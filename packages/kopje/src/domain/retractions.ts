import type { Db } from "../db/sql";
import { sameOrigin } from "../platform/http-url";

// The tombstone store (ID-7): the ids each actor retracted and the objects stored and then deleted
// (inbound_retractions). The sweep (inbox.ts) removes expired ones.

// A retraction (Undo or Delete) is kept this long; an activity it names that arrives later is ignored (ID-7).
export const RETRACTION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// At most this many live retractions per actor (RES-4): a remote can name any number of ids of its own origin. An
// actor's own deletion does not depend on it (inbound_jobs).
export const MAX_RETRACTIONS_PER_ACTOR = 10_000;

export function isRetracted(db: Db, actorUri: string, targetUri: string, now: number): boolean {
  return (
    db.first(
      "SELECT 1 AS x FROM inbound_retractions WHERE actor_uri = ? AND target_uri = ? AND expires_at > ?",
      actorUri,
      targetUri,
      now,
    ) !== undefined
  );
}

// The actor_uri of a deletion that holds for every actor: a status or boost that was stored and deleted by its author
// is not created again under that uri by anyone, its author or another actor of the same origin (ID-6, ID-7). A Delete
// of an unknown object stays the actor's own (it cannot suppress another actor's objects never seen here).
export const ANY_ACTOR = "*";

// Whether `uri` may not be created by `actorUri`: the actor retracted it, or it was stored and deleted.
export function isDeleted(db: Db, actorUri: string, uri: string, now: number): boolean {
  return isRetracted(db, actorUri, uri, now) || isRetracted(db, ANY_ACTOR, uri, now);
}

// Records that the stored object `uri` was deleted. Bounded by the authors' caps: it is written only together with
// the author's own retraction of the same uri, which counts against MAX_RETRACTIONS_PER_ACTOR, and expires and is
// swept with it.
export function recordDeletedObject(db: Db, uri: string, now: number): void {
  db.run(
    `INSERT INTO inbound_retractions (actor_uri, target_uri, expires_at) VALUES (?, ?, ?)
		ON CONFLICT DO UPDATE SET expires_at = excluded.expires_at`,
    ANY_ACTOR,
    uri,
    now + RETRACTION_TTL_MS,
  );
}

function recordable(actorUri: string, targetUri: string): boolean {
  return sameOrigin(targetUri, actorUri);
}

// Whether every one of targetUris can be recorded as retracted by actorUri now: those not recorded yet fit under the
// cap. A change whose generation could not be recorded is not made (ID-7: it could come back).
export function canRetract(db: Db, actorUri: string, targetUris: readonly string[], now: number): boolean {
  const missing = new Set(targetUris.filter((uri) => recordable(actorUri, uri) && !isRetracted(db, actorUri, uri, now)))
    .size;
  if (missing === 0) {
    return true;
  }
  const live =
    db.first<{ n: number }>(
      "SELECT count(*) AS n FROM inbound_retractions WHERE actor_uri = ? AND expires_at > ?",
      actorUri,
      now,
    )?.n ?? 0;
  return live + missing <= MAX_RETRACTIONS_PER_ACTOR;
}

// Records that actorUri retracted targetUri, and reports whether it is recorded. Only an id of the actor's own origin
// is recorded (another origin's activity could never be the actor's to retract), and at most
// MAX_RETRACTIONS_PER_ACTOR live ones per actor.
export function retract(db: Db, actorUri: string, targetUri: string, now: number): boolean {
  if (!recordable(actorUri, targetUri) || !canRetract(db, actorUri, [targetUri], now)) {
    return false;
  }
  db.run(
    `INSERT INTO inbound_retractions (actor_uri, target_uri, expires_at) VALUES (?, ?, ?)
		ON CONFLICT DO UPDATE SET expires_at = excluded.expires_at`,
    actorUri,
    targetUri,
    now + RETRACTION_TTL_MS,
  );
  return true;
}

// Records a Follow id as retracted: the one way every path (Undo, Block, a refused or superseded Follow, a local
// reject) records a Follow generation. A Misskey pair id (`/follows/<follower>/<followee>`) names every generation of a
// follow, so it is never recorded: true without writing anything. Its limit, on every path: a pair activity delivered
// again after a new Follow cannot be told from a new one.
export function retractFollow(db: Db, actorUri: string, followUri: string, now: number): boolean {
  return isMisskeyPairId(followUri) || retract(db, actorUri, followUri, now);
}

// Misskey's Undo of a Follow names the follow by its pair (ApRendererService#renderFollow without a request id:
// <origin>/follows/<follower id>/<followee id>), not by the id of the Follow it sent.
export function isMisskeyPairId(id: string): boolean {
  try {
    return /^\/follows\/[^/]+\/[^/]+$/.test(new URL(id).pathname);
  } catch {
    return false;
  }
}
