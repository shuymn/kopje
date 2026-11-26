// Checks spec/collection-consent/, the TLA+ specification of a local account's consent to membership in a remote
// collection (#1589), with tla-ts: every check of checks.json gives its expected outcome
// (scripts/collection-consent-plan.mjs lists the kinds), the replay fixtures equal a fresh run, cover each of Kopje's
// steps and take no model-only one, and each fixture names the replay that runs it. Each calibration variant that
// changes what the Store does no longer reproduces a fixture checks.json's replay names, so that fixture's replay fails
// against a Store with the variant's change; a variant that changes only what an invariant counts is exempt there, with
// its reason, and reproduces every fixture.
// scripts/tlc-check.mjs runs the same checks under the official TLC.
//
// A scenario's distinct-state count and depth are fixed: a change means the state space changed, which the commit
// that changes checks.json explains. Each check logs its name when it starts, so a job cancelled at its time limit
// shows the check that stalled, and its time and the process's RSS.
//
// The tests are split over PARTS files, <part>.test.ts beside this module, so that CI's test shards share them:
// `vitest --shard` deals out whole files, and each part's file has a shard of its own
// (test-node/collection-consent-spec-parts.test.ts). Each part runs its share of the checks of checks.json
// (tlaTsChecks), and each other suite is in one part's file. A check runs in the part PLACED gives it, or else in the
// part the SHA-256 of its title picks, so a new check moves no other. PLACED holds the checks that took 3 s or more in
// a run of the parts on a laptop: those and the other suites, the longest first, each went to the part with the least
// time so far, the other checks counted in the part their hash picks. The fixtures' fresh run alone takes most of one
// part's time, and the other parts take about as long as each other.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

import { check } from "tla-ts";
import { describe, expect, it } from "vitest";

import { checks, readModule, readPlan } from "../../scripts/collection-consent-plan.mjs";
import type { Fixture } from "../../test/collection-consent-observe.js";
import { FIXTURE_DIR } from "../collection-consent-fixtures.js";

export const PARTS = 4;

// A check's title (its kind and name) and its part.
export const PLACED = new Map<string, number>([
  ["goal S2-ReadOverRetraction", 3],
  ["induction Ind", 0],
  ["scenario S16", 1],
  ["scenario S2", 1],
  ["variant V13", 0],
  ["goal S2-LeaseFailedOrdinary", 3],
  ["goal S2-F8ThenF7", 1],
  ["goal S2-LeaseSuperseded", 3],
  ["variant V31", 1],
  ["variant V20-induction", 0],
  ["goal S2-LeaseDupSuperseded", 3],
  ["goal S2-ReclaimSuperseded", 1],
  ["goal S16-ReclaimRetraction", 0],
  ["goal S2-ReclaimOrdinary", 1],
  ["scenario S6", 0],
  ["goal S16-ReclaimRefused", 3],
  ["goal S4-LeaseFailedBesideX", 1],
  ["variant V34", 0],
  ["goal S16-LeasedSentSuspended", 3],
  ["goal S5-StaleOmits", 1],
]);

/** The part that runs a check of checks.json, by its title. */
const partOf = (title: string): number =>
  PLACED.get(title) ?? createHash("sha256").update(title).digest().readUInt32BE(0) % PARTS;

export const plan = readPlan();
// The largest check, goal S2-ReadOverRetraction (656,913 distinct states), took 88.7 s and 130.6 s on CI's runners
// with the same states, so the timeout leaves it more than twice its slower time.
export const CHECK_TIMEOUT_MS = 300_000;

export const fixtureFiles = () =>
  readdirSync(FIXTURE_DIR)
    .filter((file) => file.endsWith(".json"))
    .toSorted();
export const readFixture = (file: string) => JSON.parse(readFileSync(`${FIXTURE_DIR}${file}`, "utf8")) as Fixture;

/** Declares the checks of checks.json that run in the part whose file is file (part 0 is 0.test.ts). */
export function tlaTsChecks(file: string): void {
  const part = Number(basename(fileURLToPath(file), ".test.ts"));
  describe("spec/collection-consent under tla-ts", () => {
    for (const c of checks(plan).filter((c) => partOf(`${c.kind} ${c.name}`) === part)) {
      it(`${c.kind} ${c.name}`, { timeout: CHECK_TIMEOUT_MS }, async () => {
        console.log(`${c.kind} ${c.name}: start`);
        // Vitest forwards console output on a microtask, and check() then runs synchronously: yield once so the line
        // is out before the search, or a job killed during it never shows the line.
        await Promise.resolve();
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
            : { status: result.status, invariant: result.violation?.name, trace: result.violation?.trace.length };
        expect(got).toEqual(c.expected);
      });
    }
  });
}
