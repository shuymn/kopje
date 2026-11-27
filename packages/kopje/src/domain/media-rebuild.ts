import { ACCOUNTS_ID_INDEX, MEDIA_ID_INDEX } from "../db/indexes";
import type { Db } from "../db/sql";
import type { ImageRole } from "../platform/images";
import { iso } from "../platform/iso-time";
import { mediaUrl } from "../platform/media-files";
import { type Marker, restoreTime } from "../platform/restore-marker";
import type { ImportAuthority } from "../platform/store-admin";
import { PITR_RESTORING, PITR_RESTORING_MS, REBUILD_LEASE } from "../platform/store-flags";
import { MEDIA_META_BYTES, storedBlurhash } from "../platform/stored-bounds";
import { accessAdminRefusal } from "./admin-authority";
import {
  chargeInstanceTransforms,
  chargeUploadJob,
  ownerUri,
  profileStaticSql,
  uploadJobFits,
  TRANSFORMS_PER_EMOJI,
  TRANSFORMS_PER_UPLOAD,
  uploadMediaMeta,
} from "./media";
import {
  claimProbeIn,
  probeDue,
  type ProbeProfile,
  type ProbeRecord,
  type ProbeResult,
  probeState,
  recordProbeResultIn,
} from "./media-probes";
import { mediaRebuildOperation, readOperation } from "./operation";

// The media rebuild (mastodon/media-rebuild.ts): local media whose row is complete but whose served files are not in R2
// get them made again from their original. That is media restored from a backup (which holds only the originals) and
// the images the cutover moved out of Cloudflare Images (`convert --images`).
//
// The Store does not know which files exist in R2, and no column says so: an upload completes only after its files
// are written, and a restore or a conversion writes rows whose files were never made. So the Store lists every
// complete local row with a file token, in id order, and the Worker asks R2 for each. Rows that are doomed (gc_at
// passed) are left to the sweep. One listing scans at most SCAN_WINDOW rows by id, whatever they are, and returns at
// most REBUILD_PAGE candidates from them, with the id it scanned to: a long run of rows that are not candidates (remote,
// doomed) costs bounded work per call and is not scanned again.
//
// The rebuild runs only while nothing can delete media: the Store is unpublished after a verified import, or its
// readonly maintenance has lasted REBUILD_SETTLE_MS. Then no delete_media, sweep or reconciliation runs (their Store
// writes are refused before they touch R2), none decided before is still running, and while the lease is live the
// Store also refuses leaving maintenance and every media-deleting write (platform/store-flags.ts), so no row can go
// while its files are written. And one rebuild call runs at a time, under a lease kept in kopje_state
// (REBUILD_LEASE), so no two calls charge and write the same row; while the lease is live the Store refuses to begin
// an import, reset one, reset a cutover or publish (platform/store-admin.ts), so the rows cannot change under it.
//
// Its writes (the lease, the transformation counter, the meta of a rebuilt row) are 'media-rebuild' operations, which
// the operator gate admits in readonly maintenance and while a verified import is unpublished (platform/store-flags.ts).
// Each checks the Access admin again in its transaction, as the cutover operations do (platform/store-admin.ts), and
// the counter and meta writes also the caller's lease.

export const REBUILD_PAGE = 50;
export const SCAN_WINDOW = 500;

// emoji: the row is a custom emoji's image (migration 0055_local_custom_emojis), which the rebuild holds to the emoji
// limits too (mastodon/media-rebuild.ts, platform/emoji-image.ts). av: for a video or audio row (#1828: its served
// file is the media processor's verified output, content_type video/mp4 or audio/mpeg), its kind, whether it has a
// preview, the preview's geometry in meta.small (as stored, any JSON value) and its blurhash; null for any other row.
// A JSON value of meta as json_extract returns it (an object or array comes back as its JSON text).
type StoredScalar = string | number | null;
export type RebuildAv = {
  kind: "video" | "audio";
  preview: boolean;
  // The bytes of the row's meta with meta.small set to {"width":0,"height":0}, as recordAvStill sets it; null when
  // meta is not a JSON object (or NULL), which cannot take a still (avMetaFits).
  metaBytes: number | null;
  small: { width: StoredScalar; height: StoredScalar } | null;
  blurhash: string | null;
};
// role: the row's own account, when local, names it as its header (`header`, also when it names it as its avatar too,
// so nothing is cropped from the header) or as its avatar (`avatar`), which gives its files that image's shape
// (platform/images.ts processImage); null for a custom emoji's row and any other.
export type RebuildRow = {
  id: string;
  token: string;
  contentType: string | null;
  emoji: boolean;
  role: ImageRole | null;
  av: RebuildAv | null;
};

// meta.small of one-digit edges: a still's meta.small is longer by its edges' further digits.
const SMALLEST_SMALL = JSON.stringify({ width: 0, height: 0 });

// Whether recordAvStill can record a still of `small` in the row's meta: an object, within MEDIA_META_BYTES as SQLite
// serializes it with this meta.small (the length of SMALLEST_SMALL's form and the edges' further digits).
export function avMetaFits(av: Pick<RebuildAv, "metaBytes">, small: Size): boolean {
  const digits = (n: number) => String(n).length - 1;
  return av.metaBytes !== null && av.metaBytes + digits(small.width) + digits(small.height) <= MEDIA_META_BYTES;
}

// A video or audio row by its served type and its kind, which must agree.
const AV_SQL = `((type = 'video' AND content_type = 'video/mp4') OR (type = 'audio' AND content_type = 'audio/mpeg'))`;

// rows: the candidates; next: the id the listing scanned to (the next listing starts after it); done: nothing is after
// it.
export type RebuildPage = { rows: RebuildRow[]; next: string | null; done: boolean };

// Complete local media with a token that is not doomed: what is served, or should be.
const ELIGIBLE = `file_token IS NOT NULL AND processed = 1 AND url <> '' AND (gc_at IS NULL OR gc_at > ?)`;

export const rebuildCandidates = readOperation.atStoreTime("now")<{ after: string | null; now: number }, RebuildPage>((
  db,
  { after, now },
) => {
  const scanned = db.all<{ id: string }>(
    "SELECT id FROM media_attachments WHERE id > ? ORDER BY id LIMIT ?",
    after ?? "",
    SCAN_WINDOW,
  );
  const last = scanned.at(-1)?.id;
  if (last === undefined) {
    return { rows: [], next: after, done: true };
  }
  type Listed = Omit<RebuildRow, "emoji" | "av"> & {
    emoji: number;
    kind: "video" | "audio" | null;
    preview: number;
    metaBytes: number | null;
    smallWidth: SqlStorageValue;
    smallHeight: SqlStorageValue;
    hasSmall: number;
    blurhash: string | null;
  };
  const rows = db
    .all<Listed>(
      `SELECT id, file_token AS token, content_type AS contentType,
				EXISTS (SELECT 1 FROM custom_emojis e WHERE e.id = media_attachments.id) AS emoji,
				CASE WHEN ${AV_SQL} THEN type END AS kind, preview_url IS NOT NULL AS preview,
				json_type(meta, '$.small') IS NOT NULL AS hasSmall,
				CASE WHEN meta IS NULL OR json_type(meta) = 'object'
					THEN length(CAST(json_set(COALESCE(meta, '{}'), '$.small', json(?)) AS BLOB)) END AS metaBytes,
				json_extract(meta, '$.small.width') AS smallWidth, json_extract(meta, '$.small.height') AS smallHeight,
				blurhash,
				(SELECT CASE WHEN pa.header_url = media_attachments.url THEN 'header'
						WHEN pa.avatar_url = media_attachments.url THEN 'avatar' END
					FROM accounts pa INDEXED BY ${ACCOUNTS_ID_INDEX}
					WHERE pa.id = media_attachments.account_id AND pa.domain IS NULL) AS role
			FROM media_attachments WHERE ${ELIGIBLE} AND id > ? AND id <= ? ORDER BY id LIMIT ?`,
      SMALLEST_SMALL,
      iso(now),
      after ?? "",
      last,
      REBUILD_PAGE,
    )
    .map(({ emoji, kind, preview, metaBytes, smallWidth, smallHeight, hasSmall, blurhash, role, ...row }) => ({
      ...row,
      emoji: emoji === 1,
      // An emoji's row has no role, whatever names it (it is built under the emoji limits).
      role: emoji === 1 ? null : role,
      av:
        kind === null
          ? null
          : {
              kind,
              preview: preview === 1,
              metaBytes,
              small: hasSmall === 1 ? { width: smallWidth as StoredScalar, height: smallHeight as StoredScalar } : null,
              blurhash,
            },
    }));
  if (rows.length === REBUILD_PAGE) {
    return { rows, next: rows.at(-1)?.id ?? last, done: false };
  }
  return { rows, next: last, done: scanned.length < SCAN_WINDOW };
});

// Whether a row is still a candidate with this token: the rebuild of a video or audio row asks after its files are
// written (mastodon/media-rebuild-av.ts).
export const rebuildRowLive = readOperation.atStoreTime("now")<{ id: string; token: string; now: number }, boolean>(
  (db, { id, token, now }) =>
    db.first(
      `SELECT 1 AS found FROM media_attachments WHERE id = ? AND file_token = ? AND ${ELIGIBLE}`,
      id,
      token,
      iso(now),
    ) !== undefined,
);

// IMPORT_TOKEN and import sessions never rebuild: the cutover runs this through Access, after the token is retired.
function adminRefused(db: Db, authority: ImportAuthority): string | null {
  return accessAdminRefusal(db, authority, "only an Access admin rebuilds media");
}

// The rebuild's lease (REBUILD_LEASE in kopje_state; not dumped, imported or reset). Every rebuild operation runs at
// the Store's own time (atStoreTime, whatever the Worker's clock says), so acquisition, ownership and the fences of
// store-admin.ts read one clock. A call renews it before each row and, while an R2 write it started is pending,
// every REBUILD_HEARTBEAT_MS (mastodon/media-rebuild.ts), so it never expires under a write while the call runs; each
// renewal names the generation of the call's take (rebuildLease), so none outlives the take it was for.
export const REBUILD_LEASE_MS = 10 * 60 * 1000;

// How long the Store's readonly maintenance must have lasted before a rebuild writes: longer than any invocation that
// fetched a sweep or reconciliation batch before it began can still run (a cron invocation has at most 15 minutes of
// wall time; the sweep after an API delete runs in waitUntil, at most 30 seconds after its response), so no deletion
// decided before readonly can land during the rebuild. An unpublished import needs none: the import began on an empty
// Store and every write has been refused since it was verified, so no deletion was ever decided for a row it brought.
export const REBUILD_SETTLE_MS = 20 * 60 * 1000;

// `generation`: the fencing token of one take of the lease, one more than the take before it. A release keeps it with
// `until` 0, so the next take is a new generation and no renewal of the released one succeeds. A lease stored without
// one (before generations) is generation 0.
type Lease = { holder: string; until: number; generation: number };

function readLease(db: Db): Lease | null {
  const value = db.first<{ value: string }>("SELECT value FROM kopje_state WHERE name = ?", REBUILD_LEASE)?.value;
  if (value === undefined) {
    return null;
  }
  const lease = JSON.parse(value) as Partial<Lease> & { holder: string; until: number };
  return { ...lease, generation: Number.isSafeInteger(lease.generation) ? lease.generation! : 0 };
}

function writeLease(db: Db, lease: Lease): void {
  db.run("INSERT OR REPLACE INTO kopje_state (name, value) VALUES (?, ?)", REBUILD_LEASE, JSON.stringify(lease));
}

function holds(db: Db, holder: string, now: number): boolean {
  const lease = readLease(db);
  return lease !== null && lease.holder === holder && lease.until > now;
}

function flag<T>(db: Db, name: string): T | null {
  const value = db.first<{ value: string }>("SELECT value FROM kopje_state WHERE name = ?", name)?.value;
  return value === undefined ? null : (JSON.parse(value) as T);
}

// Whether the Store has refused every media-deleting write long enough (the flags of platform/store-flags.ts): 'ok'
// while a verified import is unpublished, or once its readonly maintenance has lasted REBUILD_SETTLE_MS. A PITR restore
// rewinds those flags, so both count only from the last restore (`restoredAt`, recorded outside the database): an
// unpublished flag from before it is not ready, and maintenance settles from the later of its start and the restore.
// An active restore, or neither flag, decides by itself, so only the checks after them ask for the marker
// (restoreTime).
function readiness(
  db: Db,
  now: number,
  marker: Marker,
): { status: "ok" } | { status: "needs-readonly" } | { status: "restoring" } | { status: "settling"; readyAt: number } {
  const restoring = flag<{ at: number }>(db, PITR_RESTORING);
  if (restoring !== null && restoring.at > now - PITR_RESTORING_MS) {
    return { status: "restoring" };
  }
  const unpublished = flag<{ at: number }>(db, "unpublished");
  const maintenance = flag<{ at: number }>(db, "maintenance");
  if (unpublished === null && maintenance === null) {
    return { status: "needs-readonly" };
  }
  const restoredAt = restoreTime(marker);
  if (unpublished !== null && (restoredAt === null || unpublished.at > restoredAt)) {
    return { status: "ok" };
  }
  if (maintenance === null) {
    return { status: "needs-readonly" };
  }
  const readyAt = Math.max(maintenance.at, restoredAt ?? 0) + REBUILD_SETTLE_MS;
  return now >= readyAt ? { status: "ok" } : { status: "settling", readyAt };
}

export type RebuildLeaseResult =
  | { status: "ok"; remainingMs: number; generation: number }
  | { status: "released" }
  // A renewal of a generation that is not the live one (released, expired or taken since). A release never answers it.
  | { status: "lost" }
  | { status: "needs-readonly" }
  | { status: "settling"; readyAt: number }
  | { status: "restoring" }
  | { status: "busy"; remainingMs: number }
  | { status: "denied"; reason: string };

// Takes the lease for `holder` (for REBUILD_LEASE_MS from the Store's `now`) as a new generation, renews it, or releases
// it. With `generation` (the take's answer) a renewal succeeds only for that generation while it is live and the
// holder's: one that arrives after the release, after the lease ended or after another call took it is `lost` and
// changes nothing, so it can never take the lease back. A release is idempotent: it ends that generation when it is the
// holder's, and otherwise (released already, or a later generation, even the same holder's, now live) changes nothing,
// answering `released` either way. Without `generation`, a holder that holds the live lease renews it and a release by
// a holder that no longer holds it changes nothing.
export const rebuildLease = mediaRebuildOperation.atStoreTime("now")<
  {
    authority: ImportAuthority;
    holder: string;
    generation?: number;
    release?: boolean;
    restoredAt: Marker;
    now: number;
  },
  RebuildLeaseResult
>((db, { authority, holder, generation, release, restoredAt, now }) => {
  const refused = adminRefused(db, authority);
  if (refused !== null) {
    return { status: "denied", reason: refused };
  }
  const lease = readLease(db);
  const mine =
    lease !== null && lease.holder === holder && (generation === undefined || lease.generation === generation);
  if (release === true) {
    if (mine && lease.until > 0) {
      writeLease(db, { ...lease, until: 0 });
    }
    return { status: "released" };
  }
  const live = lease !== null && lease.until > now;
  if (generation !== undefined && !(mine && live)) {
    return { status: "lost" };
  }
  // Acquiring or renewing waits on the restore's time (readiness); a release never asks for it.
  const ready = readiness(db, now, restoredAt);
  if (ready.status !== "ok") {
    return ready;
  }
  if (live && lease.holder !== holder) {
    return { status: "busy", remainingMs: lease.until - now };
  }
  const next = live ? lease.generation : (lease?.generation ?? 0) + 1;
  writeLease(db, { holder, until: now + REBUILD_LEASE_MS, generation: next });
  return { status: "ok", remainingMs: REBUILD_LEASE_MS, generation: next };
});

export type RebuildCharge =
  | { status: "ok" }
  | { status: "budget_exhausted" }
  | { status: "lease-lost" }
  | { status: "denied"; reason: string };

// Charges one rebuilt row's transformations to the instance's budget of the month `now` is in, before Images is called,
// as its writer charged them (RES-6): TRANSFORMS_PER_EMOJI for a custom emoji's image, TRANSFORMS_PER_UPLOAD for any
// other row (its preview's RGBA too; a video row's still and its RGBA, or the RGBA of an adopted still). The kind is the
// Store's (a primary-key probe of custom_emojis), not the caller's. With `uploads` (a video row's still made by the
// media processor, #1828 design 4.12), one upload unit is charged too, against that limit (MEDIA_UPLOAD_MONTHLY_JOBS):
// both or neither.
export const chargeRebuild = mediaRebuildOperation.atStoreTime("now")<
  { authority: ImportAuthority; holder: string; id: string; limit: number; uploads?: number; now: number },
  RebuildCharge
>((db, { authority, holder, id, limit, uploads, now }) => {
  const refused = adminRefused(db, authority);
  if (refused !== null) {
    return { status: "denied", reason: refused };
  }
  if (!holds(db, holder, now)) {
    return { status: "lease-lost" };
  }
  const emoji = db.first("SELECT 1 AS found FROM custom_emojis WHERE id = ?", id) !== undefined;
  const count = emoji ? TRANSFORMS_PER_EMOJI : TRANSFORMS_PER_UPLOAD;
  // The upload unit is judged first, so a refusal charges neither.
  if (uploads !== undefined && !uploadJobFits(db, uploads, now)) {
    return { status: "budget_exhausted" };
  }
  if (!chargeInstanceTransforms(db, count, limit, now)) {
    return { status: "budget_exhausted" };
  }
  if (uploads !== undefined) {
    chargeUploadJob(db, uploads, now);
  }
  return { status: "ok" };
});

type Size = { width: number; height: number };

export type RebuildRecord =
  | { status: "ok" }
  | { status: "gone" }
  // recordAvStill: the row is there, but its meta cannot take the still (not an object, or past MEDIA_META_BYTES).
  | { status: "meta" }
  | { status: "lease-lost" }
  | { status: "denied"; reason: string };

// Records the sizes of the files the rebuild made, before they are written: the row must still be eligible with the
// same token and type, so files are not written for a row that changed or went. Only meta (the animated flag included)
// and the blurhash change; no account is touched here (finishRebuild sets a profile image's static once its files are
// written). The blurhash is the new preview's, as storedBlurhash keeps it; null (an emoji, or its RGBA output failed)
// keeps the stored one, so a transient failure loses nothing. A row doomed after this is caught by finishRebuild once
// the files are written.
export const recordRebuild = mediaRebuildOperation.atStoreTime("now")<
  {
    authority: ImportAuthority;
    holder: string;
    id: string;
    token: string;
    contentType: string;
    original: Size;
    small: Size;
    animated: boolean;
    blurhash: string | null;
    now: number;
  },
  RebuildRecord
>((db, { authority, holder, id, token, contentType, original, small, animated, blurhash, now }) => {
  const refused = adminRefused(db, authority);
  if (refused !== null) {
    return { status: "denied", reason: refused };
  }
  if (!holds(db, holder, now)) {
    return { status: "lease-lost" };
  }
  const changed = db.run(
    `UPDATE media_attachments SET meta = ?, blurhash = COALESCE(?, blurhash)
		WHERE id = ? AND file_token = ? AND content_type = ? AND ${ELIGIBLE}`,
    uploadMediaMeta(original, small, animated),
    storedBlurhash(blurhash),
    id,
    token,
    contentType,
    iso(now),
  );
  return changed === 0 ? { status: "gone" } : { status: "ok" };
});

// The statics of the row ?1 (with token ?2) for its own account, probed by key, when that account is local
// (`domain IS NULL`) and the row is not a custom emoji's: each of avatar_static_url and header_static_url whose image
// is the row's URL becomes its static (profileStaticSql of ?3); the other keeps its value. ?3 is the URL of the still
// the rebuild just wrote, as an upload of this token is given it (finishRebuild), never the stored preview_url, which a
// conversion may have spelled with another origin. The images' URLs are compared within SQL, byte for byte (RES-2,
// DATA-6).
const FINISH_REBUILD_SQL = `UPDATE accounts SET (avatar_static_url, header_static_url) = (
		SELECT CASE WHEN accounts.avatar_url = m.url THEN still ELSE accounts.avatar_static_url END,
			CASE WHEN accounts.header_url = m.url THEN still ELSE accounts.header_static_url END
		FROM (SELECT url, ${profileStaticSql("meta", "?3")} AS still
			FROM media_attachments INDEXED BY ${MEDIA_ID_INDEX} WHERE id = ?1) m)
	WHERE id = (SELECT account_id FROM media_attachments INDEXED BY ${MEDIA_ID_INDEX} WHERE id = ?1 AND file_token = ?2)
		AND domain IS NULL AND NOT EXISTS (SELECT 1 FROM custom_emojis e WHERE e.id = ?1)`;

export type RebuildFinish =
  | { status: "ok" }
  | { status: "gone" }
  | { status: "lease-lost" }
  | { status: "denied"; reason: string };

// Finishes an image row once both its files are written: the row must still be a candidate with this token, else
// `gone` and nothing changes (the caller deletes the files again); then its own account's statics are set for the
// images that name it (FINISH_REBUILD_SQL), so a rebuilt animated avatar or header shows its still preview as an
// upload does, and never before its `small` is stored. A custom emoji's row, and a row of a remote account (only an
// import makes one), touch no account. It reads no restore marker: the lease it checks was taken under
// the restore's fences (rebuildLease).
export const finishRebuild = mediaRebuildOperation.atStoreTime("now")<
  { authority: ImportAuthority; holder: string; id: string; token: string; now: number },
  RebuildFinish
>((db, { authority, holder, id, token, now }) => {
  const refused = adminRefused(db, authority);
  if (refused !== null) {
    return { status: "denied", reason: refused };
  }
  if (!holds(db, holder, now)) {
    return { status: "lease-lost" };
  }
  const live = db.first<{ contentType: string | null }>(
    `SELECT content_type AS contentType FROM media_attachments WHERE id = ? AND file_token = ? AND ${ELIGIBLE}`,
    id,
    token,
    iso(now),
  );
  if (live === undefined) {
    return { status: "gone" };
  }
  // The origin of the owner's URI, as completeMedia derives an upload's URLs (domain/media.ts): normalized by URL, so
  // `https://host:443` and an IDN host give the origin an upload of the account would be served at.
  const origin = URL.parse(ownerUri(db, id) ?? "")?.origin;
  const preview =
    origin === undefined || live.contentType === null ? null : mediaUrl(origin, token, "small", live.contentType);
  db.run(FINISH_REBUILD_SQL, id, token, preview);
  return { status: "ok" };
});

// ---- Video and audio rows (#1828 design 4.16, mastodon/media-rebuild-av.ts)

// Records the still of a video row once its `small` exists in R2: meta.small its geometry and the blurhash as given
// (null is stored as null: the still's metadata says it has none). `publish` (`--stills`) also sets the row's
// preview_url, on the uploader's origin as completeMedia makes it, in the same update; otherwise the row must still
// have one, so a row that fell back is not given a preview by a plain rebuild. A meta that is not an object, or that
// the still would take past MEDIA_META_BYTES, is not written: "meta" while the row is there, "gone" once it is not.
export const recordAvStill = mediaRebuildOperation.atStoreTime("now")<
  {
    authority: ImportAuthority;
    holder: string;
    id: string;
    token: string;
    small: Size;
    blurhash: string | null;
    publish: boolean;
    now: number;
  },
  RebuildRecord
>((db, { authority, holder, id, token, small, blurhash, publish, now }) => {
  const refused = adminRefused(db, authority);
  if (refused !== null) {
    return { status: "denied", reason: refused };
  }
  if (!holds(db, holder, now)) {
    return { status: "lease-lost" };
  }
  const uri = ownerUri(db, id);
  if (uri === undefined) {
    return { status: "gone" };
  }
  const preview = publish ? mediaUrl(new URL(uri).origin, token, "small", "image/webp") : null;
  const meta = `json_set(COALESCE(meta, '{}'), '$.small', json(?1))`;
  const changed = db.run(
    `UPDATE media_attachments SET meta = ${meta}, blurhash = ?2, preview_url = COALESCE(?3, preview_url)
		WHERE id = ?4 AND file_token = ?5 AND type = 'video' AND content_type = 'video/mp4'
			AND (?3 IS NOT NULL OR preview_url IS NOT NULL)
			AND (meta IS NULL OR json_type(meta) = 'object')
			AND length(CAST(${meta} AS BLOB)) <= ?6
			AND ${ELIGIBLE.replace("?", "?7")}`,
    JSON.stringify({ width: small.width, height: small.height }),
    storedBlurhash(blurhash),
    preview,
    id,
    token,
    MEDIA_META_BYTES,
    iso(now),
  );
  if (changed > 0) {
    return { status: "ok" };
  }
  const live = db.first(
    `SELECT 1 AS found FROM media_attachments WHERE id = ?1 AND file_token = ?2 AND type = 'video'
			AND content_type = 'video/mp4' AND (?3 IS NOT NULL OR preview_url IS NOT NULL) AND ${ELIGIBLE.replace("?", "?4")}`,
    id,
    token,
    preview,
    iso(now),
  );
  return live === undefined ? { status: "gone" } : { status: "meta" };
});

// The fallback of a video row whose still cannot be made (the processor unbound or failing, its probe failed, a
// budget spent): preview_url, meta.small and the blurhash are cleared, so the row is presented with VIDEO_POSTER.
// Nothing is written to R2. Terminal for a plain rebuild; `--stills` revisits it.
export const fallbackAvRebuild = mediaRebuildOperation.atStoreTime("now")<
  { authority: ImportAuthority; holder: string; id: string; token: string; now: number },
  RebuildRecord
>((db, { authority, holder, id, token, now }) => {
  const refused = adminRefused(db, authority);
  if (refused !== null) {
    return { status: "denied", reason: refused };
  }
  if (!holds(db, holder, now)) {
    return { status: "lease-lost" };
  }
  const changed = db.run(
    `UPDATE media_attachments SET preview_url = NULL, meta = json_remove(meta, '$.small'), blurhash = NULL
		WHERE id = ? AND file_token = ? AND type = 'video' AND content_type = 'video/mp4' AND ${ELIGIBLE}`,
    id,
    token,
    iso(now),
  );
  return changed === 0 ? { status: "gone" } : { status: "ok" };
});

// The rebuild's own probe of `still@standard-1` (design 4.15), under its lease, over the shared probe records and their
// one claim (domain/media-probes.ts claimProbeIn, recordProbeResultIn): the claim, its cooldown and its record are the
// generic probe's, so a rebuild in maintenance and the probe round after it never both record, and each cools down as
// the other's claim says.
const STILL_PROFILE: ProbeProfile = "still@standard-1";

export type RebuildProbeClaim =
  | { status: "denied"; reason: string }
  | { status: "lease-lost" }
  // A pass for the build that needs no probe (media-probes.ts probeDue).
  | { status: "passed" }
  | { status: "claimed"; claim: string }
  // Claimed for the build within its cooldown: the verdict of that claim, if it reached one, stands.
  | { status: "cooldown"; record: ProbeRecord | null };

export const claimRebuildProbe = mediaRebuildOperation.atStoreTime("now")<
  { authority: ImportAuthority; holder: string; build: string; now: number },
  RebuildProbeClaim
>((db, { authority, holder, build, now }) => {
  const refused = adminRefused(db, authority);
  if (refused !== null) {
    return { status: "denied", reason: refused };
  }
  if (!holds(db, holder, now)) {
    return { status: "lease-lost" };
  }
  const state = probeState(db, STILL_PROFILE, now);
  if (!probeDue(state, build)) {
    return { status: "passed" };
  }
  const claimed = claimProbeIn(db, STILL_PROFILE, build, false, now, state);
  if (claimed.status === "claimed") {
    return claimed;
  }
  // The build's verdict stands only when it is the last claim's (recorded at or after it): an older one does not stand
  // for a claim that recorded none, nor for one that reached no verdict.
  const { record, attempt } = state;
  const standing = record !== null && record.version === build && attempt !== null && record.at >= attempt.at;
  return { status: "cooldown", record: standing ? record : null };
});

// The rebuild probe's outcome under its claim (media-probes.ts recordProbeResultIn): `stale` when another prober's
// claim replaced it.
export const recordRebuildProbe = mediaRebuildOperation.atStoreTime("now")<
  { authority: ImportAuthority; holder: string; result: Omit<ProbeResult, "profile">; now: number },
  { status: "recorded" } | { status: "stale" } | { status: "lease-lost" } | { status: "denied"; reason: string }
>((db, { authority, holder, result, now }) => {
  const refused = adminRefused(db, authority);
  if (refused !== null) {
    return { status: "denied", reason: refused };
  }
  if (!holds(db, holder, now)) {
    return { status: "lease-lost" };
  }
  return recordProbeResultIn(db, { ...result, profile: STILL_PROFILE }, now);
});
