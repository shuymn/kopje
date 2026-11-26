import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DETACHED_GRACE_MS, TRANSFORMS_PER_UPLOAD, UPLOAD_BUDGET } from "../src/domain/media";
import { DISPATCH_MS, PART_BYTES, V1_POLL_MS } from "../src/domain/media-processing";
import { MEDIA_BODY_LIMIT } from "../src/mastodon/media";
import { PREFIX_THUMBNAIL_LIMIT } from "../src/mastodon/media-av";
import { API_BODY_LIMIT } from "../src/mastodon/params";
import { accountMonthlyTransforms, readConfig } from "../src/platform/config";
import { IMAGE_SIZE_LIMIT, imagesCodec } from "../src/platform/images";
import { incomingKey, originalKey, restoreMarkerKey } from "../src/platform/media-files";
import { bearer, sql } from "./api-helpers";
import { PNG_PLAIN } from "./fixtures/images";
import { BUILD, deferred } from "./helpers";
import { bytes } from "./media-helpers";
import { charged, clock, VIDEO, VIDEO_NO_STILL } from "./media-processing-helpers";
import {
  answerOf,
  hookedBucket,
  input,
  mp3,
  mp4,
  multipartBody,
  type Part,
  postMedia,
  postWatched,
  type RouteWorld,
  routeWorld,
  SlowBody,
  videoPart,
} from "./media-route-helpers";
import { sweep } from "./media-thumbnail-helpers";

// Custom thumbnails on POST /api/v1/media and /api/v2/media for video and audio (#1828 PR6 plan, "Multipart", "POST
// timing", "POST link"; T15, T16, T17's route cases): one `thumbnail` part, judged once the file is known to be video
// or audio; the thumbnail made by Images after the staging and before S3, by the staging's end; linked by S3 in its own
// transaction, so every reply and every later reader shows it.

afterEach(() => {
  vi.useRealTimers();
});

const thumbPart = (data: Uint8Array = bytes(PNG_PLAIN)): Part => ({
  name: "thumbnail",
  data,
  filename: "t.png",
  type: "image/png",
});
const imageFile = (): Part => ({ name: "file", data: bytes(PNG_PLAIN), filename: "a.png", type: "image/png" });

const RECEIVE_TOO_LONG = { error: "Media processing took too long to receive. Try again." };
const UNAVAILABLE = { error: "Media processing is unavailable. Try again later." };
const MUST_BE_BLANK = { error: "Validation failed: Thumbnail must be blank" };
const REPEATED = { error: "Validation failed: Thumbnail was sent more than once" };

// The latest video or audio upload of alice's (a thumbnail is a later image row).
async function parentId(w: RouteWorld): Promise<string> {
  const [row] = await sql<{ id: string }>(
    w.store,
    "SELECT id FROM media_attachments WHERE account_id = ? AND type <> 'image' ORDER BY id DESC LIMIT 1",
    w.h.users.alice.id,
  );
  return row?.id ?? "";
}

type Child = {
  id: string;
  file_token: string;
  thumbnail_of: string | null;
  gc_at: string | null;
  processed: number;
  url: string;
};

async function children(w: RouteWorld): Promise<Child[]> {
  return sql<Child>(
    w.store,
    "SELECT id, file_token, thumbnail_of, gc_at, processed, url FROM media_attachments WHERE type = 'image' ORDER BY id",
  );
}

async function attempts(w: RouteWorld): Promise<number> {
  const [row] = await sql<{ value: string }>(
    w.store,
    "SELECT value FROM kopje_state WHERE name = ?",
    `media_attempts:${w.h.users.alice.id}`,
  );
  return (JSON.parse(row?.value ?? "[]") as number[]).length;
}

async function transforms(w: RouteWorld): Promise<string[]> {
  const rows = await sql<{ value: string }>(
    w.store,
    "SELECT value FROM kopje_state WHERE name LIKE 'images_transforms:%' OR name LIKE 'images_account_transforms:%' ORDER BY name",
  );
  return rows.map((r) => r.value);
}

async function tokenOf(w: RouteWorld, id: string): Promise<string> {
  const [row] = await sql<{ file_token: string }>(w.store, "SELECT file_token FROM media_attachments WHERE id = ?", id);
  return row?.file_token ?? "";
}

// S4 and S6 for the upload `id`, as the processor makes them.
async function complete(w: RouteWorld, id: string): Promise<void> {
  const token = await tokenOf(w, id);
  const started = await w.store.startNormalize(BUILD, { id, token, invocation: `inv-${id}` });
  if (started.status !== "started") {
    throw new Error(`not started: ${JSON.stringify(started)}`);
  }
  const done = await w.store.completeAvUpload(BUILD, { id, token, startId: started.startId, facts: VIDEO });
  if (done.status !== "done") {
    throw new Error(`not completed: ${done.status}`);
  }
}

function getOwn(w: RouteWorld, id: string) {
  return w.h.request(`/api/v1/media/${id}`, bearer(w.h.users.alice.token)).then(answerOf);
}

// The thumbnail's three facts in an answer: its preview (by its file token), its geometry and its blurhash.
function showsChild(child: Child | undefined): unknown {
  return expect.objectContaining({
    preview_url: expect.stringContaining(`/media/${child?.file_token ?? "?"}/small.`),
    meta: expect.objectContaining({ small: expect.objectContaining({ width: expect.any(Number) }) }),
    blurhash: expect.any(String),
  });
}

describe("a video or audio upload with a thumbnail (T15)", () => {
  it.each([
    ["before", (file: Part) => [thumbPart(), file]],
    ["after", (file: Part) => [file, thumbPart()]],
  ])("v2: links a thumbnail sent %s the file, shown on the 202 and after completion; one attempt", async (_, parts) => {
    const w = await routeWorld();
    const response = await answerOf(await postMedia(w, multipartBody(parts(videoPart()))));
    const [child] = await children(w);
    const id = await parentId(w);
    expect(child).toMatchObject({ thumbnail_of: id, gc_at: null, processed: 1 });
    expect(response).toEqual({ status: 202, body: showsChild(child) });
    expect(response.body).toMatchObject({ id, url: null });
    expect(await attempts(w)).toBe(1);
    expect(await transforms(w)).toEqual([String(TRANSFORMS_PER_UPLOAD), String(TRANSFORMS_PER_UPLOAD)]);
    expect(await charged(w.store)).toBe(1);
    await complete(w, id);
    expect(await getOwn(w, id)).toEqual({ status: 200, body: showsChild(child) });
  });

  it.each(["before", "after"] as const)("v1: links a thumbnail sent %s the file, shown by S10's 200", async (where) => {
    const w = await routeWorld();
    const polled = w.timers.waitFor(V1_POLL_MS);
    const arrival = Date.now();
    const file = { ...videoPart(mp3()), filename: "a.mp3", type: "audio/mpeg" };
    const response = postMedia(w, multipartBody(where === "before" ? [thumbPart(), file] : [file, thumbPart()]), "v1");
    await polled;
    const id = await parentId(w);
    await complete(w, id);
    await w.advance(arrival + V1_POLL_MS);
    const [child] = await children(w);
    expect(await answerOf(await response)).toEqual({ status: 200, body: showsChild(child) });
  });

  it("takes the 30th POST of the window with a thumbnail: the thumbnail takes no attempt (fork h)", async () => {
    const w = await routeWorld();
    const now = Date.now();
    await sql(
      w.store,
      "INSERT OR REPLACE INTO kopje_state (name, value) VALUES (?, ?)",
      `media_attempts:${w.h.users.alice.id}`,
      JSON.stringify(Array.from({ length: UPLOAD_BUDGET.count - 1 }, () => now)),
    );
    const response = await postMedia(w, multipartBody([videoPart(), thumbPart()]));
    expect(response.status).toBe(202);
    expect(await attempts(w)).toBe(UPLOAD_BUDGET.count);
    expect((await children(w))[0]?.thumbnail_of).toBe(await parentId(w));
  });

  it("refuses a second thumbnail part after the file at its head, its bytes unread (D-9)", async () => {
    const w = await routeWorld();
    const second = thumbPart(new Uint8Array(4 * 1024 * 1024));
    const { body, contentType } = multipartBody([videoPart(), thumbPart(), second]);
    // One chunk carries the second part's head and its first bytes (r3).
    const slow = new SlowBody(body, { chunk: 64 * 1024 });
    const response = await postMedia(w, { body: slow.stream(), contentType });
    expect(await answerOf(response)).toEqual({ status: 422, body: REPEATED });
    expect(slow.pulled).toBeLessThan(body.byteLength - 3 * 1024 * 1024);
    expect(w.gate.calls).toContain("releaseStaging");
    expect(w.codec.calls).toBe(0);
    expect(await children(w)).toEqual([]);
  });

  it.each([
    ["a second thumbnail", [thumbPart(), thumbPart()], REPEATED],
    [
      "text (D-3)",
      [{ name: "thumbnail", data: "x" }],
      { error: "Validation failed: Thumbnail content type is invalid" },
    ],
    [
      "IMAGE_SIZE_LIMIT + 1 bytes",
      [thumbPart(new Uint8Array(IMAGE_SIZE_LIMIT + 1))],
      { error: "Validation failed: Thumbnail file size must be less than 16 MB" },
    ],
    ["no image", [thumbPart(mp4(64))], { error: "Validation failed: Thumbnail content type is invalid" }],
  ])("refuses %s before a video file after the sniff, before any slot, charging nothing", async (_, before, error) => {
    const w = await routeWorld();
    const response = await postMedia(w, multipartBody([...before, videoPart()]));
    expect(await answerOf(response)).toEqual({ status: 422, body: error });
    expect(w.gate.calls).toContain("reserveMedia");
    expect(w.gate.calls).not.toContain("takeAvSlot");
    expect(w.codec.calls).toBe(0);
    expect(await attempts(w)).toBe(1);
    expect(await transforms(w)).toEqual([]);
  });

  it("keeps main's prefix ceiling without a thumbnail file, and refuses past the raised one with one (422)", async () => {
    const w = await routeWorld();
    const text = { name: "other", data: new Uint8Array(MEDIA_BODY_LIMIT).fill(0x61) };
    expect(await answerOf(await postMedia(w, multipartBody([text, videoPart()])))).toEqual({
      status: 422,
      body: { error: "Validation failed: File file size must be less than 16 MB" },
    });
    const over = thumbPart(new Uint8Array(PREFIX_THUMBNAIL_LIMIT));
    expect(await answerOf(await postMedia(w, multipartBody([over, videoPart()])))).toEqual({
      status: 422,
      body: { error: "Validation failed: File file size must be less than 16 MB" },
    });
    expect(w.gate.calls).not.toContain("takeAvSlot");
    expect(PREFIX_THUMBNAIL_LIMIT).toBe(MEDIA_BODY_LIMIT + API_BODY_LIMIT + 64 * 1024);
  });

  it.each(["before", "after"] as const)(
    "takes a thumbnail of exactly IMAGE_SIZE_LIMIT bytes %s the file",
    async (where) => {
      const w = await routeWorld();
      // A PNG padded to the limit, which this Images stand-in reads as the PNG itself.
      const padded = new Uint8Array(IMAGE_SIZE_LIMIT);
      padded.set(bytes(PNG_PLAIN));
      asPlainPng(w);
      const parts = where === "before" ? [thumbPart(padded), videoPart()] : [videoPart(), thumbPart(padded)];
      expect((await postMedia(w, multipartBody(parts))).status).toBe(202);
      expect((await children(w))[0]?.thumbnail_of).toBe(await parentId(w));
    },
  );

  // The flush order and the allocation it bounds ("Multipart"): the file's last part is sent before the thumbnail
  // after it is read, so no part buffer is held beside the thumbnail.
  it("sends the file's last part before reading a thumbnail after it (88 MiB - 1, then IMAGE_SIZE_LIMIT)", async () => {
    let slow: SlowBody | null = null;
    const pulledAt: number[] = [];
    const { bucket } = hookedBucket({ onPart: () => pulledAt.push(slow?.pulled ?? 0) });
    const w = await routeWorld({ bucket });
    asPlainPng(w);
    const fileSize = 11 * PART_BYTES - 1;
    const padded = new Uint8Array(IMAGE_SIZE_LIMIT);
    padded.set(bytes(PNG_PLAIN));
    const { body, contentType } = multipartBody([videoPart(mp4(fileSize)), thumbPart(padded)]);
    // 1 MiB chunks: the chunk that ends the file carries the delimiter and the thumbnail's head and first bytes.
    const chunk = 1024 * 1024;
    slow = new SlowBody(body, { chunk });
    const response = await postMedia(w, { body: slow.stream(), contentType });
    expect(response.status).toBe(202);
    expect(pulledAt).toHaveLength(11);
    // The last part went while at most two reads past the file's end were pulled, never the thumbnail's 16 MiB.
    expect(pulledAt.at(-1)).toBeLessThanOrEqual(fileSize + 1024 + 2 * chunk);
    expect((await input(await parentId(w)))?.byteLength).toBe(fileSize);
  }, 300_000);

  it.each([
    ["Images' quota", 9422, 503, { error: "Media processing is unavailable. Try again later." }],
    ["an input Images refuses", 9412, 422, { error: "Validation failed: Thumbnail content type is invalid" }],
  ])(
    "ends the staging on %s while making it: S2, input deleted, nothing queued or charged",
    async (_, code, status, error) => {
      const w = await routeWorld();
      w.codec.failInfo = code;
      const response = await postMedia(w, multipartBody([videoPart(), thumbPart()]));
      expect(await answerOf(response)).toEqual({ status, body: error });
      const id = await parentId(w);
      expect(w.gate.calls).toContain("releaseStaging");
      expect(w.gate.calls).not.toContain("queueNormalize");
      expect(await input(id)).toBeNull();
      expect(await charged(w.store)).toBe(0);
      // The thumbnail's reservation is abandoned (due at once), its charge kept.
      expect(await children(w)).toEqual([expect.objectContaining({ thumbnail_of: null, processed: 1, url: "" })]);
    },
  );

  it("answers a thumbnail reservation refused for a parent a restore fenced as the staging exit (staging_gone)", async () => {
    const w = await routeWorld();
    const held = w.gate.hold("reserveMedia", "before", 1);
    const reached = w.gate.reached("reserveMedia");
    const response = postMedia(w, multipartBody([videoPart(), thumbPart()]));
    await reached;
    await env.MEDIA.put(restoreMarkerKey(w.store.id.toString()), JSON.stringify({ at: Date.now() }));
    held.resolve();
    expect(await answerOf(await response)).toEqual({ status: 503, body: RECEIVE_TOO_LONG });
    expect(await children(w)).toEqual([]);
    expect(await attempts(w)).toBe(1);
    expect(await transforms(w)).toEqual([]);
    expect(w.gate.calls).not.toContain("queueNormalize");
  });

  it.each([
    [
      "thumbnail",
      async (w: RouteWorld, child: Child) => {
        await sql(w.store, "UPDATE media_attachments SET url = '' WHERE id = ?", child.id);
      },
      UNAVAILABLE,
    ],
    [
      "staging_deadline",
      async (w: RouteWorld) => {
        const [row] = await sql<{ staged_until: number }>(w.store, "SELECT staged_until FROM media_processing");
        clock(row?.staged_until ?? 0);
      },
      RECEIVE_TOO_LONG,
    ],
  ] as const)(
    "discards the thumbnail S3 refuses (%s): input deleted, the thumbnail swept, no unit charged",
    async (_, meanwhile, error) => {
      const w = await routeWorld();
      const s3 = w.gate.hold("queueNormalize");
      const reached = w.gate.reached("queueNormalize");
      const response = postMedia(w, multipartBody([videoPart(), thumbPart()]));
      await reached;
      const id = await parentId(w);
      const [child] = await children(w);
      expect(child).toMatchObject({ processed: 1, thumbnail_of: null });
      await meanwhile(w, child as Child);
      s3.resolve();
      expect(await answerOf(await response)).toEqual({ status: 503, body: error });
      expect(await input(id)).toBeNull();
      expect(await charged(w.store)).toBe(0);
      expect(await children(w)).toEqual([]);
      expect(await env.MEDIA.head(originalKey(child?.id ?? ""))).toBeNull();
    },
  );

  // The atomicity witnesses: S3 commits the link, so no reply is needed for the upload to keep its thumbnail.
  it("keeps the thumbnail of an upload whose S3 replies are both lost, dispatched by S12 and completed", async () => {
    const w = await routeWorld();
    w.gate.drops.set("queueNormalize", 2);
    expect((await postMedia(w, multipartBody([videoPart(), thumbPart()]))).status).toBe(503);
    const id = await parentId(w);
    const [child] = await children(w);
    expect(child).toMatchObject({ thumbnail_of: id, gc_at: null });
    clock(Date.now() + DISPATCH_MS);
    expect(await w.store.mediaDispatchRound(BUILD)).toMatchObject({ runs: [{ id }] });
    await complete(w, id);
    expect(await getOwn(w, id)).toEqual({ status: 200, body: showsChild(child) });
  });

  it("keeps the thumbnail of an upload whose route dies after S3: completed with it, swept with it at its grace", async () => {
    const w = await routeWorld();
    // S3 commits and its reply never reaches the route, which makes no further call (W-T4).
    w.gate.hold("queueNormalize", "after");
    const committed = w.gate.reached("queueNormalize");
    void postMedia(w, multipartBody([videoPart(), thumbPart()]));
    await committed;
    const id = await parentId(w);
    const [child] = await children(w);
    expect(child).toMatchObject({ thumbnail_of: id, gc_at: null });
    clock(Date.now() + DISPATCH_MS);
    expect(await w.store.mediaDispatchRound(BUILD)).toMatchObject({ runs: [{ id }] });
    await complete(w, id);
    expect(await getOwn(w, id)).toEqual({ status: 200, body: showsChild(child) });
    const [parent] = await sql<{ gc_at: string }>(w.store, "SELECT gc_at FROM media_attachments WHERE id = ?", id);
    const grace = Date.parse(parent?.gc_at ?? "");
    expect(grace).toBe(Date.now() + DETACHED_GRACE_MS);
    clock(grace - 1);
    expect(await sweep(w.store)).toBe(0);
    clock(grace);
    await sweep(w.store);
    await sweep(w.store);
    expect(await sql(w.store, "SELECT id FROM media_attachments WHERE id IN (?, ?)", id, child?.id ?? "")).toEqual([]);
    expect(await env.MEDIA.head(originalKey(child?.id ?? ""))).toBeNull();
  });

  // T17's route case: the thumbnail takes the account's last three transformations, so the video's still finds no room
  // (chargeAvPoster `spent`) and the video completes with its poster, the thumbnail its preview.
  it("makes the thumbnail with three transformations left; the video completes with its poster (T17)", async () => {
    const w = await routeWorld();
    const config = readConfig(env);
    if (!config.ok) {
      throw new Error("config");
    }
    const limit = accountMonthlyTransforms(config.config);
    const account = `images_account_transforms:${new Date().toISOString().slice(0, 7)}:${w.h.users.alice.id}`;
    await sql(
      w.store,
      "INSERT OR REPLACE INTO kopje_state (name, value) VALUES (?, ?)",
      account,
      String(limit - TRANSFORMS_PER_UPLOAD),
    );
    const response = await answerOf(await postMedia(w, multipartBody([videoPart(), thumbPart()])));
    const id = await parentId(w);
    const [child] = await children(w);
    expect(child).toMatchObject({ thumbnail_of: id, processed: 1 });
    expect(response).toEqual({ status: 202, body: showsChild(child) });
    const [spent] = await sql<{ value: string }>(w.store, "SELECT value FROM kopje_state WHERE name = ?", account);
    expect(spent?.value).toBe(String(limit));
    clock(Date.now() + DISPATCH_MS);
    expect(await w.store.mediaDispatchRound(BUILD)).toMatchObject({ runs: [{ id }] });
    const token = await tokenOf(w, id);
    const started = await w.store.startNormalize(BUILD, { id, token, invocation: `inv-${id}` });
    if (started.status !== "started") {
      throw new Error(`not started: ${started.status}`);
    }
    const monthlyTransforms = { instance: config.config.IMAGES_MONTHLY_TRANSFORMS, account: limit };
    expect(await w.store.chargeAvPoster(BUILD, { id, startId: started.startId, monthlyTransforms })).toEqual({
      status: "spent",
    });
    expect(
      await w.store.completeAvUpload(BUILD, { id, token, startId: started.startId, facts: VIDEO_NO_STILL }),
    ).toEqual({ status: "done" });
    const shown = await getOwn(w, id);
    expect(shown).toEqual({ status: 200, body: showsChild(child) });
    expect(shown.body).toMatchObject({ type: "video", url: expect.stringContaining("/media/") });
  });

  it("answers a repeat that finds S3 committed (pending) with the thumbnail, linked once", async () => {
    const w = await routeWorld();
    w.gate.drops.set("queueNormalize", 1);
    const response = await answerOf(await postMedia(w, multipartBody([videoPart(), thumbPart()])));
    const [child] = await children(w);
    expect(w.gate.calls.filter((c) => c === "queueNormalize")).toHaveLength(2);
    expect(response).toEqual({ status: 202, body: showsChild(child) });
    expect(await children(w)).toEqual([expect.objectContaining({ thumbnail_of: await parentId(w), gc_at: null })]);
  });

  it("answers a settled repeat whose GET fails with the thumbnail S3's reply showed", async () => {
    const w = await routeWorld();
    w.gate.drops.set("queueNormalize", 1);
    const repeat = w.gate.hold("queueNormalize", "before", 1);
    const reached = w.gate.reached("queueNormalize");
    const response = postMedia(w, multipartBody([videoPart(), thumbPart()]));
    await reached;
    const id = await parentId(w);
    const token = await tokenOf(w, id);
    expect((await w.store.startNormalize(BUILD, { id, token, invocation: "inv" })).status).toBe("started");
    w.gate.fails.set("getMedia", 1);
    repeat.resolve();
    const [child] = await children(w);
    expect(await answerOf(await response)).toEqual({ status: 202, body: showsChild(child) });
    expect(w.gate.calls).toContain("getMedia");
  });

  it("answers v1 with the thumbnail when S6 completes before S3's reply reaches the route", async () => {
    const w = await routeWorld();
    const s3 = w.gate.hold("queueNormalize", "after");
    const reached = w.gate.reached("queueNormalize");
    const arrival = Date.now();
    const response = postMedia(w, multipartBody([videoPart(), thumbPart()]), "v1");
    await reached;
    const id = await parentId(w);
    await complete(w, id);
    const polled = w.timers.waitFor(V1_POLL_MS);
    s3.resolve();
    await Promise.race([polled, response]);
    await w.advance(arrival + V1_POLL_MS);
    const [child] = await children(w);
    expect(await answerOf(await response)).toEqual({ status: 200, body: showsChild(child) });
  });
});

describe("the making by the staging's end (POST timing)", () => {
  // Images calls that never settle, each resolving `reached` as it starts: the inspection's info(), the full encode's
  // output() or the read of its output, or the preview's (small) output().
  const stalls = {
    info: (w: RouteWorld, reached: () => void) => {
      w.codec.info = () => {
        reached();
        return new Promise(() => {});
      };
    },
    output: (w: RouteWorld, reached: () => void) => {
      stallingEncode(w, "output", reached);
    },
    read: (w: RouteWorld, reached: () => void) => {
      stallingEncode(w, "read", reached);
    },
    small: (w: RouteWorld, reached: () => void) => {
      stallingEncode(w, "output", reached, true);
    },
  };

  it.each(
    (["info", "output", "read", "small"] as const).flatMap((stall) =>
      (["v2", "v1"] as const).map((v) => [stall, v] as const),
    ),
  )(
    "gives up a stalled Images call (%s, %s) at the end: 503, S2 and the thumbnail abandoned, no write",
    async (stall, version) => {
      const w = await routeWorld();
      const reachedImages = deferred();
      stalls[stall](w, () => reachedImages.resolve());
      const post = postWatched(w, multipartBody([videoPart(), thumbPart()]), version);
      await reachedImages.promise;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const [child] = await children(w);
      await w.advance(Math.min(...w.timers.pending));
      expect(await answerOf(await post.answered)).toEqual({ status: 503, body: RECEIVE_TOO_LONG });
      await post.done;
      expect(w.gate.calls).toContain("releaseStaging");
      expect(w.gate.calls).not.toContain("completeMedia");
      expect(w.gate.calls).not.toContain("queueNormalize");
      // Given up by the guard, so the making settled and its reservation was abandoned, the Images call still pending.
      expect(await children(w)).toEqual([
        expect.objectContaining({ id: child?.id, processed: 1, url: "", thumbnail_of: null }),
      ]);
      expect(await env.MEDIA.head(originalKey(child?.id ?? ""))).toBeNull();
      expect(await input(await parentId(w))).toBeNull();
    },
  );

  it("answers at the end while the thumbnail's R2 put is pending, and discards it only once the put settles", async () => {
    const put = deferred();
    const putReached = deferred();
    const bucket = new Proxy(env.MEDIA, {
      get(target, method: string) {
        const value = Reflect.get(target, method) as unknown;
        if (method === "put") {
          return async (key: string, data: Uint8Array, options?: R2PutOptions) => {
            if (key.startsWith("originals/")) {
              putReached.resolve();
              await put.promise;
            }
            return target.put(key, data, options);
          };
        }
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const w = await routeWorld({ bucket });
    const post = postWatched(w, multipartBody([videoPart(), thumbPart()]));
    await putReached.promise;
    const [child] = await children(w);
    await w.advance(Math.min(...w.timers.pending));
    expect(await answerOf(await post.answered)).toEqual({ status: 503, body: RECEIVE_TOO_LONG });
    await vi.waitFor(() => expect(w.gate.calls).toContain("releaseStaging"));
    // The thumbnail is not discarded while its own write is pending.
    expect(await children(w)).toEqual([expect.objectContaining({ id: child?.id, processed: 0 })]);
    put.resolve();
    await post.done;
    expect(w.gate.calls).not.toContain("completeMedia");
    expect(await children(w)).toEqual([expect.objectContaining({ id: child?.id, processed: 1, url: "" })]);
    expect(await env.MEDIA.head(originalKey(child?.id ?? ""))).toBeNull();
    expect(await env.MEDIA.head(incomingKey(await parentId(w)))).toBeNull();
  });
});

describe("an image upload with a thumbnail on the active route (T16)", () => {
  it.each([
    ["a thumbnail file before", () => [thumbPart(), imageFile()], 422],
    ["a thumbnail file after", () => [imageFile(), thumbPart()], 422],
    ["text before", () => [{ name: "thumbnail", data: "x" }, imageFile()], 422],
    ["two thumbnail files before", () => [thumbPart(), thumbPart(), imageFile()], 422],
    ["a file then empty text before", () => [thumbPart(), { name: "thumbnail", data: "" }, imageFile()], 200],
  ])("answers %s as the image path does", async (_, parts, status) => {
    const w = await routeWorld();
    const response = await answerOf(await postMedia(w, multipartBody(parts())));
    if (status === 422) {
      expect(response).toEqual({ status, body: MUST_BE_BLANK });
    } else {
      expect(response.status).toBe(200);
    }
    expect(w.gate.calls).not.toContain("takeAvSlot");
  });
});

// The test codec reads any input that begins with PNG_PLAIN as PNG_PLAIN (a thumbnail padded to a size).
function asPlainPng(w: RouteWorld): void {
  const plain = bytes(PNG_PLAIN);
  const strip = (b: Uint8Array) => (b.byteLength > plain.byteLength && b[0] === plain[0] ? plain : b);
  const info = w.codec.info.bind(w.codec);
  const encode = w.codec.encode.bind(w.codec);
  w.codec.info = (b) => info(strip(b));
  w.codec.encode = (b, o) => encode(strip(b), o);
}

// Each encode (only the preview's, a still, with `still`) through a binding whose output() never answers, or whose
// output's read never yields; `reached` once such an output() is asked for.
function stallingEncode(w: RouteWorld, where: "output" | "read", reached: () => void, still = false): void {
  const never = <T>() => new Promise<T>(() => {});
  const binding = {
    info: () => never(),
    input: () => {
      const transformer = {
        transform: () => transformer,
        output: () => {
          reached();
          return where === "output"
            ? never()
            : Promise.resolve({
                image: () => new ReadableStream<Uint8Array>({ pull: () => never() }),
                contentType: () => "image/png",
              });
        },
      };
      return transformer;
    },
  } as unknown as ImagesBinding;
  const stalled = imagesCodec(binding);
  const encode = w.codec.encode.bind(w.codec);
  w.codec.encode = (b, o) => (!still || o.still === true ? stalled.encode(b, o) : encode(b, o));
}
