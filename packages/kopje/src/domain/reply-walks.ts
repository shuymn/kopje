import { ACCOUNTS_ID_INDEX, REPLY_WALKS_ID_INDEX, STATUSES_ID_INDEX, STATUSES_URI_INDEX } from "../db/indexes";
import type { Db } from "../db/sql";
import { sameOrigin } from "../platform/http-url";
import { iso } from "../platform/iso-time";
import { isoTimeSql } from "../platform/stored-bounds";
import { userReadOperation, userWriteOperation } from "./auth";
import { fetchedAuthor, type Prefetched } from "./inbox";
import { writeOperation } from "./operation";
import { QUOTE_HOPS } from "./quotes";
import {
  type ActorState,
  type DocumentRevision,
  isDeletedActor,
  type RemoteActorInput,
  type RemoteRow,
} from "./remote-actors";
import { removeGone } from "./remote-removal";
import type { RemoteStatusInput } from "./remote-status-reads";
import { storeFetchedStatus, storeRemoteStatus } from "./remote-statuses";
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
  COLLECTION_DEBT,
  type Debt,
  type DebtKey,
  debtEpoch,
  moveCursor,
  nextDebt,
  ORDINARY,
  owe,
  OWED,
  PATH,
  pathStep,
  type Place,
  removalBegun,
  ROW_DEBT,
  scanWindow,
  settle,
} from "./reply-walk-debts";
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
// its stored row's (in_reply_to_id, else in_reply_to_uri), which no update changes. A stored status a step fetched, the
// root included, is applied as its author's Update (remote-statuses.ts storeFetchedStatus, Mastodon's FetchReplyWorker
// through FetchRemoteStatusService), and a node other than the root whose own URI answered 404 has the status stored
// under it then removed (remote-removal.ts removeGone, Mastodon's fetch_status); the root's 404 removes nothing, as
// FetchAllRepliesWorker hands the root's body to FetchReplyWorker. A node whose parent is not valid yet (a node of the
// walk not valid yet, or a URI a walk may record that is no node of it yet) is deferred on the parent's URI, and
// returns to the end of the walk (fetched again, while it has an attempt left) when a node of that URI becomes valid;
// one with no parent, a parent no walk records (of this instance's origin, or no http(s) URI within STATUS_URI_LIMIT),
// or a parent node that ended without becoming valid, ends. A walk ends when no node is pending; deferred nodes are
// then dropped. A new status goes through the boosted original's author step (inbox.ts fetchedAuthor) and
// storeRemoteStatus as a fetched status, its quote one hop short of a root's (QUOTE_HOPS - 1): its quoted status is
// stored with none, and nothing a walk stores starts another walk. Collection items are ids only: an embedded object is
// never taken as a status.
//
// A walk is a context walk (the refresh a context read starts) or a create walk (the Create trigger,
// reply-walk-create.ts), alike but for these: a create walk records a node's first CREATE_WALK_ITEMS items on the
// node's origin, stored or not (createItems), reads first pages only, reads the replies of the statuses it
// creates only, is capped at CREATE_WALK_STATUSES nodes and CREATE_WALK_PAGES documents, and goes once it ends. Context
// walks are claimed first; create walks in the order the Store recorded them, each back in its place at every release
// (one whose round died holding it is due behind them once its lease runs out), and one the Store recorded
// REFRESH_RUNNING_MS ago is dropped.
//
// A context walk also scans and owes (reply-walk-debts.ts; one started before migration 0106, with no debt_walk, does
// neither). A valid node whose collection reading ends, or is cut, after it read a chain becomes scan-due, and its scan
// examines REPLY_SCAN_ROWS of its stored public replies from its cursor: a remote one published REPLIES_INITIAL_WAIT_MS
// ago and no node of the walk is admitted while the walk has room, else owed to the root as a row debt; a reading the
// walk cuts (no room for its next entry or document, or WALK_PAGES spent) is owed as a collection debt with its place.
// A hand-out takes, in this order: the owed or path node of lowest seq pending; the scan of the owed node scan-due
// first; while considering is open, the root's next debt older than the walk, applied to a node of the walk at its
// status stage, passed for one past it, or recorded after its stored path to a node of the walk (dropped when the path
// passes a status a walk may not record, or cannot reach the root within an empty walk; considering closes when it does
// not fit otherwise, or when no debt or room is left, or WALK_STATUSES debts were considered); the ordinary node of
// lowest seq pending, the root's status step first; and, with none pending, the scan of the ordinary node scan-due
// first. A scan or a consideration is a Store-only step: the hand-out runs one, then hands out a node it put in the
// walk, or a step the Worker completes with no request. What owed work admits joins the owed lane; a path node is
// fetched and validated as any and reads no collection. A node's status stage ending pays the root's row debt of it,
// and ending invalid also drops an applied collection debt (not the root's); a reading's end pays its collection debt,
// a cut re-keys it. An applied collection debt's reading starts at its place (skip, and resume_page for a later chain).

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
// which its completion hands back. At the stage `store`, a Store-only step (a scan or a debt's consideration ran in the
// hand-out), which the Worker completes with nothing fetched; its URI is the root's.
export type ReplyStep = { uri: string; stage: WalkStage | "store"; fetch: string; skip: number; handout: number };

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
// or a page's reading, a 404 that the status's own URI answered without a redirect (federation/actor-gone.ts goneAt),
// a failure that may pass, any other failure (a 410, a redirected 404, refused, unusable, another origin), or nothing
// (a Store-only step).
export type StepFetched =
  | { kind: "status"; status: RemoteStatusInput; replies: RepliesRead | null }
  | { kind: "replies"; replies: RepliesRead }
  | { kind: "gone" }
  | { kind: "transient" }
  | { kind: "failed" }
  | { kind: "none" };

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
// claim lost). jobsPending: the step started a removal (removeGone), whose batches the inbound job rounds run.
export type AuthorNeed = { uri: string; refresh: boolean; state?: ActorState };
export type ReplyStepAnswer = { next: ReplyStep | null; need: AuthorNeed | null; done: boolean; jobsPending: boolean };

// The walk's counters, changed in memory by a step and written once (saveWalk); handout: the number of the hand-out
// whose completion is awaited, null once it is applied; removed (not stored): the step started a removal. debtWalk:
// its debt epoch, null for a walk that owes and considers nothing; debtAfter: the key of the last debt considered;
// debtsSeen: the debts considered.
type Walk = {
  id: string;
  kind: number;
  nextSeq: number;
  nodes: number;
  pages: number;
  resultCount: number;
  handouts: number;
  handout: number | null;
  removed: boolean;
  debtWalk: number | null;
  debtAfter: DebtKey | null;
  debtsSeen: number;
};

type Node = {
  uri: string;
  seq: number;
  state: number;
  stage: number;
  valid: number;
  fetch: string | null;
  skip: number;
  attempts: number;
  lane: number;
  depth: number;
  resume_page: string | null;
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
    debt_walk: number | null;
    debt_after_walk: number | null;
    debt_after_seq: number | null;
    debt_after_pos: number | null;
    debts_seen: number;
  }>(
    `SELECT kind, next_seq, nodes, pages, result_count, handouts, handout, debt_walk, debt_after_walk, debt_after_seq,
				debt_after_pos, debts_seen
			FROM reply_walks WHERE status_id = ? AND token = ? AND due_at IS NOT NULL`,
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
        removed: false,
        debtWalk: row.kind === CONTEXT_WALK ? row.debt_walk : null,
        debtAfter:
          row.debt_after_walk === null
            ? null
            : { walk: row.debt_after_walk, seq: row.debt_after_seq ?? 0, pos: row.debt_after_pos ?? 0 },
        debtsSeen: row.debts_seen,
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
    `UPDATE reply_walks SET next_seq = ?2, nodes = ?3, pages = ?4, result_count = ?5, handouts = ?6, handout = ?7,
				debt_after_walk = ?8, debt_after_seq = ?9, debt_after_pos = ?10, debts_seen = ?11
			WHERE status_id = ?1`,
    walk.id,
    walk.nextSeq,
    walk.nodes,
    walk.pages,
    walk.resultCount,
    walk.handouts,
    walk.handout,
    walk.debtAfter?.walk ?? null,
    walk.debtAfter?.seq ?? null,
    walk.debtAfter?.pos ?? null,
    walk.debtsSeen,
  );
}

const NODE_COLUMNS = "uri, seq, state, stage, valid, fetch, skip, attempts, lane, depth, resume_page";

function nodeOf(db: Db, walkId: string, uri: string): Node | undefined {
  return db.first<Node>(`SELECT ${NODE_COLUMNS} FROM reply_walk_nodes WHERE status_id = ? AND uri = ?`, walkId, uri);
}

// A node's end; scanDue: its scan is due (a context walk's valid node whose reading ended or was cut after it read a
// chain).
function endNode(db: Db, walkId: string, uri: string, scanDue = false): void {
  db.run(
    `UPDATE reply_walk_nodes SET state = ${DONE}, parent = NULL, scan_due = ?3 WHERE status_id = ?1 AND uri = ?2`,
    walkId,
    uri,
    scanDue ? 1 : 0,
  );
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

// Whether the walk has work left: a node pending, a scan due, or a debt to consider.
function hasWork(db: Db, walk: Walk): boolean {
  return hasPending(db, walk.id) || scanDue(db, walk, null) !== undefined || considered(db, walk) !== undefined;
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

// The root's debt of the node's status of `kinds` settled (paid or dropped), in a walk that owes. A key read and a
// key delete.
function settleNode(db: Db, walk: Walk, uri: string, kinds: readonly number[]): void {
  const statusId = walk.debtWalk === null ? undefined : statusIdOf(db, uri);
  if (statusId !== undefined) {
    settle(db, walk.id, statusId, kinds);
  }
}

// A node's status stage ended without its becoming valid (out of attempts, failed, gone, refused or judged out): the
// root's row debt of its status is paid, and a collection debt applied to it is dropped. The root's status stage
// (valid from the walk's start) ends nothing of its own debt, which keeps its key and place.
function statusFailed(db: Db, walk: Walk, node: Node): void {
  endNode(db, walk.id, node.uri);
  if (node.valid === 0) {
    settleNode(db, walk, node.uri, [ROW_DEBT, COLLECTION_DEBT]);
  }
}

// Whether a node's reading has read a chain (a page of its collection, embedded or fetched): at this completion, at an
// earlier one of the walk (a reading again past its first entries, a later chain, the status's chain again), or at the
// walk whose cut its applied debt resumes (a skip carried from it).
function chainRead(node: Node, read: RepliesRead | null): boolean {
  return (
    (read !== null && read.from !== null) ||
    node.skip > 0 ||
    node.resume_page !== null ||
    node.stage === STAGES.indexOf("replies")
  );
}

// A node's reading ended (its collection read to its end, refused, absent or failed): the root's collection debt of
// it paid; scan-due when it read a chain (scanDue) in a walk that owes.
function readingEnded(db: Db, walk: Walk, node: Node, scanDue: boolean): void {
  endNode(db, walk.id, node.uri, scanDue && walk.debtWalk !== null);
  settleNode(db, walk, node.uri, [COLLECTION_DEBT]);
}

// A node's reading cut before it ended (no room for its next entry or document, or the walk's pages spent): in a walk
// that owes, scan-due when it read a chain, and owed to the root as a collection debt with the place it stopped,
// keyed by the node's seq in this walk. A debt the walk applied to it (an owed node's, considered: the root joins the
// owed lane only so) is re-keyed behind every earlier walk's; one not applied keeps its key and place, since the
// reading started from the start. One deeper than WALK_STATUSES - 2, which no walk of the root can read, or whose
// status or root is being removed, is not owed (one held is dropped).
function readingCut(db: Db, walk: Walk, node: Node, place: Place, scanDue: boolean): void {
  endNode(db, walk.id, node.uri, scanDue && walk.debtWalk !== null);
  const statusId = walk.debtWalk === null ? undefined : statusIdOf(db, node.uri);
  if (walk.debtWalk === null || statusId === undefined) {
    return;
  }
  if (node.depth > WALK_STATUSES - 2 || removalBegun(db, walk.id) || removalBegun(db, statusId)) {
    settle(db, walk.id, statusId, [COLLECTION_DEBT]);
    return;
  }
  const key = { walk: walk.debtWalk, seq: node.seq, pos: 0 };
  owe(db, walk.id, statusId, COLLECTION_DEBT, node.depth, key, place, node.lane === OWED ? walk.debtAfter : null);
}

// Charges a pending node and hands it out: an attempt, and a page at every stage but the status; it takes the walk's
// next hand-out number, the only one a completion is then applied for. null: the node was ended instead, without a
// fetch: with no attempt left (its status stage, or its reading, failed), or past its stage once the walk's pages are
// spent (capsOf: its reading cut).
function charge(db: Db, walk: Walk, node: Node): ReplyStep | null {
  const page = node.stage !== 0;
  if (node.attempts >= NODE_ATTEMPTS) {
    if (page) {
      readingEnded(db, walk, node, false);
    } else {
      statusFailed(db, walk, node);
    }
    return null;
  }
  if (page && walk.pages >= capsOf(walk).pages) {
    readingCut(db, walk, node, { page: node.resume_page, offset: node.skip }, chainRead(node, null));
    return null;
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

// A Store-only step, numbered as any hand-out: the Worker completes it with nothing fetched.
function storeStep(db: Db, walk: Walk): ReplyStep {
  walk.handouts += 1;
  walk.handout = walk.handouts;
  const root = db.first<{ uri: string }>(
    `SELECT uri FROM statuses INDEXED BY ${STATUSES_ID_INDEX} WHERE id = ?`,
    walk.id,
  );
  const uri = root?.uri ?? "";
  return { uri, stage: "store", fetch: uri, skip: 0, handout: walk.handouts };
}

// The pending node of lowest seq: of the owed and path lanes (reply_walk_nodes_owed), or of any.
function firstPending(db: Db, walk: Walk, owed: boolean): Node | undefined {
  return db.first<Node>(
    owed
      ? `SELECT ${NODE_COLUMNS} FROM reply_walk_nodes INDEXED BY reply_walk_nodes_owed
				WHERE status_id = ? AND state = ${PENDING} AND lane <> ${ORDINARY} ORDER BY seq LIMIT 1`
      : `SELECT ${NODE_COLUMNS} FROM reply_walk_nodes INDEXED BY reply_walk_nodes_pending
				WHERE status_id = ? AND state = ${PENDING} ORDER BY seq LIMIT 1`,
    walk.id,
  );
}

// The scan-due node of lowest seq of the lane (of any, null), in a walk that owes.
function scanDue(db: Db, walk: Walk, lane: number | null): Node | undefined {
  if (walk.debtWalk === null) {
    return undefined;
  }
  const row =
    lane === null
      ? db.first<{ uri: string }>(
          `SELECT uri FROM reply_walk_nodes INDEXED BY reply_walk_nodes_scan WHERE status_id = ? AND scan_due = 1 LIMIT 1`,
          walk.id,
        )
      : db.first<{ uri: string }>(
          `SELECT uri FROM reply_walk_nodes INDEXED BY reply_walk_nodes_scan
					WHERE status_id = ?1 AND scan_due = 1 AND lane = ?2 ORDER BY seq LIMIT 1`,
          walk.id,
          lane,
        );
  return row === undefined ? undefined : nodeOf(db, walk.id, row.uri);
}

// The debt a hand-out considers next while considering is open: the root's next debt after the last one considered,
// owed by an earlier walk, while the walk has room and has considered fewer than WALK_STATUSES. One index entry and
// its row.
function considered(db: Db, walk: Walk): Debt | undefined {
  if (walk.debtWalk === null || walk.debtsSeen >= WALK_STATUSES || walk.nodes >= capsOf(walk).statuses) {
    return undefined;
  }
  const debt = nextDebt(db, walk.id, walk.debtAfter);
  return debt !== undefined && debt.key.walk < walk.debtWalk ? debt : undefined;
}

// A status recorded as a pending node of the walk in `lane`, its reading to start at `place`.
function record(db: Db, walk: Walk, uri: string, lane: number, place: Place | null = null): void {
  db.run(
    "INSERT INTO reply_walk_nodes (status_id, uri, seq, lane, skip, resume_page) VALUES (?, ?, ?, ?, ?, ?)",
    walk.id,
    uri,
    walk.nextSeq,
    lane,
    place?.offset ?? 0,
    place?.page ?? null,
  );
  walk.nextSeq += 1;
  walk.nodes += 1;
}

// A debt considered (the module comment): applied to the node of its status at its status stage (pending or deferred:
// it joins the owed lane, a collection debt's place its reading's start), passed for one past it, or recorded after its
// path, the stored statuses from its status's parent up to the first node of the walk, one pathStep each, at most the
// free slots less one (less two for a collection debt, which keeps one for its reading): the path top-down in the path
// lane, then the status in the owed lane. A status on the way a walk may not record drops the debt, as does a path that
// ends or repeats before it reaches a node; one that does not fit drops it in a walk that holds only its root and
// otherwise closes considering (debtsSeen at its cap), the debt kept as not considered (debtAfter where it was).
function consider(db: Db, walk: Walk, debt: Debt): void {
  const before = walk.debtAfter;
  walk.debtAfter = debt.key;
  walk.debtsSeen += 1;
  const drop = () => settle(db, walk.id, debt.statusId, [debt.kind]);
  const place = debt.kind === COLLECTION_DEBT ? debt.place : null;
  const status = pathStep(db, debt.statusId);
  if (status === undefined || !status.recordable) {
    drop();
    return;
  }
  const node = nodeOf(db, walk.id, status.uri);
  if (node !== undefined) {
    if (node.stage === 0 && node.state !== DONE) {
      db.run(
        `UPDATE reply_walk_nodes SET lane = ${OWED}, skip = ?3, resume_page = ?4 WHERE status_id = ?1 AND uri = ?2`,
        walk.id,
        node.uri,
        place?.offset ?? node.skip,
        place === null ? node.resume_page : place.page,
      );
    }
    return;
  }
  const room = capsOf(walk).statuses - walk.nodes - (debt.kind === COLLECTION_DEBT ? 2 : 1);
  const unfit = () => {
    if (walk.nodes === 1) {
      drop();
    } else {
      walk.debtAfter = before;
      walk.debtsSeen = WALK_STATUSES;
    }
  };
  const path: string[] = [];
  const seen = new Set([status.uri]);
  for (let parent = status.parent; ;) {
    const step = parent === null ? undefined : pathStep(db, parent);
    if (step === undefined || !step.recordable || seen.has(step.uri)) {
      drop();
      return;
    }
    if (nodeOf(db, walk.id, step.uri) !== undefined) {
      break;
    }
    if (path.length >= room) {
      unfit();
      return;
    }
    seen.add(step.uri);
    path.push(step.uri);
    parent = step.parent;
  }
  // A path of none still needs the status's slot, and a collection debt's one more.
  if (path.length > room) {
    unfit();
    return;
  }
  for (const uri of path.toReversed()) {
    record(db, walk, uri, PATH);
  }
  record(db, walk, status.uri, OWED, place);
}

// A scan of the node, its scan_due cleared: of the rows of its window (scanWindow), a remote reply that is no node of
// the walk and that should_not_fetch_replies does not skip (published REPLIES_INITIAL_WAIT_MS ago, a time that is not a
// stored one not; and no root of a refresh within REPLIES_COOLDOWN_MS, as skipped) is admitted while
// the walk has room (in the owed lane for an owed node's scan), else owed to the root as a row debt at its place in the
// window when its depth fits (WALK_STATUSES - 1) and the root is not being removed; any other is passed. Then the
// node's cursor moves past them, unless its status is being removed.
function scan(db: Db, walk: Walk, node: Node, now: number): void {
  db.run("UPDATE reply_walk_nodes SET scan_due = 0 WHERE status_id = ? AND uri = ?", walk.id, node.uri);
  const statusId = statusIdOf(db, node.uri);
  if (statusId === undefined) {
    return;
  }
  const rows = scanWindow(db, statusId, iso(now - REPLIES_INITIAL_WAIT_MS));
  const depth = node.depth + 1;
  const owing = walk.debtWalk !== null && depth <= WALK_STATUSES - 1 && !removalBegun(db, walk.id);
  const lane = node.lane === ORDINARY ? ORDINARY : OWED;
  rows.forEach((row, i) => {
    if (row.waited !== 1 || !walkUri(row.uri) || nodeOf(db, walk.id, row.uri) !== undefined) {
      return;
    }
    if (pathStep(db, row.id)?.recordable !== true || cooling(db, row.id, now)) {
      return;
    }
    if (walk.nodes < capsOf(walk).statuses) {
      record(db, walk, row.uri, lane);
    } else if (owing) {
      const key = { walk: walk.debtWalk!, seq: node.seq, pos: i + 1 };
      owe(db, walk.id, row.id, ROW_DEBT, depth, key, { page: null, offset: 0 });
    }
  });
  if (!removalBegun(db, statusId)) {
    moveCursor(db, statusId, rows);
  }
}

// The first pending node of the lane a scan or a consideration put in the walk, charged, or else a Store-only step.
function afterStoreWork(db: Db, walk: Walk, owed: boolean): ReplyStep {
  const node = firstPending(db, walk, owed);
  return (node === undefined ? null : charge(db, walk, node)) ?? storeStep(db, walk);
}

// The walk's next step, in the hand-out order of the module comment (a walk that owes nothing hands out its pending
// nodes by seq): at most one scan or one consideration, after which the first node it put in the walk or a
// Store-only step. Each turn of the loop ends a pending node, so it reads at most the walk's nodes. null: no work is
// left.
function handOut(db: Db, walk: Walk, now: number): ReplyStep | null {
  for (;;) {
    const owed = walk.debtWalk === null ? undefined : firstPending(db, walk, true);
    if (owed !== undefined) {
      const step = charge(db, walk, owed);
      if (step !== null) {
        return step;
      }
      continue;
    }
    const owedScan = scanDue(db, walk, OWED);
    if (owedScan !== undefined) {
      scan(db, walk, owedScan, now);
      return afterStoreWork(db, walk, true);
    }
    const debt = considered(db, walk);
    if (debt !== undefined) {
      consider(db, walk, debt);
      return afterStoreWork(db, walk, true);
    }
    const ordinary = firstPending(db, walk, false);
    if (ordinary !== undefined) {
      const step = charge(db, walk, ordinary);
      if (step !== null) {
        return step;
      }
      continue;
    }
    const ordinaryScan = scanDue(db, walk, ORDINARY);
    if (ordinaryScan === undefined) {
      return null;
    }
    scan(db, walk, ordinaryScan, now);
    return afterStoreWork(db, walk, false);
  }
}

// The refresh part of should_not_fetch_replies: the status `s` is the root of a context refresh running (queued after
// `running`) or started within REPLIES_COOLDOWN_MS (after `cooldown`). One key read of its walk.
function coolingSql(running: string, cooldown: string): string {
  return `EXISTS (SELECT 1 FROM reply_walks w INDEXED BY ${REPLY_WALKS_ID_INDEX} WHERE w.status_id = s.id AND w.kind = 0
		AND ((w.finished_at IS NULL AND w.queued_at > ${running}) OR w.queued_at > ${cooldown}))`;
}

// Whether a stored status listed as an item is skipped, as FetchAllRepliesService skips should_not_fetch_replies: one
// published within REPLIES_INITIAL_WAIT_MS (or whose time is not a stored one), or the root of a refresh running or
// started within REPLIES_COOLDOWN_MS. One key read of the status, one of its walk.
function skipped(db: Db, uri: string, now: number): boolean {
  return (
    db.first(
      `SELECT 1 AS x FROM statuses s INDEXED BY ${STATUSES_URI_INDEX}
			WHERE s.uri = ?1 AND (COALESCE(${isoTimeSql("s.published_at")} > ?2, 1) OR ${coolingSql("?3", "?4")})`,
      uri,
      iso(now - REPLIES_INITIAL_WAIT_MS),
      now - REFRESH_RUNNING_MS,
      now - REPLIES_COOLDOWN_MS,
    ) !== undefined
  );
}

// Whether a scanned row is the root of a refresh running or started within REPLIES_COOLDOWN_MS (its initial wait is the
// scan's). One key read of the status, one of its walk.
function cooling(db: Db, statusId: string, now: number): boolean {
  return (
    db.first(
      `SELECT 1 AS x FROM statuses s INDEXED BY ${STATUSES_ID_INDEX} WHERE s.id = ?1 AND ${coolingSql("?2", "?3")}`,
      statusId,
      now - REFRESH_RUNNING_MS,
      now - REPLIES_COOLDOWN_MS,
    ) !== undefined
  );
}

// A chain's entries recorded as pending nodes of `node`'s walk, by raw position, while the walk holds fewer nodes than
// its cap (capsOf): in a context walk each an id a walk may fetch, not of this instance's origin, not a node of the
// walk already, and not a stored status skipped, any other entry passed, items of any other origin taken
// (FetchAllRepliesService does not filter them by host), in the owed lane when an owed node reads them; in a create
// walk the items createItems keeps of the node's, while the walk has room. Returns how many entries were taken: all of
// them, unless a context walk had no room for the next entry it would record (a node of the walk takes none).
function recordItems(
  db: Db,
  walk: Walk,
  node: Node,
  entries: readonly (string | null)[],
  input: ReplyStepInput,
): number {
  const create = walk.kind === CREATE_WALK;
  const items = create ? createItems(entries, node.uri) : entries;
  const lane = node.lane === ORDINARY ? ORDINARY : OWED;
  for (const [taken, uri] of items.entries()) {
    if (create && walk.nodes >= capsOf(walk).statuses) {
      return entries.length;
    }
    if (uri === null || (!create && (!walkUri(uri) || sameOrigin(uri, input.origin) || skipped(db, uri, input.now)))) {
      continue;
    }
    if (walk.nodes >= capsOf(walk).statuses) {
      if (nodeOf(db, walk.id, uri) !== undefined) {
        continue;
      }
      return taken;
    }
    const inserted = db.run(
      "INSERT INTO reply_walk_nodes (status_id, uri, seq, lane) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
      walk.id,
      uri,
      walk.nextSeq,
      lane,
    );
    if (inserted > 0) {
      walk.nextSeq += 1;
      walk.nodes += 1;
    }
  }
  return entries.length;
}

// Where a reading cut before its next document goes on: the same chain past the entries taken ('more'), the chain the
// next URI holds (a page past a chain: a later chain, from its start), or, while no chain was held yet, the place the
// reading was at (resume_page: null in the collection's first chain; the skip carried).
function placeOf(node: Node, read: RepliesRead): Place {
  const { next } = read;
  if (next === "more") {
    return { page: node.resume_page, offset: (read.from ?? node.skip) + read.entries.length };
  }
  if (read.from !== null && next !== null) {
    return { page: next.uri, offset: 0 };
  }
  return { page: node.resume_page, offset: node.skip };
}

// A valid node's replies: its entries recorded, then its reading goes on in a later step at the same place, while the
// walk has room. On 'more', the same document is read again past the entries taken (a chain the status holds at the
// replies stage, which fetches the status for its replies only); a URI next (on the node's own origin, Mastodon's
// non_matching_uri_hosts? refusal) is read from its start, a later chain, or past the carried skip when this document
// held no chain. With neither, the reading ends; with no room for an entry or for the next document, or the walk's
// pages spent, it is cut (readingCut, with its place). A path node reads nothing, and a node with an applied debt's
// page passes over its status's replies and goes on at that page with its skip. A create walk reads a node's first
// page only (FetchRepliesService's max_pages 1), whatever the completion names (createOnward).
function readReplies(db: Db, walk: Walk, node: Node, replies: RepliesRead | null, input: ReplyStepInput): void {
  if (node.lane === PATH) {
    endNode(db, walk.id, node.uri);
    return;
  }
  const read: RepliesRead | null =
    node.stage === 0 && node.resume_page !== null
      ? { entries: [], from: null, next: { stage: "page", uri: node.resume_page } }
      : replies;
  if (read === null) {
    readingEnded(db, walk, node, false);
    return;
  }
  const taken = recordItems(db, walk, node, read.entries, input);
  const scanDue = chainRead(node, read);
  if (taken < read.entries.length) {
    readingCut(db, walk, node, { page: node.resume_page, offset: (read.from ?? node.skip) + taken }, scanDue);
    return;
  }
  const { next } = read;
  if (
    next === null ||
    (walk.kind === CREATE_WALK && !createOnward(node, read)) ||
    (next !== "more" && (!walkUri(next.uri) || !sameOrigin(next.uri, node.uri)))
  ) {
    readingEnded(db, walk, node, scanDue);
    return;
  }
  const caps = capsOf(walk);
  if (walk.nodes >= caps.statuses || walk.pages >= caps.pages) {
    readingCut(db, walk, node, placeOf(node, read), scanDue);
    return;
  }
  const move = (stage: number, fetch: string, skip: number, resumePage: string | null) =>
    db.run(
      `UPDATE reply_walk_nodes SET stage = ?3, fetch = ?4, skip = ?5, attempts = 0, resume_page = ?6
				WHERE status_id = ?1 AND uri = ?2`,
      walk.id,
      node.uri,
      stage,
      fetch,
      skip,
      resumePage,
    );
  if (next === "more") {
    const skip = (read.from ?? node.skip) + read.entries.length;
    move(node.stage === 0 ? STAGES.indexOf("replies") : node.stage, node.fetch ?? node.uri, skip, node.resume_page);
    return;
  }
  if (read.from === null) {
    move(STAGES.indexOf(next.stage), next.uri, node.skip, node.resume_page);
  } else {
    move(STAGES.indexOf(next.stage), next.uri, 0, next.uri);
  }
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

// A node becomes valid under a node at `parentDepth`, one link deeper: its status stage ends (the root's row debt of it
// paid), the nodes deferred on it go back to the end of the walk, in their order (each fetched again while it has an
// attempt left), and its replies are read.
function validate(
  db: Db,
  walk: Walk,
  node: Node,
  replies: RepliesRead | null,
  input: ReplyStepInput,
  parentDepth: number,
): void {
  const depth = parentDepth + 1;
  db.run(
    "UPDATE reply_walk_nodes SET valid = 1, depth = ?3 WHERE status_id = ?1 AND uri = ?2",
    walk.id,
    node.uri,
    depth,
  );
  settleNode(db, walk, node.uri, [ROW_DEBT]);
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
  readReplies(db, walk, { ...node, valid: 1, depth }, replies, input);
}

// A stored status's place in the thread, as its row keeps it: its id, the status its in_reply_to_id links (null while
// unlinked), the URI of its parent (that status's, else in_reply_to_uri), and its author's URI. Three key reads.
type StoredPlace = { id: string; linked: string | null; parent: string | null; author: string | null };
function storedPlace(db: Db, uri: string): StoredPlace | undefined {
  return db.first<StoredPlace>(
    `SELECT s.id, s.in_reply_to_id AS linked, COALESCE(p.uri, s.in_reply_to_uri) AS parent,
				(SELECT a.uri FROM accounts a INDEXED BY ${ACCOUNTS_ID_INDEX} WHERE a.id = s.account_id) AS author
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

// The author of a document a step fetched (inbox.ts fetchedAuthor: a stored one, refetched first when stale, or an
// unknown one fetched and stored by `store` once the caller's checks pass): null for one of which nothing is stored (no
// author, one off the status's origin, ID-6, one whose deletion has started, ID-7, or one that cannot be fetched).
function authorFound(
  db: Db,
  status: RemoteStatusInput,
  input: ReplyStepInput,
): { need: AuthorNeed } | { store: () => RemoteRow | undefined } | null {
  const authorUri = status.attributedTo;
  if (authorUri === null || !sameOrigin(authorUri, status.uri) || isDeletedActor(db, authorUri, input.now)) {
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
  if (!("reason" in found)) {
    return found;
  }
  if (found.need === undefined) {
    return null;
  }
  const { uri, refresh, state } = found.need;
  return { need: { uri, refresh: refresh === true, ...(state === undefined ? {} : { state }) } };
}

// As any fetched status (StoreContext.fetched): no relation to a local account needed, its mentions and its author's
// subscribers notified only within the real-time window; its quote one hop short of a root's.
function fetchedContext(input: ReplyStepInput) {
  return {
    now: input.now,
    storeNow: input.now,
    origin: input.origin,
    deliveredTo: null,
    fetched: true,
    quoteHops: QUOTE_HOPS - 1,
  };
}

// A stored status's fetched document, applied as its author's Update (storeFetchedStatus: the version rules, the
// fan-out, the quote, R38) when it names the stored author; one naming another changes nothing, as Mastodon's
// Create#find_existing_status finds the status by its uri. Its place in the thread is its stored row's either way.
// Returns the author the Store needs first, or null once applied.
function refresh(db: Db, stored: StoredPlace, status: RemoteStatusInput, input: ReplyStepInput): AuthorNeed | null {
  if (status.attributedTo === null || status.attributedTo !== stored.author) {
    return null;
  }
  const found = authorFound(db, status, input);
  if (found === null || "need" in found) {
    return found?.need ?? null;
  }
  const author = found.store();
  if (author !== undefined) {
    storeFetchedStatus(db, author, status, fetchedContext(input));
  }
  return null;
}

// The status step of a node that is not valid yet: its parent judged, then, under a valid parent, a stored status
// refreshed (refresh) or a new one stored with its author. Returns the author the Store needs first, or null once the
// step is applied.
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
    statusFailed(db, walk, node);
    return null;
  }
  const parent = nodeOf(db, walk.id, parentUri);
  if (parent !== undefined && parent.state === DONE && parent.valid === 0) {
    statusFailed(db, walk, node);
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
      statusFailed(db, walk, node);
      return null;
    }
    const need = refresh(db, stored, status, input);
    if (need === null) {
      validate(db, walk, node, repliesOf(false), input, parent.depth);
    }
    return need;
  }
  const found = authorFound(db, status, input);
  if (found !== null && "need" in found) {
    return found.need;
  }
  const stores = found?.store();
  if (stores === undefined) {
    statusFailed(db, walk, node);
    return null;
  }
  const outcome = storeRemoteStatus(db, stores, status, fetchedContext(input));
  if (outcome.reason === "created") {
    walk.resultCount += 1;
  }
  if (outcome.statusId === undefined || parentId === undefined || !linkedTo(db, outcome.statusId, parentId)) {
    statusFailed(db, walk, node);
  } else {
    validate(db, walk, node, repliesOf(outcome.reason === "created"), input, parent.depth);
  }
  return null;
}

// Applies a step's fetch to its node. Returns the author the Store needs first, or null once applied.
function applyStep(db: Db, walk: Walk, node: Node, input: ReplyStepInput): AuthorNeed | null {
  const { fetched } = input;
  // A step's end without its document: its status stage failed, or its reading ended.
  const failed = () => (node.stage === 0 ? statusFailed(db, walk, node) : readingEnded(db, walk, node, false));
  if (fetched.kind === "none") {
    return null;
  }
  if (fetched.kind === "transient") {
    // Tried again at the end of the walk, while it has an attempt left.
    if (node.attempts >= NODE_ATTEMPTS) {
      failed();
    } else {
      db.run("UPDATE reply_walk_nodes SET seq = ?3 WHERE status_id = ?1 AND uri = ?2", walk.id, node.uri, walk.nextSeq);
      walk.nextSeq += 1;
    }
    return null;
  }
  // A node's own 404, judged on the row stored under its URI now (one whose Create arrived since its hand-out
  // included); never the root's (valid at its status stage from the walk's start).
  if (fetched.kind === "gone" && node.stage === 0 && node.valid === 0) {
    walk.removed = removeGone(db, node.uri, input.now) || walk.removed;
  }
  if (fetched.kind === "failed" || fetched.kind === "gone" || (fetched.kind === "replies") !== (node.stage !== 0)) {
    failed();
    return null;
  }
  if (fetched.kind === "replies") {
    readReplies(db, walk, node, fetched.replies, input);
    return null;
  }
  if (fetched.status.uri !== node.uri) {
    statusFailed(db, walk, node);
    return null;
  }
  // The root: stored (its claim checked it), refreshed, and read for its replies.
  if (node.valid === 1) {
    const stored = storedPlace(db, node.uri);
    const need = stored === undefined ? null : refresh(db, stored, fetched.status, input);
    if (need === null) {
      readReplies(db, walk, node, fetched.replies, input);
    }
    return need;
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
    const step = handOut(db, walk, now);
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
  const store = input.step.stage === "store";
  const node =
    walk === undefined || walk.handout !== input.step.handout || store
      ? undefined
      : nodeOf(db, walk.id, input.step.uri);
  if (walk === undefined || (node === undefined && !(store && walk.handout === input.step.handout))) {
    return { next: null, need: null, done: true, jobsPending: false };
  }
  const need = node === undefined ? null : applyStep(db, walk, node, input);
  if (need !== null) {
    return { next: null, need, done: false, jobsPending: false };
  }
  walk.handout = null;
  const next = input.more ? handOut(db, walk, input.now) : null;
  saveWalk(db, walk);
  const jobsPending = walk.removed;
  if (next === null && !hasWork(db, walk)) {
    finish(db, walk.id, walk.kind, input.now);
    return { next: null, need: null, done: true, jobsPending };
  }
  return { next, need: null, done: false, jobsPending };
});

// The end of a round's turn of a walk: under its claim, the walk is due again at once while a node is pending (a
// create walk waiting in its place, CREATE_WALK_WAITING), else it finishes. Returns whether a walk is due.
export const releaseReplyWalk = writeOperation.atStoreTime("now")<
  { statusId: string; token: string; now: number },
  boolean
>((db, { statusId, token, now }) => {
  const walk = walkOf(db, statusId, token);
  if (walk !== undefined) {
    if (hasWork(db, walk)) {
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
    `INSERT INTO reply_walks (status_id, kind, refresh_id, queued_at, due_at, next_seq, nodes, debt_walk)
		VALUES (?1, 0, ?2, ?3, ?3, 1, 1, ?4)
		ON CONFLICT (status_id) DO UPDATE SET kind = 0,
			refresh_id = COALESCE(reply_walks.refresh_id, excluded.refresh_id), queued_at = ?3, due_at = ?3,
			finished_at = NULL, token = NULL, next_seq = 1, nodes = 1, pages = 0, result_count = 0, handouts = 0,
			handout = NULL, debt_walk = ?4, debt_after_walk = NULL, debt_after_seq = NULL, debt_after_pos = NULL,
			debts_seen = 0`,
    statusId,
    newRefreshId(),
    now,
    debtEpoch(db, statusId),
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
