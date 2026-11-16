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
  walkSteps,
} from "./reply-thread-helpers";
import { type RefDoc, referenceWalk, RefWorld } from "./reply-walk-reference";

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
// Oracle 1, the rules: the reference of reply-walk-reference.ts, written from the designs' text and not from src/,
// walks the same thread after each of the Store's walks, the ids the Store drew taken as its own, and gives the status
// steps the walk handed out, in order, the statuses stored with their parents, every root's debts in key order (status,
// kind, place, depth, key) and the scan cursors, which the Store's must equal.
//
// Oracle 2, on the Store alone: in every walk, the debt heading the walking root's queue at its start is applied or
// dropped in it: gone after the walk, or a collection debt placed behind (the walk's epoch) with its place advanced;
// after every walk and every move, no status is named by two debts of one depth, none by more than WALK_STATUSES, and
// the debts number at most WALK_STATUSES × S.
//
// Oracle 3, discovery: every status of the thread is fetched by some walk, T's or another root's, by the walk at which
// the reference has first fetched them all, a deadline the reference finds; a thread the reference does not finish
// within 40 walks of all roots fails (the reference or the generator is wrong).

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

type Snapshot = { ids: Map<string, string>; stored: string[]; debts: string[]; cursors: string[] };

// What oracle 1 compares, read from the Store: its remote statuses with their parents, every root's debts in key order
// and the scan cursors, by URI; and the ids it drew, which the reference takes.
async function snapshot(t: Awaited<ReturnType<typeof threadWorld>>["t"]): Promise<Snapshot> {
  const rows = await sql<{ id: string; uri: string; parent: string | null; local: number }>(
    t.store,
    `SELECT s.id, s.uri, p.uri AS parent, l.account_id IS NOT NULL AS local
			FROM statuses s LEFT JOIN statuses p ON p.id = s.in_reply_to_id
				LEFT JOIN local_accounts l ON l.account_id = s.account_id`,
  );
  const debts = await sql<{ line: string }>(
    t.store,
    `SELECT r.uri || ' ' || s.uri || ' k' || d.kind || ' ' || COALESCE(d.page, '-') || '@' || d.page_offset || ' d' ||
				d.depth || ' [' || d.owed_walk || ',' || d.owed_seq || ',' || d.owed_pos || ']' AS line
			FROM reply_walk_debts d JOIN statuses r ON r.id = d.root_id JOIN statuses s ON s.id = d.status_id
			ORDER BY r.uri, d.owed_walk, d.owed_seq, d.owed_pos`,
  );
  const cursors = await sql<{ line: string }>(
    t.store,
    `SELECT s.uri || ' ' || c.after_id AS line FROM reply_walk_cursors c JOIN statuses s ON s.id = c.status_id
			ORDER BY s.uri`,
  );
  return {
    ids: new Map(rows.map((row) => [row.uri, row.id])),
    stored: rows
      .filter((row) => row.local === 0)
      .map((row) => `${row.uri} <- ${row.parent ?? "-"}`)
      .toSorted(),
    debts: debts.map((row) => row.line),
    cursors: cursors.map((row) => row.line),
  };
}

// The same of the reference's world.
function referenceSnapshot(world: RefWorld): Omit<Snapshot, "ids"> {
  const uriOf = (id: string) => world.byId.get(id)!.uri;
  const debts = [...world.debts]
    .flatMap(([rootId, owed]) => [...owed.values()].map((d) => ({ root: uriOf(rootId), d })))
    .toSorted((a, b) =>
      a.root !== b.root
        ? a.root < b.root
          ? -1
          : 1
        : a.d.key[0] - b.d.key[0] || a.d.key[1] - b.d.key[1] || a.d.key[2] - b.d.key[2],
    )
    .map(
      ({ root, d }) =>
        `${root} ${uriOf(d.statusId)} k${d.kind} ${d.place.page ?? "-"}@${d.place.offset} d${d.depth} [${d.key.join(",")}]`,
    );
  return {
    stored: [...world.statuses.values()]
      .filter((status) => !status.local)
      .map((status) => `${status.uri} <- ${status.parentId === null ? "-" : uriOf(status.parentId)}`)
      .toSorted(),
    debts,
    cursors: [...world.cursors].map(([id, after]) => `${uriOf(id)} ${after}`).toSorted((a, b) => (a < b ? -1 : 1)),
  };
}

describe("generated threads (D12, section 9)", () => {
  it.each(SEEDS)(
    "seed %i: each walk as the reference's, its head debt settled, the totals held, every status found by its deadline",
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
      const docs = new Map<string, RefDoc>();
      const serve = (i: number, entries: unknown[]) => {
        const listing = { items: entries, page: pageOf(thread, i, entries.length), shape: thread.shape[i]! };
        docs.set(uris[i]!, { inReplyTo: i === 0 ? null : uris[thread.parent[i]!]!, entries, ...listing });
        return listing;
      };
      for (let i = 1; i <= n; i++) {
        served(t.web, notes[i]!, serve(i, entriesOf(thread, i, uris, r)));
      }
      const ids: string[] = [await threadRoot(t, root, notes[0]!, serve(0, entriesOf(thread, 0, uris, r)))];
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
      // Oracle 1's world: the served documents, and the statuses as stored now.
      const world = new RefWorld(docs);
      const rows = await sql<{ id: string; uri: string; parent: string | null; local: number }>(
        t.store,
        `SELECT s.id, s.uri, s.in_reply_to_id AS parent, l.account_id IS NOT NULL AS local
				FROM statuses s LEFT JOIN local_accounts l ON l.account_id = s.account_id ORDER BY s.id`,
      );
      for (const row of rows) {
        world.store({ id: row.id, uri: row.uri, parentId: row.parent, local: row.local === 1 });
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
      const referenceFound = new Set<string>();
      // Oracle 3's deadline: the walk by which the reference has fetched every status; two walks more run past it.
      let deadline: number | undefined;
      for (let walk = 0; walk < 40 && (deadline === undefined || walk <= deadline + 2); walk++) {
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
            world.move(ids[moved]!, ids[to]!);
            await totals(`seed ${seed}, after the move before walk ${walk}`);
          }
        }
        const rootIndex = roots[walk % roots.length]!;
        const rootId = ids[rootIndex]!;
        const before = await debtsOf(t.store, rootId);
        const head = before[0];
        const epoch = Math.max(0, ...before.map((d) => d.key[0])) + 1;
        const steps = await walkSteps(t, rootId);
        const fetched = steps.filter((step) => step.stage === "status").map((step) => step.uri);
        for (const uri of fetched) {
          found.add(uri);
        }
        const when = `seed ${seed}, walk ${walk} of root ${rootIndex}`;
        // Oracle 1: the reference's walk, its ids the Store's.
        const store = await snapshot(t);
        const expected = referenceWalk(world, uris[rootIndex]!, (uri) => store.ids.get(uri) ?? `~${uri}`);
        for (const uri of expected) {
          referenceFound.add(uri);
        }
        expect(fetched, `${when}: the statuses fetched`).toEqual(expected);
        const reference = referenceSnapshot(world);
        expect(store.stored, `${when}: the statuses stored`).toEqual(reference.stored);
        expect(store.debts, `${when}: the debts`).toEqual(reference.debts);
        expect(store.cursors, `${when}: the cursors`).toEqual(reference.cursors);
        if (deadline === undefined && [...wanted].every((uri) => referenceFound.has(uri))) {
          deadline = walk;
          // Oracle 3: every status fetched by then, by some walk.
          expect(
            [...wanted].filter((uri) => !found.has(uri)),
            `seed ${seed}: statuses not fetched by walk ${walk}`,
          ).toEqual([]);
        }
        // Oracle 2.
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
      // Oracle 3: a thread the reference does not finish within 40 walks fails (the reference or the generator is
      // wrong).
      expect(deadline, `seed ${seed}: the reference did not fetch every status within 40 walks`).toBeDefined();
    },
  );
});
