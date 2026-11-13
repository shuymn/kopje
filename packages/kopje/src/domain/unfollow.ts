import type { Db } from "../db/sql";
import { followUri, recordOutbound, undoFollowActivity } from "./activities";
import { END_FOLLOW_NOTIFICATIONS_SQL } from "./notifications";

export type EndedFollow = { id: string; uri: string | null; state: string };

// Ends a local account's follow of a remote account in either state, with its follow notifications, and records its
// Undo there (Mastodon's UnfollowService). A migrated edge without a uri is named as this instance would have named it
// (a remote server matches an Undo by actor and object as well). Returns the removed edge, undefined without one; the
// caller keeps the local counts, by its own strategy.
export function unfollowRemote(
  db: Db,
  follower: { id: string; uri: string },
  target: { id: string; uri: string },
  now: number,
): EndedFollow | undefined {
  const edge = db.first<EndedFollow>(
    `DELETE FROM follows WHERE account_id = ? AND target_account_id = ?
		RETURNING CAST(id AS TEXT) AS id, uri, state`,
    follower.id,
    target.id,
  );
  if (edge === undefined) {
    return undefined;
  }
  db.run(END_FOLLOW_NOTIFICATIONS_SQL, target.id, follower.id);
  recordOutbound(
    db,
    follower.id,
    undoFollowActivity({
      followUri: edge.uri ?? followUri(follower.uri, edge.id),
      actorUri: follower.uri,
      targetUri: target.uri,
      targetId: target.id,
    }),
    now,
  );
  return edge;
}
