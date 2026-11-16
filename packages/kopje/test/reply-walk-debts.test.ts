import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { REPLY_SCAN_ROWS } from "../src/domain/reply-walk-debts";
import { REPLIES_COOLDOWN_MS, REPLIES_INITIAL_WAIT_MS } from "../src/domain/reply-walk-reads";
import { WALK_PAGES, WALK_STATUSES } from "../src/domain/reply-walks";
import { REPLY_STEPS_PER_WALK } from "../src/federation/replies";
import { sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { mastodonActor } from "./inbox-helpers";
import {
  accountId,
  ALICE,
  AS,
  create,
  DAVE,
  followed,
  mastodonNote,
  type Note,
  statusRow,
} from "./inbox-status-helpers";
import {
  cursorOf,
  debtsOf,
  localReplies,
  OTHER_ORIGIN,
  owedDebt,
  pageUri,
  served,
  servedReply,
  storedId,
  storedReplies,
  storeReplies,
  threadRoot,
  threadWorld,
  walkOnce,
  walkSteps,
} from "./reply-thread-helpers";
import { serveNote, startWalk, walkRounds, walkRow } from "./reply-walk-helpers";

// The scans of stored replies and the debts of the walks of replies collections (#1607 D12: domain/reply-walk-debts.ts
// and reply-walks.ts), through the Worker's rounds and the Store: what a scan examines and admits, where its cursor
// stands, what a full walk owes its root, and the order the root's next walks take it in. The Store's clock is the
// faked Date; each walk starts past the last one's cooldown.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

const iso = (ms: number) => new Date(ms).toISOString();
// The Store's time of the next walk (walkOnce moves the clock past the cooldown first).
const nextWalkAt = () => Date.now() + REPLIES_COOLDOWN_MS + 1;
const count = (fetched: readonly string[], uri: string) => fetched.filter((url) => url === uri).length;

describe("a scan's window (D12, What a scan examines)", () => {
  it("admits an eligible reply past 150 filtered rows in one scan: local ones, nodes of the walk, too recent ones", async () => {
    const { t, root, bob } = await threadWorld();
    const note = mastodonNote(root);
    // 50 stored replies the root lists (nodes of the walk), 50 local replies and 50 published within the initial wait,
    // all below U.
    const listed = Array.from({ length: 50 }, () => servedReply(t.web, bob, note.id));
    const rootId = await threadRoot(t, root, note, { items: listed.map((n) => n.id) });
    await storeReplies(
      t,
      bob,
      listed.map((n, i) => ({ note: n, parentId: rootId, id: storedId(1000 + i) })),
    );
    await localReplies(t, rootId, note.id, 50, 1050);
    const recent = Array.from({ length: 50 }, () => servedReply(t.web, bob, note.id));
    const at = nextWalkAt();
    await storeReplies(
      t,
      bob,
      recent.map((n, i) => ({
        note: n,
        parentId: rootId,
        id: storedId(1100 + i),
        published: iso(at - REPLIES_INITIAL_WAIT_MS + 1000),
      })),
    );
    const u = servedReply(t.web, bob, note.id);
    await storeReplies(t, bob, [{ note: u, parentId: rootId, id: storedId(1150) }]);
    const fetched = await walkOnce(t, rootId, new Set([u.id, ...recent.map((n) => n.id)]));
    expect(fetched).toEqual([u.id]);
  });

  it("goes on from its cursor: 250 filtered rows before U, the second scan wraps and admits U", async () => {
    const { t, root, bob } = await threadWorld();
    const note = mastodonNote(root);
    const rootId = await threadRoot(t, root, note);
    await localReplies(t, rootId, note.id, 250, 2000);
    const u = servedReply(t.web, bob, note.id);
    await storeReplies(t, bob, [{ note: u, parentId: rootId, id: storedId(2250) }]);
    const watched = new Set([u.id]);
    expect(await walkOnce(t, rootId, watched)).toEqual([]);
    // The first scan examined rows 1 to 200: its cursor names the 200th.
    expect(await cursorOf(t.store, rootId)).toBe(storedId(2199));
    expect(await walkOnce(t, rootId, watched)).toEqual([u.id]);
    // The second examined rows 201 to 251 and wrapped to the 149 from the first: its cursor names the 149th.
    expect(await cursorOf(t.store, rootId)).toBe(storedId(2148));
  });

  it("spends no scan on a reset: 200 rows with U last and too recent at the first, and 400 with U last", async () => {
    for (const total of [REPLY_SCAN_ROWS, 2 * REPLY_SCAN_ROWS]) {
      const { t, root, bob } = await threadWorld();
      const note = mastodonNote(root);
      const rootId = await threadRoot(t, root, note);
      await localReplies(t, rootId, note.id, total - 1, 3000);
      const u = servedReply(t.web, bob, note.id);
      // Too recent at the first walk, past the wait at the second.
      const published = total === REPLY_SCAN_ROWS ? iso(nextWalkAt() - 60_000) : undefined;
      await storeReplies(t, bob, [
        {
          note: u,
          parentId: rootId,
          id: storedId(3000 + total - 1),
          ...(published === undefined ? {} : { published }),
        },
      ]);
      const watched = new Set([u.id]);
      expect(await walkOnce(t, rootId, watched), `${total} rows`).toEqual([]);
      expect(await walkOnce(t, rootId, watched), `${total} rows`).toEqual([u.id]);
    }
  });

  it("examines a reply stored behind its cursor within the next ⌈N / REPLY_SCAN_ROWS⌉ scans, wrapping", async () => {
    const { t, root, bob } = await threadWorld();
    const note = mastodonNote(root);
    const rootId = await threadRoot(t, root, note);
    // 400 local rows at even places; after the first scan (its cursor at the 200th), U at an odd place among the
    // first 100: N = 401, so within 3 further scans; the second examines rows 201 to 400 and the third wraps to U.
    await localReplies(t, rootId, note.id, 400, 4000, 2);
    expect(await walkOnce(t, rootId, new Set())).toEqual([]);
    expect(await cursorOf(t.store, rootId)).toBe(storedId(4000 + 2 * 199));
    const u = servedReply(t.web, bob, note.id);
    await storeReplies(t, bob, [{ note: u, parentId: rootId, id: storedId(4101) }]);
    const watched = new Set([u.id]);
    expect(await walkOnce(t, rootId, watched)).toEqual([]);
    expect(await walkOnce(t, rootId, watched)).toEqual([u.id]);
  });
});

describe("what a scan admits and owes (D12, Who is admitted; Where a scan ends)", () => {
  it("owes the eligible rows a full walk has no slot for, keyed in window order, and examines the rest", async () => {
    const { t, root, bob } = await threadWorld();
    const note = mastodonNote(root);
    // The root lists 199 unstored items, which fill the walk; its window holds U at place 6 and V at place 10 among
    // 198 local rows, and 10 local rows lie past the window.
    const items = Array.from({ length: WALK_STATUSES - 1 }, () => servedReply(t.web, bob, note.id));
    const rootId = await threadRoot(t, root, note, { items: items.map((n) => n.id) });
    await localReplies(t, rootId, note.id, 5, 5000);
    const [u, v] = [servedReply(t.web, bob, note.id), servedReply(t.web, bob, note.id)];
    await storeReplies(t, bob, [{ note: u, parentId: rootId, id: storedId(5005) }]);
    await localReplies(t, rootId, note.id, 3, 5006);
    await storeReplies(t, bob, [{ note: v, parentId: rootId, id: storedId(5009) }]);
    await localReplies(t, rootId, note.id, 200, 5010);
    const fetched = await walkOnce(t, rootId, new Set([u.id, v.id]));
    expect(fetched).toEqual([]);
    expect(await debtsOf(t.store, rootId)).toEqual([
      { status: u.id, kind: 0, page: null, offset: 0, depth: 1, key: [1, 0, 6] },
      { status: v.id, kind: 0, page: null, offset: 0, depth: 1, key: [1, 0, 10] },
    ]);
    // Past V, the scan examined its whole allowance: its cursor names the window's 200th row.
    expect(await cursorOf(t.store, rootId)).toBe(storedId(5199));
  });

  it("counts the root's slot: 200 eligible replies of a root, 199 admitted, the 200th owed and fetched first next", async () => {
    const { t, root, bob } = await threadWorld();
    const note = mastodonNote(root);
    const rootId = await threadRoot(t, root, note);
    const { notes } = await storedReplies(t, bob, rootId, note.id, WALK_STATUSES, { at: 6000 });
    const last = notes.at(-1)!;
    const watched = new Set([note.id, ...notes.map((n) => n.id)]);
    const first = await walkOnce(t, rootId, watched);
    expect(first).toHaveLength(WALK_STATUSES);
    expect(first).not.toContain(last.id);
    expect(await debtsOf(t.store, rootId)).toEqual([
      { status: last.id, kind: 0, page: null, offset: 0, depth: 1, key: [1, 0, WALK_STATUSES] },
    ]);
    const second = await walkOnce(t, rootId, watched);
    expect(second.slice(0, 2)).toEqual([last.id, note.id]);
    // The root's scan then admits 198 of the others and owes the 199th.
    expect(await debtsOf(t.store, rootId)).toEqual([
      { status: notes.at(-2)!.id, kind: 0, page: null, offset: 0, depth: 1, key: [2, 0, WALK_STATUSES - 1] },
    ]);
  });

  it("admits a remote reply whoever follows its author: an old and a new local follow, only an old one, or none", async () => {
    const { t, root } = await threadWorld();
    const note = mastodonNote(root);
    const rootId = await threadRoot(t, root, note);
    const authors = [];
    for (const name of ["carol", "erin", "frank"]) {
      const actor = await mastodonActor(t.web, name, { origin: OTHER_ORIGIN, key: 1 });
      await followed(t, actor, DAVE);
      authors.push(actor);
    }
    const replies = [];
    for (const actor of authors) {
      const reply = servedReply(t.web, actor, note.id);
      await storeReplies(t, actor, [{ note: reply, parentId: rootId }]);
      replies.push(reply);
    }
    // Local accepted follows: of carol, alice's before her reply and dave's after it; of erin, alice's before hers; of
    // frank, none.
    const ids = await Promise.all(authors.map(async (actor) => (await accountId(t.store, actor.uri))!));
    await sql(
      t.store,
      "DELETE FROM follows WHERE account_id = ? AND target_account_id IN (?, ?)",
      DAVE,
      ids[1]!,
      ids[2]!,
    );
    for (const target of [ids[0]!, ids[1]!]) {
      await sql(
        t.store,
        "INSERT INTO follows (account_id, target_account_id, state, created_at) VALUES (?, ?, 'accepted', ?)",
        ALICE,
        target,
        "2026-10-01T00:00:00.000Z",
      );
    }
    const follows = await sql<{ n: number }>(
      t.store,
      "SELECT count(*) AS n FROM follows WHERE target_account_id IN (?, ?, ?) GROUP BY target_account_id ORDER BY 1",
      ...ids,
    );
    expect(follows.map((row) => row.n)).toEqual([1, 2]);
    const fetched = await walkOnce(t, rootId, new Set(replies.map((r) => r.id)));
    expect(fetched.toSorted()).toEqual(replies.map((r) => r.id).toSorted());
  });

  it("scans every scan-due node of a full walk and owes what it cannot admit", async () => {
    const { t, root, bob } = await threadWorld();
    const note = mastodonNote(root);
    // The root lists its 199 stored replies (they fill the walk), each with a stored reply of its own.
    const listed = Array.from({ length: WALK_STATUSES - 1 }, () => servedReply(t.web, bob, note.id));
    const rootId = await threadRoot(t, root, note, { items: listed.map((n) => n.id) });
    const ids = await storeReplies(
      t,
      bob,
      listed.map((n) => ({ note: n, parentId: rootId })),
    );
    const below = listed.map((n) => servedReply(t.web, bob, n.id));
    await storeReplies(
      t,
      bob,
      below.map((n, i) => ({ note: n, parentId: ids[i]! })),
    );
    expect(await walkOnce(t, rootId, new Set(below.map((n) => n.id)))).toEqual([]);
    const debts = await debtsOf(t.store, rootId);
    expect(debts.map((d) => d.status)).toEqual(below.map((n) => n.id));
    expect(debts.every((d) => d.kind === 0 && d.depth === 2 && d.key[2] === 1)).toBe(true);
  });
});

describe("debts across walks (D12, Debts; Lanes and order)", () => {
  // T's collection read and empty; its 199 stored eligible replies, B the first by id, and U a stored eligible reply
  // to B, whose collection is `bShape` (read and empty when embedded).
  async function review(bShape: "embedded" | "first") {
    const { t, root, bob } = await threadWorld();
    const note = mastodonNote(root);
    const rootId = await threadRoot(t, root, note);
    const b = served(t.web, mastodonNote(bob, { inReplyTo: note.id }), { shape: bShape });
    const [bId] = await storeReplies(t, bob, [{ note: b, parentId: rootId, id: storedId(7000) }]);
    const siblings = await storedReplies(t, bob, rootId, note.id, WALK_STATUSES - 2, { at: 7001 });
    const u = servedReply(t.web, bob, b.id);
    await storeReplies(t, bob, [{ note: u, parentId: bId! }]);
    const watched = new Set([note.id, b.id, u.id]);
    return { t, rootId, note, b, u, siblings, watched };
  }

  it("owes U, which the walk's last scan finds, and fetches it before the root at the next walk (the review's case)", async () => {
    const { t, rootId, note, b, u, watched } = await review("embedded");
    expect(await walkOnce(t, rootId, watched)).toEqual([note.id, b.id]);
    expect(await debtsOf(t.store, rootId)).toEqual([
      expect.objectContaining({ status: u.id, kind: 0, depth: 2, key: [1, 1, 1] }),
    ]);
    // B as U's path, then U, then the root.
    expect(await walkOnce(t, rootId, watched)).toEqual([b.id, u.id, note.id]);
    expect((await debtsOf(t.store, rootId)).map((d) => d.status)).not.toContain(u.id);
    // Every second walk after: the walk B reads in owes U, the next fetches it.
    const later = [];
    for (let walk = 3; walk <= 8; walk++) {
      later.push(count(await walkOnce(t, rootId, watched), u.id));
    }
    expect(later).toEqual([0, 1, 0, 1, 0, 1]);
  });

  it("owes B's collection when its first page is fetched (not embedded), and reads it, then U, at the next walk", async () => {
    const { t, rootId, note, b, u, watched } = await review("first");
    expect(await walkOnce(t, rootId, watched)).toEqual([note.id, b.id]);
    expect(await debtsOf(t.store, rootId)).toEqual([
      { status: b.id, kind: 1, page: null, offset: 0, depth: 1, key: [1, 1, 0] },
    ]);
    expect(await walkOnce(t, rootId, watched)).toEqual([b.id, u.id, note.id]);
  });

  it("keys a debt by the owing node's seq, so U, found by B's scan, goes before the siblings' cut collections", async () => {
    const { t, root, bob } = await threadWorld();
    const note = mastodonNote(root);
    // T lists B; B's collection is empty and U is stored under B; T's 198 other stored replies each list an unstored
    // item, so each of their readings is cut. bob's only local follow predates them.
    const b = servedReply(t.web, bob, note.id);
    const rootId = await threadRoot(t, root, note, { items: [b.id] });
    const [bId] = await storeReplies(t, bob, [{ note: b, parentId: rootId, id: storedId(8000) }]);
    await storedReplies(t, bob, rootId, note.id, WALK_STATUSES - 2, {
      at: 8001,
      listing: () => ({ items: [`${OTHER_ORIGIN}/users/bob/statuses/unstored-${Math.random()}`] }),
    });
    const bobId = (await accountId(t.store, bob.uri))!;
    await sql(t.store, "UPDATE follows SET created_at = '2026-10-01T00:00:00.000Z' WHERE target_account_id = ?", bobId);
    const u = servedReply(t.web, bob, b.id);
    await storeReplies(t, bob, [{ note: u, parentId: bId! }]);
    const watched = new Set([u.id]);
    expect(await walkOnce(t, rootId, watched)).toEqual([]);
    const debts = await debtsOf(t.store, rootId);
    expect(debts[0]).toEqual({ status: u.id, kind: 0, page: null, offset: 0, depth: 2, key: [1, 1, 1] });
    expect(debts.slice(1).every((d) => d.kind === 1 && d.key[1] > 1)).toBe(true);
    expect(debts).toHaveLength(1 + WALK_STATUSES - 2);
    expect(await walkOnce(t, rootId, watched)).toEqual([u.id]);
  });

  it("puts what owed work admits in the owed lane: B1 > B2 > B3 > U, scanned or alternating listed links, U at walk 2", async () => {
    for (const alternating of [false, true]) {
      const { t, root, bob } = await threadWorld();
      const note = mastodonNote(root);
      const rootId = await threadRoot(t, root, note);
      // B1 the first of the root's 199 stored replies; B2 a stored reply of B1 (listed by it when alternating), B3 a
      // stored reply of B2, and U a reply of B3 (stored, or listed by B3 and unstored when alternating).
      const u = mastodonNote(bob, {});
      const b3 = mastodonNote(bob, {});
      const b2 = mastodonNote(bob, {});
      const b1 = served(t.web, mastodonNote(bob, { inReplyTo: note.id }), { items: alternating ? [b2.id] : [] });
      served(t.web, Object.assign(b2, { inReplyTo: b1.id }));
      served(t.web, Object.assign(b3, { inReplyTo: b2.id }), { items: alternating ? [u.id] : [] });
      served(t.web, Object.assign(u, { inReplyTo: b3.id }));
      const [b1Id] = await storeReplies(t, bob, [{ note: b1, parentId: rootId, id: storedId(9000) }]);
      await storedReplies(t, bob, rootId, note.id, WALK_STATUSES - 2, { at: 9001 });
      const [b2Id] = await storeReplies(t, bob, [{ note: b2, parentId: b1Id! }]);
      const [b3Id] = await storeReplies(t, bob, [{ note: b3, parentId: b2Id! }]);
      if (!alternating) {
        await storeReplies(t, bob, [{ note: u, parentId: b3Id! }]);
      }
      const watched = new Set([u.id]);
      expect(await walkOnce(t, rootId, watched), `alternating: ${alternating}`).toEqual([]);
      expect(await walkOnce(t, rootId, watched), `alternating: ${alternating}`).toEqual([u.id]);
    }
  });

  // T lists X and Y; X lists 1,000 unstored items, 20 a page; Y lists V.
  async function resuming() {
    const { t, root, bob } = await threadWorld();
    const note = mastodonNote(root);
    const items = Array.from({ length: 1000 }, (_, i) => servedReply(t.web, bob, `${OTHER_ORIGIN}/x-parent-${i}`));
    const x = servedReply(t.web, bob, note.id, { items: items.map((n) => n.id), page: 20 });
    const v = servedReply(t.web, bob, note.id);
    const y = servedReply(t.web, bob, note.id, { items: [v.id] });
    const rootId = await threadRoot(t, root, note, { items: [x.id, y.id] });
    return { t, rootId, x, y, v, items };
  }

  it(
    "resumes a cut collection at its place, and re-keys it behind earlier debts when cut again: V at walk 3",
    { timeout: 300_000 },
    async () => {
      const { t, rootId, x, y, v, items } = await resuming();
      const watched = new Set([v.id, ...items.map((n) => n.id)]);
      const fetched = new Set<string>();
      const vAt: number[] = [];
      const places: unknown[] = [];
      for (let walk = 1; walk <= 12; walk++) {
        const walked = await walkOnce(t, rootId, watched);
        expect(new Set(walked).size, `walk ${walk}: none twice`).toBe(walked.length);
        for (const uri of walked) {
          fetched.add(uri);
        }
        if (walked.includes(v.id)) {
          vAt.push(walk);
        }
        places.push((await debtsOf(t.store, rootId)).find((d) => d.status === x.id));
      }
      expect(vAt[0]).toBe(3);
      // The first walk cut X's reading on its tenth page, after 17 of its items: its debt names that page and place.
      expect(places[0]).toEqual({
        status: x.id,
        kind: 1,
        page: `${x.id}/replies?page=10`,
        offset: 17,
        depth: 1,
        key: [1, 1, 0],
      });
      expect(items.every((n) => fetched.has(n.id))).toBe(true);
      expect(y.id).toBeDefined();
    },
  );

  it("owes a cut collection: T lists A and X with 150 items each, W the last of X, fetched at walk 2", async () => {
    const { t, root, bob } = await threadWorld();
    const note = mastodonNote(root);
    const listed = (name: string) =>
      Array.from({ length: 150 }, (_, i) => servedReply(t.web, bob, `${OTHER_ORIGIN}/${name}-parent-${i}`));
    const aItems = listed("a");
    const xItems = listed("x");
    const a = servedReply(t.web, bob, note.id, { items: aItems.map((n) => n.id) });
    const x = servedReply(t.web, bob, note.id, { items: xItems.map((n) => n.id) });
    const rootId = await threadRoot(t, root, note, { items: [a.id, x.id] });
    const w = xItems.at(-1)!;
    expect(await walkOnce(t, rootId, new Set([w.id]))).toEqual([]);
    expect(await debtsOf(t.store, rootId)).toEqual([
      { status: x.id, kind: 1, page: null, offset: 47, depth: 1, key: [1, 2, 0] },
    ]);
    expect(await walkOnce(t, rootId, new Set([w.id]))).toEqual([w.id]);
  });

  it("pays U's row debt at its status stage and owes its cut collection anew, behind the first walk's debts", async () => {
    const { t, root, bob } = await threadWorld();
    const note = mastodonNote(root);
    const rootId = await threadRoot(t, root, note);
    // The review's case, U listing 300 unstored items and each sibling holding a stored reply of its own.
    const b = servedReply(t.web, bob, note.id);
    const [bId] = await storeReplies(t, bob, [{ note: b, parentId: rootId, id: storedId(9500) }]);
    const { ids } = await storedReplies(t, bob, rootId, note.id, WALK_STATUSES - 2, { at: 9501 });
    for (const id of ids) {
      await storedReplies(t, bob, id, "unused", 1, { serve: false });
    }
    const listed = Array.from({ length: 300 }, (_, i) => servedReply(t.web, bob, `${OTHER_ORIGIN}/u-parent-${i}`));
    const u = servedReply(t.web, bob, b.id, { items: listed.map((n) => n.id) });
    await storeReplies(t, bob, [{ note: u, parentId: bId! }]);
    await walkOnce(t, rootId, new Set());
    const first = await debtsOf(t.store, rootId);
    expect(first[0]).toEqual({ status: u.id, kind: 0, page: null, offset: 0, depth: 2, key: [1, 1, 1] });
    expect(first.length).toBeGreaterThan(1);
    await walkOnce(t, rootId, new Set());
    const second = await debtsOf(t.store, rootId);
    const owed = second.find((d) => d.status === u.id);
    expect(owed).toMatchObject({ kind: 1, page: null, depth: 2, key: [2, expect.any(Number), 0] });
    expect(owed!.offset).toBeGreaterThan(0);
    // Behind every debt of the first walk still held.
    const earlier = second.filter((d) => d.key[0] === 1);
    expect(earlier.length).toBeGreaterThan(0);
    expect(earlier.every((d) => second.indexOf(d) < second.indexOf(owed!))).toBe(true);
  });
});

describe("a debt's path and depth (D12, Applying a debt; Guarantees, Depth)", () => {
  // T > P1 > P2 > U, all stored and eligible; U owed to T as a row debt. P1 is served edited and lists X.
  async function pathed() {
    const { t, root, bob } = await threadWorld();
    const note = mastodonNote(root);
    const rootId = await threadRoot(t, root, note);
    const x = servedReply(t.web, bob, `${OTHER_ORIGIN}/x-parent`);
    const p1 = mastodonNote(bob, { inReplyTo: note.id });
    const p2 = servedReply(t.web, bob, p1.id);
    const u = servedReply(t.web, bob, p2.id);
    const [p1Id] = await storeReplies(t, bob, [{ note: p1, parentId: rootId }]);
    const [p2Id] = await storeReplies(t, bob, [{ note: p2, parentId: p1Id! }]);
    const [uId] = await storeReplies(t, bob, [{ note: u, parentId: p2Id! }]);
    const edited = "<p>edited</p>";
    served(
      t.web,
      { ...p1, content: edited, contentMap: { en: edited }, updated: "2026-10-11T18:00:00Z" },
      {
        items: [x.id],
      },
    );
    await owedDebt(t.store, rootId, uId!, { depth: 3, key: [1, 5, 1] });
    return { t, rootId, note, p1, p2, u, x, p2Id: p2Id!, uId: uId! };
  }

  it("records an owed status after its stored path, top-down, each fetched and refreshed first; a path node reads nothing", async () => {
    const { t, rootId, note, p1, p2, u, x } = await pathed();
    const fetched = await walkOnce(t, rootId, new Set([note.id, p1.id, p2.id, u.id, x.id]));
    expect(fetched).toEqual([p1.id, p2.id, u.id, note.id]);
    expect((await statusRow(t.store, p1.id))?.content).toBe("<p>edited</p>");
    expect(await debtsOf(t.store, rootId)).toEqual([]);
  });

  it("drops a debt whose path passes a withdrawn status, fetching none of it", async () => {
    const { t, rootId, note, p1, p2, u, p2Id } = await pathed();
    await sql(t.store, "UPDATE statuses SET withdrawn = 1 WHERE id = ?", p2Id);
    const fetched = await walkOnce(t, rootId, new Set([p1.id, p2.id, u.id]));
    expect(fetched).toEqual([p1.id]);
    expect(await debtsOf(t.store, rootId)).toEqual([]);
    expect(note.id).toBeDefined();
  });

  // A chain c1 > … > c`n` of stored eligible replies under T, each the first of its parent's replies.
  async function chain(n: number) {
    const { t, root, bob } = await threadWorld();
    const note = mastodonNote(root);
    const rootId = await threadRoot(t, root, note);
    const notes = [];
    const ids: string[] = [];
    let parent = { id: rootId, uri: note.id };
    for (let i = 0; i < n; i++) {
      const c = servedReply(t.web, bob, parent.uri);
      const [id] = await storeReplies(t, bob, [{ note: c, parentId: parent.id }]);
      notes.push(c);
      ids.push(id!);
      parent = { id: id!, uri: c.id };
    }
    return { t, rootId, note, notes, ids, bob };
  }

  it(
    "drops at a walk's first consideration a row debt deeper than WALK_STATUSES - 1, and a collection debt deeper than WALK_STATUSES - 2",
    { timeout: 120_000 },
    async () => {
      for (const kind of [0, 1]) {
        // c200 (a row debt) or c199 (a collection debt), owed at a depth a walk reaches: re-parented, its path is one
        // status longer than the walk's free slots less one (less two).
        const { t, rootId, note, notes, ids } = await chain(WALK_STATUSES - kind);
        await owedDebt(t.store, rootId, ids.at(-1)!, { kind, depth: WALK_STATUSES - 1 - kind, key: [1, 9, 1 - kind] });
        const steps = await walkSteps(t, rootId);
        // Dropped at the first consideration (a Store-only step): the root's status step follows, no path recorded.
        expect(steps.slice(0, 2), `kind ${kind}`).toEqual([
          { uri: "", stage: "store" },
          { uri: note.id, stage: "status" },
        ]);
        expect(
          (await debtsOf(t.store, rootId)).filter((d) => d.status === notes.at(-1)!.id),
          `kind ${kind}`,
        ).toEqual([]);
      }
    },
  );

  it("closes considering, the debt kept, when a deep debt is met later in a walk", { timeout: 120_000 }, async () => {
    const { t, rootId, note, notes, ids, bob } = await chain(WALK_STATUSES + 1);
    const s = servedReply(t.web, bob, note.id);
    const [sId] = await storeReplies(t, bob, [{ note: s, parentId: rootId }]);
    const q = servedReply(t.web, bob, note.id);
    const [qId] = await storeReplies(t, bob, [{ note: q, parentId: rootId }]);
    await owedDebt(t.store, rootId, sId!, { depth: 1, key: [1, 1, 1] });
    await owedDebt(t.store, rootId, ids.at(-1)!, { depth: WALK_STATUSES - 1, key: [1, 2, 1] });
    await owedDebt(t.store, rootId, qId!, { depth: 1, key: [1, 3, 1] });
    const steps = await walkSteps(t, rootId);
    // S recorded and fetched; the deep debt closes considering, so Q is not considered: the root's status step follows.
    expect(steps.slice(0, 3)).toEqual([
      { uri: s.id, stage: "status" },
      { uri: "", stage: "store" },
      { uri: "", stage: "store" },
    ]);
    expect(steps[3]).toEqual({ uri: note.id, stage: "status" });
    const debts = await debtsOf(t.store, rootId);
    expect(debts.find((d) => d.status === notes.at(-1)!.id)).toMatchObject({ key: [1, 2, 1] });
  });

  it(
    "applies and pays a row debt exactly WALK_STATUSES - 1 links deep, its path filling the walk",
    { timeout: 180_000 },
    async () => {
      const { t, root, bob } = await threadWorld();
      const note = mastodonNote(root);
      // T lists X and c1; each c lists the next, to c198, whose collection is empty; c199 is a stored eligible reply of
      // c198, so T's first walk holds T, X and c1 to c198, and c198's scan owes c199 at depth 199.
      const x = servedReply(t.web, bob, note.id);
      const cs: Note[] = [];
      for (let i = 0; i < WALK_STATUSES - 2; i++) {
        cs.push(mastodonNote(bob, { inReplyTo: i === 0 ? note.id : cs[i - 1]!.id }));
      }
      cs.forEach((c, i) => served(t.web, c, { items: i + 1 < cs.length ? [cs[i + 1]!.id] : [] }));
      const rootId = await threadRoot(t, root, note, { items: [x.id, cs[0]!.id] });
      const c199 = servedReply(t.web, bob, cs.at(-1)!.id);
      const watched = new Set([c199.id]);
      expect(await walkOnce(t, rootId, watched)).toEqual([]);
      const c198Id = (await statusRow(t.store, cs.at(-1)!.id))!.id;
      await storeReplies(t, bob, [{ note: c199, parentId: c198Id }]);
      expect(await walkOnce(t, rootId, watched)).toEqual([]);
      expect(await debtsOf(t.store, rootId)).toEqual([
        expect.objectContaining({ status: c199.id, kind: 0, depth: WALK_STATUSES - 1 }),
      ]);
      expect(await walkOnce(t, rootId, watched)).toEqual([c199.id]);
      expect((await debtsOf(t.store, rootId)).filter((d) => d.status === c199.id)).toEqual([]);
    },
  );

  it(
    "fetches no status more than WALK_STATUSES - 1 links below the root, and owes nothing for them (Mastodon fetches all)",
    { timeout: 300_000 },
    async () => {
      const { t, root, bob } = await threadWorld();
      const note = mastodonNote(root);
      // T > c1 > … > c201, each listed by its parent.
      const cs: Note[] = [];
      for (let i = 0; i < WALK_STATUSES + 1; i++) {
        cs.push(mastodonNote(bob, { inReplyTo: i === 0 ? note.id : cs[i - 1]!.id }));
      }
      cs.forEach((c, i) => served(t.web, c, { items: i + 1 < cs.length ? [cs[i + 1]!.id] : [] }));
      const rootId = await threadRoot(t, root, note, { items: [cs[0]!.id] });
      const deep = new Set([cs[199]!.id, cs[200]!.id]);
      const first = await walkOnce(t, rootId, new Set(cs.map((c) => c.id)));
      expect(first).toEqual(cs.slice(0, WALK_STATUSES - 1).map((c) => c.id));
      for (let walk = 2; walk <= 5; walk++) {
        expect((await walkOnce(t, rootId, deep)).length, `walk ${walk}`).toBe(0);
        expect(await debtsOf(t.store, rootId), `walk ${walk}`).toEqual([]);
      }
      // A walk of c2 reaches both.
      const c2Id = (await statusRow(t.store, cs[1]!.id))!.id;
      expect((await walkOnce(t, c2Id, deep)).toSorted()).toEqual([...deep].toSorted());
    },
  );
});

describe("payment and keys (D12, Debts; Keys)", () => {
  it(
    "pays a row debt at its status stage and a collection debt at its reading's end, drops an applied debt whose node ends invalid, keeps a passed one, and keeps a debt owed again",
    { timeout: 120_000 },
    async () => {
      const { t, root, bob } = await threadWorld();
      const note = mastodonNote(root);
      const rootId = await threadRoot(t, root, note);
      // Under T: B > U, X (answering 410), A > S, R (listing 3 unstored items), Q (listing 300), and V; A lists S, R
      // and Q.
      const b = servedReply(t.web, bob, note.id);
      const u = servedReply(t.web, bob, b.id);
      const x = mastodonNote(bob, { inReplyTo: note.id });
      t.web.fail(x.id, 410);
      const unstored = (name: string, n: number) =>
        Array.from({ length: n }, (_, i) => servedReply(t.web, bob, `${OTHER_ORIGIN}/${name}-parent-${i}`)).map(
          (item) => item.id,
        );
      const a = mastodonNote(bob, { inReplyTo: note.id });
      const s = servedReply(t.web, bob, a.id);
      const r = servedReply(t.web, bob, a.id, { items: unstored("r", 3) });
      const q = servedReply(t.web, bob, a.id, { items: unstored("q", 300) });
      served(t.web, a, { items: [s.id, r.id, q.id] });
      const v = servedReply(t.web, bob, note.id);
      const [bId, xId, aId, vId] = await storeReplies(
        t,
        bob,
        [b, x, a, v].map((n) => ({ note: n, parentId: rootId })),
      );
      const [uId] = await storeReplies(t, bob, [{ note: u, parentId: bId! }]);
      const [sId, rId, qId] = await storeReplies(
        t,
        bob,
        [s, r, q].map((n) => ({ note: n, parentId: aId! })),
      );
      // U's row debt (B its path), B's collection debt (B a path node then: passed), X's (applied: X ends invalid), A's
      // (applied: its reading ends), S's row debt and R's and Q's collection debts (A's reading admits all three first:
      // S's paid at its status stage, R's at the end of its reading from its start; Q's reading from its start is cut,
      // the debt kept), and V's row debt (T's scan owes it again when the walk is full).
      const debts: [string, Parameters<typeof owedDebt>[3]][] = [
        [uId!, { depth: 2, key: [1, 1, 1] }],
        [bId!, { kind: 1, offset: 3, depth: 1, key: [1, 2, 0] }],
        [xId!, { kind: 1, depth: 1, key: [1, 3, 0] }],
        [aId!, { kind: 1, depth: 1, key: [1, 4, 0] }],
        [sId!, { depth: 2, key: [1, 5, 1] }],
        [rId!, { kind: 1, offset: 2, depth: 2, key: [1, 6, 0] }],
        [qId!, { kind: 1, offset: 7, depth: 2, key: [1, 7, 0] }],
        [vId!, { depth: 1, key: [1, 8, 1] }],
      ];
      for (const [id, debt] of debts) {
        await owedDebt(t.store, rootId, id, debt);
      }
      const watched = new Set([note.id, b.id, u.id, x.id, a.id, s.id, r.id, q.id, v.id]);
      expect(await walkOnce(t, rootId, watched)).toEqual([b.id, u.id, x.id, a.id, s.id, r.id, q.id, note.id]);
      expect(await debtsOf(t.store, rootId)).toEqual([
        { status: b.id, kind: 1, page: null, offset: 3, depth: 1, key: [1, 2, 0] },
        { status: q.id, kind: 1, page: null, offset: 7, depth: 2, key: [1, 7, 0] },
        { status: v.id, kind: 0, page: null, offset: 0, depth: 1, key: [1, 8, 1] },
      ]);
    },
  );
});

describe("the hand-out's order (D12, Lanes and order)", () => {
  it("hands out owed work first, its scans before the next debt, the root's own applied debt in the owed lane, and the ordinary lane last", async () => {
    const { t, root, bob } = await threadWorld();
    const note = mastodonNote(root);
    // T lists L1, which lists L2. A (with A1, a stored reply of its own) is T's first stored reply by id, then 200
    // local replies, then B: T's scan examines A and 199 of them. Debts: A's row debt, T's own collection debt, B's row
    // debt.
    const l1 = mastodonNote(bob, { inReplyTo: note.id });
    const l2 = servedReply(t.web, bob, l1.id);
    served(t.web, l1, { items: [l2.id] });
    const rootId = await threadRoot(t, root, note, { items: [l1.id] });
    const a = servedReply(t.web, bob, note.id);
    const [aId] = await storeReplies(t, bob, [{ note: a, parentId: rootId, id: storedId(20_000) }]);
    const a1 = servedReply(t.web, bob, a.id);
    await storeReplies(t, bob, [{ note: a1, parentId: aId!, id: storedId(20_001) }]);
    await localReplies(t, rootId, note.id, REPLY_SCAN_ROWS, 20_002);
    const b = servedReply(t.web, bob, note.id);
    const [bId] = await storeReplies(t, bob, [{ note: b, parentId: rootId, id: storedId(20_500) }]);
    await owedDebt(t.store, rootId, aId!, { depth: 1, key: [1, 1, 1] });
    await owedDebt(t.store, rootId, rootId, { kind: 1, depth: 0, key: [1, 2, 0] });
    await owedDebt(t.store, rootId, bId!, { depth: 1, key: [1, 3, 1] });
    const status = (n: { id: string }) => ({ uri: n.id, stage: "status" });
    const store = { uri: "", stage: "store" };
    // A, then A's scan admitting A1 (owed), fetched; A1's scan; T's debt applied: T fetched in the owed lane, then its
    // items L1 and L2; the scans of T, L1 and L2; then B and its scan. Considering then closes, and no ordinary work
    // is left.
    expect(await walkSteps(t, rootId)).toEqual([
      status(a),
      status(a1),
      store,
      status(note),
      status(l1),
      status(l2),
      store,
      store,
      store,
      status(b),
      store,
    ]);
    expect(await debtsOf(t.store, rootId)).toEqual([]);
  });

  it("runs the root's status step once considering closes, its items' and a scan's admissions' before the next ordinary scan", async () => {
    const { t, root, bob } = await threadWorld();
    const note = mastodonNote(root);
    // T lists L1, which lists L2; A (owed) and S are T's stored replies; S lists S2 (unstored) and holds S1.
    const l1 = mastodonNote(bob, { inReplyTo: note.id });
    const l2 = servedReply(t.web, bob, l1.id);
    served(t.web, l1, { items: [l2.id] });
    const rootId = await threadRoot(t, root, note, { items: [l1.id] });
    const a = servedReply(t.web, bob, note.id);
    const s = mastodonNote(bob, { inReplyTo: note.id });
    const s2 = servedReply(t.web, bob, s.id);
    served(t.web, s, { items: [s2.id] });
    const [aId, sId] = await storeReplies(t, bob, [
      { note: a, parentId: rootId, id: storedId(21_000) },
      { note: s, parentId: rootId, id: storedId(21_001) },
    ]);
    const s1 = servedReply(t.web, bob, s.id);
    await storeReplies(t, bob, [{ note: s1, parentId: sId!, id: storedId(21_002) }]);
    await owedDebt(t.store, rootId, aId!, { depth: 1, key: [1, 1, 1] });
    const status = (n: { id: string }) => ({ uri: n.id, stage: "status" });
    const store = { uri: "", stage: "store" };
    // A and its scan; T, L1, L2; T's scan admits S, which is fetched and admits S2, fetched; the scans of L1 and L2;
    // S's scan admits S1, fetched; the scans of S2 and S1.
    expect(await walkSteps(t, rootId)).toEqual([
      status(a),
      store,
      status(note),
      status(l1),
      status(l2),
      status(s),
      status(s2),
      store,
      store,
      status(s1),
      store,
      store,
    ]);
  });
});

describe("what a walk scans (D12, Where a scan ends)", () => {
  it(
    "scans no node whose collection is absent or failed, and scans and owes one cut by WALK_PAGES with its place",
    { timeout: 120_000 },
    async () => {
      const { t, root, bob } = await threadWorld();
      const note = mastodonNote(root);
      // T lists A (no collection), F (a collection answering 404) and P, whose collection runs past WALK_PAGES empty
      // pages; each holds a stored eligible reply.
      const a = servedReply(t.web, bob, note.id, { shape: "absent" });
      const f = servedReply(t.web, bob, note.id, { shape: "failed" });
      const p = mastodonNote(bob, { inReplyTo: note.id });
      const collection = `${p.id}/replies`;
      for (let k = 1; k <= WALK_PAGES + 1; k++) {
        t.web.serve(pageUri(p, k), {
          "@context": AS,
          id: pageUri(p, k),
          type: "CollectionPage",
          partOf: collection,
          items: [],
          next: pageUri(p, k + 1),
        });
      }
      serveNote(t.web, { ...p, replies: { id: collection, type: "Collection", first: pageUri(p, 1) } });
      const rootId = await threadRoot(t, root, note, { items: [a.id, f.id, p.id] });
      const ids = await storeReplies(
        t,
        bob,
        [a, f, p].map((n) => ({ note: n, parentId: rootId })),
      );
      const below = [a, f, p].map((n) => servedReply(t.web, bob, n.id));
      await storeReplies(
        t,
        bob,
        below.map((n, i) => ({ note: n, parentId: ids[i]! })),
      );
      expect(await walkOnce(t, rootId, new Set(below.map((n) => n.id)))).toEqual([below[2]!.id]);
      // F's collection document took one of the walk's pages, P's the other 99: P's reading is cut before its 100th.
      expect(await debtsOf(t.store, rootId)).toEqual([
        { status: p.id, kind: 1, page: pageUri(p, WALK_PAGES), offset: 0, depth: 1, key: [1, 3, 0] },
      ]);
    },
  );

  it("scans nothing and owes nothing in a create walk", async () => {
    const { t, root, bob } = await threadWorld();
    const note = mastodonNote(root);
    // Replies A, of T, and R1, of R, arrive before their parents; T's Create links A and records a create walk of T's
    // collection, which lists R, a reply of T's author, unstored: the walk creates R, which links R1, and reads R's
    // collection, which lists R2, another.
    const r = mastodonNote(root, { inReplyTo: note.id });
    const r2 = servedReply(t.web, root, r.id);
    served(t.web, r, { items: [r2.id] });
    const [a, r1] = [servedReply(t.web, bob, note.id), servedReply(t.web, bob, r.id)];
    for (const reply of [a, r1]) {
      expect(await t.post(bob, create(bob, reply))).toBe(202);
    }
    const rootId = await threadRoot(t, root, note, { items: [r.id] });
    expect(await walkRow(t.store, rootId)).toMatchObject({ nodes: 2, finished_at: null });
    await walkRounds(t);
    const rId = (await statusRow(t.store, r.id))!.id;
    expect(await statusRow(t.store, r1.id)).toMatchObject({ in_reply_to_id: rId });
    expect(t.web.fetched).toContain(r2.id);
    expect(t.web.fetched).not.toContain(a.id);
    expect(t.web.fetched).not.toContain(r1.id);
    for (const id of [rootId, rId]) {
      expect(await cursorOf(t.store, id)).toBeNull();
    }
    expect(await sql(t.store, "SELECT count(*) AS n FROM reply_walk_debts")).toEqual([{ n: 0 }]);
  });
});

describe("owed work and the root (D12, Lanes and order; Guarantees)", () => {
  it(
    "fetches owed work before the root's status step: 99 items at walk 2, 198 at walk 3, all 199 at walk 4",
    { timeout: 600_000 },
    async () => {
      const { t, root, bob } = await threadWorld();
      const note = mastodonNote(root);
      // T's embedded page lists 199 children, each listing one unstored item.
      const children = Array.from({ length: WALK_STATUSES - 1 }, () => mastodonNote(bob, { inReplyTo: note.id }));
      const items = children.map((c) => servedReply(t.web, bob, c.id, { shape: "absent" }));
      children.forEach((c, i) => served(t.web, c, { items: [items[i]!.id] }));
      const rootId = await threadRoot(t, root, note, { items: children.map((c) => c.id) });
      const watched = new Set([note.id, ...children.map((c) => c.id), ...items.map((n) => n.id)]);
      expect(await walkOnce(t, rootId, watched)).toEqual([note.id, ...children.map((c) => c.id)]);
      expect(await debtsOf(t.store, rootId)).toEqual(
        children.map((c, i) => ({ status: c.id, kind: 1, page: null, offset: 0, depth: 1, key: [1, i + 1, 0] })),
      );
      const itemIds = new Set(items.map((n) => n.id));
      const seen = new Set<string>();
      const totals: number[] = [];
      for (let walk = 2; walk <= 4; walk++) {
        const fetched = await walkOnce(t, rootId, watched);
        if (walk === 2) {
          // Each owed child fetched once, under the root valid from the start, and its item before the next debt; T's
          // status step once considering closes (the 100th debt does not fit), then the child it admits.
          expect(fetched).toEqual([
            ...children.slice(0, 99).flatMap((c, i) => [c.id, items[i]!.id]),
            note.id,
            children[99]!.id,
          ]);
        }
        for (const uri of fetched.filter((url) => itemIds.has(url))) {
          seen.add(uri);
        }
        totals.push(seen.size);
      }
      expect(totals).toEqual([99, 198, 199]);
    },
  );

  it(
    "keeps the root's own debt, its key and place, at walks where the root answers 404, and goes on past it",
    { timeout: 300_000 },
    async () => {
      const { t, root, bob } = await threadWorld();
      const note = mastodonNote(root);
      // T's collection: a first page of 400 unstored items, with no next.
      const items = Array.from({ length: 400 }, (_, i) =>
        servedReply(t.web, bob, `${OTHER_ORIGIN}/t-parent-${i}`, { shape: "absent" }),
      );
      const listing = { items: items.map((n) => n.id), shape: "first" } as const;
      const rootId = await threadRoot(t, root, note, listing);
      await walkOnce(t, rootId, new Set());
      const own = { status: note.id, kind: 1, page: null, offset: 199, depth: 0, key: [1, 0, 0] };
      expect(await debtsOf(t.store, rootId)).toEqual([own]);
      // U, stored under B, under T, owed as a row debt.
      const b = servedReply(t.web, bob, note.id);
      const u = servedReply(t.web, bob, b.id);
      const [bId] = await storeReplies(t, bob, [{ note: b, parentId: rootId }]);
      const [uId] = await storeReplies(t, bob, [{ note: u, parentId: bId! }]);
      await owedDebt(t.store, rootId, uId!, { depth: 2, key: [1, 1, 1] });
      t.web.fail(note.id, 404);
      const watched = new Set([note.id, b.id, u.id]);
      // T's debt applied, its fetch 404: kept as it was; U's debt then applied and paid.
      expect(await walkOnce(t, rootId, watched)).toEqual([note.id, b.id, u.id]);
      expect(await debtsOf(t.store, rootId)).toEqual([own]);
      for (let walk = 3; walk <= 4; walk++) {
        expect(await walkOnce(t, rootId, watched), `walk ${walk}`).toEqual([note.id]);
        expect(await debtsOf(t.store, rootId), `walk ${walk}`).toEqual([own]);
      }
      expect(await sql(t.store, "SELECT withdrawn FROM statuses WHERE id = ?", rootId)).toEqual([{ withdrawn: 0 }]);
      // Served again, its first attempt answering 503: the second (T moved to the end of the walk, its seq 1) reads the
      // page from 199, and the debt is re-keyed at the place it is cut again; T's scan then owes B, the walk being
      // full.
      served(t.web, note, listing);
      let failing = true;
      const loader = {
        ...t.web.loader,
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = input instanceof Request ? input.url : String(input);
          if (failing && url === note.id) {
            failing = false;
            return new Response("unavailable", { status: 503 });
          }
          return t.web.fetch(input, init);
        }) as typeof fetch,
      };
      const fifth = await walkOnce(t, rootId, new Set([note.id, ...items.map((n) => n.id)]), loader);
      expect(failing).toBe(false);
      expect(fifth).toEqual([note.id, ...items.slice(199, 398).map((n) => n.id)]);
      expect(await debtsOf(t.store, rootId)).toEqual([
        { ...own, offset: 398, key: [2, 1, 0] },
        { status: b.id, kind: 0, page: null, offset: 0, depth: 1, key: [2, 1, 1] },
      ]);
    },
  );

  it("defers a node whose parent is no node yet, admits the parent from a scan, and reads the node's collection", async () => {
    const { t, root, bob } = await threadWorld();
    const note = mastodonNote(root);
    // T > P > S, stored; T lists S, not P; S lists U, unstored.
    const p = servedReply(t.web, bob, note.id);
    const s = mastodonNote(bob, { inReplyTo: p.id });
    const u = servedReply(t.web, bob, s.id);
    served(t.web, s, { items: [u.id] });
    const rootId = await threadRoot(t, root, note, { items: [s.id] });
    const [pId] = await storeReplies(t, bob, [{ note: p, parentId: rootId }]);
    await storeReplies(t, bob, [{ note: s, parentId: pId! }]);
    // S deferred on P; P admitted from T's scan and fetched; S again, its second attempt; U.
    expect(await walkOnce(t, rootId, new Set([note.id, p.id, s.id, u.id]))).toEqual([note.id, s.id, p.id, s.id, u.id]);
    expect(await statusRow(t.store, u.id)).toBeDefined();
    expect(await debtsOf(t.store, rootId)).toEqual([]);
  });
});

describe("the shared cursor (D12, What a scan examines)", () => {
  // T lists B; B's collection is empty; B holds 399 local replies, then U.
  async function alternating() {
    const { t, root, bob } = await threadWorld();
    const note = mastodonNote(root);
    const b = servedReply(t.web, bob, note.id);
    const rootId = await threadRoot(t, root, note, { items: [b.id] });
    const [bId] = await storeReplies(t, bob, [{ note: b, parentId: rootId }]);
    await localReplies(t, bId!, b.id, 2 * REPLY_SCAN_ROWS - 1, 22_000);
    const u = servedReply(t.web, bob, b.id);
    await storeReplies(t, bob, [{ note: u, parentId: bId!, id: storedId(22_000 + 2 * REPLY_SCAN_ROWS - 1) }]);
    return { t, rootId, bId: bId!, u };
  }

  it(
    "scans B from where the last scan of it ended, whichever root's walk: U at every walk of B, alternating",
    { timeout: 180_000 },
    async () => {
      const { t, rootId, bId, u } = await alternating();
      const fetched: number[] = [];
      const cursors: (string | null)[] = [];
      for (let walk = 1; walk <= 6; walk++) {
        fetched.push(count(await walkOnce(t, walk % 2 === 1 ? rootId : bId, new Set([u.id])), u.id));
        cursors.push(await cursorOf(t.store, bId));
      }
      expect(fetched).toEqual([0, 1, 0, 1, 0, 1]);
      // T's walks examine rows 1 to 200, B's 201 to 400.
      const [r200, r400] = [storedId(22_000 + REPLY_SCAN_ROWS - 1), storedId(22_000 + 2 * REPLY_SCAN_ROWS - 1)];
      expect(cursors).toEqual([r200, r400, r200, r400, r200, r400]);
    },
  );

  it("finds U at T's second walk with T walked alone", { timeout: 120_000 }, async () => {
    const { t, rootId, u } = await alternating();
    const watched = new Set([u.id]);
    expect(await walkOnce(t, rootId, watched)).toEqual([]);
    expect(await walkOnce(t, rootId, watched)).toEqual([u.id]);
  });

  it(
    "starts a scan at the cursor another walk left while this one ran, and owes only to the walk that could not admit",
    { timeout: 180_000 },
    async () => {
      const { t, root, bob } = await threadWorld();
      const note = mastodonNote(root);
      // T lists N and 198 items that answer 404 (its walk is full); N's collection is empty; N holds 450 replies, all
      // local but E1, E2 and E3, the 50th, 250th and 420th.
      const n = servedReply(t.web, bob, note.id);
      const fillers = Array.from({ length: WALK_STATUSES - 2 }, (_, i) => `${OTHER_ORIGIN}/gone/${i}`);
      const rootId = await threadRoot(t, root, note, { items: [n.id, ...fillers] });
      const [nId] = await storeReplies(t, bob, [{ note: n, parentId: rootId }]);
      const at = 23_000;
      const places = [50, 250, 420];
      const eligible = places.map(() => servedReply(t.web, bob, n.id));
      let from = 1;
      for (const [i, place] of places.entries()) {
        await localReplies(t, nId!, n.id, place - from, at + from);
        await storeReplies(t, bob, [{ note: eligible[i]!, parentId: nId!, id: storedId(at + place) }]);
        from = place + 1;
      }
      await localReplies(t, nId!, n.id, 450 - from + 1, at + from);
      const row = (k: number) => storedId(at + k);
      const watched = new Set(eligible.map((e) => e.id));
      // T's walk, held at its last item's fetch (before N's scan): N's walk runs whole meanwhile, examining rows 1 to
      // 200 and admitting E1.
      vi.setSystemTime(Date.now() + REPLIES_COOLDOWN_MS + 1);
      await startWalk(t.store, rootId, Date.now());
      const held = t.web.hold(fillers.at(-1)!);
      const before = t.web.fetched.length;
      const rounds = walkRounds(t, 2000);
      await held.reached;
      // At the same time (a walk's lease outlasts the hold), and N never refreshed before.
      await startWalk(t.store, nId!, Date.now());
      await walkRounds(t, 2000);
      expect(t.web.fetched.slice(before).filter((url) => watched.has(url))).toEqual([eligible[0]!.id]);
      expect(await cursorOf(t.store, nId!)).toBe(row(200));
      held.release();
      await rounds;
      // T's scan of N went on from row 201: E2 owed to T, which had no room; nothing owed to N.
      expect(t.web.fetched.slice(before).filter((url) => watched.has(url))).toEqual([eligible[0]!.id]);
      expect(await cursorOf(t.store, nId!)).toBe(row(400));
      expect(await debtsOf(t.store, rootId)).toEqual([
        { status: eligible[1]!.id, kind: 0, page: null, offset: 0, depth: 2, key: [1, 1, 50] },
      ]);
      // N's next walk: rows 401 to 450, then 1 to 150, admitting E3 and E1.
      expect((await walkOnce(t, nId!, watched)).toSorted()).toEqual([eligible[2]!.id, eligible[0]!.id].toSorted());
      expect(await cursorOf(t.store, nId!)).toBe(row(150));
      expect(await debtsOf(t.store, nId!)).toEqual([]);
    },
  );
});

describe("a reading resumed across walks (D12, Places; RepliesRead)", () => {
  it.each([
    ["one first page of 400 entries with no next", { count: 400, listing: { shape: "first" } as const }],
    [
      "a first page embedding next pages of 150, 150 and 150",
      { count: 450, listing: { shape: "chain", page: 150 } as const },
    ],
  ])(
    "reads %s over three walks, by raw position across the chain",
    { timeout: 180_000 },
    async (_name, { count: n, listing }) => {
      const { t, root, bob } = await threadWorld();
      const note = mastodonNote(root);
      const items = Array.from({ length: n }, (_, i) =>
        servedReply(t.web, bob, `${OTHER_ORIGIN}/c-parent-${i}`, { shape: "absent" }),
      );
      const rootId = await threadRoot(t, root, note, { ...listing, items: items.map((item) => item.id) });
      const watched = new Set(items.map((item) => item.id));
      const own = { status: note.id, kind: 1, page: null, depth: 0 };
      // Walk 1 takes entries 0 to 198 and owes the reading at 199 (the walk full); walk 2, resumed there, gets 200
      // entries ('more' past them) and owes it at 398; walk 3 reads the rest.
      expect(await walkOnce(t, rootId, watched)).toEqual(items.slice(0, 199).map((item) => item.id));
      expect(await debtsOf(t.store, rootId)).toEqual([{ ...own, offset: 199, key: [1, 0, 0] }]);
      expect(await walkOnce(t, rootId, watched)).toEqual(items.slice(199, 398).map((item) => item.id));
      expect(await debtsOf(t.store, rootId)).toEqual([{ ...own, offset: 398, key: [2, 0, 0] }]);
      expect(await walkOnce(t, rootId, watched)).toEqual(items.slice(398).map((item) => item.id));
      expect(await debtsOf(t.store, rootId)).toEqual([]);
    },
  );

  it.each([
    ["ten entries that are no ids first: the cut at raw position 150, and the resumed read from it", true],
    ["valid ids in their place: recorded, the cut at 140", false],
  ])("counts raw positions, %s", { timeout: 120_000 }, async (_name, invalid) => {
    const { t, root, bob } = await threadWorld();
    const note = mastodonNote(root);
    // T lists X and 58 items that answer 404: X's reading has room for 140. X's page holds 300 entries.
    const items = Array.from({ length: 300 }, (_, i) =>
      servedReply(t.web, bob, `${OTHER_ORIGIN}/x-parent-${i}`, { shape: "absent" }),
    );
    const notIds = [
      42,
      { type: "Note", content: "no id" },
      "data:text/plain,x",
      `${OTHER_ORIGIN}/${"a".repeat(4096)}`,
      true,
      "not a uri",
      "ftp://other.example/x",
      { id: 7 },
      [],
      "javascript:void(0)",
    ];
    const entries = items.map((item, i) => (invalid && i < notIds.length ? notIds[i] : item.id));
    const x = servedReply(t.web, bob, note.id, { items: entries });
    const fillers = Array.from({ length: 58 }, (_, i) => `${OTHER_ORIGIN}/gone/${i}`);
    const rootId = await threadRoot(t, root, note, { items: [x.id, ...fillers] });
    const watched = new Set(items.map((item) => item.id));
    const cut = invalid ? 150 : 140;
    expect(await walkOnce(t, rootId, watched)).toEqual(items.slice(invalid ? 10 : 0, cut).map((item) => item.id));
    expect((await debtsOf(t.store, rootId)).find((d) => d.status === x.id)).toEqual({
      status: x.id,
      kind: 1,
      page: null,
      offset: cut,
      depth: 1,
      key: [1, 1, 0],
    });
    expect(await walkOnce(t, rootId, watched)).toEqual(items.slice(cut).map((item) => item.id));
  });
});

describe("removals (D12, Totals; Removal)", () => {
  it(
    "owes a reply to one root at a time while its parent moves from root to root, each owing it at the same depth",
    { timeout: 600_000 },
    async () => {
      const { t, root, bob } = await threadWorld();
      // T1 to T6, each listing 198 items that answer 404, then C: a full walk. C holds 100 stored eligible replies.
      const fillers = Array.from({ length: WALK_STATUSES - 2 }, (_, i) => `${OTHER_ORIGIN}/gone/${i}`);
      const c = mastodonNote(bob, {});
      const roots: { id: string; uri: string }[] = [];
      for (let k = 0; k < 6; k++) {
        const note = mastodonNote(root);
        roots.push({ id: await threadRoot(t, root, note, { items: [...fillers, c.id] }), uri: note.id });
      }
      served(t.web, Object.assign(c, { inReplyTo: roots[0]!.uri }));
      const [cId] = await storeReplies(t, bob, [{ note: c, parentId: roots[0]!.id }]);
      const { ids } = await storedReplies(t, bob, cId!, c.id, 100);
      const statuses = async () => (await sql<{ n: number }>(t.store, "SELECT count(*) AS n FROM statuses"))[0]!.n;
      for (const [k, owner] of roots.entries()) {
        // C removed and stored again under T(k+1), its replies linked to it (as its 404's removal and a later Create
        // leave them, here in place).
        await sql(
          t.store,
          "UPDATE statuses SET in_reply_to_id = ?, in_reply_to_uri = ? WHERE id = ?",
          owner.id,
          owner.uri,
          cId!,
        );
        await walkOnce(t, owner.id, new Set());
        const named = await sql<{ root_id: string; depth: number; n: number }>(
          t.store,
          `SELECT root_id, depth, count(*) AS n FROM reply_walk_debts
					WHERE status_id IN (SELECT value FROM json_each(?)) GROUP BY root_id, depth`,
          JSON.stringify(ids),
        );
        expect(named, `T${k + 1}`).toEqual([{ root_id: owner.id, depth: 2, n: 100 }]);
        const total = (await sql<{ n: number }>(t.store, "SELECT count(*) AS n FROM reply_walk_debts"))[0]!.n;
        expect(total).toBeLessThanOrEqual(WALK_STATUSES * (await statuses()));
      }
      // T1's next walk holds no debt of them, and fetches none of them.
      const watched = new Set(
        await sql<{ uri: string }>(
          t.store,
          "SELECT uri FROM statuses WHERE id IN (SELECT value FROM json_each(?))",
          JSON.stringify(ids),
        ).then((rows) => rows.map((r) => r.uri)),
      );
      expect(await walkOnce(t, roots[0]!.id, watched)).toEqual([]);
    },
  );

  // T lists C, then items that answer 404; C lists one unstored item and holds 300 stored eligible replies.
  async function removing(fillers: number) {
    const { t, root, bob } = await threadWorld();
    const note = mastodonNote(root);
    const item = servedReply(t.web, bob, `${OTHER_ORIGIN}/i-parent`, { shape: "absent" });
    const c = servedReply(t.web, bob, note.id, { items: [item.id] });
    const gone = Array.from({ length: fillers }, (_, i) => `${OTHER_ORIGIN}/gone/${i}`);
    const rootId = await threadRoot(t, root, note, { items: [c.id, ...gone] });
    const [cId] = await storeReplies(t, bob, [{ note: c, parentId: rootId }]);
    await storedReplies(t, bob, cId!, c.id, 300, { at: 24_000, serve: false });
    return { t, rootId, cId: cId!, c, gone };
  }
  const withdraw = (t: Awaited<ReturnType<typeof removing>>["t"], id: string) =>
    sql(t.store, "UPDATE statuses SET withdrawn = 1 WHERE id = ?", id);

  it.each(["root", "status"] as const)(
    "owes no cut collection of a status whose %s's removal began during its fetch, and scans a removed status without a cursor",
    { timeout: 120_000 },
    async (which) => {
      const { t, rootId, cId, c } = await removing(WALK_STATUSES - 2);
      vi.setSystemTime(Date.now() + REPLIES_COOLDOWN_MS + 1);
      await startWalk(t.store, rootId, Date.now());
      const held = t.web.hold(c.id);
      const rounds = walkRounds(t, 2000);
      await held.reached;
      await withdraw(t, which === "root" ? rootId : cId);
      held.release();
      await rounds;
      const debts = await debtsOf(t.store, rootId);
      expect(debts.filter((d) => d.status === c.id)).toEqual([]);
      if (which === "status") {
        // The walk went on to C's scan: its rows owed (they are not being removed), no cursor for C.
        expect(debts).toHaveLength(REPLY_SCAN_ROWS);
        expect(await cursorOf(t.store, cId)).toBeNull();
      } else {
        expect(debts).toEqual([]);
      }
    },
  );

  it("owes nothing from a scan once its root's removal began in the scan's turn", { timeout: 120_000 }, async () => {
    // The last item answering 404 is a turn's fifth step; C's item, T's scan and C's scan follow it in that turn.
    const fillers = 195;
    expect((fillers + 2) % REPLY_STEPS_PER_WALK).toBe(5);
    const { t, rootId, cId, gone } = await removing(fillers);
    vi.setSystemTime(Date.now() + REPLIES_COOLDOWN_MS + 1);
    await startWalk(t.store, rootId, Date.now());
    const held = t.web.hold(gone.at(-1)!);
    const rounds = walkRounds(t, 2000);
    await held.reached;
    await withdraw(t, rootId);
    held.release();
    await rounds;
    // C's scan ran (its cursor moved past the 200 rows it examined) and owed none of the rows it had no room for.
    expect(await cursorOf(t.store, cId)).toBe(storedId(24_000 + REPLY_SCAN_ROWS - 1));
    expect(await debtsOf(t.store, rootId)).toEqual([]);
  });
});
