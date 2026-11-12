import { ACCOUNTS_ID_INDEX, LOCAL_ACCOUNTS_ID_INDEX } from "../db/indexes";
import type { Db } from "../db/sql";
import { followActivity, followAnswerActivity, followUri, recordOutbound } from "./activities";
import { addressedInboxSql, availableLocalSql, availableSql, blockedSql, followableBySql } from "./audience";
import { inboxCovered, isDeliverableInbox, recheckAtSql } from "./deliveries";
import { HANDSHAKE_REPLAYS, type JobTable, nextJob, REJECT_REPLAYS, runJobItem } from "./job-attempts";
import { readOperation, writeOperation } from "./operation";

// Held handshakes (VIS-30, migration 0088_handshake_replays). The send-time check drops a Follow or an Accept whose
// recipient is unavailable; when it is its follow's owed handshake, the drop holds that follow
// (deliveries.ts holdHandshake), and this family records the handshake again once the recipient is available, with its
// original id, rebuilt from the follow as it is now (activities.ts: a Follow's id is follows.uri, an Accept's derives
// from the Follow it answers, or from the follow's id without one). A hold says only that the follow's current
// generation is still owed its handshake: the follow's delete cascades to it, and a change of its uri or state ends it
// (handshake_replays_generation), so an old debt is never read as the next generation's.
//
// - Each step is its own write transaction (Store.runHandshakeReplays runs HANDSHAKE_REPLAYS_PER_ROUND of them a
//   round). It selects one hold of either table (dueHold) and stops at a fresh one not due yet. The item runs in its
//   own savepoint (runJobItem): one that throws backs off and parks, with the admin retry (RES-5).
// - The item reads the follow and works out its handshake from it now: a local account's pending follow of a remote
//   account is owed its Follow, a remote account's accepted follow of a local account its Accept; any other follow
//   ends the hold.
// - Eligibility, read live: both accounts available (R1), the remote account's inbox as a Follow or Accept selects it
//   (enqueueActivity: its shared inbox, else its personal one, '' read as none) passes isDeliverableInbox and its host
//   is not covered (inboxCovered), and the follow API's rule for a Follow (followableBySql) or inbound acceptance's
//   for an Accept (the local account blocks neither the follower nor its domain; inbox.ts follow, unlock-accepts.ts).
//   An ineligible hold is moved to the next check (HANDSHAKE_RECHECK_MS) and kept.
// - The handshake is recorded (recordOutbound); the hold ends only when that call inserted an intent with a target,
//   and is otherwise moved to the next check as an ineligible one.
//
// Held Rejects (migration 0092_reject_replays) share the family, its rounds and its recheck. A local account's Reject
// of a remote account's follow request that the check dropped while the pair held no follow holds the pair
// (deliveries.ts HOLD_REJECT): one row per pair, at most HELD_REJECTS_PER_ACCOUNT per account. Its replay
// (replayReject) rebuilds the Reject from the row (activities.ts followAnswerActivity: the Follow's id, else the edge
// id) with both actor uris read by key, so its id is the original's, byte for byte (ID-7).
// - The hold ends with nothing recorded once the pair holds a follow (that generation gets its own answer, and the
//   receiver's pair fallback would apply an older Reject to it, NET-2), or when the follower is not remote
//   (accounts.domain, the guard's predicate) or the local account has no row; only an import can produce either. A
//   follow's insert, the follower's Undo and its purge end it too (reject_replays_follow_stored, inbox.ts
//   cancelUndoneAnswers and purgeRelationships).
// - A stored identity (the Follow id, either actor uri) that is not valid UTF-8 cannot be sent as the original: hashing
//   or signing its decoded form would name another Follow. The item throws (kopje.jobs.reject_replay.invalid_identity,
//   no fields, DATA-5), so it backs off and parks with its hold kept; a repaired uri replays after the admin's retry.
// - Eligibility, read live: both accounts available (R1), and the follower's inbox as a Reject selects it passes
//   isDeliverableInbox and its host is not covered. No block rule: a Reject goes to its whole audience (outboundKind
//   'other'), as Mastodon's block services send it through RejectFollowService.
// Rows a step writes, two at most besides the recording's: a replay, the recording and the hold's delete (a failed
// hold's reset then matches no row); a deferral, the hold's move and its reset; a failure, what the rolled-back item
// wrote (counted all the same, row-budget.ts) and the attempt.

// Steps a round runs at most, each in its own transaction.
export const HANDSHAKE_REPLAYS_PER_ROUND = 20;

// A selected hold: its table, its key (an INTEGER read as TEXT, DATA-6), its check and its retry state.
type Hold = { t: JobTable; key: string; check_at: number; due_at: number | null; attempts: number };

type Follow = {
  id: string;
  state: string;
  uri: string | null;
  follower: string;
  target: string;
  follower_uri: string;
  target_uri: string;
  follower_local: number;
  target_local: number;
};

// The follow by its key, with both accounts by theirs.
const FOLLOW = `SELECT CAST(f.id AS TEXT) AS id, f.state, f.uri, f.account_id AS follower, f.target_account_id AS target,
		fa.uri AS follower_uri, ta.uri AS target_uri, fa.domain IS NULL AS follower_local, ta.domain IS NULL AS target_local
	FROM main.follows f
		CROSS JOIN main.accounts fa INDEXED BY ${ACCOUNTS_ID_INDEX} ON fa.id = f.account_id
		CROSS JOIN main.accounts ta INDEXED BY ${ACCOUNTS_ID_INDEX} ON ta.id = f.target_account_id
	WHERE f.id = CAST(?1 AS INTEGER)`;

// The eligibility of the handshake of local ?1 and remote ?2 (?3: 'Follow' or 'Accept') but for the inbox's checks,
// which read its URL in code: key lookups of both accounts, their blocks and the domain blocks.
const ELIGIBILITY = `SELECT
		(SELECT ${availableLocalSql("l")} FROM main.local_accounts l WHERE l.account_id = ?1) IS 1 AS local,
		${availableSql("?2")} AS remote,
		CASE ?3 WHEN 'Follow' THEN ${followableBySql("?2", "?1")} ELSE NOT ${blockedSql("?1", "?2")} END AS allowed,
		${addressedInboxSql("r")} AS inbox
	FROM main.accounts r INDEXED BY ${ACCOUNTS_ID_INDEX} WHERE r.id = ?2`;

const END = "DELETE FROM handshake_replays WHERE follow_id = CAST(?1 AS INTEGER)";

const RECHECK = `UPDATE handshake_replays SET check_at = ${recheckAtSql("?2")} WHERE follow_id = CAST(?1 AS INTEGER)`;

type Outcome = "replayed" | "deferred" | "ended";

function replay(db: Db, followId: string, now: number): Outcome {
  const follow = db.first<Follow>(FOLLOW, followId);
  const kind =
    follow === undefined
      ? null
      : follow.follower_local === 1 && follow.target_local === 0 && follow.state === "pending"
        ? "Follow"
        : follow.follower_local === 0 && follow.target_local === 1 && follow.state === "accepted"
          ? "Accept"
          : null;
  if (follow === undefined || kind === null) {
    db.run(END, followId);
    return "ended";
  }
  const [local, remote] = kind === "Follow" ? [follow.follower, follow.target] : [follow.target, follow.follower];
  const eligible = db.first<{ local: number; remote: number; allowed: number; inbox: string | null }>(
    ELIGIBILITY,
    local,
    remote,
    kind,
  );
  const deliverable =
    eligible !== undefined &&
    eligible.local === 1 &&
    eligible.remote === 1 &&
    eligible.allowed === 1 &&
    isDeliverableInbox(eligible.inbox) &&
    !inboxCovered(db, eligible.inbox);
  const recorded =
    deliverable &&
    (kind === "Follow"
      ? recordOutbound(
          db,
          local,
          followActivity({
            followUri: follow.uri ?? followUri(follow.follower_uri, follow.id),
            actorUri: follow.follower_uri,
            targetUri: follow.target_uri,
            targetId: follow.target,
          }),
          now,
        )
      : recordOutbound(
          db,
          local,
          followAnswerActivity("Accept", {
            localActorUri: follow.target_uri,
            followerUri: follow.follower_uri,
            followerId: follow.follower,
            followUri: follow.uri,
            edgeId: follow.id,
          }),
          now,
        ));
  if (recorded) {
    db.run(END, followId);
    return "replayed";
  }
  db.run(RECHECK, followId, now);
  return "deferred";
}

// A held Reject with what its replay reads, each by key: the Follow id and both actor uris as their bytes (decoded
// strictly below), the edge id as TEXT (DATA-6), whether the follower is remote and the local account has its row,
// whether the pair holds a follow (follows_pair), and the eligibility but for the inbox's checks, which read its URL
// in code. The hold is read by its rowid in a LIMIT 1 subquery, which stale statistics cannot turn into a scan, as
// deliveries.ts HELD_REJECT reads its intent (RES-7).
const REJECT_HOLD = `SELECT r.account_id AS local_id, r.follower_id, CAST(r.follow_uri AS BLOB) AS follow_uri,
		CAST(r.edge_id AS TEXT) AS edge_id, CAST(la.uri AS BLOB) AS local_uri, CAST(fa.uri AS BLOB) AS follower_uri,
		fa.domain IS NOT NULL AS remote, l.account_id IS NOT NULL AS local,
		EXISTS (SELECT 1 FROM main.follows f INDEXED BY follows_pair
			WHERE f.account_id = r.follower_id AND f.target_account_id = r.account_id) AS followed,
		(l.account_id IS NOT NULL AND ${availableLocalSql("l")}) AS local_available,
		${availableSql("r.follower_id")} AS follower_available, ${addressedInboxSql("fa")} AS inbox
	FROM (SELECT account_id, follower_id, follow_uri, edge_id FROM main.reject_replays
			WHERE id = CAST(?1 AS INTEGER) LIMIT 1) r
		CROSS JOIN main.accounts la INDEXED BY ${ACCOUNTS_ID_INDEX} ON la.id = r.account_id
		CROSS JOIN main.accounts fa INDEXED BY ${ACCOUNTS_ID_INDEX} ON fa.id = r.follower_id
		LEFT JOIN main.local_accounts l INDEXED BY ${LOCAL_ACCOUNTS_ID_INDEX} ON l.account_id = r.account_id`;

type RejectHold = {
  local_id: string;
  follower_id: string;
  follow_uri: ArrayBuffer | null;
  edge_id: string | null;
  local_uri: ArrayBuffer;
  follower_uri: ArrayBuffer;
  remote: number;
  local: number;
  followed: number;
  local_available: number;
  follower_available: number;
  inbox: string | null;
};

const END_REJECT = "DELETE FROM reject_replays WHERE id = CAST(?1 AS INTEGER)";

const RECHECK_REJECT = `UPDATE reject_replays SET check_at = ${recheckAtSql("?2")} WHERE id = CAST(?1 AS INTEGER)`;

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const ENCODER = new TextEncoder();

// The stored bytes as a string when they are valid UTF-8 that encodes back to the same bytes, else null.
function exactText(bytes: ArrayBuffer): string | null {
  let text: string;
  try {
    text = STRICT_UTF8.decode(bytes);
  } catch {
    return null;
  }
  const raw = new Uint8Array(bytes);
  const again = ENCODER.encode(text);
  return again.length === raw.length && again.every((byte, i) => byte === raw[i]) ? text : null;
}

// What a held Reject's item throws when its stored identity is not valid UTF-8 (RES-5: it backs off and parks).
class InvalidRejectIdentity extends Error {}

function replayReject(db: Db, id: string, now: number): Outcome {
  const hold = db.first<RejectHold>(REJECT_HOLD, id);
  if (hold === undefined || hold.remote !== 1 || hold.local !== 1 || hold.followed === 1) {
    db.run(END_REJECT, id);
    return "ended";
  }
  const followUri = hold.follow_uri === null ? null : exactText(hold.follow_uri);
  const localActorUri = exactText(hold.local_uri);
  const followerUri = exactText(hold.follower_uri);
  if ((hold.follow_uri !== null && followUri === null) || localActorUri === null || followerUri === null) {
    console.warn({ event: "kopje.jobs.reject_replay.invalid_identity" });
    throw new InvalidRejectIdentity("a held Reject's identity is not valid UTF-8");
  }
  const deliverable =
    hold.local_available === 1 &&
    hold.follower_available === 1 &&
    isDeliverableInbox(hold.inbox) &&
    !inboxCovered(db, hold.inbox);
  const recorded =
    deliverable &&
    recordOutbound(
      db,
      hold.local_id,
      followAnswerActivity("Reject", {
        localActorUri,
        followerUri,
        followerId: hold.follower_id,
        followUri,
        edgeId: hold.edge_id ?? "",
      }),
      now,
    );
  if (recorded) {
    db.run(END_REJECT, id);
    return "replayed";
  }
  db.run(RECHECK_REJECT, id, now);
  return "deferred";
}

// The hold a step may take at `now`, from either table: each table's job is nextJob's (a due retry by due_at, else its
// first fresh hold by check_at and integer key; two index probes at most). A due retry of either goes first, the
// earlier due_at; else the fresh hold with the earlier check_at, when that check is due. On equal times the
// handshake goes first. A parked hold (due_at NULL) and a backoff not yet due are never nextJob's.
function dueHold(db: Db, now: number): Hold | undefined {
  const next = (t: JobTable, key: string): Hold | undefined => {
    const row = nextJob<{ key: string; check_at: number; due_at: number | null }>(db, t, now, {
      columns: `CAST(${key} AS TEXT) AS key, check_at, due_at`,
    });
    return row === undefined ? undefined : { t, ...row };
  };
  const found = [next(HANDSHAKE_REPLAYS, "follow_id"), next(REJECT_REPLAYS, "id")].filter(
    (hold): hold is Hold => hold !== undefined,
  );
  const retries = found.filter((hold) => hold.attempts > 0);
  const time = (hold: Hold) => (hold.attempts > 0 ? (hold.due_at ?? 0) : hold.check_at);
  let hold: Hold | undefined;
  for (const candidate of retries.length > 0 ? retries : found) {
    if (hold === undefined || time(candidate) < time(hold)) {
      hold = candidate;
    }
  }
  return hold === undefined || (hold.attempts === 0 && hold.check_at > now) ? undefined : hold;
}

export type HandshakeStep = { done: boolean; delivers: boolean };

// One step: done when no hold is due.
export const handshakeReplayStep = writeOperation<{ now: number }, HandshakeStep>((db, { now }) => {
  const hold = dueHold(db, now);
  if (hold === undefined) {
    return { done: true, delivers: false };
  }
  const ran = runJobItem(db, hold.t, [hold.key], hold.attempts, now, () =>
    hold.t === REJECT_REPLAYS ? replayReject(db, hold.key, now) : replay(db, hold.key, now),
  );
  return { done: false, delivers: ran.ok && ran.value === "replayed" };
});

// Whether a hold is due at `now` (the same seeks as a step's selection).
export const handshakeReplaysDue = readOperation<{ now: number }, boolean>(
  (db, { now }) => dueHold(db, now) !== undefined,
);
