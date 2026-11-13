import { describe, expect, it } from "vitest";

import { blocks, codeSpans } from "./code-spans.js";

const contents = (text: string) => codeSpans(text).map(({ content }) => content);

describe("code spans", () => {
  it("closes a run only at a run of the same length, and leaves an unclosed or escaped run literal", () => {
    expect(contents("``a ` b`` and `c`")).toEqual(["a ` b", "c"]);
    expect(contents("``x` and `y`")).toEqual(["and"]);
    expect(contents("\\`x` `y`")).toEqual([" "]);
  });

  it("strips one space from each side only when the content holds something other than a space", () => {
    expect(contents("` \t `")).toEqual(["\t"]);
    expect(contents("` \u00a0 `")).toEqual(["\u00a0"]);
    expect(contents("`  `")).toEqual(["  "]);
    expect(contents("`` `a` ``")).toEqual(["`a`"]);
    expect(contents("`a\nb`")).toEqual(["a b"]);
  });

  it("splits blocks at blank lines, list items and headings, and keeps a paragraph's lines", () => {
    expect(blocks("one\ntwo\n\n- three\n  four\n1. five\n# six\nseven")).toEqual([
      "one\ntwo",
      "- three\n  four",
      "1. five",
      "# six",
      "seven",
    ]);
  });
});
