import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import {
  accountsOf,
  credentialAccount,
  getAccount,
  getAccounts,
  listFollowRequests,
  listFollows,
  partialAccountsOf,
} from "../src/domain/accounts";
import { accountEndorsementsWithin } from "../src/domain/endorsements";
import { sha256Hex } from "../src/security/tokens";
import { sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import {
  localAccounts,
  type PlannedStatement,
  plannedSql,
  remoteAccounts,
  scansOf,
  staleStatistics,
} from "./read-helpers";
import { community, remoteAccount } from "./status-helpers";

// The account presenter's statements and their siblings that read accounts `a`, with their local rows `l`, by key
// (accounts.ts ACCOUNT_FROM, LOCAL_ROW_JOIN), and the follow lists' window joins (followEdgeSql), with statistics taken
// on a Store of two accounts and one follow, then 600 accounts (half of them local) and 300 follows added (RES-7).

const present = { origin: "https://kopje.test" };

describe("account presentation with stale statistics (RES-7)", () => {
  it("seeks each account, its local row and each follow by key, reading as many rows after the growth", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const carol = await remoteAccount(h.store, "carol");
    await sql(
      h.store,
      "INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
      carol,
      alice.id,
    );
    const tokenHash = await sha256Hex(alice.token);
    let bob = "";
    const settle = async () => {
      // After ANALYZE: a pending request and an endorsement, so their lists have a row to show.
      bob = await remoteAccount(h.store, "bob");
      await sql(
        h.store,
        "INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'pending')",
        bob,
        alice.id,
      );
      await sql(h.store, "INSERT INTO account_pins (account_id, target_account_id) VALUES (?, ?)", alice.id, carol);
    };
    const capture = () =>
      runInDurableObject(h.store, (_instance, state) => {
        const transaction = <T>(fn: () => T): T => state.storage.transactionSync(fn);
        const reads: Record<string, { plans: PlannedStatement[]; result: unknown }> = {};
        const read = (name: string, run: (sql: SqlStorage) => unknown) => {
          const plans: PlannedStatement[] = [];
          reads[name] = { result: run(plannedSql(state.storage.sql, /\baccounts a\b/, plans)), plans };
        };
        read("getAccount", (s) => getAccount.run(s, { id: carol, present }, transaction));
        read("credentialAccount", (s) => credentialAccount(new Db(s), alice.id, present));
        read("getAccounts", (s) => getAccounts.run(s, { ids: [alice.id, carol], present }, transaction));
        read("accountsOf", (s) => [...accountsOf(new Db(s), [alice.id, carol], present)]);
        read("partialAccountsOf", (s) => [...partialAccountsOf(new Db(s), [alice.id, carol], present)]);
        read("endorsements", (s) => accountEndorsementsWithin(new Db(s), alice.id, { page: { limit: 40 }, present }));
        for (const direction of ["followers", "following"] as const) {
          read(direction, (s) =>
            listFollows.run(
              s,
              {
                account: direction === "followers" ? alice.id : carol,
                direction,
                page: { limit: 40 },
                present,
                credential: null,
                now: NOW,
              },
              transaction,
            ),
          );
        }
        read("followRequests", (s) =>
          listFollowRequests.run(
            s,
            { credential: { tokenHash, scope: "read:follows", now: NOW }, page: { limit: 40 }, present },
            transaction,
          ),
        );
        return reads;
      });
    const { before, after } = await staleStatistics(h, {
      settle,
      capture,
      grow: async () => {
        await remoteAccounts(h, 10, 30);
        await localAccounts(h, 300);
        await sql(
          h.store,
          `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 299)
					INSERT INTO follows (account_id, target_account_id, state)
					SELECT CAST(600000000000000000 + i AS TEXT), CAST(500000000000000000 + i AS TEXT), 'accepted' FROM n`,
        );
      },
    });
    const shown = (name: string) => JSON.stringify(after[name]!.result);
    // Each read reached its account rows: the lists show their one member.
    for (const [name, id] of [
      ["getAccount", carol],
      ["credentialAccount", alice.id],
      ["getAccounts", carol],
      ["accountsOf", carol],
      ["partialAccountsOf", carol],
      ["endorsements", carol],
      ["followers", carol],
      ["following", alice.id],
      ["followRequests", bob],
    ] as const) {
      expect([name, shown(name).includes(`"id":"${id}"`)]).toEqual([name, true]);
    }
    for (const [name, read] of Object.entries(after)) {
      expect([name, read.result]).toEqual([name, before[name]!.result]);
      expect([name, read.plans.length]).toEqual([name, before[name]!.plans.length]);
      const details = read.plans.flatMap((statement) => statement.plan);
      expect([name, read.plans.flatMap((statement) => scansOf(statement.plan, ["a", "l", "f"]))]).toEqual([name, []]);
      expect([
        name,
        details.some((d) => /^SEARCH a USING (COVERING )?INDEX sqlite_autoindex_accounts_1 \(id=\?\)$/.test(d)),
      ]).toEqual([name, true]);
      expect([name, read.plans.map((statement) => statement.rows)]).toEqual([
        name,
        before[name]!.plans.map((statement) => statement.rows),
      ]);
    }
    // The reads that use the joined local row seek it by its key (a statement whose filter reads no column of it, as
    // the endorsements' window, drops the join).
    for (const name of [
      "getAccount",
      "credentialAccount",
      "getAccounts",
      "accountsOf",
      "partialAccountsOf",
      "endorsements",
      "followers",
      "following",
      "followRequests",
    ]) {
      expect([name, after[name]!.plans.flatMap((statement) => statement.plan)]).toEqual([
        name,
        expect.arrayContaining([
          expect.stringMatching(
            /^SEARCH l USING (COVERING )?INDEX sqlite_autoindex_local_accounts_1 \(account_id=\?\)/,
          ),
        ]),
      ]);
    }
    // The follow lists' window joins seek each follow by its rowid.
    for (const name of ["followers", "following", "followRequests"]) {
      expect([name, after[name]!.plans.flatMap((statement) => statement.plan)]).toEqual([
        name,
        expect.arrayContaining(["SEARCH f USING INTEGER PRIMARY KEY (rowid=?)"]),
      ]);
    }
  }, 120_000);
});
