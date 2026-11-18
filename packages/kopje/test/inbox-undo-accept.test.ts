import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { HANDSHAKE_RECHECK_MS } from "../src/domain/deliveries";
import { type InboundActivity, type ReceiveResult, receiveActivity } from "../src/domain/inbox";
import { parseActivity } from "../src/federation/inbound";
import { handleQueue } from "../src/jobs/queue";
import type { StoreStub } from "../src/platform/store-client";
import { bearer, json, sql } from "./api-helpers";
import { countingStore, harness, inboxDeps, NOW } from "./app-helpers";
import { fixtureKeyGen, LEGACY_EMPTY_KEK, seedLocalAccount } from "./federation-helpers";
import { BUILD, completeSetup, drainDeliveries, migratedStore } from "./helpers";
import { LOCAL, loggedRefusals, mastodonActor, RemoteWeb, type SignOptions, signedInit } from "./inbox-helpers";
import { storeReceive } from "./inbox-store-helpers";
import { type PlannedStatement, plannedSql, scansOf } from "./read-helpers";
import { act, unsuspend, uriOf, world } from "./remote-suspension-helpers";
import { remoteAccount, seedStatus } from "./status-helpers";

// #1775, ID-6: an Undo of an Accept of a local account's Follow turns that follow back into a request, as Mastodon's
// Undo#undo_accept does (undo.rb:85-87, follow.rb revoke_request!): the actor's accepted follow by a local account whose
// uri is the Follow id the Accept names goes pending, with the follower's list membership of the actor and endorsement
// of it, and nothing is recorded (ID-7), so the Accept delivered again accepts it again.

const AS = "https://www.w3.org/ns/activitystreams";
const REMOTE = "https://remote.example";

type Json = Record<string, unknown>;

async function setup() {
  const w = await world();
  const store = w.h.store;
  const r = await remoteAccount(store, "r");
  const c = await remoteAccount(store, "c");
  return {
    w,
    store,
    r,
    c,
    rUri: await uriOf(store, r),
    cUri: await uriOf(store, c),
    aliceUri: await uriOf(store, w.alice.id),
  };
}

type T = Awaited<ReturnType<typeof setup>>;

let sequence = 0;

// The body as the inbox reads it (parseActivity), then the Store's receive.
async function deliver(store: StoreStub, actorUri: string, body: Json): Promise<ReceiveResult> {
  const read = await parseActivity(new TextEncoder().encode(JSON.stringify(body)));
  if (!read.ok) {
    throw new Error(`refused at the inbox: ${read.reason}`);
  }
  return storeReceive(store, actorUri, read.activity as InboundActivity, NOW);
}

async function api(t: T, method: "GET" | "POST", path: string, body?: Json) {
  const response = await t.w.h.request(
    path,
    method === "GET" ? bearer(t.w.alice.token) : bearer(t.w.alice.token, json(body ?? {})),
  );
  expect(response.status, path).toBeLessThan(500);
  return { status: response.status, body: await response.json() };
}

// alice's follow of r through the API, its Follow id, then r's Accept of it.
async function aliceFollows(t: T): Promise<{ follow: string; accept: string }> {
  expect((await api(t, "POST", `/api/v1/accounts/${t.r}/follow`)).status).toBe(200);
  const follow = (
    await sql<{ uri: string }>(
      t.store,
      "SELECT uri FROM follows WHERE account_id = ? AND target_account_id = ?",
      t.w.alice.id,
      t.r,
    )
  )[0]!.uri;
  const accept = `${REMOTE}/accepts/${++sequence}`;
  expect(await deliver(t.store, t.rUri, acceptOf(t, accept, follow))).toMatchObject({
    applied: true,
    reason: "follow-accepted",
  });
  return { follow, accept };
}

function acceptOf(t: T, id: string, follow: unknown, actor = t.rUri): Json {
  return { "@context": AS, id, type: "Accept", actor, object: follow };
}

const undoOf = (actorUri: string, accept: unknown): Json => ({
  "@context": AS,
  id: `${actorUri}#undo-${++sequence}`,
  type: "Undo",
  actor: actorUri,
  object: accept,
});

const undoAccept = (t: T, accept: string, object: unknown, extra: Json = {}, actorUri = t.rUri) =>
  deliver(
    t.store,
    actorUri,
    undoOf(actorUri, {
      id: accept,
      type: "Accept",
      actor: actorUri,
      ...(object === undefined ? {} : { object }),
      ...extra,
    }),
  );

const edge = (t: T) =>
  sql<{ state: string; uri: string | null }>(
    t.store,
    "SELECT state, uri FROM follows WHERE account_id = ? AND target_account_id = ?",
    t.w.alice.id,
    t.r,
  );

// What an Undo of an Accept may change: the follows and their counts, list members, endorsements, retractions.
async function snapshot(store: StoreStub) {
  const tables = [
    "SELECT id, account_id, target_account_id, state, uri, notify, show_reblogs FROM follows",
    "SELECT id, followers_count, following_count FROM accounts",
    "SELECT list_id, account_id FROM list_accounts",
    "SELECT account_id, target_account_id FROM account_pins",
    "SELECT actor_uri, target_uri, expires_at FROM inbound_retractions",
  ];
  return Promise.all(
    tables.map(async (query) => (await sql(store, query)).map((row) => JSON.stringify(row)).toSorted()),
  );
}

describe("ID-6: an Undo of an Accept turns the local account's follow back into a request", () => {
  it("by the Follow id its Accept names: pending, out of the list and the endorsements, and accepted again", async () => {
    const t = await setup();
    const { follow, accept } = await aliceFollows(t);
    const list = (await api(t, "POST", "/api/v1/lists", { title: "r" })).body as { id: string };
    expect((await api(t, "POST", `/api/v1/lists/${list.id}/accounts`, { account_ids: [t.r] })).status).toBe(200);
    expect((await api(t, "POST", `/api/v1/accounts/${t.r}/pin`)).status).toBe(200);
    // alice follows #kopje: r's public status under it reaches home by the hashtag too.
    expect((await api(t, "POST", "/api/v1/tags/kopje/follow")).status).toBe(200);
    const open = await seedStatus(t.store, { accountId: t.r, visibility: "public", uri: `${REMOTE}/notes/public` });
    const tagged = await seedStatus(t.store, {
      accountId: t.r,
      visibility: "public",
      uri: `${REMOTE}/notes/tagged`,
      tags: ["kopje"],
    });
    const shared = await seedStatus(t.store, { accountId: t.r, visibility: "private", uri: `${REMOTE}/notes/private` });
    const seen = async () => (await api(t, "GET", `/api/v1/statuses/${shared}`)).status;
    const ids = async (path: string) =>
      ((await api(t, "GET", path)).body as { id: string }[]).map((s) => s.id).toSorted();
    const feeds = async () => [await ids("/api/v1/timelines/home"), await ids(`/api/v1/timelines/list/${list.id}`)];
    const relationship = async () =>
      ((await api(t, "GET", `/api/v1/accounts/relationships?id[]=${t.r}`)).body as Json[])[0];
    const following = async () =>
      (await sql<{ n: number }>(t.store, "SELECT following_count AS n FROM accounts WHERE id = ?", t.w.alice.id))[0]!.n;
    expect([await seen(), await following()]).toEqual([200, 1]);
    expect(await feeds()).toEqual([[open, tagged, shared].toSorted(), [open, tagged, shared].toSorted()]);
    expect(await relationship()).toMatchObject({ following: true, requested: false, endorsed: true });
    const retractions = await sql(t.store, "SELECT * FROM inbound_retractions");

    expect(await undoAccept(t, accept, follow)).toMatchObject({ applied: true, reason: "follow-unaccepted" });
    expect(await edge(t)).toEqual([{ state: "pending", uri: follow }]);
    expect(await relationship()).toMatchObject({ following: false, requested: true, endorsed: false });
    expect([await seen(), await following()]).toEqual([404, 0]);
    // Home and the list read r's statuses from the accepted follow and the list membership, both gone: neither shows
    // r's public status either, and home keeps only what the followed hashtag brings (docs/mastodon-deviations.md,
    // "Home and lists").
    expect(await feeds()).toEqual([[tagged], []]);
    expect(await sql(t.store, "SELECT * FROM list_accounts")).toEqual([]);
    expect(await sql(t.store, "SELECT * FROM inbound_retractions")).toEqual(retractions);

    // The same Accept again accepts it again, as Mastodon's authorize! of the request does.
    expect(await deliver(t.store, t.rUri, acceptOf(t, accept, follow))).toMatchObject({
      applied: true,
      reason: "follow-accepted",
    });
    expect(await edge(t)).toEqual([{ state: "accepted", uri: follow }]);
    expect([await seen(), await following()]).toEqual([200, 1]);
  });

  // Follows sharing one Follow id (an import may repeat it): the oldest accepted one carrying it byte for byte, of any
  // local account, goes first; one whose id differs only in case is another id. The ids differ in width, so an order of
  // their text ("1000" before "999") would pick the newer one.
  it("changes only the oldest follow carrying the Follow id exactly, one per Undo", async () => {
    const t = await setup();
    const g = "https://kopje.test/ap/users/shared#follows/1";
    // The two exact ones' ages run against their accounts' order; the case-different one is the oldest of all.
    const [low, high] = [t.w.bob.id, t.w.dan.id].toSorted((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
    const rows: [string, string, string][] = [
      ["998", t.w.carol.id, g.replace("follows", "Follows")],
      ["999", high!, g],
      ["1000", low!, g],
    ];
    for (const [id, account, uri] of rows) {
      await sql(
        t.store,
        "INSERT INTO follows (id, account_id, target_account_id, state, uri) VALUES (?, ?, ?, 'accepted', ?)",
        id,
        account,
        t.r,
        uri,
      );
      await sql(t.store, "UPDATE accounts SET following_count = 1 WHERE id = ?", account);
    }
    const states = async () =>
      sql<{ id: string; state: string; n: number }>(
        t.store,
        `SELECT CAST(f.id AS TEXT) AS id, f.state, a.following_count AS n FROM follows f JOIN accounts a ON a.id = f.account_id
				WHERE f.target_account_id = ? ORDER BY f.id`,
        t.r,
      );
    const undo = () => undoAccept(t, `${REMOTE}/accepts/shared`, g);
    expect(await undo()).toMatchObject({ applied: true, reason: "follow-unaccepted" });
    expect(await states()).toEqual([
      { id: "998", state: "accepted", n: 1 },
      { id: "999", state: "pending", n: 0 },
      { id: "1000", state: "accepted", n: 1 },
    ]);
    expect(await undo()).toMatchObject({ applied: true, reason: "follow-unaccepted" });
    expect(await undo()).toMatchObject({ applied: false, reason: "unknown-follow" });
    expect(await states()).toEqual([
      { id: "998", state: "accepted", n: 1 },
      { id: "999", state: "pending", n: 0 },
      { id: "1000", state: "pending", n: 0 },
    ]);
  });

  // An Undo of the Accept, or the Accept, of an earlier generation, delivered again after alice unfollowed r and
  // followed it again under a new id, names another Follow: the new follow is left as it is.
  it("an Undo of an earlier generation's Accept, or that Accept, delivered late, leaves the new follow", async () => {
    const t = await setup();
    const old = await aliceFollows(t);
    expect(await undoAccept(t, old.accept, old.follow)).toMatchObject({ reason: "follow-unaccepted" });
    expect(await deliver(t.store, t.rUri, acceptOf(t, old.accept, old.follow))).toMatchObject({
      reason: "follow-accepted",
    });
    expect((await api(t, "POST", `/api/v1/accounts/${t.r}/unfollow`)).status).toBe(200);
    expect((await api(t, "POST", `/api/v1/accounts/${t.r}/follow`)).status).toBe(200);
    const [renewed] = await edge(t);
    expect(renewed).toMatchObject({ state: "pending" });
    expect(renewed!.uri).not.toBe(old.follow);
    expect(await deliver(t.store, t.rUri, acceptOf(t, old.accept, old.follow))).toMatchObject({ applied: false });
    expect(await edge(t)).toEqual([renewed]);
    expect(await deliver(t.store, t.rUri, acceptOf(t, `${REMOTE}/accepts/new`, renewed!.uri))).toMatchObject({
      reason: "follow-accepted",
    });
    const before = await snapshot(t.store);
    expect(await undoAccept(t, old.accept, old.follow)).toMatchObject({ applied: false, reason: "unknown-follow" });
    expect(await snapshot(t.store)).toEqual(before);
    expect(await edge(t)).toEqual([{ state: "accepted", uri: renewed!.uri }]);
  });

  it("names the Follow by an embedded Follow's id too", async () => {
    const t = await setup();
    const { follow, accept } = await aliceFollows(t);
    const embedded = { id: follow, type: "Follow", actor: t.aliceUri, object: t.rUri };
    expect(await undoAccept(t, accept, embedded)).toMatchObject({ applied: true, reason: "follow-unaccepted" });
    expect(await edge(t)).toEqual([{ state: "pending", uri: follow }]);
  });

  // Each changes nothing and records nothing.
  it.each<[string, (t: T, f: { follow: string; accept: string }) => Promise<ReceiveResult>, string]>([
    ["another Follow id", (t, f) => undoAccept(t, f.accept, `${f.follow}-other`), "unknown-follow"],
    ["an array of the Follow id", (t, f) => undoAccept(t, f.accept, [f.follow]), "unknown-follow"],
    ["a null object", (t, f) => undoAccept(t, f.accept, null), "unknown-follow"],
    ["no object", (t, f) => undoAccept(t, f.accept, undefined), "unknown-follow"],
    ["the type in an array", (t, f) => undoAccept(t, f.accept, f.follow, { type: ["Accept"] }), "unsupported-undo"],
    ["an Accept of another actor", (t, f) => undoAccept(t, f.accept, f.follow, { actor: t.cUri }), "not-own"],
    // c, of r's origin, is not the target of alice's follow.
    [
      "the Undo of another account",
      (t, f) => undoAccept(t, `${REMOTE}/accepts/c`, f.follow, {}, t.cUri),
      "unknown-follow",
    ],
  ])("an Undo of the Accept with %s leaves the follow accepted", async (_, send, reason) => {
    const t = await setup();
    const f = await aliceFollows(t);
    const before = await snapshot(t.store);
    expect(await send(t, f)).toMatchObject({ applied: false, reason });
    expect(await snapshot(t.store)).toEqual(before);
    expect(await edge(t)).toEqual([{ state: "accepted", uri: f.follow }]);
  });

  it("leaves a pending follow pending, and a follow stored without an id accepted", async () => {
    const t = await setup();
    expect((await api(t, "POST", `/api/v1/accounts/${t.r}/follow`)).status).toBe(200);
    const uri = (await edge(t))[0]!.uri!;
    const before = await snapshot(t.store);
    expect(await undoAccept(t, `${REMOTE}/accepts/1`, uri)).toMatchObject({ applied: false, reason: "unknown-follow" });
    expect(await snapshot(t.store)).toEqual(before);
    await sql(t.store, "UPDATE follows SET state = 'accepted', uri = NULL WHERE account_id = ?", t.w.alice.id);
    const migrated = await snapshot(t.store);
    for (const object of [uri, null]) {
      expect(await undoAccept(t, `${REMOTE}/accepts/2`, object)).toMatchObject({
        applied: false,
        reason: "unknown-follow",
      });
    }
    expect(await snapshot(t.store)).toEqual(migrated);
  });

  // An Undo naming the Accept by its id alone is a reference, as Mastodon's handle_reference, whose try_undo_accept
  // never matches: it is sought among r's own follows, blocks, Likes and boosts, and alice's follow stays.
  it("an untyped reference to the Accept leaves the follow accepted", async () => {
    const t = await setup();
    const f = await aliceFollows(t);
    expect(await deliver(t.store, t.rUri, undoOf(t.rUri, f.accept))).toMatchObject({ reason: "retraction-recorded" });
    expect(await edge(t)).toEqual([{ state: "accepted", uri: f.follow }]);
  });
});

// The Follow's delivery: Mastodon never sends a Follow again for a revoked one, and neither does Kopje. alice's Follow
// was sent, r accepted it, and the delivery failed with a retryable 503 (r's Accept proves r had it); r then undoes the
// Accept. The retry still goes out as it would have (the copy the failure left), but when it falls due while r is
// suspended, the send-time check does not hold it as an owed handshake (OWED_HANDSHAKE), so nothing sends it again
// once r is unsuspended.
describe("an Undo of an Accept and the Follow's retry", () => {
  const FAILED = { kind: "failed", status: 503, error: "HTTP 503", permanent: false } as const;

  async function revokedDuringRetry() {
    const t = await setup();
    expect((await api(t, "POST", `/api/v1/accounts/${t.r}/follow`)).status).toBe(200);
    const follow = (await edge(t))[0]!.uri!;
    const claim = await t.store.claimDeliveries(BUILD, { now: NOW, leaseToken: "first" });
    expect(claim.deliveries).toHaveLength(1);
    const id = claim.deliveries[0]!.id;
    const confirmed = await t.store.confirmDelivery(BUILD, { id, leaseToken: "first", now: NOW });
    expect(JSON.parse((confirmed as { body: string }).body)).toMatchObject({ type: "Follow", id: follow });
    const accept = `${REMOTE}/accepts/${++sequence}`;
    expect(await deliver(t.store, t.rUri, acceptOf(t, accept, follow))).toMatchObject({ reason: "follow-accepted" });
    const failed = await t.store.completeDelivery(BUILD, { id, leaseToken: "first", now: NOW, outcome: FAILED });
    expect(failed).toMatchObject({ status: "retry" });
    expect(await undoAccept(t, accept, follow)).toMatchObject({ reason: "follow-unaccepted" });
    return { t, follow, retryAt: (failed as { retryAt: number }).retryAt };
  }

  const sent = (t: T, now: number) =>
    drainDeliveries(t.store, ({ body }) => JSON.parse(body) as { type: string; id: string }, {
      now,
      until: "due",
      rounds: 50,
    });
  const holds = (t: T) => sql(t.store, "SELECT follow_id FROM handshake_replays");

  it("due while r is suspended, it is dropped, not held, and nothing sends the Follow after r's unsuspension", async () => {
    const { t, retryAt } = await revokedDuringRetry();
    expect(await act(t.w, t.r, { type: "suspend" })).toMatchObject({ status: 200 });
    expect(await sent(t, retryAt)).toEqual([]);
    expect(await holds(t)).toEqual([]);
    expect(await unsuspend(t.w, t.r)).toMatchObject({ status: 200 });
    const later = retryAt + 2 * HANDSHAKE_RECHECK_MS;
    expect(await t.store.runHandshakeReplays(BUILD, { now: later })).toEqual({ pending: false, delivers: false });
    expect(await sent(t, later)).toEqual([]);
    expect(await edge(t)).toMatchObject([{ state: "pending" }]);
  });

  it("due while r is available, it is sent once, as before the Undo", async () => {
    const { t, follow, retryAt } = await revokedDuringRetry();
    expect(await sent(t, retryAt)).toEqual([expect.objectContaining({ type: "Follow", id: follow })]);
    expect(await sent(t, retryAt + 2 * HANDSHAKE_RECHECK_MS)).toEqual([]);
  });
});

// RES-7: the follow is found by a point lookup per local account, and the follower's count loses the one edge, so what
// an Undo of an Accept reads stays the same under statistics taken before the Store grew, as unrelated pending follows
// and the follower's own accepted followers grow (10,000 each).
describe("an Undo of an Accept under stale statistics (RES-7)", () => {
  const VIEWER = "600000000000000001";
  const OTHER = "600000000000000002";
  const BOB = "550000000000000000";
  const BOB_URI = "https://far.example/users/bob";
  const FOLLOW = "https://kopje.test/ap/users/viewer#follows/1";
  const GROWN = 10_000;

  async function measured(grow: boolean) {
    const store = await migratedStore();
    return runInDurableObject(store, (_instance, state) => {
      const db = state.storage.sql;
      // Five local accounts, as a small community's (more of them than follows, as the statistics see it).
      for (const [id, name] of [
        [VIEWER, "viewer"],
        [OTHER, "other"],
        ["600000000000000003", "l3"],
        ["600000000000000004", "l4"],
        ["600000000000000005", "l5"],
      ]) {
        db.exec(
          "INSERT INTO accounts (id, uri, username) VALUES (?, ?, ?)",
          id,
          `https://kopje.test/ap/users/${name}`,
          name,
        );
        db.exec(
          `INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, ?, X'00', X'00', 'k')`,
          id,
          `${name}@example.com`,
        );
      }
      const remotes = (n: number, base: string) =>
        db.exec(
          `WITH RECURSIVE k(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM k WHERE i < ?1 - 1)
					INSERT INTO accounts (id, uri, username, domain) SELECT CAST(?2 + i AS TEXT), 'https://f.example/u' || ?2 || i, 'u' || ?2 || i, 'f.example' FROM k`,
          n,
          base,
        );
      const follows = (base: string, target: string, followState: string) =>
        db.exec(
          `INSERT INTO follows (account_id, target_account_id, state)
					SELECT id, ?2, ?3 FROM accounts WHERE id >= ?1 AND id < CAST(CAST(?1 AS INTEGER) + 100000 AS TEXT)`,
          base,
          target,
          followState,
        );
      db.exec(
        "INSERT INTO accounts (id, uri, username, domain, inbox_url) VALUES (?, ?, 'bob', 'far.example', 'https://far.example/inbox')",
        BOB,
        BOB_URI,
      );
      db.exec(
        "INSERT INTO follows (account_id, target_account_id, state, uri) VALUES (?, ?, 'accepted', ?)",
        VIEWER,
        BOB,
        FOLLOW,
      );
      db.exec("UPDATE accounts SET following_count = 1 WHERE id = ?", VIEWER);
      // A small Store, analyzed: one of each kind of follow.
      remotes(1, "300000000000000000");
      follows("300000000000000000", OTHER, "pending");
      follows("300000000000000000", VIEWER, "accepted");
      db.exec("ANALYZE");
      if (grow) {
        remotes(GROWN, "310000000000000000");
        follows("310000000000000000", OTHER, "pending");
        follows("310000000000000000", VIEWER, "accepted");
      }
      const plans: PlannedStatement[] = [];
      const activity: InboundActivity = {
        type: "Undo",
        id: `${BOB_URI}#undo`,
        object: { id: `${BOB_URI}#accept`, type: "Accept", actor: BOB_URI, object: FOLLOW },
      };
      const result = receiveActivity.run(
        plannedSql(db, /./, plans),
        { now: NOW, storeNow: NOW, origin: LOCAL, actorUri: BOB_URI, actor: null, actorRevision: null, activity },
        (fn) => state.storage.transactionSync(fn),
      );
      const count = db.exec<{ n: number }>("SELECT following_count AS n FROM accounts WHERE id = ?", VIEWER).one().n;
      return { result, count, plans };
    });
  }

  it("reads the same rows, with no Bloom filter and no scan of follows", async () => {
    const few = await measured(false);
    const many = await measured(true);
    expect([few.result, many.result]).toEqual([
      expect.objectContaining({ reason: "follow-unaccepted" }),
      expect.objectContaining({ reason: "follow-unaccepted" }),
    ]);
    expect([few.count, many.count]).toEqual([0, 0]);
    expect(many.plans.map((p) => [p.query, p.rows])).toEqual(few.plans.map((p) => [p.query, p.rows]));
    for (const { query, plan } of many.plans) {
      expect([query, plan.filter((d) => /BLOOM FILTER ON (f|follows)\b/.test(d))]).toEqual([query, []]);
      expect([query, scansOf(plan, ["f", "follows"])]).toEqual([query, []]);
    }
  }, 60_000);
});

// The inbox's paths to the handler, LD-signed or not. Mastodon's compaction reads an Accept's object as given, and
// undo_accept raises on an array (value_or_id); Kopje refuses that reading (undoAsMastodon) and applies one naming the
// Follow by a single id.
describe("an Undo of an Accept through the inbox", () => {
  const ALICE = "111111111111111111";
  const ALICE_URI = `${LOCAL}/ap/users/alice`;
  const FOLLOW = `${ALICE_URI}#follows/1`;

  async function signedSetup() {
    const store = await migratedStore();
    await completeSetup(store);
    await seedLocalAccount(store, "kopje.test", { id: ALICE, username: "alice", key: LEGACY_EMPTY_KEK });
    const web = new RemoteWeb();
    const counting = countingStore(store);
    const federation = { keygen: fixtureKeyGen, loader: web.loader };
    const h = harness(counting.stub, {}, BUILD, federation);
    const bob = await mastodonActor(web, "bob");
    const reasonOf = () =>
      (counting.records.findLast((record) => record.name === "receiveActivity")?.answer as ReceiveResult | undefined)
        ?.reason;
    // bob is stored by a first delivery; alice's follow of bob is accepted under FOLLOW.
    const send = async (body: unknown, signer: SignOptions = {}) => {
      counting.records.length = 0;
      const status = (await h.request("/inbox", await signedInit(bob, "/inbox", body, signer))).status;
      return { status, reason: reasonOf() };
    };
    expect(
      await send({ "@context": AS, id: `${bob.uri}/follows/9`, type: "Follow", actor: bob.uri, object: ALICE_URI }),
    ).toMatchObject({ status: 202 });
    await sql(
      store,
      `INSERT INTO follows (account_id, target_account_id, state, uri)
				SELECT ?, id, 'accepted', ? FROM accounts WHERE uri = ?`,
      ALICE,
      FOLLOW,
      bob.uri,
    );
    const state = async () =>
      (await sql<{ state: string }>(store, "SELECT state FROM follows WHERE account_id = ?", ALICE))[0]?.state;
    return { store, web, counting, federation, bob, send, reasonOf, state };
  }

  const plain = (bob: { uri: string }, object: unknown) => ({
    "@context": AS,
    id: `${bob.uri}/activities/${++sequence}`,
    type: "Undo",
    actor: bob.uri,
    object: { id: `${bob.uri}/accepts/1`, type: "Accept", actor: bob.uri, object },
  });

  const signed = (bob: { uri: string }, object: unknown, extra: Json = {}) => ({
    "@context": [AS, "https://w3id.org/security/v1"],
    id: `${bob.uri}/activities/${++sequence}`,
    type: "Undo",
    actor: bob.uri,
    object: { id: `${bob.uri}/accepts/1`, type: "Accept", actor: bob.uri, object },
    signature: {
      type: "RsaSignature2017",
      creator: `${bob.uri}#main-key`,
      created: "2026-11-18T12:00:00Z",
      signatureValue: "placeholder-signature-value",
    },
    ...extra,
  });

  it("read as the compaction: an array object is refused, a single id turns the follow back", async () => {
    const t = await signedSetup();
    expect(await t.send(signed(t.bob, [FOLLOW, `${FOLLOW}-other`]))).toEqual({ status: 202, reason: undefined });
    expect(await t.state()).toBe("accepted");
    expect(await t.send(signed(t.bob, FOLLOW))).toEqual({ status: 202, reason: "follow-unaccepted" });
    expect(await t.state()).toBe("pending");
  });

  it("read as received past Mastodon's 1,000 values: an array object names no Follow", async () => {
    const t = await signedSetup();
    const padding = { padding: Array.from({ length: 1_000 }, () => "x") };
    expect(await t.send(signed(t.bob, [FOLLOW, `${FOLLOW}-other`], padding))).toEqual({
      status: 202,
      reason: "unknown-follow",
    });
    expect(await t.state()).toBe("accepted");
  });

  // A context Mastodon's compaction is not shown for (one past AS and security/v1): the body is read as named, the
  // array as it is, which names no Follow.
  it("read as named: an array object names no Follow, a single id turns the follow back", async () => {
    const t = await signedSetup();
    const context = { "@context": [AS, "https://w3id.org/security/v1", "https://w3id.org/security/data-integrity/v1"] };
    expect(await t.send(signed(t.bob, [FOLLOW, `${FOLLOW}-other`], context))).toEqual({
      status: 202,
      reason: "unknown-follow",
    });
    expect(await t.state()).toBe("accepted");
    expect(await t.send(signed(t.bob, FOLLOW, context))).toEqual({ status: 202, reason: "follow-unaccepted" });
    expect(await t.state()).toBe("pending");
  });

  it("a signed POST without a Linked Data signature turns the follow back", async () => {
    const t = await signedSetup();
    expect(await t.send(plain(t.bob, FOLLOW))).toEqual({ status: 202, reason: "follow-unaccepted" });
    expect(await t.state()).toBe("pending");
  });

  it("spooled during maintenance and replayed, it turns the follow back", async () => {
    const t = await signedSetup();
    const maintenance = harness(t.counting.stub, { MAINTENANCE: "readonly" }, BUILD, t.federation);
    const response = await maintenance.request("/inbox", await signedInit(t.bob, "/inbox", plain(t.bob, FOLLOW)));
    expect(response.status).toBe(202);
    expect(await t.state()).toBe("accepted");
    t.counting.records.length = 0;
    const deps = inboxDeps(() => t.counting.stub, t.web.loader);
    await maintenance.queue.deliver((batch) =>
      handleQueue(batch, { ...maintenance.env, MAINTENANCE: "off" } as Env, deps),
    );
    expect(maintenance.queue.pending).toEqual([]);
    expect(t.reasonOf()).toBe("follow-unaccepted");
    expect(await t.state()).toBe("pending");
  });

  // Signed by carol's key in bob's name, it is a relay, which only a Delete passes (ID-1): dropped before the Store.
  it("relayed by another actor, it is dropped and the follow stays", async () => {
    const t = await signedSetup();
    const carol = await mastodonActor(t.web, "carol", { key: 2 });
    expect(
      await loggedRefusals(async () => {
        const answer = await t.send(plain(t.bob, FOLLOW), { keyId: carol.keyId, privateKey: carol.privateKey });
        expect(answer.reason).toBeUndefined();
        return answer.status;
      }),
    ).toEqual({ status: 202, refused: [[{ event: "kopje.inbox.refused", status: 202, reason: "relay-not-applied" }]] });
    expect(await t.state()).toBe("accepted");
  });

  // The Store applies an activity in one transaction: one that fails part way (the inbox's 503) leaves the follow as
  // it was, and the sender's redelivery applies it whole.
  it("failing part way changes nothing, and the redelivery turns the follow back", async () => {
    const t = await signedSetup();
    const activity: InboundActivity = {
      type: "Undo",
      id: `${t.bob.uri}#undo`,
      object: { id: `${t.bob.uri}/accepts/1`, type: "Accept", actor: t.bob.uri, object: FOLLOW },
    };
    const input = {
      now: NOW,
      storeNow: NOW,
      origin: LOCAL,
      actorUri: t.bob.uri,
      actor: null,
      actorRevision: null,
      activity,
    };
    const failing = await runInDurableObject(t.store, (_instance, state) => {
      const real = state.storage.sql;
      const failingSql = {
        exec: (query: string, ...params: SqlStorageValue[]) => {
          if (query.includes("DELETE FROM account_pins")) {
            throw new Error("storage failed");
          }
          return real.exec(query, ...params);
        },
      } as unknown as SqlStorage;
      try {
        // One Store transaction, as the Store runs a write operation (plannedRun's `transaction`).
        state.storage.transactionSync(() =>
          receiveActivity.run(failingSql, input, (fn) => state.storage.transactionSync(fn)),
        );
        return "applied";
      } catch {
        return "failed";
      }
    });
    expect(failing).toBe("failed");
    expect(await t.state()).toBe("accepted");
    expect(await t.send(plain(t.bob, FOLLOW))).toEqual({ status: 202, reason: "follow-unaccepted" });
    expect(await t.state()).toBe("pending");
  });
});
