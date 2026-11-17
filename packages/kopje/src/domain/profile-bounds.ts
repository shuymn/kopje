import { boundedHref } from "../platform/http-url";
import { ACTOR_URI_LIMIT, REMOTE_USERNAME_LIMIT } from "../platform/identity-bounds";
import { cutSql, PROFILE_URL_LIMIT } from "../platform/stored-bounds";

// RES-2: read projections of the username and actor id (test-node/bounded-columns.test.ts). Stored profile bounds and
// read exceptions: STORED_COLUMNS in platform/stored-bounds.ts. Imports only leaves, so modules that build SQL at load
// (status-rows.ts) can use it whatever the import order.

export { cutSql, DISPLAY_NAME_LIMIT, PROFILE_URL_LIMIT } from "../platform/stored-bounds";
// Mastodon's remote usernames are short; Kopje refuses a longer one as stored (federation/remote-actor.ts, RES-1).
export const USERNAME_LIMIT = REMOTE_USERNAME_LIMIT;
// Actor ids, as stored (federation/remote-actor.ts, RES-6), in UTF-8 bytes.
export { ACTOR_URI_LIMIT };

// A stored username as every read that presents one, or derives an acct or URL from it, takes it. One the Worker
// stores is ASCII of Mastodon's remote format (federation/remote-actor.ts), so its JSON is its length: cut at
// USERNAME_LIMIT. Any other (a row converted before the cutover refused such usernames) is cut at
// NONCONFORMING_USERNAME_LIMIT code points; a code point escapes to at most six bytes, so its JSON is at most
// USERNAME_LIMIT bytes plus the quotes. The fast path needs every byte to be a character (length counts characters
// up to an embedded NUL, so a NUL or a non-ASCII byte makes the two differ) and none outside the format (GLOB, which
// also stops at a NUL). Lookups compare the whole stored username.
const NONCONFORMING_USERNAME_LIMIT = Math.floor(USERNAME_LIMIT / 6);
export function usernameSql(column: string): string {
  return `CASE WHEN length(CAST(${column} AS BLOB)) = length(${column}) AND ${column} NOT GLOB '*[^A-Za-z0-9_.-]*'
	THEN ${cutSql(column, USERNAME_LIMIT)} ELSE substr(${column}, 1, ${NONCONFORMING_USERNAME_LIMIT}) END`;
}

// A stored actor id as a presenter reads it: '' past ACTOR_URI_LIMIT, or past a lower `limit` (UTF-8 bytes) where the
// presenter shows less (a moved-to account, account-columns.ts MOVED_URL_LIMIT). Only a converted row can hold one
// longer than ACTOR_URI_LIMIT, and the cutover refuses it (docs/cutover.md); it is an identity, so it is never cut into
// another actor's id. A presenter shows it as a remote account's profile URL (remoteAccountUrl) or derives a URL from
// its origin (accounts.ts accountUrl), which for '' falls back to this instance's /@acct page. Lookups, deliveries and
// ActivityPub documents compare or send the whole stored id.
export function actorUriSql(column: string, limit = ACTOR_URI_LIMIT): string {
  return `CASE WHEN length(CAST(${column} AS BLOB)) <= ${limit} THEN ${column} ELSE '' END`;
}

// A remote account's profile URL as Kopje shows it wherever Mastodon's TagManager#url_for gives one (accounts.ts
// accountUrl, a notification fallback, the link-card mention test): its stored url when it is usable, else its actor
// id, as Mastodon stores `url || @uri` (process_account_service.rb:228); null when neither is. Usable: `href` gives it,
// by default an http(s) URL within PROFILE_URL_LIMIT once serialized (HTML-3, RES-2). Mastodon's url_for gives nil for
// a stored url that is not http(s), which only an import holds (docs/mastodon-deviations.md).
export function remoteAccountUrl(
  row: { url: string | null; uri: string },
  href: (value: string | null) => string | null = (value) => boundedHref(value, PROFILE_URL_LIMIT),
): string | null {
  return href(row.url) ?? href(row.uri);
}
