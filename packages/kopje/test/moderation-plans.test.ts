import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { REACH_INBOX_BYTES, reachFollowerInboxes } from "../src/domain/audience";
import { REPORT_ROUND } from "../src/domain/moderation-bounds";
import { writeOperation } from "../src/domain/operation";
import { sweepStaleVotes } from "../src/domain/polls";
import { remoteModerationRound } from "../src/domain/remote-suspension";
import { resolveSuspensionReports } from "../src/domain/reports";
import { moderationRound, REACH_ROUND } from "../src/domain/suspension";
import type { StoreStub } from "../src/platform/store-client";
import { sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { migratedStore } from "./helpers";
import { expectBeside, expectGrowth, PlanWitness, type Run, STATISTICS, type Statistics } from "./plan-witness";
import { observedSql, plannedRun, scansOf, staleStatistics } from "./read-helpers";
import { act, world, type World } from "./remote-suspension-helpers";
import { normalized } from "./sql-text";
import { community, remoteAccount } from "./status-helpers";

// RES-7: the cron's and the moderation jobs' bounded writes seek what they write by key, with statistics taken before
// the Store grew: the stale-vote sweep (polls.ts), a suspension's report resolution (reports.ts), its followers round
// and its staged rows (suspension.ts).

const AT = new Date(NOW).toISOString();

describe("the stale-vote sweep with stale statistics (RES-7)", () => {
  const sweep = writeOperation<{ limit: number }, number>((db, { limit }) => sweepStaleVotes(db, limit));

  // A stale poll of `status` at generation 1 with `old` votes of generation 0 and one current one.
  async function stalePoll(h: Awaited<ReturnType<typeof community>>, status: string, voter: string, old: number) {
    await sql(
      h.store,
      `INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
			VALUES (?1, 'https://kopje.test/ap/o/' || ?1, ?2, 'public', '<p>p</p>', ?3)`,
      status,
      voter,
      AT,
    );
    await sql(
      h.store,
      `INSERT INTO polls (status_id, options, tallies, generation, stale) VALUES (?, '["x","y"]', '[0,0]', 1, 1)`,
      status,
    );
    await sql(
      h.store,
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?3)
			INSERT INTO poll_votes (poll_id, account_id, choice, generation)
			SELECT ?1, ?2, i % 100, CASE WHEN i = ?3 THEN 1 ELSE 0 END FROM n`,
      status,
      voter,
      old,
    );
  }

  it("deletes each poll's old votes by key within the limit, other polls' votes grown after ANALYZE", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    await stalePoll(h, "300000000000000001", alice.id, 3);
    await stalePoll(h, "300000000000000002", alice.id, 3);
    const { before, after } = await staleStatistics(h, {
      capture: (phase) => plannedRun(h, /poll_votes/, sweep, { limit: phase === "before" ? 2 : 4 }),
      grow: async () => {
        // The current votes of many other polls, which are not stale.
        for (let p = 0; p < 200; p++) {
          const status = String(310000000000000000n + BigInt(p));
          await sql(
            h.store,
            `INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
						VALUES (?1, 'https://kopje.test/ap/o/' || ?1, ?2, 'public', '<p>p</p>', ?3)`,
            status,
            alice.id,
            AT,
          );
          await sql(
            h.store,
            `INSERT INTO polls (status_id, options, tallies) VALUES (?, '["x","y"]', '[0,0]')`,
            status,
          );
          await sql(
            h.store,
            `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 99)
						INSERT INTO poll_votes (poll_id, account_id, choice) SELECT ?1, ?2, i FROM n`,
            status,
            alice.id,
          );
        }
      },
    });
    // The limit holds: two of the first poll's three, then its last and the second poll's three.
    expect([before.result, after.result]).toEqual([2, 4]);
    expect(
      await sql(
        h.store,
        "SELECT count(*) AS n FROM poll_votes WHERE poll_id LIKE '30000000000000000_' AND generation = 0",
      ),
    ).toEqual([{ n: 0 }]);
    expect(await sql(h.store, "SELECT count(*) AS n FROM polls WHERE stale = 1")).toEqual([{ n: 0 }]);
    const deletes = after.plans.filter((p) => p.query.startsWith("DELETE"));
    expect(deletes).toHaveLength(4);
    for (const { query, plan, rows } of after.plans) {
      expect(scansOf(plan, ["poll_votes", "polls"]), query).toEqual([]);
      // A vote's key, or one entry past the poll's old generation in the key index.
      expect(rows, query).toBeLessThanOrEqual(5);
    }
    for (const { plan } of deletes) {
      expect(plan).toEqual(["SEARCH poll_votes USING INTEGER PRIMARY KEY (rowid=?)"]);
    }
  }, 60_000);
});

describe("a suspension's report resolution with stale statistics (RES-7)", () => {
  const resolve = writeOperation<{ target: string }, unknown>((db, { target }) =>
    resolveSuspensionReports(db, target, "999999999999999999", "0", null, "0", 100, AT),
  );

  it("stamps each frozen report by key, other accounts' reports grown after ANALYZE", async () => {
    const h = await community(["alice"]);
    const targets = [await remoteAccount(h.store, "one"), await remoteAccount(h.store, "two")];
    for (const target of targets) {
      await sql(
        h.store,
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 2)
				INSERT INTO reports (account_id, target_account_id, uri, created_at)
				SELECT ?1, ?2, 'https://r.example/' || ?2 || '/' || i, ?3 FROM n`,
        h.users.alice.id,
        target,
        AT,
      );
    }
    const other = await remoteAccount(h.store, "other");
    const { before, after } = await staleStatistics(h, {
      capture: (phase) =>
        plannedRun(h, /^\s*UPDATE reports/, resolve, { target: targets[phase === "before" ? 0 : 1]! }),
      grow: () =>
        sql(
          h.store,
          `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 20000 - 1)
					INSERT INTO reports (account_id, target_account_id, uri, created_at)
					SELECT ?1, ?2, 'https://r.example/other/' || i, ?3 FROM n`,
          h.users.alice.id,
          other,
          AT,
        ),
    });
    expect(after.result).toMatchObject({ read: 3, resolved: 3 });
    expect(before.result).toMatchObject({ read: 3, resolved: 3 });
    expect(
      await sql(h.store, "SELECT count(*) AS n FROM reports WHERE action_taken_at IS NOT NULL AND last_action_id = 0"),
    ).toEqual([{ n: 6 }]);
    expect(after.plans).toHaveLength(3);
    for (const [i, { plan, rows }] of after.plans.entries()) {
      expect(plan).toEqual(["SEARCH reports USING INTEGER PRIMARY KEY (rowid=?)"]);
      expect(rows).toBe(before.plans[i]!.rows);
    }
  }, 60_000);
});

describe("report ids past 2^53 through both suspension jobs (VIS-29)", () => {
  // 2 * REPORT_ROUND + 6 reports of `target` with ids from below 2^53 up, so each round's last report and the bound are
  // past it and odd: as JS numbers 9007199254740995 and 9007199254741095 round up (the next report skipped) and the
  // bound 9007199254741101 rounds down (the newest left out). Every seventh is last stamped after the suspension
  // (fence-excluded).
  const BASE = 9007199254740896n;
  const COUNT = 2 * REPORT_ROUND + 6;
  async function reportsOf(w: World, target: string) {
    await sql(
      w.h.store,
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?4 - 1)
			INSERT INTO reports (id, account_id, target_account_id, uri, created_at, last_action_id)
			SELECT CAST(?3 AS INTEGER) + i, ?1, ?2, 'https://r.example/big/' || i, ?5, CASE WHEN i % 7 = 3 THEN 999999999 END
			FROM n`,
      w.bob.id,
      target,
      String(BASE),
      COUNT,
      AT,
    );
  }
  // Each report as [id, resolved], in id order, by its decimal id.
  const resolved = (w: World, target: string) =>
    sql<{ id: string; resolved: number }>(
      w.h.store,
      `SELECT CAST(id AS TEXT) AS id, action_taken_at IS NOT NULL AS resolved FROM reports
			WHERE target_account_id = ? ORDER BY reports.id`,
      target,
    );
  const expected = Array.from({ length: COUNT }, (_, i) => ({
    id: String(BASE + BigInt(i)),
    resolved: i % 7 === 3 ? 0 : 1,
  }));

  // The jobs a round at a time, each in its own transaction, to their end: the report ids each round read.
  async function run(w: World, round: (db: Db, after: string) => { id: string } | null): Promise<string[]> {
    const read: string[] = [];
    for (let after = "0", i = 0; ; i++) {
      expect(i).toBeLessThan(1_000);
      const ran = await runInDurableObject(w.h.store, (_instance, state) => {
        const sql = observedSql(state.storage.sql, (rows, query) => {
          if (query.includes("FROM reports INDEXED BY reports_target_state")) {
            read.push(...rows.map((row) => row.id as string));
          }
        });
        return state.storage.transactionSync(() =>
          round(new Db(sql, (fn) => state.storage.transactionSync(fn)), after),
        );
      });
      if (ran === null) {
        return read;
      }
      after = ran.id;
    }
  }

  it("resolves a local account's frozen reports, each read once", async () => {
    const w = await world();
    await reportsOf(w, w.alice.id);
    expect((await act(w, w.alice.id, { type: "suspend" })).status).toBe(200);
    expect(await run(w, (db, after) => moderationRound(db, NOW, after))).toEqual(expected.map((r) => r.id));
    expect(await resolved(w, w.alice.id)).toEqual(expected);
  }, 60_000);

  it("resolves a remote account's frozen reports, each read once", async () => {
    const w = await world();
    const carol = await remoteAccount(w.h.store, "carol");
    await reportsOf(w, carol);
    expect((await act(w, carol, { type: "suspend" })).status).toBe(200);
    expect(await run(w, (db, after) => remoteModerationRound(db, NOW, after))).toEqual(expected.map((r) => r.id));
    expect(await resolved(w, carol)).toEqual(expected);
  }, 60_000);
});

// RES-7 witness of a suspension's followers round beside main's statement (#1724, test/plan-witness.ts): the round
// reads its page through reachFollowerInboxes, which judges each inbox in SQL (audience.ts reachInboxSql), where main's
// reachFollowers read the inbox whole, by an unpinned join. main's statement is its literal baseline, by its audited
// identity, and returns main's rows once both sides are read as the round reads them: each follow's id (the cursor) and
// its inbox, none for a local follower (main's domain) or an inbox outside the rule (main's value, the rewrite's NULL).
// Each page reads no more rows than main's under the plan audit's singleton statistics and after ANALYZE, and stays
// flat as each population grows apart, each counted by its own predicate: alice's own followers (the page's key, read
// a LIMIT at a time), the followers of the accounts on either side of her id, and remote accounts that follow no one.
// The world holds import-shaped followers beside 4,096-byte inboxes: a local follower, inboxes outside the rule (past
// it, a NUL inside, a BLOB, empty, none, a shared inbox past it beside a valid personal one), two sharing one inbox,
// and a pending request. No other statement may run.
describe("a suspension's followers round beside main's (#1724, RES-7)", () => {
  const ALICE = "600000000000000001";
  const LOW = "500000000000000001";
  const HIGH = "700000000000000001";
  const PAGE = 10;
  const V = "COALESCE(NULLIF(a.shared_inbox_url, ''), a.inbox_url)";
  const MAIN = `SELECT CAST(f.id AS TEXT) AS id, a.domain, ${V} AS inbox FROM main.follows f INDEXED BY follows_target
		JOIN main.accounts a ON a.id = f.account_id
		WHERE f.target_account_id = ?1 AND f.state = 'accepted' AND f.id > CAST(?2 AS INTEGER) AND f.id <= CAST(?3 AS INTEGER)
		ORDER BY f.id LIMIT ?4`;
  const MINE = `SELECT CAST(w.id AS TEXT) AS id, CASE WHEN a.domain IS NOT NULL AND typeof(${V}) = 'text' AND length(CAST(${V} AS BLOB)) BETWEEN 1 AND ?5 AND instr(CAST(${V} AS BLOB), x'00') = 0 THEN ${V} END AS inbox FROM (SELECT f.id, f.account_id FROM main.follows f INDEXED BY follows_target WHERE f.target_account_id = ?1 AND f.state = 'accepted' AND f.id > CAST(?2 AS INTEGER) AND f.id <= CAST(?3 AS INTEGER) ORDER BY f.id LIMIT ?4) w LEFT JOIN main.accounts a INDEXED BY sqlite_autoindex_accounts_1 ON a.id = w.account_id ORDER BY w.id`;
  const ID = "faf0592983e05942";
  // An inbox the round stages: TEXT of 1 to REACH_INBOX_BYTES UTF-8 bytes without NUL (the world holds no malformed
  // UTF-8, whose decoded length is not its raw length; the suspension witness in admin-suspension.test.ts holds one).
  const admitted = (inbox: SqlStorageValue) =>
    typeof inbox === "string" &&
    inbox.length > 0 &&
    !inbox.includes("\0") &&
    new TextEncoder().encode(inbox).length <= REACH_INBOX_BYTES;
  const WITNESS = new PlanWitness(
    {
      [ID]: {
        sql: MAIN,
        text: normalized(MINE),
        params: (mine) => mine.slice(0, 4),
        result: {
          main: (rows) =>
            rows.map((row) => ({ id: row.id, inbox: row.domain !== null && admitted(row.inbox!) ? row.inbox : null })),
          mine: (rows) => rows,
        },
      },
    },
    undefined,
    [],
  );

  type Shape = { own: number; others: number; idle: number };
  const BASE: Shape = { own: 40, others: 40, idle: 40 };
  const POPULATIONS = {
    own: `SELECT count(*) AS n FROM follows WHERE target_account_id = '${ALICE}'`,
    others: `SELECT count(*) AS n FROM follows WHERE target_account_id IN ('${LOW}', '${HIGH}')`,
    idle: "SELECT count(*) AS n FROM accounts WHERE id GLOB '64*'",
  };

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

  function remote(sql: SqlStorage, id: bigint, host: string, shared: SqlStorageValue) {
    sql.exec(
      `INSERT INTO accounts (id, uri, username, domain, inbox_url, shared_inbox_url)
			VALUES (?1, 'https://' || ?2 || '/users/u' || ?1, 'u' || ?1, ?2, 'https://' || ?2 || '/users/u' || ?1 || '/inbox', ?3)`,
      String(id),
      host,
      shared,
    );
    return String(id);
  }

  const follow = (sql: SqlStorage, account: string, target: string, state = "accepted") =>
    sql.exec(
      "INSERT INTO follows (account_id, target_account_id, state, created_at) VALUES (?, ?, ?, ?)",
      account,
      target,
      state,
      AT,
    );
  const sized = (host: string, bytes: number) => `https://${host}/` + "a".repeat(bytes - `https://${host}/`.length);

  // The world of `shape`; the page's cursors: alice's highest follow id (the bound) and her fifth.
  function shaped(sql: SqlStorage, shape: Shape): { bound: string; after: string } {
    local(sql, LOW, "low");
    local(sql, ALICE, "alice");
    local(sql, HIGH, "high");
    local(sql, "600000000000000002", "bob");
    follow(sql, "600000000000000002", ALICE);
    const max = sized("max.example", REACH_INBOX_BYTES);
    for (let i = 0; i < 6; i++) {
      follow(sql, remote(sql, 610000000000000000n + BigInt(i), `m${i}.example`, max), ALICE);
    }
    const outside: [string, SqlStorageValue[]][] = [
      ["shared_inbox_url = ?", [sized("over.example", REACH_INBOX_BYTES + 1)]],
      ["shared_inbox_url = ? || char(0) || 'box'", ["https://nul.example/in"]],
      ["shared_inbox_url = CAST(? AS BLOB)", ["https://blob.example/inbox"]],
      ["shared_inbox_url = '', inbox_url = ''", []],
      ["shared_inbox_url = NULL, inbox_url = NULL", []],
    ];
    for (const [i, [assign, params]] of outside.entries()) {
      const id = remote(sql, 611000000000000000n + BigInt(i), `x${i}.example`, null);
      sql.exec(`UPDATE accounts SET ${assign} WHERE id = ?`, ...params, id);
      follow(sql, id, ALICE);
    }
    follow(sql, remote(sql, 612000000000000000n, "p.example", null), ALICE, "pending");
    for (let i = 0; i < shape.own; i++) {
      follow(
        sql,
        remote(sql, 620000000000000000n + BigInt(i), `f${i % 7}.example`, `https://f${i % 7}.example/inbox`),
        ALICE,
      );
    }
    for (let i = 0; i < shape.others; i++) {
      const id = remote(sql, 630000000000000000n + BigInt(i), `o${i % 7}.example`, `https://o${i % 7}.example/inbox`);
      follow(sql, id, i % 2 === 0 ? LOW : HIGH);
    }
    for (let i = 0; i < shape.idle; i++) {
      remote(sql, 640000000000000000n + BigInt(i), `i${i % 7}.example`, null);
    }
    const ids = sql
      .exec<{ key: string }>(
        "SELECT CAST(id AS TEXT) AS key FROM follows WHERE target_account_id = ? ORDER BY follows.id",
        ALICE,
      )
      .toArray()
      .map((row) => row.key);
    return { bound: ids.at(-1)!, after: ids[4]! };
  }

  // The flow: a page from the start, which holds the import-shaped followers, and one from alice's fifth follow.
  const EXPECTED = [ID, ID];
  const flow = (sql: SqlStorage, cursors: { bound: string; after: string }) => {
    const db = new Db(sql);
    return [
      reachFollowerInboxes(db, ALICE, "0", cursors.bound, PAGE, REACH_INBOX_BYTES),
      reachFollowerInboxes(db, ALICE, cursors.after, cursors.bound, PAGE, REACH_INBOX_BYTES),
    ];
  };

  async function measured(statistics: Statistics, shape: Shape): Promise<Run> {
    const store = await migratedStore();
    return runInDurableObject(store, (_instance, state) => {
      const cursors = shaped(state.storage.sql, shape);
      return WITNESS.measure(state, {
        statistics,
        expected: EXPECTED,
        populations: POPULATIONS,
        run: (sql) => flow(sql, cursors),
      });
    });
  }

  it("is main's audited statement", async () => {
    await WITNESS.expectAudited();
  });

  it.each(STATISTICS)("%s statistics: main's rows, read in no more rows", async (statistics) => {
    const run = await measured(statistics, BASE);
    expectBeside(statistics, run, { singletonRows: true });
    // The first page holds every import-shaped follower: only the 4,096-byte inboxes are read.
    const [first] = run.result as { id: string; inbox: string | null }[][];
    expect(first!.map((row) => row.inbox?.length ?? null)).toEqual([
      null,
      ...Array.from({ length: 6 }, () => REACH_INBOX_BYTES),
      null,
      null,
      null,
    ]);
  });

  it.each(
    STATISTICS.flatMap((statistics) => (Object.keys(BASE) as (keyof Shape)[]).map((key) => [statistics, key] as const)),
  )("%s statistics: rows read stay flat as %s grow", async (statistics, key) => {
    const base = await measured(statistics, BASE);
    const grown = await measured(statistics, { ...BASE, [key]: 400 });
    expectBeside(statistics, grown, { singletonRows: true });
    expectGrowth(base, grown, { populations: [key], perSide: {} });
  });
});

// RES-7 witness of a write or end round's staged rows (#1724, suspension.ts consumeStaged): the read and the delete
// walk moderation_reach's key (job_id, inbox) from the job's own id, with no sort and no scan, and read as many rows
// with the job's own staged rows grown tenfold and another job's grown, statistics taken before either grew. The read
// reads its REACH_ROUND rows; the delete walks REACH_ROUND entries to its boundary (the OFFSET subquery), then reads
// the REACH_ROUND rows it deletes twice (SQLite collects the keys of a delete whose WHERE reads its own table, then
// deletes each by key) and the entry past them.
describe("a write round's staged rows with stale statistics (#1724, RES-7)", () => {
  const stageRows = (store: StoreStub, job: string, from: number, count: number) =>
    sql(
      store,
      `WITH RECURSIVE n(i) AS (SELECT ?2 UNION ALL SELECT i + 1 FROM n WHERE i < ?2 + ?3 - 1)
			INSERT INTO moderation_reach (job_id, inbox)
			SELECT CAST(?1 AS INTEGER), 'https://s' || printf('%07d', i) || '.example/inbox' FROM n`,
      job,
      from,
      count,
    );

  it("seeks the job's own rows by key, as many with its own and another job's rows grown", async () => {
    const w = await world();
    for (const account of [w.alice.id, w.bob.id]) {
      expect((await act(w, account, { type: "suspend" })).status).toBe(200);
    }
    const jobs = await sql<{ id: string }>(
      w.h.store,
      "SELECT CAST(id AS TEXT) AS id FROM moderation_jobs WHERE kind = 'suspension' ORDER BY id",
    );
    const [own, other] = jobs.map((job) => job.id) as [string, string];
    await sql(w.h.store, "UPDATE moderation_jobs SET phase = 'write', state = '{}' WHERE kind = 'suspension'");
    await stageRows(w.h.store, own, 0, 3);
    await stageRows(w.h.store, other, 0, 3);
    const round = writeOperation<{ after: string }, unknown>((db, { after }) => moderationRound(db, NOW, after));
    const after = String(BigInt(own) - 1n);
    const { before, after: grown } = await staleStatistics(w.h, {
      settle: async () => {
        await stageRows(w.h.store, own, 3, 600);
        await stageRows(w.h.store, other, 3, 3_000);
      },
      capture: () => plannedRun(w.h, /FROM moderation_reach/, round, { after }, true),
      grow: async () => {
        await stageRows(w.h.store, own, 1_000, 6_000);
        await stageRows(w.h.store, other, 10_000, 30_000);
      },
    });
    for (const { plans } of [before, grown]) {
      expect(plans.map((p) => p.query.trimStart().split(/\s/)[0])).toEqual(["SELECT", "DELETE"]);
      for (const { query, plan } of plans) {
        expect(scansOf(plan, ["moderation_reach"]), query).toEqual([]);
        expect(plan.join(" | "), query).not.toContain("TEMP B-TREE");
        expect(plan.join(" | "), query).toContain("SEARCH moderation_reach USING PRIMARY KEY (job_id=?)");
      }
    }
    // The rows read stay flat: the job's own rows grew tenfold, the other job's tenfold.
    expect(grown.plans.map((p) => p.rows)).toEqual(before.plans.map((p) => p.rows));
    const [read, deleted] = grown.plans.map((p) => p.rows) as [number, number];
    expect(read).toBe(REACH_ROUND);
    expect(deleted).toBe(3 * REACH_ROUND + 1);
    expect(
      await sql(w.h.store, "SELECT count(*) AS n FROM moderation_reach WHERE job_id = CAST(? AS INTEGER)", own),
    ).toEqual([{ n: 3 + 600 + 6_000 - 2 * REACH_ROUND }]);
  }, 120_000);
});
