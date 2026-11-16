import type { Db } from "../db/sql";
import { iso } from "../platform/iso-time";

// The streaming journal's bound and the events that need no presenter at capture, for streaming.ts and the modules
// streaming.ts presents (announcements.ts, statuses.ts), so neither imports the other.

// The journal stops recording once it spans this many ids: the fan-out stalled, and REST is authoritative.
export const JOURNAL_SPAN = 4096;

// Whether some listener could be sent an `edit` event (`status.update`) of the status `s`: an account on `user` or
// `user:notification`, on a list, or, for a public status that is not a boost, on a `public*` or `hashtag*` stream.
// Who is sent it is judged when it is sent (R33). The listener condition of stream_status_edited (migration
// 0056_announcements), checked equal to it by test/streaming/status-update-journal.test.ts, and the text of
// stream_quote_state's (migration 0102_quote_state_stream; test/migrations.test.ts).
export const EDIT_LISTENED_SQL = `(
    EXISTS (SELECT 1 FROM stream_subscriptions WHERE stream_key IN ('user', 'user:notification'))
    OR EXISTS (SELECT 1 FROM stream_subscriptions WHERE stream_key > 'list:' AND stream_key < 'list;')
    OR (s.visibility = 'public' AND s.reblog_of_id IS NULL
      AND (EXISTS (SELECT 1 FROM stream_subscriptions WHERE stream_key >= 'public' AND stream_key < 'public;')
        OR EXISTS (SELECT 1 FROM stream_subscriptions WHERE stream_key > 'hashtag:' AND stream_key < 'hashtag;'))))`;

// The subject of an `edit` row that is sent without its mention reference: this prefix, then the status id (a status
// id is 18 digits, the statuses CHECK, so no other row's subject starts with it). streaming.ts reads such a row as the
// event `quiet_edit`: `status.update` to home, the lists and the feeds, not to an account only a held mention shows the
// status to, as Mastodon's `skip_notifications` skips the mentioned accounts (fan_out_on_write_service.rb:31-35, :76-83
// in v4.7.5).
export const QUIET_EDIT_SUBJECT = "quiet:";

// One `edit` event (`status.update`) of the status `statusId`, for a write that changes what its listeners are shown
// but no column a trigger watches (`statuses.edited_at`, `quotes.state`): a local status's quote policy (statuses.ts,
// VIS-26). Without `mentions`, the row is a quiet edit (QUIET_EDIT_SUBJECT). Under EDIT_LISTENED_SQL and JOURNAL_SPAN,
// as the triggers: at most one row a call.
export function journalStatusUpdate(db: Db, statusId: string, now: number, { mentions }: { mentions: boolean }): void {
  if (journalFull(db, "edit")) {
    return;
  }
  db.run(
    `INSERT INTO stream_events (kind, subject, created_at)
		SELECT 'edit', ?3 || s.id, ?2 FROM statuses s WHERE s.id = ?1 AND ${EDIT_LISTENED_SQL}`,
    statusId,
    iso(now),
    mentions ? "" : QUIET_EDIT_SUBJECT,
  );
}

// The journal's newest id ("0" when it is empty), as text (DATA-6): read before a write whose trigger may journal an
// `edit` row that quietJournaledEdit then makes quiet. One seek of the primary key.
export function journalHead(db: Db): string {
  return db.first<{ head: string }>("SELECT CAST(coalesce((SELECT max(id) FROM stream_events), 0) AS TEXT) AS head")!
    .head;
}

// Makes the `edit` row of the status `statusId` that the write just before journaled a quiet edit (QUIET_EDIT_SUBJECT),
// for a state move Mastodon broadcasts with skip_notifications: the journal's newest row, if it is past `head`
// (journalHead, read in this transaction before that write), that status's and an `edit`. An id is never given twice
// (the newest row is never pruned), so a row past `head` is this transaction's, and no older row is touched; when the
// trigger journaled nothing (nobody listening, a full journal), nothing is. At most one row, by its primary key.
export function quietJournaledEdit(db: Db, head: string, statusId: string): void {
  db.run(
    `UPDATE stream_events SET subject = ?3 || subject
		WHERE id = (SELECT max(id) FROM stream_events) AND id > CAST(?1 AS INTEGER) AND kind = 'edit' AND subject = ?2`,
    head,
    statusId,
    QUIET_EDIT_SUBJECT,
  );
}

// The streaming API's announcement events (announcements.ts calls it on each write that changes what a listener may be
// shown): an `announcement` event (subject: the id) or an `announcement_reaction` one (subject: ["<id>","<name>"]) in
// the journal, one per write, while some account listens on `user` (the scope is checked when it is sent) and the
// journal is not full. Nothing is coalesced: a socket opened after an earlier event is sent each later write's own
// event (the hub sends an event only to sockets opened before it). The writes are admin- and user-rate, and
// JOURNAL_SPAN bounds the journal as for every event.
export function streamAnnouncement(
  db: Db,
  kind: "announcement" | "announcement_reaction",
  subject: string,
  now: string,
): void {
  if (db.first("SELECT 1 AS x FROM stream_subscriptions WHERE stream_key = 'user'") === undefined) {
    return;
  }
  if (journalFull(db, kind)) {
    return;
  }
  db.run("INSERT INTO stream_events (kind, subject, created_at) VALUES (?, ?, ?)", kind, subject, now);
}

// Whether the journal spans JOURNAL_SPAN ids (the fan-out stalled), logged for an event of `kind` it then refuses.
export function journalFull(db: Db, kind: string): boolean {
  const span = db.first<{ span: number }>(
    "SELECT coalesce((SELECT max(id) FROM stream_events) - (SELECT min(id) FROM stream_events), 0) AS span",
  );
  if ((span?.span ?? 0) < JOURNAL_SPAN) {
    return false;
  }
  console.warn({ event: "kopje.stream.journal-full", kind });
  return true;
}
