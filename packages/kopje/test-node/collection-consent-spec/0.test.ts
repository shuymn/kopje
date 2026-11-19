// Part 0 of the specification's checks (./checks.ts says how they are split): its share of the checks of checks.json,
// the calibration variants against the replay, and compareObservation.
import { describe, expect, it } from "vitest";

import { compareObservation } from "../../test/collection-consent-observe.js";
import type { Fixture } from "../../test/collection-consent-observe.js";
import { reproduces } from "../collection-consent-fixtures.js";
import { CHECK_TIMEOUT_MS, fixtureFiles, plan, readFixture, tlaTsChecks } from "./checks.js";

tlaTsChecks(import.meta.url);

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
