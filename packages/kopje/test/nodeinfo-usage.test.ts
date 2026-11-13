import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { getNodeInfoUsage, nodeInfoUsageOf } from "../src/domain/actors";
import type { StoreStub } from "../src/platform/store-client";
import { sql } from "./api-helpers";
import { migratedStore } from "./helpers";
import { expectBeside, expectGrowth, gain, PlanWitness, type Run, STATISTICS, type Statistics } from "./plan-witness";
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

  // A Store whose only recent poster is suspended counts it neither as a user nor as active; localPosts still counts
  // its original status, as /api/v1/instance's status count does (nodeInfoUsageOf).
  it("counts a suspended recent poster as neither a user nor active", async () => {
    const store = await migratedStore();
    await localAccounts({ store }, 1);
    await sql(
      store,
      `INSERT INTO statuses (id, uri, account_id, visibility, published_at)
			VALUES ('700000000000000000', 'https://kopje.test/ap/o/recent', ?1, 'public', '2026-05-30T00:00:00.000Z')`,
      ACTIVE,
    );
    const usage = () =>
      runInDurableObject(store, (_instance, state) => nodeInfoUsageOf(new Db(state.storage.sql), NOW));
    expect(await usage()).toEqual({ users: 1, activeMonth: 1, activeHalfyear: 1, localPosts: 1 });
    await sql(
      store,
      "UPDATE local_accounts SET suspended_at = '2026-05-31T00:00:00.000Z' WHERE account_id = ?",
      ACTIVE,
    );
    expect(await usage()).toEqual({ users: 0, activeMonth: 0, activeHalfyear: 0, localPosts: 1 });
  });
});

// RES-7 witness of the active probe beside main's statement (test/plan-witness.ts), under the plan audit's singleton
// statistics and after ANALYZE, taken once every population exists. Each population grows apart, counted by its own
// predicate: an active account's older history (ids below its recent status), an idle account's history, an imported
// account's history (ids above its recent status), the available local accounts, and the remote statuses. The rewrite
// returns main's counts, reads no more than main after ANALYZE, and each growth costs it at most main's walk: none for
// an active account's history or the remote statuses, one row per status for an idle or imported account's history
// (#1479). Import-shaped rows: statuses tied on published_at at the window's edge, a published_at with a NUL after it,
// a suspended_at that is empty. Suspended accounts are counted by main and not by the rewrite, which never probes them.
// The run's other statements are main's users and localPosts counts, unchanged and allowed literally; any further
// statement fails the witness.
const ACTIVE_PROBE = new PlanWitness(
  {
    e087e97290cf7451: {
      sql: "SELECT count(*) AS n FROM local_accounts l WHERE (SELECT 1 FROM statuses s INDEXED BY statuses_account WHERE s.account_id = l.account_id AND s.published_at >= ? ORDER BY s.id DESC LIMIT 1) IS NOT NULL",
      text: "SELECT count(*) AS n FROM local_accounts l WHERE l.suspended_at IS NULL AND (SELECT 1 FROM statuses s INDEXED BY statuses_account WHERE s.account_id = l.account_id AND s.published_at >= ? ORDER BY s.id DESC LIMIT 1) IS NOT NULL",
    },
  },
  /s\.published_at >= \?/,
  [
    "SELECT count(*) AS n FROM local_accounts l WHERE l.suspended_at IS NULL",
    "SELECT count(*) AS n FROM local_accounts l CROSS JOIN statuses s INDEXED BY statuses_account_originals ON s.account_id = l.account_id WHERE s.reblog_of_id IS NULL",
  ],
);
// The month's probe, then the half-year's.
const PROBES = ["e087e97290cf7451", "e087e97290cf7451"];
const MONTH_EDGE = new Date(NOW - 30 * 24 * 60 * 60 * 1000).toISOString();
const OLD = "2020-01-01T00:00:00.000Z";
const RECENT = "2026-05-30T00:00:00.000Z";
const REMOTE = "900000000000000000";

type Shape = {
  active: number;
  idle: number;
  imported: number;
  suspended: number;
  history: { active: number; idle: number; imported: number; suspended: number };
  remote: number;
};
const BASE: Shape = {
  active: 3,
  idle: 3,
  imported: 3,
  suspended: 0,
  history: { active: 20, idle: 20, imported: 20, suspended: 20 },
  remote: 20,
};
const shapeOf = (history: Partial<Shape["history"]>, shape: Partial<Shape> = {}): Shape => ({
  ...BASE,
  ...shape,
  history: { ...BASE.history, ...history },
});

// `count` public statuses of `account` with ids from `low`, published at `at`.
function statusesOf(sql: SqlStorage, account: string, count: number, low: bigint, at: string) {
  sql.exec(
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
		INSERT INTO statuses (id, uri, account_id, visibility, published_at)
		SELECT CAST(?2 + i AS TEXT), 'https://kopje.test/ap/o/' || ?2 || '-' || i, ?3, 'public', ?4 FROM n`,
    count,
    String(low),
    account,
    at,
  );
}

// The local accounts by kind (ids 61… active, 62… idle, 63… imported, 64… suspended), each with its statuses in an id
// range of its own, and one remote account's recent statuses.
function shaped(sql: SqlStorage, shape: Shape) {
  let next = 0;
  const account = (kind: string, i: number, suspendedAt: string | null) => {
    const id = `${kind}${String(i).padStart(16, "0")}`;
    sql.exec(
      "INSERT INTO accounts (id, uri, username) VALUES (?1, 'https://kopje.test/ap/users/' || ?1, 'u' || ?1)",
      id,
    );
    sql.exec(
      `INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey, suspended_at)
			VALUES (?1, ?1 || '@example.com', X'00', X'00', 'k', ?2)`,
      id,
      suspendedAt,
    );
    next += 1;
    return { id, low: 100000000000000000n + BigInt(next) * 1000000n };
  };
  for (let i = 0; i < shape.active; i++) {
    const { id, low } = account("61", i, null);
    statusesOf(sql, id, shape.history.active, low, OLD);
    // Above the history: two tied at the window's edge, one with a NUL after its published_at, or one recent.
    statusesOf(sql, id, i === 0 ? 2 : 1, low + 500000n, i === 0 ? MONTH_EDGE : i === 1 ? `${RECENT}\u0000x` : RECENT);
  }
  for (let i = 0; i < shape.idle; i++) {
    const { id, low } = account("62", i, null);
    statusesOf(sql, id, shape.history.idle, low, OLD);
  }
  // A recent status below the older history (#1479), and so for the suspended accounts, one suspended_at empty.
  for (let i = 0; i < shape.imported; i++) {
    const { id, low } = account("63", i, null);
    statusesOf(sql, id, 1, low, RECENT);
    statusesOf(sql, id, shape.history.imported, low + 1n, OLD);
  }
  for (let i = 0; i < shape.suspended; i++) {
    const { id, low } = account("64", i, i === 0 ? "" : "2026-05-31T00:00:00.000Z");
    statusesOf(sql, id, 1, low, RECENT);
    statusesOf(sql, id, shape.history.suspended, low + 1n, OLD);
  }
  sql.exec(
    "INSERT INTO accounts (id, uri, username, domain) VALUES (?1, 'https://r.example/u', 'r', 'r.example')",
    REMOTE,
  );
  statusesOf(sql, REMOTE, shape.remote, 900000000000000000n, RECENT);
}

const historyOf = (kind: string) =>
  `SELECT count(*) AS n FROM statuses WHERE account_id GLOB '${kind}*' AND published_at = '${OLD}'`;
const POPULATIONS = {
  "active history": historyOf("61"),
  "idle history": historyOf("62"),
  "imported history": historyOf("63"),
  "suspended history": historyOf("64"),
  accounts: "SELECT count(*) AS n FROM local_accounts WHERE suspended_at IS NULL",
  remote: `SELECT count(*) AS n FROM statuses WHERE account_id = '${REMOTE}'`,
};

// `stray`: a further read the run makes after the usage, which the witness must refuse.
async function probed(statistics: Statistics, shape: Shape, stray?: (sql: SqlStorage) => void): Promise<Run> {
  const store = await migratedStore();
  return runInDurableObject(store, (_instance, state) => {
    shaped(state.storage.sql, shape);
    return ACTIVE_PROBE.measure(state, {
      statistics,
      expected: PROBES,
      populations: POPULATIONS,
      run: (sql) => {
        const usage = nodeInfoUsageOf(new Db(sql), NOW);
        stray?.(sql);
        return usage;
      },
    });
  });
}

// Each growth: the shape that grows it, its population, and the rows each probe may read per row it gains.
const GROWTHS: Record<string, { shape: Shape; population: string; perRun: number }> = {
  "an active account's older history": { shape: shapeOf({ active: 80 }), population: "active history", perRun: 0 },
  "an idle account's history": { shape: shapeOf({ idle: 80 }), population: "idle history", perRun: 1 },
  "an imported account's history": { shape: shapeOf({ imported: 80 }), population: "imported history", perRun: 1 },
  "the available local accounts": { shape: shapeOf({}, { active: 9 }), population: "accounts", perRun: 2 },
  "the remote statuses": { shape: shapeOf({}, { remote: 200 }), population: "remote", perRun: 0 },
};

describe("NodeInfo's active probe beside main's (RES-7)", () => {
  it("is main's audited statement", async () => {
    await ACTIVE_PROBE.expectAudited();
  });

  it.each(STATISTICS.flatMap((statistics) => Object.keys(GROWTHS).map((name) => [statistics, name] as const)))(
    "%s statistics: %s",
    async (statistics, name) => {
      const growth = GROWTHS[name]!;
      const base = await probed(statistics, BASE);
      const more = await probed(statistics, growth.shape);
      for (const run of [base, more]) {
        expectBeside(statistics, run);
      }
      expect(base.result).toMatchObject({ users: 9, activeMonth: 6, activeHalfyear: 6 });
      expectGrowth(base, more, {
        populations: [growth.population],
        perSide: { "*": { population: growth.population, perRun: growth.perRun } },
      });
    },
    120_000,
  );

  // Suspended accounts with a recent status below their history, one with an empty suspended_at: main counts them and
  // walks their history; the rewrite counts only the available accounts, reads no more than main, and no more as the
  // suspended accounts' history grows.
  it.each(STATISTICS)(
    "%s statistics: leaves the suspended accounts out without probing them",
    async (statistics) => {
      const base = await probed(statistics, shapeOf({}, { suspended: 3 }));
      const more = await probed(statistics, shapeOf({ suspended: 80 }, { suspended: 3 }));
      expect(gain(base, more, "suspended history")).toBeGreaterThan(0);
      for (const run of [base, more]) {
        expect(run.sides.map((side) => side.fault ?? side.id)).toEqual(PROBES);
        expect(run.result).toMatchObject({ users: 9, activeMonth: 6, activeHalfyear: 6 });
        for (const side of run.sides) {
          expect(side.main.result).toEqual([{ n: 9 }]);
          expect(side.mine.result).toEqual([{ n: 6 }]);
          expect(side.mine.rows, side.query).toBeLessThanOrEqual(side.main.rows);
        }
      }
      for (const [i, side] of more.sides.entries()) {
        expect(side.main.rows, side.query).toBeGreaterThan(base.sides[i]!.main.rows);
        expect(side.mine.rows, side.query).toBe(base.sides[i]!.mine.rows);
      }
    },
    120_000,
  );

  // A further read of an account's whole history, a SEARCH the plan audit passes, grows with that history unmeasured
  // unless the witness refuses it.
  it.each(STATISTICS)(
    "%s statistics: fails a statement it does not allow",
    async (statistics) => {
      const run = await probed(statistics, shapeOf({ active: 80 }), (sql) =>
        sql
          .exec(
            "SELECT count(*) AS n FROM statuses s INDEXED BY statuses_account WHERE s.account_id = ?",
            "610000000000000000",
          )
          .toArray(),
      );
      expect(run.sides.map((side) => side.fault)).toEqual([undefined, undefined, "not allowed"]);
      expect(() => expectBeside(statistics, run)).toThrow(/main's statements, every one in order/);
    },
    120_000,
  );
});
