import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import {
  completeDelivery,
  type DeliveryEnvelope,
  type DeliveryOutcome,
  enqueueActivity,
} from "../src/domain/deliveries";
import type { StoreStub } from "../src/platform/store-client";
import { NOW } from "./app-helpers";
import { migratedStore } from "./helpers";
import { expectBeside, expectGrowth, PlanWitness, type Run, STATISTICS, type Statistics } from "./plan-witness";

// RES-7 witnesses of the delivery reads and writes a pin or a LIMIT 1 subquery rewrote (deliveries.ts), each run beside
// main's statement by test/plan-witness.ts (WITNESS: main's audited SQL, the lane count's identity computed as it never
// failed the audit, and its rewrite's pins or form), under the plan audit's singleton statistics and after ANALYZE,
// taken once the chunks and active rows exist. Each flow names main's statements it runs, every one in order; each
// rewrite returns main's rows, writes as many and changes the same rows (the ids a DELETE removes, some in each run;
// the receipts an INSERT leaves), and reads no more than main after ANALYZE. The
// neighbours (other signers' activities, their rows, chunks, statuses and receipts, the active backlog and a lane's
// active rows) grow on both sides of the subject's own rows (inserted before and after them; the rows a flow writes
// are the newest), each counted by its own predicate: a statement reads the same rows but for a count that walks its
// population. The subject's own key grows too, its activities, their rows and their chunks each counted by its own
// predicate, and the flow reads at least one and at most its stated rows per row they gain together. The import-shaped
// rows: earlier generations under one object URI (duplicates of a non-unique column),
// an audience account named twice, an object URI that is the subject's with a NUL and more after it. Their orders are
// by rowid or by key, so they hold no ties.

const ALICE = "600000000000000001";
const ALICE_URI = "https://kopje.test/ap/users/alice";
const LOW = "500000000000000000";
const HIGH = "700000000000000000";
const NOTE = "https://kopje.test/ap/o/500000000000000000";
const SHARED = "https://shared.example/inbox";
const FEW = 100;
const MANY = 200;
const OWN_FEW = 2;
const OWN_MANY = 40;

// main's statements as the flows run them.
const OLDEST_CHUNK = "34a88d39f6885dc4";
const CHUNK_TARGETS = "0d7193e6184aeba1";
const BACKLOG = "335e707dbb1daaf0";
const LANE = "4bb9cf6368705988";
const OUTSTANDING = "97a57f06dc7bf735";
const UNEXPANDED = "27a4573d075eb9bf";
const EARLIER = "a9e710dd668ef93f";
const WAITING = "403395117854549a";
const CHUNKS = "49fa63915b16b036";
const RECEIPT = "7bf87fad46c9aa1b";
const FORWARD = "34d6a8b0dc38a476";
const times = (n: number, ids: readonly string[]) => Array.from({ length: n }, () => ids).flat();

// An enqueue's expansion: the oldest chunk (a neighbour's, of 150 targets in one lane) and EXPANSION_STEP (100) of its
// targets, each admitted against the backlog (counted once) and its lane; the next enqueue takes its last 50, then the
// next chunk's first 50.
const FIRST_EXPANSION = [OLDEST_CHUNK, CHUNK_TARGETS, BACKLOG, ...times(100, [LANE])];
const SECOND_EXPANSION = [
  OLDEST_CHUNK,
  CHUNK_TARGETS,
  BACKLOG,
  ...times(50, [LANE]),
  OLDEST_CHUNK,
  CHUNK_TARGETS,
  ...times(50, [LANE]),
];

// main's audited statements (origin/main as of #1468 group 8), by their audit identity, each with its rewrite: its pins
// taken out (an index named, CROSS JOIN for JOIN), or, for a statement whose rewrite is its form (a LIMIT 1 subquery,
// a correlated lookup), that rewrite exactly, as it reads in deliveries.ts (whitespace collapsed). The writes: the
// receipts the INSERT leaves, the ids the DELETE removes.
const WITNESS = new PlanWitness({
  // expandPending, the oldest chunk
  "34a88d39f6885dc4": {
    sql: "SELECT CAST(c.id AS TEXT) AS id, CAST(c.activity_id AS TEXT) AS activity_id, o.account_id, o.retracts, c.next FROM outbound_targets c JOIN outbound_activities o ON o.id = c.activity_id ORDER BY c.id LIMIT 1",
    text: "SELECT CAST(id AS TEXT) AS id, CAST(activity_id AS TEXT) AS activity_id, o ->> 0 AS account_id, o ->> 1 AS retracts, next FROM (SELECT c.id, c.activity_id, c.next, (SELECT json_array(o.account_id, o.retracts) FROM outbound_activities o WHERE o.id = c.activity_id) AS o FROM outbound_targets c ORDER BY c.id LIMIT 1)",
  },
  // expandPending, a chunk's targets
  "0d7193e6184aeba1": {
    sql: "SELECT t.key, json_extract(t.value, '$.inbox') AS inbox, json_extract(t.value, '$.addressee') AS addressee, json_extract(t.value, '$.accounts') AS accounts, json_extract(t.value, '$.domains') AS domains, json_extract(t.value, '$.many') AS many FROM outbound_targets c, json_each(c.targets) t WHERE c.id = CAST(? AS INTEGER) AND t.key >= c.next ORDER BY t.key LIMIT ?",
    text: "SELECT t.key, json_extract(t.value, '$.inbox') AS inbox, json_extract(t.value, '$.addressee') AS addressee, json_extract(t.value, '$.accounts') AS accounts, json_extract(t.value, '$.domains') AS domains, json_extract(t.value, '$.many') AS many FROM (SELECT targets, next FROM outbound_targets WHERE id = CAST(?1 AS INTEGER) LIMIT 1) c, json_each(c.targets) t WHERE t.key >= c.next ORDER BY t.key LIMIT ?2",
  },
  // activeCount, the whole backlog
  "335e707dbb1daaf0": {
    sql: "SELECT count(*) AS n FROM (SELECT 1 FROM deliveries WHERE 1 AND state IN ('queued', 'pending', 'leased') LIMIT ?)",
    pins: (text) => text.replace(" INDEXED BY deliveries_lane", ""),
  },
  // activeCount, a lane
  "4bb9cf6368705988": {
    sql: "SELECT count(*) AS n FROM (SELECT 1 FROM deliveries WHERE account_id = ? AND lane = ? AND state IN ('queued', 'pending', 'leased') LIMIT ?)",
    pins: (text) => text.replace(" INDEXED BY deliveries_lane", ""),
  },
  // receiversOf, outstanding rows
  "97a57f06dc7bf735": {
    sql: "SELECT d.inbox_url AS inbox FROM outbound_activities o JOIN deliveries d ON d.activity_id = o.id WHERE o.account_id = ? AND o.object_uri = ? AND o.retracts = 0",
    pins: (text) =>
      text
        .replace(" INDEXED BY outbound_activities_object", "")
        .replace(" CROSS JOIN deliveries d INDEXED BY deliveries_activity ON", " JOIN deliveries d ON"),
  },
  // receiversOf, unexpanded targets
  "27a4573d075eb9bf": {
    sql: "SELECT json_extract(t.value, '$.inbox') AS inbox FROM outbound_activities o JOIN outbound_targets c ON c.activity_id = o.id, json_each(c.targets) t WHERE o.account_id = ? AND o.object_uri = ? AND o.retracts = 0 AND t.key >= c.next",
    pins: (text) =>
      text
        .replace(" INDEXED BY outbound_activities_object", "")
        .replace(
          " CROSS JOIN outbound_targets c INDEXED BY outbound_targets_activity ON",
          " JOIN outbound_targets c ON",
        ),
  },
  // replaceWaiting, the earlier activities
  a9e710dd668ef93f: {
    sql: "SELECT CAST(id AS TEXT) AS id FROM outbound_activities WHERE account_id = ? AND object_uri = ? AND retracts = 0",
    pins: (text) => text.replace(" INDEXED BY outbound_activities_object", ""),
  },
  // replaceWaiting, their waiting rows
  "403395117854549a": {
    sql: "DELETE FROM deliveries WHERE activity_id = CAST(? AS INTEGER) AND state <> 'leased' AND lane IN (SELECT value FROM json_each(?)) RETURNING lane",
    pins: (text) => text.replace(" INDEXED BY deliveries_activity", ""),
    writes: "SELECT CAST(id AS TEXT) AS id FROM deliveries ORDER BY id",
  },
  // replaceWaiting, their chunks
  "49fa63915b16b036": {
    sql: "SELECT CAST(id AS TEXT) AS id, targets, next FROM outbound_targets WHERE activity_id = CAST(? AS INTEGER)",
    pins: (text) => text.replace(" INDEXED BY outbound_targets_activity", ""),
  },
  // completeDelivery, the receipt
  "7bf87fad46c9aa1b": {
    sql: "INSERT INTO outbound_receipts (status_id, inbox_url, account_id, delivered_at) SELECT s.id, ?2, o.account_id, ?3 FROM outbound_activities o JOIN statuses s ON s.uri = o.object_uri WHERE o.id = CAST(?1 AS INTEGER) AND (json_extract(o.body, '$.activity.type') IN ('Create', 'Announce') OR (s.withdrawn = 1 AND o.retracts = 0)) AND NOT EXISTS (SELECT 1 FROM outbound_activities r WHERE r.account_id = o.account_id AND r.object_uri = o.object_uri AND r.retracts = 1 AND r.staged IS NULL) ON CONFLICT DO UPDATE SET delivered_at = excluded.delivered_at",
    text: "INSERT INTO outbound_receipts (status_id, inbox_url, account_id, delivered_at) SELECT s.id, ?2, o.account_id, ?3 FROM (SELECT account_id, object_uri, body, retracts FROM outbound_activities WHERE id = CAST(?1 AS INTEGER) LIMIT 1) o CROSS JOIN statuses s INDEXED BY sqlite_autoindex_statuses_2 ON s.uri = o.object_uri WHERE (json_extract(o.body, '$.activity.type') IN ('Create', 'Announce') OR (s.withdrawn = 1 AND o.retracts = 0)) AND NOT EXISTS (SELECT 1 FROM outbound_activities r INDEXED BY outbound_activities_object WHERE r.account_id = o.account_id AND r.object_uri = o.object_uri AND r.retracts = 1 AND r.staged IS NULL) ON CONFLICT DO UPDATE SET delivered_at = excluded.delivered_at",
    writes:
      "SELECT status_id, inbox_url, account_id, delivered_at FROM outbound_receipts ORDER BY status_id, inbox_url",
  },
  // forwardFallback
  "34d6a8b0dc38a476": {
    sql: "SELECT a.inbox_url AS inbox, a.id, a.uri FROM deliveries d CROSS JOIN json_each(d.recipient_accounts) r CROSS JOIN accounts a INDEXED BY sqlite_autoindex_accounts_1 ON a.id = r.value WHERE d.id = CAST(?1 AS INTEGER) AND d.addressee IS NULL AND d.recipient_accounts IS NOT NULL AND d.recipients_many IS NULL AND a.domain IS NOT NULL AND a.shared_inbox_url = d.inbox_url AND a.inbox_url <> d.inbox_url ORDER BY a.id",
    text: "SELECT a.inbox_url AS inbox, a.id, a.uri FROM (SELECT addressee, inbox_url, recipient_accounts, recipients_many FROM deliveries WHERE id = CAST(?1 AS INTEGER) LIMIT 1) row CROSS JOIN json_each(row.recipient_accounts) r CROSS JOIN accounts a INDEXED BY sqlite_autoindex_accounts_1 ON a.id = r.value WHERE row.addressee IS NULL AND row.recipient_accounts IS NOT NULL AND row.recipients_many IS NULL AND a.domain IS NOT NULL AND a.shared_inbox_url = row.inbox_url AND a.inbox_url <> row.inbox_url ORDER BY a.id",
  },
});

const ACCOUNTS = Array.from({ length: 3 }, (_, i) => String(550_000_000_000_000_001n + BigInt(i)));
const ACTIVE = "state IN ('queued', 'pending', 'leased')";
const T_LANE = "https://t.example";
const STATUS = "560000000000000000";
const STATUS_URI = "https://kopje.test/ap/o/m";
const LEASE = "lease";

// The other signers' work around the subject, `n` of each per side: before the subject's rows (Low, objects a…)
// and after them (High, objects z…). Each activity is about a status of its own (with its receipt), has a given-up
// row, an active row in Low's or High's lane at t.example, and a chunk of 150 targets in that lane (more than one
// expansion step, so the oldest chunk takes every step whatever their number).
function neighbours(sql: SqlStorage, n: number, signer: string, prefix: string, statusBase: string) {
  sql.exec(
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
		INSERT INTO statuses (id, uri, account_id, visibility, published_at)
		SELECT CAST(?2 + i AS TEXT), 'https://kopje.test/ap/o/' || ?3 || i, ?4, 'public', ?5 FROM n`,
    n,
    statusBase,
    prefix,
    signer,
    new Date(NOW).toISOString(),
  );
  sql.exec(
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
		INSERT INTO outbound_activities (account_id, body, object_uri, created_at)
		SELECT ?2, json_object('activity', json_object('type', 'Create', 'id', 'https://kopje.test/ap/a/' || ?3 || i)),
			'https://kopje.test/ap/o/' || ?3 || i, ?4 FROM n`,
    n,
    signer,
    prefix,
    NOW,
  );
  const mine = `account_id = '${signer}' AND object_uri GLOB 'https://kopje.test/ap/o/${prefix}*'`;
  sql.exec(
    `INSERT INTO outbound_receipts (status_id, inbox_url, account_id, delivered_at)
		SELECT s.id, 'https://far.example/inbox', s.account_id, ?1 FROM statuses s WHERE s.account_id = ?2`,
    NOW,
    signer,
  );
  sql.exec(
    `INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, state, next_attempt_at, updated_at)
		SELECT id, account_id, 'https://far.example/inbox', 'https://far.example', 'gave_up', ?1, ?1
		FROM outbound_activities WHERE ${mine}`,
    NOW,
  );
  sql.exec(
    `INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, state, next_attempt_at, updated_at)
		SELECT id, account_id, ?1 || '/users/' || id || '/inbox', ?1, 'pending', ?2, ?2
		FROM outbound_activities WHERE ${mine}`,
    T_LANE,
    NOW,
  );
  sql.exec(
    `INSERT INTO outbound_targets (activity_id, targets)
		SELECT id, (WITH RECURSIVE k(j) AS (SELECT 0 UNION ALL SELECT j + 1 FROM k WHERE j < 149)
			SELECT json_group_array(json_object('inbox', ?1 || '/users/' || j || '/inbox')) FROM k)
		FROM outbound_activities WHERE ${mine}`,
    T_LANE,
  );
}

// Alice (the signer), Low and High (local, ids below and above hers), three remote accounts at one shared inbox
// (shared.example), each with a personal inbox there; the neighbours before, `subject` (the subject's own rows), and
// the neighbours after.
async function world(n: number, subject: (sql: SqlStorage) => void): Promise<StoreStub> {
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
    local(ALICE, "alice");
    local(LOW, "low");
    local(HIGH, "high");
    for (const [i, id] of ACCOUNTS.entries()) {
      sql.exec(
        `INSERT INTO accounts (id, uri, username, domain, inbox_url, shared_inbox_url)
				VALUES (?, ?, ?, 'shared.example', ?, ?)`,
        id,
        `https://shared.example/users/r${i}`,
        `r${i}`,
        `https://shared.example/users/r${i}/inbox`,
        SHARED,
      );
    }
    neighbours(sql, n, LOW, "a", "400000000000000000");
    subject(sql);
    neighbours(sql, n, HIGH, "z", "800000000000000000");
  });
  return store;
}

// `own` earlier generations of Alice's `object`, each with a given-up row and an active row at the shared inbox and
// a chunk of one target there; and one generation of an object whose URI is `object` with a NUL and more after it,
// which no lookup of `object` may take.
function generations(sql: SqlStorage, object: string, own: number) {
  sql.exec(
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
		INSERT INTO outbound_activities (account_id, body, object_uri, superseded, created_at)
		SELECT ?2, json_object('activity', json_object('type', 'Update', 'id', ?3 || i)), ?4, 1, ?5 FROM n WHERE ?1 > 0`,
    own,
    ALICE,
    `${ALICE_URI}#earlier/`,
    object,
    NOW,
  );
  sql.exec(
    `INSERT INTO outbound_activities (account_id, body, object_uri, created_at)
		VALUES (?1, json_object('activity', json_object('type', 'Update', 'id', ?2)), ?3 || char(0) || 'x', ?4)`,
    ALICE,
    `${ALICE_URI}#nul`,
    object,
    NOW,
  );
  for (const state of ["gave_up", "pending"]) {
    sql.exec(
      `INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, state, next_attempt_at, updated_at)
			SELECT id, account_id, ?1, 'https://shared.example', ?2, ?3, ?3 FROM outbound_activities WHERE account_id = ?4`,
      SHARED,
      state,
      NOW,
      ALICE,
    );
  }
  sql.exec(
    `INSERT INTO outbound_targets (activity_id, targets)
		SELECT id, json_array(json_object('inbox', ?1)) FROM outbound_activities WHERE account_id = ?2`,
    SHARED,
    ALICE,
  );
}

const update = (n: number): DeliveryEnvelope => ({
  activity: {
    type: "Update",
    id: `${ALICE_URI}#updates/${n}`,
    actor: ALICE_URI,
    object: { id: ALICE_URI, type: "Person", name: `alice ${n}` },
  },
  // An audience account named twice, as an import may hold it.
  audience: { followers: false, accounts: [...ACCOUNTS, ACCOUNTS[0]!] },
});

// Alice's activity of `type` about the subject status, and a row of it leased to the shared inbox.
function leased(sql: SqlStorage, type: string, extra: { withdrawn?: boolean; shares?: boolean } = {}) {
  sql.exec(
    "INSERT INTO statuses (id, uri, account_id, visibility, published_at, withdrawn) VALUES (?, ?, ?, 'public', ?, ?)",
    STATUS,
    STATUS_URI,
    ALICE,
    new Date(NOW).toISOString(),
    extra.withdrawn === true ? 1 : 0,
  );
  sql.exec(
    `INSERT INTO outbound_activities (account_id, body, object_uri, created_at)
		VALUES (?1, json_object('activity', json_object('type', ?2, 'id', ?3, 'object', ?4),
			'audience', CASE WHEN ?5 THEN json_object('shares', json_array(?4), 'accounts', json_array()) END), ?4, ?6)`,
    ALICE,
    type,
    `${STATUS_URI}#${type}`,
    STATUS_URI,
    extra.shares === true ? 1 : 0,
    NOW,
  );
  sql.exec(
    `INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, state, lease_token, next_attempt_at, updated_at,
			recipient_accounts)
		SELECT id, account_id, ?1, 'https://shared.example', 'leased', ?2, ?3, ?3, json_array(?4)
		FROM outbound_activities WHERE account_id = ?5 AND object_uri = ?6`,
    SHARED,
    LEASE,
    NOW,
    ACCOUNTS[0]!,
    ALICE,
    STATUS_URI,
  );
}

const completed = (outcome: DeliveryOutcome) => (sql: SqlStorage, transact: <T>(fn: () => T) => T) => {
  const id = sql
    .exec<{ id: string }>("SELECT CAST(id AS TEXT) AS id FROM deliveries WHERE lease_token = ?", LEASE)
    .one().id;
  return completeDelivery.run(sql, { id, leaseToken: LEASE, now: NOW, outcome }, transact);
};
const DELIVERED: DeliveryOutcome = { kind: "delivered", status: 202 };

type Flow = {
  // main's statements the flow runs, in order, for the subject's own key at `own`.
  main: (own: number) => readonly string[];
  // The subject's own rows, among the neighbours.
  subject: (sql: SqlStorage, own: number) => void;
  run: (sql: SqlStorage, transact: <T>(fn: () => T) => T) => unknown;
  answer?: unknown;
  // The subject's own key, each population counted, and the rows the flow reads at most per row of them.
  own?: { count: Record<string, string>; walks: number };
};

// The neighbour populations, each by its own predicate, that every flow's world grows.
const POPULATIONS: Record<string, string> = {
  activities: `SELECT count(*) AS n FROM outbound_activities WHERE account_id <> '${ALICE}'`,
  rows: `SELECT count(*) AS n FROM deliveries WHERE account_id <> '${ALICE}'`,
  chunks: `SELECT count(*) AS n FROM outbound_targets WHERE activity_id IN (SELECT id FROM outbound_activities WHERE account_id <> '${ALICE}')`,
  backlog: `SELECT count(*) AS n FROM deliveries WHERE ${ACTIVE}`,
  lane: `SELECT count(*) AS n FROM deliveries WHERE account_id = '${LOW}' AND lane = '${T_LANE}' AND ${ACTIVE}`,
  receipts: `SELECT count(*) AS n FROM outbound_receipts WHERE account_id <> '${ALICE}'`,
};

// The statements whose reads walk a neighbour population, the population, and the rows each run reads per row of it:
// the backlog count reads the active rows (up to MAX_BACKLOG), the lane count Low's active rows in its lane (up to
// MAX_LANE_BACKLOG).
const WALKS: Record<string, { population: string; perRun: number }> = {
  "335e707dbb1daaf0": { population: "backlog", perRun: 1 },
  "4bb9cf6368705988": { population: "lane", perRun: 1 },
};

// The subject's own key, each population by its own predicate: the object's activities, their rows and their chunks.
const OWN_COUNT = (object: string): Record<string, string> => {
  const own = `SELECT id FROM outbound_activities WHERE account_id = '${ALICE}' AND object_uri = '${object}'`;
  return {
    activities: `SELECT count(*) AS n FROM outbound_activities WHERE account_id = '${ALICE}' AND object_uri = '${object}'`,
    rows: `SELECT count(*) AS n FROM deliveries WHERE activity_id IN (${own})`,
    chunks: `SELECT count(*) AS n FROM outbound_targets WHERE activity_id IN (${own})`,
  };
};

const FLOWS: Record<string, Flow> = {
  // An actor Update twice: the second replaces the first's waiting rows and those of the earlier generations; both
  // expand the oldest chunk (a neighbour's).
  "an actor Update replacing the waiting ones": {
    // The first Update replaces the waiting rows of each earlier generation; the second, those of the first.
    main: (own) => [
      EARLIER,
      ...times(own, [WAITING, CHUNKS]),
      ...FIRST_EXPANSION,
      EARLIER,
      WAITING,
      CHUNKS,
      ...SECOND_EXPANSION,
    ],
    subject: (sql, own) => generations(sql, ALICE_URI, own),
    run: (sql) => {
      const db = new Db(sql);
      enqueueActivity(db, ALICE, update(1), NOW);
      enqueueActivity(db, ALICE, update(2), NOW);
    },
    own: { count: OWN_COUNT(ALICE_URI), walks: 6 },
  },
  // A Create, then its Delete: the Delete reaches the earlier generations' rows and unexpanded targets.
  "a Delete reaching the earlier receivers": {
    main: () => [...FIRST_EXPANSION, OUTSTANDING, UNEXPANDED, ...SECOND_EXPANSION],
    subject: (sql, own) => generations(sql, NOTE, own),
    run: (sql) => {
      const db = new Db(sql);
      enqueueActivity(
        db,
        ALICE,
        {
          activity: { type: "Create", id: `${NOTE}/activity`, actor: ALICE_URI, object: { id: NOTE, type: "Note" } },
          audience: { followers: false, accounts: ACCOUNTS },
        },
        NOW,
      );
      enqueueActivity(
        db,
        ALICE,
        {
          activity: { type: "Delete", id: `${NOTE}#delete`, actor: ALICE_URI, object: { id: NOTE, type: "Tombstone" } },
          audience: { followers: false, accounts: ACCOUNTS },
        },
        NOW,
      );
    },
    own: { count: OWN_COUNT(NOTE), walks: 4 },
  },
  // A delivered Create of the status: its receipt is written.
  "a delivered Create's receipt": {
    main: () => [RECEIPT],
    subject: (sql) => leased(sql, "Create"),
    run: completed(DELIVERED),
    answer: { status: "delivered" },
  },
  // A delivered Announce of the status: its receipt is written.
  "a delivered Announce's receipt": {
    main: () => [RECEIPT],
    subject: (sql) => leased(sql, "Announce"),
    run: completed(DELIVERED),
    answer: { status: "delivered" },
  },
  // A delivered Update of a withdrawn status: its receipt is written (VIS-3).
  "a delivered Update's receipt, its status withdrawn": {
    main: () => [RECEIPT],
    subject: (sql) => leased(sql, "Update", { withdrawn: true }),
    run: completed(DELIVERED),
    answer: { status: "delivered" },
  },
  // A delivered Create whose receipt is held already: its time is updated.
  "a delivered Create's receipt, held already": {
    main: () => [RECEIPT],
    subject: (sql) => {
      leased(sql, "Create");
      sql.exec(
        "INSERT INTO outbound_receipts (status_id, inbox_url, account_id, delivered_at) VALUES (?, ?, ?, 1)",
        STATUS,
        SHARED,
        ALICE,
      );
    },
    run: completed(DELIVERED),
    answer: { status: "delivered" },
  },
  // A delivered Create whose status has a retraction pending: no receipt.
  "a delivered Create, its retraction pending": {
    main: () => [RECEIPT],
    subject: (sql) => {
      leased(sql, "Create");
      sql.exec(
        `INSERT INTO outbound_activities (account_id, body, object_uri, retracts, created_at)
				VALUES (?1, json_object('activity', json_object('type', 'Delete', 'id', ?2)), ?3, 1, ?4)`,
        ALICE,
        `${STATUS_URI}#delete`,
        STATUS_URI,
        NOW,
      );
    },
    run: completed(DELIVERED),
    answer: { status: "delivered" },
  },
  // A forward's row to the shared inbox, failed with 404: it moves to the personal inbox of the one account its
  // provenance names there (forwardFallback).
  "a forward whose shared inbox is gone": {
    main: () => [FORWARD],
    subject: (sql) => leased(sql, "Create", { shares: true }),
    run: completed({ kind: "failed", status: 404, error: "HTTP 404", permanent: true }),
    answer: { status: "retry" },
  },
};

async function sides(statistics: Statistics, flow: Flow, n: number, own: number): Promise<Run> {
  const store = await world(n, (sql) => flow.subject(sql, own));
  return runInDurableObject(store, (_instance, state) =>
    WITNESS.measure(state, {
      statistics,
      expected: flow.main(own),
      populations: { ...POPULATIONS, ...owned(flow) },
      run: flow.run,
    }),
  );
}

// The flow's own populations, named apart from the neighbours'.
const owned = (flow: Flow) =>
  Object.fromEntries(Object.entries(flow.own?.count ?? {}).map(([name, count]) => [`own ${name}`, count]));

describe("main's statements", () => {
  it("are main's audited ones", async () => {
    await WITNESS.expectAudited();
  });
});

describe("delivery reads beside main's (RES-7)", () => {
  it.each(STATISTICS.flatMap((statistics) => Object.keys(FLOWS).map((name) => [statistics, name] as const)))(
    "%s statistics: %s",
    async (statistics, name) => {
      const flow = FLOWS[name]!;
      const few = await sides(statistics, flow, FEW, OWN_FEW);
      const many = await sides(statistics, flow, MANY, OWN_FEW);
      const runs = [few, many];
      const ownMany = flow.own === undefined ? undefined : await sides(statistics, flow, FEW, OWN_MANY);
      if (ownMany !== undefined) {
        runs.push(ownMany);
      }
      for (const run of runs) {
        expectBeside(statistics, run);
        // A DELETE runs for each earlier generation, the unexpanded ones removing none; the others remove some.
        const deletes = run.sides.filter((side) => side.id === WAITING);
        if (deletes.length > 0) {
          expect(deletes.reduce((n, side) => n + side.main.removed.length, 0)).toBeGreaterThan(0);
        }
      }
      if (flow.answer !== undefined) {
        expect(few.result).toMatchObject(flow.answer as object);
      }
      expect(many.result).toEqual(few.result);
      // The neighbours: each statement, the same rows but for a walk of its population.
      expectGrowth(few, many, { populations: Object.keys(POPULATIONS), perSide: WALKS });
      if (ownMany !== undefined) {
        // The own key: at least one more row read and at most `walks` per row it gained (its populations added up),
        // summed over the flow.
        expectGrowth(few, ownMany, {
          populations: Object.keys(owned(flow)),
          total: { atLeast: "gain", walks: flow.own!.walks },
        });
      }
    },
    180_000,
  );
});
