import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { hasFollowerOn, remoteReportStatusIds, reportForwardees } from "../src/domain/audience";
import { block, listMutes, previewDomainBlock } from "../src/domain/blocks";
import { reportsRejected } from "../src/domain/instance-domain-blocks";
import { reportTargetPage } from "../src/domain/reports";
import type { StoreStub } from "../src/platform/store-client";
import { NOW } from "./app-helpers";
import { migratedStore } from "./helpers";
import { ACCESS, ensureAdmin } from "./ops-helpers";
import { singletonStatistics } from "./plan-audit-store";
import { type PlannedStatement, plannedSql, scansOf } from "./read-helpers";

// RES-7 witnesses of what a block, a mute list, a domain-block preview and a report read by their keys (mutes_pair,
// notifications_natural, follows_accepted and follows_target, accounts and statuses by id, instance_domain_blocks by
// domain, a report by its rowid), under the plan audit's singleton statistics and under ANALYZE of the Store as read:
// the rows they read stay the same as their neighbours grow on both sides of their keys (local accounts whose ids and
// URIs sort below and above the viewer's, their mutes, follows, notifications, reports, statuses and mentions, and
// instance blocks of domains below and above the subject's). The walks their keys still allow (the viewer's own mutes,
// follows and followers, a status's mentions) are #1481's.

const VIEWER = "600000000000000001";
const OTHER = "600000000000000002";
const REMOTE = "550000000000000000";
const REMOTE_URI = "https://far.example/users/r";
const STATUS = "950000000000000000";
// The other local account's private status mentioning only the viewer.
const OTHER_STATUS = "950000000000000001";
const REPORT = 500_000;
const AT = new Date(NOW).toISOString();
const STATISTICS = ["singleton", "analyzed"] as const;
const FEW = 1_500;
const MANY = 3_000;

// `n` local accounts on each side of the viewer's id and URI; each mutes the remote account, follows and is followed
// by it and by the other local account, sent the viewer a follow notification and was sent one by the remote account,
// reported the remote account, and wrote a status mentioning it; and `n` instance blocks of domains on each side of
// far.example. Between the sides, the subject: the viewer and the remote account following each other, the viewer
// muting it, its follow notification to the viewer, a suspend-free block of far.example rejecting reports, the
// viewer's report of it, the viewer's private status replying to it and mentioning it, and the other local account's
// private status mentioning the viewer.
async function world(n: number): Promise<StoreStub> {
  const store = await migratedStore();
  await runInDurableObject(store, (_instance, state) => {
    const sql = state.storage.sql;
    const local = (id: string, name: string) => {
      sql.exec(
        "INSERT INTO accounts (id, uri, username) VALUES (?, ?, ?)",
        id,
        `https://kopje.test/ap/users/${name}`,
        name,
      );
      sql.exec(
        `INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, ?, X'00', X'00', 'k')`,
        id,
        `${name}@example.com`,
      );
    };
    local(VIEWER, "viewer");
    local(OTHER, "other");
    sql.exec(
      "INSERT INTO accounts (id, uri, username, domain, created_at) VALUES (?, ?, 'r', 'far.example', '2026-01-01T00:00:00.000Z')",
      REMOTE,
      REMOTE_URI,
    );
    sql.exec(
      "INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('app', 's', 'app', 'urn:ietf:wg:oauth:2.0:oob', 'read write follow')",
    );
    sql.exec(
      "INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES ('viewer', 'access', 'app', ?, 'read write follow')",
      VIEWER,
    );
    const side = (base: string, prefix: string, statuses: string, host: string) => {
      sql.exec(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO accounts (id, uri, username) SELECT CAST(?2 + i AS TEXT), 'https://kopje.test/ap/users/' || ?3 || i, ?3 || i FROM n`,
        n,
        base,
        prefix,
      );
      const range = `id >= '${base}' AND id < '${BigInt(base) + BigInt(n)}'`;
      sql.exec(
        `INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey)
				SELECT id, username || '@example.com', X'00', X'00', 'k' FROM accounts WHERE ${range}`,
      );
      sql.exec(`INSERT INTO mutes (account_id, target_account_id) SELECT id, ? FROM accounts WHERE ${range}`, REMOTE);
      for (const [follower, target] of [
        ["id", `'${REMOTE}'`],
        [`'${REMOTE}'`, "id"],
        ["id", `'${OTHER}'`],
        [`'${OTHER}'`, "id"],
      ]) {
        sql.exec(
          `INSERT INTO follows (account_id, target_account_id, state)
					SELECT ${follower}, ${target}, 'accepted' FROM accounts WHERE ${range}`,
        );
      }
      sql.exec(
        `INSERT INTO notifications (account_id, type, from_account_id) SELECT ?, 'follow', id FROM accounts WHERE ${range}`,
        VIEWER,
      );
      sql.exec(
        `INSERT INTO notifications (account_id, type, from_account_id) SELECT id, 'follow', ? FROM accounts WHERE ${range}`,
        REMOTE,
      );
      sql.exec(
        `INSERT INTO reports (account_id, target_account_id, uri, created_at)
				SELECT id, ?, uri || '#report', ? FROM accounts WHERE ${range}`,
        REMOTE,
        AT,
      );
      sql.exec(
        `INSERT INTO statuses (id, uri, account_id, visibility, published_at, in_reply_to_account_id)
				SELECT CAST(?1 + CAST(id AS INTEGER) - ?2 AS TEXT), uri || '/s', id, 'private', ?3, ?4 FROM accounts WHERE ${range}`,
        statuses,
        base,
        AT,
        REMOTE,
      );
      sql.exec(
        `INSERT INTO status_mentions (status_id, account_id)
				SELECT id, ? FROM statuses WHERE account_id IN (SELECT id FROM accounts WHERE ${range})`,
        REMOTE,
      );
      sql.exec(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO instance_domain_blocks (domain, severity, created_at, updated_at)
				SELECT ?2 || i || '.example', 'noop', ?3, ?3 FROM n`,
        n,
        host,
        AT,
      );
    };
    side("400000000000000000", "a", "930000000000000000", "a");
    for (const [follower, target] of [
      [VIEWER, REMOTE],
      [REMOTE, VIEWER],
    ]) {
      sql.exec(
        "INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
        follower,
        target,
      );
    }
    sql.exec("INSERT INTO mutes (id, account_id, target_account_id) VALUES (500000, ?, ?)", VIEWER, REMOTE);
    sql.exec("INSERT INTO notifications (account_id, type, from_account_id) VALUES (?, 'follow', ?)", VIEWER, REMOTE);
    sql.exec(
      `INSERT INTO instance_domain_blocks (domain, severity, reject_reports, created_at, updated_at)
			VALUES ('far.example', 'noop', 1, ?1, ?1)`,
      AT,
    );
    sql.exec(
      "INSERT INTO reports (id, account_id, target_account_id, uri, created_at) VALUES (?, ?, ?, 'https://kopje.test/report', ?)",
      REPORT,
      VIEWER,
      REMOTE,
      AT,
    );
    sql.exec(
      `INSERT INTO statuses (id, uri, account_id, visibility, published_at, in_reply_to_account_id)
			VALUES (?, 'https://kopje.test/ap/o/s', ?, 'private', ?, ?)`,
      STATUS,
      VIEWER,
      AT,
      REMOTE,
    );
    sql.exec("INSERT INTO status_mentions (status_id, account_id) VALUES (?, ?)", STATUS, REMOTE);
    sql.exec(
      `INSERT INTO statuses (id, uri, account_id, visibility, published_at)
			VALUES (?, 'https://kopje.test/ap/o/other', ?, 'private', ?)`,
      OTHER_STATUS,
      OTHER,
      AT,
    );
    sql.exec("INSERT INTO status_mentions (status_id, account_id) VALUES (?, ?)", OTHER_STATUS, VIEWER);
    side("700000000000000000", "z", "960000000000000000", "z");
  });
  await ensureAdmin(store);
  return store;
}

const credential = <S extends "read" | "write">(scope: S) => ({ tokenHash: "viewer", scope, now: NOW });
const transact = <T>(fn: () => T): T => fn();

type Case = {
  // The statements witnessed, and the tables (by their names in them) none of them may scan.
  pattern: RegExp;
  scanned: string[];
  run: (sql: SqlStorage) => unknown;
  answer: unknown;
};

const CASES: Record<string, Case> = {
  "the viewer's mutes": {
    pattern: /FROM mutes m\b/,
    scanned: ["m"],
    run: (sql) =>
      listMutes.run(
        sql,
        { credential: credential("read"), page: { limit: 20 }, present: { origin: "https://kopje.test" } },
        transact,
      ),
    answer: { status: "ok", value: { items: [{ id: REMOTE }] } },
  },
  "a domain block's preview": {
    pattern: /SELECT COUNT\(\*\) AS n FROM follows f/,
    scanned: ["f", "a"],
    run: (sql) => previewDomainBlock.run(sql, { credential: credential("read"), domain: "far.example" }, transact),
    answer: { status: "ok", value: { following_count: 1, followers_count: 1 } },
  },
  "a block's follow notification": {
    pattern: /type IN \('follow', 'follow_request'\)/,
    scanned: ["notifications"],
    run: (sql) => block.run(sql, { credential: credential("write"), target: REMOTE, now: NOW }, transact),
    answer: { status: "ok" },
  },
  "a report's follower probe": {
    pattern: /INDEXED BY follows_target\s+WHERE f\.target_account_id = \?1 AND f\.state = 'accepted' LIMIT \?3/,
    scanned: ["a", "f"],
    run: (sql) => hasFollowerOn(new Db(sql), VIEWER, "far.example"),
    answer: true,
  },
  "a remote report's statuses": {
    pattern: /status_mentions rm/,
    scanned: ["s", "rm", "ra"],
    run: (sql) => remoteReportStatusIds(new Db(sql), "far.example", VIEWER, [STATUS]),
    answer: [{ id: STATUS }],
  },
  // The other local account's followers (each grown account) hold none on far.example: the probe reads its windows
  // whole, FOLLOWER_PROBE (1,000) rows of each.
  "a report's follower probe that finds none": {
    pattern: /INDEXED BY follows_target\s+WHERE f\.target_account_id = \?1 AND f\.state = 'accepted' LIMIT \?3/,
    scanned: ["a", "f"],
    run: (sql) => hasFollowerOn(new Db(sql), OTHER, "far.example"),
    answer: false,
  },
  // Its private status is not attached: no follower on the domain, and it mentions no account there.
  "a remote report's statuses that mention none there": {
    pattern: /status_mentions rm/,
    scanned: ["s", "rm", "ra"],
    run: (sql) => remoteReportStatusIds(new Db(sql), "far.example", OTHER, [OTHER_STATUS]),
    answer: [],
  },
  "a forwarded report's addressees": {
    pattern: /SELECT t\.id FROM main\.accounts t/,
    scanned: ["t", "s", "a"],
    run: (sql) => reportForwardees(new Db(sql), REMOTE, [STATUS], ["far.example"]),
    answer: [REMOTE],
  },
  "a domain's rule": {
    pattern: /FROM instance_domain_blocks(?: INDEXED BY \S+)?\s+WHERE domain IN/,
    scanned: ["instance_domain_blocks"],
    run: (sql) => reportsRejected(new Db(sql), "x.far.example"),
    answer: true,
  },
  "a report's target page": {
    pattern: /FROM reports WHERE id = |FROM reports r JOIN/,
    scanned: ["reports", "a"],
    run: (sql) =>
      reportTargetPage.run(sql, { authority: ACCESS, id: String(REPORT), origin: "https://kopje.test" }, transact),
    answer: { ok: true },
  },
};

async function planned(statistics: (typeof STATISTICS)[number], n: number, c: Case) {
  const store = await world(n);
  return runInDurableObject(store, (_instance, state) => {
    const sql = state.storage.sql;
    if (statistics === "singleton") {
      singletonStatistics(sql);
    } else {
      sql.exec("ANALYZE");
    }
    const plans: PlannedStatement[] = [];
    const result = state.storage.transactionSync(() => c.run(plannedSql(sql, c.pattern, plans)));
    return { result, plans };
  });
}

describe("block, mute and report reads with grown neighbours (RES-7)", () => {
  it.each(STATISTICS.flatMap((statistics) => Object.keys(CASES).map((name) => [statistics, name] as const)))(
    "%s statistics: %s reads the same rows",
    async (statistics, name) => {
      const c = CASES[name]!;
      const few = await planned(statistics, FEW, c);
      const many = await planned(statistics, MANY, c);
      expect(few.result).toMatchObject(c.answer as object);
      expect(many.result).toEqual(few.result);
      expect(many.plans.length).toBeGreaterThan(0);
      for (const { plan } of many.plans) {
        expect(scansOf(plan, c.scanned)).toEqual([]);
      }
      expect(many.plans.map((p) => p.rows)).toEqual(few.plans.map((p) => p.rows));
    },
    120_000,
  );
});
