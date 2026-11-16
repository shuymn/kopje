import { afterEach, describe, expect, it } from "vitest";

import { type Resolved, webfingerUrl } from "../src/domain/remote-statuses";
import {
  DOCUMENT_BODY_LIMIT,
  type FetchBudget,
  REQUEST_DEADLINE_MS,
  REQUEST_MAX_BYTES,
  REQUEST_MAX_FETCHES,
  RESOLVE_ACCEPT,
} from "../src/federation/loader";
import { createResolver } from "../src/federation/resolve";
import { LINK_HEADER_CHARS } from "../src/platform/link-header";
import { apiHarness, seedAccount, sql } from "./api-helpers";
import { countingStore, harness, NOW } from "./app-helpers";
import { blockDomain } from "./domain-block-helpers";
import { fixtureKeyGen, LEGACY_EMPTY_KEK, seedLocalAccount } from "./federation-helpers";
import { BUILD, completeSetup, migratedStore } from "./helpers";
import { AP, MASTODON, mastodonActor, RemoteWeb, serveWebFinger } from "./inbox-helpers";
import { ALICE, AS, mastodonNote, token } from "./inbox-status-helpers";
import { attr, parseHtml, query } from "./web-dom";
import { postForm, signIn } from "./web-helpers";

// Search resolution of a URL whose page is HTML (federation/resolve.ts alternateOf, D13 of #1585): the Link header's
// alternate, then the page's <link rel="alternate">, as Mastodon 4.7.5's FetchResourceService follows them. The remote
// web is the loader's fake fetch: crafted answers by URL, and RemoteWeb's served documents behind them.

const PAGE = "https://blog.example/post";
const LD_TYPE = 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"';
const PRIVATE = "https://internal.example";

type Route = (request: Request) => Response | Promise<Response>;

// A body that records whether it was read and whether it was cancelled (pulled only on a read: high-water mark 0).
function watchedBody(text: string | Uint8Array) {
  const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
  const seen = { pulled: false, cancelled: false };
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        seen.pulled = true;
        if (offset >= bytes.byteLength) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.subarray(offset, offset + 64 * 1024));
        offset += 64 * 1024;
      },
      cancel() {
        seen.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, seen };
}

function html(body: string | ReadableStream<Uint8Array>, headers: Record<string, string> = {}): Response {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8", ...headers } });
}

function linkTag(href: string, type = "application/activity+json", rel = "alternate"): string {
  return `<link rel="${rel}" type="${type.replaceAll('"', "&quot;")}" href="${href}">`;
}

function page(...links: string[]): string {
  return `<!doctype html><html><head><title>t</title>${links.join("")}</head><body><p>post</p></body></html>`;
}

const settling: Promise<unknown>[] = [];
afterEach(async () => {
  await Promise.allSettled(settling.splice(0));
});

// The loader's fake fetch: crafted answers in `routes`, RemoteWeb's served documents behind them, every request kept;
// the DNS check refuses internal.example (a private address, NET-1).
function remote(loaderExtra: { timeoutMs?: number } = {}) {
  const web = new RemoteWeb();
  const routes = new Map<string, Route>();
  const requests: Request[] = [];
  const fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(request);
    const route = routes.get(request.url);
    return route === undefined ? web.fetch(request) : Promise.resolve(route(request));
  }) as typeof globalThis.fetch;
  const checkHost = (url: URL) =>
    url.origin === PRIVATE ? Promise.reject(new Error("Invalid or private address: 10.0.0.1")) : Promise.resolve();
  const loader = { fetch, checkHost, ...loaderExtra };
  return { web, routes, requests, loader, fetched: () => requests.map((request) => request.url) };
}

// alice's app over remote(): bob and his notes on mastodon.example; the Store's calls counted.
async function world(loaderExtra: { timeoutMs?: number } = {}) {
  const store = await migratedStore();
  await completeSetup(store);
  await seedLocalAccount(store, "kopje.test", { id: ALICE, username: "alice", key: LEGACY_EMPTY_KEK });
  const { web, routes, requests, loader, fetched } = remote(loaderExtra);
  const counting = countingStore(store);
  const h = harness(counting.stub, {}, undefined, { keygen: fixtureKeyGen, loader }, () => NOW);
  const bearer = await token(store, ALICE);
  const bob = await mastodonActor(web, "bob");
  const note = (extra: Record<string, unknown> = {}) => {
    const made = mastodonNote(bob, extra);
    web.serve(made.id, { "@context": AS, ...made });
    return made;
  };
  const search = async (q: string) => {
    const response = await h.request(`/api/v2/search?resolve=true&q=${encodeURIComponent(q)}`, {
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(response.status).toBe(200);
    return response.json<{ accounts: { acct: string }[]; statuses: { uri: string }[] }>();
  };
  // A resolver of its own, with the request's budget at `budget` when it starts.
  const resolver = (budget: FetchBudget) =>
    createResolver({
      build: () => BUILD,
      store: () => store,
      now: () => NOW,
      keygen: fixtureKeyGen,
      loader,
      budget: () => budget,
    });
  return { store, web, routes, requests, fetched, bob, note, search, h, resolver, calls: counting.calls };
}

type World = Awaited<ReturnType<typeof world>>;

// The note `search` found, by uri, or none.
async function foundUri(t: World, q: string): Promise<string | null> {
  const body = await t.search(q);
  return body.statuses[0]?.uri ?? null;
}

describe("resolve through a Link header alternate (T10.1, T10.3, T10.4)", () => {
  it("resolves a status and an actor a 200 HTML page names in its Link header", async () => {
    const t = await world();
    const note = t.note();
    t.routes.set(PAGE, () => html(page(), { link: `<${note.id}>; rel="alternate"; type="application/activity+json"` }));
    expect(await foundUri(t, PAGE)).toBe(note.id);
    // The author, fetched after its state read, and the WebFinger that confirms its handle (NET-4).
    expect(t.fetched()).toEqual([PAGE, note.id, t.bob.uri, webfingerUrl("bob", "mastodon.example")]);

    const profile = "https://blog.example/about";
    t.routes.set(profile, () =>
      html(page(), { link: `<${t.bob.uri}>; rel="alternate"; type="application/activity+json"` }),
    );
    const found = await t.search(profile);
    expect(found.accounts.map((account) => account.acct)).toEqual(["bob@mastodon.example"]);
  });

  it("takes the activity+json link before an ld+json one listed first, and either type only exactly", async () => {
    const t = await world();
    const [first, second] = [t.note(), t.note()];
    t.routes.set(PAGE, () =>
      html(page(), {
        link: `<${first.id}>; rel="alternate"; type="${LD_TYPE.replaceAll('"', '\\"')}", <${second.id}>; rel="alternate"; type="application/activity+json"`,
      }),
    );
    expect(await foundUri(t, PAGE)).toBe(second.id);
    // The ld+json one alone, its quoted profile escaped as a quoted-string.
    t.routes.set(`${PAGE}/ld`, () =>
      html(page(), { link: `<${first.id}>; rel=alternate; type="${LD_TYPE.replaceAll('"', '\\"')}"` }),
    );
    expect(await foundUri(t, `${PAGE}/ld`)).toBe(first.id);
    for (const type of [
      "application/activity+json; charset=utf-8",
      "Application/Activity+JSON",
      "application/activity+json ",
    ]) {
      const url = `${PAGE}/${encodeURIComponent(type)}`;
      t.routes.set(url, () => html(page(), { link: `<${first.id}>; rel="alternate"; type="${type}"` }));
      expect(await foundUri(t, url), type).toBeNull();
    }
  });

  it("follows no Link alternate whose rel is a token list, nor an HTML one whose rel holds more", async () => {
    const t = await world();
    const [inHeader, inPage] = [t.note(), t.note()];
    t.routes.set(PAGE, () =>
      html(page(linkTag(inPage.id, "application/activity+json", "nofollow alternate")), {
        link: `<${inHeader.id}>; rel="alternate nofollow"; type="application/activity+json"`,
      }),
    );
    // The header's is no alternate (rel compared whole, as link_header's find_link), so the page's is taken.
    expect(await foundUri(t, PAGE)).toBe(inPage.id);
    expect(t.fetched()).not.toContain(inHeader.id);
  });
});

describe("resolve through the page's <link> alternate (T10.2, T10.5, T10.6, T10.7, T10.8)", () => {
  it("resolves the ld+json profile type written with &quot; entities", async () => {
    const t = await world();
    const note = t.note();
    t.routes.set(PAGE, () =>
      html(
        page(
          `<link rel="alternate" type="application/ld+json; profile=&quot;https://www.w3.org/ns/activitystreams&quot;" href="${note.id}">`,
        ),
      ),
    );
    expect(await foundUri(t, PAGE)).toBe(note.id);
  });

  it("follows no relative href, in the header (nothing at all) or on the page", async () => {
    const t = await world();
    const note = t.note();
    const relative = new URL(note.id).pathname;
    t.routes.set(PAGE, () => html(page(linkTag(relative))));
    t.routes.set(`${MASTODON}/page`, () => html(page(linkTag(relative))));
    expect(await foundUri(t, PAGE)).toBeNull();
    expect(await foundUri(t, `${MASTODON}/page`)).toBeNull();
    // A relative header href is raised in Mastodon (an invalid request), so a valid page alternate is not tried.
    t.routes.set(`${PAGE}/h`, () =>
      html(page(linkTag(note.id)), { link: `<${relative}>; rel="alternate"; type="application/activity+json"` }),
    );
    expect(await foundUri(t, `${PAGE}/h`)).toBeNull();
    expect(t.fetched().filter((url) => url === note.id)).toEqual([]);
  });

  it("makes no second hop: an alternate answering HTML that names its own alternate resolves nothing", async () => {
    const t = await world();
    const note = t.note();
    const hop = "https://blog.example/hop";
    t.routes.set(PAGE, () => html(page(linkTag(hop))));
    t.routes.set(hop, () =>
      html(page(linkTag(note.id)), { link: `<${note.id}>; rel=alternate; type="application/activity+json"` }),
    );
    expect(await foundUri(t, PAGE)).toBeNull();
    expect(t.fetched()).toEqual([PAGE, hop]);
  });

  it("follows no redirect of an alternate: the page's resolves nothing, the header's falls back to the page", async () => {
    const t = await world();
    const note = t.note();
    // On the note's origin, so that a loader following it would reach the note.
    const moved = `${MASTODON}/moved`;
    t.routes.set(moved, () => new Response(null, { status: 302, headers: { location: note.id } }));
    t.routes.set(PAGE, () => html(page(linkTag(moved))));
    expect(await foundUri(t, PAGE)).toBeNull();
    expect(t.fetched()).toEqual([PAGE, moved]);
    const other = t.note();
    t.routes.set(`${PAGE}/2`, () =>
      html(page(linkTag(other.id)), { link: `<${moved}>; rel="alternate"; type="application/activity+json"` }),
    );
    expect(await foundUri(t, `${PAGE}/2`)).toBe(other.id);
  });

  it("takes an alternate on another origin whose id is the href, and none whose id is not", async () => {
    const t = await world();
    const note = t.note();
    t.routes.set(PAGE, () => html(page(linkTag(note.id))));
    expect(await foundUri(t, PAGE)).toBe(note.id);
    const aliased = `${note.id}?alias=1`;
    const other = t.note();
    t.routes.set(aliased, () => Response.json({ "@context": AS, ...other }, { headers: { "content-type": AP } }));
    t.routes.set(`${PAGE}/2`, () => html(page(linkTag(aliased))));
    expect(await foundUri(t, `${PAGE}/2`)).toBeNull();
    expect(t.fetched()).toContain(aliased);
    expect(t.fetched()).not.toContain(other.id);
  });
});

describe("the alternate's own rules (T10.9, T10.12, T10.13)", () => {
  it("resolves nothing for an alternate on a blocked domain or at a private address", async () => {
    const t = await world();
    await blockDomain(t.store, "blocked.example");
    t.routes.set(PAGE, () => html(page(linkTag("https://blocked.example/users/x/statuses/1"))));
    t.routes.set(`${PAGE}/2`, () => html(page(linkTag(`${PRIVATE}/users/x/statuses/1`))));
    expect(await foundUri(t, PAGE)).toBeNull();
    expect(await foundUri(t, `${PAGE}/2`)).toBeNull();
    expect(t.fetched()).toEqual([PAGE, `${PAGE}/2`]);
  });

  it("resolves nothing after a non-200 first answer, and starts nothing on a 410 alternate", async () => {
    const t = await world();
    const note = t.note();
    t.routes.set(
      PAGE,
      () =>
        new Response(page(linkTag(note.id)), {
          status: 404,
          headers: {
            "content-type": "text/html",
            link: `<${note.id}>; rel="alternate"; type="application/activity+json"`,
          },
        }),
    );
    expect(await foundUri(t, PAGE)).toBeNull();
    expect(t.fetched()).toEqual([PAGE]);
    // bob stored, then named by a page whose alternate (his URI) answers 410: nothing is resolved or deleted.
    expect((await t.search(t.bob.uri)).accounts).toHaveLength(1);
    t.routes.set(t.bob.uri, () => new Response("Gone", { status: 410 }));
    t.routes.set(`${PAGE}/gone`, () => html(page(linkTag(t.bob.uri))));
    expect((await t.search(`${PAGE}/gone`)).accounts).toEqual([]);
    expect(t.fetched().at(-1)).toBe(t.bob.uri);
    expect(t.calls).not.toContain("actorGone");
  });

  it("sends Mastodon's Accept on the first request and on the alternate's", async () => {
    const t = await world();
    const note = t.note();
    t.routes.set(PAGE, () => html(page(linkTag(note.id))));
    expect(await foundUri(t, PAGE)).toBe(note.id);
    const accepts = new Map(t.requests.map((request) => [request.url, request.headers.get("accept")]));
    expect(RESOLVE_ACCEPT).toContain("text/html;q=0.1");
    expect(accepts.get(PAGE)).toBe(RESOLVE_ACCEPT);
    expect(accepts.get(note.id)).toBe(RESOLVE_ACCEPT);
  });
});

describe("the bounds of the header and the page (T10.10, T10.11, T10.14, T10.15)", () => {
  it("ignores a Link value past LINK_HEADER_CHARS, and reads one at it", async () => {
    const t = await world();
    const [inHeader, inPage] = [t.note(), t.note()];
    const link = (length: number) => {
      const value = `<${inHeader.id}>; rel="alternate"; type="application/activity+json"`;
      return `${value}, <${"x".repeat(length - value.length - 4)}>`;
    };
    t.routes.set(PAGE, () => html(page(linkTag(inPage.id)), { link: link(LINK_HEADER_CHARS) }));
    t.routes.set(`${PAGE}/long`, () => html(page(linkTag(inPage.id)), { link: link(LINK_HEADER_CHARS + 1) }));
    expect(link(LINK_HEADER_CHARS)).toHaveLength(LINK_HEADER_CHARS);
    expect(await foundUri(t, PAGE)).toBe(inHeader.id);
    expect(await foundUri(t, `${PAGE}/long`)).toBe(inPage.id);
  });

  it("follows a Link alternate of any other type, and nothing of a text/plain answer without one", async () => {
    const t = await world();
    const note = t.note();
    const plain = (headers: Record<string, string>) => () =>
      new Response(page(linkTag(note.id)), { headers: { "content-type": "text/plain", ...headers } });
    t.routes.set(PAGE, plain({}));
    expect(await foundUri(t, PAGE)).toBeNull();
    expect(t.fetched()).toEqual([PAGE]);
    t.routes.set(`${PAGE}/2`, plain({ link: `<${note.id}>; rel="alternate"; type="application/activity+json"` }));
    expect(await foundUri(t, `${PAGE}/2`)).toBe(note.id);
  });

  it("resolves nothing for a page past DOCUMENT_BODY_LIMIT, by Content-Length or as read", async () => {
    const t = await world();
    const note = t.note();
    const big = page(linkTag(note.id)) + " ".repeat(DOCUMENT_BODY_LIMIT);
    // A Content-Length past the limit is refused before any byte is read, whatever the body holds.
    const declared = watchedBody(page(linkTag(note.id)));
    t.routes.set(PAGE, () => html(declared.stream, { "content-length": String(DOCUMENT_BODY_LIMIT + 1) }));
    t.routes.set(`${PAGE}/2`, () => html(watchedBody(big).stream));
    const exact = page(linkTag(note.id));
    t.routes.set(`${PAGE}/3`, () => html(watchedBody(exact.padEnd(DOCUMENT_BODY_LIMIT, " ")).stream));
    expect(await foundUri(t, PAGE)).toBeNull();
    expect(declared.seen).toEqual({ pulled: false, cancelled: true });
    expect(await foundUri(t, `${PAGE}/2`)).toBeNull();
    expect(t.fetched()).toEqual([PAGE, `${PAGE}/2`]);
    // At exactly DOCUMENT_BODY_LIMIT bytes the page is read and its alternate followed.
    expect(await foundUri(t, `${PAGE}/3`)).toBe(note.id);
  });

  it("charges the page and every alternate to the request's budget (RES-6)", async () => {
    const t = await world();
    const note = t.note();
    // What resolved, with the budget given; the request never spends more than it was given.
    const resolve = async (given: Partial<FetchBudget>, url = PAGE): Promise<Resolved["kind"]> => {
      const budget = {
        fetches: REQUEST_MAX_FETCHES,
        bytes: REQUEST_MAX_BYTES,
        deadline: Date.now() + REQUEST_DEADLINE_MS,
        ...given,
      };
      const kind = (await t.resolver(budget)(t.h.env, url)).kind;
      expect(budget.bytes).toBeGreaterThanOrEqual(0);
      expect(budget.fetches).toBeGreaterThanOrEqual(0);
      return kind;
    };
    t.routes.set(PAGE, () => html(page(linkTag(note.id))));
    // (a) Seven fetches spent: the page is the eighth, the alternate would be the ninth. Four left: the page, the
    // alternate, the author and the WebFinger that confirms its handle (NET-4).
    expect(await resolve({ fetches: 1 })).toBe("none");
    expect(t.fetched()).toEqual([PAGE]);
    expect(await resolve({ fetches: 4 })).toBe("status");
    // (b) Fewer bytes left than the page holds (a 600 KiB page, 500 KiB left): nothing, where the alternate and the
    // author would fit.
    const padded = page(linkTag(note.id)).padEnd(600 * 1024, " ");
    t.routes.set(`${PAGE}/b`, () => html(padded));
    expect(await resolve({ bytes: 500 * 1024 }, `${PAGE}/b`)).toBe("none");
    expect(await resolve({ bytes: 700 * 1024 }, `${PAGE}/b`)).toBe("status");
    // (c) A header alternate of nearly 1 MiB that is no JSON (a nil answer), then a 1 MiB page: the page alternate is
    // refused for the bytes left (the departure of D13); with a small header alternate it resolves.
    const junk = (bytes: number) => () => new Response("x".repeat(bytes), { headers: { "content-type": AP } });
    t.routes.set("https://blog.example/junk-big", junk(DOCUMENT_BODY_LIMIT - 512));
    t.routes.set("https://blog.example/junk-small", junk(512));
    const full = page(linkTag(note.id)).padEnd(DOCUMENT_BODY_LIMIT, " ");
    for (const [name, outcome] of [
      ["junk-big", "none"],
      ["junk-small", "status"],
    ] as const) {
      t.routes.set(`${PAGE}/${name}`, () =>
        html(full, { link: `<https://blog.example/${name}>; rel="alternate"; type="application/activity+json"` }),
      );
      expect(await resolve({}, `${PAGE}/${name}`), name).toBe(outcome);
    }
  });
});

describe("the page scan's time witness (NET-3, RES-6)", () => {
  const MiB = DOCUMENT_BODY_LIMIT;
  const fill = (prefix: string, suffix = "") => {
    const unit = '<link rel=alternate type=text/html href="https://blog.example/x">';
    return prefix + unit.repeat(Math.floor((MiB - prefix.length - suffix.length) / unit.length)) + suffix;
  };

  it.each([
    ["no match", fill(""), "none"],
    ["a refused context first", fill("<select>"), "none"],
    ["the match last (no link-count cap)", fill("", linkTag("NOTE")), "status"],
  ])(
    "reads and scans a 1 MiB page of <link> elements, %s, within the request's deadline",
    { timeout: 60_000 },
    async (_label, body, outcome) => {
      const t = await world();
      const note = t.note();
      const html1 = body.replace("NOTE", note.id);
      const bytes = new TextEncoder().encode(html1).byteLength;
      expect(bytes).toBeLessThanOrEqual(MiB);
      expect(bytes).toBeGreaterThan(MiB - 200);
      t.routes.set(PAGE, () => html(html1));
      const budget = {
        fetches: REQUEST_MAX_FETCHES,
        bytes: REQUEST_MAX_BYTES,
        deadline: Date.now() + REQUEST_DEADLINE_MS,
      };
      const started = Date.now();
      const resolved = await t.resolver(budget)(t.h.env, PAGE);
      expect(Date.now() - started).toBeLessThan(REQUEST_DEADLINE_MS);
      expect(resolved.kind).toBe(outcome);
      // The page was read whole and charged (the alternate and its author too when it resolved).
      expect(REQUEST_MAX_BYTES - budget.bytes).toBeGreaterThanOrEqual(bytes);
      if (outcome === "none") {
        expect(REQUEST_MAX_BYTES - budget.bytes).toBe(bytes);
      }
    },
  );
});

describe("a header alternate and a page alternate together (T10.17)", () => {
  const ALT = "https://blog.example/alt";
  const note =
    (body: Record<string, unknown>, init: ResponseInit = {}) =>
    () =>
      Response.json(body, { ...init, headers: { "content-type": AP } });

  // A page whose Link header names `headerUrl` (answered by `header`, else as served) and whose <link> names another
  // note: what search resolved, and whether the page's body was read or cancelled.
  async function mixed(header: Route | null, headerUrl: string | null = ALT) {
    const t = await world({ timeoutMs: 300 });
    await blockDomain(t.store, "blocked.example");
    const [viaHeader, viaPage] = [t.note(), t.note()];
    const target = headerUrl ?? viaHeader.id;
    if (header !== null) {
      t.routes.set(target, (request) => {
        const answer = header(request);
        settling.push(Promise.resolve(answer));
        return answer;
      });
    }
    const body = watchedBody(page(linkTag(viaPage.id)));
    t.routes.set(PAGE, () =>
      html(body.stream, { link: `<${target}>; rel="alternate"; type="application/activity+json"` }),
    );
    return { t, viaHeader, viaPage, seen: body.seen, found: await foundUri(t, PAGE) };
  }

  it("takes a header alternate that resolves, and never reads the page", async () => {
    const { found, viaHeader, seen } = await mixed(null, null);
    expect(found).toBe(viaHeader.id);
    expect(seen).toEqual({ pulled: false, cancelled: true });
  });

  it.each<[string, Route]>([
    ["404", () => new Response("Not Found", { status: 404 })],
    ["HTML", () => html(page())],
    ["an id that is not its href", note({ "@context": AS, id: "https://blog.example/other", type: "Note" })],
    ["an unparseable body", () => new Response("{not json", { headers: { "content-type": AP } })],
    ["a 201", note({ "@context": AS, id: ALT, type: "Note" }, { status: 201 })],
    ["another context", note({ "@context": "https://example.com/ns", id: ALT, type: "Note" })],
    ["another type", note({ "@context": AS, id: ALT, type: "Collection" })],
  ])("falls back to the page alternate when the header's answers %s", async (_label, header) => {
    const { found, viaPage, seen } = await mixed(header);
    expect(found).toBe(viaPage.id);
    expect(seen.pulled).toBe(true);
  });

  it.each<[string, Route | null, string]>([
    ["is refused by NET-1", null, `${PRIVATE}/alt`],
    ["is on a blocked domain", null, "https://blocked.example/alt"],
    [
      "is past DOCUMENT_BODY_LIMIT",
      () => new Response("x".repeat(DOCUMENT_BODY_LIMIT + 1), { headers: { "content-type": AP } }),
      ALT,
    ],
    [
      "times out",
      (request) =>
        new Promise<Response>((_, reject) =>
          request.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
        ),
      ALT,
    ],
  ])("resolves nothing when the header alternate %s", async (_label, header, url) => {
    const { t, found, seen, viaPage } = await mixed(header, url);
    expect(found).toBeNull();
    expect(seen).toEqual({ pulled: false, cancelled: true });
    expect(t.fetched()).not.toContain(viaPage.id);
  });
});

describe("the interaction page (T10.16)", () => {
  it("resolves through a page alternate as search does", async () => {
    const { web, routes, loader } = remote();
    const h = await apiHarness({}, { federation: { keygen: fixtureKeyGen, loader } });
    await seedAccount(h.store, { username: "alice", email: "alice@example.com", displayName: "Alice" });
    const bob = await mastodonActor(web, "bob");
    const note = mastodonNote(bob, { content: "<p>the alternate note</p>" });
    web.serve(note.id, { "@context": AS, ...note });
    routes.set(PAGE, () => html(page(linkTag(note.id))));
    const browser = await signIn(h);
    const form = await h.request(`/authorize_interaction?uri=${encodeURIComponent(PAGE)}`, {
      headers: { cookie: browser.cookie },
    });
    const fields = new URLSearchParams();
    for (const input of query(parseHtml(await form.text()), "input")) {
      fields.append(attr(input, "name") ?? "", attr(input, "value") ?? "");
    }
    expect(fields.get("uri")).toBe(PAGE);
    const found = await postForm(h, browser, "/authorize_interaction", fields);
    expect(found.status).toBe(200);
    expect(await found.text()).toContain("the alternate note");
  });
});

// An actor reached through an alternate is the actor a direct URL reaches (resolveUrl → resolveAccount): its state read,
// its refetch after it and its handle's confirmation (NET-4), all within the request's one fetch budget (RES-6).
describe("verified handles through an alternate (NET-4, RES-6)", () => {
  type Row = { username: string; domain: string; display_name: string };
  const row = (t: World, uri: string) =>
    sql<Row>(t.store, "SELECT username, domain, display_name FROM accounts WHERE uri = ?", uri);

  it("stores an actor an alternate names under its handle only as a direct URL would", async () => {
    // A world of its own per search: the actor's URI searched directly, or a page whose alternate is that URI.
    const outcome = async (via: "direct" | "alternate", prepare: (t: World) => Promise<string>) => {
      const t = await world();
      const uri = await prepare(t);
      t.routes.set(PAGE, () => html(page(linkTag(uri))));
      const from = t.fetched().length;
      const accts = (await t.search(via === "direct" ? uri : PAGE)).accounts.map((account) => account.acct);
      return { uri, accts, row: await row(t, uri), fetched: t.fetched().slice(from) };
    };
    // A new actor claiming a handle whose WebFinger names another actor (the handle's owner): nothing is stored.
    const claimant = async (t: World) => {
      const carol = await mastodonActor(t.web, "carol", { key: 2, extra: { webfinger: "carol@victim.example" } });
      serveWebFinger(
        t.web,
        "acct:carol@victim.example",
        "acct:carol@victim.example",
        "https://victim.example/users/carol",
      );
      return carol.uri;
    };
    // A stored actor (bob@mastodon.example) whose document now claims a handle nothing confirms (no WebFinger answer
    // there) and a new name: the name is stored, the handle kept.
    const renamed = async (t: World) => {
      expect((await t.search(t.bob.uri)).accounts.map((account) => account.acct)).toEqual(["bob@mastodon.example"]);
      t.web.serve(t.bob.uri, { ...t.bob.document, name: "Robert", webfinger: "robert@victim.example" });
      return t.bob.uri;
    };
    for (const [prepare, claim, accts, rows] of [
      [claimant, webfingerUrl("carol", "victim.example"), [], []],
      [
        renamed,
        webfingerUrl("robert", "victim.example"),
        ["bob@mastodon.example"],
        [{ username: "bob", domain: "mastodon.example", display_name: "Robert" }],
      ],
    ] as const) {
      const direct = await outcome("direct", prepare);
      const alternate = await outcome("alternate", prepare);
      // Each fetched the actor after its state read and looked its claim up (the confirmation ran); the alternate's
      // actor was fetched twice, as a probe's is: once as the alternate, once after the state read.
      expect(direct.fetched.slice(-2)).toEqual([direct.uri, claim]);
      expect(alternate.fetched).toEqual([PAGE, alternate.uri, alternate.uri, claim]);
      for (const seen of [direct, alternate]) {
        expect(seen.accts).toEqual(accts);
        expect(seen.row).toEqual(rows);
      }
    }
  });

  it("stops at the request's budget when the alternates and the confirmation need more", async () => {
    // PAGE answers after `hops` same-origin redirects, its Link header naming a header alternate that answers 404 (a
    // nil answer) and its <link> the actor. The actor claims <name>@alias.example, whose WebFinger names
    // <name>@mastodon.example, which names the actor: confirmed through another subject, two WebFinger loads. The
    // requests: the hops and the page, the header alternate, the page alternate, the refetch after the actor's state
    // read, two WebFinger answers; 8 with two hops, 9 with three.
    const run = async (hops: number, stored: boolean) => {
      const t = await world();
      const name = stored ? "robert" : "dave";
      const uri = stored ? t.bob.uri : `${MASTODON}/users/dave`;
      if (stored) {
        expect((await t.search(t.bob.uri)).accounts.map((account) => account.acct)).toEqual(["bob@mastodon.example"]);
        t.web.serve(uri, { ...t.bob.document, name: "Robert", webfinger: `${name}@alias.example` });
      } else {
        await mastodonActor(t.web, "dave", { key: 2, extra: { webfinger: "dave@alias.example" } });
      }
      serveWebFinger(t.web, `acct:${name}@alias.example`, `acct:${name}@mastodon.example`, uri);
      serveWebFinger(t.web, `acct:${name}@mastodon.example`, `acct:${name}@mastodon.example`, uri);
      const nil = "https://blog.example/nil";
      t.routes.set(nil, () => new Response("Not Found", { status: 404 }));
      for (let hop = 0; hop < hops; hop++) {
        const location = `${PAGE}/${hop + 1}`;
        t.routes.set(
          hop === 0 ? PAGE : `${PAGE}/${hop}`,
          () => new Response(null, { status: 302, headers: { location } }),
        );
      }
      t.routes.set(hops === 0 ? PAGE : `${PAGE}/${hops}`, () =>
        html(page(linkTag(uri)), { link: `<${nil}>; rel="alternate"; type="application/activity+json"` }),
      );
      const from = t.fetched().length;
      const accts = (await t.search(PAGE)).accounts.map((account) => account.acct);
      const fetched = t.fetched().slice(from);
      expect(fetched.slice(hops + 1, hops + 4)).toEqual([nil, uri, uri]);
      return { accts, row: await row(t, uri), fetched, second: webfingerUrl(name, "mastodon.example"), name };
    };
    for (const stored of [false, true]) {
      // Within the budget: the second subject confirms, and the handle is taken.
      const within = await run(2, stored);
      expect(within.fetched).toHaveLength(REQUEST_MAX_FETCHES);
      expect(within.fetched.at(-1)).toBe(within.second);
      expect(within.accts).toEqual([`${within.name}@mastodon.example`]);
      // One hop more: the second WebFinger would be the ninth request and is never sent. A transient failure: a new
      // actor is not stored, a stored one keeps its handle and takes the rest of its document.
      const past = await run(3, stored);
      expect(past.fetched).toHaveLength(REQUEST_MAX_FETCHES);
      expect(past.fetched.at(-1)).toBe(webfingerUrl(past.name, "alias.example"));
      expect(past.fetched).not.toContain(past.second);
      expect(past.accts).toEqual(stored ? ["bob@mastodon.example"] : []);
      expect(past.row).toEqual(stored ? [{ username: "bob", domain: "mastodon.example", display_name: "Robert" }] : []);
    }
  });
});

// A resolution that ends with nothing after a 410, the last answer of the probe's fetches, is `gone` (resolve.ts
// resolveUrl), and the search then answers no stored status (storeResolved): Mastodon's process_url_from_db reads the
// last fetch's response code (fetch_resource_service.rb:47) and answers a stored status only after a 401, 403 or 404
// (resolve_url_service.rb:44).
describe("a resolution gone after a 410", () => {
  const ALT = "https://blog.example/alt";
  const answer = (status: number) => () => new Response("", { status });
  const resolve = (t: World, url = PAGE) =>
    t.resolver({ fetches: REQUEST_MAX_FETCHES, bytes: REQUEST_MAX_BYTES, deadline: Date.now() + REQUEST_DEADLINE_MS })(
      t.h.env,
      url,
    );

  it("is gone when the probe answers 410, and when the id its document names does", async () => {
    const t = await world();
    t.routes.set(PAGE, answer(410));
    expect(await resolve(t)).toEqual({ kind: "none", gone: true });
    t.routes.set(PAGE, answer(404));
    expect(await resolve(t)).toEqual({ kind: "none" });
    // The note's own origin serves it at another URL (the loader refuses an id on another origin).
    const note = t.note();
    const other = `${new URL(note.id).origin}/other`;
    t.routes.set(other, () => Response.json({ "@context": AS, ...note }, { headers: { "content-type": AP } }));
    t.routes.set(note.id, answer(410));
    expect(await resolve(t, other)).toEqual({ kind: "none", gone: true });
    expect(t.fetched().slice(-2)).toEqual([other, note.id]);
  });

  // The header alternate answers 410; the page alternate's answer comes last.
  it.each<[string, Route]>([
    ["404", answer(404)],
    ["an HTML 200", () => html(page())],
  ])("is not gone when a later alternate answers %s", async (_label, last) => {
    const t = await world();
    t.routes.set(PAGE, () =>
      html(page(linkTag(ALT)), { link: `<${PAGE}/gone>; rel="alternate"; type="application/activity+json"` }),
    );
    t.routes.set(`${PAGE}/gone`, answer(410));
    t.routes.set(ALT, last);
    expect(await resolve(t)).toEqual({ kind: "none" });
    expect(t.fetched()).toEqual([PAGE, `${PAGE}/gone`, ALT]);
  });
});
