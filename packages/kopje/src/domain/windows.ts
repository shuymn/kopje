import type { Db } from "../db/sql";

// Candidate windows: the bound, the cut and the continuation of every paged read whose rule hides rows, and the cursor
// rule its candidates keep, are docs/visibility.md "Read bounds" (RES-7).

// The candidates of a read for a page of `limit`: three pages, at least 40, and never fewer than a stream's.
export function readWindow(limit: number): number {
  return Math.max(3 * limit, 40);
}

// The candidates of each stream of a merged read (home, a list, a hashtag timeline's names): two pages, at least 40.
export function streamWindow(limit: number): number {
  return Math.max(2 * limit, 40);
}

// The budget of a page's walk under request conditions (walkedWindow): the sum of its rounds' stream LIMITs (each
// round, streams × per-stream LIMIT), counting entries within the audience before the request's conditions, not
// distinct statuses. GROUP_WALK's figure, a separate constant so the two can change apart.
export const CONDITION_WALK = 2_000;

// A window: its candidates in cursor order, each with `o`, the bits of the streams it came from (a merged read's rule
// may differ by stream), and whether it ended before the cursor's range did. `end`: the last candidate a walk examined,
// when it read past the candidates it keeps (walkedWindow).
export type Window = {
  readonly candidates: readonly { id: string; o: number }[];
  readonly cut: boolean;
  readonly end?: string;
};

// The window of streams merged (home's, a list's, a hashtag timeline's). `streams` selects (id, k, o) rows: each
// stream k's candidates from the cursor in cursor order, at most `per` each, and o a bit of the stream's kind (a power
// of two, or 0), which the candidate carries ORed over its streams.
// A stream that gave `per` ended there, so the merged window ends at the highest such end (the lowest when ascending):
// below it a stream may have candidates that were not read. The window is the candidates from the cursor to that end,
// at most `size`. A single stream (one k, per = size) is the plain case. The parameters are the caller's.
// The streams are read in one pass and grouped by stream, with no CTE: SQLite expands a CTE's body once per reference,
// and from 3.54.1 refuses a reference resolved after too many cursors (docs/engineering.md "Queries"), which the
// streams' own policy walks would otherwise pass. Each group carries its stream's end when it filled (`edge`) and its
// ids as JSON; the statement returns the first size + 1 distinct ids in cursor order, each with the edges of its
// streams, and boundedWindow cuts them at the bound. Contracts of the streams: every id is TEXT (compared in cursor
// order the same in SQLite and here), `o` is constant within a stream (a literal of its arm), and a stream's JSON is
// at most 21 × per + 1 bytes (per ≤ CONDITION_WALK: 42,001).
export function mergedWindow(
  db: Db,
  query: { streams: string; ascending: boolean; per: number; size: number },
  ...params: SqlStorageValue[]
): Window {
  const order = query.ascending ? "ASC" : "DESC";
  const [end, highest] = query.ascending ? ["max", "min"] : ["min", "max"];
  const rows = db.all<MergedRow>(
    `SELECT j.value AS id, sum(DISTINCT g.o) AS o, ${highest}(g.edge) AS edge
		FROM (SELECT CASE WHEN count(*) >= ${int(query.per)} THEN ${end}(id) END AS edge, max(o) AS o,
				json_group_array(id) AS members
			FROM (${query.streams}) GROUP BY k) g
		CROSS JOIN json_each(g.members) j
		GROUP BY 1 ORDER BY 1 ${order} LIMIT ${int(query.size) + 1}`,
    ...params,
  );
  return boundedWindow(rows, query.ascending, query.size);
}

// A row of mergedWindow's statement: a candidate, the OR of its streams' bits, and the highest end (lowest when
// ascending) of its streams that filled, or null.
export type MergedRow = { id: SqlStorageValue; o: number; edge: SqlStorageValue };

// The window of mergedWindow's rows, the first size + 1 candidates in cursor order: the bound is the highest edge
// among them (the lowest when ascending), and the window the candidates from the cursor to it, at most `size`, cut
// when it ends at a bound or past `size`. A bound below the first size + 1 candidates is that of a stream whose
// edge row is among them (its edge is its own last row), carrying the highest edge; one past them drops none of them,
// and the count decides the cut.
export function boundedWindow(rows: readonly MergedRow[], ascending: boolean, size: number): Window {
  const text = (value: SqlStorageValue): string => {
    if (typeof value !== "string") {
      throw new Error("a merged window's candidate is not TEXT");
    }
    return value;
  };
  let bound: string | null = null;
  for (const row of rows) {
    if (row.edge !== null) {
      const edge = text(row.edge);
      if (bound === null || (ascending ? edge < bound : edge > bound)) {
        bound = edge;
      }
    }
  }
  const kept = rows
    .map((row) => ({ id: text(row.id), o: row.o }))
    .filter(({ id }) => bound === null || (ascending ? id <= bound : id >= bound));
  return { candidates: kept.slice(0, size), cut: kept.length > size || bound !== null };
}

// The window of one stream: `candidates` selects (id) rows, the stream's candidates from the cursor in cursor order,
// at most `size`, so a full window may end before the range does. An INTEGER cursor is selected as TEXT, exact above
// 2^53.
export function singleWindow(db: Db, candidates: string, size: number, ...params: SqlStorageValue[]): Window {
  return windowOf(
    db.all<{ id: string }>(candidates, ...params).map(({ id }) => id),
    size,
  );
}

// The window of one stream read already: at most `size` candidate ids in cursor order.
export function windowOf(ids: readonly string[], size: number): Window {
  return { candidates: ids.map((id) => ({ id, o: 0 })), cut: ids.length >= size };
}

export function windowJson(window: Window): string {
  return JSON.stringify(window.candidates);
}

// The window of a read whose request conditions no index serves (docs/visibility.md "Read bounds"): rounds of raw
// candidates from the cursor, each `round(range, per)` with a per-stream LIMIT `per` over `streams` streams, of which
// it keeps those `passing` accepts (a set of ids, read by key), in cursor order. Round 1's per-stream LIMIT is `first`,
// each later one min(max(first, ⌊spent / streams⌋), ⌊(CONDITION_WALK − spent) / streams⌋), with `spent` the LIMITs
// charged so far. It ends with the first `size` kept (no `end`: a next page examines again what lies past the last
// kept; cut unless the round was exhausted and kept exactly `size`), at a round that was not cut, at a cut round when no
// round so far rejected a candidate (its window, as the read without conditions takes it), or cut at `end`, the last
// candidate examined, once the budget left cannot pay one more entry per stream. Without conditions (`passing` null)
// it is round 1 itself.
export function walkedWindow(
  round: (range: { max: string; min: string }, per: number) => Window,
  passing: ((candidates: Window["candidates"]) => ReadonlySet<string>) | null,
  start: { max: string; min: string; ascending: boolean },
  first: number,
  streams: number,
  size: number,
): Window {
  let range = { max: start.max, min: start.min };
  let per = Math.min(first, Math.floor(CONDITION_WALK / streams));
  let spent = 0;
  let rejected = false;
  const kept: Window["candidates"][number][] = [];
  for (;;) {
    const window = round(range, int(per));
    if (passing === null) {
      return window;
    }
    spent += streams * per;
    const passed = window.candidates.length === 0 ? new Set<string>() : passing(window.candidates);
    kept.push(...window.candidates.filter(({ id }) => passed.has(id)));
    if (kept.length >= size) {
      // Cut when the round was, or when it kept more than `size`: an exhausted round that kept exactly `size` holds
      // the whole of the cursor's range, as a single window of it would.
      return { candidates: kept.slice(0, size), cut: window.cut || kept.length > size };
    }
    rejected ||= passed.size < window.candidates.length;
    // Nothing rejected yet: this round is the single window a read without conditions takes, so its page and links
    // are that read's (AC5), ending where its merge ended.
    if (!window.cut || !rejected) {
      return { candidates: kept, cut: window.cut };
    }
    // A cut window holds the candidate it ended at (mergedWindow, windowOf).
    const last = window.candidates.at(-1)?.id;
    if (last === undefined) {
      throw new Error("a cut round has no candidates");
    }
    per = Math.min(Math.max(first, Math.floor(spent / streams)), Math.floor((CONDITION_WALK - spent) / streams));
    if (per < 1) {
      return { candidates: kept, cut: true, end: last };
    }
    range = start.ascending ? { ...range, min: last } : { ...range, max: last };
  }
}

// The page of a window: of the rows the rule passed (`passed`, keyed by candidate), the first `limit` in cursor order,
// newest first. Its far end is the last of them when the page is full, else, when the window was cut, its `end` or its
// last candidate, so a next page starts below what this one read; its near end is the first of them, or the window's
// first candidate when none passed. `cut`: the next link is offered whatever the page holds. `more`: a row may lie past
// the far end: a row the rule passed lies past the page in the window, or the window was cut. An uncut window holds
// every candidate of the cursor's range, so without either no row a page would show lies past it.
export function windowPage<R>(
  window: Window,
  passed: readonly R[],
  key: (row: R) => string,
  limit: number,
  ascending: boolean,
): { rows: R[]; newest: string | null; oldest: string | null; cut: boolean; more: boolean } {
  const byKey = new Map(passed.map((row) => [key(row), row]));
  const ordered = window.candidates.flatMap(({ id }) => byKey.get(id) ?? []);
  const taken = ordered.slice(0, limit);
  const full = taken.length >= limit;
  const first = taken[0];
  const last = taken.at(-1);
  const near = first !== undefined ? key(first) : window.cut ? (window.candidates[0]?.id ?? null) : null;
  const far =
    full && last !== undefined
      ? key(last)
      : window.cut
        ? (window.end ?? window.candidates.at(-1)?.id ?? null)
        : last === undefined
          ? null
          : key(last);
  const cut = window.cut && !full;
  const more = ordered.length > limit || window.cut;
  return ascending
    ? { rows: taken.toReversed(), newest: far, oldest: near, cut, more }
    : { rows: taken, newest: near, oldest: far, cut, more };
}

function int(n: number): number {
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new Error(`a window size must be a positive integer, not ${n}`);
  }
  return n;
}

// The cursor on an edge table's INTEGER id as a plain range, with `max` and `min` the cursor parameters (NULL for none):
// no cursor is a REAL beyond either end of the INTEGER range, so every id is inside it (SQLite compares the two types by
// value). A read in an index ending in the id then starts at the cursor, not at the newest.
export function edgeRangeSql(column: string, max: string, min: string): string {
  return `${column} < coalesce(CAST(${max} AS INTEGER), 1e19) AND ${column} > coalesce(CAST(${min} AS INTEGER), -1e19)`;
}

const STATUS_ID_LENGTH = 18;

// Status ids are 18-digit TEXT compared as TEXT (the indexes are on the TEXT column). A shorter cursor is padded so
// it compares as the number it is; a longer one is beyond every id, ABOVE_EVERY_ID, never the largest id itself (a
// range below it then keeps that id, and one above it holds nothing).
export function statusCursor(cursor: string | undefined): string | null {
  if (cursor === undefined) {
    return null;
  }
  cursor = cursor.replace(/^0+(?=\d)/, "");
  if (cursor.length > STATUS_ID_LENGTH) {
    return ABOVE_EVERY_ID;
  }
  return cursor.padStart(STATUS_ID_LENGTH, "0");
}

// Bounds beyond every 18-digit id, for a cursor that is absent: with them a range is always a plain one, read through
// the index from the cursor rather than filtered from the newest.
export const ABOVE_EVERY_ID = ":";
export const BELOW_EVERY_ID = "";
