// RES-2: the stored bounds of the columns a remote server controls or a converted row may carry. Each column has a
// projection P, the SQL builder below, and a writer that ingestion, the local write paths, the cutover's conversion and
// its verification apply. The triggers of 0048_stored_bounds refuse what is not a fixed point of P
// (domain/stored-triggers.ts), and reads take the columns of STORED_COLUMNS as stored; pollOptionsSql is also the read projection of polls.options. Every writer's
// output, as SQLite stores it, is a fixed point of the column's P, and P(P(x)) = P(x) for any stored string
// (test/stored-bounds.test.ts).
//
// Text writers replace a lone surrogate with U+FFFD and remove U+0000 (storedText), then cut by code points, as
// SQLite's substr and length count them. JSON-bounded columns (bio, content, content warning, source text) keep the
// writers of security/html.ts, applied to storedText's output.
//
// No relative imports: the cutover runs it from the sources on Node (cli/lib/cutover/kopje-runtime.js). The JSON
// bounds of security/html.ts and the status URI bound of identity-bounds.ts are therefore repeated here;
// test/stored-bounds.test.ts pins them equal.

// Display names, in code points.
export const DISPLAY_NAME_LIMIT = 2048;
// Profile URLs (url, avatar, header), in UTF-8 bytes; a serialized URL is ASCII.
export const PROFILE_URL_LIMIT = 2048;
// A status's url, in UTF-8 bytes, as identity-bounds.ts STATUS_URI_LIMIT bounds its uri.
export const STATUS_URL_LIMIT = 4096;
// A media URL (url, preview_url), in UTF-8 bytes, and as a presented JSON string: an href is ASCII, and JSON escapes
// none of its characters to more than two bytes (controls, spaces and quotes are percent-encoded).
export const MEDIA_URL_LIMIT = 2048;
export const MEDIA_URL_JSON_BYTES = 2 * MEDIA_URL_LIMIT + 2;
// A media row's meta, in UTF-8 bytes: the stored dimensions ({"original":{...},"small":{...}}) take about 80.
export const MEDIA_META_BYTES = 1024;
// A media description, in code points, as Mastodon's MAX_DESCRIPTION_HARD_LENGTH_LIMIT.
export const MAX_MEDIA_DESCRIPTION_LENGTH = 10_000;
// A poll's choices (RES-4): at most this many, each at most this many code points as read.
export const MAX_REMOTE_OPTIONS = 100;
export const MAX_REMOTE_OPTION_LENGTH = 1000;
// polls.options as its CHECK bounds it (migration 0013), in UTF-8 bytes; an edit's poll_options past it reads as none.
export const POLL_OPTIONS_BYTES = 655_360;
// The JSON-string bounds of security/html.ts (REMOTE_BIO_BYTES, STATUS_CONTENT_BYTES, SPOILER_BYTES), in UTF-8 bytes
// of the escaped string with its quotes.
export const BIO_JSON_BYTES = 64 * 1024;
export const CONTENT_JSON_BYTES = 128 * 1024;
export const SPOILER_JSON_BYTES = 16 * 1024;

// ---- Projections (P)

// SQLite's substr and length stop at an embedded NUL, so a string is cut only when its UTF-8 bytes pass the limit
// (a code point is never longer than its bytes). A string containing a NUL is kept whole while its UTF-8 bytes fit
// the limit; otherwise it may come out shorter than a cut in code units would be, never longer.
export function cutSql(column: string, limit: number): string {
  return `CASE WHEN length(CAST(${column} AS BLOB)) <= ${limit} THEN ${column} ELSE substr(${column}, 1, ${limit}) END`;
}

// `column` when its JSON string (json_quote: quotes and escapes, as JSON.stringify writes them) is at most `bytes`
// UTF-8 bytes, else `over`. json_quote measures it only below the raw bound, so its escaped copy stays far below
// SQLite's largest string.
export function jsonBoundSql(column: string, bytes: number, over: string): string {
  return `CASE WHEN length(CAST(${column} AS BLOB)) > ${bytes} THEN ${over}
	WHEN length(CAST(json_quote(${column}) AS BLOB)) > ${bytes} THEN ${over} ELSE ${column} END`;
}

// A text value cut to its first `bytes` UTF-8 bytes, counted as bytes: SQLite's length and substr count characters,
// skipping continuation bytes, so a malformed imported value would pass a character cut whole. Each byte presents as
// at most six JSON bytes (a control character escaped, or a malformed byte decoded to U+FFFD: three).
export function byteCut(column: string, bytes: number): string {
  return `CAST(substr(CAST(${column} AS BLOB), 1, ${bytes}) AS TEXT)`;
}

// A NULL past `bytes` UTF-8 bytes.
export function byteBoundSql(column: string, bytes: number): string {
  return `CASE WHEN length(CAST(${column} AS BLOB)) <= ${bytes} THEN ${column} END`;
}

// accounts.display_name: cut at DISPLAY_NAME_LIMIT code points.
export function displayNameSql(column: string): string {
  return cutSql(column, DISPLAY_NAME_LIMIT);
}

// accounts.note: '' past BIO_JSON_BYTES as a JSON string.
export function noteSql(column: string): string {
  return jsonBoundSql(column, BIO_JSON_BYTES, "''");
}

// accounts.url, avatar_url and header_url: NULL past PROFILE_URL_LIMIT.
export function profileUrlSql(column: string): string {
  return byteBoundSql(column, PROFILE_URL_LIMIT);
}

// statuses.content and status_edits.content: '' past CONTENT_JSON_BYTES as a JSON string. The status keeps its url,
// which links its original.
export function contentSql(column: string): string {
  return jsonBoundSql(column, CONTENT_JSON_BYTES, "''");
}

// statuses.source_text: '' past CONTENT_JSON_BYTES (a local one is at most 10,000 code units, 60 KB escaped).
export function sourceTextSql(column: string): string {
  return jsonBoundSql(column, CONTENT_JSON_BYTES, "''");
}

// statuses.spoiler_text and status_edits.spoiler_text: past SPOILER_JSON_BYTES, cut to the code points that fit
// however they escape (6 bytes each at most), so the warning stays.
export function spoilerSql(column: string): string {
  return jsonBoundSql(column, SPOILER_JSON_BYTES, `substr(${column}, 1, ${Math.floor((SPOILER_JSON_BYTES - 2) / 6)})`);
}

// statuses.url: NULL past STATUS_URL_LIMIT, so it reads as its uri.
export function statusUrlSql(column: string): string {
  return byteBoundSql(column, STATUS_URL_LIMIT);
}

// media_attachments.url and preview_url: NULL past MEDIA_URL_LIMIT, as an invalid one. url is NOT NULL, so its
// writer stores '' instead, which presentMedia shows as null.
export function mediaUrlSql(column: string): string {
  return byteBoundSql(column, MEDIA_URL_LIMIT);
}

// media_attachments.description: cut at MAX_MEDIA_DESCRIPTION_LENGTH code points.
export function mediaDescriptionSql(column: string): string {
  return cutSql(column, MAX_MEDIA_DESCRIPTION_LENGTH);
}

// media_attachments.meta: NULL past MEDIA_META_BYTES, as no meta.
export function mediaMetaSql(column: string): string {
  return byteBoundSql(column, MEDIA_META_BYTES);
}

// A poll's choices (polls.options, status_edits.poll_options) as a JSON array: the first MAX_REMOTE_OPTIONS, each cut
// at MAX_REMOTE_OPTION_LENGTH (cutSql); NULL (no poll) past POLL_OPTIONS_BYTES. A stored choice is longer only in a
// converted row; a vote names it as stored (polls.ts cut_options). An edit's snapshot stores P of the poll's choices,
// evaluated inside SQLite (statuses.ts recordEdit).
export function pollOptionsSql(column: string): string {
  return `CASE WHEN length(CAST(${column} AS BLOB)) <= ${POLL_OPTIONS_BYTES} THEN
		(SELECT json_group_array(${cutSql("value", MAX_REMOTE_OPTION_LENGTH)} ORDER BY key) FROM json_each(${column})
			WHERE key < ${MAX_REMOTE_OPTIONS}) END`;
}

// ---- Writers

const ENCODER = new TextEncoder();

// `value` when its UTF-8 bytes as SQLite stores it are at most `bytes` (a lone surrogate takes three bytes, as U+FFFD
// or as workerd binds it), else none.
function withinBytes(value: string | null, bytes: number): string | null {
  return value !== null && ENCODER.encode(value).length <= bytes ? value : null;
}

// Text as stored: well-formed and without U+0000. workerd binds a lone surrogate as its three-byte surrogate encoding,
// which reads back as three U+FFFD; replaced first, it is one U+FFFD either way. Mastodon's JSON parsing refuses
// invalid UTF-8, so nothing it would keep is lost. PostgreSQL text cannot hold U+0000, so Mastodon never stores one;
// SQLite's substr and length stop at it.
export function storedText(text: string): string {
  const wellFormed = text.toWellFormed();
  return wellFormed.includes("\u0000") ? wellFormed.replaceAll("\u0000", "") : wellFormed;
}

// The first `limit` code points of `text`. A string has at least as many code units as code points.
export function cutCodePoints(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  let points = 0;
  let end = 0;
  for (const char of text) {
    if (points === limit) {
      return text.slice(0, end);
    }
    points++;
    end += char.length;
  }
  return text;
}

// accounts.display_name as stored: storedText's output, at most DISPLAY_NAME_LIMIT code points.
export function storedDisplayName(text: string): string {
  return cutCodePoints(storedText(text), DISPLAY_NAME_LIMIT);
}

// media_attachments.description as stored: storedText's output, at most MAX_MEDIA_DESCRIPTION_LENGTH code points.
export function storedMediaDescription(text: string): string {
  return cutCodePoints(storedText(text), MAX_MEDIA_DESCRIPTION_LENGTH);
}

// accounts.url, avatar_url and header_url as stored: none past PROFILE_URL_LIMIT.
export function storedProfileUrl(url: string | null): string | null {
  return withinBytes(url, PROFILE_URL_LIMIT);
}

// statuses.url as stored: none past STATUS_URL_LIMIT.
export function storedStatusUrl(url: string | null): string | null {
  return withinBytes(url, STATUS_URL_LIMIT);
}

// media_attachments.preview_url as stored, and a media URL where none is a value: none past MEDIA_URL_LIMIT.
export function storedMediaLink(url: string | null): string | null {
  return withinBytes(url, MEDIA_URL_LIMIT);
}

// media_attachments.url as stored (NOT NULL): '' past MEDIA_URL_LIMIT. A row with a file token holds a URL Kopje
// built (platform/media-files.ts mediaUrl), always within it.
export function storedMediaUrl(url: string): string {
  return storedMediaLink(url) ?? "";
}

// media_attachments.meta as stored: none past MEDIA_META_BYTES.
export function storedMediaMeta(meta: string | null): string | null {
  return withinBytes(meta, MEDIA_META_BYTES);
}

// ---- Migration 0048_stored_bounds and its triggers

// A covered column: its projection P and, where P's value cannot be stored (a NOT NULL column), what is stored.
type StoredColumn = {
  column: string;
  projection: (column: string) => string;
  // A JSON-bounded column's bound: a value of at most a sixth of it (less the quotes) in UTF-8 bytes cannot escape past
  // it, so the test skips P (and json_quote) for it.
  jsonBytes?: number;
  stored?: (column: string) => string;
};

// The columns 0048_stored_bounds and its triggers cover. accounts.uri and username, statuses.uri, status_tags.name,
// polls.options and status_edits.media_json keep their read-time projections and are not here;
// media_attachments.blurhash has triggers of its own (0065_media_blurhash).
export const STORED_COLUMNS: Readonly<Record<string, readonly StoredColumn[]>> = {
  statuses: [
    { column: "content", projection: contentSql, jsonBytes: CONTENT_JSON_BYTES },
    { column: "spoiler_text", projection: spoilerSql, jsonBytes: SPOILER_JSON_BYTES },
    { column: "source_text", projection: sourceTextSql, jsonBytes: CONTENT_JSON_BYTES },
    { column: "url", projection: statusUrlSql },
  ],
  accounts: [
    { column: "display_name", projection: displayNameSql },
    { column: "note", projection: noteSql, jsonBytes: BIO_JSON_BYTES },
    { column: "url", projection: profileUrlSql },
    { column: "avatar_url", projection: profileUrlSql },
    { column: "header_url", projection: profileUrlSql },
  ],
  media_attachments: [
    // A row with a file token holds a URL mediaUrl (media-files.ts) built within the bound; the migration checks it.
    {
      column: "url",
      projection: mediaUrlSql,
      stored: (column) => `coalesce(${mediaUrlSql(column)}, '')`,
    },
    { column: "preview_url", projection: mediaUrlSql },
    { column: "description", projection: mediaDescriptionSql },
    { column: "meta", projection: mediaMetaSql },
  ],
  status_edits: [
    { column: "content", projection: contentSql, jsonBytes: CONTENT_JSON_BYTES },
    { column: "spoiler_text", projection: spoilerSql, jsonBytes: SPOILER_JSON_BYTES },
    { column: "poll_options", projection: pollOptionsSql },
  ],
};

// ---- Instance settings: migration 0049_instance_bounds and its triggers

// The instance's public settings (instance_settings rows, data rather than configuration: access-settings.ts
// CONFIG_KEYS). Each name has a projection P, the SQL value stored for a value, NULL where no row is stored, and a
// writer, its JS twin over storedText's output. The admin write (domain/instance.ts setInstanceSettings) refuses what
// its writer would change or drop; the cutover's conversion and verification store the writer's output and count
// what it changed (cli/lib/cutover). Reads take these rows as stored.

// title, in code points (at most 4 KiB): a label, cut past the bound. Mastodon sets no limit.
export const INSTANCE_TITLE_LIMIT = 1024;
// description, in code points: Mastodon's DESCRIPTION_LIMIT (app/models/form/admin_settings.rb:86,107), cut past it.
export const INSTANCE_DESCRIPTION_LIMIT = 200;
// contact_email, in UTF-8 bytes (RFC 5321's path limit); no row past it.
export const CONTACT_EMAIL_BYTES = 254;
// rules, a JSON array, in UTF-8 bytes; no row past it (a cut array is not JSON).
export const INSTANCE_RULES_BYTES = 65_536;
// extended_description, privacy_policy and terms_of_service, HTML in UTF-8 bytes; no row past it (a cut document
// loses its end). At most 50,000 UTF-16 code units too, so security/html.ts REMOTE_HTML_RAW_LIMIT never cuts one.
export const INSTANCE_DOCUMENT_BYTES = 50_000;

export const INSTANCE_DOCUMENTS = ["extended_description", "privacy_policy", "terms_of_service"] as const;
export type InstanceDocument = (typeof INSTANCE_DOCUMENTS)[number];

// show_domain_blocks and show_domain_blocks_rationale, as Mastodon's settings (config/settings.yml:29-30).
export const DOMAIN_BLOCKS_SHOWN = ["disabled", "users", "all"] as const;
export type DomainBlocksShown = (typeof DOMAIN_BLOCKS_SHOWN)[number];

// The characters a blank value consists of, SQL's and JS's alike: space, tab, LF, VT, FF and CR. Not String#trim's
// set, which SQLite's trim cannot list (it includes U+00A0, U+3000 and the other Unicode spaces).
const BLANK_CODES = [32, 9, 10, 11, 12, 13];
const BLANK = new Set(BLANK_CODES.map((code) => String.fromCharCode(code)));

export function isBlank(text: string): boolean {
  for (const char of text) {
    if (!BLANK.has(char)) {
      return false;
    }
  }
  return true;
}

// `text` without blank characters at either end.
export function trimBlank(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && BLANK.has(text[start] ?? "")) {
    start++;
  }
  while (end > start && BLANK.has(text[end - 1] ?? "")) {
    end--;
  }
  return text.slice(start, end);
}

function blankSql(column: string): string {
  return `trim(${column}, char(${BLANK_CODES.join(", ")})) = ''`;
}

// A calendar date, YYYY-MM-DD, as SQLite's date() writes it.
function isCalendarDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return false;
  }
  const parsed = new Date(`${text}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

// A time as Date#toISOString writes it for years 0 to 9999 (24 bytes), as SQLite's strftime('%Y-%m-%dT%H:%M:%fZ').
export function isIsoTime(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text)) {
    return false;
  }
  const parsed = new Date(text);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === text;
}

function isJsonArray(text: string): boolean {
  try {
    return Array.isArray(JSON.parse(text));
  } catch {
    return false;
  }
}

const ISO_TIME_FORMAT = "%Y-%m-%dT%H:%M:%fZ";

// A setting's projection P and writer. `cut`, for a name cut past its bound: the value 0049 rewrites it to before it
// deletes the rows whose P is NULL.
type InstanceSettingBound = {
  projection: (column: string) => string;
  writer: (value: string) => string | null;
  cut?: (column: string) => string;
};

// Text cut at `points` code points, and no row when blank.
function cutText(points: number): InstanceSettingBound {
  return {
    projection: (column) =>
      `CASE WHEN ${blankSql(cutSql(column, points))} THEN NULL ELSE ${cutSql(column, points)} END`,
    writer: (value) => {
      const cut = cutCodePoints(storedText(value), points);
      return isBlank(cut) ? null : cut;
    },
    cut: (column) => cutSql(column, points),
  };
}

// Text of at most `bytes` UTF-8 bytes, and no row when blank or past them.
function boundedText(bytes: number): InstanceSettingBound {
  return {
    projection: (column) =>
      `CASE WHEN length(CAST(${column} AS BLOB)) > ${bytes} THEN NULL WHEN ${blankSql(column)} THEN NULL ELSE ${column} END`,
    writer: (value) => {
      const text = withinBytes(storedText(value), bytes);
      return text === null || isBlank(text) ? null : text;
    },
  };
}

// One of `values`, else no row.
function oneOf(values: readonly string[]): InstanceSettingBound {
  return {
    projection: (column) => `CASE WHEN ${column} IN (${values.map((v) => `'${v}'`).join(", ")}) THEN ${column} END`,
    writer: (value) => (values.includes(value) ? value : null),
  };
}

const DOCUMENT = boundedText(INSTANCE_DOCUMENT_BYTES);
const SHOWN = oneOf(DOMAIN_BLOCKS_SHOWN);
// A document's stamp (the time an admin write changed it): written only by setInstanceSettings. SQLite's strftime
// writes an hour of 24 back as given, which Date#toISOString never writes.
// The acceptance rule of a stored time: 24 bytes, an hour below 24, and read back by strftime as itself.
function isoTimeAcceptedSql(column: string): string {
  return `length(CAST(${column} AS BLOB)) = 24 AND substr(${column}, 12, 2) < '24'
	AND strftime('${ISO_TIME_FORMAT}', ${column}) = ${column}`;
}

const STAMP: InstanceSettingBound = {
  projection: (column) => `CASE WHEN ${isoTimeAcceptedSql(column)} THEN ${column} END`,
  writer: (value) => (isIsoTime(value) ? value : null),
};

// Every bounded name. Other names (CONFIG_KEYS, the instance actor's key, the web client) are not covered.
export const INSTANCE_SETTING_BOUNDS = {
  title: cutText(INSTANCE_TITLE_LIMIT),
  description: cutText(INSTANCE_DESCRIPTION_LIMIT),
  contact_email: boundedText(CONTACT_EMAIL_BYTES),
  rules: {
    projection: (column) =>
      `CASE WHEN length(CAST(${column} AS BLOB)) > ${INSTANCE_RULES_BYTES} THEN NULL
	WHEN json_valid(${column}) THEN CASE WHEN json_type(${column}) = 'array' THEN ${column} END END`,
    writer: (value) => {
      const text = withinBytes(storedText(value), INSTANCE_RULES_BYTES);
      return text !== null && isJsonArray(text) ? text : null;
    },
  },
  extended_description: DOCUMENT,
  privacy_policy: DOCUMENT,
  terms_of_service: DOCUMENT,
  terms_of_service_effective_date: {
    projection: (column) =>
      `CASE WHEN length(CAST(${column} AS BLOB)) = 10 AND ${column} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
	AND date(${column}) = ${column} THEN ${column} END`,
    writer: (value) => (isCalendarDate(value) ? value : null),
  },
  show_domain_blocks: SHOWN,
  show_domain_blocks_rationale: SHOWN,
  extended_description_updated_at: STAMP,
  privacy_policy_updated_at: STAMP,
} as const satisfies Record<string, InstanceSettingBound>;

export type InstanceSettingName = keyof typeof INSTANCE_SETTING_BOUNDS;

export const INSTANCE_SETTING_NAMES = Object.keys(INSTANCE_SETTING_BOUNDS) as InstanceSettingName[];

// The value `name` stores for `value` (storedText's output where it is text), or null for no row.
export function storedInstanceSetting(name: InstanceSettingName, value: string): string | null {
  return INSTANCE_SETTING_BOUNDS[name].writer(value);
}

// ---- Custom emoji snapshots: migration 0053_custom_emoji_snapshots and its triggers

// statuses.emojis, status_edits.emojis and accounts.emojis (RES-2): NULL, or a JSON array of [shortcode, url] pairs in
// tag order, written by domain/custom-emojis.ts emojiSnapshot and presented by its presentEmojis. A shortcode matches
// EMOJI_SHORTCODE, as Mastodon's MAX_SHORTCODE_SIZE (app/models/custom_emoji.rb:29) and Misskey's name column
// (models/Emoji.ts) bound it; a url is http(s), at most EMOJI_URL_LIMIT bytes and within EMOJI_URL_ALPHABET, so a
// presented entry needs no JSON escape. A boost row's value is never read (status-rows.ts STATUS_COLUMN_MAP).
export const EMOJI_SHORTCODE = /^[A-Za-z0-9_+-]{1,128}$/;
export const EMOJI_SHORTCODE_LIMIT = 128;
// In UTF-8 bytes of the normalized href: Misskey's url columns hold 512 characters (models/Emoji.ts).
export const EMOJI_URL_LIMIT = 512;
// '!' to '~' but '"' and '\': a literal '\' can survive WHATWG normalization in a query or fragment.
export const EMOJI_URL_ALPHABET = /^[!#-[\]-~]+$/;
// Emoji tags examined per object (RES-1), and entries per snapshot.
export const MAX_EMOJI_TAGS = 64;
export const MAX_EMOJIS = 64;
// The presented JSON bytes of Status.emojis (and StatusEdit's, and a Poll's, a subset) and of Account.emojis; also the
// stored UTF-8 bytes of the columns. Entries are {"shortcode":n,"url":u,"static_url":u,"visible_in_picker":true}.
// For shortcode length n and URL length u, a nonempty presented array occupies
// 1 + Σ(EMOJI_ENTRY_BYTES + n + 2u) bytes, including separators (presentedEmojiBytes).
export const STATUS_EMOJIS_BYTES = 12_288;
export const ACCOUNT_EMOJIS_BYTES = 6_144;
export const EMOJI_ENTRY_BYTES = 67;

// The cached copies of a remote snapshot's emoji, read with its row (domain/remote-media.ts, MEDIA-7): for its first
// EMOJI_CACHE_LIMIT entries in snapshot order, those whose (domain, url) slot holds a stored file, a JSON array of
// [entry index, packed object] (token:ext:still_ext, at most 74 bytes); '[]' when none is cached, NULL for a local or
// empty snapshot. The limit is the Store's memory bound (RES-3): an entry past it, or one not cached, keeps its remote
// URL. Read through remote_media_emoji, one seek an entry. domain/custom-emojis.ts presents what it holds.
export const EMOJI_CACHE_LIMIT = 16;
// At most `[15,"<74>"]` and its separator an entry, and the brackets.
export const EMOJI_CACHE_BYTES = 2 + EMOJI_CACHE_LIMIT * 82;
export function emojiCacheSql(snapshot: string, domain: string): string {
  return `CASE WHEN ${domain} IS NOT NULL AND ${snapshot} IS NOT NULL THEN (SELECT json_group_array(json_array(ee.key,
		ce.token || ':' || ce.ext || ':' || COALESCE(ce.still_ext, ''))) FROM json_each(${snapshot}) ee
		CROSS JOIN remote_media ce INDEXED BY ${REMOTE_MEDIA_EMOJI_INDEX} ON ce.kind = 'emoji' AND ce.domain = ${domain}
			AND ce.url = json_extract(ee.value, '$[1]')
		WHERE ee.key < ${EMOJI_CACHE_LIMIT} AND ce.token IS NOT NULL) END`;
}

// The remote media category of an attachment's type (a slot's `category`): image, video (gifv too) or audio; NULL for
// unknown, which is never cached. remoteMediaCategory is the same rule in code.
export function mediaCategorySql(type: string): string {
  return `CASE ${type} WHEN 'image' THEN 'image' WHEN 'gifv' THEN 'video' WHEN 'video' THEN 'video' WHEN 'audio' THEN 'audio' END`;
}

export function remoteMediaCategory(type: string): "image" | "video" | "audio" | null {
  return type === "image" ? "image" : type === "gifv" || type === "video" ? "video" : type === "audio" ? "audio" : null;
}

// The window of a status's attachment rows (`status` its id's SQL) its removal reads for cache slots at a time:
// MEDIA_SLOT_WINDOW of them, local uploads included, as media_attachments_status holds them, so what is read stays
// bounded however many rows of either kind the status has; the conditions are judged inside it. The removal's media
// steps take rows from the same front (inbox.ts STATUS_CHILDREN), so the window moves as they go.
export const MEDIA_SLOT_WINDOW = 64;
export function statusMediaWindowSql(status: string): string {
  return `SELECT id, file_token FROM media_attachments INDEXED BY media_attachments_status WHERE status_id = ${status}
		LIMIT ${MEDIA_SLOT_WINDOW}`;
}

// Whether the slot `r` is the current one of the remote attachment row `m`: its file (kind attachment, the row's url
// and the category of its current type) or its icon (kind thumbnail, the row's preview_url), byte for byte. The one
// rule the cache's eligibility (domain/remote-media.ts slotOwnsSql) and the presenter (mediaCacheSql) share.
export function mediaSlotOwnsSql(r: string, m: string): string {
  return `(${m}.file_token IS NULL AND ${m}.account_id = ${r}.account_id
		AND CASE ${r}.kind
			WHEN 'attachment' THEN CAST(${m}.url AS BLOB) = CAST(${r}.url AS BLOB) AND ${mediaCategorySql(`${m}.type`)} = ${r}.category
			WHEN 'thumbnail' THEN CAST(${m}.preview_url AS BLOB) = CAST(${r}.url AS BLOB)
			ELSE 0 END)`;
}

// The cached copy of the remote attachment row `m`'s `kind` (its file, or its icon) as a packed object
// (token:ext:still_ext, at most 74 bytes), or NULL: its slot through remote_media_owner, one seek, while it is the
// current one (mediaSlotOwnsSql) and holds a stored file. Read with the row (status-rows.ts STATUS_MEDIA_COLUMN_MAP).
export function mediaCacheSql(m: string, kind: "attachment" | "thumbnail"): string {
  return `(SELECT rc.token || ':' || rc.ext || ':' || COALESCE(rc.still_ext, '') FROM remote_media rc
		INDEXED BY ${REMOTE_MEDIA_OWNER_INDEX} WHERE rc.owner_id = ${m}.id AND rc.kind = '${kind}' AND rc.token IS NOT NULL
			AND ${mediaSlotOwnsSql("rc", m)})`;
}

// The presented JSON bytes of `pairs` as Status.emojis: none needs an escape (EMOJI_SHORTCODE, EMOJI_URL_ALPHABET).
export function presentedEmojiBytes(pairs: readonly (readonly [string, string])[]): number {
  return pairs.length === 0
    ? 2
    : 1 + pairs.reduce((sum, [n, u]) => sum + EMOJI_ENTRY_BYTES + n.length + 2 * u.length, 0);
}

// Whether `url` may be stored and presented as an emoji's: http(s), within EMOJI_URL_LIMIT and EMOJI_URL_ALPHABET.
export function isEmojiUrl(url: string): boolean {
  return url.length <= EMOJI_URL_LIMIT && EMOJI_URL_ALPHABET.test(url) && /^https?:\/\/./.test(url);
}

// The JS twin of emojisPastBoundSql: whether `text`, as stored, is a snapshot within `bytes` (NULL is).
export function emojisValid(text: string | null, bytes: number): boolean {
  if (text === null) {
    return true;
  }
  if (text.includes("\u0000") || new TextEncoder().encode(text).length > bytes) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > MAX_EMOJIS) {
    return false;
  }
  const names = new Set<string>();
  const pairs: [string, string][] = [];
  for (const entry of parsed as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      return false;
    }
    const [name, url] = entry as unknown[];
    if (typeof name !== "string" || typeof url !== "string" || !EMOJI_SHORTCODE.test(name) || !isEmojiUrl(url)) {
      return false;
    }
    if (names.has(name)) {
      return false;
    }
    names.add(name);
    pairs.push([name, url]);
  }
  return presentedEmojiBytes(pairs) <= bytes;
}

// True when `column` holds a value emojisValid refuses: false for NULL, true for a value that is not text. Judged as
// stored: the byte bound first, so nothing else scans a value past it; then a raw NUL anywhere (SQLite's JSON
// functions stop at one, so a complete value followed by NUL and anything would pass them); then the shape, each
// element (`->>` decodes escapes, and a decoded name or url whose bytes and characters differ holds a NUL or a
// non-ASCII character), the names once each, and the presented size.
export function emojisPastBoundSql(column: string, bytes: number): string {
  const name = "e.value ->> '$[0]'";
  const url = "e.value ->> '$[1]'";
  const element = `CASE WHEN e.type <> 'array' THEN 1
		WHEN json_array_length(e.value) <> 2 THEN 1
		WHEN json_type(e.value, '$[0]') <> 'text' OR json_type(e.value, '$[1]') <> 'text' THEN 1
		WHEN length(CAST(${name} AS BLOB)) NOT BETWEEN 1 AND ${EMOJI_SHORTCODE_LIMIT} THEN 1
		WHEN length(CAST(${name} AS BLOB)) <> length(${name}) THEN 1
		WHEN ${name} GLOB '*[^A-Za-z0-9_+-]*' THEN 1
		WHEN length(CAST(${url} AS BLOB)) > ${EMOJI_URL_LIMIT} THEN 1
		WHEN length(CAST(${url} AS BLOB)) <> length(${url}) THEN 1
		WHEN NOT (${url} GLOB 'https://?*' OR ${url} GLOB 'http://?*') THEN 1
		WHEN ${url} GLOB '*[^!-~]*' OR ${url} GLOB '*["\\]*' THEN 1
		ELSE 0 END`;
  return `CASE WHEN ${column} IS NULL THEN 0
	WHEN typeof(${column}) <> 'text' THEN 1
	WHEN length(CAST(${column} AS BLOB)) > ${bytes} THEN 1
	WHEN instr(CAST(${column} AS BLOB), X'00') > 0 THEN 1
	WHEN NOT json_valid(${column}) THEN 1
	WHEN json_type(${column}) <> 'array' THEN 1
	WHEN json_array_length(${column}) NOT BETWEEN 1 AND ${MAX_EMOJIS} THEN 1
	WHEN EXISTS (SELECT 1 FROM json_each(${column}) e WHERE ${element}) THEN 1
	WHEN (SELECT count(DISTINCT ${name}) FROM json_each(${column}) e) <> json_array_length(${column}) THEN 1
	WHEN 1 + (SELECT sum(${EMOJI_ENTRY_BYTES} + length(${name}) + 2 * length(${url})) FROM json_each(${column}) e)
		> ${bytes} THEN 1
	ELSE 0 END`;
}

// The snapshot columns and their stored bounds.
export const EMOJI_COLUMNS: Readonly<Record<"statuses" | "status_edits" | "accounts", number>> = {
  statuses: STATUS_EMOJIS_BYTES,
  status_edits: STATUS_EMOJIS_BYTES,
  accounts: ACCOUNT_EMOJIS_BYTES,
};

// ---- Local custom emoji: migration 0055_local_custom_emojis

// custom_emojis.shortcode (RES-2): 2 to 128 ASCII letters, digits and underscores, as Mastodon's SHORTCODE_ONLY_RE,
// MINIMUM_SHORTCODE_SIZE and MAX_SHORTCODE_SIZE for a local emoji (app/models/custom_emoji.rb:28-38, 50-51). A subset
// of EMOJI_SHORTCODE, so a local snapshot passes the 0053 triggers.
export const LOCAL_EMOJI_SHORTCODE = /^[A-Za-z0-9_]{2,128}$/;
// custom_emojis.category: at most this many code points within EMOJI_CATEGORY_BYTES UTF-8 bytes, with no C0 control
// or DEL. The CHECK bounds the stored bytes only: SQLite cannot judge UTF-8 well-formedness, so presentedCategory
// judges the decoded value again.
export const EMOJI_CATEGORY_LENGTH = 64;
export const EMOJI_CATEGORY_BYTES = 256;
// Enabled local emoji at most (RES-3: the whole list is one answer); disabled ones are not counted.
export const MAX_ENABLED_EMOJIS = 1000;

// oxlint-disable-next-line no-control-regex
const CATEGORY_CONTROL = /[\u0000-\u001f\u007f]/;

// Whether `items` (a string's code points, a segmenter's graphemes) yields more than `max`, reading no further than the
// one past it.
export function yieldsMoreThan(items: Iterable<unknown>, max: number): boolean {
  const iterator = items[Symbol.iterator]();
  for (let count = 0; !iterator.next().done;) {
    if (++count > max) {
      return true;
    }
  }
  return false;
}

// Whether `text`, as decoded, is a category that may be stored and presented: well-formed, 1 to EMOJI_CATEGORY_LENGTH
// code points within EMOJI_CATEGORY_BYTES UTF-8 bytes, and no C0 control or DEL.
export function isEmojiCategory(text: string): boolean {
  if (text === "" || text.length > EMOJI_CATEGORY_BYTES || !text.isWellFormed() || CATEGORY_CONTROL.test(text)) {
    return false;
  }
  if (yieldsMoreThan(text, EMOJI_CATEGORY_LENGTH)) {
    return false;
  }
  return ENCODER.encode(text).length <= EMOJI_CATEGORY_BYTES;
}

// A category from the admin API: made well-formed (workerd stores a bound lone surrogate as its three-byte encoding,
// which no check of the stored bytes would see), trimmed, then judged. null for an empty value (no category);
// undefined when it is refused.
export function storedEmojiCategory(raw: string): string | null | undefined {
  const text = raw.toWellFormed().trim();
  if (text === "") {
    return null;
  }
  return isEmojiCategory(text) ? text : undefined;
}

// A stored category as it is presented: the value when isEmojiCategory holds for it as decoded, else none (an
// imported value of malformed UTF-8 can pass the CHECK and decode to more, or to replacement characters).
export function presentedCategory(stored: string | null): string | null {
  return stored !== null && isEmojiCategory(stored) ? stored : null;
}

// ---- Announcements: migration 0056_announcements

// announcements.text (RES-1, RES-2): plain text as the Access admin wrote it, 1 to ANNOUNCEMENT_TEXT_BYTES UTF-8 bytes,
// with no NUL, not blank. A text within the bytes decodes to at most as many UTF-16 code units (a malformed byte
// becomes one U+FFFD), so it never passes status-text.ts MAX_RAW_LENGTH when presented.
export const ANNOUNCEMENT_TEXT_BYTES = 10_000;
// Announcements at most, and published or scheduled ones at most (RES-3, RES-4: the list holds every published one).
export const MAX_ANNOUNCEMENTS = 1000;
export const MAX_LIVE_ANNOUNCEMENTS = 16;
// announcement_reactions.name, in UTF-8 bytes, judged before the emoji pattern runs (RES-2); names per announcement
// (Mastodon's ReactionValidator::LIMIT).
export const REACTION_NAME_BYTES = 128;
export const MAX_REACTION_NAMES = 8;

// Plain text an admin write stores, or null when it is refused: made well-formed (a bound lone surrogate would be
// stored as its three-byte encoding), then refused when it holds a NUL or its UTF-8 passes `bytes` (a string of more
// code units than `bytes` passes them without being encoded).
function adminPlainText(raw: string, bytes: number): string | null {
  const text = raw.toWellFormed();
  if (text.includes("\u0000") || text.length > bytes) {
    return null;
  }
  return ENCODER.encode(text).length <= bytes ? text : null;
}

// The text an announcement stores, or null when it is refused: adminPlainText's, also refused when blank after
// JavaScript's trim (which removes every character SQLite's ASCII trim of the CHECK does, and Unicode spaces).
export function storedAnnouncementText(raw: string): string | null {
  const text = adminPlainText(raw, ANNOUNCEMENT_TEXT_BYTES);
  return text === null || text.trim() === "" ? null : text;
}

// ---- Trends: migration 0057_trends

// trend_tags and trend_statuses rows at most: TREND_ALLOWED_ROWS the round keeps allowed and TREND_REVIEW_POOL awaiting
// review or rejected (RES-4); TREND_STATUSES_PER_AUTHOR rows of one author; decisions per review table.
export const TREND_ALLOWED_ROWS = 200;
export const TREND_REVIEW_POOL = 50;
export const MAX_TREND_TAGS = TREND_ALLOWED_ROWS + TREND_REVIEW_POOL;
export const MAX_TREND_STATUSES = TREND_ALLOWED_ROWS + TREND_REVIEW_POOL;
export const TREND_STATUSES_PER_AUTHOR = 3;
export const MAX_TREND_REVIEWS = 10_000;
// A stored score and peak at most (the round clamps what it scores; RES-2).
export const TREND_SCORE_MAX = 1e15;
// A trend or review tag name (RES-2): 1 to TREND_TAG_NAME_BYTES UTF-8 bytes, no NUL, at most TREND_TAG_NAME_LENGTH
// characters as SQLite's length counts them, and no ASCII but what a normalized hashtag holds (0-9, _ and a-z;
// tag-name.ts normalizeTag). The GLOB pattern is 14 bytes (workerd refuses one over 50).
export const TREND_TAG_NAME_BYTES = 1024;
export const TREND_TAG_NAME_LENGTH = 256;

// The name rule over `column`, as the CHECKs of 0057 write it and the round filters a status's hashtags with it.
export function trendTagNameCheckSql(column: string): string {
  return `typeof(${column}) = 'text' AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND ${TREND_TAG_NAME_BYTES}
    AND instr(CAST(${column} AS BLOB), x'00') = 0 AND length(${column}) <= ${TREND_TAG_NAME_LENGTH}
    AND ${column} NOT GLOB ('*[' || char(1) || '-/:-^\`{-' || char(127) || ']*')`;
}

// The trends settings (Mastodon's `trends` and `trendable_by_default`, config/settings.yml), 'true' or 'false', bound
// by the triggers of 0057 rather than 0049's.
export const TREND_SETTING_BOUNDS = {
  trends: oneOf(["true", "false"]),
  trendable_by_default: oneOf(["true", "false"]),
} as const satisfies Record<string, InstanceSettingBound>;

export type TrendSettingName = keyof typeof TREND_SETTING_BOUNDS;

// ---- The contact account and activity: migration 0059_contact_and_activity

// contact_username (Mastodon's site_contact_username, config/settings.yml): the address of an account Kopje knows,
// `username` for a local one or `username@domain`, as the admin write stores it (domain/instance.ts). In UTF-8 bytes:
// a username of at most REMOTE_USERNAME_LIMIT (identity-bounds.ts, repeated here; test/stored-bounds.test.ts pins
// them equal), `@` and a domain name of at most 253. P checks the storage class, then the bytes, then NUL, then the
// structure: only ASCII letters, digits and `-._@`, one `@` at most and at neither end, and a username part of at most
// REMOTE_USERNAME_LIMIT bytes. Each GLOB pattern is at most 19 bytes (workerd refuses one over 50).
export const CONTACT_USERNAME_LIMIT = 255;
export const CONTACT_USERNAME_BYTES = CONTACT_USERNAME_LIMIT + 1 + 253;

const CONTACT_ALPHABET = /^[-.0-9@A-Z_a-z]+$/;

// True when a text `column` (no NUL, within the bytes) breaks the structure: a character outside the alphabet, `@` at
// either end or more than one, or a username part past CONTACT_USERNAME_LIMIT. CASE-free, for the migration's DELETE.
function contactStructurePastSql(column: string): string {
  return `${column} = '' OR ${column} GLOB '*[^-.0-9@A-Z_a-z]*' OR ${column} GLOB '@*' OR ${column} GLOB '*@'
	OR ${column} GLOB '*@*@*'
	OR (instr(${column}, '@') = 0 AND length(${column}) > ${CONTACT_USERNAME_LIMIT})
	OR instr(${column}, '@') - 1 > ${CONTACT_USERNAME_LIMIT}`;
}

function contactUsernameSql(column: string): string {
  return `CASE WHEN typeof(${column}) <> 'text' THEN NULL
	WHEN length(CAST(${column} AS BLOB)) > ${CONTACT_USERNAME_BYTES} THEN NULL
	WHEN instr(CAST(${column} AS BLOB), x'00') > 0 THEN NULL
	WHEN ${contactStructurePastSql(column)} THEN NULL
	ELSE ${column} END`;
}

// True when `column` is not a fixed point of P (P(x) IS NOT x), written without CASE so a migration's DELETE may use it
// (test/migration-lint.test.ts); test/stored-bounds.test.ts holds the two equal.
export function contactUsernamePastBoundSql(column: string): string {
  return `${column} IS NOT NULL AND (typeof(${column}) <> 'text'
	OR length(CAST(${column} AS BLOB)) > ${CONTACT_USERNAME_BYTES}
	OR instr(CAST(${column} AS BLOB), x'00') > 0
	OR ${contactStructurePastSql(column)})`;
}

// P's JS twin: the value itself, or null where P is NULL.
export function storedContactUsername(value: string): string | null {
  if (ENCODER.encode(value).length > CONTACT_USERNAME_BYTES || !CONTACT_ALPHABET.test(value)) {
    return null;
  }
  const parts = value.split("@");
  return parts.length > 2 || parts.some((part) => part === "") || parts[0]!.length > CONTACT_USERNAME_LIMIT
    ? null
    : value;
}

// Bound by the triggers of 0059 rather than 0049's or 0057's.
export const CONTACT_SETTING_BOUNDS = {
  contact_username: { projection: contactUsernameSql, writer: storedContactUsername },
} as const satisfies Record<string, InstanceSettingBound>;

export type ContactSettingName = keyof typeof CONTACT_SETTING_BOUNDS;

// Mastodon's `activity_api_enabled` (config/settings.yml), 'true' or 'false', bound by the triggers of 0072;
// no row reads as 'true', Mastodon's default.
export const ACTIVITY_SETTING_BOUNDS = {
  activity_api_enabled: oneOf(["true", "false"]),
} as const satisfies Record<string, InstanceSettingBound>;

type ActivitySettingName = keyof typeof ACTIVITY_SETTING_BOUNDS;

export type StoredSettingName = InstanceSettingName | TrendSettingName | ContactSettingName | ActivitySettingName;

function settingBound(name: StoredSettingName): InstanceSettingBound {
  if (name in TREND_SETTING_BOUNDS) {
    return TREND_SETTING_BOUNDS[name as TrendSettingName];
  }
  if (name in ACTIVITY_SETTING_BOUNDS) {
    return ACTIVITY_SETTING_BOUNDS[name as ActivitySettingName];
  }
  return name in CONTACT_SETTING_BOUNDS
    ? CONTACT_SETTING_BOUNDS[name as ContactSettingName]
    : INSTANCE_SETTING_BOUNDS[name as InstanceSettingName];
}

// The value `name` stores for `value` (null: no row), through 0049's bounds, 0057's, 0059's or 0072's.
export function storedSetting(name: StoredSettingName, value: string): string | null {
  return settingBound(name).writer(value);
}

// The projection of a stored setting `name` over `column`, through 0049's bounds, 0057's, 0059's or 0072's.
export function settingProjectionSql(name: StoredSettingName, column: string): string {
  return settingBound(name).projection(column);
}

// The UTC day of `now` as the CHECKs of 0059 (active_on) and 0072 (the activity tables) accept it (text of 10 bytes,
// no NUL, a calendar date YYYY-MM-DD that date() reads back as itself), or null for a time outside the years 0 to 9999.
export function utcDay(now: number): string | null {
  const date = new Date(now);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const day = date.toISOString().slice(0, 10);
  return isCalendarDate(day) ? day : null;
}

// A stored time read as the 24-byte ISO form Kopje writes (hour 00 to 23, read back by strftime as itself), else NULL:
// the bytes judged before strftime reads the value, so a long imported value costs one length.
export function isoTimeSql(column: string): string {
  return `(${STAMP.projection(column)})`;
}

// ---- Profile credentials: migration 0058_profile_credentials

// accounts.indexable as stored: NULL (a remote account not stored again since 0058), or the integer 0 or 1. True when
// `column` holds anything else: the type first (an integer has no bytes to bound or NUL to hold), then the value.
export function indexablePastBoundSql(column: string): string {
  return `CASE WHEN ${column} IS NULL THEN 0
	WHEN typeof(${column}) <> 'integer' THEN 1
	WHEN ${column} NOT IN (0, 1) THEN 1
	ELSE 0 END`;
}

// ---- Account moves: migration 0060_account_moves

// accounts.moved_to_account_id: NULL, or the 18-digit id of another account, on a remote row only (Mastodon's
// Account#moved_to_account_id, set from the actor document's movedTo and by a verified Move: domain/inbox.ts). No
// foreign key holds it: the purge of a remote account clears the references to it first (PURGED_ACCOUNT_REFERENCES in
// domain/inbox.ts). True when `NEW` holds anything else, judged in order: the storage class, the bytes, NUL, the
// structure (digits only), then the row (another account's id, and a remote row).
export const MOVED_TO_ID_BYTES = 18;

export function movedToPastBoundSql(row: string): string {
  const column = `${row}.moved_to_account_id`;
  return `CASE WHEN ${column} IS NULL THEN 0
	WHEN typeof(${column}) <> 'text' THEN 1
	WHEN length(CAST(${column} AS BLOB)) <> ${MOVED_TO_ID_BYTES} THEN 1
	WHEN instr(CAST(${column} AS BLOB), x'00') > 0 THEN 1
	WHEN ${column} GLOB '*[^0-9]*' THEN 1
	WHEN ${column} = ${row}.id THEN 1
	WHEN ${row}.domain IS NULL THEN 1
	ELSE 0 END`;
}

// The partial index the purge's clearing step and completion check seek references through.
export const MOVED_TO_INDEX = "accounts_moved_to";

// ---- Account static images: migration 0061_account_static_images

// accounts.avatar_static_url and header_static_url: NULL ("the same as the image"), or the still preview URL of the
// upload the image names (domain/media.ts profileAssignSql), in UTF-8 bytes. Kopje's preview URLs are mediaUrl's
// (platform/media-files.ts): 'https://', a host of at most 253 bytes, ':65535', '/media/', a token of at most 64 bytes
// and '/small.webp' make at most 349, so a longer one is not copied and the account shows its image.
export const STATIC_URL_LIMIT = 512;

// The WHEN lines that judge one stored static value, in order: the storage class (TEXT affinity stores a number as
// its text, so only a BLOB is refused), the raw bytes (an imported value may be malformed UTF-8, which length counts
// as fewer characters), then NUL.
function staticValueCases(value: string): string {
  return `WHEN ${value} IS NULL THEN 0
	WHEN typeof(${value}) <> 'text' THEN 1
	WHEN length(CAST(${value} AS BLOB)) > ${STATIC_URL_LIMIT} THEN 1
	WHEN instr(CAST(${value} AS BLOB), x'00') > 0 THEN 1`;
}

// True when `value` is no static value accounts may store: what the writer judges before it copies a preview URL.
export function staticUrlPastBoundSql(value: string): string {
  return `CASE ${staticValueCases(value)}
	ELSE 0 END`;
}

// True when `row` holds a static past its stored bound, or one where the structure allows none: on a remote row (a
// remote document never sets one, ID-3), or without its image.
export function staticImagesPastBoundSql(row: string): string {
  return (["avatar", "header"] as const)
    .map(
      (image) => `CASE ${staticValueCases(`${row}.${image}_static_url`)}
	WHEN ${row}.domain IS NOT NULL THEN 1
	WHEN ${row}.${image}_url IS NULL THEN 1
	ELSE 0 END`,
    )
    .join("\n\tOR ");
}

// ---- Account warnings: migrations 0062_account_warnings and 0063_account_warning_notifications_key

// account_warnings.text (RES-1, RES-2): the admin's plain text as sent, at most WARNING_TEXT_BYTES UTF-8 bytes with no
// NUL; empty when none was sent. Mastodon sets no bound (and a NUL is its 500). Within the bytes it decodes to at most
// as many UTF-16 code units, a malformed byte becoming one U+FFFD.
export const WARNING_TEXT_BYTES = 10_000;
// account_warnings.status_ids: NULL, or a JSON array of at most WARNING_STATUS_IDS 18-digit status ids (the report's
// own bound, MAX_REPORT_STATUSES in domain/reports.ts), so at most WARNING_STATUS_IDS_BYTES of '[', ']', the quoted ids
// and their commas.
export const WARNING_STATUS_IDS = 100;
export const WARNING_STATUS_ID_BYTES = 18;
export const WARNING_STATUS_IDS_BYTES = 2 + WARNING_STATUS_IDS * (WARNING_STATUS_ID_BYTES + 3) - 1;

// The text an admin action stores (adminPlainText at WARNING_TEXT_BYTES), or null when it is refused (422).
export function storedWarningText(raw: string): string | null {
  return adminPlainText(raw, WARNING_TEXT_BYTES);
}

const WARNING_STATUS_ID = /^[0-9]{18}$/;

// The writer twin of warningStatusIdsPastBoundSql: the ids of stored status_ids, or null for none or when the rule
// refuses them (a restored report is bound only by its own CHECK, which does not judge the elements; a warning's own
// are held by its triggers, so the presenter never throws on one). Judged in the trigger's order: bytes, NUL, JSON,
// array, length, elements.
export function warningStatusIdsOf(raw: string | null): string[] | null {
  if (raw === null || raw.length > WARNING_STATUS_IDS_BYTES || raw.includes("\u0000")) {
    return null;
  }
  if (ENCODER.encode(raw).length > WARNING_STATUS_IDS_BYTES) {
    return null;
  }
  let ids: unknown;
  try {
    ids = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(ids) || ids.length > WARNING_STATUS_IDS) {
    return null;
  }
  return ids.every((id): id is string => typeof id === "string" && WARNING_STATUS_ID.test(id)) ? ids : null;
}

// The status_ids a warning stores for a report's stored status_ids, as JSON.stringify writes the ids warningStatusIdsOf
// accepts (within the bytes when they pass), or null.
export function storedWarningStatusIds(raw: string | null): string | null {
  const ids = warningStatusIdsOf(raw);
  return ids === null ? null : JSON.stringify(ids);
}

// True when `column` holds status_ids past the bound, judged in order: the scalar parts the table's CHECK holds too
// (the storage class, the raw bytes, NUL, the JSON structure), then every element an 18-digit decimal id as TEXT,
// judged on its decoded bytes, then NUL (a JSON escape decodes to a NUL that GLOB stops at), then digits (a CHECK may
// not read json_each, so triggers judge the elements, as 0053 does).
export function warningStatusIdsPastBoundSql(column: string): string {
  return `CASE WHEN ${column} IS NULL THEN 0
	WHEN typeof(${column}) <> 'text' THEN 1
	WHEN length(CAST(${column} AS BLOB)) > ${WARNING_STATUS_IDS_BYTES} THEN 1
	WHEN instr(CAST(${column} AS BLOB), x'00') > 0 THEN 1
	WHEN NOT json_valid(${column}) THEN 1
	WHEN json_type(${column}) <> 'array' THEN 1
	WHEN json_array_length(${column}) > ${WARNING_STATUS_IDS} THEN 1
	WHEN EXISTS (SELECT 1 FROM json_each(${column}) e WHERE e.type <> 'text'
		OR length(CAST(e.value AS BLOB)) <> ${WARNING_STATUS_ID_BYTES} OR instr(CAST(e.value AS BLOB), x'00') > 0
		OR e.value GLOB '*[^0-9]*') THEN 1
	ELSE 0 END`;
}

// ---- Status applications: migration 0064_status_applications

// statuses.application_id: NULL, or the client_id of the app a local original was posted through (Mastodon's
// Status#application_id, AUTH-6: the credential's client), in UTF-8 bytes. Kopje's client ids are 43 base64url
// characters (security/tokens.ts randomToken) and a converted legacy client's a UUID, so 64 holds both. No foreign key
// holds it (Mastodon has none, schema.rb): removing an app writes no status row, and an id whose app is gone reads as
// no app (RES-6). True when `row` holds anything else, judged in order: the storage class, the bytes, NUL, the
// structure (base64url characters), then the row (a boost, or a remote author: Mastodon records an app on neither).
export const APP_ID_BYTES = 64;
const APP_ID = new RegExp(`^[A-Za-z0-9_-]{1,${APP_ID_BYTES}}$`);

export function applicationIdPastBoundSql(row: string): string {
  const column = `${row}.application_id`;
  return `CASE WHEN ${column} IS NULL THEN 0
	WHEN typeof(${column}) <> 'text' THEN 1
	WHEN length(CAST(${column} AS BLOB)) NOT BETWEEN 1 AND ${APP_ID_BYTES} THEN 1
	WHEN instr(CAST(${column} AS BLOB), x'00') > 0 THEN 1
	WHEN ${column} GLOB '*[^0-9A-Za-z_-]*' THEN 1
	WHEN ${row}.reblog_of_id IS NOT NULL THEN 1
	WHEN (SELECT a.domain FROM accounts a WHERE a.id = ${row}.account_id) IS NOT NULL THEN 1
	ELSE 0 END`;
}

// The application_id a local original stores for the client `value`: it when the bound's value cases accept it, else
// none (the post is written without an app rather than refused).
export function storedApplicationId(value: unknown): string | null {
  return typeof value === "string" && APP_ID.test(value) ? value : null;
}

// The bounds of an app's name and website as a status presents them (REST::StatusSerializer's application).
// A name: APP_NAME_LIMIT code points (Mastodon's ApplicationExtension APP_NAME_LIMIT), so at most APP_NAME_BYTES UTF-8
// bytes and APP_NAME_JSON_BYTES as a JSON string. A website: APP_WEBSITE_LIMIT UTF-8 bytes (isAppWebsite).
export const APP_NAME_LIMIT = 60;
export const APP_NAME_BYTES = 4 * APP_NAME_LIMIT;
export const APP_NAME_JSON_BYTES = 6 * APP_NAME_LIMIT + 2;
export const APP_WEBSITE_LIMIT = 2000;
export const APP_WEBSITE_JSON_BYTES = 2 * APP_WEBSITE_LIMIT + 2;

// The characters no app website may hold, those that end or split an HTML attribute or a URL in common parsers: C0
// controls, the space, DEL, C1 controls (U+0085 NEL is not in \s), other whitespace (\s), and " ' < > \ ^ ` { | }.
// None needs escaping in JSON.
// oxlint-disable-next-line no-control-regex
const WEBSITE_EXCLUDED = /[\u0000-\u0020\u007f-\u009f"'<>\\^`{|}]|\s/u;

// Whether `text`, as decoded, is an app website registration accepts and a status presents as stored: well-formed (so
// its JSON is its UTF-8 bytes and the quotes) with no excluded character, within APP_WEBSITE_LIMIT UTF-8 bytes and
// APP_WEBSITE_JSON_BYTES as JSON, and an http(s) URL with a host by the WHATWG parser. Mastodon's UrlValidator
// (Addressable::URI.parse, an http(s) scheme and a host) may accept some of the excluded characters
// (docs/mastodon-deviations.md, Posting).
export function isAppWebsite(text: string): boolean {
  if (text.length > APP_WEBSITE_LIMIT || !text.isWellFormed() || WEBSITE_EXCLUDED.test(text)) {
    return false;
  }
  if (
    ENCODER.encode(text).length > APP_WEBSITE_LIMIT ||
    ENCODER.encode(JSON.stringify(text)).length > APP_WEBSITE_JSON_BYTES
  ) {
    return false;
  }
  try {
    const url = new URL(text);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
  } catch {
    return false;
  }
}

// The read projections of oauth_clients.name and website for a status (RES-2): NULL for another storage class (no JSON
// function sees a BLOB) or past the raw bytes a presented value may hold, so a row reads at most APP_NAME_BYTES and
// APP_WEBSITE_LIMIT bytes of them whatever was imported. The presenter judges the decoded value again
// (presentedAppName, isAppWebsite): malformed bytes decode to U+FFFD, three bytes each.
export function appNameSql(column: string): string {
  return `CASE WHEN typeof(${column}) = 'text' THEN ${byteBoundSql(column, APP_NAME_BYTES)} END`;
}

export function appWebsiteSql(column: string): string {
  return `CASE WHEN typeof(${column}) = 'text' THEN ${byteBoundSql(column, APP_WEBSITE_LIMIT)} END`;
}

// A stored app name as a status presents it: the name when, as decoded, it is 1 to APP_NAME_LIMIT code points within
// APP_NAME_BYTES UTF-8 bytes and APP_NAME_JSON_BYTES as a JSON string, with no U+0000 (which no registration keeps:
// storedText's rule), else none.
export function presentedAppName(name: string | null): string | null {
  if (name === null || name === "" || name.length > APP_NAME_BYTES || name.includes("\u0000")) {
    return null;
  }
  if (yieldsMoreThan(name, APP_NAME_LIMIT)) {
    return null;
  }
  return ENCODER.encode(name).length <= APP_NAME_BYTES &&
    ENCODER.encode(JSON.stringify(name)).length <= APP_NAME_JSON_BYTES
    ? name
    : null;
}

// media_attachments.blurhash: NULL, or a BlurHash Mastodon's MediaAttachmentParser#supported_blurhash? keeps (its
// parser/media_attachment_parser.rb, the blurhash gem's Blurhash.components): base83 characters, x and y components
// of 1 to 5 each (the size flag, its first character: x = flag mod 9 + 1, y = floor(flag / 9) + 1), and 4 + 2xy
// characters, so 6 to BLURHASH_BYTES ASCII bytes. Mastodon's character check is line-anchored (Ruby's ^ and $), so it
// keeps a valid first line followed by anything; Kopje checks the whole string (docs/mastodon-deviations.md, Media).
// True when `value` holds anything else, judged in order: the storage class, the bytes, NUL, the structure (base83
// only, which also makes the string ASCII), the size flag, then the length.
export const BLURHASH_BYTES = 54;
export const BLURHASH_MIN = 6;
export const BASE83 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~";
const BLURHASH = new RegExp(`^[0-9A-Za-z#$%*+,\\-.:;=?@[\\]^_{|}~]{${BLURHASH_MIN},${BLURHASH_BYTES}}$`);
const BLURHASH_COMPONENTS = 5;

export function blurhashPastBoundSql(value: string): string {
  return `CASE WHEN ${value} IS NULL THEN 0
	WHEN typeof(${value}) <> 'text' THEN 1
	WHEN length(CAST(${value} AS BLOB)) NOT BETWEEN ${BLURHASH_MIN} AND ${BLURHASH_BYTES} THEN 1
	WHEN instr(CAST(${value} AS BLOB), x'00') > 0 THEN 1
	WHEN rtrim(${value}, '${BASE83}') <> '' THEN 1
	WHEN (SELECT f % 9 >= ${BLURHASH_COMPONENTS} OR f / 9 >= ${BLURHASH_COMPONENTS}
			OR length(${value}) <> 4 + 2 * (f % 9 + 1) * (f / 9 + 1)
		FROM (SELECT instr('${BASE83}', substr(${value}, 1, 1)) - 1 AS f)) THEN 1
	ELSE 0 END`;
}

// The blurhash a remote attachment stores for the value it was sent with: it when the bound's value cases accept it,
// else none (the attachment is stored without one rather than refused). The presenter applies it again to what it
// reads, so an imported value it would refuse is never shown.
export function storedBlurhash(value: unknown): string | null {
  if (typeof value !== "string" || !BLURHASH.test(value)) {
    return null;
  }
  const flag = BASE83.indexOf(value[0]!);
  const x = (flag % 9) + 1;
  const y = Math.floor(flag / 9) + 1;
  return x <= BLURHASH_COMPONENTS && y <= BLURHASH_COMPONENTS && value.length === 4 + 2 * x * y ? value : null;
}

// ---- Field verification: migration 0066_field_verification

// Mastodon's limits for local fields (Account::DEFAULT_FIELDS_SIZE, 255 characters each): what Kopje's writer stores
// and presentation keeps (accounts.ts fieldSources), in code points.
export const MAX_FIELDS = 4;
export const MAX_FIELD_NAME = 255;
export const MAX_FIELD_VALUE = 255;

// local_accounts.fields as the verification reads it (domain/field-links.ts): at most LOCAL_FIELDS_BYTES UTF-8 bytes,
// which hold Kopje's writer at its worst (4 fields of 255-character names and values, each character a control that
// JSON escapes to six bytes: test/field-links.test.ts computes it), and at most LOCAL_FIELDS elements. Only a converted
// or imported row can hold more; it is never verified, and its fields are presented by fieldSources' rule.
export const LOCAL_FIELDS_BYTES = 16_384;
/** @alias */
export const LOCAL_FIELDS = MAX_FIELDS;
// A verifiable value, in UTF-8 bytes: the value limit (Account::Field::MAX_CHARACTERS_LOCAL) of printable ASCII, one
// byte each.
/** @alias */
export const FIELD_LINK_VALUE_BYTES = MAX_FIELD_VALUE;
// local_accounts.verified_links: NULL, or a JSON array of 1 to VERIFIED_LINKS [value, verified at] pairs, one per
// distinct value, within VERIFIED_LINKS_BYTES (at most 4 × (2 + 2 × 255 + 3 + 26) + 5 = 2,169 bytes of JSON when every
// value character escapes to two bytes).
const VERIFIED_LINKS = MAX_FIELDS;
export const VERIFIED_LINKS_BYTES = 4096;
// local_accounts.links_attempts: claims of an account's links since the last finish (domain/field-links.ts).
export const FIELD_LINK_MAX_ATTEMPTS = 2;

// `column` when it is fields presentation reads (accounts.ts fieldSources): text of at most LOCAL_FIELDS_BYTES raw
// bytes with no raw NUL, else NULL. Its structure is judged in the Worker, which keeps the entries Kopje's writer
// produces.
export function presentedLocalFieldsSql(column: string): string {
  return `CASE WHEN typeof(${column}) = 'text' AND length(CAST(${column} AS BLOB)) <= ${LOCAL_FIELDS_BYTES}
		AND instr(CAST(${column} AS BLOB), x'00') = 0 THEN ${column} END`;
}

// `column` when it is fields the verification reads, else NULL: the storage class, the raw bytes, a raw NUL (SQLite's
// JSON functions stop at one, so a valid array followed by NUL and anything would pass them), then the structure.
export function boundedLocalFieldsSql(column: string): string {
  return `CASE WHEN typeof(${column}) = 'text' AND length(CAST(${column} AS BLOB)) <= ${LOCAL_FIELDS_BYTES}
		AND instr(CAST(${column} AS BLOB), x'00') = 0 AND json_valid(${column}) AND json_type(${column}) = 'array'
		AND json_array_length(${column}) <= ${LOCAL_FIELDS} THEN ${column} END`;
}

// Whether the decoded text `value` is a value the verification may hold: 1 to FIELD_LINK_VALUE_BYTES bytes, no NUL
// (a JSON escape decodes to one, which GLOB stops at), printable ASCII only (so its bytes are its characters).
export function fieldLinkValueSql(value: string): string {
  return `(length(CAST(${value} AS BLOB)) BETWEEN 1 AND ${FIELD_LINK_VALUE_BYTES}
		AND instr(CAST(${value} AS BLOB), x'00') = 0 AND ${value} NOT GLOB '*[^!-~]*')`;
}

// True when `column` holds verified_links past its bound, judged in order: the storage class, the raw bytes, a raw
// NUL, the structure (a JSON array of 1 to VERIFIED_LINKS elements, each a pair of texts), each value by its decoded
// bytes (fieldLinkValueSql), each time by isoTimeSql, then the values once each.
export function verifiedLinksPastBoundSql(column: string): string {
  const value = "e.value ->> '$[0]'";
  const at = "e.value ->> '$[1]'";
  const element = `CASE WHEN e.type <> 'array' THEN 1
		WHEN json_array_length(e.value) <> 2 THEN 1
		WHEN json_type(e.value, '$[0]') <> 'text' OR json_type(e.value, '$[1]') <> 'text' THEN 1
		WHEN NOT ${fieldLinkValueSql(value)} THEN 1
		WHEN ${isoTimeSql(at)} IS NULL THEN 1
		ELSE 0 END`;
  return `CASE WHEN ${column} IS NULL THEN 0
	WHEN typeof(${column}) <> 'text' THEN 1
	WHEN length(CAST(${column} AS BLOB)) > ${VERIFIED_LINKS_BYTES} THEN 1
	WHEN instr(CAST(${column} AS BLOB), x'00') > 0 THEN 1
	WHEN NOT json_valid(${column}) THEN 1
	WHEN json_type(${column}) <> 'array' THEN 1
	WHEN json_array_length(${column}) NOT BETWEEN 1 AND ${VERIFIED_LINKS} THEN 1
	WHEN EXISTS (SELECT 1 FROM json_each(${column}) e WHERE ${element}) THEN 1
	WHEN (SELECT count(DISTINCT ${value}) FROM json_each(${column}) e) <> json_array_length(${column}) THEN 1
	ELSE 0 END`;
}

// ---- Unverified field links: migration 0076_field_link_checks

// local_accounts.unverified_links: NULL, or a JSON array of 1 to UNVERIFIED_LINKS distinct values (texts, each
// fieldLinkValueSql), within UNVERIFIED_LINKS_BYTES raw UTF-8 bytes (at most 4 × (2 + 2 × 255) + 5 = 2,053 bytes of
// JSON when every value character escapes to two bytes).
const UNVERIFIED_LINKS = LOCAL_FIELDS;
export const UNVERIFIED_LINKS_BYTES = 4096;

// True when `column` holds unverified_links past its bound, judged in order: the storage class, the raw bytes, a raw
// NUL, the structure (a JSON array of 1 to UNVERIFIED_LINKS elements), each element a text by its decoded bytes
// (fieldLinkValueSql), then the values once each.
export function unverifiedLinksPastBoundSql(column: string): string {
  return `CASE WHEN ${column} IS NULL THEN 0
	WHEN typeof(${column}) <> 'text' THEN 1
	WHEN length(CAST(${column} AS BLOB)) > ${UNVERIFIED_LINKS_BYTES} THEN 1
	WHEN instr(CAST(${column} AS BLOB), x'00') > 0 THEN 1
	WHEN NOT json_valid(${column}) THEN 1
	WHEN json_type(${column}) <> 'array' THEN 1
	WHEN json_array_length(${column}) NOT BETWEEN 1 AND ${UNVERIFIED_LINKS} THEN 1
	WHEN EXISTS (SELECT 1 FROM json_each(${column}) e WHERE e.type <> 'text' OR NOT ${fieldLinkValueSql("e.value")}) THEN 1
	WHEN (SELECT count(DISTINCT e.value) FROM json_each(${column}) e) <> json_array_length(${column}) THEN 1
	ELSE 0 END`;
}

// ---- Status cards: migration 0067_status_cards

// status_cards (domain/link-cards.ts): one row per public or unlisted original status, pending or attached, holding
// the card's fields (Mastodon's PreviewCard and PreviewCardsStatus, as one copy per status). Bounds, each in its unit:
// url, author_url and provider_url in UTF-8 bytes (a serialized URL is ASCII; url is web-page.ts WEB_PAGE_URL_LIMIT,
// test/link-cards.test.ts pins them equal); the texts as JSON-escaped UTF-8 bytes with their quotes, so a stored text
// is at most two fewer raw bytes; language in UTF-8 bytes (mn-Mong, the longest of trend-languages.ts TREND_LANGUAGES).
// Mastodon bounds only the url (PreviewCard validates no text); the others are Kopje's, set so a status with its cards
// stays within RES-3's budgets (test/status-bounds.test.ts, the table of maxima).
export const CARD_URL_LIMIT = 2048;
export const CARD_OPTIONAL_URL_LIMIT = 1024;
export const CARD_TITLE_JSON_BYTES = 512;
export const CARD_DESCRIPTION_JSON_BYTES = 1024;
export const CARD_NAME_JSON_BYTES = 512;
export const CARD_LANGUAGE_BYTES = 7;
// status_cards.attempts: claims of a pending row since it was enqueued or released (domain/link-cards.ts).
export const CARD_MAX_ATTEMPTS = 2;
// The largest counter or time in ms a row holds: a JavaScript safe integer, so each crosses RPC whole.
export const SAFE_INTEGER_MAX = Number.MAX_SAFE_INTEGER;

// A counter or time column as read: an integer within 0..`max`, else NULL (link-cards.ts, remote-field-links.ts).
export function storedCountSql(column: string, max = SAFE_INTEGER_MAX): string {
  return `CASE WHEN typeof(${column}) = 'integer' AND ${column} BETWEEN 0 AND ${max} THEN ${column} END`;
}

// The card's texts with their bounds, in column order.
export const CARD_TEXTS = {
  title: CARD_TITLE_JSON_BYTES,
  description: CARD_DESCRIPTION_JSON_BYTES,
  author_name: CARD_NAME_JSON_BYTES,
  provider_name: CARD_NAME_JSON_BYTES,
} as const;
export type CardText = keyof typeof CARD_TEXTS;

// The characters no stored or presented card URL holds besides controls, spaces and non-ASCII: those that end or split
// an HTML attribute or a URL. One GLOB pattern of 13 bytes (workerd refuses one over 50).
const CARD_URL_EXCLUDED_GLOB = '*["<>\\^`{|}]*';

// The WHEN lines that refuse `value` as a card text of at most `jsonBytes`, in order: the storage class, the raw bytes,
// NUL, then the JSON-escaped bytes (json_quote escapes as JSON.stringify does).
function cardTextCases(value: string, jsonBytes: number): string {
  return `WHEN typeof(${value}) <> 'text' THEN 1
	WHEN length(CAST(${value} AS BLOB)) > ${jsonBytes - 2} THEN 1
	WHEN instr(CAST(${value} AS BLOB), x'00') > 0 THEN 1
	WHEN length(CAST(json_quote(${value}) AS BLOB)) > ${jsonBytes} THEN 1`;
}

// True when `value` is no card text of at most `jsonBytes`: the rule the triggers and the writers share.
export function cardTextPastSql(value: string, jsonBytes: number): string {
  return `CASE ${cardTextCases(value, jsonBytes)}
	ELSE 0 END`;
}

// The WHEN lines that refuse `value` as a card URL, in order: the storage class, the raw bytes, NUL, then the
// structure: https (for the card's url) or http(s) (`optional`, which may also be ''), printable ASCII only, and none
// of CARD_URL_EXCLUDED_GLOB's characters.
function cardUrlCases(value: string, optional: boolean): string {
  const scheme = optional
    ? `NOT (${value} GLOB 'https://?*' OR ${value} GLOB 'http://?*')`
    : `${value} NOT GLOB 'https://?*'`;
  return `WHEN typeof(${value}) <> 'text' THEN 1
	WHEN length(CAST(${value} AS BLOB)) > ${optional ? CARD_OPTIONAL_URL_LIMIT : CARD_URL_LIMIT} THEN 1
	WHEN instr(CAST(${value} AS BLOB), x'00') > 0 THEN 1${optional ? `\n\tWHEN ${value} = '' THEN 0` : ""}
	WHEN ${scheme} THEN 1
	WHEN ${value} GLOB '*[^!-~]*' THEN 1
	WHEN ${value} GLOB '${CARD_URL_EXCLUDED_GLOB}' THEN 1`;
}

// True when `value` is no card URL (optional: author_url or provider_url, which may be '').
export function cardUrlPastSql(value: string, optional: boolean): string {
  return `CASE ${cardUrlCases(value, optional)}
	ELSE 0 END`;
}

// True when `value` is no stored language: NULL is one; else 2 to CARD_LANGUAGE_BYTES ASCII letters and hyphens.
export function cardLanguagePastSql(value: string): string {
  return `CASE WHEN ${value} IS NULL THEN 0
	WHEN typeof(${value}) <> 'text' THEN 1
	WHEN length(CAST(${value} AS BLOB)) NOT BETWEEN 2 AND ${CARD_LANGUAGE_BYTES} THEN 1
	WHEN instr(CAST(${value} AS BLOB), x'00') > 0 THEN 1
	WHEN ${value} GLOB '*[^A-Za-z-]*' THEN 1
	ELSE 0 END`;
}

// A counter or time column's case: an integer from 0 to `max` (NULL too when nullable).
function cardCountCase(value: string, nullable: boolean, max: number): string {
  const refused = `typeof(${value}) <> 'integer' OR ${value} NOT BETWEEN 0 AND ${max}`;
  return nullable ? `WHEN ${value} IS NOT NULL AND (${refused}) THEN 1` : `WHEN ${refused} THEN 1`;
}

// The WHEN lines that refuse the row `row` by the rules 0067_status_cards introduced, column by column in order:
// status_id (an 18-digit snowflake as TEXT, as statuses.id), url, the counters and times, the texts, the optional
// URLs, language and published_at (isoTimeSql), over the current bounds and predicates.
function statusCardBaseCases(row: string): string {
  const c = (name: string) => `${row}.${name}`;
  const texts = Object.entries(CARD_TEXTS).map(([name, bytes]) => `WHEN ${cardTextPastSql(c(name), bytes)} THEN 1`);
  return `WHEN typeof(${c("status_id")}) <> 'text' THEN 1
	WHEN length(CAST(${c("status_id")} AS BLOB)) <> 18 THEN 1
	WHEN instr(CAST(${c("status_id")} AS BLOB), x'00') > 0 THEN 1
	WHEN ${c("status_id")} GLOB '*[^0-9]*' THEN 1
	WHEN ${cardUrlPastSql(c("url"), false)} THEN 1
	${cardCountCase(c("due_at"), true, SAFE_INTEGER_MAX)}
	${cardCountCase(c("enqueued_at"), false, SAFE_INTEGER_MAX)}
	${cardCountCase(c("claim"), false, SAFE_INTEGER_MAX)}
	${cardCountCase(c("attempts"), false, CARD_MAX_ATTEMPTS)}
	${cardCountCase(c("generation"), false, SAFE_INTEGER_MAX)}
	${cardCountCase(c("fetched_at"), true, SAFE_INTEGER_MAX)}
	${texts.join("\n\t")}
	WHEN ${cardUrlPastSql(c("author_url"), true)} THEN 1
	WHEN ${cardUrlPastSql(c("provider_url"), true)} THEN 1
	WHEN ${cardLanguagePastSql(c("language"))} THEN 1
	WHEN ${c("published_at")} IS NOT NULL AND ${isoTimeSql(c("published_at"))} IS NULL THEN 1`;
}

// A stored card text as presented: the value when, as decoded, it is a string of at most `jsonBytes` code units,
// well-formed, with no U+0000, within `jsonBytes` - 2 UTF-8 bytes and `jsonBytes` as a JSON string, else ''. An
// imported value of malformed UTF-8 can pass the triggers and decode to more (U+FFFD, three bytes each).
export function presentedCardText(value: unknown, jsonBytes: number): string {
  if (typeof value !== "string" || value.length > jsonBytes || !value.isWellFormed() || value.includes("\u0000")) {
    return "";
  }
  return ENCODER.encode(value).length <= jsonBytes - 2 && ENCODER.encode(JSON.stringify(value)).length <= jsonBytes
    ? value
    : "";
}

// What no presented card URL holds as decoded: C0 controls, the space, DEL, C1 controls, U+FFFD (a stored value that
// is not well-formed UTF-8 decodes to it), other whitespace, and the characters of CARD_URL_EXCLUDED_GLOB.
// oxlint-disable-next-line no-control-regex
const CARD_URL_REFUSED = /[\u0000-\u0020\u007f-\u009f\ufffd"<>\\^`{|}]|\s/u;

// A stored card URL as presented (HTML-3): judged as decoded (a string of at most `limit` code units,
// well-formed, no refused character, within `limit` UTF-8 bytes), then normalized (an http(s) URL by the WHATWG
// parser, its href within `limit` bytes and `limit` + 2 as a JSON string). Else null. `limit`: CARD_URL_LIMIT for the
// card's url, CARD_OPTIONAL_URL_LIMIT for author_url and provider_url.
export function presentedCardUrl(value: unknown, limit = CARD_URL_LIMIT): string | null {
  if (
    typeof value !== "string" ||
    value.length > limit ||
    !value.isWellFormed() ||
    CARD_URL_REFUSED.test(value) ||
    ENCODER.encode(value).length > limit
  ) {
    return null;
  }
  let href: string;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    href = url.href;
  } catch {
    return null;
  }
  return href.length <= limit && ENCODER.encode(JSON.stringify(href)).length <= limit + 2 ? href : null;
}

// The partial indexes of status_cards (domain/link-cards.ts names them in INDEXED BY).
export const CARD_DUE_INDEX = "status_cards_due";
export const CARD_EXPIRY_INDEX = "status_cards_expiry";
export const CARD_CLAIMED_INDEX = "status_cards_claimed";
export const CARD_FRESH_INDEX = "status_cards_fresh";

// ---- Remote field verification: migration 0068_remote_field_verification

// remote_field_links (domain/remote-field-links.ts): one row per remote account with a field link to verify, holding
// what the cron's round checks and what it found. Bounds, each in its unit:
// - REMOTE_FIELD_INDEXES: the fields a remote account shows (account-columns.ts MAX_REMOTE_FIELDS; test pins them
//   equal), an entry's index among them from 0;
// - REMOTE_VERIFIED_SHOWN: the entries `links` holds, the first candidates in shown order;
// - REMOTE_FIELD_LINK_BYTES: an href, in UTF-8 bytes of printable ASCII: the longest X of Mastodon's shortest
//   double-quoted anchor `<a href="X">X</a>` within Account::Field::MAX_CHARACTERS_COMPAT, floor((2047 - 15) / 2);
// - REMOTE_LINK_BACK_BYTES: link_back, in UTF-8 bytes of printable ASCII (identity-bounds.ts ACTOR_URI_LIMIT and
//   PROFILE_URL_LIMIT, which the link back is one of);
// - REMOTE_FIELD_LINKS_BYTES: `links`, in UTF-8 bytes of its canonical JSON: 1 + 4 × 1,052 + 3 + 1, an entry at most
//   [15,"<1016 bytes>","<24 bytes>",1], no href character JSON-escaped (test/status-bounds.test.ts derives it).
export const REMOTE_FIELD_INDEXES = 16;
export const REMOTE_VERIFIED_SHOWN = 4;
export const REMOTE_FIELD_LINK_BYTES = 1016;
export const REMOTE_LINK_BACK_BYTES = 2048;
export const REMOTE_FIELD_LINKS_BYTES = 4213;

// The WHEN lines that refuse the decoded text `value` as an href of an entry, in order: its bytes, NUL (a JSON escape
// decodes to one, which GLOB stops at), printable ASCII only, none of CARD_URL_EXCLUDED_GLOB's characters (those that
// end or split an HTML attribute or a URL), then the https:// prefix.
function remoteFieldHrefCases(value: string): string {
  return `WHEN length(CAST(${value} AS BLOB)) NOT BETWEEN 1 AND ${REMOTE_FIELD_LINK_BYTES} THEN 1
	WHEN instr(CAST(${value} AS BLOB), x'00') > 0 THEN 1
	WHEN ${value} GLOB '*[^!-~]*' THEN 1
	WHEN ${value} GLOB '${CARD_URL_EXCLUDED_GLOB}' THEN 1
	WHEN ${value} NOT GLOB 'https://?*' THEN 1`;
}

// True when `column` holds no `links` value, judged in order, each step only once every earlier one passed: the
// storage class, the raw bytes, a raw NUL, json_valid, the canonical form (json() of it, by bytes, and no escape,
// which json() keeps and no stored character needs: no padding, no other spelling), the shape and types (an array of
// 1 to REMOTE_VERIFIED_SHOWN entries, each [integer, text, null or text, integer]), each decoded element (the href,
// remoteFieldHrefCases; the time by isoTimeSql), then the invariants: indexes from 0 to REMOTE_FIELD_INDEXES - 1
// strictly increasing, checked 0 or 1, and a verified entry checked. The writer's drop rule
// (domain/remote-field-links.ts) and the triggers share it.
export function remoteFieldLinksPastBoundSql(column: string): string {
  const element = (path: string) => `e.value ->> '${path}'`;
  const shape = `CASE WHEN e.type <> 'array' THEN 1
		WHEN json_array_length(e.value) <> 4 THEN 1
		WHEN json_type(e.value, '$[0]') <> 'integer' OR json_type(e.value, '$[1]') <> 'text' THEN 1
		WHEN json_type(e.value, '$[2]') NOT IN ('null', 'text') OR json_type(e.value, '$[3]') <> 'integer' THEN 1
		ELSE 0 END`;
  const decoded = `CASE ${remoteFieldHrefCases(element("$[1]"))}
		WHEN json_type(e.value, '$[2]') = 'text' AND ${isoTimeSql(element("$[2]"))} IS NULL THEN 1
		ELSE 0 END`;
  const invariant = `CASE WHEN ${element("$[0]")} NOT BETWEEN 0 AND ${REMOTE_FIELD_INDEXES - 1} THEN 1
		WHEN ${element("$[3]")} NOT IN (0, 1) THEN 1
		WHEN json_type(e.value, '$[2]') = 'text' AND ${element("$[3]")} <> 1 THEN 1
		WHEN e.key > 0 AND ${element("$[0]")} <= (${column} ->> ('$[' || (e.key - 1) || '][0]')) THEN 1
		ELSE 0 END`;
  return `CASE WHEN typeof(${column}) <> 'text' THEN 1
	WHEN length(CAST(${column} AS BLOB)) > ${REMOTE_FIELD_LINKS_BYTES} THEN 1
	WHEN instr(CAST(${column} AS BLOB), x'00') > 0 THEN 1
	WHEN NOT json_valid(${column}) THEN 1
	WHEN CAST(json(${column}) AS BLOB) <> CAST(${column} AS BLOB) OR instr(${column}, '\\') > 0 THEN 1
	WHEN json_type(${column}) <> 'array' THEN 1
	WHEN json_array_length(${column}) NOT BETWEEN 1 AND ${REMOTE_VERIFIED_SHOWN} THEN 1
	WHEN EXISTS (SELECT 1 FROM json_each(${column}) e WHERE ${shape}) THEN 1
	WHEN EXISTS (SELECT 1 FROM json_each(${column}) e WHERE ${decoded}) THEN 1
	WHEN EXISTS (SELECT 1 FROM json_each(${column}) e WHERE ${invariant}) THEN 1
	ELSE 0 END`;
}

// True when `value` is no link back: text of 1 to REMOTE_LINK_BACK_BYTES bytes, no NUL, printable ASCII, http(s).
export function remoteLinkBackPastBoundSql(value: string): string {
  return `CASE WHEN typeof(${value}) <> 'text' THEN 1
	WHEN length(CAST(${value} AS BLOB)) NOT BETWEEN 1 AND ${REMOTE_LINK_BACK_BYTES} THEN 1
	WHEN instr(CAST(${value} AS BLOB), x'00') > 0 THEN 1
	WHEN ${value} GLOB '*[^!-~]*' THEN 1
	WHEN NOT (${value} GLOB 'https://?*' OR ${value} GLOB 'http://?*') THEN 1
	ELSE 0 END`;
}

// True when the row `row` holds a value past its stored bound, in order: the storage classes, the raw bytes and
// NUL of account_id (an 18-digit snowflake as TEXT, as accounts.id), link_back and links, then their structure
// (remoteLinkBackPastBoundSql, remoteFieldLinksPastBoundSql), then the counters and times. The table's CHECK holds
// that a row is armed (due_at and armed_at set) or not (both NULL).
export function remoteFieldLinkRowPastBoundSql(row: string): string {
  const c = (name: string) => `${row}.${name}`;
  return `CASE WHEN typeof(${c("account_id")}) <> 'text' OR typeof(${c("link_back")}) <> 'text'
		OR typeof(${c("links")}) <> 'text' THEN 1
	WHEN length(CAST(${c("account_id")} AS BLOB)) <> 18 THEN 1
	WHEN instr(CAST(${c("account_id")} AS BLOB), x'00') > 0 THEN 1
	WHEN ${c("account_id")} GLOB '*[^0-9]*' THEN 1
	WHEN ${remoteLinkBackPastBoundSql(c("link_back"))} THEN 1
	WHEN ${remoteFieldLinksPastBoundSql(c("links"))} THEN 1
	${cardCountCase(c("generation"), false, SAFE_INTEGER_MAX)}
	${cardCountCase(c("claim"), false, SAFE_INTEGER_MAX)}
	${cardCountCase(c("attempts"), false, FIELD_LINK_MAX_ATTEMPTS)}
	${cardCountCase(c("due_at"), true, SAFE_INTEGER_MAX)}
	${cardCountCase(c("armed_at"), true, SAFE_INTEGER_MAX)}
	${cardCountCase(c("hold_until"), true, SAFE_INTEGER_MAX)}
	${cardCountCase(c("checked_at"), true, SAFE_INTEGER_MAX)}
	ELSE 0 END`;
}

// The partial indexes of remote_field_links (domain/remote-field-links.ts names them in INDEXED BY).
export const REMOTE_LINK_DUE_INDEX = "remote_field_links_due";
export const REMOTE_LINK_EXPIRY_INDEX = "remote_field_links_expiry";

// ---- Card embeds: migration 0069_card_embeds

// What an oEmbed or twitter:player card adds to status_cards (domain/link-cards.ts), and the cache of oEmbed endpoints
// per host (card_oembed_endpoints, Mastodon's oembed_endpoint:<host> cache, fetch_oembed_service.rb:4, 69-78). Bounds,
// each in its unit:
// - CARD_TYPES: card_type, an integer (link 0, photo 1, video 2);
// - CARD_DIMENSION_MAX: width, height, iframe_width and iframe_height, integers (iframe ones NULL when omitted);
// - CARD_EMBED_SRC_BYTES: embed_src, the video iframe's decoded src, in UTF-8 bytes of printable ASCII ('' for none);
//   CARD_EMBED_SRC_ESCAPED_BYTES: the same after its one HTML escape (& to &amp;, the only character it escapes);
// - OEMBED_TEMPLATE_BYTES: a cached endpoint template, in UTF-8 bytes of printable ASCII (web-page.ts
//   WEB_PAGE_URL_LIMIT; test/link-cards.test.ts pins them equal); a host, in bytes of the DOMAIN rule (253);
// - OEMBED_ENDPOINT_TTL_MS: a cached endpoint's life; expires_at, a time in ms from 0 to SAFE_INTEGER_MAX;
// - OEMBED_ENDPOINTS_MAX: the rows the writer keeps (an import may hold more; they expire, OEMBED_EXPIRE_BATCH a
//   claim).
export const CARD_TYPES = { link: 0, photo: 1, video: 2 } as const;
export type CardType = keyof typeof CARD_TYPES;
export const CARD_DIMENSION_MAX = 65_535;
export const CARD_EMBED_SRC_BYTES = 512;
export const CARD_EMBED_SRC_ESCAPED_BYTES = 512;
export const OEMBED_TEMPLATE_BYTES = 2048;
export const OEMBED_HOST_BYTES = 253;
export const OEMBED_ENDPOINT_TTL_MS = 24 * 60 * 60 * 1000;
export const OEMBED_ENDPOINTS_MAX = 2048;
export const OEMBED_EXPIRE_BATCH = 100;
// The placeholder of a template: every brace of one belongs to it, after an =.
export const OEMBED_PLACEHOLDER = "={url}";

// The WHEN lines that refuse `value` as an embed_src, in order: the storage class, the raw bytes, NUL, then '' (none)
// accepted, then the structure: http(s), printable ASCII only, none of CARD_URL_EXCLUDED_GLOB's characters,
// and its escaped form (each & four bytes longer) within CARD_EMBED_SRC_ESCAPED_BYTES.
function cardEmbedSrcCases(value: string): string {
  return `WHEN typeof(${value}) <> 'text' THEN 1
	WHEN length(CAST(${value} AS BLOB)) > ${CARD_EMBED_SRC_BYTES} THEN 1
	WHEN instr(CAST(${value} AS BLOB), x'00') > 0 THEN 1
	WHEN ${value} = '' THEN 0
	WHEN NOT (${value} GLOB 'http://?*' OR ${value} GLOB 'https://?*') THEN 1
	WHEN ${value} GLOB '*[^!-~]*' THEN 1
	WHEN ${value} GLOB '${CARD_URL_EXCLUDED_GLOB}' THEN 1
	WHEN length(CAST(${value} AS BLOB)) + 4 * (length(${value}) - length(replace(${value}, '&', '')))
		> ${CARD_EMBED_SRC_ESCAPED_BYTES} THEN 1`;
}

// The iframe src as rendered inside the double quotes of its attribute: & escaped once, as &amp;. The stored and
// presented value refuses "<> (CARD_URL_EXCLUDED_GLOB, presentedCardUrl), so no other character needs it; ' is
// legal inside double quotes.
export function embedSrcAttribute(src: string): string {
  return src.replaceAll("&", "&amp;");
}

// An iframe src as kept and presented (HTML-3): presentedCardUrl's rule within CARD_EMBED_SRC_BYTES (judged as
// decoded, then normalized: an absolute http(s) URL, no base), and its attribute form within
// CARD_EMBED_SRC_ESCAPED_BYTES. Else null.
export function presentedEmbedSrc(value: unknown): string | null {
  const href = presentedCardUrl(value, CARD_EMBED_SRC_BYTES);
  return href !== null && embedSrcAttribute(href).length <= CARD_EMBED_SRC_ESCAPED_BYTES ? href : null;
}

// A card's width or height (strict): a JSON integer from 0 to CARD_DIMENSION_MAX, or a string of 1 to 5 ASCII
// digits whose value is at most that; anything else (absent, null, '', a fraction, a sign, a unit) is 0.
const DIMENSION = /^[0-9]{1,5}$/;
export function cardDimension(value: unknown): number {
  return iframeDimension(value) ?? 0;
}

// An iframe's width or height attribute, or the same rule over an oEmbed field: the value as cardDimension reads it,
// else null (the attribute is omitted).
export function iframeDimension(value: unknown): number | null {
  const n = typeof value === "string" && DIMENSION.test(value) ? Number(value) : value;
  return Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= CARD_DIMENSION_MAX ? (n as number) : null;
}

// True when `value` is no embed_src: the rule the triggers and the writer share.
export function cardEmbedSrcPastSql(value: string): string {
  return `CASE ${cardEmbedSrcCases(value)}
	ELSE 0 END`;
}

// The card's dimension as stored: an integer within 0..CARD_DIMENSION_MAX, else `otherwise` (0, or NULL for an
// iframe's).
export function cardDimensionSql(value: string, otherwise: "0" | "NULL"): string {
  const read = storedCountSql(value, CARD_DIMENSION_MAX);
  return otherwise === "NULL" ? read : `coalesce(${read}, 0)`;
}

// A card image's alt text (status_cards.image_description, Mastodon's og:image:alt), in JSON-escaped UTF-8 bytes with
// its quotes; RES-3's spares at 4,096 bytes (test/status-bounds.test.ts) set it.
export const CARD_IMAGE_DESCRIPTION_JSON_BYTES = 256;

// True when `value` is no 18-digit snowflake as TEXT (NULL included): the storage class, the bytes, NUL, the digits.
function snowflakePastSql(value: string): string {
  return `CASE WHEN typeof(${value}) <> 'text' THEN 1
	WHEN length(CAST(${value} AS BLOB)) <> 18 THEN 1
	WHEN instr(CAST(${value} AS BLOB), x'00') > 0 THEN 1
	WHEN ${value} GLOB '*[^0-9]*' THEN 1
	ELSE 0 END`;
}

// True when the row `row` holds a value past its stored bound: 0067's rules (statusCardBaseCases), then card_type,
// width and height, embed_src (cardEmbedSrcPastSql), iframe_width and iframe_height (0069), then image_url ('' or a
// card URL, cardUrlPastSql), image_id (NULL or a snowflake) and image_description (a card text of
// CARD_IMAGE_DESCRIPTION_JSON_BYTES) of 0070, then link_type (LINK_TYPES), final_url ('' or a card URL) and public (0
// or 1) of 0071, then the invariants: a video card and only one holds an embed_src, no iframe dimension is kept without
// one, no image id without an image URL, and public = 1 only on an attached row with a final URL whose status is
// public (the membership of status_cards_public_link: one key seek of statuses). The CHECKs of the table hold the
// row's structure (pending or attached, an attached title).
export function statusCardPastBoundSql(row: string): string {
  const c = (name: string) => `${row}.${name}`;
  return `CASE ${statusCardBaseCases(row)}
	${cardCountCase(c("card_type"), false, CARD_TYPES.video)}
	${cardCountCase(c("width"), false, CARD_DIMENSION_MAX)}
	${cardCountCase(c("height"), false, CARD_DIMENSION_MAX)}
	WHEN ${cardEmbedSrcPastSql(c("embed_src"))} THEN 1
	${cardCountCase(c("iframe_width"), true, CARD_DIMENSION_MAX)}
	${cardCountCase(c("iframe_height"), true, CARD_DIMENSION_MAX)}
	WHEN ${c("image_url")} IS NOT '' AND ${cardUrlPastSql(c("image_url"), false)} THEN 1
	WHEN ${c("image_id")} IS NOT NULL AND ${snowflakePastSql(c("image_id"))} THEN 1
	WHEN ${cardTextPastSql(c("image_description"), CARD_IMAGE_DESCRIPTION_JSON_BYTES)} THEN 1
	${cardCountCase(c("link_type"), false, LINK_TYPES.article)}
	WHEN ${c("final_url")} IS NOT '' AND ${cardUrlPastSql(c("final_url"), false)} THEN 1
	${cardCountCase(c("public"), false, 1)}
	WHEN (${c("card_type")} = ${CARD_TYPES.video}) <> (${c("embed_src")} <> '') THEN 1
	WHEN ${c("embed_src")} = '' AND (${c("iframe_width")} IS NOT NULL OR ${c("iframe_height")} IS NOT NULL) THEN 1
	WHEN ${c("image_url")} IS '' AND ${c("image_id")} IS NOT NULL THEN 1
	WHEN ${c("public")} = 1 AND (${c("fetched_at")} IS NULL OR ${c("final_url")} = ''
		OR (SELECT ps.visibility FROM main.statuses ps WHERE ps.id = ${c("status_id")}) IS NOT 'public') THEN 1
	ELSE 0 END`;
}

// A card's link type (status_cards.link_type, Mastodon's PreviewCard link_type, link_details_extractor.rb:139-145):
// unknown, or an article (JSON-LD @type NewsArticle, or og:type article), independent of the card's type.
export const LINK_TYPES = { unknown: 0, article: 1 } as const;
export type LinkType = keyof typeof LINK_TYPES;

// The characters a template holds besides printable ASCII's refused: those that end or split an HTML attribute or a
// URL, braces apart (OEMBED_PLACEHOLDER's, judged after). One GLOB pattern of 11 bytes.
const OEMBED_TEMPLATE_EXCLUDED_GLOB = '*["<>\\^`|]*';

// True when `value` is no template, judged in order: the storage class, the raw bytes, NUL, https, printable
// ASCII, the excluded characters, at least one OEMBED_PLACEHOLDER, and no brace outside one. The triggers, the writer
// (domain/link-cards.ts recordCard) and the reader (claimCards) share it; the Worker's twin adds the URL checks
// (federation/card-oembed.ts).
export function oembedTemplatePastSql(value: string): string {
  return `CASE WHEN typeof(${value}) <> 'text' THEN 1
	WHEN length(CAST(${value} AS BLOB)) NOT BETWEEN 1 AND ${OEMBED_TEMPLATE_BYTES} THEN 1
	WHEN instr(CAST(${value} AS BLOB), x'00') > 0 THEN 1
	WHEN ${value} NOT GLOB 'https://?*' THEN 1
	WHEN ${value} GLOB '*[^!-~]*' THEN 1
	WHEN ${value} GLOB '${OEMBED_TEMPLATE_EXCLUDED_GLOB}' THEN 1
	WHEN instr(${value}, '${OEMBED_PLACEHOLDER}') = 0 THEN 1
	WHEN replace(${value}, '${OEMBED_PLACEHOLDER}', '') GLOB '*[{}]*' THEN 1
	ELSE 0 END`;
}

// The same rule over a JavaScript string, as SQLite would judge it bound as text (a lone surrogate binds as three
// bytes, which the printable ASCII rule refuses either way).
const TEMPLATE_REFUSED = /[^!-~]|["<>\\^`|]/;
export function isOembedTemplate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= OEMBED_TEMPLATE_BYTES &&
    value.startsWith("https://") &&
    value.length > "https://".length &&
    !TEMPLATE_REFUSED.test(value) &&
    value.includes(OEMBED_PLACEHOLDER) &&
    !/[{}]/.test(value.replaceAll(OEMBED_PLACEHOLDER, ""))
  );
}

// True when `value` is no cached host: text of 1 to OEMBED_HOST_BYTES bytes, no NUL, of a-z, 0-9, '.' and '-' only.
export function oembedHostPastSql(value: string): string {
  return `CASE WHEN typeof(${value}) <> 'text' THEN 1
	WHEN length(CAST(${value} AS BLOB)) NOT BETWEEN 1 AND ${OEMBED_HOST_BYTES} THEN 1
	WHEN instr(CAST(${value} AS BLOB), x'00') > 0 THEN 1
	WHEN ${value} GLOB '*[^a-z0-9.-]*' THEN 1
	ELSE 0 END`;
}

// True when the row `row` of card_oembed_endpoints holds a value past its stored bound: the host, the template, then
// expires_at.
export function oembedEndpointPastBoundSql(row: string): string {
  return `CASE WHEN ${oembedHostPastSql(`${row}.domain`)} THEN 1
	WHEN ${oembedTemplatePastSql(`${row}.template`)} THEN 1
	${cardCountCase(`${row}.expires_at`, false, SAFE_INTEGER_MAX)}
	ELSE 0 END`;
}

// The index card_oembed_endpoints' expiry walks (domain/link-cards.ts names it in INDEXED BY).
export const OEMBED_EXPIRY_INDEX = "card_oembed_endpoints_expiry";

// ---- Card images: migration 0070_card_images

// card_images (domain/card-images.ts): one row per image source URL a card names, pending or stored, and
// status_cards' link to it (image_url, image_id) with its alt text. Bounds, each in its unit:
// - CARD_IMAGE_BODY_LIMIT: a fetched image, in bytes after workerd's Content-Encoding decoding, exclusive (Mastodon's
//   8 MB, preview_card.rb LIMIT under vips): read as a prefix of one byte less and refused when the body is longer;
// - CARD_IMAGE_PIXELS: the stored image's target area (Mastodon's 230,400-pixel original style); CARD_DECODE_PIXELS
//   the most an output may hold, the target's box plus one line of the longer edge that Images may round up (230,400 +
//   31,744 for edges up to 31,744 pixels), so its RGBA output (federation/card-images.ts I15) is at most 1 MiB;
// - CARD_GIF_MATRIX_LIMIT: a GIF's pixels (Mastodon's attachmentable.rb GIF limit); other types IMAGE_MATRIX_LIMIT
//   (platform/images.ts); CARD_IMAGE_EDGE_MAX an edge of the source, the target and the stored image, in pixels;
// - CARD_IMAGE_OUTPUT_LIMIT: the stored WebP, in bytes, refused while it is read;
// - CARD_IMAGE_TOKEN_BYTES: a stored token (media-files.ts FILE_TOKEN), in ASCII bytes;
// - CARD_IMAGE_URL_BYTES: the presented image URL, in UTF-8 bytes of ASCII: 'https://' + a 253-byte host + '/media/' +
//   a token + '/full.webp';
// - CARD_IMAGE_MAX_ATTEMPTS: claims of a pending row since it was enqueued or released.
export const CARD_IMAGE_BODY_LIMIT = 8 * 1024 * 1024;
export const CARD_IMAGE_PIXELS = 230_400;
export const CARD_DECODE_PIXELS = 262_144;
export const CARD_GIF_MATRIX_LIMIT = 921_600;
/** @alias */
export const CARD_IMAGE_EDGE_MAX = CARD_DIMENSION_MAX;
export const CARD_IMAGE_OUTPUT_LIMIT = 512 * 1024;
export const CARD_IMAGE_TOKEN_MIN_BYTES = 32;
export const CARD_IMAGE_TOKEN_BYTES = 64;
export const CARD_IMAGE_URL_BYTES =
  "https://".length + 253 + "/media/".length + CARD_IMAGE_TOKEN_BYTES + "/full.webp".length;
export const CARD_IMAGE_MAX_ATTEMPTS = 2;

// The partial indexes of card_images and status_cards' image link (domain/card-images.ts names them in INDEXED BY).
export const CARD_IMAGE_DUE_INDEX = "card_images_due";
export const CARD_IMAGE_EXPIRY_INDEX = "card_images_expiry";
export const CARD_IMAGE_STORED_INDEX = "card_images_stored";
export const CARD_IMAGE_PENDING_INDEX = "card_images_pending";
export const CARD_IMAGE_STORED_ID_INDEX = "card_images_stored_id";
export const CARD_IMAGE_TOKEN_INDEX = "card_images_token";
export const CARD_IMAGE_LINK_INDEX = "status_cards_image";

// True when `value` is no stored token: NULL is one; else text of CARD_IMAGE_TOKEN_MIN_BYTES to
// CARD_IMAGE_TOKEN_BYTES bytes, no NUL, base64url only.
export function cardImageTokenPastSql(value: string): string {
  return `CASE WHEN ${value} IS NULL THEN 0
	WHEN typeof(${value}) <> 'text' THEN 1
	WHEN length(CAST(${value} AS BLOB)) NOT BETWEEN ${CARD_IMAGE_TOKEN_MIN_BYTES} AND ${CARD_IMAGE_TOKEN_BYTES} THEN 1
	WHEN instr(CAST(${value} AS BLOB), x'00') > 0 THEN 1
	WHEN ${value} GLOB '*[^A-Za-z0-9_-]*' THEN 1
	ELSE 0 END`;
}

// An edge of a stored image as stored: an integer from 1 to CARD_IMAGE_EDGE_MAX, else NULL.
export function cardImageEdgeSql(value: string): string {
  return `CASE WHEN typeof(${value}) = 'integer' AND ${value} BETWEEN 1 AND ${CARD_IMAGE_EDGE_MAX} THEN ${value} END`;
}

// True when the row `row` of card_images holds a value past its stored bound, column by column in order (the storage
// class, the bytes, NUL, the structure): id (a snowflake), source_url (cardUrlPastSql), the counters and times,
// token, width and height (1 to CARD_IMAGE_EDGE_MAX or NULL), blurhash (blurhashPastBoundSql); then the invariants:
// pending (due_at set) exactly while stored_at is NULL; a stored row holds a token, a width and a height; a pending
// row holds none of them and no blurhash.
export function cardImagePastBoundSql(row: string): string {
  const c = (name: string) => `${row}.${name}`;
  const edge = (name: string) =>
    `WHEN ${c(name)} IS NOT NULL AND (typeof(${c(name)}) <> 'integer' OR ${c(name)} NOT BETWEEN 1 AND ${CARD_IMAGE_EDGE_MAX}) THEN 1`;
  return `CASE WHEN ${snowflakePastSql(c("id"))} THEN 1
	WHEN ${cardUrlPastSql(c("source_url"), false)} THEN 1
	${cardCountCase(c("due_at"), true, SAFE_INTEGER_MAX)}
	${cardCountCase(c("enqueued_at"), false, SAFE_INTEGER_MAX)}
	${cardCountCase(c("claim"), false, SAFE_INTEGER_MAX)}
	${cardCountCase(c("attempts"), false, CARD_IMAGE_MAX_ATTEMPTS)}
	WHEN ${cardImageTokenPastSql(c("token"))} THEN 1
	${edge("width")}
	${edge("height")}
	WHEN ${blurhashPastBoundSql(c("blurhash"))} THEN 1
	${cardCountCase(c("stored_at"), true, SAFE_INTEGER_MAX)}
	WHEN (${c("due_at")} IS NULL) = (${c("stored_at")} IS NULL) THEN 1
	WHEN ${c("stored_at")} IS NOT NULL AND (${c("token")} IS NULL OR ${c("width")} IS NULL OR ${c("height")} IS NULL) THEN 1
	WHEN ${c("stored_at")} IS NULL AND (${c("token")} IS NOT NULL OR ${c("width")} IS NOT NULL OR ${c("height")} IS NOT NULL
		OR ${c("blurhash")} IS NOT NULL) THEN 1
	ELSE 0 END`;
}

// ---- Link trends: migration 0071_link_trends

// trend_links (domain/trends.ts roundLinks): the links the cron scores, by their card's final URL, at most
// MAX_TREND_LINKS (TREND_ALLOWED_ROWS allowed and TREND_REVIEW_POOL for review, RES-4); link_trend_reviews and
// link_provider_reviews: the Access admin's decisions on a link and on a publisher (a domain and its subdomains), at
// most MAX_TREND_REVIEWS each. Bounds, each in its unit: a URL by the card URL rule (cardUrlPastSql, CARD_URL_LIMIT
// bytes of printable ASCII); a domain in LINK_DOMAIN_BYTES ASCII bytes (a DNS name, normalizeDomain's form); a language
// by cardLanguagePastSql; a score from 0 to TREND_SCORE_MAX and its peak from the score to it; a time in the 24-byte
// ISO form (isoTimeSql).
export const MAX_TREND_LINKS = TREND_ALLOWED_ROWS + TREND_REVIEW_POOL;
export const LINK_DOMAIN_BYTES = 253;

// The indexes 0071 adds (domain/trends.ts names them in INDEXED BY): the public, attached copies of a final URL by
// status, the public boosts of an original by id, and the listed trend links by score.
export const CARD_PUBLIC_LINK_INDEX = "status_cards_public_link";
export const PUBLIC_BOOSTS_INDEX = "statuses_public_boosts";
export const TREND_LINKS_LISTED_INDEX = "trend_links_listed";

// True when `value` is no stored link domain, judged in order: the storage class, the bytes, NUL, then the structure
// (lowercase ASCII letters, digits, '-' and '.', at least two labels, no empty label). Each GLOB pattern is at most 15
// bytes.
export function linkDomainPastSql(value: string): string {
  return `CASE WHEN typeof(${value}) <> 'text' THEN 1
	WHEN length(CAST(${value} AS BLOB)) NOT BETWEEN 3 AND ${LINK_DOMAIN_BYTES} THEN 1
	WHEN instr(CAST(${value} AS BLOB), x'00') > 0 THEN 1
	WHEN ${value} GLOB '*[^a-z0-9.-]*' THEN 1
	WHEN ${value} NOT GLOB '?*.?*' OR ${value} GLOB '.*' OR ${value} GLOB '*.' OR ${value} GLOB '*..*' THEN 1
	ELSE 0 END`;
}

// The same rule over a JavaScript string: the domain itself, or null.
export function storedLinkDomain(value: string | null): string | null {
  return value !== null &&
    value.length >= 3 &&
    value.length <= LINK_DOMAIN_BYTES &&
    /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(value)
    ? value
    : null;
}

// A score and its peak as stored (0057's trend_tag_scores, as cases).
function trendScoreCases(row: string): string {
  const c = (name: string) => `${row}.${name}`;
  return `WHEN typeof(${c("score")}) NOT IN ('integer', 'real') OR ${c("score")} NOT BETWEEN 0 AND ${TREND_SCORE_MAX} THEN 1
	WHEN typeof(${c("max_score")}) NOT IN ('integer', 'real')
		OR ${c("max_score")} NOT BETWEEN ${c("score")} AND ${TREND_SCORE_MAX} THEN 1`;
}

// True when the row `row` of trend_links holds a value past its stored bound, column by column: url, domain,
// language, the score and its peak, max_score_at.
export function trendLinkPastBoundSql(row: string): string {
  const c = (name: string) => `${row}.${name}`;
  return `CASE WHEN ${cardUrlPastSql(c("url"), false)} THEN 1
	WHEN ${linkDomainPastSql(c("domain"))} THEN 1
	WHEN ${cardLanguagePastSql(c("language"))} THEN 1
	${trendScoreCases(row)}
	WHEN ${isoTimeSql(c("max_score_at"))} IS NULL THEN 1
	ELSE 0 END`;
}

// True when the row `row` of a link review table holds a value past its stored bound: its key (`key`: the URL by the
// card URL rule, or the domain by linkDomainPastSql), trendable (0 or 1), reviewed_at.
export function linkReviewPastBoundSql(row: string, key: "url" | "domain"): string {
  const c = (name: string) => `${row}.${name}`;
  const keyPast = key === "url" ? cardUrlPastSql(c("url"), false) : linkDomainPastSql(c("domain"));
  return `CASE WHEN ${keyPast} THEN 1
	${cardCountCase(c("trendable"), false, 1)}
	WHEN ${isoTimeSql(c("reviewed_at"))} IS NULL THEN 1
	ELSE 0 END`;
}

// ---- Instance activity: migration 0072_activity_tracking (domain/instance-activity.ts)

// activity_counts: one row per kind and UTC day, value the day's count (1 to ACTIVITY_VALUE_MAX: the writers add 1 and
// stop there, so a window's sum of 6 days stays a safe integer of at most 13 digits). activity_logins: one row per UTC
// day and local account with a login that day, account_id an 18-digit id as TEXT (accounts.id's form), no foreign key.
export const ACTIVITY_KINDS = ["statuses", "registrations"] as const;
export const ACTIVITY_VALUE_MAX = 1_000_000_000_000;

// Whether `id` is an account id activity_logins stores (its CHECK's JS twin): 18 ASCII digits.
export function isActivityAccountId(id: string): boolean {
  return /^[0-9]{18}$/.test(id);
}

// ---- Actor document revisions: migration 0073_actor_document_revision (domain/remote-actors.ts upsertRemoteActor)

// accounts.document_revision: an integer from 0 to DOCUMENT_REVISION_MAX, a JavaScript safe integer so it crosses RPC
// whole. The Store issues a new one with every store of a remote actor's document (ID-1); a row the upgrade or a
// converted dump carries holds 0.
/** @alias */
export const DOCUMENT_REVISION_MAX = SAFE_INTEGER_MAX;

// True when `row` holds a revision past its stored bound: not an integer (INTEGER affinity has already stored numeric
// text and an integral REAL as one), or outside 0..DOCUMENT_REVISION_MAX.
export function documentRevisionPastBoundSql(row: string): string {
  const column = `${row}.document_revision`;
  return `CASE WHEN typeof(${column}) <> 'integer' THEN 1
	WHEN ${column} NOT BETWEEN 0 AND ${DOCUMENT_REVISION_MAX} THEN 1
	ELSE 0 END`;
}

// A new revision for a row whose revision is the SQL `current` (null: a row being inserted, which takes a draw):
// `current` plus an increment of 1 to 2^53 - 1, modulo 2^53, so it always differs from `current` and a stored maximum
// never stops it from changing (no saturation). The increment is drawn from random(), not quite uniformly (two of the
// 2^53 draws give 1), so a repeat of a value an expectation read before is possible after two or more intervening
// stores, each with a chance of about 2^-52 at most: the accepted risk of quotes.generation's convention (domain/ids.ts
// NEW_GENERATION).
export function nextDocumentRevisionSql(current: string | null): string {
  const draw = `(random() & ${DOCUMENT_REVISION_MAX})`;
  return current === null
    ? draw
    : `(${current} + 1 + ${draw} % ${DOCUMENT_REVISION_MAX}) % ${DOCUMENT_REVISION_MAX + 1}`;
}

// ---- Filter text units: migration 0079_filter_text_units (domain/status-presenter.ts measureFilterText)

// statuses.filter_text_units: NULL (not measured), or an integer from 0 to FILTER_TEXT_UNITS_MAX, the UTF-16 code units
// of the status's searchable text cut at filters.ts MAX_FILTER_TEXT, which is this bound.
export const FILTER_TEXT_UNITS_MAX = 10_000;

// True when `column` holds filter_text_units past its stored bound: not NULL and not an integer (INTEGER affinity has
// already stored numeric text and an integral REAL as one), or outside 0..FILTER_TEXT_UNITS_MAX.
export function filterTextUnitsPastBoundSql(column: string): string {
  return `CASE WHEN ${column} IS NULL THEN 0
	WHEN typeof(${column}) <> 'integer' THEN 1
	WHEN ${column} NOT BETWEEN 0 AND ${FILTER_TEXT_UNITS_MAX} THEN 1
	ELSE 0 END`;
}

// ---- Account invitations: migration 0081_account_invitations (domain/account-invitations.ts, AUTH-9)

// A local username: 1 to 30 ASCII letters, digits or underscores (setup's step 7 and an invitation alike), so its
// UTF-8 bytes, UTF-16 code units and code points are the same count.
export const LOCAL_USERNAME = /^[A-Za-z0-9_]{1,30}$/;
export const LOCAL_USERNAME_BYTES = 30;
// account_invitations.email, in UTF-8 bytes (RFC 5321's path limit, as set-email's MAX_EMAIL_LENGTH), and the
// invitations kept at most: local accounts are operator-sized (about 10, admin-authority.ts), and an invitation ends
// when its account is made.
export const INVITATION_EMAIL_BYTES = 254;
export const MAX_ACCOUNT_INVITATIONS = 10;

// The email an invitation stores, or null when it is refused: trimmed, then well-formed, within
// INVITATION_EMAIL_BYTES, and one '@' between two parts with no whitespace or control character. Stricter than the
// CHECK below (which refuses only NUL, ASCII controls, the space and DEL, and wants one '@' inside), so a write never
// fails on it.
export function storedInvitationEmail(raw: string): string | null {
  const email = raw.trim();
  if (!email.isWellFormed() || email.length > INVITATION_EMAIL_BYTES) {
    return null;
  }
  return ENCODER.encode(email).length <= INVITATION_EMAIL_BYTES && /^[^\s@\p{Cc}]+@[^\s@\p{Cc}]+$/u.test(email)
    ? email
    : null;
}

// ---- Status times (statuses.published_at, edited_at)
//
// TEXT with no CHECK or trigger (0000_initial): a converted or imported row may hold any value there, and adding a
// bound would rewrite every status (each row whole, so the cost grows with its content). The bound is kept at both ends
// instead, as for account counts: the writers store storedTime's output only (a time they cannot store replaced as each
// says), and every read that copies a status's time into an answer, a document or another row takes
// statusPublishedSql and statusEditedSql, so no stored value past the form leaves SQLite.

// The stored form of the time `ms` (ms since the epoch), or null when it is no time or its year is outside 0 to 9999.
export function storedTime(ms: number): string | null {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const text = date.toISOString();
  return isIsoTime(text) ? text : null;
}

// The longest stored time read in a format of SQLite's (a fraction of nanoseconds and a zone offset take 35), in UTF-8
// bytes.
const TIME_FORMAT_BYTES = 64;

// `column` (a column, not an expression) in the stored form: as stored when it is in it, else the time SQLite reads in
// it, else NULL. A value is read only when it is at most TIME_FORMAT_BYTES, holds no NUL and starts with a calendar
// date (strftime reads a bare number as a Julian day), judged in that order; strftime applies a zone offset, rounds a
// longer fraction to milliseconds (never past .999), and its '+0 seconds' carries an hour of 24 into the next day. The
// bytes are judged first by octet_length, which SQLite answers from the record header for a column without loading the
// value (test/status-times.test.ts reads the bytecode), so a long imported value costs no more than a short one.
function storedTimeOfSql(column: string): string {
  return `CASE WHEN octet_length(${column}) > ${TIME_FORMAT_BYTES} THEN NULL
	WHEN ${isoTimeAcceptedSql(column)} THEN ${column}
	WHEN instr(CAST(${column} AS BLOB), x'00') = 0 AND ${column} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'
	THEN ${isoTimeSql(`strftime('${ISO_TIME_FORMAT}', ${column}, '+0 seconds')`)} END`;
}

// A status's publication time as read (`s`, the statuses row's alias): its published_at in the stored form, else its
// arrival (created_at), as a remote writer stores a time it cannot read, else the epoch, which no window counts as
// recent. Never NULL.
export function statusPublishedSql(s: string): string {
  return `coalesce(${storedTimeOfSql(`${s}.published_at`)}, ${storedTimeOfSql(`${s}.created_at`)},
	'1970-01-01T00:00:00.000Z')`;
}

// A status's edit time as read: NULL when it was never edited (octet_length is NULL only for NULL, and reads no value);
// else its edited_at in the stored form, else its publication time as read, so an edited status stays edited.
export function statusEditedSql(s: string): string {
  return `CASE WHEN octet_length(${s}.edited_at) IS NULL THEN NULL
	ELSE coalesce(${storedTimeOfSql(`${s}.edited_at`)}, ${statusPublishedSql(s)}) END`;
}

// ---- Account counts (accounts.followers_count, following_count, statuses_count)
//
// INTEGER NOT NULL DEFAULT 0 with no CHECK or trigger (0000_initial): an imported row may hold TEXT, REAL or a BLOB of
// any size there, and adding a bound would rewrite every account. The bound is kept at both ends instead: every writer
// stores storedCount's values only (a local recount, or a remote account's learned count, remote-collections.ts
// completeCollectionRead), and every read that presents, ranks or sums a count takes presentedCountSql, so no stored
// value past it reaches the Worker or an aggregate.

// The largest count kept, a JavaScript safe integer: 16 decimal digits, presented as at most 16 JSON bytes.
export const MAX_ACCOUNT_COUNT = Number.MAX_SAFE_INTEGER;

// A count as stored (an account's, and a remote poll's tallies and voters): a safe integer from 0 to MAX_ACCOUNT_COUNT,
// otherwise null.
export function storedCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

// A stored count as read: the integer within storedCount's range, else 0 (an imported TEXT, REAL or BLOB never leaves
// SQLite, whatever its size).
export function presentedCountSql(column: string): string {
  return `CASE WHEN typeof(${column}) = 'integer' AND ${column} BETWEEN 0 AND ${MAX_ACCOUNT_COUNT} THEN ${column}
		ELSE 0 END`;
}

// ---- Remote media: migration 0077_remote_media

// The cache of remote media in the media bucket under remote/ (domain/remote-media.ts, the only writer of the three
// tables; MEDIA-7): remote_media holds one slot per remote file per owner, remote_media_objects one row per R2 token
// (reserved before any key exists, stored, or doomed until its deletion is confirmed) with the bytes it is charged,
// and remote_media_usage the sums. Bounds, each in its unit:
// - a slot's url: a card URL (cardUrlPastSql: https, at most CARD_URL_LIMIT printable ASCII bytes); its host and an
//   emoji slot's domain: a link domain (linkDomainPastSql, at most LINK_DOMAIN_BYTES ASCII bytes);
// - kind, category, extension and content type: one of the lists below;
// - REMOTE_MEDIA_MAX_ATTEMPTS: claims since the slot was enqueued or reset; REMOTE_MEDIA_DELETE_ATTEMPTS: failed
//   deletions of a doomed object (its backoff stops growing at a day well before);
// - a token: a server token (cardImageTokenPastSql, 32 to 64 base64url bytes);
// - hosts: a JSON array of at most REMOTE_MEDIA_HOSTS link domains, REMOTE_MEDIA_HOSTS_BYTES bytes;
// - every counter, charge and time: an integer from 0 to SAFE_INTEGER_MAX.
export const REMOTE_MEDIA_KINDS = ["avatar", "header", "attachment", "thumbnail", "emoji"] as const;
export const REMOTE_MEDIA_CATEGORIES = ["image", "video", "audio"] as const;
// The served types and the extension each is served under (media-files.ts REMOTE_SERVED_TYPES keeps the same map).
export const REMOTE_MEDIA_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "audio/mp4": "m4a",
  "audio/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/flac": "flac",
  "audio/wav": "wav",
} as const;
export const REMOTE_MEDIA_MAX_ATTEMPTS = 4;
export const REMOTE_MEDIA_DELETE_ATTEMPTS = 64;
export const REMOTE_MEDIA_HOSTS = 4;
export const REMOTE_MEDIA_HOSTS_BYTES = 2 + REMOTE_MEDIA_HOSTS * (LINK_DOMAIN_BYTES + 3);

// The indexes of the three tables (domain/remote-media.ts names them in INDEXED BY).
export const REMOTE_MEDIA_OWNER_INDEX = "remote_media_owner";
export const REMOTE_MEDIA_EMOJI_INDEX = "remote_media_emoji";
export const REMOTE_MEDIA_DUE_INDEX = "remote_media_due";
export const REMOTE_MEDIA_EXPIRY_INDEX = "remote_media_expiry";
export const REMOTE_MEDIA_ACCOUNT_INDEX = "remote_media_account";
export const REMOTE_OBJECTS_SLOT_INDEX = "remote_media_objects_slot";
export const REMOTE_OBJECTS_DUE_INDEX = "remote_media_objects_due";
export const REMOTE_OBJECTS_RETRY_INDEX = "remote_media_objects_retry";
export const REMOTE_OBJECTS_RESERVED_INDEX = "remote_media_objects_reserved";
export const REMOTE_OBJECTS_STORED_INDEX = "remote_media_objects_stored";
export const REMOTE_OBJECTS_VALIDATION_INDEX = "remote_media_objects_validation";

const sqlList = (values: readonly string[]) => `(${values.map((value) => `'${value}'`).join(", ")})`;
const REMOTE_EXTENSIONS = [...new Set(Object.values(REMOTE_MEDIA_TYPES))];

// True when `value` is neither NULL nor a stored remote media extension.
function remoteExtensionPastSql(value: string): string {
  return `CASE WHEN ${value} IS NULL THEN 0
	WHEN typeof(${value}) <> 'text' THEN 1
	WHEN ${value} NOT IN ${sqlList(REMOTE_EXTENSIONS)} THEN 1
	ELSE 0 END`;
}

// True when `value` is neither NULL nor a stored remote media content type.
function remoteTypePastSql(value: string): string {
  return `CASE WHEN ${value} IS NULL THEN 0
	WHEN typeof(${value}) <> 'text' THEN 1
	WHEN ${value} NOT IN ${sqlList(Object.keys(REMOTE_MEDIA_TYPES))} THEN 1
	ELSE 0 END`;
}

// True when the row `row` of remote_media holds a value past its stored bound, column by column in order (id is
// SQLite's rowid, which a BEFORE INSERT trigger reads as -1 before it is assigned), then the invariants: an emoji slot has no owner and a domain, any other an owner and an account; a slot points at its stored
// object (token, ext, stored_at) only while it is neither due nor failed, and a still extension only with it.
export function remoteMediaSlotPastBoundSql(row: string): string {
  const c = (name: string) => `${row}.${name}`;
  return `CASE WHEN typeof(${c("kind")}) <> 'text' OR ${c("kind")} NOT IN ${sqlList(REMOTE_MEDIA_KINDS)} THEN 1
	WHEN ${c("owner_id")} IS NOT NULL AND ${snowflakePastSql(c("owner_id"))} THEN 1
	WHEN ${c("account_id")} IS NOT NULL AND ${snowflakePastSql(c("account_id"))} THEN 1
	WHEN ${c("domain")} IS NOT NULL AND ${linkDomainPastSql(c("domain"))} THEN 1
	WHEN ${cardUrlPastSql(c("url"), false)} THEN 1
	WHEN ${linkDomainPastSql(c("host"))} THEN 1
	WHEN typeof(${c("category")}) <> 'text' OR ${c("category")} NOT IN ${sqlList(REMOTE_MEDIA_CATEGORIES)} THEN 1
	${cardCountCase(c("lane"), false, 1)}
	${cardCountCase(c("generation"), false, SAFE_INTEGER_MAX)}
	${cardCountCase(c("due_at"), true, SAFE_INTEGER_MAX)}
	${cardCountCase(c("enqueued_at"), false, SAFE_INTEGER_MAX)}
	${cardCountCase(c("claim"), false, SAFE_INTEGER_MAX)}
	${cardCountCase(c("attempts"), false, REMOTE_MEDIA_MAX_ATTEMPTS)}
	WHEN ${cardImageTokenPastSql(c("token"))} THEN 1
	WHEN ${remoteExtensionPastSql(c("ext"))} THEN 1
	WHEN ${remoteExtensionPastSql(c("still_ext"))} THEN 1
	${cardCountCase(c("stored_at"), true, SAFE_INTEGER_MAX)}
	${cardCountCase(c("failed_at"), true, SAFE_INTEGER_MAX)}
	${cardCountCase(c("seen_at"), true, SAFE_INTEGER_MAX)}
	WHEN (${c("owner_id")} IS NULL) <> (${c("kind")} = 'emoji') THEN 1
	WHEN (${c("account_id")} IS NULL) <> (${c("kind")} = 'emoji') THEN 1
	WHEN (${c("domain")} IS NULL) = (${c("kind")} = 'emoji') THEN 1
	WHEN (${c("token")} IS NULL) <> (${c("ext")} IS NULL) OR (${c("token")} IS NULL) <> (${c("stored_at")} IS NULL) THEN 1
	WHEN ${c("token")} IS NOT NULL AND (${c("due_at")} IS NOT NULL OR ${c("failed_at")} IS NOT NULL) THEN 1
	WHEN ${c("still_ext")} IS NOT NULL AND ${c("token")} IS NULL THEN 1
	WHEN ${c("failed_at")} IS NOT NULL AND ${c("due_at")} IS NOT NULL THEN 1
	ELSE 0 END`;
}

// True when `value` is no stored hosts list: NULL is one; else a JSON array of 1 to REMOTE_MEDIA_HOSTS link domains
// within REMOTE_MEDIA_HOSTS_BYTES bytes, judged in order (the storage class, the bytes, NUL, the JSON, each element).
export function remoteHostsPastSql(value: string): string {
  return `CASE WHEN ${value} IS NULL THEN 0
	WHEN typeof(${value}) <> 'text' THEN 1
	WHEN length(CAST(${value} AS BLOB)) > ${REMOTE_MEDIA_HOSTS_BYTES} THEN 1
	WHEN instr(CAST(${value} AS BLOB), x'00') > 0 THEN 1
	WHEN NOT json_valid(${value}) OR json_type(${value}) <> 'array' THEN 1
	WHEN json_array_length(${value}) NOT BETWEEN 1 AND ${REMOTE_MEDIA_HOSTS} THEN 1
	WHEN EXISTS (SELECT 1 FROM json_each(${value}) h WHERE h.type <> 'text' OR ${linkDomainPastSql("h.value")}) THEN 1
	ELSE 0 END`;
}

// True when the row `row` of remote_media_objects holds a value past its stored bound, then the invariants: a
// doomed object has a deletion time and no slot, a live one a slot and no deletion time; a stored object has its type
// and time, a reserved one neither; a still type only with a type.
export function remoteMediaObjectPastBoundSql(row: string): string {
  const c = (name: string) => `${row}.${name}`;
  return `CASE WHEN ${c("token")} IS NULL OR ${cardImageTokenPastSql(c("token"))} THEN 1
	WHEN ${c("slot_id")} IS NOT NULL AND (typeof(${c("slot_id")}) <> 'integer' OR ${c("slot_id")} NOT BETWEEN 1 AND ${SAFE_INTEGER_MAX}) THEN 1
	WHEN typeof(${c("state")}) <> 'text' OR ${c("state")} NOT IN ('reserved', 'stored', 'doomed') THEN 1
	${cardCountCase(c("charge"), false, SAFE_INTEGER_MAX)}
	WHEN typeof(${c("kind")}) <> 'text' OR ${c("kind")} NOT IN ${sqlList(REMOTE_MEDIA_KINDS)} THEN 1
	WHEN ${remoteTypePastSql(c("content_type"))} THEN 1
	WHEN ${remoteTypePastSql(c("still_type"))} THEN 1
	WHEN ${remoteHostsPastSql(c("hosts"))} THEN 1
	${cardCountCase(c("claimed_at"), false, SAFE_INTEGER_MAX)}
	${cardCountCase(c("stored_at"), true, SAFE_INTEGER_MAX)}
	${cardCountCase(c("due_at"), true, SAFE_INTEGER_MAX)}
	${cardCountCase(c("delete_attempts"), false, REMOTE_MEDIA_DELETE_ATTEMPTS)}
	WHEN (${c("state")} = 'doomed') <> (${c("due_at")} IS NOT NULL) THEN 1
	WHEN (${c("state")} = 'doomed') = (${c("slot_id")} IS NOT NULL) THEN 1
	WHEN ${c("state")} = 'stored' AND (${c("content_type")} IS NULL OR ${c("stored_at")} IS NULL) THEN 1
	WHEN ${c("state")} = 'reserved' AND (${c("content_type")} IS NOT NULL OR ${c("stored_at")} IS NOT NULL) THEN 1
	WHEN ${c("still_type")} IS NOT NULL AND ${c("content_type")} IS NULL THEN 1
	ELSE 0 END`;
}

// True when the usage row holds a value past its bound: the one row (id 1), its sums integers within range, the
// doomed bytes within the bytes.
export function remoteMediaUsagePastBoundSql(row: string): string {
  const c = (name: string) => `${row}.${name}`;
  return `CASE WHEN typeof(${c("id")}) <> 'integer' OR ${c("id")} <> 1 THEN 1
	${cardCountCase(c("bytes"), false, SAFE_INTEGER_MAX)}
	${cardCountCase(c("doomed"), false, SAFE_INTEGER_MAX)}
	${cardCountCase(c("pending"), false, SAFE_INTEGER_MAX)}
	WHEN ${c("doomed")} > ${c("bytes")} THEN 1
	ELSE 0 END`;
}
