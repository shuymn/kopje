import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { ANSWER_BYTES, jsonBytes } from "../src/domain/answer-budget";
import type { Collection, CollectionItem } from "../src/domain/collection-presenter";
import {
  COLLECTION_JSON_MAX,
  LOCAL_COLLECTION_JSON_MAX,
  pruneCollectionItems,
  RETIRED_ROWS_PER_ROUND,
  showCollection,
} from "../src/domain/collections";
import { ACTOR_URI_LIMIT } from "../src/domain/profile-bounds";
import { MAX_TAG_LENGTH, TAG_NAME_BYTES } from "../src/domain/status-bounds";
import { TREND_LANGUAGES } from "../src/domain/trend-languages";
import { handleScheduled } from "../src/jobs/scheduled";
import {
  COLLECTION_DESCRIPTION_LENGTH,
  COLLECTION_NAME_LENGTH,
  COLLECTION_URI_BYTES,
  COLLECTION_URL_BYTES,
  LOCAL_USERNAME_BYTES,
} from "../src/platform/stored-bounds";
import { type ApiHarness, bearer, seedAccount, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { BUILD } from "./helpers";
import { CONSERVATIVE_JSON } from "./presented-maxima";
import { block, community, remoteAccount, type User } from "./status-helpers";

// Collections (src/domain/collections.ts, src/mastodon/collections.ts): the routes, their errors and paging, R45 and
// the stored bounds, as Mastodon 4.7.5 answers them (design §6, PR 1).

const T = "2026-10-11T00:00:00.000Z";
const DEPRECATION = "@1781049600";
const PREFIXES = ["/api/v1", "/api/v1_alpha"] as const;

// The members of an answer the tests read: each route's own, and an error's.
type Body = {
  collection: Collection;
  collections: Collection[];
  accounts: { id: string }[];
  collection_item: CollectionItem;
  error: { details: Record<string, unknown> } & Record<string, unknown>;
};
type Answer = { status: number; body: Body; text: string; headers: Headers };

async function call(h: ApiHarness, method: string, path: string, token?: string, body?: unknown): Promise<Answer> {
  const init: RequestInit = {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  };
  const response = await h.request(path, token === undefined ? init : bearer(token, init));
  const text = await response.text();
  return {
    status: response.status,
    body: (text === "" ? null : JSON.parse(text)) as Body,
    text,
    headers: response.headers,
  };
}

const discoverable = (h: ApiHarness, ...ids: string[]) =>
  sql(
    h.store,
    "UPDATE accounts SET discoverable = 1 WHERE id IN (SELECT value FROM json_each(?))",
    JSON.stringify(ids),
  );

// Accounts that may be featured: local, discoverable, unlocked.
async function members(h: ApiHarness, count: number, prefix = "m"): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    ids.push(await seedAccount(h.store, { username: `${prefix}${i}` }));
  }
  await discoverable(h, ...ids);
  return ids;
}

async function world() {
  const h = await community(["alice", "bob", "carol"]);
  const { alice, bob, carol } = h.users;
  await discoverable(h, alice.id, bob.id, carol.id);
  return { h, alice, bob, carol };
}

const VALID = { name: "c", sensitive: false, discoverable: true };

async function create(h: ApiHarness, user: User, body: Record<string, unknown> = {}, prefix = "/api/v1") {
  return call(h, "POST", `${prefix}/collections`, user.token, { ...VALID, ...body });
}

async function created(h: ApiHarness, user: User, body: Record<string, unknown> = {}): Promise<Collection> {
  const answer = await create(h, user, body);
  expect(answer.status, answer.text).toBe(200);
  return answer.body.collection;
}

const count = async (h: ApiHarness, table: string) =>
  (await sql<{ n: number }>(h.store, `SELECT count(*) AS n FROM ${table}`))[0]?.n ?? 0;

const nested = (problems: [string, string, string][]) =>
  JSON.stringify({
    error: {
      error: `Validation failed: ${problems.map(([attribute, , description]) => (attribute === "base" ? description : `${attribute.charAt(0).toUpperCase()}${attribute.slice(1).replaceAll("_", " ")} ${description}`)).join(", ")}`,
      details: Object.fromEntries(
        [...new Set(problems.map(([attribute]) => attribute))].map((attribute) => [
          attribute,
          problems.filter(([a]) => a === attribute).map(([, error, description]) => ({ error, description })),
        ]),
      ),
    },
  });

// A collection of `owner` written directly (a remote owner's with a URI), and items of it.
const collectionId = (n: number) => String(500000000000000000n + BigInt(n));
const itemId = (n: number) => String(600000000000000000n + BigInt(n));

async function seedCollection(h: ApiHarness, owner: string, n: number, fields: Record<string, unknown> = {}) {
  const local = (await sql(h.store, "SELECT 1 FROM local_accounts WHERE account_id = ?", owner)).length;
  const row = {
    id: collectionId(n),
    account_id: owner,
    local,
    name: `c${n}`,
    sensitive: 0,
    discoverable: 1,
    uri: local === 1 ? null : `https://remote.example/c/${n}`,
    created_at: new Date(Date.parse(T) + n).toISOString(),
    updated_at: T,
    ...fields,
  };
  const keys = Object.keys(row);
  await sql(
    h.store,
    `INSERT INTO collections (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
    ...(Object.values(row) as SqlStorageValue[]),
  );
  return row.id;
}

async function seedItem(h: ApiHarness, collection: string, n: number, fields: Record<string, unknown> = {}) {
  const row = {
    id: itemId(n),
    collection_id: collection,
    account_id: null,
    object_uri: `https://remote.example/u/${n}`,
    state: 0,
    position: 1,
    created_at: T,
    updated_at: T,
    ...fields,
  };
  const keys = Object.keys(row);
  await sql(
    h.store,
    `INSERT INTO collection_items (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
    ...(Object.values(row) as SqlStorageValue[]),
  );
  return row.id;
}

// `count` remote collections of `owner` from number `from`, each with one item of `member` (or an unresolved one) in
// `state`, written in two statements.
async function seedMany(
  h: ApiHarness,
  owner: string,
  from: number,
  count: number,
  item: { member?: string | null; state?: number; updated_at?: string; per?: number } = {},
) {
  const per = item.per ?? 1;
  await sql(
    h.store,
    `WITH RECURSIVE n(i) AS (SELECT CAST(?2 AS INTEGER) UNION ALL SELECT i + 1 FROM n WHERE i < ?2 + ?3 - 1)
		INSERT INTO collections (id, account_id, local, name, sensitive, discoverable, uri, created_at, updated_at)
		SELECT printf('%d', 500000000000000000 + i), ?1,
			(SELECT count(*) FROM local_accounts WHERE account_id = ?1), 'c' || i, 0, 1,
			CASE WHEN EXISTS (SELECT 1 FROM local_accounts WHERE account_id = ?1) THEN NULL
				ELSE 'https://remote.example/c/' || i END,
			strftime('%Y-%m-%dT%H:%M:%fZ', ?4, '+' || i || ' seconds'), ?4
		FROM n`,
    owner,
    from,
    count,
    T,
  );
  await sql(
    h.store,
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?2 * ?6 - 1),
			k(i, item, collection) AS (SELECT i, CAST(?1 AS INTEGER) * CAST(?6 AS INTEGER) + i,
				CAST(?1 AS INTEGER) + i / CAST(?6 AS INTEGER) FROM n)
		INSERT INTO collection_items (id, collection_id, account_id, object_uri, state, position, created_at, updated_at)
		SELECT printf('%d', 600000000000000000 + item), printf('%d', 500000000000000000 + collection), ?3,
			CASE WHEN ?3 IS NULL THEN 'https://remote.example/u/' || item END, ?4, 1, ?5, ?5
		FROM k`,
    from,
    count,
    item.member ?? null,
    item.state ?? 1,
    item.updated_at ?? T,
    per,
  );
}

describe("collections: routes", () => {
  it("serves the 20 routes in Mastodon's shapes, the alpha collections and items routes deprecated", async () => {
    const { h, alice, bob, carol } = await world();
    for (const prefix of PREFIXES) {
      const deprecated = prefix === "/api/v1_alpha" ? DEPRECATION : null;
      const seen: [string, Answer, string | null][] = [];
      const made = await create(h, alice, { account_ids: [bob.id] }, prefix);
      seen.push(["create", made, deprecated]);
      expect(Object.keys(made.body)).toEqual(["collection"]);
      const id = made.body.collection.id;
      const bobItem = made.body.collection.items[0]!.id;
      const listed = await call(h, "GET", `${prefix}/accounts/${alice.id}/collections`);
      seen.push(["list", listed, deprecated]);
      expect(listed.body.collections.map((c: { id: string }) => c.id)).toContain(id);
      const shown = await call(h, "GET", `${prefix}/collections/${id}`, bob.token);
      seen.push(["show", shown, deprecated]);
      expect(Object.keys(shown.body)).toEqual(["collection", "accounts"]);
      expect(shown.body.accounts.map((a: { id: string }) => a.id)).toEqual([alice.id, bob.id]);
      for (const method of ["PATCH", "PUT"]) {
        const updated = await call(h, method, `${prefix}/collections/${id}`, alice.token, { name: method });
        seen.push([method, updated, deprecated]);
        expect(updated.body.collection.name).toBe(method);
      }
      const added = await call(h, "POST", `${prefix}/collections/${id}/items`, alice.token, { account_id: carol.id });
      seen.push(["add", added, deprecated]);
      expect(Object.keys(added.body)).toEqual(["collection_item"]);
      expect(added.body.collection_item).toEqual({
        id: expect.any(String),
        state: "accepted",
        created_at: new Date(NOW).toISOString(),
        account_id: carol.id,
      });
      const inCollections = await call(h, "GET", `${prefix}/accounts/${carol.id}/in_collections`, carol.token);
      seen.push(["in_collections", inCollections, null]);
      expect(inCollections.body.collections.map((c: { id: string }) => c.id)).toContain(id);
      // No user: require_user!'s 422; another account: 403; neither deprecated.
      const anonymous = await call(h, "GET", `${prefix}/accounts/${carol.id}/in_collections`);
      expect([anonymous.status, anonymous.body]).toEqual([
        422,
        { error: "This method requires an authenticated user" },
      ]);
      seen.push(["in_collections without a user", anonymous, null]);
      const other = await call(h, "GET", `${prefix}/accounts/${carol.id}/in_collections`, alice.token);
      expect([other.status, other.body]).toEqual([403, { error: "This action is not allowed" }]);
      seen.push(["another's in_collections", other, null]);
      const revoked = await call(
        h,
        "POST",
        `${prefix}/collections/${id}/items/${added.body.collection_item.id}/revoke`,
        carol.token,
      );
      seen.push(["revoke", revoked, deprecated]);
      const removed = await call(h, "DELETE", `${prefix}/collections/${id}/items/${bobItem}`, alice.token);
      seen.push(["remove", removed, deprecated]);
      // The header is on error answers too: it is set before the token is read.
      const refused = await call(h, "DELETE", `${prefix}/collections/${id}`, "not-a-token");
      expect(refused.status).toBe(401);
      seen.push(["401", refused, deprecated]);
      const deleted = await call(h, "DELETE", `${prefix}/collections/${id}`, alice.token);
      seen.push(["delete", deleted, deprecated]);
      for (const [name, answer] of [
        ["revoke", revoked],
        ["remove", removed],
        ["delete", deleted],
      ] as const) {
        expect([name, answer.status, answer.text]).toEqual([name, 200, ""]);
      }
      expect(seen.map(([name, answer]) => [name, answer.headers.get("deprecation")])).toEqual(
        seen.map(([name, , header]) => [name, header]),
      );
      expect(await count(h, "collections")).toBe(0);
    }
  });

  // WEB-7: CollectionsController#index and #show, and InCollectionsController#index, run cache_if_unauthenticated!
  // (Mastodon 4.7.5): a 2xx without Authorization is public for 15 s; with one, an error, or a write, private; each
  // varies by Authorization.
  it("caches the anonymous reads as Mastodon's index and show, and nothing else", async () => {
    const { h, alice, bob } = await world();
    const PUBLIC = "max-age=15, public, stale-while-revalidate=30, stale-if-error=86400";
    const PRIVATE = "private, no-store";
    for (const prefix of PREFIXES) {
      const made = await create(h, alice, { account_ids: [bob.id] }, prefix);
      const id = made.body.collection.id;
      const missing = "900000000000000000";
      const seen: [string, Answer][] = [
        ["create", made],
        ["show", await call(h, "GET", `${prefix}/collections/${id}`)],
        ["list", await call(h, "GET", `${prefix}/accounts/${alice.id}/collections`)],
        ["show, signed in", await call(h, "GET", `${prefix}/collections/${id}`, bob.token)],
        ["list, signed in", await call(h, "GET", `${prefix}/accounts/${alice.id}/collections`, bob.token)],
        ["show, not found", await call(h, "GET", `${prefix}/collections/${missing}`)],
        ["in_collections, no user", await call(h, "GET", `${prefix}/accounts/${bob.id}/in_collections`)],
        ["in_collections", await call(h, "GET", `${prefix}/accounts/${bob.id}/in_collections`, bob.token)],
        ["update", await call(h, "PATCH", `${prefix}/collections/${id}`, alice.token, { name: "n" })],
      ];
      expect(seen.map(([name, answer]) => [name, answer.status, answer.headers.get("cache-control")])).toEqual([
        ["create", 200, PRIVATE],
        ["show", 200, PUBLIC],
        ["list", 200, PUBLIC],
        ["show, signed in", 200, PRIVATE],
        ["list, signed in", 200, PRIVATE],
        ["show, not found", 404, PRIVATE],
        ["in_collections, no user", 422, PRIVATE],
        ["in_collections", 200, PRIVATE],
        ["update", 200, PRIVATE],
      ]);
      expect(seen.map(([name, answer]) => [name, answer.headers.get("vary")])).toEqual(
        seen.map(([name]) => [name, "Authorization"]),
      );
    }
  });

  it("presents a collection as REST::CollectionSerializer, its tag shallow", async () => {
    const { h, alice, bob } = await world();
    const collection = await created(h, alice, {
      name: "Picks",
      description: "Who to follow",
      language: "en",
      sensitive: true,
      discoverable: false,
      tag_name: "#Café",
      account_ids: [bob.id],
    });
    expect(collection).toEqual({
      id: collection.id,
      uri: `https://kopje.test/ap/users/alice/collections/${collection.id}`,
      name: "Picks",
      description: "Who to follow",
      language: "en",
      account_id: alice.id,
      local: true,
      sensitive: true,
      discoverable: false,
      url: `https://kopje.test/collections/${collection.id}`,
      item_count: 1,
      created_at: new Date(NOW).toISOString(),
      updated_at: new Date(NOW).toISOString(),
      tag: { name: "cafe", url: "https://kopje.test/tags/cafe" },
      items: [
        { id: collection.items[0]!.id, state: "accepted", created_at: new Date(NOW).toISOString(), account_id: bob.id },
      ],
    });
    expect(Object.keys(collection)).toEqual([
      "id",
      "uri",
      "name",
      "description",
      "language",
      "account_id",
      "local",
      "sensitive",
      "discoverable",
      "url",
      "item_count",
      "created_at",
      "updated_at",
      "tag",
      "items",
    ]);
  });
});

describe("collections: validation", () => {
  it("answers the collection's validations nested, with Mastodon's codes, lengths in characters", async () => {
    const { h, alice } = await world();
    const cases: [Record<string, unknown>, [string, string, string][]][] = [
      [{ name: "" }, [["name", "ERR_BLANK", "can't be blank"]]],
      [{ name: "  " }, [["name", "ERR_BLANK", "can't be blank"]]],
      // Rails' blank? is Unicode whitespace: an ideographic space is blank.
      [{ name: "　" }, [["name", "ERR_BLANK", "can't be blank"]]],
      [{ name: "a".repeat(41) }, [["name", "ERR_TOO_LONG", "is too long (maximum is 40 characters)"]]],
      [{ description: "a".repeat(101) }, [["description", "ERR_TOO_LONG", "is too long (maximum is 100 characters)"]]],
      [{ language: "" }, [["language", "ERR_INVALID", "is invalid"]]],
      [{ language: "xx" }, [["language", "ERR_INVALID", "is invalid"]]],
      [{ sensitive: undefined }, [["sensitive", "ERR_INCLUSION", "is not included in the list"]]],
      [{ discoverable: null }, [["discoverable", "ERR_INCLUSION", "is not included in the list"]]],
      // Tag.find_or_create_by_names: the Tag's own errors.
      [
        { tag_name: "#" },
        [
          ["name", "ERR_BLANK", "can't be blank"],
          ["name", "ERR_INVALID", "is invalid"],
          ["display_name", "ERR_INVALID", "is invalid"],
        ],
      ],
      // Every problem at once, in Mastodon's order.
      [
        { name: "", description: "a".repeat(101), sensitive: undefined, language: "xx" },
        [
          ["name", "ERR_BLANK", "can't be blank"],
          ["description", "ERR_TOO_LONG", "is too long (maximum is 100 characters)"],
          ["sensitive", "ERR_INCLUSION", "is not included in the list"],
          ["language", "ERR_INVALID", "is invalid"],
        ],
      ],
    ];
    for (const [body, problems] of cases) {
      const answer = await create(h, alice, body);
      expect([JSON.stringify(body), answer.status, answer.text]).toEqual([JSON.stringify(body), 422, nested(problems)]);
    }
    expect(await count(h, "collections")).toBe(0);
    // 40 and 100 characters of four bytes each, stored and presented whole.
    const full = await created(h, alice, { name: "😀".repeat(40), description: "😀".repeat(100) });
    expect([full.name, full.description]).toEqual(["😀".repeat(40), "😀".repeat(100)]);
    // description: JSON null is nil, "" stays ""; language: null is nil.
    expect((await created(h, alice, { description: null, language: null })).description).toBeNull();
    expect((await created(h, alice, { description: "" })).description).toBe("");
  });

  // Rails' params[name]: the query's value replaces the body's null, so a blank one is "" (not nil) and validated so.
  it("reads a field the query sends over the body's JSON null, as Rails merges them", async () => {
    const { h, alice } = await world();
    const withQuery = (query: string, body: Record<string, unknown>) =>
      call(h, "POST", `/api/v1/collections?${query}`, alice.token, { ...VALID, ...body });
    const blankLanguage = await withQuery("language=", { language: null });
    expect([blankLanguage.status, blankLanguage.text]).toEqual([
      422,
      nested([["language", "ERR_INVALID", "is invalid"]]),
    ]);
    const blankTag = await withQuery("tag_name=", { tag_name: null });
    expect([blankTag.status, blankTag.body.error.details]).toEqual([
      422,
      {
        name: [
          { error: "ERR_BLANK", description: "can't be blank" },
          { error: "ERR_INVALID", description: "is invalid" },
        ],
        display_name: [{ error: "ERR_INVALID", description: "is invalid" }],
      },
    ]);
    const blankName = await withQuery("name=", { name: null });
    expect([blankName.status, blankName.text]).toEqual([422, nested([["name", "ERR_BLANK", "can't be blank"]])]);
    const blankDescription = await withQuery("description=", { description: null });
    expect([blankDescription.status, blankDescription.body.collection.description]).toEqual([200, ""]);
    expect((await withQuery("language=xx", { language: null })).text).toBe(
      nested([["language", "ERR_INVALID", "is invalid"]]),
    );
    // Without the query, each null is nil: accepted.
    const nulls = await withQuery("", { description: null, language: null, tag_name: null });
    expect([nulls.status, nulls.body.collection.description, nulls.body.collection.tag]).toEqual([200, null, null]);
  });

  it("changes on update only what is sent, a JSON null tag clearing it and a blank one refused", async () => {
    const { h, alice, bob } = await world();
    const collection = await created(h, alice, { tag_name: "kopje", description: "d" });
    const path = `/api/v1/collections/${collection.id}`;
    h.now.mockReturnValue(NOW + 1000);
    const renamed = await call(h, "PATCH", path, alice.token, { name: "renamed" });
    expect(renamed.body.collection).toMatchObject({
      name: "renamed",
      description: "d",
      tag: { name: "kopje" },
      updated_at: new Date(NOW + 1000).toISOString(),
    });
    // Nothing changed: updated_at stays.
    h.now.mockReturnValue(NOW + 2000);
    expect((await call(h, "PUT", path, alice.token, { name: "renamed" })).body.collection.updated_at).toBe(
      new Date(NOW + 1000).toISOString(),
    );
    expect((await call(h, "PATCH", path, alice.token, { tag_name: null })).body.collection.tag).toBeNull();
    const blankTag = await call(h, "PATCH", path, alice.token, { tag_name: "" });
    expect(blankTag.status).toBe(422);
    expect(blankTag.body.error.details).toEqual({
      name: [
        { error: "ERR_BLANK", description: "can't be blank" },
        { error: "ERR_INVALID", description: "is invalid" },
      ],
      display_name: [{ error: "ERR_INVALID", description: "is invalid" }],
    });
    // A boolean sent blank is nil, which the inclusion refuses.
    const form = await h.request(
      path,
      bearer(alice.token, {
        method: "PATCH",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "sensitive=",
      }),
    );
    expect([form.status, await form.text()]).toEqual([
      422,
      nested([["sensitive", "ERR_INCLUSION", "is not included in the list"]]),
    ]);
    // Only the owner: 403; an unknown id: 404.
    expect((await call(h, "PATCH", path, bob.token, { name: "x" })).status).toBe(403);
    expect((await call(h, "DELETE", path, bob.token)).status).toBe(403);
    expect((await call(h, "PATCH", "/api/v1/collections/1", alice.token, { name: "x" })).body).toEqual({
      error: "Record not found",
    });
  });

  it("refuses an 11th collection with Mastodon's base problem, unprefixed", async () => {
    const { h, alice } = await world();
    for (let i = 0; i < 10; i++) {
      await created(h, alice);
    }
    const eleventh = await create(h, alice);
    expect([eleventh.status, eleventh.text]).toEqual([
      422,
      '{"error":{"error":"Validation failed: Collections are too many, no more than 10 are allowed","details":{"base":[{"error":"ERR_TOO_MANY","description":"Collections are too many, no more than 10 are allowed"}]}}}',
    ]);
    expect(await count(h, "collections")).toBe(10);
  });

  it("refuses a 26th live item on create and on add, and resolves a create's accounts in Mastodon's order", async () => {
    const { h, alice, bob, carol } = await world();
    const ids = await members(h, 26);
    const tooMany = await create(h, alice, { account_ids: ids });
    expect([tooMany.status, tooMany.text]).toEqual([
      422,
      nested([["collection_items", "ERR_TOO_MANY", "are too many, no more than 25 are allowed"]]),
    ]);
    // Past 25 distinct ids nothing is resolved: 27 unknown ids answer the same 422, not 404.
    const unknown = Array.from({ length: 27 }, (_, i) => String(900000000000000000n + BigInt(i)));
    expect((await create(h, alice, { account_ids: unknown })).status).toBe(422);
    expect(await count(h, "collections")).toBe(0);
    // 25 with duplicates.
    const full = await created(h, alice, { account_ids: [...ids.slice(0, 25), ids[0], ids[1]] });
    expect(full.item_count).toBe(25);
    expect(full.items.map((item) => item.account_id)).toEqual(ids.slice(0, 25));
    const add = await call(h, "POST", `/api/v1/collections/${full.id}/items`, alice.token, { account_id: ids[25] });
    expect([add.status, add.text]).toEqual([
      422,
      '{"error":"Validation failed: Collection items are too many, no more than 25 are allowed"}',
    ]);
    expect(await count(h, "collection_items")).toBe(25);
    // A pending item counts as live (an imported one: these routes write none yet): 24 accepted and 1 pending refuse
    // the add the same way.
    await sql(
      h.store,
      "UPDATE collection_items SET state = 0 WHERE collection_id = ? AND account_id = ?",
      full.id,
      ids[0]!,
    );
    const pending = await call(h, "POST", `/api/v1/collections/${full.id}/items`, alice.token, { account_id: ids[25] });
    expect([pending.status, pending.text]).toEqual([add.status, add.text]);
    expect(await count(h, "collection_items")).toBe(25);
    // Precedence, each against the next: an unknown account before the validations, the tag before consent, consent
    // before the validations.
    await sql(h.store, "UPDATE accounts SET discoverable = 0 WHERE id = ?", carol.id);
    expect((await create(h, alice, { name: "", account_ids: ["900000000000000000"] })).body).toEqual({
      error: "Record not found",
    });
    const tag = await create(h, alice, { tag_name: "#", account_ids: [carol.id] });
    expect([tag.status, Object.keys(tag.body.error.details)]).toEqual([422, ["name", "display_name"]]);
    expect(await create(h, alice, { name: "", account_ids: [carol.id] })).toMatchObject({
      status: 403,
      body: { error: "This action is not allowed" },
    });
    expect((await create(h, alice, { name: "", account_ids: [bob.id] })).text).toBe(
      nested([["name", "ERR_BLANK", "can't be blank"]]),
    );
    expect(await count(h, "collections")).toBe(1);
  });

  it("refuses an account twice in one collection, in any state, and a blank account_id after the collection", async () => {
    const { h, alice, bob } = await world();
    const collection = await created(h, alice, { account_ids: [bob.id] });
    const path = `/api/v1/collections/${collection.id}/items`;
    const again = await call(h, "POST", path, alice.token, { account_id: bob.id });
    expect([again.status, again.text]).toEqual([422, '{"error":"Validation failed: Account has already been taken"}']);
    await sql(h.store, "UPDATE collection_items SET state = 3");
    expect((await call(h, "POST", path, alice.token, { account_id: bob.id })).status).toBe(422);
    expect(await call(h, "POST", path, alice.token, {})).toMatchObject({
      status: 422,
      body: { error: "`account_id` parameter is missing" },
    });
    // The collection first: an unknown one is not found whatever the account.
    expect((await call(h, "POST", "/api/v1/collections/1/items", alice.token, {})).status).toBe(404);
    expect((await call(h, "POST", path, alice.token, { account_id: "1" })).status).toBe(404);
    expect((await call(h, "POST", path, bob.token, { account_id: alice.id })).status).toBe(403);
  });
});

describe("collections: stored items", () => {
  it("evicts the oldest retired item when an add meets the stored bound", async () => {
    const { h, alice, bob } = await world();
    const collection = (await created(h, alice)).id;
    for (let i = 0; i < 24; i++) {
      await seedItem(h, collection, i);
    }
    for (let i = 24; i < 50; i++) {
      await seedItem(h, collection, i, {
        state: i % 2 === 0 ? 2 : 3,
        updated_at: new Date(Date.parse(T) + (74 - i) * 1000).toISOString(),
      });
    }
    // The oldest retired item is the last written.
    const added = await call(h, "POST", `/api/v1/collections/${collection}/items`, alice.token, { account_id: bob.id });
    expect(added.status, added.text).toBe(200);
    const left = await sql<{ live: number; retired: number; oldest: number }>(
      h.store,
      `SELECT count(*) FILTER (WHERE state IN (0, 1)) AS live, count(*) FILTER (WHERE state IN (2, 3)) AS retired,
				count(*) FILTER (WHERE id = ?) AS oldest FROM collection_items`,
      itemId(49),
    );
    expect(left).toEqual([{ live: 25, retired: 25, oldest: 0 }]);
    // Positions after every other.
    expect(added.body.collection_item.account_id).toBe(bob.id);
    expect(await sql(h.store, "SELECT position FROM collection_items WHERE account_id = ?", bob.id)).toEqual([
      { position: 2 },
    ]);
  });

  it("deletes retired items a day old, RETIRED_ROWS_PER_ROUND a round, keeping younger and live ones", async () => {
    const { h, alice } = await world();
    const old = new Date(NOW - 24 * 60 * 60 * 1000 - 1).toISOString();
    const young = new Date(NOW - 24 * 60 * 60 * 1000 + 1).toISOString();
    // 11 collections of 48 items: 46 retired a day ago, one retired since, one live.
    await seedMany(h, alice.id, 0, 11, { state: 2, updated_at: old, per: 48 });
    await sql(h.store, "UPDATE collection_items SET state = 3 WHERE CAST(id AS INTEGER) % 2 = 1");
    await sql(
      h.store,
      "UPDATE collection_items SET state = 3, updated_at = ? WHERE CAST(id AS INTEGER) % 48 = 46",
      young,
    );
    await sql(h.store, "UPDATE collection_items SET state = 0 WHERE CAST(id AS INTEGER) % 48 = 47");
    const prune = () =>
      runInDurableObject(h.store, (_instance, state) =>
        state.storage.transactionSync(() =>
          pruneCollectionItems.run(state.storage.sql, { now: NOW }, (fn) => state.storage.transactionSync(fn)),
        ),
      );
    expect(await prune()).toEqual({ deleted: RETIRED_ROWS_PER_ROUND });
    expect(await prune()).toEqual({ deleted: 11 * 46 - RETIRED_ROWS_PER_ROUND });
    expect(await prune()).toEqual({ deleted: 0 });
    expect(
      await sql(h.store, "SELECT state, count(*) AS n FROM collection_items GROUP BY state ORDER BY state"),
    ).toEqual([
      { state: 0, n: 11 },
      { state: 3, n: 11 },
    ]);
  });

  it("runs the cleanup from the 5-minute cron, waiting out the Store's maintenance", async () => {
    const { h, alice } = await world();
    await seedMany(h, alice.id, 0, 1, { state: 3, updated_at: new Date(NOW - 25 * 60 * 60 * 1000).toISOString() });
    const run = () =>
      handleScheduled({ ...h.env, MAINTENANCE: "off" } as unknown as Env, {
        build: () => BUILD,
        now: () => NOW,
        store: () => h.store,
      });
    expect(await h.store.setMaintenance(BUILD, true)).toMatchObject({ maintenance: true });
    await run();
    expect(await count(h, "collection_items")).toBe(1);
    expect(await h.store.setMaintenance(BUILD, false)).toMatchObject({ maintenance: false });
    await run();
    expect(await count(h, "collection_items")).toBe(0);
  });

  it("serializes two adds racing for the last live slot: one succeeds", async () => {
    const { h, alice, bob, carol } = await world();
    const ids = await members(h, 24);
    const collection = (await created(h, alice, { account_ids: ids })).id;
    const add = (user: User) =>
      call(h, "POST", `/api/v1/collections/${collection}/items`, alice.token, { account_id: user.id });
    const answers = await Promise.all([add(bob), add(carol)]);
    expect(answers.map((a) => a.status).toSorted((a, b) => a - b)).toEqual([200, 422]);
    expect(await count(h, "collection_items")).toBe(25);
  });
});

describe("collections: paging", () => {
  it("pages an account's collections by offset, linking at /api/v1 while a page is full", async () => {
    const { h, alice, bob } = await world();
    for (let i = 0; i < 12; i++) {
      await seedCollection(h, alice.id, i);
    }
    const page = async (query: string, prefix = "/api/v1") => {
      const answer = await call(h, "GET", `${prefix}/accounts/${alice.id}/collections${query}`, bob.token);
      expect(answer.status).toBe(200);
      return {
        ids: answer.body.collections.map((c: { id: string }) => Number(BigInt(c.id) - 500000000000000000n)),
        link: answer.headers.get("link"),
      };
    };
    const at = (query: string) => `https://kopje.test/api/v1/accounts/${alice.id}/collections?${query}`;
    expect(await page("?limit=5", "/api/v1_alpha")).toEqual({
      ids: [11, 10, 9, 8, 7],
      link: `<${at("limit=5&offset=5")}>; rel="next"`,
    });
    expect(await page("?limit=5&offset=5")).toEqual({
      ids: [6, 5, 4, 3, 2],
      link: `<${at("limit=5&offset=10")}>; rel="next", <${at("limit=5&offset=0")}>; rel="prev"`,
    });
    expect(await page("?limit=5&offset=10")).toEqual({ ids: [1, 0], link: `<${at("limit=5&offset=5")}>; rel="prev"` });
    expect((await page("?limit=-5")).ids).toHaveLength(5);
    expect((await page("?limit=500")).ids).toHaveLength(12);
    expect(await page("")).toEqual({ ids: [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0], link: null });
    // A limit sent without a value (nil) is the default, and the links carry none.
    expect(await page("?limit&offset=5")).toEqual({
      ids: [6, 5, 4, 3, 2, 1, 0],
      link: `<${at("offset=0")}>; rel="prev"`,
    });
    for (const limit of ["0", "", "abc"]) {
      expect(await page(`?limit=${limit}`)).toEqual({ ids: [], link: null });
    }
    for (const offset of ["abc", "-3"]) {
      expect((await page(`?limit=5&offset=${offset}`)).ids).toEqual([11, 10, 9, 8, 7]);
    }
    expect(await page("?offset=99999999999999999999")).toEqual({
      ids: [],
      link: expect.stringContaining('rel="prev"'),
    });
  });

  it("pages in_collections through a bounded window, linking past memberships it hides", async () => {
    const h = await community(["carol"]);
    const { carol } = h.users;
    // 200 memberships, one per collection, of 4 remote owners; the newest 150 are those of 3 suspended owners.
    const owners: string[] = [];
    for (let o = 0; o < 4; o++) {
      owners.push(await remoteAccount(h.store, `owner${o}`));
    }
    for (const [o, owner] of owners.entries()) {
      await seedMany(h, owner, o * 50, 50, { member: carol.id, state: o % 2 });
    }
    await sql(
      h.store,
      "UPDATE accounts SET suspended_at = ?, suspension_source = 'account' WHERE id IN (?, ?, ?)",
      T,
      owners[1]!,
      owners[2]!,
      owners[3]!,
    );
    const read = async (url: string) => {
      const answer = await h.request(url.replace("https://kopje.test", ""), bearer(carol.token));
      const body = (await answer.json()) as { collections: { id: string }[] };
      const next = /<([^>]*)>; rel="next"/.exec(answer.headers.get("link") ?? "")?.[1] ?? null;
      return { ids: body.collections.map((c) => c.id), next };
    };
    const first = await read(`/api/v1_alpha/accounts/${carol.id}/in_collections?limit=40`);
    // readWindow(40) = 120 candidates, all hidden: an empty page that links on from the 120th.
    expect(first).toEqual({
      ids: [],
      next: `https://kopje.test/api/v1/accounts/${carol.id}/in_collections?limit=40&max_id=${itemId(80)}`,
    });
    // A limit sent without a value (nil) is the default, 40, and the link carries none.
    expect(await read(`/api/v1/accounts/${carol.id}/in_collections?limit`)).toEqual({
      ids: [],
      next: `https://kopje.test/api/v1/accounts/${carol.id}/in_collections?max_id=${itemId(80)}`,
    });
    const seen: string[] = [];
    let next: string | null = first.next;
    while (next !== null) {
      const page = await read(next);
      seen.push(...page.ids);
      next = page.next;
    }
    expect(seen).toEqual(Array.from({ length: 50 }, (_, i) => collectionId(49 - i)));
    // An offset is a raw skip inside the window: 120 candidates past the first 150 give the available 30 newest.
    const skipped = await read(`/api/v1/accounts/${carol.id}/in_collections?limit=40&offset=150`);
    expect(skipped.ids).toEqual(Array.from({ length: 40 }, (_, i) => collectionId(49 - i)));
    expect((await read(`/api/v1/accounts/${carol.id}/in_collections?offset=400`)).ids).toEqual([]);
    const past = await h.request(`/api/v1/accounts/${carol.id}/in_collections?offset=401`, bearer(carol.token));
    expect([past.status, await past.json(), past.headers.get("link")]).toEqual([200, { collections: [] }, null]);
  });

  it("reads offset + readWindow(limit) candidates of in_collections at most", async () => {
    const h = await community(["carol"]);
    const { carol } = h.users;
    // 600 memberships, every owner suspended: the page is empty, and links on from the last candidate it read.
    for (let o = 0; o < 12; o++) {
      const owner = await remoteAccount(h.store, `owner${o}`);
      await seedMany(h, owner, o * 50, 50, { member: carol.id });
      await sql(h.store, "UPDATE accounts SET suspended_at = ?, suspension_source = 'account' WHERE id = ?", T, owner);
    }
    const answer = await h.request(`/api/v1/accounts/${carol.id}/in_collections?offset=400`, bearer(carol.token));
    expect(await answer.json()).toEqual({ collections: [] });
    // The 400 skipped and 120 read: the 520th newest of 600.
    expect(answer.headers.get("link")).toContain(`max_id=${itemId(600 - 520)}`);
  });
});

describe("collections: R45", () => {
  it("shows a collection and its items only as R45 allows", async () => {
    const { h, alice, bob, carol } = await world();
    const dave = (await members(h, 1, "dave"))[0]!;
    const open = await created(h, alice, { account_ids: [carol.id, dave] });
    const hidden = await created(h, alice, { discoverable: false });
    const list = async (token?: string) =>
      (await call(h, "GET", `/api/v1/accounts/${alice.id}/collections`, token)).body.collections.map(
        (c: { id: string }) => c.id,
      );
    const items = async (token?: string) =>
      (await call(h, "GET", `/api/v1/collections/${open.id}`, token)).body.collection.items.map((i) => i.account_id);
    // Discoverable only, but to the owner.
    expect(await list(bob.token)).toEqual([open.id]);
    expect(await list()).toEqual([open.id]);
    expect(await list(alice.token)).toEqual([hidden.id, open.id]);
    // A non-discoverable collection is still shown by its id.
    expect((await call(h, "GET", `/api/v1/collections/${hidden.id}`, bob.token)).status).toBe(200);
    // A pending item: the owner's alone.
    await sql(h.store, "UPDATE collection_items SET state = 0 WHERE account_id = ?", dave);
    expect([await items(alice.token), await items(bob.token), await items()]).toEqual([
      [carol.id, dave],
      [carol.id],
      [carol.id],
    ]);
    // An item whose account the viewer blocks: left out for that viewer, items and accounts.
    await block(h.store, bob.id, carol.id);
    expect(await items(bob.token)).toEqual([]);
    expect((await call(h, "GET", `/api/v1/collections/${open.id}`, bob.token)).body.accounts).toHaveLength(1);
    expect(await items()).toEqual([carol.id]);
    // An unavailable member: left out for everyone.
    await sql(h.store, "UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?", T, carol.id);
    expect(await items(alice.token)).toEqual([dave]);
    // A viewer the owner blocks: no collections, and 403 by id.
    await block(h.store, alice.id, bob.id);
    expect(await list(bob.token)).toEqual([]);
    expect(await call(h, "GET", `/api/v1/collections/${open.id}`, bob.token)).toMatchObject({
      status: 403,
      body: { error: "This action is not allowed" },
    });
    // An unavailable owner: not found by id, and listed nowhere.
    await sql(h.store, "UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?", T, alice.id);
    expect((await call(h, "GET", `/api/v1/collections/${open.id}`)).status).toBe(404);
    expect(await list()).toEqual([]);
  });

  it("asks the member's consent: discoverable, and unlocked or followed, no block either way, local", async () => {
    const { h, alice, bob, carol } = await world();
    const collection = (await created(h, alice)).id;
    const add = (id: string) =>
      call(h, "POST", `/api/v1/collections/${collection}/items`, alice.token, { account_id: id });
    const refused = async (id: string) => {
      expect((await add(id)).status).toBe(403);
      expect((await create(h, alice, { account_ids: [id] })).status).toBe(403);
    };
    const locked = await seedAccount(h.store, { username: "locked", locked: true });
    const hiding = await seedAccount(h.store, { username: "hiding" });
    const remote = await remoteAccount(h.store, "far");
    await discoverable(h, locked, remote);
    // A remote account whose actor states no canFeature (missing) is refused.
    for (const id of [locked, hiding, remote]) {
      await refused(id);
    }
    await block(h.store, bob.id, alice.id);
    await block(h.store, alice.id, carol.id);
    await refused(bob.id);
    await refused(carol.id);
    expect(await count(h, "collections")).toBe(1);
    // Followed by the owner (accepted): a locked account consents.
    await sql(
      h.store,
      "INSERT INTO follows (account_id, target_account_id, state, created_at) VALUES (?, ?, 'accepted', ?)",
      alice.id,
      locked,
      T,
    );
    expect((await add(locked)).status).toBe(200);
    // The owner itself, while discoverable.
    expect((await add(alice.id)).status).toBe(200);
    // A remote account whose canFeature approves the public automatically: added pending, to be asked
    // (test/federation-feature-requests.test.ts).
    await sql(h.store, "UPDATE accounts SET feature_policy = ? WHERE id = ?", 2 << 16, remote);
    const asked = await add(remote);
    expect([asked.status, asked.body.collection_item.state]).toEqual([200, "pending"]);
    await sql(h.store, "UPDATE accounts SET discoverable = 0 WHERE id = ?", alice.id);
    expect((await create(h, alice, { account_ids: [alice.id] })).status).toBe(403);
  });

  it("lets only the item's account revoke it, which keeps the row and the membership listed", async () => {
    const { h, alice, bob, carol } = await world();
    const collection = await created(h, alice, { account_ids: [bob.id, carol.id] });
    const [bobItem, carolItem] = collection.items.map((i) => i.id) as [string, string];
    const revoke = (user: User, item: string) =>
      call(h, "POST", `/api/v1/collections/${collection.id}/items/${item}/revoke`, user.token);
    expect((await revoke(bob, carolItem)).status).toBe(403);
    expect((await revoke(alice, carolItem)).status).toBe(403);
    expect((await revoke(carol, carolItem)).status).toBe(200);
    expect(await sql(h.store, "SELECT state FROM collection_items WHERE id = ?", carolItem)).toEqual([{ state: 3 }]);
    for (const user of [alice, bob]) {
      const shown = await call(h, "GET", `/api/v1/collections/${collection.id}`, user.token);
      expect(shown.body.collection.items.map((i: { id: string }) => i.id)).toEqual([bobItem]);
    }
    const memberships = await call(h, "GET", `/api/v1/accounts/${carol.id}/in_collections`, carol.token);
    expect(memberships.body.collections.map((c: { id: string; items: unknown[] }) => [c.id, c.items.length])).toEqual([
      [collection.id, 1],
    ]);
    // An item of another collection, or none: not found.
    expect((await call(h, "POST", `/api/v1/collections/${collection.id}/items/1/revoke`, carol.token)).status).toBe(
      404,
    );
  });
});

describe("collections: maxima", () => {
  const LONG_ORIGIN = `https://${"h".repeat(253 - ".example".length)}.example`;
  const language = [...TREND_LANGUAGES].reduce((a, b) => (b.length > a.length ? b : a));
  const escaped = (n: number) => "\u0001".repeat(n);
  // A four-byte character a hashtag holds as it is (an ideograph: NFKC and lowercase keep it).
  const tag = "\u{20000}".repeat(MAX_TAG_LENGTH);

  // The collection `id` as GET /api/v1/collections/:id presents it on LONG_ORIGIN, with no viewer.
  async function shownAtLongOrigin(h: ApiHarness, id: string) {
    const shown = await runInDurableObject(h.store, (_instance, state) =>
      showCollection.run(state.storage.sql, { credential: null, now: NOW, id, present: { origin: LONG_ORIGIN } }),
    );
    if (shown.status !== "ok" || shown.value.status !== "ok") {
      throw new Error("not shown");
    }
    return shown.value.value;
  }

  // The bound's skeleton: every string empty, the booleans false, the counts at their longest, its 25 items' strings
  // empty.
  const skeleton = (collection: Collection) =>
    jsonBytes({
      ...collection,
      ...Object.fromEntries(
        Object.entries(collection)
          .filter(([, v]) => typeof v === "string")
          .map(([k]) => [k, ""]),
      ),
      local: false,
      sensitive: false,
      discoverable: false,
      tag: { name: "", url: "" },
      items: collection.items.map(() => ({ id: "", state: "accepted", created_at: "", account_id: "" })),
    });
  // What both bounds share past the skeleton: the id, language, account_id, timestamps, tag and its URL on
  // LONG_ORIGIN (each byte of its name encoded in three), and each item's id, created_at and account_id.
  const shared =
    18 +
    language.length +
    18 +
    2 * 24 +
    TAG_NAME_BYTES +
    (LONG_ORIGIN.length + "/tags/".length + 3 * TAG_NAME_BYTES) +
    25 * (18 + 24 + 18);

  it("derives a local collection's maximum from the bounds, and fits the answers of a full account", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const owner = await seedAccount(h.store, { username: "o".repeat(LOCAL_USERNAME_BYTES) });
    const ids = await members(h, 25);
    const retired = await members(h, 25, "r");
    expect(new TextEncoder().encode(tag).length).toBe(TAG_NAME_BYTES);
    for (let c = 0; c < 10; c++) {
      const collection = await seedCollection(h, owner, c, {
        name: escaped(COLLECTION_NAME_LENGTH.local),
        description: escaped(COLLECTION_DESCRIPTION_LENGTH.local),
        language,
        tag,
        created_at: T,
      });
      for (const [i, member] of ids.entries()) {
        await seedItem(h, collection, c * 100 + i, { account_id: member, object_uri: null, state: 1 });
      }
    }
    // The shown collection at the stored maximum: 25 revoked items beside the 25 accepted, which it does not show.
    for (const [i, member] of retired.entries()) {
      await seedItem(h, collectionId(0), 50 + i, { account_id: member, object_uri: null, state: 3 });
    }
    // The list at limit=100, on the API's origin: the account's 10 collections.
    const listed = await call(h, "GET", `/api/v1/accounts/${owner}/collections?limit=100`, alice.token);
    expect(listed.body.collections).toHaveLength(10);
    expect(jsonBytes(listed.body)).toBeLessThanOrEqual(10 * (COLLECTION_JSON_MAX + 1) + jsonBytes({ collections: [] }));
    // Its stored actor id at ACTOR_URI_LIMIT, as JSON too (a restored row: localCollectionUri builds the id under any
    // actor id the account presenter shows, withinIdentityBound), on LONG_ORIGIN, where the answer is presented.
    const actor = `${LONG_ORIGIN}/ap/users/`.padEnd(ACTOR_URI_LIMIT, "o");
    await sql(h.store, "UPDATE accounts SET uri = ? WHERE id = ?", actor, owner);
    const { collection, accounts } = await shownAtLongOrigin(h, collectionId(0));
    expect(collection.items).toHaveLength(25);
    expect(accounts).toHaveLength(26);
    // The bound: the skeleton and each string at its most, as JSON (six bytes for each escaped character): its uri
    // under the actor id at its bound, and its url on LONG_ORIGIN.
    expect(collection.uri).toBe(`${actor}/collections/${collectionId(0)}`);
    const max =
      skeleton(collection) +
      shared +
      (ACTOR_URI_LIMIT + "/collections/".length + 18) + // uri
      6 * COLLECTION_NAME_LENGTH.local +
      6 * COLLECTION_DESCRIPTION_LENGTH.local +
      (LONG_ORIGIN.length + "/collections/".length + 18); // url
    expect(max).toBe(LOCAL_COLLECTION_JSON_MAX);
    expect(LOCAL_COLLECTION_JSON_MAX).toBeLessThan(COLLECTION_JSON_MAX);
    // The fill reaches the bound but for local and discoverable, true and one byte shorter than false.
    expect(LOCAL_COLLECTION_JSON_MAX - jsonBytes(collection)).toBe(2);
    // An actor id whose JSON passes ACTOR_URI_LIMIT (its last byte a `"`, escaped to two), which the account presenter
    // does not show either, builds no id (localCollectionUri): the collection is presented with the uri "".
    await sql(h.store, "UPDATE accounts SET uri = ? WHERE id = ?", `${actor.slice(0, -1)}"`, owner);
    expect((await shownAtLongOrigin(h, collectionId(0))).collection.uri).toBe("");
    // CollectionWithAccounts: the collection and 26 accounts at the account occurrence's conservative bound.
    const frame = jsonBytes({ collection: {}, accounts: [] }) - 2;
    expect(COLLECTION_JSON_MAX + frame + 26 * (CONSERVATIVE_JSON.account + 1)).toBeLessThan(ANSWER_BYTES);
  });

  // 5-T8: a remote collection's longer name and description, and its uri and url as stored (https and printable ASCII,
  // a `"` escaped to two bytes), set COLLECTION_JSON_MAX.
  it("derives COLLECTION_JSON_MAX from a remote collection's bounds", async () => {
    const h = await community(["alice"]);
    const owner = await remoteAccount(h.store, "owner");
    const quoted = (bytes: number) => `https://${'"'.repeat(bytes - "https://".length)}`;
    const id = await seedCollection(h, owner, 0, {
      name: escaped(COLLECTION_NAME_LENGTH.remote),
      description: escaped(COLLECTION_DESCRIPTION_LENGTH.remote),
      language,
      tag,
      uri: quoted(COLLECTION_URI_BYTES),
      url: quoted(COLLECTION_URL_BYTES),
      created_at: T,
    });
    for (let i = 0; i < 25; i++) {
      const member = await remoteAccount(h.store, `m${i}`);
      // A remote collection's item as a listing stores it, with its uri (R45 shows a remote collection's item once listed).
      await seedItem(h, id, i, {
        account_id: member,
        object_uri: null,
        state: 1,
        uri: `https://remote.example/items/${i}`,
      });
    }
    const { collection, accounts } = await shownAtLongOrigin(h, id);
    expect(collection.items).toHaveLength(25);
    expect(accounts).toHaveLength(26);
    const max =
      skeleton(collection) +
      shared +
      (2 * COLLECTION_URI_BYTES - "https://".length) + // uri: each byte past the scheme a `"`
      6 * COLLECTION_NAME_LENGTH.remote +
      6 * COLLECTION_DESCRIPTION_LENGTH.remote +
      (2 * COLLECTION_URL_BYTES - "https://".length); // url
    expect(max).toBe(COLLECTION_JSON_MAX);
    // The fill reaches the bound but for discoverable, true and one byte shorter than false.
    expect(COLLECTION_JSON_MAX - jsonBytes(collection)).toBe(1);
    // CollectionWithAccounts: the collection and 26 accounts at the account occurrence's conservative bound.
    const frame = jsonBytes({ collection: {}, accounts: [] }) - 2;
    expect(COLLECTION_JSON_MAX + frame + 26 * (CONSERVATIVE_JSON.account + 1)).toBeLessThan(ANSWER_BYTES);
  });
});
