import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { leaveConversationsWith } from "../src/domain/conversations";
import { getFilterStatus } from "../src/domain/filters";
import { instanceInfo } from "../src/domain/instance";
import { accountLists, listLists } from "../src/domain/lists";
import { DAILY_LIMIT, updateScheduled } from "../src/domain/scheduled-statuses";
import { NOW } from "./app-helpers";
import { migratedStore } from "./helpers";
import { statementId } from "./plan-audit";
import { singletonStatistics } from "./plan-audit-store";
import { type SqlRow, watchedCursor } from "./read-helpers";

// RES-7 witnesses of the request reads group 9 of #1468 pinned (conversations.ts, filters.ts, scheduled-statuses.ts,
// lists.ts, instance.ts), each run side by side with main's statement (MAIN: main's audited SQL, each guarded by its
// identity) with the same parameters, in a savepoint rolled back before the pinned statement runs, under the plan
// audit's singleton statistics and after ANALYZE, taken once every population exists. Each flow names main's
// statements it runs, every one in order, and a production statement pairs with the next only when it is that
// statement with its pins taken out; a pinned statement out of that order, or past its end, fails the flow. Each pinned
// statement returns main's rows, writes as many and deletes the same ids, and reads no more than main after ANALYZE.
// The neighbours (other owners' conversations, filters and their statuses, scheduled statuses, lists, the remote
// accounts) grow on both sides of the viewer's rows (inserted before and after them), each counted by its own
// predicate: a statement reads the same rows but for a walk it states. The viewer's own key grows too (its
// conversations, filters, schedules of the day and of other days, lists past MAX_LISTS, which an import does not
// enforce; the local accounts), each population counted by its own predicate, and the flow reads at most its stated
// rows per row they gain together, and at least one when it walks them. The import-shaped rows: a participant named
// twice and one with a NUL after it, lists and filters of one title, schedules at one time. The day's count reads no
// more as the other days grow, and reads to DAILY_LIMIT on a day already past it.

const VIEWER = "600000000000000001";
const LOW = "500000000000000001";
const HIGH = "700000000000000001";
const TARGET = "550000000000000001";
const STATUS = "560000000000000001";
const SCHEDULE = "399999999999999999";
const DAY = "2026-11-20";
const AT = `${DAY}T12:00:00.000Z`;
const STATISTICS = ["singleton", "analyzed"] as const;
const FEW = 20;
const MANY = 60;
const OWN_FEW = 60;
const OWN_MANY = 120;
const normalized = (sql: string) => sql.replace(/\s+/g, " ").trim();
const id18 = (prefix: string, i: number) => `${prefix}${String(i).padStart(18 - prefix.length, "0")}`;
const credential = (scope: "read" | "write") => ({ tokenHash: "viewer", scope, now: NOW });

// main's audited statements, as main's code wrote them.
const MAIN: Record<string, string> = {
  "483bcfadf028a776":
    "DELETE FROM conversations WHERE account_id = ?1 AND EXISTS (SELECT 1 FROM json_each(conversations.participants) WHERE value = ?2)",
  "6e80489968ad0885":
    "SELECT fs.id, fs.filter_id, fs.status_id FROM filter_statuses fs JOIN filters f ON f.id = fs.filter_id WHERE fs.id = ? AND f.account_id = ?",
  d634d9244eae5d1e:
    "SELECT count(*) AS n FROM (SELECT 1 FROM scheduled_statuses ss WHERE ss.account_id = ?1 AND ss.scheduled_at >= ?2 AND ss.scheduled_at < ?3 AND ss.id IS NOT ?4 LIMIT ?5)",
  c062eb1780f68065: "SELECT id, title, replies_policy, exclusive FROM lists WHERE account_id = ? ORDER BY id",
  "28567507fc2af2e0":
    "SELECT id, title, replies_policy, exclusive FROM lists l WHERE l.account_id = ?1 AND EXISTS (SELECT 1 FROM list_accounts lh WHERE lh.list_id = l.id AND lh.account_id = ?2) AND (NOT EXISTS (SELECT 1 FROM main.local_accounts pl WHERE pl.account_id = ?2 AND pl.suspended_at IS NOT NULL UNION ALL SELECT 1 FROM main.accounts pa INDEXED BY accounts_deleted WHERE pa.id = ?2 AND pa.deleted_at IS NOT NULL UNION ALL SELECT 1 FROM main.accounts ps INDEXED BY accounts_suspended WHERE ps.id = ?2 AND (ps.suspended_at IS NOT NULL AND ps.suspension_source = 'account')) AND NOT (CASE WHEN EXISTS (SELECT 1 FROM main.instance_domain_blocks INDEXED BY instance_domain_blocks_suspend WHERE severity = 'suspend') THEN EXISTS (WITH RECURSIVE pk(d) AS (SELECT DISTINCT CASE pv.n WHEN 1 THEN rtrim(pc.domain, '.') ELSE rtrim(lower(substr(substr(substr(pc.uri, instr(pc.uri, '://') + 3), 1, instr(substr(pc.uri, instr(pc.uri, '://') + 3) || '/', '/') - 1), 1, instr(substr(substr(pc.uri, instr(pc.uri, '://') + 3), 1, instr(substr(pc.uri, instr(pc.uri, '://') + 3) || '/', '/') - 1) || ':', ':') - 1)), '.') END FROM main.accounts pc INDEXED BY sqlite_autoindex_accounts_1 CROSS JOIN (SELECT 1 AS n UNION ALL SELECT 2) pv WHERE pc.domain IS NOT NULL AND pc.id = ?2), ps(d, dots) AS (SELECT CASE WHEN length(CAST(d AS BLOB)) <= 1012 THEN d END, CASE WHEN length(CAST(d AS BLOB)) <= 1012 THEN length(d) - length(replace(d, '.', '')) ELSE -1 END FROM pk UNION ALL SELECT substr(d, instr(d, '.') + 1), dots - 1 FROM ps WHERE dots > 1 AND NOT EXISTS (SELECT 1 FROM main.instance_domain_blocks pn INDEXED BY sqlite_autoindex_instance_domain_blocks_1 WHERE ps.dots BETWEEN 1 AND 7 AND pn.domain = ps.d)) SELECT 1 FROM ps LEFT JOIN main.instance_domain_blocks pr INDEXED BY sqlite_autoindex_instance_domain_blocks_1 ON ps.dots BETWEEN 1 AND 7 AND pr.domain = ps.d WHERE ps.dots < 0 OR (pr.domain IS NOT NULL AND pr.severity = 'suspend')) ELSE 0 END)) ORDER BY l.id",
  "782bd4dc8403b718":
    "SELECT u.users, u.active, (SELECT SUM(CASE WHEN typeof(statuses_count) = 'integer' AND statuses_count BETWEEN 0 AND 9007199254740991 THEN statuses_count ELSE 0 END) FROM accounts WHERE domain IS NULL) AS statuses, (SELECT COUNT(DISTINCT domain) FROM accounts WHERE domain IS NOT NULL) AS domains FROM (SELECT COUNT(*) AS users, COUNT(CASE WHEN l.active_on BETWEEN ?1 AND ?2 THEN 1 END) AS active FROM local_accounts l WHERE l.suspended_at IS NULL) u",
};

// The pins each rewrite adds to main's statement.
const PINS: Record<string, (text: string) => string> = {
  "483bcfadf028a776": (text) => text.replace(" INDEXED BY conversations_account", ""),
  "6e80489968ad0885": (text) =>
    text.replace(
      " INDEXED BY sqlite_autoindex_filter_statuses_1 CROSS JOIN filters f INDEXED BY filters_account ON",
      " JOIN filters f ON",
    ),
  d634d9244eae5d1e: (text) => text.replace(" INDEXED BY scheduled_statuses_account_time", ""),
  c062eb1780f68065: (text) => text.replace(" INDEXED BY lists_account", ""),
  "28567507fc2af2e0": (text) => text.replace(" INDEXED BY lists_account", ""),
  "782bd4dc8403b718": (text) => text.replace(" INDEXED BY accounts_domain_username", ""),
};

// The rows a DELETE removes, read on both sides as the ids there before it and not after it.
const DELETED: Record<string, string> = {
  "483bcfadf028a776": "SELECT CAST(id AS TEXT) AS id FROM conversations ORDER BY id",
};

// Whether `text` is the pinned form of main's statement `id`.
function rewrites(id: string, text: string): boolean {
  const main = MAIN[id];
  return main !== undefined && text !== normalized(main) && PINS[id]!(text) === normalized(main);
}

type Measure = { rows: number; written: number; result: SqlRow[]; deleted: SqlRow[] };
type Side = { id: string; query: string; mine: Measure; main: Measure };

const ROLLBACK = new Error("rolled back");

// A SqlStorage over `real` that pairs the production statements with `expected` (main's identities, in order): each
// statement that is the pinned form of the next one runs main's of that identity first, with the same parameters, in
// a nested transaction it rolls back (the ids it deletes read inside it), then itself, recording both one `Side`. A
// pinned form of any other identity, or one after `expected` is used up, is recorded under its own identity with
// nothing compared, so the flow's sequence fails. Every other statement runs as it is.
function sideBySide(
  real: SqlStorage,
  transact: <T>(fn: () => T) => T,
  expected: readonly string[],
  sides: Side[],
): SqlStorage {
  return {
    exec: (query: string, ...params: SqlStorageValue[]) => {
      const text = normalized(query);
      const kind = Object.keys(PINS).find((key) => rewrites(key, text));
      if (kind === undefined) {
        return real.exec(query, ...params);
      }
      const empty = (): Measure => ({ rows: 0, written: 0, result: [], deleted: [] });
      const side: Side = { id: kind, query, mine: empty(), main: empty() };
      sides.push(side);
      if (expected[sides.length - 1] !== kind) {
        return real.exec(query, ...params);
      }
      const ids = DELETED[kind];
      const before = ids === undefined ? [] : real.exec<{ id: string }>(ids).toArray();
      const deleted = (): SqlRow[] => {
        if (ids === undefined) {
          return [];
        }
        const left = new Set(
          real
            .exec<{ id: string }>(ids)
            .toArray()
            .map((row) => row.id),
        );
        return before.filter((row) => !left.has(row.id));
      };
      try {
        transact(() => {
          const cursor = real.exec<SqlRow>(MAIN[kind]!, ...params);
          side.main.result = cursor.toArray();
          side.main.rows = cursor.rowsRead;
          side.main.written = cursor.rowsWritten;
          side.main.deleted = deleted();
          throw ROLLBACK;
        });
      } catch (error) {
        if (error !== ROLLBACK) {
          throw error;
        }
      }
      const cursor = real.exec<SqlRow>(query, ...params);
      return watchedCursor(
        cursor,
        () => {
          side.mine.rows += cursor.rowsRead;
          side.mine.written = cursor.rowsWritten;
          side.mine.deleted = deleted();
        },
        (rows) => (side.mine.result = rows),
      );
    },
  } as unknown as SqlStorage;
}

function local(sql: SqlStorage, id: string, name: string) {
  sql.exec(
    "INSERT INTO accounts (id, uri, username) VALUES (?, ?, ?)",
    id,
    `https://kopje.test/ap/users/${name}`,
    name,
  );
  sql.exec(
    "INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, ?, X'00', X'00', 'k')",
    id,
    `${name}@example.com`,
  );
}

// `n` rows of each kind an owner holds, ids from `base` (two digits): conversations (every other one with TARGET,
// one naming it twice), filters each with a status of its own, schedules on DAY and the day after, lists (every
// other one holding TARGET); and, with a `domain`, `n` remote accounts on it.
function holdings(sql: SqlStorage, owner: string, base: string, n: number, domain: string | null) {
  const each = (query: string, ...params: SqlStorageValue[]) =>
    sql.exec(`WITH RECURSIVE i(k) AS (SELECT 0 UNION ALL SELECT k + 1 FROM i WHERE k < ?1 - 1) ${query}`, n, ...params);
  each(
    `INSERT INTO conversations (account_id, thread, participants, last_status_id)
		SELECT ?2, ?3 || k, CASE k % 4 WHEN 0 THEN json_array(?4) WHEN 2 THEN json_array(?4, ?4) ELSE json_array(?5) END, ?6
		FROM i`,
    owner,
    `${base}-t`,
    TARGET,
    HIGH === owner ? LOW : HIGH,
    STATUS,
  );
  each(
    `INSERT INTO filters (id, account_id, title, context) SELECT ?2 || printf('%016d', k), ?3, 'one title', '["home"]' FROM i`,
    base,
    owner,
  );
  each(
    `INSERT INTO filter_statuses (id, filter_id, status_id) SELECT ?2 || printf('%016d', k), ?3 || printf('%016d', k), ?4 FROM i`,
    `${base[0]}${Number(base[1]) + 1}`,
    base,
    STATUS,
  );
  for (const [offset, at] of [
    [0, AT],
    [n, `${DAY.slice(0, 8)}21T12:00:00.000Z`],
  ] as const) {
    each(
      `INSERT INTO scheduled_statuses (id, account_id, scheduled_at, params)
			SELECT ?2 || printf('%016d', k + ?5), ?3, ?4, '{}' FROM i`,
      `${base[0]}${Number(base[1]) + 2}`,
      owner,
      at,
      offset,
    );
  }
  each(
    `INSERT INTO lists (id, account_id, title) SELECT ?2 || printf('%016d', k), ?3, 'one title' FROM i`,
    `${base[0]}${Number(base[1]) + 3}`,
    owner,
  );
  each(
    `INSERT INTO list_accounts (list_id, account_id) SELECT ?2 || printf('%016d', k), ?3 FROM i WHERE k % 2 = 0`,
    `${base[0]}${Number(base[1]) + 3}`,
    TARGET,
  );
  if (domain === null) {
    return;
  }
  each(
    `INSERT INTO accounts (id, uri, username, domain)
		SELECT ?2 || printf('%016d', k), 'https://' || ?3 || '/u/' || k, 'u' || k, ?3 FROM i`,
    `${base[0]}${Number(base[1]) + 4}`,
    `${domain}.example`,
  );
}

// The viewer's own rows, `own` of each kind: conversations (as an owner's, and one naming TARGET with a NUL after
// it), filters, schedules of the day after and `day` of DAY, the one SCHEDULE moved, lists, and own / 10 local
// accounts.
function subject(sql: SqlStorage, own: number, day: number) {
  holdings(sql, VIEWER, "30", own, null);
  sql.exec(
    "INSERT INTO conversations (account_id, thread, participants, last_status_id) VALUES (?, 'nul', json_array(? || char(0) || 'x'), ?)",
    VIEWER,
    TARGET,
    STATUS,
  );
  sql.exec(
    "DELETE FROM scheduled_statuses WHERE account_id = ? AND scheduled_at = ? AND id > ?",
    VIEWER,
    AT,
    id18("32", day - 1),
  );
  sql.exec(
    "INSERT INTO scheduled_statuses (id, account_id, scheduled_at, params) VALUES (?, ?, ?, '{}')",
    SCHEDULE,
    VIEWER,
    `${DAY.slice(0, 8)}22T12:00:00.000Z`,
  );
  sql.exec(
    `WITH RECURSIVE i(k) AS (SELECT 0 UNION ALL SELECT k + 1 FROM i WHERE k < ?1 - 1)
		INSERT INTO accounts (id, uri, username) SELECT '61' || printf('%016d', k), 'https://kopje.test/ap/users/o' || k, 'o' || k FROM i`,
    Math.floor(own / 10),
  );
  sql.exec(
    `INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey)
		SELECT id, username || '@example.com', X'00', X'00', 'k' FROM accounts WHERE id GLOB '61*'`,
  );
}

function base(sql: SqlStorage) {
  local(sql, VIEWER, "viewer");
  local(sql, LOW, "low");
  local(sql, HIGH, "high");
  sql.exec(
    "INSERT INTO accounts (id, uri, username, domain) VALUES (?, 'https://t.example/u', 't', 't.example')",
    TARGET,
  );
  sql.exec(
    "INSERT INTO statuses (id, uri, account_id, visibility, published_at) VALUES (?, 'https://t.example/s', ?, 'public', ?)",
    STATUS,
    TARGET,
    new Date(NOW).toISOString(),
  );
  sql.exec(
    "INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('app', 's', 'app', 'urn:ietf:wg:oauth:2.0:oob', 'read write')",
  );
  sql.exec(
    "INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES ('viewer', 'access', 'app', ?, 'read write')",
    VIEWER,
  );
}

type Flow = {
  main: readonly string[];
  run: (sql: SqlStorage, transact: <T>(fn: () => T) => T) => unknown;
  // The neighbour populations the flow's statements could read, each by its own predicate.
  neighbours: Record<string, string>;
  // A statement whose reads walk a neighbour population, and the rows it reads per row of it.
  walks?: Record<string, { population: string; perRun: number }>;
  // The viewer's own key, each population by its own predicate, and the rows the flow reads at most per row they gain
  // together (0: none, a lookup by key).
  own: { count: Record<string, string>; walks: number };
  // The viewer's schedules of DAY at `own` (own / 12 + 1 by default), and the operation's value.
  day?: (own: number) => number;
  answer?: unknown;
};

const others = (table: string) => `SELECT count(*) AS n FROM ${table} WHERE account_id <> '${VIEWER}'`;
const mine = (table: string, where = "1") =>
  `SELECT count(*) AS n FROM ${table} WHERE account_id = '${VIEWER}' AND ${where}`;

const FLOWS: Record<string, Flow> = {
  // A block of TARGET: the viewer's conversations with it go (one naming it twice among them; not the one naming it
  // with a NUL after it).
  "the conversations a block leaves": {
    main: ["483bcfadf028a776"],
    run: (sql) => leaveConversationsWith(new Db(sql), VIEWER, TARGET),
    neighbours: { conversations: others("conversations") },
    own: { count: { conversations: mine("conversations") }, walks: 3 },
  },
  // The viewer's filter status by its id.
  "the viewer's filter status": {
    main: ["6e80489968ad0885"],
    run: (sql, transact) => getFilterStatus.run(sql, { id: id18("31", 1), credential: credential("read") }, transact),
    neighbours: {
      filters: others("filters"),
      statuses: `SELECT count(*) AS n FROM filter_statuses WHERE filter_id IN (SELECT id FROM filters WHERE account_id <> '${VIEWER}')`,
    },
    own: {
      count: {
        filters: mine("filters"),
        statuses: `SELECT count(*) AS n FROM filter_statuses WHERE filter_id IN (SELECT id FROM filters WHERE account_id = '${VIEWER}')`,
      },
      walks: 0,
    },
  },
  // Another owner's filter status by its id: none.
  "another owner's filter status": {
    main: ["6e80489968ad0885"],
    run: (sql, transact) => getFilterStatus.run(sql, { id: id18("21", 1), credential: credential("read") }, transact),
    neighbours: {
      filters: others("filters"),
      statuses: `SELECT count(*) AS n FROM filter_statuses WHERE filter_id IN (SELECT id FROM filters WHERE account_id <> '${VIEWER}')`,
    },
    own: {
      count: {
        filters: mine("filters"),
        statuses: `SELECT count(*) AS n FROM filter_statuses WHERE filter_id IN (SELECT id FROM filters WHERE account_id = '${VIEWER}')`,
      },
      walks: 0,
    },
  },
  // A schedule of the day after moved to DAY: the day's count reads the viewer's schedules of DAY.
  "a schedule moved to a day": {
    main: ["d634d9244eae5d1e"],
    run: (sql, transact) =>
      updateScheduled.run(sql, { id: SCHEDULE, scheduledAt: AT, now: NOW, credential: credential("write") }, transact),
    neighbours: { day: others("scheduled_statuses") },
    own: {
      count: {
        day: mine("scheduled_statuses", `scheduled_at = '${AT}'`),
        others: mine("scheduled_statuses", `scheduled_at <> '${AT}'`),
      },
      walks: 1,
    },
  },
  // The same, the viewer's schedules of DAY held: other days grown, the day's count reads no more.
  "a schedule moved to a day, other days grown": {
    main: ["d634d9244eae5d1e"],
    run: (sql, transact) =>
      updateScheduled.run(sql, { id: SCHEDULE, scheduledAt: AT, now: NOW, credential: credential("write") }, transact),
    neighbours: { day: others("scheduled_statuses") },
    own: { count: { others: mine("scheduled_statuses", `scheduled_at <> '${AT}'`) }, walks: 0 },
    day: () => 5,
    answer: { status: "ok" },
  },
  // A schedule moved to a DAY that already holds more than DAILY_LIMIT: refused, the count read to its limit.
  "a schedule moved to a full day": {
    main: ["d634d9244eae5d1e"],
    run: (sql, transact) =>
      updateScheduled.run(sql, { id: SCHEDULE, scheduledAt: AT, now: NOW, credential: credential("write") }, transact),
    neighbours: { day: others("scheduled_statuses") },
    own: {
      count: {
        day: mine("scheduled_statuses", `scheduled_at = '${AT}'`),
        others: mine("scheduled_statuses", `scheduled_at <> '${AT}'`),
      },
      walks: 0,
    },
    day: (own) => DAILY_LIMIT + own / 12,
    answer: {
      status: "invalid",
      error: `Validation failed: You have exceeded the limit of ${DAILY_LIMIT} scheduled posts for today`,
    },
  },
  // The viewer's lists.
  "the viewer's lists": {
    main: ["c062eb1780f68065"],
    run: (sql, transact) => listLists.run(sql, { credential: credential("read") }, transact),
    neighbours: { lists: others("lists") },
    own: { count: { lists: mine("lists") }, walks: 2 },
  },
  // The viewer's lists that hold TARGET.
  "the viewer's lists holding an account": {
    main: ["28567507fc2af2e0"],
    run: (sql, transact) => accountLists.run(sql, { account: TARGET, credential: credential("read") }, transact),
    neighbours: {
      lists: others("lists"),
      held: `SELECT count(*) AS n FROM list_accounts WHERE list_id IN (SELECT id FROM lists WHERE account_id <> '${VIEWER}')`,
    },
    own: {
      count: {
        lists: mine("lists"),
        held: `SELECT count(*) AS n FROM list_accounts WHERE list_id IN (SELECT id FROM lists WHERE account_id = '${VIEWER}')`,
      },
      walks: 2,
    },
  },
  // The instance's counts: the local accounts and their statuses, the peer domains.
  "the instance's counts": {
    main: ["782bd4dc8403b718"],
    run: (sql, transact) => instanceInfo.run(sql, { now: NOW, present: { origin: "https://kopje.test" } }, transact),
    neighbours: { remote: "SELECT count(*) AS n FROM accounts WHERE domain IS NOT NULL" },
    // The peer domain count walks the remote accounts (#1502).
    walks: { "782bd4dc8403b718": { population: "remote", perRun: 1 } },
    own: {
      count: {
        local: "SELECT count(*) AS n FROM local_accounts",
        accounts: "SELECT count(*) AS n FROM accounts WHERE domain IS NULL",
      },
      walks: 1,
    },
  },
};

function world(n: number, own: number, day: number) {
  return migratedStore().then(async (store) => {
    await runInDurableObject(store, (_instance, state) => {
      const sql = state.storage.sql;
      base(sql);
      holdings(sql, LOW, "20", n, "a");
      subject(sql, own, day);
      holdings(sql, HIGH, "40", n, "z");
    });
    return store;
  });
}

async function sides(statistics: (typeof STATISTICS)[number], flow: Flow, n: number, own: number) {
  const store = await world(n, own, flow.day?.(own) ?? Math.floor(own / 12) + 1);
  return runInDurableObject(store, (_instance, state) => {
    const sql = state.storage.sql;
    const transact = <T>(fn: () => T): T => state.storage.transactionSync(fn);
    const count = (queries: Record<string, string>) =>
      Object.fromEntries(Object.entries(queries).map(([name, q]) => [name, sql.exec<{ n: number }>(q).one().n]));
    const neighbours = count(flow.neighbours);
    const ownCount = count(flow.own.count);
    if (statistics === "singleton") {
      singletonStatistics(sql);
    } else {
      sql.exec("ANALYZE");
    }
    const out: Side[] = [];
    const result = transact(() => flow.run(sideBySide(sql, transact, flow.main, out), transact));
    return { sides: out, neighbours, own: ownCount, result };
  });
}

const total = (counts: Record<string, number>) => Object.values(counts).reduce((a, n) => a + n, 0);
const readOf = (sides: readonly Side[]) => sides.reduce((a, s) => a + s.mine.rows, 0);

describe("main's statements", () => {
  it("are main's audited ones", async () => {
    expect(Object.keys(MAIN).toSorted()).toEqual(Object.keys(PINS).toSorted());
    for (const [id, sql] of Object.entries(MAIN)) {
      expect(await statementId(sql), sql).toBe(id);
    }
  });
});

describe("group 9's pinned reads beside main's (RES-7)", () => {
  it.each(STATISTICS.flatMap((statistics) => Object.keys(FLOWS).map((name) => [statistics, name] as const)))(
    "%s statistics: %s",
    async (statistics, name) => {
      const flow = FLOWS[name]!;
      const few = await sides(statistics, flow, FEW, OWN_FEW);
      const many = await sides(statistics, flow, MANY, OWN_FEW);
      const ownMany = await sides(statistics, flow, FEW, OWN_MANY);
      for (const population of Object.keys(flow.neighbours)) {
        expect(many.neighbours[population]!, population).toBeGreaterThan(few.neighbours[population]!);
      }
      for (const population of Object.keys(flow.own.count)) {
        expect(ownMany.own[population]!, `own ${population}`).toBeGreaterThan(few.own[population]!);
      }
      for (const run of [few, many, ownMany]) {
        expect(
          run.sides.map((s) => s.id),
          "main's statements, every one in order",
        ).toEqual(flow.main);
        for (const side of run.sides) {
          expect(side.mine.result, side.query).toEqual(side.main.result);
          expect(side.mine.written, side.query).toBe(side.main.written);
          expect(side.mine.deleted, side.query).toEqual(side.main.deleted);
          if (statistics === "analyzed") {
            expect(side.mine.rows, side.query).toBeLessThanOrEqual(side.main.rows);
          }
        }
        if (Object.keys(DELETED).some((id) => flow.main.includes(id))) {
          expect(run.sides.reduce((n, side) => n + side.main.deleted.length, 0)).toBeGreaterThan(0);
        }
      }
      expect(many.result).toEqual(few.result);
      if (flow.answer !== undefined) {
        for (const run of [few, many, ownMany]) {
          expect(run.result).toMatchObject({ status: "ok", value: flow.answer });
        }
      }
      // The neighbours: the same rows but for a walk of a population.
      for (const [i, side] of many.sides.entries()) {
        const walk = flow.walks?.[side.id];
        const allowed =
          walk === undefined ? 0 : walk.perRun * (many.neighbours[walk.population]! - few.neighbours[walk.population]!);
        const grown = side.mine.rows - few.sides[i]!.mine.rows;
        expect(grown, side.id).toBeGreaterThanOrEqual(0);
        expect(grown, side.id).toBeLessThanOrEqual(allowed);
      }
      // The own key: at most `walks` rows per row it gained (its populations added up), at least one when it walks.
      const gained = total(ownMany.own) - total(few.own);
      const grown = readOf(ownMany.sides) - readOf(few.sides);
      expect(grown).toBeLessThanOrEqual(flow.own.walks * gained);
      expect(grown).toBeGreaterThanOrEqual(flow.own.walks === 0 ? 0 : 1);
    },
    120_000,
  );
});
