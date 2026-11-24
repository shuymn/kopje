import { ACCOUNTS_ID_INDEX, MEDIA_ID_INDEX } from "../db/indexes";
import type { Db } from "../db/sql";
import { iso } from "../platform/iso-time";
import { mediaUrl } from "../platform/media-files";
import type { ImportAuthority } from "../platform/store-admin";
import { PITR_RESTORING, PITR_RESTORING_MS, REBUILD_LEASE } from "../platform/store-flags";
import { MEDIA_META_BYTES, storedBlurhash } from "../platform/stored-bounds";
import { accessAdminRefusal } from "./admin-authority";
import {
  chargeInstanceTransforms,
  chargeUploadJob,
  uploadJobFits,
  TRANSFORMS_PER_EMOJI,
  TRANSFORMS_PER_UPLOAD,
  uploadMediaMeta,
} from "./media";
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
  // Whether a still can be recorded in the row's meta: it is a JSON object (or NULL), and with the largest meta.small
  // a still may have it stays within MEDIA_META_BYTES.
  meta: "ok" | "not-object" | "too-large";
  small: { width: StoredScalar; height: StoredScalar } | null;
  blurhash: string | null;
};
export type RebuildRow = {
  id: string;
  token: string;
  contentType: string | null;
  emoji: boolean;
  av: RebuildAv | null;
};

// The largest meta.small a still can have (its edges are at most STILL_LONG_EDGE, 640): what a row's meta must have
// room for.
const LARGEST_SMALL = JSON.stringify({ width: 640, height: 640 });

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
    meta: "ok" | "not-object" | "too-large";
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
				CASE WHEN meta IS NOT NULL AND json_type(meta) <> 'object' THEN 'not-object'
					WHEN length(CAST(json_set(COALESCE(meta, '{}'), '$.small', json(?)) AS BLOB)) > ? THEN 'too-large'
					ELSE 'ok' END AS meta,
				json_extract(meta, '$.small.width') AS smallWidth, json_extract(meta, '$.small.height') AS smallHeight,
				blurhash
			FROM media_attachments WHERE ${ELIGIBLE} AND id > ? AND id <= ? ORDER BY id LIMIT ?`,
      LARGEST_SMALL,
      MEDIA_META_BYTES,
      iso(now),
      after ?? "",
      last,
      REBUILD_PAGE,
    )
    .map(({ emoji, kind, preview, meta, smallWidth, smallHeight, hasSmall, blurhash, ...row }) => ({
      ...row,
      emoji: emoji === 1,
      av:
        kind === null
          ? null
          : {
              kind,
              preview: preview === 1,
              meta,
              small: hasSmall === 1 ? { width: smallWidth as StoredScalar, height: smallHeight as StoredScalar } : null,
              blurhash,
            },
    }));
  if (rows.length === REBUILD_PAGE) {
    return { rows, next: rows.at(-1)?.id ?? last, done: false };
  }
  return { rows, next: last, done: scanned.length < SCAN_WINDOW };
});

// Whether a row is still a candidate with this token: the rebuild asks after its files are written (mastodon/
// media-rebuild.ts).
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
// every REBUILD_HEARTBEAT_MS (mastodon/media-rebuild.ts), so it never expires under a write while the call runs.
export const REBUILD_LEASE_MS = 10 * 60 * 1000;

// How long the Store's readonly maintenance must have lasted before a rebuild writes: longer than any invocation that
// fetched a sweep or reconciliation batch before it began can still run (a cron invocation has at most 15 minutes of
// wall time; the sweep after an API delete runs in waitUntil, at most 30 seconds after its response), so no deletion
// decided before readonly can land during the rebuild. An unpublished import needs none: the import began on an empty
// Store and every write has been refused since it was verified, so no deletion was ever decided for a row it brought.
export const REBUILD_SETTLE_MS = 20 * 60 * 1000;

type Lease = { holder: string; until: number };

function readLease(db: Db): Lease | null {
  const value = db.first<{ value: string }>("SELECT value FROM kopje_state WHERE name = ?", REBUILD_LEASE)?.value;
  return value === undefined ? null : (JSON.parse(value) as Lease);
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
function readiness(
  db: Db,
  now: number,
  restoredAt: number | null,
): { status: "ok" } | { status: "needs-readonly" } | { status: "restoring" } | { status: "settling"; readyAt: number } {
  const restoring = flag<{ at: number }>(db, PITR_RESTORING);
  if (restoring !== null && restoring.at > now - PITR_RESTORING_MS) {
    return { status: "restoring" };
  }
  const unpublished = flag<{ at: number }>(db, "unpublished");
  if (unpublished !== null && (restoredAt === null || unpublished.at > restoredAt)) {
    return { status: "ok" };
  }
  const maintenance = flag<{ at: number }>(db, "maintenance");
  if (maintenance === null) {
    return { status: "needs-readonly" };
  }
  const readyAt = Math.max(maintenance.at, restoredAt ?? 0) + REBUILD_SETTLE_MS;
  return now >= readyAt ? { status: "ok" } : { status: "settling", readyAt };
}

export type RebuildLeaseResult =
  | { status: "ok"; remainingMs: number }
  | { status: "released" }
  | { status: "needs-readonly" }
  | { status: "settling"; readyAt: number }
  | { status: "restoring" }
  | { status: "busy"; remainingMs: number }
  | { status: "denied"; reason: string };

// Takes or renews the lease for `holder` (for REBUILD_LEASE_MS from the Store's `now`), or releases it. A release by a
// holder that no longer holds it changes nothing.
export const rebuildLease = mediaRebuildOperation.atStoreTime("now")<
  { authority: ImportAuthority; holder: string; release?: boolean; restoredAt: number | null; now: number },
  RebuildLeaseResult
>((db, { authority, holder, release, restoredAt, now }) => {
  const refused = adminRefused(db, authority);
  if (refused !== null) {
    return { status: "denied", reason: refused };
  }
  const lease = readLease(db);
  if (release === true) {
    if (lease?.holder === holder) {
      db.run("DELETE FROM kopje_state WHERE name = ?", REBUILD_LEASE);
    }
    return { status: "released" };
  }
  const ready = readiness(db, now, restoredAt);
  if (ready.status !== "ok") {
    return ready;
  }
  if (lease !== null && lease.holder !== holder && lease.until > now) {
    return { status: "busy", remainingMs: lease.until - now };
  }
  db.run(
    "INSERT OR REPLACE INTO kopje_state (name, value) VALUES (?, ?)",
    REBUILD_LEASE,
    JSON.stringify({ holder, until: now + REBUILD_LEASE_MS } satisfies Lease),
  );
  return { status: "ok", remainingMs: REBUILD_LEASE_MS };
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
// and the blurhash change; no account is touched, so a profile image keeps the static it had. The blurhash is the new
// preview's, as storedBlurhash keeps it; null (an emoji, or its RGBA output failed) keeps the stored one, so a
// transient failure loses nothing. A row doomed after this is caught by rebuildRowLive once the files are written.
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
  const owner = db.first<{ uri: string }>(
    `SELECT a.uri FROM media_attachments m INDEXED BY ${MEDIA_ID_INDEX}
			CROSS JOIN accounts a INDEXED BY ${ACCOUNTS_ID_INDEX} ON a.id = m.account_id WHERE m.id = ?`,
    id,
  );
  if (owner === undefined) {
    return { status: "gone" };
  }
  const preview = publish ? mediaUrl(new URL(owner.uri).origin, token, "small", "image/webp") : null;
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

// The probe record of an execution profile (design 4.15): which Worker version (the build) it passed or failed for,
// the image the container reported, and when (Store time). Kept in kopje_state (not dumped). This release records only
// the rebuild's own probe of `still@standard-1`.
export type ProbeRecord = { version: string; imageTag: string | null; at: number; ok: boolean };

const PROBE_RECORD = "media_probe:";
const PROBE_ATTEMPT = "media_probe_attempt:";
const PROBE_PROFILES = ["still@standard-1"] as const;
type RecordedProfile = (typeof PROBE_PROFILES)[number];

function probeName(prefix: string, profile: RecordedProfile): string {
  if (!PROBE_PROFILES.includes(profile)) {
    throw new Error("not a recorded probe profile");
  }
  return `${prefix}${profile}`;
}

// The bounds of the probe's stored values (RES-2): the build a Worker version id, and the image tag as the container
// reported it, both printable ASCII; the tag is the processor's, so the Worker keeps one past its bound as null
// (probeImageTag). A stored value is read only within PROBE_VALUE_BYTES and as JSON.
const PROBE_VERSION_BYTES = 64;
const PROBE_IMAGE_TAG_BYTES = 512;
const PROBE_VALUE_BYTES = 1024;
const PRINTABLE = /^[\x21-\x7e]+$/;

function printable(value: unknown, bytes: number): value is string {
  return typeof value === "string" && value.length <= bytes && PRINTABLE.test(value);
}

export function probeImageTag(tag: string | null): string | null {
  return printable(tag, PROBE_IMAGE_TAG_BYTES) ? tag : null;
}

// An object of exactly `keys`, or null.
function exactly(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const own = Object.keys(record);
  return own.length === keys.length && keys.every((key) => own.includes(key)) ? record : null;
}

// A time the Store stamped: a safe integer, not after `now` (a later one is not trusted to suppress anything).
function stamped(at: unknown, now: number): boolean {
  return Number.isSafeInteger(at) && (at as number) >= 0 && (at as number) <= now;
}

function probeRecordValid(value: unknown, now: number): value is ProbeRecord {
  const record = exactly(value, ["version", "imageTag", "at", "ok"]);
  return (
    record !== null &&
    printable(record.version, PROBE_VERSION_BYTES) &&
    (record.imageTag === null || printable(record.imageTag, PROBE_IMAGE_TAG_BYTES)) &&
    stamped(record.at, now) &&
    typeof record.ok === "boolean"
  );
}

// When the rebuild last started the profile's probe, whatever came of it (written before the probe runs).
export type ProbeAttempt = { version: string; at: number };

function probeAttemptValid(value: unknown, now: number): value is ProbeAttempt {
  const attempt = exactly(value, ["version", "at"]);
  return attempt !== null && printable(attempt.version, PROBE_VERSION_BYTES) && stamped(attempt.at, now);
}

// A stored value of kopje_state as JSON, or null when it is missing, past PROBE_VALUE_BYTES or not JSON.
function storedJson(db: Db, name: string): unknown {
  const value = db.first<{ value: string }>(
    "SELECT value FROM kopje_state WHERE name = ? AND length(CAST(value AS BLOB)) <= ?",
    name,
    PROBE_VALUE_BYTES,
  )?.value;
  if (value === undefined) {
    return null;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

// The verdict, the last attempt, and the Store's time, which their `at` is compared with. A stored value that is out of
// bounds, not JSON or dated after the Store's time reads as none, so it never holds the probe back.
export const probeRecord = readOperation.atStoreTime("now")<
  { profile: RecordedProfile; now: number },
  { record: ProbeRecord | null; attempt: ProbeAttempt | null; now: number }
>((db, { profile, now }) => {
  const record = storedJson(db, probeName(PROBE_RECORD, profile));
  const attempt = storedJson(db, probeName(PROBE_ATTEMPT, profile));
  return {
    record: probeRecordValid(record, now) ? record : null,
    attempt: probeAttemptValid(attempt, now) ? attempt : null,
    now,
  };
});

// Records, under the rebuild's lease, the start of a probe (`ok` null: the attempt, before the probe runs) or its
// verdict.
export const recordProbe = mediaRebuildOperation.atStoreTime("now")<
  {
    authority: ImportAuthority;
    holder: string;
    profile: RecordedProfile;
    version: string;
    imageTag: string | null;
    ok: boolean | null;
    now: number;
  },
  { status: "ok" } | { status: "lease-lost" } | { status: "denied"; reason: string }
>((db, { authority, holder, profile, version, imageTag, ok, now }) => {
  const refused = adminRefused(db, authority);
  if (refused !== null) {
    return { status: "denied", reason: refused };
  }
  if (!holds(db, holder, now)) {
    return { status: "lease-lost" };
  }
  const [name, value] =
    ok === null
      ? [probeName(PROBE_ATTEMPT, profile), { version, at: now }]
      : [probeName(PROBE_RECORD, profile), { version, imageTag, at: now, ok }];
  const valid = ok === null ? probeAttemptValid(value, now) : probeRecordValid(value, now);
  const text = JSON.stringify(value);
  if (!valid || new TextEncoder().encode(text).byteLength > PROBE_VALUE_BYTES) {
    throw new Error("probe record out of bounds");
  }
  db.run("INSERT OR REPLACE INTO kopje_state (name, value) VALUES (?, ?)", name, text);
  return { status: "ok" };
});
