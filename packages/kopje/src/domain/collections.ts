import { writeEach } from "../db/by-ids";
import { ACCOUNTS_ID_INDEX, COLLECTION_ITEMS_ID_INDEX, COLLECTIONS_ID_INDEX } from "../db/indexes";
import type { Db } from "../db/sql";
import {
  COLLECTION_DESCRIPTION_LENGTH,
  COLLECTION_ITEM_STATES,
  COLLECTION_MAX_ITEMS,
  COLLECTION_NAME_LENGTH,
  COLLECTION_POSITION_MAX,
  MAX_STORED_ITEMS,
  storedText,
} from "../platform/stored-bounds";
import {
  type Account,
  type Page,
  type PageQuery,
  type Present,
  presentAccountsWithin,
  presentFor,
  type PresentInput,
  routeAccountId,
} from "./accounts";
import { ANSWER_BYTES, jsonBytes } from "./answer-budget";
import {
  availableSql,
  collectionFoundSql,
  collectionListedSql,
  collectionShownSql,
  inCollectionsSql,
  mayFeatureSql,
} from "./audience";
import { COLLECTION_LIMIT, optionalUserReadOperation, userReadOperation, userWriteOperation } from "./auth";
import {
  recordCollectionAdd,
  recordCollectionRemove,
  recordCollectionUpdate,
  recordItemAdd,
  recordItemRemove,
  stageItemRemove,
} from "./collection-documents";
import { beginCollectionJobs } from "./collection-jobs";
import {
  type Collection,
  COLLECTION_COLUMNS,
  type CollectionItem,
  type CollectionRow,
  collectionUri,
  presentCollection,
  presentCollections,
  presentItem,
  shownItems,
} from "./collection-presenter";
import { allocateLocalId, insertWithFreshId, requestedId, storedIdOf } from "./ids";
import { blank } from "./lists";
import { notify } from "./notifications";
import { writeOperation } from "./operation";
import { usernameSql } from "./profile-bounds";
import { RowBudget } from "./row-budget";
import { isHashtagName } from "./status-text";
import { TAG_NAME_TOO_LONG, withinTagNameBound } from "./tag-bounds";
import { normalizeTag, tagDisplayName } from "./tag-name";
import { TREND_LANGUAGES } from "./trend-languages";
import { ABOVE_EVERY_ID, BELOW_EVERY_ID, readWindow, statusCursor, windowOf, windowPage } from "./windows";

// Collections (Mastodon 4.6's Collection and CollectionItem, served as 4.7.5 serves them: Api::V1::CollectionsController,
// CollectionItemsController and InCollectionsController; REST::CollectionSerializer, CollectionItemSerializer and
// CollectionWithAccountsSerializer). A local account features up to COLLECTION_MAX_ITEMS accounts in each of up to
// COLLECTION_LIMIT collections; who sees what is R45 (audience.ts, docs/visibility.md). Only local accounts can be
// featured yet: a remote one fails the consent rule (mayFeatureSql). The stored bounds are migration 0100's CHECKs and
// triggers (stored-bounds.ts, stored-triggers.ts). A member added is notified added_to_collection, and the accepted
// members of a collection whose name, description, sensitivity or tag changes collection_update (notifications.ts:
// local recipients only, R15); each notification goes with its item or collection (migration
// 0107_collection_notifications), its pushes with it.

// in_collections honours `offset` as a raw skip of candidates up to this many (ten default pages); past it the page is
// empty (docs/mastodon-deviations.md, "Collections").
const IN_COLLECTIONS_MAX_OFFSET = 400;

// CollectionItemCleanupScheduler: rejected and revoked items are kept this long after their last change, so a re-add
// within it is the same uniqueness error and in_collections still lists them.
const RETIRED_ITEM_TTL_MS = 24 * 60 * 60 * 1000;

// The rows the cleanup writes per round (RES-4): the retired items and their notifications' pushes and notifications.
export const RETIRED_ROWS_PER_ROUND = 500;

// Collection#user_does_not_exceed_limit's error (errors.add(:base, :too_many, count: limit)). Mastodon has no English
// text for it and answers a missing-translation message; Kopje answers the sentence of the sibling key
// (docs/mastodon-deviations.md, "Collections").
const COLLECTION_LIMIT_MESSAGE = `Collections are too many, no more than ${COLLECTION_LIMIT} are allowed`;

// The most JSON a Collection presents (RES-3), each derived from the bounds and measured by test/collections.test.ts: a
// local one's name and description at their bounds in characters JSON escapes to six bytes, its tag at the tag-name
// bound (its URL encoding each byte in three), 25 accepted items, an instance domain of 253 octets and an owner's
// username at LOCAL_USERNAME_BYTES; a remote one's longer name and description likewise, and its stored uri and url at
// their bounds of printable ASCII, which JSON escapes to two bytes at most. COLLECTION_JSON_MAX is the larger, a remote
// one's.
export const LOCAL_COLLECTION_JSON_MAX = 9_165;
export const COLLECTION_JSON_MAX = 29_701;

// REST::CollectionWithAccountsSerializer.
export type CollectionWithAccounts = { collection: Collection; accounts: Account[] };

// One error of a Rails model (ActiveModel::Error), as mastodon/errors.ts formats it.
export type Problem = { attribute: string; type: string; description: string };

const ITEMS_TOO_MANY: Problem = {
  attribute: "collection_items",
  type: "too_many",
  description: `are too many, no more than ${COLLECTION_MAX_ITEMS} are allowed`,
};

const ACCOUNT_TAKEN: Problem = { attribute: "account_id", type: "taken", description: "has already been taken" };

// The collection `id` (as the route names it) when R45 finds it.
function foundCollection(db: Db, id: string): CollectionRow | undefined {
  return db.first<CollectionRow>(
    `SELECT ${COLLECTION_COLUMNS} FROM collections c INDEXED BY ${COLLECTIONS_ID_INDEX}
			CROSS JOIN accounts a INDEXED BY ${ACCOUNTS_ID_INDEX} ON a.id = c.account_id
		WHERE c.id = ? AND ${collectionFoundSql("c")}`,
    id,
  );
}

// The account an account id parameter names (Account.without_requested_deletion.find: as the account routes name it,
// else read as Ruby's to_i reads it), unless it is unavailable (R1): Kopje features no unavailable account.
function availableAccount(db: Db, raw: string): string | null {
  const id = routeAccountId(db, raw) ?? routeAccountId(db, storedIdOf(requestedId(raw)));
  return id === null || db.first(`SELECT 1 AS x WHERE ${availableSql("?1")}`, id) === undefined ? null : id;
}

function mayFeature(db: Db, owner: string, member: string): boolean {
  return db.first(`SELECT 1 AS x WHERE ${mayFeatureSql("?1", "?2")}`, owner, member) !== undefined;
}

// GET /api/v1/accounts/:account_id/collections: the account's collections R45 lists to the viewer, newest first,
// `offset` and `limit` as Mastodon reads them (LIMIT/OFFSET over at most MAX_STORED_COLLECTIONS index entries). Null
// for an account not found; no collections when R45 refuses its owner. `owner`: the account's id, which the links name;
// `full`: the page holds `limit` collections, so a next page may follow.
export const accountCollections = optionalUserReadOperation<
  { account: string; offset: number; limit: number; present: PresentInput },
  { owner: string; collections: Collection[]; full: boolean } | null
>((db, input, { accountId: viewer }) => {
  const owner = routeAccountId(db, input.account);
  if (owner === null) {
    return null;
  }
  const rows =
    input.limit === 0
      ? []
      : db.all<CollectionRow>(
          `SELECT ${COLLECTION_COLUMNS} FROM collections c INDEXED BY collections_account
						CROSS JOIN accounts a INDEXED BY ${ACCOUNTS_ID_INDEX} ON a.id = c.account_id
					WHERE c.account_id = ?1 AND ${collectionListedSql("c", "?2")}
					ORDER BY c.created_at DESC, c.id DESC LIMIT ?3 OFFSET ?4`,
          owner,
          viewer,
          input.limit,
          input.offset,
        );
  return {
    owner,
    collections: presentCollections(db, rows, viewer, input.present.origin),
    full: input.limit > 0 && rows.length === input.limit,
  };
});

export type InCollectionsResult =
  | { status: "user_required" }
  | { status: "not_found" }
  | { status: "forbidden" }
  | { status: "ok"; page: Page<Collection> };

// GET /api/v1/accounts/:account_id/in_collections: the collections holding an item of the viewer, who must be the
// account, in any state, newest item first (R45 inCollectionsSql). A candidate window (windows.ts): from the cursor (an
// item id) at most readWindow(limit) of the viewer's items through collection_items_account, `offset` skipped inside
// the same walk (at most IN_COLLECTIONS_MAX_OFFSET; past it the page is empty), the owner's availability tested on
// those alone, outside the window's LIMIT. A page cut at its window links on from its last candidate.
export const inCollections = optionalUserReadOperation<
  { account: string; page: PageQuery; offset: number; present: PresentInput },
  InCollectionsResult
>((db, input, { accountId: viewer }) => {
  if (viewer === null) {
    return { status: "user_required" };
  }
  const account = routeAccountId(db, input.account);
  if (account === null) {
    return { status: "not_found" };
  }
  if (account !== viewer) {
    return { status: "forbidden" };
  }
  const { page } = input;
  if (page.limit === 0 || input.offset > IN_COLLECTIONS_MAX_OFFSET) {
    return { status: "ok", page: { items: [], newest: null, oldest: null } };
  }
  const ascending = page.minId !== undefined;
  const size = readWindow(page.limit);
  const max = statusCursor(page.maxId) ?? ABOVE_EVERY_ID;
  const min = statusCursor(page.minId ?? page.sinceId) ?? BELOW_EVERY_ID;
  const candidates = db
    .all<{ id: string; collection_id: string; found: number }>(
      `SELECT w.id, w.collection_id, ${inCollectionsSql("w", "c", "?1")} AS found
			FROM (SELECT i.id, i.collection_id, i.account_id FROM collection_items i INDEXED BY collection_items_account
				WHERE i.account_id = ?1 AND i.id < ?2 AND i.id > ?3
				ORDER BY i.id ${ascending ? "ASC" : "DESC"} LIMIT ?4 OFFSET ?5) w
			CROSS JOIN collections c INDEXED BY ${COLLECTIONS_ID_INDEX} ON c.id = w.collection_id`,
      viewer,
      max,
      min,
      size,
      input.offset,
    )
    .toSorted((a, b) => (a.id < b.id === ascending ? -1 : 1));
  const window = windowOf(
    candidates.map((row) => row.id),
    size,
  );
  const shown = windowPage(
    window,
    candidates.filter((row) => row.found === 1),
    (row) => row.id,
    page.limit,
    ascending,
  );
  const rows = db.all<CollectionRow>(
    `SELECT ${COLLECTION_COLUMNS} FROM json_each(?1) w
			CROSS JOIN collections c INDEXED BY ${COLLECTIONS_ID_INDEX} ON c.id = w.value
			CROSS JOIN accounts a INDEXED BY ${ACCOUNTS_ID_INDEX} ON a.id = c.account_id
		ORDER BY w.key`,
    JSON.stringify(shown.rows.map((row) => row.collection_id)),
  );
  return {
    status: "ok",
    page: {
      items: presentCollections(db, rows, viewer, input.present.origin),
      newest: shown.newest,
      oldest: shown.oldest,
      ...(shown.cut ? { cut: true } : {}),
    },
  };
});

export type ShowResult =
  | { status: "not_found" }
  | { status: "forbidden" }
  | { status: "ok"; value: CollectionWithAccounts };

// The collection with its accounts as CollectionWithAccountsSerializer presents it: the owner, then each shown item's
// account in item order (the owner again when it features itself), within ANSWER_BYTES.
function withAccounts(db: Db, row: CollectionRow, viewer: string | null, present: Present): CollectionWithAccounts {
  const items = shownItems(db, [row.id], viewer).get(row.id) ?? [];
  const collection = presentCollection(row, items, present.origin);
  const ids = [row.account_id, ...items.flatMap((item) => (item.account_id === null ? [] : [item.account_id]))];
  // The answer's frame around the accounts array: {"collection":…,"accounts":[…]}.
  const frame = jsonBytes({ collection, accounts: [] });
  const { items: accounts } = presentAccountsWithin(db, ids, present, ANSWER_BYTES - frame, true);
  return { collection, accounts };
}

// Whether R45 shows the collection `id` to `viewer` (a found one).
function shown(db: Db, id: string, viewer: string | null): boolean {
  return (
    db.first(
      `SELECT 1 AS x FROM collections c INDEXED BY ${COLLECTIONS_ID_INDEX} WHERE c.id = ?1 AND ${collectionShownSql("c", "?2")}`,
      id,
      viewer,
    ) !== undefined
  );
}

// GET /api/v1/collections/:id: 404 unless R45 finds it, 403 unless it shows it to the viewer.
export const showCollection = optionalUserReadOperation<{ id: string; present: PresentInput }, ShowResult>(
  (db, input, { accountId: viewer }) => {
    const row = foundCollection(db, input.id);
    if (row === undefined) {
      return { status: "not_found" };
    }
    if (!shown(db, row.id, viewer)) {
      return { status: "forbidden" };
    }
    return { status: "ok", value: withAccounts(db, row, viewer, presentFor(input.present, viewer)) };
  },
);

// What a create or an update sends: undefined when a field is not sent, null when it is sent as nil (JSON null, or a
// boolean sent blank), which Rails assigns.
export type CollectionFields = {
  name?: string | null | undefined;
  description?: string | null | undefined;
  language?: string | null | undefined;
  sensitive?: boolean | null | undefined;
  discoverable?: boolean | null | undefined;
  tagName?: string | null | undefined;
};

type CollectionValues = {
  name: string | null;
  description: string | null;
  language: string | null;
  sensitive: boolean | null;
  discoverable: boolean | null;
  tag: string | null;
};

export type CollectionResult =
  | { status: "not_found" }
  | { status: "forbidden" }
  | { status: "invalid"; problems: Problem[] }
  | { status: "ok"; collection: Collection };

// Collection#tag_name= (Tag.find_or_create_by_names): the display name with the characters a hashtag cannot hold
// dropped, refused with the Tag's errors (its name normalized present and a hashtag, its display name a hashtag), or,
// past Kopje's tag-name bound, the name too long (as the featured hashtags answer it).
function tagProblems(tagName: string): { display: string; problems: Problem[] } {
  const display = tagDisplayName(storedText(tagName));
  const name = normalizeTag(display);
  const problems: Problem[] = [];
  if (name === "") {
    problems.push({ attribute: "name", type: "blank", description: "can't be blank" });
  }
  if (!isHashtagName(name)) {
    problems.push({ attribute: "name", type: "invalid", description: "is invalid" });
  }
  if (!isHashtagName(display)) {
    problems.push({ attribute: "display_name", type: "invalid", description: "is invalid" });
  }
  if (problems.length === 0 && (!withinTagNameBound(display) || !withinTagNameBound(name))) {
    problems.push({ attribute: "name", type: "too_long", description: TAG_NAME_TOO_LONG.replace(/^Name /, "") });
  }
  return { display, problems };
}

// A remote collection's topic as tag_name= takes it (ProcessFeaturedCollectionService's `topic.name`): its display
// name, or null when the Tag would refuse it, which refuses the collection (its update! raises).
export function remoteCollectionTag(name: string): string | null {
  const { display, problems } = tagProblems(name);
  return problems.length === 0 ? display : null;
}

// Collection's validations of a local collection, in Mastodon's order (collection.rb:42-61), with Rails' messages.
// Lengths are in characters (code points).
function valueProblems(values: CollectionValues): Problem[] {
  const problems: Problem[] = [];
  if (values.name === null || blank(values.name)) {
    problems.push({ attribute: "name", type: "blank", description: "can't be blank" });
  }
  if (values.name !== null && [...values.name].length > COLLECTION_NAME_LENGTH.local) {
    problems.push({
      attribute: "name",
      type: "too_long",
      description: `is too long (maximum is ${COLLECTION_NAME_LENGTH.local} characters)`,
    });
  }
  if (values.description !== null && [...values.description].length > COLLECTION_DESCRIPTION_LENGTH.local) {
    problems.push({
      attribute: "description",
      type: "too_long",
      description: `is too long (maximum is ${COLLECTION_DESCRIPTION_LENGTH.local} characters)`,
    });
  }
  for (const attribute of ["sensitive", "discoverable"] as const) {
    if (values[attribute] === null) {
      problems.push({ attribute, type: "inclusion", description: "is not included in the list" });
    }
  }
  if (values.language !== null && !TREND_LANGUAGES.has(values.language)) {
    problems.push({ attribute: "language", type: "invalid", description: "is invalid" });
  }
  return problems;
}

// The values the fields give, over `base` (a stored collection's, or none on create), and the tag's problems.
function valuesOf(fields: CollectionFields, base: CollectionValues): { values: CollectionValues; tag: Problem[] } {
  const text = (value: string | null | undefined, kept: string | null) =>
    value === undefined ? kept : value === null ? null : storedText(value);
  let tag = base.tag;
  let problems: Problem[] = [];
  if (fields.tagName !== undefined) {
    if (fields.tagName === null) {
      tag = null;
    } else {
      const given = tagProblems(fields.tagName);
      tag = given.display;
      problems = given.problems;
    }
  }
  return {
    values: {
      name: text(fields.name, base.name),
      description: text(fields.description, base.description),
      language: text(fields.language, base.language),
      sensitive: fields.sensitive === undefined ? base.sensitive : fields.sensitive,
      discoverable: fields.discoverable === undefined ? base.discoverable : fields.discoverable,
      tag,
    },
    tag: problems,
  };
}

const NONE: CollectionValues = {
  name: null,
  description: null,
  language: null,
  sensitive: null,
  discoverable: null,
  tag: null,
};

// The collection `id` as its owner sees it, after a write.
function ownView(db: Db, id: string, owner: string, origin: string): Collection {
  const row = foundCollection(db, id);
  if (row === undefined) {
    throw new Error("the collection was not written");
  }
  return presentCollections(db, [row], owner, origin)[0]!;
}

// POST /api/v1/collections (CreateCollectionService), in its order: account_ids[] (duplicates dropped; an unknown or
// unavailable account is not found), tag_name (the Tag's errors), consent per account in the order given (403), then
// the collection's validations with the counts (422). Past COLLECTION_MAX_ITEMS distinct ids the request is refused
// before any is read (docs/mastodon-deviations.md, "Collections"). Every item of a local account is accepted, at
// position 1 (CollectionItem#set_position reads no collection yet). The collection's Add is recorded with them
// (collection-documents.ts recordCollectionAdd).
export const createCollection = userWriteOperation<
  CollectionFields & { accountIds: readonly string[]; now: number; present: PresentInput },
  CollectionResult
>((db, input, { accountId: owner }) => {
  const requested = [...new Set(input.accountIds)];
  if (requested.length > COLLECTION_MAX_ITEMS) {
    return { status: "invalid", problems: [ITEMS_TOO_MANY] };
  }
  const members: string[] = [];
  for (const raw of requested) {
    const member = availableAccount(db, raw);
    if (member === null) {
      return { status: "not_found" };
    }
    if (!members.includes(member)) {
      members.push(member);
    }
  }
  const { values, tag } = valuesOf(input, NONE);
  if (tag.length > 0) {
    return { status: "invalid", problems: tag };
  }
  if (members.some((member) => !mayFeature(db, owner, member))) {
    return { status: "forbidden" };
  }
  const problems = valueProblems(values);
  const owned =
    db.first<{ n: number }>(
      `SELECT count(*) AS n FROM (SELECT 1 FROM collections INDEXED BY collections_account WHERE account_id = ?
				LIMIT ?)`,
      owner,
      COLLECTION_LIMIT,
    )?.n ?? 0;
  if (owned >= COLLECTION_LIMIT) {
    problems.push({ attribute: "base", type: "too_many", description: COLLECTION_LIMIT_MESSAGE });
  }
  if (problems.length > 0) {
    return { status: "invalid", problems };
  }
  const at = new Date(input.now).toISOString();
  const id = insertWithFreshId(
    "collections",
    () => allocateLocalId(db, input.now),
    (fresh) => {
      db.run(
        `INSERT INTO collections (id, account_id, local, name, description, language, sensitive, discoverable, tag,
					created_at, updated_at)
				VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
        fresh,
        owner,
        values.name,
        values.description,
        values.language,
        values.sensitive === true ? 1 : 0,
        values.discoverable === true ? 1 : 0,
        values.tag,
        at,
        at,
      );
      return fresh;
    },
  );
  for (const member of members) {
    notifyAdded(db, owner, member, insertItem(db, id, member, 1, input.now), input.now);
  }
  recordCollectionAdd(db, id, input.now);
  return { status: "ok", collection: ownView(db, id, owner, input.present.origin) };
});

// CreateCollectionService and AddAccountToCollectionService notify a local member of its new item
// (LocalNotificationWorker, added_to_collection); notify writes it for a local recipient other than the owner (R15).
function notifyAdded(db: Db, owner: string, member: string, item: string, now: number): void {
  notify(db, {
    recipientId: member,
    type: "added_to_collection",
    fromId: owner,
    statusId: null,
    collectionItemId: item,
    now,
  });
}

function insertItem(db: Db, collection: string, member: string, position: number, now: number): string {
  const at = new Date(now).toISOString();
  return insertWithFreshId(
    "collection_items",
    () => allocateLocalId(db, now),
    (fresh) => {
      db.run(
        `INSERT INTO collection_items (id, collection_id, account_id, state, position, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?)`,
        fresh,
        collection,
        member,
        COLLECTION_ITEM_STATES.accepted,
        position,
        at,
        at,
      );
      return fresh;
    },
  );
}

// The collection `id` the viewer owns: not found unless R45 finds it, forbidden unless it is the viewer's
// (CollectionPolicy#update?, #destroy?).
function ownCollection(db: Db, id: string, viewer: string): CollectionRow | "not_found" | "forbidden" {
  const row = foundCollection(db, id);
  return row === undefined ? "not_found" : row.account_id === viewer ? row : "forbidden";
}

// PATCH and PUT /api/v1/collections/:id (UpdateCollectionService): what is sent changes, the rest stays; tag_name's
// errors before the collection's validations; updated_at moves only when a value changes, and only then is the
// collection's Update recorded: every value is one its FeaturedCollection carries (UPDATEABLE_PARAMS).
export const updateCollection = userWriteOperation<
  CollectionFields & { id: string; now: number; present: PresentInput },
  CollectionResult
>((db, input, { accountId: viewer }) => {
  const row = ownCollection(db, input.id, viewer);
  if (typeof row === "string") {
    return { status: row };
  }
  const base: CollectionValues = {
    name: row.name,
    description: row.description,
    language: row.language,
    sensitive: row.sensitive === 1,
    discoverable: row.discoverable === 1,
    tag: row.tag,
  };
  const { values, tag } = valuesOf(input, base);
  if (tag.length > 0) {
    return { status: "invalid", problems: tag };
  }
  const problems = valueProblems(values);
  if (problems.length > 0) {
    return { status: "invalid", problems };
  }
  const differs = (key: keyof CollectionValues) => values[key] !== base[key];
  const changed = (Object.keys(base) as (keyof CollectionValues)[]).some(differs);
  if (changed) {
    db.run(
      `UPDATE collections INDEXED BY ${COLLECTIONS_ID_INDEX}
				SET name = ?, description = ?, language = ?, sensitive = ?, discoverable = ?, tag = ?, updated_at = ?
			WHERE id = ?`,
      values.name,
      values.description,
      values.language,
      values.sensitive === true ? 1 : 0,
      values.discoverable === true ? 1 : 0,
      values.tag,
      new Date(input.now).toISOString(),
      row.id,
    );
    recordCollectionUpdate(db, row.id, input.now);
  }
  if (NOTIFIED_CHANGES.some(differs)) {
    notifyUpdated(db, row.id, viewer, input.now);
  }
  return { status: "ok", collection: ownView(db, row.id, viewer, input.present.origin) };
});

// The changes a collection's members are notified of (NotifyOfCollectionUpdateService#significantly_changed?:
// description, description_html, name, sensitive, tag_id): not its language or discoverability.
const NOTIFIED_CHANGES: readonly (keyof CollectionValues)[] = ["name", "description", "sensitive", "tag"];

// NotifyOfCollectionUpdateService: each accepted member of the collection `id` is notified collection_update, which
// replaces its earlier one of the collection (notify); a local one only. At most COLLECTION_MAX_ITEMS live items, read
// through collection_items_order. A remote collection's change notifies the same way
// (remote-featured-collections.ts).
export function notifyUpdated(db: Db, id: string, owner: string, now: number): void {
  const members = db.all<{ account_id: string }>(
    `SELECT account_id FROM collection_items INDEXED BY collection_items_order
		WHERE collection_id = ? AND state = ? AND account_id IS NOT NULL ORDER BY position, id`,
    id,
    COLLECTION_ITEM_STATES.accepted,
  );
  for (const { account_id } of members) {
    notify(db, {
      recipientId: account_id,
      type: "collection_update",
      fromId: owner,
      statusId: null,
      collectionId: id,
      now,
    });
  }
}

// DELETE /api/v1/collections/:id (DeleteCollectionService): the collection and, by the foreign keys, its items, their
// notifications, its collection_update notifications and their pushes (at most MAX_PUSH_BACKLOG in all), after
// recording its Remove, which reads its members.
export const deleteCollection = userWriteOperation<{ id: string; now: number }, "ok" | "not_found" | "forbidden">(
  (db, input, { accountId: viewer }) => {
    const row = ownCollection(db, input.id, viewer);
    if (typeof row === "string") {
      return row;
    }
    recordCollectionRemove(db, row.id, input.now);
    db.run(`DELETE FROM collections INDEXED BY ${COLLECTIONS_ID_INDEX} WHERE id = ?`, row.id);
    return "ok";
  },
);

export type ItemResult =
  | { status: "not_found" }
  | { status: "account_missing" }
  | { status: "forbidden" }
  | { status: "invalid"; problems: Problem[] }
  | { status: "ok"; item: CollectionItem };

// POST /api/v1/collections/:collection_id/items (AddAccountToCollectionService), in the controller's order: the
// collection (404), a blank account_id (422), the account (404, unavailable included), the owner (403), consent (403),
// then the item's uniqueness in any state and the live bound (422). At MAX_STORED_ITEMS stored rows the oldest retired
// row of the collection is deleted first, with its notification and that notification's pushes (by the foreign keys).
// The new item is accepted, after every other (CollectionItem#set_position), and its Add recorded.
export const addCollectionItem = userWriteOperation<{ collection: string; account: string; now: number }, ItemResult>(
  (db, input, { accountId: viewer }) => {
    const row = foundCollection(db, input.collection);
    if (row === undefined) {
      return { status: "not_found" };
    }
    if (blank(input.account)) {
      return { status: "account_missing" };
    }
    const member = availableAccount(db, input.account);
    if (member === null) {
      return { status: "not_found" };
    }
    if (row.account_id !== viewer || !mayFeature(db, viewer, member)) {
      return { status: "forbidden" };
    }
    const counts = db.first<{ taken: number; live: number; stored: number; last: number | null }>(
      `SELECT count(*) FILTER (WHERE account_id = ?2) AS taken, count(*) FILTER (WHERE state IN (0, 1)) AS live,
			count(*) AS stored, max(position) AS last
		FROM collection_items INDEXED BY collection_items_order WHERE collection_id = ?1`,
      row.id,
      member,
    );
    if ((counts?.taken ?? 0) > 0) {
      return { status: "invalid", problems: [ACCOUNT_TAKEN] };
    }
    if ((counts?.live ?? 0) >= COLLECTION_MAX_ITEMS) {
      return { status: "invalid", problems: [ITEMS_TOO_MANY] };
    }
    if ((counts?.stored ?? 0) >= MAX_STORED_ITEMS) {
      db.run(
        `DELETE FROM collection_items INDEXED BY ${COLLECTION_ITEMS_ID_INDEX} WHERE id =
				(SELECT id FROM collection_items INDEXED BY collection_items_order
					WHERE collection_id = ? AND state IN (2, 3) ORDER BY updated_at, id LIMIT 1)`,
        row.id,
      );
    }
    const position = Math.min((counts?.last ?? 0) + 1, COLLECTION_POSITION_MAX);
    const id = insertItem(db, row.id, member, position, input.now);
    notifyAdded(db, viewer, member, id, input.now);
    recordItemAdd(db, { id, collection: row.id }, input.now);
    const item = { collection_id: row.id, id, state: COLLECTION_ITEM_STATES.accepted, account_id: member };
    return { status: "ok", item: presentItem({ ...item, created_at: new Date(input.now).toISOString() }) };
  },
);

// The item `item` of the found collection `collection` (CollectionItemsController#set_collection_item), any state.
function collectionItem(
  db: Db,
  collection: string,
  item: string,
): { row: CollectionRow; item: { id: string; account_id: string | null; state: number } } | null {
  const row = foundCollection(db, collection);
  if (row === undefined) {
    return null;
  }
  const found = db.first<{ id: string; account_id: string | null; state: number }>(
    `SELECT id, account_id, state FROM collection_items INDEXED BY ${COLLECTION_ITEMS_ID_INDEX}
		WHERE id = ? AND collection_id = ?`,
    item,
    row.id,
  );
  return found === undefined ? null : { row, item: found };
}

// DELETE /api/v1/collections/:collection_id/items/:id (DeleteCollectionItemService): the owner deletes any item, and
// by the foreign keys its notification and that notification's pushes, after recording its Remove.
export const removeCollectionItem = userWriteOperation<
  { collection: string; item: string; now: number },
  "ok" | "not_found" | "forbidden"
>((db, input, { accountId: viewer }) => {
  const found = collectionItem(db, input.collection, input.item);
  if (found === null) {
    return "not_found";
  }
  if (found.row.account_id !== viewer) {
    return "forbidden";
  }
  recordItemRemove(db, { id: found.item.id, collection: found.row.id, account: found.item.account_id }, input.now);
  db.run(`DELETE FROM collection_items INDEXED BY ${COLLECTION_ITEMS_ID_INDEX} WHERE id = ?`, found.item.id);
  return "ok";
});

// POST /api/v1/collections/:collection_id/items/:id/revoke (RevokeCollectionItemService): the item's own account
// revokes it, in any state (CollectionItemPolicy#revoke?); the row stays, revoked, for RETIRED_ITEM_TTL_MS. In a local
// collection its owner's Remove of the item is recorded, once.
export const revokeCollectionItem = userWriteOperation<
  { collection: string; item: string; now: number },
  "ok" | "not_found" | "forbidden"
>((db, input, { accountId: viewer }) => {
  const found = collectionItem(db, input.collection, input.item);
  if (found === null) {
    return "not_found";
  }
  if (found.item.account_id !== viewer) {
    return "forbidden";
  }
  const revoked = db.run(
    `UPDATE collection_items INDEXED BY ${COLLECTION_ITEMS_ID_INDEX}
			SET state = ?, retracted_approval_uri = NULL, updated_at = ?
		WHERE id = ? AND state <> ?`,
    COLLECTION_ITEM_STATES.revoked,
    new Date(input.now).toISOString(),
    found.item.id,
    COLLECTION_ITEM_STATES.revoked,
  );
  if (revoked > 0) {
    recordItemRemove(db, { id: found.item.id, collection: found.row.id, account: viewer }, input.now);
  }
  return "ok";
});

// BlockService#handle_collections, in the block's transaction: the blocker's items in the target's collections are
// revoked, and the target's items in the blocker's collections deleted, with their notifications and those
// notifications' pushes (by the foreign keys), each item's Remove as its revoke or removal sends it (a local
// collection's only), recorded with its members' targets and its owner's followers left to a collection job
// (collection-jobs.ts), as Mastodon's CollectionRawDistributionWorker reaches them after the block. Each reads one
// account's collections (at most MAX_STORED_COLLECTIONS) and one item of each by its member key, so at most that many
// rows and Removes each, and each Remove reads its collection's items (at most MAX_STORED_ITEMS) and no follower.
// Returns whether it left a job.
export function severCollections(db: Db, blocker: string, target: string, now: number): boolean {
  const revoked = db.all<{ id: string; collection_id: string }>(
    `UPDATE collection_items INDEXED BY collection_items_member
			SET state = ?3, retracted_approval_uri = NULL, updated_at = ?4
		WHERE collection_id IN (SELECT id FROM collections INDEXED BY collections_account WHERE account_id = ?2)
			AND account_id = ?1 AND state <> ?3
		RETURNING id, collection_id`,
    blocker,
    target,
    COLLECTION_ITEM_STATES.revoked,
    new Date(now).toISOString(),
  );
  const removes: { owner: string; intent: string }[] = [];
  const stage = (item: { id: string; collection_id: string }, account: string) => {
    const staged = stageItemRemove(db, { id: item.id, collection: item.collection_id, account }, now);
    if (staged !== null) {
      removes.push(staged);
    }
  };
  for (const item of revoked) {
    stage(item, blocker);
  }
  const deleted = db.all<{ id: string; collection_id: string }>(
    `DELETE FROM collection_items INDEXED BY collection_items_member
		WHERE collection_id IN (SELECT id FROM collections INDEXED BY collections_account WHERE account_id = ?1)
			AND account_id = ?2
		RETURNING id, collection_id`,
    blocker,
    target,
  );
  for (const item of deleted) {
    stage(item, target);
  }
  return beginCollectionJobs(db, removes);
}

// The retired items unchanged since ?1, oldest first, at most ?2 (the rows a round has left): one bounded range of
// collection_items_retired.
const RETIRED_WINDOW = `SELECT id FROM collection_items INDEXED BY collection_items_retired
	WHERE state IN (2, 3) AND updated_at < ?1 ORDER BY updated_at, id LIMIT ?2`;

// The cron's cleanup (CollectionItemCleanupScheduler): rejected and revoked items unchanged for RETIRED_ITEM_TTL_MS,
// oldest first, child-first so that no delete cascades (as inbox.ts purgeReports): within the window of the oldest
// (RETIRED_WINDOW), the pushes of their notifications (pending or leased: a leased push whose row is gone completes as
// nothing), then the notifications left without one, then the items left without a notification. Each statement reads
// only the window and takes what the round has left, so a round writes at most RETIRED_ROWS_PER_ROUND rows, and the
// next one continues from the oldest left. `deleted`: the rows written.
export const pruneCollectionItems = writeOperation<{ now: number }, { deleted: number }>((db, { now }) => {
  const budget = new RowBudget(db, RETIRED_ROWS_PER_ROUND);
  const cutoff = new Date(now - RETIRED_ITEM_TTL_MS).toISOString();
  const writes = [
    {
      ids: `SELECT CAST(d.id AS TEXT) AS id FROM (${RETIRED_WINDOW}) w
				CROSS JOIN notifications n INDEXED BY notifications_collection_item ON n.collection_item_id = w.id
				CROSS JOIN push_deliveries d INDEXED BY push_deliveries_notification ON d.notification_id = n.id LIMIT ?2`,
      each: "DELETE FROM push_deliveries WHERE id = CAST(?1 AS INTEGER)",
    },
    {
      ids: `SELECT CAST(n.id AS TEXT) AS id FROM (${RETIRED_WINDOW}) w
				CROSS JOIN notifications n INDEXED BY notifications_collection_item ON n.collection_item_id = w.id
			WHERE NOT EXISTS (SELECT 1 FROM push_deliveries d INDEXED BY push_deliveries_notification
				WHERE d.notification_id = n.id) LIMIT ?2`,
      each: "DELETE FROM notifications WHERE id = CAST(?1 AS INTEGER)",
    },
    {
      ids: `SELECT w.id FROM (${RETIRED_WINDOW}) w
			WHERE NOT EXISTS (SELECT 1 FROM notifications n INDEXED BY notifications_collection_item
				WHERE n.collection_item_id = w.id) LIMIT ?2`,
      each: `DELETE FROM collection_items INDEXED BY ${COLLECTION_ITEMS_ID_INDEX} WHERE id = ?1`,
    },
  ];
  for (const write of writes) {
    if (budget.left() > 0) {
      writeEach(db, write, cutoff, budget.left());
    }
  }
  return { deleted: budget.spent() };
});

// ---- Collections named by reports and search.

// The local collection a URL names by its route (ActivityPub::TagManager#uri_to_local_collection,
// ResolveURLService#process_local_url): its stored id when the URL is a local collection's uri
// (`/ap/users/:username/collections/:id`) or url (`/collections/:id`) on `origin`, whatever the username; null for
// any other.
export function localCollectionId(url: string, origin: string): string | null {
  if (!url.startsWith(`${origin}/`)) {
    return null;
  }
  const id = /^(?:ap\/users\/[^/?#]+\/)?collections\/(\d{1,18})$/.exec(url.slice(origin.length + 1))?.[1];
  return id === undefined ? null : storedIdOf(id);
}

// The collection `id` when R45 shows it to `viewer` (CollectionPolicy#show?), as the viewer sees it; null otherwise.
export function shownCollection(db: Db, id: string, viewer: string | null, origin: string): Collection | null {
  const row = foundCollection(db, id);
  return row === undefined || !shown(db, row.id, viewer)
    ? null
    : (presentCollections(db, [row], viewer, origin)[0] ?? null);
}

// Search with resolve=true of a local collection's URL (ResolveURLService#check_collection): shownCollection.
export const resolvedCollection = userReadOperation<{ id: string; present: PresentInput }, Collection | null>(
  (db, input, { accountId: viewer }) => shownCollection(db, input.id, viewer, input.present.origin),
);

// ReportService#reported_collection_ids (`@target_account.collections.find(ids)`): the target's collections the
// `raw` ids name, in any visibility, each read as Ruby's to_i reads it, in the order given; null unless each names one
// of them, and a different one (ActiveRecord's find counts the records found against the distinct ids sent). At most
// `raw.length` rows read, each by key.
export function reportedCollectionIds(db: Db, target: string, raw: readonly string[]): string[] | null {
  const found = db.all<{ id: string }>(
    `SELECT c.id FROM json_each(?1) w CROSS JOIN collections c INDEXED BY ${COLLECTIONS_ID_INDEX} ON c.id = w.value
		WHERE c.account_id = ?2 ORDER BY w.key`,
    JSON.stringify(raw.map((id) => storedIdOf(requestedId(id)))),
    target,
  );
  const ids = [...new Set(found.map((row) => row.id))];
  return ids.length === raw.length ? ids : null;
}

// The ActivityPub ids of the collections `ids`, in that order (ActivityPub::FlagSerializer#collection_uris), each read
// by key.
export function collectionUris(db: Db, ids: readonly string[], origin: string): string[] {
  return db
    .all<Pick<CollectionRow, "id" | "local" | "username" | "uri">>(
      `SELECT c.id, c.local, ${usernameSql("a.username")} AS username, c.uri FROM json_each(?1) w
				CROSS JOIN collections c INDEXED BY ${COLLECTIONS_ID_INDEX} ON c.id = w.value
				CROSS JOIN accounts a INDEXED BY ${ACCOUNTS_ID_INDEX} ON a.id = c.account_id
			ORDER BY w.key`,
      JSON.stringify(ids),
    )
    .map((row) => collectionUri(row, origin));
}

// The collections an inbound Flag names among its objects (ActivityPub::Activity::Flag#perform's collection_from_uri,
// TagManager#uri_to_resource), with their owners, in the objects' order: a local one by route on `origin`, a remote
// one by its stored uri, the object's fragment removed. Each read by key.
export function flaggedCollections(
  db: Db,
  objects: readonly string[],
  origin: string,
): { id: string; account_id: string }[] {
  const named = objects.map((uri) => {
    const local = localCollectionId(uri, origin);
    return local === null ? { uri: uri.split("#")[0]! } : { id: local };
  });
  const rows = db.all<{ key: number; id: string; account_id: string }>(
    `SELECT w.key, c.id, c.account_id FROM json_each(?1) w
			CROSS JOIN collections c INDEXED BY ${COLLECTIONS_ID_INDEX} ON c.id = w.value ->> '$.id'
		UNION ALL
		SELECT w.key, c.id, c.account_id FROM json_each(?1) w
			CROSS JOIN collections c INDEXED BY collections_uri ON c.uri = w.value ->> '$.uri'
		WHERE c.local = 0
		ORDER BY 1`,
    JSON.stringify(named),
  );
  const owners = new Map<string, string>();
  for (const row of rows) {
    if (!owners.has(row.id)) {
      owners.set(row.id, row.account_id);
    }
  }
  return [...owners].map(([id, account_id]) => ({ id, account_id }));
}

// ---- The public page of a local collection (web-pages/collection.ts).

// The path of the local collection `id`'s FeaturedCollection (collection-documents.ts), by key; null for any other.
export function localCollectionPath(db: Db, id: string): string | null {
  const row = db.first<{ username: string }>(
    `SELECT a.username FROM collections c INDEXED BY ${COLLECTIONS_ID_INDEX}
			CROSS JOIN accounts a INDEXED BY ${ACCOUNTS_ID_INDEX} ON a.id = c.account_id
		WHERE c.id = ? AND c.local = 1`,
    id,
  );
  return row === undefined ? null : `/ap/users/${encodeURIComponent(row.username)}/collections/${id}`;
}

type PageOwner = { id: string; account: Account } | { status: "not_found" } | { status: "suspended" };

// A local collection's page (Mastodon's CollectionsController#show, as HTML), as an anonymous viewer reads it (VIS-4):
// the local collection `id` (as the route names it), its owner answered for first by `owner` (the page's account read,
// by key: a suspended owner's page is gone, as its profile), then R45 with no viewer, discoverable or not
// (discoverable governs listings only). Not found for an unknown id or a remote collection's: its url is its own
// server's. Each row read by key, the items as shownItems reads them.
export function localCollectionOf(
  db: Db,
  id: string,
  origin: string,
  owner: (accountId: string) => PageOwner,
): { collection: Collection; owner: Account } | { status: "not_found" } | { status: "suspended" } {
  const row = db.first<CollectionRow>(
    `SELECT ${COLLECTION_COLUMNS} FROM collections c INDEXED BY ${COLLECTIONS_ID_INDEX}
			CROSS JOIN accounts a INDEXED BY ${ACCOUNTS_ID_INDEX} ON a.id = c.account_id
		WHERE c.id = ? AND c.local = 1`,
    id,
  );
  if (row === undefined) {
    return { status: "not_found" };
  }
  const found = owner(row.account_id);
  if ("status" in found) {
    return found;
  }
  const [collection] = shown(db, row.id, null) ? presentCollections(db, [row], null, origin) : [];
  return collection === undefined ? { status: "not_found" } : { collection, owner: found.account };
}
