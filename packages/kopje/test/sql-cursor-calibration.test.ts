import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { migratedStore } from "./helpers";
import { CURSOR_REFUSAL, flatCteAfter, recursiveCteAfter } from "./sql-cursor-pads";

// The Store's own cursor rule (docs/engineering.md "Queries"), at the runtime's limit of 100: a flat CTE resolves after
// at most 98 numbered cursors and a recursive one after at most 97. The guard (test-node/sql-depth.ts) prepares every
// statement at CTE_GUARD_LIMIT on Node and calibrates itself the same way; should the runtime stop refusing past these
// counts, or refuse earlier, this fails.
describe("the runtime's cursor rule", () => {
  it("refuses a CTE resolved past its count, and prepares one at it", async () => {
    const store = await migratedStore();
    const outcomes = await runInDurableObject(store, (_instance, state) => {
      const outcome = (sql: string) => {
        try {
          state.storage.sql.exec(sql).toArray();
          return "prepares";
        } catch (error) {
          return error instanceof Error && error.message.includes(CURSOR_REFUSAL) ? "refused" : String(error);
        }
      };
      return {
        flat: [outcome(flatCteAfter(98, "accounts")), outcome(flatCteAfter(99, "accounts"))],
        recursive: [outcome(recursiveCteAfter(97, "accounts")), outcome(recursiveCteAfter(98, "accounts"))],
      };
    });
    expect(outcomes).toEqual({ flat: ["prepares", "refused"], recursive: ["prepares", "refused"] });
  });
});
