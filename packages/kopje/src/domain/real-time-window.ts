import { STATUSES_ID_INDEX } from "../db/indexes";
import type { Db } from "../db/sql";

// Mastodon's real-time window (Status::REAL_TIME_WINDOW and Status#within_realtime_window?, app/models/status.rb:188,
// :218-220 in v4.7.5): a status published at most six hours before it arrived is live. A delivered Create always fans
// out (ActivityPub::ProcessingWorker sets override_timestamps, processing_worker.rb:16); a fetched one only within the
// window (Create#distribute, create.rb:92). The streaming `update` event (streaming.ts) judges it here.
//
// It compares the stored published_at with created_at, both the Store's: published_at is the parsed `published`, or
// the arrival when it is missing, unreadable or in the future (remote-statuses.ts remoteTime), as StatusParser takes
// the time of storing (status_parser.rb:80-85); created_at is the arrival.
const REAL_TIME_WINDOW = "-6 hours";

// Whether the stored status `statusId` was published within the window before it arrived (one key read; false for a
// status that is not stored).
export function withinRealTimeWindow(db: Db, statusId: string): boolean {
  return (
    db.first(
      `SELECT 1 AS x FROM statuses INDEXED BY ${STATUSES_ID_INDEX}
			WHERE id = ? AND published_at >= strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '${REAL_TIME_WINDOW}')`,
      statusId,
    ) !== undefined
  );
}
