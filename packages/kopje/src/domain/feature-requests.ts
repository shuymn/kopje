import { COLLECTION_ITEMS_ID_INDEX, COLLECTIONS_ID_INDEX } from "../db/indexes";
import type { Db } from "../db/sql";
import { sameOrigin } from "../platform/http-url";
import { COLLECTION_ITEM_STATES, COLLECTION_URI_BYTES } from "../platform/stored-bounds";
import { recordItemAdd } from "./collection-documents";
import { storableUrl } from "./remote-featured-collections";

// A remote member's answer to Kopje's FeatureRequest (#1589's D23, Mastodon 4.7.5's Accept#accept_feature_request! and
// Reject#reject_feature_request!). The request is the pending item collections.ts insertItem wrote, named by its
// activity_uri; only the item's own account answers it (ID-6). An Accept changes only a pending item whose earlier
// answer awaits no check (no candidate_approval_uri), and is decided by the first deletion of the member's
// authorization Kopje recorded before it (retracted_approval_uri, remote-featured-collections.ts
// revokeFeatureAuthorization):
//   - none: accepted with the result R as its approval_uri, and the item's Add sent to the collection's reach;
//   - R itself: revoked, nothing sent (the member withdrew R before its Accept arrived);
//   - another one: R becomes the candidate of a check (collection-checks.ts), which accepts it only if the member's
//     server still serves R, since Kopje keeps only the first deletion and R's own may be among those it did not keep.
// Each clears the recorded deletion. An Accept without a result Kopje can store on the member's host, with a result
// the member already holds as another row's approval_uri, after a removal (no row), a rejection or a revocation, or
// while a check is queued, changes nothing (Mastodon accepts the item whatever its state:
// docs/mastodon-deviations.md, "Collections"). A Reject ends a pending or accepted item as rejected and fences a
// check of an earlier answer: the candidate, its due time and its claim's token are cleared, so a completion of that
// check changes nothing (collection-checks.ts CLAIMED).

type Requested = { id: string; collection: string; state: number; candidate: string | null; retracted: string | null };

// Our FeatureRequest `request` the actor answers (Activity#feature_request_from_object: CollectionItem.local, by
// activity_uri and the actor as the item's account): one item of a local collection. collection_items_activity is not
// unique (an import may give rows of any collection the same activity_uri), so at most two rows holding the id are
// read before the actor and the collection are tested: a request Kopje wrote names one item, and an id that two rows
// hold answers no request.
export function ourFeatureRequest(db: Db, actor: { id: string }, request: string | null): Requested | undefined {
  if (request === null) {
    return undefined;
  }
  const rows = db.all<Requested & { ours: number }>(
    `SELECT r.id, r.collection, r.state, r.candidate, r.retracted, r.account_id = ?2 AND c.local = 1 AS ours
		FROM (SELECT id, collection_id AS collection, state, candidate_approval_uri AS candidate,
				retracted_approval_uri AS retracted, account_id
			FROM collection_items INDEXED BY collection_items_activity WHERE activity_uri = ?1 LIMIT 2) r
			CROSS JOIN collections c INDEXED BY ${COLLECTIONS_ID_INDEX} ON c.id = r.collection`,
    request,
    actor.id,
  );
  return rows.length === 1 && rows[0]!.ours === 1 ? rows[0] : undefined;
}

export type AcceptOutcome = "accepted" | "revoked" | "check";

// The member's Accept of `item` with `result` (see the module's header): its outcome, or null when it changes nothing.
export function acceptFeatureRequest(
  db: Db,
  actor: { id: string; uri: string },
  item: Requested,
  result: string | null,
  now: number,
): AcceptOutcome | null {
  if (
    !storableUrl(result, COLLECTION_URI_BYTES) ||
    !sameOrigin(result, actor.uri) ||
    item.state !== COLLECTION_ITEM_STATES.pending ||
    item.candidate !== null
  ) {
    return null;
  }
  // Only the member's server can have said that it holds R for another of its items (collection_items_approval).
  const held = db.first(
    `SELECT 1 AS x FROM collection_items INDEXED BY collection_items_approval
			WHERE account_id = ?1 AND approval_uri = ?2 AND id <> ?3`,
    actor.id,
    result,
    item.id,
  );
  if (held !== undefined) {
    return null;
  }
  const at = new Date(now).toISOString();
  if (item.retracted === null) {
    db.run(
      `UPDATE collection_items INDEXED BY ${COLLECTION_ITEMS_ID_INDEX}
				SET state = ${COLLECTION_ITEM_STATES.accepted}, approval_uri = ?2, updated_at = ?3
			WHERE id = ?1`,
      item.id,
      result,
      at,
    );
    recordItemAdd(db, { id: item.id, collection: item.collection }, now);
    return "accepted";
  }
  if (item.retracted === result) {
    db.run(
      `UPDATE collection_items INDEXED BY ${COLLECTION_ITEMS_ID_INDEX}
				SET state = ${COLLECTION_ITEM_STATES.revoked}, retracted_approval_uri = NULL, updated_at = ?2
			WHERE id = ?1`,
      item.id,
      at,
    );
    return "revoked";
  }
  db.run(
    `UPDATE collection_items INDEXED BY ${COLLECTION_ITEMS_ID_INDEX}
			SET retracted_approval_uri = NULL, candidate_approval_uri = ?2, check_due_at = ?3, check_attempts = 0,
				check_token = NULL, updated_at = ?4
		WHERE id = ?1`,
    item.id,
    result,
    now,
    at,
  );
  return "check";
}

// The member's Reject of `item` (see the module's header): whether it changed the item.
export function rejectFeatureRequest(db: Db, item: Requested, now: number): boolean {
  if (item.state !== COLLECTION_ITEM_STATES.pending && item.state !== COLLECTION_ITEM_STATES.accepted) {
    return false;
  }
  db.run(
    `UPDATE collection_items INDEXED BY ${COLLECTION_ITEMS_ID_INDEX}
			SET state = ${COLLECTION_ITEM_STATES.rejected}, retracted_approval_uri = NULL, updated_at = ?2,
				candidate_approval_uri = NULL, check_due_at = NULL, check_token = NULL
		WHERE id = ?1`,
    item.id,
    new Date(now).toISOString(),
  );
  return true;
}
