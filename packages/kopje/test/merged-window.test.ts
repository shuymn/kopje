import { runInDurableObject } from "cloudflare:test";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { CONDITION_WALK, mergedWindow, type Window } from "../src/domain/windows";
import { migratedStore } from "./helpers";
import { runs } from "./policy-world";

// mergedWindow (src/domain/windows.ts), which reads the streams in one pass and bounds its rows in the Worker,
// returns the Window main's statement and its post-processing returned, copied here literally (MAIN_WINDOW), over the
// same streams. The streams are given as rows (id, k, o) bound as JSON, each stream's ids in cursor order and at most
// `per` of them, `o` constant within a stream, as mergedWindow's contracts require of its callers. Each case below is
// one a wrong bound, an exclusive bound, a sum of repeated bits, a cut without the bound, or a window without its
// streams' edges would answer differently.

type Stream = { k: string; o: number; ids: readonly string[] };
type Query = { ascending: boolean; per: number; size: number };

const STREAMS = `SELECT json_extract(value, '$[0]') AS id, json_extract(value, '$[1]') AS k, json_extract(value, '$[2]') AS o
	FROM json_each(?1)`;

// main's mergedWindow, as it was (its int() checks dropped: the cases pass positive integers).
function MAIN_WINDOW(
  db: Db,
  query: { streams: string; ascending: boolean; per: number; size: number },
  ...params: SqlStorageValue[]
): Window {
  const order = query.ascending ? "ASC" : "DESC";
  const [toward, end] = query.ascending ? ["<=", "max"] : [">=", "min"];
  const highest = query.ascending ? "min" : "max";
  const rows = db.all<{ id: string; o: number; bound: string | null }>(
    `WITH c(id, k, o) AS MATERIALIZED (${query.streams}),
		f(bound) AS (SELECT ${highest}(edge) FROM (SELECT ${end}(id) AS edge FROM c GROUP BY k HAVING count(*) >= ${query.per}))
		SELECT id, sum(DISTINCT o) AS o, (SELECT bound FROM f) AS bound FROM c
		WHERE (SELECT bound FROM f) IS NULL OR id ${toward} (SELECT bound FROM f)
		GROUP BY id ORDER BY id ${order} LIMIT ${query.size + 1}`,
    ...params,
  );
  const cut = rows.length > query.size || (rows[0]?.bound ?? null) !== null;
  return { candidates: rows.slice(0, query.size).map(({ id, o }) => ({ id, o })), cut };
}

const id = (n: number) => `1${String(n).padStart(17, "0")}`;

// A stream of the ids `ns` (numbers), in the cursor order of `ascending`.
function stream(k: string, o: number, ns: readonly number[], ascending: boolean): Stream {
  return { k, o, ids: ns.toSorted((a, b) => (ascending ? a - b : b - a)).map(id) };
}

const json = (streams: readonly Stream[]) => JSON.stringify(streams.flatMap((s) => s.ids.map((i) => [i, s.k, s.o])));

// Both windows over each world, in one Store.
async function windows(worlds: readonly { streams: readonly Stream[]; query: Query }[]) {
  const store = await migratedStore();
  return runInDurableObject(store, (_instance, state) => {
    const db = new Db(state.storage.sql);
    return worlds.map(({ streams, query }) => {
      const q = { streams: STREAMS, ...query };
      return { main: MAIN_WINDOW(db, q, json(streams)), mine: mergedWindow(db, q, json(streams)) };
    });
  });
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

// Named cases, each in both orders (the ids mirrored, so the same case holds when ascending).
const CASES: Record<string, (ascending: boolean) => { streams: Stream[]; query: Omit<Query, "ascending"> }> = {
  "no stream": () => ({ streams: [], query: { per: 3, size: 6 } }),
  "no stream full": (a) => ({
    streams: [stream("a", 1, [10, 8], a), stream("b", 2, [9], a)],
    query: { per: 3, size: 6 },
  }),
  // A filled stream ends the window at its edge, below `size`: the edge drops the other stream's farther ids, and
  // without it the window would hold them and not be cut.
  "a filled stream bounding below size": (a) => ({
    streams: [stream("a", 1, a ? [1, 2, 3] : [9, 8, 7], a), stream("b", 2, a ? [4, 5] : [6, 5], a)],
    query: { per: 3, size: 10 },
  }),
  // Two filled streams, the nearer edge and the farther: the bound is the nearer (the highest when descending).
  "two filled streams, different edges": (a) => ({
    streams: [
      stream("a", 1, a ? [1, 2, 3] : [20, 19, 18], a),
      stream("b", 2, a ? [4, 8, 12] : [17, 13, 9], a),
      stream("c", 4, a ? [5, 6] : [16, 15], a),
    ],
    query: { per: 3, size: 20 },
  }),
  "more than size + 1 within the bound": (a) => ({
    streams: [stream("a", 1, range(1, 8), a), stream("b", 2, range(11, 18), a)],
    query: { per: 8, size: 5 },
  }),
  // An id in several filled streams carries the highest of their edges (the lowest when ascending): 9 and 8 are in the
  // streams ending at 7 and 6, and the bound, 7, is the highest edge, which their rows must carry for it to be found.
  "shared ids of filled streams with different edges": (a) => ({
    streams: [
      stream("a", 1, a ? [1, 2, 3] : [9, 8, 7], a),
      stream("b", 2, a ? [1, 2, 4] : [9, 8, 6], a),
      stream("c", 4, a ? [3, 4, 5] : [7, 6, 5], a),
    ],
    query: { per: 3, size: 10 },
  }),
  "a tie at the bound": (a) => ({
    streams: [stream("a", 1, a ? [1, 2, 5] : [9, 8, 5], a), stream("b", 2, a ? [3, 4, 5] : [7, 6, 5], a)],
    query: { per: 3, size: 10 },
  }),
  // One id in streams of different bits and in two of the same bit: its bits are ORed, the repeated one counted once.
  "shared ids": (a) => ({
    streams: [
      stream("a1", 2, [9, 7, 5], a),
      stream("a2", 2, [9, 6], a),
      stream("own", 1, [9, 8, 7], a),
      stream("t", 4, [8, 6], a),
    ],
    query: { per: 3, size: 10 },
  }),
  // A hashtag round's size, names × per: cut exactly when a stream filled.
  "size = names × per, one filled": (a) => ({
    streams: [stream("0", 0, a ? [1, 2] : [9, 8], a), stream("1", 0, a ? [3, 4] : [7, 6], a), stream("2", 0, [5], a)],
    query: { per: 2, size: 6 },
  }),
  "size = names × per, none filled": (a) => ({
    streams: [stream("0", 0, [9], a), stream("1", 0, [7], a), stream("2", 0, [5], a)],
    query: { per: 2, size: 6 },
  }),
  "a stream of CONDITION_WALK": (a) => ({
    streams: [stream("0", 0, range(1, CONDITION_WALK), a), stream("1", 0, range(5000, 5100), a)],
    query: { per: CONDITION_WALK, size: CONDITION_WALK },
  }),
};

describe("mergedWindow beside main's", () => {
  it.each(Object.keys(CASES).flatMap((name) => [false, true].map((ascending) => [name, ascending] as const)))(
    "%s, ascending %s",
    async (name, ascending) => {
      const { streams, query } = CASES[name]!(ascending);
      const [{ main, mine }] = (await windows([{ streams, query: { ...query, ascending } }])) as [
        { main: Window; mine: Window },
      ];
      expect(mine).toEqual(main);
    },
  );

  // The cases' windows themselves, so a case cannot pass by both sides failing alike.
  it("answers the cases as main did", async () => {
    const pick = (name: string, ascending = false) => {
      const { streams, query } = CASES[name]!(ascending);
      return { streams, query: { ...query, ascending } };
    };
    const [bounded, shared, walk] = await windows([
      pick("a filled stream bounding below size"),
      pick("shared ids"),
      pick("a stream of CONDITION_WALK"),
    ]);
    expect(bounded!.mine).toEqual({
      candidates: [9, 8, 7].map((n) => ({ id: id(n), o: 1 })),
      cut: true,
    });
    expect(shared!.mine.candidates.slice(0, 2)).toEqual([
      { id: id(9), o: 3 },
      { id: id(8), o: 5 },
    ]);
    expect(walk!.mine.candidates).toHaveLength(CONDITION_WALK);
  });

  it("returns main's window over random streams", { timeout: 120_000 }, async () => {
    const world = fc
      .record({
        ascending: fc.boolean(),
        per: fc.integer({ min: 1, max: 6 }),
        size: fc.integer({ min: 1, max: 20 }),
        streams: fc.array(
          fc.record({ o: fc.constantFrom(0, 1, 2, 4), ns: fc.uniqueArray(fc.integer({ min: 1, max: 40 })) }),
          { maxLength: 6 },
        ),
      })
      .map(({ ascending, per, size, streams }) => ({
        streams: streams.map((s, k) => stream(String(k), s.o, s.ns.slice(0, per), ascending)),
        query: { ascending, per, size },
      }));
    await fc.assert(
      fc.asyncProperty(fc.array(world, { minLength: 1, maxLength: 20 }), async (worlds) => {
        for (const { main, mine } of await windows(worlds)) {
          expect(mine).toEqual(main);
        }
      }),
      runs(30, 20_261_114),
    );
  });
});
