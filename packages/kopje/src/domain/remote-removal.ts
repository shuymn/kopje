import type { Db } from "../db/sql";
import { deleteCard } from "./link-cards";
import { retireQuoteOf } from "./quotes";
import { streamDelete } from "./streaming";

// The start of a remote status's removal (RES-6, VIS-1), for its author's Delete after the retractions it records
// (inbox.ts deleteObject) and for a 404 at its own URI to a pin sync's fetch, which records none (remote-collections.ts
// removeGone): its delete job, the streamed delete, the hide and the end of its quote, each outside the batch's
// budget, after which the job's batches remove the rest (inbox.ts runJobBatch). The caller decides whether a batch
// runs in its own transaction.

// The hide of a remote status whose removal runs (VIS-1): it writes the status, the account's last status, which the
// trigger of migration 0021_directory moves back, and deletes the status's card (link-cards.ts: a direct status holds
// none), and the copy of withdrawn on its own quote row when that row is marked local (migration 0091_live_local_quotes;
// only an import marks a remote status's quote so), so four rows at most, and nothing once done. It also marks the
// status withdrawn, which refuses a local unboost of it (statuses.ts unboostableId) and skips its recounts
// (deleteStatusWithin).
export const HIDE_ROWS = 4;
export function hideRemoteStatus(db: Db, statusId: string): void {
  db.run(
    `UPDATE statuses SET withdrawn = 1, visibility = 'direct', content = '', spoiler_text = '', search_text = NULL,
			filter_text_units = NULL
		WHERE id = ? AND (withdrawn = 0 OR visibility <> 'direct' OR content <> '' OR spoiler_text <> ''
			OR search_text IS NOT NULL)`,
    statusId,
  );
  deleteCard(db, statusId);
}

// The removal of the remote original `statusId` begins, its job naming `actorUri`. Whether this call created the job:
// a status whose removal runs already gets no second job, streamed delete or hide.
export function startRemoval(db: Db, statusId: string, actorUri: string, now: number): boolean {
  // R32: the streaming delete is captured when the job is created, before the first batch removes its mentions; the
  // job row is the marker, so a Delete delivered again (or the later batches) captures nothing more. It writes outside
  // the batch's budget, which deleteStatusBatch starts after it.
  const created = db.first(
    `INSERT INTO inbound_jobs (kind, key, actor_uri, created_at) VALUES ('delete', ?, ?, ?) ON CONFLICT DO NOTHING
		RETURNING key`,
    statusId,
    actorUri,
    now,
  );
  // The hide follows the capture (which reads the audience it ends), before any batch removes a mention (VIS-1), also
  // outside the batch's budget: from here no one sees the status, no local account may boost it (it is direct) or
  // unboost it (removalBegunSql), so its kept local boosts are fixed in this transaction.
  if (created !== undefined) {
    streamDelete(db, statusId, now);
    hideRemoteStatus(db, statusId);
  }
  // Its accepted quote ends now, before any batch, outside the batch's budget (one quote row, its target's count and
  // the revocation of Kopje's authorization if it holds one): neither the quotes list nor the count of its target
  // shows it (VIS-27), and no stamp is served (VIS-28), while the removal runs.
  retireQuoteOf(db, statusId, now);
  return created !== undefined;
}
