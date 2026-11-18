import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { FOLLOW_ANSWER_INTENTS, HANDSHAKE_RECHECK_MS } from "../src/domain/deliveries";
import { type InboundActivity, type ReceiveResult, receiveActivity } from "../src/domain/inbox";
import { MAX_RETRACTIONS_PER_ACTOR } from "../src/domain/retractions";
import { parseActivity } from "../src/federation/inbound";
import { handleQueue } from "../src/jobs/queue";
import { ACTIVITY_ID_LIMIT } from "../src/platform/identity-bounds";
import type { StoreStub } from "../src/platform/store-client";
import { bearer, json, sql } from "./api-helpers";
import { countingStore, harness, inboxDeps, NOW } from "./app-helpers";
import { fixtureKeyGen, LEGACY_EMPTY_KEK, seedLocalAccount } from "./federation-helpers";
import formsFixture from "./fixtures/ld-signed/forms.json";
import { BUILD, claimAndSettle, completeSetup, drainDeliveries, migratedStore } from "./helpers";
import { LOCAL, mastodonActor, RemoteWeb, signedInit, type TestActor } from "./inbox-helpers";
import { storeReceive } from "./inbox-store-helpers";
import { longestString, observedSql } from "./read-helpers";
import { act, receive, uriOf, world } from "./remote-suspension-helpers";
import { post, remoteAccount, remoteFollows, seedStatus } from "./status-helpers";

// #1773, ID-6: an Undo ends what its undone activity names as Mastodon's Undo does (undo.rb): a Follow or a Block named
// by its type, the sender's edge to the local account its object names, whatever id the edge carries; a Like named
// by its type, only the sender's favourite of the status its object names; an undone activity without a type, what
// its id names; and nothing, with nothing recorded, where the object is no single IRI of such an account or status or
// the type is no single name Kopje undoes. ID-7: a live retraction of the undone id still keeps it from the current
// generation, and the answers of both generations go (NET-2).

const AS = "https://www.w3.org/ns/activitystreams";
const PUBLIC = `${AS}#Public`;
const REMOTE = "https://remote.example";
const LATER = NOW + 24 * 60 * 60 * 1000;

type Json = Record<string, unknown>;

// alice and dan (local); r and c (remote.example), and s, alice's follower there, which r's lane is shared with.
async function setup(options: { locked?: boolean } = {}) {
  const w = await world();
  const store = w.h.store;
  const r = await remoteAccount(store, "r");
  const c = await remoteAccount(store, "c");
  const s = await remoteAccount(store, "s");
  await remoteFollows(store, s, w.alice.id);
  if (options.locked === true) {
    await sql(store, "UPDATE accounts SET locked = 1 WHERE id = ?", w.alice.id);
  }
  return {
    w,
    store,
    r,
    c,
    rUri: await uriOf(store, r),
    cUri: await uriOf(store, c),
    aliceUri: await uriOf(store, w.alice.id),
    danUri: await uriOf(store, w.dan.id),
  };
}

type T = Awaited<ReturnType<typeof setup>>;

let sequence = 0;
const followId = () => `${REMOTE}/follows/${++sequence}`;
const blockId = () => `${REMOTE}/blocks/${++sequence}`;
const likeId = () => `${REMOTE}/likes/${++sequence}`;

// The body as the inbox reads it (parseActivity: refOf, the shapes this issue is about), then the Store's receive.
async function deliver(store: StoreStub, actorUri: string, body: Json, now = NOW): Promise<ReceiveResult> {
  const read = await parseActivity(new TextEncoder().encode(JSON.stringify(body)));
  if (!read.ok) {
    throw new Error(`refused at the inbox: ${read.reason}`);
  }
  return storeReceive(store, actorUri, read.activity as InboundActivity, now);
}

// actorUri's Undo of `undone`, embedded as given.
function undoBody(actorUri: string, undone: unknown): Json {
  return { "@context": AS, id: `${actorUri}#undo-${++sequence}`, type: "Undo", actor: actorUri, object: undone };
}

// An undone activity of `type` with the id `id` naming `object`; `object` undefined leaves the member out.
function undone(actorUri: string, id: string, type: unknown, object?: unknown): Json {
  return { id, type, actor: actorUri, ...(object === undefined ? {} : { object }) };
}

const undo = (t: T, id: string, type: unknown, object: unknown, actorUri = t.rUri, now = NOW) =>
  deliver(t.store, actorUri, undoBody(actorUri, undone(actorUri, id, type, object)), now);

async function followFrom(t: T, id = followId(), actorUri = t.rUri, object = t.aliceUri) {
  const result = await receive(t.store, actorUri, { id, type: "Follow", object });
  return { id, result };
}

async function blockFrom(t: T, id = blockId(), actorUri = t.rUri) {
  expect(await receive(t.store, actorUri, { id, type: "Block", object: t.aliceUri })).toMatchObject({
    applied: true,
    reason: "blocked",
  });
  return id;
}

async function api(t: T, path: string) {
  const response = await t.w.h.request(path, bearer(t.w.alice.token, json({})));
  expect(response.status, path).toBe(200);
}

let lease = 0;

// A public post of alice's.
async function alicePost(t: T, text: string): Promise<{ id: string; uri: string }> {
  const status = await post(t.w.h, t.w.alice, { status: text, visibility: "public" });
  return { id: status.id, uri: status.uri as string };
}

// A claim took alice's lane head to remote.example and it failed, so every row behind it waits queued.
async function outage(t: T): Promise<void> {
  await post(t.w.h, t.w.alice, { status: "head" });
  const { sent } = await claimAndSettle(t.store, {
    now: NOW,
    leaseToken: `once-${++lease}`,
    outcome: { kind: "failed", status: 503, error: "HTTP 503", permanent: false },
  });
  expect(sent.map(({ body }) => (JSON.parse(body) as { type: string }).type)).toEqual(["Create"]);
}

// Fills r's retractions to one place short of the cap (fillers of its origin, expiring at LATER).
const oneSlotLeft = (t: T) =>
  sql(
    t.store,
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
		INSERT INTO inbound_retractions (actor_uri, target_uri, expires_at) SELECT ?, ? || '/filler/' || i, ? FROM n`,
    MAX_RETRACTIONS_PER_ACTOR - 1,
    t.rUri,
    t.rUri,
    LATER,
  );

// The answers delivered once everything due by LATER goes, in lane order, each as [type, the Follow id it names].
async function answersSent(t: T): Promise<[string, string | null][]> {
  const sent = await drainDeliveries(
    t.store,
    (row): [string, string | null] => {
      const body = JSON.parse(row.body) as { type: string; object: unknown };
      const object = typeof body.object === "string" ? body.object : (body.object as { id?: string }).id;
      return [body.type, object ?? null];
    },
    { now: LATER, until: "due", rounds: 1_000 },
  );
  return sent.filter(([type]) => type === "Accept" || type === "Reject");
}

// The actor's recorded retractions, the cap's fillers left out, sorted.
const retractions = async (t: T, actorUri = t.rUri) =>
  (
    await sql<{ target_uri: string }>(
      t.store,
      "SELECT target_uri FROM inbound_retractions WHERE actor_uri = ? AND target_uri NOT LIKE '%/filler/%'",
      actorUri,
    )
  )
    .map((row) => row.target_uri)
    .toSorted();

// Everything an Undo may change: the edges both ways, favourites, boosts and the counts they keep, retractions and
// their expiry, answers and their rows and chunks, held Rejects and notifications.
async function snapshot(store: StoreStub) {
  const tables = [
    "SELECT account_id, target_account_id, state, uri FROM follows",
    "SELECT account_id, target_account_id, uri FROM blocks",
    "SELECT id, followers_count, following_count FROM accounts",
    "SELECT account_id, status_id, uri FROM favourites",
    "SELECT favourite_id, uri FROM favourite_likes",
    "SELECT id, uri, reblogs_count, favourites_count FROM statuses",
    "SELECT actor_uri, target_uri, expires_at FROM inbound_retractions",
    "SELECT id, body, superseded FROM outbound_activities",
    "SELECT activity_id, state FROM deliveries",
    "SELECT activity_id FROM outbound_targets",
    "SELECT account_id, follower_id, follow_uri, edge_id FROM reject_replays",
    "SELECT account_id, type, from_account_id, status_id FROM notifications",
  ];
  return Promise.all(
    tables.map(async (query) => (await sql(store, query)).map((row) => JSON.stringify(row)).toSorted()),
  );
}

const follows = (t: T) =>
  sql<{ state: string; uri: string | null }>(
    t.store,
    "SELECT state, uri FROM follows WHERE account_id = ? AND target_account_id = ?",
    t.r,
    t.w.alice.id,
  );
const blocks = (t: T, from = t.r) =>
  sql<{ uri: string | null }>(
    t.store,
    "SELECT uri FROM blocks WHERE account_id = ? AND target_account_id = ?",
    from,
    t.w.alice.id,
  );

// The objects a typed Undo of a Follow or a Block names that are no single IRI of a local account.
const NOT_A_LOCAL_ACCOUNT: [string, (t: T) => unknown][] = [
  ["an array of alice", (t) => [t.aliceUri]],
  ["null", () => null],
  ["missing", () => undefined],
  ["an object whose id is a number", () => ({ id: 5 })],
  ["true", () => true],
  ["a URN", () => "urn:x:alice"],
  ["a remote account", (t) => t.cUri],
  ["a local IRI of no account", () => `${LOCAL}/ap/users/nobody`],
];

describe("ID-6: an Undo ends what its undone activity's object names", () => {
  it.each(NOT_A_LOCAL_ACCOUNT)(
    "a typed Undo of a Follow whose object is %s ends nothing and records nothing",
    async (_, object) => {
      const t = await setup();
      const { id } = await followFrom(t);
      expect(await follows(t)).toEqual([{ state: "accepted", uri: id }]);
      const before = await snapshot(t.store);
      expect(await undo(t, id, "Follow", object(t))).toMatchObject({ applied: false, reason: "unknown-target" });
      expect(await snapshot(t.store)).toEqual(before);
    },
  );

  it("a typed Undo of a Follow naming alice by her IRI ends the follow and its Accept", async () => {
    const t = await setup();
    const { id } = await followFrom(t);
    expect(await undo(t, id, "Follow", t.aliceUri)).toMatchObject({ applied: true, reason: "undone" });
    expect(await follows(t)).toEqual([]);
    expect(await retractions(t)).toEqual([id]);
    expect(await answersSent(t)).toEqual([]);
  });

  it.each(NOT_A_LOCAL_ACCOUNT)(
    "a typed Undo of a Block whose object is %s ends nothing and records nothing",
    async (_, object) => {
      const t = await setup();
      const id = await blockFrom(t);
      const before = await snapshot(t.store);
      expect(await undo(t, id, "Block", object(t))).toMatchObject({ applied: false, reason: "unknown-target" });
      expect(await snapshot(t.store)).toEqual(before);
    },
  );

  it("a typed Undo of a Block naming alice by an object with her id ends the block", async () => {
    const t = await setup();
    const id = await blockFrom(t);
    expect(await undo(t, id, "Block", { id: t.aliceUri })).toMatchObject({ applied: true, reason: "undone" });
    expect(await blocks(t)).toEqual([]);
    expect(await retractions(t)).toEqual([id]);
  });

  // F5, B5: the edge from the sender to alice ends whatever its id, and both ids are recorded, so neither activity
  // applies again (ID-7).
  it("a typed Undo under another id ends the sender's follow or block of alice and records both ids", async () => {
    const t = await setup();
    const { id: f1 } = await followFrom(t);
    const other = followId();
    expect(await undo(t, other, "Follow", t.aliceUri)).toMatchObject({ applied: true, reason: "undone" });
    expect(await follows(t)).toEqual([]);
    expect(await retractions(t)).toEqual([other, f1].toSorted());
    for (const id of [f1, other]) {
      expect((await followFrom(t, id)).result).toMatchObject({ applied: false, reason: "retracted" });
    }
    const b1 = await blockFrom(t);
    const otherBlock = blockId();
    expect(await undo(t, otherBlock, "Block", t.aliceUri)).toMatchObject({ applied: true, reason: "undone" });
    expect(await blocks(t)).toEqual([]);
    expect(await retractions(t)).toEqual([other, f1, otherBlock, b1].toSorted());
    expect(await receive(t.store, t.rUri, { id: b1, type: "Block", object: t.aliceUri })).toMatchObject({
      applied: false,
      reason: "retracted",
    });
    expect(await blocks(t)).toEqual([]);
  });

  // F6: a typed Undo ends a follow stored without an id (a cutover's) by its pair. Its owner's answer names no Follow:
  // the Accept of that edge goes with it, unexpanded, queued or leased; a Reject of a request the owner refused, whose
  // edge is gone, stays (F6r, an accepted risk). B4: a block stored without an id ends too.
  describe("an edge stored without an id", () => {
    // r's pending request of alice, imported without a Follow id; its edge id.
    async function importedRequest(t: T): Promise<string> {
      await sql(
        t.store,
        "INSERT INTO follows (account_id, target_account_id, state, uri) VALUES (?, ?, 'pending', NULL)",
        t.r,
        t.w.alice.id,
      );
      return (
        await sql<{ id: string }>(
          t.store,
          "SELECT CAST(id AS TEXT) AS id FROM follows WHERE account_id = ? AND target_account_id = ?",
          t.r,
          t.w.alice.id,
        )
      )[0]!.id;
    }

    const lane = (t: T) =>
      sql<{ type: string; id: string; object: string | null; state: string | null }>(
        t.store,
        `SELECT json_extract(o.body, '$.activity.type') AS type, json_extract(o.body, '$.activity.id') AS id,
					json_extract(o.body, '$.activity.object.id') AS object,
					(SELECT d.state FROM deliveries d WHERE d.activity_id = o.id) AS state
				FROM outbound_activities o WHERE o.follow_pair = ? ORDER BY o.id`,
        t.r,
      );

    it("authorized, its Accept queued: the follow and its Accept end", async () => {
      const t = await setup({ locked: true });
      await outage(t);
      const edge = await importedRequest(t);
      await api(t, `/api/v1/follow_requests/${t.r}/authorize`);
      expect(await lane(t)).toEqual([
        { type: "Accept", id: `${t.aliceUri}#accepts/follows/${edge}`, object: null, state: "queued" },
      ]);
      const f1 = followId();
      expect(await undo(t, f1, "Follow", t.aliceUri)).toMatchObject({ applied: true, reason: "undone" });
      expect(await follows(t)).toEqual([]);
      expect(await lane(t)).toEqual([]);
      expect(await retractions(t)).toEqual([f1]);
      expect(await answersSent(t)).toEqual([]);
    });

    it("authorized, its Accept leased: the confirmation drops it", async () => {
      const t = await setup({ locked: true });
      await importedRequest(t);
      await api(t, `/api/v1/follow_requests/${t.r}/authorize`);
      const token = `held-${++lease}`;
      const claim = await t.store.claimDeliveries(BUILD, { now: NOW, leaseToken: token });
      const accept = claim.deliveries.find((d) => d.inbox === `${REMOTE}/inbox`);
      expect(accept).toBeDefined();
      expect(await undo(t, followId(), "Follow", t.aliceUri)).toMatchObject({ applied: true, reason: "undone" });
      expect(await t.store.confirmDelivery(BUILD, { id: accept!.id, leaseToken: token, now: NOW })).toMatchObject({
        status: "dropped",
      });
      expect(await answersSent(t)).toEqual([]);
    });

    // 199 followers on lanes of their own and s: alice's Create has two chunks; the Accept recorded after it waits
    // unexpanded, as the Create's second chunk uses up the expansion budget.
    it("authorized, its Accept unexpanded: the chunk goes, and no later expansion sends it", async () => {
      const t = await setup({ locked: true });
      await sql(
        t.store,
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 199)
				INSERT INTO accounts (id, uri, username, domain, inbox_url, shared_inbox_url)
				SELECT printf('%018d', 900000000000000000 + i), 'https://d' || printf('%03d', i) || '.example/u', 'u',
					'd' || printf('%03d', i) || '.example', 'https://d' || printf('%03d', i) || '.example/u/inbox',
					'https://d' || printf('%03d', i) || '.example/inbox'
				FROM n`,
      );
      await sql(
        t.store,
        `INSERT INTO follows (account_id, target_account_id, state)
				SELECT id, ?, 'accepted' FROM accounts WHERE domain GLOB 'd[0-9][0-9][0-9].example'`,
        t.w.alice.id,
      );
      await post(t.w.h, t.w.alice, { status: "wide" });
      await importedRequest(t);
      await api(t, `/api/v1/follow_requests/${t.r}/authorize`);
      const chunked = () =>
        sql<{ type: string }>(
          t.store,
          `SELECT json_extract(o.body, '$.activity.type') AS type FROM outbound_targets c
					JOIN outbound_activities o ON o.id = c.activity_id ORDER BY c.id`,
        );
      expect(await chunked()).toEqual([{ type: "Accept" }]);
      expect(await undo(t, followId(), "Follow", t.aliceUri)).toMatchObject({ applied: true, reason: "undone" });
      expect(await chunked()).toEqual([]);
      expect(await answersSent(t)).toEqual([]);
    });

    it("rejected, its Reject queued: the Reject stays, and the Undo's id is recorded", async () => {
      const t = await setup({ locked: true });
      await outage(t);
      await importedRequest(t);
      await api(t, `/api/v1/follow_requests/${t.r}/reject`);
      expect(await follows(t)).toEqual([]);
      const f1 = followId();
      expect(await undo(t, f1, "Follow", t.aliceUri)).toMatchObject({ applied: true, reason: "retraction-recorded" });
      expect(await retractions(t)).toEqual([f1]);
      expect(await answersSent(t)).toEqual([["Reject", null]]);
    });

    it("rejected, its Reject held: the hold stays", async () => {
      const t = await setup({ locked: true });
      const edge = await importedRequest(t);
      await api(t, `/api/v1/follow_requests/${t.r}/reject`);
      expect(await act(t.w, t.r, { type: "suspend" })).toMatchObject({ status: 200 });
      expect(await answersSent(t)).toEqual([]);
      const holds = () =>
        sql<{ follow_uri: string | null; edge_id: string | null }>(
          t.store,
          "SELECT follow_uri, CAST(edge_id AS TEXT) AS edge_id FROM reject_replays WHERE follower_id = ?",
          t.r,
        );
      expect(await holds()).toEqual([{ follow_uri: null, edge_id: edge }]);
      expect(await undo(t, followId(), "Follow", t.aliceUri)).toMatchObject({
        applied: true,
        reason: "retraction-recorded",
      });
      expect(await holds()).toEqual([{ follow_uri: null, edge_id: edge }]);
    });

    it("a block stored without an id ends", async () => {
      const t = await setup();
      await sql(
        t.store,
        "INSERT INTO blocks (account_id, target_account_id, uri) VALUES (?, ?, NULL)",
        t.r,
        t.w.alice.id,
      );
      const b1 = blockId();
      expect(await undo(t, b1, "Block", t.aliceUri)).toMatchObject({ applied: true, reason: "undone" });
      expect(await blocks(t)).toEqual([]);
      expect(await retractions(t)).toEqual([b1]);
    });
  });

  // AC5 on what an import stores (engineering.md, "Imported TEXT"): the ended edge's uri may be malformed UTF-8 or of
  // any length, so the Store classifies it only within ACTIVITY_ID_LIMIT bytes and copies its retraction from the row,
  // byte for byte; and a Reject the import held beside the follow (its triggers do not run then,
  // test/import-triggers.test.ts) goes with it.
  describe("an edge an import stored", () => {
    const EDGES: ["Follow" | "Block", "follows" | "blocks"][] = [
      ["Follow", "follows"],
      ["Block", "blocks"],
    ];
    // r's edge to alice in `table`, its uri the SQL expression `uri`.
    const imported = (t: T, table: "follows" | "blocks", uri: string) =>
      sql(
        t.store,
        table === "follows"
          ? `INSERT INTO follows (account_id, target_account_id, state, uri) VALUES (?, ?, 'accepted', ${uri})`
          : `INSERT INTO blocks (account_id, target_account_id, uri) VALUES (?, ?, ${uri})`,
        t.r,
        t.w.alice.id,
      );
    const hexOf = (text: string) =>
      [...new TextEncoder().encode(text)].map((byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join("");

    it.each(EDGES)("preserves the ended URI's bytes: a typed Undo of a %s", async (type, table) => {
      const t = await setup();
      await imported(t, table, `'${REMOTE}/edges/malformed' || CAST(X'80' AS TEXT)`);
      const [stored] = await sql<{ hex: string }>(
        t.store,
        `SELECT hex(uri) AS hex FROM ${table} WHERE account_id = ?`,
        t.r,
      );
      expect(stored!.hex).toBe(`${hexOf(`${REMOTE}/edges/malformed`)}80`);
      const other = type === "Follow" ? followId() : blockId();
      expect(await undo(t, other, type, t.aliceUri)).toMatchObject({ applied: true, reason: "undone" });
      expect(await sql(t.store, `SELECT 1 FROM ${table} WHERE account_id = ?`, t.r)).toEqual([]);
      const recorded = await sql<{ hex: string }>(
        t.store,
        "SELECT hex(target_uri) AS hex FROM inbound_retractions WHERE actor_uri = ?",
        t.rUri,
      );
      expect(recorded.map((row) => row.hex).toSorted()).toEqual([stored!.hex, hexOf(other)].toSorted());
    });

    // A uri of over 256 KiB: the Undo ends the edge, records only its own id, and reads no value of the uri's size.
    it.each(EDGES)("ends an edge whose uri is far past the bound, reading none of it: a %s", async (type, table) => {
      const t = await setup();
      const long = `'${REMOTE}/edges/' || replace(hex(zeroblob(150000)), '0', 'a')`;
      await imported(t, table, long);
      const other = type === "Follow" ? followId() : blockId();
      const read = await parseActivity(
        new TextEncoder().encode(JSON.stringify(undoBody(t.rUri, undone(t.rUri, other, type, t.aliceUri)))),
      );
      expect(read.ok).toBe(true);
      const activity = (read as { activity: InboundActivity }).activity;
      const { result, longest } = await runInDurableObject(t.store, (_instance, state) => {
        let most = 0;
        const observed = observedSql(state.storage.sql, (rows) => {
          most = Math.max(most, longestString(rows));
        });
        const answer = receiveActivity.run(
          observed,
          { now: NOW, storeNow: NOW, origin: LOCAL, actorUri: t.rUri, actor: null, actorRevision: null, activity },
          (fn) => state.storage.transactionSync(fn),
        );
        return { result: answer, longest: most };
      });
      expect(result).toMatchObject({ applied: true, reason: "undone" });
      expect(longest).toBeLessThanOrEqual(ACTIVITY_ID_LIMIT);
      expect(await sql(t.store, `SELECT 1 FROM ${table} WHERE account_id = ?`, t.r)).toEqual([]);
      expect(await retractions(t)).toEqual([other]);
    });

    // An edge uri of `bytes` bytes, of r's origin through its userinfo, or a Misskey pair id by its path.
    const userinfo = (bytes: number) => {
      const [head, tail] = ["https://user:", "@remote.example/edges/1"];
      return `${head}${"a".repeat(bytes - head.length - tail.length)}${tail}`;
    };
    const pairShaped = (bytes: number) => {
      const head = `${REMOTE}/follows/r/alice?`;
      return `${head}${"a".repeat(bytes - head.length)}`;
    };
    // The edge's uri is classified whole within ACTIVITY_ID_LIMIT bytes: of r's origin it is recorded, so it applies no
    // more; a pair id is not. Past the bound nothing is recorded for it, so it applies again, and the Undo needs only
    // its own id's place under the cap (docs/threat-model.md, accepted risks).
    it.each([
      ["Follow", "of r's origin by its userinfo", ACTIVITY_ID_LIMIT, true, "follows", userinfo],
      ["Block", "of r's origin by its userinfo", ACTIVITY_ID_LIMIT, true, "blocks", userinfo],
      ["Follow", "of r's origin by its userinfo", ACTIVITY_ID_LIMIT + 1, false, "follows", userinfo],
      ["Block", "of r's origin by its userinfo", ACTIVITY_ID_LIMIT + 1, false, "blocks", userinfo],
      ["Follow", "shaped as a pair id by its path", ACTIVITY_ID_LIMIT, false, "follows", pairShaped],
      ["Follow", "shaped as a pair id by its path", ACTIVITY_ID_LIMIT + 1, false, "follows", pairShaped],
    ] as const)("a %s's uri %s of %i bytes is recorded: %s", async (type, _, bytes, recorded, table, shaped) => {
      const t = await setup();
      const uri = shaped(bytes);
      expect(new TextEncoder().encode(uri).length).toBe(bytes);
      await imported(t, table, `'${uri}'`);
      if (!recorded) {
        await oneSlotLeft(t);
      }
      const other = type === "Follow" ? followId() : blockId();
      expect(await undo(t, other, type, t.aliceUri)).toMatchObject({ applied: true, reason: "undone" });
      expect(await sql(t.store, `SELECT 1 FROM ${table} WHERE account_id = ?`, t.r)).toEqual([]);
      expect(await retractions(t)).toEqual((recorded ? [other, uri] : [other]).toSorted());
      expect(await receive(t.store, t.rUri, { id: uri, type, object: t.aliceUri })).toMatchObject(
        recorded ? { applied: false, reason: "retracted" } : { applied: true },
      );
    });

    // The bound is on the stored bytes, not on characters: an edge uri (an SQL expression) of r's origin, `bytes` bytes
    // long, filled with two-byte or four-byte characters, or ending in malformed bytes (0x80, which SQLite's length()
    // does not count as a character), is recorded at ACTIVITY_ID_LIMIT bytes, as its stored bytes, and not past it.
    const PREFIX = `${REMOTE}/edges/`;
    const filled = (unit: string, unitBytes: number) => (bytes: number) => {
      const count = Math.floor((bytes - PREFIX.length) / unitBytes);
      return `'${PREFIX}${"a".repeat(bytes - PREFIX.length - count * unitBytes)}${unit.repeat(count)}'`;
    };
    const malformed = (bytes: number) =>
      `'${PREFIX}${"a".repeat(bytes - PREFIX.length - 100)}' || CAST(X'${"80".repeat(100)}' AS TEXT)`;
    const FILLS: [string, (bytes: number) => string][] = [
      ["two-byte characters", filled("é", 2)],
      ["four-byte characters", filled("😀", 4)],
      ["malformed bytes", malformed],
    ];
    it.each(
      FILLS.flatMap(([label, uri]): [string, number, boolean, (bytes: number) => string][] => [
        [label, ACTIVITY_ID_LIMIT, true, uri],
        [label, ACTIVITY_ID_LIMIT + 1, false, uri],
      ]),
    )("a Follow's uri of %s, %i bytes stored, is recorded: %s", async (_, bytes, recorded, uri) => {
      const t = await setup();
      await imported(t, "follows", uri(bytes));
      expect(
        await sql(
          t.store,
          `SELECT length(CAST(uri AS BLOB)) AS bytes, length(uri) < length(CAST(uri AS BLOB)) AS fewer FROM follows
					WHERE account_id = ?`,
          t.r,
        ),
      ).toEqual([{ bytes, fewer: 1 }]);
      const other = followId();
      expect(await undo(t, other, "Follow", t.aliceUri)).toMatchObject({ applied: true, reason: "undone" });
      expect(await follows(t)).toEqual([]);
      expect(
        await sql(
          t.store,
          `SELECT count(*) AS n FROM inbound_retractions WHERE actor_uri = ? AND target_uri = ${uri(bytes)}`,
          t.rUri,
        ),
      ).toEqual([{ n: recorded ? 1 : 0 }]);
      expect(await retractions(t)).toHaveLength(recorded ? 2 : 1);
    });

    // r's accepted follow F1 and the pair's hold naming it, which only an import leaves together: a typed Undo under
    // another id ends the follow, and the hold with it, so no replay sends a Reject of F1.
    it("cancels the hold naming the ended edge", async () => {
      const t = await setup();
      const { id: f1, result } = await followFrom(t);
      expect(result).toMatchObject({ reason: "followed" });
      await sql(
        t.store,
        "INSERT INTO reject_replays (account_id, follower_id, follow_uri, check_at) VALUES (?, ?, ?, ?)",
        t.w.alice.id,
        t.r,
        f1,
        NOW,
      );
      expect(await undo(t, followId(), "Follow", t.aliceUri)).toMatchObject({ applied: true, reason: "undone" });
      expect(await sql(t.store, "SELECT follow_uri FROM reject_replays WHERE follower_id = ?", t.r)).toEqual([]);
      await t.store.runHandshakeReplays(BUILD, { now: NOW + HANDSHAKE_RECHECK_MS });
      expect(await answersSent(t)).toEqual([]);
    });
  });

  // F7: a live retraction of the undone id keeps the current generation (ID-7), and the answers naming the id go.
  it("a typed Undo of a retracted id keeps the newer request and cancels the Reject of the id", async () => {
    const t = await setup({ locked: true });
    await outage(t);
    const { id: g } = await followFrom(t);
    await api(t, `/api/v1/follow_requests/${t.r}/reject`);
    const { id: k, result } = await followFrom(t);
    expect(result).toMatchObject({ reason: "follow-requested" });
    expect(await undo(t, g, "Follow", t.aliceUri)).toMatchObject({ applied: false, reason: "retracted" });
    expect(await follows(t)).toEqual([{ state: "pending", uri: k }]);
    expect(await answersSent(t)).toEqual([]);
  });

  // F7e: the retraction is live while expires_at > now (isRetracted); at expires_at the Undo ends the follow by the
  // pair.
  it.each([
    [-1, "retracted"],
    [0, "undone"],
  ])("an Undo at %i ms from its id's retraction expiry: %s", async (offset, reason) => {
    const t = await setup();
    await followFrom(t);
    const g = followId();
    const expiresAt = NOW + 60_000;
    await sql(
      t.store,
      "INSERT INTO inbound_retractions (actor_uri, target_uri, expires_at) VALUES (?, ?, ?)",
      t.rUri,
      g,
      expiresAt,
    );
    expect(await undo(t, g, "Follow", t.aliceUri, t.rUri, expiresAt + offset)).toMatchObject({ reason });
    expect(await follows(t)).toHaveLength(reason === "undone" ? 0 : 1);
  });

  // AC5: the answers of both generations go: the Reject naming the undone id (its retraction expired) and the Accept of
  // the ended edge.
  it("cancels the answers naming the undone id and those of the ended edge", async () => {
    const t = await setup({ locked: true });
    await outage(t);
    const { id: g } = await followFrom(t);
    await api(t, `/api/v1/follow_requests/${t.r}/reject`);
    await sql(t.store, "UPDATE inbound_retractions SET expires_at = ? WHERE target_uri = ?", NOW, g);
    await sql(t.store, "UPDATE accounts SET locked = 0 WHERE id = ?", t.w.alice.id);
    const { id: f1, result } = await followFrom(t);
    expect(result).toMatchObject({ reason: "followed" });
    expect(await undo(t, g, "Follow", t.aliceUri)).toMatchObject({ applied: true, reason: "undone" });
    expect(await retractions(t)).toEqual([g, f1].toSorted());
    expect(await answersSent(t)).toEqual([]);
  });

  it("changes nothing when the two ids cannot both be recorded", async () => {
    const t = await setup();
    await followFrom(t);
    await oneSlotLeft(t);
    const before = await snapshot(t.store);
    expect(await undo(t, followId(), "Follow", t.aliceUri)).toMatchObject({ applied: false, reason: "retraction-cap" });
    expect(await snapshot(t.store)).toEqual(before);
  });

  it("changes nothing, answered 503, when the pair's answers are over their bound", async () => {
    const t = await setup();
    await outage(t);
    await followFrom(t);
    await sql(
      t.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?3)
			INSERT INTO outbound_activities (id, account_id, body, object_uri, superseded, created_at, follow_pair)
			SELECT 1000 + i, ?1, '{"activity":{"type":"Reject"},"audience":{"followers":false,"accounts":[]}}',
				'https://remote.example/follows/earlier-' || i, 0, 0, ?2
			FROM n`,
      t.w.alice.id,
      t.r,
      FOLLOW_ANSWER_INTENTS,
    );
    const before = await snapshot(t.store);
    expect(await undo(t, followId(), "Follow", t.aliceUri)).toMatchObject({
      applied: false,
      reason: "follow-answer-backlog",
      retry: true,
    });
    expect(await snapshot(t.store)).toEqual(before);
  });

  // The Undo is judged before any retraction is read or answer cancelled: one naming no local account leaves the
  // Reject of its id (whose retraction is live) queued.
  it("judges the target before the retraction: a Reject of the undone id stays", async () => {
    const t = await setup({ locked: true });
    await outage(t);
    const { id: f1 } = await followFrom(t);
    await api(t, `/api/v1/follow_requests/${t.r}/reject`);
    expect(await undo(t, f1, "Follow", [t.aliceUri])).toMatchObject({ applied: false, reason: "unknown-target" });
    expect(await answersSent(t)).toEqual([["Reject", f1]]);
  });

  // AC3: a type given that is no single name, or a name Kopje does not undo, ends and records nothing, also where the
  // id names a favourite's tracked Like or a boost.
  it.each([
    ["an array of types", ["Block", "Ignore"]],
    ["an array of one type", ["Block"]],
    ["an empty array", []],
    ["a number", 5],
    ["an object", {}],
    ["a boolean", true],
    ["Reject", "Reject"],
    ["a blank node", "_:Block"],
    ["an absolute IRI, unsigned", `${AS}#Block`],
  ])("an undone type given as %s changes nothing", async (_, type) => {
    const t = await setup();
    const b1 = await blockFrom(t);
    const status = await alicePost(t, "liked");
    const like = likeId();
    expect(await receive(t.store, t.rUri, { id: like, type: "Like", object: status.uri })).toMatchObject({
      applied: true,
    });
    const boost = `${REMOTE}/boosts/${++sequence}`;
    expect(
      await deliver(t.store, t.rUri, {
        "@context": AS,
        id: boost,
        type: "Announce",
        actor: t.rUri,
        published: "2026-10-11T13:00:00Z",
        to: [PUBLIC],
        cc: [],
        object: status.uri,
      }),
    ).toMatchObject({ applied: true });
    const before = await snapshot(t.store);
    for (const id of [b1, like, boost]) {
      expect(await undo(t, id, type, t.aliceUri), id).toMatchObject({ applied: false, reason: "unsupported-undo" });
    }
    expect(await snapshot(t.store)).toEqual(before);
  });

  // AC4: an undone activity given without a type (none, or null) is sought by its id.
  it("an undone activity without a type ends what its id names", async () => {
    const t = await setup();
    const b1 = await blockFrom(t);
    expect(await deliver(t.store, t.rUri, undoBody(t.rUri, { id: b1, actor: t.rUri }))).toMatchObject({
      applied: true,
      reason: "undone",
    });
    const b2 = await blockFrom(t);
    expect(await undo(t, b2, null, t.aliceUri)).toMatchObject({ applied: true, reason: "undone" });
    expect(await blocks(t)).toEqual([]);
    const status = await alicePost(t, "liked");
    const like = likeId();
    await receive(t.store, t.rUri, { id: like, type: "Like", object: status.uri });
    expect(await deliver(t.store, t.rUri, undoBody(t.rUri, like))).toMatchObject({ applied: true, reason: "undone" });
    expect(await sql(t.store, "SELECT * FROM favourites WHERE account_id = ?", t.r)).toEqual([]);
  });
});

describe("ID-6: a typed Undo of a Like ends only the favourite of the status its object names", () => {
  async function liked(t: T) {
    const status = await alicePost(t, "liked");
    const other = await alicePost(t, "other");
    const remote = `${REMOTE}/notes/${++sequence}`;
    await seedStatus(t.store, { accountId: t.c, visibility: "public", uri: remote });
    return { status, other, remote };
  }

  const favourites = (t: T) =>
    sql<{ uri: string | null }>(t.store, "SELECT uri FROM favourites WHERE account_id = ?", t.r);

  it.each([
    ["an array of the status", (s: { uri: string }) => [s.uri]],
    ["null", () => null],
    ["missing", () => undefined],
    ["an object whose id is a number", () => ({ id: 5 })],
  ])("whose object is %s: nothing changes or is recorded", async (_, object) => {
    const t = await setup();
    const { status } = await liked(t);
    const like = likeId();
    await receive(t.store, t.rUri, { id: like, type: "Like", object: status.uri });
    const before = await snapshot(t.store);
    expect(await undo(t, like, "Like", object(status))).toMatchObject({ applied: false, reason: "unknown-target" });
    expect(await snapshot(t.store)).toEqual(before);
  });

  // The favourite by its tracked id (favourite_likes) or its retained one (favourites.uri, kept from before
  // migration 0052_favourite_likes).
  it.each(["tracked", "retained"] as const)(
    "under its %s id, naming another status: the favourite stays; recorded only for a local post",
    async (kind) => {
      const t = await setup();
      const { status, other, remote } = await liked(t);
      const like = likeId();
      if (kind === "tracked") {
        await receive(t.store, t.rUri, { id: like, type: "Like", object: status.uri });
      } else {
        await sql(
          t.store,
          "INSERT INTO favourites (account_id, status_id, uri) VALUES (?, ?, ?)",
          t.r,
          status.id,
          like,
        );
      }
      const before = await favourites(t);
      expect(before).toHaveLength(1);
      // Another local post: the id is recorded, as Mastodon's delete_later!.
      expect(await undo(t, like, "Like", other.uri)).toMatchObject({ applied: true, reason: "retraction-recorded" });
      expect(await favourites(t)).toEqual(before);
      expect(await retractions(t)).toEqual([like]);
      // A URN, an unknown local IRI, a remote status the sender has no favourite of: nothing.
      for (const object of ["urn:x:status", `${LOCAL}/ap/o/unknown`, remote]) {
        const unrecorded = likeId();
        await sql(t.store, "UPDATE favourites SET uri = ? WHERE account_id = ? AND uri IS NOT NULL", unrecorded, t.r);
        await sql(t.store, "UPDATE favourite_likes SET uri = ?", unrecorded);
        expect(await undo(t, unrecorded, "Like", object), object).toMatchObject({
          applied: false,
          reason: "unrelated",
        });
        expect(await favourites(t)).toHaveLength(1);
        expect(await retractions(t)).toEqual([like]);
      }
      // Naming the liked status, it ends the favourite.
      const last = (
        await sql<{ uri: string }>(
          t.store,
          `SELECT uri FROM favourite_likes UNION ALL SELECT uri FROM favourites WHERE account_id = ? AND uri IS NOT NULL`,
          t.r,
        )
      )[0]!.uri;
      expect(await undo(t, last, "Like", status.uri)).toMatchObject({ applied: true, reason: "undone" });
      expect(await favourites(t)).toEqual([]);
    },
  );

  // AC2L (d): a migrated favourite of a remote status, id-less or tracked, ends as on main (a listed difference).
  it("ends a migrated favourite of a remote status it names", async () => {
    const t = await setup();
    const { remote } = await liked(t);
    const statusId = (await sql<{ id: string }>(t.store, "SELECT id FROM statuses WHERE uri = ?", remote))[0]!.id;
    await sql(t.store, "INSERT INTO favourites (account_id, status_id) VALUES (?, ?)", t.r, statusId);
    const legacy = likeId();
    expect(await undo(t, legacy, "Like", remote)).toMatchObject({ applied: true, reason: "undone" });
    expect(await favourites(t)).toEqual([]);
    expect(await retractions(t)).toEqual([legacy]);
    // One whose Like id is tracked, named by its own id and status.
    await sql(t.store, "INSERT INTO favourites (account_id, status_id) VALUES (?, ?)", t.r, statusId);
    const tracked = likeId();
    await sql(
      t.store,
      `INSERT INTO favourite_likes (favourite_id, uri, received_at)
			SELECT id, ?, ? FROM favourites WHERE account_id = ?`,
      tracked,
      NOW,
      t.r,
    );
    expect(await undo(t, tracked, "Like", remote)).toMatchObject({ applied: true, reason: "undone" });
    expect(await favourites(t)).toEqual([]);
  });

  // L1, L5, L7, N1: as before.
  it("ends a favourite under its own id, keeps one under another, reads EmojiReact as a Like, ends a boost", async () => {
    const t = await setup();
    const { status } = await liked(t);
    const like = likeId();
    await receive(t.store, t.rUri, { id: like, type: "Like", object: status.uri });
    const other = likeId();
    expect(await undo(t, other, "Like", status.uri)).toMatchObject({ applied: true, reason: "retraction-recorded" });
    expect(await favourites(t)).toHaveLength(1);
    expect(await undo(t, like, "Like", status.uri)).toMatchObject({ applied: true, reason: "undone" });
    expect(await favourites(t)).toEqual([]);
    const react = likeId();
    expect(
      await deliver(t.store, t.rUri, {
        "@context": AS,
        id: react,
        type: "EmojiReact",
        actor: t.rUri,
        object: status.uri,
        content: "👍",
      }),
    ).toMatchObject({ applied: true });
    expect(await undo(t, react, "EmojiReact", status.uri)).toMatchObject({ applied: true, reason: "undone" });
    expect(await favourites(t)).toEqual([]);
    for (const object of [[status.uri], null]) {
      const boost = `${REMOTE}/boosts/${++sequence}`;
      await deliver(t.store, t.rUri, {
        "@context": AS,
        id: boost,
        type: "Announce",
        actor: t.rUri,
        published: "2026-10-11T13:00:00Z",
        to: [PUBLIC],
        cc: [],
        object: status.uri,
      });
      expect(await undo(t, boost, "Announce", object)).toMatchObject({ applied: true, reason: "undone" });
      expect(await sql(t.store, "SELECT * FROM statuses WHERE uri = ?", boost)).toEqual([]);
    }
  });
});

// AC6: an Undo that overtook what it undoes records its id, and that activity is refused when it arrives.
describe("ID-7: a typed Undo with nothing to end records its id", () => {
  it("of a Follow and of a Like", async () => {
    const t = await setup();
    const f8 = followId();
    expect(await undo(t, f8, "Follow", t.aliceUri)).toMatchObject({ applied: true, reason: "retraction-recorded" });
    expect((await followFrom(t, f8)).result).toMatchObject({ applied: false, reason: "retracted" });
    const status = await alicePost(t, "liked");
    const like = likeId();
    expect(await undo(t, like, "Like", status.uri)).toMatchObject({ applied: true, reason: "retraction-recorded" });
    expect(await receive(t.store, t.rUri, { id: like, type: "Like", object: status.uri })).toMatchObject({
      applied: false,
      reason: "retracted",
    });
  });
});

// F10, B6: the pair's first element is the verified sender. c, of r's origin, ends nothing of r's.
describe("ID-6: another actor's Undo ends nothing of the pair it names", () => {
  it("of a Follow: r's follows, alice's follow of r and their answers and notifications stay", async () => {
    const t = await setup();
    await outage(t);
    await followFrom(t);
    await followFrom(t, followId(), t.rUri, t.danUri);
    await sql(
      t.store,
      "INSERT INTO follows (account_id, target_account_id, state, uri) VALUES (?, ?, 'accepted', ?)",
      t.w.alice.id,
      t.r,
      `${t.aliceUri}#follows/1`,
    );
    const before = await snapshot(t.store);
    const c1 = `${REMOTE}/follows/c-${++sequence}`;
    expect(await undo(t, c1, "Follow", t.aliceUri, t.cUri)).toMatchObject({
      applied: true,
      reason: "retraction-recorded",
    });
    const after = await snapshot(t.store);
    // All but the retractions (the snapshot's seventh table), which gain c's.
    expect(after.toSpliced(6, 1)).toEqual(before.toSpliced(6, 1));
    expect(await retractions(t)).toEqual([]);
    expect(await retractions(t, t.cUri)).toEqual([c1]);
  });

  it("of a Block: r's block of alice stays, beside c's own, which ends", async () => {
    const t = await setup();
    await blockFrom(t);
    const c2 = `${REMOTE}/blocks/c-${++sequence}`;
    expect(await undo(t, c2, "Block", t.aliceUri, t.cUri)).toMatchObject({
      applied: true,
      reason: "retraction-recorded",
    });
    expect(await blocks(t)).toHaveLength(1);
    await blockFrom(t, blockId(), t.cUri);
    expect(await undo(t, blockId(), "Block", t.aliceUri, t.cUri)).toMatchObject({ applied: true, reason: "undone" });
    expect(await blocks(t, t.c)).toEqual([]);
    expect(await blocks(t)).toHaveLength(1);
  });

  it("refuses another actor's undone activity, one without an id, or one of another origin", async () => {
    const t = await setup();
    const { id } = await followFrom(t);
    const before = await snapshot(t.store);
    expect(
      await deliver(t.store, t.rUri, undoBody(t.rUri, { id, type: "Follow", actor: t.cUri, object: t.aliceUri })),
    ).toMatchObject({ applied: false, reason: "not-own" });
    expect(
      await deliver(t.store, t.rUri, undoBody(t.rUri, { type: "Follow", actor: t.rUri, object: t.aliceUri })),
    ).toMatchObject({ applied: false, reason: "unknown-object" });
    expect(await undo(t, "https://elsewhere.example/follows/1", "Follow", t.aliceUri)).toMatchObject({
      applied: false,
      reason: "foreign-object",
    });
    expect(await snapshot(t.store)).toEqual(before);
  });
});

// AC8: an Accept or a Reject reads an embedded object whose type is an array as before (by id, by the pair, or as a
// quote answer by its id).
describe("an Accept or a Reject of an object typed by an array", () => {
  async function ourFollow(t: T, uri: string | null) {
    await sql(
      t.store,
      "INSERT INTO follows (account_id, target_account_id, state, uri) VALUES (?, ?, 'pending', ?)",
      t.w.alice.id,
      t.r,
      uri,
    );
  }
  const ours = (t: T) =>
    sql<{ state: string }>(t.store, "SELECT state FROM follows WHERE account_id = ?", t.w.alice.id);
  const answer = (t: T, type: string, object: Json, extra: Json = {}) =>
    deliver(t.store, t.rUri, {
      "@context": AS,
      id: `${t.rUri}#answer-${++sequence}`,
      type,
      actor: t.rUri,
      object,
      ...extra,
    });
  // alice's pending quote of r's status, as an API post records it with its QuoteRequest; the quote's status id and
  // the QuoteRequest's id.
  async function pendingQuote(t: T): Promise<{ id: string; request: string }> {
    const theirs = `${REMOTE}/notes/${++sequence}`;
    const quoted = await seedStatus(t.store, { accountId: t.r, visibility: "public", uri: theirs });
    const mine = await alicePost(t, "quoting");
    const request = `${mine.uri}#quote-request`;
    await sql(
      t.store,
      `INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, local, activity_uri,
				updated_at)
			VALUES (?, ?, ?, ?, 'pending', 1, ?, ?)`,
      mine.id,
      theirs,
      quoted,
      t.r,
      request,
      new Date(NOW).toISOString(),
    );
    return { id: mine.id, request };
  }
  const quoteState = async (t: T, id: string) =>
    (await sql<{ state: string }>(t.store, "SELECT state FROM quotes WHERE status_id = ?", id))[0]?.state;

  it("accepts our follow by its id and by the pair, rejects it by its id, and reads a quote answer", async () => {
    const t = await setup();
    const uri = `${t.aliceUri}#follows/1`;
    await ourFollow(t, uri);
    expect(await answer(t, "Accept", { id: uri, type: ["Follow"], actor: t.aliceUri, object: t.rUri })).toMatchObject({
      applied: true,
      reason: "follow-accepted",
    });
    expect(await ours(t)).toEqual([{ state: "accepted" }]);
    expect(await answer(t, "Reject", { id: uri, type: ["Follow"], actor: t.aliceUri, object: t.rUri })).toMatchObject({
      applied: true,
    });
    expect(await ours(t)).toEqual([]);
    await ourFollow(t, null);
    expect(await answer(t, "Accept", { type: ["Follow"], actor: t.aliceUri, object: t.rUri })).toMatchObject({
      applied: true,
      reason: "follow-accepted",
    });
    expect(await ours(t)).toEqual([{ state: "accepted" }]);
    expect(
      await answer(t, "Accept", { id: `${t.aliceUri}/statuses/1#quote-request`, type: ["QuoteRequest"] }),
    ).toMatchObject({ applied: false, reason: "quote-unchanged" });
  });

  it("accepts and rejects our pending quote by its QuoteRequest typed by an array", async () => {
    const t = await setup();
    const accepted = await pendingQuote(t);
    const rejected = await pendingQuote(t);
    expect(
      await answer(
        t,
        "Accept",
        { id: accepted.request, type: ["QuoteRequest"] },
        { result: `${t.rUri}/quote_authorizations/${++sequence}` },
      ),
    ).toMatchObject({ applied: true, reason: "quote-accepted" });
    expect(await answer(t, "Reject", { id: rejected.request, type: ["QuoteRequest"] })).toMatchObject({
      applied: true,
      reason: "quote-rejected",
    });
    expect([await quoteState(t, accepted.id), await quoteState(t, rejected.id)]).toEqual(["accepted", "rejected"]);
  });
});

// The inbox's own paths: a signed POST, an LD-signed body read as Mastodon's compaction or as received, and a request
// spooled during maintenance and replayed. Each reason is the Store's answer to the request.
describe("an Undo through the inbox", () => {
  const ALICE = "111111111111111111";
  const ALICE_URI = `${LOCAL}/ap/users/alice`;

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
    const send = async (body: unknown) => {
      counting.records.length = 0;
      const status = (await h.request("/inbox", await signedInit(bob, "/inbox", body))).status;
      return { status, reason: reasonOf() };
    };
    const blocks = () => sql<{ uri: string | null }>(store, "SELECT uri FROM blocks");
    return { store, web, counting, federation, bob, send, reasonOf, blocks };
  }

  const blockOf = (bob: TestActor) => ({
    "@context": AS,
    id: `${bob.uri}/blocks/1`,
    type: "Block",
    actor: bob.uri,
    object: ALICE_URI,
  });
  const undoOf = (bob: TestActor, object: Json, extra: Json = {}) => ({
    "@context": [AS, "https://w3id.org/security/v1"],
    id: `${bob.uri}/activities/${++sequence}`,
    type: "Undo",
    actor: bob.uri,
    object,
    ...extra,
  });
  const ldSignature = (bob: TestActor) => ({
    signature: {
      type: "RsaSignature2017",
      creator: `${bob.uri}#main-key`,
      created: "2026-11-16T12:00:00Z",
      signatureValue: "placeholder-signature-value",
    },
  });

  it("a signed POST of a typed Undo whose object is an array: 202, the follow stays", async () => {
    const t = await signedSetup();
    const follow = {
      "@context": AS,
      id: `${t.bob.uri}/follows/1`,
      type: "Follow",
      actor: t.bob.uri,
      object: ALICE_URI,
    };
    expect(await t.send(follow)).toEqual({ status: 202, reason: "followed" });
    expect(
      await t.send(undoOf(t.bob, { id: follow.id, type: "Follow", actor: t.bob.uri, object: [ALICE_URI] })),
    ).toEqual({ status: 202, reason: "unknown-target" });
    expect(await sql(t.store, "SELECT uri FROM follows")).toEqual([{ uri: follow.id }]);
  });

  // forms.json: Mastodon's compaction writes an embedded empty type as null, which undo.rb reads as an Undo by
  // reference.
  it.each([
    "Undo of a block, both typed as absolute IRIs, with its block's type as an empty array",
    "Undo of a block, both typed as absolute IRIs, with its block's type as an empty array after a stop",
  ])("LD-signed, read as the compaction: %s ends the block by its id", async (name) => {
    const t = await signedSetup();
    expect(await t.send(blockOf(t.bob))).toEqual({ status: 202, reason: "blocked" });
    const form = (formsFixture as unknown as { name: string; received: Json }[]).find((entry) => entry.name === name)!;
    expect(await t.send(form.received)).toEqual({ status: 202, reason: "undone" });
    expect(await t.blocks()).toEqual([]);
  });

  // Past Mastodon's 1,000 values, it reads the body as received: an empty type is no single name there, and undo.rb
  // applies nothing, as for an array of types, an array object or none.
  it.each([
    ["an empty undone type", { type: [], object: ALICE_URI }, "unsupported-undo"],
    ["an array of undone types", { type: ["Block", "Ignore"], object: ALICE_URI }, "unsupported-undo"],
    ["an array object", { type: "Block", object: [ALICE_URI] }, "unknown-target"],
    ["no object", { type: "Block" }, "unknown-target"],
  ])("LD-signed, read as received: %s leaves the block", async (_, block, reason) => {
    const t = await signedSetup();
    expect(await t.send(blockOf(t.bob))).toEqual({ status: 202, reason: "blocked" });
    const body = undoOf(
      t.bob,
      { id: `${t.bob.uri}/blocks/1`, actor: t.bob.uri, ...block },
      { ...ldSignature(t.bob), padding: Array.from({ length: 1_000 }, () => "x") },
    );
    expect(await t.send(body)).toEqual({ status: 202, reason });
    expect(await t.blocks()).toEqual([{ uri: `${t.bob.uri}/blocks/1` }]);
  });

  it("spooled during maintenance and replayed: an array of undone types leaves the block", async () => {
    const t = await signedSetup();
    expect(await t.send(blockOf(t.bob))).toEqual({ status: 202, reason: "blocked" });
    const maintenance = harness(t.counting.stub, { MAINTENANCE: "readonly" }, BUILD, t.federation);
    const body = undoOf(t.bob, {
      id: `${t.bob.uri}/blocks/1`,
      type: ["Block", "Ignore"],
      actor: t.bob.uri,
      object: ALICE_URI,
    });
    const response = await maintenance.request("/inbox", await signedInit(t.bob, "/inbox", body));
    expect(response.status).toBe(202);
    t.counting.records.length = 0;
    const deps = inboxDeps(() => t.counting.stub, t.web.loader);
    await maintenance.queue.deliver((batch) =>
      handleQueue(batch, { ...maintenance.env, MAINTENANCE: "off" } as Env, deps),
    );
    expect(maintenance.queue.pending).toEqual([]);
    expect(t.reasonOf()).toBe("unsupported-undo");
    expect(await t.blocks()).toEqual([{ uri: `${t.bob.uri}/blocks/1` }]);
  });
});
