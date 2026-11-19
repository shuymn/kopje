import { describe, expect, it } from "vitest";

import { railsFormatParam } from "../src/platform/rails-format-param";
import { ParamHash, type RailsParam } from "../src/platform/rails-params";
import corpus from "./fixtures/rails-params/format-corpus.json";

// Each row: the route extension (null without one), the query, and the answer: the stage of a refusal, or the format.
const ROWS = corpus.rows as [string | null, string, unknown][];

type Encoded = string | null | Encoded[] | { hash: [string, Encoded][] };

function encode(value: RailsParam): Encoded {
  if (value instanceof ParamHash) {
    return { hash: [...value].map(([key, item]): [string, Encoded] => [key, encode(item)]) };
  }
  return Array.isArray(value) ? value.map(encode) : value;
}

// format-corpus.json is railsFormatParam's answer, recorded before its parser moved to platform/rails-params.ts, for
// every key shape alone and with every value, and seeded combinations of them with separators and route extensions:
// bad `%`, keys that are not UTF-8, nested kinds in both orders, nil, empty and malformed brackets. The parser shared
// with the API answers each the same, the stage of each refusal included.
describe("railsFormatParam: the recorded corpus", () => {
  it("covers each answer", () => {
    const kinds = new Set(ROWS.map(([, , answer]) => (typeof answer === "string" ? answer : "read")));
    expect([ROWS.length, [...kinds].toSorted()]).toEqual([1500, ["controller", "read", "request"]]);
  });

  it("answers every recorded request as before", () => {
    const answers = ROWS.map(([extension, query]) => {
      const result = railsFormatParam(extension ?? undefined, query);
      if (result.refused !== false) {
        return [extension, query, result.refused];
      }
      return [extension, query, { format: result.format === undefined ? "(absent)" : encode(result.format) }];
    });
    expect(answers).toEqual(ROWS);
  });

  // Rack's limits, each at its value and one past it, as recorded with the corpus: a nesting 31 deep, 4,096 fields and
  // 4,194,304 bytes are read; one more refuses while the request is read.
  it("refuses past each of Rack's limits, and reads at it", () => {
    const deep = (n: number) => `format=json&a${"[b]".repeat(n)}=1`;
    const fields = (n: number) => `format=json&${Array.from({ length: n }, (_, i) => `k${i}=1`).join("&")}`;
    const bytes = (n: number) => `format=json&a=${"x".repeat(n - 14)}`;
    const forms: [string, string, unknown][] = [
      ["deep 31", deep(31), { refused: false, format: "json" }],
      ["deep 32", deep(32), { refused: "request" }],
      ["4,096 fields", fields(4095), { refused: false, format: "json" }],
      ["4,097 fields", fields(4096), { refused: "request" }],
      ["4 MiB", bytes(4194304), { refused: false, format: "json" }],
      ["4 MiB + 1", bytes(4194305), { refused: "request" }],
    ];
    for (const [label, query, answer] of forms) {
      expect([label, railsFormatParam(undefined, query)]).toEqual([label, answer]);
    }
  });
});
