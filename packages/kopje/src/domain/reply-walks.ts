import { REPLY_WALKS_ID_INDEX, STATUSES_ID_INDEX, STATUSES_URI_INDEX } from "../db/indexes";
import type { Db } from "../db/sql";
import { sameOrigin } from "../platform/http-url";
import { STATUS_URI_LIMIT, withinIdentityBound } from "../platform/identity-bounds";
import { iso } from "../platform/iso-time";
import { isoTimeSql } from "../platform/stored-bounds";
import { userWriteOperation } from "./auth";
import { fetchedAuthor, type Prefetched } from "./inbox";
import { writeOperation } from "./operation";
import { QUOTE_HOPS } from "./quotes";
import { type DocumentRevision, isDeletedActor, type RemoteActorInput } from "./remote-actors";
import type { RemoteStatusInput } from "./remote-status-reads";
import { storeRemoteStatus } from "./remote-statuses";
import {
  recentlyRefreshed,
  REFRESH_FINISHED_MS,
  REFRESH_RUNNING_MS,
  type Refresh,
  refreshesFull,
  REPLIES_COOLDOWN_MS,
  REPLIES_INITIAL_WAIT_MS,
  runningRefresh,
  walkRoot,
} from "./reply-walk-reads";
import { viewable } from "./statuses";

// Walks of remote replies collections (Mastodon 4.7.5's ActivityPub::FetchAllRepliesWorker and
// FetchAllRepliesService, which a context read starts: reply-walk-reads.ts), in the rows of migration
// 0099_reply_walks: a walk per root status, and its nodes, the statuses it found by URI. Only the Worker's job rounds
// run them (federation/replies.ts), one document a step, each fetched through the safe loader signed by the instance
// actor within a whole fetch budget of its own (DATA-7, RES-6); every decision is here, in the step's transaction.
//
// A node is pending at a stage: its status (fetched by its URI), its replies collection (the collection document, to
// take its first page), or a page of it (its items and next). Nodes run breadth first in seq order; a node keeps its
// place while its collection is read, one that fails transiently goes to the end. The Store hands a node to the Worker
// (at the claim, or as a completion's next) only by charging it in the same transaction: one of its NODE_ATTEMPTS for
// the document it reads, and at the collection and page stages one of the walk's WALK_PAGES. A charge stays whatever
// the step's outcome, a lost lease or a round that died included, so a walk takes at most
// NODE_ATTEMPTS × WALK_STATUSES + WALK_PAGES steps however its rounds end, with no counter of claims. A completion
// hands out a next node only when the Worker says it will fetch it (`more`); the round's last hands out nothing.
//
// Only statuses linked to the root are stored (ID-2): a node is valid once its parent is a valid node of the same walk
// and its stored row links to that node's status (in_reply_to_id, the link the context follows). The root is valid
// from the start. A new status's parent is its fetched inReplyTo, checked before anything of it is stored; a stored
// one's is its stored row's (in_reply_to_id, else in_reply_to_uri), and it is not updated (Mastodon updates it,
// deletes it on 404 and refetches replies the collection no longer lists: docs/mastodon-deviations.md, "Replies
// collections"). A node whose parent is a node not valid yet is deferred on it, and returns to the end of the walk
// (fetched again, while it has an attempt left) when that node becomes valid; one whose parent is no node, or a node
// that ended without becoming valid, ends. A walk ends when no node is pending; deferred nodes are then dropped. A new
// status goes through the boosted original's author step (inbox.ts fetchedAuthor) and storeRemoteStatus as a fetched
// status, its quote one hop short of a root's (QUOTE_HOPS - 1): its quoted status is stored with none, and nothing a
// walk stores starts another walk. Collection items are ids only: an embedded object is never taken as a status.

// Nodes a walk records at most, the root included; an item past it is not recorded (docs/mastodon-deviations.md:
// Mastodon's FetchAllRepliesWorker takes 1,000).
export const WALK_STATUSES = 200;
// Collection documents a walk hands out at most, fetched or not (Mastodon: 500 pages); past it, nodes still pending
// at those stages end.
export const WALK_PAGES = 100;
// Hand-outs of one document of a node at most (its status, its collection, each page), a fetch after a deferral
// included: the first and one retry (FetchReplyWorker's retry).
export const NODE_ATTEMPTS = 2;
// How long a claim holds a walk from other rounds: at least twice a round's steps of it (federation/replies.ts checks
// it as it loads).
export const REPLY_WALK_LEASE_MS = 10 * 60 * 1000;
// Finished walks a claim deletes at most, past REFRESH_FINISHED_MS.
export const WALK_PRUNE_BATCH = 100;
// Walks a claim drops at most before it answers 'more' (a root gone or no longer a walk root, a walk running past
// REFRESH_RUNNING_MS, one with nothing left to hand out), as claimCollectionSync drops syncs.
export const REPLY_CLAIM_DROPS = 3;

const STAGES = ["status", "collection", "page"] as const;
type WalkStage = (typeof STAGES)[number];
const [PENDING, DONE, DEFERRED] = [0, 1, 2];

// A node handed out: its URI, its stage and the document the step fetches (the URI itself at the status stage).
export type ReplyStep = { uri: string; stage: WalkStage; fetch: string };

// A walk a round claimed: the claim's token, which every completion hands back, and its first node, charged. pending:
// another walk is due.
export type ClaimedWalk = { statusId: string; token: string; step: ReplyStep; pending: boolean };

// What one document of a replies collection gave, read by the Worker from a status's replies, a collection or a page
// (embedded pages read through without a step): the ids of its items, at most WALK_STATUSES, and the next document to
// fetch, if any.
export type RepliesRead = { items: string[]; next: { stage: "collection" | "page"; uri: string } | null };

// A step's fetch: the node's status with its replies (null when it names none Kopje reads), a collection document's
// or a page's reading, a failure that may pass, or any other failure (gone, refused, unusable, another origin).
export type StepFetched =
  | { kind: "status"; status: RemoteStatusInput; replies: RepliesRead | null }
  | { kind: "replies"; replies: RepliesRead }
  | { kind: "transient" }
  | { kind: "failed" };

// author: the document of the author a need asked for (inbox.ts Prefetched's actors), with the revision the need read.
export type ReplyStepInput = {
  now: number;
  origin: string;
  statusId: string;
  token: string;
  step: ReplyStep;
  more: boolean;
  fetched: StepFetched;
  author?: { uri: string; document: RemoteActorInput | null | "gone"; revision?: DocumentRevision };
};

// need: the step is not applied yet, and the Store needs the status's author (unknown, or stale: refresh, with the
// revision read here). next: the node handed out, charged. done: the walk is over for this claim (finished, or the
// claim lost).
export type AuthorNeed = { uri: string; refresh: boolean; revision?: DocumentRevision };
export type ReplyStepAnswer = { next: ReplyStep | null; need: AuthorNeed | null; done: boolean };

// The walk's counters, changed in memory by a step and written once (saveWalk).
type Walk = { id: string; nextSeq: number; nodes: number; pages: number; resultCount: number };

type Node = {
  uri: string;
  state: number;
  stage: number;
  valid: number;
  fetch: string | null;
  attempts: number;
};

function walkOf(db: Db, statusId: string, token: string): Walk | undefined {
  const row = db.first<{ next_seq: number; nodes: number; pages: number; result_count: number }>(
    `SELECT next_seq, nodes, pages, result_count FROM reply_walks
			WHERE status_id = ? AND token = ? AND due_at IS NOT NULL`,
    statusId,
    token,
  );
  return row === undefined
    ? undefined
    : { id: statusId, nextSeq: row.next_seq, nodes: row.nodes, pages: row.pages, resultCount: row.result_count };
}

function saveWalk(db: Db, walk: Walk): void {
  db.run(
    "UPDATE reply_walks SET next_seq = ?2, nodes = ?3, pages = ?4, result_count = ?5 WHERE status_id = ?1",
    walk.id,
    walk.nextSeq,
    walk.nodes,
    walk.pages,
    walk.resultCount,
  );
}

function nodeOf(db: Db, walkId: string, uri: string): Node | undefined {
  return db.first<Node>(
    "SELECT uri, state, stage, valid, fetch, attempts FROM reply_walk_nodes WHERE status_id = ? AND uri = ?",
    walkId,
    uri,
  );
}

function endNode(db: Db, walkId: string, uri: string): void {
  db.run(`UPDATE reply_walk_nodes SET state = ${DONE}, parent = NULL WHERE status_id = ? AND uri = ?`, walkId, uri);
}

function hasPending(db: Db, walkId: string): boolean {
  return (
    db.first(
      `SELECT 1 AS x FROM reply_walk_nodes INDEXED BY reply_walk_nodes_pending
				WHERE status_id = ? AND state = ${PENDING} LIMIT 1`,
      walkId,
    ) !== undefined
  );
}

// A walk's end: its nodes go (deferred ones dropped), and its row is kept finished, with its refresh, for
// REFRESH_FINISHED_MS (the claims' prune).
function finish(db: Db, walkId: string, now: number): void {
  db.run("DELETE FROM reply_walk_nodes WHERE status_id = ?", walkId);
  db.run("UPDATE reply_walks SET due_at = NULL, finished_at = ?2, token = NULL WHERE status_id = ?1", walkId, now);
}

// The next pending node, charged: an attempt, and a page at the collection and page stages. A node with no attempt
// left, or at those stages once WALK_PAGES are spent, is ended without a fetch, and the next is taken: each turn of the
// loop ends a pending node, so it reads at most WALK_STATUSES of them. null: none is pending.
function handOut(db: Db, walk: Walk): ReplyStep | null {
  for (;;) {
    const node = db.first<{ uri: string; stage: number; fetch: string | null; attempts: number }>(
      `SELECT uri, stage, fetch, attempts FROM reply_walk_nodes INDEXED BY reply_walk_nodes_pending
				WHERE status_id = ? AND state = ${PENDING} ORDER BY seq LIMIT 1`,
      walk.id,
    );
    if (node === undefined) {
      return null;
    }
    const page = node.stage !== 0;
    if (node.attempts >= NODE_ATTEMPTS || (page && walk.pages >= WALK_PAGES)) {
      endNode(db, walk.id, node.uri);
      continue;
    }
    db.run("UPDATE reply_walk_nodes SET attempts = attempts + 1 WHERE status_id = ? AND uri = ?", walk.id, node.uri);
    if (page) {
      walk.pages += 1;
    }
    return { uri: node.uri, stage: STAGES[node.stage]!, fetch: node.fetch ?? node.uri };
  }
}

// A URI a walk may record or fetch: an http(s) URI within STATUS_URI_LIMIT (UTF-8 bytes as JSON writes it, which
// bounds the raw bytes the columns' CHECKs hold to 4096), without NUL.
function walkUri(value: string): boolean {
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

// Whether a stored status listed as an item is skipped, as FetchAllRepliesService skips should_not_fetch_replies: one
// published within REPLIES_INITIAL_WAIT_MS (or whose time is not a stored one), or the root of a refresh running or
// started within REPLIES_COOLDOWN_MS. One key read of the status, one of its walk.
function skipped(db: Db, uri: string, now: number): boolean {
  return (
    db.first(
      `SELECT 1 AS x FROM statuses s INDEXED BY ${STATUSES_URI_INDEX}
				LEFT JOIN reply_walks w INDEXED BY ${REPLY_WALKS_ID_INDEX} ON w.status_id = s.id AND w.kind = 0
			WHERE s.uri = ?1 AND (COALESCE(${isoTimeSql("s.published_at")} > ?2, 1)
				OR (w.status_id IS NOT NULL AND ((w.finished_at IS NULL AND w.queued_at > ?3) OR w.queued_at > ?4)))`,
      uri,
      iso(now - REPLIES_INITIAL_WAIT_MS),
      now - REFRESH_RUNNING_MS,
      now - REPLIES_COOLDOWN_MS,
    ) !== undefined
  );
}

// A page's items recorded as pending nodes, in order, while the walk holds fewer than WALK_STATUSES: each a URI a walk
// may fetch, not of this instance's origin, not a node of the walk already, and not a stored status skipped.
// Items of any other origin are taken (FetchAllRepliesService does not filter them by host).
function recordItems(db: Db, walk: Walk, items: readonly string[], input: ReplyStepInput): void {
  for (const uri of items) {
    if (walk.nodes >= WALK_STATUSES) {
      return;
    }
    if (!walkUri(uri) || sameOrigin(uri, input.origin) || skipped(db, uri, input.now)) {
      continue;
    }
    const inserted = db.run(
      "INSERT INTO reply_walk_nodes (status_id, uri, seq) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
      walk.id,
      uri,
      walk.nextSeq,
    );
    if (inserted > 0) {
      walk.nextSeq += 1;
      walk.nodes += 1;
    }
  }
}

// A valid node's replies: its items recorded, and its next document (on the node's own origin, Mastodon's
// non_matching_uri_hosts? refusal) read in a later step at the same place; with none, the node is done.
function readReplies(db: Db, walk: Walk, node: Node, replies: RepliesRead | null, input: ReplyStepInput): void {
  if (replies !== null) {
    recordItems(db, walk, replies.items, input);
  }
  const next = replies?.next ?? null;
  if (next === null || !walkUri(next.uri) || !sameOrigin(next.uri, node.uri)) {
    endNode(db, walk.id, node.uri);
    return;
  }
  db.run(
    "UPDATE reply_walk_nodes SET stage = ?3, fetch = ?4, attempts = 0 WHERE status_id = ?1 AND uri = ?2",
    walk.id,
    node.uri,
    STAGES.indexOf(next.stage),
    next.uri,
  );
}

// A node becomes valid: the nodes deferred on it go back to the end of the walk, in their order (each fetched again
// while it has an attempt left), and its replies are read.
function validate(db: Db, walk: Walk, node: Node, replies: RepliesRead | null, input: ReplyStepInput): void {
  db.run("UPDATE reply_walk_nodes SET valid = 1 WHERE status_id = ? AND uri = ?", walk.id, node.uri);
  const deferred = db.all<{ uri: string; seq: number }>(
    "SELECT uri, seq FROM reply_walk_nodes INDEXED BY reply_walk_nodes_parent WHERE status_id = ? AND parent = ?",
    walk.id,
    node.uri,
  );
  for (const row of deferred.toSorted((a, b) => a.seq - b.seq)) {
    db.run(
      `UPDATE reply_walk_nodes SET state = ${PENDING}, parent = NULL, seq = ?3 WHERE status_id = ?1 AND uri = ?2`,
      walk.id,
      row.uri,
      walk.nextSeq,
    );
    walk.nextSeq += 1;
  }
  readReplies(db, walk, node, replies, input);
}

// A stored status's place in the thread, as its row keeps it: its id, the status its in_reply_to_id links (null while
// unlinked), and the URI of its parent (that status's, else in_reply_to_uri). Two key reads.
function storedPlace(db: Db, uri: string): { id: string; linked: string | null; parent: string | null } | undefined {
  return db.first<{ id: string; linked: string | null; parent: string | null }>(
    `SELECT s.id, s.in_reply_to_id AS linked, COALESCE(p.uri, s.in_reply_to_uri) AS parent
			FROM statuses s INDEXED BY ${STATUSES_URI_INDEX}
				LEFT JOIN statuses p INDEXED BY ${STATUSES_ID_INDEX} ON p.id = s.in_reply_to_id
			WHERE s.uri = ?`,
    uri,
  );
}

function statusIdOf(db: Db, uri: string): string | undefined {
  return db.first<{ id: string }>(`SELECT id FROM statuses INDEXED BY ${STATUSES_URI_INDEX} WHERE uri = ?`, uri)?.id;
}

function linkedTo(db: Db, statusId: string, parentId: string): boolean {
  return (
    db.first(
      `SELECT 1 AS x FROM statuses INDEXED BY ${STATUSES_ID_INDEX} WHERE id = ? AND in_reply_to_id = ?`,
      statusId,
      parentId,
    ) !== undefined
  );
}

// The status step of a node that is not valid yet: its parent judged, then, for a new status under a valid parent,
// its author and the status stored. Returns the author the Store needs first, or null once the step is applied.
function judge(
  db: Db,
  walk: Walk,
  node: Node,
  fetched: Extract<StepFetched, { kind: "status" }>,
  input: ReplyStepInput,
): AuthorNeed | null {
  const status = fetched.status;
  const stored = storedPlace(db, node.uri);
  const parentUri = stored === undefined ? status.inReplyTo : stored.parent;
  const parent = parentUri === null ? undefined : nodeOf(db, walk.id, parentUri);
  if (parent === undefined || (parent.state === DONE && parent.valid === 0)) {
    endNode(db, walk.id, node.uri);
    return null;
  }
  if (parent.valid === 0) {
    db.run(
      `UPDATE reply_walk_nodes SET state = ${DEFERRED}, parent = ?3 WHERE status_id = ?1 AND uri = ?2`,
      walk.id,
      node.uri,
      parent.uri,
    );
    return null;
  }
  const parentId = statusIdOf(db, parent.uri);
  if (stored !== undefined) {
    // A stored status still unlinked is out of the context's reach, as is one linked elsewhere.
    if (parentId === undefined || stored.linked !== parentId) {
      endNode(db, walk.id, node.uri);
    } else {
      validate(db, walk, node, fetched.replies, input);
    }
    return null;
  }
  const authorUri = status.attributedTo;
  // Nothing new of an author whose deletion has started is stored (ID-7), nor of one off the status's origin (ID-6).
  if (authorUri === null || !sameOrigin(authorUri, status.uri) || isDeletedActor(db, authorUri, input.now)) {
    endNode(db, walk.id, node.uri);
    return null;
  }
  const author = input.author?.uri === authorUri ? input.author : undefined;
  const prefetched: Prefetched | undefined =
    author === undefined
      ? undefined
      : {
          statuses: {},
          actors: { [authorUri]: author.document },
          revisions: author.revision === undefined ? {} : { [authorUri]: author.revision },
        };
  const found = fetchedAuthor(db, authorUri, prefetched, input.origin, input.now);
  if ("reason" in found) {
    if (found.need !== undefined) {
      const { uri, refresh, revision } = found.need;
      return { uri, refresh: refresh === true, ...(revision === undefined ? {} : { revision }) };
    }
    endNode(db, walk.id, node.uri);
    return null;
  }
  const stores = found.store();
  if (stores === undefined) {
    endNode(db, walk.id, node.uri);
    return null;
  }
  // As any fetched status (StoreContext.fetched): no relation to a local account needed, its mentions and its author's
  // subscribers notified only within the real-time window; its quote one hop short of a root's.
  const outcome = storeRemoteStatus(db, stores, status, {
    now: input.now,
    origin: input.origin,
    deliveredTo: null,
    fetched: true,
    quoteHops: QUOTE_HOPS - 1,
  });
  if (outcome.reason === "created") {
    walk.resultCount += 1;
  }
  if (outcome.statusId === undefined || parentId === undefined || !linkedTo(db, outcome.statusId, parentId)) {
    endNode(db, walk.id, node.uri);
  } else {
    validate(db, walk, node, fetched.replies, input);
  }
  return null;
}

// Applies a step's fetch to its node. Returns the author the Store needs first, or null once applied.
function applyStep(db: Db, walk: Walk, node: Node, input: ReplyStepInput): AuthorNeed | null {
  const { fetched } = input;
  if (fetched.kind === "transient") {
    // Tried again at the end of the walk, while it has an attempt left.
    if (node.attempts >= NODE_ATTEMPTS) {
      endNode(db, walk.id, node.uri);
    } else {
      db.run("UPDATE reply_walk_nodes SET seq = ?3 WHERE status_id = ?1 AND uri = ?2", walk.id, node.uri, walk.nextSeq);
      walk.nextSeq += 1;
    }
    return null;
  }
  if (fetched.kind === "failed" || (fetched.kind === "replies") !== (node.stage !== 0)) {
    endNode(db, walk.id, node.uri);
    return null;
  }
  if (fetched.kind === "replies") {
    readReplies(db, walk, node, fetched.replies, input);
    return null;
  }
  if (fetched.status.uri !== node.uri) {
    endNode(db, walk.id, node.uri);
    return null;
  }
  // The root: stored, read for its replies only.
  if (node.valid === 1) {
    readReplies(db, walk, node, fetched.replies, input);
    return null;
  }
  return judge(db, walk, node, fetched, input);
}

// ---- Operations: claims, steps and releases of the Worker's rounds (federation/replies.ts)

function dueWalk(db: Db, now: number): { status_id: string; queued_at: number } | undefined {
  return db.first<{ status_id: string; queued_at: number }>(
    `SELECT status_id, queued_at FROM reply_walks INDEXED BY reply_walks_due WHERE kind = 0 AND due_at <= ?
			ORDER BY due_at LIMIT 1`,
    now,
  );
}

// The context walk due first, claimed for REPLY_WALK_LEASE_MS with its next node handed out. First the finished walks
// past REFRESH_FINISHED_MS are pruned (WALK_PRUNE_BATCH at most). A walk running REFRESH_RUNNING_MS after its latest
// start is deleted, one whose root is gone or no longer a walk root is finished, and one with no node left to hand out
// is finished; then the next due is taken, at most REPLY_CLAIM_DROPS + 1 in all. 'more': that many were dropped and
// another is due; null: none is due.
export const claimReplyWalk = writeOperation.atStoreTime("now")<{ now: number }, ClaimedWalk | "more" | null>((
  db,
  { now },
) => {
  db.run(
    `DELETE FROM reply_walks INDEXED BY ${REPLY_WALKS_ID_INDEX} WHERE status_id IN (SELECT status_id
				FROM reply_walks INDEXED BY reply_walks_finished WHERE finished_at <= ? LIMIT ?)`,
    now - REFRESH_FINISHED_MS,
    WALK_PRUNE_BATCH,
  );
  for (let drop = 0; drop <= REPLY_CLAIM_DROPS; drop++) {
    const row = dueWalk(db, now);
    if (row === undefined) {
      return null;
    }
    const id = row.status_id;
    if (row.queued_at <= now - REFRESH_RUNNING_MS) {
      db.run("DELETE FROM reply_walk_nodes WHERE status_id = ?", id);
      db.run("DELETE FROM reply_walks WHERE status_id = ?", id);
      continue;
    }
    if (walkRoot(db, id, now) === undefined) {
      finish(db, id, now);
      continue;
    }
    const token = crypto.randomUUID();
    db.run("UPDATE reply_walks SET token = ?2, due_at = ?3 WHERE status_id = ?1", id, token, now + REPLY_WALK_LEASE_MS);
    const walk = walkOf(db, id, token)!;
    const step = handOut(db, walk);
    saveWalk(db, walk);
    if (step === null) {
      finish(db, id, now);
      continue;
    }
    return { statusId: id, token, step, pending: dueWalk(db, now) !== undefined };
  }
  return dueWalk(db, now) === undefined ? null : "more";
});

// Applies what the Worker fetched for a node handed out under the claim `token`, in one transaction, and hands out the
// next node when `more` says the Worker will fetch it. A completion of a claim that is no longer the walk's, or of a
// node not at that stage and document, changes nothing (done). When no node is left pending, the walk finishes.
export const completeReplyStep = writeOperation.atStoreTime("now")<ReplyStepInput, ReplyStepAnswer>((db, input) => {
  const walk = walkOf(db, input.statusId, input.token);
  const node = walk === undefined ? undefined : nodeOf(db, walk.id, input.step.uri);
  if (
    walk === undefined ||
    node === undefined ||
    node.state !== PENDING ||
    STAGES[node.stage] !== input.step.stage ||
    (node.fetch ?? node.uri) !== input.step.fetch
  ) {
    return { next: null, need: null, done: true };
  }
  const need = applyStep(db, walk, node, input);
  if (need !== null) {
    return { next: null, need, done: false };
  }
  const next = input.more ? handOut(db, walk) : null;
  saveWalk(db, walk);
  if (next === null && !hasPending(db, walk.id)) {
    finish(db, walk.id, input.now);
    return { next: null, need: null, done: true };
  }
  return { next, need: null, done: false };
});

// The end of a round's turn of a walk: under its claim, the walk is due again at once while a node is pending, else it
// finishes. Returns whether a walk is due.
export const releaseReplyWalk = writeOperation.atStoreTime("now")<
  { statusId: string; token: string; now: number },
  boolean
>((db, { statusId, token, now }) => {
  if (walkOf(db, statusId, token) !== undefined) {
    if (hasPending(db, statusId)) {
      db.run("UPDATE reply_walks SET token = NULL, due_at = ?2 WHERE status_id = ?1", statusId, now);
    } else {
      finish(db, statusId, now);
    }
  }
  return dueWalk(db, now) !== undefined;
});

// ---- Starts (the context read's refresh: mastodon/statuses.ts statusContext)

// A refresh's id: 32 lowercase hex characters, drawn when the status's walk row is created and kept on it, as
// Mastodon's AsyncRefresh key belongs to the status.
function newRefreshId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Starts a context refresh of the status `id` for a signed-in reader (Mastodon's ContextsController#show,
// AsyncRefresh.create when should_fetch_replies?), deciding again in its own transaction what the context read
// advised (reply-walk-reads.ts refreshDue): a status the reader may see (R3) that is a walk root published at least
// REPLIES_INITIAL_WAIT_MS ago, with no refresh started within REPLIES_COOLDOWN_MS, while fewer than
// MAX_RUNNING_REFRESHES run. A refresh already running is answered as it is. The status's row is created with a drawn
// id, or a kept one (finished, or running past REFRESH_RUNNING_MS) is rewritten with its own: running from now with
// result_count 0, its nodes replaced by the root's. Answers the running refresh, or null.
export const startRepliesRefresh = userWriteOperation.atStoreTime("now")<{ id: string; now: number }, Refresh | null>((
  db,
  { id, now },
  viewer,
) => {
  const statusId = viewable(db, viewer.accountId, id);
  const root = statusId === null ? undefined : walkRoot(db, statusId, now);
  if (statusId === null || root === undefined || !root.waited) {
    return null;
  }
  if (recentlyRefreshed(db, statusId, now) || refreshesFull(db)) {
    return runningRefresh(db, statusId, now);
  }
  db.run(
    `INSERT INTO reply_walks (status_id, kind, refresh_id, queued_at, due_at, next_seq, nodes)
		VALUES (?1, 0, ?2, ?3, ?3, 1, 1)
		ON CONFLICT (status_id) DO UPDATE SET kind = 0,
			refresh_id = COALESCE(reply_walks.refresh_id, excluded.refresh_id), queued_at = ?3, due_at = ?3,
			finished_at = NULL, token = NULL, next_seq = 1, nodes = 1, pages = 0, result_count = 0`,
    statusId,
    newRefreshId(),
    now,
  );
  db.run("DELETE FROM reply_walk_nodes WHERE status_id = ?", statusId);
  db.run("INSERT INTO reply_walk_nodes (status_id, uri, seq, valid) VALUES (?, ?, 0, 1)", statusId, root.uri);
  return runningRefresh(db, statusId, now);
});
