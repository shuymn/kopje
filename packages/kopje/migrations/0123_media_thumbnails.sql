-- Kopje Store schema 0123: custom thumbnails of video and audio uploads (#1828 PR6; src/domain/media-thumbnails.ts).
-- Never edit after release (checksummed).
--
--   media_attachments.thumbnail_of           NULL, or the id of the video or audio upload whose thumbnail this image
--                                            upload is (its parent). NULL on every row the upgrade carries.
--   media_attachments_thumbnail              a parent's current child (gc_at NULL), at most one: the overlay, the link
--                                            and the delete trigger seek it.
--   media_attachments_thumbnail_release      the retired children whose served files the sweep has yet to delete (url
--                                            '' and preview_url set): the release's work list, empty once released.
--   media_attachments_thumbnail_insert       BEFORE INSERT and BEFORE UPDATE OF the link's columns: RAISE(ABORT,
--   media_attachments_thumbnail_update       'media_attachments: an invalid thumbnail link') for a row with
--                                            thumbnail_of set that is not an 18-digit id other than its own, an image
--                                            with its file token, unattached and unscheduled, and, while current,
--                                            completed with its URL; the update's also for a current child whose
--                                            parent, sought by its key, is missing, of another account, not local or
--                                            not video or audio. The insert's does not seek the parent, so an import
--                                            may insert a child before it (src/platform/store-import.ts
--                                            ThumbnailLinkCheck checks the link once every row is in).
--   media_attachments_thumbnail_delete       AFTER DELETE: the deleted row's current child doomed (gc_at the epoch, url
--                                            ''), through media_attachments_thumbnail.
--
-- The triggers are emitTriggers' output (src/domain/stored-triggers.ts; test/migrations.test.ts compares them);
-- stored form: docs/dump-format.md. The column is dumped with media_attachments.
--
-- Cost: the column has no default and no CHECK, so adding it reads and rewrites no row (media_attachments is a parent
-- table, so it is not recreated); each index is built by one pass over media_attachments and holds no row after it;
-- the guards read no row unless thumbnail_of is set, and the delete trigger one seek of the empty index per deleted
-- row. It adds a unique key to an existing table, so the upgrade checks every reference of the Store
-- (src/db/migrations.ts declares no foreignKeys).

ALTER TABLE media_attachments ADD COLUMN thumbnail_of TEXT;

CREATE UNIQUE INDEX media_attachments_thumbnail ON media_attachments (thumbnail_of)
  WHERE thumbnail_of IS NOT NULL AND gc_at IS NULL;

CREATE INDEX media_attachments_thumbnail_release ON media_attachments (id)
  WHERE thumbnail_of IS NOT NULL AND url = '' AND preview_url IS NOT NULL;

CREATE TRIGGER media_attachments_thumbnail_insert BEFORE INSERT ON media_attachments
WHEN NEW.thumbnail_of IS NOT NULL AND CASE WHEN typeof(NEW.thumbnail_of) <> 'text' THEN 1
	WHEN length(CAST(NEW.thumbnail_of AS BLOB)) <> 18 THEN 1
	WHEN instr(CAST(NEW.thumbnail_of AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.thumbnail_of GLOB '*[^0-9]*' THEN 1
	WHEN NEW.thumbnail_of = NEW.id THEN 1
	WHEN NEW.type IS NOT 'image' THEN 1
	WHEN NEW.file_token IS NULL THEN 1
	WHEN NEW.status_id IS NOT NULL OR NEW.scheduled_status_id IS NOT NULL THEN 1
	WHEN NEW.gc_at IS NULL AND (NEW.processed IS NOT 1 OR NEW.url = '') THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'media_attachments: an invalid thumbnail link');
END;

CREATE TRIGGER media_attachments_thumbnail_update BEFORE UPDATE OF id, account_id, thumbnail_of, type, file_token, processed, url, status_id, scheduled_status_id, gc_at ON media_attachments
WHEN NEW.thumbnail_of IS NOT NULL AND CASE WHEN typeof(NEW.thumbnail_of) <> 'text' THEN 1
	WHEN length(CAST(NEW.thumbnail_of AS BLOB)) <> 18 THEN 1
	WHEN instr(CAST(NEW.thumbnail_of AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.thumbnail_of GLOB '*[^0-9]*' THEN 1
	WHEN NEW.thumbnail_of = NEW.id THEN 1
	WHEN NEW.type IS NOT 'image' THEN 1
	WHEN NEW.file_token IS NULL THEN 1
	WHEN NEW.status_id IS NOT NULL OR NEW.scheduled_status_id IS NOT NULL THEN 1
	WHEN NEW.gc_at IS NULL AND (NEW.processed IS NOT 1 OR NEW.url = '') THEN 1
	WHEN NEW.gc_at IS NULL AND NOT EXISTS (SELECT 1 FROM media_attachments p WHERE p.id = NEW.thumbnail_of
		AND p.account_id = NEW.account_id AND p.file_token IS NOT NULL AND p.type IN ('video', 'audio')) THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'media_attachments: an invalid thumbnail link');
END;

CREATE TRIGGER media_attachments_thumbnail_delete AFTER DELETE ON media_attachments
BEGIN
  UPDATE media_attachments SET gc_at = '1970-01-01T00:00:00.000Z', url = '' WHERE thumbnail_of = OLD.id AND gc_at IS NULL;
END;
