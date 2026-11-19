import { type ColumnMap, fixedColumns, selectSql } from "../db/columns";
import { ACCOUNTS_ID_INDEX, COLLECTION_ITEMS_ID_INDEX, COLLECTIONS_ID_INDEX } from "../db/indexes";
import type { Db } from "../db/sql";
import { sameOrigin } from "../platform/http-url";
import {
  COLLECTION_DESCRIPTION_LENGTH,
  COLLECTION_NAME_LENGTH,
  COLLECTION_URI_BYTES,
  COLLECTION_URL_BYTES,
} from "../platform/stored-bounds";
import { collectionItemShownSql, collectionShownSql } from "./audience";
import { usernameSql } from "./profile-bounds";
import { withinTagNameBound } from "./tag-bounds";
import { normalizeTag } from "./tag-name";

// The Collection entity (REST::CollectionSerializer and CollectionItemSerializer, as Mastodon 4.7.5 serves them) and
// its reads, apart from collections.ts, which notifies (notifications.ts), so the notification presenters can present
// a collection notification's collection without a cycle.

const STATE_NAMES = ["pending", "accepted", "rejected", "revoked"] as const;

const ENCODER = new TextEncoder();

// The stored form of a remote URI (stored-bounds.ts httpsUrlWhen): an https URL of printable ASCII within `bytes`.
export function storableUrl(value: string | null, bytes: number): value is string {
  return (
    value !== null && /^https:\/\/[!-~]+$/.test(value) && ENCODER.encode(value).length <= bytes && URL.canParse(value)
  );
}

// Whether a remote collection's id `uri` is one remote-featured-collections.ts stores for the owner of id `ownerUri`:
// within the stored bound and on the owner's origin (ProcessFeaturedCollectionService's non_matching_uri_hosts?). Every
// reader that resolves or shows a stored remote collection by its uri (a status's tags, #1589's D26) judges it alike,
// so a restored row no writer would store is neither referenced nor shown.
export function validRemoteCollection(uri: string | null, ownerUri: string | null): boolean {
  return storableUrl(uri, COLLECTION_URI_BYTES) && sameOrigin(uri, ownerUri);
}

// Whether a remote collection's name and description, as read, are within the code points its writer stores
// (COLLECTION_NAME_LENGTH and COLLECTION_DESCRIPTION_LENGTH's remote bounds), which COLLECTION_JSON_MAX charges at six
// JSON bytes each. A restored row's malformed UTF-8 passes the CHECK, which counts a lead byte and its continuation
// bytes as one character, yet is read as a U+FFFD for each byte, three JSON bytes: a description of 2,048 such
// characters of four bytes presents 24,576 bytes, twice its charge.
function withinRemoteText(row: { name: string; description: string | null }): boolean {
  return (
    [...row.name].length <= COLLECTION_NAME_LENGTH.remote &&
    (row.description === null || [...row.description].length <= COLLECTION_DESCRIPTION_LENGTH.remote)
  );
}

type CollectionItemStateName = (typeof STATE_NAMES)[number];

// REST::ShallowTagSerializer.
type ShallowTag = { name: string; url: string };

// REST::CollectionItemSerializer: account_id only while pending or accepted.
export type CollectionItem = { id: string; state: CollectionItemStateName; created_at: string; account_id?: string };

// REST::CollectionSerializer, its keys in its order.
export type Collection = {
  id: string;
  uri: string;
  name: string;
  description: string | null;
  language: string | null;
  account_id: string;
  local: boolean;
  sensitive: boolean;
  discoverable: boolean;
  url: string;
  item_count: number;
  created_at: string;
  updated_at: string;
  tag: ShallowTag | null;
  items: CollectionItem[];
};

// A stored collection with its owner's username (the local uri names it).
export type CollectionRow = {
  id: string;
  account_id: string;
  username: string;
  local: number;
  name: string;
  description: string | null;
  language: string | null;
  sensitive: number;
  discoverable: number;
  tag: string | null;
  uri: string | null;
  url: string | null;
  created_at: string;
  updated_at: string;
};

export const COLLECTION_COLUMNS = `c.id, c.account_id, ${usernameSql("a.username")} AS username, c.local, c.name, c.description, c.language, c.sensitive,
	c.discoverable, c.tag, c.uri, c.url, c.created_at, c.updated_at`;

type ItemRow = {
  collection_id: string;
  id: string;
  state: number;
  position: number;
  account_id: string | null;
  created_at: string;
};

// The columns of ItemRow as shownItems reads them, each within its CHECK (migration 0103_collections): ids of 18
// digits, the state and position, a 24-byte ISO time.
export const ITEM_COLUMNS = fixedColumns(
  {
    collection_id: "i.collection_id",
    id: "i.id",
    state: "i.state",
    position: "i.position",
    account_id: "i.account_id",
    created_at: "i.created_at",
  },
  { collection_id: 18, id: 18, state: 0, position: 0, account_id: 18, created_at: 24 },
);

// A status's references to the collections it tags (status_collections, migration 0120_tagged_collections), as
// taggedCollectionsOf reads them.
export const TAG_REFERENCE_COLUMNS = fixedColumns(
  { status_id: "r.status_id", collection_id: "r.collection_id" },
  { status_id: 18, collection_id: 18 },
);

// A tagged collection as taggedCollectionsOf reads it: its columns as stored, each within its CHECK (migration
// 0103_collections), its owner's username (a local collection's uri names it) and its owner's uri, against which a
// remote one's id is judged (validRemoteCollection).
export const TAGGED_COLLECTION_COLUMNS: ColumnMap = {
  id: "c.id",
  account_id: "c.account_id",
  username: usernameSql("a.username"),
  local: "c.local",
  name: "c.name",
  description: "c.description",
  language: "c.language",
  sensitive: "c.sensitive",
  discoverable: "c.discoverable",
  tag: "c.tag",
  uri: "c.uri",
  url: "c.url",
  created_at: "c.created_at",
  updated_at: "c.updated_at",
  owner_uri: "a.uri",
};

// Collection#to_param's page: a local collection's url (collection_url, the page of web-pages/collection.ts).
function collectionUrl(origin: string, id: string): string {
  return `${origin}/collections/${id}`;
}

function stateName(state: number): CollectionItemStateName {
  const name = STATE_NAMES[state];
  if (name === undefined) {
    throw new Error("a collection item's state is past its stored bound");
  }
  return name;
}

export function presentItem(row: Omit<ItemRow, "position">): CollectionItem {
  const state = stateName(row.state);
  return {
    id: row.id,
    state,
    created_at: row.created_at,
    ...((state === "pending" || state === "accepted") && row.account_id !== null ? { account_id: row.account_id } : {}),
  };
}

// The tag as ShallowTagSerializer presents it: the hashtag's normalized name (Tag#name) and its page; none when the
// stored name normalizes to no hashtag.
function shallowTag(tag: string | null, origin: string): ShallowTag | null {
  if (tag === null) {
    return null;
  }
  const name = normalizeTag(tag);
  return name === "" || !withinTagNameBound(name) ? null : { name, url: `${origin}/tags/${encodeURIComponent(name)}` };
}

// Collection's ActivityPub id (ActivityPub::TagManager#uri_for): a local one's under its owner's actor, a remote one's
// as stored.
export function collectionUri(row: Pick<CollectionRow, "id" | "local" | "username" | "uri">, origin: string): string {
  return row.local === 1 ? `${origin}/ap/users/${row.username}/collections/${row.id}` : (row.uri ?? "");
}

export function presentCollection(row: CollectionRow, items: readonly ItemRow[], origin: string): Collection {
  const presented = items.map(presentItem);
  const local = row.local === 1;
  return {
    id: row.id,
    uri: collectionUri(row, origin),
    name: row.name,
    description: row.description,
    language: row.language,
    account_id: row.account_id,
    local,
    sensitive: row.sensitive === 1,
    discoverable: row.discoverable === 1,
    url: local ? collectionUrl(origin, row.id) : (row.url ?? row.uri ?? ""),
    item_count: presented.length,
    created_at: row.created_at,
    updated_at: row.updated_at,
    tag: shallowTag(row.tag, origin),
    items: presented,
  };
}

// Ids of 18 digits, whose text order is their numeric order.
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// The items of `collections` R45 shows `viewer`, by collection, each in position order: at most MAX_STORED_ITEMS rows
// read per collection through collection_items_order, put in order here, so no query sorts the payload of several
// collections (the status presenter reads a chunk's at once).
export function shownItems(db: Db, collections: readonly string[], viewer: string | null): Map<string, ItemRow[]> {
  const byCollection = new Map<string, ItemRow[]>(collections.map((id) => [id, []]));
  if (collections.length === 0) {
    return byCollection;
  }
  const rows = db.all<ItemRow>(
    `SELECT ${selectSql(ITEM_COLUMNS.columns)}
		FROM json_each(?1) w CROSS JOIN collections c INDEXED BY ${COLLECTIONS_ID_INDEX} ON c.id = w.value
			CROSS JOIN collection_items i INDEXED BY collection_items_order ON i.collection_id = c.id
		WHERE ${collectionItemShownSql("i", "c", "?2")}`,
    JSON.stringify(collections),
    viewer,
  );
  for (const row of rows.toSorted((a, b) => a.position - b.position || compareIds(a.id, b.id))) {
    byCollection.get(row.collection_id)?.push(row);
  }
  return byCollection;
}

// The collections each status of `statuses` (ids of statuses that are not boosts) tags that R45 shows `viewer`, by
// status, each status's in collection-id order with the items R45 shows the viewer (#1589's D26): the references by
// the primary key's prefix (at most MAX_TAGGED_COLLECTIONS a status, the trigger's bound), each collection once by key
// with its owner, then shownItems once for them, so a collection several statuses tag is read once. A remote
// collection is shown only while valid (validRemoteCollection) with its text within its writer's bounds
// (withinRemoteText), and its url only when its writer would store it (storableUrl), else its uri (presentCollection),
// so a restored row shows nothing a writer would not have admitted and each stays within COLLECTION_JSON_MAX.
export function taggedCollectionsOf(
  db: Db,
  statuses: readonly string[],
  viewer: string | null,
  origin: string,
): Map<string, Collection[]> {
  const tagged = new Map<string, Collection[]>();
  const references =
    statuses.length === 0
      ? []
      : db.all<{ status_id: string; collection_id: string }>(
          `SELECT ${selectSql(TAG_REFERENCE_COLUMNS.columns)} FROM (SELECT DISTINCT value FROM json_each(?1)) j
					CROSS JOIN status_collections r ON r.status_id = j.value`,
          JSON.stringify(statuses),
        );
  if (references.length === 0) {
    return tagged;
  }
  const rows = db.all<CollectionRow & { owner_uri: string | null }>(
    `SELECT ${selectSql(TAGGED_COLLECTION_COLUMNS)} FROM json_each(?1) w
			CROSS JOIN collections c INDEXED BY ${COLLECTIONS_ID_INDEX} ON c.id = w.value
			CROSS JOIN accounts a INDEXED BY ${ACCOUNTS_ID_INDEX} ON a.id = c.account_id
		WHERE ${collectionShownSql("c", "?2")}`,
    JSON.stringify([...new Set(references.map((reference) => reference.collection_id))]),
    viewer,
  );
  const shown = rows.filter(
    (row) => row.local === 1 || (validRemoteCollection(row.uri, row.owner_uri) && withinRemoteText(row)),
  );
  const items = shownItems(
    db,
    shown.map((row) => row.id),
    viewer,
  );
  const presented = new Map(
    shown.map((row) => {
      const url = row.local === 1 || storableUrl(row.url, COLLECTION_URL_BYTES) ? row.url : null;
      return [row.id, presentCollection({ ...row, url }, items.get(row.id) ?? [], origin)];
    }),
  );
  for (const { status_id, collection_id } of references.toSorted((a, b) =>
    compareIds(a.collection_id, b.collection_id),
  )) {
    const collection = presented.get(collection_id);
    if (collection !== undefined) {
      tagged.set(status_id, [...(tagged.get(status_id) ?? []), collection]);
    }
  }
  return tagged;
}

export function presentCollections(db: Db, rows: readonly CollectionRow[], viewer: string | null, origin: string) {
  const items = shownItems(
    db,
    rows.map((row) => row.id),
    viewer,
  );
  return rows.map((row) => presentCollection(row, items.get(row.id) ?? [], origin));
}

// The collection the notification `id` of `recipient` is about (Notification#target_collection: an
// added_to_collection's item's collection, a collection_update's collection), as R45 shows it to the recipient, with
// the items R45 shows the recipient; undefined when it is gone or R45 does not show it. The notification, the item,
// the collection and its owner by their keys, then shownItems.
export function notifiedCollection(db: Db, id: string, recipient: string, origin: string): Collection | undefined {
  const row = db.first<CollectionRow>(
    `SELECT ${COLLECTION_COLUMNS} FROM collections c INDEXED BY ${COLLECTIONS_ID_INDEX}
			CROSS JOIN accounts a INDEXED BY ${ACCOUNTS_ID_INDEX} ON a.id = c.account_id
		WHERE c.id = (SELECT coalesce(n.collection_id, (SELECT ni.collection_id FROM collection_items ni
				INDEXED BY ${COLLECTION_ITEMS_ID_INDEX} WHERE ni.id = n.collection_item_id))
			FROM notifications n WHERE n.id = CAST(?1 AS INTEGER) AND n.account_id = ?2)
			AND ${collectionShownSql("c", "?2")}`,
    id,
    recipient,
  );
  return row === undefined ? undefined : presentCollections(db, [row], recipient, origin)[0];
}
