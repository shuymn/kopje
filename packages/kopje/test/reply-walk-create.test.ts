import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Db } from "../src/db/sql";
import { QUOTE_HOPS } from "../src/domain/quotes";
import type { RemoteRepliesInput } from "../src/domain/remote-status-reads";
import {
  CREATE_WALK_ITEMS,
  CREATE_WALK_PAGES,
  CREATE_WALK_STATUSES,
  createWalkDue,
  recordCreateWalk,
} from "../src/domain/reply-walk-create";
import { REFRESH_RUNNING_MS } from "../src/domain/reply-walk-reads";
import {
  claimReplyWalk,
  type ClaimedWalk,
  NODE_ATTEMPTS,
  REPLY_WALK_LEASE_MS,
  WALK_STATUSES,
} from "../src/domain/reply-walks";
import { syncCollections } from "../src/federation/collections";
import { REQUEST_MAX_FETCHES } from "../src/federation/loader";
import { verifyQuotes } from "../src/federation/quotes";
import { createRepliesOf, parseRemoteStatus } from "../src/federation/remote-status";
import { walkReplies } from "../src/federation/replies";
import { handleQueue } from "../src/jobs/queue";
import { apiHarness, seedAccount, sql } from "./api-helpers";
import { harness, inboxDeps, NOW } from "./app-helpers";
import { fixtureKeyGen } from "./federation-helpers";
import { BUILD } from "./helpers";
import { LOCAL, mastodonActor, RemoteWeb, signedInit, type TestActor } from "./inbox-helpers";
import {
  announce,
  AS,
  create,
  DAVE,
  followed,
  localStatus,
  mastodonNote,
  nextId,
  type Note,
  type Setup,
  setup,
  statusRow,
  update,
} from "./inbox-status-helpers";
import { storeReceive } from "./inbox-store-helpers";
import { quoteRequest, quoting, serveFeatured, serveStamp } from "./quote-helpers";
import { plannedRun, scansOf } from "./read-helpers";
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
import { attr, parseHtml, query } from "./web-dom";
import { postForm, signIn } from "./web-helpers";

// The Create trigger of the walks of replies collections (domain/reply-walk-create.ts; Mastodon 4.7.5's
// Create#fetch_replies and FetchRepliesService): which stores record a create walk, which never do, what a create walk
// reads (first pages, the first items on the node's origin that Kopje does not store), its caps, its order among the
// walks, and a context refresh started over one. The Store's clock is the faked Date.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

const OTHER_ORIGIN = "https://other.example";
const at = (ms: number) => new Date(ms).toISOString();
const fetches = (t: { web: RemoteWeb }, url: string) => t.web.fetched.filter((fetched) => fetched === url).length;

// bob on mastodon.example, followed by dave; erin on other.example, unknown.
async function world() {
  const t = await setup();
  const bob = await mastodonActor(t.web, "bob");
  await followed(t, bob, DAVE);
  const erin = await mastodonActor(t.web, "erin", { origin: OTHER_ORIGIN, key: 3 });
  return { t, bob, erin };
}

// `note` with its embedded first page listing two of its author's replies (served, each listing nothing), served.
function listing(web: RemoteWeb, author: TestActor, note: Note): string[] {
  const replies = [reply(web, author, note.id).id, reply(web, author, note.id).id];
  serveNote(web, withReplies(web, note, replies));
  return replies;
}

// `note` naming its replies collection by URI, whose first page (by URI) lists one reply of its author's, served.
function collected(web: RemoteWeb, author: TestActor, note: Note): { collection: string; child: string } {
  const child = reply(web, author, note.id).id;
  const collection = `${note.id}/replies`;
  const page = `${collection}?page=true`;
  web.serve(collection, { "@context": AS, id: collection, type: "Collection", first: page });
  web.serve(page, { "@context": AS, id: page, type: "CollectionPage", partOf: collection, items: [child] });
  note.replies = collection;
  serveNote(web, note);
  return { collection, child };
}

// The create walk of the status `uri`: its row and its nodes, or undefined.
async function createWalkOf(store: Setup["store"], uri: string) {
  const id = (await statusRow(store, uri))?.id;
  const row =
    id === undefined
      ? undefined
      : (
          await sql<{ kind: number; refresh_id: string | null; queued_at: number; due_at: number | null }>(
            store,
            "SELECT kind, refresh_id, queued_at, due_at FROM reply_walks WHERE status_id = ?",
            id,
          )
        )[0];
  return row === undefined ? undefined : { ...row, ...(await walkRow(store, id!)), rows: await walkNodes(store, id!) };
}

// A create walk recorded at NOW for `uri`, its node done and `items` pending at their status stage.
function recorded(uri: string, items: readonly string[]) {
  const node = { state: 0, stage: 0, valid: 0, parent: null, fetch: null, skip: 0, attempts: 0 };
  return {
    kind: 1,
    refresh_id: null,
    queued_at: NOW,
    due_at: NOW,
    finished_at: null,
    token: null,
    next_seq: 1 + items.length,
    nodes: 1 + items.length,
    pages: 0,
    result_count: 0,
    handouts: 0,
    handout: null,
    rows: [
      { ...node, uri, seq: 0, state: 1, valid: 1 },
      ...items.map((item, i) => ({ ...node, uri: item, seq: i + 1 })),
    ],
  };
}

// The job rounds of walks, collection syncs and quote verification, as the Queue and cron run them, until none is due.
async function allRounds(t: Setup): Promise<void> {
  const deps = inboxDeps(() => t.store, t.web.loader);
  for (let round = 0, idle = 0; idle < 2; round++) {
    expect(round).toBeLessThan(80);
    const walking = await walkReplies(t.env, deps);
    const syncing = await syncCollections(t.env, deps);
    const verifying = await verifyQuotes(t.env, deps);
    idle = walking || syncing || verifying ? 0 : idle + 1;
  }
}

// `author`'s Note quoting `target` by `quoted`, under a valid stamp of `quoted`, with `extra`, served listing nothing.
function quotingServed(t: Setup, author: TestActor, target: string, quoted: TestActor, extra = {}): Note {
  const stamp = `${quoted.uri}/quote_authorizations/${nextId()}`;
  const note = quoting(author, target, stamp, extra);
  serveStamp(t.web, stamp, quoted, note.id, target);
  withReplies(t.web, note, []);
  return serveNote(t.web, note);
}

describe("the replies a Create reads (createRepliesOf)", () => {
  const ORIGIN = "https://mastodon.example";
  const own = (n: number) => `${ORIGIN}/users/bob/statuses/${n}`;
  const page = (items: unknown[], type = "CollectionPage") => ({ type, items, orderedItems: items });

  it.each([undefined, null, false, "", " \n", [], {}])("reads none of a blank value: %j", (value) => {
    expect(createRepliesOf(value, ORIGIN)).toBeNull();
  });

  it.each<[string, unknown, RemoteRepliesInput | null]>([
    [
      "a URI on the status's origin: the collection, fetched",
      `${ORIGIN}/replies`,
      {
        stage: "collection",
        uri: `${ORIGIN}/replies`,
      },
    ],
    ["a URI on another origin: none", `${OTHER_ORIGIN}/replies`, null],
    ["a URI that is no status identity: none", "ftp://mastodon.example/replies", null],
    [
      "an embedded collection whose first page is a URI on the origin: the page, fetched",
      {
        type: "Collection",
        first: `${ORIGIN}/replies?page=1`,
      },
      { stage: "page", uri: `${ORIGIN}/replies?page=1` },
    ],
    [
      "an embedded collection whose first page is a URI on another origin: none",
      {
        type: "Collection",
        first: `${OTHER_ORIGIN}/replies?page=1`,
      },
      null,
    ],
    [
      "an embedded first page: its first CREATE_WALK_ITEMS ids on the origin, objects by their id",
      {
        type: "Collection",
        first: page([own(1), `${OTHER_ORIGIN}/s/1`, { id: own(2), type: "Note" }, 7, own(3), own(4), own(5), own(6)]),
      },
      { items: [own(1), own(2), own(3), own(4), own(5)] },
    ],
    [
      "an ordered first page: its orderedItems",
      {
        type: "OrderedCollection",
        first: page([own(1)], "OrderedCollectionPage"),
      },
      { items: [own(1)] },
    ],
    [
      "a blank first: the collection's own items",
      { type: "Collection", first: "", items: [own(1)] },
      {
        items: [own(1)],
      },
    ],
    ["a first page of no collection type: none", { type: "Collection", first: page([own(1)], "Note") }, null],
    [
      "a first page listing nothing on the origin: none",
      {
        type: "Collection",
        first: page([`${OTHER_ORIGIN}/s/1`]),
      },
      null,
    ],
    ["a first that is neither a page nor a URI: none", { type: "Collection", first: [own(1)] }, null],
  ])("%s", (_name, value, expected) => {
    expect(createRepliesOf(value, ORIGIN)).toEqual(expected);
  });

  it("is what parseRemoteStatus reads of a Note as Mastodon serves it, on the Note's own origin", () => {
    const bob = { uri: `${ORIGIN}/users/bob` } as TestActor;
    const note = mastodonNote(bob);
    note.replies = { id: `${note.id}/replies`, type: "Collection", first: page([own(1), `${OTHER_ORIGIN}/s/2`]) };
    expect(parseRemoteStatus({ "@context": AS, ...note })?.replies).toEqual({ items: [own(1)] });
    note.replies = `${OTHER_ORIGIN}/replies`;
    expect(parseRemoteStatus({ "@context": AS, ...note })?.replies).toBeNull();
  });
});

describe("the stores that record a create walk (StoreContext.readReplies)", () => {
  // Every store of what was delivered or what a user asked for, each of a Note listing two of its author's replies:
  // the Note's id, the replies, and whether the walk already ran.
  type Stored = { uri: string; items: string[]; walked?: true };
  const OUTSIDE: [string, (t: Setup, bob: TestActor, erin: TestActor) => Promise<Stored>][] = [
    [
      "an inbound Create",
      async (t, bob) => {
        const note = mastodonNote(bob);
        const items = listing(t.web, bob, note);
        expect(await t.post(bob, create(bob, note))).toBe(202);
        return { uri: note.id, items };
      },
    ],
    [
      "an inbound Create spooled in maintenance and replayed",
      async (t, bob) => {
        const note = mastodonNote(bob);
        const items = listing(t.web, bob, note);
        const maintenance = harness(t.store, { MAINTENANCE: "readonly" }, BUILD, {
          keygen: fixtureKeyGen,
          loader: t.web.loader,
        });
        const spooled = await maintenance.request("/inbox", await signedInit(bob, "/inbox", create(bob, note)));
        expect(spooled.status).toBe(202);
        expect(await statusRow(t.store, note.id)).toBeUndefined();
        const deps = { ...inboxDeps(() => t.store, t.web.loader), now: () => NOW };
        await maintenance.queue.deliver((batch) => handleQueue(batch, { ...t.env, MAINTENANCE: "off" } as Env, deps));
        // The replay asked for a jobs round, which the same batch ran: the walk is done.
        return { uri: note.id, items, walked: true };
      },
    ],
    [
      "an inbound Update of an unknown recent status",
      async (t, bob) => {
        const note = mastodonNote(bob, { published: at(NOW - 60_000) });
        const items = listing(t.web, bob, note);
        expect(await t.post(bob, update(bob, note, at(NOW - 30_000)))).toBe(202);
        return { uri: note.id, items };
      },
    ],
    [
      "an Announce's embedded self-boost",
      async (t, bob) => {
        const note = mastodonNote(bob);
        const items = listing(t.web, bob, note);
        expect(await t.post(bob, announce(bob, note.id, { object: note }))).toBe(202);
        return { uri: note.id, items };
      },
    ],
    [
      "an Announce's fetched original",
      async (t, bob, erin) => {
        const note = mastodonNote(erin);
        const items = listing(t.web, erin, note);
        expect(await t.post(bob, announce(bob, note.id))).toBe(202);
        return { uri: note.id, items };
      },
    ],
    [
      "an Add to the featured collection",
      async (t, bob) => {
        const note = mastodonNote(bob);
        const items = listing(t.web, bob, note);
        const add = {
          "@context": AS,
          id: `${bob.uri}#add-${nextId()}`,
          type: "Add",
          actor: bob.uri,
          target: `${bob.uri}/collections/featured`,
          object: note.id,
        };
        expect(await t.post(bob, add)).toBe(202);
        return { uri: note.id, items };
      },
    ],
    [
      "a QuoteRequest's quoting status",
      async (t, bob) => {
        const mine = await localStatus(t, { status: "quote me", visibility: "public" }, "dave");
        const note = quoting(bob, mine.uri, null);
        const items = listing(t.web, bob, note);
        expect(await t.post(bob, quoteRequest(bob, mine.uri, note.id))).toBe(202);
        return { uri: note.id, items };
      },
    ],
    [
      "a search resolution",
      async (t, bob) => {
        const note = mastodonNote(bob);
        const items = listing(t.web, bob, note);
        expect((await t.api(`/api/v2/search?resolve=true&q=${encodeURIComponent(note.id)}`, "dave")).status).toBe(200);
        return { uri: note.id, items };
      },
    ],
  ];

  it.each(OUTSIDE)("%s records one", async (_name, run) => {
    const { t, bob, erin } = await world();
    const { uri, items, walked } = await run(t, bob, erin);
    if (walked === undefined) {
      expect(await createWalkOf(t.store, uri)).toEqual(recorded(uri, items));
      // A round walks it.
      await walkRounds(t);
    }
    // Both replies stored, and the walk gone.
    expect(await storedOf(t.store, items)).toEqual(items);
    expect(await createWalkOf(t.store, uri)).toBeUndefined();
  });

  it("an /authorize_interaction resolution records one", async () => {
    const web = new RemoteWeb();
    const h = await apiHarness({}, { federation: { keygen: fixtureKeyGen, loader: web.loader } });
    await seedAccount(h.store, { username: "alice", email: "alice@example.com", displayName: "Alice" });
    const bob = await mastodonActor(web, "bob");
    const note = mastodonNote(bob);
    const items = listing(web, bob, note);
    const browser = await signIn(h);
    const page = await h.request(`/authorize_interaction?uri=${encodeURIComponent(note.id)}`, {
      headers: { cookie: browser.cookie },
    });
    expect(page.status).toBe(200);
    const form = query(parseHtml(await page.text()), "form").find(
      (f) => attr(f, "action") === "/authorize_interaction",
    )!;
    const fields = new URLSearchParams();
    for (const input of query(form, "input")) {
      fields.append(attr(input, "name") ?? "", attr(input, "value") ?? "");
    }
    expect((await postForm(h, browser, "/authorize_interaction", fields)).status).toBe(200);
    expect(await createWalkOf(h.store, note.id)).toEqual(recorded(note.id, items));
  });

  it("asks for a jobs round when a Create records one, and not otherwise", async () => {
    const { t, bob } = await world();
    const receive = (note: Note) =>
      storeReceive(t.store, bob.uri, {
        type: "Create",
        id: `${note.id}/activity`,
        object: parseRemoteStatus({ "@context": AS, ...note })!,
      });
    const quiet = await receive(mastodonNote(bob));
    expect(quiet).toMatchObject({ applied: true });
    expect(quiet.jobsPending ?? false).toBe(false);
    const listed = mastodonNote(bob);
    listing(t.web, bob, listed);
    expect(await receive(listed)).toMatchObject({ applied: true, jobsPending: true });
  });

  it("records none for a private status, for items it stores or that are on another origin, nor for nothing listed", async () => {
    const { t, bob, erin } = await world();
    const stored = mastodonNote(bob);
    expect(await t.post(bob, create(bob, stored))).toBe(202);
    const cases = [
      mastodonNote(bob, { to: [`${bob.uri}/followers`], cc: [] }),
      withReplies(t.web, mastodonNote(bob), [stored.id, mastodonNote(erin).id]),
      withReplies(t.web, mastodonNote(bob), []),
      { ...mastodonNote(bob), replies: `${OTHER_ORIGIN}/replies` },
    ];
    listing(t.web, bob, cases[0]!);
    for (const note of cases) {
      expect(await t.post(bob, create(bob, note))).toBe(202);
      expect(await statusRow(t.store, note.id)).toBeDefined();
      expect(await createWalkOf(t.store, note.id)).toBeUndefined();
    }
    // Control: the same public Note listing its own replies records one.
    const listed = mastodonNote(bob);
    const items = listing(t.web, bob, listed);
    expect(await t.post(bob, create(bob, listed))).toBe(202);
    expect(await createWalkOf(t.store, listed.id)).toEqual(recorded(listed.id, items));
  });

  it("records the root at its collection's or first page's stage when the Note names them by URI", async () => {
    const { t, bob } = await world();
    const note = mastodonNote(bob);
    const { collection } = collected(t.web, bob, note);
    const paged = mastodonNote(bob);
    const first = `${paged.id}/replies?page=true`;
    paged.replies = { id: `${paged.id}/replies`, type: "Collection", first };
    for (const each of [note, paged]) {
      expect(await t.post(bob, create(bob, each))).toBe(202);
    }
    const root = { state: 0, valid: 1, parent: null, skip: 0, attempts: 0, seq: 0 };
    expect((await createWalkOf(t.store, note.id))?.rows).toEqual([
      { ...root, uri: note.id, stage: 1, fetch: collection },
    ]);
    expect((await createWalkOf(t.store, paged.id))?.rows).toEqual([{ ...root, uri: paged.id, stage: 2, fetch: first }]);
  });
});

describe("the stores that never record one: a walk's, quote verification's and a sync's", () => {
  it("a walk's reply: its collection is read by the context walk alone", async () => {
    const { t, bob } = await world();
    const root = mastodonNote(bob);
    const w = mastodonNote(bob, { inReplyTo: root.id });
    const { collection, child } = collected(t.web, bob, w);
    serveNote(t.web, withReplies(t.web, root, [w.id]));
    const rootId = await storedRoot(t, bob, root);
    await startWalk(t.store, rootId, NOW);
    await allRounds(t);
    expect(await storedOf(t.store, [w.id, child])).toEqual([w.id, child]);
    expect(fetches(t, collection)).toBe(1);
    // Control: the same Note delivered records a walk that reads its collection.
    const delivered = mastodonNote(bob, { inReplyTo: root.id });
    const other = collected(t.web, bob, delivered);
    expect(await t.post(bob, create(bob, delivered))).toBe(202);
    await allRounds(t);
    expect(fetches(t, other.collection)).toBe(1);
  });

  it("quote verification's quoted status, fetched or embedded: its collection is never read", async () => {
    const { t, bob, erin } = await world();
    // Fetched: bob's S quotes erin's Q under erin's stamp.
    const q = mastodonNote(erin);
    const fetched = collected(t.web, erin, q);
    const s = quotingServed(t, bob, q.id, erin);
    expect(await t.post(bob, create(bob, s))).toBe(202);
    // Embedded: bob's S2 embeds his own E.
    const e = mastodonNote(bob);
    const embedded = collected(t.web, bob, e);
    expect(await t.post(bob, create(bob, quoting(bob, e.id, null, { quote: e })))).toBe(202);
    await allRounds(t);
    expect(await storedOf(t.store, [q.id, e.id])).toEqual([q.id, e.id]);
    expect([fetches(t, fetched.collection), fetches(t, embedded.collection)]).toEqual([0, 0]);
    // Control: the same Notes delivered record walks that read their collections.
    await followed(t, erin, DAVE);
    const q2 = mastodonNote(erin);
    const e2 = mastodonNote(bob);
    const controls = [collected(t.web, erin, q2), collected(t.web, bob, e2)];
    expect(await t.post(erin, create(erin, q2))).toBe(202);
    expect(await t.post(bob, create(bob, e2))).toBe(202);
    await allRounds(t);
    expect(controls.map(({ collection }) => fetches(t, collection))).toEqual([1, 1]);
  });

  it("a collection sync's pin: its collection is never read", async () => {
    const { t, bob } = await world();
    const pin = mastodonNote(bob);
    const pinned = collected(t.web, bob, pin);
    // Storing bob's document (world's Follow) asked for the sync; its rounds read the featured collection.
    serveFeatured(t.web, bob, [pin.id]);
    await allRounds(t);
    expect(t.web.fetched).toContain(`${bob.uri}/collections/featured`);
    expect(await storedOf(t.store, [pin.id])).toEqual([pin.id]);
    expect(fetches(t, pinned.collection)).toBe(0);
    // Control: the same Note delivered records a walk that reads its collection.
    const delivered = mastodonNote(bob);
    const control = collected(t.web, bob, delivered);
    expect(await t.post(bob, create(bob, delivered))).toBe(202);
    await allRounds(t);
    expect(fetches(t, control.collection)).toBe(1);
  });

  it("starts no walk along an alternating reply and quote chain longer than a walk", { timeout: 120_000 }, async () => {
    // Thread i: root_i by the root author, its first page listing its author's reply_i, which quotes root_{i+1}.
    const thread = async () => {
      const t = await setup();
      const author = await mastodonActor(t.web, "root");
      const roots = Array.from({ length: WALK_STATUSES + 1 }, () => mastodonNote(author));
      const replies = roots.map((r, i) =>
        i + 1 < roots.length
          ? quotingServed(t, author, roots[i + 1]!.id, author, { inReplyTo: r.id })
          : reply(t.web, author, r.id),
      );
      roots.forEach((r, i) => serveNote(t.web, withReplies(t.web, r, [replies[i]!.id])));
      return { t, author, roots, replies };
    };
    const { t, author, roots, replies } = await thread();
    const first = await storedRoot(t, author, roots[0]!);
    await startWalk(t.store, first, NOW);
    await allRounds(t);
    // The walk stores reply_0; its quote's verification stores root_1 at no hops; nothing reads root_1's replies.
    expect(await storedOf(t.store, [replies[0]!.id, roots[1]!.id, replies[1]!.id, roots[2]!.id])).toEqual([
      replies[0]!.id,
      roots[1]!.id,
    ]);
    expect(
      (
        await sql<{ hops: number }>(
          t.store,
          "SELECT q.hops FROM quotes q JOIN statuses s ON s.id = q.status_id WHERE s.uri = ?",
          replies[0]!.id,
        )
      )[0]?.hops,
    ).toBe(QUOTE_HOPS - 1);
    expect([fetches(t, replies[1]!.id), fetches(t, roots[2]!.id)]).toEqual([0, 0]);
    // Control: root_1 delivered records a walk that fetches reply_1.
    const control = await thread();
    await followed(control.t, control.author);
    expect(await control.t.post(control.author, create(control.author, control.roots[1]!))).toBe(202);
    await walkRounds(control.t);
    expect(fetches(control.t, control.replies[1]!.id)).toBe(1);
  });
});

describe("the Store's own reading of a create walk's items, whatever the Worker hands it", () => {
  // Of a node's entries: one of another origin, then same-origin ids, one of them stored: the first CREATE_WALK_ITEMS on
  // the node's origin, less the stored one.
  async function entries(t: Setup, bob: TestActor) {
    const stored = mastodonNote(bob);
    expect(await t.post(bob, create(bob, stored))).toBe(202);
    const own = Array.from({ length: 7 }, (_, i) => `${bob.uri}/statuses/x${i}`);
    const all = [`${OTHER_ORIGIN}/statuses/1`, own[0]!, stored.id, ...own.slice(1)];
    return { all, taken: [own[0]!, ...own.slice(1, CREATE_WALK_ITEMS - 1)] };
  }

  it("records at most CREATE_WALK_ITEMS items on the status's origin that it does not store", async () => {
    const { t, bob } = await world();
    const { all, taken } = await entries(t, bob);
    const s = mastodonNote(bob);
    expect(await t.post(bob, create(bob, s))).toBe(202);
    const id = (await statusRow(t.store, s.id))!.id;
    await runInDurableObject(t.store, (_instance, state) =>
      recordCreateWalk(new Db(state.storage.sql), { id, uri: s.id, visibility: "public" }, { items: all }, NOW),
    );
    expect((await walkNodes(t.store, id)).map((node) => node.uri)).toEqual([s.id, ...taken]);
  });

  it("records the same of a page, and ends the node there: a page's next is not read", async () => {
    const { t, bob } = await world();
    const { all, taken } = await entries(t, bob);
    const s = mastodonNote(bob);
    const page = `${s.id}/replies?page=1`;
    s.replies = { id: `${s.id}/replies`, type: "Collection", first: page };
    expect(await t.post(bob, create(bob, s))).toBe(202);
    const id = (await statusRow(t.store, s.id))!.id;
    const claim = (await t.store.claimReplyWalk(BUILD)) as ClaimedWalk;
    expect(claim).toMatchObject({ statusId: id, kind: "create", step: { uri: s.id, stage: "page", fetch: page } });
    await t.store.completeReplyStep(BUILD, {
      origin: LOCAL,
      statusId: id,
      token: claim.token,
      step: claim.step,
      more: false,
      fetched: {
        kind: "replies",
        replies: { entries: all, from: 0, next: { stage: "page", uri: `${s.id}/replies?page=2` } },
      },
    });
    const nodes = await walkNodes(t.store, id);
    expect(nodes.map((node) => node.uri)).toEqual([s.id, ...taken]);
    expect(nodes[0]).toMatchObject({ state: 1, stage: 2, fetch: page });
  });
});

describe("what a create walk reads", () => {
  it("reads a node's first page only: neither an embedded nor a URI next is followed", async () => {
    const { t, bob } = await world();
    const note = mastodonNote(bob);
    const [a, b] = [reply(t.web, bob, note.id), reply(t.web, bob, note.id)];
    // The root's embedded first page lists a and names a next page listing b.
    serveNote(t.web, withReplies(t.web, note, [a.id], [b.id]));
    // a's first page, by URI, lists a1 and names a next page listing a2.
    const [a1, a2] = [reply(t.web, bob, a.id), reply(t.web, bob, a.id)];
    const collection = `${a.id}/replies`;
    const pages = [`${collection}?page=1`, `${collection}?page=2`];
    t.web.serve(pages[0]!, { "@context": AS, id: pages[0], type: "CollectionPage", items: [a1.id], next: pages[1] });
    t.web.serve(pages[1]!, { "@context": AS, id: pages[1], type: "CollectionPage", items: [a2.id] });
    a.replies = { id: collection, type: "Collection", first: pages[0] };
    serveNote(t.web, a);
    expect(await t.post(bob, create(bob, note))).toBe(202);
    await walkRounds(t);
    expect(await storedOf(t.store, [a.id, a1.id, b.id, a2.id])).toEqual([a.id, a1.id]);
    expect([fetches(t, pages[0]!), fetches(t, pages[1]!)]).toEqual([1, 0]);
    expect(t.web.fetched.filter((url) => url.includes("only_other_accounts"))).toEqual([]);
  });

  it("reads the replies of the statuses it creates only: one stored meanwhile is not read", async () => {
    const { t, bob } = await world();
    const note = mastodonNote(bob);
    const [a, b] = [mastodonNote(bob, { inReplyTo: note.id }), mastodonNote(bob, { inReplyTo: note.id })];
    serveNote(t.web, withReplies(t.web, note, [a.id, b.id]));
    expect(await t.post(bob, create(bob, note))).toBe(202);
    // a arrives before the walk's step, listing nothing; served afterwards listing a1. b, new, lists b1.
    expect(await t.post(bob, create(bob, withReplies(t.web, a, [])))).toBe(202);
    const a1 = reply(t.web, bob, a.id);
    serveNote(t.web, withReplies(t.web, a, [a1.id]));
    const b1 = reply(t.web, bob, b.id);
    serveNote(t.web, withReplies(t.web, b, [b1.id]));
    await walkRounds(t);
    expect(fetches(t, a.id)).toBe(1);
    expect(await storedOf(t.store, [b.id, b1.id, a1.id])).toEqual([b.id, b1.id]);
    expect(fetches(t, a1.id)).toBe(0);
  });
});

describe("the bounds of a create walk at their caps", () => {
  // A self-reply chain s_0 … s_29 by bob, s_0 delivered: each s_i's first page lists 8 items, s_{i+1} first, then 7
  // other replies of bob's to s_i (leaves listing nothing); `first` makes each page's form.
  function chain(t: Setup, bob: TestActor, form: (note: Note, items: string[]) => void) {
    const LENGTH = 30;
    const s = [mastodonNote(bob)];
    for (let i = 1; i < LENGTH; i++) {
      s.push(mastodonNote(bob, { inReplyTo: s[i - 1]!.id }));
    }
    const leaves = s.map((parent) => Array.from({ length: 7 }, () => reply(t.web, bob, parent.id).id));
    s.forEach((note, i) => {
      form(note, i + 1 < LENGTH ? [s[i + 1]!.id, ...leaves[i]!] : leaves[i]!);
      serveNote(t.web, note);
    });
    return { s, leaves };
  }

  it(
    "records at most CREATE_WALK_STATUSES nodes and CREATE_WALK_ITEMS items a page: 8 items a page, a chain of 30",
    { timeout: 60_000 },
    async () => {
      const { t, bob } = await world();
      const { s, leaves } = chain(t, bob, (note, items) => withReplies(t.web, note, items));
      expect(await t.post(bob, create(bob, s[0]!))).toBe(202);
      await walkRounds(t);
      // Each status read takes its page's first CREATE_WALK_ITEMS items, until the walk holds CREATE_WALK_STATUSES.
      const taken = s.flatMap((_, i) =>
        [s[i + 1]?.id, ...leaves[i]!].filter((uri): uri is string => uri !== undefined).slice(0, CREATE_WALK_ITEMS),
      );
      const recorded = taken.slice(0, CREATE_WALK_STATUSES - 1);
      expect(await storedOf(t.store, taken)).toEqual(recorded);
      expect(taken.slice(CREATE_WALK_STATUSES - 1).map((uri) => fetches(t, uri))).toEqual(
        taken.slice(CREATE_WALK_STATUSES - 1).map(() => 0),
      );
      // An item past CREATE_WALK_ITEMS on a page is never fetched.
      const past = leaves.flatMap((page) => page.slice(CREATE_WALK_ITEMS - 1));
      expect(past.filter((uri) => fetches(t, uri) > 0)).toEqual([]);
      expect(await sql(t.store, "SELECT count(*) AS n FROM reply_walks")).toEqual([{ n: 0 }]);
    },
  );

  it(
    "hands out at most CREATE_WALK_PAGES documents, and records no item of another origin: a chain of 30 by URI",
    { timeout: 60_000 },
    async () => {
      const { t, bob } = await world();
      // Each s_i names a collection whose first page (both by URI) lists s_{i+1} and 7 statuses of another origin.
      const foreign = (i: number) => Array.from({ length: 7 }, (_, j) => `${OTHER_ORIGIN}/statuses/${i}-${j}`);
      const docs: string[] = [];
      const { s } = chain(t, bob, (note, items) => {
        const collection = `${note.id}/replies`;
        const page = `${collection}?page=true`;
        t.web.serve(collection, { "@context": AS, id: collection, type: "Collection", first: page });
        const listed = [items[0]!, ...foreign(docs.length)];
        t.web.serve(page, { "@context": AS, id: page, type: "CollectionPage", items: listed });
        note.replies = collection;
        docs.push(collection, page);
      });
      expect(await t.post(bob, create(bob, s[0]!))).toBe(202);
      await walkRounds(t);
      const read = CREATE_WALK_PAGES / 2;
      expect(docs.filter((url) => fetches(t, url) > 0)).toEqual(docs.slice(0, CREATE_WALK_PAGES));
      // s_1 … s_read stored, s_read's collection never requested, nor anything of the other origin.
      expect(
        await storedOf(
          t.store,
          s.map((note) => note.id),
        ),
      ).toEqual(s.slice(0, read + 1).map((note) => note.id));
      expect(fetches(t, s[read + 1]!.id)).toBe(0);
      expect(t.web.fetched.filter((url) => url.startsWith(OTHER_ORIGIN))).toEqual([]);
    },
  );

  it(
    "hands out at most NODE_ATTEMPTS × (CREATE_WALK_STATUSES - 1) + CREATE_WALK_PAGES documents, each within its budget",
    { timeout: 60_000 },
    async () => {
      const { t, bob } = await world();
      // Every node at its attempts and every page charged: a tree by bob, the root over 8 children each over 8
      // grandchildren, every status naming its collection and first page by URI (two documents), each page listing its
      // children; every status but the root (a create walk never fetches it) fails once (5xx) before it is read, and
      // the walk fills both CREATE_WALK_STATUSES and CREATE_WALK_PAGES.
      const paged = (note: Note, items: string[]) => {
        const collection = `${note.id}/replies`;
        const page = `${collection}?page=true`;
        t.web.serve(collection, { "@context": AS, id: collection, type: "Collection", first: page });
        t.web.serve(page, { "@context": AS, id: page, type: "CollectionPage", items });
        note.replies = collection;
        serveNote(t.web, note);
      };
      const root = mastodonNote(bob);
      const children = Array.from({ length: 8 }, () => mastodonNote(bob, { inReplyTo: root.id }));
      const grand = children.map((c) => Array.from({ length: 8 }, () => mastodonNote(bob, { inReplyTo: c.id })));
      paged(
        root,
        children.map((c) => c.id),
      );
      // The first child's page lists only statuses of another origin: two documents read for no node, so that both
      // caps are reached together (5 + 0 + 5 + 5 + 4 nodes under the root over 10 documents).
      paged(
        children[0]!,
        Array.from({ length: 8 }, (_, j) => `${OTHER_ORIGIN}/statuses/${j}`),
      );
      children.slice(1).forEach((c, i) =>
        paged(
          c,
          grand[i + 1]!.map((g) => g.id),
        ),
      );
      grand.flat().forEach((g) => paged(g, []));
      const flaky = new Set([...children, ...grand.flat()].map((note) => note.id));
      const loader = {
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new Request(input, init).url;
          if (flaky.delete(url)) {
            t.web.fetched.push(url);
            return new Response("busy", { status: 503 });
          }
          return t.web.fetch(input, init);
        }) as typeof fetch,
        checkHost: () => Promise.resolve(),
      };
      expect(await t.post(bob, create(bob, root))).toBe(202);
      const before = t.web.fetched.length;
      await walkRounds(t, 100, loader);
      const made = t.web.fetched.slice(before);
      const documents = made.filter((url) => /\/replies(\?page=true)?$/.test(url));
      const statuses = made.filter((url) => !documents.includes(url));
      expect(documents).toHaveLength(CREATE_WALK_PAGES);
      expect(statuses).toHaveLength(NODE_ATTEMPTS * (CREATE_WALK_STATUSES - 1));
      expect(new Set(statuses).size).toBe(CREATE_WALK_STATUSES - 1);
      expect(statuses).not.toContain(root.id);
      // No author to fetch (bob is known): each hand-out made one request, within REQUEST_MAX_FETCHES.
      expect(made.length).toBeLessThanOrEqual(
        (NODE_ATTEMPTS * CREATE_WALK_STATUSES + CREATE_WALK_PAGES) * REQUEST_MAX_FETCHES,
      );
      expect(await storedOf(t.store, [...statuses])).toHaveLength(2 * (CREATE_WALK_STATUSES - 1));
      expect(await sql(t.store, "SELECT count(*) AS n FROM reply_walks")).toEqual([{ n: 0 }]);
    },
  );
});

describe("claims of create walks", () => {
  // Statuses of bob's (listing nothing) and walks of them as given: a context walk (kind 0) or create walks (kind 1),
  // queued at `queued`, each with one node pending at its status stage.
  async function walks<const S extends readonly { kind: 0 | 1; queued: number }[]>(
    t: Setup,
    bob: TestActor,
    specs: S,
  ): Promise<{ [K in keyof S]: string }> {
    const ids: string[] = [];
    for (const [i, spec] of specs.entries()) {
      const note = mastodonNote(bob);
      expect(await t.post(bob, create(bob, note))).toBe(202);
      const id = (await statusRow(t.store, note.id))!.id;
      await sql(
        t.store,
        `INSERT INTO reply_walks (status_id, kind, refresh_id, queued_at, due_at, next_seq, nodes) VALUES (?, ?, ?, ?, ?, 2, 2)`,
        id,
        spec.kind,
        spec.kind === 0 ? String(i).padStart(32, "a") : null,
        spec.queued,
        spec.queued,
      );
      await sql(
        t.store,
        `INSERT INTO reply_walk_nodes (status_id, uri, seq, state, valid) VALUES (?1, ?2, 0, 1, 1), (?1, ?3, 1, 0, 0)`,
        id,
        note.id,
        `${OTHER_ORIGIN}/statuses/${i}`,
      );
      ids.push(id);
    }
    return ids as { [K in keyof S]: string };
  }

  const claim = (t: Setup) => t.store.claimReplyWalk(BUILD);

  it("claims context walks first, then create walks in the order they were queued, each keeping its place", async () => {
    const { t, bob } = await world();
    const [a, b, c] = await walks(t, bob, [
      { kind: 1, queued: NOW - 2000 },
      { kind: 1, queued: NOW - 1000 },
      { kind: 0, queued: NOW },
    ]);
    expect(await claim(t)).toMatchObject({ statusId: c, kind: "context" });
    const first = (await claim(t)) as ClaimedWalk;
    expect(first).toMatchObject({ statusId: a, kind: "create", pending: true });
    // Released with its node pending (the round's turn ended), it is due again in its own place, ahead of b.
    expect(await t.store.releaseReplyWalk(BUILD, { statusId: a, token: first.token })).toBe(true);
    expect((await walkRow(t.store, a))?.due_at).toBe(NOW - 2000);
    const again = (await claim(t)) as ClaimedWalk;
    expect(again).toMatchObject({ statusId: a, kind: "create" });
    // Its node ended, the walk goes, row and nodes; the next claim takes b.
    const ended = await t.store.completeReplyStep(BUILD, {
      origin: LOCAL,
      statusId: a,
      token: again.token,
      step: again.step,
      more: true,
      fetched: { kind: "failed" },
    });
    expect(ended).toEqual({ next: null, need: null, done: true });
    expect(await walkRow(t.store, a)).toBeUndefined();
    expect(await walkNodes(t.store, a)).toEqual([]);
    expect(await claim(t)).toMatchObject({ statusId: b, kind: "create" });
  });

  it("drops a create walk queued REFRESH_RUNNING_MS ago with its nodes, and claims the next", async () => {
    const { t, bob } = await world();
    const [old, kept] = await walks(t, bob, [
      { kind: 1, queued: NOW - REFRESH_RUNNING_MS },
      { kind: 1, queued: NOW - REFRESH_RUNNING_MS + 1 },
    ]);
    expect(await claim(t)).toMatchObject({ statusId: kept, kind: "create" });
    expect(await walkRow(t.store, old)).toBeUndefined();
    expect(await walkNodes(t.store, old)).toEqual([]);
    expect(t.web.fetched.filter((url) => url.startsWith(OTHER_ORIGIN))).toEqual([]);
  });

  it("drops a create walk whose root is no longer a walk root, deleting it", async () => {
    const { t, bob } = await world();
    const [gone, kept] = await walks(t, bob, [
      { kind: 1, queued: NOW - 2000 },
      { kind: 1, queued: NOW - 1000 },
    ]);
    await sql(t.store, "UPDATE statuses SET visibility = 'private' WHERE id = ?", gone);
    expect(await claim(t)).toMatchObject({ statusId: kept, kind: "create" });
    expect(await walkRow(t.store, gone)).toBeUndefined();
  });
});

describe("a context refresh over a create walk (D12)", () => {
  it("restarts the leased create walk as a context walk: the held step changes nothing, the refresh reads it all", async () => {
    const { t, bob, erin } = await world();
    const note = mastodonNote(bob, { published: at(NOW - 60 * 60 * 1000) });
    // The root's first page lists a (bob's) and x (erin's, another origin) and names a next page listing n.
    const a = reply(t.web, bob, note.id);
    const x = reply(t.web, erin, note.id);
    const n = reply(t.web, bob, note.id);
    serveNote(t.web, withReplies(t.web, note, [a.id, x.id], [n.id]));
    expect(await t.post(bob, create(bob, note))).toBe(202);
    const id = (await statusRow(t.store, note.id))!.id;
    expect(await createWalkOf(t.store, note.id)).toEqual(recorded(note.id, [a.id]));
    // The create walk's round, held at a's fetch.
    const held = t.web.hold(a.id);
    const deps = inboxDeps(() => t.store, t.web.loader);
    const round = walkReplies(t.env, deps);
    await held.reached;
    // A signed-in context read starts the refresh in its place.
    const read = await t.api(`/api/v1/statuses/${id}/context`, "dave");
    expect(read.status).toBe(200);
    const restarted = await walkNodes(t.store, id);
    expect(await walkRow(t.store, id)).toMatchObject({ token: null, nodes: 1, pages: 0, result_count: 0, handouts: 0 });
    expect(restarted).toEqual([
      { uri: note.id, seq: 0, state: 0, stage: 0, valid: 1, parent: null, fetch: null, skip: 0, attempts: 0 },
    ]);
    expect(
      (
        await sql<{ kind: number; refresh: number }>(
          t.store,
          "SELECT kind, refresh_id IS NOT NULL AS refresh FROM reply_walks WHERE status_id = ?",
          id,
        )
      )[0],
    ).toEqual({ kind: 0, refresh: 1 });
    // The held step completes under the create walk's lost claim: nothing changes, a stored by no one. The round then
    // claims the context walk, held at the root's fetch.
    const rootHeld = t.web.hold(note.id);
    held.release();
    await rootHeld.reached;
    expect(await walkNodes(t.store, id)).toEqual([{ ...restarted[0]!, attempts: 1 }]);
    expect(await storedOf(t.store, [a.id])).toEqual([]);
    rootHeld.release();
    await round;
    // The context walk refetches the root and reads what the create walk would not: x of another origin, the next page.
    await walkRounds(t);
    expect(fetches(t, note.id)).toBe(1);
    expect(await storedOf(t.store, [a.id, x.id, n.id])).toEqual([a.id, x.id, n.id]);
    expect(await walkRow(t.store, id)).toMatchObject({ finished_at: NOW, result_count: 3 });
  });
});

describe("plans (RES-7)", () => {
  it("seeks every create walk statement by its key, after ANALYZE and growth", { timeout: 120_000 }, async () => {
    const { t, bob } = await world();
    const note = mastodonNote(bob);
    const items = listing(t.web, bob, note);
    const stored = mastodonNote(bob);
    expect(await t.post(bob, create(bob, stored))).toBe(202);
    const s = mastodonNote(bob);
    expect(await t.post(bob, create(bob, s))).toBe(202);
    const sid = (await statusRow(t.store, s.id))!.id;
    await sql(t.store, "ANALYZE");
    // Growth the statistics never saw: 10,000 context walks finished, 5,000 create walks leased ahead, one due.
    await sql(
      t.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 15000)
			INSERT INTO reply_walks (status_id, kind, refresh_id, queued_at, due_at, finished_at, token)
			SELECT printf('8%017d', i), CASE WHEN i <= 10000 THEN 0 ELSE 1 END,
				CASE WHEN i <= 10000 THEN printf('%032x', i) END, ?1,
				CASE WHEN i > 10000 THEN ?1 + ?2 END, CASE WHEN i <= 10000 THEN ?1 - 1 END,
				CASE WHEN i > 10000 THEN printf('%036d', i) END FROM n`,
      NOW,
      REPLY_WALK_LEASE_MS,
    );
    const replies: RemoteRepliesInput = { items: [stored.id, ...items, `${OTHER_ORIGIN}/statuses/1`] };
    const recording = await plannedRun(
      t,
      /reply_walk|statuses INDEXED/,
      {
        run: (storage: SqlStorage) => {
          const db = new Db(storage);
          recordCreateWalk(db, { id: sid, uri: s.id, visibility: "public" }, replies, NOW);
          return createWalkDue(db, NOW);
        },
      },
      undefined,
      true,
    );
    expect(recording.result).toBe(true);
    const claimed = await plannedRun(t, /reply_walk/, claimReplyWalk, { now: NOW }, true);
    expect(claimed.result).toMatchObject({ statusId: sid, kind: "create", step: { uri: items[0] } });
    const statements = [...recording.plans, ...claimed.plans];
    for (const { query, plan } of statements) {
      expect(scansOf(plan, ["reply_walks", "reply_walk_nodes", "statuses"]), query).toEqual([]);
    }
    for (const { query, rows } of statements) {
      expect(rows, query).toBeLessThanOrEqual(2);
    }
    expect(statements.some(({ query }) => /kind = \? AND due_at <= \?/.test(query))).toBe(true);
  });
});
