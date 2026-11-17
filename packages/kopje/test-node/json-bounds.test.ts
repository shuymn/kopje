import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { jsonRefusal, jsonTextMalformed, MAX_JSON_DEPTH, MAX_JSON_NODES } from "../src/platform/json-bounds.js";
import verdicts from "../test/fixtures/json-surrogates/verdicts.json" with { type: "json" };

// The JSON walk's refusal of unpaired surrogates (#1718) on Node, beside the Workers runtime's check in
// test/inbox-json.test.ts: String.prototype.isWellFormed, and the walk over every string and key.

// JSON texts as a remote sends them, each escape written out.
const parse = (text: string): unknown => JSON.parse(text);

describe("jsonRefusal", () => {
  it.each([
    String.raw`{"a":"\ud800"}`,
    String.raw`{"a":"\udc00"}`,
    String.raw`{"a":"\ud800A"}`,
    String.raw`{"a":"\ud800\ud800"}`,
    String.raw`{"a":"\udc00\ud800"}`,
    String.raw`{"\ud800":1}`,
    String.raw`{"a":["ok","\ud800"]}`,
    String.raw`{"a":{"b":[{"c":"x\udc00"}]}}`,
    String.raw`"\ud800"`,
  ])("refuses %s as malformed", (text) => {
    expect(jsonRefusal(parse(text))).toBe("malformed");
    expect(jsonTextMalformed(text)).toBe(true);
  });

  it.each([
    String.raw`{"a":"\ud800\udc00"}`,
    String.raw`{"\ud83d\ude00":"\ud83d\ude00"}`,
    `{"a":"😀"}`,
    String.raw`{"a":"\u0000"}`,
    String.raw`{"a":"\ufffd"}`,
    `{"a":[1,null,true,{}]}`,
  ])("reads %s", (text) => {
    expect(jsonRefusal(parse(text))).toBeNull();
    expect(jsonTextMalformed(text)).toBe(false);
  });

  it("refuses past the bounds as too-complex", () => {
    const wide = Array.from({ length: MAX_JSON_NODES }, () => 0);
    expect(jsonRefusal(wide.slice(1))).toBeNull();
    expect(jsonRefusal(wide)).toBe("too-complex");
    let deep: unknown = "\ud800\udc00";
    for (let depth = 1; depth < MAX_JSON_DEPTH; depth++) {
      deep = [deep];
    }
    expect(jsonRefusal(deep)).toBeNull();
    expect(jsonRefusal([deep])).toBe("too-complex");
    // Values are counted as their container is read, before any of them is checked.
    expect(jsonRefusal(["\ud800", ...wide])).toBe("too-complex");
  });
});

// The text check against Mastodon's parser (json 2.21.2) on the texts of fixtures/json-surrogates/ (capture.rb): Kopje
// refuses what that parser refuses, a token a later duplicate key replaces included, and also a lone low surrogate,
// which that parser keeps (docs/mastodon-deviations.md).
describe("jsonTextMalformed", () => {
  const cases = verdicts.cases as { text: string; parses: boolean }[];
  const LONE_LOW = new Set([
    String.raw`{"a":"\udc00"}`,
    String.raw`[1,"\udc00",2]`,
    String.raw`{"\udc00":1}`,
    String.raw`{"x":{"k":"\udc00","k":"ok"}}`,
    String.raw`{"a":"\ud800\udc00","a":"\udc00"}`,
    String.raw`{"a":"\udc00","a":"ok"}`,
  ]);

  it("was captured from json 2.21.2 on Ruby 4.0.9, with every lone low text in it", () => {
    expect([verdicts.json, verdicts.ruby]).toEqual(["2.21.2", "4.0.9"]);
    expect(cases.filter((c) => LONE_LOW.has(c.text))).toHaveLength(LONE_LOW.size);
  });

  it.each(cases.map((c) => [c.text, c.parses] as const))("judges %s as json 2.21.2 does", (text, parses) => {
    expect(jsonTextMalformed(text)).toBe(LONE_LOW.has(text) ? true : !parses);
    if (LONE_LOW.has(text)) {
      expect(parses).toBe(true);
    }
  });

  // What the walk over the parsed value cannot see: JSON.parse kept a well-formed value for a duplicate key.
  it("refuses a token a later duplicate key replaced, which the parsed value no longer holds", () => {
    const hidden = cases.filter((c) => !c.parses && jsonRefusal(JSON.parse(c.text)) === null).map((c) => c.text);
    expect(hidden).toEqual([
      String.raw`{"a":"\ud800","a":"ok"}`,
      String.raw`{"a":{"b":"\ud800"},"a":{}}`,
      String.raw`{"a":["\ud800"],"a":[]}`,
    ]);
    for (const text of hidden) {
      expect(jsonTextMalformed(text)).toBe(true);
    }
  });

  it("reads raw code units as the parsed string holds them", () => {
    expect(jsonTextMalformed(`{"a":"\ud800"}`)).toBe(true);
    expect(jsonTextMalformed(`{"\udc00":1}`)).toBe(true);
    expect(jsonTextMalformed(`{"a":"\ud83d\ude00"}`)).toBe(false);
    expect(jsonTextMalformed(`{"a":"\ud83d${String.raw`\ude00`}"}`)).toBe(false);
    expect(jsonTextMalformed(`{"a":"${String.raw`\ud83d`}\ude00"}`)).toBe(false);
    expect(jsonTextMalformed(`{"a":"${String.raw`\ud83d`}\ud83d\ude00"}`)).toBe(true);
  });

  // Any value JSON.stringify writes (which escapes a lone surrogate and keeps a pair raw), and the same with every code
  // unit past ASCII written as an escape: the text check agrees with the walk over the parsed value.
  it("agrees with the walk over the parsed value on any text without duplicate keys", () => {
    const escaped = (text: string) =>
      text.replace(/[\u0080-\uffff]/g, (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`);
    const value = fc.letrec((tie) => ({
      tree: fc.oneof({ depthSize: "small" }, tie("leaf"), tie("array"), tie("object")),
      leaf: fc.oneof(fc.string({ unit: "binary" }), fc.integer(), fc.constant(null)),
      array: fc.array(tie("tree"), { maxLength: 4 }),
      object: fc.dictionary(fc.string({ unit: "binary", maxLength: 4 }), tie("tree"), { maxKeys: 4 }),
    })).tree;
    fc.assert(
      fc.property(value, (v) => {
        const text = JSON.stringify(v);
        const malformed = jsonRefusal(JSON.parse(text)) === "malformed";
        expect(jsonTextMalformed(text)).toBe(malformed);
        expect(jsonTextMalformed(escaped(text))).toBe(malformed);
      }),
      { numRuns: 2_000 },
    );
  }, 60_000);
});

describe("the Node runtime", () => {
  it("has String.prototype.isWellFormed, which tells an unpaired surrogate from a pair", () => {
    expect(typeof String.prototype.isWellFormed).toBe("function");
    expect(["\ud800", "\udc00", "\ud800A", "\ud800\ud800"].map((s) => s.isWellFormed())).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(["\ud800\udc00", "😀", "", "a"].map((s) => s.isWellFormed())).toEqual([true, true, true, true]);
  });
});
