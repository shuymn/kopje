import { readFileSync } from "node:fs";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { createKopjeDatabase } from "../cli/lib/cutover/kopje-db.js";

// Claim 8 of the cursor-rule rewrite (docs/engineering.md "Queries"): in every world of
// test/main-runtime/witness-world.ts, each flow walks no more domain suffixes than main's. Workerd's rows-read counter
// does not count a walk that finds no block (domain-coverage-cost.test.ts), so the walks are counted here as that suite
// counts them: instr(), overridden by a counting function of the same behavior, is called at every label a walk steps.
// The worlds and flows run on Node's SQLite (3.54.1) through a SqlStorage over it, its expression depth limit at 1,000
// so that main's statements prepare; main's side runs the same flow with main's literal text in place of each statement
// the rewrite changed (test/main-runtime/recorded.json, recorded from main's code), bound to the same parameters.

const EXPR_DEPTH = 1_000;

type Recorded = { statements: string[]; runs: Record<string, { main: number[]; mine: number[] }> };
const { statements, runs } = JSON.parse(
  readFileSync(new URL("../test/main-runtime/recorded.json", import.meta.url), "utf8"),
) as Recorded;

type World = { blocks: string; shape: string };
type Run = (sql: unknown, transact: <T>(fn: () => T) => T, context: unknown) => unknown;
// The worlds and flows, loaded by a computed specifier: they are typed against the Workers runtime, which this suite's
// TypeScript project does not include.
const { buildWorld, FLOWS, WORLDS, worldName } = (await import(
  new URL("../test/main-runtime/witness-world.ts", import.meta.url).href
)) as {
  buildWorld: (sql: unknown, world: World) => unknown;
  FLOWS: Record<string, { run: Run }>;
  WORLDS: World[];
  worldName: (world: World) => string;
};

const normalized = (sql: string) => sql.replace(/\s+/g, " ").trim();

// A statement main's code read through its own post-processing: a candidate window (src/domain/windows.ts), whose
// rows the rewrite's code reads in another shape.
const reshaped = (main: string) => main.includes("f(bound) AS");

let calls = 0;
let counting = true;

// The SqlStorage surface the Store's code reads (Db in src/db/sql.ts), over node:sqlite. `swap` gives main's text to
// run in place of a statement, from its normalized text: its walks are counted, and a reshaped statement's rows are
// the rewrite's, read uncounted.
function storage(db: DatabaseSync, swap: (text: string) => string | undefined) {
  const changes = db.prepare("SELECT total_changes() AS n");
  return {
    exec(query: string, ...params: SQLInputValue[]) {
      const main = swap(normalized(query));
      const before = changes.get()!.n as number;
      let rows = db.prepare(main ?? query).all(...params);
      if (main !== undefined && reshaped(main)) {
        counting = false;
        rows = db.prepare(query).all(...params);
        counting = true;
      }
      const rowsWritten = (changes.get()!.n as number) - before;
      return {
        rowsRead: 0,
        rowsWritten,
        toArray: () => rows,
        one: () => rows[0],
        [Symbol.iterator]: () => rows[Symbol.iterator](),
      };
    },
  };
}

let savepoints = 0;
function transaction(db: DatabaseSync) {
  return <T>(fn: () => T): T => {
    const name = `s${++savepoints}`;
    db.exec(`SAVEPOINT ${name}`);
    try {
      const result = fn();
      db.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      db.exec(`ROLLBACK TO ${name}`);
      db.exec(`RELEASE ${name}`);
      throw error;
    }
  };
}

// The instr() calls of each flow of `world`, run on main's statements and on the rewrite's, each flow from the world as
// built.
function walks(world: World): Record<string, { main: number; mine: number }> {
  const db = createKopjeDatabase();
  db.limits.exprDepth = EXPR_DEPTH;
  db.function("instr", { deterministic: true }, (haystack, needle) => {
    if (counting) {
      calls++;
    }
    return typeof haystack === "string" && typeof needle === "string" ? haystack.indexOf(needle) + 1 : null;
  });
  const transact = transaction(db);
  const context = transact(() =>
    buildWorld(
      storage(db, () => undefined),
      world,
    ),
  );
  const counted: Record<string, { main: number; mine: number }> = {};
  for (const [flow, { run }] of Object.entries(FLOWS)) {
    const recorded = runs[`${worldName(world)} ${flow}`]!;
    const side = (main: boolean): number => {
      let position = 0;
      const swap = (text: string) => {
        const at = position++;
        expect(text, `${flow}: statement ${at} as recorded`).toBe(statements[recorded.mine[at]!]);
        return main ? statements[recorded.main[at]!] : undefined;
      };
      calls = 0;
      db.exec("SAVEPOINT flow");
      try {
        run(storage(db, swap), transact, context);
      } finally {
        db.exec("ROLLBACK TO flow");
        db.exec("RELEASE flow");
      }
      expect(position, `${flow}: statements as recorded`).toBe(recorded.mine.length);
      return calls;
    };
    counted[flow] = { main: side(true), mine: side(false) };
  }
  db.close();
  return counted;
}

// Each world's walks on main's statements, over its flows.
const totals = new Map<string, number>();

describe("the walks of each flow beside main's", () => {
  it.each(WORLDS.map((world) => [worldName(world), world] as const))("%s", { timeout: 300_000 }, (name, world) => {
    let total = 0;
    for (const [flow, { main, mine }] of Object.entries(walks(world))) {
      expect(mine, `${name} ${flow}`).toBeLessThanOrEqual(main);
      total += main;
    }
    totals.set(name, total);
  });

  // The meter's positive control: in each shape, suspend blocks make main's flows walk the accounts' domains.
  it("counts the walks suspend blocks add", () => {
    for (const shape of new Set(WORLDS.map((world) => world.shape))) {
      const none = totals.get(`none/${shape}`)!;
      expect(totals.get(`noncovering/${shape}`)!, shape).toBeGreaterThan(none);
      expect(totals.get(`covering/${shape}`)!, shape).toBeGreaterThan(none);
    }
  });
});
