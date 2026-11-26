import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Db } from "../src/db/sql";
import { profileUploadReady, SWEEP_BATCH } from "../src/domain/media";
import { BACKUP_HOLD_RECHECK_MS, THUMBNAIL_KEEP_MS } from "../src/domain/media-thumbnails";
import { restoreMarkerKey } from "../src/platform/media-files";
import { toStoreUnavailable } from "../src/platform/store-errors";
import { bearer, json, sql } from "./api-helpers";
import { BUILD, holdingMarker, rejectionOf } from "./helpers";
import {
  ACTIVE,
  type AvWorld,
  avWorld,
  bookmark,
  charged,
  clock,
  completed,
  failed,
  fileToken,
  forgetRestore,
  held,
  queued,
  reserve,
  restore,
  SECOND,
  staged,
  started,
  T0,
  TEXT,
  type Up,
  VIDEO,
} from "./media-processing-helpers";
import {
  BUDGETS,
  childRow,
  imageChild,
  objects,
  putObjects,
  sweep,
  THUMB_BLURHASH,
  updateThumbnail,
} from "./media-thumbnail-helpers";

// Custom thumbnails of video and audio uploads in the Store (#1828 PR6-1, domain/media-thumbnails.ts): the link
// predicate on PUT (updateOwnerMedia) and S3 (queueNormalize), the reservation made during an upload (reserveMedia's
// thumbnailFor), what the owner is shown, and the sweep's release and retention. No route sends a thumbnail yet; each
// case calls the Store's own methods, as the routes will.

afterEach(() => {
  vi.useRealTimers();
});

const at = (s: number) => T0 + s * SECOND;
const PREVIEW = (token: string) => `https://kopje.test/media/${token}/small.webp`;
const SMALL = { width: 320, height: 240, size: "320x240", aspect: 320 / 240 };
const DOOMED = "1970-01-01T00:00:00.000Z";

async function attempts(w: AvWorld): Promise<number> {
  const [row] = await sql<{ value: string }>(
    w.store,
    "SELECT value FROM kopje_state WHERE name = ?",
    `media_attempts:${w.h.users.alice.id}`,
  );
  return (JSON.parse(row?.value ?? "[]") as number[]).length;
}

async function mediaCount(w: AvWorld): Promise<number> {
  const [row] = await sql<{ n: number }>(w.store, "SELECT count(*) AS n FROM media_attachments");
  return row?.n ?? 0;
}

function allMedia(w: AvWorld) {
  return sql(w.store, "SELECT * FROM media_attachments ORDER BY id");
}

async function getOwn(w: AvWorld, id: string, who: "alice" | "bob" = "alice") {
  const answer = await w.store.getMedia(BUILD, { credential: who === "alice" ? w.alice : w.bob, id });
  return answer.status === "ok" ? answer.value : answer;
}

// A finished video of alice's with a linked thumbnail.
async function thumbnailed(w: AvWorld): Promise<{ parent: Up; child: Up }> {
  const parent = await completed(w);
  const child = await imageChild(w);
  expect(await updateThumbnail(w, parent, child)).toMatchObject({ status: "ok" });
  return { parent, child };
}

describe("PUT's link (updateOwnerMedia's thumbnail, T3)", () => {
  it("links a finished video's thumbnail, shown as its preview, geometry and blurhash, its own meta kept", async () => {
    const w = await avWorld();
    const parent = await completed(w);
    const child = await imageChild(w);
    const answer = await updateThumbnail(w, parent, child, "alice", { description: "with a cover" });
    expect(answer).toEqual({
      status: "ok",
      media: expect.objectContaining({
        id: parent.id,
        type: "video",
        url: `https://kopje.test/media/${parent.token}/full.mp4`,
        preview_url: PREVIEW(child.token),
        blurhash: THUMB_BLURHASH,
        description: "with a cover",
        meta: {
          original: {
            width: 1280,
            height: 720,
            size: "1280x720",
            aspect: 1280 / 720,
            frame_rate: "30/1",
            duration: 8,
            bitrate: 1_000_000,
          },
          small: SMALL,
          focus: TEXT.focus,
        },
      }),
    });
    expect(await getOwn(w, parent.id)).toEqual(answer);
    // The child is linked and current; the parent's own still stays stored.
    expect(await childRow(w.store, child.id)).toMatchObject({ thumbnail_of: parent.id, gc_at: null });
    const [own] = await sql(w.store, "SELECT preview_url, blurhash FROM media_attachments WHERE id = ?", parent.id);
    expect(own).toEqual({ preview_url: PREVIEW(parent.token), blurhash: VIDEO.preview?.blurhash });
  });

  it("refuses a child that fails the predicate, writing nothing (`gone`)", async () => {
    const w = await avWorld();
    const parent = await completed(w);
    const base = await imageChild(w);
    const bobs = await imageChild(w, "bob");
    const unfinished = await reserve(w, Date.now());
    await sql(w.store, "UPDATE media_attachments SET type = 'image' WHERE id = ?", unfinished.id);
    const scheduled = await imageChild(w);
    await sql(
      w.store,
      "INSERT INTO scheduled_statuses (id, account_id, scheduled_at, params) VALUES (?, ?, ?, '{}')",
      "130000000000000001",
      w.h.users.alice.id,
      "2027-01-01T00:00:00.000Z",
    );
    await sql(
      w.store,
      "UPDATE media_attachments SET scheduled_status_id = '130000000000000001' WHERE id = ?",
      scheduled.id,
    );
    const candidates: [string, Up][] = [
      ["a wrong token", { id: base.id, token: fileToken() }],
      ["another account's", bobs],
      ["an unfinished reservation", unfinished],
      ["a scheduled one", scheduled],
    ];
    for (const [label, candidate] of candidates) {
      const before = await allMedia(w);
      const answer = await updateThumbnail(w, parent, candidate, "alice", { description: "x" });
      expect([label, answer]).toEqual([label, { status: "gone" }]);
      expect(await allMedia(w)).toEqual(before);
    }
    // The guarded branch ran: the same child with its own token links.
    expect(await updateThumbnail(w, parent, base)).toMatchObject({ status: "ok" });
  });

  it("refuses a child linked to another upload, retired or doomed", async () => {
    const w = await avWorld();
    const { parent, child } = await thumbnailed(w);
    // A second video of alice's, still processing.
    const other = await queued(w);
    expect(await updateThumbnail(w, other, child)).toEqual({ status: "gone" });
    const replacement = await imageChild(w);
    expect(await updateThumbnail(w, parent, replacement)).toMatchObject({ status: "ok" });
    // `child` is retired now.
    expect(await updateThumbnail(w, other, child)).toEqual({ status: "gone" });
    const doomed = await imageChild(w);
    await sql(w.store, "UPDATE media_attachments SET gc_at = ? WHERE id = ?", DOOMED, doomed.id);
    expect(await updateThumbnail(w, other, doomed)).toEqual({ status: "gone" });
    const fresh = await imageChild(w);
    expect(await updateThumbnail(w, other, fresh)).toMatchObject({ status: "processing" });
  });

  it("answers a repeat for the current thumbnail as linked, and one a later link retired `gone`", async () => {
    const w = await avWorld();
    const parent = await completed(w);
    const a = await imageChild(w);
    const b = await imageChild(w);
    expect(await updateThumbnail(w, parent, a)).toMatchObject({ status: "ok" });
    const linkedA = await childRow(w.store, a.id);
    expect(await updateThumbnail(w, parent, a)).toMatchObject({
      status: "ok",
      media: { preview_url: PREVIEW(a.token) },
    });
    expect(await childRow(w.store, a.id)).toEqual(linkedA);
    expect(await updateThumbnail(w, parent, b)).toMatchObject({ status: "ok" });
    const before = await allMedia(w);
    expect(await updateThumbnail(w, parent, a)).toEqual({ status: "gone" });
    expect(await allMedia(w)).toEqual(before);
    expect(await childRow(w.store, b.id)).toMatchObject({ thumbnail_of: parent.id, gc_at: null });
  });

  it("answers by the parent's state: blank, not_found, failed, or linked while processing", async () => {
    const w = await avWorld();
    const child = await imageChild(w);
    const image = await imageChild(w);
    // An image upload refuses a thumbnail; null on it is a plain update.
    expect(await updateThumbnail(w, image, child)).toEqual({ status: "blank" });
    expect(await updateThumbnail(w, image, null, "alice", { description: "plain" })).toMatchObject({
      status: "ok",
      media: { description: "plain" },
    });
    // Another account's and a doomed upload are not found.
    const parent = await completed(w);
    expect(await updateThumbnail(w, parent, child, "bob")).toEqual({ status: "not_found" });
    await sql(w.store, "UPDATE media_attachments SET gc_at = ? WHERE id = ?", DOOMED, parent.id);
    expect(await updateThumbnail(w, parent, child)).toEqual({ status: "not_found" });
    // A failed upload.
    const w2 = await avWorld();
    const broken = await failed(w2, "verifier");
    const c2 = await imageChild(w2);
    expect(await updateThumbnail(w2, broken, c2)).toEqual({ status: "failed" });
    expect(await childRow(w2.store, c2.id)).toMatchObject({ thumbnail_of: null });
    // A staging upload is its request's.
    const w3 = await avWorld();
    const stagingUp = await staged(w3);
    const c3 = await imageChild(w3);
    expect(await updateThumbnail(w3, stagingUp, c3)).toEqual({ status: "not_found" });
    // A pending v2 upload before its deadline: linked, shown with the processing mask (D-5).
    const w4 = await avWorld();
    const pending = await queued(w4);
    const c4 = await imageChild(w4);
    expect(await updateThumbnail(w4, pending, c4)).toEqual({
      status: "processing",
      media: expect.objectContaining({
        url: null,
        preview_url: PREVIEW(c4.token),
        blurhash: THUMB_BLURHASH,
        meta: { small: SMALL },
        description: TEXT.description,
      }),
    });
  });

  it("answers a pending v2 upload processing before its deadline_at and failed at it, and a running one", async () => {
    const w = await avWorld();
    const pending = await queued(w);
    const [row] = await sql<{ deadline_at: number }>(
      w.store,
      "SELECT deadline_at FROM media_processing WHERE media_id = ?",
      pending.id,
    );
    clock(row!.deadline_at - 1);
    const child = await imageChild(w);
    expect(await updateThumbnail(w, pending, child)).toMatchObject({ status: "processing" });
    clock(row!.deadline_at);
    const other = await imageChild(w);
    expect(await updateThumbnail(w, pending, other)).toEqual({ status: "failed" });
    expect(await childRow(w.store, other.id)).toMatchObject({ thumbnail_of: null });
    const w2 = await avWorld();
    const running = await started(w2);
    const c2 = await imageChild(w2);
    expect(await updateThumbnail(w2, running, c2)).toMatchObject({ status: "processing" });
  });

  it("reads the restore marker only for a pending or running upload, and refuses on an unknown one", async () => {
    const w = await avWorld();
    const finished = await completed(w);
    const c1 = await imageChild(w);
    const read = await holdingMarker(w.store, () => updateThumbnail(w, finished, c1));
    expect(read).toEqual({ answer: expect.objectContaining({ status: "ok" }), reads: 0 });
    const w2 = await avWorld();
    const pending = await queued(w2);
    const c2 = await imageChild(w2);
    expect((await holdingMarker(w2.store, () => updateThumbnail(w2, pending, c2))).reads).toBe(1);
    await env.MEDIA.put(restoreMarkerKey(w2.store.id.toString()), "not json");
    const c3 = await imageChild(w2);
    expect(toStoreUnavailable(await rejectionOf(updateThumbnail(w2, pending, c3)))?.reason).toBe("transient");
    expect(await childRow(w2.store, c3.id)).toMatchObject({ thumbnail_of: null });
    // A restore after the upload's reservation fails it `restored` (K3): nothing linked.
    await restore(w2.store, await bookmark(w2.store), Date.now());
    const c4 = await imageChild(w2);
    expect(await updateThumbnail(w2, pending, c4)).toEqual({ status: "failed" });
    expect(await childRow(w2.store, c4.id)).toMatchObject({ thumbnail_of: null });
    await forgetRestore(w2.store);
  });
});

describe("one current thumbnail a parent (T4), and removal", () => {
  it("retires the replaced thumbnail: url cleared, preview kept, gc_at THUMBNAIL_KEEP_MS on", async () => {
    const w = await avWorld();
    const { parent, child: a } = await thumbnailed(w);
    const b = await imageChild(w);
    clock(at(100));
    expect(await updateThumbnail(w, parent, b)).toMatchObject({ media: { preview_url: PREVIEW(b.token) } });
    expect(await childRow(w.store, a.id)).toEqual({
      thumbnail_of: parent.id,
      gc_at: new Date(at(100) + THUMBNAIL_KEEP_MS).toISOString(),
      url: "",
      preview_url: PREVIEW(a.token),
      processed: 1,
    });
    expect(THUMBNAIL_KEEP_MS).toBe(31 * 24 * 60 * 60 * 1000);
  });

  it("refuses a second current child inserted directly, and takes it retired", async () => {
    const w = await avWorld();
    const { parent, child } = await thumbnailed(w);
    const [row] = await sql(w.store, "SELECT * FROM media_attachments WHERE id = ?", child.id);
    const copy: Record<string, SqlStorageValue> = { ...row, id: "190000000000000001", file_token: fileToken() };
    const columns = Object.keys(copy);
    const insert = () =>
      sql(
        w.store,
        `INSERT INTO media_attachments (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
        ...columns.map((c) => copy[c] ?? null),
      );
    await expect(insert()).rejects.toThrow(/UNIQUE constraint failed: media_attachments.thumbnail_of/);
    copy.gc_at = "2027-01-01T00:00:00.000Z";
    copy.url = "";
    await insert();
    expect(await childRow(w.store, "190000000000000001")).toMatchObject({ thumbnail_of: parent.id });
  });

  it("removes the current thumbnail by null, showing the parent's own preview, geometry and blurhash (D-7)", async () => {
    const w = await avWorld();
    const { parent, child } = await thumbnailed(w);
    expect(await updateThumbnail(w, parent, null)).toMatchObject({
      status: "ok",
      media: {
        preview_url: PREVIEW(parent.token),
        blurhash: VIDEO.preview?.blurhash,
        meta: { small: { width: 640, height: 360 } },
      },
    });
    expect(await childRow(w.store, child.id)).toMatchObject({ thumbnail_of: parent.id, url: "" });
    // Null with none current changes nothing.
    const before = await allMedia(w);
    expect(await updateThumbnail(w, parent, null)).toMatchObject({ status: "ok" });
    expect(await allMedia(w)).toEqual(before);
  });

  it("applies a description with null on an image upload as a plain update, not blank, retiring nothing", async () => {
    const w = await avWorld();
    const { child } = await thumbnailed(w);
    const image = await imageChild(w);
    const before = await childRow(w.store, child.id);
    expect(await updateThumbnail(w, image, null, "alice", { description: "a photo" })).toMatchObject({
      status: "ok",
      media: { id: image.id, type: "image", description: "a photo" },
    });
    expect(await childRow(w.store, child.id)).toEqual(before);
  });
});

describe("thumbnail rows are never the owner's media (T2, MEDIA-1)", () => {
  it("answers a current or retired child not found to GET, PUT, DELETE, a post's media_ids and a profile image", async () => {
    const w = await avWorld();
    const { parent, child } = await thumbnailed(w);
    const check = async (id: string) => {
      expect(await getOwn(w, id)).toEqual({ status: "not_found" });
      const put = await w.store.updateMedia(BUILD, { credential: w.alice, id, changes: { description: "x" } });
      expect(put).toEqual({ status: "ok", value: { status: "not_found" } });
      expect(await w.store.deleteMedia(BUILD, { credential: w.alice, id })).toEqual({
        status: "ok",
        value: "not_found",
      });
      const posted = await w.h.request(
        "/api/v1/statuses",
        bearer(w.h.users.alice.token, json({ status: "x", media_ids: [id] })),
      );
      expect(posted.status).toBe(422);
      const ready = await runInDurableObject(w.store, (_i, state) =>
        profileUploadReady(new Db(state.storage.sql), w.h.users.alice.id, id, Date.now()),
      );
      expect(ready).toBe(false);
    };
    await check(child.id);
    await updateThumbnail(w, parent, await imageChild(w));
    await check(child.id);
    // The guarded branch ran: an unlinked image upload is the owner's.
    const free = await imageChild(w);
    expect(await getOwn(w, free.id)).toMatchObject({ status: "ok" });
    const ready = await runInDurableObject(w.store, (_i, state) =>
      profileUploadReady(new Db(state.storage.sql), w.h.users.alice.id, free.id, Date.now()),
    );
    expect(ready).toBe(true);
  });
});

describe("reserveMedia's thumbnailFor (T17's Store cases)", () => {
  async function reserveFor(w: AvWorld, parent: { id: string; token: string; stagedAt: number }) {
    const answer = await w.store.reserveMedia(BUILD, {
      credential: w.alice,
      token: fileToken(),
      monthlyTransforms: BUDGETS,
      thumbnailFor: { id: parent.id, token: parent.token, stagedAt: parent.stagedAt },
      now: Date.now(),
    });
    if (answer.status !== "ok") {
      throw new Error(JSON.stringify(answer));
    }
    return answer.value;
  }

  it("reserves an image for a staging upload without an attempt, past the attempt limit too", async () => {
    const w = await avWorld();
    const parent = await staged(w);
    const before = await attempts(w);
    expect(await reserveFor(w, parent)).toMatchObject({ status: "ok" });
    expect(await attempts(w)).toBe(before);
    await sql(
      w.store,
      "UPDATE kopje_state SET value = ? WHERE name = ?",
      JSON.stringify(Array.from({ length: 30 }, () => Date.now())),
      `media_attempts:${w.h.users.alice.id}`,
    );
    expect(await reserveFor(w, parent)).toMatchObject({ status: "ok" });
    const [row] = await sql(w.store, "SELECT type, processed FROM media_attachments ORDER BY id DESC LIMIT 1");
    expect(row).toEqual({ type: "image", processed: 0 });
    // The guarded branch: a plain reservation is refused at the limit.
    const plain = await w.store.reserveMedia(BUILD, {
      credential: w.alice,
      token: fileToken(),
      monthlyTransforms: BUDGETS,
      now: Date.now(),
    });
    expect(plain).toEqual({ status: "ok", value: { status: "rate_limited" } });
  });

  it("answers staging_gone, writing and counting nothing, for a wrong identity, token, account or a late call", async () => {
    const w = await avWorld();
    const parent = await staged(w);
    const [row] = await sql<{ staged_until: number }>(
      w.store,
      "SELECT staged_until FROM media_processing WHERE media_id = ?",
      parent.id,
    );
    const before = { media: await mediaCount(w), attempts: await attempts(w) };
    expect(await reserveFor(w, { ...parent, stagedAt: parent.stagedAt + 1 })).toEqual({ status: "staging_gone" });
    expect(await reserveFor(w, { ...parent, token: fileToken() })).toEqual({ status: "staging_gone" });
    const bobs = await w.store.reserveMedia(BUILD, {
      credential: w.bob,
      token: fileToken(),
      monthlyTransforms: BUDGETS,
      thumbnailFor: { id: parent.id, token: parent.token, stagedAt: parent.stagedAt },
      now: Date.now(),
    });
    expect(bobs).toEqual({ status: "ok", value: { status: "staging_gone" } });
    clock(row!.staged_until);
    expect(await reserveFor(w, parent)).toEqual({ status: "staging_gone" });
    expect({ media: await mediaCount(w), attempts: await attempts(w) }).toEqual(before);
    clock(row!.staged_until - 1);
    expect(await reserveFor(w, parent)).toMatchObject({ status: "ok" });
  });

  it("fences a parent reserved at or before the last restore, reading the marker only on that branch", async () => {
    const w = await avWorld();
    const parent = await staged(w);
    const plain = await holdingMarker<unknown>(w.store, () =>
      w.store.reserveMedia(BUILD, {
        credential: w.alice,
        token: fileToken(),
        monthlyTransforms: BUDGETS,
        now: Date.now(),
      }),
    );
    expect(plain).toEqual({ answer: expect.objectContaining({ status: "ok" }), reads: 0 });
    expect((await holdingMarker(w.store, () => reserveFor(w, parent))).reads).toBe(1);
    const before = await mediaCount(w);
    await env.MEDIA.put(restoreMarkerKey(w.store.id.toString()), "not json");
    expect(toStoreUnavailable(await rejectionOf(reserveFor(w, parent)))?.reason).toBe("transient");
    await env.MEDIA.put(restoreMarkerKey(w.store.id.toString()), JSON.stringify({ at: T0 }));
    expect(await reserveFor(w, parent)).toEqual({ status: "staging_gone" });
    expect(await mediaCount(w)).toBe(before);
    await env.MEDIA.put(restoreMarkerKey(w.store.id.toString()), JSON.stringify({ at: T0 - 1 }));
    expect(await reserveFor(w, parent)).toMatchObject({ status: "ok" });
    await forgetRestore(w.store);
  });
});

describe("S3's thumbnail (POST link)", () => {
  function queueWith(w: AvWorld, up: { id: string; token: string; stagedAt: number }, thumbnail: Up) {
    return w.store.queueNormalize(BUILD, {
      id: up.id,
      token: up.token,
      stagedAt: up.stagedAt,
      bytes: 2_000_000,
      text: TEXT,
      activation: ACTIVE,
      thumbnail: { id: thumbnail.id, token: thumbnail.token },
    });
  }

  it("links the child in S3's transaction, and every queued or settled answer carries it", async () => {
    const w = await avWorld();
    const up = await staged(w);
    const child = await imageChild(w);
    clock(at(2));
    const facts = { preview_url: PREVIEW(child.token), small: SMALL, blurhash: THUMB_BLURHASH };
    const first = await queueWith(w, up, child);
    expect(first).toEqual({ status: "queued", teardownId: expect.any(String), thumbnail: facts });
    expect(await childRow(w.store, child.id)).toMatchObject({ thumbnail_of: up.id, gc_at: null });
    expect(await charged(w.store)).toBe(1);
    // A repeat (the pending branch), then while it runs.
    expect(await queueWith(w, up, child)).toEqual(first);
    clock(at(3));
    await w.store.startNormalize(BUILD, { id: up.id, token: up.token, invocation: "inv-1" });
    expect(await queueWith(w, up, child)).toEqual({ status: "settled", outcome: "running", thumbnail: facts });
    expect(await charged(w.store)).toBe(1);
    expect(await getOwn(w, up.id)).toMatchObject({ status: "processing", media: { preview_url: facts.preview_url } });
  });

  it("refuses a child that fails the predicate before charging, deleting the row and slot (`thumbnail`)", async () => {
    const w = await avWorld();
    const up = await staged(w);
    const child = await imageChild(w);
    clock(at(2));
    expect(await queueWith(w, up, { id: child.id, token: fileToken() })).toEqual({
      status: "refused_cleanup_yours",
      reason: "thumbnail",
    });
    expect(await charged(w.store)).toBe(0);
    expect(await held(w.store, up.id)).toMatchObject({ row: null, slot: null });
    expect(await childRow(w.store, child.id)).toMatchObject({ thumbnail_of: null });
    // The guarded branch: the same child with its token is linked to another upload.
    const up2 = await staged(w);
    clock(at(2));
    expect(await queueWith(w, up2, child)).toMatchObject({ status: "queued" });
  });

  it("leaves a completed upload's thumbnail shown and its own columns the processor's (S6, T8)", async () => {
    const w = await avWorld();
    const up = await staged(w);
    const child = await imageChild(w);
    clock(at(2));
    await queueWith(w, up, child);
    clock(at(3));
    const s = await w.store.startNormalize(BUILD, { id: up.id, token: up.token, invocation: "inv" });
    if (s.status !== "started") {
      throw new Error(s.status);
    }
    clock(at(4));
    const done = await w.store.completeAvUpload(BUILD, {
      id: up.id,
      token: up.token,
      startId: s.startId,
      facts: VIDEO,
    });
    expect(done).toEqual({ status: "done" });
    const [own] = await sql(w.store, "SELECT preview_url, blurhash, meta FROM media_attachments WHERE id = ?", up.id);
    expect(own).toEqual({
      preview_url: PREVIEW(up.token),
      blurhash: VIDEO.preview?.blurhash,
      meta: JSON.stringify({
        original: { width: 1280, height: 720, frame_rate: "30/1", duration: 8, bitrate: 1_000_000 },
        small: { width: 640, height: 360 },
      }),
    });
    expect(await getOwn(w, up.id)).toMatchObject({
      status: "ok",
      media: { preview_url: PREVIEW(child.token), blurhash: THUMB_BLURHASH, meta: { small: SMALL } },
    });
  });
});

describe("presenting a thumbnail (T6, T7)", () => {
  it("shows the parent alone for a child whose preview is the parent's file or not an http(s) URL", async () => {
    const w = await avWorld();
    const { parent, child } = await thumbnailed(w);
    const own = {
      preview_url: PREVIEW(parent.token),
      blurhash: VIDEO.preview?.blurhash,
      meta: expect.objectContaining({ small: expect.objectContaining({ width: 640, height: 360 }) }),
    };
    for (const preview of [
      `https://kopje.test/media/${parent.token}/full.mp4`,
      `HTTPS://KOPJE.TEST/media/${parent.token}/full.mp4#t=1`,
      "javascript:alert(1)",
    ]) {
      await sql(w.store, "UPDATE media_attachments SET preview_url = ? WHERE id = ?", preview, child.id);
      const shown = await getOwn(w, parent.id);
      expect([preview, shown]).toEqual([preview, { status: "ok", media: expect.objectContaining(own) }]);
    }
    // A null blurhash on the child stays null, never the still's.
    await sql(
      w.store,
      "UPDATE media_attachments SET preview_url = ?, blurhash = NULL WHERE id = ?",
      PREVIEW(child.token),
      child.id,
    );
    expect(await getOwn(w, parent.id)).toMatchObject({ media: { preview_url: PREVIEW(child.token), blurhash: null } });
  });

  it("federates a current thumbnail as the Document's icon with its blurhash, and none it would not show (T9)", async () => {
    const w = await avWorld();
    const { parent, child } = await thumbnailed(w);
    const posted = await w.h.request(
      "/api/v1/statuses",
      bearer(w.h.users.alice.token, json({ status: "with a video", media_ids: [parent.id] })),
    );
    expect(posted.status).toBe(200);
    const status = await posted.json<{ id: string; uri: string }>();
    const shown = async () => {
      const note = JSON.parse((await w.store.localNote(BUILD, { uri: status.uri }))!) as {
        attachment: Record<string, unknown>[];
      };
      const answer = await w.h.request(`/api/v1/statuses/${status.id}`, bearer(w.h.users.alice.token));
      const rest = await answer.json<{ media_attachments: { preview_url: string; blurhash: string | null }[] }>();
      return { note: note.attachment[0]!, rest: rest.media_attachments[0]! };
    };
    const linked = await shown();
    expect(linked.rest).toMatchObject({ preview_url: PREVIEW(child.token), blurhash: THUMB_BLURHASH });
    expect(linked.note).toMatchObject({
      type: "Document",
      url: `https://kopje.test/media/${parent.token}/full.mp4`,
      blurhash: THUMB_BLURHASH,
      icon: { type: "Image", mediaType: "image/webp", url: PREVIEW(child.token) },
    });
    // A child whose preview the presenter refuses (the parent's own file, a non-http(s) URL): no icon on the Note, and
    // the parent's own blurhash, as REST shows the parent alone.
    for (const preview of [`https://kopje.test/media/${parent.token}/full.mp4`, "javascript:alert(1)"]) {
      await sql(w.store, "UPDATE media_attachments SET preview_url = ? WHERE id = ?", preview, child.id);
      const refused = await shown();
      expect(refused.rest).toMatchObject({ preview_url: PREVIEW(parent.token), blurhash: VIDEO.preview?.blurhash });
      expect(refused.note).not.toHaveProperty("icon");
      expect(refused.note).toMatchObject({ blurhash: VIDEO.preview?.blurhash });
    }
    // A child with no blurhash: the icon without one, never the still's.
    await sql(
      w.store,
      "UPDATE media_attachments SET preview_url = ?, blurhash = NULL WHERE id = ?",
      PREVIEW(child.token),
      child.id,
    );
    const bare = await shown();
    expect(bare.note).toMatchObject({ icon: { url: PREVIEW(child.token) } });
    expect(bare.note).not.toHaveProperty("blurhash");
  });

  it("keeps main's mask for a processing upload without a thumbnail (no VIDEO_POSTER), and only three facts with one", async () => {
    const w = await avWorld();
    const pending = await queued(w);
    expect(await getOwn(w, pending.id)).toEqual({
      status: "processing",
      media: expect.objectContaining({ url: null, preview_url: null, meta: null, blurhash: null }),
    });
    await updateThumbnail(w, pending, await imageChild(w));
    const shown = await getOwn(w, pending.id);
    expect(shown).toMatchObject({ status: "processing", media: { url: null, blurhash: THUMB_BLURHASH } });
    expect((shown as { media: { meta: unknown } }).media.meta).toEqual({ small: SMALL });
  });
});

describe("mediaUpdateTarget", () => {
  it("answers the type and whether the upload failed, or not_found", async () => {
    const w = await avWorld();
    const broken = await failed(w, "verifier");
    const target = (who: AvWorld["alice"], id: string) => w.store.mediaUpdateTarget(BUILD, { credential: who, id });
    expect(await target(w.alice, broken.id)).toEqual({
      status: "ok",
      value: { status: "found", type: "video", failed: true },
    });
    expect(await target(w.bob, broken.id)).toEqual({ status: "ok", value: { status: "not_found" } });
    const image = await imageChild(w);
    expect(await target(w.alice, image.id)).toEqual({
      status: "ok",
      value: { status: "found", type: "image", failed: false },
    });
  });
});

describe("the sweep and a thumbnail (T5, T5r, T13k)", () => {
  it("dooms the current child with its parent's purge and takes it at the next batch, with no tombstone", async () => {
    const w = await avWorld();
    const { parent, child } = await thumbnailed(w);
    await putObjects(parent);
    await putObjects(child);
    expect(await objects(child)).toEqual({ original: true, full: true, small: true });
    expect(await w.store.deleteMedia(BUILD, { credential: w.alice, id: parent.id })).toEqual({
      status: "ok",
      value: "deleted",
    });
    expect(await sweep(w.store)).toBe(1);
    expect(await childRow(w.store, child.id)).toMatchObject({ thumbnail_of: parent.id, gc_at: DOOMED, url: "" });
    expect(await objects(child)).toMatchObject({ original: true });
    expect(await sweep(w.store)).toBe(1);
    expect(await childRow(w.store, child.id)).toBeUndefined();
    expect(await objects(child)).toEqual({ original: false, full: false, small: false });
    expect(await sql(w.store, "SELECT * FROM media_orphans WHERE media_id = ?", child.id)).toEqual([]);
  });

  it("purges a full batch of parents and dooms every child in that transaction, then takes the children", async () => {
    const w = await avWorld();
    for (let i = 0; i < SWEEP_BATCH; i++) {
      const id = `18${String(i).padStart(16, "0")}`;
      await sql(
        w.store,
        `INSERT INTO media_attachments (id, account_id, type, url, file_token, content_type, processed, gc_at)
					VALUES (?1, ?2, 'video', 'https://kopje.test/media/' || ?3 || '/full.mp4', ?3, 'video/mp4', 1, ?4)`,
        id,
        w.h.users.alice.id,
        fileToken(),
        DOOMED,
      );
      await sql(
        w.store,
        `INSERT INTO media_attachments (id, account_id, type, url, preview_url, file_token, content_type, processed,
					thumbnail_of)
					VALUES (?1, ?2, 'image', 'u', 'p', ?3, 'image/webp', 1, ?4)`,
        `17${String(i).padStart(16, "0")}`,
        w.h.users.alice.id,
        fileToken(),
        id,
      );
    }
    expect(await sweep(w.store)).toBe(SWEEP_BATCH);
    const [doomed] = await sql<{ n: number }>(
      w.store,
      "SELECT count(*) AS n FROM media_attachments WHERE thumbnail_of IS NOT NULL AND gc_at = ? AND url = ''",
      DOOMED,
    );
    expect([doomed?.n, await mediaCount(w)]).toEqual([SWEEP_BATCH, SWEEP_BATCH]);
    expect(await sweep(w.store)).toBe(SWEEP_BATCH);
    expect(await mediaCount(w)).toBe(0);
  });

  it("releases a retired thumbnail's files at the next batch, keeping its original and row, and repeats nothing", async () => {
    const w = await avWorld();
    const { parent, child: a } = await thumbnailed(w);
    await putObjects(a);
    await updateThumbnail(w, parent, await imageChild(w));
    await sweep(w.store);
    expect(await objects(a)).toEqual({ original: true, full: false, small: false });
    expect(await childRow(w.store, a.id)).toMatchObject({ url: "", preview_url: null });
    const before = await allMedia(w);
    await sweep(w.store);
    expect(await allMedia(w)).toEqual(before);
    // A late discard of the retired child keeps it.
    expect(await w.store.abandonMedia(BUILD, { credential: w.alice, id: a.id })).toEqual({
      status: "ok",
      value: "kept",
    });
    expect(await objects(a)).toMatchObject({ original: true });
    expect(await childRow(w.store, a.id)).toMatchObject({ url: "", processed: 1 });
  });

  it("lists SWEEP_BATCH earlier retired thumbnails first, and releases a later one at the next batch", async () => {
    const w = await avWorld();
    for (let i = 0; i < SWEEP_BATCH; i++) {
      await sql(
        w.store,
        `INSERT INTO media_attachments (id, account_id, type, url, preview_url, file_token, content_type, processed, gc_at,
					thumbnail_of)
					VALUES (?1, ?2, 'image', '', 'p', ?3, 'image/webp', 1, '2099-01-01T00:00:00.000Z', '990000000000000000')`,
        `10${String(i).padStart(16, "0")}`,
        w.h.users.alice.id,
        fileToken(),
      );
    }
    const { parent, child: a } = await thumbnailed(w);
    await putObjects(a);
    await updateThumbnail(w, parent, null);
    await sweep(w.store);
    expect(await objects(a)).toEqual({ original: true, full: true, small: true });
    await sweep(w.store);
    expect(await objects(a)).toEqual({ original: true, full: false, small: false });
  });

  it("marks nothing for a row a restore made current again after the list was read", async () => {
    const w = await avWorld();
    const { parent, child: a } = await thumbnailed(w);
    const b = await imageChild(w);
    await updateThumbnail(w, parent, b);
    expect(await w.store.releasedThumbnails(BUILD, {})).toEqual([{ id: a.id, token: a.token }]);
    // The restore: A current again, B named by nothing.
    await sql(w.store, "DELETE FROM media_attachments WHERE id = ?", b.id);
    await sql(
      w.store,
      "UPDATE media_attachments SET url = ?, gc_at = NULL WHERE id = ?",
      `https://kopje.test/media/${a.token}/full.webp`,
      a.id,
    );
    expect(await w.store.forgetThumbnailFiles(BUILD, { ids: [a.id] })).toBe(0);
    expect(await childRow(w.store, a.id)).toMatchObject({ preview_url: PREVIEW(a.token) });
    expect(await getOwn(w, parent.id)).toMatchObject({ media: { preview_url: PREVIEW(a.token) } });
    // The guarded branch: retired, it is marked.
    await updateThumbnail(w, parent, null);
    expect(await w.store.forgetThumbnailFiles(BUILD, { ids: [a.id] })).toBe(1);
  });

  it("keeps a retired thumbnail's original through THUMBNAIL_KEEP_MS - 1 ms and takes it at the first batch past", async () => {
    // The point-in-time window (30 days) and a day more (D26).
    expect(THUMBNAIL_KEEP_MS).toBe(31 * 24 * 60 * 60 * 1000);
    const w = await avWorld();
    const { parent, child: a } = await thumbnailed(w);
    await putObjects(a);
    const retiredAt = Date.now();
    await updateThumbnail(w, parent, null);
    clock(retiredAt + THUMBNAIL_KEEP_MS - 1);
    await sweep(w.store);
    expect(await childRow(w.store, a.id)).toBeDefined();
    expect(await objects(a)).toMatchObject({ original: true });
    clock(retiredAt + THUMBNAIL_KEEP_MS);
    await sweep(w.store);
    expect(await childRow(w.store, a.id)).toBeUndefined();
    expect(await objects(a)).toEqual({ original: false, full: false, small: false });
    expect(await sql(w.store, "SELECT * FROM media_orphans WHERE media_id = ?", a.id)).toEqual([]);
  });

  it("holds a doomed thumbnail the copying backup run holds pending, moving it back, until the run leaves (T12h)", async () => {
    const w = await avWorld();
    const { parent, child } = await thumbnailed(w);
    // A doomed upload behind the child, which the second call takes.
    const other = await imageChild(w);
    await updateThumbnail(w, parent, null);
    const now = Date.now();
    await sql(
      w.store,
      "UPDATE media_attachments SET gc_at = ? WHERE id = ?",
      new Date(now - 2).toISOString(),
      child.id,
    );
    await sql(
      w.store,
      "UPDATE media_attachments SET gc_at = ? WHERE id = ?",
      new Date(now - 1).toISOString(),
      other.id,
    );
    const run = (stage: string) =>
      sql(
        w.store,
        "INSERT INTO kopje_state (name, value) VALUES ('backup', ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value",
        JSON.stringify({ run: { id: "run-1", stage } }),
      );
    await run("media");
    await sql(
      w.store,
      "INSERT INTO backup_media (source, required_run, state) VALUES (?, 'run-1', 'pending')",
      `originals/${child.id}`,
    );
    const expired = async () => (await w.store.expiredMedia(BUILD, { limit: 1 })).map((row) => row.id);
    expect(await expired()).toEqual([]);
    const [moved] = await sql(w.store, "SELECT gc_at FROM media_attachments WHERE id = ?", child.id);
    expect(Date.parse(moved!.gc_at as string)).toBeGreaterThanOrEqual(now + BACKUP_HOLD_RECHECK_MS);
    // The held row left the front of the queue: the next call reaches the upload behind it.
    expect(await expired()).toEqual([other.id]);
    // Once the run has left its copy stage, the child is taken at its due time.
    await run("done");
    await sql(
      w.store,
      "UPDATE media_attachments SET gc_at = ? WHERE id = ?",
      new Date(now - 3).toISOString(),
      child.id,
    );
    expect(await expired()).toEqual([child.id]);
  });
});
