import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DOOMED_AT, TRANSFORMS_PER_UPLOAD } from "../src/domain/media";
import {
  AV_UPLOAD_LIMIT,
  deleteOwnerMedia,
  DISPATCH_MS,
  MAX_AV_INFLIGHT,
  ownerMedia,
  PART_BYTES,
  R2_CALL_MS,
  STORE_CALL_MS,
  T_REPLY,
  updateOwnerMedia,
  V1_POLL_MS,
  V1_TIME_MS,
  V2_PROCESS_MS,
} from "../src/domain/media-processing";
import { incomingOrphans } from "../src/jobs/media-jobs";
import { MEDIA_BODY_LIMIT, sweepMedia } from "../src/mastodon/media";
import { VIDEO_POSTER } from "../src/platform/brand-assets";
import { IMAGE_SIZE_LIMIT } from "../src/platform/images";
import { fileKey, incomingKey, originalKey, restoreMarkerKey } from "../src/platform/media-files";
import { readRestore } from "../src/platform/restore-marker";
import type { StoreStub } from "../src/platform/store-client";
import { toStoreUnavailable } from "../src/platform/store-errors";
import { MAX_MEDIA_DESCRIPTION_LENGTH } from "../src/platform/stored-bounds";
import { markedRun } from "../src/store";
import { bearer, json, sql } from "./api-helpers";
import { concat } from "./av-helpers";
import { imageUpload } from "./av-posting-helpers";
import { BUILD, deferred, gateMarker, holdingMarker, rejectionOf, testKernel } from "./helpers";
import { DESCRIPTION_TOO_LONG, OVERLONG_DESCRIPTIONS } from "./media-helpers";
import {
  ACTIVE,
  AUDIO,
  type AvWorld,
  avWorld,
  bookmark,
  charged,
  gate,
  clock,
  completed,
  failed,
  held,
  queue,
  queued,
  reserve,
  restore,
  SECOND,
  staged,
  type Started,
  started,
  T0,
  VIDEO,
  VIDEO_NO_STILL,
} from "./media-processing-helpers";
import {
  answerOf,
  hookedBucket,
  input,
  lastUpload,
  mp3,
  mp4,
  multipartBody,
  postMedia,
  postWatched,
  type RouteWorld,
  routeWorld,
  SlowBody,
  videoPart,
} from "./media-route-helpers";
import { observedSql } from "./read-helpers";
import { storeWith } from "./setup-helpers";

// The owner's GET, PUT and DELETE of a video or audio upload in each state (#1828 P9, MEDIA-1), through the routes, with
// rows made by the Store's own operations (domain/media-processing.ts): 206 masked while processing, 422 once failed or
// past its deadline, 200 once complete, 404 for a staging, doomed or never staged reservation and for another account
// in every state; DELETE as S11; a DELETE lost or delayed across a restore (W13's cases the specification's RS3 does not
// interleave); and S10's 200 through the owner's presenter.

afterEach(() => {
  vi.useRealTimers();
});

const PROCESSING_ERROR = { error: "Error processing thumbnail for uploaded media" };
const NOT_FOUND = { error: "Record not found" };

type Who = "alice" | "bob";

function get(w: AvWorld, id: string, who: Who = "alice") {
  return w.h.request(`/api/v1/media/${id}`, bearer(w.h.users[who].token)).then(answerOf);
}

function put(w: AvWorld, id: string, body: Record<string, unknown>, who: Who = "alice") {
  return w.h.request(`/api/v1/media/${id}`, bearer(w.h.users[who].token, json(body, { method: "PUT" }))).then(answerOf);
}

function del(w: AvWorld, id: string, who: Who = "alice") {
  return w.h.request(`/api/v1/media/${id}`, bearer(w.h.users[who].token, { method: "DELETE" })).then(answerOf);
}

async function description(w: AvWorld, id: string): Promise<string | undefined> {
  const [row] = await sql<{ description: string }>(
    w.store,
    "SELECT description FROM media_attachments WHERE id = ?",
    id,
  );
  return row?.description;
}

// The masked attachment of alice's upload still processing (status-presenter.ts processingMedia).
const masked = (id: string, describedAs: string) => ({
  id,
  type: "video",
  url: null,
  preview_url: null,
  remote_url: null,
  preview_remote_url: null,
  text_url: null,
  meta: null,
  description: describedAs,
  blurhash: null,
});

describe("the owner's reads of an upload in each state (P9)", () => {
  it("answers 206 masked while pending and running, and PUT writes the text and answers 206", async () => {
    for (const make of [queued, started]) {
      const w = await avWorld();
      const up = await make(w);
      clock(T0 + 5 * SECOND);
      expect(await get(w, up.id)).toEqual({ status: 206, body: masked(up.id, "a clip") });
      expect(await put(w, up.id, { description: "later", focus: "0.5,0.5" })).toEqual({
        status: 206,
        body: masked(up.id, "later"),
      });
      expect(await description(w, up.id)).toBe("later");
      // The read wrote nothing: the row is as the operation left it.
      expect((await held(w.store, up.id)).row).toMatchObject({ state: make === queued ? "pending" : "running" });
    }
  });

  it("answers 422 at and past deadline_at, read at the Store's time with no round, and PUT writes nothing", async () => {
    const w = await avWorld();
    const up = await started(w);
    const deadline = T0 + 2 * SECOND + V2_PROCESS_MS;
    clock(deadline - 1);
    expect((await get(w, up.id)).status).toBe(206);
    clock(deadline);
    expect(await get(w, up.id)).toEqual({ status: 422, body: PROCESSING_ERROR });
    expect(await put(w, up.id, { description: "later" })).toEqual({ status: 422, body: PROCESSING_ERROR });
    expect(await description(w, up.id)).toBe("a clip");
    // Neither the GET nor the PUT recorded K4: the row is still running until a writing operation meets it.
    expect((await held(w.store, up.id)).row).toMatchObject({ state: "running", failure: null });
  });

  it("answers 422 for a failed upload, every cause, and PUT writes nothing", async () => {
    for (const cause of [
      "refused",
      "envelope",
      "verifier",
      "unavailable",
      "timeout",
      "deadline",
      "restored",
    ] as const) {
      const w = await avWorld();
      const up = await failed(w, cause);
      clock(T0 + 5 * SECOND);
      expect(await get(w, up.id)).toEqual({ status: 422, body: PROCESSING_ERROR });
      expect(await put(w, up.id, { description: "later" })).toEqual({ status: 422, body: PROCESSING_ERROR });
      expect(await description(w, up.id)).toBe("a clip");
    }
  });

  it("a PUT whose description is too long answers the description's 422 first, on a failed upload too", async () => {
    const w = await avWorld();
    const up = await failed(w, "refused");
    const pending = await queued(w);
    clock(T0 + 5 * SECOND);
    for (const id of [up.id, pending.id]) {
      expect(await put(w, id, { description: OVERLONG_DESCRIPTIONS[0] })).toEqual({
        status: 422,
        body: DESCRIPTION_TOO_LONG,
      });
      expect(await put(w, id, { description: OVERLONG_DESCRIPTIONS[0] }, "bob")).toEqual({
        status: 404,
        body: NOT_FOUND,
      });
    }
    expect(await description(w, up.id)).toBe("a clip");
  });

  it("answers 200 for a completed upload, with its URLs and facts", async () => {
    const w = await avWorld();
    const up = await completed(w);
    clock(T0 + 5 * SECOND);
    const shown = await get(w, up.id);
    expect(shown).toMatchObject({
      status: 200,
      body: {
        id: up.id,
        type: "video",
        url: expect.stringMatching(new RegExp(`/media/${up.token}/full\\.mp4$`)),
        preview_url: expect.stringMatching(new RegExp(`/media/${up.token}/small\\.webp$`)),
        meta: { original: { frame_rate: "30/1", duration: 8, bitrate: 1_000_000 } },
        description: "a clip",
      },
    });
    expect(await put(w, up.id, { description: "later" })).toMatchObject({
      status: 200,
      body: { description: "later" },
    });
  });

  it("answers 404 for a staging reservation, one never staged and a doomed upload", async () => {
    const w = await avWorld();
    const staging = await staged(w);
    const reserved = await reserve(w, T0);
    const doomed = await queued(w);
    clock(T0 + 5 * SECOND);
    expect((await del(w, doomed.id)).status).toBe(200);
    for (const id of [staging.id, reserved.id, doomed.id]) {
      expect(await get(w, id)).toEqual({ status: 404, body: NOT_FOUND });
      expect(await put(w, id, { description: "later" })).toEqual({ status: 404, body: NOT_FOUND });
    }
    // The staging row is the route's: a DELETE does not take it.
    expect(await del(w, staging.id)).toEqual({ status: 404, body: NOT_FOUND });
    expect((await held(w.store, staging.id)).row).toMatchObject({ state: "staging" });
    expect(await description(w, staging.id)).toBe("");
  });

  it("answers another account 404 in every state, and changes nothing of the upload (MEDIA-1)", async () => {
    // One world for each upload: at most MAX_AV_INFLIGHT slots are taken at once. The owner's own answer shows the
    // branch bob is refused at ran.
    const cases: [(w: AvWorld) => Promise<{ id: string }>, number][] = [
      [staged, 404],
      [queued, 206],
      [started, 206],
      [(w) => failed(w, "refused"), 422],
      [completed, 200],
      [(w) => reserve(w), 404],
    ];
    for (const [make, owner] of cases) {
      const w = await avWorld();
      const up = await make(w);
      clock(T0 + 5 * SECOND);
      const before = await held(w.store, up.id);
      expect(await get(w, up.id, "bob")).toEqual({ status: 404, body: NOT_FOUND });
      expect(await put(w, up.id, { description: "bob's" }, "bob")).toEqual({ status: 404, body: NOT_FOUND });
      expect(await del(w, up.id, "bob")).toEqual({ status: 404, body: NOT_FOUND });
      expect(await held(w.store, up.id)).toEqual(before);
      expect(await description(w, up.id)).not.toBe("bob's");
      expect((await get(w, up.id)).status).toBe(owner);
    }
  });
});

const OWNER_OPS = [ownerMedia, updateOwnerMedia, deleteOwnerMedia] as const;

// One of the owner's operations run through markedRun in the Store, counting its marker reads: `answer` the
// operation's status (or DELETE's answer), or the Store's refusal.
async function counted(w: AvWorld, op: (typeof OWNER_OPS)[number], id: string, who: Who = "alice") {
  let reads = 0;
  const credential = who === "alice" ? w.alice : w.bob;
  const input = op === updateOwnerMedia ? { credential, id, changes: { description: "bob's" } } : { credential, id };
  const answered = await runInDurableObject(w.store, (_instance, state) =>
    markedRun(testKernel(state), BUILD, op as typeof ownerMedia, input, () => {
      reads++;
      return Promise.resolve(null);
    }),
  );
  const value = answered.status === "ok" ? (answered.value as unknown) : answered.status;
  return { answer: typeof value === "string" ? value : (value as { status: string }).status, reads };
}
describe("another account's upload is never normalized or read past its owner check (code review r1 M1)", () => {
  it("leaves another account's overdue upload untouched on DELETE", async () => {
    const w = await avWorld();
    const up = await started(w);
    const before = await held(w.store, up.id);
    clock(before.row!.deadline_at!);
    expect(await del(w, up.id, "bob")).toEqual({ status: 404, body: NOT_FOUND });
    expect(await held(w.store, up.id)).toEqual(before);
  });

  it("leaves another account's staging reservation a restore fenced untouched, row and slot", async () => {
    const w = await avWorld();
    const up = await staged(w);
    const taken = await bookmark(w.store);
    await restore(w.store, taken, T0 + 6 * SECOND);
    clock(T0 + 7 * SECOND);
    const before = await held(w.store, up.id);
    expect(before).toMatchObject({ row: { state: "staging" }, slot: { phase: "staging" } });
    expect(await del(w, up.id, "bob")).toEqual({ status: 404, body: NOT_FOUND });
    expect(await held(w.store, up.id)).toEqual(before);
  });

  it("reads no marker for another account's upload, in any operation", async () => {
    for (const make of [staged, queued, started]) {
      const w = await avWorld();
      const up = await make(w);
      clock(T0 + 5 * SECOND);
      const before = await held(w.store, up.id);
      for (const op of OWNER_OPS) {
        expect(await counted(w, op, up.id, "bob")).toEqual({ answer: "not_found", reads: 0 });
      }
      expect(await held(w.store, up.id)).toEqual(before);
    }
  });
});

describe("a restore marker that cannot be read (code review r1 M2)", () => {
  const MONTHLY = { instance: 1_000_000, account: 1_000_000 };
  async function unreadable<T>(w: AvWorld, run: () => Promise<T>, body = "{"): Promise<T> {
    const key = restoreMarkerKey(w.store.id.toString());
    await env.MEDIA.put(key, body);
    try {
      return await run();
    } finally {
      await env.MEDIA.delete(key);
    }
  }

  // A marker that exists but holds no time a restore records (code review r2 M1) is as unreadable as one that is
  // not JSON: it is never taken for no restore.
  it.each([
    ["not JSON", "{"],
    ["no time", "{}"],
    ["a time as a string", '{"at":"1760000000000"}'],
    ["an infinite time", '{"at":1e309}'],
    ["a negative time", '{"at":-1}'],
    ["a fractional time", '{"at":0.5}'],
    ["a time past the safe integers", '{"at":9007199254740992}'],
  ])("refuses with a 503 the owner's operations K3 decides, and writes nothing: %s", async (_name, body) => {
    // GET and PUT of a pending or running upload (K3 fails it `restored`), DELETE of a staging one (K3 deletes it).
    const cases: [typeof staged, ("get" | "put" | "del")[]][] = [
      [queued, ["get", "put"]],
      [started, ["get", "put"]],
      [staged, ["del"]],
    ];
    for (const [make, ops] of cases) {
      const w = await avWorld();
      const up = await make(w);
      clock(T0 + 7 * SECOND);
      const before = await held(w.store, up.id);
      const described = await description(w, up.id);
      const call = {
        get: () => get(w, up.id),
        put: () => put(w, up.id, { description: "lost" }),
        del: () => del(w, up.id),
      };
      const statuses = await unreadable(
        w,
        async () => {
          const answered: number[] = [];
          for (const op of ops) {
            answered.push((await call[op]()).status);
          }
          return answered;
        },
        body,
      );
      expect(statuses).toEqual(ops.map(() => 503));
      expect(await held(w.store, up.id)).toEqual(before);
      expect(await description(w, up.id)).toBe(described);
    }
  });

  it("reads an R2 failure, of the get or of the body, as an unknown marker", async () => {
    const failing = (reason: string) => Promise.reject(new Error(reason));
    const buckets = [
      { get: () => failing("get") },
      { get: () => Promise.resolve({ text: () => failing("body") }) },
      { get: () => Promise.resolve({ text: () => Promise.resolve('{"at":5}') }) },
      { get: () => Promise.resolve(null) },
    ];
    const read = await Promise.all(buckets.map((bucket) => readRestore(bucket as unknown as R2Bucket, "k")));
    expect(read).toEqual(["unknown", "unknown", 5, null]);
  });

  // The rule (code review r4): an operation asks for the marker only where K3's answer would change its reply or its
  // committed state; what every K3 outcome answers alike is decided without it.
  describe("what every K3 outcome answers alike, under an unknown marker (code review r4)", () => {
    it("answers a staging reservation's GET and PUT 404 and a v2 upload's at its deadline_at 422, writing nothing", async () => {
      const w = await avWorld();
      const stagedUp = await staged(w);
      const w2 = await avWorld();
      const overdue = await queued(w2);
      clock(T0 + 5 * SECOND);
      const before = await held(w.store, stagedUp.id);
      const described = await description(w, stagedUp.id);
      const statuses = await unreadable(
        w,
        async () => [(await get(w, stagedUp.id)).status, (await put(w, stagedUp.id, { description: "lost" })).status],
        "{}",
      );
      expect(statuses).toEqual([404, 404]);
      expect(await held(w.store, stagedUp.id)).toEqual(before);
      expect(await description(w, stagedUp.id)).toBe(described);
      const late = await held(w2.store, overdue.id);
      clock(late.row!.deadline_at!);
      const failedStatuses = await unreadable(
        w2,
        async () => [(await get(w2, overdue.id)).status, (await put(w2, overdue.id, { description: "lost" })).status],
        "{}",
      );
      expect(failedStatuses).toEqual([422, 422]);
      expect(await held(w2.store, overdue.id)).toEqual(late);
    });

    it("dooms a running v1 upload on S10 and an unattached pending v2 upload on S11, the marker unknown or its read held", async () => {
      for (const mode of ["{}", "held"] as const) {
        const w = await avWorld();
        const running = await started(w, { v1: true });
        const w2 = await avWorld();
        const pending = await queued(w2);
        clock(T0 + 5 * SECOND);
        const before = [await held(w.store, running.id), await held(w2.store, pending.id)];
        const calls: (() => Promise<unknown>)[] = [
          () => w.store.v1Final(BUILD, { id: running.id, token: running.token }),
          () => w2.store.deleteAvUpload(BUILD, { credential: w2.alice, id: pending.id }),
        ];
        const answers: unknown[] = [];
        for (const [i, call] of calls.entries()) {
          const world = i === 0 ? w : w2;
          if (mode === "{}") {
            answers.push(await unreadable(world, call, "{}"));
          } else {
            answers.push(await holdingMarker(world.store, call));
          }
        }
        expect(answers, mode).toEqual(
          mode === "{}"
            ? [{ status: 503 }, { status: "ok", value: "deleted" }]
            : [
                { answer: { status: 503 }, reads: 0 },
                { answer: { status: "ok", value: "deleted" }, reads: 0 },
              ],
        );
        const after = [await held(w.store, running.id), await held(w2.store, pending.id)];
        for (const [i, record] of after.entries()) {
          // Doomed: the processing row deleted, gc_at DOOMED_AT, the slot kept.
          expect(record, mode).toEqual({
            row: null,
            slot: before[i]!.slot,
            att: { ...before[i]!.att, gc_at: DOOMED_AT },
          });
        }
      }
    });

    it("answers S9's ended, a late S1's gone and a stale sweep claim's stale without the marker", async () => {
      const w = await avWorld();
      const running = await started(w, { v1: true });
      const w2 = await avWorld();
      const image = await reserve(w2);
      clock(T0 + SECOND);
      const took = await w2.store.startTransforms(BUILD, {
        credential: w2.alice,
        id: image.id,
        monthlyTransforms: MONTHLY,
        now: Date.now(),
      });
      expect(took).toEqual({ status: "ok", value: { status: "ok" } });
      const w3 = await avWorld();
      const claimed = (await w3.store.incomingSweepClaim(BUILD)) as { claim: number };
      expect(await w3.store.incomingSwept(BUILD, { claim: claimed.claim, cursor: "next" })).toEqual({
        status: "swept",
      });
      clock(T0 + 5 * SECOND);
      const deadline = (await held(w.store, running.id)).row!.deadline_at!;
      const answers = [
        await unreadable<unknown>(w, () => w.store.v1Outcome(BUILD, { id: running.id, token: "another" }), "{}"),
        await unreadable<unknown>(
          w2,
          () =>
            w2.store.takeAvSlot(BUILD, {
              id: image.id,
              token: image.token,
              kind: "video",
              v1Left: null,
              activation: ACTIVE,
            }),
          "{}",
        ),
        await unreadable<unknown>(
          w3,
          async () => [
            await w3.store.incomingClassify(BUILD, { claim: claimed.claim + 1, keys: [] }),
            await w3.store.incomingSwept(BUILD, { claim: claimed.claim, cursor: "again" }),
          ],
          "{}",
        ),
      ];
      clock(deadline);
      answers.push(
        await unreadable<unknown>(w, () => w.store.v1Outcome(BUILD, { id: running.id, token: running.token }), "{}"),
      );
      expect(answers).toEqual([
        { status: "ended" },
        { status: "gone" },
        [{ status: "stale" }, { status: "stale" }],
        { status: "ended" },
      ]);
    });

    it("answers a PUT held at the marker read 404 once S10 dooms the upload meanwhile, writing no text (code review r5)", async () => {
      const w = await avWorld();
      const up = await started(w, { v1: true });
      clock(T0 + 5 * SECOND);
      const text = "SELECT description, focus_x, focus_y, focus_given FROM media_attachments WHERE id = ?";
      const before = await sql(w.store, text, up.id);
      const gate = await gateMarker(w.store);
      try {
        const putting = put(w, up.id, { description: "lost", focus: "0.5,0.5" });
        await gate.reached();
        expect(await w.store.v1Final(BUILD, { id: up.id, token: up.token })).toEqual({ status: 503 });
        gate.open();
        expect(await putting).toEqual({ status: 404, body: NOT_FOUND });
        expect(gate.reads()).toBe(1);
      } finally {
        await gate.close();
      }
      expect(await sql(w.store, text, up.id)).toEqual(before);
    });

    it("commits the sweep's claim while the marker read is held", async () => {
      const w = await avWorld();
      const claimed = await holdingMarker<unknown>(w.store, () => w.store.incomingSweepClaim(BUILD));
      expect(claimed).toMatchObject({ answer: { status: "claimed" }, reads: 0 });
      expect(await w.store.incomingSweepClaim(BUILD)).toEqual({ status: "not_due" });
    });
  });

  // One rule for every reader of the marker (code review r3): an unknown marker ({} here, on a writable Store) refuses
  // only an answer or a write K3 could change, with the transient refusal (503); one K3 cannot change answers as before.
  describe("an unknown marker on a writable Store (code review r3)", () => {
    const transient = async (call: Promise<unknown>) => toStoreUnavailable(await rejectionOf(call))?.reason;

    it("answers what K3 cannot change: S10's and S9's completed upload, a completed S6 replay, the poster's charge after it, S8 after completion, the sweep's claim", async () => {
      const w = await avWorld();
      const up = await completed(w, { v1: true });
      clock(T0 + 5 * SECOND);
      const queuedUp = await held(w.store, up.id);
      expect(queuedUp.slot).toMatchObject({ phase: "processing", teardown_id: up.teardownId });
      const answers = await unreadable<unknown>(
        w,
        async () => [
          (await w.store.v1Final(BUILD, { id: up.id, token: up.token })).status,
          (await w.store.v1Outcome(BUILD, { id: up.id, token: up.token })).status,
          (await w.store.completeAvUpload(BUILD, { id: up.id, token: up.token, startId: up.startId, facts: VIDEO }))
            .status,
          (await w.store.chargeAvPoster(BUILD, { id: up.id, startId: up.startId, monthlyTransforms: MONTHLY })).status,
          (await w.store.releaseAvSlot(BUILD, { id: up.id, teardownId: up.teardownId })).status,
          (await w.store.incomingSweepClaim(BUILD)).status,
        ],
        "{}",
      );
      expect(answers).toEqual([200, "done", "done", "refused", "released", "claimed"]);
      expect(queuedUp.row).toBeNull();
      // S8 deleted the slot, and the claim is recorded: the next one is not due.
      expect((await held(w.store, up.id)).slot).toBeNull();
      expect(await w.store.incomingSweepClaim(BUILD)).toEqual({ status: "not_due" });
    });

    it("refuses what K3 could change, for an unfinished upload, with the transient refusal", async () => {
      const w = await avWorld();
      const running = await started(w, { v1: true });
      const w2 = await avWorld();
      const pending = await queued(w2);
      const w3 = await avWorld();
      const candidate = await reserve(w3);
      const w4 = await avWorld();
      const stagedUp = await staged(w4);
      const w5 = await avWorld();
      const overdue = await started(w5, { v1: true });
      clock(T0 + 5 * SECOND);
      const before = [
        await held(w.store, running.id),
        await held(w2.store, pending.id),
        await held(w4.store, stagedUp.id),
        await held(w5.store, overdue.id),
      ];
      const refusals = [
        ...(await unreadable(
          w,
          async () => [
            await transient(w.store.v1Outcome(BUILD, { id: running.id, token: running.token })),
            await transient(
              w.store.completeAvUpload(BUILD, {
                id: running.id,
                token: running.token,
                startId: running.startId,
                facts: VIDEO,
              }),
            ),
            await transient(w.store.mediaDispatchRound(BUILD)),
          ],
          "{}",
        )),
        ...(await unreadable(
          w2,
          async () => [
            await transient(w2.store.releaseAvSlot(BUILD, { id: pending.id, teardownId: pending.teardownId })),
          ],
          "{}",
        )),
        // The owner's own S11 as a Store call, the refusal the route answers 503 with: of a staging reservation (K3
        // deletes it, so S11 dooms it) and of a v1 upload at its deadline_at (K4 dooms it: 404; K3 fails it: 200).
        ...(await unreadable(
          w4,
          async () => [await transient(w4.store.deleteAvUpload(BUILD, { credential: w4.alice, id: stagedUp.id }))],
          "{}",
        )),
        ...(await unreadable(
          w3,
          async () => [
            await transient(
              w3.store.startTransforms(BUILD, {
                credential: w3.alice,
                id: candidate.id,
                monthlyTransforms: MONTHLY,
                now: Date.now(),
              }),
            ),
          ],
          "{}",
        )),
      ];
      clock(before[3]!.row!.deadline_at!);
      refusals.push(
        ...(await unreadable(
          w5,
          async () => [await transient(w5.store.deleteAvUpload(BUILD, { credential: w5.alice, id: overdue.id }))],
          "{}",
        )),
      );
      expect(refusals).toEqual(Array.from({ length: 7 }, () => "transient"));
      expect([
        await held(w.store, running.id),
        await held(w2.store, pending.id),
        await held(w4.store, stagedUp.id),
        await held(w5.store, overdue.id),
      ]).toEqual(before);
    });

    it("refuses the processor's fence-dependent writes S1-S5, the poster's charge and S7 and the sweep's checkpoint, writing nothing", async () => {
      const cases: [string, (w: AvWorld) => Promise<{ id: string; run: () => Promise<unknown> }>][] = [
        [
          "S1",
          async (w) => {
            const up = await reserve(w);
            const run = () =>
              w.store.takeAvSlot(BUILD, {
                id: up.id,
                token: up.token,
                kind: "video",
                v1Left: null,
                activation: ACTIVE,
              });
            return { id: up.id, run };
          },
        ],
        [
          "S2",
          async (w) => {
            const up = await staged(w);
            return {
              id: up.id,
              run: () => w.store.releaseStaging(BUILD, { id: up.id, token: up.token, stagedAt: up.stagedAt }),
            };
          },
        ],
        [
          "S3",
          async (w) => {
            const up = await staged(w);
            return { id: up.id, run: () => queue(w, up, up.stagedAt) };
          },
        ],
        [
          "S4",
          async (w) => {
            const up = await queued(w);
            return {
              id: up.id,
              run: () => w.store.startNormalize(BUILD, { id: up.id, token: up.token, invocation: "inv-x" }),
            };
          },
        ],
        [
          "S5",
          async (w) => {
            const up = await started(w);
            return {
              id: up.id,
              run: () => w.store.confirmAvWrite(BUILD, { id: up.id, startId: up.startId, write: "full" }),
            };
          },
        ],
        [
          "chargeAvPoster",
          async (w) => {
            const up = await started(w);
            return {
              id: up.id,
              run: () => w.store.chargeAvPoster(BUILD, { id: up.id, startId: up.startId, monthlyTransforms: MONTHLY }),
            };
          },
        ],
        [
          "S7",
          async (w) => {
            const up = await started(w);
            return {
              id: up.id,
              run: () => w.store.failNormalize(BUILD, { id: up.id, startId: up.startId, cause: "unavailable" }),
            };
          },
        ],
        [
          "incomingSwept",
          async (w) => {
            const claimed = (await w.store.incomingSweepClaim(BUILD)) as { claim: number };
            return { id: "", run: () => w.store.incomingSwept(BUILD, { claim: claimed.claim, cursor: null }) };
          },
        ],
      ];
      const refused: Record<string, unknown> = {};
      for (const [name, make] of cases) {
        const w = await avWorld();
        const { id, run } = await make(w);
        clock(T0 + 3 * SECOND);
        const before = id === "" ? null : await held(w.store, id);
        refused[name] = await unreadable(w, () => transient(run()), "{}");
        if (before !== null) {
          expect(await held(w.store, id), name).toEqual(before);
        }
      }
      expect(refused).toEqual(Object.fromEntries(cases.map(([name]) => [name, "transient"])));
    });

    it("refuses the sweep's classification, which checks its claim against the restore", async () => {
      const w = await avWorld();
      const claimed = await w.store.incomingSweepClaim(BUILD);
      expect(claimed.status).toBe("claimed");
      const claim = (claimed as { claim: number }).claim;
      expect(await unreadable(w, () => transient(w.store.incomingClassify(BUILD, { claim, keys: [] })), "{}")).toBe(
        "transient",
      );
    });
  });

  it("answers another account's S11 not found without reading the marker (code review r2)", async () => {
    const w = await avWorld();
    const up = await queued(w);
    clock(T0 + 5 * SECOND);
    const before = await held(w.store, up.id);
    const answered = await unreadable<unknown>(w, () =>
      w.store.deleteAvUpload(BUILD, { credential: w.bob, id: up.id }),
    );
    expect(answered).toEqual({ status: "ok", value: "not_found" });
    expect(await held(w.store, up.id)).toEqual(before);
  });

  it("answers an upload K3 cannot act on without reading the marker", async () => {
    const w = await avWorld();
    const up = await completed(w);
    clock(T0 + 5 * SECOND);
    const statuses = await unreadable(w, async () => [
      (await get(w, up.id)).status,
      (await put(w, up.id, { description: "kept" })).status,
    ]);
    expect(statuses).toEqual([200, 200]);
    expect(await description(w, up.id)).toBe("kept");
  });
});

// A DELETE through the route runs a sweep after its response (sweepSoon), which removes a doomed row and its keys.
async function swept(w: AvWorld, id: string): Promise<void> {
  expect(await held(w.store, id)).toMatchObject({ row: null, att: null });
  expect(await get(w, id)).toEqual({ status: 404, body: NOT_FOUND });
}

const MAKES: ((w: AvWorld) => Promise<{ id: string }>)[] = [
  queued,
  started,
  (w) => failed(w, "unavailable"),
  completed,
  (w) => reserve(w),
];

describe("DELETE through the route (S11)", () => {
  it("dooms a pending, running, failed or completed upload and a reservation, its processing row deleted and its slot kept", async () => {
    for (const make of MAKES) {
      const w = await avWorld();
      const up = await make(w);
      clock(T0 + 5 * SECOND);
      const slot = (await held(w.store, up.id)).slot;
      // The Store's own S11, so the doom is seen before a sweep removes the row.
      expect(await w.store.deleteMedia(BUILD, { credential: w.alice, id: up.id })).toEqual({
        status: "ok",
        value: "deleted",
      });
      expect(await held(w.store, up.id)).toMatchObject({ row: null, slot, att: { gc_at: "1970-01-01T00:00:00.000Z" } });
    }
  });

  it("answers 200 through the route, and the sweep after it takes the upload, its slot kept", async () => {
    for (const make of MAKES) {
      const w = await avWorld();
      const up = await make(w);
      clock(T0 + 5 * SECOND);
      const slot = (await held(w.store, up.id)).slot;
      expect(await del(w, up.id)).toEqual({ status: 200, body: {} });
      await swept(w, up.id);
      expect((await held(w.store, up.id)).slot).toEqual(slot);
    }
  });

  it("a repeat after a DELETE whose reply was lost answers 404 (1.4)", async () => {
    const w = await avWorld();
    const up = await started(w);
    clock(T0 + 5 * SECOND);
    // The first DELETE commits; its reply never reaches the client.
    await w.store.deleteMedia(BUILD, { credential: w.alice, id: up.id });
    expect(await del(w, up.id)).toEqual({ status: 404, body: NOT_FOUND });
    expect((await held(w.store, up.id)).att).toMatchObject({ gc_at: "1970-01-01T00:00:00.000Z" });
  });
});

describe("a DELETE across a restore (W13, Codex r7)", () => {
  it("a DELETE committing after a restore of a running upload: K3 fails it restored, then S11 dooms it", async () => {
    const w = await avWorld();
    const up = await started(w);
    const taken = await bookmark(w.store);
    await restore(w.store, taken, T0 + 6 * SECOND);
    clock(T0 + 7 * SECOND);
    // The restored row is fenced: the owner's read meets it failed, as the round's S13 would leave it.
    expect(await get(w, up.id)).toEqual({ status: 422, body: PROCESSING_ERROR });
    expect(await w.store.deleteMedia(BUILD, { credential: w.alice, id: up.id })).toEqual({
      status: "ok",
      value: "deleted",
    });
    expect(await held(w.store, up.id)).toMatchObject({ row: null, att: { gc_at: "1970-01-01T00:00:00.000Z" } });
  });

  it("a staging reservation a restore fenced is no longer the route's: K3 deletes its row and DELETE dooms it", async () => {
    const w = await avWorld();
    const up = await staged(w);
    const taken = await bookmark(w.store);
    await restore(w.store, taken, T0 + 6 * SECOND);
    clock(T0 + 7 * SECOND);
    expect(await w.store.deleteMedia(BUILD, { credential: w.alice, id: up.id })).toEqual({
      status: "ok",
      value: "deleted",
    });
    expect(await held(w.store, up.id)).toMatchObject({
      row: null,
      slot: null,
      att: { gc_at: "1970-01-01T00:00:00.000Z" },
    });
  });

  it("a DELETE delayed past a restore of a completed upload dooms the upload the restore brought back", async () => {
    const w = await avWorld();
    const up = await completed(w);
    const taken = await bookmark(w.store);
    await restore(w.store, taken, T0 + 6 * SECOND);
    clock(T0 + 7 * SECOND);
    expect(await del(w, up.id)).toEqual({ status: 200, body: {} });
    await swept(w, up.id);
  });

  it("a restore between a DELETE and the sweep brings the upload back, which the owner reads and deletes again", async () => {
    for (const make of [started, completed]) {
      const w = await avWorld();
      const up = await make(w);
      const taken = await bookmark(w.store);
      clock(T0 + 5 * SECOND);
      // The Store's own S11, with no sweep after it.
      expect(await w.store.deleteMedia(BUILD, { credential: w.alice, id: up.id })).toEqual({
        status: "ok",
        value: "deleted",
      });
      await restore(w.store, taken, T0 + 6 * SECOND);
      clock(T0 + 7 * SECOND);
      // A running upload comes back fenced (422); a completed one comes back as it was (200).
      expect(await get(w, up.id)).toMatchObject(
        make === started ? { status: 422, body: PROCESSING_ERROR } : { status: 200, body: { id: up.id } },
      );
      expect(await del(w, up.id)).toEqual({ status: 200, body: {} });
      await swept(w, up.id);
    }
  });

  it("a completed upload a restore brings back after the sweep deleted its files is shown, and its file answers 404", async () => {
    const w = await avWorld();
    const up = await completed(w);
    for (const key of [originalKey(up.id), fileKey(up.token, "full"), fileKey(up.token, "small")]) {
      await env.MEDIA.put(key, new Uint8Array([1, 2, 3]), { httpMetadata: { contentType: "video/mp4" } });
    }
    const taken = await bookmark(w.store);
    clock(T0 + 5 * SECOND);
    const url = new URL(((await get(w, up.id)).body as { url: string }).url);
    expect((await w.h.request(url.pathname)).status).toBe(200);
    // The DELETE's sweep deletes the keys and the row.
    expect((await del(w, up.id)).status).toBe(200);
    await swept(w, up.id);
    expect(await env.MEDIA.get(fileKey(up.token, "full"))).toBeNull();
    await restore(w.store, taken, T0 + 6 * SECOND);
    clock(T0 + 7 * SECOND);
    // As an image's restored row is shown on main: its URL, while its file is gone (W13).
    expect(await get(w, up.id)).toMatchObject({ status: 200, body: { id: up.id, url: url.href } });
    expect((await w.h.request(url.pathname)).status).toBe(404);
    // The owner's repair is to delete it.
    expect((await del(w, up.id)).status).toBe(200);
    await swept(w, up.id);
  });
});

describe("the owner's text and masks while processing (code review r1)", () => {
  it("keeps the description and focus a PUT wrote while pending or running through S6, shown by GET", async () => {
    for (const startAfterPut of [true, false]) {
      const w = await avWorld();
      // Pending: queued, its PUT before its start; running: started before its PUT.
      const up = startAfterPut ? await queued(w) : await started(w);
      clock(T0 + 3 * SECOND);
      expect(await held(w.store, up.id)).toMatchObject({ row: { state: startAfterPut ? "pending" : "running" } });
      expect((await put(w, up.id, { description: "later", focus: "0.5,0.75" })).status).toBe(206);
      let startId = (up as Partial<Started>).startId;
      if (startAfterPut) {
        const answer = await w.store.startNormalize(BUILD, { id: up.id, token: up.token, invocation: "inv-pending" });
        expect(answer.status).toBe("started");
        startId = (answer as { startId: string }).startId;
      }
      clock(T0 + 4 * SECOND);
      const done = await w.store.completeAvUpload(BUILD, {
        id: up.id,
        token: up.token,
        startId: startId!,
        facts: VIDEO,
      });
      expect(done.status).toBe("done");
      expect(await get(w, up.id)).toMatchObject({
        status: 200,
        body: { description: "later", meta: { focus: { x: 0.5, y: 0.75 } } },
      });
    }
  });

  it("writes nothing on a PUT of an upload a restore fenced, the marker read", async () => {
    const w = await avWorld();
    const up = await started(w);
    const taken = await bookmark(w.store);
    await restore(w.store, taken, T0 + 6 * SECOND);
    clock(T0 + 7 * SECOND);
    const before = await held(w.store, up.id);
    const text = () =>
      sql(w.store, "SELECT description, focus_x, focus_y, focus_given FROM media_attachments WHERE id = ?", up.id);
    const written = await text();
    expect(await put(w, up.id, { description: "later", focus: "0.5,0.5" })).toEqual({
      status: 422,
      body: PROCESSING_ERROR,
    });
    expect(await held(w.store, up.id)).toEqual(before);
    expect(await text()).toEqual(written);
    expect(await description(w, up.id)).toBe("a clip");
  });

  it("masks a stored URL, preview and blurhash while processing", async () => {
    const w = await avWorld();
    const up = await queued(w);
    await sql(
      w.store,
      `UPDATE media_attachments SET url = 'https://kopje.test/media/x/full.mp4',
				preview_url = 'https://kopje.test/media/x/small.png', blurhash = 'LEHV6nWB2yk8pyo0adR*.7kCMdnj' WHERE id = ?`,
      up.id,
    );
    clock(T0 + 5 * SECOND);
    expect(await get(w, up.id)).toEqual({ status: 206, body: masked(up.id, "a clip") });
  });
});

type Call = (...args: unknown[]) => Promise<unknown>;

// The Store stub the app calls, with its method `name` wrapped by `wrap` (apiHarness's wrapStore, storeWith).
function around(name: string, wrap: (call: Call) => Call) {
  return (store: StoreStub): StoreStub =>
    storeWith(store, { [name]: wrap((...args) => (store as unknown as Record<string, Call>)[name]!(...args)) });
}

// Holds the first call until `release` resolves, `reached` resolved when it is held: an explicit await point in a
// route (docs/engineering.md, "Tests").
function holdingFirst(reached: PromiseWithResolvers<void>, release: Promise<void>) {
  let held = false;
  return (call: Call): Call =>
    async (...args) => {
      if (!held) {
        held = true;
        reached.resolve();
        await release;
      }
      return call(...args);
    };
}

describe("a DELETE across a restore at the route (W13, Codex r7)", () => {
  it("a DELETE held before its Store call while a restore fences the staging reservation dooms it once released", async () => {
    const reached = deferred();
    const release = deferred();
    const w = await avWorld({ wrapStore: around("deleteMedia", holdingFirst(reached, release.promise)) });
    const up = await staged(w);
    const taken = await bookmark(w.store);
    clock(T0 + 5 * SECOND);
    const deleting = del(w, up.id);
    await reached.promise;
    await restore(w.store, taken, T0 + 6 * SECOND);
    clock(T0 + 7 * SECOND);
    release.resolve();
    expect(await deleting).toEqual({ status: 200, body: {} });
    await swept(w, up.id);
  });

  it("a restore while the DELETE's sweep is held before its selection: the sweep leaves the restored row and files", async () => {
    const reached = deferred();
    const release = deferred();
    const w = await avWorld({ wrapStore: around("expiredMedia", holdingFirst(reached, release.promise)) });
    const up = await completed(w);
    const keys = [originalKey(up.id), fileKey(up.token, "full"), fileKey(up.token, "small")];
    for (const key of keys) {
      await env.MEDIA.put(key, new Uint8Array([1, 2, 3]), { httpMetadata: { contentType: "video/mp4" } });
    }
    const live = await held(w.store, up.id);
    const taken = await bookmark(w.store);
    clock(T0 + 5 * SECOND);
    const deleting = del(w, up.id);
    await reached.promise;
    expect((await held(w.store, up.id)).att).toMatchObject({ gc_at: "1970-01-01T00:00:00.000Z" });
    await restore(w.store, taken, T0 + 6 * SECOND);
    release.resolve();
    expect(await deleting).toEqual({ status: 200, body: {} });
    expect(await held(w.store, up.id)).toEqual(live);
    for (const key of keys) {
      expect(await env.MEDIA.head(key), key).not.toBeNull();
    }
    clock(T0 + 7 * SECOND);
    expect(await get(w, up.id)).toMatchObject({ status: 200, body: { id: up.id } });
  });

  it("a DELETE whose committed reply is lost before the route answers 503, and its repeat 404", async () => {
    let lost = false;
    const w = await avWorld({
      wrapStore: around("deleteMedia", (call) => async (...args) => {
        if (lost) {
          return call(...args);
        }
        lost = true;
        await call(...args);
        throw Object.assign(new Error("Network connection lost."), { retryable: true });
      }),
    });
    const up = await started(w);
    clock(T0 + 5 * SECOND);
    expect((await del(w, up.id)).status).toBe(503);
    expect((await held(w.store, up.id)).att).toMatchObject({ gc_at: "1970-01-01T00:00:00.000Z" });
    expect(await del(w, up.id)).toEqual({ status: 404, body: NOT_FOUND });
  });
});

describe("S10's 200 through the owner's presenter (PR4-1 code review r1 M4)", () => {
  it.each([
    ["a video with a still", VIDEO],
    ["a video without one", VIDEO_NO_STILL],
    ["an audio upload", AUDIO],
  ] as const)("S6 then S10 for %s answers what the owner's GET shows", async (_name, facts) => {
    const w = await avWorld();
    const up = await completed(w, { v1: true, facts });
    clock(T0 + 5 * SECOND);
    const decided = await w.store.v1Final(BUILD, { id: up.id, token: up.token });
    const shown = await get(w, up.id);
    expect(shown.status).toBe(200);
    expect(decided).toEqual({ status: 200, media: shown.body });
    const origin = new URL((shown.body as { url: string }).url).origin;
    if (facts === VIDEO_NO_STILL) {
      expect(shown.body).toMatchObject({ preview_url: `${origin}${VIDEO_POSTER}`, blurhash: null });
      expect((shown.body as { meta: Record<string, unknown> }).meta).not.toHaveProperty("small");
    }
    if (facts === AUDIO) {
      expect(shown.body).toMatchObject({
        type: "audio",
        preview_url: null,
        meta: { original: { duration: 10, bitrate: 256_000 } },
      });
    }
    if (facts === VIDEO) {
      expect(shown.body).toMatchObject({
        meta: {
          original: { width: 1280, height: 720, frame_rate: "30/1", duration: 8, bitrate: 1_000_000 },
          small: { width: 640, height: 360 },
        },
        blurhash: VIDEO.preview?.blurhash,
      });
    }
  });
});

describe("an image's GET, PUT and DELETE read what they read before #1828 (code review r1)", () => {
  it("runs one media statement for GET, three for PUT and three for DELETE, reading the row's description as before", async () => {
    const w = await avWorld();
    const id = await imageUpload(w);
    const statements = await runInDurableObject(w.store, (_instance, state) => {
      const counts: number[] = [];
      const rowReads: number[] = [];
      for (const op of OWNER_OPS) {
        let n = 0;
        let full = 0;
        const counting = observedSql(state.storage.sql, (rows, query) => {
          if (/\bmedia_(attachments|processing|av_slots)\b/.test(query)) {
            n++;
          }
          if (rows.some((row) => "description" in row)) {
            full++;
          }
        });
        const input = { credential: w.alice, id, now: Date.now(), restoredAt: "unread" as const };
        const answered = (op as typeof updateOwnerMedia).run(counting, { ...input, changes: { description: "a" } });
        expect(answered).toMatchObject({ status: "ok" });
        counts.push(n);
        rowReads.push(full);
      }
      return { counts, rowReads };
    });
    // On cd9292004: getMedia's ownUpload; updateMedia's ownUpload, UPDATE and ownUpload; deleteOwnMedia's used and kept,
    // ownUpload and UPDATE. The presented row (its description) is read once by GET, twice by PUT and once by DELETE.
    expect(statements).toEqual({ counts: [1, 3, 3], rowReads: [1, 2, 1] });
  });
});

describe("the Store's entry points across a deploy (code review r1)", () => {
  it("keeps getMedia, updateMedia and deleteMedia, so a Worker of another build is refused as version-mismatch", async () => {
    const w = await avWorld();
    const up = await queued(w);
    const other = "0.0.0-other";
    const input = { credential: w.alice, id: up.id };
    const calls = [
      () => w.store.getMedia(other, input),
      () => w.store.updateMedia(other, { ...input, changes: { description: "x" } }),
      () => w.store.deleteMedia(other, input),
    ];
    for (const call of calls) {
      expect(toStoreUnavailable(await rejectionOf(call()))?.reason).toBe("version-mismatch");
    }
  });
});

describe("the owner's two passes (store.ts markedRun)", () => {
  it("reads the restore marker only for an upload whose processing row K3 could act on", async () => {
    const cases: [(w: AvWorld) => Promise<{ id: string }>, string, number][] = [
      [queued, "processing", 1],
      [(w) => failed(w, "refused"), "failed", 0],
      [completed, "ok", 0],
    ];
    for (const [make, status, reads] of cases) {
      const w = await avWorld();
      const up = await make(w);
      clock(T0 + 5 * SECOND);
      expect(await counted(w, ownerMedia, up.id)).toEqual({ answer: status, reads });
    }
  });
});

// ---- The upload route (#1828 PR4-4, mastodon/media-av.ts): the route's side of the plan's 1.1 and 1.4, its v1 wait, and
// the part rules, through the production route with the Store's own operations; held calls by explicit gates.

async function slotOf(w: RouteWorld, id: string) {
  return (await held(w.store, id)).slot;
}

describe("a video or audio upload through the route (v2)", () => {
  it("stages the file into incoming/<id>, queues it with its text, dispatches one run and answers 202 as GET's 206", async () => {
    const w = await routeWorld();
    const file = mp4(20_000);
    const response = await postMedia(
      w,
      multipartBody([videoPart(file), { name: "description", data: "a clip" }, { name: "focus", data: "0.25,-0.5" }]),
    );
    const accepted = await answerOf(response);
    expect(accepted.status).toBe(202);
    const id = (accepted.body as { id: string }).id;
    expect(await input(id)).toEqual(file);
    expect(w.runs).toEqual([{ id, token: expect.any(String), teardownId: (await slotOf(w, id))?.teardown_id }]);
    expect(await charged(w.store)).toBe(1);
    expect((await held(w.store, id)).row?.state).toBe("pending");
    const shown = await get(w, id);
    expect(shown).toEqual({ status: 206, body: accepted.body });
    expect(accepted.body).toMatchObject({ type: "video", url: null, description: "a clip" });
  });

  // The AV reader frames the body as the image path's parser does (code review r1 M6): an LF delimiter ends the file,
  // so the description after it is the upload's and no delimiter is staged; a malformed close is refused.
  it("ends the file at an LF delimiter, as formData() does: the input is the file, the description is read", async () => {
    const w = await routeWorld();
    const file = mp4(20_000);
    const enc = new TextEncoder();
    const B = "kopje-route-boundary";
    const body = concat(
      enc.encode(
        `--${B}\r\nContent-Disposition: form-data; name="file"; filename="v.mp4"\r\nContent-Type: video/mp4\r\n\r\n`,
      ),
      file,
      enc.encode(`\n--${B}\r\nContent-Disposition: form-data; name="description"\r\n\r\na clip\r\n--${B}--\r\n`),
    );
    const response = await postMedia(w, { body, contentType: `multipart/form-data; boundary=${B}` });
    const accepted = await answerOf(response);
    expect(accepted).toMatchObject({ status: 202, body: { description: "a clip" } });
    expect(await input((accepted.body as { id: string }).id)).toEqual(file);
  });

  it("refuses a closing delimiter followed by junk: 422, nothing queued", async () => {
    const w = await routeWorld();
    const { body } = multipartBody([videoPart()]);
    const text = new TextEncoder().encode("junk");
    const closed = concat(body.subarray(0, body.byteLength - 2), text);
    const response = await postMedia(w, {
      body: closed,
      contentType: "multipart/form-data; boundary=kopje-route-boundary",
    });
    expect(response.status).toBe(422);
    await leftNothing(w);
  });

  it("takes audio by its signature", async () => {
    const w = await routeWorld();
    const accepted = await answerOf(
      await postMedia(w, multipartBody([{ name: "file", data: mp3(), filename: "a.mp3", type: "audio/mpeg" }])),
    );
    expect(accepted).toMatchObject({ status: 202, body: { type: "audio" } });
  });
});

async function tokenOf(w: RouteWorld, id: string): Promise<string> {
  const [row] = await sql<{ file_token: string }>(w.store, "SELECT file_token FROM media_attachments WHERE id = ?", id);
  return row?.file_token ?? "";
}

// S4 for the upload `id` as the processor makes it: its start_id.
async function startJob(w: RouteWorld, id: string): Promise<string> {
  const answer = await w.store.startNormalize(BUILD, { id, token: await tokenOf(w, id), invocation: `inv-${id}` });
  if (answer.status !== "started") {
    throw new Error(`not started: ${JSON.stringify(answer)}`);
  }
  return answer.startId;
}

async function completeJob(w: RouteWorld, id: string, startId: string, facts = VIDEO): Promise<void> {
  const done = await w.store.completeAvUpload(BUILD, { id, token: await tokenOf(w, id), startId, facts });
  if (done.status !== "done") {
    throw new Error(`not completed: ${done.status}`);
  }
}

// What a refused upload leaves: no input, nothing charged, no processing row or slot, no run.
async function leftNothing(w: RouteWorld): Promise<void> {
  const id = await lastUpload(w);
  expect(await input(id)).toBeNull();
  expect(await charged(w.store)).toBe(0);
  expect(await held(w.store, id)).toMatchObject({ row: null, slot: null });
  expect(w.runs).toEqual([]);
}

const PNG_PART = { name: "file", data: imageBytes(), filename: "a.png", type: "image/png" };
const THUMB_FILE = { name: "thumbnail", data: imageBytes(), filename: "t.png", type: "image/png" };
// A thumbnail file part whose bytes are no image type by their signature.
const NOT_IMAGE_THUMB = { name: "thumbnail", data: mp4(64), filename: "t.png", type: "image/png" };

function imageBytes(): Uint8Array {
  // A PNG's signature and IHDR start: sniffImageType reads it as image/png.
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1,
  ]);
}

describe("the parts of a video or audio upload (P7, C2-M6)", () => {
  it("refuses a second file part after the video (MP4 then PNG): 422, no input, nothing charged", async () => {
    const w = await routeWorld();
    const response = await postMedia(w, multipartBody([videoPart(), PNG_PART]));
    expect(await answerOf(response)).toEqual({
      status: 422,
      body: { error: "Validation failed: File was sent more than once" },
    });
    await leftNothing(w);
    // The guarded branch ran: S1 took a slot and S2 released it.
    expect(w.gate.calls).toEqual(expect.arrayContaining(["takeAvSlot", "releaseStaging"]));
  });

  it("takes PNG then MP4 down the image pipeline, which answers what it answers for that body", async () => {
    const w = await routeWorld();
    const response = await postMedia(w, multipartBody([PNG_PART, videoPart()]));
    expect(await answerOf(response)).toEqual({
      status: 422,
      body: { error: "Validation failed: File content type is invalid" },
    });
    expect(w.gate.calls).not.toContain("takeAvSlot");
    expect(w.gate.calls).toContain("startTransforms");
  });

  // #1828 PR6: a video or audio file takes an image thumbnail (test/media-av-thumbnails.test.ts); one that is no image
  // is refused, before the file before any slot, after it as a staging exit.
  it.each([
    ["before", (file: ReturnType<typeof videoPart>) => [NOT_IMAGE_THUMB, file]],
    ["after", (file: ReturnType<typeof videoPart>) => [file, NOT_IMAGE_THUMB]],
  ])("refuses a thumbnail part that is no image %s the file: 422, no input, nothing charged", async (_, parts) => {
    const w = await routeWorld();
    const response = await postMedia(w, multipartBody(parts(videoPart())));
    expect(await answerOf(response)).toEqual({
      status: 422,
      body: { error: "Validation failed: Thumbnail content type is invalid" },
    });
    await leftNothing(w);
    expect(w.codec.calls).toBe(0);
  });

  it("reads the description and focus after the file", async () => {
    const w = await routeWorld();
    const response = await postMedia(
      w,
      multipartBody([videoPart(), { name: "focus", data: "0.5,0.5" }, { name: "description", data: "after" }]),
    );
    expect(await answerOf(response)).toMatchObject({ status: 202, body: { description: "after" } });
    const id = await lastUpload(w);
    expect(
      await sql(w.store, "SELECT description, focus_x, focus_y, focus_given FROM media_attachments WHERE id = ?", id),
    ).toEqual([{ description: "after", focus_x: 0.5, focus_y: 0.5, focus_given: 1 }]);
  });

  it("refuses an invalid trailing description once every part is read: S2 releases the slot, nothing charged", async () => {
    const w = await routeWorld();
    const response = await postMedia(
      w,
      multipartBody([videoPart(), { name: "description", data: "x".repeat(MAX_MEDIA_DESCRIPTION_LENGTH + 1) }]),
    );
    expect(await answerOf(response)).toEqual({ status: 422, body: DESCRIPTION_TOO_LONG });
    await leftNothing(w);
    expect(w.gate.calls).toContain("releaseStaging");
  });
  it("decides a text file part or a thumbnail file before the video without taking a slot", async () => {
    for (const first of [{ name: "file", data: "text" }, NOT_IMAGE_THUMB]) {
      const w = await routeWorld();
      const response = await postMedia(w, multipartBody([first, videoPart()]));
      expect(response.status).toBe(422);
      expect(w.gate.calls).toContain("reserveMedia");
      expect(w.gate.calls).not.toContain("takeAvSlot");
    }
  });

  it.each([
    ["released", false],
    ["no longer the route's (a restore fenced it)", true],
  ])(
    "a staging whose R2 completion lands after its cut: S2 %s, the input deleted only on released (1.1)",
    async (_, fenced) => {
      const landed = deferred();
      const hold = deferred();
      // The completion commits, and its reply is held past the cut.
      const { bucket } = hookedBucket({ holdComplete: { committed: () => landed.resolve(), reply: hold.promise } });
      const w = await routeWorld({ bucket });
      const response = postMedia(w, multipartBody([videoPart()]));
      await landed.promise;
      const id = await lastUpload(w);
      expect(await input(id)).not.toBeNull();
      if (fenced) {
        await restore(w.store, await bookmark(w.store), Date.now());
      }
      await w.advance(Math.max(...w.timers.pending));
      hold.resolve();
      expect(await answerOf(await response)).toEqual({
        status: 503,
        body: { error: "Media processing took too long to receive. Try again." },
      });
      expect(w.gate.calls).toContain("releaseStaging");
      if (fenced) {
        expect(await input(id)).not.toBeNull();
      } else {
        expect(await input(id)).toBeNull();
      }
    },
  );

  // The form's error order on the AV path (code review r1 M7): the query first, as Rack reads it; a thumbnail as
  // thumbnailSent counts one (empty text is none); a thumbnail before the file refused before any slot (P7), one after
  // it after the description, as the image path orders them.
  it("answers a malformed query 400 before a thumbnail before the file, taking no slot", async () => {
    const w = await routeWorld();
    const { body, contentType } = multipartBody([THUMB_FILE, videoPart()]);
    const response = await w.h.request("/api/v2/media?a[]=1&a[b]=2", {
      method: "POST",
      headers: { authorization: `Bearer ${w.h.users.alice.token}`, "content-type": contentType },
      body,
    });
    expect(await answerOf(response)).toEqual({ status: 400, body: { error: "Malformed request body" } });
    expect(w.gate.calls).not.toContain("takeAvSlot");
  });

  it("refuses a text thumbnail before the file before any slot (D-3)", async () => {
    const w = await routeWorld();
    const response = await postMedia(w, multipartBody([{ name: "thumbnail", data: "data:x" }, videoPart()]));
    expect(await answerOf(response)).toEqual({
      status: 422,
      body: { error: "Validation failed: Thumbnail content type is invalid" },
    });
    expect(w.gate.calls).not.toContain("takeAvSlot");
  });

  it("takes an empty text thumbnail as none, as the image path does", async () => {
    const w = await routeWorld();
    const response = await postMedia(w, multipartBody([{ name: "thumbnail", data: "" }, videoPart()]));
    expect(response.status).toBe(202);
  });

  it("answers an invalid description before a thumbnail file after the file, as the image path orders them", async () => {
    const w = await routeWorld();
    const response = await postMedia(
      w,
      multipartBody([
        videoPart(),
        NOT_IMAGE_THUMB,
        { name: "description", data: "x".repeat(MAX_MEDIA_DESCRIPTION_LENGTH + 1) },
      ]),
    );
    expect(await answerOf(response)).toEqual({ status: 422, body: DESCRIPTION_TOO_LONG });
    await leftNothing(w);
  });

  // Deviation (docs/mastodon-deviations.md): a thumbnail before the file is refused before the description is read.
  it("answers a thumbnail before the file over an invalid description after it", async () => {
    const w = await routeWorld();
    const response = await postMedia(
      w,
      multipartBody([
        NOT_IMAGE_THUMB,
        videoPart(),
        { name: "description", data: "x".repeat(MAX_MEDIA_DESCRIPTION_LENGTH + 1) },
      ]),
    );
    expect(await answerOf(response)).toEqual({
      status: 422,
      body: { error: "Validation failed: Thumbnail content type is invalid" },
    });
    expect(w.gate.calls).not.toContain("takeAvSlot");
  });
});

describe("the staging of a video or audio upload (P6)", () => {
  it("refuses a file of exactly AV_UPLOAD_LIMIT + 1 bytes and takes one of AV_UPLOAD_LIMIT", async () => {
    const over = await routeWorld();
    const refused = await postMedia(over, multipartBody([videoPart(mp4(AV_UPLOAD_LIMIT + 1))]));
    expect(refused.status).toBe(422);
    await leftNothing(over);
    const at = await routeWorld();
    const taken = await postMedia(at, multipartBody([videoPart(mp4(AV_UPLOAD_LIMIT))]));
    expect(taken.status).toBe(202);
  });

  it("stops reading the bytes before the type is known at MEDIA_BODY_LIMIT: 422, no slot", async () => {
    const chunk = 64 * 1024;
    const { body: rest, contentType } = multipartBody([videoPart()]);
    // A preamble before the first delimiter: only the reader's ceiling bounds it.
    const bytes = new Uint8Array(MEDIA_BODY_LIMIT + 1024 * 1024 + rest.byteLength).fill(0x61);
    bytes.set(rest, bytes.byteLength - rest.byteLength);
    const body = new SlowBody(bytes, { chunk });
    const w = await routeWorld();
    const response = await postMedia(w, { body: body.stream(), contentType });
    expect(response.status).toBe(422);
    // The chunk that passed the ceiling, and the one the stream pulled ahead.
    expect(body.pulled).toBeLessThanOrEqual(MEDIA_BODY_LIMIT + 2 * chunk);
    expect(w.gate.calls).not.toContain("takeAvSlot");
  });

  it("stops reading at AV_UPLOAD_LIMIT + 1 bytes of the file, holding at most PART_BYTES and one read", async () => {
    const parts: number[] = [];
    let body: SlowBody | null = null;
    let peak = 0;
    const { bucket } = hookedBucket({
      onPart: (part) => {
        parts.push(part.byteLength);
        // What was read and not yet written: the part itself and what the reader holds besides it.
        peak = Math.max(peak, (body?.pulled ?? 0) - parts.slice(0, -1).reduce((a, b) => a + b, 0));
      },
    });
    const w = await routeWorld({ bucket });
    const chunk = 256 * 1024;
    const { body: bytes, contentType } = multipartBody([videoPart(mp4(AV_UPLOAD_LIMIT + 1 + 4 * chunk))]);
    body = new SlowBody(bytes, { chunk });
    const response = await postMedia(w, { body: body.stream(), contentType });
    expect(await answerOf(response)).toEqual({
      status: 422,
      body: { error: "Validation failed: File file size must be less than 90 MB" },
    });
    // Reading stopped at the chunk that passed the cap: never the rest of the file.
    expect(body.pulled).toBeLessThanOrEqual(AV_UPLOAD_LIMIT + 1 + 2 * chunk);
    expect(body.pulled).toBeGreaterThan(AV_UPLOAD_LIMIT);
    expect(parts.every((n) => n === PART_BYTES)).toBe(true);
    expect(peak).toBeLessThanOrEqual(PART_BYTES + chunk);
    await leftNothing(w);
  });

  it("answers spent 429 at the sniff with Images room left, with no input (P15)", async () => {
    const w = await routeWorld({ budget: 1 });
    expect((await postMedia(w, multipartBody([videoPart()]))).status).toBe(202);
    const second = await postMedia(w, multipartBody([videoPart()]));
    expect(await answerOf(second)).toEqual({
      status: 429,
      body: { error: "This server's media processing budget for the month is used up" },
    });
    const id = await lastUpload(w);
    expect(await input(id)).toBeNull();
    expect(await held(w.store, id)).toMatchObject({ row: null, slot: null });
    expect(await charged(w.store)).toBe(1);
  });

  it("answers busy 503 to the upload beyond MAX_AV_INFLIGHT slow ones, with no input", async () => {
    const w = await routeWorld();
    const slow = Array.from({ length: MAX_AV_INFLIGHT }, () => {
      // Held past the sniff (SNIFF_BYTES), so S1 has taken the slot.
      const { body, contentType } = multipartBody([videoPart(mp4(200_000))]);
      const stream = new SlowBody(body, { chunk: 1024, holdAt: 150_000 });
      const response = postMedia(w, { body: stream.stream(), contentType });
      response.catch(() => {});
      return { stream, response };
    });
    for (const { stream } of slow) {
      await stream.reachedHold.promise;
    }
    const busy = await postMedia(w, multipartBody([videoPart()]));
    expect(await answerOf(busy)).toEqual({
      status: 503,
      body: { error: "Media processing is busy. Try again in a moment." },
    });
    expect(await input(await lastUpload(w))).toBeNull();
    for (const { stream, response } of slow) {
      stream.release();
      expect((await response).status).toBe(202);
    }
  });
});

describe("the route's rows of 1.1 and 1.4", () => {
  it("repeats S3 once when its committed reply is lost: queued, one charge, one run", async () => {
    const w = await routeWorld();
    w.gate.drops.set("queueNormalize", 1);
    const accepted = await answerOf(await postMedia(w, multipartBody([videoPart()])));
    expect(accepted.status).toBe(202);
    const id = await lastUpload(w);
    expect(w.gate.calls.filter((c) => c === "queueNormalize")).toHaveLength(2);
    expect(await charged(w.store)).toBe(1);
    expect(w.runs).toEqual([{ id, token: expect.any(String), teardownId: (await slotOf(w, id))?.teardown_id }]);
  });

  it("answers 503 when S3's reply is lost twice, deleting nothing: the dispatch round starts it once", async () => {
    const w = await routeWorld();
    w.gate.drops.set("queueNormalize", 2);
    const file = mp4(10_000);
    expect((await postMedia(w, multipartBody([videoPart(file)]))).status).toBe(503);
    const id = await lastUpload(w);
    expect(await input(id)).toEqual(file);
    expect(await charged(w.store)).toBe(1);
    expect(w.runs).toEqual([]);
    expect(await held(w.store, id)).toMatchObject({ row: { state: "pending" }, slot: { phase: "processing" } });
    clock(Date.now() + DISPATCH_MS);
    const round = await w.store.mediaDispatchRound(BUILD);
    expect(round).toMatchObject({ runs: [{ id }] });
  });

  it("H3: a lost S3 reply whose repeat is held while S12 starts and the job completes answers settled, 202, one charge, no second run", async () => {
    const w = await routeWorld();
    w.gate.drops.set("queueNormalize", 1);
    const repeat = w.gate.hold("queueNormalize", "before", 1);
    const reached = w.gate.reached("queueNormalize");
    const file = mp4(10_000);
    const response = postMedia(w, multipartBody([videoPart(file)]));
    await reached;
    const id = await lastUpload(w);
    clock(Date.now() + DISPATCH_MS);
    expect(await w.store.mediaDispatchRound(BUILD)).toMatchObject({ runs: [{ id }] });
    const startId = await startJob(w, id);
    expect((await held(w.store, id)).row?.state).toBe("running");
    await completeJob(w, id, startId);
    repeat.resolve();
    const posted = await answerOf(await response);
    expect(posted.status).toBe(202);
    expect(w.runs).toEqual([]);
    expect(await charged(w.store)).toBe(1);
    expect(await input(id)).toEqual(file);
    // The 202 shows the upload as GET shows it now: completed (code review r1 M5).
    const shown = await get(w, id);
    expect(shown.status).toBe(200);
    expect(posted.body).toEqual(shown.body);
  });

  it("a settled S3 repeat of a running job answers 202 with GET's masked entity (code review r1 M5)", async () => {
    const w = await routeWorld();
    w.gate.drops.set("queueNormalize", 1);
    const repeat = w.gate.hold("queueNormalize", "before", 1);
    const reached = w.gate.reached("queueNormalize");
    const response = postMedia(w, multipartBody([videoPart(), { name: "description", data: "kept" }]));
    await reached;
    const id = await lastUpload(w);
    await startJob(w, id);
    repeat.resolve();
    const posted = await answerOf(await response);
    const shown = await get(w, id);
    expect(shown.status).toBe(206);
    expect(posted).toEqual({ status: 202, body: shown.body });
  });

  it("a settled S3 repeat after a restore failed the job (K3) answers 202, and GET then the failure (code review r1 M5)", async () => {
    const w = await routeWorld();
    w.gate.drops.set("queueNormalize", 1);
    const repeat = w.gate.hold("queueNormalize", "before", 1);
    const reached = w.gate.reached("queueNormalize");
    const response = postMedia(w, multipartBody([videoPart()]));
    await reached;
    const id = await lastUpload(w);
    clock(Date.now() + SECOND);
    await restore(w.store, await bookmark(w.store), Date.now());
    clock(Date.now() + SECOND);
    repeat.resolve();
    const posted = await answerOf(await response);
    expect(posted).toMatchObject({ status: 202, body: { id, url: null } });
    const shown = await w.h.request(`/api/v1/media/${id}`, bearer(w.h.users.alice.token));
    expect(shown.status).toBe(422);
  });

  it("M5: a probe failure while the body is read refuses the queue (422, input deleted, nothing charged), and a queued job still finishes", async () => {
    const w = await routeWorld();
    expect((await postMedia(w, multipartBody([videoPart()]))).status).toBe(202);
    const earlier = await lastUpload(w);
    const { body, contentType } = multipartBody([videoPart(mp4(200_000))]);
    const stream = new SlowBody(body, { chunk: 1024, holdAt: 150_000 });
    const response = postMedia(w, { body: stream.stream(), contentType });
    await stream.reachedHold.promise;
    await failProbe(w);
    stream.release();
    expect(await answerOf(await response)).toEqual({
      status: 422,
      body: { error: "Validation failed: File content type is invalid" },
    });
    const id = await lastUpload(w);
    expect(await input(id)).toBeNull();
    expect(await charged(w.store)).toBe(1);
    expect(w.runs.map((r) => r.id)).toEqual([earlier]);
    await completeJob(w, earlier, await startJob(w, earlier));
  });

  it("takes the image pipeline when S1 finds the probe failed after the reservation", async () => {
    const w = await routeWorld();
    const hold = w.gate.hold("takeAvSlot");
    const reached = w.gate.reached("takeAvSlot");
    const response = postMedia(w, multipartBody([videoPart()]));
    await reached;
    await failProbe(w);
    hold.resolve();
    expect(await answerOf(await response)).toEqual({
      status: 422,
      body: { error: "Validation failed: File content type is invalid" },
    });
    expect(w.gate.calls).toContain("startTransforms");
    expect(await held(w.store, await lastUpload(w))).toMatchObject({ row: null, slot: null });
  });
});

// The Images counters (the instance's and the account's), by name.
async function transformCounters(w: RouteWorld): Promise<string[]> {
  const rows = await sql<{ value: string }>(
    w.store,
    "SELECT value FROM kopje_state WHERE name LIKE 'images_transforms:%' OR name LIKE 'images_account_transforms:%' ORDER BY name",
  );
  return rows.map((r) => r.value);
}

// A failed probe of the normalize profile for this build: uploads are inactive.
async function failProbe(w: RouteWorld): Promise<void> {
  await sql(
    w.store,
    "UPDATE kopje_state SET value = json_set(value, '$.ok', json('false')) WHERE name = 'media_probe:normalize@standard-4'",
  );
}

describe("the v1 wait (P8, H1, C2-M3, r4 H1, M5, W5)", () => {
  // A v1 upload sent at the route's time now, waiting at its first poll: its id, arrival, cut and give-up on the
  // route's clock, and its response.
  async function waiting(w: RouteWorld, parts = [videoPart()]) {
    const arrival = Date.now() + w.skew.ms;
    const polled = w.timers.waitFor(V1_POLL_MS);
    const response = postMedia(w, multipartBody(parts), "v1");
    response.catch(() => {});
    await polled;
    const id = await lastUpload(w);
    return { id, arrival, cut: arrival + V1_TIME_MS - T_REPLY, giveUp: arrival + V1_TIME_MS, response };
  }

  // Moves the route's clock to `at` (the Store's to `at` less the skew) and fires its due waits.
  const routeAt = (w: RouteWorld, at: number) => w.advance(at - w.skew.ms);

  it("answers S10's 200 once S9 shows the completion, as the owner's GET shows it", async () => {
    const w = await routeWorld();
    const v = await waiting(w);
    await completeJob(w, v.id, await startJob(w, v.id));
    await routeAt(w, v.arrival + V1_POLL_MS);
    const answered = await answerOf(await v.response);
    expect(answered.status).toBe(200);
    expect(await get(w, v.id)).toEqual(answered);
  });

  it("answers a video without a still with VIDEO_POSTER (P16)", async () => {
    const w = await routeWorld();
    const v = await waiting(w);
    await completeJob(w, v.id, await startJob(w, v.id), VIDEO_NO_STILL);
    await routeAt(w, v.arrival + V1_POLL_MS);
    const answered = await answerOf(await v.response);
    expect(answered).toMatchObject({ status: 200, body: { preview_url: `https://kopje.test${VIDEO_POSTER}` } });
  });

  it.each([
    ["timeout", 500, "Error processing thumbnail for uploaded media"],
    ["unavailable", 500, "Error processing thumbnail for uploaded media"],
    ["refused", 422, "Validation failed: File is too long or too large to process"],
    ["envelope", 422, "Validation failed: File is too long or too large to process"],
  ] as const)("answers a failure %s with %i", async (cause, status, error) => {
    const w = await routeWorld();
    const v = await waiting(w);
    const startId = await startJob(w, v.id);
    await w.store.failNormalize(BUILD, { id: v.id, startId, cause });
    await routeAt(w, v.arrival + V1_POLL_MS);
    expect(await answerOf(await v.response)).toEqual({ status, body: { error } });
  });

  it("decides at the route's cut, whatever the Store's deadline_at: S10 dooms the running job, and nothing completes after the 503", async () => {
    const w = await routeWorld();
    // S1 delayed after it was sent: the Store's reply_by, and deadline_at, fall after the route's cut.
    const s1 = w.gate.hold("takeAvSlot");
    const reached = w.gate.reached("takeAvSlot");
    const arrival = Date.now();
    const polled = w.timers.waitFor(V1_POLL_MS);
    const response = postMedia(w, multipartBody([videoPart()]), "v1");
    await reached;
    clock(Date.now() + 10 * SECOND);
    s1.resolve();
    await polled;
    const id = await lastUpload(w);
    const startId = await startJob(w, id);
    const deadline = (await held(w.store, id)).row?.deadline_at ?? 0;
    expect(deadline).toBeGreaterThan(arrival + V1_TIME_MS - T_REPLY);
    expect(w.gate.calls).not.toContain("v1Final");
    await w.advance(arrival + V1_TIME_MS - T_REPLY);
    expect(await answerOf(await response)).toEqual({
      status: 503,
      body: { error: "Media processing took too long. Try a shorter file." },
    });
    expect(await held(w.store, id)).toMatchObject({ row: null, att: { gc_at: DOOMED_AT } });
    const late = await w.store.completeAvUpload(BUILD, { id, token: await tokenOf(w, id), startId, facts: VIDEO });
    expect(late.status).toBe("refused");
  });

  it.each([
    ["ahead of", 30 * SECOND],
    ["behind", -30 * SECOND],
  ])("cuts on its own clock, %s the Store's", async (_, skew) => {
    const w = await routeWorld();
    w.skew.ms = skew;
    const v = await waiting(w);
    await startJob(w, v.id);
    await routeAt(w, v.cut - 1);
    expect(w.gate.calls).not.toContain("v1Final");
    await routeAt(w, v.cut);
    expect((await v.response).status).toBe(503);
    expect(w.gate.calls).toContain("v1Final");
    expect(Date.now()).toBe(v.cut - skew);
  });

  it("completion just before the cut, with a normal S10 reply in the reserve, answers 200", async () => {
    const w = await routeWorld();
    const v = await waiting(w);
    const startId = await startJob(w, v.id);
    clock(v.cut - 1);
    await completeJob(w, v.id, startId);
    await w.advance(v.cut);
    expect((await v.response).status).toBe(200);
  });

  it("W5: S10 committed with its reply lost answers 503, the upload doomed", async () => {
    const w = await routeWorld();
    const v = await waiting(w);
    await startJob(w, v.id);
    w.gate.drops.set("v1Final", 1);
    await w.advance(v.cut);
    expect(await answerOf(await v.response)).toEqual({
      status: 503,
      body: { error: "Media processing took too long. Try a shorter file." },
    });
    expect((await held(w.store, v.id)).att?.gc_at).toBe(DOOMED_AT);
  });

  it("W5: S10 failing before its commit answers 503, and K4 dooms the upload at its deadline_at", async () => {
    const w = await routeWorld();
    const v = await waiting(w);
    await startJob(w, v.id);
    w.gate.fails.set("v1Final", 1);
    await w.advance(v.cut);
    expect((await v.response).status).toBe(503);
    const after = await held(w.store, v.id);
    expect(after.row?.state).toBe("running");
    clock(after.row?.deadline_at ?? 0);
    await w.store.mediaDispatchRound(BUILD);
    expect(await held(w.store, v.id)).toMatchObject({ row: null, att: { gc_at: DOOMED_AT } });
  });

  it("maintenance begun during the wait answers the maintenance 503 and dooms nothing; K4 after it", async () => {
    const w = await routeWorld();
    const v = await waiting(w);
    await startJob(w, v.id);
    await gate(w.store, "maintenance", true);
    await w.advance(v.cut);
    const answered = await v.response;
    expect(await answerOf(answered)).toEqual({
      status: 503,
      body: { error: "This server is under maintenance. Try again later." },
    });
    expect((await held(w.store, v.id)).row?.state).toBe("running");
    await gate(w.store, "maintenance", false);
    clock((await held(w.store, v.id)).row?.deadline_at ?? 0);
    await w.store.mediaDispatchRound(BUILD);
    expect((await held(w.store, v.id)).att?.gc_at).toBe(DOOMED_AT);
  });

  it("a completion before maintenance answers 200 in maintenance", async () => {
    const w = await routeWorld();
    const v = await waiting(w);
    await completeJob(w, v.id, await startJob(w, v.id));
    await gate(w.store, "maintenance", true);
    await w.advance(v.arrival + V1_POLL_MS);
    expect((await v.response).status).toBe(200);
  });

  it("Q4: a restore during the wait answers 503 with the upload doomed, S10's K3 first", async () => {
    const w = await routeWorld();
    const v = await waiting(w);
    await startJob(w, v.id);
    await restore(w.store, await bookmark(w.store), Date.now());
    await w.advance(v.cut);
    expect((await v.response).status).toBe(503);
    expect(await held(w.store, v.id)).toMatchObject({ row: null, att: { gc_at: DOOMED_AT } });
  });

  it("Q4: a restore during the wait answers 503 with the upload doomed, the round's K3 first", async () => {
    const w = await routeWorld();
    const v = await waiting(w);
    await startJob(w, v.id);
    await restore(w.store, await bookmark(w.store), Date.now());
    await w.store.mediaDispatchRound(BUILD);
    expect((await held(w.store, v.id)).row).toMatchObject({ state: "failed", failure: "restored" });
    await w.advance(v.arrival + V1_POLL_MS);
    expect((await v.response).status).toBe(503);
    expect(await held(w.store, v.id)).toMatchObject({ row: null, att: { gc_at: DOOMED_AT } });
  });

  it("a held ingress read answers 503 by V1_TIME_MS from arrival: nothing charged, S2 released, no input", async () => {
    const w = await routeWorld();
    const arrival = Date.now();
    const { body, contentType } = multipartBody([videoPart(mp4(200_000))]);
    const stream = new SlowBody(body, { chunk: 1024, holdAt: 150_000 });
    const response = postMedia(w, { body: stream.stream(), contentType }, "v1");
    await stream.reachedHold.promise;
    await w.advance(arrival + V1_TIME_MS - T_REPLY);
    expect(await answerOf(await response)).toEqual({
      status: 503,
      body: { error: "Media processing took too long to receive. Try again." },
    });
    expect(Date.now()).toBeLessThanOrEqual(arrival + V1_TIME_MS);
    expect(w.gate.calls).toContain("releaseStaging");
    await leftNothing(w);
  });

  it("W5: S3's reply lost twice answers 503 with nothing deleted", async () => {
    const w = await routeWorld();
    w.gate.drops.set("queueNormalize", 2);
    const response = await postMedia(w, multipartBody([videoPart()]), "v1");
    expect(response.status).toBe(503);
    const id = await lastUpload(w);
    expect(await input(id)).not.toBeNull();
    expect(w.gate.calls).not.toContain("v1Final");
  });

  it("W5: the give-up answers 503 at V1_TIME_MS while S10 is held, though S10 then decides 200", async () => {
    const w = await routeWorld();
    const v = await waiting(w);
    await completeJob(w, v.id, await startJob(w, v.id));
    const s10 = w.gate.hold("v1Final");
    const reached = w.gate.reached("v1Final");
    await w.advance(v.cut);
    await reached;
    await w.advance(v.giveUp);
    s10.resolve();
    expect(await answerOf(await v.response)).toEqual({
      status: 503,
      body: { error: "Media processing took too long. Try a shorter file." },
    });
  });

  // One clock (code review r2 M1): S10 is waited for until the give-up, no inner bound shortening it.
  it("S10 started early and answered between STORE_CALL_MS and the give-up answers 200", async () => {
    const w = await routeWorld();
    const v = await waiting(w);
    await completeJob(w, v.id, await startJob(w, v.id));
    const s10 = w.gate.hold("v1Final", "after");
    const reached = w.gate.reached("v1Final");
    await routeAt(w, v.arrival + 2 * SECOND);
    await reached;
    await routeAt(w, v.arrival + 2 * SECOND + STORE_CALL_MS);
    clock(v.arrival + 3 * SECOND + STORE_CALL_MS);
    s10.resolve();
    expect((await v.response).status).toBe(200);
  });

  it("D45: S10's 200 received before the give-up fires is the answer, though the clock is past V1_TIME_MS", async () => {
    const w = await routeWorld();
    const v = await waiting(w);
    await completeJob(w, v.id, await startJob(w, v.id));
    const s10 = w.gate.hold("v1Final", "after");
    const reached = w.gate.reached("v1Final");
    await w.advance(v.cut);
    await reached;
    clock(v.giveUp + SECOND);
    s10.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    w.timers.fire();
    expect((await v.response).status).toBe(200);
  });

  it("the route's answer to S10's 503 received at the cut is the decided 503: the upload is doomed", async () => {
    const w = await routeWorld();
    const v = await waiting(w);
    await startJob(w, v.id);
    await w.advance(v.cut);
    expect((await v.response).status).toBe(503);
    expect((await held(w.store, v.id)).att?.gc_at).toBe(DOOMED_AT);
  });
});

describe("Images and the active path (Q1, route side)", () => {
  it("answers an audio upload with Images spent 202, charging no Images", async () => {
    const w = await routeWorld();
    const month = new Date(Date.now()).toISOString().slice(0, 7);
    await sql(w.store, "INSERT INTO kopje_state (name, value) VALUES (?, '100000000')", `images_transforms:${month}`);
    const response = await postMedia(
      w,
      multipartBody([{ name: "file", data: mp3(), filename: "a.mp3", type: "audio/mpeg" }]),
    );
    expect(response.status).toBe(202);
    expect(await sql(w.store, "SELECT value FROM kopje_state WHERE name = ?", `images_transforms:${month}`)).toEqual([
      { value: "100000000" },
    ]);
  });
});

// Every wait of the route bounded, and no write started after its cut (code review r1 H1, M1-M3, LOW).
describe("the route's bounded waits (code review r1)", () => {
  const RECEIVE = { error: "Media processing took too long to receive. Try again." };

  it("H1: a v1 body held before the sniff answers 503 at V1_TIME_MS: no slot, nothing charged, reservation abandoned", async () => {
    const w = await routeWorld();
    const arrival = Date.now();
    const { body, contentType } = multipartBody([videoPart(mp4(200_000))]);
    const stream = new SlowBody(body, { chunk: 512, holdAt: 1024 });
    const response = postMedia(w, { body: stream.stream(), contentType }, "v1");
    await stream.reachedHold.promise;
    await w.advance(arrival + V1_TIME_MS);
    expect(await answerOf(await response)).toEqual({ status: 503, body: RECEIVE });
    expect(w.gate.calls).not.toContain("takeAvSlot");
    const id = await lastUpload(w);
    expect(await charged(w.store)).toBe(0);
    expect((await held(w.store, id)).att?.gc_at).toBe(DOOMED_AT);
  });

  it("H1: a v1 reservation held past V1_TIME_MS answers 503, and the late reservation is abandoned", async () => {
    const w = await routeWorld();
    const arrival = Date.now();
    const gate = w.gate.hold("reserveMedia", "after");
    const reached = w.gate.reached("reserveMedia");
    const response = postMedia(w, multipartBody([videoPart()]), "v1");
    await reached;
    await w.advance(arrival + V1_TIME_MS);
    gate.resolve();
    expect(await answerOf(await response)).toEqual({ status: 503, body: RECEIVE });
    const id = await lastUpload(w);
    expect(w.gate.calls).not.toContain("takeAvSlot");
    expect((await held(w.store, id)).att?.gc_at).toBe(DOOMED_AT);
  });

  it("H1: once the sniff reads an image, the image path keeps its own deadline past V1_TIME_MS", async () => {
    const plain = await routeWorld();
    const parts = [PNG_PART, { name: "description", data: "x".repeat(200_000) }];
    const expected = await answerOf(await postMedia(plain, multipartBody(parts), "v1"));
    const w = await routeWorld();
    const arrival = Date.now();
    const { body, contentType } = multipartBody(parts);
    const stream = new SlowBody(body, { chunk: 1024, holdAt: body.byteLength - 1024 });
    const response = postMedia(w, { body: stream.stream(), contentType }, "v1");
    await stream.reachedHold.promise;
    await w.advance(arrival + V1_TIME_MS + SECOND);
    stream.release();
    expect(await answerOf(await response)).toEqual(expected);
  });

  it("M1: a multipart create answering after the staging cut is aborted when it answers", async () => {
    const hold = deferred();
    const { bucket, counts } = hookedBucket({ holdCreate: hold.promise });
    const w = await routeWorld({ bucket });
    const response = postMedia(w, multipartBody([videoPart()]));
    await vi.waitFor(() => expect(counts.creates).toBe(1));
    await w.advance(Math.max(...w.timers.pending));
    hold.resolve();
    expect(await answerOf(await response)).toEqual({ status: 503, body: RECEIVE });
    await vi.waitFor(() => expect(counts.aborts).toBe(1));
    expect(counts.completes).toBe(0);
  });

  it("M2: an abort that never answers still lets S2 run, and the refusal answers by R2_CALL_MS", async () => {
    const { bucket, counts } = hookedBucket({ stallAbort: true });
    const w = await routeWorld({ bucket });
    const response = postMedia(w, multipartBody([videoPart(), PNG_PART]));
    await vi.waitFor(() => expect(counts.aborts).toBe(1));
    await w.advance(Date.now() + R2_CALL_MS);
    expect(await answerOf(await response)).toEqual({
      status: 422,
      body: { error: "Validation failed: File was sent more than once" },
    });
    expect(w.gate.calls).toContain("releaseStaging");
  });

  it("M2: a stream cancel that never settles still lets the refusal answer, S2 run", async () => {
    const w = await routeWorld();
    const { body, contentType } = multipartBody([videoPart(), PNG_PART]);
    const stream = new SlowBody(body, { stallCancel: true });
    const response = postMedia(w, { body: stream.stream(), contentType });
    expect((await response).status).toBe(422);
    expect(stream.cancelled).toBe(true);
    expect(w.gate.calls).toContain("releaseStaging");
  });

  it("M2: an input delete that never answers after S2's released still abandons and answers by R2_CALL_MS", async () => {
    const { bucket, counts } = hookedBucket({ stallDelete: true });
    const w = await routeWorld({ bucket });
    const response = postMedia(
      w,
      multipartBody([videoPart(), { name: "description", data: "x".repeat(MAX_MEDIA_DESCRIPTION_LENGTH + 1) }]),
    );
    await vi.waitFor(() => expect(counts.deletes).toBe(1));
    await w.advance(Date.now() + R2_CALL_MS);
    expect((await response).status).toBe(422);
    expect(w.gate.calls).toContain("abandonMedia");
  });

  it.each(["takeAvSlot", "queueNormalize"])(
    "M2: v2's %s held past STORE_CALL_MS answers 503, deleting nothing",
    async (call) => {
      const w = await routeWorld();
      w.gate.hold(call);
      const reached = w.gate.reached(call);
      const response = postMedia(w, multipartBody([videoPart()]));
      await reached;
      await w.advance(Date.now() + STORE_CALL_MS);
      expect(await answerOf(await response)).toEqual({
        status: 503,
        body: { error: "Media processing is unavailable. Try again later." },
      });
      if (call === "queueNormalize") {
        expect(await input(await lastUpload(w))).not.toBeNull();
      }
    },
  );

  it("M3: a final part answering after the cut starts no complete()", async () => {
    const hold = deferred();
    const { bucket, counts, partReached } = hookedBucket({ holdPart: hold.promise });
    const w = await routeWorld({ bucket });
    const response = postMedia(w, multipartBody([videoPart()]));
    await partReached;
    const cut = Math.max(...w.timers.pending);
    clock(cut + SECOND);
    hold.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    w.timers.fire();
    expect(await answerOf(await response)).toEqual({ status: 503, body: RECEIVE });
    expect(counts.completes).toBe(0);
  });

  it("LOW: S9 is read every V1_POLL_MS from the start of the poll before, its reply time included", async () => {
    const w = await routeWorld();
    const s9 = w.gate.hold("v1Outcome", "after");
    const reached = w.gate.reached("v1Outcome");
    const response = postMedia(w, multipartBody([videoPart()]), "v1");
    response.catch(() => {});
    await reached;
    clock(Date.now() + SECOND);
    const next = w.timers.waitFor(V1_POLL_MS - SECOND);
    s9.resolve();
    await next;
  });

  it("LOW: a v2 upload read in many chunks leaves no wait pending", async () => {
    const w = await routeWorld();
    const { body, contentType } = multipartBody([videoPart(mp4(200_000))]);
    const stream = new SlowBody(body, { chunk: 1024 });
    expect((await postMedia(w, { body: stream.stream(), contentType })).status).toBe(202);
    expect(w.timers.pending).toEqual([]);
  });
});

// The answer never awaits cleanup, and one clock per request (code review r2).
describe("the route's answers and its cleanup (code review r2)", () => {
  const RECEIVE = { error: "Media processing took too long to receive. Try again." };

  it("H1: a pre-sniff timeout answers 503 at the route's cut while abandonMedia is held", async () => {
    const w = await routeWorld();
    const arrival = Date.now();
    const abandon = w.gate.hold("abandonMedia");
    const { body, contentType } = multipartBody([videoPart(mp4(200_000))]);
    const stream = new SlowBody(body, { chunk: 512, holdAt: 1024 });
    const post = postWatched(w, { body: stream.stream(), contentType }, "v1");
    await stream.reachedHold.promise;
    await w.advance(arrival + V1_TIME_MS - T_REPLY);
    expect(await answerOf(await post.answered)).toEqual({ status: 503, body: RECEIVE });
    abandon.resolve();
    await post.done;
    expect((await held(w.store, await lastUpload(w))).att?.gc_at).toBe(DOOMED_AT);
  });

  it("H1: a pre-sniff timeout answers 503 at the route's cut while the reservation's R2 delete never answers", async () => {
    const { bucket } = hookedBucket({ stallDelete: true });
    const w = await routeWorld({ bucket });
    const arrival = Date.now();
    const { body, contentType } = multipartBody([videoPart(mp4(200_000))]);
    const stream = new SlowBody(body, { chunk: 512, holdAt: 1024 });
    const post = postWatched(w, { body: stream.stream(), contentType }, "v1");
    await stream.reachedHold.promise;
    await w.advance(arrival + V1_TIME_MS - T_REPLY);
    expect(await answerOf(await post.answered)).toEqual({ status: 503, body: RECEIVE });
    await w.advance(Date.now() + STORE_CALL_MS + R2_CALL_MS);
    await post.done;
  });

  it("M2: a refusal before the slot answers while abandonMedia is held", async () => {
    const w = await routeWorld();
    const abandon = w.gate.hold("abandonMedia");
    const post = postWatched(w, multipartBody([{ name: "file", data: "text" }, videoPart()]));
    expect((await post.answered).status).toBe(422);
    abandon.resolve();
    await post.done;
  });

  it("M2: the Images refusal of an image answers 429 while abandonMedia is held", async () => {
    const w = await routeWorld();
    const month = new Date(Date.now()).toISOString().slice(0, 7);
    await sql(w.store, "INSERT INTO kopje_state (name, value) VALUES (?, '4000')", `images_transforms:${month}`);
    const abandon = w.gate.hold("abandonMedia");
    const post = postWatched(w, multipartBody([PNG_PART]));
    expect((await post.answered).status).toBe(429);
    abandon.resolve();
    await post.done;
  });

  it("M2: a staging refusal answers while its abort, S2 and abandonment are held", async () => {
    const { bucket } = hookedBucket({ stallAbort: true });
    const w = await routeWorld({ bucket });
    const s2 = w.gate.hold("releaseStaging");
    const post = postWatched(w, multipartBody([videoPart(), PNG_PART]));
    expect(await answerOf(await post.answered)).toEqual({
      status: 422,
      body: { error: "Validation failed: File was sent more than once" },
    });
    s2.resolve();
    await w.advance(Date.now() + R2_CALL_MS);
    await post.done;
    expect(w.gate.calls).toContain("abandonMedia");
  });

  it("M3: the cleanup is registered with waitUntil when staging starts, before any cut", async () => {
    const hold = deferred();
    const { bucket, counts } = hookedBucket({ holdCreate: hold.promise });
    const w = await routeWorld({ bucket });
    const post = postWatched(w, multipartBody([videoPart()]));
    await vi.waitFor(() => expect(counts.creates).toBe(1));
    expect(post.registered()).toBeGreaterThanOrEqual(1);
    hold.resolve();
    expect((await post.done).status).toBe(202);
  });

  // A completion that lands after the route's delete (its abort not yet effective, code review r2 M3) is the
  // sweep's while the doomed row stands (sweptKeys holds incoming/<id>), and the incoming/ orphan pass's after it.
  it("M3: an input completed after the route's delete goes with the doomed row's sweep, or the orphan pass after it", async () => {
    const w = await routeWorld();
    const response = await postMedia(
      w,
      multipartBody([videoPart(), { name: "description", data: "x".repeat(MAX_MEDIA_DESCRIPTION_LENGTH + 1) }]),
    );
    expect(response.status).toBe(422);
    const id = await lastUpload(w);
    await env.MEDIA.put(incomingKey(id), "late");
    expect(await sweepMedia(env, { build: () => BUILD, store: () => w.store })).toBe(1);
    expect(await input(id)).toBeNull();
    // Landing after the row is gone: no row holds it, and the orphan pass takes it once a day old.
    await env.MEDIA.put(incomingKey(id), "later");
    vi.useRealTimers();
    const real = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    clock(real + 25 * 60 * 60 * 1000);
    await incomingOrphans({ build: BUILD, store: w.store, bucket: env.MEDIA });
    expect(await input(id)).toBeNull();
  });

  it("M5: a settled repeat whose lookup passes STORE_CALL_MS answers 202 masked; GET then the completion", async () => {
    const w = await routeWorld();
    w.gate.drops.set("queueNormalize", 1);
    const repeat = w.gate.hold("queueNormalize", "before", 1);
    const reached = w.gate.reached("queueNormalize");
    const post = postWatched(w, multipartBody([videoPart()]));
    await reached;
    const id = await lastUpload(w);
    await completeJob(w, id, await startJob(w, id));
    const lookup = w.gate.hold("getMedia");
    const looked = w.gate.reached("getMedia");
    repeat.resolve();
    await looked;
    await w.advance(Date.now() + STORE_CALL_MS);
    expect(await answerOf(await post.answered)).toMatchObject({ status: 202, body: { id, url: null, meta: null } });
    lookup.resolve();
    await post.done;
    expect((await w.h.request(`/api/v1/media/${id}`, bearer(w.h.users.alice.token))).status).toBe(200);
  });

  // The AV path streams only a Content-Type in the canonical form (multipartBoundary); any other is read whole, as
  // before #1828, where a video is refused by its type.
  it("reads a video under a Content-Type outside the canonical form as the image path does, taking no slot", async () => {
    const w = await routeWorld();
    const { body, contentType } = multipartBody([videoPart()]);
    const boundary = contentType.slice(contentType.indexOf("=") + 1);
    const response = await postMedia(w, { body, contentType: `${contentType}; boundary=${boundary}` });
    expect(await answerOf(response)).toEqual({
      status: 422,
      body: { error: "Validation failed: File content type is invalid" },
    });
    expect(w.gate.calls).not.toContain("takeAvSlot");
  });

  it("streams a video under a quoted boundary, its form read under the same header", async () => {
    const w = await routeWorld();
    const { body, contentType } = multipartBody([videoPart(), { name: "description", data: "quoted" }]);
    const boundary = contentType.slice(contentType.indexOf("=") + 1);
    const response = await postMedia(w, { body, contentType: `multipart/form-data; boundary="${boundary}"` });
    expect(await answerOf(response)).toMatchObject({ status: 202, body: { description: "quoted" } });
  });

  it("M6: `file[]` after the streamed file answers 400, as the image path's form parser does", async () => {
    const w = await routeWorld();
    const response = await postMedia(w, multipartBody([videoPart(), { name: "file[]", data: "x" }]));
    expect(await answerOf(response)).toEqual({ status: 400, body: { error: "Malformed request body" } });
    await leftNothing(w);
  });

  // One thumbnail part on the AV path (#1828 PR6 D-9), where Rails reads the last: a second, even empty text, is
  // refused at its head.
  it.each([
    ["a thumbnail file then an empty thumbnail text", [videoPart(), THUMB_FILE, { name: "thumbnail", data: "" }]],
    ["an empty thumbnail text then a thumbnail file", [videoPart(), { name: "thumbnail", data: "" }, THUMB_FILE]],
  ])("M5: %s answers 422 (D-9)", async (_, parts) => {
    const w = await routeWorld();
    const response = await postMedia(w, multipartBody(parts));
    expect(await answerOf(response)).toEqual({
      status: 422,
      body: { error: "Validation failed: Thumbnail was sent more than once" },
    });
    await leftNothing(w);
  });

  // S2, then the delete its `released` authorizes, then the abandonment (code review r3 M3).
  it("M3: a staging refusal's authorized delete starts while abandonMedia is held", async () => {
    const { bucket, counts } = hookedBucket({});
    const w = await routeWorld({ bucket });
    const abandon = w.gate.hold("abandonMedia");
    const abandoning = w.gate.reached("abandonMedia");
    const post = postWatched(w, multipartBody([videoPart(), PNG_PART]));
    expect((await post.answered).status).toBe(422);
    await vi.waitFor(() => expect(counts.deletes).toBe(1));
    expect(w.gate.calls).toContain("releaseStaging");
    await abandoning;
    abandon.resolve();
    await post.done;
    expect(await input(await lastUpload(w))).toBeNull();
  });

  // A documented limit: S1 answering `inactive` hands the request to the image path, whose waits are its own. v1 still answers 503 at the give-up; the image path then charges Images (the account's and the
  // instance's TRANSFORMS_PER_UPLOAD, at startTransforms) whether or not an image comes of it, and charges no AV job.
  // Here neither file makes an image (the harness's Images refuses the PNG as Images refuses an MP4), so the
  // reservation is abandoned and left to the sweep; an image completing after the 503 is not exercised.
  it.each([
    ["an image as the last file", [videoPart(mp4(200_000)), PNG_PART]],
    ["no image at all", [videoPart(mp4(200_000))]],
  ] as const)(
    "M1 (limit): S1 `inactive` hands v1 to the image path, which charges Images after the give-up's 503: %s",
    async (_, parts) => {
      const w = await routeWorld();
      const arrival = Date.now();
      const s1 = w.gate.hold("takeAvSlot");
      const reached = w.gate.reached("takeAvSlot");
      const { body, contentType } = multipartBody([...parts]);
      const stream = new SlowBody(body, { chunk: 1024, holdAt: 100_000 });
      const post = postWatched(w, { body: stream.stream(), contentType }, "v1");
      await reached;
      await failProbe(w);
      s1.resolve();
      await stream.reachedHold.promise;
      await w.advance(arrival + V1_TIME_MS);
      expect(await answerOf(await post.answered)).toEqual({
        status: 503,
        body: { error: "Media processing took too long. Try a shorter file." },
      });
      expect(await transformCounters(w)).toEqual([]);
      stream.release();
      await post.done;
      expect(w.gate.calls).toContain("startTransforms");
      expect(await transformCounters(w)).toEqual([String(TRANSFORMS_PER_UPLOAD), String(TRANSFORMS_PER_UPLOAD)]);
      expect(await charged(w.store)).toBe(0);
      expect(await held(w.store, await lastUpload(w))).toMatchObject({
        row: null,
        slot: null,
        att: { type: "image", processed: 1, url: "" },
      });
    },
  );

  // S2's wait is a deadline on the route's clock (code review r4 M3): a `released` received past it, before its timer
  // fired, deletes nothing; the input is left to reclamation.
  it("M3: an S2 `released` received after its deadline, before the timer fires, deletes nothing", async () => {
    const { bucket, counts } = hookedBucket({});
    const w = await routeWorld({ bucket });
    const s2 = w.gate.hold("releaseStaging", "after");
    const reached = w.gate.reached("releaseStaging");
    const post = postWatched(w, multipartBody([videoPart(), PNG_PART]));
    expect((await post.answered).status).toBe(422);
    await reached;
    clock(Date.now() + STORE_CALL_MS + 1);
    s2.resolve();
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    w.timers.fire();
    await post.done;
    expect(counts.deletes).toBe(0);
    expect(w.gate.calls).toContain("abandonMedia");
  });

  // RES-1's bound comes first (docs/mastodon-deviations.md): a thumbnail file is kept within IMAGE_SIZE_LIMIT, past it
  // refused before the description after it is judged (#1828 PR6: its body no longer weighs against API_BODY_LIMIT).
  it("M6: a thumbnail past IMAGE_SIZE_LIMIT answers 422 before an invalid description", async () => {
    const w = await routeWorld();
    const response = await postMedia(
      w,
      multipartBody([
        videoPart(),
        { name: "thumbnail", data: new Uint8Array(IMAGE_SIZE_LIMIT + 1), filename: "t.png", type: "image/png" },
        { name: "description", data: "x".repeat(MAX_MEDIA_DESCRIPTION_LENGTH + 1) },
      ]),
    );
    expect(await answerOf(response)).toEqual({
      status: 422,
      body: { error: "Validation failed: Thumbnail file size must be less than 16 MB" },
    });
    await leftNothing(w);
  });
});
