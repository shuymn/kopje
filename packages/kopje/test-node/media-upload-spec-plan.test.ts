// The plan of spec/media-upload/ against the specification itself, in the Node suite, which every Kopje change runs
// (the checks the plan lists run in the kopje-spec project, media-upload-spec/checks.ts): every .cfg is a check, every
// named property has a mutation that breaks it, the mutations of checks.json are exactly the (property, mutation,
// scenario) triples MediaUpload.tla's Mutations declares, and its goals exactly the ones MediaUploadGoals.tla defines.
import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { readPlan, SPEC_DIR } from "../scripts/media-upload-plan.mjs";

const plan = readPlan();

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
const HELPERS = new Set(["Running", "Excused", "PendingRoom", "Mutations"]);
// Every mutation the modules name: Variant = "X" or Variant # "X".
const variantsInSpec = new Set(
  ["MediaUpload", "MediaUploadStore"].flatMap((m) =>
    [...read(m).matchAll(/Variant (?:=|#) "(\w+)"/g)].map((match) => match[1] ?? ""),
  ),
);
// The (property, mutation, scenario) triples MediaUpload.tla's Mutations declares, each as "property variant scenario".
const declared = (() => {
  const from = main.indexOf("Mutations ==");
  if (from < 0) throw new Error("MediaUpload.tla declares no Mutations");
  const set = main.slice(from, main.indexOf("}", from));
  return [...set.matchAll(/<<"(\w+)", "(\w+)", "(\w+)">>/g)].map((m) => `${m[1]} ${m[2]} ${m[3]}`);
})();
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

  it("runs exactly the mutations MediaUpload.tla declares, each once", () => {
    const run = plan.variants.map((v) => `${v.property} ${v.variant} ${v.scenario}`);
    expect(new Set(run).size).toBe(run.length);
    expect(run.toSorted()).toEqual(declared.toSorted());
    for (const v of plan.variants) expect(v.name, v.name).toBe(`${v.property}-${v.variant}`);
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
