-- Kopje Store schema 0088: held handshakes (src/domain/handshake-replays.ts, VIS-30). Never edit after release
-- (checksummed).
--
--   handshake_replays     one row per follow whose Follow or Accept the send-time check dropped because of its
--                         recipient (deliveries.ts holdHandshake), owed until a replay records it again: follow_id,
--                         the follows row (the activity is rebuilt from it, with its original id); check_at, when
--                         the replay next reads the follow's availability (a time in ms within 0 to 2^53 - 1); and
--                         the retry columns of a job table, as src/domain/job-attempts.ts jobAttemptColumnsSql writes
--                         them (RES-5). The follow's delete cascades to its hold.
--   handshake_replays_fresh, _failing   the selection's seeks, as jobAttemptIndexesSql writes them: the fresh holds by
--                         check_at and follow id, and the failing ones by due_at.
--   handshake_replays_generation        ends the hold when its follow's uri or state changes: the generation it was
--                         owed for is over, and a replay of the next one must never be read as the old debt.
--
-- No backfill: a Follow or Accept dropped before this upgrade left no record.
--
-- Cost: a new table, two empty indexes and a trigger. A file that creates a table cannot declare foreignKeys:
-- 'unchanged' (test/migration-sql.ts), so its upgrade checks every reference of the Store. Measured on the benchmark
-- store of test/bench/migration-cost.ts in workerd's local Durable Object SQLite: see the CHANGELOG entry of this file.

CREATE TABLE handshake_replays (
  follow_id INTEGER PRIMARY KEY REFERENCES follows (id) ON DELETE CASCADE,
  check_at INTEGER NOT NULL CONSTRAINT handshake_replays_check_at
    CHECK (typeof(check_at) = 'integer' AND check_at BETWEEN 0 AND 9007199254740991),
  attempts INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(attempts) = 'integer' AND attempts BETWEEN 0 AND 6),
  due_at INTEGER CHECK (
  (attempts = 0 AND due_at IS NULL)
  OR (attempts BETWEEN 1 AND 5 AND typeof(due_at) = 'integer' AND due_at BETWEEN 0 AND 9007199254740991)
  OR (attempts = 6 AND due_at IS NULL))
);
CREATE INDEX handshake_replays_fresh ON handshake_replays (check_at, follow_id) WHERE attempts = 0;
CREATE INDEX handshake_replays_failing ON handshake_replays (due_at) WHERE attempts > 0;

CREATE TRIGGER handshake_replays_generation AFTER UPDATE OF uri, state ON follows
  WHEN NEW.uri IS NOT OLD.uri OR NEW.state IS NOT OLD.state
BEGIN
  DELETE FROM handshake_replays WHERE follow_id = OLD.id;
END;
