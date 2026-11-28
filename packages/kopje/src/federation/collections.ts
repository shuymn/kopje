import type { DocumentLoader } from "@fedify/fedify";

import { MAX_FEATURED_TAGS } from "../domain/featured-tags";
import {
  type CollectionCounts,
  type CollectionReadInput,
  type CollectionSync,
  type DocumentRefreshInput,
  MAX_REMOTE_PINS,
  type MoveOutcome,
  PART_COLLECTIONS,
  PART_FEATURED,
  PART_MOVED,
  PART_NETWORK,
  PART_TAGS,
  type PinFetchesInput,
} from "../domain/remote-collections";
import { MAX_REMOTE_COLLECTIONS } from "../domain/remote-featured-collections";
import { readConfig, userKek } from "../platform/config";
import { railsPresent } from "../platform/rails-blank";
import { callStore } from "../platform/store-client";
import { storedCount } from "../platform/stored-bounds";
import { goneAt, goneSettler, type SettleGone } from "./actor-gone";
import { featuredCollectionOf } from "./featured-collections";
import { createRemoteLoaders, type FederationState, type RemoteLoaders } from "./federation";
import type { InboxDeps } from "./inbox";
import { itemsOf } from "./json-shapes";
import {
  type DocumentCaps,
  isTransientLoadError,
  REQUEST_MAX_BYTES,
  REQUEST_MAX_FETCHES,
  requestBudget,
} from "./loader";
import { fetchActor } from "./remote-actor";
import { type FetchedStatus, fetchRemoteStatus, idOf } from "./remote-status";
import { confirmedInput } from "./resolve";

// The Worker's part of a sync of a remote account's collections (domain/remote-collections.ts): what Mastodon's
// FetchFeaturedCollectionService, FetchFeaturedTagsCollectionService and ProcessAccountService#collection_info fetch
// (the following, followers and outbox collections, for hide_collections and the counts), read through the safe
// loader (NET-1) within one request's fetch budget per round (RES-6), signed by a local follower of the account or
// else by the instance actor, and never from the signed-document cache (NET-4). Mastodon signs the featured and pin
// fetches with local_follower, as Kopje does, but the network collections as Account.representative
// (json_ld_helper.rb:232-235): Kopje signs them as the others (docs/mastodon-deviations.md, Accounts). The move part
// fetches another account, the destination of a pending move, which has no recipient: as the instance actor (DATA-7),
// as Mastodon's FetchRemoteAccountService fetches it (Account.representative), on the round's one budget. The
// jobs/queue.ts rounds run it after the Store's inbound jobs: a round runs one phase of a sync, reading the
// collections or fetching the listed statuses that reading left to fetch, stored or not.
//
// Differences from Mastodon: a collection is read only on the actor's own origin (Mastodon checks the host for the
// featured collections only); the featured collection's first MAX_REMOTE_PINS items are read; a collection that may be
// read later (a timeout, a 5xx, the budget) leaves that part as it was and is read again in a later round, where
// Mastodon retries the job or, for hide_collections, reads the failure as a hidden collection (and keeps the count).

// Syncs one round runs, each with its own fetch budget.
export const COLLECTION_SYNCS_PER_ROUND = 2;
// Pages of a featuredTags collection read at most (FetchFeaturedTagsCollectionService reads pages until it has
// FeaturedTag::LIMIT items or there is no next page).
export const MAX_FEATURED_TAG_PAGES = 3;
// The most documents each part of a read fetches (domain/remote-collections.ts PART_*): the featured collection and its
// first page, the following, followers and outbox collections, and the featuredTags collection and its pages. A round
// reads the parts not read yet in that order, and records each it reads through, so the parts together may cost more
// than one budget. Each part alone fits a round's budget even with a redirect hop, or the RFC 9421 retry of a signed
// fetch answered 400 or 401 (loader.ts RETRY_STATUSES), on each of its documents, checked as the module loads: a part
// read first in its round always completes, so every round with a healthy part left makes progress. Both on one
// document are not covered: a server that refuses draft-cavage and redirects every document may leave a part unread
// until its attempts run out (RES-6). The document part of a refresh (D9) runs alone in its round: the account's
// document and at most two WebFinger answers confirming its claim (resolve.ts confirmHandle). The move part fetches the
// destination's document and the same two WebFinger answers.
export const PART_DOCUMENTS = {
  moved: 3,
  featured: 2,
  network: 3,
  tags: 1 + MAX_FEATURED_TAG_PAGES,
  document: 3,
  collections: 3,
} as const;

// Whether each part of `parts` fits one round of `maxFetches`, a redirect or an RFC 9421 retry on each document.
export function partsFitRound(parts: Readonly<Record<string, number>>, maxFetches: number): boolean {
  return Math.max(...Object.values(parts)) * 2 <= maxFetches;
}
if (!partsFitRound(PART_DOCUMENTS, REQUEST_MAX_FETCHES)) {
  throw new Error(
    "each part of a collection read must fit one round of REQUEST_MAX_FETCHES, a redirect or an RFC 9421 retry each included",
  );
}
// The network part's documents are read under tighter caps, so that its three fit one round's fetches and bytes
// together whatever the documents are (RES-6): one redirect, or the RFC 9421 retry, each (PART_DOCUMENTS.network × 2
// fetches) and 512 KiB of body each (UTF-8 bytes as served; three take 1.5 MiB of REQUEST_MAX_BYTES). A document past
// them is settled as unreadable: it gives no count, and a following or followers collection past them hides the
// network, as any collection that cannot be read does. The other parts keep the loader's own caps.
export const NETWORK_CAPS = { documentBytes: 512 * 1024, maxRedirects: 1 } as const satisfies DocumentCaps;
if (
  PART_DOCUMENTS.network * (1 + NETWORK_CAPS.maxRedirects) > REQUEST_MAX_FETCHES ||
  PART_DOCUMENTS.network * NETWORK_CAPS.documentBytes >= REQUEST_MAX_BYTES
) {
  throw new Error(
    "the network part must fit one round of REQUEST_MAX_FETCHES and REQUEST_MAX_BYTES under NETWORK_CAPS, a redirect or an RFC 9421 retry each included",
  );
}

// The collections part (PART_COLLECTIONS, #1589's D21) reads the featuredCollections collection and its first
// FEATURED_COLLECTION_PAGES pages (PART_DOCUMENTS.collections documents) under COLLECTIONS_CAPS: no redirect, so the
// loader sends a document at most twice (the signed request and, answered 400 or 401, its RFC 9421 retry), and 512 KiB
// of body each; three such documents fit one round's fetches and bytes, checked as the module loads, so the part read
// first in its round always completes whatever its documents are. A document past the caps or redirected is settled as
// unreadable, as a refused one: the part completes with the collections read before it. Mastodon's pages hold 5
// collections of at most 25 items, served without a redirect (FeaturedCollectionsController).
export const FEATURED_COLLECTION_PAGES = 2;
export const COLLECTIONS_CAPS = { documentBytes: 512 * 1024, maxRedirects: 0 } as const satisfies DocumentCaps;
if (
  PART_DOCUMENTS.collections !== 1 + FEATURED_COLLECTION_PAGES ||
  PART_DOCUMENTS.collections * 2 > REQUEST_MAX_FETCHES ||
  PART_DOCUMENTS.collections * COLLECTIONS_CAPS.documentBytes >= REQUEST_MAX_BYTES
) {
  throw new Error(
    "the collections part must fit one round of REQUEST_MAX_FETCHES and REQUEST_MAX_BYTES under COLLECTIONS_CAPS, an RFC 9421 retry each included",
  );
}

// The move part's actor document is read with no redirect, as Mastodon's fetch_resource (json_ld_helper.rb:242-252,
// allow_redirects false): a destination that redirects settles with nothing. Its body keeps the loader's own cap,
// DOCUMENT_BODY_LIMIT, Mastodon's too.
const MOVED_CAPS = { maxRedirects: 0 } as const satisfies DocumentCaps;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function originOf(uri: string | null): string | null {
  if (uri === null) {
    return null;
  }
  try {
    return new URL(uri).origin;
  } catch {
    return null;
  }
}

// A document on `origin` (Mastodon's non_matching_uri_hosts? refusal): the object, 'transient' when fetching again may
// succeed, or null (refused, gone, not an object, or on another origin). An embedded object is taken as it is.
export async function documentOn(
  value: unknown,
  origin: string | null,
  loader: DocumentLoader,
): Promise<Json | "transient" | null> {
  if (isObject(value)) {
    return value;
  }
  if (typeof value !== "string" || origin === null || originOf(value) !== origin) {
    return null;
  }
  try {
    const document = (await loader(value)).document;
    return isObject(document) ? document : null;
  } catch (error) {
    return isTransientLoadError(error) ? "transient" : null;
  }
}

// The names of the Hashtags among `items`, in order, appended to `names` until it holds MAX_FEATURED_TAGS; the items
// after that are not looked at.
function hashtagNames(items: readonly unknown[], names: string[] = []): string[] {
  for (const item of items) {
    if (names.length >= MAX_FEATURED_TAGS) {
      break;
    }
    if (isObject(item) && item.type === "Hashtag" && typeof item.name === "string") {
      names.push(item.name);
    }
  }
  return names;
}

// ProcessAccountService#collection_info: whether the collection shows its items (a first page). An actor without the
// collection, or whose collection is not a readable object, hides it, as Mastodon reads it; undefined when the fetch
// may pass.
function showsItems(collection: Json | "transient" | null): boolean | undefined {
  if (collection === "transient") {
    return undefined;
  }
  return collection !== null && collection.first !== undefined && collection.first !== null;
}

// collection_info's total_items: a JSON number only (Mastodon's is_a?(Numeric)), its integer part, a negative one read
// as 0 (AccountStat's getters show max(value, 0)); one past MAX_ACCOUNT_COUNT or not finite is not taken (null), as
// storedCount refuses it.
function totalItemsOf(collection: Json | "transient" | null): number | null {
  const total = isObject(collection) ? collection.totalItems : undefined;
  return typeof total === "number" && Number.isFinite(total) ? storedCount(Math.max(Math.trunc(total), 0)) : null;
}

// ProcessAccountService#set_fetchable_attributes!: the following, followers and outbox collections, each fetched (the
// followers even once the following hides, as Mastodon fetches all three for their counts). hide_collections =
// following_private? || followers_private?: hidden as soon as either collection is known to hide its items, shown when
// both are known to show them, and unknown (null: left as it was) otherwise. The counts are each collection's
// totalItems. settled: none of the three may be read later, so the part is read through.
async function readNetwork(
  sync: CollectionSync,
  origin: string | null,
  loader: DocumentLoader,
): Promise<{ hideCollections: boolean | null; counts: CollectionCounts; settled: boolean }> {
  const following = await documentOn(sync.following, origin, loader);
  const followers = await documentOn(sync.followers, origin, loader);
  const outbox = await documentOn(sync.outbox, origin, loader);
  const shows = [showsItems(following), showsItems(followers)];
  return {
    hideCollections: shows.includes(false) ? true : shows.every((shown) => shown === true) ? false : null,
    counts: { statuses: totalItemsOf(outbox), following: totalItemsOf(following), followers: totalItemsOf(followers) },
    settled: ![following, followers, outbox].includes("transient"),
  };
}

// FetchFeaturedCollectionService: the first MAX_REMOTE_PINS items of the first page, null when it cannot be read, or
// 'transient' when it may be read later.
// Among them, Notes (or ids) of the actor's origin are its pins, and Hashtags its featured hashtags when it has no
// featuredTags collection. The items past them are never looked at, whatever they are.
async function readFeatured(
  sync: CollectionSync,
  origin: string | null,
  loader: DocumentLoader,
): Promise<{ uris: string[]; hashtags: string[] } | "transient" | null> {
  const collection = await documentOn(sync.featured, origin, loader);
  if (collection === null || collection === "transient") {
    return collection;
  }
  const page = collection.first === undefined ? collection : await documentOn(collection.first, origin, loader);
  if (page === "transient") {
    return page;
  }
  const items = page === null ? null : (itemsOf(page)?.slice(0, MAX_REMOTE_PINS) ?? null);
  if (items === null) {
    return null;
  }
  const uris = [
    ...new Set(
      items.flatMap((item) => {
        const uri = typeof item === "string" || (isObject(item) && item.type === "Note") ? idOf(item) : null;
        return uri !== null && originOf(uri) === origin ? [uri] : [];
      }),
    ),
  ];
  return { uris, hashtags: hashtagNames(items) };
}

// Phase 2: the statuses of the pending and refresh rows, fetched in order (FetchRemoteStatusService) while the budget
// lasts; one that may be fetched later (the budget spent included) is left out, for a later round.
async function fetchPending(uris: readonly string[], loader: DocumentLoader): Promise<PinFetchesInput["fetched"]> {
  const fetched: PinFetchesInput["fetched"] = {};
  for (const uri of uris) {
    const status = await fetchRemoteStatus(uri, loader);
    if (status.kind !== "transient") {
      fetched[uri] = pinFetched(status, uri);
    }
  }
  return fetched;
}

// What phase 2 hands back of the fetch of `uri`: a usable status, 'gone' for a 404 the status's own URI answered
// (goneAt: none after a redirect, and never a 410, as Mastodon's fetch_status), or null for one that cannot be used.
export function pinFetched(
  status: Exclude<FetchedStatus, { kind: "transient" }>,
  uri: string,
): PinFetchesInput["fetched"][string] {
  return status.kind === "ok" ? status.status : goneAt(status, uri, 404) ? "gone" : null;
}

// FetchFeaturedTagsCollectionService: the Hashtags of its pages, until MAX_FEATURED_TAGS items, a page without items,
// or MAX_FEATURED_TAG_PAGES pages. 'transient' when a page may be read later (Mastodon retries the job), null when the
// collection cannot be read; a later page that cannot be read at all ends it with what was read.
async function readFeaturedTags(
  sync: CollectionSync,
  origin: string | null,
  loader: DocumentLoader,
): Promise<string[] | "transient" | null> {
  const collection = await documentOn(sync.featuredTags, origin, loader);
  if (collection === null || collection === "transient") {
    return collection;
  }
  // The raw items read so far (the paging condition counts them), and the hashtags among them.
  let listedItems = 0;
  const names: string[] = [];
  let page: Json | "transient" | null =
    collection.first === undefined ? collection : await documentOn(collection.first, origin, loader);
  // The page limit is checked before the next page is fetched: page MAX_FEATURED_TAG_PAGES + 1 is never asked for.
  for (let read = 1; isObject(page); read++) {
    const listed = itemsOf(page);
    if (listed === null || listed.length === 0) {
      break;
    }
    listedItems += listed.length;
    hashtagNames(listed, names);
    if (
      listedItems >= MAX_FEATURED_TAGS ||
      read >= MAX_FEATURED_TAG_PAGES ||
      page.next === undefined ||
      page.next === null
    ) {
      break;
    }
    page = await documentOn(page.next, origin, loader);
  }
  if (page === "transient") {
    return page;
  }
  return names;
}

// FetchFeaturedCollectionsCollectionService (collection_items with max_pages): the embedded collections of the root's
// pages (`first`, then each `next`), in order, until MAX_REMOTE_COLLECTIONS or FEATURED_COLLECTION_PAGES pages; a
// collection given only as a URI is skipped (Mastodon fetches it). 'transient' when a document may be read later. A
// page that cannot be read (refused, gone, past the caps, redirected) ends the list with what was read before it.
// complete: every page was read and the last had no next, so the stored collections the list does not name are not
// the owner's any more.
async function readFeaturedCollections(
  sync: CollectionSync,
  origin: string | null,
  loader: DocumentLoader,
): Promise<NonNullable<CollectionReadInput["collections"]> | "transient"> {
  const root = await documentOn(sync.featuredCollections, origin, loader);
  if (root === "transient") {
    return root;
  }
  const listed: CollectionReadInput["collections"] & {} = { listed: [], complete: false };
  if (root === null) {
    return listed;
  }
  let page: Json | "transient" | null =
    root.first === undefined || root.first === null ? root : await documentOn(root.first, origin, loader);
  for (let read = 1; ; read++) {
    if (page === "transient") {
      return page;
    }
    if (page === null) {
      return listed;
    }
    for (const item of itemsOf(page) ?? []) {
      const collection = featuredCollectionOf(item);
      if (collection !== null && listed.listed.length < MAX_REMOTE_COLLECTIONS) {
        listed.listed.push(collection);
      }
    }
    if (page.next === undefined || page.next === null) {
      listed.complete = true;
      return listed;
    }
    if (read >= FEATURED_COLLECTION_PAGES) {
      return listed;
    }
    page = await documentOn(page.next, origin, loader);
  }
}

type ReadOut = Pick<
  CollectionReadInput,
  "parts" | "pins" | "tags" | "hideCollections" | "counts" | "collections" | "move"
>;

// The loaders of a read: `document` within the loader's own caps, `network` within NETWORK_CAPS, `collections` within
// COLLECTIONS_CAPS, each signed by the sync's signer; `moved`, the move part's, signed by the instance actor on the
// same budget, built only for a sync that hands a destination over.
type ReadLoaders = {
  document: DocumentLoader;
  network: DocumentLoader;
  collections: DocumentLoader;
  moved: (() => RemoteLoaders) | null;
  instanceDomain: string;
};

// ProcessAccountService#moved_account's fetch (FetchRemoteAccountService with break_on_redirect, one hop): the
// destination's document by its id, without a redirect, which must name no movedTo of its own
// (fetch_remote_actor_service.rb:33, Rails' present?), and its claim confirmed by WebFinger (resolve.ts
// confirmedInput; no row of it is stored). A 404 or 410 deletes nothing: the fetch was made for another account.
async function readMoved(movedTo: string, loaders: RemoteLoaders, instanceDomain: string): Promise<MoveOutcome> {
  const final = { kind: "failed", final: true } as const;
  const fetched = await fetchActor(movedTo, loaders.capped(MOVED_CAPS), loaders.context);
  if (fetched.kind === "transient") {
    return { kind: "failed", final: false };
  }
  if (fetched.kind !== "ok" || fetched.input === null || railsPresent(literalMovedTo(fetched.input.raw))) {
    return final;
  }
  const checked = await confirmedInput(loaders, fetched.input, null, instanceDomain);
  if (checked.outcome === "transient") {
    return { kind: "failed", final: false };
  }
  return checked.outcome === "confirmed" ? { kind: "moved", document: checked.input } : final;
}

// The literal movedTo member of a fetched actor document, as Mastodon reads `@json['movedTo']`.
function literalMovedTo(raw: string): unknown {
  const parsed = JSON.parse(raw) as unknown;
  return isObject(parsed) ? parsed.movedTo : undefined;
}

// Each part's read, which records in `out` what it read through.
const PART_READS: [
  number,
  (sync: CollectionSync, origin: string | null, loaders: ReadLoaders, out: ReadOut) => Promise<void>,
][] = [
  // The move part goes first, so attempt 1 of every generation starts with it: four parts that keep failing never take
  // every claim before it. With nothing to fetch it costs nothing. Its bit is the Store's (move_pending), never set
  // here.
  [
    PART_MOVED,
    async (sync, _origin, loaders, out) => {
      if (sync.movedTo !== null && loaders.moved !== null) {
        out.move = await readMoved(sync.movedTo, loaders.moved(), loaders.instanceDomain);
      }
    },
  ],
  // The featured collection: its pins, and its hashtags for an actor without a featuredTags collection (that part is
  // read with it). One that cannot be read at all is read through: nothing changes, as with Mastodon.
  [
    PART_FEATURED,
    async (sync, origin, loaders, out) => {
      const read = sync.featured === null ? null : await readFeatured(sync, origin, loaders.document);
      if (read !== "transient") {
        out.parts |= PART_FEATURED | (sync.featuredTags === null ? PART_TAGS : 0);
        out.pins = read === null ? null : { uris: read.uris };
        out.tags = sync.featuredTags === null ? (read?.hashtags ?? null) : out.tags;
      }
    },
  ],
  // What was learned is applied in every round; the part is read through once none of its documents may be read later.
  [
    PART_NETWORK,
    async (sync, origin, loaders, out) => {
      const read = await readNetwork(sync, origin, loaders.network);
      out.hideCollections = read.hideCollections;
      out.counts = read.counts;
      out.parts |= read.settled ? PART_NETWORK : 0;
    },
  ],
  [
    PART_TAGS,
    async (sync, origin, loaders, out) => {
      const listed = await readFeaturedTags(sync, origin, loaders.document);
      if (listed !== "transient") {
        out.parts |= PART_TAGS;
        out.tags = listed;
      }
    },
  ],
  // The featuredCollections collection; an actor without one has the part read at once, changing nothing.
  [
    PART_COLLECTIONS,
    async (sync, origin, loaders, out) => {
      const read =
        sync.featuredCollections === null ? null : await readFeaturedCollections(sync, origin, loaders.collections);
      if (read !== "transient") {
        out.parts |= PART_COLLECTIONS;
        out.collections = read;
      }
    },
  ],
];

// Phase 1: what a round reads of one account's collections: the parts not read through yet, in the order of PART_READS,
// starting from the one the round's attempt names. A round after one without progress starts
// with the next unread part, so each gets a round where it goes first with the whole budget (a part that keeps failing
// does not spend every round's budget before a healthy one) before MAX_SYNC_ATTEMPTS gives the read up.
async function readCollections(sync: CollectionSync, loaders: ReadLoaders): Promise<ReadOut> {
  const origin = originOf(sync.accountUri);
  const out: ReadOut = {
    parts: 0,
    pins: null,
    tags: null,
    hideCollections: null,
    counts: { statuses: null, following: null, followers: null },
    collections: null,
    move: null,
  };
  const unread = PART_READS.filter(
    ([part]) => (sync.parts & part) === 0 && !(part === PART_TAGS && sync.featuredTags === null),
  );
  const first = unread.length === 0 ? 0 : (Math.max(sync.attempt, 1) - 1) % unread.length;
  for (const [, read] of [...unread.slice(first), ...unread.slice(0, first)]) {
    await read(sync, origin, loaders, out);
  }
  return out;
}

// The document part (D9): the account's document, fetched as the sync's other documents are, and its claim confirmed
// against the handle read at the claim (an invalidated one, which equals no claim). A 410 at the account's own URI
// deletes it under the revision read at the claim, as any fetch of a stored actor does (actor-gone.ts); jobsPending:
// its purge has a batch for a round. A failure of the fetch or of the confirmation that may pass is 'transient', for a
// later round.
async function refetchDocument(
  sync: CollectionSync,
  loaders: RemoteLoaders,
  instanceDomain: string,
  settle: SettleGone,
): Promise<{ document: DocumentRefreshInput["document"]; jobsPending: boolean }> {
  const fetched = await fetchActor(sync.accountUri, loaders.document, loaders.context);
  if (fetched.kind === "gone") {
    return { document: "gone", jobsPending: (await settle(fetched, sync.accountUri, sync.state.revision)).jobsPending };
  }
  if (fetched.kind !== "ok") {
    return { document: fetched.kind === "unusable" ? null : fetched.kind, jobsPending: false };
  }
  if (fetched.input === null) {
    return { document: null, jobsPending: false };
  }
  const checked = await confirmedInput(loaders, fetched.input, sync.state.handle, instanceDomain);
  return { document: checked.outcome === "transient" ? "transient" : checked.input, jobsPending: false };
}

// One round: up to COLLECTION_SYNCS_PER_ROUND syncs, each claimed, its phase run and handed back. pending: another
// waits, or a purge a document part started (refetchDocument) or a removal a pin fetch started (completePinFetches)
// has a batch left; delivers: a read recorded deliveries (completeCollectionRead), which the jobs round rings for.
// `progress.delivers` is set as each such read commits, so a later call of the round that throws loses none of it
// (queue.ts runFamilies reads it at the family's error boundary). A Store refusal (maintenance) surfaces as
// StoreUnavailableError for the caller; a claimed sync whose round died is claimed again after its lease.
export async function syncCollectionsRound(
  env: Env,
  deps: InboxDeps,
  progress: { delivers: boolean } = { delivers: false },
): Promise<{ pending: boolean; delivers: boolean }> {
  const build = deps.build(env);
  const store = () => deps.store(env);
  const domain = await callStore(() => store().instanceDomain(build));
  if (domain === null) {
    return { pending: false, delivers: false };
  }
  const origin = `https://${domain}`;
  const config = readConfig(env);
  const settle = goneSettler(store, build, deps.now);
  let pending = false;
  let goneJobs = false;
  for (let round = 0; round < COLLECTION_SYNCS_PER_ROUND; round++) {
    const sync = await callStore<CollectionSync | "more" | null>(() =>
      store().claimCollectionSync(build, { now: deps.now() }),
    );
    if (sync === null) {
      return { pending: goneJobs, delivers: progress.delivers };
    }
    if (sync === "more") {
      // The claim spent its allowance dropping syncs; more are due.
      pending = true;
      continue;
    }
    pending = sync.pending;
    const state: FederationState = { resolvedUsername: null, source: null, storeError: null, ticket: null };
    const federation = {
      domain,
      build,
      store,
      kek: config.ok ? userKek(config.config) : "",
      now: deps.now,
      keygen: deps.keygen,
      loader: deps.loader,
    };
    const budget = requestBudget(Date.now());
    const loaders = createRemoteLoaders(federation, state, sync.signer, budget);
    const round = { origin, accountUri: sync.accountUri, generation: sync.generation, token: sync.token };
    if (sync.phase === "document") {
      const { document, jobsPending } = await refetchDocument(sync, loaders, domain, settle);
      if (state.storeError !== null) {
        throw state.storeError;
      }
      goneJobs ||= jobsPending;
      pending = await callStore(() =>
        store().completeDocumentRefresh(build, { ...round, now: deps.now(), revision: sync.state.revision, document }),
      );
    } else if (sync.phase === "read") {
      const read = await readCollections(sync, {
        document: loaders.document,
        network: loaders.capped(NETWORK_CAPS),
        collections: loaders.capped(COLLECTIONS_CAPS),
        moved: sync.movedTo === null ? null : () => createRemoteLoaders(federation, state, null, budget),
        instanceDomain: domain,
      });
      if (state.storeError !== null) {
        throw state.storeError;
      }
      const ended = await callStore(() =>
        store().completeCollectionRead(build, {
          ...round,
          now: deps.now(),
          ...read,
          movedTo: sync.movedTo,
          sourceRevision: sync.sourceRevision,
        }),
      );
      pending = ended.pending;
      progress.delivers ||= ended.delivers;
    } else {
      const fetched = await fetchPending(sync.uris, loaders.document);
      if (state.storeError !== null) {
        throw state.storeError;
      }
      const ended = await callStore(() => store().completePinFetches(build, { ...round, now: deps.now(), fetched }));
      pending = ended.pending;
      goneJobs ||= ended.jobsPending;
    }
  }
  return { pending: pending || goneJobs, delivers: progress.delivers };
}

// A round of syncCollectionsRound: whether another waits.
export async function syncCollections(env: Env, deps: InboxDeps): Promise<boolean> {
  return (await syncCollectionsRound(env, deps)).pending;
}
