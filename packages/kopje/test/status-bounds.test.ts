import { runInDurableObject } from "cloudflare:test";
import { parseFragment } from "parse5";
import { describe, expect, it } from "vitest";

import { rowHeapSql, selectSql } from "../src/db/columns";
import { Db, rowHeapBytes, VALUE_BYTES } from "../src/db/sql";
import {
  ACCOUNT_COLUMN_MAP,
  MAX_REMOTE_FIELDS,
  MOVED_ACCOUNT_COLUMNS,
  MOVED_CREATED_AT_LIMIT,
  MOVED_DISPLAY_NAME_LIMIT,
  MOVED_EMOJIS_BYTES,
  MOVED_LAST_STATUS_AT_LIMIT,
  MOVED_URL_LIMIT,
  REMOTE_FIELDS_BYTES,
  REMOTE_VERIFIED_JSON_BYTES,
} from "../src/domain/account-columns";
import {
  ACCOUNT_FROM,
  fieldSources,
  getAccount,
  MAX_FIELD_NAME,
  MAX_FIELD_VALUE,
  MAX_FIELDS,
  VERIFIED_AT_JSON_BYTES,
} from "../src/domain/accounts";
import { createActivity, getLegacyObject, noteOf, PIN_LIMIT, statusFacts } from "../src/domain/activities";
import { ANSWER_BYTES } from "../src/domain/answer-budget";
import { type VisibleStatusId } from "../src/domain/audience";
import { OWNER_ROLE } from "../src/domain/auth";
import { listConversations, MAX_PRESENTED_PARTICIPANTS } from "../src/domain/conversations";
import { MAX_FILTER_KEYWORD, MAX_FILTER_KEYWORDS, MAX_FILTER_TITLE, MAX_FILTERS } from "../src/domain/filters";
import { getFeatured, OUTBOX_BYTES } from "../src/domain/local-notes";
import { FALLBACK_JSON_MAX, FALLBACK_TYPES } from "../src/domain/notification-fallback";
import { listGroupedNotifications } from "../src/domain/notification-groups";
import { listNotifications } from "../src/domain/notifications";
import { ACTOR_URI_LIMIT, PROFILE_URL_LIMIT, USERNAME_LIMIT } from "../src/domain/profile-bounds";
import { noteQuote } from "../src/domain/quotes";
import { getAdminReport } from "../src/domain/reports";
import {
  MAX_MEDIA_DESCRIPTION_LENGTH,
  MAX_REMOTE_OPTION_LENGTH,
  MAX_REMOTE_OPTIONS,
  MAX_STATUS_MEDIA,
  MAX_STATUS_MENTION_ROWS,
  MAX_PRESENTED_TAGS,
  MAX_STATUS_TAGS,
  MAX_TAG_LENGTH,
  EDIT_MEDIA_BYTES,
  MEDIA_URL_JSON_BYTES,
  MEDIA_URL_LIMIT,
  SNAPSHOT_KEY_LIMIT,
} from "../src/domain/status-bounds";
import {
  CARD_JSON_MAX,
  type ChunkPlan,
  LARGE_ITEM_CHUNKS,
  PAGE_CHUNKS,
  presentation,
  presentedMediaUrl,
  presentStatusesWithin,
  storedSearchableText,
} from "../src/domain/status-presenter";
import { STATUS_COLUMN_MAP, STATUS_FROM, statusRowBoundSql } from "../src/domain/status-rows";
import { renderFieldValue } from "../src/domain/status-text";
import { getStatus, getStatuses, recordEdit, statusHistory } from "../src/domain/statuses";
import { streamUnit } from "../src/domain/streaming";
import {
  LINK_ACCT_JSON_BYTES,
  LINK_URL_JSON_BYTES,
  LONGEST_STATUS_STUB,
  PARENT_ENTRY_BYTES,
  WEB_PAGE_BYTES,
} from "../src/domain/web-pages/budget";
import type { PageCursor } from "../src/domain/web-pages/paging";
import { parseRemoteStatus } from "../src/federation/remote-status";
import { utf8Length } from "../src/platform/dump-format";
import { DOMAIN_BYTES, MAX_LOCAL_ADDRESSED } from "../src/platform/identity-bounds";
import type { StoreOperation } from "../src/platform/store-kernel";
import {
  APP_NAME_BYTES,
  APP_NAME_LIMIT,
  APP_WEBSITE_LIMIT,
  BLURHASH_BYTES,
  CARD_DIMENSION_MAX,
  CARD_EMBED_SRC_BYTES,
  CARD_IMAGE_DESCRIPTION_JSON_BYTES,
  CARD_IMAGE_EDGE_MAX,
  CARD_IMAGE_TOKEN_BYTES,
  CARD_EMBED_SRC_ESCAPED_BYTES,
  CARD_OPTIONAL_URL_LIMIT,
  CARD_TEXTS,
  CARD_URL_LIMIT,
  MEDIA_DESCRIPTION_BYTES,
  MEDIA_META_BYTES,
  mediaCategorySql,
  ACCOUNT_EMOJIS_BYTES,
  EMOJI_ENTRY_BYTES,
  EMOJI_SHORTCODE_LIMIT,
  EMOJI_URL_LIMIT,
  MAX_ACCOUNT_COUNT,
  MAX_EMOJIS,
  presentedEmojiBytes,
  PROFILE_DESCRIPTION_BYTES,
  PROFILE_DESCRIPTION_LIMIT,
  REMOTE_FIELD_INDEXES,
  REMOTE_FIELD_LINK_BYTES,
  REMOTE_FIELD_LINKS_BYTES,
  REMOTE_VERIFIED_SHOWN,
  SPOILER_CUT_LIMIT,
  SPOILER_READ_BYTES,
  STATIC_URL_LIMIT,
  STATUS_EMOJIS_BYTES,
  VERIFIED_LINKS_BYTES,
  WARNING_STATUS_IDS,
  WARNING_STATUS_IDS_BYTES,
  WARNING_TEXT_BYTES,
} from "../src/platform/stored-bounds";
import {
  jsonStringBytes,
  REMOTE_BIO_BYTES,
  sanitizeRemoteContent,
  sanitizeRemoteHtml,
  SPOILER_BYTES,
  STATUS_CONTENT_BYTES,
} from "../src/security/html";
import { sha256Hex } from "../src/security/tokens";
import { STREAM_LIMITS, TURN_BUDGET, UNIT_WORST } from "../src/stream-hub";
import { setSetting, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { acceptQuote } from "./budget-helpers";
import {
  ACCOUNT_EMOJIS_FULL,
  accountAtCap,
  emojiUrl,
  STATUS_EMOJIS_FULL,
  statusAtCap,
  statusShortNames,
} from "./emoji-fixtures";
import { BUILD } from "./helpers";
import { ALICE, setup, type Setup } from "./inbox-status-helpers";
import { localSnapshotAtCap } from "./local-emoji-helpers";
import { LOCAL_FIELD_VALUE_JSON_MAX, LOCAL_FIELDS_JSON_MAX, localLinkValue } from "./local-field-maxima";
import {
  CONSERVATIVE_JSON,
  type Fill,
  FILL_SHAPES,
  FILLS,
  HEAP_PEAKS,
  MOVED_ACCOUNT_MAXIMA,
  NOTE_MAXIMA,
  type Peaks,
  type Shape,
  SHAPE_CEILING_PERCENT,
} from "./presented-maxima";
import { ESCAPED_STATIC_WITNESS, fullestFields, MAX_BIO, MOVED_ROW_SQLITE_MAX } from "./profile-fixtures";
import { pinStatuses, profileFrameBytes, tagFrameBytes, walkProfile } from "./profile-page-helpers";
import { observedSql, rowsRead } from "./read-helpers";
import { community, post, remoteAccount } from "./status-helpers";
import { heap } from "./status-row-fixtures";
import { blurhashOf } from "./stored-bounds-fixtures";
import { postsTab } from "./web-helpers";

// RES-2: one presented status has a known size. Each column a remote server controls is bounded where it is stored
// (the stored-bound triggers of 0048_stored_bounds), and identities, hashtag names and poll choices again as they are
// read (status-bounds.ts), so a converted row leaves SQLite within them too. The maxima measured here are
// docs/threat-model.md's table (RES-3), whose figures this file asserts from presented-maxima.ts.

const ORIGIN = "https://kopje.test";
// A control character: one code point that JSON escapes to six bytes, the most any code point takes.
const C = "\u0001";
// A remote host of 2,000 characters: an actor id of ACTOR_URI_LIMIT holds it, so no stored domain is longer.
const HOST = `${"d".repeat(1992)}.example`;

let sequence = 900_000_000_000_000_000n;
const nextId = () => String(sequence++);

const atLimit = (prefix: string, limit: number) => prefix.padEnd(limit, "u");

// How a fixture fills text at its bound: `escaped` with characters JSON escapes to six bytes (the most JSON for the
// fewest bytes read); `derived`, the same with mentioned accounts that have no stored url, so their url is derived
// from the host and the username; `raw` with what reads the most bytes from SQLite for each bound: ASCII where the
// bound is in bytes, and four-byte characters (W) where it is in characters. Emoji snapshots: at their presented
// bounds (escaped and derived), padded to their stored bounds (raw). `emoji-poll` is escaped with every poll's choices
// referencing the status's emoji in the fewest characters (statusShortNames), so each poll shows them all: the
// escaped poll, untouched, keeps the row bounds, and the conservative JSON (conservativeJson) both. `emoji-cache` is
// escaped with every remote snapshot at the most entries its bound holds (mostEmojis), each cached (cachedEmojis):
// the most cached emoji every row reads.

// The most entries a snapshot within `bytes` holds: one-character-name entries of the shortest URLs, up to MAX_EMOJIS.
function mostEmojis(bytes: number): string {
  const entries = (n: number): [string, string][] =>
    Array.from({ length: n }, (_, i) => [i.toString(36), `https://e.co/${i.toString(36)}`]);
  let n = MAX_EMOJIS;
  while (presentedEmojiBytes(entries(n)) > bytes) {
    n--;
  }
  return JSON.stringify(entries(n));
}

// The emoji snapshots of a fill: a status's (its boost's own row too) and an account's.
const statusEmojis = (fill: Fill) =>
  fill === "raw"
    ? STATUS_EMOJIS_FULL
    : fill === "emoji-cache"
      ? mostEmojis(STATUS_EMOJIS_BYTES)
      : JSON.stringify(fill === "emoji-poll" ? statusShortNames() : statusAtCap());
const accountEmojis = (fill: Fill) =>
  fill === "raw"
    ? ACCOUNT_EMOJIS_FULL
    : fill === "emoji-cache"
      ? mostEmojis(ACCOUNT_EMOJIS_BYTES)
      : JSON.stringify(accountAtCap());
// The 37 characters that reference every name of statusShortNames.
const SHORT_REFERENCES = statusShortNames()
  .map(([name]) => `:${name}:`)
  .join("");

// A report's comment at its stored bound for each fill (migration 0054_remote_reports, CHECK
// report_comment_within_20000_bytes): the most JSON an imported one holds (a NUL, which SQLite's length stops at, then
// 19,999 bytes of U+0001, each 6 JSON-escaped bytes), what Kopje's writers make at most in JSON (5,000 code points of
// U+0001), and the most SQLite bytes (5,000 four-byte code points); emoji-poll is escaped's.
const REPORT_COMMENTS: Record<Fill, string> = {
  escaped: "\u0000" + "\u0001".repeat(19_999),
  derived: "\u0001".repeat(5_000),
  raw: "𠀀".repeat(5_000),
  "emoji-poll": "\u0000" + "\u0001".repeat(19_999),
  "emoji-cache": "\u0000" + "\u0001".repeat(19_999),
};
// A warning's text at its stored bound for each fill (migration 0062_account_warnings, CHECK
// account_warning_text_within_10000_bytes, which allows no NUL): 10,000 bytes of U+0001, each 6 JSON-escaped bytes,
// which Kopje's writer makes too (escaped, derived, emoji-poll); and 10,000 malformed bytes (raw: 0xFF, no UTF-8 lead
// byte), which an import may store and which read back as 10,000 three-byte U+FFFD.
const WARNING_TEXTS: Record<Fill, string | ArrayBuffer> = {
  escaped: "\u0001".repeat(WARNING_TEXT_BYTES),
  derived: "\u0001".repeat(WARNING_TEXT_BYTES),
  raw: new Uint8Array(WARNING_TEXT_BYTES).fill(0xff).buffer,
  "emoji-poll": "\u0001".repeat(WARNING_TEXT_BYTES),
  "emoji-cache": "\u0001".repeat(WARNING_TEXT_BYTES),
};
const W = "𠀀";
const RAW_BIO = `<p>${"x".repeat(REMOTE_BIO_BYTES - 9)}</p>`;
// An image description at its bound for each fill: PROFILE_DESCRIPTION_LIMIT characters JSON escapes to six bytes (902
// JSON bytes), or of four bytes (raw: 600 bytes read, PROFILE_DESCRIPTION_BYTES).
const profileDescription = (fill: Fill) => (fill === "raw" ? W : C).repeat(PROFILE_DESCRIPTION_LIMIT);

// The most JSON a nested moved-to account presents (accounts.ts presentMovedAccount), from its decoded limits at worst
// escaping: characters of six JSON bytes at each text limit, URLs and uri at MOVED_URL_LIMIT (JSON-measured), counts
// of 20 characters (any int64; presentedCountSql shows at most MAX_ACCOUNT_COUNT, 16), emojis of MOVED_EMOJIS_BYTES
// (a string of that many JSON bytes stands for them), and every key at once, a local account's (noindex, roles) and
// an unavailable one's (suspended) included; its image descriptions '' (not read) and its display settings false.
const MOVED_ACCOUNT_JSON_MAX = utf8Length(
  JSON.stringify({
    id: "9".repeat(18),
    username: C.repeat(USERNAME_LIMIT),
    acct: `${C.repeat(USERNAME_LIMIT)}@${C.repeat(DOMAIN_BYTES)}`,
    display_name: C.repeat(MOVED_DISPLAY_NAME_LIMIT),
    locked: false,
    bot: false,
    discoverable: false,
    indexable: false,
    group: false,
    created_at: C.repeat(MOVED_CREATED_AT_LIMIT),
    note: "",
    url: "u".repeat(MOVED_URL_LIMIT),
    uri: "u".repeat(MOVED_URL_LIMIT),
    avatar: "u".repeat(MOVED_URL_LIMIT),
    avatar_static: "u".repeat(MOVED_URL_LIMIT),
    avatar_description: "",
    header: "u".repeat(MOVED_URL_LIMIT),
    header_static: "u".repeat(MOVED_URL_LIMIT),
    header_description: "",
    followers_count: -(2 ** 63),
    following_count: -(2 ** 63),
    statuses_count: -(2 ** 63),
    last_status_at: C.repeat(MOVED_LAST_STATUS_AT_LIMIT),
    hide_collections: false,
    show_media: false,
    show_media_replies: false,
    show_featured: false,
    emojis: "x".repeat(MOVED_EMOJIS_BYTES - 2),
    fields: [],
    noindex: false,
    roles: [{ id: OWNER_ROLE.id, name: OWNER_ROLE.name, color: OWNER_ROLE.color }],
    suspended: true,
  }),
);
// What a moved-to account's row reads at most: SQLite bytes (profile-fixtures.ts MOVED_ROW_SQLITE_MAX) and heap.
const MOVED_ROW_HEAP_MAX = MOVED_ACCOUNT_COLUMNS.rowHeap;

// What presenting a nested account's emojis holds besides what it admits (custom-emojis.ts referencedEmojis), at
// three times its bytes: one entry at a time, its two literals as stored (a 128-character name and a 512-byte url,
// each character escaped to six bytes), their decoded strings, and the larger of the entry presented from them and a
// candidate href that normalization makes before rejecting it (each url character percent-encoded to three bytes).
// One presentation runs at a time, so an answer holds one.
const MOVED_EMOJI_LITERALS = 6 * EMOJI_SHORTCODE_LIMIT + 2 + (6 * EMOJI_URL_LIMIT + 2);
const MOVED_EMOJI_DECODED = EMOJI_SHORTCODE_LIMIT + EMOJI_URL_LIMIT;
const MOVED_EMOJI_CANDIDATE = Math.max(
  EMOJI_ENTRY_BYTES + EMOJI_SHORTCODE_LIMIT + 2 * EMOJI_URL_LIMIT,
  3 * EMOJI_URL_LIMIT,
);
const MOVED_EMOJI_SCRATCH = 3 * (MOVED_EMOJI_LITERALS + MOVED_EMOJI_DECODED + MOVED_EMOJI_CANDIDATE);

// The nested moved-to accounts a presented value shows (each `moved` that is an account).
function movedAccounts(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value.flatMap(movedAccounts);
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  return Object.entries(value).flatMap(([key, item]: [string, unknown]) =>
    key === "moved" && typeof item === "object" && item !== null ? [item] : movedAccounts(item),
  );
}

// The account a fill's presented account moved to (Account#moved, MOVED_ACCOUNT_COLUMNS), each column at its nested
// cap: escaped (and derived, emoji-poll), characters JSON escapes to six bytes at each decoded limit, URLs at
// MOVED_URL_LIMIT, counts at MAX_ACCOUNT_COUNT (the most presentedCountSql shows) and a display name that references
// emojis whose JSON fills MOVED_EMOJIS_BYTES; raw, four-byte characters where a limit is in characters and every
// column at its byte cap, the emoji snapshot at its stored bound; its display settings off (false, the longer JSON).
// Its last status gives last_status_at.
const MOVED_REFERENCED = 3;
// The longest url of MOVED_REFERENCED one-character entries whose presented JSON fits MOVED_EMOJIS_BYTES.
const MOVED_EMOJI_URL = Math.floor(((MOVED_EMOJIS_BYTES - 1) / MOVED_REFERENCED - EMOJI_ENTRY_BYTES - 1) / 2);
const MOVED_EMOJIS = Array.from({ length: MOVED_REFERENCED }, (_, i) => [
  String.fromCharCode(97 + i),
  emojiUrl(MOVED_EMOJI_URL, String(i)),
]);
const MOVED_REFERENCES = MOVED_EMOJIS.map(([name]) => `:${name}:`).join("");

// The account's cached avatar and header (remote-media.ts), each at the packed cap: a 64-character token and four-letter
// extensions, for the URLs it shows now. Only the raw fill (the most bytes read from SQLite) has them: a cached image
// adds its row to what is read but shows a shorter URL, so the other fills keep the remote URLs at their bounds.
async function cachedProfile(t: Setup, id: string, host: string): Promise<void> {
  await sql(
    t.store,
    `INSERT INTO remote_media (kind, owner_id, account_id, url, host, category, lane, generation, enqueued_at, token, ext,
			still_ext, stored_at)
		SELECT k.kind, a.id, a.id, CASE k.kind WHEN 'avatar' THEN a.avatar_url ELSE a.header_url END, ?2, 'image', 0, 0, 1,
			substr(k.kind || a.id || '${"t".repeat(64)}', 1, 64), 'webp', 'webp', 1
		FROM accounts a CROSS JOIN (SELECT 'avatar' AS kind UNION ALL SELECT 'header') k
		WHERE a.id = ?1 AND CASE k.kind WHEN 'avatar' THEN a.avatar_url ELSE a.header_url END IS NOT NULL`,
    id,
    host,
  );
}

async function movedTarget(t: Setup, fill: Fill): Promise<string> {
  const id = nextId();
  const raw = fill === "raw";
  const domain = raw ? `${"d".repeat(DOMAIN_BYTES - 4)}.com` : C.repeat(DOMAIN_BYTES);
  const counted = raw ? W : C;
  await sql(
    t.store,
    `INSERT INTO accounts (id, uri, username, domain, display_name, url, avatar_url, header_url, emojis, created_at,
			followers_count, following_count, statuses_count, show_featured, show_media, show_media_replies)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?11, ?11, ?11, 0, 0, 0)`,
    id,
    atLimit(`https://moved.example/users/${id}/`, MOVED_URL_LIMIT),
    `${"u".repeat(USERNAME_LIMIT - 18)}${id}`,
    domain,
    raw ? W.repeat(2048) : `${MOVED_REFERENCES}${C.repeat(2048 - MOVED_REFERENCES.length)}`,
    atLimit(`https://moved.example/@${id}/`, MOVED_URL_LIMIT),
    atLimit(`https://moved.example/a/${id}/`, MOVED_URL_LIMIT),
    atLimit(`https://moved.example/h/${id}/`, MOVED_URL_LIMIT),
    raw ? ACCOUNT_EMOJIS_FULL : JSON.stringify(MOVED_EMOJIS),
    counted.repeat(MOVED_CREATED_AT_LIMIT),
    MAX_ACCOUNT_COUNT,
  );
  await sql(
    t.store,
    "INSERT INTO statuses (id, uri, account_id, visibility, published_at) VALUES (?, ?, ?, 'public', ?)",
    nextId(),
    `https://moved.example/statuses/${id}`,
    id,
    counted.repeat(MOVED_LAST_STATUS_AT_LIMIT),
  );
  if (raw) {
    await cachedProfile(t, id, "moved.example");
  }
  return id;
}

// A remote account with every profile column at its bound, its image descriptions at PROFILE_DESCRIPTION_LIMIT
// (profileDescription) and its display settings off (false, the longer JSON); `light`: only what a mention reads is at
// its bound. Its counts, light or not, at MAX_ACCOUNT_COUNT, the most a remote account learns. One that is not light
// moved to an account of its own at the nested caps (movedTarget).
async function maximalAccount(t: Setup, light = false, fill: Fill = "escaped"): Promise<string> {
  const id = nextId();
  const username = `${"u".repeat(USERNAME_LIMIT - 18)}${id}`;
  await sql(
    t.store,
    `INSERT INTO accounts (id, uri, username, domain, display_name, note, url, avatar_url, header_url, raw, emojis,
			followers_count, following_count, statuses_count, avatar_description, header_description, show_featured,
			show_media, show_media_replies)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?12, ?12, ?12, ?13, ?13, ?14, ?14, ?14)`,
    id,
    atLimit(`https://${HOST}/users/${id}/`, ACTOR_URI_LIMIT),
    username,
    HOST,
    light ? "" : (fill === "raw" ? W : C).repeat(2048),
    light ? "" : fill === "raw" ? RAW_BIO : MAX_BIO,
    light && fill === "derived" ? null : atLimit(`https://${HOST}/@${id}/`, PROFILE_URL_LIMIT),
    light ? null : atLimit(`https://${HOST}/a/${id}/`, PROFILE_URL_LIMIT),
    light ? null : atLimit(`https://${HOST}/h/${id}/`, PROFILE_URL_LIMIT),
    light ? null : JSON.stringify({ type: "Person", attachment: fullestFields() }),
    light ? null : accountEmojis(fill),
    MAX_ACCOUNT_COUNT,
    light ? "" : profileDescription(fill),
    light ? 1 : 0,
  );
  if (fill === "raw") {
    await cachedProfile(t, id, "files.example");
  }
  if (!light) {
    await sql(t.store, "UPDATE accounts SET moved_to_account_id = ? WHERE id = ?", await movedTarget(t, fill), id);
  }
  return id;
}

type Parts = {
  content: string;
  spoiler: string;
  // The source text a local status keeps for editing; none for a remote one.
  source?: string | null;
  media: { url: string; preview: string | null; description: string; meta: string | null; blurhash?: string | null }[];
  mentions: string[];
  tags: string[];
  poll: string[] | null;
  uri?: string;
  url?: string;
  // The status a boost boosts; a boost's content is '' (the statuses CHECK).
  reblogOf?: string;
  emojis?: string | null;
};

// A public remote status of `author` with the given parts, written directly in SQL: the stored-bound triggers of
// 0048_stored_bounds accept every part at its bound.
async function storedStatus(t: Setup, author: string, parts: Parts): Promise<string> {
  const id = nextId();
  await sql(
    t.store,
    `INSERT INTO statuses (id, uri, url, account_id, reblog_of_id, visibility, spoiler_text, content, source_text,
			published_at, emojis)
		VALUES (?, ?, ?, ?, ?, 'public', ?, ?, ?, ?, ?)`,
    id,
    parts.uri ?? atLimit(`https://${HOST}/objects/${id}/`, 4096),
    parts.url ?? atLimit(`https://${HOST}/notes/${id}/`, 4096),
    author,
    parts.reblogOf ?? null,
    parts.spoiler,
    parts.reblogOf === undefined ? parts.content : "",
    parts.source ?? null,
    new Date(NOW - 60_000).toISOString(),
    parts.emojis ?? null,
  );
  for (const [position, m] of parts.media.entries()) {
    await sql(
      t.store,
      `INSERT INTO media_attachments (id, account_id, status_id, position, type, url, preview_url, description, meta,
				focus_x, focus_y, blurhash)
			VALUES (?, ?, ?, ?, 'image', ?, ?, ?, ?, -1, -1, ?)`,
      nextId(),
      author,
      id,
      position,
      m.url,
      m.preview,
      m.description,
      m.meta,
      m.blurhash ?? null,
    );
  }
  await sql(
    t.store,
    `INSERT INTO status_mentions (status_id, account_id, silent, requires_mention, author_id)
		SELECT ?, value, 0, 0, ? FROM json_each(?)`,
    id,
    author,
    JSON.stringify(parts.mentions),
  );
  await sql(
    t.store,
    "INSERT INTO status_tags (status_id, name, public) SELECT ?, value, 1 FROM json_each(?)",
    id,
    JSON.stringify(parts.tags),
  );
  if (parts.poll !== null) {
    await sql(
      t.store,
      `INSERT INTO polls (status_id, options, tallies, votes_count, voters_count, expires_at)
			VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      JSON.stringify(parts.poll),
      JSON.stringify(parts.poll.map(() => Number.MAX_SAFE_INTEGER)),
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
      new Date(NOW + 86_400_000).toISOString(),
    );
  }
  return id;
}

// A meta of MEDIA_META_BYTES: the dimensions, padded with a key presentMedia does not read.
const MAX_META = (() => {
  const base = { original: { width: 100_000, height: 100_000 }, small: { width: 100_000, height: 100_000 }, x: "" };
  return JSON.stringify({ ...base, x: "x".repeat(1024 - JSON.stringify(base).length) });
})();

// A media URL of MEDIA_URL_LIMIT bytes that JSON escapes the most: a query of backslashes, which URL parsing keeps as
// they are (a query is not a path, and the query percent-encode set has no backslash), each two bytes in JSON.
const escapingUrl = (prefix: string) => prefix.padEnd(MEDIA_URL_LIMIT, "\\");
// The most JSON a presented blurhash takes: BLURHASH_BYTES base83 characters, none of which JSON escapes. A media
// URL's is MEDIA_URL_JSON_BYTES.
const BLURHASH_JSON_MAX = BLURHASH_BYTES + 2;
const MEDIA_STRINGS = ["url", "preview_url", "remote_url", "preview_remote_url", "blurhash"] as const;

// The attachments a presented value shows (each object with a preview_remote_url, which only a MediaAttachment has).
function presentedMedia(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.flatMap(presentedMedia);
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const own = "preview_remote_url" in value ? [value as Record<string, unknown>] : [];
  return [...own, ...Object.values(value).flatMap(presentedMedia)];
}

// What an attachment's URLs and blurhash lack of their maxima in its JSON (each of them is a string or null).
function mediaDeficit(media: Record<string, unknown>): number {
  return MEDIA_STRINGS.reduce(
    (sum, key) => sum + (key === "blurhash" ? BLURHASH_JSON_MAX : MEDIA_URL_JSON_BYTES) - jsonBytes(media[key]),
    0,
  );
}

// A tag name of MAX_TAG_LENGTH code points of four bytes each: the longest URL encodeURIComponent makes of one.
const maxTag = (i: number) => `${String.fromCodePoint(0x20000 + i)}${"𠀀".repeat(MAX_TAG_LENGTH - 1)}`;

// A status with every part at its bound: content and source text of STATUS_CONTENT_BYTES and a warning of
// SPOILER_BYTES as JSON strings (each the largest value its stored-bound trigger accepts), MAX_STATUS_MEDIA
// attachments at theirs, MAX_STATUS_MENTION_ROWS mentions of accounts at theirs, MAX_STATUS_TAGS tags and a poll of
// MAX_REMOTE_OPTIONS choices of MAX_REMOTE_OPTION_LENGTH escaping characters.
async function maximalParts(t: Setup, fill: Fill = "escaped"): Promise<Parts> {
  const mentions: string[] = [];
  for (let i = 0; i < MAX_STATUS_MENTION_ROWS; i++) {
    mentions.push(await maximalAccount(t, true, fill));
  }
  const counted = fill === "raw" ? W : C;
  const content = fill === "raw" ? "x".repeat(STATUS_CONTENT_BYTES - 2) : C.repeat((STATUS_CONTENT_BYTES - 2) / 6);
  return {
    content,
    source: content,
    spoiler: fill === "raw" ? "x".repeat(SPOILER_BYTES - 2) : C.repeat(Math.floor((SPOILER_BYTES - 2) / 6)),
    // URLs at their byte bound, of ASCII (raw) or of backslashes JSON escapes (the others); a 5x5 blurhash.
    media: Array.from({ length: MAX_STATUS_MEDIA }, (_, i) => ({
      url:
        fill === "raw" ? atLimit(`https://${HOST}/m/${i}/`, MEDIA_URL_LIMIT) : escapingUrl(`https://m.example/${i}/?`),
      preview:
        fill === "raw" ? atLimit(`https://${HOST}/p/${i}/`, MEDIA_URL_LIMIT) : escapingUrl(`https://p.example/${i}/?`),
      description: counted.repeat(MAX_MEDIA_DESCRIPTION_LENGTH),
      meta: MAX_META,
      blurhash: blurhashOf(5, 5, "~"),
    })),
    mentions,
    tags: Array.from({ length: MAX_STATUS_TAGS }, (_, i) => maxTag(i)),
    poll: Array.from({ length: MAX_REMOTE_OPTIONS }, (_, i) =>
      fill === "emoji-poll" && i === 0
        ? `${SHORT_REFERENCES}${counted.repeat(MAX_REMOTE_OPTION_LENGTH - SHORT_REFERENCES.length)}`
        : counted.repeat(MAX_REMOTE_OPTION_LENGTH),
    ),
    emojis: statusEmojis(fill),
  };
}

// The heap of the rows one read returns under the model of "Heap at 8 MiB per answer" (docs/threat-model.md), by query
// (its SQL) and column: each query's rows (64 B each for the object), and for each column its values' heap summed and
// its largest value's (32 B and twice its UTF-8 bytes, which is at least RowMeter's twice its UTF-16 code units).
type ColumnHeap = { total: number; largest: number };
type Heaps = Map<string, { rows: number; columns: Map<string, ColumnHeap> }>;

type Measure = {
  answer: unknown;
  rows: number;
  sqliteBytes: number;
  longest: number;
  profileBytes: number;
  heaps: Heaps;
};

// Runs a read over a SqlStorage that measures what leaves SQLite: the rows, the UTF-8 bytes of their values (eight per
// number), the longest value's bytes, and their heap by query and column.
async function measured<I>(t: Setup, operation: StoreOperation<I, unknown>, input: I): Promise<Measure> {
  return runInDurableObject(t.store, (_instance, state) => {
    let rows = 0;
    let sqliteBytes = 0;
    let longest = 0;
    let profileBytes = 0;
    const heaps: Heaps = new Map();
    const counting = observedSql(state.storage.sql, (read, query) => {
      const heap = heaps.get(query) ?? { rows: 0, columns: new Map<string, ColumnHeap>() };
      heaps.set(query, heap);
      for (const row of read) {
        rows++;
        heap.rows++;
        const profile = "note" in row && "display_name" in row;
        for (const [column, value] of Object.entries(row)) {
          const text = typeof value === "string" ? utf8Length(value) : null;
          const bytes = text ?? 8;
          sqliteBytes += bytes;
          profileBytes += profile ? bytes : 0;
          longest = Math.max(longest, bytes);
          const one = 32 + 2 * (text ?? 0);
          const sum = heap.columns.get(column) ?? { total: 0, largest: 0 };
          heap.columns.set(column, { total: sum.total + one, largest: Math.max(sum.largest, one) });
        }
      }
    });
    let answer = operation.run(counting, input) as Record<string, unknown>;
    while (answer.status === "ok" && "value" in answer) {
      answer = answer.value as Record<string, unknown>;
    }
    return { answer, rows, sqliteBytes, longest, profileBytes, heaps };
  });
}

const credential = async (t: Setup) => ({ tokenHash: await sha256Hex(t.tokens.alice), scope: "read", now: NOW });

const read = async (t: Setup, operation: StoreOperation<never, unknown>, id: string) =>
  measured(t, operation, { credential: await credential(t), now: NOW, id, present: { origin: ORIGIN } } as never);

// The objects, arrays and strings a presented value holds.
function nodes(value: unknown): number {
  if (Array.isArray(value)) {
    return 1 + value.reduce((sum: number, item) => sum + nodes(item), 0);
  }
  if (typeof value === "object" && value !== null) {
    return 1 + Object.values(value).reduce((sum: number, item) => sum + nodes(item), 0);
  }
  return typeof value === "string" ? 1 : 0;
}

const jsonBytes = (value: unknown) => utf8Length(JSON.stringify(value));

type Presented = Record<string, unknown> & {
  content: string;
  spoiler_text: string;
  uri: string;
  url: string | null;
  account: Record<string, unknown>;
  media_attachments: Record<string, unknown>[];
  mentions: Record<string, unknown>[];
  tags: { name: string; url: string }[];
  poll: { options: { title: string }[] } | null;
};

describe("a remote status is stored within its bounds (RES-2)", () => {
  const note = (extra: Record<string, unknown>) =>
    parseRemoteStatus({
      id: "https://remote.example/notes/1",
      type: "Note",
      attributedTo: "https://remote.example/users/u",
      to: ["https://www.w3.org/ns/activitystreams#Public"],
      content: "<p>x</p>",
      ...extra,
    })!;

  it("sanitizes a fitting prefix of over-long content into well-formed HTML within STATUS_CONTENT_BYTES", () => {
    for (const content of [
      "<a>".repeat(16_666),
      `<p>${'日本語の本文と<a href="https://example.com/a">リンク</a>です。'.repeat(2_000)}</p>`,
      `<p>${`${C}"<b>x</b>`.repeat(5_000)}</p>`,
    ]) {
      const stored = note({ content }).content;
      expect(stored).toBe(sanitizeRemoteContent(content));
      expect(jsonStringBytes(stored)).toBeLessThanOrEqual(STATUS_CONTENT_BYTES);
      expect(jsonStringBytes(stored)).toBeGreaterThan(STATUS_CONTENT_BYTES / 2);
      const errors: string[] = [];
      parseFragment(stored, { onParseError: (error) => errors.push(error.code) });
      expect(errors.filter((code) => code !== "control-character-in-input-stream")).toEqual([]);
    }
  });

  it("refuses a status id over its bound in UTF-8 bytes, and ignores such a url", () => {
    const long = `https://remote.example/notes/${"é".repeat(2_100)}`;
    expect(note({ id: long })).toBeNull();
    expect(note({ url: long }).url).toBeNull();
    expect(note({ url: "https://remote.example/@u/1" }).url).toBe("https://remote.example/@u/1");
  });

  it("cuts a content warning to SPOILER_BYTES at a code point, and refuses over-long media URLs", () => {
    const spoiler = note({ summary: "注意".repeat(5_000) }).spoilerText;
    expect(jsonStringBytes(spoiler)).toBeLessThanOrEqual(SPOILER_BYTES);
    expect(spoiler).toBe("注意".repeat(5_000).slice(0, spoiler.length));
    expect(spoiler.length).toBe(Math.floor((SPOILER_BYTES - 2) / 3));
    const bisons = note({ summary: "🦬".repeat(5_000) }).spoilerText;
    expect(bisons).toBe("🦬".repeat(Math.floor((SPOILER_BYTES - 2) / 4)));
    const long = atLimit("https://remote.example/media/", MEDIA_URL_LIMIT + 1);
    const fits = atLimit("https://remote.example/media/", MEDIA_URL_LIMIT);
    const media = note({
      attachment: [
        { type: "Document", mediaType: "image/png", url: long },
        { type: "Document", mediaType: "image/png", url: fits, icon: long },
      ],
    }).media;
    expect(media.map((m) => [m.url, m.previewUrl])).toEqual([[fits, null]]);
  });

  it("parses at most 4 usable attachments: the 5th is left out", () => {
    const png = (i: number) => ({ type: "Document", mediaType: "image/png", url: `https://remote.example/m/${i}.png` });
    // A link (href) and an attachment without a usable url do not count toward the cap; the 5th usable one is cut, as
    // Mastodon 4.5.21's Create and Update keep at most 4 (process_status_update_service.rb:92-100).
    const media = note({
      attachment: [
        { type: "Link", href: "https://remote.example/page" },
        png(0),
        { type: "Document", mediaType: "image/png", url: "ftp://remote.example/m/x.png" },
        png(1),
        png(2),
        png(3),
        png(4),
      ],
    }).media;
    expect(MAX_STATUS_MEDIA).toBe(4);
    expect(media.map((m) => m.url)).toEqual([0, 1, 2, 3].map((i) => png(i).url));
  });
});

describe("a local status is written within its bounds (RES-2)", () => {
  it("refuses a post whose rendered mentions pass STATUS_CONTENT_BYTES, writing nothing", async () => {
    const h = await community(["alice"]);
    const target = await remoteAccount(h.store, "a");
    await sql(
      h.store,
      "UPDATE accounts SET url = ? WHERE id = ?",
      atLimit("https://remote.example/@a/", PROFILE_URL_LIMIT),
      target,
    );
    const response = await h.request("/api/v1/statuses", {
      method: "POST",
      headers: { authorization: `Bearer ${h.users.alice.token}`, "content-type": "application/json" },
      body: JSON.stringify({ status: "@a@remote.example ".repeat(160) }),
    });
    expect(response.status).toBe(422);
    expect(await sql(h.store, "SELECT id FROM statuses")).toEqual([]);
    // Fewer mentions fit, and are rendered whole.
    const posted = await post(h, h.users.alice, { status: "@a@remote.example ".repeat(40) });
    expect(jsonStringBytes(posted.content!)).toBeLessThanOrEqual(STATUS_CONTENT_BYTES);
    expect(posted.mentions).toHaveLength(1);
  });
});

describe("a stored status is read within its bounds (RES-2)", () => {
  it("projects identities, hashtags and poll choices, and caps the rows, as the bytes leaving SQLite show", async () => {
    const t = await setup();
    const author = await maximalAccount(t);
    await sql(
      t.store,
      "UPDATE accounts SET uri = ? WHERE id = ?",
      atLimit(`https://${HOST}/users/long/`, ACTOR_URI_LIMIT + 1),
      author,
    );
    const mentions: string[] = [];
    for (let i = 0; i < MAX_STATUS_MENTION_ROWS + 50; i++) {
      mentions.push(await maximalAccount(t, true));
    }
    // A converted username of 64 KiB and an actor id past its bound, with no stored url.
    await sql(
      t.store,
      "UPDATE accounts SET username = ?, url = NULL, uri = ? WHERE id = ?",
      `u${"v".repeat(64 * 1024)}`,
      atLimit("https://remote.example/users/u/", ACTOR_URI_LIMIT + 1),
      mentions[0]!,
    );
    // A converted username outside Mastodon's remote format, of characters that escape to six bytes.
    await sql(t.store, "UPDATE accounts SET username = ? WHERE id = ?", C.repeat(300), mentions[1]!);
    await sql(t.store, "UPDATE accounts SET username = ? WHERE id = ?", `u\u0000${C.repeat(253)}`, mentions[2]!);
    const url = atLimit(`https://${HOST}/notes/long/`, 4096);
    const id = await storedStatus(t, author, {
      content: "<p>x</p>",
      spoiler: "",
      media: Array.from({ length: MAX_STATUS_MEDIA + 2 }, (_, i) => ({
        url: atLimit(`https://${HOST}/m/${i}/`, MEDIA_URL_LIMIT),
        preview: null,
        description: "",
        meta: null,
      })),
      mentions,
      tags: [
        ...Array.from({ length: MAX_STATUS_TAGS + 50 }, (_, i) => `t${String(i).padStart(3, "0")}`),
        "a".repeat(300),
      ],
      poll: Array.from({ length: MAX_REMOTE_OPTIONS }, () => "x".repeat(6_000)),
      uri: atLimit(`https://${HOST}/objects/long/`, 4097),
      url,
    });
    const { answer, longest } = await read(t, getStatus, id);
    const status = answer as Presented;
    expect([status.uri, status.url]).toEqual(["", url]);
    expect(status.account.url).toBe(atLimit(`https://${HOST}/@${author}/`, PROFILE_URL_LIMIT));
    expect(status.media_attachments.map((m) => m.url)).toEqual(
      Array.from({ length: MAX_STATUS_MEDIA }, (_, i) => atLimit(`https://${HOST}/m/${i}/`, MEDIA_URL_LIMIT)),
    );
    expect(status.mentions).toHaveLength(MAX_STATUS_MENTION_ROWS);
    expect(status.mentions.map((m) => m.id)).toEqual(mentions.toSorted().slice(0, MAX_STATUS_MENTION_ROWS));
    const cut = status.mentions.find((m) => m.id === mentions[0])!;
    expect(cut).toEqual({
      id: mentions[0],
      username: `u${"v".repeat(USERNAME_LIMIT - 1)}`,
      acct: `u${"v".repeat(USERNAME_LIMIT - 1)}@${HOST}`,
      // Its url derived from the host and the username would pass PROFILE_URL_LIMIT: none fits, so ''.
      url: "",
    });
    // A NUL hides what follows it from GLOB; the username is still read within its JSON bound.
    const nul = status.mentions.find((m) => m.id === mentions[2])!;
    expect(jsonStringBytes(nul.username as string)).toBeLessThanOrEqual(USERNAME_LIMIT + 2);
    expect(jsonStringBytes(nul.acct as string)).toBeLessThanOrEqual(USERNAME_LIMIT + 2 + HOST.length + 1);
    const odd = status.mentions.find((m) => m.id === mentions[1])!;
    expect(odd.username).toBe(C.repeat(Math.floor(USERNAME_LIMIT / 6)));
    expect(jsonStringBytes(odd.username as string)).toBeLessThanOrEqual(USERNAME_LIMIT + 2);
    // The over-long name sorts first: it takes one of the MAX_PRESENTED_TAGS rows read and is left out.
    expect(status.tags.map((tag) => tag.name)).toEqual(
      Array.from({ length: MAX_PRESENTED_TAGS - 1 }, (_, i) => `t${String(i).padStart(3, "0")}`),
    );
    expect(status.poll!.options.map((o) => o.title)).toEqual(
      Array.from({ length: MAX_REMOTE_OPTIONS }, () => "x".repeat(MAX_REMOTE_OPTION_LENGTH)),
    );
    // The longest value that left SQLite is the poll's choices as a JSON array, within their bound: the 64 KiB
    // username, the actor ids and the 600 KB of stored choices stayed.
    expect(longest).toBeLessThanOrEqual(MAX_REMOTE_OPTIONS * (6 * MAX_REMOTE_OPTION_LENGTH + 3) + 1);
  });

  it("projects edit history snapshots' media within their bounds", async () => {
    const t = await setup();
    const author = await maximalAccount(t);
    const id = await storedStatus(t, author, {
      content: "<p>now</p>",
      spoiler: "",
      media: [],
      mentions: [],
      tags: [],
      poll: null,
    });
    const snapshot = (i: number) => ({ id: `m${i}`, type: "image", description: C.repeat(10_000) });
    await sql(
      t.store,
      `INSERT INTO status_edits (status_id, content, spoiler_text, media_json, poll_options, created_at) VALUES
				(?1, '<p>a</p>', '', ?2, NULL, ?3), (?1, '<p>b</p>', '', ?4, ?5, ?3)`,
      id,
      JSON.stringify(Array.from({ length: 10 }, (_, i) => snapshot(i))),
      new Date(NOW).toISOString(),
      // A small snapshot whose single fields are past their bounds: a long URL, description and meta.
      JSON.stringify([
        "not an attachment",
        ...Array.from({ length: 6 }, (_, i) => ({
          id: `m${i}`,
          type: "image",
          url: atLimit(`https://${HOST}/m/${i}/`, MEDIA_URL_LIMIT + i),
          preview_url: atLimit(`https://${HOST}/p/${i}/`, MEDIA_URL_LIMIT),
          description: "d".repeat(2 * MAX_MEDIA_DESCRIPTION_LENGTH),
          meta: i === 0 ? { original: { width: 1, height: 1 } } : { x: "x".repeat(2_000) },
          extra: "x".repeat(1_000),
        })),
      ]),
      JSON.stringify(["a", "b"]),
    );
    const { answer, longest } = await read(t, statusHistory, id);
    const [first, second] = answer as {
      media_attachments: unknown[];
      poll: { options: { title: string }[] } | null;
    }[];
    // Past EDIT_MEDIA_BYTES, a snapshot reads as no media.
    expect(first!.media_attachments).toEqual([]);
    // The first MAX_STATUS_MEDIA entries (the string among them left out), each rebuilt within the column bounds.
    expect(second!.media_attachments).toEqual(
      Array.from({ length: MAX_STATUS_MEDIA - 1 }, (_, i) => ({
        id: `m${i}`,
        type: "image",
        url: i === 0 ? atLimit(`https://${HOST}/m/0/`, MEDIA_URL_LIMIT) : null,
        preview_url: atLimit(`https://${HOST}/p/${i}/`, MEDIA_URL_LIMIT),
        remote_url: null,
        preview_remote_url: null,
        text_url: null,
        meta: i === 0 ? { original: { width: 1, height: 1 } } : null,
        description: "d".repeat(MAX_MEDIA_DESCRIPTION_LENGTH),
        blurhash: null,
      })),
    );
    expect(second!.poll!.options.map((o) => o.title)).toEqual(["a", "b"]);
    expect(longest).toBeLessThanOrEqual(STATUS_CONTENT_BYTES);
  });

  // The most JSON one snapshot entry holds as editMediaSql projects it, at the worst escaping: an id and a type of
  // SNAPSHOT_KEY_LIMIT escaping code points, four URLs at MEDIA_URL_JSON_BYTES, a meta of MEDIA_META_BYTES, a
  // description of MAX_MEDIA_DESCRIPTION_LENGTH escaping units and a blurhash at BLURHASH_JSON_MAX. EDIT_MEDIA_BYTES is
  // the smallest MAX_STATUS_MEDIA times a whole KiB that holds MAX_STATUS_MEDIA of them as a JSON array.
  it("derives the snapshot bound from the caps of one entry", () => {
    const url = "\\".repeat(MEDIA_URL_LIMIT);
    const entry = {
      id: C.repeat(SNAPSHOT_KEY_LIMIT),
      type: C.repeat(SNAPSHOT_KEY_LIMIT),
      url,
      preview_url: url,
      remote_url: url,
      preview_remote_url: url,
      text_url: null,
      meta: JSON.parse(MAX_META) as unknown,
      description: C.repeat(MAX_MEDIA_DESCRIPTION_LENGTH),
      blurhash: blurhashOf(5, 5),
    };
    expect([jsonBytes(url), jsonBytes(entry.meta), jsonBytes(entry.blurhash)]).toEqual([
      MEDIA_URL_JSON_BYTES,
      MEDIA_META_BYTES,
      BLURHASH_JSON_MAX,
    ]);
    const four = jsonBytes(Array.from({ length: MAX_STATUS_MEDIA }, () => entry));
    const kib = Math.ceil(four / MAX_STATUS_MEDIA / 1024);
    expect({ entry: jsonBytes(entry), four, kib }).toEqual({ entry: 77_986, four: 311_949, kib: 77 });
    expect(EDIT_MEDIA_BYTES).toBe(MAX_STATUS_MEDIA * kib * 1024);
  });

  // Regression witness: a snapshot past the earlier bound (72 KiB an entry), within EDIT_MEDIA_BYTES, reads its
  // media.
  it("reads a snapshot of four entries of escaped descriptions and URLs", async () => {
    const t = await setup();
    const id = await storedStatus(t, await maximalAccount(t, true), {
      content: "<p>now</p>",
      spoiler: "",
      media: [],
      mentions: [],
      tags: [],
      poll: null,
    });
    const entries = Array.from({ length: MAX_STATUS_MEDIA }, (_, i) => ({
      id: `m${i}`,
      type: "image",
      url: escapingUrl(`https://m.example/${i}/?`),
      preview_url: escapingUrl(`https://p.example/${i}/?`),
      remote_url: escapingUrl(`https://m.example/${i}/?`),
      preview_remote_url: escapingUrl(`https://p.example/${i}/?`),
      text_url: null,
      meta: null,
      description: C.repeat(MAX_MEDIA_DESCRIPTION_LENGTH),
      blurhash: blurhashOf(5, 5),
    }));
    const snapshot = JSON.stringify(entries);
    expect(utf8Length(snapshot)).toBeGreaterThan(MAX_STATUS_MEDIA * 72 * 1024);
    expect(utf8Length(snapshot)).toBeLessThanOrEqual(EDIT_MEDIA_BYTES);
    await sql(
      t.store,
      `INSERT INTO status_edits (status_id, content, spoiler_text, media_json, created_at)
			VALUES (?1, '<p>a</p>', '', ?2, ?3)`,
      id,
      snapshot,
      new Date(NOW).toISOString(),
    );
    const { answer } = await read(t, statusHistory, id);
    expect((answer as { media_attachments: unknown[] }[])[0]!.media_attachments).toEqual(entries);
  });

  // Regression witness: the shared media URL rule judges the decoded value before normalization, so neither a value
  // past the byte bound that normalization shrinks, nor a NUL, control or malformed byte in a path or query that
  // normalization would percent-encode, is shown.
  it("judges a media URL as decoded, then as normalized", () => {
    const shrinking = `https://ok.example/${"x/../".repeat(420)}a`;
    expect([utf8Length(shrinking), new URL(shrinking).href]).toEqual([2_120, "https://ok.example/a"]);
    for (const value of [
      shrinking,
      "https://ok.example/a\u0000b",
      "https://ok.example/a\u0001b",
      "https://ok.example/a\u007fb",
      "https://ok.example/?q=\u0000",
      "https://ok.example/?q=\u001f",
      "https://ok.example/\ufffd",
      "https://ok.example/?\ud800",
      atLimit("https://ok.example/é", MEDIA_URL_LIMIT),
      atLimit("https://ok.example/ ", MEDIA_URL_LIMIT),
      "javascript:alert(1)",
      42,
    ]) {
      expect(presentedMediaUrl(value), JSON.stringify(value)).toBeNull();
    }
    for (const [value, shown] of [
      ["https://ok.example/a/./b/../c", "https://ok.example/a/c"],
      ["https://OK.example/é", "https://ok.example/%C3%A9"],
      [atLimit("https://ok.example/", MEDIA_URL_LIMIT), atLimit("https://ok.example/", MEDIA_URL_LIMIT)],
      [escapingUrl("https://ok.example/?"), escapingUrl("https://ok.example/?")],
    ]) {
      expect(presentedMediaUrl(value)).toBe(shown);
    }
  });

  // Regression witness: a stored meta that is not an object of dimensions shows no size,
  // and the attachment is still presented; so is a live URL whose path or query holds a NUL or a control.
  it("presents stored media whose meta or URLs are malformed", async () => {
    const t = await setup();
    const metas = ["null", '{"original":null}', '{"original":{"width":0,"height":1},"small":"x"}', "[1]"];
    const id = await storedStatus(t, await maximalAccount(t, true), {
      content: "<p>now</p>",
      spoiler: "",
      media: metas.map((meta, i) => ({
        url: i === 0 ? "https://ok.example/a\u0000b" : `https://ok.example/${i}`,
        preview: i === 1 ? "https://ok.example/?q=\u0001" : null,
        description: "",
        meta,
      })),
      mentions: [],
      tags: [],
      poll: null,
    });
    const { answer } = await read(t, getStatus, id);
    const media = (answer as Presented).media_attachments;
    expect(media.map((m) => [m.url, m.preview_url, m.remote_url, m.preview_remote_url, m.meta])).toEqual([
      [null, null, null, null, { focus: { x: -1, y: -1 } }],
      ["https://ok.example/1", "https://ok.example/1", "https://ok.example/1", null, { focus: { x: -1, y: -1 } }],
      ["https://ok.example/2", "https://ok.example/2", "https://ok.example/2", null, { focus: { x: -1, y: -1 } }],
      ["https://ok.example/3", "https://ok.example/3", "https://ok.example/3", null, { focus: { x: -1, y: -1 } }],
    ]);
  });

  // Regression witness: each URL of an imported snapshot passes the presented-URL rule as decoded (presentedMediaUrl),
  // and its blurhash storedBlurhash's, as live media do; editMediaSql bounds their bytes only.
  it("judges an imported snapshot's URLs and blurhash as live media", async () => {
    const t = await setup();
    const id = await storedStatus(t, await maximalAccount(t, true), {
      content: "<p>now</p>",
      spoiler: "",
      media: [],
      mentions: [],
      tags: [],
      poll: null,
    });
    // U+007F stands for a byte 0xFF (malformed UTF-8) in the stored text.
    const MALFORMED = "\u007f";
    const ok = "https://ok.example/a";
    const atCap = atLimit("https://ok.example/r/", MEDIA_URL_LIMIT);
    const entry = (i: number, fields: Record<string, unknown>) => ({ id: `m${i}`, type: "image", ...fields });
    const entries = [
      entry(0, {
        url: "javascript:alert(1)",
        preview_url: "https://ok\u0001.example/",
        remote_url: "https://ok\u0000.example/",
        preview_remote_url: `https://ok${MALFORMED}.example/`,
        blurhash: blurhashOf(5, 5),
      }),
      entry(1, {
        url: atLimit(`https://ok.example/${MALFORMED.repeat(8)}`, MEDIA_URL_LIMIT),
        preview_url: atLimit("https://ok.example/   ", MEDIA_URL_LIMIT),
        remote_url: atCap,
        preview_remote_url: `${atCap}u`,
        blurhash: "LEHV6",
      }),
      entry(2, { url: ok, preview_url: ok, remote_url: ok, preview_remote_url: ok, blurhash: 42 }),
      entry(3, {
        url: ok,
        preview_url: "https://ok.example/a\u0000b",
        remote_url: `https://ok.example/${MALFORMED}`,
        preview_remote_url: "https://ok.example/?q=\u0001",
        blurhash: `${blurhashOf(1, 1)}\u0000`,
      }),
    ];
    const bytes = new TextEncoder().encode(JSON.stringify(entries)).map((byte) => (byte === 0x7f ? 0xff : byte));
    await sql(
      t.store,
      `INSERT INTO status_edits (status_id, content, spoiler_text, media_json, created_at)
			VALUES (?1, '<p>a</p>', '', CAST(?2 AS TEXT), ?3)`,
      id,
      bytes.buffer,
      new Date(NOW).toISOString(),
    );
    const { answer } = await read(t, statusHistory, id);
    const shown = (answer as { media_attachments: Record<string, unknown>[] }[])[0]!.media_attachments;
    const fields = (m: Record<string, unknown>) => MEDIA_STRINGS.map((key) => m[key]);
    expect(shown.map(fields)).toEqual([
      [null, null, null, null, blurhashOf(5, 5)],
      [null, null, atCap, null, null],
      [ok, ok, ok, ok, null],
      [ok, null, null, null, null],
    ]);
  });
});

describe("each per-status cap reads a bounded number of rows (RES-7)", () => {
  it("reads at most its cap of rows whatever a converted status holds, each status once", async () => {
    const t = await setup();
    const author = await maximalAccount(t, true);
    const id = await storedStatus(t, author, {
      content: "<p>x</p>",
      spoiler: "",
      media: [],
      mentions: [],
      tags: [],
      poll: null,
    });
    const many = 10_000;
    // Rejected rows that sort before the presented ones: over-long tag names, hidden media and silent mentions.
    await sql(
      t.store,
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?2 - 1)
			INSERT INTO status_tags (status_id, name, public) SELECT ?1, 'a' || printf('%05d', i) || ?3, 1 FROM n`,
      id,
      many,
      "x".repeat(MAX_TAG_LENGTH),
    );
    await sql(t.store, "INSERT INTO status_tags (status_id, name, public) VALUES (?1, 'shown', 1)", id);
    await sql(
      t.store,
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?3 - 1)
			INSERT INTO media_attachments (id, account_id, status_id, position, type, url, shown)
			SELECT CAST(800000000000000000 + i AS TEXT), ?2, ?1, i, 'image', 'https://m.example/' || i, 0 FROM n`,
      id,
      author,
      many,
    );
    await sql(
      t.store,
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
			INSERT INTO accounts (id, uri, username, domain)
			SELECT CAST(700000000000000000 + i AS TEXT), 'https://m.example/users/s' || i, 's' || i, 'm.example' FROM n`,
      many,
    );
    await sql(
      t.store,
      `INSERT INTO status_mentions (status_id, account_id, silent, requires_mention, author_id)
			SELECT ?1, id, 1, 0, ?2 FROM accounts WHERE id BETWEEN '700000000000000000' AND '700000000000009999'`,
      id,
      author,
    );
    const credentialOf = await credential(t);
    const rows = (ids: string[]) =>
      rowsRead(t, getStatuses as never, { credential: credentialOf, now: NOW, ids, present: { origin: ORIGIN } });
    const once = await rows([id]);
    // The status, its account, at most MAX_STATUS_MENTION_ROWS mentions, MAX_PRESENTED_TAGS tags and MAX_STATUS_MEDIA
    // media, and a constant number of other rows; never the 30,000 rejected ones.
    expect(once).toBeLessThan(MAX_STATUS_MENTION_ROWS + MAX_PRESENTED_TAGS + MAX_STATUS_MEDIA + 200);
    // Repeating the id adds only the rows of reading the repeated ids, not another status's worth.
    expect(await rows([id, id, id, id])).toBeLessThanOrEqual(once + 8);
    const { answer } = await read(t, getStatus, id);
    expect(answer).toMatchObject({ media_attachments: [], mentions: [], tags: [] });
  });
});

describe("a conversation presents its first participants (RES-3)", () => {
  it("reads only the participants it presents out of SQLite, whatever the row stores", async () => {
    const t = await setup();
    const author = await maximalAccount(t, true);
    const id = await storedStatus(t, author, {
      content: "<p>x</p>",
      spoiler: "",
      media: [],
      mentions: [],
      tags: [],
      poll: null,
    });
    const stored = Array.from({ length: 5_000 }, (_, i) => String(600_000_000_000_000_000n + BigInt(i)));
    await sql(
      t.store,
      "INSERT INTO conversations (account_id, thread, participants, last_status_id) VALUES (?, 'th', ?, ?)",
      ALICE,
      JSON.stringify(stored),
      id,
    );
    const listed = await measured(
      t,
      listConversations as never,
      {
        credential: await credential(t),
        page: { limit: 1 },
        present: { origin: ORIGIN },
      } as never,
    );
    // The stored list is 105,000 bytes; what leaves SQLite is the last status with its author and URLs (about 15 KB)
    // and 12 ids of the list.
    expect(listed.sqliteBytes).toBeLessThan(30_000);
  });
});

describe("an ordinary status keeps its mentions and hashtags (RES-2)", () => {
  it("shows a current mention after more silent rows than the cap, as an edited status keeps them", async () => {
    const h = await community(["alice"]);
    const bob = await remoteAccount(h.store, "bob");
    const posted = await post(h, h.users.alice, { status: "@bob@remote.example hello" });
    // Recipients an edit removed stay as silent rows, without a cap, and may sort before the current one.
    await sql(
      h.store,
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
			INSERT INTO accounts (id, uri, username, domain)
			SELECT CAST(100000000000000000 + i AS TEXT), 'https://old.example/users/o' || i, 'o' || i, 'old.example' FROM n`,
      MAX_STATUS_MENTION_ROWS + 50,
    );
    await sql(
      h.store,
      `INSERT INTO status_mentions (status_id, account_id, silent, requires_mention, author_id)
			SELECT ?1, id, 1, 0, ?2 FROM accounts WHERE domain = 'old.example'`,
      posted.id,
      h.users.alice.id,
    );
    const response = await h.request(`/api/v1/statuses/${posted.id}`, {
      headers: { authorization: `Bearer ${h.users.alice.token}` },
    });
    const shown = await response.json<{ mentions: { id: string }[] }>();
    // The silent rows sort before the current mention.
    expect(bob > String(100_000_000_000_000_000n + BigInt(MAX_STATUS_MENTION_ROWS + 50))).toBe(true);
    expect(shown.mentions.map((m) => m.id)).toEqual([bob]);
  });

  it("records a local hashtag past its bound, and leaves it out of the 70 presented when it sorts first", async () => {
    const h = await community(["alice"]);
    const long = "a".repeat(MAX_TAG_LENGTH + 1);
    const cjk = Array.from({ length: MAX_PRESENTED_TAGS }, (_, i) => `#${String.fromCodePoint(0x4e00 + i)}`);
    const posted = await post(h, h.users.alice, { status: `#${long} ${cjk.join(" ")}` });
    // Stored and associated, as Mastodon records it.
    expect(
      await sql(h.store, "SELECT name FROM status_tags WHERE status_id = ? AND name = ?", posted.id, long),
    ).toEqual([{ name: long }]);
    // It sorts before the others, takes one of the MAX_PRESENTED_TAGS rows read, and is left out: 69 are presented.
    expect(posted.tags.map((tag) => `#${tag.name}`).toSorted()).toEqual(
      cjk.toSorted().slice(0, MAX_PRESENTED_TAGS - 1),
    );
  });

  it("keeps a local post with a hashtag past its bound on that hashtag's timeline, after an edit too", async () => {
    const h = await community(["alice"]);
    const long = "a".repeat(MAX_TAG_LENGTH + 1);
    const posted = await post(h, h.users.alice, { status: `hello #${long}` });
    const timeline = async () => {
      const response = await h.request(`/api/v1/timelines/tag/${long}`, {
        headers: { authorization: `Bearer ${h.users.alice.token}` },
      });
      return (await response.json<{ id: string }[]>()).map((status) => status.id);
    };
    expect(await timeline()).toEqual([posted.id]);
    const edited = await h.request(`/api/v1/statuses/${posted.id}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${h.users.alice.token}`, "content-type": "application/json" },
      body: JSON.stringify({ status: `edited #${long}` }),
    });
    expect(edited.status).toBe(200);
    expect(await timeline()).toEqual([posted.id]);
  });
});

// Realistic posts of each implementation at its own length limit, in Japanese with its own markup.
const misskey = () => {
  const mention = '<a href="https://misskey.example/@bob" class="u-url mention">@bob@misskey.example</a>';
  const tag = '<a href="https://misskey.example/tags/日本語" rel="tag">#日本語</a>';
  const link = '<a href="https://example.com/path/to/page">https://example.com/path/to/page</a>';
  return `<p><span>${Array.from({ length: 30 }, () => `${"本文の文章です。".repeat(11)} ${mention} ${tag} ${link}<br>`).join("")}</span></p>`;
};
const pleroma = () => {
  const mention =
    '<span class="h-card"><a class="u-url mention" data-user="AbCdEf123" href="https://pleroma.example/users/bob" ' +
    'rel="ugc">@<span>bob</span></a></span>';
  const tag =
    '<a class="hashtag" data-tag="日本語" href="https://pleroma.example/tag/日本語" rel="tag ugc">#日本語</a>';
  const link = '<a href="https://example.com/path/to/page" rel="ugc">https://example.com/path/to/page</a>';
  return Array.from({ length: 50 }, () => `${"本文の文章です。".repeat(11)} ${mention} ${tag} ${link}<br/>`).join("");
};
const gotosocial = () => {
  const mention =
    '<span class="h-card"><a href="https://gts.example/@bob" class="mention" rel="nofollow noreferrer noopener" ' +
    'target="_blank">@<span>bob</span></a></span>';
  const tag =
    '<a href="https://gts.example/tags/日本語" class="mention hashtag" rel="tag nofollow noreferrer noopener" ' +
    'target="_blank">#<span>日本語</span></a>';
  return Array.from({ length: 50 }, () => `<p>${"本文の文章です。".repeat(11)} ${mention} ${tag}</p>`).join("");
};
const mastodon = () =>
  '<p><span class="h-card" translate="no"><a href="https://mastodon.example/@bob" class="u-url mention">@<span>bob</span>' +
  `</a></span> ${"本文の文章です。".repeat(55)}</p><p><a href="https://mastodon.example/tags/日本語" ` +
  'class="mention hashtag" rel="tag">#<span>日本語</span></a></p>';

describe("realistic content is never cut (RES-2)", () => {
  it.each([
    ["Misskey (3,000 characters)", misskey],
    ["Pleroma and Akkoma (5,000)", pleroma],
    ["GoToSocial (5,000)", gotosocial],
    ["Mastodon (500)", mastodon],
  ])("keeps %s whole, as stored and as read", async (_name, html) => {
    const stored = sanitizeRemoteContent(html());
    expect(stored).toBe(sanitizeRemoteHtml(html()));
    expect(jsonStringBytes(stored)).toBeLessThan(STATUS_CONTENT_BYTES / 2);
    const spoiler = "ネタバレ注意。".repeat(70);
    expect(
      parseRemoteStatus({
        id: "https://remote.example/notes/1",
        type: "Note",
        to: ["https://www.w3.org/ns/activitystreams#Public"],
        content: html(),
        summary: spoiler,
      }),
    ).toMatchObject({ content: stored, spoilerText: spoiler });
    const t = await setup();
    const author = await maximalAccount(t, true);
    const id = await storedStatus(t, author, {
      content: stored,
      spoiler,
      media: [],
      mentions: [],
      tags: [],
      poll: null,
    });
    const { answer } = await read(t, getStatus, id);
    expect(answer).toMatchObject({ content: stored, spoiler_text: spoiler });
  });
});

// The viewer's own filters at their bounds (filters.ts): MAX_FILTERS of them in every context, each with a title of
// MAX_FILTER_TITLE characters and a keyword of MAX_FILTER_KEYWORD that the statuses' text holds, and each naming the
// given statuses, so every presented status carries every filter with a keyword match and its status matches.
async function maximalFilters(t: Setup, fill: Fill, statuses: readonly string[]): Promise<void> {
  // The first keyword is what the statuses hold, so it matches; the rest fill the filter's keywords.
  const matching = (fill === "raw" ? "x" : C).repeat(MAX_FILTER_KEYWORD);
  const other = (k: number) =>
    fill === "raw" ? `${String.fromCodePoint(0x20000 + k)}${W.repeat(MAX_FILTER_KEYWORD - 1)}` : matching;
  for (let i = 0; i < MAX_FILTERS; i++) {
    const filter = nextId();
    await sql(
      t.store,
      `INSERT INTO filters (id, account_id, title, context, action) VALUES (?, ?, ?, ?, 'warn')`,
      filter,
      ALICE,
      (fill === "raw" ? W : C).repeat(MAX_FILTER_TITLE),
      JSON.stringify(["home", "notifications", "public", "thread", "account"]),
    );
    for (let k = 0; k < MAX_FILTER_KEYWORDS; k++) {
      await sql(
        t.store,
        "INSERT INTO filter_keywords (id, filter_id, keyword, whole_word) VALUES (?, ?, ?, 0)",
        nextId(),
        filter,
        k === 0 ? matching : other(k),
      );
    }
    for (const status of statuses) {
      await sql(
        t.store,
        "INSERT INTO filter_statuses (id, filter_id, status_id) VALUES (?, ?, ?)",
        nextId(),
        filter,
        status,
      );
    }
  }
}

// A quote of a status and a boost of the quote, each part of every status at its bound and each account at its
// bounds, filled as `fill`, with alice's profile and filters at their bounds, the filters naming all three, her votes
// in every choice of both polls shown, and every flag of hers on each. The boost's own row holds every part its CHECK
// and triggers accept (all but content), and attachments, mentions, hashtags and a poll of its own, which the presenter
// neither reads nor shows.
async function maximalStatuses(fill: Fill) {
  const t = await setup();
  await sql(
    t.store,
    `UPDATE accounts SET display_name = ?, note = ?, url = ?, avatar_url = ?, header_url = ?, emojis = ?,
			avatar_description = ?7, header_description = ?7, show_featured = 0, show_media = 0, show_media_replies = 0
		WHERE id = ?8`,
    (fill === "raw" ? W : C).repeat(2048),
    fill === "raw" ? RAW_BIO : MAX_BIO,
    atLimit(`https://kopje.test/@alice/`, PROFILE_URL_LIMIT),
    atLimit(`https://kopje.test/a/alice/`, PROFILE_URL_LIMIT),
    atLimit(`https://kopje.test/h/alice/`, PROFILE_URL_LIMIT),
    accountEmojis(fill),
    profileDescription(fill),
    ALICE,
  );
  const [booster, quoter, quotedAuthor] = [
    await maximalAccount(t, false, fill),
    await maximalAccount(t, false, fill),
    await maximalAccount(t, false, fill),
  ];
  const quoted = await storedStatus(t, quotedAuthor, await maximalParts(t, fill));
  const quote = await storedStatus(t, quoter, await maximalParts(t, fill));
  await acceptQuote(t, quote, quoted);
  const boost = await storedStatus(t, booster, { ...(await maximalParts(t, fill)), reblogOf: quote });
  // A card on each, the boost's own row too (an imported row: the presenter never reads a boost's).
  for (const id of [quoted, quote, boost]) {
    await maximalCard(t, id, fill);
  }
  await maximalFilters(t, fill, [quoted, quote, boost]);
  const at = new Date(NOW).toISOString();
  for (const id of [quoted, quote]) {
    await sql(t.store, "UPDATE polls SET multiple = 1 WHERE status_id = ?", id);
    await sql(
      t.store,
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ? - 1)
			INSERT INTO poll_votes (poll_id, account_id, choice, generation, created_at) SELECT ?, ?, i, 0, ? FROM n`,
      MAX_REMOTE_OPTIONS,
      id,
      ALICE,
      at,
    );
  }
  for (const id of [quoted, quote, boost]) {
    await sql(t.store, "INSERT INTO favourites (account_id, status_id, created_at) VALUES (?, ?, ?)", ALICE, id, at);
    await sql(t.store, "INSERT INTO bookmarks (account_id, status_id, created_at) VALUES (?, ?, ?)", ALICE, id, at);
    await sql(
      t.store,
      "INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, published_at) VALUES (?, ?, ?, ?, 'public', ?)",
      nextId(),
      `https://kopje.test/boosts/${id}`,
      ALICE,
      id,
      at,
    );
  }
  return { t, quoted, quote, boost };
}

// A status's card at its stored bounds for the fill (migrations 0067_status_cards and 0069_card_embeds): each text at
// its JSON bound in characters JSON escapes to six bytes (its rest in ASCII), or, in the raw fill, at its raw bound in
// ASCII (the bounds are in bytes); its URLs at their bounds in ASCII; a video of CARD_DIMENSION_MAX by
// CARD_DIMENSION_MAX whose iframe src is at its raw bound in ASCII (the raw fill) or at its escaped bound with as many
// & as fit (the others), and its iframe dimensions at CARD_DIMENSION_MAX; and (0070_card_images) a stored image of a
// 64-byte token at CARD_IMAGE_EDGE_MAX by CARD_IMAGE_EDGE_MAX with a blurhash at BLURHASH_BYTES, its source URL at its
// bound and its alt text at its JSON bound; and (0098_card_attribution) an unverified author at its stored bound (18
// digits), an account other than the viewer's (ALICE), so its missing_attribution is false.
async function maximalCard(t: Setup, statusId: string, fill: Fill): Promise<void> {
  const text = (bytes: number) =>
    fill === "raw" ? "a".repeat(bytes - 2) : C.repeat(Math.floor((bytes - 2) / 6)) + "a".repeat((bytes - 2) % 6);
  const ampersands = Math.floor((CARD_EMBED_SRC_ESCAPED_BYTES - "https://v.example/?".length) / 5);
  const src =
    fill === "raw"
      ? atLimit("https://v.example/", CARD_EMBED_SRC_BYTES)
      : `https://v.example/?${"&".repeat(ampersands)}`.padEnd(CARD_EMBED_SRC_ESCAPED_BYTES - 4 * ampersands, "u");
  await sql(
    t.store,
    `INSERT INTO status_cards (status_id, url, enqueued_at, generation, title, description, author_name, author_url,
			provider_name, provider_url, language, published_at, fetched_at, card_type, width, height, embed_src,
			iframe_width, iframe_height)
		VALUES (?1, ?2, 0, 0, ?3, ?4, ?5, ?6, ?7, ?8, 'mn-Mong', ?9, 1, 2, ${CARD_DIMENSION_MAX}, ${CARD_DIMENSION_MAX}, ?10,
			${CARD_DIMENSION_MAX}, ${CARD_DIMENSION_MAX})`,
    statusId,
    atLimit("https://card.example/", CARD_URL_LIMIT),
    text(CARD_TEXTS.title),
    text(CARD_TEXTS.description),
    text(CARD_TEXTS.author_name),
    atLimit("https://author.example/", CARD_OPTIONAL_URL_LIMIT),
    text(CARD_TEXTS.provider_name),
    atLimit("https://provider.example/", CARD_OPTIONAL_URL_LIMIT),
    new Date(NOW).toISOString(),
    src,
  );
  const imageId = `9${statusId.slice(1)}`;
  await sql(
    t.store,
    `INSERT INTO card_images (id, source_url, enqueued_at, token, width, height, blurhash, stored_at)
		VALUES (?1, ?2, 0, ?3, ${CARD_IMAGE_EDGE_MAX}, ${CARD_IMAGE_EDGE_MAX}, ?4, 1)`,
    imageId,
    atLimit("https://img.example/", CARD_URL_LIMIT),
    `${"k".repeat(CARD_IMAGE_TOKEN_BYTES - statusId.length)}${statusId}`,
    `e${"0".repeat(BLURHASH_BYTES - 1)}`,
  );
  await sql(
    t.store,
    `UPDATE status_cards SET image_url = ?2, image_id = ?3, image_description = ?4, unverified_author_account_id = ?5
		WHERE status_id = ?1`,
    statusId,
    atLimit("https://img.example/", CARD_URL_LIMIT),
    imageId,
    text(CARD_IMAGE_DESCRIPTION_JSON_BYTES),
    "222222222222222222",
  );
}

// What each fill measures: the table of maxima, and for each item of the heap model its rows by query and column (its
// JSON is the table's). Measured once per fill, by whichever test asks first.
type FillMeasure = {
  shapes: Record<string, Shape>;
  heaps: Record<string, Heaps>;
  // The nested moved-to accounts each shape shows: how many, and what their JSON lacks of MOVED_ACCOUNT_JSON_MAX.
  moved: Record<string, { count: number; deficit: number }>;
  // The statuses each shape shows: how many, and what their `application` entries lack of APPLICATION_JSON_MAX.
  applications: Record<string, { count: number; deficit: number }>;
  // The statuses each shape shows that may show a card (not a boost or a quoted status): how many, and what their
  // cards lack of CARD_JSON_MAX (a card shown in place of null).
  cards: Record<string, { count: number; deficit: number }>;
  // The attachments each shape shows: how many, and what their URLs and blurhash lack of their maxima.
  media: Record<string, { count: number; deficit: number }>;
  // The verified local fields each shape shows: how many, and what their values lack of LOCAL_FIELD_VALUE_JSON_MAX.
  localFields: Record<string, { count: number; deficit: number }>;
  // The remote accounts each shape shows: how many, and what their fields' JSON lacks of REMOTE_FIELDS_JSON_MAX.
  remoteFields: Record<string, { count: number; deficit: number }>;
  // The fallbacks each shape shows (its notifications read with every fallback type): how many, and what their JSON
  // lacks of FALLBACK_JSON_MAX.
  fallbacks: Record<string, { count: number; deficit: number }>;
  // The JSON of the fields of the account occurrence (a remote account's, at REMOTE_FIELDS_BYTES).
  accountFields: number;
  // The moderation_warning notification as a stream payload: its JSON, which carries no fallback, encoded again as a
  // string (stream-hub.ts).
  warningPayload: number;
  // The escaped fill's streamed witnesses of the turn's hard bound: the conversation and the notification whose status
  // is the boost of the quote, as the stream presents them (their JSON), and the conversation's payload.
  streamed: { conversation: number; conversationPayload: number; notification: number } | undefined;
};
const fills = new Map<Fill, Promise<FillMeasure>>();

function measureFill(fill: Fill): Promise<FillMeasure> {
  const measure = fills.get(fill) ?? measureShapes(fill);
  fills.set(fill, measure);
  return measure;
}

// The emoji-cache fill's cached copies (remote-media.ts): an emoji slot at the packed cap (a 64-character token and
// four-letter extensions) for every entry of every remote snapshot, under its account's domain. The fixtures' domains
// pass the slot's stored bound (an emoji slot's domain is a link domain), which nothing read here depends on, so the
// slot's insert trigger is dropped for this fixture's Store.
async function cachedEmojis(t: Setup, fill: Fill): Promise<void> {
  if (fill !== "emoji-cache") {
    return;
  }
  await sql(t.store, "DROP TRIGGER IF EXISTS remote_media_bounds_insert");
  await sql(
    t.store,
    `INSERT OR IGNORE INTO remote_media (kind, domain, url, host, category, lane, generation, enqueued_at, token, ext,
			still_ext, stored_at, seen_at)
		SELECT 'emoji', d, u, 'e.co', 'image', 0, 0, 1, lower(hex(randomblob(32))), 'webp', 'webp', 1, 1 FROM (
			SELECT a.domain AS d, json_extract(e.value, '$[1]') AS u FROM accounts a, json_each(a.emojis) e
			WHERE a.domain IS NOT NULL
			UNION SELECT au.domain, json_extract(e.value, '$[1]') FROM statuses s JOIN accounts au ON au.id = s.account_id,
				json_each(s.emojis) e WHERE au.domain IS NOT NULL)`,
  );
}

// The raw fill's cached attachments (remote-media.ts): each remote attachment's file and icon cached at the packed cap,
// for its current URLs and category. As cachedEmojis, the slot's insert trigger is dropped for this fixture's Store
// (the fixtures' URLs pass the slot's stored bounds, which nothing read here depends on).
async function cachedMedia(t: Setup, fill: Fill): Promise<void> {
  if (fill !== "raw") {
    return;
  }
  await sql(t.store, "DROP TRIGGER IF EXISTS remote_media_bounds_insert");
  for (const [kind, url, category] of [
    ["attachment", "m.url", mediaCategorySql("m.type")],
    ["thumbnail", "m.preview_url", "'image'"],
  ] as const) {
    await sql(
      t.store,
      `INSERT OR IGNORE INTO remote_media (kind, owner_id, account_id, url, host, category, lane, generation, enqueued_at,
				token, ext, still_ext, stored_at)
			SELECT '${kind}', m.id, m.account_id, ${url}, 'm.example', ${category}, 0, 0, 1, lower(hex(randomblob(32))), 'webp',
				'webp', 1
			FROM media_attachments m JOIN accounts a ON a.id = m.account_id
			WHERE a.domain IS NOT NULL AND m.file_token IS NULL AND ${url} IS NOT NULL AND ${category} IS NOT NULL`,
    );
  }
}

async function measureShapes(fill: Fill): Promise<FillMeasure> {
  const { t, quoted, quote, boost } = await maximalStatuses(fill);
  await cachedEmojis(t, fill);
  await cachedMedia(t, fill);
  const shape = (m: Measure): Shape => ({
    sqlite: m.sqliteBytes,
    json: jsonBytes(m.answer),
    rows: m.rows,
    nodes: nodes(m.answer),
  });
  const one = await read(t, getStatus, quoted);
  const pair = await read(t, getStatus, boost);
  // Every part at its bound is shown, and every filter with its match.
  const shown = one.answer as Presented & { filtered: { keyword_matches: string[]; status_matches: string[] }[] };
  expect(shown.media_attachments).toHaveLength(MAX_STATUS_MEDIA);
  expect(shown.mentions).toHaveLength(MAX_STATUS_MENTION_ROWS);
  expect(shown.tags).toHaveLength(MAX_PRESENTED_TAGS);
  expect(shown.poll!.options).toHaveLength(MAX_REMOTE_OPTIONS);
  expect(shown.filtered).toHaveLength(MAX_FILTERS);
  expect(shown.filtered[0]!.keyword_matches).toHaveLength(1);
  expect(shown.filtered[0]!.status_matches).toEqual([quoted]);
  expect((pair.answer as { reblog: { quote: { quoted_status: unknown } } }).reblog.quote.quoted_status).not.toBeNull();
  // A conversation of alice's with more participants than presented, each at its bounds, whose last status is the
  // quote, read end to end.
  const participants: string[] = [];
  for (let i = 0; i < MAX_PRESENTED_PARTICIPANTS + 8; i++) {
    participants.push(await maximalAccount(t, false, fill));
  }
  await cachedEmojis(t, fill);
  await cachedMedia(t, fill);
  await sql(
    t.store,
    "INSERT INTO conversations (account_id, thread, participants, last_status_id) VALUES (?, 'th', ?, ?)",
    ALICE,
    JSON.stringify(participants.toSorted()),
    quote,
  );
  const listed = await measured(
    t,
    listConversations as never,
    {
      credential: await credential(t),
      page: { limit: 1 },
      present: { origin: ORIGIN },
    } as never,
  );
  const [talk] = (listed.answer as { items: { accounts: { id: string }[]; last_status: unknown }[] }).items;
  expect(talk!.accounts.map((a) => a.id)).toEqual(participants.toSorted().slice(0, MAX_PRESENTED_PARTICIPANTS));
  expect(talk!.last_status).not.toBeNull();
  // A favourite group of alice's with its 8 sample accounts at their bounds, its status the quote, read as a page of
  // one group.
  for (let i = 0; i < 8; i++) {
    await sql(
      t.store,
      `INSERT INTO notifications (account_id, type, from_account_id, status_id, created_at, group_key)
			VALUES (?, 'favourite', ?, ?, ?, 'favourite-maximal-1')`,
      ALICE,
      await maximalAccount(t, false, fill),
      quote,
      new Date(NOW).toISOString(),
    );
  }
  const grouped = await measured(
    t,
    listGroupedNotifications as never,
    {
      credential: await credential(t),
      page: { limit: 1 },
      types: [],
      excludeTypes: [],
      groupedTypes: null,
      includeFiltered: false,
      expandAccounts: "full",
      present: { origin: ORIGIN },
    } as never,
  );
  const { next: _next, prev: _prev, ...group } = grouped.answer as Record<string, unknown> & { accounts: unknown[] };
  expect(group.accounts).toHaveLength(8);
  // A report of the quoter naming the quote (its first status, past REPORT_STATUS_BYTES alone), by a remote reporter at
  // its bounds (an inbound Flag's, migration 0054_remote_reports) with the comment at its stored bound for the fill
  // (REPORT_COMMENTS), assigned to and resolved by alice (local accounts only), read by alice as the OAuth admin.
  await sql(t.store, "UPDATE local_accounts SET email = 'alice@kopje.test' WHERE account_id = ?", ALICE);
  await setSetting(t.store, "admin_email", "alice@kopje.test");
  const adminToken = "admin-token";
  await sql(
    t.store,
    "INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'test', ?, 'admin:read')",
    await sha256Hex(adminToken),
    ALICE,
  );
  const reporter = await maximalAccount(t, false, fill);
  const [report] = await sql<{ id: string }>(
    t.store,
    `INSERT INTO reports (account_id, target_account_id, status_ids, uri, comment, created_at, assigned_account_id,
			action_taken_by_account_id)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING CAST(id AS TEXT) AS id`,
    reporter,
    (await sql<{ account_id: string }>(t.store, "SELECT account_id FROM statuses WHERE id = ?", quote))[0]!.account_id,
    // status_ids at its stored bound: 100 ids (2,101 bytes), the rest naming no stored status.
    JSON.stringify([quote, quoted, ...Array.from({ length: 98 }, (_, i) => String(990000000000000000 + i))]),
    atLimit(`https://${HOST}/payloads/`, 4096),
    REPORT_COMMENTS[fill],
    new Date(NOW).toISOString(),
    ALICE,
    ALICE,
  );
  // Its admin.report, as the OAuth admin's list of notifications presents it (the report as its reporter's entity).
  await sql(
    t.store,
    `INSERT INTO notifications (account_id, type, from_account_id, report_id, created_at)
		VALUES (?, 'admin.report', ?, ?, ?)`,
    ALICE,
    reporter,
    report!.id,
    new Date(NOW).toISOString(),
  );
  const notified = await measured(
    t,
    listNotifications as never,
    {
      credential: await credential(t),
      page: { limit: 1 },
      types: ["admin.report"],
      excludeTypes: [],
      accountId: null,
      includeFiltered: false,
      fallbackTypes: [...FALLBACK_TYPES],
      present: { origin: ORIGIN },
    } as never,
  );
  const [adminReport] = (notified.answer as { items: { report: { comment: string } }[] }).items;
  expect(adminReport!.report.comment).toBe(REPORT_COMMENTS[fill]);
  const reported = await measured(
    t,
    getAdminReport as never,
    {
      credential: { tokenHash: await sha256Hex(adminToken), scope: "admin:read", now: NOW },
      id: report!.id,
      present: { origin: ORIGIN },
    } as never,
  );
  const shownReport = (reported.answer as { report: { statuses: { id: string }[] } }).report;
  expect(shownReport.statuses.map((status) => status.id)).toEqual([quote]);
  // A moderation_warning of a local account at its bounds (the fill's maximal account made local: without the moved-to
  // account, actor document and fetch a local row may not hold, with MAX_FIELDS local fields at their limits: names
  // in the fill's character, values in it in the raw fill and otherwise linked URLs of '&', which linkHtml escapes
  // twice (localLinkValue), each verified; verified_links padded to its stored bound), its text at its stored bound
  // for the fill (WARNING_TEXTS) and status_ids of 100 ids, read by the target in v1 and v2: the account twice, as the
  // sender and as the warning's target_account.
  const target = await maximalAccount(t, false, fill);
  await sql(
    t.store,
    "UPDATE accounts SET moved_to_account_id = NULL, domain = NULL, raw = NULL, fetched_at = NULL WHERE id = ?",
    target,
  );
  const fieldChar = fill === "raw" ? W : C;
  await sql(
    t.store,
    `INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey, fields, verified_links)
		VALUES (?, ?, X'00', X'00', 'k', ?, ?)`,
    target,
    `${target}@kopje.test`,
    JSON.stringify(
      Array.from({ length: MAX_FIELDS }, (_, i) => ({
        name: fieldChar.repeat(MAX_FIELD_NAME),
        value: fill === "raw" ? fieldChar.repeat(MAX_FIELD_VALUE) : localLinkValue(i),
      })),
    ),
    JSON.stringify(
      Array.from({ length: MAX_FIELDS }, (_, i) => [localLinkValue(i), new Date(NOW).toISOString()]),
    ).padEnd(VERIFIED_LINKS_BYTES, " "),
  );
  const targetToken = "warned-token";
  await sql(
    t.store,
    "INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'test', ?, 'read')",
    await sha256Hex(targetToken),
    target,
  );
  const warningIds = Array.from({ length: WARNING_STATUS_IDS }, (_, i) => String(980000000000000000 + i));
  const [warningRow] = await sql<{ id: number }>(
    t.store,
    `INSERT INTO account_warnings (target_account_id, action, text, status_ids, created_at)
		VALUES (?, 'none', CAST(? AS TEXT), ?, ?) RETURNING id`,
    target,
    WARNING_TEXTS[fill],
    JSON.stringify(warningIds),
    new Date(NOW).toISOString(),
  );
  await sql(
    t.store,
    `INSERT INTO notifications (account_id, type, from_account_id, account_warning_id, created_at)
		VALUES (?1, 'moderation_warning', ?1, ?2, ?3)`,
    target,
    warningRow!.id,
    new Date(NOW).toISOString(),
  );
  const targetCredential = { tokenHash: await sha256Hex(targetToken), scope: "read", now: NOW };
  const warned = await measured(
    t,
    listNotifications as never,
    {
      credential: targetCredential,
      page: { limit: 1 },
      types: ["moderation_warning"],
      excludeTypes: [],
      accountId: null,
      includeFiltered: false,
      fallbackTypes: [...FALLBACK_TYPES],
      present: { origin: ORIGIN },
    } as never,
  );
  const [warningNotification] = (
    warned.answer as { items: { account: unknown; moderation_warning: { text: string; status_ids: string[] } }[] }
  ).items;
  const { text: warningText, status_ids: warningStatusIds } = warningNotification!.moderation_warning;
  expect(jsonBytes(warningText)).toBe(fill === "raw" ? 3 * WARNING_TEXT_BYTES + 2 : 6 * WARNING_TEXT_BYTES + 2);
  expect(jsonBytes(warningStatusIds)).toBe(WARNING_STATUS_IDS_BYTES);
  expect(warningNotification!.moderation_warning).toMatchObject({ target_account: warningNotification!.account });
  const warnedGroup = await measured(
    t,
    listGroupedNotifications as never,
    {
      credential: targetCredential,
      page: { limit: 1 },
      types: ["moderation_warning"],
      excludeTypes: [],
      groupedTypes: null,
      includeFiltered: false,
      expandAccounts: "full",
      fallbackTypes: [...FALLBACK_TYPES],
      present: { origin: ORIGIN },
    } as never,
  );
  const { next: _warnedNext, prev: _warnedPrev, ...warningGroup } = warnedGroup.answer as Record<string, unknown>;
  // A favourite of the quote alice's policy filtered, by an account at its bounds, as include_filtered lists it: the
  // largest v1 notification of a status, and the only one presented with `filtered`.
  await sql(
    t.store,
    `INSERT INTO notifications (account_id, type, from_account_id, status_id, created_at, filtered)
		VALUES (?, 'favourite', ?, ?, ?, 1)`,
    ALICE,
    await maximalAccount(t, false, fill),
    quote,
    new Date(NOW).toISOString(),
  );
  const filteredList = await measured(
    t,
    listNotifications as never,
    {
      credential: await credential(t),
      page: { limit: 1 },
      types: ["favourite"],
      excludeTypes: [],
      accountId: null,
      includeFiltered: true,
      present: { origin: ORIGIN },
    } as never,
  );
  const [filteredNotification] = (filteredList.answer as { items: { filtered?: true; status: { id: string } }[] })
    .items;
  expect(filteredNotification).toMatchObject({ filtered: true, status: { id: quote } });
  const account = (one.answer as Presented).account;
  const two = await read(t, getStatus, quote);
  const answers: Record<string, unknown> = {
    account,
    status: one.answer,
    quote: two.answer,
    boostOfQuote: pair.answer,
    conversation: talk,
    group,
    report: shownReport,
    reportNotification: adminReport,
    warningNotification,
    warningGroup,
    filteredNotification,
  };
  // A notification row's `filtered` is read as one integer (NOTIFICATION_COLUMNS), 8 SQLite bytes for each row a
  // shape reads: the group's walk reads 10, the filtered favourite's list the 9 favourites of its window.
  const filteredReads = (m: Measure) =>
    [...m.heaps.values()].reduce((sum, heap) => sum + (heap.columns.get("filtered")?.total ?? 0) / VALUE_BYTES, 0);
  expect(
    [one, grouped, notified, warned, warnedGroup, filteredList].map((m) => filteredReads(m)),
    fill,
  ).toEqual([0, 10, 1, 1, 1, 9]);
  // The escaped fill's streamed witnesses of the turn's hard bound (stream-hub.ts): a conversation of alice's with the
  // table's participants whose last status is the quote (it shows no boost: conversationStream), and a favourite
  // notification of alice's whose status is the boost of the quote, each presented as a stream unit presents it
  // (unfiltered, as R33 reads it).
  let streamed: FillMeasure["streamed"];
  if (fill === "escaped") {
    const [conversation] = await sql<{ id: string }>(
      t.store,
      `INSERT INTO conversations (account_id, thread, participants, last_status_id) VALUES (?, 'th-streamed', ?, ?)
			RETURNING CAST(id AS TEXT) AS id`,
      ALICE,
      JSON.stringify(participants.toSorted()),
      quote,
    );
    const [notification] = await sql<{ id: string }>(
      t.store,
      `INSERT INTO notifications (account_id, type, from_account_id, status_id, created_at)
			VALUES (?, 'favourite', ?, ?, ?) RETURNING CAST(id AS TEXT) AS id`,
      ALICE,
      await maximalAccount(t, false, fill),
      boost,
      new Date(NOW).toISOString(),
    );
    const tokenHashes = [await sha256Hex(t.tokens.alice)];
    const unit = async (kind: string, subject: string) => {
      const made = await runInDurableObject(t.store, (_instance, state) =>
        streamUnit.run(state.storage.sql, { kind, subject, accountId: ALICE, tokenHashes, now: NOW }),
      );
      expect(made.payload, kind).not.toBeNull();
      return made.payload as Record<string, unknown>;
    };
    const talkOfQuote = await unit("conversation", conversation!.id);
    expect((talkOfQuote.last_status as { id: string }).id).toBe(quote);
    const notified = await unit("notification", notification!.id);
    expect((notified.status as { id: string }).id).toBe(boost);
    streamed = {
      conversation: jsonBytes(talkOfQuote),
      conversationPayload: utf8Length(JSON.stringify(JSON.stringify(talkOfQuote))),
      notification: jsonBytes(notified),
    };
  }
  const { fallback: _streamed, ...streamedWarning } = warningNotification as { fallback?: unknown };
  return {
    streamed,
    warningPayload: utf8Length(JSON.stringify(JSON.stringify(streamedWarning))),
    accountFields: jsonBytes((account as { fields: unknown }).fields),
    moved: Object.fromEntries(
      Object.entries(answers).map(([name, answer]) => {
        const nested = movedAccounts(answer);
        const deficit = nested.reduce((sum: number, value) => sum + MOVED_ACCOUNT_JSON_MAX - jsonBytes(value), 0);
        for (const value of nested) {
          expect(jsonBytes(value)).toBeLessThanOrEqual(MOVED_ACCOUNT_JSON_MAX);
        }
        return [name, { count: nested.length, deficit }];
      }),
    ),
    applications: Object.fromEntries(
      Object.entries(answers).map(([name, answer]) => {
        const shown = presentedStatuses(answer);
        const deficit = shown.reduce((sum: number, status) => sum + APPLICATION_JSON_MAX - applicationJson(status), 0);
        for (const status of shown) {
          expect(applicationJson(status)).toBeLessThanOrEqual(APPLICATION_JSON_MAX);
        }
        return [name, { count: shown.length, deficit }];
      }),
    ),
    cards: Object.fromEntries(
      Object.entries(answers).map(([name, answer]) => {
        // A boost and a quoted status show none.
        const all = presentedStatuses(answer);
        const quotedShown = new Set(
          all.flatMap((status) => (status.quote as { quoted_status?: unknown } | null)?.quoted_status ?? []),
        );
        const shown = all.filter((status) => status.reblog === null && !quotedShown.has(status));
        for (const status of all) {
          expect(jsonBytes(status.card)).toBeLessThanOrEqual(shown.includes(status) ? CARD_JSON_MAX : 4);
        }
        const deficit = shown.reduce((sum: number, status) => sum + CARD_JSON_MAX - jsonBytes(status.card), 0);
        return [name, { count: shown.length, deficit }];
      }),
    ),
    localFields: Object.fromEntries(
      Object.entries(answers).map(([name, answer]) => {
        const shown = verifiedFields(answer);
        for (const field of shown) {
          expect(jsonBytes(field.value)).toBeLessThanOrEqual(LOCAL_FIELD_VALUE_JSON_MAX);
          expect(jsonBytes(field.verified_at)).toBe(VERIFIED_AT_JSON_BYTES);
        }
        const deficit = shown.reduce((sum, field) => sum + LOCAL_FIELD_VALUE_JSON_MAX - jsonBytes(field.value), 0);
        return [name, { count: shown.length, deficit }];
      }),
    ),
    remoteFields: Object.fromEntries(
      Object.entries(answers).map(([name, answer]) => {
        const shown = remoteAccounts(answer);
        for (const account of shown) {
          expect(jsonBytes(account.fields)).toBeLessThanOrEqual(REMOTE_FIELDS_JSON_MAX);
        }
        const deficit = shown.reduce((sum, account) => sum + REMOTE_FIELDS_JSON_MAX - jsonBytes(account.fields), 0);
        return [name, { count: shown.length, deficit }];
      }),
    ),
    fallbacks: Object.fromEntries(
      Object.entries(answers).map(([name, answer]) => {
        const shown = presentedFallbacks(answer);
        for (const fallback of shown) {
          expect(jsonBytes(fallback)).toBeLessThanOrEqual(FALLBACK_JSON_MAX);
        }
        const deficit = shown.reduce((sum: number, fallback) => sum + FALLBACK_JSON_MAX - jsonBytes(fallback), 0);
        return [name, { count: shown.length, deficit }];
      }),
    ),
    media: Object.fromEntries(
      Object.entries(answers).map(([name, answer]) => {
        const shown = presentedMedia(answer);
        for (const media of shown) {
          for (const key of MEDIA_STRINGS) {
            expect(jsonBytes(media[key])).toBeLessThanOrEqual(
              key === "blurhash" ? BLURHASH_JSON_MAX : MEDIA_URL_JSON_BYTES,
            );
          }
        }
        return [name, { count: shown.length, deficit: shown.reduce((sum, media) => sum + mediaDeficit(media), 0) }];
      }),
    ),
    shapes: {
      account: { sqlite: one.profileBytes, json: jsonBytes(account), rows: 1, nodes: nodes(account) },
      status: shape(one),
      quote: shape(two),
      boostOfQuote: shape(pair),
      conversation: { ...shape({ ...listed, answer: talk }), sqlite: listed.sqliteBytes },
      group: shape({ ...grouped, answer: group }),
      report: shape({ ...reported, answer: shownReport }),
      reportNotification: shape({ ...notified, answer: adminReport }),
      warningNotification: shape({ ...warned, answer: warningNotification }),
      warningGroup: shape({ ...warnedGroup, answer: warningGroup }),
      filteredNotification: shape({ ...filteredList, answer: filteredNotification }),
    },
    heaps: {
      status: one.heaps,
      quote: two.heaps,
      boostOfQuote: pair.heaps,
      group: grouped.heaps,
      report: reported.heaps,
    },
  };
}

// An account's static images (migration 0061_account_static_images), each at its stored bound whatever the fills hold:
// the fills' accounts are remote, which hold none, and a local account's may hold both.
const STATIC_COLUMNS = new Set(["avatar_static_url", "header_static_url"]);
const STATIC_COLUMN_HEAP = VALUE_BYTES + 2 * STATIC_URL_LIMIT;

// A remote account's verification times (migration 0068_remote_field_verification, account-columns.ts
// REMOTE_VERIFIED_SQL): the writer's maximum of remote_field_links.links (REMOTE_VERIFIED_SHOWN entries [index, href,
// time, checked] at the largest index, an href of REMOTE_FIELD_LINK_BYTES no character of which JSON escapes, and a
// time), the projection's maximum ([index, time] of each), and the column's heap on every account row whatever the
// fills hold (theirs hold no row); and the most JSON a remote account's fields present: REMOTE_FIELDS_BYTES of names
// and values (counted as presented, a verified value's link included), each of MAX_REMOTE_FIELDS fields' keys,
// REMOTE_VERIFIED_SHOWN of them with a time and the rest null, and the array's separators.
const ISO_TIME = new Date(NOW).toISOString();
const REMOTE_LINKS_WRITER_MAX = jsonBytes(
  Array.from({ length: REMOTE_VERIFIED_SHOWN }, () => [
    REMOTE_FIELD_INDEXES - 1,
    "h".repeat(REMOTE_FIELD_LINK_BYTES),
    ISO_TIME,
    1,
  ]),
);
const REMOTE_VERIFIED_PROJECTION_MAX = jsonBytes(
  Array.from({ length: REMOTE_VERIFIED_SHOWN }, () => [REMOTE_FIELD_INDEXES - 1, ISO_TIME]),
);
const REMOTE_VERIFIED_COLUMN_HEAP = VALUE_BYTES + 2 * REMOTE_VERIFIED_JSON_BYTES;
const REMOTE_FIELDS_JSON_MAX =
  REMOTE_FIELDS_BYTES +
  MAX_REMOTE_FIELDS * (jsonBytes({ name: "", value: "", verified_at: null }) - 4 - 4) +
  REMOTE_VERIFIED_SHOWN * VERIFIED_AT_JSON_BYTES +
  (MAX_REMOTE_FIELDS - REMOTE_VERIFIED_SHOWN) * jsonBytes(null) +
  2 +
  (MAX_REMOTE_FIELDS - 1);

// The remote accounts a presented value shows (Account objects whose acct names a domain), not descending into a
// nested moved-to account (counted at MOVED_ACCOUNT_JSON_MAX).
function remoteAccounts(value: unknown): { fields: unknown }[] {
  if (Array.isArray(value)) {
    return value.flatMap(remoteAccounts);
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const record = value as Record<string, unknown>;
  const own =
    typeof record.acct === "string" && record.acct.includes("@") && Array.isArray(record.fields)
      ? [record as { fields: unknown }]
      : [];
  return [...own, ...Object.entries(record).flatMap(([key, child]) => (key === "moved" ? [] : remoteAccounts(child)))];
}

// A status's app (migration 0064_status_applications), each column at its raw projection bound (stored-bounds.ts
// appNameSql, appWebsiteSql) on every status row whatever the fills hold: their statuses are remote, which show none,
// and every local original may name one.
const APPLICATION_COLUMN_HEAP: Readonly<Record<string, number>> = {
  application_name: VALUE_BYTES + 2 * APP_NAME_BYTES,
  application_website: VALUE_BYTES + 2 * APP_WEBSITE_LIMIT,
};
const APPLICATION_ROW_HEAP = Object.values(APPLICATION_COLUMN_HEAP).reduce((sum, heap) => sum + heap, 0);

// The most JSON a status's `application` entry adds, its separator included: a name of APP_NAME_LIMIT code points
// each escaped to six bytes, and a website of APP_WEBSITE_LIMIT bytes, which JSON writes as they are (isAppWebsite
// admits no character JSON escapes, and only well-formed text).
const APPLICATION_JSON_MAX =
  jsonBytes({ application: { name: C.repeat(APP_NAME_LIMIT), website: "u".repeat(APP_WEBSITE_LIMIT) } }) - 1;

// What a presented status's `application` entry takes in its JSON, its separator included (0 when it has none).
function applicationJson(status: Record<string, unknown>): number {
  return "application" in status ? jsonBytes({ application: status.application }) - 1 : 0;
}

// The presented fields with a verification time: a local account's verified fields.
function verifiedFields(value: unknown): { value: string; verified_at: string }[] {
  if (Array.isArray(value)) {
    return value.flatMap(verifiedFields);
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const own =
    "verified_at" in value && typeof value.verified_at === "string"
      ? [value as { value: string; verified_at: string }]
      : [];
  return [...own, ...Object.values(value).flatMap(verifiedFields)];
}

// The fallbacks a shape presents (notification-fallback.ts).
function presentedFallbacks(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value.flatMap(presentedFallbacks);
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  return Object.entries(value).flatMap(([key, item]: [string, unknown]) =>
    key === "fallback" && typeof item === "object" && item !== null ? [item] : presentedFallbacks(item),
  );
}

function presentedStatuses(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.flatMap(presentedStatuses);
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const own = "quote_approval" in value ? [value as Record<string, unknown>] : [];
  return [...own, ...Object.values(value).flatMap(presentedStatuses)];
}

// An item's rows at their per-column maxima: for each query and column, the most any fill read (each fill puts a column
// at the bound in the unit that reads the most heap for it or the most JSON), summed, so a combination of columns no
// single fill holds is counted; a static image column at STATIC_COLUMN_HEAP and an app column at its
// APPLICATION_COLUMN_HEAP on every row. Returns their heap and the largest single row such a combination makes.
function perColumn(measures: readonly Heaps[]): { heap: number; largestRow: number } {
  const queries = new Map<string, { rows: number; columns: Map<string, ColumnHeap> }>();
  for (const heaps of measures) {
    for (const [query, { rows, columns }] of heaps) {
      const most = queries.get(query) ?? { rows: 0, columns: new Map<string, ColumnHeap>() };
      most.rows = Math.max(most.rows, rows);
      for (const [column, { total, largest }] of columns) {
        const was = most.columns.get(column) ?? { total: 0, largest: 0 };
        most.columns.set(column, { total: Math.max(was.total, total), largest: Math.max(was.largest, largest) });
      }
      queries.set(query, most);
    }
  }
  let heap = 0;
  let largestRow = 0;
  for (const [query, { rows, columns }] of queries) {
    // The moved-to accounts' rows at their caps, whatever the fills hold (MOVED_ROW_HEAP_MAX).
    if (query.includes(selectSql(MOVED_ACCOUNT_COLUMNS.columns))) {
      heap += rows * MOVED_ROW_HEAP_MAX;
      largestRow = Math.max(largestRow, MOVED_ROW_HEAP_MAX);
      continue;
    }
    const values = [...columns].map(([column, c]) => {
      const cap = STATIC_COLUMNS.has(column)
        ? STATIC_COLUMN_HEAP
        : column === "remote_verified"
          ? REMOTE_VERIFIED_COLUMN_HEAP
          : APPLICATION_COLUMN_HEAP[column];
      return cap === undefined ? c : { total: rows * cap, largest: cap };
    });
    heap += 64 * rows + values.reduce((sum, c) => sum + c.total, 0);
    largestRow = Math.max(largestRow, 64 + values.reduce((sum, c) => sum + c.largest, 0));
  }
  return { heap, largestRow };
}

// The polls each shape shows (a quote shows its quoted status's too), and the most a poll's emojis add to its JSON.
const POLLS_SHOWN: Record<string, number> = {
  account: 0,
  status: 1,
  quote: 2,
  boostOfQuote: 2,
  conversation: 2,
  group: 2,
  report: 2,
  filteredNotification: 2,
};
const POLL_EMOJIS_JSON = STATUS_EMOJIS_BYTES - 2;

// What a local account adds that the fills' remote account occurrence does not carry: noindex and roles with the
// Owner's badge (the largest role list a local account shows), each with its separator.
const LOCAL_ACCOUNT_KEYS_JSON =
  jsonBytes({ noindex: false, roles: [{ id: OWNER_ROLE.id, name: OWNER_ROLE.name, color: OWNER_ROLE.color }] }) - 1;

// The conservative JSON of each shape: the escaped fill's, whose status and account emoji arrays are at their bounds,
// plus a poll's emoji array at its bound for each poll shown. No one fill holds both: the references a poll's choices
// need displace escaped characters (the emoji-poll fill), so this bounds every combination from above. The account
// occurrence adds a local account's keys, and what a local account's fields at LOCAL_FIELDS_JSON_MAX present past the
// remote one's, so it bounds a local account as well as the remote one measured. Each
// nested moved-to account counts at MOVED_ACCOUNT_JSON_MAX, what its caps allow at once, each status shown with an
// `application` at APPLICATION_JSON_MAX, as a local one may show it, and with a card at CARD_JSON_MAX unless it is a
// boost or a quoted status, and each attachment's four URLs at
// MEDIA_URL_JSON_BYTES and its blurhash at BLURHASH_JSON_MAX, and each verified local field's value at
// LOCAL_FIELD_VALUE_JSON_MAX. Every remote account shown but the account occurrence counts its fields at
// REMOTE_FIELDS_JSON_MAX (verified remote fields); the account occurrence keeps the larger of the local and remote
// fields' maxima. Each notification's or group's fallback counts at FALLBACK_JSON_MAX.
async function conservativeJson(): Promise<Record<string, number>> {
  const { shapes, moved, applications, cards, media, localFields, remoteFields, fallbacks, accountFields } =
    await measureFill("escaped");
  return Object.fromEntries(
    Object.entries(shapes).map(([name, shape]) => [
      name,
      shape.json +
        (POLLS_SHOWN[name] ?? 0) * POLL_EMOJIS_JSON +
        (name === "account"
          ? LOCAL_ACCOUNT_KEYS_JSON +
            Math.max(0, LOCAL_FIELDS_JSON_MAX - accountFields, REMOTE_FIELDS_JSON_MAX - accountFields)
          : remoteFields[name]!.deficit) +
        moved[name]!.deficit +
        applications[name]!.deficit +
        cards[name]!.deficit +
        media[name]!.deficit +
        localFields[name]!.deficit +
        fallbacks[name]!.deficit,
    ]),
  );
}

// The peaks of "Heap at 8 MiB per answer" (docs/threat-model.md, its model and terms) for answers whose largest item
// is one of `items`, with that item's rows and largest row at their per-column maxima, and its rejected item's JSON at
// its conservative bound. A single item is read alone, in no chunk.
async function peaks(items: readonly string[], chunks: ChunkPlan, state: number): Promise<Peaks> {
  const measures = await Promise.all(FILLS.map(measureFill));
  const each = items.map((item) => perColumn(measures.map((m) => m.heaps[item]!)));
  const rows = 1.25 * Math.max(...each.map((e) => e.heap));
  const largestRow = Math.max(...each.map((e) => e.largestRow));
  const conservative = await conservativeJson();
  const json = Math.max(...items.map((item) => conservative[item]!));
  const rest = 3 * ANSWER_BYTES + 3 * json + MOVED_EMOJI_SCRATCH + state;
  return {
    rows,
    largestRow,
    rejected: 3 * json,
    normal: Math.max(1.25 * chunks.cap, rows) + rest,
    backstop: 1.25 * (chunks.cap + largestRow) + rows + rest,
    single: rows + rest,
  };
}

// The nested moved-to account (Account#moved): its row and JSON maxima follow from its caps (MOVED_ACCOUNT_COLUMNS), so
// any target reads and presents within them: one at the caps (movedTarget), a full account at every profile bound, or
// an unavailable one.
describe("the moved-to account (RES-3)", () => {
  it("derives its maxima from its caps", () => {
    expect(MOVED_EMOJI_SCRATCH).toBe(18_060);
    expect({ json: MOVED_ACCOUNT_JSON_MAX, sqlite: MOVED_ROW_SQLITE_MAX, heap: MOVED_ROW_HEAP_MAX }).toEqual({
      json: MOVED_ACCOUNT_MAXIMA.json,
      sqlite: MOVED_ACCOUNT_MAXIMA.sqlite,
      heap: MOVED_ACCOUNT_MAXIMA.heap,
    });
  });

  it.each<[string, Fill]>([
    ["escaped", "escaped"],
    ["raw", "raw"],
  ])(
    "reads a full account at its bounds, available or not, as a target within them, %s",
    async (_name, fill) => {
      const t = await setup();
      const target = await maximalAccount(t, false, fill);
      // A domain a target is read with (DOMAIN_BYTES), the rest at every profile bound.
      await sql(t.store, "UPDATE accounts SET domain = ? WHERE id = ?", `${"d".repeat(DOMAIN_BYTES - 4)}.com`, target);
      const source = await maximalAccount(t, true, fill);
      await sql(t.store, "UPDATE accounts SET moved_to_account_id = ? WHERE id = ?", target, source);
      for (const unavailable of [false, true]) {
        if (unavailable) {
          await sql(
            t.store,
            "UPDATE accounts SET suspended_at = '2026-01-01', suspension_source = 'account' WHERE id = ?",
            target,
          );
        }
        const m = await measured(
          t,
          getAccount as never,
          { id: source, present: { origin: ORIGIN }, credential: null } as never,
        );
        const [rows] = [...m.heaps].filter(([query]) => query.includes(selectSql(MOVED_ACCOUNT_COLUMNS.columns)));
        expect(rows![1].rows).toBe(MOVED_ACCOUNT_MAXIMA.rows);
        const heap = 64 + [...rows![1].columns.values()].reduce((sum, column) => sum + column.total, 0);
        expect(heap).toBeLessThanOrEqual(MOVED_ROW_HEAP_MAX);
        const moved = (m.answer as { moved: Record<string, unknown> }).moved;
        expect(moved).toMatchObject({ id: target, ...(unavailable ? { suspended: true } : {}) });
        expect(jsonBytes(moved)).toBeLessThanOrEqual(MOVED_ACCOUNT_JSON_MAX);
      }
    },
    120_000,
  );
});

// A local target's static images at their stored bound (migration 0061_account_static_images, STATIC_URL_LIMIT): a
// plain one, and one that serializes within PROFILE_URL_LIMIT but whose JSON passes it (192 malformed bytes, each
// %EF%BF%BD, and 309 backslashes, which JSON doubles). Each reads and presents within the nested account's caps, and
// the full account shows each within PROFILE_URL_LIMIT as JSON.
describe("static images (RES-2, RES-3)", () => {
  const PLAIN = `https://kopje.test/media/${"s".repeat(STATIC_URL_LIMIT - "https://kopje.test/media/".length)}`;
  const WITNESS = ESCAPED_STATIC_WITNESS;

  it.each<[string, string | ArrayBuffer]>([
    ["plain", PLAIN],
    ["escaping", WITNESS],
  ])(
    "of a local target at their bound stay within the nested caps and the full bounds, %s",
    async (_name, still) => {
      const t = await setup();
      const image = `https://kopje.test/media/${"i".repeat(MOVED_URL_LIMIT - "https://kopje.test/media/".length)}`;
      await sql(
        t.store,
        `UPDATE accounts SET avatar_url = ?1, header_url = ?1, avatar_static_url = CAST(?2 AS TEXT),
					header_static_url = CAST(?2 AS TEXT) WHERE id = ?3`,
        image,
        still,
        ALICE,
      );
      expect(
        await sql(t.store, "SELECT length(CAST(avatar_static_url AS BLOB)) AS n FROM accounts WHERE id = ?", ALICE),
      ).toEqual([{ n: STATIC_URL_LIMIT }]);
      const source = await maximalAccount(t, true);
      await sql(t.store, "UPDATE accounts SET moved_to_account_id = ? WHERE id = ?", ALICE, source);
      const m = await measured(
        t,
        getAccount as never,
        { id: source, present: { origin: ORIGIN }, credential: null } as never,
      );
      const [rows] = [...m.heaps].filter(([query]) => query.includes(selectSql(MOVED_ACCOUNT_COLUMNS.columns)));
      expect(64 + [...rows![1].columns.values()].reduce((sum, column) => sum + column.total, 0)).toBeLessThanOrEqual(
        MOVED_ROW_HEAP_MAX,
      );
      const moved = (m.answer as { moved: Record<string, string> }).moved;
      expect(jsonBytes(moved)).toBeLessThanOrEqual(MOVED_ACCOUNT_JSON_MAX);
      expect(moved.avatar_static).toBe(typeof still === "string" ? still : image);
      const full = (
        await measured(t, getAccount as never, { id: ALICE, present: { origin: ORIGIN }, credential: null } as never)
      ).answer as Record<string, string>;
      for (const key of ["avatar", "avatar_static", "header", "header_static"]) {
        expect(utf8Length(JSON.stringify(full[key])), key).toBeLessThanOrEqual(PROFILE_URL_LIMIT + 2);
      }
      expect(full.avatar_static).toBe(typeof still === "string" ? still : image);
    },
    120_000,
  );
});

// A local original and a local quote of it, each posted through an app at the bounds a status reads and presents it
// within (migration 0064_status_applications): escaped, names of APP_NAME_LIMIT characters JSON escapes to six bytes;
// raw, the most bytes read (APP_NAME_LIMIT four-byte characters, and APP_NAME_BYTES of ASCII, read whole and shown as
// null); malformed, imported bytes (0xFF, no UTF-8 lead byte) that decode to U+FFFD, three bytes each. The fills'
// statuses are remote, which name none, so these are the witnesses of the app columns' caps (APPLICATION_COLUMN_HEAP,
// in RowMeter's unit: a malformed byte decodes to one code unit) and of APPLICATION_JSON_MAX.
describe("status applications (RES-2, RES-3)", () => {
  it("derives their maxima from the caps", () => {
    expect({ row: APPLICATION_ROW_HEAP, json: APPLICATION_JSON_MAX }).toEqual({ row: 4_544, json: 2_399 });
  });

  const bytes = (prefix: string, byte: number, length: number) =>
    new Uint8Array([...new TextEncoder().encode(prefix), ...Array.from({ length: length - prefix.length }, () => byte)])
      .buffer;
  const utf8Bytes = (value: string | ArrayBuffer) => (typeof value === "string" ? utf8Length(value) : value.byteLength);
  const SITE = "https://kopje.test/";
  const ASCII_SITE = SITE.padEnd(APP_WEBSITE_LIMIT, "u");
  type App = { name: string | ArrayBuffer; website: string | ArrayBuffer; shown: unknown };
  const FIXTURES: Record<string, [App, App]> = {
    escaped: [
      {
        name: C.repeat(APP_NAME_LIMIT),
        website: ASCII_SITE,
        shown: { name: C.repeat(APP_NAME_LIMIT), website: ASCII_SITE },
      },
      {
        name: `${C.repeat(APP_NAME_LIMIT - 1)}a`,
        website: ASCII_SITE,
        shown: { name: `${C.repeat(APP_NAME_LIMIT - 1)}a`, website: ASCII_SITE },
      },
    ],
    raw: [
      {
        name: W.repeat(APP_NAME_LIMIT),
        website: ASCII_SITE,
        shown: { name: W.repeat(APP_NAME_LIMIT), website: ASCII_SITE },
      },
      { name: "n".repeat(APP_NAME_BYTES), website: ASCII_SITE, shown: null },
    ],
    malformed: [
      {
        name: bytes("", 0xff, APP_NAME_LIMIT),
        website: bytes(SITE, 0xff, APP_WEBSITE_LIMIT),
        shown: { name: "\ufffd".repeat(APP_NAME_LIMIT), website: null },
      },
      { name: bytes("", 0xff, APP_NAME_BYTES), website: bytes(SITE, 0xff, APP_WEBSITE_LIMIT), shown: null },
    ],
  };

  it.each(Object.keys(FIXTURES))(
    "reads and presents them within their caps, %s",
    async (fill) => {
      const t = await setup();
      const [original, quoting] = FIXTURES[fill]!;
      const ids: string[] = [];
      for (const [i, app] of [original, quoting].entries()) {
        await sql(
          t.store,
          `INSERT INTO oauth_clients (id, secret, name, redirect_uris, website)
					VALUES (?, 's', CAST(? AS TEXT), 'urn:x', CAST(? AS TEXT))`,
          `app-${i}`,
          app.name,
          app.website,
        );
        const id = nextId();
        await sql(
          t.store,
          `INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, application_id)
					VALUES (?1, 'https://kopje.test/ap/o/' || ?1, ?2, 'public', '<p>x</p>', ?3, ?4)`,
          id,
          ALICE,
          new Date(NOW - 60_000).toISOString(),
          `app-${i}`,
        );
        ids.push(id);
      }
      await acceptQuote(t, ids[1]!, ids[0]!);
      expect(
        await sql(t.store, "SELECT max(length(CAST(name AS BLOB))) AS n FROM oauth_clients WHERE id LIKE ?", "app-%"),
      ).toEqual([{ n: Math.max(...[original, quoting].map((app) => utf8Bytes(app.name))) }]);
      // The rows of the statuses query, each app column in RowMeter's unit.
      const { answer, largest } = await runInDurableObject(t.store, async (_instance, state) => {
        const most: Record<string, number> = {};
        const counting = observedSql(state.storage.sql, (rows) => {
          for (const row of rows) {
            for (const column of Object.keys(APPLICATION_COLUMN_HEAP)) {
              if (column in row) {
                const value = row[column];
                const heap = VALUE_BYTES + (typeof value === "string" ? 2 * value.length : 0);
                most[column] = Math.max(most[column] ?? 0, heap);
              }
            }
          }
        });
        const input = { credential: await credential(t), now: NOW, id: ids[1], present: { origin: ORIGIN } };
        let result = getStatus.run(counting, input as never) as Record<string, unknown>;
        while (result.status === "ok" && "value" in result) {
          result = result.value as Record<string, unknown>;
        }
        return { answer: result, largest: most };
      });
      for (const [column, heap] of Object.entries(largest)) {
        expect(heap, column).toBeLessThanOrEqual(APPLICATION_COLUMN_HEAP[column]!);
      }
      expect(Object.keys(largest).toSorted()).toEqual(Object.keys(APPLICATION_COLUMN_HEAP).toSorted());
      const quoted = (answer.quote as { quoted_status: Record<string, unknown> }).quoted_status;
      expect(answer).toHaveProperty("application", quoting.shown);
      expect(quoted).toHaveProperty("application", original.shown);
      for (const status of [answer, quoted]) {
        expect(applicationJson(status)).toBeLessThanOrEqual(APPLICATION_JSON_MAX);
      }
      if (fill === "escaped") {
        expect(applicationJson(quoted)).toBe(APPLICATION_JSON_MAX);
      }
    },
    60_000,
  );
});

// Remote fields' verification (migration 0068_remote_field_verification): the column's and the fields' maxima follow
// from the constants; an account at the bounds with an imported row of four verified links presents within them.
describe("remote field verification (RES-3)", () => {
  it("derives its maxima from the constants", async () => {
    const { accountFields } = await measureFill("escaped");
    expect({
      writer: REMOTE_LINKS_WRITER_MAX,
      projection: REMOTE_VERIFIED_PROJECTION_MAX,
      heap: REMOTE_VERIFIED_COLUMN_HEAP,
      growth: REMOTE_VERIFIED_SHOWN * (VERIFIED_AT_JSON_BYTES - jsonBytes(null)),
      fields: REMOTE_FIELDS_JSON_MAX,
      deficit: REMOTE_FIELDS_JSON_MAX - accountFields,
    }).toEqual({ writer: 4_213, projection: 129, heap: 290, growth: 108, fields: 33_485, deficit: 565 });
    expect(REMOTE_LINKS_WRITER_MAX).toBe(REMOTE_FIELD_LINKS_BYTES);
    expect(REMOTE_VERIFIED_PROJECTION_MAX).toBe(REMOTE_VERIFIED_JSON_BYTES);
  }, 300_000);

  it("presents an account at its bounds with four verified links within the maxima", async () => {
    const t = await setup();
    const id = nextId();
    // Four links of REMOTE_FIELD_LINK_BYTES (their shortest anchors at MAX_CHARACTERS_COMPAT), then fields of names and
    // values at their cuts, each character escaping to six bytes.
    const href = (i: number) => {
      const prefix = `https://x${i}.test/`;
      return prefix + "a".repeat(REMOTE_FIELD_LINK_BYTES - prefix.length);
    };
    const anchor = (i: number) => `<a href="${href(i)}">${href(i)}</a>`;
    const attachment = [
      ...Array.from({ length: REMOTE_VERIFIED_SHOWN }, (_, i) => ({
        type: "PropertyValue",
        name: C.repeat(255),
        value: anchor(i),
      })),
      ...Array.from({ length: MAX_REMOTE_FIELDS - REMOTE_VERIFIED_SHOWN }, () => ({
        type: "PropertyValue",
        name: C.repeat(255),
        value: C.repeat(4096),
      })),
    ];
    await sql(
      t.store,
      `INSERT INTO accounts (id, uri, username, domain, raw) VALUES (?, ?, 'v', ?, ?)`,
      id,
      `https://${HOST}/users/${id}`,
      HOST,
      JSON.stringify({ type: "Person", attachment }),
    );
    // An imported row (as a cutover or a dump carries it) at the writer's maximum.
    const links = JSON.stringify(Array.from({ length: REMOTE_VERIFIED_SHOWN }, (_, i) => [i, href(i), ISO_TIME, 1]));
    await sql(
      t.store,
      "INSERT INTO remote_field_links (account_id, link_back, links, generation) VALUES (?, ?, ?, 1)",
      id,
      `https://${HOST}/users/${id}`,
      links,
    );
    const m = await measured(t, getAccount as never, { id, present: { origin: ORIGIN }, credential: null } as never);
    const fields = (m.answer as { fields: { value: string; verified_at: string | null }[] }).fields;
    expect(fields.filter((field) => field.verified_at !== null).length).toBe(REMOTE_VERIFIED_SHOWN);
    expect(jsonBytes(fields)).toBeLessThanOrEqual(REMOTE_FIELDS_JSON_MAX);
    const column = [...m.heaps.values()].flatMap((heap) => heap.columns.get("remote_verified") ?? []);
    expect(column.length).toBeGreaterThan(0);
    for (const c of column) {
      expect(c.largest).toBeLessThanOrEqual(REMOTE_VERIFIED_COLUMN_HEAP);
    }
    // Single-digit indexes: one byte less an entry than the projection's maximum.
    expect(Math.max(...column.map((c) => c.largest))).toBe(
      VALUE_BYTES + 2 * (REMOTE_VERIFIED_JSON_BYTES - REMOTE_VERIFIED_SHOWN),
    );
  }, 120_000);
});

// An Account whose imported display name and note hold malformed UTF-8 that passes 0048's triggers (D14 of RES-3).
// measured counts the UTF-8 of decoded values, which triples such a byte (the projected name re-encodes to 24,576
// bytes, the note to 196,602), so this is a check of its own, not a fill, in the three units the bounds are in: the
// stored bytes read (SQL octet_length of each projected value), the heap (rowHeapBytes of the decoded row against
// rowHeapSql of the same row) and the presented JSON (UTF-8 of the answer).
describe("an account of malformed imported text (RES-3)", () => {
  it("reads and presents within the fills' maxima", async () => {
    const t = await setup();
    // A conversation of MAX_PRESENTED_PARTICIPANTS accounts of the raw fill, each display name 0xFF and 1,048,575
    // continuation bytes (one character to 0048's cut), each note 65,534 continuation bytes (within noteSql's bound,
    // as json_quote copies them) and each image description 0xFF and 599 continuation bytes (one character to 0097's
    // trigger); its last status is by an account of the raw fill as it is, the reference.
    const participants: string[] = [];
    for (let i = 0; i < MAX_PRESENTED_PARTICIPANTS; i++) {
      participants.push(await maximalAccount(t, false, "raw"));
    }
    const reference = await maximalAccount(t, false, "raw");
    const name = new Uint8Array(1_048_576).fill(0x80);
    name[0] = 0xff;
    const description = new Uint8Array(PROFILE_DESCRIPTION_BYTES).fill(0x80);
    description[0] = 0xff;
    await sql(
      t.store,
      `UPDATE accounts SET display_name = CAST(?1 AS TEXT), note = CAST(?2 AS TEXT),
				avatar_description = CAST(?4 AS TEXT), header_description = CAST(?4 AS TEXT)
			WHERE id IN (SELECT value FROM json_each(?3))`,
      name.buffer,
      new Uint8Array(65_534).fill(0x80).buffer,
      JSON.stringify(participants),
      description.buffer,
    );
    const last = await storedStatus(t, reference, {
      content: "",
      spoiler: "",
      media: [],
      mentions: [],
      tags: [],
      poll: null,
    });
    await sql(
      t.store,
      "INSERT INTO conversations (account_id, thread, participants, last_status_id) VALUES (?, 'th', ?, ?)",
      ALICE,
      JSON.stringify(participants.toSorted()),
      last,
    );
    const rows = await runInDurableObject(t.store, (_instance, state) =>
      [...participants, reference].map((id) => {
        const bounds = state.storage.sql
          .exec<{ stored: number; name: number; note: number; avatar: number; header: number; heap: number }>(
            `SELECT octet_length(a.display_name) AS stored, octet_length(${ACCOUNT_COLUMN_MAP.display_name}) AS name,
							octet_length(${ACCOUNT_COLUMN_MAP.note}) AS note,
							octet_length(${ACCOUNT_COLUMN_MAP.avatar_description}) AS avatar,
							octet_length(${ACCOUNT_COLUMN_MAP.header_description}) AS header,
							${rowHeapSql(ACCOUNT_COLUMN_MAP)} AS heap
						FROM ${ACCOUNT_FROM} WHERE a.id = ?`,
            id,
          )
          .one();
        const row = state.storage.sql
          .exec<{ display_name: string; note: string; avatar_description: string; header_description: string }>(
            `SELECT ${selectSql(ACCOUNT_COLUMN_MAP)} FROM ${ACCOUNT_FROM} WHERE a.id = ?`,
            id,
          )
          .one();
        return {
          ...bounds,
          decoded: rowHeapBytes(row),
          names: row.display_name.length,
          notes: row.note.length,
          avatars: row.avatar_description.length,
          headers: row.header_description.length,
        };
      }),
    );
    const own = rows.pop()!;
    expect(own).toMatchObject({
      stored: 4 * 2048,
      name: 4 * 2048,
      note: utf8Length(RAW_BIO),
      avatar: PROFILE_DESCRIPTION_BYTES,
      header: PROFILE_DESCRIPTION_BYTES,
    });
    for (const row of rows) {
      // Read: the raw fill's bytes, of the 1,048,576 stored; the descriptions as stored, the raw fill's 600 bytes.
      expect(row).toMatchObject({
        stored: 1_048_576,
        name: own.name,
        note: own.note,
        avatar: own.avatar,
        header: own.header,
      });
      // Heap: a malformed byte decodes to one code unit, so each text equals its SQL bound and the row is within it;
      // that bound is the reference's.
      expect({ names: row.names, notes: row.notes, avatars: row.avatars, headers: row.headers }).toEqual({
        names: row.name,
        notes: row.note,
        avatars: row.avatar,
        headers: row.header,
      });
      expect(row.decoded).toBeLessThanOrEqual(row.heap);
      expect(row.heap).toBeLessThanOrEqual(own.heap);
    }
    // Presented: each account within the escaped fill's account occurrence, its display name within the escaped
    // fill's (2,048 code points of six JSON bytes), its note within BIO_JSON_BYTES, and each description within the
    // escaped fill's (PROFILE_DESCRIPTION_LIMIT code points of six JSON bytes).
    const listed = await measured(
      t,
      listConversations as never,
      { credential: await credential(t), page: { limit: 1 }, present: { origin: ORIGIN } } as never,
    );
    const [talk] = (listed.answer as { items: { accounts: Record<string, unknown>[] }[] }).items;
    expect(talk!.accounts.map((a) => a.id)).toEqual(participants.toSorted());
    for (const account of talk!.accounts) {
      expect(jsonBytes(account.display_name)).toBeLessThanOrEqual(jsonBytes(C.repeat(2048)));
      expect(jsonBytes(account.note)).toBeLessThanOrEqual(REMOTE_BIO_BYTES);
      expect(jsonBytes(account)).toBeLessThanOrEqual(FILL_SHAPES.escaped.account.json);
      for (const key of ["avatar_description", "header_description"]) {
        expect(jsonBytes(account[key])).toBeLessThanOrEqual(jsonBytes(profileDescription("escaped")));
      }
      expect({
        name: account.display_name,
        note: account.note,
        avatar: account.avatar_description,
        header: account.header_description,
      }).toEqual({
        name: "\uFFFD".repeat(2048),
        note: "",
        avatar: "\uFFFD".repeat(PROFILE_DESCRIPTION_LIMIT),
        header: "\uFFFD".repeat(PROFILE_DESCRIPTION_LIMIT),
      });
    }
  }, 300_000);
});

describe("a status of malformed imported text (RES-3)", () => {
  it("reads and presents within the fills' maxima", async () => {
    // The raw fill's statuses. The quoted one takes content and source text of 0xFF and 131,069 continuation bytes
    // (the raw fill's 131,070 bytes; json_quote's 131,072, within contentSql's bound) and a warning of 0xFF and
    // 1,048,575 continuation bytes (one character to spoilerSql's cut), and two versions of the same; the quote, of the
    // raw fill as it is, with a version of its own text, is the reference.
    const { t, quoted, quote, boost } = await maximalStatuses("raw");
    const text = new Uint8Array(STATUS_CONTENT_BYTES - 2).fill(0x80);
    text[0] = 0xff;
    const warning = new Uint8Array(1_048_576).fill(0x80);
    warning[0] = 0xff;
    await sql(
      t.store,
      `UPDATE statuses SET content = CAST(?1 AS TEXT), source_text = CAST(?1 AS TEXT), spoiler_text = CAST(?2 AS TEXT)
			WHERE id = ?3`,
      text.buffer,
      warning.buffer,
      quoted,
    );
    for (const id of [quoted, quoted, quote]) {
      await sql(
        t.store,
        `INSERT INTO status_edits (status_id, content, spoiler_text, media_json, created_at)
				SELECT id, content, spoiler_text, '[]', ?2 FROM statuses WHERE id = ?1`,
        id,
        new Date(NOW).toISOString(),
      );
    }
    const [own, reference] = await runInDurableObject(t.store, (_instance, state) =>
      [quoted, quote].map((id) => {
        const bounds = state.storage.sql
          .exec<{ stored: number; spoiler: number; content: number; source: number; heap: number }>(
            `SELECT octet_length(s.spoiler_text) AS stored, octet_length(${STATUS_COLUMN_MAP.spoiler_text}) AS spoiler,
							octet_length(${STATUS_COLUMN_MAP.content}) AS content,
							octet_length(${STATUS_COLUMN_MAP.source_text}) AS source, ${rowHeapSql(STATUS_COLUMN_MAP)} AS heap
						FROM ${STATUS_FROM} WHERE s.id = ?`,
            id,
          )
          .one();
        const row = state.storage.sql
          .exec<{ spoiler_text: string; content: string; source_text: string }>(
            `SELECT ${selectSql(STATUS_COLUMN_MAP)} FROM ${STATUS_FROM} WHERE s.id = ?`,
            id,
          )
          .one();
        return {
          ...bounds,
          decoded: rowHeapBytes(row),
          spoilers: row.spoiler_text.length,
          contents: row.content.length,
          sources: row.source_text.length,
        };
      }),
    );
    expect(reference).toMatchObject({
      stored: SPOILER_BYTES - 2,
      spoiler: SPOILER_BYTES - 2,
      content: STATUS_CONTENT_BYTES - 2,
      source: STATUS_CONTENT_BYTES - 2,
    });
    // Read: the raw fill's bytes, the warning's SPOILER_READ_BYTES of the 1,048,576 stored.
    expect(own).toMatchObject({
      stored: 1_048_576,
      spoiler: reference!.spoiler,
      content: reference!.content,
      source: reference!.source,
    });
    // Heap: a malformed byte decodes to one code unit, so each text equals its SQL bound and the row is within it;
    // that bound is the reference's.
    expect({ spoilers: own!.spoilers, contents: own!.contents, sources: own!.sources }).toEqual({
      spoilers: own!.spoiler,
      contents: own!.content,
      sources: own!.source,
    });
    expect(own!.decoded).toBeLessThanOrEqual(own!.heap);
    expect(own!.heap).toBeLessThanOrEqual(reference!.heap);
    // What the three statuses and the quoted one's history read of each text column (decoded, in code units): within
    // the raw fill's bytes, the versions' warnings too.
    const viewer = { ...(await credential(t)), scope: "read" as const };
    const longest = new Map<string, number>();
    const [items, history] = await runInDurableObject(t.store, (_instance, state) => {
      const counting = observedSql(state.storage.sql, (rows) => {
        for (const row of rows) {
          for (const column of ["spoiler_text", "content", "source_text"]) {
            const value = row[column];
            if (typeof value === "string") {
              longest.set(column, Math.max(longest.get(column) ?? 0, value.length));
            }
          }
        }
      });
      const unwrap = (answer: unknown): unknown => {
        let value = answer as Record<string, unknown>;
        while (value.status === "ok" && "value" in value) {
          value = value.value as Record<string, unknown>;
        }
        return value;
      };
      const present = { origin: ORIGIN };
      return [
        [quoted, quote, boost].map((id) =>
          unwrap(getStatus.run(counting, { credential: viewer, now: NOW, id, present })),
        ) as Presented[],
        unwrap(statusHistory.run(counting, { credential: viewer, now: NOW, id: quoted, present })) as Presented[],
      ] as const;
    });
    expect(Object.fromEntries(longest)).toEqual({
      spoiler_text: SPOILER_READ_BYTES,
      content: STATUS_CONTENT_BYTES - 2,
      source_text: STATUS_CONTENT_BYTES - 2,
    });
    // Presented: each status within the escaped fill's occurrence of its shape, and the quoted one's text, as a status,
    // as the quote's and the boost's, and in both versions of its history, within its bounds: content '' and the
    // warning 2,730 U+FFFD (8,192 JSON bytes).
    expect(items.map((item) => item.id)).toEqual([quoted, quote, boost]);
    const shapes = [FILL_SHAPES.escaped.status, FILL_SHAPES.escaped.quote, FILL_SHAPES.escaped.boostOfQuote];
    for (const [i, item] of items.entries()) {
      expect(jsonBytes(item)).toBeLessThanOrEqual(shapes[i]!.json);
    }
    const shown = [...presentedStatuses(items).filter((status) => status.id === quoted), ...history];
    expect(shown).toHaveLength(5);
    for (const status of shown) {
      expect({ content: status.content, spoiler: status.spoiler_text }).toEqual({
        content: "",
        spoiler: "�".repeat(SPOILER_CUT_LIMIT),
      });
      expect(jsonBytes(status.content)).toBeLessThanOrEqual(STATUS_CONTENT_BYTES);
      expect(jsonBytes(status.spoiler_text)).toBeLessThanOrEqual(SPOILER_BYTES);
    }
  }, 300_000);
});

// A status of alice's whose four attachments hold imported descriptions of malformed UTF-8 at 0105's stored bound:
// 0xFF and continuation bytes to MEDIA_DESCRIPTION_BYTES, one character to SQLite, which decode to 40,000 U+FFFD.
// Every presenter shows MAX_MEDIA_DESCRIPTION_LENGTH of them (presentedMediaDescription), within the escaped fill's
// description (that many code points of six JSON bytes): REST, the stream unit of its edit, the edit history (a
// snapshot an edit recorded, and an imported one past the byte bound), the Note's attachment names, the legacy
// Image's name and the filter text; and the rows its read takes stay within R.
describe("an attachment of malformed imported text (RES-3)", () => {
  const malformed = (bytes: number, tail = "") => {
    const run = new Uint8Array(bytes).fill(0x80);
    run[0] = 0xff;
    return new Uint8Array([...run, ...new TextEncoder().encode(tail)]).buffer;
  };
  const SHOWN = "�".repeat(MAX_MEDIA_DESCRIPTION_LENGTH);
  const DESCRIPTION_JSON_MAX = jsonBytes(C.repeat(MAX_MEDIA_DESCRIPTION_LENGTH));

  it("presents each description within MAX_MEDIA_DESCRIPTION_LENGTH code points everywhere", async () => {
    const t = await setup();
    const id = await storedStatus(t, ALICE, {
      content: "<p>described</p>",
      spoiler: "",
      media: Array.from({ length: MAX_STATUS_MEDIA }, (_, i) => ({
        url: `https://m.example/${i}.png`,
        preview: null,
        description: "",
        meta: null,
      })),
      mentions: [],
      tags: [],
      poll: null,
    });
    const at = new Date(NOW).toISOString();
    await runInDurableObject(t.store, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(
        "UPDATE media_attachments SET description = CAST(? AS TEXT) WHERE status_id = ?",
        malformed(MEDIA_DESCRIPTION_BYTES),
        id,
      );
      sql.exec(
        `UPDATE media_attachments SET legacy_ap_o = 'legacy-image'
				WHERE id = (SELECT min(id) FROM media_attachments WHERE status_id = ?)`,
        id,
      );
      // An edit records the status as it is now (statuses.ts recordEdit), and an imported snapshot holds one past the
      // byte bound, within EDIT_MEDIA_BYTES.
      recordEdit(new Db(sql), id, at);
      sql.exec(
        `INSERT INTO status_edits (status_id, content, spoiler_text, media_json, created_at)
				VALUES (?1, '<p>imported</p>', '', CAST(?2 AS TEXT), ?3)`,
        id,
        new Uint8Array([
          ...new TextEncoder().encode('[{"id":"m","type":"image","description":"'),
          ...new Uint8Array(malformed(100_000)),
          ...new TextEncoder().encode('"}]'),
        ]).buffer,
        at,
      );
      sql.exec("UPDATE statuses SET edited_at = ? WHERE id = ?", at, id);
      // Stored: MEDIA_DESCRIPTION_BYTES each, one character to SQLite.
      expect(
        sql
          .exec(
            "SELECT length(CAST(description AS BLOB)) AS bytes, length(description) AS characters FROM media_attachments WHERE status_id = ?",
            id,
          )
          .toArray(),
      ).toEqual(Array.from({ length: MAX_STATUS_MEDIA }, () => ({ bytes: MEDIA_DESCRIPTION_BYTES, characters: 1 })));
    });
    const described = (media: readonly { description?: unknown; name?: unknown }[], key: "description" | "name") => {
      expect(media).toHaveLength(MAX_STATUS_MEDIA);
      for (const m of media) {
        expect(m[key]).toBe(SHOWN);
        expect(jsonBytes(m[key])).toBeLessThanOrEqual(DESCRIPTION_JSON_MAX);
      }
    };
    // REST.
    const rest = (await read(t, getStatus, id)).answer as Presented;
    described(rest.media_attachments, "description");
    // The stream unit of an edit, as the hub presents it.
    const tokenHashes = [await sha256Hex(t.tokens.alice)];
    const unit = await runInDurableObject(t.store, (_instance, state) =>
      streamUnit.run(state.storage.sql, { kind: "edit", subject: id, accountId: ALICE, tokenHashes, now: NOW }),
    );
    expect(unit.event).toBe("status.update");
    described((unit.payload as Presented).media_attachments, "description");
    // The edit history: the current version, the snapshot the edit recorded and the imported one, whose description
    // editMediaSql cuts to MEDIA_DESCRIPTION_BYTES (40,000 U+FFFD decoded).
    const history = (await read(t, statusHistory, id)).answer as {
      content: string;
      media_attachments: Presented["media_attachments"];
    }[];
    const versions = Object.fromEntries(history.map((v) => [v.content, v.media_attachments]));
    described(versions["<p>described</p>"]!.slice(0, MAX_STATUS_MEDIA), "description");
    expect(versions["<p>imported</p>"]!.map((m) => m.description)).toEqual([SHOWN]);
    // The Note's attachments, and the legacy Image.
    const { note, image, filterText } = await runInDurableObject(t.store, (_instance, state) => {
      const db = new Db(state.storage.sql);
      const facts = statusFacts(db, id, noteQuote, { reached: false })!;
      const legacy = getLegacyObject.run(state.storage.sql, { uuid: "legacy-image", origin: ORIGIN });
      return {
        note: noteOf(facts),
        image: JSON.parse(legacy.image ?? "null") as { name?: string },
        filterText: storedSearchableText(db, id, at),
      };
    });
    described(
      (note.attachment as { name?: unknown }[]).filter((a) => "name" in a),
      "name",
    );
    expect(image.name).toBe(SHOWN);
    // The filter text holds the descriptions as shown.
    expect(filterText).toBe(
      ["", "described", Array.from({ length: MAX_STATUS_MEDIA }, () => SHOWN).join("\n\n")].join("\n\n"),
    );
    // The rows the read takes stay within R.
    const rows = await runInDurableObject(t.store, (_instance, state) => {
      const real = state.storage.sql;
      const visible = [id as VisibleStatusId];
      const shared = presentation(new Db(real), visible, { origin: ORIGIN, viewer: { accountId: ALICE, now: at } });
      let bytes = 0;
      const counting = observedSql(real, (read) => {
        bytes += heap(read);
      });
      presentStatusesWithin(new Db(counting), shared, visible, Infinity, true, 1);
      const [bound] = real
        .exec<{ bytes: number }>(statusRowBoundSql(), JSON.stringify(visible), ALICE, MAX_FILTERS)
        .toArray();
      return { bytes, bound: bound!.bytes };
    });
    expect(rows.bytes).toBeLessThanOrEqual(rows.bound);
  }, 120_000);

  // A keyword past the 10,000th code point of a description as decoded is not in the filter text, as it is not shown.
  it("leaves a description's text past MAX_MEDIA_DESCRIPTION_LENGTH code points out of the filter text", async () => {
    const t = await setup();
    const id = await storedStatus(t, ALICE, {
      content: "<p>x</p>",
      spoiler: "",
      media: [{ url: "https://m.example/0.png", preview: null, description: "", meta: null }],
      mentions: [],
      tags: [],
      poll: null,
    });
    const text = await runInDurableObject(t.store, (_instance, state) => {
      // 10,001 bytes of a malformed run, then the keyword: seven characters to SQLite, within both bounds.
      state.storage.sql.exec(
        "UPDATE media_attachments SET description = CAST(? AS TEXT) WHERE status_id = ?",
        malformed(MAX_MEDIA_DESCRIPTION_LENGTH + 1, "secret"),
        id,
      );
      return storedSearchableText(new Db(state.storage.sql), id, new Date(NOW).toISOString());
    });
    expect(text).toBe(`\n\nx\n\n${SHOWN}`);
    expect(text).not.toContain("secret");
  });
});

// The least spare the timeline heap and the conversation's JSON keep (#1142).
const SPARE_FLOOR = 4096;

describe("the table of maxima (RES-3)", () => {
  // docs/threat-model.md "Maxima of presented units" states these. An answer admits a whole item, so every atomic
  // shape stays within SHAPE_CEILING_PERCENT of ANSWER_BYTES (8 MiB) with filters included, measured and conservative
  // alike.
  const ceiling = (percent: number) => Math.floor((ANSWER_BYTES * percent) / 100);
  const LIMIT = ceiling(SHAPE_CEILING_PERCENT);

  it.each<[string, Fill]>([
    ["the escaped worst case: the most JSON", "escaped"],
    ["mentions whose url is derived", "derived"],
    ["the raw worst case: the most bytes read from SQLite", "raw"],
    ["short emoji references in every poll: the most poll emojis", "emoji-poll"],
    ["the most cached emoji: every remote snapshot at its most entries, each cached", "emoji-cache"],
  ])(
    "measures %s",
    async (_name, fill) => {
      const { shapes } = await measureFill(fill);
      expect(shapes).toEqual(FILL_SHAPES[fill]);
      for (const shape of Object.values(shapes)) {
        expect(shape.json).toBeLessThanOrEqual(LIMIT);
      }
    },
    300_000,
  );

  // An invalidated handle (accounts.ts shownHandle) shows the 18-digit id as username and `<id>@handle.invalid` (33
  // bytes) as acct, where the occurrence shows a username and an acct at their bounds, and its url (the stored one, else
  // the actor id) through the same href bound: an account with every other column at its bound stays within the
  // occurrence measured for its fill.
  it.each<Fill>(["escaped", "raw"])(
    "presents an invalidated account at its bounds within the %s account occurrence",
    async (fill) => {
      const t = await setup();
      const id = await maximalAccount(t, false, fill);
      for (const set of ["username = '! ' || id", "url = NULL"]) {
        await sql(t.store, `UPDATE accounts SET ${set} WHERE id = ?`, id);
        const { answer } = await measured(
          t,
          getAccount as never,
          { id, present: { origin: ORIGIN }, credential: null } as never,
        );
        expect(answer).toMatchObject({ username: id, acct: `${id}@handle.invalid`, invalid_handle: true });
        expect(jsonBytes(answer)).toBeLessThanOrEqual(FILL_SHAPES[fill].account.json);
      }
    },
    120_000,
  );

  // The conservative JSON of every shape is within the ceiling too, and bounds the emoji-poll fill, whose polls each
  // show the most emoji JSON less what their references displace (37 escaped characters: 185 bytes).
  it("keeps the conservative JSON of every shape within the ceiling, above every fill", async () => {
    const conservative = await conservativeJson();
    // Every presented account but the viewer's own shows a moved-to account, counted at MOVED_ACCOUNT_JSON_MAX.
    for (const fill of await Promise.all(FILLS.map(measureFill))) {
      expect(Object.fromEntries(Object.entries(fill.moved).map(([name, { count }]) => [name, count]))).toEqual({
        account: 1,
        status: 1,
        quote: 2,
        boostOfQuote: 3,
        conversation: 14,
        group: 10,
        report: 4,
        reportNotification: 2,
        warningNotification: 0,
        warningGroup: 0,
        filteredNotification: 3,
      });
    }
    // Each attachment shown counts its four URLs at MEDIA_URL_JSON_BYTES and its blurhash at BLURHASH_JSON_MAX; the
    // escaped fill's witnesses (backslash queries at the byte bound) come within the URL host and path of them.
    const { media } = await measureFill("escaped");
    console.info(`Media shown and their JSON deficit: ${JSON.stringify(media)}`);
    for (const { count, deficit } of Object.values(media)) {
      expect(deficit).toBeLessThanOrEqual(count * 4 * 2 * "https://m.example/0/?".length);
    }
    const [escaped, emojiPoll] = await Promise.all([measureFill("escaped"), measureFill("emoji-poll")]);
    const displaced = SHORT_REFERENCES.length * 5;
    for (const [name, json] of Object.entries(conservative)) {
      expect(json).toBeLessThanOrEqual(LIMIT);
      for (const fill of await Promise.all(FILLS.map(measureFill))) {
        expect(fill.shapes[name]!.json).toBeLessThanOrEqual(json);
      }
      expect(emojiPoll.shapes[name]!.json - escaped.shapes[name]!.json).toBe(
        (POLLS_SHOWN[name] ?? 0) * (POLL_EMOJIS_JSON - displaced),
      );
    }
    // The conversation's spare under the ceiling (one card in that shape): at least SPARE_FLOOR (#1142), and
    // SHAPE_CEILING_PERCENT is the least whole percent that keeps it.
    const spare = LIMIT - conservative.conversation!;
    expect(spare).toBe(62_869);
    expect(spare).toBeGreaterThanOrEqual(SPARE_FLOOR);
    expect(ceiling(SHAPE_CEILING_PERCENT - 1) - conservative.conversation!).toBeLessThan(SPARE_FLOOR);
    expect(conservative).toEqual(CONSERVATIVE_JSON);
  }, 600_000);

  // A moderation_warning is streamed as its notification's JSON encoded again as a string (stream-hub.ts), which
  // escapes each backslash and quote once more: the most of every fill, and the conservative payload (the escaped
  // fill's plus twice its notification's conservative JSON over its measured, as encoding again at most doubles a
  // byte), stay within the hub's payload limit.
  it("keeps the moderation_warning stream payload within the hub’s limit", async () => {
    const fills = await Promise.all(FILLS.map(measureFill));
    const payloads = fills.map((fill) => fill.warningPayload);
    const escaped = await measureFill("escaped");
    const conservative = await conservativeJson();
    const payload =
      escaped.warningPayload + 2 * (conservative.warningNotification! - escaped.shapes.warningNotification!.json);
    expect({ measured: Math.max(...payloads), conservative: payload }).toEqual({
      measured: 337_412,
      conservative: 476_110,
    });
    expect(payload).toBeLessThan(STREAM_LIMITS.payloadBytes);
    // The derived bounds of a local field value and of a local account's fields, and the fill's linked value.
    expect({
      value: LOCAL_FIELD_VALUE_JSON_MAX,
      fields: LOCAL_FIELDS_JSON_MAX,
      linked: jsonBytes(renderFieldValue(localLinkValue(0))),
    }).toEqual({ value: 7_822, fields: 37_677, linked: 2_594 });
    // Imported fields past the writer's limits present within the derived figures (fieldSources keeps the first
    // MAX_FIELDS entries within the code point limits): over-long values of many links, and five entries.
    const presented = (stored: unknown) =>
      fieldSources(JSON.stringify(stored)).map((field) => ({
        name: field.name,
        value: renderFieldValue(field.value),
        verified_at: "2026-10-12T00:00:00.000+00:00",
      }));
    const witnesses = [
      Array.from({ length: 4 }, () => ({ name: "", value: "http://a ".repeat(450) })),
      Array.from({ length: 5 }, (_, i) => ({ name: C.repeat(MAX_FIELD_NAME), value: localLinkValue(i) })),
      Array.from({ length: 4 }, () => ({ name: C.repeat(MAX_FIELD_NAME), value: "http://a ".repeat(28) })),
    ];
    for (const stored of witnesses) {
      const fields = presented(stored);
      expect(fields.length).toBeLessThanOrEqual(MAX_FIELDS);
      expect(jsonBytes(fields)).toBeLessThanOrEqual(LOCAL_FIELDS_JSON_MAX);
      for (const field of fields) {
        expect(jsonBytes(field.value)).toBeLessThanOrEqual(LOCAL_FIELD_VALUE_JSON_MAX);
      }
    }
    expect(witnesses.map((stored) => presented(stored).length)).toEqual([0, 4, 4]);
  }, 600_000);

  // The most a stream turn presents (stream-hub.ts, RES-6): a turn starts a unit while UNIT_WORST is left of
  // TURN_BUDGET, and charges it whole once presented, so the unit that crosses it presents at most 2S + 2 bytes
  // (encoding the JSON again at most doubles a byte, plus two quotes), S the most JSON a streamed subject presents:
  // `update` and `status.update` a status, at most a boost of a quote; `conversation` its participants and a last
  // status, counted as a boost of a quote, which it no longer shows (conversationStream shows at most a quote), so S is
  // conservative until it is re-derived from the quote conversation (#1610); `notification` its account, its status
  // and a report and a warning (their conservative figures count a fallback each, which a streamed notification does
  // not carry); an announcement, at its derived maximum (test/announcement-bounds.test.ts).
  it("bounds what a stream turn presents by the most a streamed subject presents", async () => {
    const c = await conservativeJson();
    const ANNOUNCEMENT = 248_997;
    const kinds = {
      status: c.boostOfQuote!,
      conversation: c.conversation! - c.quote! + c.boostOfQuote!,
      notification: c.boostOfQuote! + c.reportNotification! + c.warningNotification!,
      announcement: ANNOUNCEMENT,
    };
    const most = Math.max(...Object.values(kinds));
    expect({ ...kinds, most }).toEqual({
      status: 5_818_830,
      conversation: 7_568_003,
      notification: 6_625_860,
      announcement: ANNOUNCEMENT,
      most: 7_568_003,
    });
    expect(TURN_BUDGET.bytes - UNIT_WORST.bytes + 2 * most + 2).toBe(18_806_024);
    const { streamed } = await measureFill("escaped");
    expect(streamed).toEqual({ conversation: 7_074_778, conversationPayload: 7_836_062, notification: 5_918_803 });
    expect(streamed!.conversation).toBeLessThanOrEqual(kinds.conversation);
    expect(streamed!.conversationPayload).toBeLessThanOrEqual(2 * most + 2);
    expect(streamed!.notification).toBeLessThanOrEqual(kinds.notification);
  }, 600_000);

  // What an answer of many accounts reads past its budget (one chunk of accounts.ts ANSWER_CHUNK, 50, each with its
  // static images and its verification times at their bounds and its moved-to account) and what a page of 80 accounts
  // serializes to at most, from the account occurrence.
  it("bounds a chunk of accounts read past an answer and a page of 80, from the account occurrence", async () => {
    const { shapes } = await measureFill("raw");
    const conservative = await conservativeJson();
    expect({
      chunk: 50 * (shapes.account!.sqlite + 2 * STATIC_URL_LIMIT + REMOTE_VERIFIED_JSON_BYTES + MOVED_ROW_SQLITE_MAX),
      page: 80 * conservative.account!,
    }).toEqual({ chunk: 6_905_000, page: 12_001_760 });
  }, 600_000);

  // Half of the Store isolate's 128 MB. A timeline's largest item is a status, a quote or a boost of a quote; groups
  // and reports keep the presentation's state besides (10.1 and 12.5 MB, docs/threat-model.md) and pass half, below
  // the whole (the RES-3 gap).
  const HALF = 64_000_000;
  const CAP_STEP = 8 * 1024;
  it("keeps the peaks of the heap model within their bounds, from the maxima per column", async () => {
    const timelines = await peaks(["status", "quote", "boostOfQuote"], PAGE_CHUNKS, 0);
    const groups = await peaks(["group"], LARGE_ITEM_CHUNKS, 10_100_000);
    const reports = await peaks(["report"], LARGE_ITEM_CHUNKS, 12_500_000);
    // The peaks follow from the fills and the constants, which are pinned, so they are pinned too, as the document's
    // heap tables state them.
    expect({ timelines, groups, reports }).toEqual(HEAP_PEAKS);
    expect(timelines.normal).toBeLessThanOrEqual(HALF);
    expect(timelines.backstop).toBeLessThanOrEqual(HALF);
    // The spare a later change may spend: below SPARE_FLOOR, it stops for a review.
    expect(HALF - timelines.backstop).toBeGreaterThanOrEqual(SPARE_FLOOR);
    // PAGE_CHUNKS is the largest cap in steps of 8 KiB that keeps it: the backstop grows by 1.25 bytes a byte of cap.
    expect(PAGE_CHUNKS.cap % CAP_STEP).toBe(0);
    expect(HALF - (timelines.backstop + 1.25 * CAP_STEP)).toBeLessThan(SPARE_FLOOR);
    for (const p of [groups, reports]) {
      expect(p.backstop).toBeLessThanOrEqual(2 * HALF);
    }
  }, 900_000);

  // R (status-rows.ts), which statusStream plans its chunks by, is at least the heap RowMeter counts of the rows each
  // shape reads, with every part at its bound (maximalStatuses).
  it("bounds the rows each shape reads by R", async () => {
    const { t, quoted, quote, boost } = await maximalStatuses("raw");
    const measuredShapes = await runInDurableObject(t.store, (_instance, state) => {
      const real = state.storage.sql;
      const viewer = { accountId: ALICE, now: new Date(NOW).toISOString() };
      return [quoted, quote, boost].map((id) => {
        const visible = [id as VisibleStatusId];
        const shared = presentation(new Db(real), visible, { origin: ORIGIN, viewer });
        let bytes = 0;
        let rows = 0;
        const counting = observedSql(real, (read) => {
          rows += read.length;
          bytes += heap(read);
        });
        presentStatusesWithin(new Db(counting), shared, visible, Infinity, true, 1);
        const [bound] = real
          .exec<{ bytes: number }>(statusRowBoundSql(), JSON.stringify(visible), ALICE, MAX_FILTERS)
          .toArray();
        return { bytes, rows, bound: bound!.bytes };
      });
    });
    for (const shape of measuredShapes) {
      expect(shape.bytes).toBeLessThanOrEqual(shape.bound);
    }
    console.info(
      `R at the maxima (status, quote, boost of a quote): ${measuredShapes.map((m) => `${m.bound} for ${m.bytes} counted in ${m.rows} rows`).join("; ")}`,
    );
  }, 300_000);

  // The largest atomic items through the real Store RPC (32 MiB per return): the boost of a quote alone, and an
  // answer of the boost, the quote and the quoted status, which admits the boost and stops at the quote. Raw fill is
  // the most serialized bytes (four-byte characters), escaped fill the most JSON.
  it.each<[string, Fill]>([
    ["escaped", "escaped"],
    ["raw", "raw"],
  ])(
    "returns the largest atomic items through the Store RPC, %s",
    async (_name, fill) => {
      const { t, quoted, quote, boost } = await maximalStatuses(fill);
      const input = {
        credential: { ...(await credential(t)), scope: "read" as const },
        now: NOW,
        present: { origin: ORIGIN },
      };
      const one = await t.store.getStatus(BUILD, { ...input, id: boost });
      const many = await t.store.getStatuses(BUILD, { ...input, ids: [boost, quote, quoted] });
      expect(one.status === "ok" && one.value.status === "ok" && one.value.value.id).toBe(boost);
      expect(many.status === "ok" && many.value.map((s) => s.id)).toEqual([boost]);
      const sizes = [jsonBytes(one), jsonBytes(many)];
      for (const size of sizes) {
        expect(size).toBeLessThanOrEqual(ANSWER_BYTES);
      }
      console.info(`Store RPC, ${fill}: the boost of a quote ${sizes[0]}, the lookup ${sizes[1]} JSON bytes`);
    },
    120_000,
  );
});

describe("ActivityPub Notes of a local status at its bounds (RES-3)", () => {
  // A converted local status with every part at its bound, an attached card on it (an imported row beside its media)
  // whose url (CARD_URL_LIMIT bytes of ASCII, which JSON does not escape) and title (CARD_TEXTS.title less its quotes,
  // in ASCII: the most bytes its projection reads) are at their bounds,
  // built as statusFacts and noteOf build the object endpoint's Note, the outbox's Create and the featured
  // collection's Notes. docs/threat-model.md "Maxima of presented units" states the Note and the Create.
  it("measures the Note and the Create, within OUTBOX_BYTES, and five Notes of the featured collection", async () => {
    const t = await setup();
    const parts = await maximalParts(t);
    // Addressed to MAX_LOCAL_ADDRESSED accounts, each actor id at ACTOR_URI_LIMIT: the mentions above and more.
    const base = 950_000_000_000_000_000n;
    const more = MAX_LOCAL_ADDRESSED - parts.mentions.length;
    await sql(
      t.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO accounts (id, uri, username, domain)
			SELECT CAST(?2 + i AS TEXT), substr(?3 || (?2 + i) || '/' || ?4, 1, ?5), 'a' || i, ?6 FROM n`,
      more,
      String(base),
      `https://${HOST}/users/`,
      "u".repeat(ACTOR_URI_LIMIT),
      ACTOR_URI_LIMIT,
      HOST,
    );
    parts.mentions = [...parts.mentions, ...Array.from({ length: more }, (_, i) => String(base + BigInt(i + 1)))];
    // A local emoji snapshot at exactly STATUS_EMOJIS_BYTES presented bytes, every entry resolved to an Emoji tag
    // (custom-emojis.ts localEmojiTags), with as many entries as fit (local-emoji-helpers.ts localSnapshotAtCap).
    parts.emojis = await localSnapshotAtCap(t.store, ALICE, STATUS_EMOJIS_BYTES);
    expect(presentedEmojiBytes(JSON.parse(parts.emojis) as [string, string][])).toBe(STATUS_EMOJIS_BYTES);
    const ids: string[] = [];
    for (let i = 0; i < PIN_LIMIT; i++) {
      const id = await storedStatus(t, ALICE, parts);
      await maximalCard(t, id, "raw");
      await sql(t.store, "INSERT INTO status_pins (account_id, status_id) VALUES (?, ?)", ALICE, id);
      ids.push(id);
    }
    const measuredNote = await runInDurableObject(t.store, (_instance, state) => {
      let sqlite = 0;
      let rows = 0;
      const counting = observedSql(state.storage.sql, (read) => {
        for (const row of read) {
          rows++;
          for (const value of Object.values(row)) {
            sqlite += typeof value === "string" ? utf8Length(value) : 8;
          }
        }
      });
      const facts = statusFacts(new Db(counting), ids[0]!, noteQuote, { reached: false })!;
      const note = noteOf(facts);
      return {
        sqlite,
        rows,
        nodes: nodes(note),
        note: jsonBytes(note),
        create: jsonBytes(createActivity(facts).activity),
        tags: facts.tags.length,
        longest: Math.max(...facts.tags.map((tag) => [...tag.name].length)),
        mentions: facts.mentions.length,
        media: facts.media.length,
        emojis: facts.emojis.length,
        emojiTags: jsonBytes(facts.emojis),
        link: jsonBytes(note.attachment) - jsonBytes((note.attachment as unknown[]).slice(0, -1)),
      };
    });
    expect(measuredNote).toMatchObject({ tags: MAX_PRESENTED_TAGS, mentions: MAX_STATUS_MENTION_ROWS, media: 4 });
    expect(measuredNote.longest).toBeLessThanOrEqual(MAX_TAG_LENGTH);
    expect(measuredNote.create).toBeLessThanOrEqual(OUTBOX_BYTES);
    const featured = await runInDurableObject(t.store, (_instance, state) =>
      getFeatured.run(state.storage.sql, { username: "alice" }),
    );
    // Five such Notes pass the bound: the first ones are shown whole, the rest by their uri.
    let items = featured as unknown;
    while (!Array.isArray(items)) {
      items = (items as { value: unknown }).value;
    }
    const pins = items as { uri: string; note: string | null }[];
    const featuredBytes = jsonBytes(pins);
    expect(featuredBytes).toBeLessThanOrEqual(ANSWER_BYTES);
    const whole = pins.filter((item) => item.note !== null).length;
    expect(whole).toBeGreaterThan(0);
    expect(whole).toBeLessThan(PIN_LIMIT);
    expect(pins).toHaveLength(PIN_LIMIT);
    // Three hashtags far past their bound, as a converted row may hold them, are left out, as the Status entity leaves
    // them out.
    const long = await storedStatus(t, ALICE, {
      ...parts,
      mentions: [],
      media: [],
      poll: null,
      tags: [1, 2, 3].map((i) => `${i}${"x".repeat(240_000)}`),
    });
    const shown = await runInDurableObject(t.store, (_instance, state) => {
      const facts = statusFacts(new Db(state.storage.sql), long, noteQuote, { reached: false })!;
      return { tags: facts.tags.length, create: jsonBytes(createActivity(facts).activity) };
    });
    expect(shown.tags).toBe(0);
    expect(shown.create).toBeLessThan(200_000);
    expect({ ...measuredNote, featured: featuredBytes, whole }).toEqual({
      ...NOTE_MAXIMA,
      tags: MAX_PRESENTED_TAGS,
      longest: MAX_TAG_LENGTH,
      mentions: MAX_STATUS_MENTION_ROWS,
      media: 4,
      emojis: 61,
      emojiTags: 14_850,
      // The Link and its comma: `,{"type":"Link","href":""}` and the url.
      link: 26 + CARD_URL_LIMIT,
      featured: 4_456_650,
      whole: 1,
    });
  }, 300_000);
});

describe("the public pages at the maxima (RES-3)", () => {
  // Every input the page reads at its cap at once, in the emoji-poll fill (the largest quote payloads of the fills:
  // the escaped fill with each poll's choices showing every emoji): the profile's account (a local account made from
  // maximalAccount: its display name, bio, URLs and emoji at their bounds, a username of USERNAME_LIMIT on a
  // 2,000-character host, MAX_FIELDS local fields at their limits, verified); each post at the unit maximum of the
  // quote shape (a local status with maximalParts quoting a remote one with maximalParts, each with a card at its
  // bounds), posted through an app whose name and website are at their bounds; each post after the first a reply to
  // the one before (its parent link: a local URL on that host, the author's acct); and the status page's post a reply
  // to a remote parent whose url is at 4,096 bytes and whose author has a username at its bound on that host, with its
  // thread's caps filled (more ancestors than the walk visits, more replies than a window holds, each at the quote
  // shape's maximum). The embed is the status page's read without its thread. The pages are held to what the
  // conservative JSON of the account and the quote shape (conservativeJson, the derivation the table of maxima uses)
  // allows with the page's own frame and links.
  it("keeps the profile feed within WEB_PAGE_BYTES, and the status page and the embed within ANSWER_BYTES", async () => {
    const t = await setup();
    const fill: Fill = "emoji-poll";
    const author = await maximalAccount(t, false, fill);
    await sql(
      t.store,
      "UPDATE accounts SET moved_to_account_id = NULL, domain = NULL, raw = NULL, fetched_at = NULL WHERE id = ?",
      author,
    );
    await sql(
      t.store,
      `INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey, fields, verified_links)
			VALUES (?, ?, X'00', X'00', 'k', ?, ?)`,
      author,
      `${author}@kopje.test`,
      JSON.stringify(
        Array.from({ length: MAX_FIELDS }, (_, i) => ({ name: C.repeat(MAX_FIELD_NAME), value: localLinkValue(i) })),
      ),
      JSON.stringify(
        Array.from({ length: MAX_FIELDS }, (_, i) => [localLinkValue(i), new Date(NOW).toISOString()]),
      ).padEnd(VERIFIED_LINKS_BYTES, " "),
    );
    const [{ username }] = (await sql<{ username: string }>(
      t.store,
      "SELECT username FROM accounts WHERE id = ?",
      author,
    )) as [{ username: string }];
    const parts = await maximalParts(t, fill);
    const quotedAuthor = await maximalAccount(t, false, fill);
    // A post at the quote shape's maximum, its quoted status by quotedAuthor; a local one's through the app.
    const quotePost = async (by = author) => {
      const quoted = await storedStatus(t, quotedAuthor, parts);
      const id = await storedStatus(t, by, parts);
      await acceptQuote(t, id, quoted);
      await maximalCard(t, quoted, fill);
      await maximalCard(t, id, fill);
      if (by === author) {
        await sql(t.store, "UPDATE statuses SET application_id = 'page-app' WHERE id = ?", id);
      }
      return id;
    };
    await sql(
      t.store,
      `INSERT INTO oauth_clients (id, secret, name, redirect_uris, website)
			VALUES ('page-app', 's', ?, 'urn:x', ?)`,
      C.repeat(APP_NAME_LIMIT),
      "https://kopje.test/".padEnd(APP_WEBSITE_LIMIT, "u"),
    );
    const replyTo = (id: string, parent: string, parentAuthor: string) =>
      sql(
        t.store,
        `UPDATE statuses SET in_reply_to_id = ?2, in_reply_to_account_id = ?3,
					in_reply_to_uri = (SELECT uri FROM statuses WHERE id = ?2) WHERE id = ?1`,
        id,
        parent,
        parentAuthor,
      );
    const posts = [await quotePost(), await quotePost()];
    await replyTo(posts[1]!, posts[0]!, author);
    const parentAuthor = await maximalAccount(t, false, fill);
    const parent = await storedStatus(t, parentAuthor, {
      content: "",
      spoiler: "",
      media: [],
      mentions: [],
      tags: [],
      poll: null,
    });
    const focal = await quotePost();
    await replyTo(focal, parent, parentAuthor);
    // The status page's thread with its caps filled: above the remote parent a chain of more ancestors than the walk
    // visits (CONTEXT_LIMITS, 40 for an anonymous viewer), and more direct replies than the replies' window holds
    // (readWindow(20), 60), each at the quote shape's maximum, by the remote parent's author (so the feeds below
    // list none of them).
    const chain: string[] = [];
    for (let i = 0; i < 40; i++) {
      const id = await quotePost(parentAuthor);
      if (chain.length > 0) {
        await replyTo(id, chain.at(-1)!, parentAuthor);
      }
      chain.push(id);
    }
    await replyTo(parent, chain.at(-1)!, parentAuthor);
    const replies: string[] = [];
    for (let i = 0; i < 61; i++) {
      const id = await quotePost(parentAuthor);
      await replyTo(id, focal, author);
      replies.push(id);
    }

    // The profile feed, walked to its end: a post at the quote shape's maximum does not fit beside
    // the account within WEB_PAGE_BYTES, so each page is the account and the post's stub, within WEB_PAGE_BYTES, and
    // the walk reaches every post once.
    const sizes: number[] = [];
    const { seen, pages: feedPages } = await walkProfile(async (maxId) => {
      const page = await t.store.webProfilePage(BUILD, postsTab(username, maxId, NOW));
      if (page.status !== "ok") {
        throw new Error(page.status);
      }
      sizes.push(jsonBytes(page));
      return page;
    }, 5);
    expect(seen).toEqual(posts.toReversed());
    // A stub a page, then the empty page past the last.
    expect(feedPages).toEqual([...posts.map(() => ({ shown: 0, stub: true })), { shown: 0, stub: false }]);
    expect(sizes.every((size) => size <= WEB_PAGE_BYTES)).toBe(true);

    // The status page and the embed: the post and its remote parent's link at their bounds. The head passes
    // WEB_PAGE_BYTES, so its thread holds no ancestor and its first reply's stub; the next page starts past it.
    const statusRead = (cursor: PageCursor) =>
      t.store.webStatusPage(BUILD, { handle: username, id: focal, now: NOW, tab: { kind: "replies", cursor } });
    const statusPage = await statusRead(null);
    const embedPage = await t.store.webStatusPage(BUILD, { handle: username, id: focal, now: NOW, tab: null });
    if (statusPage.status !== "ok" || statusPage.thread === null || embedPage.status !== "ok") {
      throw new Error(statusPage.status);
    }
    expect(jsonBytes(statusPage)).toBeLessThanOrEqual(ANSWER_BYTES);
    const { list } = statusPage.thread;
    expect([
      statusPage.thread.ancestors,
      list.kind,
      "statuses" in list && list.statuses,
      "stub" in list && list.stub?.id,
    ]).toEqual([[], "replies", [], replies[0]]);
    expect(statusPage.thread.paging).toEqual({ newest: replies[0], oldest: replies[0], more: true });
    const second = await statusRead({ minId: replies[0]! });
    expect(second.status === "ok" && second.thread?.list.kind === "replies" && second.thread.list.stub?.id).toBe(
      replies[1],
    );
    expect(statusPage.parent?.url).toBe(atLimit(`https://${HOST}/notes/${parent}/`, 4096));
    expect(statusPage.parent?.acct.endsWith(`@${HOST}`)).toBe(true);
    expect((statusPage.value as { quote: { quoted_status: unknown } | null }).quote?.quoted_status).not.toBeNull();
    for (const path of [`/@${username}`, `/@${username}/${focal}`, `/@${username}/${focal}/embed`]) {
      expect([path, (await t.request(path)).status]).toEqual([path, 200]);
    }
    expect((statusPage.value as { application?: unknown }).application).toEqual({
      name: C.repeat(APP_NAME_LIMIT),
      website: "https://kopje.test/".padEnd(APP_WEBSITE_LIMIT, "u"),
    });
    // The derivation: a profile page with the account and one post at their conservative JSON, the post's parent link
    // and the frame (budget.ts) fits ANSWER_BYTES, the ceiling of an answer whose head passes WEB_PAGE_BYTES; a
    // status page with the post and its parent link at theirs, its head whatever the page budget, does too. Each page
    // measured here is within it.
    const conservative = await conservativeJson();
    const frame = profileFrameBytes({ domain: "kopje.test", documents: { privacyPolicy: true, termsOfService: true } });
    const profileBound = frame + conservative.account! + conservative.quote! + 1 + PARENT_ENTRY_BYTES;
    // The parent link counts at its bounds (its strings' quotes counted twice, which only adds); the thread's frame
    // holds the longest stub and paging ends, and the history's the longest count of versions left out (the embed's
    // holds neither, and this post has no history).
    const statusFrame = (thread: unknown) =>
      jsonBytes({
        status: "ok",
        value: null,
        parent: { url: "", acct: "" },
        thread,
        history: { versions: [], leftOut: Number.MAX_SAFE_INTEGER },
        site: { domain: "kopje.test", documents: { privacyPolicy: true, termsOfService: true } },
      }) +
      conservative.quote! +
      LINK_URL_JSON_BYTES +
      LINK_ACCT_JSON_BYTES;
    const statusBound = statusFrame({
      ancestors: [],
      list: { kind: "replies", statuses: [], stub: LONGEST_STATUS_STUB },
      paging: { newest: "9".repeat(19), oldest: "9".repeat(19), more: true },
    });
    const embedBound = statusFrame(null);
    // The other tabs' ceilings: the Quotes tab's frame holds a stub as the Replies tab's does, and the Boosts and
    // Favourites tabs' frames none, their first account admitted whole beside the head (budget.ts accountList).
    const paging = { newest: "9".repeat(19), oldest: "9".repeat(19), more: true };
    const quotesBound = statusFrame({
      ancestors: [],
      list: { kind: "quotes", statuses: [], stub: LONGEST_STATUS_STUB, parents: {} },
      paging,
    });
    const accountsBound = Math.max(
      ...(["reblogs", "favourites"] as const).map(
        (kind) => statusFrame({ ancestors: [], list: { kind, accounts: [] }, paging }) + conservative.account! + 1,
      ),
    );
    expect([quotesBound, accountsBound].every((bound) => bound <= ANSWER_BYTES)).toBe(true);
    expect(profileBound).toBeLessThanOrEqual(ANSWER_BYTES);
    expect(statusBound).toBeLessThanOrEqual(ANSWER_BYTES);
    expect(sizes.every((size) => size <= profileBound)).toBe(true);
    expect(jsonBytes(statusPage)).toBeLessThanOrEqual(statusBound);
    expect(jsonBytes(embedPage)).toBeLessThanOrEqual(embedBound);
    console.info(
      `Public pages at the maxima: feed ${JSON.stringify(sizes)}, status ${jsonBytes(statusPage)}, embed ${jsonBytes(embedPage)}; derived profile ${profileBound}, status ${statusBound}, quotes ${quotesBound}, accounts ${accountsBound}, embed ${embedBound}`,
    );

    // With PIN_LIMIT pins, each a post at the quote shape's maximum (two of them replies, one to the remote parent at
    // its bounds), and the author's boost of one of them (its original at that maximum): the Posts tab's pins come
    // first, strictly (none of them fits beside the account within WEB_PAGE_BYTES), then the list, its first item
    // stubbed when it does not fit; every page within WEB_PAGE_BYTES and the walk reaching every post once, in order.
    const pinned = [...posts, focal, await quotePost(), await quotePost()];
    expect(pinned).toHaveLength(PIN_LIMIT);
    await pinStatuses(t.store, author, pinned);
    await sql(
      t.store,
      `INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, content, published_at)
			VALUES ('999999999999999990', 'https://kopje.test/boost/1', ?, ?, 'public', '', ?)`,
      author,
      posts[0]!,
      new Date(NOW).toISOString(),
    );
    const pinSizes: number[] = [];
    const pinsShown: string[] = [];
    const { seen: walked } = await walkProfile(async (maxId) => {
      const page = await t.store.webProfilePage(BUILD, postsTab(username, maxId, NOW));
      if (page.status !== "ok") {
        throw new Error(page.status);
      }
      const bytes = jsonBytes(page);
      expect(bytes).toBeLessThanOrEqual(WEB_PAGE_BYTES);
      pinSizes.push(bytes);
      if (maxId === null) {
        pinsShown.push(...page.pins.map((pin) => pin.id));
      }
      return page;
    }, 20);
    // The pins that fit, newest pin first: a prefix of them, never one after one left out.
    expect(pinned.toReversed().slice(0, pinsShown.length)).toEqual(pinsShown);
    // The list: the boost, then the posts newest first, less the focal post (a reply to another account).
    expect(walked).toEqual(["999999999999999990", ...pinned.slice(3).toReversed(), ...posts.toReversed()]);
    console.info(`Profile with pins and a boost at the maxima: ${JSON.stringify(pinSizes)}, pins ${pinsShown.length}`);

    // The hashtag page (/tags/:name), every input at its cap at once: the name at the bound of the hashtags Kopje
    // lists (maxTag(0), 256 code points of four UTF-8 bytes, which JSON does not escape), carried by every post here
    // among its 100 hashtags at their bound; the posts the five above by the maximal local author, each at the quote
    // shape's maximum (two of them replies, one to the remote parent at its link bounds); more of them than one answer
    // holds, so pages are filled to their byte capacity. Their quoted statuses (by a remote author) and the boost
    // carry no place on a local hashtag's page. The derivation: the frame with the name, one post at its conservative
    // JSON and its parent link fit ANSWER_BYTES; within WEB_PAGE_BYTES each post is its page's stub,
    // every page is within WEB_PAGE_BYTES and the walk reaches every post once, newest first.
    const tag = maxTag(0);
    const tagBound =
      tagFrameBytes(tag, { domain: "kopje.test", documents: { privacyPolicy: true, termsOfService: true } }) +
      conservative.quote! +
      1 +
      PARENT_ENTRY_BYTES;
    expect(tagBound).toBeLessThanOrEqual(ANSWER_BYTES);
    const tagSizes: number[] = [];
    const tagParents: string[] = [];
    const { seen: tagSeen, pages: tagPages } = await walkProfile(async (maxId) => {
      const page = await t.store.webTagPage(BUILD, { name: tag, cursor: maxId === null ? null : { maxId }, now: NOW });
      if (page.status !== "ok") {
        throw new Error(page.status);
      }
      expect(page.tag).toBe(tag);
      expect(page.statuses).toEqual([]);
      tagSizes.push(jsonBytes(page));
      tagParents.push(...Object.keys(page.parents));
      return page;
    }, 20);
    expect(tagSeen).toEqual(pinned.toReversed());
    // One post a page, as its stub, which links no parent, then the empty page past the last.
    expect(tagPages).toEqual([...pinned.map(() => ({ shown: 0, stub: true })), { shown: 0, stub: false }]);
    expect(tagSizes.every((size) => size <= WEB_PAGE_BYTES)).toBe(true);
    expect(tagParents).toEqual([]);
    expect((await t.request(`/tags/${encodeURIComponent(tag)}`)).status).toBe(200);
    console.info(`Hashtag page at the maxima: ${JSON.stringify(tagSizes)}; derived first-post bound ${tagBound}`);
  }, 600_000);
});
