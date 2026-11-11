import { runInDurableObject } from "cloudflare:test";

import { migratedStore } from "./helpers";
import type { PlanRow, PlanSchema } from "./plan-audit";

// The Store the plan audit plans on (test/plan-audit.ts): migrated as every test's Store, with singleton statistics.

// Replaces the statistics of the Store of `sql` by singleton statistics, each table and each index (automatic and
// partial ones included) estimated at one row, one row per key, built from the live schema so a new migration's index
// is covered; then reloads them (ANALYZE sqlite_schema), as the planner of a Store analyzed while small would hold.
// Prepared statements re-plan on the reload (test/plan-audit.test.ts).
export function singletonStatistics(sql: SqlStorage): void {
  // ANALYZE creates sqlite_stat1 if missing; its figures for the rows already present are replaced below.
  sql.exec("ANALYZE");
  sql.exec("DELETE FROM sqlite_stat1");
  const objects = sql
    .exec<{ type: string; name: string; tbl_name: string }>(
      `SELECT type, name, tbl_name FROM sqlite_schema WHERE type IN ('table', 'index')
			AND substr(tbl_name, 1, 4) <> '_cf_' AND substr(tbl_name, 1, 7) <> 'sqlite_'`,
    )
    .toArray();
  for (const { type, name, tbl_name: table } of objects) {
    if (type === "table") {
      sql.exec("INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES (?, NULL, '1')", table);
    } else {
      sql.exec("INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES (?, ?, '1 1')", table, name);
    }
  }
  sql.exec("ANALYZE sqlite_schema");
}

// The schema of the Store of `sql`, as the classifier reads it.
export function planSchema(sql: SqlStorage): PlanSchema {
  const objects = sql
    .exec<{ type: string; name: string; tbl_name: string }>(
      "SELECT type, name, tbl_name FROM sqlite_schema WHERE type IN ('table', 'index')",
    )
    .toArray();
  return {
    tables: new Set(objects.filter((o) => o.type === "table").map((o) => o.name.toLowerCase())),
    indexes: new Map(objects.filter((o) => o.type === "index").map((o) => [o.name, o.tbl_name.toLowerCase()])),
  };
}

// The plan of `query` with `params` on the Store of `sql`.
export function queryPlan(sql: SqlStorage, query: string, params: readonly SqlStorageValue[]): PlanRow[] {
  return sql
    .exec<PlanRow>(`EXPLAIN QUERY PLAN ${query}`, ...params)
    .toArray()
    .map(({ id, parent, detail }) => ({ id, parent, detail }));
}

export type PlannedOrRefused = { plan: PlanRow[]; error?: string };

// A new audit Store and its schema, and `plan`, which plans statements on it in one call.
export async function auditStore(): Promise<{
  schema: PlanSchema;
  plan: (statements: readonly { sql: string; params: readonly SqlStorageValue[] }[]) => Promise<PlannedOrRefused[]>;
}> {
  const store = await migratedStore();
  const schema = await runInDurableObject(store, (_instance, state) => {
    singletonStatistics(state.storage.sql);
    return planSchema(state.storage.sql);
  });
  return {
    schema,
    plan: (statements) =>
      runInDurableObject(store, (_instance, state) =>
        statements.map(({ sql, params }) => {
          try {
            return { plan: queryPlan(state.storage.sql, sql, params) };
          } catch (error) {
            return { plan: [], error: String(error) };
          }
        }),
      ),
  };
}
