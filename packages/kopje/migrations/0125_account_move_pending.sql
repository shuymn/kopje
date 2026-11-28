-- Kopje Store schema 0125: a remote account's pending move (#1561). Never edit after release (checksummed).
--
--   accounts.move_pending          1 while the account's stored actor document names, as its movedTo, a fetchable
--                                  destination Kopje has neither stored nor settled, which the account's collection
--                                  sync fetches one hop (src/domain/remote-collections.ts, the move part), else 0.
--                                  Written by the store of the account's document, a verified Move, the sync's claim
--                                  and completion, and the start of the account's deletion; 0 for every row the
--                                  upgrade carries, until its document is stored again.
--   accounts_move_pending_insert   BEFORE INSERT and BEFORE UPDATE OF move_pending, moved_to_account_id, domain on
--   accounts_move_pending_update   accounts: RAISE(ABORT, 'accounts: move_pending past its stored bound') for a value
--                                  that is not the integer 0 or 1, or 1 on a local row or on one with a move.
--
-- Bounds and the predicate: src/platform/stored-bounds.ts (movePendingPastBoundSql); the statements below are its
-- registered triggers (src/domain/stored-triggers.ts, which test/migrations.test.ts holds them to); stored form:
-- docs/dump-format.md.
--
-- Cost: the column has a constant default and no CHECK, so adding it reads and rewrites no row; no index is made (the
-- column is read only with its row); the triggers read no row and name no other table. accounts is a parent table:
-- nothing is recreated.

ALTER TABLE accounts ADD COLUMN move_pending INTEGER NOT NULL DEFAULT 0;

CREATE TRIGGER accounts_move_pending_insert BEFORE INSERT ON accounts
WHEN CASE WHEN typeof(NEW.move_pending) <> 'integer' THEN 1
	WHEN NEW.move_pending NOT IN (0, 1) THEN 1
	WHEN NEW.move_pending = 1 AND NEW.domain IS NULL THEN 1
	WHEN NEW.move_pending = 1 AND NEW.moved_to_account_id IS NOT NULL THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'accounts: move_pending past its stored bound');
END;

CREATE TRIGGER accounts_move_pending_update BEFORE UPDATE OF move_pending, moved_to_account_id, domain ON accounts
WHEN CASE WHEN typeof(NEW.move_pending) <> 'integer' THEN 1
	WHEN NEW.move_pending NOT IN (0, 1) THEN 1
	WHEN NEW.move_pending = 1 AND NEW.domain IS NULL THEN 1
	WHEN NEW.move_pending = 1 AND NEW.moved_to_account_id IS NOT NULL THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'accounts: move_pending past its stored bound');
END;
