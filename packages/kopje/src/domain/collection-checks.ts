import { ACCOUNTS_ID_INDEX, COLLECTION_ITEMS_ID_INDEX, COLLECTIONS_ID_INDEX } from "../db/indexes";
import type { Db } from "../db/sql";
import { COLLECTION_CHECK_ATTEMPTS, COLLECTION_ITEM_STATES } from "../platform/stored-bounds";
import { localCollectionUri, recordItemAdd } from "./collection-documents";
import { writeOperation } from "./operation";

// Checks of remote members' feature authorizations (#1589's D22, Mastodon 4.7.5's ActivityPub::VerifyFeaturedItemService):
// an item of a remote collection is accepted only once its member's server serves an authorization naming the
// collection and the member. Kopje checks an item once per revision (remote-featured-collections.ts queues it when the
// owner first lists it or changes it), where Mastodon verifies it again on every processing of the collection. A local
// collection's item is checked the same way when its member's Accept followed a deletion of another of its
// authorizations (D23, feature-requests.ts), against the collection's own id: a match also sends the item's Add to the
// collection's reach, and an authorization gone revokes it (the member answered, then withdrew).
//
// The queue is durable in the item's row (check_due_at, check_attempts, check_token, migration 0103_collections) and
// run by the Worker's job rounds (jobs/queue.ts, federation/collection-checks.ts) apart from the collection syncs, so no
// sync phase, request generation or owner's Update delays or removes a queued check:
//   - claimItemChecks reads at most ITEM_CHECK_CANDIDATES due items in (check_due_at, id) order across every owner
//     (collection_items_check), and moves each it reads: a sixth attempt ends the revision's check (pending,
//     unqueued); an owner that has spent its day's OWNER_CHECKS_PER_DAY claims has its item deferred to the next UTC
//     day's start; any other is claimed, at most ITEM_CHECKS_PER_ROUND a round: a new token, a lease of CHECK_LEASE_MS,
//     an attempt, and one claim charged to the collection's owner for the UTC day of the claim (collection_check_quotas,
//     migration 0113_featured_collection_syncs). The walk stops at the round's last claim, so each round reads at most
//     ITEM_CHECK_CANDIDATES rows and every row it reads moves forward.
//   - completeItemChecks applies a round's outcomes, each only while its item is pending and holds the token its claim
//     set (a revision change, a revocation, a Reject and a later claim each replace or clear it). An item whose
//     candidate its member has retracted (ID-7's tombstone: the member's Delete reached Kopje without revoking the
//     item) is revoked whatever the fetch found, since the member's server may serve a withdrawn authorization from a
//     cache (Mastodon 4.7.5's FeatureAuthorizationsController, 30 seconds public). Otherwise a match accepts the item with
//     the candidate as its verified authorization, unless another row of the same member holds that authorization
//     (only the member's server can have said so), which ends the check as a mismatch; a final refusal (a 4xx other
//     than 401, 408 and 429) or a document that is no object rejects it; a mismatch or an unsupported document (a
//     redirect, past ITEM_CHECK_CAPS) ends the check; a transient failure backs off, CHECK_BACKOFF_MS ×
//     4^(attempts − 1). Every outcome clears the token.
// A claim is charged when it is made, so a round that dies spends its claims and its attempts, and its items come due
// when their leases end. Whatever an owner does (removing and re-adding an item, changing its authorization after each
// failure), its collections cost at most OWNER_CHECKS_PER_DAY claims a UTC day.

// The due items one claim reads, and claims, at most.
export const ITEM_CHECK_CANDIDATES = 16;
export const ITEM_CHECKS_PER_ROUND = 4;
// How long a claim holds its item from other rounds, and the first backoff after a transient failure.
export const CHECK_LEASE_MS = 10 * 60 * 1000;
export const CHECK_BACKOFF_MS = 15 * 60 * 1000;
// The claims one owner's collections may take in a UTC day: one full account's items (MAX_REMOTE_COLLECTIONS ×
// COLLECTION_MAX_ITEMS). collection_check_quotas' CHECK holds the same number.
export const OWNER_CHECKS_PER_DAY = 250;
export const DAY_MS = 86_400_000;

// A claimed check: the item, its claim's token, the authorization to fetch (its candidate), and what the document must
// name: the collection's id and the member's.
export type ItemCheck = { item: string; token: string; authorization: string; collection: string; member: string };

// A check's outcome (federation/collection-checks.ts): the authorization matched; it is gone (a 4xx other than 401,
// 408 and 429, or no object); it does not match, or cannot be read as Kopje reads it (a redirect, past the caps); or
// the fetch may pass later.
export type ItemCheckOutcome = "match" | "gone" | "mismatch" | "transient";

type Candidate = {
  id: string;
  attempts: number;
  candidate: string | null;
  owner: string | null;
  local: number | null;
  collection_id: string;
  collection: string | null;
  owner_uri: string | null;
  member: string | null;
  member_local: number | null;
};

// The due items, oldest due first, with what a claim reads of each by key: its collection and that collection's owner,
// and its member. ?1 now, ?2 the most read.
const DUE = `SELECT i.id, i.check_attempts AS attempts, i.candidate_approval_uri AS candidate, c.account_id AS owner,
		c.local, i.collection_id, c.uri AS collection, o.uri AS owner_uri, a.uri AS member, a.domain IS NULL AS member_local
	FROM (SELECT id FROM collection_items INDEXED BY collection_items_check
		WHERE check_due_at >= 0 AND check_due_at <= ?1 ORDER BY check_due_at, id LIMIT ?2) w
	CROSS JOIN collection_items i INDEXED BY ${COLLECTION_ITEMS_ID_INDEX} ON i.id = w.id
	LEFT JOIN collections c INDEXED BY ${COLLECTIONS_ID_INDEX} ON c.id = i.collection_id
	LEFT JOIN accounts o INDEXED BY ${ACCOUNTS_ID_INDEX} ON o.id = c.account_id
	LEFT JOIN accounts a INDEXED BY ${ACCOUNTS_ID_INDEX} ON a.id = i.account_id
	ORDER BY i.check_due_at, i.id`;

// The id of the collection a candidate's authorization must name: a remote collection's uri, a local one's as Kopje
// writes it; null for neither.
function checkedCollection(row: Candidate): string | null {
  if (row.local === 1) {
    return row.owner_uri === null ? null : localCollectionUri(row.owner_uri, row.collection_id);
  }
  return row.local === 0 ? row.collection : null;
}

// Whether an item is due at `now` (one seek of collection_items_check).
function checksDue(db: Db, now: number): boolean {
  return (
    db.first(
      `SELECT 1 AS x FROM collection_items INDEXED BY collection_items_check
				WHERE check_due_at >= 0 AND check_due_at <= ? LIMIT 1`,
      now,
    ) !== undefined
  );
}

// The UTC day of `now`, a day number of the Store's clock.
export function dayOf(now: number): number {
  return Math.floor(now / DAY_MS);
}

// Ends an item's check: unqueued, unclaimed.
function endCheck(db: Db, id: string): void {
  db.run(
    `UPDATE collection_items INDEXED BY ${COLLECTION_ITEMS_ID_INDEX} SET check_due_at = NULL, check_token = NULL
		WHERE id = ?`,
    id,
  );
}

// The claims of a round (see the module's header): at most ITEM_CHECKS_PER_ROUND, and whether another item is due now.
// A queued item this release does not check (a local member's, #1589's PR 6; one without its collection, its member's
// account or its candidate, which only an import writes) ends its check without a fetch.
export const claimItemChecks = writeOperation<{ now: number }, { checks: ItemCheck[]; pending: boolean }>(
  (db, { now }) => {
    const today = dayOf(now);
    const checks: ItemCheck[] = [];
    for (const row of db.all<Candidate>(DUE, now, ITEM_CHECK_CANDIDATES)) {
      if (checks.length >= ITEM_CHECKS_PER_ROUND) {
        break;
      }
      const collection = checkedCollection(row);
      if (
        row.owner === null ||
        collection === null ||
        row.member === null ||
        row.member_local !== 0 ||
        row.candidate === null ||
        row.attempts >= COLLECTION_CHECK_ATTEMPTS
      ) {
        endCheck(db, row.id);
        continue;
      }
      // The owner's claims on the day of the quota row (a row of a later day, from a clock that went back or an import,
      // counts as today's, so no clock makes room for more).
      const quota = db.first<{ day: number; used: number }>(
        "SELECT day, used FROM collection_check_quotas WHERE account_id = ?",
        row.owner,
      );
      const day = Math.max(today, quota?.day ?? today);
      const used = quota !== undefined && quota.day >= today ? quota.used : 0;
      if (used >= OWNER_CHECKS_PER_DAY) {
        db.run(
          `UPDATE collection_items INDEXED BY ${COLLECTION_ITEMS_ID_INDEX} SET check_due_at = ?2, check_token = NULL
					WHERE id = ?1`,
          row.id,
          (day + 1) * DAY_MS,
        );
        continue;
      }
      const token = crypto.randomUUID();
      db.run(
        `UPDATE collection_items INDEXED BY ${COLLECTION_ITEMS_ID_INDEX}
					SET check_token = ?2, check_due_at = ?3, check_attempts = check_attempts + 1
				WHERE id = ?1`,
        row.id,
        token,
        now + CHECK_LEASE_MS,
      );
      db.run(
        `INSERT INTO collection_check_quotas (account_id, day, used) VALUES (?1, ?2, 1)
				ON CONFLICT (account_id) DO UPDATE SET used = CASE WHEN day >= excluded.day THEN used + 1 ELSE 1 END,
					day = max(day, excluded.day)`,
        row.owner,
        today,
      );
      checks.push({
        item: row.id,
        token,
        authorization: row.candidate,
        collection,
        member: row.member,
      });
    }
    return { checks, pending: checksDue(db, now) };
  },
);

// The outcome of one claimed check, by its item and token.
export type ItemCheckResult = { item: string; token: string; outcome: ItemCheckOutcome };

// The item of a completion while its claim holds it: pending, with the claim's token. ?1 the item, ?2 the token.
const CLAIMED = `WHERE id = ?1 AND check_token = ?2 AND state = ${COLLECTION_ITEM_STATES.pending}`;

// A round's outcomes (see the module's header), each applied only under its claim's token to a pending item; a local
// collection's item that matches has its Add sent, and one whose authorization is gone is revoked. Returns whether an
// item is due now.
export const completeItemChecks = writeOperation<{ now: number; results: ItemCheckResult[] }, boolean>(
  (db, { now, results }) => {
    const at = new Date(now).toISOString();
    for (const { item, token, outcome } of results) {
      const row = db.first<{
        account_id: string | null;
        candidate: string | null;
        attempts: number;
        collection: string;
        local: number | null;
        retracted: number;
      }>(
        `SELECT account_id, candidate_approval_uri AS candidate, check_attempts AS attempts, collection_id AS collection,
					(SELECT local FROM collections c INDEXED BY ${COLLECTIONS_ID_INDEX} WHERE c.id = collection_id) AS local,
					EXISTS (SELECT 1 FROM accounts a INDEXED BY ${ACCOUNTS_ID_INDEX}
						CROSS JOIN inbound_retractions r ON r.actor_uri = a.uri AND r.target_uri = candidate_approval_uri
						WHERE a.id = account_id AND r.expires_at > ?3) AS retracted
				FROM collection_items INDEXED BY ${COLLECTION_ITEMS_ID_INDEX} ${CLAIMED}`,
        item,
        token,
        now,
      );
      if (row === undefined) {
        continue;
      }
      const local = row.local === 1;
      if (row.retracted === 1) {
        // The member retracted the candidate (retractions.ts isRetracted, read here by the member's stored uri): its
        // Delete reached Kopje without revoking this item (a bare URI, or before the owner listed it). Revoked,
        // whatever the fetch found, since a server may serve a withdrawn authorization from a cache.
        db.run(
          `UPDATE collection_items INDEXED BY ${COLLECTION_ITEMS_ID_INDEX}
						SET state = ${COLLECTION_ITEM_STATES.revoked}, check_token = NULL, check_due_at = NULL, updated_at = ?3
					${CLAIMED}`,
          item,
          token,
          at,
        );
      } else if (outcome === "transient") {
        db.run(
          `UPDATE collection_items INDEXED BY ${COLLECTION_ITEMS_ID_INDEX} SET check_token = NULL, check_due_at = ?3
					${CLAIMED}`,
          item,
          token,
          now + CHECK_BACKOFF_MS * 4 ** Math.max(row.attempts - 1, 0),
        );
      } else if (outcome === "gone") {
        db.run(
          `UPDATE collection_items INDEXED BY ${COLLECTION_ITEMS_ID_INDEX}
						SET state = ?4, check_token = NULL, check_due_at = NULL, updated_at = ?3
					${CLAIMED}`,
          item,
          token,
          at,
          local ? COLLECTION_ITEM_STATES.revoked : COLLECTION_ITEM_STATES.rejected,
        );
      } else if (
        outcome === "match" &&
        row.account_id !== null &&
        row.candidate !== null &&
        db.first(
          `SELECT 1 AS x FROM collection_items INDEXED BY collection_items_approval
						WHERE account_id = ?1 AND approval_uri = ?2 AND id <> ?3`,
          row.account_id,
          row.candidate,
          item,
        ) === undefined
      ) {
        db.run(
          `UPDATE collection_items INDEXED BY ${COLLECTION_ITEMS_ID_INDEX}
						SET state = ${COLLECTION_ITEM_STATES.accepted}, approval_uri = candidate_approval_uri, check_token = NULL,
							check_due_at = NULL, updated_at = ?3
					${CLAIMED}`,
          item,
          token,
          at,
        );
        if (local) {
          recordItemAdd(db, { id: item, collection: row.collection }, now);
        }
      } else {
        db.run(
          `UPDATE collection_items INDEXED BY ${COLLECTION_ITEMS_ID_INDEX} SET check_token = NULL, check_due_at = NULL
					${CLAIMED}`,
          item,
          token,
        );
      }
    }
    return checksDue(db, now);
  },
);
