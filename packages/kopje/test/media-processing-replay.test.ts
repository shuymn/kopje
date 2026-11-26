import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { expiredMedia, purgeMedia } from "../src/domain/media";
import { PROBE_CLAIM_MS } from "../src/domain/media-probes";
import { sweptKeys } from "../src/platform/media-files";
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
  held,
  HOUR,
  queued,
  restore,
  SECOND,
  staged,
  started,
  T0,
  VIDEO,
  queue,
} from "./media-processing-helpers";

// Table 1.4 of the PR4 plan, the Store's rows: each RPC's first call committed and its reply was lost (the test drops
// it), and the caller repeats it at a later phase. Each case holds the repeat's answer and what it grants, as the row
// states it.

afterEach(() => {
  vi.useRealTimers();
});

const at = (s: number) => T0 + s * SECOND;

async function sweep(w: AvWorld, now: number): Promise<void> {
  await runInDurableObject(w.store, (_instance, state) => {
    const ids = expiredMedia.run(state.storage.sql, { now, limit: 100 }).map((m) => m.id);
    purgeMedia.run(state.storage.sql, { ids, now });
  });
}

type Replay = [rpc: string, phase: string, run: (w: AvWorld) => Promise<void>];

const REPLAYS: Replay[] = [
  [
    "takeAvSlot",
    "staging: taken, the same staged_at (the staging slot only)",
    async (w) => {
      const c = await staged(w);
      clock(at(5));
      const repeat = await w.store.takeAvSlot(BUILD, {
        id: c.id,
        token: c.token,
        kind: "video",
        v1Left: null,
        activation: ACTIVE,
      });
      expect(repeat).toMatchObject({ status: "taken", stagedAt: c.stagedAt });
      expect(await sql(w.store, "SELECT count(*) AS n FROM media_av_slots")).toEqual([{ n: 1 }]);
    },
  ],
  [
    "takeAvSlot",
    "the row removed meanwhile: gone (S1's staged mark)",
    async (w) => {
      const c = await staged(w);
      await w.store.releaseStaging(BUILD, { id: c.id, token: c.token, stagedAt: c.stagedAt });
      expect(
        await w.store.takeAvSlot(BUILD, { id: c.id, token: c.token, kind: "video", v1Left: null, activation: ACTIVE }),
      ).toEqual({ status: "gone" });
    },
  ],
  [
    "releaseStaging",
    "the row is gone: not_staging, and the input waits for the sweep (W6)",
    async (w) => {
      const c = await staged(w);
      clock(at(5));
      expect(await w.store.releaseStaging(BUILD, { id: c.id, token: c.token, stagedAt: c.stagedAt })).toEqual({
        status: "released",
      });
      expect(await w.store.releaseStaging(BUILD, { id: c.id, token: c.token, stagedAt: c.stagedAt })).toEqual({
        status: "not_staging",
      });
      // The reservation stays to its gc_at, when the sweep deletes its keys, incoming/<id> among them.
      const [row] = await sql<{ gc_at: string }>(w.store, "SELECT gc_at FROM media_attachments WHERE id = ?", c.id);
      expect(sweptKeys(c.id, c.token)).toContain(`incoming/${c.id}`);
      await sweep(w, Date.parse(row!.gc_at));
      expect(await sql(w.store, "SELECT id FROM media_attachments WHERE id = ?", c.id)).toEqual([]);
    },
  ],
  [
    "queueNormalize",
    "pending: queued, the same teardown_id, nothing charged",
    async (w) => {
      const c = await queued(w);
      clock(at(5));
      expect(await queue(w, c, c.stagedAt)).toEqual({ status: "queued", teardownId: c.teardownId, thumbnail: null });
      expect(await charged(w.store)).toBe(1);
    },
  ],
  [
    "queueNormalize",
    "running: settled without a teardown_id",
    async (w) => {
      const c = await started(w);
      clock(at(5));
      expect(await queue(w, c, c.stagedAt)).toEqual({ status: "settled", outcome: "running", thumbnail: null });
      expect(await charged(w.store)).toBe(1);
    },
  ],
  [
    "queueNormalize",
    "H3: completed, after S8 released: settled without a teardown_id",
    async (w) => {
      const c = await completed(w);
      await w.store.releaseAvSlot(BUILD, { id: c.id, teardownId: c.teardownId });
      clock(at(5));
      expect(await queue(w, c, c.stagedAt)).toEqual({ status: "settled", outcome: "completed", thumbnail: null });
      expect(await charged(w.store)).toBe(1);
    },
  ],
  [
    "queueNormalize",
    "H3: failed, after S8 released: settled without a teardown_id",
    async (w) => {
      const c = await failed(w, "verifier");
      await w.store.releaseAvSlot(BUILD, { id: c.id, teardownId: c.teardownId });
      clock(at(5));
      expect(await queue(w, c, c.stagedAt)).toEqual({
        status: "settled",
        outcome: { failed: "verifier" },
        thumbnail: null,
      });
      expect(await charged(w.store)).toBe(1);
    },
  ],
  [
    "queueNormalize",
    "a restored staging row: refused_cleanup_yours(restored), the input the route's",
    async (w) => {
      const c = await staged(w);
      const taken = await bookmark(w.store);
      await queue(w, c, c.stagedAt);
      await restore(w.store, taken, at(5));
      clock(at(6));
      expect(await queue(w, c, c.stagedAt)).toEqual({ status: "refused_cleanup_yours", reason: "restored" });
      expect(await held(w.store, c.id)).toMatchObject({ row: null, slot: null });
    },
  ],
  [
    "queueNormalize",
    "purged: gone",
    async (w) => {
      const c = await queued(w);
      await w.store.deleteAvUpload(BUILD, { credential: w.alice, id: c.id });
      await sweep(w, at(5));
      clock(at(6));
      expect(await queue(w, c, c.stagedAt)).toEqual({ status: "gone" });
    },
  ],
  [
    "queueNormalize",
    "refused before: gone, nothing charged",
    async (w) => {
      const c = await staged(w);
      clock(c.stagedAt + 10 * 60 * SECOND);
      expect(await queue(w, c, c.stagedAt)).toEqual({ status: "refused_cleanup_yours", reason: "staging_deadline" });
      expect(await queue(w, c, c.stagedAt)).toEqual({ status: "gone" });
      expect(await charged(w.store)).toBe(0);
    },
  ],
  [
    "startNormalize",
    "same invocation, running: the same start_id",
    async (w) => {
      const c = await started(w);
      clock(at(5));
      expect(await w.store.startNormalize(BUILD, { id: c.id, token: c.token, invocation: c.invocation })).toMatchObject(
        { status: "started", startId: c.startId },
      );
    },
  ],
  [
    "startNormalize",
    "same invocation, terminal: settled",
    async (w) => {
      const c = await completed(w);
      clock(at(5));
      expect(await w.store.startNormalize(BUILD, { id: c.id, token: c.token, invocation: c.invocation })).toEqual({
        status: "settled",
        state: "completed",
      });
    },
  ],
  [
    "startNormalize",
    "same invocation, purged: gone",
    async (w) => {
      const c = await started(w);
      await w.store.deleteAvUpload(BUILD, { credential: w.alice, id: c.id });
      await sweep(w, at(5));
      clock(at(6));
      expect(await w.store.startNormalize(BUILD, { id: c.id, token: c.token, invocation: c.invocation })).toEqual({
        status: "gone",
      });
    },
  ],
  [
    "startNormalize",
    "another invocation after a start whose reply was lost: settled(running); the job fails at deadline_at",
    async (w) => {
      const c = await started(w);
      clock(at(5));
      expect(await w.store.startNormalize(BUILD, { id: c.id, token: c.token, invocation: "replay" })).toEqual({
        status: "settled",
        state: "running",
      });
      const { row } = await held(w.store, c.id);
      clock(row!.deadline_at!);
      expect(await w.store.startNormalize(BUILD, { id: c.id, token: c.token, invocation: "replay" })).toEqual({
        status: "settled",
        state: { failed: "deadline" },
      });
    },
  ],
  [
    "confirmAvWrite",
    "running before deadline_at: a new grant from the Store's time",
    async (w) => {
      const c = await started(w);
      const { row } = await held(w.store, c.id);
      clock(at(5));
      expect(await w.store.confirmAvWrite(BUILD, { id: c.id, startId: c.startId, write: "full" })).toEqual({
        status: "grant",
        ms: 2000,
      });
      clock(row!.deadline_at! - 500);
      expect(await w.store.confirmAvWrite(BUILD, { id: c.id, startId: c.startId, write: "full" })).toEqual({
        status: "grant",
        ms: 500,
      });
    },
  ],
  [
    "confirmAvWrite",
    "at every later phase and with no row: refused",
    async (w) => {
      const c = await started(w);
      const confirm = () => w.store.confirmAvWrite(BUILD, { id: c.id, startId: c.startId, write: "small" });
      clock(at(5));
      await w.store.completeAvUpload(BUILD, { id: c.id, token: c.token, startId: c.startId, facts: VIDEO });
      expect(await confirm()).toEqual({ status: "refused" });
      await w.store.deleteAvUpload(BUILD, { credential: w.alice, id: c.id });
      expect(await confirm()).toEqual({ status: "refused" });
      await sweep(w, at(6));
      expect(await confirm()).toEqual({ status: "refused" });
    },
  ],
  [
    "completeAvUpload",
    "completed, not doomed, same token: done; doomed: refused",
    async (w) => {
      const c = await completed(w);
      const complete = () =>
        w.store.completeAvUpload(BUILD, { id: c.id, token: c.token, startId: c.startId, facts: VIDEO });
      clock(at(5));
      expect(await complete()).toEqual({ status: "done" });
      await w.store.deleteAvUpload(BUILD, { credential: w.alice, id: c.id });
      expect(await complete()).toEqual({ status: "refused" });
      await sweep(w, at(6));
      expect(await complete()).toEqual({ status: "refused" });
    },
  ],
  [
    "completeAvUpload",
    "failed: refused",
    async (w) => {
      const c = await failed(w, "unavailable");
      clock(at(5));
      expect(
        await w.store.completeAvUpload(BUILD, { id: c.id, token: c.token, startId: c.startId, facts: VIDEO }),
      ).toEqual({ status: "refused" });
    },
  ],
  [
    "failNormalize",
    "failed: the stored cause, deadline included; completed: settled; purged: gone",
    async (w) => {
      const c = await failed(w, "envelope");
      const fail = (id: string, startId: string) => w.store.failNormalize(BUILD, { id, startId, cause: "unavailable" });
      clock(at(5));
      expect(await fail(c.id, c.startId)).toEqual({ status: "recorded", cause: "envelope" });
      await w.store.releaseAvSlot(BUILD, { id: c.id, teardownId: c.teardownId });
      const late = await started(w);
      const { row } = await held(w.store, late.id);
      clock(row!.deadline_at!);
      expect(await fail(late.id, late.startId)).toEqual({ status: "recorded", cause: "deadline" });
      expect(await fail(late.id, late.startId)).toEqual({ status: "recorded", cause: "deadline" });
      await w.store.releaseAvSlot(BUILD, { id: late.id, teardownId: late.teardownId });
      const done = await completed(w);
      clock(at(5));
      expect(await fail(done.id, done.startId)).toEqual({ status: "settled", state: "completed" });
      await w.store.deleteAvUpload(BUILD, { credential: w.alice, id: done.id });
      await sweep(w, at(6));
      expect(await fail(done.id, done.startId)).toEqual({ status: "gone" });
    },
  ],
  [
    "releaseAvSlot",
    "released, whether the first freed the slot or none was left; maintenance under K1",
    async (w) => {
      const c = await completed(w);
      const release = () => w.store.releaseAvSlot(BUILD, { id: c.id, teardownId: c.teardownId });
      clock(at(5));
      expect(await release()).toEqual({ status: "released" });
      expect((await held(w.store, c.id)).slot).toBeNull();
      expect(await release()).toEqual({ status: "released" });
      await gate(w.store, "maintenance", true);
      expect(await release()).toEqual({ status: "maintenance" });
    },
  ],
  [
    "v1Final",
    "the recorded decision: a doom stays; purged: 503",
    async (w) => {
      const c = await started(w, { v1: true });
      const final = () => w.store.v1Final(BUILD, { id: c.id, token: c.token });
      clock(at(5));
      expect(await final()).toEqual({ status: 503 });
      expect(await final()).toEqual({ status: 503 });
      expect(await held(w.store, c.id)).toMatchObject({ row: null, att: { gc_at: "1970-01-01T00:00:00.000Z" } });
      await sweep(w, at(6));
      expect(await final()).toEqual({ status: 503 });
      const done = await completed(w, { v1: true });
      clock(at(5));
      expect(await w.store.v1Final(BUILD, { id: done.id, token: done.token })).toMatchObject({ status: 200 });
      expect(await w.store.v1Final(BUILD, { id: done.id, token: done.token })).toMatchObject({ status: 200 });
    },
  ],
  [
    "DELETE",
    "404 on the repeat",
    async (w) => {
      const c = await started(w);
      clock(at(5));
      expect(await w.store.deleteAvUpload(BUILD, { credential: w.alice, id: c.id })).toEqual({
        status: "ok",
        value: "deleted",
      });
      expect(await w.store.deleteAvUpload(BUILD, { credential: w.alice, id: c.id })).toEqual({
        status: "ok",
        value: "not_found",
      });
    },
  ],
  [
    "incomingSweepClaim",
    "the attempt is recorded: refused within the hour",
    async (w) => {
      clock(at(5));
      expect(await w.store.incomingSweepClaim(BUILD)).toMatchObject({ status: "claimed" });
      clock(at(5) + HOUR - 1);
      expect(await w.store.incomingSweepClaim(BUILD)).toEqual({ status: "not_due" });
      clock(at(5) + HOUR);
      expect(await w.store.incomingSweepClaim(BUILD)).toMatchObject({ status: "claimed" });
    },
  ],
  [
    "incomingClassify",
    "a read under the claim: the same answer; stale for a newer claim",
    async (w) => {
      clock(at(5));
      const first = await w.store.incomingSweepClaim(BUILD);
      if (first.status !== "claimed") {
        throw new Error("not claimed");
      }
      const keys = [{ key: "incoming/100000000000000001", uploaded: at(5) - 25 * HOUR }];
      const classify = (claim: number) => w.store.incomingClassify(BUILD, { claim, keys });
      expect(await classify(first.claim)).toEqual({ status: "ok", orphans: [keys[0]!.key] });
      expect(await classify(first.claim)).toEqual({ status: "ok", orphans: [keys[0]!.key] });
      clock(at(5) + HOUR);
      const second = await w.store.incomingSweepClaim(BUILD);
      expect(second).toMatchObject({ status: "claimed" });
      expect(await classify(first.claim)).toEqual({ status: "stale" });
    },
  ],
  [
    "incomingSwept",
    "the claim is consumed by the first: stale",
    async (w) => {
      clock(at(5));
      const claimed = await w.store.incomingSweepClaim(BUILD);
      if (claimed.status !== "claimed") {
        throw new Error("not claimed");
      }
      expect(await w.store.incomingSwept(BUILD, { claim: claimed.claim, cursor: "c1" })).toEqual({ status: "swept" });
      expect(await w.store.incomingSwept(BUILD, { claim: claimed.claim, cursor: "c2" })).toEqual({ status: "stale" });
      clock(at(5) + HOUR);
      expect(await w.store.incomingSweepClaim(BUILD)).toMatchObject({ status: "claimed", cursor: "c1" });
    },
  ],
  [
    "claimProbe / recordProbeResult",
    "claim: refused under PROBE_CLAIM_MS, and under PROBE_RETRY_MS once it has a result; result: recorded, the same",
    async (w) => {
      clock(at(5));
      const claim = () =>
        w.store.claimMediaProbe(BUILD, { profile: "normalize@standard-4", build: "build-2", due: false });
      const first = await claim();
      if (first.status !== "claimed") {
        throw new Error("not claimed");
      }
      expect(await claim()).toEqual({ status: "cooldown", retryAt: at(5) + PROBE_CLAIM_MS });
      const record = () =>
        w.store.recordMediaProbeResult(BUILD, {
          profile: "normalize@standard-4",
          claim: first.claim,
          outcome: "fail",
          imagesVerified: false,
          imageTag: null,
        });
      expect(await record()).toEqual({ status: "recorded" });
      expect(await claim()).toEqual({ status: "cooldown", retryAt: at(5) + HOUR });
      const [stored] = await sql<{ value: string }>(
        w.store,
        "SELECT value FROM kopje_state WHERE name = 'media_probe:normalize@standard-4'",
      );
      clock(at(6));
      expect(await record()).toEqual({ status: "recorded" });
      expect(
        await sql(w.store, "SELECT value FROM kopje_state WHERE name = 'media_probe:normalize@standard-4'"),
      ).toEqual([stored]);
    },
  ],
];

describe("table 1.4: a repeat after a lost reply", () => {
  it.each(REPLAYS)("%s: %s", async (_rpc, _phase, run) => {
    const w = await avWorld();
    await run(w);
  });
});
