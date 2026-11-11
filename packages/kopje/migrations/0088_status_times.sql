-- Kopje Store schema 0088: status times in their stored form. Never edit after release (checksummed).
--
--   statuses.published_at          the 24-byte ISO form Kopje writes (isoTimeSql), imports included.
--   statuses.edited_at             NULL, or the same form.
--   statuses_times_insert          BEFORE INSERT and BEFORE UPDATE OF published_at, edited_at on statuses:
--   statuses_times_update          RAISE(ABORT, 'statuses: a time past its stored bound') when either is past it.
--
-- A row past the bound (one converted or restored from a dump) is rewritten, and no status is removed:
--   published_at   the time SQLite reads in it, in the stored form: a value of at most 64 bytes, with no NUL, that
--                  starts with a calendar date and that strftime reads (a space for the T, no fraction, a fraction
--                  longer than milliseconds, cut to them, a zone offset, which it applies, an hour of 24); else the
--                  row's arrival time (created_at) read the same way, as a remote writer stores a time it cannot read;
--                  else the epoch, which no recent window counts, as reads through isoTimeSql already judged it.
--   edited_at      NULL stays NULL; otherwise the time SQLite reads in it, else the row's new published_at, so an
--                  edited status stays edited.
-- A rewritten edited_at fires stream_status_edited, which journals an edit for the streams open, within its span.
--
-- Bounds and the predicate: src/platform/stored-bounds.ts (statusTimesPastBoundSql); the statements below are the
-- output of statusTimesMigrationSql (test/migrations.test.ts compares them); stored form: docs/dump-format.md.
-- Recovery of a rewritten value: the point-in-time bookmark the kernel records before the upgrade (docs/upgrade.md).
--
-- Cost: one walk of statuses, judging each row's two times and rewriting only rows past the bound; the triggers read
-- no row when made. Measured on the benchmark store of test/bench/migration-cost.ts (2,000,000 statuses, 1,000 of them
-- past the bound, beside the rest) in workerd's local Durable Object SQLite, the Store's foreign key check skipped as
-- declared: 903 and 1,034 ms for the upgrade of this file through the kernel at load averages of about 8 and 15, and
-- 9,232 ms in a run whose load rose from 8 to 13, within the budget.

UPDATE statuses SET
  published_at = coalesce(CASE WHEN length(CAST(published_at AS BLOB)) <= 64
	AND instr(CAST(published_at AS BLOB), x'00') = 0
	AND published_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'
	THEN (CASE WHEN length(CAST(strftime('%Y-%m-%dT%H:%M:%fZ', published_at, '+0 seconds') AS BLOB)) = 24 AND substr(strftime('%Y-%m-%dT%H:%M:%fZ', published_at, '+0 seconds'), 12, 2) < '24'
	AND strftime('%Y-%m-%dT%H:%M:%fZ', strftime('%Y-%m-%dT%H:%M:%fZ', published_at, '+0 seconds')) = strftime('%Y-%m-%dT%H:%M:%fZ', published_at, '+0 seconds') THEN strftime('%Y-%m-%dT%H:%M:%fZ', published_at, '+0 seconds') END) END, CASE WHEN length(CAST(created_at AS BLOB)) <= 64
	AND instr(CAST(created_at AS BLOB), x'00') = 0
	AND created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'
	THEN (CASE WHEN length(CAST(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 seconds') AS BLOB)) = 24 AND substr(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 seconds'), 12, 2) < '24'
	AND strftime('%Y-%m-%dT%H:%M:%fZ', strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 seconds')) = strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 seconds') THEN strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 seconds') END) END, '1970-01-01T00:00:00.000Z'),
  edited_at = CASE WHEN edited_at IS NOT NULL THEN coalesce(CASE WHEN length(CAST(edited_at AS BLOB)) <= 64
	AND instr(CAST(edited_at AS BLOB), x'00') = 0
	AND edited_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'
	THEN (CASE WHEN length(CAST(strftime('%Y-%m-%dT%H:%M:%fZ', edited_at, '+0 seconds') AS BLOB)) = 24 AND substr(strftime('%Y-%m-%dT%H:%M:%fZ', edited_at, '+0 seconds'), 12, 2) < '24'
	AND strftime('%Y-%m-%dT%H:%M:%fZ', strftime('%Y-%m-%dT%H:%M:%fZ', edited_at, '+0 seconds')) = strftime('%Y-%m-%dT%H:%M:%fZ', edited_at, '+0 seconds') THEN strftime('%Y-%m-%dT%H:%M:%fZ', edited_at, '+0 seconds') END) END, coalesce(CASE WHEN length(CAST(published_at AS BLOB)) <= 64
	AND instr(CAST(published_at AS BLOB), x'00') = 0
	AND published_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'
	THEN (CASE WHEN length(CAST(strftime('%Y-%m-%dT%H:%M:%fZ', published_at, '+0 seconds') AS BLOB)) = 24 AND substr(strftime('%Y-%m-%dT%H:%M:%fZ', published_at, '+0 seconds'), 12, 2) < '24'
	AND strftime('%Y-%m-%dT%H:%M:%fZ', strftime('%Y-%m-%dT%H:%M:%fZ', published_at, '+0 seconds')) = strftime('%Y-%m-%dT%H:%M:%fZ', published_at, '+0 seconds') THEN strftime('%Y-%m-%dT%H:%M:%fZ', published_at, '+0 seconds') END) END, CASE WHEN length(CAST(created_at AS BLOB)) <= 64
	AND instr(CAST(created_at AS BLOB), x'00') = 0
	AND created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'
	THEN (CASE WHEN length(CAST(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 seconds') AS BLOB)) = 24 AND substr(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 seconds'), 12, 2) < '24'
	AND strftime('%Y-%m-%dT%H:%M:%fZ', strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 seconds')) = strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 seconds') THEN strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 seconds') END) END, '1970-01-01T00:00:00.000Z')) END
WHERE (CASE WHEN length(CAST(statuses.published_at AS BLOB)) = 24 AND substr(statuses.published_at, 12, 2) < '24'
	AND strftime('%Y-%m-%dT%H:%M:%fZ', statuses.published_at) = statuses.published_at THEN statuses.published_at END) IS NULL
  OR (statuses.edited_at IS NOT NULL AND (CASE WHEN length(CAST(statuses.edited_at AS BLOB)) = 24 AND substr(statuses.edited_at, 12, 2) < '24'
	AND strftime('%Y-%m-%dT%H:%M:%fZ', statuses.edited_at) = statuses.edited_at THEN statuses.edited_at END) IS NULL);

CREATE TRIGGER statuses_times_insert BEFORE INSERT ON statuses
WHEN (CASE WHEN length(CAST(NEW.published_at AS BLOB)) = 24 AND substr(NEW.published_at, 12, 2) < '24'
	AND strftime('%Y-%m-%dT%H:%M:%fZ', NEW.published_at) = NEW.published_at THEN NEW.published_at END) IS NULL
  OR (NEW.edited_at IS NOT NULL AND (CASE WHEN length(CAST(NEW.edited_at AS BLOB)) = 24 AND substr(NEW.edited_at, 12, 2) < '24'
	AND strftime('%Y-%m-%dT%H:%M:%fZ', NEW.edited_at) = NEW.edited_at THEN NEW.edited_at END) IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'statuses: a time past its stored bound');
END;

CREATE TRIGGER statuses_times_update BEFORE UPDATE OF published_at, edited_at ON statuses
WHEN (CASE WHEN length(CAST(NEW.published_at AS BLOB)) = 24 AND substr(NEW.published_at, 12, 2) < '24'
	AND strftime('%Y-%m-%dT%H:%M:%fZ', NEW.published_at) = NEW.published_at THEN NEW.published_at END) IS NULL
  OR (NEW.edited_at IS NOT NULL AND (CASE WHEN length(CAST(NEW.edited_at AS BLOB)) = 24 AND substr(NEW.edited_at, 12, 2) < '24'
	AND strftime('%Y-%m-%dT%H:%M:%fZ', NEW.edited_at) = NEW.edited_at THEN NEW.edited_at END) IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'statuses: a time past its stored bound');
END;
