import { ACCOUNTS_ID_INDEX, COLLECTION_ITEMS_ID_INDEX, COLLECTIONS_ID_INDEX } from "../db/indexes";
import type { Db } from "../db/sql";
import { followersUri, recordOutbound } from "./activities";
import { availableSql, blockedSql, collectionItemShownSql, collectionShownSql, PUBLIC_COLLECTION } from "./audience";
import { allocateLocalId } from "./ids";
import { withinTagNameBound } from "./tag-bounds";
import { normalizeTag } from "./tag-name";

// FEP-7aa9's documents of local collections, as Mastodon 4.7.5 serializes them (ActivityPub::FeaturedCollection-
// Serializer, FeaturedItemSerializer, FeatureAuthorizationSerializer, and the featured_collections Collection of
// ActivityPub::FeaturedCollectionsController): served by federation/routes.ts through federation-reads.ts, one read a
// request (D18), and embedded in the activities collections.ts records (D17, at the end). Every member list and count
// is R45's federation projection: the accepted items whose member is available (collectionItemShownSql with no
// viewer), so a member R1 hides is in none of them. Each read answers null (404) while the owner is unavailable, and to
// a fetcher the owner (the member, for an authorization) blocks or whose domain it blocks.
//
// The fetcher is the account whose stored key the request's signature names by keyId (fetcherOf), unverified: the
// documents are served to anyone, so naming a key only ever narrows the answer, and a forged keyId refuses only its own
// sender (VIS-33).

const AS_CONTEXT = "https://www.w3.org/ns/activitystreams";

const FEP_7AA9 = "https://w3id.org/fep/7aa9#";

// context_helper.rb's featured_collections extension.
const FEATURED_COLLECTIONS_TERMS = {
  FeaturedCollection: `${FEP_7AA9}FeaturedCollection`,
  FeaturedItem: `${FEP_7AA9}FeaturedItem`,
  FeatureRequest: `${FEP_7AA9}FeatureRequest`,
  FeatureAuthorization: `${FEP_7AA9}FeatureAuthorization`,
  topic: { "@id": `${FEP_7AA9}topic`, "@type": "@id" },
  featuredObject: { "@id": `${FEP_7AA9}featuredObject`, "@type": "@id" },
  featureAuthorization: { "@id": `${FEP_7AA9}featureAuthorization`, "@type": "@id" },
} as const;

// The context of a document or activity holding a FeaturedCollection: FeaturedCollectionSerializer's extensions
// (discoverable, featured_collections, hashtag, sensitive), merged in their order.
const FEATURED_COLLECTION_CONTEXT = [
  AS_CONTEXT,
  {
    toot: "http://joinmastodon.org/ns#",
    discoverable: "toot:discoverable",
    ...FEATURED_COLLECTIONS_TERMS,
    Hashtag: "as:Hashtag",
    sensitive: "as:sensitive",
  },
] as const;

// The context of a document or activity holding a FeaturedItem (FeaturedItemSerializer's featured_collections).
const FEATURED_ITEM_CONTEXT = [AS_CONTEXT, FEATURED_COLLECTIONS_TERMS] as const;

// FeatureAuthorizationSerializer's feature_authorizations extension.
const FEATURE_AUTHORIZATION_CONTEXT = [
  AS_CONTEXT,
  {
    gts: "https://gotosocial.org/ns#",
    FeatureAuthorization: `${FEP_7AA9}FeatureAuthorization`,
    interactingObject: { "@id": "gts:interactingObject", "@type": "@id" },
    interactionTarget: { "@id": "gts:interactionTarget", "@type": "@id" },
  },
] as const;

// A FeaturedCollection's page holds this many collections (FeaturedCollectionsController::PER_PAGE).
const FEATURED_COLLECTIONS_PER_PAGE = 5;

// The ids of a local actor's collections (ActivityPub::TagManager, routes.rb), under its actor id: Kopje's actor ids
// are /ap/users/<username>, so these are the paths federation/routes.ts serves.
function featuredCollectionsUri(actorUri: string): string {
  return `${actorUri}/featured_collections`;
}

function localCollectionUri(ownerUri: string, collectionId: string): string {
  return `${ownerUri}/collections/${collectionId}`;
}

function collectionItemUri(ownerUri: string, itemId: string): string {
  return `${ownerUri}/collection_items/${itemId}`;
}

function featureAuthorizationUri(memberUri: string, itemId: string): string {
  return `${memberUri}/feature_authorizations/${itemId}`;
}

// context_helper.rb's interaction_policies extension, which ActivityPub::ActorSerializer names.
export const INTERACTION_POLICIES_TERMS = {
  gts: "https://gotosocial.org/ns#",
  interactionPolicy: { "@id": "gts:interactionPolicy", "@type": "@id" },
  canFeature: { "@id": `${FEP_7AA9}canFeature`, "@type": "@id" },
  canQuote: { "@id": "gts:canQuote", "@type": "@id" },
  automaticApproval: { "@id": "gts:automaticApproval", "@type": "@id" },
  manualApproval: { "@id": "gts:manualApproval", "@type": "@id" },
} as const;

// What a local actor document says of its collections (ActivityPub::ActorSerializer#featured_collections and
// #interaction_policy, D19): where they are (`featuredCollections`, a bare key: no context term defines it, as
// Mastodon's), and who may feature the account without asking, from its stored settings (a suspended account's too):
// itself alone when not discoverable, its followers when locked, else anyone. The instance actor says neither.
export function actorCollectionTerms(
  actorUri: string,
  settings: { discoverable: boolean | null; locked: boolean },
): { featuredCollections: string; interactionPolicy: { canFeature: { automaticApproval: string[] } } } {
  const approval =
    settings.discoverable !== true ? actorUri : settings.locked ? followersUri(actorUri) : PUBLIC_COLLECTION;
  return {
    featuredCollections: featuredCollectionsUri(actorUri),
    interactionPolicy: { canFeature: { automaticApproval: [approval] } },
  };
}

type CollectionDocumentRow = {
  id: string;
  owner_uri: string;
  name: string;
  description: string | null;
  language: string | null;
  sensitive: number;
  discoverable: number;
  tag: string | null;
  created_at: string;
  updated_at: string;
};

const DOCUMENT_COLUMNS = `c.id, o.uri AS owner_uri, c.name, c.description, c.language, c.sensitive, c.discoverable,
	c.tag, c.created_at, c.updated_at`;

type ItemDocumentRow = {
  collection_id: string;
  id: string;
  created_at: string;
  member_uri: string;
  member_local: number;
  approval_uri: string | null;
};

// FeaturedItemSerializer: the member, and its authorization: a local member's own (served below), a remote one's as
// its server gave it (none while pending).
function itemDocument(row: ItemDocumentRow, ownerUri: string): Record<string, unknown> {
  const authorization =
    row.member_local === 1 ? featureAuthorizationUri(row.member_uri, row.id) : (row.approval_uri ?? undefined);
  return {
    id: collectionItemUri(ownerUri, row.id),
    type: "FeaturedItem",
    featuredObject: row.member_uri,
    ...(authorization === undefined ? {} : { featureAuthorization: authorization }),
    published: row.created_at,
  };
}

const ITEM_COLUMNS = `i.collection_id, i.id, i.created_at, m.uri AS member_uri, m.domain IS NULL AS member_local,
	i.approval_uri`;

// The federation projection of the collections `ids`: each one's accepted items whose member is available, in position
// order, at most MAX_STORED_ITEMS rows read per collection through collection_items_order.
function projectedItems(db: Db, ids: readonly string[]): Map<string, ItemDocumentRow[]> {
  const byCollection = new Map<string, ItemDocumentRow[]>(ids.map((id) => [id, []]));
  if (ids.length === 0) {
    return byCollection;
  }
  const rows = db.all<ItemDocumentRow>(
    `SELECT ${ITEM_COLUMNS}
		FROM json_each(?1) w CROSS JOIN collections c INDEXED BY ${COLLECTIONS_ID_INDEX} ON c.id = w.value
			CROSS JOIN collection_items i INDEXED BY collection_items_order ON i.collection_id = c.id
			CROSS JOIN accounts m INDEXED BY ${ACCOUNTS_ID_INDEX} ON m.id = i.account_id
		WHERE ${collectionItemShownSql("i", "c", "NULL")}
		ORDER BY w.key, i.position, i.id`,
    JSON.stringify(ids),
  );
  for (const row of rows) {
    byCollection.get(row.collection_id)?.push(row);
  }
  return byCollection;
}

// The Hashtag a collection's topic is (NoteSerializer::TagSerializer): its normalized name and page, as the REST
// entity's ShallowTag; none when the stored name normalizes to no hashtag.
function topicOf(tag: string | null, origin: string): Record<string, unknown> | undefined {
  if (tag === null) {
    return undefined;
  }
  const name = normalizeTag(tag);
  return name === "" || !withinTagNameBound(name)
    ? undefined
    : { type: "Hashtag", href: `${origin}/tags/${encodeURIComponent(name)}`, name: `#${name}` };
}

// FeaturedCollectionSerializer, without its context: `summary` the description, or `summaryMap` by the language when
// one is set; `url` the collection's page (collections.ts collectionUrl).
function collectionDocument(row: CollectionDocumentRow, items: readonly ItemDocumentRow[]): Record<string, unknown> {
  const origin = new URL(row.owner_uri).origin;
  const topic = topicOf(row.tag, origin);
  const summary =
    row.description === null
      ? {}
      : row.language === null
        ? { summary: row.description }
        : { summaryMap: { [row.language]: row.description } };
  return {
    id: localCollectionUri(row.owner_uri, row.id),
    type: "FeaturedCollection",
    totalItems: items.length,
    name: row.name,
    attributedTo: row.owner_uri,
    url: `${origin}/collections/${row.id}`,
    sensitive: row.sensitive === 1,
    discoverable: row.discoverable === 1,
    published: row.created_at,
    updated: row.updated_at,
    ...summary,
    ...(topic === undefined ? {} : { topic }),
    orderedItems: items.map((item) => itemDocument(item, row.owner_uri)),
  };
}

function documentsOf(db: Db, rows: readonly CollectionDocumentRow[]): Record<string, unknown>[] {
  const items = projectedItems(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => collectionDocument(row, items.get(row.id) ?? []));
}

// ---- The documents served (federation-reads.ts), each null when it is not found.

// The remote account whose stored key `keyId` names (as the inbox gate looks keys up, inbox.ts remoteKeyOf), by its
// primary key; null for none or an unsigned request.
function fetcherOf(db: Db, keyId: string | null): string | null {
  if (keyId === null) {
    return null;
  }
  return (
    db.first<{ id: string }>(
      `SELECT k.account_id AS id FROM remote_keys k
				CROSS JOIN accounts a INDEXED BY ${ACCOUNTS_ID_INDEX} ON a.id = k.account_id
			WHERE k.key_id = ? AND a.domain IS NOT NULL`,
      keyId,
    )?.id ?? null
  );
}

// The local account `username` (its stored spelling: ID-5), by accounts_local_username.
function localAccountId(db: Db, username: string): string | null {
  return (
    db.first<{ id: string }>(
      `SELECT a.id FROM accounts a INDEXED BY accounts_local_username
			WHERE a.domain IS NULL AND lower(a.username) = lower(?1) AND a.username = ?1`,
      username,
    )?.id ?? null
  );
}

export type DocumentRequest = { username: string; keyId: string | null };

// /ap/users/:username/featured_collections (FeaturedCollectionsController#index): without a page, an unordered
// Collection of every collection of the account (discoverable or not) with its first page; page N (from 1) the
// FeaturedCollections at its place, newest first, FEATURED_COLLECTIONS_PER_PAGE a page, through collections_account
// (at most MAX_STORED_COLLECTIONS entries whatever the page). Not found unless the account is available and shows its
// collections to the fetcher (AccountPolicy#index_collections?).
export function featuredCollectionsDocument(
  db: Db,
  input: DocumentRequest & { page: number | null },
): Record<string, unknown> | null {
  const owner = localAccountId(db, input.username);
  if (owner === null) {
    return null;
  }
  const fetcher = fetcherOf(db, input.keyId);
  const head = db.first<{ uri: string; total: number }>(
    `SELECT a.uri, (SELECT count(*) FROM collections c INDEXED BY collections_account WHERE c.account_id = a.id) AS total
		FROM accounts a INDEXED BY ${ACCOUNTS_ID_INDEX}
		WHERE a.id = ?1 AND ${availableSql("a.id")} AND (?2 IS NULL OR NOT ${blockedSql("a.id", "?2")})`,
    owner,
    fetcher,
  );
  if (head === undefined) {
    return null;
  }
  const id = featuredCollectionsUri(head.uri);
  if (input.page === null) {
    return {
      "@context": AS_CONTEXT,
      id,
      type: "Collection",
      totalItems: head.total,
      first: `${id}?page=1`,
    };
  }
  const rows = db.all<CollectionDocumentRow>(
    `SELECT ${DOCUMENT_COLUMNS} FROM collections c INDEXED BY collections_account
			CROSS JOIN accounts o INDEXED BY ${ACCOUNTS_ID_INDEX} ON o.id = c.account_id
		WHERE c.account_id = ?1 ORDER BY c.created_at DESC, c.id DESC LIMIT ?2 OFFSET ?3`,
    owner,
    FEATURED_COLLECTIONS_PER_PAGE,
    (input.page - 1) * FEATURED_COLLECTIONS_PER_PAGE,
  );
  return {
    "@context": FEATURED_COLLECTION_CONTEXT,
    id: `${id}?page=${input.page}`,
    type: "CollectionPage",
    totalItems: head.total,
    ...(input.page * FEATURED_COLLECTIONS_PER_PAGE < head.total ? { next: `${id}?page=${input.page + 1}` } : {}),
    ...(input.page > 1 ? { prev: `${id}?page=${input.page - 1}` } : {}),
    partOf: id,
    items: documentsOf(db, rows),
  };
}

// /ap/users/:username/collections/:id (CollectionsController#show): the FeaturedCollection of the local collection
// `id` of `username`, which R45 shows the fetcher (collectionShownSql). A non-discoverable collection is served:
// discoverable governs listings only.
export function featuredCollectionDocument(
  db: Db,
  input: DocumentRequest & { id: string },
): Record<string, unknown> | null {
  const owner = localAccountId(db, input.username);
  if (owner === null) {
    return null;
  }
  const row = db.first<CollectionDocumentRow>(
    `SELECT ${DOCUMENT_COLUMNS} FROM collections c INDEXED BY ${COLLECTIONS_ID_INDEX}
			CROSS JOIN accounts o INDEXED BY ${ACCOUNTS_ID_INDEX} ON o.id = c.account_id
		WHERE c.id = ?1 AND c.account_id = ?2 AND c.local = 1 AND ${collectionShownSql("c", "?3")}`,
    input.id,
    owner,
    fetcherOf(db, input.keyId),
  );
  const [document] = row === undefined ? [] : documentsOf(db, [row]);
  return document === undefined ? null : { "@context": FEATURED_COLLECTION_CONTEXT, ...document };
}

// /ap/users/:username/collection_items/:id (CollectionItemsController#show): the FeaturedItem of an item of a local
// collection of `username` that R45 shows the fetcher, in any state, as Mastodon serves it, while its member is
// available.
export function featuredItemDocument(db: Db, input: DocumentRequest & { id: string }): Record<string, unknown> | null {
  const owner = localAccountId(db, input.username);
  if (owner === null) {
    return null;
  }
  const row = db.first<ItemDocumentRow & { owner_uri: string }>(
    `SELECT ${ITEM_COLUMNS}, o.uri AS owner_uri FROM collection_items i INDEXED BY ${COLLECTION_ITEMS_ID_INDEX}
			CROSS JOIN collections c INDEXED BY ${COLLECTIONS_ID_INDEX} ON c.id = i.collection_id
			CROSS JOIN accounts o INDEXED BY ${ACCOUNTS_ID_INDEX} ON o.id = c.account_id
			CROSS JOIN accounts m INDEXED BY ${ACCOUNTS_ID_INDEX} ON m.id = i.account_id
		WHERE i.id = ?1 AND c.account_id = ?2 AND c.local = 1 AND ${collectionShownSql("c", "?3")}
			AND ${availableSql("i.account_id")}`,
    input.id,
    owner,
    fetcherOf(db, input.keyId),
  );
  return row === undefined ? null : { "@context": FEATURED_ITEM_CONTEXT, ...itemDocument(row, row.owner_uri) };
}

// /ap/users/:username/feature_authorizations/:id (FeatureAuthorizationsController#show): the FeatureAuthorization of
// the item `id` of the local member `username`, only while it is accepted, the member available and not blocking the
// fetcher or its domain. Its collection is a local one's id, or a remote one's as stored.
export function featureAuthorizationDocument(
  db: Db,
  input: DocumentRequest & { id: string },
): Record<string, unknown> | null {
  const member = localAccountId(db, input.username);
  if (member === null) {
    return null;
  }
  const row = db.first<{ id: string; member_uri: string; collection_uri: string | null }>(
    `SELECT i.id, m.uri AS member_uri,
			CASE WHEN c.local = 1 THEN o.uri || '/collections/' || c.id ELSE c.uri END AS collection_uri
		FROM collection_items i INDEXED BY ${COLLECTION_ITEMS_ID_INDEX}
			CROSS JOIN accounts m INDEXED BY ${ACCOUNTS_ID_INDEX} ON m.id = i.account_id
			CROSS JOIN collections c INDEXED BY ${COLLECTIONS_ID_INDEX} ON c.id = i.collection_id
			CROSS JOIN accounts o INDEXED BY ${ACCOUNTS_ID_INDEX} ON o.id = c.account_id
		WHERE i.id = ?1 AND i.account_id = ?2 AND i.state = 1 AND ${availableSql("i.account_id")}
			AND (?3 IS NULL OR NOT ${blockedSql("i.account_id", "?3")})`,
    input.id,
    member,
    fetcherOf(db, input.keyId),
  );
  if (row === undefined || row.collection_uri === null) {
    return null;
  }
  return {
    "@context": FEATURE_AUTHORIZATION_CONTEXT,
    id: featureAuthorizationUri(row.member_uri, row.id),
    type: "FeatureAuthorization",
    interactingObject: row.collection_uri,
    interactionTarget: row.member_uri,
  };
}

// ---- The activities (D17): each change of a local collection, recorded in its transaction and signed by its owner, to
// the owner's followers and the collection's pending and accepted remote members (CollectionReachFinder), as
// Mastodon's CreateCollectionService, UpdateCollectionService, DeleteCollectionService, AddAccountToCollectionService
// and DeleteCollectionItemService send them. Each carries an id under the collection's (`#adds/<n>`, `#removes/<n>`,
// `#updates/<n>`, n a local id) and `to` Public, as Kopje's other activities: Mastodon's Add and Remove carry neither,
// and its parsers ignore both. An Add or Remove of the collection supersedes the other while it waits, and an Update
// the earlier Update; an item's Add and Remove supersede nothing (deliveries.ts supersededTypes), since a member's
// server learns the item's id only from its Add. A suspension sends nothing: the next Update or fetch leaves the
// member out.

// The FeaturedCollection of the local collection `id` as an activity embeds it (no context), whatever its owner's
// state: the activities are recorded by the owner, who is available then. null for any other.
function embeddedCollection(db: Db, id: string): Record<string, unknown> | null {
  const row = db.first<CollectionDocumentRow>(
    `SELECT ${DOCUMENT_COLUMNS} FROM collections c INDEXED BY ${COLLECTIONS_ID_INDEX}
			CROSS JOIN accounts o INDEXED BY ${ACCOUNTS_ID_INDEX} ON o.id = c.account_id
		WHERE c.id = ? AND c.local = 1`,
    id,
  );
  return row === undefined ? null : (documentsOf(db, [row])[0] ?? null);
}

// The FeaturedItem of the item `id` as an activity embeds it (no context): an item of a local collection with a member.
function embeddedItem(db: Db, id: string): Record<string, unknown> | null {
  const row = db.first<ItemDocumentRow & { owner_uri: string }>(
    `SELECT ${ITEM_COLUMNS}, o.uri AS owner_uri FROM collection_items i INDEXED BY ${COLLECTION_ITEMS_ID_INDEX}
			CROSS JOIN collections c INDEXED BY ${COLLECTIONS_ID_INDEX} ON c.id = i.collection_id
			CROSS JOIN accounts o INDEXED BY ${ACCOUNTS_ID_INDEX} ON o.id = c.account_id
			CROSS JOIN accounts m INDEXED BY ${ACCOUNTS_ID_INDEX} ON m.id = i.account_id
		WHERE i.id = ? AND c.local = 1`,
    id,
  );
  return row === undefined ? null : itemDocument(row, row.owner_uri);
}

type Reach = { owner: string; ownerUri: string; uri: string; members: string[] };

// The local collection `id`'s owner and uri, and the remote accounts its activities reach besides the owner's
// followers: its pending and accepted members (Collection#accounts), through collection_items_order (at most
// MAX_STORED_ITEMS rows). null for any other collection.
function reachOf(db: Db, id: string): Reach | null {
  const head = db.first<{ owner: string; owner_uri: string }>(
    `SELECT c.account_id AS owner, o.uri AS owner_uri FROM collections c INDEXED BY ${COLLECTIONS_ID_INDEX}
			CROSS JOIN accounts o INDEXED BY ${ACCOUNTS_ID_INDEX} ON o.id = c.account_id
		WHERE c.id = ? AND c.local = 1`,
    id,
  );
  if (head === undefined) {
    return null;
  }
  const members = db.all<{ id: string }>(
    `SELECT i.account_id AS id FROM collection_items i INDEXED BY collection_items_order
			CROSS JOIN accounts m INDEXED BY ${ACCOUNTS_ID_INDEX} ON m.id = i.account_id
		WHERE i.collection_id = ? AND i.state IN (0, 1) AND m.domain IS NOT NULL`,
    id,
  );
  return {
    owner: head.owner,
    ownerUri: head.owner_uri,
    uri: localCollectionUri(head.owner_uri, id),
    members: members.map((member) => member.id),
  };
}

const ID_KINDS = { Add: "adds", Remove: "removes", Update: "updates" } as const;

// Records an activity of the collection's owner for its reach, and for `also` (an item's member) besides.
function deliver(
  db: Db,
  reach: Reach,
  now: number,
  activity: { type: keyof typeof ID_KINDS; context: unknown; target?: string; object: unknown },
  also: string | null = null,
): void {
  recordOutbound(
    db,
    reach.owner,
    {
      activity: {
        "@context": activity.context,
        id: `${reach.uri}#${ID_KINDS[activity.type]}/${allocateLocalId(db, now)}`,
        type: activity.type,
        actor: reach.ownerUri,
        to: [PUBLIC_COLLECTION],
        ...(activity.target === undefined ? {} : { target: activity.target }),
        object: activity.object,
      },
      audience: {
        followers: true,
        accounts: also === null || reach.members.includes(also) ? reach.members : [...reach.members, also],
      },
    },
    now,
  );
}

// CreateCollectionService: the collection's Add to the owner's featured_collections, its accepted items embedded.
export function recordCollectionAdd(db: Db, id: string, now: number): void {
  const reach = reachOf(db, id);
  const object = embeddedCollection(db, id);
  if (reach !== null && object !== null) {
    const target = featuredCollectionsUri(reach.ownerUri);
    deliver(db, reach, now, { type: "Add", context: FEATURED_COLLECTION_CONTEXT, target, object });
  }
}

// UpdateCollectionService, when a field it federates changed: the collection as it now is.
export function recordCollectionUpdate(db: Db, id: string, now: number): void {
  const reach = reachOf(db, id);
  const object = embeddedCollection(db, id);
  if (reach !== null && object !== null) {
    deliver(db, reach, now, { type: "Update", context: FEATURED_COLLECTION_CONTEXT, object });
  }
}

// DeleteCollectionService: the collection's Remove from featured_collections, recorded before the delete, so that its
// members are read and reached (Mastodon's delivery per member reaches the owner's inbox instead).
export function recordCollectionRemove(db: Db, id: string, now: number): void {
  const reach = reachOf(db, id);
  if (reach !== null) {
    const target = featuredCollectionsUri(reach.ownerUri);
    deliver(db, reach, now, { type: "Remove", context: AS_CONTEXT, target, object: reach.uri });
  }
}

// AddAccountToCollectionService: a local member's item, as accepted, added to the collection.
export function recordItemAdd(db: Db, item: { id: string; collection: string }, now: number): void {
  const reach = reachOf(db, item.collection);
  const object = embeddedItem(db, item.id);
  if (reach !== null && object !== null) {
    deliver(db, reach, now, { type: "Add", context: FEATURED_ITEM_CONTEXT, target: reach.uri, object });
  }
}

// DeleteCollectionItemService: the item `id` of a local collection removed by its id, whatever its state, which the
// owner deleted (or a block of its member did) or its member revoked (or blocked the owner). Its member is reached
// whatever the item's state, so the item may be deleted already.
export function recordItemRemove(
  db: Db,
  item: { id: string; collection: string; account: string | null },
  now: number,
): void {
  const reach = reachOf(db, item.collection);
  if (reach !== null) {
    const object = collectionItemUri(reach.ownerUri, item.id);
    deliver(db, reach, now, { type: "Remove", context: AS_CONTEXT, target: reach.uri, object }, item.account);
  }
}
