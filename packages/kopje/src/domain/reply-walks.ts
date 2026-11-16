import { REPLY_WALKS_ID_INDEX, STATUSES_ID_INDEX, STATUSES_URI_INDEX } from "../db/indexes";
import type { Db } from "../db/sql";
import { sameOrigin } from "../platform/http-url";
import { iso } from "../platform/iso-time";
import { isoTimeSql } from "../platform/stored-bounds";
import { userReadOperation, userWriteOperation } from "./auth";
import { fetchedAuthor, type Prefetched } from "./inbox";
import { writeOperation } from "./operation";
import { QUOTE_HOPS } from "./quotes";
import { type ActorState, type DocumentRevision, isDeletedActor, type RemoteActorInput } from "./remote-actors";
import type { RemoteStatusInput } from "./remote-status-reads";
import { storeRemoteStatus } from "./remote-statuses";
import {
  CONTEXT_WALK,
  CREATE_WALK,
  CREATE_WALK_PAGES,
  CREATE_WALK_STATUSES,
  CREATE_WALK_WAITING,
  createItems,
  DEFERRED,
  DONE,
  PENDING,
  STAGES,
  walkUri,
  type WalkStage,
} from "./reply-walk-create";
import {
  recentlyRefreshed,
  REFRESH_FINISHED_MS,
  REFRESH_RUNNING_MS,
  type Refresh,
  refreshById,
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
// take its first page), a page of it (its items and next), or its status again for the replies it embeds (read past
// what an earlier step took: RepliesRead). Nodes run breadth first in seq order; a node keeps its place while its
// collection is read, one that fails transiently goes to the end. The Store hands a node to the Worker (at the claim,
// or as a completion's next) only by charging it in the same transaction: one of its NODE_ATTEMPTS for the document it
// reads, and at every stage but the status one of the walk's WALK_PAGES. A charge stays whatever the step's outcome, a
// lost lease or a round that died included, so a walk takes at most NODE_ATTEMPTS × WALK_STATUSES + WALK_PAGES steps
// however its rounds end, with no counter of claims. A completion hands out a next node only when the Worker says it
// will fetch it (`more`); the round's last hands out nothing. Each hand-out takes the walk's next number, and only the
// completion carrying the number of the one awaited is applied, once.
//
// Only statuses linked to the root are stored (ID-2): a node is valid once its parent is a valid node of the same walk
// and its stored row links to that node's status (in_reply_to_id, the link the context follows). The root is valid from
// the start. A new status's parent is its fetched inReplyTo, checked before anything of it is stored; a stored one's is
// its stored row's (in_reply_to_id, else in_reply_to_uri), and it is not updated (Mastodon updates it, deletes it on
// 404 and refetches replies the collection no longer lists: docs/mastodon-deviations.md, "Replies collections"). A node
// whose parent is not valid yet (a node of the walk not valid yet, or a URI a walk may record that is no node of it
// yet) is deferred on the parent's URI, and returns to the end of the walk (fetched again, while it has an attempt
// left) when a node of that URI becomes valid; one with no parent, a parent no walk records (of this instance's origin,
// or no http(s) URI within STATUS_URI_LIMIT), or a parent node that ended without becoming valid, ends. A walk ends
// when no node is pending; deferred nodes are then dropped. A new status goes through the boosted original's author
// step (inbox.ts fetchedAuthor) and storeRemoteStatus as a fetched status, its quote one hop short of a root's
// (QUOTE_HOPS - 1): its quoted status is stored with none, and nothing a walk stores starts another walk. Collection
// items are ids only: an embedded object is never taken as a status.
//
// A walk is a context walk (the refresh a context read starts) or a create walk (the Create trigger,
// reply-walk-create.ts), alike but for these: a create walk records a node's first CREATE_WALK_ITEMS items on the
// node's origin that Kopje does not store (createItems), reads first pages only, reads the replies of the statuses it
// creates only, is capped at CREATE_WALK_STATUSES nodes and CREATE_WALK_PAGES documents, and goes once it ends. Context
// walks are claimed first; create walks in the order the Store recorded them, each back in its place at every release
// (one whose round died holding it is due behind them once its lease runs out), and one the Store recorded
// REFRESH_RUNNING_MS ago is dropped.

// Nodes a walk records at most, the root included; an item past it is not recorded (docs/mastodon-deviations.md:
// Mastodon's FetchAllRepliesWorker takes 1,000).
export const WALK_STATUSES = 200;
// Collection documents a walk hands out at most, fetched or not, a document read again past its first entries and a
// status read again for its replies included (Mastodon: 500 pages); past it, nodes still pending at those stages end.
export const WALK_PAGES = 100;
// Hand-outs of one document of a node at most (its status, its collection, each page, each reading again), a fetch
// after a deferral included: the first and one retry (FetchReplyWorker's retry).
export const NODE_ATTEMPTS = 2;
// How long a claim holds a walk from other rounds: at least twice a round's steps of it (federation/replies.ts checks
// it as it loads).
export const REPLY_WALK_LEASE_MS = 10 * 60 * 1000;
// Finished walks a claim deletes at most, past REFRESH_FINISHED_MS.
export const WALK_PRUNE_BATCH = 100;
// Walks a claim drops at most before it answers 'more' (a root gone or no longer a walk root, a walk running past
// REFRESH_RUNNING_MS, one with nothing left to hand out), as claimCollectionSync drops syncs.
export const REPLY_CLAIM_DROPS = 3;

// A node handed out: its URI, its stage, the document the step fetches (the URI itself at the status stage), the raw
// entries of that document's chain the step passes over (`skip`, RepliesRead), and the hand-out's number in the walk,
// which its completion hands back.
export type ReplyStep = { uri: string; stage: WalkStage; fetch: string; skip: number; handout: number };

// A walk a round claimed: its kind, the claim's token, which every completion hands back, and its first node, charged.
// pending: another walk is due.
export type ClaimedWalk = {
  statusId: string;
  kind: "context" | "create";
  token: string;
  step: ReplyStep;
  pending: boolean;
};

// Entries of a chain one step reads at most, after the ones it passes over (JsonLdHelper#collection_items reads whole
// pages; past it, the step's next reads the same document again).
export const REPLY_READ_ENTRIES = 200;

// What one document of a replies collection gave, read by the Worker from a status's replies, a collection or a page.
// Its chain is the page it holds and the pages that page embeds as next, read in the one step; an entry is an element
// of a page's items, whatever it holds, and its raw position is its index across the chain. The step passes over its
// `skip` raw entries and takes at most REPLY_READ_ENTRIES: `entries`, in raw order, each an id or null when it is not
// an http(s) id within STATUS_URI_LIMIT (so a null keeps its position); `from`, the raw position of the first (the
// skip), or null when the document holds no chain (its replies or its first page are a URI), the skip then carried to
// the next document; `next`, 'more' when the cap stopped the read with entries left, the URI the chain ended naming,
// or null when it named none. A skip past the chain's end takes nothing and answers the chain's end.
export type RepliesRead = {
  entries: (string | null)[];
  from: number | null;
  next: { stage: "collection" | "page"; uri: string } | "more" | null;
};

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

// need: the step is not applied yet, and the Store needs the status's author (unknown, or stale: refresh, with its
// state read here). next: the node handed out, charged. done: the walk is over for this claim (finished, or the
// claim lost).
export type AuthorNeed = { uri: string; refresh: boolean; state?: ActorState };
export type ReplyStepAnswer = { next: ReplyStep | null; need: AuthorNeed | null; done: boolean };

// The walk's counters, changed in memory by a step and written once (saveWalk); handout: the number of the hand-out
// whose completion is awaited, null once it is applied.
type Walk = {
  id: string;
  kind: number;
  nextSeq: number;
  nodes: number;
  pages: number;
  resultCount: number;
  handouts: number;
  handout: number | null;
};

type Node = {
  uri: string;
  state: number;
  stage: number;
  valid: number;
  fetch: string | null;
  skip: number;
  attempts: number;
};

function walkOf(db: Db, statusId: string, token: string): Walk | undefined {
  const row = db.first<{
    kind: number;
    next_seq: number;
    nodes: number;
    pages: number;
    result_count: number;
    handouts: number;
    handout: number | null;
  }>(
    `SELECT kind, next_seq, nodes, pages, result_count, handouts, handout FROM reply_walks
			WHERE status_id = ? AND token = ? AND due_at IS NOT NULL`,
    statusId,
    token,
  );
  return row === undefined
    ? undefined
    : {
        id: statusId,
        kind: row.kind,
        nextSeq: row.next_seq,
        nodes: row.nodes,
        pages: row.pages,
        resultCount: row.result_count,
        handouts: row.handouts,
        handout: row.handout,
      };
}

// A walk's caps by its kind: the nodes it records and the collection documents it hands out at most (D3, D12).
function capsOf(walk: Walk): { statuses: number; pages: number } {
  return walk.kind === CREATE_WALK
    ? { statuses: CREATE_WALK_STATUSES, pages: CREATE_WALK_PAGES }
    : { statuses: WALK_STATUSES, pages: WALK_PAGES };
}

function saveWalk(db: Db, walk: Walk): void {
  db.run(
    `UPDATE reply_walks SET next_seq = ?2, nodes = ?3, pages = ?4, result_count = ?5, handouts = ?6, handout = ?7
			WHERE status_id = ?1`,
    walk.id,
    walk.nextSeq,
    walk.nodes,
    walk.pages,
    walk.resultCount,
    walk.handouts,
    walk.handout,
  );
}

function nodeOf(db: Db, walkId: string, uri: string): Node | undefined {
  return db.first<Node>(
    "SELECT uri, state, stage, valid, fetch, skip, attempts FROM reply_walk_nodes WHERE status_id = ? AND uri = ?",
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

// A walk's end: its nodes go (deferred ones dropped); a context walk's row is kept finished, with its refresh, for
// REFRESH_FINISHED_MS (the claims' prune), and a create walk's goes, its nodes with it (ON DELETE CASCADE).
function finish(db: Db, walkId: string, kind: number, now: number): void {
  if (kind === CREATE_WALK) {
    db.run("DELETE FROM reply_walks WHERE status_id = ?", walkId);
    return;
  }
  db.run("DELETE FROM reply_walk_nodes WHERE status_id = ?", walkId);
  db.run("UPDATE reply_walks SET due_at = NULL, finished_at = ?2, token = NULL WHERE status_id = ?1", walkId, now);
}

// The next pending node, charged: an attempt, and a page at every stage but the status; it takes the walk's next
// hand-out number, the only one a completion is then applied for. A node with no attempt left, or at those stages once
// the walk's pages are spent (capsOf), is ended without a fetch, and the next is taken: each turn of the loop ends a
// pending node, so it reads at most the walk's nodes. null: none is pending.
function handOut(db: Db, walk: Walk): ReplyStep | null {
  for (;;) {
    const node = db.first<{ uri: string; stage: number; fetch: string | null; skip: number; attempts: number }>(
      `SELECT uri, stage, fetch, skip, attempts FROM reply_walk_nodes INDEXED BY reply_walk_nodes_pending
				WHERE status_id = ? AND state = ${PENDING} ORDER BY seq LIMIT 1`,
      walk.id,
    );
    if (node === undefined) {
      return null;
    }
    const page = node.stage !== 0;
    if (node.attempts >= NODE_ATTEMPTS || (page && walk.pages >= capsOf(walk).pages)) {
      endNode(db, walk.id, node.uri);
      continue;
    }
    db.run("UPDATE reply_walk_nodes SET attempts = attempts + 1 WHERE status_id = ? AND uri = ?", walk.id, node.uri);
    if (page) {
      walk.pages += 1;
    }
    walk.handouts += 1;
    walk.handout = walk.handouts;
    return {
      uri: node.uri,
      stage: STAGES[node.stage]!,
      fetch: node.fetch ?? node.uri,
      skip: node.skip,
      handout: walk.handouts,
    };
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

// A chain's entries recorded as pending nodes of `node`'s walk, by raw position, while the walk holds fewer nodes than
// its cap (capsOf): in a context walk each an id a walk may fetch, not of this instance's origin, not a node of the walk
// already, and not a stored status skipped, any other entry passed, items of any other origin taken
// (FetchAllRepliesService does not filter them by host); in a create walk the items createItems keeps of the node's.
function recordItems(db: Db, walk: Walk, node: Node, entries: readonly (string | null)[], input: ReplyStepInput): void {
  const create = walk.kind === CREATE_WALK;
  for (const uri of create ? createItems(db, entries, node.uri) : entries) {
    if (walk.nodes >= capsOf(walk).statuses) {
      return;
    }
    if (uri === null || (!create && (!walkUri(uri) || sameOrigin(uri, input.origin) || skipped(db, uri, input.now)))) {
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

// A valid node's replies: its entries recorded, then its reading goes on in a later step at the same place, while the
// walk has room. On 'more', the same document is read again past the entries taken (a chain the status holds at the
// replies stage, which fetches the status for its replies only); a URI next (on the node's own origin, Mastodon's
// non_matching_uri_hosts? refusal) is read from its start, or past the carried skip when this document held no chain.
// With neither, or once the walk is full, the node is done. A create walk reads a node's first page only
// (FetchRepliesService's max_pages 1), whatever the completion names (createOnward).
function readReplies(db: Db, walk: Walk, node: Node, replies: RepliesRead | null, input: ReplyStepInput): void {
  if (replies !== null) {
    recordItems(db, walk, node, replies.entries, input);
  }
  const next = replies?.next ?? null;
  if (
    replies === null ||
    next === null ||
    (walk.kind === CREATE_WALK && !createOnward(node, replies)) ||
    walk.nodes >= capsOf(walk).statuses
  ) {
    endNode(db, walk.id, node.uri);
    return;
  }
  const move = (stage: number, fetch: string, skip: number) =>
    db.run(
      "UPDATE reply_walk_nodes SET stage = ?3, fetch = ?4, skip = ?5, attempts = 0 WHERE status_id = ?1 AND uri = ?2",
      walk.id,
      node.uri,
      stage,
      fetch,
      skip,
    );
  if (next === "more") {
    const skip = (replies.from ?? node.skip) + replies.entries.length;
    move(node.stage === 0 ? STAGES.indexOf("replies") : node.stage, node.fetch ?? node.uri, skip);
    return;
  }
  if (!walkUri(next.uri) || !sameOrigin(next.uri, node.uri)) {
    endNode(db, walk.id, node.uri);
    return;
  }
  move(STAGES.indexOf(next.stage), next.uri, replies.from === null ? node.skip : 0);
}

// Whether a create walk's node reads on past this completion: only from a document that held no page (no chain, no
// entry) to a later stage, a status's collection or first page, or a collection's first page. A completion that read a
// page, at any stage, ends the node, whatever next it names, and so does any other next (a chain's, a page's, one
// naming the node's own stage or an earlier one).
function createOnward(node: Node, replies: RepliesRead): boolean {
  const { next } = replies;
  return (
    replies.from === null &&
    replies.entries.length === 0 &&
    next !== null &&
    next !== "more" &&
    STAGES.indexOf(next.stage) > node.stage
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
  if (parentUri === null || !walkUri(parentUri) || sameOrigin(parentUri, input.origin)) {
    endNode(db, walk.id, node.uri);
    return null;
  }
  const parent = nodeOf(db, walk.id, parentUri);
  if (parent !== undefined && parent.state === DONE && parent.valid === 0) {
    endNode(db, walk.id, node.uri);
    return null;
  }
  // A parent no node of the walk yet may be recorded later, from a collection read after this one.
  if (parent === undefined || parent.valid === 0) {
    db.run(
      `UPDATE reply_walk_nodes SET state = ${DEFERRED}, parent = ?3 WHERE status_id = ?1 AND uri = ?2`,
      walk.id,
      node.uri,
      parentUri,
    );
    return null;
  }
  const parentId = statusIdOf(db, parent.uri);
  // A create walk reads the replies of the statuses it creates only (a stored one's Create is not run again).
  const repliesOf = (created: boolean) => (walk.kind === CONTEXT_WALK || created ? fetched.replies : null);
  if (stored !== undefined) {
    // A stored status still unlinked is out of the context's reach, as is one linked elsewhere.
    if (parentId === undefined || stored.linked !== parentId) {
      endNode(db, walk.id, node.uri);
    } else {
      validate(db, walk, node, repliesOf(false), input);
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
      const { uri, refresh, state } = found.need;
      return { uri, refresh: refresh === true, ...(state === undefined ? {} : { state }) };
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
    validate(db, walk, node, repliesOf(outcome.reason === "created"), input);
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

type DueWalk = { status_id: string; kind: number; queued_at: number };

// The walk due first of a kind, by due_at, then by rowid: a waiting create walk's due_at is CREATE_WALK_WAITING, so
// create walks are taken in the order the Store recorded them (reply-walk-create.ts), each again in its place once
// released (releaseReplyWalk).
function dueOf(db: Db, kind: number, now: number): DueWalk | undefined {
  return db.first<DueWalk>(
    `SELECT status_id, kind, queued_at FROM reply_walks INDEXED BY reply_walks_due WHERE kind = ? AND due_at <= ?
			ORDER BY due_at, rowid LIMIT 1`,
    kind,
    now,
  );
}

function dueWalk(db: Db, now: number): DueWalk | undefined {
  return dueOf(db, CONTEXT_WALK, now) ?? dueOf(db, CREATE_WALK, now);
}

// The walk due first, a context walk before any create walk, claimed for REPLY_WALK_LEASE_MS with its next node handed
// out. First the finished walks past REFRESH_FINISHED_MS are pruned (WALK_PRUNE_BATCH at most). A walk queued
// REFRESH_RUNNING_MS ago (a context walk's latest start, a create walk's record) is deleted, one whose root is gone or
// no longer a walk root is finished, and one with no node left to hand out is finished; then the next due is taken, at
// most REPLY_CLAIM_DROPS + 1 in all. 'more': that many were dropped and another is due; null: none is due.
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
      finish(db, id, row.kind, now);
      continue;
    }
    const token = crypto.randomUUID();
    db.run("UPDATE reply_walks SET token = ?2, due_at = ?3 WHERE status_id = ?1", id, token, now + REPLY_WALK_LEASE_MS);
    const walk = walkOf(db, id, token)!;
    const step = handOut(db, walk);
    saveWalk(db, walk);
    if (step === null) {
      finish(db, id, row.kind, now);
      continue;
    }
    const kind = row.kind === CREATE_WALK ? "create" : "context";
    return { statusId: id, kind, token, step, pending: dueWalk(db, now) !== undefined };
  }
  return dueWalk(db, now) === undefined ? null : "more";
});

// Applies what the Worker fetched for a node handed out under the claim `token`, in one transaction, and hands out the
// next node when `more` says the Worker will fetch it. Only the completion of the hand-out awaited is applied, once: one
// of a claim that is no longer the walk's, of an earlier hand-out, or repeated after it was applied changes nothing
// (done), whatever node, stage, document and skip it names. A completion answered with a need is applied when it comes
// again with the author. When no node is left pending, the walk finishes.
export const completeReplyStep = writeOperation.atStoreTime("now")<ReplyStepInput, ReplyStepAnswer>((db, input) => {
  const walk = walkOf(db, input.statusId, input.token);
  const node =
    walk === undefined || walk.handout !== input.step.handout ? undefined : nodeOf(db, walk.id, input.step.uri);
  if (walk === undefined || node === undefined) {
    return { next: null, need: null, done: true };
  }
  const need = applyStep(db, walk, node, input);
  if (need !== null) {
    return { next: null, need, done: false };
  }
  walk.handout = null;
  const next = input.more ? handOut(db, walk) : null;
  saveWalk(db, walk);
  if (next === null && !hasPending(db, walk.id)) {
    finish(db, walk.id, walk.kind, input.now);
    return { next: null, need: null, done: true };
  }
  return { next, need: null, done: false };
});

// The end of a round's turn of a walk: under its claim, the walk is due again at once while a node is pending (a
// create walk waiting in its place, CREATE_WALK_WAITING), else it finishes. Returns whether a walk is due.
export const releaseReplyWalk = writeOperation.atStoreTime("now")<
  { statusId: string; token: string; now: number },
  boolean
>((db, { statusId, token, now }) => {
  const walk = walkOf(db, statusId, token);
  if (walk !== undefined) {
    if (hasPending(db, statusId)) {
      db.run(
        `UPDATE reply_walks SET token = NULL, due_at = IIF(kind = ${CREATE_WALK}, ${CREATE_WALK_WAITING}, ?2)
			WHERE status_id = ?1`,
        statusId,
        now,
      );
    } else {
      finish(db, statusId, walk.kind, now);
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
// result_count 0, its nodes replaced by the root's. A create walk of the status becomes this refresh the same way, with
// a drawn id: its nodes and counters go, and its claim's token, so its round's completions change nothing (D12).
// Answers the running refresh, or null.
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
			finished_at = NULL, token = NULL, next_seq = 1, nodes = 1, pages = 0, result_count = 0, handouts = 0,
			handout = NULL`,
    statusId,
    newRefreshId(),
    now,
  );
  db.run("DELETE FROM reply_walk_nodes WHERE status_id = ?", statusId);
  db.run("INSERT INTO reply_walk_nodes (status_id, uri, seq, valid) VALUES (?, ?, 0, 1)", statusId, root.uri);
  return runningRefresh(db, statusId, now);
});

// A refresh's id as startRepliesRefresh draws it.
const REFRESH_ID = /^[0-9a-f]{32}$/;

// GET /api/v1_alpha/async_refreshes/:id (Api::V1Alpha::AsyncRefreshesController#show, AsyncRefresh.find), to any
// signed-in user, as Mastodon's: the refresh with the id while it runs, or until REFRESH_FINISHED_MS after it
// finished, else null. An id that is not 32 lowercase hex characters names none and is looked up nowhere.
export const getAsyncRefresh = userReadOperation.atStoreTime("now")<{ id: string; now: number }, Refresh | null>(
  (db, { id, now }) => (REFRESH_ID.test(id) ? refreshById(db, id, now) : null),
);
