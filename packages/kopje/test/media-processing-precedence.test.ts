import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DETACHED_GRACE_MS, DOOMED_AT } from "../src/domain/media";
import {
  AV_GRANT_MS,
  DISPATCH_MS,
  HARD_HOLD_MS,
  MAX_AV_INFLIGHT,
  STAGING_MS,
  T_MIN_ENCODE,
  T_REPLY,
  V2_PROCESS_MS,
} from "../src/domain/media-processing";
import { restoreMarkerKey } from "../src/platform/media-files";
import { sql } from "./api-helpers";
import { BUILD } from "./helpers";
import {
  ACTIVE,
  type AvWorld,
  avWorld,
  bookmark,
  charged,
  clock,
  completed,
  failed,
  gate,
  GATES,
  held,
  type Held,
  MINUTE,
  queued,
  reserve,
  restore,
  SECOND,
  staged,
  started,
  T0,
  TEXT,
  type Up,
  V1_LEFT,
  VIDEO,
} from "./media-processing-helpers";

// Table 1.2 of the PR4 plan (spec/media-upload/MediaUploadStore.tla, S1-S13 under K1, K3 and K4), one case per cell,
// each run through the Store's methods against migration 0121's schema. An upload is built to its phase (the columns),
// the clock set, and the operation (the rows) called once: its answer and what the Store then holds of the upload are
// compared with the cell. The sections below are the table at a time before every staged_until and deadline_at (v2),
// the staging column past staged_until, the pending and running columns at deadline_at (K4, v2 and v1), in
// maintenance (K1), and with the reservation at or before the restore marker and after it (K3); then the cells the
// table names by finding.

afterEach(() => {
  vi.useRealTimers();
});

type Phase = "staging" | "pending" | "running" | "failed" | "completed" | "none";
const PHASES: readonly Phase[] = ["staging", "pending", "running", "failed", "completed", "none"];

// The upload an operation is called on, as far as its phase made it.
type Ctx = Up & { stagedAt: number; teardownId: string; startId: string; invocation: string; v1: boolean };

async function build(w: AvWorld, phase: Phase, v1 = false): Promise<Ctx> {
  const none = { stagedAt: 0, teardownId: "no-teardown", startId: "no-start", invocation: "no-invocation", v1 };
  switch (phase) {
    case "staging":
      return { ...none, ...(await staged(w, { v1 })) };
    case "pending":
      return { ...none, ...(await queued(w, { v1 })) };
    case "running":
      return started(w, { v1 });
    case "failed":
      return failed(w, "refused", { v1 });
    case "completed":
      return completed(w, { v1 });
    case "none":
      return { ...none, ...(await reserve(w, T0)) };
  }
}

const OPS = {
  S1: (w: AvWorld, c: Ctx) =>
    w.store.takeAvSlot(BUILD, { id: c.id, token: c.token, kind: "video", v1Left: null, activation: ACTIVE }),
  S2: (w: AvWorld, c: Ctx) => w.store.releaseStaging(BUILD, { id: c.id, token: c.token, stagedAt: c.stagedAt }),
  S3: (w: AvWorld, c: Ctx) =>
    w.store.queueNormalize(BUILD, {
      id: c.id,
      token: c.token,
      stagedAt: c.stagedAt,
      bytes: 2_000_000,
      text: TEXT,
      activation: ACTIVE,
    }),
  S4: (w: AvWorld, c: Ctx) => w.store.startNormalize(BUILD, { id: c.id, token: c.token, invocation: c.invocation }),
  S4other: (w: AvWorld, c: Ctx) => w.store.startNormalize(BUILD, { id: c.id, token: c.token, invocation: "other" }),
  S5: (w: AvWorld, c: Ctx) => w.store.confirmAvWrite(BUILD, { id: c.id, startId: c.startId, write: "full" }),
  S6: (w: AvWorld, c: Ctx) =>
    w.store.completeAvUpload(BUILD, { id: c.id, token: c.token, startId: c.startId, facts: VIDEO }),
  S7: (w: AvWorld, c: Ctx) => w.store.failNormalize(BUILD, { id: c.id, startId: c.startId, cause: "verifier" }),
  S8: (w: AvWorld, c: Ctx) => w.store.releaseAvSlot(BUILD, { id: c.id, teardownId: c.teardownId }),
  S8other: (w: AvWorld, c: Ctx) => w.store.releaseAvSlot(BUILD, { id: c.id, teardownId: "another-teardown" }),
  S9: (w: AvWorld, c: Ctx) => w.store.v1Outcome(BUILD, { id: c.id, token: c.token }),
  S10: (w: AvWorld, c: Ctx) => w.store.v1Final(BUILD, { id: c.id, token: c.token }),
  S11: (w: AvWorld, c: Ctx) => w.store.deleteAvUpload(BUILD, { credential: w.alice, id: c.id }),
  S12: (w: AvWorld) => w.store.mediaDispatchRound(BUILD),
} as const;
type Op = keyof typeof OPS;

// What the Store holds, in the cells' terms: the row's state (failed with its cause), the slot (granted or not), the
// attachment (res, done, doomed).
type Shown = { row: string | null; slot: "staging" | "processing" | "granted" | null; att: "res" | "done" | "doomed" };

function shown(h: Held): Shown {
  const att = h.att!;
  return {
    row: h.row === null ? null : h.row.state === "failed" ? `failed ${h.row.failure}` : h.row.state,
    slot: h.slot === null ? null : h.slot.granted_at !== null ? "granted" : (h.slot.phase as "staging" | "processing"),
    att:
      att.gc_at === DOOMED_AT || (att.processed === 1 && att.url === "")
        ? "doomed"
        : att.processed === 1
          ? "done"
          : "res",
  };
}

// The record of each phase before the operation.
const BEFORE: Record<Phase, Shown> = {
  staging: { row: "staging", slot: "staging", att: "res" },
  pending: { row: "pending", slot: "processing", att: "res" },
  running: { row: "running", slot: "granted", att: "res" },
  failed: { row: "failed refused", slot: "granted", att: "res" },
  completed: { row: null, slot: "granted", att: "done" },
  none: { row: null, slot: null, att: "res" },
};

// A cell: the answer (matched as a subset, or a function of the upload), and what the Store holds after it (only what
// changed from BEFORE).
type Cell = { answer: object | ((c: Ctx) => object); after?: Partial<Shown> };
const same = (answer: Cell["answer"]): Cell => ({ answer });

const SETTLED_COMPLETED = { status: "settled", state: "completed" };

const TABLE: Record<Op, Record<Phase, Cell>> = {
  S1: {
    staging: same((c: Ctx) => ({ status: "taken", stagedAt: c.stagedAt })),
    pending: same({ status: "gone" }),
    running: same({ status: "gone" }),
    failed: same({ status: "gone" }),
    completed: same({ status: "gone" }),
    none: { answer: { status: "taken" }, after: { row: "staging", slot: "staging" } },
  },
  S2: {
    staging: { answer: { status: "released" }, after: { row: null, slot: null } },
    pending: same({ status: "not_staging" }),
    running: same({ status: "not_staging" }),
    failed: same({ status: "not_staging" }),
    completed: same({ status: "not_staging" }),
    none: same({ status: "not_staging" }),
  },
  S3: {
    staging: { answer: { status: "queued" }, after: { row: "pending", slot: "processing" } },
    pending: same((c: Ctx) => ({ status: "queued", teardownId: c.teardownId })),
    running: same({ status: "settled", outcome: "running" }),
    failed: same({ status: "settled", outcome: { failed: "refused" } }),
    completed: same({ status: "settled", outcome: "completed" }),
    none: same({ status: "gone" }),
  },
  S4: {
    staging: same({ status: "gone" }),
    pending: { answer: { status: "started" }, after: { row: "running", slot: "granted" } },
    running: same((c: Ctx) => ({ status: "started", startId: c.startId })),
    failed: same({ status: "settled", state: { failed: "refused" } }),
    completed: same(SETTLED_COMPLETED),
    none: same({ status: "gone" }),
  },
  S4other: {
    staging: same({ status: "gone" }),
    pending: { answer: { status: "started" }, after: { row: "running", slot: "granted" } },
    running: same({ status: "settled", state: "running" }),
    failed: same({ status: "settled", state: { failed: "refused" } }),
    completed: same(SETTLED_COMPLETED),
    none: same({ status: "gone" }),
  },
  S5: {
    staging: same({ status: "refused" }),
    pending: same({ status: "refused" }),
    running: same({ status: "grant", ms: AV_GRANT_MS }),
    failed: same({ status: "refused" }),
    completed: same({ status: "refused" }),
    none: same({ status: "refused" }),
  },
  S6: {
    staging: same({ status: "refused" }),
    pending: same({ status: "refused" }),
    running: { answer: { status: "done" }, after: { row: null, att: "done" } },
    failed: same({ status: "refused" }),
    completed: same({ status: "done" }),
    none: same({ status: "refused" }),
  },
  S7: {
    staging: same({ status: "gone" }),
    pending: same({ status: "gone" }),
    running: { answer: { status: "recorded", cause: "verifier" }, after: { row: "failed verifier" } },
    failed: same({ status: "recorded", cause: "refused" }),
    completed: same(SETTLED_COMPLETED),
    none: same({ status: "gone" }),
  },
  S8: {
    staging: same({ status: "released" }),
    pending: same({ status: "held" }),
    running: { answer: { status: "released" }, after: { slot: null } },
    failed: { answer: { status: "released" }, after: { slot: null } },
    completed: { answer: { status: "released" }, after: { slot: null } },
    none: same({ status: "released" }),
  },
  S8other: {
    staging: same({ status: "released" }),
    pending: same({ status: "released" }),
    running: same({ status: "released" }),
    failed: same({ status: "released" }),
    completed: same({ status: "released" }),
    none: same({ status: "released" }),
  },
  S9: {
    staging: same({ status: "processing" }),
    pending: same({ status: "processing" }),
    running: same({ status: "processing" }),
    failed: same({ status: "ended" }),
    completed: same({ status: "done" }),
    none: same({ status: "ended" }),
  },
  S10: {
    staging: { answer: { status: 503 }, after: { row: null, att: "doomed" } },
    pending: { answer: { status: 503 }, after: { row: null, att: "doomed" } },
    running: { answer: { status: 503 }, after: { row: null, att: "doomed" } },
    failed: same({ status: 422 }),
    completed: same({ status: 200 }),
    none: { answer: { status: 503 }, after: { att: "doomed" } },
  },
  S11: {
    staging: same({ status: "ok", value: "not_found" }),
    pending: { answer: { status: "ok", value: "deleted" }, after: { row: null, att: "doomed" } },
    running: { answer: { status: "ok", value: "deleted" }, after: { row: null, att: "doomed" } },
    failed: { answer: { status: "ok", value: "deleted" }, after: { row: null, att: "doomed" } },
    completed: { answer: { status: "ok", value: "deleted" }, after: { att: "doomed" } },
    none: same({ status: "ok", value: "not_found" }),
  },
  S12: {
    staging: same({ runs: [] }),
    pending: same({ runs: [] }),
    running: same({ runs: [] }),
    failed: same({ runs: [] }),
    completed: same({ runs: [] }),
    none: same({ runs: [] }),
  },
};

async function runCell(w: AvWorld, c: Ctx, op: Op, cell: Cell, before: Shown): Promise<void> {
  const answer = await OPS[op](w, c);
  const expected = typeof cell.answer === "function" ? (cell.answer as (c: Ctx) => unknown)(c) : cell.answer;
  expect(answer).toMatchObject(expected as object);
  expect(shown(await held(w.store, c.id))).toEqual({ ...before, ...cell.after });
}

const CASES = (Object.keys(TABLE) as Op[]).flatMap((op) => PHASES.map((phase) => [op, phase] as const));

describe("table 1.2 before staged_until and deadline_at (v2)", () => {
  it.each(CASES)("%s on %s", async (op, phase) => {
    const w = await avWorld();
    const c = await build(w, phase);
    clock(T0 + 10 * SECOND);
    expect(shown(await held(w.store, c.id))).toEqual(BEFORE[phase]);
    await runCell(w, c, op, TABLE[op][phase], BEFORE[phase]);
  });

  it("S3 charges one unit on the queue and none on its repeat (ChargeOnce)", async () => {
    const w = await avWorld();
    const c = await staged(w);
    clock(T0 + 10 * SECOND);
    await OPS.S3(w, { ...c, teardownId: "", startId: "", invocation: "" });
    expect(await charged(w.store)).toBe(1);
    await OPS.S3(w, { ...c, teardownId: "", startId: "", invocation: "" });
    expect(await charged(w.store)).toBe(1);
  });

  it("S4's start stores granted_at at the Store's time, and the slot's held_until stays deadline_at", async () => {
    const w = await avWorld();
    const c = await queued(w);
    const before = await held(w.store, c.id);
    expect(before.slot).toMatchObject({ phase: "processing", granted_at: null, held_until: before.row!.deadline_at });
    clock(T0 + 7 * SECOND);
    expect(await OPS.S4(w, { ...c, startId: "", invocation: "inv-a" })).toMatchObject({
      status: "started",
      msLeft: before.row!.deadline_at! - (T0 + 7 * SECOND),
    });
    expect((await held(w.store, c.id)).slot).toMatchObject({
      granted_at: T0 + 7 * SECOND,
      held_until: before.row!.deadline_at,
    });
  });

  it("S6 stores the upload's own facts and keeps the text S3 stored", async () => {
    const w = await avWorld();
    const c = await completed(w);
    const [row] = await sql<{
      url: string;
      preview_url: string;
      gc_at: string;
      description: string;
      focus_given: number;
    }>(w.store, "SELECT url, preview_url, gc_at, description, focus_given FROM media_attachments WHERE id = ?", c.id);
    expect(row).toMatchObject({
      description: TEXT.description,
      focus_given: 1,
      gc_at: new Date(T0 + 4 * SECOND + DETACHED_GRACE_MS).toISOString(),
    });
    expect(row!.url).toMatch(/\/full\.mp4$/);
    expect(row!.preview_url).toMatch(/\/small\.webp$/);
  });
});

describe("the staging column at and past staged_until", () => {
  const PAST: Partial<Record<Op, Cell>> = {
    S1: { answer: { status: "taken", stagingMs: 0 } },
    S2: { answer: { status: "released" }, after: { row: null, slot: null } },
    S3: { answer: { status: "refused_cleanup_yours", reason: "staging_deadline" }, after: { row: null, slot: null } },
    S12: { answer: { runs: [], counts: { abandoned: 1 } }, after: { row: null, slot: null } },
  };
  it.each(Object.keys(PAST) as Op[])("%s", async (op) => {
    const w = await avWorld();
    const c = await build(w, "staging");
    clock(c.stagedAt + STAGING_MS);
    await runCell(w, c, op, PAST[op]!, BEFORE.staging);
    expect(await charged(w.store)).toBe(0);
  });

  it("S3 one millisecond before staged_until queues", async () => {
    const w = await avWorld();
    const c = await build(w, "staging");
    clock(c.stagedAt + STAGING_MS - 1);
    await runCell(w, c, "S3", TABLE.S3.staging, BEFORE.staging);
  });
});

// K4: at deadline_at a pending or running v2 row fails `deadline`; a v1 one is doomed. Then the operation's own rule.
describe("the pending and running columns at deadline_at (K4)", () => {
  const V2: Record<Op, Cell> = {
    S1: { answer: { status: "gone" } },
    S2: { answer: { status: "not_staging" } },
    S3: { answer: { status: "settled", outcome: { failed: "deadline" } } },
    S4: { answer: { status: "settled", state: { failed: "deadline" } } },
    S4other: { answer: { status: "settled", state: { failed: "deadline" } } },
    S5: { answer: { status: "refused" } },
    S6: { answer: { status: "refused" } },
    S7: { answer: { status: "recorded", cause: "deadline" } },
    S8: { answer: { status: "released" }, after: { slot: null } },
    S8other: { answer: { status: "released" } },
    S9: { answer: { status: "ended" } },
    S10: { answer: { status: 503 }, after: { row: null, att: "doomed" } },
    S11: { answer: { status: "ok", value: "deleted" }, after: { row: null, att: "doomed" } },
    S12: { answer: { runs: [] } },
  };
  const V1: Record<Op, Cell> = {
    ...V2,
    S3: { answer: { status: "gone" } },
    S4: { answer: { status: "gone" } },
    S4other: { answer: { status: "gone" } },
    S7: { answer: { status: "gone" } },
    S10: { answer: { status: 503 } },
    S11: { answer: { status: "ok", value: "not_found" } },
  };
  const cases = (["pending", "running"] as const).flatMap((phase) =>
    (Object.keys(V2) as Op[]).flatMap((op) => [[phase, "v2", op] as const, [phase, "v1", op] as const]),
  );
  it.each(cases)("%s %s: %s", async (phase, endpoint, op) => {
    const w = await avWorld();
    const c = await build(w, phase, endpoint === "v1");
    const { row } = await held(w.store, c.id);
    clock(row!.deadline_at!);
    // K4's own effect, whatever the operation's rule then does.
    const k4: Partial<Shown> = endpoint === "v1" ? { row: null, att: "doomed" } : { row: "failed deadline" };
    // S8 is the processor's confirmation of the stop: a pending row's slot is released once K4 failed it.
    const cell = (endpoint === "v1" ? V1 : V2)[op];
    // S9 is a read: it answers as K4 would leave the row and writes nothing. S12 also deletes a pending row's slot,
    // which was never granted and stopped counting at its held_until, deadline_at.
    const after =
      op === "S9" ? {} : { ...k4, ...cell.after, ...(op === "S12" && phase === "pending" ? { slot: null } : {}) };
    await runCell(w, c, op, { ...cell, after }, BEFORE[phase]);
  });

  it("one millisecond before deadline_at S5 grants that millisecond", async () => {
    const w = await avWorld();
    const c = await build(w, "running");
    const { row } = await held(w.store, c.id);
    clock(row!.deadline_at! - 1);
    expect(await OPS.S5(w, c)).toEqual({ status: "grant", ms: 1 });
  });
});

// K1: every write answers `maintenance` and changes nothing; S9 is a read; S10 answers 200 for a completed upload
// before its gc_at and `maintenance` otherwise, dooming nothing.
describe("in maintenance (K1)", () => {
  const MAINT: Record<Op, (phase: Phase) => unknown> = {
    S1: () => ({ status: "maintenance" }),
    S2: () => ({ status: "maintenance" }),
    S3: () => ({ status: "maintenance" }),
    S4: () => ({ status: "maintenance" }),
    S4other: () => ({ status: "maintenance" }),
    S5: () => ({ status: "maintenance" }),
    S6: () => ({ status: "maintenance" }),
    S7: () => ({ status: "maintenance" }),
    S8: () => ({ status: "maintenance" }),
    S8other: () => ({ status: "maintenance" }),
    // Past deadline_at a pending or running row reads as K4 would leave it.
    S9: (phase) => ({ status: phase === "staging" ? "processing" : phase === "completed" ? "done" : "ended" }),
    S10: (phase) => (phase === "completed" ? { status: 200 } : { status: "maintenance" }),
    S11: () => ({ status: "maintenance" }),
    S12: () => ({ status: "maintenance" }),
  };
  it.each(CASES)("%s on %s", async (op, phase) => {
    const w = await avWorld();
    const c = await build(w, phase);
    // Past every deadline, so that K3 or K4 would change the row if the gate let anything through.
    const { row } = await held(w.store, c.id);
    clock((row?.deadline_at ?? T0 + 10 * SECOND) + DISPATCH_MS);
    await gate(w.store, "maintenance", true);
    const before = await held(w.store, c.id);
    expect(await OPS[op](w, c)).toMatchObject(MAINT[op](phase) as object);
    expect(await held(w.store, c.id)).toEqual(before);
    expect(await charged(w.store)).toBe(phase === "staging" || phase === "none" ? 0 : 1);
  });
});

// K3: the reservation made at or before the restore marker. A staging row and its slot are deleted; a pending or
// running row fails `restored`, its slot kept. Then the operation's own rule.
describe("with the reservation at or before the restore marker (K3)", () => {
  const RESTORED: Record<"staging" | "pending" | "running", Partial<Record<Op, Cell>>> = {
    staging: {
      S1: { answer: { status: "gone" } },
      S2: { answer: { status: "not_staging" } },
      S3: { answer: { status: "refused_cleanup_yours", reason: "restored" } },
      S4: { answer: { status: "gone" } },
      S8: { answer: { status: "released" } },
      S9: { answer: { status: "ended" } },
      S10: { answer: { status: 503 }, after: { att: "doomed" } },
      // K3 deleted the staging row: an unfinished reservation with no row is not found (table 1.2, "no row"), as for
      // DELETE; the sweep takes it at its gc_at.
      S11: { answer: { status: "ok", value: "not_found" } },
      S12: { answer: { runs: [], counts: { restored: 1 } } },
    },
    pending: {
      S1: { answer: { status: "gone" } },
      S3: { answer: { status: "settled", outcome: { failed: "restored" } } },
      S4: { answer: { status: "settled", state: { failed: "restored" } } },
      S5: { answer: { status: "refused" } },
      S7: { answer: { status: "recorded", cause: "restored" } },
      S8: { answer: { status: "released" }, after: { slot: null } },
      S8other: { answer: { status: "released" } },
      S9: { answer: { status: "ended" } },
      S10: { answer: { status: 503 }, after: { row: null, att: "doomed" } },
      S11: { answer: { status: "ok", value: "deleted" }, after: { row: null, att: "doomed" } },
      S12: { answer: { runs: [], counts: { restored: 1 } } },
    },
    running: {
      S4: { answer: { status: "settled", state: { failed: "restored" } } },
      S5: { answer: { status: "refused" } },
      S6: { answer: { status: "refused" } },
      S7: { answer: { status: "recorded", cause: "restored" } },
      S8: { answer: { status: "released" }, after: { slot: null } },
      S9: { answer: { status: "ended" } },
      S10: { answer: { status: 503 }, after: { row: null, att: "doomed" } },
      S12: { answer: { runs: [], counts: { restored: 1 } } },
    },
  };
  const K3: Record<"staging" | "pending" | "running", Partial<Shown>> = {
    staging: { row: null, slot: null },
    pending: { row: "failed restored" },
    running: { row: "failed restored" },
  };
  const cases = (["staging", "pending", "running"] as const).flatMap((phase) =>
    (Object.keys(RESTORED[phase]) as Op[]).map((op) => [phase, op] as const),
  );
  it.each(cases)("%s: %s", async (phase, op) => {
    const w = await avWorld();
    const c = await build(w, phase);
    // A bookmark taken in this phase, and a restore to it after the reservation.
    await restore(w.store, await bookmark(w.store), T0 + 5 * SECOND);
    clock(T0 + 10 * SECOND);
    const cell = RESTORED[phase][op]!;
    // S9 is a read: it answers as K3 would leave the row and writes nothing.
    await runCell(w, c, op, { ...cell, after: op === "S9" ? {} : { ...K3[phase], ...cell.after } }, BEFORE[phase]);
  });

  it.each(["staging", "pending", "running"] as const)(
    "%s: a restore marker before the reservation fences nothing",
    async (phase) => {
      const w = await avWorld();
      await restore(w.store, await bookmark(w.store), T0 - 1);
      const c = await build(w, phase);
      clock(T0 + 10 * SECOND);
      const op = phase === "staging" ? "S3" : "S4";
      await runCell(w, c, op, TABLE[op][phase], BEFORE[phase]);
    },
  );

  it("a reservation made exactly at the restore marker is fenced", async () => {
    const w = await avWorld();
    const c = await build(w, "pending");
    await restore(w.store, await bookmark(w.store), T0);
    clock(T0 + 10 * SECOND);
    expect(await OPS.S4(w, c)).toEqual({ status: "settled", state: { failed: "restored" } });
  });
});

// The cells the plan names by finding.
describe("named cells", () => {
  it("M4, S7 first: S7 timeout before deadline_at, then S10 answers 500", async () => {
    const w = await avWorld();
    const c = await started(w, { v1: true });
    clock(T0 + 10 * SECOND);
    expect(await w.store.failNormalize(BUILD, { id: c.id, startId: c.startId, cause: "timeout" })).toEqual({
      status: "recorded",
      cause: "timeout",
    });
    expect(await OPS.S10(w, { ...c, stagedAt: 0 })).toEqual({ status: 500 });
  });

  it("M4, K4 first: past deadline_at S7 timeout records deadline, and S10 answers 503", async () => {
    const w = await avWorld();
    const c = await started(w);
    const { row } = await held(w.store, c.id);
    clock(row!.deadline_at!);
    expect(await w.store.failNormalize(BUILD, { id: c.id, startId: c.startId, cause: "timeout" })).toEqual({
      status: "recorded",
      cause: "deadline",
    });
    expect(await OPS.S10(w, { ...c, stagedAt: 0 })).toEqual({ status: 503 });
    expect(shown(await held(w.store, c.id))).toMatchObject({ row: null, att: "doomed" });
  });

  it.each(["verifier", "unavailable", "timeout"] as const)("S10 on a failed %s upload answers 500", async (cause) => {
    const w = await avWorld();
    const c = await failed(w, cause, { v1: true });
    clock(T0 + 10 * SECOND);
    expect(await OPS.S10(w, { ...c, stagedAt: 0 })).toEqual({ status: 500 });
    expect(shown(await held(w.store, c.id)).att).toBe("res");
  });

  it.each(["refused", "envelope"] as const)("S10 on a failed %s upload answers 422", async (cause) => {
    const w = await avWorld();
    const c = await failed(w, cause, { v1: true });
    clock(T0 + 10 * SECOND);
    expect(await OPS.S10(w, { ...c, stagedAt: 0 })).toEqual({ status: 422 });
  });

  it.each(["deadline", "restored"] as const)(
    "S10 on a failed %s upload answers 503 and dooms it (Q4)",
    async (cause) => {
      const w = await avWorld();
      const c = await failed(w, cause, { v1: true });
      clock(T0 + 10 * SECOND);
      expect(await OPS.S10(w, { ...c, stagedAt: 0 })).toEqual({ status: 503 });
      expect(shown(await held(w.store, c.id))).toMatchObject({ row: null, att: "doomed" });
    },
  );

  it("Q4, the round's K3 first: S13 fails the restored row, then S10 answers 503 and dooms it", async () => {
    const w = await avWorld();
    const c = await started(w, { v1: true });
    await restore(w.store, await bookmark(w.store), T0 + 5 * SECOND);
    clock(T0 + 10 * SECOND);
    expect(await OPS.S12(w)).toMatchObject({ counts: { restored: 1 } });
    expect((await held(w.store, c.id)).row).toMatchObject({ state: "failed", failure: "restored" });
    expect(await OPS.S10(w, { ...c, stagedAt: 0 })).toEqual({ status: 503 });
    expect(shown(await held(w.store, c.id))).toMatchObject({ row: null, att: "doomed", slot: "granted" });
  });

  it("Q4, S10's own K3: S10 answers 503 and dooms the restored row", async () => {
    const w = await avWorld();
    const c = await started(w, { v1: true });
    await restore(w.store, await bookmark(w.store), T0 + 5 * SECOND);
    clock(T0 + 10 * SECOND);
    expect(await OPS.S10(w, { ...c, stagedAt: 0 })).toEqual({ status: 503 });
    expect(shown(await held(w.store, c.id))).toMatchObject({ row: null, att: "doomed", slot: "granted" });
  });

  it("r4 H1: S10 at the route's cut dooms a running v1 job before its deadline_at", async () => {
    const w = await avWorld();
    const c = await started(w, { v1: true });
    const { row } = await held(w.store, c.id);
    clock(row!.deadline_at! - 1);
    expect(await OPS.S10(w, { ...c, stagedAt: 0 })).toEqual({ status: 503 });
    expect(await OPS.S5(w, { ...c, stagedAt: 0 })).toEqual({ status: "refused" });
    expect(await OPS.S6(w, { ...c, stagedAt: 0 })).toEqual({ status: "refused" });
  });

  it("S10 on a completed upload at and after its gc_at answers 503 and changes nothing (S10IgnoresGc)", async () => {
    const w = await avWorld();
    const c = await completed(w, { v1: true });
    const gcAt = T0 + 4 * SECOND + DETACHED_GRACE_MS;
    for (const at of [gcAt, gcAt + 1]) {
      clock(at);
      const before = await held(w.store, c.id);
      expect(await OPS.S10(w, { ...c, stagedAt: 0 })).toEqual({ status: 503 });
      expect(await held(w.store, c.id)).toEqual(before);
    }
    clock(gcAt - 1);
    expect(await OPS.S10(w, { ...c, stagedAt: 0 })).toMatchObject({ status: 200, media: { id: c.id, type: "video" } });
  });

  it("S10 in maintenance answers 200 for a completed upload before its gc_at, and maintenance at it", async () => {
    const w = await avWorld();
    const c = await completed(w, { v1: true });
    await gate(w.store, "maintenance", true);
    clock(T0 + 10 * SECOND);
    expect(await OPS.S10(w, { ...c, stagedAt: 0 })).toMatchObject({ status: 200 });
    clock(T0 + 4 * SECOND + DETACHED_GRACE_MS);
    expect(await OPS.S10(w, { ...c, stagedAt: 0 })).toEqual({ status: "maintenance" });
  });

  it.each(Object.keys(GATES) as (keyof typeof GATES)[])(
    "S10 under the %s gate answers maintenance for a running job and changes nothing (K1, M5)",
    async (name) => {
      const w = await avWorld();
      const c = await started(w, { v1: true });
      await gate(w.store, name, true);
      clock(T0 + 10 * SECOND);
      const before = await held(w.store, c.id);
      expect(await OPS.S10(w, { ...c, stagedAt: 0 })).toEqual({ status: "maintenance" });
      expect(await held(w.store, c.id)).toEqual(before);
    },
  );

  it.each([
    ["maintenance", 200],
    ["dump", 200],
    ["unpublished", 200],
    ["import", "maintenance"],
  ] as const)(
    "S10 under the %s gate on a completed upload answers %s (reads admitted or not)",
    async (name, answer) => {
      const w = await avWorld();
      const c = await completed(w, { v1: true });
      await gate(w.store, name, true);
      clock(T0 + 10 * SECOND);
      expect(await OPS.S10(w, { ...c, stagedAt: 0 })).toMatchObject({ status: answer });
    },
  );

  it.each(Object.keys(GATES) as (keyof typeof GATES)[])(
    "S10 under the %s gate answers maintenance when the restore marker cannot be read",
    async (name) => {
      const w = await avWorld();
      const c = await started(w, { v1: true });
      await env.MEDIA.put(restoreMarkerKey(w.store.id.toString()), "not json");
      await gate(w.store, name, true);
      clock(T0 + 10 * SECOND);
      expect(await OPS.S10(w, { ...c, stagedAt: 0 })).toEqual({ status: "maintenance" });
    },
  );

  it.each([
    ["kept (gc_at NULL)", null, "in_use"],
    ["at its gc_at", "now", "not_found"],
  ] as const)(
    "S11 on a completed upload %s answers as DELETE does: %s, nothing doomed (M6)",
    async (_name, gcAt, answer) => {
      const w = await avWorld();
      const c = await completed(w);
      clock(T0 + 10 * SECOND);
      await sql(
        w.store,
        "UPDATE media_attachments SET gc_at = ? WHERE id = ?",
        gcAt === null ? null : new Date(T0 + 10 * SECOND).toISOString(),
        c.id,
      );
      const before = await held(w.store, c.id);
      expect(await w.store.deleteAvUpload(BUILD, { credential: w.alice, id: c.id })).toEqual({
        status: "ok",
        value: answer,
      });
      expect(await held(w.store, c.id)).toEqual(before);
    },
  );

  it("S11 by another account on an unfinished upload answers not_found and changes nothing", async () => {
    const w = await avWorld();
    const c = await started(w);
    clock(T0 + 10 * SECOND);
    const before = await held(w.store, c.id);
    expect(await w.store.deleteAvUpload(BUILD, { credential: w.bob, id: c.id })).toEqual({
      status: "ok",
      value: "not_found",
    });
    expect(await held(w.store, c.id)).toEqual(before);
  });

  it("S11 on an unfinished upload a scheduled status holds answers in_use and changes nothing", async () => {
    const w = await avWorld();
    const c = await started(w);
    clock(T0 + 10 * SECOND);
    // A status cannot hold an unfinished upload (CHECK status_id IS NULL OR processed = 1); a scheduled one is held
    // only by the application's rules, so the Store's DELETE checks it.
    const [owner] = await sql<{ account_id: string }>(
      w.store,
      "SELECT account_id FROM media_attachments WHERE id = ?",
      c.id,
    );
    await sql(
      w.store,
      "INSERT INTO scheduled_statuses (id, account_id, scheduled_at, params) VALUES ('600000000000000001', ?, ?, '{}')",
      owner!.account_id,
      new Date(T0 + 60 * 60 * SECOND).toISOString(),
    );
    await sql(w.store, "UPDATE media_attachments SET scheduled_status_id = '600000000000000001' WHERE id = ?", c.id);
    const before = await held(w.store, c.id);
    expect(await w.store.deleteAvUpload(BUILD, { credential: w.alice, id: c.id })).toEqual({
      status: "ok",
      value: "in_use",
    });
    expect(await held(w.store, c.id)).toEqual(before);
  });

  it("S4 with less than T_MIN_ENCODE left after the remaining fixed parts fails the job timeout", async () => {
    const w = await avWorld();
    const c = await queued(w, { v1: true });
    const { row } = await held(w.store, c.id);
    // The start's fixed parts (start, input, probe, still, preview, commit) are 15 s at this input's size.
    const fixed = 15 * SECOND;
    clock(row!.deadline_at! - fixed - T_MIN_ENCODE + 1);
    expect(await OPS.S4(w, { ...c, startId: "", invocation: "inv-late" })).toEqual({
      status: "settled",
      state: { failed: "timeout" },
    });
    expect(shown(await held(w.store, c.id))).toMatchObject({ row: "failed timeout", slot: "processing" });
    expect(await OPS.S10(w, { ...c, startId: "", invocation: "" })).toEqual({ status: 500 });
  });

  it("S4 with exactly T_MIN_ENCODE left starts", async () => {
    const w = await avWorld();
    const c = await queued(w, { v1: true });
    const { row } = await held(w.store, c.id);
    clock(row!.deadline_at! - 15 * SECOND - T_MIN_ENCODE);
    expect(await OPS.S4(w, { ...c, startId: "", invocation: "inv-edge" })).toMatchObject({ status: "started" });
  });

  it("S8's held: a pending row's slot is not freed by its teardown_id", async () => {
    const w = await avWorld();
    const c = await queued(w);
    clock(T0 + 10 * SECOND);
    expect(await OPS.S8(w, { ...c, startId: "", invocation: "" })).toEqual({ status: "held" });
    expect((await held(w.store, c.id)).slot).toMatchObject({ phase: "processing", teardown_id: c.teardownId });
  });

  it("r4 H2: S8 on a restored running row with its teardown_id releases the slot", async () => {
    const w = await avWorld();
    const c = await started(w);
    await restore(w.store, await bookmark(w.store), T0 + 5 * SECOND);
    clock(T0 + 10 * SECOND);
    expect(await OPS.S8(w, c)).toEqual({ status: "released" });
    expect(shown(await held(w.store, c.id))).toMatchObject({ row: "failed restored", slot: null });
  });

  it.each(Object.keys(GATES) as (keyof typeof GATES)[])(
    "S8 under the %s gate answers maintenance and the granted slot still counts",
    async (name) => {
      const w = await avWorld();
      const c = await completed(w);
      const other = await started(w);
      await gate(w.store, name, true);
      clock(T0 + 10 * SECOND);
      expect(await OPS.S8(w, c)).toEqual({ status: "maintenance" });
      expect((await held(w.store, c.id)).slot).toMatchObject({ granted_at: T0 + 3 * SECOND });
      await gate(w.store, name, false);
      // Both granted slots count: a third upload is busy.
      expect(MAX_AV_INFLIGHT).toBe(2);
      const third = await reserve(w, T0 + 10 * SECOND);
      expect(
        await OPS.S1(w, { ...third, stagedAt: 0, teardownId: "", startId: "", invocation: "", v1: false }),
      ).toEqual({
        status: "busy",
      });
      // Once confirmed, the slot is free again.
      expect(await OPS.S8(w, c)).toEqual({ status: "released" });
      expect(
        await OPS.S1(w, { ...third, stagedAt: 0, teardownId: "", startId: "", invocation: "", v1: false }),
      ).toMatchObject({
        status: "taken",
      });
      expect((await held(w.store, other.id)).slot).toMatchObject({ granted_at: T0 + 3 * SECOND });
    },
  );

  it("S8 with another teardown_id leaves the slot as it is in every column (ConfirmFenced)", async () => {
    const w = await avWorld();
    const c = await completed(w);
    clock(T0 + 10 * SECOND);
    const before = await held(w.store, c.id);
    expect(await OPS.S8other(w, c)).toEqual({ status: "released" });
    expect(await held(w.store, c.id)).toEqual(before);
  });

  it("S12 deletes a granted slot only at granted_at + HARD_HOLD_MS, whatever its held_until", async () => {
    const w = await avWorld();
    const c = await completed(w);
    const grantedAt = T0 + 3 * SECOND;
    const { slot } = await held(w.store, c.id);
    clock(slot!.held_until + 1);
    await OPS.S12(w);
    expect((await held(w.store, c.id)).slot).not.toBeNull();
    clock(grantedAt + HARD_HOLD_MS - 1);
    await OPS.S12(w);
    expect((await held(w.store, c.id)).slot).not.toBeNull();
    clock(grantedAt + HARD_HOLD_MS);
    expect(await OPS.S12(w)).toMatchObject({ counts: { slots: 1 } });
    expect((await held(w.store, c.id)).slot).toBeNull();
  });

  it("S12 deletes a slot never granted at its held_until", async () => {
    const w = await avWorld();
    const c = await queued(w);
    const { slot } = await held(w.store, c.id);
    clock(slot!.held_until - 1);
    await OPS.S12(w);
    expect((await held(w.store, c.id)).slot).not.toBeNull();
    clock(slot!.held_until);
    await OPS.S12(w);
    expect((await held(w.store, c.id)).slot).toBeNull();
  });

  it("S12 dispatches a pending row again once DISPATCH_MS passed since its dispatch", async () => {
    const w = await avWorld();
    const c = await queued(w);
    clock(T0 + 2 * SECOND + DISPATCH_MS - 1);
    expect(await OPS.S12(w)).toMatchObject({ runs: [] });
    clock(T0 + 2 * SECOND + DISPATCH_MS);
    expect(await OPS.S12(w)).toMatchObject({ runs: [{ id: c.id, token: c.token, teardownId: c.teardownId }] });
    expect((await held(w.store, c.id)).row).toMatchObject({ dispatched_at: T0 + 2 * SECOND + DISPATCH_MS });
  });
});

describe("S1's own rule", () => {
  const ctx = (up: Up): Ctx => ({ ...up, stagedAt: 0, teardownId: "", startId: "", invocation: "", v1: false });

  it.each([
    ["after S2", "S2"],
    ["after an S3 refusal", "S3"],
    ["after S12's expiry", "S12"],
  ] as const)("answers gone %s (the staged mark)", async (_name, ended) => {
    const w = await avWorld();
    const c = await build(w, "staging");
    if (ended === "S2") {
      clock(T0 + 10 * SECOND);
      await OPS.S2(w, c);
    } else {
      clock(c.stagedAt + STAGING_MS);
      await (ended === "S3" ? OPS.S3(w, c) : OPS.S12(w));
    }
    expect((await held(w.store, c.id)).row).toBeNull();
    expect(await OPS.S1(w, c)).toEqual({ status: "gone" });
    expect((await held(w.store, c.id)).row).toBeNull();
  });

  it("answers gone for a reservation made at or before the restore marker", async () => {
    const w = await avWorld();
    const up = await reserve(w, T0);
    await restore(w.store, await bookmark(w.store), T0 + SECOND);
    clock(T0 + 2 * SECOND);
    expect(await OPS.S1(w, ctx(up))).toEqual({ status: "gone" });
    // The same reservation after a marker before it stages.
    await restore(w.store, await bookmark(w.store), T0 - 1);
    expect(await OPS.S1(w, ctx(up))).toMatchObject({ status: "taken" });
  });

  it("answers time past the reservation's write deadline, and stages one millisecond before it", async () => {
    const w = await avWorld();
    const up = await reserve(w, T0);
    clock(T0 + 15 * MINUTE);
    expect(await OPS.S1(w, ctx(up))).toEqual({ status: "time" });
    clock(T0 + 15 * MINUTE - 1);
    expect(await OPS.S1(w, ctx(up))).toMatchObject({ status: "taken" });
  });

  it("answers time for a v1 upload with T_REPLY or less left, and stages one millisecond more", async () => {
    const w = await avWorld();
    const up = await reserve(w, T0);
    clock(T0 + SECOND);
    const take = (v1Left: number) =>
      w.store.takeAvSlot(BUILD, { id: up.id, token: up.token, kind: "video", v1Left, activation: ACTIVE });
    expect(await take(T_REPLY)).toEqual({ status: "time" });
    expect(await take(T_REPLY + 1)).toMatchObject({ status: "taken" });
  });

  it("answers inactive without the binding, without a budget, and without a passed probe for the build", async () => {
    const w = await avWorld();
    const up = await reserve(w, T0);
    clock(T0 + SECOND);
    const take = (activation: typeof ACTIVE) =>
      w.store.takeAvSlot(BUILD, { id: up.id, token: up.token, kind: "video", v1Left: null, activation });
    expect(await take({ ...ACTIVE, binding: false })).toEqual({ status: "inactive" });
    expect(await take({ ...ACTIVE, budget: 0 })).toEqual({ status: "inactive" });
    expect(await take({ ...ACTIVE, build: "another-build" })).toEqual({ status: "inactive" });
    expect(await take(ACTIVE)).toMatchObject({ status: "taken" });
  });

  it("answers busy at MAX_AV_INFLIGHT counting slots (SlotBound)", async () => {
    const w = await avWorld();
    for (let i = 0; i < MAX_AV_INFLIGHT; i++) {
      await staged(w);
    }
    const up = await reserve(w, T0);
    clock(T0 + SECOND);
    expect(await OPS.S1(w, ctx(up))).toEqual({ status: "busy" });
  });

  it("stages v1 to min(t + STAGING_MS, reply_by - T_REPLY) and v2 to t + STAGING_MS", async () => {
    const w = await avWorld();
    const v1 = await staged(w, { v1: true });
    const v2 = await staged(w);
    const [r1] = await sql<{ staged_until: number; reply_by: number }>(
      w.store,
      "SELECT staged_until, reply_by FROM media_processing WHERE media_id = ?",
      v1.id,
    );
    expect(r1).toEqual({ staged_until: T0 + SECOND + V1_LEFT - T_REPLY, reply_by: T0 + SECOND + V1_LEFT });
    const [r2] = await sql<{ staged_until: number; reply_by: number | null }>(
      w.store,
      "SELECT staged_until, reply_by FROM media_processing WHERE media_id = ?",
      v2.id,
    );
    expect(r2).toEqual({ staged_until: T0 + SECOND + STAGING_MS, reply_by: null });
  });

  it("the queue caps deadline_at for v2 at queued_at + V2_PROCESS_MS", async () => {
    const w = await avWorld();
    const c = await queued(w);
    expect((await held(w.store, c.id)).row!.deadline_at).toBe(T0 + 2 * SECOND + V2_PROCESS_MS);
  });
});

// W2: a restore brings back slots, which count until S8, their held_until (not granted) or granted_at + HARD_HOLD_MS.
describe("W2: restored slots", () => {
  it("count until S8 confirms, and a granted one at most until granted_at + HARD_HOLD_MS", async () => {
    const w = await avWorld();
    const a = await started(w);
    const b = await started(w);
    const taken = await bookmark(w.store);
    // Both completed and confirmed after the bookmark; then the restore brings both running rows and slots back.
    clock(T0 + 10 * SECOND);
    for (const up of [a, b]) {
      await w.store.completeAvUpload(BUILD, { id: up.id, token: up.token, startId: up.startId, facts: VIDEO });
      await w.store.releaseAvSlot(BUILD, { id: up.id, teardownId: up.teardownId });
    }
    await restore(w.store, taken, T0 + 20 * SECOND);
    const up = await reserve(w, T0 + 30 * SECOND);
    const take = () =>
      w.store.takeAvSlot(BUILD, { id: up.id, token: up.token, kind: "audio", v1Left: null, activation: ACTIVE });
    expect(await take()).toEqual({ status: "busy" });
    // S8 of one restored run frees its slot.
    clock(T0 + 40 * SECOND);
    expect(await w.store.releaseAvSlot(BUILD, { id: a.id, teardownId: a.teardownId })).toEqual({ status: "released" });
    expect(await take()).toMatchObject({ status: "taken" });
  });

  it("a granted restored slot whose processor never confirms counts until granted_at + HARD_HOLD_MS", async () => {
    const w = await avWorld();
    await started(w);
    await started(w);
    await restore(w.store, await bookmark(w.store), T0 + 20 * SECOND);
    const late = await reserve(w, T0 + 3 * SECOND + HARD_HOLD_MS - 1);
    const takeLate = () =>
      w.store.takeAvSlot(BUILD, { id: late.id, token: late.token, kind: "audio", v1Left: null, activation: ACTIVE });
    expect(await takeLate()).toEqual({ status: "busy" });
    clock(T0 + 3 * SECOND + HARD_HOLD_MS);
    expect(await takeLate()).toMatchObject({ status: "taken" });
  });

  it("a restored slot never granted counts until its held_until", async () => {
    const w = await avWorld();
    const a = await queued(w);
    await queued(w);
    await restore(w.store, await bookmark(w.store), T0 + 20 * SECOND);
    const { slot } = await held(w.store, a.id);
    const late = await reserve(w, slot!.held_until - 1);
    const take = () =>
      w.store.takeAvSlot(BUILD, { id: late.id, token: late.token, kind: "audio", v1Left: null, activation: ACTIVE });
    expect(await take()).toEqual({ status: "busy" });
    clock(slot!.held_until);
    expect(await take()).toMatchObject({ status: "taken" });
  });
});
