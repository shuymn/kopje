import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// The Mastodon release Kopje claims to follow (docs/mastodon-deviations.md, "What Kopje follows") is the one its
// conformance checks read: every Mastodon fixture carries that release in its name and its `mastodon` field, so moving
// the reference release moves the claim and the evidence together.

const FIXTURES = new URL("../test/fixtures/", import.meta.url);

function claimedRelease(): string {
  const text = readFileSync(new URL("../docs/mastodon-deviations.md", import.meta.url), "utf8");
  const claims = [...text.matchAll(/follows the client API as \*\*Mastodon v(\d+\.\d+\.\d+)\*\*/g)];
  expect(claims, "one client API claim on the page").toHaveLength(1);
  return claims[0]?.[1] ?? "";
}

describe("the reference Mastodon release", () => {
  it("is the release every Mastodon fixture was made from", () => {
    const release = claimedRelease();
    const fixtures = readdirSync(FIXTURES).filter((name) => /^mastodon-.*\.json$/.test(name));
    expect(fixtures).not.toHaveLength(0);
    for (const name of fixtures) {
      expect(name, name).toMatch(new RegExp(`^mastodon-${release.replaceAll(".", "\\.")}-`));
      const fixture = JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8")) as { mastodon?: unknown };
      expect(fixture.mastodon, name).toBe(release);
    }
  });
});
