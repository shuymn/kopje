import { describe, expect, it } from "vitest";

// docs/mastodon-deviations.md, "Streaming.": what one character of a media description adds to a stream payload, the
// presented subject's JSON encoded again as a JSON string (stream-hub.ts), in UTF-8 bytes. U+0000 is left out: no
// stored description holds it (storedText removes it).

const ENCODER = new TextEncoder();

// The character's bytes inside the payload: encoded as JSON, then again as a JSON string, less the second quotes.
const twice = (char: string) => ENCODER.encode(JSON.stringify(JSON.stringify(char).slice(1, -1))).length - 2;

// The class D8 of #1584 states for a scalar value.
function stated(code: number): number {
  if (code === 0x22 || code === 0x5c || code > 0xffff) {
    return 4;
  }
  if ([0x08, 0x09, 0x0a, 0x0c, 0x0d].includes(code)) {
    return 3;
  }
  if (code < 0x20) {
    return 7;
  }
  return code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
}

describe("a description's characters in a stream payload", () => {
  it("take 1 to 4 bytes, and 7 for a C0 control", () => {
    const counts = new Map<number, number>();
    const differing: string[] = [];
    for (let code = 1; code <= 0x10ffff; code++) {
      if (code >= 0xd800 && code <= 0xdfff) {
        continue;
      }
      const bytes = twice(String.fromCodePoint(code));
      counts.set(bytes, (counts.get(bytes) ?? 0) + 1);
      if (bytes !== stated(code)) {
        differing.push(code.toString(16));
      }
    }
    expect(differing).toEqual([]);
    // Every scalar value but U+0000 and the surrogates, by its bytes.
    expect(Object.fromEntries([...counts].toSorted(([a], [b]) => a - b))).toEqual({
      1: 94,
      2: 1_920,
      3: 61_445,
      4: 1_048_578,
      7: 26,
    });
    expect([twice("\u0001"), twice("\u{1F600}"), twice("あ"), twice("a")]).toEqual([7, 4, 3, 1]);
  });
});
