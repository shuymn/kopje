import { createExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { apiHeaders } from "../src/mastodon/caching";
import type { ApiHandler } from "../src/mastodon/context";
import { mastodonApi, ROUTES } from "../src/mastodon/routes";
import { imagesCodec } from "../src/platform/images";
import type { StoreStub } from "../src/platform/store-client";
import { sha256Hex as tokenHash } from "../src/security/tokens";
import { type ApiHarness, bearer, json, login, setSetting, sql } from "./api-helpers";
import { countingStore, NOW } from "./app-helpers";
import { BUILD, runStoreJobs } from "./helpers";
import { appToken } from "./read-helpers";
import { community, post } from "./status-helpers";

// AUTH-1's order (domain/auth.ts authorize, as Mastodon's Api::BaseController#require_not_suspended! before
// Doorkeeper's checks): a held token of a suspended owner answers 403 on every API route, expired or of an earlier
// epoch alike; a deleted row is no credential (docs/mastodon-deviations.md, "Expired and revoked tokens on routes that
// need none").

const DISABLED = { status: 403, body: { error: "Your login is currently disabled" } };
const INVALID = { status: 401, body: { error: "The access token is invalid" } };

async function answer(h: ApiHarness, method: string, path: string, token: string | null, init: RequestInit = {}) {
  const sent = { ...init, method };
  const response = await h.request(path, token === null ? sent : bearer(token, sent));
  const text = await response.text();
  return { status: response.status, body: text === "" ? "" : (JSON.parse(text) as unknown) };
}

const expire = async (h: ApiHarness, token: string) =>
  sql(
    h.store,
    "UPDATE oauth_tokens SET expires_at = ? WHERE token_hash = ?",
    new Date(NOW - 1000).toISOString(),
    await tokenHash(token),
  );

// alice holds an unexpired token and an expired one; bob, who stays available, holds an expired one too. `suspend`
// suspends alice as the admin API does (a new credential epoch, so both her tokens are also stale), leaving the
// suspension's tokens job unrun so the rows are still held.
async function world() {
  const h = await community(["alice", "bob"]);
  const second = async (name: string) =>
    (await login(h, { app: h.app, email: `${name}@example.com`, scope: "read write follow" })).token;
  const tokens = { fresh: h.users.alice.token, expired: await second("alice"), bobExpired: await second("bob") };
  await expire(h, tokens.expired);
  await expire(h, tokens.bobExpired);
  const suspend = async () => {
    expect(await h.store.suspendAccount(BUILD, { accountId: h.users.alice.id, now: NOW })).toEqual({ suspended: true });
    expect(
      await sql(h.store, "SELECT count(*) AS held FROM oauth_tokens WHERE account_id = ?", h.users.alice.id),
    ).toEqual([{ held: 2 }]);
  };
  return { h, tokens, suspend };
}

const FORBIDDEN = { status: 403, body: { error: "Forbidden" } };

// One route per way a token reaches authorize() or the admin gate (docs: the design's paths of D10), each with a
// request it answers after the token check, and its answer to an available owner's expired token: invalid, or, on an
// admin route, Forbidden, as the gate judges the owner before the expiry (adminGate, VIS-29).
const BY_CALLER: [string, string, string, () => RequestInit, typeof INVALID | typeof FORBIDDEN][] = [
  ["a user read (userReadOperation)", "GET", "/api/v1/timelines/home", () => ({}), INVALID],
  ["a user write (userWriteOperation)", "POST", "/api/v1/lists", () => json({ title: "l" }), INVALID],
  ["optionalUserReadOperation", "GET", "/api/v1/directory", () => ({}), INVALID],
  ["tokenUserReadOperation", "GET", "/api/v1/announcements", () => ({}), INVALID],
  ["checkCredential (search)", "GET", "/api/v2/search?q=a&type=none", () => ({}), INVALID],
  ["checkCredential (placeholders)", "POST", "/api/v1/statuses/1/translate", () => ({}), INVALID],
  ["checkCredential (accounts)", "POST", "/api/v1/accounts", () => ({}), INVALID],
  ["checkCredential (tags)", "POST", "/api/v1/featured_tags", () => json({}), INVALID],
  ["checkCredential (refuseAfterAuth)", "GET", "/api/v1/accounts/search", () => ({}), INVALID],
  ["appOfCredential", "GET", "/api/v1/apps/verify_credentials", () => ({}), INVALID],
  ["checkAdminCredential (afterGate)", "GET", "/api/v1/admin/ip_blocks", () => ({}), FORBIDDEN],
  ["adminGate (adminGuarded)", "GET", "/api/v1/admin/reports", () => ({}), FORBIDDEN],
];

describe("a suspended owner's held token", () => {
  it("answers 403 on every kind of token check, expired or not, where its expiry answered 401", async () => {
    const { h, tokens, suspend } = await world();
    // Before the suspension the expired token reaches each check and is refused as invalid, or as not the admin.
    for (const [caller, method, path, init, before] of BY_CALLER) {
      expect(await answer(h, method, path, tokens.expired, init()), caller).toEqual(before);
    }
    await suspend();
    for (const [caller, method, path, init] of BY_CALLER) {
      expect(await answer(h, method, path, tokens.expired, init()), `${caller}, expired`).toEqual(DISABLED);
      expect(await answer(h, method, path, tokens.fresh, init()), `${caller}, unexpired`).toEqual(DISABLED);
    }
  });

  it("answers 403 on the public block list, where its expired token read as anonymous", async () => {
    const { h, tokens, suspend } = await world();
    await setSetting(h.store, "show_domain_blocks", "users");
    const blocks = (token: string) => answer(h, "GET", "/api/v1/instance/domain_blocks", token);
    expect(await blocks(tokens.expired)).toEqual({ status: 404, body: "" });
    expect(await blocks(tokens.fresh)).toEqual({ status: 200, body: [] });
    await suspend();
    expect(await blocks(tokens.expired)).toEqual(DISABLED);
    expect(await blocks(tokens.fresh)).toEqual(DISABLED);
  });

  it("leaves an unknown token and an available owner's expired or stale token invalid", async () => {
    const { h, tokens, suspend } = await world();
    await suspend();
    for (const token of ["unknown-token", tokens.bobExpired]) {
      expect(await answer(h, "GET", "/api/v1/timelines/home", token)).toEqual(INVALID);
    }
    // bob's unexpired token passes until his epoch moves on, then it is stale.
    expect((await answer(h, "GET", "/api/v1/timelines/home", h.users.bob.token)).status).toBe(200);
    await sql(
      h.store,
      "UPDATE local_accounts SET credential_epoch = credential_epoch + 1 WHERE account_id = ?",
      h.users.bob.id,
    );
    expect(await answer(h, "GET", "/api/v1/timelines/home", h.users.bob.token)).toEqual(INVALID);
  });

  it("is no credential once deleted, by the suspension's tokens job or by the sweep of expired tokens", async () => {
    const { h, tokens, suspend } = await world();
    await suspend();
    expect(await answer(h, "GET", "/api/v1/timelines/home", tokens.expired)).toEqual(DISABLED);
    // The sweep deletes the expired row first.
    expect(await h.store.sweepOAuth(BUILD, { now: NOW })).toMatchObject({ tokens: 2 });
    expect(await answer(h, "GET", "/api/v1/timelines/home", tokens.expired)).toEqual(INVALID);
    expect(await answer(h, "GET", "/api/v1/timelines/home", tokens.fresh)).toEqual(DISABLED);
    // The tokens job deletes the rest of the account's tokens.
    await runStoreJobs(h.store, BUILD, { now: NOW });
    expect(await sql(h.store, "SELECT 1 FROM oauth_tokens WHERE account_id = ?", h.users.alice.id)).toEqual([]);
    expect(await answer(h, "GET", "/api/v1/timelines/home", tokens.fresh)).toEqual(INVALID);
  });
});

// AUTH-2's anonymous routes (mastodon/access.ts): a token sent is read only for its owner's suspension.

// The Store as the app calls it, counted; while `failing` is set, every call but the host check's and the
// after-check's throws, as a Store failure would.
function observedStore() {
  const state: { failing: boolean; counting?: ReturnType<typeof countingStore> } = { failing: false };
  const spared = new Set(["instanceDomain", "checkNotSuspended"]);
  const wrapStore = (store: StoreStub): StoreStub => {
    state.counting ??= countingStore(store);
    return new Proxy(state.counting.stub, {
      get: (target, name) => {
        const value = Reflect.get(target, name) as unknown;
        return state.failing && typeof value === "function" && !spared.has(String(name))
          ? () => Promise.reject(new Error("forced"))
          : value;
      },
    });
  };
  // The calls `run` makes, but the host check's (app.ts, WEB-6).
  const callsOf = async <T>(run: () => Promise<T>): Promise<{ result: T; calls: string[] }> => {
    const before = state.counting?.calls.length ?? 0;
    const result = await run();
    return { result, calls: (state.counting?.calls ?? []).slice(before).filter((name) => name !== "instanceDomain") };
  };
  return { state, wrapStore, callsOf };
}

// alice is suspended with a held unexpired token and a held expired one; bob is available, with a valid token and an
// expired one; carol's token is used on anonymous routes only.
async function anonymousWorld(overrides: Record<string, unknown> = {}) {
  const store = observedStore();
  const h = await community(["alice", "bob", "carol"], "read write follow", { wrapStore: store.wrapStore }, overrides);
  const second = async (name: string) =>
    (await login(h, { app: h.app, email: `${name}@example.com`, scope: "read write follow" })).token;
  const tokens = {
    suspended: h.users.alice.token,
    suspendedExpired: await second("alice"),
    bobExpired: await second("bob"),
    app: await appToken(h),
  };
  await expire(h, tokens.suspendedExpired);
  await expire(h, tokens.bobExpired);
  const status = await post(h, h.users.bob, { status: "hello", visibility: "public" });
  expect(await h.store.suspendAccount(BUILD, { accountId: h.users.alice.id, now: NOW })).toEqual({ suspended: true });
  return { h, tokens, store, bob: h.users.bob, statusUrl: status.url as string };
}

type World = Awaited<ReturnType<typeof anonymousWorld>>;

// One request a route answers, the route's template, and the operation that judges the owner (its RPC name), or
// "after" for the access middleware's after-check.
type AnonymousRequest = { label: string; route: string; path: string; init?: () => RequestInit; judgedBy: string };

function anonymousRequests(w: World): AnonymousRequest[] {
  const app = (body: Record<string, string>) => () => json(body);
  const tooMany = Array.from({ length: 41 }, (_, i) => `id[]=${i + 1}`).join("&");
  return [
    {
      label: "app registration",
      route: "POST /api/v1/apps",
      path: "/api/v1/apps",
      init: app({ client_name: "c", redirect_uris: "https://c.test/cb", scopes: "read" }),
      judgedBy: "registerApp",
    },
    {
      label: "app registration without client_name (422)",
      route: "POST /api/v1/apps",
      path: "/api/v1/apps",
      init: app({ redirect_uris: "https://c.test/cb" }),
      judgedBy: "after",
    },
    {
      label: "app registration without redirect_uris (422)",
      route: "POST /api/v1/apps",
      path: "/api/v1/apps",
      init: app({ client_name: "c" }),
      judgedBy: "after",
    },
    {
      label: "app registration with a bad scope (422)",
      route: "POST /api/v1/apps",
      path: "/api/v1/apps",
      init: app({ client_name: "c", redirect_uris: "https://c.test/cb", scopes: "nope" }),
      judgedBy: "after",
    },
    {
      label: "app registration with a malformed body (400)",
      route: "POST /api/v1/apps",
      path: "/api/v1/apps",
      init: () => ({ headers: { "content-type": "application/json" }, body: "{" }),
      judgedBy: "after",
    },
    {
      label: "instance activity",
      route: "GET /api/v1/instance/activity",
      path: "/api/v1/instance/activity",
      judgedBy: "instanceActivity",
    },
    {
      label: "custom emoji",
      route: "GET /api/v1/custom_emojis",
      path: "/api/v1/custom_emojis",
      judgedBy: "customEmojis",
    },
    {
      label: "account",
      route: "GET /api/v1/accounts/:id",
      path: `/api/v1/accounts/${w.bob.id}`,
      judgedBy: "getAccount",
    },
    {
      label: "unknown account (404)",
      route: "GET /api/v1/accounts/:id",
      path: "/api/v1/accounts/0",
      judgedBy: "getAccount",
    },
    {
      label: "accounts by id",
      route: "GET /api/v1/accounts",
      path: `/api/v1/accounts?id[]=${w.bob.id}`,
      judgedBy: "getAccounts",
    },
    {
      label: "too many ids (422)",
      route: "GET /api/v1/accounts",
      path: `/api/v1/accounts?${tooMany}`,
      judgedBy: "after",
    },
    {
      label: "lookup",
      route: "GET /api/v1/accounts/lookup",
      path: "/api/v1/accounts/lookup?acct=bob",
      judgedBy: "lookupAccount",
    },
    {
      label: "lookup without acct (404)",
      route: "GET /api/v1/accounts/lookup",
      path: "/api/v1/accounts/lookup",
      judgedBy: "after",
    },
    {
      label: "featured hashtags",
      route: "GET /api/v1/accounts/:id/featured_tags",
      path: `/api/v1/accounts/${w.bob.id}/featured_tags`,
      judgedBy: "accountFeaturedTags",
    },
    {
      label: "oEmbed",
      route: "GET /api/oembed",
      path: `/api/oembed?url=${encodeURIComponent(w.statusUrl)}`,
      judgedBy: "after",
    },
    { label: "oEmbed without url (404)", route: "GET /api/oembed", path: "/api/oembed", judgedBy: "after" },
    {
      label: "oEmbed of a foreign url (404)",
      route: "GET /api/oembed",
      path: `/api/oembed?url=${encodeURIComponent("https://other.example/@a/1")}`,
      judgedBy: "after",
    },
    {
      label: "privacy policy (404)",
      route: "GET /api/v1/instance/privacy_policy",
      path: "/api/v1/instance/privacy_policy",
      judgedBy: "after",
    },
    {
      label: "terms of service (404)",
      route: "GET /api/v1/instance/terms_of_service",
      path: "/api/v1/instance/terms_of_service",
      judgedBy: "after",
    },
    {
      label: "terms of service of a malformed date (404)",
      route: "GET /api/v1/instance/terms_of_service/:date",
      path: "/api/v1/instance/terms_of_service/not-a-date",
      judgedBy: "after",
    },
    {
      label: "languages",
      route: "GET /api/v1/instance/languages",
      path: "/api/v1/instance/languages",
      judgedBy: "after",
    },
    {
      label: "translation languages",
      route: "GET /api/v1/instance/translation_languages",
      path: "/api/v1/instance/translation_languages",
      judgedBy: "after",
    },
    {
      label: "peer search",
      route: "GET /api/v1/peers/search",
      path: "/api/v1/peers/search?q=example",
      judgedBy: "after",
    },
    {
      label: "peer search without q",
      route: "GET /api/v1/peers/search",
      path: "/api/v1/peers/search",
      judgedBy: "after",
    },
  ];
}

async function send(h: ApiHarness, request: AnonymousRequest, token: string | null) {
  const method = request.route.split(" ")[0]!;
  const init = { ...request.init?.(), method };
  const response = await h.request(request.path, token === null ? init : bearer(token, init));
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    // An empty or non-JSON answer is compared as its text.
  }
  return {
    status: response.status,
    body,
    cacheControl: response.headers.get("cache-control"),
    vary: response.headers.get("vary"),
  };
}

// What an answer is compared by: an app registration's new credentials differ on every request.
function comparable(answer: Awaited<ReturnType<typeof send>>) {
  const { body } = answer;
  if (typeof body === "object" && body !== null && "client_id" in body) {
    return { ...answer, body: Object.keys(body).toSorted() };
  }
  return answer;
}

// Private, varying by Authorization as every anonymous route's answer does (WEB-7): never a public header.
const REFUSED = { ...DISABLED, cacheControl: "private, no-store", vary: "Authorization" };

const register = (h: ApiHarness, token: string | null) =>
  answer(
    h,
    "POST",
    "/api/v1/apps",
    token,
    json({ client_name: "c", redirect_uris: "https://c.test/cb", scopes: "read" }),
  );

describe("an anonymous route with a token", () => {
  it("covers every anonymous route of the table", async () => {
    const w = await anonymousWorld();
    const covered = new Set(anonymousRequests(w).map((request) => request.route));
    const anonymous = ROUTES.filter((route) => route.access === "anonymous").map((r) => `${r.method} ${r.path}`);
    expect([...covered].toSorted()).toEqual(anonymous.toSorted());
  });

  it("answers a suspended owner's token, expired or not, a private 403, errors and early answers included", async () => {
    const w = await anonymousWorld();
    for (const request of anonymousRequests(w)) {
      for (const token of [w.tokens.suspended, w.tokens.suspendedExpired]) {
        expect(await send(w.h, request, token), request.label).toEqual(REFUSED);
        w.store.state.failing = true;
        try {
          expect(await send(w.h, request, token), `${request.label}, the Store failing`).toEqual(REFUSED);
        } finally {
          w.store.state.failing = false;
        }
      }
    }
  });

  it("answers any other token as no token, judging each answer once", async () => {
    const w = await anonymousWorld();
    for (const request of anonymousRequests(w)) {
      const anonymous = comparable(await send(w.h, request, null));
      expect(anonymous.status, request.label).not.toBe(403);
      for (const token of ["unknown-token", w.tokens.bobExpired, w.tokens.app, w.bob.token]) {
        const { result, calls } = await w.store.callsOf(() => send(w.h, request, token));
        // The same answer, but private: a request with Authorization is never cached (WEB-7).
        expect(comparable(result), request.label).toEqual({ ...anonymous, cacheControl: "private, no-store" });
        // The judgment ran: in the route's one operation, or once after the handler.
        if (request.judgedBy === "after") {
          expect(calls.at(-1), request.label).toBe("checkNotSuspended");
          expect(
            calls.filter((name) => name === "checkNotSuspended"),
            request.label,
          ).toHaveLength(1);
        } else {
          expect(calls, request.label).toEqual([request.judgedBy]);
        }
      }
    }
  });

  it("drops the replaced answer's headers", async () => {
    const w = await anonymousWorld();
    // The real route table, with the languages answered under a public Cache-Control of the handler's own.
    const cached =
      (handler: ApiHandler): ApiHandler =>
      async (c, deps) => {
        const response = await handler(c, deps);
        response.headers.set("cache-control", "public, max-age=300");
        return response;
      };
    const routes = ROUTES.map((route) =>
      route.path === "/api/v1/instance/languages" ? { ...route, handler: cached(route.handler) } : route,
    );
    const api = mastodonApi(
      {
        build: () => BUILD,
        now: () => NOW,
        store: () => w.h.store,
        randomToken: () => "unused",
        images: (e) => imagesCodec(e.IMAGES),
      },
      routes,
    );
    const languages = (token: string | null) =>
      api.fetch(
        new Request("https://kopje.test/api/v1/instance/languages", token === null ? {} : bearer(token)),
        w.h.env,
        createExecutionContext(),
      );
    expect((await languages(null)).headers.get("cache-control")).toBe("public, max-age=300");
    const refused = await languages(w.tokens.suspended);
    expect([refused.status, refused.headers.get("cache-control"), await refused.json()]).toEqual([
      403,
      null,
      DISABLED.body,
    ]);
    // Under the API's caching middleware the route's declaration decides, never a handler's header: the anonymous
    // answer is public with Vary, and the suspended owner's 403 private (WEB-7).
    const app = new Hono<{ Bindings: Env }>();
    app.use("/api/*", apiHeaders);
    app.route("/", api);
    const throughApp = async (token: string | null) => {
      const response = await app.fetch(
        new Request("https://kopje.test/api/v1/instance/languages", token === null ? {} : bearer(token)),
        w.h.env,
        createExecutionContext(),
      );
      return [response.status, response.headers.get("cache-control"), response.headers.get("vary")];
    };
    expect(await throughApp(null)).toEqual([
      200,
      "max-age=300, public, stale-while-revalidate=30, stale-if-error=86400",
      "Authorization",
    ]);
    expect(await throughApp(w.tokens.suspended)).toEqual([403, "private, no-store", "Authorization"]);
  });

  it("records no activity", async () => {
    const w = await anonymousWorld();
    const carol = w.h.users.carol;
    for (const request of anonymousRequests(w)) {
      const { calls } = await w.store.callsOf(() => send(w.h, request, carol.token));
      expect(calls, request.label).not.toContain("noteActivity");
    }
    expect(await sql(w.h.store, "SELECT active_on FROM local_accounts WHERE account_id = ?", carol.id)).toEqual([
      { active_on: null },
    ]);
    // The same token on a token route is recorded.
    const { calls } = await w.store.callsOf(() => answer(w.h, "GET", "/api/v1/timelines/home", carol.token));
    expect(calls).toContain("noteActivity");
  });

  it("refuses a suspended owner's app registration before the app is written", async () => {
    const w = await anonymousWorld();
    const apps = () => sql(w.h.store, "SELECT count(*) AS n FROM oauth_clients");
    const [before] = await apps();
    expect(await register(w.h, w.tokens.suspendedExpired)).toEqual(DISABLED);
    expect(await register(w.h, w.tokens.suspended)).toEqual(DISABLED);
    expect(await apps()).toEqual([before]);
    expect((await register(w.h, null)).status).toBe(200);
    expect(await apps()).toEqual([{ n: Number(before!.n) + 1 }]);
  });

  // The limiter's 429 is an answer of the route too: a suspended owner's token turns it into the 403, where Mastodon's
  // Rack::Attack answers 429 first (docs/mastodon-deviations.md).
  it("answers a suspended owner's token 403 where the registration limiter refuses", async () => {
    let denying = false;
    const w = await anonymousWorld({ APP_REGISTRATION_LIMIT: { limit: () => Promise.resolve({ success: !denying }) } });
    denying = true;
    const throttled = { status: 429, body: { error: "Too many requests" } };
    expect(await register(w.h, null)).toEqual(throttled);
    const unknown = await w.store.callsOf(() => register(w.h, "unknown-token"));
    expect(unknown).toEqual({ result: throttled, calls: ["checkNotSuspended"] });
    expect(await register(w.h, w.tokens.suspended)).toEqual(DISABLED);
    expect(await register(w.h, w.tokens.suspendedExpired)).toEqual(DISABLED);
  });

  it("keeps no activity answer for a suspended owner, with a cold cache and during a dump's freeze", async () => {
    const w = await anonymousWorld();
    const kept = () => sql(w.h.store, "SELECT name FROM kopje_state WHERE name = 'activity_answer'");
    const activity = (token: string | null) => answer(w.h, "GET", "/api/v1/instance/activity", token);
    expect(await kept()).toEqual([]);
    expect(await activity(w.tokens.suspended)).toEqual(DISABLED);
    expect(await kept()).toEqual([]);
    const started = await w.h.store.dumpStart(BUILD);
    if (!started.ok) throw new Error(started.message);
    try {
      expect(await activity(w.tokens.suspendedExpired)).toEqual(DISABLED);
      expect((await activity(null)).status).toBe(200);
    } finally {
      expect(await w.h.store.dumpFinish(BUILD, started.cursor, true)).toMatchObject({ ok: true });
    }
    expect(await kept()).toEqual([]);
    // Without the suspended token the first request of the day keeps the answer.
    expect((await activity(null)).status).toBe(200);
    expect(await kept()).toEqual([{ name: "activity_answer" }]);
  });

  it("answers a deleted token as no token", async () => {
    const w = await anonymousWorld();
    const anonymous = await answer(w.h, "GET", "/api/v1/custom_emojis", null);
    expect(await answer(w.h, "GET", "/api/v1/custom_emojis", w.tokens.suspended)).toEqual(DISABLED);
    await runStoreJobs(w.h.store, BUILD, { now: NOW });
    expect(await sql(w.h.store, "SELECT 1 FROM oauth_tokens WHERE account_id = ?", w.h.users.alice.id)).toEqual([]);
    for (const token of [w.tokens.suspended, w.tokens.suspendedExpired]) {
      expect(await answer(w.h, "GET", "/api/v1/custom_emojis", token)).toEqual(anonymous);
    }
  });
});

// Mastodon's instance controllers read a user only in limited federation mode (their current_user override), which
// Kopje does not have: these routes read no token, and a suspended owner's gets what no token gets (AUTH-2).
describe("an instance read Mastodon answers without a user", () => {
  it("answers a suspended owner's token, expired or not, as no token, with the Store calls of no token", async () => {
    const w = await anonymousWorld();
    const paths = [
      "/api/v1/instance",
      "/api/v2/instance",
      "/api/v1/instance/rules",
      "/api/v1/instance/peers",
      "/api/v1/instance/extended_description",
    ];
    for (const path of paths) {
      const anonymous = await w.store.callsOf(() => answer(w.h, "GET", path, null));
      expect(anonymous.result.status, path).toBe(200);
      for (const token of [w.tokens.suspended, w.tokens.suspendedExpired]) {
        expect(await w.store.callsOf(() => answer(w.h, "GET", path, token)), path).toEqual(anonymous);
      }
    }
  });
});
