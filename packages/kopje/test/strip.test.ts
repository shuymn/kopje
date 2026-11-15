import { describe, expect, it } from "vitest";

import { rubyStrip, stripEnds } from "../src/platform/strip";

// The strips' time is witnessed where each strips request or remote text (accounts, polls, error-pages and link-details
// tests).

describe("rubyStrip", () => {
  // Ruby 4.0's String#strip (Mastodon 4.7.5's image), over every code point at both ends: these and no others.
  it("strips exactly Ruby's set: NUL, tab, LF, VT, FF, CR and space", () => {
    const stripped: number[] = [];
    const altered: number[] = [];
    for (let point = 0; point <= 0x10ffff; point++) {
      if (point >= 0xd800 && point <= 0xdfff) {
        continue;
      }
      const c = String.fromCodePoint(point);
      const result = rubyStrip(`${c}x${c}`);
      if (result === "x") {
        stripped.push(point);
      } else if (result !== `${c}x${c}`) {
        altered.push(point);
      }
    }
    expect(stripped).toEqual([0x00, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20]);
    expect(altered).toEqual([]);
  });

  it.each([
    ["NUL and VT at either end", "\u0000\u000b a \u000b\u0000", "a"],
    ["NBSP and U+0085 kept", "\u00a0 a \u0085", "\u00a0 a \u0085"],
    ["a run inside kept", "\u0000a \t\u0000 b\u0000", "a \t\u0000 b"],
    ["all of the set", "\u0000\t\n\u000b\f\r ", ""],
    ["empty", "", ""],
    ["astral characters at the ends", " \u{1f600}\u0000\u{1f600} ", "\u{1f600}\u0000\u{1f600}"],
  ])("%s", (_name, value, expected) => {
    expect(rubyStrip(value)).toBe(expected);
  });
});

describe("stripEnds", () => {
  it("strips only the characters of its set, at either end", () => {
    expect(stripEnds(" \t\na\n\t ", " \t")).toBe("\na\n");
    expect(stripEnds("\t \t", " \t")).toBe("");
    expect(stripEnds("", " \t")).toBe("");
  });
});
