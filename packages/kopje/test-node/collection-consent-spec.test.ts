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
// that changes checks.json explains. Each check logs its time and the process's RSS.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { check } from "tla-ts";
import { describe, expect, it } from "vitest";

import { checks, readModule, readPlan } from "../scripts/collection-consent-plan.mjs";
import { compareObservation } from "../test/collection-consent-observe.js";
import type { Fixture } from "../test/collection-consent-observe.js";
import { FIXTURE_DIR, REPLAY_FILE, fixtureText, generateFixtures, reproduces } from "./collection-consent-fixtures.js";

const plan = readPlan();
// The largest check, the induction, takes about 30 s under tla-ts on a laptop.
const CHECK_TIMEOUT_MS = 120_000;
// A fresh run of every fixture's goal: about 85 s on a laptop, S2-ReadOverRetraction's about 40 s of it.
const FIXTURES_TIMEOUT_MS = 300_000;
const REPLAY_PATH = fileURLToPath(new URL(`../${REPLAY_FILE}`, import.meta.url));

// Each of Kopje's steps in CollectionConsent.tla, an inbound activity by its envelope: the replay fixtures run each
// one.
const KOPJE_STEPS = [
  ...["FR", "Add", "XAdd", "Rem", "Upd", "RemC", "DelR"].map((type) => `KRecv.${type}`),
  "KApplyFetch",
  "KRevoke",
  "KBlock",
  "KSuspend",
  "KUnsuspend",
  "KCleanup",
  "KEvict",
  "KPurge",
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
  "KLeaseHead",
  "KFail",
];

// Steps the real Store cannot take: Kopje deletes no local account (src/domain/delivery-hosts.ts, hostCaused).
const MODEL_ONLY = ["KMemberGone"];

const fixtureFiles = () =>
  readdirSync(FIXTURE_DIR)
    .filter((file) => file.endsWith(".json"))
    .toSorted();
const readFixture = (file: string) => JSON.parse(readFileSync(`${FIXTURE_DIR}${file}`, "utf8")) as Fixture;

describe("spec/collection-consent under tla-ts", () => {
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
  it("equal a fresh run of the specification", { timeout: FIXTURES_TIMEOUT_MS }, async () => {
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

  it("take no step the Store cannot take", () => {
    const taken = fixtureFiles().flatMap((file) =>
      readFixture(file)
        .steps.filter((s) => MODEL_ONLY.includes(s.action))
        .map((s) => `${file}: ${s.action}`),
    );
    expect(taken).toEqual([]);
  });

  it("each name their replay", () => {
    for (const file of fixtureFiles()) {
      const fixture = readFixture(file);
      expect(fixture.replayedBy).toBe(`${REPLAY_FILE}::${fixture.name}`);
    }
  });

  // The replay is the implementer's (a workerd test against the real Store, one test per fixture, titled by the
  // fixture's name). Until it exists only the names above are checked; then each fixture's name must appear as a string
  // literal in it, and it may skip none, so a fixture added later fails here until a test runs it. That each fixture's
  // test ran and passed is checked from the replay's own run (scripts/collection-consent-coverage.mjs forward).
  it.skipIf(!existsSync(REPLAY_PATH))("are each run by the replay they name", () => {
    const source = readFileSync(REPLAY_PATH, "utf8");
    const missing = fixtureFiles()
      .map((file) => readFixture(file).name)
      .filter((name) => !['"', "'", "`"].some((quote) => source.includes(`${quote}${name}${quote}`)));
    expect(missing).toEqual([]);
    expect(source.match(/\.(skip|skipIf|todo|only|fails)\b/g) ?? []).toEqual([]);
  });
});

describe("the calibration variants against the replay", () => {
  const fixtures = new Map(
    fixtureFiles().map((file): [string, Fixture] => [file.slice(0, -".json".length), readFixture(file)]),
  );
  const fixture = (name: string) => {
    const found = fixtures.get(name);
    if (found === undefined) throw new Error(`checks.json's replay names ${name}, which is no fixture`);
    return found;
  };
  // Which fixtures the variant no longer reproduces.
  const failed = async (variant: string) => {
    const names: string[] = [];
    for (const [name, f] of fixtures) if (!(await reproduces(f, variant))) names.push(name);
    return names;
  };

  it("are each caught by a fixture or exempt, once", () => {
    const variants = [...new Set(plan.variants.map((v) => v.variant))].toSorted();
    const named = [...plan.replay.catches, ...plan.replay.exempt].map((entry) => entry.variant).toSorted();
    expect(named).toEqual(variants);
    for (const { fixture: name } of plan.replay.catches) expect(fixtures.has(name), name).toBe(true);
    for (const { variant, why } of plan.replay.exempt) expect(why.trim(), variant).not.toBe("");
  });

  it("start from base rules that reproduce every fixture", { timeout: CHECK_TIMEOUT_MS }, async () => {
    expect(await failed("base")).toEqual([]);
  });

  for (const { variant, fixture: name } of plan.replay.catches) {
    it(`${variant} no longer reproduces ${name}`, { timeout: CHECK_TIMEOUT_MS }, async () => {
      expect(await reproduces(fixture(name), variant)).toBe(false);
    });
  }

  for (const { variant } of plan.replay.exempt) {
    it(`${variant}, exempt, reproduces every fixture`, { timeout: CHECK_TIMEOUT_MS }, async () => {
      expect(await failed(variant)).toEqual([]);
    });
  }
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
    const served = { a1: { status: 200, collection: "C", member: "L" } } as const;
    expect(observation).toMatchObject({
      authorizationGet: { a1: { status: 404 } },
      inCollections: true,
      notified: false,
    });
    const actual = {
      ...observation,
      row,
      authorizationGet: served,
      memberDetail: true,
      inCollections: false,
      notified: true,
    };
    expect(compareObservation(exact, actual)).toEqual([
      'row.listedAs: expected null, got "I1"',
      'authorizationGet: expected [["a1",{"status":404}]], got [["a1",{"status":200,"collection":"C","member":"L"}]]',
      "memberDetail: expected false, got true",
      "inCollections: expected true, got false",
      "notified: expected false, got true",
    ]);
  });

  it("accepts each permitted activity once, besides the required ones", () => {
    const [required, permitted] = observation.recorded;
    const expected = { ...observation, recorded: [required!], mayAlsoRecord: [permitted!] };
    expect(compareObservation(expected, { ...observation, recorded: [required!] })).toEqual([]);
    expect(compareObservation(expected, { ...observation, recorded: [permitted!, required!] })).toEqual([]);
    expect(
      compareObservation(expected, { ...observation, recorded: [permitted!, required!, permitted!] }),
    ).toHaveLength(1);
    expect(compareObservation(expected, { ...observation, recorded: [permitted!] })).toHaveLength(1);
  });

  it("skips the fields the specification leaves open at the step", () => {
    expect(observation.unspecified).toEqual(["row.listedAs"]);
    const row = observation.row && { ...observation.row, listedAs: "I1" as const };
    expect(compareObservation(observation, { ...observation, row })).toEqual([]);
  });
});
