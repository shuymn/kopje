-- Kopje Store schema 0116: whether an attachment's focal point was given (#1767). Never edit after release
-- (checksummed).
--
--   media_attachments.focus_given           1 when a focus was given: an upload's or a media update's `focus`, a
--                                           status edit's media_attributes focus, a remote attachment's focalPoint.
--                                           Mastodon keeps meta.focus only then (MediaAttachment#focus=), so an
--                                           explicit 0,0 is shown and an omitted focus is not. 0 when none was, and on
--                                           every row the upgrade carries, whose stored point the reads go by
--                                           instead: shown when not 0,0 (src/domain/status-rows.ts focusShownSql).
--   media_attachments_focus_given_insert    BEFORE INSERT and BEFORE UPDATE OF focus_given on media_attachments:
--   media_attachments_focus_given_update    RAISE(ABORT, 'media_attachments: focus_given past its stored bound') for
--                                           any value but the integer 0 or 1, imports included. INTEGER affinity
--                                           stores numeric text and an integral REAL as the integer before the
--                                           trigger sees it.
--
-- Bounds and the predicate: src/platform/stored-bounds.ts (focusGivenPastBoundSql); the statements below are its
-- registered triggers (src/domain/stored-triggers.ts, which test/migrations.test.ts holds them to); stored form:
-- docs/dump-format.md.
--
-- Cost: the column has a constant default and no CHECK, so adding it reads and rewrites no row (media_attachments is a
-- parent table, so it is not recreated); no index is made (the column is read only with its row); the triggers read
-- no row and name no other table.

ALTER TABLE media_attachments ADD COLUMN focus_given INTEGER NOT NULL DEFAULT 0;

CREATE TRIGGER media_attachments_focus_given_insert BEFORE INSERT ON media_attachments
WHEN CASE WHEN typeof(NEW.focus_given) <> 'integer' THEN 1
	WHEN NEW.focus_given NOT IN (0, 1) THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'media_attachments: focus_given past its stored bound');
END;

CREATE TRIGGER media_attachments_focus_given_update BEFORE UPDATE OF focus_given ON media_attachments
WHEN CASE WHEN typeof(NEW.focus_given) <> 'integer' THEN 1
	WHEN NEW.focus_given NOT IN (0, 1) THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'media_attachments: focus_given past its stored bound');
END;
