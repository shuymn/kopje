// Checks spec/media-upload/, the TLA+ specification of a video or audio upload's lifecycle (#1828 PR4), with tla-ts:
// every check of checks.json gives its expected outcome (scripts/media-upload-plan.mjs lists the kinds). A scenario's
// distinct-state count and depth are fixed: a change means the state space changed, which the commit that changes
// checks.json explains. Each check logs its time and the process's RSS.
//
// The checks are split over PARTS files, <part>.test.ts beside this module, so that CI's test shards share them; a check
// runs in the part the SHA-256 of its title picks, so a new check moves no other.
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

import { check } from "tla-ts";
import { describe, expect, it } from "vitest";

import { checks, readModule, readPlan } from "../../scripts/media-upload-plan.mjs";

const PARTS = 2;

export const plan = readPlan();
// The largest scenarios took about 90 s on a laptop running two checks at once; the timeout leaves CI more than three
// times that.
const CHECK_TIMEOUT_MS = 300_000;

/** The part that runs a check of checks.json, by its title. */
const partOf = (title: string): number => createHash("sha256").update(title).digest().readUInt32BE(0) % PARTS;

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
