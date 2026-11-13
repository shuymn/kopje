import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Db } from "../src/db/sql";
import { followActivity, recordOutbound } from "../src/domain/activities";
import { DOMAIN_BLOCK_BATCHES_PER_RUN, DOMAIN_BLOCK_WINDOW, runDomainBlockCleanups } from "../src/domain/blocks";
import {
  CLAIM_LIMIT,
  claimDeliveries,
  enqueueActivity,
  HANDSHAKE_RECHECK_MS,
  TARGET_CHUNK_BYTES,
} from "../src/domain/deliveries";
import { handshakeReplayStep } from "../src/domain/handshake-replays";
import { MOVE_BATCH, runInboundJobs } from "../src/domain/inbox";
import type { StoreStub } from "../src/platform/store-client";
import type { StoreOperation } from "../src/platform/store-kernel";
import { sha256Hex } from "../src/security/tokens";
import { bearer, json, settle, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { blockDomain, unblockDomain } from "./domain-block-helpers";
import { BUILD, drainDeliveries } from "./helpers";
import { writtenBy } from "./inbox-store-helpers";
import { plannedRun, scansOf, staleStatistics } from "./read-helpers";
import { act, receive, unsuspend, uriOf, world, type World } from "./remote-suspension-helpers";
import { follow, post, remoteAccount } from "./status-helpers";

// VIS-30's held handshakes (src/domain/handshake-replays.ts, deliveries.ts holdHandshake): a Follow or Accept the
// send-time check drops because of its recipient holds its follow, and a jobs round records it again, with its
// original id, once the recipient is available. #1422 (a local Follow) and #1423 (an Accept to a remote follower).

const RECHECK = HANDSHAKE_RECHECK_MS;

afterEach(() => {
  vi.restoreAllMocks();
});

type Body = { id: string; type: string; actor: string; object: string | { id?: string; type?: string } };
type Sent = { type: string; id: string; inbox: string; object: Body["object"] };

// Claims at `now` until nothing is due then; each row sent, in order.
function drain(store: StoreStub, now = NOW): Promise<Sent[]> {
  return drainDeliveries(
    store,
    ({ inbox, body }) => {
      const parsed = JSON.parse(body) as Body;
      return { type: parsed.type, id: parsed.id, inbox, object: parsed.object };
    },
    { now, until: "due" },
  );
}

type HoldRow = { follow_id: string; check_at: number; attempts: number };

const holds = (store: StoreStub) =>
  sql<HoldRow>(
    store,
    "SELECT CAST(follow_id AS TEXT) AS follow_id, check_at, attempts FROM handshake_replays ORDER BY follow_id",
  );

const replays = (store: StoreStub, now: number) => store.runHandshakeReplays(BUILD, { now });

const edge = async (store: StoreStub, follower: string, target: string) =>
  (
    await sql<{ id: string; state: string; uri: string | null }>(
      store,
      "SELECT CAST(id AS TEXT) AS id, state, uri FROM follows WHERE account_id = ? AND target_account_id = ?",
      follower,
      target,
    )
  )[0];

// The intents of `type` recorded so far, with their follow pair.
const intents = (store: StoreStub, type: string) =>
  sql<{ id: string; pair: string | null }>(
    store,
    `SELECT json_extract(body, '$.activity.id') AS id, follow_pair AS pair FROM outbound_activities
		WHERE json_extract(body, '$.activity.type') = ? ORDER BY id`,
    type,
  );

const suspend = async (w: World, id: string) =>
  expect(await act(w, id, { type: "suspend" })).toMatchObject({ status: 200 });

const lift = async (w: World, id: string) => expect(await unsuspend(w, id)).toMatchObject({ status: 200 });

const SHARED = "https://remote.example/inbox";
const PERSONAL = "https://remote.example/users/r/inbox";

// alice follows r (remote.example): her Follow is queued with the id kept in the follow.
async function aliceFollowsR(w: World): Promise<{ r: string; id: string; uri: string }> {
  const r = await remoteAccount(w.h.store, "r", "remote.example");
  await follow(w.h, w.alice, r);
  const row = (await edge(w.h.store, w.alice.id, r))!;
  expect(row).toMatchObject({ state: "pending" });
  return { r, id: row.id, uri: row.uri! };
}

// r follows alice, unlocked, with `followId`: her Accept is queued.
async function rFollowsAlice(w: World, followId = "https://remote.example/follows/1") {
  const r =
    (await sql<{ id: string }>(w.h.store, "SELECT id FROM accounts WHERE username = 'r'"))[0]?.id ??
    (await remoteAccount(w.h.store, "r", "remote.example"));
  const aliceUri = await uriOf(w.h.store, w.alice.id);
  expect(
    await receive(w.h.store, await uriOf(w.h.store, r), { id: followId, type: "Follow", object: aliceUri }),
  ).toMatchObject({ applied: true });
  const accept = `${aliceUri}#accepts/follows/${await sha256Hex(followId)}`;
  return { r, aliceUri, accept, edgeId: (await edge(w.h.store, r, w.alice.id))!.id };
}

describe("a Follow refused at its claim (#1422)", () => {
  it("is held, kept while the account is suspended, and sent with its id once it is not; the peer's Accept lands", async () => {
    const w = await world();
    const { r, id, uri } = await aliceFollowsR(w);
    await suspend(w, r);
    expect(await drain(w.h.store)).toEqual([]);
    expect(await holds(w.h.store)).toEqual([{ follow_id: id, check_at: NOW + RECHECK, attempts: 0 }]);
    // W3: a round while r is suspended selects the hold, moves its check and records nothing.
    expect(await replays(w.h.store, NOW + RECHECK)).toEqual({ pending: false, delivers: false });
    expect(await holds(w.h.store)).toEqual([{ follow_id: id, check_at: NOW + 2 * RECHECK, attempts: 0 }]);
    expect(await intents(w.h.store, "Follow")).toEqual([]);
    expect(await drain(w.h.store, NOW + RECHECK)).toEqual([]);
    // A round before the check is due selects nothing.
    await lift(w, r);
    expect(await replays(w.h.store, NOW + 2 * RECHECK - 1)).toEqual({ pending: false, delivers: false });
    expect(await holds(w.h.store)).toHaveLength(1);
    const at = NOW + 2 * RECHECK;
    expect(await replays(w.h.store, at)).toEqual({ pending: false, delivers: true });
    expect(await holds(w.h.store)).toEqual([]);
    expect(await drain(w.h.store, at)).toEqual([
      { type: "Follow", id: uri, inbox: SHARED, object: await uriOf(w.h.store, r) },
    ]);
    const aliceUri = await uriOf(w.h.store, w.alice.id);
    expect(
      await receive(w.h.store, await uriOf(w.h.store, r), {
        type: "Accept",
        object: { id: uri, type: "Follow", actor: aliceUri, object: await uriOf(w.h.store, r) },
      }),
    ).toMatchObject({ applied: true });
    expect(await edge(w.h.store, w.alice.id, r)).toMatchObject({ state: "accepted", uri });
  });

  it("is held when the domain's block is lifted before its job severs, from the claim or from confirmation", async () => {
    for (const at of ["claim", "confirm"] as const) {
      const w = await world();
      const r = await remoteAccount(w.h.store, "r", "d.example");
      await follow(w.h, w.alice, r);
      const { id, uri } = (await edge(w.h.store, w.alice.id, r))!;
      let block;
      if (at === "claim") {
        block = await blockDomain(w.h.store, "d.example");
        expect(await drain(w.h.store)).toEqual([]);
      } else {
        const claim = await w.h.store.claimDeliveries(BUILD, { now: NOW, leaseToken: "held" });
        expect(claim.deliveries).toHaveLength(1);
        block = await blockDomain(w.h.store, "d.example");
        expect(
          await w.h.store.confirmDelivery(BUILD, { id: claim.deliveries[0]!.id, leaseToken: "held", now: NOW }),
        ).toMatchObject({ status: "dropped" });
      }
      expect(await holds(w.h.store), at).toEqual([{ follow_id: id, check_at: NOW + RECHECK, attempts: 0 }]);
      await unblockDomain(w.h.store, block.id);
      await settle(w.h.store);
      expect(await edge(w.h.store, w.alice.id, r)).toMatchObject({ state: "pending", uri });
      expect(await replays(w.h.store, NOW + RECHECK)).toMatchObject({ delivers: true });
      expect((await drain(w.h.store, NOW + RECHECK)).map((s) => [s.type, s.id, s.inbox])).toEqual([
        ["Follow", uri, "https://d.example/inbox"],
      ]);
    }
  });

  it("records nothing while an unsuspension leaves the account covered by a block (converted)", async () => {
    const w = await world();
    const r = await remoteAccount(w.h.store, "r", "d.example");
    await follow(w.h, w.alice, r);
    const { id } = (await edge(w.h.store, w.alice.id, r))!;
    await suspend(w, r);
    await blockDomain(w.h.store, "d.example");
    expect(await drain(w.h.store)).toEqual([]);
    await lift(w, r);
    expect(await sql(w.h.store, "SELECT suspension_source FROM accounts WHERE id = ?", r)).toEqual([
      { suspension_source: "domain" },
    ]);
    expect(await replays(w.h.store, NOW + RECHECK)).toEqual({ pending: false, delivers: false });
    expect(await holds(w.h.store)).toEqual([{ follow_id: id, check_at: NOW + 2 * RECHECK, attempts: 0 }]);
    expect(await intents(w.h.store, "Follow")).toEqual([]);
    expect(await drain(w.h.store, NOW + RECHECK)).toEqual([]);
  });

  it("is held again when its replay is refused at its claim, and sent exactly once in the end (W4)", async () => {
    const w = await world();
    const { r, id, uri } = await aliceFollowsR(w);
    await suspend(w, r);
    const sent = [...(await drain(w.h.store))];
    await lift(w, r);
    const first = NOW + RECHECK;
    expect(await replays(w.h.store, first)).toMatchObject({ delivers: true });
    await suspend(w, r);
    sent.push(...(await drain(w.h.store, first)));
    expect(await holds(w.h.store)).toEqual([{ follow_id: id, check_at: first + RECHECK, attempts: 0 }]);
    await lift(w, r);
    expect(await replays(w.h.store, first + RECHECK)).toMatchObject({ delivers: true });
    sent.push(...(await drain(w.h.store, first + RECHECK)));
    expect(await replays(w.h.store, first + 3 * RECHECK)).toEqual({ pending: false, delivers: false });
    sent.push(...(await drain(w.h.store, first + 3 * RECHECK)));
    expect(sent.map((s) => [s.type, s.id])).toEqual([["Follow", uri]]);
  });

  it("ends with an unfollow while the account is suspended: the Undo goes, and nothing is replayed (W5)", async () => {
    const w = await world();
    const { r, uri } = await aliceFollowsR(w);
    await suspend(w, r);
    expect(await drain(w.h.store)).toEqual([]);
    expect(await holds(w.h.store)).toHaveLength(1);
    expect((await w.h.request(`/api/v1/accounts/${r}/unfollow`, bearer(w.alice.token, json({})))).status).toBe(200);
    expect(await holds(w.h.store)).toEqual([]);
    expect((await drain(w.h.store)).map((s) => [s.type, s.id])).toEqual([["Undo", `${uri}/undo`]]);
    await lift(w, r);
    expect(await replays(w.h.store, NOW + RECHECK)).toEqual({ pending: false, delivers: false });
    expect(await drain(w.h.store, NOW + RECHECK)).toEqual([]);
  });
});

describe("an Accept refused at its claim (#1423)", () => {
  it("is held through a short suspension whose job ends without severing, and sent with its id", async () => {
    const w = await world();
    const { r, accept, edgeId } = await rFollowsAlice(w);
    await suspend(w, r);
    expect(await drain(w.h.store)).toEqual([]);
    expect(await holds(w.h.store)).toEqual([{ follow_id: edgeId, check_at: NOW + RECHECK, attempts: 0 }]);
    await lift(w, r);
    await settle(w.h.store);
    expect(await edge(w.h.store, r, w.alice.id)).toMatchObject({ state: "accepted" });
    expect(await replays(w.h.store, NOW + RECHECK)).toMatchObject({ delivers: true });
    // The replay is the pair's answer (NET-2).
    expect(await intents(w.h.store, "Accept")).toEqual([{ id: accept, pair: r }]);
    expect(await drain(w.h.store, NOW + RECHECK)).toEqual([
      {
        type: "Accept",
        id: accept,
        inbox: SHARED,
        object: expect.objectContaining({ id: "https://remote.example/follows/1", type: "Follow" }),
      },
    ]);
  });
});

describe("what is never held (W9)", () => {
  it("drops a stale Accept that is also refused without a hold; the newer generation's Accept is held", async () => {
    const w = await world();
    const { r, aliceUri, accept } = await rFollowsAlice(w);
    // The first Accept is leased, then r follows again: the leased one is superseded (stale) and the new one queued.
    const claim = await w.h.store.claimDeliveries(BUILD, { now: NOW, leaseToken: "lost" });
    expect(claim.deliveries).toHaveLength(1);
    const renewal = "https://remote.example/follows/2";
    expect(
      await receive(w.h.store, await uriOf(w.h.store, r), { id: renewal, type: "Follow", object: aliceUri }),
    ).toMatchObject({ applied: true });
    await suspend(w, r);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // The lease expires: the claim reads the stale Accept, which the send-time check refuses first.
    const later = NOW + 60_000;
    const first = await w.h.store.claimDeliveries(BUILD, { now: later, leaseToken: "again" });
    expect(first.deliveries).toEqual([]);
    expect(
      await sql(w.h.store, "SELECT 1 FROM outbound_activities WHERE json_extract(body, '$.activity.id') = ?", accept),
    ).toEqual([]);
    expect(await holds(w.h.store)).toEqual([]);
    expect(warn.mock.calls.map(([entry]) => (entry as { event?: string }).event)).not.toContain(
      "kopje.delivery.stale_follow_answer",
    );
    // The guarded branch: the newer Accept, current and refused, is held.
    expect(await drain(w.h.store, later)).toEqual([]);
    expect(await holds(w.h.store)).toEqual([
      { follow_id: (await edge(w.h.store, r, w.alice.id))!.id, check_at: later + RECHECK, attempts: 0 },
    ]);
  });

  it("drops a Follow whose local sender is suspended without a hold", async () => {
    const w = await world();
    const { r } = await aliceFollowsR(w);
    await suspend(w, w.alice.id);
    expect(await drain(w.h.store)).toEqual([]);
    expect(await sql(w.h.store, "SELECT 1 FROM deliveries")).toEqual([]);
    expect(await holds(w.h.store)).toEqual([]);
    expect(await edge(w.h.store, w.alice.id, r)).toMatchObject({ state: "pending" });
  });

  it("drops content and a quote's Accept without a hold; a Reject of a request is held apart (reject_replays)", async () => {
    const w = await world();
    const { r, aliceUri, edgeId } = await rFollowsAlice(w);
    expect(await drain(w.h.store)).toHaveLength(1);
    // r asks locked bob, who rejects: a Reject that withdraws nothing.
    await sql(w.h.store, "UPDATE accounts SET locked = 1 WHERE id = ?", w.bob.id);
    expect(
      await receive(w.h.store, await uriOf(w.h.store, r), { type: "Follow", object: await uriOf(w.h.store, w.bob.id) }),
    ).toMatchObject({ applied: true });
    expect(
      (await w.h.request(`/api/v1/follow_requests/${r}/reject`, bearer(w.bob.token, { method: "POST" }))).status,
    ).toBe(200);
    // Content to r, and an Accept of a quote request that names r's follow's Follow id but carries no follow pair.
    await post(w.h, w.alice, { status: "to followers" });
    await runInDurableObject(w.h.store, (_instance, state) => {
      const db = new Db(state.storage.sql);
      state.storage.transactionSync(() =>
        enqueueActivity(
          db,
          w.alice.id,
          {
            activity: {
              id: `${aliceUri}#quote-accept`,
              type: "Accept",
              actor: aliceUri,
              object: { id: "https://remote.example/follows/1", type: "QuoteRequest" },
            },
            audience: { followers: false, accounts: [r] },
          },
          NOW,
        ),
      );
    });
    const queued = await sql<{ type: string }>(
      w.h.store,
      `SELECT json_extract(o.body, '$.activity.type') AS type FROM deliveries d
			JOIN outbound_activities o ON o.id = d.activity_id ORDER BY d.id`,
    );
    expect(queued.map((row) => row.type)).toEqual(["Reject", "Create", "Accept"]);
    await suspend(w, r);
    expect(await drain(w.h.store)).toEqual([]);
    expect(await sql(w.h.store, "SELECT 1 FROM deliveries")).toEqual([]);
    expect(await holds(w.h.store)).toEqual([]);
    // The Reject's pair holds it (test/reject-replays.test.ts); content and the quote's Accept hold nothing.
    expect(await sql(w.h.store, "SELECT account_id, follower_id FROM reject_replays")).toEqual([
      { account_id: w.bob.id, follower_id: r },
    ]);
    expect(await edge(w.h.store, r, w.alice.id)).toMatchObject({ id: edgeId, state: "accepted" });
  });
});

describe("an inbox the replay cannot use (W10)", () => {
  // A held Follow of r, r unsuspended with `routing` stored: the round keeps the hold; with r's inbox back, it replays.
  it.each([
    ["an http inbox and no shared inbox", "inbox_url = 'http://remote.example/users/r/inbox', shared_inbox_url = NULL"],
    [
      "a target past TARGET_CHUNK_BYTES (an imported https inbox)",
      `inbox_url = 'https://remote.example/' || replace(hex(zeroblob(${TARGET_CHUNK_BYTES / 2})), '00', 'ab'),
				shared_inbox_url = NULL`,
    ],
  ])("keeps the hold over %s, and replays once the routing is repaired", async (_name, routing) => {
    const w = await world();
    const { r, id, uri } = await aliceFollowsR(w);
    await suspend(w, r);
    expect(await drain(w.h.store)).toEqual([]);
    await sql(w.h.store, `UPDATE accounts SET ${routing} WHERE id = ?`, r);
    await lift(w, r);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await replays(w.h.store, NOW + RECHECK)).toEqual({ pending: false, delivers: false });
    expect(await holds(w.h.store)).toEqual([{ follow_id: id, check_at: NOW + 2 * RECHECK, attempts: 0 }]);
    expect(await intents(w.h.store, "Follow")).toEqual([]);
    warn.mockRestore();
    await sql(w.h.store, "UPDATE accounts SET inbox_url = ?, shared_inbox_url = ? WHERE id = ?", PERSONAL, SHARED, r);
    expect(await replays(w.h.store, NOW + 2 * RECHECK)).toMatchObject({ delivers: true });
    expect(await holds(w.h.store)).toEqual([]);
    expect((await drain(w.h.store, NOW + 2 * RECHECK)).map((s) => [s.type, s.id, s.inbox])).toEqual([
      ["Follow", uri, SHARED],
    ]);
  });

  it("replays to the personal inbox of an account whose shared inbox is stored empty", async () => {
    const w = await world();
    const { r, uri } = await aliceFollowsR(w);
    await suspend(w, r);
    expect(await drain(w.h.store)).toEqual([]);
    await sql(w.h.store, "UPDATE accounts SET shared_inbox_url = '' WHERE id = ?", r);
    await lift(w, r);
    expect(await replays(w.h.store, NOW + RECHECK)).toMatchObject({ delivers: true });
    expect((await drain(w.h.store, NOW + RECHECK)).map((s) => [s.type, s.id, s.inbox])).toEqual([
      ["Follow", uri, PERSONAL],
    ]);
  });
});

const LATER = NOW + RECHECK;
const G1 = "https://remote.example/follows/1";
const G2 = "https://remote.example/follows/2";

// r's Follow of alice with the id `g2`, or its Undo of g1.
async function answerChange(w: World, r: string, aliceUri: string, change: "Follow" | "Undo") {
  const rUri = await uriOf(w.h.store, r);
  const activity =
    change === "Follow"
      ? { id: G2, type: "Follow", object: aliceUri }
      : { type: "Undo", object: { id: G1, type: "Follow", actor: rUri, object: aliceUri } };
  expect(await receive(w.h.store, rUri, activity)).toMatchObject({ applied: true });
}

describe("a generation change ends the hold (W6a, W7)", () => {
  it("sends only the new generation's Accept when r follows again before the replay", async () => {
    const w = await world();
    const { r, aliceUri, accept } = await rFollowsAlice(w, G1);
    await suspend(w, r);
    expect(await drain(w.h.store)).toEqual([]);
    expect(await holds(w.h.store)).toHaveLength(1);
    await lift(w, r);
    await answerChange(w, r, aliceUri, "Follow");
    expect(await holds(w.h.store)).toEqual([]);
    expect(await replays(w.h.store, LATER)).toEqual({ pending: false, delivers: false });
    const sent = [...(await drain(w.h.store)), ...(await drain(w.h.store, LATER))];
    expect(sent.map((s) => [s.type, s.id])).toEqual([["Accept", `${aliceUri}#accepts/follows/${await sha256Hex(G2)}`]]);
    expect(sent.map((s) => s.id)).not.toContain(accept);
  });

  it.each(["undo", "removal"] as const)(
    "replays nothing after the follow ends by its %s while r is suspended",
    async (by) => {
      const w = await world();
      const { r, aliceUri } = await rFollowsAlice(w, G1);
      await suspend(w, r);
      expect(await drain(w.h.store)).toEqual([]);
      expect(await holds(w.h.store)).toHaveLength(1);
      if (by === "undo") {
        await answerChange(w, r, aliceUri, "Undo");
      } else {
        const removed = await w.h.request(
          `/api/v1/accounts/${r}/remove_from_followers`,
          bearer(w.alice.token, { method: "POST" }),
        );
        expect(removed.status).toBe(200);
      }
      expect(await edge(w.h.store, r, w.alice.id)).toBeUndefined();
      expect(await holds(w.h.store)).toEqual([]);
      await lift(w, r);
      expect(await replays(w.h.store, LATER)).toEqual({ pending: false, delivers: false });
      const sent = [...(await drain(w.h.store)), ...(await drain(w.h.store, LATER))];
      expect(sent.filter((s) => s.type === "Accept")).toEqual([]);
    },
  );
});

describe("a replayed Accept is the pair's answer (W6b–e, NET-2)", () => {
  // r's follow of alice, its Accept held and replayed at LATER; `ahead` runs before the replay.
  async function replayed(ahead: (w: World) => Promise<void> = async () => {}) {
    const w = await world();
    const { r, aliceUri, accept } = await rFollowsAlice(w, G1);
    await suspend(w, r);
    expect(await drain(w.h.store)).toEqual([]);
    await lift(w, r);
    await settle(w.h.store);
    await ahead(w);
    expect(await replays(w.h.store, LATER)).toMatchObject({ delivers: true });
    expect(await intents(w.h.store, "Accept")).toEqual([{ id: accept, pair: r }]);
    return { w, r, aliceUri, accept };
  }

  const renewed = async (w: World, change: "Follow" | "Undo", aliceUri: string) =>
    change === "Follow" ? [["Accept", `${aliceUri}#accepts/follows/${await sha256Hex(G2)}`]] : [];

  it.each(["Follow", "Undo"] as const)("cancels it queued behind another row of its lane (%s)", async (change) => {
    const { w, r, aliceUri, accept } = await replayed(async (w) => {
      await post(w.h, w.alice, { status: "ahead" });
    });
    expect((await sql(w.h.store, "SELECT state FROM deliveries ORDER BY id")).map((row) => row.state)).toEqual([
      "pending",
      "queued",
    ]);
    await answerChange(w, r, aliceUri, change);
    expect((await intents(w.h.store, "Accept")).map((i) => i.id)).not.toContain(accept);
    const sent = await drain(w.h.store, LATER);
    expect(sent.map((s) => [s.type, s.id]).filter(([type]) => type !== "Create")).toEqual(
      await renewed(w, change, aliceUri),
    );
  });

  it.each(["Follow", "Undo"] as const)(
    "cancels it while its targets are not yet expanded behind a backlog (%s)",
    async (change) => {
      const { w, r, aliceUri, accept } = await replayed(async (w) => {
        // 350 followers on servers of their own: the Create's targets stay unexpanded past two expansion steps.
        await backlog(w, 350);
        await post(w.h, w.alice, { status: "to many servers" });
      });
      expect(
        await sql(
          w.h.store,
          `SELECT 1 FROM outbound_targets t JOIN outbound_activities o ON o.id = t.activity_id
					WHERE json_extract(o.body, '$.activity.id') = ?`,
          accept,
        ),
      ).toHaveLength(1);
      await answerChange(w, r, aliceUri, change);
      expect((await intents(w.h.store, "Accept")).map((i) => i.id)).not.toContain(accept);
      const sent = await drain(w.h.store, LATER);
      expect(sent.filter((s) => s.type !== "Create").map((s) => [s.type, s.id])).toEqual(
        await renewed(w, change, aliceUri),
      );
    },
    60_000,
  );

  it.each(["Follow", "Undo"] as const)(
    "supersedes it leased, and confirmation drops it as stale (%s)",
    async (change) => {
      const { w, r, aliceUri } = await replayed();
      const claim = await w.h.store.claimDeliveries(BUILD, { now: LATER, leaseToken: "held" });
      expect(claim.deliveries).toHaveLength(1);
      await answerChange(w, r, aliceUri, change);
      expect(await intents(w.h.store, "Accept")).toEqual(
        expect.arrayContaining([expect.objectContaining({ pair: r })]),
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(
        await w.h.store.confirmDelivery(BUILD, { id: claim.deliveries[0]!.id, leaseToken: "held", now: LATER }),
      ).toMatchObject({ status: "dropped" });
      expect(warn.mock.calls.map(([entry]) => entry as unknown)).toContainEqual({
        event: "kopje.delivery.stale_follow_answer",
        type: "Accept",
        at: "confirm",
      });
      warn.mockRestore();
      const sent = await drain(w.h.store, LATER);
      expect(sent.map((s) => [s.type, s.id])).toEqual(await renewed(w, change, aliceUri));
    },
  );

  it.each(["Follow", "Undo"] as const)(
    "is sent when confirmed before the change commits, and logged as sent in flight (%s)",
    async (change) => {
      const { w, r, aliceUri, accept } = await replayed();
      const claim = await w.h.store.claimDeliveries(BUILD, { now: LATER, leaseToken: "held" });
      const id = claim.deliveries[0]!.id;
      const confirmed = await w.h.store.confirmDelivery(BUILD, { id, leaseToken: "held", now: LATER });
      expect(confirmed).toMatchObject({ status: "send" });
      expect(JSON.parse((confirmed as { body: string }).body)).toMatchObject({ id: accept });
      await answerChange(w, r, aliceUri, change);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await w.h.store.completeDelivery(BUILD, {
        id,
        leaseToken: "held",
        now: LATER,
        outcome: { kind: "delivered", status: 202 },
      });
      expect(warn.mock.calls.map(([entry]) => entry as unknown)).toContainEqual({
        event: "kopje.delivery.stale_follow_answer",
        type: "Accept",
        at: "sent_in_flight",
      });
    },
  );
});

// `n` remote followers of alice, each on a server of its own (one target each).
async function backlog(w: World, n: number): Promise<void> {
  await sql(
    w.h.store,
    `WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < ?1)
		INSERT INTO accounts (id, uri, username, domain, inbox_url, shared_inbox_url)
		SELECT printf('3%017d', i), 'https://f' || i || '.example/u', 'f', 'f' || i || '.example',
			'https://f' || i || '.example/u/inbox', 'https://f' || i || '.example/inbox' FROM k`,
    n,
  );
  await sql(
    w.h.store,
    `INSERT INTO follows (account_id, target_account_id, state)
		SELECT id, ?, 'accepted' FROM accounts WHERE id LIKE '3%' AND domain LIKE 'f%.example'`,
    w.alice.id,
  );
}

describe("severing (W8)", () => {
  it("in an account's suspension severs the held Accept's follow, keeps r's request, and replays alice's Follow", async () => {
    const w = await world();
    const { r, aliceUri } = await rFollowsAlice(w, G1);
    // r asks locked bob, and alice follows r: her Follow is queued too.
    await sql(w.h.store, "UPDATE accounts SET locked = 1 WHERE id = ?", w.bob.id);
    expect(
      await receive(w.h.store, await uriOf(w.h.store, r), { type: "Follow", object: await uriOf(w.h.store, w.bob.id) }),
    ).toMatchObject({ applied: true });
    await follow(w.h, w.alice, r);
    const { id: aliceEdge, uri } = (await edge(w.h.store, w.alice.id, r))!;
    await suspend(w, r);
    expect(await drain(w.h.store)).toEqual([]);
    expect(await holds(w.h.store)).toHaveLength(2);
    await settle(w.h.store);
    // r's accepted follow of alice is severed with the withdrawing Reject to r's personal inbox; its hold goes.
    expect(await edge(w.h.store, r, w.alice.id)).toBeUndefined();
    expect(await edge(w.h.store, r, w.bob.id)).toMatchObject({ state: "pending" });
    expect(await holds(w.h.store)).toEqual([{ follow_id: aliceEdge, check_at: NOW + RECHECK, attempts: 0 }]);
    expect((await drain(w.h.store)).map((s) => [s.type, s.inbox, (s.object as { id?: string }).id])).toEqual([
      ["Reject", PERSONAL, G1],
    ]);
    await lift(w, r);
    expect(await replays(w.h.store, LATER)).toMatchObject({ delivers: true });
    expect((await drain(w.h.store, LATER)).map((s) => [s.type, s.id])).toEqual([["Follow", uri]]);
    expect(aliceUri).toBeDefined();
  });

  it("in a domain block severs both ways, and the holds go with the follows", async () => {
    const w = await world();
    const r = await remoteAccount(w.h.store, "r", "d.example");
    const aliceUri = await uriOf(w.h.store, w.alice.id);
    expect(
      await receive(w.h.store, await uriOf(w.h.store, r), {
        id: "https://d.example/f/1",
        type: "Follow",
        object: aliceUri,
      }),
    ).toMatchObject({ applied: true });
    await follow(w.h, w.alice, r);
    await blockDomain(w.h.store, "d.example");
    expect(await drain(w.h.store)).toEqual([]);
    expect(await holds(w.h.store)).toHaveLength(2);
    await settle(w.h.store);
    expect(await edge(w.h.store, r, w.alice.id)).toBeUndefined();
    expect(await edge(w.h.store, w.alice.id, r)).toBeUndefined();
    expect(await holds(w.h.store)).toEqual([]);
    expect(await replays(w.h.store, LATER)).toEqual({ pending: false, delivers: false });
  });
});

describe("the replayed id (W11, W12)", () => {
  it("replays the Accept of an edge without a uri with its edge id, byte for byte", async () => {
    const w = await world();
    const r = await remoteAccount(w.h.store, "r", "remote.example");
    await sql(w.h.store, "UPDATE accounts SET locked = 1 WHERE id = ?", w.alice.id);
    // An imported request: no Follow id.
    await sql(
      w.h.store,
      "INSERT INTO follows (account_id, target_account_id, state, uri) VALUES (?, ?, 'pending', NULL)",
      r,
      w.alice.id,
    );
    expect(
      (await w.h.request(`/api/v1/follow_requests/${r}/authorize`, bearer(w.alice.token, { method: "POST" }))).status,
    ).toBe(200);
    const body = "SELECT json_extract(body, '$.activity') AS a FROM outbound_activities";
    const [original] = await sql<{ a: string }>(w.h.store, body);
    const edgeId = (await edge(w.h.store, r, w.alice.id))!.id;
    expect(JSON.parse(original!.a)).toMatchObject({
      id: `${await uriOf(w.h.store, w.alice.id)}#accepts/follows/${edgeId}`,
    });
    expect((JSON.parse(original!.a) as { object: { id?: string } }).object.id).toBeUndefined();
    await suspend(w, r);
    expect(await drain(w.h.store)).toEqual([]);
    expect(await holds(w.h.store)).toHaveLength(1);
    await lift(w, r);
    expect(await replays(w.h.store, LATER)).toMatchObject({ delivers: true });
    expect(await sql(w.h.store, body)).toEqual([original]);
  });

  it("replays a pair-shaped Follow's Accept with its id; a pair Undo and a new pair Follow leave nothing to replay", async () => {
    const w = await world();
    const r = await remoteAccount(w.h.store, "r", "remote.example");
    const pair = `https://remote.example/follows/${r}/${w.alice.id}`;
    const { aliceUri, accept } = await rFollowsAlice(w, pair);
    await suspend(w, r);
    expect(await drain(w.h.store)).toEqual([]);
    await lift(w, r);
    expect(await replays(w.h.store, LATER)).toMatchObject({ delivers: true });
    expect((await drain(w.h.store, LATER)).map((s) => [s.type, s.id])).toEqual([["Accept", accept]]);
    // Held again, then undone by its pair id and followed again with it: a new row, no hold.
    await suspend(w, r);
    const rUri = await uriOf(w.h.store, r);
    await sql(w.h.store, "UPDATE follows SET state = 'accepted' WHERE account_id = ?", r);
    await sql(
      w.h.store,
      "INSERT INTO handshake_replays (follow_id, check_at) SELECT id, ? FROM follows WHERE account_id = ?",
      LATER,
      r,
    );
    expect(
      await receive(w.h.store, rUri, {
        type: "Undo",
        object: { id: pair, type: "Follow", actor: rUri, object: aliceUri },
      }),
    ).toMatchObject({ applied: true });
    expect(await holds(w.h.store)).toEqual([]);
    await lift(w, r);
    expect(await receive(w.h.store, rUri, { id: pair, type: "Follow", object: aliceUri })).toMatchObject({
      applied: true,
    });
    expect(await holds(w.h.store)).toEqual([]);
    expect(await replays(w.h.store, LATER + RECHECK)).toEqual({ pending: false, delivers: false });
  });
});

describe("the account's deletion (W13)", () => {
  it("purges its follows, and their holds go with them", async () => {
    const w = await world();
    const { r, aliceUri } = await rFollowsAlice(w, G1);
    await follow(w.h, w.alice, r);
    await suspend(w, r);
    expect(await drain(w.h.store)).toEqual([]);
    expect(await holds(w.h.store)).toHaveLength(2);
    const rUri = await uriOf(w.h.store, r);
    // The actor's Delete of itself, as the Worker passes it once its document is gone.
    expect(await receive(w.h.store, rUri, { type: "DeleteActor" })).toMatchObject({ applied: true });
    await settle(w.h.store);
    expect(await sql(w.h.store, "SELECT 1 FROM follows WHERE ? IN (account_id, target_account_id)", r)).toEqual([]);
    expect(await holds(w.h.store)).toEqual([]);
    expect(aliceUri).toBeDefined();
  });
});

describe("a hold that keeps failing (W14, RES-5)", () => {
  it("backs off and parks while another is replayed, and replays after the admin's retry", async () => {
    const w = await world();
    const { r, id, uri } = await aliceFollowsR(w);
    const s = await remoteAccount(w.h.store, "s", "other.example");
    await follow(w.h, w.alice, s);
    const other = (await edge(w.h.store, w.alice.id, s))!;
    await suspend(w, r);
    await suspend(w, s);
    expect(await drain(w.h.store)).toEqual([]);
    await lift(w, r);
    await lift(w, s);
    // Recording r's Follow fails.
    await sql(
      w.h.store,
      `CREATE TRIGGER test_record_fails BEFORE INSERT ON outbound_activities
			WHEN json_extract(NEW.body, '$.activity.id') = '${uri}' BEGIN SELECT RAISE(ABORT, 'test: recording fails'); END`,
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let at = LATER;
    expect(await replays(w.h.store, at)).toMatchObject({ delivers: true });
    expect((await drain(w.h.store, at)).map((s) => s.id)).toEqual([other.uri]);
    const seen: [number, number | null][] = [];
    for (let i = 0; i < 6; i++) {
      const [row] = await sql<{ attempts: number; due_at: number | null }>(
        w.h.store,
        "SELECT attempts, due_at FROM handshake_replays WHERE follow_id = ?",
        id,
      );
      seen.push([row!.attempts, row!.due_at === null ? null : row!.due_at - at]);
      at = row!.due_at ?? at;
      if (row!.due_at !== null) {
        await replays(w.h.store, at);
      }
    }
    expect(seen).toEqual([
      [1, 5 * 60_000],
      [2, 10 * 60_000],
      [3, 20 * 60_000],
      [4, 40 * 60_000],
      [5, 80 * 60_000],
      [6, null],
    ]);
    expect(warn.mock.calls.map(([entry]) => entry as unknown)).toContainEqual({
      event: "kopje.jobs.item.parked",
      family: "handshake_replays",
    });
    expect(error.mock.calls.length).toBeGreaterThan(0);
    expect(await replays(w.h.store, at + 86_400_000)).toEqual({ pending: false, delivers: false });
    await sql(w.h.store, "DROP TRIGGER test_record_fails");
    expect(await w.h.store.retryParkedJobs(BUILD, {})).toEqual({ reset: 1, more: false });
    expect(await replays(w.h.store, at)).toMatchObject({ delivers: true });
    expect((await drain(w.h.store, at)).map((s) => s.id)).toEqual([uri]);
  });
});

describe("inbound acceptance's rule (W15)", () => {
  it("replays the Accept of a follower that blocks alice, and nothing once alice blocks it", async () => {
    for (const blocker of ["r", "alice"] as const) {
      const w = await world();
      const r = await remoteAccount(w.h.store, "r", "remote.example");
      await sql(w.h.store, "INSERT INTO blocks (account_id, target_account_id) VALUES (?, ?)", r, w.alice.id);
      const { accept } = await rFollowsAlice(w, G1);
      await suspend(w, r);
      expect(await drain(w.h.store)).toEqual([]);
      expect(await holds(w.h.store)).toHaveLength(1);
      if (blocker === "alice") {
        expect((await w.h.request(`/api/v1/accounts/${r}/block`, bearer(w.alice.token, json({})))).status).toBe(200);
        expect(await holds(w.h.store)).toEqual([]);
      }
      await lift(w, r);
      const replayed = await replays(w.h.store, LATER);
      const sent = (await drain(w.h.store, LATER)).filter((s) => s.type === "Accept").map((s) => s.id);
      expect([replayed.delivers, sent], blocker).toEqual(blocker === "r" ? [true, [accept]] : [false, []]);
    }
  });
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

describe("bounds (RES-4, RES-6, RES-7)", () => {
  // Holds of alice's pending follows with the ids `from`…`to`, all due at NOW, of accounts the instance suspended but
  // for follow 10's; the follow ids are integers whose TEXT order differs from their order (2 < 10, '10' < '2').
  const holdsFrom = async (store: StoreStub, alice: string, from: number, to: number) => {
    await sql(
      store,
      `WITH RECURSIVE k(i) AS (SELECT ?1 UNION ALL SELECT i + 1 FROM k WHERE i < ?2)
				INSERT INTO accounts (id, uri, username, domain, inbox_url, shared_inbox_url, suspended_at, suspension_source)
				SELECT printf('4%017d', i), 'https://b' || i || '.example/u', 'b', 'b' || i || '.example',
					'https://b' || i || '.example/u/inbox', 'https://b' || i || '.example/inbox',
					CASE WHEN i = 10 THEN NULL ELSE '2026-01-01T00:00:00.000Z' END,
					CASE WHEN i = 10 THEN NULL ELSE 'account' END FROM k`,
      from,
      to,
    );
    await sql(
      store,
      `WITH RECURSIVE k(i) AS (SELECT ?1 UNION ALL SELECT i + 1 FROM k WHERE i < ?2)
				INSERT INTO follows (id, account_id, target_account_id, state, uri)
				SELECT i, ?3, printf('4%017d', i), 'pending', 'https://kopje.test/ap/users/alice#follows/' || i FROM k`,
      from,
      to,
      alice,
    );
    await sql(
      store,
      `WITH RECURSIVE k(i) AS (SELECT ?1 UNION ALL SELECT i + 1 FROM k WHERE i < ?2)
				INSERT INTO handshake_replays (follow_id, check_at) SELECT i, ?3 FROM k`,
      from,
      to,
      NOW,
    );
  };

  it("takes holds in integer follow id order through the partial index under stale statistics, 20 steps a round (B1)", async () => {
    const w = await world();
    const store = w.h.store;
    expect(await sql(store, "SELECT 1 FROM follows")).toEqual([]);
    await holdsFrom(store, w.alice.id, 1, 3);
    const { after } = await staleStatistics(w.h, {
      grow: () => holdsFrom(store, w.alice.id, 4, 1001),
      capture: async (phase) => {
        if (phase === "before") {
          return [];
        }
        const plans = [];
        for (let i = 0; i < 2; i++) {
          plans.push((await plannedRun(w.h, /./, handshakeReplayStep, { now: NOW }, true)).plans);
        }
        return plans;
      },
    });
    // Each of the two steps: the two seeks (failing, then fresh), each one index entry, and key lookups; no scan of
    // the holds but the fresh index's ordered read, none of the follows or accounts, and no sort.
    for (const step of after) {
      const seeks = step.filter((s) => s.query.includes("INDEXED BY handshake_replays_"));
      expect(seeks).toHaveLength(2);
      for (const seek of seeks) {
        expect(seek.rows, seek.query).toBeLessThanOrEqual(1);
      }
      for (const statement of step) {
        expect(statement.plan.join(" | "), statement.query).not.toMatch(/TEMP B-TREE FOR ORDER BY/);
        const scans = scansOf(statement.plan, [
          "handshake_replays",
          "follows",
          "accounts",
          "local_accounts",
          "f",
          "fa",
          "ta",
          "r",
          "l",
        ]).filter((detail) => !/USING (?:COVERING )?INDEX handshake_replays_(?:fresh|failing)\b/.test(detail));
        expect(scans, statement.query).toEqual([]);
      }
    }
    // The two steps read the same rows: none grows with the holds.
    const read = after.map((step) => step.reduce((sum, s) => sum + s.rows, 0));
    expect(read[0]).toBe(read[1]);
    // Rounds of 20 steps in integer order: follows 1 and 2 above, then 3…22, follow 10 replayed among them.
    expect(await replays(store, NOW)).toEqual({ pending: true, delivers: true });
    const moved = await sql<{ f: number }>(
      store,
      "SELECT follow_id AS f FROM handshake_replays WHERE check_at > ? ORDER BY follow_id",
      NOW,
    );
    expect(moved.map((row) => row.f)).toEqual(Array.from({ length: 22 }, (_, i) => i + 1).filter((i) => i !== 10));
    expect(await sql(store, "SELECT 1 FROM handshake_replays WHERE follow_id = 10")).toEqual([]);
    // 979 holds left after it: 48 rounds that use their 20 steps and ask for another, then one of 19 that asks for none.
    let rounds = 1;
    while ((await replays(store, NOW)).pending) {
      rounds++;
    }
    expect(rounds).toBe(49);
    expect(await sql(store, "SELECT 1 FROM handshake_replays WHERE check_at = ?", NOW)).toEqual([]);
    expect(await replays(store, NOW)).toEqual({ pending: false, delivers: false });
  }, 120_000);

  it("writes the recording's rows and two more at most a step, with the expansion backlog full (B2)", async () => {
    const w = await world();
    const { r, id, uri } = await aliceFollowsR(w);
    const s = await remoteAccount(w.h.store, "s", "other.example");
    await suspend(w, r);
    expect(await drain(w.h.store)).toEqual([]);
    await lift(w, r);
    // Every input at its worst: the hold failed before, and more targets wait unexpanded than two expansion steps take.
    // A replay deletes the hold, so its reset then matches no row: the recording and one more.
    await sql(w.h.store, "UPDATE handshake_replays SET attempts = 1, due_at = ? WHERE follow_id = ?", NOW, id);
    await backlog(w, 350);
    await post(w.h, w.alice, { status: "to many servers" });
    const unexpanded = () =>
      sql<{ n: number }>(w.h.store, "SELECT sum(json_array_length(targets) - next) AS n FROM outbound_targets");
    expect((await unexpanded())[0]!.n).toBeGreaterThan(2 * 100);
    // The follow API's recording of a Follow, in the same state.
    const aliceUri = await uriOf(w.h.store, w.alice.id);
    const recording = await writtenBy(w.h.store, (db) =>
      recordOutbound(
        db,
        w.alice.id,
        followActivity({
          followUri: `${aliceUri}#follows/other`,
          actorUri: aliceUri,
          targetUri: "https://other.example/users/s",
          targetId: s,
        }),
        NOW,
      ),
    );
    expect(recording.result).toBe(true);
    const step = await operationRows(w.h.store, handshakeReplayStep, { now: NOW });
    expect(step.result).toEqual({ done: false, delivers: true });
    expect(await holds(w.h.store)).toEqual([]);
    expect(await intents(w.h.store, "Follow")).toEqual(expect.arrayContaining([{ id: uri, pair: null }]));
    expect(step.rows).toBeLessThanOrEqual(recording.rows + 1);
    // The two rows past it: a failed hold that is deferred writes its move and its reset, and records nothing.
    await suspend(w, s);
    await sql(
      w.h.store,
      "INSERT INTO follows (account_id, target_account_id, state, uri) VALUES (?, ?, 'pending', ?)",
      w.alice.id,
      s,
      `${aliceUri}#follows/deferred`,
    );
    await sql(
      w.h.store,
      `INSERT INTO handshake_replays (follow_id, check_at, attempts, due_at)
			SELECT id, ?1, 1, ?1 FROM follows WHERE target_account_id = ?2`,
      NOW,
      s,
    );
    const deferred = await operationRows(w.h.store, handshakeReplayStep, { now: NOW });
    expect(deferred).toEqual({ result: { done: false, delivers: false }, rows: 2 });
  }, 60_000);

  it("writes CLAIM_LIMIT holds at most in a claim (B3)", async () => {
    const w = await world();
    for (let i = 0; i < CLAIM_LIMIT + 4; i++) {
      const target = await remoteAccount(w.h.store, "c", `c${i}.example`);
      await follow(w.h, w.alice, target);
      await suspend(w, target);
    }
    // The hold's statement under statistics older than the follows and accounts: key lookups only.
    await sql(w.h.store, "ANALYZE");
    await backlog(w, 2_000);
    const { plans } = await plannedRun(w.h, /INSERT INTO handshake_replays/, claimDeliveries, {
      now: NOW,
      leaseToken: "plan",
      limit: 1,
    });
    expect(plans).toHaveLength(1);
    expect(
      scansOf(plans[0]!.plan, ["o", "t", "f", "outbound_activities", "accounts", "follows"]),
      plans[0]!.plan.join(" | "),
    ).toEqual([]);
    // The intent by key in each branch, the target account by its uri and the follow by its pair (each an index entry
    // and its row): 6, whatever the Store holds.
    expect(plans[0]!.rows).toBeLessThanOrEqual(6);
    expect(await holds(w.h.store)).toHaveLength(1);
    // A full claim of refused Follows: CLAIM_LIMIT more holds, though more rows are due.
    const { rows } = await operationRows(w.h.store, claimDeliveries, { now: NOW, leaseToken: "b3" });
    expect(await holds(w.h.store)).toHaveLength(1 + CLAIM_LIMIT);
    // Each refused row: its hold, its delete and its intent's (one target, one chunk already expanded).
    expect(rows).toBeLessThanOrEqual(3 * CLAIM_LIMIT);
  });
});

// B4: every path that deletes a follow or changes its uri or state also deletes its hold (the cascade, the trigger),
// one row a follow. The row-budgeted ones reserve it (SEVER_ROWS, PURGED_FOLLOW_ROWS: their own bounds tests seed a
// hold on every follow); these are the bulk paths without a row budget, each with a hold on every follow it ends, its
// rows measured against the ceiling derived from what it writes per follow.
describe("the cascaded hold in bulk paths without a row budget (B4)", () => {
  // `n` remote accounts on `domain` (ids from `base`), each with its personal and shared inbox.
  const remotes = (store: StoreStub, n: number, domain: string, base: string) =>
    sql(
      store,
      `WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < ?1)
			INSERT INTO accounts (id, uri, username, domain, inbox_url, shared_inbox_url)
			SELECT printf('%s%016d', ?3, i), 'https://' || ?2 || '/users/u' || i, 'u' || i, ?2,
				'https://' || ?2 || '/users/u' || i || '/inbox', 'https://' || ?2 || '/inbox' FROM k`,
      n,
      domain,
      base,
    );

  it("an inbound Block ends both follows of the pair, and both holds go with them", async () => {
    const w = await world();
    const { r, aliceUri } = await rFollowsAlice(w, G1);
    await follow(w.h, w.alice, r);
    await sql(w.h.store, "UPDATE follows SET state = 'accepted'");
    await sql(w.h.store, "INSERT INTO handshake_replays (follow_id, check_at) SELECT id, ? FROM follows", LATER);
    expect(await holds(w.h.store)).toHaveLength(2);
    expect(
      await receive(w.h.store, await uriOf(w.h.store, r), {
        id: "https://remote.example/blocks/1",
        type: "Block",
        object: aliceUri,
      }),
    ).toMatchObject({ applied: true });
    // Each follow's delete cascades to its hold: two rows besides the request's, a constant.
    expect(await sql(w.h.store, "SELECT 1 FROM follows")).toEqual([]);
    expect(await holds(w.h.store)).toEqual([]);
  });

  it("a user's domain block cleanup stays within its derived ceiling with every follow of its call held", async () => {
    const w = await world();
    const store = w.h.store;
    // Every input of a call at its worst: DOMAIN_BLOCK_BATCHES_PER_RUN windows of DOMAIN_BLOCK_WINDOW follows, each
    // one the user's and of the domain (each ended), each a remote follower's accepted follow (the costlier side:
    // its Reject, its retraction, its notification and both counts) holding its Accept, with a pin trigger's row
    // counted too. Not at a cap here, and unbounded in a batch as before: the earlier activities about a follow its
    // Reject supersedes, a local follower's list rows and another activity's expansion backlog (none).
    const n = DOMAIN_BLOCK_WINDOW * DOMAIN_BLOCK_BATCHES_PER_RUN;
    await remotes(store, n, "d.example", "40");
    await sql(
      store,
      `INSERT INTO follows (account_id, target_account_id, state, uri)
				SELECT id, ?, 'accepted', uri || '#follow' FROM accounts WHERE domain = 'd.example'`,
      w.alice.id,
    );
    await sql(
      store,
      `INSERT INTO notifications (account_id, type, from_account_id, created_at)
				SELECT ?, 'follow', id, '' FROM accounts WHERE domain = 'd.example'`,
      w.alice.id,
    );
    await sql(store, "INSERT INTO handshake_replays (follow_id, check_at) SELECT id, ? FROM follows", LATER);
    const [block] = await sql<{ id: string }>(
      store,
      "INSERT INTO domain_blocks (account_id, domain, created_at) VALUES (?, 'd.example', '') RETURNING CAST(id AS TEXT) AS id",
      w.alice.id,
    );
    await sql(
      store,
      `INSERT INTO domain_block_cleanups (domain_block_id, bound, cursor, created_at)
				SELECT CAST(? AS INTEGER), max(id), 0, 0 FROM follows`,
      block!.id,
    );
    const { rows } = await operationRows(store, runDomainBlockCleanups, { now: NOW });
    // The guarded branch: the call ended every follow, and every hold went with its follow.
    expect(await sql(store, "SELECT 1 FROM follows")).toEqual([]);
    expect(await holds(store)).toEqual([]);
    // A follow: its delete, its hold, its two notifications, the two counts, the retraction, the Reject's intent and
    // chunk, its delivery and its chunk's cursor update and delete, a pin: 13. A batch: its cleanup row, and its retry
    // state's.
    const ceiling = DOMAIN_BLOCK_BATCHES_PER_RUN * (DOMAIN_BLOCK_WINDOW * 13 + 2);
    console.info({ event: "b4.domain-cleanup", rows, ceiling });
    expect(rows).toBeLessThanOrEqual(ceiling);
    expect(rows).toBeGreaterThan(n * 2);
  }, 120_000);

  it("a Move batch stays within its derived ceiling with every moved follow held", async () => {
    const w = await world();
    const store = w.h.store;
    // MOVE_BATCH local followers of the source, each its accepted follow holding its Follow (imported), the target
    // remote (so each follower gets a new Follow), no lists.
    await remotes(store, 1, "m.example", "50");
    await remotes(store, 1, "n.example", "51");
    const source = "500000000000000001";
    const target = "510000000000000001";
    await sql(
      store,
      `WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < ?1)
			INSERT INTO accounts (id, uri, username, domain) SELECT printf('6%017d', i),
				'https://kopje.test/ap/users/m' || i, 'm' || i, NULL FROM k`,
      MOVE_BATCH,
    );
    await sql(
      store,
      `INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey)
			SELECT id, username || '@example.com', X'00', X'00', 'k' FROM accounts WHERE id GLOB '6*'`,
    );
    await sql(
      store,
      `INSERT INTO follows (account_id, target_account_id, state, uri)
			SELECT id, ?, 'accepted', uri || '#follows/old' FROM accounts WHERE id GLOB '6*'`,
      source,
    );
    await sql(store, "INSERT INTO handshake_replays (follow_id, check_at) SELECT id, ? FROM follows", LATER);
    await sql(
      store,
      `INSERT INTO inbound_jobs (kind, key, actor_uri, target_account_id, bound, cursor, created_at)
			SELECT 'move', 'https://m.example/moves/1', 'https://m.example/users/u1', ?, max(id), '0', ? FROM follows`,
      target,
      NOW,
    );
    const { rows } = await operationRows(store, runInboundJobs, { now: NOW });
    // The guarded branch: every follower moved, and every hold went with its old follow.
    expect(await sql(store, "SELECT 1 FROM follows WHERE target_account_id = ?", source)).toEqual([]);
    expect(await sql(store, "SELECT 1 FROM follows WHERE target_account_id = ?", target)).toHaveLength(MOVE_BATCH);
    expect(await holds(store)).toEqual([]);
    // A follower: the old follow's delete, its hold, its two notifications, its pin, the Undo's intent, chunk,
    // delivery and its chunk's cursor update and delete; the new follow, its uri, the Follow's intent, chunk, delivery
    // and its chunk's two rows: 17. The batch: each changed account's recount (the followers and the target), and the
    // job's cursor and end.
    const ceiling = MOVE_BATCH * 17 + (MOVE_BATCH + 1) + 2;
    console.info({ event: "b4.move", rows, ceiling });
    expect(rows).toBeLessThanOrEqual(ceiling);
    expect(rows).toBeGreaterThan(MOVE_BATCH * 2);
  }, 60_000);
});
