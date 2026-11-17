import { describe, expect, it } from "vitest";

import { createRemoteLoaders, type FederationState, instanceActorKey } from "../src/federation/federation";
import { MAX_PUBLIC_KEYS } from "../src/federation/key-entries";
import {
  isTransientLoadError,
  RefusedFetchError,
  requestBudget,
  UnusableDocumentError,
} from "../src/federation/loader";
import { MAX_JSON_NODES } from "../src/platform/json-bounds";
import { sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { fixtureKeyGen, LEGACY, setDomain } from "./federation-helpers";
import { BUILD, migratedStore } from "./helpers";
import { LOCAL, mastodonActor, RemoteWeb } from "./inbox-helpers";
import { like, setup } from "./inbox-status-helpers";

// #1718: a fetched document, a WebFinger answer or a JSON-LD context whose text holds a string token, a key or a value,
// with an unpaired surrogate is a body that does not parse (loader.ts readDocument, json-bounds.ts jsonTextMalformed;
// a cached context, federation.ts withinBounds): UnusableDocumentError, never transient, which search resolution reads
// as Mastodon's nil answer. Mastodon's body_to_json (json_ld_helper.rb:366-374) is nil for a lone high surrogate and
// keeps a lone low one, failing only where it stores the value; Kopje refuses both (docs/mastodon-deviations.md,
// "Reading inbound activities"). A document past the JSON bounds stays a refusal (RES-2).

const DOMAIN = "social.example";
const REMOTE = "https://remote.example";

async function loaders() {
  const store = await migratedStore();
  await setDomain(store, DOMAIN);
  await instanceActorKey((call) => call(store), BUILD, LEGACY.kek, fixtureKeyGen);
  const web = new RemoteWeb();
  const state: FederationState = { resolvedUsername: null, source: null, storeError: null, ticket: null };
  const deps = {
    domain: DOMAIN,
    build: BUILD,
    store: () => store,
    kek: LEGACY.kek,
    now: () => NOW,
    keygen: fixtureKeyGen,
    loader: web.loader,
  };
  return { store, web, l: createRemoteLoaders(deps, state, null, requestBudget(Date.now())) };
}

async function failure(load: Promise<unknown>): Promise<unknown> {
  try {
    await load;
  } catch (error) {
    return error;
  }
  throw new Error("loaded");
}

// A document's text with a member "junk" holding a lone high surrogate escape, which a later "junk":"ok" replaces:
// JSON.parse keeps "ok", where Mastodon's parser refuses the text.
const hidden = (document: Record<string, unknown>) =>
  JSON.stringify({ ...document, junk: "ok" }).replace(`"junk":"ok"`, String.raw`"junk":"\ud800","junk":"ok"`);

const MALFORMED: [string, Record<string, unknown>][] = [
  ["a lone high surrogate", { content: "\ud800" }],
  ["a lone low surrogate", { content: "\udc00" }],
  ["a key holding a high surrogate", { "\ud800": "x" }],
  ["an array element holding a lone low surrogate", { tag: [{ name: "a\udc00" }] }],
];

describe("a fetched document with an unpaired surrogate (#1718)", () => {
  it.each(MALFORMED)("refuses one holding %s as a body that is not JSON", async (_, extra) => {
    const { web, l } = await loaders();
    const url = `${REMOTE}/notes/1`;
    web.serve(url, { id: url, type: "Note", ...extra });
    const error = await failure(l.document(url));
    expect(error).toBeInstanceOf(UnusableDocumentError);
    expect((error as Error).message).toBe(`${url}: Document is not valid JSON`);
    expect(isTransientLoadError(error)).toBe(false);
    // As a body JSON.parse refuses.
    web.serveRaw(`${REMOTE}/notes/2`, "{");
    expect(await failure(l.document(`${REMOTE}/notes/2`))).toBeInstanceOf(UnusableDocumentError);
  });

  it("refuses one whose unpaired surrogate a duplicate key hides: a document, a context, a resolution", async () => {
    const { web, l } = await loaders();
    const note = `${REMOTE}/notes/hidden`;
    web.serveRaw(note, hidden({ id: note, type: "Note", content: "ok" }));
    expect(JSON.parse(hidden({ id: note })) as unknown).toEqual({ id: note, junk: "ok" });
    const error = await failure(l.document(note));
    expect(error).toBeInstanceOf(UnusableDocumentError);
    expect(isTransientLoadError(error)).toBe(false);
    expect(await failure(l.resolve(note, true))).toBeInstanceOf(UnusableDocumentError);
    const context = `${REMOTE}/contexts/hidden`;
    web.serveRaw(context, hidden({ "@context": { name: "https://remote.example/ns#name" } }), "application/ld+json");
    expect(await failure(l.context(context))).toBeInstanceOf(UnusableDocumentError);
    // The same texts with the duplicate holding a valid pair load.
    const pair = `${REMOTE}/notes/pair`;
    web.serveRaw(
      pair,
      hidden({ id: pair, type: "Note", content: "ok" }).replace(String.raw`\ud800`, String.raw`\ud83d\ude00`),
    );
    expect((await l.document(pair)).document).toMatchObject({ id: pair, junk: "ok" });
  });

  // The refusal runs before the document's key entries are read (key-entries.ts readableKeys), which drop an entry
  // whose key does not import and every entry past MAX_PUBLIC_KEYS: the document is refused with them, not stored
  // without.
  it.each([
    ["beside a good key", 1],
    ["past MAX_PUBLIC_KEYS", MAX_PUBLIC_KEYS],
  ])("refuses an actor with an unpaired surrogate in a key entry %s", async (_, good) => {
    const { web, l } = await loaders();
    // `good` copies of the actor's key, then an entry whose key material is `pem`.
    const actor = async (username: string, pem: string) => {
      const served = await mastodonActor(web, username);
      const key = served.document.publicKey as Record<string, unknown>;
      const keys = [...Array.from({ length: good }, () => key), { ...key, id: `${served.uri}#bad`, publicKeyPem: pem }];
      web.serve(served.uri, { ...served.document, publicKey: keys });
      return served.uri;
    };
    const error = await failure(l.document(await actor("bob", "\ud800")));
    expect(error).toBeInstanceOf(UnusableDocumentError);
    expect(isTransientLoadError(error)).toBe(false);
    // The same entry with a valid pair is dropped by readableKeys, and the actor loads with its good keys.
    const loaded = await l.document(await actor("carol", "😀"));
    expect((loaded.document as { publicKey: unknown[] }).publicKey).toHaveLength(good);
  });

  // Bytes that are not UTF-8 (a surrogate's): a JSON-LD context holding them does not parse, as Mastodon's JSON-LD
  // loader refuses it; a document reads each as U+FFFD, where Mastodon keeps the bytes (docs/mastodon-deviations.md).
  it("refuses a JSON-LD context holding bytes that are not UTF-8, and reads a document's as U+FFFD", async () => {
    const { web, l } = await loaders();
    const encoder = new TextEncoder();
    const raw = (json: unknown) => {
      const [before, after] = JSON.stringify(json).split("MARK");
      return new Uint8Array([...encoder.encode(before), 0xed, 0xb0, 0x80, ...encoder.encode(after)]);
    };
    const context = `${REMOTE}/contexts/bytes`;
    web.serveRaw(
      context,
      raw({ "@context": { name: "https://remote.example/ns#name" }, junk: "MARK" }),
      "application/ld+json",
    );
    const error = await failure(l.context(context));
    expect(error).toBeInstanceOf(UnusableDocumentError);
    expect(isTransientLoadError(error)).toBe(false);
    await failure(l.context(context));
    expect(web.fetched.filter((url) => url === context)).toHaveLength(2);
    const note = `${REMOTE}/notes/bytes`;
    web.serveRaw(note, raw({ id: note, type: "Note", content: "ok", junk: "xMARK" }));
    expect(((await l.document(note)).document as { junk: string }).junk).toBe("x\uFFFD\uFFFD\uFFFD");
  });

  it("loads one holding a surrogate pair, and refuses one past the bounds as before", async () => {
    const { web, l } = await loaders();
    const pair = `${REMOTE}/notes/pair`;
    web.serve(pair, { id: pair, type: "Note", content: "😀", "😀": 1 });
    expect((await l.document(pair)).document).toMatchObject({ id: pair, content: "😀" });
    const wide = `${REMOTE}/notes/wide`;
    web.serve(wide, { id: wide, type: "Note", tag: Array.from({ length: MAX_JSON_NODES }, () => 0) });
    const error = await failure(l.document(wide));
    expect(error).toBeInstanceOf(RefusedFetchError);
    expect(error).not.toBeInstanceOf(UnusableDocumentError);
  });

  it("refuses a JSON-LD context holding one, and caches none", async () => {
    const { web, l } = await loaders();
    const broken = `${REMOTE}/contexts/broken`;
    web.serve(broken, { "@context": { name: "https://remote.example/ns#\ud800" } }, "application/ld+json");
    const error = await failure(l.context(broken));
    expect(error).toBeInstanceOf(UnusableDocumentError);
    expect(isTransientLoadError(error)).toBe(false);
    // Not cached: the next load fetches it again.
    await failure(l.context(broken));
    expect(web.fetched.filter((url) => url === broken)).toHaveLength(2);
    const pair = `${REMOTE}/contexts/pair`;
    web.serve(pair, { "@context": { name: "https://remote.example/ns#😀" } }, "application/ld+json");
    expect((await l.context(pair)).document).toEqual({ "@context": { name: "https://remote.example/ns#😀" } });
  });

  // A context an earlier release cached is checked on every hit (boundedContexts).
  it("refuses a cached JSON-LD context holding one without fetching it", async () => {
    const { store, web, l } = await loaders();
    const cached = `${REMOTE}/contexts/cached`;
    await sql(
      store,
      "INSERT INTO fedify_kv (key, value, expires_at) VALUES (?, ?, NULL)",
      JSON.stringify(["_fedify", "remoteDocument", cached]),
      JSON.stringify({ contextUrl: null, document: { "@context": { name: "x\udc00" } }, documentUrl: cached }),
    );
    const error = await failure(l.context(cached));
    expect(error).toBeInstanceOf(UnusableDocumentError);
    expect(web.fetched).toEqual([]);
  });

  it("answers search resolution's request with a body that is not JSON (a nil answer)", async () => {
    const { web, l } = await loaders();
    const broken = `${REMOTE}/notes/broken`;
    web.serve(broken, { id: broken, type: "Note", content: "\ud800" });
    const error = await failure(l.resolve(broken, true));
    expect(error).toBeInstanceOf(UnusableDocumentError);
    const pair = `${REMOTE}/notes/pair`;
    web.serve(pair, { id: pair, type: "Note", content: "😀" });
    expect(await l.resolve(pair, true)).toMatchObject({ kind: "document", remote: { document: { id: pair } } });
  });

  it("stores no actor whose document holds one in a member no reader reads, and refuses its activity", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob", { extra: { junk: "\ud800" } });
    const carol = await mastodonActor(t.web, "carol", { key: 2, extra: { junk: "😀" } });
    expect(await t.post(bob, like(bob, `${LOCAL}/ap/o/1`))).toBe(401);
    expect(t.web.fetched).toContain(bob.uri);
    expect(await t.post(carol, like(carol, `${LOCAL}/ap/o/1`))).toBe(202);
    expect(await sql(t.store, "SELECT uri FROM accounts WHERE uri IN (?, ?) ORDER BY uri", bob.uri, carol.uri)).toEqual(
      [{ uri: carol.uri }],
    );
  });

  it("stores no actor with an unpaired surrogate in a key entry beside its signing key", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const key = bob.document.publicKey as Record<string, unknown>;
    const bad = { ...key, id: `${bob.uri}#bad`, publicKeyPem: "\ud800" };
    t.web.serve(bob.uri, { ...bob.document, publicKey: [key, bad] });
    expect(await t.post(bob, like(bob, `${LOCAL}/ap/o/1`))).toBe(401);
    expect(t.web.fetched).toContain(bob.uri);
    expect(await sql(t.store, "SELECT uri FROM accounts WHERE uri = ?", bob.uri)).toEqual([]);
  });
});
