import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { migratedStore } from "./helpers";
import { scansOf } from "./read-helpers";

describe("scansOf", () => {
  // A materialized CTE and a table share one name in two scopes: both scans count, so the table's is never hidden
  // behind the CTE's.
  it("counts a table's scan that shares its name with a materialized subquery", async () => {
    const store = await migratedStore();
    const plan = await runInDurableObject(store, (_instance, state) =>
      state.storage.sql
        .exec<{ detail: string }>(
          "EXPLAIN QUERY PLAN WITH a AS MATERIALIZED (SELECT 1 AS id) SELECT id FROM a UNION ALL SELECT id FROM deliveries a",
        )
        .toArray()
        .map((row) => row.detail),
    );
    expect(plan).toContain("MATERIALIZE a");
    expect(scansOf(plan, ["a"])).toHaveLength(2);
  });
});
