import { runInDurableObject } from "cloudflare:test";

import { Db } from "../src/db/sql";
import type { StoreStub } from "../src/platform/store-client";
import type { StoreOperation } from "../src/platform/store-kernel";
import { seedAccount, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { migratedStore } from "./helpers";

// Fixtures of the unavailable-host tests (domain/delivery-hosts.ts, the drain in domain/deliveries.ts): a Store with a
// local sender, outbound activities and lanes written as the Store writes them, and the host table read back.

export const HOST = "h.example";
export const LANE = "https://h.example";
export const INBOX = "https://h.example/inbox";
export const DAY = 86_400_000;

// Runs an operation in one Store transaction, as the kernel does, with its input as given (a Store time included).
export function run<I, O>(store: StoreStub, operation: Pick<StoreOperation<I, O>, "run">, input: I): Promise<O> {
  return runInDurableObject(store, (_instance, state) =>
    state.storage.transactionSync(() =>
      operation.run(state.storage.sql, input, (fn) => state.storage.transactionSync(fn)),
    ),
  );
}

// Runs `fn` over the Store's Db in one transaction.
export function inDb<T>(store: StoreStub, fn: (db: Db) => T): Promise<T> {
  return runInDurableObject(store, (_instance, state) =>
    state.storage.transactionSync(() => fn(new Db(state.storage.sql))),
  );
}

// A Store with alice, a local account that sends.
export async function sender(): Promise<{ store: StoreStub; alice: string }> {
  const store = await migratedStore();
  const alice = await seedAccount(store, { username: "alice", email: "alice@example.com" });
  return { store, alice };
}

let activities = 0;

// An outbound activity of `account` of `type` (a Follow is sent to an unavailable host; anything else is not); its id.
export async function outbound(store: StoreStub, account: string, type = "Create"): Promise<string> {
  const n = ++activities;
  const [row] = await sql<{ id: string }>(
    store,
    `INSERT INTO outbound_activities (account_id, body, object_uri, created_at)
			VALUES (?1, json_object('activity', json_object('type', ?2, 'id', 'https://kopje.test/ap/a/' || ?3,
				'actor', 'https://kopje.test/ap/users/alice', 'object', 'https://h.example/users/bob')),
				'https://kopje.test/ap/o/' || ?3, ?4)
			RETURNING CAST(id AS TEXT) AS id`,
    account,
    type,
    n,
    NOW,
  );
  return row!.id;
}

// `count` rows of `activity` in the lane, ids ascending, each in `state` and due at `due`; their ids.
export async function rows(
  store: StoreStub,
  input: {
    activity: string;
    account: string;
    lane?: string | ArrayBuffer;
    inbox?: string;
    count?: number;
    state?: "pending" | "queued" | "leased";
    due?: number;
    attempts?: number;
    leaseToken?: string;
  },
): Promise<string[]> {
  const ids = await sql<{ id: string }>(
    store,
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?9)
		INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, state, attempts, lease_token, next_attempt_at,
			updated_at)
		SELECT CAST(?1 AS INTEGER), ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?10 FROM n
		RETURNING CAST(id AS TEXT) AS id`,
    input.activity,
    input.account,
    input.inbox ?? INBOX,
    input.lane ?? LANE,
    input.state ?? "queued",
    input.attempts ?? 0,
    input.leaseToken ?? null,
    input.due ?? NOW,
    input.count ?? 1,
    NOW,
  );
  return ids.map((r) => r.id);
}

// A lane as the Store keeps one: its head pending at `due`, the rest queued; their ids.
export async function lane(
  store: StoreStub,
  input: { activity: string; account: string; lane?: string; inbox?: string; count: number; due?: number },
): Promise<string[]> {
  const head = await rows(store, { ...input, count: 1, state: "pending" });
  return input.count === 1 ? head : [...head, ...(await rows(store, { ...input, count: input.count - 1 }))];
}

// Marks `host` unavailable as an import or an earlier release left it: with its drain at its start, or without one.
export async function markUnavailable(store: StoreStub, host: string, drain: boolean, since = NOW): Promise<void> {
  await sql(
    store,
    `INSERT INTO delivery_hosts (host, failure_days, last_failure_day, unavailable_since, drain_lane, drain_id)
		VALUES (?1, 0, NULL, ?2, CASE WHEN ?3 THEN '' END, CASE WHEN ?3 THEN 0 END)`,
    host,
    since,
    drain ? 1 : 0,
  );
}

export type HostRow = {
  host: string;
  failure_days: number;
  last_failure_day: number | null;
  unavailable_since: number | null;
  drain_lane: string | null;
  drain_id: string | null;
};

export function hostRows(store: StoreStub): Promise<HostRow[]> {
  return sql<HostRow>(
    store,
    `SELECT host, failure_days, last_failure_day, unavailable_since, drain_lane, CAST(drain_id AS TEXT) AS drain_id
		FROM delivery_hosts ORDER BY host`,
  );
}

export type DeliveryState = { id: string; state: string; last_error: string | null; attempts: number };

// Each row's state, in id order (of `ids` only, when given).
export async function states(store: StoreStub, ids?: readonly string[]): Promise<DeliveryState[]> {
  const all = await sql<DeliveryState>(
    store,
    "SELECT CAST(id AS TEXT) AS id, state, last_error, attempts FROM deliveries ORDER BY id",
  );
  return ids === undefined ? all : all.filter((r) => ids.includes(r.id));
}

// How many rows are in each state, as "state: n" sorted.
export async function tally(store: StoreStub, ids?: readonly string[]): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const r of await states(store, ids)) {
    const key = r.state === "gave_up" ? `gave_up: ${r.last_error}` : r.state;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
