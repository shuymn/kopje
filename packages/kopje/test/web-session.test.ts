import { describe, expect, it, vi } from "vitest";

import { SESSION_LIFETIME_MS } from "../src/domain/web-session";
import { handleScheduled } from "../src/jobs/scheduled";
import { MAX_FIELDS } from "../src/platform/stored-bounds";
import { csrfToken, returnPath } from "../src/web/session";
import { type ApiHarness, apiHarness, bearer, login, registerApp, seedAccount, sql, withAlice } from "./api-helpers";
import { NOW } from "./app-helpers";
import { PLAIN_NOTE } from "./note-fills";
import { attr, one, parseHtml, query, text } from "./web-dom";
import {
  type Browser,
  callback,
  cookieHeader,
  csrfOf,
  LOGIN,
  ORIGIN,
  postForm,
  SESSION,
  setCookies,
  signIn,
  startSignIn,
} from "./web-helpers";

// The web UI's sessions (AUTH, WEB-1, WEB-4) and the settings page: sign-in through Access, the opaque session cookie,
// sign-out, expiry and revocation, and the Origin and anti-forgery checks on every state change.

function settings(h: ApiHarness, browser: Browser) {
  return h.request("/settings", { headers: { cookie: browser.cookie } });
}

// The text of the settings page's textarea `name`, as the form shows it.
async function textareaOf(h: ApiHarness, browser: Browser, name: string): Promise<string> {
  const page = parseHtml(await (await settings(h, browser)).text());
  const [textarea, ...more] = query(page, "textarea").filter((element) => attr(element, "name") === name);
  expect(textarea, name).toBeDefined();
  expect(more, name).toEqual([]);
  return textarea!.childNodes.map((node) => (node as { value?: string }).value ?? "").join("");
}

async function sessionRows(h: Awaited<ReturnType<typeof withAlice>>) {
  return sql<{ token_hash: string; expires_at: string | null }>(
    h.store,
    `SELECT token_hash, expires_at FROM oauth_tokens
		WHERE client_id = (SELECT value FROM instance_settings WHERE name = 'web_client_id') AND kind = 'access'`,
  );
}

describe("sign-in (AUTH)", () => {
  it("signs in through Access and sets an opaque, HttpOnly, Secure, SameSite session cookie", async () => {
    const h = await withAlice();
    const started = await startSignIn(h);
    // /login sets only the short-lived login cookie and sends the browser to the consent page behind Access.
    expect(started.authorize.pathname).toBe("/oauth/authorize");
    expect(started.authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(started.authorize.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/callback`);
    const loginLine = setCookies(started.login).lines.find((line) => line.startsWith(`${LOGIN}=`));
    expect(loginLine).toMatch(/; Max-Age=600; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
    // The web client's consent reads as signing in.
    const consent = await started.consent.text();
    expect(consent).toContain("Sign in");
    expect(consent).toContain("@alice");
    expect(started.approved.status).toBe(302);
    expect(started.callback.pathname).toBe("/auth/callback");

    const response = await callback(h, started.callback, { [LOGIN]: started.loginCookie });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/settings");
    const cookies = setCookies(response);
    const sessionLine = cookies.lines.find((line) => line.startsWith(`${SESSION}=`));
    expect(sessionLine).toMatch(
      new RegExp(`; Max-Age=${SESSION_LIFETIME_MS / 1000}; Path=/; HttpOnly; Secure; SameSite=Lax$`),
    );
    // The login cookie is cleared.
    expect(cookies.lines.find((line) => line.startsWith(`${LOGIN}=`))).toMatch(/Max-Age=0/);
    const session = cookies.values.get(SESSION) ?? "";
    expect(session).toMatch(/^token-/);
    // Stored as a digest only, with a fixed expiry (AUTH-7).
    const rows = await sessionRows(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).not.toBe(session);
    expect(rows[0]?.expires_at).toBe(new Date(NOW + SESSION_LIFETIME_MS).toISOString());

    const page = await settings(h, { session, cookie: cookieHeader({ [SESSION]: session }) });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("@alice");
  });

  it("sends a browser without a session to sign in, and back to the settings page", async () => {
    const h = await withAlice();
    const response = await h.request("/settings");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/login?return=%2Fsettings");
  });

  it("refuses a callback without the login cookie, or with another state (session fixation, login CSRF)", async () => {
    const h = await withAlice();
    await seedAccount(h.store, { username: "mallory", email: "mallory@example.com" });
    // The attacker completes a sign-in of their own and sends the victim the callback URL.
    const attacker = await startSignIn(h, "mallory@example.com");
    const noCookie = await callback(h, attacker.callback, {});
    expect(noCookie.status).toBe(400);
    expect(setCookies(noCookie).values.get(SESSION)).toBeUndefined();
    // The victim has a sign-in of their own in progress: the state does not match theirs.
    const victim = await startSignIn(h);
    const crossed = await callback(h, attacker.callback, { [LOGIN]: victim.loginCookie });
    expect(crossed.status).toBe(400);
    expect(setCookies(crossed).values.get(SESSION)).toBeUndefined();
    // The victim's state with the attacker's code: the code is bound to the attacker's PKCE challenge.
    const injected = new URL(attacker.callback);
    injected.searchParams.set("state", victim.authorize.searchParams.get("state") ?? "");
    const forged = await callback(h, injected, { [LOGIN]: victim.loginCookie });
    expect(forged.status).toBe(400);
    expect(setCookies(forged).values.get(SESSION)).toBeUndefined();
    expect(await sessionRows(h)).toEqual([]);
  });

  it("uses a code once", async () => {
    const h = await withAlice();
    const started = await startSignIn(h);
    expect((await callback(h, started.callback, { [LOGIN]: started.loginCookie })).status).toBe(303);
    expect((await callback(h, started.callback, { [LOGIN]: started.loginCookie })).status).toBe(400);
    expect(await sessionRows(h)).toHaveLength(1);
  });

  it("ends the session the browser already had when it signs in again", async () => {
    const h = await withAlice();
    const first = await signIn(h);
    const started = await startSignIn(h, "alice@example.com", undefined, first);
    const response = await callback(h, started.callback, { [LOGIN]: started.loginCookie, [SESSION]: first.session });
    expect(response.status).toBe(303);
    expect(await sessionRows(h)).toHaveLength(1);
    expect((await settings(h, first)).status).toBe(302);
  });

  it("consumes a sign-in attempt once: a second code for it starts nothing (overlapping callbacks)", async () => {
    const h = await withAlice();
    const started = await startSignIn(h);
    const second = await started.approveAgain();
    expect(second.searchParams.get("code")).not.toBe(started.callback.searchParams.get("code"));
    expect((await callback(h, started.callback, { [LOGIN]: started.loginCookie })).status).toBe(303);
    expect((await callback(h, second, { [LOGIN]: started.loginCookie })).status).toBe(400);
    expect(await sessionRows(h)).toHaveLength(1);
  });

  it("keeps one session per browser when two sign-ins of it complete", async () => {
    const h = await withAlice();
    const first = await signIn(h);
    const a = await startSignIn(h, "alice@example.com", undefined, first);
    const b = await startSignIn(h, "alice@example.com", undefined, first);
    expect((await callback(h, a.callback, { [LOGIN]: a.loginCookie })).status).toBe(303);
    expect((await callback(h, b.callback, { [LOGIN]: b.loginCookie })).status).toBe(303);
    expect(await sessionRows(h)).toHaveLength(1);
  });

  it("leaves the newer sign-in in place when a stale callback arrives", async () => {
    const h = await withAlice();
    const older = await startSignIn(h);
    const newer = await startSignIn(h);
    // The older tab's callback arrives with the newer sign-in's cookie.
    const stale = await callback(h, older.callback, { [LOGIN]: newer.loginCookie });
    expect(stale.status).toBe(400);
    expect(setCookies(stale).lines).toEqual([]);
    expect((await callback(h, newer.callback, { [LOGIN]: newer.loginCookie })).status).toBe(303);
  });

  it("installs nothing from a callback that arrives after sign-out", async () => {
    const h = await withAlice();
    const browser = await signIn(h);
    const started = await startSignIn(h, "alice@example.com", undefined, browser);
    const csrf = await csrfOf(h, browser);
    expect((await postForm(h, browser, "/logout", { csrf })).status).toBe(200);
    const late = await callback(h, started.callback, { [LOGIN]: started.loginCookie });
    expect(late.status).toBe(400);
    expect(setCookies(late).values.get(SESSION)).toBeUndefined();
    expect(await sessionRows(h)).toEqual([]);
  });

  it("signs out the newer session when sign-out carries the session it replaced", async () => {
    const h = await withAlice();
    const browser = await signIn(h);
    const csrf = await csrfOf(h, browser);
    const started = await startSignIn(h, "alice@example.com", undefined, browser);
    const replaced = await callback(h, started.callback, { [LOGIN]: started.loginCookie });
    const session = setCookies(replaced).values.get(SESSION) ?? "";
    expect((await settings(h, browser)).status).toBe(302);
    // The sign-out form was rendered for the old session, and is posted after the new one was installed.
    expect((await postForm(h, browser, "/logout", { csrf })).status).toBe(200);
    expect(await sessionRows(h)).toEqual([]);
    expect((await settings(h, { session, cookie: cookieHeader({ [SESSION]: session }) })).status).toBe(302);
  });

  it("keeps the sign-out fence when the session expires and is swept before the late callback", async () => {
    const h = await withAlice();
    const browser = await signIn(h);
    // The session ends in five minutes; the sign-in starts now, sign-out follows.
    const soon = NOW + 5 * 60 * 1000;
    await sql(h.store, "UPDATE oauth_tokens SET expires_at = ? WHERE kind = 'access'", new Date(soon).toISOString());
    await sql(
      h.store,
      "UPDATE kopje_state SET value = json_set(value, '$.expiresAt', ?) WHERE name LIKE 'web_session:%'",
      soon,
    );
    const started = await startSignIn(h, "alice@example.com", undefined, browser);
    expect((await postForm(h, browser, "/logout", { csrf: await csrfOf(h, browser) })).status).toBe(200);
    const later = NOW + 6 * 60 * 1000;
    h.now.mockReturnValue(later);
    await handleScheduled({ ...h.env, MAINTENANCE: "off" } as unknown as Env, {
      build: () => h.env.CF_VERSION_METADATA.id,
      now: () => later,
      store: () => h.store,
    });
    expect(await sql(h.store, "SELECT name FROM kopje_state WHERE name LIKE 'web_session:%'")).toEqual([]);
    const late = await callback(h, started.callback, { [LOGIN]: started.loginCookie });
    expect(late.status).toBe(400);
    expect(await sessionRows(h)).toEqual([]);
  });

  it('fences the sign-ins in flight of the sessions "sign out other sessions" ends', async () => {
    const h = await withAlice();
    const a = await signIn(h);
    const b = await signIn(h);
    // Browser B has a code for a new sign-in, not yet exchanged.
    const pending = await startSignIn(h, "alice@example.com", undefined, b);
    const response = await postForm(h, a, "/settings/sessions/revoke", { csrf: await csrfOf(h, a) });
    expect(response.status).toBe(303);
    const late = await callback(h, pending.callback, { [LOGIN]: pending.loginCookie, [SESSION]: b.session });
    expect(late.status).toBe(400);
    expect(setCookies(late).values.get(SESSION)).toBeUndefined();
    expect(await sessionRows(h)).toHaveLength(1);
    expect((await settings(h, a)).status).toBe(200);
  });

  it("retires every replaced or signed-out session for cookies and bearer use alike", async () => {
    const h = await withAlice();
    const api = (session: string) => h.request("/api/v1/accounts/verify_credentials", bearer(session));
    const first = await signIn(h);
    expect((await api(first.session)).status).toBe(200);
    // Replaced by a new sign-in of the same browser.
    const started = await startSignIn(h, "alice@example.com", undefined, first);
    const second = setCookies(await callback(h, started.callback, { [LOGIN]: started.loginCookie })).values.get(
      SESSION,
    );
    expect((await api(first.session)).status).toBe(401);
    expect((await api(second ?? "")).status).toBe(200);
    // Signed out with the replaced session: the newer one goes too.
    await postForm(h, first, "/logout", { csrf: await csrfToken(first.session) });
    expect((await api(second ?? "")).status).toBe(401);
    // Signed out by "sign out other sessions".
    const a = await signIn(h);
    const b = await signIn(h);
    await postForm(h, a, "/settings/sessions/revoke", { csrf: await csrfOf(h, a) });
    expect((await api(b.session)).status).toBe(401);
    // A suspended account's session.
    await sql(h.store, "UPDATE local_accounts SET suspended_at = ?", new Date(NOW).toISOString());
    expect((await api(a.session)).status).toBe(403);
    expect((await settings(h, a)).status).toBe(302);
  });

  it("lets no anonymous flood of sign-ins or failed callbacks lock out the owner (RES-6)", async () => {
    const attacker = "203.0.113.66";
    const limiter = {
      limit: vi.fn(({ key }: { key: string }) => Promise.resolve({ success: key !== attacker })),
    };
    const h = await apiHarness({ LOGIN_LIMIT: limiter });
    await seedAccount(h.store, { username: "alice", email: "alice@example.com" });
    const fromAttacker = { headers: { "cf-connecting-ip": attacker } };
    // The attacker's address is limited; the limit keys on the address, never on the account signing in.
    expect((await h.request("/login", fromAttacker)).status).toBe(429);
    // Sign-ins and failed callbacks from elsewhere, aimed at the owner's account.
    const cookies: string[] = [];
    for (let i = 0; i < 30; i++) {
      const response = await h.request("/login", { headers: { "cf-connecting-ip": `198.51.100.${i}` } });
      expect(response.status).toBe(302);
      cookies.push(setCookies(response).values.get(LOGIN) ?? "");
    }
    for (const cookie of cookies) {
      for (const query of ["?code=forged&state=forged", "?error=access_denied&state=forged"]) {
        const response = await h.request(`/auth/callback${query}`, {
          headers: { cookie: cookieHeader({ [LOGIN]: cookie }) },
        });
        expect(response.status).toBe(400);
      }
    }
    // Sign-out without a session cannot end anyone's family.
    expect((await h.request("/logout", { method: "POST", headers: { origin: ORIGIN } })).status).toBe(403);
    const owner = await signIn(h);
    expect((await settings(h, owner)).status).toBe(200);
    // Abandoned attempts expire.
    const attempts = await sql(h.store, "SELECT name FROM kopje_state WHERE name LIKE 'web_login:%'");
    expect(attempts).toHaveLength(30);
    // The owner's attempt was consumed. Ten minutes on, each new sign-in prunes expired ones.
    h.now.mockReturnValue(NOW + 11 * 60 * 1000);
    await h.request("/login");
    await h.request("/login");
    expect(await sql(h.store, "SELECT name FROM kopje_state WHERE name LIKE 'web_login:%'")).toHaveLength(2);
  });

  it("shows a cancelled sign-in and starts no session", async () => {
    const h = await withAlice();
    const started = await startSignIn(h);
    const denied = new URL(started.callback);
    denied.searchParams.delete("code");
    denied.searchParams.set("error", "access_denied");
    const response = await callback(h, denied, { [LOGIN]: started.loginCookie });
    expect(response.status).toBe(403);
    expect(await sessionRows(h)).toEqual([]);
  });

  it("refuses a suspended account at the callback", async () => {
    const h = await withAlice();
    const started = await startSignIn(h);
    await sql(h.store, "UPDATE local_accounts SET suspended_at = ?", new Date(NOW).toISOString());
    expect((await callback(h, started.callback, { [LOGIN]: started.loginCookie })).status).toBe(400);
    expect(await sessionRows(h)).toEqual([]);
  });

  it("expires a session after its lifetime", async () => {
    const h = await withAlice();
    const browser = await signIn(h);
    h.now.mockReturnValue(NOW + SESSION_LIFETIME_MS);
    const response = await settings(h, browser);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/login?return=%2Fsettings");
  });

  it("does not take an API token for a session", async () => {
    const h = await withAlice();
    const { token } = await login(h, { scope: "read write" });
    const response = await settings(h, { session: token, cookie: cookieHeader({ [SESSION]: token }) });
    expect(response.status).toBe(302);
  });
});

describe("return paths (WEB-4)", () => {
  it("accepts only local paths (WEB-4: unsafe return path)", () => {
    expect(returnPath("/settings")).toBe("/settings");
    expect(returnPath("/@alice?max_id=1")).toBe("/@alice?max_id=1");
    // An '@' after the single leading slash is part of a local path (a profile), never userinfo.
    expect(returnPath("/@evil.example")).toBe("/@evil.example");
    const unsafe = {
      "absolute URL to another host": "https://evil.example/",
      "absolute URL with userinfo": "https://kopje.test@evil.example/",
      "protocol-relative": "//evil.example",
      "protocol-relative with userinfo": "//kopje.test@evil.example/",
      "slash backslash": "/\\evil.example",
      "backslash later": "/settings\\..\\x",
      "javascript:": "javascript:alert(1)",
      "data:": "data:text/html,x",
      "no leading slash": "evil.example",
      empty: "",
      "tab inside //": "/\t/evil.example",
      newline: "/x\ny",
      "control character": "/x\u0000y",
      DEL: "/x\u007fy",
      "encoded slashes": "/%2F%2Fevil.example",
      "encoded slash, lowercase": "/%2f/evil.example",
      "encoded backslash": "/%5Cevil.example",
      "encoded control": "/x%0d%0aLocation:%20//evil.example",
      "encoded dot segment": "/%2e%2e//evil.example",
      "double encoding": "/%252F%252Fevil.example",
      "dot segment to //": "/a/..//evil.example",
      "single dot to //": "/.//evil.example",
      "too long": `/${"a".repeat(600)}`,
    };
    for (const [name, value] of Object.entries(unsafe)) {
      expect(returnPath(value), name).toBe("/settings");
    }
    expect(returnPath(undefined)).toBe("/settings");
    expect(returnPath(null)).toBe("/settings");
  });

  it("returns after sign-in only to a validated local path", async () => {
    const h = await withAlice();
    for (const [asked, expected] of [
      ["/@alice", "/@alice"],
      ["//evil.example/x", "/settings"],
      ["https://evil.example/", "/settings"],
      ["/a/..//evil.example", "/settings"],
      ["/%2F%2Fevil.example", "/settings"],
      ["javascript:alert(1)", "/settings"],
    ] as const) {
      const started = await startSignIn(h, "alice@example.com", asked);
      const response = await callback(h, started.callback, { [LOGIN]: started.loginCookie });
      expect(response.headers.get("location"), asked).toBe(expected);
    }
  });

  it("trusts nothing but the attempt id from the login cookie (forged attempts, sessions, return paths)", async () => {
    const h = await withAlice();
    await seedAccount(h.store, { username: "bob", email: "bob@example.com" });
    const bob = await signIn(h, "bob@example.com");
    const victim = await startSignIn(h);
    const attacker = await startSignIn(h, "bob@example.com");
    // Structured or unknown cookie values name no attempt: no return path, session digest or family is read from it.
    for (const forged of [
      `${victim.loginCookie}.//evil.example`,
      `${victim.loginCookie}.${"a".repeat(64)}./settings`,
      "unknown-attempt-id-000000000000",
    ]) {
      const response = await callback(h, victim.callback, { [LOGIN]: forged });
      expect(response.status, forged).toBe(400);
      expect(response.headers.get("location")).toBeNull();
    }
    // Another attempt's cookie with the victim's callback: the state is not that attempt's; neither is consumed.
    const crossed = await callback(h, victim.callback, { [LOGIN]: attacker.loginCookie });
    expect(crossed.status).toBe(400);
    expect(setCookies(crossed).lines).toEqual([]);
    // Both attempts still complete with their own cookies, and the return path is the Store's.
    const done = await callback(h, victim.callback, { [LOGIN]: victim.loginCookie });
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/settings");
    // Bob's session was never touched.
    expect((await settings(h, bob)).status).toBe(200);
  });
});

// Every state-changing form of the web UI, with what it needs besides the token.
const FORMS: { path: string; fields: Record<string, string> }[] = [
  { path: "/settings/profile", fields: { display_name: "Forged" } },
  { path: "/settings/authorizations/revoke", fields: { client_id: "x" } },
  { path: "/settings/sessions/revoke", fields: {} },
  { path: "/logout", fields: {} },
];

describe("state changes (WEB-1, WEB-4)", () => {
  it("refuses a missing, null or foreign Origin on every form, before anything changes", async () => {
    const h = await withAlice();
    const browser = await signIn(h);
    const csrf = await csrfOf(h, browser);
    for (const { path, fields } of [
      ...FORMS,
      { path: "/settings/avatar", fields: {} },
      { path: "/settings/header", fields: {} },
    ]) {
      for (const origin of [null, "null", "https://evil.example", "http://kopje.test"]) {
        const response = await postForm(h, browser, path, { ...fields, csrf }, origin);
        expect(response.status, `${path} ${origin}`).toBe(403);
        expect(response.headers.get("content-type")).toBe("text/html; charset=UTF-8");
      }
    }
    expect(await sql(h.store, "SELECT display_name FROM accounts")).toEqual([{ display_name: "Alice" }]);
    expect(await sessionRows(h)).toHaveLength(1);
    expect((await settings(h, browser)).status).toBe(200);
  });

  it("refuses a missing or wrong anti-forgery token on every form", async () => {
    const h = await withAlice();
    const browser = await signIn(h);
    const other = await signIn(h);
    // A token of another session of the same user is not this session's.
    const otherCsrf = await csrfOf(h, other);
    for (const { path, fields } of FORMS) {
      for (const csrf of [undefined, "", "forged", otherCsrf]) {
        const response = await postForm(h, browser, path, csrf === undefined ? fields : { ...fields, csrf });
        expect(response.status, `${path} ${csrf}`).toBe(403);
      }
    }
    expect(await sql(h.store, "SELECT display_name FROM accounts")).toEqual([{ display_name: "Alice" }]);
    expect(await sessionRows(h)).toHaveLength(2);
  });

  it("refuses a form without a session", async () => {
    const h = await withAlice();
    const response = await h.request("/settings/profile", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: "display_name=x&csrf=x",
    });
    expect(response.status).toBe(403);
  });
});

describe("sign-out and revocation (AUTH)", () => {
  it("signs out, and the cookie authenticates nothing afterwards (reuse after logout)", async () => {
    const h = await withAlice();
    const browser = await signIn(h);
    const csrf = await csrfOf(h, browser);
    const response = await postForm(h, browser, "/logout", { csrf });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(setCookies(response).lines.find((line) => line.startsWith(`${SESSION}=`))).toMatch(/Max-Age=0/);
    expect(await sessionRows(h)).toEqual([]);
    // The old cookie, replayed.
    expect((await settings(h, browser)).status).toBe(302);
    expect((await postForm(h, browser, "/settings/profile", { csrf, display_name: "x" })).status).toBe(302);
    expect(await sql(h.store, "SELECT display_name FROM accounts")).toEqual([{ display_name: "Alice" }]);
    // Nor is it a bearer token any more.
    expect((await h.request("/api/v1/accounts/verify_credentials", bearer(browser.session))).status).toBe(401);
  });

  it("signs out the other sessions only", async () => {
    const h = await withAlice();
    const browser = await signIn(h);
    const other = await signIn(h);
    const page = await (await settings(h, browser)).text();
    expect(page).toContain("1 other web session is active.");
    const response = await postForm(h, browser, "/settings/sessions/revoke", { csrf: await csrfOf(h, browser) });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/settings?notice=sessions");
    expect((await settings(h, other)).status).toBe(302);
    expect((await settings(h, browser)).status).toBe(200);
  });

  it("ends the sessions of an account that is suspended", async () => {
    const h = await withAlice();
    const browser = await signIn(h);
    await sql(h.store, "UPDATE local_accounts SET suspended_at = ?", new Date(NOW).toISOString());
    expect((await settings(h, browser)).status).toBe(302);
  });

  it("lists the authorized apps and revokes one (AUTH-6: only the viewer’s own)", async () => {
    const h = await withAlice();
    await seedAccount(h.store, { username: "bob", email: "bob@example.com" });
    const app = await registerApp(h);
    const alice = await login(h, { app, email: "alice@example.com" });
    const bob = await login(h, { app, email: "bob@example.com" });
    await sql(
      h.store,
      "UPDATE oauth_tokens SET created_at = '2026-10-01T23:30:00.000Z' WHERE client_id = ?",
      app.client_id,
    );
    const browser = await signIn(h);
    const page = await (await settings(h, browser)).text();
    // The web client is not listed as an app: one item, Test Client, and every revoke form names its client.
    const doc = parseHtml(page);
    const apps = query(one(doc, "ul", "apps"), "li");
    expect(apps.map((li) => text(one(li, "strong")))).toEqual(["Test Client"]);
    // The page loads no bundle and the time of day does not matter: the authorization shows its UTC calendar date.
    const authorized = one(apps[0]!, "time");
    expect([attr(authorized, "datetime"), attr(authorized, "data-local"), text(authorized)]).toEqual([
      "2026-10-01",
      null,
      "Oct 1, 2026",
    ]);
    const revoked = query(doc, "input")
      .filter((input) => attr(input, "name") === "client_id")
      .map((input) => attr(input, "value"));
    expect(revoked).toEqual([app.client_id]);

    const response = await postForm(h, browser, "/settings/authorizations/revoke", {
      client_id: app.client_id,
      csrf: await csrfOf(h, browser),
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/settings?notice=revoked");
    expect((await h.request("/api/v1/accounts/verify_credentials", bearer(alice.token))).status).toBe(401);
    // Bob's authorization of the same app stays.
    expect((await h.request("/api/v1/accounts/verify_credentials", bearer(bob.token))).status).toBe(200);
    expect(await (await settings(h, browser)).text()).toContain("No authorized apps yet.");
  });

  it("does not revoke the web client as an app", async () => {
    const h = await withAlice();
    const browser = await signIn(h);
    const [client] = await sql<{ value: string }>(
      h.store,
      "SELECT value FROM instance_settings WHERE name = 'web_client_id'",
    );
    await postForm(h, browser, "/settings/authorizations/revoke", {
      client_id: client?.value ?? "",
      csrf: await csrfOf(h, browser),
    });
    expect((await settings(h, browser)).status).toBe(200);
  });
});

describe("settings page", () => {
  it("is never cached, framed or opened to other origins (WEB-2, WEB-3, WEB-5)", async () => {
    const h = await withAlice();
    const browser = await signIn(h);
    for (const response of [
      await h.request("/settings", { headers: { cookie: browser.cookie, origin: "https://evil.example" } }),
      await h.request("/auth/callback", { headers: { origin: "https://evil.example" } }),
    ]) {
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-type")).toBe("text/html; charset=UTF-8");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      // Not no-referrer: browsers would post the forms with Origin: null, which the Origin check refuses.
      expect(response.headers.get("referrer-policy")).toBe("same-origin");
      expect(response.headers.get("content-security-policy")).toBe(
        "default-src 'none'; style-src 'self'; img-src 'self' https:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      );
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
    const page = await (await settings(h, browser)).text();
    expect(page).not.toContain("<script");
  });

  it("saves the profile: name, bio, fields, locked, discoverable and default visibility", async () => {
    const h = await withAlice();
    const browser = await signIn(h);
    const fields = new URLSearchParams({
      csrf: await csrfOf(h, browser),
      display_name: "Alice <Liddell>",
      note: "Down the <b>rabbit</b> hole",
      "fields_attributes[0][name]": "Site",
      "fields_attributes[0][value]": "https://alice.example/",
      "fields_attributes[1][name]": "Script",
      "fields_attributes[1][value]": "javascript:alert(1) <script>x</script>",
      "fields_attributes[2][name]": "",
      "fields_attributes[2][value]": "",
      "source[privacy]": "unlisted",
    });
    // Checkboxes: a checked box posts its hidden false, then true; the last value is read.
    fields.append("locked", "false");
    fields.append("locked", "true");
    fields.append("discoverable", "false");
    const response = await postForm(h, browser, "/settings/profile", fields);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/settings?notice=saved");
    // The save's Update(Person) is delivered at once, not at the next cron.
    expect(h.doorbell).toHaveBeenCalledTimes(1);

    const { token } = await login(h, { scope: "read" });
    const me = await (
      await h.request("/api/v1/accounts/verify_credentials", bearer(token))
    ).json<{
      display_name: string;
      note: string;
      locked: boolean;
      discoverable: boolean;
      fields: { name: string; value: string }[];
      source: { privacy: string; fields: { name: string; value: string }[] };
    }>();
    expect(me).toMatchObject({
      display_name: "Alice <Liddell>",
      note: "<p>Down the &lt;b&gt;rabbit&lt;/b&gt; hole</p>",
      locked: true,
      discoverable: false,
      source: {
        privacy: "unlisted",
        fields: [
          { name: "Site", value: "https://alice.example/", verified_at: null },
          { name: "Script", value: "javascript:alert(1) <script>x</script>", verified_at: null },
        ],
      },
    });
    // HTML-2: values are escaped and only http(s) URLs linked.
    expect(me.fields[0]?.value).toContain('<a href="https://alice.example/"');
    expect(me.fields[1]?.value).toBe("javascript:alert(1) &lt;script&gt;x&lt;/script&gt;");

    const page = await (await h.request("/settings?notice=saved", { headers: { cookie: browser.cookie } })).text();
    expect(page).toContain("Your profile has been saved.");
    expect(page).toContain('value="Alice &lt;Liddell&gt;"');
  });

  it("renders a row for every field the account may store, and a save from it keeps them all", async () => {
    const h = await withAlice();
    const browser = await signIn(h);
    const fieldInputs = async () =>
      query(
        parseHtml(await (await h.request("/settings", { headers: { cookie: browser.cookie } })).text()),
        "input",
      ).filter((i) => /^fields_attributes\[\d+\]\[(name|value)\]$/.test(attr(i, "name") ?? ""));
    // With no fields, as many empty rows as the account may store.
    expect(await fieldInputs()).toHaveLength(MAX_FIELDS * 2);
    const { token } = await login(h, { scope: "read write" });
    const stored = Array.from({ length: MAX_FIELDS }, (_, i) => ({ name: `Name ${i}`, value: `Value ${i}` }));
    const set = await h.request(
      "/api/v1/accounts/update_credentials",
      bearer(token, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fields_attributes: stored }),
      }),
    );
    expect(set.status).toBe(200);
    const inputs = await fieldInputs();
    expect(inputs).toHaveLength(MAX_FIELDS * 2);
    // The profile form posted as rendered: every stored field comes back.
    const form = new URLSearchParams({ csrf: await csrfOf(h, browser), display_name: "alice" });
    for (const input of inputs) {
      form.append(attr(input, "name")!, attr(input, "value") ?? "");
    }
    expect((await postForm(h, browser, "/settings/profile", form)).status).toBe(303);
    const me = await (
      await h.request("/api/v1/accounts/verify_credentials", bearer(token))
    ).json<{
      source: { fields: { name: string; value: string }[] };
    }>();
    expect(me.source.fields.map(({ name, value }) => ({ name, value }))).toEqual(stored);
  });

  it("shows validation problems and saves nothing", async () => {
    const h = await withAlice();
    const browser = await signIn(h);
    const csrf = await csrfOf(h, browser);
    const response = await postForm(h, browser, "/settings/profile", {
      csrf,
      display_name: "x".repeat(41),
      "fields_attributes[0][name]": " ",
      "fields_attributes[0][value]": "v",
    });
    expect(response.status).toBe(422);
    const page = await response.text();
    expect(page).toContain("Display name is too long (maximum is 40 characters)");
    expect(page).toContain("Fields contains values with missing labels");
    expect(await sql(h.store, "SELECT display_name FROM accounts")).toEqual([{ display_name: "Alice" }]);
    expect(h.doorbell).not.toHaveBeenCalled();
  });

  // The server decides the display name's limit in code points (40, Mastodon's), after stripping it as Mastodon does
  // (test/accounts.test.ts); the field's native limit lets through more (browser job), so 41 BMP characters reach this
  // check.
  it("saves a display name of 40 code points, astral ones included, and refuses 41", async () => {
    const h = await withAlice();
    const browser = await signIn(h);
    const csrf = await csrfOf(h, browser);
    const forty = `${"😀".repeat(20)}${"あ".repeat(20)}`;
    const saved = await postForm(h, browser, "/settings/profile", { csrf, display_name: `\u0000 ${forty}\t\u0000` });
    expect(saved.status).toBe(303);
    expect(await sql(h.store, "SELECT display_name FROM accounts")).toEqual([{ display_name: forty }]);
    for (const value of ["😀".repeat(41), "x".repeat(41)]) {
      const refused = await postForm(h, browser, "/settings/profile", { csrf, display_name: value });
      expect(refused.status, value).toBe(422);
      expect(await refused.text()).toContain("Display name is too long (maximum is 40 characters)");
    }
    expect(await sql(h.store, "SELECT display_name FROM accounts")).toEqual([{ display_name: forty }]);
  });

  // The note round-trips through the form as Mastodon keeps it: stripped of ASCII whitespace and NUL at its ends, its
  // Unicode spaces kept (test/accounts.test.ts).
  it("saves a note with Unicode spaces and shows it back in the form", async () => {
    const h = await withAlice();
    const browser = await signIn(h);
    const csrf = await csrfOf(h, browser);
    expect((await postForm(h, browser, "/settings/profile", { csrf, note: " bio\u3000" })).status).toBe(303);
    expect(await sql(h.store, "SELECT note FROM accounts")).toEqual([{ note: "<p>bio\u3000</p>" }]);
    expect(await textareaOf(h, browser, "note")).toBe("bio\u3000");
  });

  // The textarea takes MAX_RAW_LENGTH code units (browser job), and the form is read with update_credentials' limit:
  // a note of three-byte characters at the raw bound, which NoteLengthValidator counts as 500, encodes to 90,000 bytes.
  it("saves a note at the raw bound, and refuses one past it with its message", async () => {
    const h = await withAlice();
    const browser = await signIn(h);
    const csrf = await csrfOf(h, browser);
    expect(new URLSearchParams({ note: PLAIN_NOTE }).toString().length).toBeGreaterThan(64 * 1024);
    expect((await postForm(h, browser, "/settings/profile", { csrf, note: PLAIN_NOTE })).status).toBe(303);
    expect(await textareaOf(h, browser, "note")).toBe(PLAIN_NOTE);
    const refused = await postForm(h, browser, "/settings/profile", { csrf, note: `${PLAIN_NOTE}x` });
    expect(refused.status).toBe(422);
    expect(await refused.text()).toContain("Note is too long (maximum is 500 characters)");
    expect(await textareaOf(h, browser, "note")).toBe(PLAIN_NOTE);
  });

  // An image card's form posts its description alone to /settings/profile, so nothing else changes; '' clears it, and
  // the server refuses one past PROFILE_DESCRIPTION_LIMIT code points (test/profile-descriptions.test.ts) with its
  // message, saving nothing. The textarea's native limit lets the 151 astral characters through (browser job).
  it("saves an image description from its card, and shows it back in the form", async () => {
    const h = await withAlice();
    const browser = await signIn(h);
    const csrf = await csrfOf(h, browser);
    const stored = async () =>
      (
        await sql<Record<string, string | number | null>>(
          h.store,
          `SELECT display_name, note, locked, discoverable, indexable, avatar_description, header_description
					FROM accounts`,
        )
      )[0];
    const before = await stored();
    for (const [name, value] of [
      ["avatar_description", "A cat 😀"],
      ["header_description", "A field"],
    ] as const) {
      expect((await postForm(h, browser, "/settings/profile", { csrf, [name]: value })).status).toBe(303);
    }
    expect(await stored()).toEqual({ ...before, avatar_description: "A cat 😀", header_description: "A field" });
    expect([
      await textareaOf(h, browser, "avatar_description"),
      await textareaOf(h, browser, "header_description"),
    ]).toEqual(["A cat 😀", "A field"]);
    const refused = await postForm(h, browser, "/settings/profile", { csrf, avatar_description: "😀".repeat(151) });
    expect(refused.status).toBe(422);
    expect(await refused.text()).toContain("Avatar description is too long (maximum is 150 characters)");
    expect(await stored()).toMatchObject({ avatar_description: "A cat 😀" });
    expect(
      (await postForm(h, browser, "/settings/profile", { csrf, avatar_description: "😀".repeat(150) })).status,
    ).toBe(303);
    expect((await postForm(h, browser, "/settings/profile", { csrf, header_description: "" })).status).toBe(303);
    expect(await stored()).toEqual({ ...before, avatar_description: "😀".repeat(150), header_description: "" });
  });

  // A browser submits a textarea's line breaks as CRLF (HTML's form-data newline normalization), which the textarea
  // holds as LF, and the HTML parser drops a newline right after <textarea>: an image description is stored as its
  // textarea holds it, its code points counted so, and one that starts with a newline shows as stored, so saving what
  // the browser read stores it unchanged (browser job: the real form).
  it("keeps an image description as its textarea holds it, a leading newline included, through the form", async () => {
    const h = await withAlice();
    const browser = await signIn(h);
    const csrf = await csrfOf(h, browser);
    const values = { avatar_description: "\nA cat", header_description: "\n\nA field\n" };
    const submitted = (value: string) => value.replaceAll("\n", "\r\n");
    const stored = async () =>
      (await sql<typeof values>(h.store, "SELECT avatar_description, header_description FROM accounts"))[0];
    for (const [name, value] of Object.entries(values)) {
      expect((await postForm(h, browser, "/settings/profile", { csrf, [name]: submitted(value) })).status).toBe(303);
    }
    expect(await stored()).toEqual(values);
    for (const [name, value] of Object.entries(values)) {
      const shown = await textareaOf(h, browser, name);
      expect(shown, name).toBe(value);
      expect((await postForm(h, browser, "/settings/profile", { csrf, [name]: submitted(shown) })).status).toBe(303);
    }
    expect(await stored()).toEqual(values);
    // PROFILE_DESCRIPTION_LIMIT code points with a line break, as the textarea's maxlength counts them; a lone CR.
    const full = `${"x".repeat(74)}\n${"x".repeat(75)}`;
    expect(
      (await postForm(h, browser, "/settings/profile", { csrf, avatar_description: submitted(full) })).status,
    ).toBe(303);
    expect((await postForm(h, browser, "/settings/profile", { csrf, header_description: "a\rb" })).status).toBe(303);
    expect(await stored()).toEqual({ avatar_description: full, header_description: "a\nb" });
    // The bio is stripped when saved, so only a stored note shows one: a line break first in its paragraph.
    await sql(h.store, "UPDATE accounts SET note = '<p><br>bio</p>'");
    expect(await textareaOf(h, browser, "note")).toBe("\nbio");
  });

  it("shows only notices it knows", async () => {
    const h = await withAlice();
    const browser = await signIn(h);
    const page = await (
      await h.request("/settings?notice=%3Cscript%3E", { headers: { cookie: browser.cookie } })
    ).text();
    expect(page).not.toContain('class="notice"');
    expect(page).not.toContain("<script");
  });
});
