import type { Node } from "oxc-parser";
import { describe, expect, it } from "vitest";

import { guardFixtures, inventoryDiff, parse, sources, walk, type Source } from "./source-scan.js";

// Request integers are read as Ruby reads them, after Params#last or Params#getAllIntegers (a JSON number by
// rubyNumberToI, its to_i): by rubyToI (src/platform/ruby-to-i.ts), Ruby's String#to_i, and a vote's choices by
// rubyInteger (src/platform/ruby-integer.ts), its Kernel#Integer. READERS is their inventory, each file's references to
// each reader (its import included), so a reader added, moved or dropped changes it. The parseInt check fails on any
// `parseInt` under src/mastodon and src/domain but the hex decodings listed: a tripwire only, which sees no reader
// written with a regular expression or Number(), so a new integer parameter needs its own route test as well.
const SOURCES = [...sources("src/mastodon"), ...sources("src/domain")];

// Percent and hex escapes, not request integers.
const EXPECTED = {
  "src/domain/collection-requests.ts": 1,
  "src/domain/remote-statuses.ts": 1,
};

const READERS = {
  rubyToI: {
    "src/domain/filters.ts": 2,
    "src/domain/polls.ts": 2,
    "src/mastodon/blocks.ts": 2,
    "src/mastodon/oembed.ts": 3,
    "src/mastodon/params.ts": 3,
    "src/mastodon/search.ts": 2,
  },
  rubyNumberToI: { "src/mastodon/params.ts": 2 },
  rubyInteger: { "src/domain/polls.ts": 2 },
};

// Each reference to `name` (a call, a member such as `Number.parseInt` or `Number["parseInt"]`, a destructured or
// aliased binding, an import), once per place: a shorthand property's key and value are two nodes at one offset.
function references(name: string): (all: readonly Source[]) => string[] {
  return (all) =>
    all.flatMap((source) => {
      const found = new Set<number>();
      walk(parse(source).program, (node: Node) => {
        if ((node.type === "Identifier" && node.name === name) || (node.type === "Literal" && node.value === name)) {
          found.add(node.start);
        }
      });
      return [...found].map(() => source.path);
    });
}

describe("request integers are not read with parseInt", () => {
  it("finds parseInt only at the listed hex decodings", () => {
    expect(inventoryDiff(references("parseInt")(SOURCES), EXPECTED)).toEqual([]);
  });

  guardFixtures(references("parseInt"), {
    flagged: {
      "a call": ["const n = parseInt(value, 10);", "src/domain/probe.ts"],
      "Number.parseInt": ["const n = Number.parseInt(value, 10);", "src/domain/probe.ts"],
      "a computed member": ['const n = Number["parseInt"](value);', "src/domain/probe.ts"],
      "a destructured alias": ["const { parseInt: read } = Number;", "src/domain/probe.ts"],
    },
    passed: {
      rubyToI: "const n = rubyToI(value);",
      rubyInteger: "const n = rubyInteger(value);",
      "a comment": "// parseInt\nconst n = 1;",
      "a string that mentions it": 'const s = "not parseInt";',
    },
  });
});

describe("request integers are read by the Ruby readers listed", () => {
  it.each(Object.entries(READERS))("finds %s at its inventory", (name, expected) => {
    expect(inventoryDiff(references(name)(SOURCES), expected)).toEqual([]);
  });
});
