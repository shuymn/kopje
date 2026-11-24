import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { expiredMedia, purgeMedia } from "../src/domain/media";
import { mediaKeys, sweptKeys } from "../src/platform/media-files";
import { sql } from "./api-helpers";
import { BUILD } from "./helpers";
import {
  type AvWorld,
  avWorld,
  bookmark,
  clock,
  completed,
  held,
  queued,
  restore,
  SECOND,
  staged,
  started,
  T0,
  VIDEO,
  queue,
} from "./media-processing-helpers";

// Table 1.1 of the PR4 plan, the Store's side: who may clean up or free each resource in each phase. Only S2's
// `released` and S3's `refused_cleanup_yours` hand the route its input, and only for the staging row of that
// staged_at; a processing slot goes only by S8 with its teardown_id (after completion, a purge, a start whose reply was
// lost) or by time past its bound; the teardown_id authorizes S8 alone.

afterEach(() => {
  vi.useRealTimers();
});

const at = (s: number) => T0 + s * SECOND;

async function sweep(w: AvWorld, now: number): Promise<string[]> {
  return runInDurableObject(w.store, (_instance, state) => {
    const ids = expiredMedia.run(state.storage.sql, { now, limit: 100 }).map((m) => m.id);
    purgeMedia.run(state.storage.sql, { ids, now });
    return ids;
  });
}

type Row = [resource: string, rule: string, run: (w: AvWorld) => Promise<void>];

const OWNERSHIP: Row[] = [
  [
    "incoming/<id>",
    "S2 answers released only for the staging row of that staged_at",
    async (w) => {
      const c = await staged(w);
      clock(at(5));
      expect(await w.store.releaseStaging(BUILD, { id: c.id, token: c.token, stagedAt: c.stagedAt + 1 })).toEqual({
        status: "not_staging",
      });
      expect(await held(w.store, c.id)).toMatchObject({ row: { state: "staging" }, slot: { phase: "staging" } });
      expect(await w.store.releaseStaging(BUILD, { id: c.id, token: "another-token", stagedAt: c.stagedAt })).toEqual({
        status: "not_staging",
      });
      expect(await w.store.releaseStaging(BUILD, { id: c.id, token: c.token, stagedAt: c.stagedAt })).toEqual({
        status: "released",
      });
    },
  ],
  [
    "incoming/<id>",
    "S2 hands nothing back once the row is queued, so the route deletes nothing after its S3",
    async (w) => {
      const c = await queued(w);
      clock(at(5));
      expect(await w.store.releaseStaging(BUILD, { id: c.id, token: c.token, stagedAt: c.stagedAt })).toEqual({
        status: "not_staging",
      });
      expect(await held(w.store, c.id)).toMatchObject({ row: { state: "pending" }, slot: { phase: "processing" } });
    },
  ],
  [
    "incoming/<id>",
    "S3 refuses with cleanup authority only from the staging row of that staged_at",
    async (w) => {
      const c = await staged(w);
      clock(c.stagedAt + 10 * 60 * SECOND);
      expect(await queue(w, c, c.stagedAt + 1)).toEqual({ status: "gone" });
      expect(await held(w.store, c.id)).toMatchObject({ row: { state: "staging" } });
      expect(await queue(w, c, c.stagedAt)).toEqual({ status: "refused_cleanup_yours", reason: "staging_deadline" });
      expect(await held(w.store, c.id)).toMatchObject({ row: null, slot: null });
    },
  ],
  [
    "incoming/<id>",
    "the sweep takes the input with the row (sweptKeys); a failed writer's own cleanup does not (mediaKeys)",
    async (w) => {
      const c = await staged(w);
      expect(sweptKeys(c.id, c.token)[0]).toBe(`incoming/${c.id}`);
      expect(mediaKeys(c.id, c.token)).not.toContain(`incoming/${c.id}`);
    },
  ],
  [
    "slot",
    "S8 frees a completed upload's slot by its teardown_id",
    async (w) => {
      const c = await completed(w);
      clock(at(5));
      expect(await w.store.releaseAvSlot(BUILD, { id: c.id, teardownId: c.teardownId })).toEqual({
        status: "released",
      });
      expect((await held(w.store, c.id)).slot).toBeNull();
    },
  ],
  [
    "slot",
    "the slot outlives a purged upload until S8 frees it by its teardown_id (DELETE and the sweep never free it)",
    async (w) => {
      const c = await started(w);
      clock(at(5));
      await w.store.deleteAvUpload(BUILD, { credential: w.alice, id: c.id });
      expect(await sweep(w, at(6))).toEqual([c.id]);
      expect(await held(w.store, c.id)).toMatchObject({ row: null, att: null, slot: { granted_at: at(3) } });
      expect(await w.store.releaseAvSlot(BUILD, { id: c.id, teardownId: c.teardownId })).toEqual({
        status: "released",
      });
      expect((await held(w.store, c.id)).slot).toBeNull();
    },
  ],
  [
    "slot",
    "a start whose reply was lost: the cleanup's S8 by teardown_id frees the slot",
    async (w) => {
      const c = await queued(w);
      clock(at(3));
      // S4 commits; its invocation never learns the start_id.
      await w.store.startNormalize(BUILD, { id: c.id, token: c.token, invocation: "lost" });
      expect(await w.store.releaseAvSlot(BUILD, { id: c.id, teardownId: c.teardownId })).toEqual({
        status: "released",
      });
      expect((await held(w.store, c.id)).slot).toBeNull();
    },
  ],
  [
    "slot",
    "a wrong teardown_id frees nothing",
    async (w) => {
      const c = await completed(w);
      const other = await queued(w);
      clock(at(5));
      const before = await held(w.store, c.id);
      expect(await w.store.releaseAvSlot(BUILD, { id: c.id, teardownId: other.teardownId })).toEqual({
        status: "released",
      });
      expect(await held(w.store, c.id)).toEqual(before);
    },
  ],
  [
    "slot",
    "K3 keeps a processing slot: a restored running row fails, its granted slot still counts",
    async (w) => {
      const c = await started(w);
      await restore(w.store, await bookmark(w.store), at(5));
      clock(at(6));
      expect(await w.store.mediaDispatchRound(BUILD)).toMatchObject({ counts: { restored: 1, slots: 0 } });
      expect(await held(w.store, c.id)).toMatchObject({
        row: { state: "failed", failure: "restored" },
        slot: { granted_at: at(3) },
      });
    },
  ],
  [
    "slot",
    "a null teardown_id frees nothing: a staging slot, which has none, stays (L2)",
    async (w) => {
      const c = await staged(w);
      clock(at(5));
      const before = await held(w.store, c.id);
      expect(await w.store.releaseAvSlot(BUILD, { id: c.id, teardownId: null as unknown as string })).toEqual({
        status: "released",
      });
      expect(await held(w.store, c.id)).toEqual(before);
    },
  ],
  [
    "teardown_id",
    "grants only S8: offered as a start_id it is refused by S5, S6 and S7",
    async (w) => {
      const c = await started(w);
      clock(at(5));
      expect(await w.store.confirmAvWrite(BUILD, { id: c.id, startId: c.teardownId, write: "original" })).toEqual({
        status: "refused",
      });
      expect(
        await w.store.completeAvUpload(BUILD, { id: c.id, token: c.token, startId: c.teardownId, facts: VIDEO }),
      ).toEqual({ status: "refused" });
      expect(await w.store.failNormalize(BUILD, { id: c.id, startId: c.teardownId, cause: "refused" })).toEqual({
        status: "gone",
      });
      expect(await held(w.store, c.id)).toMatchObject({ row: { state: "running" } });
      // The start_id is accepted where the teardown_id was not, so the refusals above were the identity check's.
      expect(await w.store.confirmAvWrite(BUILD, { id: c.id, startId: c.startId, write: "original" })).toMatchObject({
        status: "grant",
      });
    },
  ],
  [
    "media_processing row",
    "deleted by completion, by DELETE, by a v1 doom and by the attachment's cascade",
    async (w) => {
      const done = await completed(w);
      expect((await held(w.store, done.id)).row).toBeNull();
      await w.store.releaseAvSlot(BUILD, { id: done.id, teardownId: done.teardownId });
      const deleted = await queued(w);
      clock(at(5));
      await w.store.deleteAvUpload(BUILD, { credential: w.alice, id: deleted.id });
      expect((await held(w.store, deleted.id)).row).toBeNull();
      const doomed = await queued(w, { v1: true });
      clock(at(5));
      await w.store.v1Final(BUILD, { id: doomed.id, token: doomed.token });
      expect((await held(w.store, doomed.id)).row).toBeNull();
      await sql(w.store, "DELETE FROM media_av_slots");
      const cascaded = await staged(w);
      await sql(w.store, "DELETE FROM media_attachments WHERE id = ?", cascaded.id);
      expect(await sql(w.store, "SELECT media_id FROM media_processing WHERE media_id = ?", cascaded.id)).toEqual([]);
    },
  ],
  [
    "originals/<id>, files/<token>/*",
    "one write a grant: each S5 is its own grant, none after completion",
    async (w) => {
      const c = await started(w);
      clock(at(5));
      for (const write of ["original", "full", "small"] as const) {
        expect(await w.store.confirmAvWrite(BUILD, { id: c.id, startId: c.startId, write })).toEqual({
          status: "grant",
          ms: 2000,
        });
      }
      await w.store.completeAvUpload(BUILD, { id: c.id, token: c.token, startId: c.startId, facts: VIDEO });
      expect(await w.store.confirmAvWrite(BUILD, { id: c.id, startId: c.startId, write: "small" })).toEqual({
        status: "refused",
      });
    },
  ],
];

describe("table 1.1, the Store's side", () => {
  it.each(OWNERSHIP)("%s: %s", async (_resource, _rule, run) => {
    const w = await avWorld();
    await run(w);
  });
});
