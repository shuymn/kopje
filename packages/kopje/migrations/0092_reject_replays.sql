-- Kopje Store schema 0092: held Rejects of follow requests (src/domain/handshake-replays.ts, VIS-30). Never edit after
-- release (checksummed).
--
--   reject_replays        one row per (local account, remote follower) pair whose Reject of a follow request the
--                         send-time check dropped because of its recipient while the pair held no follow
--                         (deliveries.ts HOLD_REJECT), owed until a replay records it again. The Reject is rebuilt from
--                         the row with its original id (followAnswerActivity): follow_uri, the Follow's id
--                         as received (within ACTIVITY_ID_LIMIT, 4,096 JSON-escaped UTF-8 bytes, the CHECK
--                         reject_replays_follow_uri; non-empty, no NUL, TEXT; 682 bytes cannot escape past it), else
--                         edge_id, the ended follow's id (any 64-bit integer, as follows.id may hold after an import);
--                         exactly one of them (reject_replays_name). check_at and the retry columns as in 0088. A local
--                         account is never deleted (local_accounts is RESTRICTed); the follower's purge deletes its
--                         rows before its account (inbox.ts purgeRelationships), so the cascade finds none.
--   reject_replays_follower             the follower's rows: its purge, and an Undo whose target is unknown.
--   reject_replays_fresh, _failing      the selection's seeks, as jobAttemptIndexesSql writes them.
--   reject_replays_follow_stored        a remote follower's new follow of a local account ends the pair's hold: that
--                         generation gets its own answer, and an older Reject would reach it through the pair fallback
--                         of Mastodon's and Misskey's receivers (NET-2). Any other follow insert (a local follower, a
--                         remote target) matches no hold, by the guards below: one seek, zero rows.
--   reject_replays_guard_insert, _update  RAISE(ABORT, 'reject_replays: the follower is local') when the follower's
--                         account is stored with domain NULL (the predicate HOLD_REJECT and the replay use), and
--                         RAISE(ABORT, 'reject_replays: more held Rejects than an account may keep') when a new pair
--                         would give its account more than HELD_REJECTS_PER_ACCOUNT (100) rows; an existing pair
--                         passes (an upsert's BEFORE INSERT fires before its conflict), as 0089's pin cap does.
--                         Each reads the follower by key and at most 100 entries of the unique key's account prefix.
--
-- No backfill: a Reject dropped before this upgrade left no record.
--
-- Cost: a new table, three empty indexes besides its unique key, and three triggers. A file that creates a table cannot
-- declare foreignKeys: 'unchanged' (test/migration-sql.ts), so its upgrade checks every reference of the Store.
-- Measured on the benchmark store of test/bench/migration-cost.ts in workerd's local Durable Object SQLite: see the
-- CHANGELOG entry of this file.

CREATE TABLE reject_replays (
  id INTEGER PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES local_accounts (account_id),
  follower_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  follow_uri TEXT CONSTRAINT reject_replays_follow_uri CHECK (follow_uri IS NULL OR (typeof(follow_uri) = 'text'
    AND length(CAST(follow_uri AS BLOB)) > 0 AND instr(CAST(follow_uri AS BLOB), x'00') = 0
    AND (length(CAST(follow_uri AS BLOB)) <= 682 OR length(CAST(json_quote(follow_uri) AS BLOB)) <= 4098))),
  edge_id INTEGER CONSTRAINT reject_replays_edge_id CHECK (edge_id IS NULL OR typeof(edge_id) = 'integer'),
  check_at INTEGER NOT NULL CONSTRAINT reject_replays_check_at
    CHECK (typeof(check_at) = 'integer' AND check_at BETWEEN 0 AND 9007199254740991),
  attempts INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(attempts) = 'integer' AND attempts BETWEEN 0 AND 6),
  due_at INTEGER CHECK (
  (attempts = 0 AND due_at IS NULL)
  OR (attempts BETWEEN 1 AND 5 AND typeof(due_at) = 'integer' AND due_at BETWEEN 0 AND 9007199254740991)
  OR (attempts = 6 AND due_at IS NULL)),
  CONSTRAINT reject_replays_name CHECK ((follow_uri IS NULL) <> (edge_id IS NULL)),
  UNIQUE (account_id, follower_id)
);
CREATE INDEX reject_replays_follower ON reject_replays (follower_id);
CREATE INDEX reject_replays_fresh ON reject_replays (check_at, id) WHERE attempts = 0;
CREATE INDEX reject_replays_failing ON reject_replays (due_at) WHERE attempts > 0;

CREATE TRIGGER reject_replays_follow_stored AFTER INSERT ON follows
  WHEN (SELECT a.domain FROM accounts a WHERE a.id = NEW.account_id) IS NOT NULL
    AND EXISTS (SELECT 1 FROM local_accounts WHERE account_id = NEW.target_account_id)
BEGIN
  DELETE FROM reject_replays WHERE account_id = NEW.target_account_id AND follower_id = NEW.account_id;
END;

CREATE TRIGGER reject_replays_guard_insert BEFORE INSERT ON reject_replays
BEGIN
  SELECT RAISE(ABORT, 'reject_replays: the follower is local')
    WHERE (SELECT a.domain IS NULL FROM accounts a WHERE a.id = NEW.follower_id) IS 1;
  SELECT RAISE(ABORT, 'reject_replays: more held Rejects than an account may keep')
    WHERE NOT EXISTS (SELECT 1 FROM reject_replays WHERE account_id = NEW.account_id AND follower_id = NEW.follower_id)
      AND (SELECT count(*) FROM (SELECT 1 FROM reject_replays WHERE account_id = NEW.account_id LIMIT 100)) >= 100;
END;

CREATE TRIGGER reject_replays_guard_update BEFORE UPDATE OF account_id, follower_id ON reject_replays
  WHEN NEW.account_id IS NOT OLD.account_id OR NEW.follower_id IS NOT OLD.follower_id
BEGIN
  SELECT RAISE(ABORT, 'reject_replays: the follower is local')
    WHERE (SELECT a.domain IS NULL FROM accounts a WHERE a.id = NEW.follower_id) IS 1;
  SELECT RAISE(ABORT, 'reject_replays: more held Rejects than an account may keep')
    WHERE NEW.account_id IS NOT OLD.account_id
      AND NOT EXISTS (SELECT 1 FROM reject_replays WHERE account_id = NEW.account_id AND follower_id = NEW.follower_id)
      AND (SELECT count(*) FROM (SELECT 1 FROM reject_replays WHERE account_id = NEW.account_id LIMIT 100)) >= 100;
END;
