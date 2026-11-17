import { selectSql } from "../db/columns";
import { ACCOUNTS_ID_INDEX, LOCAL_ACCOUNTS_ID_INDEX } from "../db/indexes";
import type { Db } from "../db/sql";
import { DEFAULT_AVATAR, DEFAULT_HEADER } from "../platform/brand-assets";
import { normalizeDomain, parseAddress } from "../platform/domain-name";
import { boundedHref, httpUrl } from "../platform/http-url";
import { ACTOR_URI_LIMIT, DOMAIN_BYTES, isRemoteUsername, withinIdentityBound } from "../platform/identity-bounds";
import { railsBlank } from "../platform/rails-blank";
import {
  ACCOUNT_EMOJIS_BYTES,
  attributionDomainsSql,
  cutCodePoints,
  isIsoTime,
  MAX_FIELD_NAME,
  MAX_FIELD_VALUE,
  MAX_FIELDS,
  presentedAttributionDomains,
  presentedCountSql,
  presentedDisplayName,
  presentedNote,
  presentedProfileDescription,
  REMOTE_VERIFIED_SHOWN,
} from "../platform/stored-bounds";
import { rubyStrip } from "../platform/strip";
import { sanitizeRemoteHtml } from "../security/html";
import {
  ACCOUNT_COLUMN_MAP,
  FIELD_NAME_LIMIT,
  FIELD_VALUE_RAW_LIMIT,
  LOCAL_ROW_JOIN,
  MOVED_ACCOUNT_COLUMNS,
  MOVED_CREATED_AT_LIMIT,
  MOVED_DISPLAY_NAME_LIMIT,
  MOVED_EMOJIS_BYTES,
  MOVED_LAST_STATUS_AT_LIMIT,
  MOVED_URL_LIMIT,
  REMOTE_FIELDS_BYTES,
  remoteAttachmentSql,
} from "./account-columns";
import { adminAccountIdOnce } from "./admin-authority";
import { admit, type Admitted, admittedPage, ANSWER_BYTES, ARRAY_ANSWER_BYTES, jsonBytes } from "./answer-budget";
import {
  activeMuteJoinSql,
  availableJoinedSql,
  availableSql,
  blocksSql,
  domainBlocksSql,
  filteredForSql,
  findableBySql,
  followListedSql,
  followListsShownSql,
  foundSql,
  hidesCollectionsSql,
  isBotActorType,
  type QuotePolicyName,
  type ViewerContext,
  type FeatureApproval,
  featureApprovalReads,
} from "./audience";
import {
  type Credential,
  type Judged,
  localRole,
  optionalUserReadOperation,
  OWNER_ROLE,
  refuseSuspended,
  type Role,
  unlessSuspended,
  userReadOperation,
  userWriteOperation,
} from "./auth";
import { type CustomEmoji, emojiCacheOf, presentEmojis, referencedEmojis } from "./custom-emojis";
import type { FeaturedTag } from "./featured-tags";
import { remoteFieldLink } from "./field-verification";
import { readOperation } from "./operation";
import { htmlToPlainText } from "./plain-text";
import {
  actorUriSql,
  DISPLAY_NAME_LIMIT,
  PROFILE_URL_LIMIT,
  remoteAccountUrl,
  USERNAME_LIMIT,
  usernameSql,
} from "./profile-bounds";
import { type CachedImages, cachedImagesOf, cachedImageUrls } from "./remote-media";
import { queryTerms } from "./search-text";
import { linkHtml, renderFieldValue } from "./status-text";
import { edgeRangeSql, readWindow, singleWindow, type Window, windowJson, windowPage } from "./windows";

// Accounts as the Mastodon API (4.0.2) shows them: one presenter, and the account and relationship operations.
// Every operation takes an account by its API id or by its legacy id (accounts.legacy_id); both resolve to the same
// row and responses always carry the API id. Ids are TEXT and are never read as numbers.

// How an account is presented: on the instance origin, for the viewer (null: none signed in), whose answer
// feature_approval.current_user is. The Worker sends the origin alone (PresentInput); the Store adds the viewer it
// judged the token to be, so a caller cannot present for another account.
export type Present = { origin: string; viewerId: string | null };

export type PresentInput = Pick<Present, "origin">;

// The presentation of `input` for `viewerId`.
export function presentFor(input: PresentInput, viewerId: string | null): Present {
  return { origin: input.origin, viewerId };
}

export type Account = {
  id: string;
  username: string;
  acct: string;
  display_name: string;
  locked: boolean;
  bot: boolean;
  discoverable: boolean | null;
  // Account#indexable is stored, presented and federated. Kopje has no public status-search index.
  indexable: boolean;
  group: boolean;
  created_at: string;
  note: string;
  url: string;
  // The actor id (ActivityPub::TagManager#uri_for), also of an unavailable account; '' past ACTOR_URI_LIMIT.
  uri: string;
  avatar: string;
  avatar_static: string;
  // The image descriptions (Account#avatar_description, header_description): '' for none, and while unavailable.
  avatar_description: string;
  header: string;
  header_static: string;
  header_description: string;
  followers_count: number;
  following_count: number;
  statuses_count: number;
  last_status_at: string | null;
  // Whether the account hides its network (Account#hide_collections): set by a local account, learned of a remote one
  // (remote-collections.ts); null for a remote account Kopje has not learned it of.
  hide_collections: boolean | null;
  // The display settings (Account#show_media, show_media_replies, show_featured), presented as stored, also while
  // unavailable, as Mastodon does. Kopje's pages and timelines do not honour them.
  show_media: boolean;
  show_media_replies: boolean;
  show_featured: boolean;
  emojis: CustomEmoji[];
  fields: Field[];
  // A local account's only, as Mastodon's `if: :local?`: false, Mastodon's default, as Kopje has no such setting.
  noindex?: boolean;
  // A local account's only: its highlighted role, the OAuth admin's Owner while it is available; [] otherwise.
  roles?: AccountRole[];
  suspended?: true;
  // Who may feature the account in a collection (REST::AccountSerializer#feature_approval): the policy's halves as
  // keys, from the row as Mastodon reads it also while unavailable (a local account: ["public"], or ["followers"] while
  // locked, when discoverable, else []; manual []; a remote one [] until Kopje stores its policy), and the answer to
  // the viewer (featureApprovalSql).
  feature_approval: { automatic: string[]; manual: string[]; current_user: FeatureApproval };
  // Present, true, only while the account's handle is invalidated (shownHandle).
  invalid_handle?: true;
  // The account it moved to (Account#moved_to_account), one level deep (MOVED_ACCOUNT_COLUMNS), when it has one
  // stored; null while it is unavailable (REST::AccountSerializer#moved_to_account).
  moved?: Account | null;
};

// A role as REST::AccountSerializer::RoleSerializer presents it.
type AccountRole = Pick<Role, "id" | "name" | "color">;

// Mastodon shows only a highlighted role (UserRole#highlighted?): OWNER_ROLE is, EVERYONE_ROLE is not.
const OWNER_BADGE: AccountRole = { id: OWNER_ROLE.id, name: OWNER_ROLE.name, color: OWNER_ROLE.color };

// A profile field (Mastodon's Account::Field): the name as plain text, the value as HTML. Local fields come from
// local_accounts.fields, remote ones from the actor's attachments. verified_at: when a local field's value, or a remote
// field's link (domain/remote-field-links.ts), was verified by rel=me (domain/field-links.ts), as Mastodon's
// DateTime#xmlschema(3) writes it ("2026-10-22T12:34:56.789+00:00", VERIFIED_AT_JSON_BYTES as JSON); null for every
// other field.
export type Field = { name: string; value: string; verified_at: string | null };

// A local field as the owner wrote it (plain text), stored in local_accounts.fields.
export type FieldSource = { name: string; value: string };

export { MAX_ATTRIBUTION_DOMAINS, MAX_FIELD_NAME, MAX_FIELD_VALUE, MAX_FIELDS } from "../platform/stored-bounds";

// Account::DISPLAY_NAME_LENGTH_LIMIT and NOTE_LENGTH_LIMIT: the local writer's limits, in code points. A stored display
// name is bounded by DISPLAY_NAME_LIMIT (platform/stored-bounds.ts), which remote ones may reach.
export const MAX_DISPLAY_NAME = 40;
export const MAX_NOTE = 500;

export type Visibility = "public" | "unlisted" | "private" | "direct";

export type CredentialAccount = Account & {
  source: {
    privacy: Visibility;
    sensitive: boolean;
    language: string | null;
    note: string;
    fields: (FieldSource & { verified_at: string | null })[];
    follow_requests_count: number;
    hide_collections: boolean;
    discoverable: boolean | null;
    indexable: boolean;
    attribution_domains: string[];
    quote_policy: QuotePolicyName;
  };
  role: Role;
};

export type Relationship = {
  id: string;
  following: boolean;
  showing_reblogs: boolean;
  notifying: boolean;
  languages: string[] | null;
  followed_by: boolean;
  requested_by: boolean;
  blocking: boolean;
  blocked_by: boolean;
  muting: boolean;
  muting_notifications: boolean;
  muting_expires_at: string | null;
  requested: boolean;
  domain_blocking: boolean;
  endorsed: boolean;
  note: string;
};

export type AccountRow = {
  id: string;
  uri: string;
  username: string;
  domain: string | null;
  actor_type: string;
  display_name: string;
  note: string;
  url: string | null;
  avatar_url: string | null;
  header_url: string | null;
  // The still of an animated uploaded image (migration 0061_account_static_images), or null: the image itself.
  avatar_static_url: string | null;
  header_static_url: string | null;
  // The image descriptions and display settings (migration 0097_profile_descriptions), bounded by its triggers.
  avatar_description: string;
  header_description: string;
  locked: number;
  discoverable: number | null;
  // NULL for a remote account not stored again since migration 0058.
  indexable: number | null;
  show_featured: number;
  show_media: number;
  show_media_replies: number;
  followers_count: number;
  following_count: number;
  statuses_count: number;
  created_at: string;
  // R1, read live in the query that reads the row (availableJoinedSql): 0 for an unavailable account.
  available: number;
  last_status_at: string | null;
  // local_accounts.fields within its raw read bound (presentedLocalFieldsSql), else null: an imported value past it
  // presents no fields, its bytes kept; fieldSources judges the rest. Null for a remote account.
  local_fields: string | null;
  // local_accounts.verified_links (VERIFIED_LINKS_BYTES, 0066's trigger) while the fields are the ones verification
  // reads (boundedLocalFieldsSql); null otherwise, and for a remote account.
  verified_links: string | null;
  // local_accounts' for a local account, accounts' (null until learned) for a remote one.
  hide_collections: number | null;
  // A remote account's PropertyValue attachments, bounded (REMOTE_ATTACHMENT_SQL), as JSON; null for a local one.
  attachment: string | null;
  // A remote account's verified fields (REMOTE_VERIFIED_SQL): a JSON array of [index, time]; null for a local one or
  // none.
  remote_verified: string | null;
  // The account's emoji snapshot (custom-emojis.ts); null for none.
  emojis: string | null;
  // The cached copies of its first emoji (stored-bounds.ts emojiCacheSql), as JSON; null for none.
  emoji_cache: string | null;
  // The id of the account it moved to (migration 0060_account_moves), or null.
  moved_to_account_id: string | null;
};

type MovedRow = Omit<
  AccountRow,
  | "note"
  | "local_fields"
  | "verified_links"
  | "attachment"
  | "moved_to_account_id"
  | "locked"
  | "avatar_description"
  | "header_description"
  | "show_featured"
  | "show_media"
  | "show_media_replies"
> & {
  locked: number | null;
  show_featured: number | null;
  show_media: number | null;
  show_media_replies: number | null;
};

// The moved-to accounts of `rows` that are available (an unavailable one shows `moved: null`, its target not read),
// each target read once by its key; a target that is not stored, or whose domain passes DOMAIN_BYTES, is not returned.
function movedOf(db: Db, rows: readonly AccountRow[]): ReadonlyMap<string, MovedRow> {
  const targets = [
    ...new Set(
      rows.flatMap((row) => (row.available === 1 && row.moved_to_account_id !== null ? [row.moved_to_account_id] : [])),
    ),
  ];
  if (targets.length === 0) {
    return new Map();
  }
  return new Map(
    db
      .all<MovedRow>(
        `SELECT ${selectSql(MOVED_ACCOUNT_COLUMNS.columns)} FROM json_each(?1) c
				CROSS JOIN accounts m INDEXED BY ${ACCOUNTS_ID_INDEX} ON m.id = c.value
				LEFT JOIN local_accounts ml INDEXED BY ${LOCAL_ACCOUNTS_ID_INDEX} ON ml.account_id = m.id
				WHERE m.domain IS NULL OR length(CAST(m.domain AS BLOB)) <= ${DOMAIN_BYTES}`,
        JSON.stringify(targets),
      )
      .map((row) => [row.id, row]),
  );
}

// What a chunk of accounts shows besides its rows, read once for the chunk: the moved-to accounts (movedOf), and of
// the accounts and their targets the cached profile images (remote-media.ts cachedImagesOf, one seek a slot, outside
// the row heap) and the viewer's feature_approval answers (featureApprovalReads, one statement).
type Related = {
  moved: ReadonlyMap<string, MovedRow>;
  cached: CachedImages;
  approvals: ReadonlyMap<string, FeatureApproval>;
};

function relatedOf(db: Db, rows: readonly AccountRow[], viewerId: string | null): Related {
  const moved = movedOf(db, rows);
  const ids = [...rows.map((row) => row.id), ...moved.keys()];
  return { moved, cached: cachedImagesOf(db, ids), approvals: featureApprovalReads(db, ids, viewerId) };
}

export { DISPLAY_NAME_LIMIT, PROFILE_URL_LIMIT, USERNAME_LIMIT };

// The accounts `a` a statement names by id (a.id = ? or a membership of ids), each sought by its key with its local row
// (RES-7).
export const ACCOUNT_FROM = `accounts a INDEXED BY ${ACCOUNTS_ID_INDEX} ${LOCAL_ROW_JOIN}`;

// An answer of many accounts (a list's members and endorsements with limit=0, familiar followers) is within
// ANSWER_BYTES, the JSON around the accounts reserved first (only its first account, bounded by RES-2, may stand
// alone past it). A Mastodon user's account serializes to about 2 KiB, so 1,000 take a quarter of it; one at
// Misskey's profile limits to about 8 KiB (test/account-answer-bytes.test.ts measures both).
// Accounts read per query while an answer is filled: what is read past the budget is at most one chunk of accounts
// at their bound (RES-2), their static images and the accounts they moved to included, 6.77 MB
// (test/status-bounds.test.ts).
export const ANSWER_CHUNK = 50;

// The presented accounts of `ids` (accounts' ids), in order, `chunk` at a time, each with its serialized size (and a
// separator), an id with no account skipped: only the profiles asked for so far are read, so the attachment projection
// runs for those alone.
function accountStream(
  db: Db,
  ids: readonly string[],
  present: Present,
  chunk = ANSWER_CHUNK,
): () => { account: Account; bytes: number } | undefined {
  const accounts = accountsOf(db, ids, present, chunk);
  return () => {
    for (let next = accounts.next(); next.done !== true; next = accounts.next()) {
      if (next.value !== undefined) {
        return { account: next.value, bytes: jsonBytes(next.value) + 1 };
      }
    }
    return undefined;
  };
}

// The presented accounts of `ids` (accounts' ids, each once), in order, while their serialized bytes stay within
// `budget`, read in chunks that stop once it is reached (admitAccounts). `leading`: the first account is shown whatever
// its size (RES-2 bounds it), so an answer continued from its last account moves on. `cut`: an account was left out,
// by the budget or for having none. `bytes`: the admitted accounts' JSON, each with a separator.
export function presentAccountsWithin(
  db: Db,
  ids: readonly string[],
  present: Present,
  budget: number,
  leading: boolean,
): { items: Account[]; cut: boolean; bytes: number } {
  const { items, bytes } = admitAccounts(db, ids, present, budget, leading);
  return { items, cut: items.length < ids.length, bytes };
}

// The presented accounts of `ids` in order (an id may repeat), for an admission (admit) of items that embed them:
// read `chunk` at a time as the stream reaches them, undefined for an id with no account. What the stream holds past
// what its consumer kept is one chunk of accounts at their bound (RES-2).
export function* accountsOf(
  db: Db,
  ids: readonly string[],
  present: Present,
  chunk = ANSWER_CHUNK,
): Generator<Account | undefined, undefined> {
  for (let next = 0; next < ids.length; next += chunk) {
    const slice = ids.slice(next, next + chunk);
    const read = accountRowsOf(db, [...new Set(slice)]);
    // The chunk's moved-to accounts and cached images in one read each; a target is presented only with its source.
    const related = relatedOf(db, read, present.viewerId);
    const rows = new Map(read.map((row) => [row.id, row]));
    for (const id of slice) {
      const row = rows.get(id);
      yield row === undefined ? undefined : presentAccount(db, row, present, related);
    }
  }
}

// REST::PartialAccountSerializer (grouped notifications' partial_accounts), each key as Account presents it.
export type PartialAccount = {
  id: string;
  acct: string;
  locked: boolean;
  bot: boolean;
  url: string;
  avatar: string;
  avatar_static: string;
  avatar_description: string;
};

type PartialRow = Pick<AccountRow, "id" | "uri" | "username" | "domain" | "actor_type" | "url" | "avatar_url"> &
  Pick<AccountRow, "avatar_static_url" | "avatar_description" | "locked" | "available">;

// The partial accounts of `ids` in order (an id may repeat), as presentAccount shows those fields, reading only their
// columns, `chunk` at a time as the stream reaches them; undefined for an id with no account.
export function* partialAccountsOf(
  db: Db,
  ids: readonly string[],
  present: PresentInput,
  chunk = ANSWER_CHUNK,
): Generator<PartialAccount | undefined, undefined> {
  for (let next = 0; next < ids.length; next += chunk) {
    const slice = ids.slice(next, next + chunk);
    const rows = new Map(
      db
        .all<PartialRow>(
          `SELECT a.id, ${actorUriSql("a.uri")} AS uri, ${usernameSql("a.username")} AS username, a.domain, a.actor_type,
						a.url, a.avatar_url, a.avatar_static_url, a.avatar_description, a.locked,
						${availableJoinedSql("a", "l")} AS available
					FROM json_each(?1) c CROSS JOIN accounts a INDEXED BY ${ACCOUNTS_ID_INDEX} ON a.id = c.value
					${LOCAL_ROW_JOIN}`,
          JSON.stringify([...new Set(slice)]),
        )
        .map((row) => [row.id, row]),
    );
    const cached = cachedImagesOf(db, [...rows.keys()]);
    for (const id of slice) {
      const row = rows.get(id);
      if (row === undefined) {
        yield undefined;
        continue;
      }
      const suspended = row.available === 0;
      const avatar = shownImage(
        ACCOUNT_BOUNDS,
        suspended ? null : row.avatar_url,
        row.avatar_static_url,
        `${present.origin}${DEFAULT_AVATAR}`,
        cachedImageUrls(cached.get(row.id)?.avatar ?? null, present.origin),
      );
      yield {
        id: row.id,
        acct: acctOf(row),
        locked: !suspended && row.locked === 1,
        bot: !suspended && isBotActorType(row.actor_type),
        url: accountUrl(row, present.origin),
        avatar: avatar.image,
        avatar_static: avatar.still,
        avatar_description: suspended ? "" : presentedProfileDescription(row.avatar_description),
      };
    }
  }
}

// Admission of accounts (RES-3, admit): the accounts of `ids` in traversal order while their JSON fits `budget`, read
// in chunks of ANSWER_CHUNK; an id with no account is consumed.
export function admitAccounts(
  db: Db,
  ids: readonly string[],
  present: Present,
  budget: number,
  leading: boolean,
): Admitted<Account> {
  return admit(accountsOf(db, ids, present), budget, leading);
}

// An account's profile URL. A stored url is used only when it is http(s) (HTML-3). A remote account's is otherwise its
// actor id (profile-bounds.ts remoteAccountUrl), as Mastodon stores `url || @uri` (process_account_service.rb:228) and
// REST::AccountSerializer#url falls back to uri_for. An invalidated handle (shownHandle) names no page, so such an
// account's is its stored url, else its actor id, as Mastodon's url_for, else ''. Any other is derived from the actor
// id, which carries the account's origin (a local account's carries the instance origin), or from this instance's
// origin when the id is not http(s) either.
// Each is used only within PROFILE_URL_LIMIT as serialized (RES-2): a longer one falls back to the next, and to '' when
// none fits (a converted row of a long host and name). `href` bounds each: a nested moved-to account's are
// MOVED_BOUNDS'.
export function accountUrl(
  row: { id: string; url: string | null; uri: string; username: string; domain: string | null },
  origin: string,
  href = ACCOUNT_BOUNDS.href,
): string {
  const stored = row.domain === null ? href(row.url) : remoteAccountUrl(row, href);
  if (stored !== null) {
    return stored;
  }
  const handle = shownHandle(row);
  if (handle.invalid) {
    return "";
  }
  const actor = httpUrl(row.uri);
  return (actor === null ? null : href(`${actor.origin}/@${row.username}`)) ?? href(`${origin}/@${handle.acct}`) ?? "";
}

// How a presenter bounds an account's URLs and actor id (RES-2): `href` serializes an http(s) URL within its bound or
// gives null, `image` does so for an image or its static within the bound as JSON writes it too, and `uri` is the
// actor id's bound, in UTF-8 bytes as JSON writes it.
type IdentityBounds = {
  href: (value: string | null) => string | null;
  image: (value: string | null) => string | null;
  uri: number;
};

// A serialized URL may keep a '\' in its query or fragment, which JSON doubles: within `limit` as JSON too.
function jsonHref(value: string | null, limit: number): string | null {
  const href = boundedHref(value, limit);
  return href !== null && withinIdentityBound(href, limit) ? href : null;
}

const ACCOUNT_BOUNDS: IdentityBounds = {
  href: (value) => boundedHref(value, PROFILE_URL_LIMIT),
  image: (value) => jsonHref(value, PROFILE_URL_LIMIT),
  uri: ACTOR_URI_LIMIT,
};

const MOVED_BOUNDS: IdentityBounds = {
  href: (value) => jsonHref(value, MOVED_URL_LIMIT),
  image: (value) => jsonHref(value, MOVED_URL_LIMIT),
  uri: MOVED_URL_LIMIT,
};

// An image as an account shows it with its static (Mastodon's avatar and avatar_static, header and header_static):
// both `fallback` unless the image is shown (null: unavailable or unset); then a remote account's cached copy on the
// instance origin when there is one for its current URL (`cached`: the full file and its still, or the full file when
// it has none), else the static when it is shown too, else the image. Each is shown within `bounds.image`.
function shownImage<F extends string | null>(
  bounds: IdentityBounds,
  image: string | null,
  still: string | null,
  fallback: F,
  cached: { image: string; still: string } | null,
): { image: string | F; still: string | F } {
  const href = bounds.image(image);
  if (href === null) {
    return { image: fallback, still: fallback };
  }
  const local = cached === null ? null : bounds.image(cached.image);
  if (local !== null && cached !== null) {
    return { image: local, still: bounds.image(cached.still) ?? local };
  }
  return { image: href, still: bounds.image(still) ?? href };
}

// The domain of an invalidated handle's address (Account#pretty_acct): reserved (RFC 6761), so it names no server.
const INVALID_HANDLE_DOMAIN = "handle.invalid";

// How every presenter shows an account's username and acct (Mastodon's pretty_username and pretty_acct). A remote
// account whose handle another account has taken is invalidated: its stored username starts with '! ' (Mastodon's
// invalidated_username?), which no username Kopje matches by address can (addressRow), and it shows its id as
// username and `<id>@handle.invalid` as acct, within the bounds a valid row's fill (accounts.id is 18 digits, the
// CHECK of 0000_initial). A local account is never invalidated. `row.username` is the read's projection
// (usernameSql), whose cut keeps the prefix.
export function shownHandle(row: { id: string; username: string; domain: string | null }): {
  username: string;
  acct: string;
  invalid: boolean;
} {
  if (row.domain !== null && row.username.startsWith("! ")) {
    return { username: row.id, acct: `${row.id}@${INVALID_HANDLE_DOMAIN}`, invalid: true };
  }
  return {
    username: row.username,
    acct: row.domain === null ? row.username : `${row.username}@${row.domain}`,
    invalid: false,
  };
}

export function acctOf(row: { id: string; username: string; domain: string | null }): string {
  return shownHandle(row).acct;
}

// An unavailable account (R1: suspended, or a remote account whose deletion has started, as the row's query read it
// live) is shown redacted, as Mastodon's REST::AccountSerializer shows an unavailable one: no display name, note,
// fields, emojis or image descriptions, the default avatar and header, locked, bot, discoverable and indexable false,
// and `suspended: true`. The uri, noindex and the display settings are shown as for an available one, as Mastodon shows
// them. `moved`: the account it moved to, from `moved` (movedOf), absent when it names none Kopje reads, null while it
// is unavailable.
function presentAccount(db: Db, row: AccountRow, { origin }: Present, related: Related): Account {
  const { moved } = related;
  const target = row.moved_to_account_id === null ? undefined : moved.get(row.moved_to_account_id);
  return {
    ...presentIdentity(db, row, origin, ACCOUNT_BOUNDS, related, () => ({
      display_name: presentedDisplayName(row.display_name),
      note: presentedNote(row.note),
      avatar_description: presentedProfileDescription(row.avatar_description),
      header_description: presentedProfileDescription(row.header_description),
      emojis: presentEmojis(row.emojis, ACCOUNT_EMOJIS_BYTES, emojiCacheOf(row.emoji_cache, origin)),
      fields:
        row.domain === null ? localFields(row).map(presentField) : remoteFields(row.attachment, row.remote_verified),
    })),
    ...(row.moved_to_account_id === null
      ? {}
      : row.available === 0
        ? { moved: null }
        : target === undefined
          ? {}
          : { moved: presentMovedAccount(db, target, origin, related) }),
  };
}

// A moved-to account nested in Account#moved (MOVED_ACCOUNT_COLUMNS): every text within its decoded limit, no note,
// fields or image descriptions, and the emojis its display name references while their JSON fits MOVED_EMOJIS_BYTES. It
// never shows a `moved` of its own (Mastodon's AccountDecorator#moved? is false).
function presentMovedAccount(db: Db, row: MovedRow, origin: string, related: Related): Account {
  const displayName = cutCodePoints(row.display_name, MOVED_DISPLAY_NAME_LIMIT);
  const cut = {
    ...row,
    username: cutCodePoints(row.username, USERNAME_LIMIT),
    created_at: cutCodePoints(row.created_at, MOVED_CREATED_AT_LIMIT),
    last_status_at: row.last_status_at === null ? null : cutCodePoints(row.last_status_at, MOVED_LAST_STATUS_AT_LIMIT),
  };
  return presentIdentity(db, cut, origin, MOVED_BOUNDS, related, () => ({
    display_name: displayName,
    note: "",
    avatar_description: "",
    header_description: "",
    emojis: referencedEmojis(row.emojis, [displayName], MOVED_EMOJIS_BYTES, emojiCacheOf(row.emoji_cache, origin)),
    fields: [],
  }));
}

// The texts an account shows only while it is available.
type ProfileText = Pick<
  Account,
  "display_name" | "note" | "avatar_description" | "header_description" | "emojis" | "fields"
>;

// The keys an account shows, its URLs and actor id within `bounds`; `profile`, of an available account only.
function presentIdentity(
  db: Db,
  row: MovedRow,
  origin: string,
  bounds: IdentityBounds,
  { cached, approvals }: Related,
  profile: () => ProfileText,
): Account {
  const suspended = row.available === 0;
  const url = accountUrl(row, origin, bounds.href);
  const own = cached.get(row.id);
  const avatar = shownImage(
    bounds,
    suspended ? null : row.avatar_url,
    row.avatar_static_url,
    `${origin}${DEFAULT_AVATAR}`,
    cachedImageUrls(own?.avatar ?? null, origin),
  );
  const header = shownImage(
    bounds,
    suspended ? null : row.header_url,
    row.header_static_url,
    `${origin}${DEFAULT_HEADER}`,
    cachedImageUrls(own?.header ?? null, origin),
  );
  const shown: ProfileText = suspended
    ? { display_name: "", note: "", avatar_description: "", header_description: "", emojis: [], fields: [] }
    : profile();
  const handle = shownHandle(row);
  return {
    id: row.id,
    username: handle.username,
    acct: handle.acct,
    display_name: shown.display_name,
    locked: !suspended && row.locked === 1,
    bot: !suspended && isBotActorType(row.actor_type),
    discoverable: suspended ? false : row.discoverable === null ? null : row.discoverable === 1,
    indexable: !suspended && row.indexable === 1,
    group: row.actor_type === "Group",
    created_at: row.created_at,
    note: shown.note,
    url,
    // RES-2: the projection (actorUriSql) bounds the raw bytes, and this the escaped JSON of an imported value.
    uri: withinIdentityBound(row.uri, bounds.uri) ? row.uri : "",
    avatar: avatar.image,
    avatar_static: avatar.still,
    avatar_description: shown.avatar_description,
    header: header.image,
    header_static: header.still,
    header_description: shown.header_description,
    followers_count: row.followers_count,
    following_count: row.following_count,
    statuses_count: row.statuses_count,
    last_status_at: row.last_status_at,
    hide_collections: row.hide_collections === null ? null : row.hide_collections === 1,
    show_media: row.show_media !== 0,
    show_media_replies: row.show_media_replies !== 0,
    show_featured: row.show_featured !== 0,
    emojis: shown.emojis,
    fields: shown.fields,
    // The admin is looked up only for an available local account, once per operation (adminAccountIdOnce).
    ...(row.domain === null
      ? { noindex: false, roles: !suspended && adminAccountIdOnce(db) === row.id ? [OWNER_BADGE] : [] }
      : {}),
    ...(suspended ? { suspended: true as const } : {}),
    feature_approval: {
      automatic: row.domain === null && row.discoverable === 1 ? [row.locked === 1 ? "followers" : "public"] : [],
      manual: [],
      current_user: approvals.get(row.id) ?? "denied",
    },
    ...(handle.invalid ? { invalid_handle: true as const } : {}),
  };
}

// One account with its moved-to account, read for it alone.
function presentOne(db: Db, row: AccountRow, present: Present): Account {
  return presentAccount(db, row, present, relatedOf(db, [row], present.viewerId));
}

// Stored local fields as every path presents them (the Account, source.fields and the actor's attachments), read
// through presentedLocalFieldsSql: none for a value that is not a JSON array; else of its first MAX_FIELDS elements,
// those that are a name and a value of strings within MAX_FIELD_NAME and MAX_FIELD_VALUE code points (the writer's
// limits), in their order. Only an imported row can hold anything else (docs/mastodon-deviations.md, Accounts). Never
// throws.
export function fieldSources(stored: string | null): FieldSource[] {
  if (stored === null) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return [];
  }
  return (Array.isArray(parsed) ? (parsed as unknown[]).slice(0, MAX_FIELDS) : []).flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) {
      return [];
    }
    const { name, value } = entry as Record<string, unknown>;
    return typeof name === "string" &&
      typeof value === "string" &&
      cutCodePoints(name, MAX_FIELD_NAME) === name &&
      cutCodePoints(value, MAX_FIELD_VALUE) === value
      ? [{ name, value }]
      : [];
  });
}

export const VERIFIED_AT_JSON_BYTES = 31;

// Presented verification times of a stored JSON array of [key, time] pairs, by key: each an ISO time (isIsoTime) with Z
// written +00:00, a later pair of the same key replacing an earlier one. A value that does not parse, or an entry whose
// key `isKey` refuses or whose time is not one, is skipped; the presenter never throws on a stored value.
function presentedTimes<K>(stored: string | null, isKey: (key: unknown) => key is K): Map<K, string> {
  const times = new Map<K, string>();
  if (stored === null) {
    return times;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return times;
  }
  for (const entry of Array.isArray(parsed) ? (parsed as unknown[]) : []) {
    if (Array.isArray(entry) && isKey(entry[0]) && typeof entry[1] === "string" && isIsoTime(entry[1])) {
      times.set(entry[0], `${entry[1].slice(0, -1)}+00:00`);
    }
  }
  return times;
}

const isText = (key: unknown): key is string => typeof key === "string";
const isIndex = (key: unknown): key is number => Number.isSafeInteger(key);

// The times of stored verified_links, by value.
function verifiedTimes(stored: string | null): Map<string, string> {
  return presentedTimes(stored, isText);
}

// A local account's fields with their verification times (a field whose value is verified shows it: Mastodon keeps
// verified_at per field and carries it over while the value stays). Against null, a verified field presents
// VERIFIED_AT_JSON_BYTES - 4 more JSON bytes: at most 108 per Account and 216 per CredentialAccount (fields and
// source.fields), test/field-links.test.ts ("presents at most VERIFIED_AT_JSON_BYTES more per verified field").
function localFields(
  row: Pick<AccountRow, "local_fields" | "verified_links">,
): (FieldSource & { verified_at: string | null })[] {
  const times = verifiedTimes(row.verified_links);
  return fieldSources(row.local_fields).map((field) => ({ ...field, verified_at: times.get(field.value) ?? null }));
}

// HTML-2: the name stays plain text (JSON consumers escape it); the value is escaped and its URLs linked.
function presentField(field: FieldSource & { verified_at: string | null }): Field {
  return { name: field.name, value: renderFieldValue(field.value), verified_at: field.verified_at };
}

// The fields shown, in document order, while the JSON of their names and values, in UTF-8 bytes, stays within
// REMOTE_FIELDS_BYTES: the first field that would pass it is dropped with all after it, never cut. This bounds what is
// returned and serialized, as REMOTE_ATTACHMENT_SQL bounds what is read (sanitizing can grow a value fivefold, `&` to
// `&amp;`). A response of N accounts thus carries at most N × 32 KiB of field names and values once serialized. Each
// with its entry's `src` (remoteAttachmentSql's eligibility), when it has one.
function remoteFieldEntries(
  attachment: string | null,
  verified: ReadonlyMap<number, string> = new Map(),
): { field: Field; src: string | null }[] {
  if (attachment === null) {
    return [];
  }
  const fields: { field: Field; src: string | null }[] = [];
  let bytes = 0;
  for (const [index, entry] of (JSON.parse(attachment) as { name: string; value: string; src?: string }[]).entries()) {
    // Account::Field#sanitize: each stripped as Ruby's String#strip strips, then cut, after the projection's cut
    // (REMOTE_ATTACHMENT_SQL; mastodon-deviations.md, Accounts).
    const name = rubyStrip(entry.name).slice(0, FIELD_NAME_LIMIT);
    const raw = rubyStrip(entry.value).slice(0, FIELD_VALUE_RAW_LIMIT);
    const time = verified.get(index);
    const href = time === undefined ? null : remoteFieldLink(raw);
    const value = href === null ? sanitizeRemoteHtml(raw) : linkHtml(href);
    bytes += jsonBytes(name) + jsonBytes(value);
    if (bytes > REMOTE_FIELDS_BYTES) {
      break;
    }
    fields.push({
      field: { name, value, verified_at: href === null ? null : (time ?? null) },
      src: typeof entry.src === "string" ? entry.src : null,
    });
  }
  return fields;
}

// A remote account's fields as presented: a field at an index with a verification time (REMOTE_VERIFIED_SQL) shows
// it, and its value as Mastodon's shortened link of its href, while its value still derives that link
// (remoteFieldLink, over the projected value: an eligible one is at most REMOTE_FIELD_SOURCE_BYTES, so never cut); else
// null and its sanitized value (an imported time at an index that derives no link). Never throws on a stored value.
function remoteFields(attachment: string | null, remoteVerified: string | null = null): Field[] {
  return remoteFieldEntries(attachment, remoteVerifiedTimes(remoteVerified)).map(({ field }) => field);
}

// The times of REMOTE_VERIFIED_SQL's projection, by index.
function remoteVerifiedTimes(stored: string | null): Map<number, string> {
  return presentedTimes(stored, isIndex);
}

// The fields a remote account whose document is `raw` will show, chosen and cut as presentation chooses and cuts them
// (REMOTE_ATTACHMENT_SQL over the document, then remoteFields): what the account's emoji snapshot is scanned over.
// `links`: the [index, href] of the first REMOTE_VERIFIED_SHOWN shown fields whose original value remoteFieldLink
// accepts, in shown order: what remote-field-links.ts tracks.
export function presentedRemoteFields(
  db: Db,
  raw: string,
  domain: string,
): { fields: Field[]; links: [number, string][] } {
  const row = db.first<{ attachment: string | null }>(
    `SELECT ${remoteAttachmentSql({ eligibility: true })} AS attachment FROM (SELECT ?1 AS raw, ?2 AS domain) a`,
    raw,
    domain,
  );
  const entries = remoteFieldEntries(row?.attachment ?? null);
  const links = entries
    .flatMap(({ src }, index): [number, string][] => {
      const href = src === null ? null : remoteFieldLink(src);
      return href === null ? [] : [[index, href]];
    })
    .slice(0, REMOTE_VERIFIED_SHOWN);
  return { fields: entries.map(({ field }) => field), links };
}

// API ids are 18 digits; legacy ids are UUIDs or other short strings. Anything longer is not an id.
const MAX_ID_LENGTH = 64;

// Resolves an API id or a legacy id (the table's legacy_id) to the API id.
export function resolveApiId(db: Db, table: "accounts" | "statuses", id: string): string | null {
  if (id === "" || id.length > MAX_ID_LENGTH) {
    return null;
  }
  const row =
    db.first<{ id: string }>(`SELECT id FROM ${table} WHERE id = ?`, id) ??
    db.first<{ id: string }>(`SELECT id FROM ${table} WHERE legacy_id = ?`, id);
  return row?.id ?? null;
}

export function resolveAccountId(db: Db, id: string): string | null {
  return resolveApiId(db, "accounts", id);
}

// The account GET /api/v1/accounts/:id and every /api/v1/accounts/:id/... route names (R1's account reads, foundSql):
// resolveAccountId's, unless its deletion has started, as Mastodon 4.7's AccountsController and
// Accounts::BaseController find it (Account.without_requested_deletion). One more read of the account's row by key.
export function routeAccountId(db: Db, id: string): string | null {
  const resolved = resolveAccountId(db, id);
  return resolved !== null &&
    db.first(`SELECT 1 AS found FROM accounts a WHERE a.id = ? AND ${foundSql("a")}`, resolved) !== undefined
    ? resolved
    : null;
}

// Presented accounts by id, read in one query, those found (foundSql): for getAccounts' MAX_ACCOUNTS_BY_ID only.
function presentAccountsById(db: Db, ids: readonly string[], present: Present): Map<string, Account> {
  const rows = db.all<AccountRow>(
    `SELECT ${selectSql(ACCOUNT_COLUMN_MAP)} FROM ${ACCOUNT_FROM}
		WHERE a.id IN (SELECT value FROM json_each(?1)) AND ${foundSql("a")}`,
    JSON.stringify([...new Set(ids)]),
  );
  const related = relatedOf(db, rows, present.viewerId);
  return new Map(rows.map((row) => [row.id, presentAccount(db, row, present, related)]));
}

// One presented account by id, bounded as a unit (RES-2); undefined for an id with no account.
export function presentAccountById(db: Db, id: string, present: Present): Account | undefined {
  const row = accountRow(db, id);
  return row === undefined ? undefined : presentOne(db, row, present);
}

function accountRow(db: Db, id: string): AccountRow | undefined {
  return db.first<AccountRow>(`SELECT ${selectSql(ACCOUNT_COLUMN_MAP)} FROM ${ACCOUNT_FROM} WHERE a.id = ?`, id);
}

// GET /api/v1/accounts/:id, and the API's other reads of one account by id. credential: the token an anonymous route
// was sent (AUTH-2), whose suspended owner is refused first.
export const getAccount = readOperation<
  { id: string; present: PresentInput; credential: Credential | null },
  Judged<Account | null>
>((db, { id, present, credential }) =>
  unlessSuspended(db, credential, (viewerId) => {
    const resolved = routeAccountId(db, id);
    return resolved === null ? null : (presentAccountById(db, resolved, presentFor(present, viewerId)) ?? null);
  }),
);

// GET /api/v1/accounts?id[]= (AccountsController#index): the accounts getAccount shows one by one, read in one query,
// in the order asked, each once; an id that names no account, or one getAccount does not find, is left out. Kopje has
// no unapproved accounts (`without_unapproved`). The caller limits the ids (MAX_ACCOUNTS_BY_ID). A suspended owner of
// the token sent is refused first (AUTH-2's anonymous routes).
export const MAX_ACCOUNTS_BY_ID = 40;

export const getAccounts = readOperation<
  { ids: string[]; present: PresentInput; credential: Credential | null },
  Judged<Account[]>
>((db, { ids, present, credential }) =>
  unlessSuspended(db, credential, (viewerId) => {
    const resolved = [...new Set(ids.slice(0, MAX_ACCOUNTS_BY_ID).flatMap((id) => resolveAccountId(db, id) ?? []))];
    const accounts = presentAccountsById(db, resolved, presentFor(present, viewerId));
    return resolved.flatMap((id) => accounts.get(id) ?? []);
  }),
);

// The account an address names, domain null for a local one, matched case-insensitively as Mastodon's
// Account.find_remote: by accounts_local_username or accounts_domain_username, named so the seek does not rest on the
// Store's statistics (RES-7), as is the account's local row. stored_username is the username as stored, not
// usernameSql's projection: a matching row's username has the bytes of `username` (SQLite's lower changes ASCII
// letters only), so it is bounded by the caller's. At most one remote row holds an address (the UNIQUE
// accounts_domain_username, 0096_remote_handles), so at most one row matches. Only a username of Mastodon's format
// (isRemoteUsername, which every LOCAL_USERNAME is too) names an account, so an invalidated handle ('! <id>',
// shownHandle) is never matched by an address. found: whether the account reads find it (foundSql).
function addressRow(
  db: Db,
  username: string,
  domain: string | null,
): (AccountRow & { stored_username: string; found: number }) | undefined {
  if (!isRemoteUsername(username)) {
    return undefined;
  }
  return domain === null
    ? db.first(
        `SELECT ${selectSql(ACCOUNT_COLUMN_MAP)}, a.username AS stored_username, ${foundSql("a")} AS found
				FROM accounts a INDEXED BY accounts_local_username
				${LOCAL_ROW_JOIN}
				WHERE a.domain IS NULL AND lower(a.username) = lower(?) LIMIT 1`,
        username,
      )
    : db.first(
        `SELECT ${selectSql(ACCOUNT_COLUMN_MAP)}, a.username AS stored_username, ${foundSql("a")} AS found
				FROM accounts a INDEXED BY accounts_domain_username
				${LOCAL_ROW_JOIN}
				WHERE a.domain = ? AND lower(a.username) = lower(?) LIMIT 1`,
        domain,
        username,
      );
}

// The presented account an address names (an unavailable one redacted, VIS-30), or null when none does.
export function accountByAddress(db: Db, username: string, domain: string | null, present: Present): Account | null {
  const row = addressRow(db, username, domain);
  return row === undefined ? null : presentOne(db, row, present);
}

// The id of the account an address names (addressRow), whether the account reads find it or not.
export function accountIdByAddress(db: Db, username: string, domain: string | null): string | undefined {
  return addressRow(db, username, domain)?.id;
}

// The address of the account an address names, as stored: `username`, or `username@domain` for a remote one.
export function storedAddress(db: Db, username: string, domain: string | null): string | null {
  const row = addressRow(db, username, domain);
  return row === undefined ? null : row.domain === null ? row.stored_username : `${row.stored_username}@${row.domain}`;
}

// POST /api/v1/accounts/:account_id/email_subscriptions with e-mail subscriptions off (MD-3): Mastodon's
// require_not_suspended! reads a sent token first, then set_account finds the id among local accounts
// (Account.local.find), suspended ones included. Only a held token of a suspended user counts, expired or not (AUTH-1's
// order); any other token reads as none (AUTH-2's exception). At most four unique-key lookups: the token, the id (twice at most) and its
// local row.
export const emailSubscriptionTarget = readOperation<
  { credential: Credential | null; id: string },
  "suspended" | "missing" | "local"
>((db, { credential, id }) => {
  if (refuseSuspended(db, credential) !== null) {
    return "suspended";
  }
  const resolved = resolveAccountId(db, id);
  const local =
    resolved === null ? undefined : db.first("SELECT 1 AS local FROM local_accounts WHERE account_id = ?", resolved);
  return local === undefined ? "missing" : "local";
});

// The presented account an address names as lookup finds it (an unavailable one redacted, VIS-30), or null: by
// address, but `<id>@handle.invalid` names the remote account of that id while its handle is invalidated (shownHandle;
// Mastodon's ResolveAccountService special case), one primary-key seek; none when the account reads do not find it
// (foundSql: Mastodon 4.7's LookupController answers 404 for a deleted account). `domain` is normalized.
export function accountByLookup(db: Db, username: string, domain: string | null, present: Present): Account | null {
  if (domain !== INVALID_HANDLE_DOMAIN) {
    const row = addressRow(db, username, domain);
    return row === undefined || row.found !== 1 ? null : presentOne(db, row, present);
  }
  // The prefix is a prefilter; shownHandle decides on the row as presented.
  const row = db.first<AccountRow>(
    `SELECT ${selectSql(ACCOUNT_COLUMN_MAP)} FROM ${ACCOUNT_FROM}
			WHERE a.id = ? AND a.domain IS NOT NULL AND substr(a.username, 1, 2) = '! ' AND ${foundSql("a")}`,
    username,
  );
  return row === undefined || !shownHandle(row).invalid ? null : presentOne(db, row, present);
}

// GET /api/v1/accounts/lookup: domain null means a local account. credential: the token an anonymous route was sent
// (AUTH-2), whose suspended owner is refused first; null for a public page.
export const lookupAccount = readOperation<
  { username: string; domain: string | null; present: PresentInput; credential: Credential | null },
  Judged<Account | null>
>((db, { username, domain, present, credential }) =>
  unlessSuspended(db, credential, (viewerId) =>
    accountByLookup(
      db,
      username,
      domain === null ? null : (normalizeDomain(domain) ?? domain.toLowerCase()),
      presentFor(present, viewerId),
    ),
  ),
);

// source.follow_requests_count: Mastodon 4.5.21 counts at most 40 requests of accounts that are not suspended
// (credential_account_serializer.rb:17). Kopje counts, among the newest readWindow(FOLLOW_REQUESTS_COUNT) pending
// requests (follows_target, as listFollowRequests' first page reads them), those of available requesters (R1), at
// most FOLLOW_REQUESTS_COUNT (docs/mastodon-deviations.md, "Accounts").
export const FOLLOW_REQUESTS_COUNT = 40;

type CredentialRow = {
  default_visibility: Visibility;
  default_sensitive: number;
  default_language: string | null;
  default_quote_policy: QuotePolicyName;
  attribution_domains: string;
  follow_requests_count: number;
};

export function credentialAccount(db: Db, accountId: string, present: Present): CredentialAccount | null {
  const row = accountRow(db, accountId);
  const local = db.first<CredentialRow>(
    `SELECT default_visibility, default_sensitive, default_language, default_quote_policy,
			${attributionDomainsSql("attribution_domains")} AS attribution_domains,
			(SELECT COUNT(*) FROM (SELECT f.account_id FROM follows f
					WHERE f.target_account_id = ?1 AND f.state = 'pending' ORDER BY f.id DESC LIMIT ?2) w
				CROSS JOIN accounts a INDEXED BY ${ACCOUNTS_ID_INDEX} ON a.id = w.account_id ${LOCAL_ROW_JOIN}
				WHERE ${availableJoinedSql("a", "l")}) AS follow_requests_count
		FROM local_accounts WHERE account_id = ?1`,
    accountId,
    readWindow(FOLLOW_REQUESTS_COUNT),
  );
  if (row === undefined || local === undefined) {
    return null;
  }
  return {
    ...presentOne(db, row, present),
    source: {
      privacy: local.default_visibility,
      sensitive: local.default_sensitive === 1,
      language: local.default_language,
      note: htmlToPlainText(presentedNote(row.note)),
      fields: localFields(row),
      follow_requests_count: Math.min(local.follow_requests_count, FOLLOW_REQUESTS_COUNT),
      hide_collections: row.hide_collections === 1,
      discoverable: row.discoverable === null ? null : row.discoverable === 1,
      indexable: row.indexable === 1,
      attribution_domains: presentedAttributionDomains(local.attribution_domains),
      quote_policy: local.default_quote_policy,
    },
    // The OAuth admin has the Owner role with the permissions Kopje serves; every other user the default role.
    role: localRole(db, accountId),
  };
}

// REST::ProfileSerializer (/api/v1/profile, Mastodon 4.6): the token's own account as its owner edits it, the texts
// as written and as formatted. Only its current, functional user reaches it, so nothing is redacted.
export type Profile = {
  id: string;
  display_name: string;
  // The note as written (source.note's), and as the Account formats it.
  note: string;
  fields: (FieldSource & { verified_at: string | null })[];
  formatted_note: string;
  formatted_fields: Field[];
  // null unless the account has the image (Mastodon's `*_file_name.present?`), never the default image.
  avatar: string | null;
  avatar_static: string | null;
  avatar_description: string;
  header: string | null;
  header_static: string | null;
  header_description: string;
  locked: boolean;
  bot: boolean;
  hide_collections: boolean;
  discoverable: boolean | null;
  indexable: boolean;
  show_media: boolean;
  show_media_replies: boolean;
  show_featured: boolean;
  attribution_domains: string[];
  featured_tags: FeaturedTag[];
};

// The Profile of the local account `accountId`, with `featuredTags` (account-actions.ts reads them: featured-tags.ts
// imports this module); null when it has no local row. Each text through the bound every Account presenter applies
// after decoding (presentedDisplayName, presentedNote, presentedProfileDescription; presentedAttributionDomains over
// attributionDomainsSql's projection, read by key from local_accounts).
export function presentProfile(db: Db, accountId: string, featuredTags: FeaturedTag[]): Profile | null {
  const row = accountRow(db, accountId);
  const local = db.first<{ attribution_domains: string }>(
    `SELECT ${attributionDomainsSql("attribution_domains")} AS attribution_domains
			FROM local_accounts INDEXED BY ${LOCAL_ACCOUNTS_ID_INDEX} WHERE account_id = ?`,
    accountId,
  );
  if (row === undefined || local === undefined) {
    return null;
  }
  const note = presentedNote(row.note);
  const fields = localFields(row);
  const avatar = shownImage(ACCOUNT_BOUNDS, row.avatar_url, row.avatar_static_url, null, null);
  const header = shownImage(ACCOUNT_BOUNDS, row.header_url, row.header_static_url, null, null);
  return {
    id: row.id,
    display_name: presentedDisplayName(row.display_name),
    note: htmlToPlainText(note),
    fields,
    formatted_note: note,
    formatted_fields: fields.map(presentField),
    avatar: avatar.image,
    avatar_static: avatar.still,
    avatar_description: presentedProfileDescription(row.avatar_description),
    header: header.image,
    header_static: header.still,
    header_description: presentedProfileDescription(row.header_description),
    locked: row.locked === 1,
    bot: isBotActorType(row.actor_type),
    hide_collections: row.hide_collections === 1,
    discoverable: row.discoverable === null ? null : row.discoverable === 1,
    indexable: row.indexable === 1,
    show_media: row.show_media !== 0,
    show_media_replies: row.show_media_replies !== 0,
    show_featured: row.show_featured !== 0,
    attribution_domains: presentedAttributionDomains(local.attribution_domains),
    featured_tags: featuredTags,
  };
}

export const verifyCredentials = userReadOperation<{ present: PresentInput }, CredentialAccount | null>(
  (db, { present }, viewer) => credentialAccount(db, viewer.accountId, presentFor(present, viewer.accountId)),
);

// GET /oauth/userinfo (Mastodon's OAuthUserinfoSerializer): OpenID Connect claims of the token's own account, with the
// display name, profile URL and avatar as the account presenter shows them.
export type Userinfo = {
  iss: string;
  sub: string;
  name: string;
  preferred_username: string;
  profile: string;
  picture: string;
};

export const userinfo = userReadOperation<{ present: PresentInput }, Userinfo | null>((db, { present }, viewer) => {
  const row = accountRow(db, viewer.accountId);
  if (row === undefined) {
    return null;
  }
  const account = presentOne(db, row, presentFor(present, viewer.accountId));
  return {
    iss: `${present.origin}/`,
    sub: row.uri,
    name: account.display_name,
    preferred_username: account.username,
    profile: account.url,
    picture: account.avatar,
  };
});

// GET /api/v1/preferences (Mastodon's REST::PreferencesSerializer): the posting defaults the account stores, and
// Mastodon's defaults for the reading preferences Kopje has no setting for. The language is null when none is set.
export type Preferences = {
  "posting:default:visibility": Visibility;
  "posting:default:sensitive": boolean;
  "posting:default:language": string | null;
  "posting:default:quote_policy": QuotePolicyName;
  "reading:expand:media": "default";
  "reading:expand:spoilers": false;
  "reading:autoplay:gifs": false;
};

export const preferences = userReadOperation<object, Preferences | null>((db, _input, { accountId }) => {
  const row = db.first<Omit<CredentialRow, "follow_requests_count" | "attribution_domains">>(
    "SELECT default_visibility, default_sensitive, default_language, default_quote_policy FROM local_accounts WHERE account_id = ?",
    accountId,
  );
  return row === undefined
    ? null
    : {
        "posting:default:visibility": row.default_visibility,
        "posting:default:sensitive": row.default_sensitive === 1,
        "posting:default:language": row.default_language,
        "posting:default:quote_policy": row.default_quote_policy,
        "reading:expand:media": "default",
        "reading:expand:spoilers": false,
        "reading:autoplay:gifs": false,
      };
});

type RelationshipRow = {
  id: string;
  following: string | null;
  show_reblogs: number | null;
  notify: number | null;
  languages: string | null;
  followed_by: string | null;
  blocking: number;
  blocked_by: number;
  muting: number;
  muting_notifications: number | null;
  muting_expires_at: string | null;
  domain_blocking: number;
  endorsed: number;
  note: string | null;
};

// The viewer's relationships with each account, as they stand at `now` (an expired mute no longer counts), with the
// viewer's endorsement of it and the viewer's own private note on it (Account.endorsed_map and account_note_map), each
// read through its pair key, each account sought by id from the requested ids (RES-7). `accounts` 'found' leaves out an
// account the account reads do not find (foundSql), 'available' an unavailable one (R1), read from the account's row
// and its local_accounts row by key (availableJoinedSql); 'every' leaves none out.
function relationshipsOf(
  db: Db,
  viewerId: string,
  accountIds: string[],
  now: number,
  accounts: "every" | "found" | "available" = "every",
): Relationship[] {
  const available =
    accounts === "available"
      ? `${LOCAL_ROW_JOIN}
		WHERE ${availableJoinedSql("a", "l")}`
      : accounts === "found"
        ? `WHERE ${foundSql("a")}`
        : "";
  const rows = db.all<RelationshipRow>(
    `SELECT a.id,
			fo.state AS following, fo.show_reblogs, fo.notify, fo.languages,
			fb.state AS followed_by,
			${blocksSql("?1", "a.id")} AS blocking,
			${blocksSql("a.id", "?1")} AS blocked_by,
			m.account_id IS NOT NULL AS muting, m.hide_notifications AS muting_notifications, m.expires_at AS muting_expires_at,
			${domainBlocksSql("?1", "a.id")} AS domain_blocking,
			p.account_id IS NOT NULL AS endorsed, n.comment AS note
		FROM json_each(?2) j
		CROSS JOIN accounts a INDEXED BY ${ACCOUNTS_ID_INDEX} ON a.id = j.value
		LEFT JOIN follows fo INDEXED BY follows_pair ON fo.account_id = ?1 AND fo.target_account_id = a.id
		LEFT JOIN follows fb INDEXED BY follows_pair ON fb.account_id = a.id AND fb.target_account_id = ?1
		LEFT JOIN account_pins p ON p.account_id = ?1 AND p.target_account_id = a.id
		LEFT JOIN account_notes n ON n.account_id = ?1 AND n.target_account_id = a.id
		${activeMuteJoinSql("m", "?1", "a.id", "?3")}
		${available}
		ORDER BY j.key`,
    viewerId,
    JSON.stringify(accountIds),
    new Date(now).toISOString(),
  );
  return rows.map((row) => ({
    id: row.id,
    following: row.following === "accepted",
    showing_reblogs: row.following !== null && row.show_reblogs === 1,
    notifying: row.following !== null && row.notify === 1,
    languages: row.languages === null ? null : (JSON.parse(row.languages) as string[]),
    followed_by: row.followed_by === "accepted",
    requested_by: row.followed_by === "pending",
    blocking: row.blocking === 1,
    blocked_by: row.blocked_by === 1,
    muting: row.muting === 1,
    muting_notifications: row.muting_notifications === 1,
    muting_expires_at: row.muting_expires_at,
    requested: row.following === "pending",
    domain_blocking: row.domain_blocking === 1,
    endorsed: row.endorsed === 1,
    note: row.note ?? "",
  }));
}

export const MAX_RELATIONSHIP_IDS = 100;

// `withSuspended` (Mastodon's with_suspended): absent or false leaves unavailable accounts out (R1; Mastodon's
// Account.without_suspended), true includes them with the same entry. Either way an account the account reads do not
// find has none (foundSql; Mastodon 4.7's without_requested_deletion).
export const relationships = userReadOperation<{ ids: string[]; withSuspended?: boolean }, Relationship[]>(
  (db, { ids, withSuspended }, { accountId: viewerId, now }) => {
    const resolved = ids
      .slice(0, MAX_RELATIONSHIP_IDS)
      .map((id) => resolveAccountId(db, id))
      .filter((id) => id !== null);
    return relationshipsOf(db, viewerId, [...new Set(resolved)], now, withSuspended === true ? "found" : "available");
  },
);

// GET /api/v1/accounts/familiar_followers (Mastodon's FamiliarFollowersPresenter): for each requested account, the
// accounts the viewer follows that follow it. Both follows are accepted ones (VIS-8). As Mastodon's
// FamiliarFollowersController and FamiliarFollowersPresenter: an unknown or suspended account has no entry; an account
// that hides its network has an entry with no accounts, whoever asks (the account itself included); a follower that
// hides its network, or is suspended, is left out. So is a follower the viewer filters out of lists (filteredForSql: a
// block, a mute that applies at the request time, or a block of its domain).
// Bounds (RES-3, RES-7): at most MAX_FAMILIAR_FOLLOWERS_IDS accounts. For each, the candidates are the viewer's own
// accepted follows (at most FAMILIAR_FOLLOWERS_WINDOW, through the partial index of accepted follows), each checked
// for an accepted follow of the account through the unique pair index (CROSS JOIN keeps SQLite to that order), so
// the work never grows with the account's other followers and a match is never pushed out by them. At most
// MAX_FAMILIAR_FOLLOWERS are shown, newest follow of the account first, while the answer's accounts fit
// ANSWER_BYTES, shared among the requested accounts that have followers to show (sharedAnswer); past it,
// fewer are shown (Mastodon's answer has no paging).
export const MAX_FAMILIAR_FOLLOWERS_IDS = 20;
// Above Mastodon's default follow limit (7,500), which Kopje does not enforce: a match past the viewer's first 10,000
// accepted follows (in index order, by account id) is not shown (an accepted risk).
export const FAMILIAR_FOLLOWERS_WINDOW = 10_000;
export const MAX_FAMILIAR_FOLLOWERS = 80;

export type FamiliarFollowers = { id: string; accounts: Account[] };

export const familiarFollowers = userReadOperation<{ ids: string[]; present: PresentInput }, FamiliarFollowers[]>(
  (db, { ids, present }, _viewer, { accountId: viewerId, now }) => {
    const resolved = ids
      .slice(0, MAX_FAMILIAR_FOLLOWERS_IDS)
      .map((id) => resolveAccountId(db, id))
      .filter((id) => id !== null);
    const entries = [...new Set(resolved)].flatMap((target) => {
      const row = db.first<{ hidden: number }>(
        `SELECT ${hidesCollectionsSql("?1")} AS hidden WHERE ${availableSql("?1")}`,
        target,
      );
      if (row === undefined) {
        return [];
      }
      if (row.hidden === 1) {
        return [{ id: target, followers: [] }];
      }
      const followers = db
        .all<{ id: string }>(
          `SELECT x.account_id AS id
					FROM (SELECT target_account_id FROM follows WHERE account_id = ?2 AND state = 'accepted' LIMIT ?3) mine
					CROSS JOIN follows x ON x.account_id = mine.target_account_id AND x.target_account_id = ?1 AND x.state = 'accepted'
					WHERE ${availableSql("x.account_id")} AND NOT ${hidesCollectionsSql("x.account_id")}
						AND NOT ${filteredForSql("x.account_id", "?2", "?5")}
					ORDER BY x.id DESC LIMIT ?4`,
          target,
          viewerId,
          FAMILIAR_FOLLOWERS_WINDOW,
          MAX_FAMILIAR_FOLLOWERS,
          now,
        )
        .map((row) => row.id);
      return [{ id: target, followers }];
    });
    // The answer's own JSON: brackets and each entry's id, keys and separator; accountStream counts each account's.
    const frame = entries.reduce((sum, entry) => sum + jsonBytes({ id: entry.id, accounts: [] }) + 1, 1);
    const shown = sharedAnswer(
      db,
      entries.map((entry) => entry.followers),
      presentFor(present, viewerId),
      ANSWER_BYTES - frame,
    );
    return entries.map((entry, i) => ({ id: entry.id, accounts: shown[i] ?? [] }));
  },
);

// The presented accounts of each list, in order. Each round shares what is left of `budget` (serialized bytes)
// equally among lists with accounts left; unused shares go to the next round. So list order cannot change the answer,
// and large accounts cannot crowd others out. Profiles are read one at a time: at most one unshown account per list.
function sharedAnswer(db: Db, lists: readonly (readonly string[])[], present: Present, budget: number): Account[][] {
  const streams = lists.map((ids) => accountStream(db, ids, present, 1));
  const pending = streams.map((stream) => stream());
  const shown: Account[][] = lists.map(() => []);
  let left = budget;
  for (;;) {
    const open = pending.flatMap((next, i) => (next === undefined ? [] : [i]));
    const share = Math.floor(left / Math.max(open.length, 1));
    let progress = false;
    for (const i of open) {
      let allowance = share;
      for (let next = pending[i]; next !== undefined && next.bytes <= allowance; next = pending[i]) {
        shown[i]!.push(next.account);
        allowance -= next.bytes;
        left -= next.bytes;
        pending[i] = streams[i]!();
        progress = true;
      }
    }
    if (!progress) {
      return shown;
    }
  }
}

export type SearchInput = {
  query: string;
  limit: number;
  offset: number;
  following: boolean;
  // The instance's own host: "alice@<host>" searches for the local alice.
  localDomain: string;
  present: PresentInput;
  // The account resolve=true found (remote-statuses.ts resolveSearch), shown first, as Mastodon's
  // AccountSearchService puts the exact match first, when the viewer may find it and, with `following`, follows it.
  resolvedAccountId?: string | undefined;
};

// Local and known remote accounts whose search_text contains every term (in any of its variants). An exact username
// ranks first, then local accounts. Only accounts the viewer may find are listed (findableBySql, R14): not suspended,
// and not on a domain the viewer blocks. One answer within ANSWER_BYTES (RES-3): an offset endpoint, so a cut answer
// holds fewer accounts and a client advancing by the number received continues after them.
export const searchAccounts = userReadOperation<SearchInput, Account[]>(
  (db, input, viewer) =>
    presentAccountsWithin(
      db,
      searchAccountIds(db, input, viewer.accountId),
      presentFor(input.present, viewer.accountId),
      ARRAY_ANSWER_BYTES,
      true,
    ).items,
);

// The accounts' ids: the account resolve=true found, when the viewer may find it (findableBySql, R14) and, with
// `following`, follows it (accepted; AccountSearchService#exact_match), then the search's own, within the limit.
export function searchAccountIds(db: Db, input: SearchInput, viewerId: string): string[] {
  const found = findAccountIds(db, input, viewerId);
  const resolved = input.resolvedAccountId;
  if (
    resolved === undefined ||
    db.first(
      `SELECT 1 AS found WHERE ${findableBySql("?2", "?1")} AND (?3 = 0 OR EXISTS (SELECT 1 FROM follows f
				WHERE f.account_id = ?1 AND f.target_account_id = ?2 AND f.state = 'accepted'))`,
      viewerId,
      resolved,
      input.following ? 1 : 0,
    ) === undefined
  ) {
    return found;
  }
  return [resolved, ...found.filter((id) => id !== resolved)].slice(0, input.limit);
}

// The work of an account search is bounded (RES-7): it matches only candidates from indexed sources, never the whole
// table: every local account, the accounts whose address is exactly the query (username, or username@domain), up to
// ACCOUNT_PREFIX_LIMIT accounts whose username starts with the first term, and the ACCOUNT_RECENT_LIMIT accounts the
// instance learned of most recently. With following, the sources are the exact address among accepted follows and up
// to ACCOUNT_RECENT_LIMIT accepted follows (a partial index holds accepted follows only, so pending ones are never
// read). An exact address is always found. Trade-off: a remote account known for long is found by its address or its
// username prefix, not by a word of its display name.
export const ACCOUNT_PREFIX_LIMIT = 1000;
export const ACCOUNT_RECENT_LIMIT = 5000;

// The largest code point, as UTF-8 compares: every string with a prefix sorts below prefix + this.
const PREFIX_END = "\u{10FFFF}";

// The ids of the accounts the search finds, in its order.
function findAccountIds(db: Db, input: SearchInput, viewerId: string): string[] {
  // An address is read with the shared parser, so a Unicode domain finds the account stored under its punycode.
  const address = parseAddress(input.query.trim());
  const query = (address === null ? input.query : `${address.username}@${address.domain}`)
    .trim()
    .replace(/^@/, "")
    .replace(new RegExp(`@${escapeRegExp(input.localDomain)}$`, "i"), "");
  const terms = queryTerms(query);
  if (terms.length === 0) {
    return [];
  }
  const where = terms.map((variants) => `(${variants.map(() => "instr(a.search_text, ?) > 0").join(" OR ")})`);
  const [user = "", exactDomain] = query.toLowerCase().split("@");
  const exactUsername = user;
  const prefix = (terms[0]?.[0] ?? "").replace(/^@/, "").split("@")[0] ?? "";
  // The exact address: "user" is any account with that username, "user@domain" that one remote account. Only a
  // username addressRow would match names one: any other (an invalidated handle's '! <id>') is bound as NULL, which
  // equals nothing.
  const exactUser = isRemoteUsername(user) ? user : null;
  const exact =
    exactDomain === undefined
      ? "SELECT id FROM accounts INDEXED BY accounts_username WHERE lower(username) = ?"
      : "SELECT id FROM accounts INDEXED BY accounts_domain_username WHERE domain = ? AND lower(username) = ?";
  const exactParams: SqlStorageValue[] = exactDomain === undefined ? [exactUser] : [exactDomain, exactUser];
  const candidates = input.following
    ? `SELECT target_account_id AS id FROM (SELECT target_account_id FROM follows INDEXED BY follows_accepted
				WHERE account_id = ? AND state = 'accepted' LIMIT ${ACCOUNT_RECENT_LIMIT})
			UNION SELECT e.id FROM (${exact} LIMIT ${ACCOUNT_PREFIX_LIMIT}) e
				CROSS JOIN follows f INDEXED BY follows_accepted ON f.account_id = ? AND f.target_account_id = e.id AND f.state = 'accepted'`
    : `SELECT account_id AS id FROM local_accounts
			UNION SELECT id FROM (${exact} LIMIT ${ACCOUNT_PREFIX_LIMIT})
			UNION SELECT id FROM (SELECT id FROM accounts INDEXED BY accounts_username
				WHERE lower(username) >= ? AND lower(username) < ? ORDER BY lower(username), rowid LIMIT ${ACCOUNT_PREFIX_LIMIT})
			UNION SELECT id FROM (SELECT id FROM accounts ORDER BY rowid DESC LIMIT ${ACCOUNT_RECENT_LIMIT})`;
  const candidateParams: SqlStorageValue[] = input.following
    ? [viewerId, ...exactParams, viewerId]
    : [...exactParams, prefix, `${prefix}${PREFIX_END}`];
  // The candidates outside, each account sought by id, and the prefix through accounts_username: statistics older than
  // the Store's growth cannot turn either into a scan of accounts (RES-7). The prefix window is the first in the
  // index's own order (the lowered username, then rowid), so which accounts it holds does not depend on the plan.
  return db
    .all<{ id: string }>(
      `WITH candidates(id) AS (${candidates})
			SELECT a.id FROM candidates c CROSS JOIN accounts a INDEXED BY ${ACCOUNTS_ID_INDEX} ON a.id = c.id
			WHERE ${findableBySql("a.id", "?")} AND ${where.join(" AND ")}
			ORDER BY lower(a.username) = ? DESC, a.domain IS NULL DESC,
				${presentedCountSql("a.followers_count")} DESC, a.id
			LIMIT ? OFFSET ?`,
      ...candidateParams,
      viewerId,
      ...terms.flat(),
      exactUsername,
      input.limit,
      input.offset,
    )
    .map((row) => row.id);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type RelationshipResult =
  | { status: "ok"; relationship: Relationship }
  | { status: "not_found" }
  | { status: "forbidden" }
  // The change cannot be recorded right now (answered 503).
  | { status: "unavailable" };

// Mastodon's FollowLimitValidator, with its default MAX_FOLLOWS_THRESHOLD and MAX_FOLLOWS_RATIO: a local account may
// follow up to FOLLOW_LIMIT accounts, and past that up to FOLLOW_LIMIT_RATIO times its followers. Like Mastodon it
// counts accepted follows only (following_count), not pending requests.
export const FOLLOW_LIMIT = 7_500;
const FOLLOW_LIMIT_RATIO = 1.1;

export function followLimit(counts: { following_count: number; followers_count: number }): number {
  return counts.following_count < FOLLOW_LIMIT
    ? FOLLOW_LIMIT
    : Math.max(Math.round(counts.followers_count * FOLLOW_LIMIT_RATIO), FOLLOW_LIMIT);
}

// POST /api/v1/accounts/:id/note (Accounts::NotesController, AccountNote): the viewer's private note on any stored
// account, the viewer's own included. A blank comment (absent, or blank by railsBlank) deletes the note; a longer one
// than AccountNote::COMMENT_SIZE_LIMIT characters is refused with Rails' message, after the account is found. The note
// is kept as sent, and only its author is shown it (relationshipsOf).
export const MAX_NOTE_COMMENT = 2_000;

export type NoteResult = RelationshipResult | { status: "invalid"; errors: string[] };

export const setNote = userWriteOperation<{ target: string; comment: string | undefined; now: number }, NoteResult>(
  (db, { target, comment, now }, { accountId: viewerId }) => {
    const id = routeAccountId(db, target);
    if (id === null) {
      return { status: "not_found" };
    }
    // Rails' blank? (Accounts::NotesController#create).
    if (comment === undefined || railsBlank(comment)) {
      db.run("DELETE FROM account_notes WHERE account_id = ? AND target_account_id = ?", viewerId, id);
    } else if ([...comment].length > MAX_NOTE_COMMENT) {
      return { status: "invalid", errors: [`Comment is too long (maximum is ${MAX_NOTE_COMMENT} characters)`] };
    } else {
      // An unchanged note is not written again (`@note.save! if @note.changed?`).
      db.run(
        `INSERT INTO account_notes (account_id, target_account_id, comment, created_at, updated_at)
				VALUES (?1, ?2, ?3, ?4, ?4)
				ON CONFLICT (account_id, target_account_id) DO UPDATE SET comment = excluded.comment,
					updated_at = excluded.updated_at
				WHERE comment IS NOT excluded.comment`,
        viewerId,
        id,
        comment,
        new Date(now).toISOString(),
      );
    }
    return relationshipResult(db, viewerId, id, now);
  },
);

export function relationshipResult(db: Db, viewerId: string, targetId: string, now: number): RelationshipResult {
  const [relationship] = relationshipsOf(db, viewerId, [targetId], now);
  return relationship === undefined ? { status: "not_found" } : { status: "ok", relationship };
}

// Keyset pages over an edge table's INTEGER id (a paging cursor only). max_id and since_id page backwards from the
// newest; min_id pages forwards from the given cursor and is returned newest first as well. Cursors stay strings:
// they are read with CAST(id AS TEXT) and compared in SQL, never as JS numbers (which are exact only up to 2^53).
export type PageQuery = {
  maxId?: string | undefined;
  sinceId?: string | undefined;
  minId?: string | undefined;
  limit: number;
};

// A page of a list. `cut`: the read stopped at its candidate window (windows.ts) before the page filled, or an answer
// without a page stopped at ANSWER_BYTES, so the next link is offered however few items it holds.
export type Page<T> = { items: T[]; newest: string | null; oldest: string | null; cut?: boolean | undefined };

export type ListFollowsInput = {
  account: string;
  direction: "followers" | "following";
  page: PageQuery;
  present: PresentInput;
};

// The ids of a window of account ids (windows.ts) that `rule` (over `a`, the account row, and `l`, its local_accounts
// row) passes, each by its key, without their profiles.
export function windowAccountIds(db: Db, window: Window, rule: string): { id: string }[] {
  return window.candidates.length === 0
    ? []
    : db.all<{ id: string }>(
        `SELECT a.id FROM json_each(?1) c
					CROSS JOIN accounts a INDEXED BY ${ACCOUNTS_ID_INDEX} ON a.id = json_extract(c.value, '$.id') ${LOCAL_ROW_JOIN}
				WHERE ${rule}`,
        windowJson(window),
      );
}

// The account rows of `ids`, in their order, each by its key: the profiles an answer presents, built for its own
// accounts only.
function accountRowsOf(db: Db, ids: readonly string[]): AccountRow[] {
  if (ids.length === 0) {
    return [];
  }
  const rows = new Map(
    db
      .all<AccountRow>(
        `SELECT ${selectSql(ACCOUNT_COLUMN_MAP)} FROM json_each(?1) c CROSS JOIN accounts a INDEXED BY ${ACCOUNTS_ID_INDEX} ON a.id = c.value
					${LOCAL_ROW_JOIN}`,
        JSON.stringify(ids),
      )
      .map((row) => [row.id, row]),
  );
  return ids.flatMap((id) => rows.get(id) ?? []);
}

// How a list read admits its presented accounts, in traversal order (RES-3): an API answer is one JSON array of them,
// admitted with `leading`; a web page's list shares the page's budget (domain/web-pages/budget.ts).
export type AccountAdmission = (entries: Iterable<Account | undefined>) => Admitted<Account>;

const accountAnswerAdmission: AccountAdmission = (entries) => admit(entries, ARRAY_ANSWER_BYTES, true);

// A page of accounts (the rows of a window's page, newest first, each by its cursor `key`), their profiles read for
// the page only (RES-2; candidate windows read ids alone), admitted by `admission` (an API answer within ANSWER_BYTES,
// RES-3) in traversal order: a page cut there continues from its last admitted account (admittedPage).
export function accountPage<R extends { id: string }>(
  db: Db,
  page: { rows: readonly R[]; newest: string | null; oldest: string | null; cut?: boolean },
  ascending: boolean,
  key: (row: R) => string,
  present: Present,
  admission: AccountAdmission = accountAnswerAdmission,
): Page<Account> {
  return admittedPage(page, ascending, key, (traversal) =>
    admission(
      accountsOf(
        db,
        traversal.map((row) => row.id),
        present,
      ),
    ),
  );
}

// GET /api/v1/accounts/:id/followers and /following as the viewer (null: anonymous) may see them (R13, Mastodon's
// FollowerAccountsController and FollowingAccountsController): accepted follows, newest first. Nothing is listed when
// the account is suspended, or, to anyone but itself, when it hides its network or blocks the viewer
// (followListsShownSql). Others do not see the accounts they block, mute or are blocked by (followListedSql). A page
// reads a window of readWindow(limit) of the account's follows from the cursor (windows.ts), then applies the rule to
// those; a follower that blocks the viewer is never a candidate (docs/visibility.md "Read bounds"), so its follow
// supplies no cursor. Followers read follows_target, following follows_following (migration 0043), both in id order.
// An unknown account is not found.
export const listFollows = optionalUserReadOperation<ListFollowsInput, Page<Account> | null>(
  (db, input, viewer) => listFollowsWithin(db, input, viewer, accountAnswerAdmission, "every")?.page ?? null,
);

// A page of a follow list, whether a continuation follows it (a row may lie past it, windowPage's `more`, or it was
// cut by bytes), and whether the list is shown at all (followListsShownSql).
export type FollowList = { page: Page<Account>; more: boolean; shown: boolean };

// The account at the `end` of the follow a window candidate `c` names (its id, read as TEXT), by the follow's rowid in a
// correlated lookup: a join of follows by its rowid becomes a scan of follows under statistics taken while the table
// was small (RES-7).
function followEdgeSql(end: "account_id" | "target_account_id"): string {
  return end === "account_id"
    ? "(SELECT f.account_id FROM follows f WHERE f.id = CAST(c.value ->> '$.id' AS INTEGER))"
    : "(SELECT f.target_account_id FROM follows f WHERE f.id = CAST(c.value ->> '$.id' AS INTEGER))";
}

// listFollows' read, its accounts admitted by `admission`. `members`: 'every' lists an unavailable member, presented
// redacted, as Mastodon's API does; 'available' leaves it out (the public pages, VIS-4), by availableSql over the
// window's candidates, outside the window's LIMIT, so its follow still moves the continuation past it.
export function listFollowsWithin(
  db: Db,
  { account, direction, page, present }: ListFollowsInput,
  { accountId: viewerId, now }: ViewerContext,
  admission: AccountAdmission,
  members: "every" | "available",
): FollowList | null {
  const id = routeAccountId(db, account);
  if (id === null) {
    return null;
  }
  if (db.first(`SELECT 1 AS shown WHERE ${followListsShownSql("?1", "?2")}`, id, viewerId) === undefined) {
    return { page: { items: [], newest: null, oldest: null }, more: false, shown: false };
  }
  const [anchor, other] =
    direction === "followers"
      ? (["target_account_id", "account_id"] as const)
      : (["account_id", "target_account_id"] as const);
  const ascending = page.minId !== undefined;
  const size = readWindow(page.limit);
  const window = singleWindow(
    db,
    `SELECT CAST(f.id AS TEXT) AS id FROM follows f
		WHERE f.${anchor} = ?1 AND f.state = 'accepted' AND ${edgeRangeSql("f.id", "?2", "?3")}
			AND (?5 IS NULL OR ?5 IS ?1 OR NOT ${blocksSql(`f.${other}`, "?5")})
		ORDER BY f.id ${ascending ? "ASC" : "DESC"} LIMIT ?4`,
    size,
    id,
    page.maxId ?? null,
    page.minId ?? page.sinceId ?? null,
    size,
    viewerId,
  );
  const available = members === "available" ? `AND ${availableSql("a.id")}` : "";
  const rows =
    window.candidates.length === 0
      ? []
      : db.all<{ cursor: string; id: string }>(
          `SELECT c.value ->> '$.id' AS cursor, a.id
					FROM json_each(?4) c CROSS JOIN accounts a INDEXED BY ${ACCOUNTS_ID_INDEX} ON a.id = ${followEdgeSql(other)}
					WHERE ${followListedSql("a.id", "?1", "?2", "?3")} ${available}`,
          id,
          viewerId,
          now,
          windowJson(window),
        );
  const shown = windowPage(window, rows, (row) => row.cursor, page.limit, ascending);
  const presented = accountPage(db, shown, ascending, (row) => row.cursor, presentFor(present, viewerId), admission);
  return { page: presented, more: shown.more || presented.cut === true, shown: true };
}

// Follow requests to the viewer (Mastodon's FollowRequestsController and AuthorizeFollowService/RejectFollowService).
// Only the followed account decides (VIS-9): the viewer is the target, from the credential, never from the request.
// An unavailable requester (R1) is left out, as Mastodon lists Account.without_suspended, and listed again once it is
// available. A page reads a window of readWindow(limit) of the viewer's requests from the cursor (follows_target, in
// id order; windows.ts), then applies the rule to those (docs/visibility.md "Read bounds").
export const listFollowRequests = userReadOperation<{ page: PageQuery; present: PresentInput }, Page<Account>>(
  (db, { page, present }, { accountId: viewerId }) => {
    const ascending = page.minId !== undefined;
    const size = readWindow(page.limit);
    const window = singleWindow(
      db,
      `SELECT CAST(f.id AS TEXT) AS id FROM follows f
			WHERE f.target_account_id = ?1 AND f.state = 'pending' AND ${edgeRangeSql("f.id", "?2", "?3")}
			ORDER BY f.id ${ascending ? "ASC" : "DESC"} LIMIT ?4`,
      size,
      viewerId,
      page.maxId ?? null,
      page.minId ?? page.sinceId ?? null,
      size,
    );
    const rows =
      window.candidates.length === 0
        ? []
        : db.all<{ cursor: string; id: string }>(
            `SELECT c.value ->> '$.id' AS cursor, a.id
						FROM json_each(?1) c CROSS JOIN accounts a INDEXED BY ${ACCOUNTS_ID_INDEX} ON a.id = ${followEdgeSql("account_id")}
							${LOCAL_ROW_JOIN}
						WHERE ${availableJoinedSql("a", "l")}`,
            windowJson(window),
          );
    const shown = windowPage(window, rows, (row) => row.cursor, page.limit, ascending);
    return accountPage(db, shown, ascending, (row) => row.cursor, presentFor(present, viewerId));
  },
);
