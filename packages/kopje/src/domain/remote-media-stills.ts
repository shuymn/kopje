import type { Db } from "../db/sql";
import { STILL_OUTPUT_LIMIT } from "../platform/av-bytes";
import { REMOTE_MEDIA_CACHE_MIN_BYTES } from "../platform/config";
import { FILE_TOKEN } from "../platform/media-files";
import { type Marker, restoreTime } from "../platform/restore-marker";
import { SAFE_INTEGER_MAX, STILL_ATTEMPT, STILL_CLAIMS, storedBlurhash } from "../platform/stored-bounds";
import { readState, state, writeState } from "./kopje-state";
import { chargeJob, jobFits } from "./media";
import { writeOperation } from "./operation";
import {
  chargeStill,
  DEFER_MS,
  LANE1_HEADROOM,
  LATE_PUT_MS,
  REMOTE_SETTLE_MS,
  RETRY_DELAYS_MS,
  slotEligibleSql,
  STATE,
  STILL_ROUND_MS,
  type StillsActivation,
  stillsActive,
  stillQualifiesSql,
  usage,
} from "./remote-media";

// Remote video stills (#1828 PR5; MEDIA-7 in docs/threat-model.md; migration 0122_remote_media_stills): the Store's
// operations on remote_media_stills, one row per cached remote video or gifv whose still is queued or recorded, keyed by
// its object's token. The queue (remote-media.ts queueStill, in recordRemoteMedia), the doom delay, the deletion's keys
// and the sweep's rule for unnamed keys (stillKeyKept) are the cache's own transitions, in remote-media.ts.
//
// A key per attempt (F9-A): each claim draws an attempt nonce (STILL_ATTEMPT), and its still is put at
// remote/<token>/s<attempt> and served at /media/r/<token>/s<attempt>.webp once a record names it (the slot's still_key).
// A key no row names is garbage: never charged, presented or adopted, and swept (remote-media.ts stillKeyKept).
//
// Transitions, each one transaction at the Store's time; every charge move requires the object stored and changes the
// ledger row's charge, the row's still_charge, and usage and the audit accumulator (chargeObject) by one delta:
// - claim (claimRemoteStill): a reservation of STILL_OUTPUT_LIMIT (net of an unsettled earlier one), one unit of the
//   stills budget, a fresh attempt, and the lease (remote_still_lease) to it;
// - admission (admitRemoteStill) before the put: one put;
// - record (recordRemoteStill): the slot names the still, the reservation becomes the WebP's bytes;
// - failure (failRemoteStill): the attempt settled once (retry or park), its reservation released;
// - the claim's walk deletes a row that no longer qualifies and releases its charge.
// On a doomed object nothing settles and nothing is charged: its row keeps its attempt and charge until the deletion's
// cascade, and confirmRemoteMediaDeleted subtracts the whole charge. The restore marker is read only where a restore
// changes an answer (withMarker): an attempt claimed at or before the last restore can neither be admitted, record nor
// settle.

// The claim's walk: the most due rows it reads.
export const STILL_CLAIM_WALK = 64;
// The lease a claim takes: past the next 5-minute cron tick, so a round whose stop is unknown holds the next one off.
export const STILL_LEASE_MS = 600 * 1000;

const isTime = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;

type Lease = { holder: string; until: number };

function lease(db: Db): Lease | null {
  try {
    const value = readState<Partial<Lease>>(db, STATE.stillLease);
    return typeof value?.holder === "string" && isTime(value.until)
      ? { holder: value.holder, until: value.until }
      : null;
  } catch {
    return null;
  }
}

// Releases the lease when `attempt` holds it; a stale release (a newer lease) changes nothing.
function release(db: Db, attempt: string): void {
  if (lease(db)?.holder === attempt) {
    db.run("DELETE FROM kopje_state WHERE name = ?1", STATE.stillLease);
  }
}

type Row = {
  state: string;
  claims: number;
  claimed_at: number | null;
  attempt: string | null;
  outcome: string | null;
  still_charge: number;
};

function rowOf(db: Db, token: unknown): Row | undefined {
  return typeof token === "string" && FILE_TOKEN.test(token)
    ? db.first<Row>(
        "SELECT state, claims, claimed_at, attempt, outcome, still_charge FROM remote_media_stills WHERE token = ?1",
        token,
      )
    : undefined;
}

// Whether the object `token` is stored and its slot is its current one, eligible (remote-media.ts slotEligibleSql) and
// qualifying (stillQualifiesSql): the ledger row by its key, then the slot by its rowid (slotRowHolds).
function slotHolds(db: Db, token: string): boolean {
  const object = db.first<{ slot_id: number | null }>(
    "SELECT slot_id FROM remote_media_objects WHERE token = ?1 AND state = 'stored'",
    token,
  );
  return object?.slot_id != null && slotRowHolds(db, object.slot_id, token);
}

// Whether the slot `slot` names `token` and is eligible and qualifying: one seek of its rowid, its eligibility evaluated
// in the projection on that row alone, so the planner cannot turn the terms' EXISTS into joins that walk remote_media.
function slotRowHolds(db: Db, slot: number, token: string): boolean {
  return (
    db.first<{ holds: number }>(
      `SELECT CASE WHEN r.token = ?2 AND ${slotEligibleSql("r")} AND ${stillQualifiesSql("r")} THEN 1 ELSE 0 END AS holds
			FROM remote_media r WHERE r.id = ?1`,
      slot,
      token,
    )?.holds === 1
  );
}

function objectState(db: Db, token: string): string | undefined {
  return db.first<{ state: string }>("SELECT state FROM remote_media_objects WHERE token = ?1", token)?.state;
}

// Whether the claim `claimedAt` follows the last restore (the marker read here: an attempt from before a restore may
// be one the restored Store gave again).
function afterRestore(claimedAt: number, restoredAt: Marker): boolean {
  const restore = restoreTime(restoredAt);
  return restore === null || claimedAt > restore;
}

export type RemoteStillClaim =
  // Nothing to do, decided before the marker: the cap off, stills inactive, the month's unit spent, the lease held by
  // another attempt, or no row due.
  | { status: "idle"; reason: "cap" | "inactive" | "spent" | "leased" | "none" }
  // A restore younger than REMOTE_SETTLE_MS, or one whose validation has not finished.
  | { status: "restoring" }
  // The walk claimed none: rows deleted (no longer qualifying) and deferred (the cap).
  | { status: "walked"; deleted: number; deferred: number }
  | { status: "claimed"; token: string; attempt: string; claims: number; deleted: number; deferred: number };

// The claim of the next due still (at most one a call). Before the marker: `idle` for the cap (`cap`,
// REMOTE_MEDIA_CACHE_BYTES, below REMOTE_MEDIA_CACHE_MIN_BYTES), stills inactive (remote-media.ts stillsActive), the
// month's unit spent, a live lease, or no due row (one seek of remote_media_stills_due). Then the marker: a restore
// younger than REMOTE_SETTLE_MS or not yet validated (remote_media_validated_at) refuses. Then at most STILL_CLAIM_WALK
// due rows by due_at: one whose object is doomed is skipped (its deletion removes it); one whose slot is no longer
// current, eligible or qualifying is deleted and its charge released; one whose net reservation (STILL_OUTPUT_LIMIT less
// an unsettled earlier reservation it replaces) does not fit under the cap less LANE1_HEADROOM is deferred by DEFER_MS
// (reclamation never makes room for a still); the first other is claimed: one unit, the reservation, claims + 1, a
// fresh attempt, due again LATE_PUT_MS later (none after the STILL_CLAIMS-th), and the lease to it.
export const claimRemoteStill = writeOperation.atStoreTime("now")<
  StillsActivation & { cap: number; now: number; restoredAt: Marker },
  RemoteStillClaim
>((db, input) => {
  const { cap, now, restoredAt } = input;
  if (!isTime(now) || now > SAFE_INTEGER_MAX - STILL_LEASE_MS || !isTime(cap) || cap < REMOTE_MEDIA_CACHE_MIN_BYTES) {
    return { status: "idle", reason: "cap" };
  }
  if (!stillsActive(db, input, now)) {
    return { status: "idle", reason: "inactive" };
  }
  if (!jobFits(db, "still", input.budget, now)) {
    return { status: "idle", reason: "spent" };
  }
  const held = lease(db);
  if (held !== null && held.until > now) {
    return { status: "idle", reason: "leased" };
  }
  const due = () =>
    db.first(
      "SELECT 1 AS x FROM remote_media_stills INDEXED BY remote_media_stills_due WHERE due_at <= ?1 LIMIT 1",
      now,
    ) !== undefined;
  if (!due()) {
    return { status: "idle", reason: "none" };
  }
  const restore = restoreTime(restoredAt);
  const validated = Number(state(db, STATE.validated) ?? "-1");
  if (restore !== null && (now - restore < REMOTE_SETTLE_MS || restore > validated)) {
    return { status: "restoring" };
  }
  const walk = db.all<{
    token: string;
    claims: number;
    still_charge: number;
    object: string | null;
    slot: number | null;
  }>(
    `SELECT w.token, st.claims, st.still_charge, o.state AS object, o.slot_id AS slot
			FROM (SELECT token, due_at FROM remote_media_stills INDEXED BY remote_media_stills_due WHERE due_at <= ?1
				ORDER BY due_at LIMIT ${STILL_CLAIM_WALK}) w
			CROSS JOIN remote_media_stills st ON st.token = w.token
			LEFT JOIN remote_media_objects o ON o.token = w.token
			ORDER BY w.due_at, w.token`,
    now,
  );
  const limit = cap - LANE1_HEADROOM;
  let bytes = usage(db).bytes;
  let deleted = 0;
  let deferred = 0;
  for (const row of walk) {
    if (row.object !== "stored") {
      continue;
    }
    // A row due after its last claim (a restore's or an import's) is due no more.
    if (row.claims >= STILL_CLAIMS) {
      db.run("UPDATE remote_media_stills SET due_at = NULL WHERE token = ?1", row.token);
      continue;
    }
    if (row.slot === null || !slotRowHolds(db, row.slot, row.token)) {
      chargeStill(db, row.token, -row.still_charge);
      bytes -= row.still_charge;
      db.run("DELETE FROM remote_media_stills WHERE token = ?1", row.token);
      deleted++;
      continue;
    }
    const net = STILL_OUTPUT_LIMIT - row.still_charge;
    if (bytes + net > limit) {
      db.run("UPDATE remote_media_stills SET due_at = ?2 WHERE token = ?1", row.token, now + DEFER_MS);
      deferred++;
      continue;
    }
    chargeJob(db, "still", input.budget, now);
    const attempt = crypto.randomUUID().replaceAll("-", "");
    const claims = row.claims + 1;
    chargeStill(db, row.token, net);
    db.run(
      `UPDATE remote_media_stills SET claims = ?2, claimed_at = ?3, attempt = ?4, outcome = NULL, still_charge = ?5,
				due_at = ?6 WHERE token = ?1`,
      row.token,
      claims,
      now,
      attempt,
      STILL_OUTPUT_LIMIT,
      claims >= STILL_CLAIMS ? null : now + LATE_PUT_MS,
    );
    writeState(db, STATE.stillLease, { holder: attempt, until: now + STILL_LEASE_MS });
    return { status: "claimed", token: row.token, attempt, claims, deleted, deferred };
  }
  return { status: "walked", deleted, deferred };
});

// Whether `attempt` is the row's current, unsettled attempt on a queued row of the stored object `token`.
function current(row: Row | undefined, attempt: unknown): row is Row & { claimed_at: number; attempt: string } {
  return (
    row !== undefined &&
    typeof attempt === "string" &&
    STILL_ATTEMPT.test(attempt) &&
    row.attempt === attempt &&
    row.state === "queued" &&
    row.outcome === null &&
    row.claimed_at !== null
  );
}

// Admission right before the put of `attempt`'s still: a write (refused in any maintenance, a dump or an import), for
// the row's current, unsettled attempt that holds the live lease, the object stored and its slot current, eligible and
// qualifying, and the claim after the last restore (the marker). Its commit authorizes one put.
export const admitRemoteStill = writeOperation.atStoreTime("now")<
  { token: string; attempt: string; now: number; restoredAt: Marker },
  { admitted: boolean }
>((db, { token, attempt, now, restoredAt }) => {
  const row = rowOf(db, token);
  const held = lease(db);
  if (
    !current(row, attempt) ||
    held === null ||
    held.holder !== attempt ||
    held.until <= now ||
    !slotHolds(db, token)
  ) {
    return { admitted: false };
  }
  return { admitted: afterRestore(row.claimed_at, restoredAt) };
});

export type RemoteStillFacts = { bytes: number; blurhash: string | null };

// The record of `attempt`'s still put at remote/<token>/s<attempt>: `recorded` for a repeat of a committed record before
// the marker; refused unless the attempt is the row's current, unsettled one on a queued row before claimed_at +
// STILL_ROUND_MS (Store time), the object stored and its slot current, eligible and qualifying, the bytes from 1 to
// STILL_OUTPUT_LIMIT, and the claim after the last restore. Then the slot names the still (still_ext webp, still_key,
// its blurhash as storedBlurhash keeps it), the row is stored, its charge becomes the bytes (the ledger and usage by
// bytes − STILL_OUTPUT_LIMIT), and the lease is released.
export const recordRemoteStill = writeOperation.atStoreTime("now")<
  { token: string; attempt: string; facts: RemoteStillFacts; now: number; restoredAt: Marker },
  { status: "recorded" | "refused" }
>((db, { token, attempt, facts, now, restoredAt }) => {
  const row = rowOf(db, token);
  if (row !== undefined && row.state === "stored" && typeof attempt === "string" && row.attempt === attempt) {
    return { status: "recorded" };
  }
  const bytes = facts?.bytes;
  if (
    !current(row, attempt) ||
    !isTime(now) ||
    now >= row.claimed_at + STILL_ROUND_MS ||
    !Number.isSafeInteger(bytes) ||
    bytes < 1 ||
    bytes > STILL_OUTPUT_LIMIT ||
    !slotHolds(db, token) ||
    !afterRestore(row.claimed_at, restoredAt)
  ) {
    return { status: "refused" };
  }
  db.run(
    `UPDATE remote_media SET still_ext = 'webp', still_key = ?2, still_blurhash = ?3
		WHERE id = (SELECT slot_id FROM remote_media_objects WHERE token = ?1)`,
    token,
    `s${attempt}`,
    storedBlurhash(facts.blurhash ?? null),
  );
  chargeStill(db, token, bytes - row.still_charge);
  db.run(
    "UPDATE remote_media_stills SET state = 'stored', due_at = NULL, still_charge = ?2 WHERE token = ?1",
    token,
    bytes,
  );
  release(db, attempt);
  return { status: "recorded" };
});

export type RemoteStillFailure =
  | { status: "settled"; outcome: "retry" | "park" }
  // The object is doomed: nothing settles, the row keeps its attempt and charge until the deletion (the lease is
  // released all the same on a confirmed stop).
  | { status: "doomed" }
  // Not the row's current attempt, or one claimed at or before the last restore.
  | { status: "stale" };

// The failure of `attempt` (design 4.14's outcomes, the round's classification): fenced on the attempt alone (the
// row's current one, unsettled, queued, claimed after the last restore), with no record deadline and no qualification
// check, so a late failure still releases a live reservation. A doomed object answers `doomed` and settles nothing,
// its charge left to the deletion, the lease released as below. On a stored object the first call settles the attempt: its outcome, its reservation released (the ledger and usage by
// −still_charge), and due again at max(claimed_at + LATE_PUT_MS, now + RETRY_DELAYS_MS[claims − 1]) for a retry, never
// for a park or after the STILL_CLAIMS-th claim, and the lease released when the attempt holds it and `keepLease` is
// false (no container started, or its stop confirmed). A replay answers the recorded outcome and writes nothing, the
// lease included, whatever its `keepLease`: a lease a settlement kept lapses at its expiry.
export const failRemoteStill = writeOperation.atStoreTime("now")<
  { token: string; attempt: string; outcome: "retry" | "park"; keepLease: boolean; now: number; restoredAt: Marker },
  RemoteStillFailure
>((db, { token, attempt, outcome, keepLease, now, restoredAt }) => {
  const row = rowOf(db, token);
  // oxlint-disable-next-line typescript/no-unnecessary-boolean-literal-compare -- unchecked RPC input
  const keep = keepLease !== false;
  if (
    row !== undefined &&
    typeof attempt === "string" &&
    row.attempt === attempt &&
    (row.outcome === "retry" || row.outcome === "park")
  ) {
    return { status: "settled", outcome: row.outcome };
  }
  if (!current(row, attempt) || (outcome !== "retry" && outcome !== "park") || !isTime(now)) {
    return { status: "stale" };
  }
  if (!afterRestore(row.claimed_at, restoredAt)) {
    return { status: "stale" };
  }
  if (objectState(db, token) !== "stored") {
    // The doomed object's charge is the deletion's to release; the lease goes with a confirmed stop all the same, so
    // the next tick can claim another video.
    if (!keep) {
      release(db, attempt);
    }
    return { status: "doomed" };
  }
  chargeStill(db, token, -row.still_charge);
  const delay = RETRY_DELAYS_MS[row.claims - 1];
  const dueAt =
    outcome === "park" || row.claims >= STILL_CLAIMS || delay === undefined
      ? null
      : Math.min(Math.max(row.claimed_at + LATE_PUT_MS, now + delay), SAFE_INTEGER_MAX);
  db.run(
    "UPDATE remote_media_stills SET outcome = ?2, still_charge = 0, due_at = ?3 WHERE token = ?1",
    token,
    outcome,
    dueAt,
  );
  if (!keep) {
    release(db, attempt);
  }
  return { status: "settled", outcome };
});
