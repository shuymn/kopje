import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Db } from "../src/db/sql";
import { QUOTE_AUTHOR_FETCHES, QUOTE_HOPS, QUOTE_LEASE_MS, type QuoteVerification } from "../src/domain/quotes";
import { ACCOUNT_STALE_MS } from "../src/domain/remote-actors";
import { MAX_REMOTE_PINS } from "../src/domain/remote-collections";
import { suspendRemote } from "../src/domain/remote-suspension";
import { REPLIES_COOLDOWN_MS, REPLIES_INITIAL_WAIT_MS } from "../src/domain/reply-walk-reads";
import {
  NODE_ATTEMPTS,
  REPLY_READ_ENTRIES,
  REPLY_WALK_LEASE_MS,
  type ReplyStepInput,
  WALK_STATUSES,
} from "../src/domain/reply-walks";
import { syncCollections } from "../src/federation/collections";
import { REQUEST_MAX_FETCHES } from "../src/federation/loader";
import { verifyQuotes } from "../src/federation/quotes";
import { REPLY_STEPS_PER_WALK, REPLY_WALKS_PER_ROUND, walkReplies } from "../src/federation/replies";
import { jobsRound } from "../src/jobs/queue";
import { STATUS_URI_LIMIT } from "../src/platform/identity-bounds";
import type { StoreStub } from "../src/platform/store-client";
import { StoreUnavailableError } from "../src/platform/store-errors";
import { sql } from "./api-helpers";
import { countingStore, inboxDeps, NOW } from "./app-helpers";
import { blockDomain } from "./domain-block-helpers";
import { LOCAL, mastodonActor, type TestActor } from "./inbox-helpers";
import {
  accountId,
  ALICE,
  ALICE_URI,
  AS,
  create,
  DAVE,
  followed,
  mastodonNote,
  nextId,
  type Note,
  type Setup,
  setup,
  statusRow,
} from "./inbox-status-helpers";
import { quoting, serveFeatured, serveStamp } from "./quote-helpers";
import {
  reply,
  serveNote,
  startWalk,
  storedOf,
  storedRoot,
  walkNodes,
  walkRounds,
  walkRow,
  withReplies,
} from "./reply-walk-helpers";

// Walks of remote replies collections end to end (federation/replies.ts, domain/reply-walks.ts): the replies family's
// job rounds over Mastodon-shaped threads served by a synthetic remote web. The Store's clock is the faked Date.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

const OTHER_ORIGIN = "https://other.example";
const INSTANCE_KEY = `${LOCAL}/actor#main-key`;

// The root author on mastodon.example and bob on other.example, neither known to the instance before the root's
// Create stores the root author.
async function world() {
  const t = await setup();
  const root = await mastodonActor(t.web, "root");
  const bob = await mastodonActor(t.web, "bob", { origin: OTHER_ORIGIN, key: 1 });
  return { t, root, bob };
}

// The root `note` listing `items` in its embedded first page (none further), stored by its delivered Create, and a
// walk of it started; returns the root's id.
async function walkOf(t: Setup, root: TestActor, note: Note, items: unknown[]) {
  serveNote(t.web, withReplies(t.web, note, items as string[]));
  const id = await storedRoot(t, root, note);
  await startWalk(t.store, id, Date.now());
  return { id };
}

const fetches = (t: Setup, url: string) => t.web.fetched.filter((fetched) => fetched === url).length;

describe("a walk of a Mastodon thread", () => {
  it("stores the replies its collections list, each linked under the root, signed by the instance actor", async () => {
    const { t, root, bob } = await world();
    const note = mastodonNote(root);
    const self = reply(t.web, root, note.id);
    const other = reply(t.web, bob, note.id);
    const nested = reply(t.web, root, other.id);
    serveNote(t.web, withReplies(t.web, other, [], [nested.id]));
    serveNote(t.web, withReplies(t.web, note, [self.id], [other.id]));
    const rootId = await storedRoot(t, root, note);
    const signed = t.web.signers.length;
    await startWalk(t.store, rootId, NOW);
    await walkRounds(t);
    expect(await storedOf(t.store, [self.id, other.id, nested.id])).toEqual([self.id, other.id, nested.id]);
    expect((await statusRow(t.store, self.id))?.in_reply_to_id).toBe(rootId);
    expect((await statusRow(t.store, other.id))?.in_reply_to_id).toBe(rootId);
    expect((await statusRow(t.store, nested.id))?.in_reply_to_id).toBe((await statusRow(t.store, other.id))?.id);
    expect(await walkRow(t.store, rootId)).toMatchObject({
      due_at: null,
      finished_at: NOW,
      token: null,
      result_count: 3,
      pages: 2,
    });
    expect(await walkNodes(t.store, rootId)).toEqual([]);
    // bob, unknown, was fetched and stored with his reply (the Announce original's author step).
    expect(await accountId(t.store, bob.uri)).toBeDefined();
    expect(t.web.fetched).toContain(bob.uri);
    // DATA-7: every fetch of the walk signed as the instance actor; nothing of this instance's origin requested.
    expect(new Set(t.web.signers.slice(signed))).toEqual(new Set([INSTANCE_KEY]));
    expect(t.web.fetched.filter((url) => url.startsWith(LOCAL))).toEqual([]);
  });

  it("refetches a stale stored author before its reply, under the revision read with the need", async () => {
    const { t, root, bob } = await world();
    await followed(t, bob, DAVE);
    const bobId = (await accountId(t.store, bob.uri))!;
    await sql(t.store, "UPDATE accounts SET fetched_at = '2026-01-01T00:00:00.000Z' WHERE id = ?", bobId);
    bob.document.name = "bob refreshed";
    t.web.serve(bob.uri, bob.document);
    const note = mastodonNote(root);
    const answer = reply(t.web, bob, note.id);
    await walkOf(t, root, note, [answer.id]);
    const before = fetches(t, bob.uri);
    await walkRounds(t);
    expect(await storedOf(t.store, [answer.id])).toEqual([answer.id]);
    expect(fetches(t, bob.uri)).toBe(before + 1);
    expect((await sql(t.store, "SELECT display_name, fetched_at FROM accounts WHERE id = ?", bobId))[0]).toEqual({
      display_name: "bob refreshed",
      fetched_at: new Date(NOW).toISOString(),
    });
  });
});

// ID-2: a node is stored and its collection read only when its parent is a valid node of the walk and its stored row
// links to that node's status. Each case has a reply that is stored beside it (G), so the walk did read the root.
describe("stores only the thread", () => {
  it("stores no self-parent, no two-node cycle, no reply of a rejected node or of no node; reads none of their collections", async () => {
    const { t, root, bob } = await world();
    const note = mastodonNote(root);
    const g = reply(t.web, bob, note.id);
    const self = mastodonNote(bob);
    self.inReplyTo = self.id;
    const a = mastodonNote(bob);
    const b = mastodonNote(bob, { inReplyTo: a.id });
    a.inReplyTo = b.id;
    const rejected = mastodonNote(bob, { inReplyTo: `${OTHER_ORIGIN}/users/bob/statuses/elsewhere` });
    const underRejected = mastodonNote(bob, { inReplyTo: rejected.id });
    const children = [self, a, b, rejected].map((parent) => reply(t.web, bob, parent.id));
    for (const [i, parent] of [self, a, b, rejected].entries()) {
      serveNote(t.web, withReplies(t.web, parent, [], [children[i]!.id]));
    }
    withReplies(t.web, underRejected, []);
    serveNote(t.web, underRejected);
    const { id } = await walkOf(t, root, note, [self.id, a.id, b.id, rejected.id, underRejected.id, g.id]);
    await walkRounds(t);
    expect(await storedOf(t.store, [g.id])).toEqual([g.id]);
    const others = [self, a, b, rejected, underRejected, ...children].map((n) => n.id);
    expect(await storedOf(t.store, others)).toEqual([]);
    // Their collections and their listed children were never requested.
    for (const parent of [self, a, b, rejected]) {
      expect(t.web.fetched.filter((url) => url.startsWith(`${parent.id}/replies`))).toEqual([]);
    }
    for (const child of children) {
      expect(fetches(t, child.id)).toBe(0);
    }
    expect((await walkRow(t.store, id))?.result_count).toBe(1);
  });

  it("stores a reply listed before its parent once the parent is, fetching it twice", async () => {
    const { t, root, bob } = await world();
    const note = mastodonNote(root);
    const parent = reply(t.web, bob, note.id);
    const child = reply(t.web, bob, parent.id);
    const { id } = await walkOf(t, root, note, [child.id, parent.id]);
    await walkRounds(t);
    expect(await storedOf(t.store, [child.id, parent.id])).toEqual([child.id, parent.id]);
    expect((await statusRow(t.store, child.id))?.in_reply_to_id).toBe((await statusRow(t.store, parent.id))?.id);
    // Fetched again from the remote after its parent was stored: never from a cache (NET-4).
    expect(fetches(t, child.id)).toBe(NODE_ATTEMPTS);
    expect((await walkRow(t.store, id))?.result_count).toBe(2);
  });

  it("judges a stored status by its stored row, not by its fetched document, and does not update it", async () => {
    const { t, root, bob } = await world();
    await followed(t, bob, DAVE);
    const note = mastodonNote(root);
    serveNote(t.web, withReplies(t.web, note, []));
    const rootId = await storedRoot(t, root, note);
    // outside: a status of bob's outside the thread. elsewhere's row replies to it, linked; inside's to the root.
    const outside = mastodonNote(bob);
    expect(await t.post(bob, create(bob, outside))).toBe(202);
    const elsewhere = mastodonNote(bob, { inReplyTo: outside.id, replies: undefined });
    const inside = mastodonNote(bob, { inReplyTo: note.id, replies: undefined });
    for (const status of [elsewhere, inside]) {
      expect(await t.post(bob, create(bob, status))).toBe(202);
    }
    // Their documents now name the other parent, and other content; each lists a reply of its own by its collection.
    const childOfElsewhere = reply(t.web, bob, elsewhere.id);
    const childOfInside = reply(t.web, bob, inside.id);
    for (const [status, parent, child] of [
      [elsewhere, note.id, childOfElsewhere],
      [inside, outside.id, childOfInside],
    ] as const) {
      const collection = `${status.id}/replies`;
      t.web.serve(collection, { "@context": AS, id: collection, type: "OrderedCollection", orderedItems: [child.id] });
      serveNote(t.web, { ...status, inReplyTo: parent, content: "<p>edited</p>", replies: collection });
    }
    const before = await statusRow(t.store, inside.id);
    serveNote(t.web, withReplies(t.web, note, [elsewhere.id, inside.id]));
    await startWalk(t.store, rootId, NOW);
    await walkRounds(t);
    expect(await storedOf(t.store, [childOfInside.id, childOfElsewhere.id])).toEqual([childOfInside.id]);
    expect(t.web.fetched).not.toContain(`${elsewhere.id}/replies`);
    expect(t.web.fetched).toContain(`${inside.id}/replies`);
    // Neither stored status was updated: content and parent as stored.
    expect(await statusRow(t.store, inside.id)).toEqual({ ...before, replies_count: before!.replies_count + 1 });
    expect((await statusRow(t.store, elsewhere.id))?.content).not.toContain("edited");
  });

  it("leaves a stored cycle invalid: neither status's collection is requested", async () => {
    const { t, root, bob } = await world();
    await followed(t, bob, DAVE);
    const note = mastodonNote(root);
    const g = reply(t.web, bob, note.id);
    serveNote(t.web, withReplies(t.web, note, []));
    const rootId = await storedRoot(t, root, note);
    // a replies to b and b to a, as stored: a arrives first (unlinked), then b links it.
    const a = mastodonNote(bob, { replies: undefined });
    const b = mastodonNote(bob, { inReplyTo: a.id, replies: undefined });
    a.inReplyTo = b.id;
    expect(await t.post(bob, create(bob, a))).toBe(202);
    expect(await t.post(bob, create(bob, b))).toBe(202);
    const aId = (await statusRow(t.store, a.id))!.id;
    const bId = (await statusRow(t.store, b.id))!.id;
    expect([
      (await statusRow(t.store, a.id))?.in_reply_to_id,
      (await statusRow(t.store, b.id))?.in_reply_to_id,
    ]).toEqual([bId, aId]);
    // Fetched, each names the root.
    for (const status of [a, b]) {
      serveNote(t.web, { ...status, inReplyTo: note.id, replies: `${status.id}/replies` });
    }
    serveNote(t.web, withReplies(t.web, note, [a.id, b.id, g.id]));
    await startWalk(t.store, rootId, NOW);
    await walkRounds(t);
    expect(await storedOf(t.store, [g.id])).toEqual([g.id]);
    expect(t.web.fetched.filter((url) => url.endsWith("/replies"))).toEqual([]);
  });

  it("takes only the ids of embedded items: an item whose id answers 404 is not stored", async () => {
    const { t, root, bob } = await world();
    const note = mastodonNote(root);
    const g = reply(t.web, bob, note.id);
    const embedded = { ...mastodonNote(bob, { inReplyTo: note.id }), "@context": AS };
    // Served nowhere: only a fetch of its id could store it.
    const { id } = await walkOf(t, root, note, [embedded, g.id]);
    await walkRounds(t);
    expect(await storedOf(t.store, [embedded.id, g.id])).toEqual([g.id]);
    expect(fetches(t, embedded.id)).toBe(1);
    expect((await walkRow(t.store, id))?.result_count).toBe(1);
  });
});

describe("stored items", () => {
  it("records no stored status published within REPLIES_INITIAL_WAIT_MS or refreshed within REPLIES_COOLDOWN_MS", async () => {
    const { t, root, bob } = await world();
    await followed(t, bob, DAVE);
    const note = mastodonNote(root);
    serveNote(t.web, withReplies(t.web, note, []));
    const rootId = await storedRoot(t, root, note);
    // Three stored replies, each listing a reply of its own: one just published, one whose own refresh started
    // within the cooldown, and one older with none (the one recorded).
    const at = (ms: number) => new Date(ms).toISOString();
    const recent = mastodonNote(bob, { inReplyTo: note.id, published: at(NOW - REPLIES_INITIAL_WAIT_MS + 1000) });
    const cooling = mastodonNote(bob, { inReplyTo: note.id });
    const older = mastodonNote(bob, { inReplyTo: note.id });
    const children = [recent, cooling, older].map((status) => reply(t.web, bob, status.id));
    for (const [i, status] of [recent, cooling, older].entries()) {
      serveNote(t.web, withReplies(t.web, status, [children[i]!.id]));
      expect(await t.post(bob, create(bob, status))).toBe(202);
    }
    const coolingId = (await statusRow(t.store, cooling.id))!.id;
    await sql(
      t.store,
      `INSERT INTO reply_walks (status_id, kind, refresh_id, queued_at, due_at, finished_at)
			VALUES (?, 0, '${"c".repeat(32)}', ?2, NULL, ?2)`,
      coolingId,
      NOW - REPLIES_COOLDOWN_MS + 1000,
    );
    serveNote(t.web, withReplies(t.web, note, [recent.id, cooling.id, older.id]));
    await startWalk(t.store, rootId, NOW);
    await walkRounds(t);
    expect(fetches(t, older.id)).toBe(1);
    expect([fetches(t, recent.id), fetches(t, cooling.id)]).toEqual([0, 0]);
    expect(
      await storedOf(
        t.store,
        children.map((child) => child.id),
      ),
    ).toEqual([children[2]!.id]);
    expect((await walkRow(t.store, rootId))?.nodes).toBe(3);
  });
});

describe("origins", () => {
  it("fetches no collection or page of another origin, and records no item of this instance's origin", async () => {
    const { t, root, bob } = await world();
    const note = mastodonNote(root);
    const g = reply(t.web, bob, note.id);
    // g's collection is on bob's origin (requested); h's names a page on another origin, which is never charged.
    const h = reply(t.web, bob, note.id);
    const foreign = `https://elsewhere.example/replies/${nextId()}`;
    const hidden = reply(t.web, bob, h.id);
    t.web.serve(foreign, { "@context": AS, id: foreign, type: "CollectionPage", items: [hidden.id] });
    serveNote(t.web, { ...h, replies: { id: `${h.id}/replies`, type: "Collection", first: foreign } });
    const nested = reply(t.web, bob, g.id);
    serveNote(t.web, withReplies(t.web, g, [], [nested.id]));
    const local = `${LOCAL}/ap/statuses/1`;
    const { id } = await walkOf(t, root, note, [local, g.id, h.id]);
    await walkRounds(t);
    expect(await storedOf(t.store, [g.id, h.id, nested.id, hidden.id])).toEqual([g.id, h.id, nested.id]);
    expect(t.web.fetched.filter((url) => !url.startsWith(MASTODON_ORIGIN) && !url.startsWith(OTHER_ORIGIN))).toEqual(
      [],
    );
    // Nodes: the root, g, h, nested; pages: g's page only.
    expect(await walkRow(t.store, id)).toMatchObject({ nodes: 4, pages: 1, result_count: 3 });
  });

  it("requests nothing of an instance-blocked host, and stores nothing of a suspended author", async () => {
    const { t, root, bob } = await world();
    const carol = await mastodonActor(t.web, "carol", { origin: "https://third.example", key: 2 });
    const blocked = await mastodonActor(t.web, "eve", { origin: "https://blocked.example", key: 3 });
    const carolId = await followed(t, carol, DAVE);
    await runInDurableObject(t.store, (_instance, state) =>
      state.storage.transactionSync(() => suspendRemote(new Db(state.storage.sql), carolId, null, NOW)),
    );
    await blockDomain(t.store, "blocked.example");
    const note = mastodonNote(root);
    const g = reply(t.web, bob, note.id);
    const ofBlocked = reply(t.web, blocked, note.id);
    const ofSuspended = reply(t.web, carol, note.id);
    await walkOf(t, root, note, [ofBlocked.id, ofSuspended.id, g.id]);
    await walkRounds(t);
    expect(await storedOf(t.store, [ofBlocked.id, ofSuspended.id, g.id])).toEqual([g.id]);
    expect(t.web.fetched.filter((url) => url.startsWith("https://blocked.example"))).toEqual([]);
    expect(fetches(t, ofSuspended.id)).toBe(1);
  });
});

const MASTODON_ORIGIN = "https://mastodon.example";

describe("failures", () => {
  it("ends a node whose document answers 5xx twice, 404, or is not ActivityPub; the rest of the walk goes on", async () => {
    const { t, root, bob } = await world();
    const note = mastodonNote(root);
    const g = reply(t.web, bob, note.id);
    const failing = `${OTHER_ORIGIN}/users/bob/statuses/failing`;
    const missing = `${OTHER_ORIGIN}/users/bob/statuses/missing`;
    const html = `${OTHER_ORIGIN}/users/bob/statuses/html`;
    t.web.fail(failing, 503);
    t.web.serve(html, "<p>not a status</p>", "text/html");
    const { id } = await walkOf(t, root, note, [failing, missing, html, g.id]);
    await walkRounds(t);
    expect(await storedOf(t.store, [g.id])).toEqual([g.id]);
    // A failure that may pass is retried once at the end of the walk; the others end at once.
    expect([fetches(t, failing), fetches(t, missing), fetches(t, html)]).toEqual([NODE_ATTEMPTS, 1, 1]);
    expect(await walkRow(t.store, id)).toMatchObject({ finished_at: NOW, result_count: 1 });
  });

  it("retries a slow remote once, then drops it", { timeout: 60_000 }, async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    const { t, root, bob } = await world();
    const note = mastodonNote(root);
    const g = reply(t.web, bob, note.id);
    const slow = reply(t.web, bob, note.id);
    t.web.delay(slow.id, 6_000);
    await walkOf(t, root, note, [slow.id, g.id]);
    await walkRounds(t);
    expect(await storedOf(t.store, [slow.id, g.id])).toEqual([g.id]);
    expect(fetches(t, slow.id)).toBe(NODE_ATTEMPTS);
  });
});

// The Store with completeReplyStep failing as a dropped round does (the Store refusing), for the steps `drop` picks.
function droppingStore(store: StoreStub, drop: (input: { step: { uri: string } }) => boolean): StoreStub {
  return new Proxy(store, {
    get: (target, name) => {
      const value = Reflect.get(target, name) as unknown;
      if (name !== "completeReplyStep" || typeof value !== "function") {
        return value;
      }
      return async (build: string, input: { step: { uri: string } }) => {
        if (drop(input)) {
          throw new StoreUnavailableError("maintenance");
        }
        return (target as unknown as Record<string, (b: string, i: unknown) => Promise<unknown>>)[name]!(build, input);
      };
    },
  });
}

describe("charges", () => {
  it("ends a node fetched by two rounds that died after the fetch, at the next claim, with no request (crash after fetch)", async () => {
    const { t, root, bob } = await world();
    const note = mastodonNote(root);
    const x = reply(t.web, bob, note.id);
    const { id } = await walkOf(t, root, note, [x.id]);
    const dropping = droppingStore(t.store, (input) => input.step.uri === x.id);
    const deps = inboxDeps(() => dropping, t.web.loader);
    for (let round = 1; round <= NODE_ATTEMPTS; round++) {
      await expect(walkReplies(t.env, deps)).rejects.toThrow(StoreUnavailableError);
      expect(fetches(t, x.id)).toBe(round);
      expect((await walkNodes(t.store, id)).find((node) => node.uri === x.id)?.attempts).toBe(round);
      // Within the lease nothing is claimed; after it the walk is claimed again.
      expect(await walkReplies(t.env, deps)).toBe(false);
      vi.setSystemTime(Date.now() + REPLY_WALK_LEASE_MS + 1);
    }
    expect(await walkReplies(t.env, deps)).toBe(false);
    expect(fetches(t, x.id)).toBe(NODE_ATTEMPTS);
    expect(await storedOf(t.store, [x.id])).toEqual([]);
    expect(await walkRow(t.store, id)).toMatchObject({ due_at: null, token: null });
  });

  it("hands out nothing at the round's last step: the reply it returns is fetched by the next claim", async () => {
    const { t, root, bob } = await world();
    await followed(t, bob, DAVE);
    const note = mastodonNote(root);
    // R's first page lists X, A to E, and P (no further replies); X replies to P. bob is known: one completion a step.
    const p = reply(t.web, bob, note.id);
    const x = reply(t.web, bob, p.id);
    const others = Array.from({ length: 5 }, () => reply(t.web, bob, note.id));
    const { id } = await walkOf(t, root, note, [x.id, ...others.map((n) => n.id), p.id]);
    expect(1 + 1 + others.length + 1).toBe(REPLY_STEPS_PER_WALK);
    const counting = countingStore(t.store);
    const deps = inboxDeps(() => counting.stub, t.web.loader);
    expect(await walkReplies(t.env, deps)).toBe(false);
    const completions = counting.records.filter((record) => record.name === "completeReplyStep");
    // The turn's eighth step (P) is told no more and hands out nothing; X, returned, keeps one attempt.
    const last = completions[REPLY_STEPS_PER_WALK - 1]!;
    expect((last.args[1] as { step: { uri: string }; more: boolean }).step.uri).toBe(p.id);
    expect((last.args[1] as { more: boolean }).more).toBe(false);
    expect((last.answer as { next: unknown }).next).toBeNull();
    const claims = counting.records.filter((record) => record.name === "claimReplyWalk");
    expect(claims).toHaveLength(REPLY_WALKS_PER_ROUND);
    expect((claims[1]!.answer as { step: { uri: string } }).step.uri).toBe(x.id);
    expect(fetches(t, x.id)).toBe(NODE_ATTEMPTS);
    expect(await storedOf(t.store, [x.id, p.id])).toEqual([x.id, p.id]);
    expect((await walkRow(t.store, id))?.result_count).toBe(1 + others.length + 1);
  });

  it("bounds a round: two walks, eight steps each, within their fetch budgets, with the derived Store calls", async () => {
    const { t, root, bob } = await world();
    const walks: string[] = [];
    for (let i = 0; i < 2; i++) {
      const note = mastodonNote(root);
      const listed = Array.from({ length: REPLY_STEPS_PER_WALK + 2 }, () => reply(t.web, bob, note.id).id);
      walks.push((await walkOf(t, root, note, listed)).id);
    }
    // Queued a millisecond apart, so that the first walk, released, is due after the second.
    await sql(t.store, "UPDATE reply_walks SET queued_at = ?1, due_at = ?1 WHERE status_id = ?2", NOW - 2, walks[0]!);
    await sql(t.store, "UPDATE reply_walks SET queued_at = ?1, due_at = ?1 WHERE status_id = ?2", NOW - 1, walks[1]!);
    const counting = countingStore(t.store);
    const before = t.web.fetched.length;
    expect(
      await walkReplies(
        t.env,
        inboxDeps(() => counting.stub, t.web.loader),
      ),
    ).toBe(true);
    const completions = counting.calls.filter((name) => name === "completeReplyStep").length;
    // Each walk's turn: its root and seven replies (the first reply also needs bob, fetched in the same step).
    expect(completions).toBe(REPLY_WALKS_PER_ROUND * REPLY_STEPS_PER_WALK + 1);
    expect(t.web.fetched.length - before).toBeLessThanOrEqual(
      REPLY_WALKS_PER_ROUND * REPLY_STEPS_PER_WALK * REQUEST_MAX_FETCHES,
    );
    const own = ["instanceDomain", "claimReplyWalk", "completeReplyStep", "releaseReplyWalk"];
    const calls = counting.calls.filter((name) => own.includes(name)).length;
    expect(calls).toBeLessThanOrEqual(1 + REPLY_WALKS_PER_ROUND * (1 + REPLY_STEPS_PER_WALK * 2 + 1));
    for (const walk of walks) {
      expect((await walkNodes(t.store, walk)).filter((node) => node.state === 0).length).toBeGreaterThan(0);
    }
  });
});

describe("concurrency", () => {
  it("applies nothing of a step whose lease another round took", async () => {
    const { t, root, bob } = await world();
    await followed(t, bob, DAVE);
    const note = mastodonNote(root);
    const x = reply(t.web, bob, note.id);
    const { id } = await walkOf(t, root, note, [x.id]);
    const first = t.web.hold(x.id);
    const second = t.web.hold(x.id);
    const deps = inboxDeps(() => t.store, t.web.loader);
    const late = walkReplies(t.env, deps);
    await first.reached;
    vi.setSystemTime(NOW + REPLY_WALK_LEASE_MS + 1);
    const current = walkReplies(t.env, deps);
    await second.reached;
    // The first round's step completes under a claim the walk no longer holds: nothing changes.
    first.release();
    await late;
    expect(await storedOf(t.store, [x.id])).toEqual([]);
    expect((await walkNodes(t.store, id)).find((node) => node.uri === x.id)).toMatchObject({ state: 0, attempts: 2 });
    second.release();
    await current;
    expect(await storedOf(t.store, [x.id])).toEqual([x.id]);
    expect((await walkRow(t.store, id))?.result_count).toBe(1);
  });

  it("stores nothing of an author whose domain a block covers once the step's fetch returns", async () => {
    const { t, root, bob } = await world();
    const note = mastodonNote(root);
    const y = reply(t.web, bob, note.id);
    const x = reply(t.web, bob, note.id);
    await walkOf(t, root, note, [y.id, x.id]);
    const held = t.web.hold(x.id);
    const round = walkReplies(
      t.env,
      inboxDeps(() => t.store, t.web.loader),
    );
    await held.reached;
    await blockDomain(t.store, "other.example");
    held.release();
    await round;
    await walkRounds(t);
    expect(await storedOf(t.store, [y.id, x.id])).toEqual([y.id]);
  });
});

const HOUR = 60 * 60 * 1000;

describe("notifications", () => {
  it("notifies a walk-stored reply's tagged local account and its author's subscriber only within the real-time window", async () => {
    // The root author's own replies (a reply to another account notifies no subscriber, as Mastodon's
    // FeedInsertWorker#notify?); dave subscribes to the author.
    const { t, root } = await world();
    await followed(t, root, DAVE);
    await sql(t.store, "UPDATE follows SET notify = 1 WHERE account_id = ?", DAVE);
    const note = mastodonNote(root);
    const tagging = (published: number) =>
      reply(t.web, root, note.id, {
        published: new Date(published).toISOString(),
        cc: [`${root.uri}/followers`, ALICE_URI],
        tag: [{ type: "Mention", href: ALICE_URI, name: "@alice" }],
      });
    const fresh = tagging(NOW - 60_000);
    const stale = tagging(NOW - 7 * HOUR);
    await walkOf(t, root, note, [fresh.id, stale.id]);
    await sql(t.store, "DELETE FROM notifications");
    await walkRounds(t);
    expect(await storedOf(t.store, [fresh.id, stale.id])).toEqual([fresh.id, stale.id]);
    const freshId = (await statusRow(t.store, fresh.id))!.id;
    expect(
      await sql(t.store, "SELECT account_id, type, status_id FROM notifications ORDER BY account_id, type"),
    ).toEqual([
      { account_id: ALICE, type: "mention", status_id: freshId },
      { account_id: DAVE, type: "status", status_id: freshId },
    ]);
  });
});

// The job rounds of every Worker family (walks, collection syncs, quote verifications), until two in a row find none
// due (work one family's round leaves is due for another's in the next).
async function allRounds(t: Setup): Promise<void> {
  const deps = inboxDeps(() => t.store, t.web.loader);
  for (let round = 0, idle = 0; idle < 2; round++) {
    expect(round).toBeLessThan(60);
    const walking = await walkReplies(t.env, deps);
    const syncing = await syncCollections(t.env, deps);
    const verifying = await verifyQuotes(t.env, deps);
    idle = walking || syncing || verifying ? 0 : idle + 1;
  }
}

// `author`'s Note quoting `target` by `quoted`, under a valid stamp of `quoted`, with `extra`, served.
function quotingServed(t: Setup, author: TestActor, target: string, quoted: TestActor, extra = {}): Note {
  const stamp = `${quoted.uri}/quote_authorizations/${nextId()}`;
  const note = quoting(author, target, stamp, extra);
  serveStamp(t.web, stamp, quoted, note.id, target);
  withReplies(t.web, note, []);
  return serveNote(t.web, note);
}

const quoteOf = async (t: Setup, uri: string) =>
  (
    await sql<{ state: string; hops: number }>(
      t.store,
      "SELECT q.state, q.hops FROM quotes q JOIN statuses s ON s.id = q.status_id WHERE s.uri = ?",
      uri,
    )
  )[0];

const requested = (t: Setup, actor: TestActor) =>
  t.web.fetched.some((url) => url.startsWith(new URL(actor.uri).origin));

describe("discovery a walk leads to (RES-6)", () => {
  async function authors(t: Setup, count: number, prefix = "a"): Promise<TestActor[]> {
    const made: TestActor[] = [];
    for (let i = 0; i < count; i++) {
      made.push(await mastodonActor(t.web, `${prefix}${i}`, { origin: `https://${prefix}${i}.example`, key: 10 + i }));
    }
    return made;
  }

  it("verifies a walk's reply's quote one hop deep: its quoted status's own quote is never followed", async () => {
    for (const delivered of [false, true]) {
      const { t, root, bob } = await world();
      const [carol, erin] = await authors(t, 2);
      const c = serveNote(t.web, withReplies(t.web, mastodonNote(erin!), []));
      const b = quotingServed(t, carol!, c.id, erin!);
      const note = mastodonNote(root);
      const w = quotingServed(t, bob, b.id, carol!, { inReplyTo: note.id });
      if (delivered) {
        // The same reply delivered: a root's budget, so its quoted status's quote is verified too.
        await followed(t, bob, DAVE);
        expect(await t.post(bob, create(bob, w))).toBe(202);
      } else {
        await walkOf(t, root, note, [w.id]);
      }
      await allRounds(t);
      expect(await quoteOf(t, w.id)).toEqual({ state: "accepted", hops: delivered ? QUOTE_HOPS : QUOTE_HOPS - 1 });
      expect(await quoteOf(t, b.id)).toMatchObject({ hops: delivered ? QUOTE_HOPS - 1 : QUOTE_HOPS - 2 });
      expect(requested(t, erin!)).toBe(delivered);
      expect(await storedOf(t.store, [c.id])).toEqual(delivered ? [c.id] : []);
      expect(await sql(t.store, "SELECT count(*) AS n FROM reply_walks")).toEqual([{ n: delivered ? 0 : 1 }]);
    }
  });

  it("starts no walk along an alternating reply and quote chain longer than a walk", { timeout: 120_000 }, async () => {
    const { t, root, bob } = await world();
    // Thread i: root_i by the root author, listing reply_i by bob, which quotes root_{i+1}.
    const roots = Array.from({ length: WALK_STATUSES + 1 }, () => mastodonNote(root));
    const replies = roots.map((r, i) =>
      i + 1 < roots.length
        ? quotingServed(t, bob, roots[i + 1]!.id, root, { inReplyTo: r.id })
        : reply(t.web, bob, r.id),
    );
    roots.forEach((r, i) => serveNote(t.web, withReplies(t.web, r, [replies[i]!.id])));
    const first = await storedRoot(t, root, roots[0]!);
    await startWalk(t.store, first, NOW);
    await allRounds(t);
    expect(await storedOf(t.store, [replies[0]!.id, roots[1]!.id, replies[1]!.id, roots[2]!.id])).toEqual([
      replies[0]!.id,
      roots[1]!.id,
    ]);
    expect(await quoteOf(t, replies[0]!.id)).toEqual({ state: "accepted", hops: QUOTE_HOPS - 1 });
    expect(t.web.fetched).not.toContain(replies[1]!.id);
    expect(t.web.fetched.filter((url) => url.startsWith(`${roots[1]!.id}/`))).toEqual([]);
    expect(t.web.fetched).not.toContain(roots[2]!.id);
    expect(await sql(t.store, "SELECT status_id FROM reply_walks")).toEqual([{ status_id: first }]);
  });

  it(
    "ends discovery at a new author's synced pin, along both alternating author chains",
    { timeout: 120_000 },
    async () => {
      const LINKS = QUOTE_HOPS + 3;
      // Chain 1: the reply's author A₀ pins P₀, which quotes S₁ by A₁, …
      {
        const { t, root } = await world();
        const a = await authors(t, LINKS);
        const s = a.map((author) => serveNote(t.web, withReplies(t.web, mastodonNote(author), [])));
        const p = a.slice(0, -1).map((author, i) => quotingServed(t, author, s[i + 1]!.id, a[i + 1]!));
        a.forEach((author, i) => serveFeatured(t.web, author, i < p.length ? [p[i]!.id] : []));
        const note = mastodonNote(root);
        const w = reply(t.web, a[0]!, note.id);
        await walkOf(t, root, note, [w.id]);
        await allRounds(t);
        expect(await storedOf(t.store, [w.id, p[0]!.id])).toEqual([w.id, p[0]!.id]);
        expect(await quoteOf(t, p[0]!.id)).toEqual({ state: "pending", hops: 0 });
        for (const author of a.slice(1)) {
          expect(requested(t, author)).toBe(false);
        }
      }
      // Chain 2: the reply quotes P₁ by A₁; each Aᵢ pins Pᵢ, which quotes Pᵢ₊₁ by Aᵢ₊₁.
      {
        const { t, root, bob } = await world();
        const a = await authors(t, LINKS, "b");
        const p: Note[] = [];
        for (let i = a.length - 1; i >= 0; i--) {
          const next = p[0];
          p.unshift(
            next === undefined
              ? serveNote(t.web, withReplies(t.web, mastodonNote(a[i]!), []))
              : quotingServed(t, a[i]!, next.id, a[i + 1]!),
          );
        }
        a.forEach((author, i) => serveFeatured(t.web, author, [p[i]!.id]));
        const note = mastodonNote(root);
        const w = quotingServed(t, bob, p[0]!.id, a[0]!, { inReplyTo: note.id });
        await walkOf(t, root, note, [w.id]);
        await allRounds(t);
        // P₀ stored by the walk's reply's verification at 0 hops; A₀'s sync finds it and promotes nothing.
        expect(await quoteOf(t, p[0]!.id)).toEqual({ state: "pending", hops: 0 });
        expect(requested(t, a[1]!)).toBe(false);
        expect(requested(t, a[2]!)).toBe(false);
      }
    },
  );
});

describe("a walk's ceilings of follow-on work (RES-6)", () => {
  it("repeated stale-author applications under a walk", { timeout: 180_000 }, async () => {
    // The walk's reply W, by bob (new), quotes Q by A (new, stable), under a valid stamp. Every fetch of a featured
    // collection lists MAX_REMOTE_PINS statuses it did not list before. Each quote round is dropped after its author
    // stage while Q's work has fewer than QUOTE_AUTHOR_FETCHES author documents (the Store having committed it), and
    // the clock moves past ACCOUNT_STALE_MS (and so QUOTE_LEASE_MS) before each next claim: A is stale again.
    expect(ACCOUNT_STALE_MS).toBeGreaterThan(QUOTE_LEASE_MS);
    const { t, root, bob } = await world();
    const a = await mastodonActor(t.web, "a", { origin: "https://a.example", key: 20 });
    const q = serveNote(t.web, withReplies(t.web, mastodonNote(a), []));
    const note = mastodonNote(root);
    const w = quotingServed(t, bob, q.id, a, { inReplyTo: note.id });
    await walkOf(t, root, note, [w.id]);
    const generations = new Map<string, number>();
    const pins: string[] = [];
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new Request(input, init).url;
      const owner = [bob, a].find((actor) => `${actor.uri}/collections/featured` === url);
      if (owner !== undefined) {
        generations.set(owner.uri, (generations.get(owner.uri) ?? 0) + 1);
        const listed = Array.from({ length: MAX_REMOTE_PINS }, () => serveNote(t.web, mastodonNote(owner)));
        pins.push(...listed.map((pin) => pin.id));
        serveFeatured(
          t.web,
          owner,
          listed.map((pin) => pin.id),
        );
      }
      return t.web.fetch(input, init);
    }) as typeof globalThis.fetch;
    const loader = { ...t.web.loader, fetch };
    const authorFetches = async () =>
      (
        await sql<{ n: number }>(
          t.store,
          "SELECT q.author_fetches AS n FROM quotes q JOIN statuses s ON s.id = q.status_id WHERE s.uri = ?",
          w.id,
        )
      )[0]?.n ?? 0;
    const dropping = new Proxy(t.store, {
      get: (target, name) => {
        if (name !== "completeQuote") {
          return Reflect.get(target, name) as unknown;
        }
        return async (build: string, input: QuoteVerification) => {
          const result = await target.completeQuote(build, input);
          if (input.stage === "author" && (await authorFetches()) < QUOTE_AUTHOR_FETCHES) {
            throw new StoreUnavailableError("maintenance");
          }
          return result;
        };
      },
    });
    let at = NOW;
    for (let claim = 0; ; claim++) {
      expect(claim).toBeLessThan(4 * QUOTE_AUTHOR_FETCHES);
      vi.setSystemTime(at);
      const deps = { ...inboxDeps(() => t.store, loader), now: () => at };
      for (let round = 0; (await walkReplies(t.env, deps)) || (await syncCollections(t.env, deps)); round++) {
        expect(round).toBeLessThan(20);
      }
      try {
        await verifyQuotes(t.env, { ...inboxDeps(() => dropping, loader), now: () => at });
      } catch (error) {
        expect(error).toBeInstanceOf(StoreUnavailableError);
      }
      const due = await sql(t.store, "SELECT 1 FROM quotes WHERE verify_after IS NOT NULL");
      const syncs = await sql(t.store, "SELECT 1 FROM collection_syncs");
      if (due.length === 0 && syncs.length === 0) {
        break;
      }
      at += ACCOUNT_STALE_MS + 1;
    }
    // Q's work applied A's document QUOTE_AUTHOR_FETCHES times, each a sync generation of MAX_REMOTE_PINS new pins;
    // bob, stored with W, brought one; then nothing more.
    expect(t.web.fetched.filter((url) => url === a.uri)).toHaveLength(QUOTE_AUTHOR_FETCHES);
    expect(Object.fromEntries(generations)).toEqual({ [bob.uri]: 1, [a.uri]: QUOTE_AUTHOR_FETCHES });
    expect(await storedOf(t.store, pins)).toHaveLength((1 + QUOTE_AUTHOR_FETCHES) * MAX_REMOTE_PINS);
    expect(await quoteOf(t, w.id)).toEqual({ state: "accepted", hops: QUOTE_HOPS - 1 });
    expect(await quoteOf(t, q.id)).toBeUndefined();
    // The walk's ceilings from that per-reply figure: each of WALK_STATUSES nodes stores at most one author and one
    // reply, whose one quote applies at most QUOTE_AUTHOR_FETCHES author documents.
    const documents = WALK_STATUSES * (1 + QUOTE_AUTHOR_FETCHES);
    expect(documents).toBe(1_400);
    expect(documents * MAX_REMOTE_PINS).toBe(28_000);
  });
});

describe("a user's blocks over a walk's replies (R8)", () => {
  it("hides a walk-stored reply from a user blocking its domain or its author only", async () => {
    const { t, root, bob } = await world();
    const carol = await mastodonActor(t.web, "carol", { origin: "https://third.example", key: 2 });
    const note = mastodonNote(root);
    const ofBob = reply(t.web, bob, note.id);
    const ofCarol = reply(t.web, carol, note.id);
    const { id } = await walkOf(t, root, note, [ofBob.id, ofCarol.id]);
    await walkRounds(t);
    await sql(t.store, "INSERT INTO domain_blocks (account_id, domain) VALUES (?, 'other.example')", ALICE);
    await sql(
      t.store,
      "INSERT INTO blocks (account_id, target_account_id) VALUES (?, ?)",
      ALICE,
      (await accountId(t.store, carol.uri))!,
    );
    const context = async (as: "alice" | "dave") =>
      (await t.api<{ descendants: { uri: string }[] }>(`/api/v1/statuses/${id}/context`, as)).body.descendants.map(
        (status) => status.uri,
      );
    expect(await context("alice")).toEqual([]);
    expect((await context("dave")).toSorted()).toEqual([ofBob.id, ofCarol.id].toSorted());
  });
});

describe("the jobs round", () => {
  it("runs the replies family after the other Worker families", async () => {
    const { t, root, bob } = await world();
    const note = mastodonNote(root);
    const g = reply(t.web, bob, note.id);
    await walkOf(t, root, note, [g.id]);
    const counting = countingStore(t.store);
    const env = { ...t.env, MAINTENANCE: "off" } as unknown as Env;
    await jobsRound(
      env,
      inboxDeps(() => counting.stub, t.web.loader),
    );
    const order = counting.calls.filter((name) =>
      ["claimCollectionSync", "claimQuotes", "claimReplyWalk"].includes(name),
    );
    expect(order[0]).toBe("claimCollectionSync");
    expect(order.at(-1)).toBe("claimReplyWalk");
    expect(await storedOf(t.store, [g.id])).toEqual([g.id]);
  });
});

describe("reading a collection: raw entries, skips and reading again (RepliesRead)", () => {
  // Entries that are no status id: a number, an object without id, a data: URI, and an http(s) URI one past
  // STATUS_URI_LIMIT, in turn.
  const NOT_IDS: unknown[] = [
    5,
    { type: "Note" },
    "data:text/plain,x",
    `https://x.example/${"a".repeat(STATUS_URI_LIMIT - 17)}`,
  ];
  const notIds = (count: number) => Array.from({ length: count }, (_, i) => NOT_IDS[i % NOT_IDS.length]);

  // A chain of pages, the first with `id`, each embedding the next as `next`; the last names `next` by URI, if given.
  function chain(id: string, pages: unknown[][], next?: string): Record<string, unknown> {
    const page = (index: number): Record<string, unknown> => ({
      type: "CollectionPage",
      ...(index === 0 ? { id } : {}),
      items: pages[index],
      ...(index + 1 < pages.length ? { next: page(index + 1) } : next === undefined ? {} : { next }),
    });
    return page(0);
  }

  // The root `note` of root, its replies collection naming by URI a first page that holds the chain `pages`; returns
  // the first page's URI. The root is stored and its walk started.
  async function pagedWalk(t: Setup, root: TestActor, note: Note, pages: unknown[][], next?: string) {
    const collection = `${note.id}/replies`;
    const first = `${collection}?page=true`;
    t.web.serve(first, { "@context": AS, partOf: collection, ...chain(first, pages, next) });
    note.replies = { id: collection, type: "Collection", first };
    serveNote(t.web, note);
    const id = await storedRoot(t, root, note);
    await startWalk(t.store, id, Date.now());
    return { id, first };
  }

  // The replies family's rounds over a counting Store until none reports a walk due: each step's first completion (the
  // one without an author), in order.
  async function countedRounds(t: Setup, loader = t.web.loader): Promise<ReplyStepInput[]> {
    const counting = countingStore(t.store);
    const deps = inboxDeps(() => counting.stub, loader);
    for (let round = 0; await walkReplies(t.env, deps); round++) {
      expect(round).toBeLessThan(100);
    }
    return counting.records
      .filter((record) => record.name === "completeReplyStep")
      .map((record) => record.args[1] as ReplyStepInput)
      .filter((input) => input.author === undefined);
  }

  const readsOf = (inputs: readonly ReplyStepInput[], uri: string) =>
    inputs.filter((input) => input.step.uri === uri).map(({ step }) => ({ stage: step.stage, skip: step.skip }));
  // A step as handed out, without its number.
  const placeOf = ({ step }: ReplyStepInput) => ({
    uri: step.uri,
    stage: step.stage,
    fetch: step.fetch,
    skip: step.skip,
  });

  it("reads a page of 400 entries with no next past its first 200 in the same walk", async () => {
    const { t, root, bob } = await world();
    const note = mastodonNote(root);
    const u = reply(t.web, bob, note.id);
    const last = reply(t.web, bob, note.id);
    const entries = notIds(400);
    entries[250] = u.id;
    entries[399] = last.id;
    const { first } = await pagedWalk(t, root, note, [entries]);
    const inputs = await countedRounds(t);
    expect(readsOf(inputs, note.id)).toEqual([
      { stage: "status", skip: 0 },
      { stage: "page", skip: 0 },
      { stage: "page", skip: REPLY_READ_ENTRIES },
    ]);
    expect(fetches(t, first)).toBe(2);
    expect(await storedOf(t.store, [u.id, last.id])).toEqual([u.id, last.id]);
  });

  it("goes on reading a page past entries that record nothing: not ids or nodes of the walk", async () => {
    const { t, root, bob } = await world();
    const note = mastodonNote(root);
    const a = reply(t.web, bob, note.id);
    const u = reply(t.web, bob, note.id);
    const entries = [...notIds(110), ...Array.from({ length: 110 }, () => a.id), u.id, ...notIds(79)];
    expect(entries).toHaveLength(300);
    await pagedWalk(t, root, note, [entries]);
    const inputs = await countedRounds(t);
    expect(readsOf(inputs, note.id).filter(({ stage }) => stage === "page")).toEqual([
      { stage: "page", skip: 0 },
      { stage: "page", skip: REPLY_READ_ENTRIES },
    ]);
    expect(await storedOf(t.store, [a.id, u.id])).toEqual([a.id, u.id]);
  });

  it("counts raw positions across a chain of embedded pages, reading it again at 200 and 400", async () => {
    const { t, root, bob } = await world();
    const note = mastodonNote(root);
    const at = [140, 260, 430].map(() => reply(t.web, bob, note.id));
    const pages = [notIds(150), notIds(150), notIds(150)];
    pages[0]![140] = at[0]!.id;
    pages[1]![110] = at[1]!.id;
    pages[2]![130] = at[2]!.id;
    const { first } = await pagedWalk(t, root, note, pages);
    const inputs = await countedRounds(t);
    expect(readsOf(inputs, note.id).filter(({ stage }) => stage === "page")).toEqual([
      { stage: "page", skip: 0 },
      { stage: "page", skip: 200 },
      { stage: "page", skip: 400 },
    ]);
    expect(fetches(t, first)).toBe(3);
    const ids = at.map((status) => status.id);
    expect(await storedOf(t.store, ids)).toEqual(ids);
  });

  it("keeps an entry that is not an id in its raw position, and records ids in those positions", async () => {
    for (const valid of [false, true]) {
      const { t, root, bob } = await world();
      const note = mastodonNote(root);
      const head = Array.from({ length: 10 }, () => reply(t.web, bob, note.id));
      const a = reply(t.web, bob, note.id);
      const b = reply(t.web, bob, note.id);
      const entries = [
        ...(valid ? head.map((status) => status.id) : notIds(10)),
        ...Array.from({ length: 190 }, () => a.id),
        b.id,
      ];
      await pagedWalk(t, root, note, [entries]);
      const inputs = await countedRounds(t);
      const reads = inputs.filter((input) => input.step.uri === note.id && input.step.stage === "page");
      const read = (index: number) => {
        const fetched = reads[index]!.fetched;
        return fetched.kind === "replies" ? fetched.replies : null;
      };
      // The first read takes raw entries 0 to 199, those that are no id as null; the second starts at raw entry 200.
      expect(read(0)).toMatchObject({ from: 0, next: "more" });
      expect(read(0)?.entries).toHaveLength(REPLY_READ_ENTRIES);
      expect(read(0)?.entries.slice(0, 10)).toEqual(
        valid ? head.map((status) => status.id) : notIds(10).map(() => null),
      );
      expect(read(1)).toEqual({ entries: [b.id], from: REPLY_READ_ENTRIES, next: null });
      const expected = [...(valid ? head.map((status) => status.id) : []), a.id, b.id];
      expect(await storedOf(t.store, expected)).toEqual(expected);
    }
  });

  it("reads a page's entries past the cap before the next page its URI names", async () => {
    const { t, root, bob } = await world();
    const note = mastodonNote(root);
    const u = reply(t.web, bob, note.id);
    const v = reply(t.web, bob, note.id);
    const entries = notIds(250);
    entries[230] = u.id;
    const next = `${note.id}/replies?page=2`;
    t.web.serve(next, { "@context": AS, id: next, type: "CollectionPage", items: [v.id] });
    const { first } = await pagedWalk(t, root, note, [entries], next);
    const inputs = await countedRounds(t);
    expect(inputs.filter((input) => input.step.uri === note.id && input.step.stage === "page").map(placeOf)).toEqual([
      { uri: note.id, stage: "page", fetch: first, skip: 0 },
      { uri: note.id, stage: "page", fetch: first, skip: REPLY_READ_ENTRIES },
      { uri: note.id, stage: "page", fetch: next, skip: 0 },
    ]);
    expect(await storedOf(t.store, [u.id, v.id])).toEqual([u.id, v.id]);
  });

  it("reads the rest of the replies a status embeds by fetching it for its replies only, storing nothing", async () => {
    const { t, root, bob } = await world();
    const note = mastodonNote(root);
    const x = mastodonNote(bob, { inReplyTo: note.id });
    const u = reply(t.web, bob, x.id);
    const entries = notIds(250);
    entries[220] = u.id;
    serveNote(t.web, withReplies(t.web, x, entries as string[]));
    const { id } = await walkOf(t, root, note, [x.id]);
    const inputs = await countedRounds(t);
    expect(inputs.filter((input) => input.step.uri === x.id).map(placeOf)).toEqual([
      { uri: x.id, stage: "status", fetch: x.id, skip: 0 },
      { uri: x.id, stage: "replies", fetch: x.id, skip: REPLY_READ_ENTRIES },
    ]);
    expect(fetches(t, x.id)).toBe(2);
    expect(await storedOf(t.store, [x.id, u.id])).toEqual([x.id, u.id]);
    expect((await statusRow(t.store, u.id))?.in_reply_to_id).toBe((await statusRow(t.store, x.id))?.id);
    // X and U are the walk's only statuses created: the replies step stored nothing.
    expect((await walkRow(t.store, id))?.result_count).toBe(2);
  });

  it("carries a reading's skip to the document a status names by URI once it embeds no chain", async () => {
    const { t, root, bob } = await world();
    const note = mastodonNote(root);
    const x = mastodonNote(bob, { inReplyTo: note.id });
    const u = reply(t.web, bob, x.id);
    const entries = notIds(250);
    entries[220] = u.id;
    serveNote(t.web, withReplies(t.web, x, entries as string[]));
    const collection = `${x.id}/replies`;
    t.web.serve(collection, {
      "@context": AS,
      id: collection,
      type: "Collection",
      first: { type: "CollectionPage", partOf: collection, items: entries },
    });
    await walkOf(t, root, note, [x.id]);
    // X's second fetch (its replies step) names its replies by URI.
    let fetched = 0;
    const loader = {
      ...t.web.loader,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (new Request(input, init).url === x.id && ++fetched === 2) {
          serveNote(t.web, { ...x, replies: collection });
        }
        return t.web.loader.fetch(input, init);
      }) as typeof fetch,
    };
    const inputs = await countedRounds(t, loader);
    expect(inputs.filter((input) => input.step.uri === x.id).map(placeOf)).toEqual([
      { uri: x.id, stage: "status", fetch: x.id, skip: 0 },
      { uri: x.id, stage: "replies", fetch: x.id, skip: REPLY_READ_ENTRIES },
      { uri: x.id, stage: "collection", fetch: collection, skip: REPLY_READ_ENTRIES },
    ]);
    expect(await storedOf(t.store, [x.id, u.id])).toEqual([x.id, u.id]);
  });
});
