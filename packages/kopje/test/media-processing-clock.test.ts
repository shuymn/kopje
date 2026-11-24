import { afterEach, describe, expect, it, vi } from "vitest";

import { BUILD } from "./helpers";
import {
  ACTIVE,
  type AvWorld,
  avWorld,
  bookmark,
  clock,
  fileToken,
  restore,
  SECOND,
  T0,
  TEXT,
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
    const queued = await w.store.queueNormalize(BUILD, {
      id,
      token,
      stagedAt: taken.stagedAt,
      bytes: 2_000_000,
      text: TEXT,
      activation: ACTIVE,
    });
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
