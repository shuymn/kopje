import { LinkifyIt } from "linkify-it";

import { storedText } from "../platform/stored-bounds";
import { cutCodeUnits } from "../security/html";
import { escapeHtml } from "./plain-text";
import { normalizeTag } from "./tag-name";

// Plain status text to safe HTML, as Mastodon 4's TextFormatter does: everything is escaped; http(s) URLs, mentions
// of known accounts and hashtags become links; blank lines separate paragraphs and single newlines become <br />.
// URLs are found by linkify-it (no hand-written URL pattern); mentions and hashtags use Mastodon's own patterns. The
// source text is kept separately (statuses.source_text) for /source and editing.

// Only absolute http(s) links, as Mastodon (extract_url_without_protocol: false). No fuzzy links, emails, ftp or //.
const linkify = new LinkifyIt({ fuzzyLink: false, fuzzyEmail: false, fuzzyIP: false })
  .add("ftp:", null)
  .add("mailto:", null)
  .add("//", null);

// Ruby's [[:word:]] and [[:alpha:]] under Unicode.
const WORD = "\\p{L}\\p{M}\\p{Nd}\\p{Pc}";
const ALPHA = "\\p{L}\\p{M}";
const TAG_SEPARATORS = "_\\u00B7\\u30FB\\u200C";

// Account::MENTION_RE: @user or @user@domain, not preceded by a word character, = or /.
const MENTION = `(?<![=/${WORD}])@([a-z0-9_]+(?:[a-z0-9_.-]+[a-z0-9_]+)?)(?:@([${WORD}.-]+[${WORD}]+))?`;
// Tag::HASHTAG_NAME_PAT, and Tag::HASHTAG_RE: #name or ＃name at the text's start or after whitespace (Ruby's
// [[:space:]] is White_Space, which holds U+0085 and not U+FEFF, unlike JavaScript's \s; Mastodon 4.7.5, tag.rb:44).
// Without the m flag, ^ is the text's start; a newline is White_Space, as after Ruby's line-start ^.
const HASHTAG_NAME = `[${WORD}_][${WORD}${TAG_SEPARATORS}]*[${ALPHA}${TAG_SEPARATORS}][${WORD}${TAG_SEPARATORS}]*[${WORD}_]|[${WORD}_]*[${ALPHA}][${WORD}_]*`;
const HASHTAG = `(?<=^|\\p{White_Space})[#＃](${HASHTAG_NAME})`;
const ENTITY = new RegExp(`${MENTION}|${HASHTAG}`, "giu");
const HASHTAG_NAME_ONLY = new RegExp(`^(?:${HASHTAG_NAME})$`, "iu");

// Bounds on the raw input, checked before anything is parsed. statusLength counts a URL as 23 characters and a remote
// mention by its username, so the counted 500 characters say nothing about the size of the raw text: without a bound,
// a status padded with long URLs or mention domains could be as large as the request body. Every path that takes
// status text (posting, editing) refuses text and spoiler longer than this together, with Mastodon's length error.
// 20 UTF-16 code units per counted character leaves room for 500 graphemes of long emoji sequences.
export const MAX_RAW_LENGTH = 10_000;
// twitter-text's maximum URL length: a longer run is not a link (and is counted as text).
export const MAX_URL_LENGTH = 4096;

export function exceedsRawLength(text: string, spoilerText: string): boolean {
  return text.length + spoilerText.length > MAX_RAW_LENGTH;
}

// StatusLengthValidator::MAX_CHARS: the most a local status's counted length (statusLength) may be.
export const MAX_STATUS_CHARACTERS = 500;

// ActiveSupport's String#blank? (/\A[[:space:]]*\z/; [[:space:]] under Unicode, as Ruby has it), over the text as
// it is stored (storedText): U+0085 is blank and U+FEFF is not, where JavaScript's trim() has it the other way.
const BLANK = /^[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/;

export function blankText(text: string): boolean {
  return BLANK.test(storedText(text));
}

export type MentionRef = { username: string; domain: string | null };

export type Segment =
  | { kind: "text"; text: string }
  | { kind: "url"; url: string; text: string }
  | { kind: "mention"; username: string; domain: string | null; text: string }
  | { kind: "tag"; name: string; text: string };

export type ParsedText = { segments: Segment[]; mentions: MentionRef[]; tags: string[] };

// Throws on text over MAX_RAW_LENGTH: callers check exceedsRawLength first, so nothing unbounded is ever parsed.
export function parseStatusText(source: string): ParsedText {
  if (source.length > MAX_RAW_LENGTH) {
    throw new RangeError(`status text over ${MAX_RAW_LENGTH} code units`);
  }
  const text = source.replace(/\r\n?/g, "\n");
  const segments: Segment[] = [];
  let at = 0;
  for (const match of linkify.match(text) ?? []) {
    if (match.raw.length > MAX_URL_LENGTH) {
      continue;
    }
    pushEntities(text, at, match.index, segments);
    segments.push({ kind: "url", url: match.url, text: match.raw });
    at = match.lastIndex;
  }
  pushEntities(text, at, text.length, segments);
  const mentions = new Map<string, MentionRef>();
  const tags = new Set<string>();
  for (const segment of segments) {
    if (segment.kind === "mention") {
      mentions.set(mentionKey(segment), { username: segment.username, domain: segment.domain });
    } else if (segment.kind === "tag") {
      tags.add(normalizeTag(segment.name));
    }
  }
  return { segments, mentions: [...mentions.values()], tags: [...tags] };
}

// The mentions and hashtags of text[start, end) between URLs. They are matched on the whole text before `end`, from
// `start`, so a lookbehind sees the character before the slice (the end of a URL), as Mastodon's extractor scans the
// whole text: a hashtag starts a slice only at the text's start or after whitespace.
function pushEntities(text: string, start: number, end: number, out: Segment[]): void {
  const entity = new RegExp(ENTITY, "giu");
  entity.lastIndex = start;
  let at = start;
  for (const match of text.slice(0, end).matchAll(entity)) {
    const [raw, username, domain, tag] = match;
    if (match.index > at) {
      out.push({ kind: "text", text: text.slice(at, match.index) });
    }
    if (username !== undefined) {
      out.push({ kind: "mention", username, domain: domain === undefined ? null : normalizeDomain(domain), text: raw });
    } else if (tag !== undefined && normalizeTag(tag) !== "") {
      out.push({ kind: "tag", name: tag, text: raw });
    } else {
      // A name of characters a hashtag cannot hold (a lone combining mark) normalizes to nothing: it is text.
      out.push({ kind: "text", text: raw });
    }
    at = match.index + raw.length;
  }
  if (at < end) {
    out.push({ kind: "text", text: text.slice(at, end) });
  }
}

// IDN domains compare in their ASCII form; anything the URL parser rejects stays lowercased as written.
function normalizeDomain(domain: string): string {
  try {
    return new URL(`https://${domain}`).hostname;
  } catch {
    return domain.toLowerCase();
  }
}

// The key two mentions of the same account share.
export function mentionKey(mention: MentionRef): string {
  return `${mention.username.toLowerCase()}@${mention.domain ?? ""}`;
}

// Tag::HASHTAG_NAME_RE: whether `name` (without #) is a hashtag name. A status holds at most 500 characters, so no
// hashtag is longer than 1,000 UTF-16 code units, and the pattern never runs on more than that (RES-2).
const MAX_HASHTAG_NAME_LENGTH = 1000;

export function isHashtagName(name: string): boolean {
  return name.length <= MAX_HASHTAG_NAME_LENGTH && HASHTAG_NAME_ONLY.test(name);
}

// A resolved mention: the account's profile URL and username. Unresolved mentions stay text.
export type MentionTarget = { url: string; username: string };

export type RenderOptions = {
  // The account a mention resolved to, by mentionKey, or undefined.
  mention: (mention: MentionRef) => MentionTarget | undefined;
  tagUrl: (name: string) => string;
};

// One segment's inline HTML, before paragraphs (renderStatusHtml): text escaped, a URL, a resolved mention or a
// hashtag as its link.
export function renderSegmentHtml(segment: Segment, options: RenderOptions): string {
  switch (segment.kind) {
    case "text":
      return escapeHtml(segment.text);
    case "url":
      return linkHtml(segment.url);
    case "mention": {
      const target = options.mention(segment);
      return target === undefined
        ? escapeHtml(segment.text)
        : `<span class="h-card"><a href="${escapeHtml(target.url)}" class="u-url mention">@<span>${escapeHtml(target.username)}</span></a></span>`;
    }
    case "tag":
      return `<a href="${escapeHtml(options.tagUrl(normalizeTag(segment.name)))}" class="mention hashtag" rel="tag">#<span>${escapeHtml(segment.name)}</span></a>`;
  }
}

export function renderStatusHtml(segments: readonly Segment[], options: RenderOptions): string {
  const inline = segments.map((segment) => renderSegmentHtml(segment, options)).join("");
  // Every newline left in the output comes from text segments, so paragraphs can be cut on the rendered HTML.
  return inline
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "")
    .map((paragraph) => `<p>${paragraph.replace(/\n/g, "<br />")}</p>`)
    .join("");
}

// A local profile field value (HTML-2): escaped, with absolute http(s) URLs linked as in statuses. Mentions and
// hashtags stay text. Values are short (MAX_FIELD_VALUE), so this never reaches the raw bound.
export function renderFieldValue(value: string): string {
  return parseStatusText(cutCodeUnits(value, MAX_RAW_LENGTH))
    .segments.map((segment) => (segment.kind === "url" ? linkHtml(segment.url) : escapeHtml(segment.text)))
    .join("");
}

// TextFormatter#add_quote_fallback: the RE: line a quote's content starts with, linking the quoted status, for clients
// that do not show quotes (the class lets the others hide it, as the sanitizer keeps it: security/html.ts).
export function quoteFallbackHtml(url: string): string {
  return `<p class="quote-inline">RE: ${linkHtml(url)}</p>`;
}

// Whether the text links one of `urls` (a URL segment exactly one of them): its quote then needs no RE: line.
export function linksAny(segments: readonly Segment[], urls: readonly string[]): boolean {
  return segments.some((segment) => segment.kind === "url" && urls.includes(segment.url));
}

const DISPLAY_LIMIT = 30;

// Mastodon's link display: the scheme (and www.) hidden, the rest cut with an ellipsis after 30 characters. Also a
// verified remote field's value (accounts.ts remoteFields, Mastodon's TextFormatter.shortened_link).
export function linkHtml(url: string): string {
  const prefix = /^https?:\/\/(?:www\.)?/i.exec(url)?.[0] ?? "";
  const rest = url.slice(prefix.length);
  const shown = cutCodeUnits(rest, DISPLAY_LIMIT);
  const hidden = rest.slice(shown.length);
  const display =
    `<span class="invisible">${escapeHtml(prefix)}</span>` +
    `<span class="${hidden === "" ? "" : "ellipsis"}">${escapeHtml(shown)}</span>` +
    `<span class="invisible">${escapeHtml(hidden)}</span>`;
  return `<a href="${escapeHtml(url)}" target="_blank" rel="nofollow noopener noreferrer">${display}</a>`;
}

const URL_PLACEHOLDER_LENGTH = 23;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemeLength(text: string): number {
  const segments = graphemes.segment(text)[Symbol.iterator]();
  let count = 0;
  while (!segments.next().done) {
    count++;
  }
  return count;
}

// StatusLengthValidator (for text within MAX_RAW_LENGTH): the grapheme count of the warning followed by the countable
// text, as one string (combined_text), so a combining mark that starts the text joins the warning's last grapheme. The
// countable text (countable_text) of a blank text is empty; otherwise a URL counts as 23 characters and a remote
// mention as its local part only.
export function statusLength(text: string, spoilerText: string): number {
  const countable = blankText(text)
    ? ""
    : parseStatusText(text)
        .segments.map((segment) => {
          switch (segment.kind) {
            case "url":
              return "x".repeat(URL_PLACEHOLDER_LENGTH);
            case "mention":
              return `@${segment.username}`;
            default:
              return segment.text;
          }
        })
        .join("");
  return graphemeLength(spoilerText + countable);
}
