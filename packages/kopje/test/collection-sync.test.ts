import { describe, expect, it } from "vitest";

import {
  PART_COLLECTIONS,
  PART_FEATURED,
  PART_NETWORK,
  PART_TAGS,
  SYNC_RETRY_MS,
} from "../src/domain/remote-collections";
import { MAX_REMOTE_COLLECTIONS, MAX_REMOTE_ITEMS } from "../src/domain/remote-featured-collections";
import { webfingerUrl } from "../src/domain/remote-statuses";
import { COLLECTIONS_CAPS, FEATURED_COLLECTION_PAGES, syncCollections } from "../src/federation/collections";
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
  requestSync,
  serveAuthorization,
  serveCollections,
  storedMember,
  storedOwner,
  syncAll,
} from "./featured-collection-helpers";
import { BUILD } from "./helpers";
import { LOCAL, type RemoteWeb, type TestActor } from "./inbox-helpers";
import { accountId, AS, nextId, OTHER, type Setup, setup } from "./inbox-status-helpers";

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
