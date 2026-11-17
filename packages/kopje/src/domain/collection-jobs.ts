import type { Db } from "../db/sql";
import { REACH_INBOX_BYTES, reachFollowerInboxes } from "./audience";
import { endStaging, isDeliverableInbox, stageTargets } from "./deliveries";
import { COLLECTION_JOBS, nextJob, runJobItem } from "./job-attempts";
import { writeOperation } from "./operation";

// The followers a block's collection Removes reach, read after the block in rounds (RES-6; migration
// 0108_collection_jobs), as Mastodon's CollectionRawDistributionWorker reads CollectionReachFinder's inboxes after
// BlockService. The block records each Remove with its members' targets and no follower (deliveries.ts
// beginFollowerStaging), and one job per local owner naming its Removes (beginCollectionJobs), so its transaction
// reads no follower. A round of a job reads or writes at most COLLECTION_REACH_ROUND rows of one kind:
//   - followers: the owner's accepted followers up to the job's follow_bound, in id order after the cursor
//     (audience.ts reachFollowerInboxes, follows_target's range), staged by inbox in collection_reach, as
//     moderation_reach. Its first round takes the bound, the highest follows.id then, so the followers are those of
//     when the job starts, as Mastodon's worker reads them when it runs; the later rounds keep it, so they end;
//   - write: the staged inboxes after the cursor, in inbox order, written as neutral copies to the job's first Remove
//     (the lowest intent id it names); once they run out the Remove is released (endStaging) and leaves the job, and
//     the next starts from the first inbox. A Remove the row names that is not a staged Remove of the owner (an
//     imported row) gets nothing and leaves the job;
//   - drop: the staged inboxes deleted, then the job.
// Each round moves a cursor or the phase, or deletes rows, so the family counts failures only (RES-5). The followers'
// copies carry no provenance, as a moderation Update's staged reach (VIS-30: the send-time check reads their inbox's
// host alone).

export const COLLECTION_REACH_ROUND = 500;
// The rounds one call runs at most, the jobs taking turns (as MODERATION_ROUNDS).
export const COLLECTION_ROUNDS = 4;
// A staged inbox's bound in UTF-8 bytes: the CHECK collection_reach_inbox, whose rule a followers round judges in SQL
// before it reads an inbox (audience.ts reachInboxSql, the rule every follower's and voter's inbox is read by), so a
// round reads at most COLLECTION_REACH_ROUND × 4,096 bytes of them.
export const COLLECTION_REACH_INBOX_BYTES = REACH_INBOX_BYTES;
// Below every follow id but SQLite's least INTEGER.
const BEFORE_FOLLOWS = "-9223372036854775808";

type Job = {
  id: string;
  account_id: string;
  follow_bound: string | null;
  phase: "followers" | "write" | "drop";
  follow_cursor: string | null;
  inbox_cursor: string | null;
};

const JOB_COLUMNS = `CAST(id AS TEXT) AS id, account_id, CAST(follow_bound AS TEXT) AS follow_bound, phase,
	CAST(follow_cursor AS TEXT) AS follow_cursor, inbox_cursor`;

// The jobs of a block's staged Removes (collections.ts severCollections): one per owner, naming its Removes; its first
// round takes its follow bound. Writes a row per owner and per Remove; returns whether it wrote any.
export function beginCollectionJobs(db: Db, removes: readonly { owner: string; intent: string }[]): boolean {
  const owners = new Map<string, string[]>();
  for (const { owner, intent } of removes) {
    owners.set(owner, [...(owners.get(owner) ?? []), intent]);
  }
  for (const [owner, intents] of owners) {
    const job = db.first<{ id: string }>(
      "INSERT INTO collection_jobs (account_id, phase) VALUES (?, 'followers') RETURNING CAST(id AS TEXT) AS id",
      owner,
    )!.id;
    for (const intent of intents) {
      db.run(
        "INSERT INTO collection_job_intents (job_id, intent_id) VALUES (CAST(? AS INTEGER), CAST(? AS INTEGER))",
        job,
        intent,
      );
    }
  }
  return owners.size > 0;
}

// The remote followers' inboxes collection_reach keeps: within the CHECK collection_reach_inbox's rule (read so, in
// SQL: reachFollowerInboxes) and deliverable (isDeliverableInbox); any other is left out.
function stage(db: Db, job: Job, rows: readonly { inbox: string | null }[]): void {
  for (const inbox of new Set(rows.map((row) => row.inbox))) {
    if (inbox !== null && isDeliverableInbox(inbox)) {
      db.run("INSERT OR IGNORE INTO collection_reach (job_id, inbox) VALUES (CAST(? AS INTEGER), ?)", job.id, inbox);
    }
  }
}

// The job's follow bound from its first followers round on: the highest follows.id then (an index end), kept.
function takeFollowBound(db: Db, job: Job): string {
  return db.first<{ bound: string }>(
    `UPDATE collection_jobs SET follow_bound = (SELECT coalesce(max(id), 0) FROM follows) WHERE id = CAST(? AS INTEGER)
			RETURNING CAST(follow_bound AS TEXT) AS bound`,
    job.id,
  )!.bound;
}

// Whether the intent, sought by its key, is a Remove of the job's owner still staging (CASE reads the body's JSON only
// where it is valid).
const STAGED_REMOVE = `SELECT 1 AS x FROM outbound_activities WHERE id = CAST(?1 AS INTEGER) AND account_id = ?2
	AND retracts = 0 AND staged IS NOT NULL
	AND CASE WHEN json_valid(body) THEN json_extract(body, '$.activity.type') END = 'Remove'`;

// A write round; returns whether it wrote targets.
function writeRound(db: Db, job: Job): boolean {
  const first = db.first<{ intent: string }>(
    `SELECT CAST(intent_id AS TEXT) AS intent FROM collection_job_intents WHERE job_id = CAST(? AS INTEGER)
		ORDER BY intent_id LIMIT 1`,
    job.id,
  );
  if (first === undefined) {
    db.run("UPDATE collection_jobs SET phase = 'drop', inbox_cursor = NULL WHERE id = CAST(? AS INTEGER)", job.id);
    return false;
  }
  const staged = db.first(STAGED_REMOVE, first.intent, job.account_id) !== undefined;
  const inboxes = staged
    ? db
        .all<{ inbox: string }>(
          `SELECT inbox FROM collection_reach WHERE job_id = CAST(?1 AS INTEGER) AND inbox > ?2
						ORDER BY inbox LIMIT ?3`,
          job.id,
          job.inbox_cursor ?? "",
          COLLECTION_REACH_ROUND,
        )
        .map((row) => row.inbox)
    : [];
  const wrote = inboxes.length === 0 ? 0 : stageTargets(db, first.intent, inboxes);
  if (inboxes.length === COLLECTION_REACH_ROUND) {
    db.run("UPDATE collection_jobs SET inbox_cursor = ? WHERE id = CAST(? AS INTEGER)", inboxes.at(-1)!, job.id);
    return wrote > 0;
  }
  if (staged) {
    endStaging(db, first.intent);
  }
  db.run(
    "DELETE FROM collection_job_intents WHERE job_id = CAST(? AS INTEGER) AND intent_id = CAST(? AS INTEGER)",
    job.id,
    first.intent,
  );
  if (job.inbox_cursor !== null) {
    db.run("UPDATE collection_jobs SET inbox_cursor = NULL WHERE id = CAST(? AS INTEGER)", job.id);
  }
  return wrote > 0;
}

// A drop round: the first COLLECTION_REACH_ROUND staged inboxes, in inbox order (up to the last of them, else the
// last of all), then the job once none is left. A job that still names a Remove (an imported row) goes back to write
// it first.
function dropRound(db: Db, job: Job): void {
  const deleted = db.run(
    `DELETE FROM collection_reach WHERE job_id = CAST(?1 AS INTEGER) AND inbox <= coalesce(
			(SELECT inbox FROM collection_reach WHERE job_id = CAST(?1 AS INTEGER) ORDER BY inbox LIMIT 1 OFFSET ?2),
			(SELECT max(inbox) FROM collection_reach WHERE job_id = CAST(?1 AS INTEGER)))`,
    job.id,
    COLLECTION_REACH_ROUND - 1,
  );
  if (deleted === COLLECTION_REACH_ROUND) {
    return;
  }
  if (db.first("SELECT 1 AS x FROM collection_job_intents WHERE job_id = CAST(? AS INTEGER) LIMIT 1", job.id)) {
    db.run("UPDATE collection_jobs SET phase = 'write' WHERE id = CAST(? AS INTEGER)", job.id);
  } else {
    db.run("DELETE FROM collection_jobs WHERE id = CAST(? AS INTEGER)", job.id);
  }
}

// One round of the job; returns whether it wrote targets.
function round(db: Db, job: Job): boolean {
  switch (job.phase) {
    case "followers": {
      const rows = reachFollowerInboxes(
        db,
        job.account_id,
        job.follow_cursor ?? BEFORE_FOLLOWS,
        job.follow_bound ?? takeFollowBound(db, job),
        COLLECTION_REACH_ROUND,
        COLLECTION_REACH_INBOX_BYTES,
      );
      stage(db, job, rows);
      if (rows.length < COLLECTION_REACH_ROUND) {
        db.run(
          "UPDATE collection_jobs SET phase = 'write', follow_cursor = NULL WHERE id = CAST(? AS INTEGER)",
          job.id,
        );
      } else {
        db.run(
          "UPDATE collection_jobs SET follow_cursor = CAST(? AS INTEGER) WHERE id = CAST(? AS INTEGER)",
          rows.at(-1)!.id,
          job.id,
        );
      }
      return false;
    }
    case "write":
      return writeRound(db, job);
    default:
      dropRound(db, job);
      return false;
  }
}

// One round of the next job (nextJob: the first due retry, else the first fresh job after id `after`, else the
// oldest), in its own savepoint (runJobItem): one that throws is rolled back and recorded on its job, which backs off
// and parks after MAX_JOB_ATTEMPTS keeping its rows, while the other jobs run (RES-5). Null when no job may run.
function collectionRound(db: Db, now: number, after: string): { id: string; fresh: boolean; delivers: boolean } | null {
  const job = nextJob<Job>(db, COLLECTION_JOBS, now, { columns: JOB_COLUMNS, after });
  if (job === undefined) {
    return null;
  }
  const ran = runJobItem(db, COLLECTION_JOBS, [job.id], job.attempts, now, () => round(db, job));
  return { id: job.id, fresh: job.attempts === 0, delivers: ran.ok && ran.value };
}

// The collection jobs' next rounds, at most COLLECTION_ROUNDS, failed ones included, fresh jobs taking turns in id
// order (the Queue and the cron run it as a family of its own, src/jobs/queue.ts). pending: a job may run a round now;
// delivers: targets were written.
export const runCollectionJobs = writeOperation<{ now: number }, { pending: boolean; delivers: boolean }>(
  (db, { now }) => {
    let delivers = false;
    let after = "0";
    for (let n = 0; n < COLLECTION_ROUNDS; n++) {
      const ran = collectionRound(db, now, after);
      if (ran === null) {
        break;
      }
      if (ran.fresh) {
        after = ran.id;
      }
      delivers = ran.delivers || delivers;
    }
    return { pending: nextJob(db, COLLECTION_JOBS, now) !== undefined, delivers };
  },
);
