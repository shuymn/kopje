// Part 0 of the specification's checks (./checks.ts says how they are split): its share of the checks of checks.json,
// and the plan's own consistency: every .cfg is a check, every named property has a mutation that breaks it, the
// mutations and the goals of checks.json are exactly the ones the specification defines, and every goal is checked.
import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { SPEC_DIR } from "../../scripts/media-upload-plan.mjs";
import { plan, tlaTsChecks } from "./checks.js";

tlaTsChecks(import.meta.url);

const read = (module: string) => readFileSync(`${SPEC_DIR}${module}.tla`, "utf8");
const main = read("MediaUpload");
// The definitions of MediaUpload.tla between its heading (* <heading> and the next separator line.
const defined = (heading: string) => {
  const from = main.indexOf(`(* ${heading}`);
  if (from < 0) throw new Error(`MediaUpload.tla has no heading ${heading}`);
  const rest = main.slice(from);
  const to = rest.search(/^(-{4,}|={4,})$/m);
  return [...rest.slice(0, to).matchAll(/^([A-Z]\w*)(\(\w+\))? ==/gm)]
    .filter((m) => m[2] === undefined)
    .map((m) => m[1] ?? "");
};
// The operators of the sections that are no named property.
const HELPERS = new Set(["Running", "Excused", "PendingRoom"]);
// Every mutation the modules name: Variant = "X" or Variant # "X".
const variantsInSpec = new Set(
  ["MediaUpload", "MediaUploadStore"].flatMap((m) =>
    [...read(m).matchAll(/Variant (?:=|#) "(\w+)"/g)].map((match) => match[1] ?? ""),
  ),
);
// The goals MediaUploadGoals.tla's Goals record names.
const goalsInSpec = (() => {
  const source = read("MediaUploadGoals");
  const record = source.slice(source.indexOf("Goals =="), source.indexOf("NotReached =="));
  return new Set([...record.matchAll(/^ {2,3}\[?(\w+) \|->/gm)].map((m) => m[1] ?? ""));
})();

describe("the plan of spec/media-upload", () => {
  it("runs every .cfg as a scenario or a liveness check, and nothing else", () => {
    const cfgs = readdirSync(SPEC_DIR)
      .filter((f) => f.endsWith(".cfg"))
      .map((f) => f.slice(0, -".cfg".length))
      .toSorted();
    expect([...plan.scenarios, ...plan.liveness].map((s) => s.name).toSorted()).toEqual(cfgs);
  });

  it("checks every scenario under every safety invariant, and every liveness scenario under every property", () => {
    const safety = defined("Safety.").filter((name) => !HELPERS.has(name));
    const liveness = defined("Liveness (LSpec).").filter((name) => !HELPERS.has(name));
    expect(safety.length).toBeGreaterThan(0);
    expect(liveness.length).toBeGreaterThan(0);
    for (const { name } of plan.scenarios) {
      const cfg = readFileSync(`${SPEC_DIR}${name}.cfg`, "utf8");
      expect(
        [...cfg.matchAll(/^INVARIANT (\w+)$/gm)].map((m) => m[1]),
        name,
      ).toEqual(safety);
    }
    for (const { name } of plan.liveness) {
      const cfg = readFileSync(`${SPEC_DIR}${name}.cfg`, "utf8");
      expect(
        [...cfg.matchAll(/^PROPERTY (\w+)$/gm)].map((m) => m[1]),
        name,
      ).toEqual(liveness);
    }
  });

  it("breaks every named property with a mutation", () => {
    const named = [...defined("Safety."), ...defined("Liveness (LSpec).")].filter((name) => !HELPERS.has(name));
    const broken = new Set(plan.variants.map((v) => v.property));
    expect(named.filter((name) => !broken.has(name))).toEqual([]);
  });

  it("names exactly the mutations the specification defines, each with the rule it breaks", () => {
    expect([...new Set(plan.variants.map((v) => v.variant))].toSorted()).toEqual([...variantsInSpec].toSorted());
    for (const v of plan.variants) expect(v.breaks.trim(), v.name).not.toBe("");
  });

  it("reaches exactly the goals the specification defines", () => {
    expect(goalsInSpec.size).toBeGreaterThan(0);
    expect([...new Set(plan.goals.map((g) => g.goal))].toSorted()).toEqual([...goalsInSpec].toSorted());
  });
});
