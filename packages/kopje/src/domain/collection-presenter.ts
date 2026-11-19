import { type ColumnMap, fixedColumns, selectSql } from "../db/columns";
import { ACCOUNTS_ID_INDEX, COLLECTION_ITEMS_ID_INDEX, COLLECTIONS_ID_INDEX } from "../db/indexes";
import type { Db } from "../db/sql";
import { sameOrigin } from "../platform/http-url";
import { ROUTE_USERNAME } from "../platform/identity-bounds";
import {
  COLLECTION_DESCRIPTION_LENGTH,
  COLLECTION_NAME_LENGTH,
  COLLECTION_URI_BYTES,
  COLLECTION_URL_BYTES,
} from "../platform/stored-bounds";
import { collectionFoundSql, collectionItemShownSql, collectionShownSql, collectionViewerSql } from "./audience";
import { instanceOrigin } from "./instance-domain";
import { actorUriSql } from "./profile-bounds";
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

// A collection's owner as every read that names a local collection's id takes it: its stored actor id, as actorUriSql
// reads it ('' past ACTOR_URI_LIMIT), under alias `a`.
export function collectionOwnerSql(a: string): string {
  return `${actorUriSql(`${a}.uri`)} AS owner_uri`;
}

// A collection's owner as collectionOwnerSql reads it.
export type CollectionOwner = { owner_uri: string | null };

// A local collection's ID (ActivityPub::TagManager#uri_for, #1589's D1): its owner's stored actor id and the collection
// id, built here alone, in TypeScript (no SQL builds it), for every surface that emits or compares it: REST's uri and
// tagged_collections, a Note's tag, the FeaturedCollection, featured_collections, a FeaturedItem and a local member's
// FeatureAuthorization, the page's alternate, the collection's activities, a Flag, and the authorizations checked
// against it (test-node/tagged-collection-reads holds that no other code spells the path). Nothing compares it with the
// request's host or the configured one: it resolves exactly when its owner's actor id does, so an account whose actor
// id was kept from an earlier domain or restored under another name has collections no more and no less reachable
// than itself. null only for no actor id: none, past ACTOR_URI_LIMIT as actorUriSql reads it, or not a URL.
export function localCollectionUri(ownerUri: string | null, id: string): string | null {
  return ownerUri === null || !URL.canParse(ownerUri) ? null : `${ownerUri}/collections/${id}`;
}

// The path of a local collection's id that the collection route takes (federation/routes.ts COLLECTION: a
// ROUTE_USERNAME under /ap/users/ and the id's 18 digits), with no query or fragment, on any host (#1589's D2).
const ROUTED_ID_PATH = new RegExp(`^/ap/users/${ROUTE_USERNAME}/collections/\\d{18}$`);

function routedPath(id: string): boolean {
  if (!URL.canParse(id)) {
    return false;
  }
  const url = new URL(id);
  return url.search === "" && url.hash === "" && ROUTED_ID_PATH.test(url.pathname);
}

// A tagged collection as a tag reads it (TAGGED_COLLECTION_COLUMNS).
type TaggedRow = CollectionRow & { text_replacements: number; owner_local: number };

// The U+FFFD in a text as read.
function replacements(text: string | null): number {
  return text === null ? 0 : text.split("\uFFFD").length - 1;
}

// Whether a tagged collection's presented text (name, description and tag) is well-formed UTF-8 as stored. Decoding
// gives one U+FFFD for each malformed sequence and decodes well-formed bytes exactly, each stored EF BF BD to one
// U+FFFD (EF starts a sequence, so no malformed one takes it in), so a text read with more U+FFFD than it stores
// (text_replacements) is malformed, a replacement of the same width included: no JSON carries a value decoding
// replaced.
function wellFormed(row: TaggedRow): boolean {
  return replacements(row.name) + replacements(row.description) + replacements(row.tag) === row.text_replacements;
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

// Whether a status can tag the collection `row`, as stored (#1589's D2): its text well-formed (wellFormed); a local one
// owned by a local account, its id (localCollectionUri) on a path the collection route takes (routedPath); a remote one
// valid (validRemoteCollection) with its text within its writer's bounds (withinRemoteText), its id not on the
// instance's origin (`instance`, read only for a remote row), where only a local collection is.
function taggable(row: TaggedRow, instance: () => string | null): boolean {
  if (!wellFormed(row)) {
    return false;
  }
  if (row.local === 1) {
    const id = localCollectionUri(row.owner_uri, row.id);
    return row.owner_local === 1 && id !== null && routedPath(id);
  }
  return (
    validRemoteCollection(row.uri, row.owner_uri) && withinRemoteText(row) && new URL(row.uri!).origin !== instance()
  );
}

// The collections a read names (`from` joins `collections c` and its owner `accounts a`; `where` picks them, with
// `params`) that a status can tag whatever the viewer (#1589's D26, D2): its owner available (collectionFoundSql: not
// suspended, deleted or covered) and taggable. The writer (collections.ts) resolves a status's links and tags through it
// before it takes the first MAX_TAGGED_COLLECTIONS, and the REST presenter (taggedCollectionsOf, adding R45's part
// that depends on the viewer) and the Note (activities.ts statusFacts) read a status's references through it, which
// leaves out a row restored, written before a rule was, or whose owner became unavailable since: one decision, so a
// collection takes a slot only when every surface would show it to some viewer. Each row with
// TAGGED_COLLECTION_COLUMNS, which R's term charges. `origin`: the instance's (instanceOrigin), read once at most, and
// only for a remote row; the writer, which has read it, passes it.
export function taggableCollections(
  db: Db,
  origin: string | null | undefined,
  from: string,
  where: string,
  ...params: SqlStorageValue[]
): TaggedRow[] {
  let instance = origin;
  const instanceOf = () => (instance === undefined ? (instance = instanceOrigin(db)) : instance);
  return db
    .all<TaggedRow>(
      `SELECT ${selectSql(TAGGED_COLLECTION_COLUMNS)} FROM ${from} WHERE ${collectionFoundSql("c")} AND ${where}`,
      ...params,
    )
    .filter((row) => taggable(row, instanceOf));
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

// A stored collection with its owner (a local one's id names it: localCollectionUri).
export type CollectionRow = CollectionOwner & {
  id: string;
  account_id: string;
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

export const COLLECTION_COLUMNS = `c.id, c.account_id, ${collectionOwnerSql("a")}, c.local, c.name, c.description,
	c.language, c.sensitive, c.discoverable, c.tag, c.uri, c.url, c.created_at, c.updated_at`;

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

// The U+FFFD a stored text holds as bytes (EF BF BD), 0 for NULL. replace() compares bytes and returns text, whose
// length counts characters, so both lengths are of bytes.
function storedReplacementsSql(column: string): string {
  const bytes = (text: string) => `length(CAST(${text} AS BLOB))`;
  return `coalesce((${bytes(column)} - ${bytes(`replace(CAST(${column} AS BLOB), X'EFBFBD', X'')`)}) / 3, 0)`;
}

// A tagged collection as taggedCollectionsOf reads it, every text column within a bound of stored bytes before it
// reaches JavaScript: its columns as stored, each within its CHECK, imports included (migration 0103_collections: the
// name, description and tag by stored bytes, the uri, url, language and times ASCII); whether its owner is a local
// account, and its owner's actor id (collectionOwnerSql), against which a remote one's id is judged
// (validRemoteCollection: '' past ACTOR_URI_LIMIT is invalid) and from which a local one's is built
// (localCollectionUri); and the U+FFFD the name, description and tag store, which wellFormed compares. R's term charges
// these columns, and every read of them is taggableCollections'.
export const TAGGED_COLLECTION_COLUMNS: ColumnMap = {
  id: "c.id",
  account_id: "c.account_id",
  owner_local: "a.domain IS NULL",
  text_replacements: ["c.name", "c.description", "c.tag"].map(storedReplacementsSql).join(" + "),
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
  owner_uri: actorUriSql("a.uri"),
};

// Collection#to_param's page: a local collection's url (collection_url, the page of web-pages/collection.ts).
export function collectionUrl(origin: string, id: string): string {
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

// Collection's ActivityPub id (ActivityPub::TagManager#uri_for): a local one's as localCollectionUri builds it (null for
// an actor id it does not read), a remote one's as stored.
export function collectionUri(row: CollectionOwner & Pick<CollectionRow, "id" | "local" | "uri">): string | null {
  return row.local === 1 ? localCollectionUri(row.owner_uri, row.id) : (row.uri ?? "");
}

// The Collection `row` presents with `items`: its uri '' where collectionUri gives none, as a remote one's is without
// a stored id; `origin` the request's, for its url and its tag's, as Mastodon's url helpers take the request's host.
export function presentCollection(row: CollectionRow, items: readonly ItemRow[], origin: string): Collection {
  const uri = collectionUri(row) ?? "";
  const presented = items.map(presentItem);
  const local = row.local === 1;
  return {
    id: row.id,
    uri,
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
// with its owner, then shownItems once for them, so a collection several statuses tag is read once. A collection is
// shown only while a status can tag it (taggable), and a remote one's url only when its writer would store it
// (storableUrl), else its uri (presentCollection), so a restored row shows nothing a writer would not have admitted and
// each stays within COLLECTION_JSON_MAX.
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
  const shown = taggableCollections(
    db,
    undefined,
    `json_each(?1) w CROSS JOIN collections c INDEXED BY ${COLLECTIONS_ID_INDEX} ON c.id = w.value
			CROSS JOIN accounts a INDEXED BY ${ACCOUNTS_ID_INDEX} ON a.id = c.account_id`,
    collectionViewerSql("c", "?2"),
    JSON.stringify([...new Set(references.map((reference) => reference.collection_id))]),
    viewer,
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
