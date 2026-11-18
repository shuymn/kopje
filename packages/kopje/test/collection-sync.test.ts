import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { claimItemChecks } from "../src/domain/collection-checks";
import {
  ANSWER_POLL_MS,
  holdsLocalMember,
  localRows as localRowsOf,
  PREAPPROVED_WAIT_MS,
} from "../src/domain/feature-answers";
import { answerFeatureRequest } from "../src/domain/inbound-feature-requests";
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
import { MAX_STORED_ITEMS } from "../src/platform/stored-bounds";
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
import { measuredStatements, watchedCursor } from "./read-helpers";

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

// ---- A local member's row in a remote collection (#1589's D21 and D24, PR 6: 6-T7, 6-T8).

type Featured = { t: Setup; owner: TestActor & { featuredCollections: string }; listed: ReturnType<typeof collection> };

let featuredOwners = 0;

// A remote owner holding one collection (listed, served) that alice is featured in, accepted on its FeatureRequest:
// her row, its wait queued on the Accept.
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
  expect(row).toMatchObject({ state: ACCEPTED, check_due_at: NOW + ANSWER_POLL_MS });
  return { t, owner, listed, ownerId, row: row!.id };
}

// The deliveries of alice's answer `answer` settled (the answer's targets all expanded): given up, or delivered (a
// delivered row is deleted).
async function answerDeliveries(t: Setup, answer: string, state: "delivered" | "gave_up"): Promise<void> {
  await outbound(t, ALICE);
  await sql(
    t.store,
    state === "delivered"
      ? "DELETE FROM deliveries WHERE activity_id = CAST(? AS INTEGER)"
      : "UPDATE deliveries SET state = 'gave_up' WHERE activity_id = CAST(? AS INTEGER)",
    answer,
  );
}

// Check rounds at `now` until none is due (the remote members' checks among them).
async function waitRounds(t: Setup, now: number): Promise<void> {
  for (let round = 0; round < 32 && (await checkRound(t, now)); round++) {
    // Another is due.
  }
}

const syncsOf = (t: Setup) => sql<{ account_id: string }>(t.store, "SELECT account_id FROM collection_syncs");

describe("a local member's wait and the reads of its owner's collections", () => {
  // 6-T7. Fails if the margin starts while the answer's target is not yet expanded (a probe of deliveries alone) or its
  // delivery is active (queued behind the lane, or leased), if a due wait is claimed as a check (a token, a quota
  // claim, a fetch), if the margin's end requests no read, or if a read deletes a waiting row.
  it("polls the answer's delivery hourly, then waits four days and requests a read, with no fetch, token or quota", async () => {
    const w = await featuring();
    const [queued] = await localRows(w.t, ALICE);
    const answer = queued!.answer!;
    // Check rounds at `now` that fetch nothing.
    const quietRounds = async (now: number) => {
      const from = w.t.web.fetched.length;
      await waitRounds(w.t, now);
      expect(w.t.web.fetched.length).toBe(from);
    };
    // Its target not yet expanded (its deliveries not written).
    await outbound(w.t, ALICE);
    await sql(w.t.store, "DELETE FROM deliveries WHERE activity_id = CAST(? AS INTEGER)", answer);
    await sql(
      w.t.store,
      "INSERT INTO outbound_targets (activity_id, targets, next) VALUES (CAST(?1 AS INTEGER), ?2, 0)",
      answer,
      JSON.stringify([{ inbox: `${w.owner.uri}/inbox` }]),
    );
    let at = NOW + ANSWER_POLL_MS;
    await quietRounds(at);
    expect(await localRows(w.t, ALICE)).toMatchObject([
      { answer, check_due_at: at + ANSWER_POLL_MS, check_token: null },
    ]);
    await sql(w.t.store, "DELETE FROM outbound_targets WHERE activity_id = CAST(? AS INTEGER)", answer);
    // Then queued behind another delivery in its lane, then leased.
    for (const state of ["queued", "leased"]) {
      await sql(
        w.t.store,
        `INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, state, lease_token, next_attempt_at,
					updated_at)
				VALUES (CAST(?1 AS INTEGER), ?2, ?3, ?4, ?5, CASE WHEN ?5 = 'leased' THEN 'token' END, ?6, ?6)`,
        answer,
        ALICE,
        `${w.owner.uri}/inbox`,
        new URL(w.owner.uri).origin,
        state,
        at,
      );
      at += ANSWER_POLL_MS;
      await quietRounds(at);
      expect(await localRows(w.t, ALICE)).toMatchObject([{ answer, check_due_at: at + ANSWER_POLL_MS }]);
      await sql(w.t.store, "DELETE FROM deliveries WHERE activity_id = CAST(? AS INTEGER)", answer);
    }
    expect(await syncsOf(w.t)).toEqual([]);
    // A read while the wait is queued that does not list alice's row keeps it.
    await requestSync(w.t, w.ownerId);
    await syncAll(w.t, w.t.web.loader, at);
    expect(await localRows(w.t, ALICE)).toMatchObject([{ id: w.row, answer }]);
    // A read listing the row sets its uri; the wait stays.
    const listedItem = localItem(w.owner, ALICE_URI, `${ALICE_URI}/feature_authorizations/${w.row}`);
    w.listed.orderedItems = [listedItem];
    serveListing(w.t.web, w.owner, w.listed);
    await requestSync(w.t, w.ownerId);
    await syncAll(w.t, w.t.web.loader, at);
    expect(await localRows(w.t, ALICE)).toMatchObject([{ id: w.row, uri: listedItem.id, answer }]);
    w.listed.orderedItems = [];
    serveListing(w.t.web, w.owner, w.listed);
    // Its delivery settled (delivered): the answer no longer watched, the margin due four days on.
    at += ANSWER_POLL_MS;
    await quietRounds(at);
    expect(await localRows(w.t, ALICE)).toMatchObject([{ answer: null, check_due_at: at + PREAPPROVED_WAIT_MS }]);
    // The margin's end: one read of the owner requested, the wait ended, nothing fetched, claimed or charged.
    at += PREAPPROVED_WAIT_MS;
    await quietRounds(at);
    expect(await localRows(w.t, ALICE)).toMatchObject([
      { id: w.row, check_due_at: null, candidate_approval_uri: null, check_token: null, check_attempts: 0 },
    ]);
    expect(await syncsOf(w.t)).toEqual([{ account_id: w.ownerId }]);
    expect(await sql(w.t.store, "SELECT 1 FROM collection_check_quotas")).toEqual([]);
    // The read it requests (claimed after the wait's end), not listing the row, deletes it.
    await syncAll(w.t, w.t.web.loader, at + 60_000);
    expect(await localRows(w.t, ALICE)).toEqual([]);
  });

  it("starts the margin once the answer's delivery is given up", async () => {
    const w = await featuring();
    const [queued] = await localRows(w.t, ALICE);
    await answerDeliveries(w.t, queued!.answer!, "gave_up");
    await waitRounds(w.t, NOW + ANSWER_POLL_MS);
    expect(await localRows(w.t, ALICE)).toMatchObject([
      { answer: null, check_due_at: NOW + ANSWER_POLL_MS + PREAPPROVED_WAIT_MS },
    ]);
  });

  // 6-T7. Fails if a read deletes a row changed after its claim (its listing predates the change), or a revoked row.
  it("keeps a row changed between a read's claim and its completion, and a revoked row until the cleanup", async () => {
    const w = await featuring();
    await sql(
      w.t.store,
      "UPDATE collection_items SET check_due_at = NULL, candidate_approval_uri = NULL, answer_activity_id = NULL WHERE id = ?",
      w.row,
    );
    // The read is claimed at NOW; the row changes at NOW + 30 s, while its listing is read; it completes at NOW + 60 s.
    let clock = NOW;
    const page = `${w.owner.featuredCollections}?page=1`;
    const loader = {
      ...w.t.web.loader,
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (request.url === page) {
          await sql(
            w.t.store,
            "UPDATE collection_items SET updated_at = ? WHERE id = ?",
            new Date(NOW + 30_000).toISOString(),
            w.row,
          );
          clock = NOW + 60_000;
        }
        return w.t.web.fetch(request);
      },
    };
    await requestSync(w.t, w.ownerId);
    const deps = { ...inboxDeps(() => w.t.store, loader), now: () => clock };
    for (let round = 0; round < 8 && (await syncCollections(w.t.env, deps)); round++) {
      // Another sync waits.
    }
    expect(await localRows(w.t, ALICE)).toMatchObject([{ id: w.row }]);
    // A later read, claimed after the change, deletes it.
    await requestSync(w.t, w.ownerId);
    await syncAll(w.t, w.t.web.loader, NOW + 120_000);
    expect(await localRows(w.t, ALICE)).toEqual([]);

    // A revoked row is kept by every read until the cleanup.
    const v = await featuring();
    await sql(
      v.t.store,
      "UPDATE collection_items SET state = 3, check_due_at = NULL, candidate_approval_uri = NULL, answer_activity_id = NULL, updated_at = ? WHERE id = ?",
      new Date(NOW - 60_000).toISOString(),
      v.row,
    );
    await requestSync(v.t, v.ownerId);
    await syncAll(v.t);
    expect(await localRows(v.t, ALICE)).toMatchObject([{ id: v.row, state: 3 }]);
  });

  // D21 through an owner's Add or Update of the whole collection (inbox.ts addFeatured and updateCollection apply the
  // read's rule, the activity's own time as its claim's). Fails if either deletes a local member's row it leaves out
  // while the row's wait is queued, while it is revoked, or when it changed at the activity's time; the row that is none
  // of these is deleted, so it is the rule that keeps the others.
  for (const kind of ["Add", "Update"] as const) {
    it(`keeps a row an owner's ${kind} of the collection leaves out while it waits, is revoked or changed then`, async () => {
      const ended = ", check_due_at = NULL, candidate_approval_uri = NULL, answer_activity_id = NULL";
      const cases: [string, string, number][] = [
        ["waiting", "", NOW - 60_000],
        ["revoked", `${ended}, state = 3`, NOW - 60_000],
        ["changed at the activity's time", ended, NOW],
        ["none of these", ended, NOW - 60_000],
      ];
      const kept: Record<string, boolean> = {};
      for (const [name, set, changed] of cases) {
        const w = await featuring();
        await sql(
          w.t.store,
          `UPDATE collection_items SET updated_at = ?${set} WHERE id = ?`,
          new Date(changed).toISOString(),
          w.row,
        );
        // The collection as the owner sends it, without alice's item.
        const object = { ...w.listed, name: "renamed" };
        const actor = w.owner.uri;
        const body =
          kind === "Add"
            ? { "@context": AS, type: "Add", actor, target: w.owner.featuredCollections, object }
            : { "@context": AS, id: `${actor}#updates/${nextId()}`, type: "Update", actor, object };
        expect(await w.t.post(w.owner, body)).toBe(202);
        expect(await sql(w.t.store, "SELECT name FROM collections WHERE uri = ?", w.listed.id)).toEqual([
          { name: "renamed" },
        ]);
        kept[name] = (await localRows(w.t, ALICE)).some((row) => row.id === w.row);
      }
      expect(kept).toEqual({
        waiting: true,
        revoked: true,
        "changed at the activity's time": true,
        "none of these": false,
      });
    });
  }

  // 6-T8. Fails if the read applies the first 25 listed items regardless of local rows (the trigger refuses the 25th
  // and the part never completes) or if the request's row meets the trigger.
  it("applies a listing into the slots local members' rows leave, and gives a request a slot", async () => {
    const w = await featuring();
    const members = await seededMembers(w.t, MAX_REMOTE_ITEMS, "s");
    w.listed.orderedItems = members.map((member) => item(w.owner, member));
    // Their servers serve each authorization, so their checks accept them (live items).
    for (const entry of w.listed.orderedItems as ReturnType<typeof item>[]) {
      serveAuthorization(w.t.web, entry, w.listed.id);
    }
    serveListing(w.t.web, w.owner, w.listed);
    await requestSync(w.t, w.ownerId);
    await syncAll(w.t);
    let stored = await items(w.t, w.listed.id);
    expect(stored.filter((row) => row.account_id === ALICE)).toHaveLength(1);
    expect(stored.filter((row) => row.account_id !== ALICE).map((row) => row.object_uri)).toEqual(
      members.slice(0, MAX_REMOTE_ITEMS - 1).map((member) => member.uri),
    );
    // The wait's end: the read it requests deletes alice's row and stores all 25.
    const [queued] = await localRows(w.t, ALICE);
    await answerDeliveries(w.t, queued!.answer!, "delivered");
    await waitRounds(w.t, NOW + ANSWER_POLL_MS);
    const end = NOW + ANSWER_POLL_MS + PREAPPROVED_WAIT_MS;
    await waitRounds(w.t, end);
    await syncAll(w.t, w.t.web.loader, end + 60_000);
    stored = await items(w.t, w.listed.id);
    expect(stored.map((row) => row.object_uri)).toEqual(members.map((member) => member.uri));

    // A request while the collection holds 25 remote members' items: the last-positioned one deleted, alice's row
    // stored and accepted.
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

  it("refuses a request when local members' rows hold every live slot", async () => {
    const w = await featuring();
    const collectionId = (
      await sql<{ id: string }>(w.t.store, "SELECT id FROM collections WHERE uri = ?", w.listed.id)
    )[0]!.id;
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
  });
});

// RES-7 for a local member's rows (design §5.1's row for PR 6, §5.2's delivery probe): each statement PR 6 adds walks
// one collection's rows (collection_items_order, at most MAX_STORED_ITEMS by the trigger) or one answer's targets and
// deliveries (outbound_targets_activity, deliveries_activity), or reads one row by a unique key. Statistics are taken
// (ANALYZE) on a small world; the grown world then fills two of the owner's collections to their stored cap, the one
// with every live slot taken (25 live remote members, 25 retired rows: takeSlot frees a live slot) and the other with
// one live slot free (24 and 26: takeSlot frees a stored row), and grows every other key past it: the owner's 8 other
// collections and another owner's 10 at their caps, and 2,000 deliveries and 200 unexpanded targets of other
// activities. Each PR 6 statement's rows grow by at most its key's bound, and each delivery probe reads at most four.
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
      // No other item's check is due, so the round reads the wait.
      await sql(t.store, "UPDATE collection_items SET check_due_at = NULL, candidate_approval_uri = NULL");
      // Other activities' unexpanded targets and active deliveries, in the owner's lane and others.
      await sql(
        t.store,
        `WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < 200)
				INSERT INTO outbound_activities (account_id, body, object_uri, retracts, created_at)
				SELECT ?1, '{"activity":{"type":"Like"},"audience":{"followers":false,"accounts":[]}}', 'filler ' || i, 0, ?2
				FROM k`,
        ALICE,
        NOW,
      );
      await sql(
        t.store,
        `INSERT INTO outbound_targets (activity_id, targets)
				SELECT id, '[]' FROM outbound_activities WHERE object_uri LIKE 'filler %'`,
      );
      await sql(
        t.store,
        `WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < 2000)
				INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, state, next_attempt_at, updated_at)
				SELECT (SELECT min(id) FROM outbound_activities WHERE object_uri LIKE 'filler %') + i % 200, ?1,
					CASE WHEN i % 4 = 0 THEN ?2 ELSE 'https://filler.example/inbox' END,
					CASE WHEN i % 4 = 0 THEN ?3 ELSE 'https://filler.example' END, 'queued', ?4, ?4
				FROM k`,
        ALICE,
        `${owner.uri}/inbox`,
        new URL(owner.uri).origin,
        NOW,
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

  // What each statement of `run` read in the small and the grown world, by its text.
  async function compare(run: (w: Awaited<ReturnType<typeof readsWorld>>) => Promise<Measured[]>) {
    const few = await run(await readsWorld(false));
    const many = await run(await readsWorld(true));
    return { few, many };
  }

  it("answers a request, waits and reads within one collection's stored rows and one answer's deliveries", async () => {
    const answered = await compare(async (w) => {
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
      const waited = await measuredStatements(
        { store: w.t.store },
        claimItemChecks,
        { now: NOW + ANSWER_POLL_MS },
        true,
      );
      expect(waited.output.checks).toEqual([]);
      const listing = await measuredDomain(w.t, (db) => [
        localRowsOf(db, collectionId, NOW),
        holdsLocalMember(db, collectionId),
      ]);
      expect(listing.output[0]).toHaveLength(1);
      return [...answer.statements, ...waited.statements, ...listing.statements];
    });
    // Each statement's rows in all, by its text; one only the grown world runs (the slot taken at the cap) from none.
    const byQuery = (statements: Measured[]) => {
      const rows = new Map<string, { rows: number; runs: number }>();
      for (const { query, rows: read } of statements) {
        const entry = rows.get(query) ?? { rows: 0, runs: 0 };
        rows.set(query, { rows: entry.rows + read, runs: entry.runs + 1 });
      }
      return rows;
    };
    const probed = (query: string) => query.includes("outbound_targets_activity");
    const few = byQuery(answered.few);
    const many = byQuery(answered.many);
    // Both of takeSlot's deletes ran in the grown world.
    expect(
      ["ORDER BY i.position DESC, i.id DESC LIMIT 1", "ORDER BY updated_at, id LIMIT 1"].map((tail) =>
        [...many.keys()].some((query) => query.startsWith("DELETE FROM collection_items") && query.includes(tail)),
      ),
    ).toEqual([true, true]);
    const grown = [...many].flatMap(([query, { rows, runs }]) => {
      // A walk of the owner's collection grows by at most its stored rows, twice where it joins their members, and a
      // new row by its two triggers' counts of the collection (§5.2, D4); any other statement not at all.
      const bound = /collection_items_order|INSERT INTO collection_items/.test(query) ? runs * 2 * MAX_STORED_ITEMS : 0;
      const before = few.get(query)?.rows ?? 0;
      return /collection_items|deliveries_activity/.test(query) && !probed(query) && rows - before > bound
        ? [`${query.slice(0, 160)}: ${before} -> ${rows}`]
        : [];
    });
    expect(grown).toEqual([]);
    // Each wait's delivery probe reads at most its answer's target, its delivery (twice: active, then as the row its lane
    // is read from) and the first older active delivery of that lane, whatever the other activities hold (the grown
    // world's lane of the owner is at its cap, so its answers are refused there): whether the answer is expanded yet
    // depends on their backlog, not on its rows.
    const probes = (statements: Measured[]) => statements.filter(({ query }) => probed(query)).map(({ rows }) => rows);
    expect([probes(answered.few).length, probes(answered.many).length]).toEqual([2, 2]);
    expect(Math.max(...probes(answered.few), ...probes(answered.many))).toBeLessThanOrEqual(4);
  });
});
