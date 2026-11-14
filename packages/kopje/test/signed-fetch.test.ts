import { type DocumentLoader, verifyRequestDetailed } from "@fedify/fedify";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { FetchSigner } from "../src/domain/actors";
import {
  createKopjeFederation,
  createRemoteLoaders,
  type FederationState,
  instanceActorKey,
} from "../src/federation/federation";
import { DoKvStore } from "../src/federation/kv-store";
import { RefusedFetchError, requestBudget, TransientFetchError } from "../src/federation/loader";
import type { StoreStub } from "../src/platform/store-client";
import { sql } from "./api-helpers";
import { countingStore, harness, NOW } from "./app-helpers";
import {
  fixtureKeyGen,
  LEGACY,
  LEGACY_EMPTY_KEK,
  seedFollow,
  seedLocalAccount,
  seedRemoteAccount,
  setDomain,
  verifyCavage,
} from "./federation-helpers";
import { BUILD, completeSetup, migratedStore } from "./helpers";
import { LOCAL, mastodonActor, RemoteWeb, signedInit } from "./inbox-helpers";

const DOMAIN = "social.example";
const NOTE = "https://remote.example/notes/1";

// refuseCavage: the status the remote answers a request without Signature-Input with, as a remote accepting only
// RFC 9421 would.
async function setup(contentType = "application/activity+json", refuseCavage?: number) {
  const store = await migratedStore();
  await setDomain(store, DOMAIN);
  await seedLocalAccount(store, DOMAIN, { id: "111111111111111111", username: "Alice" });
  const requests: Request[] = [];
  const fetch = ((input: RequestInfo | URL) => {
    const request = input instanceof Request ? input : new Request(input);
    requests.push(request);
    if (refuseCavage !== undefined && !request.headers.has("signature-input")) {
      return Promise.resolve(new Response(null, { status: refuseCavage }));
    }
    return Promise.resolve(Response.json({ id: NOTE, type: "Note" }, { headers: { "content-type": contentType } }));
  }) as typeof globalThis.fetch;
  const state: FederationState = { resolvedUsername: null, source: null, storeError: null, ticket: null };
  const federation = createKopjeFederation(
    {
      domain: DOMAIN,
      build: BUILD,
      store: () => store,
      kek: LEGACY.kek,
      now: () => NOW,
      keygen: fixtureKeyGen,
      loader: { fetch, checkHost: () => Promise.resolve() },
    },
    state,
  );
  const ctx = federation.createContext(new URL(`https://${DOMAIN}`), state);
  return { store, requests, ctx };
}

describe("signed fetches", () => {
  it("signs fetches without a specific recipient as the instance actor", async () => {
    const { requests, ctx } = await setup();
    await ctx.documentLoader(NOTE);

    const signature = requests[0]?.headers.get("signature") ?? "";
    expect(signature).toContain('keyId="https://social.example/actor#main-key"');
    expect(await verifyCavage(requests[0] as Request, LEGACY_EMPTY_KEK.pubkey)).toBe(true);
  });

  it("signs a recipient's fetches with the recipient's key", async () => {
    const { requests, ctx } = await setup();
    const loader = await ctx.getDocumentLoader({ identifier: "Alice" });
    await loader(NOTE);

    expect(requests[0]?.headers.get("signature")).toContain('keyId="https://social.example/ap/users/Alice#main-key"');
    expect(await verifyCavage(requests[0] as Request, LEGACY.pubkey)).toBe(true);
  });

  it("caches signed documents per signing key, apart from each other and from unsigned ones", async () => {
    const { store, requests, ctx } = await setup();
    const alice = await ctx.getDocumentLoader({ identifier: "Alice" });
    await alice(NOTE);
    await alice(NOTE);
    expect(requests).toHaveLength(1);
    await ctx.documentLoader(NOTE);
    expect(requests).toHaveLength(2);

    const keys = await runInDurableObject(store, (_instance, state) =>
      state.storage.sql
        .exec<{ key: string }>('SELECT key FROM fedify_kv WHERE key LIKE \'["_fedify","signedRemoteDocument"%\'')
        .toArray()
        .map((row) => JSON.parse(row.key) as string[]),
    );
    expect(keys).toEqual(
      expect.arrayContaining([
        ["_fedify", "signedRemoteDocument", "v2", "https://social.example/actor#main-key", NOTE],
        ["_fedify", "signedRemoteDocument", "v2", "https://social.example/ap/users/Alice#main-key", NOTE],
      ]),
    );
  });

  it("has key pairs for local actors and the instance actor only", async () => {
    const { ctx } = await setup();
    expect((await ctx.getActorKeyPairs("Alice")).map((pair) => pair.keyId.href)).toEqual([
      "https://social.example/ap/users/Alice#main-key",
    ]);
    expect((await ctx.getActorKeyPairs("kopje:instance")).map((pair) => pair.keyId.href)).toEqual([
      "https://social.example/actor#main-key",
    ]);
    expect(await ctx.getActorKeyPairs("nobody")).toEqual([]);
  });

  it("has no key pairs for a spelling other than the stored username", async () => {
    const { ctx } = await setup();
    expect(await ctx.getActorKeyPairs("alice")).toEqual([]);
    expect(await ctx.getActorKeyPairs("ALICE")).toEqual([]);
  });

  // Plain JSON-LD is a context, never an object (GHSA-jhrq-qvrm-qr36): only the context loader takes it.
  it("takes plain JSON-LD on the context loader only", async () => {
    const { ctx } = await setup("application/ld+json");
    await expect(ctx.documentLoader(NOTE)).rejects.toThrow(/Not an ActivityPub document/);
    const alice = await ctx.getDocumentLoader({ identifier: "Alice" });
    await expect(alice(NOTE)).rejects.toThrow(/Not an ActivityPub document/);
    expect((await ctx.contextLoader(NOTE)).document).toMatchObject({ id: NOTE });
  });

  // A cache entry admitted under an older, looser acceptance policy is never served after the policy is tightened.
  it("ignores signed documents cached under the unversioned namespace", async () => {
    const { store, requests, ctx } = await setup();
    const stale = { contextUrl: null, documentUrl: NOTE, document: { id: NOTE, type: "Note", content: "stale" } };
    const kv = new DoKvStore(
      () => store,
      BUILD,
      () => NOW,
    );
    await kv.set(["_fedify", "signedRemoteDocument", "https://social.example/actor#main-key", NOTE], stale);

    expect((await ctx.documentLoader(NOTE)).document).toEqual({ id: NOTE, type: "Note" });
    expect(requests).toHaveLength(1);
  });
});

const ALICE = "111111111111111111";
const ALICE_KEY = "https://social.example/ap/users/Alice#main-key";
const INSTANCE_KEY = "https://social.example/actor#main-key";
const REMOTE = "https://remote.example";
const note = (n: number, origin = REMOTE) => `${origin}/notes/${n}`;

const storeInstanceKey = (store: StoreStub) =>
  instanceActorKey((call) => call(store), BUILD, LEGACY.kek, fixtureKeyGen);

// DATA-7's rule in its one place (domain/actors.ts fetchSignerOf), through the Store's read: the designated local key
// while it may sign, else the instance key, null before the instance key's first use. Keys stay wrapped (DATA-1).
describe("the signer of a fetch (DATA-7)", () => {
  async function store(options: { instanceKey?: boolean } = {}) {
    const s = await migratedStore();
    await setDomain(s, DOMAIN);
    await seedLocalAccount(s, DOMAIN, { id: ALICE, username: "Alice" });
    await seedRemoteAccount(s, "333333333333333333", `${REMOTE}/users/bob`, "remote.example");
    const instance = options.instanceKey === false ? null : await storeInstanceKey(s);
    return { s, instance };
  }
  const alice = { username: "Alice", key: { privkey: LEGACY.privkey, salt: LEGACY.salt, pubkey: LEGACY.pubkey } };
  const follower = { follower: ALICE, of: "333333333333333333" };

  it("chooses an available recipient by its exact username, else the instance actor", async () => {
    const { s, instance } = await store();
    expect(await s.fetchSigner(BUILD, { by: "Alice" })).toEqual(alice);
    expect(await s.fetchSigner(BUILD, { by: "alice" })).toEqual({ username: null, key: instance });
    expect(await s.fetchSigner(BUILD, { by: null })).toEqual({ username: null, key: instance });
    await runInDurableObject(s, (_instance, state) => {
      state.storage.sql.exec("UPDATE local_accounts SET suspended_at = '2026-10-01T00:00:00.000Z'");
    });
    expect(await s.fetchSigner(BUILD, { by: "Alice" })).toEqual({ username: null, key: instance });
  });

  it("chooses a follower while it follows, else the instance actor", async () => {
    const { s, instance } = await store();
    expect(await s.fetchSigner(BUILD, { by: follower })).toEqual({ username: null, key: instance });
    await seedFollow(s, ALICE, "333333333333333333");
    expect(await s.fetchSigner(BUILD, { by: follower })).toEqual(alice);
  });

  it("hands over no instance key before its first use", async () => {
    const { s } = await store({ instanceKey: false });
    expect(await s.fetchSigner(BUILD, { by: null })).toEqual({ username: null, key: null });
    expect(await s.fetchSigner(BUILD, { by: "Alice" })).toEqual(alice);
  });
});

// The loaders' side of a fetch preparation (federation.ts): a ticket answers the next policy check alone, and only for
// its host (VIS-30); a prepared or offered signer saves the signer read, and is unwrapped on the first fetch (DATA-1).
describe("fetch preparations in the loaders", () => {
  async function loaders(options: { instanceKey?: boolean } = {}) {
    const store = await migratedStore();
    await setDomain(store, DOMAIN);
    await seedLocalAccount(store, DOMAIN, { id: ALICE, username: "Alice" });
    if (options.instanceKey !== false) {
      await storeInstanceKey(store);
    }
    const web = new RemoteWeb();
    for (const url of [note(1), note(2), note(3), note(1, "https://other.example")]) {
      web.serve(url, { id: url, type: "Note" });
    }
    const { stub, calls, records } = countingStore(store);
    const state: FederationState = { resolvedUsername: null, source: null, storeError: null, ticket: null };
    const deps = {
      domain: DOMAIN,
      build: BUILD,
      store: () => stub,
      kek: LEGACY.kek,
      now: () => NOW,
      keygen: fixtureKeyGen,
      loader: web.loader,
    };
    const create = (by: string | null = null, prepared: FetchSigner | null = null, timeoutMs?: number) =>
      createRemoteLoaders(
        timeoutMs === undefined ? deps : { ...deps, loader: { ...deps.loader, timeoutMs } },
        state,
        by,
        requestBudget(Date.now()),
        prepared,
      );
    const signerOf = (url: string) => web.signers[web.fetched.indexOf(url)];
    const asked = () =>
      records.filter((r) => r.name === "fetchRefused").map((r) => (r.args[1] as { host: string }).host);
    return { store, web, calls, state, create, signerOf, asked };
  }

  it("answers the next request to its host with the ticket, once", async () => {
    const { store, calls, state, create } = await loaders();
    const l = create(null, await store.fetchSigner(BUILD, { by: null }));
    state.ticket = { host: "remote.example", refused: false };
    await l.document(note(1));
    expect(calls).toEqual([]);
    expect(state.ticket).toBeNull();
    await l.document(note(2));
    expect(calls).toEqual(["fetchRefused"]);
  });

  it("refuses with a refused ticket, asking the Store nothing and requesting nothing", async () => {
    const { store, web, calls, state, create } = await loaders();
    const l = create(null, await store.fetchSigner(BUILD, { by: null }));
    state.ticket = { host: "remote.example", refused: true };
    await expect(l.document(note(1))).rejects.toBeInstanceOf(RefusedFetchError);
    expect(calls).toEqual([]);
    expect(web.fetched).toEqual([]);
  });

  it("spends the ticket on the next check whatever its host, so both requests then ask the Store", async () => {
    const { store, state, create, asked } = await loaders();
    const l = create(null, await store.fetchSigner(BUILD, { by: null }));
    state.ticket = { host: "remote.example", refused: false };
    await l.document(note(1, "https://other.example"));
    expect(state.ticket).toBeNull();
    await l.document(note(1));
    expect(asked()).toEqual(["other.example", "remote.example"]);
  });

  it("lets one of two concurrent requests to its host take the ticket; the other asks the Store", async () => {
    const { store, web, state, create, asked } = await loaders();
    const l = create(null, await store.fetchSigner(BUILD, { by: null }));
    state.ticket = { host: "remote.example", refused: false };
    // Both start before either reaches the remote, where each waits once past its policy check.
    const held = [web.hold(note(1)), web.hold(note(2))];
    const loads = [l.document(note(1)), l.document(note(2))];
    await Promise.all(held.map((h) => h.reached));
    expect(asked()).toEqual(["remote.example"]);
    expect(state.ticket).toBeNull();
    held.forEach((h) => h.release());
    await Promise.all(loads);
    expect(asked()).toEqual(["remote.example"]);
  });

  // The held fetch never answers, so the first loaders' timeout is what ends the first load; it leaves that load room
  // to reach the remote on a loaded runner. The later load, on loaders sharing the state, keeps the default timeout so
  // that only the held load can time out.
  it("leaves nothing for a later request when the load that took the ticket times out", async () => {
    const { store, web, state, create, asked } = await loaders();
    const signer = await store.fetchSigner(BUILD, { by: null });
    state.ticket = { host: "remote.example", refused: false };
    const held = web.hold(note(1));
    await expect(create(null, signer, 1000).document(note(1))).rejects.toBeInstanceOf(TransientFetchError);
    await held.reached;
    expect(asked()).toEqual([]);
    await create(null, signer).document(note(2));
    expect(asked()).toEqual(["remote.example"]);
    held.release();
  });

  it("signs with a prepared signer, reading none", async () => {
    const { store, calls, create, signerOf } = await loaders();
    const l = create("Alice", await store.fetchSigner(BUILD, { by: "Alice" }));
    await l.document(note(1));
    expect(calls).toEqual(["fetchRefused"]);
    expect(signerOf(note(1))).toBe(ALICE_KEY);
  });

  it("reads the signer once, on the first fetch, when none was prepared", async () => {
    const { calls, create, signerOf } = await loaders();
    const l = create("Alice");
    expect(calls).toEqual([]);
    await l.document(note(1));
    await l.document(note(2));
    expect(calls).toEqual(["fetchSigner", "fetchRefused", "fetchRefused"]);
    expect([signerOf(note(1)), signerOf(note(2))]).toEqual([ALICE_KEY, ALICE_KEY]);
  });

  // Offered signers here name another account than the loaders' designation only to tell them apart: a need offers
  // the signer the Store chose for the same designation.
  it("takes a signer offered while none is resolved, and keeps the resolved one after", async () => {
    const { store, calls, create, signerOf } = await loaders();
    const l = create(null);
    l.offerSigner(await store.fetchSigner(BUILD, { by: "Alice" }));
    await l.document(note(1));
    l.offerSigner(await store.fetchSigner(BUILD, { by: null }));
    await l.document(note(2));
    expect(calls.filter((name) => name === "fetchSigner")).toEqual([]);
    expect([signerOf(note(1)), signerOf(note(2))]).toEqual([ALICE_KEY, ALICE_KEY]);
  });

  it("creates the instance key on its first use when the chosen signer has none", async () => {
    const { calls, create, signerOf } = await loaders({ instanceKey: false });
    await create(null).document(note(1));
    expect(calls).toEqual(["fetchSigner", "ensureInstanceActorKey", "fetchRefused"]);
    expect(signerOf(note(1))).toBe(INSTANCE_KEY);
  });
});

// The key id a request was signed with: an RFC 9421 signature's keyid, else a draft-cavage signature's keyId.
function keyIdOf(request: Request): string | undefined {
  const input = request.headers.get("signature-input");
  return input === null
    ? /keyId="([^"]+)"/.exec(request.headers.get("signature") ?? "")?.[1]
    : /;keyid="([^"]+)"/.exec(input)?.[1];
}

const formOf = (request: Request) =>
  request.headers.has("signature-input") ? "rfc9421" : request.headers.has("signature") ? "cavage" : "unsigned";

// Mastodon 4.7's RFC 9421 signature of a GET (request.rb perform_rfc9421_signed_request): exactly @method and
// @target-uri, bare, by `keyId`.
const mastodon47Get = (keyId: string) =>
  new RegExp(`^sig1=\\("@method" "@target-uri"\\);alg="rsa-v1_5-sha256";keyid="${keyId}";created=\\d+$`);

// A local actor's document as a remote verifier reads it: its id, and the key it publishes.
function publishedKey(keyId: string, pubkey: string): DocumentLoader {
  const owner = keyId.replace(/#.*$/, "");
  return (url) =>
    Promise.resolve({
      contextUrl: null,
      documentUrl: url,
      document: {
        "@context": ["https://www.w3.org/ns/activitystreams", "https://w3id.org/security/v1"],
        id: owner,
        type: "Application",
        inbox: `${owner}/inbox`,
        publicKey: { id: keyId, owner, publicKeyPem: pubkey },
      },
    });
}

// A remote that refuses draft-cavage, as one accepting only RFC 9421 would: `status` to a signed request without
// Signature-Input, `fetch` for the rest. Every request is recorded.
function refusingCavage(fetch: typeof globalThis.fetch, status = 401) {
  const requests: Request[] = [];
  const refusing = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(request);
    return formOf(request) === "cavage" ? new Response(null, { status }) : fetch(request);
  }) as typeof globalThis.fetch;
  return { fetch: refusing, requests };
}

// Mastodon 4.7's double knock for signed fetches (D8, NET-4, RES-6): a fetch answered 400 or 401 to its draft-cavage
// signature is sent once more, signed with RFC 9421 by the same key; the loader's own rules are in test/loader.test.ts.
describe("the RFC 9421 retry (NET-4, RES-6)", () => {
  it.each([401, 400])(
    "fetches once more with RFC 9421 by the same key when draft-cavage is answered %i, which Fedify verifies",
    async (status) => {
      const { requests, ctx } = await setup(undefined, status);
      expect((await ctx.documentLoader(NOTE)).document).toEqual({ id: NOTE, type: "Note" });
      const [cavage, rfc9421, ...rest] = requests;
      expect(rest).toEqual([]);
      expect(cavage?.headers.has("signature-input")).toBe(false);
      expect(await verifyCavage(cavage as Request, LEGACY_EMPTY_KEK.pubkey)).toBe(true);
      expect(rfc9421?.url).toBe(NOTE);
      expect(rfc9421?.headers.get("signature-input")).toMatch(mastodon47Get(INSTANCE_KEY));
      expect(
        await verifyRequestDetailed(rfc9421 as Request, {
          documentLoader: publishedKey(INSTANCE_KEY, LEGACY_EMPTY_KEK.pubkey),
        }),
      ).toMatchObject({ verified: true, signatureLabel: "sig1", key: { id: new URL(INSTANCE_KEY) } });
    },
  );

  it("caches a document fetched through the retry under its signing key, apart from other keys", async () => {
    const { store, requests, ctx } = await setup(undefined, 401);
    const alice = await ctx.getDocumentLoader({ identifier: "Alice" });
    await alice(NOTE);
    expect(requests.map((r) => [formOf(r), keyIdOf(r)])).toEqual([
      ["cavage", ALICE_KEY],
      ["rfc9421", ALICE_KEY],
    ]);
    expect(
      await verifyRequestDetailed(requests[1] as Request, { documentLoader: publishedKey(ALICE_KEY, LEGACY.pubkey) }),
    ).toMatchObject({ verified: true });
    await alice(NOTE);
    expect(requests).toHaveLength(2);
    await ctx.documentLoader(NOTE);
    expect(requests.slice(2).map((r) => [formOf(r), keyIdOf(r)])).toEqual([
      ["cavage", INSTANCE_KEY],
      ["rfc9421", INSTANCE_KEY],
    ]);
    const keys = await runInDurableObject(store, (_instance, state) =>
      state.storage.sql
        .exec<{ key: string }>('SELECT key FROM fedify_kv WHERE key LIKE \'["_fedify","signedRemoteDocument"%\'')
        .toArray()
        .map((row) => (JSON.parse(row.key) as string[]).slice(3)),
    );
    expect(keys).toHaveLength(2);
    expect(keys).toEqual(
      expect.arrayContaining([
        [ALICE_KEY, NOTE],
        [INSTANCE_KEY, NOTE],
      ]),
    );
  });

  // The loaders of inbound processing: the retry asks the Store's domain policy (a ticket answers only the request
  // with none before it) and charges the request's budget.
  it("asks the domain policy again before the retry and charges it to the request's budget", async () => {
    const store = await migratedStore();
    await setDomain(store, DOMAIN);
    await storeInstanceKey(store);
    const web = new RemoteWeb();
    web.serve(note(1), { id: note(1), type: "Note" });
    const refusing = refusingCavage(web.fetch);
    const { stub, records } = countingStore(store);
    const state: FederationState = { resolvedUsername: null, source: null, storeError: null, ticket: null };
    const deps = {
      domain: DOMAIN,
      build: BUILD,
      store: () => stub,
      kek: LEGACY.kek,
      now: () => NOW,
      keygen: fixtureKeyGen,
      loader: { fetch: refusing.fetch, checkHost: () => Promise.resolve() },
    };
    const budget = requestBudget(Date.now());
    const loaders = createRemoteLoaders(deps, state, null, budget, await store.fetchSigner(BUILD, { by: null }));
    state.ticket = { host: "remote.example", refused: false };
    expect((await loaders.document(note(1))).document).toEqual({ id: note(1), type: "Note" });
    expect(refusing.requests.map((r) => [formOf(r), keyIdOf(r)])).toEqual([
      ["cavage", INSTANCE_KEY],
      ["rfc9421", INSTANCE_KEY],
    ]);
    expect(records.filter((r) => r.name === "fetchRefused").map((r) => r.args[1])).toEqual([
      { host: "remote.example" },
    ]);
    expect(budget.fetches).toBe(requestBudget(0).fetches - 2);
  });

  it("applies an Update(Person) whose actor document answers draft-cavage with 401 and RFC 9421 with 200", async () => {
    const store = await migratedStore();
    await completeSetup(store);
    await seedLocalAccount(store, "kopje.test", { id: ALICE, username: "alice", key: LEGACY_EMPTY_KEK });
    const web = new RemoteWeb();
    const refusing = refusingCavage(web.fetch);
    const h = harness(store, {}, BUILD, {
      keygen: fixtureKeyGen,
      loader: { fetch: refusing.fetch, checkHost: () => Promise.resolve() },
    });
    const bob = await mastodonActor(web, "bob");
    const send = async (activity: unknown) =>
      (await h.request("/inbox", await signedInit(bob, "/inbox", activity))).status;
    const AS = "https://www.w3.org/ns/activitystreams";
    const follow = { "@context": AS, id: `${bob.uri}#follows/1`, type: "Follow", actor: bob.uri };
    expect(await send({ ...follow, object: `${LOCAL}/ap/users/alice` })).toBe(202);
    const before = refusing.requests.length;
    const updated = { ...bob.document, name: "Bob 2" };
    web.serve(bob.uri, updated);
    const update = { "@context": AS, id: `${bob.uri}#updates/1`, type: "Update", actor: bob.uri, object: updated };
    expect(await send(update)).toBe(202);
    expect(refusing.requests.slice(before).map((r) => [r.url, formOf(r)])).toEqual([
      [bob.uri, "cavage"],
      [bob.uri, "rfc9421"],
    ]);
    expect(await sql(store, "SELECT display_name FROM accounts WHERE uri = ?", bob.uri)).toEqual([
      { display_name: "Bob 2" },
    ]);
  });
});
