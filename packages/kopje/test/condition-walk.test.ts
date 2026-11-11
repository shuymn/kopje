import { describe, expect, it } from "vitest";

import {
  CONDITION_WALK,
  readWindow,
  streamWindow,
  walkedWindow,
  type Window,
  windowOf,
  windowPage,
} from "../src/domain/windows";
import { CONDITION_WALK_ROUNDS } from "./condition-walk-helpers";

// walkedWindow (src/domain/windows.ts, docs/visibility.md "Read bounds"): the rounds a page under request conditions
// walks, their summed stream LIMITs within CONDITION_WALK, and the far end windowPage takes from a cut walk.

const id = (n: number) => String(n).padStart(18, "0");

// A range of `total` raw candidates, ids 1 to `total`, read `streams` at a time per entry of the per-stream LIMIT (each
// stream the same ids, as overlapping names are): a round answers the ids in the range in cursor order, at most `per`,
// and is cut when it filled. Records each round's range and LIMIT.
function rawRange(total: number, ascending: boolean) {
  const rounds: { max: string; min: string; per: number }[] = [];
  const round = (range: { max: string; min: string }, per: number): Window => {
    rounds.push({ ...range, per });
    const ids: string[] = [];
    for (let i = 1; i <= total; i++) {
      const candidate = ascending ? id(i) : id(total + 1 - i);
      if (candidate < range.max && candidate > range.min) {
        ids.push(candidate);
      }
      if (ids.length === per) {
        break;
      }
    }
    return windowOf(ids, per);
  };
  return { round, rounds };
}

const start = (ascending: boolean) => ({ max: ":", min: "", ascending });

describe("a condition walk's rounds stay within CONDITION_WALK (C1)", () => {
  it("sums its LIMITs within the budget, never below 1 a stream, and moves on each round, for limits 1-40 and 1-5 streams", () => {
    let most = 0;
    const failures: string[] = [];
    for (const ascending of [false, true]) {
      for (let limit = 1; limit <= 40; limit++) {
        for (let streams = 1; streams <= 5; streams++) {
          // Account statuses' first LIMIT is readWindow, a hashtag's streamWindow.
          for (const first of [readWindow(limit), streamWindow(limit)]) {
            const { round, rounds } = rawRange(1_000_000, ascending);
            // Every candidate rejected: the walk runs until the budget ends it.
            const window = walkedWindow(round, () => new Set(), start(ascending), first, streams, 60);
            const spent = rounds.reduce((sum, r) => sum + streams * r.per, 0);
            const name = `${ascending ? "asc" : "desc"} limit ${limit} streams ${streams} first ${first}`;
            if (spent > CONDITION_WALK || CONDITION_WALK - spent >= streams) {
              failures.push(`${name}: spent ${spent}`);
            }
            if (rounds.some((r) => r.per < 1)) {
              failures.push(`${name}: a LIMIT below 1`);
            }
            for (let i = 1; i < rounds.length; i++) {
              const [before, after] = [rounds[i - 1]!, rounds[i]!];
              const moved = ascending ? after.min > before.min : after.max < before.max;
              if (!moved) {
                failures.push(`${name}: round ${i} did not move`);
              }
            }
            if (!window.cut || window.end === undefined || window.candidates.length > 0) {
              failures.push(`${name}: not cut at an end`);
            }
            most = Math.max(most, rounds.length);
          }
        }
      }
    }
    expect(failures).toEqual([]);
    expect(most).toBe(CONDITION_WALK_ROUNDS);
  });

  it("runs three names at limit 20 as 40, 40, 80, 160, 320 and 26, ending cut at 1,998", () => {
    const { round, rounds } = rawRange(1_000_000, false);
    const window = walkedWindow(round, () => new Set(), start(false), streamWindow(20), 3, readWindow(20));
    expect(rounds.map((r) => r.per)).toEqual([40, 40, 80, 160, 320, 26]);
    // The last round's last candidate: the 666th raw id from the top (one stream's ids, read 666 deep).
    expect(window).toEqual({ candidates: [], cut: true, end: id(1_000_000 - 665) });
  });

  it("runs one round without conditions, today's read", () => {
    const { round, rounds } = rawRange(1_000_000, false);
    const window = walkedWindow(round, null, start(false), readWindow(20), 1, readWindow(20));
    expect(rounds).toEqual([{ max: ":", min: "", per: 60 }]);
    expect(window.candidates.length).toBe(60);
    expect(window.end).toBeUndefined();
  });

  it("stops uncut at the end of its range, and keeps what passed", () => {
    const { round } = rawRange(500, false);
    const passing = (candidates: Window["candidates"]) =>
      new Set(candidates.filter(({ id }) => Number(id) % 100 === 0).map(({ id }) => id));
    const window = walkedWindow(round, passing, start(false), 60, 1, 60);
    expect(window).toEqual({ candidates: [500, 400, 300, 200, 100].map((n) => ({ id: id(n), o: 0 })), cut: false });
  });
});

describe("collecting the window's size keeps whether its round was cut (C4)", () => {
  // One round of `count` candidates, cut or exhausted, every one passing, for a window of 3.
  const once = (count: number, cut: boolean) =>
    walkedWindow(
      () => ({ candidates: [9, 8, 7, 6].slice(0, count).map((n) => ({ id: id(n), o: 0 })), cut }),
      (candidates) => new Set(candidates.map(({ id }) => id)),
      start(false),
      40,
      1,
      3,
    );

  it("is not cut when an exhausted round kept exactly the size", () => {
    expect(once(3, false)).toEqual({ candidates: [9, 8, 7].map((n) => ({ id: id(n), o: 0 })), cut: false });
  });

  it("is cut when an exhausted round kept more than the size, or a cut round kept exactly the size", () => {
    expect(once(4, false).cut).toBe(true);
    expect(once(3, true).cut).toBe(true);
  });

  it("stops at a cut round short of the size when nothing was rejected, as the read without conditions does", () => {
    const { round, rounds } = rawRange(1_000, false);
    const window = walkedWindow(
      (range, per) => {
        const read = round(range, per);
        return { ...read, candidates: read.candidates.slice(0, 2) };
      },
      (candidates) => new Set(candidates.map(({ id }) => id)),
      start(false),
      40,
      1,
      3,
    );
    expect(rounds).toHaveLength(1);
    expect(window).toEqual({ candidates: [1_000, 999].map((n) => ({ id: id(n), o: 0 })), cut: true });
  });
});

describe("collecting the window's size sets no end (C5)", () => {
  it("returns the first `size` passing rows, cut, with no end, so a next page examines what lies after them", () => {
    const { round } = rawRange(10_000, false);
    // Every third candidate passes: the second round (LIMIT 60) collects 40 passing rows, past the size of 30.
    const passing = (candidates: Window["candidates"]) =>
      new Set(candidates.filter(({ id }) => Number(id) % 3 === 0).map(({ id }) => id));
    const window = walkedWindow(round, passing, start(false), 60, 1, 30);
    expect(window.cut).toBe(true);
    expect(window.end).toBeUndefined();
    expect(window.candidates.length).toBe(30);
    expect(window.candidates.at(-1)?.id).toBe(id(9_912));
  });
});

describe("windowPage takes a cut walk's end only for a page that is not full (C4)", () => {
  const candidates = [5, 4, 3].map((n) => ({ id: id(n), o: 0 }));
  const passed = candidates.map(({ id }) => ({ id }));

  it("continues from the end of a cut window whose page is not full, in both directions", () => {
    const window = { candidates, cut: true, end: id(1) };
    expect(windowPage(window, passed, (row) => row.id, 20, false)).toMatchObject({
      newest: id(5),
      oldest: id(1),
      cut: true,
      more: true,
    });
    expect(windowPage(window, passed, (row) => row.id, 20, true)).toMatchObject({
      newest: id(1),
      oldest: id(5),
      cut: true,
      more: true,
    });
    expect(
      windowPage({ candidates: [], cut: true, end: id(1) }, [] as { id: string }[], (row) => row.id, 20, false),
    ).toMatchObject({
      rows: [],
      newest: null,
      oldest: id(1),
      cut: true,
    });
  });

  it("ends a full page at its last row, whatever the end", () => {
    const window = { candidates, cut: true, end: id(1) };
    expect(windowPage(window, passed, (row) => row.id, 2, false)).toMatchObject({ oldest: id(4), cut: false });
  });

  it("ends a page of an uncut window at its last row", () => {
    expect(windowPage({ candidates, cut: false }, passed, (row) => row.id, 20, false)).toMatchObject({
      oldest: id(3),
      cut: false,
      more: false,
    });
  });
});
