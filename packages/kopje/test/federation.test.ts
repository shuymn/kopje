import { runInDurableObject } from "cloudflare:test";
import jsonld from "jsonld/dist/jsonld.esm.js";
import { describe, expect, it } from "vitest";

import { version as packageVersion } from "../package.json";
import { fetchFederation } from "../src/federation/routes";
import type { StoreStub } from "../src/platform/store-client";
import { base64ToBytes } from "../src/security/key-wrap";
import { checkKey } from "../src/security/keyring";
import { harness } from "./app-helpers";
import { PUBLISHED_DAY, storeCreatedAt } from "./created-at-fixtures";
import {
  fixtureKeyGen,
  LEGACY,
  LEGACY_EMPTY_KEK,
  seedFollow,
  seedLocalAccount,
  seedRemoteAccount,
  setDomain,
} from "./federation-helpers";
import { BUILD, migratedStore } from "./helpers";
import { contexts } from "./quote-helpers";
import { ACTIVE_EDGES, ACTIVE_EDGES_DAY, activeAccounts } from "./read-helpers";

// Identity goldens: every expected value is a literal. The domain is fixed at /setup ('social.example'), where the
// requests go (WEB-6).
const DOMAIN = "social.example";
const KEK = LEGACY.kek;
const ALICE = "111111111111111111";
const BOB = "222222222222222222";
const AP = { headers: { accept: "application/activity+json" } };

const pemBody = (pem: string) => pem.replace(/-----(BEGIN|END) PUBLIC KEY-----|\s/g, "");

// Where another server sends a person to follow, or to open a post or an account, from this one (app/interaction.tsx):
// the subscribe template and FEP-3b86's Object intent, as Mastodon 4.7.5's WebfingerSerializer#links gives every
// account and its instance actor; its Create intent is left out (docs/mastodon-deviations.md, WebFinger).
const INTERACTION_LINKS = [
  {
    rel: "http://ostatus.org/schema/1.0/subscribe",
    template: "https://social.example/authorize_interaction?uri={uri}",
  },
  { rel: "https://w3id.org/fep/3b86/Object", template: "https://social.example/authorize_interaction?uri={object}" },
];

// The answer carries both templates, and no FEP-3b86 intent but Object.
function expectInteractionLinks(body: { links?: { rel: string }[] }) {
  expect(body.links).toEqual(expect.arrayContaining(INTERACTION_LINKS));
  expect(body.links?.map((link) => link.rel).filter((rel) => rel.startsWith("https://w3id.org/fep/3b86/"))).toEqual([
    "https://w3id.org/fep/3b86/Object",
  ]);
}

async function instance(options: { kek?: string; now?: () => number } = {}) {
  const store = await migratedStore();
  await setDomain(store, DOMAIN);
  await seedLocalAccount(store, DOMAIN, { id: ALICE, username: "Alice", displayName: "Alice A", note: "<p>hi</p>" });
  await seedRemoteAccount(store, BOB, "https://remote.example/users/bob", "remote.example");
  let generated = 0;
  const keygen = () => {
    generated++;
    return fixtureKeyGen();
  };
  const loader = { fetch: () => Promise.reject(new Error("offline")), checkHost: () => Promise.resolve() };
  const h = harness(store, { USER_KEK: options.kek ?? KEK }, undefined, { keygen, loader }, options.now, DOMAIN);
  const json = async (path: string, init: RequestInit = AP) => {
    const response = await h.request(path, init);
    return {
      status: response.status,
      type: response.headers.get("content-type"),
      body: await response.json<never>(),
    };
  };
  return { ...h, store, json, generated: () => generated };
}

describe("actor document", () => {
  it("publishes a local actor with ids under the fixed domain", async () => {
    const { json } = await instance();
    const { status, type, body } = await json("/ap/users/Alice");

    expect(status).toBe(200);
    expect(type).toBe("application/activity+json");
    expect(body).toMatchObject({
      id: "https://social.example/ap/users/Alice",
      type: "Person",
      preferredUsername: "Alice",
      name: "Alice A",
      summary: "<p>hi</p>",
      url: "https://social.example/@Alice",
      inbox: "https://social.example/ap/users/Alice/inbox",
      outbox: "https://social.example/ap/users/Alice/outbox",
      followers: "https://social.example/ap/users/Alice/followers",
      following: "https://social.example/ap/users/Alice/following",
      featured: "https://social.example/ap/users/Alice/collections/featured",
      featuredTags: "https://social.example/ap/users/Alice/collections/tags",
      endpoints: { sharedInbox: "https://social.example/inbox" },
      manuallyApprovesFollowers: false,
      discoverable: true,
      published: "2026-10-01T00:00:00Z",
      publicKey: {
        id: "https://social.example/ap/users/Alice#main-key",
        owner: "https://social.example/ap/users/Alice",
      },
    });
    // The same key as local_accounts.pubkey (Fedify re-wraps the base64 at 64 columns).
    const { publicKeyPem } = (body as { publicKey: { publicKeyPem: string } }).publicKey;
    expect(pemBody(publicKeyPem)).toBe(pemBody(LEGACY.pubkey));
  });

  // ActivityPub::ActorSerializer#published: the creation day's midnight UTC (created_at.midnight.iso8601).
  it("publishes the creation day's midnight for a creation time past it", async () => {
    const { json, store } = await instance();
    await storeCreatedAt(store, ALICE);
    const { status, body } = await json("/ap/users/Alice");
    expect(status).toBe(200);
    expect((body as { published: unknown }).published).toBe(PUBLISHED_DAY);
  });

  // An imported time in another form than Kopje's writers store is published as before #1564 (Fedify's reading of it),
  // as the Account shows it as stored (account-created-at.test.ts).
  it("publishes a creation time with an offset as it did before", async () => {
    const { json, store } = await instance();
    await storeCreatedAt(store, ALICE, "2026-10-12T00:15:00+01:00");
    const { status, body } = await json("/ap/users/Alice");
    expect(status).toBe(200);
    expect((body as { published: unknown }).published).toBe("2026-10-11T23:15:00Z");
  });

  // HTML-3: a stored avatar or header that is not an http(s) URL is left out of the actor.
  it.each(["javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:image/png;base64,AAAA", "/a.png"])(
    "leaves out an icon and image stored as %j",
    async (bad) => {
      const { json, store } = await instance();
      await runInDurableObject(store, (_instance, state) => {
        state.storage.sql.exec("UPDATE accounts SET avatar_url = ?, header_url = ? WHERE id = ?", bad, bad, ALICE);
      });
      const { status, body } = await json("/ap/users/Alice");
      expect(status).toBe(200);
      expect(body).not.toHaveProperty("icon");
      expect(body).not.toHaveProperty("image");
    },
  );

  it("publishes an http(s) icon and image", async () => {
    const { json, store } = await instance();
    await runInDurableObject(store, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE accounts SET avatar_url = 'HTTPS://cdn.test/a.png', header_url = 'https://cdn.test/h.png' WHERE id = ?",
        ALICE,
      );
    });
    const { body } = await json("/ap/users/Alice");
    expect(body).toMatchObject({
      icon: { type: "Image", url: "https://cdn.test/a.png" },
      image: { type: "Image", url: "https://cdn.test/h.png" },
    });
  });

  // ActivityPub::ActorSerializer: `icon` and `image` only while the account is available and has the image, each with
  // its description as `summary` when present? (ImageSerializer#summary?).
  it("publishes the image descriptions as the icon's and image's summary, and none without the image", async () => {
    const { json, store } = await instance();
    const set = (assignments: string) =>
      runInDurableObject(store, (_instance, state) => {
        state.storage.sql.exec(`UPDATE accounts SET ${assignments} WHERE id = ?`, ALICE);
      });
    const images = async () => {
      const body = (await json("/ap/users/Alice")).body as Record<string, unknown>;
      return { icon: body.icon, image: body.image };
    };
    await set(`avatar_url = 'https://cdn.test/a.png', header_url = 'https://cdn.test/h.png',
			avatar_description = 'A cat', header_description = '𠀀 field'`);
    expect(await images()).toEqual({
      icon: { type: "Image", url: "https://cdn.test/a.png", summary: "A cat" },
      image: { type: "Image", url: "https://cdn.test/h.png", summary: "𠀀 field" },
    });
    // '' publishes no summary.
    await set("avatar_description = ''");
    expect(await images()).toEqual({
      icon: { type: "Image", url: "https://cdn.test/a.png" },
      image: { type: "Image", url: "https://cdn.test/h.png", summary: "𠀀 field" },
    });
    // Without the image, nor its description.
    await set("avatar_description = 'A cat', header_url = NULL");
    expect(await images()).toEqual({
      icon: { type: "Image", url: "https://cdn.test/a.png", summary: "A cat" },
      image: undefined,
    });
    // Suspended, neither.
    await runInDurableObject(store, (_instance, state) => {
      state.storage.sql.exec("UPDATE local_accounts SET suspended_at = '2026-01-01T00:00:00.000Z'");
    });
    expect(await images()).toEqual({ icon: undefined, image: undefined });
  });

  it("publishes only http(s) aliases, dropping invalid and relative ones", async () => {
    const { json, store } = await instance();
    const stored = ["https://old.example/users/alice", "javascript:alert(1)", "/users/alice", "HTTP://Older.example/a"];
    await runInDurableObject(store, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE local_accounts SET also_known_as = ? WHERE account_id = ?",
        JSON.stringify(stored),
        ALICE,
      );
    });
    const { status, body } = await json("/ap/users/Alice");
    expect(status).toBe(200);
    expect((body as { alsoKnownAs: unknown }).alsoKnownAs).toEqual([
      "https://old.example/users/alice",
      "http://older.example/a",
    ]);
  });

  it("publishes no aliases when none is an http(s) URL", async () => {
    const { json, store } = await instance();
    await runInDurableObject(store, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE local_accounts SET also_known_as = ? WHERE account_id = ?",
        JSON.stringify(["/users/alice", "data:,x"]),
        ALICE,
      );
    });
    const { status, body } = await json("/ap/users/Alice");
    expect(status).toBe(200);
    expect(body).not.toHaveProperty("alsoKnownAs");
  });

  it("publishes attributionDomains with its context term only when the account has one, as Mastodon does", async () => {
    const { json, store } = await instance();
    const none = (await json("/ap/users/Alice")).body as Record<string, unknown>;
    expect(none).not.toHaveProperty("attributionDomains");
    expect(JSON.stringify(none["@context"])).not.toContain("attributionDomains");
    await runInDurableObject(store, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE local_accounts SET attribution_domains = ? WHERE account_id = ?",
        JSON.stringify(["writer.example", "news.example"]),
        ALICE,
      );
    });
    const { status, body } = await json("/ap/users/Alice");
    expect(status).toBe(200);
    const document = body as Record<string, unknown>;
    expect(document.attributionDomains).toEqual(["writer.example", "news.example"]);
    expect(document["@context"]).toContainEqual({
      toot: "http://joinmastodon.org/ns#",
      showFeatured: "toot:showFeatured",
      showMedia: "toot:showMedia",
      showRepliesInMedia: "toot:showRepliesInMedia",
      attributionDomains: { "@id": "toot:attributionDomains", "@container": "@set" },
    });
    expect(document).toMatchObject({ id: "https://social.example/ap/users/Alice", type: "Person" });
  });

  it("declares its handle in webfinger with its context, suspended too, as Mastodon 4.6 (FEP-2c59)", async () => {
    const { json, store } = await instance();
    for (const suspended of [false, true]) {
      if (suspended) {
        await runInDurableObject(store, (_instance, state) => {
          state.storage.sql.exec(
            "UPDATE local_accounts SET suspended_at = '2026-01-01T00:00:00.000Z' WHERE account_id = ?",
            ALICE,
          );
        });
      }
      const { status, body } = await json("/ap/users/Alice");
      expect(status).toBe(200);
      const document = body as Record<string, unknown>;
      // The stored username's spelling at the domain fixed at setup.
      expect(document.webfinger, String(suspended)).toBe("Alice@social.example");
      expect(document["@context"], String(suspended)).toContain("https://purl.archive.org/socialweb/webfinger");
      expect(document.suspended, String(suspended)).toBe(suspended ? true : undefined);
    }
    // The instance actor declares none: WebFinger answers it only by its URL.
    const actor = (await json("/actor")).body as Record<string, unknown>;
    expect(actor).not.toHaveProperty("webfinger");
    expect(JSON.stringify(actor["@context"])).not.toContain("socialweb/webfinger");
  });

  // ActivityPub::ActorSerializer: show_featured, show_media and show_media_replies (as showRepliesInMedia) with the
  // profile_settings terms of context_helper.rb, on every actor, a suspended one's too.
  it("publishes the display settings with their context terms, suspended too", async () => {
    const { json, store } = await instance();
    const settings = async () => {
      const document = (await json("/ap/users/Alice")).body as Record<string, unknown>;
      // What a JSON-LD processor reads: each value under its toot: IRI.
      const [expanded] = await jsonld.expand(document, { documentLoader: contexts });
      const read = (term: string) =>
        (expanded?.[`http://joinmastodon.org/ns#${term}`] as { "@value": unknown }[] | undefined)?.map(
          (v) => v["@value"],
        );
      return {
        compact: [document.showFeatured, document.showMedia, document.showRepliesInMedia],
        expanded: [read("showFeatured"), read("showMedia"), read("showRepliesInMedia")],
        suspended: document.suspended,
      };
    };
    // An account that never changed them: Mastodon's defaults.
    expect(await settings()).toEqual({
      compact: [true, true, true],
      expanded: [[true], [true], [true]],
      suspended: undefined,
    });
    // Each read from its own column (no local writer yet: set in SQL).
    await runInDurableObject(store, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE accounts SET show_featured = 0, show_media = 1, show_media_replies = 0 WHERE id = ?",
        ALICE,
      );
    });
    expect(await settings()).toEqual({
      compact: [false, true, false],
      expanded: [[false], [true], [false]],
      suspended: undefined,
    });
    await runInDurableObject(store, (_instance, state) => {
      state.storage.sql.exec("UPDATE local_accounts SET suspended_at = '2026-01-01T00:00:00.000Z'");
    });
    expect(await settings()).toEqual({
      compact: [false, true, false],
      expanded: [[false], [true], [false]],
      suspended: true,
    });
  });

  it("answers 404 for an unknown actor and for a differently cased path", async () => {
    const { request } = await instance();
    expect((await request("/ap/users/nobody", AP)).status).toBe(404);
    expect((await request("/ap/users/alice", AP)).status).toBe(404);
  });

  it("answers 406 to a request that does not accept ActivityPub", async () => {
    const { request } = await instance();
    expect((await request("/ap/users/Alice", { headers: { accept: "text/html" } })).status).toBe(406);
  });
});

describe("instance actor", () => {
  it("publishes an Application at /actor with its own key, wrapped with the KEK in instance_settings", async () => {
    const { json, store, generated } = await instance();
    const { status, body } = await json("/actor");

    expect(status).toBe(200);
    expect(body).toMatchObject({
      id: "https://social.example/actor",
      type: "Application",
      preferredUsername: "social.example",
      inbox: "https://social.example/actor/inbox",
      outbox: "https://social.example/actor/outbox",
      endpoints: { sharedInbox: "https://social.example/inbox" },
      publicKey: { id: "https://social.example/actor#main-key", owner: "https://social.example/actor" },
    });
    const { publicKeyPem } = (body as { publicKey: { publicKeyPem: string } }).publicKey;
    expect(pemBody(publicKeyPem)).toBe(pemBody(LEGACY_EMPTY_KEK.pubkey));

    const stored = await storedInstanceKey(store);
    expect(stored.pubkey).toBe(LEGACY_EMPTY_KEK.pubkey);
    expect(await checkKey(KEK, stored)).toBe("ok");
    expect(await checkKey("", stored)).toBe("unwrap-failed");

    await json("/actor");
    expect(generated()).toBe(1);
  });

  it("is not served under /ap/users", async () => {
    const { request } = await instance();
    expect((await request("/ap/users/kopje%3Ainstance", AP)).status).toBe(404);
  });

  it("is discoverable through WebFinger by its canonical URI, with the interaction templates", async () => {
    const { json, request } = await instance();
    const { status, body } = await json("/.well-known/webfinger?resource=https://social.example/actor");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      subject: "https://social.example/actor",
      links: expect.arrayContaining([
        { rel: "self", type: "application/activity+json", href: "https://social.example/actor" },
      ]),
    });
    expectInteractionLinks(body);
    // Only the canonical URI: the template spelling of the instance identifier, as the resource value
    // "https://social.example/ap/users/kopje%3Ainstance", and other spellings are not the instance actor.
    for (const resource of [
      "https://social.example/ap/users/kopje%3Ainstance",
      "https://social.example/ap/users/kopje:instance",
      "https://social.example/actor/",
      "https://social.example/actor?x=1",
    ]) {
      const query = new URLSearchParams({ resource });
      expect((await request(`/.well-known/webfinger?${query.toString()}`)).status, resource).toBe(404);
    }
  });

  // Mastodon 4.7.5 answers acct:<local domain>@<local domain> with its instance actor (WebfingerResource#account_from_acct)
  // and confirms a new actor's handle by WebFinger before it stores it (ProcessAccountService#check_webfinger!): the
  // subject loops back to acct:<preferredUsername>@<host> and the self link to the actor id. WebfingerSerializer gives
  // the instance actor the aliases [instance_actor_url].
  it("is discoverable through WebFinger by its handle, the domain at the domain", async () => {
    const { json } = await instance();
    const actor = (await json("/actor")).body as { id: string; preferredUsername: string };
    const { status, type, body } = await json("/.well-known/webfinger?resource=acct:social.example@social.example");
    expect(status).toBe(200);
    expect(type).toBe("application/jrd+json");
    expect(body).toEqual({
      subject: `acct:${actor.preferredUsername}@social.example`,
      aliases: [actor.id],
      links: [
        { rel: "self", type: "application/activity+json", href: actor.id },
        { rel: "http://webfinger.net/rel/profile-page", href: "https://social.example/about" },
        ...INTERACTION_LINKS,
      ],
    });
    expect(actor).toMatchObject({ id: "https://social.example/actor", preferredUsername: "social.example" });
    // The host is matched without case, as Mastodon's TagManager#local_domain? matches it, and the subject names it in
    // lower case.
    const upper = await json("/.well-known/webfinger?resource=acct:social.example@SOCIAL.EXAMPLE");
    expect(upper.body).toMatchObject({ subject: "acct:social.example@social.example" });
  });

  // ID-5: a local account keeps its WebFinger identity. Imports, conversion and configuration refuse a local username
  // that is the domain; a Store that holds one anyway (written before those refusals) answers the account for it, and
  // the instance actor then has no handle answer, only its URI one.
  it("never answers its handle for a local account whose username is the domain", async () => {
    const { json, store } = await instance();
    await seedLocalAccount(store, DOMAIN, { id: "333333333333333333", username: "social.example" });
    const self = {
      rel: "self",
      type: "application/activity+json",
      href: "https://social.example/ap/users/social.example",
    };
    for (const handle of ["social.example", "SOCIAL.EXAMPLE"]) {
      const { status, body } = await json(`/.well-known/webfinger?resource=acct:${handle}@social.example`);
      expect([handle, status]).toEqual([handle, 200]);
      expect(body).toMatchObject({ subject: `acct:${handle}@social.example`, links: expect.arrayContaining([self]) });
    }
    const byUri = await json("/.well-known/webfinger?resource=https://social.example/actor");
    expect(byUri.body).toMatchObject({
      links: expect.arrayContaining([
        { rel: "self", type: "application/activity+json", href: "https://social.example/actor" },
      ]),
    });
  });

  it("answers no other handle at the domain, nor the domain's handle elsewhere", async () => {
    const { request } = await instance();
    for (const resource of [
      // Mastodon compares the username with the local domain exactly (account_from_acct), then as a local username.
      "acct:SOCIAL.EXAMPLE@social.example",
      "acct:social.example.@social.example",
      "acct:example@social.example",
      "acct:kopje:instance@social.example",
      "acct:social.example@other.example",
      "acct:other.example@social.example",
      "acct:kopje.test@kopje.test",
    ]) {
      const query = new URLSearchParams({ resource });
      expect((await request(`/.well-known/webfinger?${query.toString()}`)).status, resource).toBe(404);
    }
  });

  // Mastodon 4.7.5 also answers its instance actor for a resource that is the domain itself (WebfingerResource,
  // `\A(https?://)?<domain>/?\Z`), which its web client asks when a person names only a server, and on a 404 opens
  // https://<domain>/authorize_interaction?uri={uri}. Kopje answers none (docs/mastodon-deviations.md, WebFinger).
  it("answers no resource that is the domain itself", async () => {
    const { request } = await instance();
    for (const [resource, status] of [
      ["https://social.example", 404],
      ["https://social.example/", 404],
      ["http://social.example", 404],
      ["http://social.example/", 404],
      ["social.example", 400],
      ["social.example/", 400],
    ] as const) {
      const query = new URLSearchParams({ resource });
      expect([resource, (await request(`/.well-known/webfinger?${query.toString()}`)).status]).toEqual([
        resource,
        status,
      ]);
    }
  });
});

// Mastodon's instance actor outbox (ActivityPub::OutboxesController for Account.representative, v4.5.11) is an
// OrderedCollection of its statuses_count, 0, with a first page that lists nothing.
describe("instance actor outbox", () => {
  const OUTBOX = "https://social.example/actor/outbox";

  it("answers the outbox the actor advertises: empty, counted, with a first page", async () => {
    const { json, request } = await instance();
    const actor = (await json("/actor")).body as { outbox: string };
    const advertised = new URL(actor.outbox);
    expect(advertised.href).toBe(OUTBOX);

    const response = await request(advertised.pathname, AP);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/activity+json");
    expect(response.headers.get("vary")).toBe("Accept");
    // Fedify's @context for a collection of activities, as a user outbox has.
    const context = expect.arrayContaining(["https://www.w3.org/ns/activitystreams"]);
    expect(await response.json()).toEqual({
      "@context": context,
      id: OUTBOX,
      type: "OrderedCollection",
      totalItems: 0,
      first: `${OUTBOX}?cursor=first`,
    });

    const page = await json("/actor/outbox?cursor=first");
    expect(page.status).toBe(200);
    expect(page.body).toEqual({
      "@context": context,
      id: `${OUTBOX}?cursor=first`,
      type: "OrderedCollectionPage",
      partOf: OUTBOX,
    });
  });

  it("answers as a user outbox does, by the same negotiation and headers", async () => {
    const { request } = await instance();
    const LD = 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"';
    for (const accept of [LD, "application/json", "text/html", "text/html, application/activity+json", "*/*", null]) {
      const init = accept === null ? {} : { headers: { accept } };
      const mine = await request("/actor/outbox", init);
      const user = await request("/ap/users/Alice/outbox", init);
      expect(mine.status, String(accept)).toBe(user.status);
      for (const header of ["content-type", "vary", "cache-control"]) {
        expect(mine.headers.get(header), `${accept} ${header}`).toBe(user.headers.get(header));
      }
    }
    // The negotiation ran: a browser is refused.
    expect((await request("/actor/outbox", { headers: { accept: "text/html" } })).status).toBe(406);
  });

  it("names only the cursor of the query in its ids and links, and has no page past the first", async () => {
    const { json, request } = await instance();
    expect((await json("/actor/outbox?x=1")).body).toMatchObject({ id: OUTBOX, first: `${OUTBOX}?cursor=first` });
    expect((await json("/actor/outbox?cursor=first&x=1")).body).toMatchObject({
      id: `${OUTBOX}?cursor=first`,
      partOf: OUTBOX,
    });
    for (const cursor of ["2", "999999999999999999", ""]) {
      expect((await request(`/actor/outbox?cursor=${cursor}`, AP)).status, cursor).toBe(404);
    }
  });

  it("serves no other collection under /actor", async () => {
    const { store } = await instance();
    const deps = {
      domain: DOMAIN,
      build: BUILD,
      store: () => store,
      kek: KEK,
      now: () => Date.now(),
      keygen: fixtureKeyGen,
      loader: { fetch: () => Promise.reject(new Error("offline")), checkHost: () => Promise.resolve() },
    };
    const status = async (path: string) => {
      const url = new URL(path, `https://${DOMAIN}`);
      return (await fetchFederation(deps, new Request(url, AP), url)).response.status;
    };
    expect(await status("/actor/outbox")).toBe(200);
    for (const path of ["/actor/inbox", "/actor/followers", "/actor/Outbox", "/actor/inbox?cursor=first"]) {
      expect(await status(path), path).toBe(404);
    }
  });
});

async function storedInstanceKey(store: StoreStub) {
  const value = await runInDurableObject(store, (_instance, state) => {
    const row = state.storage.sql
      .exec<{ value: string }>("SELECT value FROM instance_settings WHERE name = 'instance_actor_key'")
      .one();
    return row.value;
  });
  const key = JSON.parse(value) as { privkey: string; salt: string; pubkey: string };
  return { privkey: base64ToBytes(key.privkey), salt: base64ToBytes(key.salt), pubkey: key.pubkey };
}

describe("WebFinger", () => {
  it("resolves acct:user@domain to the actor, with the profile link, the subscribe template and the Object intent", async () => {
    const { json } = await instance();
    const { status, type, body } = await json("/.well-known/webfinger?resource=acct:Alice@social.example");

    expect(status).toBe(200);
    expect(type).toBe("application/jrd+json");
    expect(body).toEqual({
      subject: "acct:Alice@social.example",
      aliases: ["https://social.example/ap/users/Alice"],
      links: [
        { rel: "self", type: "application/activity+json", href: "https://social.example/ap/users/Alice" },
        { rel: "http://webfinger.net/rel/profile-page", href: "https://social.example/@Alice" },
        ...INTERACTION_LINKS,
      ],
    });
  });

  it("matches the username case-insensitively and accepts the actor URI", async () => {
    const { json } = await instance();
    const lower = await json("/.well-known/webfinger?resource=acct:alice@social.example");
    expect(lower.body).toMatchObject({
      links: expect.arrayContaining([
        { rel: "self", type: "application/activity+json", href: "https://social.example/ap/users/Alice" },
      ]),
    });
    const byUri = await json("/.well-known/webfinger?resource=https://social.example/ap/users/Alice");
    expect(byUri.body).toMatchObject({
      subject: "https://social.example/ap/users/Alice",
      links: expect.arrayContaining([
        { rel: "self", type: "application/activity+json", href: "https://social.example/ap/users/Alice" },
      ]),
    });
    expectInteractionLinks(byUri.body);
  });

  it("answers 404 for another host, an unknown user, and the request host", async () => {
    const { request } = await instance();
    for (const resource of ["acct:Alice@other.example", "acct:nobody@social.example", "acct:Alice@kopje.test"]) {
      expect((await request(`/.well-known/webfinger?resource=${resource}`)).status, resource).toBe(404);
    }
  });
});

describe("NodeInfo", () => {
  async function withPosts() {
    const i = await instance();
    await runInDurableObject(i.store, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO statuses (id, uri, account_id, visibility, published_at) VALUES
				('333333333333333333', 'https://social.example/ap/o/1', '${ALICE}', 'public', '2026-10-05T00:00:00.000Z')`,
      );
      state.storage.sql.exec(`UPDATE local_accounts SET active_on = '2026-10-05' WHERE account_id = '${ALICE}'`);
    });
    return i;
  }

  it("links both versions from /.well-known/nodeinfo", async () => {
    const { json } = await instance();
    expect((await json("/.well-known/nodeinfo")).body).toEqual({
      links: [
        { rel: "http://nodeinfo.diaspora.software/ns/schema/2.0", href: "https://social.example/nodeinfo/2.0" },
        { rel: "http://nodeinfo.diaspora.software/ns/schema/2.1", href: "https://social.example/nodeinfo/2.1" },
      ],
    });
  });

  it("serves 2.1 with software kopje and the package version", async () => {
    const { json } = await withPosts();
    const { type, body } = await json("/nodeinfo/2.1");
    expect(type).toBe('application/json; profile="http://nodeinfo.diaspora.software/ns/schema/2.1#"');
    expect(body).toEqual({
      $schema: "http://nodeinfo.diaspora.software/ns/schema/2.1#",
      version: "2.1",
      software: {
        name: "kopje",
        version: packageVersion,
        repository: "https://github.com/shuymn/kopje",
        homepage: "https://github.com/shuymn/kopje",
      },
      protocols: ["activitypub"],
      services: { inbound: [], outbound: [] },
      openRegistrations: false,
      usage: { users: { total: 1, activeMonth: 1, activeHalfyear: 1 }, localPosts: 1, localComments: 0 },
      metadata: {},
    });
  });

  // Two fresh origin responses on the same UTC day and account state (a cached response of an earlier day may differ):
  // both count the available local accounts with active_on in the 29 UTC days ending today, at the clock both requests
  // read, ACTIVE_EDGES_DAY: Alice (never active) and the window edges of ACTIVE_EDGES.
  it("answers activeMonth as a fresh /api/v2/instance of the same day answers active_month", async () => {
    const { json, store } = await instance({ now: () => Date.parse(`${ACTIVE_EDGES_DAY}T00:00:00.000Z`) });
    await activeAccounts(store, ACTIVE_EDGES, 500000000000000000n);
    const nodeInfo = (await json("/nodeinfo/2.1")).body as { usage: { users: Record<string, number> } };
    expect(nodeInfo.usage.users).toEqual({ total: 7, activeMonth: 2, activeHalfyear: 4 });
    const instanceV2 = await json("/api/v2/instance", {});
    expect(instanceV2.status).toBe(200);
    expect((instanceV2.body as { usage: { users: { active_month: number } } }).usage.users.active_month).toBe(
      nodeInfo.usage.users.activeMonth,
    );
  });

  it("serves 2.0 without the 2.1-only software fields", async () => {
    const { json } = await withPosts();
    const { type, body } = await json("/nodeinfo/2.0");
    expect(type).toBe('application/json; profile="http://nodeinfo.diaspora.software/ns/schema/2.0#"');
    expect(body).toEqual({
      $schema: "http://nodeinfo.diaspora.software/ns/schema/2.0#",
      version: "2.0",
      software: { name: "kopje", version: packageVersion },
      protocols: ["activitypub"],
      services: { inbound: [], outbound: [] },
      openRegistrations: false,
      usage: { users: { total: 1, activeMonth: 1, activeHalfyear: 1 }, localPosts: 1, localComments: 0 },
      metadata: {},
    });
  });
});

describe("documents open to browsers", () => {
  // Mastodon opens /.well-known/*, /nodeinfo/* and /users/:username to GET from any origin (config/initializers/cors.rb,
  // v4.5.11). Elk reads NodeInfo with no-cache headers, so it sends a preflight first.
  const ORIGIN = { origin: "https://elk.example" };

  it("answers GET and its preflight on the public documents with any origin", async () => {
    const { request } = await instance();
    for (const path of [
      "/.well-known/nodeinfo",
      "/nodeinfo/2.0",
      "/nodeinfo/2.1",
      "/.well-known/webfinger?resource=acct:Alice@social.example",
      "/.well-known/oauth-authorization-server",
      "/ap/users/Alice",
    ]) {
      const response = await request(path, { headers: { ...ORIGIN, ...AP.headers } });
      expect(response.headers.get("access-control-allow-origin"), path).toBe("*");
      const preflight = await request(path, {
        method: "OPTIONS",
        headers: {
          ...ORIGIN,
          "access-control-request-method": "GET",
          "access-control-request-headers": "cache-control,pragma",
        },
      });
      expect(preflight.status, path).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin"), path).toBe("*");
      expect(preflight.headers.get("access-control-allow-methods"), path).toBe("GET");
      expect(preflight.headers.get("access-control-allow-headers"), path).toBe("cache-control,pragma");
    }
  });

  it("keeps the instance actor, collections and objects closed, as Mastodon does", async () => {
    const { request } = await instance();
    for (const path of ["/actor", "/actor/outbox", "/ap/users/Alice/followers", "/ap/users/Alice/outbox"]) {
      const response = await request(path, { headers: { ...ORIGIN, ...AP.headers } });
      expect(response.headers.get("access-control-allow-origin"), path).toBeNull();
    }
  });

  it("opens the profile page only as the actor document, not as HTML (WEB-3)", async () => {
    const { request } = await instance();
    const actor = await request("/@Alice", { headers: { ...ORIGIN, ...AP.headers } });
    expect(actor.headers.get("content-type")).toContain("activity+json");
    expect(actor.headers.get("access-control-allow-origin")).toBe("*");
    const page = await request("/@Alice", { headers: { ...ORIGIN, accept: "text/html" } });
    expect(page.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("followers and following collections", () => {
  it("answers the count with a first page link, and pages of actor ids", async () => {
    const { json, store } = await instance();
    await seedFollow(store, BOB, ALICE);

    expect((await json("/ap/users/Alice/followers")).body).toMatchObject({
      id: "https://social.example/ap/users/Alice/followers",
      type: "OrderedCollection",
      totalItems: 1,
      first: "https://social.example/ap/users/Alice/followers?cursor=1",
    });
    expect((await json("/ap/users/Alice/followers?cursor=1")).body).toMatchObject({
      id: "https://social.example/ap/users/Alice/followers?cursor=1",
      type: "OrderedCollectionPage",
      partOf: "https://social.example/ap/users/Alice/followers",
      orderedItems: ["https://remote.example/users/bob"],
    });
    expect((await json("/ap/users/Alice/following")).body).toMatchObject({
      id: "https://social.example/ap/users/Alice/following",
      type: "OrderedCollection",
      totalItems: 0,
    });
  });

  it("counts accepted follows only, newest first, 40 per page", async () => {
    const { json, store } = await instance();
    await seedFollow(store, ALICE, BOB, "pending");
    for (let i = 1; i <= 41; i++) {
      const id = `4000000000000000${String(i).padStart(2, "0")}`;
      await seedRemoteAccount(store, id, `https://remote.example/users/u${i}`, "remote.example");
      await seedFollow(store, ALICE, id);
    }

    expect((await json("/ap/users/Alice/following")).body).toMatchObject({ totalItems: 41 });
    const first = (await json("/ap/users/Alice/following?cursor=1")).body as { orderedItems: string[]; next: string };
    expect(first.orderedItems).toHaveLength(40);
    expect(first.orderedItems[0]).toBe("https://remote.example/users/u41");
    expect(first.next).toBe("https://social.example/ap/users/Alice/following?cursor=2");
    expect((await json("/ap/users/Alice/following?cursor=2")).body).toMatchObject({
      orderedItems: ["https://remote.example/users/u1"],
    });
  });

  it("shows only the size of the collections of an actor that hides its network, and refuses a page", async () => {
    const { json, request, store } = await instance();
    await seedFollow(store, BOB, ALICE);
    await seedFollow(store, ALICE, BOB);
    await runInDurableObject(store, (_instance, state) => {
      state.storage.sql.exec("UPDATE local_accounts SET hide_collections = 1 WHERE account_id = ?", ALICE);
    });

    for (const kind of ["followers", "following"]) {
      expect((await json(`/ap/users/Alice/${kind}`)).body).toEqual({
        "@context": expect.anything(),
        id: `https://social.example/ap/users/Alice/${kind}`,
        type: "OrderedCollection",
        totalItems: 1,
      });
      expect((await request(`/ap/users/Alice/${kind}?cursor=1`, AP)).status).toBe(403);
    }
    // A malformed page is still not found.
    expect((await request("/ap/users/Alice/followers?cursor=x", AP)).status).toBe(404);
  });

  it("answers 404 for the collections of a suspended actor, as for its outbox", async () => {
    const { request, store } = await instance();
    await seedFollow(store, BOB, ALICE);
    await runInDurableObject(store, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE local_accounts SET suspended_at = '2026-01-01T00:00:00.000Z' WHERE account_id = ?",
        ALICE,
      );
    });

    for (const path of [
      "/ap/users/Alice/followers",
      "/ap/users/Alice/followers?cursor=1",
      "/ap/users/Alice/following",
    ]) {
      expect((await request(path, AP)).status, path).toBe(404);
    }
  });

  it("answers 404 for an unknown actor, another spelling of a username, or a malformed page", async () => {
    const { request } = await instance();
    for (const path of [
      "/ap/users/nobody/followers",
      "/ap/users/alice/followers",
      "/ap/users/alice/following?cursor=1",
      "/ap/users/Alice/followers?cursor=0",
      "/ap/users/Alice/followers?cursor=x",
    ]) {
      expect((await request(path, AP)).status, path).toBe(404);
    }
  });
});

describe("featured collections", () => {
  it("serves the featured hashtags as Hashtags, and an empty featured collection (no pinned statuses)", async () => {
    const { json, store } = await instance();
    await runInDurableObject(store, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO featured_tags (id, account_id, name, display_name) VALUES
					('700000000000000001', ?1, 'cats', 'Cats'), ('700000000000000002', ?1, '猫', '猫')`,
        ALICE,
      );
      // Imported rows the list bound refuses (tag-bounds.ts), left out: a name past it, malformed bytes.
      state.storage.sql.exec(
        `INSERT INTO featured_tags (id, account_id, name, display_name) VALUES
					('700000000000000003', ?1, ?2, ?2), ('700000000000000004', ?1, CAST(x'63617480' AS TEXT), 'Cat')`,
        ALICE,
        "a".repeat(300),
      );
    });
    const tags = await json("/ap/users/Alice/collections/tags");
    expect(tags.status).toBe(200);
    expect(tags.body).toMatchObject({
      id: "https://social.example/ap/users/Alice/collections/tags",
      totalItems: 2,
      orderedItems: [
        { type: "Hashtag", name: "#Cats", href: "https://social.example/@Alice/tagged/cats" },
        { type: "Hashtag", name: "#猫", href: `https://social.example/@Alice/tagged/${encodeURIComponent("猫")}` },
      ],
    });
    const featured = await json("/ap/users/Alice/collections/featured");
    expect(featured.status).toBe(200);
    expect(featured.body).toMatchObject({
      id: "https://social.example/ap/users/Alice/collections/featured",
      totalItems: 0,
    });
  });

  it("answers 404 for an unknown actor, another spelling or a suspended actor", async () => {
    const { request, store } = await instance();
    for (const path of [
      "/ap/users/nobody/collections/tags",
      "/ap/users/alice/collections/tags",
      "/ap/users/alice/collections/featured",
    ]) {
      expect((await request(path, AP)).status, path).toBe(404);
    }
    await runInDurableObject(store, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE local_accounts SET suspended_at = '2026-01-01T00:00:00.000Z' WHERE account_id = ?",
        ALICE,
      );
    });
    for (const path of ["/ap/users/Alice/collections/tags", "/ap/users/Alice/collections/featured"]) {
      expect((await request(path, AP)).status, path).toBe(404);
    }
  });
});
