import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { answerFollowRequest } from "../src/domain/account-actions";
import { relationships, searchAccounts } from "../src/domain/accounts";
import { type InboundActivity, receiveActivity } from "../src/domain/inbox";
import { parseRemoteStatus } from "../src/federation/remote-status";
import type { StoreStub } from "../src/platform/store-client";
import type { StoreOperation } from "../src/platform/store-kernel";
import { NOW } from "./app-helpers";
import { migratedStore } from "./helpers";
import { LOCAL } from "./inbox-helpers";
import { PUBLIC } from "./inbox-status-helpers";
import { singletonStatistics } from "./plan-audit-store";
import { type PlannedStatement, plannedSql, scansOf } from "./read-helpers";

// RES-7 witnesses of the edges a relationship, an answered follow request and an inbound activity read by their keys
// (follows_pair, follows_accepted, follows_target, blocks_pair, mutes_pair, favourites_pair, favourite_likes_uri and
// favourites_account, notifications_natural, statuses by uri and statuses_unresolved_reply), under the plan audit's
// singleton statistics and under ANALYZE of the Store as read: the rows they read stay the same as the neighbours they
// never touch grow on both sides of their keys (accounts whose ids and URIs sort below and above the subject's, their
// follows, blocks, mutes, favourites, Like ids and notifications), and as the viewer's follows and bob's favourites
// grow. The walks the keys still allow (a remote actor's own follows and blocks by uri, a remote actor's followers) are
// #1481's: the inbox writes only edges with a local side, but an import does not hold them to it.

const VIEWER = "600000000000000001";
const VIEWER_URI = "https://kopje.test/ap/users/viewer";
const OTHER = "600000000000000002";
const BOB = "550000000000000000";
const BOB_URI = "https://far.example/users/bob";
const STATUS = "920000000000000000";
const STATUS_URI = "https://kopje.test/ap/o/viewer1";
const AT = new Date(NOW).toISOString();
const STATISTICS = ["singleton", "analyzed"] as const;
// Neighbours per side: each side's accepted follows of the viewer past ACCOUNT_RECENT_LIMIT (5,000), so the following
// search's first source is full of the lower side's in either world.
const FEW = 7_800;
const MANY = 15_600;

// The viewer and another local account, bob (remote), the viewer's status; then `n` remote accounts on each side of
// bob's id and URI, each followed by the viewer (a third pending, the rest accepted, with post notifications) and muted
// by it, each following the viewer (pending) and blocking it by uri, each with a status that replies to a status not
// yet stored and that the viewer and bob favourited (bob by a tracked Like id), each having favourited the viewer's
// status (by a tracked Like id), and notifications of each kind from each to the viewer and from bob to the other local
// account.
async function world(n: number): Promise<StoreStub> {
  const store = await migratedStore();
  await runInDurableObject(store, (_instance, state) => {
    const sql = state.storage.sql;
    for (const [id, name] of [
      [VIEWER, "viewer"],
      [OTHER, "other"],
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
      `INSERT INTO accounts (id, uri, username, domain, inbox_url, search_text, created_at)
			VALUES (?, ?, 'bob', 'far.example', 'https://far.example/inbox', 'bob@far.example', '2026-01-01T00:00:00.000Z')`,
      BOB,
      BOB_URI,
    );
    sql.exec(
      "INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('app', 's', 'app', 'urn:ietf:wg:oauth:2.0:oob', 'read write follow')",
    );
    sql.exec(
      "INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES ('viewer', 'access', 'app', ?, 'read write follow')",
      VIEWER,
    );
    const at = AT;
    sql.exec(
      "INSERT INTO statuses (id, uri, account_id, visibility, published_at) VALUES (?, ?, ?, 'public', ?)",
      STATUS,
      STATUS_URI,
      VIEWER,
      at,
    );
    for (const [base, host, statuses] of [
      ["400000000000000000", "a.example", "930000000000000000"],
      ["700000000000000000", "z.example", "940000000000000000"],
    ] as const) {
      sql.exec(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO accounts (id, uri, username, domain, search_text)
				SELECT CAST(?2 + i AS TEXT), 'https://' || ?3 || '/users/u' || i, 'u' || i, ?3, 'u' || i || '@' || ?3 FROM n`,
        n,
        base,
        host,
      );
      const range = `id >= '${base}' AND id < '${BigInt(base) + BigInt(n)}'`;
      sql.exec(
        `INSERT INTO follows (account_id, target_account_id, state, notify)
				SELECT ?1, id, CASE WHEN (CAST(id AS INTEGER) - ?2) % 3 = 2 THEN 'pending' ELSE 'accepted' END, 1
				FROM accounts WHERE ${range}`,
        VIEWER,
        base,
      );
      sql.exec(
        `INSERT INTO follows (account_id, target_account_id, state, uri)
				SELECT id, ?, 'pending', uri || '#follow' FROM accounts WHERE ${range}`,
        VIEWER,
      );
      sql.exec(`INSERT INTO mutes (account_id, target_account_id) SELECT ?, id FROM accounts WHERE ${range}`, VIEWER);
      sql.exec(
        `INSERT INTO blocks (account_id, target_account_id, uri) SELECT id, ?, uri || '#block' FROM accounts WHERE ${range}`,
        VIEWER,
      );
      sql.exec(
        `INSERT INTO statuses (id, uri, account_id, visibility, published_at, in_reply_to_uri)
				SELECT CAST(?1 + CAST(id AS INTEGER) - ?2 AS TEXT), uri || '/s', id, 'public', ?3, uri || '/unknown'
				FROM accounts WHERE ${range}`,
        statuses,
        base,
        at,
      );
      // The side's statuses.
      const own = `account_id IN (SELECT id FROM accounts WHERE ${range})`;
      sql.exec(`INSERT INTO favourites (account_id, status_id) SELECT ?, id FROM statuses WHERE ${own}`, VIEWER);
      sql.exec(`INSERT INTO favourites (account_id, status_id) SELECT id, ? FROM accounts WHERE ${range}`, STATUS);
      sql.exec(`INSERT INTO favourites (account_id, status_id) SELECT ?, id FROM statuses WHERE ${own}`, BOB);
      sql.exec(
        `INSERT INTO favourite_likes (favourite_id, uri, received_at)
				SELECT f.id, CASE WHEN f.account_id = ?1 THEN ?2 || '#like-' || f.status_id ELSE a.uri || '#like' END, ?3
				FROM favourites f JOIN accounts a ON a.id = f.account_id
				WHERE (f.account_id = ?1 AND f.status_id IN (SELECT id FROM statuses WHERE ${own}))
					OR (f.status_id = ?4 AND f.${own})`,
        BOB,
        BOB_URI,
        NOW,
        STATUS,
      );
      for (const type of ["follow_request", "favourite", "reblog"]) {
        sql.exec(
          `INSERT INTO notifications (account_id, type, from_account_id, status_id)
					SELECT ?, ?, id, CASE WHEN ? = 'follow_request' THEN NULL ELSE ? END FROM accounts WHERE ${range}`,
          VIEWER,
          type,
          type,
          STATUS,
        );
      }
      sql.exec(
        `INSERT INTO notifications (account_id, type, from_account_id, status_id)
				SELECT ?, 'favourite', ?, id FROM statuses WHERE ${own}`,
        OTHER,
        BOB,
      );
    }
    // Each grown table holds what the world says of it.
    const counts = sql
      .exec<{ likes: number; replies: number; notified: number }>(
        `SELECT (SELECT count(*) FROM favourite_likes) AS likes,
					(SELECT count(*) FROM statuses WHERE in_reply_to_uri IS NOT NULL) AS replies,
					(SELECT count(*) FROM notifications) AS notified`,
      )
      .one();
    expect(counts).toEqual({ likes: 4 * n, replies: 2 * n, notified: 8 * n });
  });
  return store;
}

type Case = {
  // The statements witnessed, and the tables (by their names in them) none of them may scan.
  pattern: RegExp;
  scanned: string[];
  // The subject's own rows, on top of the world.
  subject: string[];
  run: (sql: SqlStorage, transact: Transact) => unknown;
  // What the subject's run answers, in part.
  answer: unknown;
};

type Transact = <T>(fn: () => T) => T;

function api<I>(operation: StoreOperation<I, unknown>, input: Omit<I, "credential">, scope: string) {
  return (sql: SqlStorage, transact: Transact) =>
    operation.run(sql, { credential: { tokenHash: "viewer", scope, now: NOW }, ...input } as I, transact);
}

function inbound(activity: InboundActivity) {
  return (sql: SqlStorage, transact: Transact) =>
    receiveActivity.run(
      sql,
      { now: NOW, storeNow: NOW, origin: LOCAL, actorUri: BOB_URI, actor: null, actorRevision: null, activity },
      transact,
    );
}

const reply = parseRemoteStatus({
  id: `${BOB_URI}/statuses/new`,
  type: "Note",
  published: "2026-10-11T12:00:00Z",
  attributedTo: BOB_URI,
  to: [PUBLIC],
  cc: [`${BOB_URI}/followers`],
  content: "<p>new</p>",
})!;

const CASES: Record<string, Case> = {
  relationships: {
    pattern: /AS muting_notifications/,
    scanned: ["fo", "fb", "m"],
    subject: [
      `INSERT INTO follows (account_id, target_account_id, state) VALUES ('${VIEWER}', '${BOB}', 'accepted')`,
      `INSERT INTO follows (account_id, target_account_id, state) VALUES ('${BOB}', '${VIEWER}', 'accepted')`,
      `INSERT INTO mutes (account_id, target_account_id) VALUES ('${VIEWER}', '${BOB}')`,
    ],
    run: api(relationships, { ids: [BOB] }, "read"),
    answer: { status: "ok", value: [{ id: BOB, following: true, followed_by: true, muting: true }] },
  },
  "following search": {
    pattern: /^WITH candidates/,
    scanned: ["f", "follows", "accounts", "a"],
    subject: [`INSERT INTO follows (account_id, target_account_id, state) VALUES ('${VIEWER}', '${BOB}', 'accepted')`],
    run: api(
      searchAccounts,
      {
        query: "bob@far.example",
        following: true,
        limit: 20,
        offset: 0,
        localDomain: "kopje.test",
        present: { origin: "https://kopje.test" },
      },
      "read",
    ),
    answer: { status: "ok", value: [{ id: BOB }] },
  },
  "answered follow request": {
    pattern: /f\.state = 'pending'|type = 'follow_request'/,
    scanned: ["f", "a", "notifications"],
    subject: [
      `INSERT INTO follows (account_id, target_account_id, state, uri) VALUES ('${BOB}', '${VIEWER}', 'pending', '${BOB_URI}#f')`,
      `INSERT INTO notifications (account_id, type, from_account_id) VALUES ('${VIEWER}', 'follow_request', '${BOB}')`,
    ],
    run: api(answerFollowRequest, { account: BOB, decision: "reject", now: NOW }, "write"),
    answer: { status: "ok", value: { status: "ok", relationship: { id: BOB, followed_by: false, requested: false } } },
  },
  "Accept of our follow": {
    pattern: /WHERE f\.uri = \? AND f\.target_account_id = \?/,
    scanned: ["f", "l"],
    subject: [
      `INSERT INTO follows (account_id, target_account_id, state, uri) VALUES ('${VIEWER}', '${BOB}', 'pending', '${VIEWER_URI}#f')`,
    ],
    run: inbound({
      type: "Accept",
      id: `${BOB_URI}#accept`,
      object: { id: `${VIEWER_URI}#f`, type: "Follow", actor: VIEWER_URI, object: BOB_URI },
    }),
    answer: { applied: true, reason: "follow-accepted" },
  },
  "Undo of a follow": {
    pattern: /FROM follows INDEXED BY follows_pair WHERE account_id = \? AND uri = \?/,
    scanned: ["follows"],
    subject: [
      `INSERT INTO follows (account_id, target_account_id, state, uri) VALUES ('${BOB}', '${VIEWER}', 'accepted', '${BOB_URI}#f')`,
    ],
    run: inbound({
      type: "Undo",
      id: `${BOB_URI}#undo`,
      object: { id: `${BOB_URI}#f`, type: null, actor: BOB_URI, object: VIEWER_URI },
    }),
    answer: { applied: true, reason: "undone" },
  },
  "Undo of a block": {
    pattern: /FROM blocks INDEXED BY blocks_pair/,
    scanned: ["blocks"],
    subject: [`INSERT INTO blocks (account_id, target_account_id, uri) VALUES ('${BOB}', '${VIEWER}', '${BOB_URI}#b')`],
    run: inbound({
      type: "Undo",
      id: `${BOB_URI}#undo`,
      object: { id: `${BOB_URI}#b`, type: null, actor: BOB_URI, object: null },
    }),
    answer: { applied: true, reason: "undone" },
  },
  Announce: {
    pattern: /AS local\s/,
    scanned: ["s", "l"],
    subject: [],
    run: inbound({
      type: "Announce",
      id: `${BOB_URI}/boosts/1`,
      object: STATUS_URI,
      embedded: null,
      to: [PUBLIC],
      cc: [],
      published: null,
      raw: "{}",
    }),
    answer: { applied: true, reason: "boosted" },
  },
  "Undo of a converted favourite": {
    pattern: /CROSS JOIN favourites f|type = 'favourite' AND from_account_id/,
    scanned: ["s", "f", "notifications"],
    subject: [
      `INSERT INTO favourites (account_id, status_id) VALUES ('${BOB}', '${STATUS}')`,
      `INSERT INTO notifications (account_id, type, from_account_id, status_id) VALUES ('${VIEWER}', 'favourite', '${BOB}', '${STATUS}')`,
    ],
    run: inbound({
      type: "Undo",
      id: `${BOB_URI}#undo`,
      object: { id: `${BOB_URI}#like`, type: "Like", actor: BOB_URI, object: STATUS_URI },
    }),
    answer: { applied: true, reason: "undone" },
  },
  "Undo of a tracked like": {
    pattern: /favourite_likes_uri|type = 'favourite' AND from_account_id/,
    scanned: ["l", "f", "notifications"],
    subject: [
      `INSERT INTO favourites (id, account_id, status_id) VALUES (990000, '${BOB}', '${STATUS}')`,
      `INSERT INTO favourite_likes (favourite_id, uri, received_at) VALUES (990000, '${BOB_URI}#tracked', ${NOW})`,
      `INSERT INTO notifications (account_id, type, from_account_id, status_id) VALUES ('${VIEWER}', 'favourite', '${BOB}', '${STATUS}')`,
    ],
    run: inbound({
      type: "Undo",
      id: `${BOB_URI}#undo`,
      object: { id: `${BOB_URI}#tracked`, type: "Like", actor: BOB_URI, object: STATUS_URI },
    }),
    answer: { applied: true, reason: "undone" },
  },
  "Undo of a boost": {
    pattern: /type = 'reblog' AND from_account_id/,
    scanned: ["notifications", "s"],
    subject: [
      `INSERT INTO statuses (id, uri, account_id, visibility, reblog_of_id, published_at) VALUES ('950000000000000000', '${BOB_URI}/boosts/1', '${BOB}', 'public', '${STATUS}', '${AT}')`,
      `INSERT INTO notifications (account_id, type, from_account_id, status_id) VALUES ('${VIEWER}', 'reblog', '${BOB}', '${STATUS}')`,
    ],
    run: inbound({
      type: "Undo",
      id: `${BOB_URI}#undo`,
      object: { id: `${BOB_URI}/boosts/1`, type: "Announce", actor: BOB_URI, object: STATUS_URI },
    }),
    answer: { applied: true, reason: "undone" },
  },
  Create: {
    pattern: /statuses_unresolved_reply|f\.notify = 1/,
    scanned: ["statuses", "f", "l"],
    subject: [
      `INSERT INTO follows (account_id, target_account_id, state, notify) VALUES ('${VIEWER}', '${BOB}', 'accepted', 1)`,
      `INSERT INTO statuses (id, uri, account_id, visibility, in_reply_to_uri, published_at) VALUES ('950000000000000001', 'https://z.example/users/u0/r', '700000000000000000', 'public', '${BOB_URI}/statuses/new', '${AT}')`,
    ],
    run: inbound({ type: "Create", id: `${BOB_URI}/statuses/new/activity`, object: reply }),
    answer: { applied: true, reason: "created" },
  },
};

async function planned(statistics: (typeof STATISTICS)[number], n: number, c: Case) {
  const store = await world(n);
  return runInDurableObject(store, (_instance, state) => {
    const sql = state.storage.sql;
    for (const statement of c.subject) {
      sql.exec(statement);
    }
    if (statistics === "singleton") {
      singletonStatistics(sql);
    } else {
      sql.exec("ANALYZE");
    }
    const plans: PlannedStatement[] = [];
    const result = c.run(plannedSql(sql, c.pattern, plans), (fn) => state.storage.transactionSync(fn));
    return { result, plans };
  });
}

describe("relationship and inbound edges with grown neighbours (RES-7)", () => {
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
