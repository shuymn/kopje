-- Kopje Store schema 0117: each actor's live retractions as one range (#1787). Never edit after release
-- (checksummed).
--
--   inbound_retractions_actor_expires   inbound_retractions by (actor_uri, expires_at): the per-actor cap's count
--                                       (src/domain/retractions.ts canRetract) reads the actor's own live entries
--                                       as one range of it, whatever the Store's statistics (RES-7). The primary key
--                                       and inbound_retractions_expires each serve only one of the count's terms,
--                                       and statistics taken while the table held few actors made the expiry walk,
--                                       over every actor's live retractions, look the cheaper. SQLite costs an
--                                       index that serves a proper superset of another's terms below it (where.c,
--                                       whereLoopAdjustCost), so this one is chosen over both without a pin. Not
--                                       UNIQUE: an actor's retractions may share an expiry.
--
-- inbound_retractions_expires stays: the sweep (src/domain/inbox.ts sweep) walks it in expiry order across actors.
--
-- No row is rewritten and no trigger changes. Cost: one pass over inbound_retractions to build the index, whose entries
-- hold the same three columns as inbound_retractions_expires's; the CHANGELOG entry gives its measured time.

CREATE INDEX inbound_retractions_actor_expires ON inbound_retractions (actor_uri, expires_at);
