import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { normalized } from "../test/sql-text.js";
import { nodeStorage, rolledBack, transaction, witnessDatabase, witnessWorld } from "./witness-store.js";

// The provenance of test/main-runtime/recorded.json, which the main-runtime witnesses and shown-walk-work.test.ts read
// main's statements from: its `main` side is what main's sources at its `base` commit issue in each flow of
// witness-world.ts, and its `mine` side what the current sources issue. Both are recorded here, on Node's SQLite, and
// compared with the file: main's sources are taken from Git (`git archive`; a clone without that commit fails, naming
// the fetch that brings it, as CI's test jobs run it), with the current witness-world.ts beside them (it names nothing
// only one side has). The main-runtime witnesses check in turn that workerd runs the `mine` sequences (as many of
// each statement as recorded).
// KOPJE_RECORD_WITNESS=1 rewrites the file from the two recordings instead, which a change to the rewrite's statements
// requires.

type Recorded = {
  base: string;
  procedure: string;
  statements: string[];
  runs: Record<string, { main: number[]; mine: number[] }>;
};
const FILE = new URL("../test/main-runtime/recorded.json", import.meta.url);
const PACKAGE = new URL("../", import.meta.url);
const recorded = JSON.parse(readFileSync(FILE, "utf8")) as Recorded;
const PROCEDURE =
  "test-node/witness-recording.test.ts: each flow of test/main-runtime/witness-world.ts in each world, on main's sources at `base` (mine: the current sources), on Node's SQLite; KOPJE_RECORD_WITNESS=1 rewrites this file";
const GIT_MS = 60_000;

// The statements each flow issues in each world, whitespace collapsed, with the sources under `root`.
async function record(root: URL): Promise<Record<string, string[]>> {
  const { buildWorld, FLOWS, WORLDS, worldName } = await witnessWorld(root);
  const runs: Record<string, string[]> = {};
  for (const world of WORLDS) {
    const db = witnessDatabase();
    try {
      const transact = transaction(db);
      const context = transact(() => buildWorld(nodeStorage(db), world));
      for (const [flow, { run }] of Object.entries(FLOWS)) {
        const texts: string[] = [];
        const storage = nodeStorage(db, (query, params) => {
          texts.push(normalized(query));
          return db.prepare(query).all(...params);
        });
        rolledBack(db, () => run(storage, transact, context));
        runs[`${worldName(world)} ${flow}`] = texts;
      }
    } finally {
      db.close();
    }
  }
  return runs;
}

// The package's sources at `base` in a directory of their own, with the current witness-world.ts beside them;
// removed after `fn`, whatever it does.
async function atBase<T>(base: string, fn: (root: URL) => Promise<T>): Promise<T> {
  // The repository's root: a pathspec is read from the working directory, inside the tree named.
  const root = fileURLToPath(new URL("../../", PACKAGE));
  try {
    execFileSync("git", ["cat-file", "-e", `${base}^{commit}`], { cwd: root, stdio: "ignore", timeout: GIT_MS });
  } catch {
    throw new Error(
      `recorded.json's base ${base} is not in this clone; fetch it: git fetch --no-tags --depth=1 origin ${base}`,
    );
  }
  const tmp = fileURLToPath(new URL(".wrangler/tmp/", PACKAGE));
  mkdirSync(tmp, { recursive: true });
  const dir = mkdtempSync(`${tmp}witness-base-`);
  try {
    const archive = execFileSync("git", ["archive", "--format=tar", `${base}:packages/kopje`, "src"], {
      cwd: root,
      maxBuffer: 256 * 1024 * 1024,
      timeout: GIT_MS,
    });
    execFileSync("tar", ["-x", "-C", dir], { input: archive, timeout: GIT_MS });
    mkdirSync(`${dir}/test/main-runtime`, { recursive: true });
    copyFileSync(new URL("test/main-runtime/witness-world.ts", PACKAGE), `${dir}/test/main-runtime/witness-world.ts`);
    return await fn(pathToFileURL(`${dir}/`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The recorded sequences of one side, as texts.
const side = (which: "main" | "mine") =>
  Object.fromEntries(
    Object.entries(recorded.runs).map(([key, run]) => [key, run[which].map((n) => recorded.statements[n])]),
  );

const rewriting = process.env.KOPJE_RECORD_WITNESS === "1";

describe.skipIf(rewriting)("recorded.json", () => {
  it("names its base commit and how it is recorded", () => {
    expect(recorded.base).toMatch(/^[0-9a-f]{40}$/);
    expect(recorded.procedure).toBe(PROCEDURE);
  });

  it("holds the statements main's sources at its base issue", { timeout: 300_000 }, async () => {
    expect(side("main")).toEqual(await atBase(recorded.base, record));
  });

  it("holds the statements the current sources issue", { timeout: 300_000 }, async () => {
    expect(side("mine")).toEqual(await record(PACKAGE));
  });
});

describe.skipIf(!rewriting)("recording recorded.json", () => {
  it("rewrites it from both sources", { timeout: 600_000 }, async () => {
    const main = await atBase(recorded.base, record);
    const mine = await record(PACKAGE);
    const statements: string[] = [];
    const index = new Map<string, number>();
    const at = (text: string) => {
      if (!index.has(text)) {
        index.set(text, statements.push(text) - 1);
      }
      return index.get(text)!;
    };
    const runs = Object.fromEntries(
      Object.keys(mine).map((key) => [key, { main: main[key]!.map(at), mine: mine[key]!.map(at) }]),
    );
    const file: Recorded = { base: recorded.base, procedure: PROCEDURE, statements, runs };
    writeFileSync(FILE, `${JSON.stringify(file, null, 2)}\n`);
  });
});
