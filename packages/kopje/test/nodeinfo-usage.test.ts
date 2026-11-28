import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { getNodeInfoUsage, nodeInfoUsageOf } from "../src/domain/actors";
import type { StoreStub } from "../src/platform/store-client";
import { sql } from "./api-helpers";
import { migratedStore } from "./helpers";
import { ACTIVE_EDGES, activeAccounts, plannedRun, seedStatuses, staleStatistics } from "./read-helpers";

const NOW = Date.parse("2026-06-01T00:00:00.000Z");
const LATE = Date.parse("2026-06-01T23:59:59.999Z");
const ACCOUNT = "600000000000000000";

const usageAt = (store: StoreStub, now: number) =>
  runInDurableObject(store, (_instance, state) => nodeInfoUsageOf(new Db(state.storage.sql), now));

describe("NodeInfo usage", () => {
  // The active counts are the available local accounts whose active_on (an authenticated request's day) is in the
  // window, whether or not they posted: a reader counts, a poster with no recorded request does not.
  it("counts an account that signed in today and never posted as active", async () => {
    const reader = await migratedStore();
    await activeAccounts(reader, [{ activeOn: "2026-06-01" }]);
    expect(await usageAt(reader, NOW)).toEqual({ users: 1, activeMonth: 1, activeHalfyear: 1, localPosts: 0 });
  });

  it("counts an account that posted yesterday with no recorded sign-in as not active", async () => {
    const poster = await migratedStore();
    await activeAccounts(poster, [{ activeOn: null }]);
    await seedStatuses(poster, ACCOUNT, 1, 700000000000000000n, "2026-05-31T00:00:00.000Z");
    expect(await usageAt(poster, NOW)).toEqual({ users: 1, activeMonth: 0, activeHalfyear: 0, localPosts: 1 });
  });

  // A suspended account is neither a user nor active, whatever its active_on; localPosts still counts its original
  // status, as /api/v1/instance's status count does (nodeInfoUsageOf).
  it("counts a suspended account as neither a user nor active", async () => {
    const store = await migratedStore();
    await activeAccounts(store, [{ activeOn: "2026-06-01" }]);
    await seedStatuses(store, ACCOUNT, 1, 700000000000000000n, "2026-05-30T00:00:00.000Z");
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
    await activeAccounts(store, ACTIVE_EDGES);
    for (const now of [NOW, LATE]) {
      expect(await usageAt(store, now), new Date(now).toISOString()).toEqual({
        users: 6,
        activeMonth: 2,
        activeHalfyear: 4,
        localPosts: 0,
      });
    }
    // Tomorrow's stamp alone, at the last millisecond of today: the totals above would not show a window moved a day
    // forward, which trades the first day's account for it.
    const tomorrow = await migratedStore();
    await activeAccounts(tomorrow, [{ activeOn: "2026-06-02" }]);
    expect(await usageAt(tomorrow, LATE)).toMatchObject({ users: 1, activeMonth: 0, activeHalfyear: 0 });
  });

  // RES-7: the account counts are one walk of local_accounts that reads no status, however many statuses an account
  // with no active_on has gained since the statistics were taken; statuses are read only for localPosts.
  it("reads no status for the active counts, with stale statistics", async () => {
    const store = await migratedStore();
    const h = { store };
    await activeAccounts(store, [{ activeOn: null }, { activeOn: "2026-06-01" }]);
    await seedStatuses(store, ACCOUNT, 20, 700000000000000000n, "2026-05-30T00:00:00.000Z");
    const capture = async () => {
      const { result, plans } = await plannedRun(h, /./, getNodeInfoUsage, { now: NOW });
      expect(result).toMatchObject({ users: 2, activeMonth: 1, activeHalfyear: 1 });
      const accounts = plans.filter(({ query }) => /AS halfyear/.test(query));
      expect(accounts).toHaveLength(1);
      const [count] = accounts;
      expect(count!.plan).toEqual(["SCAN l"]);
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
      grow: () => seedStatuses(store, ACCOUNT, 5_000, 720000000000000000n, "2026-05-30T00:00:00.000Z"),
    });
    expect(after).toEqual(before);
  }, 60_000);
});
