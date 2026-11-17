import { ACCOUNTS_ID_INDEX, COLLECTION_ITEMS_ID_INDEX, COLLECTIONS_ID_INDEX } from "../db/indexes";
import type { Db } from "../db/sql";
import { collectionItemShownSql, collectionShownSql } from "./audience";
import { usernameSql } from "./profile-bounds";
import { withinTagNameBound } from "./tag-bounds";
import { normalizeTag } from "./tag-name";

// The Collection entity (REST::CollectionSerializer and CollectionItemSerializer, as Mastodon 4.7.5 serves them) and
// its reads, apart from collections.ts, which notifies (notifications.ts), so the notification presenters can present
// a collection notification's collection without a cycle.

const STATE_NAMES = ["pending", "accepted", "rejected", "revoked"] as const;

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
  account_id: string | null;
  created_at: string;
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

export function presentItem(row: ItemRow): CollectionItem {
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

// The items of `collections` R45 shows `viewer`, by collection, each in position order: at most MAX_STORED_ITEMS rows
// read per collection through collection_items_order.
export function shownItems(db: Db, collections: readonly string[], viewer: string | null): Map<string, ItemRow[]> {
  const byCollection = new Map<string, ItemRow[]>(collections.map((id) => [id, []]));
  if (collections.length === 0) {
    return byCollection;
  }
  const rows = db.all<ItemRow>(
    `SELECT i.collection_id, i.id, i.state, i.account_id, i.created_at
		FROM json_each(?1) w CROSS JOIN collections c INDEXED BY ${COLLECTIONS_ID_INDEX} ON c.id = w.value
			CROSS JOIN collection_items i INDEXED BY collection_items_order ON i.collection_id = c.id
		WHERE ${collectionItemShownSql("i", "c", "?2")}
		ORDER BY w.key, i.position, i.id`,
    JSON.stringify(collections),
    viewer,
  );
  for (const row of rows) {
    byCollection.get(row.collection_id)?.push(row);
  }
  return byCollection;
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
