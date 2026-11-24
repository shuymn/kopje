import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AV_WRITE_WINDOW_MS, DETACHED_GRACE_MS, ORPHAN_GRACE_MS, WRITE_WINDOW_MS } from "../src/domain/media";
import { reconcileMedia, sweepMedia } from "../src/mastodon/media";
import { sha256Hex } from "../src/security/tokens";
import { bearer, json, sql } from "./api-helpers";
import { BUILD } from "./helpers";
import {
  ACTIVE,
  type AvWorld,
  avWorld,
  clock,
  completed,
  fileToken,
  held,
  HOUR,
  MINUTE,
  queued,
  reserve,
  SECOND,
  staged,
  started,
  T0,
  TEXT,
  type Up,
  VIDEO,
} from "./media-processing-helpers";

// One media clock and one path per reservation (#1828 plan section 3, "PR4-1"): every comparison with a time stored on
// media_attachments is made at the Store's time, and a reservation made as an AV candidate takes exactly one path, the
// image path (startTransforms sets `image`) or the AV path (S1 sets the provisional AV type), chosen by the first of
// the two; each refuses a reservation the other chose, a doomed one and a finished one, and nothing revives a doom.

afterEach(() => {
  vi.useRealTimers();
});

const BUDGETS = { instance: 1_000_000, account: 1_000_000 };

const image = (w: AvWorld, id: string) => ({
  credential: w.alice,
  id,
  contentType: "image/webp",
  original: { width: 10, height: 10 },
  small: { width: 10, height: 10 },
  animated: false,
  blurhash: null,
  description: "",
  focus: undefined,
});

function startImage(w: AvWorld, id: string) {
  return w.store.startTransforms(BUILD, { credential: w.alice, id, monthlyTransforms: BUDGETS, now: Date.now() });
}

function takeSlot(w: AvWorld, up: Up) {
  return w.store.takeAvSlot(BUILD, { id: up.id, token: up.token, kind: "video", v1Left: null, activation: ACTIVE });
}

function post(w: AvWorld, id: string) {
  return w.h.request(
    "/api/v1/statuses",
    bearer(w.h.users.alice.token, json({ status: "with media", media_ids: [id] })),
  );
}

const sweepDeps = (w: AvWorld) => ({ build: () => BUILD, store: () => w.store });

// ---- The table: one case per (path state × operation)

type State =
  | "unknown"
  | "image started"
  | "image completed"
  | "AV staging"
  | "AV pending"
  | "AV running"
  | "AV completed"
  | "doomed"
  | "abandoned";

type Op =
  | "startTransforms"
  | "completeMedia"
  | "abandonMedia"
  | "S1"
  | "S3"
  | "S6"
  | "S11"
  | "attach"
  | "expiredMedia/purgeMedia"
  | "dueOrphans";

// An upload in a state, with what the AV operations need of it.
type Built = Up & { stagedAt: number; startId: string };

// Each state built at the Store's times T0 (the reservation) to T0 + 4 s; every operation then runs at AT.
const AT = T0 + 5 * SECOND;

async function build(w: AvWorld, state: State): Promise<Built> {
  const none = { stagedAt: T0 + SECOND, startId: "none" };
  switch (state) {
    case "unknown":
      return { ...(await reserve(w, T0)), ...none };
    case "image started": {
      const up = await reserve(w, T0);
      clock(T0 + SECOND);
      expect(await startImage(w, up.id)).toEqual({ status: "ok", value: { status: "ok" } });
      return { ...up, ...none };
    }
    case "image completed": {
      const up = await reserve(w, T0);
      clock(T0 + SECOND);
      await startImage(w, up.id);
      expect(await w.store.completeMedia(BUILD, image(w, up.id))).toMatchObject({ value: { id: up.id } });
      return { ...up, ...none };
    }
    case "AV staging":
      return { ...(await staged(w)), startId: "none" };
    case "AV pending":
      return { ...(await queued(w)), startId: "none" };
    case "AV running":
      return started(w);
    case "AV completed":
      return completed(w);
    case "doomed": {
      const up = await reserve(w, T0);
      clock(T0 + SECOND);
      expect(await w.store.deleteAvUpload(BUILD, { credential: w.alice, id: up.id })).toEqual({
        status: "ok",
        value: "deleted",
      });
      return { ...up, ...none };
    }
    case "abandoned": {
      const up = await reserve(w, T0);
      clock(T0 + SECOND);
      expect(await w.store.abandonMedia(BUILD, { credential: w.alice, id: up.id })).toEqual({
        status: "ok",
        value: "abandoned",
      });
      return { ...up, ...none };
    }
  }
}

// What each operation answers, reduced to what the table compares.
const OPS: Record<Op, (w: AvWorld, b: Built) => Promise<unknown>> = {
  startTransforms: async (w, b) => ((await startImage(w, b.id)) as { value: { status: string } }).value.status,
  completeMedia: async (w, b) => {
    const done = (await w.store.completeMedia(BUILD, image(w, b.id))) as { value: { type: string } | null };
    return done.value === null ? null : done.value.type;
  },
  abandonMedia: async (w, b) =>
    ((await w.store.abandonMedia(BUILD, { credential: w.alice, id: b.id })) as { value: string }).value,
  S1: async (w, b) => (await takeSlot(w, b)).status,
  S3: async (w, b) =>
    (
      await w.store.queueNormalize(BUILD, {
        id: b.id,
        token: b.token,
        stagedAt: b.stagedAt,
        bytes: 2_000_000,
        text: TEXT,
        activation: ACTIVE,
      })
    ).status,
  S6: async (w, b) =>
    (await w.store.completeAvUpload(BUILD, { id: b.id, token: b.token, startId: b.startId, facts: VIDEO })).status,
  S11: async (w, b) =>
    ((await w.store.deleteAvUpload(BUILD, { credential: w.alice, id: b.id })) as { value: string }).value,
  attach: async (w, b) => (await post(w, b.id)).status,
  "expiredMedia/purgeMedia": async (w, b) => {
    const selected = (await w.store.expiredMedia(BUILD, { limit: 100 })).map((m) => m.id);
    const purged = await w.store.purgeMedia(BUILD, { ids: selected });
    return { selected: selected.includes(b.id), purged };
  },
  // The tombstone the purge at AT leaves, and whether reconciliation takes it just before it falls due and at it.
  dueOrphans: async (w, b) => {
    const selected = (await w.store.expiredMedia(BUILD, { limit: 100 })).map((m) => m.id);
    await w.store.purgeMedia(BUILD, { ids: selected });
    const [tomb] = await sql<{ delete_after: string }>(
      w.store,
      "SELECT delete_after FROM media_orphans WHERE media_id = ?",
      b.id,
    );
    if (tomb === undefined) {
      return null;
    }
    const due = Date.parse(tomb.delete_after);
    clock(due - 1);
    const before = (await w.store.dueOrphans(BUILD)).some((o) => o.id === b.id);
    clock(due);
    const at = (await w.store.dueOrphans(BUILD)).some((o) => o.id === b.id);
    return { due: due - T0, before, at };
  },
};

// A candidate's own write window: an `unknown` reservation that is purged unfinished keeps the image window, one S1
// took the AV window (media.ts writeDeadline), each from the reservation at T0, past AT.
const IMAGE_TOMBSTONE = { due: WRITE_WINDOW_MS + ORPHAN_GRACE_MS, before: false, at: true };
const NOT_SWEPT = { selected: false, purged: 0 };
const SWEPT = { selected: true, purged: 1 };

const TABLE: Record<State, Record<Op, unknown>> = {
  unknown: {
    startTransforms: "ok",
    completeMedia: null,
    abandonMedia: "abandoned",
    S1: "taken",
    S3: "gone",
    S6: "refused",
    S11: "deleted",
    attach: 422,
    "expiredMedia/purgeMedia": NOT_SWEPT,
    dueOrphans: null,
  },
  "image started": {
    startTransforms: "ok",
    completeMedia: "image",
    abandonMedia: "abandoned",
    S1: "gone",
    S3: "gone",
    S6: "refused",
    S11: "not_found",
    attach: 422,
    "expiredMedia/purgeMedia": NOT_SWEPT,
    dueOrphans: null,
  },
  "image completed": {
    startTransforms: "expired",
    completeMedia: "image",
    abandonMedia: "kept",
    S1: "gone",
    S3: "gone",
    S6: "refused",
    S11: "deleted",
    attach: 200,
    "expiredMedia/purgeMedia": NOT_SWEPT,
    dueOrphans: null,
  },
  "AV staging": {
    startTransforms: "expired",
    completeMedia: null,
    abandonMedia: "kept",
    S1: "taken",
    S3: "queued",
    S6: "refused",
    S11: "not_found",
    attach: 422,
    "expiredMedia/purgeMedia": NOT_SWEPT,
    dueOrphans: null,
  },
  "AV pending": {
    startTransforms: "expired",
    completeMedia: null,
    abandonMedia: "kept",
    S1: "gone",
    S3: "queued",
    S6: "refused",
    S11: "deleted",
    attach: 422,
    "expiredMedia/purgeMedia": NOT_SWEPT,
    dueOrphans: null,
  },
  "AV running": {
    startTransforms: "expired",
    completeMedia: null,
    abandonMedia: "kept",
    S1: "gone",
    S3: "settled",
    S6: "done",
    S11: "deleted",
    attach: 422,
    "expiredMedia/purgeMedia": NOT_SWEPT,
    dueOrphans: null,
  },
  "AV completed": {
    startTransforms: "expired",
    completeMedia: null,
    abandonMedia: "kept",
    S1: "gone",
    S3: "settled",
    S6: "done",
    S11: "deleted",
    attach: 200,
    "expiredMedia/purgeMedia": NOT_SWEPT,
    dueOrphans: null,
  },
  doomed: {
    startTransforms: "expired",
    completeMedia: null,
    abandonMedia: "abandoned",
    S1: "gone",
    S3: "gone",
    S6: "refused",
    S11: "not_found",
    attach: 422,
    "expiredMedia/purgeMedia": SWEPT,
    dueOrphans: IMAGE_TOMBSTONE,
  },
  abandoned: {
    startTransforms: "expired",
    completeMedia: null,
    abandonMedia: "abandoned",
    S1: "gone",
    S3: "gone",
    S6: "refused",
    S11: "not_found",
    attach: 422,
    "expiredMedia/purgeMedia": SWEPT,
    dueOrphans: IMAGE_TOMBSTONE,
  },
};

describe("one path per reservation: every (path state × operation)", () => {
  const cases = Object.entries(TABLE).flatMap(([state, row]) =>
    Object.entries(row).map(([op, expected]) => [state as State, op as Op, expected] as const),
  );

  it("covers every state and operation of the plan", () => {
    expect(cases).toHaveLength(9 * 10);
  });

  it.each(cases)("%s × %s", async (state, op, expected) => {
    const w = await avWorld();
    const built = await build(w, state);
    clock(AT);
    expect(await OPS[op](w, built)).toEqual(expected);
  });
});

// ---- The r3 interleavings

// An explicit await point: the actor that awaits `point` stays there until the test calls `release`.
function holdPoint(): { point: Promise<void>; release: () => void } {
  let release = () => {};
  const point = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { point, release };
}

// The media bucket, its deletes held after they settle: `deleted` resolves once the sweep's R2 deletion is done, and
// the sweep waits there, before its purge, until `release`.
function heldBucket() {
  const deleted = holdPoint();
  const purge = holdPoint();
  const bucket = new Proxy(env.MEDIA, {
    get(target, property) {
      if (property === "delete") {
        return async (keys: string | string[]) => {
          await target.delete(keys);
          deleted.release();
          await purge.point;
        };
      }
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { bucket, deleted: deleted.point, release: purge.release };
}

describe("the r3 interleavings, each actor held at an explicit await", () => {
  it("S11 before the image start: the candidate is doomed, and the image start and completion, held until after the sweep's deletion, are refused", async () => {
    const w = await avWorld();
    const up = await reserve(w, T0);
    // The image route has read the body and is held before its start.
    const route = holdPoint();
    const imageRoute = (async () => {
      await route.point;
      const start = await startImage(w, up.id);
      const done = await w.store.completeMedia(BUILD, image(w, up.id));
      return { start, done };
    })();
    const { bucket, deleted, release } = heldBucket();
    try {
      clock(T0 + SECOND);
      expect(await w.store.deleteAvUpload(BUILD, { credential: w.alice, id: up.id })).toEqual({
        status: "ok",
        value: "deleted",
      });
      // The sweep selects the doomed row and deletes its keys; it is held before its purge.
      const sweep = sweepMedia({ ...env, MEDIA: bucket }, sweepDeps(w));
      await deleted;
      clock(T0 + 2 * SECOND);
      route.release();
      expect(await imageRoute).toEqual({
        start: { status: "ok", value: { status: "expired" } },
        done: { status: "ok", value: null },
      });
      release();
      expect(await sweep).toBe(1);
      expect((await held(w.store, up.id)).att).toBeNull();
    } finally {
      route.release();
      release();
    }
  });

  it("the image start before S11: S11, made while the image route is held, answers not_found and the image completes", async () => {
    const w = await avWorld();
    const up = await reserve(w, T0);
    clock(T0 + SECOND);
    expect(await startImage(w, up.id)).toEqual({ status: "ok", value: { status: "ok" } });
    // The image route has written its files and is held before its completion.
    const route = holdPoint();
    const completion = (async () => {
      await route.point;
      return w.store.completeMedia(BUILD, image(w, up.id));
    })();
    try {
      clock(T0 + 2 * SECOND);
      expect(await w.store.deleteAvUpload(BUILD, { credential: w.alice, id: up.id })).toEqual({
        status: "ok",
        value: "not_found",
      });
      expect(await w.store.expiredMedia(BUILD, { limit: 100 })).toEqual([]);
      clock(T0 + 3 * SECOND);
      route.release();
      expect(await completion).toMatchObject({ status: "ok", value: { id: up.id, type: "image" } });
      expect((await held(w.store, up.id)).att).toMatchObject({
        processed: 1,
        gc_at: new Date(T0 + 3 * SECOND + DETACHED_GRACE_MS).toISOString(),
      });
    } finally {
      route.release();
    }
  });

  it("the image start first: S1, made while the image route is held, answers gone and the image completes", async () => {
    const w = await avWorld();
    const up = await reserve(w, T0);
    clock(T0 + SECOND);
    expect(await startImage(w, up.id)).toEqual({ status: "ok", value: { status: "ok" } });
    const route = holdPoint();
    const completion = (async () => {
      await route.point;
      return w.store.completeMedia(BUILD, image(w, up.id));
    })();
    try {
      clock(T0 + 2 * SECOND);
      expect(await takeSlot(w, up)).toEqual({ status: "gone" });
      route.release();
      expect(await completion).toMatchObject({ status: "ok", value: { id: up.id, type: "image" } });
      expect(await held(w.store, up.id)).toMatchObject({ row: null, slot: null });
    } finally {
      route.release();
    }
  });

  it("S1 and S3 first: the image start, made while the AV route is held after S3, is refused and the AV upload goes on", async () => {
    const w = await avWorld();
    const up = await reserve(w, T0);
    clock(T0 + SECOND);
    const taken = await takeSlot(w, up);
    if (taken.status !== "taken") {
      throw new Error(taken.status);
    }
    clock(T0 + 2 * SECOND);
    const queuedAnswer = await w.store.queueNormalize(BUILD, {
      id: up.id,
      token: up.token,
      stagedAt: taken.stagedAt,
      bytes: 2_000_000,
      text: TEXT,
      activation: ACTIVE,
    });
    expect(queuedAnswer).toMatchObject({ status: "queued" });
    // The AV route holds before its next step (the processor's start).
    const route = holdPoint();
    const av = (async () => {
      await route.point;
      return w.store.startNormalize(BUILD, { id: up.id, token: up.token, invocation: "inv" });
    })();
    try {
      clock(T0 + 3 * SECOND);
      expect(await startImage(w, up.id)).toEqual({ status: "ok", value: { status: "expired" } });
      expect(await w.store.completeMedia(BUILD, image(w, up.id))).toEqual({ status: "ok", value: null });
      route.release();
      expect(await av).toMatchObject({ status: "started" });
      expect((await held(w.store, up.id)).att).toMatchObject({ processed: 0, type: "video" });
    } finally {
      route.release();
    }
  });

  it("a purged AV upload's tombstone keeps its authority until the Store's purge time + ORPHAN_GRACE_MS", async () => {
    const w = await avWorld();
    const c = await queued(w);
    clock(T0 + 3 * SECOND);
    await w.store.deleteAvUpload(BUILD, { credential: w.alice, id: c.id });
    // Purged past the AV write deadline (the reservation + 30 minutes), so the tombstone runs from the purge.
    const purgedAt = T0 + AV_WRITE_WINDOW_MS + MINUTE;
    clock(purgedAt);
    expect(await sweepMedia(env, sweepDeps(w))).toBe(1);
    expect(await sql(w.store, "SELECT delete_after FROM media_orphans WHERE media_id = ?", c.id)).toEqual([
      { delete_after: new Date(purgedAt + ORPHAN_GRACE_MS).toISOString() },
    ]);
    clock(purgedAt + ORPHAN_GRACE_MS - 1);
    expect(await reconcileMedia(env, sweepDeps(w))).toBe(0);
    clock(purgedAt + ORPHAN_GRACE_MS);
    expect(await reconcileMedia(env, sweepDeps(w))).toBe(1);
  });

  it("a post from a Worker 2 s behind cannot attach a completed upload the sweep selected at its gc_at", async () => {
    const w = await avWorld();
    clock(T0);
    const token = fileToken();
    const reserved = await w.store.reserveMedia(BUILD, {
      credential: w.alice,
      token,
      monthlyTransforms: BUDGETS,
      now: T0,
    });
    if (reserved.status !== "ok" || reserved.value.status !== "ok") {
      throw new Error("not reserved");
    }
    const id = reserved.value.id;
    clock(T0 + SECOND);
    await startImage(w, id);
    expect(await w.store.completeMedia(BUILD, image(w, id))).toMatchObject({ value: { id } });
    const gcAt = T0 + SECOND + DETACHED_GRACE_MS;
    expect((await held(w.store, id)).att?.gc_at).toBe(new Date(gcAt).toISOString());
    clock(gcAt + SECOND);
    const { bucket, deleted, release } = heldBucket();
    try {
      const sweep = sweepMedia({ ...env, MEDIA: bucket }, sweepDeps(w));
      await deleted;
      // The sweep has deleted the upload's files and is held before its purge; a post made with a Worker clock behind
      // the gc_at arrives now.
      w.h.now.mockReturnValue(gcAt - SECOND);
      const posted = await post(w, id);
      expect([posted.status, await posted.json()]).toEqual([
        422,
        { error: `Media ${id} not found or already attached to another post` },
      ]);
      release();
      expect(await sweep).toBe(1);
      expect((await held(w.store, id)).att).toBeNull();
    } finally {
      release();
    }
  });
});

describe("an abandoned candidate", () => {
  it("is doomed and never live: GET answers not found", async () => {
    const w = await avWorld();
    const up = await reserve(w, T0);
    expect(await w.store.abandonMedia(BUILD, { credential: w.alice, id: up.id })).toEqual({
      status: "ok",
      value: "abandoned",
    });
    expect(await w.store.getMedia(BUILD, { credential: w.alice, id: up.id })).toEqual({ status: "ok", value: null });
    expect(await sql(w.store, "SELECT gc_at, url FROM media_attachments WHERE id = ?", up.id)).toEqual([
      { gc_at: new Date(0).toISOString(), url: "" },
    ]);
  });
});

// An image upload of alice's, reserved without avCandidate and completed at the Store's `at`.
async function completedImage(w: AvWorld, at: number): Promise<string> {
  clock(at);
  const reserved = await w.store.reserveMedia(BUILD, {
    credential: w.alice,
    token: fileToken(),
    monthlyTransforms: BUDGETS,
    now: at,
  });
  if (reserved.status !== "ok" || reserved.value.status !== "ok") {
    throw new Error("not reserved");
  }
  const { id } = reserved.value;
  await startImage(w, id);
  expect(await w.store.completeMedia(BUILD, image(w, id))).toMatchObject({ value: { id } });
  return id;
}

describe("one media clock beyond the upload: every write and check of a stored media time is the Store's", () => {
  it("stamps a reservation made without avCandidate at the Store's time, whatever time the request carries", async () => {
    const w = await avWorld();
    clock(T0);
    const reserved = await w.store.reserveMedia(BUILD, {
      credential: w.alice,
      token: fileToken(),
      monthlyTransforms: BUDGETS,
      now: T0 + 3 * SECOND,
    });
    if (reserved.status !== "ok" || reserved.value.status !== "ok") {
      throw new Error("not reserved");
    }
    expect(await sql(w.store, "SELECT created_at FROM media_attachments WHERE id = ?", reserved.value.id)).toEqual([
      { created_at: new Date(T0).toISOString() },
    ]);
    // The answer's deadline is the request's own reading plus the window.
    expect(reserved.value.deadline).toBe(T0 + 3 * SECOND + WRITE_WINDOW_MS);
  });

  it("an edit from a Worker 2 s behind cannot attach a completed upload past its gc_at on the Store's clock", async () => {
    const w = await avWorld();
    const id = await completedImage(w, T0);
    clock(T0 + SECOND);
    const posted = await w.h.request("/api/v1/statuses", bearer(w.h.users.alice.token, json({ status: "text" })));
    const { id: statusId } = await posted.json<{ id: string }>();
    const gcAt = T0 + DETACHED_GRACE_MS;
    clock(gcAt + SECOND);
    w.h.now.mockReturnValue(gcAt - SECOND);
    const edited = await w.h.request(
      `/api/v1/statuses/${statusId}`,
      bearer(w.h.users.alice.token, json({ status: "text", media_ids: [id] }, { method: "PUT" })),
    );
    expect([edited.status, await edited.json()]).toEqual([
      422,
      { error: `Media ${id} not found or already attached to another post` },
    ]);
  });

  it("a status's deletion detaches its media for a day from the Store's time, the Worker an hour behind", async () => {
    const w = await avWorld();
    const id = await completedImage(w, T0);
    clock(T0 + SECOND);
    const posted = await post(w, id);
    expect(posted.status).toBe(200);
    const { id: statusId } = await posted.json<{ id: string }>();
    clock(T0 + 2 * SECOND);
    w.h.now.mockReturnValue(T0 + 2 * SECOND - HOUR);
    const deleted = await w.h.request(
      `/api/v1/statuses/${statusId}`,
      bearer(w.h.users.alice.token, { method: "DELETE" }),
    );
    expect(deleted.status).toBe(200);
    expect((await held(w.store, id)).att?.gc_at).toBe(new Date(T0 + 2 * SECOND + DETACHED_GRACE_MS).toISOString());
  });

  it("a scheduled status's deletion detaches its media for a day from the Store's time, the Worker an hour behind", async () => {
    const w = await avWorld();
    const id = await completedImage(w, T0);
    clock(T0 + SECOND);
    const scheduled = await w.h.request(
      "/api/v1/statuses",
      bearer(
        w.h.users.alice.token,
        json({ status: "later", media_ids: [id], scheduled_at: new Date(T0 + 2 * HOUR).toISOString() }),
      ),
    );
    expect(scheduled.status).toBe(200);
    const { id: scheduledId } = await scheduled.json<{ id: string }>();
    clock(T0 + 2 * SECOND);
    w.h.now.mockReturnValue(T0 + 2 * SECOND - HOUR);
    const deleted = await w.h.request(
      `/api/v1/scheduled_statuses/${scheduledId}`,
      bearer(w.h.users.alice.token, { method: "DELETE" }),
    );
    expect(deleted.status).toBe(200);
    expect((await held(w.store, id)).att?.gc_at).toBe(new Date(T0 + 2 * SECOND + DETACHED_GRACE_MS).toISOString());
  });

  it("a profile update judges its upload live at the Store's time: past its gc_at there, the upload is gone", async () => {
    const w = await avWorld();
    const id = await completedImage(w, T0);
    const gcAt = T0 + DETACHED_GRACE_MS;
    const credential = { tokenHash: await sha256Hex(w.h.users.alice.token), scope: "write:accounts" as const, now: T0 };
    const update = () =>
      w.store.updateCredentials(BUILD, {
        credential,
        changes: {},
        images: { avatar: id },
        present: { origin: "https://kopje.test" },
        now: gcAt - SECOND,
      });
    clock(gcAt + SECOND);
    expect(await update()).toEqual({ status: "ok", value: { status: "upload_gone" } });
    // The control: before its gc_at on the Store's clock, the same request applies it.
    clock(gcAt - SECOND);
    expect(await update()).toMatchObject({ status: "ok", value: { status: "ok" } });
  });
});

describe("a row without a URL is never live, nor a doomed one completed", () => {
  it("an upload processed without its URL, as an import may leave one, is neither shown nor attachable", async () => {
    const w = await avWorld();
    const id = await completedImage(w, T0);
    await sql(w.store, "UPDATE media_attachments SET url = '', gc_at = NULL WHERE id = ?", id);
    clock(T0 + SECOND);
    expect(await w.store.getMedia(BUILD, { credential: w.alice, id })).toEqual({ status: "ok", value: null });
    expect((await post(w, id)).status).toBe(422);
  });

  it("completeMedia refuses a doomed image-path reservation, as a later delete would leave it", async () => {
    const w = await avWorld();
    const up = await reserve(w, T0);
    clock(T0 + SECOND);
    expect(await startImage(w, up.id)).toEqual({ status: "ok", value: { status: "ok" } });
    await sql(w.store, "UPDATE media_attachments SET gc_at = ? WHERE id = ?", new Date(0).toISOString(), up.id);
    expect(await w.store.completeMedia(BUILD, image(w, up.id))).toEqual({ status: "ok", value: null });
    expect((await held(w.store, up.id)).att).toMatchObject({ processed: 0, gc_at: new Date(0).toISOString() });
  });
});
