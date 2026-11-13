import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { migratedStore } from "./helpers";
import { statementId } from "./plan-audit";
import { type Baseline, expectBeside, expectGrowth, PlanWitness, type Run, type Side } from "./plan-witness";

// test/plan-witness.ts against itself: each guard of the side-by-side witness, met by one minimal case that fails it,
// beside the case that passes. The world: a table t of `k` keys, two rows each, with an index on k.

const SELECT = "SELECT id FROM t WHERE k = ? ORDER BY id";
const DELETE = "DELETE FROM t WHERE k = ?";
const PINNED = "SELECT id FROM t INDEXED BY t_k WHERE k = ? ORDER BY id";

async function baselines(extra: Record<string, Baseline> = {}): Promise<Record<string, Baseline>> {
  return {
    [await statementId(SELECT)]: { sql: SELECT, pins: (text) => text.replace(" INDEXED BY t_k", "") },
    [await statementId(DELETE)]: {
      sql: DELETE,
      text: "DELETE FROM t WHERE k = ? AND id > 0",
      writes: "SELECT CAST(id AS TEXT) AS id FROM t ORDER BY id",
    },
    ...extra,
  };
}

// Runs `statements` (each with its parameters) through the witness of `entries`, expecting `expected`, under
// `statistics`, in a world of `keys` keys.
async function witnessed(
  entries: Record<string, Baseline>,
  expected: (ids: string[]) => string[],
  statements: [string, ...SqlStorageValue[]][],
  options: { statistics?: "singleton" | "analyzed"; keys?: number; family?: RegExp } = {},
): Promise<Run> {
  const witness = new PlanWitness(entries, options.family);
  const ids = Object.keys(entries);
  const store = await migratedStore();
  return runInDurableObject(store, (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, k INTEGER NOT NULL)");
    sql.exec("CREATE INDEX t_k ON t (k)");
    sql.exec(
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 * 2 - 1)
			INSERT INTO t (id, k) SELECT i + 1, i / 2 FROM n`,
      options.keys ?? 50,
    );
    return witness.measure(state, {
      statistics: options.statistics ?? "analyzed",
      expected: expected(ids),
      populations: { t: "SELECT count(*) AS n FROM t" },
      run: (wrapped) => statements.map(([query, ...params]) => wrapped.exec(query, ...params).toArray()),
    });
  });
}

describe("the baselines", () => {
  it("pass as main's audited statements", async () => {
    await new PlanWitness(await baselines()).expectAudited();
  });

  it("fail a baseline that is not its identity's statement", async () => {
    const wrong = new PlanWitness({ [await statementId(SELECT)]: { sql: DELETE, text: DELETE } });
    await expect(wrong.expectAudited()).rejects.toThrow(/expected '[0-9a-f]{16}' to be/);
  });

  it("fail a baseline with both or neither rewrite form", async () => {
    const both = new PlanWitness({ [await statementId(SELECT)]: { sql: SELECT, text: PINNED, pins: (text) => text } });
    await expect(both.expectAudited()).rejects.toThrow(/expected false to be true/);
  });
});

describe("the sequence", () => {
  it("passes each rewrite paired with the next expected baseline, in order", async () => {
    const run = await witnessed(await baselines(), (ids) => [ids[0]!, ids[1]!], [
      [PINNED, 3],
      ["DELETE FROM t WHERE k = ? AND id > 0", 4],
    ]);
    expectBeside("analyzed", run);
    expect(run.sides.map((side) => side.mine.removed.toSorted())).toEqual([[], ['{"id":"10"}', '{"id":"9"}']]);
  });

  it("fails a rewrite other than the next expected", async () => {
    const run = await witnessed(await baselines(), (ids) => [ids[1]!], [[PINNED, 3]]);
    expect(run.sides.map((side) => side.fault)).toEqual([`not ${Object.keys(await baselines())[1]}`]);
    expect(() => expectBeside("analyzed", run)).toThrow(/main's statements, every one in order/);
  });

  it("fails a rewrite past the sequence (a statement doubled)", async () => {
    const run = await witnessed(await baselines(), (ids) => [ids[0]!], [
      [PINNED, 3],
      [PINNED, 3],
    ]);
    expect(run.sides.map((side) => side.fault)).toEqual([undefined, "past the sequence"]);
    expect(() => expectBeside("analyzed", run)).toThrow(/main's statements, every one in order/);
  });

  it("fails a sequence not run whole", async () => {
    const run = await witnessed(await baselines(), (ids) => [ids[0]!, ids[1]!], [[PINNED, 3]]);
    expect(run.sides.map((side) => side.fault)).toEqual([undefined]);
    expect(() => expectBeside("analyzed", run)).toThrow(/main's statements, every one in order/);
  });

  it("fails main's own statement, its rewrite undone", async () => {
    const run = await witnessed(await baselines(), (ids) => [ids[0]!], [[SELECT, 3]]);
    expect(run.sides.map((side) => side.fault)).toEqual(["main's own"]);
    expect(() => expectBeside("analyzed", run)).toThrow(/main's statements, every one in order/);
  });

  it("fails a statement of the family that is no baseline's rewrite", async () => {
    const run = await witnessed(await baselines(), () => [], [["SELECT id FROM t WHERE k > ? ORDER BY id", 3]], {
      family: /^SELECT id FROM t /,
    });
    expect(run.sides.map((side) => side.fault)).toEqual(["no baseline's"]);
    expect(() => expectBeside("analyzed", run)).toThrow(/main's statements, every one in order/);
  });
});

describe("each pair", () => {
  it("fails a rewrite that returns other rows (a LIMIT changed)", async () => {
    const id = await statementId(SELECT);
    const entries = { [id]: { sql: SELECT, text: "SELECT id FROM t WHERE k = ? ORDER BY id LIMIT 1" } };
    const run = await witnessed(entries, () => [id], [["SELECT id FROM t WHERE k = ? ORDER BY id LIMIT 1", 3]]);
    expect(() => expectBeside("analyzed", run)).toThrow(/LIMIT 1: expected/);
  });

  it("fails a DELETE that removes as many rows, but others (its write set by id)", async () => {
    const id = await statementId(DELETE);
    const wrong = "DELETE FROM t WHERE k = ? + 1";
    const entries = { [id]: { sql: DELETE, text: wrong, writes: "SELECT CAST(id AS TEXT) AS id FROM t ORDER BY id" } };
    const run = await witnessed(entries, () => [id], [[wrong, 3]]);
    expect(run.sides[0]!.mine.written).toBe(run.sides[0]!.main.written);
    expect(() => expectBeside("analyzed", run)).toThrow(/DELETE FROM t WHERE k = \? \+ 1: expected/);
  });

  it("fails a rewrite that reads more than main under ANALYZE, and not under singleton statistics", async () => {
    const id = await statementId(SELECT);
    const scan = "SELECT id FROM t NOT INDEXED WHERE k = ? ORDER BY id";
    const entries = { [id]: { sql: SELECT, pins: (text: string) => text.replace(" NOT INDEXED", "") } };
    const analyzed = await witnessed(entries, () => [id], [[scan, 3]], { statistics: "analyzed" });
    expect(() => expectBeside("analyzed", analyzed)).toThrow(/expected \d+ to be less than or equal to/);
    const singleton = await witnessed(entries, () => [id], [[scan, 3]], { statistics: "singleton" });
    expectBeside("singleton", singleton);
  });
});

describe("the growth", () => {
  const side = (id: string, rows: number): Side => ({
    id,
    query: id,
    mine: { rows, written: 0, result: [], removed: [], added: [] },
    main: { rows, written: 0, result: [], removed: [], added: [] },
  });
  const run = (populations: Record<string, number>, rows: number[]): Run => ({
    expected: rows.map((_, i) => `s${i}`),
    sides: rows.map((r, i) => side(`s${i}`, r)),
    populations,
    result: null,
  });

  it("passes a read that grows within its walk of a population that grew", () => {
    expectGrowth(run({ p: 10 }, [5, 7]), run({ p: 20 }, [5, 17]), {
      populations: ["p"],
      perSide: { s1: { population: "p", perRun: 1 } },
      total: { atLeast: "gain", walks: 1 },
    });
  });

  it("fails a population held fixed", () => {
    expect(() => expectGrowth(run({ p: 10 }, [5]), run({ p: 10 }, [5]), { populations: ["p"] })).toThrow(/p grows/);
  });

  it("fails a read that grows with a population it may not walk", () => {
    expect(() => expectGrowth(run({ p: 10 }, [5]), run({ p: 20 }, [6]), { populations: ["p"], perSide: {} })).toThrow(
      /at most its walk/,
    );
  });

  it("fails a read past its walk, and one that shrinks", () => {
    const walks = { "*": { population: "p", perRun: 1 } };
    expect(() =>
      expectGrowth(run({ p: 10 }, [5]), run({ p: 20 }, [16]), { populations: ["p"], perSide: walks }),
    ).toThrow(/at most its walk/);
    expect(() =>
      expectGrowth(run({ p: 10 }, [5]), run({ p: 20 }, [4]), { populations: ["p"], perSide: walks }),
    ).toThrow(/no fewer/);
  });

  it("fails a flow that reads less than its gain, or more than its walks", () => {
    expect(() =>
      expectGrowth(run({ p: 10 }, [5]), run({ p: 20 }, [9]), { populations: ["p"], total: { atLeast: "gain" } }),
    ).toThrow(/reads at least/);
    expect(() =>
      expectGrowth(run({ p: 10 }, [5]), run({ p: 20 }, [30]), {
        populations: ["p"],
        total: { atLeast: 0, walks: 2 },
      }),
    ).toThrow(/at most its walks/);
  });
});
