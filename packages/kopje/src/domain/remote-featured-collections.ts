import { COLLECTION_ITEMS_ID_INDEX, COLLECTIONS_ID_INDEX } from "../db/indexes";
import type { Db } from "../db/sql";
import { sameOrigin } from "../platform/http-url";
import {
  COLLECTION_DESCRIPTION_LENGTH,
  COLLECTION_ITEM_STATES,
  COLLECTION_MAX_ITEMS,
  COLLECTION_NAME_LENGTH,
  COLLECTION_TOTAL_ITEMS_MAX,
  COLLECTION_URI_BYTES,
  COLLECTION_URL_BYTES,
  cutCodePoints,
  MAX_STORED_ITEMS,
  storedText,
  storedTime,
} from "../platform/stored-bounds";
import { sanitizeRemoteCodePoints } from "../security/html";
import { notifyUpdated, remoteCollectionTag } from "./collections";
import { allocateLocalId, insertWithFreshId } from "./ids";
import { blank } from "./lists";
import { isRetracted } from "./retractions";
import { TREND_LANGUAGES } from "./trend-languages";

// Remote accounts' collections (FEP-7aa9, Mastodon 4.7.5's ActivityPub::ProcessFeaturedCollectionService and
// ProcessFeaturedItemService) as Kopje stores them, in the rows of migration 0103_collections. One application serves
// every path that carries an embedded collection or item (#1589's D21): the collections part of a sync
// (remote-collections.ts completeCollectionRead), an inbound Add of a collection or an item and an Update of a
// collection from its owner (inbox.ts). Nothing here fetches: a collection or an item given only as a URI is skipped,
// and a member Kopje does not store is kept by its featuredObject alone, unshown and unchecked, until a later
// application finds the account (never fetched for it: reading an account's collections leads to no other account).
//
// The rules, each the Store's whatever the Worker read:
//   - A collection: its id on its owner's origin and attributedTo exactly the owner (ID-6), at most
//     MAX_REMOTE_COLLECTIONS a remote account, a name of 1 to COLLECTION_NAME_LENGTH.remote code points and a
//     description of sanitized HTML within COLLECTION_DESCRIPTION_LENGTH.remote (both cut as Mastodon cuts them; a NUL
//     refuses the collection, as PostgreSQL refuses it), sensitive and discoverable by Rails' boolean cast (absent:
//     refused, as Collection's inclusion validations refuse it), the language a supported locale or none, the topic a
//     hashtag Tag would take (else refused), totalItems a count the column holds (else refused), url and uri within
//     the stored bounds.
//   - An item (#1589's D22): its id on its collection's origin, its featuredObject a remote account (an item naming a
//     local account is #1589's PR 6 and is not stored), its featureAuthorization on the featuredObject's origin; at
//     most COLLECTION_MAX_ITEMS live in a collection and one item a member. Its revision is its member (account_id, or
//     object_uri while the account is unknown) and its candidate_approval_uri: an unchanged revision changes nothing
//     (its state, accepted, rejected or revoked included, and its queue stay), a new item or a changed revision is
//     pending with the new candidate, no verified authorization, attempts 0, no claim, and queued for a check now
//     while its member is known (collection-checks.ts).

// The collections a remote account keeps (Mastodon reads up to 50) and the items listed in one that are applied
// (Mastodon: 150, ProcessFeaturedCollectionService::ITEMS_LIMIT).
export const MAX_REMOTE_COLLECTIONS = 10;
export const MAX_REMOTE_ITEMS = COLLECTION_MAX_ITEMS;

// An embedded FeaturedItem as the Worker read it (federation/featured-collections.ts): its id, value_or_id of its
// featuredObject and featureAuthorization, and its published as given (a string, else null).
export type FeaturedItemInput = { id: string; object: string; authorization: string | null; published: string | null };

// An embedded FeaturedCollection as the Worker read it, each value as ProcessFeaturedCollectionService reads it:
// attributedTo, name and the topic's name when strings, the summary (summaryMap's first value, else summary, else ''),
// the language (summaryMap's first key), sensitive and discoverable by Rails' boolean cast (null for nil), totalItems
// (0 when absent, null when not an integer the column holds, which refuses the collection), url (url_to_href's), and
// its first MAX_REMOTE_ITEMS orderedItems, null where one is given only as a URI or cannot be read.
export type FeaturedCollectionInput = {
  id: string;
  attributedTo: string | null;
  name: string | null;
  summary: string;
  language: string | null;
  sensitive: boolean | null;
  discoverable: boolean | null;
  totalItems: number | null;
  topic: string | null;
  url: string | null;
  items: (FeaturedItemInput | null)[];
};

type Owner = { id: string; uri: string };

const ENCODER = new TextEncoder();
const LANGUAGES: ReadonlySet<string> = new Set(TREND_LANGUAGES);

// The stored form of a remote URI (stored-bounds.ts httpsUrlWhen): an https URL of printable ASCII within `bytes`.
function storableUrl(value: string | null, bytes: number): value is string {
  return (
    value !== null && /^https:\/\/[!-~]+$/.test(value) && ENCODER.encode(value).length <= bytes && URL.canParse(value)
  );
}

type Values = {
  name: string;
  description: string;
  language: string | null;
  sensitive: number;
  discoverable: number;
  tag: string | null;
  url: string | null;
  total_items: number | null;
};

// The columns `input` gives its collection, or null when Mastodon would not store it, or Kopje cannot store its
// totalItems (docs/mastodon-deviations.md, "Collections"). Its language is kept only when it is one the column holds.
function collectionValues(input: FeaturedCollectionInput): Values | null {
  const total = input.totalItems;
  if (
    input.name === null ||
    input.name.includes("\0") ||
    input.summary.includes("\0") ||
    total === null ||
    !Number.isInteger(total) ||
    total < 0 ||
    total > COLLECTION_TOTAL_ITEMS_MAX
  ) {
    return null;
  }
  const name = storedText(cutCodePoints(input.name, COLLECTION_NAME_LENGTH.remote));
  const tag = input.topic === null ? null : remoteCollectionTag(input.topic);
  if (
    blank(name) ||
    input.sensitive === null ||
    input.discoverable === null ||
    (input.topic !== null && tag === null)
  ) {
    return null;
  }
  const description = storedText(
    sanitizeRemoteCodePoints(
      cutCodePoints(input.summary, COLLECTION_DESCRIPTION_LENGTH.remote),
      COLLECTION_DESCRIPTION_LENGTH.remote,
    ),
  );
  return {
    name,
    description,
    language: input.language !== null && LANGUAGES.has(input.language) ? input.language : null,
    sensitive: input.sensitive ? 1 : 0,
    discoverable: input.discoverable ? 1 : 0,
    tag,
    url: storableUrl(input.url, COLLECTION_URL_BYTES) ? input.url : null,
    total_items: total,
  };
}

// Whether `input` is a collection of `owner` the Store may hold at all: its id on the owner's origin, within the
// stored bound, and attributed to the owner exactly (ProcessFeaturedCollectionService: non_matching_uri_hosts? and
// `attributedTo == @account.uri`).
function ownedCollection(owner: Owner, input: Pick<FeaturedCollectionInput, "id" | "attributedTo">): boolean {
  return (
    storableUrl(input.id, COLLECTION_URI_BYTES) && sameOrigin(input.id, owner.uri) && input.attributedTo === owner.uri
  );
}

// Whether applyFeaturedCollection keeps `input` as the owner's collection when it holds it already: one of the owner's
// with values Mastodon would store.
export function holdableCollection(owner: Owner, input: FeaturedCollectionInput): boolean {
  return ownedCollection(owner, input) && collectionValues(input) !== null;
}

type StoredCollection = { id: string; account_id: string } & Pick<Values, "name" | "description" | "sensitive" | "tag">;

// The collection stored under `uri` (collections_uri), any owner.
function collectionByUri(db: Db, uri: string): StoredCollection | undefined {
  return db.first<StoredCollection>(
    `SELECT id, account_id, name, description, sensitive, tag FROM collections INDEXED BY collections_uri
		WHERE uri = ?`,
    uri,
  );
}

// What applying a collection or an item did: the stored collection's id (null when nothing was stored), and whether an
// item was queued for a check.
export type Applied = { collection: string | null; queued: boolean };

// ProcessFeaturedCollectionService#call: the owner's collection `input` stored or updated, then its items replaced by
// the listing (applyListing); a change of its name, description, sensitivity or tag notifies its local accepted
// members collection_update (NotifyOfCollectionUpdateService). A new collection past MAX_REMOTE_COLLECTIONS of the
// owner, or one whose uri another account's collection holds, is not stored.
export function applyFeaturedCollection(
  db: Db,
  owner: Owner,
  input: FeaturedCollectionInput,
  origin: string,
  now: number,
): Applied {
  const values = ownedCollection(owner, input) ? collectionValues(input) : null;
  if (values === null) {
    return { collection: null, queued: false };
  }
  const at = new Date(now).toISOString();
  const stored = collectionByUri(db, input.id);
  if (stored !== undefined && stored.account_id !== owner.id) {
    return { collection: null, queued: false };
  }
  let id: string;
  if (stored === undefined) {
    const held = db.first<{ n: number }>(
      `SELECT count(*) AS n FROM (SELECT 1 FROM collections INDEXED BY collections_account WHERE account_id = ? LIMIT ?)`,
      owner.id,
      MAX_REMOTE_COLLECTIONS,
    );
    if ((held?.n ?? 0) >= MAX_REMOTE_COLLECTIONS) {
      return { collection: null, queued: false };
    }
    id = insertWithFreshId(
      "collections",
      () => allocateLocalId(db, now),
      (fresh) => {
        db.run(
          `INSERT INTO collections (id, account_id, local, name, description, language, sensitive, discoverable, tag, uri,
						url, total_items, created_at, updated_at)
					VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          fresh,
          owner.id,
          values.name,
          values.description,
          values.language,
          values.sensitive,
          values.discoverable,
          values.tag,
          input.id,
          values.url,
          values.total_items,
          at,
          at,
        );
        return fresh;
      },
    );
  } else {
    id = stored.id;
    // The values compared in SQL, byte for byte (an imported value may not survive a round trip through JavaScript).
    const changed = db.first<{ any: number; notified: number }>(
      `SELECT (name IS NOT ?2 OR description IS NOT ?3 OR language IS NOT ?4 OR sensitive IS NOT ?5
					OR discoverable IS NOT ?6 OR tag IS NOT ?7 OR url IS NOT ?8 OR total_items IS NOT ?9) AS "any",
				(name IS NOT ?2 OR description IS NOT ?3 OR sensitive IS NOT ?5 OR tag IS NOT ?7) AS notified
			FROM collections INDEXED BY ${COLLECTIONS_ID_INDEX} WHERE id = ?1`,
      id,
      values.name,
      values.description,
      values.language,
      values.sensitive,
      values.discoverable,
      values.tag,
      values.url,
      values.total_items,
    );
    if (changed?.any === 1) {
      db.run(
        `UPDATE collections INDEXED BY ${COLLECTIONS_ID_INDEX} SET name = ?2, description = ?3, language = ?4,
					sensitive = ?5, discoverable = ?6, tag = ?7, url = ?8, total_items = ?9, updated_at = ?10
				WHERE id = ?1`,
        id,
        values.name,
        values.description,
        values.language,
        values.sensitive,
        values.discoverable,
        values.tag,
        values.url,
        values.total_items,
        at,
      );
    }
    if (changed?.notified === 1) {
      notifyUpdated(db, id, owner.id, now);
    }
  }
  const queued = applyListing(db, { id, uri: input.id }, input.items, origin, now);
  return { collection: id, queued };
}

type Planned = {
  uri: string;
  position: number;
  member: string | null;
  object: string;
  candidate: string;
  published: string | null;
  existing: string | undefined;
};

type StoredItem = { id: string; collection_id: string };

// An item of `input` the collection may hold, or null: its id on the collection's origin, its featuredObject a remote
// URI (a local member's item is #1589's PR 6), its featureAuthorization on the featuredObject's origin
// (non_matching_actor_and_approval_uris?), each within the stored bound.
function itemOf(
  db: Db,
  collection: { id: string; uri: string },
  input: FeaturedItemInput,
  origin: string,
): Omit<Planned, "position" | "existing"> | null {
  if (
    !storableUrl(input.id, COLLECTION_URI_BYTES) ||
    !sameOrigin(input.id, collection.uri) ||
    !storableUrl(input.object, COLLECTION_URI_BYTES) ||
    sameOrigin(input.object, origin) ||
    !storableUrl(input.authorization, COLLECTION_URI_BYTES) ||
    !sameOrigin(input.authorization, input.object)
  ) {
    return null;
  }
  const member = db.first<{ id: string }>(
    "SELECT id FROM accounts WHERE uri = ? AND domain IS NOT NULL",
    input.object,
  )?.id;
  return {
    uri: input.id,
    member: member ?? null,
    object: input.object,
    candidate: input.authorization,
    published: input.published,
  };
}

// The item stored under `uri` (collection_items_uri), any collection.
function itemByUri(db: Db, uri: string): StoredItem | undefined {
  return db.first<StoredItem>(
    "SELECT id, collection_id FROM collection_items INDEXED BY collection_items_uri WHERE uri = ?",
    uri,
  );
}

// The collection's items become the listing's (ProcessFeaturedCollectionService: the items not listed deleted, each
// listed one processed): the first MAX_REMOTE_ITEMS entries, each it may hold (itemOf) in listed order, one a member
// and an item whose uri another collection holds skipped; every other row of the collection (not listed, not applied,
// whatever its state) is deleted first, so the live and stored triggers never see more than the listing, then each
// listed item applied by the revision rule. Whether an item was queued.
function applyListing(
  db: Db,
  collection: { id: string; uri: string },
  items: readonly (FeaturedItemInput | null)[],
  origin: string,
  now: number,
): boolean {
  const planned: Planned[] = [];
  const members = new Set<string>();
  items.slice(0, MAX_REMOTE_ITEMS).forEach((input, index) => {
    const item = input === null ? null : itemOf(db, collection, input, origin);
    if (item === null || planned.some((other) => other.uri === item.uri)) {
      return;
    }
    if (item.member !== null && members.has(item.member)) {
      return;
    }
    const stored = itemByUri(db, item.uri);
    if (stored !== undefined && stored.collection_id !== collection.id) {
      return;
    }
    if (item.member !== null) {
      members.add(item.member);
    }
    planned.push({ ...item, position: index + 1, existing: stored?.id });
  });
  db.run(
    `DELETE FROM collection_items INDEXED BY collection_items_order WHERE collection_id = ?1
			AND id NOT IN (SELECT value FROM json_each(?2))`,
    collection.id,
    JSON.stringify(planned.flatMap((item) => item.existing ?? [])),
  );
  // A kept row whose member changes gives its member up first, so a member moving between two kept rows never meets
  // the unique member index.
  for (const item of planned) {
    if (item.existing !== undefined) {
      releaseMember(db, item.existing, item, now);
    }
  }
  let queued = false;
  for (const item of planned) {
    queued =
      (item.existing === undefined ? insertItem(db, collection.id, item, now) : reviseItem(db, item, now)) || queued;
  }
  return queued;
}

// An inbound Add of one item to the collection (Add#add_collection_item, ProcessFeaturedItemService): applied by the
// revision rule after every other item, unless the owner's Remove retracted it (ID-7), it is not one the collection
// may hold, another collection holds its uri, another item of the collection holds its member, or the collection has
// no live slot left for a new item (the next read applies the listing). At MAX_STORED_ITEMS rows the oldest retired
// row of the collection is deleted first (collections.ts addCollectionItem). Whether it was queued, or null when
// nothing was applied.
export function applyFeaturedItem(
  db: Db,
  owner: { uri: string },
  collection: { id: string; uri: string },
  input: FeaturedItemInput,
  origin: string,
  now: number,
): boolean | null {
  const item = itemOf(db, collection, input, origin);
  if (item === null || isRetracted(db, owner.uri, item.uri, now)) {
    return null;
  }
  const stored = itemByUri(db, item.uri);
  if (stored !== undefined && stored.collection_id !== collection.id) {
    return null;
  }
  const counts = db.first<{ taken: number; live: number; total: number; last: number | null; retired: number }>(
    `SELECT count(*) FILTER (WHERE account_id = ?2 AND id IS NOT ?3) AS taken,
			count(*) FILTER (WHERE state IN (0, 1)) AS live, count(*) AS total, max(position) AS last,
			count(*) FILTER (WHERE id = ?3 AND state IN (2, 3)) AS retired
		FROM collection_items INDEXED BY collection_items_order WHERE collection_id = ?1`,
    collection.id,
    item.member,
    stored?.id ?? null,
  );
  if ((counts?.taken ?? 0) > 0) {
    return null;
  }
  // A retired row a changed revision would make live needs a live slot as a new one does.
  const full = (counts?.live ?? 0) >= COLLECTION_MAX_ITEMS;
  if (stored !== undefined) {
    return full && counts?.retired === 1
      ? null
      : reviseItem(db, { ...item, position: positionOf(db, stored.id), existing: stored.id }, now);
  }
  if (full) {
    return null;
  }
  if ((counts?.total ?? 0) >= MAX_STORED_ITEMS) {
    db.run(
      `DELETE FROM collection_items INDEXED BY ${COLLECTION_ITEMS_ID_INDEX} WHERE id =
				(SELECT id FROM collection_items INDEXED BY collection_items_order
					WHERE collection_id = ? AND state IN (2, 3) ORDER BY updated_at, id LIMIT 1)`,
      collection.id,
    );
  }
  const position = Math.min((counts?.last ?? 0) + 1, 2_147_483_647);
  return insertItem(db, collection.id, { ...item, position }, now);
}

function positionOf(db: Db, item: string): number {
  return (
    db.first<{ position: number }>(
      `SELECT position FROM collection_items INDEXED BY ${COLLECTION_ITEMS_ID_INDEX} WHERE id = ?`,
      item,
    )?.position ?? 1
  );
}

// The revision of an item as stored and as listed, compared in SQL (an imported URI may not survive a round trip
// through JavaScript): its member (account_id, else object_uri) and its candidate.
const REVISED = `(coalesce(account_id, object_uri) IS NOT coalesce(?2, ?3) OR candidate_approval_uri IS NOT ?4)`;

// A kept row whose revision changes to another member drops its member, and with it its verified authorization and
// any claim (reviseItem then writes the new revision).
function releaseMember(db: Db, id: string, item: Pick<Planned, "member" | "object" | "candidate">, now: number): void {
  db.run(
    `UPDATE collection_items INDEXED BY ${COLLECTION_ITEMS_ID_INDEX}
			SET account_id = NULL, object_uri = ?3, candidate_approval_uri = ?4, state = ${COLLECTION_ITEM_STATES.pending},
				approval_uri = NULL, retracted_approval_uri = NULL, check_due_at = NULL, check_token = NULL,
				answer_activity_id = NULL, updated_at = ?5
		WHERE id = ?1 AND account_id IS NOT NULL AND account_id IS NOT ?2`,
    id,
    item.member,
    item.object,
    item.candidate,
    new Date(now).toISOString(),
  );
}

// A listed item over its kept row: a changed revision makes it pending under the new one (queued when its member is
// known); an unchanged one takes only its position. Whether it was queued.
function reviseItem(db: Db, item: Planned, now: number): boolean {
  const revised = db.first<{ queued: number }>(
    `UPDATE collection_items INDEXED BY ${COLLECTION_ITEMS_ID_INDEX}
			SET account_id = ?2, object_uri = ?3, candidate_approval_uri = ?4, state = ${COLLECTION_ITEM_STATES.pending},
				approval_uri = NULL, retracted_approval_uri = NULL, check_attempts = 0, check_token = NULL,
				answer_activity_id = NULL, check_due_at = CASE WHEN ?2 IS NULL THEN NULL ELSE ?5 END, position = ?6, updated_at = ?7
		WHERE id = ?1 AND ${REVISED}
		RETURNING check_due_at IS NOT NULL AS queued`,
    item.existing ?? "",
    item.member,
    item.object,
    item.candidate,
    now,
    item.position,
    new Date(now).toISOString(),
  );
  if (revised !== undefined) {
    return revised.queued === 1;
  }
  db.run(
    `UPDATE collection_items INDEXED BY ${COLLECTION_ITEMS_ID_INDEX} SET position = ?2 WHERE id = ?1 AND position <> ?2`,
    item.existing ?? "",
    item.position,
  );
  return false;
}

// A new item's created_at (ProcessFeaturedItemService#new_item: its published): the time its published names when
// Kopje stores that time and it is not after `now`, as a remote status's published is taken (remote-statuses.ts
// remoteTime); else `now`, the time Kopje received it. A kept item keeps its own.
function itemCreatedAt(published: string | null, now: number): string {
  const at = published === null ? Number.NaN : Date.parse(published);
  return (at <= now ? storedTime(at) : null) ?? new Date(now).toISOString();
}

// A new item: pending under its revision, queued when its member is known. Whether it was queued.
function insertItem(db: Db, collection: string, item: Omit<Planned, "existing">, now: number): boolean {
  const at = new Date(now).toISOString();
  const created = itemCreatedAt(item.published, now);
  insertWithFreshId(
    "collection_items",
    () => allocateLocalId(db, now),
    (fresh) =>
      db.run(
        `INSERT INTO collection_items (id, collection_id, account_id, state, position, uri, object_uri,
					candidate_approval_uri, check_due_at, created_at, updated_at)
				VALUES (?, ?, ?, ${COLLECTION_ITEM_STATES.pending}, ?, ?, ?, ?, ?, ?, ?)`,
        fresh,
        collection,
        item.member,
        item.position,
        item.uri,
        item.object,
        item.candidate,
        item.member === null ? null : now,
        created,
        at,
      ),
  );
  return item.member !== null;
}

// A complete read of the owner's collections (every page seen, none unreadable): its stored collections whose uri is
// not among `kept` (the uris the read lists as collections the owner may hold) are deleted, each with its items, their
// notifications, its collection_update notifications and those notifications' pushes by the foreign keys (at most
// MAX_STORED_COLLECTIONS rows, read through collections_account). Mastodon keeps them until a Remove
// (docs/mastodon-deviations.md, "Collections").
export function deleteUnlisted(db: Db, owner: string, kept: readonly string[]): void {
  db.run(
    `DELETE FROM collections INDEXED BY ${COLLECTIONS_ID_INDEX} WHERE id IN
			(SELECT id FROM collections INDEXED BY collections_account WHERE account_id = ?1
				AND uri NOT IN (SELECT value FROM json_each(?2)))`,
    owner,
    JSON.stringify(kept),
  );
}

// Remove#remove_collection: the owner's collection `uri`, with its items and notifications (as deleteUnlisted).
// Whether one was deleted.
export function removeFeaturedCollection(db: Db, owner: string, uri: string): boolean {
  return (
    db.run(
      `DELETE FROM collections INDEXED BY ${COLLECTIONS_ID_INDEX} WHERE id =
				(SELECT id FROM collections INDEXED BY collections_uri WHERE uri = ?2 AND account_id = ?1)`,
      owner,
      uri,
    ) > 0
  );
}

// The owner's stored collection `uri` (an Add's or a Remove's target among the account's collections).
export function ownCollectionByUri(db: Db, owner: string, uri: string): { id: string; uri: string } | undefined {
  return db.first<{ id: string; uri: string }>(
    "SELECT id, uri FROM collections INDEXED BY collections_uri WHERE uri = ?2 AND account_id = ?1 AND local = 0",
    owner,
    uri,
  );
}

// Remove#remove_collection_item: the item `uri` of the collection, with its notification. Whether one was deleted.
export function removeFeaturedItem(db: Db, collection: string, uri: string): boolean {
  return (
    db.run(
      `DELETE FROM collection_items INDEXED BY ${COLLECTION_ITEMS_ID_INDEX} WHERE id =
				(SELECT id FROM collection_items INDEXED BY collection_items_uri WHERE uri = ?2 AND collection_id = ?1)`,
      collection,
      uri,
    ) > 0
  );
}

// A member's Delete of its feature authorization `authorization` (Delete#delete_feature_authorization!, #1589's
// revocation rule): its row is the member's row whose approval_uri is it (collection_items_approval), or else the
// member's row in the stored collection the embedded FeatureAuthorization's interactingObject names, when its
// interactionTarget is the member. That row is revoked only while the authorization is its current one: its
// approval_uri, or, with none verified, its candidate; then no later check completion accepts it (no token, no
// queue). At most one row is read by each lookup and one written. Whether a row was revoked.
export function revokeFeatureAuthorization(
  db: Db,
  member: { id: string; uri: string },
  authorization: string,
  feature: { collection: string | null; member: string | null } | null,
  now: number,
): boolean {
  const row =
    db.first<{ id: string }>(
      "SELECT id FROM collection_items INDEXED BY collection_items_approval WHERE account_id = ?1 AND approval_uri = ?2",
      member.id,
      authorization,
    ) ??
    (feature !== null && feature.collection !== null && feature.member === member.uri
      ? db.first<{ id: string }>(
          `SELECT i.id FROM collections c INDEXED BY collections_uri
						CROSS JOIN collection_items i INDEXED BY collection_items_member ON i.collection_id = c.id AND i.account_id = ?2
					WHERE c.uri = ?1`,
          feature.collection,
          member.id,
        )
      : undefined);
  if (row === undefined) {
    return false;
  }
  return (
    db.run(
      `UPDATE collection_items INDEXED BY ${COLLECTION_ITEMS_ID_INDEX}
				SET state = ${COLLECTION_ITEM_STATES.revoked}, check_due_at = NULL, check_token = NULL, updated_at = ?3
			WHERE id = ?1 AND state <> ${COLLECTION_ITEM_STATES.revoked}
				AND (approval_uri = ?2 OR (approval_uri IS NULL AND candidate_approval_uri = ?2))`,
      row.id,
      authorization,
      new Date(now).toISOString(),
    ) > 0
  );
}
