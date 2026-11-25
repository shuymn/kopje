import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AV_WRITE_WINDOW_MS, ORPHAN_GRACE_MS } from "../src/domain/media";
import { AV_GRANT_MS, DISPATCH_MS } from "../src/domain/media-processing";
import { mediaDispatchRound } from "../src/jobs/media-jobs";
import { reconcileMedia, sweepMedia } from "../src/mastodon/media";
import { fileKey, originalKey } from "../src/platform/media-files";
import type { UploadProcessor } from "../src/platform/media-transcoder";
import { BUILD } from "./helpers";
import {
  ACTIVE,
  avWorld,
  type AvWorld,
  bookmark,
  clock,
  held,
  MINUTE,
  reserve,
  restore,
  SECOND,
  T0,
} from "./media-processing-helpers";
import { cleared, platformFor, upload } from "./media-unit-helpers";

// Interleavings of an upload's object (UploadUnit) with the owner, the Store and the platform, through the production
// Store and the media bucket (the PR4 plan's W1 and per-write reauthorization, the start rule, K3).

afterEach(() => {
  vi.useRealTimers();
});

const deleteOf = (w: AvWorld, id: string) => async () => {
  await w.store.deleteAvUpload(BUILD, { credential: w.alice, id });
};

async function landed(id: string, token: string) {
  const [original, full, small] = await Promise.all([
    env.MEDIA.head(originalKey(id)),
    env.MEDIA.head(fileKey(token, "full")),
    env.MEDIA.head(fileKey(token, "small")),
  ]);
  return { original: original !== null, full: full !== null, small: small !== null };
}

describe("W1 and the per-write reauthorization", () => {
  it("a grant reply held across DELETE starts at most one write; after the sweep and reconciliation the file answers 404", async () => {
    const w = await avWorld();
    const p = await platformFor(w);
    const up = await upload(w, p);
    // full's grant commits, the owner's DELETE commits, then the grant's reply arrives.
    p.beforeWrite("original", () => {
      p.afterCall("confirmAvWrite", deleteOf(w, up.id));
      return Promise.resolve();
    });
    await p.settle();
    expect(p.writes()).toEqual(["original", "full"]);
    expect(await landed(up.id, up.token)).toEqual({ original: true, full: true, small: false });
    expect((await held(w.store, up.id)).att?.processed).not.toBe(1);
    await cleared(w, p, up.id);
    const served = `/media/${up.token}/full.mp4`;
    expect((await w.h.request(served)).status).toBe(200);
    const deps = { build: () => BUILD, store: () => w.store };
    const sweptAt = T0 + AV_WRITE_WINDOW_MS + MINUTE;
    clock(sweptAt);
    await sweepMedia(env, deps);
    clock(sweptAt + ORPHAN_GRACE_MS);
    await reconcileMedia(env, deps);
    expect((await w.h.request(served)).status).toBe(404);
    expect(await landed(up.id, up.token)).toEqual({ original: false, full: false, small: false });
  });

  it("originals' complete held while DELETE commits: full's complete and small's put never start", async () => {
    const w = await avWorld();
    const p = await platformFor(w);
    const up = await upload(w, p);
    p.beforeWrite("original", deleteOf(w, up.id));
    await p.settle();
    expect(p.writes()).toEqual(["original"]);
    expect(await landed(up.id, up.token)).toEqual({ original: true, full: false, small: false });
    await cleared(w, p, up.id);
  });

  it("a job whose deadline passes during full's complete starts no small put", async () => {
    const w = await avWorld();
    const p = await platformFor(w);
    const up = await upload(w, p);
    p.beforeWrite("full", async () => {
      const deadline = (await held(w.store, up.id)).row?.deadline_at ?? 0;
      clock(deadline + 1);
    });
    await p.settle();
    expect(p.writes()).toEqual(["original", "full"]);
    expect((await held(w.store, up.id)).att?.processed).not.toBe(1);
    await cleared(w, p, up.id);
  });

  it("full's complete outliving its grant leaves small a fresh grant, and the upload completes with its preview", async () => {
    const w = await avWorld();
    const p = await platformFor(w);
    const up = await upload(w, p);
    p.beforeWrite("full", () => {
      clock(Date.now() + AV_GRANT_MS + SECOND);
      return Promise.resolve();
    });
    await p.settle();
    expect(p.writes()).toEqual(["original", "full", "small"]);
    expect(p.storeCalls().filter((call) => call === "confirmAvWrite")).toHaveLength(3);
    expect(await landed(up.id, up.token)).toEqual({ original: true, full: true, small: true });
    expect((await held(w.store, up.id)).att).toMatchObject({ processed: 1 });
    await cleared(w, p, up.id);
  });

  it("a grant that expired on receipt is asked again before its write", async () => {
    const w = await avWorld();
    const p = await platformFor(w);
    const up = await upload(w, p);
    p.afterCall("confirmAvWrite", () => {
      clock(Date.now() + AV_GRANT_MS);
      return Promise.resolve();
    });
    await p.settle();
    expect(p.writes()).toEqual(["original", "full", "small"]);
    expect(p.storeCalls().filter((call) => call === "confirmAvWrite")).toHaveLength(4);
    expect((await held(w.store, up.id)).att).toMatchObject({ processed: 1 });
    await cleared(w, p, up.id);
  });

  it("full's grant reply held across a restore starts that one write and no other; after the sweep the file answers 404", async () => {
    const w = await avWorld();
    const p = await platformFor(w);
    const up = await upload(w, p);
    // Once original has landed, the bookmark is taken before full's grant commits, and the restore to it commits before
    // that grant's reply arrives.
    p.beforeWrite("original", () => {
      p.beforeCall("confirmAvWrite", async () => {
        const taken = await bookmark(w.store);
        p.afterCall("confirmAvWrite", () => restore(w.store, taken, Date.now()));
      });
      return Promise.resolve();
    });
    await p.settle();
    expect(p.writes()).toEqual(["original", "full"]);
    expect(await landed(up.id, up.token)).toEqual({ original: true, full: true, small: false });
    expect((await held(w.store, up.id)).att?.processed).not.toBe(1);
    // The restore failed the job (`restored`); its unpublished attachment is collected from its gc_at.
    const after = await held(w.store, up.id);
    expect(after.row).toMatchObject({ state: "failed", failure: "restored" });
    await cleared(w, p, up.id);
    const served = `/media/${up.token}/full.mp4`;
    expect((await w.h.request(served)).status).toBe(200);
    const deps = { build: () => BUILD, store: () => w.store };
    const sweptAt = Math.max(T0 + AV_WRITE_WINDOW_MS, Date.parse(after.att!.gc_at!)) + MINUTE;
    clock(sweptAt);
    await sweepMedia(env, deps);
    clock(sweptAt + ORPHAN_GRACE_MS);
    await reconcileMedia(env, deps);
    expect((await w.h.request(served)).status).toBe(404);
    expect(await landed(up.id, up.token)).toEqual({ original: false, full: false, small: false });
  });

  it("a replay after R2 completed full writes nothing", async () => {
    const w = await avWorld();
    const p = await platformFor(w);
    const up = await upload(w, p);
    // R2's complete has landed full; the invocation dies before its answer is used.
    p.killNext("completed:full");
    expect(await p.fire()).toBe("killed");
    expect(await env.MEDIA.head(fileKey(up.token, "full"))).not.toBeNull();
    const before = p.writes().length;
    await p.settle();
    expect(p.writes().length).toBe(before);
    expect((await held(w.store, up.id)).att?.processed).not.toBe(1);
    await cleared(w, p, up.id);
  });
});

describe("the start rule", () => {
  it("two alarms and a dispatch's run start one container, and the upload completes once", async () => {
    const w = await avWorld();
    const p = await platformFor(w);
    const up = await upload(w, p);
    // The dispatch round hands the pending upload back once its dispatch is DISPATCH_MS old; its run reaches the object
    // only once the first alarm has reached S4.
    clock(Date.now() + DISPATCH_MS + SECOND);
    const s4 = Promise.withResolvers<void>();
    const handed = Promise.withResolvers<void>();
    p.beforeCall("startNormalize", () => {
      s4.resolve();
      return Promise.resolve();
    });
    const runs: string[] = [];
    const processor = {
      run: async (id: string, token: string, teardownId: string) => {
        runs.push(id);
        handed.resolve();
        await s4.promise;
        await p.unit().run(id, token, teardownId);
      },
    } as unknown as UploadProcessor;
    const round = mediaDispatchRound({ build: BUILD, store: w.store, bucket: env.MEDIA, processor, budget: 10 });
    await handed.promise;
    // The platform runs one alarm at a time: the second delivery runs once the first returns.
    const first = p.unit().alarm();
    await Promise.all([round, first, first.then(() => p.unit().alarm())]);
    await p.settle();
    expect(runs).toEqual([up.id]);
    expect(p.starts()).toBe(1);
    expect(p.writes().filter((name) => name === "full")).toHaveLength(1);
    expect((await held(w.store, up.id)).att).toMatchObject({ processed: 1 });
    await cleared(w, p, up.id);
  });

  it("a restored live run (K3) writes nothing, and no third upload takes a slot before its S8", async () => {
    const w = await avWorld();
    const p = await platformFor(w);
    const up = await upload(w, p);
    p.afterCall("startNormalize", async () => {
      await restore(w.store, await bookmark(w.store), Date.now());
    });
    const take = async () => {
      const next = await reserve(w, Date.now());
      return w.store.takeAvSlot(BUILD, {
        id: next.id,
        token: next.token,
        kind: "video",
        v1Left: null,
        activation: ACTIVE,
      });
    };
    let beforeRelease: { second: string; third: string } | null = null;
    p.beforeCall("releaseAvSlot", async () => {
      // Past the restore marker, so the new reservations are not fenced; the restored run's slot still counts.
      clock(Date.now() + SECOND);
      beforeRelease = { second: (await take()).status, third: (await take()).status };
    });
    await p.settle();
    expect(beforeRelease).toEqual({ second: "taken", third: "busy" });
    expect(p.writes()).toEqual([]);
    expect(await landed(up.id, up.token)).toEqual({ original: false, full: false, small: false });
    await cleared(w, p, up.id);
    // After its S8, the slot is free again.
    expect((await take()).status).toBe("taken");
  });
});
