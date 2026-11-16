import type { Node } from "oxc-parser";
import { describe, expect, it } from "vitest";

import { guardFixtures, inventoryDiff, parse, sources, walk, type Source } from "./source-scan.js";

// Request integers are read as Ruby's String#to_i reads them, by rubyToI (src/platform/ruby-to-i.ts), after
// Params#last. This fails on any `parseInt` under src/mastodon and src/domain but the hex decodings listed: a tripwire
// only, which sees no reader written with a regular expression or Number(), so a new integer parameter needs its own
// route test as well.
const SOURCES = [...sources("src/mastodon"), ...sources("src/domain")];

// Percent and hex escapes, not request integers.
const EXPECTED = {
  "src/domain/collection-requests.ts": 1,
  "src/domain/remote-statuses.ts": 1,
};

const NAME = "parseInt";

// Each reference to parseInt (a call, `Number.parseInt`, `Number["parseInt"]`, a destructured or aliased binding),
// once per place: a shorthand property's key and value are two nodes at one offset.
function sites(all: readonly Source[]): string[] {
  return all.flatMap((source) => {
    const found = new Set<number>();
    walk(parse(source).program, (node: Node) => {
      if ((node.type === "Identifier" && node.name === NAME) || (node.type === "Literal" && node.value === NAME)) {
        found.add(node.start);
      }
    });
    return [...found].map(() => source.path);
  });
}

describe("request integers are not read with parseInt", () => {
  it("finds parseInt only at the listed hex decodings", () => {
    expect(inventoryDiff(sites(SOURCES), EXPECTED)).toEqual([]);
  });

  guardFixtures(sites, {
    flagged: {
      "a call": ["const n = parseInt(value, 10);", "src/domain/probe.ts"],
      "Number.parseInt": ["const n = Number.parseInt(value, 10);", "src/domain/probe.ts"],
      "a computed member": ['const n = Number["parseInt"](value);', "src/domain/probe.ts"],
      "a destructured alias": ["const { parseInt: read } = Number;", "src/domain/probe.ts"],
    },
    passed: {
      rubyToI: "const n = rubyToI(value);",
      "a comment": "// parseInt\nconst n = 1;",
      "a string that mentions it": 'const s = "not parseInt";',
    },
  });
});
