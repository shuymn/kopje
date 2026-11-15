-- Kopje Store schema 0104: unreadable scheduled params refused. Never edit after release (checksummed).
--
--   scheduled_statuses.params          text with no NUL anywhere, besides the CHECK of 0011_scheduled_statuses (a JSON
--                                      object within 128 KiB), which a BLOB passes and whose json_valid stops at a
--                                      NUL: such a value is not one JSON.parse reads (RES-2, "stored values").
--   scheduled_statuses_params_insert   BEFORE INSERT on scheduled_statuses, and BEFORE UPDATE OF params:
--   scheduled_statuses_params_update   RAISE(ABORT, 'scheduled_statuses: a value past its stored bound') when params
--                                      is not text or holds a NUL. They read no row.
--
-- No row is rewritten: no writer updates params, and a stored row holding such a value reads as unreadable
-- (paramsReadSql in src/domain/scheduled-statuses.ts): left out of the list, not found when shown or updated, and
-- dropped as params when due. The CHECK stays: changing it would recreate scheduled_statuses, a parent table.
--
-- Bounds and the statements: src/domain/scheduled-statuses.ts (paramsPastBoundSql); the triggers are its output as
-- src/domain/stored-triggers.ts registers them (test/migrations.test.ts compares them); stored form:
-- docs/dump-format.md.
--
-- Cost: the triggers read no row when made, and the file reads or writes no row. Measured on the benchmark store of
-- test/bench/migration-cost.ts in workerd's local Durable Object SQLite, the Store's reference check skipped as
-- declared: 66 ms for this file at a load average of about 17 to 41.

CREATE TRIGGER scheduled_statuses_params_insert BEFORE INSERT ON scheduled_statuses
WHEN typeof(NEW.params) <> 'text' OR instr(CAST(NEW.params AS BLOB), x'00') > 0
BEGIN
  SELECT RAISE(ABORT, 'scheduled_statuses: a value past its stored bound');
END;

CREATE TRIGGER scheduled_statuses_params_update BEFORE UPDATE OF params ON scheduled_statuses
WHEN typeof(NEW.params) <> 'text' OR instr(CAST(NEW.params AS BLOB), x'00') > 0
BEGIN
  SELECT RAISE(ABORT, 'scheduled_statuses: a value past its stored bound');
END;
