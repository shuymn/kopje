-- Kopje Store schema 0121: the state of a video or audio upload while the media processor works on it (#1828;
-- src/domain/media-processing.ts). Never edit after release (checksummed).
--
--   media_processing               one row per unfinished video or audio upload: staging (the request writes its
--                                  input), pending (queued), running (started) or failed (its cause), with the Store's
--                                  times that bound it. It cascades with its attachment, and an upload that completes,
--                                  is deleted or is doomed loses it.
--   media_processing_dispatch      the pending rows by dispatched_at: the dispatch round's redispatch.
--   media_processing_deadline      the pending and running rows by deadline_at: the round's deadline (K4).
--   media_processing_staging       the staging rows by staged_until: the round's abandoned staging.
--   media_processing_restore       the unfailed rows by staged_at: the round's restore pass (K3).
--   media_av_slots                 the processor's capacity slots, one per upload, with no reference to its row: a
--                                  slot outlives its upload until its container's stop is confirmed. A slot not
--                                  granted counts until held_until; a granted one (granted_at, the start) until the
--                                  stop is confirmed or HARD_HOLD_MS after granted_at.
--   media_av_slots_held            the slots not granted by held_until: the slot count and expiry.
--   media_av_slots_granted         the granted slots by granted_at: the slot count and expiry.
--
-- Every value is the Store's own (times on its clock, tokens it draws, the input's byte count it checks), and the
-- CHECKs below hold each column to its bound and each state to its columns. The tables are not dumped
-- (src/platform/dump-catalog.ts): a restored Store has no processing row or slot.
--
-- No row is written and no existing table is read or changed: the file only creates two empty tables and their
-- indexes. A file that creates a table cannot declare foreignKeys: 'unchanged' (test/migration-sql.ts), so its upgrade
-- checks every reference of the Store. Measured on the benchmark store of test/bench/migration-cost.ts in workerd's
-- local Durable Object SQLite: see the CHANGELOG entry of this file.

CREATE TABLE media_processing (
  media_id TEXT NOT NULL PRIMARY KEY REFERENCES media_attachments (id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('staging', 'pending', 'running', 'failed')),
  staged_at INTEGER NOT NULL CHECK (typeof(staged_at) = 'integer' AND staged_at >= 0),
  staged_until INTEGER NOT NULL CHECK (typeof(staged_until) = 'integer' AND staged_until >= staged_at),
  queued_at INTEGER CHECK (queued_at IS NULL OR (typeof(queued_at) = 'integer' AND queued_at >= staged_at)),
  dispatched_at INTEGER CHECK (dispatched_at IS NULL OR (typeof(dispatched_at) = 'integer' AND dispatched_at >= 0)),
  deadline_at INTEGER CHECK (deadline_at IS NULL OR (typeof(deadline_at) = 'integer' AND deadline_at >= 0)),
  reply_by INTEGER CHECK (reply_by IS NULL OR (typeof(reply_by) = 'integer' AND reply_by >= 0)),
  start_id TEXT CHECK (start_id IS NULL OR (typeof(start_id) = 'text' AND length(CAST(start_id AS BLOB)) BETWEEN 1 AND 64)),
  started_by TEXT CHECK (started_by IS NULL
    OR (typeof(started_by) = 'text' AND length(CAST(started_by AS BLOB)) BETWEEN 1 AND 64)),
  input_bytes INTEGER CHECK (input_bytes IS NULL OR (typeof(input_bytes) = 'integer' AND input_bytes BETWEEN 1 AND 94371840)),
  failure TEXT CHECK (failure IS NULL
    OR failure IN ('refused', 'envelope', 'verifier', 'unavailable', 'timeout', 'deadline', 'restored')),
  CHECK ((state = 'staging') = (queued_at IS NULL)),
  CHECK ((state = 'staging') = (input_bytes IS NULL)),
  CHECK ((state IN ('pending', 'running', 'failed')) = (deadline_at IS NOT NULL)),
  CHECK ((state = 'pending') = (dispatched_at IS NOT NULL)),
  CHECK ((start_id IS NULL) = (started_by IS NULL)),
  CHECK (state <> 'running' OR start_id IS NOT NULL),
  CHECK (state NOT IN ('staging', 'pending') OR start_id IS NULL),
  CHECK ((state = 'failed') = (failure IS NOT NULL))
);

CREATE INDEX media_processing_dispatch ON media_processing (dispatched_at) WHERE state = 'pending';

CREATE INDEX media_processing_deadline ON media_processing (deadline_at) WHERE state IN ('pending', 'running');

CREATE INDEX media_processing_staging ON media_processing (staged_until) WHERE state = 'staging';

CREATE INDEX media_processing_restore ON media_processing (staged_at) WHERE state <> 'failed';

CREATE TABLE media_av_slots (
  media_id TEXT NOT NULL PRIMARY KEY CHECK (typeof(media_id) = 'text' AND length(CAST(media_id AS BLOB)) BETWEEN 1 AND 64),
  phase TEXT NOT NULL CHECK (phase IN ('staging', 'processing')),
  held_until INTEGER NOT NULL CHECK (typeof(held_until) = 'integer' AND held_until >= 0),
  teardown_id TEXT CHECK (teardown_id IS NULL
    OR (typeof(teardown_id) = 'text' AND length(CAST(teardown_id AS BLOB)) BETWEEN 1 AND 64)),
  granted_at INTEGER CHECK (granted_at IS NULL OR (typeof(granted_at) = 'integer' AND granted_at >= 0)),
  CHECK ((phase = 'processing') = (teardown_id IS NOT NULL)),
  CHECK (granted_at IS NULL OR phase = 'processing')
);

CREATE INDEX media_av_slots_held ON media_av_slots (held_until) WHERE granted_at IS NULL;

CREATE INDEX media_av_slots_granted ON media_av_slots (granted_at) WHERE granted_at IS NOT NULL;
