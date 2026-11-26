import { BACKUP_RETRY_MS } from "../platform/backup-state";
import { PITR_WINDOW_MS } from "../platform/restore-marker";

// Custom thumbnails of video and audio uploads (#1828 PR6, D26; migration 0123_media_thumbnails). A thumbnail is an
// ordinary image upload of the same account, its own row, id, file token, original and served files, linked to the
// video or audio upload (its parent) by its column thumbnail_of. So backup, restore, rebuild, serving, the sweep and
// tombstones handle it as the image row it is. A child row is never the owner's media (media.ts liveMediaSql, MEDIA-1).
//
// A parent has at most one current child (gc_at NULL, the unique index media_attachments_thumbnail). A child that a
// later thumbnail replaces, or that a removal takes off, is retired: its url is cleared (so no rebuild remakes it, and
// the release below deletes its served files) and its gc_at set THUMBNAIL_KEEP_MS ahead, so a point-in-time restore to
// a bookmark that still names it as current finds its original, and the restore's media rebuild remakes its preview.
// When a parent row is deleted (the sweep's purge, whatever doomed it), the trigger media_attachments_thumbnail_delete
// dooms its current child in the same statement, in the retired shape (url '', gc_at the epoch).
//
// Release (media.ts releasedThumbnails, forgetThumbnailFiles): a retired child's files/<token>/{full,small} are deleted
// by the first sweep batch that lists it, and its preview_url cleared, which ends its place in the release's work list
// (media_attachments_thumbnail_release). Its original and row stay until the sweep takes it past its gc_at, unless a
// backup run that can still copy its original holds it pending (media.ts expiredMedia, the backup hold).

const DAY = 24 * 60 * 60 * 1000;

// How long a retired child keeps its original: the Store's point-in-time window and a day, so any restore that brings
// it back as current lands at least a day before it is swept.
export const THUMBNAIL_KEEP_MS = PITR_WINDOW_MS + DAY;

// How far the sweep moves a held child's gc_at (expiredMedia): the backup's retry interval, the soonest the run that
// holds its original pending copies again.
export const BACKUP_HOLD_RECHECK_MS = BACKUP_RETRY_MS;

// The conditions on a child `c` of the parent `p` that the link (media.ts thumbnailLinkSql) and the overlay share: one
// of the parent's account, a completed image with its URL and content type, and the parent a local video or audio
// upload. The link adds that the child is the owner's live unattached upload; the overlay that it is the parent's
// current one.
export function thumbnailChildSql(c: string, p: string): string {
  return `${c}.account_id = ${p}.account_id AND ${c}.type = 'image' AND ${c}.processed = 1 AND ${c}.url <> ''
			AND ${c}.content_type IS NOT NULL AND ${thumbnailParentSql(p)}`;
}

// Whether `m` may have a thumbnail: a local (its file token) video or audio upload. The link, the trigger's parent
// seek and the import's check use the same test.
export function thumbnailParentSql(m: string): string {
  return `${m}.file_token IS NOT NULL AND ${m}.type IN ('video', 'audio')`;
}

// The column `column` of the current child of the media row `m`, or NULL (no child, or `m` cannot have one): one seek
// of media_attachments_thumbnail. The presenter (status-rows.ts MEDIA_COLUMN_MAP), S3's facts and the Note read it.
export function thumbnailOfSql(m: string, column: "preview_url" | "meta" | "blurhash" | "content_type"): string {
  const t = `${m}_th`;
  return `CASE WHEN ${thumbnailParentSql(m)} THEN (SELECT ${t}.${column}
			FROM media_attachments ${t} INDEXED BY media_attachments_thumbnail
			WHERE ${t}.thumbnail_of = ${m}.id AND ${t}.gc_at IS NULL AND ${thumbnailChildSql(t, m)}) END`;
}

const DOOMED = "'1970-01-01T00:00:00.000Z'";
const REFUSED = "media_attachments: an invalid thumbnail link";

// The shape of a row with thumbnail_of set (`row` NEW): an 18-digit id other than its own, an image with its file
// token, neither attached nor scheduled, and while current (gc_at NULL) completed with its URL. A retired child (gc_at
// ahead), a doomed one (the epoch) and one whose parent is gone keep this shape.
function linkShapeRefusedSql(row: string): string {
  const of = `${row}.thumbnail_of`;
  return `${of} IS NOT NULL AND CASE WHEN typeof(${of}) <> 'text' THEN 1
	WHEN length(CAST(${of} AS BLOB)) <> 18 THEN 1
	WHEN instr(CAST(${of} AS BLOB), x'00') > 0 THEN 1
	WHEN ${of} GLOB '*[^0-9]*' THEN 1
	WHEN ${of} = ${row}.id THEN 1
	WHEN ${row}.type IS NOT 'image' THEN 1
	WHEN ${row}.file_token IS NULL THEN 1
	WHEN ${row}.status_id IS NOT NULL OR ${row}.scheduled_status_id IS NOT NULL THEN 1
	WHEN ${row}.gc_at IS NULL AND (${row}.processed IS NOT 1 OR ${row}.url = '') THEN 1`;
}

// A current child whose parent, sought by its key, is missing, of another account, not local, or not video or audio.
function parentRefusedSql(row: string): string {
  return `WHEN ${row}.gc_at IS NULL AND NOT EXISTS (SELECT 1 FROM media_attachments p WHERE p.id = ${row}.thumbnail_of
		AND p.account_id = ${row}.account_id AND ${thumbnailParentSql("p")}) THEN 1`;
}

const LINK_COLUMNS =
  "id, account_id, thumbnail_of, type, file_token, processed, url, status_id, scheduled_status_id, gc_at";

// The triggers of 0123_media_thumbnails (stored-triggers.ts registers them): the insert guard holds the shape only, so
// an import may insert a child before its parent (store-import.ts ThumbnailLinkCheck checks the link once every row is
// in); the update guard also seeks the parent of a current child; the delete trigger dooms a deleted row's current
// child, through media_attachments_thumbnail.
export const THUMBNAIL_TRIGGERS: readonly string[] = [
  `CREATE TRIGGER media_attachments_thumbnail_insert BEFORE INSERT ON media_attachments
WHEN ${linkShapeRefusedSql("NEW")}
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, '${REFUSED}');
END;`,
  `CREATE TRIGGER media_attachments_thumbnail_update BEFORE UPDATE OF ${LINK_COLUMNS} ON media_attachments
WHEN ${linkShapeRefusedSql("NEW")}
	${parentRefusedSql("NEW")}
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, '${REFUSED}');
END;`,
  `CREATE TRIGGER media_attachments_thumbnail_delete AFTER DELETE ON media_attachments
BEGIN
  UPDATE media_attachments SET gc_at = ${DOOMED}, url = '' WHERE thumbnail_of = OLD.id AND gc_at IS NULL;
END;`,
];
