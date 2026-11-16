-- Kopje Store schema 0108: the Removes a block takes out of local collections, delivered to their owners' followers in
-- rounds (src/domain/collection-jobs.ts, RES-6). Never edit after release (checksummed).
--
-- A block records each Remove with its collection's members as targets and leaves its followers to a job, so the
-- block's transaction reads no follower (domain/collections.ts severCollections). The tables mirror moderation_jobs and
-- moderation_reach (0034_admin_suspension):
--
--   collection_jobs          one row per local owner and block: the owner (account_id), the follows it reads (up to
--                            follow_bound, the highest follows.id when the block committed, any 64-bit integer) and
--                            where it stands: phase 'followers' while it reads the owner's accepted followers in id
--                            order into collection_reach (follow_cursor: the last follow read, NULL before the first);
--                            'write' while it writes them to each of its Removes in turn (inbox_cursor: the last inbox
--                            written to the first of them, NULL before the first); 'drop' while it deletes its staged
--                            rows. The retry columns of a job table, as src/domain/job-attempts.ts
--                            jobAttemptColumnsSql writes them (RES-5). A local account is never deleted
--                            (local_accounts is RESTRICTed); its jobs would cascade as moderation_jobs do.
--   collection_job_intents   the job's Removes: outbound_activities ids, without a foreign key (an intent with staged
--                            set is never deleted, deliveries.ts dropSettledActivity), written in id order and deleted
--                            as each is released. A round writes only to an intent of the job's owner that is a Remove
--                            still staging (collection-jobs.ts), whatever an imported row names.
--   collection_reach         the staged follower inboxes, one row per inbox (deliveries.ts isDeliverableInbox, within
--                            COLLECTION_REACH_INBOX_BYTES, 4,096 UTF-8 bytes, no NUL: the CHECK
--                            collection_reach_inbox, whose rule the staging shares). Neither child table cascades:
--                            the job deletes their rows in rounds before itself.
--   collection_jobs_fresh, _failing   the selection's seeks, as jobAttemptIndexesSql writes them.
--
-- No backfill: a block before this upgrade recorded its Removes with their targets.
--
-- Cost: three new tables and two empty indexes; nothing is read or written. A file that creates a table cannot declare
-- foreignKeys: 'unchanged' (test/migration-sql.ts), so its upgrade checks every reference of the Store. Measured on the
-- benchmark store of test/bench/migration-cost.ts in workerd's local Durable Object SQLite: see the CHANGELOG entry of
-- this file.

CREATE TABLE collection_jobs (
  id INTEGER PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES local_accounts (account_id) ON DELETE CASCADE,
  follow_bound INTEGER NOT NULL CONSTRAINT collection_jobs_follow_bound CHECK (typeof(follow_bound) = 'integer'),
  phase TEXT NOT NULL CONSTRAINT collection_jobs_phase CHECK (phase IN ('followers', 'write', 'drop')),
  follow_cursor INTEGER CONSTRAINT collection_jobs_follow_cursor
    CHECK (follow_cursor IS NULL OR typeof(follow_cursor) = 'integer'),
  inbox_cursor TEXT CONSTRAINT collection_jobs_inbox_cursor CHECK (inbox_cursor IS NULL OR (typeof(inbox_cursor) = 'text'
    AND length(CAST(inbox_cursor AS BLOB)) BETWEEN 1 AND 4096 AND instr(CAST(inbox_cursor AS BLOB), x'00') = 0)),
  attempts INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(attempts) = 'integer' AND attempts BETWEEN 0 AND 6),
  due_at INTEGER CHECK (
  (attempts = 0 AND due_at IS NULL)
  OR (attempts BETWEEN 1 AND 5 AND typeof(due_at) = 'integer' AND due_at BETWEEN 0 AND 9007199254740991)
  OR (attempts = 6 AND due_at IS NULL))
);
CREATE INDEX collection_jobs_fresh ON collection_jobs (attempts) WHERE attempts = 0;
CREATE INDEX collection_jobs_failing ON collection_jobs (due_at) WHERE attempts > 0;

CREATE TABLE collection_job_intents (
  job_id INTEGER NOT NULL REFERENCES collection_jobs (id),
  intent_id INTEGER NOT NULL CONSTRAINT collection_job_intents_intent CHECK (typeof(intent_id) = 'integer'),
  PRIMARY KEY (job_id, intent_id)
) WITHOUT ROWID;

CREATE TABLE collection_reach (
  job_id INTEGER NOT NULL REFERENCES collection_jobs (id),
  inbox TEXT NOT NULL CONSTRAINT collection_reach_inbox CHECK (typeof(inbox) = 'text'
    AND length(CAST(inbox AS BLOB)) BETWEEN 1 AND 4096 AND instr(CAST(inbox AS BLOB), x'00') = 0),
  PRIMARY KEY (job_id, inbox)
) WITHOUT ROWID;
