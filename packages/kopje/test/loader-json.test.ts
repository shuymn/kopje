import { describe, expect, it } from "vitest";

import { createRemoteLoaders, type FederationState, instanceActorKey } from "../src/federation/federation";
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

// #1718: a fetched document, a WebFinger answer or a JSON-LD context holding a string or a key with an unpaired
// surrogate is a body that does not parse (federation.ts withinBounds, json-bounds.ts jsonRefusal), as Mastodon's
// body_to_json reads one (json_ld_helper.rb:366-374, nil): UnusableDocumentError, never transient, which search
// resolution reads as Mastodon's nil answer. A document past the JSON bounds stays a refusal (RES-2).

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
});
