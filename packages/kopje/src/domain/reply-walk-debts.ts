import { ACCOUNTS_ID_INDEX, LOCAL_ACCOUNTS_ID_INDEX, STATUSES_ID_INDEX } from "../db/indexes";
import type { Db } from "../db/sql";
import { isoTimeSql } from "../platform/stored-bounds";
import { DISTRIBUTABLE_SQL, removalBegunSql } from "./audience";

// The rows of a context walk's scans and debts (migration 0106_reply_walk_debts; reply-walks.ts runs them). Mastodon
// 4.7.5's FetchAllRepliesService adds a status's stored replies its collection does not list once the collection is
// read (fetch_all_replies_service.rb:33-49), all of them at every walk, within 1,000 statuses a walk. A Kopje walk
// holds WALK_STATUSES, so it examines a node's stored public replies REPLY_SCAN_ROWS at a time, in cyclic id order from
// where the node's last scan ended (its cursor, shared by every walk), and records what it has no room for as debts of
// its root, which the root's next walks take first, oldest first: a row debt for a reply a scan could not admit, a
// collection debt for a collection reading it cut, with the place to go on from. A status holds one debt a depth (the
// links from the owing root to it), so a status is named by at most WALK_STATUSES debts at any time.

// Rows of a node's stored public replies one scan examines at most.
export const REPLY_SCAN_ROWS = 200;

// reply_walk_debts.kind, and reply_walk_nodes.lane.
export const [ROW_DEBT, COLLECTION_DEBT] = [0, 1];
export const [ORDINARY, OWED, PATH] = [0, 1, 2];

// A debt's key: the owing walk's epoch (reply_walks.debt_walk), the owing node's seq, the row's place in the scan's
// window (0 for a collection debt).
export type DebtKey = { walk: number; seq: number; pos: number };
// Where a cut reading goes on: the page whose chain it was at (null: the collection's first chain), and the raw
// position in that chain of the first entry it did not take.
export type Place = { page: string | null; offset: number };
export type Debt = { statusId: string; kind: number; place: Place; depth: number; key: DebtKey };

// The epoch of a walk of `rootId` starting now: above every owed_walk the root's debts hold. One index entry.
export function debtEpoch(db: Db, rootId: string): number {
  const row = db.first<{ owed: number }>(
    `SELECT owed_walk AS owed FROM reply_walk_debts INDEXED BY reply_walk_debts_order WHERE root_id = ?
			ORDER BY owed_walk DESC LIMIT 1`,
    rootId,
  );
  return (row?.owed ?? 0) + 1;
}

// The root's first debt in key order after `after` (its first, with none). One index entry and its row.
export function nextDebt(db: Db, rootId: string, after: DebtKey | null): Debt | undefined {
  type Row = {
    status_id: string;
    kind: number;
    page: string | null;
    page_offset: number;
    depth: number;
    owed_walk: number;
    owed_seq: number;
    owed_pos: number;
  };
  const columns = "status_id, kind, page, page_offset, depth, owed_walk, owed_seq, owed_pos";
  const row =
    after === null
      ? db.first<Row>(
          `SELECT ${columns} FROM reply_walk_debts INDEXED BY reply_walk_debts_order WHERE root_id = ?1
					ORDER BY owed_walk, owed_seq, owed_pos LIMIT 1`,
          rootId,
        )
      : db.first<Row>(
          `SELECT ${columns} FROM reply_walk_debts INDEXED BY reply_walk_debts_order
					WHERE root_id = ?1 AND (owed_walk, owed_seq, owed_pos) > (?2, ?3, ?4)
					ORDER BY owed_walk, owed_seq, owed_pos LIMIT 1`,
          rootId,
          after.walk,
          after.seq,
          after.pos,
        );
  return row === undefined
    ? undefined
    : {
        statusId: row.status_id,
        kind: row.kind,
        place: { page: row.page, offset: row.page_offset },
        depth: row.depth,
        key: { walk: row.owed_walk, seq: row.owed_seq, pos: row.owed_pos },
      };
}

// Whether the removal of the status has begun (removalBegunSql: withdrawn, or its account's deletion started), or it is
// gone: no cursor or debt is written for it. Two key reads.
export function removalBegun(db: Db, statusId: string): boolean {
  return (
    db.first(
      `SELECT 1 AS x FROM statuses s INDEXED BY ${STATUSES_ID_INDEX}
				CROSS JOIN accounts a INDEXED BY ${ACCOUNTS_ID_INDEX} ON a.id = s.account_id
			WHERE s.id = ? AND NOT ${removalBegunSql("s", "a")}`,
      statusId,
    ) === undefined
  );
}

// Owes the status to the root at `depth` with `key`: a debt of another root at the same status and depth, which can
// no longer be its ancestor's, is replaced (reply_walk_debts_depth); then a row debt is inserted unless the root owes
// the status already, which keeps its key, and a collection debt is inserted, or, when the reading cut again resumed
// from it (its key at or before `resumed`, the last debt the walk considered, for a node it applied), re-keyed with its
// new place behind every earlier walk's; one owed again otherwise keeps its key and place (a reading from the start).
// At most one delete and one write.
export function owe(
  db: Db,
  rootId: string,
  statusId: string,
  kind: number,
  depth: number,
  key: DebtKey,
  place: Place,
  resumed: DebtKey | null = null,
): void {
  db.run("DELETE FROM reply_walk_debts WHERE status_id = ?1 AND depth = ?2 AND root_id <> ?3", statusId, depth, rootId);
  const insert = `INSERT INTO reply_walk_debts
			(root_id, status_id, kind, page, page_offset, owed_walk, owed_seq, owed_pos, depth)
			VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) ON CONFLICT (root_id, status_id)`;
  const params = [rootId, statusId, kind, place.page, place.offset, key.walk, key.seq, key.pos, depth];
  if (kind === ROW_DEBT || resumed === null) {
    db.run(`${insert} DO NOTHING`, ...params);
    return;
  }
  db.run(
    `${insert} DO UPDATE SET page = excluded.page, page_offset = excluded.page_offset, owed_walk = excluded.owed_walk,
				owed_seq = excluded.owed_seq, owed_pos = 0, depth = excluded.depth
			WHERE (reply_walk_debts.owed_walk, reply_walk_debts.owed_seq, reply_walk_debts.owed_pos) <= (?10, ?11, ?12)`,
    ...params,
    resumed.walk,
    resumed.seq,
    resumed.pos,
  );
}

// Deletes the root's debt of the status if it is of one of `kinds` (a payment, or a drop). One key.
export function settle(db: Db, rootId: string, statusId: string, kinds: readonly number[]): void {
  db.run(
    `DELETE FROM reply_walk_debts WHERE root_id = ?1 AND status_id = ?2 AND kind IN (${kinds.map(() => "?").join(", ")})`,
    rootId,
    statusId,
    ...kinds,
  );
}

// A scan's window of the stored public replies of the status: at most REPLY_SCAN_ROWS rows of
// statuses_public_replies, those after its cursor, then, while the allowance lasts, those from its first up to the
// cursor, each with whether it was published at `waited` or before (a time that is not a stored one: not). Every
// eligibility test is the caller's, on the rows read.
type ScanRow = { id: string; uri: string; waited: number };
export function scanWindow(db: Db, statusId: string, waited: string): ScanRow[] {
  const cursor =
    db.first<{ after_id: string }>("SELECT after_id FROM reply_walk_cursors WHERE status_id = ?", statusId)?.after_id ??
    null;
  const range = (op: ">" | "<=", from: string, limit: number) =>
    db.all<ScanRow>(
      `SELECT id, uri, COALESCE(${isoTimeSql("published_at")} <= ?4, 0) AS waited
				FROM statuses INDEXED BY statuses_public_replies
				WHERE in_reply_to_id = ?1 AND in_reply_to_id IS NOT NULL AND visibility IN ${DISTRIBUTABLE_SQL}
					AND withdrawn = 0 AND id ${op} ?2
				ORDER BY id LIMIT ?3`,
      statusId,
      from,
      limit,
      waited,
    );
  const rows = range(">", cursor ?? "", REPLY_SCAN_ROWS);
  return cursor === null || rows.length >= REPLY_SCAN_ROWS
    ? rows
    : [...rows, ...range("<=", cursor, REPLY_SCAN_ROWS - rows.length)];
}

// The status's cursor after a scan examined `rows`: the last of them, or none once the scan examined every row the
// status has (fewer than REPLY_SCAN_ROWS). One write.
export function moveCursor(db: Db, statusId: string, rows: readonly ScanRow[]): void {
  const last = rows.at(-1);
  if (rows.length < REPLY_SCAN_ROWS || last === undefined) {
    db.run("DELETE FROM reply_walk_cursors WHERE status_id = ?", statusId);
    return;
  }
  db.run(
    `INSERT INTO reply_walk_cursors (status_id, after_id) VALUES (?1, ?2)
			ON CONFLICT (status_id) DO UPDATE SET after_id = excluded.after_id`,
    statusId,
    last.id,
  );
}

// One step of a debt's path, or a scanned row: a stored status's URI, the status its in_reply_to_id links, and whether
// a walk may record or owe it (a remote original, public or unlisted, whose removal has not begun). Three key reads.
type PathStep = { uri: string; parent: string | null; recordable: boolean };
export function pathStep(db: Db, statusId: string): PathStep | undefined {
  const row = db.first<{ uri: string; parent: string | null; recordable: number }>(
    `SELECT s.uri, s.in_reply_to_id AS parent,
				(s.reblog_of_id IS NULL AND s.visibility IN ${DISTRIBUTABLE_SQL} AND l.account_id IS NULL
					AND NOT ${removalBegunSql("s", "a")}) AS recordable
			FROM statuses s INDEXED BY ${STATUSES_ID_INDEX}
				CROSS JOIN accounts a INDEXED BY ${ACCOUNTS_ID_INDEX} ON a.id = s.account_id
				LEFT JOIN local_accounts l INDEXED BY ${LOCAL_ACCOUNTS_ID_INDEX} ON l.account_id = s.account_id
			WHERE s.id = ?`,
    statusId,
  );
  return row === undefined ? undefined : { uri: row.uri, parent: row.parent, recordable: row.recordable === 1 };
}
