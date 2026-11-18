import { ACCOUNTS_ID_INDEX, ACCOUNTS_URI_INDEX, COLLECTION_ITEMS_ID_INDEX, COLLECTIONS_ID_INDEX } from "../db/indexes";
import type { Db } from "../db/sql";
import { COLLECTION_ITEM_STATES } from "../platform/stored-bounds";
import { recordOutbound } from "./activities";
import { availableSql } from "./audience";
import { authorizedItemOf, featureAnswerEnvelope, featureDeleteActivity } from "./collection-documents";

// A local account's rows in remote collections (#1589's D21 and D24; Mastodon 4.7.5's
// ActivityPub::Activity::FeatureRequest answered by a local member). A row is created accepted by the member's consent
// to the owner's FeatureRequest (inbound-feature-requests.ts) and serves its authorization (collection-documents.ts
// featureAuthorizationDocument) while it is accepted. The row is the member's consent, which lasts until the member
// revokes it or blocks the owner, or the collection or either account is removed: no listing of the owner's ends it, so
// an Accept the owner processes late, by any amount, always finds it (threat-model.md ID-9, which
// migration 0118_feature_grant_guard enforces). What the owner lists decides only who else sees the row (R45: its uri,
// the owner's item that last listed it, NULL while unlisted):
//   - An owner's listing that names the row's authorization sets its uri: its Add of the item (unless the owner
//     retracted that item, ID-7), a read of its collections whatever the retractions, and an embedded listing (an Add
//     or an Update of the collection, a request's instrument, a search).
//   - Only a read hides: an untruncated listing that does not name the accepted row clears its uri, unless the row
//     changed at or after the read's claim (remote-featured-collections.ts applyListing). So does the owner's Remove of
//     the row's item (inbox.ts removeFeatured), which also requests a read.
//   - A listing that names a member unavailable to every read (suspended) leaves its row as it is, and so does a read's
//     omission of it.
//   - An owner's listing (its Add, or a read) naming an authorization of the member that Kopje serves in no collection
//     (no row, or a retired one) is answered with the member's Delete of it (answerUnserved), to the sender alone, once
//     per listing, nothing stored: a retraction to the owner of a row Kopje holds for that member, of that row's
//     authorization, at most one copy waiting (deliveries.ts answerOutstanding), and an ordinary intent under RES-4's
//     caps for any other, which Kopje cannot tell from one it never issued (threat-model.md F8). An authorization
//     Kopje serves for another collection is not answered: a Mastodon server applies a Delete of it to whichever of its
//     collections holds it.
// Answers to requests are ordinary deliveries (answerRequest), as Mastodon's DeliveryWorker sends them.

// A local member's row in a remote collection, as a listing reads it: its member, state, uri, whether it changed at
// or after `since` (updated_at compared as stored: the 24-byte ISO times of the CHECK order as their instants), and
// whether its member is available to every read (availableSql).
export type LocalRow = {
  id: string;
  account_id: string;
  state: number;
  uri: string | null;
  changed: number;
  available: number;
};

// The local members' rows of the collection `collection` (at most MAX_STORED_ITEMS through collection_items_order),
// in position order.
export function localRows(db: Db, collection: string, since: number): LocalRow[] {
  return db.all<LocalRow>(
    `SELECT i.id, i.account_id, i.state, i.uri, i.updated_at >= ?2 AS changed, ${availableSql("i.account_id")} AS available
		FROM collection_items i INDEXED BY collection_items_order
			CROSS JOIN accounts m INDEXED BY ${ACCOUNTS_ID_INDEX} ON m.id = i.account_id
		WHERE i.collection_id = ?1 AND m.domain IS NULL
		ORDER BY i.position, i.id`,
    collection,
    new Date(since).toISOString(),
  );
}

// The SQL condition that the collection `collection` (an SQL expression) holds a local member's row, in any state: a
// complete read keeps such a collection whole (remote-featured-collections.ts deleteUnlisted, threat-model.md ID-9).
// Reads at most the collection's MAX_STORED_ITEMS rows through collection_items_order, one account probe each, and
// stops at the first local member's.
export function holdsLocalMember(collection: string): string {
  return `EXISTS (SELECT 1 FROM collection_items i INDEXED BY collection_items_order
					CROSS JOIN accounts m INDEXED BY ${ACCOUNTS_ID_INDEX} ON m.id = i.account_id
				WHERE i.collection_id = ${collection} AND m.domain IS NULL)`;
}

// Whether a read leaves the local member's row `row` it does not list as it is, rather than hiding it: a row not
// accepted (its cleanup ends it), one not listed already, one whose member is unavailable (no listing changes its row),
// or one changed at or after the read's claim (the documents read predate that change). No read deletes a local
// member's row (ID-9).
export function keptUnlisted(row: LocalRow): boolean {
  return row.state !== COLLECTION_ITEM_STATES.accepted || row.uri === null || row.available !== 1 || row.changed !== 0;
}

// What an item of a listing naming a local account is: the local member it names (an available local account by its
// exact uri) and the authorization it lists, which must be one Kopje writes for that member (authorizedItemOf); null
// for anything else, which the listing skips (nothing is answered for an authorization the member never could have
// issued, or for a member that cannot act).
export type LocalListing = { member: { id: string; uri: string }; authorization: string; item: string };

export function localListing(db: Db, object: string, authorization: string | null): LocalListing | null {
  if (authorization === null) {
    return null;
  }
  const member = db.first<{ id: string; uri: string }>(
    `SELECT a.id, a.uri FROM accounts a INDEXED BY ${ACCOUNTS_URI_INDEX}
		WHERE a.uri = ?1 AND a.domain IS NULL AND ${availableSql("a.id")}`,
    object,
  );
  const item = member === undefined ? null : authorizedItemOf(member.uri, authorization);
  return member === undefined || item === null ? null : { member, authorization, item };
}

// Whether the listed authorization is the one `row` serves: the row is the member's, accepted, and the authorization
// names it.
export function serves(row: Pick<LocalRow, "id" | "account_id" | "state">, listing: LocalListing): boolean {
  return (
    row.account_id === listing.member.id && row.state === COLLECTION_ITEM_STATES.accepted && row.id === listing.item
  );
}

// The owner's item `uri` (an Add's or a listing's, one of its collection's: remote-featured-collections.ts isItemOf)
// named the row's authorization: its uri becomes the item's, and a listing gives it its `position`; whether it did.
// An item uri another row holds (another collection's item, or one this collection keeps) names no row of a local
// member: the row is left as it is, so the listing has not listed it (it may hide it, applyListing). updated_at moves
// only when the uri does, so a read claimed before a change of who is shown keeps the row (its fence), and a listing
// that names the row as it is listed already fences nothing.
export function markListed(db: Db, row: string, uri: string, now: number, position: number | null = null): boolean {
  return (
    db.first(
      `UPDATE collection_items INDEXED BY ${COLLECTION_ITEMS_ID_INDEX}
			SET uri = ?2, updated_at = CASE WHEN uri IS NOT ?2 THEN ?3 ELSE updated_at END, position = coalesce(?4, position)
		WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM collection_items o INDEXED BY collection_items_uri
				WHERE o.uri = ?2 AND o.id <> ?1)
		RETURNING 1 AS x`,
      row,
      uri,
      new Date(now).toISOString(),
      position,
    ) !== undefined
  );
}

// The row is hidden from everyone but its member (R45): its uri cleared. Its state, its authorization and its consent
// stay (threat-model.md ID-9: an omission hides, and never deletes).
export function hideRow(db: Db, row: string, now: number): void {
  db.run(
    `UPDATE collection_items INDEXED BY ${COLLECTION_ITEMS_ID_INDEX} SET uri = NULL, updated_at = ?2
		WHERE id = ?1 AND uri IS NOT NULL`,
    row,
    new Date(now).toISOString(),
  );
}

// The member's Delete of the authorization `listing` names, answering a listing of it by `sender` (the owner of the
// collection `collectionUri`, or another account listing it in its own): to the sender's personal inbox alone,
// immutable (the body of the member's LD-signed revocation without its signature, byte for byte: no personal copy
// rewrites its addressing). It is a retraction while Kopje holds the row of that authorization (any state: the
// authorization names the row) and the sender owns the row's collection, else an ordinary intent (deliveries.ts
// OutboundOptions.answer): a retraction is never refused, so only the one owner a held row has draws one, and another
// account's listing of it is new work under RES-4's caps, as one of an authorization Kopje never issued is. Nothing is
// sent for an authorization Kopje serves, in whatever collection (its row the member's and accepted, as
// collection-documents.ts featureAuthorizationDocument serves it): a Mastodon server revokes its own collection's item
// by the Delete's authorization and signer alone (delete.rb:80), so a Delete to another owner there would end the
// membership it serves. Whether the Delete was recorded.
export function answerUnserved(
  db: Db,
  sender: { id: string },
  collectionUri: string,
  listing: LocalListing,
  now: number,
): boolean {
  const held = db.first<{ state: number; owned: number }>(
    `SELECT i.state, c.account_id = ?3 AS owned FROM collection_items i INDEXED BY ${COLLECTION_ITEMS_ID_INDEX}
			CROSS JOIN collections c INDEXED BY ${COLLECTIONS_ID_INDEX} ON c.id = i.collection_id
			WHERE i.id = ?1 AND i.account_id = ?2`,
    listing.item,
    listing.member.id,
    sender.id,
  );
  if (held?.state === COLLECTION_ITEM_STATES.accepted) {
    return false;
  }
  recordOutbound(
    db,
    listing.member.id,
    {
      activity: featureDeleteActivity(listing.member.uri, listing.authorization, collectionUri),
      audience: { followers: false, accounts: [sender.id] },
      immutable: true,
    },
    now,
    { answer: held?.owned === 1 ? "retraction" : "ordinary", audienceOnly: true, personalInbox: true },
  );
  return true;
}

// The member's answer to the owner's request `request`, recorded from the member to the owner's personal inbox as an
// ordinary delivery. `n`: the answer's id (featureAnswerEnvelope).
export function answerRequest(
  db: Db,
  kind: "Accept" | "Reject",
  member: { id: string; uri: string },
  owner: { id: string; uri: string },
  request: string,
  n: string,
  result: string | null,
  now: number,
): void {
  recordOutbound(db, member.id, featureAnswerEnvelope(kind, member, owner, request, n, result), now, {
    personalInbox: true,
  });
}
