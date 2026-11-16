import { ACCOUNTS_ID_INDEX, STATUSES_ID_INDEX } from "../db/indexes";
import type { Db } from "../db/sql";
import { iso } from "../platform/iso-time";
import { isoTimeSql } from "../platform/stored-bounds";
import { availableSql, DISTRIBUTABLE_SQL } from "./audience";

// The reads of the context's refresh of a remote status's replies (reply-walks.ts), apart from the walk so that the
// context read (statuses.ts statusContext) imports none of the walk's writers: Mastodon 4.7.5's FetchRepliesConcern
// (app/models/concerns/status/fetch_replies_concern.rb) and AsyncRefresh (app/models/async_refresh.rb). Times are the
// Store's (ms); a walk's queued_at, set at each start, is the pacing record (Mastodon's fetched_replies_at of the
// root).

// A refresh starts only for a status published at least this long ago (FETCH_REPLIES_INITIAL_WAIT_MINUTES), and at most
// once in this long (FETCH_REPLIES_COOLDOWN_MINUTES).
export const REPLIES_INITIAL_WAIT_MS = 5 * 60 * 1000;
export const REPLIES_COOLDOWN_MS = 15 * 60 * 1000;
// A refresh counts as running for at most this long after its latest start (AsyncRefresh::NEW_REFRESH_EXPIRATION), and
// a finished one is kept this long (FINISHED_REFRESH_EXPIRATION); then its row goes (reply-walks.ts claimReplyWalk).
export const REFRESH_RUNNING_MS = 24 * 60 * 60 * 1000;
export const REFRESH_FINISHED_MS = 60 * 60 * 1000;
// Context walks running at once at most (docs/mastodon-deviations.md, "Replies collections"): a due read past it starts
// none, as one not due. Mastodon has no such cap.
export const MAX_RUNNING_REFRESHES = 16;

// A refresh as the API and the header show it (Mastodon's AsyncRefresh#to_json): its id, running or finished, and the
// statuses its latest start created.
export type Refresh = { id: string; status: "running" | "finished"; resultCount: number };

type RefreshRow = { refresh_id: string; queued_at: number; finished_at: number | null; result_count: number };

const REFRESH_COLUMNS = "refresh_id, queued_at, finished_at, result_count";

// Running: not finished, and started less than REFRESH_RUNNING_MS ago (a walk past it is deleted at its claim).
function running(row: RefreshRow, now: number): boolean {
  return row.finished_at === null && row.queued_at > now - REFRESH_RUNNING_MS;
}

function refreshRow(db: Db, statusId: string): RefreshRow | undefined {
  return db.first<RefreshRow>(
    `SELECT ${REFRESH_COLUMNS} FROM reply_walks WHERE status_id = ? AND kind = 0 AND refresh_id IS NOT NULL`,
    statusId,
  );
}

function shown(row: RefreshRow, now: number): Refresh {
  return { id: row.refresh_id, status: running(row, now) ? "running" : "finished", resultCount: row.result_count };
}

// The status's refresh while it runs, which every context answer of it names (Mastodon's add_async_refresh_header
// while running?), or null.
export function runningRefresh(db: Db, statusId: string, now: number): Refresh | null {
  const row = refreshRow(db, statusId);
  return row !== undefined && running(row, now) ? shown(row, now) : null;
}

// GET /api/v1_alpha/async_refreshes/:id (AsyncRefresh.find): a refresh running, or finished less than
// REFRESH_FINISHED_MS ago, by its id (one key of reply_walks_refresh); null for any other id.
export function refreshById(db: Db, id: string, now: number): Refresh | null {
  const row = db.first<RefreshRow>(
    `SELECT ${REFRESH_COLUMNS} FROM reply_walks INDEXED BY reply_walks_refresh WHERE refresh_id = ? AND kind = 0`,
    id,
  );
  if (row === undefined) {
    return null;
  }
  const kept = running(row, now) || (row.finished_at !== null && row.finished_at > now - REFRESH_FINISHED_MS);
  return kept ? shown(row, now) : null;
}

// A walk's root (FetchRepliesConcern#should_fetch_replies?, less its times): the remote, public or unlisted original
// of an available author, not being withdrawn, with whether it was published at least REPLIES_INITIAL_WAIT_MS ago (a
// stored published_at is never in the future; one that is not a stored time reads as not). Two key reads.
export function walkRoot(db: Db, statusId: string, now: number): { uri: string; waited: boolean } | undefined {
  const row = db.first<{ uri: string; waited: number }>(
    `SELECT s.uri, COALESCE(${isoTimeSql("s.published_at")} <= ?2, 0) AS waited
		FROM statuses s INDEXED BY ${STATUSES_ID_INDEX} CROSS JOIN accounts a INDEXED BY ${ACCOUNTS_ID_INDEX} ON a.id = s.account_id
		WHERE s.id = ?1 AND s.reblog_of_id IS NULL AND s.withdrawn = 0 AND s.visibility IN ${DISTRIBUTABLE_SQL}
			AND a.domain IS NOT NULL AND ${availableSql("a.id")}`,
    statusId,
    iso(now - REPLIES_INITIAL_WAIT_MS),
  );
  return row === undefined ? undefined : { uri: row.uri, waited: row.waited === 1 };
}

// Whether the status's refresh runs or started within REPLIES_COOLDOWN_MS (FetchRepliesConcern's cooldown on
// fetched_replies_at), so that none starts again yet.
export function recentlyRefreshed(db: Db, statusId: string, now: number): boolean {
  const row = refreshRow(db, statusId);
  return row !== undefined && (running(row, now) || row.queued_at > now - REPLIES_COOLDOWN_MS);
}

// Whether MAX_RUNNING_REFRESHES context walks run: the walks not finished, read by reply_walks_due at most that many. A
// walk running past REFRESH_RUNNING_MS still counts until its claim deletes it (the cron's rounds claim every run).
export function refreshesFull(db: Db): boolean {
  const row = db.first<{ n: number }>(
    `SELECT count(*) AS n FROM (SELECT 1 FROM reply_walks INDEXED BY reply_walks_due
			WHERE kind = 0 AND due_at IS NOT NULL LIMIT ?)`,
    MAX_RUNNING_REFRESHES,
  );
  return (row?.n ?? 0) >= MAX_RUNNING_REFRESHES;
}

// Whether a signed-in viewer's context read of the status starts a refresh (advisory: the start decides again in its
// own transaction): a walk root published at least REPLIES_INITIAL_WAIT_MS ago, with no refresh running or started
// within REPLIES_COOLDOWN_MS, while fewer than MAX_RUNNING_REFRESHES run.
export function refreshDue(db: Db, statusId: string, now: number): boolean {
  return walkRoot(db, statusId, now)?.waited === true && !recentlyRefreshed(db, statusId, now) && !refreshesFull(db);
}
