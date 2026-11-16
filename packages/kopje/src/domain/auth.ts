import { LOCAL_ACCOUNTS_ID_INDEX, OAUTH_CLIENTS_ID_INDEX } from "../db/indexes";
import type { Db } from "../db/sql";
import type { StoreClock, StoreOperation, TimedOperation } from "../platform/store-kernel";
import { grantsAny, type RequiredScope } from "../security/scopes";
import { adminAccountId, adminAccountIdOnce } from "./admin-authority";
import type { ViewerContext } from "./audience";
import { mediaDeleteOperation, readOperation, sessionOperation, writeOperation } from "./operation";

// Token validation for API requests, in the same RPC as the operation. A protected
// operation takes the request's credential and checks it in the transaction that runs the operation, so a token
// revoked, or an account suspended, before the operation commits cannot act. The Worker's access middleware only
// reads the bearer token and declares the route's scope.

// The caller of an API request. accountId is null for an app token (client_credentials). now is the request time
// (the credential's), which time-bound state such as a mute's expiry is judged at.
export type Viewer = {
  tokenHash: string;
  scopes: string[];
  accountId: string | null;
  client: { id: string; name: string; website: string | null };
  now: number;
};

export type UserViewer = Viewer & { accountId: string };

// What a request presents: the sha256 of its bearer token, the scope its route requires (any one of them if several;
// null: any valid token, app tokens included), and the request time.
export type Credential = { tokenHash: string; scope: RequiredScope | null; now: number };

// A route that requires a scope also requires a user.
export type UserCredential = Credential & { scope: RequiredScope };

export type AuthFailure =
  | { status: "unauthenticated" }
  | { status: "suspended" }
  | { status: "insufficient_scope" }
  | { status: "user_required" }
  // The admin gate's refusal (adminGate): the caller of an admin route is not the OAuth admin. Mastodon's 403
  // "Forbidden" (Admin::PermissionsConcern).
  | { status: "admin_forbidden" }
  // An admin operation's refusal (adminReadOperation): Kopje does not grant the OAuth admin the route's permission.
  // Mastodon's 403 "This action is not allowed".
  | { status: "forbidden" };

export type Authorized<O> = AuthFailure | { status: "ok"; value: O };

// The credential epoch (migration 0034_admin_suspension): whether the credential `t` (an oauth_tokens row: an access
// token, a code or a web session) was issued in its account's current epoch, local_accounts.credential_epoch, read by
// key. Every insert stamps the account's epoch (CREDENTIAL_EPOCH_SQL) and a suspension increments it, in their
// transactions, so every credential issued before a suspension is refused from its commit on, also after an
// unsuspension (which keeps the epoch), with no clock involved, while the tokens job deletes them in rounds
// (domain/suspension.ts). An app token has no account and no epoch.
export function currentCredentialSql(t: string): string {
  return `NOT EXISTS (SELECT 1 FROM main.local_accounts fl WHERE fl.account_id = ${t}.account_id
		AND fl.credential_epoch <> ${t}.epoch)`;
}

// The epoch a credential of the account bound to `?` is stamped with when it is inserted: its current one, 0 for an
// app token.
export const CREDENTIAL_EPOCH_SQL =
  "coalesce((SELECT credential_epoch FROM main.local_accounts WHERE account_id = ?), 0)";

type TokenRow = {
  scopes: string;
  account_id: string | null;
  expires_at: string | null;
  client_id: string;
  name: string;
  website: string | null;
  suspended_at: string | null;
  stale: number;
};

// One indexed lookup by the token's sha256, then its client and account by key, the join order pinned so stale
// statistics cannot pick a scan of either (RES-7; test/activity.test.ts). The row is read whatever its expiry and
// epoch, as Doorkeeper 5.9.9 finds expired and revoked rows by value.
function tokenRow(db: Db, tokenHash: string): TokenRow | undefined {
  return db.first<TokenRow>(
    `SELECT t.scopes, t.account_id, t.expires_at, c.id AS client_id, c.name, c.website, l.suspended_at,
			coalesce(t.epoch <> l.credential_epoch, 0) AS stale
		FROM oauth_tokens t
		CROSS JOIN oauth_clients c INDEXED BY ${OAUTH_CLIENTS_ID_INDEX} ON c.id = t.client_id
		LEFT JOIN local_accounts l INDEXED BY ${LOCAL_ACCOUNTS_ID_INDEX} ON l.account_id = t.account_id
		WHERE t.token_hash = ? AND t.kind = 'access'`,
    tokenHash,
  );
}

// Doorkeeper's checks of a held row whose owner has been judged: an expired row and one of an earlier epoch
// (currentCredentialSql) are invalid; then the route's scope.
function validToken(row: TokenRow, credential: Credential): AuthFailure | { status: "ok"; viewer: Viewer } {
  if (row.expires_at !== null && row.expires_at <= new Date(credential.now).toISOString()) {
    return { status: "unauthenticated" };
  }
  if (row.stale === 1) {
    return { status: "unauthenticated" };
  }
  const scopes = row.scopes.split(" ");
  if (credential.scope !== null) {
    if (!grantsAny(scopes, credential.scope)) {
      return { status: "insufficient_scope" };
    }
    if (row.account_id === null) {
      return { status: "user_required" };
    }
  }
  return {
    status: "ok",
    viewer: {
      tokenHash: credential.tokenHash,
      scopes,
      accountId: row.account_id,
      client: { id: row.client_id, name: row.name, website: row.website },
      now: credential.now,
    },
  };
}

// AUTH-1's order, as Mastodon's Api::BaseController#require_not_suspended! runs before Doorkeeper's checks of the row
// it finds: a row the Store holds whose owner is suspended is refused as suspended, expired or of an earlier epoch
// alike; then validToken. A deleted row is no credential.
export function authorize(db: Db, credential: Credential): AuthFailure | { status: "ok"; viewer: Viewer } {
  const row = tokenRow(db, credential.tokenHash);
  if (row === undefined) {
    return { status: "unauthenticated" };
  }
  if (row.suspended_at !== null) {
    return { status: "suspended" };
  }
  return validToken(row, credential);
}

// The viewer context of a signed-in user.
export type UserContext = ViewerContext & { readonly accountId: string };

// The only place a ViewerContext is made: the viewer a credential names (or none), judged at its request time, another
// account seen by the OAuth admin (viewerOf), or the anonymous viewer of the public page reads (domain/web-pages/).
export function contextOf<A extends string | null>(
  accountId: A,
  now: number,
): ViewerContext & { readonly accountId: A } {
  return { accountId, now: new Date(now).toISOString() };
}

// The tokens of one account's streaming sockets (domain/streaming.ts), checked in the transaction that makes a message
// (R33, VIS-26): the scopes of each token still valid and still the account's, and the account's context when any is.
export function authorizeStream(
  db: Db,
  accountId: string,
  tokenHashes: readonly string[],
  now: number,
): { scopes: Map<string, string[]>; context: UserContext | null } {
  const scopes = new Map<string, string[]>();
  for (const tokenHash of tokenHashes) {
    const auth = authorize(db, { tokenHash, scope: null, now });
    if (auth.status === "ok" && auth.viewer.accountId === accountId) {
      scopes.set(tokenHash, auth.viewer.scopes);
    }
  }
  return { scopes, context: scopes.size === 0 ? null : contextOf(accountId, now) };
}

type Declare = typeof readOperation;

type UserRun<I, O> = (db: Db, input: I, viewer: UserViewer, context: UserContext) => O;

// The credential checked, then `run` with the user it names.
function asUser<I extends { credential: UserCredential }, O>(run: UserRun<I, O>) {
  return (db: Db, input: I): Authorized<O> => {
    const auth = authorize(db, input.credential);
    if (auth.status !== "ok") {
      return auth;
    }
    // authorize() refuses a token without an account when a scope is required.
    const viewer = auth.viewer as UserViewer;
    return { status: "ok", value: run(db, input, viewer, contextOf(viewer.accountId, viewer.now)) };
  };
}

// `.atStoreTime(field)` declares one that also takes the Store's own time in `field` (operation.ts), the credential
// still judged at its request time.
function guarded(declare: Declare) {
  const operation = <I, O>(
    run: UserRun<I & { credential: UserCredential }, O>,
  ): StoreOperation<I & { credential: UserCredential }, Authorized<O>> =>
    declare<I & { credential: UserCredential }, Authorized<O>>(asUser(run));
  const atStoreTime =
    <C extends StoreClock>(clock: C) =>
    <I extends Record<C, number>, O>(
      run: UserRun<I & { credential: UserCredential }, O>,
    ): TimedOperation<I & { credential: UserCredential }, Authorized<O>, C> =>
      declare.atStoreTime(clock)<I & { credential: UserCredential }, Authorized<O>>(asUser(run));
  return Object.assign(operation, { atStoreTime });
}

// Operations of a signed-in user, under the scope of the route.
export const userReadOperation = guarded(readOperation);
export const userWriteOperation = guarded(writeOperation);
// Web Push registration: still served while the Store is readonly, as sign-ins are.
export const userSessionOperation = guarded(sessionOperation);
export const userMediaDeleteOperation = guarded(mediaDeleteOperation);

// Operations of a route that declares no scope but serves only a user (Mastodon's require_user! without
// doorkeeper_authorize!): any valid token of a user, whatever its scopes; an app token answers user_required.
export function tokenUserReadOperation<I, O>(
  run: (db: Db, input: I, viewer: UserViewer, context: UserContext) => O,
): StoreOperation<I & { credential: Credential }, Authorized<O>> {
  return readOperation<I & { credential: Credential }, Authorized<O>>((db, input) => {
    const auth = authorize(db, input.credential);
    if (auth.status !== "ok") {
      return auth;
    }
    if (auth.viewer.accountId === null) {
      return { status: "user_required" };
    }
    const viewer = auth.viewer as UserViewer;
    return { status: "ok", value: run(db, input, viewer, contextOf(viewer.accountId, viewer.now)) };
  });
}

// Checks a credential without doing anything else: lets the Worker answer an authentication failure before a
// request error it found on its own, as Mastodon does.
export const checkCredential = readOperation<Credential, Authorized<Viewer>>((db, credential) => {
  const auth = authorize(db, credential);
  return auth.status === "ok" ? { status: "ok", value: auth.viewer } : auth;
});

export type Suspended = { status: "suspended" };

// The answer of an operation of an anonymous route (mastodon/access.ts) that judges the token's owner.
export type Judged<O> = Suspended | { status: "ok"; value: O };

// AUTH-2's anonymous routes, as Mastodon's Api::BaseController#require_not_suspended! on a route that needs no token:
// a token sent whose row the Store holds and whose owner is suspended is refused, expired or of an earlier epoch alike
// (authorize's order, AUTH-1); any other token, an unknown, expired or app token included, changes nothing. An
// operation that can write calls it first, in the transaction of its writes.
export function refuseSuspended(db: Db, credential: Credential | null): Suspended | null {
  return credential !== null && authorize(db, credential).status === "suspended" ? { status: "suspended" } : null;
}

// An anonymous route's read in its operation: the suspended owner's refusal, else what `read` reads, run after the
// judgment in the same transaction.
export function unlessSuspended<O>(db: Db, credential: Credential | null, read: () => O): Judged<O> {
  return refuseSuspended(db, credential) ?? { status: "ok", value: read() };
}

// The judgment of an anonymous route's answer that no operation judged (the access middleware's after-check).
export const checkNotSuspended = readOperation<Credential, Suspended | { status: "ok" }>(
  (db, credential) => refuseSuspended(db, credential) ?? { status: "ok" },
);

type OptionalUserInput = { credential: Credential | null; now: number };

// The credential checked as a route whose token is optional judges it, then `run` with the viewer it names.
function asOptionalUser<I extends OptionalUserInput, O>(run: (db: Db, input: I, context: ViewerContext) => O) {
  return (db: Db, input: I): Authorized<O> => {
    if (input.credential === null) {
      return { status: "ok", value: run(db, input, contextOf(null, input.now)) };
    }
    const { now } = input.credential;
    const auth = authorize(db, input.credential);
    if (auth.status === "user_required") {
      return { status: "ok", value: run(db, input, contextOf(null, now)) };
    }
    if (auth.status !== "ok") {
      return auth;
    }
    return { status: "ok", value: run(db, input, contextOf(auth.viewer.accountId, now)) };
  };
}

// Operations of a route whose token is optional (Mastodon's authorize_if_got_token!): no credential reads as an
// anonymous viewer; a credential must be valid and cover the route's scope (if it declares one), and an app token (no
// user) is anonymous. The context's time is the credential's request time, or the request time the input carries
// when there is no credential. `.atStoreTime(field)` declares one that also takes the Store's own time in `field`.
export function optionalUserReadOperation<I, O>(
  run: (db: Db, input: I, context: ViewerContext) => O,
): StoreOperation<I & OptionalUserInput, Authorized<O>> {
  return readOperation<I & OptionalUserInput, Authorized<O>>(asOptionalUser<I & OptionalUserInput, O>(run));
}

optionalUserReadOperation.atStoreTime =
  <C extends StoreClock>(clock: C) =>
  <I extends Record<C, number>, O>(
    run: (db: Db, input: I & OptionalUserInput, context: ViewerContext) => O,
  ): TimedOperation<I & OptionalUserInput, Authorized<O>, C> =>
    readOperation.atStoreTime(clock)<I & OptionalUserInput, Authorized<O>>(asOptionalUser(run));

// Mastodon's permission bits (app/models/user_role.rb) of the admin API's route groups.
export const ADMIN_PERMISSION = {
  viewDashboard: 8,
  manageReports: 16,
  manageFederation: 32,
  manageBlocks: 128,
  manageTaxonomies: 256,
  manageUsers: 1024,
  deleteUserData: 524288,
} as const;

export type AdminPermission = (typeof ADMIN_PERMISSION)[keyof typeof ADMIN_PERMISSION];

// The permissions of the OAuth admin's role: the bits of the route groups Kopje serves. A group's bit is set only
// once the whole group is served; until then its routes refuse the admin as they refuse everyone. Served: reports
// (manage_reports), accounts (manage_users, with local and remote suspension), domain blocks and allows
// (manage_federation) and the dashboard's metrics (view_dashboard, domain/admin-measures.ts): 1080.
export const ADMIN_PERMISSIONS: number =
  ADMIN_PERMISSION.manageReports |
  ADMIN_PERMISSION.manageUsers |
  ADMIN_PERMISSION.manageFederation |
  ADMIN_PERMISSION.viewDashboard;

// A role as Mastodon's REST::RoleSerializer presents it (permissions is a string).
export type Role = { id: string; name: string; permissions: string; color: string; highlighted: boolean };

// The OAuth admin's role: Mastodon's Owner (id 3 on a default install, db/seeds/03_roles.rb), with exactly the
// permissions Kopje serves. Not `administrator` (bit 1), which implies every permission (UserRole#can?).
export const OWNER_ROLE: Role = {
  id: "3",
  name: "Owner",
  permissions: String(ADMIN_PERMISSIONS),
  color: "",
  highlighted: true,
};

// Every other local account's role: Mastodon's default (everyone) role, id -99.
export const EVERYONE_ROLE: Role = { id: "-99", name: "", permissions: "0", color: "", highlighted: false };

// The role a local account's credential account presents: Owner for the OAuth admin, read in the transaction that
// presents it through the operation's one lookup (adminAccountIdOnce, which its `roles` shares), and the everyone role
// for every other one.
export function localRole(db: Db, accountId: string): Role {
  return accountId === adminAccountIdOnce(db) ? OWNER_ROLE : EVERYONE_ROLE;
}

// The OAuth admin acting through an admin route: its account, the client it acts through, the request time, and the
// admin as a viewer at that time.
export type Admin = { accountId: string; clientId: string; now: number; context: UserContext };

// R32's capture (streaming.ts streamDelete): an account listening on a list stream as a viewer at the time of the
// delete, for its lists' reads positioned at the deleted status.
export function listenerContext(accountId: string, now: number): UserContext {
  return contextOf(accountId, now);
}

// R37: another account as a viewer at the admin's request time, for what the admin is shown only while that account
// may still see it (the statuses a report names, as its reporter sees them: domain/reports.ts).
export function viewerOf(admin: Admin, accountId: string): UserContext {
  return contextOf(accountId, admin.now);
}

// The admin gate (VIS-29), in the order of Mastodon's admin controllers: Api::BaseController#require_not_suspended!,
// then Admin::PermissionsConcern#require_moderator_or_admin_permissions (403 "Forbidden" unless the caller's role
// has a moderation, administration or devops permission), then authorize_if_got_token!. Doorkeeper finds a held row
// whatever its expiry, so its owner is judged first: no credential or no row the Store holds is nobody
// (admin_forbidden); a suspended owner is refused as suspended; an owner other than the OAuth admin (adminAccountId,
// read here, so tokens follow the current match), an app token's included, is admin_forbidden; then the OAuth admin's
// token is judged as authorize judges it (validToken). A deleted row of the OAuth admin is nobody's, where Mastodon
// still finds a revoked one (docs/mastodon-deviations.md, MD-2).
function adminGate(db: Db, credential: UserCredential | null): AuthFailure | { status: "ok"; viewer: UserViewer } {
  const row = credential === null ? undefined : tokenRow(db, credential.tokenHash);
  if (credential === null || row === undefined) {
    return { status: "admin_forbidden" };
  }
  if (row.suspended_at !== null) {
    return { status: "suspended" };
  }
  if (row.account_id === null || row.account_id !== adminAccountId(db)) {
    return { status: "admin_forbidden" };
  }
  const auth = validToken(row, credential);
  // The row has an account, so validToken cannot answer user_required.
  return auth.status === "ok" ? { status: "ok", viewer: auth.viewer as UserViewer } : auth;
}

// The admin gate alone: lets the Worker answer a refusal before an answer an admin handler gives without its
// operation (mastodon/context.ts checkAdminCredential).
export const checkAdminCredential = readOperation<UserCredential, Authorized<true>>((db, credential) => {
  const gate = adminGate(db, credential);
  return gate.status === "ok" ? { status: "ok", value: true } : gate;
});

// Operations of the Mastodon admin API (R37, VIS-29): the admin gate, then, in the same transaction, `granted` must
// hold the route's permission, else `forbidden`, as Mastodon's policies refuse a role without the permission.
// `granted` is ADMIN_PERMISSIONS outside tests.
export function adminGuarded(declare: Declare, granted: number) {
  return <I, O>(
    permission: AdminPermission,
    run: (db: Db, input: I, admin: Admin) => O,
  ): StoreOperation<I & { credential: UserCredential | null }, Authorized<O>> =>
    declare<I & { credential: UserCredential | null }, Authorized<O>>((db, input) => {
      const gate = adminGate(db, input.credential);
      if (gate.status !== "ok") {
        return gate;
      }
      if ((granted & permission) === 0) {
        return { status: "forbidden" };
      }
      const { viewer } = gate;
      return {
        status: "ok",
        value: run(db, input, {
          accountId: viewer.accountId,
          clientId: viewer.client.id,
          now: viewer.now,
          context: contextOf(viewer.accountId, viewer.now),
        }),
      };
    });
}

export const adminReadOperation = adminGuarded(readOperation, ADMIN_PERMISSIONS);
export const adminWriteOperation = adminGuarded(writeOperation, ADMIN_PERMISSIONS);
