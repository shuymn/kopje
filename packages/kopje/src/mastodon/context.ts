import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";

import type { PresentInput } from "../domain/accounts";
import type { StoredKey } from "../domain/actors";
import type { AuthFailure, Authorized, Credential, Suspended, UserCredential } from "../domain/auth";
import type { ResolutionStart } from "../domain/inbox";
import type { AddressResolver } from "../domain/mention-addresses";
import type { PollReservation } from "../domain/polls";
import type { RemoteStatusInput } from "../domain/remote-status-reads";
import type { Resolved } from "../domain/remote-statuses";
import { webPushKeys } from "../platform/config";
import { errorFields } from "../platform/error-message";
import type { ImageCodec } from "../platform/images";
import type { MediaProcessorClient } from "../platform/media-transcoder";
import { callStore, type StoreResolver, type StoreStub } from "../platform/store-client";
import type { RequiredScope } from "../security/scopes";
import type { TokenGenerator } from "../security/tokens";
import type { ActivityMemo } from "./activity";
import type { ApiHeadersEnv } from "./caching";
import { INVALID_TOKEN, invalidTokenError, mastodonError } from "./errors";
import { type Params, type ReadOptions, readParams } from "./params";

export type ApiDeps = {
  build: (env: Env) => string;
  now: () => number;
  store: StoreResolver;
  // Generates client ids and secrets, codes and access tokens, and media file tokens.
  randomToken: TokenGenerator;
  // Re-encodes uploaded images (the Images binding in production).
  images: (env: Env) => ImageCodec;
  // Fetches a URL or user@domain for search with resolve=true (federation/resolve.ts), from what the resolution gate
  // answered; none: answered locally.
  resolve?: (env: Env, query: string, start?: ResolutionStart) => Promise<Resolved>;
  // Resolves the unknown mention addresses of a post or an edit (federation/resolve.ts createAddressResolver), from what
  // its mention gate answered; none: they stay text.
  resolveAddresses?: AddressResolver;
  // Fetches the document of a remote poll's status for its refresh on read (federation/poll-refresh.ts), after the
  // Store reserved the attempt; none: polls are not refreshed.
  fetchPoll?: (env: Env, reservation: PollReservation) => Promise<RemoteStatusInput | null>;
  // Asks the Queue for a round of the Store's jobs (a resolved status's quote to verify); cron runs one regardless.
  requestJobs?: (env: Env) => Promise<unknown>;
  // LD-signs an activity as a local author with their wrapped key (a revoke's stamp Delete, the Delete of a public or
  // unlisted status; federation/ld-sign.ts); none: revokes and DELETEs that need a signature answer 503.
  signAsAuthor?: (env: Env, sign: AuthorSignature) => Promise<Record<string, unknown>>;
  // The isolate's memo of recorded activity (mastodon/activity.ts); none: no activity is recorded.
  activity?: ActivityMemo;
  // The media processor (src/media-processor.ts), null without its binding; none: video and audio uploads are
  // inactive.
  mediaProcessor?: (env: Env) => MediaProcessorClient | null;
  // Resolves `ms` later on the route's clock (the v1 upload's waits and cuts, mastodon/media-av.ts); none: a timer.
  // An aborted `signal` cancels the wait, which then never resolves.
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export type AuthorSignature = { activity: Record<string, unknown>; keyId: string; key: StoredKey };

// The bearer token's digest and the scope the route declares, set by the access middleware (mastodon/access.ts) on
// every API route: null on a public route. It is not validated there; the Store validates it in the operation. admin:
// the route is the admin API's, whose every answer passes the admin gate first (checkAdminCredential).
type RequestCredential = { tokenHash: string; scope: RequiredScope | null; admin?: true };

// ownerJudged: on an anonymous route with a token, whether an operation judged the token's owner (judged), so the
// access middleware does not judge the answer again. caching, deprecation, suspendedAnswer: mastodon/caching.ts.
export type ApiEnv = {
  Bindings: Env;
  Variables: { credential: RequestCredential | null; ownerJudged: boolean } & ApiHeadersEnv["Variables"];
};

export type ApiContext = Context<ApiEnv>;

export type ApiHandler = (c: ApiContext, deps: ApiDeps) => Promise<Response>;

// One Store RPC with the caller's build; maintenance refusals become StoreUnavailableError (503 in onError).
// Typed by the callback so the RPC result types (unions of promises) come through as their awaited values.
export function storeCall<F extends (store: StoreStub, build: string) => unknown>(
  c: { env: Env },
  deps: Pick<ApiDeps, "build" | "store">,
  call: F,
): Promise<Awaited<ReturnType<F>>> {
  type Result = Awaited<ReturnType<F>>;
  return callStore(() => Promise.resolve(call(deps.store(c.env), deps.build(c.env))) as Promise<Result>);
}

export function present(c: Context): PresentInput {
  return { origin: new URL(c.req.url).origin };
}

// The credential of a route that declares a token (scope null) or a scope. Its `now` is the time the Store judges
// expiry by, so handlers take it immediately before the Store call, after the request body has been read: a slow
// body must not carry a token past its expiry.
export function credential(c: ApiContext, deps: Pick<ApiDeps, "now">): Credential {
  const value = c.get("credential");
  if (value === null) {
    throw authError("unauthenticated");
  }
  return { tokenHash: value.tokenHash, scope: value.scope, now: deps.now() };
}

// The credential of a route that declares a scope, which a user-bound operation of the Store takes.
export function userCredential(c: ApiContext, deps: Pick<ApiDeps, "now">): UserCredential {
  const value = credential(c, deps);
  if (value.scope === null) {
    throw new Error("route declares no scope for a user operation");
  }
  return { ...value, scope: value.scope };
}

// The credential of a route whose token is optional: null when the request sent none.
export function optionalCredential(c: ApiContext, deps: Pick<ApiDeps, "now">): UserCredential | null {
  return c.get("credential") === null ? null : userCredential(c, deps);
}

// The credential of a route whose token is optional and declares no scope: null when the request sent none.
export function optionalTokenCredential(c: ApiContext, deps: Pick<ApiDeps, "now">): Credential | null {
  return c.get("credential") === null ? null : credential(c, deps);
}

const AUTH_ERRORS: Record<AuthFailure["status"], { status: 401 | 403 | 422; message: string }> = {
  unauthenticated: { status: 401, message: INVALID_TOKEN },
  suspended: { status: 403, message: "Your login is currently disabled" },
  insufficient_scope: { status: 403, message: "This action is outside the authorized scopes" },
  user_required: { status: 422, message: "This method requires an authenticated user" },
  admin_forbidden: { status: 403, message: "Forbidden" },
  forbidden: { status: 403, message: "This action is not allowed" },
};

// The value of an authorized Store operation; an authorization failure becomes Mastodon's error answer.
export function authorized<O>(result: Authorized<O>): O {
  if (result.status !== "ok") {
    throw authError(result.status);
  }
  return result.value;
}

// The answer of an anonymous route's operation that judged the token's owner (refuseSuspended, domain/auth.ts): the
// request is marked judged, and a suspended owner's answer is the 403.
export function judged<R extends { status: string }>(c: ApiContext, result: R | Suspended): Exclude<R, Suspended> {
  c.set("ownerJudged", true);
  if (result.status === "suspended") {
    throw authError("suspended");
  }
  return result as Exclude<R, Suspended>;
}

// A suspended owner's 403, in place of any answer of an anonymous route (mastodon/access.ts).
export function suspendedError(): Response {
  const { status, message } = AUTH_ERRORS.suspended;
  return mastodonError(status, message);
}

// The admin gate's 403, the answer of an admin route to a request without a token (mastodon/access.ts).
export function adminForbiddenError(): Response {
  const { status, message } = AUTH_ERRORS.admin_forbidden;
  return mastodonError(status, message);
}

// AUTH-2's 403 to a suspended owner's token, thrown by an operation's judgment: the app's error handler marks its
// answer (mastodon/caching.ts markSuspendedAnswer).
export class SuspendedRefusal extends HTTPException {}

// The error answer to an authorization failure, carried to the app's error handler; an invalid token's carries its
// Bearer challenge.
function authError(failure: AuthFailure["status"]): HTTPException {
  const { status, message } = AUTH_ERRORS[failure];
  if (failure === "suspended") {
    return new SuspendedRefusal(status, { message });
  }
  return new HTTPException(status, {
    message,
    ...(failure === "unauthenticated" ? { res: invalidTokenError() } : {}),
  });
}

// A request error the Worker found before calling the Store. Mastodon authenticates first, so a request with a bad
// token is answered as unauthenticated even when its parameters are wrong too; on an admin route, the admin gate
// comes first (checkAdminCredential).
export async function refuseAfterAuth(c: ApiContext, deps: ApiDeps, response: Response): Promise<Response> {
  const sent = c.get("credential");
  if (sent?.admin === true) {
    await checkAdminCredential(c, deps);
  } else if (sent !== null) {
    const value = credential(c, deps);
    authorized(await storeCall(c, deps, (s, b) => s.checkCredential(b, value)));
  }
  return response;
}

// The admin gate (domain/auth.ts adminGate, VIS-29), which every answer an admin handler gives before or without its
// admin operation passes first: anyone but the OAuth admin is refused (403 Forbidden, after the suspension's 403),
// then the OAuth admin's token must be valid and cover the route's scope. The access middleware answers a request
// without a token, with no Store call.
export async function checkAdminCredential(c: ApiContext, deps: Pick<ApiDeps, "build" | "store" | "now">) {
  const value = userCredential(c, deps);
  authorized(await storeCall(c, deps, (s, b) => s.checkAdminCredential(b, value)));
}

// A handler given the request's parameters, or the error answer for an unreadable body (after authentication, as
// Mastodon orders it). The handler still takes its credential in its body, right before the Store call.
export function withParams(
  handler: (c: ApiContext, deps: ApiDeps, p: Params) => Promise<Response>,
  options: ReadOptions = {},
): ApiHandler {
  return async (c, deps) => {
    const result = await readParams(c.req.raw, options);
    if (!result.ok) {
      return refuseAfterAuth(
        c,
        deps,
        mastodonError(result.status, result.status === 413 ? "Request body is too large" : "Malformed request body"),
      );
    }
    return handler(c, deps, result.params);
  };
}

// The Web Push application server key clients subscribe with; empty until VAPID_JWK is set.
export function vapidKey(env: Env): string {
  return webPushKeys(env)?.publicKey ?? "";
}

// What runs after the response needs of the request: its bindings and its execution context.
export type AfterResponse = { env: Env; executionCtx: Pick<ExecutionContext, "waitUntil"> };

// Runs `work` after the response; the execution context keeps it alive.
export function afterResponse(c: AfterResponse, work: Promise<unknown>): void {
  try {
    c.executionCtx.waitUntil(work);
  } catch {
    // No execution context (not reachable in the Worker); the work still runs.
  }
}

// Asks for a round of the Store's jobs after the response (the unlock job, domain/unlock-accepts.ts); the cron runs
// one regardless.
export function requestJobsSoon(c: AfterResponse, deps: Pick<ApiDeps, "requestJobs">): void {
  const ring = deps.requestJobs?.(c.env);
  if (ring !== undefined) {
    afterResponse(
      c,
      ring.catch((error: unknown) => {
        console.error({ event: "kopje.jobs.request_failed", ...errorFields(error) });
      }),
    );
  }
}
