import { createMiddleware } from "hono/factory";

import type { RequiredScope } from "../security/scopes";
import { sha256Hex } from "../security/tokens";
import { noteActivitySoon } from "./activity";
import { type ApiDeps, type ApiEnv, storeCall, suspendedError } from "./context";
import { invalidTokenError } from "./errors";

// What a route requires of the caller:
//   public    : no token is read (credential null): outside /api (OAuth, /.well-known), whose handlers read their own
//               credentials, and the five instance reads where Mastodon reads no user (AUTH-2), so a suspended
//               owner's token gets what no token gets
//   anonymous : no token is required, and a token sent is read only for its owner's suspension (AUTH-2, Mastodon's
//               Api::BaseController#require_not_suspended! on a route that needs no token): every answer to a
//               request whose token's owner is suspended is the 403, and any other token changes nothing, so a stale
//               token a client still sends does not break the call
//   token     : any valid token, app tokens included
//   scope     : a token covering the scope (any one of them if several) and bound to a user
//   scope, app : a token covering the scope; an app token (no user) reads as anonymous (Mastodon's
//                doorkeeper_authorize! without require_user!)
//   scope, optional : no token reads as anonymous; a token sent must be valid and cover the scope, and an app token
//                     reads as anonymous (Mastodon's authorize_if_got_token!)
//   optional        : the same with no scope: a token sent must be valid, whatever its scopes (Mastodon's reads that
//                     declare no doorkeeper scope but use the current user)
export type RouteAccess =
  | "public"
  | "anonymous"
  | "token"
  | { scope: RequiredScope; optional?: true; app?: never }
  | { scope: RequiredScope; app: true; optional?: never }
  | { scope?: never; optional: true; app?: never };

// The one middleware that reads the bearer token and declares the route's scope for every API route. It does not
// validate the token: the Store does, in the transaction of the operation the request performs (domain/auth.ts).
// After a response below 400 to a request with a token, the token's activity is recorded (mastodon/activity.ts); an
// anonymous route records none.
//
// An anonymous route with a token: its credential has no scope, and its owner is judged once. An operation that can
// write judges it first in its own transaction (refuseSuspended), as do the hot reads' operations, which mark the
// request (judged in context.ts); any answer not so marked, an early 4xx or a thrown error's included, is judged here
// after the handler with one Store call (checkNotSuspended) and replaced by the 403, with none of its headers, when
// the owner is suspended.
export function requireAccess(access: RouteAccess, deps: Pick<ApiDeps, "build" | "store" | "now" | "activity">) {
  return createMiddleware<ApiEnv>(async (c, next) => {
    if (access === "public") {
      c.set("credential", null);
      return next();
    }
    const token = bearerToken(c.req.header("authorization"));
    if (access === "anonymous") {
      if (token === undefined) {
        c.set("credential", null);
        return next();
      }
      const tokenHash = await sha256Hex(token);
      c.set("credential", { tokenHash, scope: null });
      c.set("ownerJudged", false);
      await next();
      if (!c.get("ownerJudged")) {
        const credential = { tokenHash, scope: null, now: deps.now() };
        const judgment = await storeCall(c, deps, (s, b) => s.checkNotSuspended(b, credential));
        if (judgment.status === "suspended") {
          // Unset first: Hono's setter copies the replaced answer's headers (Cache-Control among them) onto the new.
          c.res = undefined;
          c.res = suspendedError();
        }
      }
      return;
    }
    if (token === undefined) {
      if (typeof access === "object" && access.optional === true) {
        c.set("credential", null);
        return next();
      }
      return invalidTokenError();
    }
    const tokenHash = await sha256Hex(token);
    c.set("credential", { tokenHash, scope: access === "token" ? null : (access.scope ?? null) });
    await next();
    if (c.res.status < 400) {
      noteActivitySoon(c, deps, tokenHash);
    }
  });
}

export function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  return match?.[1];
}
