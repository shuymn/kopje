import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { statusFacts } from "../src/domain/activities";
import { jsonBytes } from "../src/domain/answer-budget";
import type { VisibleStatusId } from "../src/domain/audience";
import { contextOf } from "../src/domain/auth";
import { taggedCollectionsOf } from "../src/domain/collection-presenter";
import { writeTaggedCollections } from "../src/domain/collections";
import { deleteStatusBatch, PURGE_BATCH, purgeBatch } from "../src/domain/inbox";
import { resolveInteraction } from "../src/domain/interaction";
import { MAX_PUSH_BACKLOG } from "../src/domain/notifications";
import { readOperation } from "../src/domain/operation";
import { USERNAME_LIMIT } from "../src/domain/profile-bounds";
import { ALL_PARTS, completeCollectionRead } from "../src/domain/remote-collections";
import { removeFeaturedCollection } from "../src/domain/remote-featured-collections";
import { startRemoval } from "../src/domain/remote-removal";
import { postStatus, publishScheduled } from "../src/domain/scheduled-statuses";
import { MAX_TAG_LENGTH } from "../src/domain/status-bounds";
import { presentation, type Quote, type Status, statusStream } from "../src/domain/status-presenter";
import { webInteractTarget } from "../src/domain/web-pages/interact";
import { webProfilePage } from "../src/domain/web-pages/profile";
import { embeddedStatus, webStatusPage } from "../src/domain/web-pages/status";
import { webTagPage } from "../src/domain/web-pages/tags";
import { endPolls } from "../src/jobs/scheduled";
import { utf8Length } from "../src/platform/dump-format";
import { ACTOR_URI_LIMIT } from "../src/platform/identity-bounds";
import type { StoreStub } from "../src/platform/store-client";
import {
  COLLECTION_DESCRIPTION_LENGTH,
  COLLECTION_ITEM_STATES,
  COLLECTION_NAME_LENGTH,
  COLLECTION_URI_BYTES,
  MAX_TAG_LINK_CANDIDATES,
  MAX_TAGGED_COLLECTIONS,
  MAX_TAGGING_STATUSES,
} from "../src/platform/stored-bounds";
import { sha256Hex } from "../src/security/tokens";
import { type ApiHarness, bearer, setSetting, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { acceptQuote } from "./budget-helpers";
import { malformed, maximalCollections } from "./collection-maxima";
import { BUILD } from "./helpers";
import { MASTODON, mastodonActor } from "./inbox-helpers";
import {
  ALICE,
  AS,
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
import { seedEmojiRow } from "./local-emoji-helpers";
import {
  measuredRead,
  measuredStatements,
  observedSql,
  plannedRun,
  type PlannedStatement,
  plannedSql,
  staleStatistics,
} from "./read-helpers";
import { act, block, community, getJson, outbound, post, remoteAccount, seedStatus } from "./status-helpers";
import { postsTab } from "./web-helpers";

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

// A request to any URL, through the app as t.request sends one to the instance's.
async function through(t: Setup, url: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await t.app.fetch(new Request(url, init), t.env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
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
    const byUrl = await posted(t, `${LOCAL}/collections/${L}`);
    expect(await tagged(t, byUrl)).toEqual([L]);
    const { body } = await t.api<Status>(`/api/v1/statuses/${byUrl}`, "dave");
    expect(body.tagged_collections.map(({ id, uri, url }) => ({ id, uri, url }))).toEqual([
      { id: L, uri: `${LOCAL}/ap/users/alice/collections/${L}`, url: `${LOCAL}/collections/${L}` },
    ]);
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
      publishScheduled.run(state.storage.sql, {
        id,
        now: NOW + 2 * 60 * 60 * 1000,
        storeNow: NOW + 2 * 60 * 60 * 1000,
        objectId: crypto.randomUUID(),
      }),
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
// postStatus's input for dave's post of `text`.
async function postInput(t: Setup, text: string) {
  return {
    credential: { tokenHash: await sha256Hex(t.tokens.dave), scope: "write:statuses", now: NOW } as never,
    text,
    spoilerText: "",
    mediaIds: [],
    objectId: crypto.randomUUID(),
    now: NOW,
    storeNow: NOW,
    present: { origin: LOCAL },
  };
}

async function measuredPost(t: Setup, text: string) {
  return measuredStatements(t, postStatus, await postInput(t, text), true);
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

  // #1589's D3: the instance's domain, which decides every candidate, is read once for the post's links, however many
  // of them resolve to a remote collection, and once each when the Note (statusFacts) and the answer read the post's
  // tagged collections.
  it("reads the instance's domain once for a post's links", async () => {
    const t = await setup();
    const uri = `${MASTODON}/users/x/collections/1`;
    const X = await remoteCollection(t, await remoteOwner(t, 1, `${MASTODON}/users/x`), 1, uri);
    const links = Array.from({ length: MAX_TAG_LINK_CANDIDATES }, () => uri).join("\n");
    const { output, statements } = await measuredPost(t, links);
    const id = (output as { value: { value: { id: string } } }).value.value.id;
    const domainReads = statements.filter(
      (s) =>
        s.query.replace(/\s+/g, " ").trim() ===
        "SELECT s.value AS value FROM instance_settings s WHERE s.name = 'domain'",
    );
    expect({ tagged: await tagged(t, id), domainReads: domainReads.length }).toEqual({ tagged: [X], domainReads: 3 });
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

  // The lookup reads at most 2 entries of collections_url however many rows share the url, under statistics taken over
  // 3 of them, seeking the url and the range of ids on the link's origin: of the rows added (rows a restored dump may
  // hold, their owners on another origin), 1,000 in the range sort first, so a walk that tested owners before its LIMIT
  // would read them all, and 1,000 with ids on m.example.org sort before the range, so a walk that did not seek the
  // range would read them all; the answer is none either way.
  it("reads two rows of one url under statistics taken before it grew", async () => {
    const t = await setup();
    const add = (from: number, n: number, owner: string, uri: string) =>
      sql(
        t.store,
        `WITH RECURSIVE n(i) AS (SELECT ?1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 + ?2 - 1)
				INSERT INTO collections (id, account_id, local, name, sensitive, discoverable, uri, url, total_items,
					created_at, updated_at)
				SELECT printf('5%017d', i), printf(?3, 1 + i / 50), 0, 'c', 0, 1, ?4 || i,
					'https://m.example/collections/1', 0, ?5, ?5 FROM n`,
        from,
        n,
        owner,
        uri,
        T,
      );
    await sql(
      t.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 60)
			INSERT INTO accounts (id, uri, username, domain)
			SELECT printf('7%017d', i), 'https://m.example/users/w' || i, 'w' || i, 'm.example' FROM n
			UNION ALL SELECT printf('8%017d', i), 'https://m.example.org/users/v' || i, 'v' || i, 'm.example.org' FROM n`,
    );
    await add(0, 3, "7%017d", `${M}/users/w/collections/`);
    await sql(t.store, "ANALYZE");
    const rows = async () => {
      const { result, plans } = await plannedRun(
        t,
        /collections_url/,
        postStatus,
        await postInput(t, `${M}/collections/1`),
        true,
      );
      expect(result).toMatchObject({ status: "ok", value: { status: "ok" } });
      const id = (result as { value: { value: { id: string } } }).value.value.id;
      expect(await tagged(t, id)).toEqual([]);
      expect(plans).toHaveLength(1);
      expect(plans[0]!.plan).toContain("SEARCH collections USING INDEX collections_url (url=? AND uri>? AND uri<?)");
      return plans[0]!.rows;
    };
    const few = await rows();
    await add(100, 1000, "8%017d", `${M}/a/collections/`);
    await add(2000, 1000, "8%017d", `${M}.org/v/collections/`);
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

  // #1589's D3: a Note search resolves names the local collection its tag gives by the instance's domain, so it is
  // referenced alike whether the search came over HTTPS or HTTP.
  it("references a local collection alike from a Note resolved over HTTPS or HTTP", async () => {
    const { t, bob, L } = await world();
    const notes = [mastodonNote(bob, tags(localUri(L))), mastodonNote(bob, tags(localUri(L)))];
    const references: string[][] = [];
    for (const [i, origin] of [LOCAL, "http://kopje.test"].entries()) {
      const note = notes[i]!;
      t.web.serve(note.id, { "@context": AS, ...note });
      const path = `/api/v2/search?type=statuses&resolve=true&q=${encodeURIComponent(note.id)}`;
      const response = await through(t, `${origin}${path}`, { headers: { authorization: `Bearer ${t.tokens.dave}` } });
      expect((await response.json<{ statuses: unknown[] }>()).statuses).toHaveLength(1);
      references.push(await tagged(t, await statusId(t, note)));
    }
    expect(references).toEqual([[L], [L]]);
  });

  // #1589's D1 and D3: every tag goes to the one resolver, which names a local collection by any address its routes
  // serve, http included, as a post's link does (only a remote collection's id is https, as stored). A Create naming L
  // by its route or its web page over http references L, and so does an Update replacing the https tag with either,
  // which moves the version.
  it("references a local collection by its route or web page over http, from a Create and an Update", async () => {
    const { t, bob, L } = await world();
    const aliases = [`http://kopje.test/ap/users/alice/collections/${L}`, `http://kopje.test/collections/${L}`];
    const created: string[][] = [];
    for (const alias of aliases) {
      const note = mastodonNote(bob, tags(alias));
      expect(await t.post(bob, create(bob, note))).toBe(202);
      created.push(await tagged(t, await statusId(t, note)));
    }
    const note = mastodonNote(bob, tags(localUri(L)));
    expect(await t.post(bob, create(bob, note))).toBe(202);
    const id = await statusId(t, note);
    const v2 = Date.parse(note.published as string) + 60 * 60 * 1000;
    const updated: { tagged: string[]; version: string }[] = [];
    for (const [i, alias] of aliases.entries()) {
      const activity = update(bob, { ...note, ...tags(alias) }, new Date(v2 + i * 60_000).toISOString());
      expect(await t.post(bob, { ...activity, id: `${activity.id}/${i}` })).toBe(202);
      const [row] = await sql<{ version: string }>(
        t.store,
        "SELECT remote_version AS version FROM statuses WHERE id = ?",
        id,
      );
      updated.push({ tagged: await tagged(t, id), version: row!.version });
    }
    expect({ created, updated }).toEqual({
      created: [[L], [L]],
      updated: aliases.map((_, i) => ({ tagged: [L], version: new Date(v2 + i * 60_000).toISOString() })),
    });
  });

  // A tag's id is capped at COLLECTION_URI_BYTES (a remote collection's stored id) without its fragment, which no lookup
  // compares: L's id padded by its fragment alone to COLLECTION_URI_BYTES + 1 bytes references L.
  it("references a local collection by its id padded past COLLECTION_URI_BYTES by its fragment alone", async () => {
    const { t, bob, L } = await world();
    const id = `${localUri(L)}#`;
    const padded = id + "f".repeat(COLLECTION_URI_BYTES + 1 - utf8Length(id));
    const note = mastodonNote(bob, tags(padded));
    expect(await t.post(bob, create(bob, note))).toBe(202);
    expect({ bytes: utf8Length(padded), tagged: await tagged(t, await statusId(t, note)) }).toEqual({
      bytes: COLLECTION_URI_BYTES + 1,
      tagged: [L],
    });
  });

  it("reads the first MAX_TAG_LINK_CANDIDATES distinct tag ids", async () => {
    const { t, bob, M, uriOf } = await world();
    const unknown = Array.from({ length: MAX_TAG_LINK_CANDIDATES }, (_, i) => `${MASTODON}/users/x/collections/${i}`);
    const note = mastodonNote(bob, tags(...unknown, uriOf.M));
    expect(await t.post(bob, create(bob, note))).toBe(202);
    expect(await tagged(t, await statusId(t, note))).toEqual([]);
    // MAX_TAG_LINK_CANDIDATES copies of one id are one candidate, so M, after them, is read.
    const repeated = mastodonNote(
      bob,
      tags(...Array.from({ length: MAX_TAG_LINK_CANDIDATES }, () => unknown[0]!), uriOf.M),
    );
    expect(await t.post(bob, create(bob, repeated))).toBe(202);
    expect(await tagged(t, await statusId(t, repeated))).toEqual([M]);
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

// ---- Presentation (7-T5): R45 decides what a status's tagged_collections shows, a chunk reads a collection once, and
// no page reads a reference.

// The local collection `n` of `owner`, written directly: listed among its owner's only when `discoverable`.
async function ownedCollection(store: StoreStub, owner: string, n: number, discoverable: boolean): Promise<string> {
  await sql(
    store,
    `INSERT INTO collections (id, account_id, local, name, sensitive, discoverable, created_at, updated_at)
		VALUES (?, ?, 1, ?, 0, ?, ?, ?)`,
    collectionId(n),
    owner,
    `local ${n}`,
    discoverable ? 1 : 0,
    T,
    T,
  );
  return collectionId(n);
}

let items = 0;
// `member`'s item of the collection `collection` at `position`, in `state`.
const item = (store: StoreStub, collection: string, member: string, position: number, state: number) =>
  sql(
    store,
    `INSERT INTO collection_items (id, collection_id, account_id, state, position, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
    String(600000000000000000n + BigInt(++items)),
    collection,
    member,
    state,
    position,
    T,
    T,
  );

// A presented status's collections, each with its items' accounts.
const shown = (status: Pick<Status, "tagged_collections">) =>
  status.tagged_collections.map(({ id, items }) => ({ id, members: items.map((i) => i.account_id) }));

describe("a status's tagged_collections (7-T5)", () => {
  // carol's public post P linking alice's non-discoverable collection C, which holds bob's accepted item and erin's
  // pending one; alice blocks victor.
  async function world() {
    const h = await community(["alice", "carol", "victor", "wendy"]);
    const { alice, carol, victor } = h.users;
    const C = await ownedCollection(h.store, alice.id, 1, false);
    const [bob, erin] = [await remoteAccount(h.store, "bob"), await remoteAccount(h.store, "erin")];
    await item(h.store, C, bob, 1, COLLECTION_ITEM_STATES.accepted);
    await item(h.store, C, erin, 2, COLLECTION_ITEM_STATES.pending);
    const P = (await post(h, carol, { status: `${LOCAL}/collections/${C}` })).id;
    await block(h.store, alice.id, victor.id);
    return { h, C, P, bob, erin };
  }
  const read = async (h: ApiHarness, id: string, token?: string) => {
    const { status, body } = await getJson<Status>(h, `/api/v1/statuses/${id}`, token);
    expect(status).toBe(200);
    return body;
  };

  it("shows each viewer the collection and the items R45 shows them", async () => {
    const { h, C, P, bob, erin } = await world();
    const { alice, victor, wendy } = h.users;
    expect(shown(await read(h, P, victor.token))).toEqual([]);
    expect(shown(await read(h, P, wendy.token))).toEqual([{ id: C, members: [bob] }]);
    expect(shown(await read(h, P, alice.token))).toEqual([{ id: C, members: [bob, erin] }]);
    const timeline = await getJson<Status[]>(h, "/api/v1/timelines/public");
    expect(timeline.status).toBe(200);
    expect(timeline.body.map((status) => [status.id, shown(status)])).toEqual([[P, [{ id: C, members: [bob] }]]]);
    // While its owner is suspended, no viewer is shown it.
    await sql(h.store, "UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?", T, alice.id);
    expect(shown(await read(h, P, wendy.token))).toEqual([]);
    expect(shown(await read(h, P))).toEqual([]);
  });

  it("presents a boost's original and a quote's own and quoted collections", async () => {
    const { h, C, P, bob } = await world();
    const { alice, wendy } = h.users;
    const boosted = await act(h, wendy, `/api/v1/statuses/${P}/reblog`);
    expect(boosted.status).toBe(200);
    const boost = await read(h, (await boosted.json<{ id: string }>()).id, wendy.token);
    expect(shown(boost)).toEqual([]);
    expect(shown(boost.reblog!)).toEqual([{ id: C, members: [bob] }]);
    const D = await ownedCollection(h.store, alice.id, 2, true);
    const Q = (await post(h, wendy, { status: `${LOCAL}/collections/${D}` })).id;
    await acceptQuote(h, Q, P);
    const quote = await read(h, Q, wendy.token);
    expect(shown(quote)).toEqual([{ id: D, members: [] }]);
    expect(shown((quote.quote as Quote).quoted_status!)).toEqual([{ id: C, members: [bob] }]);
  });

  // 20 statuses each tagging one collection of 25 accepted items of distinct members, presented as one chunk: the
  // collection and its items are read once, so the statements reading the references, collections and items grow by
  // a status's reference and its json_each entry alone (at most 3 a status), where a read per status adds at least 26.
  it("reads a collection the statuses of a chunk share once", async () => {
    const h = await community(["alice", "carol"]);
    const { alice, carol } = h.users;
    const C = await ownedCollection(h.store, alice.id, 1, true);
    await sql(
      h.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 25)
			INSERT INTO accounts (id, uri, username, domain) SELECT printf('71%016d', i), 'https://m.example/users/m' || i,
				'm' || i, 'm.example' FROM n`,
    );
    await sql(
      h.store,
      `INSERT INTO collection_items (id, collection_id, account_id, state, position, created_at, updated_at)
			SELECT '61' || substr(id, 3), ?1, id, 1, CAST(substr(id, 3) AS INTEGER), ?2, ?2 FROM accounts WHERE id GLOB '71*'`,
      C,
      T,
    );
    await sql(
      h.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20)
			INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
			SELECT printf('9%017d', i), 'https://kopje.test/ap/o/t' || i, ?1, 'public', '', ?2 FROM n`,
      carol.id,
      T,
    );
    await sql(h.store, "INSERT INTO status_collections SELECT id, ? FROM statuses WHERE id GLOB '9*'", C);
    const chunk = readOperation<{ ids: string[] }, Status[]>((db, { ids }) => {
      const visible = ids as VisibleStatusId[];
      const shared = presentation(db, visible, { origin: LOCAL, viewer: contextOf(alice.id, NOW) });
      return [...statusStream(db, shared, visible, 20)].filter((status) => status !== undefined);
    });
    const measured = async (n: number) => {
      const ids = Array.from({ length: n }, (_, i) => `9${String(i + 1).padStart(17, "0")}`);
      const { output, statements } = await measuredStatements(h, chunk, { ids });
      const rows = statements
        .filter(({ query }) => /status_collections|\bcollections\b|collection_items/.test(query))
        .reduce((sum, { rows }) => sum + rows, 0);
      return { rows, members: output.map((status) => shown(status)[0]?.members.length) };
    };
    const [one, twenty] = [await measured(1), await measured(20)];
    expect(twenty.rows - one.rows, `${one.rows} → ${twenty.rows}`).toBeLessThanOrEqual(3 * 19);
    expect([one.members, twenty.members]).toEqual([[25], Array.from({ length: 20 }, () => 25)]);
  });

  // bob's public post P with a hashtag, pinned, linking four of alice's collections, and bob's reply R to P: each page
  // reads as many rows as with P's references deleted, and presents P's tagged_collections empty.
  it("reads no reference for a page, which presents none, while the API presents them", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    const collections = [];
    for (const n of [1, 2, 3, 4]) {
      collections.push(await ownedCollection(h.store, alice.id, n, true));
      await item(h.store, collectionId(n), alice.id, 1, COLLECTION_ITEM_STATES.accepted);
    }
    const links = collections.map((id) => `${LOCAL}/collections/${id}`);
    const P = (await post(h, bob, { status: ["#walks", ...links].join("\n") })).id;
    expect((await sql(h.store, "SELECT count(*) AS n FROM status_collections WHERE status_id = ?", P))[0]).toEqual({
      n: 4,
    });
    expect((await act(h, bob, `/api/v1/statuses/${P}/pin`)).status).toBe(200);
    const R = (await post(h, bob, { status: "a reply", in_reply_to_id: P })).id;
    const url = `${LOCAL}/@bob/${P}`;
    // Each status page with its thread: R's holds P among its ancestors.
    const replies = { kind: "replies", cursor: null } as const;
    const credential = { tokenHash: await sha256Hex(bob.token), scope: "write:follows", now: NOW } as const;
    const reads: [string, () => Promise<{ output: unknown; rows: number }>][] = [
      ["P's page", () => measuredRead(h, webStatusPage, { handle: "bob", id: P, now: NOW, tab: replies })],
      ["R's page", () => measuredRead(h, webStatusPage, { handle: "bob", id: R, now: NOW, tab: replies })],
      ["the profile's posts", () => measuredRead(h, webProfilePage, postsTab("bob", null, NOW))],
      ["the hashtag page", () => measuredRead(h, webTagPage, { name: "walks", cursor: null, now: NOW })],
      ["the interact handoff", () => measuredRead(h, webInteractTarget, { handle: "bob", id: P, now: NOW })],
      ["oEmbed", () => measuredRead(h, embeddedStatus, { url, present: { origin: LOCAL }, now: NOW })],
      [
        "/authorize_interaction",
        () =>
          measuredRead(h, resolveInteraction, {
            credential,
            query: url,
            resolved: { kind: "local" },
            now: NOW,
            storeNow: NOW,
            origin: LOCAL,
            present: { origin: LOCAL },
          }),
      ],
    ];
    const measure = async () => {
      const measured: { name: string; rows: number; json: string }[] = [];
      for (const [name, run] of reads) {
        const { output, rows } = await run();
        measured.push({ name, rows, json: JSON.stringify(output) });
      }
      return measured;
    };
    const tagged = await measure();
    for (const { name, json } of tagged) {
      expect(json, name).toContain(`"id":"${P}"`);
      expect(json, name).toContain('"tagged_collections":[]');
      expect(json.match(/"tagged_collections":\[[^\]]/g), name).toBeNull();
    }
    const statuses = await getJson<Status[]>(h, `/api/v1/accounts/${bob.id}/statuses`, alice.token);
    expect(statuses.body.find((status) => status.id === P)?.tagged_collections.map(({ id }) => id)).toEqual(
      collections,
    );
    await sql(h.store, "DELETE FROM status_collections WHERE status_id = ?", P);
    const untagged = await measure();
    expect(tagged.map(({ name, rows }) => [name, rows])).toEqual(untagged.map(({ name, rows }) => [name, rows]));
  });
});

// ---- ActivityPub (7-T1, 7-T10): every surface of a local status names the collections it tags by their ids alone.

const AP_GET = { headers: { accept: "application/activity+json" } };
const pathOf = (uri: string) => {
  const url = new URL(uri);
  return `${url.pathname}${url.search}`;
};

// The ids the Note of the local status `id` names in its FeaturedCollection tags.
async function noted(t: Setup, id: string): Promise<string[]> {
  const [row] = await sql<{ uri: string }>(t.store, "SELECT uri FROM statuses WHERE id = ?", id);
  const note = await (await t.request(pathOf(row!.uri), AP_GET)).json<{ tag: Record<string, unknown>[] }>();
  return note.tag.filter((tag) => tag.type === "FeaturedCollection").map((tag) => tag.id as string);
}

// Each distinct local id of `ids` dereferenced: its status and, when served, the id its document declares.
async function served(t: Setup, ids: readonly string[]): Promise<{ status: number; id: string | null }[]> {
  const local = [...new Set(ids)].filter((id) => id.startsWith(`${LOCAL}/`));
  return Promise.all(
    local.map(async (id) => {
      const response = await t.request(pathOf(id), AP_GET);
      return { status: response.status, id: response.ok ? (await response.json<{ id: string }>()).id : null };
    }),
  );
}

// context_helper.rb's featured_collections terms, written out.
const FEATURED_COLLECTIONS_TERMS = {
  FeaturedCollection: "https://w3id.org/fep/7aa9#FeaturedCollection",
  FeaturedItem: "https://w3id.org/fep/7aa9#FeaturedItem",
  FeatureRequest: "https://w3id.org/fep/7aa9#FeatureRequest",
  FeatureAuthorization: "https://w3id.org/fep/7aa9#FeatureAuthorization",
  topic: { "@id": "https://w3id.org/fep/7aa9#topic", "@type": "@id" },
  featuredObject: { "@id": "https://w3id.org/fep/7aa9#featuredObject", "@type": "@id" },
  featureAuthorization: { "@id": "https://w3id.org/fep/7aa9#featureAuthorization", "@type": "@id" },
};

describe("the ActivityPub surfaces of a status that tags collections (7-T1, 7-T10)", () => {
  // dave's public P mentioning alice, with a hashtag, a custom emoji and a poll, linking alice's L and a valid remote
  // M, quoting bob's Note (a remote status, so a QuoteRequest follows the Create), then pinned and edited, and its poll
  // ended.
  it("names each collection by its id alone, after the other tags, under the featured_collections terms", async () => {
    const t = await setup();
    await seedEmojiRow(t.store, { id: "190000000000000001", shortcode: "walking", owner: ALICE });
    const L = await localCollection(t, ALICE, 1);
    const owner = await remoteOwner(t, 1, `${MASTODON}/users/m`);
    await remoteCollection(t, owner, 2, `${MASTODON}/users/m/collections/2`);
    const bob = await mastodonActor(t.web, "bob");
    await followed(t, bob);
    // Quotable by anyone with bob's approval: dave's quote waits for it.
    const quotedNote = mastodonNote(bob, {
      interactionPolicy: { canQuote: { manualApproval: ["https://www.w3.org/ns/activitystreams#Public"] } },
    });
    expect(await t.post(bob, create(bob, quotedNote))).toBe(202);
    const [quoted] = await sql<{ id: string }>(t.store, "SELECT id FROM statuses WHERE uri = ?", quotedNote.id);
    const body = {
      status: `@alice #walks :walking: ${LOCAL}/collections/${L}\n${MASTODON}/users/m/collections/2`,
      poll: { options: ["a", "b"], expires_in: 300 },
      quoted_status_id: quoted!.id,
    };
    const dave = { authorization: `Bearer ${t.tokens.dave}`, "content-type": "application/json" };
    const posted = await t.request("/api/v1/statuses", { method: "POST", headers: dave, body: JSON.stringify(body) });
    expect(posted.status).toBe(200);
    const P = await posted.json<{ id: string; uri: string }>();
    expect((await t.request(`/api/v1/statuses/${P.id}/pin`, { method: "POST", headers: dave })).status).toBe(200);
    const edited = await t.request(`/api/v1/statuses/${P.id}`, {
      method: "PUT",
      headers: dave,
      body: JSON.stringify({ ...body, status: `${body.status} edited` }),
    });
    expect(edited.status).toBe(200);
    // The edit's Update, read before the poll's Update supersedes it in the lane.
    const recordedOf = async () => (await outbound(t.store)).map((row) => row.activity as Record<string, unknown>);
    const [edit] = (await recordedOf()).filter(
      (activity) => activity.type === "Update" && (activity.object as { id?: string }).id === P.uri,
    );
    await endPolls(t.env, { build: () => BUILD, now: () => NOW + 2 * 60 * 60 * 1000, store: () => t.store });
    // Each surface: the object, and the context its document carries.
    const surfaces: [string, unknown, Record<string, unknown>][] = [];
    const served = await (await t.request(pathOf(P.uri), AP_GET)).json<Record<string, unknown>>();
    surfaces.push(["the Question at its id", served["@context"], served]);
    const outbox = await (await t.request("/ap/users/dave/outbox", AP_GET)).json<{ first: string }>();
    const page = await (await t.request(pathOf(outbox.first), AP_GET)).json<Record<string, unknown>>();
    // A page's items keep the contexts the Store built, nested in Fedify's page (§7.2, J-6).
    const [inOutbox] = (page.orderedItems as { "@context": unknown; object: Record<string, unknown> }[]).filter(
      (item) => item.object.id === P.uri,
    );
    surfaces.push(["the outbox page's Create", inOutbox!["@context"], inOutbox!.object]);
    const featured = await (
      await t.request("/ap/users/dave/collections/featured", AP_GET)
    ).json<Record<string, unknown>>();
    const [pinned] = featured.orderedItems as Record<string, unknown>[];
    surfaces.push(["featured", pinned!["@context"], pinned!]);
    const recorded = await recordedOf();
    const about = (type: string) =>
      recorded.filter((activity) => activity.type === type && (activity.object as { id?: string }).id === P.uri);
    const [creation] = about("Create");
    surfaces.push(["the recorded Create", creation!["@context"], creation!.object as Record<string, unknown>]);
    // The poll's Update by its id, which names it after the time it is recorded, and its end.
    const [ended] = about("Update").filter((activity) => String(activity.id).startsWith(`${P.uri}#updates/poll-`));
    expect((ended!.object as { closed?: unknown }).closed).toEqual(expect.any(String));
    surfaces.push(["the edit's Update", edit!["@context"], edit!.object as Record<string, unknown>]);
    surfaces.push(["the poll's Update", ended!["@context"], ended!.object as Record<string, unknown>]);
    const [request] = recorded.filter((activity) => activity.type === "QuoteRequest");
    surfaces.push([
      "the QuoteRequest's instrument",
      request!["@context"],
      request!.instrument as Record<string, unknown>,
    ]);
    for (const [name, context, object] of surfaces) {
      expect(object.type, name).toBe("Question");
      const tags = object.tag as Record<string, unknown>[];
      expect(tags.slice(-2), name).toEqual([
        { type: "FeaturedCollection", id: "https://kopje.test/ap/users/alice/collections/500000000000000001" },
        { type: "FeaturedCollection", id: "https://mastodon.example/users/m/collections/2" },
      ]);
      expect(
        tags.slice(0, -2).map((tag) => tag.type),
        name,
      ).toEqual(["Mention", "Hashtag", "Emoji"]);
      expect([context].flat(), name).toContainEqual(expect.objectContaining(FEATURED_COLLECTIONS_TERMS));
    }
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
    return { t, X, Y, Z, S, uriOf: { Y: `${MASTODON}/users/x/collections/2`, Z: `${M}/users/z/collections/3` } };
  }

  it("presents Y alone, with its uri for the url no writer would store", async () => {
    const { t, Y, S, uriOf } = await restored();
    const { body } = await t.api<Status>(`/api/v1/statuses/${S}`, "dave");
    expect(body.tagged_collections.map(({ id, uri, url }) => ({ id, uri, url }))).toEqual([
      { id: Y, uri: uriOf.Y, url: uriOf.Y },
    ]);
  });

  // A restored description of 2,048 characters of four bytes each, a lead byte 0xC0 and three continuation bytes, which
  // the CHECK admits (2,048 characters, 8,192 bytes) and which are read as 8,192 U+FFFD: 24,576 JSON bytes, twice what
  // COLLECTION_JSON_MAX charges a description. Its collection is left out; V, beside it, is shown.
  it("leaves out a restored collection whose text reads past its writer's bounds", async () => {
    const t = await setup();
    const owner = await remoteOwner(t, 1, `${MASTODON}/users/x`);
    const U = await remoteCollection(t, owner, 1, `${MASTODON}/users/x/collections/1`);
    const V = await remoteCollection(t, owner, 2, `${MASTODON}/users/x/collections/2`);
    await sql(
      t.store,
      "UPDATE collections SET description = CAST(unhex(replace(hex(zeroblob(2048)), '00', 'C0808080')) AS TEXT) WHERE id = ?",
      U,
    );
    const [read] = await sql<{ description: string }>(t.store, "SELECT description FROM collections WHERE id = ?", U);
    expect(jsonBytes(read!.description)).toBe(24_576 + 2);
    const S = await posted(t, "S");
    for (const id of [U, V]) {
      await sql(t.store, "INSERT INTO status_collections VALUES (?, ?)", S, id);
    }
    const { body } = await t.api<Status>(`/api/v1/statuses/${S}`, "dave");
    expect(body.tagged_collections.map(({ id }) => id)).toEqual([V]);
  });

  // The first's tag is 256 characters of 0xC0 and three continuation bytes (1,024 bytes, within its CHECK, read as 1,024
  // U+FFFD), the third's name F0 90 80, a sequence cut short that decodes to one U+FFFD of the same three bytes, and the
  // fifth's description C0 80, read as two U+FFFD (within withinRemoteText's bound): each is malformed in one column
  // alone, so none is presented. The fourth's description stores a U+FFFD, well-formed, so it is presented beside the
  // second. S tags the first four, S2 the fifth.
  it("leaves out a restored collection whose text is malformed, however wide it decodes", async () => {
    const t = await setup();
    const owner = await remoteOwner(t, 1, `${MASTODON}/users/x`);
    const ids: string[] = [];
    for (let n = 1; n <= 5; n++) {
      ids.push(await remoteCollection(t, owner, n, `${MASTODON}/users/x/collections/${n}`));
    }
    const restore = (column: string, count: number, character: string, id: string) =>
      sql(
        t.store,
        `UPDATE collections SET ${column} = CAST(unhex(replace(hex(zeroblob(?)), '00', ?)) AS TEXT) WHERE id = ?`,
        count,
        character,
        id,
      );
    await restore("tag", 256, "C0808080", ids[0]!);
    await restore("name", 1, "F09080", ids[2]!);
    await sql(t.store, "UPDATE collections SET description = ? WHERE id = ?", "a\uFFFDb", ids[3]!);
    await restore("description", 1, "C080", ids[4]!);
    const S = await posted(t, "S");
    const S2 = await posted(t, "S2");
    for (const [n, id] of ids.entries()) {
      await sql(t.store, "INSERT INTO status_collections VALUES (?, ?)", n < 4 ? S : S2, id);
    }
    const shown = async (status: string) =>
      (await t.api<Status>(`/api/v1/statuses/${status}`, "dave")).body.tagged_collections.map(({ id }) => id);
    expect([await shown(S), await shown(S2)]).toEqual([[ids[1], ids[3]], []]);
  });

  // Each text of a restored collection (maximalCollections' restored shape) as the tag reads return it, the REST one's
  // and then the Note's: three times the bytes the read takes of it, which no stored bytes decode past
  // (collection-maxima.ts, `malformed`), so the fill the heap model measures is the widest. None of the four is
  // presented or named.
  it("reads a restored collection's every text at three times the bytes the read takes of it", async () => {
    const t = await setup();
    const S = await posted(t, "S");
    await maximalCollections(t.store, "\u0001", [S], true);
    const read = await runInDurableObject(t.store, (_instance, state) => {
      const widths: Record<string, number>[] = [];
      const db = new Db(
        observedSql(state.storage.sql, (rows) => {
          for (const row of rows) {
            if ("owner_uri" in row && "name" in row) {
              const { owner_uri, name, description, tag } = row as Record<string, string>;
              const width = (value: string) => utf8Length(value);
              widths.push({
                owner_uri: width(owner_uri!),
                name: width(name!),
                description: width(description!),
                tag: width(tag!),
              });
            }
          }
        }),
      );
      const presented = taggedCollectionsOf(db, [S], null, LOCAL).get(S) ?? [];
      const named = statusFacts(db, S, () => null)?.collections ?? [];
      return { widths, presented: presented.length, named };
    });
    const widest = {
      owner_uri: 3 * ACTOR_URI_LIMIT,
      name: 3 * 4 * COLLECTION_NAME_LENGTH.remote,
      description: 3 * 4 * COLLECTION_DESCRIPTION_LENGTH.remote,
      tag: 3 * 4 * MAX_TAG_LENGTH,
    };
    expect(read.widths).toEqual(Array.from({ length: 2 * MAX_TAGGED_COLLECTIONS }, () => widest));
    expect({ presented: read.presented, named: read.named }).toEqual({ presented: 0, named: [] });
  });

  // #1589's D2: a local collection can be tagged while its owner is a local account and its id (its owner's stored actor
  // id and its own) has a path the collection route takes (ROUTE_USERNAME under /ap/users/, no query), on any host; the
  // username plays no part. alice's actor id is restored as her route, the same path on another host (kept from an
  // earlier domain), 64 letters, and her route beside a malformed username: L is tagged, presented and named under that
  // actor id. As a-b, 65 letters, a path off /ap/users and her route with a query, it is not; V, beside it, always is.
  it("decides a local collection by its owner's actor id's path, on any host, whatever the username", async () => {
    const t = await setup();
    const L = await localCollection(t, ALICE, 1);
    const owner = await remoteOwner(t, 2, `${MASTODON}/users/x`);
    const V = await remoteCollection(t, owner, 2, `${MASTODON}/users/x/collections/2`);
    const S = await posted(t, "S");
    for (const id of [L, V]) {
      await sql(t.store, "INSERT INTO status_collections VALUES (?, ?)", S, id);
    }
    const alice = Uint8Array.from(new TextEncoder().encode("alice")).buffer;
    const cases: [string, ArrayBuffer][] = [
      [`${LOCAL}/ap/users/alice`, alice],
      ["https://old.example/ap/users/alice", alice],
      [`${LOCAL}/ap/users/${"a".repeat(64)}`, alice],
      [`${LOCAL}/ap/users/alice`, malformed(USERNAME_LIMIT)],
      [`${LOCAL}/ap/users/a-b`, alice],
      [`${LOCAL}/ap/users/${"a".repeat(65)}`, alice],
      [`${LOCAL}/users/alice`, alice],
      [`${LOCAL}/ap/users/alice?x=1`, alice],
    ];
    const seen: unknown[] = [];
    for (const [uri, username] of cases) {
      await sql(t.store, "UPDATE accounts SET uri = ?, username = CAST(? AS TEXT) WHERE id = ?", uri, username, ALICE);
      const read = await runInDurableObject(t.store, (_instance, state) => {
        const db = new Db(state.storage.sql);
        return {
          presented: (taggedCollectionsOf(db, [S], null, LOCAL).get(S) ?? []).map(({ uri: id }) => id),
          named: statusFacts(db, S, () => null)?.collections ?? [],
        };
      });
      seen.push({ ...read, linked: await tagged(t, await posted(t, `${LOCAL}/collections/${L}`)) });
    }
    const v = `${MASTODON}/users/x/collections/2`;
    const tags = (actor: string) => ({
      presented: [`${actor}/collections/${L}`, v],
      named: [`${actor}/collections/${L}`, v],
      linked: [L],
    });
    const left = { presented: [v], named: [v], linked: [] };
    expect(seen).toEqual([...cases.slice(0, 4).map(([uri]) => tags(uri)), left, left, left, left]);
  });

  // A local collection owned by o2, a remote account (a restored row the import admits) whose actor id has the path the
  // collection route takes: only its owner's locality (#1589's D2) leaves it out. The routes serve a local account's
  // alone, so /ap/users/o2/collections/… answers 404; neither the REST read nor the Note presents or names it, and a
  // link to it by either local form references none; V, beside it, is.
  it("leaves out a local collection whose owner is not a local account", async () => {
    const t = await setup();
    const owner = await remoteOwner(t, 2, `${MASTODON}/ap/users/o2`);
    const O = await localCollection(t, owner, 1);
    const V = await remoteCollection(t, owner, 2, `${MASTODON}/ap/users/o2/collections/2`);
    const S = await posted(t, "S");
    for (const id of [O, V]) {
      await sql(t.store, "INSERT INTO status_collections VALUES (?, ?)", S, id);
    }
    const v = `${MASTODON}/ap/users/o2/collections/2`;
    const { body } = await t.api<Status>(`/api/v1/statuses/${S}`, "dave");
    expect(body.tagged_collections.map(({ id, uri }) => ({ id, uri }))).toEqual([{ id: V, uri: v }]);
    expect(await noted(t, S)).toEqual([v]);
    expect((await t.request(`/ap/users/o2/collections/${O}`, AP_GET)).status).toBe(404);
    const links = [`${LOCAL}/ap/users/o2/collections/${O}`, `${LOCAL}/collections/${O}`];
    expect(await tagged(t, await posted(t, ...links))).toEqual([]);
  });

  // alice's username restored as a-b, of Mastodon's grammar but not the routes' (#1811): a post linking four of her
  // collections by their ids and then dave's own D gives D a slot, which the API presents, the Note names and the
  // route serves; the four, which no surface shows, take none, so they do not crowd D out of the first
  // MAX_TAGGED_COLLECTIONS.
  it("gives a post's slots only to collections a status can tag, before it takes the first four", async () => {
    const t = await setup();
    const unroutable: string[] = [];
    for (let n = 1; n <= MAX_TAGGED_COLLECTIONS; n++) {
      unroutable.push(await localCollection(t, ALICE, n));
    }
    const D = await localCollection(t, DAVE, 9);
    await sql(t.store, "UPDATE accounts SET username = 'a-b', uri = ? WHERE id = ?", `${LOCAL}/ap/users/a-b`, ALICE);
    const S = await posted(
      t,
      ...unroutable.map((id) => `${LOCAL}/ap/users/a-b/collections/${id}`),
      `${LOCAL}/collections/${D}`,
    );
    expect(await tagged(t, S)).toEqual([D]);
    const d = `${LOCAL}/ap/users/dave/collections/${D}`;
    const { body } = await t.api<Status>(`/api/v1/statuses/${S}`, "dave");
    expect(body.tagged_collections.map(({ id, uri }) => ({ id, uri }))).toEqual([{ id: D, uri: d }]);
    expect(await noted(t, S)).toEqual([d]);
    expect(await served(t, [d])).toEqual([{ status: 200, id: d }]);
  });

  // #1589's D1: a local collection's id is its owner's stored actor id and its own, on every surface, whatever the host a
  // request came on: the API's status and collection, the Note, the owner's listing, the FeaturedCollection at the
  // owner's route, a FeaturedItem (under the same actor id), dave's FeatureAuthorization and the page's alternate. Over
  // HTTPS and HTTP each emitted id dereferences to a document of that id, and the owner's writes answer 200 with ids
  // under the actor id. After a domain change (/admin/config) the ids stay under the stored actor id, which then
  // resolves no more than alice's actor id does. With alice's actor id restored as /ap/users/old_alice, every surface
  // emits the old_alice id, which, as her actor id, answers 404; her actor document at her route advertises its
  // listing there, and that listing is served (D4).
  it("builds a local collection's id from its owner's stored actor id on every surface, whatever the host", async () => {
    const t = await setup();
    const L = await localCollection(t, ALICE, 1);
    await item(t.store, L, DAVE, 1, 1);
    const I = String(600000000000000000n + BigInt(items));
    const owner = await remoteOwner(t, 2, `${MASTODON}/users/x`);
    const V = await remoteCollection(t, owner, 2, `${MASTODON}/users/x/collections/2`);
    const S = await posted(t, "S");
    for (const id of [L, V]) {
      await sql(t.store, "INSERT INTO status_collections VALUES (?, ?)", S, id);
    }
    const fetched = (url: string, init: RequestInit = {}) => through(t, url, init);
    const on = (origin: string, path: string, init: RequestInit = {}) => fetched(`${origin}${path}`, init);
    const as = (who: "alice" | "dave") => ({ authorization: `Bearer ${t.tokens[who]}` });
    // Every id a surface emits for L, read on `origin`, and the ids beside it.
    const emitted = async (origin: string) => {
      const json = async <T>(path: string, init?: RequestInit) => (await on(origin, path, init)).json<T>();
      const status = await json<Status>(`/api/v1/statuses/${S}`, { headers: as("dave") });
      const got = await on(origin, `/api/v1/collections/${L}`, { headers: as("dave") });
      const shown = got.ok ? await got.json<{ collection: { uri: string } }>() : null;
      const listing = await json<{ partOf: string; items: { id: string }[] }>(
        "/ap/users/alice/featured_collections?page=1",
        AP_GET,
      );
      const document = await json<{ id: string; attributedTo: string }>(`/ap/users/alice/collections/${L}`, AP_GET);
      const featuredItem = await json<{ id: string }>(`/ap/users/alice/collection_items/${I}`, AP_GET);
      const authorization = await json<{ interactingObject: string }>(
        `/ap/users/dave/feature_authorizations/${I}`,
        AP_GET,
      );
      const page = await (await on(origin, `/collections/${L}`)).text();
      const [named] = await runInDurableObject(
        t.store,
        (_instance, state) => statusFacts(new Db(state.storage.sql), S, () => null)?.collections ?? [],
      );
      const ids = [
        status.tagged_collections[0]?.uri,
        shown?.collection.uri,
        named,
        listing.items[0]?.id,
        document.id,
        authorization.interactingObject,
        /<link rel="alternate" type="application\/activity\+json" href="([^"]+)"/.exec(page)?.[1],
      ];
      return {
        get: got.status,
        ids: [...new Set(ids)],
        listing: listing.partOf,
        attributedTo: document.attributedTo,
        item: featuredItem.id,
      };
    };
    // The owner's writes on `origin`: a new collection and an update of L, each its status and its id's actor part.
    const writes = async (origin: string) =>
      Promise.all(
        (
          [
            ["POST", "/api/v1/collections"],
            ["PATCH", `/api/v1/collections/${L}`],
          ] as const
        ).map(async ([method, path]) => {
          const response = await on(origin, path, {
            method,
            headers: { ...as("alice"), "content-type": "application/json" },
            body: JSON.stringify({ name: "c", sensitive: false, discoverable: true }),
          });
          const body = response.ok ? await response.json<{ collection: { uri: string } }>() : null;
          return [response.status, body?.collection.uri.replace(/\/collections\/\d+$/, "") ?? null];
        }),
      );
    // An id fetched as itself, and on http: its status and the id its document declares.
    const dereferenced = async (id: string) =>
      Promise.all(
        [id, id.replace(/^https:/, "http:")].map(async (url) => {
          const response = await fetched(url, AP_GET);
          return [response.status, response.ok ? (await response.json<{ id: string }>()).id : null];
        }),
      );
    const actor = `${LOCAL}/ap/users/alice`;
    const l = `${actor}/collections/${L}`;
    const ordinary = {
      get: 200,
      ids: [l],
      listing: `${actor}/featured_collections`,
      attributedTo: actor,
      item: `${actor}/collection_items/${I}`,
    };
    for (const origin of [LOCAL, "http://kopje.test"]) {
      expect({ ...(await emitted(origin)), writes: await writes(origin) }).toEqual({
        ...ordinary,
        writes: [
          [200, actor],
          [200, actor],
        ],
      });
    }
    expect(await dereferenced(l)).toEqual([
      [200, l],
      [200, l],
    ]);
    await setSetting(t.store, "domain", "other.test");
    expect({ ...(await emitted("https://other.test")), writes: await writes("https://other.test") }).toEqual({
      ...ordinary,
      writes: [
        [200, actor],
        [200, actor],
      ],
    });
    const statusOf = async (url: string) => (await fetched(url, AP_GET)).status;
    expect([await statusOf(l), await statusOf(actor)]).toEqual([301, 301]);
    await setSetting(t.store, "domain", "kopje.test");
    const old = `${LOCAL}/ap/users/old_alice`;
    await sql(t.store, "UPDATE accounts SET uri = ? WHERE id = ?", old, ALICE);
    expect(await emitted(LOCAL)).toEqual({
      get: 200,
      ids: [`${old}/collections/${L}`],
      listing: `${old}/featured_collections`,
      attributedTo: old,
      item: `${old}/collection_items/${I}`,
    });
    expect([await statusOf(`${old}/collections/${L}`), await statusOf(old)]).toEqual([404, 404]);
    const advertised = (await (await t.request("/ap/users/alice", AP_GET)).json<{ featuredCollections: string }>())
      .featuredCollections;
    expect([advertised, await statusOf(advertised)]).toEqual([`${actor}/featured_collections`, 200]);
  });

  // #1589's D3: whether a link names a local collection is decided by the instance's domain, not by its author's actor
  // id, nor by the request's host or the link's scheme: dave's actor id kept on an earlier domain, his post linking L's
  // url on this one over http references L, which the API presents and the Note names, read over HTTPS and over HTTP
  // alike; his post linking it over https references it too.
  it("names a local collection by the instance's domain, whatever the author's actor id's", async () => {
    const t = await setup();
    const L = await localCollection(t, ALICE, 1);
    await sql(t.store, "UPDATE accounts SET uri = ? WHERE id = ?", "https://old.example/ap/users/dave", DAVE);
    const S = await posted(t, `http://kopje.test/collections/${L}`);
    const l = `${LOCAL}/ap/users/alice/collections/${L}`;
    const presented = async (origin: string) =>
      (
        await (
          await through(t, `${origin}/api/v1/statuses/${S}`, { headers: { authorization: `Bearer ${t.tokens.dave}` } })
        ).json<Status>()
      ).tagged_collections.map(({ uri }) => uri);
    const named = await runInDurableObject(
      t.store,
      (_instance, state) => statusFacts(new Db(state.storage.sql), S, () => null)?.collections ?? [],
    );
    expect({
      tagged: [await tagged(t, S), await tagged(t, await posted(t, `${LOCAL}/collections/${L}`))],
      presented: [await presented(LOCAL), await presented("http://kopje.test")],
      named,
    }).toEqual({ tagged: [[L], [L]], presented: [[l], [l]], named: [l] });
  });

  // #1589's D1 and D3: search with resolve=true finds a local collection by the uri and url the API returns, and by its
  // route on the instance's domain over http and https, before and after a domain change, for each local owner,
  // deciding by the collection's id and the instance's domain, never by the request's origin.
  it("finds a local collection by the uri and url the API returns and by its route, over http and after a domain change", async () => {
    const t = await setup();
    const L = await localCollection(t, ALICE, 1);
    const M = await localCollection(t, DAVE, 2);
    const dave = { headers: { authorization: `Bearer ${t.tokens.dave}` } };
    const found = async (origin: string, domain: string) =>
      Promise.all(
        [
          [L, "alice"],
          [M, "dave"],
        ].map(async ([id, username]) => {
          const shown = await (
            await through(t, `${origin}/api/v1/collections/${id}`, dave)
          ).json<{
            collection: { uri: string; url: string };
          }>();
          const route = `//${domain}/ap/users/${username}/collections/${id}`;
          return Promise.all(
            [shown.collection.uri, shown.collection.url, `http:${route}`, `https:${route}`].map(async (q) => {
              const path = `/api/v2/search?type=collections&resolve=true&q=${encodeURIComponent(q)}`;
              const body = await (await through(t, `${origin}${path}`, dave)).json<{ collections: { id: string }[] }>();
              return body.collections.map((c) => c.id);
            }),
          );
        }),
      );
    const each = [
      [[L], [L], [L], [L]],
      [[M], [M], [M], [M]],
    ];
    const fetchedBefore = t.web.fetched.length;
    expect(await found("http://kopje.test", "kopje.test")).toEqual(each);
    await setSetting(t.store, "domain", "other.test");
    expect(await found("https://other.test", "other.test")).toEqual(each);
    expect(t.web.fetched.slice(fetchedBefore)).toEqual([]);
  });

  // #1589's D1 and D3: a link, a tag or a search names a local collection by its id exactly as every surface emits it,
  // under its owner's stored actor id, or by its route on the instance's domain with its owner's username, as the route
  // takes it: with alice's actor id at /ap/users/old_alice, the old_alice id and the /ap/users/alice route are
  // referenced by a post and a remote Note and found by search, and the route under dave's username is not.
  it("names a local collection by its id as emitted, or by its route with its owner's username", async () => {
    const t = await setup();
    const L = await localCollection(t, ALICE, 1);
    const old = `${LOCAL}/ap/users/old_alice`;
    await sql(t.store, "UPDATE accounts SET uri = ? WHERE id = ?", old, ALICE);
    const exact = `${old}/collections/${L}`;
    const spelled = `${LOCAL}/ap/users/alice/collections/${L}`;
    const other = `${LOCAL}/ap/users/dave/collections/${L}`;
    const searched = async (q: string) =>
      (
        await t.api<{ collections: { id: string }[] }>(
          `/api/v2/search?type=collections&resolve=true&q=${encodeURIComponent(q)}`,
          "dave",
        )
      ).body.collections.map((c) => c.id);
    const bob = await mastodonActor(t.web, "bob");
    await followed(t, bob);
    const noted = async (id: string) => {
      const note = mastodonNote(bob, { tag: [{ type: "FeaturedCollection", id }] });
      expect(await t.post(bob, create(bob, note))).toBe(202);
      const [row] = await sql<{ id: string }>(t.store, "SELECT id FROM statuses WHERE uri = ?", note.id);
      return tagged(t, row!.id);
    };
    const each = [exact, spelled, other];
    const linked = [];
    const notedEach = [];
    const searchedEach = [];
    for (const q of each) {
      linked.push(await tagged(t, await posted(t, q)));
      notedEach.push(await noted(q));
      searchedEach.push(await searched(q));
    }
    expect({ linked, noted: notedEach, searched: searchedEach }).toEqual({
      linked: [[L], [L], []],
      noted: [[L], [L], []],
      searched: [[L], [L], []],
    });
  });

  // #1589's D1 and D3: one parser reads a local collection's address for its routes and for a lookup by URL
  // (platform/collection-address.ts), so a URL on the instance's domain names a collection exactly when its GET serves
  // it: the page by its id as the router decodes the path (`%31` is a 1), whatever the query, a short id naming no
  // stored one; the FeaturedCollection by its raw path (a percent-encoded digit is Fedify's 404) with a format the
  // route answers with (`?format=xml` is its 406) and a query it reads (`a=%FF`, not UTF-8, is its 400 whatever the
  // format). Each URL is fetched as ActivityPub (the collection served: its id's last segment) and searched for and
  // linked by a post, with alice's L and her collection O, whose id is 18 digits with leading zeros.
  it("names a local collection by a URL exactly when its GET serves it", async () => {
    const t = await setup();
    const L = await localCollection(t, ALICE, 1);
    const O = "000000000000000123";
    await sql(
      t.store,
      `INSERT INTO collections (id, account_id, local, name, sensitive, discoverable, created_at, updated_at)
			VALUES (?, ?, 1, 'zeros', 0, 1, ?, ?)`,
      O,
      ALICE,
      T,
      T,
    );
    const route = `${LOCAL}/ap/users/alice/collections`;
    const encoded = `${L.slice(0, -1)}%3${L.at(-1)}`;
    const spellings: [string, string | null][] = [
      [`${LOCAL}/collections/${L}`, L],
      [`${route}/${L}`, L],
      [`${LOCAL}/collections/${O}`, O],
      [`${LOCAL}/collections/123`, null],
      [`${route}/123`, null],
      [`${LOCAL}/collections/${encoded}`, L],
      [`${route}/${encoded}`, null],
      [`${LOCAL}/collections/${L}?from=profile`, L],
      [`${route}/${L}?from=profile`, L],
      [`${route}/${L}.json`, L],
      [`${route}/${L}?format=xml`, null],
      [`${route}/${L}?format=json&a=%FF`, null],
    ];
    const served = async (url: string) => {
      const response = await through(t, url, AP_GET);
      return response.status === 200 ? ((await response.json<{ id: string }>()).id.split("/").at(-1) ?? null) : null;
    };
    const searched = async (url: string) =>
      (
        await t.api<{ collections: { id: string }[] }>(
          `/api/v2/search?type=collections&resolve=true&q=${encodeURIComponent(url)}`,
          "dave",
        )
      ).body.collections.map((c) => c.id);
    const each = [];
    for (const [url] of spellings) {
      each.push({
        url,
        served: await served(url),
        searched: await searched(url),
        linked: await tagged(t, await posted(t, url)),
      });
    }
    expect(each).toEqual(
      spellings.map(([url, id]) => ({
        url,
        served: id,
        searched: id === null ? [] : [id],
        linked: id === null ? [] : [id],
      })),
    );
  });

  // #1589's D1 and D26, a URL resolved before it is filtered: alice's actor id kept on an earlier domain, L's id is
  // https://old.example/ap/users/alice/collections/<L>, which zed's collection R there is stored under too, and L's
  // restored name is malformed, so no status can tag L. A post linking that id and a Note tagging it reference nothing,
  // for the id names L, never R, as search finds L; with L gone, the id names R, which a post then references.
  it("tags nothing by a local collection's id when no status can tag it, whatever remote row shares the id", async () => {
    const t = await setup();
    const L = await localCollection(t, ALICE, 1);
    const old = "https://old.example/ap/users/alice";
    await sql(t.store, "UPDATE accounts SET uri = ? WHERE id = ?", old, ALICE);
    const id = `${old}/collections/${L}`;
    const R = await remoteCollection(t, await remoteOwner(t, 1, "https://old.example/users/zed"), 2, id);
    await sql(t.store, "UPDATE collections SET name = CAST(unhex('F09080') AS TEXT) WHERE id = ?", L);
    const bob = await mastodonActor(t.web, "bob");
    await followed(t, bob);
    const note = mastodonNote(bob, { tag: [{ type: "FeaturedCollection", id }] });
    expect(await t.post(bob, create(bob, note))).toBe(202);
    const [row] = await sql<{ id: string }>(t.store, "SELECT id FROM statuses WHERE uri = ?", note.id);
    const searched = await t.api<{ collections: { id: string }[] }>(
      `/api/v2/search?type=collections&resolve=true&q=${encodeURIComponent(id)}`,
      "dave",
    );
    const named = {
      linked: await tagged(t, await posted(t, id)),
      noted: await tagged(t, row!.id),
      searched: searched.body.collections.map((c) => c.id),
    };
    await sql(t.store, "DELETE FROM collections WHERE id = ?", L);
    expect({ ...named, gone: await tagged(t, await posted(t, id)) }).toEqual({
      linked: [],
      noted: [],
      searched: [L],
      gone: [R],
    });
  });

  // #1589's D2 and D4: a restored row of alice's, `local = 0` with an id on the instance's origin (validRemoteCollection
  // admits it: on its owner's origin), with dave's accepted item. Only a local collection is on that origin, so S's
  // reference to it is neither presented nor named, a link to its id references none, alice's listing holds her local
  // L alone, and dave's FeatureAuthorization of the item answers 404; L, beside it, is listed and tagged.
  it("neither lists nor tags a remote row whose id is on the instance's origin", async () => {
    const t = await setup();
    const L = await localCollection(t, ALICE, 1);
    const R = await remoteCollection(t, ALICE, 2, `${LOCAL}/ap/users/alice/collections/${collectionId(2)}`);
    await item(t.store, R, DAVE, 1, 1);
    const I = String(600000000000000000n + BigInt(items));
    const S = await posted(t, "S");
    for (const id of [L, R]) {
      await sql(t.store, "INSERT INTO status_collections VALUES (?, ?)", S, id);
    }
    const l = `${LOCAL}/ap/users/alice/collections/${L}`;
    const { body } = await t.api<Status>(`/api/v1/statuses/${S}`, "dave");
    const listing = await (
      await t.request("/ap/users/alice/featured_collections?page=1", AP_GET)
    ).json<{
      totalItems: number;
      items: { id: string }[];
    }>();
    expect({
      presented: body.tagged_collections.map(({ id }) => id),
      named: await noted(t, S),
      linked: await tagged(t, await posted(t, `${LOCAL}/ap/users/alice/collections/${R}`)),
      listed: [listing.totalItems, listing.items.map(({ id }) => id)],
      authorization: (await t.request(`/ap/users/dave/feature_authorizations/${I}`, AP_GET)).status,
    }).toEqual({ presented: [L], named: [l], linked: [], listed: [1, [l]], authorization: 404 });
  });

  // Four collections of x, then suspended, and then y's: a post linking the four and then y's, and a remote Note
  // tagging them in that order, give y's a slot, since the writer decides as the readers do (taggableCollections), with
  // no viewer: the four, which no surface shows anyone, take none.
  it("gives a post's slots only to collections whose owner is available, before it takes the first four", async () => {
    const t = await setup();
    const x = await remoteOwner(t, 1, `${MASTODON}/users/x`);
    const y = await remoteOwner(t, 2, `${MASTODON}/users/y`);
    const unavailable: string[] = [];
    for (let n = 1; n <= MAX_TAGGED_COLLECTIONS; n++) {
      unavailable.push(await remoteCollection(t, x, n, `${MASTODON}/users/x/collections/${n}`));
    }
    const Y = await remoteCollection(t, y, 9, `${MASTODON}/users/y/collections/9`);
    await sql(t.store, "UPDATE accounts SET suspended_at = ?, suspension_source = 'account' WHERE id = ?", T, x);
    const links = [
      ...unavailable.map((_, i) => `${MASTODON}/users/x/collections/${i + 1}`),
      `${MASTODON}/users/y/collections/9`,
    ];
    const S = await posted(t, ...links);
    expect(await tagged(t, S)).toEqual([Y]);
    const { body } = await t.api<Status>(`/api/v1/statuses/${S}`, "dave");
    expect(body.tagged_collections.map(({ id }) => id)).toEqual([Y]);
    expect(await noted(t, S)).toEqual([`${MASTODON}/users/y/collections/9`]);
  });

  // A remote collection whose restored name is F0 90 80, a sequence cut short that decodes to one U+FFFD of the same
  // three bytes, beside a well-formed one: a post linking both references the second alone, as the readers would show
  // it alone (the U+FFFD comparison of taggableCollections).
  it("gives no slot to a collection whose restored text is malformed", async () => {
    const t = await setup();
    const owner = await remoteOwner(t, 1, `${MASTODON}/users/x`);
    const M = await remoteCollection(t, owner, 1, `${MASTODON}/users/x/collections/1`);
    const W = await remoteCollection(t, owner, 2, `${MASTODON}/users/x/collections/2`);
    await sql(t.store, "UPDATE collections SET name = CAST(unhex('F09080') AS TEXT) WHERE id = ?", M);
    const S = await posted(t, `${MASTODON}/users/x/collections/1`, `${MASTODON}/users/x/collections/2`);
    expect({ malformed: M, tagged: await tagged(t, S) }).toEqual({ malformed: M, tagged: [W] });
  });

  it("lets S's Note name Y alone, by its id", async () => {
    const { t, S, uriOf } = await restored();
    const [row] = await sql<{ uri: string }>(t.store, "SELECT uri FROM statuses WHERE id = ?", S);
    const note = await (await t.request(pathOf(row!.uri), AP_GET)).json<{ tag: Record<string, unknown>[] }>();
    expect(note.tag.filter((tag) => tag.type === "FeaturedCollection")).toEqual([
      { type: "FeaturedCollection", id: uriOf.Y },
    ]);
  });

  // U's owner deleted, V's available: S's Note names V alone (collectionFoundSql), as the API presents it.
  it("lets a Note name no collection whose owner is unavailable", async () => {
    const t = await setup();
    const gone = await remoteOwner(t, 1, `${MASTODON}/users/x`);
    const U = await remoteCollection(t, gone, 1, `${MASTODON}/users/x/collections/1`);
    const owner = await remoteOwner(t, 2, `https://m.example/users/z`);
    const V = await remoteCollection(t, owner, 2, `https://m.example/users/z/collections/2`);
    const S = await posted(t, "S");
    for (const id of [U, V]) {
      await sql(t.store, "INSERT INTO status_collections VALUES (?, ?)", S, id);
    }
    await sql(t.store, "UPDATE accounts SET deleted_at = ? WHERE id = ?", new Date(NOW).toISOString(), gone);
    const [row] = await sql<{ uri: string }>(t.store, "SELECT uri FROM statuses WHERE id = ?", S);
    const note = await (await t.request(pathOf(row!.uri), AP_GET)).json<{ tag: Record<string, unknown>[] }>();
    expect(note.tag.filter((tag) => tag.type === "FeaturedCollection")).toEqual([
      { type: "FeaturedCollection", id: `https://m.example/users/z/collections/2` },
    ]);
  });

  // W's owner holds a restored actor id of 8,192 bytes on W's origin, past ACTOR_URI_LIMIT, which accounts.uri admits and
  // every read takes as '' (actorUriSql): W is not valid, so the API and the Note leave out S's reference to it, and a
  // link to its id or to its web page references nothing. V, beside it, is shown.
  it("leaves out a collection whose owner's id is past ACTOR_URI_LIMIT, and references none", async () => {
    const t = await setup();
    const M = "https://m.example";
    const long = await remoteOwner(t, 1, `${M}/users/w/`.padEnd(8_192, "a"));
    const W = await remoteCollection(t, long, 1, `${M}/users/w/collections/1`, `${M}/collections/1`);
    const owner = await remoteOwner(t, 2, `${MASTODON}/users/x`);
    const V = await remoteCollection(t, owner, 2, `${MASTODON}/users/x/collections/2`);
    const S = await posted(t, "S");
    for (const id of [W, V]) {
      await sql(t.store, "INSERT INTO status_collections VALUES (?, ?)", S, id);
    }
    const { body } = await t.api<Status>(`/api/v1/statuses/${S}`, "dave");
    expect(body.tagged_collections.map(({ id }) => id)).toEqual([V]);
    const [row] = await sql<{ uri: string }>(t.store, "SELECT uri FROM statuses WHERE id = ?", S);
    const note = await (await t.request(pathOf(row!.uri), AP_GET)).json<{ tag: Record<string, unknown>[] }>();
    expect(note.tag.filter((tag) => tag.type === "FeaturedCollection")).toEqual([
      { type: "FeaturedCollection", id: `${MASTODON}/users/x/collections/2` },
    ]);
    expect(await tagged(t, await posted(t, `${M}/users/w/collections/1`))).toEqual([]);
    expect(await tagged(t, await posted(t, `${M}/collections/1`))).toEqual([]);
  });

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
