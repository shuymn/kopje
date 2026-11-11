-- Kopje Store schema 0089: pinned statuses bounded per account. Never edit after release (checksummed).
--
--   status_pins                at most an account's pin limit of rows per account, imports included: PIN_LIMIT (5)
--                              for a local account (accounts.domain IS NULL, which the pin's account row holds
--                              before any pin, whatever order an import's rows come in), MAX_REMOTE_PINS (20) for a
--                              remote one (pinCapSql).
--   status_pins_cap_insert     BEFORE INSERT on status_pins, and BEFORE UPDATE OF account_id when the account
--   status_pins_cap_update     changes: RAISE(ABORT, 'status_pins: more pins than the account may keep') when the
--                              account keeps its limit of other pins. A pin that exists already passes (an upsert, or
--                              ON CONFLICT DO NOTHING). Each reads at most MAX_REMOTE_PINS + 1 rows by primary key.
--
-- An account holding more (a converted or restored row set) keeps its newest pins in pin order, the order its
-- profile and featured collection show them (created_at descending, then status_id descending); the older ones are
-- deleted. Nothing references status_pins and no trigger watches it, so the deletes cascade nothing and journal or
-- notify nothing; no Remove is sent, so a follower that kept the deleted pins keeps them until it reads the featured
-- collection again.
--
-- Bounds and the statements: src/domain/status-actions.ts (pinCapMigrationSql, pinCapSql); the statements below are
-- its output (test/migrations.test.ts compares them); stored form: docs/dump-format.md.
-- Recovery of a deleted pin: the point-in-time bookmark the kernel records before the upgrade (docs/upgrade.md).
--
-- Cost: one walk of status_pins by its primary key to count each account's pins, a sort of the pins of the accounts
-- holding more than PIN_LIMIT, and one delete by key for each pin past a limit; the triggers read no row when made.
-- Measured on the benchmark store of test/bench/migration-cost.ts in workerd's local Durable Object SQLite, the Store's
-- reference check skipped as declared, with 2,400,000 pins, every one of an account past its limit, in two
-- distributions: concentrated (20 local accounts of 120,000, so 2,399,900 deleted, the bench's seed), 10,605 ms for
-- this file at a load average of about 5 to 10, and 11,827 and 12,034 ms for 0088 and 0089 in one upgrade (with 0088's
-- check of every reference) at about 9 to 14; spread (100,000 remote accounts of 22 and 20 local accounts of 10,000, so
-- 399,900 deleted), 4,310 ms for this file and 10,161 and 10,164 ms for both, at about 4 to 9. A retry after such an
-- upgrade checks every reference of the Store (112,371 ms estimated after the concentrated one, reported by the bench,
-- not judged).

DELETE FROM status_pins WHERE (account_id, status_id) IN (
  SELECT c.account_id, c.status_id FROM (
    SELECT p.account_id, p.status_id,
      row_number() OVER (PARTITION BY p.account_id ORDER BY p.created_at DESC, p.status_id DESC) AS n
    FROM status_pins p
    WHERE p.account_id IN (SELECT account_id FROM status_pins GROUP BY account_id HAVING count(*) > 5)
  ) c WHERE c.n > iif((SELECT a.domain FROM accounts a WHERE a.id = c.account_id) IS NULL, 5, 20));

CREATE TRIGGER status_pins_cap_insert BEFORE INSERT ON status_pins
WHEN NOT EXISTS (SELECT 1 FROM status_pins WHERE account_id = NEW.account_id AND status_id = NEW.status_id)
  AND (SELECT count(*) FROM (SELECT 1 FROM status_pins WHERE account_id = NEW.account_id LIMIT 20))
    >= iif((SELECT a.domain FROM accounts a WHERE a.id = NEW.account_id) IS NULL, 5, 20)
BEGIN
  SELECT RAISE(ABORT, 'status_pins: more pins than the account may keep');
END;

CREATE TRIGGER status_pins_cap_update BEFORE UPDATE OF account_id ON status_pins
WHEN NEW.account_id IS NOT OLD.account_id AND NOT EXISTS (SELECT 1 FROM status_pins WHERE account_id = NEW.account_id AND status_id = NEW.status_id)
  AND (SELECT count(*) FROM (SELECT 1 FROM status_pins WHERE account_id = NEW.account_id LIMIT 20))
    >= iif((SELECT a.domain FROM accounts a WHERE a.id = NEW.account_id) IS NULL, 5, 20)
BEGIN
  SELECT RAISE(ABORT, 'status_pins: more pins than the account may keep');
END;
