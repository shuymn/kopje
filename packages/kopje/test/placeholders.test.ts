import { describe, expect, it } from "vitest";

import { type ApiHarness, apiHarness, bearer, form, login, registerApp, seedAccount, sql } from "./api-helpers";
import { appToken, appTokenWith, scopedToken } from "./read-helpers";
import { community, remoteAccount } from "./status-helpers";

// Features Kopje has no data for yet answer empty, under the access Mastodon gives each route (AUTH-2).

describe("features without data yet", () => {
  const userLists: [string, string][] = [
    ["/api/v1/filters", "read:filters"],
    ["/api/v2/filters", "read:filters"],
  ];

  it.each(userLists)("%s is an empty list of the user, under %s (AUTH-2)", async (route, scope) => {
    const h = await apiHarness();
    await seedAccount(h.store, { username: "alice", email: "alice@example.com" });
    const response = await h.request(route, bearer(await scopedToken(h, scope)));
    expect(response.status).toBe(200);
    expect(response.headers.get("link")).toBeNull();
    expect(await response.json()).toEqual([]);
    expect((await h.request(route)).status).toBe(401);
    expect((await h.request(route, bearer("nope"))).status).toBe(401);
    expect((await h.request(route, bearer(await scopedToken(h, "write")))).status).toBe(403);
    expect((await h.request(route, bearer(await appToken(h)))).status).toBe(422);
  });

  it("a revoked token gets no empty list", async () => {
    const h = await community(["alice"]);
    await sql(h.store, "DELETE FROM oauth_tokens WHERE kind = 'access'");
    expect((await h.request("/api/v2/filters", bearer(h.users.alice.token))).status).toBe(401);
  });

  // Mastodon's answers when the feature has nothing to show or is not configured, each under its route's scope.
  const recordNotFound = { error: "Record not found" };
  const notFound = { error: "Not Found" };
  const userAnswers: [string, string, string, number, unknown][] = [
    ["GET", "/api/v1/annual_reports", "read:accounts", 200, { annual_reports: [], accounts: [], statuses: [] }],
    ["GET", "/api/v1/annual_reports/2025", "read:accounts", 404, recordNotFound],
    ["GET", "/api/v1/annual_reports/2026/state", "read:accounts", 200, { state: "ineligible" }],
    ["POST", "/api/v1/annual_reports/2025/read", "write:accounts", 404, recordNotFound],
    ["POST", "/api/v1/annual_reports/2026/generate", "write:accounts", 200, {}],
    ["GET", "/api/v1/emails/check_confirmation", "read:accounts", 200, true],
    ["POST", "/api/v1/statuses/123/translate", "read:statuses", 404, notFound],
    ["GET", "/api/v1_alpha/async_refreshes/abc", "read", 404, notFound],
  ];

  const send = async (h: ApiHarness, method: string, route: string, token?: string) => {
    const response = await h.request(route, token === undefined ? { method } : bearer(token, { method }));
    return { status: response.status, body: await response.json<unknown>() };
  };

  it.each(userAnswers)("%s %s answers the user under %s (AUTH-2)", async (method, route, scope, status, body) => {
    const h = await apiHarness();
    const alice = await seedAccount(h.store, { username: "alice", email: "alice@example.com" });
    expect(await send(h, method, route, await scopedToken(h, scope))).toEqual({ status, body });
    expect((await send(h, method, route)).status).toBe(401);
    expect((await send(h, method, route, "nope")).status).toBe(401);
    // A scope the route does not take (read and write are disjoint; push covers neither).
    const other = scope.startsWith("read") ? "write" : scope.startsWith("write") ? "read" : "push";
    expect(await send(h, method, route, await scopedToken(h, other))).toEqual({
      status: 403,
      body: { error: "This action is outside the authorized scopes" },
    });
    expect(await send(h, method, route, await appTokenWith(h, scope))).toEqual({
      status: 422,
      body: { error: "This method requires an authenticated user" },
    });
    const token = await scopedToken(h, scope);
    await sql(h.store, "UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?", "2026-01-01", alice);
    expect((await send(h, method, route, token)).status).toBe(403);
  });

  it("generates no annual report: the list stays empty and the year's report is not found", async () => {
    const h = await apiHarness();
    await seedAccount(h.store, { username: "alice", email: "alice@example.com" });
    const token = await scopedToken(h, "read:accounts write:accounts");
    expect(await send(h, "POST", "/api/v1/annual_reports/2026/generate", token)).toEqual({ status: 200, body: {} });
    expect(await send(h, "GET", "/api/v1/annual_reports", token)).toEqual({
      status: 200,
      body: { annual_reports: [], accounts: [], statuses: [] },
    });
    expect(await send(h, "GET", "/api/v1/annual_reports/2026", token)).toEqual({ status: 404, body: recordNotFound });
    expect(await send(h, "GET", "/api/v1/annual_reports/2026/state", token)).toEqual({
      status: 200,
      body: { state: "ineligible" },
    });
  });

  it("/api/v1/emails/confirmations refuses every token with write:accounts, as no user signed up through an app", async () => {
    const h = await apiHarness();
    await seedAccount(h.store, { username: "alice", email: "alice@example.com" });
    const refused = {
      status: 403,
      body: { error: "This method is only available to the application the user originally signed-up with" },
    };
    const route = "/api/v1/emails/confirmations";
    expect(await send(h, "POST", route, await scopedToken(h, "write:accounts"))).toEqual(refused);
    // Mastodon takes app tokens here, and refuses them for the same reason.
    expect(await send(h, "POST", route, await appTokenWith(h, "write:accounts"))).toEqual(refused);
    expect(await send(h, "POST", route, await scopedToken(h, "read"))).toEqual({
      status: 403,
      body: { error: "This action is outside the authorized scopes" },
    });
    expect((await send(h, "POST", route)).status).toBe(401);
    expect((await send(h, "POST", route, "nope")).status).toBe(401);
  });
});

// Routes that answer as Mastodon with the feature off and need no token, yet read a sent one as Mastodon's
// Api::BaseController does: a suspended user's held token is refused, and any other token that is not a valid user
// token reads as none (MD-3; AUTH-2's exception).
describe("feature-off routes that read a sent token", () => {
  const userRequired = { status: 422, body: JSON.stringify({ error: "This method requires an authenticated user" }) };
  const disabled = { status: 403, body: JSON.stringify({ error: "Your login is currently disabled" }) };
  const recordNotFound = { status: 404, body: JSON.stringify({ error: "Record not found" }) };
  const emptyNotFound = { status: 404, body: "" };

  const raw = async (h: ApiHarness, method: string, route: string, token?: string) => {
    const response = await h.request(route, token === undefined ? { method } : bearer(token, { method }));
    return { status: response.status, body: await response.text() };
  };
  const donation = (h: ApiHarness, token?: string) => raw(h, "GET", "/api/v1/donation_campaigns", token);
  const subscribe = (h: ApiHarness, id: string, token?: string) =>
    raw(h, "POST", `/api/v1/accounts/${id}/email_subscriptions`, token);
  const suspend = (h: ApiHarness, id: string) =>
    sql(h.store, "UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?", "2026-01-01T00:00:00.000Z", id);

  it("donation campaigns answer 204 to a user of any scope, 422 without a user, 403 to a suspended user", async () => {
    const h = await apiHarness();
    const alice = await seedAccount(h.store, { username: "alice", email: "alice@example.com" });
    for (const scope of ["read", "push"]) {
      expect(await donation(h, await scopedToken(h, scope))).toEqual({ status: 204, body: "" });
    }
    expect(await donation(h)).toEqual(userRequired);
    expect(await donation(h, "nope")).toEqual(userRequired);
    expect(await donation(h, await appToken(h))).toEqual(userRequired);
    const held = await scopedToken(h, "read");
    await suspend(h, alice);
    expect(await donation(h, held)).toEqual(disabled);
  });

  it("e-mail subscriptions answer 404 as with the feature off, and 403 to a suspended user's token", async () => {
    const h = await apiHarness();
    const alice = await seedAccount(h.store, { username: "alice", email: "alice@example.com" });
    const bob = await seedAccount(h.store, { username: "bob", email: "bob@example.com" });
    const carol = await remoteAccount(h.store, "carol");
    expect(await subscribe(h, "0")).toEqual(recordNotFound);
    expect(await subscribe(h, carol)).toEqual(recordNotFound);
    expect(await subscribe(h, alice)).toEqual(emptyNotFound);
    // The target's own suspension: Account.local finds it.
    await suspend(h, bob);
    expect(await subscribe(h, bob)).toEqual(emptyNotFound);
    // Any token but a suspended user's leaves the anonymous answer.
    const valid = await scopedToken(h, "read");
    for (const token of ["nope", await appToken(h), valid]) {
      expect(await subscribe(h, alice, token)).toEqual(emptyNotFound);
      expect(await subscribe(h, "0", token)).toEqual(recordNotFound);
    }
    // The caller's suspension comes first, whatever the id names.
    await suspend(h, alice);
    expect(await subscribe(h, alice, valid)).toEqual(disabled);
    expect(await subscribe(h, "0", valid)).toEqual(disabled);
  });

  // M8: Mastodon reads an expired or revoked token's owner here (Api::BaseController#current_user); Kopje answers
  // such a token as none, and a held token of an earlier epoch as on every route (suspension before the epoch).
  const cases: [string, "available" | "suspended", typeof userRequired, typeof userRequired][] = [
    ["expired", "available", userRequired, emptyNotFound],
    ["expired", "suspended", userRequired, emptyNotFound],
    ["revoked", "available", userRequired, emptyNotFound],
    ["revoked", "suspended", userRequired, emptyNotFound],
    ["held at an earlier epoch", "available", userRequired, emptyNotFound],
    ["held at an earlier epoch", "suspended", disabled, disabled],
  ];

  it.each(cases)(
    "answers an expired or revoked token as no token on the feature-off routes: %s, owner %s",
    async (kind, owner, donationAnswer, subscriptionAnswer) => {
      const h = await apiHarness();
      const alice = await seedAccount(h.store, { username: "alice", email: "alice@example.com" });
      const app = await registerApp(h, { scopes: "read" });
      const { token } = await login(h, { app, scope: "read", email: "alice@example.com" });
      expect(await donation(h, token)).toEqual({ status: 204, body: "" });
      if (kind === "expired") {
        await sql(
          h.store,
          "UPDATE oauth_tokens SET expires_at = ? WHERE account_id = ?",
          "2000-01-01T00:00:00.000Z",
          alice,
        );
        expect(await sql(h.store, "SELECT 1 AS held FROM oauth_tokens WHERE account_id = ?", alice)).not.toEqual([]);
      } else if (kind === "revoked") {
        const revoke = await h.request(
          "/oauth/revoke",
          form({ token, client_id: app.client_id, client_secret: app.client_secret }),
        );
        expect(revoke.status).toBe(200);
        expect(await sql(h.store, "SELECT 1 AS held FROM oauth_tokens WHERE account_id = ?", alice)).toEqual([]);
      } else {
        await sql(
          h.store,
          "UPDATE local_accounts SET credential_epoch = credential_epoch + 1 WHERE account_id = ?",
          alice,
        );
      }
      if (owner === "suspended") {
        await suspend(h, alice);
      }
      expect(await donation(h, token)).toEqual(donationAnswer);
      expect(await subscribe(h, alice, token)).toEqual(subscriptionAnswer);
    },
  );
});
