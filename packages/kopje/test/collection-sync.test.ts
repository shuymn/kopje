import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { pruneCollectionItems, RETIRED_ROWS_PER_ROUND } from "../src/domain/collections";
import { localRows as localRowsOf } from "../src/domain/feature-answers";
import { answerFeatureRequest } from "../src/domain/inbound-feature-requests";
import {
  PART_COLLECTIONS,
  PART_FEATURED,
  PART_NETWORK,
  PART_TAGS,
  SYNC_RETRY_MS,
} from "../src/domain/remote-collections";
import {
  applyFeaturedCollection,
  deleteUnlisted,
  MAX_REMOTE_COLLECTIONS,
  MAX_REMOTE_ITEMS,
} from "../src/domain/remote-featured-collections";
import { webfingerUrl } from "../src/domain/remote-statuses";
import { COLLECTIONS_CAPS, FEATURED_COLLECTION_PAGES, syncCollections } from "../src/federation/collections";
import { MAX_STORED_COLLECTIONS, MAX_STORED_ITEMS } from "../src/platform/stored-bounds";
import { sql } from "./api-helpers";
import { inboxDeps, NOW } from "./app-helpers";
import {
  ACCEPTED,
  cavageRefused,
  checkRound,
  collection,
  collectionRows,
  COLLECTIONS_ONLY,
  featuredOwner,
  item,
  items,
  PENDING,
  featureRequest,
  localItem,
  localRows,
  outbound,
  requestSync,
  seededMembers,
  serveAuthorization,
  serveCollections,
  serveListing,
  storedMember,
  storedOwner,
  syncAll,
} from "./featured-collection-helpers";
import { BUILD } from "./helpers";
import { LOCAL, type RemoteWeb, type TestActor } from "./inbox-helpers";
import { accountId, ALICE, ALICE_URI, AS, nextId, OTHER, type Setup, setup } from "./inbox-status-helpers";
import { watchedCursor } from "./read-helpers";

// The collections part of a remote account's sync (#1589's D21: domain/remote-collections.ts PART_COLLECTIONS,
// domain/remote-featured-collections.ts, federation/collections.ts): an account's featuredCollections collection and
// its first FEATURED_COLLECTION_PAGES pages read within one round's budget under COLLECTIONS_CAPS, at most
// MAX_REMOTE_COLLECTIONS embedded collections kept with their first MAX_REMOTE_ITEMS items.

const fetchedUnder = (web: RemoteWeb, from: number, prefix: string) =>
  web.fetched.slice(from).filter((url) => url.startsWith(prefix));

describe("the collections part of a sync", () => {
  it("reads two pages in one round of three documents, keeps ten collections, and fetches no URI-only entry", async () => {
    const t = await setup();
    const owner = await featuredOwner(t.web, "owner", COLLECTIONS_ONLY);
    const member = await storedMember(t, "member", OTHER);
    const listed = Array.from({ length: MAX_REMOTE_COLLECTIONS + 1 }, (_, n) =>
      collection(
        owner,
        n === 0 ? [item(owner, member), `${owner.uri}/collection_items/by-uri`] : [item(owner, member)],
      ),
    );
    const byUri = `${owner.uri}/collections/by-uri`;
    t.web.serve(byUri, collection(owner, [item(owner, member)]));
    // Page 1: five collections and one given only as a URI; page 2: six (an eleventh), and a next page.
    serveCollections(t.web, owner, [[...listed.slice(0, 5), byUri], listed.slice(5)], true);
    await storedOwner(t, owner);
    const from = t.web.fetched.length;
    const deps = { ...inboxDeps(() => t.store, t.web.loader), now: () => NOW };
    expect(await syncCollections(t.env, deps)).toBe(false);
    expect(await sql(t.store, "SELECT account_id FROM collection_syncs")).toEqual([]);

    const root = owner.featuredCollections;
    expect(fetchedUnder(t.web, from, root)).toEqual([root, `${root}?page=1`, `${root}?page=2`]);
    expect(FEATURED_COLLECTION_PAGES).toBe(2);
    expect(t.web.fetched.slice(from)).not.toContain(byUri);
    expect(t.web.fetched.slice(from)).not.toContain(`${owner.uri}/collection_items/by-uri`);
    expect((await collectionRows(t)).map((row) => row.uri)).toEqual(
      listed
        .slice(0, MAX_REMOTE_COLLECTIONS)
        .map((entry) => entry.id)
        .toSorted(),
    );
    // The first collection's URI-only item is skipped: one item each.
    expect((await items(t)).length).toBe(MAX_REMOTE_COLLECTIONS);
  });

  it("keeps the first 25 items, deletes the dropped ones, and deletes unlisted collections only after a complete read", async () => {
    const t = await setup();
    const owner = await featuredOwner(t.web, "owner", COLLECTIONS_ONLY);
    // Members Kopje does not store: their items are kept by featuredObject alone, unqueued.
    const ghosts = Array.from({ length: 30 }, (_, n) => ({ uri: `${OTHER}/users/ghost${n}` }));
    const entries = ghosts.map((ghost) => item(owner, ghost));
    const first = collection(owner, entries);
    const second = collection(owner, []);
    const third = collection(owner, []);
    serveCollections(t.web, owner, [[first], [second, third]]);
    const ownerId = await storedOwner(t, owner);
    await syncAll(t);
    expect((await collectionRows(t)).map((row) => row.uri)).toEqual([first.id, second.id, third.id].toSorted());
    expect((await items(t, first.id)).map((row) => row.uri)).toEqual(
      entries.slice(0, MAX_REMOTE_ITEMS).map((entry) => entry.id),
    );
    for (const row of await items(t, first.id)) {
      expect(row).toMatchObject({ state: PENDING, account_id: null, check_due_at: null });
    }

    // A complete read listing 20 items of the first and the third: the dropped items and the second go.
    serveCollections(t.web, owner, [[{ ...first, orderedItems: entries.slice(0, 20) }], [third]]);
    await requestSync(t, ownerId);
    await syncAll(t);
    expect((await collectionRows(t)).map((row) => row.uri)).toEqual([first.id, third.id].toSorted());
    expect((await items(t, first.id)).map((row) => row.uri)).toEqual(entries.slice(0, 20).map((entry) => entry.id));

    // A read whose second page cannot be read (a 404) keeps the third, which it did not see.
    serveCollections(t.web, owner, [[first]], true);
    t.web.fail(`${owner.featuredCollections}?page=2`, 404);
    await requestSync(t, ownerId);
    await syncAll(t);
    expect((await collectionRows(t)).map((row) => row.uri)).toEqual([first.id, third.id].toSorted());
  });

  it("replaces a collection at MAX_REMOTE_COLLECTIONS on a complete read, and on no other", async () => {
    const t = await setup();
    const owner = await featuredOwner(t.web, "owner", COLLECTIONS_ONLY);
    const held = Array.from({ length: MAX_REMOTE_COLLECTIONS }, () => collection(owner, []));
    serveCollections(t.web, owner, [held.slice(0, 5), held.slice(5)]);
    const ownerId = await storedOwner(t, owner);
    await syncAll(t);
    const uris = async () => (await collectionRows(t)).map((row) => row.uri);
    expect(await uris()).toEqual(held.map((entry) => entry.id).toSorted());

    // A read whose second page cannot be read lists a new one in place of the last: the new one finds no slot.
    const replacement = collection(owner, []);
    const listed = [...held.slice(0, 5), ...held.slice(5, -1), replacement];
    serveCollections(t.web, owner, [listed.slice(0, 5), listed.slice(5)]);
    t.web.fail(`${owner.featuredCollections}?page=2`, 404);
    await requestSync(t, ownerId);
    await syncAll(t);
    expect(await uris()).toEqual(held.map((entry) => entry.id).toSorted());

    // The same listing read through: the last goes, and the new one takes its slot. The first, listed with a value
    // Mastodon would not store, goes too.
    const unstorable = { ...listed[0]!, sensitive: undefined };
    serveCollections(t.web, owner, [[unstorable, ...listed.slice(1, 5)], listed.slice(5)]);
    await requestSync(t, ownerId);
    await syncAll(t);
    expect(await uris()).toEqual(
      listed
        .slice(1)
        .map((entry) => entry.id)
        .toSorted(),
    );
  });

  it("refuses a collection of another host or another owner, and cuts a long name and description", async () => {
    const t = await setup();
    const owner = await featuredOwner(t.web, "owner", COLLECTIONS_ONLY);
    const other = await featuredOwner(t.web, "other", COLLECTIONS_ONLY);
    const elsewhere = { ...collection(owner, []), id: `${OTHER}/collections/elsewhere` };
    const foreign = collection(owner, [], { attributedTo: other.uri });
    const withNul = collection(owner, [], { name: "a\u0000b" });
    const longName = "𝒜".repeat(300);
    const long = collection(owner, [], {
      name: longName,
      summary: `<script>alert(1)</script>${"a&".repeat(1500)}`,
    });
    serveCollections(t.web, owner, [[elsewhere, foreign, withNul, long]]);
    await storedOwner(t, owner);
    await syncAll(t);
    const rows = await collectionRows(t);
    expect(rows.map((row) => row.uri)).toEqual([long.id]);
    expect([...rows[0]!.name]).toHaveLength(256);
    expect(rows[0]!.name).toBe("𝒜".repeat(256));
    const description = rows[0]!.description ?? "";
    expect([...description].length).toBeLessThanOrEqual(2048);
    expect([...description].length).toBeGreaterThan(2000);
    expect(description).not.toContain("script");
    expect(description.startsWith("a&amp;a&amp;")).toBe(true);
  });

  it("refuses a collection whose totalItems is no count it stores, and keeps an unknown language as none", async () => {
    const t = await setup();
    const owner = await featuredOwner(t.web, "owner", COLLECTIONS_ONLY);
    const refused = [-1, 1.5, "5", true, 2 ** 31].map((totalItems) => collection(owner, [], { totalItems }));
    // Absent and false are 0, as Mastodon's `totalItems || 0`.
    const absent = collection(owner, [], { totalItems: undefined });
    const falsy = collection(owner, [], { totalItems: false });
    const largest = collection(owner, [], { totalItems: 2 ** 31 - 1 });
    const unknown = collection(owner, [], { summaryMap: { zz: "a summary" } });
    const known = collection(owner, [], { summaryMap: { ja: "a summary" } });
    serveCollections(t.web, owner, [
      [...refused, absent, falsy],
      [largest, unknown, known],
    ]);
    await storedOwner(t, owner);
    await syncAll(t);
    const rows = await sql<{ uri: string; total_items: number | null; language: string | null }>(
      t.store,
      "SELECT uri, total_items, language FROM collections WHERE local = 0 ORDER BY uri",
    );
    const expected = [
      [absent.id, 0, null],
      [falsy.id, 0, null],
      [largest.id, 2 ** 31 - 1, null],
      [unknown.id, 0, null],
      [known.id, 0, "ja"],
    ];
    expect(rows.map((row) => [row.uri, row.total_items, row.language])).toEqual(
      expected.toSorted(([a], [b]) => (String(a) < String(b) ? -1 : 1)),
    );
  });

  it("never fetches a member it does not store, and queues its item at the read after the account is stored", async () => {
    const t = await setup();
    const owner = await featuredOwner(t.web, "owner", COLLECTIONS_ONLY);
    const ghost = { uri: `${OTHER}/users/ghost` };
    const entry = item(owner, ghost);
    const listed = collection(owner, [entry]);
    serveCollections(t.web, owner, [[listed]]);
    serveAuthorization(t.web, entry, listed.id);
    const ownerId = await storedOwner(t, owner);
    const from = t.web.fetched.length;
    await syncAll(t);
    expect(await checkRound(t)).toBe(false);
    expect(await items(t)).toMatchObject([
      { uri: entry.id, state: PENDING, account_id: null, object_uri: ghost.uri, check_due_at: null },
    ]);
    expect(t.web.fetched.slice(from).filter((url) => url.startsWith(OTHER))).toEqual([]);

    // Once Kopje stores the account (by its own activity), the next read queues the item.
    const stored = await storedMember(t, "ghost", OTHER);
    expect(stored.uri).toBe(ghost.uri);
    await requestSync(t, ownerId);
    await syncAll(t);
    expect(await items(t)).toMatchObject([
      { uri: entry.id, state: PENDING, account_id: await accountId(t.store, ghost.uri), check_due_at: NOW },
    ]);
  });

  it("runs a refresh's document part before the collections part, keeps a refresh asked during a read, and checks meanwhile", async () => {
    const t = await setup();
    const owner = await featuredOwner(t.web, "owner", COLLECTIONS_ONLY);
    const member = await storedMember(t, "member", OTHER);
    const entry = item(owner, member);
    const listed = collection(owner, [entry]);
    serveCollections(t.web, owner, [[listed]]);
    serveAuthorization(t.web, entry, listed.id);
    const ownerId = await storedOwner(t, owner);
    await syncAll(t);
    expect(await items(t)).toMatchObject([{ state: PENDING, check_due_at: NOW }]);

    // A check claimed, its fetch in flight while the syncs run.
    const check = t.web.hold(entry.featureAuthorization);
    const checked = checkRound(t);
    await check.reached;

    // An invalidated handle with a refresh asked for (remote-actors.ts): the document part, then the read it requests.
    const invalidate = async () => {
      await sql(t.store, "UPDATE accounts SET username = '! ' || id WHERE id = ?", ownerId);
      await sql(
        t.store,
        `INSERT INTO collection_syncs (account_id, due_at, refresh) VALUES (?1, 0, 1)
				ON CONFLICT (account_id) DO UPDATE SET generation = generation + 1, parts_read = 0, collections_read = 0,
					attempts = 0, refresh = 1`,
        ownerId,
      );
    };
    await invalidate();
    const root = owner.featuredCollections;
    const webfinger = webfingerUrl("owner", "mastodon.example");
    const deps = { ...inboxDeps(() => t.store, t.web.loader), now: () => NOW };
    let from = t.web.fetched.length;
    const reading = t.web.hold(root);
    const rounds = syncCollections(t.env, deps);
    await reading.reached;
    // The held fetch is recorded when it is answered.
    expect(t.web.fetched.slice(from)).toEqual([owner.uri, webfinger]);
    expect(await sql(t.store, "SELECT refresh FROM collection_syncs")).toEqual([{ refresh: 0 }]);
    // Invalidated again while the read's round holds the sync: the read's end keeps the refresh.
    await invalidate();
    reading.release();
    expect(await rounds).toBe(true);
    expect(await sql(t.store, "SELECT refresh, collections_read FROM collection_syncs")).toEqual([
      { refresh: 1, collections_read: 0 },
    ]);
    from = t.web.fetched.length;
    expect(await syncCollections(t.env, deps)).toBe(false);
    expect(t.web.fetched.slice(from)).toEqual([owner.uri, webfinger, root, `${root}?page=1`]);
    expect(await sql(t.store, "SELECT account_id FROM collection_syncs")).toEqual([]);

    // The reads listed the item unchanged and kept its claim: the check completes.
    check.release();
    expect(await checked).toBe(false);
    expect(await items(t)).toMatchObject([
      { state: ACCEPTED, approval_uri: entry.featureAuthorization, check_due_at: null, check_token: null },
    ]);
  });

  it("reads a request through only once the stored parts and the collections part are read", async () => {
    const t = await setup();
    const owner = await featuredOwner(t.web, "owner", COLLECTIONS_ONLY);
    const ownerId = await storedOwner(t, owner);
    const stored = PART_FEATURED | PART_NETWORK | PART_TAGS;
    // A claimed read ended with `parts`: the sync's columns after it.
    const end = async (parts: number, claimed: number) => {
      const sync = await t.store.claimCollectionSync(BUILD, { now: NOW });
      if (sync === null || sync === "more") {
        throw new Error("no sync claimed");
      }
      expect([sync.phase, sync.parts]).toEqual(["read", claimed]);
      const counts = { statuses: null, following: null, followers: null };
      const round = { now: NOW, origin: LOCAL, accountUri: owner.uri, generation: sync.generation, token: sync.token };
      const read = { parts, pins: null, tags: null, hideCollections: null, counts, collections: null };
      await t.store.completeCollectionRead(BUILD, { ...round, ...read });
      return sql(
        t.store,
        "SELECT parts_read, collections_read, generation <= read_through AS through FROM collection_syncs",
      );
    };
    for (const [first, second] of [
      [stored, PART_COLLECTIONS],
      [PART_COLLECTIONS, stored],
    ]) {
      await sql(t.store, "DELETE FROM collection_syncs");
      await sql(t.store, "INSERT INTO collection_syncs (account_id, due_at) VALUES (?, ?)", ownerId, NOW);
      expect(await end(first!, 0)).toEqual([
        { parts_read: first! & stored, collections_read: first === PART_COLLECTIONS ? 1 : 0, through: 0 },
      ]);
      // Read through, with nothing pending: the sync ends.
      expect(await end(second!, first!)).toEqual([]);
    }
  });

  describe("and the owner's changes during its read", () => {
    // The stored collections, their names and their items, by uri.
    const stored = (t: Setup) =>
      sql(
        t.store,
        `SELECT c.uri, c.name, (SELECT group_concat(i.uri) FROM collection_items i WHERE i.collection_id = c.id) AS items
				FROM collections c WHERE c.local = 0 ORDER BY c.uri`,
      );
    const activity = (type: "Add" | "Remove", owner: TestActor, target: string, object: unknown) => ({
      "@context": AS,
      type,
      actor: owner.uri,
      target,
      object,
    });

    // An owner with two collections stored by a read, `kept` (one item) and `other` (none).
    async function world() {
      const t = await setup();
      const owner = await featuredOwner(t.web, "owner", COLLECTIONS_ONLY);
      const member = await storedMember(t, "member", OTHER);
      const entry = item(owner, member);
      const kept = collection(owner, [entry]);
      const other = collection(owner, []);
      serveCollections(t.web, owner, [[kept], [other]]);
      const ownerId = await storedOwner(t, owner);
      await syncAll(t);
      return { t, owner, member, entry, kept, other, ownerId };
    }
    type World = Awaited<ReturnType<typeof world>>;

    // Each change, committed by the owner (or a search) while a read waits for its second page, and the pages its
    // server serves after it.
    const CHANGES: [string, (w: World) => Promise<unknown[][]>][] = [
      [
        "an Add of a collection",
        async ({ t, owner, kept, other }) => {
          const added = collection(owner, []);
          expect(await t.post(owner, activity("Add", owner, owner.featuredCollections, added))).toBe(202);
          return [[kept], [other, added]];
        },
      ],
      [
        "an Update of a collection",
        async ({ t, owner, kept, other }) => {
          const renamed = { ...other, name: "renamed" };
          const id = `${owner.uri}#updates/${nextId()}`;
          const update = { "@context": AS, id, type: "Update", actor: owner.uri, object: renamed };
          expect(await t.post(owner, update)).toBe(202);
          return [[kept], [renamed]];
        },
      ],
      [
        "a Remove of a collection",
        async ({ t, owner, kept, other }) => {
          expect(await t.post(owner, activity("Remove", owner, owner.featuredCollections, other.id))).toBe(202);
          return [[kept], []];
        },
      ],
      [
        "an Add of an item",
        async ({ t, owner, member, kept, other }) => {
          const added = item(owner, member);
          expect(await t.post(owner, activity("Add", owner, other.id, added))).toBe(202);
          return [[kept], [{ ...other, orderedItems: [added] }]];
        },
      ],
      [
        "a Remove of an item",
        async ({ t, owner, entry, kept, other }) => {
          expect(await t.post(owner, activity("Remove", owner, kept.id, entry.id))).toBe(202);
          return [[{ ...kept, orderedItems: [] }], [other]];
        },
      ],
      [
        "a search storing a collection",
        async ({ t, owner, kept, other }) => {
          const found = collection(owner, []);
          t.web.serve(found.id, { "@context": AS, ...found });
          const answer = await t.api<{ collections: { uri: string }[] }>(
            `/api/v2/search?resolve=true&q=${encodeURIComponent(found.id)}`,
          );
          expect(answer.body.collections.map((c) => c.uri)).toEqual([found.id]);
          return [[kept], [other, found]];
        },
      ],
    ];

    for (const [name, change] of CHANGES) {
      it(`applies no listing read before ${name}, and reads the collections again`, async () => {
        const w = await world();
        const { t, owner, ownerId } = w;
        const root = owner.featuredCollections;
        await requestSync(t, ownerId);
        // The read fetched the root and page 1; page 2 is answered as served when it was asked for.
        const held = t.web.hold(`${root}?page=2`, { snapshot: true });
        const round = syncCollections(t.env, { ...inboxDeps(() => t.store, t.web.loader), now: () => NOW });
        await held.reached;
        const before = await stored(t);
        serveCollections(t.web, owner, await change(w));
        const changed = await stored(t);
        expect(changed).not.toEqual(before);
        // The read's end, before any later round reads the root again.
        const again = t.web.hold(root);
        held.release();
        await Promise.race([again.reached, round]);
        expect(await stored(t)).toEqual(changed);
        expect(await sql(t.store, "SELECT collections_read FROM collection_syncs")).toEqual([{ collections_read: 0 }]);

        const from = t.web.fetched.length;
        again.release();
        await round;
        await syncAll(t, t.web.loader, NOW + SYNC_RETRY_MS);
        expect(fetchedUnder(t.web, from, root)).toEqual([root, `${root}?page=1`, `${root}?page=2`]);
        expect(await stored(t)).toEqual(changed);
      });
    }

    it("applies a read claimed after the owner's change", async () => {
      const { t, owner, kept, other, ownerId } = await world();
      await requestSync(t, ownerId);
      // An Add while the sync waits, no round holding it.
      const added = collection(owner, []);
      expect(await t.post(owner, activity("Add", owner, owner.featuredCollections, added))).toBe(202);
      serveCollections(t.web, owner, [[kept], [{ ...other, name: "renamed" }, added]]);
      await syncAll(t);
      const expected = [
        [kept.id, kept.name],
        [other.id, "renamed"],
        [added.id, added.name],
      ];
      expect((await collectionRows(t)).map((row) => [row.uri, row.name])).toEqual(
        expected.toSorted(([a], [b]) => (a! < b! ? -1 : 1)),
      );
    });
  });

  describe("its budget", () => {
    const KIB = 1024;
    const padded = <T extends object>(document: T, bytes: number) => {
      const size = new TextEncoder().encode(JSON.stringify({ ...document, padding: "" })).length;
      return { ...document, padding: "x".repeat(bytes - size) };
    };

    it("reads a root and two pages of 500 KiB, each retried with RFC 9421, in one round of six sends", async () => {
      const t = await setup();
      const owner = await featuredOwner(t.web, "owner", COLLECTIONS_ONLY);
      const lists = [Array.from({ length: 5 }, () => collection(owner, [])), [collection(owner, [])]];
      serveCollections(t.web, owner, lists);
      const root = owner.featuredCollections;
      for (const url of [root, `${root}?page=1`, `${root}?page=2`]) {
        const served = t.web.served.get(url)!;
        t.web.serve(url, padded(served.body as object, 500 * KIB));
      }
      await storedOwner(t, owner);
      const sent: string[] = [];
      const loader = { ...t.web.loader, fetch: cavageRefused(t.web, root, sent) };
      const deps = { ...inboxDeps(() => t.store, loader), now: () => NOW };
      expect(await syncCollections(t.env, deps)).toBe(false);
      expect(sent).toHaveLength(6);
      expect((await collectionRows(t)).length).toBe(6);
      expect(await sql(t.store, "SELECT account_id FROM collection_syncs")).toEqual([]);
    });

    for (const [name, last] of [
      ["past 512 KiB", (web: RemoteWeb, url: string, body: object) => web.serve(url, padded(body, 513 * KIB))],
      ["redirected", (web: RemoteWeb, url: string) => web.redirect(url, `${url}&again`)],
    ] as const) {
      it(`settles a page ${name} as unreadable after two sends, completing the part with what it read before`, async () => {
        const t = await setup();
        const owner = await featuredOwner(t.web, "owner", COLLECTIONS_ONLY);
        const kept = collection(owner, []);
        const unread = collection(owner, []);
        serveCollections(t.web, owner, [[kept], [unread]]);
        const root = owner.featuredCollections;
        const page = `${root}?page=2`;
        last(t.web, page, t.web.served.get(page)!.body as object);
        t.web.redirect(`${page}&again`, page);
        await storedOwner(t, owner);
        const sent: string[] = [];
        const loader = { ...t.web.loader, fetch: cavageRefused(t.web, root, sent) };
        const deps = { ...inboxDeps(() => t.store, loader), now: () => NOW };
        expect(await syncCollections(t.env, deps)).toBe(false);
        expect(sent.filter((url) => url.startsWith(page))).toEqual([page, page]);
        expect((await collectionRows(t)).map((row) => row.uri)).toEqual([kept.id]);
        // The part is read through: no round reads it again.
        expect(await sql(t.store, "SELECT account_id FROM collection_syncs")).toEqual([]);
        expect(COLLECTIONS_CAPS).toEqual({ documentBytes: 512 * KIB, maxRedirects: 0 });
        expect(PART_COLLECTIONS).toBe(8);
      });
    }
  });
});

// ---- A local member's row in a remote collection (#1589's D21 and D24).

type Featured = { t: Setup; owner: TestActor & { featuredCollections: string }; listed: ReturnType<typeof collection> };

let featuredOwners = 0;

// A remote owner holding one collection (listed, served) that alice is featured in, accepted on its FeatureRequest:
// her row, unlisted (its uri NULL) and waiting on nothing.
async function featuring(items: unknown[] = []): Promise<Featured & { ownerId: string; row: string }> {
  const t = await setup();
  await sql(t.store, "UPDATE accounts SET discoverable = 1 WHERE id = ?", ALICE);
  const owner = await featuredOwner(t.web, `fo${++featuredOwners}`, COLLECTIONS_ONLY);
  const listed = collection(owner, items);
  serveListing(t.web, owner, listed);
  const ownerId = await storedOwner(t, owner);
  await syncAll(t);
  expect(await t.post(owner, featureRequest(owner, ALICE_URI, listed.id))).toBe(202);
  const [row] = await localRows(t, ALICE);
  expect(row).toMatchObject({ state: ACCEPTED, uri: null, check_due_at: null, answer: null });
  return { t, owner, listed, ownerId, row: row!.id };
}

// The owner's item listing alice's row by the authorization Kopje serves for it.
const servedItem = (w: Featured & { row: string }) =>
  localItem(w.owner, ALICE_URI, `${ALICE_URI}/feature_authorizations/${w.row}`);

// A read of the owner's collections claimed and completed at `at`, the collection listing `entries`.
async function readAt(w: Featured & { ownerId: string }, entries: unknown[], at: number): Promise<void> {
  w.listed.orderedItems = entries;
  w.listed.totalItems = entries.length;
  serveListing(w.t.web, w.owner, w.listed);
  await requestSync(w.t, w.ownerId);
  await syncAll(w.t, w.t.web.loader, at);
}

const syncsOf = (t: Setup) => sql<{ account_id: string }>(t.store, "SELECT account_id FROM collection_syncs");

describe("a local member's row and the reads of its owner's collections", () => {
  // Fails if a read's omission deletes the row (threat-model.md ID-9: an omission hides, only evidence deletes), or if
  // a read that lists it leaves it hidden.
  it("shows the row on a read that lists it, and hides it, never deletes it, on one that omits it", async () => {
    const w = await featuring();
    const served = servedItem(w);
    await readAt(w, [served], NOW + 60_000);
    expect(await localRows(w.t, ALICE)).toMatchObject([{ id: w.row, state: ACCEPTED, uri: served.id, position: 1 }]);
    for (const at of [NOW + 120_000, NOW + 180_000]) {
      await readAt(w, [], at);
      expect(await localRows(w.t, ALICE)).toMatchObject([{ id: w.row, state: ACCEPTED, uri: null }]);
    }
    // Listed again: shown again, the same row.
    await readAt(w, [served], NOW + 240_000);
    expect(await localRows(w.t, ALICE)).toMatchObject([{ id: w.row, state: ACCEPTED, uri: served.id }]);
  });

  // Code review r2: an entry whose item cannot be one of the collection's (an item on another origin) lists no one, so
  // a read whose only entry naming the row's authorization is one hides the row, at its place. Fails if the read takes
  // that entry for the row's (the row kept shown under its old item, moved to the entry's position, or shown under the
  // foreign item).
  it("hides the row on a read whose only entry naming its authorization is an item on another origin", async () => {
    const w = await featuring();
    const served = servedItem(w);
    await readAt(w, [served], NOW + 60_000);
    expect(await localRows(w.t, ALICE)).toMatchObject([{ id: w.row, uri: served.id, position: 1 }]);
    const ghost = item(w.owner, { uri: `${OTHER}/users/ghost` });
    const foreign = { ...servedItem(w), id: `${OTHER}/collection_items/${nextId()}` };
    await readAt(w, [ghost, foreign], NOW + 120_000);
    expect(await localRows(w.t, ALICE)).toMatchObject([{ id: w.row, state: ACCEPTED, uri: null, position: 1 }]);
  });

  // Code review r3: an entry whose item uri another row holds (here another collection's item, on the owner's origin)
  // names no row of a local member either, so a read whose only entry naming the row's authorization is one hides the
  // row, at its place. Fails if the read takes that entry for the row's (the row kept shown under its old item and moved
  // to the entry's position).
  it("hides the row on a read whose only entry naming its authorization is an item another collection holds", async () => {
    const w = await featuring();
    const held = item(w.owner, { uri: `${OTHER}/users/held` });
    const other = collection(w.owner, [held]);
    const read = async (entries: unknown[], at: number) => {
      w.listed.orderedItems = entries;
      w.listed.totalItems = entries.length;
      serveListing(w.t.web, w.owner, w.listed);
      serveCollections(w.t.web, w.owner, [[w.listed, other]]);
      await requestSync(w.t, w.ownerId);
      await syncAll(w.t, w.t.web.loader, at);
    };
    const served = servedItem(w);
    await read([served], NOW + 60_000);
    expect(await localRows(w.t, ALICE)).toMatchObject([{ id: w.row, uri: served.id, position: 1 }]);
    const holder = () =>
      sql(
        w.t.store,
        "SELECT c.uri FROM collection_items i JOIN collections c ON c.id = i.collection_id WHERE i.uri = ?",
        held.id,
      );
    expect(await holder()).toEqual([{ uri: other.id }]);
    const ghost = item(w.owner, { uri: `${OTHER}/users/ghost` });
    await read([ghost, { ...servedItem(w), id: held.id }], NOW + 120_000);
    expect(await holder()).toEqual([{ uri: other.id }]);
    expect(await localRows(w.t, ALICE)).toMatchObject([{ id: w.row, state: ACCEPTED, uri: null, position: 1 }]);
  });

  // Fails if a read hides a row changed at or after its claim (its listing may predate the change), the same
  // millisecond included, or hides a revoked row.
  it("keeps a row changed at or after the read's claim shown, and leaves a revoked row to the cleanup", async () => {
    const w = await featuring();
    const served = servedItem(w);
    await readAt(w, [served], NOW + 60_000);
    // The read is claimed at NOW + 120 s; the row changes at NOW + 150 s, while its listing is read; it completes at
    // NOW + 180 s.
    let clock = NOW + 120_000;
    const page = `${w.owner.featuredCollections}?page=1`;
    const loader = {
      ...w.t.web.loader,
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (request.url === page && clock === NOW + 120_000) {
          await sql(
            w.t.store,
            "UPDATE collection_items SET updated_at = ? WHERE id = ?",
            new Date(NOW + 150_000).toISOString(),
            w.row,
          );
          clock = NOW + 180_000;
        }
        return w.t.web.fetch(request);
      },
    };
    w.listed.orderedItems = [];
    serveListing(w.t.web, w.owner, w.listed);
    await requestSync(w.t, w.ownerId);
    const deps = { ...inboxDeps(() => w.t.store, loader), now: () => clock };
    for (let round = 0; round < 8 && (await syncCollections(w.t.env, deps)); round++) {
      // Another sync waits.
    }
    expect(await localRows(w.t, ALICE)).toMatchObject([{ id: w.row, uri: served.id }]);
    // Changed in the millisecond of the claim: kept too.
    await sql(
      w.t.store,
      "UPDATE collection_items SET updated_at = ? WHERE id = ?",
      new Date(NOW + 240_000).toISOString(),
      w.row,
    );
    await readAt(w, [], NOW + 240_000);
    expect(await localRows(w.t, ALICE)).toMatchObject([{ id: w.row, uri: served.id }]);
    // A later read, claimed after the change, hides it.
    await readAt(w, [], NOW + 300_000);
    expect(await localRows(w.t, ALICE)).toMatchObject([{ id: w.row, state: ACCEPTED, uri: null }]);

    // A revoked row: no read hides or deletes it.
    const v = await featuring();
    const listedV = servedItem(v);
    await readAt(v, [listedV], NOW + 60_000);
    await sql(v.t.store, "UPDATE collection_items SET state = 3 WHERE id = ?", v.row);
    await readAt(v, [], NOW + 120_000);
    expect(await localRows(v.t, ALICE)).toMatchObject([{ id: v.row, state: 3, uri: listedV.id }]);
  });

  // Fails if a truncated listing (more than MAX_REMOTE_ITEMS orderedItems) hides the row it does not name among its
  // first MAX_REMOTE_ITEMS: the row may be listed past them.
  it("hides nothing on a truncated listing", async () => {
    const w = await featuring();
    const served = servedItem(w);
    await readAt(w, [served], NOW + 60_000);
    const members = await seededMembers(w.t, MAX_REMOTE_ITEMS + 1, "t");
    await readAt(
      w,
      members.map((member) => item(w.owner, member)),
      NOW + 120_000,
    );
    expect(await localRows(w.t, ALICE)).toMatchObject([{ id: w.row, state: ACCEPTED, uri: served.id }]);
    // The local row holds its slot: the remote members' items fill the 24 left.
    expect((await items(w.t, w.listed.id)).filter((row) => row.account_id !== ALICE)).toHaveLength(
      MAX_REMOTE_ITEMS - 1,
    );
    await readAt(
      w,
      members.slice(0, MAX_REMOTE_ITEMS).map((member) => item(w.owner, member)),
      NOW + 180_000,
    );
    expect(await localRows(w.t, ALICE)).toMatchObject([{ id: w.row, state: ACCEPTED, uri: null }]);
  });

  // An owner's Add or Update of the whole collection, and a search, only show (a push may be a late copy).
  // Fails if either hides or deletes a local member's row it leaves out.
  for (const kind of ["Add", "Update"] as const) {
    it(`keeps a row an owner's ${kind} of the collection leaves out shown`, async () => {
      const w = await featuring();
      const served = servedItem(w);
      await readAt(w, [served], NOW - 60_000);
      // The collection as the owner sends it, without alice's item.
      const object = { ...w.listed, orderedItems: [], totalItems: 0, name: "renamed" };
      const actor = w.owner.uri;
      const body =
        kind === "Add"
          ? { "@context": AS, type: "Add", actor, target: w.owner.featuredCollections, object }
          : { "@context": AS, id: `${actor}#updates/${nextId()}`, type: "Update", actor, object };
      expect(await w.t.post(w.owner, body)).toBe(202);
      expect(await sql(w.t.store, "SELECT name FROM collections WHERE uri = ?", w.listed.id)).toEqual([
        { name: "renamed" },
      ]);
      expect(await localRows(w.t, ALICE)).toMatchObject([{ id: w.row, state: ACCEPTED, uri: served.id }]);
    });
  }

  // Fails if a complete read that does not list a collection holding a local member's row deletes it (pages that
  // shift between a read's fetches may omit a live collection), or if the cleanup of its last local row does not ask
  // for the read that reclaims it.
  it("keeps a collection holding a local member's row that a complete read omits, until the cleanup of the row", async () => {
    const w = await featuring();
    const other = collection(w.owner, []);
    serveCollections(w.t.web, w.owner, [[w.listed, other]]);
    await requestSync(w.t, w.ownerId);
    await syncAll(w.t, w.t.web.loader, NOW + 60_000);
    // A complete read listing neither: the one without a local member's row is deleted.
    serveCollections(w.t.web, w.owner, [[]]);
    await requestSync(w.t, w.ownerId);
    await syncAll(w.t, w.t.web.loader, NOW + 120_000);
    expect((await collectionRows(w.t)).map((row) => row.uri)).toEqual([w.listed.id]);
    expect(await localRows(w.t, ALICE)).toMatchObject([{ id: w.row, state: ACCEPTED }]);
    // Revoked (a retired row keeps it too), then the cleanup past RETIRED_ITEM_TTL_MS: the row deleted and one read of
    // the owner asked for, which deletes the collection.
    await sql(
      w.t.store,
      "UPDATE collection_items SET state = 3, updated_at = ? WHERE id = ?",
      new Date(NOW + 120_000).toISOString(),
      w.row,
    );
    await requestSync(w.t, w.ownerId);
    await syncAll(w.t, w.t.web.loader, NOW + 180_000);
    expect((await collectionRows(w.t)).map((row) => row.uri)).toEqual([w.listed.id]);
    const later = NOW + 120_000 + 86_400_000 + 1;
    // Its added_to_collection notification, the row and the read it asks for.
    expect(await prune(w.t, later)).toEqual({ deleted: 3 });
    expect(await localRows(w.t, ALICE)).toEqual([]);
    expect(await syncsOf(w.t)).toEqual([{ account_id: w.ownerId }]);
    await syncAll(w.t, w.t.web.loader, later);
    expect(await collectionRows(w.t)).toEqual([]);
  });

  // RES-4 for the reclamation: a local member's retired row in a remote collection takes two writes of the round's
  // RETIRED_ROWS_PER_ROUND (its delete and its owner's sync request), after the child rows. Fails if the request is not
  // counted (the round writes past its budget) or the rows past it are lost rather than left to the next round.
  it("deletes at most half the round's budget left of local members' retired rows, and continues the next round", async () => {
    const t = await setup();
    const owner = await featuredOwner(t.web, `fo${++featuredOwners}`, COLLECTIONS_ONLY);
    const ownerId = await storedOwner(t, owner);
    await sql(t.store, "DELETE FROM collection_syncs");
    const old = new Date(NOW - 86_400_000 - 1).toISOString();
    // 6 collections of 50 retired rows, one for each of 50 local accounts, and 41 notifications of them (alice's: a
    // notification's recipient is an account with a local_accounts row).
    await sql(
      t.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50)
			INSERT INTO accounts (id, uri, username, domain) SELECT '7' || printf('%017d', i), ?1 || '/ap/users/r' || i, 'r' || i, NULL FROM n`,
      LOCAL,
    );
    await sql(
      t.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 6)
			INSERT INTO collections (id, account_id, local, name, sensitive, discoverable, uri, created_at, updated_at)
			SELECT '6' || printf('%017d', i), ?1, 0, 'c' || i, 0, 1, ?2 || '/collections/r' || i, ?3, ?3 FROM n`,
      ownerId,
      owner.uri,
      old,
    );
    await sql(
      t.store,
      `WITH RECURSIVE c(k) AS (SELECT 1 UNION ALL SELECT k + 1 FROM c WHERE k < 6),
				m(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM m WHERE i < 50)
			INSERT INTO collection_items (id, collection_id, account_id, state, position, created_at, updated_at)
			SELECT '8' || printf('%03d', k) || printf('%014d', i), '6' || printf('%017d', k), '7' || printf('%017d', i), 3, i,
				?1, ?1
			FROM c CROSS JOIN m`,
      old,
    );
    await sql(
      t.store,
      `INSERT INTO notifications (account_id, type, from_account_id, collection_item_id, created_at)
			SELECT ?3, 'added_to_collection', ?1, id, ?2 FROM collection_items ORDER BY id LIMIT 41`,
      ownerId,
      old,
      ALICE,
    );
    const left = async () => (await sql<{ n: number }>(t.store, "SELECT count(*) AS n FROM collection_items"))[0]!.n;
    // The notifications, then 229 rows: the one write left is not enough for another.
    const rows = Math.floor((RETIRED_ROWS_PER_ROUND - 41) / 2);
    expect(await prune(t, NOW)).toEqual({ deleted: 41 + 2 * rows });
    expect(await left()).toBe(300 - rows);
    expect(await syncsOf(t)).toEqual([{ account_id: ownerId }]);
    expect(await prune(t, NOW)).toEqual({ deleted: 2 * (300 - rows) });
    expect(await left()).toBe(0);
  });

  // A retired item of a member Kopje does not know (object_uri only) is a remote member's: its cleanup takes one write
  // and requests no read. Fails if the cleanup reads a missing account as a local one.
  it("requests no read at the cleanup of a retired item of a member Kopje does not know", async () => {
    const t = await setup();
    const owner = await featuredOwner(t.web, `fo${++featuredOwners}`, COLLECTIONS_ONLY);
    const ownerId = await storedOwner(t, owner);
    await sql(t.store, "DELETE FROM collection_syncs");
    const old = new Date(NOW - 86_400_000 - 1).toISOString();
    await sql(
      t.store,
      `INSERT INTO collections (id, account_id, local, name, sensitive, discoverable, uri, created_at, updated_at)
			VALUES ('600000000000000001', ?1, 0, 'c', 0, 1, ?2 || '/collections/u', ?3, ?3)`,
      ownerId,
      owner.uri,
      old,
    );
    await sql(
      t.store,
      `INSERT INTO collection_items (id, collection_id, object_uri, state, position, created_at, updated_at)
			VALUES ('800000000000000001', '600000000000000001', ?1, 3, 1, ?2, ?2)`,
      `${OTHER}/users/unknown`,
      old,
    );
    expect(await prune(t, NOW)).toEqual({ deleted: 1 });
    expect(await syncsOf(t)).toEqual([]);
  });

  // Fails if a read admits a new collection only under MAX_REMOTE_COLLECTIONS (a kept collection would then take one of
  // the slots of those it lists), or if a push admits one past MAX_REMOTE_COLLECTIONS.
  it("admits a read's collections up to MAX_STORED_COLLECTIONS, and a push's up to MAX_REMOTE_COLLECTIONS", async () => {
    const w = await featuring();
    const fresh = Array.from({ length: MAX_REMOTE_COLLECTIONS }, () => collection(w.owner, []));
    serveCollections(w.t.web, w.owner, [fresh]);
    await requestSync(w.t, w.ownerId);
    await syncAll(w.t, w.t.web.loader, NOW + 60_000);
    expect((await collectionRows(w.t)).map((row) => row.uri).toSorted()).toEqual(
      [w.listed.id, ...fresh.map((c) => c.id)].toSorted(),
    );
    const pushed = collection(w.owner, []);
    const add = {
      "@context": AS,
      type: "Add",
      actor: w.owner.uri,
      target: w.owner.featuredCollections,
      object: pushed,
    };
    expect(await w.t.post(w.owner, add)).toBe(202);
    expect(await collectionRows(w.t)).toHaveLength(MAX_REMOTE_COLLECTIONS + 1);
  });

  // 6-T8. Fails if the read applies the first 25 listed items regardless of local rows (the live trigger refuses the
  // 25th and the part never completes), if a retired row takes a live slot, or if the request's row meets the trigger.
  it("applies a listing into the slots local members' rows leave, and gives a request a slot", async () => {
    const w = await featuring();
    const members = await seededMembers(w.t, MAX_REMOTE_ITEMS, "s");
    const entries = members.map((member) => item(w.owner, member));
    // Their servers serve each authorization, so their checks accept them (live items).
    for (const entry of entries) {
      serveAuthorization(w.t.web, entry, w.listed.id);
    }
    await readAt(w, entries, NOW);
    let stored = await items(w.t, w.listed.id);
    expect(stored.filter((row) => row.account_id === ALICE)).toHaveLength(1);
    expect(stored.filter((row) => row.account_id !== ALICE).map((row) => row.object_uri)).toEqual(
      members.slice(0, MAX_REMOTE_ITEMS - 1).map((member) => member.uri),
    );
    // Alice's row retired: it holds no live slot, and the next read stores all 25.
    await sql(w.t.store, "UPDATE collection_items SET state = 3 WHERE id = ?", w.row);
    await readAt(w, entries, NOW + 60_000);
    stored = await items(w.t, w.listed.id);
    expect(stored.filter((row) => row.account_id !== ALICE).map((row) => row.object_uri)).toEqual(
      members.map((member) => member.uri),
    );
    // The cleanup deleted it; a request while the collection holds 25 remote members' items: the last-positioned one
    // deleted, alice's row stored and accepted.
    await sql(w.t.store, "DELETE FROM collection_items WHERE id = ?", w.row);
    expect(await w.t.post(w.owner, featureRequest(w.owner, ALICE_URI, w.listed.id))).toBe(202);
    stored = await items(w.t, w.listed.id);
    expect(stored.filter((row) => row.account_id === ALICE)).toMatchObject([{ state: ACCEPTED }]);
    expect(stored.filter((row) => row.account_id !== ALICE).map((row) => row.object_uri)).toEqual(
      members.slice(0, MAX_REMOTE_ITEMS - 1).map((member) => member.uri),
    );
    expect((await outbound(w.t, ALICE)).at(-1)!.activity.type).toBe("Accept");
    // An Add of another remote member's item to the full collection: not stored, no error.
    const [extra] = await seededMembers(w.t, 1, "x");
    const added = item(w.owner, extra!);
    expect(
      await w.t.post(w.owner, { "@context": AS, type: "Add", actor: w.owner.uri, target: w.listed.id, object: added }),
    ).toBe(202);
    expect(await sql(w.t.store, "SELECT 1 FROM collection_items WHERE uri = ?", added.id)).toEqual([]);
  });

  // Fails if a request evicts a local member's row for its slot.
  it("refuses a request when local members' rows hold every live slot", async () => {
    const w = await featuring();
    const collectionId = (
      await sql<{ id: string }>(w.t.store, "SELECT id FROM collections WHERE uri = ?", w.listed.id)
    )[0]!.id;
    // Alice's row retired and cleaned up (the grant guard lets a retired row go).
    await sql(w.t.store, "UPDATE collection_items SET state = 3 WHERE id = ?", w.row);
    await sql(w.t.store, "DELETE FROM collection_items WHERE collection_id = ?", collectionId);
    const at = new Date(NOW).toISOString();
    await sql(
      w.t.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO accounts (id, uri, username, domain) SELECT '7' || printf('%017d', i), ?2 || '/ap/users/l' || i, 'l' || i, NULL FROM n`,
      MAX_REMOTE_ITEMS,
      LOCAL,
    );
    await sql(
      w.t.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO collection_items (id, collection_id, account_id, state, position, created_at, updated_at)
			SELECT '8' || printf('%017d', i), ?2, '7' || printf('%017d', i), 1, i, ?3, ?3 FROM n`,
      MAX_REMOTE_ITEMS,
      collectionId,
      at,
    );
    const request = featureRequest(w.owner, ALICE_URI, w.listed.id);
    expect(await w.t.post(w.owner, request)).toBe(202);
    expect(await localRows(w.t, ALICE)).toEqual([]);
    expect((await outbound(w.t, ALICE)).at(-1)!.activity).toMatchObject({ type: "Reject", object: request.id });
    expect(await sql<{ n: number }>(w.t.store, "SELECT count(*) AS n FROM collection_items")).toEqual([
      { n: MAX_REMOTE_ITEMS },
    ]);
  });
});

// One round of the cron's cleanup of retired items at `now`.
function prune(t: Setup, now: number) {
  return runInDurableObject(t.store, (_instance, state) =>
    state.storage.transactionSync(() =>
      pruneCollectionItems.run(state.storage.sql, { now }, (fn) => state.storage.transactionSync(fn)),
    ),
  );
}

// RES-7 for a local member's rows (#1589's D21 and D24): each statement it adds walks one collection's rows
// (collection_items_order, at most MAX_STORED_ITEMS by the trigger), one owner's collections (collections_account, at
// most MAX_STORED_COLLECTIONS) or reads one row by a unique key. Statistics are taken (ANALYZE) on a small world; the
// grown world then fills two of the owner's collections to their stored cap, the one with every live slot taken (25
// live remote members, 25 retired rows: takeSlot frees a live slot) and the other with one live slot free (24 and 26:
// takeSlot frees a stored row), and grows every other key past it: the owner's 8 other collections and another owner's
// 10 at their caps. Each statement's rows grow by at most its key's bound.
describe("a local member's reads at their caps, on statistics from before the growth", () => {
  type Measured = { query: string; rows: number };

  // Runs `fn` on a Db over the Store's storage in one transaction, each statement's rows read recorded.
  function measuredDomain<T>(t: Setup, fn: (db: Db) => T): Promise<{ output: T; statements: Measured[] }> {
    return runInDurableObject(t.store, (_instance, state) => {
      const statements: Measured[] = [];
      const real = state.storage.sql;
      const counting = {
        exec: (query: string, ...params: SqlStorageValue[]) => {
          const cursor = real.exec(query, ...params);
          const entry = { query: query.replace(/\s+/g, " ").trim(), rows: 0 };
          statements.push(entry);
          return watchedCursor(cursor, () => (entry.rows = cursor.rowsRead));
        },
      } as unknown as SqlStorage;
      const output = state.storage.transactionSync(() =>
        fn(new Db(counting, (inner) => state.storage.transactionSync(inner))),
      );
      return { output, statements };
    });
  }

  async function readsWorld(grown: boolean) {
    const t = await setup();
    await sql(t.store, "UPDATE accounts SET discoverable = 1 WHERE id = ?", ALICE);
    const n = ++featuredOwners;
    const owner = await featuredOwner(t.web, `rw${n}`, COLLECTIONS_ONLY);
    const listed = collection(owner, []);
    const second = collection(owner, []);
    serveListing(t.web, owner, listed);
    serveCollections(t.web, owner, [[listed, second]]);
    const ownerId = await storedOwner(t, owner);
    await syncAll(t);
    await sql(t.store, "ANALYZE");
    if (grown) {
      const members = await seededMembers(t, 10 * MAX_REMOTE_ITEMS, `g${n}m`);
      const page = (of: TestActor, from: number) =>
        members.slice(from, from + MAX_REMOTE_ITEMS).map((member) => item(of, member));
      listed.orderedItems = page(owner, 0);
      second.orderedItems = page(owner, MAX_REMOTE_ITEMS);
      const others = Array.from({ length: 8 }, (_, k) => collection(owner, page(owner, (k + 2) * MAX_REMOTE_ITEMS)));
      serveCollections(t.web, owner, [[listed, second, ...others.slice(0, 3)], others.slice(3)]);
      await requestSync(t, ownerId);
      await syncAll(t);
      const x = await featuredOwner(t.web, `rx${n}`, COLLECTIONS_ONLY, OTHER);
      serveCollections(t.web, x, [
        Array.from({ length: 5 }, (_, k) => collection(x, page(x, k * MAX_REMOTE_ITEMS))),
        Array.from({ length: 5 }, (_, k) => collection(x, page(x, (k + 5) * MAX_REMOTE_ITEMS))),
      ]);
      await storedOwner(t, x);
      await syncAll(t);
      // Both collections at their stored cap: 25 retired rows besides their 25 items, the second's last item retired.
      const retired = await seededMembers(t, MAX_STORED_ITEMS - MAX_REMOTE_ITEMS, `r${n}m`);
      for (const [k, { id }] of [listed, second].entries()) {
        await sql(
          t.store,
          `INSERT INTO collection_items (id, collection_id, account_id, state, position, uri, created_at, updated_at)
					SELECT '8' || printf('%017d', ?1 + j.key), c.id, a.id, 3, 1000 + j.key,
						?3 || '/collection_items/r' || ?1 || '-' || j.key, ?4, ?4
					FROM json_each(?2) j CROSS JOIN accounts a ON a.uri = j.value CROSS JOIN collections c ON c.uri = ?5`,
          n * 1000 + k * 100,
          JSON.stringify(retired.map((member) => member.uri)),
          owner.uri,
          new Date(NOW - 86_400_000).toISOString(),
          id,
        );
      }
      await sql(
        t.store,
        `UPDATE collection_items SET state = 3 WHERE id = (SELECT i.id FROM collection_items i
				CROSS JOIN collections c ON c.id = i.collection_id
				WHERE c.uri = ? AND i.state IN (0, 1) ORDER BY i.position DESC LIMIT 1)`,
        second.id,
      );
      const stored = await sql<{ items: number }>(t.store, "SELECT count(*) AS items FROM collection_items");
      expect(stored[0]!.items).toBeGreaterThanOrEqual(20 * MAX_REMOTE_ITEMS);
      const capped = await sql<{ live: number; total: number }>(
        t.store,
        `SELECT count(*) FILTER (WHERE i.state IN (0, 1)) AS live, count(*) AS total FROM collection_items i
				CROSS JOIN collections c ON c.id = i.collection_id WHERE c.uri IN (?, ?) GROUP BY c.uri ORDER BY c.uri = ?`,
        listed.id,
        second.id,
        second.id,
      );
      expect(capped).toEqual([
        { live: MAX_REMOTE_ITEMS, total: MAX_STORED_ITEMS },
        { live: MAX_REMOTE_ITEMS - 1, total: MAX_STORED_ITEMS },
      ]);
    }
    return { t, owner, listed, second, ownerId };
  }

  // The exemption's and the admission's ceilings, every input at its cap at once: the owner's MAX_STORED_COLLECTIONS
  // collections, none listed, each at MAX_STORED_ITEMS rows (24 live remote members, 25 retired, and one local member's
  // accepted row last in collection_items_order), and another owner's as many, on statistics from one collection.
  it("keeps every collection a local member's row holds, reading at most each one's stored rows, at every cap", async () => {
    const t = await setup();
    const n = ++featuredOwners;
    const owner = await featuredOwner(t.web, `rc${n}`, COLLECTIONS_ONLY);
    const other = await featuredOwner(t.web, `rd${n}`, COLLECTIONS_ONLY, OTHER);
    const ownerId = await storedOwner(t, owner);
    const otherId = await storedOwner(t, other);
    serveListing(t.web, owner, collection(owner, []));
    await syncAll(t);
    await sql(t.store, "ANALYZE");
    const members = await seededMembers(t, MAX_STORED_ITEMS - 1, `c${n}m`);
    const at = new Date(NOW - 60_000).toISOString();
    await sql(t.store, "DELETE FROM collections WHERE account_id = ?", ownerId);
    for (const [k, account] of [ownerId, otherId].entries()) {
      await sql(
        t.store,
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
				INSERT INTO collections (id, account_id, local, name, sensitive, discoverable, uri, created_at, updated_at)
				SELECT '6' || printf('%d', ?2) || printf('%016d', i), ?3, 0, 'c' || i, 0, 1, a.uri || '/collections/cap' || i, ?4, ?4
				FROM n CROSS JOIN accounts a ON a.id = ?3`,
        MAX_STORED_COLLECTIONS,
        k,
        account,
        at,
      );
    }
    // Each collection's rows: the remote members first (the first 24 live, the rest retired), alice's accepted row
    // last.
    await sql(
      t.store,
      `INSERT INTO collection_items (id, collection_id, account_id, state, position, created_at, updated_at)
			SELECT '8' || substr(c.id, 2, 1) || substr(c.id, 16, 3) || printf('%013d', j.key), c.id, a.id,
				CASE WHEN j.key < ?2 THEN 1 ELSE 3 END, j.key + 1, ?3, ?3
			FROM collections c CROSS JOIN json_each(?1) j CROSS JOIN accounts a ON a.uri = j.value
			WHERE c.uri LIKE '%/collections/cap%'`,
      JSON.stringify(members.map((member) => member.uri)),
      MAX_REMOTE_ITEMS - 1,
      at,
    );
    await sql(
      t.store,
      `INSERT INTO collection_items (id, collection_id, account_id, state, position, created_at, updated_at)
			SELECT '8' || substr(c.id, 2, 1) || substr(c.id, 16, 3) || printf('%013d', 999), c.id, ?1, 1, ?2, ?3, ?3
			FROM collections c WHERE c.uri LIKE '%/collections/cap%'`,
      ALICE,
      MAX_STORED_ITEMS,
      at,
    );
    const capped = await sql<{ n: number }>(
      t.store,
      "SELECT count(*) AS n FROM collection_items i JOIN collections c ON c.id = i.collection_id WHERE c.account_id = ?",
      ownerId,
    );
    expect(capped).toEqual([{ n: MAX_STORED_COLLECTIONS * MAX_STORED_ITEMS }]);
    const unlisted = await measuredDomain(t, (db) => deleteUnlisted(db, ownerId, []));
    expect(await sql(t.store, "SELECT count(*) AS n FROM collections WHERE account_id = ?", ownerId)).toEqual([
      { n: MAX_STORED_COLLECTIONS },
    ]);
    const [walk] = unlisted.statements;
    // The owner's collections (each an index entry and its row, for its uri), and each one's rows walked to its last,
    // with one account probe each; the two scans' ends.
    expect(walk!.rows).toBeGreaterThanOrEqual(MAX_STORED_COLLECTIONS * 2 * MAX_STORED_ITEMS);
    expect(walk!.rows).toBeLessThanOrEqual(MAX_STORED_COLLECTIONS * 2 * (1 + MAX_STORED_ITEMS) + 2);
    // A read's new collection at the cap: refused on the gate's count, at most MAX_STORED_COLLECTIONS entries.
    const fresh = collection(owner, []);
    const admitted = await measuredDomain(t, (db) =>
      applyFeaturedCollection(
        db,
        { id: ownerId, uri: owner.uri },
        {
          id: fresh.id,
          attributedTo: owner.uri,
          name: fresh.name,
          summary: "",
          language: null,
          sensitive: false,
          discoverable: true,
          totalItems: 0,
          topic: null,
          url: fresh.url,
          items: [],
          truncated: false,
        },
        new URL(owner.uri).origin,
        NOW,
        { kind: "read", since: NOW },
      ),
    );
    expect(admitted.output).toEqual({ collection: null, queued: false, full: true });
    const counted = admitted.statements.filter(({ query }) => query.includes("collections_account"));
    expect(counted.map(({ rows }) => rows)).toEqual([expect.any(Number)]);
    expect(counted[0]!.rows).toBeLessThanOrEqual(MAX_STORED_COLLECTIONS);
    expect(Math.max(...admitted.statements.map(({ rows }) => rows))).toBeLessThanOrEqual(MAX_STORED_COLLECTIONS);
  });

  it("answers a request, lists and keeps the collection within one collection's stored rows", async () => {
    const run = async (w: Awaited<ReturnType<typeof readsWorld>>) => {
      const collectionId = (
        await sql<{ id: string }>(w.t.store, "SELECT id FROM collections WHERE uri = ?", w.listed.id)
      )[0]!.id;
      const owner = { id: w.ownerId, uri: w.owner.uri };
      // A request into each collection: in the grown world, the first frees a live slot, the second a stored row.
      const answer = await measuredDomain(w.t, (db) =>
        [w.listed, w.second].map((instrument, k) =>
          answerFeatureRequest(
            db,
            owner,
            { id: `${new URL(w.owner.uri).origin}/requests/${k}`, object: ALICE_URI, instrument: instrument.id },
            undefined,
            LOCAL,
            NOW,
          ),
        ),
      );
      expect(answer.output).toEqual([
        { kind: "answered", reason: "feature-accepted" },
        { kind: "answered", reason: "feature-accepted" },
      ]);
      // A listing's read of the local rows, and a complete read's deletion of the collections it does not list, which
      // walks the two holding alice's rows and deletes none of them.
      const uris = (await collectionRows(w.t)).filter((row) => row.account_id === w.ownerId).map((row) => row.uri);
      const listing = await measuredDomain(w.t, (db) => {
        deleteUnlisted(
          db,
          w.ownerId,
          uris.filter((uri) => uri !== w.listed.id && uri !== w.second.id),
        );
        return localRowsOf(db, collectionId, NOW);
      });
      expect(listing.output).toHaveLength(1);
      expect((await collectionRows(w.t)).filter((row) => row.account_id === w.ownerId)).toHaveLength(uris.length);
      return [...answer.statements, ...listing.statements];
    };
    const few = byQuery(await run(await readsWorld(false)));
    const manyStatements = await run(await readsWorld(true));
    const many = byQuery(manyStatements);
    // Both of takeSlot's deletes ran in the grown world.
    expect(
      ["ORDER BY i.position DESC, i.id DESC LIMIT 1", "ORDER BY updated_at, id LIMIT 1"].map((tail) =>
        [...many.keys()].some((query) => query.startsWith("DELETE FROM collection_items") && query.includes(tail)),
      ),
    ).toEqual([true, true]);
    const grown = [...many].flatMap(([query, { rows, runs }]) => {
      // A walk of the owner's collection grows by at most its stored rows, twice where it joins their members, and a
      // new row by its two triggers' counts of the collection (D4); the deletion of the unlisted ones by the owner's
      // collections and, for each of the two it walks, twice its stored rows; any other statement not at all.
      const bound = query.startsWith("DELETE FROM collections")
        ? MAX_STORED_COLLECTIONS + 2 * 2 * MAX_STORED_ITEMS
        : /collection_items_order|INSERT INTO collection_items/.test(query)
          ? runs * 2 * MAX_STORED_ITEMS
          : 0;
      const before = few.get(query)?.rows ?? 0;
      return /collection_items|collections_account/.test(query) && rows - before > bound
        ? [`${query.slice(0, 160)}: ${before} -> ${rows}`]
        : [];
    });
    expect(grown).toEqual([]);
  });
});

// Each statement's rows in all, by its text.
function byQuery(statements: { query: string; rows: number }[]) {
  const rows = new Map<string, { rows: number; runs: number }>();
  for (const { query, rows: read } of statements) {
    const entry = rows.get(query) ?? { rows: 0, runs: 0 };
    rows.set(query, { rows: entry.rows + read, runs: entry.runs + 1 });
  }
  return rows;
}
