-- Kopje Store schema 0106: a context walk's scans of stored replies and the work it owes its root's next walks
-- (src/domain/reply-walk-debts.ts). Never edit after release (checksummed).
--
--   reply_walk_cursors        one row per stored status a scan examined: after_id, the last of its public replies the
--                             last scan examined (a scan reads at most REPLY_SCAN_ROWS of statuses_public_replies in
--                             cyclic id order after it); none once a scan examined them all.
--   reply_walk_debts          the work a context walk had no room for, owed to its root (root_id): a row debt (kind 0)
--                             names a stored reply a scan examined and could not admit, a collection debt (kind 1) a
--                             node whose collection reading the walk cut, with its place (page: the page whose chain
--                             it was reading or was to read next, NULL for the collection's first chain; page_offset:
--                             the raw position in that chain of the first entry not taken). depth: the links from the
--                             root to the status in the walk that owed it (at most WALK_STATUSES - 1 for a row,
--                             WALK_STATUSES - 2 for a collection). The key (owed_walk, the walk's debt epoch;
--                             owed_seq, the owing node's place in it; owed_pos, the row's place in the scan's window, 0
--                             for a collection) orders a root's debts, which its next walks take first, oldest first.
--   reply_walk_debts_order    a root's debts in key order, and its newest epoch.
--   reply_walk_debts_depth    one debt a status and depth: a walk owing a status at a depth another root's debt holds
--                             replaces it, so a status is named by at most WALK_STATUSES debts.
--   reply_walk_nodes.lane     0 ordinary, 1 owed (a debt's status, and what owed work admits), 2 path (a stored status
--                             recorded only to link an owed one to the walk; its collection is not read). Its CHECK is
--                             a range: a constant list of three makes SQLite read an ephemeral table at every write of
--                             a node.
--   reply_walk_nodes.scan_due 1 once the node's collection reading ended or was cut after it read a chain, until its
--                             scan.
--   reply_walk_nodes.depth    links from the root, set when the node becomes valid (the root 0).
--   reply_walk_nodes.resume_page   the page whose chain the node's reading is at, NULL for the collection's first
--                             chain: at the status stage, an applied collection debt's page (its offset in skip).
--   reply_walk_nodes_owed, _scan   the hand-out's seeks of the owed and path nodes pending, and of the scan-due nodes.
--   reply_walks.debt_walk     the walk's debt epoch, above every owed_walk its root's debts held at its start; NULL for
--                             a create walk and for a walk started before this file, which owe and consider nothing.
--   reply_walks.debt_after_walk, _seq, _pos   the key of the last debt the walk considered (NULL before its first),
--                             written together; debts_seen, the debts it considered.
--
-- Both tables are deleted with their statuses in batches before the status (src/domain/inbox.ts STATUS_CHILDREN), the
-- cascades only a backstop, and neither is written for a status or root whose removal has begun. Job state: neither is
-- dumped (src/platform/dump-catalog.ts leaves out the reply_walk prefix); an import leaves both empty, which only
-- starts each node's next scan from its first reply and leaves the cut work to the next walk that cuts it.
--
-- Cost: two new empty tables and four indexes on them; columns of reply_walk_nodes and reply_walks, each nullable or
-- with a constant default its CHECK admits (SQLite tests the CHECKs on the rows of running walks, at most a few
-- thousand, and rewrites none); two partial indexes of reply_walk_nodes. A file that creates a table cannot declare
-- foreignKeys: 'unchanged' (test/migration-sql.ts), so its upgrade checks every reference of the Store. Measured on the
-- benchmark store of test/bench/migration-cost.ts in workerd's local Durable Object SQLite: see the CHANGELOG entry of
-- this file.

CREATE TABLE reply_walk_cursors (
  status_id TEXT NOT NULL PRIMARY KEY REFERENCES statuses (id) ON DELETE CASCADE
    CHECK (typeof(status_id) = 'text' AND length(CAST(status_id AS BLOB)) = 18 AND status_id NOT GLOB '*[^0-9]*'),
  after_id TEXT NOT NULL
    CHECK (typeof(after_id) = 'text' AND length(CAST(after_id AS BLOB)) = 18 AND after_id NOT GLOB '*[^0-9]*')
) WITHOUT ROWID;
CREATE TABLE reply_walk_debts (
  root_id TEXT NOT NULL REFERENCES statuses (id) ON DELETE CASCADE
    CHECK (typeof(root_id) = 'text' AND length(CAST(root_id AS BLOB)) = 18 AND root_id NOT GLOB '*[^0-9]*'),
  status_id TEXT NOT NULL REFERENCES statuses (id) ON DELETE CASCADE
    CHECK (typeof(status_id) = 'text' AND length(CAST(status_id AS BLOB)) = 18 AND status_id NOT GLOB '*[^0-9]*'),
  kind INTEGER NOT NULL CHECK (typeof(kind) = 'integer' AND kind IN (0, 1)),
  page TEXT CHECK (page IS NULL OR (typeof(page) = 'text' AND length(CAST(page AS BLOB)) BETWEEN 1 AND 4096
    AND instr(CAST(page AS BLOB), x'00') = 0)),
  page_offset INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(page_offset) = 'integer' AND page_offset BETWEEN 0 AND 100000),
  owed_walk INTEGER NOT NULL CHECK (typeof(owed_walk) = 'integer' AND owed_walk BETWEEN 1 AND 9007199254740991),
  owed_seq INTEGER NOT NULL CHECK (typeof(owed_seq) = 'integer' AND owed_seq BETWEEN 0 AND 2147483647),
  owed_pos INTEGER NOT NULL CHECK (typeof(owed_pos) = 'integer' AND owed_pos BETWEEN 0 AND 200),
  depth INTEGER NOT NULL CHECK (typeof(depth) = 'integer' AND depth BETWEEN 0 AND 199),
  CHECK (kind = 1 OR (page IS NULL AND page_offset = 0 AND owed_pos > 0 AND depth > 0)),
  CHECK (kind = 0 OR (owed_pos = 0 AND depth <= 198)),
  PRIMARY KEY (root_id, status_id)
) WITHOUT ROWID;
CREATE UNIQUE INDEX reply_walk_debts_order ON reply_walk_debts (root_id, owed_walk, owed_seq, owed_pos);
CREATE UNIQUE INDEX reply_walk_debts_depth ON reply_walk_debts (status_id, depth);
ALTER TABLE reply_walk_nodes ADD COLUMN lane INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(lane) = 'integer' AND lane BETWEEN 0 AND 2);
ALTER TABLE reply_walk_nodes ADD COLUMN scan_due INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(scan_due) = 'integer' AND scan_due IN (0, 1));
ALTER TABLE reply_walk_nodes ADD COLUMN depth INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(depth) = 'integer' AND depth BETWEEN 0 AND 199);
ALTER TABLE reply_walk_nodes ADD COLUMN resume_page TEXT CHECK (resume_page IS NULL OR (typeof(resume_page) = 'text'
  AND length(CAST(resume_page AS BLOB)) BETWEEN 1 AND 4096 AND instr(CAST(resume_page AS BLOB), x'00') = 0));
CREATE INDEX reply_walk_nodes_owed ON reply_walk_nodes (status_id, state, seq) WHERE lane <> 0;
CREATE INDEX reply_walk_nodes_scan ON reply_walk_nodes (status_id, lane, seq) WHERE scan_due = 1;
ALTER TABLE reply_walks ADD COLUMN debt_walk INTEGER
  CHECK (debt_walk IS NULL OR (typeof(debt_walk) = 'integer' AND debt_walk BETWEEN 1 AND 9007199254740991));
ALTER TABLE reply_walks ADD COLUMN debt_after_walk INTEGER CHECK (debt_after_walk IS NULL
  OR (typeof(debt_after_walk) = 'integer' AND debt_after_walk BETWEEN 1 AND 9007199254740991));
ALTER TABLE reply_walks ADD COLUMN debt_after_seq INTEGER CHECK (debt_after_seq IS NULL
  OR (typeof(debt_after_seq) = 'integer' AND debt_after_seq BETWEEN 0 AND 2147483647));
ALTER TABLE reply_walks ADD COLUMN debt_after_pos INTEGER CHECK (debt_after_pos IS NULL
  OR (typeof(debt_after_pos) = 'integer' AND debt_after_pos BETWEEN 0 AND 200));
ALTER TABLE reply_walks ADD COLUMN debts_seen INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(debts_seen) = 'integer' AND debts_seen BETWEEN 0 AND 100000);
