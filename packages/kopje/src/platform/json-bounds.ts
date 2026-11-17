// Structural bounds of a parsed JSON document from a remote server (RES-2). The body bound (1 MiB) caps the bytes, not
// the work: a megabyte of nested arrays or tiny objects costs JSON-LD expansion far more than a real actor or note does.
// Every inbound activity and every fetched document is checked before it is read or handed to JSON-LD, so one
// activity's processing is bounded by REQUEST_MAX_FETCHES documents of at most these sizes.
//
// The same walk refuses a string or a key holding an unpaired surrogate as JSON that does not parse. After UTF-8
// decoding (TextDecoder replaces what is not UTF-8) only a \u escape gives one, and Mastodon's parser (json 2.21.2,
// json_string_unescape) raises on a high surrogate not followed by a low one; Kopje refuses a lone low surrogate too,
// which that parser keeps as invalid UTF-8 (docs/mastodon-deviations.md, "Reading inbound activities").

// Values (objects, arrays and scalars) in one document. A Mastodon actor or note has a few hundred.
export const MAX_JSON_NODES = 10_000;
// Nesting depth. Real documents nest a handful of levels.
export const MAX_JSON_DEPTH = 32;

// Why a document is refused: past either bound, or holding an unpaired surrogate.
export type JsonRefusal = "too-complex" | "malformed";

// The first refusal the walk meets, or null. The walk stops there, so its cost is bounded by the bounds' visits and
// one pass over each string and key it visits.
function walk(document: unknown, maxNodes: number, maxDepth: number): JsonRefusal | null {
  // Counted when a value is reached, so the stack never holds more than maxNodes entries.
  let nodes = 1;
  const stack: [unknown, number][] = [[document, 1]];
  while (stack.length > 0) {
    const [value, depth] = stack.pop() as [unknown, number];
    if (depth > maxDepth) {
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
      if (++nodes > maxNodes) {
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

// The refusal of a parsed remote document, within MAX_JSON_NODES values and MAX_JSON_DEPTH levels.
export function jsonRefusal(document: unknown): JsonRefusal | null {
  return walk(document, MAX_JSON_NODES, MAX_JSON_DEPTH);
}

// Whether the document stays within the bounds and holds no unpaired surrogate.
export function withinJsonBounds(document: unknown): boolean {
  return jsonRefusal(document) === null;
}

// Whether a parsed document holds no unpaired surrogate, for a caller without the structural bounds: the walk is then
// bounded by the text the document was parsed from.
export function wellFormedJson(document: unknown): boolean {
  return walk(document, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY) === null;
}
