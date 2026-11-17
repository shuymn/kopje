-- Kopje Store schema 0113: remote accounts' collections are read by the collection sync, and their members' feature
-- authorizations checked within a daily quota per owner (src/domain/remote-collections.ts,
-- src/domain/remote-featured-collections.ts, src/domain/collection-checks.ts). Never edit after release (checksummed).
--
--   collection_syncs.collections_read  1 once the round's request has read the account's featuredCollections (the
--                                      fourth part of a read, PART_COLLECTIONS): parts_read's CHECK holds the first
--                                      three parts only (0025_remote_collections), so this part's bit is a column of
--                                      its own, read with them as parts_read | (collections_read << 3).
--   collection_syncs.collections_changed
--                                      1 once an inbound change of the account's collections (an Add, a Remove or an
--                                      Update from the owner, a search storing one) committed after the claim of the
--                                      round that holds the sync: that round's read is older than the stored
--                                      collections and is not applied, and a later round reads them again. Each claim
--                                      sets it to 0.
--   collection_check_quotas            one row per account whose collections' items were claimed for a check: the UTC
--                                      day of its claims (a day number of the Store's clock, ms / 86,400,000) and how
--                                      many it made that day, 0 to OWNER_CHECKS_PER_DAY (250); a row of an earlier day
--                                      counts from 0 again. The day is at most 104,249,990, the last whose next day
--                                      starts within 2^53 - 1 ms: a claim defers a spent owner's items to that start,
--                                      which collection_items.check_due_at holds (0103_collections). The account's
--                                      delete cascades, and its purge deletes it (src/domain/inbox.ts
--                                      PURGED_ACCOUNT_CHILDREN).
--
-- No backfill: every pending sync has not read the new part, which it is due to read, its next claim starts with no
-- change seen, and no claim is counted before the upgrade.
--
-- Cost: SQLite tests the new CHECKs on every pending sync (at most one per remote account), and the constant defaults
-- write none; the new table is empty. A file that creates a table cannot declare foreignKeys: 'unchanged'
-- (test/migration-sql.ts), so its upgrade checks every reference of the Store. Measured on the benchmark store of
-- test/bench/migration-cost.ts in workerd's local Durable Object SQLite: see the CHANGELOG entry of this file.

ALTER TABLE collection_syncs ADD COLUMN collections_read INTEGER NOT NULL DEFAULT 0 CHECK (collections_read IN (0, 1));

ALTER TABLE collection_syncs ADD COLUMN collections_changed INTEGER NOT NULL DEFAULT 0
  CHECK (collections_changed IN (0, 1));

CREATE TABLE collection_check_quotas (
  account_id TEXT NOT NULL PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  day INTEGER NOT NULL CONSTRAINT collection_check_quotas_day
    CHECK (typeof(day) = 'integer' AND day BETWEEN 0 AND 104249990),
  used INTEGER NOT NULL CONSTRAINT collection_check_quotas_used
    CHECK (typeof(used) = 'integer' AND used BETWEEN 0 AND 250)
) WITHOUT ROWID;
