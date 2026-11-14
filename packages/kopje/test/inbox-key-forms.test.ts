import { Person } from "@fedify/vocab";
import { describe, expect, it } from "vitest";

import { handleQueue } from "../src/jobs/queue";
import type { StoreStub } from "../src/platform/store-client";
import { StoreUnavailableError } from "../src/platform/store-errors";
import { sql } from "./api-helpers";
import { harness, inboxDeps } from "./app-helpers";
import { fixtureKeyGen, LEGACY_EMPTY_KEK, seedLocalAccount } from "./federation-helpers";
import { BUILD, completeSetup, migratedStore } from "./helpers";
import {
  LOCAL,
  loggedRefusals,
  MASTODON,
  mastodonActor,
  RemoteWeb,
  type SignOptions,
  signedInit,
  type TestActor,
} from "./inbox-helpers";
import { setup as statusSetup } from "./inbox-status-helpers";
import {
  cavageByKeyId,
  ecPem,
  ed25519Key,
  fedifyAlone,
  ML_DSA_44_MULTIBASE,
  multikeyActor,
  servedLoader,
  UNKNOWN_MULTIBASE,
} from "./key-forms-helpers";

// The key and signature forms of Mastodon 4.7's reading (ID-1): which keys an actor's document gives it, Ed25519 HTTP
// signatures, and a draft-cavage signature naming a key that is not RSA, live and on replay.

const AS = "https://www.w3.org/ns/activitystreams";
const ALICE_URI = `${LOCAL}/ap/users/alice`;

async function setup(options: { store?: (store: StoreStub) => StoreStub } = {}) {
  const store = await migratedStore();
  await completeSetup(store);
  await seedLocalAccount(store, "kopje.test", { id: "111111111111111111", username: "alice", key: LEGACY_EMPTY_KEK });
  const web = new RemoteWeb();
  const served = options.store?.(store) ?? store;
  const h = harness(served, {}, BUILD, { keygen: fixtureKeyGen, loader: web.loader });
  const send = async (init: RequestInit) => (await h.request("/inbox", init)).status;
  // The answer and the refusal lines it logs (processInbox).
  const refusals = (init: RequestInit) => loggedRefusals(() => send(init));
  // The request spooled in maintenance, then replayed once the Store is back.
  const replay = async (init: RequestInit) => {
    const maintenance = harness(store, { MAINTENANCE: "readonly" }, BUILD, {
      keygen: fixtureKeyGen,
      loader: web.loader,
    });
    expect((await maintenance.request("/inbox", init)).status).toBe(202);
    const deps = inboxDeps(() => store, web.loader);
    const replayed = await loggedRefusals(async () => {
      await maintenance.queue.deliver((batch) =>
        handleQueue(batch, { ...maintenance.env, MAINTENANCE: "off" } as Env, deps),
      );
      return 0;
    });
    return { queue: maintenance.queue, refused: replayed.refused };
  };
  const post = async (actor: TestActor, activity: unknown, sign: SignOptions = {}) =>
    send(await signedInit(actor, "/inbox", activity, sign));
  return { store, web, send, post, refusals, replay, h };
}

let sequence = 0;
const follow = (actor: TestActor) => ({
  "@context": AS,
  id: `${new URL(actor.uri).origin}/activities/k${++sequence}`,
  type: "Follow",
  actor: actor.uri,
  object: ALICE_URI,
});

const follows = (store: StoreStub) => sql(store, "SELECT account_id FROM follows");
const keys = (store: StoreStub) => sql<{ key_id: string; pem: string }>(store, "SELECT key_id, pem FROM remote_keys");
const INVALID = [[{ event: "kopje.inbox.refused", status: 401, reason: "invalidSignature" }]];

// The Store with its key lookups (remoteKey) refused as in maintenance.
function refusingKeyLookups(store: StoreStub): StoreStub {
  return new Proxy(store, {
    get: (target, name) => {
      if (name === "remoteKey") {
        return () => Promise.reject(new StoreUnavailableError("maintenance"));
      }
      const value = Reflect.get(target, name) as unknown;
      return typeof value === "function"
        ? (...args: unknown[]) =>
            (target as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[String(name)]!(...args)
        : value;
    },
  });
}

describe("a draft-cavage signature naming a key that is not RSA (ID-1)", () => {
  // Each: Fedify 2.4.5 alone throws InvalidAccessError for the request; Kopje answers 401 and changes nothing.

  it("refuses one naming an Ed25519 key in a legacy publicKey, which Fedify fetches itself, live and on replay", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const ed = await ed25519Key(bob.keyId);
    t.web.serve(bob.uri, { ...bob.document, publicKey: { id: bob.keyId, owner: bob.uri, publicKeyPem: ed.pem } });
    const init = await cavageByKeyId(bob.keyId, "/inbox", follow(bob));
    await expect(fedifyAlone(t.web, init)).rejects.toMatchObject({ name: "InvalidAccessError" });

    expect(await t.refusals(init)).toEqual({ status: 401, refused: INVALID });
    expect(t.web.fetched).toContain(bob.uri);
    const { queue, refused } = await t.replay(await cavageByKeyId(bob.keyId, "/inbox", follow(bob)));
    expect(queue.pending).toEqual([]);
    expect(queue.retries).toBe(0);
    expect(refused).toEqual(INVALID);
    expect(await follows(t.store)).toEqual([]);
    expect(await keys(t.store)).toEqual([]);
  });

  it("refuses one naming a key document of its own with an Ed25519 key, its actor listing it by reference", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const keyUrl = `${MASTODON}/keys/bob`;
    const ed = await ed25519Key(keyUrl);
    t.web.serve(bob.uri, { ...bob.document, publicKey: keyUrl });
    t.web.serve(keyUrl, {
      "@context": "https://w3id.org/security/v1",
      id: keyUrl,
      type: "CryptographicKey",
      owner: bob.uri,
      publicKeyPem: ed.pem,
    });
    const init = await cavageByKeyId(keyUrl, "/inbox", follow(bob));
    await expect(fedifyAlone(t.web, init)).rejects.toMatchObject({ name: "InvalidAccessError" });

    expect(await t.refusals(init)).toEqual({ status: 401, refused: INVALID });
    expect(t.web.fetched).toContain(keyUrl);
    expect(await follows(t.store)).toEqual([]);
    expect(await keys(t.store)).toEqual([]);
  });

  it("refuses one after an RSA legacy key is rotated to an Ed25519 key under the same id (Fedify's refetch)", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    expect(await t.send(await signedInit(bob, "/inbox", follow(bob)))).toBe(202);
    const stored = await keys(t.store);
    expect(stored).toEqual([{ key_id: bob.keyId, pem: bob.pem }]);
    const ed = await ed25519Key(bob.keyId);
    t.web.serve(bob.uri, { ...bob.document, publicKey: { id: bob.keyId, owner: bob.uri, publicKeyPem: ed.pem } });
    // The stored RSA key is served fresh and fails these bytes, so Fedify refetches the key and finds the Ed25519 one.
    const init = await cavageByKeyId(bob.keyId, "/inbox", follow(bob));
    await expect(fedifyAlone(t.web, init)).rejects.toMatchObject({ name: "InvalidAccessError" });
    const before = t.web.fetched.length;

    expect(await t.refusals(init)).toEqual({ status: 401, refused: INVALID });
    expect(t.web.fetched.slice(before)).toContain(bob.uri);
    expect(await follows(t.store)).toHaveLength(1);
    expect(await keys(t.store)).toEqual(stored);
  });

  it("still spools a request whose key lookup the Store refuses in maintenance", async () => {
    const t = await setup({ store: refusingKeyLookups });
    const bob = await mastodonActor(t.web, "bob");
    const init = await cavageByKeyId(bob.keyId, "/inbox", follow(bob));
    // The gate reads the first keyId, Fedify the last, so the key is asked of the Store (remoteKey), which refuses.
    const headers = new Headers(init.headers);
    headers.set("signature", `keyId="https://other.example/k",${headers.get("signature")!}`);

    expect(await t.send({ ...init, headers })).toBe(202);
    expect(t.h.queue.pending).toHaveLength(1);
    expect(await follows(t.store)).toEqual([]);
  });
});

// An actor listing, beside its readable keys, keys Mastodon 4.7 reads and Fedify 2.4.5 cannot import (an ML-DSA-44
// Multikey, an unknown multicodec, an EC legacy key) and nulls (mastodon#40194).
async function unreadableKeysActor(t: { web: RemoteWeb }, username: string) {
  const carol = await multikeyActor(t.web, username);
  const { uri } = carol.actor;
  const methods = carol.document.assertionMethod as unknown[];
  const document = {
    ...carol.document,
    publicKey: [carol.document.publicKey, { id: `${uri}#ec-key`, owner: uri, publicKeyPem: await ecPem() }, null],
    assertionMethod: [
      ...methods,
      { id: `${uri}#mldsa-key`, type: "Multikey", controller: uri, publicKeyMultibase: ML_DSA_44_MULTIBASE },
      null,
      { id: `${uri}#k1-key`, type: "Multikey", controller: uri, publicKeyMultibase: UNKNOWN_MULTIBASE },
    ],
  };
  t.web.serve(uri, document);
  // Fedify alone cannot parse the document as served.
  await expect(
    Person.fromJsonLd(document, { documentLoader: servedLoader(t.web), contextLoader: servedLoader(t.web) }),
  ).rejects.toThrow(/./);
  return { ...carol, document };
}

describe("an actor whose document lists keys Kopje cannot read (ID-1)", () => {
  it("is usable on first contact, its readable keys stored", async () => {
    const t = await setup();
    const carol = await unreadableKeysActor(t, "carol");
    expect(await t.post(carol.actor, follow(carol.actor))).toBe(202);
    expect(await follows(t.store)).toHaveLength(1);
    expect(await keys(t.store)).toEqual([{ key_id: carol.actor.keyId, pem: carol.actor.pem }]);
  });

  it("is found by search resolution", async () => {
    const t = await statusSetup();
    const carol = await unreadableKeysActor(t, "carol");
    const found = await t.api<{ accounts: { acct: string }[] }>(
      `/api/v2/search?resolve=true&type=accounts&q=${encodeURIComponent(carol.actor.uri)}`,
    );
    expect(found.body.accounts.map((a) => a.acct)).toEqual(["carol@mastodon.example"]);
  });
});

// Eleven legacy keys of `actor`, its own first, each with its key material: the first MAX_PUBLIC_KEYS and one more.
function elevenKeys(actor: TestActor) {
  return Array.from({ length: 11 }, (_, i) => ({
    id: i === 0 ? actor.keyId : `${actor.uri}#key-${i}`,
    owner: actor.uri,
    publicKeyPem: actor.pem,
  }));
}

describe("the keys read per actor (ID-1, RES-6)", () => {
  it("reads ten entries of publicKey from a recognized context: a signature by the eleventh is refused", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    t.web.serve(bob.uri, { ...bob.document, publicKey: elevenKeys(bob) });
    expect(await t.post(bob, follow(bob))).toBe(202);
    expect(await keys(t.store)).toHaveLength(10);
    const eleventh = await signedInit(bob, "/inbox", follow(bob), { keyId: `${bob.uri}#key-10` });
    // Fedify alone finds the eleventh key in the document as served, and verifies.
    expect(await fedifyAlone(t.web, eleventh)).toMatchObject({ verified: true });
    expect(await t.refusals(eleventh)).toEqual({ status: 401, refused: INVALID });
    expect(await follows(t.store)).toHaveLength(1);
  });

  it("stores ten keys from a context it does not recognize, and refuses the 11th legacy key", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    // An instance-hosted context, as Pleroma and Akkoma serve litepub-0.1.jsonld.
    const litepub = `${MASTODON}/schemas/litepub-0.1.jsonld`;
    t.web.serve(litepub, { "@context": [AS, "https://w3id.org/security/v1"] }, "application/ld+json");
    t.web.serve(bob.uri, {
      ...bob.document,
      "@context": [AS, litepub, { "@language": "und" }],
      publicKey: elevenKeys(bob),
    });
    expect(await t.post(bob, follow(bob))).toBe(202);
    const stored = await keys(t.store);
    expect(stored).toHaveLength(10);
    const eleventh = await signedInit(bob, "/inbox", follow(bob), { keyId: `${bob.uri}#key-10` });
    expect(await fedifyAlone(t.web, eleventh)).toMatchObject({ verified: true });
    expect(await t.refusals(eleventh)).toEqual({
      status: 401,
      refused: [[{ event: "kopje.inbox.refused", status: 401, reason: "not-key-owner" }]],
    });
    expect(await keys(t.store)).toEqual(stored);
    expect(await follows(t.store)).toHaveLength(1);
  });
});

describe("a document whose context gives publicKey another meaning (ID-1, ID-4)", () => {
  it("applies a Move whose target lists the mover as its eleventh alias under publicKey, its document kept whole", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const carol = await mastodonActor(t.web, "carol", { origin: "https://new.example", key: 2 });
    const aliases = [...Array.from({ length: 10 }, (_, i) => `https://other.example/users/${i}`), bob.uri];
    // A valid JSON-LD redefinition no known sender writes: Fedify alone reads the eleven values as aliases.
    const target = {
      ...carol.document,
      "@context": [AS, "https://w3id.org/security/v1", { publicKey: { "@id": "as:alsoKnownAs", "@type": "@id" } }],
      publicKey: aliases,
    };
    t.web.serve(carol.uri, target);
    const parsed = await Person.fromJsonLd(target, {
      documentLoader: servedLoader(t.web),
      contextLoader: servedLoader(t.web),
    });
    expect(parsed.aliasIds.map((id) => id.href)).toEqual(aliases);
    expect(await t.post(bob, follow(bob))).toBe(202);
    const move = { "@context": AS, id: `${bob.uri}#moves/1`, type: "Move", actor: bob.uri, object: bob.uri };
    const logged = await loggedRefusals(() => t.post(bob, { ...move, target: carol.uri }));
    expect(logged).toEqual({ status: 202, refused: [] });
    const [moved] = await sql<{ moved: string | null }>(
      t.store,
      "SELECT m.uri AS moved FROM accounts a LEFT JOIN accounts m ON m.id = a.moved_to_account_id WHERE a.uri = ?",
      bob.uri,
    );
    expect(moved).toEqual({ moved: carol.uri });
    const [raw] = await sql<{ raw: string }>(t.store, "SELECT raw FROM accounts WHERE uri = ?", carol.uri);
    expect((JSON.parse(raw!.raw) as { publicKey: unknown }).publicKey).toEqual(aliases);
  });
});
