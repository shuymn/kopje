-- Kopje Store schema 0091: the local quotes whose quoting status is not withdrawn, by quoted status. Never edit after
-- release (checksummed).
--
--   quotes.withdrawn                 a local quote's quoting status's statuses.withdrawn; always 0 for a received
--                                    quote. Kept by the three triggers below, which share one rule (for the row NEW:
--                                    CASE WHEN NEW.local = 1 THEN coalesce((SELECT withdrawn FROM statuses WHERE
--                                    id = NEW.status_id), 0) ELSE 0 END) and write only on a mismatch, so restores,
--                                    imports with explicit values and direct writes of the copy, its status_id or its
--                                    local all end consistent. A quote row always follows its status (status_id is a
--                                    NOT NULL reference), so the statuses trigger and the insert trigger together fix
--                                    every order of arrival.
--   quotes_withdrawn_status_changed  AFTER UPDATE OF withdrawn on statuses: the status's local quote takes the value.
--   quotes_withdrawn_inserted        AFTER INSERT on quotes and AFTER UPDATE OF withdrawn, status_id or local on
--   quotes_withdrawn_changed         quotes: the row takes the rule's value.
--   quotes_local_live                the live local quotes of a quoted status, by quoting status: a remote author's
--                                    proven Delete of the quoted status forwards through them (docs/threat-model.md
--                                    VIS-3), from one window that no withdrawn or received quote can fill (RES-7).
--
-- Cost: an ALTER adding a column with a constant default and a CHECK, which SQLite tests against each stored quote; a
-- backfill reading every quote once with a primary-key search of its status (EXPLAIN QUERY PLAN: SCAN quotes, SEARCH s
-- USING INDEX sqlite_autoindex_statuses_1 (id=?)); one index over the quotes. The triggers read no row when made.
-- Measured on the benchmark store of test/bench/migration-cost.ts (its 200,000 quotes and 200,000 local quotes in every
-- state, a share of their quoting statuses withdrawn) in workerd's local Durable Object SQLite, the Store's reference
-- check skipped as declared, three runs each, medians: 427 ms with none withdrawn, 580 ms with half, 581 ms with all,
-- for the upgrade of this file through the kernel, at a load average of about 3 to 9; 567 ms (565 to 570) for 0090 and
-- this file in one upgrade, with all withdrawn, at about 4 to 8.

ALTER TABLE quotes ADD COLUMN withdrawn INTEGER NOT NULL DEFAULT 0 CHECK (withdrawn IN (0, 1));

UPDATE quotes SET withdrawn = 1
WHERE local = 1 AND (SELECT s.withdrawn FROM statuses s WHERE s.id = quotes.status_id) = 1;

CREATE TRIGGER quotes_withdrawn_status_changed AFTER UPDATE OF withdrawn ON statuses
WHEN NEW.withdrawn IS NOT OLD.withdrawn
BEGIN
  UPDATE quotes SET withdrawn = NEW.withdrawn
    WHERE status_id = NEW.id AND local = 1 AND withdrawn IS NOT NEW.withdrawn;
END;

CREATE TRIGGER quotes_withdrawn_inserted AFTER INSERT ON quotes
BEGIN
  UPDATE quotes
    SET withdrawn = CASE WHEN NEW.local = 1
      THEN coalesce((SELECT s.withdrawn FROM statuses s WHERE s.id = NEW.status_id), 0) ELSE 0 END
    WHERE status_id = NEW.status_id AND withdrawn IS NOT CASE WHEN NEW.local = 1
      THEN coalesce((SELECT s.withdrawn FROM statuses s WHERE s.id = NEW.status_id), 0) ELSE 0 END;
END;

CREATE TRIGGER quotes_withdrawn_changed AFTER UPDATE OF withdrawn, status_id, local ON quotes
BEGIN
  UPDATE quotes
    SET withdrawn = CASE WHEN NEW.local = 1
      THEN coalesce((SELECT s.withdrawn FROM statuses s WHERE s.id = NEW.status_id), 0) ELSE 0 END
    WHERE status_id = NEW.status_id AND withdrawn IS NOT CASE WHEN NEW.local = 1
      THEN coalesce((SELECT s.withdrawn FROM statuses s WHERE s.id = NEW.status_id), 0) ELSE 0 END;
END;

CREATE INDEX quotes_local_live ON quotes (quoted_status_id, status_id) WHERE local = 1 AND withdrawn = 0;
