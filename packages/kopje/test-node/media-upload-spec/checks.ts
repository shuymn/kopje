// Checks spec/media-upload/, the TLA+ specification of a video or audio upload's lifecycle (#1828 PR4), with tla-ts:
// every check of checks.json gives its expected outcome (scripts/media-upload-plan.mjs lists the kinds). A scenario's
// distinct-state count and depth are fixed: a change means the state space changed, which the commit that changes
// checks.json explains. Each check logs its time and the process's RSS.
//
// The checks are split over the parts PARTS numbers, part n in checks-<n>.test.ts beside this module, so that CI's test
// shards share them: `vitest --shard` deals out whole files, and each of CI's four shards holds two parts' files
// (test-node/media-upload-spec-parts.test.ts; the numbers are ones whose paths hash two into each quarter), which run
// at once there, as a shard runs its files on a hosted runner's vCPUs less one (Vitest's default maxWorkers, D43). A
// check runs in the part PLACED gives it, or else in the part the SHA-256 of its title picks, so a new check moves no
// other. PLACED holds the checks that took 5 s or more in a run of the parts on a laptop: those, the longest first,
// each went to the part with the least time so far, the other checks counted in the part their hash picks. Before a
// part's checks run, its file must have declared exactly its share of them (below), so a part file that stops calling
// tlaTsChecks fails instead of passing with its checks unrun.
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

import { check } from "tla-ts";
import { beforeAll, describe, expect, it } from "vitest";

import { checks, readModule, readPlan } from "../../scripts/media-upload-plan.mjs";

export const PARTS = [0, 1, 2, 3, 4, 6, 7, 8];

// A check's title (its kind and name) and its part.
export const PLACED = new Map<string, number>([
  ["scenario MTX", 0],
  ["scenario CAP2", 4],
  ["scenario RS", 8],
  ["scenario RSL", 7],
  ["scenario RS12", 2],
  ["scenario RS2", 6],
  ["scenario CAP4", 1],
  ["scenario OR", 3],
  ["scenario MT", 1],
  ["scenario DLW", 6],
  ["scenario V2D", 3],
  ["goal RS12-W12", 2],
  ["goal RS12-W12Dead", 7],
  ["scenario CAP5", 8],
  ["scenario LK", 4],
  ["goal RS-W11Swept", 0],
  ["scenario V1L", 1],
  ["scenario V1R", 3],
  ["scenario H1W", 6],
  ["liveness L3", 4],
  ["scenario RSD", 8],
  ["scenario SK", 7],
  ["scenario V2L", 2],
  ["scenario MT2", 0],
  ["goal V1L-W5Swept", 8],
  ["goal V1L-S10Swept", 4],
  ["variant SlotsReleased-NoExpiry", 6],
  ["scenario V2K", 1],
  ["goal RS-W11Forgotten", 3],
  ["scenario V1K", 7],
  ["variant V1Answer-S10IgnoresGc", 2],
  ["scenario MTR", 0],
  ["goal RSD-W3Twice", 8],
  ["variant NoPublishAfterNon200-WaitForStoreDeadline", 4],
  ["scenario CAP", 3],
  ["goal DLW-Published", 6],
  ["variant V1Answer-ShortGrace", 1],
  ["goal RS-W11", 2],
  ["goal H1W-W5Maint", 7],
  ["goal V1L-W5S3Lost", 0],
]);

export const plan = readPlan();
// The longest check, scenario MTX (3,578,157 distinct states), took 117 s on a laptop running three checks at once; the
// timeout leaves CI over twice that.
const CHECK_TIMEOUT_MS = 300_000;

// The title of the describe block tlaTsChecks declares.
const SUITE = "spec/media-upload under tla-ts";

/** The part that runs a check of checks.json, by its title. */
const partOf = (title: string): number =>
  PLACED.get(title) ?? PARTS[createHash("sha256").update(title).digest().readUInt32BE(0) % PARTS.length] ?? -1;

/** The part whose file is the given path or file URL (part 0 is checks-0.test.ts), or undefined for another file. */
const partOfFile = (file: string): number | undefined => {
  const match = /^checks-(\d+)\.test\.ts$/.exec(basename(file.startsWith("file:") ? fileURLToPath(file) : file));
  return match === null || !PARTS.includes(Number(match[1])) ? undefined : Number(match[1]);
};

/** The titles of the checks the given part runs. */
const titlesOf = (part: number): string[] =>
  checks(plan)
    .map((c) => `${c.kind} ${c.name}`)
    .filter((title) => partOf(title) === part);

// Registered in every file that imports this module: a part's file must have collected exactly its share of the
// checks (Codex r3 CM5, D22).
// oxlint-disable-next-line eslint/no-empty-pattern -- vitest wants the context destructured; the file is the second
beforeAll(({}, file) => {
  const part = "filepath" in file ? partOfFile(file.filepath) : undefined;
  if (part === undefined) return;
  const collected = file.tasks
    .filter((task) => task.type === "suite" && task.name === SUITE)
    .flatMap((suite) => (suite.type === "suite" ? suite.tasks.map((task) => task.name) : []));
  expect(collected.toSorted(), `checks-${part}.test.ts declares its share of the checks`).toEqual(
    titlesOf(part).toSorted(),
  );
});

/** Declares the checks of checks.json that run in the part whose file is file. */
export function tlaTsChecks(file: string): void {
  const part = partOfFile(file);
  if (part === undefined) throw new Error(`${file} is no part's file`);
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
