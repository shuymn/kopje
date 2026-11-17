-- Kopje Store schema 0114: untrusted status counts. Never edit after release (checksummed).
--
--   statuses.untrusted_favourites_count   NULL, or an integer from 0 to 100,000,000 (MAX_UNTRUSTED_COUNT): the
--   statuses.untrusted_reblogs_count      totalItems of a remote status's likes and shares, read as Mastodon 4.7.5
--                                         reads and clamps them (platform/untrusted-count.ts) on a Create and on every
--                                         Update, and moved with the favourites and boosts Kopje counts of it
--                                         (statuses.ts recountStatus). The API shows a remote status's stored one in
--                                         place of its own count (status-rows.ts STATUS_COLUMN_MAP); a local status's
--                                         is never read. NULL: none received (every row the upgrade carries).
--   statuses_untrusted_favourites_insert  BEFORE INSERT and BEFORE UPDATE OF each column on statuses:
--   statuses_untrusted_favourites_update  RAISE(ABORT, 'statuses: <column> past its stored bound') for any value but
--   statuses_untrusted_reblogs_insert     NULL or an integer from 0 to 100,000,000, imports included. INTEGER affinity
--   statuses_untrusted_reblogs_update     stores numeric text and an integral REAL as the integer before the trigger
--                                         sees it.
--
-- Bounds and the predicate: src/platform/stored-bounds.ts (untrustedCountPastBoundSql); the triggers below are the
-- output of src/domain/stored-triggers.ts (test/migrations.test.ts compares them); stored form: docs/dump-format.md.
--
-- Cost: the columns have no default or CHECK, so adding them reads and rewrites no row; no index is made (the columns
-- are read only with their row, by key); the triggers read no row.

ALTER TABLE statuses ADD COLUMN untrusted_favourites_count INTEGER;
ALTER TABLE statuses ADD COLUMN untrusted_reblogs_count INTEGER;

CREATE TRIGGER statuses_untrusted_favourites_insert BEFORE INSERT ON statuses
WHEN CASE WHEN NEW.untrusted_favourites_count IS NULL THEN 0
	WHEN typeof(NEW.untrusted_favourites_count) <> 'integer' THEN 1
	WHEN NEW.untrusted_favourites_count < 0 THEN 1
	WHEN NEW.untrusted_favourites_count > 100000000 THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'statuses: untrusted_favourites_count past its stored bound');
END;

CREATE TRIGGER statuses_untrusted_favourites_update BEFORE UPDATE OF untrusted_favourites_count ON statuses
WHEN CASE WHEN NEW.untrusted_favourites_count IS NULL THEN 0
	WHEN typeof(NEW.untrusted_favourites_count) <> 'integer' THEN 1
	WHEN NEW.untrusted_favourites_count < 0 THEN 1
	WHEN NEW.untrusted_favourites_count > 100000000 THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'statuses: untrusted_favourites_count past its stored bound');
END;

CREATE TRIGGER statuses_untrusted_reblogs_insert BEFORE INSERT ON statuses
WHEN CASE WHEN NEW.untrusted_reblogs_count IS NULL THEN 0
	WHEN typeof(NEW.untrusted_reblogs_count) <> 'integer' THEN 1
	WHEN NEW.untrusted_reblogs_count < 0 THEN 1
	WHEN NEW.untrusted_reblogs_count > 100000000 THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'statuses: untrusted_reblogs_count past its stored bound');
END;

CREATE TRIGGER statuses_untrusted_reblogs_update BEFORE UPDATE OF untrusted_reblogs_count ON statuses
WHEN CASE WHEN NEW.untrusted_reblogs_count IS NULL THEN 0
	WHEN typeof(NEW.untrusted_reblogs_count) <> 'integer' THEN 1
	WHEN NEW.untrusted_reblogs_count < 0 THEN 1
	WHEN NEW.untrusted_reblogs_count > 100000000 THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'statuses: untrusted_reblogs_count past its stored bound');
END;
