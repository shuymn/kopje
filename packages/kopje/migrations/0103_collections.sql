-- Kopje Store schema 0100: collections (Mastodon 4.6's Collection and CollectionItem, for /api/v1/collections;
-- src/domain/collections.ts). Never edit after release (checksummed).
--
--   collections                   one row per collection: its owner (the account's delete cascades), local, the name,
--                                 description, language, sensitive and discoverable flags, the hashtag's display name
--                                 (NULL when none), and, for a remote collection only, uri, url and total_items (NULL
--                                 on a local one), created_at and updated_at on the Store's clock.
--   collections_account           an account's collections in creation order; collections_uri a remote one by uri.
--   collection_items              one row per member of a collection: the member's account (NULL only while a remote
--                                 item is unresolved, object_uri then naming it), the state (0 pending, 1 accepted,
--                                 2 rejected, 3 revoked), the position, the remote URIs (the item's own, its
--                                 featuredObject, the request or its answer, the authorization asserted, verified and
--                                 first retracted) and the columns of the item-check queue (due time, attempts, the
--                                 claim's token, the answer it watches). The collection's or the member's delete
--                                 cascades. A row's CHECKs tie them: a member or its object; a queued check has a
--                                 candidate; a token is queued; a watched answer is queued unclaimed; a verified
--                                 authorization has an account; a retraction is pending without either authorization;
--                                 an accepted item has an account.
--   collection_items_member       one item per member and collection, any state; collection_items_order the items in
--                                 order; collection_items_account a member's items; collection_items_uri,
--                                 collection_items_approval (per member) and collection_items_activity by URI;
--                                 collection_items_retired the rejected and revoked items for the cleanup;
--                                 collection_items_check the queued checks.
--   reports.collection_ids        NULL, or a JSON array of the reported collections' ids. Every existing row holds
--                                 NULL; no row is rewritten.
--   collections_per_account       BEFORE INSERT and BEFORE UPDATE OF account_id: RAISE(ABORT, 'collections: past the
--   collections_per_account_move  per-account bound') past MAX_STORED_COLLECTIONS rows of one account.
--   collection_items_per_collection       BEFORE INSERT and BEFORE UPDATE OF collection_id: RAISE(ABORT,
--   collection_items_per_collection_move  'collection_items: past the per-collection bound') past MAX_STORED_ITEMS.
--   collection_items_live         BEFORE INSERT, and BEFORE UPDATE OF state, collection_id into a live state:
--   collection_items_live_update  RAISE(ABORT, 'collection_items: past the live bound') past COLLECTION_MAX_ITEMS
--                                 pending and accepted items of one collection.
--   reports_collection_ids_insert BEFORE INSERT and BEFORE UPDATE OF collection_ids on reports: RAISE(ABORT,
--   reports_collection_ids_update 'reports: collection_ids past its stored bound') past REPORT_COLLECTION_IDS ids of
--                                 18 ASCII digits or REPORT_COLLECTION_IDS_BYTES bytes. No trigger writes.
--
-- Bounds (src/platform/stored-bounds.ts, the collections section; src/domain/status-bounds.ts TAG_NAME_BYTES,
-- MAX_TAG_LENGTH; src/domain/trend-languages.ts TREND_LANGUAGES): ids 18 ASCII digits; a local name 1 to 40 and a
-- remote one 1 to 256 characters, a local description at most 100 and a remote one 2,048, each at most 4 bytes a
-- character, no NUL; the language a supported locale; the flags 0 or 1; the tag 1 to TAG_NAME_BYTES raw bytes, at most
-- MAX_TAG_LENGTH characters; the URIs https URLs of printable ASCII within 2,048 bytes; total_items and position to
-- 2^31 - 1; the check's due time to 2^53 - 1, its attempts to 5, its token a 36-byte UUID; the times Kopje's 24-byte
-- form. The statements below are the output of collectionsMigrationSql and of src/domain/stored-triggers.ts
-- (test/migrations.test.ts compares them); stored form: docs/dump-format.md.
--
-- Cost: the tables and their indexes are new and empty, the column, without a default or a CHECK, is added to the
-- schema only, and the triggers read no row. A file that creates a table cannot declare foreignKeys: 'unchanged'
-- (test/migration-sql.ts), so its upgrade checks every reference of the Store. Measured on the benchmark store of
-- test/bench/migration-cost.ts in workerd's local Durable Object SQLite: see the CHANGELOG entry of this file.

CREATE TABLE collections (
  id TEXT NOT NULL PRIMARY KEY CONSTRAINT collection_id CHECK ((CASE
      WHEN typeof(id) <> 'text' THEN 0
      WHEN length(CAST(id AS BLOB)) <> 18 THEN 0
      WHEN instr(CAST(id AS BLOB), x'00') > 0 THEN 0
      WHEN id NOT GLOB '*[^0-9]*' THEN 1
      ELSE 0 END) = 1),
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  local INTEGER NOT NULL CONSTRAINT collection_local CHECK ((CASE
      WHEN typeof(local) <> 'integer' THEN 0
      WHEN local BETWEEN 0 AND 1 THEN 1
      ELSE 0 END) = 1),
  name TEXT NOT NULL CONSTRAINT collection_name CHECK ((CASE
      WHEN typeof(name) <> 'text' THEN 0
      WHEN length(CAST(name AS BLOB)) > 4 * (CASE WHEN local = 1 THEN 40 ELSE 256 END) THEN 0
      WHEN instr(CAST(name AS BLOB), x'00') > 0 THEN 0
      WHEN length(name) BETWEEN 1 AND CASE WHEN local = 1 THEN 40 ELSE 256 END THEN 1
      ELSE 0 END) = 1),
  description TEXT CONSTRAINT collection_description CHECK ((CASE
      WHEN description IS NULL THEN 1
      WHEN typeof(description) <> 'text' THEN 0
      WHEN length(CAST(description AS BLOB)) > 4 * (CASE WHEN local = 1 THEN 100 ELSE 2048 END) THEN 0
      WHEN instr(CAST(description AS BLOB), x'00') > 0 THEN 0
      WHEN length(description) BETWEEN 0 AND CASE WHEN local = 1 THEN 100 ELSE 2048 END THEN 1
      ELSE 0 END) = 1),
  language TEXT CONSTRAINT collection_language CHECK ((CASE
      WHEN language IS NULL THEN 1
      WHEN typeof(language) <> 'text' THEN 0
      WHEN length(CAST(language AS BLOB)) > 16 THEN 0
      WHEN instr(CAST(language AS BLOB), x'00') > 0 THEN 0
      WHEN language IN ('aa', 'ab', 'ae', 'af', 'ak', 'am', 'an', 'ar', 'as', 'av', 'ay', 'az', 'ba', 'be', 'bg', 'bh',
        'bi', 'bm', 'bn', 'bo', 'br', 'bs', 'ca', 'ce', 'ch', 'co', 'cr', 'cs', 'cu', 'cv', 'cy', 'da',
        'de', 'dv', 'dz', 'ee', 'el', 'en', 'eo', 'es', 'et', 'eu', 'fa', 'ff', 'fi', 'fj', 'fo', 'fr',
        'fy', 'ga', 'gd', 'gl', 'gu', 'gv', 'ha', 'he', 'hi', 'ho', 'hr', 'ht', 'hu', 'hy', 'hz', 'ia',
        'id', 'ie', 'ig', 'ii', 'ik', 'io', 'is', 'it', 'iu', 'ja', 'jv', 'ka', 'kg', 'ki', 'kj', 'kk',
        'kl', 'km', 'kn', 'ko', 'kr', 'ks', 'ku', 'kv', 'kw', 'ky', 'la', 'lb', 'lg', 'li', 'ln', 'lo',
        'lt', 'lu', 'lv', 'mg', 'mh', 'mi', 'mk', 'ml', 'mn', 'mn-Mong', 'mr', 'ms', 'ms-Arab', 'mt', 'my', 'na',
        'nb', 'nd', 'ne', 'ng', 'nl', 'nn', 'no', 'nr', 'nv', 'ny', 'oc', 'oj', 'om', 'or', 'os', 'pa',
        'pi', 'pl', 'ps', 'pt', 'qu', 'rm', 'rn', 'ro', 'ru', 'rw', 'sa', 'sc', 'sd', 'se', 'sg', 'si',
        'sk', 'sl', 'sn', 'so', 'sq', 'sr', 'ss', 'st', 'su', 'sv', 'sw', 'ta', 'te', 'tg', 'th', 'ti',
        'tk', 'tl', 'tn', 'to', 'tr', 'ts', 'tt', 'tw', 'ty', 'ug', 'uk', 'ur', 'uz', 've', 'vi', 'vo',
        'wa', 'wo', 'xh', 'yi', 'yo', 'za', 'zh', 'zu', 'zh-CN', 'zh-HK', 'zh-TW', 'zh-YUE', 'ast', 'chr', 'ckb', 'cnr',
        'csb', 'gsw', 'jbo', 'kab', 'ldn', 'lfn', 'moh', 'nds', 'pdc', 'sco', 'sma', 'smj', 'szl', 'tok', 'vai', 'xal',
        'zba', 'zgh') THEN 1
      ELSE 0 END) = 1),
  sensitive INTEGER NOT NULL CONSTRAINT collection_sensitive CHECK ((CASE
      WHEN typeof(sensitive) <> 'integer' THEN 0
      WHEN sensitive BETWEEN 0 AND 1 THEN 1
      ELSE 0 END) = 1),
  discoverable INTEGER NOT NULL CONSTRAINT collection_discoverable CHECK ((CASE
      WHEN typeof(discoverable) <> 'integer' THEN 0
      WHEN discoverable BETWEEN 0 AND 1 THEN 1
      ELSE 0 END) = 1),
  tag TEXT CONSTRAINT collection_tag CHECK ((CASE
      WHEN tag IS NULL THEN 1
      WHEN typeof(tag) <> 'text' THEN 0
      WHEN length(CAST(tag AS BLOB)) NOT BETWEEN 1 AND 1024 THEN 0
      WHEN instr(CAST(tag AS BLOB), x'00') > 0 THEN 0
      WHEN length(tag) <= 256 THEN 1
      ELSE 0 END) = 1),
  uri TEXT CONSTRAINT collection_uri CHECK ((CASE
      WHEN local = 1 THEN uri IS NULL
      WHEN typeof(uri) <> 'text' THEN 0
      WHEN length(CAST(uri AS BLOB)) > 2048 THEN 0
      WHEN instr(CAST(uri AS BLOB), x'00') > 0 THEN 0
      WHEN uri GLOB 'https://?*' AND uri NOT GLOB '*[^!-~]*' THEN 1
      ELSE 0 END) = 1),
  url TEXT CONSTRAINT collection_url CHECK ((CASE
      WHEN local = 1 THEN url IS NULL
      WHEN url IS NULL THEN 1
      WHEN typeof(url) <> 'text' THEN 0
      WHEN length(CAST(url AS BLOB)) > 2048 THEN 0
      WHEN instr(CAST(url AS BLOB), x'00') > 0 THEN 0
      WHEN url GLOB 'https://?*' AND url NOT GLOB '*[^!-~]*' THEN 1
      ELSE 0 END) = 1),
  total_items INTEGER CONSTRAINT collection_total_items CHECK ((CASE
      WHEN local = 1 THEN total_items IS NULL
      WHEN total_items IS NULL THEN 1
      WHEN typeof(total_items) <> 'integer' THEN 0
      WHEN total_items BETWEEN 0 AND 2147483647 THEN 1
      ELSE 0 END) = 1),
  created_at TEXT NOT NULL CONSTRAINT collection_created_at CHECK ((CASE
      WHEN typeof(created_at) <> 'text' THEN 0
      WHEN length(CAST(created_at AS BLOB)) <> 24 THEN 0
      WHEN instr(CAST(created_at AS BLOB), x'00') > 0 THEN 0
      WHEN length(CAST(created_at AS BLOB)) = 24 AND substr(created_at, 12, 2) < '24'
        AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at THEN 1
      ELSE 0 END) = 1),
  updated_at TEXT NOT NULL CONSTRAINT collection_updated_at CHECK ((CASE
      WHEN typeof(updated_at) <> 'text' THEN 0
      WHEN length(CAST(updated_at AS BLOB)) <> 24 THEN 0
      WHEN instr(CAST(updated_at AS BLOB), x'00') > 0 THEN 0
      WHEN length(CAST(updated_at AS BLOB)) = 24 AND substr(updated_at, 12, 2) < '24'
        AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at THEN 1
      ELSE 0 END) = 1)
);

CREATE INDEX collections_account ON collections (account_id, created_at, id);
CREATE UNIQUE INDEX collections_uri ON collections (uri) WHERE uri IS NOT NULL;

CREATE TABLE collection_items (
  id TEXT NOT NULL PRIMARY KEY CONSTRAINT collection_item_id CHECK ((CASE
      WHEN typeof(id) <> 'text' THEN 0
      WHEN length(CAST(id AS BLOB)) <> 18 THEN 0
      WHEN instr(CAST(id AS BLOB), x'00') > 0 THEN 0
      WHEN id NOT GLOB '*[^0-9]*' THEN 1
      ELSE 0 END) = 1),
  collection_id TEXT NOT NULL REFERENCES collections (id) ON DELETE CASCADE,
  account_id TEXT REFERENCES accounts (id) ON DELETE CASCADE,
  state INTEGER NOT NULL CONSTRAINT collection_item_state CHECK ((CASE
      WHEN typeof(state) <> 'integer' THEN 0
      WHEN state BETWEEN 0 AND 3 THEN 1
      ELSE 0 END) = 1),
  position INTEGER NOT NULL CONSTRAINT collection_item_position CHECK ((CASE
      WHEN typeof(position) <> 'integer' THEN 0
      WHEN position BETWEEN 1 AND 2147483647 THEN 1
      ELSE 0 END) = 1),
  uri TEXT CONSTRAINT collection_item_uri CHECK ((CASE
      WHEN uri IS NULL THEN 1
      WHEN typeof(uri) <> 'text' THEN 0
      WHEN length(CAST(uri AS BLOB)) > 2048 THEN 0
      WHEN instr(CAST(uri AS BLOB), x'00') > 0 THEN 0
      WHEN uri GLOB 'https://?*' AND uri NOT GLOB '*[^!-~]*' THEN 1
      ELSE 0 END) = 1),
  object_uri TEXT CONSTRAINT collection_item_object_uri CHECK ((CASE
      WHEN object_uri IS NULL THEN 1
      WHEN typeof(object_uri) <> 'text' THEN 0
      WHEN length(CAST(object_uri AS BLOB)) > 2048 THEN 0
      WHEN instr(CAST(object_uri AS BLOB), x'00') > 0 THEN 0
      WHEN object_uri GLOB 'https://?*' AND object_uri NOT GLOB '*[^!-~]*' THEN 1
      ELSE 0 END) = 1),
  activity_uri TEXT CONSTRAINT collection_item_activity_uri CHECK ((CASE
      WHEN activity_uri IS NULL THEN 1
      WHEN typeof(activity_uri) <> 'text' THEN 0
      WHEN length(CAST(activity_uri AS BLOB)) > 2048 THEN 0
      WHEN instr(CAST(activity_uri AS BLOB), x'00') > 0 THEN 0
      WHEN activity_uri GLOB 'https://?*' AND activity_uri NOT GLOB '*[^!-~]*' THEN 1
      ELSE 0 END) = 1),
  candidate_approval_uri TEXT CONSTRAINT collection_item_candidate_approval_uri CHECK ((CASE
      WHEN candidate_approval_uri IS NULL THEN 1
      WHEN typeof(candidate_approval_uri) <> 'text' THEN 0
      WHEN length(CAST(candidate_approval_uri AS BLOB)) > 2048 THEN 0
      WHEN instr(CAST(candidate_approval_uri AS BLOB), x'00') > 0 THEN 0
      WHEN candidate_approval_uri GLOB 'https://?*' AND candidate_approval_uri NOT GLOB '*[^!-~]*' THEN 1
      ELSE 0 END) = 1),
  approval_uri TEXT CONSTRAINT collection_item_approval_uri CHECK ((CASE
      WHEN approval_uri IS NULL THEN 1
      WHEN typeof(approval_uri) <> 'text' THEN 0
      WHEN length(CAST(approval_uri AS BLOB)) > 2048 THEN 0
      WHEN instr(CAST(approval_uri AS BLOB), x'00') > 0 THEN 0
      WHEN approval_uri GLOB 'https://?*' AND approval_uri NOT GLOB '*[^!-~]*' THEN 1
      ELSE 0 END) = 1),
  retracted_approval_uri TEXT CONSTRAINT collection_item_retracted_approval_uri CHECK ((CASE
      WHEN retracted_approval_uri IS NULL THEN 1
      WHEN typeof(retracted_approval_uri) <> 'text' THEN 0
      WHEN length(CAST(retracted_approval_uri AS BLOB)) > 2048 THEN 0
      WHEN instr(CAST(retracted_approval_uri AS BLOB), x'00') > 0 THEN 0
      WHEN retracted_approval_uri GLOB 'https://?*' AND retracted_approval_uri NOT GLOB '*[^!-~]*' THEN 1
      ELSE 0 END) = 1),
  check_due_at INTEGER CONSTRAINT collection_item_check_due_at CHECK ((CASE
      WHEN check_due_at IS NULL THEN 1
      WHEN typeof(check_due_at) <> 'integer' THEN 0
      WHEN check_due_at BETWEEN 0 AND 9007199254740991 THEN 1
      ELSE 0 END) = 1),
  check_attempts INTEGER NOT NULL DEFAULT 0 CONSTRAINT collection_item_check_attempts CHECK ((CASE
      WHEN typeof(check_attempts) <> 'integer' THEN 0
      WHEN check_attempts BETWEEN 0 AND 5 THEN 1
      ELSE 0 END) = 1),
  check_token TEXT CONSTRAINT collection_item_check_token CHECK ((CASE
      WHEN check_token IS NULL THEN 1
      WHEN typeof(check_token) <> 'text' THEN 0
      WHEN length(CAST(check_token AS BLOB)) <> 36 THEN 0
      WHEN instr(CAST(check_token AS BLOB), x'00') > 0 THEN 0
      WHEN check_token NOT GLOB '*[^0-9a-f-]*' THEN 1
      ELSE 0 END) = 1),
  answer_activity_id INTEGER CONSTRAINT collection_item_answer_activity_id CHECK ((CASE
      WHEN answer_activity_id IS NULL THEN 1
      WHEN typeof(answer_activity_id) <> 'integer' THEN 0
      WHEN answer_activity_id BETWEEN 1 AND 9223372036854775807 THEN 1
      ELSE 0 END) = 1),
  created_at TEXT NOT NULL CONSTRAINT collection_item_created_at CHECK ((CASE
      WHEN typeof(created_at) <> 'text' THEN 0
      WHEN length(CAST(created_at AS BLOB)) <> 24 THEN 0
      WHEN instr(CAST(created_at AS BLOB), x'00') > 0 THEN 0
      WHEN length(CAST(created_at AS BLOB)) = 24 AND substr(created_at, 12, 2) < '24'
        AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at THEN 1
      ELSE 0 END) = 1),
  updated_at TEXT NOT NULL CONSTRAINT collection_item_updated_at CHECK ((CASE
      WHEN typeof(updated_at) <> 'text' THEN 0
      WHEN length(CAST(updated_at AS BLOB)) <> 24 THEN 0
      WHEN instr(CAST(updated_at AS BLOB), x'00') > 0 THEN 0
      WHEN length(CAST(updated_at AS BLOB)) = 24 AND substr(updated_at, 12, 2) < '24'
        AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at THEN 1
      ELSE 0 END) = 1),
  CONSTRAINT collection_item_member CHECK ((CASE
      WHEN account_id IS NOT NULL OR object_uri IS NOT NULL THEN 1
      ELSE 0 END) = 1),
  CONSTRAINT collection_item_queued CHECK ((CASE
      WHEN check_due_at IS NULL OR candidate_approval_uri IS NOT NULL THEN 1
      ELSE 0 END) = 1),
  CONSTRAINT collection_item_claimed CHECK ((CASE
      WHEN check_token IS NULL OR check_due_at IS NOT NULL THEN 1
      ELSE 0 END) = 1),
  CONSTRAINT collection_item_watched CHECK ((CASE
      WHEN answer_activity_id IS NULL THEN 1
      WHEN check_due_at IS NOT NULL AND check_token IS NULL THEN 1
      ELSE 0 END) = 1),
  CONSTRAINT collection_item_approved CHECK ((CASE
      WHEN approval_uri IS NULL OR account_id IS NOT NULL THEN 1
      ELSE 0 END) = 1),
  CONSTRAINT collection_item_retracted CHECK ((CASE
      WHEN retracted_approval_uri IS NULL THEN 1
      WHEN state = 0 AND approval_uri IS NULL AND candidate_approval_uri IS NULL THEN 1
      ELSE 0 END) = 1),
  CONSTRAINT collection_item_accepted CHECK ((CASE
      WHEN state <> 1 OR account_id IS NOT NULL THEN 1
      ELSE 0 END) = 1)
);

CREATE UNIQUE INDEX collection_items_member ON collection_items (collection_id, account_id) WHERE account_id IS NOT NULL;
CREATE INDEX collection_items_order ON collection_items (collection_id, position, id);
CREATE INDEX collection_items_account ON collection_items (account_id, id) WHERE account_id IS NOT NULL;
CREATE UNIQUE INDEX collection_items_uri ON collection_items (uri) WHERE uri IS NOT NULL;
CREATE UNIQUE INDEX collection_items_approval ON collection_items (account_id, approval_uri) WHERE approval_uri IS NOT NULL;
CREATE INDEX collection_items_activity ON collection_items (activity_uri) WHERE activity_uri IS NOT NULL;
CREATE INDEX collection_items_retired ON collection_items (updated_at, id) WHERE state IN (2, 3);
CREATE INDEX collection_items_check ON collection_items (check_due_at, id) WHERE check_due_at IS NOT NULL;

ALTER TABLE reports ADD COLUMN collection_ids TEXT;

CREATE TRIGGER collections_per_account BEFORE INSERT ON collections
WHEN (SELECT count(*) FROM (SELECT 1 FROM collections WHERE account_id = NEW.account_id
    LIMIT 50)) >= 50
BEGIN
  SELECT RAISE(ABORT, 'collections: past the per-account bound');
END;

CREATE TRIGGER collections_per_account_move BEFORE UPDATE OF account_id ON collections
WHEN NEW.account_id IS NOT OLD.account_id
  AND (SELECT count(*) FROM (SELECT 1 FROM collections WHERE account_id = NEW.account_id AND id <> OLD.id
    LIMIT 50)) >= 50
BEGIN
  SELECT RAISE(ABORT, 'collections: past the per-account bound');
END;

CREATE TRIGGER collection_items_per_collection BEFORE INSERT ON collection_items
WHEN (SELECT count(*) FROM (SELECT 1 FROM collection_items WHERE collection_id = NEW.collection_id
    LIMIT 50)) >= 50
BEGIN
  SELECT RAISE(ABORT, 'collection_items: past the per-collection bound');
END;

CREATE TRIGGER collection_items_per_collection_move BEFORE UPDATE OF collection_id ON collection_items
WHEN NEW.collection_id IS NOT OLD.collection_id
  AND (SELECT count(*) FROM (SELECT 1 FROM collection_items WHERE collection_id = NEW.collection_id AND id <> OLD.id
    LIMIT 50)) >= 50
BEGIN
  SELECT RAISE(ABORT, 'collection_items: past the per-collection bound');
END;

CREATE TRIGGER collection_items_live BEFORE INSERT ON collection_items
WHEN NEW.state IN (0, 1)
  AND (SELECT count(*) FROM (SELECT 1 FROM collection_items WHERE collection_id = NEW.collection_id AND state IN (0, 1)
    LIMIT 25)) >= 25
BEGIN
  SELECT RAISE(ABORT, 'collection_items: past the live bound');
END;

CREATE TRIGGER collection_items_live_update BEFORE UPDATE OF state, collection_id ON collection_items
WHEN NEW.state IN (0, 1) AND (OLD.state NOT IN (0, 1) OR NEW.collection_id IS NOT OLD.collection_id)
  AND (SELECT count(*) FROM (SELECT 1 FROM collection_items WHERE collection_id = NEW.collection_id AND state IN (0, 1)
    AND id <> OLD.id LIMIT 25)) >= 25
BEGIN
  SELECT RAISE(ABORT, 'collection_items: past the live bound');
END;

CREATE TRIGGER reports_collection_ids_insert BEFORE INSERT ON reports
WHEN CASE WHEN NEW.collection_ids IS NULL THEN 0
	WHEN typeof(NEW.collection_ids) <> 'text' THEN 1
	WHEN length(CAST(NEW.collection_ids AS BLOB)) > 1051 THEN 1
	WHEN instr(CAST(NEW.collection_ids AS BLOB), x'00') > 0 THEN 1
	WHEN NOT json_valid(NEW.collection_ids) THEN 1
	WHEN json_type(NEW.collection_ids) <> 'array' THEN 1
	WHEN json_array_length(NEW.collection_ids) > 50 THEN 1
	WHEN EXISTS (SELECT 1 FROM json_each(NEW.collection_ids) e WHERE e.type <> 'text'
		OR length(CAST(e.value AS BLOB)) <> 18 OR instr(CAST(e.value AS BLOB), x'00') > 0
		OR e.value GLOB '*[^0-9]*') THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'reports: collection_ids past its stored bound');
END;

CREATE TRIGGER reports_collection_ids_update BEFORE UPDATE OF collection_ids ON reports
WHEN CASE WHEN NEW.collection_ids IS NULL THEN 0
	WHEN typeof(NEW.collection_ids) <> 'text' THEN 1
	WHEN length(CAST(NEW.collection_ids AS BLOB)) > 1051 THEN 1
	WHEN instr(CAST(NEW.collection_ids AS BLOB), x'00') > 0 THEN 1
	WHEN NOT json_valid(NEW.collection_ids) THEN 1
	WHEN json_type(NEW.collection_ids) <> 'array' THEN 1
	WHEN json_array_length(NEW.collection_ids) > 50 THEN 1
	WHEN EXISTS (SELECT 1 FROM json_each(NEW.collection_ids) e WHERE e.type <> 'text'
		OR length(CAST(e.value AS BLOB)) <> 18 OR instr(CAST(e.value AS BLOB), x'00') > 0
		OR e.value GLOB '*[^0-9]*') THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'reports: collection_ids past its stored bound');
END;
