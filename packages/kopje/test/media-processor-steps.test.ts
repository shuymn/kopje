import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { allocate, HARD_HOLD_MS, V2_PROCESS_MS } from "../src/domain/media-processing";
import { incomingKey } from "../src/platform/media-files";
import { sql } from "./api-helpers";
import { putInput } from "./media-job-helpers";
import { avWorld, clock, gate, held, queued } from "./media-processing-helpers";
import { cleared, platformFor, upload } from "./media-unit-helpers";

// The PR4 plan's table 1.3 as data, on an upload's object driven by the test's platform (media-unit-helpers.ts).
// Recovery after a kill runs only through the alarm the platform fires on a new instance; the Store is the production
// Store.

afterEach(() => {
  vi.useRealTimers();
});

// Table 1.3: each step, the invocation killed just after it, and what the alarm's replay leaves.
const STEPS: { step: string; killAt: string; completes: boolean }[] = [
  // D1: the alarm set at the entry, the invocation dead before S4 is sent: the replay starts the still pending job.
  { step: "D1 alarm entry", killAt: "before:startNormalize", completes: true },
  // D2: S4 committed, its reply lost: the replay is refused the start (settled running) and cleans up.
  { step: "D2 S4", killAt: "after:startNormalize", completes: false },
  // D3: the work under way, the container on, dead before the stop.
  { step: "D3 work", killAt: "destroy", completes: false },
  // D4: the stop confirmed, dead before the first grant.
  { step: "D4 confirmed stop", killAt: "before:confirmAvWrite", completes: false },
  // D6: a write granted (its reply lost).
  { step: "D6 a final write", killAt: "after:confirmAvWrite", completes: false },
  // D7: S6 committed, its reply lost: the replay finds it completed and cleans up.
  { step: "D7 terminal", killAt: "after:completeAvUpload", completes: true },
  // D8: the input deleted, dead before S8 (a kill after D8 before S8 repeats both).
  { step: "D8 input", killAt: "before:releaseAvSlot", completes: true },
  // D9: S8 committed, its reply lost: the replay's S8 answers released.
  { step: "D9 release", killAt: "after:releaseAvSlot", completes: true },
];

describe("table 1.3: an upload's object killed after each step recovers through its armed alarm", () => {
  it.each(STEPS)("$step", async ({ killAt, completes }) => {
    const w = await avWorld();
    const p = await platformFor(w);
    const up = await upload(w, p);
    p.killNext(killAt);
    expect(await p.fire()).toBe("killed");
    // The alarm stays armed after every kill (D1's, or the fired one kept due).
    expect(p.storage.alarm).not.toBeNull();
    await p.settle();
    await cleared(w, p, up.id);
    const after = await held(w.store, up.id);
    expect(after.att?.processed === 1).toBe(completes);
    // One container for the job, whatever the replays did.
    expect(p.starts()).toBeLessThanOrEqual(1);
  });

  it("the uninterrupted run completes, releases the slot and clears the storage (H2's control)", async () => {
    const w = await avWorld();
    const p = await platformFor(w);
    const up = await upload(w, p);
    expect(await p.settle()).toBe(1);
    await cleared(w, p, up.id);
    expect((await held(w.store, up.id)).att).toMatchObject({ processed: 1, type: "video" });
    // MEDIA-8: its container on standard-4 without Internet access.
    expect(p.startedWith()).toMatchObject({ instance: "standard-4", enableInternet: false });
  });
});

describe("table 1.3: D0 run", () => {
  it("leaves neither record nor alarm when killed inside its transaction, and run's repeat (S12's) repairs it", async () => {
    const w = await avWorld();
    const p = await platformFor(w);
    const up = await queued(w);
    await putInput(up.id);
    p.killNext("commit:run");
    void p.unit().run(up.id, up.token, up.teardownId);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(p.storage.map.size).toBe(0);
    expect(p.storage.alarm).toBeNull();
    await p.unit().run(up.id, up.token, up.teardownId);
    await p.settle();
    await cleared(w, p, up.id);
    expect((await held(w.store, up.id)).att?.processed).toBe(1);
  });

  it("gives a record without an alarm one, and otherwise does nothing", async () => {
    const w = await avWorld();
    const p = await platformFor(w);
    const up = await queued(w);
    await p.unit().run(up.id, up.token, up.teardownId);
    const record = p.storage.map.get("upload");
    p.storage.alarm = null;
    await p.unit().run(up.id, up.token, "another");
    expect(p.storage.alarm).not.toBeNull();
    const armed = p.storage.alarm;
    clock(Date.now() + 1000);
    await p.unit().run(up.id, up.token, up.teardownId);
    expect(p.storage.alarm).toBe(armed);
    expect(p.storage.map.get("upload")).toEqual(record);
  });

  it("run arriving during alarm() before D1 sets an alarm for now, which D1 replaces: no second invocation", async () => {
    const w = await avWorld();
    const p = await platformFor(w);
    const up = await upload(w, p);
    // The fired alarm is consumed (getAlarm is null): run arms one, and D1 then replaces it.
    p.storage.alarm = null;
    await p.unit().run(up.id, up.token, up.teardownId);
    const now = Date.now();
    expect(p.storage.alarm).toBe(now);
    await p.settle();
    await cleared(w, p, up.id);
    expect(p.starts()).toBe(1);
  });
});

describe("table 1.3: the stop and its confirmation", () => {
  it("never calls S8 before a confirmed stop; a stop that keeps failing is retried with no Store write while the granted slot counts (W10)", async () => {
    const w = await avWorld();
    const p = await platformFor(w);
    const up = await upload(w, p);
    p.failDestroy(true);
    await p.fire();
    expect(p.running()).toBe(true);
    for (let i = 0; i < 3; i++) {
      p.clearCalls();
      await p.fire();
      expect(p.storeCalls()).not.toContain("releaseAvSlot");
      expect(p.storeCalls().filter((c) => c !== "startNormalize")).toEqual([]);
    }
    // Past the job's deadline the slot still counts: granted, kept.
    clock(Date.now() + V2_PROCESS_MS);
    await p.fire();
    expect((await held(w.store, up.id)).slot).toMatchObject({ phase: "processing" });
    expect(p.storage.alarm).not.toBeNull();
    p.failDestroy(false);
    await p.settle();
    await cleared(w, p, up.id);
  });

  it("in maintenance stops the container and keeps the record, slot and alarm; after it the replay completes the release (GM3, r4 H4)", async () => {
    const w = await avWorld();
    const p = await platformFor(w);
    const up = await upload(w, p);
    p.killNext("before:releaseAvSlot");
    await p.fire();
    await gate(w.store, "maintenance", true);
    p.clearCalls();
    await p.fire();
    // S4 answers maintenance: the stop is tried, and nothing else is asked of the Store.
    expect(p.storeCalls()).toEqual(["startNormalize"]);
    expect(p.storage.map.size).toBe(1);
    expect(p.storage.alarm).not.toBeNull();
    expect((await held(w.store, up.id)).slot).not.toBeNull();
    await gate(w.store, "maintenance", false);
    await p.settle();
    await cleared(w, p, up.id);
    expect((await held(w.store, up.id)).att?.processed).toBe(1);
  });

  it("keeps the record and the alarm when S8 answers maintenance after a completed job, and releases once it ends", async () => {
    const w = await avWorld();
    const p = await platformFor(w);
    const up = await upload(w, p);
    p.beforeCall("releaseAvSlot", () => gate(w.store, "maintenance", true));
    expect(await p.fire()).toBe("returned");
    expect(p.storage.map.size).toBe(1);
    expect(p.storage.alarm).not.toBeNull();
    expect((await held(w.store, up.id)).slot).not.toBeNull();
    await gate(w.store, "maintenance", false);
    await p.settle();
    await cleared(w, p, up.id);
    expect((await held(w.store, up.id)).att?.processed).toBe(1);
  });

  it("drops a record only V2_PROCESS_MS + HARD_HOLD_MS after D0 and only with the container stopped, deleting the input (W9)", async () => {
    const w = await avWorld();
    const p = await platformFor(w);
    const up = await upload(w, p);
    // S8 refused throughout (maintenance), the stop failing at first.
    p.failDestroy(true);
    await p.fire();
    await gate(w.store, "maintenance", true);
    clock(Date.now() + V2_PROCESS_MS + HARD_HOLD_MS);
    await p.fire();
    // The container still runs: the record stays.
    expect(p.storage.map.size).toBe(1);
    p.failDestroy(false);
    await p.fire();
    expect(p.running()).toBe(false);
    await p.fire();
    expect(p.storage.map.size).toBe(0);
    expect(p.storage.alarm).toBeNull();
    expect(await env.MEDIA.head(incomingKey(up.id))).toBeNull();
    await gate(w.store, "maintenance", false);
  });
});

describe("table 1.3 D3: every wait on the container ends at its cut", () => {
  it.each([
    // The container takes the input and never answers: the reply's cut is the work deadline (the still's cut).
    { hang: "reply" as const, cut: "still" as const, uploads: [] as string[] },
    // The container answers and stalls mid-body: the body's cut is the preview stage's, and both uploads are aborted.
    { hang: "body" as const, cut: "preview" as const, uploads: ["full", "original"] },
    // The still is never answered: its cut is the preview stage's too.
    { hang: "still" as const, cut: "preview" as const, uploads: ["full", "original"] },
  ])("a container that hangs at its $hang ends at the $cut cut as timeout, stopped, its slot released", async (c) => {
    const w = await avWorld();
    const p = await platformFor(w);
    const up = await upload(w, p);
    p.hangNormalize(c.hang);
    const fired = p.fire();
    await vi.waitFor(() => expect(p.hung()).toBe(true));
    const row = (await held(w.store, up.id)).row!;
    const [input] = await sql<{ input_bytes: number }>(
      w.store,
      "SELECT input_bytes FROM media_processing WHERE media_id = ?",
      up.id,
    );
    const cut = allocate("v2", Date.now(), row.deadline_at!, input!.input_bytes).cuts[c.cut];
    // The wait the hang is raced against ends at the cut.
    expect(p.lastWait()).toBe(cut);
    expect(cut).toBeLessThan(row.deadline_at!);
    p.expire(cut);
    expect(await fired).toBe("returned");
    expect((await held(w.store, up.id)).row).toMatchObject({ state: "failed", failure: "timeout" });
    // The container's request was aborted at the cut, and the uploads begun were aborted.
    expect(p.requestAborted()).toBe(true);
    expect(p.aborts().toSorted()).toEqual(c.uploads);
    expect(p.writes()).toEqual([]);
    // D4, D8 and D9 in the same invocation: the container stopped, the input deleted, the slot released.
    await cleared(w, p, up.id);
  });
});
