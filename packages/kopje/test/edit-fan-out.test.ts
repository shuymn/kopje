import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Db } from "../src/db/sql";
import { QUOTE_BACKOFF_MS } from "../src/domain/quotes";
import { totalChanges } from "../src/domain/row-budget";
import { notifyEdited } from "../src/domain/update-fan-out";
import { verifyQuotes } from "../src/federation/quotes";
import { sql } from "./api-helpers";
import { inboxDeps, NOW } from "./app-helpers";
import { LEGACY_EMPTY_KEK, seedLocalAccount } from "./federation-helpers";
import { BUILD } from "./helpers";
import { LOCAL, mastodonActor, type TestActor } from "./inbox-helpers";
import {
  ALICE,
  ALICE_URI,
  AS,
  create,
  DAVE,
  DAVE_URI,
  followed,
  localStatus,
  mastodonNote,
  nextId,
  type Note,
  OTHER,
  PUBLIC,
  remove,
  type Setup,
  setup,
  statusRow,
  token,
  update,
} from "./inbox-status-helpers";
import { quoteAccept, quoteReject, quoteRequest, quoting, serveStamp } from "./quote-helpers";
import { observedSql, remoteAccounts, staleStatistics, watchedCursor } from "./read-helpers";

// Mastodon's update fan-out (notifyEdited in src/domain/update-fan-out.ts; docs/visibility.md R15, docs/threat-model.md
// VIS-10 and RES-4): wherever Mastodon broadcasts an update, the local quoted account of an accepted quote and every
// active local mention without a kept notification are notified, then the local boosters and quoters. A remote edit
// broadcasts only when it is significant (ProcessStatusUpdateService#handle_explicit_update!).

const FOLLOWERS = (actor: TestActor) => `${actor.uri}/followers`;
const mention = (href: string) => ({ type: "Mention", href, name: "@x" });

async function setPolicy(t: Setup, as: "alice" | "dave", policy: Record<string, string>) {
  const response = await t.request("/api/v2/notifications/policy", {
    method: "PUT",
    headers: { authorization: `Bearer ${t.tokens[as]}`, "content-type": "application/json" },
    body: JSON.stringify(policy),
  });
  expect(response.status).toBe(200);
}

// A push subscription of each token of `accountId` wanting `types`.
async function subscribe(t: Setup, accountId: string, types: string[]) {
  await sql(
    t.store,
    `INSERT INTO push_subscriptions (token_hash, endpoint, key_p256dh, key_auth, alerts, policy)
		SELECT token_hash, 'https://push.example/' || ?2, 'p', 'a', ?3, 'all' FROM oauth_tokens WHERE account_id = ?1`,
    accountId,
    nextId(),
    JSON.stringify(Object.fromEntries(types.map((type) => [type, true]))),
  );
}

// A clear of `accountId`'s notifications as its request leaves it before its batches run: recorded, so R15 hides them,
// and the rows still there, their pushes queued.
const cleared = (t: Setup, accountId: string) =>
  sql(
    t.store,
    "INSERT INTO notification_clears (account_id, max_id) SELECT ?1, max(id) FROM notifications WHERE account_id = ?1",
    accountId,
  );

const rowsOf = (t: Setup, type: string) =>
  sql<{ id: string; account_id: string; filtered: number }>(
    t.store,
    "SELECT CAST(id AS TEXT) AS id, account_id, filtered FROM notifications WHERE type = ? ORDER BY id",
    type,
  );

const pushed = async (t: Setup) =>
  (
    await sql<{ id: string }>(
      t.store,
      "SELECT CAST(notification_id AS TEXT) AS id FROM push_deliveries ORDER BY notification_id",
    )
  ).map((row) => row.id);

let minute = 0;
// bob's newer version of `note`: its text changed (significant) unless `extra` sets it.
function edited(bob: TestActor, note: Note, extra: Record<string, unknown> = {}) {
  minute++;
  return update(
    bob,
    { ...note, content: `<p>@alice edited ${minute}</p>`, ...extra },
    `2026-10-11T${String(13 + Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00Z`,
  );
}

describe("a remote edit's update fan-out", () => {
  // bob tags alice and addresses her in cc (unless not `addressed`); dave follows bob, which relates his statuses to
  // this instance. alice does not follow bob and holds a push subscription for mentions.
  async function world(addressed = true) {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const bobId = await followed(t, bob, DAVE);
    await subscribe(t, ALICE, ["mention"]);
    const note = mastodonNote(bob, {
      content: '<p><a href="https://kopje.test/@alice" class="u-url mention">@alice</a> hi</p>',
      cc: addressed ? [FOLLOWERS(bob), ALICE_URI] : [FOLLOWERS(bob)],
      tag: [mention(ALICE_URI)],
    });
    return { t, bob, bobId, note };
  }

  const activeMention = async (t: Setup, uri: string, accountId: string) =>
    sql(
      t.store,
      `SELECT m.silent FROM status_mentions m JOIN statuses s ON s.id = m.status_id
			WHERE s.uri = ? AND m.account_id = ?`,
      uri,
      accountId,
    );

  it("a significant edit notifies a mention the policy dropped", async () => {
    const { t, bob, note } = await world();
    await setPolicy(t, "alice", { for_not_following: "drop" });
    expect(await t.post(bob, create(bob, note))).toBe(202);
    expect(await activeMention(t, note.id, ALICE)).toEqual([{ silent: 0 }]);
    expect(await rowsOf(t, "mention")).toEqual([]);
    await setPolicy(t, "alice", { for_not_following: "accept" });
    expect(await t.post(bob, edited(bob, note))).toBe(202);
    expect(await rowsOf(t, "mention")).toMatchObject([{ account_id: ALICE, filtered: 0 }]);
  });

  it("…and a mention alice cleared, written again with a new id and pushed", async () => {
    const { t, bob, note } = await world();
    await t.post(bob, create(bob, note));
    const [first] = await rowsOf(t, "mention");
    expect(await pushed(t)).toEqual([first!.id]);
    await cleared(t, ALICE);
    expect(await t.post(bob, edited(bob, note))).toBe(202);
    const again = await rowsOf(t, "mention");
    expect(again).toHaveLength(1);
    expect(again[0]!.id).not.toBe(first!.id);
    // The hidden row went with its push (cascade); the new one is pushed.
    expect(await pushed(t)).toEqual([again[0]!.id]);
  });

  it("…but not one alice holds: the same row, no new push", async () => {
    const { t, bob, note } = await world();
    await t.post(bob, create(bob, note));
    const kept = await rowsOf(t, "mention");
    expect(await t.post(bob, edited(bob, note))).toBe(202);
    expect(await sql(t.store, "SELECT count(*) AS n FROM status_edits")).not.toEqual([{ n: 0 }]);
    expect(await rowsOf(t, "mention")).toEqual(kept);
    expect(await pushed(t)).toEqual([kept[0]!.id]);
  });

  it("…and a limited mention dropped at the Create, judged without the limited condition", async () => {
    // alice is tagged and left out of to and cc: limited at the Create, dropped by her choice.
    const { t, bob, note } = await world(false);
    await setPolicy(t, "alice", { for_limited_accounts: "drop" });
    await t.post(bob, create(bob, note));
    expect(await activeMention(t, note.id, ALICE)).toEqual([{ silent: 0 }]);
    expect(await rowsOf(t, "mention")).toEqual([]);
    expect(await t.post(bob, edited(bob, note))).toBe(202);
    expect(await rowsOf(t, "mention")).toMatchObject([{ account_id: ALICE, filtered: 0 }]);
  });

  it("an edit that is not significant notifies no mention, not even one it newly tags", async () => {
    const { t, bob, note } = await world();
    await t.post(bob, create(bob, note));
    await sql(t.store, "DELETE FROM notifications");
    // The same text, now sensitive, newly tagging and addressing dave.
    const tagsDave = edited(bob, note, {
      content: note.content,
      sensitive: true,
      cc: [FOLLOWERS(bob), ALICE_URI, DAVE_URI],
      tag: [mention(ALICE_URI), mention(DAVE_URI)],
    });
    expect(await t.post(bob, tagsDave)).toBe(202);
    expect(await statusRow(t.store, note.id)).toMatchObject({ sensitive: 1, edited_at: null });
    expect(await activeMention(t, note.id, DAVE)).toEqual([{ silent: 0 }]);
    expect(await rowsOf(t, "mention")).toEqual([]);
  });
});

describe("an accepted quote's notification on an edit (notify_quoted_account!)", () => {
  // bob's status quoting alice's, delivered (dave follows bob); accepted through its QuoteRequest unless `pending`.
  async function world(pending = false) {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await followed(t, bob, DAVE);
    await subscribe(t, ALICE, ["quote"]);
    const mine = await localStatus(t, { status: "quote me", visibility: "public" });
    const note = quoting(bob, mine.uri, null);
    t.web.serve(note.id, { "@context": AS, ...note });
    expect(await t.post(bob, create(bob, note))).toBe(202);
    if (!pending) {
      expect(await t.post(bob, quoteRequest(bob, mine.uri, note.id))).toBe(202);
    }
    const state = await sql(
      t.store,
      "SELECT state FROM quotes q JOIN statuses s ON s.id = q.status_id WHERE s.uri = ?",
      note.id,
    );
    expect(state).toEqual([{ state: pending ? "pending" : "accepted" }]);
    return { t, bob, note };
  }

  it("writes again a quote notification alice dismissed, and pushes it", async () => {
    const { t, bob, note } = await world();
    const [first] = await rowsOf(t, "quote");
    const dismissed = await t.request(`/api/v1/notifications/${first!.id}/dismiss`, {
      method: "POST",
      headers: { authorization: `Bearer ${t.tokens.alice}` },
    });
    expect(dismissed.status).toBe(200);
    expect(await rowsOf(t, "quote")).toEqual([]);
    expect(await t.post(bob, edited(bob, note))).toBe(202);
    const again = await rowsOf(t, "quote");
    expect(again).toMatchObject([{ account_id: ALICE }]);
    expect(await pushed(t)).toEqual([again[0]!.id]);
  });

  it("…but not a kept one: the same row, no new push", async () => {
    const { t, bob, note } = await world();
    const kept = await rowsOf(t, "quote");
    expect(await pushed(t)).toEqual([kept[0]!.id]);
    expect(await t.post(bob, edited(bob, note))).toBe(202);
    expect(await rowsOf(t, "quote")).toEqual(kept);
    expect(await pushed(t)).toEqual([kept[0]!.id]);
  });

  it("…and none for a pending quote", async () => {
    const { t, bob, note } = await world(true);
    expect(await t.post(bob, edited(bob, note))).toBe(202);
    expect(await sql(t.store, "SELECT count(*) AS n FROM status_edits")).not.toEqual([{ n: 0 }]);
    expect(await rowsOf(t, "quote")).toEqual([]);
  });
});

describe("a quote's decision and an implicit Update's update fan-out", () => {
  // bob's status quotes carol's (on another server) with `first` (a stamp, unless !stamped, answering `answer` when
  // given), tags alice and addresses her; dave follows bob and boosts it. alice's mention notification is dismissed,
  // her pushes subscribed. The Create's work is decided first unless `undecided`. Updates follow: `implicit` the same
  // version (handle_implicit_update!), `newer` a later one (handle_explicit_update!).
  async function world(
    stamped: boolean,
    extra: Record<string, unknown> = {},
    { answer, undecided = false }: { answer?: number; undecided?: boolean } = {},
  ) {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await followed(t, bob, DAVE);
    const carol = await mastodonActor(t.web, "carol", { origin: OTHER, key: 2 });
    await subscribe(t, ALICE, ["mention"]);
    const target = mastodonNote(carol);
    t.web.serve(target.id, { "@context": AS, ...target });
    const stamp = () => `${carol.uri}/quote_authorizations/${nextId()}`;
    const first = stamped ? stamp() : null;
    const note = quoting(bob, target.id, first, {
      cc: [FOLLOWERS(bob), ALICE_URI],
      tag: [mention(ALICE_URI)],
      ...extra,
    });
    // A stamp of carol's naming `quoting` (bob's status unless given) and her status.
    const serve = (uri: string, quoting = note.id) => serveStamp(t.web, uri, carol, quoting, target.id);
    if (first !== null) {
      serve(first);
      if (answer !== undefined) {
        t.web.fail(first, answer);
      }
    }
    expect(await t.post(bob, create(bob, note))).toBe(202);
    if (stamped && !undecided) {
      await decide(t);
    }
    const statusId = (await statusRow(t.store, note.id))!.id;
    expect(await quoteState(t, statusId)).toBe(
      !stamped || undecided ? "pending" : answer === undefined ? "accepted" : answer === 404 ? "rejected" : "pending",
    );
    const boosted = await t.request(`/api/v1/statuses/${statusId}/reblog`, {
      method: "POST",
      headers: { authorization: `Bearer ${t.tokens.dave}` },
    });
    expect(boosted.status).toBe(200);
    const [mentioned] = await rowsOf(t, "mention");
    const dismissed = await t.request(`/api/v1/notifications/${mentioned!.id}/dismiss`, {
      method: "POST",
      headers: { authorization: `Bearer ${t.tokens.alice}` },
    });
    expect(dismissed.status).toBe(200);
    expect(await pushed(t)).toEqual([]);
    const implicit = (extra: Record<string, unknown>) => update(bob, { ...note, ...extra }, note.published as string);
    const newer = (extra: Record<string, unknown>, at = "2026-10-11T12:30:00Z") =>
      update(bob, { ...note, ...extra }, at);
    return { t, bob, carol, statusId, note, first, stamp, serve, implicit, newer };
  }

  // The job rounds at `now`, until no quote's work is due.
  async function decide(t: Setup, now = NOW) {
    const deps = { ...inboxDeps(() => t.store, t.web.loader), now: () => now };
    for (let round = 0; await verifyQuotes(t.env, deps); round++) {
      expect(round).toBeLessThan(20);
    }
  }

  const quoteState = async (t: Setup, statusId: string) =>
    (await sql<{ state: string }>(t.store, "SELECT state FROM quotes WHERE status_id = ?", statusId))[0]?.state;

  // The update fan-outs that reached dave, the booster, so far: each replaces his update notification with a new row
  // (LocalNotificationWorker), so every one is a row id not seen before. Read after each step, as the next replaces it.
  function broadcasts(t: Setup) {
    const seen = new Set<string>();
    return async () => {
      for (const row of await rowsOf(t, "update")) {
        seen.add(row.id);
      }
      return seen.size;
    };
  }

  const SIGNIFICANT = { content: "<p>edited</p>" };

  it("an approval Update notifies when the round accepts the quote, not before", async () => {
    const { t, bob, statusId, stamp, serve, implicit } = await world(false);
    const approval = stamp();
    serve(approval);
    expect(await t.post(bob, implicit({ quoteAuthorization: approval }))).toBe(202);
    expect(await quoteState(t, statusId)).toBe("pending");
    expect(await rowsOf(t, "mention")).toEqual([]);
    expect(await rowsOf(t, "update")).toEqual([]);
    await decide(t);
    expect(await quoteState(t, statusId)).toBe("accepted");
    const again = await rowsOf(t, "mention");
    expect(again).toMatchObject([{ account_id: ALICE }]);
    expect(await pushed(t)).toEqual([again[0]!.id]);
    expect(await rowsOf(t, "update")).toMatchObject([{ account_id: DAVE }]);
  });

  it("…when the stamp is gone, the rejection notifies", async () => {
    const { t, bob, statusId, stamp, implicit } = await world(false);
    const approval = stamp();
    t.web.fail(approval, 404);
    expect(await t.post(bob, implicit({ quoteAuthorization: approval }))).toBe(202);
    await decide(t);
    expect(await quoteState(t, statusId)).toBe("rejected");
    expect(await rowsOf(t, "mention")).toMatchObject([{ account_id: ALICE }]);
    expect(await rowsOf(t, "update")).toMatchObject([{ account_id: DAVE }]);
  });

  it("…a stamp that does not name the quote leaves it pending and notifies no one", async () => {
    const { t, bob, note, statusId, stamp, serve, implicit } = await world(false);
    const approval = stamp();
    serve(approval, `${note.id}/other`);
    t.web.fetched.length = 0;
    expect(await t.post(bob, implicit({ quoteAuthorization: approval }))).toBe(202);
    await decide(t);
    expect(t.web.fetched).toContain(approval);
    expect(await sql(t.store, "SELECT state, verify_after FROM quotes WHERE status_id = ?", statusId)).toEqual([
      { state: "pending", verify_after: null },
    ]);
    expect(await rowsOf(t, "mention")).toEqual([]);
    expect(await rowsOf(t, "update")).toEqual([]);
  });

  it("a new stamp on an accepted quote notifies at the Update; its acceptance by the round notifies no more", async () => {
    const { t, bob, statusId, stamp, serve, implicit } = await world(true);
    const approval = stamp();
    serve(approval);
    expect(await t.post(bob, implicit({ quoteAuthorization: approval }))).toBe(202);
    expect(await quoteState(t, statusId)).toBe("pending");
    const again = await rowsOf(t, "mention");
    expect(again).toMatchObject([{ account_id: ALICE }]);
    const update = await rowsOf(t, "update");
    expect(update).toMatchObject([{ account_id: DAVE }]);
    expect(await pushed(t)).toEqual([again[0]!.id]);
    await decide(t);
    expect(await quoteState(t, statusId)).toBe("accepted");
    expect(await rowsOf(t, "mention")).toEqual(again);
    expect(await rowsOf(t, "update")).toEqual(update);
    expect(await pushed(t)).toEqual([again[0]!.id]);
  });

  it("a same-version Update with the same stamp verifies an accepted quote again: gone, it is revoked and notified", async () => {
    const { t, bob, statusId, first, implicit } = await world(true);
    t.web.fail(first!, 404);
    expect(await t.post(bob, implicit({}))).toBe(202);
    expect(await quoteState(t, statusId)).toBe("accepted");
    expect(await rowsOf(t, "update")).toEqual([]);
    await decide(t);
    expect(await quoteState(t, statusId)).toBe("revoked");
    const again = await rowsOf(t, "mention");
    expect(again).toMatchObject([{ account_id: ALICE }]);
    expect(await pushed(t)).toEqual([again[0]!.id]);
    expect(await rowsOf(t, "update")).toMatchObject([{ account_id: DAVE }]);
  });

  it("…valid, it stays accepted and notifies no one, whatever the Updates keep or change of the policy", async () => {
    const { t, bob, statusId, first, implicit } = await world(true);
    t.web.fetched.length = 0;
    expect(await t.post(bob, implicit({}))).toBe(202);
    const policy = { interactionPolicy: { canQuote: { automaticApproval: [PUBLIC] } } };
    expect(await t.post(bob, implicit(policy))).toBe(202);
    expect(await sql(t.store, "SELECT quote_policy FROM statuses WHERE id = ?", statusId)).not.toEqual([
      { quote_policy: 0 },
    ]);
    await decide(t);
    expect(t.web.fetched.filter((url) => url === first)).toHaveLength(1);
    expect(await quoteState(t, statusId)).toBe("accepted");
    expect(await rowsOf(t, "mention")).toEqual([]);
    expect(await rowsOf(t, "update")).toEqual([]);
  });

  it("a newer Update of an idle quote verifies it again too, and its revocation notifies only through an edit", async () => {
    const { t, bob, statusId, first, newer } = await world(true);
    t.web.fail(first!, 404);
    // Not significant: no edit, so no broadcast (handle_explicit_update!, :64-67 in v4.7.5).
    expect(await t.post(bob, newer({}))).toBe(202);
    await decide(t);
    expect(await quoteState(t, statusId)).toBe("revoked");
    expect(await rowsOf(t, "mention")).toEqual([]);
    expect(await rowsOf(t, "update")).toEqual([]);
  });

  it("a retried verification notifies when it moves the state", async () => {
    const { t, statusId, first, serve } = await world(true, {}, { answer: 503 });
    serve(first!);
    await decide(t, NOW + QUOTE_BACKOFF_MS[0]!);
    expect(await quoteState(t, statusId)).toBe("accepted");
    expect(await rowsOf(t, "mention")).toMatchObject([{ account_id: ALICE }]);
    expect(await rowsOf(t, "update")).toMatchObject([{ account_id: DAVE }]);
  });

  it("a first decision of a Create's work notifies no one", async () => {
    const { t, statusId } = await world(true, {}, { undecided: true });
    await decide(t);
    expect(await quoteState(t, statusId)).toBe("accepted");
    expect(await rowsOf(t, "mention")).toEqual([]);
    expect(await rowsOf(t, "update")).toEqual([]);
  });

  it("a failing fan-out leaves the decision committed, and logs it", async () => {
    const { t, bob, statusId, first, implicit } = await world(true);
    t.web.fail(first!, 404);
    expect(await t.post(bob, implicit({}))).toBe(202);
    await sql(
      t.store,
      `CREATE TRIGGER test_fail_update BEFORE INSERT ON notifications WHEN NEW.type = 'update'
			BEGIN SELECT RAISE(ABORT, 'notify'); END`,
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await decide(t);
    expect(await quoteState(t, statusId)).toBe("revoked");
    expect(errors).toHaveBeenCalledWith(expect.objectContaining({ event: "kopje.quote.fan_out.failed" }));
    expect(await rowsOf(t, "mention")).toEqual([]);
    expect(await pushed(t)).toEqual([]);
  });

  it("a decision writes at most one update fan-out's bound beside its own rows (RES-4)", async () => {
    const { t, bob, statusId, first, implicit } = await world(true);
    t.web.fail(first!, 404);
    expect(await t.post(bob, implicit({}))).toBe(202);
    const work = (await t.store.quoteWork(BUILD, { statusId, now: NOW }))!;
    expect(work).toMatchObject({ stage: "stamp", fetch: first });
    const total = async () => (await sql<{ n: number }>(t.store, "SELECT total_changes() AS n"))[0]!.n;
    const before = await total();
    await t.store.completeQuote(BUILD, {
      statusId,
      now: NOW,
      origin: LOCAL,
      quotedUri: work.quotedUri,
      approvalUri: work.approvalUri,
      generation: work.generation,
      stage: work.stage,
      fetch: work.fetch,
      signer: work.signer,
      stamp: { kind: "gone" },
    });
    const changes = (await total()) - before;
    expect(await quoteState(t, statusId)).toBe("revoked");
    // The fan-out ran: alice's mention written again and pushed, dave's update.
    expect(await rowsOf(t, "mention")).toMatchObject([{ account_id: ALICE }]);
    expect(await rowsOf(t, "update")).toMatchObject([{ account_id: DAVE }]);
    // The decision's own rows: the quote and its target's count (quotes_count_changed). One notifyEdited: at most
    // 1 + 2·L + MAX_QUOTED_UPDATES notify calls of at most 7 + 2·P_r rows each (RES-4), here L = 2 local accounts, no
    // local quoter and P_r = 1.
    const [own, L, P] = [2, 2, 1];
    expect(changes).toBeLessThanOrEqual(own + (1 + 2 * L) * (7 + 2 * P));
    // Exactly: those two, alice's mention and its push, dave's update (one fan-out).
    expect(changes).toBe(own + 2 + 1);
  });

  // A Delete of the stamp relayed by another server without carol's proof: the quote is checked again (recheckStamp).
  const RELAY = "https://relay.example";
  const relayed = (carol: TestActor, stamp: string) => ({
    "@context": [AS, "https://w3id.org/security/v1"],
    id: `${carol.uri}#delete-${nextId()}`,
    type: "Delete",
    actor: carol.uri,
    to: [PUBLIC],
    object: stamp,
  });

  it("a relayed Delete's recheck that finds the stamp gone revokes and notifies, from an idle work", async () => {
    const { t, carol, statusId, first } = await world(true);
    const dan = await mastodonActor(t.web, "dan", { origin: RELAY, key: 6 });
    t.web.fail(first!, 404);
    expect(await t.post(dan, relayed(carol, first!))).toBe(202);
    expect(await quoteState(t, statusId)).toBe("accepted");
    await decide(t);
    expect(await quoteState(t, statusId)).toBe("revoked");
    expect(await rowsOf(t, "mention")).toMatchObject([{ account_id: ALICE }]);
    expect(await rowsOf(t, "update")).toMatchObject([{ account_id: DAVE }]);
  });

  it("…and from a Create's work whose stamp fetch it raced: the second look revokes and notifies once", async () => {
    const { t, carol, statusId, first } = await world(true, {}, { undecided: true });
    const dan = await mastodonActor(t.web, "dan", { origin: RELAY, key: 6 });
    // The round's stamp fetch, answered as served when it arrived (valid); the stamp is gone meanwhile.
    const gate = t.web.hold(first!, { snapshot: true });
    const round = decide(t);
    await gate.reached;
    t.web.fail(first!, 404);
    expect(await t.post(dan, relayed(carol, first!))).toBe(202);
    expect(await sql(t.store, "SELECT recheck FROM quotes WHERE status_id = ?", statusId)).toEqual([{ recheck: 1 }]);
    gate.release();
    await round;
    expect(await quoteState(t, statusId)).toBe("revoked");
    expect(await rowsOf(t, "mention")).toMatchObject([{ account_id: ALICE }]);
    expect(await rowsOf(t, "update")).toMatchObject([{ account_id: DAVE }]);
  });

  it("a rejected or revoked quote is not verified again by an Update with the same stamp", async () => {
    const policy = { interactionPolicy: { canQuote: { automaticApproval: [PUBLIC] } } };
    const due = (t: Setup, statusId: string) =>
      sql(t.store, "SELECT state, verify_after FROM quotes WHERE status_id = ?", statusId);
    // Rejected: the Create's stamp answered 404.
    const rejected = await world(true, {}, { answer: 404 });
    expect(await due(rejected.t, rejected.statusId)).toEqual([{ state: "rejected", verify_after: null }]);
    expect(await rejected.t.post(rejected.bob, rejected.implicit(policy))).toBe(202);
    expect(
      await sql(rejected.t.store, "SELECT quote_policy FROM statuses WHERE id = ?", rejected.statusId),
    ).not.toEqual([{ quote_policy: 0 }]);
    expect(await due(rejected.t, rejected.statusId)).toEqual([{ state: "rejected", verify_after: null }]);
    // Revoked: carol's own Delete of the stamp.
    const revoked = await world(true);
    expect(await revoked.t.post(revoked.carol, remove(revoked.carol, revoked.first!))).toBe(202);
    expect(await revoked.t.post(revoked.bob, revoked.implicit(policy))).toBe(202);
    expect(await due(revoked.t, revoked.statusId)).toEqual([{ state: "revoked", verify_after: null }]);
  });

  it("a flag left on a revoked quote is not read: a newer Update's new stamp starts a work of its own", async () => {
    const { t, bob, carol, statusId, first, stamp, serve, implicit, newer } = await world(true);
    // A same-version Update flags the quote's renewed work; carol's Delete revokes it meanwhile (and fans out).
    expect(await t.post(bob, implicit({}))).toBe(202);
    expect(await t.post(carol, remove(carol, first!))).toBe(202);
    expect(await quoteState(t, statusId)).toBe("revoked");
    const count = broadcasts(t);
    expect(await count()).toBe(1);
    const approval = stamp();
    serve(approval);
    expect(await t.post(bob, newer({ quoteAuthorization: approval }))).toBe(202);
    expect(await count()).toBe(1);
    await decide(t);
    expect(await quoteState(t, statusId)).toBe("accepted");
    expect(await count()).toBe(1);
  });

  // The flag's orders (quotes.broadcast): an accepted quote whose stamp already answers 404, the round's stamp fetch
  // held while an Update arrives. Each count is Mastodon's for the same order: one broadcast for the first
  // verification's move, one per significant edit.
  async function heldRound(t: Setup, stamp: string, during: () => Promise<void>, now = NOW) {
    const gate = t.web.hold(stamp);
    const round = decide(t, now);
    await gate.reached;
    await during();
    gate.release();
    await round;
  }

  it("a same-version Update then a significant newer one: two notifications", async () => {
    const { t, bob, statusId, first, implicit, newer } = await world(true);
    t.web.fail(first!, 404);
    const count = broadcasts(t);
    expect(await t.post(bob, implicit({}))).toBe(202);
    await heldRound(t, first!, async () => {
      expect(await t.post(bob, newer(SIGNIFICANT))).toBe(202);
      expect(await count()).toBe(1);
    });
    expect(await quoteState(t, statusId)).toBe("revoked");
    expect(await count()).toBe(2);
  });

  it("a significant newer Update then a same-version one: one", async () => {
    const { t, bob, statusId, first, newer } = await world(true);
    t.web.fail(first!, 404);
    const count = broadcasts(t);
    expect(await t.post(bob, newer(SIGNIFICANT))).toBe(202);
    expect(await count()).toBe(1);
    // The same version as the edit's: handle_implicit_update!.
    await heldRound(t, first!, async () => {
      expect(await t.post(bob, newer(SIGNIFICANT))).toBe(202);
      expect(await count()).toBe(1);
    });
    expect(await quoteState(t, statusId)).toBe("revoked");
    expect(await count()).toBe(1);
  });

  it("a same-version Update then a newer one with no significant change: one", async () => {
    const { t, bob, statusId, first, implicit, newer } = await world(true);
    t.web.fail(first!, 404);
    const count = broadcasts(t);
    expect(await t.post(bob, implicit({}))).toBe(202);
    await heldRound(t, first!, async () => {
      expect(await t.post(bob, newer({}))).toBe(202);
      expect(await count()).toBe(0);
    });
    expect(await quoteState(t, statusId)).toBe("revoked");
    expect(await count()).toBe(1);
  });

  // A Create's stamp answers 503: its retry, one backoff later, finds the stamp gone.
  describe("after a failure that may pass, the next verification decides", () => {
    const RETRY = NOW + QUOTE_BACKOFF_MS[0]!;
    async function failed() {
      const w = await world(true, {}, { answer: 503 });
      w.t.web.fail(w.first!, 404);
      return { ...w, count: broadcasts(w.t) };
    }

    it("with no Update between: the retry's rejection notifies once", async () => {
      const { t, statusId, count } = await failed();
      await decide(t, RETRY);
      expect(await quoteState(t, statusId)).toBe("rejected");
      expect(await count()).toBe(1);
    });

    it.each([
      ["a same-version Update", "implicit", 1, false],
      ["a significant newer Update", "newer", 1, false],
      ["a same-version Update, while the retry is claimed", "implicit", 1, true],
      ["a significant newer Update, while the retry is claimed", "newer", 1, true],
    ] as const)("after %s: one notification in all", async (_name, kind, expected, claimed) => {
      const { t, bob, statusId, first, implicit, newer, count } = await failed();
      const arrive = async () => {
        expect(await t.post(bob, kind === "implicit" ? implicit({}) : newer(SIGNIFICANT))).toBe(202);
        expect(await count()).toBe(kind === "implicit" ? 0 : 1);
      };
      if (claimed) {
        await heldRound(t, first!, arrive, RETRY);
      } else {
        await arrive();
        await decide(t, RETRY);
      }
      expect(await quoteState(t, statusId)).toBe("rejected");
      expect(await count()).toBe(expected);
    });

    it("after a significant newer Update then a same-version one: the edit only", async () => {
      const { t, bob, statusId, newer, count } = await failed();
      expect(await t.post(bob, newer(SIGNIFICANT))).toBe(202);
      expect(await count()).toBe(1);
      // The same version as the edit's: handle_implicit_update!.
      expect(await t.post(bob, newer(SIGNIFICANT))).toBe(202);
      expect(await count()).toBe(1);
      await decide(t, RETRY);
      expect(await quoteState(t, statusId)).toBe("rejected");
      expect(await count()).toBe(1);
    });
  });

  it("a signer's retry keeps the flag: its decision notifies no one", async () => {
    const t = await setup();
    const erin = await mastodonActor(t.web, "erin", { key: 7 });
    const followers = `${erin.uri}/followers`;
    const own = mastodonNote(erin, { to: [followers], cc: [] });
    t.web.serve(own.id, { "@context": AS, ...own });
    t.web.signedOnly.set(own.id, `${ALICE_URI}#main-key`);
    const quote = quoting(erin, own.id, null);
    t.web.serve(quote.id, { "@context": AS, ...quote });
    // Stored by a search while no local account follows erin: the instance actor fetches for it (a work at 0).
    const found = await t.api<{ statuses: { id: string; uri: string }[] }>(
      `/api/v2/search?q=${encodeURIComponent(quote.id)}&resolve=true&type=statuses`,
    );
    const statusId = found.body.statuses[0]!.id;
    const boosted = await t.request(`/api/v1/statuses/${statusId}/reblog`, {
      method: "POST",
      headers: { authorization: `Bearer ${t.tokens.dave}` },
    });
    expect(boosted.status).toBe(200);
    // The instance actor's fetch, refused while the Create at alice's inbox names her: a signer's retry.
    await heldRound(t, own.id, async () => {
      await followed(t, erin);
      expect(await t.post(erin, create(erin, quote), { path: "/ap/users/alice/inbox" })).toBe(202);
    });
    expect(await sql(t.store, "SELECT state, attempts FROM quotes WHERE status_id = ?", statusId)).toEqual([
      { state: "pending", attempts: 1 },
    ]);
    await decide(t, NOW + QUOTE_BACKOFF_MS[0]!);
    expect(await quoteState(t, statusId)).toBe("accepted");
    expect(await rowsOf(t, "update")).toEqual([]);
  });

  it("notifies no one when it changes only its poll's counts", async () => {
    const choices = (cats: number) => [
      { type: "Note", name: "cats", replies: { type: "Collection", totalItems: cats } },
      { type: "Note", name: "dogs", replies: { type: "Collection", totalItems: 0 } },
    ];
    const poll = { type: "Question", endTime: "2026-10-13T00:00:00Z", votersCount: 1, oneOf: choices(1) };
    const { t, bob, statusId, implicit } = await world(true, poll);
    expect(await t.post(bob, implicit({ votersCount: 2, oneOf: choices(2) }))).toBe(202);
    expect(await sql(t.store, "SELECT votes_count, voters_count FROM polls WHERE status_id = ?", statusId)).toEqual([
      { votes_count: 2, voters_count: 2 },
    ]);
    await decide(t);
    expect(await quoteState(t, statusId)).toBe("accepted");
    expect(await rowsOf(t, "mention")).toEqual([]);
    expect(await rowsOf(t, "update")).toEqual([]);
  });

  it("notifies no one for a legacy form alone, and keeps the quote accepted", async () => {
    const { t, bob, statusId, implicit } = await world(true);
    // The same stamp, the quote named by _misskey_quote and quoteUri only (a legacy form).
    expect(await t.post(bob, implicit({ quote: undefined }))).toBe(202);
    await decide(t);
    expect(await sql(t.store, "SELECT legacy, state FROM quotes WHERE status_id = ?", statusId)).toEqual([
      { legacy: 0, state: "accepted" },
    ]);
    expect(await rowsOf(t, "mention")).toEqual([]);
    expect(await rowsOf(t, "update")).toEqual([]);
  });
});

describe("the bound of an edit's notifications (docs/threat-model.md RES-4)", () => {
  const CAROL = "333333333333333333";
  const ERIN = "444444444444444444";
  const LOCALS = [
    [ALICE, "alice"],
    [DAVE, "dave"],
    [CAROL, "carol"],
    [ERIN, "erin"],
  ] as const;
  const uriOf = (username: string) => `${LOCAL}/ap/users/${username}`;

  async function seedLocals(t: Setup): Promise<Record<string, string>> {
    const tokens: Record<string, string> = { [ALICE]: t.tokens.alice, [DAVE]: t.tokens.dave };
    for (const [id, username] of LOCALS.slice(2)) {
      await seedLocalAccount(t.store, "kopje.test", { id, username, key: LEGACY_EMPTY_KEK });
      tokens[id] = await token(t.store, id);
    }
    return tokens;
  }

  it("replaces each update, quoted_update and cleared mention within the formula; a kept one writes nothing", async () => {
    const t = await setup();
    const tokens = await seedLocals(t);
    // Every local account: a streaming subscription and one push subscription (P_r = 1) for each type here.
    for (const [id] of LOCALS) {
      await sql(
        t.store,
        "INSERT INTO stream_subscriptions (account_id, stream_key, sockets) VALUES (?, 'user', 1)",
        id,
      );
      await subscribe(t, id, ["mention", "quote", "update", "quoted_update"]);
    }
    const bob = await mastodonActor(t.web, "bob");
    const bobId = await followed(t, bob, DAVE);
    // bob's public status quoting alice's (accepted through its QuoteRequest), tagging and addressing the four.
    const mine = await localStatus(t, { status: "quote me", visibility: "public" });
    const uris = LOCALS.map(([, username]) => uriOf(username));
    const note = quoting(bob, mine.uri, null, { cc: [FOLLOWERS(bob), ...uris], tag: uris.map(mention) });
    t.web.serve(note.id, { "@context": AS, ...note });
    expect(await t.post(bob, create(bob, note))).toBe(202);
    expect(await t.post(bob, quoteRequest(bob, mine.uri, note.id))).toBe(202);
    const statusId = (await statusRow(t.store, note.id))!.id;
    // Each of the four boosts it; dave quotes it (an accepted local quote).
    for (const [id] of LOCALS) {
      const response = await t.request(`/api/v1/statuses/${statusId}/reblog`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokens[id]}` },
      });
      expect(response.status).toBe(200);
    }
    const daves = await localStatus(t, { status: "dave quotes bob", visibility: "public" }, "dave");
    await sql(
      t.store,
      `INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, local, updated_at)
			VALUES (?, ?, ?, ?, 'accepted', 1, ?)`,
      daves.id,
      note.id,
      statusId,
      bobId,
      new Date(NOW).toISOString(),
    );
    // bob's first significant edit: each booster's update and dave's quoted_update, each with its push queued.
    expect(await t.post(bob, edited(bob, note))).toBe(202);
    // carol clears her notifications (hidden, their pushes still queued).
    await cleared(t, CAROL);
    const notificationsNow = () =>
      sql<{ id: string; account_id: string; type: string }>(
        t.store,
        "SELECT CAST(id AS TEXT) AS id, account_id, type FROM notifications ORDER BY id",
      );
    const streamed = async () =>
      (await sql<{ n: number }>(t.store, "SELECT count(*) AS n FROM stream_events WHERE kind = 'notification'"))[0]!.n;
    const before = await notificationsNow();
    const streamedBefore = await streamed();
    expect(before.filter((n) => n.type === "update")).toHaveLength(LOCALS.length);
    expect(before.filter((n) => n.type === "quoted_update")).toMatchObject([{ account_id: DAVE }]);
    expect(before.filter((n) => n.type === "quote")).toMatchObject([{ account_id: ALICE }]);
    expect(before.filter((n) => n.type === "mention")).toHaveLength(LOCALS.length);

    const measured = await runInDurableObject(t.store, (_instance, state) => {
      let policies = 0;
      const db = new Db(
        observedSql(state.storage.sql, (_rows, query) => {
          policies += query.includes("main.notification_permissions") ? 1 : 0;
        }),
      );
      const start = totalChanges(db);
      notifyEdited(db, statusId, bobId, NOW + 60_000);
      return { policies, changes: totalChanges(db) - start };
    });
    // One policy statement for alice's quote and one per mention (N = 4); update and quoted_update read none.
    expect(measured.policies).toBe(1 + LOCALS.length);
    // Section 5's terms that happen: each replaced update and quoted_update deletes the previous row and its push
    // (cascade), inserts, journals and pushes (3 + 2·P_r); carol's cleared mention the same (the status is not direct,
    // so no conversation: 3 + 2·P_r of its 7 + 2·P_r); the kept quote and the other kept mentions write nothing.
    const P = 1;
    const replaced = LOCALS.length + 1 + 1;
    expect(measured.changes).toBe(replaced * (3 + 2 * P));
    const formula = 3 + 2 * P + LOCALS.length * (7 + 2 * P) + LOCALS.length * (3 + 2 * P) + (3 + 2 * P);
    expect(measured.changes).toBeLessThanOrEqual(formula);

    const after = await notificationsNow();
    const key = (n: { account_id: string; type: string }) => `${n.type}:${n.account_id}`;
    expect(after.map(key).toSorted()).toEqual(before.map(key).toSorted());
    const kept = before.filter((n) => after.some((m) => m.id === n.id));
    expect(kept.map(key).toSorted()).toEqual(
      ["mention:" + ALICE, "mention:" + DAVE, "mention:" + ERIN, "quote:" + ALICE].toSorted(),
    );
    const fresh = after.filter((n) => !before.some((m) => m.id === n.id));
    expect(fresh).toHaveLength(replaced);
    expect(await streamed()).toBe(streamedBefore + replaced);
    // One push per new row, and the pushes of the kept ones; the replaced rows' pushes went with them.
    expect(await pushed(t)).toEqual(
      [...kept, ...fresh].map((n) => n.id).toSorted((a, b) => Number(BigInt(a) - BigInt(b))),
    );
  }, 60_000);

  it("reads no more for 10,000 converted mention rows: one key probe per local account", async () => {
    const t = await setup();
    await seedLocals(t);
    const bob = await mastodonActor(t.web, "bob");
    const bobId = await followed(t, bob, DAVE);
    const uris = LOCALS.slice(0, 3).map(([, username]) => uriOf(username));
    const note = mastodonNote(bob, { cc: [FOLLOWERS(bob), ...uris], tag: uris.map(mention) });
    expect(await t.post(bob, create(bob, note))).toBe(202);
    const statusId = (await statusRow(t.store, note.id))!.id;
    await remoteAccounts({ store: t.store }, 10, 1010);
    // Remote mention rows as the cutover conversion writes them (cli/lib/cutover/convert.js): any number, by SQL.
    const converted = (offset: number, count: number) =>
      sql(
        t.store,
        `INSERT INTO status_mentions (status_id, account_id, silent, requires_mention, author_id)
				SELECT ?1, id, 0, 0, ?2 FROM accounts WHERE domain IS NOT NULL AND id <> ?2 ORDER BY id LIMIT ?3 OFFSET ?4`,
        statusId,
        bobId,
        count,
        offset,
      );
    await converted(0, 100);
    // The rows LOCAL_MENTIONS_SQL reads in notifyEdited.
    const reads = () =>
      runInDurableObject(t.store, (_instance, state) => {
        let rows = -1;
        const real = state.storage.sql;
        const counting = {
          exec: (query: string, ...params: SqlStorageValue[]) => {
            const cursor = real.exec(query, ...params);
            return watchedCursor(cursor, () => {
              if (query.includes("CROSS JOIN status_mentions m")) {
                rows = cursor.rowsRead;
              }
            });
          },
        } as unknown as SqlStorage;
        notifyEdited(new Db(counting), statusId, bobId, NOW);
        return rows;
      });
    const { before, after } = await staleStatistics(
      { store: t.store },
      { capture: reads, grow: () => converted(100, 10_000) },
    );
    expect(
      await sql(t.store, "SELECT count(*) AS n FROM status_mentions WHERE status_id = ? AND silent = 0", statusId),
    ).toEqual([{ n: 3 + 100 + 10_000 }]);
    expect(before).toBeGreaterThan(0);
    expect(after).toBe(before);
  }, 60_000);
});

describe("a quote state change's update fan-out (DistributionWorker with update: true)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function boost(t: Setup, statusId: string) {
    const boosted = await t.request(`/api/v1/statuses/${statusId}/reblog`, {
      method: "POST",
      headers: { authorization: `Bearer ${t.tokens.dave}` },
    });
    expect(boosted.status).toBe(200);
  }

  async function dismiss(t: Setup, as: "alice" | "dave", id: string) {
    const dismissed = await t.request(`/api/v1/notifications/${id}/dismiss`, {
      method: "POST",
      headers: { authorization: `Bearer ${t.tokens[as]}` },
    });
    expect(dismissed.status).toBe(200);
  }

  const updates = (t: Setup) =>
    sql<{ id: string; account_id: string; status_id: string }>(
      t.store,
      "SELECT CAST(id AS TEXT) AS id, account_id, status_id FROM notifications WHERE type = 'update' ORDER BY id",
    );

  const stateOf = async (t: Setup, statusId: string) =>
    (await sql<{ state: string }>(t.store, "SELECT state FROM quotes WHERE status_id = ?", statusId))[0]?.state;

  // bob's quote of carol's status (on another server), accepted by carol's stamp, tags alice, whose mention is
  // dismissed; bob's other quote names the same stamp, which does not name it (pending). dave follows bob and boosted
  // both.
  async function received() {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await followed(t, bob, DAVE);
    const carol = await mastodonActor(t.web, "carol", { origin: OTHER, key: 2 });
    await subscribe(t, ALICE, ["mention"]);
    const target = mastodonNote(carol);
    t.web.serve(target.id, { "@context": AS, ...target });
    const stamp = `${carol.uri}/quote_authorizations/${nextId()}`;
    const note = quoting(bob, target.id, stamp, { cc: [FOLLOWERS(bob), ALICE_URI], tag: [mention(ALICE_URI)] });
    serveStamp(t.web, stamp, carol, note.id, target.id);
    const other = quoting(bob, target.id, stamp);
    expect(await t.post(bob, create(bob, note))).toBe(202);
    expect(await t.post(bob, create(bob, other))).toBe(202);
    const deps = { ...inboxDeps(() => t.store, t.web.loader), now: () => NOW };
    for (let round = 0; await verifyQuotes(t.env, deps); round++) {
      expect(round).toBeLessThan(20);
    }
    const statusId = (await statusRow(t.store, note.id))!.id;
    const otherId = (await statusRow(t.store, other.id))!.id;
    expect([await stateOf(t, statusId), await stateOf(t, otherId)]).toEqual(["accepted", "pending"]);
    await boost(t, statusId);
    await boost(t, otherId);
    const [mentioned] = await rowsOf(t, "mention");
    await dismiss(t, "alice", mentioned!.id);
    expect(await pushed(t)).toEqual([]);
    return { t, carol, stamp, statusId, otherId };
  }

  it("a stamp's Delete fans out the quote it approved, and rejects a pending quote naming it silently", async () => {
    const { t, carol, stamp, statusId, otherId } = await received();
    expect(await t.post(carol, remove(carol, stamp))).toBe(202);
    expect([await stateOf(t, statusId), await stateOf(t, otherId)]).toEqual(["revoked", "rejected"]);
    const again = await rowsOf(t, "mention");
    expect(again).toMatchObject([{ account_id: ALICE }]);
    expect(await pushed(t)).toEqual([again[0]!.id]);
    // The booster hears of the revoked quote only: the rejection moved a state no broadcast follows.
    expect(await updates(t)).toMatchObject([{ account_id: DAVE, status_id: statusId }]);
  });

  // The fan-out fails at the booster's update, after alice's mention and its push were written: they are rolled back
  // with it, and the revocation stays.
  it("…and still revokes when the fan-out fails part way, keeping none of its notifications, and logs it", async () => {
    const { t, carol, stamp, statusId } = await received();
    await sql(
      t.store,
      `CREATE TRIGGER test_fail_update BEFORE INSERT ON notifications WHEN NEW.type = 'update'
			BEGIN SELECT RAISE(ABORT, 'notify'); END`,
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await t.post(carol, remove(carol, stamp))).toBe(202);
    expect(await stateOf(t, statusId)).toBe("revoked");
    expect(await sql(t.store, "SELECT authorization FROM quote_revocations")).toEqual([{ authorization: stamp }]);
    expect(errors).toHaveBeenCalledWith(expect.objectContaining({ event: "kopje.quote.fan_out.failed" }));
    expect(await rowsOf(t, "mention")).toEqual([]);
    expect(await updates(t)).toEqual([]);
    expect(await pushed(t)).toEqual([]);
  });

  // alice's quote of bob's status (anyone may quote it), tagging dave: pending until bob answers its QuoteRequest.
  async function ours() {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await followed(t, bob);
    await subscribe(t, DAVE, ["mention", "update"]);
    const theirs = mastodonNote(bob, { interactionPolicy: { canQuote: { automaticApproval: [PUBLIC] } } });
    expect(await t.post(bob, create(bob, theirs))).toBe(202);
    t.web.serve(theirs.id, { "@context": AS, ...theirs });
    const quoted = (await statusRow(t.store, theirs.id))!.id;
    const mine = await localStatus(t, { status: "@dave look", visibility: "public", quoted_status_id: quoted });
    expect(await stateOf(t, mine.id)).toBe("pending");
    return { t, bob, theirs, mine, stamp: `${bob.uri}/quote_authorizations/${nextId()}` };
  }

  it("an Accept of our quote request notifies the quote's booster and a dismissed mention", async () => {
    const { t, bob, mine, stamp } = await ours();
    await boost(t, mine.id);
    const [mentioned] = await rowsOf(t, "mention");
    await dismiss(t, "dave", mentioned!.id);
    expect(await updates(t)).toEqual([]);
    expect(await t.post(bob, quoteAccept(bob, mine.uri, stamp))).toBe(202);
    expect(await stateOf(t, mine.id)).toBe("accepted");
    const again = await rowsOf(t, "mention");
    expect(again).toMatchObject([{ account_id: DAVE }]);
    const update = await updates(t);
    expect(update).toMatchObject([{ account_id: DAVE, status_id: mine.id }]);
    expect(await pushed(t)).toEqual(expect.arrayContaining([again[0]!.id, update[0]!.id]));
  });

  // reject.rb:37 in v4.7.5: "TODO: broadcast an update?".
  it("…but a Reject notifies no one, though the quote's state moved", async () => {
    const { t, bob, mine } = await ours();
    await boost(t, mine.id);
    const [mentioned] = await rowsOf(t, "mention");
    await dismiss(t, "dave", mentioned!.id);
    const pushes = await pushed(t);
    expect(await t.post(bob, quoteReject(bob, mine.uri))).toBe(202);
    expect(await stateOf(t, mine.id)).toBe("rejected");
    expect(await rowsOf(t, "mention")).toEqual([]);
    expect(await updates(t)).toEqual([]);
    expect(await pushed(t)).toEqual(pushes);
  });

  // quote_request.rb:41 in v4.7.5 broadcasts with skip_notifications.
  it("accepting a QuoteRequest notifies the quoted author's quote only", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await subscribe(t, DAVE, ["update"]);
    const mine = await localStatus(t, { status: "quote me", visibility: "public" });
    const note = quoting(bob, mine.uri, null);
    t.web.serve(note.id, { "@context": AS, ...note });
    expect(await t.post(bob, create(bob, note), { path: "/ap/users/alice/inbox" })).toBe(202);
    const statusId = (await statusRow(t.store, note.id))!.id;
    expect(await stateOf(t, statusId)).toBe("pending");
    await boost(t, statusId);
    expect(await t.post(bob, quoteRequest(bob, mine.uri, note.id))).toBe(202);
    expect(await stateOf(t, statusId)).toBe("accepted");
    expect(await rowsOf(t, "quote")).toMatchObject([{ account_id: ALICE }]);
    expect(await updates(t)).toEqual([]);
    expect(await pushed(t)).toEqual([]);
  });

  it("a local quote's stamp Delete fans out its status once; a repeated Delete none", async () => {
    const { t, bob, mine, stamp } = await ours();
    expect(await t.post(bob, quoteAccept(bob, mine.uri, stamp))).toBe(202);
    expect(await stateOf(t, mine.id)).toBe("accepted");
    await boost(t, mine.id);
    const [mentioned] = await rowsOf(t, "mention");
    await dismiss(t, "dave", mentioned!.id);
    expect(await t.post(bob, remove(bob, stamp))).toBe(202);
    expect(await stateOf(t, mine.id)).toBe("revoked");
    const again = await rowsOf(t, "mention");
    expect(again).toMatchObject([{ account_id: DAVE }]);
    const update = await updates(t);
    expect(update).toMatchObject([{ account_id: DAVE, status_id: mine.id }]);
    const pushes = await pushed(t);
    expect(pushes).toEqual(expect.arrayContaining([again[0]!.id, update[0]!.id]));
    expect(await t.post(bob, remove(bob, stamp))).toBe(202);
    expect(await updates(t)).toEqual(update);
    expect(await pushed(t)).toEqual(pushes);
  });

  // bob approves alice's quote with the stamp he also serves for erin's quote of the same status: its Delete revokes
  // the local quote holding it (revokeLocalStamp) and the received one it approved (stampHolder), each fanned out.
  it("a stamp's Delete fans out at most twice: the local quote holding it, then the received one it approved", async () => {
    const { t, bob, theirs, mine, stamp } = await ours();
    expect(await t.post(bob, quoteAccept(bob, mine.uri, stamp))).toBe(202);
    const erin = await mastodonActor(t.web, "erin", { key: 7 });
    await followed(t, erin, DAVE);
    const note = quoting(erin, theirs.id, stamp);
    serveStamp(t.web, stamp, bob, note.id, theirs.id);
    expect(await t.post(erin, create(erin, note))).toBe(202);
    const deps = { ...inboxDeps(() => t.store, t.web.loader), now: () => NOW };
    for (let round = 0; await verifyQuotes(t.env, deps); round++) {
      expect(round).toBeLessThan(20);
    }
    const received = (await statusRow(t.store, note.id))!.id;
    expect([await stateOf(t, mine.id), await stateOf(t, received)]).toEqual(["accepted", "accepted"]);
    await boost(t, mine.id);
    await boost(t, received);
    expect(await t.post(bob, remove(bob, stamp))).toBe(202);
    expect([await stateOf(t, mine.id), await stateOf(t, received)]).toEqual(["revoked", "revoked"]);
    const update = await updates(t);
    expect(update).toMatchObject([
      { account_id: DAVE, status_id: mine.id },
      { account_id: DAVE, status_id: received },
    ]);
    expect(await t.post(bob, remove(bob, stamp))).toBe(202);
    expect(await updates(t)).toEqual(update);
  });

  it("the revoke API fans out the quoting status once; a repeated revoke none", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await followed(t, bob, DAVE);
    await subscribe(t, DAVE, ["update"]);
    const mine = await localStatus(t, { status: "quote me", visibility: "public" });
    const note = quoting(bob, mine.uri, null);
    t.web.serve(note.id, { "@context": AS, ...note });
    expect(await t.post(bob, create(bob, note))).toBe(202);
    expect(await t.post(bob, quoteRequest(bob, mine.uri, note.id))).toBe(202);
    const statusId = (await statusRow(t.store, note.id))!.id;
    expect(await stateOf(t, statusId)).toBe("accepted");
    await boost(t, statusId);
    const revoke = () =>
      t.request(`/api/v1/statuses/${mine.id}/quotes/${statusId}/revoke`, {
        method: "POST",
        headers: { authorization: `Bearer ${t.tokens.alice}` },
      });
    expect((await revoke()).status).toBe(200);
    expect(await stateOf(t, statusId)).toBe("revoked");
    const update = await updates(t);
    expect(update).toMatchObject([{ account_id: DAVE, status_id: statusId }]);
    expect(await pushed(t)).toEqual([update[0]!.id]);
    expect((await revoke()).status).toBe(200);
    expect(await updates(t)).toEqual(update);
    expect(await pushed(t)).toEqual([update[0]!.id]);
  });
});
