import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DOOMED_AT } from "../src/domain/media";
import {
  deleteOwnerMedia,
  ownerMedia,
  updateOwnerMedia,
  V2_PROCESS_MS,
  type AvFacts,
} from "../src/domain/media-processing";
import { VIDEO_POSTER } from "../src/platform/brand-assets";
import { fileKey, originalKey, restoreMarkerKey } from "../src/platform/media-files";
import { readRestore } from "../src/platform/restore-marker";
import type { StoreStub } from "../src/platform/store-client";
import { toStoreUnavailable } from "../src/platform/store-errors";
import { markedRun } from "../src/store";
import { bearer, json, sql } from "./api-helpers";
import { imageUpload } from "./av-posting-helpers";
import { BUILD, deferred, gateMarker, holdingMarker, rejectionOf, testKernel } from "./helpers";
import { DESCRIPTION_TOO_LONG, OVERLONG_DESCRIPTIONS } from "./media-helpers";
import {
  ACTIVE,
  AUDIO,
  type AvWorld,
  avWorld,
  bookmark,
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
} from "./media-processing-helpers";
import { observedSql } from "./read-helpers";

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

async function answer(response: Response): Promise<{ status: number; body: unknown }> {
  return { status: response.status, body: await response.json() };
}

function get(w: AvWorld, id: string, who: Who = "alice") {
  return w.h.request(`/api/v1/media/${id}`, bearer(w.h.users[who].token)).then(answer);
}

function put(w: AvWorld, id: string, body: Record<string, unknown>, who: Who = "alice") {
  return w.h.request(`/api/v1/media/${id}`, bearer(w.h.users[who].token, json(body, { method: "PUT" }))).then(answer);
}

function del(w: AvWorld, id: string, who: Who = "alice") {
  return w.h.request(`/api/v1/media/${id}`, bearer(w.h.users[who].token, { method: "DELETE" })).then(answer);
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
      const taken = await bookmark(w.store);
      await restore(w.store, taken, T0 + 6 * SECOND);
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

    it("answers what K3 cannot change: S10's and S9's completed upload, a completed S6 replay, S8 after completion, the sweep's claim", async () => {
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
          (await w.store.releaseAvSlot(BUILD, { id: up.id, teardownId: up.teardownId })).status,
          (await w.store.incomingSweepClaim(BUILD)).status,
        ],
        "{}",
      );
      expect(answers).toEqual([200, "done", "done", "released", "claimed"]);
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

    it("refuses the processor's fence-dependent writes S1-S5 and S7 and the sweep's checkpoint, writing nothing", async () => {
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

// The Store stub the app calls, with its method `name` wrapped by `wrap` (apiHarness's wrapStore).
function around(name: string, wrap: (call: Call) => Call) {
  return (store: StoreStub): StoreStub =>
    new Proxy(store, {
      get: (target, key) => {
        const value = Reflect.get(target, key) as unknown;
        if (typeof value !== "function") {
          return value;
        }
        const call: Call = (...args) => (target as unknown as Record<string, Call>)[String(key)]!(...args);
        return key === name ? wrap(call) : call;
      },
    });
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
  const NO_STILL: AvFacts = { ...VIDEO, preview: null };

  it.each([
    ["a video with a still", VIDEO],
    ["a video without one", NO_STILL],
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
    if (facts === NO_STILL) {
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
