import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { normalized } from "../test/sql-text.js";
import { countingInstr } from "./instr-counter.js";
import { nodeStorage, rolledBack, transaction, type World, witnessDatabase, witnessWorld } from "./witness-store.js";

// The cursor-rule rewrite's statements (docs/engineering.md "Queries") walk no more domain suffixes than main's: in
// every world of test/main-runtime/witness-world.ts, each flow walks no more than main's flow does, counted by the
// calls of a counting instr() (instr-counter.ts), which a walk makes at every label it steps.
// The worlds and flows run on Node's SQLite (3.54.1) (witness-store.ts); main's side runs the same flow with main's
// literal text in place of each statement the rewrite changed (test/main-runtime/recorded.json, whose provenance
// witness-recording.test.ts checks), bound to the same parameters.

type Recorded = { statements: string[]; runs: Record<string, { main: number[]; mine: number[] }> };
const { statements, runs } = JSON.parse(
  readFileSync(new URL("../test/main-runtime/recorded.json", import.meta.url), "utf8"),
) as Recorded;

const { buildWorld, FLOWS, WORLDS, worldName } = await witnessWorld(new URL("../", import.meta.url));

// A statement main's code read through its own post-processing: a candidate window (src/domain/windows.ts), whose
// rows the rewrite's code reads in another shape.
const reshaped = (main: string) => main.includes("f(bound) AS");

// The Store over `db`, running main's text in place of a statement where `swap` gives one (from its normalized text):
// its walks are counted, and a reshaped statement's rows are the rewrite's, read uncounted.
function swapping(
  db: DatabaseSync,
  counter: ReturnType<typeof countingInstr>,
  swap: (text: string) => string | undefined,
) {
  return nodeStorage(db, (query, params) => {
    const main = swap(normalized(query));
    const rows = db.prepare(main ?? query).all(...params);
    return main === undefined || !reshaped(main) ? rows : counter.uncounted(() => db.prepare(query).all(...params));
  });
}

// The instr() calls of each flow of `world`, run on main's statements and on the rewrite's, each flow from the world as
// built.
function walks(world: World): Record<string, { main: number; mine: number }> {
  const db = witnessDatabase();
  const counter = countingInstr(db);
  const transact = transaction(db);
  const context = transact(() => buildWorld(nodeStorage(db), world));
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
      counter.reset();
      rolledBack(db, () => run(swapping(db, counter, swap), transact, context));
      expect(position, `${flow}: statements as recorded`).toBe(recorded.mine.length);
      return counter.calls();
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
