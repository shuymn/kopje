// The checks of spec/collection-consent/, the TLA+ specification of a local account's consent to membership in a remote
// collection (#1589), as one plan that both checkers run: test-node/collection-consent-spec.test.ts under tla-ts,
// scripts/tlc-check.mjs under the official TLC. spec/collection-consent/checks.json holds each check's expected
// outcome; this module gives each check the root module and the configuration a checker reads.
//
// scenario one focused scenario of CollectionConsent.tla (its .cfg): no invariant fails; distinct states and depth
//              fixed.
// induction Ind.cfg over CollectionConsentInd.tla: IndInv holds one step after every state that satisfies it. Where a
//              successor lies outside the starting states, TLC counts it and tla-ts does not; checks.json may then
//              record TLC's own count ("tlc").
// variant a calibration variant: the named invariant fails, with a shortest trace of the given length. Its scenario is
//              a scenario's name, or the induction's (then CollectionConsentInd.tla under Ind.cfg's bounds).
// finding a violation of the specified rules themselves: it must still fail until the rules change, and then
//              checks.json and the spec change with it.
// goal a reachability trap (CollectionConsentGoals.tla): NotReached fails, so the goal is reached, and its shortest
//              witness has the given length; a goal marked fixture is also a replay fixture.
//
// Goals are searched without CollectionConsent's VIEW: a step that changes only `last` (a 503, which leaves the
// envelope for R's retry) reaches a state the view has already seen, and a trap on that step would never fire.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SPEC_DIR = fileURLToPath(new URL("../spec/collection-consent/", import.meta.url));

/** @typedef {{ name: string, distinct: number, depth: number }} Scenario */
/** @typedef {Scenario & { tlc?: { distinct: number, depth: number, why: string } }} Induction */
/** @typedef {{ name: string, scenario: string, variant: string, invariant: string, trace: number }} Violation */
/** @typedef {{ name: string, scenario: string, goal: string, trace: number, fixture: boolean }} Goal */
/**
 * @typedef {{ scenarios: Scenario[], induction: Induction, variants: Violation[], findings: Violation[],
 *   goals: Goal[] }} Plan
 */
/**
 * @typedef {{ status: "success", distinct: number, depth: number }
 *   | { status: "invariant-violation", invariant: string, trace: number }} Expected
 */
/**
 * @typedef {{ kind: string, name: string, module: string, config: string, expected: Expected, tlc?: Expected }} Check
 *   tlc: TLC's outcome where its count differs from tla-ts's by convention
 */

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
 * @param {Record<string, string>} constants
 * @param {string[]} lines
 */
function config(constants, lines) {
  const values = Object.entries(constants).map(([name, value]) => `  ${name} = "${value}"`);
  return ["CONSTANTS", ...values, "INIT Init", "NEXT Next", "CHECK_DEADLOCK FALSE", ...lines, ""].join("\n");
}

/**
 * A goal's configuration; with alias, the trace is projected to the replay fixtures' JSON
 * (CollectionConsentFixtures.tla).
 * @param {Goal} goal
 * @param {boolean} alias
 */
export function goalConfig(goal, alias) {
  return config({ Scenario: goal.scenario, Variant: "base", Goal: goal.goal }, [
    "INVARIANT NotReached",
    ...(alias ? ["ALIAS Alias"] : []),
  ]);
}

/**
 * The induction's configuration with another variant and one invariant.
 * @param {string} name
 * @param {string} variant
 * @param {string} invariant
 */
function inductionConfig(name, variant, invariant) {
  const text = readFileSync(`${SPEC_DIR}${name}.cfg`, "utf8");
  const changed = text
    .replace(/^CONSTANT Variant = "base"$/m, `CONSTANT Variant = "${variant}"`)
    .replace(/^INVARIANT IndInv$/m, `INVARIANT ${invariant}`);
  if (!changed.includes(`"${variant}"`) || !changed.includes(`INVARIANT ${invariant}`)) {
    throw new Error(`${name}.cfg names no variant or invariant to replace`);
  }
  return changed;
}

/**
 * Every check of the plan, in the order both checkers run them.
 * @param {Plan} plan
 * @returns {Check[]}
 */
export function checks(plan) {
  /** @param {Violation} v @param {string} kind @returns {Check} */
  const violation = (v, kind) => ({
    kind,
    name: v.name,
    ...(v.scenario === plan.induction.name
      ? { module: "CollectionConsentInd", config: inductionConfig(plan.induction.name, v.variant, v.invariant) }
      : {
          module: "CollectionConsent",
          config: config({ Scenario: v.scenario, Variant: v.variant }, ["VIEW View", `INVARIANT ${v.invariant}`]),
        }),
    expected: { status: "invariant-violation", invariant: v.invariant, trace: v.trace },
  });
  return [
    ...plan.scenarios.map((s) => ({
      kind: "scenario",
      name: s.name,
      module: "CollectionConsent",
      config: readFileSync(`${SPEC_DIR}${s.name}.cfg`, "utf8"),
      expected: /** @type {Expected} */ ({ status: "success", distinct: s.distinct, depth: s.depth }),
    })),
    {
      kind: "induction",
      name: plan.induction.name,
      module: "CollectionConsentInd",
      config: readFileSync(`${SPEC_DIR}${plan.induction.name}.cfg`, "utf8"),
      expected: { status: "success", distinct: plan.induction.distinct, depth: plan.induction.depth },
      ...(plan.induction.tlc && {
        tlc: { status: "success", distinct: plan.induction.tlc.distinct, depth: plan.induction.tlc.depth },
      }),
    },
    ...plan.variants.map((v) => violation(v, "variant")),
    ...plan.findings.map((v) => violation(v, "finding")),
    ...plan.goals.map((g) => ({
      kind: "goal",
      name: g.name,
      module: "CollectionConsentGoals",
      config: goalConfig(g, false),
      expected: /** @type {Expected} */ ({ status: "invariant-violation", invariant: "NotReached", trace: g.trace }),
    })),
  ];
}
