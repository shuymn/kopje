import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { acceptNotificationRequest, dismissNotificationRequest } from "../src/domain/notification-requests";
import { notify } from "../src/domain/notifications";
import type { StoreStub } from "../src/platform/store-client";
import { NOW } from "./app-helpers";
import { migratedStore } from "./helpers";
import { singletonStatistics } from "./plan-audit-store";
import { type PlannedStatement, plannedSql, rowsRead } from "./read-helpers";

// RES-7 witnesses of notification writes, under the plan audit's singleton statistics and under statistics taken on the
// grown Store: queuePushes (notifications.ts) as an account's unsubscribed tokens grow, and an answered request's
// batches (notification-requests.ts jobBatch) as other senders' notifications grow.

const VIEWER = "600000000000000001";
const SENDER = "600000000000000002";
const OTHERS = 700000000000000000n;
const STATISTICS = ["singleton", "analyzed"] as const;

async function analyze(store: StoreStub, statistics: (typeof STATISTICS)[number]) {
  await runInDurableObject(store, (_instance, state) =>
    statistics === "singleton" ? singletonStatistics(state.storage.sql) : state.storage.sql.exec("ANALYZE"),
  );
}

// The viewer (local) and the sender (local), and `others` accounts besides.
function people(sql: SqlStorage, others: number) {
  for (const [id, name] of [
    [VIEWER, "viewer"],
    [SENDER, "sender"],
  ]) {
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
  }
  sql.exec(
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
		INSERT INTO accounts (id, uri, username, domain)
		SELECT CAST(?2 + i AS TEXT), 'https://far.example/users/o' || i, 'o' || i, 'far.example' FROM n`,
    others,
    String(OTHERS),
  );
  sql.exec(
    "INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('app', 's', 'app', 'urn:ietf:wg:oauth:2.0:oob', 'read write push')",
  );
}

describe("notification writes with grown neighbours (RES-7)", () => {
  // queuePushes: the viewer's three subscriptions, among `tokens` access tokens of the viewer without one. The join is
  // the statistics' (no index reaches an account's subscriptions, #1481); its rows read stay flat as the viewer's
  // unsubscribed tokens grow, under either statistics.
  it.each(STATISTICS)(
    "queues a notification's pushes as the recipient's tokens grow (%s)",
    async (statistics) => {
      const pushes = async (tokens: number) => {
        const store = await migratedStore();
        await runInDurableObject(store, (_instance, state) => {
          const sql = state.storage.sql;
          people(sql, 0);
          sql.exec(
            `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
					INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes)
					SELECT 'token' || i, 'access', 'app', ?2, 'read write push' FROM n`,
            tokens + 3,
            VIEWER,
          );
          sql.exec(
            `INSERT INTO push_subscriptions (token_hash, endpoint, key_p256dh, key_auth, alerts, policy)
					SELECT token_hash, 'https://push.example/' || token_hash, 'p', 'a', '{"follow":true}', 'all'
					FROM oauth_tokens WHERE token_hash IN ('token0', 'token1', 'token2')`,
          );
        });
        await analyze(store, statistics);
        return runInDurableObject(store, (_instance, state) => {
          const plans: PlannedStatement[] = [];
          const db = new Db(plannedSql(state.storage.sql, /INSERT INTO push_deliveries/, plans));
          notify(db, { recipientId: VIEWER, type: "follow", fromId: SENDER, statusId: null, now: NOW });
          const queued = state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM push_deliveries").one().n;
          return { queued, rows: plans.map((plan) => plan.rows) };
        });
      };
      const [few, many] = [await pushes(1_000), await pushes(20_000)];
      expect([few.queued, many.queued]).toEqual([3, 3]);
      expect(many.rows).toEqual(few.rows);
    },
    120_000,
  );

  // jobBatch: the viewer answers the sender's request of a filtered notification while `others` accounts' follow
  // notifications to the viewer grow. Each batch reads the sender's window through notifications_from and writes the
  // viewer's rows by key, so the rows read stay flat, under either statistics, accepted or dismissed.
  it.each(STATISTICS.flatMap((s) => [`${s} accept`, `${s} dismiss`] as const))(
    "answers a request as other senders' notifications grow (%s)",
    async (name) => {
      const [statistics, kind] = name.split(" ") as [(typeof STATISTICS)[number], "accept" | "dismiss"];
      const answered = async (others: number) => {
        const store = await migratedStore();
        const request = await runInDurableObject(store, (_instance, state) => {
          const sql = state.storage.sql;
          people(sql, others);
          sql.exec(
            "INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES ('viewer', 'access', 'app', ?, 'read write')",
            VIEWER,
          );
          sql.exec(
            `INSERT INTO notifications (account_id, type, from_account_id) SELECT ?1, 'follow', id FROM accounts
						WHERE id GLOB '7*'`,
            VIEWER,
          );
          sql.exec(
            `INSERT INTO notifications (account_id, type, from_account_id, filtered) VALUES (?1, 'follow_request', ?2, 1)`,
            VIEWER,
            SENDER,
          );
          return sql
            .exec<{ id: number }>(
              `INSERT INTO notification_requests (account_id, from_account_id, notifications_count)
							VALUES (?, ?, 1) RETURNING id`,
              VIEWER,
              SENDER,
            )
            .one().id;
        });
        await analyze(store, statistics);
        const operation = kind === "accept" ? acceptNotificationRequest : dismissNotificationRequest;
        const input = { credential: { tokenHash: "viewer", scope: "write", now: NOW }, id: String(request), now: NOW };
        const rows = await rowsRead({ store }, operation, input as never);
        const left = await runInDurableObject(
          store,
          (_instance, state) =>
            state.storage.sql
              .exec<{ n: number }>(
                "SELECT count(*) AS n FROM notifications WHERE from_account_id = ? AND filtered = 1",
                SENDER,
              )
              .one().n,
        );
        return { rows, left };
      };
      const [few, many] = [await answered(1_000), await answered(20_000)];
      expect([few.left, many.left]).toEqual([0, 0]);
      expect(many.rows).toBe(few.rows);
    },
    120_000,
  );
});
