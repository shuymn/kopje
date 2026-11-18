// The drift record of spec/feature-d/ (coverage.json): the Kopje source files and functions the TLA+ specification
// describes, with the commit at which it was last confirmed to describe them and each file's git blob at that commit.
// test-node/feature-d-coverage.test.ts fails, naming the file, once a covered file's blob differs from the record.
// A change of a covered file then needs a re-look: rerun the specification and the replay, change the specification
// through a challenge if the behaviour changed, then move the record forward:
//
//   node scripts/feature-d-coverage.mjs forward    runs both checks, then records HEAD and the files' blobs
//   node scripts/feature-d-coverage.mjs initial    only while no replay exists: runs the specification's checks alone
//
// Either refuses while a covered file differs from HEAD, so each blob recorded is the blob at the commit recorded.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const RECORD = fileURLToPath(new URL("../spec/feature-d/coverage.json", import.meta.url));
const SPEC_TEST = "test-node/feature-d-spec.test.ts";
const REPLAY_TEST = "test/feature-d-replay.test.ts";

/**
 * @typedef {{ path: string, functions: string[], spec: string, blob: string | null }} Covered
 *   path: relative to packages/kopje; spec: what of the specification describes it; blob: null for a file (d) adds
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

/** @param {"forward" | "initial"} mode */
function moveForward(mode) {
  const record = readRecord();
  const replay = existsSync(`${PACKAGE}${REPLAY_TEST}`);
  if (mode === "initial" && replay) throw new Error(`${REPLAY_TEST} exists: move the record forward with "forward"`);
  if (mode === "forward" && !replay) throw new Error(`${REPLAY_TEST} does not exist yet: use "initial"`);
  const paths = record.files.map((f) => f.path);
  const dirty = execFileSync("git", ["status", "--porcelain", "--", ...paths], { cwd: PACKAGE, encoding: "utf8" });
  if (dirty.trim() !== "") throw new Error(`commit the covered files first:\n${dirty}`);
  run("pnpm", ["exec", "vitest", "run", "-c", "vitest.node.config.ts", "--max-workers=1", SPEC_TEST]);
  if (replay) run("pnpm", ["exec", "vitest", "run", "--max-workers=1", REPLAY_TEST]);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: PACKAGE, encoding: "utf8" }).trim();
  const files = record.files.map((f) => ({ ...f, blob: blobOf(f.path) }));
  writeFileSync(RECORD, `${JSON.stringify({ ...record, confirmed: head, files }, null, 2)}\n`);
  console.log(`recorded ${files.length} files at ${head}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (mode !== "forward" && mode !== "initial") throw new Error("usage: feature-d-coverage.mjs forward|initial");
  moveForward(mode);
}
