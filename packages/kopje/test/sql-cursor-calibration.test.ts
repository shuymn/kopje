import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { migratedStore } from "./helpers";
import { flatCteAfter, recursiveCteAfter } from "./sql-cursor-pads";
import { windowVariants } from "./window-variants";

// The cursor rule on the Store's own runtime (docs/engineering.md "Queries"), its success side only: at the runtime's
// limit of 100, a flat CTE resolved after 98 numbered cursors and a recursive one after 97 prepare, and so does every
// candidate window statement in its largest variant. The refusal side is enforced on Node alone
// (test-node/sql-depth.ts: SQLite 3.54.1 refuses past these counts; workerd from 1.20261111.1 backs the rule out), so
// a workerd that carries the backout passes here.
describe("the runtime's cursor rule", () => {
  it("prepares a CTE resolved at its count", async () => {
    const store = await migratedStore();
    const outcomes = await runInDurableObject(store, (_instance, state) => {
      const outcome = (sql: string) => {
        try {
          state.storage.sql.exec(sql).toArray();
          return "prepares";
        } catch (error) {
          return String(error);
        }
      };
      return [outcome(flatCteAfter(98, "accounts")), outcome(recursiveCteAfter(97, "accounts"))];
    });
    expect(outcomes).toEqual(["prepares", "prepares"]);
  });

  it("prepares every candidate window statement in its largest variant", { timeout: 120_000 }, async () => {
    await windowVariants();
  });
});
