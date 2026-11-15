import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAX_RUNNING_REFRESHES,
  REFRESH_FINISHED_MS,
  REFRESH_RUNNING_MS,
  REPLIES_COOLDOWN_MS,
  REPLIES_INITIAL_WAIT_MS,
} from "../src/domain/reply-walk-reads";
import { getAsyncRefresh } from "../src/domain/reply-walks";
import { sha256Hex } from "../src/security/tokens";
import { apiHarness, bearer, seedAccount, sql } from "./api-helpers";
import { countingStore, harness, NOW } from "./app-helpers";
import { fixtureKeyGen } from "./federation-helpers";
import { BUILD } from "./helpers";
import { mastodonActor, type TestActor } from "./inbox-helpers";
import {
  ALICE_URI,
  announce,
  AS,
  create,
  DAVE,
  followed,
  localStatus,
  mastodonNote,
  type Note,
  type Setup,
  setup,
  statusRow,
} from "./inbox-status-helpers";
import { appTokenWith, measuredStatements, scopedToken } from "./read-helpers";

// A context read's refresh of a remote status's replies (Mastodon 4.7.5's ContextsController#show with
// AsyncRefreshesConcern, FetchRepliesConcern and AsyncRefresh): which reads start one, the Mastodon-Async-Refresh
// header that names it while it runs, and GET /api/v1_alpha/async_refreshes/:id. The walk itself is
// reply-walk-rounds.test.ts's. The Store's clock is the faked Date; the requests' is `clock`.

const clock = { now: NOW };

beforeEach(() => {
  clock.now = NOW;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

const HEADER = "mastodon-async-refresh";
const REFRESH = /^id="([0-9a-f]{32})", retry=3, result_count=(\d+)$/;

// Moves both clocks.
function at(ms: number): void {
  clock.now = ms;
  vi.setSystemTime(ms);
}

// The root author on mastodon.example, followed by alice.
async function world() {
  const t = await setup(clock);
  const root = await mastodonActor(t.web, "root");
  await followed(t, root);
  return { t, root };
}

// `note` delivered by its author; returns its id.
async function delivered(t: Setup, author: TestActor, note: Note): Promise<string> {
  expect(await t.post(author, create(author, note))).toBe(202);
  return (await statusRow(t.store, note.id))!.id;
}

// GET /api/v1/statuses/:id/context as `as` (null: anonymous): its refresh header, the start calls it made and the
// queue messages it sent.
async function context(t: Setup, id: string, as: "alice" | "dave" | null = "alice") {
  const counting = countingStore(t.store);
  const h = harness(counting.stub, {}, BUILD, { keygen: fixtureKeyGen, loader: t.web.loader }, () => clock.now);
  const headers: Record<string, string> = as === null ? {} : { authorization: `Bearer ${t.tokens[as]}` };
  const response = await h.request(`/api/v1/statuses/${id}/context`, { headers });
  const header = response.headers.get(HEADER);
  return {
    status: response.status,
    header,
    match: header === null ? null : REFRESH.exec(header),
    starts: counting.calls.filter((name) => name === "startRepliesRefresh").length,
    sent: h.queue.pending.map((message) => message.body),
  };
}

// An app over t's Store whose first start call waits for `release` (`arrived` once it waits).
function heldStart(t: Setup) {
  let reached!: () => void;
  let release!: () => void;
  const arrived = new Promise<void>((resolve) => (reached = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  let first = true;
  const held = new Proxy(t.store, {
    get: (target, name) => {
      if (name !== "startRepliesRefresh") {
        return Reflect.get(target, name) as unknown;
      }
      return async (...args: Parameters<typeof target.startRepliesRefresh>) => {
        if (first) {
          first = false;
          reached();
          await gate;
        }
        return target.startRepliesRefresh(...args);
      };
    },
  });
  const h = harness(held, {}, BUILD, { keygen: fixtureKeyGen, loader: t.web.loader }, () => clock.now);
  return { h, arrived, release };
}

// startRepliesRefresh called directly for alice, past what the context read advises.
async function start(t: Setup, id: string) {
  const credential = { tokenHash: await sha256Hex(t.tokens.alice), scope: "read:statuses" as const, now: clock.now };
  return t.store.startRepliesRefresh(BUILD, { credential, id });
}

const walkOf = async (t: Setup, id: string) =>
  (
    await sql<{ refresh_id: string; queued_at: number; finished_at: number | null; result_count: number }>(
      t.store,
      "SELECT refresh_id, queued_at, finished_at, result_count FROM reply_walks WHERE status_id = ?",
      id,
    )
  )[0];

const published = (ms: number) => new Date(ms).toISOString();

describe("a context read's refresh", () => {
  it("starts for a signed-in reader and is named, while it runs, to any reader", async () => {
    const { t, root } = await world();
    const id = await delivered(t, root, mastodonNote(root));
    const other = await delivered(t, root, mastodonNote(root));
    // An anonymous read starts none.
    expect(await context(t, other, null)).toMatchObject({ status: 200, header: null, starts: 0 });
    expect(await walkOf(t, other)).toBeUndefined();
    const read = await context(t, id);
    expect(read.status).toBe(200);
    expect(read.match?.[2]).toBe("0");
    const walk = await walkOf(t, id);
    expect(walk).toEqual({ refresh_id: read.match![1], queued_at: NOW, finished_at: null, result_count: 0 });
    // Running: every reader's answer names it, and none starts another.
    expect(await context(t, id, null)).toMatchObject({ header: read.header, starts: 0 });
    expect(await context(t, id, "dave")).toMatchObject({ header: read.header, starts: 0 });
    expect(await walkOf(t, id)).toEqual(walk);
    // result_count is the walk's for every reader: the statuses it created, counted whoever may see them.
    await sql(t.store, "UPDATE reply_walks SET result_count = 2 WHERE status_id = ?", id);
    for (const as of [null, "alice", "dave"] as const) {
      expect((await context(t, id, as)).match?.[2], String(as)).toBe("2");
    }
    // Finished: no header.
    await sql(t.store, "UPDATE reply_walks SET due_at = NULL, finished_at = ?1 WHERE status_id = ?2", NOW, id);
    expect((await context(t, id)).header).toBeNull();
  });

  it("starts none for a private or direct status, a local status or a boost", async () => {
    const { t, root } = await world();
    const open = await delivered(t, root, mastodonNote(root));
    const closed = await delivered(t, root, mastodonNote(root, { to: [`${root.uri}/followers`], cc: [] }));
    const direct = await delivered(
      t,
      root,
      mastodonNote(root, {
        to: ["https://kopje.test/ap/users/alice"],
        cc: [],
        tag: [{ type: "Mention", href: "https://kopje.test/ap/users/alice", name: "@alice" }],
      }),
    );
    const local = (await localStatus(t, { status: "mine", visibility: "public" })).id;
    const original = mastodonNote(root);
    await delivered(t, root, original);
    expect(await t.post(root, announce(root, original.id))).toBe(202);
    const boost = (
      await sql<{ id: string }>(
        t.store,
        "SELECT id FROM statuses WHERE reblog_of_id IS NOT NULL ORDER BY id DESC LIMIT 1",
      )
    )[0]!.id;
    for (const id of [closed, direct, local, boost]) {
      expect(await context(t, id), id).toMatchObject({ status: 200, header: null, starts: 0 });
      expect(await walkOf(t, id), id).toBeUndefined();
    }
    expect((await context(t, open)).match).not.toBeNull();
  });

  it("starts none until REPLIES_INITIAL_WAIT_MS after the status was published", async () => {
    const { t, root } = await world();
    const early = await delivered(
      t,
      root,
      mastodonNote(root, { published: published(NOW - REPLIES_INITIAL_WAIT_MS + 1000) }),
    );
    const waited = await delivered(
      t,
      root,
      mastodonNote(root, { published: published(NOW - REPLIES_INITIAL_WAIT_MS) }),
    );
    expect(await context(t, early)).toMatchObject({ header: null, starts: 0 });
    expect(await walkOf(t, early)).toBeUndefined();
    expect((await context(t, waited)).match).not.toBeNull();
  });

  it("starts none within REPLIES_COOLDOWN_MS of the last start, and a later start keeps the refresh's id", async () => {
    const { t, root } = await world();
    const id = await delivered(t, root, mastodonNote(root));
    const first = (await context(t, id)).match![1];
    await sql(
      t.store,
      "UPDATE reply_walks SET due_at = NULL, finished_at = ?1, result_count = 4 WHERE status_id = ?2",
      NOW + 1000,
      id,
    );
    at(NOW + REPLIES_COOLDOWN_MS - 1);
    expect(await context(t, id)).toMatchObject({ header: null, starts: 0 });
    expect(await walkOf(t, id)).toMatchObject({ queued_at: NOW, result_count: 4 });
    at(NOW + REPLIES_COOLDOWN_MS);
    const again = await context(t, id);
    expect(again.match?.slice(1)).toEqual([first, "0"]);
    expect(await walkOf(t, id)).toEqual({
      refresh_id: first,
      queued_at: NOW + REPLIES_COOLDOWN_MS,
      finished_at: null,
      result_count: 0,
    });
    expect(
      await sql(t.store, "SELECT uri, seq, state, valid FROM reply_walk_nodes WHERE status_id = ?", id),
    ).toHaveLength(1);
  });

  it(`starts none while MAX_RUNNING_REFRESHES run: the ${MAX_RUNNING_REFRESHES}th starts, the next does not`, async () => {
    const { t, root } = await world();
    await sql(
      t.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO reply_walks (status_id, kind, refresh_id, queued_at, due_at)
			SELECT printf('9%017d', i), 0, printf('%032x', i), ?2, ?2 FROM n`,
      MAX_RUNNING_REFRESHES - 1,
      NOW,
    );
    const last = await delivered(t, root, mastodonNote(root));
    const past = await delivered(t, root, mastodonNote(root));
    expect((await context(t, last)).match).not.toBeNull();
    expect(await context(t, past)).toMatchObject({ header: null, starts: 0 });
    expect(await walkOf(t, past)).toBeUndefined();
  });

  it("is decided again by the start: none for a status not waited, private, refreshed within REPLIES_COOLDOWN_MS or past MAX_RUNNING_REFRESHES", async () => {
    const { t, root } = await world();
    const early = await delivered(
      t,
      root,
      mastodonNote(root, { published: published(NOW - REPLIES_INITIAL_WAIT_MS + 1000) }),
    );
    const closed = await delivered(t, root, mastodonNote(root, { to: [`${root.uri}/followers`], cc: [] }));
    const cooled = await delivered(t, root, mastodonNote(root));
    const running = await delivered(t, root, mastodonNote(root));
    const full = await delivered(t, root, mastodonNote(root));
    for (const id of [early, closed]) {
      expect(await start(t, id), id).toEqual({ status: "ok", value: null });
    }
    expect(await start(t, running)).toEqual({
      status: "ok",
      value: { id: expect.stringMatching(/^[0-9a-f]{32}$/), status: "running", resultCount: 0 },
    });
    const refreshId = (await walkOf(t, running))!.refresh_id;
    // Running: answered as it is, and not restarted.
    await sql(t.store, "UPDATE reply_walks SET result_count = 2 WHERE status_id = ?", running);
    expect(await start(t, running)).toEqual({
      status: "ok",
      value: { id: refreshId, status: "running", resultCount: 2 },
    });
    await sql(
      t.store,
      `INSERT INTO reply_walks (status_id, kind, refresh_id, queued_at, finished_at, result_count)
			VALUES (?1, 0, ?2, ?3, ?3, 1)`,
      cooled,
      "a".repeat(32),
      NOW - REPLIES_COOLDOWN_MS + 1,
    );
    expect(await start(t, cooled)).toEqual({ status: "ok", value: null });
    expect(await walkOf(t, cooled)).toMatchObject({ queued_at: NOW - REPLIES_COOLDOWN_MS + 1, result_count: 1 });
    await sql(
      t.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO reply_walks (status_id, kind, refresh_id, queued_at, due_at)
			SELECT printf('9%017d', i), 0, printf('%032x', i), ?2, ?2 FROM n`,
      MAX_RUNNING_REFRESHES - 1,
      NOW,
    );
    expect(await start(t, full)).toEqual({ status: "ok", value: null });
    for (const id of [early, closed, full]) {
      expect(await walkOf(t, id), id).toBeUndefined();
    }
  });

  it("starts none for a status the reader may not see: 404, and no walk", async () => {
    const { t } = await world();
    const stranger = await mastodonActor(t.web, "stranger", { origin: "https://other.example", key: 1 });
    await followed(t, stranger, DAVE);
    const hidden = await delivered(t, stranger, mastodonNote(stranger));
    // A public status whose author blocks alice (R2).
    expect(
      await t.post(stranger, {
        "@context": AS,
        id: `${stranger.uri}#blocks/1`,
        type: "Block",
        actor: stranger.uri,
        object: ALICE_URI,
      }),
    ).toBe(202);
    expect(await context(t, hidden)).toMatchObject({ status: 404, header: null });
    // The start itself refuses it too (R3), whoever calls it.
    expect(await start(t, hidden)).toEqual({ status: "ok", value: null });
    expect(await walkOf(t, hidden)).toBeUndefined();
    // dave, who follows the author, starts one.
    expect((await context(t, hidden, "dave")).match).not.toBeNull();
  });

  it("makes no start call while the env is in maintenance, and answers without a header while the Store refuses writes", async () => {
    const { t, root } = await world();
    const id = await delivered(t, root, mastodonNote(root));
    const counting = countingStore(t.store);
    const read = (env: Record<string, unknown>) =>
      harness(counting.stub, env, BUILD, { keygen: fixtureKeyGen, loader: t.web.loader }, () => clock.now).request(
        `/api/v1/statuses/${id}/context`,
        { headers: { authorization: `Bearer ${t.tokens.alice}` } },
      );
    const readonly = await read({ MAINTENANCE: "readonly" });
    expect([readonly.status, readonly.headers.get(HEADER)]).toEqual([200, null]);
    expect(counting.calls).not.toContain("startRepliesRefresh");
    await t.store.setMaintenance(BUILD, true);
    const refused = await read({});
    expect([refused.status, refused.headers.get(HEADER)]).toEqual([200, null]);
    expect(counting.calls).toContain("startRepliesRefresh");
    expect(await walkOf(t, id)).toBeUndefined();
    await t.store.setMaintenance(BUILD, false);
    const started = await read({});
    expect(REFRESH.test(started.headers.get(HEADER) ?? "")).toBe(true);
  });

  it("answers two due reads with one refresh: the start held behind the other's names the other's", async () => {
    const { t, root } = await world();
    const id = await delivered(t, root, mastodonNote(root));
    const { h, arrived, release } = heldStart(t);
    const read = () =>
      h.request(`/api/v1/statuses/${id}/context`, { headers: { authorization: `Bearer ${t.tokens.alice}` } });
    const late = read();
    await arrived;
    const other = (await read()).headers.get(HEADER);
    release();
    expect(REFRESH.test(other ?? "")).toBe(true);
    expect((await late).headers.get(HEADER)).toBe(other);
    expect(await sql(t.store, "SELECT refresh_id FROM reply_walks")).toEqual([
      { refresh_id: REFRESH.exec(other!)![1] },
    ]);
  });

  it("asks for a jobs round after a start", async () => {
    const { t, root } = await world();
    const id = await delivered(t, root, mastodonNote(root));
    const read = await context(t, id);
    expect(read.match).not.toBeNull();
    expect(read.sent).toContainEqual({ kind: "inbound-jobs" });
    // A read that starts none asks for none.
    expect(await context(t, id)).toMatchObject({ starts: 0, sent: [] });
  });

  it("asks for no jobs round after a due read's start that starts none", async () => {
    const { t, root } = await world();
    const id = await delivered(t, root, mastodonNote(root));
    const { h, arrived, release } = heldStart(t);
    const late = h.request(`/api/v1/statuses/${id}/context`, {
      headers: { authorization: `Bearer ${t.tokens.alice}` },
    });
    await arrived;
    // A refresh started and finished between the read and its start: within REPLIES_COOLDOWN_MS.
    await sql(
      t.store,
      `INSERT INTO reply_walks (status_id, kind, refresh_id, queued_at, finished_at) VALUES (?1, 0, ?2, ?3, ?3)`,
      id,
      "b".repeat(32),
      NOW,
    );
    release();
    expect((await late).headers.get(HEADER)).toBeNull();
    expect(h.queue.pending).toEqual([]);
  });

  it("exposes the header to browser clients", async () => {
    const { t, root } = await world();
    const id = await delivered(t, root, mastodonNote(root));
    const response = await t.request(`/api/v1/statuses/${id}/context`, {
      headers: { authorization: `Bearer ${t.tokens.alice}`, origin: "https://client.example" },
    });
    expect(response.headers.get("access-control-expose-headers")).toBe("Link,Mastodon-Async-Refresh");
    expect(REFRESH.test(response.headers.get(HEADER) ?? "")).toBe(true);
  });
});

describe("GET /api/v1_alpha/async_refreshes/:id", () => {
  const poll = async (t: Setup, id: string, token: string = t.tokens.alice) => {
    const response = await t.request(`/api/v1_alpha/async_refreshes/${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: response.status, body: await response.json<unknown>() };
  };
  const NOT_FOUND = { status: 404, body: { error: "Not Found" } };

  it("answers a user's token under read and refuses any other, as Mastodon's (AUTH-2)", async () => {
    const h = await apiHarness();
    const alice = await seedAccount(h.store, { username: "alice", email: "alice@example.com" });
    const route = `/api/v1_alpha/async_refreshes/${"0".repeat(32)}`;
    const send = async (token?: string) => {
      const response = await h.request(route, token === undefined ? {} : bearer(token));
      return { status: response.status, body: await response.json<unknown>() };
    };
    expect(await send(await scopedToken(h, "read"))).toEqual(NOT_FOUND);
    expect((await send()).status).toBe(401);
    expect((await send("nope")).status).toBe(401);
    expect(await send(await scopedToken(h, "write"))).toEqual({
      status: 403,
      body: { error: "This action is outside the authorized scopes" },
    });
    expect(await send(await appTokenWith(h, "read"))).toEqual({
      status: 422,
      body: { error: "This method requires an authenticated user" },
    });
    const token = await scopedToken(h, "read");
    await sql(h.store, "UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?", "2026-01-01", alice);
    expect((await send(token)).status).toBe(403);
  });

  it("reports a refresh while it runs and until REFRESH_FINISHED_MS after it finished, to any user", async () => {
    const { t, root } = await world();
    const statusId = await delivered(t, root, mastodonNote(root));
    const id = (await context(t, statusId)).match![1]!;
    expect(await poll(t, id)).toEqual({
      status: 200,
      body: { async_refresh: { id, status: "running", result_count: 0 } },
    });
    expect(await poll(t, id, t.tokens.dave)).toEqual({
      status: 200,
      body: { async_refresh: { id, status: "running", result_count: 0 } },
    });
    await sql(
      t.store,
      "UPDATE reply_walks SET due_at = NULL, finished_at = ?1, result_count = 3 WHERE status_id = ?2",
      NOW + 1000,
      statusId,
    );
    at(NOW + 1000 + REFRESH_FINISHED_MS - 1);
    expect(await poll(t, id)).toEqual({
      status: 200,
      body: { async_refresh: { id, status: "finished", result_count: 3 } },
    });
    at(NOW + 1000 + REFRESH_FINISHED_MS);
    expect(await poll(t, id)).toEqual(NOT_FOUND);
  });

  it("answers 404 for a refresh started REFRESH_RUNNING_MS ago and never finished, and for an unknown id", async () => {
    const { t, root } = await world();
    const statusId = await delivered(t, root, mastodonNote(root));
    const id = (await context(t, statusId)).match![1]!;
    // An id no refresh holds, while one runs.
    expect(await poll(t, "0".repeat(32))).toEqual(NOT_FOUND);
    at(NOW + REFRESH_RUNNING_MS - 1);
    expect((await poll(t, id)).status).toBe(200);
    at(NOW + REFRESH_RUNNING_MS);
    expect(await poll(t, id)).toEqual(NOT_FOUND);
  });

  it("answers 404 for an id that is not 32 lowercase hex characters, reading no walk", async () => {
    const { t, root } = await world();
    const statusId = await delivered(t, root, mastodonNote(root));
    const id = (await context(t, statusId)).match![1]!;
    const credential = { tokenHash: await sha256Hex(t.tokens.alice), scope: "read" as const, now: clock.now };
    const read = (input: string) => measuredStatements(t, getAsyncRefresh, { credential, id: input, now: clock.now });
    for (const malformed of [`${id}0`, id.slice(1), "A".repeat(32), "g".repeat(32), "abc", statusId]) {
      expect(await poll(t, malformed), malformed).toEqual(NOT_FOUND);
      const { output, statements } = await read(malformed);
      expect(output, malformed).toEqual({ status: "ok", value: null });
      expect(
        statements.filter((statement) => statement.query.includes("reply_walks")),
        malformed,
      ).toEqual([]);
    }
    // A well-formed id is one key read.
    const { output, statements } = await read(id);
    expect(output).toEqual({ status: "ok", value: { id, status: "running", resultCount: 0 } });
    expect(statements.filter((statement) => statement.query.includes("reply_walks"))).toHaveLength(1);
  });

  it("reads a refresh started again after the cooldown under the earlier id, running", async () => {
    const { t, root } = await world();
    const statusId = await delivered(t, root, mastodonNote(root));
    const id = (await context(t, statusId)).match![1]!;
    await sql(
      t.store,
      "UPDATE reply_walks SET due_at = NULL, finished_at = ?1, result_count = 2 WHERE status_id = ?2",
      NOW,
      statusId,
    );
    at(NOW + REPLIES_COOLDOWN_MS);
    expect((await context(t, statusId)).match?.[1]).toBe(id);
    expect(await poll(t, id)).toEqual({
      status: 200,
      body: { async_refresh: { id, status: "running", result_count: 0 } },
    });
  });
});
