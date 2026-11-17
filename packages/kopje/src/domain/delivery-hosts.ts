import type { Db } from "../db/sql";
import { hostDomain, serverDomain } from "../platform/domain-name";
import { MAX_DELIVERY_HOSTS, withinDeliveryHostBound } from "../platform/stored-bounds";
import { writeOperation } from "./operation";

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

// The host deliveries to `inbox` count toward, or null for one Kopje never sends to (an IP literal, a single label,
// past DNS's lengths, not a URL): such a host is not tracked.
export function deliveryHost(inbox: string): string | null {
  try {
    return serverDomain(hostDomain(inbox));
  } catch {
    return null;
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

// The operator's restart (Mastodon's "restart delivery"): the host's row is deleted, its drain with it; rows not
// reached yet are sent, and rows given up stay given up until retried. The host is a stored one, read by
// withinDeliveryHostBound.
export const restartDeliveryHost = writeOperation<{ host: string }, { restarted: boolean }>((db, { host }) => ({
  restarted: withinDeliveryHostBound(host) && clearHost(db, host, "restarted"),
}));
