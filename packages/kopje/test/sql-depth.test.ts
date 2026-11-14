import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { localActorOf } from "../src/domain/actors";
import { stagedList } from "../src/domain/audience";
import { migratedStore } from "./helpers";
import { flatCteAfter } from "./sql-cursor-pads";
import { measure, statements } from "./sql-depth-setup";
import { community, post } from "./status-helpers";
import { WINDOW_FAMILIES, windowVariants } from "./window-variants";

// The guard of test/sql-depth-setup.ts: it sees the statements the Store runs, and it reports one nested too deep or
// resolving a CTE after too many cursors (test-node/sql-depth.ts, CTE_GUARD_LIMIT).
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
    expect(own.samples).toEqual([]);
    expect(own.sites).toEqual([expect.stringMatching(/^test\/sql-depth\.test\.ts:\d+ /)]);
    const [, staged] = [...statements].find(
      ([sql]) => sql.includes("FROM json_each(") && sql.includes("LIMIT ?4 OFFSET ?3"),
    )!;
    expect(staged.production).toBe(true);
    expect(staged.sites[0]).toMatch(/^src\/domain\/audience\.ts:\d+ stagedList/);
  });

  it("keeps the first distinct samples of the domain code's parameters", async () => {
    const store = await migratedStore();
    const owner = (sql: string) => sql.includes("lower(a.username) = lower(?)") && sql.includes("l.also_known_as");
    const ran = await runInDurableObject(store, (_instance, state) => {
      const db = new Db(state.storage.sql);
      localActorOf(db, "a");
      // A test running the domain code's text, before the slots fill, takes none of them.
      const query = [...statements.keys()].find(owner)!;
      db.all(query, "test-only");
      for (const username of ["a", "b", "c", "d", "e"]) {
        localActorOf(db, username);
      }
      return query;
    });
    const seen = statements.get(ran)!;
    expect(seen.production).toBe(true);
    expect(seen.samples).toHaveLength(3);
    expect(seen.samples).not.toContainEqual(["test-only"]);
  });

  it("reports a statement nested past the guard's limit, with the lowest limit it prepares at", async () => {
    expect(await measure([nested(10), nested(96), nested(97), nested(101)])).toEqual([
      { limit: 97, sql: nested(97) },
      { limit: 101, sql: nested(101) },
    ]);
  });

  it("reports a statement resolving a CTE after more cursors than the guard's limit allows", async () => {
    expect(await measure([flatCteAfter(94, "accounts"), flatCteAfter(95, "accounts")])).toEqual([
      { limit: 97, sql: flatCteAfter(95, "accounts") },
    ]);
  });

  // Every candidate window statement, in its largest variant, prepares on the Store's runtime (each page windowVariants
  // reads answers 200) and at the guard's limit on Node.
  it("passes each candidate window statement in its largest variant", { timeout: 120_000 }, async () => {
    await windowVariants();
    for (const [family, member] of Object.entries(WINDOW_FAMILIES)) {
      const recorded = [...statements.keys()].filter(member);
      expect(recorded.length, family).toBeGreaterThanOrEqual(2);
      expect(await measure(recorded), family).toEqual([]);
    }
  });

  it("refuses a batch, whose later statements it would not measure", async () => {
    await expect(measure([`SELECT 1; ${nested(101)}`])).rejects.toThrow("a batch of statements");
  });
});
