import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  nodeStorage,
  normalized,
  rolledBack,
  transaction,
  type World,
  witnessDatabase,
  witnessWorld,
} from "./witness-store.js";

// Claim 8 of the cursor-rule rewrite (docs/engineering.md "Queries"): in every world of
// test/main-runtime/witness-world.ts, each flow walks no more domain suffixes than main's. Workerd's rows-read counter
// does not count a walk that finds no block (domain-coverage-cost.test.ts), so the walks are counted here as that suite
// counts them: instr(), overridden by a counting function of the same behavior, is called at every label a walk steps.
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

let calls = 0;
let counting = true;

// The Store over `db`, running main's text in place of a statement where `swap` gives one (from its normalized text):
// its walks are counted, and a reshaped statement's rows are the rewrite's, read uncounted.
function swapping(db: DatabaseSync, swap: (text: string) => string | undefined) {
  return nodeStorage(db, (query, params) => {
    const main = swap(normalized(query));
    const rows = db.prepare(main ?? query).all(...params);
    if (main === undefined || !reshaped(main)) {
      return rows;
    }
    counting = false;
    try {
      return db.prepare(query).all(...params);
    } finally {
      counting = true;
    }
  });
}

// The instr() calls of each flow of `world`, run on main's statements and on the rewrite's, each flow from the world as
// built.
function walks(world: World): Record<string, { main: number; mine: number }> {
  const db = witnessDatabase();
  db.function("instr", { deterministic: true }, (haystack, needle) => {
    if (counting) {
      calls++;
    }
    return typeof haystack === "string" && typeof needle === "string" ? haystack.indexOf(needle) + 1 : null;
  });
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
      calls = 0;
      rolledBack(db, () => run(swapping(db, swap), transact, context));
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
