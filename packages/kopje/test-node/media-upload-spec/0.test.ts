// Part 0 of the specification's checks (./checks.ts says how they are split): its share of the checks of checks.json,
// and the plan's own consistency: every .cfg is a check, every named property has a mutation that breaks it, and
// every mutation is one the specification defines.
import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { SPEC_DIR } from "../../scripts/media-upload-plan.mjs";
import { plan, tlaTsChecks } from "./checks.js";

tlaTsChecks(import.meta.url);

const source = ["MediaUpload", "MediaUploadStore"].map((m) => readFileSync(`${SPEC_DIR}${m}.tla`, "utf8")).join("\n");
// The properties MediaUpload.tla defines under "Safety." and "Liveness (LSpec).", in order.
const defined = (heading: string) => {
  const from = source.indexOf(`(* ${heading}`);
  const to = source.indexOf("----", from);
  return [...source.slice(from, to).matchAll(/^([A-Z]\w*) ==/gm)].map((m) => m[1] ?? "");
};

describe("the plan of spec/media-upload", () => {
  it("runs every .cfg as a scenario or a liveness check, and nothing else", () => {
    const cfgs = readdirSync(SPEC_DIR)
      .filter((f) => f.endsWith(".cfg"))
      .map((f) => f.slice(0, -".cfg".length))
      .toSorted();
    expect([...plan.scenarios, ...plan.liveness].map((s) => s.name).toSorted()).toEqual(cfgs);
  });

  it("checks every scenario under every safety invariant, and every liveness scenario under every property", () => {
    const safety = defined("Safety.").filter((name) => name !== "Running" && name !== "Excused");
    const liveness = defined("Liveness (LSpec).").filter((name) => name !== "PendingRoom");
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
    const named = [...defined("Safety."), ...defined("Liveness (LSpec).")].filter(
      (name) => !["Running", "Excused", "PendingRoom"].includes(name),
    );
    const broken = new Set(plan.variants.map((v) => v.property));
    expect(named.filter((name) => !broken.has(name))).toEqual([]);
  });

  it("names only mutations the specification defines, each with the rule it breaks", () => {
    for (const v of plan.variants) {
      expect(source.includes(`"${v.variant}"`), v.variant).toBe(true);
      expect(v.breaks.trim(), v.name).not.toBe("");
    }
  });
});
