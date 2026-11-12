import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Db } from "../src/db/sql";
import { followAnswerActivity, recordOutbound } from "../src/domain/activities";
import {
  CLAIM_LIMIT,
  claimDeliveries,
  enqueueActivity,
  HANDSHAKE_RECHECK_MS,
  HELD_REJECTS_PER_ACCOUNT,
  TARGET_CHUNK_BYTES,
} from "../src/domain/deliveries";
import { handshakeReplayStep } from "../src/domain/handshake-replays";
import { JOB_RETRY_DELAYS_MS, MAX_JOB_ATTEMPTS } from "../src/domain/job-attempts";
import type { StoreStub } from "../src/platform/store-client";
import type { StoreOperation } from "../src/platform/store-kernel";
import { sha256Hex } from "../src/security/tokens";
import { bearer, json, settle, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { blockDomain, unblockDomain } from "./domain-block-helpers";
import { BUILD, claimAndSettle } from "./helpers";
import { writtenBy } from "./inbox-store-helpers";
import { plannedRun, scansOf, staleStatistics } from "./read-helpers";
import { act, receive, unsuspend, uriOf, world, type World } from "./remote-suspension-helpers";
import { remoteAccount } from "./status-helpers";

// VIS-30's held Rejects (#1463; deliveries.ts HOLD_REJECT, handshake-replays.ts replayReject, migration
// 0092_reject_replays): a local account's Reject of a remote follow request that the send-time check drops because of
// its recipient holds the pair, and a jobs round records it again, with its original id, once the requester is
// available. Witnesses W1–W18 and B1–B4 of the design.

const RECHECK = HANDSHAKE_RECHECK_MS;
const G1 = "https://remote.example/follows/1";
const G2 = "https://remote.example/follows/2";
const SHARED = "https://remote.example/inbox";
const D1 = "https://d.example/follows/1";

afterEach(() => {
  vi.restoreAllMocks();
});

type Sent = { type: string; id: string; inbox: string; body: string };

// Claims at `now` until nothing is due then; each row sent, in order, with its body.
async function drain(store: StoreStub, now = NOW): Promise<Sent[]> {
  const sent: Sent[] = [];
  for (let round = 0; round < 200; round++) {
    const { claim, sent: rows } = await claimAndSettle(store, {
      now,
      leaseToken: `drain-${now}-${round}`,
      outcome: { kind: "delivered", status: 202 },
    });
    for (const { inbox, body } of rows) {
      const parsed = JSON.parse(body) as { type: string; id: string };
      sent.push({ type: parsed.type, id: parsed.id, inbox, body });
    }
    if (claim.deliveries.length === 0 && (claim.nextDueAt === null || claim.nextDueAt > now)) {
      return sent;
    }
  }
  throw new Error("the deliveries did not drain");
}

type HoldRow = {
  account: string;
  follower: string;
  follow_uri: string | null;
  edge_id: string | null;
  check_at: number;
  attempts: number;
};

const holds = (store: StoreStub) =>
  sql<HoldRow>(
    store,
    `SELECT account_id AS account, follower_id AS follower, follow_uri, CAST(edge_id AS TEXT) AS edge_id, check_at, attempts
		FROM reject_replays ORDER BY account_id, follower_id`,
  );

const replays = (store: StoreStub, now: number) => store.runHandshakeReplays(BUILD, { now });

// The intents of type Reject recorded so far.
const rejectIntents = (store: StoreStub) =>
  sql<{ id: string; pair: string | null; superseded: number; retracts: number }>(
    store,
    `SELECT json_extract(body, '$.activity.id') AS id, follow_pair AS pair, superseded, retracts FROM outbound_activities
		WHERE json_extract(body, '$.activity.type') = 'Reject' ORDER BY id`,
  );

const suspend = async (w: World, id: string) =>
  expect(await act(w, id, { type: "suspend" })).toMatchObject({ status: 200 });

const lift = async (w: World, id: string) => expect(await unsuspend(w, id)).toMatchObject({ status: 200 });

const lock = (w: World, id: string) => sql(w.h.store, "UPDATE accounts SET locked = 1 WHERE id = ?", id);

// r (remote.example, or `domain`) requests locked `local` with the Follow `followId`.
async function requests(w: World, local: { id: string }, followId: string, domain = "remote.example") {
  const r =
    (await sql<{ id: string }>(w.h.store, "SELECT id FROM accounts WHERE username = 'r' AND domain = ?", domain))[0]
      ?.id ?? (await remoteAccount(w.h.store, "r", domain));
  await lock(w, local.id);
  expect(
    await receive(w.h.store, await uriOf(w.h.store, r), {
      id: followId,
      type: "Follow",
      object: await uriOf(w.h.store, local.id),
    }),
  ).toMatchObject({ applied: true });
  return r;
}

// `local` rejects r's request through the API: a Reject that withdraws nothing.
async function rejectRequest(w: World, local: { id: string; token: string }, r: string) {
  expect(
    (await w.h.request(`/api/v1/follow_requests/${r}/reject`, bearer(local.token, { method: "POST" }))).status,
  ).toBe(200);
}

// The Reject id of `local` for the Follow `followId`.
const rejectId = async (w: World, local: { id: string }, followId: string) =>
  `${await uriOf(w.h.store, local.id)}#rejects/follows/${await sha256Hex(followId)}`;

describe("a Reject refused at its claim (W1, W2, W2b, W4)", () => {
  it("is held when the requester is suspended during its retry, and sent with the same body once it is not (W1, P1, P8)", async () => {
    const w = await world();
    const r = await requests(w, w.bob, G1);
    await rejectRequest(w, w.bob, r);
    // A 503 leaves it retrying; its body is the first attempt's.
    const first = await claimAndSettle(w.h.store, {
      now: NOW,
      leaseToken: "first",
      outcome: { kind: "failed", status: 503, error: "busy", permanent: false },
    });
    expect(first.sent).toHaveLength(1);
    const body = first.sent[0]!.body;
    expect(JSON.parse(body)).toMatchObject({ type: "Reject", id: await rejectId(w, w.bob, G1) });
    await suspend(w, r);
    const retry = NOW + RECHECK;
    expect(await drain(w.h.store, retry)).toEqual([]);
    expect(await sql(w.h.store, "SELECT 1 FROM deliveries")).toEqual([]);
    expect(await holds(w.h.store)).toEqual([
      { account: w.bob.id, follower: r, follow_uri: G1, edge_id: null, check_at: retry + RECHECK, attempts: 0 },
    ]);
    // While r is suspended a round moves the check and records nothing (C3).
    expect(await replays(w.h.store, retry + RECHECK)).toEqual({ pending: false, delivers: false });
    expect(await holds(w.h.store)).toMatchObject([{ check_at: retry + 2 * RECHECK }]);
    await lift(w, r);
    const at = retry + 2 * RECHECK;
    expect(await replays(w.h.store, at)).toEqual({ pending: false, delivers: true });
    expect(await holds(w.h.store)).toEqual([]);
    const sent = await drain(w.h.store, at);
    expect(sent.map((s) => [s.type, s.inbox])).toEqual([["Reject", SHARED]]);
    expect(sent[0]!.body).toBe(body);
  });

  it("is held under an instance block of the requester's domain and sent once the block is deleted (W2, P2, P8c)", async () => {
    const w = await world();
    const r = await requests(w, w.bob, D1, "d.example");
    await rejectRequest(w, w.bob, r);
    const block = await blockDomain(w.h.store, "d.example");
    expect(await drain(w.h.store)).toEqual([]);
    expect(await holds(w.h.store)).toMatchObject([{ account: w.bob.id, follower: r, follow_uri: D1 }]);
    await unblockDomain(w.h.store, block.id);
    await settle(w.h.store);
    expect(await replays(w.h.store, NOW + RECHECK)).toMatchObject({ delivers: true });
    expect((await drain(w.h.store, NOW + RECHECK)).map((s) => [s.type, s.id, s.inbox])).toEqual([
      ["Reject", await rejectId(w, w.bob, D1), "https://d.example/inbox"],
    ]);
  });

  it("is held and deferred while only its inbox's host is covered, the actor and its domain available (W2)", async () => {
    const w = await world();
    const r = await requests(w, w.bob, G1);
    // r's inboxes on another host than its actor's and its domain's.
    await sql(
      w.h.store,
      `UPDATE accounts SET inbox_url = 'https://inbox.example/users/r/inbox', shared_inbox_url = 'https://inbox.example/inbox'
				WHERE id = ?`,
      r,
    );
    await rejectRequest(w, w.bob, r);
    const block = await blockDomain(w.h.store, "inbox.example");
    expect(await sql(w.h.store, "SELECT suspended_at FROM accounts WHERE id = ?", r)).toEqual([{ suspended_at: null }]);
    expect(await drain(w.h.store)).toEqual([]);
    expect(await holds(w.h.store)).toMatchObject([{ follower: r, follow_uri: G1 }]);
    // Available by its account and domain: the step defers on the inbox's host alone.
    expect(await replays(w.h.store, NOW + RECHECK)).toEqual({ pending: false, delivers: false });
    expect(await holds(w.h.store)).toMatchObject([{ check_at: NOW + 2 * RECHECK }]);
    expect(await rejectIntents(w.h.store)).toEqual([]);
    await unblockDomain(w.h.store, block.id);
    await settle(w.h.store);
    expect(await replays(w.h.store, NOW + 2 * RECHECK)).toMatchObject({ delivers: true });
    expect((await drain(w.h.store, NOW + 2 * RECHECK)).map((s) => [s.id, s.inbox])).toEqual([
      [await rejectId(w, w.bob, G1), "https://inbox.example/inbox"],
    ]);
  });

  it("records nothing while an unsuspension leaves the requester covered (W2b, P8b)", async () => {
    const w = await world();
    const r = await requests(w, w.bob, D1, "d.example");
    await rejectRequest(w, w.bob, r);
    await suspend(w, r);
    await blockDomain(w.h.store, "d.example");
    expect(await drain(w.h.store)).toEqual([]);
    await lift(w, r);
    expect(await sql(w.h.store, "SELECT suspension_source FROM accounts WHERE id = ?", r)).toEqual([
      { suspension_source: "domain" },
    ]);
    expect(await replays(w.h.store, NOW + RECHECK)).toEqual({ pending: false, delivers: false });
    expect(await holds(w.h.store)).toMatchObject([{ check_at: NOW + 2 * RECHECK, attempts: 0 }]);
    expect(await rejectIntents(w.h.store)).toEqual([]);
    expect(await drain(w.h.store, NOW + RECHECK)).toEqual([]);
  });

  it("is held again when its replay is refused at its claim, and sent exactly once in the end (W4, P16)", async () => {
    const w = await world();
    const r = await requests(w, w.bob, G1);
    await rejectRequest(w, w.bob, r);
    await suspend(w, r);
    const sent = [...(await drain(w.h.store))];
    await lift(w, r);
    const first = NOW + RECHECK;
    expect(await replays(w.h.store, first)).toMatchObject({ delivers: true });
    await suspend(w, r);
    sent.push(...(await drain(w.h.store, first)));
    expect(await holds(w.h.store)).toMatchObject([{ check_at: first + RECHECK, attempts: 0 }]);
    await lift(w, r);
    expect(await replays(w.h.store, first + RECHECK)).toMatchObject({ delivers: true });
    sent.push(...(await drain(w.h.store, first + RECHECK)));
    expect(await replays(w.h.store, first + 3 * RECHECK)).toEqual({ pending: false, delivers: false });
    sent.push(...(await drain(w.h.store, first + 3 * RECHECK)));
    expect(sent.map((s) => [s.type, s.id])).toEqual([["Reject", await rejectId(w, w.bob, G1)]]);
  });
});

describe("a Reject refused at its confirmation (W3, P3)", () => {
  it("is held by confirmDelivery when the suspension commits between the claim and the confirmation", async () => {
    const w = await world();
    const r = await requests(w, w.bob, G1);
    await rejectRequest(w, w.bob, r);
    const claim = await w.h.store.claimDeliveries(BUILD, { now: NOW, leaseToken: "held" });
    expect(claim.deliveries).toHaveLength(1);
    // The claim's lease is held while the suspension commits.
    await suspend(w, r);
    expect(
      await w.h.store.confirmDelivery(BUILD, { id: claim.deliveries[0]!.id, leaseToken: "held", now: NOW }),
    ).toMatchObject({ status: "dropped" });
    expect(await holds(w.h.store)).toMatchObject([{ account: w.bob.id, follower: r, follow_uri: G1 }]);
  });
});

describe("a new generation ends the hold (W5, W5b)", () => {
  it("ends the hold when r follows again before the replay, and sends no Reject (W5, P11)", async () => {
    const w = await world();
    const r = await requests(w, w.bob, G1);
    await rejectRequest(w, w.bob, r);
    await suspend(w, r);
    expect(await drain(w.h.store)).toEqual([]);
    expect(await holds(w.h.store)).toHaveLength(1);
    await lift(w, r);
    await requests(w, w.bob, G2);
    expect(await holds(w.h.store)).toEqual([]);
    expect(await replays(w.h.store, NOW + RECHECK)).toEqual({ pending: false, delivers: false });
    expect(await drain(w.h.store, NOW + RECHECK)).toEqual([]);
    expect(await sql(w.h.store, "SELECT state, uri FROM follows WHERE account_id = ?", r)).toEqual([
      { state: "pending", uri: G2 },
    ]);
  });

  it("holds no Reject refused while its pair holds a newer request (W5b, P11b)", async () => {
    const w = await world();
    const r = await requests(w, w.bob, G1);
    await rejectRequest(w, w.bob, r);
    await requests(w, w.bob, G2);
    // The g1 Reject is kept queued (NET-2): a current Reject of r, neither superseded nor a retraction.
    expect(await rejectIntents(w.h.store)).toEqual([
      { id: await rejectId(w, w.bob, G1), pair: r, superseded: 0, retracts: 0 },
    ]);
    await suspend(w, r);
    expect(await drain(w.h.store)).toEqual([]);
    expect(await sql(w.h.store, "SELECT 1 FROM deliveries")).toEqual([]);
    expect(await holds(w.h.store)).toEqual([]);
  });
});

// r's Undo of the Follow `followId`: typed and naming `target` (a local account), or by its id alone (null).
async function undo(w: World, r: string, followId: string, target: { id: string } | null) {
  const rUri = await uriOf(w.h.store, r);
  // As the parser hands an Undo whose object is the Follow's id alone (an ActivityRef with only its id).
  const object =
    target === null
      ? { id: followId, type: null, actor: null, object: null }
      : { id: followId, type: "Follow", actor: rUri, object: await uriOf(w.h.store, target.id) };
  return receive(w.h.store, rUri, { type: "Undo", object });
}

// r's pending request of locked `local`, imported without a Follow id, its edge id `edge`.
async function importedRequest(w: World, local: { id: string }, r: string, edge: string) {
  await lock(w, local.id);
  await sql(
    w.h.store,
    "INSERT INTO follows (id, account_id, target_account_id, state, uri) VALUES (CAST(? AS INTEGER), ?, ?, 'pending', NULL)",
    edge,
    r,
    local.id,
  );
}

const byAccount = <T extends { account: string }>(rows: T[]) =>
  rows.toSorted((a, b) => (a.account < b.account ? -1 : 1));

describe("the follower's Undo ends the hold within its pair (W6, P12)", () => {
  it("by the Follow id it names, by a pair id for a known target, and keeps every other pair's hold", async () => {
    const w = await world();
    // alice's hold names G1; bob's has an edge id only.
    const r = await requests(w, w.alice, G1);
    await rejectRequest(w, w.alice, r);
    await importedRequest(w, w.bob, r, "7");
    await rejectRequest(w, w.bob, r);
    await suspend(w, r);
    expect(await drain(w.h.store)).toEqual([]);
    expect(await holds(w.h.store)).toMatchObject(
      byAccount([
        { account: w.alice.id, follow_uri: G1, edge_id: null },
        { account: w.bob.id, follow_uri: null, edge_id: "7" },
      ]),
    );
    const pairId = `https://remote.example/follows/${r}/${w.bob.id}`;
    // An id-only pair Undo that matches no answer and no hold ends nothing.
    await undo(w, r, pairId, null);
    expect(await holds(w.h.store)).toHaveLength(2);
    // A typed Undo of another Follow, naming bob, keeps bob's hold.
    await undo(w, r, G2, w.bob);
    expect(await holds(w.h.store)).toHaveLength(2);
    // An id-only Undo of G1: alice's hold only.
    await undo(w, r, G1, null);
    expect(await holds(w.h.store)).toMatchObject([{ account: w.bob.id, edge_id: "7" }]);
    // A typed pair Undo naming bob: bob's edge-id hold.
    await undo(w, r, pairId, w.bob);
    expect(await holds(w.h.store)).toEqual([]);
  });

  it("finds the pair of an id-only pair Undo through a queued answer, and ends that pair's hold too", async () => {
    const w = await world();
    const r = await requests(w, w.bob, G1);
    await rejectRequest(w, w.bob, r);
    await suspend(w, r);
    expect(await drain(w.h.store)).toEqual([]);
    expect(await holds(w.h.store)).toMatchObject([{ account: w.bob.id, follow_uri: G1 }]);
    // r is lifted, bob blocks r, and r's Follow by a Misskey pair id P is refused: its Reject naming P is queued.
    await lift(w, r);
    expect((await w.h.request(`/api/v1/accounts/${r}/block`, bearer(w.bob.token, json({})))).status).toBe(200);
    const pairId = `https://remote.example/follows/${r}/${w.bob.id}`;
    expect(
      await receive(w.h.store, await uriOf(w.h.store, r), {
        id: pairId,
        type: "Follow",
        object: await uriOf(w.h.store, w.bob.id),
      }),
    ).toMatchObject({ applied: true });
    expect(await rejectIntents(w.h.store)).toEqual([
      { id: await rejectId(w, w.bob, pairId), pair: r, superseded: 0, retracts: 0 },
    ]);
    expect(await holds(w.h.store)).toHaveLength(1);
    // The id-only Undo of P resolves bob through the queued answer: the answer and the G1 hold both go.
    await undo(w, r, pairId, null);
    expect(await rejectIntents(w.h.store)).toEqual([]);
    expect(await holds(w.h.store)).toEqual([]);
  });
});

// Once a replay records it, a held Reject is a queued answer like any other (NET-2's keep rule): a newer request that
// arrives before its claim keeps it, so it is sent, and the peer's pair fallback (Mastodon's reject_embedded_follow)
// may reject that request while Kopje keeps it pending. The same window as any queued Reject's (an accepted risk in
// docs/threat-model.md); these pin today's behaviour, so a change to it is deliberate.
describe("a replayed Reject under NET-2's keep rule (accepted risk)", () => {
  const heldThenReplayed = async () => {
    const w = await world();
    const r = await requests(w, w.bob, G1);
    await rejectRequest(w, w.bob, r);
    await suspend(w, r);
    expect(await drain(w.h.store)).toEqual([]);
    await lift(w, r);
    expect(await replays(w.h.store, NOW + RECHECK)).toMatchObject({ delivers: true });
    expect(await holds(w.h.store)).toEqual([]);
    return { w, r };
  };

  it("is still sent when r's newer request arrives before its claim, and that request stays pending here", async () => {
    const { w, r } = await heldThenReplayed();
    await requests(w, w.bob, G2);
    expect(await rejectIntents(w.h.store)).toEqual([
      { id: await rejectId(w, w.bob, G1), pair: r, superseded: 0, retracts: 0 },
    ]);
    expect((await drain(w.h.store, NOW + RECHECK)).map((s) => [s.type, s.id])).toEqual([
      ["Reject", await rejectId(w, w.bob, G1)],
    ]);
    expect(await sql(w.h.store, "SELECT state, uri FROM follows WHERE account_id = ?", r)).toEqual([
      { state: "pending", uri: G2 },
    ]);
  });

  it("is cancelled when r's Undo of g1 also arrives before its claim", async () => {
    const { w, r } = await heldThenReplayed();
    await requests(w, w.bob, G2);
    await undo(w, r, G1, w.bob);
    expect(await rejectIntents(w.h.store)).toEqual([]);
    expect(await drain(w.h.store, NOW + RECHECK)).toEqual([]);
    expect(await sql(w.h.store, "SELECT state, uri FROM follows WHERE account_id = ?", r)).toEqual([
      { state: "pending", uri: G2 },
    ]);
  });
});

describe("a Reject the blocks record (W7, W8)", () => {
  it("records a local block's Reject of a suspended requester, holds it at the claim, and replays it (W7, P13)", async () => {
    const w = await world();
    const r = await requests(w, w.bob, G1);
    await suspend(w, r);
    expect((await w.h.request(`/api/v1/accounts/${r}/block`, bearer(w.bob.token, json({})))).status).toBe(200);
    expect(await rejectIntents(w.h.store)).toEqual([
      { id: await rejectId(w, w.bob, G1), pair: r, superseded: 0, retracts: 0 },
    ]);
    expect(await drain(w.h.store)).toEqual([]);
    expect(await holds(w.h.store)).toMatchObject([{ account: w.bob.id, follower: r, follow_uri: G1 }]);
    await lift(w, r);
    // No block rule: the Reject goes to the account bob blocks.
    expect(await replays(w.h.store, NOW + RECHECK)).toMatchObject({ delivers: true });
    expect((await drain(w.h.store, NOW + RECHECK)).map((s) => [s.type, s.id])).toEqual([
      ["Reject", await rejectId(w, w.bob, G1)],
    ]);
  });

  it("holds a user domain block's Rejects of suspended requesters, one per requester (W8, P14)", async () => {
    const w = await world();
    await lock(w, w.bob.id);
    const requesters: string[] = [];
    for (const name of ["r1", "r2"]) {
      const id = await remoteAccount(w.h.store, name, "d.example");
      expect(
        await receive(w.h.store, await uriOf(w.h.store, id), {
          id: `https://d.example/follows/${name}`,
          type: "Follow",
          object: await uriOf(w.h.store, w.bob.id),
        }),
      ).toMatchObject({ applied: true });
      await suspend(w, id);
      requesters.push(id);
    }
    expect(
      (await w.h.request("/api/v1/domain_blocks", bearer(w.bob.token, json({ domain: "d.example" })))).status,
    ).toBe(200);
    await settle(w.h.store);
    expect(await sql(w.h.store, "SELECT 1 FROM follows WHERE target_account_id = ?", w.bob.id)).toEqual([]);
    expect(await drain(w.h.store)).toEqual([]);
    expect((await holds(w.h.store)).map((h) => [h.account, h.follower])).toEqual(
      requesters.toSorted().map((r) => [w.bob.id, r]),
    );
  });
});

// The intent of bob's queued Reject, changed by `set` (a json_set of its body, or other columns): an imported or
// legacy intent.
const changeIntent = (w: World, set: string, ...params: SqlStorageValue[]) =>
  sql(
    w.h.store,
    `UPDATE outbound_activities SET ${set} WHERE json_extract(body, '$.activity.type') = 'Reject'`,
    ...params,
  );

describe("what is never held (W9, W16)", () => {
  // Each case changes bob's queued Reject of r, then r is suspended and the claim refuses it. The control holds it, so
  // every other case reaches the same refusal and differs only in what it changes.
  const cases: [string, (w: World, r: string) => Promise<unknown>, boolean][] = [
    ["the control", async () => {}, true],
    // (a) superseded and refused: the refusal branch runs first (sendRefused), and HOLD_REJECT refuses superseded.
    ["a superseded Reject", (w) => changeIntent(w, "superseded = 1"), false],
    // (c) a refused sender: holdHandshake returns before HOLD_REJECT.
    ["a Reject of a suspended local sender", (w) => suspend(w, w.bob.id), false],
    // (e) a Follow id past ACTIVITY_ID_LIMIT, NUL, or not text.
    [
      "a Follow id past its bound",
      (w) => changeIntent(w, "body = json_set(body, '$.activity.object.id', ?)", `https://x/${"a".repeat(4096)}`),
      false,
    ],
    [
      "a Follow id with NUL",
      (w) => changeIntent(w, "body = json_set(body, '$.activity.object.id', 'a' || char(0))"),
      false,
    ],
    ["a Follow id that is a number", (w) => changeIntent(w, "body = json_set(body, '$.activity.object.id', 7)"), false],
    [
      "an object that is not a Follow",
      (w) => changeIntent(w, "body = json_set(body, '$.activity.object.type', 'X')"),
      false,
    ],
    ["no follow pair", (w) => changeIntent(w, "follow_pair = NULL"), false],
    // (f) the pair holds a follow (W5b's newer request, here imported).
    [
      "a pair that holds a follow",
      (w, r) =>
        sql(
          w.h.store,
          "INSERT INTO follows (account_id, target_account_id, state, uri) VALUES (?, ?, 'pending', ?)",
          r,
          w.bob.id,
          G2,
        ),
      false,
    ],
  ];

  it.each(cases)("holds nothing for %s", async (_name, change, held) => {
    const w = await world();
    const r = await requests(w, w.bob, G1);
    await rejectRequest(w, w.bob, r);
    await change(w, r);
    await suspend(w, r);
    expect(await drain(w.h.store)).toEqual([]);
    expect(await sql(w.h.store, "SELECT 1 FROM deliveries")).toEqual([]);
    expect(await holds(w.h.store)).toHaveLength(held ? 1 : 0);
  });

  it("holds nothing for a Reject that withdraws: the send-time check never refuses it (AC-7)", async () => {
    const w = await world();
    const r = await requests(w, w.bob, G1);
    await rejectRequest(w, w.bob, r);
    await changeIntent(w, "retracts = 1");
    await suspend(w, r);
    expect((await drain(w.h.store)).map((s) => s.type)).toEqual(["Reject"]);
    expect(await holds(w.h.store)).toEqual([]);
  });

  it("holds nothing for a row gone at its confirmation (W9b, P4): the refusal branch is not reached", async () => {
    const w = await world();
    const r = await requests(w, w.bob, G1);
    await rejectRequest(w, w.bob, r);
    const claim = await w.h.store.claimDeliveries(BUILD, { now: NOW, leaseToken: "gone" });
    expect(claim.deliveries).toHaveLength(1);
    await suspend(w, r);
    // The intent's activity is gone (a legacy row): confirmDelivery's `gone` branch drops it before sendRefused.
    await changeIntent(w, "body = json_remove(body, '$.activity')");
    expect(
      await w.h.store.confirmDelivery(BUILD, { id: claim.deliveries[0]!.id, leaseToken: "gone", now: NOW }),
    ).toMatchObject({ status: "dropped" });
    expect(await holds(w.h.store)).toEqual([]);
  });

  it("holds nothing for a quote's Reject (W9d): it carries no follow pair", async () => {
    const w = await world();
    const r = await remoteAccount(w.h.store, "r", "remote.example");
    const bobUri = await uriOf(w.h.store, w.bob.id);
    await runInDurableObject(w.h.store, (_instance, state) => {
      const db = new Db(state.storage.sql);
      state.storage.transactionSync(() =>
        enqueueActivity(
          db,
          w.bob.id,
          {
            activity: {
              id: `${bobUri}#quote-reject`,
              type: "Reject",
              actor: bobUri,
              object: { id: G1, type: "QuoteRequest" },
            },
            audience: { followers: false, accounts: [r] },
          },
          NOW,
        ),
      );
    });
    await suspend(w, r);
    expect(await drain(w.h.store)).toEqual([]);
    expect(await sql(w.h.store, "SELECT 1 FROM deliveries")).toEqual([]);
    expect(await holds(w.h.store)).toEqual([]);
  });

  // The edge id a Reject without a Follow id ends with: canonical 64-bit decimals hold, anything else holds nothing.
  it.each([
    ["7", "7"],
    ["0", "0"],
    ["-1", "-1"],
    ["9007199254740993", "9007199254740993"],
    ["9223372036854775807", "9223372036854775807"],
    ["-9223372036854775808", "-9223372036854775808"],
    ["9223372036854775808", null],
    ["007", null],
    ["+5", null],
    [" 7", null],
    ["7.0", null],
    ["7e0", null],
    ["-0", null],
    ["", null],
    ["7a", null],
  ])("reads the edge id suffix %j as %j (W16)", async (suffix, edge) => {
    const w = await world();
    const r = await requests(w, w.bob, G1);
    await rejectRequest(w, w.bob, r);
    const bobUri = await uriOf(w.h.store, w.bob.id);
    await changeIntent(
      w,
      "body = json_set(json_remove(body, '$.activity.object.id'), '$.activity.id', ?)",
      `${bobUri}#rejects/follows/${suffix}`,
    );
    await suspend(w, r);
    expect(await drain(w.h.store)).toEqual([]);
    expect(await holds(w.h.store)).toEqual(
      edge === null ? [] : [expect.objectContaining({ follow_uri: null, edge_id: edge })],
    );
  });
});

describe("edge ids and pair ids replayed byte for byte (W16, W17; C4)", () => {
  it.each(["9007199254740993", "9223372036854775807", "0", "-1"])(
    "replays the Reject of an imported request without a Follow id, edge %s, with its id",
    async (edge) => {
      const w = await world();
      const r = await remoteAccount(w.h.store, "r", "remote.example");
      await importedRequest(w, w.bob, r, edge);
      await rejectRequest(w, w.bob, r);
      const [intent] = await sql<{ activity: string }>(
        w.h.store,
        "SELECT json_extract(body, '$.activity') AS activity FROM outbound_activities",
      );
      const bobUri = await uriOf(w.h.store, w.bob.id);
      expect(JSON.parse(intent!.activity)).toMatchObject({ id: `${bobUri}#rejects/follows/${edge}` });
      await suspend(w, r);
      expect(await drain(w.h.store)).toEqual([]);
      expect(await holds(w.h.store)).toMatchObject([{ follow_uri: null, edge_id: edge }]);
      await lift(w, r);
      expect(await replays(w.h.store, NOW + RECHECK)).toMatchObject({ delivers: true });
      const sent = await drain(w.h.store, NOW + RECHECK);
      expect(sent.map((s) => s.id)).toEqual([`${bobUri}#rejects/follows/${edge}`]);
      expect(JSON.parse(sent[0]!.body)).toEqual(JSON.parse(intent!.activity));
    },
  );

  it("replays a Misskey pair id's Reject with its id, and a new pair Follow ends the hold (W17)", async () => {
    const w = await world();
    const r = await remoteAccount(w.h.store, "r", "remote.example");
    const pairId = `https://remote.example/follows/${r}/${w.bob.id}`;
    await requests(w, w.bob, pairId);
    await rejectRequest(w, w.bob, r);
    await suspend(w, r);
    expect(await drain(w.h.store)).toEqual([]);
    expect(await holds(w.h.store)).toMatchObject([{ follow_uri: pairId, edge_id: null }]);
    await lift(w, r);
    expect(await replays(w.h.store, NOW + RECHECK)).toMatchObject({ delivers: true });
    expect((await drain(w.h.store, NOW + RECHECK)).map((s) => s.id)).toEqual([await rejectId(w, w.bob, pairId)]);
    // Held again, then the same pair id follows again: the follow's insert ends the hold.
    await sql(
      w.h.store,
      "INSERT INTO reject_replays (account_id, follower_id, follow_uri, check_at) VALUES (?, ?, ?, ?)",
      w.bob.id,
      r,
      pairId,
      NOW,
    );
    await requests(w, w.bob, pairId);
    expect(await holds(w.h.store)).toEqual([]);
  });
});

describe("an inbox the replay cannot use, and the shared-inbox fallback (W10, W10b)", () => {
  it("gives up through the shared inbox's 404 with no hold, and the operator's retry holds it (W10, P5, P6)", async () => {
    const w = await world();
    const r = await requests(w, w.bob, G1);
    await rejectRequest(w, w.bob, r);
    const claim = await w.h.store.claimDeliveries(BUILD, { now: NOW, leaseToken: "post" });
    const id = claim.deliveries[0]!.id;
    expect(claim.deliveries[0]!.inbox).toBe(SHARED);
    expect(await w.h.store.confirmDelivery(BUILD, { id, leaseToken: "post", now: NOW })).toMatchObject({
      status: "send",
    });
    // The POST is held while the suspension commits, then its completion is a 404.
    await suspend(w, r);
    expect(
      await w.h.store.completeDelivery(BUILD, {
        id,
        leaseToken: "post",
        now: NOW,
        outcome: { kind: "failed", status: 404, error: "gone", permanent: true },
      }),
    ).toMatchObject({ status: "gave_up" });
    expect(await holds(w.h.store)).toEqual([]);
    expect(await w.h.store.retryDeliveries(BUILD, { ids: "all", now: NOW })).toMatchObject({ ok: true });
    expect(await drain(w.h.store)).toEqual([]);
    expect(await holds(w.h.store)).toMatchObject([{ account: w.bob.id, follower: r, follow_uri: G1 }]);
  });

  it("keeps the hold when the recording inserts no target (an inbox past TARGET_CHUNK_BYTES), and replays once repaired (W10b; C6)", async () => {
    const w = await world();
    const r = await requests(w, w.bob, G1);
    await rejectRequest(w, w.bob, r);
    await suspend(w, r);
    expect(await drain(w.h.store)).toEqual([]);
    await sql(
      w.h.store,
      `UPDATE accounts SET inbox_url = 'https://remote.example/' || replace(hex(zeroblob(${TARGET_CHUNK_BYTES / 2})), '00', 'ab'),
				shared_inbox_url = NULL WHERE id = ?`,
      r,
    );
    await lift(w, r);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await replays(w.h.store, NOW + RECHECK)).toEqual({ pending: false, delivers: false });
    // The step reached recordOutbound, which refused the target.
    expect(warn.mock.calls.map(([entry]) => (entry as { event?: string }).event)).toContain(
      "kopje.delivery.oversized_target",
    );
    expect(await holds(w.h.store)).toMatchObject([{ check_at: NOW + 2 * RECHECK, attempts: 0 }]);
    warn.mockRestore();
    await sql(
      w.h.store,
      "UPDATE accounts SET inbox_url = 'https://remote.example/users/r/inbox', shared_inbox_url = ? WHERE id = ?",
      SHARED,
      r,
    );
    expect(await replays(w.h.store, NOW + 2 * RECHECK)).toMatchObject({ delivers: true });
    expect((await drain(w.h.store, NOW + 2 * RECHECK)).map((s) => [s.id, s.inbox])).toEqual([
      [await rejectId(w, w.bob, G1), SHARED],
    ]);
  });
});

describe("lifecycle (W11–W14)", () => {
  it("ends the hold by a spooled Undo, and a spooled blocked Follow's Reject is held when refused (W11, P7)", async () => {
    const w = await world();
    const r = await remoteAccount(w.h.store, "r", "remote.example");
    expect((await w.h.request(`/api/v1/accounts/${r}/block`, bearer(w.bob.token, json({})))).status).toBe(200);
    // The spool replays through the Store's receive: a blocked Follow records its Reject (S2).
    expect(
      await receive(w.h.store, await uriOf(w.h.store, r), {
        id: G1,
        type: "Follow",
        object: await uriOf(w.h.store, w.bob.id),
      }),
    ).toMatchObject({ applied: true });
    await suspend(w, r);
    expect(await drain(w.h.store)).toEqual([]);
    expect(await holds(w.h.store)).toMatchObject([{ follow_uri: G1 }]);
    await undo(w, r, G1, w.bob);
    expect(await holds(w.h.store)).toEqual([]);
  });

  it("defers while the requester is deleted, and its purge deletes the hold before the account (W12, P9; C10)", async () => {
    const w = await world();
    const r = await requests(w, w.bob, G1);
    await rejectRequest(w, w.bob, r);
    await suspend(w, r);
    expect(await drain(w.h.store)).toEqual([]);
    await lift(w, r);
    // deleted_at alone (a purge still to run) makes the step defer.
    await sql(w.h.store, "UPDATE accounts SET deleted_at = ? WHERE id = ?", new Date(NOW).toISOString(), r);
    expect(await replays(w.h.store, NOW + RECHECK)).toEqual({ pending: false, delivers: false });
    expect(await holds(w.h.store)).toMatchObject([{ check_at: NOW + 2 * RECHECK }]);
    expect(await rejectIntents(w.h.store)).toEqual([]);
    await sql(w.h.store, "UPDATE accounts SET deleted_at = NULL WHERE id = ?", r);
    // r's Delete while it is suspended: the purge deletes the hold, then the account, which cascades nothing.
    await suspend(w, r);
    expect(await receive(w.h.store, await uriOf(w.h.store, r), { type: "DeleteActor" })).toMatchObject({
      applied: true,
    });
    await settle(w.h.store);
    expect(await sql(w.h.store, "SELECT id FROM accounts WHERE id = ?", r)).toEqual([]);
    expect(await holds(w.h.store)).toEqual([]);
  });

  it("defers while the local account is suspended, and replays once it is not (W13, P10)", async () => {
    const w = await world();
    const r = await requests(w, w.bob, G1);
    await rejectRequest(w, w.bob, r);
    await suspend(w, r);
    expect(await drain(w.h.store)).toEqual([]);
    await lift(w, r);
    await suspend(w, w.bob.id);
    expect(await replays(w.h.store, NOW + RECHECK)).toEqual({ pending: false, delivers: false });
    expect(await holds(w.h.store)).toMatchObject([{ check_at: NOW + 2 * RECHECK }]);
    expect(await rejectIntents(w.h.store)).toEqual([]);
    await lift(w, w.bob.id);
    await settle(w.h.store);
    expect(await replays(w.h.store, NOW + 2 * RECHECK)).toMatchObject({ delivers: true });
    expect((await drain(w.h.store, NOW + 2 * RECHECK)).filter((s) => s.type === "Reject").map((s) => s.id)).toEqual([
      await rejectId(w, w.bob, G1),
    ]);
  });

  it.each(["account", "domain"] as const)(
    "severing r (%s) adds no hold and leaves another pair's alone (W14, P15)",
    async (mode) => {
      const w = await world();
      // alice holds a Reject of s; r follows alice and requests bob.
      const s = await requests(w, w.alice, "https://other.example/follows/1", "other.example");
      await rejectRequest(w, w.alice, s);
      await suspend(w, s);
      expect(await drain(w.h.store)).toEqual([]);
      const before = await holds(w.h.store);
      expect(before).toHaveLength(1);
      const r = await requests(w, w.bob, G1);
      await sql(
        w.h.store,
        "INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
        r,
        w.alice.id,
      );
      if (mode === "account") {
        await suspend(w, r);
      } else {
        await blockDomain(w.h.store, "remote.example");
      }
      await settle(w.h.store);
      await drain(w.h.store);
      expect(await holds(w.h.store)).toEqual(before);
    },
  );
});

describe("failures (W15, W18; RES-5)", () => {
  it("backs a failing hold off and parks it while another replays, and the admin's retry recovers it (W15, P19)", async () => {
    const w = await world();
    const r1 = await requests(w, w.bob, G1);
    await rejectRequest(w, w.bob, r1);
    const r2 = await requests(w, w.alice, "https://two.example/follows/1", "two.example");
    await rejectRequest(w, w.alice, r2);
    for (const r of [r1, r2]) {
      await suspend(w, r);
    }
    expect(await drain(w.h.store)).toEqual([]);
    for (const r of [r1, r2]) {
      await lift(w, r);
    }
    await sql(
      w.h.store,
      `CREATE TRIGGER test_reject_fails BEFORE INSERT ON outbound_activities WHEN NEW.follow_pair = '${r1}'
				BEGIN SELECT RAISE(ABORT, 'test: the item fails'); END`,
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let now = NOW + RECHECK;
    expect(await replays(w.h.store, now)).toMatchObject({ delivers: true });
    const state = async () => (await holds(w.h.store)).map((h) => [h.follower, h.attempts]);
    expect(await state()).toEqual([[r1, 1]]);
    for (const delay of JOB_RETRY_DELAYS_MS) {
      now += delay;
      await replays(w.h.store, now);
    }
    expect(await state()).toEqual([[r1, MAX_JOB_ATTEMPTS]]);
    expect(await replays(w.h.store, now + RECHECK)).toEqual({ pending: false, delivers: false });
    expect(errors.mock.calls.map(([e]) => (e as { family?: string }).family)).toContain("handshake_replays");
    errors.mockRestore();
    await sql(w.h.store, "DROP TRIGGER test_reject_fails");
    expect(await w.h.store.retryParkedJobs(BUILD, {})).toMatchObject({ reset: 1 });
    expect(await replays(w.h.store, now)).toMatchObject({ delivers: true });
    expect(await holds(w.h.store)).toEqual([]);
  });

  it.each(["follow_uri", "follower uri", "local actor uri"] as const)(
    "parks a hold whose %s is not valid UTF-8, sends nothing, and replays its original id once repaired (W18; AC-6)",
    async (what) => {
      const w = await world();
      const r = await requests(w, w.bob, G1);
      await rejectRequest(w, w.bob, r);
      await suspend(w, r);
      expect(await drain(w.h.store)).toEqual([]);
      await lift(w, r);
      const account = what === "local actor uri" ? w.bob.id : r;
      const accountUri = await uriOf(w.h.store, account);
      if (what === "follow_uri") {
        await sql(w.h.store, "UPDATE reject_replays SET follow_uri = CAST(X'68747470733aff' AS TEXT)");
      } else {
        await sql(
          w.h.store,
          "UPDATE accounts SET uri = CAST(CAST(uri AS BLOB) || X'ff' AS TEXT) WHERE id = ?",
          account,
        );
      }
      const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      let now = NOW + RECHECK;
      expect(await replays(w.h.store, now)).toEqual({ pending: false, delivers: false });
      for (const delay of JOB_RETRY_DELAYS_MS) {
        now += delay;
        await replays(w.h.store, now);
      }
      expect(await holds(w.h.store)).toMatchObject([{ attempts: MAX_JOB_ATTEMPTS }]);
      expect(await replays(w.h.store, now + RECHECK)).toEqual({ pending: false, delivers: false });
      expect(await rejectIntents(w.h.store)).toEqual([]);
      const logged = warns.mock.calls.map(([entry]) => entry as Record<string, unknown>);
      expect(logged.filter((e) => e.event === "kopje.jobs.reject_replay.invalid_identity")).toEqual(
        Array.from({ length: MAX_JOB_ATTEMPTS }, () => ({ event: "kopje.jobs.reject_replay.invalid_identity" })),
      );
      warns.mockRestore();
      errors.mockRestore();
      if (what === "follow_uri") {
        await sql(w.h.store, "UPDATE reject_replays SET follow_uri = ?", G1);
      } else {
        await sql(w.h.store, "UPDATE accounts SET uri = ? WHERE id = ?", accountUri, account);
      }
      expect(await w.h.store.retryParkedJobs(BUILD, {})).toMatchObject({ reset: 1 });
      expect(await replays(w.h.store, now)).toMatchObject({ delivers: true });
      expect((await drain(w.h.store, now)).map((s) => s.id)).toEqual([await rejectId(w, w.bob, G1)]);
    },
  );
});

// Runs `operation` in one Store transaction as the kernel does: its result and the rows it wrote (total_changes()).
function operationRows<I, O>(
  store: StoreStub,
  operation: StoreOperation<I, O>,
  input: I,
): Promise<{ result: O; rows: number }> {
  return runInDurableObject(store, (_instance, state) => {
    const changes = () => state.storage.sql.exec<{ n: number }>("SELECT total_changes() AS n").one().n;
    const before = changes();
    const result = state.storage.transactionSync(() =>
      operation.run(state.storage.sql, input, (fn) => state.storage.transactionSync(fn)),
    );
    return { result, rows: changes() - before };
  });
}

// `n` remote accounts on their own domains (ids `<prefix>` then 17 digits), each with its inbox, `suspended` or not.
const remotes = (store: StoreStub, n: number, prefix: string, suspended: boolean) =>
  sql(
    store,
    `WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < ?1)
		INSERT INTO accounts (id, uri, username, domain, inbox_url, shared_inbox_url, suspended_at, suspension_source)
		SELECT ?2 || printf('%017d', i), 'https://' || ?2 || i || '.example/u', 'b', ?2 || i || '.example',
			'https://' || ?2 || i || '.example/u/inbox', 'https://' || ?2 || i || '.example/inbox',
			CASE WHEN ?3 THEN '2026-01-01T00:00:00.000Z' END, CASE WHEN ?3 THEN 'account' END FROM k`,
    n,
    prefix,
    suspended ? 1 : 0,
  );

describe("bounds (RES-4, RES-6, RES-7)", () => {
  it("merges both tables by due retry, then check time, the handshake first, then integer key; 20 steps a round (B1; C8)", async () => {
    const w = await world();
    const store = w.h.store;
    // 11 local accounts: the world's five and six more.
    const locals = [w.owner.id, w.alice.id, w.bob.id, w.carol.id, w.dan.id];
    for (let i = 1; i <= 6; i++) {
      const id = `19000000000000000${i}`;
      await sql(
        store,
        "INSERT INTO accounts (id, uri, username, domain) VALUES (?1, 'https://kopje.test/ap/users/x' || ?2, 'x' || ?2, NULL)",
        id,
        i,
      );
      await sql(
        store,
        "INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?1, 'x' || ?2 || '@example.com', X'00', X'00', 'k')",
        id,
        i,
      );
      locals.push(id);
    }
    // 1,001 held Rejects and 1,000 held handshakes of suspended accounts, all fresh and due at NOW, keys 1…; ids whose
    // TEXT order differs from their order (2 < 10, '10' < '2').
    await remotes(store, 1001, "6", true);
    await remotes(store, 1000, "7", true);
    await sql(
      store,
      `WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < 1001)
			INSERT INTO reject_replays (id, account_id, follower_id, follow_uri, check_at)
			SELECT i, json_extract(?1, '$[' || (i % 11) || ']'), '6' || printf('%017d', i), 'https://f/' || i, ?2 FROM k`,
      JSON.stringify(locals),
      NOW,
    );
    await sql(
      store,
      `WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < 1000)
			INSERT INTO follows (id, account_id, target_account_id, state, uri)
			SELECT i, ?1, '7' || printf('%017d', i), 'pending', 'https://kopje.test/f/' || i FROM k`,
      w.alice.id,
    );
    await sql(
      store,
      `WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < 1000)
			INSERT INTO handshake_replays (follow_id, check_at) SELECT i, ?1 FROM k`,
      NOW,
    );
    // In each table: a parked row, a backoff due in the future, and a due backoff (reject_replays' earlier).
    for (const [table, key] of [
      ["reject_replays", "id"],
      ["handshake_replays", "follow_id"],
    ] as const) {
      await sql(store, `UPDATE ${table} SET attempts = 6, due_at = NULL WHERE ${key} = 900`);
      await sql(store, `UPDATE ${table} SET attempts = 2, due_at = ? WHERE ${key} = 901`, NOW + 1);
    }
    await sql(store, "UPDATE reject_replays SET attempts = 1, due_at = ? WHERE id = 902", NOW - 2);
    await sql(store, "UPDATE handshake_replays SET attempts = 1, due_at = ? WHERE follow_id = 902", NOW - 1);
    // An order log: each step's hold, as its write shows.
    await sql(store, "CREATE TABLE test_order (n INTEGER PRIMARY KEY, t TEXT, k INTEGER)");
    await sql(
      store,
      `CREATE TRIGGER test_order_r AFTER UPDATE ON reject_replays BEGIN
				INSERT INTO test_order (t, k) SELECT 'r', NEW.id WHERE NEW.check_at <> OLD.check_at; END`,
    );
    await sql(
      store,
      `CREATE TRIGGER test_order_h AFTER UPDATE ON handshake_replays BEGIN
				INSERT INTO test_order (t, k) SELECT 'h', NEW.follow_id WHERE NEW.check_at <> OLD.check_at; END`,
    );
    const order = async () =>
      (await sql<{ t: string; k: number }>(store, "SELECT t, k FROM test_order ORDER BY n")).map((r) => `${r.t}${r.k}`);
    // Under statistics taken while the tables were small, a step's statements read no more than the seeks' entries.
    const { after } = await staleStatistics(w.h, {
      capture: async (phase) =>
        phase === "before" ? [] : (await plannedRun(w.h, /./, handshakeReplayStep, { now: NOW }, true)).plans,
      grow: async () => {},
    });
    for (const statement of after) {
      expect(statement.plan.join(" | "), statement.query).not.toMatch(/TEMP B-TREE FOR ORDER BY/);
      const scans = scansOf(statement.plan, [
        "handshake_replays",
        "reject_replays",
        "follows",
        "accounts",
        "f",
        "fa",
        "la",
        "l",
      ]).filter((detail) => !/USING (?:COVERING )?INDEX (?:handshake|reject)_replays_(?:fresh|failing)\b/.test(detail));
      expect(scans, statement.query).toEqual([]);
    }
    const seeks = after.filter((s) => /INDEXED BY (?:handshake|reject)_replays_/.test(s.query));
    expect(seeks.length).toBeLessThanOrEqual(4);
    for (const seek of seeks) {
      expect(seek.rows, seek.query).toBeLessThanOrEqual(1);
    }
    // The first step took reject_replays' earlier due retry (902); the round goes on with handshake 902's, then fresh
    // rows by check time, the handshake first on equal times, then integer key.
    expect(await order()).toEqual(["r902"]);
    expect(await replays(store, NOW)).toEqual({ pending: true, delivers: false });
    expect(await order()).toEqual([
      "r902",
      "h902",
      ...Array.from({ length: 9 }, (_, i) => `h${i + 1}`),
      ...Array.from({ length: 10 }, (_, i) => `h${i + 10}`),
    ]);
    // Every due hold of both tables within ceil(due / 20) rounds; the parked and future rows never.
    const due = 1001 + 1000 - 4;
    let rounds = 1;
    while ((await replays(store, NOW)).pending) {
      rounds++;
    }
    expect(rounds).toBeLessThanOrEqual(Math.ceil(due / 20) + 1);
    const taken = await order();
    expect([taken.length, new Set(taken).size]).toEqual([due, due]);
    expect(taken).not.toContain("r900");
    expect(taken).not.toContain("h900");
    expect(taken).not.toContain("r901");
    expect(taken).not.toContain("h901");
    // After all the fresh handshakes at NOW come the fresh Rejects at NOW.
    expect(taken.indexOf("r1")).toBeGreaterThan(taken.indexOf("h1000"));
    // A table holding only parked rows asks for nothing.
    await sql(store, "DELETE FROM handshake_replays");
    await sql(store, "DELETE FROM reject_replays WHERE id <> 900");
    expect(await replays(store, NOW + 10 * RECHECK)).toEqual({ pending: false, delivers: false });
  }, 300_000);

  it("takes the handshake's due retry first when its due_at is the earlier (B1, the reverse order)", async () => {
    const w = await world();
    const store = w.h.store;
    await remotes(store, 1, "6", true);
    await remotes(store, 1, "7", true);
    await sql(
      store,
      "INSERT INTO reject_replays (id, account_id, follower_id, follow_uri, check_at, attempts, due_at) VALUES (5, ?, ?, 'https://f/5', 0, 1, ?)",
      w.bob.id,
      `6${"1".padStart(17, "0")}`,
      NOW - 1,
    );
    await sql(
      store,
      "INSERT INTO follows (id, account_id, target_account_id, state, uri) VALUES (5, ?, ?, 'pending', 'https://kopje.test/f/5')",
      w.alice.id,
      `7${"1".padStart(17, "0")}`,
    );
    await sql(
      store,
      "INSERT INTO handshake_replays (follow_id, check_at, attempts, due_at) VALUES (5, 0, 1, ?)",
      NOW - 2,
    );
    const moved = async () =>
      sql<{ t: string }>(
        store,
        `SELECT 'h' AS t FROM handshake_replays WHERE attempts = 0 UNION ALL SELECT 'r' FROM reject_replays WHERE attempts = 0`,
      );
    // One step: the handshake's retry (due earlier) runs through and is reset; the Reject's still waits.
    expect(await operationRows(store, handshakeReplayStep, { now: NOW })).toMatchObject({ result: { done: false } });
    expect(await moved()).toEqual([{ t: "h" }]);
  });

  it("reads the intent and the hold by key under statistics older than both tables' growth (HOLD_REJECT, REJECT_HOLD)", async () => {
    const w = await world();
    const store = w.h.store;
    // One cycle on `local`: a fresh requester's Reject refused at a claim (the hold's statements), then lifted and
    // replayed (the hold's read); the rows each statement read.
    let n = 0;
    const cycle = async (local: { id: string; token: string }) => {
      const domain = `s${++n}.example`;
      const r = await requests(w, local, `https://${domain}/follows/1`, domain);
      await rejectRequest(w, local, r);
      await suspend(w, r);
      const claim = await plannedRun(w.h, /reject_replays/, claimDeliveries, { now: NOW, leaseToken: `s${n}` }, true);
      expect(await sql(store, "SELECT 1 FROM reject_replays WHERE follower_id = ?", r)).toHaveLength(1);
      await lift(w, r);
      await sql(store, "UPDATE reject_replays SET check_at = 0 WHERE follower_id = ?", r);
      const step = await plannedRun(w.h, /FROM main\.reject_replays r\b/, handshakeReplayStep, { now: NOW }, true);
      expect(step.result).toEqual({ done: false, delivers: true });
      return {
        hold: claim.plans.map((p) => [p.rows, p.plan.find((d) => / o /.test(` ${d} `)) ?? ""]),
        read: step.plans.map((p) => [p.rows, p.plan[0]]),
      };
    };
    const { before, after } = await staleStatistics(w.h, {
      capture: (phase) => cycle(phase === "before" ? w.alice : w.carol),
      // 20,000 intents (the tail key past them all) and 3,000 holds of 30 other local accounts, all due much later.
      grow: async () => {
        await sql(
          store,
          `WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < 20000)
					INSERT INTO outbound_activities (account_id, body, created_at)
					SELECT ?, '{"activity":{"type":"Reject","object":{"type":"Follow"}}}', 0 FROM k`,
          w.dan.id,
        );
        await remotes(store, 100, "8", false);
        for (let i = 0; i < 30; i++) {
          const local = `191${String(i).padStart(15, "0")}`;
          await sql(
            store,
            "INSERT INTO accounts (id, uri, username, domain) VALUES (?1, 'https://kopje.test/ap/users/g' || ?1, 'g' || ?1, NULL)",
            local,
          );
          await sql(
            store,
            "INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?1, ?1 || '@example.com', X'00', X'00', 'k')",
            local,
          );
          await sql(
            store,
            `INSERT INTO reject_replays (account_id, follower_id, follow_uri, check_at)
						SELECT ?, id, 'https://f/' || id, ? FROM accounts WHERE id LIKE '80000%'`,
            local,
            NOW + 1_000_000_000,
          );
        }
      },
    });
    // The intent and the hold each by rowid, and every statement's rows read the same after the growth.
    expect([before.hold.length, before.read.length]).toEqual([2, 1]);
    expect(after.hold.map(([, plan]) => plan)).toEqual(before.hold.map(([, plan]) => plan));
    for (const [, plan] of after.hold) {
      expect(plan).toMatch(/^SEARCH o USING INTEGER PRIMARY KEY \(rowid=\?\)$/);
    }
    expect(after.read.map(([, plan]) => plan)).toEqual(["SEARCH r USING INTEGER PRIMARY KEY (rowid=?)"]);
    expect(after).toEqual(before);
  }, 300_000);

  it("writes the recording's rows and two more at most a step (B2)", async () => {
    const w = await world();
    const r = await requests(w, w.bob, G1);
    await rejectRequest(w, w.bob, r);
    await suspend(w, r);
    expect(await drain(w.h.store)).toEqual([]);
    await lift(w, r);
    // Every input at its worst: the hold failed before (its reset then matches no row once it is deleted).
    await sql(w.h.store, "UPDATE reject_replays SET attempts = 1, due_at = ?", NOW);
    const bobUri = await uriOf(w.h.store, w.bob.id);
    const rUri = await uriOf(w.h.store, r);
    // The same recording made by hand, then undone: what the step's recording writes.
    const recording = await writtenBy(w.h.store, (db) =>
      recordOutbound(
        db,
        w.bob.id,
        followAnswerActivity("Reject", {
          localActorUri: bobUri,
          followerUri: rUri,
          followerId: r,
          followUri: G2,
          edgeId: "",
        }),
        NOW,
      ),
    );
    expect(recording.result).toBe(true);
    await sql(w.h.store, "DELETE FROM outbound_activities");
    await sql(w.h.store, "DELETE FROM deliveries");
    const step = await operationRows(w.h.store, handshakeReplayStep, { now: NOW });
    expect(step.result).toEqual({ done: false, delivers: true });
    expect(step.rows).toBeLessThanOrEqual(recording.rows + 2);
    // A deferral: the hold's move and its reset.
    await sql(
      w.h.store,
      "INSERT INTO reject_replays (account_id, follower_id, follow_uri, check_at, attempts, due_at) VALUES (?, ?, ?, ?, 1, ?)",
      w.bob.id,
      r,
      G1,
      NOW,
      NOW,
    );
    await suspend(w, r);
    expect(await operationRows(w.h.store, handshakeReplayStep, { now: NOW })).toEqual({
      result: { done: false, delivers: false },
      rows: 2,
    });
  });

  it("updates an existing pair at the cap, drops a new pair's Reject without stopping the claim, and reads the cap's entries (B3; C7)", async () => {
    const w = await world();
    const cap = HELD_REJECTS_PER_ACCOUNT;
    // bob holds the cap: one of r's (G1, the existing pair) and cap - 1 others.
    const r = await requests(w, w.bob, G1);
    await rejectRequest(w, w.bob, r);
    await suspend(w, r);
    expect(await drain(w.h.store)).toEqual([]);
    await remotes(w.h.store, cap - 1, "6", true);
    await sql(
      w.h.store,
      `INSERT INTO reject_replays (account_id, follower_id, follow_uri, check_at)
			SELECT ?, id, 'https://f/' || id, ? FROM accounts WHERE id LIKE '6%'`,
      w.bob.id,
      NOW,
    );
    expect(await holds(w.h.store)).toHaveLength(cap);
    // Statistics older than the holds of 30 other accounts at the cap (only bob's walk may count).
    await sql(w.h.store, "ANALYZE");
    await remotes(w.h.store, cap, "8", true);
    const others = [w.alice.id, w.carol.id, w.dan.id];
    for (const other of others) {
      await sql(
        w.h.store,
        `INSERT INTO reject_replays (account_id, follower_id, follow_uri, check_at)
				SELECT ?, id, 'https://f/' || id, ? FROM accounts WHERE id LIKE '80000%'`,
        other,
        NOW,
      );
    }
    // r's renewed request (G2) refused again: the existing pair's hold is replaced; and alice's post to s is delivered.
    await lift(w, r);
    await requests(w, w.bob, G2);
    expect((await holds(w.h.store)).filter((h) => h.account === w.bob.id)).toHaveLength(cap - 1);
    await sql(
      w.h.store,
      "INSERT INTO reject_replays (account_id, follower_id, follow_uri, check_at) VALUES (?, ?, ?, ?)",
      w.bob.id,
      r,
      G1,
      NOW,
    );
    await rejectRequest(w, w.bob, r);
    await suspend(w, r);
    // A new pair at the cap: n requests bob, who rejects it; n is suspended.
    const n = await remoteAccount(w.h.store, "n", "n.example");
    expect(
      await receive(w.h.store, await uriOf(w.h.store, n), {
        id: "https://n.example/follows/1",
        type: "Follow",
        object: await uriOf(w.h.store, w.bob.id),
      }),
    ).toMatchObject({ applied: true });
    await rejectRequest(w, w.bob, n);
    await suspend(w, n);
    // Another delivery in the same claim: alice's Follow of an available account.
    const s = await remoteAccount(w.h.store, "s", "s.example");
    expect((await w.h.request(`/api/v1/accounts/${s}/follow`, bearer(w.alice.token, json({})))).status).toBe(200);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result, plans } = await plannedRun(
      w.h,
      /reject_replays/,
      claimDeliveries,
      { now: NOW + 1, leaseToken: "b3" },
      true,
    );
    expect(result.deliveries.map((d) => d.inbox)).toEqual(["https://s.example/inbox"]);
    const events = warn.mock.calls.map(([entry]) => entry as Record<string, unknown>);
    expect(events.filter((e) => e.event === "kopje.delivery.reject_hold_capped")).toEqual([
      { event: "kopje.delivery.reject_hold_capped" },
    ]);
    warn.mockRestore();
    // The existing pair's hold took the new identity and check; no hold of n.
    const after = await holds(w.h.store);
    expect(after.filter((h) => h.account === w.bob.id)).toHaveLength(cap);
    expect(after.find((h) => h.follower === r)).toMatchObject({ follow_uri: G2, check_at: NOW + 1 + RECHECK });
    expect(after.find((h) => h.follower === n)).toBeUndefined();
    // Reads: each refused Reject's room (the pair's seek, and the cap's walk for a new pair) and the existing pair's
    // upsert (the guard passes it on the pair's seek); the cap's entries at most once a statement, whatever others hold.
    for (const plan of plans) {
      expect(plan.rows, plan.query).toBeLessThanOrEqual(cap + 12);
    }
    const total = plans.reduce((sum, p) => sum + p.rows, 0);
    expect(total).toBeLessThanOrEqual(2 * (cap + 12));
    // The writer's cap at 99: a new pair is held, its rows read the cap's walk twice (the writer's and the guard's).
    await sql(w.h.store, "DELETE FROM reject_replays WHERE follower_id = ?", r);
    await lift(w, n);
    const m = await remoteAccount(w.h.store, "m", "m.example");
    expect(
      await receive(w.h.store, await uriOf(w.h.store, m), {
        id: "https://m.example/follows/1",
        type: "Follow",
        object: await uriOf(w.h.store, w.bob.id),
      }),
    ).toMatchObject({ applied: true });
    await rejectRequest(w, w.bob, m);
    await suspend(w, m);
    const ninetyNine = await plannedRun(
      w.h,
      /reject_replays/,
      claimDeliveries,
      { now: NOW + 2, leaseToken: "b3b" },
      true,
    );
    expect((await holds(w.h.store)).filter((h) => h.account === w.bob.id)).toHaveLength(cap);
    const read = ninetyNine.plans.reduce((sum, p) => sum + p.rows, 0);
    expect(read).toBeGreaterThanOrEqual(2 * (cap - 1));
    expect(read).toBeLessThanOrEqual(2 * (cap + 12));
  }, 120_000);

  it("holds at most CLAIM_LIMIT Rejects in a claim", async () => {
    const w = await world();
    await lock(w, w.bob.id);
    for (let i = 0; i < CLAIM_LIMIT + 4; i++) {
      const id = await remoteAccount(w.h.store, "c", `c${i}.example`);
      expect(
        await receive(w.h.store, await uriOf(w.h.store, id), {
          id: `https://c${i}.example/follows/1`,
          type: "Follow",
          object: await uriOf(w.h.store, w.bob.id),
        }),
      ).toMatchObject({ applied: true });
      await rejectRequest(w, w.bob, id);
      await suspend(w, id);
    }
    await w.h.store.claimDeliveries(BUILD, { now: NOW, leaseToken: "limit" });
    expect(await holds(w.h.store)).toHaveLength(CLAIM_LIMIT);
  });
});
