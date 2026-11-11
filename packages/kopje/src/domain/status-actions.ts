import type { Db } from "../db/sql";
import { iso } from "../platform/iso-time";
import type { Present } from "./accounts";
import { featuredActivity, PIN_LIMIT, recordOutbound } from "./activities";
import { announceFeatured } from "./actor-update";
import { requiresMention, type Visibility } from "./audience";
import { userWriteOperation } from "./auth";
import { allocateLocalId } from "./ids";
import { MAX_REMOTE_PINS } from "./remote-collections";
import type { Status } from "./status-presenter";
import { type Acted, presented, viewable } from "./statuses";

// The status actions of Mastodon 4.5 that keep a viewer's own choice about a status (R31): pinning it to the
// profile (Api::V1::Statuses::PinsController, StatusPin) and muting its conversation (Api::V1::Statuses::
// MutesController, ConversationMute). Each acts on a status the viewer may see (Statuses::BaseController#set_status
// authorizes show?; anything else is not found) and answers with it, as GET /api/v1/statuses/:id shows it then.
//
// A pin is public: the profile's pinned statuses are listed to whoever may see each (account statuses with pinned,
// R11) and served in the actor's featured collection (activities.ts), and pinning or unpinning is told to the
// followers (Add, Remove). A conversation mute is the viewer's alone: it shows in their statuses' `muted` and stops
// the notifications about statuses of the conversation from being written (notifiedSql in audience.ts), and only
// audience.ts reads it.

type ActionInput = { id: string; now: number; present: Present };

// ---- The stored bound of pins: migration 0089_pin_cap (RES-2, RES-4)
//
// status_pins holds at most an account's pin limit of rows per account, imports included: PIN_LIMIT for a local
// account (StatusPinValidator, which pin checks in its transaction), MAX_REMOTE_PINS for a remote one (the writers of
// remote-collections.ts keep a slot below it). Its writers never pass it, so its trigger only refuses an import or a
// write past it. An account's pins are read in pin order, newest first (p.created_at DESC, s.id DESC), through the
// primary key: at most MAX_REMOTE_PINS rows.

// The pin limit of the account whose id is the SQL `account`: a local account's, else a remote one's.
export function pinCapSql(account: string): string {
  return `iif(EXISTS (SELECT 1 FROM local_accounts l WHERE l.account_id = ${account}), ${PIN_LIMIT}, ${MAX_REMOTE_PINS})`;
}

// Whether the account `account` keeps its pin limit of pins other than the status `status`: a new pin of it would
// pass the limit. Reads at most MAX_REMOTE_PINS + 1 rows through the primary key.
function pinsFullSql(account: string, status: string): string {
  return `NOT EXISTS (SELECT 1 FROM status_pins WHERE account_id = ${account} AND status_id = ${status})
  AND (SELECT count(*) FROM (SELECT 1 FROM status_pins WHERE account_id = ${account} LIMIT ${MAX_REMOTE_PINS}))
    >= ${pinCapSql(account)}`;
}

const PIN_CAP_REFUSED = "status_pins: more pins than the account may keep";

// Migration 0089_pin_cap after its header (test/migrations.test.ts compares them): each account's pins past its limit
// deleted, the oldest in pin order first (the presenter's order, newest first by created_at then status id, kept), then
// triggers that refuse a pin past the limit, inserted or moved to another account. The trim sorts only the pins of
// accounts holding more than PIN_LIMIT.
export function pinCapMigrationSql(): string {
  return `${[
    `DELETE FROM status_pins WHERE (account_id, status_id) IN (
  SELECT c.account_id, c.status_id FROM (
    SELECT p.account_id, p.status_id,
      row_number() OVER (PARTITION BY p.account_id ORDER BY p.created_at DESC, p.status_id DESC) AS n
    FROM status_pins p
    WHERE p.account_id IN (SELECT account_id FROM status_pins GROUP BY account_id HAVING count(*) > ${PIN_LIMIT})
  ) c WHERE c.n > ${pinCapSql("c.account_id")});`,
    `CREATE TRIGGER status_pins_cap_insert BEFORE INSERT ON status_pins
WHEN ${pinsFullSql("NEW.account_id", "NEW.status_id")}
BEGIN
  SELECT RAISE(ABORT, '${PIN_CAP_REFUSED}');
END;`,
    `CREATE TRIGGER status_pins_cap_update BEFORE UPDATE OF account_id ON status_pins
WHEN NEW.account_id IS NOT OLD.account_id AND ${pinsFullSql("NEW.account_id", "NEW.status_id")}
BEGIN
  SELECT RAISE(ABORT, '${PIN_CAP_REFUSED}');
END;`,
  ].join("\n\n")}\n`;
}

// StatusPinValidator's messages (statuses.pin_errors in Mastodon's config/locales/en.yml), in its order.
export const PIN_ERRORS = {
  reblog: "A boost cannot be pinned",
  ownership: "Someone else's post cannot be pinned",
  direct: "Posts that are only visible to mentioned users cannot be pinned",
  limit: "You have already pinned the maximum number of posts",
} as const;

function actorUri(db: Db, accountId: string): string {
  const row = db.first<{ uri: string }>("SELECT uri FROM accounts WHERE id = ?", accountId);
  if (row === undefined) {
    throw new Error("authorized viewer has no account");
  }
  return row.uri;
}

// POST /api/v1/statuses/:id/pin (StatusPin.create!): StatusPinValidator refuses a boost, someone else's status, a
// direct status and a pin past PIN_LIMIT, with every message that applies (ActiveRecord::RecordInvalid's "Validation
// failed: ..."); a status already pinned then answers Mastodon's "Duplicate record" (RecordNotUnique). A new pin is
// told to the followers in an Add. A limited status, which the API shows as private, is a direct one whose recipients
// were not all mentioned, and is refused as direct.
export const pin = userWriteOperation<ActionInput, Acted<Status>>((db, input, { accountId }, viewer) => {
  const id = viewable(db, accountId, input.id);
  if (id === null) {
    return { status: "not_found" };
  }
  const row = db.first<{
    account_id: string;
    reblog_of_id: string | null;
    visibility: Visibility;
    uri: string;
    pinned: number;
    pins: number;
  }>(
    `SELECT s.account_id, s.reblog_of_id, s.visibility, s.uri,
			EXISTS (SELECT 1 FROM status_pins WHERE account_id = ?1 AND status_id = s.id) AS pinned,
			(SELECT count(*) FROM (SELECT 1 FROM status_pins WHERE account_id = ?1 LIMIT ?3)) AS pins
		FROM statuses s WHERE s.id = ?2`,
    accountId,
    id,
    PIN_LIMIT,
  );
  if (row === undefined) {
    return { status: "not_found" };
  }
  const errors = [
    ...(row.reblog_of_id === null ? [] : [PIN_ERRORS.reblog]),
    ...(row.account_id === accountId ? [] : [PIN_ERRORS.ownership]),
    ...(requiresMention(row.visibility) ? [PIN_ERRORS.direct] : []),
    ...(row.pins >= PIN_LIMIT ? [PIN_ERRORS.limit] : []),
  ];
  if (errors.length > 0) {
    return { status: "invalid", error: `Validation failed: ${errors.join(", ")}` };
  }
  if (row.pinned === 1) {
    return { status: "invalid", error: "Duplicate record" };
  }
  db.run("INSERT INTO status_pins (account_id, status_id, created_at) VALUES (?, ?, ?)", accountId, id, iso(input.now));
  recordFeatured(db, "Add", accountId, row.uri, input.now);
  return presented(db, id, viewer, input.present);
});

// POST /api/v1/statuses/:id/unpin: the viewer's pin of the status goes, if there is one, and its removal is told to
// the followers in a Remove. Without one, nothing changes.
export const unpin = userWriteOperation<ActionInput, Acted<Status>>((db, input, { accountId }, viewer) => {
  const id = viewable(db, accountId, input.id);
  if (id === null) {
    return { status: "not_found" };
  }
  const removed = db.all<{ uri: string }>(
    `DELETE FROM status_pins WHERE account_id = ?1 AND status_id = ?2
		RETURNING (SELECT uri FROM statuses WHERE id = ?2) AS uri`,
    accountId,
    id,
  )[0];
  if (removed !== undefined) {
    recordFeatured(db, "Remove", accountId, removed.uri, input.now);
  }
  return presented(db, id, viewer, input.present);
});

function recordFeatured(db: Db, type: "Add" | "Remove", accountId: string, statusUri: string, now: number): void {
  const actor = actorUri(db, accountId);
  // Servers that stored the actor before it published its featured collection match the target against nothing.
  announceFeatured(db, accountId, now);
  recordOutbound(
    db,
    accountId,
    featuredActivity(type, { id: `${actor}#featured/${allocateLocalId(db, now)}`, actorUri: actor, statusUri }),
    now,
  );
}

// A change to the viewer's mute of a status's conversation, its thread (a boost's own, as Mastodon gives a boost a
// conversation of its own). A status without a thread raises Mastodon::ValidationError, as one without a conversation
// does.
const conversationMuteChange = (change: (db: Db, accountId: string, thread: string) => void) =>
  userWriteOperation<ActionInput, Acted<Status>>((db, input, { accountId }, viewer) => {
    const id = viewable(db, accountId, input.id);
    if (id === null) {
      return { status: "not_found" };
    }
    const thread = db.first<{ thread: string | null }>("SELECT thread FROM statuses WHERE id = ?", id)?.thread ?? null;
    if (thread === null) {
      return { status: "invalid", error: "Mastodon::ValidationError" };
    }
    change(db, accountId, thread);
    return presented(db, id, viewer, input.present);
  });

// POST /api/v1/statuses/:id/mute (Account#mute_conversation!): the viewer mutes the status's conversation. Muting it
// again changes nothing.
export const muteConversation = conversationMuteChange((db, accountId, thread) => {
  db.run("INSERT INTO conversation_mutes (account_id, thread) VALUES (?, ?) ON CONFLICT DO NOTHING", accountId, thread);
});

// POST /api/v1/statuses/:id/unmute (Account#unmute_conversation!): the mute of the status's conversation goes, if
// there is one.
export const unmuteConversation = conversationMuteChange((db, accountId, thread) => {
  db.run("DELETE FROM conversation_mutes WHERE account_id = ? AND thread = ?", accountId, thread);
});
