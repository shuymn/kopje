import { describe, expect, it, vi } from "vitest";

import {
  ANONYMOUS,
  ANONYMOUS_BY_LANGUAGE,
  ANONYMOUS_LONG,
  type Caching,
  cacheHeaders,
  EVERYONE,
  PRIVATE,
  PRIVATE_BY_LANGUAGE,
} from "../src/mastodon/caching";
import { mastodonApi, ROUTES } from "../src/mastodon/routes";
import { imagesCodec } from "../src/platform/images";
import type { StoreStub } from "../src/platform/store-client";
import { StoreUnavailableError } from "../src/platform/store-errors";
import { type ApiHarness, bearer, json, setSetting, sql } from "./api-helpers";
import { harness, NOW } from "./app-helpers";
import { BUILD } from "./helpers";
import { appToken, scopedToken } from "./read-helpers";
import { storeWith } from "./setup-helpers";
import { community, post } from "./status-helpers";

// WEB-7: the Cache-Control and Vary of every Mastodon API answer (mastodon/caching.ts), as Mastodon's
// ApplicationController and Api::BaseController set them, with the route table's declarations.

const PRIVATE_HEADER = "private, no-store";
const SHORT = "max-age=15, public, stale-while-revalidate=30, stale-if-error=86400";
const LONG = "max-age=300, public, stale-while-revalidate=30, stale-if-error=86400";

const headersOf = (response: Response) => ({
  status: response.status,
  cacheControl: response.headers.get("cache-control"),
  vary: response.headers.get("vary"),
});

function world(wrapStore?: (store: StoreStub) => StoreStub) {
  return community(["alice", "bob"], "read write follow", { wrapStore });
}

// bob's token is held by a suspended owner (AUTH-2): the row stays until the suspension's tokens job runs.
async function suspendBob(h: ApiHarness & { users: Record<"bob", { id: string }> }) {
  await sql(
    h.store,
    "UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?",
    new Date(NOW).toISOString(),
    h.users.bob.id,
  );
}

describe("the API's private answers", () => {
  it("an authenticated read is private", async () => {
    const h = await world();
    const response = await h.request("/api/v1/notifications", bearer(h.users.alice.token));
    expect(headersOf(response)).toEqual({ status: 200, cacheControl: PRIVATE_HEADER, vary: "Authorization" });
  });

  it("an authenticated write is private", async () => {
    const h = await world();
    const response = await h.request("/api/v1/statuses", bearer(h.users.alice.token, json({ status: "hi" })));
    expect(headersOf(response)).toEqual({ status: 200, cacheControl: PRIVATE_HEADER, vary: "Authorization" });
  });

  it("the app registration is private", async () => {
    const h = await world();
    const response = await h.request(
      "/api/v1/apps",
      json({ client_name: "c", redirect_uris: "urn:ietf:wg:oauth:2.0:oob", scopes: "read" }),
    );
    expect(headersOf(response)).toEqual({ status: 200, cacheControl: PRIVATE_HEADER, vary: "Authorization" });
    expect(await response.json()).toHaveProperty("client_secret");
  });

  it("an error answer is private", async () => {
    const h = await world();
    // A 422 of a write, and the 404 of a route anonymous readers may cache.
    const refused = await h.request("/api/v1/statuses", bearer(h.users.alice.token, json({})));
    expect(headersOf(refused)).toEqual({ status: 422, cacheControl: PRIVATE_HEADER, vary: "Authorization" });
    const missing = await h.request("/api/v1/statuses/999999");
    expect(headersOf(missing)).toEqual({ status: 404, cacheControl: PRIVATE_HEADER, vary: "Authorization" });
  });

  it("a refused token is private and varies by Authorization", async () => {
    const h = await world();
    for (const path of ["/api/v1/notifications", "/api/v1/timelines/public"]) {
      const response = await h.request(path, bearer("nope"));
      expect(headersOf(response), path).toEqual({ status: 401, cacheControl: PRIVATE_HEADER, vary: "Authorization" });
    }
    // The admin gate's 403 to a request without a token, under the trend list's own Vary.
    expect(headersOf(await h.request("/api/v1/admin/trends/links"))).toEqual({
      status: 403,
      cacheControl: PRIVATE_HEADER,
      vary: "Authorization, Accept-Language",
    });
  });

  it("a thrown error is private", async () => {
    const h = await world((store) => storeWith(store, { publicTimeline: () => Promise.reject(new Error("a defect")) }));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await h.request("/api/v1/timelines/public");
      expect(headersOf(response)).toEqual({ status: 500, cacheControl: PRIVATE_HEADER, vary: "Authorization" });
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it("an unavailable Store's answer is private", async () => {
    const h = await world((store) =>
      storeWith(store, { publicTimeline: () => Promise.reject(new StoreUnavailableError("transient")) }),
    );
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const response = await h.request("/api/v1/timelines/public");
      expect(headersOf(response)).toEqual({ status: 503, cacheControl: PRIVATE_HEADER, vary: "Authorization" });
    } finally {
      warned.mockRestore();
    }
  });

  it("a maintenance answer is private", async () => {
    const h = await world();
    // The same Store under a read-only env.
    const readonly = harness(h.store, { MAINTENANCE: "readonly" });
    const refused = await readonly.request("/api/v1/statuses", bearer(h.users.alice.token, json({ status: "hi" })));
    // The gate answered before any route: no declaration, so no Vary.
    expect(headersOf(refused)).toEqual({ status: 503, cacheControl: PRIVATE_HEADER, vary: null });
    // The branch ran: reads still answer, with their route's caching.
    expect(headersOf(await readonly.request("/api/v1/instance"))).toEqual({
      status: 200,
      cacheControl: LONG,
      vary: null,
    });
  });

  it("an unknown API path is private", async () => {
    const h = await world();
    for (const init of [{}, bearer(h.users.alice.token)]) {
      const response = await h.request("/api/v1/nonexistent", init);
      expect(headersOf(response)).toEqual({ status: 404, cacheControl: PRIVATE_HEADER, vary: null });
    }
  });

  it("an off-domain answer stays private", async () => {
    const h = await world();
    const moved = await h.send(new Request("https://other.kopje.test/api/v1/instance"));
    expect(headersOf(moved)).toEqual({ status: 301, cacheControl: PRIVATE_HEADER, vary: null });
    const misdirected = await h.send(
      new Request("https://other.kopje.test/api/v1/statuses", bearer(h.users.alice.token, json({ status: "hi" }))),
    );
    expect(headersOf(misdirected)).toEqual({ status: 421, cacheControl: PRIVATE_HEADER, vary: null });
  });

  it("userinfo is private", async () => {
    const h = await world();
    const token = await scopedToken(h, "profile");
    for (const method of ["GET", "POST"]) {
      const answered = await h.request("/oauth/userinfo", bearer(token, { method }));
      expect(headersOf(answered), method).toEqual({ status: 200, cacheControl: PRIVATE_HEADER, vary: "Authorization" });
      const refused = await h.request("/oauth/userinfo", { method });
      expect(headersOf(refused), method).toEqual({ status: 401, cacheControl: PRIVATE_HEADER, vary: "Authorization" });
    }
  });
});

describe("the API's public answers", () => {
  it("an anonymous public read", async () => {
    const h = await world();
    const status = await post(h, h.users.alice, { status: "hello", visibility: "public" });
    for (const path of [
      "/api/v1/timelines/public",
      `/api/v1/accounts/${h.users.alice.id}`,
      `/api/v1/statuses/${status.id}`,
    ]) {
      expect(headersOf(await h.request(path)), path).toEqual({
        status: 200,
        cacheControl: SHORT,
        vary: "Authorization",
      });
    }
  });

  it("any Authorization header makes it private", async () => {
    const h = await world();
    const path = "/api/v1/timelines/public";
    const sent: [string, string, number][] = [
      ["a user's token", `Bearer ${h.users.alice.token}`, 200],
      ["an app token", `Bearer ${await appToken(h)}`, 200],
      ["an unknown token", "Bearer invalid", 401],
      ["another scheme", "Basic eDp5", 200],
    ];
    for (const [label, authorization, status] of sent) {
      const response = await h.request(path, { headers: { authorization } });
      expect(headersOf(response), label).toEqual({ status, cacheControl: PRIVATE_HEADER, vary: "Authorization" });
    }
    // An empty header is none, as Rails' present? reads it.
    expect(headersOf(await h.request(path, { headers: { authorization: "" } }))).toEqual({
      status: 200,
      cacheControl: SHORT,
      vary: "Authorization",
    });
  });

  it("trending statuses vary by language", async () => {
    const h = await world();
    for (const path of ["/api/v1/trends/statuses", "/api/v1/trends/links"]) {
      expect(headersOf(await h.request(path)), path).toEqual({
        status: 200,
        cacheControl: SHORT,
        vary: "Authorization, Accept-Language",
      });
      expect(headersOf(await h.request(path, bearer(h.users.alice.token))), path).toEqual({
        status: 200,
        cacheControl: PRIVATE_HEADER,
        vary: "Authorization, Accept-Language",
      });
    }
  });

  it("an everyone read", async () => {
    const h = await world();
    await suspendBob(h);
    for (const path of ["/api/v1/instance", "/api/v2/instance", "/api/v1/instance/rules"]) {
      // A suspended owner's token too: these routes read no token (AUTH-2), so every caller gets the same answer.
      for (const init of [{}, bearer(h.users.alice.token), bearer(h.users.bob.token), bearer("invalid")]) {
        expect(headersOf(await h.request(path, init)), path).toEqual({ status: 200, cacheControl: LONG, vary: null });
      }
    }
  });

  it("a token-reading instance route varies by Authorization", async () => {
    const h = await world();
    await suspendBob(h);
    for (const path of ["/api/v1/instance/languages", "/api/v1/custom_emojis"]) {
      expect(headersOf(await h.request(path)), path).toEqual({
        status: 200,
        cacheControl: LONG,
        vary: "Authorization",
      });
      expect(headersOf(await h.request(path, bearer(h.users.alice.token))), path).toEqual({
        status: 200,
        cacheControl: PRIVATE_HEADER,
        vary: "Authorization",
      });
      expect(headersOf(await h.request(path, bearer(h.users.bob.token))), path).toEqual({
        status: 403,
        cacheControl: PRIVATE_HEADER,
        vary: "Authorization",
      });
    }
  });

  it("the block list varies by Authorization under every setting", async () => {
    const h = await world();
    await sql(
      h.store,
      `INSERT INTO instance_domain_blocks (domain, severity, public_comment, created_at, updated_at)
				VALUES ('blocked.example', 'suspend', 'spam', ?, ?)`,
      new Date(NOW).toISOString(),
      new Date(NOW).toISOString(),
    );
    const read = async (token?: string) => {
      const response = await h.request("/api/v1/instance/domain_blocks", token === undefined ? {} : bearer(token));
      const text = await response.text();
      const body = text === "" ? null : (JSON.parse(text) as { comment: string | null }[]);
      return { ...headersOf(response), comments: body?.map((block) => block.comment) ?? null };
    };
    for (const [blocks, rationale, anonymous, user] of [
      ["all", "all", { status: 200, cacheControl: LONG, comments: ["spam"] }, ["spam"]],
      ["all", "users", { status: 200, cacheControl: LONG, comments: [null] }, ["spam"]],
      ["users", "users", { status: 404, cacheControl: PRIVATE_HEADER, comments: null }, ["spam"]],
    ] as const) {
      await setSetting(h.store, "show_domain_blocks", blocks);
      await setSetting(h.store, "show_domain_blocks_rationale", rationale);
      const label = `${blocks}/${rationale}`;
      expect(await read(), label).toEqual({ ...anonymous, vary: "Authorization" });
      expect(await read(h.users.alice.token), label).toEqual({
        status: 200,
        cacheControl: PRIVATE_HEADER,
        vary: "Authorization",
        comments: user,
      });
    }
  });
});

describe("answers left as they are", () => {
  it("a preflight carries no Cache-Control", async () => {
    const h = await world();
    const response = await h.request("/api/v1/instance", {
      method: "OPTIONS",
      headers: { origin: "https://client.test", "access-control-request-method": "GET" },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(headersOf(response)).toEqual({ status: 204, cacheControl: null, vary: null });
  });

  it("streaming keeps its own headers", async () => {
    const h = await world();
    const health = await h.request("/api/v1/streaming/health");
    expect(headersOf(health)).toEqual({ status: 200, cacheControl: PRIVATE_HEADER, vary: null });
    for (const path of ["/api/v1/streaming", "/api/v1/streaming/public"]) {
      // Not an upgrade: Mastodon's streaming server's 404, with no Cache-Control.
      expect(headersOf(await h.request(path)), path).toEqual({ status: 404, cacheControl: null, vary: null });
    }
  });
});

describe("the route table's declarations", () => {
  const declared = (caching: Caching) =>
    ROUTES.filter((route) => route.caching === caching).map((route) => `${route.method} ${route.path}`);

  it("declares Mastodon's public routes", () => {
    expect(declared(EVERYONE).toSorted()).toEqual(
      [
        "GET /api/v1/instance",
        "GET /api/v2/instance",
        "GET /api/v1/instance/rules",
        "GET /api/v1/instance/peers",
        "GET /api/v1/instance/extended_description",
      ].toSorted(),
    );
    expect(declared(ANONYMOUS_LONG).toSorted()).toEqual(
      [
        "GET /api/v1/custom_emojis",
        "GET /api/v1/instance/languages",
        "GET /api/v1/instance/privacy_policy",
        "GET /api/v1/instance/terms_of_service",
        "GET /api/v1/instance/terms_of_service/:date",
        "GET /api/v1/instance/translation_languages",
        "GET /api/v1/instance/activity",
        "GET /api/v1/instance/domain_blocks",
        "GET /api/v1/peers/search",
      ].toSorted(),
    );
    expect(declared(ANONYMOUS)).toHaveLength(26);
    // Of them, the collections reads (cache_if_unauthenticated! in CollectionsController#index and #show and
    // InCollectionsController#index), under both prefixes.
    expect(declared(ANONYMOUS).filter((name) => name.includes("collections"))).toEqual(
      ["/api/v1", "/api/v1_alpha"].flatMap((prefix) => [
        `GET ${prefix}/accounts/:id/collections`,
        `GET ${prefix}/accounts/:id/in_collections`,
        `GET ${prefix}/collections/:id`,
      ]),
    );
    expect(declared(ANONYMOUS_BY_LANGUAGE).toSorted()).toEqual([
      "GET /api/v1/trends/links",
      "GET /api/v1/trends/statuses",
    ]);
    expect(declared(PRIVATE_BY_LANGUAGE).toSorted()).toEqual([
      "GET /api/v1/admin/trends/links",
      "GET /api/v1/admin/trends/statuses",
    ]);
    // Every other route is private.
    expect(declared(PRIVATE)).toHaveLength(ROUTES.length - 44);
  });

  it("only routes that never read a token declare EVERYONE", () => {
    for (const route of ROUTES.filter((r) => r.caching === EVERYONE)) {
      expect(route.access, `${route.method} ${route.path}`).toBe("public");
    }
    const deps = {
      build: () => BUILD,
      now: () => NOW,
      store: () => {
        throw new Error("no Store");
      },
      randomToken: () => "unused",
      images: (e: Env) => imagesCodec(e.IMAGES),
    };
    const emojis = ROUTES.find((route) => route.path === "/api/v1/custom_emojis")!;
    expect(() => mastodonApi(deps, [{ ...emojis, caching: EVERYONE }])).toThrow(
      "GET /api/v1/custom_emojis reads a token: it cannot be cached for everyone",
    );
    // The branch ran on a route that reads none.
    expect(() => mastodonApi(deps, [{ ...emojis, access: "public", caching: EVERYONE }])).not.toThrow();
  });
});

describe("cacheHeaders", () => {
  const declarations: [string, Caching | undefined][] = [
    ["none", undefined],
    ["PRIVATE", PRIVATE],
    ["PRIVATE_BY_LANGUAGE", PRIVATE_BY_LANGUAGE],
    ["ANONYMOUS", ANONYMOUS],
    ["ANONYMOUS_BY_LANGUAGE", ANONYMOUS_BY_LANGUAGE],
    ["ANONYMOUS_LONG", ANONYMOUS_LONG],
    ["EVERYONE", EVERYONE],
  ];
  const statuses = [100, 200, 201, 204, 299, 301, 304, 400, 401, 403, 404, 422, 500, 503];
  const expected = (caching: Caching | undefined, status: number, sent: boolean) => {
    const vary = caching?.vary ?? null;
    const success = status >= 200 && status < 300;
    if (caching === EVERYONE && success) {
      return { cacheControl: LONG, vary };
    }
    if (caching === ANONYMOUS_LONG && success && !sent) {
      return { cacheControl: LONG, vary };
    }
    if ((caching === ANONYMOUS || caching === ANONYMOUS_BY_LANGUAGE) && success && !sent) {
      return { cacheControl: SHORT, vary };
    }
    return { cacheControl: PRIVATE_HEADER, vary };
  };

  it("decides every declaration, status class and Authorization", () => {
    for (const [name, caching] of declarations) {
      for (const status of statuses) {
        for (const sent of [false, true]) {
          expect(cacheHeaders(caching, status, sent), `${name} ${status} ${sent}`).toEqual(
            expected(caching, status, sent),
          );
        }
      }
    }
    expect(PRIVATE.vary).toBe("Authorization");
    expect(ANONYMOUS_BY_LANGUAGE.vary).toBe("Authorization, Accept-Language");
    expect(PRIVATE_BY_LANGUAGE.vary).toBe("Authorization, Accept-Language");
    expect([ANONYMOUS.vary, ANONYMOUS_LONG.vary, EVERYONE.vary]).toEqual(["Authorization", "Authorization", null]);
  });
});
