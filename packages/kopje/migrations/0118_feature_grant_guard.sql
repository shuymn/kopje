-- Kopje Store schema 0118: a local member's accepted row in a remote collection ends only with evidence (#1589's
-- D21 and D24, threat-model.md ID-9). Never edit after release (checksummed).
--
--   collection_items_grant_guard  BEFORE DELETE on collection_items: RAISE(ABORT, 'collection_items: a local
--                                 member's grant ends only with evidence') for an accepted row (state 1) whose member
--                                 is a local account and whose collection is a remote one (local 0) whose owner is
--                                 not being deleted (accounts.deleted_at NULL, set in the first transaction of the
--                                 owner's purge, src/domain/inbox.ts startActorDeletion).
--   collections_grant_guard       BEFORE DELETE on collections: RAISE(ABORT, 'collections: a local member's grant ends
--                                 only with evidence') for a remote collection holding such a row, unless its owner is
--                                 being deleted or the owner's Remove of it is deleting it (the kopje_state mark
--                                 'collection_removal' naming the collection's uri, src/domain/remote-featured-
--                                 collections.ts removeFeaturedCollection).
--
-- The evidence each delete may rest on is what the deletion events leave in the Store, read at the delete: the member's
-- revoke or block retires the row first (state 3), after which only the cleanup and the early eviction delete it; the
-- owner's Remove of the collection marks its delete, and the owner's deletion marks the owner from its first
-- transaction, whose batched purge deletes the collections' rows in later ones; an account's row deleted (the
-- member's, or the owner's at the purge's end) cascades, and a cascade's child trigger runs after its parent row is
-- gone, so it finds no member or no collection and passes, the parent's own guard having decided; the reset of an
-- import not yet published deletes its rows under the kopje_state mark 'import_reset_step' (src/platform/
-- store-admin.ts). Both marks are written and removed inside the transaction of the delete they admit, so no committed
-- state admits a later one. Any other delete of such a row, by any path an import, a cutover or a later release adds,
-- is refused.
--
-- No row is read or rewritten by the migration, and no table is recreated. Cost at a delete: each deleted row is read
-- once more (a table with a delete trigger has no one-pass delete); for collection_items, an accepted row's member
-- probed by primary key, then a local member's collection and its owner; for collections, a remote one's owner probed,
-- then its rows walked through collection_items_order (MAX_STORED_ITEMS) with a probe of each one's member, stopping at
-- the first accepted local member's; for a guarded row, one kopje_state probe for each mark. Each probe and the walk
-- name their index, and CROSS JOIN fixes the order, so statistics taken before the accounts grew do not turn a probe
-- into a range of local accounts (docs/engineering.md, "Queries").

CREATE TRIGGER collection_items_grant_guard BEFORE DELETE ON collection_items
WHEN OLD.state = 1
  AND EXISTS (SELECT 1 FROM accounts m INDEXED BY sqlite_autoindex_accounts_1
    CROSS JOIN collections c INDEXED BY sqlite_autoindex_collections_1
    CROSS JOIN accounts o INDEXED BY sqlite_autoindex_accounts_1
    WHERE m.id = OLD.account_id AND m.domain IS NULL AND c.id = OLD.collection_id AND c.local = 0
      AND o.id = c.account_id AND o.deleted_at IS NULL)
  AND NOT EXISTS (SELECT 1 FROM kopje_state WHERE name = 'import_reset_step')
BEGIN
  SELECT RAISE(ABORT, 'collection_items: a local member''s grant ends only with evidence');
END;

CREATE TRIGGER collections_grant_guard BEFORE DELETE ON collections
WHEN OLD.local = 0
  AND EXISTS (SELECT 1 FROM accounts o INDEXED BY sqlite_autoindex_accounts_1
    WHERE o.id = OLD.account_id AND o.deleted_at IS NULL)
  AND EXISTS (SELECT 1 FROM collection_items i INDEXED BY collection_items_order
    CROSS JOIN accounts m INDEXED BY sqlite_autoindex_accounts_1
    WHERE i.collection_id = OLD.id AND i.state = 1 AND m.id = i.account_id AND m.domain IS NULL)
  AND NOT EXISTS (SELECT 1 FROM kopje_state WHERE name = 'collection_removal' AND value = OLD.uri)
  AND NOT EXISTS (SELECT 1 FROM kopje_state WHERE name = 'import_reset_step')
BEGIN
  SELECT RAISE(ABORT, 'collections: a local member''s grant ends only with evidence');
END;
