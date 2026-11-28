import type { Db } from "../db/sql";
import { sameOrigin } from "../platform/http-url";
import { storedCount } from "../platform/stored-bounds";
import { availableSql, requiresMention, type Visibility } from "./audience";
import { actorCollections, type ActorCollections, fetchableMove, namedMove } from "./collection-requests";
import { outboundMark, outboundSince } from "./deliveries";
import {
  displayName,
  featurableName,
  featuredTagNamed,
  featuresMost,
  MAX_FEATURED_TAGS,
  writeFeatured,
} from "./featured-tags";
import { type FollowerSigner, localFollower } from "./follower-signer";
import { isIntegerText } from "./ids";
import { instanceDomainOf } from "./instance-domain";
import { writeOperation } from "./operation";
import {
  type ActorState,
  actorState,
  NO_ACTOR_STATE,
  type DocumentRevision,
  moveTarget,
  type RemoteActorInput,
  upsertRemoteActor,
} from "./remote-actors";
import {
  applyFeaturedCollection,
  deleteUnlisted,
  type FeaturedCollectionInput,
  holdableCollection,
  MAX_REMOTE_COLLECTIONS,
} from "./remote-featured-collections";
import { removeGone } from "./remote-removal";
import { type RemoteStatusInput, statusByUri } from "./remote-status-reads";
import { storeFetchedStatus } from "./remote-statuses";
import { isHashtagName } from "./status-text";
import { normalizeTag } from "./tag-name";

// What Kopje learns of a remote account's collections (Mastodon 4.5's ActivityPub::ProcessAccountService,
// SynchronizeFeaturedCollectionWorker and SynchronizeFeaturedTagsCollectionWorker with their Fetch*Service, and
// ActivityPub::Activity::Add and Remove): its pinned statuses (the featured collection), its featured hashtags (the
// featuredTags collection), whether it hides its network (hide_collections), and its counts (the totalItems of its
// followers, following and outbox collections, ProcessAccountService#set_fetchable_attributes!). They go in the rows a
// local account's go in (status_pins, featured_tags, migration 0025_remote_collections) and accounts.hide_collections
// and *_count, so the profile reads (timelines.ts accountStatuses with pinned, featured-tags.ts accountFeaturedTags,
// R13 in audience.ts, and the presented counts) serve a remote account through the same rules.
//
// When the account's document is stored (remote-actors.ts upsertRemoteActor, every path that stores one), a sync is
// requested (collection_syncs, one row per account): the Worker's inbound job rounds (jobs/queue.ts) claim a few, read
// the collections and then fetch every status the featured collection lists on the account's origin, those Kopje does
// not have and those it does, through the safe loader within one request's fetch budget each
// (federation/collections.ts), and hand back what they read (completeCollectionRead, completePinFetches). An Add or a
// Remove whose target is the actor's own featured or featuredTags collection changes one row (inbox.ts add and remove).
//
// Every input is the remote server's: a collection is read only on the actor's own host, an item is fetched only on
// that host and applied only when it is the actor's own status there (a 404 at its own URI removes it whoever's, as
// Mastodon's), at most MAX_REMOTE_PINS pins and MAX_FEATURED_TAGS hashtags are kept, and a hashtag must be a valid
// name.

// The most pins a remote account keeps. Mastodon keeps any number for a remote account (StatusPinValidator limits
// local accounts to five) but reads only the first page of the collection; Kopje bounds them, so the pinned read of a
// remote profile stays bounded.
export const MAX_REMOTE_PINS = 20;
// Rounds of one sync that end with nothing done before it is dropped, how long a claim holds it from other rounds, and
// how long a round that did nothing leaves it before it is due again.
export const MAX_SYNC_ATTEMPTS = 3;
export const SYNC_LEASE_MS = 10 * 60 * 1000;
export const SYNC_RETRY_MS = 15 * 60 * 1000;

// Whether a read claim of these parts (CollectionSync.parts) is in the streak the move part opens: the move is pending
// and nothing else is read through yet, so no claim of the streak has progressed. That streak has one claim more than
// MAX_SYNC_ATTEMPTS, its first, where the move part goes first (federation/collections.ts readCollections); the other
// parts then have MAX_SYNC_ATTEMPTS claims of their own and the rotation a read without a move gives them.
export function moveOpened(parts: number): boolean {
  return parts === 0;
}

// The claims a read streak of these parts has before the read is given up.
function readAttempts(parts: number): number {
  return MAX_SYNC_ATTEMPTS + (moveOpened(parts) ? 1 : 0);
}

// Run just before a writer clears the account's pending bit while its read may be under way (the claim's
// reconciliation, a verified Move): the claim the move part opened, once charged, is counted off, so the claims left
// are exactly a read's without a move (moveOpened): the streak is still the opened one while nothing else is read
// through and the bit is set. Returns whether one was counted off. The read's end settles the bit as progress, which
// starts the count again, so it needs none.
export function countOffMoveClaim(db: Db, accountId: string): boolean {
  return (
    db.run(
      `UPDATE collection_syncs SET attempts = attempts - 1
			WHERE account_id = ?1 AND attempts > 0 AND refresh = 0 AND generation > read_through AND parts_read = 0
				AND collections_read = 0 AND (SELECT move_pending FROM accounts WHERE id = ?1) = 1`,
      accountId,
    ) > 0
  );
}

// The parts of a read (phase 1), each read and applied on its own and recorded once it is, so a round that reads one
// part makes progress whatever the others cost, and a later round reads only the rest: the featured collection (pins),
// the followers, following and outbox collections (hide_collections and the counts), the featuredTags collection
// (featured hashtags; read with the featured collection for an actor without one), and the featuredCollections
// collection (FEP-7aa9 collections, remote-featured-collections.ts), and the destination the account's movedTo names
// when Kopje does not store it (the move part, ProcessAccountService#moved_account). The first three are recorded in
// collection_syncs.parts_read, whose CHECK holds them alone (0025_remote_collections), and the fourth in
// collections_read (0113_featured_collection_syncs); the move part is read while the account's move_pending is 0
// (0125_account_move_pending), which a request leaves as it is. A round reads them as
// parts_read | (collections_read << 3) | ((move_pending = 0) << 4).
export const PART_FEATURED = 1;
export const PART_NETWORK = 2;
export const PART_TAGS = 4;
export const PART_COLLECTIONS = 8;
export const PART_MOVED = 16;
export const ALL_PARTS = PART_FEATURED | PART_NETWORK | PART_TAGS | PART_COLLECTIONS | PART_MOVED;
// The parts parts_read holds.
const STORED_PARTS = PART_FEATURED | PART_NETWORK | PART_TAGS;

// Which of the actor's own collections `target` is (Add#perform and Remove#perform compare it with the account's
// featured_collection_url and collections_url): its featured collection, its featuredTags collection or its
// featuredCollections collection (FEP-7aa9), on its own origin; null for anything else.
export function collectionOf(
  db: Db,
  accountId: string,
  target: string,
): "featured" | "featuredTags" | "featuredCollections" | null {
  const row = db.first<{ uri: string; raw: string | null }>(
    "SELECT uri, raw FROM accounts WHERE id = ? AND domain IS NOT NULL",
    accountId,
  );
  if (row === undefined || !sameOrigin(target, row.uri)) {
    return null;
  }
  const collections = actorCollections(row.raw);
  return target === collections.featured
    ? "featured"
    : target === collections.featuredTags
      ? "featuredTags"
      : target === collections.featuredCollections
        ? "featuredCollections"
        : null;
}

type Pinnable = { id: string; uri: string; account_id: string; reblog_of_id: string | null; visibility: Visibility };

// Whether the account may pin the status (StatusPinValidator): its own original, neither direct nor limited.
function pinnable<T extends Omit<Pinnable, "uri">>(status: T | undefined, accountId: string): status is T {
  return (
    status !== undefined &&
    status.account_id === accountId &&
    status.reblog_of_id === null &&
    !requiresMention(status.visibility)
  );
}

function pinnableStatus(db: Db, statusId: string): Pinnable | undefined {
  return db.first<Pinnable>(
    "SELECT id, uri, account_id, reblog_of_id, visibility FROM statuses WHERE id = ?",
    statusId,
  );
}

// Add#add_featured: the account pins its stored status, unless it pins it already or keeps MAX_REMOTE_PINS. Whether a
// pin was written.
// A pin a sync left pending for the same status becomes this pin: its slot is converted, not added to.
export function pinRemote(db: Db, accountId: string, statusId: string, now: number): boolean {
  const status = pinnableStatus(db, statusId);
  if (!pinnable(status, accountId) || !pinsBelowCap(db, accountId, status.uri)) {
    return false;
  }
  db.run("DELETE FROM collection_pins_pending WHERE account_id = ? AND uri = ?", accountId, status.uri);
  return (
    db.run(
      "INSERT INTO status_pins (account_id, status_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
      accountId,
      statusId,
      new Date(now).toISOString(),
    ) > 0
  );
}

// Whether the account's pins, stored and pending, leave a slot below MAX_REMOTE_PINS for the status `uri`: the slot
// a pending pin of that very status holds counts as free, since pinning it converts that slot, and a refresh row holds
// none. The pins read at most MAX_REMOTE_PINS rows and the sync rows at most MAX_REMOTE_PINS + 1: replacePins writes
// at most MAX_REMOTE_PINS, so a window past that holds an imported excess and counts as full whatever its kinds (it can
// then only refuse a pin, never admit one past the cap), and one at or under it counts its pending rows only.
function pinsBelowCap(db: Db, accountId: string, uri: string): boolean {
  const used = db.first<{ pins: number; raw: number; pending: number | null }>(
    `SELECT (SELECT count(*) FROM (SELECT 1 FROM status_pins WHERE account_id = ?1 LIMIT ?3)) AS pins, w.raw, w.pending
		FROM (SELECT count(*) AS raw, sum(refresh = 0) AS pending
			FROM (SELECT refresh FROM collection_pins_pending WHERE account_id = ?1 AND uri <> ?2 LIMIT ?3 + 1)) w`,
    accountId,
    uri,
    MAX_REMOTE_PINS,
  );
  if (used === undefined) {
    return true;
  }
  const pending = used.raw > MAX_REMOTE_PINS ? MAX_REMOTE_PINS : (used.pending ?? 0);
  return used.pins + pending < MAX_REMOTE_PINS;
}

// Remove#remove_featured: the account's pin of its status, if any.
// A pin a sync left pending (its status not fetched yet) goes too, in the same transaction, so a later round does not
// pin it again, and so does a refresh row of the status; a round that fetched either changes nothing once its row is
// gone (completePinFetches).
export function unpinRemote(db: Db, accountId: string, statusUri: string): boolean {
  const pending = db.run("DELETE FROM collection_pins_pending WHERE account_id = ? AND uri = ?", accountId, statusUri);
  const pinned = db.run(
    `DELETE FROM status_pins WHERE account_id = ?1
		AND status_id = (SELECT id FROM statuses WHERE uri = ?2 AND account_id = ?1)`,
    accountId,
    statusUri,
  );
  return pending + pinned > 0;
}

// FeaturedTag's normalization of a received name (a leading # dropped, surrounding whitespace too), or null when it is
// not a valid hashtag name (FeaturedTag validates the name against Tag::HASHTAG_NAME_RE) or is past the list bound
// (featurableName), which ingestion skips without an error.
function featuredName(name: string): string | null {
  const display = displayName(name);
  return display !== "" && isHashtagName(display) && normalizeTag(display) !== "" && featurableName(display)
    ? display
    : null;
}

// Add#add_featured_tags: the account features the hashtag, unless it does already or features MAX_FEATURED_TAGS.
export function featureRemote(db: Db, accountId: string, name: string, now: number): boolean {
  const display = featuredName(name);
  if (
    display === null ||
    featuredTagNamed(db, accountId, normalizeTag(display)) !== undefined ||
    featuresMost(db, accountId)
  ) {
    return false;
  }
  return writeFeatured(db, accountId, display, now) !== null;
}

// Remove#remove_featured_tags: the account's featured hashtag of that name (FeaturedTag.by_name), if any.
export function unfeatureRemote(db: Db, accountId: string, name: string): boolean {
  const display = displayName(name);
  return (
    display !== "" &&
    db.run("DELETE FROM featured_tags WHERE account_id = ? AND name = ?", accountId, normalizeTag(display)) > 0
  );
}

// ---- Syncs
//
// A sync has two phases, each run in rounds with their own fetch budgets, and durable state between them:
//   1. read: five parts (PART_*): the destination of a pending move (below), the featured collection's first
//      MAX_REMOTE_PINS items (its pins), the followers,
//      following and outbox collections (hide_collections and the counts), the featuredTags collection (the featured
//      hashtags) and the featuredCollections collection's embedded collections (at most MAX_REMOTE_COLLECTIONS, each
//      with its items, applied as remote-featured-collections.ts applies every embedded collection, their items' checks
//      queued for collection-checks.ts, which runs apart from the syncs), each applied as soon as a round has read it
//      through and recorded, so a later round reads only the parts left.
//      The listed statuses Kopje stores that are pinnable are pinned at once. Every listed status on the account's
//      origin gets a row in collection_pins_pending: a pending row (refresh 0) for one Kopje does not store, which holds
//      a pin slot, and a refresh row (refresh 1) for one it stores, which holds none (migration 0101_pin_refresh).
//   2. pins: later rounds fetch the rows' statuses within their budgets, as Mastodon's FetchFeaturedCollectionService
//      fetches every listed status at every sync (v4.7.5 fetch_featured_collection_service.rb:27-41): one fetched is
//      applied as the account's own (storeFetchedStatus) and, for a pending row, pinned; one gone at its own URI is
//      removed (removeGone); one that cannot be used is dropped, and one that may be fetched later stays. The metadata
//      is never read again for them.
// A round makes progress when it reads a part not read before, settles a pending move, or the rows shrink;
// MAX_SYNC_ATTEMPTS claims without progress give up the read (its rows are still fetched) or drop the sync.
// The move part (PART_MOVED) runs while the account's move_pending is 1: work left to the sync, as its stored
// document's movedTo named a destination Kopje did not hold when the document was stored (remote-actors.ts storeActor),
// and may have stored by another path since. A claim that reads or gives the read up (never one of the document part)
// first resolves one stored since (moveTarget), and otherwise hands the id over with the account's document revision; the round fetches it one
// hop as the instance actor (federation/collections.ts), and the read's end settles the bit, writing the move, only
// while the claim's token, that revision and the bit all still hold: a store of the account's document since, or a
// verified Move, leaves the outcome unused. A request that did not store the document leaves the bit, and its fetch
// is still valid. Giving the read up, or dropping the sync, ends the move with nothing (giveUpMove), once the claim has
// taken a destination stored since.
// A sync asked for with refresh (an invalidated account, remote-actors.ts) first runs a document part (D9, Mastodon's
// AccountRefreshWorker): a round refetches the account's document and confirms its claim (federation/collections.ts),
// and completeDocumentRefresh stores it under the revision the claim read, as any store of the actor; that store's own
// request then reads the collections of the refreshed document. The part runs only while the account is an available
// remote account whose handle is invalidated; a refresh asked for one that is not any more is dropped at the claim.
// A failure that may pass leaves the part to a later round; MAX_SYNC_ATTEMPTS claims without progress give it up.

// A sync a round claimed: the account, the collections its stored document names, the phase, the statuses of its
// pending and refresh rows (phase pins, in order), and the local follower whose key signs the fetches (FetchFeaturedCollectionService#
// local_follower: the first available one), or null for the instance actor. generation: the request the round read;
// token: the claim, unique to this round. Both are handed back. pending: another sync is due.
export type CollectionSync = ActorCollections & {
  accountUri: string;
  generation: string;
  token: string;
  phase: "read" | "pins" | "document";
  // Phase document: the account's state read at the claim (actorState), whose revision its document is stored under
  // and whose handle its claim is compared with; no row for the other phases.
  state: ActorState;
  // Phase read: the parts already read for this generation (PART_*), which the round does not read again.
  parts: number;
  // Phase read: the destination of the account's pending move to fetch (collection-requests.ts fetchableMove), and the
  // account's document revision the claim read it from (handed back with the outcome); null when nothing is pending.
  movedTo: string | null;
  sourceRevision: number | null;
  // The round's claim among those since the sync last made progress (1 for the first), which picks the part a read
  // starts with.
  attempt: number;
  uris: string[];
  signer: FollowerSigner | null;
  pending: boolean;
};

// generation is read as TEXT and compared with read_through in SQL (DATA-6).
type SyncRow = {
  account_id: string;
  attempts: number;
  generation: string;
  unread: number;
  parts_read: number;
  collections_read: number;
  refresh: number;
};

// The sync due first, by a seek of collection_syncs_due: the syncs rounds hold are due later, so none is read.
function claimable(db: Db, now: number): SyncRow | undefined {
  return db.first<SyncRow>(
    `SELECT account_id, attempts, CAST(generation AS TEXT) AS generation, generation > read_through AS unread, parts_read,
			collections_read, refresh
		FROM collection_syncs
		WHERE due_at <= ? ORDER BY due_at LIMIT 1`,
    now,
  );
}

// The statuses of the account's pending and refresh rows, in the collection's order (the first listed has the latest
// pin time).
function pendingUris(db: Db, accountId: string): string[] {
  return db
    .all<{ uri: string }>(
      "SELECT uri FROM collection_pins_pending WHERE account_id = ? ORDER BY pinned_at DESC LIMIT ?",
      accountId,
      MAX_REMOTE_PINS,
    )
    .map((row) => row.uri);
}

// A sync given up whole, with the move its read left pending (giveUpMove).
function dropSync(db: Db, accountId: string): void {
  db.run("DELETE FROM collection_pins_pending WHERE account_id = ?", accountId);
  db.run("DELETE FROM collection_syncs WHERE account_id = ?", accountId);
  giveUpMove(db, accountId);
}

// A read given up ends the account's pending move with nothing (accounts.move_pending, 0125_account_move_pending): the
// claim is the one place a pending move ends without a result, so none outlives the read that was to resolve it.
function giveUpMove(db: Db, accountId: string): void {
  db.run("UPDATE accounts SET move_pending = 0 WHERE id = ? AND move_pending = 1", accountId);
}

// The sync due first, claimed for SYNC_LEASE_MS (due again when the lease ends): phase document while a refresh is
// asked for an account whose handle is invalidated (a refresh of another account, or one out of attempts, is given up),
// else phase read while a request has not been read through, else phase pins while statuses are pending. One claimed
// MAX_SYNC_ATTEMPTS times without progress (a read in the streak the move part opens, once more: moveOpened), of an account that is no longer an available remote account
// (ProcessAccountService schedules none for a suspended account, and the services return for one), or with nothing left
// to do, is dropped instead, and the next is taken; at most MAX_SYNC_ATTEMPTS + 1 rows are read. 'more': that many were
// dropped and another is due, for the next claim; null: none is due.
export const claimCollectionSync = writeOperation<{ now: number }, CollectionSync | "more" | null>((db, { now }) => {
  for (let round = 0; round <= MAX_SYNC_ATTEMPTS; round++) {
    const row = claimable(db, now);
    if (row === undefined) {
      return null;
    }
    const account = db.first<{
      uri: string;
      raw: string | null;
      invalid: number;
      move_pending: number;
      revision: number | null;
    }>(
      `SELECT a.uri, a.raw, substr(a.username, 1, 2) = '! ' AS invalid, a.move_pending,
				CASE WHEN typeof(a.document_revision) = 'integer' THEN a.document_revision END AS revision
			FROM accounts a WHERE a.id = ?1 AND a.domain IS NOT NULL AND ${availableSql("?1")}`,
      row.account_id,
    );
    // The prefix test is accounts.ts shownHandle's on the stored username. A refresh is given up when its account's
    // handle is not invalidated any more, or the part ran out of attempts: the read and the pins go on with attempts of
    // their own.
    const refresh = row.refresh === 1 && account?.invalid === 1 && row.attempts < MAX_SYNC_ATTEMPTS;
    if (row.refresh === 1 && !refresh) {
      db.run("UPDATE collection_syncs SET refresh = 0, attempts = 0 WHERE account_id = ?", row.account_id);
      row.attempts = 0;
    }
    let read = row.unread === 1;
    // The account's pending move, reconciled by a claim that reads or gives the read up (never by one of the document
    // part, D3), so a destination stored since the last attempt becomes the move with no further fetch.
    const reconciled =
      read && !refresh && account !== undefined && account.move_pending === 1
        ? pendingMove(db, row.account_id, account)
        : { movedTo: null, countedOff: false };
    const pending = reconciled.movedTo;
    row.attempts -= reconciled.countedOff ? 1 : 0;
    const parts = row.parts_read | (row.collections_read << 3) | (pending === null ? PART_MOVED : 0);
    let limit = read ? readAttempts(parts) : MAX_SYNC_ATTEMPTS;
    // A read that ran out of attempts with rows left to fetch gives way to them: the read is given up, the rows get
    // attempts of their own.
    if (read && row.attempts >= limit && pendingUris(db, row.account_id).length > 0) {
      db.run(
        `UPDATE collection_syncs SET read_through = generation, parts_read = 0, collections_read = 0, attempts = 0
				WHERE account_id = ?`,
        row.account_id,
      );
      giveUpMove(db, row.account_id);
      read = false;
      row.attempts = 0;
      limit = MAX_SYNC_ATTEMPTS;
    }
    const uris = read || refresh ? [] : pendingUris(db, row.account_id);
    if (account === undefined || row.attempts >= limit || (!refresh && !read && uris.length === 0)) {
      dropSync(db, row.account_id);
      continue;
    }
    const movedTo = read ? pending : null;
    const token = crypto.randomUUID();
    // The round reads what the remote serves from now on: no change of the collections is after its read yet.
    db.run(
      `UPDATE collection_syncs SET due_at = ?, token = ?, attempts = attempts + 1, collections_changed = 0
			WHERE account_id = ?`,
      now + SYNC_LEASE_MS,
      token,
      row.account_id,
    );
    return {
      accountUri: account.uri,
      generation: row.generation,
      token,
      phase: refresh ? "document" : read ? "read" : "pins",
      state: refresh ? actorState(db, account.uri) : NO_ACTOR_STATE,
      parts: parts | (movedTo === null ? PART_MOVED : 0),
      movedTo,
      sourceRevision: movedTo === null ? null : account.revision,
      attempt: row.attempts + 1,
      uris,
      ...actorCollections(account.raw),
      signer: localFollower(db, row.account_id),
      pending: claimable(db, now) !== undefined,
    };
  }
  return claimable(db, now) === undefined ? null : "more";
});

// The destination of the account's pending move for the round to fetch, or null once the move is ended here: one the
// account's document names that was stored since (moveTarget) becomes its move, and one the sync may not fetch (only an
// edited dump holds one) ends with nothing, each with the bit in one statement, the claim the move opened counted off
// first (countOffMoveClaim).
function pendingMove(
  db: Db,
  accountId: string,
  account: { uri: string; raw: string | null },
): { movedTo: string | null; countedOff: boolean } {
  const domain = instanceDomainOf(db);
  const fetchable = fetchableMove(account.raw, account.uri, domain === null ? "" : `https://${domain}`);
  const target = moveTarget(db, namedMove(account.raw, account.uri), accountId);
  if (fetchable !== null && target === null) {
    return { movedTo: fetchable, countedOff: false };
  }
  const countedOff = countOffMoveClaim(db, accountId);
  db.run(
    "UPDATE accounts SET moved_to_account_id = ?2, move_pending = 0 WHERE id = ?1 AND move_pending = 1",
    accountId,
    target,
  );
  return { movedTo: null, countedOff };
}

// The end of a round of the account's sync: kept while a request is not read through or statuses are pending, due at
// once with a fresh count of attempts after progress (or a request since the round claimed it), else after
// SYNC_RETRY_MS; deleted when nothing is left. Returns whether a sync is due.
function endRound(db: Db, accountId: string, generation: string, progressed: boolean, now: number): boolean {
  const row = db.first<{ done: number; requested: number }>(
    `SELECT generation <= read_through AND refresh = 0 AS done, generation IS NOT CAST(?2 AS INTEGER) AS requested
		FROM collection_syncs WHERE account_id = ?1`,
    accountId,
    isIntegerText(generation) ? generation : null,
  );
  const pinsLeft = db.first("SELECT 1 AS x FROM collection_pins_pending WHERE account_id = ?", accountId) !== undefined;
  if (row !== undefined && row.done === 1 && !pinsLeft) {
    db.run("DELETE FROM collection_syncs WHERE account_id = ?", accountId);
  } else if (row !== undefined) {
    const renewed = progressed || row.requested === 1;
    db.run(
      `UPDATE collection_syncs SET due_at = ?, token = NULL, attempts = CASE WHEN ? THEN 0 ELSE attempts END
			WHERE account_id = ?`,
      renewed ? now : now + SYNC_RETRY_MS,
      renewed ? 1 : 0,
      accountId,
    );
  }
  return claimable(db, now) !== undefined;
}

type RoundInput = { now: number; origin: string; accountUri: string; generation: string; token: string };

// The account of a round's end, while its claim is the current one (else the round's lease ended and another round
// took the sync, or the sync was deleted and asked for anew: nothing changes) and it is an available remote account
// (a sync of one that is not is dropped).
function roundAccount(db: Db, input: RoundInput): { id: string; uri: string } | null {
  const account = db.first<{ id: string; uri: string; available: number }>(
    `SELECT a.id, a.uri, ${availableSql("a.id")} AS available
		FROM accounts a JOIN collection_syncs c ON c.account_id = a.id AND c.token = ?
		WHERE a.uri = ? AND a.domain IS NOT NULL`,
    input.token,
    input.accountUri,
  );
  if (account === undefined) {
    return null;
  }
  if (account.available !== 1) {
    dropSync(db, account.id);
    return null;
  }
  return account;
}

// What a round of phase 1 read of the account's collections. parts: the parts it read through (PART_*); a part it
// did not is read again later. null: that part's data was not read (or cannot be), and stays as it is.
//   pins: the uris the featured collection lists (its first page, in its order).
//   tags: the names of the Hashtags the featuredTags collection lists (or, for an actor without one, the featured
//         collection: FetchFeaturedCollectionService with hashtag).
//   hideCollections: whether its followers or following collection hides its items (no first page).
//   counts: the totalItems of its outbox, following and followers collections, each null when not learned.
//   collections: the embedded collections its featuredCollections collection lists, in order, at most
//                MAX_REMOTE_COLLECTIONS, and whether the read saw every page with none unreadable (complete), which
//                alone deletes the stored collections it does not list.
export type CollectionReadInput = RoundInput & {
  parts: number;
  // The claim's movedTo and sourceRevision, handed back, and what the move part fetched of the destination (null when
  // it fetched nothing): its document with its claim confirmed ('moved'), or a failure, final or one that may pass.
  movedTo?: string | null;
  sourceRevision?: number | null;
  move?: MoveOutcome | null;
  pins: { uris: string[] } | null;
  tags: string[] | null;
  hideCollections: boolean | null;
  counts: CollectionCounts;
  collections: { listed: FeaturedCollectionInput[]; complete: boolean } | null;
};

export type CollectionCounts = { statuses: number | null; following: number | null; followers: number | null };

export type MoveOutcome = { kind: "moved"; document: RemoteActorInput } | { kind: "failed"; final: boolean };

// Phase 1's end (FetchFeaturedCollectionService#process_note_items and #process_hashtag_items,
// FetchFeaturedTagsCollectionService#process_items, ProcessAccountService#set_fetchable_attributes!): what was read is
// applied, and the parts read are recorded for the generation the round claimed, by a write that names it (not for a
// newer request, whose parts start over, even one asked for inside this transaction); once every part is, the request
// is read through. The round progressed when it read a part not read
// before. Returns whether a sync is due (pending), and whether the read recorded deliveries (delivers: a local member's
// Delete answering a listing, feature-answers.ts answerUnserved), for the jobs round's doorbell.
// hide_collections and the counts are written only while the round's generation is the sync's (`before`): a round
// that read an older document never overwrites what a newer one learns. The pins and hashtags are applied whatever
// the generation: a stale round may still write them, and the newer generation's round, due at once (endRound),
// writes them again. The collections are applied whatever the generation too, unless an inbound change of them
// committed since the round's claim (collections_changed, markCollectionsChanged): the round's listing is then older
// than the stored collections, so it is not applied and the part is left to a later round, which reads it again.
export const completeCollectionRead = writeOperation<CollectionReadInput, { pending: boolean; delivers: boolean }>(
  (db, input) => {
    const account = roundAccount(db, input);
    if (account === null) {
      return { pending: claimable(db, input.now) !== undefined, delivers: false };
    }
    const mark = outboundMark(db);
    if (input.pins !== null) {
      replacePins(db, account, input.pins.uris, input.now);
    }
    if (input.tags !== null) {
      replaceFeaturedTags(db, account.id, input.tags, input.now);
    }
    const outdated =
      input.collections !== null &&
      db.first<{ changed: number }>(
        "SELECT collections_changed AS changed FROM collection_syncs WHERE account_id = ?",
        account.id,
      )?.changed === 1;
    if (input.collections !== null && !outdated) {
      // The round's claim (claimCollectionSync: due SYNC_LEASE_MS after it, which nothing moves while the token holds,
      // requestCollectionSync), before which the documents read cannot be older: a local member's row changed at or
      // after it is not hidden (remote-featured-collections.ts applyListing).
      const claimed = db.first<{ at: number }>(
        "SELECT due_at - ?3 AS at FROM collection_syncs WHERE account_id = ?1 AND token = ?2",
        account.id,
        input.token,
        SYNC_LEASE_MS,
      );
      replaceCollections(db, account, input.collections, input.origin, input.now, claimed?.at ?? input.now);
    }
    const before = isIntegerText(input.generation)
      ? db.first<{ parts_read: number }>(
          `SELECT parts_read | (collections_read << 3) | ((SELECT move_pending = 0 FROM accounts WHERE id = ?1) << 4)
					AS parts_read FROM collection_syncs
				WHERE account_id = ?1 AND generation = CAST(?2 AS INTEGER)`,
          account.id,
          input.generation,
        )
      : undefined;
    const move = settleMove(db, account.id, input);
    // The move part's bit is the account's (move_pending), never the round's own claim of it.
    const moved =
      db.first<{ pending: number }>("SELECT move_pending AS pending FROM accounts WHERE id = ?", account.id)
        ?.pending === 0
        ? PART_MOVED
        : 0;
    const parts =
      ((before?.parts_read ?? 0) & ~PART_MOVED) |
      (input.parts & (outdated ? ALL_PARTS & ~PART_COLLECTIONS & ~PART_MOVED : ALL_PARTS & ~PART_MOVED)) |
      moved;
    if (before !== undefined) {
      if (input.hideCollections !== null) {
        db.run("UPDATE accounts SET hide_collections = ? WHERE id = ?", input.hideCollections ? 1 : 0, account.id);
      }
      writeCounts(db, account.id, input.counts);
      db.run(
        `UPDATE collection_syncs SET parts_read = CASE WHEN ?1 = ?3 THEN 0 ELSE ?1 & ?4 END,
				collections_read = CASE WHEN ?1 = ?3 THEN 0 ELSE (?1 & ?5) >> 3 END,
				read_through = CASE WHEN ?1 = ?3 THEN max(read_through, generation) ELSE read_through END
			WHERE account_id = ?2 AND generation = CAST(?6 AS INTEGER)`,
        parts,
        account.id,
        ALL_PARTS,
        STORED_PARTS,
        PART_COLLECTIONS,
        input.generation,
      );
    }
    // A record that matched but changed no part is no progress: a destination that keeps failing beside parts read
    // through counts its attempts.
    const progressed = move.settled || (before !== undefined && parts !== before.parts_read);
    if (move.store !== null) {
      storeDestination(db, account.id, move.store, input.origin, input.now);
    }
    return {
      pending: endRound(db, account.id, input.generation, progressed, input.now),
      delivers: outboundSince(db, mark),
    };
  },
);

// The move part's outcome, while the claim's fences hold (the token, checked by roundAccount; the account's document
// revision the claim read, which every store of its document and every verified Move renews; the bit still 1, so its
// move is still NULL), and a document of exactly the id fetched: a destination fetched settles the bit, to be stored
// after the parts are recorded (store); a failure settles it with the account a moveTarget finds (stored by another
// path meanwhile), else with nothing when final, and one that may pass changes nothing. settled: the bit was settled
// here.
function settleMove(
  db: Db,
  accountId: string,
  input: CollectionReadInput,
): { settled: boolean; store: { document: RemoteActorInput; movedTo: string } | null } {
  const { move, movedTo, sourceRevision } = input;
  if (move === undefined || move === null || movedTo === undefined || movedTo === null || sourceRevision == null) {
    return { settled: false, store: null };
  }
  const fetched = move.kind === "moved" && move.document.uri === movedTo ? move.document : null;
  const target = fetched === null ? moveTarget(db, movedTo, accountId) : null;
  if (fetched === null && target === null && !(move.kind === "moved" || move.final)) {
    return { settled: false, store: null };
  }
  const settled =
    db.run(
      `UPDATE accounts SET move_pending = 0, moved_to_account_id = ?2
			WHERE id = ?1 AND move_pending = 1 AND document_revision = ?3`,
      accountId,
      target,
      sourceRevision,
    ) > 0;
  return { settled, store: settled && fetched !== null ? { document: fetched, movedTo } : null };
}

// A fetched destination stored as any new remote actor is (upsertRemoteActor under the expectation that no row of it
// is stored, ID-1), and then the source's move to it, or to the row stored by another path since ('superseded');
// nothing when it stores none (a deleted actor, a host or domain an instance suspend block covers, checked here, or a
// handle WebFinger did not confirm). The source's document already names the destination: no revision is issued.
// Stored after the parts are recorded: storing it may invalidate a handle the source holds, which asks for a new
// generation of the source's sync, whose parts start over.
function storeDestination(
  db: Db,
  accountId: string,
  fetched: { document: RemoteActorInput; movedTo: string },
  origin: string,
  now: number,
): void {
  upsertRemoteActor(db, fetched.document, origin, now, null);
  const target = moveTarget(db, fetched.movedTo, accountId);
  if (target !== null) {
    db.run(
      `UPDATE accounts SET moved_to_account_id = ?2
			WHERE id = ?1 AND domain IS NOT NULL AND moved_to_account_id IS NULL AND move_pending = 0`,
      accountId,
      target,
    );
  }
}

// ProcessAccountService#set_fetchable_attributes!: a remote account's counts become the totalItems learned, each that
// storedCount keeps (the others, and those not learned, stay as stored; Mastodon keeps a count it is not given). Local
// accounts' counts are Kopje's own recounts and are never written here.
function writeCounts(db: Db, accountId: string, counts: CollectionCounts): void {
  const statuses = storedCount(counts.statuses);
  const following = storedCount(counts.following);
  const followers = storedCount(counts.followers);
  if (statuses === null && following === null && followers === null) {
    return;
  }
  db.run(
    `UPDATE accounts SET statuses_count = coalesce(?2, statuses_count), following_count = coalesce(?3, following_count),
			followers_count = coalesce(?4, followers_count)
		WHERE id = ?1 AND domain IS NOT NULL`,
    accountId,
    statuses,
    following,
    followers,
  );
}

// What phase 2 fetched of the rows' statuses: a usable status; 'gone' for a 404 that the status's own URI answered,
// without a redirect (federation/actor-gone.ts goneAt); or null for one that cannot be used (refused, a 410, a 404
// after a redirect, not a status). One that may be fetched later is left out.
export type PinFetchesInput = RoundInput & { fetched: Record<string, RemoteStatusInput | "gone" | null> };

// Phase 2's end, each row as it stands now (a row unpinRemote deleted since the claim is skipped): a status fetched is
// stored or updated as the account's own (storeFetchedStatus with the account as the author, as Mastodon's
// FetchRemoteStatusService with expected_actor_uri: a document of another author changes nothing), and a pending row's
// status is then pinned when it is the account's own and pinnable, with the time phase 1 gave it (a refresh row pins
// nothing: phase 1 decided its pin, and an update changes neither author nor visibility); 'gone' removes the status
// stored under the row's URI then, whichever row it was (removeGone); one that cannot be used drops the row and keeps
// the status. The round progressed when the rows shrank. pending: whether a sync is due; jobsPending: a removal started,
// whose batches the inbound job rounds run (inbox.ts runJobBatch).
//
// A pin is stored or updated with no quote budget (quoteHops 0: its quote is recorded with no work, no quoted status it
// embeds is stored, and one Kopje already holds is not promoted: quotes.ts promoteQuote), so a sync stores only the
// account's own statuses and leads to no other author, sync or status (RES-6). A pin's quote is verified when its
// status arrives another way (a delivery, a boost, an Add, a search).
export const completePinFetches = writeOperation.atStoreTime("storeNow")<
  PinFetchesInput & { storeNow: number },
  { pending: boolean; jobsPending: boolean }
>((db, input) => {
  const account = roundAccount(db, input);
  if (account === null) {
    return { pending: claimable(db, input.now) !== undefined, jobsPending: false };
  }
  let done = 0;
  let removed = false;
  for (const [uri, fetched] of Object.entries(input.fetched)) {
    const row = db.first<{ pinned_at: string; refresh: number }>(
      "SELECT pinned_at, refresh FROM collection_pins_pending WHERE account_id = ? AND uri = ?",
      account.id,
      uri,
    );
    if (row === undefined) {
      continue;
    }
    if (fetched === "gone") {
      removed = removeGone(db, uri, input.now) || removed;
    } else if (fetched !== null && fetched.uri === uri) {
      const stored = storeFetchedStatus(db, account, fetched, {
        now: input.now,
        storeNow: input.storeNow,
        origin: input.origin,
        deliveredTo: null,
        fetched: true,
        quoteHops: 0,
      });
      if (row.refresh === 0) {
        // The status stored, or the one it matched by its atomUri (its own id may name no row); the pending entry's
        // slot is the one it takes.
        const status = stored.statusId === undefined ? undefined : pinnableStatus(db, stored.statusId);
        if (pinnable(status, account.id) && pinsBelowCap(db, account.id, uri)) {
          db.run(
            "INSERT INTO status_pins (account_id, status_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
            account.id,
            status.id,
            row.pinned_at,
          );
        }
      }
    }
    done += db.run("DELETE FROM collection_pins_pending WHERE account_id = ? AND uri = ?", account.id, uri);
  }
  return { pending: endRound(db, account.id, input.generation, done > 0, input.now), jobsPending: removed };
});

// What the document part fetched of the account (federation/collections.ts): its document with its claim confirmed or
// refused (RemoteActorInput: confirmed set or null), 'gone' (404 or 410), null when it is unusable, or 'transient' when
// the fetch or the confirmation may pass later. revision: the account's, read at the claim (CollectionSync.state).
export type DocumentRefreshInput = RoundInput & {
  revision: DocumentRevision;
  document: RemoteActorInput | "gone" | "transient" | null;
};

// The document part's end (D9): a document of the account is stored under the revision read at the claim, as any store
// of the actor (upsertRemoteActor: a confirmed handle renamed into, a refused one kept invalidated with the rest of the
// document stored; a document superseded since stores nothing); a document that cannot be used ends the part as well.
// The part is then over (refresh = 0) and the round progressed; a failure that may pass changes nothing, the claim
// having counted its attempt. Returns whether a sync is due.
export const completeDocumentRefresh = writeOperation<DocumentRefreshInput, boolean>((db, input) => {
  const account = roundAccount(db, input);
  if (account === null) {
    return claimable(db, input.now) !== undefined;
  }
  const { document } = input;
  if (document === "transient") {
    return endRound(db, account.id, input.generation, false, input.now);
  }
  if (document !== null && document !== "gone" && document.uri === account.uri) {
    upsertRemoteActor(db, document, input.origin, input.now, input.revision);
  }
  db.run("UPDATE collection_syncs SET refresh = 0 WHERE account_id = ?", account.id);
  return endRound(db, account.id, input.generation, true, input.now);
});

// The account's pins become the statuses the collection lists that are its own and pinnable, the first
// MAX_REMOTE_PINS of them on its origin: those Kopje stores at once, those it does not left pending for phase 2; the
// others are unpinned. Every listed status on the origin among those first MAX_REMOTE_PINS gets a row for phase 2,
// which replaces the rows before: a pending row for one Kopje does not store, a refresh row for one it stores, pinned
// or not (the account's direct or limited status, another author's on its origin), so that phase 2 fetches each as
// Mastodon's FetchFeaturedCollectionService does before it decides the pins. Every pin listed, kept or new, stored or
// pending, takes the time of its position in the collection (the first listed is the newest), so the profile shows
// the collection's order however its pins were learned and whichever of them phase 2 pins later. A stored pin's quote
// is not promoted (completePinFetches says why).
function replacePins(db: Db, account: { id: string; uri: string }, uris: readonly string[], now: number): void {
  const pinned: { id: string; at: string }[] = [];
  const rows: { uri: string; at: string; refresh: 0 | 1 }[] = [];
  [...new Set(uris)].slice(0, MAX_REMOTE_PINS).forEach((uri, i) => {
    if (!sameOrigin(uri, account.uri)) {
      return;
    }
    const at = new Date(now - i).toISOString();
    const status = statusByUri(db, uri);
    rows.push({ uri, at, refresh: status === undefined ? 0 : 1 });
    if (pinnable(status, account.id)) {
      pinned.push({ id: status.id, at });
    }
  });
  db.run(
    "DELETE FROM status_pins WHERE account_id = ? AND status_id NOT IN (SELECT value FROM json_each(?))",
    account.id,
    JSON.stringify(pinned.map((pin) => pin.id)),
  );
  for (const pin of pinned) {
    db.run(
      `INSERT INTO status_pins (account_id, status_id, created_at) VALUES (?, ?, ?)
			ON CONFLICT DO UPDATE SET created_at = excluded.created_at`,
      account.id,
      pin.id,
      pin.at,
    );
  }
  db.run("DELETE FROM collection_pins_pending WHERE account_id = ?", account.id);
  for (const row of rows) {
    db.run(
      "INSERT INTO collection_pins_pending (account_id, uri, pinned_at, refresh) VALUES (?, ?, ?, ?)",
      account.id,
      row.uri,
      row.at,
      row.refresh,
    );
  }
}

// The account's collections become those the read listed (ProcessFeaturedCollectionService for each), the first
// MAX_REMOTE_COLLECTIONS of them, a new one admitted while the account holds fewer than MAX_STORED_COLLECTIONS. A
// complete read first deletes the stored ones it does not list as collections the account may hold, except one holding
// a local member's row (deleteUnlisted), so the slots they held are free for the new ones it lists. `since`: the
// round's claim, which fences the hides of its listings (applyListing).
function replaceCollections(
  db: Db,
  account: { id: string; uri: string },
  read: NonNullable<CollectionReadInput["collections"]>,
  origin: string,
  now: number,
  since: number,
): void {
  const listed = read.listed.slice(0, MAX_REMOTE_COLLECTIONS);
  if (read.complete) {
    deleteUnlisted(
      db,
      account.id,
      listed.filter((input) => holdableCollection(account, input)).map((input) => input.id),
    );
  }
  for (const input of listed) {
    applyFeaturedCollection(db, account, input, origin, now, { kind: "read", since });
  }
}

// The account's featured hashtags become the valid names listed, the first MAX_FEATURED_TAGS of them: the others are
// deleted, one kept takes the spelling listed, and a new one is counted as a local one is (writeFeatured).
function replaceFeaturedTags(db: Db, accountId: string, names: readonly string[], now: number): void {
  const listed = new Map<string, string>();
  for (const name of names) {
    const display = featuredName(name);
    if (display !== null && !listed.has(normalizeTag(display))) {
      listed.set(normalizeTag(display), display);
    }
    if (listed.size >= MAX_FEATURED_TAGS) {
      break;
    }
  }
  db.run(
    "DELETE FROM featured_tags WHERE account_id = ? AND name NOT IN (SELECT value FROM json_each(?))",
    accountId,
    JSON.stringify([...listed.keys()]),
  );
  for (const [name, display] of listed) {
    if (featuredTagNamed(db, accountId, name) === undefined) {
      writeFeatured(db, accountId, display, now);
    } else {
      db.run("UPDATE featured_tags SET display_name = ? WHERE account_id = ? AND name = ?", display, accountId, name);
    }
  }
}
