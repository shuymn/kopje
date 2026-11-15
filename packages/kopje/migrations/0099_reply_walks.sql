-- Kopje Store schema 0099: walks of remote replies collections (src/domain/reply-walks.ts, the context's refresh).
-- Never edit after release (checksummed).
--
--   reply_walks           one row per root status: its walk's kind (0, a context refresh), the refresh's id (32
--                         lowercase hex characters, drawn when the row is made and kept while it is), queued_at (the
--                         latest start, the pacing record), due_at (when a round may claim it; NULL once finished),
--                         finished_at (NULL while it runs), token (the claim of the round holding it, a UUID), and its
--                         counters: next_seq (the next node's place), nodes (recorded, the root included), pages (the
--                         collection documents handed out) and result_count (the statuses it created). Times are ms
--                         within 0 to 2^53 - 1 on the Store's clock. No reference to statuses: a status's deletion
--                         writes no walk row; the claim re-checks the root.
--   reply_walks_refresh   the API's lookup by refresh id.
--   reply_walks_due       the claims' and the running count's seek by kind and due time.
--   reply_walks_finished  the prune's seek of finished walks.
--   reply_walk_nodes      the statuses a walk found, by URI (1 to 4096 bytes, no NUL): seq (its place), state (0
--                         pending, 1 done, 2 deferred on parent), stage (0 its status, 1 its replies collection, 2 a
--                         page of it, at fetch), valid (1 once linked to the root through valid nodes; only a valid
--                         node's collection is read) and attempts (hand-outs of its current document, at most 2).
--   reply_walk_nodes_pending, _parent   the hand-out's seek of the next pending node, and the deferred nodes waiting on
--                         a node.
--
-- Job state: neither table is dumped (src/platform/dump-catalog.ts), and the cutover writes neither. The bounds are the
-- writers' constants (src/domain/reply-walks.ts WALK_STATUSES, WALK_PAGES, NODE_ATTEMPTS); the CHECKs hold the
-- columns to their domains, a counter's well past its cap.
--
-- Cost: two new empty tables and five indexes; no row is read or written. A file that creates a table cannot declare
-- foreignKeys: 'unchanged' (test/migration-sql.ts), so its upgrade checks every reference of the Store. Measured on the
-- benchmark store of test/bench/migration-cost.ts in workerd's local Durable Object SQLite: see the CHANGELOG entry of
-- this file.

CREATE TABLE reply_walks (
  status_id TEXT NOT NULL PRIMARY KEY CHECK (typeof(status_id) = 'text' AND length(CAST(status_id AS BLOB)) = 18
    AND status_id NOT GLOB '*[^0-9]*'),
  kind INTEGER NOT NULL CHECK (typeof(kind) = 'integer' AND kind IN (0, 1)),
  refresh_id TEXT CHECK (refresh_id IS NULL OR (typeof(refresh_id) = 'text'
    AND length(CAST(refresh_id AS BLOB)) = 32 AND refresh_id NOT GLOB '*[^0-9a-f]*')),
  queued_at INTEGER NOT NULL CHECK (typeof(queued_at) = 'integer' AND queued_at BETWEEN 0 AND 9007199254740991),
  due_at INTEGER CHECK (due_at IS NULL OR (typeof(due_at) = 'integer' AND due_at BETWEEN 0 AND 9007199254740991)),
  finished_at INTEGER CHECK (finished_at IS NULL
    OR (typeof(finished_at) = 'integer' AND finished_at BETWEEN 0 AND 9007199254740991)),
  token TEXT CHECK (token IS NULL OR (typeof(token) = 'text' AND length(CAST(token AS BLOB)) = 36)),
  next_seq INTEGER NOT NULL DEFAULT 0 CHECK (typeof(next_seq) = 'integer' AND next_seq BETWEEN 0 AND 2147483647),
  nodes INTEGER NOT NULL DEFAULT 0 CHECK (typeof(nodes) = 'integer' AND nodes BETWEEN 0 AND 100000),
  pages INTEGER NOT NULL DEFAULT 0 CHECK (typeof(pages) = 'integer' AND pages BETWEEN 0 AND 100000),
  result_count INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(result_count) = 'integer' AND result_count BETWEEN 0 AND 100000),
  CHECK ((kind = 0) = (refresh_id IS NOT NULL)),
  CHECK ((due_at IS NULL) = (finished_at IS NOT NULL))
);
CREATE UNIQUE INDEX reply_walks_refresh ON reply_walks (refresh_id);
CREATE INDEX reply_walks_due ON reply_walks (kind, due_at);
CREATE INDEX reply_walks_finished ON reply_walks (finished_at);

CREATE TABLE reply_walk_nodes (
  status_id TEXT NOT NULL REFERENCES reply_walks (status_id) ON DELETE CASCADE,
  uri TEXT NOT NULL CHECK (typeof(uri) = 'text' AND length(CAST(uri AS BLOB)) BETWEEN 1 AND 4096
    AND instr(CAST(uri AS BLOB), x'00') = 0),
  seq INTEGER NOT NULL CHECK (typeof(seq) = 'integer' AND seq BETWEEN 0 AND 2147483647),
  state INTEGER NOT NULL DEFAULT 0 CHECK (typeof(state) = 'integer' AND state IN (0, 1, 2)),
  stage INTEGER NOT NULL DEFAULT 0 CHECK (typeof(stage) = 'integer' AND stage IN (0, 1, 2)),
  valid INTEGER NOT NULL DEFAULT 0 CHECK (typeof(valid) = 'integer' AND valid IN (0, 1)),
  parent TEXT CHECK (parent IS NULL OR (typeof(parent) = 'text' AND length(CAST(parent AS BLOB)) BETWEEN 1 AND 4096
    AND instr(CAST(parent AS BLOB), x'00') = 0)),
  fetch TEXT CHECK (fetch IS NULL OR (typeof(fetch) = 'text' AND length(CAST(fetch AS BLOB)) BETWEEN 1 AND 4096
    AND instr(CAST(fetch AS BLOB), x'00') = 0)),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (typeof(attempts) = 'integer' AND attempts BETWEEN 0 AND 2),
  CHECK ((state = 2) = (parent IS NOT NULL)),
  CHECK (state <> 2 OR (valid = 0 AND stage = 0)),
  CHECK (stage = 0 OR valid = 1),
  CHECK ((stage = 0) = (fetch IS NULL)),
  PRIMARY KEY (status_id, uri)
) WITHOUT ROWID;
CREATE INDEX reply_walk_nodes_pending ON reply_walk_nodes (status_id, state, seq);
CREATE INDEX reply_walk_nodes_parent ON reply_walk_nodes (status_id, parent);
