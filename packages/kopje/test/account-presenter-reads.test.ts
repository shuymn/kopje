import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import {
  accountsOf,
  credentialAccount,
  FOLLOW_REQUESTS_COUNT,
  getAccount,
  getAccounts,
  listFollowRequests,
  listFollows,
  partialAccountsOf,
} from "../src/domain/accounts";
import { MAX_BLOCK_LABELS } from "../src/domain/audience";
import { accountEndorsementsWithin } from "../src/domain/endorsements";
import { readWindow } from "../src/domain/windows";
import { sha256Hex } from "../src/security/tokens";
import { sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { blockDomainIn } from "./domain-block-helpers";
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
// on a Store of two accounts and one follow (RES-7). What grows is accounts, local_accounts and follows only (300
// remote accounts, 300 local ones with their local rows, 300 follows among them): the witness covers the access paths
// to those tables (no scan of `a`, `l` or `f`, a key seek of `a` and `l`, a rowid seek of `f`), not the status, field
// and cache tables the captured statements also read. Two pins change no plan here and no revert of them fails: the
// `a INDEXED BY` of windowAccountIds and of the follow lists' window join, where the planner already seeks `a` as the
// inner side of the CROSS JOIN; they keep the shape of their siblings.

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
      // Every read presents accounts with their local rows, so each seeks one by its key.
      expect([
        name,
        details.some((d) =>
          /^SEARCH l USING (COVERING )?INDEX sqlite_autoindex_local_accounts_1 \(account_id=\?\)/.test(d),
        ),
      ]).toEqual([name, true]);
      expect([name, read.plans.map((statement) => statement.rows)]).toEqual([
        name,
        before[name]!.plans.map((statement) => statement.rows),
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

describe("the credential account's follow request count with stale statistics (RES-7)", () => {
  it("reads a window of the viewer's newest requests, flat past its cap, each requester's coverage walked to its end", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    const carol = await remoteAccount(h.store, "carol");
    await sql(
      h.store,
      "INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'pending')",
      carol,
      bob.id,
    );
    let next = 0;
    // `n` new remote requesters of `target`, newest last, every one available: its domain of MAX_BLOCK_LABELS labels
    // (the deepest a block's walk seeks) and its actor id on another host of as many, so that both keys are walked.
    const labels = Array.from({ length: MAX_BLOCK_LABELS - 2 }, (_, i) => `l${i + 1}`).join(".");
    expect(`${labels}.r1.example`.split(".")).toHaveLength(MAX_BLOCK_LABELS);
    const requests = async (n: number, target: string) => {
      const base = String(400000000000000000n + BigInt(next));
      next += n;
      await sql(
        h.store,
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO accounts (id, uri, username, domain)
				SELECT CAST(?2 + i AS TEXT), 'https://' || ?3 || '.h' || (?2 + i) || '.example/users/u', 'u' || (?2 + i),
					?3 || '.r' || (?2 + i) || '.example' FROM n`,
        n,
        base,
        labels,
      );
      await sql(
        h.store,
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO follows (account_id, target_account_id, state) SELECT CAST(?2 + i AS TEXT), ?3, 'pending' FROM n`,
        n,
        base,
        target,
      );
    };
    const capture = () =>
      runInDurableObject(h.store, (_instance, state) => {
        const plans: PlannedStatement[] = [];
        const account = credentialAccount(
          new Db(plannedSql(state.storage.sql, /follow_requests_count/, plans)),
          alice.id,
          present,
        );
        return { count: account?.source.follow_requests_count, plans };
      });
    const { before, after } = await staleStatistics(h, {
      settle: async () => {
        // After ANALYZE: 130 requests, more than the window, and suspend blocks that match none of their keys, so the
        // guard is on and every walk runs to its end.
        await requests(130, alice.id);
        await runInDurableObject(h.store, (_instance, state) => {
          for (let k = 0; k < 20; k++) {
            blockDomainIn(state.storage.sql, `elsewhere${k}.example`);
          }
        });
      },
      capture,
      // The viewer's own key grows to 1,000 requests, another account's beside it.
      grow: async () => {
        await requests(870, alice.id);
        await requests(500, bob.id);
      },
    });
    const pending = await sql<{ n: number }>(
      h.store,
      "SELECT COUNT(*) AS n FROM follows WHERE target_account_id = ? AND state = 'pending'",
      alice.id,
    );
    expect(pending[0]!.n).toBe(1000);
    // Every requester is available, so the window's 120 count and the answer is the cap.
    expect(readWindow(FOLLOW_REQUESTS_COUNT)).toBe(120);
    expect([before.count, after.count]).toEqual([FOLLOW_REQUESTS_COUNT, FOLLOW_REQUESTS_COUNT]);
    expect(before.plans).toHaveLength(1);
    expect(after.plans).toHaveLength(1);
    const { plan, rows } = after.plans[0]!;
    // The read is flat past the window: 130 and 1,000 requests read the same rows.
    expect(rows).toBe(before.plans[0]!.rows);
    // The ceiling, at its caps: the viewer's local row, then per candidate of the window its follow row, its account
    // row and local row, and for each of its two keys the walk's and the match's seek of each suffix of 2 to
    // MAX_BLOCK_LABELS labels; and the statement's one seek of the suspend blocks' index.
    const window = readWindow(FOLLOW_REQUESTS_COUNT);
    const ceiling = 1 + window * (1 + 2 + 2 * (MAX_BLOCK_LABELS - 1) * 2) + 1;
    // The figure docs/threat-model.md (RES-7) states.
    expect(ceiling).toBe(3722);
    expect(rows).toBeLessThanOrEqual(ceiling);
    // The walks ran: past the window's row seeks, each candidate read a seek per suffix of both keys.
    expect(rows).toBeGreaterThanOrEqual(window * 2 * (MAX_BLOCK_LABELS - 1));
    // follows by follows_target, accounts and local rows by key, the blocks by their domain index; no scan, automatic
    // index or Bloom filter. The suspend blocks' guard reads its partial index, which holds the suspend blocks only.
    expect(plan).toContainEqual("SEARCH f USING INDEX follows_target (target_account_id=? AND state=?)");
    expect(plan).toContainEqual("SEARCH a USING INDEX sqlite_autoindex_accounts_1 (id=?)");
    expect(plan).toContainEqual(expect.stringMatching(/^SEARCH l USING INDEX sqlite_autoindex_local_accounts_1 /));
    const blocks = plan.filter((detail) => /^(SEARCH|SCAN) (pn|pr|main\.instance_domain_blocks)\b/.test(detail));
    expect(blocks).toEqual([
      "SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      expect.stringMatching(/^SEARCH pn USING .*INDEX sqlite_autoindex_instance_domain_blocks_1 \(domain=\?\)$/),
      expect.stringMatching(
        /^SEARCH pr USING .*INDEX sqlite_autoindex_instance_domain_blocks_1 \(domain=\?\) LEFT-JOIN$/,
      ),
    ]);
    expect(scansOf(plan, ["f", "a", "l", "pn", "pr", "follows", "accounts", "local_accounts"])).toEqual([]);
    expect(plan.filter((detail) => /AUTOMATIC|BLOOM/.test(detail))).toEqual([]);
  }, 120_000);
});
