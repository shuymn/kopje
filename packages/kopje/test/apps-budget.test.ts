import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import {
  EVICTION_GRACE_MS,
  issueCode,
  MAX_PENDING_APPS,
  registerApp as registerAppOperation,
  sweepOAuth,
  UNUSED_APP_TTL_MS,
} from "../src/domain/oauth";
import { handleScheduled } from "../src/jobs/scheduled";
import type { StoreStub } from "../src/platform/store-client";
import {
  apiHarness,
  type ApiHarness,
  type App,
  authorizationCode,
  bearer,
  exchange,
  form,
  json,
  login,
  registerApp,
  seedAccount,
  sql,
} from "./api-helpers";
import { NOW } from "./app-helpers";
import { plannedRun, scansOf, staleStatistics } from "./read-helpers";
import { csrfOf, postForm, signIn } from "./web-helpers";

// RES-6 for POST /api/v1/apps: a per-IP rate limit (the Rate Limiting binding) and a storage budget of
// never-authorized apps, from which a full registration removes only what it needs, with a visible refusal; the cron
// removes no app, and an authorized app is kept.

const APP = { client_name: "Flood", redirect_uris: "https://flood.example/cb", scopes: "read" };

function limiter(allowed: (key: string) => boolean) {
  return { limit: vi.fn(({ key }: { key: string }) => Promise.resolve({ success: allowed(key) })) };
}

// Fills the budget with apps created at `at`, without the API.
async function fill(store: StoreStub, count: number, at: number, prefix = "filler"): Promise<void> {
  await runInDurableObject(store, (_instance, state) => {
    for (let i = 0; i < count; i++) {
      state.storage.sql.exec(
        "INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes, created_at) VALUES (?, 's', 'f', 'https://f.example/cb', 'read', ?)",
        `${prefix}-${i}`,
        new Date(at + i).toISOString(),
      );
    }
  });
}

async function count(store: StoreStub, where = "1"): Promise<number> {
  const [row] = await sql<{ n: number }>(store, `SELECT COUNT(*) AS n FROM oauth_clients WHERE ${where}`);
  return row?.n ?? 0;
}

function registeredAt(store: StoreStub, app: App, at: number): Promise<unknown> {
  return sql(store, "UPDATE oauth_clients SET created_at = ? WHERE id = ?", new Date(at).toISOString(), app.client_id);
}

// A client_credentials request of `app`.
function appTokenRequest(h: ApiHarness, app: App): Promise<Response> {
  return h.request(
    "/oauth/token",
    json({
      grant_type: "client_credentials",
      client_id: app.client_id,
      client_secret: app.client_secret,
      scope: "read",
    }),
  );
}

async function appToken(h: ApiHarness, app: App): Promise<string> {
  const response = await appTokenRequest(h, app);
  expect(response.status).toBe(200);
  return (await response.json<{ access_token: string }>()).access_token;
}

// One run of the cron (jobs/scheduled.ts) at `now`.
function cron(h: ApiHarness, now = NOW): Promise<unknown> {
  return handleScheduled({ ...env, MAINTENANCE: "off" } as unknown as Env, {
    build: () => env.CF_VERSION_METADATA.id,
    now: () => now,
    store: () => h.store,
  });
}

describe("app registration budget (RES-6)", () => {
  it("limits registrations per client IP before reading the body", async () => {
    const blocked = limiter((key) => key !== "203.0.113.9");
    const h = await apiHarness({ APP_REGISTRATION_LIMIT: blocked });
    const refused = await h.request("/api/v1/apps", json(APP, { headers: { "cf-connecting-ip": "203.0.113.9" } }));
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "Too many requests" });
    expect(blocked.limit).toHaveBeenCalledWith({ key: "203.0.113.9" });
    const other = await h.request("/api/v1/apps", json(APP, { headers: { "cf-connecting-ip": "198.51.100.7" } }));
    expect(other.status).toBe(200);
    expect(await count(h.store)).toBe(1);
  });

  it("refuses a registration when the budget is full of recent never-authorized apps", async () => {
    const h = await apiHarness();
    await fill(h.store, MAX_PENDING_APPS, NOW - EVICTION_GRACE_MS + 1000);
    const response = await h.request("/api/v1/apps", json(APP));
    expect(response.status).toBe(429);
    expect(await count(h.store)).toBe(MAX_PENDING_APPS);
  });

  it("removes the oldest unused app older than a day first, only as many as it needs, then evicts the oldest never-authorized one", async () => {
    const h = await apiHarness();
    await fill(h.store, 10, NOW - UNUSED_APP_TTL_MS - 1000, "old");
    await fill(h.store, MAX_PENDING_APPS - 10, NOW - EVICTION_GRACE_MS + 1000);
    expect((await h.request("/api/v1/apps", json(APP))).status).toBe(200);
    expect(await count(h.store, "id = 'old-0'")).toBe(0);
    expect(await count(h.store, "id LIKE 'old-%'")).toBe(9);
    expect(await count(h.store, "authorized = 0")).toBe(MAX_PENDING_APPS);

    // Now full of recent ones and one older than the grace period: an unused one goes.
    const h2 = await apiHarness();
    await fill(h2.store, 1, NOW - EVICTION_GRACE_MS - 1000, "aged");
    await fill(h2.store, MAX_PENDING_APPS - 1, NOW - EVICTION_GRACE_MS + 1000);
    expect((await h2.request("/api/v1/apps", json(APP))).status).toBe(200);
    expect(await count(h2.store, "id = 'aged-0'")).toBe(0);
    expect(await count(h2.store)).toBe(MAX_PENDING_APPS);
  });

  it("evicts an app whose only token is an app token, which stops working (accepted risk)", async () => {
    const h = await apiHarness();
    const holder = await registerApp(h, { scopes: "read" });
    const access_token = await appToken(h, holder);
    expect((await h.request("/api/v1/apps/verify_credentials", bearer(access_token))).status).toBe(200);
    await sql(
      h.store,
      "UPDATE oauth_clients SET created_at = ?",
      new Date(NOW - EVICTION_GRACE_MS - 1000).toISOString(),
    );
    await fill(h.store, MAX_PENDING_APPS - 1, NOW - EVICTION_GRACE_MS + 1000);
    expect((await h.request("/api/v1/apps", json(APP))).status).toBe(200);
    expect(await count(h.store, `id = '${holder.client_id}'`)).toBe(0);
    expect((await h.request("/api/v1/apps/verify_credentials", bearer(access_token))).status).toBe(401);
  });

  it("keeps an app that holds only a user’s code not yet exchanged, and the code still exchanges", async () => {
    const h = await apiHarness();
    await seedAccount(h.store, { username: "alice", email: "alice@example.com" });
    const app = await registerApp(h);
    const code = await authorizationCode(h, app);
    await sql(h.store, "UPDATE oauth_clients SET created_at = ?", new Date(NOW - 2 * UNUSED_APP_TTL_MS).toISOString());
    await fill(h.store, MAX_PENDING_APPS, NOW - EVICTION_GRACE_MS - 1000);
    expect((await h.request("/api/v1/apps", json(APP))).status).toBe(200);
    expect(await count(h.store, `id = '${app.client_id}'`)).toBe(1);
    expect((await exchange(h, app, code)).status).toBe(200);
  });

  it("cannot be filled for good with app tokens: registration succeeds again once they age", async () => {
    const h = await apiHarness();
    // An attacker fills the budget with apps that each hold an app token.
    await fill(h.store, MAX_PENDING_APPS, NOW - 1000, "flood");
    await sql(
      h.store,
      "INSERT INTO oauth_tokens (token_hash, kind, client_id, scopes) SELECT 'h-' || id, 'access', id, 'read' FROM oauth_clients",
    );
    expect((await h.request("/api/v1/apps", json(APP))).status).toBe(429);
    expect(await count(h.store)).toBe(MAX_PENDING_APPS);
    // An hour later the oldest goes for each new registration; the bound holds.
    h.now.mockReturnValue(NOW + EVICTION_GRACE_MS);
    expect((await h.request("/api/v1/apps", json(APP))).status).toBe(200);
    expect((await h.request("/api/v1/apps", json(APP))).status).toBe(200);
    expect(await count(h.store)).toBe(MAX_PENDING_APPS);
  });

  it("does not count or remove apps a user has authorized, or the web client", async () => {
    const h = await apiHarness();
    await seedAccount(h.store, { username: "alice", email: "alice@example.com" });
    const used = await registerApp(h);
    const { token } = await login(h, { app: used });
    await signIn(h);
    await sql(h.store, "UPDATE oauth_clients SET created_at = ?", new Date(NOW - 2 * UNUSED_APP_TTL_MS).toISOString());
    await fill(h.store, MAX_PENDING_APPS - 1, NOW - EVICTION_GRACE_MS + 1000);
    expect((await h.request("/api/v1/apps", json(APP))).status).toBe(200);
    expect((await h.request("/api/v1/apps", json(APP))).status).toBe(429);
    expect(await count(h.store, `id = '${used.client_id}'`)).toBe(1);
    expect(await count(h.store, "id = (SELECT value FROM instance_settings WHERE name = 'web_client_id')")).toBe(1);
    expect((await h.request("/api/v1/accounts/verify_credentials", bearer(token))).status).toBe(200);
  });

  it("removes no app from the cron, and removes expired codes and sessions", async () => {
    const h = await apiHarness();
    await seedAccount(h.store, { username: "alice", email: "alice@example.com" });
    const used = await registerApp(h);
    await login(h, { app: used });
    const holder = await registerApp(h, { scopes: "read" });
    const held = await appToken(h, holder);
    await registeredAt(h.store, holder, NOW - 2 * UNUSED_APP_TTL_MS);
    await fill(h.store, 3, NOW - UNUSED_APP_TTL_MS - 60 * 60 * 1000, "old");
    await fill(h.store, 2, NOW - 1000, "new");
    await sql(
      h.store,
      `INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes, redirect_uri, expires_at)
			SELECT 'expired', 'code', ?, account_id, 'read', 'https://client.test/callback', ? FROM local_accounts`,
      used.client_id,
      new Date(NOW - 1).toISOString(),
    );
    await sql(
      h.store,
      "INSERT INTO kopje_state (name, value) VALUES ('web_login:expired', ?)",
      JSON.stringify({ expiresAt: NOW - 1 }),
    );
    await cron(h);
    // The run swept: the expired code and sign-in attempt are gone.
    expect(await sql(h.store, "SELECT token_hash FROM oauth_tokens WHERE token_hash = 'expired'")).toEqual([]);
    expect(await sql(h.store, "SELECT name FROM kopje_state WHERE name = 'web_login:expired'")).toEqual([]);
    // Every app stays: the token holder and its token, the unused ones a day old, the recent ones and the authorized.
    expect(await count(h.store, `id = '${holder.client_id}'`)).toBe(1);
    expect((await h.request("/api/v1/apps/verify_credentials", bearer(held))).status).toBe(200);
    expect(await count(h.store, "id LIKE 'old-%'")).toBe(3);
    expect(await count(h.store, "id LIKE 'new-%'")).toBe(2);
    expect(await count(h.store, `id = '${used.client_id}'`)).toBe(1);
    expect(await count(h.store)).toBe(7);
  });

  it("authorizes an app registered two days earlier and never used, after the cron, by the same client_id", async () => {
    const h = await apiHarness();
    await seedAccount(h.store, { username: "alice", email: "alice@example.com" });
    const app = await registerApp(h);
    await registeredAt(h.store, app, NOW - 2 * UNUSED_APP_TTL_MS);
    await cron(h);
    const { token } = await login(h, { app });
    expect((await h.request("/api/v1/accounts/verify_credentials", bearer(token))).status).toBe(200);
    expect(await count(h.store, `id = '${app.client_id}' AND authorized = 1`)).toBe(1);
  });

  // 500 pending apps: A unused and 3 days old, B unused and a minute short of a day at the cron's run, 498 recent. Two
  // minutes later B is past the day, and C's registration needs one slot: A, the oldest, goes and B stays, as when the
  // cron removed A. A second registration then takes B, as today's code does.
  it("keeps an app past the day until a registration needs its slot, removing the oldest unused one first", async () => {
    const scenario = async () => {
      const h = await apiHarness();
      await seedAccount(h.store, { username: "alice", email: "alice@example.com" });
      const a = await registerApp(h);
      const b = await registerApp(h);
      await registeredAt(h.store, a, NOW - 3 * UNUSED_APP_TTL_MS);
      await registeredAt(h.store, b, NOW - UNUSED_APP_TTL_MS + 60 * 1000);
      await fill(h.store, MAX_PENDING_APPS - 2, NOW);
      await cron(h);
      h.now.mockReturnValue(NOW + 2 * 60 * 1000);
      expect((await h.request("/api/v1/apps", json(APP))).status).toBe(200);
      expect(await count(h.store, `id = '${a.client_id}'`)).toBe(0);
      expect(await count(h.store, `id = '${b.client_id}'`)).toBe(1);
      expect(await count(h.store, "authorized = 0")).toBe(MAX_PENDING_APPS);
      return { h, b };
    };

    const { h, b } = await scenario();
    const { token } = await login(h, { app: b });
    expect((await h.request("/api/v1/accounts/verify_credentials", bearer(token))).status).toBe(200);
    expect(await count(h.store, `id = '${b.client_id}' AND authorized = 1`)).toBe(1);

    const second = await scenario();
    expect((await second.h.request("/api/v1/apps", json(APP))).status).toBe(200);
    expect(await count(second.h.store, `id = '${second.b.client_id}'`)).toBe(0);
    expect(await count(second.h.store, "authorized = 0")).toBe(MAX_PENDING_APPS);
  });

  // Accepted risk (docs/threat-model.md, app tokens under registration pressure): an unused app the cron used to remove
  // now keeps its registration and can get an app token, and a full budget's eviction then takes the oldest
  // token-holding app in its place.
  it("lets an aged unused app get an app token, and a full registration then evicts the oldest token holder", async () => {
    const h = await apiHarness();
    const b = await registerApp(h, { scopes: "read" });
    const bToken = await appToken(h, b);
    const a = await registerApp(h, { scopes: "read" });
    await registeredAt(h.store, b, NOW - 4 * UNUSED_APP_TTL_MS);
    await registeredAt(h.store, a, NOW - 3 * UNUSED_APP_TTL_MS);
    await fill(h.store, MAX_PENDING_APPS - 2, NOW);
    await cron(h);
    const aToken = await appToken(h, a);
    expect((await h.request("/api/v1/apps", json(APP))).status).toBe(200);
    expect(await count(h.store, `id = '${a.client_id}'`)).toBe(1);
    expect((await h.request("/api/v1/apps/verify_credentials", bearer(aToken))).status).toBe(200);
    expect(await count(h.store, `id = '${b.client_id}'`)).toBe(0);
    expect((await h.request("/api/v1/apps/verify_credentials", bearer(bToken))).status).toBe(401);
    expect(await count(h.store, "authorized = 0")).toBe(MAX_PENDING_APPS);
  });

  // RES-6: an app a user authorized stays registered after every token is gone, as Mastodon never removes one; a
  // client that kept its client_id signs in with it again, and its statuses keep showing it.
  it("keeps an app whose authorization was revoked past the sweep, and authorizes it again by the same client_id", async () => {
    const h = await apiHarness();
    await seedAccount(h.store, { username: "alice", email: "alice@example.com" });
    const app = await registerApp(h);
    const { token } = await login(h, { app, scope: "read write" });
    const posted = await h.request("/api/v1/statuses", bearer(token, json({ status: "hello" })));
    const { id } = await posted.json<{ id: string }>();
    const browser = await signIn(h);
    const revoked = await postForm(h, browser, "/settings/authorizations/revoke", {
      client_id: app.client_id,
      csrf: await csrfOf(h, browser),
    });
    expect(revoked.status).toBe(303);
    expect(await count(h.store, `id = '${app.client_id}'`)).toBe(1);
    expect(await sql(h.store, "SELECT token_hash FROM oauth_tokens WHERE client_id = ?", app.client_id)).toEqual([]);
    await sql(h.store, "UPDATE oauth_clients SET created_at = ?", new Date(NOW - 2 * UNUSED_APP_TTL_MS).toISOString());
    // A never-authorized app of the same age, which the sweep keeps too.
    await fill(h.store, 1, NOW - 2 * UNUSED_APP_TTL_MS, "old");
    const swept = await runInDurableObject(h.store, (_instance, state) =>
      sweepOAuth.run(state.storage.sql, { now: NOW }),
    );
    expect(swept).toEqual({ tokens: 0, webState: 0 });
    expect(await count(h.store, "id LIKE 'old-%'")).toBe(1);
    expect(await count(h.store, `id = '${app.client_id}'`)).toBe(1);
    const again = await login(h, { app });
    expect((await h.request("/api/v1/accounts/verify_credentials", bearer(again.token))).status).toBe(200);
    const shown = await (await h.request(`/api/v1/statuses/${id}`)).json<{ application: unknown }>();
    expect(shown.application).toEqual({ name: "Test Client", website: "https://client.test" });
  });

  it("never evicts an app authorized and then revoked, and still evicts a never-authorized one", async () => {
    const h = await apiHarness();
    await seedAccount(h.store, { username: "alice", email: "alice@example.com" });
    const app = await registerApp(h);
    const { token } = await login(h, { app });
    const revoked = await h.request(
      "/oauth/revoke",
      form({ token, client_id: app.client_id, client_secret: app.client_secret }),
    );
    expect(revoked.status).toBe(200);
    expect(await sql(h.store, "SELECT token_hash FROM oauth_tokens WHERE client_id = ?", app.client_id)).toEqual([]);
    // The revoked app is the oldest of all, past the day and the grace, and every pending slot is taken.
    await sql(h.store, "UPDATE oauth_clients SET created_at = ?", new Date(NOW - 2 * UNUSED_APP_TTL_MS).toISOString());
    await fill(h.store, MAX_PENDING_APPS, NOW - EVICTION_GRACE_MS - 1000);
    expect((await h.request("/api/v1/apps", json(APP))).status).toBe(200);
    expect(await count(h.store, `id = '${app.client_id}'`)).toBe(1);
    // The oldest never-authorized app went in its place.
    expect(await count(h.store, "id = 'filler-0'")).toBe(0);
    expect(await count(h.store, "id LIKE 'filler-%'")).toBe(MAX_PENDING_APPS - 1);
  });
});

// RES-7 for the budget's statements: authorized apps, each with a user's token, grown after ANALYZE, are never read.
// Every input at its worst: MAX_PENDING_APPS pending apps (the budget full), each older than the day and holding an app
// token, so the unused pass reads every one and removes none and eviction runs; the web client not yet authorized, so
// it is a pending candidate too. The cron's sweep reads no app.
describe("app budget reads with stale statistics (RES-6, RES-7)", () => {
  const AUTHORIZED = 3 * MAX_PENDING_APPS;
  const UNUSED_PASS_WALK = "SEARCH c USING COVERING INDEX oauth_clients_pending (created_at<?)";
  const UNUSED_PASS_TOKENS = "SEARCH u USING COVERING INDEX oauth_tokens_client (client_id=?)";

  it("walks the pending apps by their partial index and marks an app by its key", { timeout: 60_000 }, async () => {
    const h = await apiHarness();
    const alice = await seedAccount(h.store, { username: "alice", email: "alice@example.com" });
    await fill(h.store, 2, NOW - 2 * UNUSED_APP_TTL_MS, "small");
    await sql(h.store, "INSERT INTO instance_settings (name, value) VALUES ('web_client_id', 'small-0')");
    const pattern = /oauth_clients/;
    const { after } = await staleStatistics(h, {
      capture: async (phase) => ({
        registered: await plannedRun(
          h,
          pattern,
          registerAppOperation,
          {
            clientId: `new-${phase}`,
            secret: "s",
            name: "n",
            redirectUris: ["https://n.example/cb"],
            website: null,
            scopes: ["read"],
            now: NOW,
            credential: null,
          },
          true,
        ),
        swept: await plannedRun(h, pattern, sweepOAuth, { now: NOW }, true),
        marked: await plannedRun(
          h,
          pattern,
          issueCode,
          {
            clientId: `new-${phase}`,
            redirectUri: "https://n.example/cb",
            scopes: ["read"],
            codeChallenge: null,
            email: "alice@example.com",
            codeHash: `code-${phase}`,
            now: NOW,
          },
          true,
        ),
      }),
      grow: async () => {
        await sql(h.store, "DELETE FROM oauth_clients WHERE id LIKE 'new-%' OR id = 'small-1'");
        await sql(
          h.store,
          `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
					INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes, created_at, authorized)
					SELECT 'authorized-' || i, 's', 'a', 'https://a.example/cb', 'read', ?2, 1 FROM n`,
          AUTHORIZED,
          new Date(NOW - 3 * UNUSED_APP_TTL_MS).toISOString(),
        );
        await sql(
          h.store,
          `INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes)
					SELECT 'u-' || id, 'access', id, ?, 'read' FROM oauth_clients WHERE authorized = 1`,
          alice,
        );
        // MAX_PENDING_APPS beside the web client (small-0), which the budget does not count: it is full.
        await fill(h.store, MAX_PENDING_APPS, NOW - 2 * UNUSED_APP_TTL_MS, "pending");
        await sql(
          h.store,
          `INSERT INTO oauth_tokens (token_hash, kind, client_id, scopes)
					SELECT 'a-' || id, 'access', id, 'read' FROM oauth_clients WHERE authorized = 0`,
        );
      },
    });
    expect(after.registered.result).toMatchObject({ status: "ok" });
    // The budget was full: the unused pass removed none (each holds an app token), and eviction took the oldest.
    expect(await count(h.store, "id = 'pending-0'")).toBe(0);
    expect(await count(h.store, "id LIKE 'authorized-%'")).toBe(AUTHORIZED);
    expect(after.swept.result).toEqual({ tokens: 0, webState: 0 });
    expect(after.marked.result).toEqual({ status: "ok" });
    expect(await count(h.store, "id = 'new-after' AND authorized = 1")).toBe(1);

    // The budget's walks of the pending set, and the reads and writes of one app by its key. The sweep names no app.
    const walks = (query: string) => query.includes("oauth_clients_pending");
    const statements = [...after.registered.plans, ...after.marked.plans];
    expect(after.registered.plans.some((p) => walks(p.query))).toBe(true);
    expect(after.swept.plans).toEqual([]);
    expect(after.marked.plans.some((p) => p.query.startsWith("UPDATE"))).toBe(true);
    // The unused pass walks the index in its order, oldest first, and stops at what the insert needs: no sort.
    const unusedPass = after.registered.plans.filter(
      (p) => p.query.startsWith("DELETE") && p.query.includes("oauth_tokens u"),
    );
    expect(unusedPass).toHaveLength(1);
    expect(unusedPass[0]!.plan).toEqual(expect.arrayContaining([UNUSED_PASS_WALK, UNUSED_PASS_TOKENS]));
    expect(unusedPass[0]!.plan.join(" | ")).not.toMatch(/SCAN|TEMP B-TREE/);
    for (const statement of statements) {
      if (walks(statement.query)) {
        expect(statement.plan.join(" | "), statement.query).toMatch(/USING (?:COVERING )?INDEX oauth_clients_pending/);
        expect(scansOf(statement.plan, ["oauth_clients", "oauth_tokens", "u"]), statement.query).toEqual([]);
        // Per pending candidate (MAX_PENDING_APPS and the web client): its index entry and, in the unused pass, one
        // seek of its tokens (the first hit ends it); a removed one at most four more (its row by key, its index
        // entries and the foreign-key check of its tokens); the web client's setting is one seek. Measured 502 and
        // 1,004, the same with ten times as many authorized apps: none is read.
        expect(statement.rows, statement.query).toBeLessThanOrEqual(6 * (MAX_PENDING_APPS + 1) + 2);
      } else {
        expect(statement.plan, statement.query).toEqual(
          statement.query.startsWith("INSERT")
            ? []
            : ["SEARCH oauth_clients USING INDEX sqlite_autoindex_oauth_clients_1 (id=?)"],
        );
        expect(statement.rows, statement.query).toBeLessThanOrEqual(1);
      }
    }
  });
});
