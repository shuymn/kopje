-- Kopje Store schema 0094: the notification policy's bot condition. Never edit after release (checksummed).
--
--   notification_policies.for_bots    the recipient's choice for a filterable notification from a sender whose
--                                     actor type is Application or Service that the recipient does not follow
--                                     (NotificationPolicy#for_bots of Mastodon 4.6, app/models/notification_policy.rb;
--                                     src/domain/audience.ts botSql): accept, filter or drop, the other columns'
--                                     CHECK. Its default is accept, Mastodon's schema default, which matches nothing,
--                                     so every stored policy and every account without a row decides as before.
--
-- No backfill: every existing row takes the constant default. A dump restores only into a Store of the same
-- migrations, so one taken before this file is refused and one taken after it carries for_bots as written, held to the
-- CHECK on import.
--
-- Cost: SQLite tests the new CHECK on every stored row (at most one per local account), and the constant default
-- writes none; no index is made and no reference is added. Measured on the benchmark store of
-- test/bench/migration-cost.ts (one policy of each of its local accounts) in workerd's local Durable Object SQLite, the
-- Store's reference check skipped as declared: see the CHANGELOG entry of this file.

ALTER TABLE notification_policies ADD COLUMN for_bots TEXT NOT NULL DEFAULT 'accept'
  CHECK (for_bots IN ('accept', 'filter', 'drop'));
