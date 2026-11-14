import { expect } from "vitest";

import { statementId } from "./plan-audit";
import { singletonStatistics } from "./plan-audit-store";
import { type SqlRow, watchedCursor } from "./read-helpers";

// The side-by-side witness of a statement rewritten for its plan (docs/engineering.md, "Queries"; RES-7): main's
// statement is its own literal baseline, guarded by its audited identity, and each case names the baselines its flow
// runs, every one in order. A production statement pairs with the next only when it is that baseline's rewrite (its
// pins taken out, or its rewritten text exactly); it then runs main's statement first, with the same parameters, in a
// savepoint rolled back before the rewrite runs. Each pair returns the same rows, writes as many and changes the same
// rows (a write's rows listed before and after, by its `writes` query), and the rewrite reads no more than main's under
// ANALYZE. Statistics are taken after the world is built: the plan audit's singleton statistics, or ANALYZE. Each
// population a case grows is counted by its own query, asserted to grow, and its measured gain is what a read may grow
// by.

export const STATISTICS = ["singleton", "analyzed"] as const;
export type Statistics = (typeof STATISTICS)[number];

export const normalized = (sql: string) => sql.replace(/\s+/g, " ").trim();

// main's statement, by its audited identity: its literal SQL, and how its rewrite reads, either `pins` (the rewrite's
// text, whitespace collapsed, back to main's) or `text` (the rewrite exactly, whitespace collapsed). `writes`: a query
// listing the rows the statement writes, read before and after it on both sides. `result`: where the rewrite returns
// rows of another shape that its caller turns into the same answer (mergedWindow's rows and their bound), each side's
// rows as its caller reads them, compared in their place.
export type Baseline = {
  sql: string;
  pins?: (text: string) => string;
  text?: string;
  writes?: string;
  result?: { main: (rows: SqlRow[]) => unknown; mine: (rows: SqlRow[]) => unknown };
};

type Measure = { rows: number; written: number; result: unknown; removed: string[]; added: string[] };

// One production statement: `id` the baseline it is the rewrite of; `fault` set when it did not pair (out of order,
// past the sequence, main's own statement unchanged, a statement of the family no baseline names, one the witness does
// not allow) or did not finish (`incomplete`: main's statement or the rewrite threw), with nothing compared.
export type Side = { id: string; query: string; fault?: string; mine: Measure; main: Measure };

// How many times a run executes an allowed statement: `constant`, plus `perCandidate` for each of the run's candidates
// (the recipients a fan-out notifies, the notifications a window reads). A number is a constant count. Only a statement
// main's flow already runs per candidate has a coefficient, and a rewrite adds none: a count is main's.
export type Count = number | { readonly perCandidate: number; readonly constant: number };

// `counts`: each counted allowed statement's executions, by its normalized text, and `due` what its Count gives for the
// run's candidates.
export type Run = {
  expected: readonly string[];
  sides: Side[];
  populations: Record<string, number>;
  result: unknown;
  counts?: { executed: Record<string, number>; due: Record<string, number> };
};

const ROLLBACK = new Error("rolled back");
const empty = (): Measure => ({ rows: 0, written: 0, result: [], removed: [], added: [] });

// `family`, when given: the statements the rewritten code writes, each of which must be some baseline's rewrite (one
// that is no baseline's is recorded as a fault, so the case fails). `allowed`, when given: every other statement the
// run may make, each literally (whitespace collapsed); any statement that is neither a baseline's nor allowed is
// recorded as a fault, so no read the witness does not measure can grow unseen. Given as a record, each allowed
// statement has its Count, and the witness counts its executions: expectBeside holds each to its Count, and the flow
// to as many statements as main's, and expectGrowth holds each count's growth to its coefficient.
export class PlanWitness {
  readonly #allowed: ReadonlySet<string> | undefined;
  readonly counted: ReadonlyMap<string, Count> | undefined;

  constructor(
    readonly baselines: Readonly<Record<string, Baseline>>,
    readonly family?: RegExp,
    allowed?: readonly string[] | Readonly<Record<string, Count>>,
  ) {
    if (allowed === undefined || Array.isArray(allowed)) {
      this.#allowed = allowed === undefined ? undefined : new Set(allowed.map(normalized));
    } else {
      this.counted = new Map(Object.entries(allowed).map(([sql, count]) => [normalized(sql), count]));
      this.#allowed = new Set(this.counted.keys());
    }
  }

  // Each baseline is main's audited statement, with exactly one way its rewrite reads.
  async expectAudited(): Promise<void> {
    expect(Object.keys(this.baselines).length).toBeGreaterThan(0);
    for (const [id, baseline] of Object.entries(this.baselines)) {
      expect(await statementId(baseline.sql), baseline.sql).toBe(id);
      expect((baseline.pins === undefined) !== (baseline.text === undefined), id).toBe(true);
    }
  }

  // The baseline `text` is the rewrite of, `main` when it is a baseline's own statement, or undefined.
  kindOf(text: string): { id: string; main: boolean } | undefined {
    for (const [id, baseline] of Object.entries(this.baselines)) {
      const main = normalized(baseline.sql);
      if (text === main) {
        return { id, main: true };
      }
      if (baseline.pins !== undefined ? baseline.pins(text) === main : text === baseline.text) {
        return { id, main: false };
      }
    }
    return undefined;
  }

  // A SqlStorage over `real` that pairs the production statements with `expected` (baseline ids, in order); every
  // statement that is no baseline's runs as it is.
  sideBySide(
    real: SqlStorage,
    transact: <T>(fn: () => T) => T,
    expected: readonly string[],
    sides: Side[],
    counts: Record<string, number> = {},
  ): SqlStorage {
    return {
      exec: (query: string, ...params: SqlStorageValue[]) => {
        const text = normalized(query);
        if (this.counted?.has(text) === true) {
          counts[text] = (counts[text] ?? 0) + 1;
        }
        const kind = this.kindOf(text);
        if (kind === undefined) {
          if (this.family?.test(text) === true) {
            sides.push({ id: text, query, fault: "no baseline's", mine: empty(), main: empty() });
          } else if (this.#allowed !== undefined && !this.#allowed.has(text)) {
            sides.push({ id: text, query, fault: "not allowed", mine: empty(), main: empty() });
          }
          return real.exec(query, ...params);
        }
        const side: Side = { id: kind.id, query, mine: empty(), main: empty() };
        const next = expected[sides.length];
        sides.push(side);
        if (kind.main || next !== kind.id) {
          side.fault = kind.main ? "main's own" : next === undefined ? "past the sequence" : `not ${next}`;
          return real.exec(query, ...params);
        }
        // Incomplete until both sides are measured: a throw on either (caught by the flow) leaves the pair faulty.
        side.fault = "incomplete";
        let measured = false;
        const baseline = this.baselines[kind.id]!;
        const rows = () =>
          baseline.writes === undefined
            ? []
            : real
                .exec<SqlRow>(baseline.writes)
                .toArray()
                .map((row) => JSON.stringify(row));
        const before = rows();
        const changes = (into: Measure) => {
          const after = rows();
          into.removed = before.filter((row) => !after.includes(row));
          into.added = after.filter((row) => !before.includes(row));
        };
        try {
          transact(() => {
            const cursor = real.exec<SqlRow>(baseline.sql, ...params);
            const rows = cursor.toArray();
            side.main.result = baseline.result === undefined ? rows : baseline.result.main(rows);
            side.main.rows = cursor.rowsRead;
            side.main.written = cursor.rowsWritten;
            changes(side.main);
            measured = true;
            throw ROLLBACK;
          });
        } catch (error) {
          if (error !== ROLLBACK) {
            throw error;
          }
        }
        const cursor = real.exec<SqlRow>(query, ...params);
        return watchedCursor(
          cursor,
          () => {
            side.mine.rows += cursor.rowsRead;
            side.mine.written = cursor.rowsWritten;
            changes(side.mine);
            if (measured) {
              delete side.fault;
            }
          },
          (result) => (side.mine.result = baseline.result === undefined ? result : baseline.result.mine(result)),
        );
      },
    } as unknown as SqlStorage;
  }

  // Counts `populations` on the world as built, takes the statistics, and runs `run` over sideBySide in one
  // transaction (as an operation runs). `candidates`: the run's, for the counted statements' coefficients.
  measure(
    state: DurableObjectState,
    spec: {
      statistics: Statistics;
      expected: readonly string[];
      populations: Readonly<Record<string, string>>;
      candidates?: number;
      run: (sql: SqlStorage, transact: <T>(fn: () => T) => T) => unknown;
    },
  ): Run {
    const sql = state.storage.sql;
    const transact = <T>(fn: () => T): T => state.storage.transactionSync(fn);
    const populations = Object.fromEntries(
      Object.entries(spec.populations).map(([name, count]) => [name, sql.exec<{ n: number }>(count).one().n]),
    );
    if (spec.statistics === "singleton") {
      singletonStatistics(sql);
    } else {
      sql.exec("ANALYZE");
    }
    const sides: Side[] = [];
    const counts: Record<string, number> = {};
    const result = transact(() => spec.run(this.sideBySide(sql, transact, spec.expected, sides, counts), transact));
    if (this.counted === undefined) {
      return { expected: spec.expected, sides, populations, result };
    }
    const candidates = spec.candidates ?? 0;
    const due = Object.fromEntries(
      [...this.counted].map(([text, count]) => [
        text,
        typeof count === "number" ? count : count.constant + count.perCandidate * candidates,
      ]),
    );
    const executed = Object.fromEntries([...this.counted.keys()].map((text) => [text, counts[text] ?? 0]));
    return { expected: spec.expected, sides, populations, result, counts: { executed, due } };
  }
}

const total = (counts: Record<string, number>) => Object.values(counts).reduce((sum, n) => sum + n, 0);

// The run paired every statement with its expected baseline, the whole sequence in order; each pair returned the same
// rows, wrote as many and changed the same rows; under ANALYZE the rewrite read no more than main, and with
// `singletonRows` under singleton statistics too.
export function expectBeside(statistics: Statistics, run: Run, options: { singletonRows?: true } = {}): void {
  expect(
    run.sides.map((side) => (side.fault === undefined ? side.id : `${side.id} (${side.fault})`)),
    "main's statements, every one in order",
  ).toEqual(run.expected);
  if (run.counts !== undefined) {
    expect(run.counts.executed, "each counted statement's executions").toEqual(run.counts.due);
    expect(run.sides.length + total(run.counts.executed), "the flow's statements, as main's").toBe(
      run.expected.length + total(run.counts.due),
    );
  }
  for (const side of run.sides) {
    expect(side.mine.result, side.query).toEqual(side.main.result);
    expect(side.mine.written, side.query).toBe(side.main.written);
    expect(side.mine.removed, side.query).toEqual(side.main.removed);
    expect(side.mine.added, side.query).toEqual(side.main.added);
    if (statistics === "analyzed" || options.singletonRows === true) {
      expect(side.mine.rows, side.query).toBeLessThanOrEqual(side.main.rows);
    }
  }
}

// A population's gain from `base` to `grown`.
export function gain(base: Run, grown: Run, population: string): number {
  return grown.populations[population]! - base.populations[population]!;
}

// Growth from `base` to `grown`: each of `populations` grew. `perSide` (same sequence): each statement reads no fewer
// rows, and more by at most perRun rows per row its population gained (`*` for any statement; none: no more).
// `total`: the flow's rows read grew by at least `atLeast` (`gain`: one per row `populations` gained together), and at
// most `walks` per row they gained together.
export function expectGrowth(
  base: Run,
  grown: Run,
  spec: {
    populations: readonly string[];
    perSide?: Readonly<Record<string, { population: string; perRun: number }>>;
    total?: { atLeast: number | "gain"; walks?: number };
  },
): void {
  // A counted statement's executions grow only as main's do: by its own per-candidate coefficient.
  if (base.counts !== undefined || grown.counts !== undefined) {
    const growth = (run: Run, key: "executed" | "due") =>
      Object.fromEntries(
        Object.entries(grown.counts?.[key] ?? {}).map(([text, n]) => [text, n - (run.counts?.[key][text] ?? 0)]),
      );
    expect(growth(base, "executed"), "each counted statement's executions grow as main's").toEqual(growth(base, "due"));
  }
  for (const population of spec.populations) {
    expect(gain(base, grown, population), `${population} grows`).toBeGreaterThan(0);
  }
  if (spec.perSide !== undefined) {
    expect(grown.sides.map((side) => side.id)).toEqual(base.sides.map((side) => side.id));
    for (const [i, side] of grown.sides.entries()) {
      const walk = spec.perSide[side.id] ?? spec.perSide["*"];
      const allowed = walk === undefined ? 0 : walk.perRun * gain(base, grown, walk.population);
      const rows = side.mine.rows - base.sides[i]!.mine.rows;
      expect(rows, `${side.id} reads no fewer`).toBeGreaterThanOrEqual(0);
      expect(rows, `${side.id} reads at most its walk`).toBeLessThanOrEqual(allowed);
    }
  }
  if (spec.total !== undefined) {
    const read = (run: Run) => run.sides.reduce((sum, side) => sum + side.mine.rows, 0);
    const rows = read(grown) - read(base);
    const gained = spec.populations.reduce((sum, population) => sum + gain(base, grown, population), 0);
    expect(rows, "the flow reads at least").toBeGreaterThanOrEqual(
      spec.total.atLeast === "gain" ? gained : spec.total.atLeast,
    );
    if (spec.total.walks !== undefined) {
      expect(rows, "the flow reads at most its walks").toBeLessThanOrEqual(spec.total.walks * gained);
    }
  }
}
