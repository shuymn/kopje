import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { cachedImagesOf } from "../src/domain/remote-media";
import { migratedStore } from "./helpers";
import { auditStore, queryPlan, singletonStatistics } from "./plan-audit-store";
import { auditPlans, type Recorded, statements } from "./sql-depth-setup";
import { community, post } from "./status-helpers";

// The claims the plan audit (test/plan-audit.ts) rests on, in workerd's SQLite, and the audit catching a removed pin.

// localActorOf's join (src/domain/actors.ts) as it stands, and pinned as RES-7 asks.
const UNPINNED = `SELECT a.id, l.pubkey FROM accounts a JOIN local_accounts l ON l.account_id = a.id
	WHERE a.domain IS NULL AND lower(a.username) = lower(?)`;
const PINNED = `SELECT a.id, l.pubkey FROM accounts a INDEXED BY accounts_local_username
	CROSS JOIN local_accounts l INDEXED BY sqlite_autoindex_local_accounts_1 ON l.account_id = a.id
	WHERE a.domain IS NULL AND lower(a.username) = lower(?)`;

const details = (sql: SqlStorage, query: string, ...params: SqlStorageValue[]) =>
  queryPlan(sql, query, params).map((row) => row.detail);

// A community of two local accounts among 1,000 remote ones.
async function populated() {
  const h = await community(["alice", "bob"]);
  await post(h, h.users.alice, { status: "@bob hi" });
  await runInDurableObject(h.store, (_instance, state) =>
    state.storage.sql.exec(
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 999)
			INSERT INTO accounts (id, uri, username, domain)
			SELECT CAST(800000000000000000 + i AS TEXT), 'https://d' || i || '.example/u', 'u', 'd' || i || '.example' FROM n`,
    ),
  );
  return h;
}

describe("plan audit", () => {
  // C1: the planner reads no per-value samples, so a plan depends on the schema and sqlite_stat1, and on a bound value
  // only through a LIKE or GLOB pattern (bindsPattern).
  it("plans without STAT4", async () => {
    const h = await populated();
    const result = await runInDurableObject(h.store, (_instance, state) => {
      const sql = state.storage.sql;
      let limit: string;
      try {
        sql.exec("PRAGMA analysis_limit = 0");
        limit = "set";
      } catch (error) {
        limit = String(error);
      }
      sql.exec("ANALYZE");
      return {
        limit,
        stat: sql.exec<{ name: string }>("SELECT name FROM sqlite_schema WHERE name GLOB 'sqlite_stat*'").toArray(),
        // The full count, so ANALYZE was not cut short by an analysis limit.
        accounts: sql
          .exec<{ stat: string }>("SELECT stat FROM sqlite_stat1 WHERE idx = 'sqlite_autoindex_accounts_1'")
          .one().stat,
        rows: sql.exec<{ n: number }>("SELECT count(*) AS n FROM accounts").one().n,
      };
    });
    expect(result.limit).toContain("SQLITE_AUTH");
    expect(result.stat).toEqual([{ name: "sqlite_stat1" }]);
    expect(result.accounts).toBe(`${result.rows} 1`);
    expect(result.rows).toBeGreaterThan(1000);
  });

  // C2: singleton statistics, written into sqlite_stat1 and reloaded, turn an unpinned join into scans; the pinned one
  // keeps its seeks. With no statistics, or with those of the populated Store, both seek.
  it("the singleton profile turns an unpinned join into a scan", async () => {
    const h = await populated();
    const plans = await runInDurableObject(h.store, (_instance, state) => {
      const sql = state.storage.sql;
      const none = [details(sql, UNPINNED, "alice"), details(sql, PINNED, "alice")];
      sql.exec("ANALYZE");
      const analyzed = [details(sql, UNPINNED, "alice"), details(sql, PINNED, "alice")];
      singletonStatistics(sql);
      return {
        none,
        analyzed,
        singleton: [details(sql, UNPINNED, "alice"), details(sql, PINNED, "alice")],
        stat: sql.exec<{ n: number }>("SELECT count(*) AS n FROM sqlite_stat1 WHERE stat NOT IN ('1', '1 1')").one().n,
      };
    });
    const seeks = [
      "SEARCH a USING INDEX accounts_local_username (<expr>=?)",
      "SEARCH l USING INDEX sqlite_autoindex_local_accounts_1 (account_id=?)",
    ];
    for (const [unpinned, pinned] of [plans.none, plans.analyzed]) {
      expect(unpinned!.every((detail) => detail.startsWith("SEARCH"))).toBe(true);
      expect(pinned).toEqual(seeks);
    }
    expect(plans.singleton).toEqual([["SCAN a", "SCAN l"], seeks]);
    expect(plans.stat).toBe(0);
  });

  // C4: a statement plans on the audit Store as on a Store the tests ran under the same statistics; and a statement
  // the Store prepared before the statistics changed is planned again, as it runs.
  it("plans as the Store it audits", async () => {
    const h = await populated();
    const audit = await auditStore();
    const recorded = [...statements].filter(([, seen]) => seen.production);
    expect(recorded.length).toBeGreaterThan(50);
    const queries = [
      ...recorded.map(([sql, seen]) => ({ sql, params: seen.params })),
      { sql: UNPINNED, params: ["alice"] },
    ];
    const tested = await runInDurableObject(h.store, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec("ANALYZE");
      const read = () => {
        const cursor = sql.exec(UNPINNED, "alice");
        expect(cursor.toArray()).toHaveLength(1);
        return cursor.rowsRead;
      };
      const warm = read();
      singletonStatistics(sql);
      return {
        warm,
        reloaded: read(),
        plans: queries.map(({ sql: query, params }) => {
          try {
            return queryPlan(sql, query, params);
          } catch (error) {
            return String(error);
          }
        }),
      };
    });
    const audited = (await audit.plan(queries)).map((p) => p.error ?? p.plan);
    expect(audited).toEqual(tested.plans);
    expect(tested.warm).toBeLessThan(10);
    expect(tested.reloaded).toBeGreaterThan(1000);
  });

  // C8: the audit alone catches a removed pin: cachedImagesOf (src/domain/remote-media.ts, witnessed under stale
  // statistics by test/remote-media-presenter.test.ts) with its slots' join unpinned. A removed pin that leaves a prefix
  // walk is not one it sees (test/plan-audit-1468.ts, tagStatus).
  it("fails a statement whose pin is removed", async () => {
    const store = await migratedStore();
    await runInDurableObject(store, (_instance, state) => cachedImagesOf(new Db(state.storage.sql), ["1"]));
    const [pinned, seen] = [...statements].find(([sql]) => sql.includes("CROSS JOIN remote_media cm"))!;
    expect(seen.production).toBe(true);
    const pin = "CROSS JOIN remote_media cm INDEXED BY remote_media_owner ON";
    expect(pinned).toContain(pin);
    const audit = (sql: string) => auditPlans(new Map<string, Recorded>([[sql, seen]]));
    expect(await audit(pinned)).toEqual([]);
    for (const unpinned of [
      pinned.replace(pin, "JOIN remote_media cm ON"),
      pinned.replace(pin, "CROSS JOIN remote_media cm ON"),
    ]) {
      const failures = await audit(unpinned);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatch(/reads a whole table or index, and no entry lists it/);
      expect(failures[0]).toMatch(/ {4}remote_media: SCAN cm/);
    }
  });
});
