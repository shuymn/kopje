import { runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { VALUE_BYTES } from "../../src/db/sql";
import { statusRowBoundSql } from "../../src/domain/status-rows";
import { boundedWindow, type MergedRow, type Window } from "../../src/domain/windows";
import { migratedStore } from "../helpers";
import { statementId } from "../plan-audit";
import { type Baseline, type Count, expectBeside, PlanWitness, STATISTICS } from "../plan-witness";
import type { SqlRow } from "../read-helpers";
import { normalized } from "../sql-text";
import { MAIN_PARAMETERS, ROW_ALLOWANCES } from "./main-allowances";
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

// The columns added to the account read since main's base (migration 0097_profile_descriptions), which main's
// statements cannot read, with their defaults: those of them the rewrite reads and main's text does not, and the
// comparison of a pair's rows without them, so every row and every other value is still main's.
const ADDED_DEFAULTS = {
  avatar_description: "",
  header_description: "",
  show_featured: 1,
  show_media: 1,
  show_media_replies: 1,
} as const;
const ADDED_COLUMNS = Object.keys(ADDED_DEFAULTS);
const reads = (text: string, column: string) => new RegExp(`\\bAS ${column}(?![A-Za-z0-9_])`).test(text);
const addedSinceBase = (main: string, mine: string) =>
  ADDED_COLUMNS.filter((column) => reads(mine, column) && !reads(main, column));
function withoutAdded(columns: readonly string[]): NonNullable<Baseline["result"]> {
  return {
    main: (rows: SqlRow[]) => rows,
    mine: (rows: SqlRow[]) =>
      rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !columns.includes(key)))),
  };
}

// R (statusRowBoundSql) counts the author account row of each status row an item reads by
// rowHeapSql(ACCOUNT_COLUMN_MAP), and so the added columns, which main's text does not count: VALUE_BYTES and twice
// its value's UTF-8 bytes for each, ADDED_ROW_BYTES for an account that holds their defaults. R's rows as main's
// statement counts them: each item's bytes less ADDED_ROW_BYTES for each of those account rows, counted in the world
// (authorRows), with every other value, the items and their order still main's.
const ADDED_ROW_BYTES = Object.values(ADDED_DEFAULTS).reduce(
  (sum, value) => sum + VALUE_BYTES + 2 * new TextEncoder().encode(String(value)).length,
  0,
);
const R_TEXT = normalized(statusRowBoundSql());
const counts = (text: string, column: string) => text.includes(`octet_length(a.${column})`);
function rWithoutAdded(authorRows: (ids: readonly string[]) => readonly number[]): NonNullable<Baseline["result"]> {
  return {
    main: (rows: SqlRow[]) => rows,
    mine: (rows: SqlRow[], params: readonly SqlStorageValue[]) => {
      const accounts = authorRows(JSON.parse(params[0] as string) as string[]);
      return (rows as { k: number; bytes: number }[]).map((row) => {
        const n = accounts[row.k];
        if (n === undefined) {
          throw new Error(`R: no item at ${row.k}`);
        }
        return { ...row, bytes: row.bytes - n * ADDED_ROW_BYTES };
      });
    },
  };
}

// The author account rows R reads for each item of `ids` in the world `sql`: those of the status, its boosted
// original and the quoted status of the status or of its original (the status rows of statusRowBoundSql's x), each
// that is stored. Each holds the added columns' defaults and has not moved (its moved-to account's added flags would
// count too), so that ADDED_ROW_BYTES is the whole of its difference. Each read takes one row by its primary key,
// which SQLite plans without the statistics: the hook runs under the case's, and under singleton statistics a join of
// these tables scans them for each item.
const OTHER_THAN_DEFAULTS = [
  ...Object.entries(ADDED_DEFAULTS).map(
    ([column, value]) => `a.${column} IS NOT ${typeof value === "string" ? `'${value}'` : value}`,
  ),
  "a.moved_to_account_id IS NOT NULL",
].join(" OR ");
function authorRowsIn(sql: SqlStorage, ids: readonly string[]): number[] {
  const status = (id: string | null) =>
    id === null
      ? undefined
      : sql
          .exec<{ reblog: string | null; account: string }>(
            "SELECT reblog_of_id AS reblog, account_id AS account FROM statuses WHERE id = ?",
            id,
          )
          .toArray()[0];
  const quoted = (id: string) =>
    sql
      .exec<{ quoted: string | null }>("SELECT quoted_status_id AS quoted FROM quotes WHERE status_id = ?", id)
      .toArray()[0]?.quoted ?? null;
  const other = (account: string) =>
    sql
      .exec<{ other: number }>(`SELECT (${OTHER_THAN_DEFAULTS}) AS other FROM accounts a WHERE a.id = ?`, account)
      .toArray()[0]?.other;
  return ids.map((id) => {
    const item = status(id);
    if (item === undefined) {
      return 0;
    }
    const accounts = [item, status(item.reblog), status(quoted(item.reblog ?? id))]
      .map((row) => (row === undefined ? undefined : other(row.account)))
      .filter((flag) => flag !== undefined);
    if (accounts.some((flag) => flag !== 0)) {
      throw new Error(`R: an author account of ${id} holds other than the added columns' defaults, or has moved`);
    }
    return accounts.length;
  });
}

// The world the case runs in, for R's hook.
let caseWorld: SqlStorage | undefined;
const authorRows = (ids: readonly string[]) => {
  if (caseWorld === undefined) {
    throw new Error("R: no world");
  }
  return authorRowsIn(caseWorld, ids);
};

// How a pair's rows compare: a window's through each side's post-processing; R's and the account read's without what
// the added columns add. Any other statement that counts an added column fails.
function resultOf(key: string, main: string, mine: string): Baseline["result"] {
  if (main.includes("f(bound) AS")) {
    return windowResult(main, mine);
  }
  const counted = ADDED_COLUMNS.filter((column) => counts(mine, column) && !counts(main, column));
  if (counted.length > 0) {
    if (mine !== R_TEXT || counted.length !== ADDED_COLUMNS.length) {
      throw new Error(`${key}: a statement other than R counts ${counted.join(", ")} beside main's`);
    }
    return rWithoutAdded(authorRows);
  }
  const added = addedSinceBase(main, mine);
  return added.length > 0 ? withoutAdded(added) : undefined;
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
    const leading = MAIN_PARAMETERS[id]?.count;
    const result = resultOf(key, main, mine);
    baselines[id] = {
      sql: main,
      text: mine,
      ...(leading === undefined ? {} : { params: (params: readonly SqlStorageValue[]) => params.slice(0, leading) }),
      ...(writes === undefined ? {} : { writes }),
      ...(result === undefined ? {} : { result }),
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
  it("compare a pair's rows without only the columns the rewrite reads and main's text does not", () => {
    const main = "SELECT a.id AS id, a.show_media AS show_media FROM accounts a";
    const mine =
      "SELECT a.id AS id, a.show_media AS show_media, a.show_media_replies AS show_media_replies FROM accounts a";
    expect(addedSinceBase(main, mine)).toEqual(["show_media_replies"]);
    expect(addedSinceBase(mine, mine)).toEqual([]);
    const { mine: shown } = withoutAdded(["show_media_replies"]);
    expect(shown([{ id: "1", show_media: 0, show_media_replies: 1 }], [])).toEqual([{ id: "1", show_media: 0 }]);
  });

  it("compare R's items with exactly ADDED_ROW_BYTES more for each author account row of each", () => {
    const { main: of, mine: shown } = rWithoutAdded(() => [2, 1]);
    const params = [JSON.stringify(["1", "2"]), null, 0];
    const main = [
      { k: 0, bytes: 7_442 },
      { k: 1, bytes: 3_696 },
    ];
    const plus = (perRow: number, rows: readonly number[]) =>
      main.map(({ k, bytes }) => ({ k, bytes: bytes + perRow * rows[k]! }));
    expect(shown(plus(ADDED_ROW_BYTES, [2, 1]), params)).toEqual(of(main, params));
    expect(shown(plus(ADDED_ROW_BYTES - 1, [2, 1]), params)).not.toEqual(of(main, params));
    expect(shown(plus(ADDED_ROW_BYTES, [3, 1]), params)).not.toEqual(of(main, params));
    expect(shown(plus(ADDED_ROW_BYTES, [2, 1]).toReversed(), params)).not.toEqual(of(main, params));
    expect(() => shown([{ k: 2, bytes: 0 }], params)).toThrow("no item at 2");
  });

  it("count R's author account rows in the world, each holding the added columns' defaults", async () => {
    const store = await migratedStore();
    await runInDurableObject(store, (_instance, state) => {
      const sql = state.storage.sql;
      buildWorld(sql, WORLDS[0]!);
      const { id, account } = sql
        .exec<{ id: string; account: string }>(
          `SELECT id, account_id AS account FROM statuses
						WHERE reblog_of_id IS NULL AND id NOT IN (SELECT status_id FROM quotes) ORDER BY id LIMIT 1`,
        )
        .one();
      expect(authorRowsIn(sql, [id, "0"])).toEqual([1, 0]);
      sql.exec("UPDATE accounts SET avatar_description = 'A cat' WHERE id = ?", account);
      expect(() => authorRowsIn(sql, [id])).toThrow("holds other than the added columns' defaults");
    });
  });

  it("are main's audited statements, each paired with one rewrite", async () => {
    // Each allowance is a baseline's, so none outlives the statement it was given for.
    const baselineIds = new Set([...plans.values()].flatMap(({ expected }) => expected));
    const allowed = [...Object.keys(ROW_ALLOWANCES), ...Object.keys(MAIN_PARAMETERS)];
    expect(
      allowed.filter((id) => !baselineIds.has(id)),
      [...baselineIds].join(" "),
    ).toEqual([]);
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
        caseWorld = sql;
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
              expectBeside(statistics, measured, { singletonRows: true, rowAllowances: ROW_ALLOWANCES });
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
