import { exportMultibaseKey, importSpki } from "@fedify/fedify";
import { Person } from "@fedify/vocab";
import { describe, expect, it } from "vitest";

import { handleQueue } from "../src/jobs/queue";
import type { StoreStub } from "../src/platform/store-client";
import { StoreUnavailableError } from "../src/platform/store-errors";
import { RSA_ALGORITHM } from "../src/security/key-wrap";
import { sql } from "./api-helpers";
import { harness, inboxDeps, NOW } from "./app-helpers";
import { blockDomain } from "./domain-block-helpers";
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
  base64urlMultibase,
  cavageByKeyId,
  ecPem,
  type Ed25519Key,
  ed25519Key,
  fedifyAlone,
  ML_DSA_44_MULTIBASE,
  multikeyActor,
  servedLoader,
  rfc9421Init,
  type Rfc9421Options,
  UNKNOWN_MULTIBASE,
} from "./key-forms-helpers";

// The key and signature forms of Mastodon 4.7's reading (ID-1): which keys an actor's document gives it, Ed25519 HTTP
// signatures, and a draft-cavage signature naming a key that is not RSA, live and on replay.

type Json = Record<string, unknown>;

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
  const replay = async (init: RequestInit, now = NOW) => {
    const maintenance = harness(store, { MAINTENANCE: "readonly" }, BUILD, {
      keygen: fixtureKeyGen,
      loader: web.loader,
    });
    expect((await maintenance.request("/inbox", init)).status).toBe(202);
    const deps = { ...inboxDeps(() => store, web.loader), now: () => now };
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

// An actor listing, beside its readable keys (its Ed25519 Multikey written `u`-prefixed, base64url), keys Mastodon 4.7
// reads and Fedify 2.4.5 cannot import (an ML-DSA-44 Multikey, an unknown multicodec, an EC legacy key) and nulls
// (mastodon#40194).
async function unreadableKeysActor(t: { web: RemoteWeb }, username: string) {
  const carol = await multikeyActor(t.web, username);
  const { uri } = carol.actor;
  const [ed, ...methods] = carol.document.assertionMethod as Json[];
  const document = {
    ...carol.document,
    publicKey: [carol.document.publicKey, { id: `${uri}#ec-key`, owner: uri, publicKeyPem: await ecPem() }, null],
    assertionMethod: [
      { ...ed, publicKeyMultibase: await base64urlMultibase(carol.ed.publicKey) },
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

// The stored keys, each by the algorithm its PEM-SPKI names.
async function algorithms(store: StoreStub): Promise<Record<string, string>> {
  const entries = await Promise.all(
    (await keys(store)).map(async (row) => [row.key_id, (await importSpki(row.pem)).algorithm.name] as const),
  );
  return Object.fromEntries(entries);
}

const RSA = "RSASSA-PKCS1-v1_5";

describe("the keys of an actor's document (ID-1)", () => {
  it("stores a Fedify actor's legacy key and its Ed25519 and RSA Multikeys", async () => {
    const t = await setup();
    const carol = await multikeyActor(t.web, "carol");
    expect(await t.post(carol.actor, follow(carol.actor))).toBe(202);
    expect(await algorithms(t.store)).toEqual({
      [carol.ed.keyId]: "Ed25519",
      [carol.rsa.keyId]: RSA,
      [carol.actor.keyId]: RSA,
    });
  });

  it("keeps an actor usable whose document lists keys it cannot read, its readable keys stored", async () => {
    const t = await setup();
    const carol = await unreadableKeysActor(t, "carol");
    expect(await t.post(carol.actor, follow(carol.actor))).toBe(202);
    expect(await follows(t.store)).toHaveLength(1);
    expect(await keys(t.store)).toEqual(
      expect.arrayContaining([
        { key_id: carol.ed.keyId, pem: carol.ed.pem },
        { key_id: carol.rsa.keyId, pem: carol.rsa.pem },
        { key_id: carol.actor.keyId, pem: carol.actor.pem },
      ]),
    );
    expect(await keys(t.store)).toHaveLength(3);
  });

  it("finds an actor listing an ML-DSA-44 key by search resolution", async () => {
    const t = await statusSetup();
    const carol = await unreadableKeysActor(t, "carol");
    const found = await t.api<{ accounts: { acct: string }[] }>(
      `/api/v2/search?resolve=true&type=accounts&q=${encodeURIComponent(carol.actor.uri)}`,
    );
    expect(found.body.accounts.map((a) => a.acct)).toEqual(["carol@mastodon.example"]);
  });

  it("does not take a Multikey whose controller is another actor, or whose id is on another origin", async () => {
    const t = await setup();
    const carol = await multikeyActor(t.web, "carol");
    const other = await ed25519Key(`${carol.actor.uri}#other-key`, 1);
    const away = await ed25519Key("https://other.example/keys/carol", 2);
    const multikey = async (key: Ed25519Key, controller: string) => ({
      id: key.keyId,
      type: "Multikey",
      controller,
      publicKeyMultibase: await exportMultibaseKey(key.publicKey),
    });
    t.web.serve(carol.actor.uri, {
      ...carol.document,
      assertionMethod: [
        ...(carol.document.assertionMethod as Json[]),
        await multikey(other, `${MASTODON}/users/dave`),
        await multikey(away, carol.actor.uri),
      ],
    });
    expect(await t.post(carol.actor, follow(carol.actor))).toBe(202);
    expect(Object.keys(await algorithms(t.store))).toHaveLength(3);
    for (const key of [other, away]) {
      const init = await rfc9421Init(key.keyId, key.privateKey, "/inbox", follow(carol.actor));
      const served = { keyId: key.keyId, owner: carol.actor.uri, publicKey: key.publicKey };
      expect(await fedifyAlone(t.web, init, served), key.keyId).toMatchObject({ verified: true });
      expect(await t.send(init), key.keyId).toBe(401);
    }
    expect(await follows(t.store)).toHaveLength(1);
  });

  it("does not fetch a Multikey listed by reference, nor take a signature by it", async () => {
    const t = await setup();
    const carol = await multikeyActor(t.web, "carol");
    const reference = await ed25519Key(`${MASTODON}/keys/carol`, 3);
    t.web.serve(reference.keyId, {
      "@context": "https://w3id.org/security/multikey/v1",
      id: reference.keyId,
      type: "Multikey",
      controller: carol.actor.uri,
      publicKeyMultibase: await exportMultibaseKey(reference.publicKey),
    });
    t.web.serve(carol.actor.uri, {
      ...carol.document,
      assertionMethod: [...(carol.document.assertionMethod as Json[]), reference.keyId],
    });
    expect(await t.post(carol.actor, follow(carol.actor))).toBe(202);
    expect(t.web.fetched).not.toContain(reference.keyId);
    expect(Object.keys(await algorithms(t.store))).not.toContain(reference.keyId);
    const init = await rfc9421Init(reference.keyId, reference.privateKey, "/inbox", follow(carol.actor));
    const served = { keyId: reference.keyId, owner: carol.actor.uri, publicKey: reference.publicKey };
    expect(await fedifyAlone(t.web, init, served)).toMatchObject({ verified: true });
    expect(await t.send(init)).toBe(401);
    expect(await follows(t.store)).toHaveLength(1);
  });
});

// Eleven keys of `actor` in each form, its own first, sharing their material: the first MAX_PUBLIC_KEYS and one more.
function elevenKeys(actor: TestActor) {
  return Array.from({ length: 11 }, (_, i) => ({
    id: i === 0 ? actor.keyId : `${actor.uri}#key-${i}`,
    owner: actor.uri,
    publicKeyPem: actor.pem,
  }));
}

function elevenMultikeys(uri: string, multibase: string) {
  return Array.from({ length: 11 }, (_, i) => ({
    id: `${uri}#multikey-${i}`,
    type: "Multikey",
    controller: uri,
    publicKeyMultibase: multibase,
  }));
}

describe("the keys read per actor (ID-1, RES-6)", () => {
  it("reads ten entries of each form from a recognized context: a signature by either eleventh is refused", async () => {
    const t = await setup();
    const carol = await multikeyActor(t.web, "carol");
    const { uri } = carol.actor;
    t.web.serve(uri, {
      ...carol.document,
      publicKey: elevenKeys(carol.actor),
      assertionMethod: elevenMultikeys(uri, await exportMultibaseKey(carol.ed.publicKey)),
    });
    expect(await t.post(carol.actor, follow(carol.actor))).toBe(202);
    expect(await keys(t.store)).toHaveLength(20);
    const legacy = await signedInit(carol.actor, "/inbox", follow(carol.actor), { keyId: `${uri}#key-10` });
    const multikey = await rfc9421Init(`${uri}#multikey-10`, carol.ed.privateKey, "/inbox", follow(carol.actor));
    // Fedify alone finds the eleventh legacy key in the document as served, and verifies; and the eleventh Multikey,
    // which its own fetch never finds, given to it.
    expect(await fedifyAlone(t.web, legacy)).toMatchObject({ verified: true });
    const served = { keyId: `${uri}#multikey-10`, owner: uri, publicKey: carol.ed.publicKey };
    expect(await fedifyAlone(t.web, multikey, served)).toMatchObject({ verified: true });
    expect(await t.refusals(legacy)).toEqual({ status: 401, refused: INVALID });
    expect(await t.refusals(multikey)).toEqual({ status: 401, refused: INVALID });
    expect(await follows(t.store)).toHaveLength(1);
  });

  it("refuses the 11th legacy key of an unrecognized context", async () => {
    const t = await setup();
    const carol = await multikeyActor(t.web, "carol");
    const { uri } = carol.actor;
    // An instance-hosted context, as Pleroma and Akkoma serve litepub-0.1.jsonld, here defining what Fedify's does.
    const litepub = `${MASTODON}/schemas/litepub-0.1.jsonld`;
    t.web.serve(litepub, { "@context": carol.document["@context"] }, "application/ld+json");
    t.web.serve(uri, {
      ...carol.document,
      "@context": [litepub, { "@language": "und" }],
      publicKey: elevenKeys(carol.actor),
      assertionMethod: elevenMultikeys(uri, await exportMultibaseKey(carol.ed.publicKey)).slice(0, 10),
    });
    const update = { "@context": AS, id: `${uri}#updates/1`, type: "Update", actor: uri, object: uri };
    expect(await t.post(carol.actor, follow(carol.actor))).toBe(202);
    expect(await t.post(carol.actor, update)).toBe(202);
    const stored = await keys(t.store);
    expect(stored).toHaveLength(20);
    const eleventh = await signedInit(carol.actor, "/inbox", follow(carol.actor), { keyId: `${uri}#key-10` });
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

const DAY = 24 * 60 * 60 * 1000;

// A Fedify actor whose keys the Store holds, stored by its first Follow (signed with its legacy RSA key).
async function knownActor(t: Awaited<ReturnType<typeof setup>>, username = "carol") {
  const carol = await multikeyActor(t.web, username);
  expect(await t.post(carol.actor, follow(carol.actor))).toBe(202);
  const loads = () => t.web.fetched.filter((url) => url === carol.actor.uri).length;
  return { ...carol, loads };
}

describe("RFC 9421 signatures by an Ed25519 key (ID-1)", () => {
  it("verifies one by a stored Multikey without fetching, and one on first contact with one load", async () => {
    const t = await setup();
    const carol = await knownActor(t);
    const before = carol.loads();
    expect(await t.send(await rfc9421Init(carol.ed.keyId, carol.ed.privateKey, "/inbox", follow(carol.actor)))).toBe(
      202,
    );
    expect(carol.loads()).toBe(before);
    expect(await follows(t.store)).toHaveLength(1);

    const dan = await multikeyActor(t.web, "dan", { key: 1 });
    const loads = () => t.web.fetched.filter((url) => url === dan.actor.uri).length;
    expect(await t.send(await rfc9421Init(dan.ed.keyId, dan.ed.privateKey, "/inbox", follow(dan.actor)))).toBe(202);
    expect(loads()).toBe(1);
    expect(await follows(t.store)).toHaveLength(2);
    expect(await algorithms(t.store)).toMatchObject({ [dan.ed.keyId]: "Ed25519", [dan.actor.keyId]: RSA });
  });

  it("resolves a key stored more than a day ago from the current document", async () => {
    const t = await setup();
    const carol = await knownActor(t);
    await sql(t.store, "UPDATE remote_keys SET fetched_at = ?", NOW - DAY - 60 * 60 * 1000);
    const before = carol.loads();
    expect(await t.send(await rfc9421Init(carol.ed.keyId, carol.ed.privateKey, "/inbox", follow(carol.actor)))).toBe(
      202,
    );
    expect(carol.loads()).toBe(before + 1);
  });

  it("verifies with the algorithm alg names, and refuses an alg of another key type", async () => {
    const t = await setup();
    const carol = await knownActor(t);
    const signed = (
      key: { keyId: string; privateKey: CryptoKey },
      alg: string,
      algorithm?: Rfc9421Options["algorithm"],
    ) =>
      rfc9421Init(key.keyId, key.privateKey, "/inbox", follow(carol.actor), {
        alg,
        ...(algorithm ? { algorithm } : {}),
      });
    expect(await t.send(await signed(carol.ed, "ed25519"))).toBe(202);
    expect(await t.send(await signed(carol.ed, "rsa-v1_5-sha256"))).toBe(401);
    expect(await t.send(await signed(carol.rsa, "ed25519", RSA_ALGORITHM))).toBe(401);
    expect(await t.send(await signed(carol.rsa, "rsa-v1_5-sha256", RSA_ALGORITHM))).toBe(202);
    expect(await follows(t.store)).toHaveLength(1);
  });

  it("holds an Ed25519 signature to the covered components Mastodon 4.7 requires", async () => {
    const t = await setup();
    const carol = await knownActor(t);
    const init = await rfc9421Init(carol.ed.keyId, carol.ed.privateKey, "/inbox", follow(carol.actor), {
      components: ["@method", "@target-uri"],
    });
    const served = { keyId: carol.ed.keyId, owner: carol.actor.uri, publicKey: carol.ed.publicKey };
    expect(await fedifyAlone(t.web, init, served)).toMatchObject({ verified: true });
    expect(await t.refusals(init)).toEqual({ status: 401, refused: INVALID });
  });

  it("verifies one by an Ed25519 key in a legacy publicKey, or in a key document of its own", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const legacy = await ed25519Key(`${bob.uri}#ed-key`, 4);
    const keyUrl = `${MASTODON}/keys/bob`;
    const own = await ed25519Key(keyUrl, 5);
    t.web.serve(bob.uri, {
      ...bob.document,
      publicKey: [bob.document.publicKey, { id: legacy.keyId, owner: bob.uri, publicKeyPem: legacy.pem }, keyUrl],
    });
    t.web.serve(keyUrl, {
      "@context": "https://w3id.org/security/v1",
      id: keyUrl,
      type: "CryptographicKey",
      owner: bob.uri,
      publicKeyPem: own.pem,
    });
    for (const key of [legacy, own]) {
      expect(await t.send(await rfc9421Init(key.keyId, key.privateKey, "/inbox", follow(bob))), key.keyId).toBe(202);
    }
    expect(await keys(t.store)).toEqual(
      expect.arrayContaining([
        { key_id: legacy.keyId, pem: legacy.pem },
        { key_id: keyUrl, pem: own.pem },
      ]),
    );
  });

  it("replays a spooled Ed25519 request, its key resolved at replay and its signature judged at spool time", async () => {
    const t = await setup();
    const carol = await multikeyActor(t.web, "carol");
    const init = await rfc9421Init(carol.ed.keyId, carol.ed.privateKey, "/inbox", follow(carol.actor));
    const { queue, refused } = await t.replay(init, NOW + 2 * 60 * 60 * 1000);
    // Applied at once: not retried (what the Queue still holds is the Accept's delivery doorbell).
    expect(queue.retries).toBe(0);
    expect(refused).toEqual([]);
    expect(await follows(t.store)).toHaveLength(1);
  });

  it("admits a blocked actor's cleanup signed by its stored Ed25519 key, of any age, fetching nothing", async () => {
    const t = await setup();
    const carol = await knownActor(t);
    const [first] = (await sql<{ uri: string }>(t.store, "SELECT uri FROM follows")) as { uri: string }[];
    await sql(t.store, "UPDATE remote_keys SET fetched_at = ?", NOW - 30 * DAY);
    await blockDomain(t.store, "mastodon.example");
    const before = t.web.fetched.length;
    const undo = {
      "@context": AS,
      id: `${carol.actor.uri}#undo/1`,
      type: "Undo",
      actor: carol.actor.uri,
      object: first!.uri,
    };
    expect(await t.send(await rfc9421Init(carol.ed.keyId, carol.ed.privateKey, "/inbox", undo))).toBe(202);
    expect(t.web.fetched.slice(before)).toEqual([]);
    expect(await follows(t.store)).toEqual([]);
  });

  it("deletes a gone actor on its stored Ed25519 key", async () => {
    const t = await setup();
    const carol = await knownActor(t);
    await sql(t.store, "UPDATE remote_keys SET fetched_at = ?", NOW - 2 * DAY);
    t.web.fail(carol.actor.uri, 410);
    const deletion = {
      "@context": AS,
      id: `${carol.actor.uri}#delete`,
      type: "Delete",
      actor: carol.actor.uri,
      object: carol.actor.uri,
    };
    expect(await t.send(await rfc9421Init(carol.ed.keyId, carol.ed.privateKey, "/inbox", deletion))).toBe(202);
    expect(await sql(t.store, "SELECT 1 FROM accounts WHERE uri = ?", carol.actor.uri)).toEqual([]);
    expect(await follows(t.store)).toEqual([]);
  });
});

describe("a key replaced under the same id (ID-1)", () => {
  // The Store holds carol's Ed25519 Multikey fresh; her document now embeds another under the same id.
  async function rotated(t: Awaited<ReturnType<typeof setup>>) {
    const carol = await knownActor(t);
    const next = await ed25519Key(carol.ed.keyId, 6);
    const methods = carol.document.assertionMethod as Json[];
    t.web.serve(carol.actor.uri, {
      ...carol.document,
      assertionMethod: [{ ...methods[0], publicKeyMultibase: await exportMultibaseKey(next.publicKey) }, methods[1]],
    });
    return { carol, next };
  }

  it("verifies a signature by the replacement at once, loading the document once, and stores it", async () => {
    const t = await setup();
    const { carol, next } = await rotated(t);
    const init = await rfc9421Init(next.keyId, next.privateKey, "/inbox", follow(carol.actor));
    // Fedify alone, given the old key, refetches the key past its cache and finds no Multikey there.
    const old = { keyId: carol.ed.keyId, owner: carol.actor.uri, publicKey: carol.ed.publicKey };
    expect(await fedifyAlone(t.web, init, old)).toMatchObject({
      verified: false,
      reason: { type: "invalidSignature" },
    });
    const before = carol.loads();
    expect(await t.send(init)).toBe(202);
    expect(carol.loads()).toBe(before + 1);
    expect(await follows(t.store)).toHaveLength(1);
    expect(await keys(t.store)).toContainEqual({ key_id: next.keyId, pem: next.pem });
  });

  it("verifies it on replay too", async () => {
    const t = await setup();
    const { carol, next } = await rotated(t);
    await sql(t.store, "DELETE FROM follows");
    const { queue, refused } = await t.replay(
      await rfc9421Init(next.keyId, next.privateKey, "/inbox", follow(carol.actor)),
    );
    expect(queue.retries).toBe(0);
    expect(refused).toEqual([]);
    expect(await follows(t.store)).toHaveLength(1);
    expect(await keys(t.store)).toContainEqual({ key_id: next.keyId, pem: next.pem });
  });

  it("refuses a signature by a third key, verifying at most twice with one load", async () => {
    const t = await setup();
    const { carol } = await rotated(t);
    const third = await ed25519Key(carol.ed.keyId, 7);
    const before = carol.loads();
    const init = await rfc9421Init(third.keyId, third.privateKey, "/inbox", follow(carol.actor));
    expect(await t.refusals(init)).toEqual({ status: 401, refused: INVALID });
    expect(carol.loads()).toBe(before + 1);
    expect(await keys(t.store)).toContainEqual({ key_id: carol.ed.keyId, pem: carol.ed.pem });
  });

  it("refuses a blocked actor's replacement key, fetching nothing", async () => {
    const t = await setup();
    const { carol, next } = await rotated(t);
    const [first] = (await sql<{ uri: string }>(t.store, "SELECT uri FROM follows")) as { uri: string }[];
    await blockDomain(t.store, "mastodon.example");
    const before = t.web.fetched.length;
    const undo = {
      "@context": AS,
      id: `${carol.actor.uri}#undo/1`,
      type: "Undo",
      actor: carol.actor.uri,
      object: first!.uri,
    };
    expect(await t.send(await rfc9421Init(next.keyId, next.privateKey, "/inbox", undo))).toBe(401);
    expect(t.web.fetched.slice(before)).toEqual([]);
    expect(await follows(t.store)).toHaveLength(1);
  });

  it("verifies an RFC 9421 signature by an Ed25519 key replacing an RSA legacy key, and stores it", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    expect(await t.post(bob, follow(bob))).toBe(202);
    const ed = await ed25519Key(bob.keyId, 8);
    t.web.serve(bob.uri, { ...bob.document, publicKey: { id: bob.keyId, owner: bob.uri, publicKeyPem: ed.pem } });
    expect(await t.send(await rfc9421Init(ed.keyId, ed.privateKey, "/inbox", follow(bob)))).toBe(202);
    expect(await keys(t.store)).toEqual([{ key_id: bob.keyId, pem: ed.pem }]);
  });
});

describe("a draft-cavage signature naming an Ed25519 key Kopje serves (ID-1)", () => {
  it("refuses one naming a stored Multikey, live, from a blocked actor and in an envelope with no usable actor", async () => {
    const t = await setup();
    const carol = await knownActor(t);
    const served = { keyId: carol.ed.keyId, owner: carol.actor.uri, publicKey: carol.ed.publicKey };
    const init = await cavageByKeyId(carol.ed.keyId, "/inbox", follow(carol.actor));
    await expect(fedifyAlone(t.web, init, served)).rejects.toMatchObject({ name: "InvalidAccessError" });
    expect(await t.refusals(init)).toEqual({ status: 401, refused: INVALID });
    const envelope = { "@context": AS, id: `${MASTODON}/activities/no-actor`, type: "Follow", object: ALICE_URI };
    expect(await t.send(await cavageByKeyId(carol.ed.keyId, "/inbox", envelope))).toBe(401);
    await blockDomain(t.store, "mastodon.example");
    const [first] = (await sql<{ uri: string }>(t.store, "SELECT uri FROM follows")) as { uri: string }[];
    const undo = {
      "@context": AS,
      id: `${carol.actor.uri}#undo/1`,
      type: "Undo",
      actor: carol.actor.uri,
      object: first!.uri,
    };
    expect(await t.send(await cavageByKeyId(carol.ed.keyId, "/inbox", undo))).toBe(401);
    expect(await follows(t.store)).toHaveLength(1);
  });

  it("refuses one naming a Multikey resolved on first contact", async () => {
    const t = await setup();
    const carol = await multikeyActor(t.web, "carol");
    const init = await cavageByKeyId(carol.ed.keyId, "/inbox", follow(carol.actor));
    const served = { keyId: carol.ed.keyId, owner: carol.actor.uri, publicKey: carol.ed.publicKey };
    await expect(fedifyAlone(t.web, init, served)).rejects.toMatchObject({ name: "InvalidAccessError" });
    expect(await t.refusals(init)).toEqual({ status: 401, refused: INVALID });
    expect(t.web.fetched).toContain(carol.actor.uri);
    expect(await follows(t.store)).toEqual([]);
    expect(await keys(t.store)).toEqual([]);
  });

  it("refuses, fetching nothing, an envelope with no usable actor whose signature fails under a stored key", async () => {
    const t = await setup();
    const carol = await knownActor(t);
    const before = t.web.fetched.length;
    const envelope = { "@context": AS, id: `${MASTODON}/activities/no-actor`, type: "Follow", object: ALICE_URI };
    // An algorithm Fedify does not know fails the stored key without a refetch: no second pass resolves it.
    const init = await rfc9421Init(carol.ed.keyId, carol.ed.privateKey, "/inbox", envelope, { alg: "x-unknown" });
    expect(await t.send(init)).toBe(401);
    expect(t.web.fetched.slice(before)).toEqual([]);
  });
});
