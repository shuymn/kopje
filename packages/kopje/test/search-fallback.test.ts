import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { Db } from "../src/db/sql";
import { guessedStatusUri, storeResolved } from "../src/domain/remote-statuses";
import {
  DOCUMENT_BODY_LIMIT,
  type FetchBudget,
  REQUEST_DEADLINE_MS,
  REQUEST_MAX_BYTES,
  REQUEST_MAX_FETCHES,
} from "../src/federation/loader";
import { createResolver } from "../src/federation/resolve";
import { MAX_JSON_DEPTH } from "../src/platform/json-bounds";
import { sql } from "./api-helpers";
import { harness, NOW } from "./app-helpers";
import { blockDomain } from "./domain-block-helpers";
import { fixtureKeyGen, LEGACY_EMPTY_KEK, seedLocalAccount } from "./federation-helpers";
import { BUILD, completeSetup, migratedStore } from "./helpers";
import { AP, MASTODON, mastodonActor, RemoteWeb } from "./inbox-helpers";
import { ALICE, AS, DAVE, DAVE_URI, mastodonNote, type Note, token } from "./inbox-status-helpers";
import { seedStatus } from "./status-helpers";

// Search with resolve=true of a URL whose fetches resolve nothing (#1662; docs/threat-model.md ID-7, RES-6, VIS-1): the
// resolution carries the status of the last answer the URL's own fetches received (federation/resolve.ts resolveUrl,
// loader.ts answeredStatus), and storeResolved answers stored data by it as Mastodon 4.7.5's
// ResolveURLService#process_url_from_db (resolve_url_service.rb:38-63): the stored account after a 500, 502, 503, 504
// or no answer, the stored status (by its uri, or the uri its web address names) after a 401, 403 or 404, nothing
// otherwise, and nothing stored is removed. The interaction's side is in test/interaction.test.ts.

const TIMEOUT_MS = 500;
// Past TIMEOUT_MS: the answer comes after the load gave up.
const HELD_MS = 5_000;
const PAGE = "https://blog.example/post";
const NO_ANSWER = { kind: "none", last: null };

type Route = (request: Request) => Response | Promise<Response>;
type Found = { accounts: { id: string; acct: string }[]; statuses: { id: string; uri: string }[] };

// alice's app over RemoteWeb, with crafted answers by URL in `routes`, a DNS check that refuses the hosts in `refused`
// (NET-1) and a load timeout of TIMEOUT_MS; every request kept in `fetched`.
async function world() {
  const store = await migratedStore();
  await completeSetup(store);
  await seedLocalAccount(store, "kopje.test", { id: ALICE, username: "alice", key: LEGACY_EMPTY_KEK });
  await seedLocalAccount(store, "kopje.test", { id: DAVE, username: "dave", key: LEGACY_EMPTY_KEK });
  const web = new RemoteWeb();
  const routes = new Map<string, Route>();
  const fetched: string[] = [];
  const refused = new Set<string>();
  const fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    url.hash = "";
    fetched.push(url.href);
    const route = routes.get(url.href);
    return route === undefined ? web.fetch(request) : Promise.resolve().then(() => route(request));
  }) as typeof globalThis.fetch;
  const checkHost = (url: URL) =>
    refused.has(url.hostname) ? Promise.reject(new Error("Invalid or private address: 10.0.0.1")) : Promise.resolve();
  const loader = { fetch, checkHost, timeoutMs: TIMEOUT_MS };
  const h = harness(store, {}, undefined, { keygen: fixtureKeyGen, loader }, () => NOW);
  const bearer = await token(store, ALICE);
  const bob = await mastodonActor(web, "bob");
  const search = async (q: string) => {
    const response = await h.request(`/api/v2/search?resolve=true&q=${encodeURIComponent(q)}`, {
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(response.status).toBe(200);
    const { accounts, statuses } = await response.json<Found>();
    return { accounts, statuses };
  };
  // A resolver of its own, with the request's budget at its start given in part.
  const resolve = (url: string, budget: Partial<FetchBudget> = {}) =>
    createResolver({
      build: () => BUILD,
      store: () => store,
      now: () => NOW,
      keygen: fixtureKeyGen,
      loader,
      budget: () => ({
        fetches: REQUEST_MAX_FETCHES,
        bytes: REQUEST_MAX_BYTES,
        deadline: Date.now() + REQUEST_DEADLINE_MS,
        ...budget,
      }),
    })(h.env, url);
  // The requests to `url` that `run` makes.
  const requestsOf = async (url: string, run: () => Promise<unknown>) => {
    const from = fetched.length;
    await run();
    return fetched.slice(from).filter((href) => href === url).length;
  };
  const note = (extra: Record<string, unknown> = {}): Note => {
    const made = mastodonNote(bob, extra);
    web.serve(made.id, { "@context": AS, ...made });
    return made;
  };
  return { store, web, routes, fetched, refused, h, bob, search, resolve, requestsOf, note };
}

type World = Awaited<ReturnType<typeof world>>;

const stored = (t: World, table: "statuses" | "accounts", uri: string) =>
  sql<{ n: number }>(t.store, `SELECT count(*) AS n FROM ${table} WHERE uri = ?`, uri).then((rows) => rows[0]?.n);

const html = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { headers: { "content-type": "text/html; charset=utf-8", ...headers } });
const PLAIN_PAGE = "<!doctype html><html><head><title>t</title></head><body><p>post</p></body></html>";
const status = (code: number) => () => new Response("", { status: code });
const networkError = () => Promise.reject(new TypeError("network connection lost"));
const alternateHeader = (href: string) => ({ link: `<${href}>; rel="alternate"; type="application/activity+json"` });

// A note stored by a first search, then answered as `answer` sets it.
type Answer = (t: World, url: string) => void;
const failing =
  (code: number): Answer =>
  (t, url) =>
    t.web.fail(url, code);
// The document as served, under another 2xx status (#1687: taken only from a 200).
const servedAs =
  (code: number): Answer =>
  (t, url) => {
    const served = t.web.served.get(url);
    t.web.served.set(url, { status: code, body: served?.body });
  };
const held: Answer = (t, url) => t.web.delay(url, HELD_MS);
const lostConnection: Answer = (t, url) => t.web.fail(url, 0);

describe("the stored status after a failed fetch (S2)", () => {
  // 400 and 401 are sent twice: the RFC 9421 retry by the same key (loader.ts RETRY_STATUSES).
  it("answers a stored status after 401, 403 and 404 only", { timeout: 60_000 }, async () => {
    const t = await world();
    const note = t.note();
    const id = (await t.search(note.id)).statuses[0]?.id;
    expect(id).toBeDefined();
    const cases: { name: string; answer: Answer; answered: boolean; requests: number }[] = [
      { name: "401", answer: failing(401), answered: true, requests: 2 },
      { name: "403", answer: failing(403), answered: true, requests: 1 },
      { name: "404", answer: failing(404), answered: true, requests: 1 },
      { name: "400", answer: failing(400), answered: false, requests: 2 },
      { name: "410", answer: failing(410), answered: false, requests: 1 },
      { name: "429", answer: failing(429), answered: false, requests: 1 },
      { name: "500", answer: failing(500), answered: false, requests: 1 },
      { name: "501", answer: failing(501), answered: false, requests: 1 },
      { name: "503", answer: failing(503), answered: false, requests: 1 },
      { name: "203 with the note", answer: servedAs(203), answered: false, requests: 1 },
      { name: "a timeout", answer: held, answered: false, requests: 1 },
      { name: "a network error", answer: lostConnection, answered: false, requests: 1 },
      {
        name: "a 200 HTML page without alternate",
        answer: (w, url) => w.web.serveRaw(url, PLAIN_PAGE, "text/html"),
        answered: false,
        requests: 1,
      },
      {
        name: "a 200 document of a type not taken",
        answer: (w, url) => w.web.serve(url, { "@context": AS, id: url, type: "Collection", totalItems: 0 }),
        answered: false,
        requests: 1,
      },
    ];
    for (const c of cases) {
      t.web.serve(note.id, { "@context": AS, ...note });
      c.answer(t, note.id);
      let found: Found | undefined;
      const requests = await t.requestsOf(note.id, async () => {
        found = await t.search(note.id);
      });
      expect(requests, c.name).toBe(c.requests);
      expect(found, c.name).toEqual({ accounts: [], statuses: c.answered ? [expect.objectContaining({ id })] : [] });
      expect(await stored(t, "statuses", note.id), c.name).toBe(1);
    }
  });

  it("finds a stored status by its web address", async () => {
    const t = await world();
    const plain = t.note();
    const base = mastodonNote(t.bob);
    const long = { ...base, url: `${MASTODON}/@bob/statuses/${base.id.split("/").at(-1)}` };
    t.web.serve(long.id, { "@context": AS, ...long });
    for (const n of [plain, long]) {
      const id = (await t.search(n.id)).statuses[0]?.id;
      expect(id).toBeDefined();
      const address = n.url as string;
      // Nothing is served at the address: a 404.
      let found: Found | undefined;
      expect(await t.requestsOf(address, async () => (found = await t.search(address)))).toBe(1);
      expect(found, address).toEqual({ accounts: [], statuses: [expect.objectContaining({ id, uri: n.id })] });
    }
    // Not after an answer other than 401, 403 or 404.
    t.web.fail(plain.url as string, 503);
    expect((await t.search(plain.url as string)).statuses).toEqual([]);
  });

  it("requires both the guessed uri and the url", async () => {
    const t = await world();
    const elsewhere = t.note({ url: `${MASTODON}/@bob/elsewhere` });
    expect((await t.search(elsewhere.id)).statuses).toHaveLength(1);
    const address = `${MASTODON}/@bob/${elsewhere.id.split("/").at(-1)}`;
    expect(guessedStatusUri(address)).toBe(elsewhere.id);
    let found: Found | undefined;
    expect(await t.requestsOf(address, async () => (found = await t.search(address)))).toBe(1);
    expect(found).toEqual({ accounts: [], statuses: [] });
    expect(await stored(t, "statuses", elsewhere.id)).toBe(1);
  });

  // Mastodon's scope.first: the lower id of a status whose uri is the URL and one its web address names, whichever
  // was stored first (a remote status's id follows its `published`, ids.ts remoteId).
  it.each([
    { name: "the guessed one", guessedFirst: true },
    { name: "the one of that uri", guessedFirst: false },
  ])("answers the lower id of two: $name", async ({ guessedFirst }) => {
    const t = await world();
    const early = "2026-10-01T00:00:00Z";
    const late = "2026-10-05T00:00:00Z";
    const guessed = t.note({ published: guessedFirst ? early : late });
    const address = guessed.url as string;
    const own = mastodonNote(t.bob, { id: address, url: address, published: guessedFirst ? late : early });
    t.web.serve(address, { "@context": AS, ...own });
    // Stored in the other order than their ids.
    const [first, second] = guessedFirst ? [own, guessed] : [guessed, own];
    const ids = new Map<string, string | undefined>();
    for (const n of [first, second]) {
      ids.set(n.id, (await t.search(n.id)).statuses[0]?.id);
    }
    t.web.fail(address, 404);
    const expected = guessedFirst ? guessed.id : own.id;
    expect((await t.search(address)).statuses).toEqual([
      expect.objectContaining({ id: ids.get(expected), uri: expected }),
    ]);
  });
});

describe("the stored account after a failed fetch (S2)", () => {
  // A stored actor's id is fetched as that actor (resolve.ts resolveAccount); the answer to that fetch decides.
  it("answers a stored account after a server error or no answer only", { timeout: 60_000 }, async () => {
    const t = await world();
    const accountId = (await t.search(t.bob.uri)).accounts[0]?.id;
    expect(accountId).toBeDefined();
    const host = new URL(t.bob.uri).hostname;
    const cases: { name: string; answer: Answer; answered: boolean; requests: number }[] = [
      { name: "500", answer: failing(500), answered: true, requests: 1 },
      { name: "502", answer: failing(502), answered: true, requests: 1 },
      { name: "503", answer: failing(503), answered: true, requests: 1 },
      { name: "504", answer: failing(504), answered: true, requests: 1 },
      { name: "a network error", answer: lostConnection, answered: true, requests: 1 },
      { name: "a timeout", answer: held, answered: true, requests: 1 },
      { name: "a NET-1 refusal", answer: (w) => w.refused.add(host), answered: true, requests: 0 },
      {
        name: "a redirect to another origin",
        answer: (w, url) => w.web.redirect(url, "https://elsewhere.example/users/bob"),
        answered: true,
        requests: 1,
      },
      { name: "401", answer: failing(401), answered: false, requests: 2 },
      { name: "404", answer: failing(404), answered: false, requests: 1 },
      { name: "429", answer: failing(429), answered: false, requests: 1 },
      { name: "501", answer: failing(501), answered: false, requests: 1 },
      { name: "203 with the actor's document", answer: servedAs(203), answered: false, requests: 1 },
      {
        name: "an HTML 200",
        answer: (w, url) => w.web.serveRaw(url, PLAIN_PAGE, "text/html"),
        answered: false,
        requests: 1,
      },
      {
        name: "an unusable 200",
        answer: (w, url) => w.web.serve(url, { "@context": AS, ...mastodonNote(w.bob, { id: url }) }),
        answered: false,
        requests: 1,
      },
    ];
    for (const c of cases) {
      t.refused.clear();
      t.web.serve(t.bob.uri, t.bob.document);
      c.answer(t, t.bob.uri);
      let found: Found | undefined;
      const requests = await t.requestsOf(t.bob.uri, async () => {
        found = await t.search(t.bob.uri);
      });
      expect(requests, c.name).toBe(c.requests);
      expect(found, c.name).toEqual({
        accounts: c.answered ? [expect.objectContaining({ id: accountId, acct: "bob@mastodon.example" })] : [],
        statuses: [],
      });
      expect(await stored(t, "accounts", t.bob.uri), c.name).toBe(1);
    }
  });

  // A 410 at a stored actor's id deletes the actor (actor-gone.ts), and answers nothing.
  it("answers nothing after a 410", async () => {
    const t = await world();
    expect((await t.search(t.bob.uri)).accounts).toHaveLength(1);
    t.web.fail(t.bob.uri, 410);
    expect(await t.resolve(t.bob.uri)).toEqual({ kind: "none", last: 410 });
    expect(await t.search(t.bob.uri)).toEqual({ accounts: [], statuses: [] });
  });

  // The domain policy refuses the request before it is sent (R38): no answer.
  it("counts a domain-policy refusal as no answer", async () => {
    const t = await world();
    expect((await t.search(t.bob.uri)).accounts).toHaveLength(1);
    await blockDomain(t.store, "mastodon.example");
    expect(await t.requestsOf(t.bob.uri, async () => expect(await t.resolve(t.bob.uri)).toEqual(NO_ANSWER))).toBe(0);
  });
});

describe("the last answer of a URL's own fetches (S1)", () => {
  const ALT = "https://blog.example/alt";

  it("keeps the last answer", async () => {
    const t = await world();
    // The page answers 200, its header alternate 503.
    t.routes.set(PAGE, () => html(PLAIN_PAGE, alternateHeader(ALT)));
    t.routes.set(ALT, status(503));
    expect(await t.resolve(PAGE)).toEqual({ kind: "none", last: 503 });
    expect(t.fetched.slice(-2)).toEqual([PAGE, ALT]);
    // The alternate gets no answer: the page's 200 stays.
    t.routes.set(ALT, networkError);
    expect(await t.resolve(PAGE)).toEqual({ kind: "none", last: 200 });
    expect(t.fetched.slice(-2)).toEqual([PAGE, ALT]);
    // The probe gets no answer.
    t.routes.set(PAGE, networkError);
    expect(await t.resolve(PAGE)).toEqual(NO_ANSWER);
  });

  // A 200 the loader refuses is its 200, through the probe and through a stored actor's fetch.
  it("a refused answer counts as its status", async () => {
    const t = await world();
    let nested: unknown = "deep";
    for (let depth = 0; depth <= MAX_JSON_DEPTH; depth++) {
      nested = [nested];
    }
    const refusals: [string, Route][] = [
      ["a body past DOCUMENT_BODY_LIMIT", () => new Response("x".repeat(DOCUMENT_BODY_LIMIT + 1), ct(AP))],
      ["a string root", () => new Response(JSON.stringify(PAGE), ct(AP))],
      ["past the JSON bounds", () => Response.json({ "@context": AS, id: PAGE, type: "Note", x: nested }, ct(AP))],
    ];
    for (const [name, route] of refusals) {
      t.routes.set(PAGE, route);
      expect(await t.resolve(PAGE), name).toEqual({ kind: "none", last: 200 });
    }
    // A stored actor whose document is served as plain JSON (not ActivityStreams): no account.
    expect((await t.search(t.bob.uri)).accounts).toHaveLength(1);
    t.routes.set(t.bob.uri, () => Response.json(t.bob.document));
    expect(await t.resolve(t.bob.uri)).toEqual({ kind: "none", last: 200 });
    expect((await t.search(t.bob.uri)).accounts).toEqual([]);
  });

  // #1687: a first request answered 203 with a document of the URL is refused with its status, where the same answer
  // at 200 resolves the status.
  it("a 2xx other than 200 counts as its status", async () => {
    const t = await world();
    const note = t.note();
    t.web.served.set(note.id, { status: 203, body: { "@context": AS, ...note } });
    expect(await t.resolve(note.id)).toEqual({ kind: "none", last: 203 });
    t.web.serve(note.id, { "@context": AS, ...note });
    expect(await t.resolve(note.id)).toMatchObject({ kind: "status", status: { uri: note.id } });
  });

  it("a refused redirect counts as no answer", async () => {
    const t = await world();
    t.routes.set(PAGE, () => redirect("https://elsewhere.example/post"));
    expect(await t.requestsOf(PAGE, async () => expect(await t.resolve(PAGE)).toEqual(NO_ANSWER))).toBe(1);
    // Six same-origin redirects: the sixth is past MAX_REDIRECTS.
    const hops = [PAGE, ...[1, 2, 3, 4, 5].map((n) => `${PAGE}/${n}`)];
    hops.forEach((hop, n) => t.routes.set(hop, () => redirect(`${PAGE}/${n + 1}`)));
    const from = t.fetched.length;
    expect(await t.resolve(PAGE)).toEqual(NO_ANSWER);
    expect(t.fetched.slice(from)).toEqual(hops);
  });

  // RES-6: a request the budget refuses before it is sent is no answer, and the earlier answer stays; a body the
  // request's bytes cut after the answer arrived counts as that answer's status, as Mastodon records response_code
  // before it reads the body within its limit (fetch_resource_service.rb:47-49).
  it("a budget refusal is no answer, a cut read its answer's status", async () => {
    const t = await world();
    expect((await t.search(t.bob.uri)).accounts).toHaveLength(1);
    expect(
      await t.requestsOf(t.bob.uri, async () => expect(await t.resolve(t.bob.uri, { fetches: 0 })).toEqual(NO_ANSWER)),
    ).toBe(0);
    expect(await t.resolve(t.bob.uri, { deadline: Date.now() - 1 })).toEqual(NO_ANSWER);
    // The probe's document cut by the request's bytes.
    t.routes.set(PAGE, () => Response.json({ "@context": AS, id: PAGE, type: "Note" }, ct(AP)));
    expect(
      await t.requestsOf(PAGE, async () =>
        expect(await t.resolve(PAGE, { bytes: 10 })).toEqual({ kind: "none", last: 200 }),
      ),
    ).toBe(1);
    // The page answers 200; its alternate is past the request's fetches.
    t.routes.set(PAGE, () => html(PLAIN_PAGE, alternateHeader(ALT)));
    t.routes.set(ALT, status(404));
    expect(
      await t.requestsOf(ALT, async () =>
        expect(await t.resolve(PAGE, { fetches: 1 })).toEqual({ kind: "none", last: 200 }),
      ),
    ).toBe(0);
  });
});

function ct(type: string) {
  return { headers: { "content-type": type } };
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

describe("a target on this instance", () => {
  // Nothing is fetched for it, and it is looked up by uri whatever (resolve.ts LOCAL, storeResolved's local branch).
  it("a local URL is looked up whatever", async () => {
    const t = await world();
    const uri = "https://kopje.test/ap/o/shown";
    const id = await seedStatus(t.store, { accountId: ALICE, visibility: "public", content: "<p>shown</p>", uri });
    expect(await t.resolve(uri)).toEqual({ kind: "local" });
    expect(await t.search(uri)).toEqual({ accounts: [], statuses: [expect.objectContaining({ id, uri })] });
    expect(await t.search(DAVE_URI)).toEqual({ accounts: [expect.objectContaining({ id: DAVE })], statuses: [] });
    expect(t.fetched).toEqual([]);
  });
});

// S2 applies to URL queries only: an address that resolves nothing is looked up by nothing. No stored uri is an
// address, so only the Store's reads show it.
describe("an address that resolves nothing", () => {
  it("reads nothing, where a URL is looked up", async () => {
    const store = await migratedStore();
    const reads = await runInDurableObject(store, (_instance, state) => {
      const db = new Db(state.storage.sql);
      const first = vi.spyOn(db, "first");
      const all = vi.spyOn(db, "all");
      const looked = (query: string) => {
        first.mockClear();
        all.mockClear();
        const input = {
          query,
          resolved: { kind: "none", last: null } as const,
          now: NOW,
          storeNow: NOW,
          origin: "https://kopje.test",
        };
        const stored = storeResolved(db, input, true);
        return { stored, first: first.mock.calls.length, all: all.mock.calls.length };
      };
      return { address: looked("alice@remote.example"), url: looked("https://remote.example/users/alice") };
    });
    expect(reads).toEqual({
      address: { stored: { kind: "none" }, first: 0, all: 0 },
      url: { stored: { kind: "none" }, first: 1, all: 1 },
    });
  });
});

// Mastodon's USERNAME_STATUS_RE and Addressable's path= (resolve_url_service.rb:7, :50-54).
describe("guessedStatusUri", () => {
  it.each([
    ["https://h.example/@alice/1", "https://h.example/users/alice/statuses/1"],
    ["https://h.example/@alice/statuses/AbC9?x=1#f", "https://h.example/users/alice/statuses/AbC9?x=1#f"],
    ["https://u@H.example:8443/web/@a.b-c/1", "https://u@H.example:8443/users/a.b-c/statuses/1"],
    ["https://h.example/@ſK/1", "https://h.example/users/ſK/statuses/1"],
    ["https://h.example/@alice/1\n", "https://h.example/users/alice/statuses/1"],
    ["https://h.example/@alice/1/", null],
    ["https://h.example/@alice", null],
    ["https://h.example/@.alice/1", null],
    ["https://h.example/@alice/1-2", null],
    ["https://h.example/@é/1", null],
  ])("%j → %j", (url, guessed) => {
    expect(guessedStatusUri(url)).toBe(guessed);
  });
});
