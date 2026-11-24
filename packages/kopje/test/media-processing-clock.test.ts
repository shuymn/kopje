import { afterEach, describe, expect, it, vi } from "vitest";

import { DETACHED_GRACE_MS } from "../src/domain/media";
import { sql } from "./api-helpers";
import { BUILD } from "./helpers";
import {
  ACTIVE,
  type AvWorld,
  avWorld,
  bookmark,
  clock,
  completed,
  fileToken,
  queued,
  restore,
  SECOND,
  T0,
  queue,
  imageCompletion,
} from "./media-processing-helpers";

// One clock for the processing's fences (#1828 plan section 1, rules 2 and 5, "Identities"): a reservation that may
// go down the AV path is stamped at the Store's time, so K3, S1's write window, S3's cap and the AV tombstone compare
// Store times only, and Q1 admits by the probe at the Store's time; the Worker's clock may run ahead or behind.

afterEach(() => {
  vi.useRealTimers();
});

const SKEWS = [-3 * SECOND, 0, 3 * SECOND];

// A reservation on the active path made at the Store's `storeAt`, the Worker's clock `skew` from it.
async function reserveAv(
  w: AvWorld,
  storeAt: number,
  skew: number,
  monthlyTransforms = { instance: 1_000_000, account: 1_000_000 },
) {
  clock(storeAt);
  const token = fileToken();
  const reserved = await w.store.reserveMedia(BUILD, {
    credential: w.alice,
    token,
    monthlyTransforms,
    avCandidate: { build: BUILD },
    now: storeAt + skew,
  });
  if (reserved.status !== "ok") {
    throw new Error(reserved.status);
  }
  return { reserved: reserved.value, token };
}

describe("the reservation's time is the Store's (H1)", () => {
  it.each(SKEWS)("K3 fences a job reserved before the marker, the Worker %i ms off the Store", async (skew) => {
    const w = await avWorld();
    const { reserved, token } = await reserveAv(w, T0, skew);
    if (reserved.status !== "ok") {
      throw new Error(reserved.status);
    }
    const id = reserved.id;
    clock(T0 + SECOND);
    const taken = await w.store.takeAvSlot(BUILD, { id, token, kind: "video", v1Left: null, activation: ACTIVE });
    if (taken.status !== "taken") {
      throw new Error(taken.status);
    }
    clock(T0 + 2 * SECOND);
    const queued = await queue(w, { id, token }, taken.stagedAt);
    expect(queued).toMatchObject({ status: "queued" });
    await restore(w.store, await bookmark(w.store), T0 + 2500);
    clock(T0 + 4 * SECOND);
    expect(await w.store.startNormalize(BUILD, { id, token, invocation: "inv" })).toEqual({
      status: "settled",
      state: { failed: "restored" },
    });
  });

  it.each(SKEWS)("a reservation made after the marker is not fenced, the Worker %i ms off the Store", async (skew) => {
    const w = await avWorld();
    await restore(w.store, await bookmark(w.store), T0 - 1);
    const { reserved, token } = await reserveAv(w, T0, skew);
    if (reserved.status !== "ok") {
      throw new Error(reserved.status);
    }
    clock(T0 + SECOND);
    expect(
      await w.store.takeAvSlot(BUILD, { id: reserved.id, token, kind: "video", v1Left: null, activation: ACTIVE }),
    ).toMatchObject({ status: "taken" });
  });

  it.each(SKEWS)("Q1 admits by the probe at the Store's time, the Worker %i ms off the Store", async (skew) => {
    const w = await avWorld();
    // The probe passed at T0 (avWorld); the Images budgets: none left for the instance, the account's share left.
    const { reserved } = await reserveAv(w, T0, skew, { instance: 0, account: 100 });
    expect(reserved).toMatchObject({ status: "ok", imagesRefusal: "instance" });
  });
});

// One media clock (#1828 plan section 3, "PR4-1"): every comparison with a time stored on media_attachments is made at
// the Store's time, whatever time the Worker's request carries.
describe("one media clock: the Store's", () => {
  it.each(SKEWS)(
    "a candidate that resolves to an image is open up to the Worker's deadline, the Worker %i ms off the Store",
    async (skew) => {
      const w = await avWorld();
      const { reserved } = await reserveAv(w, T0, skew);
      if (reserved.status !== "ok") {
        throw new Error(reserved.status);
      }
      // The Worker's own deadline, read on its clock; the Store's clock is `skew` behind it.
      const workerAt = reserved.deadline - SECOND;
      clock(workerAt - skew);
      expect(
        await w.store.startTransforms(BUILD, {
          credential: w.alice,
          id: reserved.id,
          monthlyTransforms: { instance: 1_000_000, account: 1_000_000 },
          now: workerAt,
        }),
      ).toEqual({ status: "ok", value: { status: "ok" } });
      const done = await w.store.completeMedia(BUILD, imageCompletion(w, reserved.id));
      expect(done).toMatchObject({ status: "ok", value: { id: reserved.id, type: "image" } });
      // At the Worker's deadline, on the Store's clock too, a reservation is closed.
      const late = await reserveAv(w, T0, skew);
      if (late.reserved.status !== "ok") {
        throw new Error(late.reserved.status);
      }
      clock(late.reserved.deadline - skew);
      expect(
        await w.store.startTransforms(BUILD, {
          credential: w.alice,
          id: late.reserved.id,
          monthlyTransforms: { instance: 1_000_000, account: 1_000_000 },
          now: late.reserved.deadline,
        }),
      ).toEqual({ status: "ok", value: { status: "expired" } });
    },
  );

  it("the sweep selects a completed AV upload at its gc_at on the Store's clock, not before", async () => {
    const w = await avWorld();
    const c = await completed(w);
    const [row] = await sql<{ gc_at: string }>(w.store, "SELECT gc_at FROM media_attachments WHERE id = ?", c.id);
    const gcAt = Date.parse(row!.gc_at);
    expect(gcAt).toBe(T0 + 4 * SECOND + DETACHED_GRACE_MS);
    clock(gcAt - 1);
    expect(await w.store.expiredMedia(BUILD, { limit: 100 })).toEqual([]);
    expect(await w.store.purgeMedia(BUILD, { ids: [c.id] })).toBe(0);
    expect(await w.store.v1Final(BUILD, { id: c.id, token: c.token })).toMatchObject({ status: 200 });
    clock(gcAt);
    expect(await w.store.expiredMedia(BUILD, { limit: 100 })).toEqual([{ id: c.id, token: c.token }]);
  });

  it("reconciliation takes a tombstone when it falls due on the Store's clock, not before", async () => {
    const w = await avWorld();
    // An unfinished AV upload purged: its tombstone keeps the authority to the AV write deadline + ORPHAN_GRACE_MS.
    const c = await queued(w);
    clock(T0 + 3 * SECOND);
    await w.store.deleteAvUpload(BUILD, { credential: w.alice, id: c.id });
    expect(await w.store.expiredMedia(BUILD, { limit: 100 })).toEqual([{ id: c.id, token: c.token }]);
    await w.store.purgeMedia(BUILD, { ids: [c.id] });
    const [tomb] = await sql<{ delete_after: string }>(w.store, "SELECT delete_after FROM media_orphans");
    const due = Date.parse(tomb!.delete_after);
    clock(due - 1);
    expect(await w.store.dueOrphans(BUILD)).toEqual([]);
    clock(due);
    expect(await w.store.dueOrphans(BUILD)).toEqual([{ id: c.id, token: c.token }]);
  });

  it("S1 takes only a reservation made as an AV candidate: one made without it is gone", async () => {
    const w = await avWorld();
    clock(T0);
    const token = fileToken();
    const plain = await w.store.reserveMedia(BUILD, {
      credential: w.alice,
      token,
      monthlyTransforms: { instance: 1_000_000, account: 1_000_000 },
      now: T0,
    });
    if (plain.status !== "ok" || plain.value.status !== "ok") {
      throw new Error("not reserved");
    }
    clock(T0 + SECOND);
    expect(
      await w.store.takeAvSlot(BUILD, { id: plain.value.id, token, kind: "video", v1Left: null, activation: ACTIVE }),
    ).toEqual({ status: "gone" });
  });
});
