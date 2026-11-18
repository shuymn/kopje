import { ACCOUNTS_ID_INDEX, COLLECTION_ITEMS_ID_INDEX, COLLECTIONS_ID_INDEX } from "../db/indexes";
import type { Db } from "../db/sql";
import { MAX_STORED_COLLECTIONS } from "../platform/stored-bounds";
import { followersUri, recordOutbound } from "./activities";
import { availableSql, blockedSql, collectionItemShownSql, collectionShownSql, PUBLIC_COLLECTION } from "./audience";
import { beginFollowerStaging, type DeliveryEnvelope } from "./deliveries";
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
// context_helper.rb's feature_requests extension, which ActivityPub::FeatureRequestSerializer names.
const FEATURE_REQUEST_CONTEXT = [AS_CONTEXT, { FeatureRequest: `${FEP_7AA9}FeatureRequest` }] as const;

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

// The context of a member's Delete of its authorization: ActivityPub::DeleteFeatureAuthorizationSerializer's (its
// object's feature_authorizations extension), then security/v1, which LinkedDataSignature#sign! appends and which
// defines the signature's terms; federation/author-proof.ts's mastodonFeature profile reads this very context.
const FEATURE_DELETE_CONTEXT = [...FEATURE_AUTHORIZATION_CONTEXT, "https://w3id.org/security/v1"] as const;

// A FeaturedCollection's page holds this many collections (FeaturedCollectionsController::PER_PAGE).
const FEATURED_COLLECTIONS_PER_PAGE = 5;

// The page past every page an account can have (MAX_STORED_COLLECTIONS collections at most, the 0103 trigger): any
// larger number serves the same empty page, so a page number is read no further.
const PAST_EVERY_PAGE = Math.ceil(MAX_STORED_COLLECTIONS / FEATURED_COLLECTIONS_PER_PAGE) + 1;

// FeaturedCollectionsController#page_requested? (`params[:page].present?`): a value of white space alone (ActiveSupport's
// String#blank?, `[[:space:]]`) asks for no page.
const BLANK = /^\p{White_Space}*$/u;

const ASCII_SPACE = " \t\n\v\f\r";

const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";

// The page Kaminari serves for `value` (`.page(params[:page])`, kaminari-core 1.2.2): Ruby's String#to_i of it (ASCII
// white space, a sign, a `0d` prefix, digits with single underscores between them, up to the first other character),
// and the first page below 1. Past PAST_EVERY_PAGE no more digits are read. Mastodon answers 500 where its offset
// passes PostgreSQL's bigint; Kopje serves the empty page (docs/mastodon-deviations.md, "Collections").
function pageNumber(value: string): number {
  let i = 0;
  while (i < value.length && ASCII_SPACE.includes(value[i]!)) {
    i++;
  }
  if (value[i] === "-") {
    return 1;
  }
  if (value[i] === "+") {
    i++;
  }
  if (value[i] === "0" && (value[i + 1] === "d" || value[i + 1] === "D") && isDigit(value[i + 2])) {
    i += 2;
  }
  let n = 0;
  for (; i < value.length; i++) {
    if (isDigit(value[i])) {
      n = n * 10 + Number(value[i]);
      if (n >= PAST_EVERY_PAGE) {
        return PAST_EVERY_PAGE;
      }
    } else if (!(value[i] === "_" && isDigit(value[i - 1]) && isDigit(value[i + 1]))) {
      break;
    }
  }
  return Math.max(n, 1);
}

// A query value as Rails' url helpers write it (Hash#to_query, Ruby's CGI.escape): every UTF-8 byte but A-Z, a-z, 0-9,
// `_`, `.`, `-` and `~` percent-encoded, a space as `+`.
function queryValue(value: string): string {
  return encodeURIComponent(value.toWellFormed())
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replaceAll("%20", "+");
}

// The ids of a local actor's collections (ActivityPub::TagManager, routes.rb), under its actor id: Kopje's actor ids
// are /ap/users/<username>, so these are the paths federation/routes.ts serves.
function featuredCollectionsUri(actorUri: string): string {
  return `${actorUri}/featured_collections`;
}

export function localCollectionUri(ownerUri: string, collectionId: string): string {
  return `${ownerUri}/collections/${collectionId}`;
}

function collectionItemUri(ownerUri: string, itemId: string): string {
  return `${ownerUri}/collection_items/${itemId}`;
}

// A local member's authorization of its item `itemId` (ActivityPub::TagManager, ap_account_feature_authorization_url),
// which featureAuthorizationDocument serves while the item is accepted.
export function featureAuthorizationUri(memberUri: string, itemId: string): string {
  return `${memberUri}/feature_authorizations/${itemId}`;
}

// The item id a local member's authorization `uri` names, when `uri` is exactly one featureAuthorizationUri writes for
// the member (an item id is 18 digits, the collection_items CHECK); null for any other URI.
export function authorizedItemOf(memberUri: string, uri: string): string | null {
  const prefix = `${memberUri}/feature_authorizations/`;
  const id = uri.startsWith(prefix) ? uri.slice(prefix.length) : "";
  return /^\d{18}$/.test(id) ? id : null;
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

// /ap/users/:username/featured_collections (FeaturedCollectionsController#index): without a page (`page`, the last
// `page` of the query, absent or blank), an unordered Collection of every collection of the account (discoverable or
// not) with its first page; with one, the page pageNumber reads, its id the value as given (`params.fetch(:page, 1)`):
// the FeaturedCollections at its place, newest first, FEATURED_COLLECTIONS_PER_PAGE a page, through
// collections_account (at most MAX_STORED_COLLECTIONS entries whatever the page), and `next` and `prev` as Kaminari
// gives them (none past the last page). Not found unless the account is available and shows its collections to the
// fetcher (AccountPolicy#index_collections?).
export function featuredCollectionsDocument(
  db: Db,
  input: DocumentRequest & { page: string | null },
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
  if (input.page === null || BLANK.test(input.page)) {
    return {
      "@context": AS_CONTEXT,
      id,
      type: "Collection",
      totalItems: head.total,
      first: `${id}?page=1`,
    };
  }
  const page = pageNumber(input.page);
  const pages = Math.ceil(head.total / FEATURED_COLLECTIONS_PER_PAGE);
  const inRange = page <= pages;
  const rows = !inRange
    ? []
    : db.all<CollectionDocumentRow>(
        `SELECT ${DOCUMENT_COLUMNS} FROM collections c INDEXED BY collections_account
				CROSS JOIN accounts o INDEXED BY ${ACCOUNTS_ID_INDEX} ON o.id = c.account_id
			WHERE c.account_id = ?1 ORDER BY c.created_at DESC, c.id DESC LIMIT ?2 OFFSET ?3`,
        owner,
        FEATURED_COLLECTIONS_PER_PAGE,
        (page - 1) * FEATURED_COLLECTIONS_PER_PAGE,
      );
  return {
    "@context": FEATURED_COLLECTION_CONTEXT,
    id: `${id}?page=${queryValue(input.page)}`,
    type: "CollectionPage",
    totalItems: head.total,
    ...(inRange && page < pages ? { next: `${id}?page=${page + 1}` } : {}),
    ...(inRange && page > 1 ? { prev: `${id}?page=${page - 1}` } : {}),
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

type CollectionActivity = { type: keyof typeof ID_KINDS; context: unknown; target?: string; object: unknown };

// An activity of the collection's owner for its reach (its followers and members), and for `also` (an item's member)
// besides.
function envelopeOf(
  db: Db,
  reach: Reach,
  now: number,
  activity: CollectionActivity,
  also: string | null = null,
): DeliveryEnvelope {
  return {
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
  };
}

// Records an activity of the collection's owner for its reach (envelopeOf).
function deliver(db: Db, reach: Reach, now: number, activity: CollectionActivity, also: string | null = null): void {
  recordOutbound(db, reach.owner, envelopeOf(db, reach, now, activity, also), now);
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

// AddAccountToCollectionService#distribute_feature_request_activity, CreateCollectionService's for each remote member
// (ActivityPub::FeatureRequestWorker, FeatureRequestSerializer): the request for the remote member's consent to its
// pending item `item` of a local collection, its id the item's activity_uri, which the member's Accept or Reject names
// (feature-requests.ts). Signed by the owner and sent to the member's personal inbox alone (inbox_url). Mastodon's
// carries no actor; Kopje's names the owner, its signer, which Mastodon's receiver takes as it is
// (process_activity_service.rb:83-84). Nothing for any other item.
export function recordFeatureRequest(db: Db, item: string, now: number): void {
  const row = db.first<{
    request: string;
    collection: string;
    owner: string;
    owner_uri: string;
    member: string;
    member_uri: string;
  }>(
    `SELECT i.activity_uri AS request, i.collection_id AS collection, c.account_id AS owner, o.uri AS owner_uri,
				i.account_id AS member, m.uri AS member_uri
			FROM collection_items i INDEXED BY ${COLLECTION_ITEMS_ID_INDEX}
			CROSS JOIN collections c INDEXED BY ${COLLECTIONS_ID_INDEX} ON c.id = i.collection_id
			CROSS JOIN accounts o INDEXED BY ${ACCOUNTS_ID_INDEX} ON o.id = c.account_id
			CROSS JOIN accounts m INDEXED BY ${ACCOUNTS_ID_INDEX} ON m.id = i.account_id
		WHERE i.id = ? AND i.state = 0 AND i.activity_uri IS NOT NULL AND c.local = 1 AND m.domain IS NOT NULL`,
    item,
  );
  if (row === undefined) {
    return;
  }
  recordOutbound(
    db,
    row.owner,
    {
      activity: {
        "@context": FEATURE_REQUEST_CONTEXT,
        id: row.request,
        type: "FeatureRequest",
        actor: row.owner_uri,
        object: row.member_uri,
        instrument: localCollectionUri(row.owner_uri, row.collection),
      },
      audience: { followers: false, accounts: [row.member] },
    },
    now,
    { personalInbox: true },
  );
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
    deliver(db, reach, now, itemRemove(reach, item.id), item.account);
  }
}

function itemRemove(reach: Reach, id: string): CollectionActivity {
  return { type: "Remove", context: AS_CONTEXT, target: reach.uri, object: collectionItemUri(reach.ownerUri, id) };
}

// The same Remove of an item a block takes out, recorded with its members' targets and its followers left to the
// owner's collection job (deliveries.ts beginFollowerStaging): its owner and intent, or null for a collection that is
// not local.
export function stageItemRemove(
  db: Db,
  item: { id: string; collection: string; account: string },
  now: number,
): { owner: string; intent: string } | null {
  const reach = reachOf(db, item.collection);
  if (reach === null) {
    return null;
  }
  const envelope = envelopeOf(db, reach, now, itemRemove(reach, item.id), item.account);
  return { owner: reach.owner, intent: beginFollowerStaging(db, reach.owner, envelope, now) };
}

// ---- A local member's activities about its items in remote collections (#1589's D24).

// The member's Delete of its authorization `authorization` of its item in the remote collection `collection`
// (ActivityPub::DeleteFeatureAuthorizationSerializer, its object the FeatureAuthorizationSerializer's): addressed to
// Public alone, with no signature. The member's revoke LD-signs this very body (collections.ts prepareItemRevoke,
// federation/ld-sign.ts); every other copy (a block, an answer to the owner's listing) is sent as it is, HTTP-signed
// by the member, to the owner alone (docs/mastodon-deviations.md, "Collections").
export function featureDeleteActivity(
  memberUri: string,
  authorization: string,
  collection: string,
): Record<string, unknown> {
  return {
    "@context": FEATURE_DELETE_CONTEXT,
    id: `${authorization}#delete`,
    type: "Delete",
    actor: memberUri,
    to: [PUBLIC_COLLECTION],
    object: {
      id: authorization,
      type: "FeatureAuthorization",
      interactingObject: collection,
      interactionTarget: memberUri,
    },
  };
}

// The member's answer to the owner's FeatureRequest `request` (ActivityPub::AcceptFeatureRequestSerializer and
// RejectFeatureRequestSerializer): its id under the member's (`#accepts/feature_requests/<n>`,
// `#rejects/feature_requests/<n>`, n the item's id, or a fresh local id for a refusal that stores no item, where
// Mastodon writes an unsaved item's empty id), `to` the owner, `object` the request answered, and an Accept's `result`
// the authorization it grants. To the owner's personal inbox alone (queue_delivery!: @account.inbox_url).
export function featureAnswerEnvelope(
  kind: "Accept" | "Reject",
  member: { uri: string },
  owner: { id: string; uri: string },
  request: string,
  n: string,
  result: string | null,
): { activity: Record<string, unknown>; audience: { followers: false; accounts: string[] } } {
  return {
    activity: {
      "@context": AS_CONTEXT,
      id: `${member.uri}#${kind === "Accept" ? "accepts" : "rejects"}/feature_requests/${n}`,
      type: kind,
      actor: member.uri,
      to: owner.uri,
      object: request,
      ...(result === null ? {} : { result }),
    },
    audience: { followers: false, accounts: [owner.id] },
  };
}
