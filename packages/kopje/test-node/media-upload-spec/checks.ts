// Checks spec/media-upload/, the TLA+ specification of a video or audio upload's lifecycle (#1828 PR4), with tla-ts:
// every check of checks.json gives its expected outcome (scripts/media-upload-plan.mjs lists the kinds). A scenario's
// distinct-state count and depth are fixed: a change means the state space changed, which the commit that changes
// checks.json explains. Each check logs its time and the process's RSS.
//
// The checks are split over PARTS files, <part>.test.ts beside this module, so that CI's test shards share them:
// `vitest --shard` deals out whole files, and each part's file has a shard of its own
// (test-node/media-upload-spec-parts.test.ts). A check runs in the part PLACED gives it, or else in the part the SHA-256
// of its title picks, so a new check moves no other. PLACED holds the checks that took 10 s or more in a run of the
// parts on a laptop: those, the longest first, each went to the part with the least time so far, the other checks
// counted in the part their hash picks.
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

import { check } from "tla-ts";
import { describe, expect, it } from "vitest";

import { checks, readModule, readPlan } from "../../scripts/media-upload-plan.mjs";

export const PARTS = 2;

// A check's title (its kind and name) and its part.
export const PLACED = new Map<string, number>([
  ["scenario RS", 1],
  ["scenario CAP2", 0],
  ["scenario RS3", 0],
  ["scenario RSL", 1],
  ["goal RS-W11Swept", 1],
  ["scenario OR", 0],
  ["scenario MTX", 1],
  ["scenario RS2", 0],
  ["scenario H1W", 0],
  ["scenario MT", 1],
  ["scenario DLW", 0],
  ["goal RS-W11Forgotten", 1],
  ["scenario LK", 0],
  ["goal RS-W11", 1],
  ["scenario V1R", 0],
  ["scenario V2D", 1],
  ["scenario V1L", 0],
  ["liveness L3", 1],
]);

export const plan = readPlan();
// The largest scenario, RS (2,372,061 distinct states), took 80 s on a laptop running three checks at once; the timeout
// leaves CI more than three times that.
const CHECK_TIMEOUT_MS = 300_000;

/** The part that runs a check of checks.json, by its title. */
const partOf = (title: string): number =>
  PLACED.get(title) ?? createHash("sha256").update(title).digest().readUInt32BE(0) % PARTS;

/** Declares the checks of checks.json that run in the part whose file is file (part 0 is 0.test.ts). */
export function tlaTsChecks(file: string): void {
  const part = Number(basename(fileURLToPath(file), ".test.ts"));
  describe("spec/media-upload under tla-ts", () => {
    for (const c of checks(plan).filter((c) => partOf(`${c.kind} ${c.name}`) === part)) {
      it(`${c.kind} ${c.name}`, { timeout: CHECK_TIMEOUT_MS }, async () => {
        const start = performance.now();
        const result = await check({ source: readModule(c.module) ?? "", config: c.config, loadModule: readModule });
        const ms = Math.round(performance.now() - start);
        const rss = Math.round(process.memoryUsage().rss / 1e6);
        console.log(
          `${c.kind} ${c.name}: ${result.status}, ${result.distinctStates} distinct, depth ${result.depth}, ` +
            `trace ${result.violation?.trace.length ?? "-"}, ${ms} ms, rss ${rss} MB`,
        );
        expect(result.failure?.message).toBeUndefined();
        const got =
          c.expected.status === "success"
            ? { status: result.status, distinct: result.distinctStates, depth: result.depth }
            : { status: result.status, property: result.violation?.name, trace: result.violation?.trace.length };
        expect(got).toEqual(c.expected);
      });
    }
  });
}
