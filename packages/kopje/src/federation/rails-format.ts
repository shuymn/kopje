import { rubyStrip } from "../platform/strip";

// The representation Mastodon 4.7.5 gives a request, from its Accept, X-Requested-With and Content-Type, at a
// controller that serves both a page and a document (`respond_to { format.html; format.json }`): "html" when
// request.format.html? or respond_to picks html, "json" when it picks json, and "none" when it picks neither
// (ActionController::UnknownFormat) or a type cannot be read (Mime::Type::InvalidMimeType), both 406. Rails 8.1.3.1's
// actionpack: MimeNegotiation#formats with no format parameter or path extension (Kopje reads neither),
// Mime::Type.parse with AcceptList.sort!, and negotiate_mime; the types as Rails and Mastodon's
// config/initializers/mime_types.rb register them.
export type RailsFormat = "html" | "json" | "none";

// The request's headers, as the Worker reads them: each byte one char (a ByteString).
export type RailsRequest = {
  accept: string | undefined;
  requestedWith: string | undefined;
  contentType: string | undefined;
};

// Ruby's \s, which String#strip also removes (and NUL, which a header value never holds). Puma passes a header value
// as an ASCII-8BIT String, whose blank? ([[:space:]]) is these too: an NBSP (C2 A0 or A0) is a character, not blank.
const SPACE = "[\\t\\n\\v\\f\\r ]";
const BLANK = new RegExp(`^${SPACE}*$`);
// Request#xhr?.
const XHR = /XMLHttpRequest/i;
// MimeNegotiation's BROWSER_LIKE_ACCEPTS: a list naming */* is read as a browser's, which gets HTML.
const BROWSER_LIKE = new RegExp(`,${SPACE}*\\*/\\*|\\*/\\*${SPACE}*,`);
const Q_SEPARATOR = new RegExp(`;${SPACE}*q="?`);
const ITEM = /[^,\t\n\v\f\r "](?:[^,"]|"[^"]*")*/g;
const TRAILING_STAR = /^(text|application)\/\*/m;
// Mime::Type's MIME_REGEXP for a type without parameters (lookup reads the type before its first `;`).
const NAME = "[a-zA-Z0-9][a-zA-Z0-9!#$&\\-^_.+]{0,126}";
const MIME = new RegExp(`^(?:\\*/\\*|${NAME}/(?:\\*|${NAME}))$`);
// The number String#to_f (Ruby 4.0) reads from the start of a q: `_` only between digits, the digits after the point
// optional, an exponent only after a digit.
const FLOAT = new RegExp(
  `^${SPACE}*([+-]?(?:\\d+(?:_\\d+)*)?(?:\\.(?:\\d+(?:_\\d+)*)?)?)(?:[eE]([+-]?\\d+(?:_\\d+)*))?`,
);

type Format = "html" | "json" | "other";

// Mime::LOOKUP: every registered type and synonym, by its exact string.
const HTML_TYPES = ["text/html", "application/xhtml+xml"];
const JSON_TYPES = [
  "application/json",
  "text/x-json",
  "application/jsonrequest",
  "application/problem+json",
  "application/jrd+json",
  "application/activity+json",
  "application/ld+json",
];
const OTHER_TYPES = [
  "text/plain",
  "text/javascript",
  "application/javascript",
  "application/x-javascript",
  "text/css",
  "text/calendar",
  "text/csv",
  "text/vcard",
  "text/vtt",
  "vtt",
  "text/markdown",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/bmp",
  "image/tiff",
  "image/svg+xml",
  "image/webp",
  "video/mpeg",
  "audio/mpeg",
  "audio/ogg",
  "audio/aac",
  "audio/mp4",
  "video/webm",
  "video/mp4",
  "font/otf",
  "font/ttf",
  "font/woff",
  "font/woff2",
  "application/xml",
  "text/xml",
  "application/x-xml",
  "application/rss+xml",
  "application/atom+xml",
  "application/x-yaml",
  "text/yaml",
  "multipart/form-data",
  "application/x-www-form-urlencoded",
  "application/pdf",
  "application/zip",
  "application/gzip",
  "application/x-gzip",
  "application/xrd+xml",
];
const LOOKUP = new Map<string, Format>([
  ...HTML_TYPES.map((type) => [type, "html"] as const),
  ...JSON_TYPES.map((type) => [type, "json"] as const),
  ...OTHER_TYPES.map((type) => [type, "other"] as const),
]);

// parse_data_with_trailing_star: the registered types naming `text` or `application`, in Mime::SET's order.
const STARRED: Readonly<Record<string, readonly string[]>> = {
  text: [
    "text/html",
    "text/plain",
    "text/javascript",
    "text/css",
    "text/calendar",
    "text/csv",
    "text/vcard",
    "text/vtt",
    "text/markdown",
    "application/xml",
    "application/x-yaml",
    "application/json",
    "application/json",
    "text/xml",
  ],
  application: [
    "text/html",
    "text/javascript",
    "application/xml",
    "application/rss+xml",
    "application/atom+xml",
    "application/x-yaml",
    "application/x-www-form-urlencoded",
    "application/json",
    "application/pdf",
    "application/zip",
    "application/gzip",
    "application/json",
    "text/xml",
  ],
};

// AcceptItem's q: String#to_f × 100, truncated; a */* without one sorts last (0), any other range 100.
function weight(name: string, q: string | undefined): number {
  if (q === undefined) {
    return name === "*/*" ? 0 : 100;
  }
  const [, mantissa = "", exponent] = FLOAT.exec(q)!;
  const digits = /\d/.test(mantissa);
  const value = digits ? Number(`${mantissa}${exponent === undefined ? "" : `e${exponent}`}`.replaceAll("_", "")) : 0;
  return Math.trunc(value * 100);
}

function starred(type: string): readonly string[] | null {
  const star = TRAILING_STAR.exec(type)?.[1];
  return star === undefined ? null : STARRED[star]!;
}

// Mime::Type.lookup: the registered type of the exact string, or of the type before its first `;`; else a type of its
// own, which formats drops unless it is */* ("all"); null when that is no MIME type (InvalidMimeType).
function lookup(name: string): Format | "all" | "dropped" | null {
  const exact = LOOKUP.get(name);
  if (exact !== undefined) {
    return exact;
  }
  // A name has nothing to strip at its start, so this is String#rstrip.
  const base = rubyStrip(name.split(";", 1)[0]!);
  const registered = LOOKUP.get(base);
  if (registered !== undefined) {
    return registered;
  }
  if (!MIME.test(base)) {
    return null;
  }
  return base === "*/*" ? "all" : "dropped";
}

// Mime::Type.parse's names, in AcceptList.sort!'s order: by q, then as written; with Mastodon's :xml (text/xml), the
// text/xml range is deleted and the range after it moves behind the +xml ranges that follow it at no lower q.
function names(header: string): string[] {
  if (!header.includes(",")) {
    const cut = header.search(Q_SEPARATOR);
    const type = cut === -1 ? header : rubyStrip(header.slice(0, cut));
    return BLANK.test(type) ? [] : [...(starred(type) ?? [type])];
  }
  const items: { index: number; name: string; q: number }[] = [];
  for (const raw of header.match(ITEM) ?? []) {
    const parts = raw.split(Q_SEPARATOR);
    while (parts.at(-1) === "") {
      parts.pop();
    }
    const type = rubyStrip(parts[0] ?? "");
    if (type === "") {
      continue;
    }
    for (const name of starred(type) ?? [type]) {
      items.push({ index: items.length, name, q: weight(name, parts[1]) });
    }
  }
  items.sort((a, b) => b.q - a.q || a.index - b.index);
  const xml = items.findIndex((item) => item.name === "text/xml");
  if (xml !== -1) {
    items.splice(xml, 1);
    const moved = items[xml];
    let at = xml;
    for (let i = xml; moved !== undefined && i < items.length && items[i]!.q >= moved.q; i++) {
      if (items[i]!.name.endsWith("+xml")) {
        items[at] = items[i]!;
        items[i] = moved;
        at = i;
      }
    }
  }
  return items.map((item) => item.name);
}

// content_mime_type: the type before the Content-Type's first `,` or `;`, stripped and ASCII-downcased (the value is
// bytes); undefined without the header.
function contentMime(header: string | undefined): ReturnType<typeof lookup> | undefined {
  if (header === undefined) {
    return undefined;
  }
  return lookup(rubyStrip(header.split(/[,;]/, 1)[0]!).replace(/[A-Z]+/g, (upper) => upper.toLowerCase()));
}

// MimeNegotiation#formats: the Accept's types when valid_accept_header (an XHR's present Accept, or its Content-Type's
// type without one; any other present Accept not BROWSER_LIKE), else Mime[:js] for an XHR and Mime[:html] otherwise.
function formatsOf(request: RailsRequest): ReturnType<typeof lookup>[] {
  const accept = request.accept ?? "";
  const present = !BLANK.test(accept);
  const xhr = XHR.test(request.requestedWith ?? "");
  if (xhr && !present) {
    return [contentMime(request.contentType) ?? "other"];
  }
  if (present && (xhr || !BROWSER_LIKE.test(accept))) {
    return names(rubyStrip(accept)).map(lookup);
  }
  return ["html"];
}

export function railsFormat(request: RailsRequest): RailsFormat {
  const formats = formatsOf(request);
  if (formats.includes(null)) {
    return "none";
  }
  // request.format.html? for the first; else negotiate_mime([html, json]), which takes */* as the first of them.
  for (const format of formats) {
    if (format === "html" || format === "all") {
      return "html";
    }
    if (format === "json") {
      return "json";
    }
  }
  return "none";
}
