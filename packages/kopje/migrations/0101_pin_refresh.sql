-- Kopje Store schema 0101: pin syncs fetch every listed status again. Never edit after release (checksummed).
--
--   collection_pins_pending.refresh   whether the row is a refresh row. A sync's read leaves one row for each of the
--                                     first MAX_REMOTE_PINS distinct URIs the account's featured collection lists on
--                                     its origin (src/domain/remote-collections.ts replacePins): a pending row (0) for
--                                     a status Kopje does not store, which holds a pin slot until its fetch pins it or
--                                     drops it, and a refresh row (1) for one it stores, which holds none and is
--                                     fetched only to apply the account's edits or a 404 at its URI (Mastodon's
--                                     FetchFeaturedCollectionService fetches every listed status at every sync).
--
-- No backfill: every existing row is a pending row, which it is, and takes the constant default. A dump restores only
-- into a Store of the same migrations: one taken before this file is restored into a Store before it, whose upgrade
-- then makes its rows pending rows, and one taken after it carries refresh as written, held to the CHECK on import.
--
-- Cost: SQLite tests the new CHECK on every stored row (at most MAX_REMOTE_PINS per remote account a sync is fetching
-- for), and the constant default writes none; no index is made and no reference is added. Measured on the benchmark
-- store of test/bench/migration-cost.ts in workerd's local Durable Object SQLite, the Store's reference check skipped
-- as declared: see the CHANGELOG entry of this file.

ALTER TABLE collection_pins_pending ADD COLUMN refresh INTEGER NOT NULL DEFAULT 0 CHECK (refresh IN (0, 1));
