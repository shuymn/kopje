import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Db } from "../src/db/sql";
import { suspendRemote } from "../src/domain/remote-suspension";
import { REFRESH_FINISHED_MS, REFRESH_RUNNING_MS } from "../src/domain/reply-walk-reads";
import {
  claimReplyWalk,
  type ClaimedWalk,
  completeReplyStep,
  NODE_ATTEMPTS,
  REPLY_CLAIM_DROPS,
  REPLY_READ_ENTRIES,
  REPLY_WALK_LEASE_MS,
  type ReplyStep,
  type ReplyStepInput,
  type StepFetched,
  WALK_PAGES,
  WALK_PRUNE_BATCH,
  WALK_STATUSES,
} from "../src/domain/reply-walks";
import { totalChanges } from "../src/domain/row-budget";
import { REQUEST_MAX_FETCHES } from "../src/federation/loader";
import { parseRemoteStatus } from "../src/federation/remote-status";
import { walkReplies } from "../src/federation/replies";
import { STATUS_URI_LIMIT } from "../src/platform/identity-bounds";
import type { StoreStub } from "../src/platform/store-client";
import { StoreUnavailableError } from "../src/platform/store-errors";
import { sql } from "./api-helpers";
import { countingStore, inboxDeps, NOW } from "./app-helpers";
import { BUILD } from "./helpers";
import { LOCAL, mastodonActor, type TestActor } from "./inbox-helpers";
import {
  ALICE_URI,
  AS,
  create,
  DAVE,
  DAVE_URI,
  followed,
  mastodonNote,
  type Note,
  type Setup,
  setup,
} from "./inbox-status-helpers";
import { observedSql, plannedRun, scansOf } from "./read-helpers";
import {
  reply,
  serveNote,
  startWalk,
  storedOf,
  storedRoot,
  walkNodes,
  walkRounds,
  walkRow,
  withReplies,
} from "./reply-walk-helpers";

// The Store's side of the walks of remote replies collections (domain/reply-walks.ts): claims, ends, charges and the
// bounds of a walk at their caps (RES-6), the statements' plans, and one completion's whole transaction. The thread
// cases and the rounds end to end are in reply-walk-rounds.test.ts. The Store's clock is the faked Date.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

const OTHER_ORIGIN = "https://other.example";

// The root author on mastodon.example; bob on other.example, known (dave follows him), so that no step needs him.
async function world() {
  const t = await setup();
  const root = await mastodonActor(t.web, "root");
  const bob = await mastodonActor(t.web, "bob", { origin: OTHER_ORIGIN, key: 1 });
  await followed(t, bob, DAVE);
  return { t, root, bob };
}

// The root `note`, served as given, stored by its delivered Create, and a walk of it started at the Store's time.
async function walking(t: Setup, root: TestActor, note: Note): Promise<string> {
  serveNote(t.web, note);
  const id = await storedRoot(t, root, note);
  await startWalk(t.store, id, Date.now());
  return id;
}

let refreshes = 0;

// Walk rows of roots no status holds (ids from 9…), as given: queued at `queued`, due at `due` or finished at
// `finished`, leased with `token`.
async function walkRows(
  store: StoreStub,
  rows: readonly { id: string; queued: number; due?: number; finished?: number; token?: string }[],
): Promise<void> {
  await sql(
    store,
    `INSERT INTO reply_walks (status_id, kind, refresh_id, queued_at, due_at, finished_at, token)
		SELECT value ->> 'id', 0, value ->> 'refresh', value ->> 'queued', value ->> 'due', value ->> 'finished',
			value ->> 'token' FROM json_each(?)`,
    JSON.stringify(rows.map((row) => ({ ...row, refresh: `f${(++refreshes).toString(16).padStart(31, "0")}` }))),
  );
}

const goneRoot = (i: number) => `9${String(i).padStart(17, "0")}`;
const count = async (t: Setup, query: string, ...params: SqlStorageValue[]) =>
  (await sql<{ n: number }>(t.store, query, ...params))[0]!.n;
const fetches = (t: Setup, url: string) => t.web.fetched.filter((fetched) => fetched === url).length;

describe("claims", () => {
  it("prunes at most WALK_PRUNE_BATCH finished walks a claim, those finished REFRESH_FINISHED_MS ago", async () => {
    const { t } = await world();
    await walkRows(
      t.store,
      Array.from({ length: 150 }, (_, i) => ({ id: goneRoot(i), queued: 0, finished: NOW - REFRESH_FINISHED_MS })),
    );
    // Kept: finished a millisecond later.
    await walkRows(
      t.store,
      Array.from({ length: 10 }, (_, i) => ({
        id: goneRoot(500 + i),
        queued: 0,
        finished: NOW - REFRESH_FINISHED_MS + 1,
      })),
    );
    const expired = `SELECT count(*) AS n FROM reply_walks WHERE finished_at = ${NOW - REFRESH_FINISHED_MS}`;
    expect(await t.store.claimReplyWalk(BUILD)).toBeNull();
    expect(await count(t, expired)).toBe(150 - WALK_PRUNE_BATCH);
    expect(await t.store.claimReplyWalk(BUILD)).toBeNull();
    expect(await count(t, expired)).toBe(0);
    expect(await count(t, "SELECT count(*) AS n FROM reply_walks")).toBe(10);
  });

  it("deletes a walk running REFRESH_RUNNING_MS after its latest start, with its nodes, and claims the next", async () => {
    const { t, root } = await world();
    const note = mastodonNote(root);
    const id = await walking(t, root, withReplies(t.web, note, []));
    await sql(t.store, "UPDATE reply_walks SET queued_at = ?1, due_at = ?1 WHERE status_id = ?2", NOW - 10, id);
    await walkRows(t.store, [{ id: goneRoot(1), queued: NOW - REFRESH_RUNNING_MS, due: NOW - 20 }]);
    await sql(
      t.store,
      "INSERT INTO reply_walk_nodes (status_id, uri, seq) VALUES (?, 'https://x.example/1', 0)",
      goneRoot(1),
    );
    const claim = (await t.store.claimReplyWalk(BUILD)) as ClaimedWalk;
    expect(claim).toMatchObject({ statusId: id, step: { uri: note.id, stage: "status" }, pending: false });
    expect(await sql(t.store, "SELECT status_id FROM reply_walks")).toEqual([{ status_id: id }]);
    expect(await count(t, "SELECT count(*) AS n FROM reply_walk_nodes WHERE status_id = ?", goneRoot(1))).toBe(0);
    // Started a millisecond later, it runs: claimed (its root qualifies again below).
    await sql(
      t.store,
      "UPDATE reply_walks SET queued_at = ?1, due_at = ?2, token = NULL WHERE status_id = ?3",
      NOW - REFRESH_RUNNING_MS + 1,
      NOW,
      id,
    );
    expect(await t.store.claimReplyWalk(BUILD)).toMatchObject({ statusId: id });
  });

  it("finishes a walk whose root is gone or no longer a walk root, and claims one whose root is", async () => {
    const { t, root } = await world();
    const closed = mastodonNote(root);
    const closedId = await walking(t, root, withReplies(t.web, closed, []));
    await sql(t.store, "UPDATE statuses SET visibility = 'private' WHERE id = ?", closedId);
    const open = mastodonNote(root);
    const openId = await walking(t, root, withReplies(t.web, open, []));
    await sql(t.store, "UPDATE reply_walks SET due_at = ?1 WHERE status_id = ?2", NOW - 1, closedId);
    await walkRows(t.store, [{ id: goneRoot(1), queued: NOW, due: NOW - 2 }]);
    expect(await t.store.claimReplyWalk(BUILD)).toMatchObject({ statusId: openId, step: { uri: open.id } });
    for (const id of [goneRoot(1), closedId]) {
      expect(await walkRow(t.store, id)).toMatchObject({ due_at: null, finished_at: NOW, token: null });
      expect(await walkNodes(t.store, id)).toEqual([]);
    }
  });

  it("ends a walk at its next claim once its root's author is suspended mid-walk, and fetches nothing more", async () => {
    const { t, root, bob } = await world();
    const note = mastodonNote(root);
    const replies = Array.from({ length: 20 }, () => reply(t.web, bob, note.id).id);
    const id = await walking(t, root, withReplies(t.web, note, replies));
    // A claim, then the walk due again as a round that died would leave it once its lease ended.
    expect(await t.store.claimReplyWalk(BUILD)).toMatchObject({ statusId: id });
    await sql(t.store, "UPDATE reply_walks SET token = NULL, due_at = ?1 WHERE status_id = ?2", NOW, id);
    const rootAuthor = (
      await sql<{ account_id: string }>(t.store, "SELECT account_id FROM statuses WHERE id = ?", id)
    )[0]!.account_id;
    await runInDurableObject(t.store, (_instance, state) =>
      state.storage.transactionSync(() => suspendRemote(new Db(state.storage.sql), rootAuthor, null, NOW)),
    );
    const before = t.web.fetched.length;
    expect(
      await walkReplies(
        t.env,
        inboxDeps(() => t.store, t.web.loader),
      ),
    ).toBe(false);
    expect(t.web.fetched.length).toBe(before);
    expect(await walkRow(t.store, id)).toMatchObject({ finished_at: NOW, token: null, due_at: null });
    expect(await walkNodes(t.store, id)).toEqual([]);
  });

  it(`answers 'more' after REPLY_CLAIM_DROPS + 1 walks dropped, and claims the next due in the next claim`, async () => {
    const { t, root } = await world();
    const note = mastodonNote(root);
    const id = await walking(t, root, withReplies(t.web, note, []));
    await walkRows(
      t.store,
      Array.from({ length: REPLY_CLAIM_DROPS + 1 }, (_, i) => ({ id: goneRoot(i), queued: NOW, due: NOW - 10 + i })),
    );
    expect(await t.store.claimReplyWalk(BUILD)).toBe("more");
    expect(await count(t, "SELECT count(*) AS n FROM reply_walks WHERE finished_at IS NOT NULL")).toBe(
      REPLY_CLAIM_DROPS + 1,
    );
    expect(await t.store.claimReplyWalk(BUILD)).toMatchObject({ statusId: id });
  });

  it("ends every node a spent walk holds at the collection stage in one hand-out, with no request", async () => {
    const { t, root } = await world();
    const note = mastodonNote(root);
    const id = await walking(t, root, withReplies(t.web, note, []));
    await sql(t.store, "UPDATE reply_walk_nodes SET state = 1 WHERE status_id = ?", id);
    await sql(
      t.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
			INSERT INTO reply_walk_nodes (status_id, uri, seq, stage, valid, fetch)
			SELECT ?1, '${OTHER_ORIGIN}/users/bob/statuses/s' || i, i, 1, 1, '${OTHER_ORIGIN}/users/bob/statuses/s' || i || '/replies'
			FROM n`,
      id,
      WALK_STATUSES - 1,
    );
    await sql(
      t.store,
      "UPDATE reply_walks SET pages = ?2, nodes = ?3, next_seq = ?3 WHERE status_id = ?1",
      id,
      WALK_PAGES,
      WALK_STATUSES,
    );
    const before = t.web.fetched.length;
    expect(
      await walkReplies(
        t.env,
        inboxDeps(() => t.store, t.web.loader),
      ),
    ).toBe(false);
    expect(t.web.fetched.length).toBe(before);
    expect(await walkRow(t.store, id)).toMatchObject({ finished_at: NOW, pages: WALK_PAGES });
    expect(await walkNodes(t.store, id)).toEqual([]);
  });
});

// `count` pages of the root's replies, chained by next, each listing the item `item(i)`: the Note's replies name the
// first by URI.
function pageChain(t: Setup, note: Note, count: number, items: (i: number) => string[]): (i: number) => string {
  const collection = `${note.id}/replies`;
  const page = (i: number) => `${collection}?page=${i}`;
  for (let i = 1; i <= count; i++) {
    t.web.serve(page(i), {
      "@context": AS,
      id: page(i),
      type: "CollectionPage",
      partOf: collection,
      items: items(i),
      ...(i < count ? { next: page(i + 1) } : {}),
    });
  }
  note.replies = { id: collection, type: "Collection", first: page(1) };
  return page;
}

const missing = (name: string) => `${OTHER_ORIGIN}/users/bob/statuses/${name}`;

// The Store with completeReplyStep refused (StoreUnavailableError, as in maintenance) for the steps `drop` picks.
function droppingStore(store: StoreStub, drop: (input: ReplyStepInput) => boolean): StoreStub {
  return new Proxy(store, {
    get: (target, name) => {
      if (name !== "completeReplyStep") {
        return Reflect.get(target, name) as unknown;
      }
      return async (build: string, input: ReplyStepInput) => {
        if (drop(input)) {
          throw new StoreUnavailableError("maintenance");
        }
        return target.completeReplyStep(build, input);
      };
    },
  });
}

describe("completions", () => {
  // A walk of a root claimed, its status step completed naming its replies' first page by URI: `complete` completes a
  // step under the claim, more to follow; `state` reads the walk's row and nodes.
  async function atPage() {
    const { t, root } = await world();
    const note = mastodonNote(root);
    const id = await walking(t, root, withReplies(t.web, note, []));
    const page = (name: string) => `${note.id}/replies?page=${name}`;
    const claim = (await t.store.claimReplyWalk(BUILD)) as ClaimedWalk;
    const complete = (step: ReplyStep, fetched: StepFetched, more = true) =>
      t.store.completeReplyStep(BUILD, { origin: LOCAL, statusId: id, token: claim.token, step, more, fetched });
    const status = parseRemoteStatus({ "@context": AS, ...note })!;
    const first = await complete(claim.step, {
      kind: "status",
      status,
      replies: { entries: [], from: null, next: { stage: "page", uri: page("p") } },
    });
    expect(first.next).toEqual({ uri: note.id, stage: "page", fetch: page("p"), skip: 0, handout: 2 });
    const state = async () => ({ walk: await walkRow(t.store, id), nodes: await walkNodes(t.store, id) });
    return { t, note, page, complete, step: first.next!, state };
  }
  const naming = (uri: string): StepFetched => ({
    kind: "replies",
    replies: { entries: [], from: 0, next: { stage: "page", uri } },
  });
  const done = { next: null, need: null, done: true, jobsPending: false };

  it("applies a reading once: a completion repeated after its node reads the same page again changes nothing", async () => {
    const { complete, step, state } = await atPage();
    const read: StepFetched = { kind: "replies", replies: { entries: [missing("m0"), null], from: 0, next: "more" } };
    const again = await complete(step, read);
    expect(again.next).toEqual({ ...step, skip: 2, handout: 3 });
    const before = await state();
    // The first reading's completion, repeated (a retried call): the node reads that page past it now.
    expect(await complete(step, read)).toEqual(done);
    expect(await state()).toEqual(before);
  });

  it("applies a page's completion once when the page names itself next: repeated, it changes nothing", async () => {
    const { page, complete, step, state } = await atPage();
    const again = await complete(step, naming(page("p")));
    // The same node, document and skip, handed out again under the next number.
    expect(again.next).toEqual({ ...step, handout: 3 });
    const before = await state();
    expect(before.walk).toMatchObject({ pages: 2, handouts: 3, handout: 3 });
    expect(await complete(step, naming(page("p")))).toEqual(done);
    expect(await state()).toEqual(before);
  });

  it("applies a page's completion once when a later page names it again: P, Q, P, then P's repeated", async () => {
    const { page, complete, step, state } = await atPage();
    const atQ = await complete(step, naming(page("q")));
    const atP = await complete(atQ.next!, naming(page("p")));
    expect(atP.next).toEqual({ ...step, handout: 4 });
    const before = await state();
    expect(before.walk).toMatchObject({ pages: 3, handouts: 4, handout: 4 });
    for (const [repeated, read] of [
      [step, naming(page("q"))],
      [atQ.next!, naming(page("p"))],
    ] as const) {
      expect(await complete(repeated, read)).toEqual(done);
    }
    expect(await state()).toEqual(before);
  });

  it("applies a transient failure once: repeated after the node is handed out again, it changes nothing", async () => {
    const { page, complete, step, state } = await atPage();
    const retry = await complete(step, { kind: "transient" });
    expect(retry.next).toEqual({ ...step, handout: 3 });
    const before = await state();
    expect(before.nodes).toEqual([expect.objectContaining({ state: 0, attempts: NODE_ATTEMPTS })]);
    // Applied again, it would end the node, its attempts spent, and finish the walk.
    expect(await complete(step, { kind: "transient" })).toEqual(done);
    expect(await state()).toEqual(before);
    // The awaited one is still applied.
    expect(await complete(retry.next!, naming(page("q")))).toMatchObject({ done: false });
  });

  it("applies the round's last completion once: repeated before the walk's release, it changes nothing", async () => {
    const { complete, step, state } = await atPage();
    expect(await complete(step, { kind: "transient" }, false)).toEqual({
      next: null,
      need: null,
      done: false,
      jobsPending: false,
    });
    const before = await state();
    expect(before.walk).toMatchObject({ handouts: 2, handout: null });
    expect(await complete(step, { kind: "transient" }, false)).toEqual(done);
    expect(await state()).toEqual(before);
  });
});

describe("a status step's parent", () => {
  it("ends a node whose parent no walk records, and defers one on a parent the walk may record later", async () => {
    const { t, root, bob } = await world();
    const note = mastodonNote(root);
    const id = await walking(t, root, withReplies(t.web, note, []));
    const local = mastodonNote(bob, { inReplyTo: `${LOCAL}/statuses/1` });
    const later = mastodonNote(bob, { inReplyTo: missing("later") });
    const claim = (await t.store.claimReplyWalk(BUILD)) as ClaimedWalk;
    const complete = (step: ReplyStep, status: Note, entries: string[] = []) =>
      t.store.completeReplyStep(BUILD, {
        origin: LOCAL,
        statusId: id,
        token: claim.token,
        step,
        more: true,
        fetched: {
          kind: "status",
          status: parseRemoteStatus({ "@context": AS, ...status })!,
          replies: { entries, from: 0, next: null },
        },
      });
    // A node left pending after them keeps the walk running.
    const atLocal = await complete(claim.step, note, [local.id, later.id, missing("tail")]);
    const atLater = await complete(atLocal.next!, local);
    expect((await complete(atLater.next!, later)).next).toMatchObject({ uri: missing("tail") });
    expect((await walkNodes(t.store, id)).map(({ uri, state, parent }) => ({ uri, state, parent }))).toEqual([
      { uri: note.id, state: 1, parent: null },
      { uri: local.id, state: 1, parent: null },
      { uri: later.id, state: 2, parent: missing("later") },
      { uri: missing("tail"), state: 0, parent: null },
    ]);
  });
});

describe("the bounds of a walk at their caps", () => {
  it(
    "records at most WALK_STATUSES nodes, the root included: the next item is never fetched",
    { timeout: 120_000 },
    async () => {
      const { t, root } = await world();
      const note = mastodonNote(root);
      const PAGE = WALK_STATUSES;
      const item = (i: number) => missing(`n${i}`);
      const page = pageChain(t, note, 3, (p) => Array.from({ length: PAGE }, (_, i) => item((p - 1) * PAGE + i)));
      const id = await walking(t, root, note);
      await walkRounds(t);
      expect(await walkRow(t.store, id)).toMatchObject({ nodes: WALK_STATUSES, pages: 1, finished_at: NOW });
      expect(fetches(t, item(WALK_STATUSES - 2))).toBe(1);
      expect(fetches(t, item(WALK_STATUSES - 1))).toBe(0);
      // The full walk's reading of the collection ends there: the next pages are never requested.
      expect([fetches(t, page(2)), fetches(t, page(3))]).toEqual([0, 0]);
    },
  );

  it(
    "reads at most WALK_PAGES collection documents: the next page is never requested",
    { timeout: 120_000 },
    async () => {
      const { t, root } = await world();
      const note = mastodonNote(root);
      const page = pageChain(t, note, WALK_PAGES + 1, (i) => [missing(`p${i}`)]);
      const id = await walking(t, root, note);
      await walkRounds(t);
      expect(await walkRow(t.store, id)).toMatchObject({ pages: WALK_PAGES, finished_at: NOW });
      expect([fetches(t, page(WALK_PAGES)), fetches(t, page(WALK_PAGES + 1))]).toEqual([1, 0]);
      expect(fetches(t, missing(`p${WALK_PAGES}`))).toBe(1);
    },
  );

  it(
    "charges a page whose round died after its fetch: WALK_PAGES requests read half as many pages",
    { timeout: 120_000 },
    async () => {
      const { t, root } = await world();
      const note = mastodonNote(root);
      const page = pageChain(t, note, WALK_PAGES + 1, (i) => [missing(`p${i}`)]);
      const id = await walking(t, root, note);
      // Each page's first completion is refused, the round dying after its fetch; the walk is claimed after the lease.
      const dropped = new Set<string>();
      const dropping = droppingStore(t.store, (input) => {
        if (input.step.stage !== "page" || dropped.has(input.step.fetch)) {
          return false;
        }
        dropped.add(input.step.fetch);
        return true;
      });
      const deps = inboxDeps(() => dropping, t.web.loader);
      for (let round = 0; ; round++) {
        expect(round).toBeLessThan(400);
        try {
          if (!(await walkReplies(t.env, deps))) {
            break;
          }
        } catch (error) {
          expect(error).toBeInstanceOf(StoreUnavailableError);
          vi.setSystemTime(Date.now() + REPLY_WALK_LEASE_MS + 1);
        }
      }
      const read = WALK_PAGES / NODE_ATTEMPTS;
      const pageFetches = t.web.fetched.filter((url) => url.startsWith(`${note.id}/replies?page=`));
      expect(pageFetches).toHaveLength(WALK_PAGES);
      expect([fetches(t, page(read)), fetches(t, page(read + 1))]).toEqual([NODE_ATTEMPTS, 0]);
      expect([fetches(t, missing(`p${read}`)), fetches(t, missing(`p${read + 1}`))]).toEqual([1, 0]);
      expect(await walkRow(t.store, id)).toMatchObject({ pages: WALK_PAGES });
    },
  );

  // The root R lists X₁ … X₁₉₈ before their parent P, which replies to R: 200 nodes.
  function listedBeforeParent(t: Setup, root: TestActor, bob: TestActor) {
    const note = mastodonNote(root);
    const p = reply(t.web, bob, note.id);
    const xs = Array.from({ length: WALK_STATUSES - 2 }, () => reply(t.web, bob, p.id));
    withReplies(t.web, note, [...xs.map((x) => x.id), p.id]);
    return { note, p, xs };
  }

  it(
    "stores replies listed before their parent once it is, fetching each twice and the parent once",
    { timeout: 120_000 },
    async () => {
      const { t, root, bob } = await world();
      const { note, p, xs } = listedBeforeParent(t, root, bob);
      const id = await walking(t, root, note);
      await walkRounds(t);
      const uris = [p.id, ...xs.map((x) => x.id)];
      expect(await storedOf(t.store, uris)).toEqual(uris);
      expect(xs.every((x) => fetches(t, x.id) === NODE_ATTEMPTS)).toBe(true);
      expect(fetches(t, p.id)).toBe(1);
      expect(await walkRow(t.store, id)).toMatchObject({ nodes: WALK_STATUSES, result_count: WALK_STATUSES - 1 });
    },
  );

  it(
    "hands out at most NODE_ATTEMPTS × WALK_STATUSES + WALK_PAGES documents a walk, each within its fetch budget",
    { timeout: 180_000 },
    async () => {
      const { t, root } = await world();
      const note = mastodonNote(root);
      // Every node at its attempts and every page charged: the root's collection is a chain of WALK_PAGES + 1 pages by
      // URI, the first WALK_PAGES listing the WALK_STATUSES - 1 items that fill the walk, two a page; the root and every
      // item fail once (5xx) before they are read, the items then answering 404.
      const items = Array.from({ length: WALK_STATUSES - 1 }, (_, i) => missing(`c${i}`));
      const page = pageChain(t, note, WALK_PAGES + 1, (i) => items.slice((i - 1) * 2, i * 2));
      const flaky = new Set([note.id, ...items]);
      const loader = {
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new Request(input, init).url;
          if (flaky.delete(url)) {
            t.web.fetched.push(url);
            return new Response("busy", { status: 503 });
          }
          return t.web.fetch(input, init);
        }) as typeof fetch,
        checkHost: () => Promise.resolve(),
      };
      const id = await walking(t, root, note);
      const before = t.web.fetched.length;
      await walkRounds(t, 100, loader);
      const statusFetches = [note.id, ...items].map((uri) => fetches(t, uri));
      expect(statusFetches).toEqual(statusFetches.map(() => NODE_ATTEMPTS));
      const pageFetches = t.web.fetched.filter((url) => url.startsWith(`${note.id}/replies?page=`)).length;
      expect(pageFetches).toBe(WALK_PAGES);
      expect(fetches(t, page(WALK_PAGES + 1))).toBe(0);
      const handOuts = statusFetches.reduce((a, b) => a + b, 0) + pageFetches;
      expect(handOuts).toBe(NODE_ATTEMPTS * WALK_STATUSES + WALK_PAGES);
      // No author to fetch (bob is known): each hand-out made one request, within REQUEST_MAX_FETCHES.
      expect(t.web.fetched.length - before).toBe(handOuts);
      expect(t.web.fetched.length - before).toBeLessThanOrEqual(handOuts * REQUEST_MAX_FETCHES);
      expect(await walkRow(t.store, id)).toMatchObject({ nodes: WALK_STATUSES, pages: WALK_PAGES, finished_at: NOW });
    },
  );

  it("carries at most REPLY_READ_ENTRIES entries of a page of 1 MiB to the Store", { timeout: 60_000 }, async () => {
    const { t, root } = await world();
    const note = mastodonNote(root);
    const LISTED = 250;
    const prefix = missing("");
    const ids = Array.from({ length: LISTED }, (_, i) => `${prefix}${String(i).padStart(4000 - prefix.length, "0")}`);
    expect(ids.every((uri) => uri.length === 4000 && uri.length <= STATUS_URI_LIMIT)).toBe(true);
    pageChain(t, note, 1, () => ids);
    const body = JSON.stringify(t.web.served.get(`${note.id}/replies?page=1`)!.body);
    expect(body.length).toBeGreaterThan(1_000_000);
    expect(body.length).toBeLessThanOrEqual(1024 * 1024);
    const id = await walking(t, root, note);
    const counting = countingStore(t.store);
    await walkReplies(
      t.env,
      inboxDeps(() => counting.stub, t.web.loader),
    );
    const carried = counting.records
      .filter((record) => record.name === "completeReplyStep")
      .map((record) => (record.args[1] as ReplyStepInput).fetched)
      .find((fetched) => fetched.kind === "replies");
    const entries = carried?.kind === "replies" ? carried.replies.entries : [];
    expect(entries).toEqual(ids.slice(0, REPLY_READ_ENTRIES));
    expect(JSON.stringify(entries).length).toBeLessThanOrEqual(REPLY_READ_ENTRIES * (STATUS_URI_LIMIT + 3));
    // The walk is full (its root and 199 of them), so the page's reading ends there, its tail not read again.
    expect((await walkRow(t.store, id))?.nodes).toBe(WALK_STATUSES);
    const skips = counting.records
      .filter((record) => record.name === "completeReplyStep")
      .map((record) => (record.args[1] as ReplyStepInput).step.skip);
    expect(skips.filter((skip) => skip !== 0)).toEqual([]);
  });
});

describe("plans (RES-7)", () => {
  it("seeks every walk statement by its key, after ANALYZE and growth", { timeout: 120_000 }, async () => {
    const { t, root, bob } = await world();
    const note = mastodonNote(root);
    serveNote(t.web, withReplies(t.web, note, []));
    const id = await storedRoot(t, root, note);
    const p = mastodonNote(bob, { inReplyTo: note.id });
    expect(await t.post(bob, create(bob, p))).toBe(202);
    // The walk: its root read, P pending, 150 nodes deferred on P and 48 ended.
    await sql(
      t.store,
      `INSERT INTO reply_walks (status_id, kind, refresh_id, queued_at, due_at, next_seq, nodes)
			VALUES (?, 0, '${"e".repeat(32)}', ?2, ?2, ?3, ?3)`,
      id,
      NOW,
      WALK_STATUSES,
    );
    await sql(
      t.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 198)
			INSERT INTO reply_walk_nodes (status_id, uri, seq, state, valid, parent)
			SELECT ?1, ?2, 0, 1, 1, NULL
			UNION ALL SELECT ?1, ?3, 199, 0, 0, NULL
			UNION ALL SELECT ?1, '${OTHER_ORIGIN}/d' || i, i, CASE WHEN i <= 150 THEN 2 ELSE 1 END, 0,
				CASE WHEN i <= 150 THEN ?3 END FROM n`,
      id,
      note.id,
      p.id,
    );
    await sql(t.store, "ANALYZE");
    // Growth the statistics never saw: 10,000 walks finished recently, 150 finished long ago, 5,000 leased ahead,
    // and 3,000 nodes of 15 of those, half deferred on P's URI too.
    await sql(
      t.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 15150)
			INSERT INTO reply_walks (status_id, kind, refresh_id, queued_at, due_at, finished_at, token)
			SELECT printf('8%017d', i), 0, printf('%032x', i), ?1,
				CASE WHEN i > 10150 THEN ?1 + ?3 END,
				CASE WHEN i <= 150 THEN ?1 - ?2 WHEN i <= 10150 THEN ?1 - 1 END,
				CASE WHEN i > 10150 THEN printf('%036d', i) END FROM n`,
      NOW,
      REFRESH_FINISHED_MS,
      REPLY_WALK_LEASE_MS,
    );
    await sql(
      t.store,
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 2999)
			INSERT INTO reply_walk_nodes (status_id, uri, seq, state, parent)
			SELECT printf('8%017d', 10151 + i / 200), '${OTHER_ORIGIN}/o' || i, i, CASE WHEN i % 2 = 0 THEN 2 ELSE 0 END,
				CASE WHEN i % 2 = 0 THEN ?1 END FROM n`,
      p.id,
    );
    const TABLES = ["reply_walks", "reply_walk_nodes"];
    const claimed = await plannedRun(t, /reply_walk/, claimReplyWalk, { now: NOW }, true);
    expect(claimed.result).toMatchObject({ statusId: id, step: { uri: p.id, stage: "status" } });
    const claim = claimed.result as ClaimedWalk;
    const input: ReplyStepInput = {
      now: NOW,
      origin: LOCAL,
      statusId: id,
      token: claim.token,
      step: claim.step,
      more: true,
      fetched: { kind: "status", status: parseRemoteStatus({ "@context": AS, ...p })!, replies: null },
    };
    const completed = await plannedRun(t, /reply_walk/, completeReplyStep, input, true);
    expect(completed.result).toMatchObject({ need: null, next: { uri: `${OTHER_ORIGIN}/d1` } });
    const statements = [...claimed.plans, ...completed.plans];
    for (const { query, plan } of statements) {
      expect(scansOf(plan, TABLES), query).toEqual([]);
    }
    const rowsOf = (pattern: RegExp) => statements.filter((s) => pattern.test(s.query)).map((s) => s.rows);
    // The prune: 100 entries of reply_walks_finished, each row deleted by key with its nodes' (none) seek.
    expect(rowsOf(/^DELETE FROM reply_walks INDEXED/)).toEqual([expect.any(Number)]);
    expect(rowsOf(/^DELETE FROM reply_walks INDEXED/)[0]).toBeLessThanOrEqual(5 * WALK_PRUNE_BATCH);
    // The return of P's 150 deferred nodes reads them alone (and the entry past them), not the other walks' 1,500
    // deferred on the same URI.
    expect(rowsOf(/INDEXED BY reply_walk_nodes_parent/)).toEqual([150 + 1]);
    // Every other statement seeks a key or the head of a range: at most two rows.
    const rest = statements.filter((s) => !/^DELETE FROM reply_walks INDEXED|reply_walk_nodes_parent/.test(s.query));
    for (const { query, rows } of rest) {
      expect(rows, query).toBeLessThanOrEqual(2);
    }
    expect(
      await count(t, "SELECT count(*) AS n FROM reply_walks WHERE finished_at <= ?", NOW - REFRESH_FINISHED_MS),
    ).toBe(150 - WALK_PRUNE_BATCH);
  });
});

describe("a completion's transaction (RES-4)", () => {
  // A reply W by a new author, erin, published at `published` and tagging both local accounts, that embeds erin's own
  // quoted status Q, alike and published a second before W (so Q's id is lower, whatever the ids' random bits); 100
  // nodes deferred on W before it, and W's first page listing 98 new items, so that the walk holds WALK_STATUSES nodes
  // once W is read. The completion that stores W (its step's second, with the author) is measured: rows changed
  // (total_changes(), triggers and cascades included), the rows written to the walk's tables, and the notifications
  // inserted. The rounds stop there.
  async function measured(published: number) {
    const t = await setup();
    const root = await mastodonActor(t.web, "root");
    const erin = await mastodonActor(t.web, "erin", { origin: OTHER_ORIGIN, key: 2 });
    const tagged = {
      published: new Date(published).toISOString(),
      cc: [`${erin.uri}/followers`, ALICE_URI, DAVE_URI],
      tag: [ALICE_URI, DAVE_URI].map((href) => ({ type: "Mention", href, name: "@x" })),
    };
    const note = mastodonNote(root);
    const q = mastodonNote(erin, { ...tagged, published: new Date(published - 1000).toISOString() });
    const w = mastodonNote(erin, { ...tagged, inReplyTo: note.id, quote: q, quoteUri: q.id });
    const deferred = Array.from({ length: 100 }, () => reply(t.web, erin, w.id));
    const items = Array.from({ length: WALK_STATUSES - 2 - deferred.length }, (_, i) => missing(`w${i}`));
    serveNote(t.web, withReplies(t.web, w, items));
    withReplies(t.web, note, [...deferred.map((d) => d.id), w.id]);
    const id = await walking(t, root, note);
    const out = { changes: -1, inserts: 0, walk: {} as Record<string, number> };
    const measuring = new Proxy(t.store, {
      get: (target, name) => {
        if (name !== "completeReplyStep") {
          return Reflect.get(target, name) as unknown;
        }
        return async (build: string, input: ReplyStepInput) => {
          if (input.author === undefined) {
            return target.completeReplyStep(build, input);
          }
          return runInDurableObject(t.store, (_instance, state) =>
            state.storage.transactionSync(() => {
              const counted = observedSql(state.storage.sql, (_rows, query) => {
                out.inserts += query.includes("INSERT INTO notifications") ? 1 : 0;
                const write = /^\s*(INSERT INTO|UPDATE|DELETE FROM) (reply_walk\w*)/.exec(query);
                if (write !== null) {
                  const key = `${write[1]} ${write[2]}`;
                  out.walk[key] = (out.walk[key] ?? 0) + 1;
                }
              });
              const db = new Db(state.storage.sql);
              const before = totalChanges(db);
              const answer = completeReplyStep.run(counted, { ...input, now: Date.now() }, (fn) =>
                state.storage.transactionSync(fn),
              );
              out.changes = totalChanges(db) - before;
              return answer;
            }),
          );
        };
      },
    });
    const deps = inboxDeps(() => measuring, t.web.loader);
    for (let round = 0; out.changes < 0; round++) {
      expect(round).toBeLessThan(20);
      await walkReplies(t.env, deps);
    }
    return { t, id, w, q, out };
  }

  it(
    "stores a reply and its embedded self-quote with their notifications, the author and the nodes, within the figure",
    { timeout: 120_000 },
    async () => {
      const stale = await measured(NOW - 7 * 60 * 60 * 1000);
      const fresh = await measured(NOW - 60_000);
      for (const { t, id, w, q } of [stale, fresh]) {
        expect(await storedOf(t.store, [w.id, q.id])).toEqual([w.id, q.id]);
        expect((await walkRow(t.store, id))?.nodes).toBe(WALK_STATUSES);
      }
      // The walk's statements, each writing one row by its key: 98 items inserted; W made valid at its depth, the 100
      // nodes deferred on it returned, W ended (scan-due: it read its page) and the next node charged: within
      // WALK_STATUSES inserts and 2 × WALK_STATUSES updates; the walk's counters once; and the root's debts of W paid,
      // its row debt at its status stage's end and its collection debt at its reading's end (none held here: they
      // delete nothing), at most two (#1607 D12).
      for (const { out } of [stale, fresh]) {
        expect(out.walk).toEqual({
          "INSERT INTO reply_walk_nodes": 98,
          "UPDATE reply_walk_nodes": 1 + 100 + 1 + 1,
          "UPDATE reply_walks": 1,
          "DELETE FROM reply_walk_debts": 2,
        });
        expect(out.walk["INSERT INTO reply_walk_nodes"]).toBeLessThanOrEqual(WALK_STATUSES);
        expect(out.walk["UPDATE reply_walk_nodes"]).toBeLessThanOrEqual(2 * WALK_STATUSES);
      }
      // Notifications only within the real-time window: W's and Q's mentions of alice and dave, one notify each, each
      // within #1582's per-mention figure of 7 rows (no push subscription, no subscriber: erin is new).
      expect([stale.out.inserts, fresh.out.inserts]).toEqual([0, 4]);
      expect(fresh.out.changes - stale.out.changes).toBeGreaterThan(0);
      expect(fresh.out.changes - stale.out.changes).toBeLessThanOrEqual(4 * 7);
      // The rest, the same in both: the walk's rows above and what the two statuses' and erin's stores write for any
      // fetched status (rows, mentions, the quote, the account, and the triggers' counters; erin's last status moves to
      // W only, Q's id being lower).
      const walkRows = Object.entries(stale.out.walk)
        .filter(([write]) => write !== "DELETE FROM reply_walk_debts")
        .reduce((a, [, n]) => a + n, 0);
      expect(stale.out.changes - walkRows).toBe(19);
    },
  );
});
