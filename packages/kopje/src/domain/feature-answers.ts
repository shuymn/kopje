import { ACCOUNTS_ID_INDEX, ACCOUNTS_URI_INDEX, COLLECTION_ITEMS_ID_INDEX } from "../db/indexes";
import type { Db } from "../db/sql";
import { sameOrigin } from "../platform/http-url";
import { COLLECTION_ITEM_STATES, COLLECTION_URI_BYTES } from "../platform/stored-bounds";
import { recordOutbound, recordOutboundIntent } from "./activities";
import { availableSql } from "./audience";
import {
  authorizedItemOf,
  featureAnswerEnvelope,
  featureAuthorizationUri,
  featureDeleteActivity,
} from "./collection-documents";
import { requestCollectionSync } from "./collection-requests";

// A local account's rows in remote collections (#1589's D21 and D24; Mastodon 4.7.5's
// ActivityPub::Activity::FeatureRequest answered by a local member). A row is created accepted by the member's
// consent to the owner's FeatureRequest (inbound-feature-requests.ts) and serves its authorization
// (featureAuthorizationUri: collection-documents.ts featureAuthorizationDocument) only while accepted. The owner says
// what it holds only through its listing (its Adds, its reads), and it may process Kopje's answer late, out of order
// with a revocation, or not at all, so:
//   - The wait: every answer of a row (each request answered, a repeat of the same request included) queues the row's
//     wait in its check columns (migration 0103_collections): candidate_approval_uri its own authorization,
//     answer_activity_id the answer's outbound intent, check_due_at the next poll. collection-checks.ts runs a due wait
//     with no fetch, no claim token and no quota (advanceWait): while the answer is still being delivered (a target of
//     its intent not yet expanded, or a delivery of it queued, pending or leased) it polls again ANSWER_POLL_MS later;
//     once its delivery settled, the wait has PREAPPROVED_WAIT_MS of margin for the owner to process it, and the
//     margin's end requests a read of the owner's collections. Only the owner's requests extend a wait.
//   - A read (remote-featured-collections.ts applyListing) that lists the row, an item naming the member with the
//     row's authorization, sets the row's uri; a read that does not list it keeps it while its wait is queued, while it
//     is retired (rejected or revoked: the 24-hour cleanup deletes it) or while it changed at or after the read's claim,
//     and deletes it otherwise. The local members' rows a read keeps hold their live slots first.
//   - An owner's listing (its Add, or a read) naming an authorization of the member that Kopje serves in no collection
//     (no row, or a retired one) is answered with the member's Delete of it (answerUnserved), to the owner alone, once
//     per listing, nothing stored: a retraction for an authorization of the row Kopje holds for that member in that
//     collection, one active per authorization (deliveries.ts ANSWER_SUBJECT), and an ordinary intent under RES-4's
//     caps for any other, which Kopje cannot tell from one it never issued. An authorization Kopje serves for another
//     collection is not answered: a Mastodon server applies a Delete of it to whichever of its collections holds it.
//   - An owner's Remove does not delete such a row (it names only an item uri, and may be a late copy about an earlier
//     item of the member): it requests a read (inbox.ts removeFeatured).

// How long a due wait polls its answer's delivery, and the margin after that delivery settles for the owner to process
// it (Mastodon retries an inbound job 8 times over about an hour and a half, processing_worker.rb:6; the rest is margin
// for its queue).
export const ANSWER_POLL_MS = 60 * 60 * 1000;
export const PREAPPROVED_WAIT_MS = 4 * 24 * 60 * 60 * 1000;

// A local member's row in a remote collection, as the listing rules read it: its member, state, uri, whether its wait
// is queued, and whether it changed at or after `since` (updated_at compared as stored: the 24-byte ISO times of the
// CHECK order as their instants).
export type LocalRow = {
  id: string;
  account_id: string;
  member_uri: string;
  state: number;
  uri: string | null;
  position: number;
  waiting: number;
  changed: number;
};

// The local members' rows of the collection `collection` (at most MAX_STORED_ITEMS through collection_items_order),
// in position order.
export function localRows(db: Db, collection: string, since: number): LocalRow[] {
  return db.all<LocalRow>(
    `SELECT i.id, i.account_id, m.uri AS member_uri, i.state, i.uri, i.position, i.check_due_at IS NOT NULL AS waiting,
			i.updated_at >= ?2 AS changed
		FROM collection_items i INDEXED BY collection_items_order
			CROSS JOIN accounts m INDEXED BY ${ACCOUNTS_ID_INDEX} ON m.id = i.account_id
		WHERE i.collection_id = ?1 AND m.domain IS NULL
		ORDER BY i.position, i.id`,
    collection,
    new Date(since).toISOString(),
  );
}

// Whether the collection holds a local member's row.
export function holdsLocalMember(db: Db, collection: string): boolean {
  return (
    db.first(
      `SELECT 1 AS x FROM collection_items i INDEXED BY collection_items_order
				CROSS JOIN accounts m INDEXED BY ${ACCOUNTS_ID_INDEX} ON m.id = i.account_id
			WHERE i.collection_id = ? AND m.domain IS NULL LIMIT 1`,
      collection,
    ) !== undefined
  );
}

// Whether a read keeps the local member's row `row` it does not list.
export function keptUnlisted(row: LocalRow): boolean {
  return (
    row.waiting === 1 ||
    row.state === COLLECTION_ITEM_STATES.rejected ||
    row.state === COLLECTION_ITEM_STATES.revoked ||
    row.changed === 1
  );
}

// What an item of the listing naming a local account is: the local member it names (an available local account by
// its exact uri) and the authorization it lists, which must be one Kopje writes for that member (authorizedItemOf);
// null for anything else, which the listing skips (nothing is answered for an authorization the member never could
// have issued).
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

// The owner's item `uri` (an Add's, or a read's, of the collection `collectionUri`) named the row's authorization: its
// uri becomes the item's, unless another row holds that uri or it is not one of the collection's (the item's id on its
// collection's origin, as every item of it), and a read's listing gives it its `position`. The row is changed either
// way, so a read claimed before it keeps it; its state and its wait stay.
export function markListed(
  db: Db,
  row: string,
  uri: string,
  collectionUri: string,
  now: number,
  position: number | null = null,
): void {
  // The stored form of an item's uri (remote-featured-collections.ts storableUrl: printable ASCII, so its length is its
  // bytes).
  const named =
    uri.length <= COLLECTION_URI_BYTES &&
    /^https:\/\/[!-~]+$/.test(uri) &&
    URL.canParse(uri) &&
    sameOrigin(uri, collectionUri);
  db.run(
    `UPDATE collection_items INDEXED BY ${COLLECTION_ITEMS_ID_INDEX}
			SET uri = CASE WHEN ?3 AND NOT EXISTS (SELECT 1 FROM collection_items o INDEXED BY collection_items_uri
					WHERE o.uri = ?2 AND o.id <> ?1) THEN ?2 ELSE uri END, position = coalesce(?5, position), updated_at = ?4
		WHERE id = ?1`,
    row,
    uri,
    named ? 1 : 0,
    new Date(now).toISOString(),
    position,
  );
}

// The member's Delete of the authorization `listing` names, answering the owner's listing of it in the collection
// `collectionUri`: to the owner's personal inbox alone, immutable (the body of the member's LD-signed revocation without
// its signature, byte for byte: no personal copy rewrites its addressing), a retraction when `held` (the authorization
// of the row Kopje holds for the member there, retired), else an ordinary intent (deliveries.ts OutboundOptions.answer).
// Nothing is sent for an authorization Kopje serves, in whatever collection (its row the member's and accepted, as
// collection-documents.ts featureAuthorizationDocument serves it): a Mastodon server revokes its own collection's item
// by the Delete's authorization and signer alone (delete.rb:80), so a Delete to another owner there would end the
// membership it serves. Whether the Delete was recorded.
export function answerUnserved(
  db: Db,
  owner: { id: string },
  collectionUri: string,
  listing: LocalListing,
  held: boolean,
  now: number,
): boolean {
  const served = db.first(
    `SELECT 1 AS x FROM collection_items INDEXED BY ${COLLECTION_ITEMS_ID_INDEX}
			WHERE id = ?1 AND account_id = ?2 AND state = ${COLLECTION_ITEM_STATES.accepted}`,
    listing.item,
    listing.member.id,
  );
  if (served !== undefined) {
    return false;
  }
  recordOutbound(
    db,
    listing.member.id,
    {
      activity: featureDeleteActivity(listing.member.uri, listing.authorization, collectionUri),
      audience: { followers: false, accounts: [owner.id] },
      immutable: true,
    },
    now,
    { answer: held ? "retraction" : "ordinary", audienceOnly: true, personalInbox: true },
  );
  return true;
}

// The member's answer to the owner's request `request`, recorded from the member to the owner's personal inbox, and
// the row's wait queued again on it (queueWait). `n`: the answer's id (featureAnswerEnvelope).
export function answerRequest(
  db: Db,
  kind: "Accept" | "Reject",
  member: { id: string; uri: string },
  owner: { id: string; uri: string },
  request: string,
  n: string,
  result: string | null,
  now: number,
): string | null {
  return recordOutboundIntent(db, member.id, featureAnswerEnvelope(kind, member, owner, request, n, result), now, {
    personalInbox: true,
  });
}

// Queues the row's wait on the answer `intent` (null: nothing was sent, so its delivery has settled): its candidate the
// row's own authorization, the answer watched, due at the first poll, any earlier wait replaced.
export function queueWait(db: Db, row: string, memberUri: string, intent: string | null, now: number): void {
  db.run(
    `UPDATE collection_items INDEXED BY ${COLLECTION_ITEMS_ID_INDEX}
			SET candidate_approval_uri = ?2, answer_activity_id = CAST(?3 AS INTEGER), check_due_at = ?4,
				check_token = NULL, check_attempts = 0, updated_at = ?5
		WHERE id = ?1`,
    row,
    featureAuthorizationUri(memberUri, row),
    intent,
    now + (intent === null ? PREAPPROVED_WAIT_MS : ANSWER_POLL_MS),
    new Date(now).toISOString(),
  );
}

// A due wait (collection-checks.ts claimItemChecks): no fetch, no token, no quota. While its answer is still being
// delivered (a target of the intent not yet expanded, outbound_targets_activity; or a delivery of it queued, pending
// or leased, deliveries_activity) it moves on by ANSWER_POLL_MS; once neither is left, the answer is no longer watched
// and the margin starts; a wait whose margin ended requests a read of the owner's collections and ends (the row
// changed: a read claimed before it keeps the row, and the read it requests decides).
export function advanceWait(
  db: Db,
  row: { id: string; owner: string; answer: string | null },
  now: number,
): "polled" | "delivered" | "ended" {
  if (row.answer !== null) {
    const active = db.first(
      `SELECT 1 AS x WHERE EXISTS (SELECT 1 FROM outbound_targets INDEXED BY outbound_targets_activity
				WHERE activity_id = CAST(?1 AS INTEGER))
			OR EXISTS (SELECT 1 FROM deliveries INDEXED BY deliveries_activity
				WHERE activity_id = CAST(?1 AS INTEGER) AND state IN ('queued', 'pending', 'leased'))`,
      row.answer,
    );
    db.run(
      `UPDATE collection_items INDEXED BY ${COLLECTION_ITEMS_ID_INDEX}
				SET check_due_at = ?2, answer_activity_id = CASE WHEN ?3 THEN answer_activity_id END WHERE id = ?1`,
      row.id,
      now + (active === undefined ? PREAPPROVED_WAIT_MS : ANSWER_POLL_MS),
      active === undefined ? 0 : 1,
    );
    return active === undefined ? "delivered" : "polled";
  }
  requestCollectionSync(db, row.owner, now);
  db.run(
    `UPDATE collection_items INDEXED BY ${COLLECTION_ITEMS_ID_INDEX}
			SET check_due_at = NULL, candidate_approval_uri = NULL, check_attempts = 0, updated_at = ?2
		WHERE id = ?1`,
    row.id,
    new Date(now).toISOString(),
  );
  return "ended";
}
