-- Kopje Store schema 0105: media descriptions bounded by bytes. Never edit after release (checksummed).
--
-- RES-2: media_attachments.description is bounded in UTF-8 bytes as well as in characters. 0048's projection cut it
-- at 10,000 of SQLite's characters, which count a malformed UTF-8 run as one, so an imported value could hold any
-- number of bytes and decode to as many U+FFFD (only an imported row holds one; every writer stores well-formed
-- text), and a BLOB passed it. P becomes mediaDescriptionSql (src/platform/stored-bounds.ts): text cut at 40,000 bytes
-- (MEDIA_DESCRIPTION_BYTES, four times MAX_MEDIA_DESCRIPTION_LENGTH), then at 10,000 characters. On text within
-- 40,000 bytes it is 0048's cut, so no description a writer stores changes. It does:
--
--   media_attachments_bounds_insert   0048's pair dropped, then made again as stored-triggers.ts emits them:
--   media_attachments_bounds_update   RAISE(ABORT, 'media_attachments: a value past its stored bound') when
--                                     P(NEW.x) IS NOT NEW.x for url, preview_url, description or meta, as before,
--                                     with the description's new P.
--
-- Between the two, every description that is not a fixed point of P is set to P(x), keeping no copy: a malformed run
-- or a BLOB. No table is recreated, and the rewrite fires no other trigger (the only others on the table are
-- 0065_media_blurhash's, on blurhash). The statements below are the output of mediaDescriptionBytesMigrationSql and
-- emitTriggers (test/migrations.test.ts compares them); stored form: docs/dump-format.md.
-- Recovery of a rewritten value: the point-in-time bookmark the kernel records before the upgrade (docs/upgrade.md).
--
-- Cost: one scan of media_attachments evaluating P of each description, and a rewrite of the rows P moves; the
-- triggers read no row when made, and the upgrade checks no reference (declared unchanged). Measured on the benchmark
-- store of test/bench/migration-cost.ts (500,000 media attachments, 1,000 of them malformed runs of 50,000 bytes and
-- 1,000 BLOBs of 10,000 bytes, seeded for this file) in workerd's local Durable Object SQLite, timing the whole upgrade
-- through the kernel: 6,630 ms at a load average of 21 to 40. A retry after it checks every reference of the Store
-- (183,681 ms estimated at that load, reported by the bench, not judged).

DROP TRIGGER media_attachments_bounds_insert;

DROP TRIGGER media_attachments_bounds_update;

UPDATE media_attachments SET description = CASE WHEN typeof(description) = 'text' AND length(CAST(description AS BLOB)) <= 10000
	THEN description ELSE substr(coalesce(CAST(substr(CAST(description AS BLOB), 1, 40000) AS TEXT), ''), 1, 10000) END
WHERE (CASE WHEN typeof(description) = 'text' AND length(CAST(description AS BLOB)) <= 10000
	THEN description ELSE substr(coalesce(CAST(substr(CAST(description AS BLOB), 1, 40000) AS TEXT), ''), 1, 10000) END) IS NOT description;

CREATE TRIGGER media_attachments_bounds_insert BEFORE INSERT ON media_attachments
WHEN (CASE WHEN length(CAST(NEW.url AS BLOB)) <= 2048 THEN NEW.url END) IS NOT NEW.url
  OR (CASE WHEN length(CAST(NEW.preview_url AS BLOB)) <= 2048 THEN NEW.preview_url END) IS NOT NEW.preview_url
  OR (CASE WHEN typeof(NEW.description) = 'text' AND length(CAST(NEW.description AS BLOB)) <= 10000
	THEN NEW.description ELSE substr(coalesce(CAST(substr(CAST(NEW.description AS BLOB), 1, 40000) AS TEXT), ''), 1, 10000) END) IS NOT NEW.description
  OR (CASE WHEN length(CAST(NEW.meta AS BLOB)) <= 1024 THEN NEW.meta END) IS NOT NEW.meta
BEGIN
  SELECT RAISE(ABORT, 'media_attachments: a value past its stored bound');
END;

CREATE TRIGGER media_attachments_bounds_update BEFORE UPDATE OF url, preview_url, description, meta ON media_attachments
WHEN (CASE WHEN length(CAST(NEW.url AS BLOB)) <= 2048 THEN NEW.url END) IS NOT NEW.url
  OR (CASE WHEN length(CAST(NEW.preview_url AS BLOB)) <= 2048 THEN NEW.preview_url END) IS NOT NEW.preview_url
  OR (CASE WHEN typeof(NEW.description) = 'text' AND length(CAST(NEW.description AS BLOB)) <= 10000
	THEN NEW.description ELSE substr(coalesce(CAST(substr(CAST(NEW.description AS BLOB), 1, 40000) AS TEXT), ''), 1, 10000) END) IS NOT NEW.description
  OR (CASE WHEN length(CAST(NEW.meta AS BLOB)) <= 1024 THEN NEW.meta END) IS NOT NEW.meta
BEGIN
  SELECT RAISE(ABORT, 'media_attachments: a value past its stored bound');
END;
