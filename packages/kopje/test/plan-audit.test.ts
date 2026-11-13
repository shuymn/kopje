import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { SUSPEND_BLOCKS_SQL } from "../src/domain/audience";
import { cachedImagesOf } from "../src/domain/remote-media";
import { migratedStore } from "./helpers";
import { fragmentCount } from "./plan-audit";
import { PLAN_AUDIT_ALLOWANCES } from "./plan-audit-allowances";
import { auditStore, queryPlan, singletonStatistics } from "./plan-audit-store";
import { STATISTICS } from "./plan-witness";
import { auditPlans, type Recorded, statements } from "./sql-depth-setup";
import { community, post } from "./status-helpers";

// The claims the plan audit (test/plan-audit.ts) rests on, in workerd's SQLite, and the audit catching a removed pin.

// localActorOf's join (src/domain/actors.ts LOCAL_BY_USERNAME) unpinned, and pinned as RES-7 asks.
const UNPINNED = `SELECT a.id, l.pubkey FROM accounts a JOIN local_accounts l ON l.account_id = a.id
	WHERE a.domain IS NULL AND lower(a.username) = lower(?)`;
const PINNED = `SELECT a.id, l.pubkey FROM accounts a INDEXED BY accounts_local_username
	CROSS JOIN local_accounts l INDEXED BY sqlite_autoindex_local_accounts_1 ON l.account_id = a.id
	WHERE a.domain IS NULL AND lower(a.username) = lower(?)`;

// The audit's failures (auditPlans): its advice on listed scans a suite did not show never fails it.
const failuresOf = async (recorded: ReadonlyMap<string, Recorded>) => (await auditPlans(recorded)).failures;

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
      ...recorded.map(([sql, seen]) => ({ sql, params: seen.samples[0]! })),
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
    const audit = (sql: string) => failuresOf(new Map<string, Recorded>([[sql, seen]]));
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

  const recorded = (sql: string, ...samples: SqlStorageValue[][]) =>
    new Map<string, Recorded>([[sql, { samples, production: true, measured: true, sites: ["src/domain/x.ts:1 r"] }]]);

  // A bound value decides whether a partial index serves a statement (accounts_directory_active is the discoverable
  // accounts'), so each sample of its parameters is planned and their violations united.
  it("plans each sample of a statement's parameters", async () => {
    const query = `SELECT id FROM accounts WHERE discoverable = ? AND last_status_id > ? ORDER BY last_status_id LIMIT 1`;
    const store = await migratedStore();
    const plans = await runInDurableObject(store, (_instance, state) => {
      singletonStatistics(state.storage.sql);
      return [details(state.storage.sql, query, 1, "0"), details(state.storage.sql, query, 0, "0")];
    });
    expect(plans).toEqual([
      ["SEARCH accounts USING COVERING INDEX accounts_directory_active (last_status_id>?)"],
      ["SCAN accounts", "USE TEMP B-TREE FOR ORDER BY"],
    ]);
    expect(await failuresOf(recorded(query, [1, "0"]))).toEqual([]);
    const failures = await failuresOf(recorded(query, [1, "0"], [0, "0"]));
    expect(failures).toEqual([expect.stringMatching(/offending lines:\n {4}accounts: SCAN accounts/)]);
  });

  // The audit plans the samples the suites gave, so a LIKE or GLOB pattern, whose bound value can change a plan, is
  // never a parameter of the domain code's SQL.
  it("refuses a LIKE or GLOB pattern the domain code binds", async () => {
    const refused = "plan audit: a LIKE or GLOB pattern takes a parameter";
    for (const query of [
      "SELECT id FROM accounts WHERE id = ? AND username LIKE ?",
      `SELECT id FROM accounts WHERE id = ? AND "like"(?, username)`,
      "SELECT id FROM accounts WHERE id = ? AND glob(?, username)",
    ]) {
      expect(await failuresOf(recorded(query, ["1", "a%"])), query).toEqual([expect.stringContaining(refused)]);
    }
    const literal = "SELECT id FROM accounts WHERE id = ? AND username LIKE 'a%' LIMIT ?";
    expect(await failuresOf(recorded(literal, ["1", 1]))).toEqual([]);
  });

  // The suspend blocks' allowance (PLAN_AUDIT_ALLOWANCES) on the planner's own plans: each occurrence of
  // SUSPEND_BLOCKS_SQL plans as one line of its scan, and a walk of the same index by other SQL stays in the plan of
  // the statement without the fragment.
  describe("the suspend blocks' allowance", () => {
    const SUSPEND_SCAN = "SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend";
    const walk = `(SELECT count(*) FROM main.instance_domain_blocks INDEXED BY instance_domain_blocks_suspend
			WHERE severity = 'suspend')`;

    it("is SUSPEND_BLOCKS_SQL itself, with the scan its plan shows", () => {
      expect(PLAN_AUDIT_ALLOWANCES.map(({ fragment, scan }) => ({ fragment, scan }))).toEqual([
        { fragment: SUSPEND_BLOCKS_SQL, scan: `instance_domain_blocks: ${SUSPEND_SCAN}` },
      ]);
    });

    it("passes a statement's scan of the fragment, once for each time it contains it", async () => {
      const once = `SELECT ${SUSPEND_BLOCKS_SQL} AS x`;
      // As guardedSql (src/domain/audience.ts) puts it in an account's columns.
      const twice = `SELECT id, CASE WHEN ${SUSPEND_BLOCKS_SQL} THEN 1 ELSE 0 END AS a,
				CASE WHEN ${SUSPEND_BLOCKS_SQL} THEN 2 ELSE 0 END AS b FROM accounts WHERE id = ?`;
      const store = await migratedStore();
      const lines = await runInDurableObject(store, (_instance, state) => {
        singletonStatistics(state.storage.sql);
        const sql = state.storage.sql;
        return [once, twice].map((query, n) => details(sql, query, ...(n === 0 ? [] : ["1"])));
      });
      expect(lines.map((plan) => plan.filter((detail) => detail === SUSPEND_SCAN).length)).toEqual([1, 2]);
      expect(await failuresOf(recorded(once, []))).toEqual([]);
      expect(await failuresOf(recorded(twice, ["1"]))).toEqual([]);
    });

    it("fails the scan more often than the fragment, or without it", async () => {
      for (const query of [
        `SELECT ${SUSPEND_BLOCKS_SQL} AS x, ${walk} AS n`,
        `SELECT ${walk} AS n`,
        // The fragment's text as a name is no occurrence of it.
        `SELECT ${walk} AS "${SUSPEND_BLOCKS_SQL}"`,
        `SELECT 1 FROM main.instance_domain_blocks INDEXED BY instance_domain_blocks_suspend WHERE severity = 'suspend'`,
      ]) {
        expect(await failuresOf(recorded(query, [])), query).toEqual([
          expect.stringMatching(new RegExp(`offending lines:\\n {4}instance_domain_blocks: ${SUSPEND_SCAN}$`, "m")),
        ]);
      }
    });

    // The fragment's line can drop out of the plan (an unused column of a flattened subquery) while another walk of
    // the same index prints exactly its detail, as often as the statement contains the fragment: the plan of the
    // statement without the fragment still shows that walk, an aggregate or a correlated one. A walk the fragment
    // guards (`CASE WHEN fragment THEN walk`) stays in that plan too, since its stand-in does not fold.
    it("fails a walk of the index that prints as the fragment's scan", async () => {
      const correlated = `(SELECT count(*) FROM main.instance_domain_blocks INDEXED BY instance_domain_blocks_suspend
				WHERE severity = 'suspend' AND id + 0 <> length(a.username))`;
      const unused = (n: string, from = "") =>
        `SELECT n FROM (SELECT ${SUSPEND_BLOCKS_SQL} AS unused, ${n} AS n${from})`;
      const guarded = `CASE WHEN ${SUSPEND_BLOCKS_SQL} THEN ${correlated} ELSE 0 END`;
      const cases: [string, SqlStorageValue[], number][] = [
        [unused(walk), [], 1],
        [unused(correlated, " FROM accounts a WHERE a.id = ?"), ["1"], 1],
        [unused(guarded, " FROM accounts a WHERE a.id = ?"), ["1"], 2],
      ];
      const store = await migratedStore();
      const plans = await runInDurableObject(store, (_instance, state) => {
        singletonStatistics(state.storage.sql);
        return cases.map(([query, params]) => details(state.storage.sql, query, ...params));
      });
      for (const [n, [query, params, occurrences]] of cases.entries()) {
        // Each prints the allowed detail exactly as often as the statement contains the fragment.
        expect(fragmentCount(query, SUSPEND_BLOCKS_SQL), query).toBe(occurrences);
        expect(plans[n]!.filter((detail) => detail === SUSPEND_SCAN).length, query).toBe(occurrences);
        expect(await failuresOf(recorded(query, params)), query).toEqual([
          expect.stringMatching(new RegExp(`offending lines:\\n {4}instance_domain_blocks: ${SUSPEND_SCAN}$`, "m")),
        ]);
      }
    });

    // RES-7: the fragment reads one entry of the partial index of the suspend blocks, once in a statement however
    // many rows test it, and however many suspend blocks (and noop blocks) the Store holds: statistics are taken on a
    // Store of one suspend block, as singleton statistics or by ANALYZE, before 4,000 suspend blocks and as many noop
    // ones are added. A statement of 50 rows reads one row more with the fragment than with a constant in its place.
    it.each(STATISTICS)("reads one suspend block however many there are, with %s statistics", async (statistics) => {
      const rowsOf = (x: string) => `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50)
				SELECT ${x} AS x FROM n`;
      const probe = `SELECT ${SUSPEND_BLOCKS_SQL} AS x`;
      const perRow = rowsOf(SUSPEND_BLOCKS_SQL);
      const store = await migratedStore();
      const measured = await runInDurableObject(store, (_instance, state) => {
        const sql = state.storage.sql;
        const grow = (from: number, to: number) =>
          sql.exec(
            `WITH RECURSIVE n(i) AS (SELECT ? UNION ALL SELECT i + 1 FROM n WHERE i < ?)
						INSERT INTO instance_domain_blocks (domain, severity, created_at, updated_at)
						SELECT 'd' || i || '.example', CASE WHEN i % 2 = 0 THEN 'suspend' ELSE 'noop' END, 'x', 'x' FROM n`,
            from,
            to,
          );
        const suspends = () =>
          sql.exec<{ n: number }>("SELECT count(*) AS n FROM instance_domain_blocks WHERE severity = 'suspend'").one()
            .n;
        const run = (query: string) => {
          const cursor = sql.exec<{ x: number }>(query);
          const values = cursor.toArray().map((row) => row.x);
          return { values: [...new Set(values)], rows: cursor.rowsRead };
        };
        const constant = run(rowsOf("1")).rows;
        const read = (query: string) => {
          const { values, rows } = run(query);
          return { values, rows: query === perRow ? rows - constant : rows };
        };
        grow(1, 2);
        if (statistics === "singleton") {
          singletonStatistics(sql);
        } else {
          sql.exec("ANALYZE");
        }
        const before = { suspends: suspends(), reads: [read(probe), read(perRow)] };
        grow(3, 8_002);
        return [before, { suspends: suspends(), reads: [read(probe), read(perRow)] }];
      });
      expect(measured.map((phase) => phase.suspends)).toEqual([1, 4_001]);
      for (const phase of measured) {
        expect(phase.reads).toEqual([
          { values: [1], rows: 1 },
          { values: [1], rows: 1 },
        ]);
      }
    });
  });
});
