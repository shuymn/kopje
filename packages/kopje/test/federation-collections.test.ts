import { runInDurableObject } from "cloudflare:test";
import jsonld from "jsonld/dist/jsonld.esm.js";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { actorDocument } from "../src/domain/actor-update";
import { type ApiHarness, sql } from "./api-helpers";
import { harness, NOW } from "./app-helpers";
import { fixtureKeyGen, LEGACY, seedLocalAccount, setDomain } from "./federation-helpers";
import { BUILD, migratedStore } from "./helpers";
import { contexts } from "./quote-helpers";
import { block, community, remoteAccount } from "./status-helpers";

// Local collections over ActivityPub (FEP-7aa9, src/domain/collection-documents.ts, src/federation/routes.ts): the
// actor's featuredCollections and canFeature, the four documents, and who is refused them (design §6, PR 3; VIS-33).

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
      const document = (await (await h.request("/ap/users/Alice", { headers: AP })).json()) as Record<string, unknown>;
      // What a JSON-LD processor reads: canFeature's automaticApproval under FEP-7aa9's and GoToSocial's IRIs.
      const [expanded] = await jsonld.expand(document, { documentLoader: contexts });
      const policy = expanded?.["https://gotosocial.org/ns#interactionPolicy"] as Record<string, unknown>[] | undefined;
      const feature = policy?.[0]?.["https://w3id.org/fep/7aa9#canFeature"] as Record<string, unknown>[] | undefined;
      const approval = feature?.[0]?.["https://gotosocial.org/ns#automaticApproval"] as { "@id": string }[] | undefined;
      // The Update a profile change sends carries the same (actor-update.ts).
      const update = await runInDurableObject(store, (_instance, state) =>
        actorDocument(new Db(state.storage.sql), "111111111111111111"),
      );
      return {
        featuredCollections: document.featuredCollections,
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
      // The Update writes it as Mastodon's ActorSerializer does; the endpoint as Fedify compacts it, the same IRIs.
      const policy = { canFeature: { automaticApproval: [approval] } };
      expect(await read(), `${discoverable} ${locked}`).toEqual({
        featuredCollections: `${id}/featured_collections`,
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
    const instance = (await (await h.request("/actor", { headers: AP })).json()) as Record<string, unknown>;
    expect(instance).not.toHaveProperty("featuredCollections");
    expect(instance).not.toHaveProperty("interactionPolicy");
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
    // A page past the last is empty; anything but a page number is none.
    expect((await get(h, "/ap/users/alice/featured_collections?page=3")).body.items).toEqual([]);
    for (const page of ["0", "x", "-1"]) {
      expect((await get(h, `/ap/users/alice/featured_collections?page=${page}`)).status, page).toBe(404);
    }
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
    // The owner blocks eve: its documents refuse her; bob's authorization does not, and no one else is refused.
    await block(h.store, alice.id, eve.id);
    expect(await statuses(eve.signature)).toEqual([404, 404, 404, 404, 200]);
    expect(await statuses({})).toEqual([200, 200, 200, 200, 200]);
    await sql(h.store, "DELETE FROM blocks");
    // The owner blocks her domain.
    await sql(h.store, "INSERT INTO domain_blocks (account_id, domain) VALUES (?, 'fetch.example')", alice.id);
    expect(await statuses(eve.signature)).toEqual([404, 404, 404, 404, 200]);
    await sql(h.store, "DELETE FROM domain_blocks");
    // The member blocks her: only its authorization refuses her.
    await block(h.store, bob.id, eve.id);
    expect(await statuses(eve.signature)).toEqual([200, 200, 200, 200, 404]);
    // A key the Store does not list names no one: served as unsigned.
    await block(h.store, alice.id, eve.id);
    const stranger = {
      signature:
        'keyId="https://fetch.example/users/mallory#main-key",algorithm="rsa-sha256",headers="(request-target)",signature="x"',
    };
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
    const rest = (await (await h.request(`/api/v1/collections/${id}`)).json()) as {
      collection: { item_count: number };
    };
    expect(rest.collection.item_count).toBe(1);
    const html = await (await h.request(`/collections/${id}`)).text();
    expect([html.includes("/@bob"), html.includes("/@erin")]).toEqual([false, true]);
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
