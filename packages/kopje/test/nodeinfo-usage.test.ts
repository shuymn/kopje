import { describe, expect, it } from "vitest";

import { getNodeInfoUsage } from "../src/domain/actors";
import type { StoreStub } from "../src/platform/store-client";
import { sql } from "./api-helpers";
import { migratedStore } from "./helpers";
import { localAccounts, plannedRun, staleStatistics } from "./read-helpers";

const NOW = Date.parse("2026-06-01T00:00:00.000Z");
const ACTIVE = "600000000000000000";
const IDLE = "600000000000000001";

// `count` statuses of `account` published long before any window, with ids from `base` (below the active account's
// recent status, so they are its older history).
const history = (store: StoreStub, account: string, count: number, base: bigint) =>
  sql(
    store,
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
		INSERT INTO statuses (id, uri, account_id, visibility, published_at)
		SELECT CAST(?2 + i AS TEXT), 'https://kopje.test/ap/o/h' || ?2 || '-' || i, ?3, 'public', '2020-01-01T00:00:00.000Z'
		FROM n`,
    count,
    String(base),
    account,
  );

describe("NodeInfo usage", () => {
  // RES-7: an active account's probe reads its newest status in the window and stops, however long its older history
  // grows after the statistics were taken (same key: the account's statuses_account prefix).
  it("counts an active account without reading its older history, with stale statistics", async () => {
    const store = await migratedStore();
    const h = { store };
    await localAccounts(h, 2);
    await history(store, ACTIVE, 20, 700000000000000000n);
    await history(store, IDLE, 3, 710000000000000000n);
    await sql(
      store,
      `INSERT INTO statuses (id, uri, account_id, visibility, published_at)
			VALUES ('799999999999999999', 'https://kopje.test/ap/o/recent', ?1, 'direct', '2026-05-30T00:00:00.000Z')`,
      ACTIVE,
    );
    const capture = async () => {
      const { result, plans } = await plannedRun(h, /s\.published_at >= \?/, getNodeInfoUsage, {
        now: NOW,
      });
      expect(result).toMatchObject({ users: 2, activeMonth: 1, activeHalfyear: 1 });
      expect(plans).toHaveLength(2);
      for (const { plan } of plans) {
        expect(plan.filter((detail) => /^SCAN s\b/.test(detail))).toEqual([]);
      }
      return plans.map(({ rows }) => rows);
    };
    const { before, after } = await staleStatistics(h, {
      capture,
      grow: () => history(store, ACTIVE, 5_000, 720000000000000000n),
    });
    expect(after).toEqual(before);
  }, 60_000);
});
