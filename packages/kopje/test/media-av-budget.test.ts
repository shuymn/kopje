import { afterEach, describe, expect, it, vi } from "vitest";

import { sql } from "./api-helpers";
import { BUILD } from "./helpers";
import {
  ACTIVE,
  type AvWorld,
  avWorld,
  charged,
  clock,
  held,
  reserve,
  SECOND,
  staged,
  T0,
  TEXT,
  VIDEO,
} from "./media-processing-helpers";

// The upload budget's charge rule, the Store's side (#1828 design 4.12, P15): MEDIA_UPLOAD_MONTHLY_JOBS units per UTC
// month of the Store's clock, one charged by queueNormalize (S3) before any 2xx, read by takeAvSlot (S1) at the sniff
// (`spent`, nothing charged), never refunded; a queued upload finishes whatever the budget becomes.

afterEach(() => {
  vi.useRealTimers();
});

const at = (s: number) => T0 + s * SECOND;

async function stage(w: AvWorld, budget: number, time = at(1)) {
  const up = await reserve(w, time - SECOND);
  clock(time);
  const taken = await w.store.takeAvSlot(BUILD, {
    id: up.id,
    token: up.token,
    kind: "audio",
    v1Left: null,
    activation: { ...ACTIVE, budget },
  });
  return { up, taken };
}

const queue = (w: AvWorld, c: { id: string; token: string; stagedAt: number }, budget: number) =>
  w.store.queueNormalize(BUILD, { ...c, bytes: 1000, text: TEXT, activation: { ...ACTIVE, budget } });

describe("the upload budget (P15)", () => {
  it("admits exactly the budget and refuses one over: spent at the sniff, nothing charged", async () => {
    const w = await avWorld();
    for (let i = 0; i < 2; i++) {
      const { up, taken } = await stage(w, 2, at(1 + i));
      if (taken.status !== "taken") {
        throw new Error(taken.status);
      }
      clock(at(2 + i));
      expect(await queue(w, { ...up, stagedAt: taken.stagedAt }, 2)).toMatchObject({ status: "queued" });
      // The slots are the capacity's (S8 frees them), so that only the budget refuses below.
      await clearSlots(w);
    }
    expect(await charged(w.store)).toBe(2);
    const { taken } = await stage(w, 2, at(10));
    expect(taken).toEqual({ status: "spent" });
    expect(await charged(w.store)).toBe(2);
  });

  it("two uploads staged at the last unit: the first queue takes it, the second is refused spent with its input", async () => {
    const w = await avWorld();
    const a = await stage(w, 1);
    const b = await stage(w, 1);
    if (a.taken.status !== "taken" || b.taken.status !== "taken") {
      throw new Error("not staged");
    }
    clock(at(3));
    expect(await queue(w, { ...a.up, stagedAt: a.taken.stagedAt }, 1)).toMatchObject({ status: "queued" });
    expect(await queue(w, { ...b.up, stagedAt: b.taken.stagedAt }, 1)).toEqual({
      status: "refused_cleanup_yours",
      reason: "spent",
    });
    expect(await held(w.store, b.up.id)).toMatchObject({ row: null, slot: null });
    expect(await charged(w.store)).toBe(1);
  });

  it("budget 0 admits nothing (inactive); budget 1 admits one", async () => {
    const w = await avWorld();
    expect((await stage(w, 0)).taken).toEqual({ status: "inactive" });
    const one = await stage(w, 1);
    expect(one.taken).toMatchObject({ status: "taken" });
    expect(await charged(w.store)).toBe(0);
  });

  it("counts by the Store's UTC month: the last unit at the month's end, a fresh budget at its start", async () => {
    const w = await avWorld();
    const end = Date.parse("2026-10-31T23:59:58.000Z");
    const a = await stage(w, 1, end);
    if (a.taken.status !== "taken") {
      throw new Error(a.taken.status);
    }
    clock(end + 1000);
    expect(await queue(w, { ...a.up, stagedAt: a.taken.stagedAt }, 1)).toMatchObject({ status: "queued" });
    expect(await charged(w.store, end)).toBe(1);
    await clearSlots(w);
    // Still October: spent.
    expect((await stage(w, 1, end + 1500)).taken).toEqual({ status: "spent" });
    // November.
    const b = await stage(w, 1, end + 3000);
    expect(b.taken).toMatchObject({ status: "taken" });
    if (b.taken.status !== "taken") {
      throw new Error(b.taken.status);
    }
    clock(end + 4000);
    expect(await queue(w, { ...b.up, stagedAt: b.taken.stagedAt }, 1)).toMatchObject({ status: "queued" });
    expect(await charged(w.store, end + 4000)).toBe(1);
  });

  it("budget lowered to 0 with one pending: it still starts and completes, charged once", async () => {
    const w = await avWorld();
    const c = await staged(w);
    clock(at(2));
    const queued = await queue(w, c, 1);
    if (queued.status !== "queued") {
      throw new Error(queued.status);
    }
    // MEDIA_UPLOAD_MONTHLY_JOBS set to 0: new uploads are refused...
    const late = await reserve(w, at(3));
    clock(at(3));
    expect(
      await w.store.takeAvSlot(BUILD, { ...late, kind: "video", v1Left: null, activation: { ...ACTIVE, budget: 0 } }),
    ).toEqual({ status: "inactive" });
    // ...the queued one starts, writes and completes: the processor's operations read no budget.
    clock(at(4));
    const start = await w.store.startNormalize(BUILD, { id: c.id, token: c.token, invocation: "inv" });
    if (start.status !== "started") {
      throw new Error(start.status);
    }
    expect(await w.store.confirmAvWrite(BUILD, { id: c.id, startId: start.startId, write: "full" })).toMatchObject({
      status: "grant",
    });
    expect(
      await w.store.completeAvUpload(BUILD, { id: c.id, token: c.token, startId: start.startId, facts: VIDEO }),
    ).toEqual({ status: "done" });
    expect(await charged(w.store)).toBe(1);
  });
});

async function clearSlots(w: AvWorld): Promise<void> {
  await sql(w.store, "DELETE FROM media_av_slots");
}
