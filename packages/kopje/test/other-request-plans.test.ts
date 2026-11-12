import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { insertLocalAccount } from "../src/domain/setup";
import { tagHistory, tagKey } from "../src/domain/tags";
import { NOW } from "./app-helpers";
import { migratedStore } from "./helpers";
import { singletonStatistics } from "./plan-audit-store";
import { type PlannedStatement, plannedSql } from "./read-helpers";

// RES-7 witnesses of two scans the plan audit lists that read nothing (test/plan-audit-entries.ts, their reasons): each
// statement's plan names the scan, and its rows read stay the same as the scanned table grows, under the plan audit's
// singleton statistics and after ANALYZE, taken once every population exists. Each population is counted by its own
// predicate and asserted to grow.

const STATISTICS = ["singleton", "analyzed"] as const;
const FEW = 5;
const MANY = 300;
const AUTHOR = "500000000000000001";
const ALICE = "600000000000000001";
const ISO = new Date(NOW).toISOString();
// A status id of NOW (domain/ids.ts), so its tag is within the history's seven days.
const STATUS = String(BigInt(NOW) << 16n);

type Run = { populations: Record<string, number>; plans: PlannedStatement[]; result: unknown };

async function measured(
  statistics: (typeof STATISTICS)[number],
  build: (sql: SqlStorage) => void,
  populations: Record<string, string>,
  pattern: RegExp,
  run: (db: Db) => unknown,
): Promise<Run> {
  const store = await migratedStore();
  return runInDurableObject(store, (_instance, state) => {
    const sql = state.storage.sql;
    build(sql);
    const counted = Object.fromEntries(
      Object.entries(populations).map(([name, count]) => [name, sql.exec<{ n: number }>(count).one().n]),
    );
    if (statistics === "singleton") {
      singletonStatistics(sql);
    } else {
      sql.exec("ANALYZE");
    }
    const plans: PlannedStatement[] = [];
    const result = state.storage.transactionSync(() => run(new Db(plannedSql(sql, pattern, plans))));
    return { populations: counted, plans, result };
  });
}

function grows(few: Run, many: Run) {
  for (const name of Object.keys(few.populations)) {
    expect(many.populations[name]!, name).toBeGreaterThan(few.populations[name]!);
  }
}

// A remote author's public status tagged #tag, and `n` remote accounts following the author.
function tagged(sql: SqlStorage, n: number) {
  sql.exec(
    "INSERT INTO accounts (id, uri, username, domain) VALUES (?, ?, 'author', 'r.example')",
    AUTHOR,
    "https://r.example/author",
  );
  sql.exec(
    `WITH RECURSIVE i(k) AS (SELECT 0 UNION ALL SELECT k + 1 FROM i WHERE k < ?1 - 1)
		INSERT INTO accounts (id, uri, username, domain)
		SELECT CAST(510000000000000000 + k AS TEXT), 'https://f.example/u/' || k, 'u' || k, 'f.example' FROM i`,
    n,
  );
  sql.exec(
    `INSERT INTO follows (account_id, target_account_id, state)
		SELECT id, ?1, 'accepted' FROM accounts WHERE domain = 'f.example'`,
    AUTHOR,
  );
  sql.exec(
    "INSERT INTO statuses (id, uri, account_id, visibility, published_at) VALUES (?, ?, ?, 'public', ?)",
    STATUS,
    "https://r.example/s/1",
    AUTHOR,
    ISO,
  );
  sql.exec("INSERT INTO status_tags (status_id, name, public) VALUES (?, 'tag', 1)", STATUS);
}

describe("a hashtag's history beside the follows (RES-7)", () => {
  it.each(STATISTICS.flatMap((statistics) => (["full", 20] as const).map((rows) => [statistics, rows] as const)))(
    "%s statistics, rows %s: the anonymous rule's follow probe reads no follow",
    async (statistics, rows) => {
      const run = (n: number) =>
        measured(
          statistics,
          (sql) => tagged(sql, n),
          { follows: `SELECT count(*) AS n FROM follows WHERE target_account_id = '${AUTHOR}' AND state = 'accepted'` },
          /GROUP BY day/,
          (db) => tagHistory(db, tagKey("tag"), NOW, rows),
        );
      const few = await run(FEW);
      const many = await run(MANY);
      grows(few, many);
      for (const measuredRun of [few, many]) {
        expect(measuredRun.plans).toHaveLength(1);
        expect(measuredRun.plans[0]!.plan).toContain("SCAN fo USING COVERING INDEX follows_accepted");
        expect((measuredRun.result as { uses: string }[])[0]).toMatchObject({ uses: "1", accounts: "1" });
      }
      expect(many.plans[0]!.rows).toBe(few.plans[0]!.rows);
    },
  );
});

// A local account with `n` statuses each quoted with its fetch_as (quotes.fetch_as references local_accounts, with no
// index), and `n` announcements each with its reaction (announcement_reactions.account_id, not the index's first key).
function children(sql: SqlStorage, n: number) {
  sql.exec("INSERT INTO accounts (id, uri, username) VALUES (?, 'https://kopje.test/ap/users/alice', 'alice')", ALICE);
  sql.exec(
    `INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, 'alice@example.com', X'00', X'00', 'k')`,
    ALICE,
  );
  sql.exec(
    `WITH RECURSIVE i(k) AS (SELECT 0 UNION ALL SELECT k + 1 FROM i WHERE k < ?1 - 1)
		INSERT INTO statuses (id, uri, account_id, visibility, published_at)
		SELECT CAST(520000000000000000 + k AS TEXT), 'https://kopje.test/ap/o/' || k, ?2, 'public', ?3 FROM i`,
    n,
    ALICE,
    ISO,
  );
  sql.exec(
    `INSERT INTO quotes (status_id, state, fetch_as, updated_at)
		SELECT id, 'deleted', ?1, ?2 FROM statuses WHERE account_id = ?1`,
    ALICE,
    ISO,
  );
  sql.exec(
    `WITH RECURSIVE i(k) AS (SELECT 0 UNION ALL SELECT k + 1 FROM i WHERE k < ?1 - 1)
		INSERT INTO announcements (id, text, created_at, updated_at)
		SELECT CAST(530000000000000000 + k AS TEXT), 'a', ?2, ?2 FROM i`,
    n,
    ISO,
  );
  sql.exec(
    "INSERT INTO announcement_reactions (announcement_id, account_id, name) SELECT id, ?1, 'é' FROM announcements",
    ALICE,
  );
}

describe("a new local account beside the rows that reference local accounts (RES-7)", () => {
  it.each(STATISTICS)("%s statistics: the child-key lookups read none of them", async (statistics) => {
    const run = (n: number) =>
      measured(
        statistics,
        (sql) => children(sql, n),
        {
          quotes: `SELECT count(*) AS n FROM quotes WHERE fetch_as = '${ALICE}'`,
          reactions: `SELECT count(*) AS n FROM announcement_reactions WHERE account_id = '${ALICE}'`,
        },
        /INSERT INTO local_accounts/,
        (db) =>
          insertLocalAccount(db, {
            domain: "kopje.test",
            username: "newcomer",
            email: "newcomer@example.com",
            key: { privkey: new Uint8Array([1]), salt: new Uint8Array([2]), pubkey: "k" },
            now: NOW,
          }),
      );
    const few = await run(FEW);
    const many = await run(MANY);
    grows(few, many);
    for (const measuredRun of [few, many]) {
      expect(measuredRun.plans).toHaveLength(1);
      expect(measuredRun.plans[0]!.plan).toEqual(
        expect.arrayContaining([
          "SCAN quotes",
          "SCAN announcement_reactions USING COVERING INDEX announcement_reactions_name",
        ]),
      );
    }
    expect(many.plans[0]!.rows).toBe(few.plans[0]!.rows);
  });
});
