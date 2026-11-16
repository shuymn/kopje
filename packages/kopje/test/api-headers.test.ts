import { createExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { apiHeaders } from "../src/mastodon/caching";
import { DEPRECATED_ROUTES, mastodonApi, ROUTES } from "../src/mastodon/routes";
import { imagesCodec } from "../src/platform/images";
import type { StoreStub } from "../src/platform/store-client";
import { StoreUnavailableError } from "../src/platform/store-errors";
import { type ApiHarness, bearer, json, sql } from "./api-helpers";
import { harness, NOW } from "./app-helpers";
import { BUILD } from "./helpers";
import { scopedToken } from "./read-helpers";
import { storeWith } from "./setup-helpers";
import { community, post } from "./status-helpers";

// WEB-5: the security headers of every Mastodon API answer (mastodon/caching.ts apiHeaders), as Mastodon's
// Api::BaseController (Api::ContentSecurityPolicy) and Rails' default headers send them, and the Deprecation of the
// routes Mastodon deprecates (DEPRECATED_ROUTES), AUTH-2's 403 excepted. The paths that reach an API answer are those
// of test/api-caching.test.ts.

const SECURITY = {
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'; form-action 'none'",
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
};
const NONE = { "content-security-policy": null, "x-frame-options": null, "referrer-policy": null };

const securityOf = (response: Response) => ({
  status: response.status,
  headers: Object.fromEntries(Object.keys(SECURITY).map((name) => [name, response.headers.get(name)])),
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

// The answer to a request whose Store call fails with `error`, logged as the app logs it.
async function failing(error: Error, level: "error" | "warn") {
  const h = await world((store) => storeWith(store, { publicTimeline: () => Promise.reject(error) }));
  const logged = vi.spyOn(console, level).mockImplementation(() => {});
  try {
    return await h.request("/api/v1/timelines/public");
  } finally {
    logged.mockRestore();
  }
}

describe("the API's security headers", () => {
  it("every API answer carries the API's security headers", async () => {
    const h = await world();
    await suspendBob(h);
    const status = await post(h, h.users.alice, { status: "hello", visibility: "public" });
    const readonly = harness(h.store, { MAINTENANCE: "readonly" });
    const answers: [string, number, Response][] = [
      ["a token's 200", 200, await h.request("/api/v1/notifications", bearer(h.users.alice.token))],
      ["an anonymous 200", 200, await h.request("/api/v1/timelines/public")],
      ["an everyone 200", 200, await h.request("/api/v1/instance")],
      ["a token-reading instance route's 200", 200, await h.request("/api/v1/custom_emojis")],
      [
        "the app registration",
        200,
        await h.request("/api/v1/apps", json({ client_name: "c", redirect_uris: "urn:ietf:wg:oauth:2.0:oob" })),
      ],
      ["a handler's 422", 422, await h.request("/api/v1/statuses", bearer(h.users.alice.token, json({})))],
      ["a route's 404", 404, await h.request("/api/v1/statuses/999999")],
      ["an unknown API path", 404, await h.request("/api/v1/nonexistent")],
      ["a refused token", 401, await h.request("/api/v1/notifications", bearer("nope"))],
      ["the admin gate", 403, await h.request("/api/v1/admin/trends/links")],
      ["AUTH-2's 403 on a token route", 403, await h.request("/api/v1/notifications", bearer(h.users.bob.token))],
      ["AUTH-2's 403 on an anonymous route", 403, await h.request("/api/v1/custom_emojis", bearer(h.users.bob.token))],
      ["onError's 500", 500, await failing(new Error("a defect"), "error")],
      ["an unavailable Store's 503", 503, await failing(new StoreUnavailableError("transient"), "warn")],
      [
        "a maintenance 503",
        503,
        await readonly.request("/api/v1/statuses", bearer(h.users.alice.token, json({ status: "hi" }))),
      ],
      ["an off-domain read", 301, await h.send(new Request("https://other.kopje.test/api/v1/instance"))],
      [
        "an off-domain write",
        421,
        await h.send(
          new Request("https://other.kopje.test/api/v1/statuses", bearer(h.users.alice.token, json({ status: "hi" }))),
        ),
      ],
      ["userinfo", 200, await h.request("/oauth/userinfo", bearer(await scopedToken(h, "profile")))],
      ["userinfo refused", 401, await h.request("/oauth/userinfo", { method: "POST" })],
      ["oEmbed", 200, await h.request(`/api/oembed?url=${encodeURIComponent(String(status.url))}`)],
    ];
    for (const [label, expected, response] of answers) {
      expect(securityOf(response), label).toEqual({ status: expected, headers: SECURITY });
    }
  });

  it("a preflight, streaming and the answers outside the API carry none", async () => {
    const h = await world();
    const answers: [string, number, Response][] = [
      [
        "a preflight",
        204,
        await h.request("/api/v1/instance", {
          method: "OPTIONS",
          headers: { origin: "https://client.test", "access-control-request-method": "GET" },
        }),
      ],
      ["the streaming health check", 200, await h.request("/api/v1/streaming/health")],
      ["a streaming path without an upgrade", 404, await h.request("/api/v1/streaming/public")],
      // Doorkeeper's answers and the documents outside the API keep their own headers (H4).
      ["the token endpoint", 401, await h.request("/oauth/token", json({}))],
      ["NodeInfo", 200, await h.request("/.well-known/nodeinfo")],
    ];
    for (const [label, expected, response] of answers) {
      expect(securityOf(response), label).toEqual({ status: expected, headers: NONE });
    }
  });
});

const deprecationOf = (response: Response) => ({
  status: response.status,
  deprecation: response.headers.get("deprecation"),
});

// The suspended owner's 403 (AUTH-2), as its body shows it.
async function refusedAsSuspended(response: Response) {
  return { ...deprecationOf(response), body: await response.json() };
}
const SUSPENDED = { status: 403, deprecation: null, body: { error: "Your login is currently disabled" } };

const deps = (store: () => StoreStub) => ({
  build: () => BUILD,
  now: () => NOW,
  store,
  randomToken: () => "unused",
  images: (e: Env) => imagesCodec(e.IMAGES),
});

describe("Deprecation", () => {
  it("deprecated routes carry Mastodon's Deprecation", async () => {
    const h = await world();
    const { alice } = h.users;
    const created = await h.request("/api/v1/filters", bearer(alice.token, json({ phrase: "cat", context: ["home"] })));
    const { id } = await created.json<{ id: string }>();
    const filter = `/api/v1/filters/${id}`;
    const update = (method: string) => bearer(alice.token, { ...json({ phrase: "dog", context: ["home"] }), method });
    const NOVEMBER_2022 = "@1668384000";
    const MARCH_2022 = "@1648598400";
    const answers: [string, Response, { status: number; deprecation: string | null }][] = [
      ["POST /api/v1/filters", created, { status: 200, deprecation: NOVEMBER_2022 }],
      ["GET /api/v1/instance", await h.request("/api/v1/instance"), { status: 200, deprecation: NOVEMBER_2022 }],
      [
        "GET /api/v1/filters",
        await h.request("/api/v1/filters", bearer(alice.token)),
        { status: 200, deprecation: NOVEMBER_2022 },
      ],
      [
        "GET /api/v1/filters/:id",
        await h.request(filter, bearer(alice.token)),
        { status: 200, deprecation: NOVEMBER_2022 },
      ],
      ["PUT /api/v1/filters/:id", await h.request(filter, update("PUT")), { status: 200, deprecation: NOVEMBER_2022 }],
      [
        "PATCH /api/v1/filters/:id",
        await h.request(filter, update("PATCH")),
        { status: 200, deprecation: NOVEMBER_2022 },
      ],
      [
        "DELETE /api/v1/filters/:id",
        await h.request(filter, bearer(alice.token, { method: "DELETE" })),
        { status: 200, deprecation: NOVEMBER_2022 },
      ],
      [
        "GET /api/v1/accounts/:id/identity_proofs",
        await h.request(`/api/v1/accounts/${alice.id}/identity_proofs`, bearer(alice.token)),
        { status: 200, deprecation: MARCH_2022 },
      ],
      ["GET /api/v1/trends", await h.request("/api/v1/trends"), { status: 200, deprecation: MARCH_2022 }],
      [
        "GET /api/v1/suggestions",
        await h.request("/api/v1/suggestions", bearer(alice.token)),
        { status: 200, deprecation: "@1621123200" },
      ],
      // Their successors, the alias's own path, a sibling of an index Mastodon deprecates alone, and paths under a
      // deprecated one.
      ["GET /api/v2/instance", await h.request("/api/v2/instance"), { status: 200, deprecation: null }],
      ["GET /api/v1/instance/rules", await h.request("/api/v1/instance/rules"), { status: 200, deprecation: null }],
      [
        "GET /api/v2/filters",
        await h.request("/api/v2/filters", bearer(alice.token)),
        { status: 200, deprecation: null },
      ],
      ["GET /api/v1/trends/tags", await h.request("/api/v1/trends/tags"), { status: 200, deprecation: null }],
      [
        "DELETE /api/v1/suggestions/:id",
        await h.request(`/api/v1/suggestions/${h.users.bob.id}`, bearer(alice.token, { method: "DELETE" })),
        { status: 200, deprecation: null },
      ],
      [
        "GET /api/v2/suggestions",
        await h.request("/api/v2/suggestions", bearer(alice.token)),
        { status: 200, deprecation: null },
      ],
    ];
    for (const [label, response, expected] of answers) {
      expect(deprecationOf(response), label).toEqual(expected);
    }
    // The table holds these ten routes, the collections routes under /api/v1_alpha (test/collections.test.ts) and no
    // other.
    const deprecated = answers.filter(([, , expected]) => expected.deprecation !== null).map(([label]) => label);
    const alpha = (key: string) => key.includes(" /api/v1_alpha/");
    const keys = [...DEPRECATED_ROUTES.keys()];
    expect(keys.filter(alpha).filter((key) => !key.includes("collections"))).toEqual([]);
    expect(keys.filter((key) => !alpha(key)).toSorted()).toEqual(deprecated.toSorted());
  });

  it("an early refusal carries it; a suspended owner's 403 does not", async () => {
    const h = await world();
    await suspendBob(h);
    const readOnly = await scopedToken(h, "read");
    expect(deprecationOf(await h.request("/api/v1/filters"))).toEqual({ status: 401, deprecation: "@1668384000" });
    expect(
      deprecationOf(await h.request("/api/v1/filters", bearer(readOnly, json({ phrase: "cat", context: ["home"] })))),
    ).toEqual({ status: 403, deprecation: "@1668384000" });
    // Thrown by the operation's judgment, on a scope route and on a route whose token is optional.
    for (const path of ["/api/v1/filters", "/api/v1/trends"]) {
      expect(await refusedAsSuspended(await h.request(path, bearer(h.users.bob.token))), path).toEqual(SUSPENDED);
    }
  });

  it("a suspended owner's replaced answer carries none", async () => {
    // No deprecated route is anonymous: one is declared for the access middleware's replacement of the answer.
    const h = await world();
    await suspendBob(h);
    const app = new Hono<{ Bindings: Env }>();
    app.use("/api/*", apiHeaders);
    const deprecated = new Map([...DEPRECATED_ROUTES, ["GET /api/v1/instance/languages", "2022-11-14"]]);
    app.route(
      "/",
      mastodonApi(
        deps(() => h.store),
        ROUTES,
        deprecated,
      ),
    );
    const languages = (init: RequestInit) =>
      app.fetch(new Request("https://kopje.test/api/v1/instance/languages", init), h.env, createExecutionContext());
    expect(deprecationOf(await languages({}))).toEqual({ status: 200, deprecation: "@1668384000" });
    expect(await refusedAsSuspended(await languages(bearer(h.users.bob.token)))).toEqual(SUSPENDED);
  });

  it("the table names routed routes only", () => {
    const store = () => {
      throw new Error("no Store");
    };
    expect(() => mastodonApi(deps(store), ROUTES, new Map([["GET /api/v1/instance/", "2022-11-14"]]))).toThrow(
      "GET /api/v1/instance/ is deprecated but names no route",
    );
    expect(() => mastodonApi(deps(store), ROUTES, new Map([["HEAD /api/v1/instance", "2022-11-14"]]))).toThrow(
      "HEAD /api/v1/instance is deprecated but names no route",
    );
    expect(() => mastodonApi(deps(store), ROUTES, new Map([["GET /api/v1/instance", "14 November 2022"]]))).toThrow(
      "14 November 2022 is not a date",
    );
    // The branch ran on the table itself.
    expect(() => mastodonApi(deps(store))).not.toThrow();
  });
});
