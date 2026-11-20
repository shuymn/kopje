import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { oauthAdmin } from "../src/domain/admin-authority";
import {
  ADMIN_PERMISSION,
  ADMIN_PERMISSIONS,
  adminGuarded,
  adminReadOperation,
  adminWriteOperation,
  type UserCredential,
} from "../src/domain/auth";
import { readOperation, writeOperation } from "../src/domain/operation";
import { ROUTES } from "../src/mastodon/routes";
import type { StoreStub } from "../src/platform/store-client";
import { sha256Hex } from "../src/security/tokens";
import { adminHarness, adminTeam, serviceClaims, setTeamAccess, type AccessTeam } from "./access-helpers";
import {
  type ApiHarness,
  apiHarness,
  bearer,
  form,
  json,
  login,
  registerApp,
  seedAccount,
  setSetting,
  sql,
} from "./api-helpers";
import { countingStore, NOW } from "./app-helpers";
import { BUILD, migratedStore } from "./helpers";
import { ADMIN_EMAIL } from "./ops-helpers";

// The Mastodon admin API's authority (R37, VIS-29, AUTH-2): one OAuth admin, the local account whose email matches
// admin_email, failing closed; admin operations check it in their transaction; and every admin route answers as
// Mastodon answers a role without the route's permission until Kopje serves it.

const OWNER = "owner@example.com";
const ADMIN_SCOPES = "read admin:read admin:write";

async function userToken(h: ApiHarness, email: string, scope = ADMIN_SCOPES): Promise<string> {
  const app = await registerApp(h, { scopes: scope });
  return (await login(h, { app, scope, email })).token;
}

async function appToken(h: ApiHarness, scope = "admin:read admin:write"): Promise<string> {
  const app = await registerApp(h, { scopes: scope });
  const response = await h.request(
    "/oauth/token",
    form({ grant_type: "client_credentials", client_id: app.client_id, client_secret: app.client_secret, scope }),
  );
  return (await response.json<{ access_token: string }>()).access_token;
}

const expire = async (h: ApiHarness, token: string) =>
  sql(
    h.store,
    "UPDATE oauth_tokens SET expires_at = ? WHERE token_hash = ?",
    new Date(NOW - 1000).toISOString(),
    await sha256Hex(token),
  );

const matchOf = (store: StoreStub) =>
  runInDurableObject(store, (_instance, state) => oauthAdmin(new Db(state.storage.sql)));

// Admin operations as a route with manage_reports would declare them, with that bit granted (as a role grants it)
// or not.
const granted = adminGuarded(readOperation, ADMIN_PERMISSION.manageReports);
const reportsRead = granted(ADMIN_PERMISSION.manageReports, (_db, _input: object, admin) => admin);
const usersRead = granted(ADMIN_PERMISSION.manageUsers, (_db, _input: object, admin) => admin.accountId);
const writes = adminGuarded(writeOperation, ADMIN_PERMISSION.manageReports)(
  ADMIN_PERMISSION.manageReports,
  (db, _input: object, admin) => {
    db.run("INSERT INTO kopje_state (name, value) VALUES ('admin-probe', ?)", admin.accountId);
    return admin.accountId;
  },
);

type Operation = typeof reportsRead | typeof writes;

async function run(
  store: StoreStub,
  operation: Operation,
  token: string | null,
  scope: UserCredential["scope"] = "admin:read:reports",
) {
  const credential = token === null ? null : { tokenHash: await sha256Hex(token), scope, now: NOW };
  return runInDurableObject(store, (_instance, state) =>
    (operation.run as (sql: SqlStorage, input: { credential: UserCredential | null }) => unknown)(state.storage.sql, {
      credential,
    }),
  );
}

describe("the OAuth admin (adminAccountId)", () => {
  it("is the one local account whose email matches admin_email in ASCII case", async () => {
    const h = await apiHarness();
    const owner = await seedAccount(h.store, { username: "owner", email: OWNER });
    await seedAccount(h.store, { username: "alice", email: "alice@example.com" });
    await setSetting(h.store, "admin_email", OWNER.toUpperCase());
    expect(await matchOf(h.store)).toEqual({ status: "ok", username: "owner", accountId: owner });
    const token = await userToken(h, OWNER);
    expect(await run(h.store, reportsRead, token)).toEqual({
      status: "ok",
      value: {
        accountId: owner,
        clientId: expect.any(String),
        now: NOW,
        context: { accountId: owner, now: new Date(NOW).toISOString() },
      },
    });
  });

  it("is nobody while admin_email is unset or empty", async () => {
    const h = await apiHarness();
    await seedAccount(h.store, { username: "owner", email: OWNER });
    const token = await userToken(h, OWNER);
    expect(await matchOf(h.store)).toEqual({ status: "unset", username: null, accountId: null });
    expect(await run(h.store, reportsRead, token)).toEqual({ status: "admin_forbidden" });
    await setSetting(h.store, "admin_email", "   ");
    expect(await matchOf(h.store)).toEqual({ status: "unset", username: null, accountId: null });
    expect(await run(h.store, reportsRead, token)).toEqual({ status: "admin_forbidden" });
  });

  it("is nobody when no local account has the email", async () => {
    const h = await apiHarness();
    await seedAccount(h.store, { username: "owner", email: OWNER });
    // A remote account has no email to match.
    await seedAccount(h.store, { username: "owner", domain: "remote.example" });
    await setSetting(h.store, "admin_email", "nobody@example.com");
    const token = await userToken(h, OWNER);
    expect(await matchOf(h.store)).toEqual({ status: "none", username: null, accountId: null });
    expect(await run(h.store, reportsRead, token)).toEqual({ status: "admin_forbidden" });
  });

  it("is nobody when the match is suspended", async () => {
    const h = await apiHarness();
    await seedAccount(h.store, { username: "owner", email: OWNER });
    await setSetting(h.store, "admin_email", OWNER);
    const token = await userToken(h, OWNER);
    await sql(h.store, "UPDATE local_accounts SET suspended_at = ?", new Date(NOW).toISOString());
    expect(await matchOf(h.store)).toEqual({ status: "suspended", username: "owner", accountId: null });
    expect(await run(h.store, reportsRead, token)).toEqual({ status: "suspended" });
  });

  it("is nobody when two accounts match after lowercasing; nothing is picked", async () => {
    const h = await apiHarness();
    await seedAccount(h.store, { username: "owner", email: OWNER });
    await setSetting(h.store, "admin_email", OWNER);
    const token = await userToken(h, OWNER);
    expect(await run(h.store, reportsRead, token)).toMatchObject({ status: "ok" });
    await seedAccount(h.store, { username: "twin", email: "Owner@Example.com" });
    expect(await matchOf(h.store)).toEqual({ status: "ambiguous", username: null, accountId: null });
    expect(await run(h.store, reportsRead, token)).toEqual({ status: "admin_forbidden" });
  });

  // AUTH-9's rule (login-email.ts loginEmailMatchSql): each Unicode variant below equals a stored email after JavaScript's
  // trim() and toLowerCase(), and the sign-in reads it as another email.
  it("names local accounts by the sign-in’s rule: ASCII case only, with no trim", async () => {
    const store = await migratedStore();
    await seedAccount(store, { username: "kim", email: "kim@example.com" });
    await seedAccount(store, { username: "strasse", email: "straße@example.com" });
    await seedAccount(store, { username: "iris", email: "i\u0307ris@example.com" });
    const match = async (email: string) => {
      await setSetting(store, "admin_email", email);
      const { status, username } = await matchOf(store);
      return { status, username };
    };
    // An ASCII case variant is the same email.
    expect(await match("KIM@Example.com")).toEqual({ status: "ok", username: "kim" });
    // The Kelvin sign U+212A, the capital sharp s U+1E9E, the dotted capital I U+0130 and surrounding whitespace.
    for (const email of [
      "\u212Aim@example.com",
      "STRA\u1E9EE@example.com",
      "\u0130RIS@example.com",
      " kim@example.com ",
    ]) {
      expect(await match(email), email).toEqual({ status: "none", username: null });
    }
    // A Unicode case variant stored beside it is another account, so neither match is ambiguous.
    await seedAccount(store, { username: "kelvin", email: "\u212Aim@example.com" });
    expect(await match("kim@example.com")).toEqual({ status: "ok", username: "kim" });
    expect(await match("\u212Aim@example.com")).toEqual({ status: "ok", username: "kelvin" });
  });

  it("follows admin_email when it changes: existing tokens lose or gain admin authority at once", async () => {
    const h = await apiHarness();
    const owner = await seedAccount(h.store, { username: "owner", email: OWNER });
    const alice = await seedAccount(h.store, { username: "alice", email: "alice@example.com" });
    await setSetting(h.store, "admin_email", OWNER);
    const ownerToken = await userToken(h, OWNER);
    const aliceToken = await userToken(h, "alice@example.com");
    expect(await run(h.store, reportsRead, ownerToken)).toMatchObject({ status: "ok", value: { accountId: owner } });
    expect(await run(h.store, reportsRead, aliceToken)).toEqual({ status: "admin_forbidden" });

    await setSetting(h.store, "admin_email", "alice@example.com");
    expect(await run(h.store, reportsRead, ownerToken)).toEqual({ status: "admin_forbidden" });
    expect(await run(h.store, reportsRead, aliceToken)).toMatchObject({ status: "ok", value: { accountId: alice } });
    expect(await run(h.store, writes, ownerToken, "admin:write:reports")).toEqual({ status: "admin_forbidden" });
    expect(await run(h.store, writes, aliceToken, "admin:write:reports")).toEqual({ status: "ok", value: alice });
    expect(await sql(h.store, "SELECT value FROM kopje_state WHERE name = 'admin-probe'")).toEqual([{ value: alice }]);
  });
});

describe("admin operations", () => {
  async function withAdmin() {
    const h = await apiHarness();
    const owner = await seedAccount(h.store, { username: "owner", email: OWNER });
    await seedAccount(h.store, { username: "alice", email: "alice@example.com" });
    await setSetting(h.store, "admin_email", OWNER);
    return { h, owner };
  }

  it("refuse anonymous callers, unknown tokens, app tokens and other users, even with admin scopes", async () => {
    const { h } = await withAdmin();
    expect(await run(h.store, reportsRead, null)).toEqual({ status: "admin_forbidden" });
    expect(await run(h.store, reportsRead, "not-a-token")).toEqual({ status: "admin_forbidden" });
    expect(await run(h.store, reportsRead, await appToken(h))).toEqual({ status: "admin_forbidden" });
    expect(await run(h.store, reportsRead, await userToken(h, "alice@example.com"))).toEqual({
      status: "admin_forbidden",
    });
    expect(await run(h.store, writes, await userToken(h, "alice@example.com"), "admin:write:reports")).toEqual({
      status: "admin_forbidden",
    });
    expect(await sql(h.store, "SELECT value FROM kopje_state WHERE name = 'admin-probe'")).toEqual([]);
  });

  it("refuse the admin's token without the route's scope, and an expired one", async () => {
    const { h } = await withAdmin();
    expect(await run(h.store, reportsRead, await userToken(h, OWNER, "read write"))).toEqual({
      status: "insufficient_scope",
    });
    expect(await run(h.store, reportsRead, await userToken(h, OWNER, "admin:read:accounts"))).toEqual({
      status: "insufficient_scope",
    });
    const expired = await userToken(h, OWNER, "admin:read:reports");
    expect(await run(h.store, reportsRead, expired)).toMatchObject({ status: "ok" });
    await expire(h, expired);
    expect(await run(h.store, reportsRead, expired)).toEqual({ status: "unauthenticated" });
  });

  it("refuse the admin a permission Kopje does not grant", async () => {
    const { h } = await withAdmin();
    const token = await userToken(h, OWNER);
    expect(await run(h.store, usersRead, token, "admin:read:accounts")).toEqual({ status: "forbidden" });
  });

  it("grant manage_reports, manage_users, manage_federation and view_dashboard (ADMIN_PERMISSIONS = 1080), so every other admin operation refuses the admin", async () => {
    const { h, owner } = await withAdmin();
    expect(ADMIN_PERMISSIONS).toBe(1080);
    const served: number[] = [
      ADMIN_PERMISSION.manageReports,
      ADMIN_PERMISSION.manageUsers,
      ADMIN_PERMISSION.manageFederation,
      ADMIN_PERMISSION.viewDashboard,
    ];
    const token = await userToken(h, OWNER);
    for (const permission of Object.values(ADMIN_PERMISSION)) {
      const read = adminReadOperation(permission, (_db, _input, admin) => admin.accountId);
      const write = adminWriteOperation(permission, (_db, _input, admin) => admin.accountId);
      const want = served.includes(permission) ? { status: "ok", value: owner } : { status: "forbidden" };
      expect(await run(h.store, read as Operation, token, "admin:read")).toEqual(want);
      expect(await run(h.store, write as Operation, token, "admin:write")).toEqual(want);
    }
  });

  it("present the OAuth admin's role as Owner with the permissions served, and everyone else's as the default", async () => {
    const { h } = await withAdmin();
    const role = async (email: string) =>
      (
        await (
          await h.request("/api/v1/accounts/verify_credentials", bearer(await userToken(h, email)))
        ).json<{
          role: unknown;
        }>()
      ).role;
    expect(await role(OWNER)).toEqual({
      id: "3",
      name: "Owner",
      permissions: "1080",
      color: "",
      highlighted: true,
      collection_limit: 10,
    });
    expect(await role("alice@example.com")).toEqual({
      id: "-99",
      name: "",
      permissions: "0",
      color: "",
      highlighted: false,
      collection_limit: 10,
    });
    // The role follows the match: once admin_email names alice, she is the Owner and the owner is not.
    await setSetting(h.store, "admin_email", "alice@example.com");
    expect(await role("alice@example.com")).toMatchObject({ id: "3", name: "Owner" });
    expect(await role(OWNER)).toMatchObject({ id: "-99" });
  });
});

describe("admin routes (AUTH-2, VIS-29)", () => {
  const adminRoutes = ROUTES.filter((route) => /^\/api\/v[12]\/admin\//.test(route.path));
  const gatedRoutes = adminRoutes.filter((route) => typeof route.access === "object" && route.access.admin === true);
  const UNKNOWN = "999999999999999999";
  const FORBIDDEN = { status: 403, body: { error: "Forbidden" } };
  const DISABLED = { status: 403, body: { error: "Your login is currently disabled" } };
  const INVALID = { status: 401, body: { error: "The access token is invalid" } };
  const OUTSIDE = { status: 403, body: { error: "This action is outside the authorized scopes" } };
  // Kinds Kopje stores none of, found by id before Mastodon's policy runs.
  const UNSTORED = /\/admin\/(domain_allows|ip_blocks|email_domain_blocks|canonical_email_blocks)\/:id$/;
  const TRENDS = /^\/api\/v1\/admin\/trends\/(tags|links|statuses)$/;

  // Reports (manage_reports), accounts (manage_users), domain blocks and allows (manage_federation) and the metrics
  // (view_dashboard) are served: to the admin, with an id that is no record's and no body, the lists (the world's
  // report, block and local accounts; no allow or dimension), a create without fields (422), measures and retention
  // without their required parameters (400, params.require) and 404; deleting an account's data (delete_user_data) and
  // creating a domain allow are not served: 403, as to a role without the permission.
  const SERVED = /^\/api\/v1\/admin\/(reports|domain_blocks)(\/|$)|^\/api\/v[12]\/admin\/accounts(\/|$)/;
  const LISTS = new Map<string, unknown>([
    ["/api/v1/admin/accounts", expect.arrayContaining([expect.objectContaining({ username: "owner" })])],
    ["/api/v2/admin/accounts", expect.arrayContaining([expect.objectContaining({ username: "owner" })])],
    [
      "/api/v1/admin/reports",
      [expect.objectContaining({ target_account: expect.objectContaining({ username: "bob" }) })],
    ],
    ["/api/v1/admin/domain_blocks", [expect.objectContaining({ domain: "blocked.example" })]],
  ]);
  const EMPTY = new Set(["GET /api/v1/admin/domain_allows", "POST /api/v1/admin/dimensions"]);
  const REQUIRED = new Map([
    ["/api/v1/admin/measures", "keys"],
    ["/api/v1/admin/retention", "start_at"],
  ]);
  const adminAnswer = (path: string, method: string): { status: number; body: unknown } =>
    TRENDS.test(path) || EMPTY.has(`${method} ${path}`)
      ? { status: 200, body: [] }
      : method === "GET" && LISTS.has(path)
        ? { status: 200, body: LISTS.get(path) }
        : method === "POST" && REQUIRED.has(path)
          ? {
              status: 400,
              body: { error: `param is missing or the value is empty or invalid: ${REQUIRED.get(path)!}` },
            }
          : method === "POST" && path === "/api/v1/admin/domain_blocks"
            ? {
                status: 422,
                body: { error: "Validation failed: Severity is not included in the list, Domain can't be blank" },
              }
            : UNSTORED.test(path) || (SERVED.test(path) && (method !== "DELETE" || path.includes("domain_blocks")))
              ? { status: 404, body: { error: "Record not found" } }
              : { status: 403, body: { error: "This action is not allowed" } };

  // The handlers that read a body (withParams), each answering the admin 400 for a malformed one.
  const BODIES = new Set([
    "PUT /api/v1/admin/reports/:id",
    "PATCH /api/v1/admin/reports/:id",
    "POST /api/v1/admin/accounts/:account_id/action",
    "POST /api/v1/admin/domain_blocks",
    "PUT /api/v1/admin/domain_blocks/:id",
    "PATCH /api/v1/admin/domain_blocks/:id",
    "POST /api/v1/admin/measures",
    "POST /api/v1/admin/retention",
  ]);

  // A request the OAuth admin would have answered as the route's own: a record's id, and the fields of a valid body.
  const VALID_BODIES: Record<string, Record<string, unknown>> = {
    "POST /api/v1/admin/accounts/:account_id/action": { type: "none", text: "a warning" },
    "PUT /api/v1/admin/reports/:id": { category: "other" },
    "PATCH /api/v1/admin/reports/:id": { category: "other" },
    "POST /api/v1/admin/domain_blocks": { domain: "new.example", severity: "suspend" },
    "PUT /api/v1/admin/domain_blocks/:id": { severity: "noop" },
    "PATCH /api/v1/admin/domain_blocks/:id": { severity: "noop" },
    "POST /api/v1/admin/measures": { keys: ["new_users"], start_at: "2026-11-01", end_at: "2026-11-02" },
    "POST /api/v1/admin/retention": { start_at: "2026-11-01", end_at: "2026-11-02", frequency: "day" },
    "POST /api/v1/admin/dimensions": { keys: ["languages"] },
  };

  type Request = { label: string; path: string; init: RequestInit };
  type Ids = { account: string; report: string; block: string };
  const route = (r: (typeof adminRoutes)[number]) => `${r.method} ${r.path}`;
  const idOf = (path: string, ids: Ids) =>
    /\/admin\/accounts\//.test(path)
      ? ids.account
      : /\/admin\/reports\//.test(path)
        ? ids.report
        : /\/admin\/domain_blocks\//.test(path)
          ? ids.block
          : "1";

  // Each route's requests: a valid one, one naming an unknown id (routes with an id), malformed parameters (a
  // malformed body, or the accounts filter's unknown origin and status on a GET), and measures and retention without
  // their required fields.
  function requests(r: (typeof adminRoutes)[number], ids: Ids): Request[] {
    const at = (id: string) => r.path.replace(/:\w+/g, id);
    const body = VALID_BODIES[route(r)];
    const list: Request[] = [
      {
        label: "valid",
        path: at(idOf(r.path, ids)),
        init: body === undefined ? { method: r.method } : json(body, { method: r.method }),
      },
    ];
    if (r.path.includes(":")) {
      list.push({ label: "unknown id", path: at(UNKNOWN), init: { method: r.method } });
    }
    list.push(
      r.method === "GET"
        ? { label: "malformed", path: `${at(idOf(r.path, ids))}?origin=bogus&status=bogus`, init: { method: "GET" } }
        : {
            label: "malformed",
            path: at(idOf(r.path, ids)),
            init: { method: r.method, headers: { "content-type": "application/json" }, body: "{" },
          },
    );
    if (REQUIRED.has(r.path)) {
      list.push({ label: "without its required fields", path: r.path, init: json({}) });
    }
    return list;
  }

  // The owner is the OAuth admin; alice is a local account whose tokens hold admin scopes, one of them expired; a
  // report and a domain block exist. The Store as the app calls it, counted.
  async function world() {
    let counting: ReturnType<typeof countingStore> | undefined;
    const h = await apiHarness({}, { wrapStore: (store) => (counting ??= countingStore(store)).stub });
    await seedAccount(h.store, { username: "owner", email: OWNER });
    const alice = await seedAccount(h.store, { username: "alice", email: "alice@example.com" });
    const bob = await seedAccount(h.store, { username: "bob", email: "bob@example.com" });
    await setSetting(h.store, "admin_email", OWNER);
    const tokens = {
      admin: await userToken(h, OWNER),
      alice: await userToken(h, "alice@example.com"),
      aliceExpired: await userToken(h, "alice@example.com"),
      app: await appToken(h),
    };
    await expire(h, tokens.aliceExpired);
    await sql(
      h.store,
      "INSERT INTO reports (account_id, target_account_id, status_ids, uri, created_at) VALUES (?, ?, '[]', ?, ?)",
      alice,
      bob,
      "https://kopje.test/actor#reports/1",
      new Date(NOW).toISOString(),
    );
    const [report] = await sql<{ id: string }>(h.store, "SELECT CAST(id AS TEXT) AS id FROM reports");
    const block = await h.request(
      "/api/v1/admin/domain_blocks",
      bearer(tokens.admin, json({ domain: "blocked.example", severity: "suspend" })),
    );
    expect(block.status).toBe(200);
    const ids: Ids = { account: bob, report: report!.id, block: (await block.json<{ id: string }>()).id };
    const send = async (request: Request, token: string | null) => {
      const response = await h.request(request.path, token === null ? request.init : bearer(token, request.init));
      const text = await response.text();
      return { status: response.status, body: text === "" ? "" : (JSON.parse(text) as unknown) };
    };
    // The Store calls `run` makes, but the host check's (app.ts, WEB-6).
    const callsOf = async <T>(run: () => Promise<T>) => {
      const before = counting?.calls.length ?? 0;
      const result = await run();
      return { result, calls: (counting?.calls ?? []).slice(before).filter((name) => name !== "instanceDomain") };
    };
    return { h, alice, tokens, ids, send, callsOf };
  }

  it("are all 63 routed, each behind the admin gate", () => {
    expect(adminRoutes).toHaveLength(63);
    expect(gatedRoutes.map(route)).toEqual(adminRoutes.map(route));
    const answers = adminRoutes.map((r) => adminAnswer(r.path, r.method).status);
    expect(answers.filter((status) => status === 200)).toHaveLength(9);
    expect(answers.filter((status) => status === 400)).toHaveLength(2);
    expect(answers.filter((status) => status === 422)).toHaveLength(1);
    expect(answers.filter((status) => status === 404)).toHaveLength(29);
    expect(answers.filter((status) => status === 403)).toHaveLength(22);
  });

  // T9.1, T9.4: no token, an unknown token, an app token and another account's token (valid or expired), each with
  // admin scopes, get 403 Forbidden on every request, before the token, a lookup or a parameter is judged; no token
  // makes no Store call. The OAuth admin's same request is answered otherwise, so each reached the gate.
  it("refuse anyone but the OAuth admin with Forbidden first, without a token with no Store call", async () => {
    const { tokens, ids, send, callsOf } = await world();
    const callers: [string, string | null][] = [
      ["no token", null],
      ["an unknown token", "not-a-token"],
      ["an app token", tokens.app],
      ["another account's token", tokens.alice],
      ["another account's expired token", tokens.aliceExpired],
    ];
    for (const r of gatedRoutes) {
      for (const request of requests(r, ids)) {
        for (const [who, token] of callers) {
          const { result, calls } = await callsOf(() => send(request, token));
          expect(result, `${route(r)}, ${request.label}, ${who}`).toEqual(FORBIDDEN);
          if (token === null) {
            expect(calls, `${route(r)}, ${request.label}`).toEqual([]);
          }
        }
        const answer = await send(request, tokens.admin);
        expect(answer, `${route(r)}, ${request.label}, the OAuth admin`).not.toEqual(FORBIDDEN);
        expect(answer.status, `${route(r)}, ${request.label}, the OAuth admin`).toBeLessThan(500);
      }
    }
  }, 300_000);

  // T9.2: the suspension's 403 comes before the gate, for an unexpired and an expired token alike.
  it("refuse a suspended owner's held token as disabled before the gate", async () => {
    const { h, alice, tokens, ids, send } = await world();
    expect(await h.store.suspendAccount(BUILD, { accountId: alice, now: NOW })).toEqual({ suspended: true });
    for (const r of gatedRoutes) {
      const [valid] = requests(r, ids);
      expect(await send(valid!, tokens.alice), route(r)).toEqual(DISABLED);
      expect(await send(valid!, tokens.aliceExpired), `${route(r)}, expired`).toEqual(DISABLED);
    }
  }, 120_000);

  // T9.3: past the gate, the OAuth admin's token is judged (401, the route's scope), then the route's lookups,
  // parameters and permission, as before the gate.
  it("answer the OAuth admin's token as the route does: validity, scope, lookups, parameters, permission", async () => {
    const { h, tokens, ids, send } = await world();
    const plain = await userToken(h, OWNER, "read write");
    const expired = await userToken(h, OWNER);
    await expire(h, expired);
    for (const r of gatedRoutes) {
      const [valid] = requests(r, ids);
      const bare = { label: "", path: r.path.replace(/:\w+/g, UNKNOWN), init: { method: r.method } };
      expect(await send(bare, tokens.admin), route(r)).toEqual(adminAnswer(r.path, r.method));
      expect(await send(valid!, plain), `${route(r)}, without the scope`).toEqual(OUTSIDE);
      expect(await send(valid!, expired), `${route(r)}, expired`).toEqual(INVALID);
      if (BODIES.has(route(r))) {
        const malformed = requests(r, ids).find((request) => request.label === "malformed")!;
        expect(await send(malformed, tokens.admin), `${route(r)}, malformed`).toEqual({
          status: 400,
          body: { error: "Malformed request body" },
        });
      }
    }
    // The accounts filter's 400 (v2 reads origin and status; v1 has none to refuse).
    for (const [query, error] of [
      ["origin=bogus", "Unknown origin: bogus"],
      ["status=bogus", "Unknown status: bogus"],
    ]) {
      expect(await send({ label: "", path: `/api/v2/admin/accounts?${query}`, init: {} }, tokens.admin)).toEqual({
        status: 400,
        body: { error },
      });
    }
    // admin:read does not cover admin:write.
    const reader = await userToken(h, OWNER, "admin:read");
    const resolve = { label: "", path: `/api/v1/admin/reports/${ids.report}/resolve`, init: { method: "POST" } };
    expect(await send(resolve, reader)).toEqual(OUTSIDE);
    // A revoked token of the OAuth admin is deleted, so it is nobody's: Forbidden, where Mastodon, which still finds
    // its owner, answers 401 (MD-2).
    const app = await registerApp(h, { scopes: ADMIN_SCOPES });
    const revoked = (await login(h, { app, scope: ADMIN_SCOPES, email: OWNER })).token;
    const list = { label: "", path: "/api/v1/admin/reports", init: {} };
    expect((await send(list, revoked)).status).toBe(200);
    const revoke = form({ token: revoked, client_id: app.client_id, client_secret: app.client_secret });
    expect((await h.request("/oauth/revoke", revoke)).status).toBe(200);
    for (const r of gatedRoutes) {
      const [valid] = requests(r, ids);
      expect(await send(valid!, revoked), `${route(r)}, revoked`).toEqual(FORBIDDEN);
    }
    // A stale token (of an earlier credential epoch) is invalid as an expired one is.
    await sql(h.store, "UPDATE local_accounts SET credential_epoch = credential_epoch + 1 WHERE email = ?", OWNER);
    for (const r of gatedRoutes) {
      const [valid] = requests(r, ids);
      expect(await send(valid!, tokens.admin), `${route(r)}, stale`).toEqual(INVALID);
    }
  }, 300_000);
});

describe("GET /admin/health: oauthAdmin", () => {
  let team: AccessTeam;

  beforeEach(async () => {
    team = await adminTeam();
  });

  it("says why there is, or is not, an OAuth admin", async () => {
    const store = await migratedStore();
    await setTeamAccess(store, team);
    const { as } = adminHarness(store, team);
    // The CLI's service token, so the admin email may be cleared.
    const health = async () => (await as(serviceClaims(), "/admin/health")).json<{ oauthAdmin: unknown }>();
    expect((await health()).oauthAdmin).toEqual({ status: "none", username: null });
    await seedAccount(store, { username: "admin", email: ADMIN_EMAIL });
    expect((await health()).oauthAdmin).toEqual({ status: "ok", username: "admin" });
    await seedAccount(store, { username: "twin", email: ADMIN_EMAIL.toUpperCase() });
    expect((await health()).oauthAdmin).toEqual({ status: "ambiguous", username: null });
    await sql(store, "DELETE FROM local_accounts WHERE email = ?", ADMIN_EMAIL.toUpperCase());
    await sql(store, "UPDATE local_accounts SET suspended_at = ?", new Date(NOW).toISOString());
    expect((await health()).oauthAdmin).toEqual({ status: "suspended", username: "admin" });
    await sql(store, "UPDATE instance_settings SET value = '' WHERE name = 'admin_email'");
    expect((await health()).oauthAdmin).toEqual({ status: "unset", username: null });
  });

  it("is not shown to the import token", async () => {
    const IMPORT_TOKEN = "import-token-0123456789abcdef0123456789";
    const { request } = adminHarness(await migratedStore(), team, { IMPORT_TOKEN });
    const response = await request("/admin/health", { headers: { "Kopje-Import-Token": IMPORT_TOKEN } });
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty("oauthAdmin");
  });
});
