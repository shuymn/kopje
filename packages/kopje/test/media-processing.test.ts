import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AV_WRITE_WINDOW_MS, expiredMedia, ORPHAN_GRACE_MS, purgeMedia } from "../src/domain/media";
import {
  allocate,
  AV_GRANT_MS,
  DISPATCH_BATCH,
  DISPATCH_MS,
  encodeLeft,
  INCOMING_ORPHAN_AGE_MS,
  inputMs,
  mediaDispatchRound,
  releaseAvSlot,
  remainingOf,
  STAGING_MS,
  T_MIN_ENCODE,
  T_REPLY,
  takeAvSlot,
  V2_PROCESS_MS,
} from "../src/domain/media-processing";
import { sql } from "./api-helpers";
import { BUILD, rejectionOf } from "./helpers";
import {
  ACTIVE,
  AUDIO,
  type AvWorld,
  avWorld,
  bookmark,
  clock,
  completed,
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
  TEXT,
  VIDEO,
} from "./media-processing-helpers";
import { dumpViaRpc } from "./ops-helpers";
import { plannedRun, scansOf, staleStatistics } from "./read-helpers";

// The media processor's Store operations beyond the precedence table (domain/media-processing.ts): the allocation
// (P8), the completion's own facts and the text kept (P7, P9), the incoming/ orphan pass across a restore (W4), a
// restore between the sweep's selection and its deletion (W13), the dispatch round's paging, and the plans of the new
// statements at saturation.

afterEach(() => {
  vi.useRealTimers();
});

const MiB = 1024 * 1024;
// T_FIXED of a v2 input of at most 25 MiB: dispatch, start, input, probe, still, preview and commit.
const FIXED = 17 * SECOND;
const at = (s: number) => T0 + s * SECOND;

describe("the allocation (P8)", () => {
  it("v2: the processing's end less the fixed parts leaves the encode (19.6 s for 90 MiB)", () => {
    const a = allocate("v2", T0, T0 + V2_PROCESS_MS, 90 * MiB);
    expect(inputMs(90 * MiB)).toBe(3600);
    expect(a.deadline).toBe(T0 + V2_PROCESS_MS);
    expect(a.fixedMs).toBe(19_600);
    expect(a.encodeMs).toBe(V2_PROCESS_MS - 19_600);
    expect(a.cuts.commit).toBe(a.deadline);
    expect(a.cuts.encode).toBe(a.deadline - 10 * SECOND);
  });

  it("v1: the reply is a fixed part, and the deadline is reply_by less T_REPLY", () => {
    const a = allocate("v1", T0, T0 + 90 * SECOND, 90 * MiB);
    expect(a.deadline).toBe(T0 + 90 * SECOND - T_REPLY);
    expect(a.fixedMs).toBe(19_600 + T_REPLY);
    expect(a.encodeMs).toBe(90 * SECOND - 21_600);
    expect(allocate("v2", T0, T0 + V2_PROCESS_MS, 2 * MiB).fixedMs).toBe(FIXED);
  });

  it("an input under 25 MiB takes the least input time", () => {
    expect(inputMs(1)).toBe(SECOND);
    expect(inputMs(25 * MiB)).toBe(SECOND);
    expect(inputMs(25 * MiB + 1)).toBe(1001);
  });

  it("soft cuts: a stage that begins late takes from the encode, never from a later stage's cut", () => {
    const a = allocate("v2", T0, T0 + V2_PROCESS_MS, 2 * MiB);
    const cuts = { ...a.cuts };
    // The start begins 30 s late: the encode left shrinks by 30 s, the cuts after it stay.
    expect(encodeLeft(a, T0 + 2 * SECOND, "start")).toBe(a.encodeMs);
    expect(encodeLeft(a, T0 + 32 * SECOND, "start")).toBe(a.encodeMs - 30 * SECOND);
    // Recomputed after the probe: the probe that took 10 s more than T_PROBE costs the encode those 10 s.
    expect(encodeLeft(a, T0 + 2 * SECOND + 3 * SECOND + SECOND + 11 * SECOND, "encode")).toBe(a.encodeMs - 10 * SECOND);
    expect(a.cuts).toEqual(cuts);
  });

  it("a grant answered at the cut less 1 ms and received 2 s later is expired", async () => {
    const w = await avWorld();
    const c = await started(w);
    const { row } = await held(w.store, c.id);
    const sentAt = row!.deadline_at! - 1;
    clock(sentAt);
    const grant = await w.store.confirmAvWrite(BUILD, { id: c.id, startId: c.startId, write: "full" });
    expect(grant).toEqual({ status: "grant", ms: 1 });
    expect(remainingOf(sentAt, 1, sentAt + 2 * SECOND)).toBeLessThan(0);
    expect(remainingOf(sentAt, AV_GRANT_MS, sentAt + 2 * SECOND)).toBe(0);
  });

  it("v1Left across a slow ingress: the staging and the work end before the route's reply, and too little left is refused", async () => {
    const w = await avWorld();
    const take = async (v1Left: number) => {
      const up = await reserve(w, T0);
      clock(at(1));
      const taken = await w.store.takeAvSlot(BUILD, {
        id: up.id,
        token: up.token,
        kind: "video",
        v1Left,
        activation: ACTIVE,
      });
      if (taken.status !== "taken") {
        throw new Error(taken.status);
      }
      return { ...up, stagedAt: taken.stagedAt, stagingMs: taken.stagingMs };
    };
    // Sixty of ninety seconds went on the body before the sniff: 30 s left.
    const slow = await take(30 * SECOND);
    expect(slow.stagingMs).toBe(30 * SECOND - T_REPLY);
    clock(at(5));
    expect(
      await w.store.queueNormalize(BUILD, { ...slow, bytes: 2 * MiB, text: TEXT, activation: ACTIVE }),
    ).toMatchObject({ status: "queued" });
    expect((await held(w.store, slow.id)).row!.deadline_at).toBe(at(1) + 30 * SECOND - T_REPLY);
    // 24 s left: at the queue 4 s later the encode would have T_MIN_ENCODE less 1 s.
    const slower = await take(24 * SECOND);
    clock(at(1) + 24 * SECOND - T_REPLY - FIXED - T_MIN_ENCODE + 1);
    expect(await w.store.queueNormalize(BUILD, { ...slower, bytes: 2 * MiB, text: TEXT, activation: ACTIVE })).toEqual({
      status: "refused_cleanup_yours",
      reason: "time",
    });
  });

  it("v1's staging ends at reply_by less T_REPLY or at STAGING_MS, whichever comes first", async () => {
    const w = await avWorld();
    const long = await reserve(w, T0);
    clock(at(1));
    expect(
      await w.store.takeAvSlot(BUILD, { ...long, kind: "video", v1Left: STAGING_MS + T_REPLY + 1, activation: ACTIVE }),
    ).toMatchObject({ status: "taken", stagingMs: STAGING_MS });
    const short = await reserve(w, T0);
    clock(at(1));
    expect(
      await w.store.takeAvSlot(BUILD, {
        ...short,
        kind: "video",
        v1Left: STAGING_MS + T_REPLY - 1,
        activation: ACTIVE,
      }),
    ).toMatchObject({ status: "taken", stagingMs: STAGING_MS - 1 });
  });

  it("the queue caps deadline_at at the AV write deadline less the stages after the encode", async () => {
    const w = await avWorld();
    const up = await reserve(w, T0);
    // Staged late in the reservation's write window: queued_at + V2_PROCESS_MS passes the cap.
    const c = await staged(w, { up, at: T0 + 14 * MINUTE });
    clock(T0 + 23 * MINUTE);
    expect(await w.store.queueNormalize(BUILD, { ...c, bytes: 2 * MiB, text: TEXT, activation: ACTIVE })).toMatchObject(
      { status: "queued" },
    );
    expect((await held(w.store, c.id)).row!.deadline_at).toBe(T0 + 30 * MINUTE - 10 * SECOND);
  });
});

describe("the completion's own facts and the text (P7, P9)", () => {
  type Stored = {
    type: string;
    content_type: string;
    url: string;
    preview_url: string | null;
    meta: string;
    blurhash: string | null;
    description: string;
    focus_x: number;
    focus_y: number;
    focus_given: number;
  };
  const stored = async (w: AvWorld, id: string) =>
    (
      await sql<Stored>(
        w.store,
        `SELECT type, content_type, url, preview_url, meta, blurhash, description, focus_x, focus_y, focus_given
				FROM media_attachments WHERE id = ?`,
        id,
      )
    )[0]!;

  it("S3 stores the text on the attachment", async () => {
    const w = await avWorld();
    const c = await queued(w);
    expect(await stored(w, c.id)).toMatchObject({
      description: TEXT.description,
      focus_x: 0.25,
      focus_y: -0.5,
      focus_given: 1,
    });
  });

  it("a description written between the queue and the completion survives S6", async () => {
    const w = await avWorld();
    const c = await started(w);
    // As the owner's PUT of an unfinished upload writes it (PR4-3): the attachment's own columns.
    await sql(w.store, "UPDATE media_attachments SET description = 'changed', focus_given = 0 WHERE id = ?", c.id);
    clock(at(4));
    await w.store.completeAvUpload(BUILD, { id: c.id, token: c.token, startId: c.startId, facts: VIDEO });
    expect(await stored(w, c.id)).toMatchObject({ description: "changed", focus_given: 0 });
  });

  it("a video with a preview: its facts, url full.mp4 and preview_url small.webp", async () => {
    const w = await avWorld();
    const c = await completed(w);
    const row = await stored(w, c.id);
    expect(row).toMatchObject({ type: "video", content_type: "video/mp4", blurhash: VIDEO.preview!.blurhash });
    expect(row.url).toMatch(new RegExp(`/media/${c.token}/full\\.mp4$`));
    expect(row.preview_url).toMatch(new RegExp(`/media/${c.token}/small\\.webp$`));
    expect(JSON.parse(row.meta)).toEqual({
      original: { width: 1280, height: 720, frame_rate: "30/1", duration: 8, bitrate: 1_000_000 },
      small: { width: 640, height: 360 },
    });
  });

  it("a video without a preview and an audio upload: preview_url and blurhash NULL", async () => {
    const w = await avWorld();
    const poster = await completed(w, { facts: { ...VIDEO, preview: null } });
    expect(await stored(w, poster.id)).toMatchObject({ preview_url: null, blurhash: null });
    expect(JSON.parse((await stored(w, poster.id)).meta)).not.toHaveProperty("small");
    await w.store.releaseAvSlot(BUILD, { id: poster.id, teardownId: poster.teardownId });
    const audio = await completed(w, { facts: AUDIO });
    const row = await stored(w, audio.id);
    expect(row).toMatchObject({ type: "audio", content_type: "audio/mpeg", preview_url: null, blurhash: null });
    expect(row.url).toMatch(/\/full\.mp3$/);
    expect(JSON.parse(row.meta)).toEqual({ original: { duration: 10, bitrate: 256_000 } });
  });

  it("refuses facts that are not the verifier's (an audio preview, a video without its geometry)", async () => {
    const w = await avWorld();
    const c = await started(w);
    clock(at(4));
    for (const facts of [
      { ...AUDIO, preview: VIDEO.preview },
      { ...VIDEO, width: undefined },
      { ...VIDEO, contentType: "audio/mpeg" as const },
    ]) {
      expect(
        await rejectionOf(w.store.completeAvUpload(BUILD, { id: c.id, token: c.token, startId: c.startId, facts })),
      ).toBeInstanceOf(Error);
    }
    expect((await held(w.store, c.id)).row).toMatchObject({ state: "running" });
  });
});

describe("the incoming/ orphan pass (W4)", () => {
  const old = (key: string) => ({ key, uploaded: at(0) - INCOMING_ORPHAN_AGE_MS });

  async function claim(w: AvWorld, time: number): Promise<{ claim: number; cursor: string }> {
    clock(time);
    const claimed = await w.store.incomingSweepClaim(BUILD);
    if (claimed.status !== "claimed") {
      throw new Error(claimed.status);
    }
    return claimed;
  }

  it("classifies the unheld keys older than INCOMING_ORPHAN_AGE_MS, probe copies included", async () => {
    const w = await avWorld();
    const c = await staged(w);
    const claimed = await claim(w, at(5));
    const keys = [
      old(`incoming/${c.id}`),
      old("incoming/100000000000000001"),
      { key: "incoming/100000000000000002", uploaded: at(5) - INCOMING_ORPHAN_AGE_MS + 1 },
      old(`incoming/probe-${"a".repeat(32)}`),
      old("incoming/not-an-id"),
      old("originals/100000000000000001"),
    ];
    expect(await w.store.incomingClassify(BUILD, { claim: claimed.claim, keys })).toEqual({
      status: "ok",
      orphans: ["incoming/100000000000000001", `incoming/probe-${"a".repeat(32)}`],
    });
  });

  it("a restore with a claim held: the claim's classification and checkpoint are refused", async () => {
    const w = await avWorld();
    const claimed = await claim(w, at(5));
    const taken = await bookmark(w.store);
    await restore(w.store, taken, at(6));
    clock(at(7));
    expect(
      await w.store.incomingClassify(BUILD, { claim: claimed.claim, keys: [old("incoming/100000000000000001")] }),
    ).toEqual({ status: "stale" });
    expect(await w.store.incomingSwept(BUILD, { claim: claimed.claim, cursor: "c1" })).toEqual({ status: "stale" });
  });

  it("two rounds from one cursor delete idempotently, and the first round's checkpoint is refused", async () => {
    const w = await avWorld();
    const first = await claim(w, at(5));
    const keys = [old("incoming/100000000000000001")];
    expect(await w.store.incomingClassify(BUILD, { claim: first.claim, keys })).toMatchObject({
      orphans: [keys[0]!.key],
    });
    // The first round dies between its delete and its checkpoint; the next round lists the same page from the same
    // cursor and classifies the same keys.
    const second = await claim(w, at(5) + HOUR);
    expect(second.cursor).toBe(first.cursor);
    expect(await w.store.incomingClassify(BUILD, { claim: second.claim, keys })).toMatchObject({
      orphans: [keys[0]!.key],
    });
    expect(await w.store.incomingSwept(BUILD, { claim: first.claim, cursor: "late" })).toEqual({ status: "stale" });
    expect(await w.store.incomingSwept(BUILD, { claim: second.claim, cursor: "c1" })).toEqual({ status: "swept" });
    expect((await claim(w, at(5) + 2 * HOUR)).cursor).toBe("c1");
  });

  it("an empty page checkpoints", async () => {
    const w = await avWorld();
    const claimed = await claim(w, at(5));
    expect(await w.store.incomingClassify(BUILD, { claim: claimed.claim, keys: [] })).toEqual({
      status: "ok",
      orphans: [],
    });
    expect(await w.store.incomingSwept(BUILD, { claim: claimed.claim, cursor: "next" })).toEqual({ status: "swept" });
    expect((await claim(w, at(5) + HOUR)).cursor).toBe("next");
  });

  it("W4: a key classified unheld that a restore makes held again belongs to a fenced row", async () => {
    const w = await avWorld();
    const c = await queued(w);
    const taken = await bookmark(w.store);
    // The row is gone (as the sweep left it), so its input is classified unheld.
    await sql(w.store, "DELETE FROM media_attachments WHERE id = ?", c.id);
    const claimed = await claim(w, at(5));
    expect(
      await w.store.incomingClassify(BUILD, { claim: claimed.claim, keys: [old(`incoming/${c.id}`)] }),
    ).toMatchObject({ orphans: [`incoming/${c.id}`] });
    // A restore brings the row back before the delete: the row is fenced (K3) and never starts.
    await restore(w.store, taken, at(6));
    clock(at(7));
    expect(await w.store.startNormalize(BUILD, { id: c.id, token: c.token, invocation: "after" })).toEqual({
      status: "settled",
      state: { failed: "restored" },
    });
    expect(await w.store.incomingSwept(BUILD, { claim: claimed.claim, cursor: "c1" })).toEqual({ status: "stale" });
  });
});

describe("W13: a restore between the sweep's selection and its deletion", () => {
  it("brings the completed row back live, purgeMedia skips it, and it is left without its files", async () => {
    const w = await avWorld();
    const c = await completed(w);
    const taken = await bookmark(w.store);
    clock(at(10));
    await w.store.deleteAvUpload(BUILD, { credential: w.alice, id: c.id });
    // The sweep selects the doomed row; the restore lands before its R2 deletion and purgeMedia.
    const selected = await runInDurableObject(w.store, (_instance, state) =>
      expiredMedia.run(state.storage.sql, { now: at(11), limit: 100 }).map((m) => m.id),
    );
    expect(selected).toEqual([c.id]);
    await restore(w.store, taken, at(12));
    // The Worker deletes the selected row's keys (not modelled here: the row names them) and then purges.
    const purged = await runInDurableObject(w.store, (_instance, state) =>
      purgeMedia.run(state.storage.sql, { ids: selected, now: at(13) }),
    );
    expect(purged).toBe(0);
    expect(await held(w.store, c.id)).toMatchObject({
      att: { processed: 1, gc_at: expect.not.stringMatching(/^1970/) },
    });
    expect(await sql(w.store, "SELECT file_token FROM media_orphans")).toEqual([]);
  });
});

describe("the AV write window (MEDIA-2)", () => {
  it("a purged video upload's tombstone keeps its keys' deletion authority to the AV write deadline + ORPHAN_GRACE_MS", async () => {
    const w = await avWorld();
    const c = await started(w);
    clock(T0 + 5 * SECOND);
    await w.store.deleteAvUpload(BUILD, { credential: w.alice, id: c.id });
    await runInDurableObject(w.store, (_instance, state) => {
      purgeMedia.run(state.storage.sql, { ids: [c.id], now: T0 + 6 * SECOND });
    });
    // The reservation was made at T0: an image's tombstone would be due at T0 + WRITE_WINDOW_MS + ORPHAN_GRACE_MS.
    expect(await sql(w.store, "SELECT media_id, delete_after FROM media_orphans")).toEqual([
      { media_id: c.id, delete_after: new Date(T0 + AV_WRITE_WINDOW_MS + ORPHAN_GRACE_MS).toISOString() },
    ]);
  });
});

describe("the dispatch round", () => {
  // Pending rows past their deadline_at, written as the queue leaves them, dispatched before `dispatchedAt`. Each
  // keeps a processing slot that has not expired, so only the deadline keeps the round from dispatching it again.
  async function overdue(w: AvWorld, count: number, dispatchedAt: number): Promise<void> {
    await runInDurableObject(w.store, (_instance, state) => {
      const alice = state.storage.sql
        .exec<{ account_id: string }>("SELECT account_id FROM media_attachments LIMIT 1")
        .one();
      for (let i = 0; i < count; i++) {
        const id = String(200_000_000_000_000_000n + BigInt(i));
        state.storage.sql.exec(
          `INSERT INTO media_attachments (id, account_id, type, url, file_token, processed, gc_at, created_at)
					VALUES (?, ?, 'video', '', ?, 0, ?, ?)`,
          id,
          alice.account_id,
          `overdue${String(i).padStart(4, "0")}${"y".repeat(30)}`,
          new Date(T0 + HOUR).toISOString(),
          new Date(T0).toISOString(),
        );
        state.storage.sql.exec(
          `INSERT INTO media_processing (media_id, state, staged_at, staged_until, queued_at, dispatched_at, deadline_at,
						input_bytes) VALUES (?, 'pending', ?, ?, ?, ?, ?, 1)`,
          id,
          T0,
          T0 + MINUTE,
          T0,
          dispatchedAt - i,
          T0 + MINUTE,
        );
        state.storage.sql.exec(
          `INSERT INTO media_av_slots (media_id, phase, held_until, teardown_id) VALUES (?, 'processing', ?, ?)`,
          id,
          T0 + HOUR,
          `teardown-${i}`,
        );
      }
    });
  }

  it("reaches a pending row behind more than DISPATCH_BATCH overdue rows by a later round", async () => {
    const w = await avWorld();
    const c = await queued(w);
    await overdue(w, 2 * DISPATCH_BATCH, T0);
    clock(T0 + 5 * MINUTE);
    const first = await w.store.mediaDispatchRound(BUILD);
    expect(first).toMatchObject({ runs: [], counts: { deadline: DISPATCH_BATCH }, more: true });
    const second = await w.store.mediaDispatchRound(BUILD);
    expect(second).toMatchObject({ runs: [{ id: c.id }], counts: { deadline: DISPATCH_BATCH } });
    expect(await sql(w.store, "SELECT count(*) AS n FROM media_processing WHERE failure = 'deadline'")).toEqual([
      { n: 2 * DISPATCH_BATCH },
    ]);
  });

  it("runs nothing in maintenance", async () => {
    const w = await avWorld();
    await queued(w);
    await sql(w.store, "INSERT INTO kopje_state (name, value) VALUES ('maintenance', ?)", JSON.stringify({ at: T0 }));
    clock(T0 + DISPATCH_MS + 3 * SECOND);
    expect(await w.store.mediaDispatchRound(BUILD)).toEqual({ status: "maintenance" });
  });
});

describe("the plans of the new statements at saturation", () => {
  it("seek their partial indexes under stale statistics: slot count, dispatch, K3 and K4 seeks, teardown release", async () => {
    const w = await avWorld();
    const c = await completed(w);
    const PATTERN = /media_processing|media_av_slots/;
    const run = async () => {
      const plans = [];
      for (const [operation, input] of [
        [takeAvSlot, { id: "100000000000000009", token: "t", kind: "video", v1Left: null, activation: ACTIVE }],
        [mediaDispatchRound, {}],
        [releaseAvSlot, { id: c.id, teardownId: c.teardownId }],
      ] as const) {
        const planned = await plannedRun(
          w.h,
          PATTERN,
          operation as never,
          { ...input, now: T0 + 2 * HOUR, restoredAt: T0 + HOUR } as never,
          true,
        );
        plans.push(...planned.plans);
      }
      return plans;
    };
    const { after } = await staleStatistics(w.h, {
      capture: async () => run(),
      grow: async () => {
        await runInDurableObject(w.store, (_instance, state) => {
          const alice = state.storage.sql
            .exec<{ account_id: string }>("SELECT account_id FROM media_attachments LIMIT 1")
            .one();
          for (let i = 0; i < 3000; i++) {
            const id = String(300_000_000_000_000_000n + BigInt(i));
            state.storage.sql.exec(
              `INSERT INTO media_attachments (id, account_id, type, url, file_token, processed, gc_at, created_at)
							VALUES (?, ?, 'video', '', ?, 0, ?, ?)`,
              id,
              alice.account_id,
              `grown${String(i).padStart(5, "0")}${"z".repeat(30)}`,
              new Date(T0 + 30 * 24 * HOUR).toISOString(),
              new Date(T0 + 3 * HOUR).toISOString(),
            );
            const state_ = ["failed", "running", "staging"][i % 3]!;
            state.storage.sql.exec(
              `INSERT INTO media_processing (media_id, state, staged_at, staged_until, queued_at, deadline_at, start_id,
								started_by, input_bytes, failure) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              id,
              state_,
              T0 + 3 * HOUR,
              T0 + 4 * HOUR,
              state_ === "staging" ? null : T0 + 3 * HOUR,
              state_ === "staging" ? null : T0 + 4 * HOUR,
              state_ === "running" ? "s" : null,
              state_ === "running" ? "i" : null,
              state_ === "staging" ? null : 1,
              state_ === "failed" ? "verifier" : null,
            );
            state.storage.sql.exec(
              "INSERT INTO media_av_slots (media_id, phase, held_until, teardown_id, granted_at) VALUES (?, 'processing', ?, 't', ?)",
              id,
              T0 + 4 * HOUR,
              i % 2 === 0 ? T0 + 3 * HOUR : null,
            );
          }
        });
      },
    });
    expect(after.length).toBeGreaterThan(8);
    for (const planned of after) {
      expect(scansOf(planned.plan, ["media_processing", "media_av_slots"]), planned.query).toEqual([]);
      // Each seek reads at most its cap (and the slot count MAX_AV_INFLIGHT + 1 each part), not the grown tables.
      expect(planned.rows, planned.query).toBeLessThanOrEqual(2 * (DISPATCH_BATCH + 1));
    }
  });
});

describe("the dump (DATA-3)", () => {
  it("leaves out the processing rows, the slots and the probe records", async () => {
    const w = await avWorld();
    await queued(w);
    await staged(w);
    expect(await sql(w.store, "SELECT count(*) AS n FROM media_processing")).toEqual([{ n: 2 }]);
    vi.useRealTimers();
    const { text } = await dumpViaRpc(w.store);
    expect(text).toMatch(/INSERT INTO "media_attachments"/);
    // The header names the applied migrations, 0121 among them; no table and no kopje_state row of these is dumped.
    expect(text).not.toMatch(/"media_processing"|"media_av_slots"|media_probe|media_upload_jobs/);
    expect(text).toMatch(/"name":"0121_media_processing"/);
  });
});
