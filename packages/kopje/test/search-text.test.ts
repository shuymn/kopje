import { describe, expect, it } from "vitest";

import { normalizeSearchText, queryTerms } from "../src/domain/search-text";

// The ranges search_text's patterns name, each at its ends and one past them.
const around = (first: number, last: number) => [first - 1, first, first + 1, last - 1, last, last + 1];
const char = (code: number) => String.fromCharCode(code);
const within = (code: number, first: number, last: number) => code >= first && code <= last;

describe("search text", () => {
  it("removes the variation selectors U+FE00 to U+FE0F and keeps the characters beside them", () => {
    for (const code of around(0xfe00, 0xfe0f)) {
      const text = `a${char(code)}b`;
      expect(normalizeSearchText(text)).toBe(within(code, 0xfe00, 0xfe0f) ? "ab" : text.normalize("NFKC"));
    }
  });

  it("adds the katakana of U+3041 to U+3096 and the hiragana of U+30A1 to U+30F6, and nothing for their neighbours", () => {
    for (const code of around(0x3041, 0x3096)) {
      expect(queryTerms(char(code))).toEqual([
        within(code, 0x3041, 0x3096) ? [char(code), char(code + 0x60)] : [char(code)],
      ]);
    }
    for (const code of around(0x30a1, 0x30f6)) {
      expect(queryTerms(char(code))).toEqual([
        within(code, 0x30a1, 0x30f6) ? [char(code), char(code - 0x60)] : [char(code)],
      ]);
    }
  });

  it("adds a word ending in U+30FC without it only after U+30A1 to U+30FA, and only for U+30FC", () => {
    for (const code of around(0x30a1, 0x30fa)) {
      const term = `${char(code)}\u30FC\u30FC`;
      const hiragana = within(code, 0x30a1, 0x30f6) ? [`${char(code - 0x60)}\u30FC\u30FC`] : [];
      expect(queryTerms(term)).toEqual([within(code, 0x30a1, 0x30fa) ? [term, ...hiragana, char(code)] : [term]]);
    }
    for (const mark of [0x30fb, 0x30fd]) {
      expect(queryTerms(`\u30AB${char(mark)}`)).toEqual([[`\u30AB${char(mark)}`, `\u304B${char(mark)}`]]);
    }
  });
});
