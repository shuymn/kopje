import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AV_WRITE_WINDOW_MS, expiredMedia, ORPHAN_GRACE_MS, purgeMedia } from "../src/domain/media";
import {
  allocate,
  AV_GRANT_MS,
  avActivation,
  DISPATCH_BATCH,
  DISPATCH_MS,
  encodeLeft,
  HARD_HOLD_MS,
  INCOMING_ORPHAN_AGE_MS,
  inputMs,
  MAX_AV_INFLIGHT,
  mediaDispatchRound,
  releaseAvSlot,
  remainingOf,
  STAGING_MS,
  T_MIN_ENCODE,
  T_REPLY,
  takeAvSlot,
  V2_PROCESS_MS,
  type AvFacts,
} from "../src/domain/media-processing";
import type { VideoFacts } from "../src/platform/av-bytes";
import { sql } from "./api-helpers";
import { avFixture, syntheticMp4, verifyStream } from "./av-helpers";
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
import { type PlannedStatement, plannedRun, scansOf, staleStatistics } from "./read-helpers";

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

  it("the queue caps deadline_at at the AV write deadline, the stages after the encode taken once (L5)", async () => {
    const w = await avWorld();
    const up = await reserve(w, T0);
    const c = await staged(w, { up, at: T0 + 14 * MINUTE + 59 * SECOND });
    const queuedAt = T0 + 24 * MINUTE + 58 * SECOND;
    clock(queuedAt);
    expect(
      await w.store.queueNormalize(BUILD, { ...c, bytes: 90 * MiB, text: TEXT, activation: ACTIVE }),
    ).toMatchObject({ status: "queued" });
    const deadline = (await held(w.store, c.id)).row!.deadline_at!;
    expect(deadline).toBe(T0 + AV_WRITE_WINDOW_MS);
    expect(allocate("v2", queuedAt, deadline, 90 * MiB).encodeMs).toBe(282_400);
    // No write grant is valid past the AV write deadline: the last is answered a millisecond before it, for that
    // millisecond, and none at it.
    clock(T0 + 25 * MINUTE);
    const start = await w.store.startNormalize(BUILD, { id: c.id, token: c.token, invocation: "inv" });
    if (start.status !== "started") {
      throw new Error(start.status);
    }
    clock(deadline - 1);
    expect(await w.store.confirmAvWrite(BUILD, { id: c.id, startId: start.startId, write: "full" })).toEqual({
      status: "grant",
      ms: 1,
    });
    clock(deadline);
    expect(await w.store.confirmAvWrite(BUILD, { id: c.id, startId: start.startId, write: "full" })).toEqual({
      status: "refused",
    });
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

  // What the processor passes S6 of a file the output verifier accepted (verifyStream's facts).
  const factsOf = (facts: VideoFacts): AvFacts => ({ ...facts, contentType: "video/mp4", preview: null });

  it.each([
    ["a frame rate of 7-digit terms", { samples: 30, size: 64, delta: 1_000_003, timescale: 30_000_000 }],
    ["a bitrate the verifier rounds down", { samples: 30, size: 64, delta: 1001, timescale: 30_000 }],
  ])("completes every file the verifier accepts, with its facts as computed: %s (M2)", async (_name, shape) => {
    const file = syntheticMp4(await avFixture("r1-silent.mp4"), shape);
    const verified = await verifyStream("video/mp4", file.stream(), file.length);
    if (!verified.ok) {
      throw new Error(verified.rule);
    }
    const w = await avWorld();
    const c = await started(w);
    clock(at(4));
    expect(
      await w.store.completeAvUpload(BUILD, {
        id: c.id,
        token: c.token,
        startId: c.startId,
        facts: factsOf(verified.facts as VideoFacts),
      }),
    ).toEqual({ status: "done" });
    const facts = verified.facts as VideoFacts;
    expect(JSON.parse((await stored(w, c.id)).meta)).toMatchObject({
      original: { frame_rate: facts.frameRate, bitrate: facts.bitrate, duration: facts.duration },
    });
  });

  it("refuses facts that are not the verifier's (an audio preview, a video without its geometry)", async () => {
    const w = await avWorld();
    const c = await started(w);
    clock(at(4));
    for (const facts of [
      { ...AUDIO, preview: VIDEO.preview },
      { ...VIDEO, width: undefined },
      { ...VIDEO, contentType: "audio/mpeg" },
      { ...VIDEO, frameRate: "30000/01" },
      { ...VIDEO, bitrate: 1.5 },
    ] as unknown as AvFacts[]) {
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

  it("classifies only keys strictly older than INCOMING_ORPHAN_AGE_MS (L3)", async () => {
    const w = await avWorld();
    const claimed = await claim(w, at(5));
    const keys = [
      { key: "incoming/100000000000000001", uploaded: at(5) - INCOMING_ORPHAN_AGE_MS },
      { key: "incoming/100000000000000002", uploaded: at(5) - INCOMING_ORPHAN_AGE_MS - 1 },
    ];
    expect(await w.store.incomingClassify(BUILD, { claim: claimed.claim, keys })).toEqual({
      status: "ok",
      orphans: ["incoming/100000000000000002"],
    });
  });

  it("a Store not set up gives no claim and classifies nothing, as the sweep (L3)", async () => {
    const w = await avWorld();
    const claimed = await claim(w, at(5));
    await sql(w.store, "DELETE FROM instance_settings WHERE name = 'domain'");
    clock(at(6));
    expect(
      await w.store.incomingClassify(BUILD, { claim: claimed.claim, keys: [old("incoming/100000000000000001")] }),
    ).toEqual({ status: "stale" });
    clock(at(5) + 2 * HOUR);
    expect(await w.store.incomingSweepClaim(BUILD)).toEqual({ status: "not_due" });
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
    await overdue(w, 3 * DISPATCH_BATCH, T0);
    clock(T0 + 5 * MINUTE);
    // The K4 seek fails a batch, and the redispatch seek's batch, overdue too, is failed by K4 before any dispatch.
    const first = await w.store.mediaDispatchRound(BUILD);
    expect(first).toMatchObject({ runs: [], counts: { deadline: 2 * DISPATCH_BATCH }, more: true });
    const second = await w.store.mediaDispatchRound(BUILD);
    expect(second).toMatchObject({ runs: [{ id: c.id }], counts: { deadline: DISPATCH_BATCH } });
    expect(await sql(w.store, "SELECT count(*) AS n FROM media_processing WHERE failure = 'deadline'")).toEqual([
      { n: 3 * DISPATCH_BATCH },
    ]);
  });

  it("never dispatches a restored row, even past a K3 batch that did not reach it (M3)", async () => {
    const w = await avWorld();
    await reserve(w, T0);
    await runInDurableObject(w.store, (_instance, state) => {
      const alice = state.storage.sql
        .exec<{ account_id: string }>("SELECT account_id FROM media_attachments LIMIT 1")
        .one();
      const attachment = (id: string, i: number) =>
        state.storage.sql.exec(
          `INSERT INTO media_attachments (id, account_id, type, url, file_token, processed, gc_at, created_at)
					VALUES (?, ?, 'video', '', ?, 0, ?, ?)`,
          id,
          alice.account_id,
          `restored${String(i).padStart(4, "0")}${"z".repeat(30)}`,
          new Date(T0 + HOUR).toISOString(),
          new Date(T0).toISOString(),
        );
      // DISPATCH_BATCH staging rows reserved before the marker, staged before the pending row: the K3 seek's batch.
      for (let i = 0; i < DISPATCH_BATCH; i++) {
        const id = String(300_000_000_000_000_000n + BigInt(i));
        attachment(id, i);
        state.storage.sql.exec(
          `INSERT INTO media_processing (media_id, state, staged_at, staged_until) VALUES (?, 'staging', ?, ?)`,
          id,
          T0,
          T0 + HOUR,
        );
      }
      // A pending row reserved before the marker, due for redispatch, before its deadline, with its live slot.
      const id = "300000000000001000";
      attachment(id, DISPATCH_BATCH);
      state.storage.sql.exec(
        `INSERT INTO media_processing (media_id, state, staged_at, staged_until, queued_at, dispatched_at, deadline_at,
					input_bytes) VALUES (?, 'pending', ?, ?, ?, ?, ?, 1)`,
        id,
        T0 + SECOND,
        T0 + MINUTE,
        T0 + SECOND,
        T0 + SECOND,
        T0 + 10 * MINUTE,
      );
      state.storage.sql.exec(
        `INSERT INTO media_av_slots (media_id, phase, held_until, teardown_id) VALUES (?, 'processing', ?, 'teardown')`,
        id,
        T0 + 10 * MINUTE,
      );
    });
    await restore(w.store, await bookmark(w.store), T0 + 2 * SECOND);
    clock(T0 + DISPATCH_MS + 3 * SECOND);
    const round = await w.store.mediaDispatchRound(BUILD);
    expect(round).toMatchObject({ runs: [], more: true });
    expect(await held(w.store, "300000000000001000")).toMatchObject({ row: { state: "failed", failure: "restored" } });
  });

  it("counts a restored staging row past its staged_until as K3's, beyond K3's batch too", async () => {
    const w = await avWorld();
    await reserve(w, T0);
    await runInDurableObject(w.store, (_instance, state) => {
      const alice = state.storage.sql
        .exec<{ account_id: string }>("SELECT account_id FROM media_attachments LIMIT 1")
        .one();
      for (let i = 0; i <= DISPATCH_BATCH; i++) {
        const id = String(310_000_000_000_000_000n + BigInt(i));
        state.storage.sql.exec(
          `INSERT INTO media_attachments (id, account_id, type, url, file_token, processed, gc_at, created_at)
					VALUES (?, ?, 'video', '', ?, 0, ?, ?)`,
          id,
          alice.account_id,
          `staging${String(i).padStart(4, "0")}${"q".repeat(30)}`,
          new Date(T0 + HOUR).toISOString(),
          new Date(T0).toISOString(),
        );
        state.storage.sql.exec(
          "INSERT INTO media_processing (media_id, state, staged_at, staged_until) VALUES (?, 'staging', ?, ?)",
          id,
          T0 + i,
          T0 + MINUTE,
        );
      }
    });
    await restore(w.store, await bookmark(w.store), T0 + SECOND);
    clock(T0 + 2 * MINUTE);
    expect(await w.store.mediaDispatchRound(BUILD)).toMatchObject({
      counts: { restored: DISPATCH_BATCH + 1, abandoned: 0 },
    });
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
  // Every range a statement searches holds GROWN rows, more than any LIMIT, so a statement that reads past its LIMIT,
  // or scans, reads more than its bound.
  const GROWN = 3 * DISPATCH_BATCH;
  const NOW_AT = T0 + 2 * HOUR;
  const RESTORED_AT = T0 + HOUR;

  async function grow(w: AvWorld): Promise<void> {
    await runInDurableObject(w.store, (_instance, state) => {
      const exec = (query: string, ...values: SqlStorageValue[]) => state.storage.sql.exec(query, ...values);
      const alice = exec("SELECT account_id FROM media_attachments LIMIT 1").one().account_id as string;
      let n = 0;
      const upload = (created: number) => {
        const id = String(300_000_000_000_000_000n + BigInt(n++));
        exec(
          `INSERT INTO media_attachments (id, account_id, type, url, file_token, processed, gc_at, created_at)
					VALUES (?, ?, 'video', '', ?, 0, ?, ?)`,
          id,
          alice,
          `grown${String(n).padStart(5, "0")}${"z".repeat(30)}`,
          new Date(T0 + 30 * 24 * HOUR).toISOString(),
          new Date(created).toISOString(),
        );
        return id;
      };
      const processing = (id: string, row: Record<string, SqlStorageValue>) => {
        const columns = Object.keys(row);
        exec(
          `INSERT INTO media_processing (media_id, ${columns.join(", ")}) VALUES (?, ${columns.map(() => "?").join(", ")})`,
          id,
          ...Object.values(row),
        );
      };
      const slot = (heldUntil: number, grantedAt: number | null) =>
        exec(
          "INSERT INTO media_av_slots (media_id, phase, held_until, teardown_id, granted_at) VALUES (?, 'processing', ?, 't', ?)",
          String(400_000_000_000_000_000n + BigInt(n++)),
          heldUntil,
          grantedAt,
        );
      for (let i = 0; i < GROWN; i++) {
        // K3's range (reserved and staged before the marker) and the redispatch's (dispatched DISPATCH_MS ago).
        processing(upload(T0), {
          state: "pending",
          staged_at: T0,
          staged_until: T0 + MINUTE,
          queued_at: T0 + i,
          dispatched_at: T0 + i,
          deadline_at: T0 + 10 * HOUR,
          input_bytes: 1,
        });
        // K4's range: running past its deadline, staged after the marker.
        processing(upload(T0 + 90 * MINUTE), {
          state: "running",
          staged_at: T0 + 90 * MINUTE,
          staged_until: T0 + 95 * MINUTE,
          queued_at: T0 + 90 * MINUTE,
          deadline_at: NOW_AT - i - 1,
          start_id: "s",
          started_by: "i",
          input_bytes: 1,
        });
        // The abandoned staging's range.
        processing(upload(T0 + 90 * MINUTE), {
          state: "staging",
          staged_at: T0 + 90 * MINUTE,
          staged_until: NOW_AT - i - 1,
        });
        // The slots: expired, ungranted and granted, and counting, ungranted and granted.
        slot(NOW_AT - i - 1, null);
        slot(NOW_AT, NOW_AT - HARD_HOLD_MS - i - 1);
        slot(NOW_AT + HOUR, null);
        slot(NOW_AT + HOUR, NOW_AT - i);
      }
    });
  }

  it("each statement reads within its LIMIT under stale statistics, every searched range grown past it", async () => {
    const w = await avWorld();
    // A completed upload per capture, so each capture's S8 reaches its DELETE.
    const done = { before: await completed(w), after: await completed(w) };
    // A reservation S1 takes to the slot count: after the marker, within its write window, the probe passed.
    const fresh = { before: await reserve(w, NOW_AT - MINUTE), after: await reserve(w, NOW_AT - MINUTE) };
    const PATTERN = /media_processing|media_av_slots/;
    const answers: unknown[] = [];
    const run = async (phase: "before" | "after") => {
      answers.length = 0;
      const plans: PlannedStatement[] = [];
      for (const [operation, input] of [
        [takeAvSlot, { ...fresh[phase], kind: "video", v1Left: null, activation: ACTIVE, restoredAt: RESTORED_AT }],
        [avActivation, ACTIVE],
        [mediaDispatchRound, { restoredAt: RESTORED_AT }],
        [releaseAvSlot, { id: done[phase].id, teardownId: done[phase].teardownId, restoredAt: RESTORED_AT }],
      ] as const) {
        const planned = await plannedRun(w.h, PATTERN, operation as never, { ...input, now: NOW_AT } as never, true);
        answers.push(planned.result);
        plans.push(...planned.plans);
      }
      return plans;
    };
    const { after } = await staleStatistics(w.h, { capture: run, grow: async () => grow(w) });
    const reads = (marker: RegExp) => {
      const found = after.filter((p) => marker.test(p.query));
      expect(found.length, String(marker)).toBeGreaterThan(0);
      return found;
    };
    const bounded: [RegExp, number][] = [
      // The slot count, from S1 (answering busy) and avActivation: MAX_AV_INFLIGHT + 1 a part.
      [/count\(\*\)[\s\S]*media_av_slots_held[\s\S]*media_av_slots_granted/, 2 * (MAX_AV_INFLIGHT + 1)],
      [/media_processing_restore/, DISPATCH_BATCH],
      [/media_processing_deadline/, DISPATCH_BATCH],
      [/media_processing_staging/, DISPATCH_BATCH],
      [/media_av_slots_held\s+WHERE granted_at IS NULL AND held_until <=/, DISPATCH_BATCH],
      [/media_av_slots_granted\s+WHERE granted_at IS NOT NULL AND granted_at <=/, DISPATCH_BATCH],
      [/media_processing_dispatch/, DISPATCH_BATCH],
      // S8's release and the round's expiry: one slot by its key.
      [/DELETE FROM media_av_slots WHERE media_id = \?/, 1],
    ];
    for (const [marker, limit] of bounded) {
      for (const planned of reads(marker)) {
        expect(scansOf(planned.plan, ["media_processing", "media_av_slots"]), planned.query).toEqual([]);
        expect(planned.rows, planned.query).toBeLessThanOrEqual(limit);
      }
    }
    // The answers show each statement met its grown range: S1 reached the count (busy), each part of it full, and each
    // of the round's batches full (the redispatch's met K3's rows past its batch, failed before any dispatch).
    expect(answers).toMatchObject([
      { status: "busy" },
      { slots: 2 * (MAX_AV_INFLIGHT + 1) },
      {
        runs: [],
        counts: {
          restored: 2 * DISPATCH_BATCH,
          deadline: DISPATCH_BATCH,
          abandoned: DISPATCH_BATCH,
          slots: 2 * DISPATCH_BATCH,
        },
        more: true,
      },
      { status: "released" },
    ]);
    expect((await held(w.store, done.after.id)).slot).toBeNull();
    for (const planned of after) {
      expect(scansOf(planned.plan, ["media_processing", "media_av_slots"]), planned.query).toEqual([]);
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
