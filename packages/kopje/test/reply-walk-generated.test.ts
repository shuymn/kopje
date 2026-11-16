import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WALK_STATUSES } from "../src/domain/reply-walks";
import { sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { mastodonNote, type Note } from "./inbox-status-helpers";
import {
  debtsOf,
  type DebtRow,
  localReplies,
  type Shape,
  served,
  storeReplies,
  threadRoot,
  threadWorld,
  walkOnce,
} from "./reply-thread-helpers";

// Generated threads walked again and again (#1607 D12, the design's section 9): threads of up to 400 statuses at most 6
// links deep, each link listed by its parent's collection (the child stored or not) or only scanned (a stored reply its
// parent's collection does not list), chains of either kind and alternating; a status listed again, at random, by
// another status's collection, before or after the rest; collections of up to 450 entries in pages of 1 to 450, their
// first page embedded in the status, in a collection document or fetched, or a chain of up to 3 embedded pages, entries
// that are no ids mixed in; up to 400 local stored replies a node. The walks run T alone, or T alternating with up to 3
// of its stored descendants as roots (each with its own debts, the cursors shared); between walks, a stored status with
// at most 100 stored replies is moved under another stored node, its replies linked to it (as a 404's removal and a
// later Create leave it). The fake fetch serves every document.
//
// Oracle 2, on the Store alone: in every walk, the debt heading the walking root's queue at its start is applied or
// dropped in it: gone after the walk, or a collection debt placed behind (the walk's epoch) with its place advanced;
// after every walk and every move, no status is named by two debts of one depth, none by more than WALK_STATUSES, and
// the debts number at most WALK_STATUSES × S. Oracle 3, discovery: every status of the thread is fetched by some walk,
// T's or another root's, within 40 walks of all roots. Oracle 1 (a reference of D12's rules giving each walk's fetches
// and debts) is not written here.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

// mulberry32.
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: () => number, items: readonly T[]): T => items[Math.floor(r() * items.length)]!;
const NOT_IDS: readonly unknown[] = [42, { type: "Note" }, "data:text/plain,x", "not a uri", null, { id: 7 }];

// Index 0 is T, 1 to n the statuses below it, each after its parent.
type Thread = {
  parent: number[];
  depth: number[];
  stored: boolean[];
  // Listed by its parent's collection; else only scanned (stored).
  listed: boolean[];
  // Extra listings: status `target` listed by `by`'s collection too, before or after its other entries.
  also: { target: number; by: number; first: boolean }[];
  notIds: number[];
  shape: Shape[];
  page: number[];
  local: number[];
};

function generate(r: () => number): Thread {
  const n = 50 + Math.floor(r() * 351);
  const t: Thread = {
    parent: [-1],
    depth: [0],
    stored: [true],
    listed: [true],
    also: [],
    notIds: [],
    shape: [],
    page: [],
    local: [],
  };
  // A few hubs take many children: collections past a step's 200 entries and the walk's 200 nodes.
  const hubs = [0, ...Array.from({ length: 3 }, () => Math.floor(r() * 20))];
  for (let i = 1; i <= n; i++) {
    const hub = pick(r, hubs);
    const open = Array.from({ length: i }, (_, j) => j).filter((j) => t.depth[j]! < 6);
    const p = r() < 0.4 && hub < i && t.depth[hub]! < 6 ? hub : pick(r, open);
    t.parent.push(p);
    t.depth.push(t.depth[p]! + 1);
    // A stored status's parent is stored (its link is its stored row's).
    const stored = t.stored[p]! && r() < 0.6;
    t.stored.push(stored);
    t.listed.push(!stored || r() < 0.5);
  }
  for (let i = 1; i <= n; i++) {
    const by = Math.floor(r() * (n + 1));
    if (r() < 0.1 && by !== t.parent[i] && by !== i) {
      t.also.push({ target: i, by, first: r() < 0.5 });
    }
  }
  for (let i = 0; i <= n; i++) {
    t.notIds.push(r() < 0.2 ? Math.floor(r() * 20) : 0);
    t.shape.push(pick(r, ["embedded", "first", "collection", "chain"] as const));
    t.page.push(1 + Math.floor(r() * (r() < 0.5 ? 450 : 40)));
    t.local.push(t.stored[i]! && r() < 0.3 ? Math.floor(r() * 401) : 0);
  }
  return t;
}

// The entries of status i's collection: the extra listings first or last, its listed children, and entries that are no
// ids at places drawn from `r`.
function entriesOf(t: Thread, i: number, uris: readonly string[], r: () => number): unknown[] {
  const children = t.parent.flatMap((p, c) => (c > 0 && p === i && t.listed[c]! ? [uris[c]!] : []));
  const also = (first: boolean) => t.also.filter((a) => a.by === i && a.first === first).map((a) => uris[a.target]!);
  const entries: unknown[] = [...also(true), ...children, ...also(false)];
  for (let k = 0; k < t.notIds[i]!; k++) {
    entries.splice(Math.floor(r() * (entries.length + 1)), 0, NOT_IDS[k % NOT_IDS.length]);
  }
  return entries;
}

// The chain shape's page size, so that its entries take at most 3 pages.
const pageOf = (t: Thread, i: number, entries: number) =>
  t.shape[i] === "chain" ? Math.max(Math.ceil(entries / (1 + (t.page[i]! % 3))), 1) : t.page[i]!;

const SEEDS = Array.from({ length: 25 }, (_, k) => 0x1607_0000 + k);

describe("generated threads (D12, section 9)", () => {
  it.each(SEEDS)(
    "seed %i: every status found within 40 walks, each walk's head debt settled, the totals held",
    { timeout: 600_000 },
    async (seed) => {
      const r = random(seed);
      const thread = generate(r);
      const { t, root, bob } = await threadWorld();
      const n = thread.parent.length - 1;
      const notes: Note[] = [mastodonNote(root)];
      for (let i = 1; i <= n; i++) {
        notes.push(mastodonNote(bob, { inReplyTo: notes[thread.parent[i]!]!.id }));
      }
      const uris = notes.map((note) => note.id);
      for (let i = 1; i <= n; i++) {
        const entries = entriesOf(thread, i, uris, r);
        served(t.web, notes[i]!, { items: entries, page: pageOf(thread, i, entries.length), shape: thread.shape[i]! });
      }
      const rootEntries = entriesOf(thread, 0, uris, r);
      const ids: string[] = [
        await threadRoot(t, root, notes[0]!, {
          items: rootEntries,
          page: pageOf(thread, 0, rootEntries.length),
          shape: thread.shape[0]!,
        }),
      ];
      for (let i = 1; i <= n; i++) {
        ids.push(
          thread.stored[i]
            ? (await storeReplies(t, bob, [{ note: notes[i]!, parentId: ids[thread.parent[i]!]! }]))[0]!
            : "",
        );
      }
      for (let i = 0; i <= n; i++) {
        if (thread.local[i]! > 0) {
          await localReplies(t, ids[i]!, uris[i]!, thread.local[i]!, 200_000 + i * 1000);
        }
      }
      // The roots: T alone, or T and up to 3 stored descendants in turn.
      const descendants = ids.flatMap((id, i) => (i > 0 && id !== "" ? [i] : []));
      const others = r() < 0.5 ? [] : Array.from({ length: 1 + Math.floor(r() * 3) }, () => pick(r, descendants));
      const roots = [0, ...new Set(others.filter((i) => i !== undefined))];
      const statuses = async () => (await sql<{ n: number }>(t.store, "SELECT count(*) AS n FROM statuses"))[0]!.n;
      const totals = async (when: string) => {
        const twice = await sql(
          t.store,
          "SELECT status_id, depth FROM reply_walk_debts GROUP BY status_id, depth HAVING count(*) > 1",
        );
        expect(twice, when).toEqual([]);
        const most = await sql<{ n: number | null }>(
          t.store,
          "SELECT max(n) AS n FROM (SELECT count(*) AS n FROM reply_walk_debts GROUP BY status_id)",
        );
        expect(most[0]!.n ?? 0, when).toBeLessThanOrEqual(WALK_STATUSES);
        const all = (await sql<{ n: number }>(t.store, "SELECT count(*) AS n FROM reply_walk_debts"))[0]!.n;
        expect(all, when).toBeLessThanOrEqual(WALK_STATUSES * (await statuses()));
      };
      const wanted = new Set(uris.slice(1));
      const found = new Set<string>();
      let extra = 2;
      for (let walk = 0; walk < 40 && extra > 0; walk++) {
        if (found.size === wanted.size) {
          extra -= 1;
        }
        // A move between walks: a stored status with at most 100 stored replies, under a stored node outside it.
        if (walk > 0 && r() < 0.15) {
          const movable = descendants.filter((i) => thread.parent.filter((p) => p === i).length <= 100);
          const moved = movable.length === 0 ? undefined : pick(r, movable);
          const inside = (i: number, top: number): boolean => i === top || (i > 0 && inside(thread.parent[i]!, top));
          const targets = moved === undefined ? [] : [0, ...descendants].filter((i) => !inside(i, moved));
          if (moved !== undefined && targets.length > 0) {
            const to = pick(r, targets);
            thread.parent[moved] = to;
            await sql(
              t.store,
              "UPDATE statuses SET in_reply_to_id = ?, in_reply_to_uri = ? WHERE id = ?",
              ids[to]!,
              uris[to]!,
              ids[moved]!,
            );
            await totals(`seed ${seed}, after the move before walk ${walk}`);
          }
        }
        const rootIndex = roots[walk % roots.length]!;
        const rootId = ids[rootIndex]!;
        const before = await debtsOf(t.store, rootId);
        const head = before[0];
        const epoch = Math.max(0, ...before.map((d) => d.key[0])) + 1;
        for (const uri of await walkOnce(t, rootId, wanted)) {
          found.add(uri);
        }
        const when = `seed ${seed}, walk ${walk} of root ${rootIndex}`;
        if (head !== undefined) {
          const after: DebtRow | undefined = (await debtsOf(t.store, rootId)).find((d) => d.status === head.status);
          // A row debt paid, its status's collection then cut, is a new collection debt.
          const behind =
            after !== undefined &&
            after.kind === 1 &&
            after.key[0] === epoch &&
            (head.kind === 0 || after.page !== head.page || after.offset !== head.offset);
          expect(
            after === undefined || behind,
            `${when}: head ${JSON.stringify(head)} -> ${JSON.stringify(after)}`,
          ).toBe(true);
        }
        await totals(when);
      }
      expect(
        [...wanted].filter((uri) => !found.has(uri)),
        `seed ${seed}: statuses not fetched within 40 walks`,
      ).toEqual([]);
    },
  );
});
