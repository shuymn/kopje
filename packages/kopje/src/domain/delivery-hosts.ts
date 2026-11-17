import type { Db } from "../db/sql";
import { hostDomain, serverDomain } from "../platform/domain-name";
import { MAX_DELIVERY_HOSTS, withinDeliveryHostBound } from "../platform/stored-bounds";
import { readOperation, writeOperation } from "./operation";

// Unavailable delivery hosts (RES-4, RES-5; docs/mastodon-deviations.md, "Unavailable delivery hosts"), as Mastodon's
// DeliveryFailureTracker and UnavailableDomain keep them. delivery_hosts (migration 0112_delivery_hosts) holds one row
// per host a delivery failed to by its own doing since its last success, or that the operator stopped:
//   - Marks: a failed attempt the host caused (hostCaused) adds its UTC day, by the Store's clock, to the host's count
//     once a day; at FAILURE_DAYS the host is unavailable and its drain starts (deliveries.ts drainStep). A new host is
//     not recorded while the table holds MAX_DELIVERY_HOSTS rows (the trigger delivery_hosts_cap refuses it for every
//     writer and an import; the writers read the count first and never reach it).
//   - Clears: the row goes with a delivered row to the host, an activity the Store receives from an actor whose stored
//     inbox is on it, and the operator's restart (clearHost).
//   - Forgets: a host that is not unavailable and whose last counted day is HOST_IDLE_DAYS old goes with the delivery
//     sweep (forgetIdleHosts).
// A host is deliveryHost's key: the inbox's host without its trailing dots (hostDomain), in serverDomain's form, so
// every key a writer stores passes the CHECK delivery_hosts_host (stored-bounds.ts deliveryHostSql). A request naming
// a stored host (the listing's cursor, a restart) is read by withinDeliveryHostBound, that CHECK's twin, and used as
// given.

export const FAILURE_DAYS = 7;
export const HOST_IDLE_DAYS = 30;
// The given-up rows' last_error while their host is unavailable.
export const HOST_UNAVAILABLE = "host unavailable";
const DAY_MS = 86_400_000;
const LIST_LIMIT = 100;

// The host deliveries to `inbox` count toward, or null for one Kopje never sends to (an IP literal, a single label,
// past DNS's lengths, not a URL): such a host is not tracked.
export function deliveryHost(inbox: string): string | null {
  try {
    return serverDomain(hostDomain(inbox));
  } catch {
    return null;
  }
}

// Where a failed delivery stopped (federation/delivery.ts postActivity), which hostCaused judges:
//   - resolve: resolveDeliveryHost (federation/loader.ts, NET-3) answered no public address: `none` (an empty answer or
//     only non-IP entries), `private`, or a lookup `error` with its code (null when it has none);
//   - key: the signer's key or the Store's confirmation; sign: the keyring's signature; budget: the lease budget ran
//     out before anything was sent;
//   - post: the POST's answer or its fetch's network error.
// timeout: the budget's timer ended the stage, `whole` when the budget was the whole timeout, `cut` when the round's
// deadline shortened it.
export type FailureStage = {
  stage: "resolve" | "key" | "sign" | "post" | "budget";
  resolution?: "private" | "none" | "error";
  code?: string | null;
  timeout?: "whole" | "cut";
};

// The lookup codes that say the name or its records do not exist (Node's dns.lookup and workerd's), which count as the
// host's; any other code, or none, is the resolver's.
const NO_SUCH_NAME: ReadonlySet<string> = new Set(["ENOTFOUND", "ENODATA"]);

// Whether a failure is the remote host's doing (docs/mastodon-deviations.md, "Unavailable delivery hosts"): an answer
// that the name has no IP address or only non-public ones, a POST's answer that is neither 2xx nor permanent, a fetch's
// network error, or a timeout that ran the whole budget in the POST. Never a resolver failure, the signer's key, its
// confirmation or signature, an exhausted or shortened budget, nor a permanent answer (Mastodon's unsalvageable one,
// which neither counts nor clears). Mastodon's other unsalvageable case, a 401 to a sender deleted for good, has no
// Kopje sender: Kopje never deletes a local account, and a suspended one stands for Mastodon's suspension with its
// deletion request pending, for which Mastodon counts the 401; a future local deletion adds that case here. A failure
// without a stage (an outcome Kopje's sink did not make) counts nothing.
export function hostCaused(failure: FailureStage | undefined, permanent: boolean): boolean {
  if (failure === undefined || permanent) {
    return false;
  }
  switch (failure.stage) {
    case "resolve":
      return (
        failure.timeout === undefined &&
        (failure.resolution === "none" ||
          failure.resolution === "private" ||
          (failure.resolution === "error" && failure.code != null && NO_SUCH_NAME.has(failure.code)))
      );
    case "post":
      return failure.timeout !== "cut";
    default:
      return false;
  }
}

// The UTC day of a Store time, as last_failure_day stores it.
export function dayOf(now: number): number {
  return Math.floor(now / DAY_MS);
}

// The SET terms that make a host unavailable on the failure that counts its FAILURE_DAYS-th day, its drain starting
// at the lane '' and id 0 (deliveries.ts drainStep). Each reads the old row, so the four are set together, and a later
// day of an unavailable host keeps its cursor.
const STARTS = `unavailable_since IS NULL AND failure_days + 1 >= ${FAILURE_DAYS}`;

// Counts a failure the host caused (hostCaused) on the Store's day of `now`: once a day, the FAILURE_DAYS-th making it
// unavailable. A host without a row is recorded only while the table has room (MAX_DELIVERY_HOSTS); past it the
// failure is not recorded (kopje.delivery.hosts_full) and an existing host still counts. Reads: the host's row by its
// key, and the table's count only for a host without one (at most MAX_DELIVERY_HOSTS short keys).
export function recordHostFailure(db: Db, host: string, now: number): void {
  const day = dayOf(now);
  const row = db.first<{ counted: number; starts: number }>(
    `SELECT last_failure_day IS NOT NULL AND last_failure_day >= ?2 AS counted, ${STARTS} AS starts
		FROM delivery_hosts WHERE host = ?1`,
    host,
    day,
  );
  if (row === undefined) {
    if (hostCount(db) >= MAX_DELIVERY_HOSTS) {
      // DATA-5: no host in the log; the operator lists them.
      console.warn({ event: "kopje.delivery.hosts_full" });
      return;
    }
    db.run("INSERT INTO delivery_hosts (host, failure_days, last_failure_day) VALUES (?, 1, ?)", host, day);
    return;
  }
  if (row.counted === 1) {
    return;
  }
  db.run(
    `UPDATE delivery_hosts SET failure_days = min(failure_days + 1, ${FAILURE_DAYS}), last_failure_day = ?2,
			unavailable_since = CASE WHEN ${STARTS} THEN ?3 ELSE unavailable_since END,
			drain_lane = CASE WHEN ${STARTS} THEN '' ELSE drain_lane END,
			drain_id = CASE WHEN ${STARTS} THEN 0 ELSE drain_id END
		WHERE host = ?1`,
    host,
    day,
    now,
  );
  if (row.starts === 1) {
    // DATA-5: no host in the log; `kopje-admin hosts` lists it.
    console.warn({ event: "kopje.delivery.host_unavailable" });
  }
}

function hostCount(db: Db): number {
  return db.first<{ n: number }>("SELECT count(*) AS n FROM delivery_hosts")?.n ?? 0;
}

export type HostClear = "delivered" | "received" | "restarted";

// Deletes the host's row, its count, mark and drain with it; logs kopje.delivery.host_restored with its cause when the
// host was unavailable. Returns whether a row was deleted.
export function clearHost(db: Db, host: string | null, cause: HostClear): boolean {
  if (host === null) {
    return false;
  }
  const gone = db.first<{ unavailable: number }>(
    "DELETE FROM delivery_hosts WHERE host = ? RETURNING unavailable_since IS NOT NULL AS unavailable",
    host,
  );
  if (gone?.unavailable === 1) {
    // DATA-5: the cause only.
    console.warn({ event: "kopje.delivery.host_restored", cause });
  }
  return gone !== undefined;
}

// The longest inbox URL the clear on receipt reads (federation/remote-actor.ts INBOX_URL_LIMIT, the ingestion's cap; a
// longer imported value is not read).
const RECEIVED_INBOX_BYTES = 2048;

// Clears the host of the stored inbox of the account that sent an activity the Store receives (inbox.ts receive), as
// Mastodon's inbox resets its signer's inbox host. The inbox may name any host, as Mastodon stores it, so a signer can
// clear a host it does not control (docs/threat-model.md RES-5, an accepted gap). Reads the account by its key.
export function clearSenderHost(db: Db, accountId: string): void {
  const inbox = db.first<{ inbox: string | null }>(
    `SELECT CASE WHEN typeof(inbox_url) = 'text' AND length(CAST(inbox_url AS BLOB)) <= ${RECEIVED_INBOX_BYTES}
			THEN inbox_url END AS inbox FROM accounts WHERE id = ?`,
    accountId,
  )?.inbox;
  if (inbox !== null && inbox !== undefined) {
    clearHost(db, deliveryHost(inbox), "received");
  }
}

// Whether the host is unavailable now. One read by its key.
export function hostUnavailable(db: Db, host: string | null): boolean {
  return (
    host !== null &&
    db.first("SELECT 1 AS yes FROM delivery_hosts WHERE host = ? AND unavailable_since IS NOT NULL", host) !== undefined
  );
}

// Forgets at most `limit` hosts that are not unavailable and whose last counted day is HOST_IDLE_DAYS or more before
// the Store's day of `now`, oldest first through delivery_hosts_idle. Returns how many.
export function forgetIdleHosts(db: Db, now: number, limit: number): number {
  return db.all(
    `DELETE FROM delivery_hosts WHERE host IN (SELECT host FROM delivery_hosts INDEXED BY delivery_hosts_idle
			WHERE unavailable_since IS NULL AND last_failure_day <= ?1 ORDER BY last_failure_day LIMIT ?2)
		RETURNING 1 AS gone`,
    dayOf(now) - HOST_IDLE_DAYS,
    limit,
  ).length;
}

// Makes `host` unavailable now (the operator's stop, as Mastodon's "stop delivery"), its drain starting again at its
// beginning; one already unavailable keeps its time. A new host when the table is full first takes the place of the
// available host with the oldest counted day (kopje.delivery.host_evicted); with every host unavailable it is refused
// and nothing is written. The host must pass deliveryHostSql (the route reads it with serverDomain).
export function markStopped(db: Db, host: string, now: number): "stopped" | "hosts-full" {
  if (db.first("SELECT 1 AS yes FROM delivery_hosts WHERE host = ?", host) === undefined) {
    if (hostCount(db) >= MAX_DELIVERY_HOSTS) {
      const evicted = db.first(
        `DELETE FROM delivery_hosts WHERE host = (SELECT host FROM delivery_hosts INDEXED BY delivery_hosts_idle
					WHERE unavailable_since IS NULL ORDER BY last_failure_day LIMIT 1) RETURNING 1 AS gone`,
      );
      if (evicted === undefined) {
        return "hosts-full";
      }
      // DATA-5: no host in the log.
      console.warn({ event: "kopje.delivery.host_evicted" });
    }
  }
  db.run(
    `INSERT INTO delivery_hosts (host, failure_days, unavailable_since, drain_lane, drain_id) VALUES (?1, 0, ?2, '', 0)
		ON CONFLICT (host) DO UPDATE SET unavailable_since = coalesce(unavailable_since, excluded.unavailable_since),
			drain_lane = '', drain_id = 0`,
    host,
    now,
  );
  return "stopped";
}

// A host as the operator sees it: lastFailureDay as YYYY-MM-DD, unavailableSince as an ISO time (null past the range a
// Date shows, which only an import can store).
export type DeliveryHost = {
  host: string;
  failureDays: number;
  lastFailureDay: string | null;
  unavailableSince: string | null;
  draining: boolean;
};

export type DeliveryHostsPage = { hosts: DeliveryHost[]; next: string | null };

const MAX_DATE_MS = 8_640_000_000_000_000;

function isoOf(ms: number | null): string | null {
  return ms === null || ms > MAX_DATE_MS ? null : new Date(ms).toISOString();
}

// The stored hosts in host order after `after` (a stored host, withinDeliveryHostBound; the route refuses anything
// else), at most `limit` (1 to LIST_LIMIT), and the next `after` when the page is full.
export const deliveryHostsPage = readOperation<{ after?: string; limit?: number }, DeliveryHostsPage>(
  (db, { after, limit }) => {
    const max = Math.max(1, Math.min(limit ?? LIST_LIMIT, LIST_LIMIT));
    const rows = db.all<{
      host: string;
      failure_days: number;
      last_failure_day: number | null;
      unavailable_since: number | null;
      draining: number;
    }>(
      `SELECT host, failure_days, last_failure_day, unavailable_since, drain_lane IS NOT NULL AS draining
			FROM delivery_hosts WHERE host > ?1 ORDER BY host LIMIT ?2`,
      after ?? "",
      max,
    );
    return {
      hosts: rows.map((r) => ({
        host: r.host,
        failureDays: r.failure_days,
        lastFailureDay: r.last_failure_day === null ? null : (isoOf(r.last_failure_day * DAY_MS)?.slice(0, 10) ?? null),
        unavailableSince: isoOf(r.unavailable_since),
        draining: r.draining === 1,
      })),
      next: rows.length === max ? (rows.at(-1)?.host ?? null) : null,
    };
  },
);

// The operator's restart (Mastodon's "restart delivery"): the host's row is deleted, its drain with it; rows not
// reached yet are sent, and rows given up stay given up until retried. The host is a stored one, read by
// withinDeliveryHostBound.
export const restartDeliveryHost = writeOperation<{ host: string }, { restarted: boolean }>((db, { host }) => ({
  restarted: withinDeliveryHostBound(host) && clearHost(db, host, "restarted"),
}));
