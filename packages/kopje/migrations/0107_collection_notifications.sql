-- Kopje Store schema 0107: notifications of collections (Mastodon 4.7.5's added_to_collection and collection_update;
-- src/domain/notifications.ts, src/domain/collections.ts). Never edit after release (checksummed).
--
--   notifications.collection_item_id  the item an added_to_collection notification is about (its activity, a
--                             CollectionItem), NULL for every other type. It goes with its item (ON DELETE CASCADE).
--   notifications.collection_id       the collection a collection_update notification is about (its activity), NULL
--                             for every other type. It goes with its collection (ON DELETE CASCADE).
--   notifications_collection_item     UNIQUE: at most one notification an item (its member's added_to_collection), and
--   notifications_collection          one collection_update a collection and recipient, as LocalNotificationWorker keys
--                             each by recipient, activity and type and the writers write them; imports included, so a
--                             deleted item or collection finds at most that many notifications by key. Each holds only
--                             the rows naming one, and serves its foreign key.
--   notifications_natural    (0063_account_warning_notifications_key) gains the two keys, so one owner's two
--                             collections each notify a member, and a collection_update is replaced by its collection
--                             (LocalNotificationWorker keys a notification by its activity). Every other notification
--                             holds neither, so its key is unchanged, and reads by the key's leading columns still use
--                             it.
--   notifications_collection_insert   BEFORE INSERT and BEFORE UPDATE OF type, collection_item_id, collection_id:
--   notifications_collection_update   RAISE(ABORT, 'notifications: collection keys past their stored bound') unless
--                             each key is NULL or 18 ASCII digits as TEXT, an added_to_collection names its item
--                             alone, a collection_update its collection alone, and any other type neither.
--
-- Bounds and the predicate: src/platform/stored-bounds.ts (notificationCollectionKeysPastBoundSql); the triggers are
-- the output of src/domain/stored-triggers.ts (test/migrations.test.ts compares them); stored form:
-- docs/dump-format.md. No existing row is rewritten: every one holds NULL in both columns.
--
-- Cost: the ALTERs change the schema alone; the partial indexes read each notification once and hold none; the
-- natural key is rebuilt over every notification (a sort of the notifications, as 0063's). A file that adds a foreign
-- key cannot declare foreignKeys: 'unchanged' (test/migration-sql.ts), so its upgrade checks every reference of the
-- Store. Measured on the benchmark store of test/bench/migration-cost.ts in workerd's local Durable Object SQLite: see
-- the CHANGELOG entry of this file.

ALTER TABLE notifications ADD COLUMN collection_item_id TEXT REFERENCES collection_items (id) ON DELETE CASCADE;
ALTER TABLE notifications ADD COLUMN collection_id TEXT REFERENCES collections (id) ON DELETE CASCADE;

CREATE UNIQUE INDEX notifications_collection_item ON notifications (collection_item_id)
  WHERE collection_item_id IS NOT NULL;
CREATE UNIQUE INDEX notifications_collection ON notifications (collection_id, account_id) WHERE collection_id IS NOT NULL;

DROP INDEX notifications_natural;

CREATE UNIQUE INDEX notifications_natural ON notifications
  (account_id, type, from_account_id, IFNULL(status_id, ''), IFNULL(report_id, 0), IFNULL(account_warning_id, 0),
  IFNULL(collection_item_id, ''), IFNULL(collection_id, ''));

CREATE TRIGGER notifications_collection_insert BEFORE INSERT ON notifications
WHEN CASE WHEN NEW.collection_item_id IS NOT NULL AND (typeof(NEW.collection_item_id) <> 'text'
		OR length(CAST(NEW.collection_item_id AS BLOB)) <> 18 OR instr(CAST(NEW.collection_item_id AS BLOB), x'00') > 0 OR NEW.collection_item_id GLOB '*[^0-9]*') THEN 1
	WHEN NEW.collection_id IS NOT NULL AND (typeof(NEW.collection_id) <> 'text'
		OR length(CAST(NEW.collection_id AS BLOB)) <> 18 OR instr(CAST(NEW.collection_id AS BLOB), x'00') > 0 OR NEW.collection_id GLOB '*[^0-9]*') THEN 1
	WHEN NEW.type = 'added_to_collection' THEN NEW.collection_item_id IS NULL OR NEW.collection_id IS NOT NULL
	WHEN NEW.type = 'collection_update' THEN NEW.collection_id IS NULL OR NEW.collection_item_id IS NOT NULL
	ELSE NEW.collection_item_id IS NOT NULL OR NEW.collection_id IS NOT NULL END
BEGIN
  SELECT RAISE(ABORT, 'notifications: collection keys past their stored bound');
END;

CREATE TRIGGER notifications_collection_update BEFORE UPDATE OF type, collection_item_id, collection_id ON notifications
WHEN CASE WHEN NEW.collection_item_id IS NOT NULL AND (typeof(NEW.collection_item_id) <> 'text'
		OR length(CAST(NEW.collection_item_id AS BLOB)) <> 18 OR instr(CAST(NEW.collection_item_id AS BLOB), x'00') > 0 OR NEW.collection_item_id GLOB '*[^0-9]*') THEN 1
	WHEN NEW.collection_id IS NOT NULL AND (typeof(NEW.collection_id) <> 'text'
		OR length(CAST(NEW.collection_id AS BLOB)) <> 18 OR instr(CAST(NEW.collection_id AS BLOB), x'00') > 0 OR NEW.collection_id GLOB '*[^0-9]*') THEN 1
	WHEN NEW.type = 'added_to_collection' THEN NEW.collection_item_id IS NULL OR NEW.collection_id IS NOT NULL
	WHEN NEW.type = 'collection_update' THEN NEW.collection_id IS NULL OR NEW.collection_item_id IS NOT NULL
	ELSE NEW.collection_item_id IS NOT NULL OR NEW.collection_id IS NOT NULL END
BEGIN
  SELECT RAISE(ABORT, 'notifications: collection keys past their stored bound');
END;
