import { runInDurableObject } from "cloudflare:test";
import jsonld from "jsonld/dist/jsonld.esm.js";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { actorDocument } from "../src/domain/actor-update";
import { type ApiHarness, bearer, json, settleDeliveries, sql } from "./api-helpers";
import { harness, NOW } from "./app-helpers";
import { fixtureKeyGen, LEGACY, seedLocalAccount, setDomain } from "./federation-helpers";
import { BUILD, migratedStore } from "./helpers";
import { contexts } from "./quote-helpers";
import { act, block, community, remoteAccount, remoteFollows, type User } from "./status-helpers";

// Local collections over ActivityPub (FEP-7aa9, src/domain/collection-documents.ts, src/federation/routes.ts): the
// actor's featuredCollections and canFeature, the four documents, who is refused them, and the activities a change
// sends (design §6, PR 3; VIS-33).

const AP = { accept: "application/activity+json" };
const T = "2026-10-11T00:00:00.000Z";
const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";
const collectionId = (n: number) => String(500000000000000000n + BigInt(n));
const itemId = (n: number) => String(600000000000000000n + BigInt(n));

async function seedCollection(h: ApiHarness, owner: string, n: number, fields: Record<string, unknown> = {}) {
  const row = {
    id: collectionId(n),
    account_id: owner,
    local: 1,
    name: `c${n}`,
    sensitive: 0,
    discoverable: 1,
    created_at: new Date(Date.parse(T) + n * 1000).toISOString(),
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

async function seedItem(h: ApiHarness, collection: string, n: number, member: string, position: number, state = 1) {
  await sql(
    h.store,
    `INSERT INTO collection_items (id, collection_id, account_id, state, position, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
    itemId(n),
    collection,
    member,
    state,
    position,
    T,
    T,
  );
  return itemId(n);
}

const suspend = (h: ApiHarness, id: string) =>
  sql(h.store, "UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?", new Date(NOW).toISOString(), id);

// A remote account whose key the Store lists (remote_keys), so a request signed with its keyId names it.
async function fetcher(h: ApiHarness, username: string, domain: string) {
  const id = await remoteAccount(h.store, username, domain);
  const keyId = `https://${domain}/users/${username}#main-key`;
  await sql(
    h.store,
    "INSERT INTO remote_keys (key_id, account_id, pem, fetched_at) VALUES (?, ?, 'pem', ?)",
    keyId,
    id,
    NOW,
  );
  return {
    id,
    signature: { signature: `keyId="${keyId}",algorithm="rsa-sha256",headers="(request-target)",signature="x"` },
  };
}

async function get(h: ApiHarness, path: string, headers: Record<string, string> = {}) {
  const response = await h.request(path, { headers: { ...AP, ...headers } });
  const text = await response.text();
  return {
    status: response.status,
    type: response.headers.get("content-type"),
    cache: response.headers.get("cache-control"),
    body: (response.status === 200 ? JSON.parse(text) : text) as Record<string, unknown>,
  };
}

// alice's collection with bob accepted at 1, carol pending at 2, dave revoked at 3, erin accepted at 4.
async function world() {
  const h = await community(["alice", "bob", "carol", "dave", "erin"]);
  const { alice, bob, carol, dave, erin } = h.users;
  const id = await seedCollection(h, alice.id, 1, { description: "Mine", tag: "Cats" });
  const items = {
    bob: await seedItem(h, id, 1, bob.id, 1),
    carol: await seedItem(h, id, 2, carol.id, 2, 0),
    dave: await seedItem(h, id, 3, dave.id, 3, 3),
    erin: await seedItem(h, id, 4, erin.id, 4),
  };
  return { h, alice, bob, carol, dave, erin, id, items };
}

const ORIGIN = "https://kopje.test";
const actor = (username: string) => `${ORIGIN}/ap/users/${username}`;

describe("collections over ActivityPub: the actor (D19)", () => {
  // 3-T1. Fails if withMastodonTerms leaves the collection terms out, or the policy reads discoverable NULL as true.
  it("advertises featuredCollections and who may feature the account, as Mastodon computes them", async () => {
    const store = await migratedStore();
    await setDomain(store, "social.example");
    await seedLocalAccount(store, "social.example", { id: "111111111111111111", username: "Alice" });
    const loader = { fetch: () => Promise.reject(new Error("offline")), checkHost: () => Promise.resolve() };
    const h = harness(
      store,
      { USER_KEK: LEGACY.kek },
      BUILD,
      { keygen: fixtureKeyGen, loader },
      () => NOW,
      "social.example",
    );
    const set = (discoverable: number | null, locked: number) =>
      runInDurableObject(store, (_instance, state) => {
        state.storage.sql.exec("UPDATE accounts SET discoverable = ?, locked = ?", discoverable, locked);
      });
    const read = async () => {
      const document = await (await h.request("/ap/users/Alice", { headers: AP })).json<Record<string, unknown>>();
      // What a JSON-LD processor reads: canFeature's automaticApproval under FEP-7aa9's and GoToSocial's IRIs.
      const [expanded] = await jsonld.expand(document, { documentLoader: contexts });
      const policy = expanded?.["https://gotosocial.org/ns#interactionPolicy"] as Record<string, unknown>[] | undefined;
      const feature = policy?.[0]?.["https://w3id.org/fep/7aa9#canFeature"] as Record<string, unknown>[] | undefined;
      const approval = feature?.[0]?.["https://gotosocial.org/ns#automaticApproval"] as { "@id": string }[] | undefined;
      // The Update a profile change sends carries the same (actor-update.ts).
      const update = await runInDurableObject(store, (_instance, state) =>
        actorDocument(new Db(state.storage.sql), "111111111111111111"),
      );
      // What Mastodon's InteractionPolicyParser reads, by the raw keys: automaticApproval as a list, `as:Public` and
      // `Public` as the public collection.
      const raw = (document.interactionPolicy as { canFeature?: { automaticApproval?: unknown } } | undefined)
        ?.canFeature?.automaticApproval;
      return {
        featuredCollections: document.featuredCollections,
        mastodon: [raw].flat().map((value) => (value === "as:Public" || value === "Public" ? PUBLIC : value)),
        expanded: approval?.map((value) => value["@id"]),
        update: { featuredCollections: update?.featuredCollections, interactionPolicy: update?.interactionPolicy },
      };
    };
    const id = "https://social.example/ap/users/Alice";
    const cases: [number | null, number, string][] = [
      [1, 0, PUBLIC],
      [1, 1, `${id}/followers`],
      [0, 0, id],
      [0, 1, id],
      [null, 0, id],
    ];
    for (const [discoverable, locked, approval] of cases) {
      await set(discoverable, locked);
      // The Update writes it as Mastodon's ActorSerializer does; the endpoint as Fedify compacts it (`as:Public`, a
      // single value), which Mastodon's parser and a JSON-LD processor read as the same.
      const policy = { canFeature: { automaticApproval: [approval] } };
      expect(await read(), `${discoverable} ${locked}`).toEqual({
        featuredCollections: `${id}/featured_collections`,
        mastodon: [approval],
        expanded: [approval],
        update: { featuredCollections: `${id}/featured_collections`, interactionPolicy: policy },
      });
    }
    // A suspended account's too, from its stored settings.
    await set(1, 0);
    await runInDurableObject(store, (_instance, state) => {
      state.storage.sql.exec("UPDATE local_accounts SET suspended_at = '2026-01-01T00:00:00.000Z'");
    });
    expect((await read()).expanded).toEqual([PUBLIC]);
    // The instance actor has neither.
    const instance = await (await h.request("/actor", { headers: AP })).json<Record<string, unknown>>();
    expect(instance).not.toHaveProperty("featuredCollections");
    expect(instance).not.toHaveProperty("interactionPolicy");
  });
});

// Each form of `page` as Mastodon 4.7.5 reads it (FeaturedCollectionsController with Kaminari 1.2.2): the last `page`
// of the query, Ruby's String#to_i of it, the first page below 1, the root for a blank one, the page's id the value as
// given, CGI-escaped, and no `prev` or `next` past the last page. Each case names the one-line change that fails it.
describe("collections over ActivityPub: featured_collections reads `page` as Mastodon does (D18)", () => {
  const root = `${actor("alice")}/featured_collections`;
  const PAGE_1 = [6, 5, 4, 3, 2].map((n) => `${actor("alice")}/collections/${collectionId(n)}`);
  const PAGE_2 = [`${actor("alice")}/collections/${collectionId(1)}`];
  const page = (id: string, items: string[], links: { next?: number; prev?: number } = {}) => ({
    id: `${root}?page=${id}`,
    ...(links.next === undefined ? {} : { next: `${root}?page=${links.next}` }),
    ...(links.prev === undefined ? {} : { prev: `${root}?page=${links.prev}` }),
    items,
  });
  it.each([
    // Math.max(n, 1) dropped.
    ["below 1", "0", page("0", PAGE_1, { next: 2 })],
    // The minus read as a plus.
    ["negative", "-2", page("-2", PAGE_1, { next: 2 })],
    // The same clamp: no digits is 0.
    ["not a number", "x", page("x", PAGE_1, { next: 2 })],
    // Trailing characters refuse the number instead of ending it.
    ["digits then others", "2x", page("2x", PAGE_2, { prev: 1 })],
    // The `0d` prefix not skipped.
    ["a 0d prefix", "0d2", page("0d2", PAGE_2, { prev: 1 })],
    // The plus not skipped.
    ["a plus", "%2B2", page("%2B2", PAGE_2, { prev: 1 })],
    // Leading white space not skipped.
    ["leading white space", "%202", page("+2", PAGE_2, { prev: 1 })],
    // An underscore between digits not skipped.
    ["an underscore between digits", "0_2", page("0_2", PAGE_2, { prev: 1 })],
    // `prev` given past the last page.
    ["past the last page", "3", page("3", [])],
    // The same: any number past every page is that empty page (Mastodon answers 500 past PostgreSQL's bigint).
    ["past bigint", "99999999999999999999999", page("99999999999999999999999", [])],
    // The first `page` read instead of the last.
    ["repeated", "9&page=2", page("2", PAGE_2, { prev: 1 })],
    // The value echoed unescaped.
    ["escaped in its id", "x%20y*", page("x+y%2A", PAGE_1, { next: 2 })],
    // Not UTF-8: read with U+FFFD, where Mastodon answers 400 (docs/mastodon-deviations.md).
    ["not UTF-8", "2%FF", page("2%EF%BF%BD", PAGE_2, { prev: 1 })],
  ])("serves a page for %s", async (_name, value, expected) => {
    const { h, alice } = await world();
    for (let n = 2; n <= 6; n++) {
      await seedCollection(h, alice.id, n);
    }
    const body = (await get(h, `/ap/users/alice/featured_collections?page=${value}`)).body;
    expect({
      id: body.id,
      next: body.next,
      prev: body.prev,
      items: (body.items as { id: string }[]).map((c) => c.id),
    }).toEqual({ next: undefined, prev: undefined, ...expected });
    expect(body).toMatchObject({ type: "CollectionPage", totalItems: 6, partOf: root });
  });

  // The blank test dropped (an array or a hash is no `page`: Mastodon answers 500, docs/mastodon-deviations.md).
  it.each([
    ["empty", "page="],
    ["white space", "page=%20%C2%A0"],
    ["an array", "page[]=2"],
    ["bare", "page"],
  ])("serves the root when page is %s", async (_name, query) => {
    const { h } = await world();
    expect((await get(h, `/ap/users/alice/featured_collections?${query}`)).body).toEqual({
      "@context": "https://www.w3.org/ns/activitystreams",
      id: root,
      type: "Collection",
      totalItems: 1,
      first: `${root}?page=1`,
    });
  });
});

describe("collections over ActivityPub: the documents (D18)", () => {
  // 3-T2.
  it("serves featured_collections and its pages of five, newest first", async () => {
    const { h, alice } = await world();
    for (let n = 2; n <= 6; n++) {
      await seedCollection(h, alice.id, n, { discoverable: n === 2 ? 0 : 1 });
    }
    const root = `${actor("alice")}/featured_collections`;
    expect((await get(h, "/ap/users/alice/featured_collections")).body).toEqual({
      "@context": "https://www.w3.org/ns/activitystreams",
      id: root,
      type: "Collection",
      totalItems: 6,
      first: `${root}?page=1`,
    });
    const first = (await get(h, "/ap/users/alice/featured_collections?page=1")).body;
    expect({ ...first, items: (first.items as { id: string }[]).map((c) => c.id) }).toEqual({
      "@context": expect.any(Array),
      id: `${root}?page=1`,
      type: "CollectionPage",
      totalItems: 6,
      next: `${root}?page=2`,
      partOf: root,
      items: [6, 5, 4, 3, 2].map((n) => `${actor("alice")}/collections/${collectionId(n)}`),
    });
    const second = (await get(h, "/ap/users/alice/featured_collections?page=2")).body;
    expect({ ...second, items: (second.items as { id: string }[]).map((c) => c.id) }).toEqual({
      "@context": expect.any(Array),
      id: `${root}?page=2`,
      type: "CollectionPage",
      totalItems: 6,
      prev: `${root}?page=1`,
      partOf: root,
      items: [`${actor("alice")}/collections/${collectionId(1)}`],
    });
    // A page past the last is empty (the forms of `page`: below).
    expect((await get(h, "/ap/users/alice/featured_collections?page=3")).body.items).toEqual([]);
    // Only the stored spelling of the username, and a local account.
    expect((await get(h, "/ap/users/Alice/featured_collections")).status).toBe(404);
    expect((await get(h, "/ap/users/nobody/featured_collections")).status).toBe(404);
  });

  // 3-T2. Fails if the projection reads every state (carol's pending and dave's revoked items shown).
  it("serves a FeaturedCollection of its accepted items, with summaryMap when a language is set", async () => {
    const { h, id, items } = await world();
    const path = `/ap/users/alice/collections/${id}`;
    const answer = await get(h, path);
    expect(answer.type).toBe("application/activity+json");
    const item = (member: string, n: string) => ({
      id: `${actor("alice")}/collection_items/${n}`,
      type: "FeaturedItem",
      featuredObject: actor(member),
      featureAuthorization: `${actor(member)}/feature_authorizations/${n}`,
      published: T,
    });
    expect(answer.body).toEqual({
      "@context": [
        "https://www.w3.org/ns/activitystreams",
        {
          toot: "http://joinmastodon.org/ns#",
          discoverable: "toot:discoverable",
          FeaturedCollection: "https://w3id.org/fep/7aa9#FeaturedCollection",
          FeaturedItem: "https://w3id.org/fep/7aa9#FeaturedItem",
          FeatureRequest: "https://w3id.org/fep/7aa9#FeatureRequest",
          FeatureAuthorization: "https://w3id.org/fep/7aa9#FeatureAuthorization",
          topic: { "@id": "https://w3id.org/fep/7aa9#topic", "@type": "@id" },
          featuredObject: { "@id": "https://w3id.org/fep/7aa9#featuredObject", "@type": "@id" },
          featureAuthorization: { "@id": "https://w3id.org/fep/7aa9#featureAuthorization", "@type": "@id" },
          Hashtag: "as:Hashtag",
          sensitive: "as:sensitive",
        },
      ],
      id: `${actor("alice")}/collections/${id}`,
      type: "FeaturedCollection",
      totalItems: 2,
      name: "c1",
      attributedTo: actor("alice"),
      url: `${ORIGIN}/collections/${id}`,
      sensitive: false,
      discoverable: true,
      published: "2026-10-11T00:00:01.000Z",
      updated: T,
      summary: "Mine",
      topic: { type: "Hashtag", href: `${ORIGIN}/tags/cats`, name: "#cats" },
      orderedItems: [item("bob", items.bob), item("erin", items.erin)],
    });
    // What a JSON-LD processor reads: each item's member and authorization as ids.
    const [expanded] = await jsonld.expand(answer.body, { documentLoader: contexts });
    const listed = expanded?.["https://www.w3.org/ns/activitystreams#items"] as {
      "@list": Record<string, unknown>[];
    }[];
    expect(listed[0]?.["@list"].map((entry) => entry["https://w3id.org/fep/7aa9#featuredObject"])).toEqual([
      [{ "@id": actor("bob") }],
      [{ "@id": actor("erin") }],
    ]);
    await sql(h.store, "UPDATE collections SET language = 'ja', discoverable = 0, sensitive = 1, tag = NULL");
    const localized = (await get(h, path)).body;
    expect(localized).toMatchObject({ summaryMap: { ja: "Mine" }, discoverable: false, sensitive: true });
    expect(localized).not.toHaveProperty("summary");
    expect(localized).not.toHaveProperty("topic");
    await sql(h.store, "UPDATE collections SET description = NULL");
    expect((await get(h, path)).body).not.toHaveProperty("summaryMap");
  });

  // 3-T2. Mastodon serves an item in any state (CollectionItemsController#show).
  it("serves a FeaturedItem in any state, and the authorization of an accepted local member only, never cached", async () => {
    const { h, items } = await world();
    for (const [member, item] of Object.entries(items)) {
      const answer = await get(h, `/ap/users/alice/collection_items/${item}`);
      expect(answer.status, member).toBe(200);
      expect(answer.body, member).toMatchObject({
        id: `${actor("alice")}/collection_items/${item}`,
        type: "FeaturedItem",
        featuredObject: actor(member),
      });
    }
    const authorization = await get(h, `/ap/users/bob/feature_authorizations/${items.bob}`);
    expect(authorization).toEqual({
      status: 200,
      type: "application/activity+json",
      cache: "no-store",
      body: {
        "@context": [
          "https://www.w3.org/ns/activitystreams",
          {
            gts: "https://gotosocial.org/ns#",
            FeatureAuthorization: "https://w3id.org/fep/7aa9#FeatureAuthorization",
            interactingObject: { "@id": "gts:interactingObject", "@type": "@id" },
            interactionTarget: { "@id": "gts:interactionTarget", "@type": "@id" },
          },
        ],
        id: `${actor("bob")}/feature_authorizations/${items.bob}`,
        type: "FeatureAuthorization",
        interactingObject: `${actor("alice")}/collections/${collectionId(1)}`,
        interactionTarget: actor("bob"),
      },
    });
    // Under another member's path, the owner's, or another spelling: none.
    for (const path of [
      `/ap/users/erin/feature_authorizations/${items.bob}`,
      `/ap/users/alice/feature_authorizations/${items.bob}`,
      `/ap/users/Bob/feature_authorizations/${items.bob}`,
    ]) {
      expect(await get(h, path), path).toEqual({
        status: 404,
        type: "text/plain;charset=UTF-8",
        cache: "no-store",
        body: "Not Found",
      });
    }
  });

  // 3-T3 (refusal). Fails if the reads pass NULL for the fetcher (the block arms never run), or the authorization drops
  // its state test (the pending item answers 200).
  it("refuses a fetcher the owner blocks or domain-blocks, and an authorization to one its member blocks", async () => {
    const { h, alice, bob, id, items } = await world();
    const eve = await fetcher(h, "eve", "fetch.example");
    // eve's server's instance actor, whose key the Store lists too, and a key on that server the Store does not list.
    const server = await fetcher(h, "fetch.example", "fetch.example");
    const stranger = {
      signature:
        'keyId="https://fetch.example/users/mallory#main-key",algorithm="rsa-sha256",headers="(request-target)",signature="x"',
    };
    const paths = [
      "/ap/users/alice/featured_collections",
      "/ap/users/alice/featured_collections?page=1",
      `/ap/users/alice/collections/${id}`,
      `/ap/users/alice/collection_items/${items.bob}`,
    ];
    const authorization = `/ap/users/bob/feature_authorizations/${items.bob}`;
    const statuses = async (headers: Record<string, string>) => {
      const all: number[] = [];
      for (const path of [...paths, authorization]) {
        all.push((await get(h, path, headers)).status);
      }
      return all;
    };
    // Unsigned, and signed by eve, before any block.
    expect(await statuses({})).toEqual([200, 200, 200, 200, 200]);
    expect(await statuses(eve.signature)).toEqual([200, 200, 200, 200, 200]);
    // The owner blocks eve: its documents refuse her; bob's authorization does not, and no one else is refused, her
    // server's instance actor included.
    await block(h.store, alice.id, eve.id);
    expect(await statuses(eve.signature)).toEqual([404, 404, 404, 404, 200]);
    expect(await statuses({})).toEqual([200, 200, 200, 200, 200]);
    expect(await statuses(server.signature)).toEqual([200, 200, 200, 200, 200]);
    await sql(h.store, "DELETE FROM blocks");
    // The owner blocks her domain: every listed key of it is refused, and a key the Store does not list names no one.
    await sql(h.store, "INSERT INTO domain_blocks (account_id, domain) VALUES (?, 'fetch.example')", alice.id);
    expect(await statuses(eve.signature)).toEqual([404, 404, 404, 404, 200]);
    expect(await statuses(server.signature)).toEqual([404, 404, 404, 404, 200]);
    expect(await statuses(stranger)).toEqual([200, 200, 200, 200, 200]);
    await sql(h.store, "DELETE FROM domain_blocks");
    // The member blocks her: only its authorization refuses her.
    await block(h.store, bob.id, eve.id);
    expect(await statuses(eve.signature)).toEqual([200, 200, 200, 200, 404]);
    // A key the Store does not list names no one: served as unsigned.
    await block(h.store, alice.id, eve.id);
    expect(await statuses(stranger)).toEqual([200, 200, 200, 200, 200]);
    // A pending, revoked or rejected item has no authorization.
    for (const state of [0, 2, 3]) {
      await sql(h.store, "UPDATE collection_items SET state = ? WHERE id = ?", state, items.bob);
      expect((await get(h, authorization)).status, String(state)).toBe(404);
    }
  });

  // 3-T6 (absence). Fails if the projection reads accepted items without the availability arm.
  it("leaves a suspended member out of every document, and its FeaturedItem 404, as REST and the page do", async () => {
    const { h, alice, bob, id, items } = await world();
    await suspend(h, bob.id);
    const document = (await get(h, `/ap/users/alice/collections/${id}`)).body;
    expect({
      total: document.totalItems,
      items: (document.orderedItems as { featuredObject: string }[]).map((i) => i.featuredObject),
    }).toEqual({
      total: 1,
      items: [actor("erin")],
    });
    const page = (await get(h, "/ap/users/alice/featured_collections?page=1")).body;
    expect((page.items as Record<string, unknown>[])[0]).toEqual({ ...document, "@context": undefined });
    expect((await get(h, `/ap/users/alice/collection_items/${items.bob}`)).status).toBe(404);
    expect((await get(h, `/ap/users/bob/feature_authorizations/${items.bob}`)).status).toBe(404);
    // REST and the page show the same members.
    const rest = await (await h.request(`/api/v1/collections/${id}`)).json<{ collection: { item_count: number } }>();
    expect(rest.collection.item_count).toBe(1);
    const html = await (await h.request(`/collections/${id}`)).text();
    expect([html.includes("/@bob"), html.includes("/@erin")]).toEqual([false, true]);
    // An Update sent after the suspension embeds the same projection.
    await remoteFollows(h.store, await remoteAccount(h.store, "fan", "f.example"), alice.id);
    expect((await change(h, alice, "PATCH", `/api/v1/collections/${id}`, { name: "Renamed" })).status).toBe(200);
    const update = (await sent(h)).at(-1)!.activity;
    expect(update.object).toEqual({
      ...(await get(h, `/ap/users/alice/collections/${id}`)).body,
      "@context": undefined,
    });
    expect((update.object as { orderedItems: { featuredObject: string }[] }).orderedItems).toHaveLength(1);
    // An unavailable owner's documents are gone for everyone.
    await suspend(h, alice.id);
    for (const path of [
      "/ap/users/alice/featured_collections",
      `/ap/users/alice/collections/${id}`,
      `/ap/users/alice/collection_items/${items.erin}`,
    ]) {
      expect((await get(h, path)).status, path).toBe(404);
    }
  });
});

// A write through the API with `method`.
function change(h: ApiHarness, user: User, method: string, path: string, body: Record<string, unknown> = {}) {
  return h.request(path, bearer(user.token, json(body, { method })));
}

// Each outbound activity in record order, whether it is superseded, and the inboxes its deliveries were expanded to
// (sorted: a lane's order is lane's).
async function sent(h: ApiHarness) {
  await settleDeliveries(h.store);
  const rows = await sql<{ id: number; body: string; superseded: number }>(
    h.store,
    "SELECT id, body, superseded FROM outbound_activities ORDER BY id",
  );
  const deliveries = await sql<{ activity_id: number; inbox_url: string }>(
    h.store,
    "SELECT activity_id, inbox_url FROM deliveries ORDER BY id",
  );
  return rows.map((row) => ({
    activity: (JSON.parse(row.body) as { activity: Record<string, unknown> }).activity,
    superseded: row.superseded,
    inboxes: deliveries
      .filter((d) => d.activity_id === row.id)
      .map((d) => d.inbox_url)
      .toSorted(),
  }));
}

// The types and objects of the activities delivered to `inbox`, in its lane's order.
async function lane(h: ApiHarness, inbox: string) {
  const rows = await sql<{ body: string }>(
    h.store,
    `SELECT o.body FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id
		WHERE d.inbox_url = ? ORDER BY d.id`,
    inbox,
  );
  return rows.map((row) => {
    const { activity } = JSON.parse(row.body) as { activity: { type: string; object: unknown } };
    const object = activity.object as string | { type: string };
    return `${activity.type} ${typeof object === "string" ? object : object.type}`;
  });
}

const FAN_INBOX = "https://f.example/inbox";
const B_INBOX = "https://b.example/inbox";
const MEMBER_INBOX = "https://m.example/users/mem/inbox";

// alice with a remote follower (fan) and bob and carol discoverable; mem, a remote account, accepted into the
// collection by a row (a remote member is not featured through the API yet).
async function audience() {
  const h = await community(["alice", "bob", "carol"]);
  await sql(h.store, "UPDATE accounts SET discoverable = 1");
  const fan = await remoteAccount(h.store, "fan", "f.example");
  await remoteFollows(h.store, fan, h.users.alice.id);
  const member = await remoteAccount(h.store, "mem", "m.example");
  return { h, ...h.users, member };
}

describe("collections over ActivityPub: the activities (D17)", () => {
  // 3-T4. Fails if the changed-field test is dropped (an Update of nothing), if an Update is paired with a Create, if
  // the collection's Remove reads its members after the delete, or if an item's Add is superseded by its Remove.
  it("sends a collection's Add, Update and Remove and its items' Add and Remove to followers and members", async () => {
    const { h, alice, bob, carol, member } = await audience();
    const created = await change(h, alice, "POST", "/api/v1/collections", {
      name: "Mine",
      sensitive: false,
      discoverable: true,
      account_ids: [bob.id],
    });
    expect(created.status).toBe(200);
    const id = (await created.json<{ collection: { id: string } }>()).collection.id;
    const uri = `${actor("alice")}/collections/${id}`;
    const [add] = await sent(h);
    expect(add).toEqual({
      activity: {
        "@context": (await get(h, `/ap/users/alice/collections/${id}`)).body["@context"],
        id: expect.stringMatching(new RegExp(`^${uri}#adds/\\d{18}$`)),
        type: "Add",
        actor: actor("alice"),
        to: [PUBLIC],
        target: `${actor("alice")}/featured_collections`,
        object: { ...(await get(h, `/ap/users/alice/collections/${id}`)).body, "@context": undefined },
      },
      superseded: 0,
      inboxes: [FAN_INBOX],
    });
    expect((add!.activity.object as { orderedItems: unknown[] }).orderedItems).toHaveLength(1);

    // mem joins; a change of a federated field goes to the follower and to mem's own inbox, alone; another of the same
    // value sends nothing; two Updates waiting leave the later.
    await seedItem(h, id, 90, member, 2);
    const renamed = await change(h, alice, "PATCH", `/api/v1/collections/${id}`, { name: "Ours" });
    expect(renamed.status).toBe(200);
    const updates = (await sent(h)).slice(1);
    expect(updates.map((u) => [u.activity.type, u.activity.id, u.inboxes])).toEqual([
      ["Update", expect.stringMatching(new RegExp(`^${uri}#updates/\\d{18}$`)), [FAN_INBOX, MEMBER_INBOX]],
    ]);
    expect((updates[0]!.activity.object as { name: string }).name).toBe("Ours");
    expect((await change(h, alice, "PATCH", `/api/v1/collections/${id}`, { name: "Ours" })).status).toBe(200);
    expect(await sent(h)).toHaveLength(2);
    await change(h, alice, "PATCH", `/api/v1/collections/${id}`, { sensitive: true });
    const waiting = (await sent(h)).filter((u) => u.activity.type === "Update");
    expect(waiting.map((u) => [(u.activity.object as { sensitive: boolean }).sensitive, u.superseded])).toEqual([
      [false, 1],
      [true, 0],
    ]);

    // carol is added and removed before either is delivered: both go, the Add first, in mem's lane as in the
    // follower's.
    const added = await change(h, alice, "POST", `/api/v1/collections/${id}/items`, { account_id: carol.id });
    const item = (await added.json<{ collection_item: { id: string } }>()).collection_item.id;
    const featured = (await get(h, `/ap/users/alice/collection_items/${item}`)).body;
    expect((await change(h, alice, "DELETE", `/api/v1/collections/${id}/items/${item}`)).status).toBe(200);
    const [itemAdd, itemRemove] = (await sent(h)).filter((a) => a.activity.target === uri);
    expect(itemAdd).toEqual({
      activity: {
        "@context": featured["@context"],
        id: expect.stringMatching(new RegExp(`^${uri}#adds/\\d{18}$`)),
        type: "Add",
        actor: actor("alice"),
        to: [PUBLIC],
        target: uri,
        object: { ...featured, "@context": undefined },
      },
      superseded: 0,
      inboxes: [FAN_INBOX, MEMBER_INBOX],
    });
    expect(featured).toMatchObject({ type: "FeaturedItem", featuredObject: actor("carol") });
    expect(itemRemove).toEqual({
      activity: {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: expect.stringMatching(new RegExp(`^${uri}#removes/\\d{18}$`)),
        type: "Remove",
        actor: actor("alice"),
        to: [PUBLIC],
        target: uri,
        object: `${actor("alice")}/collection_items/${item}`,
      },
      superseded: 0,
      inboxes: [FAN_INBOX, MEMBER_INBOX],
    });
    expect((await lane(h, MEMBER_INBOX)).slice(-2)).toEqual([
      "Add FeaturedItem",
      `Remove ${actor("alice")}/collection_items/${item}`,
    ]);

    // The collection's Remove reaches mem, read before the delete.
    expect((await change(h, alice, "DELETE", `/api/v1/collections/${id}`)).status).toBe(200);
    const remove = (await sent(h)).at(-1)!;
    expect(remove).toEqual({
      activity: {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: expect.stringMatching(new RegExp(`^${uri}#removes/\\d{18}$`)),
        type: "Remove",
        actor: actor("alice"),
        to: [PUBLIC],
        target: `${actor("alice")}/featured_collections`,
        object: uri,
      },
      superseded: 0,
      inboxes: [FAN_INBOX, MEMBER_INBOX],
    });
  });

  // 3-T5, and a member's revoke. Fails if the block step or the revoke records no Remove.
  it("sends the owner's Remove of an item a block or its member's revoke takes out", async () => {
    const { h, alice, bob, carol, member } = await audience();
    const fanOfBob = await remoteAccount(h.store, "fob", "b.example");
    await remoteFollows(h.store, fanOfBob, bob.id);
    const ofAlice = await seedCollection(h, alice.id, 1);
    const ofBob = await seedCollection(h, bob.id, 2);
    const ofCarol = await seedCollection(h, carol.id, 3);
    await remoteFollows(h.store, await remoteAccount(h.store, "foc", "c.example"), carol.id);
    const memberItem = await seedItem(h, ofAlice, 1, member, 1);
    await seedItem(h, ofAlice, 2, bob.id, 2);
    const aliceInBob = await seedItem(h, ofBob, 3, alice.id, 1);
    const aliceInCarol = await seedItem(h, ofCarol, 4, alice.id, 1);

    // alice blocks mem: mem's item in her collection is deleted, and its Remove reaches her follower and mem.
    expect((await act(h, alice, `/api/v1/accounts/${member}/block`)).status).toBe(200);
    // alice blocks bob: her item in bob's collection is revoked, and bob's Remove reaches his follower.
    expect((await act(h, alice, `/api/v1/accounts/${bob.id}/block`)).status).toBe(200);
    // alice revokes her item in carol's collection, once.
    expect((await act(h, alice, `/api/v1/collections/${ofCarol}/items/${aliceInCarol}/revoke`)).status).toBe(200);
    expect((await act(h, alice, `/api/v1/collections/${ofCarol}/items/${aliceInCarol}/revoke`)).status).toBe(200);
    const removes = (await sent(h)).filter((s) => s.activity.type === "Remove");
    expect(removes.map((r) => [r.activity.actor, r.activity.target, r.activity.object, r.inboxes])).toEqual([
      [
        actor("alice"),
        `${actor("alice")}/collections/${ofAlice}`,
        `${actor("alice")}/collection_items/${memberItem}`,
        [FAN_INBOX, MEMBER_INBOX],
      ],
      [
        actor("bob"),
        `${actor("bob")}/collections/${ofBob}`,
        `${actor("bob")}/collection_items/${aliceInBob}`,
        [B_INBOX],
      ],
      [
        actor("alice"),
        `${actor("alice")}/collections/${ofAlice}`,
        `${actor("alice")}/collection_items/${itemId(2)}`,
        [FAN_INBOX],
      ],
      [
        actor("carol"),
        `${actor("carol")}/collections/${ofCarol}`,
        `${actor("carol")}/collection_items/${aliceInCarol}`,
        ["https://c.example/inbox"],
      ],
    ]);
  });

  // 3-T7. A block around the owner's own changes of the same item, before any job round: alice adds bob and blocks him
  // in the next request, and carol, added to another collection, blocks alice, who then deletes carol's revoked item.
  // Each item's Add goes before its Removes in every lane: mem's (a member's copy, written in the block) as the
  // follower's (written by the job, after it). Fails if a Remove a block stages supersedes the item's Add.
  it("keeps an item's Add before the Removes a block and its owner record around it", async () => {
    const { h, alice, bob, carol, member } = await audience();
    const create = async (name: string) => {
      const created = await change(h, alice, "POST", "/api/v1/collections", {
        name,
        sensitive: false,
        discoverable: true,
        account_ids: [],
      });
      return (await created.json<{ collection: { id: string } }>()).collection.id;
    };
    const add = async (collection: string, account: string) => {
      const added = await change(h, alice, "POST", `/api/v1/collections/${collection}/items`, { account_id: account });
      return (await added.json<{ collection_item: { id: string } }>()).collection_item.id;
    };
    const first = await create("First");
    const second = await create("Second");
    await seedItem(h, first, 91, member, 9);
    const ofBob = await add(first, bob.id);
    expect((await act(h, alice, `/api/v1/accounts/${bob.id}/block`)).status).toBe(200);
    const ofCarol = await add(second, carol.id);
    expect((await act(h, carol, `/api/v1/accounts/${alice.id}/block`)).status).toBe(200);
    expect((await change(h, alice, "DELETE", `/api/v1/collections/${second}/items/${ofCarol}`)).status).toBe(200);
    expect((await change(h, alice, "POST", `/api/v1/collections/${first}/items`, { account_id: bob.id })).status).toBe(
      403,
    );
    const all = await sent(h);
    expect(all.map((a) => [a.activity.type, a.superseded])).toEqual([
      ["Add", 0],
      ["Add", 0],
      ["Add", 0],
      ["Remove", 0],
      ["Add", 0],
      ["Remove", 0],
      ["Remove", 0],
    ]);
    const bobUri = `${actor("alice")}/collection_items/${ofBob}`;
    const carolUri = `${actor("alice")}/collection_items/${ofCarol}`;
    expect(await lane(h, FAN_INBOX)).toEqual([
      "Add FeaturedCollection",
      "Add FeaturedCollection",
      "Add FeaturedItem",
      "Add FeaturedItem",
      `Remove ${carolUri}`,
      `Remove ${bobUri}`,
      `Remove ${carolUri}`,
    ]);
    expect(await lane(h, MEMBER_INBOX)).toEqual(["Add FeaturedItem", `Remove ${bobUri}`]);
  });
});
