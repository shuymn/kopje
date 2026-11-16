import { describe, expect, it, vi } from "vitest";

import type { StoreStub } from "../src/platform/store-client";
import { StoreUnavailableError } from "../src/platform/store-errors";
import { type ApiHarness, bearer, json, sql } from "./api-helpers";
import { harness, NOW } from "./app-helpers";
import { scopedToken } from "./read-helpers";
import { storeWith } from "./setup-helpers";
import { community, post } from "./status-helpers";

// WEB-5: the security headers of every Mastodon API answer (mastodon/caching.ts apiHeaders), as Mastodon's
// Api::BaseController (Api::ContentSecurityPolicy) and Rails' default headers send them. The paths that reach an
// API answer are those of test/api-caching.test.ts.

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
