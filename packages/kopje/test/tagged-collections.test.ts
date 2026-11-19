import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { writeTaggedCollections } from "../src/domain/collections";
import { deleteStatusBatch, PURGE_BATCH, purgeBatch } from "../src/domain/inbox";
import { MAX_PUSH_BACKLOG } from "../src/domain/notifications";
import { ALL_PARTS, completeCollectionRead } from "../src/domain/remote-collections";
import { removeFeaturedCollection } from "../src/domain/remote-featured-collections";
import { startRemoval } from "../src/domain/remote-removal";
import { postStatus, publishScheduled } from "../src/domain/scheduled-statuses";
import type { StoreStub } from "../src/platform/store-client";
import { MAX_TAG_LINK_CANDIDATES, MAX_TAGGING_STATUSES } from "../src/platform/stored-bounds";
import { sha256Hex } from "../src/security/tokens";
import { type ApiHarness, bearer, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { BUILD } from "./helpers";
import { MASTODON, mastodonActor } from "./inbox-helpers";
import {
  ALICE,
  create,
  DAVE,
  followed,
  localStatus,
  mastodonNote,
  type Note,
  setup,
  type Setup,
  update,
} from "./inbox-status-helpers";
import { measuredStatements, type PlannedStatement, plannedSql, staleStatistics } from "./read-helpers";
import { community, remoteAccount, seedStatus } from "./status-helpers";

// The collections a status tags (#1589's D26, src/domain/collections.ts, migration 0120_tagged_collections): a local
// post's links and a remote Note's FeaturedCollection tags, resolved without a fetch to collections Kopje stores, at
// most MAX_TAGGED_COLLECTIONS a status and MAX_TAGGING_STATUSES a collection (design §6, PR 7). Each status's author is
// another account than the collection's owner unless a case says otherwise.

const T = "2026-11-19T00:00:00.000Z";
const LOCAL = "https://kopje.test";

const collectionId = (n: number) => String(500000000000000000n + BigInt(n));
const accountId = (n: number) => String(700000000000000000n + BigInt(n));

// A local collection of `owner` (alice or dave).
async function localCollection(t: Setup, owner: string, n: number): Promise<string> {
  await sql(
    t.store,
    `INSERT INTO collections (id, account_id, local, name, sensitive, discoverable, created_at, updated_at)
		VALUES (?, ?, 1, ?, 0, 1, ?, ?)`,
    collectionId(n),
    owner,
    `local ${n}`,
    T,
    T,
  );
  return collectionId(n);
}

// A remote account with the actor id `uri`, written directly (an owner Kopje stores, never fetched here).
async function remoteOwner(t: Setup, n: number, uri: string): Promise<string> {
  const url = new URL(uri);
  await sql(
    t.store,
    "INSERT INTO accounts (id, uri, username, domain) VALUES (?, ?, ?, ?)",
    accountId(n),
    uri,
    `o${n}`,
    url.hostname,
  );
  return accountId(n);
}

// A remote collection of `owner` stored under `uri`, with the web address `url` (none when null), as a sync stores one
// or, for rows no writer would store, as a restored dump holds them.
async function remoteCollection(t: Setup, owner: string, n: number, uri: string, url: string | null = null) {
  await sql(
    t.store,
    `INSERT INTO collections (id, account_id, local, name, sensitive, discoverable, uri, url, total_items, created_at,
			updated_at)
		VALUES (?, ?, 0, ?, 0, 1, ?, ?, 0, ?, ?)`,
    collectionId(n),
    owner,
    `remote ${n}`,
    uri,
    url,
    T,
    T,
  );
  return collectionId(n);
}

// The collections the status `id` references, by id.
async function tagged(t: Setup, id: string): Promise<string[]> {
  return (
    await sql<{ c: string }>(
      t.store,
      "SELECT collection_id AS c FROM status_collections WHERE status_id = ? ORDER BY collection_id",
      id,
    )
  ).map((row) => row.c);
}

const count = async (t: Setup, table: string) =>
  (await sql<{ n: number }>(t.store, `SELECT count(*) AS n FROM ${table}`))[0]!.n;

// A local post by dave linking `links`, one a line: its status id.
async function posted(t: Setup, ...links: string[]): Promise<string> {
  return (await localStatus(t, { status: links.join("\n") }, "dave")).id;
}

async function edited(t: Setup, id: string, ...links: string[]): Promise<void> {
  const response = await t.request(`/api/v1/statuses/${id}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${t.tokens.dave}`, "content-type": "application/json" },
    body: JSON.stringify({ status: ["edited", ...links].join("\n") }),
  });
  expect(response.status).toBe(200);
}

// `n` statuses of `author` written directly, each referencing the collection `id` (from the `from`th filler status).
async function filled(t: Setup, id: string, author: string, n: number, from = 1): Promise<void> {
  await sql(
    t.store,
    `WITH RECURSIVE n(i) AS (SELECT ?3 UNION ALL SELECT i + 1 FROM n WHERE i < ?3 + ?4 - 1)
		INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
		SELECT printf('9%017d', i), 'https://kopje.test/ap/o/fill-' || i, ?1, 'public', '', ?2 FROM n`,
    author,
    T,
    from,
    n,
  );
  await sql(
    t.store,
    `INSERT INTO status_collections (status_id, collection_id)
		SELECT id, ?1 FROM statuses WHERE id GLOB '9*' AND CAST(substr(id, 2) AS INTEGER) BETWEEN ?2 AND ?2 + ?3 - 1`,
    id,
    from,
    n,
  );
}

describe("a local post's links (7-T1)", () => {
  it("references a local collection by its url, and by its uri with its owner's username only", async () => {
    const t = await setup();
    const L = await localCollection(t, ALICE, 1);
    const owner = await remoteOwner(t, 1, `${MASTODON}/users/bob`);
    const R = await remoteCollection(t, owner, 2, `${MASTODON}/users/bob/collections/2`);
    expect(await tagged(t, await posted(t, `${LOCAL}/collections/${L}`))).toEqual([L]);
    expect(await tagged(t, await posted(t, `${LOCAL}/ap/users/alice/collections/${L}`))).toEqual([L]);
    // Another username, a stored remote collection's id under the local route, and an unknown id: none.
    expect(await tagged(t, await posted(t, `${LOCAL}/ap/users/dave/collections/${L}`))).toEqual([]);
    expect(await tagged(t, await posted(t, `${LOCAL}/collections/${R}`))).toEqual([]);
    expect(await tagged(t, await posted(t, `${LOCAL}/collections/${collectionId(99)}`))).toEqual([]);
  });

  it("stores none for a scheduled status until its publication, which references what it links", async () => {
    const t = await setup();
    const L = await localCollection(t, ALICE, 1);
    const response = await t.request("/api/v1/statuses", {
      method: "POST",
      headers: { authorization: `Bearer ${t.tokens.dave}`, "content-type": "application/json" },
      body: JSON.stringify({
        status: `${LOCAL}/collections/${L}`,
        scheduled_at: new Date(NOW + 60 * 60 * 1000).toISOString(),
      }),
    });
    expect(response.status).toBe(200);
    const { id } = await response.json<{ id: string }>();
    expect(await count(t, "status_collections")).toBe(0);
    const published = await runInDurableObject(t.store, (_instance, state) =>
      publishScheduled.run(state.storage.sql, { id, now: NOW + 2 * 60 * 60 * 1000, objectId: crypto.randomUUID() }),
    );
    expect(published).toMatchObject({ status: "published" });
    const [row] = await sql<{ status_id: string; collection_id: string }>(t.store, "SELECT * FROM status_collections");
    expect(row?.collection_id).toBe(L);
  });

  it("replaces the set on an edit, keeping a link to a collection that filled up since", async () => {
    const t = await setup();
    const [A, B] = [await localCollection(t, ALICE, 1), await localCollection(t, ALICE, 2)];
    const id = await posted(t, `${LOCAL}/collections/${A}`);
    expect(await tagged(t, id)).toEqual([A]);
    await edited(t, id);
    expect(await tagged(t, id)).toEqual([]);
    await edited(t, id, `${LOCAL}/collections/${A}`);
    expect(await tagged(t, id)).toEqual([A]);
    // A fills to MAX_TAGGING_STATUSES with this post among them: an edit keeping its link keeps the reference.
    await filled(t, A, DAVE, MAX_TAGGING_STATUSES - 1);
    await edited(t, id, `${LOCAL}/collections/${A}`, `${LOCAL}/collections/${B}`);
    expect(await tagged(t, id)).toEqual([A, B]);
    expect(await count(t, "status_collections")).toBe(MAX_TAGGING_STATUSES + 1);
  });
});

// The post operation as POST /api/v1/statuses runs it, for dave, with each statement measured.
async function measuredPost(t: Setup, text: string) {
  const credential = { tokenHash: await sha256Hex(t.tokens.dave), scope: "write:statuses", now: NOW } as never;
  return measuredStatements(
    t,
    postStatus,
    {
      credential,
      text,
      spoilerText: "",
      mediaIds: [],
      objectId: crypto.randomUUID(),
      now: NOW,
      present: { origin: LOCAL },
    },
    true,
  );
}

describe("a post's slots (7-T2)", () => {
  it("gives its four slots to the first four distinct collections its links name, in link order", async () => {
    const t = await setup();
    const [A, B, C, D, E] = await Promise.all([1, 2, 3, 4, 5].map((n) => localCollection(t, ALICE, n)));
    const url = (id: string) => `${LOCAL}/collections/${id}`;
    expect(await tagged(t, await posted(t, url(A!), url(B!), url(C!), url(D!), url(E!)))).toEqual([A, B, C, D]);
    // A's url and uri name one collection, which takes one slot.
    const both = await posted(t, url(A!), `${LOCAL}/ap/users/alice/collections/${A}`, url(B!), url(C!), url(D!));
    expect(await tagged(t, both)).toEqual([A, B, C, D]);
  });

  it("keeps a full collection's slot unwritten, counting each slot's collection once", async () => {
    const t = await setup();
    const [A, B, C, D, F] = await Promise.all([1, 2, 3, 4, 6].map((n) => localCollection(t, ALICE, n)));
    await filled(t, F!, ALICE, MAX_TAGGING_STATUSES);
    const url = (id: string) => `${LOCAL}/collections/${id}`;
    const { output, statements } = await measuredPost(t, [F, A, B, C, D].map((id) => url(id!)).join("\n"));
    expect(output).toMatchObject({ status: "ok" });
    expect(output).toMatchObject({ value: { status: "ok" } });
    const id = (output as { value: { value: { id: string } } }).value.value.id;
    expect(await tagged(t, id)).toEqual([A, B, C]);
    expect(statements.filter((s) => s.query.includes("status_collections_collection"))).toHaveLength(4);
  });

  it("fetches nothing for a link to a collection Kopje does not store, and stores none", async () => {
    const t = await setup();
    const link = "https://unknown.example/collections/1";
    const before = t.web.fetched.length;
    expect(await tagged(t, await posted(t, link, `${link}/again`))).toEqual([]);
    expect(t.web.fetched.slice(before)).toEqual([]);
    expect(await count(t, "collections")).toBe(0);
  });

  it("references the first MAX_TAGGING_STATUSES posts to tag a collection, and stores the next untagged", async () => {
    const t = await setup();
    const A = await localCollection(t, ALICE, 1);
    await filled(t, A, ALICE, MAX_TAGGING_STATUSES - 1);
    const hundredth = await posted(t, `${LOCAL}/collections/${A}`);
    const next = await posted(t, `${LOCAL}/collections/${A}`);
    expect(await tagged(t, hundredth)).toEqual([A]);
    expect(await tagged(t, next)).toEqual([]);
    expect(await sql(t.store, "SELECT count(*) AS n FROM statuses WHERE id IN (?, ?)", hundredth, next)).toEqual([
      { n: 2 },
    ]);
  });
});

describe("a link to a remote collection's web page (7-T3, c2a)", () => {
  const M = "https://m.example";

  it("references the one valid collection whose url is the link and whose id and owner are on its origin", async () => {
    const t = await setup();
    const x = await remoteOwner(t, 1, `${M}/users/x`);
    const C1 = await remoteCollection(t, x, 1, `${M}/users/x/collections/1`, `${M}/collections/1`);
    expect(await tagged(t, await posted(t, `${M}/collections/1`))).toEqual([C1]);
    expect(await tagged(t, await posted(t, `${M}/collections/1#items`))).toEqual([C1]);
    // The link is normalized (host case, the default port) before the lookup.
    expect(await tagged(t, await posted(t, "https://M.EXAMPLE:443/collections/1"))).toEqual([C1]);
    // A second collection of the origin giving the same url: neither.
    await remoteCollection(t, x, 2, `${M}/users/x/collections/2`, `${M}/collections/1`);
    expect(await tagged(t, await posted(t, `${M}/collections/1`))).toEqual([]);
  });

  it("matches no collection whose id is on another origin, a longer host or another port", async () => {
    const t = await setup();
    const elsewhere = await remoteOwner(t, 1, "https://other.example/users/y");
    const longer = await remoteOwner(t, 2, `${M}.org/users/y`);
    const ported = await remoteOwner(t, 3, `${M}:8443/users/y`);
    const x = await remoteOwner(t, 4, `${M}/users/x`);
    await remoteCollection(t, elsewhere, 1, "https://other.example/users/y/collections/1", `${M}/collections/3`);
    await remoteCollection(t, longer, 2, `${M}.org/users/y/collections/2`, `${M}/collections/3`);
    await remoteCollection(t, ported, 3, `${M}:8443/users/y/collections/3`, `${M}/collections/3`);
    expect(await tagged(t, await posted(t, `${M}/collections/3`))).toEqual([]);
    const C4 = await remoteCollection(t, x, 4, `${M}/users/x/collections/4`, `${M}/collections/3`);
    expect(await tagged(t, await posted(t, `${M}/collections/3`))).toEqual([C4]);
  });

  it("matches the stored spellings only", async () => {
    const t = await setup();
    const x = await remoteOwner(t, 1, `${M}/users/x`);
    await remoteCollection(t, x, 1, `${M}/users/x/collections/1`, "https://M.EXAMPLE:443/collections/1");
    await remoteCollection(t, x, 2, "https://M.EXAMPLE:443/users/x/collections/2", `${M}/collections/2`);
    expect(await tagged(t, await posted(t, `${M}/collections/1`, `${M}/collections/2`))).toEqual([]);
  });

  it("rechecks the owner of a row no writer would store, which then takes one of the two rows read", async () => {
    const t = await setup();
    const z = await remoteOwner(t, 1, `${M}.org/users/z`);
    await remoteCollection(t, z, 1, `${M}/users/z/collections/1`, `${M}/collections/1`);
    expect(await tagged(t, await posted(t, `${M}/collections/1`))).toEqual([]);
    const x = await remoteOwner(t, 2, `${M}/users/x`);
    await remoteCollection(t, x, 2, `${M}/users/x/collections/2`, `${M}/collections/1`);
    expect(await tagged(t, await posted(t, `${M}/collections/1`))).toEqual([]);
  });

  // The lookup reads at most 2 entries of collections_url however many rows share the url and range, under
  // statistics taken over 3 of them: the 1,000 added (rows a restored dump may hold, their owners on another origin)
  // sort first, so a walk that tested owners before its LIMIT would read them all; the answer is none either way.
  it("reads two rows of one url under statistics taken before it grew", async () => {
    const t = await setup();
    const add = (from: number, n: number, owner: string, path: string) =>
      sql(
        t.store,
        `WITH RECURSIVE n(i) AS (SELECT ?1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 + ?2 - 1)
				INSERT INTO collections (id, account_id, local, name, sensitive, discoverable, uri, url, total_items,
					created_at, updated_at)
				SELECT printf('5%017d', i), printf(?3, 1 + i / 50), 0, 'c', 0, 1, 'https://m.example/' || ?4 || i,
					'https://m.example/collections/1', 0, ?5, ?5 FROM n`,
        from,
        n,
        owner,
        path,
        T,
      );
    await sql(
      t.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 30)
			INSERT INTO accounts (id, uri, username, domain)
			SELECT printf('7%017d', i), 'https://m.example/users/w' || i, 'w' || i, 'm.example' FROM n
			UNION ALL SELECT printf('8%017d', i), 'https://m.example.org/users/v' || i, 'v' || i, 'm.example.org' FROM n`,
    );
    await add(0, 3, "7%017d", "users/w/collections/");
    await sql(t.store, "ANALYZE");
    const rows = async () => {
      const { output, statements } = await measuredPost(t, `${M}/collections/1`);
      expect(output).toMatchObject({ status: "ok", value: { status: "ok" } });
      const id = (output as { value: { value: { id: string } } }).value.value.id;
      expect(await tagged(t, id)).toEqual([]);
      const lookups = statements.filter((s) => s.query.includes("collections_url"));
      expect(lookups).toHaveLength(1);
      return lookups[0]!.rows;
    };
    const few = await rows();
    await add(100, 1000, "8%017d", "a/collections/");
    expect(await rows()).toBe(few);
  });
});

// A Mastodon 4.7.5 FeaturedCollection as note_serializer.rb embeds it in a Note's tag
// (featured_collection_serializer.rb).
function embedded(id: string, owner: string, items: { member: string; authorization: string }[] = []) {
  return {
    type: "FeaturedCollection",
    id,
    name: "embedded",
    attributedTo: owner,
    summary: "",
    sensitive: false,
    discoverable: true,
    totalItems: items.length,
    orderedItems: items.map((item, i) => ({
      type: "FeaturedItem",
      id: `${id}/items/${i}`,
      featuredObject: item.member,
      featuredObjectType: "Person",
      featureAuthorization: item.authorization,
    })),
  };
}

describe("a remote Note's tags (7-T4)", () => {
  async function world() {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const bobId = await followed(t, bob);
    const carol = await remoteOwner(t, 1, `${MASTODON}/users/carol`);
    const M = await remoteCollection(t, carol, 1, `${MASTODON}/users/carol/collections/1`);
    const L = await localCollection(t, ALICE, 2);
    return { t, bob, bobId, carol, M, L, uriOf: { M: `${MASTODON}/users/carol/collections/1` } };
  }
  const localUri = (id: string) => `${LOCAL}/ap/users/alice/collections/${id}`;
  const statusId = async (t: Setup, note: Note) =>
    (await sql<{ id: string }>(t.store, "SELECT id FROM statuses WHERE uri = ?", note.id))[0]!.id;
  const tags = (...ids: string[]) => ({ tag: ids.map((id) => ({ type: "FeaturedCollection", id })) });

  it("references the collections Kopje stores, and fetches and writes nothing from a tag", async () => {
    const { t, bob, M, L, uriOf } = await world();
    const member = await remoteOwner(t, 2, `${MASTODON}/users/member`);
    expect(member).toBeDefined();
    const own = `${bob.uri}/collections/9`;
    const authorization = `${MASTODON}/users/member/feature_authorizations/1`;
    const note = mastodonNote(bob, {
      tag: [
        embedded(uriOf.M, `${MASTODON}/users/carol`),
        embedded(localUri(L), `${LOCAL}/ap/users/alice`),
        embedded("https://third.example/users/t/collections/3", "https://third.example/users/t"),
        embedded(own, bob.uri, [{ member: `${MASTODON}/users/member`, authorization }]),
      ],
    });
    const before = {
      fetched: t.web.fetched.length,
      collections: await count(t, "collections"),
      notifications: await count(t, "notifications"),
    };
    expect(await t.post(bob, create(bob, note))).toBe(202);
    expect(await tagged(t, await statusId(t, note))).toEqual([M, L].toSorted());
    const fetched = t.web.fetched.slice(before.fetched);
    for (const url of [uriOf.M, localUri(L), "https://third.example/users/t/collections/3", own, authorization]) {
      expect(fetched).not.toContain(url);
    }
    expect(await count(t, "collections")).toBe(before.collections);
    expect(await count(t, "collection_items")).toBe(0);
    expect(await count(t, "notifications")).toBe(before.notifications);
  });

  it("reads the first MAX_TAG_LINK_CANDIDATES distinct tag ids", async () => {
    const { t, bob, uriOf } = await world();
    const unknown = Array.from({ length: MAX_TAG_LINK_CANDIDATES }, (_, i) => `${MASTODON}/users/x/collections/${i}`);
    const note = mastodonNote(bob, tags(...unknown, uriOf.M));
    expect(await t.post(bob, create(bob, note))).toBe(202);
    expect(await tagged(t, await statusId(t, note))).toEqual([]);
  });

  it("replaces the set only with a version newer than the watermark", async () => {
    const { t, bob, M, L, uriOf } = await world();
    const note = mastodonNote(bob, tags(uriOf.M));
    expect(await t.post(bob, create(bob, note))).toBe(202);
    const id = await statusId(t, note);
    expect(await tagged(t, id)).toEqual([M]);
    // A second Create under an activity id of its own.
    const again = { ...create(bob, { ...note, ...tags(localUri(L)) }), id: `${note.id}/activity-again` };
    expect(await t.post(bob, again)).toBe(202);
    expect(await tagged(t, id)).toEqual([M]);
    // An Update at the stored version, and one older.
    const published = Date.parse(note.published as string);
    const at = (ms: number, extra: Record<string, unknown>, suffix: string) => {
      const activity = update(bob, { ...note, ...extra }, new Date(ms).toISOString());
      return { ...activity, id: `${activity.id}/${suffix}` };
    };
    expect(await t.post(bob, at(published, tags(localUri(L)), "same"))).toBe(202);
    expect(await t.post(bob, at(published - 60_000, tags(localUri(L)), "stale"))).toBe(202);
    expect(await tagged(t, id)).toEqual([M]);
    // A newer Update changing only its tags: the set, no history entry, the version moved.
    const v2 = published + 60 * 60 * 1000;
    expect(await t.post(bob, at(v2, tags(localUri(L)), "v2"))).toBe(202);
    expect(await tagged(t, id)).toEqual([L]);
    expect(await count(t, "status_edits")).toBe(0);
    expect(await sql(t.store, "SELECT remote_version FROM statuses WHERE id = ?", id)).toEqual([
      { remote_version: new Date(v2).toISOString() },
    ]);
    // A replayed v2 naming other collections, and a v1.5: v2's set stays (the watermark, docs/mastodon-deviations.md).
    expect(await t.post(bob, at(v2, tags(uriOf.M), "v2-replayed"))).toBe(202);
    expect(await t.post(bob, at(v2 - 30 * 60 * 1000, tags(uriOf.M), "v1.5"))).toBe(202);
    expect(await tagged(t, id)).toEqual([L]);
  });

  it("tags a status again after its collection is stored again only with a newer version of it", async () => {
    const { t, bob, carol, uriOf } = await world();
    const note = mastodonNote(bob, tags(uriOf.M));
    expect(await t.post(bob, create(bob, note))).toBe(202);
    const id = await statusId(t, note);
    await sql(t.store, "DELETE FROM collections WHERE uri = ?", uriOf.M);
    expect(await tagged(t, id)).toEqual([]);
    const M2 = await remoteCollection(t, carol, 3, uriOf.M);
    const search = () => t.api(`/api/v2/search?q=${encodeURIComponent(note.id)}&resolve=true&type=statuses`, "alice");
    t.web.serve(note.id, { "@context": "https://www.w3.org/ns/activitystreams", ...note });
    expect((await search()).status).toBe(200);
    expect(await tagged(t, id)).toEqual([]);
    const updated = new Date(Date.parse(note.published as string) + 60 * 60 * 1000).toISOString();
    t.web.serve(note.id, { "@context": "https://www.w3.org/ns/activitystreams", ...note, updated });
    expect((await search()).status).toBe(200);
    expect(await tagged(t, id)).toEqual([M2]);
  });
});

// ---- Deletion (7-T6, 7-T7): every path deleting a status or a collection deletes its references within its budget.

// Runs `batch` (one purge or removal batch in a transaction) until it reports no more work, each batch's rows changed
// (total_changes()) recorded; at most `max` batches.
async function batches(
  store: StoreStub,
  batch: (db: Db) => boolean,
  max = 40,
): Promise<{ wrote: number[]; ended: boolean }> {
  const wrote: number[] = [];
  for (let i = 0; i < max; i++) {
    const { rows, more } = await runInDurableObject(store, (_instance, state) => {
      const db = new Db(state.storage.sql);
      const changes = () => db.first<{ n: number }>("SELECT total_changes() AS n")!.n;
      const before = changes();
      const more = state.storage.transactionSync(() => batch(db));
      return { rows: changes() - before, more };
    });
    wrote.push(rows);
    if (!more) {
      return { wrote, ended: true };
    }
  }
  return { wrote, ended: false };
}

// `n` remote accounts on many.example (`prefix` and 17 digits), and as many mentions of the status `status`: a batch's
// filler, deleted one row each before the status's references.
async function mentioned(store: StoreStub, status: string, n: number, prefix = "6"): Promise<void> {
  await sql(
    store,
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
		INSERT INTO accounts (id, uri, username, domain)
		SELECT printf(?2 || '%017d', i), 'https://many.example/users/' || ?2 || i, 'm' || ?2 || i, 'many.example' FROM n`,
    n,
    prefix,
  );
  await sql(
    store,
    "INSERT INTO status_mentions (status_id, account_id) SELECT ?, id FROM accounts WHERE id GLOB ?",
    status,
    `${prefix}*`,
  );
}

const storedCollection = (store: StoreStub, id: string, owner: string, local: number, uri: string | null) =>
  sql(
    store,
    `INSERT INTO collections (id, account_id, local, name, sensitive, discoverable, uri, created_at, updated_at)
		VALUES (?, ?, ?, 'c', 0, 1, ?, ?, ?)`,
    id,
    owner,
    local,
    uri,
    T,
    T,
  );

describe("a status's deletion (7-T6)", () => {
  // carol's reply with a poll, a trend row, a trend review and a card, her newest status, tagging 4 of alice's
  // collections; `left` rows of the batch's budget remain once its mentions are deleted.
  async function reply(left: number) {
    const h = await community(["alice"]);
    const alice = h.users.alice.id;
    const parent = await seedStatus(h.store, { accountId: alice, visibility: "public" });
    const carol = await remoteAccount(h.store, "carol");
    const status = await seedStatus(h.store, { accountId: carol, visibility: "public", inReplyToId: parent });
    await sql(h.store, `INSERT INTO polls (status_id, options, tallies) VALUES (?, '["a","b"]', '[0,0]')`, status);
    await sql(h.store, "INSERT INTO trend_statuses (status_id, account_id, score) VALUES (?, ?, 9)", status, carol);
    await sql(
      h.store,
      "INSERT INTO status_trend_reviews (status_id, trendable, reviewed_at) VALUES (?, 1, ?)",
      status,
      T,
    );
    await sql(
      h.store,
      `INSERT INTO status_cards (status_id, url, enqueued_at, generation, title, fetched_at)
			VALUES (?, 'https://a.example/', 0, 0, 't', 0)`,
      status,
    );
    for (const n of [1, 2, 3, 4]) {
      await storedCollection(h.store, collectionId(n), alice, 1, null);
      await sql(h.store, "INSERT INTO status_collections VALUES (?, ?)", status, collectionId(n));
    }
    await mentioned(h.store, status, PURGE_BATCH - left);
    return { h, status, carol: "https://remote.example/users/carol" };
  }
  const references = async (store: StoreStub) =>
    (await sql<{ n: number }>(store, "SELECT count(*) AS n FROM status_collections"))[0]!.n;

  // `batch` on a Db recording into `seen`, when the status's DELETE runs, the references it still holds, and for a
  // removal `job` the rows written from that DELETE to the job's end (its UPDATE of inbound_jobs) and by that end.
  function observed(status: string, seen: number[], batch: (db: Db) => boolean, job = false): (db: Db) => boolean {
    return (db) => {
      const run = db.run.bind(db);
      const changes = () => db.first<{ n: number }>("SELECT total_changes() AS n")!.n;
      let from: number | undefined;
      db.run = (query, ...params) => {
        if (query === "DELETE FROM statuses WHERE id = ?" && params[0] === status) {
          seen.push(
            db.first<{ n: number }>("SELECT count(*) AS n FROM status_collections WHERE status_id = ?", status)!.n,
          );
          from = changes();
        } else if (job && from !== undefined && query.includes("UPDATE inbound_jobs SET done_at")) {
          const at = changes();
          const n = run(query, ...params);
          seen.push(at - from, changes() - at);
          return n;
        }
        return run(query, ...params);
      };
      return batch(db);
    };
  }

  it("purges the author's status within each batch, its references before it, whatever the budget left", async () => {
    for (let left = 1; left <= 30; left++) {
      const { h, status, carol } = await reply(left);
      const seen: number[] = [];
      const { wrote, ended } = await batches(
        h.store,
        observed(status, seen, (db) => purgeBatch(db, carol, NOW)),
      );
      expect(ended, `left ${left}`).toBe(true);
      expect(
        wrote.filter((rows) => rows > PURGE_BATCH),
        `left ${left}: ${wrote.join()}`,
      ).toEqual([]);
      expect(seen, `left ${left}`).toEqual([0]);
      expect(await sql(h.store, "SELECT count(*) AS n FROM statuses WHERE id = ?", status)).toEqual([{ n: 0 }]);
      expect(await references(h.store)).toBe(0);
      expect(await sql(h.store, "SELECT count(*) AS n FROM collections")).toEqual([{ n: 4 }]);
    }
  }, 180_000);

  it("removes a remote status after its Delete within each batch, whatever the budget left", async () => {
    for (let left = 1; left <= 30; left++) {
      const { h, status, carol } = await reply(left);
      // The Delete's request: the job, and the status hidden (its card deleted, carol's newest status moved back).
      await runInDurableObject(h.store, (_instance, state) =>
        state.storage.transactionSync(() => startRemoval(new Db(state.storage.sql), status, carol, NOW)),
      );
      const seen: number[] = [];
      const { wrote, ended } = await batches(
        h.store,
        observed(status, seen, (db) => deleteStatusBatch(db, status, NOW), true),
      );
      expect(ended, `left ${left}`).toBe(true);
      expect(
        wrote.filter((rows) => rows > PURGE_BATCH),
        `left ${left}: ${wrote.join()}`,
      ).toEqual([]);
      // None left at its delete, which writes 5 (the status, its poll, trend and trend review rows, and the parent's
      // recount), then the job's end 1.
      expect(seen, `left ${left}`).toEqual([0, 5, 1]);
      expect(await references(h.store)).toBe(0);
      expect(await sql(h.store, "SELECT count(*) AS n FROM collections")).toEqual([{ n: 4 }]);
    }
  }, 180_000);
});

describe("a collection's deletion (7-T7)", () => {
  // alice's 100 statuses, each tagging alice's collection X; the owner's collection is tagged by all of them.
  async function world() {
    const h = await community(["alice"]);
    const alice = h.users.alice.id;
    await sql(
      h.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?3)
			INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
			SELECT printf('9%017d', i), 'https://kopje.test/ap/o/t' || i, ?1, 'public', '', ?2 FROM n`,
      alice,
      T,
      MAX_TAGGING_STATUSES,
    );
    await storedCollection(h.store, collectionId(0), alice, 1, null);
    await sql(h.store, "INSERT INTO status_collections SELECT id, ? FROM statuses WHERE id GLOB '9*'", collectionId(0));
    // The statuses the owners' filler notifications name, one each (notifications_natural).
    await sql(
      h.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?3)
			INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
			SELECT printf('8%017d', i), 'https://kopje.test/ap/o/f' || i, ?1, 'public', '', ?2 FROM n`,
      alice,
      T,
      PURGE_BATCH,
    );
    return { h, alice };
  }

  // The owner `k`'s collection, tagged by alice's 100 statuses, and PURGE_BATCH - left notifications from the owner,
  // which the purge deletes (its sender window) before it reaches the collection.
  async function owner(h: ApiHarness, alice: string, k: number, left: number) {
    const uri = `https://owner${k}.example/users/o`;
    const id = accountId(k);
    await sql(
      h.store,
      "INSERT INTO accounts (id, uri, username, domain) VALUES (?, ?, 'o', ?)",
      id,
      uri,
      `owner${k}.example`,
    );
    const collection = collectionId(k);
    await storedCollection(h.store, collection, id, 0, `${uri}/collections/1`);
    await sql(h.store, "INSERT INTO status_collections SELECT id, ? FROM statuses WHERE id GLOB '9*'", collection);
    await sql(
      h.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?3)
			INSERT INTO notifications (account_id, type, from_account_id, status_id, created_at)
			SELECT ?1, 'favourite', ?2, printf('8%017d', i), ?4 FROM n`,
      alice,
      id,
      PURGE_BATCH - left,
      T,
    );
    return { uri, collection };
  }

  it("purges an owner's collection within each batch, its references first, whatever the budget left", async () => {
    const { h, alice } = await world();
    for (let left = 1; left <= MAX_TAGGING_STATUSES + 1; left++) {
      const { uri, collection } = await owner(h, alice, left, left);
      const { wrote, ended } = await batches(h.store, (db) => purgeBatch(db, uri, NOW));
      expect(ended, `left ${left}: ${wrote.join()}`).toBe(true);
      expect(
        wrote.filter((rows) => rows > PURGE_BATCH || rows === 0),
        `left ${left}: ${wrote.join()}`,
      ).toEqual([]);
      expect(
        await sql(h.store, "SELECT count(*) AS n FROM status_collections WHERE collection_id = ?", collection),
      ).toEqual([{ n: 0 }]);
      // Every status stays, with its reference to X.
      expect(
        await sql(h.store, "SELECT count(*) AS n FROM status_collections WHERE collection_id = ?", collectionId(0)),
      ).toEqual([{ n: MAX_TAGGING_STATUSES }]);
    }
  }, 300_000);

  it("keeps the collections an author's purged statuses tagged, with their items", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    const carol = await remoteAccount(h.store, "carol");
    const status = await seedStatus(h.store, { accountId: carol, visibility: "public" });
    for (const n of [1, 2, 3, 4]) {
      await storedCollection(h.store, collectionId(n), alice.id, 1, null);
      await sql(
        h.store,
        `INSERT INTO collection_items (id, collection_id, account_id, state, position, created_at, updated_at)
				VALUES (?, ?, ?, 1, 1, ?, ?)`,
        String(600000000000000000n + BigInt(n)),
        collectionId(n),
        bob.id,
        T,
        T,
      );
      await sql(h.store, "INSERT INTO status_collections VALUES (?, ?)", status, collectionId(n));
    }
    const { ended } = await batches(h.store, (db) => purgeBatch(db, "https://remote.example/users/carol", NOW));
    expect(ended).toBe(true);
    expect(await sql(h.store, "SELECT count(*) AS n FROM status_collections")).toEqual([{ n: 0 }]);
    expect(await sql(h.store, "SELECT count(*) AS n FROM collections")).toEqual([{ n: 4 }]);
    expect(await sql(h.store, "SELECT count(*) AS n FROM collection_items")).toEqual([{ n: 4 }]);
  });

  it("deletes a collection's MAX_TAGGING_STATUSES references with it on its owner's DELETE", async () => {
    const { h, alice } = await world();
    const response = await h.request(
      `/api/v1/collections/${collectionId(0)}`,
      bearer(h.users.alice.token, { method: "DELETE" }),
    );
    expect(response.status).toBe(200);
    expect(alice).toBeDefined();
    expect(await sql(h.store, "SELECT count(*) AS n FROM status_collections")).toEqual([{ n: 0 }]);
    expect(await sql(h.store, "SELECT count(*) AS n FROM statuses WHERE id GLOB '9*'")).toEqual([
      { n: MAX_TAGGING_STATUSES },
    ]);
  });

  it("keeps the reference reads' plans under statistics taken before the growth", async () => {
    // carol's collections X, tagged by 10 of alice's statuses, and Y, by carol's status S, when the statistics are
    // taken; then X by 89 more and Y by 11 more. The plans of every statement reading status_collections (the writer
    // on alice's untagged status, S's removal and carol's purge, each run and rolled back) are read before and after;
    // the plan audit reads the same statements under singleton statistics.
    const h = await community(["alice"]);
    const alice = h.users.alice.id;
    const carol = await remoteAccount(h.store, "carol");
    const [x, y] = [collectionId(1), collectionId(2)];
    await storedCollection(h.store, x, carol, 0, "https://remote.example/users/carol/collections/1");
    await storedCollection(h.store, y, carol, 0, "https://remote.example/users/carol/collections/2");
    const tagged = async (from: number, to: number, collection: string) => {
      await sql(
        h.store,
        `WITH RECURSIVE n(i) AS (SELECT ?1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
				INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
				SELECT printf('9%017d', i), 'https://kopje.test/ap/o/t' || i, ?3, 'public', '', ?4 FROM n`,
        from,
        to,
        alice,
        T,
      );
      await sql(
        h.store,
        "INSERT INTO status_collections SELECT id, ?3 FROM statuses WHERE id BETWEEN printf('9%017d', ?1) AND printf('9%017d', ?2)",
        from,
        to,
        collection,
      );
    };
    await tagged(1, 10, x);
    const s = await seedStatus(h.store, { accountId: carol, visibility: "public" });
    await sql(h.store, "INSERT INTO status_collections VALUES (?, ?)", s, y);
    const fresh = await seedStatus(h.store, { accountId: alice, visibility: "public" });
    const ROLLBACK = new Error("rolled back");
    const plans = () =>
      runInDurableObject(h.store, (_instance, state) => {
        const planned: PlannedStatement[] = [];
        const db = new Db(plannedSql(state.storage.sql, /status_collections/, planned));
        for (const run of [
          () => writeTaggedCollections(db, fresh, [x, y]),
          () => deleteStatusBatch(db, s, NOW),
          () => {
            for (let i = 0; i < 20; i++) {
              if (!purgeBatch(db, "https://remote.example/users/carol", NOW)) {
                break;
              }
            }
          },
        ]) {
          try {
            state.storage.transactionSync(() => {
              run();
              throw ROLLBACK;
            });
          } catch (error) {
            if (error !== ROLLBACK) {
              throw error;
            }
          }
        }
        // Each statement once, with its plan's reads of status_collections.
        const seen = new Map<string, string[]>();
        for (const { query, plan } of planned) {
          seen.set(
            query,
            plan.filter((detail) => detail.includes("status_collections")),
          );
        }
        return [...seen.values()];
      });
    const { before, after } = await staleStatistics(h, {
      capture: () => plans(),
      grow: async () => {
        await tagged(11, 99, x);
        await tagged(100, 110, y);
      },
    });
    const BY_STATUS = "SEARCH status_collections USING PRIMARY KEY (status_id=?)";
    const BY_COLLECTION = "USING COVERING INDEX status_collections_collection (collection_id=?)";
    expect(before).toEqual([
      // The writer's held set, and its per-collection count.
      [BY_STATUS],
      [`SEARCH status_collections ${BY_COLLECTION}`],
      // S's removal: its references (STATUS_CHILDREN), and the test that none is left.
      [
        "SEARCH status_collections USING COVERING INDEX status_collections_collection (collection_id=? AND status_id=?)",
        BY_STATUS,
      ],
      [BY_STATUS],
      // The purge's window step, its deletes by key, and the collections' NOT EXISTS.
      [`SEARCH r ${BY_COLLECTION}`],
      ["SEARCH status_collections USING PRIMARY KEY (status_id=? AND collection_id=?)"],
      [`SEARCH r ${BY_COLLECTION}`],
    ]);
    expect(after).toEqual(before);
  });
});

describe("rows no writer produces (7-T9)", () => {
  // Remote collections a restored dump may hold, which the schema admits: X's uri does not parse, Y's url does not, and
  // Z's owner is on another origin than its uri; S, a local status, references all three.
  async function restored() {
    const t = await setup();
    const M = "https://m.example";
    const x = await remoteOwner(t, 1, `${MASTODON}/users/x`);
    const z = await remoteOwner(t, 2, `${M}.org/users/z`);
    const X = await remoteCollection(t, x, 1, "https://[", null);
    const Y = await remoteCollection(t, x, 2, `${MASTODON}/users/x/collections/2`, "https://[");
    const Z = await remoteCollection(t, z, 3, `${M}/users/z/collections/3`, `${M}/collections/3`);
    const S = await posted(t, "S");
    for (const id of [X, Y, Z]) {
      await sql(t.store, "INSERT INTO status_collections VALUES (?, ?)", S, id);
    }
    return { t, X, Y, Z, S, uriOf: { Z: `${M}/users/z/collections/3` } };
  }

  it("lets a remote Note's tag reference none of them", async () => {
    const { t, uriOf } = await restored();
    const bob = await mastodonActor(t.web, "bob");
    await followed(t, bob);
    const note = mastodonNote(bob, { tag: [{ type: "FeaturedCollection", id: uriOf.Z }] });
    expect(await t.post(bob, create(bob, note))).toBe(202);
    const [row] = await sql<{ id: string }>(t.store, "SELECT id FROM statuses WHERE uri = ?", note.id);
    expect(await tagged(t, row!.id)).toEqual([]);
  });

  it("leaves no reference to a collection deleted and stored again under its id", async () => {
    const t = await setup();
    const L = await localCollection(t, ALICE, 1);
    const id = await posted(t, `${LOCAL}/collections/${L}`);
    expect(await tagged(t, id)).toEqual([L]);
    await sql(t.store, "DELETE FROM collections WHERE id = ?", L);
    await localCollection(t, ALICE, 1);
    expect(await tagged(t, id)).toEqual([]);
  });
});

// The saturated complete read of design §5.1 (7-T7): one owner's MAX_STORED_COLLECTIONS stored collections omitted,
// each with MAX_TAGGING_STATUSES references, 25 live and 25 retired items of remote members and a collection_update
// notification for each of 25 local accounts, `pushes` pushes waiting on those notifications; the read lists 10 new
// collections of 25 items each, 20 pins replacing 20 and 10 featured hashtags replacing 10. Without `references`, the
// same with none.
async function saturated(t: Setup, { references, pushes }: { references: boolean; pushes: number }) {
  const O = "https://o.example/users/o";
  const owner = await remoteOwner(t, 0, O);
  const exec = (query: string, ...params: SqlStorageValue[]) => sql(t.store, query, ...params);
  // 50 members on m.example, 25 local recipients (r…), and alice's 1,250 statuses tagging 4 collections each.
  await exec(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50)
		INSERT INTO accounts (id, uri, username, domain) SELECT printf('71%016d', i), 'https://m.example/users/m' || i,
			'm' || i, 'm.example' FROM n`,
  );
  await exec(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 25)
		INSERT INTO accounts (id, uri, username, domain) SELECT printf('72%016d', i), 'https://kopje.test/ap/users/r' || i,
			'r' || i, NULL FROM n`,
  );
  await exec(
    `INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey)
		SELECT id, username || '@x.test', X'00', X'00', 'k' FROM accounts WHERE id GLOB '72*'`,
  );
  await exec(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50)
		INSERT INTO collections (id, account_id, local, name, sensitive, discoverable, uri, total_items, created_at, updated_at)
		SELECT printf('50%016d', i), ?1, 0, 'c', 0, 1, ?2 || '/collections/' || i, 25, ?3, ?3 FROM n`,
    owner,
    O,
    T,
  );
  await exec(
    `INSERT INTO collection_items (id, collection_id, account_id, state, position, uri, created_at, updated_at)
		SELECT printf('6%03d%014d', CAST(substr(c.id, 3) AS INTEGER), CAST(substr(m.id, 3) AS INTEGER)), c.id, m.id,
			CASE WHEN CAST(substr(m.id, 3) AS INTEGER) <= 25 THEN 1 ELSE 3 END, CAST(substr(m.id, 3) AS INTEGER),
			c.uri || '/items/' || m.id, ?1, ?1
		FROM collections c CROSS JOIN accounts m WHERE c.id GLOB '50*' AND m.id GLOB '71*'`,
    T,
  );
  await exec(
    `INSERT INTO notifications (account_id, type, from_account_id, collection_id, created_at)
		SELECT r.id, 'collection_update', ?1, c.id, ?2 FROM collections c CROSS JOIN accounts r
		WHERE c.id GLOB '50*' AND r.id GLOB '72*'`,
    owner,
    T,
  );
  await exec(
    `INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes)
		VALUES ('push', 's', 'push', 'urn:ietf:wg:oauth:2.0:oob', 'read push')`,
  );
  await exec(
    `INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes)
		SELECT 'push' || id, 'access', 'push', id, 'read push' FROM accounts WHERE id GLOB '72*'`,
  );
  await exec(
    `INSERT INTO push_subscriptions (id, token_hash, endpoint, key_p256dh, key_auth)
		SELECT CAST(substr(id, 3) AS INTEGER), 'push' || id, 'https://push.example/' || id, 'k', 'a'
		FROM accounts WHERE id GLOB '72*'`,
  );
  await exec(
    `INSERT INTO push_deliveries (subscription_id, notification_id, next_attempt_at, updated_at)
		SELECT CAST(substr(account_id, 3) AS INTEGER), id, 0, 0 FROM notifications
		WHERE type = 'collection_update' ORDER BY id LIMIT ?1`,
    pushes,
  );
  if (references) {
    await exec(
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 1249)
			INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
			SELECT printf('9%017d', i), 'https://kopje.test/ap/o/s' || i, ?1, 'public', '', ?2 FROM n`,
      ALICE,
      T,
    );
    await exec(
      `WITH RECURSIVE k(j) AS (SELECT 0 UNION ALL SELECT j + 1 FROM k WHERE j < 3)
			INSERT INTO status_collections (status_id, collection_id)
			SELECT s.id, printf('50%016d', 1 + (CAST(substr(s.id, 2) AS INTEGER) * 4 + k.j) % 50)
			FROM statuses s CROSS JOIN k WHERE s.id GLOB '9*'`,
    );
  }
  // The owner's 40 statuses, 20 pinned, and 10 featured hashtags.
  await exec(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 40)
		INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
		SELECT printf('8%017d', i), ?1 || '/statuses/' || i, ?2, 'public', '', ?3 FROM n`,
    O,
    owner,
    T,
  );
  await exec(
    "INSERT INTO status_pins (account_id, status_id) SELECT ?, id FROM statuses WHERE id GLOB '8*' ORDER BY id LIMIT 20",
    owner,
  );
  await exec(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10)
		INSERT INTO featured_tags (id, account_id, name, display_name) SELECT printf('77%016d', i), ?1, 'old' || i, 'old' || i FROM n`,
    owner,
  );
  await exec("INSERT INTO collection_syncs (account_id, due_at) VALUES (?, ?)", owner, NOW);
  const sync = await t.store.claimCollectionSync(BUILD, { now: NOW });
  if (sync === null || sync === "more") {
    throw new Error("no sync claimed");
  }
  const listed = Array.from({ length: 10 }, (_, c) => {
    const id = `${O}/collections/new${c}`;
    return {
      id,
      attributedTo: O,
      name: `new ${c}`,
      summary: "",
      language: null,
      sensitive: false,
      discoverable: true,
      totalItems: 25,
      topic: null,
      url: null,
      truncated: false,
      items: Array.from({ length: 25 }, (_, m) => ({
        id: `${id}/items/${m}`,
        object: `https://m.example/users/m${m + 1}`,
        authorization: `https://m.example/users/m${m + 1}/feature_authorizations/${c}`,
        published: null,
      })),
    };
  });
  const input = {
    now: NOW,
    origin: LOCAL,
    accountUri: O,
    generation: sync.generation,
    token: sync.token,
    parts: ALL_PARTS,
    pins: { uris: Array.from({ length: 20 }, (_, i) => `${O}/statuses/${21 + i}`) },
    tags: Array.from({ length: 10 }, (_, i) => `new${i}`),
    hideCollections: false,
    counts: { statuses: null, following: null, followers: null },
    collections: { listed, complete: true },
  };
  return { owner, input };
}

const OMITTED = ["collections", "collection_items", "status_collections", "notifications", "push_deliveries"] as const;

// The rows of the omitted collections and their children, by table.
async function omittedRows(t: Setup): Promise<Record<(typeof OMITTED)[number], number>> {
  const [row] = await sql<Record<(typeof OMITTED)[number], number>>(
    t.store,
    `SELECT (SELECT count(*) FROM collections WHERE id GLOB '50*') AS collections,
			(SELECT count(*) FROM collection_items WHERE collection_id GLOB '50*') AS collection_items,
			(SELECT count(*) FROM status_collections WHERE collection_id GLOB '50*') AS status_collections,
			(SELECT count(*) FROM notifications WHERE collection_id GLOB '50*') AS notifications,
			(SELECT count(*) FROM push_deliveries d JOIN notifications n ON n.id = d.notification_id
				WHERE n.collection_id GLOB '50*') AS push_deliveries`,
  );
  return row!;
}

// The read as one completeCollectionRead call in a Store transaction: its rows changed (total_changes() on the Store's
// connection, cascades and trigger writes included) and its time.
async function completed(t: Setup, input: unknown): Promise<{ changes: number; ms: number }> {
  return runInDurableObject(t.store, (_instance, state) => {
    const sql = state.storage.sql;
    const changes = () => sql.exec<{ n: number }>("SELECT total_changes() AS n").one().n;
    const before = changes();
    const started = performance.now();
    completeCollectionRead.run(sql, input as never, (fn) => state.storage.transactionSync(fn));
    return { changes: changes() - before, ms: performance.now() - started };
  });
}

describe("a complete read at saturation (7-T7)", () => {
  it("deletes the omitted collections with their 5,000 references, within the call's bound", async () => {
    const times: { with: number[]; without: number[] } = { with: [], without: [] };
    for (let run = 0; run < 3; run++) {
      for (const references of [true, false]) {
        const t = await setup();
        const { input } = await saturated(t, { references, pushes: MAX_PUSH_BACKLOG });
        const before = await omittedRows(t);
        expect(before).toEqual({
          collections: 50,
          collection_items: 2_500,
          status_collections: references ? 5_000 : 0,
          notifications: 1_250,
          push_deliveries: 1_000,
        });
        const otherRows = await sql(
          t.store,
          `SELECT (SELECT count(*) FROM collection_items WHERE collection_id NOT GLOB '50*') AS items,
						(SELECT count(*) FROM notifications WHERE collection_id IS NULL OR collection_id NOT GLOB '50*') AS n`,
        );
        const { changes, ms } = await completed(t, input);
        expect(await omittedRows(t)).toEqual({
          collections: 0,
          collection_items: 0,
          status_collections: 0,
          notifications: 0,
          push_deliveries: 0,
        });
        // No other row of those tables went: the new collections' items were added, and nothing else of them deleted.
        expect(await sql(t.store, "SELECT count(*) AS n FROM status_collections")).toEqual([{ n: 0 }]);
        expect(
          await sql(
            t.store,
            `SELECT (SELECT count(*) FROM collection_items WHERE collection_id NOT GLOB '50*') AS items,
							(SELECT count(*) FROM notifications WHERE collection_id IS NULL OR collection_id NOT GLOB '50*') AS n`,
          ),
        ).toEqual([{ items: 250, n: (otherRows[0] as { n: number }).n }]);
        expect(await sql(t.store, "SELECT count(*) AS n FROM collections WHERE uri GLOB '*/new*'")).toEqual([
          { n: 10 },
        ]);
        // The omission (9,800 with references), and the whole call within its own bound.
        expect(Object.values(before).reduce((a, b) => a + b, 0)).toBe(references ? 9_800 : 4_800);
        expect(changes).toBeLessThanOrEqual(10_434);
        times[references ? "with" : "without"].push(ms);
        if (run === 0) {
          console.info(`complete read at saturation (references: ${references}): ${changes} rows changed`);
        }
      }
    }
    const median = (values: number[]) => values.toSorted((a, b) => a - b)[1]!;
    console.info(
      `complete read at saturation: ${median(times.with).toFixed(0)} ms with 5,000 references, ${median(times.without).toFixed(0)} ms without (median of 3, workerd)`,
    );
  }, 300_000);

  // PR 6's exemption keeps a collection holding a local member's row when a complete read omits it, with its
  // references; the owner's Remove of it deletes them with it, under the mark that admits that delete.
  it("keeps a collection holding a local member's row with its references, which its owner's Remove deletes", async () => {
    const t = await setup();
    const O = "https://o.example/users/o";
    const owner = await remoteOwner(t, 0, O);
    const C = await remoteCollection(t, owner, 1, `${O}/collections/1`);
    await sql(
      t.store,
      `INSERT INTO collection_items (id, collection_id, account_id, state, position, approval_uri, created_at, updated_at)
			VALUES ('600000000000000001', ?1, ?2, 1, 1, ?3, ?4, ?4)`,
      C,
      ALICE,
      `${LOCAL}/ap/users/alice/feature_authorizations/1`,
      T,
    );
    const S = await posted(t, "S");
    await sql(t.store, "INSERT INTO status_collections VALUES (?, ?)", S, C);
    await sql(t.store, "INSERT INTO collection_syncs (account_id, due_at) VALUES (?, ?)", owner, NOW);
    const sync = await t.store.claimCollectionSync(BUILD, { now: NOW });
    if (sync === null || sync === "more") {
      throw new Error("no sync claimed");
    }
    await completed(t, {
      now: NOW,
      origin: LOCAL,
      accountUri: O,
      generation: sync.generation,
      token: sync.token,
      parts: ALL_PARTS,
      pins: null,
      tags: null,
      hideCollections: null,
      counts: { statuses: null, following: null, followers: null },
      collections: { listed: [], complete: true },
    });
    expect(await tagged(t, S)).toEqual([C]);
    await runInDurableObject(t.store, (_instance, state) =>
      state.storage.transactionSync(() =>
        removeFeaturedCollection(new Db(state.storage.sql), owner, `${O}/collections/1`),
      ),
    );
    expect(await tagged(t, S)).toEqual([]);
    expect(await count(t, "collections")).toBe(0);
  });

  // A restored dump can hold more pushes than MAX_PUSH_BACKLOG (#1797); the references stay within the triggers' bound.
  it("deletes the 5,000 references of a restored Store's omitted collections, reporting the rest", async () => {
    const t = await setup();
    const { input } = await saturated(t, { references: true, pushes: 1_250 });
    // 2,000 pushes in all: a second subscription of each recipient for the first 750 notifications.
    await sql(
      t.store,
      `INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes)
			SELECT 'push2' || id, 'access', 'push', id, 'read push' FROM accounts WHERE id GLOB '72*'`,
    );
    await sql(
      t.store,
      `INSERT INTO push_subscriptions (id, token_hash, endpoint, key_p256dh, key_auth)
			SELECT 100 + CAST(substr(id, 3) AS INTEGER), 'push2' || id, 'https://push.example/b/' || id, 'k', 'a'
			FROM accounts WHERE id GLOB '72*'`,
    );
    await sql(
      t.store,
      `INSERT INTO push_deliveries (subscription_id, notification_id, next_attempt_at, updated_at)
			SELECT 100 + CAST(substr(account_id, 3) AS INTEGER), id, 0, 0 FROM notifications
			WHERE type = 'collection_update' ORDER BY id LIMIT 750`,
    );
    const before = await omittedRows(t);
    expect(before).toMatchObject({ status_collections: 5_000, push_deliveries: 2_000 });
    const { changes } = await completed(t, input);
    expect((await omittedRows(t)).status_collections).toBe(0);
    console.info(`restored Store's complete read: ${JSON.stringify(before)}; ${changes} rows changed (#1797)`);
  }, 120_000);
});
