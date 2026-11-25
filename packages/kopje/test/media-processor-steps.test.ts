import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  allocate,
  HARD_HOLD_MS,
  INCOMING_ORPHAN_AGE_MS,
  outputCut,
  V2_PROCESS_MS,
} from "../src/domain/media-processing";
import { incomingOrphans, R2_CALL_MS } from "../src/jobs/media-jobs";
import { incomingKey } from "../src/platform/media-files";
import { sql } from "./api-helpers";
import { BUILD } from "./helpers";
import { putInput } from "./media-job-helpers";
import { avWorld, clock, gate, held, HOUR, queued } from "./media-processing-helpers";
import { cleared, platformFor, upload } from "./media-unit-helpers";
import { post } from "./status-helpers";

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
    // The handler has started (the fired alarm is consumed, getAlarm null) and not yet reached D1 when run arrives.
    let during: number | null | undefined;
    p.storage.onGet = async () => {
      await p.unit().run(up.id, up.token, up.teardownId);
      during = p.storage.alarm;
    };
    const firedAt = p.storage.alarm;
    expect(await p.fire()).toBe("returned");
    expect(during).toBe(firedAt);
    // D1 replaced run's alarm, and the one invocation completed the job: nothing is left to fire.
    expect(p.storage.alarm).toBeNull();
    expect(await p.settle()).toBe(0);
    await cleared(w, p, up.id);
    expect(p.starts()).toBe(1);
  });
});

describe("table 1.3: D0 and D8 around a kill (r1 claim gaps)", () => {
  it("D0 commits the record and its alarm together: a kill just after its transaction leaves both", async () => {
    const w = await avWorld();
    const p = await platformFor(w);
    const up = await queued(w);
    await putInput(up.id);
    p.killNext("committed:run");
    void p.unit().run(up.id, up.token, up.teardownId);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(p.storage.map.size).toBe(1);
    expect(p.storage.alarm).not.toBeNull();
    await p.settle();
    await cleared(w, p, up.id);
    expect((await held(w.store, up.id)).att?.processed).toBe(1);
  });

  it("run arriving while alarm() runs (after D1) finds D1's alarm and changes nothing: one container, one job", async () => {
    const w = await avWorld();
    const p = await platformFor(w);
    const up = await upload(w, p);
    let during: { alarm: number | null; size: number } | null = null;
    p.beforeCall("startNormalize", async () => {
      const armed = p.storage.alarm;
      await p.unit().run(up.id, up.token, "a repeat");
      during = { alarm: p.storage.alarm, size: p.storage.map.size };
      expect(during.alarm).toBe(armed);
    });
    expect(await p.fire()).toBe("returned");
    expect(during).toMatchObject({ size: 1 });
    expect(during!.alarm).not.toBeNull();
    await cleared(w, p, up.id);
    expect(p.starts()).toBe(1);
    expect(p.storeCalls().filter((call) => call === "startNormalize")).toHaveLength(1);
  });

  it("D8 is repeated by the replay after a kill before S8: two deletes of the input", async () => {
    const w = await avWorld();
    const p = await platformFor(w);
    const up = await upload(w, p);
    p.killNext("before:releaseAvSlot");
    expect(await p.fire()).toBe("killed");
    expect(p.deletes().filter((key) => key === incomingKey(up.id))).toHaveLength(1);
    await p.settle();
    await cleared(w, p, up.id);
    expect(p.deletes().filter((key) => key === incomingKey(up.id))).toHaveLength(2);
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

  it("under the Worker's env maintenance starts nothing, sends no S4, and keeps the record and the alarm (M4)", async () => {
    const w = await avWorld();
    const p = await platformFor(w);
    const up = await upload(w, p);
    p.envMaintenance(true);
    p.clearCalls();
    expect(await p.fire()).toBe("returned");
    expect(p.storeCalls()).toEqual([]);
    expect(p.starts()).toBe(0);
    expect(p.storage.map.size).toBe(1);
    expect(p.storage.alarm).not.toBeNull();
    // Once it ends, the alarm's repeat completes the upload.
    p.envMaintenance(false);
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

  // Runs `fired` to its end, expiring each held destroy's bound once that destroy has started.
  async function through(p: Awaited<ReturnType<typeof platformFor>>, fired: Promise<string>): Promise<string> {
    let ended: string | null = null;
    void fired.then((value) => void (ended = value));
    let seen = p.destroys();
    for (let i = 0; i < 200 && ended === null; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const due = p.lastWait();
      if (ended === null && p.destroys() > seen && due !== null) {
        seen = p.destroys();
        p.expire(due);
      }
    }
    return ended ?? "pending";
  }

  it("a destroy held in two invocations ends each at its bound with no S8, the record, slot and alarm kept", async () => {
    const w = await avWorld();
    const p = await platformFor(w);
    const up = await upload(w, p);
    p.holdDestroy(true);
    for (const invocation of [1, 2]) {
      p.clearCalls();
      expect(await through(p, p.fire()), `invocation ${invocation}`).toBe("returned");
      expect(p.destroys()).toBeGreaterThanOrEqual(invocation);
      expect(p.running()).toBe(true);
      expect(p.storeCalls()).not.toContain("releaseAvSlot");
      expect(p.storage.map.size).toBe(1);
      expect(p.storage.alarm).not.toBeNull();
      expect((await held(w.store, up.id)).slot).not.toBeNull();
    }
    p.holdDestroy(false);
    await p.settle();
    await cleared(w, p, up.id);
  });

  it("an S8 that failed leaves the slot held, and one committed whose reply was lost leaves it released; the record and alarm stay in both until the replay", async () => {
    for (const lost of [false, true]) {
      const w = await avWorld();
      const p = await platformFor(w);
      const up = await upload(w, p);
      if (lost) {
        p.killNext("after:releaseAvSlot");
        expect(await p.fire()).toBe("killed");
      } else {
        p.beforeCall("releaseAvSlot", () => Promise.reject(new Error("store unreachable")));
        expect(await p.fire()).toBe("returned");
      }
      const slot = (await held(w.store, up.id)).slot;
      expect(slot === null, `lost: ${lost}`).toBe(lost);
      expect(p.storage.map.size).toBe(1);
      expect(p.storage.alarm).not.toBeNull();
      p.clearCalls();
      await p.settle();
      expect(p.storeCalls()).toContain("releaseAvSlot");
      await cleared(w, p, up.id);
    }
  });

  it("with the container already stopped, keeps the record one millisecond before V2_PROCESS_MS + HARD_HOLD_MS and drops it at that age (W9)", async () => {
    const w = await avWorld();
    const p = await platformFor(w);
    const up = await upload(w, p);
    const { at } = p.storage.map.get("upload") as { at: number };
    // S8 refused throughout (maintenance); the first alarm stops the container.
    await gate(w.store, "maintenance", true);
    await p.fire();
    expect(p.running()).toBe(false);
    p.storage.alarm = at + V2_PROCESS_MS + HARD_HOLD_MS - 1;
    await p.fire();
    expect(p.storage.map.size).toBe(1);
    expect(await env.MEDIA.head(incomingKey(up.id))).not.toBeNull();
    p.storage.alarm = at + V2_PROCESS_MS + HARD_HOLD_MS;
    await p.fire();
    expect(p.storage.map.size).toBe(0);
    expect(p.storage.alarm).toBeNull();
    expect(await env.MEDIA.head(incomingKey(up.id))).toBeNull();
    await gate(w.store, "maintenance", false);
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

describe("D8: the input is deleted before the record goes (M1, MEDIA-3)", () => {
  it("a failed delete keeps the record and the alarm with the slot released, and the repeat deletes the input even once the upload is attached", async () => {
    const w = await avWorld();
    const p = await platformFor(w);
    const up = await upload(w, p);
    p.failDeletes(1);
    expect(await p.fire()).toBe("returned");
    expect((await held(w.store, up.id)).att).toMatchObject({ processed: 1 });
    // S8 answered: the slot is free; the record and its alarm stay for the input.
    expect((await held(w.store, up.id)).slot).toBeNull();
    expect(p.storage.map.size).toBe(1);
    expect(p.storage.alarm).not.toBeNull();
    expect(await env.MEDIA.head(incomingKey(up.id))).not.toBeNull();
    // Attached before its detached grace runs out: no sweep will take its keys, and the orphan pass holds it.
    await post(w.h, w.h.users.alice, { status: "with a video", media_ids: [up.id] });
    await p.settle();
    clock(Date.now() + INCOMING_ORPHAN_AGE_MS + HOUR);
    await incomingOrphans({ build: BUILD, store: w.store, bucket: env.MEDIA }).catch(() => {});
    expect(await env.MEDIA.head(incomingKey(up.id))).toBeNull();
    expect(p.storage.map.size).toBe(0);
    expect(p.storage.alarm).toBeNull();
    expect(p.deletes().filter((key) => key === incomingKey(up.id))).toHaveLength(2);
  });

  it("the record-age stop keeps the record while its delete fails, and drops it once the delete succeeds (W9)", async () => {
    const w = await avWorld();
    const p = await platformFor(w);
    const up = await upload(w, p);
    await gate(w.store, "maintenance", true);
    await p.fire();
    clock(Date.now() + V2_PROCESS_MS + HARD_HOLD_MS);
    p.failDeletes(1);
    await p.fire();
    expect(p.storage.map.size).toBe(1);
    expect(p.storage.alarm).not.toBeNull();
    await p.fire();
    expect(p.storage.map.size).toBe(0);
    expect(await env.MEDIA.head(incomingKey(up.id))).toBeNull();
    await gate(w.store, "maintenance", false);
  });
});

describe("D8's delete is bounded (r2 M4)", () => {
  it("a delete that never answers ends at R2_CALL_MS: S8 releases the slot, and the record and alarm stay for the input", async () => {
    const w = await avWorld();
    const p = await platformFor(w);
    const up = await upload(w, p);
    p.hold("delete");
    const fired = p.fire();
    await vi.waitFor(() => expect(p.held()).toContain("delete"));
    p.expire(Date.now() + R2_CALL_MS);
    expect(await fired).toBe("returned");
    expect(p.storeCalls()).toContain("releaseAvSlot");
    expect((await held(w.store, up.id)).slot).toBeNull();
    expect(p.storage.map.size).toBe(1);
    expect(p.storage.alarm).not.toBeNull();
    p.release("delete");
    await p.settle();
    await cleared(w, p, up.id);
  });

  it("the record-age stop arms its retry before the delete, and a delete that never answers keeps the record (W9)", async () => {
    const w = await avWorld();
    const p = await platformFor(w);
    const up = await upload(w, p);
    const { at } = p.storage.map.get("upload") as { at: number };
    await gate(w.store, "maintenance", true);
    await p.fire();
    expect(p.running()).toBe(false);
    p.storage.alarm = at + V2_PROCESS_MS + HARD_HOLD_MS;
    p.hold("delete");
    const fired = p.fire();
    await vi.waitFor(() => expect(p.held()).toContain("delete"));
    expect(p.storage.alarm).not.toBeNull();
    p.expire(Date.now() + R2_CALL_MS);
    expect(await fired).toBe("returned");
    expect(p.storage.map.size).toBe(1);
    expect(p.storage.alarm).not.toBeNull();
    p.release("delete");
    await p.fire();
    expect(p.storage.map.size).toBe(0);
    expect(await env.MEDIA.head(incomingKey(up.id))).toBeNull();
    await gate(w.store, "maintenance", false);
  });
});

describe("table 1.3 D3: every wait on the container ends at its cut", () => {
  it.each([
    // The container takes the input and never answers: the reply's cut is the work deadline (the still's cut).
    { hang: "reply" as const, cut: "still" as const, uploads: [] as string[] },
    // The container answers and stalls mid-body: the body's cut is the transfer's, and both uploads are aborted.
    { hang: "body" as const, cut: "transfer" as const, uploads: ["full", "original"] },
    // The still is never answered: its cut is the preview's, which leaves the stop and the writes their time.
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
    const allocation = allocate("v2", Date.now(), row.deadline_at!, input!.input_bytes);
    // The hang is reached at its stage's start, and the fake's clock stands still from there.
    const cut = c.cut === "still" ? allocation.cuts.still : outputCut(allocation, c.cut, p.hungAt());
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

describe("the stop and the R2 waits around a cut (M2)", () => {
  async function cutWorld() {
    const w = await avWorld();
    const p = await platformFor(w);
    const up = await upload(w, p);
    const row = (await held(w.store, up.id)).row!;
    const [input] = await sql<{ input_bytes: number }>(
      w.store,
      "SELECT input_bytes FROM media_processing WHERE media_id = ?",
      up.id,
    );
    const allocation = allocate("v2", Date.now(), row.deadline_at!, input!.input_bytes);
    // A stage's cut, read once the run has reached that stage (its start is now: the fake's clock stands still).
    const cutOf = (stage: "still" | "transfer" | "preview") =>
      stage === "still" ? allocation.cuts.still : outputCut(allocation, stage, Date.now());
    return { w, p, up, cutOf };
  }

  it("a held first abort leaves the second abort and the stop attempted, and the invocation ends within its bounds", async () => {
    const { w, p, up, cutOf } = await cutWorld();
    p.hangNormalize("body");
    p.hold("abort:original");
    p.hold("abort:full");
    const fired = p.fire();
    await vi.waitFor(() => expect(p.hung()).toBe(true));
    p.expire(cutOf("transfer"));
    // Both aborts and the destroy start together; none waits on another.
    await vi.waitFor(() => expect(p.aborts().toSorted()).toEqual(["full", "original"]));
    await vi.waitFor(() => expect(p.running()).toBe(false));
    // The aborts are bounded: past R2_CALL_MS the job goes on to S7 and D8/D9 without them.
    const logged: unknown[] = [];
    vi.spyOn(console, "warn").mockImplementation((entry: unknown) => void logged.push(entry));
    p.expire(Date.now() + R2_CALL_MS);
    expect(await fired).toBe("returned");
    // DATA-5: the timed-out aborts are logged by the upload's id and variant, never by a key holding the file token.
    const aborted = logged.filter((e) => (e as { event?: string }).event === "kopje.media.job.abort_failed");
    expect(aborted.map((e) => (e as { variant?: string }).variant)).toEqual(
      expect.arrayContaining(["full", "original"]),
    );
    expect(aborted).toHaveLength(2);
    expect(JSON.stringify(logged)).not.toContain(up.token);
    // The transfer's cut is its allowance from the reply, well before deadline_at: S7 records the cut (D7).
    expect((await held(w.store, up.id)).row).toMatchObject({ state: "failed", failure: "timeout" });
    await cleared(w, p, up.id);
  });

  it("a held input get ends at the work deadline, the container stopped", async () => {
    const { w, p, up, cutOf } = await cutWorld();
    p.hold("get");
    const fired = p.fire();
    await vi.waitFor(() => expect(p.held()).toContain("get"));
    expect(p.lastWait()).toBe(cutOf("still"));
    p.expire(cutOf("still"));
    expect(await fired).toBe("returned");
    expect((await held(w.store, up.id)).row).toMatchObject({ state: "failed", failure: "timeout" });
    await cleared(w, p, up.id);
  });

  it("a creation that answers exactly at the transfer's cut, before the timer, has its upload aborted (r2 M3)", async () => {
    const { w, p, up, cutOf } = await cutWorld();
    p.hold("create:full");
    const fired = p.fire();
    await vi.waitFor(() => expect(p.held()).toContain("create:full"));
    clock(cutOf("transfer"));
    p.release("create:full");
    expect(await fired).toBe("returned");
    expect((await held(w.store, up.id)).row).toMatchObject({ state: "failed", failure: "timeout" });
    await vi.waitFor(() => expect(p.aborts().toSorted()).toEqual(["full", "original"]));
    await cleared(w, p, up.id);
  });

  it("a held chargeAvPoster ends at the preview's cut: the container stops and the upload completes with its poster", async () => {
    const { w, p, up, cutOf } = await cutWorld();
    p.beforeCall("chargeAvPoster", () => new Promise<void>(() => {}));
    const fired = p.fire();
    await vi.waitFor(() => expect(p.storeCalls()).toContain("chargeAvPoster"));
    p.expire(cutOf("preview"));
    expect(await fired).toBe("returned");
    expect((await held(w.store, up.id)).att).toMatchObject({ processed: 1 });
    expect(p.writes()).toEqual(["original", "full"]);
    await cleared(w, p, up.id);
  });

  it("a held multipart creation ends at the transfer's cut, and the upload it makes later is aborted", async () => {
    const { w, p, up, cutOf } = await cutWorld();
    p.hold("create:full");
    const fired = p.fire();
    await vi.waitFor(() => expect(p.held()).toContain("create:full"));
    p.expire(cutOf("transfer"));
    expect(await fired).toBe("returned");
    expect((await held(w.store, up.id)).row).toMatchObject({ state: "failed", failure: "timeout" });
    await cleared(w, p, up.id);
    expect(p.aborts()).toEqual(["original"]);
    p.release("create:full");
    await vi.waitFor(() => expect(p.aborts().toSorted()).toEqual(["full", "original"]));
  });
});
