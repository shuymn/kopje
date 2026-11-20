import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Db } from "../src/db/sql";
import { HIDE_ROWS } from "../src/domain/remote-removal";
import { MAX_STATUS_MENTION_TAGS } from "../src/domain/remote-statuses";
import { DONE, PENDING } from "../src/domain/reply-walk-create";
import { COLLECTION_DEBT, debtEpoch, nextDebt, REPLY_SCAN_ROWS, scanWindow } from "../src/domain/reply-walk-debts";
import { REPLIES_COOLDOWN_MS } from "../src/domain/reply-walk-reads";
import { claimReplyWalk, WALK_PAGES, WALK_STATUSES } from "../src/domain/reply-walks";
import { MAX_STATUS_MEDIA, MAX_STATUS_MENTION_ROWS, MAX_STATUS_TAGS } from "../src/domain/status-bounds";
import { MAX_STATUS_EDITS } from "../src/domain/statuses";
import { REPLY_STEPS_PER_WALK, walkReplies } from "../src/federation/replies";
import { MAX_REMOTE_OPTIONS, MAX_TAGGED_COLLECTIONS } from "../src/platform/stored-bounds";
import { sql } from "./api-helpers";
import { inboxDeps } from "./app-helpers";
import { BUILD } from "./helpers";
import { type TestActor } from "./inbox-helpers";
import {
  accountId,
  ALICE,
  ALICE_URI,
  create,
  DAVE_URI,
  localStatus,
  mastodonNote,
  type Note,
  statusRow,
  token,
} from "./inbox-status-helpers";
import { plannedRun, plannedSql, type PlannedStatement, scansOf } from "./read-helpers";
import {
  bulkReplies,
  type MeasuredCall,
  measuringStore,
  OTHER_ORIGIN,
  owedDebt,
  served,
  servedReply,
  storedId,
  storeReplies,
  threadRoot,
  threadWorld,
} from "./reply-thread-helpers";
import { startWalk } from "./reply-walk-helpers";

// The bounds of a context walk's scans and debts (#1607 D12; domain/reply-walk-debts.ts, docs/threat-model.md RES-6):
// the rows a walk owes and changes at the caps, each scan in its own transaction and turn step, and the index reads of
// the new statements (the plan witnesses of the design's section 5). The Store's clock is the faked Date.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

const BULK = `${OTHER_ORIGIN}/users/bob/statuses/bulk-`;

// A context walk of the root started past its cooldown, run to its end over a measuring Store: its calls, and the
// requests the fake fetch saw.
async function measuredWalk(t: Awaited<ReturnType<typeof threadWorld>>["t"], rootId: string) {
  vi.setSystemTime(Date.now() + REPLIES_COOLDOWN_MS + 1);
  await startWalk(t.store, rootId, Date.now());
  const measuring = measuringStore(t);
  const deps = inboxDeps(() => measuring.stub, t.web.loader);
  const before = t.web.fetched.length;
  for (let round = 0; await walkReplies(t.env, deps); round++) {
    expect(round).toBeLessThan(500);
  }
  // The statuses' documents fetched (authors' documents refreshed past their age aside).
  return { calls: measuring.calls, requests: t.web.fetched.slice(before).filter((url) => url.includes("/statuses/")) };
}

// The calls by turn: a claim starts one, its completions follow.
function turnsOf(calls: readonly MeasuredCall[]): MeasuredCall[][] {
  const turns: MeasuredCall[][] = [];
  for (const call of calls) {
    if (call.name === "claim") {
      turns.push([]);
    }
    turns.at(-1)!.push(call);
  }
  return turns;
}

const debtCount = async (t: Awaited<ReturnType<typeof threadWorld>>["t"], rootId: string) =>
  (await sql<{ n: number }>(t.store, "SELECT count(*) AS n FROM reply_walk_debts WHERE root_id = ?", rootId))[0]!.n;

// Another root holding a debt at every status and depth of `rows` (status id, depth), each a row debt.
async function otherRootDebts(t: Awaited<ReturnType<typeof threadWorld>>["t"], other: string, select: string) {
  await sql(
    t.store,
    `INSERT INTO reply_walk_debts (root_id, status_id, kind, owed_walk, owed_seq, owed_pos, depth)
		SELECT ?1, id, 0, 1, (rn - 1) / 200, (rn - 1) % 200 + 1, depth
		FROM (SELECT id, depth, row_number() OVER (ORDER BY id) AS rn FROM (${select}))`,
    other,
  );
}

describe("the debts a walk writes (D12, Bounds: 40,000 inserts, 81,000 changes)", () => {
  // T lists its 199 stored replies, which fill the walk; T and each of them hold 200 stored eligible replies of bob in
  // their scan windows (T's with ids below its listed replies').
  async function crowded() {
    const { t, root, bob } = await threadWorld();
    const bobId = (await accountId(t.store, bob.uri))!;
    const note = mastodonNote(root);
    const items = Array.from({ length: WALK_STATUSES - 1 }, () => servedReply(t.web, bob, note.id));
    const rootId = await threadRoot(t, root, note, { items: items.map((n) => n.id) });
    await bulkReplies(t, rootId, note.id, REPLY_SCAN_ROWS, 30_000, { account: bobId, prefix: BULK });
    const itemIds = await storeReplies(
      t,
      bob,
      items.map((n, i) => ({ note: n, parentId: rootId, id: storedId(40_000 + i) })),
    );
    for (const [k, id] of itemIds.entries()) {
      await bulkReplies(t, id, items[k]!.id, REPLY_SCAN_ROWS, 100_000 + k * REPLY_SCAN_ROWS, {
        account: bobId,
        prefix: BULK,
      });
    }
    return { t, root, rootId };
  }

  it(
    "owes exactly 40,000 row debts over 200 scans, each its own step of at most 200 inserts, no request for them",
    { timeout: 600_000 },
    async () => {
      const { t, rootId } = await crowded();
      const { calls, requests } = await measuredWalk(t, rootId);
      // T and its 199 replies: the scans and the considerations made none.
      expect(requests).toHaveLength(WALK_STATUSES);
      expect(requests.filter((url) => url.startsWith(BULK))).toEqual([]);
      const scans = calls.filter((call) => call.owed > 0);
      expect(scans).toHaveLength(WALK_STATUSES);
      expect(scans.every((call) => call.owed === REPLY_SCAN_ROWS)).toBe(true);
      expect(await debtCount(t, rootId)).toBe(WALK_STATUSES * REPLY_SCAN_ROWS);
      for (const turn of turnsOf(calls)) {
        expect(turn.filter((call) => call.name === "complete" && !call.retried).length).toBeLessThanOrEqual(
          REPLY_STEPS_PER_WALK,
        );
      }
    },
  );

  it(
    "changes 80,000 debt rows when another root holds a debt at every status and depth it owes, at most 3,200 a turn",
    { timeout: 600_000 },
    async () => {
      const { t, root, rootId } = await crowded();
      const other = await threadRoot(t, root, mastodonNote(root));
      await otherRootDebts(
        t,
        other,
        `SELECT id, CASE WHEN in_reply_to_id = '${rootId}' THEN 1 ELSE 2 END AS depth FROM statuses
				WHERE uri LIKE '${BULK}%'`,
      );
      expect(await debtCount(t, other)).toBe(WALK_STATUSES * REPLY_SCAN_ROWS);
      const { calls } = await measuredWalk(t, rootId);
      expect(calls.reduce((sum, call) => sum + call.debts, 0)).toBe(2 * WALK_STATUSES * REPLY_SCAN_ROWS);
      for (const turn of turnsOf(calls)) {
        expect(turn.reduce((sum, call) => sum + call.debts, 0)).toBeLessThanOrEqual(
          REPLY_STEPS_PER_WALK * 2 * REPLY_SCAN_ROWS,
        );
      }
      // A scan run by a Store-only step's completion: the node's flag, ≤ 200 replacement deletes and 200 inserts, its
      // cursor, the walk's counters and the next node's charge (or none, for another Store-only step).
      const scans = calls.filter((call) => call.stage === "store" && call.owed > 0);
      expect(scans.length).toBeGreaterThan(0);
      for (const call of scans) {
        expect(call.changes).toBeLessThanOrEqual(1 + 2 * REPLY_SCAN_ROWS + 1 + 1 + 1);
      }
      expect(await debtCount(t, rootId)).toBe(WALK_STATUSES * REPLY_SCAN_ROWS);
      expect(await debtCount(t, other)).toBe(0);
    },
  );

  it("changes 80,198 debt rows in a thread of cut collections, within 81,000", { timeout: 600_000 }, async () => {
    const { t, root, bob } = await threadWorld();
    const bobId = (await accountId(t.store, bob.uri))!;
    const note = mastodonNote(root);
    // T lists P; P lists 199 stored children, of which the walk takes 198 (its reading cut); each child lists one
    // unstored item (each reading cut). T, P and the 198 hold 200 eligible stored replies each in their windows.
    const p = mastodonNote(bob, { inReplyTo: note.id });
    const children = Array.from({ length: WALK_STATUSES - 1 }, () => mastodonNote(bob, { inReplyTo: p.id }));
    children.forEach((c, i) => served(t.web, c, { items: [`${OTHER_ORIGIN}/unstored/${i}`] }));
    served(t.web, p, { items: children.map((c) => c.id) });
    const rootId = await threadRoot(t, root, note, { items: [p.id] });
    const [pId] = await storeReplies(t, bob, [{ note: p, parentId: rootId, id: storedId(50_000) }]);
    const childIds = await storeReplies(
      t,
      bob,
      children.map((c, i) => ({ note: c, parentId: pId!, id: storedId(50_001 + i) })),
    );
    await bulkReplies(t, rootId, note.id, REPLY_SCAN_ROWS, 45_000, { account: bobId, prefix: BULK });
    await bulkReplies(t, pId!, p.id, REPLY_SCAN_ROWS, 49_000, { account: bobId, prefix: BULK });
    for (const [k, id] of childIds.slice(0, WALK_STATUSES - 2).entries()) {
      await bulkReplies(t, id, children[k]!.id, REPLY_SCAN_ROWS, 100_000 + k * REPLY_SCAN_ROWS, {
        account: bobId,
        prefix: BULK,
      });
    }
    // Another root holds a debt at every status and depth the walk owes but T's scan's rows: P's (depth 1) and the
    // 198 children's (2) collections, P's rows (2) and the children's (3).
    const other = await threadRoot(t, root, mastodonNote(root));
    const taken = JSON.stringify(childIds.slice(0, WALK_STATUSES - 2));
    await otherRootDebts(
      t,
      other,
      `SELECT '${pId}' AS id, 1 AS depth
				UNION ALL SELECT value, 2 FROM json_each('${taken}')
				UNION ALL SELECT id, 2 FROM statuses WHERE in_reply_to_id = '${pId}' AND uri LIKE '${BULK}%'
				UNION ALL SELECT id, 3 FROM statuses WHERE in_reply_to_id IN (SELECT value FROM json_each('${taken}'))`,
    );
    const { calls } = await measuredWalk(t, rootId);
    const changes = calls.reduce((sum, call) => sum + call.debts, 0);
    // Row debts: T's 200 inserted, P's and the children's 39,800 each after a replacement delete; collection debts:
    // P's and the 198 children's, 199, each after one.
    expect(changes).toBe(REPLY_SCAN_ROWS + 2 * (WALK_STATUSES - 1) * REPLY_SCAN_ROWS + 2 * (WALK_STATUSES - 1));
    expect(changes).toBe(80_198);
    expect(changes).toBeLessThanOrEqual(81_000);
    const kinds = await sql<{ kind: number; n: number }>(
      t.store,
      "SELECT kind, count(*) AS n FROM reply_walk_debts WHERE root_id = ? GROUP BY kind ORDER BY kind",
      rootId,
    );
    expect(kinds).toEqual([
      { kind: 0, n: WALK_STATUSES * REPLY_SCAN_ROWS },
      { kind: COLLECTION_DEBT, n: WALK_STATUSES - 1 },
    ]);
    expect(await debtCount(t, other)).toBe(0);
  });
});

describe("a hand-out's rows at the caps (D12, Bounds)", () => {
  it("records a 197-status path and the owed status in one consideration, within WALK_STATUSES + 2 rows", async () => {
    const { t, root, bob } = await threadWorld();
    const bobId = (await accountId(t.store, bob.uri))!;
    const note = mastodonNote(root);
    const rootId = await threadRoot(t, root, note);
    // c1 > … > c198 under T, stored; c198 owed at depth 198.
    await sql(
      t.store,
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 197)
			INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, in_reply_to_id, in_reply_to_uri)
			SELECT printf('1%017d', 70000 + i), ?1 || (70000 + i), ?2, 'public', '<p>c</p>', '2026-10-11T12:00:00.000Z',
				CASE WHEN i = 0 THEN ?3 ELSE printf('1%017d', 69999 + i) END,
				CASE WHEN i = 0 THEN ?4 ELSE ?1 || (69999 + i) END FROM n`,
      BULK,
      bobId,
      rootId,
      note.id,
    );
    await sql(
      t.store,
      `INSERT INTO reply_walk_debts (root_id, status_id, kind, owed_walk, owed_seq, owed_pos, depth)
			VALUES (?, ?, 0, 1, 1, 1, 198)`,
      rootId,
      storedId(70_197),
    );
    vi.setSystemTime(Date.now() + REPLIES_COOLDOWN_MS + 1);
    await startWalk(t.store, rootId, Date.now());
    const measuring = measuringStore(t);
    const claim = await measuring.stub.claimReplyWalk(BUILD);
    expect(claim).toMatchObject({ step: { uri: `${BULK}70000`, stage: "status" } });
    // The claim's token; 197 path nodes and the owed status recorded; the first charged; the walk's counters.
    expect(measuring.calls).toEqual([
      {
        name: "claim",
        stage: null,
        uri: null,
        retried: false,
        changes: 1 + (WALK_STATUSES - 3) + 1 + 1 + 1,
        tables: { reply_walks: 1 + 1, reply_walk_nodes: WALK_STATUSES - 3 + 1 + 1 },
        debts: 0,
        owed: 0,
      },
    ]);
    expect(measuring.calls[0]!.changes).toBeLessThanOrEqual(WALK_STATUSES + 2);
  });

  it("ends 199 nodes at spent WALK_PAGES in one hand-out, owing each its collection debt within 3 rows a node", async () => {
    const { t, root, bob } = await threadWorld();
    const bobId = (await accountId(t.store, bob.uri))!;
    const note = mastodonNote(root);
    const rootId = await threadRoot(t, root, note);
    await bulkReplies(t, rootId, note.id, WALK_STATUSES - 1, 80_000, { account: bobId, prefix: BULK });
    const other = await threadRoot(t, root, mastodonNote(root));
    await otherRootDebts(t, other, `SELECT id, 1 AS depth FROM statuses WHERE in_reply_to_id = '${rootId}'`);
    vi.setSystemTime(Date.now() + REPLIES_COOLDOWN_MS + 1);
    await startWalk(t.store, rootId, Date.now());
    // The walk's pages spent, its 199 nodes pending at a page of their collections, 5 entries in.
    await sql(
      t.store,
      "UPDATE reply_walks SET pages = ?2, nodes = ?3, next_seq = ?3 WHERE status_id = ?1",
      rootId,
      WALK_PAGES,
      WALK_STATUSES,
    );
    await sql(t.store, `UPDATE reply_walk_nodes SET state = ${DONE} WHERE status_id = ?`, rootId);
    await sql(
      t.store,
      `INSERT INTO reply_walk_nodes (status_id, uri, seq, state, stage, valid, depth, fetch, skip, resume_page)
			SELECT ?1, uri, row_number() OVER (ORDER BY id), ${PENDING}, 2, 1, 1, uri || '/replies?page=2', 5,
				uri || '/replies?page=2'
			FROM statuses WHERE in_reply_to_id = ?1`,
      rootId,
    );
    const measuring = measuringStore(t);
    await measuring.stub.claimReplyWalk(BUILD);
    const [call] = measuring.calls;
    // Each node ended (scan-due) and owed after one replacement delete; then the first one's scan, and the walk.
    expect(call!.debts).toBe(2 * (WALK_STATUSES - 1));
    expect(call!.changes).toBeLessThanOrEqual(1 + 3 * (WALK_STATUSES - 1) + 1 + 1);
    const debts = await sql<{ n: number; page: string }>(
      t.store,
      `SELECT count(*) AS n, min(page_offset) AS low, max(page_offset) AS high FROM reply_walk_debts
				WHERE root_id = ? AND kind = 1 AND page LIKE '%/replies?page=2'`,
      rootId,
    );
    expect(debts).toEqual([{ n: WALK_STATUSES - 1, low: 5, high: 5 }]);
    expect(await debtCount(t, other)).toBe(0);
  });
});

describe("the plans of the scans and debts (D12, section 5)", () => {
  it("reads at most REPLY_SCAN_ROWS index entries and their rows a scan, past 1,000 replies outside the index", async () => {
    const { t, root } = await threadWorld();
    const note = mastodonNote(root);
    const rootId = await threadRoot(t, root, note);
    // 1,000 followers-only replies first in id order, then 450 public ones.
    await bulkReplies(t, rootId, note.id, 1000, 90_000);
    await sql(t.store, "UPDATE statuses SET visibility = 'private' WHERE in_reply_to_id = ?", rootId);
    await bulkReplies(t, rootId, note.id, 450, 91_000);
    const measure = (cursor: string | null) =>
      runInDurableObject(t.store, (_instance, state) => {
        const sqlStorage = state.storage.sql;
        sqlStorage.exec("DELETE FROM reply_walk_cursors");
        if (cursor !== null) {
          sqlStorage.exec("INSERT INTO reply_walk_cursors (status_id, after_id) VALUES (?, ?)", rootId, cursor);
        }
        const plans: PlannedStatement[] = [];
        const rows = scanWindow(
          new Db(plannedSql(sqlStorage, /statuses_public_replies/, plans)),
          rootId,
          "2026-10-12T00:00:00.000Z",
        );
        return { rows: rows.length, read: plans.reduce((sum, plan) => sum + plan.rows, 0), plans: plans.length };
      });
    const cursors = [null, storedId(91_199), storedId(91_439)];
    const before = await Promise.all(cursors.map(measure));
    await sql(t.store, "ANALYZE");
    const after = await Promise.all(cursors.map(measure));
    for (const result of [...before, ...after]) {
      expect(result.rows).toBe(REPLY_SCAN_ROWS);
      // Each row an index entry and its table row, both range reads together.
      expect(result.read).toBeLessThanOrEqual(2 * REPLY_SCAN_ROWS);
    }
    // At the end, the scan wraps: two range reads.
    expect(before.map((result) => result.plans)).toEqual([1, 1, 2]);
  });

  // T's walk with T's reading ended (its node done and scan-due) and REPLY_SCAN_ROWS stored eligible replies of bob in
  // its window: the claim's hand-out runs T's scan, which examines every row through the three lookups of an eligible
  // one (the walk's node; the status, its account and local account; its walk as a root), admits 199 and owes one.
  it("examines each scanned row with at most six key reads, in one scan of REPLY_SCAN_ROWS rows a hand-out", async () => {
    const { t, root, bob } = await threadWorld();
    const note = mastodonNote(root);
    const rootId = await threadRoot(t, root, note);
    await bulkReplies(t, rootId, note.id, REPLY_SCAN_ROWS, 95_000, {
      account: (await accountId(t.store, bob.uri))!,
      prefix: BULK,
    });
    vi.setSystemTime(Date.now() + REPLIES_COOLDOWN_MS + 1);
    await startWalk(t.store, rootId, Date.now());
    await sql(t.store, `UPDATE reply_walk_nodes SET state = ${DONE}, scan_due = 1 WHERE status_id = ?`, rootId);
    const lookups =
      /FROM reply_walk_nodes WHERE status_id = \? AND uri = \?|SELECT s\.uri, s\.in_reply_to_id AS parent|WHERE s\.id = \?1 AND EXISTS \(SELECT 1 FROM reply_walks/;
    const { plans } = await plannedRun(
      t,
      new RegExp(`${lookups.source}|statuses_public_replies`),
      claimReplyWalk,
      {
        now: Date.now(),
      },
      true,
    );
    const window = plans.filter((plan) => plan.query.includes("statuses_public_replies"));
    const rows = plans.filter((plan) => !plan.query.includes("statuses_public_replies"));
    // One scan: its window's one range read; each row three lookups of six key searches in all, none a scan (and the
    // scan-due node's own row, read once).
    expect(window).toHaveLength(1);
    expect(rows).toHaveLength(3 * REPLY_SCAN_ROWS + 1);
    const searches = rows.flatMap((plan) =>
      plan.plan.filter((detail) => /^SEARCH \S+ (?:EXISTS )?USING .*=\?/.test(detail)),
    );
    expect(searches).toHaveLength(6 * REPLY_SCAN_ROWS + 1);
    for (const plan of rows) {
      expect(scansOf(plan.plan, ["reply_walk_nodes", "s", "a", "l", "w"]), plan.query).toEqual([]);
    }
    expect(await debtCount(t, rootId)).toBe(1);
  });

  it("finds a root's epoch and next debt reading one index entry and its row, among 3,000 debts of 7 roots", async () => {
    const { t, root } = await threadWorld();
    const roots: string[] = [];
    for (let k = 0; k < 7; k++) {
      roots.push(await threadRoot(t, root, mastodonNote(root)));
    }
    await bulkReplies(t, roots[0]!, "https://mastodon.example/x", 3000, 95_000);
    await sql(
      t.store,
      `INSERT INTO reply_walk_debts (root_id, status_id, kind, owed_walk, owed_seq, owed_pos, depth)
			SELECT CASE WHEN rn <= 450 THEN ?1 ELSE json_extract(?2, '$[' || (rn % 6) || ']') END, id, 0, 1,
				(rn - 1) / 200, (rn - 1) % 200 + 1, 1
			FROM (SELECT id, row_number() OVER (ORDER BY id) AS rn FROM statuses WHERE in_reply_to_id = ?1)`,
      roots[0]!,
      JSON.stringify(roots.slice(1)),
    );
    expect(await debtCount(t, roots[0]!)).toBe(450);
    await sql(t.store, "ANALYZE");
    const keys = [null, { walk: 1, seq: 1, pos: 25 }, { walk: 1, seq: 2, pos: 50 }];
    const read = await runInDurableObject(t.store, (_instance, state) => {
      const plans: PlannedStatement[] = [];
      const db = new Db(plannedSql(state.storage.sql, /reply_walk_debts/, plans));
      const found = keys.map((key) => nextDebt(db, roots[0]!, key)?.key ?? null);
      const epoch = debtEpoch(db, roots[0]!);
      return { found, epoch, rows: plans.map((plan) => plan.rows), plans: plans.map((plan) => plan.plan.join(" | ")) };
    });
    expect(read.found).toEqual([{ walk: 1, seq: 0, pos: 1 }, { walk: 1, seq: 1, pos: 26 }, null]);
    expect(read.epoch).toBe(2);
    for (const rows of read.rows) {
      expect(rows).toBeLessThanOrEqual(2);
    }
    // Each seeks reply_walk_debts_order in key order: no sort of the root's debts.
    for (const plan of read.plans) {
      expect(plan).toMatch(/USING (COVERING )?INDEX reply_walk_debts_order/);
      expect(plan).not.toMatch(/TEMP B-TREE/);
    }
  });

  it.each(["an owed node pending", "an owed node scan-due"] as const)(
    "seeks %s reading one index entry, among 199 of the walk and 3,000 of other walks",
    async (which) => {
      const { t, root } = await threadWorld();
      const rootId = await threadRoot(t, root, mastodonNote(root));
      vi.setSystemTime(Date.now() + REPLIES_COOLDOWN_MS + 1);
      await startWalk(t.store, rootId, Date.now());
      await sql(t.store, "UPDATE reply_walks SET nodes = 200, next_seq = 201 WHERE status_id = ?", rootId);
      await sql(
        t.store,
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 199)
				INSERT INTO reply_walk_nodes (status_id, uri, seq, state, valid, depth, lane, scan_due)
				SELECT ?1, ?2 || i, i, ${DONE}, 1, 1, 1, ?3 FROM n`,
        rootId,
        `${OTHER_ORIGIN}/o/`,
        which === "an owed node scan-due" ? 1 : 0,
      );
      if (which === "an owed node pending") {
        await sql(
          t.store,
          `INSERT INTO reply_walk_nodes (status_id, uri, seq, state, lane) VALUES (?, ?, 200, ${PENDING}, 1)`,
          rootId,
          `${OTHER_ORIGIN}/o/pending`,
        );
      }
      await sql(t.store, "ANALYZE");
      // 15 other walks of 200 nodes each, owed and scan-due, half pending.
      await sql(
        t.store,
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 15)
				INSERT INTO reply_walks (status_id, kind, refresh_id, queued_at, due_at, finished_at)
				SELECT printf('8%017d', i), 0, printf('f%031x', i), 0, NULL, 1 FROM n`,
      );
      await sql(
        t.store,
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 2999)
				INSERT INTO reply_walk_nodes (status_id, uri, seq, state, valid, lane, scan_due)
				SELECT printf('8%017d', 1 + i / 200), ?1 || i, i % 200, CASE WHEN i % 2 = 0 THEN ${PENDING} ELSE ${DONE} END,
					CASE WHEN i % 2 = 0 THEN 0 ELSE 1 END, 1, i % 2 FROM n`,
        `${OTHER_ORIGIN}/other/`,
      );
      const claimed = await plannedRun(t, /reply_walk_nodes_(owed|scan)/, claimReplyWalk, { now: Date.now() }, true);
      expect(claimed.result).toMatchObject(
        which === "an owed node pending"
          ? { step: { uri: `${OTHER_ORIGIN}/o/pending`, stage: "status" } }
          : { step: { stage: "store" } },
      );
      const seeks = claimed.plans.filter((plan) =>
        new RegExp(`reply_walk_nodes_${which === "an owed node pending" ? "owed" : "scan"}`).test(plan.query),
      );
      expect(seeks.length).toBeGreaterThan(0);
      for (const plan of seeks) {
        expect(plan.rows, plan.query).toBeLessThanOrEqual(2);
      }
    },
  );
});

describe("a walk completion's rows at the caps (D12, Bounds: a walk completion's rows)", () => {
  type T = Awaited<ReturnType<typeof threadWorld>>["t"];

  // `count` remote accounts on other.example from `from` on, which statuses address and mention; their URIs.
  async function remoteAccounts(t: T, count: number, from: number) {
    await sql(
      t.store,
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
			INSERT INTO accounts (id, uri, username, domain)
			SELECT printf('3%017d', CAST(?2 AS INTEGER) + i), ?3 || (CAST(?2 AS INTEGER) + i),
				'm' || (CAST(?2 AS INTEGER) + i), 'other.example' FROM n`,
      count,
      from,
      `${OTHER_ORIGIN}/users/m`,
    );
    return Array.from({ length: count }, (_, i) => `${OTHER_ORIGIN}/users/m${from + i}`);
  }

  // bob's collection i of version k, which Kopje stores.
  const collectionUri = (bob: TestActor, k: number, i: number) => `${bob.uri}/collections/v${k}c${i}`;

  // Version k of bob's reply S at every cap updateRemoteStatus writes, all of it new at each version:
  // MAX_STATUS_TAGS hashtags, MAX_STATUS_MEDIA attachments, a poll of MAX_REMOTE_OPTIONS choices, a link (its card),
  // MAX_STATUS_MENTION_TAGS mentions, the local `local` first, and `accounts` with it in cc, past
  // MAX_STATUS_MENTION_ROWS, and MAX_TAGGED_COLLECTIONS collections of bob's that Kopje stores.
  function version(bob: TestActor, base: Note, k: number, local: string, accounts: readonly string[]): Note {
    const content = `<p>version ${k} <a href="https://cards.example/v${k}">a link</a></p>`;
    return {
      ...base,
      type: "Question",
      content,
      contentMap: { en: content },
      ...(k === 0 ? {} : { updated: `2026-10-11T1${2 + k}:00:00Z` }),
      cc: [`${bob.uri}/followers`, local, ...accounts],
      tag: [
        ...Array.from({ length: MAX_STATUS_TAGS }, (_, i) => ({
          type: "Hashtag",
          href: `${OTHER_ORIGIN}/tags/v${k}t${i}`,
          name: `#v${k}t${i}`,
        })),
        ...[local, ...accounts]
          .slice(0, MAX_STATUS_MENTION_TAGS)
          .map((href) => ({ type: "Mention", href, name: "@m" })),
        ...Array.from({ length: MAX_TAGGED_COLLECTIONS }, (_, i) => ({
          type: "FeaturedCollection",
          id: collectionUri(bob, k, i),
        })),
      ],
      attachment: Array.from({ length: MAX_STATUS_MEDIA }, (_, i) => ({
        type: "Document",
        mediaType: "image/png",
        url: `${OTHER_ORIGIN}/media/v${k}-${i}.png`,
        name: `v${k} ${i}`,
      })),
      oneOf: Array.from({ length: MAX_REMOTE_OPTIONS }, (_, i) => ({
        type: "Note",
        name: `v${k} ${i}`,
        replies: { type: "Collection", totalItems: 0 },
      })),
      endTime: "2026-10-20T00:00:00Z",
      votersCount: 0,
    };
  }

  // T, and S, bob's reply to it at every cap (version 0: MAX_STATUS_MENTION_ROWS mention rows, alice's first, and its
  // MAX_TAGGED_COLLECTIONS references), its history at MAX_STATUS_EDITS versions, its card, boosted by every local
  // account; T owes S a row debt (so S is the walk's first node, in the owed lane). bob's document is fresh, so the
  // completion needs no author step (#1592's completion witness measures one). bob's collections of versions 0 and 1
  // are stored, so version 1 replaces S's references with as many others.
  async function capped() {
    const { t, root, bob } = await threadWorld();
    const [owner] = await sql<{ id: string }>(t.store, "SELECT id FROM accounts WHERE uri = ?", bob.uri);
    for (const k of [0, 1]) {
      for (let i = 0; i < MAX_TAGGED_COLLECTIONS; i++) {
        await sql(
          t.store,
          `INSERT INTO collections (id, account_id, local, name, sensitive, discoverable, uri, total_items, created_at,
						updated_at)
					VALUES (printf('6%017d', ?1), ?2, 0, 'c', 0, 1, ?3, 0, ?4, ?4)`,
          10 * k + i,
          owner!.id,
          collectionUri(bob, k, i),
          "2026-10-11T12:00:00.000Z",
        );
      }
    }
    const locals = (await sql<{ id: string }>(t.store, "SELECT account_id AS id FROM local_accounts")).map((r) => r.id);
    const first = await remoteAccounts(t, MAX_STATUS_MENTION_ROWS, 0);
    const second = await remoteAccounts(t, MAX_STATUS_MENTION_ROWS, MAX_STATUS_MENTION_ROWS);
    const note = mastodonNote(root);
    const base = mastodonNote(bob, { inReplyTo: note.id });
    const rootId = await threadRoot(t, root, note);
    expect(await t.post(bob, create(bob, version(bob, base, 0, ALICE_URI, first)))).toBe(202);
    const sId = (await statusRow(t.store, base.id))!.id;
    const count = async (table: string) =>
      (await sql<{ n: number }>(t.store, `SELECT count(*) AS n FROM ${table} WHERE status_id = ?`, sId))[0]!.n;
    expect([
      await count("status_mentions"),
      await count("status_tags"),
      await count("media_attachments"),
      await count("status_collections"),
    ]).toEqual([MAX_STATUS_MENTION_ROWS, MAX_STATUS_TAGS, MAX_STATUS_MEDIA, MAX_TAGGED_COLLECTIONS]);
    await sql(
      t.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
			INSERT INTO status_edits (status_id, content, created_at) SELECT ?1, '<p>v' || i || '</p>', ?3 FROM n`,
      sId,
      MAX_STATUS_EDITS,
      "2026-10-11T12:00:00.000Z",
    );
    for (const id of locals) {
      await sql(t.store, "DELETE FROM oauth_tokens WHERE account_id = ?", id);
      const response = await t.request(`/api/v1/statuses/${sId}/reblog`, {
        method: "POST",
        headers: { authorization: `Bearer ${await token(t.store, id)}` },
      });
      expect(response.status).toBe(200);
    }
    await owedDebt(t.store, rootId, sId, { depth: 1, key: [1, 0, 1] });
    await sql(
      t.store,
      "INSERT INTO status_cards (status_id, url, due_at, enqueued_at, generation) VALUES (?, 'https://cards.example/v0', ?2, ?2, 1)",
      sId,
      Date.now(),
    );
    vi.setSystemTime(Date.now() + REPLIES_COOLDOWN_MS + 1);
    await sql(t.store, "UPDATE accounts SET fetched_at = ? WHERE uri = ?", new Date().toISOString(), bob.uri);
    return { t, bob, base, second, rootId, sId, locals: locals.length };
  }

  // The completion of S's status step, measured, in a walk of T run to its end.
  async function completion(t: T, rootId: string, uri: string): Promise<MeasuredCall> {
    await startWalk(t.store, rootId, Date.now());
    const measuring = measuringStore(t);
    const deps = inboxDeps(() => measuring.stub, t.web.loader);
    for (let round = 0; await walkReplies(t.env, deps); round++) {
      expect(round).toBeLessThan(500);
    }
    const calls = measuring.calls.filter((call) => call.uri === uri && call.stage === "status");
    expect(calls.map((call) => call.retried)).toEqual([false]);
    return calls[0]!;
  }

  // The figure's terms by table. #1592's (its section 5.1): ≤ WALK_STATUSES node inserts and ≤ 2 × WALK_STATUSES
  // node updates (the node's own, its scan-due flag with them, the deferrals it returns, the hand-out's ends and
  // charge), the walk's row. D12's: ≤ 2 debts paid (the status's row debt, its collection debt), ≤ 1 collection debt
  // owed after ≤ 1 replacement delete.
  const WALK = { reply_walk_nodes: 3 * WALK_STATUSES, reply_walks: 1, reply_walk_debts: 2 + 1 + 1 };
  const total = (terms: Record<string, number>) => Object.values(terms).reduce((a, n) => a + n, 0);
  // Every table the completion wrote has a term, within it, and the whole within the figure; and every term of `own`
  // (what the walk adds to #1592's completion) was reached, so the figure without it would be passed.
  function within(call: MeasuredCall, terms: Record<string, number>, own: Record<string, number>) {
    for (const [table, rows] of Object.entries(call.tables)) {
      expect(rows, table).toBeLessThanOrEqual(terms[table] ?? 0);
    }
    expect(call.changes).toBeLessThanOrEqual(total(terms));
    for (const table of Object.keys(own)) {
      expect(call.tables[table] ?? 0, table).toBeGreaterThan(0);
    }
  }

  it("updates a node at every cap of updateRemoteStatus within the figure", { timeout: 120_000 }, async () => {
    const { t, bob, base, second, rootId, locals } = await capped();
    // S's newer version at every cap, dave newly mentioned and addressed, its page listing more items than the walk
    // has slots for.
    const items = Array.from({ length: WALK_STATUSES }, () => servedReply(t.web, bob, base.id));
    served(t.web, version(bob, base, 1, DAVE_URI, second), { items: items.map((n) => n.id) });
    const call = await completion(t, rootId, base.id);
    // updateRemoteStatus at its caps (a significant edit), L the local accounts: the status's row and its filter text;
    // the history at MAX_STATUS_EDITS, its newest version replaced and the edit recorded; the poll reset, its choices
    // and its fetch mark, each moving polls_revision; the mention rows, each evicted, made silent or kept, and those
    // admitted (≤ MAX_STATUS_MENTION_ROWS each); the hashtags replaced; the collection references replaced (each of
    // MAX_TAGGED_COLLECTIONS deleted, as many others written); each attachment written or deleted with its
    // remote_media and remote_media_usage rows; the card's row; and the fan-out (edit-fan-out.test.ts's formula with
    // no push subscription: the quote's 3, each local mention's 7, each booster's and quoter's 3) with the replaced
    // poll's notifications.
    const update = {
      statuses: 2,
      status_edits: 2,
      polls: 3 * 2,
      status_mentions: 2 * MAX_STATUS_MENTION_ROWS,
      status_tags: 2 * MAX_STATUS_TAGS,
      status_collections: 2 * MAX_TAGGED_COLLECTIONS,
      media_attachments: 2 * MAX_STATUS_MEDIA,
      remote_media: 2 * MAX_STATUS_MEDIA,
      remote_media_usage: 2 * MAX_STATUS_MEDIA,
      status_cards: 1,
      notifications: 3 + locals * (7 + 3 + 3) + locals,
    };
    within(call, { ...WALK, ...update }, update);
    // What reached its caps: the walk full (S's row debt paid, its reading cut and owed), every tag, collection
    // reference and attachment replaced, the history kept at MAX_STATUS_EDITS.
    expect(call.tables).toMatchObject({
      reply_walk_nodes: WALK_STATUSES - 2 + 3,
      reply_walk_debts: 2,
      status_tags: 2 * MAX_STATUS_TAGS,
      status_collections: 2 * MAX_TAGGED_COLLECTIONS,
      media_attachments: 2 * MAX_STATUS_MEDIA,
      status_edits: 2,
    });
  });

  it("starts a node's removal within the figure", { timeout: 120_000 }, async () => {
    const { t, base, rootId, sId, locals } = await capped();
    // S quotes alice's status, accepted with Kopje's authorization and marked local (as an import marks one), and
    // every local account listens on its user stream, alice on the public one too.
    const quoted = await localStatus(t, { status: "quoted", visibility: "public" });
    await sql(
      t.store,
      `INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, local, authorization_id,
				updated_at)
			VALUES (?, ?, ?, ?, 'accepted', 1, 'authorization', ?)`,
      sId,
      quoted.uri,
      quoted.id,
      ALICE,
      new Date().toISOString(),
    );
    await sql(
      t.store,
      `INSERT INTO stream_subscriptions (account_id, stream_key, sockets)
			SELECT account_id, 'user', 1 FROM local_accounts UNION ALL SELECT ?, 'public', 1`,
      ALICE,
    );
    t.web.fail(base.id, 404);
    const call = await completion(t, rootId, base.id);
    // The removal's start (remote-removal.ts startRemoval, removeGone), by the statement that writes each row: its job;
    // the streamed delete (streaming.ts streamDelete: its event, a viewer row for each local account listening, the
    // tombstone); the hide (HIDE_ROWS: the status, with its account's last status and its local quote row's copy by
    // their triggers, and its card); the quote's retirement (retireQuoteOf, ≤ 4: the quote, and its target's count, the
    // revocation and the streaming journal's row by their triggers); and its parent's replies_count.
    const removal = {
      inbound_jobs: 1,
      stream_events: 1,
      stream_delete_viewers: locals,
      stream_delete_tombstones: 1,
      statuses: HIDE_ROWS - 1 + 1,
      status_cards: 1,
      quotes: 4,
    };
    within(call, { ...WALK, ...removal }, removal);
    expect(await sql(t.store, "SELECT withdrawn FROM statuses WHERE id = ?", sId)).toEqual([{ withdrawn: 1 }]);
  });
});
