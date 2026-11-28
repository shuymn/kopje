import { ACCOUNTS_ID_INDEX, STATUSES_ID_INDEX } from "../db/indexes";
import type { Db } from "../db/sql";
import {
  type Account,
  presentAccountsWithin,
  presentFor,
  resolveAccountId,
  searchAccountIds,
  type SearchInput,
} from "./accounts";
import { admit, ANSWER_BYTES, jsonBytes, STATUS_ANSWER_BYTES } from "./answer-budget";
import { listableSql, statusReads } from "./audience";
import { type UserContext, userReadOperation } from "./auth";
import type { Collection } from "./collection-presenter";
import { ownVotedPollsSql, ownVotedSql } from "./polls";
import { statusQueryTerms } from "./search-text";
import { tagNameSql } from "./status-bounds";
import { presentation, presentStatusesWithin, type Status } from "./status-presenter";
import { searchedTagKey } from "./tag-bounds";
import { normalizeTag } from "./tag-name";
import { LISTED_HISTORY_ROWS, presentTags, type Tag } from "./tags";
import { tagReviewedSql } from "./trends";
import { statusCursor } from "./windows";

// GET /api/v2/search: local data only, matched with instr on search_text (NFKC); no virtual
// table. Accounts: domain/accounts.ts. Statuses: the viewer's library (the sources of LIBRARY: own statuses, boosted
// originals, favourites, bookmarks, mentions), or one account's statuses with account_id. Hashtags: by prefix, from
// statuses the viewer may see. Every status passes listableSql (VIS-1 and the viewer's filters) in the query, before
// LIMIT (RES-7).
//
// A search with account_id of another account keeps what Mastodon's search would find (its public index of indexable
// accounts, and searchable_by): the account's public statuses when its stored indexable is 1, and the statuses the
// viewer boosted (kept), favourited, bookmarked, is actively mentioned in or voted in (the poll's current generation).
// Candidates are the account's newest LIBRARY_SOURCE_LIMIT originals, the windows of the viewer's INTERACTIONS,
// and the polls of the viewer's newest LIBRARY_SOURCE_LIMIT vote rows (polls.ts ownVotedPollsSql), each within the
// cursors; each candidate is then judged by the author term, listableSql and that condition, the interactions probed
// by key (libraryProbes). Candidacy is not eligibility: a status found through one window (an old vote, a silent
// mention) is returned only when a probe or its being public and indexable makes it eligible. Two limits remain: a
// status outside every window of a request is not found (a client paging by the ids it receives can stop before one),
// and an eligible candidate past MAX_SEARCH_OFFSET (mastodon/search.ts) is beyond the pages a client may request. A
// search of the viewer's own account reads the author window alone, with no condition.
//
// Work is bounded (RES-3, RES-7). Each source reads at most LIBRARY_SOURCE_LIMIT rows through an index whose order is
// the returned status id (the vote window: the vote's), with max_id and min_id applied inside the source (the vote
// window: outside its LIMIT), so a query matches at most 5 x LIBRARY_SOURCE_LIMIT candidates (6 x with account_id),
// and a client paging the library search with max_id reaches every older entry of every library source.
//
// Hashtag search is recent autocomplete, not a catalogue of every tag. Tags are taken only from statuses the viewer may
// see, inside two windows: the newest HASHTAG_LIBRARY_LIMIT entries of each library source the viewer writes (own
// statuses, boosts, favourites, bookmarks), and the newest HASHTAG_PUBLIC_WINDOW public statuses the instance knows (a
// partial index holds public originals only). Candidates pass listableSql before tags are taken from them, so a tag
// used only in posts the viewer may not see is never shown. Mentions are not a window source: others write them, and
// a hidden mention (from an author who blocks the viewer) could push a visible entry out. Limitations: a tag used only
// outside the windows is not found, even by its exact name; a status the viewer saved that later became hidden (its
// author blocked them) still takes a slot of the viewer's own windows, which reveals that something changed, not what.
//
// The whole answer, accounts, statuses and hashtags, is one answer within ANSWER_BYTES (RES-3), within
// STATUS_ANSWER_BYTES from its first admission when it may present statuses, admitted in that order
// with the account resolve=true found first among the accounts. Search pages by offset, so an answer cut there holds
// fewer results: a client advancing its offset by the number received continues after them, while Mastodon's web
// client, which takes a short answer for the last one, shows no more (docs/response-inventory.md).

export const LIBRARY_SOURCE_LIMIT = 2500;
export const HASHTAG_LIBRARY_LIMIT = 500;
export const HASHTAG_PUBLIC_WINDOW = 2000;

// A Tag entity (tags.ts), with a list's history (LISTED_HISTORY_ROWS) and the viewer's following and featuring.
export type Hashtag = Tag;

export type SearchType = "accounts" | "statuses" | "hashtags";

export type SearchRequest = SearchInput & {
  types: readonly SearchType[];
  // exclude_unreviewed (Tag.search_for): only hashtags the admin reviewed (trends.ts tagReviewedSql), and the exact
  // match.
  excludeUnreviewed?: boolean;
  accountId?: string | undefined;
  maxId?: string | undefined;
  minId?: string | undefined;
};

// REST::SearchSerializer. `collections` holds only what resolve=true found (mastodon/search.ts): this search never
// lists one.
export type SearchResults = { accounts: Account[]; statuses: Status[]; hashtags: Hashtag[]; collections: Collection[] };

// The JSON of an empty answer: each list's items are counted with a separator, one more than they take.
const SEARCH_FRAME_BYTES = jsonBytes({
  accounts: [],
  statuses: [],
  hashtags: [],
  collections: [],
} satisfies SearchResults);

export const search = userReadOperation<SearchRequest, SearchResults>((db, input, viewer, context) => {
  let left = (input.types.includes("statuses") ? STATUS_ANSWER_BYTES : ANSWER_BYTES) - SEARCH_FRAME_BYTES;
  let leading = true;
  const accounts = input.types.includes("accounts")
    ? presentAccountsWithin(
        db,
        searchAccountIds(db, input, context.accountId),
        presentFor(input.present, context.accountId),
        left,
        leading,
      )
    : { items: [], bytes: 0 };
  left -= accounts.bytes;
  leading &&= accounts.items.length === 0;
  const statusIds = input.types.includes("statuses") ? searchStatuses(db, input, context) : [];
  const options = { ...input.present, viewer: context };
  const statuses = presentStatusesWithin(db, presentation(db, statusIds, options), statusIds, left, leading);
  left -= statuses.bytes;
  leading &&= statuses.items.length === 0;
  const hashtags = input.types.includes("hashtags") ? searchHashtags(db, input, context, viewer.now) : [];
  return {
    accounts: accounts.items,
    statuses: statuses.items,
    hashtags: admit(hashtags, left, leading).items,
    collections: [],
  };
});

// Numbered parameters, so fragments that use ?1 (the viewer) can be combined with any number of terms.
class Params {
  readonly values: SqlStorageValue[];
  constructor(first: SqlStorageValue) {
    this.values = [first];
  }
  add(value: SqlStorageValue): string {
    this.values.push(value);
    return `?${this.values.length}`;
  }
}

// The viewer's library, one entry per source: the table, the column naming the status, the source's condition, the
// index ordered by (account_id, status) its window walks, and the key its probe seeks a status by (none: the primary
// key, which the two key equalities select; status_mentions is WITHOUT ROWID, so it takes no INDEXED BY). The
// originals are read as a window only. scopedWhere: what a search with account_id also asks of the probe (Mastodon's
// searchable_by counts active mentions only, status.rb:104); its window still reads every mention.
type Source = {
  table: string;
  status: string;
  where?: string;
  window: string;
  probe?: string;
  scopedWhere?: string;
};
const ORIGINALS: Source = {
  table: "statuses",
  status: "id",
  where: "reblog_of_id IS NULL",
  window: "statuses_account_originals",
};
// The sources the viewer saves: kept boosts, favourites, bookmarks.
const SAVED: readonly Source[] = [
  {
    table: "statuses",
    status: "reblog_of_id",
    where: "reblog_of_id IS NOT NULL AND withdrawn = 0",
    window: "statuses_account_reblogs_kept",
    probe: "statuses_account_reblogs_kept",
  },
  { table: "favourites", status: "status_id", window: "favourites_account_status", probe: "favourites_pair" },
  { table: "bookmarks", status: "status_id", window: "bookmarks_account_status", probe: "bookmarks_pair" },
];
// Others write mentions, so they are a source of status search only, never of the hashtag window (see above).
const MENTIONS: Source = {
  table: "status_mentions",
  status: "status_id",
  window: "status_mentions_account",
  scopedWhere: "silent = 0",
};
// The viewer's interactions, probed in a search with account_id; with the originals, the library.
const INTERACTIONS: readonly Source[] = [...SAVED, MENTIONS];
const LIBRARY: readonly Source[] = [ORIGINALS, ...INTERACTIONS];

// One source's window: `account`'s newest `limit` entries in the order of the status id they name, `cursor` (max_id
// and min_id on that id) inside the LIMIT.
function sourceWindow(source: Source, account: string, limit: string, cursor: (column: string) => string): string {
  const { table, status, where, window } = source;
  return `SELECT id FROM (SELECT ${status === "id" ? "id" : `${status} AS id`} FROM ${table} INDEXED BY ${window}
				WHERE account_id = ${account}${where === undefined ? "" : ` AND ${where}`} ${cursor(status)}
				ORDER BY ${status} DESC LIMIT ${limit})`;
}

// The viewer's windows of `sources` as one candidate list of status ids (the boosted originals through the kept boosts
// only, so withdrawn ones awaiting their job never fill the source's limit).
function librarySources(sources: readonly Source[], limit: string, cursor: (column: string) => string): string {
  return sources.map((source) => sourceWindow(source, "?1", limit, cursor)).join("\n\t\t\tUNION ");
}

// Whether the viewer (?1) holds the status `s` in one of INTERACTIONS (with its scopedWhere), or voted in its poll's
// current generation: each a key seek.
function libraryProbes(s: string): string[] {
  return [
    ...INTERACTIONS.map(({ table, status, where, probe, scopedWhere }) => {
      const conditions = [`${status} = ${s}.id`, "account_id = ?1", ...(where === undefined ? [] : [where])];
      return `EXISTS (SELECT 1 FROM ${table}${probe === undefined ? "" : ` INDEXED BY ${probe}`} WHERE ${[
        ...conditions,
        ...(scopedWhere === undefined ? [] : [scopedWhere]),
      ].join(" AND ")})`;
    }),
    ownVotedSql(`${s}.id`, "?1"),
  ];
}

function searchStatuses(db: Db, input: SearchRequest, viewer: UserContext) {
  const { accountId: viewerId, now } = viewer;
  const { include, exclude } = statusQueryTerms(input.query);
  if (include.length === 0) {
    return [];
  }
  const p = new Params(viewerId);
  const read = statusReads(viewer, { viewer: "?1", now: p.add(now) });
  const limit = p.add(LIBRARY_SOURCE_LIMIT);
  // Cursors compare as numbers: statusCursor pads a short one and puts an over-long one above every id (ids are
  // 18-digit TEXT).
  const maxCursor = statusCursor(input.maxId);
  const minCursor = statusCursor(input.minId);
  const maxId = maxCursor === null ? null : p.add(maxCursor);
  const minId = minCursor === null ? null : p.add(minCursor);
  const cursor = (column: string) =>
    `${maxId === null ? "" : `AND ${column} < ${maxId}`} ${minId === null ? "" : `AND ${column} > ${minId}`}`;
  let candidates: string;
  let library: string | null = null;
  const scoped: string[] = [];
  if (input.accountId !== undefined) {
    const accountId = resolveAccountId(db, input.accountId);
    if (accountId === null) {
      return [];
    }
    const author = p.add(accountId);
    const authorWindow = sourceWindow(ORIGINALS, author, limit, cursor);
    if (accountId === viewerId) {
      // The viewer's own statuses: every one is theirs to search, and listableSql still decides.
      candidates = authorWindow;
    } else {
      // Another account's statuses the viewer may search (see above). Two CTEs: the Store's SQLite allows five terms
      // per compound SELECT. The condition and the author term are judged outside the candidates.
      const indexable =
        db.first<{ indexable: number }>(
          `SELECT 1 AS indexable FROM accounts INDEXED BY ${ACCOUNTS_ID_INDEX} WHERE id = ? AND indexable = 1`,
          accountId,
        ) !== undefined;
      candidates = `${authorWindow}
			UNION SELECT id FROM library
			UNION SELECT id FROM (${ownVotedPollsSql("?1", limit)}) WHERE 1 ${cursor("id")}`;
      library = librarySources(INTERACTIONS, limit, cursor);
      scoped.push(
        `s.account_id = ${author}`,
        `(${[...(indexable ? ["s.visibility = 'public'"] : []), ...libraryProbes("s")].join("\n\t\t\tOR ")})`,
      );
    }
  } else {
    candidates = librarySources(LIBRARY, limit, cursor);
  }
  const matches = (variants: string[]) =>
    `(${variants.map((variant) => `instr(s.search_text, ${p.add(variant)}) > 0`).join(" OR ")})`;
  const where = [
    "s.reblog_of_id IS NULL",
    "s.search_text IS NOT NULL",
    ...include.map(matches),
    ...exclude.map((variants) => `NOT ${matches(variants)}`),
    ...scoped,
  ];
  return read
    .select(
      db,
      "listable",
      {
        with: `WITH ${library === null ? "" : `library(id) AS (${library}),\n\t\t`}candidates(id) AS (${candidates})`,
        // The candidates outside, each status looked up by id (as searchHashtags' visible statuses below).
        from: "candidates c CROSS JOIN",
        join: `INDEXED BY ${STATUSES_ID_INDEX} ON s.id = c.id`,
        where: where.join(" AND "),
        tail: `ORDER BY s.id DESC LIMIT ${p.add(input.limit)} OFFSET ${p.add(input.offset)}`,
      },
      ...p.values,
    )
    .map((row) => row.id);
}

// The largest code point, as UTF-8 compares: every name with the prefix sorts below prefix + this.
const PREFIX_END = "\u{10FFFF}";

// Tags whose name starts with the query, from the statuses in the two windows that the viewer may see (see above), exact
// match first, then shorter names. With excludeUnreviewed, only reviewed tags and the exact match, filtered before the
// page (Tag.search_for: `matching_name(term).or(reviewed)`).
function searchHashtags(
  db: Db,
  input: SearchRequest,
  { accountId: viewerId, now }: UserContext,
  at: number,
): Hashtag[] {
  // Tag.matches_name: the query normalized as a hashtag name, so spaces and other characters a hashtag cannot hold
  // are dropped from it.
  const prefix = normalizeTag(input.query.replace(/^#/, ""));
  if (prefix === "") {
    return [];
  }
  const rows = db.all<{ key: string }>(
    // The Store's SQLite allows five terms per compound SELECT, so the windows are two CTEs. CROSS JOIN keeps the
    // windows on the outside: statuses are looked up by id per candidate (the index named, so statistics of a small
    // Store cannot turn it into a scan per candidate), and tags per visible status, never scanned by name.
    `WITH library(id) AS (${librarySources([ORIGINALS, ...SAVED], "?4", () => "")}),
		public(id) AS (SELECT id FROM statuses WHERE visibility = 'public' AND reblog_of_id IS NULL ORDER BY id DESC LIMIT ?5),
		candidates(id) AS (SELECT id FROM library UNION SELECT id FROM public),
		visible(id) AS (SELECT s.id FROM candidates c
			CROSS JOIN statuses s INDEXED BY ${STATUSES_ID_INDEX} ON s.id = c.id WHERE ${listableSql("s", "?1", "?8")})
		SELECT DISTINCT hex(${tagNameSql("t.name")}) AS key FROM visible v
			CROSS JOIN status_tags t ON t.status_id = v.id AND t.name >= ?2 AND t.name < ?3
		WHERE ${tagNameSql("t.name")} IS NOT NULL AND (?9 = 0 OR t.name = ?2 OR ${tagReviewedSql("t.name")})
		ORDER BY t.name = ?2 DESC, length(t.name), t.name LIMIT ?6 OFFSET ?7`,
    viewerId,
    prefix,
    `${prefix}${PREFIX_END}`,
    HASHTAG_LIBRARY_LIMIT,
    HASHTAG_PUBLIC_WINDOW,
    input.limit,
    input.offset,
    now,
    input.excludeUnreviewed === true ? 1 : 0,
  );
  return presentTags(
    db,
    rows.map(({ key }) => searchedTagKey(key)),
    viewerId,
    input.present,
    at,
    LISTED_HISTORY_ROWS,
  );
}
