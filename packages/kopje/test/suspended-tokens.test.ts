import { describe, expect, it } from "vitest";

import { sha256Hex as tokenHash } from "../src/security/tokens";
import { type ApiHarness, bearer, json, login, setSetting, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { BUILD, runStoreJobs } from "./helpers";
import { community } from "./status-helpers";

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

// One route per way a token reaches authorize() (docs: the design's paths of D10), each with a request it answers
// after the token check.
const BY_CALLER: [string, string, string, () => RequestInit][] = [
  ["a user read (userReadOperation)", "GET", "/api/v1/timelines/home", () => ({})],
  ["a user write (userWriteOperation)", "POST", "/api/v1/lists", () => json({ title: "l" })],
  ["optionalUserReadOperation", "GET", "/api/v1/directory", () => ({})],
  ["tokenUserReadOperation", "GET", "/api/v1/announcements", () => ({})],
  ["checkCredential (search)", "GET", "/api/v2/search?q=a&type=none", () => ({})],
  ["checkCredential (placeholders)", "POST", "/api/v1/statuses/1/translate", () => ({})],
  ["checkCredential (accounts)", "POST", "/api/v1/accounts", () => ({})],
  ["checkCredential (tags)", "POST", "/api/v1/featured_tags", () => json({})],
  ["checkCredential (refuseAfterAuth)", "GET", "/api/v1/accounts/search", () => ({})],
  ["checkCredential (checkOptionalToken)", "GET", "/api/v1/admin/ip_blocks", () => ({})],
  ["appOfCredential", "GET", "/api/v1/apps/verify_credentials", () => ({})],
  ["adminGuarded", "GET", "/api/v1/admin/reports", () => ({})],
];

describe("a suspended owner's held token", () => {
  it("answers 403 on every kind of token check, expired or not, where its expiry answered 401", async () => {
    const { h, tokens, suspend } = await world();
    // Before the suspension the expired token reaches each check and is refused as invalid.
    for (const [caller, method, path, init] of BY_CALLER) {
      expect(await answer(h, method, path, tokens.expired, init()), caller).toEqual(INVALID);
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
