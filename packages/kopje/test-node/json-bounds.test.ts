import { describe, expect, it } from "vitest";

import { jsonRefusal, MAX_JSON_DEPTH, MAX_JSON_NODES, wellFormedJson } from "../src/platform/json-bounds.js";

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
    expect(wellFormedJson(parse(text))).toBe(false);
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
    expect(wellFormedJson(parse(text))).toBe(true);
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

  it("wellFormedJson reads past the bounds", () => {
    let deep: unknown = ["😀"];
    for (let depth = 0; depth < 2 * MAX_JSON_DEPTH; depth++) {
      deep = { next: deep };
    }
    const wide = [...Array.from({ length: 2 * MAX_JSON_NODES }, () => "a"), deep];
    expect(jsonRefusal(wide)).toBe("too-complex");
    expect(wellFormedJson(wide)).toBe(true);
    expect(wellFormedJson(["\ud800", ...wide])).toBe(false);
  });
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
