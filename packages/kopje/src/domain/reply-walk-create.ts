import { STATUSES_URI_INDEX } from "../db/indexes";
import type { Db } from "../db/sql";
import { sameOrigin } from "../platform/http-url";
import { STATUS_URI_LIMIT, withinIdentityBound } from "../platform/identity-bounds";
import { isDistributable, type Visibility } from "./audience";
import type { RemoteRepliesInput } from "./remote-status-reads";

// The rows of the walks of replies collections (reply-walks.ts) that storing a status writes: the Create trigger,
// Mastodon 4.7.5's Create#fetch_replies (app/lib/activitypub/activity/create.rb:400-410), apart from reply-walks.ts,
// which stores through remote-statuses.ts. Mastodon hands a created status's replies to FetchRepliesService
// (fetch_replies_service.rb:7-39), which reads their first page only and fetches its first MAX_REPLIES items on the host
// of the status's account (FetchReplyWorker), each of which, created, does the same. Here the status gets a create walk
// (kind 1) that records those items as nodes, walked with a context walk's steps, charges and judgement of parents, but
// reading first pages only and within CREATE_WALK_STATUSES and CREATE_WALK_PAGES. Only the paths that store what was
// delivered or what a user asked for start one (StoreContext.readReplies, remote-statuses.ts); nothing a walk stores,
// verifies or syncs does, so no walk's caps start afresh (docs/mastodon-deviations.md, "Replies collections").

// The stages a node is pending at, by their stored number (reply_walk_nodes.stage), and its states.
export const STAGES = ["status", "collection", "page", "replies"] as const;
export type WalkStage = (typeof STAGES)[number];
export const [PENDING, DONE, DEFERRED] = [0, 1, 2];
// reply_walks.kind: a context's refresh, or a Create's walk.
export const [CONTEXT_WALK, CREATE_WALK] = [0, 1];

// Items a create walk takes of a node's first page, on the node's origin (FetchRepliesService::MAX_REPLIES).
export const CREATE_WALK_ITEMS = 5;
// Nodes a create walk records at most, the root included, and collection documents it hands out at most, fetched or
// not (Mastodon: 1,000 statuses a request, FetchRemoteStatusService::DISCOVERIES_PER_REQUEST).
export const CREATE_WALK_STATUSES = 20;
export const CREATE_WALK_PAGES = 10;
// A waiting create walk's due_at: due on any clock. The claims' seek of reply_walks_due (kind, due_at, then the rowid
// every index of a rowid table ends with) so takes the waiting create walks by rowid, which the Store assigns above
// every row present at the insert: in the order they were recorded, whatever any clock says. queued_at, the Store's
// time of the record, only ages the walk (REFRESH_RUNNING_MS).
export const CREATE_WALK_WAITING = 0;

// A URI a walk may record or fetch: an http(s) URI within STATUS_URI_LIMIT (UTF-8 bytes as JSON writes it, which
// bounds the raw bytes the columns' CHECKs hold to 4096), without NUL.
export function walkUri(value: string): boolean {
  if (!withinIdentityBound(value, STATUS_URI_LIMIT) || value.includes("\0")) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

// The items a create walk records of a node's first page: of its entries, the first CREATE_WALK_ITEMS ids a walk may
// record on the node's origin (FetchRepliesService#filter_replies: any other origin, this instance's included, is
// passed), less the statuses Kopje stores (one key read each). Each once, in order.
export function createItems(db: Db, entries: readonly (string | null)[], nodeUri: string): string[] {
  const taken = entries
    .filter((uri): uri is string => uri !== null && walkUri(uri) && sameOrigin(uri, nodeUri))
    .slice(0, CREATE_WALK_ITEMS);
  return [...new Set(taken)].filter(
    (uri) => db.first(`SELECT 1 AS x FROM statuses INDEXED BY ${STATUSES_URI_INDEX} WHERE uri = ?`, uri) === undefined,
  );
}

// The create walk of a remote status a store just created, recorded in its transaction when there is work: a public or
// unlisted status (a walk's root, reply-walk-reads.ts walkRoot) whose embedded first page lists items createItems
// keeps (its node done, each item pending at its status), or whose replies collection or first page is a URI on its
// origin (its node pending at that stage, read in a step). Queued at the Store's time `storeNow` and waiting
// (CREATE_WALK_WAITING), behind the create walks recorded before it. Writes one walk row and at most 1 +
// CREATE_WALK_ITEMS nodes.
export function recordCreateWalk(
  db: Db,
  status: { id: string; uri: string; visibility: Visibility },
  replies: RemoteRepliesInput | null | undefined,
  storeNow: number,
): void {
  if (replies === null || replies === undefined || !isDistributable(status.visibility)) {
    return;
  }
  const items = "items" in replies ? createItems(db, replies.items, status.uri) : [];
  if ("items" in replies ? items.length === 0 : !walkUri(replies.uri) || !sameOrigin(replies.uri, status.uri)) {
    return;
  }
  const recorded = db.run(
    `INSERT INTO reply_walks (status_id, kind, queued_at, due_at, next_seq, nodes)
		VALUES (?1, ${CREATE_WALK}, ?2, ${CREATE_WALK_WAITING}, ?3, ?3) ON CONFLICT DO NOTHING`,
    status.id,
    storeNow,
    1 + items.length,
  );
  if (recorded === 0) {
    return;
  }
  if ("items" in replies) {
    db.run(
      `INSERT INTO reply_walk_nodes (status_id, uri, seq, state, valid) VALUES (?, ?, 0, ${DONE}, 1)`,
      status.id,
      status.uri,
    );
    items.forEach((uri, i) =>
      db.run("INSERT INTO reply_walk_nodes (status_id, uri, seq) VALUES (?, ?, ?)", status.id, uri, i + 1),
    );
    return;
  }
  db.run(
    "INSERT INTO reply_walk_nodes (status_id, uri, seq, stage, valid, fetch) VALUES (?, ?, 0, ?, 1, ?)",
    status.id,
    status.uri,
    STAGES.indexOf(replies.stage),
    replies.uri,
  );
}

// Whether a create walk is due at the Store's time `storeNow`: a store that recorded one asks the Queue for a jobs round
// (inbox.ts), as for quotes.
export function createWalkDue(db: Db, storeNow: number): boolean {
  return (
    db.first(
      `SELECT 1 AS x FROM reply_walks INDEXED BY reply_walks_due WHERE kind = ${CREATE_WALK} AND due_at <= ? LIMIT 1`,
      storeNow,
    ) !== undefined
  );
}
