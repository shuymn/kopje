-- Kopje Store schema 0099: a remote poll's refresh on read (Mastodon 4.7.5's Poll#possibly_stale?). Never edit after
-- release (checksummed).
--
--   polls.fetched_at        NULL, or the Store's time in ms when an Update with this poll was last accepted
--                           (Mastodon's last_fetched_at): an integer from 0 to 2^53 - 1. Every row the upgrade carries
--                           holds NULL, so a remote poll is due at its first signed-in read.
--   polls.refresh_at        NULL, or the Store's time in ms of the last refresh attempt's reservation: the same bound.
--   polls.revision          an integer from 0 to 2^53 - 1, the fence of a refresh (src/domain/polls.ts): issued anew
--                           by polls_revision on every write of the poll and by a refresh's reservation. Every row the
--                           upgrade carries holds 0.
--   polls_revision          AFTER UPDATE OF the poll's columns on polls: a new revision, one row by key.
--   polls_revision_insert   BEFORE INSERT and BEFORE UPDATE OF revision on polls:
--   polls_revision_update   RAISE(ABORT, 'polls: revision past its stored bound') for a value that is not an integer,
--                           or outside 0 to 2^53 - 1.
--
-- Bounds and the predicates: src/platform/stored-bounds.ts (pollRefreshMigrationSql, pollRevisionPastBoundSql,
-- POLL_REVISION_COLUMNS); the statements below are the output of pollRefreshMigrationSql and of
-- src/domain/stored-triggers.ts (test/migrations.test.ts compares them); stored form: docs/dump-format.md.
--
-- Cost: SQLite tests an added CHECK against every existing row, so each of fetched_at and refresh_at reads polls once;
-- revision has a constant default and no CHECK, and reads none. No row is rewritten and no index is made; the
-- triggers read no row. Measured on the benchmark store of test/bench/migration-cost.ts: see the CHANGELOG entry of
-- this file.

ALTER TABLE polls ADD COLUMN fetched_at INTEGER CHECK (fetched_at IS NULL OR (typeof(fetched_at) = 'integer' AND fetched_at BETWEEN 0 AND 9007199254740991));
ALTER TABLE polls ADD COLUMN refresh_at INTEGER CHECK (refresh_at IS NULL OR (typeof(refresh_at) = 'integer' AND refresh_at BETWEEN 0 AND 9007199254740991));
ALTER TABLE polls ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;

CREATE TRIGGER polls_revision_insert BEFORE INSERT ON polls
WHEN CASE WHEN typeof(NEW.revision) <> 'integer' THEN 1
	WHEN NEW.revision NOT BETWEEN 0 AND 9007199254740991 THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'polls: revision past its stored bound');
END;

CREATE TRIGGER polls_revision_update BEFORE UPDATE OF revision ON polls
WHEN CASE WHEN typeof(NEW.revision) <> 'integer' THEN 1
	WHEN NEW.revision NOT BETWEEN 0 AND 9007199254740991 THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'polls: revision past its stored bound');
END;

CREATE TRIGGER polls_revision AFTER UPDATE OF options, cut_options, tallies, multiple, expires_at, votes_count, voters_count, ended, generation, removed, fetched_at ON polls
BEGIN
  UPDATE polls SET revision = (revision + 1 + (random() & 9007199254740991) % 9007199254740991) % 9007199254740992 WHERE status_id = NEW.status_id;
END;
