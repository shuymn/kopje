import { describe, expect, it } from "vitest";

import type { RouteAccess } from "../src/mastodon/access";
import { ANONYMOUS, ANONYMOUS_LONG, type Caching, EVERYONE, PRIVATE } from "../src/mastodon/caching";
import { ROUTES } from "../src/mastodon/routes";
import { grants, type RequiredScope, SCOPES } from "../src/security/scopes";
import mastodon from "./fixtures/mastodon-4.7.5-api-access.json";
import { sameRoute, unroutedFailures } from "./mastodon-conformance";
import { UNROUTED } from "./mastodon-routes-exceptions";

// Every route of the API table (src/mastodon/routes.ts) asks of its caller what Mastodon's same route asks, read from
// Mastodon's source by scripts/mastodon-scopes.mjs (the fixture's header says how to regenerate it). Compared:
//   token   none (no token required: Kopje's public routes read none, its anonymous routes read one sent only for its
//           owner's suspension, as Mastodon's do), optional (a token sent is checked; Kopje's admin routes, behind the
//           admin gate, which "admin routes are gated" compares), required
//   scopes  the token scopes accepted (null: any valid token): Kopje's required scope with the scopes that cover it
//           (src/security/scopes.ts), Mastodon's doorkeeper list
//   user    whether a token without a user (an app token) is refused
// A route Mastodon does not have, or one that deliberately differs, is listed in EXCEPTIONS with both sides as compared
// and the reason; a change on either side (Kopje's routes or scope hierarchy, a regenerated fixture), or the difference
// going away, fails until the exception is revisited.

type Access = { token: "none" | "optional" | "required"; scopes: string[] | null; user: boolean };

type MastodonRoute = (typeof mastodon.routes)[number];

// Both sides as sides() writes them, and why they differ.
type Exception = { kopje: string; mastodon: string; reason: string };

// The collections routes under `prefix` (mastodon/collections.ts): R45 is the Store's (Mastodon: Pundit, unresolved),
// and in_collections answers a request without a user 422 whether or not it sent a token.
function collectionExceptions(prefix: string): Record<string, Exception> {
  const read = "optional token, scopes read read:collections, no user required";
  return {
    [`GET ${prefix}/accounts/:id/collections`]: {
      kopje: read,
      mastodon: `unresolved (Pundit policy: authorize @account, :index_collections?; verify_authorized): ${read}`,
      reason: "R45 is the Store's (Mastodon: Pundit AccountPolicy#index_collections?, unresolved)",
    },
    [`GET ${prefix}/accounts/:id/in_collections`]: {
      kopje: read,
      mastodon: "required token, scopes read read:collections, user required",
      reason:
        "authorize_if_got_token! then require_user!: without a token the answer is require_user!'s 422, not a 401, " +
        "which the handler gives (domain/collections.ts inCollections)",
    },
    [`GET ${prefix}/collections/:id`]: {
      kopje: read,
      mastodon: `unresolved (Pundit policy: authorize @collection, :show?; verify_authorized): ${read}`,
      reason: "R45 is the Store's (Mastodon: Pundit CollectionPolicy#show?, unresolved)",
    },
  };
}

const EXCEPTIONS: Record<string, Exception> = {
  // Not Mastodon /api routes.
  "POST /oauth/token": {
    kopje: "none token, scopes any, no user required",
    mastodon: "absent",
    reason: "Doorkeeper's token endpoint, outside /api",
  },
  "POST /oauth/revoke": {
    kopje: "none token, scopes any, no user required",
    mastodon: "absent",
    reason: "Doorkeeper's revocation endpoint, outside /api",
  },
  "GET /oauth/token/info": {
    kopje: "none token, scopes any, no user required",
    mastodon: "absent",
    reason: "Doorkeeper's TokenInfoController, outside /api: bearer authentication and errors handled locally",
  },
  "POST /oauth/introspect": {
    kopje: "none token, scopes any, no user required",
    mastodon: "absent",
    reason: "Doorkeeper's introspection endpoint, outside /api: client or bearer authentication in the handler",
  },
  "GET /.well-known/oauth-authorization-server": {
    kopje: "none token, scopes any, no user required",
    mastodon: "absent",
    reason: "WellKnown::OAuthMetadataController, not an API controller: public, it reads no token",
  },

  // Differences RouteAccess cannot express, enforced elsewhere or left open.
  "GET /api/v1/announcements": {
    kopje: "required token, scopes any, no user required",
    mastodon: "required token, scopes any, user required",
    reason:
      "any token at the route; announcements.listAnnouncements (tokenUserReadOperation) refuses one without a user",
  },
  "GET /api/v1/accounts/:id/identity_proofs": {
    kopje: "required token, scopes any, no user required",
    mastodon: "required token, scopes any, user required",
    reason: "any token at the route; placeholders.identityProofs refuses one without a user",
  },
  "POST /api/v1/accounts": {
    kopje: "required token, scopes any, no user required",
    mastodon: "required token, scopes write write:accounts, no user required",
    reason:
      'RouteAccess has no "scope without a user" form; accounts.register checks write:accounts, then that the token has no user',
  },
  "POST /api/v1/emails/confirmations": {
    kopje: "required token, scopes any, no user required",
    mastodon: "required token, scopes write write:accounts, no user required",
    reason:
      'RouteAccess has no "scope without a user" form; placeholders.resendConfirmation checks write:accounts, then refuses as Mastodon',
  },
  "GET /api/v1/statuses/:id/source": {
    kopje: "required token, scopes read read:statuses, user required",
    mastodon:
      "unresolved (Pundit policy: authorize @status, :show?): required token, scopes read read:statuses, no user required",
    reason: 'RouteAccess has no "scope without a user" form; Mastodon serves app tokens what StatusPolicy#show? allows',
  },
  "GET /api/v1/statuses/:id/quotes": {
    kopje: "required token, scopes read read:statuses, no user required",
    mastodon:
      "unresolved (Pundit policy: authorize @status, :show?): required token, scopes read read:statuses, no user required",
    reason: "visibility is the Store's (Mastodon: Pundit StatusPolicy#show?, unresolved)",
  },
  "POST /api/v1/statuses/:id/quotes/:quoting_status_id/revoke": {
    kopje: "required token, scopes write write:statuses, user required",
    mastodon:
      "unresolved (Pundit policy: authorize @quote, :revoke?; authorize @status, :show?): required token, scopes write write:statuses, no user required",
    reason:
      "only the quoted author may revoke (QuotePolicy#revoke?), and a token without a user is nobody’s; Kopje refuses it at the route",
  },
  "PUT /api/v1/statuses/:id/interaction_policy": {
    kopje: "required token, scopes write write:statuses, user required",
    mastodon:
      "unresolved (Pundit policy: authorize @status, :update?; authorize @status, :show?): required token, scopes write write:statuses, no user required",
    reason:
      "a token without a user owns no status, so StatusPolicy#update? refuses it there (403); Kopje refuses it at the route",
  },
  "PATCH /api/v1/statuses/:id/interaction_policy": {
    kopje: "required token, scopes write write:statuses, user required",
    mastodon:
      "unresolved (Pundit policy: authorize @status, :update?; authorize @status, :show?): required token, scopes write write:statuses, no user required",
    reason:
      "a token without a user owns no status, so StatusPolicy#update? refuses it there (403); Kopje refuses it at the route",
  },
  "GET /api/v1/donation_campaigns": {
    kopje: "optional token, scopes any, no user required",
    mastodon: "required token, scopes any, user required",
    reason:
      "require_user! with no doorkeeper check: an anonymous request reaches placeholders.donationCampaigns, which answers 422 without a user and 403 to a suspended one",
  },
  "POST /api/v1/accounts/:id/email_subscriptions": {
    kopje: "optional token, scopes any, no user required",
    mastodon: "none token, scopes any, no user required",
    reason:
      "no token is required, but Api::BaseController#require_not_suspended! reads a sent one: placeholders.emailSubscription answers a suspended user's token 403 and ignores any other",
  },
  "GET /api/v1/accounts/relationships": {
    kopje: "required token, scopes follow read read:follows, user required",
    mastodon: "required token, scopes read read:follows, user required",
    reason: "grants() lets `follow` cover read:follows everywhere; Mastodon omits follow here",
  },
  "GET /api/v1/accounts/familiar_followers": {
    kopje: "required token, scopes follow read read:follows, user required",
    mastodon: "required token, scopes read read:follows, user required",
    reason: "grants() lets `follow` cover read:follows everywhere; Mastodon omits follow here",
  },
  "POST /api/v1/statuses/:id/mute": {
    kopje: "required token, scopes follow write write:mutes, user required",
    mastodon: "required token, scopes write write:mutes, user required",
    reason: "grants() lets `follow` cover write:mutes everywhere; Mastodon omits follow here",
  },
  "POST /api/v1/statuses/:id/unmute": {
    kopje: "required token, scopes follow write write:mutes, user required",
    mastodon: "required token, scopes write write:mutes, user required",
    reason: "grants() lets `follow` cover write:mutes everywhere; Mastodon omits follow here",
  },

  // Mastodon's StatusPolicy#show? (Pundit) decides per viewer; Kopje's Store applies the visibility rules.
  ...collectionExceptions("/api/v1"),
  ...collectionExceptions("/api/v1_alpha"),
  "GET /api/v1/statuses/:id": {
    kopje: "optional token, scopes read read:statuses, no user required",
    mastodon:
      "unresolved (Pundit policy: authorize @status, :show?): optional token, scopes read read:statuses, no user required",
    reason: "visibility is the Store's (Mastodon: Pundit StatusPolicy#show?, unresolved)",
  },
  "GET /api/v1/polls/:id": {
    kopje: "optional token, scopes read read:statuses, no user required",
    mastodon:
      "unresolved (Pundit policy: authorize @poll.status, :show?): optional token, scopes read read:statuses, no user required",
    reason: "visibility of the poll's status is the Store's (Mastodon: Pundit StatusPolicy#show?, unresolved)",
  },
  "GET /api/v1/statuses/:id/context": {
    kopje: "optional token, scopes read read:statuses, no user required",
    mastodon:
      "unresolved (Pundit policy: authorize @status, :show?): optional token, scopes read read:statuses, no user required",
    reason: "visibility is the Store's (Mastodon: Pundit StatusPolicy#show?, unresolved)",
  },
  "GET /api/v1/statuses/:id/history": {
    kopje: "optional token, scopes read read:statuses, no user required",
    mastodon:
      "unresolved (Pundit policy: authorize @status, :show?): optional token, scopes read read:statuses, no user required",
    reason: "visibility is the Store's (Mastodon: Pundit StatusPolicy#show?, unresolved)",
  },
  "GET /api/v1/statuses/:id/favourited_by": {
    kopje: "optional token, scopes read read:accounts, no user required",
    mastodon:
      "unresolved (Pundit policy: authorize @status, :show?): optional token, scopes read read:accounts, no user required",
    reason: "visibility is the Store's (Mastodon: Pundit StatusPolicy#show?, unresolved)",
  },
  "GET /api/v1/statuses/:id/reblogged_by": {
    kopje: "optional token, scopes read read:accounts, no user required",
    mastodon:
      "unresolved (Pundit policy: authorize @status, :show?): optional token, scopes read read:accounts, no user required",
    reason: "visibility is the Store's (Mastodon: Pundit StatusPolicy#show?, unresolved)",
  },

  // Deliberate choices.
  "GET /api/v1/accounts/lookup": {
    kopje: "none token, scopes any, no user required",
    mastodon: "optional token, scopes read read:accounts, no user required",
    reason: "anonymous: a token sent is read only for its owner's suspension (access.ts); Mastodon checks a token sent",
  },
  "GET /api/v1/accounts/:id": {
    kopje: "none token, scopes any, no user required",
    mastodon: "optional token, scopes read read:accounts, no user required",
    reason: "anonymous: a token sent is read only for its owner's suspension (access.ts); Mastodon checks a token sent",
  },
  "GET /api/v1/accounts": {
    kopje: "none token, scopes any, no user required",
    mastodon: "optional token, scopes read read:accounts, no user required",
    reason: "anonymous, as GET /api/v1/accounts/:id, whose accounts it shows (access.ts); Mastodon checks a token sent",
  },
  "GET /api/v2/search": {
    kopje: "required token, scopes read read:search, user required",
    mastodon: "optional token, scopes read read:search, no user required",
    reason: "anonymous search is refused (routes.ts); Mastodon allows it without resolve or offset",
  },
  "GET /api/v1/timelines/public": {
    kopje: "optional token, scopes read read:statuses, no user required",
    mastodon:
      'unresolved (require_user! if: "require_auth?"): required token, scopes read read:statuses, user required',
    reason: "open to anonymous callers; Mastodon requires a user if its feed setting says so",
  },
  "GET /api/v1/timelines/link": {
    kopje: "optional token, scopes read read:statuses, no user required",
    mastodon:
      'unresolved (require_user! if: "require_auth?"): required token, scopes read read:statuses, user required',
    reason: "open to anonymous callers; Mastodon requires a user if its feed setting says so",
  },
  "GET /api/v1/timelines/tag/:hashtag": {
    kopje: "optional token, scopes read read:statuses, no user required",
    mastodon:
      'unresolved (require_user! if: "require_auth?"): required token, scopes read read:statuses, user required',
    reason: "open to anonymous callers; Mastodon requires a user if its feed setting says so",
  },
};

// The scopes a token may hold to pass the route's scope: every scope Kopje issues that covers it (any one of them if
// the route names several).
function acceptedScopes(required: RequiredScope, covers = grants): string[] {
  const any = typeof required === "string" ? [required] : required;
  return SCOPES.filter((s) => any.some((scope) => covers([s], scope))).toSorted();
}

function kopjeAccess(access: RouteAccess, covers = grants): Access {
  if (access === "public" || access === "anonymous") {
    return { token: "none", scopes: null, user: false };
  }
  if (access === "token") {
    return { token: "required", scopes: null, user: false };
  }
  const scopes = access.scope === undefined ? null : acceptedScopes(access.scope, covers);
  if (access.optional === true || access.admin === true) {
    return { token: "optional", scopes, user: false };
  }
  return { token: "required", scopes, user: access.app !== true };
}

function mastodonAccess(route: MastodonRoute): Access {
  return {
    token: route.token as Access["token"],
    scopes: route.scopes === null ? null : route.scopes.toSorted(),
    user: route.user,
  };
}

// Mastodon's route for a method and path, its parameters matched whatever their names.
function mastodonRoute(method: string, path: string): MastodonRoute | undefined {
  return sameRoute(mastodon.routes, method, path);
}

const show = (access: Access) =>
  `${access.token} token, scopes ${access.scopes?.join(" ") ?? "any"}, ${access.user ? "user required" : "no user required"}`;

const ADMIN_PATH = /^\/api\/v[12]\/admin\//;

// What is left unresolved of a Mastodon route once a role policy of the admin API is set aside: on /api/v{1,2}/admin/*
// a single Pundit authorize with verify_authorized decides by the caller's role (its permission bits), which Kopje
// decides in the Store (adminReadOperation, domain/auth.ts) or answers alike to everyone (mastodon/admin.ts), so the
// token, scopes and user are compared as read. Anything else unresolved stays.
function unresolvedOf(route: MastodonRoute): string[] | undefined {
  const role = ADMIN_PATH.test(route.path)
    ? (reason: string) => /^Pundit policy: authorize [^;]+; verify_authorized$/.test(reason)
    : () => false;
  const left = route.unresolved?.filter((reason) => !role(reason));
  return left === undefined || left.length === 0 ? undefined : left;
}

// Both sides of a route as compared: Kopje's, and Mastodon's ('absent', or marked unresolved when it could not be read).
// covers stands in for grants() in the check that the comparison sees a scope grants() lets through.
function sides(route: (typeof ROUTES)[number], covers = grants) {
  const kopje = show(kopjeAccess(route.access, covers));
  const theirs = mastodonRoute(route.method, route.path);
  if (theirs === undefined) {
    return { kopje, mastodon: "absent", source: `no such route in Mastodon v${mastodon.mastodon}` };
  }
  const access = show(mastodonAccess(theirs));
  const unresolved = unresolvedOf(theirs);
  return {
    kopje,
    mastodon: unresolved === undefined ? access : `unresolved (${unresolved.join("; ")}): ${access}`,
    source: `${theirs.controller}#${theirs.action}`,
  };
}

const describeSides = (name: string, { kopje, mastodon, source }: ReturnType<typeof sides>) =>
  `${name}\n  Kopje:    ${kopje}\n  Mastodon: ${mastodon} (${source})`;

// A route's two sides against its exception, if any: a difference needs one, and one must still describe the difference.
function compareSides(name: string, now: ReturnType<typeof sides>, exception: Exception | undefined, table: string) {
  if (exception === undefined) {
    if (now.kopje !== now.mastodon) {
      expect.fail(`${describeSides(name, now)}\nMatch Mastodon, or add the route to ${table} with the reason.`);
    }
    return;
  }
  if (now.kopje === now.mastodon) {
    expect.fail(`${name} matches Mastodon now: remove its exception (${exception.reason})`);
  }
  if (now.kopje !== exception.kopje || now.mastodon !== exception.mastodon) {
    expect.fail(
      `${describeSides(name, now)}\nThe exception was written for\n  Kopje:    ${exception.kopje}\n` +
        `  Mastodon: ${exception.mastodon}\nRevisit it (${exception.reason}).`,
    );
  }
}

describe(`route access matches Mastodon v${mastodon.mastodon}`, () => {
  it.each(ROUTES.map((route) => [`${route.method} ${route.path}`, route] as const))("%s", (name, route) =>
    compareSides(name, sides(route), EXCEPTIONS[name], "EXCEPTIONS"),
  );

  // AUTH-2: a route under /api/ reads a token sent at least for its owner's suspension (require_not_suspended!), but
  // the five instance reads whose Mastodon controllers read a user only in limited federation mode; the OAuth and
  // /.well-known routes, outside Mastodon's API controllers, read none either.
  it("reads a sent token on every /api route but the five instance reads", () => {
    const unread = ROUTES.filter((route) => route.access === "public").map((route) => `${route.method} ${route.path}`);
    expect(unread).toEqual([
      "POST /oauth/token",
      "POST /oauth/revoke",
      "GET /oauth/token/info",
      "POST /oauth/introspect",
      "GET /.well-known/oauth-authorization-server",
      "GET /api/v1/instance",
      "GET /api/v2/instance",
      "GET /api/v1/instance/rules",
      "GET /api/v1/instance/peers",
      "GET /api/v1/instance/extended_description",
    ]);
    expect(ROUTES.filter((route) => route.access === "anonymous")).toHaveLength(14);
  });

  // VIS-29's gate: the routes Mastodon guards with Admin::PermissionsConcern (the fixture's
  // require_moderator_or_admin_permissions) are those whose access is the admin kind (mastodon/access.ts), which
  // answers anyone but the OAuth admin 403 Forbidden first.
  it("gates exactly the routes Mastodon's Admin::PermissionsConcern guards", () => {
    const guarded = mastodon.routes
      .filter((route) => (route.guards ?? []).includes("require_moderator_or_admin_permissions"))
      .map((route) => `${route.method} ${route.path}`);
    expect(guarded).toHaveLength(63);
    const gated = ROUTES.filter((route) => typeof route.access === "object" && route.access.admin === true).map(
      (route) => `${route.method} ${mastodonRoute(route.method, route.path)?.path ?? route.path}`,
    );
    expect(gated.toSorted()).toEqual(guarded.toSorted());
  });

  it("lists exceptions only for routes of the table", () => {
    const names = new Set(ROUTES.map((route) => `${route.method} ${route.path}`));
    expect(Object.keys(EXCEPTIONS).filter((name) => !names.has(name))).toEqual([]);
  });

  it("routes every route of Mastodon, or lists why not", () => {
    // A tripwire for a generator that loses routes, which this check cannot otherwise see.
    expect(mastodon.routes.filter((route) => ADMIN_PATH.test(route.path))).toHaveLength(63);
    expect(unroutedFailures(mastodon.mastodon, mastodon.routes, ROUTES, UNROUTED)).toEqual([]);
  });

  it("sees a route Kopje lacks, an exception for a routed route, and one for no route", () => {
    const theirs = [
      { method: "GET", path: "/api/v1/things/:thing_id", controller: "api/v1/things", action: "show" },
      { method: "POST", path: "/api/v1/things", controller: "api/v1/things", action: "create" },
      { method: "DELETE", path: "/api/v1/things/:id", controller: "api/v1/things", action: "destroy" },
    ];
    const ours = [
      { method: "GET", path: "/api/v1/things/:id" },
      { method: "POST", path: "/api/v1/things" },
      { method: "GET", path: "/api/v1/other" },
    ];
    const gap = { status: "open", issue: 1, note: "n" } as const;
    // A differently named path parameter is the same route.
    expect(unroutedFailures("9.9.9", theirs, ours, { "DELETE /api/v1/things/:id": gap })).toEqual([]);
    expect(unroutedFailures("9.9.9", theirs, ours, { "POST /api/v1/things": gap, "GET /api/v1/gone": gap })).toEqual([
      "DELETE /api/v1/things/:id (api/v1/things#destroy): Mastodon v9.9.9 serves it and Kopje does not route it " +
        "(route it, or list it in UNROUTED with its gap issue or MD id)",
      "POST /api/v1/things: routed now; remove its exception",
      "GET /api/v1/gone: not a route of the fixture; remove its exception",
    ]);
  });

  it("sets aside only an admin route's role policy, so its scope is still compared", () => {
    const show = ROUTES.find((route) => route.method === "GET" && route.path === "/api/v1/admin/accounts/:id");
    expect(show).toBeDefined();
    expect(mastodonRoute("GET", "/api/v1/admin/accounts/:id")?.unresolved).toHaveLength(1);
    const { kopje, mastodon: theirs } = sides(show!);
    expect(kopje).toBe(theirs);
    // A broader scope than Mastodon's is seen.
    expect(sides({ ...show!, access: { scope: "admin:read", optional: true } }).kopje).not.toBe(theirs);
    // A required token is seen.
    expect(sides({ ...show!, access: { scope: "admin:read:accounts" } }).kopje).not.toBe(theirs);
    // The same policy outside the admin API stays unresolved (StatusPolicy#show? has its exception).
    expect(
      sides(ROUTES.find((route) => route.method === "GET" && route.path === "/api/v1/statuses/:id")!).mastodon,
    ).toMatch(/^unresolved \(Pundit policy/);
  });

  it("reads the scopes a route accepts through the scope hierarchy", () => {
    expect(acceptedScopes("read:statuses")).toEqual(["read", "read:statuses"]);
    expect(acceptedScopes("write:blocks")).toEqual(["follow", "write", "write:blocks"]);
    expect(acceptedScopes("admin:read:accounts")).toEqual(["admin:read", "admin:read:accounts"]);
    expect(acceptedScopes("push")).toEqual(["push"]);
    expect(acceptedScopes("profile")).toEqual(["profile"]);
    expect(acceptedScopes(["profile", "read:accounts"])).toEqual(["profile", "read", "read:accounts"]);
  });

  it("sees a scope the hierarchy wrongly lets through", () => {
    const bookmarks = ROUTES.find((route) => route.method === "GET" && route.path === "/api/v1/bookmarks");
    expect(bookmarks).toBeDefined();
    const { kopje, mastodon } = sides(bookmarks!);
    expect(kopje).toBe(mastodon);
    const leaky: typeof grants = (granted, required) =>
      grants(granted, required) || (granted.includes("push") && required === "read:bookmarks");
    expect(sides(bookmarks!, leaky).kopje).toBe(mastodon.replace("scopes read", "scopes push read"));
  });
});

// WEB-7: each route's caching declaration (src/mastodon/caching.ts) as Mastodon's same route sets it, read from its
// source into the fixture's `cache`: `public`, the helper the action runs (anonymous: cache_if_unauthenticated!, 15 s
// to a request without a user; everyone: cache_even_if_authenticated!, 5 min to every request; private: neither), and
// `vary`, its vary_by. Kopje's declaration is shown in the same terms; its 5 minutes to a request without
// Authorization (ANONYMOUS_LONG) is no helper of Mastodon's, so a route declaring it is always an exception. As for
// access, a difference is listed in CACHING_EXCEPTIONS with both sides and the reason.

type MastodonCaching = { public: string | null; vary: string | null; unresolved?: string[] };

const showCaching = (shared: string, vary: string | null) => `${shared}, vary ${vary ?? "none"}`;

function kopjeCaching(caching: Caching): string {
  if (caching.shared === null) {
    return showCaching("private", caching.vary);
  }
  const { to, control } = caching.shared;
  const seconds = Number(/^max-age=(\d+),/.exec(control)?.[1]);
  const helper =
    to === "anonymous" && seconds === 15 ? "anonymous" : to === "everyone" && seconds === 300 ? "everyone" : null;
  return showCaching(helper ?? `${to} for ${seconds} s`, caching.vary);
}

function mastodonCaching(cache: MastodonCaching): string {
  const shown = showCaching(cache.public ?? "private", cache.vary);
  return cache.unresolved === undefined ? shown : `unresolved (${cache.unresolved.join("; ")}): ${shown}`;
}

const READS_TOKEN =
  "reads the token: a suspended owner's 403 (AUTH-2) and any token's answer stay out of shared caches (WEB-7)";
const LONG = "anonymous for 300 s, vary Authorization";
const EVERYONE_NO_VARY = "everyone, vary none";
// Mastodon's admin trend lists fall back to the public lists (`super`, which runs cache_if_unauthenticated!) for a
// caller without manage_taxonomies; Kopje's admin gate answers anyone but the OAuth admin 403 first (VIS-29).
const ADMIN_FALLBACK = "unresolved (cache_if_unauthenticated! under a condition)";
const ADMIN_LIST_REASON =
  "the admin gate refuses every caller Mastodon's public fallback serves (VIS-29), so the answer is never public";
const REVIEW_REASON =
  "Mastodon's review actions inherit the public trend list's vary_by; Kopje answers them 403 to everyone (MD-2)";

const CACHING_EXCEPTIONS: Record<string, Exception> = {
  "GET /api/v1/custom_emojis": {
    kopje: LONG,
    mastodon:
      "unresolved (app/controllers/api/v1/custom_emojis_controller.rb: `vary_by '', unless: " +
      ":disallow_unauthenticated_api_access?`; cache_even_if_authenticated! under a condition): private, vary none",
    reason: `${READS_TOKEN}; Mastodon's caching depends on a setting Kopje lacks (unauthenticated API access)`,
  },
  "GET /api/v1/instance/languages": { kopje: LONG, mastodon: EVERYONE_NO_VARY, reason: READS_TOKEN },
  "GET /api/v1/instance/privacy_policy": { kopje: LONG, mastodon: EVERYONE_NO_VARY, reason: READS_TOKEN },
  "GET /api/v1/instance/terms_of_service": { kopje: LONG, mastodon: EVERYONE_NO_VARY, reason: READS_TOKEN },
  "GET /api/v1/instance/terms_of_service/:date": { kopje: LONG, mastodon: EVERYONE_NO_VARY, reason: READS_TOKEN },
  "GET /api/v1/instance/translation_languages": { kopje: LONG, mastodon: EVERYONE_NO_VARY, reason: READS_TOKEN },
  "GET /api/v1/instance/activity": { kopje: LONG, mastodon: EVERYONE_NO_VARY, reason: READS_TOKEN },
  "GET /api/v1/peers/search": { kopje: LONG, mastodon: EVERYONE_NO_VARY, reason: READS_TOKEN },
  "GET /api/v1/instance/domain_blocks": {
    kopje: LONG,
    mastodon:
      "unresolved (app/controllers/api/v1/instances/domain_blocks_controller.rb: `vary_by '', if: -> { " +
      "Setting.show_domain_blocks == 'all' }`; cache_even_if_authenticated! under a condition; " +
      "cache_if_unauthenticated! under a condition): private, vary none",
    reason:
      `${READS_TOKEN}; Mastodon's caching depends on show_domain_blocks, and with users only (or comments to users ` +
      "only) the answer depends on the token too",
  },
  "GET /api/v1/admin/trends/tags": {
    kopje: "private, vary Authorization",
    mastodon: `${ADMIN_FALLBACK}: private, vary Authorization`,
    reason: ADMIN_LIST_REASON,
  },
  "GET /api/v1/admin/trends/links": {
    kopje: "private, vary Authorization, Accept-Language",
    mastodon: `${ADMIN_FALLBACK}: private, vary Authorization, Accept-Language`,
    reason: ADMIN_LIST_REASON,
  },
  "GET /api/v1/admin/trends/statuses": {
    kopje: "private, vary Authorization, Accept-Language",
    mastodon: `${ADMIN_FALLBACK}: private, vary Authorization, Accept-Language`,
    reason: ADMIN_LIST_REASON,
  },
  "POST /api/v1/admin/trends/links/:id/approve": {
    kopje: "private, vary Authorization",
    mastodon: "private, vary Authorization, Accept-Language",
    reason: REVIEW_REASON,
  },
  "POST /api/v1/admin/trends/links/:id/reject": {
    kopje: "private, vary Authorization",
    mastodon: "private, vary Authorization, Accept-Language",
    reason: REVIEW_REASON,
  },
  "POST /api/v1/admin/trends/statuses/:id/approve": {
    kopje: "private, vary Authorization",
    mastodon: "private, vary Authorization, Accept-Language",
    reason: REVIEW_REASON,
  },
  "POST /api/v1/admin/trends/statuses/:id/reject": {
    kopje: "private, vary Authorization",
    mastodon: "private, vary Authorization, Accept-Language",
    reason: REVIEW_REASON,
  },
};

// Both sides of a route's caching as compared, or undefined for a route Mastodon does not have.
function cachingSides(route: (typeof ROUTES)[number]) {
  const theirs = mastodonRoute(route.method, route.path);
  if (theirs === undefined) {
    return undefined;
  }
  return {
    kopje: kopjeCaching(route.caching),
    mastodon: mastodonCaching(theirs.cache),
    source: `${theirs.controller}#${theirs.action}`,
  };
}

describe(`route caching matches Mastodon v${mastodon.mastodon}`, () => {
  const compared = ROUTES.flatMap((route) => {
    const now = cachingSides(route);
    return now === undefined ? [] : [[`${route.method} ${route.path}`, now] as const];
  });

  it.each(compared)("%s", (name, now) => compareSides(name, now, CACHING_EXCEPTIONS[name], "CACHING_EXCEPTIONS"));

  it("declares nothing public on a route Mastodon does not have", () => {
    const absent = ROUTES.filter((route) => cachingSides(route) === undefined);
    expect(absent.map((route) => `${route.method} ${route.path}`)).toEqual(
      Object.entries(EXCEPTIONS)
        .filter(([, exception]) => exception.mastodon === "absent")
        .map(([name]) => name),
    );
    for (const route of absent) {
      expect(route.caching, `${route.method} ${route.path}`).toBe(PRIVATE);
    }
  });

  it("lists caching exceptions only for routes compared", () => {
    const names = new Set<string>(compared.map(([name]) => name));
    expect(Object.keys(CACHING_EXCEPTIONS).filter((name) => !names.has(name))).toEqual([]);
  });

  it("reads the caching of every route Mastodon has", () => {
    // A tripwire for a generator that loses the field.
    expect(mastodon.routes.filter((route) => !("cache" in route))).toEqual([]);
    expect(mastodon.routes.filter((route) => route.cache.public !== null)).toHaveLength(40);
  });

  it("sees a declaration moved to or from ANONYMOUS_LONG, and one public to the wrong callers", () => {
    const languages = ROUTES.find((route) => route.path === "/api/v1/instance/languages")!;
    const timeline = ROUTES.find((route) => route.path === "/api/v1/timelines/public")!;
    // Moved off ANONYMOUS_LONG, the route would match and its exception would fail as stale.
    expect(cachingSides({ ...languages, caching: EVERYONE })?.kopje).toBe(EVERYONE_NO_VARY);
    expect(cachingSides(languages)?.kopje).toBe(LONG);
    // Moved onto it, or made public to everyone, a matching route differs.
    expect(cachingSides({ ...timeline, caching: ANONYMOUS_LONG })?.kopje).not.toBe(cachingSides(timeline)?.mastodon);
    expect(cachingSides({ ...timeline, caching: EVERYONE })?.kopje).not.toBe(cachingSides(timeline)?.mastodon);
    expect(cachingSides(timeline)).toMatchObject({ kopje: kopjeCaching(ANONYMOUS), mastodon: kopjeCaching(ANONYMOUS) });
  });
});
