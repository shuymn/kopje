// Runs every check of spec/collection-consent/checks.json under the official TLC and compares its outcome with the one
// recorded there, which test-node/collection-consent-spec/ requires of tla-ts: a scenario's and the induction's
// status, distinct states and depth; a variant's, finding's or goal's violated invariant and shortest-trace length.
// Only the induction's count is TLC's own (checks.json says why). Any other difference is a disagreement between the
// two checkers to report, not a count to update.
//
//   node scripts/tlc-check.mjs [--jar <tla2tools.jar>] [--only <name>]... [--trace]
//
// --only runs the checks of that name (S2, V13, S1-Accepted: checks.json's names); --trace prints TLC's
// report of each violation, its trace with every variable at every step.
//
// The jar is TLC's release TLC_VERSION, checked against TLC_SHA256; without --jar it is downloaded once into
// node_modules/.cache/. java is the JDK mise.spec.toml pins (`MISE_ENV=spec mise exec -- node scripts/tlc-check.mjs`).
// Each check runs in its own directory under the system temporary directory, one TLC worker at a time, and the
// directory is removed after it.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { SPEC_DIR, checks, readPlan } from "./collection-consent-plan.mjs";

const TLC_VERSION = "1.7.4";
const TLC_URL = `https://github.com/tlaplus/tlaplus/releases/download/v${TLC_VERSION}/tla2tools.jar`;
const TLC_SHA256 = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88";
const CACHE = fileURLToPath(new URL(`../node_modules/.cache/kopje-tlc/tla2tools-${TLC_VERSION}.jar`, import.meta.url));
// The heavy pack's bound: one checker process, at most 6 GB resident. The JVM's heap stays well inside it.
const JAVA_ARGS = ["-Xmx3g", "-XX:+UseParallelGC"];

/** @param {Buffer} bytes */
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** @param {string | undefined} given */
async function tlcJar(given) {
  const path = given ? resolve(given) : CACHE;
  if (!existsSync(path)) {
    if (given) throw new Error(`no jar at ${given}`);
    const response = await fetch(TLC_URL);
    if (!response.ok) throw new Error(`GET ${TLC_URL}: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== TLC_SHA256) throw new Error(`${TLC_URL} does not have SHA-256 ${TLC_SHA256}`);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, bytes);
  }
  const digest = sha256(readFileSync(path));
  if (digest !== TLC_SHA256) throw new Error(`${path} has SHA-256 ${digest}, not TLC ${TLC_VERSION}'s ${TLC_SHA256}`);
  return path;
}

/**
 * TLC's outcome, read from its output: an invariant violation names the invariant and prints one "State n:" per
 * state of the trace; a completed search prints its distinct states and depth.
 * @param {string} output
 */
export function parseTlc(output) {
  const violated = /^Error: Invariant (\w+) is violated/m.exec(output);
  if (violated) {
    const trace = output.match(/^State \d+: /gm)?.length ?? 0;
    return { status: "invariant-violation", invariant: violated[1], trace };
  }
  const distinct = /^\d+ states generated, (\d+) distinct states found, 0 states left on queue/m.exec(output);
  const depth = /^The depth of the complete state graph search is (\d+)/m.exec(output);
  if (/^Model checking completed\. No error has been found\./m.test(output) && distinct && depth) {
    return { status: "success", distinct: Number(distinct[1]), depth: Number(depth[1]) };
  }
  return { status: "error", output: output.split("\n").slice(-30).join("\n") };
}

/**
 * @param {string} jar
 * @param {import("./collection-consent-plan.mjs").Check} check
 */
function runTlc(jar, check) {
  const dir = mkdtempSync(join(tmpdir(), "kopje-tlc-"));
  try {
    for (const file of readdirSync(SPEC_DIR).filter((f) => f.endsWith(".tla"))) {
      copyFileSync(join(SPEC_DIR, file), join(dir, file));
    }
    writeFileSync(join(dir, "check.cfg"), check.config);
    const args = [...JAVA_ARGS, "-cp", jar, "tlc2.TLC", "-workers", "1", "-cleanup", "-metadir", join(dir, "states")];
    let output;
    try {
      output = execFileSync("java", [...args, "-config", "check.cfg", `${check.module}.tla`], {
        cwd: dir,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      // TLC exits non-zero on a violation; its report is still on stdout.
      const { stdout, stderr } = /** @type {{ stdout?: string, stderr?: string }} */ (error);
      output = `${stdout ?? ""}${stderr ?? ""}` || String(error);
    }
    return { ...parseTlc(output), report: output };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({
    options: { jar: { type: "string" }, only: { type: "string", multiple: true }, trace: { type: "boolean" } },
  });
  const jar = await tlcJar(values.jar);
  const selected = checks(readPlan()).filter((c) => !values.only || values.only.includes(c.name));
  if (selected.length === 0) throw new Error(`no check named ${(values.only ?? []).join(", ")} in checks.json`);
  let failed = 0;
  for (const check of selected) {
    const start = Date.now();
    const { report, ...got } = runTlc(jar, check);
    const ms = Date.now() - start;
    const expected = check.tlc ?? check.expected;
    const same = JSON.stringify(got) === JSON.stringify(expected);
    if (!same) failed += 1;
    const shown = (/** @type {Record<string, unknown>} */ o) =>
      Object.entries(o)
        .filter(([key]) => key !== "output")
        .map(([key, value]) => `${key} ${String(value)}`)
        .join(", ");
    console.log(`${same ? "ok  " : "DIFF"} ${check.kind} ${check.name}: TLC ${shown(got)} (${ms} ms)`);
    if (!same) console.log(`     checks.json: ${shown(expected)}`);
    else if (check.tlc) console.log(`     tla-ts: ${shown(check.expected)} (checks.json says why they differ)`);
    if (got.status === "error") console.log(got.output);
    if (values.trace && got.status === "invariant-violation") console.log(report.slice(report.indexOf("Error: ")));
  }
  console.log(failed === 0 ? "TLC agrees with every check." : `TLC disagrees on ${failed} checks.`);
  process.exitCode = failed === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
