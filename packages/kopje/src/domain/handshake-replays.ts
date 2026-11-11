import { ACCOUNTS_ID_INDEX } from "../db/indexes";
import type { Db } from "../db/sql";
import { followActivity, followAnswerActivity, followUri, recordOutbound } from "./activities";
import { addressedInboxSql, availableLocalSql, availableSql, blockedSql, followableBySql } from "./audience";
import { inboxCovered, isDeliverableInbox, recheckAtSql } from "./deliveries";
import { HANDSHAKE_REPLAYS, nextJob, runJobItem } from "./job-attempts";
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
//   round). It selects one hold (job-attempts.ts nextJob: a due retry by due_at, else the first fresh one by check_at
//   and integer follow id; two index probes at most) and stops at a fresh one not due yet. The item runs in its own
//   savepoint (runJobItem): one that throws backs off and parks, with the admin retry (RES-5).
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
// Rows a step writes: the recording's, and two at most (the hold's delete or move, and its retry state's reset or
// attempt).

// Steps a round runs at most, each in its own transaction.
export const HANDSHAKE_REPLAYS_PER_ROUND = 20;

type Hold = { follow_id: string; check_at: number; attempts: number };

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

// The hold a step may take at `now`: a due retry, else the first fresh hold when its check is due.
function dueHold(db: Db, now: number): Hold | undefined {
  const hold = nextJob<{ follow_id: string; check_at: number }>(db, HANDSHAKE_REPLAYS, now, {
    columns: "CAST(follow_id AS TEXT) AS follow_id, check_at",
  });
  return hold === undefined || (hold.attempts === 0 && hold.check_at > now) ? undefined : hold;
}

export type HandshakeStep = { done: boolean; delivers: boolean };

// One step: done when no hold is due.
export const handshakeReplayStep = writeOperation<{ now: number }, HandshakeStep>((db, { now }) => {
  const hold = dueHold(db, now);
  if (hold === undefined) {
    return { done: true, delivers: false };
  }
  const ran = runJobItem(db, HANDSHAKE_REPLAYS, [hold.follow_id], hold.attempts, now, () =>
    replay(db, hold.follow_id, now),
  );
  return { done: false, delivers: ran.ok && ran.value === "replayed" };
});

// Whether a hold is due at `now` (the same seeks as a step's selection).
export const handshakeReplaysDue = readOperation<{ now: number }, boolean>(
  (db, { now }) => dueHold(db, now) !== undefined,
);
