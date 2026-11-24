// The parts the specification's checks are split into (media-upload-spec/checks.ts): each check of checks.json runs in
// a part that has a file, and each part's file has a shard of its own among CI's test shards.
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { checks } from "../scripts/media-upload-plan.mjs";
import { PARTS, PLACED, plan } from "./media-upload-spec/checks.js";

// The test job's matrix in .github/workflows/ci.yml.
const SHARDS = 4;
// How far from a shard's edge, as a share of the hash space, a part's file lies (below).
const MARGIN = 0.05;
const DIRECTORY = "packages/kopje/test-node/media-upload-spec/";

const files = readdirSync(new URL("media-upload-spec/", import.meta.url))
  .filter((file) => file.endsWith(".test.ts"))
  .toSorted();

describe("the parts of the media upload specification's checks", () => {
  it("have a file each", () => {
    expect(files).toEqual(Array.from({ length: PARTS }, (_, part) => `${part}.test.ts`));
  });

  it("are given by hand only for checks that exist", () => {
    const titles = new Set(checks(plan).map((c) => `${c.kind} ${c.name}`));
    expect([...PLACED.keys()].filter((title) => !titles.has(title))).toEqual([]);
    expect([...PLACED.values()].filter((part) => !files.includes(`${part}.test.ts`))).toEqual([]);
  });

  // `vitest --shard` sorts the run's test files by the SHA-1 of their path from the repository root and cuts the list
  // into runs of equal length (BaseSequencer's shard in vitest), so with hundreds of files the edges between shards lie
  // close to the quarters of the hash space. A part's file inside a quarter of its own, at least MARGIN from its edges,
  // has a shard of its own.
  it("lie in a shard each", () => {
    const shards = files.map((file) => {
      const at = createHash("sha1").update(`/${DIRECTORY}${file}`).digest().readUInt32BE(0) / 2 ** 32;
      const shard = Math.floor(at * SHARDS);
      return at - shard / SHARDS < MARGIN || (shard + 1) / SHARDS - at < MARGIN ? `${file} near an edge` : shard;
    });
    expect(new Set(shards).size).toBe(files.length);
    expect(shards.filter((shard) => typeof shard === "string")).toEqual([]);
  });
});
