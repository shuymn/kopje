// The drift record of spec/collection-consent/ (coverage.json): the Kopje source files and functions the TLA+
// specification describes, with the commit at which it was last confirmed to describe them and each file's git blob at
// that commit. test-node/collection-consent-coverage.test.ts fails, naming the file, once a covered file's blob differs
// from the record. A change of a covered file then needs a re-look: rerun the specification and the replay, change the
// specification first, on its own, if the behaviour changed, then move the record forward:
//
//   node scripts/collection-consent-coverage.mjs forward
//       runs both checks, requires each fixture's replay test to have run and passed, then records HEAD and the files'
//       blobs
//   node scripts/collection-consent-coverage.mjs initial
//       only while no replay exists: runs the specification's checks alone
//
// Either refuses while a covered file differs from HEAD, so each blob recorded is the blob at the commit recorded.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const RECORD = fileURLToPath(new URL("../spec/collection-consent/coverage.json", import.meta.url));
const SPEC_TESTS = "test-node/collection-consent-spec/";
const REPLAY_TEST = "test/collection-consent-replay.test.ts";
const FIXTURE_DIR = fileURLToPath(new URL("../test/fixtures/collection-consent/", import.meta.url));

/**
 * @typedef {{ path: string, functions: string[], spec: string, blob: string | null }} Covered
 *   path: relative to packages/kopje; spec: what of the specification describes it; blob: null for a file Kopje does
 *   not have yet
 * @typedef {{ confirmed: string, files: Covered[] }} CoverageRecord
 */

/** @returns {CoverageRecord} */
export function readRecord() {
  return JSON.parse(readFileSync(RECORD, "utf8"));
}

/**
 * The git blob id of a file in the working tree, or null when there is none.
 * @param {string} path relative to packages/kopje
 */
export function blobOf(path) {
  const file = `${PACKAGE}${path}`;
  if (!existsSync(file)) return null;
  const bytes = readFileSync(file);
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/** @param {string} command @param {string[]} args */
const run = (command, args) => execFileSync(command, args, { cwd: PACKAGE, stdio: "inherit" });

/**
 * The fixtures for which a run of the replay, as Vitest's JSON reporter writes it, has no passed test titled by the
 * fixture's name.
 * @param {{ testResults: { assertionResults: { title: string, status: string }[] }[] }} report
 * @param {string[]} names
 */
export function unrunFixtures(report, names) {
  const passed = new Set(
    report.testResults
      .flatMap((f) => f.assertionResults)
      .filter((a) => a.status === "passed")
      .map((a) => a.title),
  );
  return names.filter((name) => !passed.has(name));
}

/**
 * Runs the replay and requires a passed test titled by each fixture's name: a fixture named in the replay's source but
 * not run (a loop that skips it, a filter) fails here.
 */
function runReplay() {
  const dir = mkdtempSync(join(tmpdir(), "collection-consent-replay-"));
  try {
    const report = join(dir, "report.json");
    run("pnpm", [
      "exec",
      "vitest",
      "run",
      "--max-workers=1",
      "--reporter=default",
      "--reporter=json",
      `--outputFile.json=${report}`,
      REPLAY_TEST,
    ]);
    const names = readdirSync(FIXTURE_DIR)
      .filter((file) => file.endsWith(".json"))
      .map((file) => file.slice(0, -5));
    const unrun = unrunFixtures(JSON.parse(readFileSync(report, "utf8")), names);
    if (unrun.length > 0) throw new Error(`the replay ran and passed no test for ${unrun.join(", ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** @param {"forward" | "initial"} mode */
function moveForward(mode) {
  const record = readRecord();
  const replay = existsSync(`${PACKAGE}${REPLAY_TEST}`);
  if (mode === "initial" && replay) throw new Error(`${REPLAY_TEST} exists: move the record forward with "forward"`);
  if (mode === "forward" && !replay) throw new Error(`${REPLAY_TEST} does not exist yet: use "initial"`);
  const paths = record.files.map((f) => f.path);
  const dirty = execFileSync("git", ["status", "--porcelain", "--", ...paths], { cwd: PACKAGE, encoding: "utf8" });
  if (dirty.trim() !== "") throw new Error(`commit the covered files first:\n${dirty}`);
  run("pnpm", ["exec", "vitest", "run", "-c", "vitest.spec.config.ts", "--max-workers=1", SPEC_TESTS]);
  if (replay) runReplay();
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: PACKAGE, encoding: "utf8" }).trim();
  const files = record.files.map((f) => ({ ...f, blob: blobOf(f.path) }));
  writeFileSync(RECORD, `${JSON.stringify({ ...record, confirmed: head, files }, null, 2)}\n`);
  console.log(`recorded ${files.length} files at ${head}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (mode !== "forward" && mode !== "initial")
    throw new Error("usage: collection-consent-coverage.mjs forward|initial");
  moveForward(mode);
}
