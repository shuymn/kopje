import { afterEach, describe, expect, it } from "vitest";

import { KEY_REFRESH_MS, PURGE_BATCH } from "../src/domain/inbox";
import { verifyQuotes } from "../src/federation/quotes";
import type { StoreStub } from "../src/platform/store-client";
import { bearer, sql } from "./api-helpers";
import { countingStore, harness, inboxDeps, NOW } from "./app-helpers";
import { mastodonDelete, mastodonSigned } from "./author-proof-helpers";
import { fixtureKeyGen } from "./federation-helpers";
import { BUILD } from "./helpers";
import { MASTODON, mastodonActor, serveWebFinger, signedInit, type TestActor } from "./inbox-helpers";
import {
  ALICE_URI,
  announce,
  AS,
  create,
  followed,
  mastodonNote,
  nextId,
  OTHER,
  setup,
  type Setup,
} from "./inbox-status-helpers";
import { quoting, serveStamp } from "./quote-helpers";

// A 410 at an actor's URI (federation/actor-gone.ts, domain/inbox.ts actorGone, ID-1, ID-7): a stored remote actor
// whose own URI answers 410, with no redirect, is deleted as by its Delete (the purge job, deleted_at, a round asked
// for), under the revision read before that fetch (ID-1); a 404, a redirected 410, a 410 fetched before another store
// of the actor committed, a 410 of an actor never stored and a probe's 410 delete nothing. One case per path that
// fetches an actor's document and can see its 410.

const iso = (at: number) => new Date(at).toISOString();

// The fetches a test holds and the requests it leaves running, released and settled after each test, also when an
// assertion failed before the test released them (docs/engineering.md, "Tests").
const holds: { release: () => void }[] = [];
const outstanding: Promise<unknown>[] = [];
afterEach(async () => {
  for (const held of holds.splice(0)) {
    held.release();
  }
  await Promise.allSettled(outstanding.splice(0));
});
function hold(t: Setup, url: string) {
  const held = t.web.hold(url, { snapshot: true });
  holds.push(held);
  return held;
}
function track<T>(request: Promise<T>): Promise<T> {
  outstanding.push(request);
  return request;
}

// More statuses of `uri` than one purge batch removes, so the deletion is still running after the request.
async function seedStatuses(store: StoreStub, uri: string, prefix = 3): Promise<void> {
  await sql(
    store,
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
		INSERT INTO statuses (id, uri, account_id, visibility, published_at)
		SELECT printf('%d%017d', ?3, i), ?2 || '/seeded/' || i, (SELECT id FROM accounts WHERE uri = ?2), 'public',
			'2026-10-01T00:00:00.000Z' FROM n`,
    PURGE_BATCH * 2 + 1,
    uri,
    prefix,
  );
}

// Whether the deletion of `uri` started: its deleted_at and its purge jobs.
async function deletion(store: StoreStub, uri: string) {
  const [row] = await sql<{ deleted_at: string | null }>(store, "SELECT deleted_at FROM accounts WHERE uri = ?", uri);
  const [jobs] = await sql<{ n: number }>(
    store,
    "SELECT count(*) AS n FROM inbound_jobs WHERE kind = 'purge' AND key = ?",
    uri,
  );
  return { stored: row !== undefined, deletedAt: row?.deleted_at ?? null, purges: jobs!.n };
}

const started = { stored: true, deletedAt: iso(NOW), purges: 1 };
const untouched = { stored: true, deletedAt: null, purges: 0 };

// Whether the requests since `t.queue.pending` was emptied asked the Queue for a jobs round.
const roundAsked = (t: Setup) =>
  t.queue.pending.some((message) => (message.body as { kind?: string }).kind === "inbound-jobs");

// bob (mastodon.example), followed by alice, with more statuses than a purge batch.
async function bobWorld() {
  const t = await setup();
  const bob = await mastodonActor(t.web, "bob");
  await followed(t, bob);
  await seedStatuses(t.store, bob.uri);
  t.web.fetched.length = 0;
  t.queue.pending.length = 0;
  return { t, bob };
}

const updateOf = (actor: TestActor) => ({
  "@context": AS,
  id: `${actor.uri}#updates/${nextId()}`,
  type: "Update",
  actor: actor.uri,
  object: actor.document,
});
const followOf = (actor: TestActor) => ({
  "@context": AS,
  id: `${actor.uri}#follows/${nextId()}`,
  type: "Follow",
  actor: actor.uri,
  object: ALICE_URI,
});

describe("each path that fetches a stored actor's document", () => {
  it.each([
    [410, 202, started],
    [404, 401, untouched],
  ] as const)("the inbox actor's Update(Person) answering %i", async (status, answer, expected) => {
    const { t, bob } = await bobWorld();
    t.web.fail(bob.uri, status);
    expect(await t.post(bob, updateOf(bob))).toBe(answer);
    expect(await deletion(t.store, bob.uri)).toEqual(expected);
    expect(roundAsked(t)).toBe(status === 410);
  });

  // The stored key a day old: its verification fetches bob's document, which is gone; the actor's document is that
  // same fetch (the memo), so it is fetched once.
  it.each([
    [410, 202, started],
    [404, 401, untouched],
  ] as const)("a stale stored key whose actor answers %i", async (status, answer, expected) => {
    const { t, bob } = await bobWorld();
    await sql(t.store, "UPDATE remote_keys SET fetched_at = ?", NOW - KEY_REFRESH_MS);
    t.web.fail(bob.uri, status);
    expect(await t.post(bob, followOf(bob))).toBe(answer);
    expect(t.web.fetched.filter((url) => url === bob.uri)).toHaveLength(1);
    expect(await deletion(t.store, bob.uri)).toEqual(expected);
    expect(roundAsked(t)).toBe(status === 410);
  });

  // dan relays bob's LD-signed Delete of his status; the proof's author document is gone.
  it.each([
    [410, started],
    [404, untouched],
  ] as const)("the author of a relayed Delete answering %i", async (status, expected) => {
    const { t, bob } = await bobWorld();
    const note = mastodonNote(bob);
    expect(await t.post(bob, create(bob, note))).toBe(202);
    const dan = await mastodonActor(t.web, "dan", { origin: "https://relay.example", key: 6 });
    const signed = await mastodonSigned(mastodonDelete(bob, note.id, `${note.id}#delete-${nextId()}`), bob);
    t.queue.pending.length = 0;
    t.web.fail(bob.uri, status);
    expect(await t.post(dan, signed)).toBe(202);
    expect(await deletion(t.store, bob.uri)).toEqual(expected);
    expect(roundAsked(t)).toBe(status === 410);
  });

  // bob's own LD-signed Delete of a status alice boosted: the Store asks for its proof (forwarding), whose author
  // document is gone.
  it.each([
    [410, started],
    [404, untouched],
  ] as const)("the author proof of a forwarded Delete answering %i", async (status, expected) => {
    const { t, bob } = await bobWorld();
    const note = mastodonNote(bob);
    expect(await t.post(bob, create(bob, note))).toBe(202);
    const [row] = await sql<{ id: string }>(t.store, "SELECT id FROM statuses WHERE uri = ?", note.id);
    expect(
      (await t.request(`/api/v1/statuses/${row!.id}/reblog`, bearer(t.tokens.alice, { method: "POST" }))).status,
    ).toBe(200);
    t.queue.pending.length = 0;
    t.web.fetched.length = 0;
    t.web.fail(bob.uri, status);
    const signed = await mastodonSigned(mastodonDelete(bob, note.id, `${note.id}#delete-${nextId()}`), bob);
    expect(await t.post(bob, signed)).toBe(202);
    // The proof round ran: bob's document was fetched for it.
    expect(t.web.fetched).toContain(bob.uri);
    expect(await deletion(t.store, bob.uri)).toEqual(expected);
    expect(roundAsked(t)).toBe(status === 410);
  });

  it.each([
    [410, started],
    [404, untouched],
  ] as const)("a Move target answering %i", async (status, expected) => {
    const { t, bob } = await bobWorld();
    const carol = await mastodonActor(t.web, "carol", { origin: OTHER, key: 2, extra: { alsoKnownAs: [bob.uri] } });
    await followed(t, carol);
    await seedStatuses(t.store, carol.uri, 4);
    t.queue.pending.length = 0;
    t.web.fail(carol.uri, status);
    const move = {
      "@context": AS,
      id: `${bob.uri}#moves/${nextId()}`,
      type: "Move",
      actor: bob.uri,
      object: bob.uri,
      target: carol.uri,
    };
    expect(await t.post(bob, move)).toBe(202);
    expect(await deletion(t.store, carol.uri)).toEqual(expected);
    expect(await deletion(t.store, bob.uri)).toEqual(untouched);
    expect(roundAsked(t)).toBe(status === 410);
  });

  // erin, stored by a first boost and aged a day: bob's boost of her new status refreshes her first.
  it.each([
    [410, started],
    [404, untouched],
  ] as const)("a stale author's refresh answering %i", async (status, expected) => {
    const { t, bob } = await bobWorld();
    const erin = await mastodonActor(t.web, "erin", { origin: OTHER, key: 3 });
    const first = mastodonNote(erin);
    t.web.serve(first.id, { "@context": AS, ...first });
    expect(await t.post(bob, announce(bob, first.id))).toBe(202);
    await seedStatuses(t.store, erin.uri, 4);
    await sql(t.store, "UPDATE accounts SET fetched_at = ? WHERE uri = ?", iso(NOW - KEY_REFRESH_MS), erin.uri);
    const second = mastodonNote(erin);
    t.web.serve(second.id, { "@context": AS, ...second });
    t.queue.pending.length = 0;
    t.web.fetched.length = 0;
    t.web.fail(erin.uri, status);
    expect(await t.post(bob, announce(bob, second.id))).toBe(202);
    expect(t.web.fetched).toEqual([second.id, erin.uri]);
    expect(await deletion(t.store, erin.uri)).toEqual(expected);
    expect(roundAsked(t)).toBe(status === 410);
  });

  // erin, stored and aged a day, is the author of a status bob quotes: the verification's author stage refetches her.
  it.each([
    [410, started],
    [404, untouched],
  ] as const)("a quoted author's refresh answering %i", async (status, expected) => {
    const { t, bob } = await bobWorld();
    const erin = await mastodonActor(t.web, "erin", { origin: OTHER, key: 7 });
    await followed(t, erin);
    await seedStatuses(t.store, erin.uri, 4);
    await sql(t.store, "UPDATE accounts SET fetched_at = ? WHERE uri = ?", iso(NOW - KEY_REFRESH_MS), erin.uri);
    const target = mastodonNote(erin);
    t.web.serve(target.id, { "@context": AS, ...target });
    const stamp = `${erin.uri}/quote_authorizations/${nextId()}`;
    const quote = quoting(bob, target.id, stamp);
    serveStamp(t.web, stamp, erin, quote.id, target.id);
    expect(await t.post(bob, create(bob, quote))).toBe(202);
    t.web.fetched.length = 0;
    t.web.fail(erin.uri, status);
    const more = await verifyQuotes(t.env, { ...inboxDeps(() => t.store, t.web.loader), now: () => NOW });
    // The quoted stage, then the author stage (the work may go on to the quoted status again).
    expect(t.web.fetched.slice(0, 2)).toEqual([target.id, erin.uri]);
    expect(await deletion(t.store, erin.uri)).toEqual(expected);
    // The round asks for another: the purge has a batch left.
    if (status === 410) {
      expect(more).toBe(true);
    }
  });

  it.each([
    [410, started],
    [404, untouched],
  ] as const)("a search for a stored actor's address answering %i", async (status, expected) => {
    const { t, bob } = await bobWorld();
    serveWebFinger(t.web, "acct:bob@mastodon.example", "acct:bob@mastodon.example", bob.uri);
    t.web.fail(bob.uri, status);
    const found = await t.api(
      `/api/v2/search?resolve=true&type=accounts&q=${encodeURIComponent("bob@mastodon.example")}`,
    );
    expect(found.status).toBe(200);
    expect(t.web.fetched).toContain(bob.uri);
    expect(await deletion(t.store, bob.uri)).toEqual(expected);
    expect(roundAsked(t)).toBe(status === 410);
  });

  // The URL is a stored actor's id: its revision is read before any fetch, and the URL is fetched as that actor.
  it.each([
    [410, started],
    [404, untouched],
  ] as const)("a search for a stored actor's URL answering %i", async (status, expected) => {
    const { t, bob } = await bobWorld();
    t.web.fail(bob.uri, status);
    const found = await t.api(`/api/v2/search?resolve=true&type=accounts&q=${encodeURIComponent(bob.uri)}`);
    expect(found.status).toBe(200);
    expect(t.web.fetched).toEqual([bob.uri]);
    expect(await deletion(t.store, bob.uri)).toEqual(expected);
    expect(roundAsked(t)).toBe(status === 410);
  });

  // The control: a status URL's 410 is not its author's.
  it("a search for a status URL answering 410 deletes nothing", async () => {
    const { t, bob } = await bobWorld();
    const note = mastodonNote(bob);
    t.web.fail(note.id, 410);
    const found = await t.api(`/api/v2/search?resolve=true&q=${encodeURIComponent(note.id)}`);
    expect(found.status).toBe(200);
    expect(t.web.fetched).toEqual([note.id]);
    expect(await deletion(t.store, bob.uri)).toEqual(untouched);
  });
});

describe("a 410 that deletes nothing", () => {
  // bob's URI redirects, on its own origin, to a URL that answers 410: the 410 is not bob's own.
  it("after a same-origin redirect", async () => {
    const { t, bob } = await bobWorld();
    t.web.served.set(bob.uri, { status: 301, location: `${MASTODON}/retired` });
    t.web.fail(`${MASTODON}/retired`, 410);
    expect(await t.post(bob, updateOf(bob))).toBe(401);
    expect(t.web.fetched).toEqual([bob.uri, `${MASTODON}/retired`]);
    expect(await deletion(t.store, bob.uri)).toEqual(untouched);
  });

  // A request fetches bob's document, which answers 410, and is held there; bob's server answers again, and bob's
  // Update(Person) stores the document. The held 410 was fetched under the revision read before that store: an
  // Update(Person)'s, or a search for bob's URL, which reads his revision before any fetch.
  it.each([
    ["an Update(Person)", (t: Setup, bob: TestActor) => t.post(bob, updateOf(bob)), 202],
    [
      "a URL search",
      async (t: Setup, bob: TestActor) =>
        (await t.api(`/api/v2/search?resolve=true&type=accounts&q=${encodeURIComponent(bob.uri)}`)).status,
      200,
    ],
  ] as const)("fetched by %s before another store of the actor committed (ID-1)", async (_name, request, answer) => {
    const { t, bob } = await bobWorld();
    t.web.fail(bob.uri, 410);
    const held = hold(t, bob.uri);
    const pending = track(request(t, bob));
    await held.reached;
    t.web.serve(bob.uri, bob.document);
    expect(await t.post(bob, updateOf(bob))).toBe(202);
    held.release();
    expect(await pending).toBe(answer);
    expect(await deletion(t.store, bob.uri)).toEqual(untouched);
  });

  // carol was never stored: the Worker hands her 410 to the Store (no revision row: null), which finds no row.
  it("of an actor never stored, which writes nothing", async () => {
    const { t, bob } = await bobWorld();
    const counting = countingStore(t.store);
    const h = harness(counting.stub, {}, BUILD, { keygen: fixtureKeyGen, loader: t.web.loader }, () => NOW);
    const carol = `${OTHER}/users/carol`;
    t.web.fail(carol, 410);
    const move = {
      "@context": AS,
      id: `${bob.uri}#moves/${nextId()}`,
      type: "Move",
      actor: bob.uri,
      object: bob.uri,
      target: carol,
    };
    expect((await h.request("/inbox", await signedInit(bob, "/inbox", move, { at: NOW }))).status).toBe(202);
    const gone = counting.records.filter((record) => record.name === "actorGone");
    expect(gone.map((record) => [record.args[1], record.answer])).toEqual([
      [{ uri: carol, revision: null, now: NOW }, { jobsPending: false }],
    ]);
    expect(await deletion(t.store, carol)).toEqual({ stored: false, deletedAt: null, purges: 0 });
    expect(await sql(t.store, "SELECT kind FROM inbound_jobs WHERE key = ?", carol)).toEqual([]);
  });

  it("of a local actor, which the Store never touches (ID-3)", async () => {
    const { t, bob } = await bobWorld();
    expect(await t.store.actorGone(BUILD, { uri: ALICE_URI, revision: null, now: NOW })).toEqual({
      jobsPending: false,
    });
    const [alice] = await sql(t.store, "SELECT deleted_at FROM accounts WHERE uri = ?", ALICE_URI);
    expect(alice).toEqual({ deleted_at: null });
    expect(await sql(t.store, "SELECT kind FROM inbound_jobs WHERE key = ?", ALICE_URI)).toEqual([]);
    // The same call for a stored remote actor under its revision deletes it (the branch ran).
    const [stored] = await sql<{ revision: number }>(
      t.store,
      "SELECT document_revision AS revision FROM accounts WHERE uri = ?",
      bob.uri,
    );
    const revision = stored!.revision;
    expect(await t.store.actorGone(BUILD, { uri: bob.uri, revision, now: NOW })).toEqual({ jobsPending: true });
    expect(await deletion(t.store, bob.uri)).toEqual(started);
  });
});
