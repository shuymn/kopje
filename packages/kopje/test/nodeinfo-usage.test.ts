import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { getNodeInfoUsage, nodeInfoUsageOf } from "../src/domain/actors";
import type { StoreStub } from "../src/platform/store-client";
import { sql } from "./api-helpers";
import { migratedStore } from "./helpers";
import { localAccounts, plannedRun, scansOf, staleStatistics } from "./read-helpers";

const NOW = Date.parse("2026-06-01T00:00:00.000Z");
const LATE = Date.parse("2026-06-01T23:59:59.999Z");
const ACCOUNT = "600000000000000000";

// `count` statuses of `account`, ids from `base`, published at `at`.
const statuses = (store: StoreStub, account: string, count: number, base: bigint, at: string) =>
  sql(
    store,
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
		INSERT INTO statuses (id, uri, account_id, visibility, published_at)
		SELECT CAST(?2 + i AS TEXT), 'https://kopje.test/ap/o/h' || ?2 || '-' || i, ?3, 'public', ?4
		FROM n`,
    count,
    String(base),
    account,
    at,
  );

// Local accounts from ACCOUNT up, each with its active_on and suspended_at.
async function accountsWith(store: StoreStub, rows: { activeOn: string | null; suspendedAt?: string }[]) {
  await localAccounts({ store }, rows.length);
  for (const [i, { activeOn, suspendedAt }] of rows.entries()) {
    await sql(
      store,
      "UPDATE local_accounts SET active_on = ?1, suspended_at = ?2 WHERE account_id = ?3",
      activeOn,
      suspendedAt ?? null,
      String(BigInt(ACCOUNT) + BigInt(i)),
    );
  }
}

const usageAt = (store: StoreStub, now: number) =>
  runInDurableObject(store, (_instance, state) => nodeInfoUsageOf(new Db(state.storage.sql), now));

describe("NodeInfo usage", () => {
  // The active counts are the available local accounts whose active_on (an authenticated request's day) is in the
  // window, whether or not they posted: a reader counts, a poster with no recorded request does not.
  it("counts an account that signed in today and never posted as active", async () => {
    const reader = await migratedStore();
    await accountsWith(reader, [{ activeOn: "2026-06-01" }]);
    expect(await usageAt(reader, NOW)).toEqual({ users: 1, activeMonth: 1, activeHalfyear: 1, localPosts: 0 });
  });

  it("counts an account that posted yesterday with no recorded sign-in as not active", async () => {
    const poster = await migratedStore();
    await accountsWith(poster, [{ activeOn: null }]);
    await statuses(poster, ACCOUNT, 1, 700000000000000000n, "2026-05-31T00:00:00.000Z");
    expect(await usageAt(poster, NOW)).toEqual({ users: 1, activeMonth: 0, activeHalfyear: 0, localPosts: 1 });
  });

  // A suspended account is neither a user nor active, whatever its active_on; localPosts still counts its original
  // status, as /api/v1/instance's status count does (nodeInfoUsageOf).
  it("counts a suspended account as neither a user nor active", async () => {
    const store = await migratedStore();
    await accountsWith(store, [{ activeOn: "2026-06-01" }]);
    await statuses(store, ACCOUNT, 1, 700000000000000000n, "2026-05-30T00:00:00.000Z");
    expect(await usageAt(store, NOW)).toEqual({ users: 1, activeMonth: 1, activeHalfyear: 1, localPosts: 1 });
    await sql(
      store,
      "UPDATE local_accounts SET suspended_at = '2026-05-31T00:00:00.000Z' WHERE account_id = ?",
      ACCOUNT,
    );
    expect(await usageAt(store, NOW)).toEqual({ users: 0, activeMonth: 0, activeHalfyear: 0, localPosts: 1 });
  });

  // Mastodon's active_user_count(4) and (24): the 29 and 169 UTC days ending today, both included, whatever the time of
  // day. A later imported day is not in the window; a suspended account (suspended_at set, even empty) is not a user.
  it("counts active_on within 29 and 169 UTC days ending today", async () => {
    const store = await migratedStore();
    await accountsWith(store, [
      { activeOn: "2026-06-01" },
      { activeOn: "2026-05-04" },
      { activeOn: "2026-05-03" },
      { activeOn: "2025-12-15" },
      { activeOn: "2025-12-14" },
      { activeOn: "2026-06-02" },
      { activeOn: "2026-06-01", suspendedAt: "2026-05-31T00:00:00.000Z" },
      { activeOn: "2026-06-01", suspendedAt: "" },
    ]);
    for (const now of [NOW, LATE]) {
      expect(await usageAt(store, now), new Date(now).toISOString()).toEqual({
        users: 6,
        activeMonth: 2,
        activeHalfyear: 4,
        localPosts: 0,
      });
    }
  });

  // RES-7: the account counts are one walk of local_accounts that reads no status, however many statuses an account
  // with no active_on has gained since the statistics were taken; statuses are read only for localPosts.
  it("reads no status for the active counts, with stale statistics", async () => {
    const store = await migratedStore();
    const h = { store };
    await accountsWith(store, [{ activeOn: null }, { activeOn: "2026-06-01" }]);
    await statuses(store, ACCOUNT, 20, 700000000000000000n, "2026-05-30T00:00:00.000Z");
    const capture = async () => {
      const { result, plans } = await plannedRun(h, /./, getNodeInfoUsage, { now: NOW });
      expect(result).toMatchObject({ users: 2, activeMonth: 1, activeHalfyear: 1 });
      const accounts = plans.filter(({ query }) => /AS halfyear/.test(query));
      expect(accounts).toHaveLength(1);
      const [count] = accounts;
      expect(scansOf(count!.plan, ["l"])).toEqual(["SCAN l"]);
      expect(count!.plan.filter((detail) => detail !== "SCAN l")).toEqual([]);
      expect(count!.query).not.toMatch(/statuses/);
      expect(
        plans.filter(
          ({ query, plan }) => /statuses/.test(query) || plan.some((detail) => / s\b|statuses/.test(detail)),
        ),
      ).toEqual([expect.objectContaining({ query: expect.stringMatching(/statuses_account_originals/) })]);
      return count!.rows;
    };
    const { before, after } = await staleStatistics(h, {
      capture,
      grow: () => statuses(store, ACCOUNT, 5_000, 720000000000000000n, "2026-05-30T00:00:00.000Z"),
    });
    expect(after).toEqual(before);
  }, 60_000);
});
