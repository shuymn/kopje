import { MAX_FIELD_NAME, MAX_FIELD_VALUE, MAX_FIELDS, VERIFIED_AT_JSON_BYTES } from "../src/domain/accounts";
import { jsonBytes } from "../src/domain/answer-budget";

// The most JSON a local account's fields present (RES-3), from their caps: test/status-bounds.test.ts holds the
// account occurrence and test/profile-api.test.ts the Profile to them.

const C = "\u0001";

// A local field value at its bound that renderFieldValue links: a URL of MAX_FIELD_VALUE code units, its path '&'.
export function localLinkValue(i: number): string {
  const prefix = `https://x.test/${i}`;
  return prefix + "&".repeat(MAX_FIELD_VALUE - prefix.length);
}

// The most JSON a local field value presents (renderFieldValue and linkHtml, src/domain/status-text.ts): every code
// unit at most twice (in a link's href and its shown text) as an HTML escape of at most six ASCII bytes (&quot;),
// which JSON keeps, and each link's markup once (its quotes escaped by JSON); a link holds at least 'http://' and a
// host character, and a separator from the next, so a value of MAX_FIELD_VALUE code units holds at most
// (MAX_FIELD_VALUE + 1) / 9 of them.
const LINK_MARKUP =
  '<a href="" target="_blank" rel="nofollow noopener noreferrer"><span class="invisible"></span><span class="ellipsis">' +
  '</span><span class="invisible"></span></a>';
export const LOCAL_FIELD_VALUE_JSON_MAX =
  2 + 12 * MAX_FIELD_VALUE + (jsonBytes(LINK_MARKUP) - 2) * Math.floor((MAX_FIELD_VALUE + 1) / ("http://".length + 2));

// The most JSON a local account's fields present: MAX_FIELDS names of control characters (six bytes each), each value
// at LOCAL_FIELD_VALUE_JSON_MAX and verified (VERIFIED_AT_JSON_BYTES).
export const LOCAL_FIELDS_JSON_MAX =
  jsonBytes(
    Array.from({ length: MAX_FIELDS }, () => ({ name: C.repeat(MAX_FIELD_NAME), value: "", verified_at: "" })),
  ) +
  MAX_FIELDS * (LOCAL_FIELD_VALUE_JSON_MAX - 2 + VERIFIED_AT_JSON_BYTES - 2);
