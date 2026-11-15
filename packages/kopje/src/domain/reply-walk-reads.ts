import { ACCOUNTS_ID_INDEX, STATUSES_ID_INDEX } from "../db/indexes";
import type { Db } from "../db/sql";
import { iso } from "../platform/iso-time";
import { isoTimeSql } from "../platform/stored-bounds";
import { availableSql, DISTRIBUTABLE_SQL } from "./audience";

// The reads of the refresh of a remote status's replies (reply-walks.ts), apart from the walk so that the context
// read imports none of the walk's writers: Mastodon 4.7.5's FetchRepliesConcern
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
