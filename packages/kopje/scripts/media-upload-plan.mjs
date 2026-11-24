// The checks of spec/media-upload/, the TLA+ specification of a video or audio upload's lifecycle (#1828 PR4), as one
// plan: test-node/media-upload-spec/ runs it under tla-ts. spec/media-upload/checks.json holds each check's expected
// outcome; this module gives each check the root module and the configuration a checker reads.
//
// scenario  one scenario's .cfg (MediaUpload.tla under every safety invariant): none fails; distinct states and depth
//           fixed.
// liveness  one liveness scenario's .cfg (LSpec under every liveness property): none fails; states and depth fixed.
// variant   a mutation (MediaUploadStore.tla's and MediaUpload.tla's Variant) in a scenario: the named invariant or
//           property fails, with a shortest trace of the given length (a liveness counterexample's length is the
//           checker's, its loop included).
// goal      a reachability trap (MediaUploadGoals.tla): NotReached fails, so the window or order the goal names is
//           reached, with a shortest witness of the given length.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SPEC_DIR = fileURLToPath(new URL("../spec/media-upload/", import.meta.url));

/** @typedef {{ name: string, distinct: number, depth: number }} Run */
/**
 * @typedef {{ name: string, scenario: string, variant: string, property: string, trace: number,
 *   liveness?: boolean, breaks: string }} Variant
 *   breaks: the rule the mutation breaks, and the finding or claim it stands for
 */
/** @typedef {{ name: string, scenario: string, goal: string, trace: number }} Goal */
/** @typedef {{ scenarios: Run[], liveness: Run[], variants: Variant[], goals: Goal[] }} Plan */
/**
 * @typedef {{ status: "success", distinct: number, depth: number }
 *   | { status: "invariant-violation" | "liveness-violation", property: string, trace: number }} Expected
 */
/** @typedef {{ kind: string, name: string, module: string, config: string, expected: Expected }} Check */

/** @returns {Plan} */
export function readPlan() {
  return JSON.parse(readFileSync(`${SPEC_DIR}checks.json`, "utf8"));
}

/**
 * The text of a module of the specification, or undefined for a standard module the checker provides.
 * @param {string} name
 * @returns {string | undefined}
 */
export function readModule(name) {
  try {
    return readFileSync(`${SPEC_DIR}${name}.tla`, "utf8");
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * A scenario's .cfg with another variant and one property in place of its own.
 * @param {string} scenario
 * @param {string} variant
 * @param {string} property
 */
function variantConfig(scenario, variant, property) {
  const text = readFileSync(`${SPEC_DIR}${scenario}.cfg`, "utf8");
  const kept = text
    .split("\n")
    .filter((line) => !/^(INVARIANT|PROPERTY) /.test(line))
    .join("\n")
    .replace(/^ {2}Variant = "base"$/m, `  Variant = "${variant}"`);
  if (!kept.includes(`"${variant}"`)) throw new Error(`${scenario}.cfg names no variant to replace`);
  const keyword = /^SPECIFICATION /m.test(kept) ? "PROPERTY" : "INVARIANT";
  return `${kept.trimEnd()}\n${keyword} ${property}\n`;
}

/** @param {Goal} goal */
function goalConfig(goal) {
  return [
    "CONSTANTS",
    `  Scenario = "${goal.scenario}"`,
    '  Variant = "base"',
    `  Goal = "${goal.goal}"`,
    "INIT Init",
    "NEXT Next",
    "CHECK_DEADLOCK FALSE",
    "INVARIANT NotReached",
    "",
  ].join("\n");
}

/**
 * Every check of the plan, in the order they run.
 * @param {Plan} plan
 * @returns {Check[]}
 */
export function checks(plan) {
  /** @param {Run} s @param {string} kind @returns {Check} */
  const run = (s, kind) => ({
    kind,
    name: s.name,
    module: "MediaUpload",
    config: readFileSync(`${SPEC_DIR}${s.name}.cfg`, "utf8"),
    expected: { status: "success", distinct: s.distinct, depth: s.depth },
  });
  return [
    ...plan.scenarios.map((s) => run(s, "scenario")),
    ...plan.liveness.map((s) => run(s, "liveness")),
    ...plan.variants.map((v) => ({
      kind: "variant",
      name: v.name,
      module: "MediaUpload",
      config: variantConfig(v.scenario, v.variant, v.property),
      expected: /** @type {Expected} */ ({
        status: v.liveness ? "liveness-violation" : "invariant-violation",
        property: v.property,
        trace: v.trace,
      }),
    })),
    ...plan.goals.map((g) => ({
      kind: "goal",
      name: g.name,
      module: "MediaUploadGoals",
      config: goalConfig(g),
      expected: /** @type {Expected} */ ({ status: "invariant-violation", property: "NotReached", trace: g.trace }),
    })),
  ];
}
