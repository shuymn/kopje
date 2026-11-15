-- Kopje Store schema 0103: the uploads a scheduled status holds bounded. Never edit after release (checksummed).
--
--   media_attachments.scheduled_status_id   at most MAX_STATUS_MEDIA (4) rows per scheduled status, imports included,
--                                            so detaching them (a delete, a publication, a terminal failure) is at
--                                            most four rows (RES-6).
--   media_attachments_scheduled_cap_insert  BEFORE INSERT on media_attachments, and BEFORE UPDATE OF
--   media_attachments_scheduled_cap_update  scheduled_status_id when it changes: RAISE(ABORT, 'media_attachments: more
--                                            media than a scheduled status may hold') when the scheduled status holds
--                                            four uploads other than the row. Each reads at most five rows through
--                                            media_attachments_scheduled.
--
-- Kopje's writer holds at most four (the API refuses more ids, and an attach holds the distinct ones found), so only a
-- restored row set holds more. A scheduled status holding more keeps its first four by (position, id), the four it
-- shows; the others are detached as deleting a scheduled status detaches them: no scheduled status, position 0, and
-- attachable again for a day (DETACHED_GRACE_MS) before the sweep of unattached uploads deletes them. A publication
-- whose params name a detached one is dropped, as for media gone. The detach fires no other trigger (the bound and
-- blurhash triggers watch other columns).
--
-- Bounds and the statements: src/domain/scheduled-statuses.ts (heldFullSql); the triggers are its output as
-- src/domain/stored-triggers.ts registers them (test/migrations.test.ts compares them); stored form:
-- docs/dump-format.md. Recovery of a detached upload's hold: the point-in-time bookmark the kernel records before the
-- upgrade (docs/upgrade.md).
--
-- Cost: one walk of media_attachments_scheduled over the held uploads with a sort of each scheduled status's by
-- (position, id), and one update by key for each upload past four; the triggers read no row when made. Measured on the
-- benchmark store of test/bench/migration-cost.ts in workerd's local Durable Object SQLite, the Store's reference check
-- skipped as declared, with 6,000 scheduled statuses holding four uploads each and the first 100 holding 1,000 more
-- each (124,000 held, 100,000 detached): 5,637 ms for this file at a load average of about 27 to 33.

UPDATE media_attachments SET scheduled_status_id = NULL, position = 0,
  gc_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 day')
WHERE id IN (
  SELECT h.id FROM (
    SELECT m.id, row_number() OVER (PARTITION BY m.scheduled_status_id ORDER BY m.position, m.id) AS n
    FROM media_attachments m
    WHERE m.scheduled_status_id IS NOT NULL
  ) h WHERE h.n > 4);

CREATE TRIGGER media_attachments_scheduled_cap_insert BEFORE INSERT ON media_attachments
WHEN NEW.scheduled_status_id IS NOT NULL
  AND (SELECT count(*) FROM (SELECT 1 FROM media_attachments WHERE scheduled_status_id = NEW.scheduled_status_id AND id <> NEW.id
    LIMIT 4)) >= 4
BEGIN
  SELECT RAISE(ABORT, 'media_attachments: more media than a scheduled status may hold');
END;

CREATE TRIGGER media_attachments_scheduled_cap_update BEFORE UPDATE OF scheduled_status_id ON media_attachments
WHEN NEW.scheduled_status_id IS NOT OLD.scheduled_status_id AND NEW.scheduled_status_id IS NOT NULL
  AND (SELECT count(*) FROM (SELECT 1 FROM media_attachments WHERE scheduled_status_id = NEW.scheduled_status_id AND id <> NEW.id
    LIMIT 4)) >= 4
BEGIN
  SELECT RAISE(ABORT, 'media_attachments: more media than a scheduled status may hold');
END;
