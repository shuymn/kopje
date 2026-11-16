import { LOCAL_ACCOUNTS_ID_INDEX, QUOTES_STATUS_INDEX, STATUSES_ID_INDEX } from "../db/indexes";
import type { Db } from "../db/sql";
import { notify } from "./notifications";

// Mastodon's update fan-out (FanOutOnWriteService with `update: true`, its notify_* steps): the notifications an update
// of a status sends, wherever Mastodon broadcasts one. Its callers say which: the edits of statuses.ts and
// remote-statuses.ts, and the quote state changes of quotes.ts. It imports only notifications.ts, so each of them
// calls it without an import cycle.

// The local accounts whose kept boost of the status ?1 an edit of it notifies: one unique seek of
// statuses_account_reblogs_kept per local account (RES-7), so neither the status's remote boosts nor withdrawn
// generations are read.
const LOCAL_BOOSTERS_SQL = `SELECT l.account_id FROM local_accounts l
	CROSS JOIN statuses r INDEXED BY statuses_account_reblogs_kept
		ON r.account_id = l.account_id AND r.reblog_of_id = ?1 AND r.reblog_of_id IS NOT NULL AND r.withdrawn = 0`;

// The local accounts the status ?1 mentions, not silently: the local accounts drive, each one's mention sought by the
// mention's key, so the status's other mention rows are never read; nothing caps them in the schema (a converted or
// imported status may hold any number), and local accounts are operator-sized (RES-4).
const LOCAL_MENTIONS_SQL = `SELECT l.account_id FROM local_accounts l INDEXED BY ${LOCAL_ACCOUNTS_ID_INDEX}
	CROSS JOIN status_mentions m ON m.status_id = ?1 AND m.account_id = l.account_id
	WHERE m.silent = 0`;

// Mastodon's update fan-out, run wherever Mastodon broadcasts an update (each caller says which): FanOutOnWriteService's
// notifications for `update: true` (fan_out_on_write_service.rb:31-35 in v4.7.5), in its order: the local quoted
// account of the status's accepted quote (`quote`, notify_quoted_account!, :62-66), each local account the status
// mentions not silently (`mention`, notify_mentioned_accounts!, :68-75, never limited: an update passes no silenced
// ids), the local boosters (`update`) and the accepted local quoters (`quoted_update`, notify_about_update!, :87-98). Each goes through LocalNotificationWorker, which writes nothing for a notification
// that exists (local_notification_worker.rb:15-16): notify's natural key keeps a kept `quote` or `mention`, and one
// that was dismissed or cleared, or never written (the policy dropped it, R15 refused it), is written now.
export function notifyEdited(db: Db, statusId: string, fromId: string, now: number): void {
  const quoted = localQuotedAccount(db, statusId);
  if (quoted !== null) {
    notify(db, { recipientId: quoted, type: "quote", fromId, statusId, now });
  }
  for (const mention of db.all<{ account_id: string }>(LOCAL_MENTIONS_SQL, statusId)) {
    notify(db, { recipientId: mention.account_id, type: "mention", fromId, statusId, now });
  }
  // A withdrawn boost's booster is not notified (Mastodon discards it).
  for (const booster of db.all<{ account_id: string }>(LOCAL_BOOSTERS_SQL, statusId)) {
    notify(db, { recipientId: booster.account_id, type: "update", fromId, statusId, now });
  }
  notifyQuotedUpdate(db, statusId, fromId, now);
}

// FanOutOnWriteService#notify_about_update!'s quoted_update: each local quoter (quotedUpdates) about their own quoting
// status, from the quoted author; a later one replaces the earlier (notify).
function notifyQuotedUpdate(db: Db, quotedId: string, fromId: string, now: number): void {
  for (const quote of quotedUpdates(db, quotedId)) {
    notify(db, { recipientId: quote.account_id, type: "quoted_update", fromId, statusId: quote.status_id, now });
  }
}

// The local quoted account of the status's accepted quote, which an update of the status notifies again
// (FanOutOnWriteService#notify_quoted_account!; notifyEdited): the quote by its key, its quoted account sought among the
// local accounts; at most one row.
function localQuotedAccount(db: Db, statusId: string): string | null {
  return (
    db.first<{ quoted_account_id: string }>(
      `SELECT q.quoted_account_id FROM quotes q INDEXED BY ${QUOTES_STATUS_INDEX}
			CROSS JOIN local_accounts l INDEXED BY ${LOCAL_ACCOUNTS_ID_INDEX} ON l.account_id = q.quoted_account_id
			WHERE q.status_id = ?1 AND q.state = 'accepted'`,
      statusId,
    )?.quoted_account_id ?? null
  );
}

// Local accounts an edit of a status notifies with quoted_update at most (row 16): the authors of its newest accepted
// local quotes.
export const MAX_QUOTED_UPDATES = 100;

// The quoting statuses and their local authors that an edit of `quotedId` notifies (Mastodon's
// FanOutOnWriteService#notify_about_update!): the accepted local quotes at this commit, newest first, at most
// MAX_QUOTED_UPDATES, from one seek of quotes_local_accepted (migration 0039_quotes_local) whatever the received
// quotes of the status.
export function quotedUpdates(db: Db, quotedId: string): { status_id: string; account_id: string }[] {
  return db.all<{ status_id: string; account_id: string }>(
    `SELECT q.status_id, s.account_id FROM quotes q INDEXED BY quotes_local_accepted
		CROSS JOIN statuses s INDEXED BY ${STATUSES_ID_INDEX} ON s.id = q.status_id
		WHERE q.quoted_status_id = ? AND q.local = 1 AND q.state = 'accepted'
		ORDER BY q.status_id DESC LIMIT ?`,
    quotedId,
    MAX_QUOTED_UPDATES,
  );
}
