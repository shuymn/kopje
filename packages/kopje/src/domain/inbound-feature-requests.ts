import { ACCOUNTS_ID_INDEX, ACCOUNTS_URI_INDEX, COLLECTION_ITEMS_ID_INDEX } from "../db/indexes";
import type { Db } from "../db/sql";
import { sameOrigin } from "../platform/http-url";
import {
  COLLECTION_ITEM_STATES,
  COLLECTION_MAX_ITEMS,
  COLLECTION_URI_BYTES,
  MAX_STORED_ITEMS,
} from "../platform/stored-bounds";
import { availableSql, mayFeatureSql } from "./audience";
import { featureAuthorizationUri } from "./collection-documents";
import { storableUrl } from "./collection-presenter";
import { notifyAdded } from "./collections";
import { answerRequest } from "./feature-answers";
import { allocateLocalId, insertWithFreshId } from "./ids";
import {
  applyFeaturedCollection,
  type FeaturedCollectionInput,
  ownCollectionByUri,
} from "./remote-featured-collections";
import { isRetracted } from "./retractions";

// An owner's FeatureRequest for a local account (#1589's D24, Mastodon 4.7.5's
// ActivityPub::Activity::FeatureRequest): its actor (the verified HTTP signer when the request names none,
// federation/inbound.ts), its id on that actor's origin (inbox.ts receive), its object a local account available to
// every read (a suspended member cannot consent and issues nothing: the request is ignored, nothing fetched, as a
// Follow to a suspended account is, R38), and its instrument the actor's collection: one Kopje stores, or one fetched
// once on the actor's origin. The fetched one is applied only when Kopje still stores no collection of that uri when
// the fetch returns (otherwise the stored one decides, as it is, and the fetched listing is unused), the owner has not
// retracted it by its Remove (ID-7: then nothing is fetched or stored, and the request is ignored, as Mastodon's owner
// has deleted the item), and it is the owner's (remote-featured-collections.ts applyFeaturedCollection, admitted up to
// MAX_STORED_COLLECTIONS of the owner's: past them the request is refused, with no collection or row). Storing it is a
// change of the owner's collections that a read under way does not hold (markCollectionsChanged, in the application).
// The member's row in that collection (at most one: collection_items_member) decides the answer, which names the
// request it answers (feature-answers.ts answerRequest):
//   - no row: the consent rule (R45, mayFeatureSql) → an accepted row (activity_uri the request), the member notified
//     added_to_collection, and an Accept granting its authorization; refused → a Reject and no row. The new row takes a
//     live slot (takeSlot): at COLLECTION_MAX_ITEMS live items the last-positioned remote member's item is deleted (a
//     copy of the owner's listing, which a later read applies again), and when local members' rows hold every live
//     slot the request is refused;
//   - an accepted row: an Accept with the row's authorization and no check of the member's policy, whichever request
//     it is (the row is the consent, which only the member's revoke or block, or the end of the collection or of either
//     account, ends; Mastodon re-checks its policy on every copy, docs/mastodon-deviations.md). Another request than
//     the row's becomes the row's, its uri cleared (Kopje cannot tell a request after the owner's earlier item was gone
//     from a late copy of an earlier one);
//   - a retired row (revoked: kept RETIRED_ITEM_TTL_MS): a Reject, nothing changed.

export type FeatureRequestActivity = { id: string; object: string; instrument: string };

export type FeatureRequestAnswer =
  | { kind: "need"; uri: string }
  | { kind: "ignored"; reason: string }
  | { kind: "answered"; reason: string };

type Row = { id: string; state: number; activity_uri: string | null };

// `prefetched`: the instrument as the Worker fetched it on the Store's asking (undefined: not asked yet; null: it could
// not be read as a FeaturedCollection of that id).
export function answerFeatureRequest(
  db: Db,
  owner: { id: string; uri: string },
  activity: FeatureRequestActivity,
  prefetched: FeaturedCollectionInput | null | undefined,
  origin: string,
  now: number,
): FeatureRequestAnswer {
  const member = db.first<{ id: string; uri: string }>(
    `SELECT a.id, a.uri FROM accounts a INDEXED BY ${ACCOUNTS_URI_INDEX}
		WHERE a.uri = ?1 AND a.domain IS NULL AND ${availableSql("a.id")}`,
    activity.object,
  );
  // Nothing is fetched for a request Kopje would not answer.
  if (member === undefined) {
    return { kind: "ignored", reason: "unknown-object" };
  }
  if (!storableUrl(activity.id, COLLECTION_URI_BYTES)) {
    return { kind: "ignored", reason: "unstorable-id" };
  }
  let collection = ownCollectionByUri(db, owner.id, activity.instrument);
  if (collection === undefined) {
    if (!sameOrigin(activity.instrument, owner.uri)) {
      return { kind: "ignored", reason: "foreign-instrument" };
    }
    if (isRetracted(db, owner.uri, activity.instrument, now)) {
      return { kind: "ignored", reason: "retracted-instrument" };
    }
    if (prefetched === undefined) {
      return { kind: "need", uri: activity.instrument };
    }
    if (prefetched === null || prefetched.id !== activity.instrument) {
      return { kind: "ignored", reason: "unknown-instrument" };
    }
    const applied = applyFeaturedCollection(db, owner, prefetched, origin, now, { kind: "instrument" });
    if (applied.collection === null) {
      if (!applied.full) {
        return { kind: "ignored", reason: "unknown-instrument" };
      }
      answerRequest(db, "Reject", member, owner, activity.id, allocateLocalId(db, now), null, now);
      return { kind: "answered", reason: "feature-collections-full" };
    }
    collection = { id: applied.collection, uri: activity.instrument };
  }
  const row = db.first<Row>(
    `SELECT id, state, activity_uri FROM collection_items INDEXED BY collection_items_member
		WHERE collection_id = ?1 AND account_id = ?2`,
    collection.id,
    member.id,
  );
  if (row === undefined) {
    const consented = db.first(`SELECT 1 AS x WHERE ${mayFeatureSql("?1", "?2")}`, owner.id, member.id) !== undefined;
    const position = consented ? takeSlot(db, collection.id) : null;
    if (position === null) {
      answerRequest(db, "Reject", member, owner, activity.id, allocateLocalId(db, now), null, now);
      return { kind: "answered", reason: consented ? "feature-full" : "feature-refused" };
    }
    const at = new Date(now).toISOString();
    const item = insertWithFreshId(
      "collection_items",
      () => allocateLocalId(db, now),
      (fresh) => {
        db.run(
          `INSERT INTO collection_items (id, collection_id, account_id, state, position, activity_uri, created_at,
						updated_at)
					VALUES (?, ?, ?, ${COLLECTION_ITEM_STATES.accepted}, ?, ?, ?, ?)`,
          fresh,
          collection.id,
          member.id,
          position,
          activity.id,
          at,
          at,
        );
        return fresh;
      },
    );
    notifyAdded(db, owner.id, member.id, item, now);
    accept(db, member, owner, activity.id, item, now);
    return { kind: "answered", reason: "feature-accepted" };
  }
  if (row.state !== COLLECTION_ITEM_STATES.accepted) {
    answerRequest(db, "Reject", member, owner, activity.id, row.id, null, now);
    return { kind: "answered", reason: "feature-retired" };
  }
  if (row.activity_uri === activity.id) {
    accept(db, member, owner, activity.id, row.id, now);
    return { kind: "answered", reason: "feature-repeated" };
  }
  db.run(
    `UPDATE collection_items INDEXED BY ${COLLECTION_ITEMS_ID_INDEX} SET activity_uri = ?2, uri = NULL, updated_at = ?3
		WHERE id = ?1`,
    row.id,
    activity.id,
    new Date(now).toISOString(),
  );
  accept(db, member, owner, activity.id, row.id, now);
  return { kind: "answered", reason: "feature-reaccepted" };
}

// The Accept of `request` granting the row's authorization.
function accept(
  db: Db,
  member: { id: string; uri: string },
  owner: { id: string; uri: string },
  request: string,
  row: string,
  now: number,
): void {
  answerRequest(db, "Accept", member, owner, request, row, featureAuthorizationUri(member.uri, row), now);
}

// The position of a new row in the collection when a live slot is left for it, taking one if needed (see the module's
// header), else null. Reads the collection's rows once through collection_items_order (at most MAX_STORED_ITEMS), and
// deletes at most one live item (a remote member's) and one retired row (the early eviction, threat-model.md F8).
function takeSlot(db: Db, collection: string): number | null {
  const counts = db.first<{ live: number; total: number; last: number | null }>(
    `SELECT count(*) FILTER (WHERE state IN (0, 1)) AS live, count(*) AS total, max(position) AS last
		FROM collection_items INDEXED BY collection_items_order WHERE collection_id = ?`,
    collection,
  );
  let total = counts?.total ?? 0;
  if ((counts?.live ?? 0) >= COLLECTION_MAX_ITEMS) {
    const freed = db.run(
      `DELETE FROM collection_items INDEXED BY ${COLLECTION_ITEMS_ID_INDEX} WHERE id =
				(SELECT i.id FROM collection_items i INDEXED BY collection_items_order
					LEFT JOIN accounts m INDEXED BY ${ACCOUNTS_ID_INDEX} ON m.id = i.account_id
				WHERE i.collection_id = ?1 AND i.state IN (0, 1) AND (i.account_id IS NULL OR m.domain IS NOT NULL)
				ORDER BY i.position DESC, i.id DESC LIMIT 1)`,
      collection,
    );
    if (freed === 0) {
      return null;
    }
    total -= 1;
  }
  if (total >= MAX_STORED_ITEMS) {
    db.run(
      `DELETE FROM collection_items INDEXED BY ${COLLECTION_ITEMS_ID_INDEX} WHERE id =
				(SELECT id FROM collection_items INDEXED BY collection_items_order
					WHERE collection_id = ? AND state IN (2, 3) ORDER BY updated_at, id LIMIT 1)`,
      collection,
    );
  }
  return Math.min((counts?.last ?? 0) + 1, 2_147_483_647);
}
