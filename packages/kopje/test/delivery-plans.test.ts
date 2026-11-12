import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import {
  claimDeliveries,
  completeDelivery,
  confirmDelivery,
  type DeliveryEnvelope,
  enqueueActivity,
} from "../src/domain/deliveries";
import type { StoreStub } from "../src/platform/store-client";
import { NOW } from "./app-helpers";
import { migratedStore } from "./helpers";
import { statementId } from "./plan-audit";
import { singletonStatistics } from "./plan-audit-store";
import { type SqlRow, watchedCursor } from "./read-helpers";

// RES-7 witnesses of the delivery reads a pin or a LIMIT 1 subquery rewrote (deliveries.ts), each run side by side with
// main's statement (MAIN: main's audited SQL, each guarded by its identity; the lane count never failed the audit, so
// its identity is computed) with the same parameters, in a savepoint rolled back before the rewrite runs, under the
// plan audit's singleton statistics and after ANALYZE. Each statement is paired with main's by its kind (KINDS), and
// each flow names main's statements it runs, in the order they first run. Each rewrite returns main's rows (and writes
// as many) and reads no more than main after ANALYZE. Its reads stay the same as other signers' activities, their rows
// and chunks grow on both sides of the subject's keys (signer ids below and above the subject's, object URIs before and
// after its own, rowids before and after its rows), and grow by at most their stated rows per row of the subject's own
// key: the object's earlier generations (replaceWaiting, receiversOf). The rows confirm and complete read, and
// personalFallback's candidates, keep main's statements (#1481). The import-shaped rows: an earlier generation repeated
// under one object URI (duplicates of a non-unique column), an audience account named twice, a URI with NUL.

const ALICE = "600000000000000001";
const ALICE_URI = "https://kopje.test/ap/users/alice";
const LOW = "500000000000000000";
const HIGH = "700000000000000000";
const NOTE = "https://kopje.test/ap/o/500000000000000000";
const SHARED = "https://shared.example/inbox";
const STATISTICS = ["singleton", "analyzed"] as const;
const FEW = 100;
const MANY = 200;

// main's audited statements (origin/main as of #1468 group 8), by their audit identity.
const MAIN: Record<string, string> = {
  // expandPending, the oldest chunk
  "34a88d39f6885dc4":
    "SELECT CAST(c.id AS TEXT) AS id, CAST(c.activity_id AS TEXT) AS activity_id, o.account_id, o.retracts, c.next FROM outbound_targets c JOIN outbound_activities o ON o.id = c.activity_id ORDER BY c.id LIMIT 1",
  // expandPending, a chunk's targets
  "0d7193e6184aeba1":
    "SELECT t.key, json_extract(t.value, '$.inbox') AS inbox, json_extract(t.value, '$.addressee') AS addressee, json_extract(t.value, '$.accounts') AS accounts, json_extract(t.value, '$.domains') AS domains, json_extract(t.value, '$.many') AS many FROM outbound_targets c, json_each(c.targets) t WHERE c.id = CAST(? AS INTEGER) AND t.key >= c.next ORDER BY t.key LIMIT ?",
  // activeCount, the whole backlog
  "335e707dbb1daaf0":
    "SELECT count(*) AS n FROM (SELECT 1 FROM deliveries WHERE 1 AND state IN ('queued', 'pending', 'leased') LIMIT ?)",
  // activeCount, a lane
  "4bb9cf6368705988":
    "SELECT count(*) AS n FROM (SELECT 1 FROM deliveries WHERE account_id = ? AND lane = ? AND state IN ('queued', 'pending', 'leased') LIMIT ?)",
  // receiversOf, outstanding rows
  "97a57f06dc7bf735":
    "SELECT d.inbox_url AS inbox FROM outbound_activities o JOIN deliveries d ON d.activity_id = o.id WHERE o.account_id = ? AND o.object_uri = ? AND o.retracts = 0",
  // receiversOf, unexpanded targets
  "27a4573d075eb9bf":
    "SELECT json_extract(t.value, '$.inbox') AS inbox FROM outbound_activities o JOIN outbound_targets c ON c.activity_id = o.id, json_each(c.targets) t WHERE o.account_id = ? AND o.object_uri = ? AND o.retracts = 0 AND t.key >= c.next",
  // replaceWaiting, the earlier activities
  a9e710dd668ef93f:
    "SELECT CAST(id AS TEXT) AS id FROM outbound_activities WHERE account_id = ? AND object_uri = ? AND retracts = 0",
  // replaceWaiting, their waiting rows
  "403395117854549a":
    "DELETE FROM deliveries WHERE activity_id = CAST(? AS INTEGER) AND state <> 'leased' AND lane IN (SELECT value FROM json_each(?)) RETURNING lane",
  // replaceWaiting, their chunks
  "49fa63915b16b036":
    "SELECT CAST(id AS TEXT) AS id, targets, next FROM outbound_targets WHERE activity_id = CAST(? AS INTEGER)",
  // completeDelivery, the receipt
  "7bf87fad46c9aa1b":
    "INSERT INTO outbound_receipts (status_id, inbox_url, account_id, delivered_at) SELECT s.id, ?2, o.account_id, ?3 FROM outbound_activities o JOIN statuses s ON s.uri = o.object_uri WHERE o.id = CAST(?1 AS INTEGER) AND (json_extract(o.body, '$.activity.type') IN ('Create', 'Announce') OR (s.withdrawn = 1 AND o.retracts = 0)) AND NOT EXISTS (SELECT 1 FROM outbound_activities r WHERE r.account_id = o.account_id AND r.object_uri = o.object_uri AND r.retracts = 1 AND r.staged IS NULL) ON CONFLICT DO UPDATE SET delivered_at = excluded.delivered_at",
  // forwardFallback
  "34d6a8b0dc38a476":
    "SELECT a.inbox_url AS inbox, a.id, a.uri FROM deliveries d CROSS JOIN json_each(d.recipient_accounts) r CROSS JOIN accounts a INDEXED BY sqlite_autoindex_accounts_1 ON a.id = r.value WHERE d.id = CAST(?1 AS INTEGER) AND d.addressee IS NULL AND d.recipient_accounts IS NOT NULL AND d.recipients_many IS NULL AND a.domain IS NOT NULL AND a.shared_inbox_url = d.inbox_url AND a.inbox_url <> d.inbox_url ORDER BY a.id",
};

const KINDS: [RegExp, string][] = [
  [
    /^SELECT CAST\(c\.id AS TEXT\) AS id, CAST\(c\.activity_id AS TEXT\) AS activity_id, \(SELECT o\.account_id/,
    "34a88d39f6885dc4",
  ],
  [/^SELECT t\.key, json_extract\(t\.value, '\$\.inbox'\) AS inbox/, "0d7193e6184aeba1"],
  [
    /^SELECT count\(\*\) AS n FROM \(SELECT 1 FROM deliveries INDEXED BY deliveries_lane WHERE 1 AND/,
    "335e707dbb1daaf0",
  ],
  [
    /^SELECT count\(\*\) AS n FROM \(SELECT 1 FROM deliveries INDEXED BY deliveries_lane WHERE account_id = \?/,
    "4bb9cf6368705988",
  ],
  [/^SELECT d\.inbox_url AS inbox FROM outbound_activities o INDEXED BY/, "97a57f06dc7bf735"],
  [/^SELECT json_extract\(t\.value, '\$\.inbox'\) AS inbox FROM outbound_activities o INDEXED BY/, "27a4573d075eb9bf"],
  [
    /^SELECT CAST\(id AS TEXT\) AS id FROM outbound_activities INDEXED BY outbound_activities_object WHERE/,
    "a9e710dd668ef93f",
  ],
  [/^DELETE FROM deliveries INDEXED BY deliveries_activity WHERE activity_id/, "403395117854549a"],
  [/^SELECT CAST\(id AS TEXT\) AS id, targets, next FROM outbound_targets INDEXED BY/, "49fa63915b16b036"],
  [/^INSERT INTO outbound_receipts/, "7bf87fad46c9aa1b"],
  [/^SELECT a\.inbox_url AS inbox, a\.id, a\.uri FROM \(SELECT addressee/, "34d6a8b0dc38a476"],
];

type Side = {
  id: string;
  query: string;
  mine: { rows: number; written: number; result: SqlRow[] };
  main: { rows: number; written: number; result: SqlRow[] };
};

const ROLLBACK = new Error("rolled back");
const normalized = (sql: string) => sql.replace(/\s+/g, " ").trim();

// A SqlStorage over `real` that, for each rewritten statement (KINDS), first runs main's of its kind with the same
// parameters in a nested transaction it rolls back, then the statement itself, recording both one `Side`.
function sideBySide(real: SqlStorage, transact: <T>(fn: () => T) => T, sides: Side[]): SqlStorage {
  return {
    exec: (query: string, ...params: SqlStorageValue[]) => {
      const text = normalized(query);
      const kind = KINDS.find(([pattern]) => pattern.test(text));
      if (kind === undefined) {
        return real.exec(query, ...params);
      }
      const id = kind[1];
      const main = MAIN[id]!;
      if (normalized(main) === text) {
        throw new Error(`main's statement ${id}, not the rewrite`);
      }
      const side: Side = {
        id,
        query,
        mine: { rows: 0, written: 0, result: [] },
        main: { rows: 0, written: 0, result: [] },
      };
      try {
        transact(() => {
          const cursor = real.exec<SqlRow>(main, ...params);
          side.main.result = cursor.toArray();
          side.main.rows = cursor.rowsRead;
          side.main.written = cursor.rowsWritten;
          throw ROLLBACK;
        });
      } catch (error) {
        if (error !== ROLLBACK) {
          throw error;
        }
      }
      sides.push(side);
      const cursor = real.exec<SqlRow>(query, ...params);
      return watchedCursor(
        cursor,
        () => {
          side.mine.rows += cursor.rowsRead;
          side.mine.written = cursor.rowsWritten;
        },
        (rows) => (side.mine.result = rows),
      );
    },
  } as unknown as SqlStorage;
}

const ACCOUNTS = Array.from({ length: 3 }, (_, i) => String(550_000_000_000_000_001n + BigInt(i)));

// Alice (the signer), local accounts below and above her id, and three remote accounts at one shared inbox
// (shared.example), each with a personal inbox there; `n` activities of each other signer, about objects before and
// after the subject's, each with a given-up row; and `own` earlier generations of the subject's object by Alice.
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
    for (const [signer, prefix] of [
      [LOW, "a"],
      [HIGH, "z"],
    ] as const) {
      sql.exec(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO outbound_activities (account_id, body, object_uri, created_at)
				SELECT ?2, json_object('activity', json_object('type', 'Create', 'id', ?3 || i)), 'https://kopje.test/ap/o/' || ?4 || i, ?5
				FROM n`,
        n,
        signer,
        `https://kopje.test/ap/activities/${prefix}`,
        prefix,
        NOW,
      );
    }
    sql.exec(
      `INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, state, next_attempt_at, updated_at)
			SELECT id, account_id, 'https://far.example/inbox', 'https://far.example', 'gave_up', ?1, ?1 FROM outbound_activities`,
      NOW,
    );
  });
  return store;
}

// `own` earlier generations of the subject's object by Alice, each with a given-up row for the shared inbox; and one
// of an object whose URI is the subject's with a NUL and more after it, which no lookup of the subject's may take.
function generations(sql: SqlStorage, object: string, own: number) {
  sql.exec(
    `INSERT INTO outbound_activities (account_id, body, object_uri, created_at)
		VALUES (?1, json_object('activity', json_object('type', 'Update', 'id', ?2)), ?3 || char(0) || 'x', ?4)`,
    ALICE,
    `${ALICE_URI}#nul`,
    object,
    NOW,
  );
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
    `INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, state, next_attempt_at, updated_at)
		SELECT id, account_id, ?1, 'https://shared.example', 'gave_up', ?3, ?3 FROM outbound_activities
		WHERE account_id = ?2 AND object_uri = ?4`,
    SHARED,
    ALICE,
    NOW,
    object,
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

type Flow = {
  // main's statements the flow runs, in the order they first run.
  main: readonly string[];
  // What precedes the measured run, outside it.
  setup?: (db: Db) => void;
  run: (sql: SqlStorage, transact: <T>(fn: () => T) => T) => unknown;
  // What the measured run answers, in part.
  answer?: unknown;
  // The subject's own key grown to `own` (see `count`), and the rows the flow reads at most per row of it.
  own?: { grow: (sql: SqlStorage, own: number) => void; count: string; walks: number };
};

const LEASE = "lease";

// A delivery of Alice's activity to the shared inbox, claimed: `prepare` enqueues it and claims it.
function claimed(sql: SqlStorage, transact: <T>(fn: () => T) => T): string {
  const claim = claimDeliveries.run(sql, { now: NOW, leaseToken: LEASE }, transact);
  const id = claim.deliveries.find((d) => d.inbox === SHARED)?.id;
  if (id === undefined) {
    throw new Error("no delivery to the shared inbox");
  }
  return id;
}

const FLAG: DeliveryEnvelope = {
  activity: {
    type: "Flag",
    id: `${ALICE_URI}#flags/1`,
    actor: "https://kopje.test/actor",
    object: ACCOUNTS.map((_, i) => `https://shared.example/users/r${i}`),
  },
  audience: { followers: false, accounts: ACCOUNTS },
};

const FLOWS: Record<string, Flow> = {
  // An actor Update twice: the second replaces the first's waiting rows, and both expand.
  "an actor Update replacing the waiting ones": {
    main: [
      "a9e710dd668ef93f",
      "403395117854549a",
      "49fa63915b16b036",
      "34a88d39f6885dc4",
      "0d7193e6184aeba1",
      "335e707dbb1daaf0",
      "4bb9cf6368705988",
    ],
    run: (sql) => {
      const db = new Db(sql);
      enqueueActivity(db, ALICE, update(1), NOW);
      enqueueActivity(db, ALICE, update(2), NOW);
    },
    own: {
      grow: (sql, own) => generations(sql, ALICE_URI, own),
      count: `SELECT count(*) AS n FROM outbound_activities WHERE account_id = '${ALICE}' AND object_uri = '${ALICE_URI}'`,
      // Per generation, for each of the two Updates: its activity, its waiting rows deleted (the index entry and the
      // row), its chunks sought: at most three rows.
      walks: 6,
    },
  },
  // A Create, then its Delete: the Delete reaches the Create's rows (receiversOf).
  "a Delete reaching the earlier receivers": {
    main: [
      "34a88d39f6885dc4",
      "0d7193e6184aeba1",
      "335e707dbb1daaf0",
      "4bb9cf6368705988",
      "97a57f06dc7bf735",
      "27a4573d075eb9bf",
    ],
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
    own: {
      grow: (sql, own) => generations(sql, NOTE, own),
      count: `SELECT count(*) AS n FROM outbound_activities WHERE account_id = '${ALICE}' AND object_uri = '${NOTE}'`,
      walks: 4,
    },
  },
  // A Flag to the shared inbox, claimed, confirmed, then delivered: its receipt is sought (none for a Flag).
  "a delivery confirmed and delivered": {
    main: ["34a88d39f6885dc4", "7bf87fad46c9aa1b"],
    answer: { status: "delivered" },
    setup: (db) => {
      enqueueActivity(db, ALICE, FLAG, NOW);
    },
    run: (sql, transact) => {
      const id = claimed(sql, transact);
      confirmDelivery.run(sql, { id, leaseToken: LEASE, now: NOW }, transact);
      return completeDelivery.run(
        sql,
        { id, leaseToken: LEASE, now: NOW, outcome: { kind: "delivered", status: 202 } },
        transact,
      );
    },
  },
  // A forward's row to the shared inbox, failed with 404: it moves to the personal inbox of the one account its
  // provenance names there (forwardFallback).
  "a forward whose shared inbox is gone": {
    main: ["34a88d39f6885dc4", "34d6a8b0dc38a476"],
    answer: { status: "retry" },
    setup: (db) => {
      db.run(
        `INSERT INTO outbound_activities (account_id, body, object_uri, created_at)
				VALUES (?1, json_object('activity', json_object('type', 'Create', 'id', ?2, 'object', ?3),
					'audience', json_object('shares', json_array(?3), 'accounts', json_array())), ?2, ?4)`,
        ALICE,
        `${NOTE}#forward`,
        NOTE,
        NOW,
      );
      db.run(
        `INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, state, next_attempt_at, updated_at,
					recipient_accounts)
				SELECT id, ?1, ?2, 'https://shared.example', 'pending', ?3, ?3, json_array(?4)
				FROM outbound_activities WHERE object_uri = ?5`,
        ALICE,
        SHARED,
        NOW,
        ACCOUNTS[0]!,
        `${NOTE}#forward`,
      );
    },
    run: (sql, transact) => {
      const id = claimed(sql, transact);
      return completeDelivery.run(
        sql,
        {
          id,
          leaseToken: LEASE,
          now: NOW,
          outcome: { kind: "failed", status: 404, error: "HTTP 404", permanent: true },
        },
        transact,
      );
    },
  },
};

async function sides(statistics: (typeof STATISTICS)[number], flow: Flow, n: number, own: number) {
  const store = await world(n);
  return runInDurableObject(store, (_instance, state) => {
    const sql = state.storage.sql;
    const transact = <T>(fn: () => T): T => state.storage.transactionSync(fn);
    flow.own?.grow(sql, own);
    if (flow.setup !== undefined) {
      transact(() => flow.setup!(new Db(sql)));
    }
    const neighbours = sql
      .exec<{ n: number }>("SELECT count(*) AS n FROM outbound_activities WHERE account_id <> ?", ALICE)
      .one().n;
    const ownCount = flow.own === undefined ? 0 : sql.exec<{ n: number }>(flow.own.count).one().n;
    if (statistics === "singleton") {
      singletonStatistics(sql);
    } else {
      sql.exec("ANALYZE");
    }
    const out: Side[] = [];
    const result = transact(() => flow.run(sideBySide(sql, transact, out), transact));
    return { sides: out, neighbours, own: ownCount, result };
  });
}

// The rows read and executions per main statement.
function byStatement(sides: readonly Side[]): Map<string, { rows: number; runs: number }> {
  const out = new Map<string, { rows: number; runs: number }>();
  for (const side of sides) {
    const entry = out.get(side.id) ?? { rows: 0, runs: 0 };
    entry.rows += side.mine.rows;
    entry.runs += 1;
    out.set(side.id, entry);
  }
  return out;
}

describe("main's statements", () => {
  it("are main's audited ones", async () => {
    for (const [id, sql] of Object.entries(MAIN)) {
      expect(await statementId(sql), sql).toBe(id);
    }
  });
});

describe("delivery reads beside main's (RES-7)", () => {
  it.each(STATISTICS.flatMap((statistics) => Object.keys(FLOWS).map((name) => [statistics, name] as const)))(
    "%s statistics: %s",
    async (statistics, name) => {
      const flow = FLOWS[name]!;
      const few = await sides(statistics, flow, FEW, 2);
      const many = await sides(statistics, flow, MANY, 2);
      expect(many.neighbours).toBeGreaterThan(few.neighbours);
      const runs = [few, many];
      const ownMany = flow.own === undefined ? undefined : await sides(statistics, flow, FEW, 40);
      if (ownMany !== undefined) {
        expect(ownMany.own).toBeGreaterThan(few.own);
        runs.push(ownMany);
      }
      for (const run of runs) {
        expect([...new Set(run.sides.map((s) => s.id))], "main's statements, in the order they first run").toEqual(
          flow.main,
        );
        for (const side of run.sides) {
          expect(side.mine.result, side.query).toEqual(side.main.result);
          expect(side.mine.written, side.query).toBe(side.main.written);
          if (statistics === "analyzed") {
            expect(side.mine.rows, side.query).toBeLessThanOrEqual(side.main.rows);
          }
        }
      }
      if (flow.answer !== undefined) {
        expect(few.result).toMatchObject(flow.answer as object);
      }
      expect(many.result).toEqual(few.result);
      // The neighbours: the same rows, statement by statement.
      expect([...byStatement(many.sides)]).toEqual([...byStatement(few.sides)]);
      if (flow.own !== undefined && ownMany !== undefined) {
        // The own key: at least one more row and at most `walks` per generation, summed over the flow.
        const gained = ownMany.own - few.own;
        const sum = (sides: readonly Side[]) => sides.reduce((a, s) => a + s.mine.rows, 0);
        const grown = sum(ownMany.sides) - sum(few.sides);
        expect(grown).toBeGreaterThanOrEqual(gained);
        expect(grown).toBeLessThanOrEqual(flow.own.walks * gained);
      }
    },
    120_000,
  );
});
