-- Kopje Store schema 0124: the instance domain blocks with reject_media, as one partial index (#1560). Never edit after
-- release (checksummed).
--
--   instance_domain_blocks_reject_media   instance_domain_blocks by id, only the blocks with reject_media = 1: whether
--                                         the instance has such a block at all is one seek of it
--                                         (src/domain/audience.ts REJECT_MEDIA_BLOCKS_SQL), so the presenters and the
--                                         remote media cache walk no domain's suffixes on an instance without one.
--
-- No row is rewritten and no trigger changes. Cost: one pass over instance_domain_blocks, an operator-sized table, to
-- build the index, which holds an entry only for a block with reject_media.

-- REJECT_MEDIA_BLOCKS_SQL names this index (INDEXED BY): renaming or dropping it breaks it.
CREATE INDEX instance_domain_blocks_reject_media ON instance_domain_blocks (id) WHERE reject_media = 1;
