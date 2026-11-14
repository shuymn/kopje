import { runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { boundedWindow, type MergedRow, type Window } from "../../src/domain/windows";
import { migratedStore } from "../helpers";
import { statementId } from "../plan-audit";
import { type Baseline, type Count, expectBeside, PlanWitness, STATISTICS } from "../plan-witness";
import type { SqlRow } from "../read-helpers";
import { normalized } from "../sql-text";
import RECORDED from "./recorded.json";
import { buildWorld, FLOWS, POPULATIONS, WORLDS, worldName } from "./witness-world";

// The statements rewritten to stay within SQLite's cursor rule, the candidate windows' included (docs/engineering.md
// "Queries"), cost no more than main's: on the runtime whose SQLite (3.53.4) prepares main's statements, each changed
// statement returns main's rows (a window: main's Window, through each side's own post-processing), writes as many and changes
// the same rows, and reads no more rows than main's, after ANALYZE and under the plan audit's singleton statistics, in
// every world of witness-world.ts; and each flow runs as many statements as main's, each unchanged one as often.
// main's statements are main's literal text, recorded from main's sources at the commit recorded.json names, with the
// flows' other statements (test-node/witness-recording.test.ts checks both sides against the sources): at the
// position where main's sequence and the rewrite's differ, main's statement is the baseline and the rewrite's its
// text; every other statement is allowed as often as main's flow ran it.

type Recorded = { statements: string[]; runs: Record<string, { main: number[]; mine: number[] }> };
const { statements, runs } = RECORDED as Recorded;
const ROLLBACK = new Error("rolled back");

// A window statement's rows as its caller reads them: main's, cut by the bound it returned (main's mergedWindow, its
// two lines copied); the rewrite's, by boundedWindow.
function windowResult(main: string, mine: string): NonNullable<Baseline["result"]> {
  const shape = (text: string, order: RegExp) => {
    const [, direction, limit] = order.exec(text) ?? [];
    if (direction === undefined || limit === undefined) {
      throw new Error(`not a window statement: ${text.slice(0, 80)}`);
    }
    return { ascending: direction === "ASC", size: Number(limit) - 1 };
  };
  const m = shape(main, /ORDER BY id (ASC|DESC) LIMIT (\d+)$/);
  const r = shape(mine, /ORDER BY 1 (ASC|DESC) LIMIT (\d+)$/);
  return {
    main: (rows: SqlRow[]): Window => {
      const typed = rows as { id: string; o: number; bound: string | null }[];
      const cut = typed.length > m.size || (typed[0]?.bound ?? null) !== null;
      return { candidates: typed.slice(0, m.size).map(({ id, o }) => ({ id, o })), cut };
    },
    mine: (rows: SqlRow[]): Window => boundedWindow(rows as MergedRow[], r.ascending, r.size),
  };
}

type Plan = { witness: PlanWitness; expected: string[] };
const plans = new Map<string, Plan>();

// The witness of one flow in one world, from its recording.
async function planOf(key: string, writes: string | undefined): Promise<Plan> {
  const recorded = runs[key];
  if (recorded === undefined) {
    throw new Error(`no recording of ${key}`);
  }
  expect(recorded.mine.length, `${key}: as many statements as main's`).toBe(recorded.main.length);
  const baselines: Record<string, Baseline> = {};
  const allowed: Record<string, Count> = {};
  const expected: string[] = [];
  for (const [i, n] of recorded.main.entries()) {
    const main = statements[n]!;
    const mine = statements[recorded.mine[i]!]!;
    if (main === mine) {
      allowed[main] = ((allowed[main] as number | undefined) ?? 0) + 1;
      continue;
    }
    const id = await statementId(main);
    if (baselines[id] !== undefined && baselines[id].text !== mine) {
      throw new Error(`${key}: main's ${id} has two rewrites`);
    }
    baselines[id] = {
      sql: main,
      text: mine,
      ...(writes === undefined ? {} : { writes }),
      ...(main.includes("f(bound) AS") ? { result: windowResult(main, mine) } : {}),
    };
    expected.push(id);
  }
  return { witness: new PlanWitness(baselines, undefined, allowed), expected };
}

beforeAll(async () => {
  for (const world of WORLDS) {
    for (const [flow, { writes }] of Object.entries(FLOWS)) {
      const key = `${worldName(world)} ${flow}`;
      plans.set(key, await planOf(key, writes));
    }
  }
});

describe("the rewritten statements beside main's", () => {
  it("are main's audited statements, each paired with one rewrite", async () => {
    for (const { witness, expected } of plans.values()) {
      expect(expected.length).toBeGreaterThan(0);
      await witness.expectAudited();
      for (const baseline of Object.values(witness.baselines)) {
        expect(normalized(baseline.sql)).toBe(baseline.sql);
      }
    }
  });

  it.each(WORLDS.flatMap((world) => STATISTICS.map((statistics) => [worldName(world), statistics, world] as const)))(
    "%s, %s statistics",
    { timeout: 900_000 },
    async (name, statistics, world) => {
      const store = await migratedStore();
      const figures = await runInDurableObject(store, (_instance, state) => {
        const sql = state.storage.sql;
        const transact = <T>(fn: () => T): T => state.storage.transactionSync(fn);
        const context = buildWorld(sql, world);
        const lines: string[] = [];
        let populations: Record<string, number> = {};
        for (const [flow, { run }] of Object.entries(FLOWS)) {
          const { witness, expected } = plans.get(`${name} ${flow}`)!;
          try {
            transact(() => {
              const measured = witness.measure(state, {
                statistics,
                expected,
                populations: POPULATIONS,
                run: (wrapped, inner) => run(wrapped, inner, context),
              });
              populations = measured.populations;
              expectBeside(statistics, measured, { singletonRows: true });
              for (const side of measured.sides) {
                lines.push(`FIG\t${name}\t${statistics}\t${flow}\t${side.id}\t${side.main.rows}\t${side.mine.rows}`);
              }
              throw ROLLBACK;
            });
          } catch (error) {
            if (error !== ROLLBACK) {
              throw error;
            }
          }
        }
        return { lines, populations };
      });
      // The world holds what it claims: its suspend blocks, and in a "max" world the candidates at the caps.
      expect(figures.populations.suspends).toBe({ none: 0, noncovering: 100, covering: 2 }[world.blocks]);
      if (world.shape === "max") {
        expect(figures.populations.notifications).toBeGreaterThan(2_000 + 240 + 500);
        expect(figures.populations.filtered).toBeGreaterThan(500);
        expect(figures.populations.locals).toBeGreaterThan(50);
      }
      console.log(figures.lines.join("\n"));
    },
  );
});

// Every flow is recorded in every world.
it("has a recording of each flow in each world", () => {
  expect(Object.keys(runs).toSorted()).toEqual(
    WORLDS.flatMap((world) => Object.keys(FLOWS).map((flow) => `${worldName(world)} ${flow}`)).toSorted(),
  );
});
