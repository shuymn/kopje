import { describe, expect, it } from "vitest";

import { MAX_RETRACTIONS_PER_ACTOR } from "../src/domain/retractions";
import { syncCollections } from "../src/federation/collections";
import { parseActivity } from "../src/federation/inbound";
import { verifyQuotes } from "../src/federation/quotes";
import { parseRemoteStatus } from "../src/federation/remote-status";
import { STATUS_URI_LIMIT } from "../src/platform/identity-bounds";
import { settle, sql } from "./api-helpers";
import { inboxDeps, NOW } from "./app-helpers";
import { mastodonDelete, mastodonSigned } from "./author-proof-helpers";
import { BUILD } from "./helpers";
import { LOCAL, MASTODON, mastodonActor, type TestActor } from "./inbox-helpers";
import {
  accountId,
  ALICE,
  announce,
  AS,
  create,
  followed,
  localStatus,
  mastodonNote,
  type Note,
  nextId,
  PUBLIC,
  remove,
  retractionsAtCap,
  setup,
  type Setup,
  undo,
} from "./inbox-status-helpers";
import { storeReceive } from "./inbox-store-helpers";
import { quoting } from "./quote-helpers";

// atomUri (Mastodon's Create#find_existing_status, Delete#delete_status and Undo#undo_announce, mastodon#39916): a
// status known under one id is matched by another object's atomUri, the author's own only, and every caller that goes
// on from the stored status acts on the one matched (remote-statuses.ts storeRemoteStatus, inbox.ts namedStatus,
// retractions.ts retractMatched; ID-3, ID-7). Only an http(s) atomUri is read (docs/mastodon-deviations.md,
// "Retractions and edits of remote statuses").

const RELAY = "https://relay.example";

type Json = Record<string, unknown>;

// alice follows bob and erin, both on mastodon.example, so their public statuses are stored.
async function world() {
  const t = await setup();
  const bob = await mastodonActor(t.web, "bob");
  const erin = await mastodonActor(t.web, "erin", { key: 2 });
  const bobId = await followed(t, bob);
  await followed(t, erin);
  return { t, bob, erin, bobId };
}

async function idOf(t: Setup, uri: string): Promise<string | undefined> {
  return (await sql<{ id: string }>(t.store, "SELECT id FROM statuses WHERE uri = ?", uri))[0]?.id;
}

// `actor`'s Note, delivered and stored: the Note and its row's id.
async function stored(t: Setup, actor: TestActor, extra: Json = {}): Promise<{ note: Note; id: string }> {
  const note = mastodonNote(actor, extra);
  expect(await t.post(actor, create(actor, note))).toBe(202);
  return { note, id: (await idOf(t, note.id))! };
}

// A Note of `actor` under a new id whose atomUri names `uri`, as an implementation whose atomUri differs from its id
// writes one.
function naming(actor: TestActor, uri: string, extra: Json = {}): Note {
  return mastodonNote(actor, { atomUri: uri, ...extra });
}

function served(t: Setup, note: Note): Note {
  t.web.serve(note.id, { "@context": AS, ...note });
  return note;
}

const mentionsOf = (t: Setup, id: string) =>
  sql<{ account_id: string; silent: number }>(
    t.store,
    "SELECT account_id, silent FROM status_mentions WHERE status_id = ? ORDER BY account_id",
    id,
  );

const boostsOf = (t: Setup, original: string) =>
  sql<{ uri: string; account_id: string }>(
    t.store,
    "SELECT uri, account_id FROM statuses WHERE reblog_of_id = ? ORDER BY uri",
    original,
  );

// The live retractions recorded for `actorUri` (an actor's, or '*' for a deleted stored object), other than fillers.
const retracted = (t: Setup, actorUri: string) =>
  sql<{ target_uri: string }>(
    t.store,
    "SELECT target_uri FROM inbound_retractions WHERE actor_uri = ? AND target_uri NOT LIKE '%/filler/%' ORDER BY 1",
    actorUri,
  ).then((rows) => rows.map((row) => row.target_uri));

// A Tombstone's Delete as Mastodon's DeleteSerializer writes it, naming the unknown id `id` with the atomUri `atomUri`.
function deletion(actor: TestActor, id: string, atomUri: unknown): Json {
  const body = mastodonDelete(actor, id, `${id}#delete-${nextId()}`);
  return { ...body, object: { ...(body.object as Json), atomUri } };
}

// An id of `actor`'s origin no status has.
function unknownId(actor: TestActor): string {
  return `${actor.uri}/statuses/${nextId()}`;
}

describe("a Create naming a stored status by atomUri (Create#find_existing_status)", () => {
  it("stores nothing for the author's own and extends its audience as for a known id", async () => {
    const { t, bob } = await world();
    const a = await stored(t, bob);
    const b = naming(bob, a.note.id);
    expect(await t.post(bob, create(bob, b), { path: "/ap/users/alice/inbox" })).toBe(202);
    // Without the match, B is a second row; with it, alice is added to A's audience as a silent mention.
    expect(await idOf(t, b.id)).toBeUndefined();
    expect(await mentionsOf(t, a.id)).toEqual([{ account_id: ALICE, silent: 1 }]);
  });

  it("matches a Create whose object is B by id alone (fetched), and a search for B's URL answers A", async () => {
    const { t, bob } = await world();
    const a = await stored(t, bob);
    const b = served(t, naming(bob, a.note.id));
    expect(await t.post(bob, { ...create(bob, b), object: b.id })).toBe(202);
    expect(t.web.fetched).toContain(b.id);
    expect(await idOf(t, b.id)).toBeUndefined();
    const found = await t.api<{ statuses: { id: string; uri: string }[] }>(
      `/api/v2/search?resolve=true&type=statuses&q=${encodeURIComponent(b.id)}`,
    );
    expect(found.body.statuses.map((status) => [status.id, status.uri])).toEqual([[a.id, a.note.id]]);
    expect(await idOf(t, b.id)).toBeUndefined();
  });

  it("refuses one naming another author's status, remote or local, and stores nothing", async () => {
    const { t, bob, erin } = await world();
    const a = await stored(t, bob);
    const mine = await localStatus(t, { status: "mine", visibility: "public" });
    for (const [target, inbox, targetId] of [
      [a.note.id, "alice", a.id],
      [mine.uri, "dave", mine.id],
    ] as const) {
      const before = await mentionsOf(t, targetId);
      const b = naming(erin, target);
      expect(await t.post(erin, create(erin, b), { path: `/ap/users/${inbox}/inbox` })).toBe(202);
      // not-author: no row for B, and the matched status's audience unchanged (without the author comparison, the
      // recipient would become its silent mention).
      expect(await idOf(t, b.id), target).toBeUndefined();
      expect(await mentionsOf(t, targetId), target).toEqual(before);
      const result = await storeReceive(t.store, erin.uri, {
        type: "Create",
        id: `${b.id}/activity`,
        object: parseRemoteStatus(naming(erin, target))!,
      });
      expect(result, target).toMatchObject({ applied: false, reason: "not-author" });
    }
  });

  it("does not bring back a deleted status under a third id naming it by atomUri", async () => {
    const { t, bob } = await world();
    const a = await stored(t, bob);
    expect(await t.post(bob, remove(bob, a.note.id))).toBe(202);
    await settle(t.store);
    expect(await idOf(t, a.note.id)).toBeUndefined();
    const c = naming(bob, a.note.id, { content: "<p>back again</p>" });
    expect(await t.post(bob, create(bob, c))).toBe(202);
    // Without the tombstone check of the atomUri, C is created with A's content.
    expect(await idOf(t, c.id)).toBeUndefined();
    const result = await storeReceive(t.store, bob.uri, {
      type: "Create",
      id: `${c.id}/activity`,
      object: parseRemoteStatus(c)!,
    });
    expect(result).toMatchObject({ applied: false, reason: "retracted" });
  });
});

describe("callers that go on from a status matched by atomUri act on it", () => {
  it("boosts A for an Announce of B, embedded or fetched", async () => {
    const { t, bob, erin } = await world();
    const a = await stored(t, bob);
    // bob's own B, embedded in his Announce.
    const embedded = naming(bob, a.note.id);
    const own = announce(bob, embedded.id, { object: embedded });
    expect(await t.post(bob, own)).toBe(202);
    // erin's Announce of bob's B, fetched.
    const fetched = served(t, naming(bob, a.note.id));
    const theirs = announce(erin, fetched.id);
    expect(await t.post(erin, theirs)).toBe(202);
    expect(await boostsOf(t, a.id)).toEqual([
      { uri: own.id, account_id: await accountId(t.store, bob.uri) },
      { uri: theirs.id, account_id: await accountId(t.store, erin.uri) },
    ]);
    expect(await idOf(t, embedded.id)).toBeUndefined();
    expect(await idOf(t, fetched.id)).toBeUndefined();
  });

  it("refuses the boost by A's stored visibility, whatever B's says", async () => {
    const { t, bob, erin } = await world();
    const a = await stored(t, bob, { to: [`${bob.uri}/followers`], cc: [] });
    const b = naming(bob, a.note.id);
    const id = `${erin.uri}/statuses/${nextId()}/activity`;
    const result = await t.store.receiveActivity(BUILD, {
      now: NOW,
      origin: LOCAL,
      actorUri: erin.uri,
      actor: null,
      actorRevision: null,
      activity: {
        type: "Announce",
        id,
        object: b.id,
        embedded: null,
        to: [PUBLIC],
        cc: [],
        published: null,
        raw: "{}",
      },
      prefetched: { statuses: { [b.id]: parseRemoteStatus(b) }, actors: {} },
    });
    // B is public; A is followers-only, which VIS-6 refuses to wrap.
    expect(result).toMatchObject({ applied: false, reason: "not-announceable" });
    expect(await boostsOf(t, a.id)).toEqual([]);
  });

  it("pins A for B in the featured collection, and not another account's status", async () => {
    const { t, bob, erin, bobId } = await world();
    const a = await stored(t, bob);
    const e = await stored(t, erin);
    const b = served(t, naming(bob, a.note.id));
    const other = served(t, naming(bob, e.note.id));
    const featured = `${bob.uri}/collections/featured`;
    t.web.serve(featured, { "@context": AS, id: featured, type: "OrderedCollection", orderedItems: [b.id, other.id] });
    const deps = { ...inboxDeps(() => t.store, t.web.loader), now: () => NOW };
    for (let round = 0; round < 5 && (await syncCollections(t.env, deps)); round++) {
      // Until no sync waits.
    }
    expect(t.web.fetched).toEqual(expect.arrayContaining([b.id, other.id]));
    const pinned = await t.api<{ uri: string }[]>(`/api/v1/accounts/${bobId}/statuses?pinned=true`, "alice");
    expect(pinned.body.map((status) => status.uri)).toEqual([a.note.id]);
    expect(await sql(t.store, "SELECT count(*) AS n FROM collection_pins_pending")).toEqual([{ n: 0 }]);
    expect(await idOf(t, b.id)).toBeUndefined();
  });

  it("pins A for an Add of B", async () => {
    const { t, bob, bobId } = await world();
    const a = await stored(t, bob);
    const b = served(t, naming(bob, a.note.id));
    const add = {
      "@context": AS,
      id: `${bob.uri}#add-${nextId()}`,
      type: "Add",
      actor: bob.uri,
      target: `${bob.uri}/collections/featured`,
      object: b.id,
    };
    expect(await t.post(bob, add)).toBe(202);
    expect(t.web.fetched).toContain(b.id);
    const pinned = await t.api<{ uri: string }[]>(`/api/v1/accounts/${bobId}/statuses?pinned=true`, "alice");
    expect(pinned.body.map((status) => status.uri)).toEqual([a.note.id]);
  });

  it("answers a QuoteRequest whose instrument is B as for A, and ignores one whose A quotes another status", async () => {
    const { t, bob } = await world();
    const mine = await localStatus(t, { status: "quote me", visibility: "public" });
    const elsewhere = await localStatus(t, { status: "another", visibility: "public" });
    const a = await stored(t, bob, { quote: mine.uri, _misskey_quote: mine.uri, quoteUri: mine.uri });
    const quoteOf = async (id: string) =>
      (
        await sql<{ state: string; activity_uri: string | null }>(
          t.store,
          "SELECT state, activity_uri FROM quotes WHERE status_id = ?",
          id,
        )
      )[0];
    expect(await quoteOf(a.id)).toEqual({ state: "pending", activity_uri: null });
    const request = (instrument: Note) => ({
      "@context": [AS, { QuoteRequest: "https://w3id.org/fep/044f#QuoteRequest" }],
      id: `${bob.uri}/quote_requests/${nextId()}`,
      type: "QuoteRequest",
      actor: bob.uri,
      object: mine.uri,
      instrument,
    });
    const b = quoting(bob, mine.uri, null, { atomUri: a.note.id });
    const accepted = request(b);
    expect(await t.post(bob, accepted)).toBe(202);
    expect(await quoteOf(a.id)).toEqual({ state: "accepted", activity_uri: accepted.id });
    expect(await idOf(t, b.id)).toBeUndefined();

    // A2 quotes alice's other status: the request for `mine` names no quote of it.
    const a2 = await stored(t, bob, { quote: elsewhere.uri, _misskey_quote: elsewhere.uri, quoteUri: elsewhere.uri });
    const b2 = quoting(bob, mine.uri, null, { atomUri: a2.note.id });
    const ignored = request(b2);
    const result = await storeReceive(t.store, bob.uri, {
      type: "QuoteRequest",
      id: ignored.id,
      object: mine.uri,
      instrument: b2.id,
      embedded: parseRemoteStatus(b2),
    });
    expect(result).toMatchObject({ applied: false, reason: "not-a-quote" });
    expect(await quoteOf(a2.id)).toEqual({ state: "pending", activity_uri: null });
    expect(await sql(t.store, "SELECT count(*) AS n FROM quote_requests WHERE activity_uri = ?", ignored.id)).toEqual([
      { n: 0 },
    ]);
  });

  it("leaves a quote of B unlinked: the quote stage links the status by the URI the quote names", async () => {
    const { t, bob, erin } = await world();
    const a = await stored(t, bob);
    const b = served(t, naming(bob, a.note.id));
    // erin's Mastodon quote of B names it by its URI (NoteSerializer#quote), as Mastodon names any quoted status.
    const quote = quoting(erin, b.id, null);
    expect(await t.post(erin, create(erin, quote))).toBe(202);
    const deps = { ...inboxDeps(() => t.store, t.web.loader), now: () => NOW };
    for (let round = 0; round < 10 && (await verifyQuotes(t.env, deps)); round++) {
      // Until no quote's work is due.
    }
    // The stage fetched B and stored it as A (nothing new); the quote stays pending, its work done.
    expect(t.web.fetched).toContain(b.id);
    expect(await idOf(t, b.id)).toBeUndefined();
    expect(
      await sql(
        t.store,
        `SELECT q.quoted_uri, q.quoted_status_id, q.state, q.verify_after FROM quotes q
				JOIN statuses s ON s.id = q.status_id WHERE s.uri = ?`,
        quote.id,
      ),
    ).toEqual([{ quoted_uri: b.id, quoted_status_id: null, state: "pending", verify_after: null }]);
  });
});

describe("a Delete or an Undo naming a status by atomUri (Delete#delete_status, Undo#undo_announce)", () => {
  it("deletes the actor's own status found by a Tombstone's atomUri and retracts both ids", async () => {
    const { t, bob } = await world();
    const a = await stored(t, bob);
    const x = unknownId(bob);
    expect(await t.post(bob, deletion(bob, x, a.note.id))).toBe(202);
    await settle(t.store);
    // Without the fallback, A stays and only x is recorded.
    expect(await idOf(t, a.note.id)).toBeUndefined();
    expect(await retracted(t, bob.uri)).toEqual([a.note.id, x].toSorted());
    // Only the stored status's own uri is deleted for every actor; x was never shown to be bob's.
    expect(await retracted(t, "*")).toEqual([a.note.id]);
    // Neither id brings it back.
    expect(await t.post(bob, create(bob, a.note))).toBe(202);
    expect(await t.post(bob, create(bob, mastodonNote(bob, { id: x, atomUri: x })))).toBe(202);
    expect(await idOf(t, a.note.id)).toBeUndefined();
    expect(await idOf(t, x)).toBeUndefined();
  });

  it("keeps the object id of a Delete matched by atomUri the deleting actor's: another actor's later status stays", async () => {
    const { t, bob, erin } = await world();
    const a = await stored(t, bob);
    // bob names erin's future status (one origin) as the object and his own A by atomUri.
    const future = mastodonNote(erin);
    expect(await t.post(bob, deletion(bob, future.id, a.note.id))).toBe(202);
    await settle(t.store);
    expect(await idOf(t, a.note.id)).toBeUndefined();
    // Recorded as deleted for every actor, erin's Create of it would be refused as retracted.
    expect(await t.post(erin, create(erin, future))).toBe(202);
    expect(await idOf(t, future.id)).toBeDefined();
  });

  it("takes the actor's own status by atomUri before refusing another author's status under the object id", async () => {
    const { t, bob, erin } = await world();
    const a = await stored(t, bob);
    const e = await stored(t, erin);
    // The object id is erin's stored status (one origin); the atomUri names bob's own A, as delete.rb scopes both
    // lookups to the deleting account.
    expect(await t.post(bob, deletion(bob, e.note.id, a.note.id))).toBe(202);
    await settle(t.store);
    expect(await idOf(t, a.note.id)).toBeUndefined();
    expect(await idOf(t, e.note.id)).toBe(e.id);
    expect(await retracted(t, "*")).toEqual([a.note.id]);
  });

  it("does not delete another author's status by atomUri: the Delete is of an unknown object", async () => {
    const { t, bob, erin } = await world();
    const e = await stored(t, erin);
    const x = unknownId(bob);
    expect(await t.post(bob, deletion(bob, x, e.note.id))).toBe(202);
    await settle(t.store);
    expect(await idOf(t, e.note.id)).toBe(e.id);
    // Recorded as bob's retraction of x (an unknown object), as Mastodon's Tombstone of the object id; matched to
    // erin's status, it would have been refused as not-author with nothing recorded.
    expect(await retracted(t, bob.uri)).toEqual([x]);
    expect(await retracted(t, "*")).toEqual([]);
  });

  it("applies a relayed Delete by atomUri with the author's proof, and not without one", async () => {
    for (const proven of [true, false]) {
      const { t, bob } = await world();
      const dan = await mastodonActor(t.web, "dan", { origin: RELAY, key: 6 });
      const a = await stored(t, bob);
      const body = deletion(bob, unknownId(bob), a.note.id);
      expect(await t.post(dan, proven ? await mastodonSigned(body, bob) : body)).toBe(202);
      await settle(t.store);
      expect(await idOf(t, a.note.id), String(proven)).toBe(proven ? undefined : a.id);
      expect(await retracted(t, bob.uri), String(proven)).toEqual(
        proven ? [a.note.id, (body.object as Json).id as string].toSorted() : [],
      );
    }
  }, 60_000);

  it("undoes the actor's own boost found by the Undo's atomUri, so neither Announce brings it back", async () => {
    const { t, bob, erin } = await world();
    const mine = await localStatus(t, { status: "boost me", visibility: "public" });
    const boost = announce(bob, mine.uri);
    const erins = announce(erin, mine.uri);
    expect(await t.post(bob, boost)).toBe(202);
    expect(await t.post(erin, erins)).toBe(202);
    expect((await boostsOf(t, mine.id)).map((row) => row.uri)).toEqual([boost.id, erins.id]);
    const b = `${bob.uri}/statuses/${nextId()}/activity`;
    const ref = (id: string, atomUri: string) => ({ id, type: "Announce", actor: bob.uri, object: mine.uri, atomUri });

    // bob's Undo naming erin's boost by atomUri (one origin) leaves it.
    expect(await t.post(bob, undo(bob, ref(`${bob.uri}/statuses/${nextId()}/activity`, erins.id)))).toBe(202);
    expect((await boostsOf(t, mine.id)).map((row) => row.uri)).toEqual([boost.id, erins.id]);

    expect(await t.post(bob, undo(bob, ref(b, boost.id)))).toBe(202);
    expect((await boostsOf(t, mine.id)).map((row) => row.uri)).toEqual([erins.id]);
    expect(await retracted(t, bob.uri)).toEqual(expect.arrayContaining([b, boost.id]));
    // A replay of the boost's Announce, and one under the Undo's object id, both retracted.
    expect(await t.post(bob, boost)).toBe(202);
    expect(await t.post(bob, { ...boost, id: b })).toBe(202);
    expect((await boostsOf(t, mine.id)).map((row) => row.uri)).toEqual([erins.id]);
  });

  it("removes nothing and records nothing by atomUri with one retraction slot left; with two, both go", async () => {
    for (const kind of ["Undo", "Delete"] as const) {
      const { t, bob } = await world();
      const mine = await localStatus(t, { status: "boost me", visibility: "public" });
      const boost = announce(bob, mine.uri);
      expect(await t.post(bob, boost)).toBe(202);
      const a = await stored(t, bob);
      await retractionsAtCap(t, bob);
      const free = (n: number) =>
        sql(
          t.store,
          `DELETE FROM inbound_retractions WHERE actor_uri = ?1 AND target_uri IN
					(SELECT target_uri FROM inbound_retractions WHERE actor_uri = ?1 AND target_uri LIKE '%/filler/%' LIMIT ?2)`,
          bob.uri,
          n,
        );
      const objectId = kind === "Undo" ? `${bob.uri}/statuses/${nextId()}/activity` : unknownId(bob);
      const activity =
        kind === "Undo"
          ? undo(bob, { id: objectId, type: "Announce", actor: bob.uri, object: mine.uri, atomUri: boost.id })
          : deletion(bob, objectId, a.note.id);
      const present = async () =>
        kind === "Undo" ? (await boostsOf(t, mine.id)).length === 1 : (await idOf(t, a.note.id)) !== undefined;

      await free(1);
      expect(await t.post(bob, activity), kind).toBe(503);
      expect(await present(), kind).toBe(true);
      expect(await retracted(t, bob.uri), kind).toEqual([]);
      expect(
        await sql(t.store, "SELECT count(*) AS n FROM inbound_retractions WHERE actor_uri = ?", bob.uri),
        kind,
      ).toEqual([{ n: MAX_RETRACTIONS_PER_ACTOR - 1 }]);

      await free(1);
      expect(await t.post(bob, activity), kind).toBe(202);
      await settle(t.store);
      expect(await present(), kind).toBe(false);
      expect(await retracted(t, bob.uri), kind).toEqual([objectId, kind === "Undo" ? boost.id : a.note.id].toSorted());
    }
  }, 120_000);
});

describe("reading atomUri (parseRemoteStatus, the inbound parser): an http(s) URI within STATUS_URI_LIMIT", () => {
  const bob = { uri: `${MASTODON}/users/bob` } as TestActor;
  const prefix = `${MASTODON}/users/bob/statuses/`;
  // JSON-escaped UTF-8 bytes, the bound's unit (identity-bounds.ts).
  const bytes = (value: string) => new TextEncoder().encode(JSON.stringify(value)).length - 2;
  const fill = (head: string, total: number) => head + "a".repeat(total - bytes(head));
  const atLimit = fill(prefix, STATUS_URI_LIMIT);
  const astralAtLimit = fill(`${prefix}\u{1F600}`, STATUS_URI_LIMIT);
  // Code units within the limit, bytes one past it by an escape; and NUL, escaped as \u0000.
  const escapePast = fill(`${prefix}"`, STATUS_URI_LIMIT + 1);
  const nulPast = fill(`${prefix}\0`, STATUS_URI_LIMIT + 5);
  const plainPast = fill(prefix, STATUS_URI_LIMIT + 1);
  const cases: [string, unknown, string | null][] = [
    ["at the limit", atLimit, atLimit],
    ["at the limit with an astral character", astralAtLimit, astralAtLimit],
    ["one byte past by an escape", escapePast, null],
    ["past by a NUL", nulPast, null],
    ["one byte past", plainPast, null],
    ["an OStatus tag: identity", "tag:mastodon.example,2016-11-04:objectId=1:objectType=Status", null],
    ["another scheme", "ftp://mastodon.example/1", null],
    ["a number", 1, null],
    ["null", null, null],
    ["an object", { id: `${prefix}1` }, null],
    ["empty", "", null],
  ];

  it("measures the cases as named", () => {
    expect(escapePast.length).toBe(STATUS_URI_LIMIT);
    expect(bytes(escapePast)).toBe(STATUS_URI_LIMIT + 1);
    expect(astralAtLimit.length).toBeLessThan(STATUS_URI_LIMIT);
    expect(bytes(astralAtLimit)).toBe(STATUS_URI_LIMIT);
  });

  it("keeps an http(s) atomUri within the bound as written, and reads anything else as absent", () => {
    for (const [name, value, expected] of cases) {
      expect(parseRemoteStatus(mastodonNote(bob, { atomUri: value }))?.atomUri, name).toBe(expected);
      const parse = (json: Json) => parseActivity(new TextEncoder().encode(JSON.stringify(json)));
      const deleted = parse({
        "@context": AS,
        id: `${prefix}1#delete`,
        type: "Delete",
        actor: bob.uri,
        object: { id: `${prefix}1`, type: "Tombstone", atomUri: value },
      });
      expect(deleted.ok && deleted.activity.type === "Delete" && deleted.activity.atomUri, name).toBe(expected);
      const undone = parse({
        "@context": AS,
        id: `${bob.uri}#undo-1`,
        type: "Undo",
        actor: bob.uri,
        object: { id: `${prefix}1/activity`, type: "Announce", actor: bob.uri, atomUri: value },
      });
      expect(undone.ok && undone.activity.type === "Undo" && undone.activity.object.atomUri, name).toBe(expected);
    }
  });

  it("deletes nothing for a Tombstone naming a stored status only by its tag: uri", async () => {
    const { t, bob: author } = await world();
    const a = await stored(t, author);
    const tag = `tag:mastodon.example,2016-11-04:objectId=${nextId()}:objectType=Status`;
    await sql(t.store, "UPDATE statuses SET uri = ? WHERE id = ?", tag, a.id);
    const x = unknownId(author);
    expect(await t.post(author, deletion(author, x, tag))).toBe(202);
    await settle(t.store);
    expect(await sql(t.store, "SELECT id FROM statuses WHERE uri = ?", tag)).toEqual([{ id: a.id }]);
    expect(await retracted(t, author.uri)).toEqual([x]);
  });
});
