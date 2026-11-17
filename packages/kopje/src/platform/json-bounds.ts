// Structural bounds of a parsed JSON document from a remote server (RES-2). The body bound (1 MiB) caps the bytes, not
// the work: a megabyte of nested arrays or tiny objects costs JSON-LD expansion far more than a real actor or note does.
// Every inbound activity and every fetched document is checked before it is read or handed to JSON-LD, so one
// activity's processing is bounded by REQUEST_MAX_FETCHES documents of at most these sizes.
//
// A JSON text whose string token, a key or a value, holds an unpaired surrogate does not parse (jsonTextMalformed):
// Mastodon's parser (json 2.21.2, json_string_unescape) raises on a high surrogate not followed by a low one, wherever
// the token sits, a member a later duplicate key replaces included; Kopje refuses a lone low surrogate too, which that
// parser keeps as invalid UTF-8 (docs/mastodon-deviations.md, "Reading inbound activities"). It is judged on the text,
// since JSON.parse keeps only the last of duplicate keys. After UTF-8 decoding (TextDecoder replaces what is not
// UTF-8) only a \u escape gives one; a raw one in a text from elsewhere is read too.

// Values (objects, arrays and scalars) in one document. A Mastodon actor or note has a few hundred.
export const MAX_JSON_NODES = 10_000;
// Nesting depth. Real documents nest a handful of levels.
export const MAX_JSON_DEPTH = 32;

// Why a document is refused: past either bound, or holding an unpaired surrogate.
export type JsonRefusal = "too-complex" | "malformed";

// The first refusal the walk over a parsed document meets, or null: past MAX_JSON_NODES values or MAX_JSON_DEPTH
// levels, or a string or key holding an unpaired surrogate (a value with no text left to read, such as a cached
// context; a text is read by jsonTextMalformed first). The walk stops there, so its cost is bounded by the bounds'
// visits and one native pass over each string and key it visits.
export function jsonRefusal(document: unknown): JsonRefusal | null {
  // Counted when a value is reached, so the stack never holds more than MAX_JSON_NODES entries.
  let nodes = 1;
  const stack: [unknown, number][] = [[document, 1]];
  while (stack.length > 0) {
    const [value, depth] = stack.pop() as [unknown, number];
    if (depth > MAX_JSON_DEPTH) {
      return "too-complex";
    }
    if (typeof value === "string") {
      if (!value.isWellFormed()) {
        return "malformed";
      }
      continue;
    }
    if (typeof value !== "object" || value === null) {
      continue;
    }
    for (const key in value) {
      if (++nodes > MAX_JSON_NODES) {
        return "too-complex";
      }
      if (!key.isWellFormed()) {
        return "malformed";
      }
      stack.push([(value as Record<string, unknown>)[key], depth + 1]);
    }
  }
  return null;
}

// Whether the document stays within the bounds and holds no unpaired surrogate.
export function withinJsonBounds(document: unknown): boolean {
  return jsonRefusal(document) === null;
}

// A surrogate's \u escape, in either case.
const SURROGATE_ESCAPE = /\\u[dD][89a-fA-F]/;

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const LETTER_U = 0x75;
const isHigh = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const isLow = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;

// Whether a JSON text JSON.parse accepted holds a string token, a key or a value, whose code units (each raw one, or
// the one its escape gives) are not well-formed: a high surrogate not followed by a low one, or a low one not preceded
// by a high one. One pass over the text, which a native check skips when the text holds neither a lone surrogate nor a
// surrogate escape.
export function jsonTextMalformed(text: string): boolean {
  if (text.isWellFormed() && !SURROGATE_ESCAPE.test(text)) {
    return false;
  }
  let inString = false;
  let high = false;
  for (let i = 0; i < text.length; i++) {
    let unit = text.charCodeAt(i);
    if (!inString) {
      inString = unit === QUOTE;
      continue;
    }
    if (unit === QUOTE) {
      if (high) {
        return true;
      }
      inString = false;
      continue;
    }
    if (unit === BACKSLASH) {
      unit = text.charCodeAt(++i);
      if (unit === LETTER_U) {
        unit = Number.parseInt(text.slice(i + 1, i + 5), 16);
        i += 4;
      }
    }
    if (high) {
      if (!isLow(unit)) {
        return true;
      }
      high = false;
    } else if (isHigh(unit)) {
      high = true;
    } else if (isLow(unit)) {
      return true;
    }
  }
  return high;
}
