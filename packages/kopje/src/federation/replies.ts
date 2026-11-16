import type { DocumentLoader } from "@fedify/fedify";

import type { RemoteRepliesInput } from "../domain/remote-status-reads";
import {
  type AuthorNeed,
  type ClaimedWalk,
  type RepliesRead,
  REPLY_READ_ENTRIES,
  REPLY_WALK_LEASE_MS,
  type ReplyStep,
  type ReplyStepAnswer,
  type ReplyStepInput,
  type StepFetched,
} from "../domain/reply-walks";
import { readConfig, userKek } from "../platform/config";
import { errorFields } from "../platform/error-message";
import { callStore, type StoreStub } from "../platform/store-client";
import { StoreUnavailableError } from "../platform/store-errors";
import { goneAt, goneSettler, type SettleGone } from "./actor-gone";
import { documentOn } from "./collections";
import {
  afterRevisionRead,
  createRemoteLoaders,
  type FederationDeps,
  type FederationState,
  type RemoteLoaders,
} from "./federation";
import type { InboxDeps } from "./inbox";
import { isObject, itemsOf } from "./json-shapes";
import { REQUEST_DEADLINE_MS, requestBudget } from "./loader";
import { loadActor } from "./quotes";
import type { FetchedActor } from "./remote-actor";
import { createPageItems, createRepliesOf, fetchRemoteStatus, idOf, statusIdentity } from "./remote-status";

// The Worker's part of a walk of a remote replies collection (domain/reply-walks.ts; Mastodon 4.7.5's
// FetchAllRepliesWorker and FetchReplyWorker), run only by the job rounds (jobs/queue.ts, from the Queue and cron). A
// round claims up to REPLY_WALKS_PER_ROUND walks one after another and runs up to REPLY_STEPS_PER_WALK steps of each:
// a step fetches the one document of the node the Store handed out (its status, its replies collection, or a page),
// and the status's author when the Store asks for it, through the safe loader (NET-1) within a whole fetch budget of
// its own (RES-6), signed by the instance actor, as Mastodon's representative signs these fetches (DATA-7), and never
// from the signed-document cache (NET-4); then the Store applies it and hands out the next node, which the step has
// already been charged for. Embedded replies and pages are read in the step that holds them, at most
// REPLY_READ_ENTRIES entries past the step's skip; the Store has the rest read by a step that reads the same document
// again (RepliesRead). Nothing of this instance's origin is fetched, and a collection or page only on its node's
// origin. A create walk's steps read as Create#fetch_replies reads (remote-status.ts createRepliesOf): a node's first
// page only, its first items on the node's origin.

// Walks one round runs, and the steps of each.
export const REPLY_WALKS_PER_ROUND = 2;
export const REPLY_STEPS_PER_WALK = 8;
// A walk's turn ends by its steps' deadlines (REQUEST_DEADLINE_MS each), so its claim outlasts it twice over.
if (REPLY_WALK_LEASE_MS < 2 * REPLY_STEPS_PER_WALK * REQUEST_DEADLINE_MS) {
  throw new Error("REPLY_WALK_LEASE_MS must be at least twice a walk's REPLY_STEPS_PER_WALK steps");
}

type Json = Record<string, unknown>;

function originOf(uri: string): string | null {
  try {
    return new URL(uri).origin;
  } catch {
    return null;
  }
}

// The chain of `page`: its entries and those of the pages it embeds as next, by raw position across them. The first
// `skip` are passed over, then at most REPLY_READ_ENTRIES taken as ids (JsonLdHelper#value_or_id: an embedded object
// gives only its id), each an http(s) id within STATUS_URI_LIMIT or null. 'more' when an entry is left past the cap;
// otherwise the URI next the chain ends naming, the next step's, which the Store takes only on the node's origin.
function readPages(page: Json, skip: number): RepliesRead {
  const entries: (string | null)[] = [];
  let position = 0;
  let current: Json = page;
  for (;;) {
    for (const item of itemsOf(current) ?? []) {
      if (position < skip) {
        position += 1;
        continue;
      }
      if (entries.length >= REPLY_READ_ENTRIES) {
        return { entries, from: skip, next: "more" };
      }
      entries.push(statusIdentity(idOf(item)));
      position += 1;
    }
    const next: unknown = current.next;
    if (!isObject(next)) {
      const uri = statusIdentity(next);
      return { entries, from: skip, next: uri === null ? null : { stage: "page", uri } };
    }
    current = next;
  }
}

// A collection (JsonLdHelper#collection_items): its first page's chain, read now when embedded or fetched in the next
// step, the skip carried, when a URI; a collection without one is read as its own page.
function readCollection(collection: Json, skip: number): RepliesRead {
  const first = collection.first;
  if (first === undefined || first === null) {
    return readPages(collection, skip);
  }
  if (isObject(first)) {
    return readPages(first, skip);
  }
  const uri = statusIdentity(first);
  return { entries: [], from: null, next: uri === null ? null : { stage: "page", uri } };
}

// A status's replies: an embedded collection read now, a URI fetched in the next step (the skip carried); null for
// none.
function repliesOf(value: unknown, skip: number): RepliesRead | null {
  if (isObject(value)) {
    return readCollection(value, skip);
  }
  const uri = statusIdentity(value);
  return uri === null ? null : { entries: [], from: null, next: { stage: "collection", uri } };
}

// A create walk's reading of a status's replies or of a collection document (createRepliesOf): its first page's items
// now, or the URI to read in the next step.
function createRead(replies: RemoteRepliesInput | null): RepliesRead | null {
  if (replies === null) {
    return null;
  }
  return "items" in replies
    ? { entries: replies.items, from: 0, next: null }
    : { entries: [], from: null, next: { stage: replies.stage, uri: replies.uri } };
}

// One step's document: the node's status (parsed as inbound statuses are; its id is checked by the Store) and its
// replies, or a collection or page document, or the status again for its replies only, fetched only on the node's
// origin (documentOn: Mastodon's non_matching_uri_hosts? refusal), and read as the walk's kind reads. Nothing of this
// instance's origin is fetched.
async function fetchStep(
  step: ReplyStep,
  origin: string,
  loader: DocumentLoader,
  kind: ClaimedWalk["kind"],
): Promise<StepFetched> {
  const nodeOrigin = originOf(step.uri);
  if (nodeOrigin === null || nodeOrigin === origin) {
    return { kind: "failed" };
  }
  if (step.stage === "status") {
    let document: unknown;
    const fetched = await fetchRemoteStatus(step.fetch, async (url, options) => {
      const loaded = await loader(url, options);
      document = loaded.document;
      return loaded;
    });
    if (fetched.kind !== "ok") {
      // Only a 404 the status's own URI answered, with no redirect, may remove it (the Store judges which node).
      return goneAt(fetched, step.uri, 404)
        ? { kind: "gone" }
        : { kind: fetched.kind === "transient" ? "transient" : "failed" };
    }
    const replies =
      kind === "create"
        ? createRead(fetched.status.replies ?? null)
        : isObject(document)
          ? repliesOf(document.replies, step.skip)
          : null;
    return { kind: "status", status: fetched.status, replies };
  }
  const read = await documentOn(step.fetch, nodeOrigin, loader);
  if (read === "transient") {
    return { kind: "transient" };
  }
  if (read === null) {
    return { kind: "failed" };
  }
  const replies =
    kind === "create"
      ? step.stage === "collection"
        ? (createRead(createRepliesOf(read, nodeOrigin)) ?? { entries: [], from: 0, next: null })
        : { entries: createPageItems(read, nodeOrigin), from: 0, next: null }
      : step.stage === "collection"
        ? readCollection(read, step.skip)
        : step.stage === "page"
          ? readPages(read, step.skip)
          : (repliesOf(read.replies, step.skip) ?? { entries: [], from: null, next: null });
  return { kind: "replies", replies };
}

// The author a step's completion asked for, loaded as a quoted status's is (quotes.ts loadActor): its document with its
// claim confirmed against the handle the need read, or 'gone'. An unknown author (no state) whose claim WebFinger
// refuses gives no document (null), so the Store stores neither it nor its status. A fetch or confirmation that may
// pass is 'transient', which fails the step unless the author is a stale stored one (its stored row is used: null).
// gone: the fetch's own outcome when the author is gone, which the caller settles (actor-gone.ts).
async function fetchAuthor(
  need: AuthorNeed,
  origin: string,
  loaders: RemoteLoaders,
): Promise<{ author: NonNullable<ReplyStepInput["author"]> | "transient"; gone?: FetchedActor }> {
  const { author, gone } = await loadActor(need.uri, origin, loaders, need.state?.handle ?? null);
  if (author.kind === "transient" && !need.refresh) {
    return { author: "transient" };
  }
  const document = author.kind === "ok" ? author.value : author.kind === "gone" ? "gone" : null;
  const revision = need.state === undefined ? {} : { revision: need.state.revision };
  return { author: { uri: need.uri, document, ...revision }, ...(gone === undefined ? {} : { gone }) };
}

// A Store refusal inside a loader (a signing key's RPC in maintenance) made the fetch fail: no outcome of the step's.
// The round stops before submitting anything.
function rethrowStoreError(state: FederationState): void {
  if (state.storeError !== null) {
    throw state.storeError;
  }
}

type Turn = {
  build: string;
  origin: string;
  store: () => StoreStub;
  federation: FederationDeps;
  state: FederationState;
  // What a gone author's document does (actor-gone.ts).
  settle: SettleGone;
  // A step started a status's removal (domain/remote-removal.ts removeGone), whose batches the inbound job rounds run.
  removed: () => void;
};

// A round's turn of one claimed walk: up to REPLY_STEPS_PER_WALK steps, each with loaders and a fetch budget of its
// own; a completion is told `more` only while another step of the turn will follow. A step the Store cannot apply (a
// document it cannot store) ends the turn, its charge kept. The walk is released at the end. Returns whether a walk is
// due.
async function walkTurn(turn: Turn, claim: ClaimedWalk): Promise<boolean> {
  const { build, origin, store, federation, state, settle } = turn;
  const deadline = Date.now() + REPLY_STEPS_PER_WALK * REQUEST_DEADLINE_MS;
  let step: ReplyStep | null = claim.step;
  for (let n = 0; step !== null; n++) {
    const loaders = createRemoteLoaders(federation, state, null, requestBudget(Date.now()));
    const fetched = await fetchStep(step, origin, loaders.document, claim.kind);
    rethrowStoreError(state);
    const input = {
      origin,
      statusId: claim.statusId,
      token: claim.token,
      step,
      more: n + 1 < REPLY_STEPS_PER_WALK && Date.now() < deadline,
      fetched,
    };
    let answer: ReplyStepAnswer;
    try {
      answer = await callStore(() => store().completeReplyStep(build, input));
      if (answer.need !== null) {
        // A revision read after the step's first fetch takes a fresh memo (afterRevisionRead).
        const need = answer.need;
        const { author, gone } = await fetchAuthor(
          need,
          origin,
          need.state === undefined ? loaders : afterRevisionRead(loaders),
        );
        rethrowStoreError(state);
        // A stored author whose own URI answered 410 is deleted under the revision the need read, before the step.
        if (gone !== undefined) {
          await settle(gone, need.uri, need.state?.revision);
        }
        const retried =
          author === "transient" ? { ...input, fetched: { kind: "transient" } as const } : { ...input, author };
        answer = await callStore(() => store().completeReplyStep(build, retried));
      }
    } catch (error) {
      if (error instanceof StoreUnavailableError) {
        throw error;
      }
      console.error({ event: "kopje.replies.step.failed", ...errorFields(error) });
      break;
    }
    if (answer.jobsPending) {
      turn.removed();
    }
    step = answer.need === null ? answer.next : null;
  }
  return callStore(() => store().releaseReplyWalk(build, { statusId: claim.statusId, token: claim.token }));
}

// One job round (jobs/queue.ts): up to REPLY_WALKS_PER_ROUND walks, claimed one after another. Returns whether a walk
// is due, or a deletion a gone author's 410 started has its purge a batch left, or a step started a status's removal. A
// Store refusal surfaces as StoreUnavailableError for the caller; a walk whose round died is claimed again after its
// lease, its charges kept.
export async function walkReplies(env: Env, deps: InboxDeps): Promise<boolean> {
  const build = deps.build(env);
  const store = () => deps.store(env);
  const domain = await callStore(() => store().instanceDomain(build));
  if (domain === null) {
    return false;
  }
  const config = readConfig(env);
  // Whether a deletion a 410 started (actor-gone.ts) left its purge a batch, or a step started a status's removal: the
  // round asks for another.
  let goneJobs = false;
  const settled = goneSettler(store, build, deps.now);
  const turn: Turn = {
    build,
    origin: `https://${domain}`,
    store,
    federation: {
      domain,
      build,
      store,
      kek: config.ok ? userKek(config.config) : "",
      now: deps.now,
      keygen: deps.keygen,
      loader: deps.loader,
    },
    state: { resolvedUsername: null, source: null, storeError: null, ticket: null },
    settle: async (fetched, uri, revision) => {
      const gone = await settled(fetched, uri, revision);
      goneJobs ||= gone.jobsPending;
      return gone;
    },
    removed: () => {
      goneJobs = true;
    },
  };
  let pending = false;
  for (let w = 0; w < REPLY_WALKS_PER_ROUND; w++) {
    const claim = await callStore<ClaimedWalk | "more" | null>(() => store().claimReplyWalk(build));
    if (claim === null) {
      return goneJobs;
    }
    pending = claim === "more" ? true : await walkTurn(turn, claim);
  }
  return pending || goneJobs;
}
