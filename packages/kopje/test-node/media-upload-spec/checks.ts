// Checks spec/media-upload/, the TLA+ specification of a video or audio upload's lifecycle (#1828 PR4), with tla-ts:
// every check of checks.json gives its expected outcome (scripts/media-upload-plan.mjs lists the kinds). A scenario's
// distinct-state count and depth are fixed: a change means the state space changed, which the commit that changes
// checks.json explains. Each check logs its time and the process's RSS.
//
// The checks are split over PARTS files, checks-<part>.test.ts beside this module, so that CI's test shards share them:
// `vitest --shard` deals out whole files, and each part's file has a shard of its own
// (test-node/media-upload-spec-parts.test.ts; the names are the ones whose paths hash into four different quarters).
// A check runs in the part PLACED gives it, or else in the part the SHA-256 of its title picks, so a new check moves no
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

export const PARTS = 4;

// A check's title (its kind and name) and its part.
export const PLACED = new Map<string, number>([
  ["scenario RS3", 0],
  ["scenario MTX", 1],
  ["scenario CAP2", 2],
  ["scenario RS", 3],
  ["scenario RSL", 3],
  ["scenario DLW", 1],
  ["scenario CAP4", 2],
  ["scenario RS2", 0],
  ["scenario H1W", 0],
  ["scenario MT", 2],
  ["scenario OR", 3],
  ["scenario CAP5", 1],
  ["scenario V2D", 0],
  ["goal RS-W11Swept", 1],
  ["liveness L3", 2],
  ["goal RS-W12", 3],
  ["scenario LK", 0],
  ["scenario V1R", 1],
  ["scenario V1L", 2],
  ["scenario SK", 3],
  ["variant SlotsReleased-NoExpiry", 2],
  ["scenario MT2", 3],
  ["scenario V2L", 1],
  ["scenario RSD", 0],
  ["scenario V2K", 1],
  ["scenario CAP", 2],
  ["goal V1L-W5Swept", 3],
  ["goal DLW-Published", 0],
  ["goal RS-W11Forgotten", 3],
  ["scenario MTR", 1],
  ["goal H1W-W5Maint", 2],
  ["scenario V1K", 0],
  ["variant V1Answer-ShortGrace", 2],
  ["goal RS-W11", 3],
  ["variant NoPublishAfterNon200-WaitForStoreDeadline", 1],
  ["goal RSD-W3Twice", 0],
]);

export const plan = readPlan();
// The longest check, scenario RS3 (3,424,626 distinct states), took 97 s on a laptop running three checks at once; the
// timeout leaves CI about three times that.
const CHECK_TIMEOUT_MS = 300_000;

// The title of the describe block tlaTsChecks declares.
const SUITE = "spec/media-upload under tla-ts";

/** The part that runs a check of checks.json, by its title. */
const partOf = (title: string): number =>
  PLACED.get(title) ?? createHash("sha256").update(title).digest().readUInt32BE(0) % PARTS;

/** The part whose file is the given path or file URL (part 0 is checks-0.test.ts), or undefined for another file. */
const partOfFile = (file: string): number | undefined => {
  const match = /^checks-(\d+)\.test\.ts$/.exec(basename(file.startsWith("file:") ? fileURLToPath(file) : file));
  return match === null ? undefined : Number(match[1]);
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
