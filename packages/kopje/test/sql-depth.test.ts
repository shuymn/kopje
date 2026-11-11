import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { stagedList } from "../src/domain/audience";
import { migratedStore } from "./helpers";
import { measure, statements } from "./sql-depth-setup";
import { community, post } from "./status-helpers";

// The guard of test/sql-depth-setup.ts: it sees the statements the Store runs, and it reports a deep one.
describe("expression depth guard", () => {
  const nested = (depth: number) => `SELECT ${"-(".repeat(depth - 1)}1${")".repeat(depth - 1)}`;

  it("records the statements the Store runs through Db", async () => {
    const h = await community(["alice", "bob"]);
    await post(h, h.users.alice, { status: "@bob hi" });
    const [, seen] = [...statements].find(([sql]) => sql.includes("INSERT INTO notifications"))!;
    expect(seen.production).toBe(true);
    expect(seen.sites[0]).toMatch(/^src\/domain\//);
  });

  // The plan audit (test/plan-audit.ts) reads the same record: what the domain code iterates, once its cursor steps,
  // with its call chain; a test's own statement is recorded but not the domain code's.
  it("records an iterated statement as its cursor steps, and tells the domain code's from a test's", async () => {
    const store = await migratedStore();
    const result = await runInDurableObject(store, (_instance, state) => {
      const db = new Db(state.storage.sql);
      const own = "SELECT 'sql-depth iterate' AS id";
      const unstepped = db.iterate(own);
      const before = statements.has(own);
      const rows = [...db.iterate(own)];
      void unstepped;
      const staged = [...stagedList(db, "1", "$.audience.accounts", 0, 10)];
      return { before, rows, staged };
    });
    expect(result).toEqual({ before: false, rows: [{ id: "sql-depth iterate" }], staged: [] });
    const own = statements.get("SELECT 'sql-depth iterate' AS id")!;
    expect(own.production).toBe(false);
    expect(own.sites).toEqual([expect.stringMatching(/^test\/sql-depth\.test\.ts:\d+ /)]);
    const [, staged] = [...statements].find(
      ([sql]) => sql.includes("FROM json_each(") && sql.includes("LIMIT ?4 OFFSET ?3"),
    )!;
    expect(staged.production).toBe(true);
    expect(staged.sites[0]).toMatch(/^src\/domain\/audience\.ts:\d+ stagedList/);
  });

  it("keeps the first distinct samples of a statement's parameters", async () => {
    const store = await migratedStore();
    const query = "SELECT ? AS sampled";
    await runInDurableObject(store, (_instance, state) => {
      const db = new Db(state.storage.sql);
      for (const value of [1, 1, "1", 2, 3, 4]) {
        db.all(query, value);
      }
    });
    expect(statements.get(query)!.samples).toEqual([[1], ["1"], [2]]);
  });

  it("reports a statement the Store would refuse, with its depth", async () => {
    expect(await measure([nested(10), nested(101)])).toEqual([{ depth: 101, sql: nested(101) }]);
  });

  it("refuses a batch, whose later statements it would not measure", async () => {
    await expect(measure([`SELECT 1; ${nested(101)}`])).rejects.toThrow("a batch of statements");
  });
});
