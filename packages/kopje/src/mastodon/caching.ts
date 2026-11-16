import type { Context } from "hono";
import { createMiddleware } from "hono/factory";

// The headers of every Mastodon API answer: its Cache-Control and Vary (WEB-7) and the API's security headers
// (WEB-5). Each route of the table (mastodon/routes.ts) declares a Caching, which mastodonApi sets as the request's
// `caching` before anything else of the route runs; apiHeaders (registered in app/app.ts on /api/* and
// /oauth/userinfo, after CORS and before the maintenance gate) writes the headers on the answer as it leaves, whatever
// produced it: the handler, an early refusal, the suspended owner's 403 (AUTH-2), a gate, notFound or onError. An
// answer of no route (none matched, or a gate answered first) carries no declaration and is private with no Vary, as
// Mastodon's catch-all. Headers a handler set are overwritten. A CORS preflight (answered before this middleware) and
// the streaming endpoints (MD-8: Mastodon's streaming server, not Rails) are left as they are.
//
// Mastodon (v4.7.5): every controller answer starts `private, no-store` (ApplicationController
// set_cache_control_defaults); Api::BaseController declares `vary_by 'Authorization'`; cache_if_unauthenticated!
// makes a 2xx public for 15 s and cache_even_if_authenticated! for 5 min (Api::CachingConcern); and
// enforce_cache_control! makes an answer private again when its Vary names Authorization and the request sent a
// non-blank Authorization header, whatever the header holds. Directives are in Rails' order (max-age first).
// Api::BaseController's policy (Api::ContentSecurityPolicy) and the Rails defaults a browser acts on
// (config/environments/production.rb: X-Frame-Options, Referrer-Policy; nosniff is every answer's, app/app.ts) are on
// every API answer; X-XSS-Protection: 0 (obsolete) and Server (a product name) are not sent.
//
// A route Mastodon deprecates (DEPRECATED_ROUTES in mastodon/routes.ts) also declares its `Deprecation`, written on
// every answer of the route but AUTH-2's 403: Mastodon's require_not_suspended! (Api::BaseController) answers it before
// the controller's deprecate_api runs. That answer is marked where it is made (markSuspendedAnswer).

const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'; form-action 'none'",
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
};

const ANONYMOUS_CONTROL = "max-age=15, public, stale-while-revalidate=30, stale-if-error=86400";
const LONG_CONTROL = "max-age=300, public, stale-while-revalidate=30, stale-if-error=86400";
const PRIVATE_CONTROL = "private, no-store";

export type Caching = {
  // The Cache-Control of a 2xx answer a shared cache may keep, and to which requests: those without an Authorization
  // header, or every request (only a route that never reads a token; mastodonApi refuses it on any other). null:
  // every answer is private.
  readonly shared: { readonly control: string; readonly to: "anonymous" | "everyone" } | null;
  // The Vary of every answer of the route, errors included; null: none.
  readonly vary: string | null;
};

// Api::BaseController: never public, varying by Authorization. The default of every route.
export const PRIVATE: Caching = { shared: null, vary: "Authorization" };
// Never public, varying as the trends controllers' vary_by, which the admin trend lists of links and statuses
// inherit.
export const PRIVATE_BY_LANGUAGE: Caching = { shared: null, vary: "Authorization, Accept-Language" };
// cache_if_unauthenticated!: public for 15 s to a request without Authorization.
export const ANONYMOUS: Caching = { shared: { control: ANONYMOUS_CONTROL, to: "anonymous" }, vary: "Authorization" };
// The same under the trends controllers' `vary_by 'Authorization, Accept-Language'`.
export const ANONYMOUS_BY_LANGUAGE: Caching = {
  shared: { control: ANONYMOUS_CONTROL, to: "anonymous" },
  vary: "Authorization, Accept-Language",
};
// cache_even_if_authenticated! on a route that reads the token (its answer can depend on the token's owner: AUTH-2's
// 403, or a setting): public for 5 min only to a request without Authorization, varying by it (WEB-7).
export const ANONYMOUS_LONG: Caching = { shared: { control: LONG_CONTROL, to: "anonymous" }, vary: "Authorization" };
// cache_even_if_authenticated! under `vary_by ''` on a route that never reads a token (access "public"): public for
// 5 min to every request, with no Vary.
export const EVERYONE: Caching = { shared: { control: LONG_CONTROL, to: "everyone" }, vary: null };

// caching and deprecation: the route's declarations; suspendedAnswer: the answer is AUTH-2's 403.
export type ApiHeadersEnv = {
  Variables: { caching: Caching | undefined; deprecation: string | undefined; suspendedAnswer: true | undefined };
};

// The headers of an answer of a route declaring `caching` (undefined: no route declared one) with `status`, to a
// request that sent a non-empty Authorization header or not. An error is never public.
export function cacheHeaders(
  caching: Caching | undefined,
  status: number,
  authorizationSent: boolean,
): { cacheControl: string; vary: string | null } {
  const shared = caching?.shared ?? null;
  const kept = shared !== null && status >= 200 && status < 300 && (shared.to === "everyone" || !authorizationSent);
  return { cacheControl: kept ? shared.control : PRIVATE_CONTROL, vary: caching?.vary ?? null };
}

// Mastodon's deprecate_api (DeprecationConcern): the `Deprecation` of a route deprecated on `date` (YYYY-MM-DD),
// `@` and the seconds of its midnight UTC, as Ruby's Date#to_datetime.to_i reads it. No route Kopje serves has a
// Sunset.
export function deprecationHeader(date: string): string {
  const time = /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00Z`) : Number.NaN;
  if (Number.isNaN(time)) {
    throw new Error(`${date} is not a date`);
  }
  return `@${time / 1000}`;
}

// Sets the route's declarations on the request, first in its chain (mastodon/routes.ts).
export function declareHeaders(caching: Caching, deprecation: string | undefined) {
  return createMiddleware<ApiHeadersEnv>(async (c, next) => {
    c.set("caching", caching);
    c.set("deprecation", deprecation);
    await next();
  });
}

// Marks the answer AUTH-2's 403 (mastodon/access.ts, app/app.ts onError), which carries no Deprecation.
export function markSuspendedAnswer(c: { set: (key: "suspendedAnswer", value: true) => void }): void {
  c.set("suspendedAnswer", true);
}

function streamingPath(path: string): boolean {
  return path === "/api/v1/streaming" || path.startsWith("/api/v1/streaming/");
}

export const apiHeaders = createMiddleware<ApiHeadersEnv>(async (c, next) => {
  if (streamingPath(c.req.path)) {
    return next();
  }
  await next();
  // Fetch trims header values, so a header of only whitespace reads as empty, as Rails' present? reads it.
  const authorizationSent = (c.req.header("authorization") ?? "") !== "";
  const { cacheControl, vary } = cacheHeaders(c.get("caching"), c.res.status, authorizationSent);
  const deprecation = c.get("suspendedAnswer") === true ? null : (c.get("deprecation") ?? null);
  const headers = { ...SECURITY_HEADERS, "cache-control": cacheControl, vary, deprecation };
  try {
    writeHeaders(c, headers);
  } catch {
    // A response with immutable headers (Response.redirect, a fetched response) is copied first.
    c.res = new Response(c.res.body, c.res);
    writeHeaders(c, headers);
  }
});

// Sets each header, or deletes it where its value is null.
function writeHeaders(c: Context, headers: Record<string, string | null>): void {
  for (const [name, value] of Object.entries(headers)) {
    if (value === null) {
      c.res.headers.delete(name);
    } else {
      c.res.headers.set(name, value);
    }
  }
}
