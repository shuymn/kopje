import type { Db } from "../db/sql";
import { fetchableHref, httpUrl } from "../platform/http-url";
import { isStorableActorId } from "../platform/identity-bounds";
import { requireExactIncrement } from "./ids";

// The collections a remote actor's document names, and the request to sync them, which storing an actor makes
// (remote-actors.ts). The sync itself is remote-collections.ts.

// Asks for a sync of the account's collections (ProcessAccountService#check_featured_collection! and
// #check_featured_tags_collection!, and the hide_collections it sets). One request per account waits at a time, as
// Sidekiq's until_executed lock keeps one job; a request while a round holds it is a new generation, which the round's
// end leaves due (endRound), so the round reading the older document does not end it. refresh: the sync first
// refetches the account's document and confirms its handle (remote-collections.ts, the document part), asked for an
// invalidated account (remote-actors.ts); a request without it leaves one asked for. Whether a request is due (no round
// holds it).
export function requestCollectionSync(db: Db, accountId: string, now: number, refresh = false): boolean {
  // A new request has its own MAX_SYNC_ATTEMPTS, and is due at once unless a round holds the sync (whose end leaves it
  // due, endRound): rounds that failed for the older one neither drop nor delay it.
  const row = db.first<{ due: number; exact: number }>(
    `INSERT INTO collection_syncs (account_id, due_at, refresh) VALUES (?1, ?2, ?3)
		ON CONFLICT (account_id) DO UPDATE SET generation = generation + 1, parts_read = 0, collections_read = 0, attempts = 0,
			refresh = max(refresh, excluded.refresh),
			due_at = CASE WHEN token IS NOT NULL AND due_at > ?2 THEN due_at ELSE min(due_at, ?2) END
		RETURNING due_at <= ?2 AS due, typeof(generation) = 'integer' AS exact`,
    accountId,
    now,
    refresh ? 1 : 0,
  );
  requireExactIncrement(row?.exact ?? 1, "a collection sync's generation");
  return row?.due === 1;
}

// An inbound change of the account's collections (inbox.ts: an Add, a Remove or an Update from their owner;
// remote-statuses.ts: a search storing one): a round that holds the sync now read its listing before the change, so
// its end does not apply that listing, and a later round reads the collections again (remote-collections.ts
// completeCollectionRead). Each claim of the sync clears the mark.
export function markCollectionsChanged(db: Db, accountId: string): void {
  db.run("UPDATE collection_syncs SET collections_changed = 1 WHERE account_id = ?", accountId);
}

// A collection an actor document names (followers, following, featured, ...), as Mastodon 4.7.5 stores it
// (ProcessAccountService#valid_collection_uri, process_account_service.rb:235-245): an array is unwrapped once, to its
// first value; then an object gives its id; then a string gives the URI Mastodon stores for it (storedCollectionUri),
// which addressing and quote policies are compared with as Mastodon compares its stored URI; anything else is none,
// which Mastodon stores as '' (the column's default) and compares as that string, so `[[F]]`, whose first value is an
// array, is ''. Every reader hands it the member as parsed, or reads what collectionSql selects, which is the same
// string.
export function collectionRead(value: unknown): CollectionRead {
  const uri = collectionValue(value);
  return uri === null ? NONE : storedCollectionUri(uri);
}

// valid_collection_uri's unwrap (process_account_service.rb:236-238): an array to its first value, then an object to
// its id; the string that gives, else null. The only place an actor member's array is unwrapped (collectionRead, and
// remote-actor.ts sharedInboxUri).
export function collectionValue(value: unknown): string | null {
  let uri: unknown = Array.isArray(value) ? value[0] : value;
  if (typeof uri === "object" && uri !== null && !Array.isArray(uri)) {
    uri = (uri as { id?: unknown }).id;
  }
  return typeof uri === "string" ? uri : null;
}

// No collection, as Mastodon stores it.
const NONE = "";

// A collection Kopje cannot tell what Mastodon stores for (storedCollectionUri), which no reader may read as more than
// Mastodon may (docs/mastodon-deviations.md).
export const UNREADABLE = Symbol("an unreadable collection");
export type CollectionRead = string | typeof UNREADABLE;

// collectionRead, with an unreadable collection as null, which no addressing names: a status addressed to it is direct,
// never more visible than Mastodon makes it.
export function collectionUri(value: unknown): string | null {
  const read = collectionRead(value);
  return read === UNREADABLE ? null : read;
}

// Ruby's [[:space:]] on a UTF-8 string: JavaScript's \s with U+0085 and without U+FEFF.
const RUBY_SPACE = "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
// What Addressable refuses in a host (Addressable::URI#validate), and inside an IP literal's brackets anything but
// its UNRESERVED, SUB_DELIMS and `:`.
const HOST_REFUSED = new RegExp(`[<>{}/\\\\?#@"${RUBY_SPACE}]`, "u");
const BLANK = new RegExp(`^[${RUBY_SPACE}]*$`, "u");
const IP_LITERAL = /^[A-Za-z0-9\-._~!$&'()*+,;=:]*$/;
// A NUL, a lone surrogate or U+FFFD (storedCollectionUri).
const UNREADABLE_CHARACTER = /[\0\uD800-\uDFFF\uFFFD]/u;

// The URI Mastodon 4.7.5's valid_collection_uri stores for `uri`: what Addressable 2.9.2 (its Gemfile.lock) parses
// (Addressable::URI.parse: RFC 3986's regex, the authority split into userinfo, host and port, then #validate) and
// writes back (#to_s), when the scheme is http or https:
//   - the scheme is `http` or `https` exactly as spelled (VALID_URI_SCHEMES, case-sensitive), followed by `//` and an
//     authority, so an upper-case scheme, a missing `//`, a backslash in place of a slash and leading whitespace,
//     which the URL Standard's parser would repair, are none ('');
//   - the host (the authority without its userinfo up to the last `@` and its `:port`) is not blank (present?) and
//     holds nothing #validate refuses (a backslash or whitespace among them), else none;
//   - the port is percent-decoded (#port=) and must then be digits, else none; it is written back as an integer: an
//     empty or zero port is dropped, and leading zeros go;
//   - the userinfo is written back stripped of ASCII whitespace (String#strip), and the fragment ends at a line feed
//     (Ruby's `.` and `$` stop there).
// Anything else is written back as spelled. UNREADABLE where Kopje cannot tell: a NUL (PostgreSQL refuses it, so
// Mastodon stores no account), a lone surrogate or U+FFFD (the Store's JSON functions read a lone surrogate's escape as
// bytes that come back as U+FFFD, so the SQL readers and JSON.parse would read two strings), a line feed in the
// authority (Ruby's `^` and `$` match at it, which moves the split), and a port decoded to one holding a line feed.
function storedCollectionUri(uri: string): CollectionRead {
  if (UNREADABLE_CHARACTER.test(uri)) {
    return UNREADABLE;
  }
  const parts = /^(https?:\/\/)([^/?#]*)([^]*)$/.exec(uri);
  if (parts === null) {
    return NONE;
  }
  const [, scheme = "", authority = "", rest = ""] = parts;
  if (authority.includes("\n")) {
    return UNREADABLE;
  }
  const userinfo = /^([^[\]]*)@/.exec(authority)?.[1];
  const host = authority.replace(/^[^[\]]*@/, "").replace(/:[^:@[\]]*$/, "");
  const literal = /^\[([^]*)\]$/.exec(host)?.[1];
  if (BLANK.test(host) || HOST_REFUSED.test(host) || (literal !== undefined && !IP_LITERAL.test(literal))) {
    return NONE;
  }
  let port = /:([^:@[\]]*)$/.exec(authority)?.[1] ?? "";
  port = port.replace(/%[0-9a-f]{2}/gi, (code) => String.fromCharCode(Number.parseInt(code.slice(1), 16)));
  if (!/^\d*$/.test(port)) {
    return port.includes("\n") ? UNREADABLE : NONE;
  }
  port = port.replace(/^0+/, "");
  const user = userinfo === undefined ? "" : `${userinfo.replace(/^[\t\v\f\r ]+|[\t\v\f\r ]+$/g, "")}@`;
  const hash = rest.indexOf("#");
  const cut = hash === -1 ? -1 : rest.indexOf("\n", hash);
  return `${scheme}${user}${host}${port === "" ? "" : `:${port}`}${cut === -1 ? rest : rest.slice(0, cut)}`;
}

// The SQL of the string a member of the actor document `raw` names for collectionRead, as text, or NULL: the last
// member of that name (as JSON.parse and Ruby's parser keep the last of a duplicate key), its first value if an array,
// then the last `id` of an object, kept when a string. The projection is that one string, never an object, so its
// bytes are the string's: at most the stored document's, which has no fixed bound of its own (a fetched document is
// within DOCUMENT_BODY_LIMIT, an imported one only valid JSON).
export function collectionSql(raw: string, member: "followers" | "following"): string {
  return `(SELECT CASE m.type WHEN 'text' THEN m.value
			WHEN 'object' THEN (SELECT CASE i.type WHEN 'text' THEN i.value END FROM json_each(m.value) AS i
				WHERE i.key = 'id' ORDER BY i.id DESC LIMIT 1)
			WHEN 'array' THEN (SELECT CASE f.type WHEN 'text' THEN f.value
					WHEN 'object' THEN (SELECT CASE i.type WHEN 'text' THEN i.value END FROM json_each(f.value) AS i
						WHERE i.key = 'id' ORDER BY i.id DESC LIMIT 1) END
				FROM json_each(m.value) AS f WHERE f.key = 0) END
		FROM json_each(${raw}) AS m WHERE m.key = '${member}' ORDER BY m.id DESC LIMIT 1)`;
}

// The collections a stored actor document names (collectionUri), normalized as fetch targets. featuredCollections is
// FEP-7aa9's (Mastodon 4.7.5's collections_url, process_account_service.rb:249), a bare key of Mastodon's actor.
export type ActorCollections = {
  featured: string | null;
  featuredCollections: string | null;
  featuredTags: string | null;
  followers: string | null;
  following: string | null;
  outbox: string | null;
};

function idOf(value: unknown): string | null {
  return httpUrl(collectionUri(value))?.href ?? null;
}

export function actorCollections(raw: string | null): ActorCollections {
  let document: Record<string, unknown> = {};
  try {
    const parsed = raw === null ? null : (JSON.parse(raw) as unknown);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      document = parsed as Record<string, unknown>;
    }
  } catch {
    // A stored document always parses; an unreadable one names no collection.
  }
  return {
    featured: idOf(document.featured),
    featuredCollections: idOf(document.featuredCollections),
    featuredTags: idOf(document.featuredTags),
    followers: idOf(document.followers),
    following: idOf(document.following),
    outbox: idOf(document.outbox),
  };
}

// An absolute http(s) URI with an authority, in any case of the scheme, without whitespace or a backslash anywhere:
// what namedMove takes before the URL parser, which would repair `https:host/b`, `https:\\host`, `https:///host/b` and
// surrounding whitespace.
const MOVE_URI = /^https?:\/\/[^\s\\/?#]+(?:[/?#][^\s\\]*)?$/i;

// The account a stored actor document's movedTo names (ID-4), read from the literal member as Mastodon 4.7.5 reads
// `@json['movedTo']` (process_account_service.rb:166), with no JSON-LD context applied: an array gives its first value
// and an object its id (collectionValue), and the string must be an absolute http(s) URI (MOVE_URI) that Kopje stores
// as an actor id, other than `uri` itself; its href, else null. Where Mastodon fails on an array or an object, this
// reads them (docs/mastodon-deviations.md). The stored row it names is remote-actors.ts moveTarget's.
export function namedMove(raw: string | null, uri: string): string | null {
  let value: unknown;
  try {
    const parsed = raw === null ? null : (JSON.parse(raw) as unknown);
    value =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as { movedTo?: unknown }).movedTo
        : null;
  } catch {
    // A stored document always parses; an unreadable one names no move.
    return null;
  }
  const named = collectionValue(value);
  if (named === null || !MOVE_URI.test(named)) {
    return null;
  }
  let href: string;
  try {
    href = new URL(named).href;
  } catch {
    return null;
  }
  return isStorableActorId(href) && href !== uri ? href : null;
}

// The destination namedMove reads from `raw` when the collection sync may fetch it (accounts.move_pending, the sync's
// move part in remote-collections.ts): an id the document loader would request (fetchableHref, NET-1's shape), with no
// fragment (the document fetched for it would have another id) and not on this instance's `origin` (ID-3); else null.
export function fetchableMove(raw: string | null, uri: string, origin: string): string | null {
  const named = namedMove(raw, uri);
  return named !== null && fetchableHref(named) !== null && !named.includes("#") && new URL(named).origin !== origin
    ? named
    : null;
}
