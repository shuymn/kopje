import { MAX_NOTE } from "../src/domain/accounts";
import { MAX_RAW_LENGTH, MAX_URL_LENGTH } from "../src/domain/status-text";

// Local notes at the writer's bounds (E5 of #1606): MAX_RAW_LENGTH UTF-16 code units that noteLength counts as
// MAX_NOTE.

// A link noteLength counts as 23 characters, of MAX_URL_LENGTH code units: https://example.com/ and '&', which the
// stored HTML escapes to `&amp;` (a "'" would end the link where no letter follows it, as linkify-it reads it).
const LINK = "https://example.com/".padEnd(MAX_URL_LENGTH, "&");
// Two links and the spaces after each: the first counts 23, the second 23 with the space before it, the last space 1.
const LINKS = `${LINK} ${LINK} `;
const LINKS_COUNTED = 47;

// The widest note: the two links, then MAX_NOTE - 47 clusters of '"' (`&quot;`, six bytes) and combining voiced sound
// marks (U+3099, three bytes), which a grapheme segmenter joins to it, up to MAX_RAW_LENGTH. Its stored JSON is within
// the writer's worst, 6 x MAX_RAW_LENGTH + 9 bytes (test/account-text-bounds.test.ts).
export const WIDEST_NOTE = (() => {
  const clusters = MAX_NOTE - LINKS_COUNTED;
  const marks = MAX_RAW_LENGTH - LINKS.length - clusters;
  return (
    LINKS +
    Array.from({ length: clusters }, (_, i) => {
      const share = Math.floor(marks / clusters) + (i < marks % clusters ? 1 : 0);
      return `"${"゙".repeat(share)}`;
    }).join("")
  );
})();

// The plain note at the raw bound: MAX_NOTE clusters of 20 code units, each a three-byte character neither HTML nor
// JSON escapes (あ and 19 U+3099).
export const PLAIN_NOTE = `あ${"゙".repeat(MAX_RAW_LENGTH / MAX_NOTE - 1)}`.repeat(MAX_NOTE);
