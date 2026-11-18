// Checks spec/feature-d/, the TLA+ specification of #1589's feature authorizations under design (d), with tla-ts:
// every check of checks.json gives its expected outcome (scripts/feature-d-plan.mjs lists the kinds), the replay
// fixtures equal a fresh run and cover each of Kopje's steps, and each fixture names the replay that runs it.
// scripts/tlc-check.mjs runs the same checks under the official TLC.
//
// A scenario's distinct-state count and depth are fixed: a change means the state space changed, which the commit
// that changes checks.json explains. Each check logs its time and the process's RSS.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { check } from "tla-ts";
import { describe, expect, it } from "vitest";

import { checks, readModule, readPlan } from "../scripts/feature-d-plan.mjs";
import { compareObservation } from "../test/feature-d-observe.js";
import type { Fixture } from "../test/feature-d-observe.js";
import { FIXTURE_DIR, REPLAY_FILE, fixtureText, generateFixtures } from "./feature-d-fixtures.js";

const plan = readPlan();
// The largest check, S2, takes about 4 s and 340 MB under tla-ts on a laptop.
const CHECK_TIMEOUT_MS = 120_000;
const REPLAY_PATH = fileURLToPath(new URL(`../${REPLAY_FILE}`, import.meta.url));

// Each of Kopje's steps in FeatureD.tla, an inbound activity by its envelope: the replay fixtures run each one.
const KOPJE_STEPS = [
  ...["FR", "Add", "XAdd", "Rem", "Upd", "RemC", "DelR"].map((type) => `KRecv.${type}`),
  "KApplyFetch",
  "KRevoke",
  "KBlock",
  "KMemberGone",
  "KCleanup",
  "KClaim",
  "KFetch",
  "KFetch1",
  "KFetch2",
  "KApply",
  "KLease",
  "KStale",
  "KExpire",
  "KDeliver",
  "KGiveUp",
  "KDup",
  "KRetry",
];

const fixtureFiles = () =>
  readdirSync(FIXTURE_DIR)
    .filter((file) => file.endsWith(".json"))
    .toSorted();
const readFixture = (file: string) => JSON.parse(readFileSync(`${FIXTURE_DIR}${file}`, "utf8")) as Fixture;

describe("spec/feature-d under tla-ts", () => {
  for (const c of checks(plan)) {
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
          : { status: result.status, invariant: result.violation?.name, trace: result.violation?.trace.length };
      expect(got).toEqual(c.expected);
    });
  }
});

describe("replay fixtures", () => {
  it("equal a fresh run of the specification", { timeout: CHECK_TIMEOUT_MS }, async () => {
    const fresh = await generateFixtures(plan);
    expect(fixtureFiles()).toEqual(fresh.map((f) => `${f.name}.json`).toSorted());
    for (const fixture of fresh) {
      expect(readFileSync(`${FIXTURE_DIR}${fixture.name}.json`, "utf8"), fixture.name).toBe(fixtureText(fixture));
    }
  });

  it("run each of Kopje's steps", () => {
    const covered = new Set(
      fixtureFiles().flatMap((file) =>
        readFixture(file).steps.map((s) => (s.action === "KRecv" ? `KRecv.${s.input.envelope?.type}` : s.action)),
      ),
    );
    expect(KOPJE_STEPS.filter((s) => !covered.has(s))).toEqual([]);
  });

  it("each name their replay", () => {
    for (const file of fixtureFiles()) {
      const fixture = readFixture(file);
      expect(fixture.replayedBy).toBe(`${REPLAY_FILE}::${fixture.name}`);
    }
  });

  // The replay is the implementer's (a workerd test against the real Store). Until it exists only the names above
  // are checked; then each fixture's name must appear as a string literal in it, so a fixture added later fails here
  // until a test runs it.
  it.skipIf(!existsSync(REPLAY_PATH))("are each run by the replay they name", () => {
    const source = readFileSync(REPLAY_PATH, "utf8");
    const missing = fixtureFiles()
      .map((file) => readFixture(file).name)
      .filter((name) => !['"', "'", "`"].some((quote) => source.includes(`${quote}${name}${quote}`)));
    expect(missing).toEqual([]);
  });
});

describe("compareObservation", () => {
  // L's block of an accepted row: it records the row's Delete and the Block.
  const observation = readFixture("S6-BlockRow.json").steps.at(-1)!.observation;

  it("finds no difference between equal observations, whatever the order of the recorded activities", () => {
    expect(observation.recorded).toHaveLength(2);
    const recorded = observation.recorded.toReversed();
    expect(compareObservation(observation, { ...observation, recorded })).toEqual([]);
  });

  it("names each field that differs", () => {
    const exact = { ...observation, unspecified: [] };
    const row = observation.row && { ...observation.row, listedAs: "I1" as const };
    expect(compareObservation(exact, { ...observation, row, memberShows: true })).toEqual([
      'row.listedAs: expected null, got "I1"',
      "memberShows: expected false, got true",
    ]);
  });

  it("skips the fields the design leaves open at the step", () => {
    expect(observation.unspecified).toEqual(["row.listedAs"]);
    const row = observation.row && { ...observation.row, listedAs: "I1" as const };
    expect(compareObservation(observation, { ...observation, row })).toEqual([]);
  });
});
