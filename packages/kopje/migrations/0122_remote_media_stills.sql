-- Kopje Store schema 0122: remote video stills (#1828 PR5; src/domain/remote-media-stills.ts). Never edit after
-- release (checksummed).
--
--   remote_media_stills           one row per cached remote video or gifv whose still is queued or recorded, keyed by
--                                 its object's token and cascading with the object's ledger row: queued (due_at, the
--                                 claims made, the last claim's time, attempt nonce and settled outcome) or stored
--                                 (the attempt whose key remote/<token>/s<attempt> a record named), and the bytes its
--                                 still charges to the object (a claim's reservation, or the recorded WebP's size).
--   remote_media_stills_due       the rows due, by due_at: the claim's walk.
--   remote_media                  two nullable columns: still_key (the named still's variant, s and the attempt) and
--                                 still_blurhash (its blurhash), NULL for every existing row.
--   remote_media_bounds_insert    dropped and recreated over every column, the new ones included: 0077's cases, then
--   remote_media_bounds_update    a still_key that is not s and 32 lowercase hex digits, a still_blurhash past the
--                                 blurhash bound, a still_key without a still_ext, and a still_blurhash without a
--                                 still_key. No trigger writes.
--   remote_media_stills_bounds_*  each column of the new table within its bound (remoteMediaStillPastBoundSql).
--
-- Bounds and predicates: src/platform/stored-bounds.ts (stillKeyPastSql, remoteMediaSlotPastBoundSql,
-- remoteMediaStillPastBoundSql); the triggers are emitTriggers' output (test/migrations.test.ts compares them). The
-- table is not dumped (src/platform/dump-catalog.ts). A point-in-time restore rewinds it with the ledger.
--
-- No row is written: the columns are added to the schema only, the triggers read no row, and the new table is empty. A
-- file that creates a table cannot declare foreignKeys: 'unchanged' (test/migration-sql.ts), so its upgrade checks every
-- reference of the Store.

CREATE TABLE remote_media_stills (
  token TEXT NOT NULL PRIMARY KEY REFERENCES remote_media_objects (token) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('queued', 'stored')),
  claims INTEGER NOT NULL CHECK (typeof(claims) = 'integer' AND claims BETWEEN 0 AND 3),
  due_at INTEGER CHECK (due_at IS NULL OR (typeof(due_at) = 'integer' AND due_at >= 0)),
  claimed_at INTEGER CHECK (claimed_at IS NULL OR (typeof(claimed_at) = 'integer' AND claimed_at >= 0)),
  attempt TEXT CHECK (attempt IS NULL
    OR (typeof(attempt) = 'text' AND length(CAST(attempt AS BLOB)) = 32 AND attempt NOT GLOB '*[^0-9a-f]*')),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('retry', 'park')),
  still_charge INTEGER NOT NULL CHECK (typeof(still_charge) = 'integer' AND still_charge BETWEEN 0 AND 2097152),
  CHECK ((claims = 0) = (claimed_at IS NULL)),
  CHECK ((attempt IS NULL) = (claimed_at IS NULL)),
  CHECK (outcome IS NULL OR attempt IS NOT NULL),
  CHECK (state <> 'stored' OR (due_at IS NULL AND claims >= 1 AND outcome IS NULL AND still_charge >= 1)),
  CHECK (state <> 'queued' OR outcome IS NULL OR still_charge = 0)
) WITHOUT ROWID;

CREATE INDEX remote_media_stills_due ON remote_media_stills (due_at) WHERE due_at IS NOT NULL;

ALTER TABLE remote_media ADD COLUMN still_key TEXT;
ALTER TABLE remote_media ADD COLUMN still_blurhash TEXT;

DROP TRIGGER remote_media_bounds_insert;
DROP TRIGGER remote_media_bounds_update;

CREATE TRIGGER remote_media_bounds_insert BEFORE INSERT ON remote_media
WHEN CASE WHEN typeof(NEW.kind) <> 'text' OR NEW.kind NOT IN ('avatar', 'header', 'attachment', 'thumbnail', 'emoji') THEN 1
	WHEN NEW.owner_id IS NOT NULL AND CASE WHEN typeof(NEW.owner_id) <> 'text' THEN 1
	WHEN length(CAST(NEW.owner_id AS BLOB)) <> 18 THEN 1
	WHEN instr(CAST(NEW.owner_id AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.owner_id GLOB '*[^0-9]*' THEN 1
	ELSE 0 END THEN 1
	WHEN NEW.account_id IS NOT NULL AND CASE WHEN typeof(NEW.account_id) <> 'text' THEN 1
	WHEN length(CAST(NEW.account_id AS BLOB)) <> 18 THEN 1
	WHEN instr(CAST(NEW.account_id AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.account_id GLOB '*[^0-9]*' THEN 1
	ELSE 0 END THEN 1
	WHEN NEW.domain IS NOT NULL AND CASE WHEN typeof(NEW.domain) <> 'text' THEN 1
	WHEN length(CAST(NEW.domain AS BLOB)) NOT BETWEEN 3 AND 253 THEN 1
	WHEN instr(CAST(NEW.domain AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.domain GLOB '*[^a-z0-9.-]*' THEN 1
	WHEN NEW.domain NOT GLOB '?*.?*' OR NEW.domain GLOB '.*' OR NEW.domain GLOB '*.' OR NEW.domain GLOB '*..*' THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.url) <> 'text' THEN 1
	WHEN length(CAST(NEW.url AS BLOB)) > 2048 THEN 1
	WHEN instr(CAST(NEW.url AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.url NOT GLOB 'https://?*' THEN 1
	WHEN NEW.url GLOB '*[^!-~]*' THEN 1
	WHEN NEW.url GLOB '*["<>\^`{|}]*' THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.host) <> 'text' THEN 1
	WHEN length(CAST(NEW.host AS BLOB)) NOT BETWEEN 3 AND 253 THEN 1
	WHEN instr(CAST(NEW.host AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.host GLOB '*[^a-z0-9.-]*' THEN 1
	WHEN NEW.host NOT GLOB '?*.?*' OR NEW.host GLOB '.*' OR NEW.host GLOB '*.' OR NEW.host GLOB '*..*' THEN 1
	ELSE 0 END THEN 1
	WHEN typeof(NEW.category) <> 'text' OR NEW.category NOT IN ('image', 'video', 'audio') THEN 1
	WHEN typeof(NEW.lane) <> 'integer' OR NEW.lane NOT BETWEEN 0 AND 1 THEN 1
	WHEN typeof(NEW.generation) <> 'integer' OR NEW.generation NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN NEW.due_at IS NOT NULL AND (typeof(NEW.due_at) <> 'integer' OR NEW.due_at NOT BETWEEN 0 AND 9007199254740991) THEN 1
	WHEN typeof(NEW.enqueued_at) <> 'integer' OR NEW.enqueued_at NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN typeof(NEW.claim) <> 'integer' OR NEW.claim NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN typeof(NEW.attempts) <> 'integer' OR NEW.attempts NOT BETWEEN 0 AND 4 THEN 1
	WHEN CASE WHEN NEW.token IS NULL THEN 0
	WHEN typeof(NEW.token) <> 'text' THEN 1
	WHEN length(CAST(NEW.token AS BLOB)) NOT BETWEEN 32 AND 64 THEN 1
	WHEN instr(CAST(NEW.token AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.token GLOB '*[^A-Za-z0-9_-]*' THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN NEW.ext IS NULL THEN 0
	WHEN typeof(NEW.ext) <> 'text' THEN 1
	WHEN NEW.ext NOT IN ('jpg', 'png', 'gif', 'webp', 'avif', 'mp4', 'webm', 'm4a', 'mp3', 'flac', 'wav') THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN NEW.still_ext IS NULL THEN 0
	WHEN typeof(NEW.still_ext) <> 'text' THEN 1
	WHEN NEW.still_ext NOT IN ('jpg', 'png', 'gif', 'webp', 'avif', 'mp4', 'webm', 'm4a', 'mp3', 'flac', 'wav') THEN 1
	ELSE 0 END THEN 1
	WHEN NEW.stored_at IS NOT NULL AND (typeof(NEW.stored_at) <> 'integer' OR NEW.stored_at NOT BETWEEN 0 AND 9007199254740991) THEN 1
	WHEN NEW.failed_at IS NOT NULL AND (typeof(NEW.failed_at) <> 'integer' OR NEW.failed_at NOT BETWEEN 0 AND 9007199254740991) THEN 1
	WHEN NEW.seen_at IS NOT NULL AND (typeof(NEW.seen_at) <> 'integer' OR NEW.seen_at NOT BETWEEN 0 AND 9007199254740991) THEN 1
	WHEN (NEW.owner_id IS NULL) <> (NEW.kind = 'emoji') THEN 1
	WHEN (NEW.account_id IS NULL) <> (NEW.kind = 'emoji') THEN 1
	WHEN (NEW.domain IS NULL) = (NEW.kind = 'emoji') THEN 1
	WHEN (NEW.token IS NULL) <> (NEW.ext IS NULL) OR (NEW.token IS NULL) <> (NEW.stored_at IS NULL) THEN 1
	WHEN NEW.token IS NOT NULL AND (NEW.due_at IS NOT NULL OR NEW.failed_at IS NOT NULL) THEN 1
	WHEN NEW.still_ext IS NOT NULL AND NEW.token IS NULL THEN 1
	WHEN NEW.failed_at IS NOT NULL AND NEW.due_at IS NOT NULL THEN 1
	WHEN CASE WHEN NEW.still_key IS NULL THEN 0
	WHEN typeof(NEW.still_key) <> 'text' THEN 1
	WHEN length(CAST(NEW.still_key AS BLOB)) <> 33 THEN 1
	WHEN substr(NEW.still_key, 1, 1) <> 's' THEN 1
	WHEN substr(NEW.still_key, 2) GLOB '*[^0-9a-f]*' THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN NEW.still_blurhash IS NULL THEN 0
	WHEN typeof(NEW.still_blurhash) <> 'text' THEN 1
	WHEN length(CAST(NEW.still_blurhash AS BLOB)) NOT BETWEEN 6 AND 54 THEN 1
	WHEN instr(CAST(NEW.still_blurhash AS BLOB), x'00') > 0 THEN 1
	WHEN rtrim(NEW.still_blurhash, '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~') <> '' THEN 1
	WHEN (SELECT f % 9 >= 5 OR f / 9 >= 5
			OR length(NEW.still_blurhash) <> 4 + 2 * (f % 9 + 1) * (f / 9 + 1)
		FROM (SELECT instr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~', substr(NEW.still_blurhash, 1, 1)) - 1 AS f)) THEN 1
	ELSE 0 END THEN 1
	WHEN NEW.still_key IS NOT NULL AND NEW.still_ext IS NULL THEN 1
	WHEN NEW.still_blurhash IS NOT NULL AND NEW.still_key IS NULL THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'remote_media: a value past its stored bound');
END;

CREATE TRIGGER remote_media_bounds_update BEFORE UPDATE OF id, kind, owner_id, account_id, domain, url, host, category, lane, generation, due_at, enqueued_at, claim, attempts, token, ext, still_ext, stored_at, failed_at, seen_at, still_key, still_blurhash ON remote_media
WHEN CASE WHEN typeof(NEW.kind) <> 'text' OR NEW.kind NOT IN ('avatar', 'header', 'attachment', 'thumbnail', 'emoji') THEN 1
	WHEN NEW.owner_id IS NOT NULL AND CASE WHEN typeof(NEW.owner_id) <> 'text' THEN 1
	WHEN length(CAST(NEW.owner_id AS BLOB)) <> 18 THEN 1
	WHEN instr(CAST(NEW.owner_id AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.owner_id GLOB '*[^0-9]*' THEN 1
	ELSE 0 END THEN 1
	WHEN NEW.account_id IS NOT NULL AND CASE WHEN typeof(NEW.account_id) <> 'text' THEN 1
	WHEN length(CAST(NEW.account_id AS BLOB)) <> 18 THEN 1
	WHEN instr(CAST(NEW.account_id AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.account_id GLOB '*[^0-9]*' THEN 1
	ELSE 0 END THEN 1
	WHEN NEW.domain IS NOT NULL AND CASE WHEN typeof(NEW.domain) <> 'text' THEN 1
	WHEN length(CAST(NEW.domain AS BLOB)) NOT BETWEEN 3 AND 253 THEN 1
	WHEN instr(CAST(NEW.domain AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.domain GLOB '*[^a-z0-9.-]*' THEN 1
	WHEN NEW.domain NOT GLOB '?*.?*' OR NEW.domain GLOB '.*' OR NEW.domain GLOB '*.' OR NEW.domain GLOB '*..*' THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.url) <> 'text' THEN 1
	WHEN length(CAST(NEW.url AS BLOB)) > 2048 THEN 1
	WHEN instr(CAST(NEW.url AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.url NOT GLOB 'https://?*' THEN 1
	WHEN NEW.url GLOB '*[^!-~]*' THEN 1
	WHEN NEW.url GLOB '*["<>\^`{|}]*' THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.host) <> 'text' THEN 1
	WHEN length(CAST(NEW.host AS BLOB)) NOT BETWEEN 3 AND 253 THEN 1
	WHEN instr(CAST(NEW.host AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.host GLOB '*[^a-z0-9.-]*' THEN 1
	WHEN NEW.host NOT GLOB '?*.?*' OR NEW.host GLOB '.*' OR NEW.host GLOB '*.' OR NEW.host GLOB '*..*' THEN 1
	ELSE 0 END THEN 1
	WHEN typeof(NEW.category) <> 'text' OR NEW.category NOT IN ('image', 'video', 'audio') THEN 1
	WHEN typeof(NEW.lane) <> 'integer' OR NEW.lane NOT BETWEEN 0 AND 1 THEN 1
	WHEN typeof(NEW.generation) <> 'integer' OR NEW.generation NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN NEW.due_at IS NOT NULL AND (typeof(NEW.due_at) <> 'integer' OR NEW.due_at NOT BETWEEN 0 AND 9007199254740991) THEN 1
	WHEN typeof(NEW.enqueued_at) <> 'integer' OR NEW.enqueued_at NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN typeof(NEW.claim) <> 'integer' OR NEW.claim NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN typeof(NEW.attempts) <> 'integer' OR NEW.attempts NOT BETWEEN 0 AND 4 THEN 1
	WHEN CASE WHEN NEW.token IS NULL THEN 0
	WHEN typeof(NEW.token) <> 'text' THEN 1
	WHEN length(CAST(NEW.token AS BLOB)) NOT BETWEEN 32 AND 64 THEN 1
	WHEN instr(CAST(NEW.token AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.token GLOB '*[^A-Za-z0-9_-]*' THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN NEW.ext IS NULL THEN 0
	WHEN typeof(NEW.ext) <> 'text' THEN 1
	WHEN NEW.ext NOT IN ('jpg', 'png', 'gif', 'webp', 'avif', 'mp4', 'webm', 'm4a', 'mp3', 'flac', 'wav') THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN NEW.still_ext IS NULL THEN 0
	WHEN typeof(NEW.still_ext) <> 'text' THEN 1
	WHEN NEW.still_ext NOT IN ('jpg', 'png', 'gif', 'webp', 'avif', 'mp4', 'webm', 'm4a', 'mp3', 'flac', 'wav') THEN 1
	ELSE 0 END THEN 1
	WHEN NEW.stored_at IS NOT NULL AND (typeof(NEW.stored_at) <> 'integer' OR NEW.stored_at NOT BETWEEN 0 AND 9007199254740991) THEN 1
	WHEN NEW.failed_at IS NOT NULL AND (typeof(NEW.failed_at) <> 'integer' OR NEW.failed_at NOT BETWEEN 0 AND 9007199254740991) THEN 1
	WHEN NEW.seen_at IS NOT NULL AND (typeof(NEW.seen_at) <> 'integer' OR NEW.seen_at NOT BETWEEN 0 AND 9007199254740991) THEN 1
	WHEN (NEW.owner_id IS NULL) <> (NEW.kind = 'emoji') THEN 1
	WHEN (NEW.account_id IS NULL) <> (NEW.kind = 'emoji') THEN 1
	WHEN (NEW.domain IS NULL) = (NEW.kind = 'emoji') THEN 1
	WHEN (NEW.token IS NULL) <> (NEW.ext IS NULL) OR (NEW.token IS NULL) <> (NEW.stored_at IS NULL) THEN 1
	WHEN NEW.token IS NOT NULL AND (NEW.due_at IS NOT NULL OR NEW.failed_at IS NOT NULL) THEN 1
	WHEN NEW.still_ext IS NOT NULL AND NEW.token IS NULL THEN 1
	WHEN NEW.failed_at IS NOT NULL AND NEW.due_at IS NOT NULL THEN 1
	WHEN CASE WHEN NEW.still_key IS NULL THEN 0
	WHEN typeof(NEW.still_key) <> 'text' THEN 1
	WHEN length(CAST(NEW.still_key AS BLOB)) <> 33 THEN 1
	WHEN substr(NEW.still_key, 1, 1) <> 's' THEN 1
	WHEN substr(NEW.still_key, 2) GLOB '*[^0-9a-f]*' THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN NEW.still_blurhash IS NULL THEN 0
	WHEN typeof(NEW.still_blurhash) <> 'text' THEN 1
	WHEN length(CAST(NEW.still_blurhash AS BLOB)) NOT BETWEEN 6 AND 54 THEN 1
	WHEN instr(CAST(NEW.still_blurhash AS BLOB), x'00') > 0 THEN 1
	WHEN rtrim(NEW.still_blurhash, '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~') <> '' THEN 1
	WHEN (SELECT f % 9 >= 5 OR f / 9 >= 5
			OR length(NEW.still_blurhash) <> 4 + 2 * (f % 9 + 1) * (f / 9 + 1)
		FROM (SELECT instr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~', substr(NEW.still_blurhash, 1, 1)) - 1 AS f)) THEN 1
	ELSE 0 END THEN 1
	WHEN NEW.still_key IS NOT NULL AND NEW.still_ext IS NULL THEN 1
	WHEN NEW.still_blurhash IS NOT NULL AND NEW.still_key IS NULL THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'remote_media: a value past its stored bound');
END;

CREATE TRIGGER remote_media_stills_bounds_insert BEFORE INSERT ON remote_media_stills
WHEN CASE WHEN NEW.token IS NULL OR CASE WHEN NEW.token IS NULL THEN 0
	WHEN typeof(NEW.token) <> 'text' THEN 1
	WHEN length(CAST(NEW.token AS BLOB)) NOT BETWEEN 32 AND 64 THEN 1
	WHEN instr(CAST(NEW.token AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.token GLOB '*[^A-Za-z0-9_-]*' THEN 1
	ELSE 0 END THEN 1
	WHEN typeof(NEW.state) <> 'text' OR NEW.state NOT IN ('queued', 'stored') THEN 1
	WHEN typeof(NEW.claims) <> 'integer' OR NEW.claims NOT BETWEEN 0 AND 3 THEN 1
	WHEN NEW.due_at IS NOT NULL AND (typeof(NEW.due_at) <> 'integer' OR NEW.due_at NOT BETWEEN 0 AND 9007199254740991) THEN 1
	WHEN NEW.claimed_at IS NOT NULL AND (typeof(NEW.claimed_at) <> 'integer' OR NEW.claimed_at NOT BETWEEN 0 AND 9007199254740991) THEN 1
	WHEN CASE WHEN NEW.attempt IS NULL THEN 0
	WHEN typeof(NEW.attempt) <> 'text' THEN 1
	WHEN length(CAST(NEW.attempt AS BLOB)) <> 32 THEN 1
	WHEN NEW.attempt GLOB '*[^0-9a-f]*' THEN 1
	ELSE 0 END THEN 1
	WHEN NEW.outcome IS NOT NULL AND (typeof(NEW.outcome) <> 'text' OR NEW.outcome NOT IN ('retry', 'park')) THEN 1
	WHEN typeof(NEW.still_charge) <> 'integer' OR NEW.still_charge NOT BETWEEN 0 AND 2097152 THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'remote_media_stills: a value past its stored bound');
END;

CREATE TRIGGER remote_media_stills_bounds_update BEFORE UPDATE OF token, state, claims, due_at, claimed_at, attempt, outcome, still_charge ON remote_media_stills
WHEN CASE WHEN NEW.token IS NULL OR CASE WHEN NEW.token IS NULL THEN 0
	WHEN typeof(NEW.token) <> 'text' THEN 1
	WHEN length(CAST(NEW.token AS BLOB)) NOT BETWEEN 32 AND 64 THEN 1
	WHEN instr(CAST(NEW.token AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.token GLOB '*[^A-Za-z0-9_-]*' THEN 1
	ELSE 0 END THEN 1
	WHEN typeof(NEW.state) <> 'text' OR NEW.state NOT IN ('queued', 'stored') THEN 1
	WHEN typeof(NEW.claims) <> 'integer' OR NEW.claims NOT BETWEEN 0 AND 3 THEN 1
	WHEN NEW.due_at IS NOT NULL AND (typeof(NEW.due_at) <> 'integer' OR NEW.due_at NOT BETWEEN 0 AND 9007199254740991) THEN 1
	WHEN NEW.claimed_at IS NOT NULL AND (typeof(NEW.claimed_at) <> 'integer' OR NEW.claimed_at NOT BETWEEN 0 AND 9007199254740991) THEN 1
	WHEN CASE WHEN NEW.attempt IS NULL THEN 0
	WHEN typeof(NEW.attempt) <> 'text' THEN 1
	WHEN length(CAST(NEW.attempt AS BLOB)) <> 32 THEN 1
	WHEN NEW.attempt GLOB '*[^0-9a-f]*' THEN 1
	ELSE 0 END THEN 1
	WHEN NEW.outcome IS NOT NULL AND (typeof(NEW.outcome) <> 'text' OR NEW.outcome NOT IN ('retry', 'park')) THEN 1
	WHEN typeof(NEW.still_charge) <> 'integer' OR NEW.still_charge NOT BETWEEN 0 AND 2097152 THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'remote_media_stills: a value past its stored bound');
END;
