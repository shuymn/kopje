import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AV_WRITE_WINDOW_MS, DETACHED_GRACE_MS, ORPHAN_GRACE_MS, WRITE_WINDOW_MS } from "../src/domain/media";
import { MAX_ATTEMPTS } from "../src/domain/scheduled-statuses";
import { handleScheduled, publishScheduled } from "../src/jobs/scheduled";
import { uploadEmoji } from "../src/mastodon/emoji-upload";
import { reconcileMedia, sweepMedia } from "../src/mastodon/media";
import { mediaKeys, restoreMarkerKey } from "../src/platform/media-files";
import { toStoreUnavailable } from "../src/platform/store-errors";
import { sha256Hex } from "../src/security/tokens";
import { startImagePath } from "../src/store";
import { bearer, json, sql } from "./api-helpers";
import { BUILD, deferred, rejectionOf, testKernel } from "./helpers";
import { base64, pngOf } from "./local-emoji-helpers";
import { TestCodec } from "./media-helpers";
import {
  ACTIVE,
  type AvWorld,
  avWorld,
  bookmark,
  clock,
  completed,
  fileToken,
  gate,
  held,
  HOUR,
  MINUTE,
  queued,
  reserve,
  restore,
  SECOND,
  staged,
  started,
  T0,
  type Up,
  VIDEO,
  queue,
  imageCompletion,
} from "./media-processing-helpers";
import { ACCESS, setAccess } from "./ops-helpers";

// One media clock and one path per reservation (#1828 plan section 3, "PR4-1"): every comparison with a time stored on
// media_attachments is made at the Store's time, and a reservation made as an AV candidate takes exactly one path, the
// image path (startTransforms sets `image`) or the AV path (S1 sets the provisional AV type), chosen by the first of
// the two; each refuses a reservation the other chose, a doomed one and a finished one, and nothing revives a doom.

afterEach(() => {
  vi.useRealTimers();
});

const BUDGETS = { instance: 1_000_000, account: 1_000_000 };

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
  | "AV released"
  | "AV pending"
  | "AV running"
  | "AV completed"
  | "doomed"
  | "doomed image"
  | "abandoned";

type Op =
  | "startTransforms"
  | "completeMedia"
  | "abandonMedia"
  | "completeEmoji"
  | "abandonEmoji"
  | "S1"
  | "S3"
  | "S4"
  | "S6"
  | "S7"
  | "S9"
  | "S10"
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
      expect(await w.store.completeMedia(BUILD, imageCompletion(w, up.id))).toMatchObject({ value: { id: up.id } });
      return { ...up, ...none };
    }
    case "AV staging":
      return { ...(await staged(w)), startId: "none" };
    case "AV released": {
      // S1 took it, and S2 released its staging (the route refused the input after the sniff).
      const up = await staged(w);
      clock(T0 + 2 * SECOND);
      expect(await w.store.releaseStaging(BUILD, { id: up.id, token: up.token, stagedAt: up.stagedAt })).toEqual({
        status: "released",
      });
      return { ...up, startId: "none" };
    }
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
    case "doomed image": {
      // An image-path reservation doomed before it completed: no operation leaves one (S10 and S11 leave the image path
      // to its own rules), so it is written as a restore or an import might leave it.
      const up = await reserve(w, T0);
      clock(T0 + SECOND);
      expect(await startImage(w, up.id)).toEqual({ status: "ok", value: { status: "ok" } });
      await sql(w.store, "UPDATE media_attachments SET gc_at = ? WHERE id = ?", DOOMED, up.id);
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

const DOOMED = new Date(0).toISOString();

// A duration as hours, minutes, seconds and milliseconds ("24h5s"), "0" for none.
function span(ms: number): string {
  if (ms === 0) {
    return "0";
  }
  let rest = Math.abs(ms);
  let out = ms < 0 ? "-" : "";
  for (const [unit, size] of [
    ["h", HOUR],
    ["m", MINUTE],
    ["s", SECOND],
    ["ms", 1],
  ] as const) {
    const n = Math.floor(rest / size);
    if (n > 0) {
      out += `${n}${unit}`;
      rest -= n * size;
    }
  }
  return out;
}

// What the Store holds of an upload, in one line: the attachment's type, processed and gc_at (DOOMED_AT as `doomed`,
// a time as its distance from T0, `-` for NULL), its processing row's state, its slot's phase, and the tombstone that
// names it (its delete_after from T0), each `-` when there is none.
async function stateOf(w: AvWorld, id: string): Promise<string> {
  const { att, row, slot } = await held(w.store, id);
  const [tomb] = await sql<{ delete_after: string }>(
    w.store,
    "SELECT delete_after FROM media_orphans WHERE media_id = ?",
    id,
  );
  const gc = att?.gc_at == null ? "-" : att.gc_at === DOOMED ? "doomed" : span(Date.parse(att.gc_at) - T0);
  return [
    att === null ? "-" : `${att.type} ${att.processed} ${gc}`,
    row?.state ?? "-",
    slot?.phase ?? "-",
    tomb === undefined ? "-" : `tomb ${span(Date.parse(tomb.delete_after) - T0)}`,
  ].join(" | ");
}

const EMOJI = {
  authority: ACCESS,
  shortcode: "cell",
  category: null,
  visibleInPicker: true,
  replace: false,
  contentType: "image/png",
  original: { width: 16, height: 16 },
  small: { width: 16, height: 16 },
};

// What each operation answers, reduced to what the table compares.
const OPS: Record<Op, (w: AvWorld, b: Built) => Promise<unknown>> = {
  startTransforms: async (w, b) => ((await startImage(w, b.id)) as { value: { status: string } }).value.status,
  completeMedia: async (w, b) => {
    const done = (await w.store.completeMedia(BUILD, imageCompletion(w, b.id))) as { value: { type: string } | null };
    return done.value === null ? null : done.value.type;
  },
  abandonMedia: async (w, b) =>
    ((await w.store.abandonMedia(BUILD, { credential: w.alice, id: b.id })) as { value: string }).value,
  completeEmoji: async (w, b) => {
    await setAccess(w.store);
    const done = await w.store.completeEmoji(BUILD, { ...EMOJI, id: b.id, token: b.token });
    return done.ok ? "ok" : done.code;
  },
  abandonEmoji: async (w, b) => {
    await setAccess(w.store);
    return w.store.abandonEmoji(BUILD, { authority: ACCESS, id: b.id, token: b.token });
  },
  S1: async (w, b) => (await takeSlot(w, b)).status,
  S3: async (w, b) => (await queue(w, b, b.stagedAt)).status,
  S4: async (w, b) => {
    const answer = await w.store.startNormalize(BUILD, { id: b.id, token: b.token, invocation: "cell" });
    return answer.status === "settled" ? { settled: answer.state } : answer.status;
  },
  S6: async (w, b) =>
    (await w.store.completeAvUpload(BUILD, { id: b.id, token: b.token, startId: b.startId, facts: VIDEO })).status,
  S7: async (w, b) => {
    const answer = await w.store.failNormalize(BUILD, { id: b.id, startId: b.startId, cause: "verifier" });
    return answer.status === "gone" ? "gone" : answer;
  },
  S9: async (w, b) => (await w.store.v1Outcome(BUILD, { id: b.id, token: b.token })).status,
  S10: async (w, b) => (await w.store.v1Final(BUILD, { id: b.id, token: b.token })).status,
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

// A cell: the operation's answer, and what the Store holds after it (stateOf), SAME for the state as it was built.
const SAME = Symbol("same");
type Cell = [unknown, string | typeof SAME];

// What the Store holds of each state as it is built, at AT.
const BEFORE: Record<State, string> = {
  unknown: "unknown 0 1h | - | - | -",
  "image started": "image 0 1h | - | - | -",
  "image completed": "image 1 24h1s | - | - | -",
  "AV staging": "video 0 1h | staging | staging | -",
  "AV released": "video 0 1h | - | - | -",
  "AV pending": "video 0 1h | pending | processing | -",
  "AV running": "video 0 1h | running | processing | -",
  "AV completed": "video 1 24h4s | - | processing | -",
  doomed: "unknown 0 doomed | - | - | -",
  "doomed image": "image 0 doomed | - | - | -",
  abandoned: "unknown 1 doomed | - | - | -",
};

const TABLE: Record<State, Record<Op, Cell>> = {
  unknown: {
    startTransforms: ["ok", "image 0 1h | - | - | -"],
    completeMedia: [null, SAME],
    abandonMedia: ["abandoned", "unknown 1 doomed | - | - | -"],
    completeEmoji: ["upload-expired", SAME],
    abandonEmoji: ["kept", SAME],
    S1: ["taken", "video 0 1h | staging | staging | -"],
    S3: ["gone", SAME],
    S4: ["gone", SAME],
    S6: ["refused", SAME],
    S7: ["gone", SAME],
    S9: ["ended", SAME],
    S10: [503, "unknown 0 doomed | - | - | -"],
    S11: ["deleted", "unknown 0 doomed | - | - | -"],
    attach: [422, SAME],
    "expiredMedia/purgeMedia": [NOT_SWEPT, SAME],
    dueOrphans: [null, SAME],
  },
  "image started": {
    startTransforms: ["ok", SAME],
    completeMedia: ["image", "image 1 24h5s | - | - | -"],
    abandonMedia: ["abandoned", "image 1 5s | - | - | -"],
    completeEmoji: ["ok", "image 1 - | - | - | -"],
    abandonEmoji: ["abandoned", "image 1 5s | - | - | -"],
    S1: ["gone", SAME],
    S3: ["gone", SAME],
    S4: ["gone", SAME],
    S6: ["refused", SAME],
    S7: ["gone", SAME],
    S9: ["ended", SAME],
    S10: [503, SAME],
    S11: ["not_found", SAME],
    attach: [422, SAME],
    "expiredMedia/purgeMedia": [NOT_SWEPT, SAME],
    dueOrphans: [null, SAME],
  },
  "image completed": {
    startTransforms: ["expired", SAME],
    completeMedia: ["image", SAME],
    abandonMedia: ["kept", SAME],
    completeEmoji: ["upload-expired", SAME],
    abandonEmoji: ["kept", SAME],
    S1: ["gone", SAME],
    S3: ["gone", SAME],
    S4: ["gone", SAME],
    S6: ["refused", SAME],
    S7: ["gone", SAME],
    S9: ["ended", SAME],
    S10: [503, SAME],
    S11: ["deleted", "image 1 doomed | - | - | -"],
    attach: [200, "image 1 - | - | - | -"],
    "expiredMedia/purgeMedia": [NOT_SWEPT, SAME],
    dueOrphans: [null, SAME],
  },
  "AV staging": {
    startTransforms: ["expired", SAME],
    completeMedia: [null, SAME],
    abandonMedia: ["kept", SAME],
    completeEmoji: ["upload-expired", SAME],
    abandonEmoji: ["kept", SAME],
    S1: ["taken", SAME],
    S3: ["queued", "video 0 1h | pending | processing | -"],
    S4: ["gone", SAME],
    S6: ["refused", SAME],
    S7: ["gone", SAME],
    S9: ["processing", SAME],
    S10: [503, "video 0 doomed | - | staging | -"],
    S11: ["not_found", SAME],
    attach: [422, SAME],
    "expiredMedia/purgeMedia": [NOT_SWEPT, SAME],
    dueOrphans: [null, SAME],
  },
  "AV released": {
    startTransforms: ["expired", SAME],
    completeMedia: [null, SAME],
    abandonMedia: ["abandoned", "video 1 doomed | - | - | -"],
    completeEmoji: ["upload-expired", SAME],
    abandonEmoji: ["kept", SAME],
    S1: ["gone", SAME],
    S3: ["gone", SAME],
    S4: ["gone", SAME],
    S6: ["refused", SAME],
    S7: ["gone", SAME],
    S9: ["ended", SAME],
    S10: [503, "video 0 doomed | - | - | -"],
    S11: ["deleted", "video 0 doomed | - | - | -"],
    attach: [422, SAME],
    "expiredMedia/purgeMedia": [NOT_SWEPT, SAME],
    dueOrphans: [null, SAME],
  },
  "AV pending": {
    startTransforms: ["expired", SAME],
    completeMedia: [null, SAME],
    abandonMedia: ["kept", SAME],
    completeEmoji: ["upload-expired", SAME],
    abandonEmoji: ["kept", SAME],
    S1: ["gone", SAME],
    S3: ["queued", SAME],
    S4: ["started", "video 0 1h | running | processing | -"],
    S6: ["refused", SAME],
    S7: ["gone", SAME],
    S9: ["processing", SAME],
    S10: [503, "video 0 doomed | - | processing | -"],
    S11: ["deleted", "video 0 doomed | - | processing | -"],
    attach: [422, SAME],
    "expiredMedia/purgeMedia": [NOT_SWEPT, SAME],
    dueOrphans: [null, SAME],
  },
  "AV running": {
    startTransforms: ["expired", SAME],
    completeMedia: [null, SAME],
    abandonMedia: ["kept", SAME],
    completeEmoji: ["upload-expired", SAME],
    abandonEmoji: ["kept", SAME],
    S1: ["gone", SAME],
    S3: ["settled", SAME],
    S4: [{ settled: "running" }, SAME],
    S6: ["done", "video 1 24h5s | - | processing | -"],
    S7: [{ status: "recorded", cause: "verifier" }, "video 0 1h | failed | processing | -"],
    S9: ["processing", SAME],
    S10: [503, "video 0 doomed | - | processing | -"],
    S11: ["deleted", "video 0 doomed | - | processing | -"],
    attach: [422, SAME],
    "expiredMedia/purgeMedia": [NOT_SWEPT, SAME],
    dueOrphans: [null, SAME],
  },
  "AV completed": {
    startTransforms: ["expired", SAME],
    completeMedia: [null, SAME],
    abandonMedia: ["kept", SAME],
    completeEmoji: ["upload-expired", SAME],
    abandonEmoji: ["kept", SAME],
    S1: ["gone", SAME],
    S3: ["settled", SAME],
    S4: [{ settled: "completed" }, SAME],
    S6: ["done", SAME],
    S7: [{ status: "settled", state: "completed" }, SAME],
    S9: ["done", SAME],
    S10: [200, SAME],
    S11: ["deleted", "video 1 doomed | - | processing | -"],
    attach: [200, "video 1 - | - | processing | -"],
    "expiredMedia/purgeMedia": [NOT_SWEPT, SAME],
    dueOrphans: [null, SAME],
  },
  doomed: {
    startTransforms: ["expired", SAME],
    completeMedia: [null, SAME],
    abandonMedia: ["abandoned", "unknown 1 doomed | - | - | -"],
    completeEmoji: ["upload-expired", SAME],
    abandonEmoji: ["abandoned", SAME],
    S1: ["gone", SAME],
    S3: ["gone", SAME],
    S4: ["gone", SAME],
    S6: ["refused", SAME],
    S7: ["gone", SAME],
    S9: ["ended", SAME],
    S10: [503, SAME],
    S11: ["not_found", SAME],
    attach: [422, SAME],
    "expiredMedia/purgeMedia": [SWEPT, "- | - | - | tomb 24h15m"],
    dueOrphans: [IMAGE_TOMBSTONE, "- | - | - | tomb 24h15m"],
  },
  "doomed image": {
    startTransforms: ["expired", SAME],
    completeMedia: [null, SAME],
    abandonMedia: ["abandoned", "image 1 doomed | - | - | -"],
    completeEmoji: ["upload-expired", SAME],
    abandonEmoji: ["abandoned", SAME],
    S1: ["gone", SAME],
    S3: ["gone", SAME],
    S4: ["gone", SAME],
    S6: ["refused", SAME],
    S7: ["gone", SAME],
    S9: ["ended", SAME],
    S10: [503, SAME],
    S11: ["not_found", SAME],
    attach: [422, SAME],
    "expiredMedia/purgeMedia": [SWEPT, "- | - | - | tomb 24h15m"],
    dueOrphans: [IMAGE_TOMBSTONE, "- | - | - | tomb 24h15m"],
  },
  abandoned: {
    startTransforms: ["expired", SAME],
    completeMedia: [null, SAME],
    abandonMedia: ["abandoned", SAME],
    completeEmoji: ["upload-expired", SAME],
    abandonEmoji: ["abandoned", SAME],
    S1: ["gone", SAME],
    S3: ["gone", SAME],
    S4: ["gone", SAME],
    S6: ["refused", SAME],
    S7: ["gone", SAME],
    S9: ["ended", SAME],
    S10: [503, SAME],
    S11: ["not_found", SAME],
    attach: [422, SAME],
    "expiredMedia/purgeMedia": [SWEPT, "- | - | - | tomb 24h15m"],
    dueOrphans: [IMAGE_TOMBSTONE, "- | - | - | tomb 24h15m"],
  },
};

describe("one path per reservation: every (path state × operation)", () => {
  const cases = Object.entries(TABLE).flatMap(([state, row]) =>
    Object.entries(row).map(([op, cell]) => [state as State, op as Op, cell] as const),
  );

  it("covers every state and operation of the plan", () => {
    expect(cases).toHaveLength(11 * 16);
  });

  it.each(cases)("%s × %s", async (state, op, [answer, after]) => {
    const w = await avWorld();
    const built = await build(w, state);
    clock(AT);
    expect(await stateOf(w, built.id)).toBe(BEFORE[state]);
    expect(await OPS[op](w, built)).toEqual(answer);
    expect(await stateOf(w, built.id)).toBe(after === SAME ? BEFORE[state] : after);
  });
});

// ---- The interleavings

// The media bucket, its deletes held after they settle: `deleted` resolves once the sweep's R2 deletion is done, and
// the sweep waits there, before its purge, until `release`.
function heldBucket() {
  const deleted = deferred();
  const purge = deferred();
  const bucket = new Proxy(env.MEDIA, {
    get(target, property) {
      if (property === "delete") {
        return async (keys: string | string[]) => {
          await target.delete(keys);
          deleted.resolve();
          await purge.promise;
        };
      }
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { bucket, deleted: deleted.promise, release: purge.resolve };
}

describe("the interleavings, each actor held at an explicit await", () => {
  it("S11 before the image start: the candidate is doomed, and the image start and completion, held until after the sweep's deletion, are refused", async () => {
    const w = await avWorld();
    const up = await reserve(w, T0);
    // The image route has read the body and is held before its start.
    const route = deferred();
    const imageRoute = (async () => {
      await route.promise;
      const start = await startImage(w, up.id);
      const done = await w.store.completeMedia(BUILD, imageCompletion(w, up.id));
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
      route.resolve();
      expect(await imageRoute).toEqual({
        start: { status: "ok", value: { status: "expired" } },
        done: { status: "ok", value: null },
      });
      release();
      expect(await sweep).toBe(1);
      expect((await held(w.store, up.id)).att).toBeNull();
    } finally {
      route.resolve();
      release();
    }
  });

  it("the image start before S11: S11, made while the image route is held, answers not_found and the image completes", async () => {
    const w = await avWorld();
    const up = await reserve(w, T0);
    clock(T0 + SECOND);
    expect(await startImage(w, up.id)).toEqual({ status: "ok", value: { status: "ok" } });
    // The image route has written its files and is held before its completion.
    const route = deferred();
    const completion = (async () => {
      await route.promise;
      return w.store.completeMedia(BUILD, imageCompletion(w, up.id));
    })();
    try {
      clock(T0 + 2 * SECOND);
      expect(await w.store.deleteAvUpload(BUILD, { credential: w.alice, id: up.id })).toEqual({
        status: "ok",
        value: "not_found",
      });
      expect(await w.store.expiredMedia(BUILD, { limit: 100 })).toEqual([]);
      clock(T0 + 3 * SECOND);
      route.resolve();
      expect(await completion).toMatchObject({ status: "ok", value: { id: up.id, type: "image" } });
      expect((await held(w.store, up.id)).att).toMatchObject({
        processed: 1,
        gc_at: new Date(T0 + 3 * SECOND + DETACHED_GRACE_MS).toISOString(),
      });
    } finally {
      route.resolve();
    }
  });

  it("the image start first: S1, made while the image route is held, answers gone and the image completes", async () => {
    const w = await avWorld();
    const up = await reserve(w, T0);
    clock(T0 + SECOND);
    expect(await startImage(w, up.id)).toEqual({ status: "ok", value: { status: "ok" } });
    const route = deferred();
    const completion = (async () => {
      await route.promise;
      return w.store.completeMedia(BUILD, imageCompletion(w, up.id));
    })();
    try {
      clock(T0 + 2 * SECOND);
      expect(await takeSlot(w, up)).toEqual({ status: "gone" });
      route.resolve();
      expect(await completion).toMatchObject({ status: "ok", value: { id: up.id, type: "image" } });
      expect(await held(w.store, up.id)).toMatchObject({ row: null, slot: null });
    } finally {
      route.resolve();
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
    const queuedAnswer = await queue(w, up, taken.stagedAt);
    expect(queuedAnswer).toMatchObject({ status: "queued" });
    // The AV route holds before its next step (the processor's start).
    const route = deferred();
    const av = (async () => {
      await route.promise;
      return w.store.startNormalize(BUILD, { id: up.id, token: up.token, invocation: "inv" });
    })();
    try {
      clock(T0 + 3 * SECOND);
      expect(await startImage(w, up.id)).toEqual({ status: "ok", value: { status: "expired" } });
      expect(await w.store.completeMedia(BUILD, imageCompletion(w, up.id))).toEqual({ status: "ok", value: null });
      route.resolve();
      expect(await av).toMatchObject({ status: "started" });
      expect((await held(w.store, up.id)).att).toMatchObject({ processed: 0, type: "video" });
    } finally {
      route.resolve();
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
    expect(await w.store.completeMedia(BUILD, imageCompletion(w, id))).toMatchObject({ value: { id } });
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
    expect(await w.store.getMedia(BUILD, { credential: w.alice, id: up.id })).toEqual({
      status: "ok",
      value: { status: "not_found" },
    });
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
  expect(await w.store.completeMedia(BUILD, imageCompletion(w, id))).toMatchObject({ value: { id } });
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

  it.each(["updateCredentials", "updateProfile"] as const)(
    "a profile update (%s) judges its upload live at the Store's time: past its gc_at there, the upload is gone",
    async (operation) => {
      const w = await avWorld();
      const id = await completedImage(w, T0);
      const gcAt = T0 + DETACHED_GRACE_MS;
      const credential = {
        tokenHash: await sha256Hex(w.h.users.alice.token),
        scope: "write:accounts" as const,
        now: T0,
      };
      const update = () =>
        w.store[operation](BUILD, {
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
    },
  );
});

describe("a row without a URL is never live, nor a doomed one completed", () => {
  it("an upload processed without its URL, as an import may leave one, is neither shown nor attachable", async () => {
    const w = await avWorld();
    const id = await completedImage(w, T0);
    await sql(w.store, "UPDATE media_attachments SET url = '', gc_at = NULL WHERE id = ?", id);
    clock(T0 + SECOND);
    expect(await w.store.getMedia(BUILD, { credential: w.alice, id })).toEqual({
      status: "ok",
      value: { status: "not_found" },
    });
    expect((await post(w, id)).status).toBe(422);
  });

  it("completeMedia refuses a doomed image-path reservation, as a later delete would leave it", async () => {
    const w = await avWorld();
    const up = await reserve(w, T0);
    clock(T0 + SECOND);
    expect(await startImage(w, up.id)).toEqual({ status: "ok", value: { status: "ok" } });
    await sql(w.store, "UPDATE media_attachments SET gc_at = ? WHERE id = ?", new Date(0).toISOString(), up.id);
    expect(await w.store.completeMedia(BUILD, imageCompletion(w, up.id))).toEqual({ status: "ok", value: null });
    expect((await held(w.store, up.id)).att).toMatchObject({ processed: 0, gc_at: new Date(0).toISOString() });
  });
});

describe("an emoji upload acts on an emoji's reservation only", () => {
  it.each(["unknown", "AV running"] as const)(
    "an emoji upload abandoned with a %s reservation's id and token keeps the row and its files",
    async (state) => {
      const w = await avWorld();
      const built = await build(w, state);
      await setAccess(w.store);
      const keys = mediaKeys(built.id, built.token);
      for (const key of keys) {
        await env.MEDIA.put(key, "the upload's own");
      }
      clock(AT);
      const before = await stateOf(w, built.id);
      // The Store's reservation answers that row (as only a broken caller could), past its deadline, so the upload
      // abandons it before writing anything.
      const store = new Proxy(w.store, {
        get(target, property) {
          if (property === "reserveEmoji") {
            return () => Promise.resolve({ ok: true, id: built.id, deadline: 0 });
          }
          // Called as a method of the stub: an RPC method's own bind or apply would be called remotely.
          return (...args: unknown[]) =>
            (target as unknown as Record<string | symbol, (...given: unknown[]) => unknown>)[property]!(...args);
        },
      });
      const result = await uploadEmoji(
        {
          build: BUILD,
          store,
          bucket: env.MEDIA,
          images: new TestCodec(),
          now: () => AT,
          authority: ACCESS,
          monthlyTransforms: 5000,
          token: built.token,
        },
        { shortcode: "cell", image: base64(await pngOf(16, 16)) },
      );
      expect(result).toMatchObject({ ok: false, code: "upload-expired" });
      expect(await stateOf(w, built.id)).toBe(before);
      for (const key of keys) {
        expect(await env.MEDIA.head(key)).not.toBeNull();
      }
    },
  );
});

describe("the restore fence on the image path of a candidate", () => {
  it("a candidate S1 took before a restore that rewound S1: the image start after it is refused, as S1's", async () => {
    const w = await avWorld();
    const up = await reserve(w, T0);
    const taken = await bookmark(w.store);
    await staged(w, { up });
    await restore(w.store, taken, T0 + 2 * SECOND);
    clock(T0 + 3 * SECOND);
    expect(await takeSlot(w, up)).toEqual({ status: "gone" });
    expect(await startImage(w, up.id)).toEqual({ status: "ok", value: { status: "expired" } });
    expect(await w.store.completeMedia(BUILD, imageCompletion(w, up.id))).toEqual({ status: "ok", value: null });
    expect(await stateOf(w, up.id)).toBe("unknown 0 1h | - | - | -");
  });

  it("the AV path held across the restore with a grant: the image path stays refused and the AV completion fails", async () => {
    const w = await avWorld();
    const up = await reserve(w, T0);
    const taken = await bookmark(w.store);
    const run = await started(w, { up });
    clock(T0 + 3 * SECOND + 500);
    expect(await w.store.confirmAvWrite(BUILD, { id: up.id, startId: run.startId, write: "full" })).toMatchObject({
      status: "grant",
    });
    // The processor's full put is in flight, held across the restore; its completion comes after.
    const put = deferred();
    const av = (async () => {
      await put.promise;
      return w.store.completeAvUpload(BUILD, { id: up.id, token: up.token, startId: run.startId, facts: VIDEO });
    })();
    try {
      await restore(w.store, taken, T0 + 4 * SECOND);
      clock(T0 + 5 * SECOND);
      expect(await startImage(w, up.id)).toEqual({ status: "ok", value: { status: "expired" } });
      expect(await w.store.completeMedia(BUILD, imageCompletion(w, up.id))).toEqual({ status: "ok", value: null });
      put.resolve();
      expect(await av).toEqual({ status: "refused" });
      expect(await stateOf(w, up.id)).toBe("unknown 0 1h | - | - | -");
    } finally {
      put.resolve();
    }
  });

  it("an image start the restore rewound: the row is a candidate again, and its completion is refused", async () => {
    const w = await avWorld();
    const up = await reserve(w, T0);
    const taken = await bookmark(w.store);
    clock(T0 + SECOND);
    expect(await startImage(w, up.id)).toEqual({ status: "ok", value: { status: "ok" } });
    await restore(w.store, taken, T0 + 2 * SECOND);
    clock(T0 + 3 * SECOND);
    expect(await w.store.completeMedia(BUILD, imageCompletion(w, up.id))).toEqual({ status: "ok", value: null });
    expect(await startImage(w, up.id)).toEqual({ status: "ok", value: { status: "expired" } });
    expect(await stateOf(w, up.id)).toBe("unknown 0 1h | - | - | -");
  });

  it("an image start the restore kept: it was made before the bookmark, so the image completes", async () => {
    const w = await avWorld();
    const up = await reserve(w, T0);
    clock(T0 + SECOND);
    expect(await startImage(w, up.id)).toEqual({ status: "ok", value: { status: "ok" } });
    await restore(w.store, await bookmark(w.store), T0 + 2 * SECOND);
    clock(T0 + 3 * SECOND);
    expect(await w.store.completeMedia(BUILD, imageCompletion(w, up.id))).toMatchObject({
      value: { id: up.id, type: "image" },
    });
  });

  it("a plain image reservation made before the restore is not fenced", async () => {
    const w = await avWorld();
    clock(T0);
    const reserved = await w.store.reserveMedia(BUILD, {
      credential: w.alice,
      token: fileToken(),
      monthlyTransforms: BUDGETS,
      now: T0,
    });
    if (reserved.status !== "ok" || reserved.value.status !== "ok") {
      throw new Error("not reserved");
    }
    await restore(w.store, await bookmark(w.store), T0 + SECOND);
    clock(T0 + 2 * SECOND);
    expect(await startImage(w, reserved.value.id)).toEqual({ status: "ok", value: { status: "ok" } });
  });
});

describe("the Worker's clock off the Store's: each write and check of a stored media time is the Store's", () => {
  const scheduledDeps = (w: AvWorld, now: number) => ({
    ...sweepDeps(w),
    now: () => now,
    doorbell: () => Promise.resolve(),
  });

  it("scheduling a post from a Worker 2 s behind cannot attach a completed upload past its gc_at on the Store's clock", async () => {
    const w = await avWorld();
    const id = await completedImage(w, T0);
    const gcAt = T0 + DETACHED_GRACE_MS;
    clock(gcAt + SECOND);
    w.h.now.mockReturnValue(gcAt - SECOND);
    const scheduled = await w.h.request(
      "/api/v1/statuses",
      bearer(
        w.h.users.alice.token,
        json({ status: "later", media_ids: [id], scheduled_at: new Date(gcAt + 2 * HOUR).toISOString() }),
      ),
    );
    expect([scheduled.status, await scheduled.json()]).toEqual([
      422,
      { error: `Media ${id} not found or already attached to another post` },
    ]);
    expect(await stateOf(w, id)).toBe("image 1 24h | - | - | -");
  });

  // A scheduled status holding a completed upload, due at T0 + 2 h, scheduled at T0 + 1 s.
  async function scheduledWith(w: AvWorld, fields: Record<string, unknown> = {}) {
    const id = await completedImage(w, T0);
    clock(T0 + SECOND);
    w.h.now.mockReturnValue(T0 + SECOND);
    const scheduled = await w.h.request(
      "/api/v1/statuses",
      bearer(
        w.h.users.alice.token,
        json({ status: "later", media_ids: [id], scheduled_at: new Date(T0 + 2 * HOUR).toISOString(), ...fields }),
      ),
    );
    expect(scheduled.status).toBe(200);
    return { id, scheduledId: (await scheduled.json<{ id: string }>()).id };
  }

  it("a scheduled post dropped at publication detaches its media for a day from the Store's time, the Worker an hour behind", async () => {
    const w = await avWorld();
    const parent = await w.h.request("/api/v1/statuses", bearer(w.h.users.alice.token, json({ status: "parent" })));
    const { id: parentId } = await parent.json<{ id: string }>();
    const { id } = await scheduledWith(w, { in_reply_to_id: parentId });
    await w.h.request(`/api/v1/statuses/${parentId}`, bearer(w.h.users.alice.token, { method: "DELETE" }));
    clock(T0 + 5 * HOUR);
    await publishScheduled(env, scheduledDeps(w, T0 + 4 * HOUR));
    expect(await sql(w.store, "SELECT count(*) AS n FROM scheduled_statuses")).toEqual([{ n: 0 }]);
    expect(await stateOf(w, id)).toBe(`image 1 ${span(5 * HOUR + DETACHED_GRACE_MS)} | - | - | -`);
  });

  it("a scheduled post dropped after its last failed attempt detaches its media for a day from the Store's time, the Worker an hour behind", async () => {
    const w = await avWorld();
    const { id, scheduledId } = await scheduledWith(w, { status: "fail" });
    await sql(
      w.store,
      `CREATE TRIGGER fail_publication BEFORE INSERT ON statuses WHEN NEW.source_text LIKE 'fail%'
			BEGIN SELECT RAISE(ABORT, 'injected failure'); END`,
    );
    await sql(
      w.store,
      "UPDATE scheduled_statuses SET attempts = ?, next_attempt_at = ? WHERE id = ?",
      MAX_ATTEMPTS - 1,
      new Date(T0 + 2 * HOUR).toISOString(),
      scheduledId,
    );
    clock(T0 + 5 * HOUR);
    await publishScheduled(env, scheduledDeps(w, T0 + 4 * HOUR));
    expect(await sql(w.store, "SELECT count(*) AS n FROM scheduled_statuses")).toEqual([{ n: 0 }]);
    expect(await stateOf(w, id)).toBe(`image 1 ${span(5 * HOUR + DETACHED_GRACE_MS)} | - | - | -`);
  });

  it("the cron's purge stamps a tombstone from the Store's time, the Worker's clock an hour behind", async () => {
    const w = await avWorld();
    const c = await queued(w);
    clock(T0 + 3 * SECOND);
    await w.store.deleteAvUpload(BUILD, { credential: w.alice, id: c.id });
    const purgedAt = T0 + AV_WRITE_WINDOW_MS + MINUTE;
    clock(purgedAt);
    await handleScheduled(env, scheduledDeps(w, purgedAt - HOUR));
    expect(await stateOf(w, c.id)).toBe(
      `- | - | processing | tomb ${span(AV_WRITE_WINDOW_MS + MINUTE + ORPHAN_GRACE_MS)}`,
    );
  });
});

describe("the restore marker read only for a candidate's image start", () => {
  // An unknown marker refuses what K3 decides as transient, retryable, leaving the reservation as it was
  // (platform/restore-marker.ts restoreTime, code review r3).
  it("refuses a candidate's image start as transient when the marker cannot be read, changing nothing", async () => {
    const w = await avWorld();
    const up = await reserve(w, T0);
    await env.MEDIA.put(restoreMarkerKey(w.store.id.toString()), "{");
    clock(T0 + SECOND);
    expect(toStoreUnavailable(await rejectionOf(startImage(w, up.id)))?.reason).toBe("transient");
    expect(await stateOf(w, up.id)).toBe("unknown 0 1h | - | - | -");
  });

  it("starts an ordinary image reservation whatever the marker holds", async () => {
    const w = await avWorld();
    clock(T0);
    const reserved = await w.store.reserveMedia(BUILD, {
      credential: w.alice,
      token: fileToken(),
      monthlyTransforms: BUDGETS,
      now: T0,
    });
    if (reserved.status !== "ok" || reserved.value.status !== "ok") {
      throw new Error("not reserved");
    }
    await env.MEDIA.put(restoreMarkerKey(w.store.id.toString()), "{");
    clock(T0 + SECOND);
    expect(await startImage(w, reserved.value.id)).toEqual({ status: "ok", value: { status: "ok" } });
  });
});

describe("S10 while the Store refuses writes (its read)", () => {
  it.each([
    ["image completed", "maintenance"],
    ["AV completed", 200],
  ] as const)("on an %s upload answers %s: an image-path upload is not S10's", async (state, answer) => {
    const w = await avWorld();
    const built = await build(w, state);
    await gate(w.store, "maintenance", true);
    clock(AT);
    expect(await w.store.v1Final(BUILD, { id: built.id, token: built.token })).toMatchObject({ status: answer });
  });
});

describe("publication judges its held media at the Store's time", () => {
  it("refuses a held upload past its gc_at on the Store's clock, the Worker 2 s behind (a hold migration 0011 permits)", async () => {
    const w = await avWorld();
    const id = await completedImage(w, T0);
    clock(T0 + SECOND);
    w.h.now.mockReturnValue(T0 + SECOND);
    const scheduled = await w.h.request(
      "/api/v1/statuses",
      bearer(
        w.h.users.alice.token,
        json({ status: "later", media_ids: [id], scheduled_at: new Date(T0 + 2 * HOUR).toISOString() }),
      ),
    );
    expect(scheduled.status).toBe(200);
    // A hold with a finite gc_at, as an import may write one (the API's hold clears it).
    const gcAt = T0 + 3 * HOUR;
    await sql(w.store, "UPDATE media_attachments SET gc_at = ? WHERE id = ?", new Date(gcAt).toISOString(), id);
    clock(gcAt + SECOND);
    await publishScheduled(env, { ...sweepDeps(w), now: () => gcAt - SECOND, doorbell: () => Promise.resolve() });
    expect(await sql(w.store, "SELECT count(*) AS n FROM statuses WHERE source_text = 'later'")).toEqual([{ n: 0 }]);
    expect(await sql(w.store, "SELECT count(*) AS n FROM scheduled_statuses")).toEqual([{ n: 0 }]);
  });
});

describe("the image start's two passes (store.ts startImagePath)", () => {
  // Runs startImagePath on the Store's own kernel with an after-commit hook that counts, and a marker read that counts.
  async function startCounted(w: AvWorld, id: string) {
    const counted = { commits: 0, reads: 0 };
    const answer = await runInDurableObject(w.store, (_instance, state) =>
      startImagePath(
        testKernel(state, undefined, { afterCommit: () => counted.commits++ }),
        BUILD,
        { credential: w.alice, id, monthlyTransforms: BUDGETS, now: Date.now() },
        () => {
          counted.reads++;
          return Promise.resolve(null);
        },
      ),
    );
    return { answer, ...counted };
  }

  it("a candidate: the pass that asks for the marker runs no after-commit hook, the start that chooses the path does", async () => {
    const w = await avWorld();
    const up = await reserve(w, T0);
    clock(T0 + SECOND);
    expect(await startCounted(w, up.id)).toEqual({
      answer: { status: "ok", value: { status: "ok" } },
      commits: 1,
      reads: 1,
    });
  });

  it("an ordinary image: one pass, the marker unread", async () => {
    const w = await avWorld();
    clock(T0);
    const reserved = await w.store.reserveMedia(BUILD, {
      credential: w.alice,
      token: fileToken(),
      monthlyTransforms: BUDGETS,
      now: T0,
    });
    if (reserved.status !== "ok" || reserved.value.status !== "ok") {
      throw new Error("not reserved");
    }
    clock(T0 + SECOND);
    expect(await startCounted(w, reserved.value.id)).toEqual({
      answer: { status: "ok", value: { status: "ok" } },
      commits: 1,
      reads: 0,
    });
  });

  it("answers an unknown token's refusal as it is, the marker unread", async () => {
    const w = await avWorld();
    const up = await reserve(w, T0);
    clock(T0 + SECOND);
    const credential = { ...w.alice, tokenHash: await sha256Hex("not a token") };
    expect(
      await w.store.startTransforms(BUILD, { credential, id: up.id, monthlyTransforms: BUDGETS, now: Date.now() }),
    ).toEqual({ status: "unauthenticated" });
    expect(await stateOf(w, up.id)).toBe("unknown 0 1h | - | - | -");
  });
});
