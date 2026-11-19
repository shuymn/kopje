-- Kopje Store schema 0120: the collections a status tags (Mastodon 4.7.5's tagged_collections, #1589's D26;
-- src/domain/collections.ts). Never edit after release (checksummed).
--
--   status_collections                     one row per status and collection it tags: the status (its delete cascades;
--                                          a removal deletes its rows first, src/domain/inbox.ts STATUS_CHILDREN) and
--                                          the collection (its delete cascades; the purge deletes its rows first,
--                                          purgeCollectionRows). No reference names a missing row of either.
--   status_collections_collection          a collection's references, for the per-collection count and the purge.
--   status_collections_per_status          BEFORE INSERT and BEFORE UPDATE OF status_id: RAISE(ABORT,
--   status_collections_per_status_move     'status_collections: past the per-status bound') past MAX_TAGGED_COLLECTIONS
--                                          (4) references of one status.
--   status_collections_per_collection      BEFORE INSERT and BEFORE UPDATE OF collection_id: RAISE(ABORT,
--   status_collections_per_collection_move 'status_collections: past the per-collection bound') past
--                                          MAX_TAGGING_STATUSES (100) references of one collection.
--   collections_url                        the remote collections by their stored url, then uri: a local post's link to
--                                          a remote collection's web page (collections.ts, the url lookup).
--
-- The triggers are src/domain/stored-triggers.ts emitTriggers' text (test/migrations.test.ts compares them); their
-- moves count no moved row out, as the table has no id column and the guard fires only for a changed key. Stored form:
-- docs/dump-format.md.
--
-- No row is written: existing statuses tag nothing. Cost: building collections_url scans every collections row and
-- sorts the remote rows' (url, uri) keys, each part within 2,048 bytes (COLLECTION_URL_BYTES, COLLECTION_URI_BYTES);
-- the new table and its index are empty. A file that creates a table cannot declare foreignKeys: 'unchanged'
-- (test/migration-sql.ts), so its upgrade checks every reference of the Store. Measured on the benchmark store of
-- test/bench/migration-cost.ts in workerd's local Durable Object SQLite: see the CHANGELOG entry of this file.

CREATE TABLE status_collections (
  status_id TEXT NOT NULL REFERENCES statuses (id) ON DELETE CASCADE,
  collection_id TEXT NOT NULL REFERENCES collections (id) ON DELETE CASCADE,
  PRIMARY KEY (status_id, collection_id)
) WITHOUT ROWID;

CREATE INDEX status_collections_collection ON status_collections (collection_id, status_id);

CREATE INDEX collections_url ON collections (url, uri) WHERE local = 0 AND url IS NOT NULL;

CREATE TRIGGER status_collections_per_status BEFORE INSERT ON status_collections
WHEN (SELECT count(*) FROM (SELECT 1 FROM status_collections WHERE status_id = NEW.status_id
    LIMIT 4)) >= 4
BEGIN
  SELECT RAISE(ABORT, 'status_collections: past the per-status bound');
END;

CREATE TRIGGER status_collections_per_status_move BEFORE UPDATE OF status_id ON status_collections
WHEN NEW.status_id IS NOT OLD.status_id
  AND (SELECT count(*) FROM (SELECT 1 FROM status_collections WHERE status_id = NEW.status_id
    LIMIT 4)) >= 4
BEGIN
  SELECT RAISE(ABORT, 'status_collections: past the per-status bound');
END;

CREATE TRIGGER status_collections_per_collection BEFORE INSERT ON status_collections
WHEN (SELECT count(*) FROM (SELECT 1 FROM status_collections WHERE collection_id = NEW.collection_id
    LIMIT 100)) >= 100
BEGIN
  SELECT RAISE(ABORT, 'status_collections: past the per-collection bound');
END;

CREATE TRIGGER status_collections_per_collection_move BEFORE UPDATE OF collection_id ON status_collections
WHEN NEW.collection_id IS NOT OLD.collection_id
  AND (SELECT count(*) FROM (SELECT 1 FROM status_collections WHERE collection_id = NEW.collection_id
    LIMIT 100)) >= 100
BEGIN
  SELECT RAISE(ABORT, 'status_collections: past the per-collection bound');
END;
