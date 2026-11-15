import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { parseAddress } from "../src/platform/domain-name";
import { isRemoteUsername } from "../src/platform/identity-bounds";

// The username pattern of domain-name.ts (USERNAME, through parseAddress) and identity-bounds.ts (REMOTE_USERNAME,
// through isRemoteUsername), each written in its own module, held to the language of Mastodon's USERNAME_RE as
// Mastodon writes it: the baseline below.
const USERNAME_RE = /^[a-z0-9_]+([a-z0-9_.-]+[a-z0-9_]+)?$/i;

const ALPHABET = ["a", "Z", "0", "_", ".", "-", "!", "\u00e9", "\u017f", "\u212a", "\n"];

const verdicts = (username: string) => ({
  parseAddress: parseAddress(`${username}@example.com`) !== null,
  isRemoteUsername: isRemoteUsername(username),
});

describe("the username pattern", () => {
  it.each([
    ["", false],
    ["a", true],
    ["_", true],
    [".", false],
    ["-", false],
    ["aZ", true],
    ["a.", false],
    [".a", false],
    ["-a", false],
    ["a-", false],
    ["a.b", true],
    ["a-_", true],
    ["a..b", true],
    ["a.-.b", true],
    ["a!b", false],
    ["\u00e9", false],
    ["a\n", false],
  ])("reads %j as a username: %s", (username, expected) => {
    expect(USERNAME_RE.test(username)).toBe(expected);
    expect(verdicts(username)).toEqual({ parseAddress: expected, isRemoteUsername: expected });
  });

  it("matches what the baseline matches, every string of up to three characters", () => {
    const strings = [""];
    for (let length = 1; length <= 3; length++) {
      for (const prefix of strings.filter((s) => [...s].length === length - 1)) {
        strings.push(...ALPHABET.map((c) => `${prefix}${c}`));
      }
    }
    const differ = strings.filter((s) => {
      const expected = USERNAME_RE.test(s);
      const got = verdicts(s);
      return got.parseAddress !== expected || got.isRemoteUsername !== expected;
    });
    expect(strings).toHaveLength(1 + 11 + 121 + 1331);
    expect(differ).toEqual([]);
  });

  it("matches what the baseline matches on generated strings", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...ALPHABET), { maxLength: 24 }), (parts) => {
        const username = parts.join("");
        const expected = USERNAME_RE.test(username);
        expect(verdicts(username)).toEqual({ parseAddress: expected, isRemoteUsername: expected });
      }),
      { numRuns: 20_000 },
    );
  });
});
