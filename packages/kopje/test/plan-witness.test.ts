import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { migratedStore } from "./helpers";
import { statementId } from "./plan-audit";
import {
  type Baseline,
  type Count,
  expectBeside,
  expectGrowth,
  PlanWitness,
  type Run,
  type Side,
} from "./plan-witness";
import type { SqlRow } from "./read-helpers";

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
  options: {
    statistics?: "singleton" | "analyzed";
    keys?: number;
    family?: RegExp;
    allowed?: readonly string[] | Readonly<Record<string, Count>>;
    catching?: boolean;
    candidates?: number;
  } = {},
): Promise<Run> {
  const witness = new PlanWitness(entries, options.family, options.allowed);
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
      ...(options.candidates === undefined ? {} : { candidates: options.candidates }),
      run: (wrapped) =>
        statements.map(([query, ...params]) => {
          try {
            return wrapped.exec(query, ...params).toArray();
          } catch (error) {
            if (options.catching !== true) {
              throw error;
            }
            return String(error);
          }
        }),
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
    const neither = new PlanWitness({ [await statementId(SELECT)]: { sql: SELECT } });
    await expect(neither.expectAudited()).rejects.toThrow(/expected false to be true/);
  });

  it("fail when there are none", async () => {
    await expect(new PlanWitness({}).expectAudited()).rejects.toThrow(/expected 0 to be greater than 0/);
  });
});

describe("the sequence", () => {
  it("passes each rewrite paired with the next expected baseline, in order", async () => {
    const run = await witnessed(await baselines(), (ids) => [ids[0]!, ids[1]!], [
      [PINNED, 3],
      ["DELETE FROM t WHERE k = ? AND id > 0", 4],
    ]);
    expectBeside("analyzed", run);
    // main's DELETE ran first and was rolled back: the rewrite removed the same two rows again.
    expect(run.sides.map((side) => side.mine.removed.toSorted())).toEqual([[], ['{"id":"10"}', '{"id":"9"}']]);
    expect(run.sides.map((side) => side.main.removed.toSorted())).toEqual([[], ['{"id":"10"}', '{"id":"9"}']]);
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

  it("fails a variant of a baseline's rewrite after the expected ones (LIMIT 8 for LIMIT 1), with its family", async () => {
    const id = await statementId(SELECT);
    const variant = "SELECT id FROM t INDEXED BY t_k WHERE k = ? ORDER BY id LIMIT 1";
    const statements: [string, ...SqlStorageValue[]][] = [
      [PINNED, 3],
      [PINNED, 4],
      [variant, 5],
    ];
    const unguarded = await witnessed(await baselines(), () => [id, id], statements);
    // Without its family the variant runs unpaired and the witness cannot see it.
    expectBeside("analyzed", unguarded);
    const guarded = await witnessed(await baselines(), () => [id, id], statements, { family: /^SELECT id FROM t / });
    expect(guarded.sides.map((side) => side.fault)).toEqual([undefined, undefined, "no baseline's"]);
    expect(() => expectBeside("analyzed", guarded)).toThrow(/main's statements, every one in order/);
  });

  it("fails a pair whose baseline threw, the flow catching it", async () => {
    const id = await statementId(SELECT);
    const entries = { [id]: { sql: "SELECT id FROM missing WHERE k = ? ORDER BY id", text: PINNED } };
    const run = await witnessed(entries, () => [id], [[PINNED, 3]], { catching: true });
    expect(run.result).toEqual([expect.stringContaining("no such table: missing")]);
    expect(run.sides.map((side) => side.fault)).toEqual(["incomplete"]);
    expect(() => expectBeside("analyzed", run)).toThrow(/main's statements, every one in order/);
  });

  it("fails a statement of the family that is no baseline's rewrite", async () => {
    const run = await witnessed(await baselines(), () => [], [["SELECT id FROM t WHERE k > ? ORDER BY id", 3]], {
      family: /^SELECT id FROM t /,
    });
    expect(run.sides.map((side) => side.fault)).toEqual(["no baseline's"]);
    expect(() => expectBeside("analyzed", run)).toThrow(/main's statements, every one in order/);
  });

  it("fails a statement outside the family that the witness does not allow, and passes an allowed one", async () => {
    const id = await statementId(SELECT);
    const count = "SELECT count(*) AS n FROM t WHERE k = ?";
    const statements: [string, ...SqlStorageValue[]][] = [
      [PINNED, 3],
      [count, 3],
    ];
    // Without `allowed` the stray read runs unmeasured and the witness cannot see it.
    expectBeside("analyzed", await witnessed(await baselines(), () => [id], statements));
    const allowed = await witnessed(await baselines(), () => [id], statements, { allowed: [`  ${count}\n`] });
    expectBeside("analyzed", allowed);
    const strict = await witnessed(await baselines(), () => [id], statements, { allowed: [] });
    expect(strict.sides.map((side) => side.fault)).toEqual([undefined, "not allowed"]);
    expect(() => expectBeside("analyzed", strict)).toThrow(/main's statements, every one in order/);
  });
});

describe("the counts", () => {
  const count = "SELECT count(*) AS n FROM t WHERE k = ?";
  // The pinned read, then the count once per candidate key (a flow that reads per candidate).
  const perCandidate = (keys: number): [string, ...SqlStorageValue[]][] => [
    [PINNED, 3],
    ...Array.from({ length: keys }, (_, k): [string, ...SqlStorageValue[]] => [count, k]),
  ];

  it("pass each counted statement run as often as its count, constant or per candidate", async () => {
    const id = await statementId(SELECT);
    const once = await witnessed(await baselines(), () => [id], perCandidate(1), { allowed: { [count]: 1 } });
    expectBeside("analyzed", once);
    expect(once.counts?.executed).toEqual({ [count]: 1 });
    const per = { [count]: { perCandidate: 1, constant: 0 } };
    const few = await witnessed(await baselines(), () => [id], perCandidate(2), { allowed: per, candidates: 2 });
    const many = await witnessed(await baselines(), () => [id], perCandidate(5), { allowed: per, candidates: 5 });
    expectBeside("analyzed", few);
    expectBeside("analyzed", many);
    expectGrowth(few, many, { populations: [] });
  });

  it("fail an allowed read moved into a per-candidate loop", async () => {
    const id = await statementId(SELECT);
    const allowed = { [count]: 1 };
    const few = await witnessed(await baselines(), () => [id], perCandidate(1), { allowed, candidates: 1 });
    const many = await witnessed(await baselines(), () => [id], perCandidate(4), { allowed, candidates: 4 });
    expectBeside("analyzed", few);
    expect(() => expectBeside("analyzed", many)).toThrow(/each counted statement's executions/);
    expect(() => expectGrowth(few, many, { populations: [] })).toThrow(/executions grow as main's/);
  });

  it("fail a counted statement the flow no longer runs, and one it runs twice", async () => {
    const id = await statementId(SELECT);
    const none = await witnessed(await baselines(), () => [id], perCandidate(0), { allowed: { [count]: 1 } });
    expect(() => expectBeside("analyzed", none)).toThrow(/each counted statement's executions/);
    const twice = await witnessed(await baselines(), () => [id], perCandidate(2), { allowed: { [count]: 1 } });
    expect(() => expectBeside("analyzed", twice)).toThrow(/each counted statement's executions/);
  });
});

describe("each pair", () => {
  it("fails a rewrite that returns other rows (a LIMIT changed)", async () => {
    const id = await statementId(SELECT);
    const entries = { [id]: { sql: SELECT, text: "SELECT id FROM t WHERE k = ? ORDER BY id LIMIT 1" } };
    const run = await witnessed(entries, () => [id], [["SELECT id FROM t WHERE k = ? ORDER BY id LIMIT 1", 3]]);
    expect(() => expectBeside("analyzed", run)).toThrow(/LIMIT 1: expected/);
  });

  it("fails an UPDATE that writes another number of rows", async () => {
    const id = await statementId("UPDATE t SET k = k WHERE k = ?");
    const fewer = "UPDATE t SET k = k WHERE k = ? AND id % 2 = 0";
    const entries = { [id]: { sql: "UPDATE t SET k = k WHERE k = ?", text: fewer } };
    const run = await witnessed(entries, () => [id], [[fewer, 3]]);
    // Each row updated, and its index entry.
    expect([run.sides[0]!.main.written, run.sides[0]!.mine.written]).toEqual([4, 2]);
    expect(() => expectBeside("analyzed", run)).toThrow(/AND id % 2 = 0: expected 2 to be 4/);
  });

  it("fails an INSERT that adds as many rows, but others (its write set by id)", async () => {
    const insert = "INSERT INTO t (id, k) VALUES (?1 + 1000, 0)";
    const other = "INSERT INTO t (id, k) VALUES (?1 + 2000, 0)";
    const id = await statementId(insert);
    const entries = { [id]: { sql: insert, text: other, writes: "SELECT CAST(id AS TEXT) AS id FROM t ORDER BY id" } };
    const run = await witnessed(entries, () => [id], [[other, 1]]);
    expect([run.sides[0]!.main.added, run.sides[0]!.mine.added]).toEqual([['{"id":"1001"}'], ['{"id":"2001"}']]);
    expect(run.sides[0]!.mine.written).toBe(run.sides[0]!.main.written);
    expect(() => expectBeside("analyzed", run)).toThrow(/\+ 2000, 0\): expected/);
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
    expect(() => expectBeside("singleton", singleton, { singletonRows: true })).toThrow(
      /expected \d+ to be less than or equal to/,
    );
  });

  it("compares each side as its caller reads it, and fails a rewrite whose caller answers other candidates", async () => {
    const id = await statementId(SELECT);
    // The rewrite returns each row's key too, which its caller drops.
    const wider = "SELECT id, k FROM t WHERE k = ? ORDER BY id";
    const ids = (rows: SqlRow[]) => rows.map((row) => row.id);
    const entries = (mine: (rows: SqlRow[]) => unknown) => ({
      [id]: { sql: SELECT, text: wider, result: { main: ids, mine } },
    });
    const kept = await witnessed(entries(ids), () => [id], [[wider, 3]]);
    expect(kept.sides[0]!.mine.result).toEqual([7, 8]);
    expectBeside("analyzed", kept);
    const others = await witnessed(
      entries((rows) => ids(rows).toReversed()),
      () => [id],
      [[wider, 3]],
    );
    expect(() => expectBeside("analyzed", others)).toThrow(/k FROM t WHERE k = \? ORDER BY id: expected/);
    const raw = await witnessed({ [id]: { sql: SELECT, text: wider } }, () => [id], [[wider, 3]]);
    expect(() => expectBeside("analyzed", raw)).toThrow(/k FROM t WHERE k = \? ORDER BY id: expected/);
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

  it("fails sides that do not match statement for statement", () => {
    const base = run({ p: 10 }, [5, 5]);
    const grown = { ...run({ p: 20 }, [5, 5]), sides: [side("s0", 5), side("other", 5)] };
    expect(() => expectGrowth(base, grown, { populations: ["p"], perSide: {} })).toThrow(
      /expected \[ 's0', 'other' \]/,
    );
  });

  it("fails a flow whose reads grow by less than a stated least", () => {
    expect(() =>
      expectGrowth(run({ p: 10 }, [5]), run({ p: 20 }, [7]), { populations: ["p"], total: { atLeast: 5 } }),
    ).toThrow(/reads at least/);
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
