import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TRANSFORMS_PER_UPLOAD } from "../src/domain/media";
import { THUMBNAIL_KEEP_MS } from "../src/domain/media-thumbnails";
import { fileKey, originalKey } from "../src/platform/media-files";
import { MAX_MEDIA_DESCRIPTION_LENGTH } from "../src/platform/stored-bounds";
import { sql } from "./api-helpers";
import { PNG_PLAIN, WEBP_PLAIN } from "./fixtures/images";
import { BUILD } from "./helpers";
import { bytes, TestCodec } from "./media-helpers";
import { AUDIO, avWorld, completed, failed, queued, type Up, VIDEO } from "./media-processing-helpers";
import {
  answerOf,
  mp4,
  multipartBody,
  type Part,
  postMedia,
  type RouteWorld,
  routeWorld,
  SlowBody,
} from "./media-route-helpers";

// PUT and PATCH /api/v1/media/:id with a video's or audio file's custom thumbnail (#1828 PR6 plan, "PUT order", T14,
// T17, T18, T19): the token before a multipart body, the body's bounds, the lookup, the description and the thumbnail
// judged before anything is charged, then the thumbnail made by Images as an image upload and linked by the Store; a
// removal by JSON null or a bare key, sent once.

afterEach(() => {
  vi.useRealTimers();
});

type Method = "PUT" | "PATCH";
type Body = { body: Uint8Array | ReadableStream<Uint8Array> | string; contentType: string };

const thumbPart = (data: Uint8Array = bytes(PNG_PLAIN)): Part => ({
  name: "thumbnail",
  data,
  filename: "t.png",
  type: "image/png",
});

function send(w: RouteWorld, method: Method, id: string, body: Body, query = "", token = w.h.users.alice.token) {
  return w.h.request(`/api/v1/media/${id}${query}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": body.contentType },
    body: body.body,
  });
}

const jsonBody = (value: unknown): Body => ({ body: JSON.stringify(value), contentType: "application/json" });

// The counts a refusal must leave unchanged: alice's upload attempts and the Images charges (instance and account).
async function counters(w: RouteWorld): Promise<{ attempts: number; transforms: string[] }> {
  const [row] = await sql<{ value: string }>(
    w.store,
    "SELECT value FROM kopje_state WHERE name = ?",
    `media_attempts:${w.h.users.alice.id}`,
  );
  const transforms = await sql<{ value: string }>(
    w.store,
    "SELECT value FROM kopje_state WHERE name LIKE 'images_transforms:%' OR name LIKE 'images_account_transforms:%' ORDER BY name",
  );
  return { attempts: (JSON.parse(row?.value ?? "[]") as number[]).length, transforms: transforms.map((r) => r.value) };
}

const charge = (n: number) => [String(n), String(n)];

// The parent's current thumbnail (id and file token), or undefined.
async function current(w: RouteWorld, parent: string): Promise<Up | undefined> {
  const [row] = await sql<{ id: string; file_token: string }>(
    w.store,
    "SELECT id, file_token FROM media_attachments WHERE thumbnail_of = ? AND gc_at IS NULL",
    parent,
  );
  return row === undefined ? undefined : { id: row.id, token: row.file_token };
}

async function imageRows(w: RouteWorld): Promise<{ id: string; thumbnail_of: string | null; gc_at: string | null }[]> {
  return sql(w.store, "SELECT id, thumbnail_of, gc_at FROM media_attachments WHERE type = 'image' ORDER BY id");
}

async function has(key: string): Promise<boolean> {
  return (await env.MEDIA.head(key)) !== null;
}

// A video of alice's whose own still differs from any thumbnail (VIDEO.preview).
const STILL = { width: 640, height: 360, size: "640x360", aspect: 640 / 360 };

async function scheduledParent(w: RouteWorld): Promise<string> {
  const parent = await completed(w, { facts: AUDIO });
  await sql(
    w.store,
    "INSERT INTO scheduled_statuses (id, account_id, scheduled_at, params) VALUES (?, ?, ?, '{}')",
    "130000000000000001",
    w.h.users.alice.id,
    "2027-01-01T00:00:00.000Z",
  );
  await sql(w.store, "UPDATE media_attachments SET scheduled_status_id = '130000000000000001' WHERE id = ?", parent.id);
  return parent.id;
}

describe.each(["PUT", "PATCH"] as const)("%s /api/v1/media/:id with a video's or audio file's thumbnail", (method) => {
  it("links it on an unattached video and a scheduled audio file, one attempt and the Images charge each (T14, T17)", async () => {
    const w = await routeWorld();
    const video = (await completed(w)).id;
    const audio = await scheduledParent(w);
    const before = await counters(w);
    for (const [n, id] of [video, audio].entries()) {
      const response = await answerOf<Record<string, unknown>>(
        await send(w, method, id, multipartBody([thumbPart(), { name: "description", data: `d${n}` }])),
      );
      const child = await current(w, id);
      expect(child).toBeDefined();
      expect(response).toEqual({
        status: 200,
        body: expect.objectContaining({
          id,
          description: `d${n}`,
          preview_url: expect.stringContaining(`/media/${child?.token}/small.`),
          blurhash: expect.any(String),
          meta: expect.objectContaining({ small: expect.objectContaining({ width: expect.any(Number) }) }),
        }),
      });
      expect(await has(originalKey(child?.id ?? ""))).toBe(true);
    }
    const after = await counters(w);
    expect(after.attempts).toBe(before.attempts + 2);
    expect(after.transforms).toEqual(charge(2 * TRANSFORMS_PER_UPLOAD));
    // No unit of the upload budget, no container.
    expect(w.runs).toEqual([]);
  });

  it("answers a processing video 206 with the thumbnail's preview, url still masked (D-5)", async () => {
    const w = await routeWorld();
    const parent = await queued(w);
    const response = await answerOf<Record<string, unknown>>(
      await send(w, method, parent.id, multipartBody([thumbPart()])),
    );
    const child = await current(w, parent.id);
    expect(response.status).toBe(206);
    expect(response.body).toMatchObject({
      url: null,
      preview_url: expect.stringContaining(`/media/${child?.token}/small.`),
      meta: { small: expect.objectContaining({ width: expect.any(Number) }) },
    });
  });

  it("reads no body for an invalid token: 401 with the multipart body still unread", async () => {
    const w = await routeWorld();
    const parent = await completed(w);
    const { body, contentType } = multipartBody([thumbPart()]);
    const slow = new SlowBody(body, { holdAt: 0 });
    const response = await Promise.race([
      send(w, method, parent.id, { body: slow.stream(), contentType }, "", "not-a-token"),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the body was awaited")), 5_000)),
    ]);
    expect(response.status).toBe(401);
    expect(slow.pulled).toBe(0);
  });

  it("keeps main's bound on what the body holds besides the thumbnail file, malformed bodies included (G1)", async () => {
    const w = await routeWorld();
    const parent = await completed(w);
    const big = new Uint8Array(2 * 1024 * 1024);
    const other = await answerOf<Record<string, unknown>>(
      await send(
        w,
        method,
        parent.id,
        multipartBody([
          { name: "other", data: big, filename: "o.bin" },
          { name: "description", data: "x" },
        ]),
      ),
    );
    expect(other).toEqual({ status: 413, body: { error: "Request body is too large" } });
    const malformed = (size: number): Body => ({
      body: new Uint8Array(size).fill(0x78),
      contentType: "multipart/form-data; boundary=b",
    });
    expect(
      await answerOf<Record<string, unknown>>(await send(w, method, parent.id, malformed(2 * 1024 * 1024))),
    ).toEqual({
      status: 413,
      body: { error: "Request body is too large" },
    });
    expect(await answerOf<Record<string, unknown>>(await send(w, method, parent.id, malformed(1024)))).toEqual({
      status: 400,
      body: { error: "Malformed request body" },
    });
    // Within the bound, a parse refused past the parameters' path budget keeps its own 413 (r3).
    const deep = (n: number) => `n${n}${"x".repeat(40_000)}${"[a]".repeat(30)}`;
    const paths = multipartBody([0, 1, 2].map((n) => ({ name: deep(n), data: "v" })));
    expect(paths.body.byteLength).toBeLessThan(1024 * 1024);
    expect((await send(w, method, parent.id, paths)).status).toBe(413);
    expect(await current(w, parent.id)).toBeUndefined();
  });

  it("judges in Kopje's order, the form before the failed state, charging nothing: lookup, description, thumbnail against type, failed state", async () => {
    const w = await routeWorld();
    const image = await imageUpload(w);
    const video = (await completed(w)).id;
    const failedVideo = (await failed(w, "deadline")).id;
    const before = await counters(w);
    const calls = w.codec.calls;
    const oversize = thumbPart(new Uint8Array(17_000_000));
    const refusals: [string, string, Body, number, string][] = [
      ["17 MB to a missing id", "109999999999999999", multipartBody([oversize]), 404, "Record not found"],
      ["17 MB to an image", image, multipartBody([oversize]), 422, "Validation failed: Thumbnail must be blank"],
      [
        "a long description first",
        video,
        multipartBody([oversize, { name: "description", data: "x".repeat(MAX_MEDIA_DESCRIPTION_LENGTH + 1) }]),
        422,
        `Validation failed: Description is too long (maximum is ${MAX_MEDIA_DESCRIPTION_LENGTH} characters)`,
      ],
      [
        "17 MB to a video",
        video,
        multipartBody([oversize]),
        422,
        "Validation failed: Thumbnail file size must be less than 16 MB",
      ],
      [
        "no image",
        video,
        multipartBody([thumbPart(mp4(64))]),
        422,
        "Validation failed: Thumbnail content type is invalid",
      ],
      // Its bytes are the thumbnail's allowance, not the rest of the body's.
      [
        "2 MiB, no image",
        video,
        multipartBody([thumbPart(mp4(2 * 1024 * 1024))]),
        422,
        "Validation failed: Thumbnail content type is invalid",
      ],
      [
        "text (D-3)",
        video,
        jsonBody({ thumbnail: "data:x" }),
        422,
        "Validation failed: Thumbnail content type is invalid",
      ],
      [
        "a failed upload, no image",
        failedVideo,
        multipartBody([thumbPart(mp4(64))]),
        422,
        "Validation failed: Thumbnail content type is invalid",
      ],
      [
        "a failed upload, an image",
        failedVideo,
        multipartBody([thumbPart()]),
        422,
        "Error processing thumbnail for uploaded media",
      ],
    ];
    for (const [label, id, body, status, error] of refusals) {
      const response = await answerOf<Record<string, unknown>>(await send(w, method, id, body));
      expect([label, response]).toEqual([label, { status, body: { error } }]);
    }
    expect(await counters(w)).toEqual(before);
    expect(w.codec.calls).toBe(calls);
    expect(await imageRows(w)).toEqual([expect.objectContaining({ id: image })]);
  });

  it("refuses a thumbnail past 33,177,600 pixels with no transformation, and links one at it", async () => {
    const w = await routeWorld();
    const video = (await completed(w)).id;
    w.codec.infoResult = { format: "image/png", width: 7681, height: 4320 };
    const refused = await answerOf<Record<string, unknown>>(await send(w, method, video, multipartBody([thumbPart()])));
    expect(refused).toEqual({
      status: 422,
      body: { error: "Validation failed: Thumbnail dimensions exceed 33177600 pixels" },
    });
    expect(w.codec.encodeCalls).toEqual([]);
    expect(await current(w, video)).toBeUndefined();
    w.codec.infoResult = { format: "image/png", width: 7680, height: 4320 };
    w.codec.infoCalls = 0;
    const linked = await answerOf<Record<string, unknown>>(await send(w, method, video, multipartBody([thumbPart()])));
    expect(linked.status).toBe(200);
    expect(await current(w, video)).toBeDefined();
  });

  it("keeps the attempt and charge of a thumbnail whose link is refused (the video deleted meanwhile), and sweeps it", async () => {
    const w = await routeWorld();
    const parent = await completed(w);
    const before = await counters(w);
    const link = w.gate.hold("updateMedia");
    const reached = w.gate.reached("updateMedia");
    const put = send(w, method, parent.id, multipartBody([thumbPart()]));
    await reached;
    const [child] = await sql<{ id: string; file_token: string }>(
      w.store,
      "SELECT id, file_token FROM media_attachments WHERE type = 'image'",
    );
    expect(await has(fileKey(child?.file_token ?? "", "small"))).toBe(true);
    expect((await w.store.deleteMedia(BUILD, { credential: w.alice, id: parent.id })).status).toBe("ok");
    link.resolve();
    expect(await answerOf<Record<string, unknown>>(await put)).toEqual({
      status: 404,
      body: { error: "Record not found" },
    });
    const after = await counters(w);
    expect(after.attempts).toBe(before.attempts + 1);
    expect(after.transforms).toEqual(charge(TRANSFORMS_PER_UPLOAD));
    // Discarded (doomed) and taken by the sweep the PUT ran after its response.
    expect(await imageRows(w)).toEqual([]);
    expect(await has(originalKey(child?.id ?? ""))).toBe(false);
    expect(await has(fileKey(child?.file_token ?? "", "small"))).toBe(false);
  });

  it("repeats a link once when its reply is lost, linking one thumbnail", async () => {
    const w = await routeWorld();
    const parent = await completed(w);
    w.gate.drops.set("updateMedia", 1);
    const response = await answerOf<Record<string, unknown>>(
      await send(w, method, parent.id, multipartBody([thumbPart()])),
    );
    const child = await current(w, parent.id);
    expect(response.status).toBe(200);
    expect(response.body["preview_url"]).toContain(`/media/${child?.token}/small.`);
    expect(w.gate.calls.filter((c) => c === "updateMedia")).toHaveLength(2);
    expect(await imageRows(w)).toEqual([{ id: child?.id, thumbnail_of: parent.id, gc_at: null }]);
  });

  it("repeats a link once when its reply is lost as a retryable transport error (r1 M3)", async () => {
    const w = await routeWorld();
    const parent = await completed(w);
    w.gate.drops.set("updateMedia", 1);
    w.gate.retryableDrops.add("updateMedia");
    const response = await answerOf<Record<string, unknown>>(
      await send(w, method, parent.id, multipartBody([thumbPart()])),
    );
    const child = await current(w, parent.id);
    expect(response.status).toBe(200);
    expect(response.body["preview_url"]).toContain(`/media/${child?.token}/small.`);
    expect(w.gate.calls.filter((c) => c === "updateMedia")).toHaveLength(2);
    expect(await imageRows(w)).toEqual([{ id: child?.id, thumbnail_of: parent.id, gc_at: null }]);
  });

  it("does not repeat a link whose reply is an overloaded object's error: 503, sent once (r1 M3)", async () => {
    const w = await routeWorld();
    const parent = await completed(w);
    w.gate.drops.set("updateMedia", 1);
    w.gate.overloadedDrops.add("updateMedia");
    expect((await send(w, method, parent.id, multipartBody([thumbPart()]))).status).toBe(503);
    expect(w.gate.calls.filter((c) => c === "updateMedia")).toHaveLength(1);
  });

  it("writes nothing on a link repeat that finds its thumbnail current: a later description stays (W-T5, r1 M1)", async () => {
    const w = await routeWorld();
    const parent = await completed(w);
    const held = w.gate.hold("updateMedia", "after");
    const reached = w.gate.reached("updateMedia");
    const first = send(w, method, parent.id, multipartBody([thumbPart(), { name: "description", data: "first" }]));
    await reached;
    try {
      const second = await answerOf<Record<string, unknown>>(
        await send(w, method, parent.id, jsonBody({ description: "second" })),
      );
      expect(second.body["description"]).toBe("second");
      w.gate.drops.set("updateMedia", 1);
    } finally {
      held.resolve();
    }
    const repeated = await answerOf<Record<string, unknown>>(await first);
    const child = await current(w, parent.id);
    expect(repeated).toEqual({
      status: 200,
      body: expect.objectContaining({
        description: "second",
        preview_url: expect.stringContaining(`/media/${child?.token}/small.`),
      }),
    });
    expect(w.gate.calls.filter((c) => c === "updateMedia")).toHaveLength(3);
    expect(
      (await answerOf<Record<string, unknown>>(await send(w, method, parent.id, jsonBody({})))).body["description"],
    ).toBe("second");
  });

  it("checks the token again before answering a multipart body it cannot parse (r1 M4)", async () => {
    const w = await routeWorld();
    const parent = await completed(w);
    const expiry = Date.now() + 1_000;
    await sql(
      w.store,
      "UPDATE oauth_tokens SET expires_at = ? WHERE token_hash = ?",
      new Date(expiry).toISOString(),
      w.alice.tokenHash,
    );
    const reading = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          reading.resolve();
          await resume.promise;
          controller.enqueue(new Uint8Array(1024).fill(0x78));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const response = send(w, method, parent.id, { body, contentType: "multipart/form-data; boundary=b" });
    await reading.promise;
    try {
      await w.advance(expiry);
    } finally {
      resume.resolve();
    }
    expect((await response).status).toBe(401);
  });

  it("discards and sweeps a thumbnail whose link the Store refuses for the token's scope (r1 M5)", async () => {
    const w = await routeWorld();
    const parent = await completed(w);
    const held = w.gate.hold("updateMedia");
    const reached = w.gate.reached("updateMedia");
    const response = send(w, method, parent.id, multipartBody([thumbPart()]));
    await reached;
    try {
      expect(await imageRows(w)).toHaveLength(1);
      await sql(w.store, "UPDATE oauth_tokens SET scopes = 'read' WHERE token_hash = ?", w.alice.tokenHash);
    } finally {
      held.resolve();
    }
    expect((await response).status).toBe(403);
    expect(w.gate.calls).toContain("abandonMedia");
    // The sweep is run after the response too (its first Store call), whatever the refused discard left for it.
    expect(w.gate.calls).toContain("expiredMedia");
  });

  it("runs the sweep after a removal whose reply is lost: the retired thumbnail's files are released (r1 LOW 2)", async () => {
    const w = await routeWorld();
    const parent = await completed(w);
    expect((await send(w, method, parent.id, multipartBody([thumbPart()]))).status).toBe(200);
    const a = await current(w, parent.id);
    w.gate.drops.set("updateMedia", 1);
    expect((await send(w, method, parent.id, jsonBody({ thumbnail: null }))).status).toBe(503);
    expect(await current(w, parent.id)).toBeUndefined();
    expect(await has(fileKey(a?.token ?? "", "small"))).toBe(false);
    expect(await has(originalKey(a?.id ?? ""))).toBe(true);
  });

  it("runs the sweep after a committed removal whose reply is an overloaded object's error (r2 LOW 2)", async () => {
    const w = await routeWorld();
    const parent = await completed(w);
    expect((await send(w, method, parent.id, multipartBody([thumbPart()]))).status).toBe(200);
    const a = await current(w, parent.id);
    expect(await has(fileKey(a?.token ?? "", "small"))).toBe(true);
    w.gate.drops.set("updateMedia", 1);
    w.gate.overloadedDrops.add("updateMedia");
    expect((await send(w, method, parent.id, jsonBody({ thumbnail: null }))).status).toBe(503);
    expect(await current(w, parent.id)).toBeUndefined();
    expect(await has(fileKey(a?.token ?? "", "small"))).toBe(false);
  });

  it("runs the sweep after a thumbnail whose completion committed with both replies lost (r1 LOW 3)", async () => {
    const w = await routeWorld();
    const parent = await completed(w);
    w.gate.drops.set("completeMedia", 2);
    expect((await send(w, method, parent.id, multipartBody([thumbPart()]))).status).toBe(500);
    expect(await current(w, parent.id)).toBeUndefined();
    expect(await imageRows(w)).toEqual([]);
  });

  it("answers 503 when both link replies are lost: an unlinked thumbnail is swept, a linked one stays (W-T5)", async () => {
    const w = await routeWorld();
    const parent = await completed(w);
    w.gate.fails.set("updateMedia", 2);
    expect(
      await answerOf<Record<string, unknown>>(await send(w, method, parent.id, multipartBody([thumbPart()]))),
    ).toEqual({
      status: 503,
      body: { error: "Media processing is unavailable. Try again later." },
    });
    expect(await imageRows(w)).toEqual([]);
    w.gate.drops.set("updateMedia", 2);
    expect((await send(w, method, parent.id, multipartBody([thumbPart()]))).status).toBe(503);
    const child = await current(w, parent.id);
    expect(await imageRows(w)).toEqual([{ id: child?.id, thumbnail_of: parent.id, gc_at: null }]);
  });

  it("replaces a thumbnail: the old one's served files answer 404 from the origin, its original kept (T18)", async () => {
    const w = await routeWorld();
    const parent = await completed(w);
    expect((await send(w, method, parent.id, multipartBody([thumbPart()]))).status).toBe(200);
    const a = await current(w, parent.id);
    expect(await has(fileKey(a?.token ?? "", "small"))).toBe(true);
    const replaced = await answerOf<Record<string, unknown>>(
      await send(w, method, parent.id, multipartBody([thumbPart(bytes(WEBP_PLAIN))])),
    );
    const b = await current(w, parent.id);
    expect(b?.id).not.toBe(a?.id);
    expect(replaced.body["preview_url"]).toContain(`/media/${b?.token}/small.`);
    // Released by the sweep the PUT ran after its response.
    for (const variant of ["small.png", "full.png"]) {
      expect((await w.h.request(`/media/${a?.token}/${variant}`)).status).toBe(404);
    }
    expect(await has(originalKey(a?.id ?? ""))).toBe(true);
    expect((await w.h.request(new URL(String(replaced.body["preview_url"])).pathname)).status).toBe(200);
  });

  it("removes it by JSON null: the removed thumbnail's served files answer 404 from the origin, its original kept (T18)", async () => {
    const w = await routeWorld();
    const parent = await completed(w);
    expect((await send(w, method, parent.id, multipartBody([thumbPart()]))).status).toBe(200);
    const a = await current(w, parent.id);
    expect((await w.h.request(`/media/${a?.token}/small.png`)).status).toBe(200);
    expect((await send(w, method, parent.id, jsonBody({ thumbnail: null }))).status).toBe(200);
    // Released by the sweep the PUT ran after its response.
    for (const variant of ["small.png", "full.png"]) {
      expect((await w.h.request(`/media/${a?.token}/${variant}`)).status).toBe(404);
    }
    expect(await has(originalKey(a?.id ?? ""))).toBe(true);
  });

  it("removes it by JSON null, a bare query key or a bare form key; empty text or none changes nothing (T19, D-7)", async () => {
    const w = await routeWorld();
    const parent = await completed(w);
    const removals: [string, Body, string][] = [
      ["JSON null", jsonBody({ thumbnail: null, description: "n" }), ""],
      ["a bare query key", jsonBody({ description: "q" }), "?thumbnail"],
      ["a bare form key", { body: "thumbnail&description=f", contentType: "application/x-www-form-urlencoded" }, ""],
    ];
    for (const [label, body, query] of removals) {
      expect((await send(w, method, parent.id, multipartBody([thumbPart()]))).status).toBe(200);
      const child = await current(w, parent.id);
      for (const unchanged of [jsonBody({ thumbnail: "" }), jsonBody({ description: "kept" })]) {
        const response = await answerOf<Record<string, unknown>>(await send(w, method, parent.id, unchanged));
        expect([label, response.status, response.body["preview_url"]]).toEqual([
          label,
          200,
          expect.stringContaining(child?.token ?? "?"),
        ]);
      }
      const removed = await answerOf<Record<string, unknown>>(await send(w, method, parent.id, body, query));
      expect([label, removed.status]).toEqual([label, 200]);
      expect(removed.body).toMatchObject({
        preview_url: expect.stringContaining(`/media/${parent.token}/small.`),
        blurhash: VIDEO.preview?.blurhash,
        meta: expect.objectContaining({ small: STILL }),
      });
      expect(await current(w, parent.id)).toBeUndefined();
      const [row] = await sql<{ gc_at: string }>(
        w.store,
        "SELECT gc_at FROM media_attachments WHERE id = ?",
        child?.id ?? "",
      );
      expect([label, row?.gc_at]).toEqual([label, new Date(Date.now() + THUMBNAIL_KEEP_MS).toISOString()]);
    }
  });

  it.each([
    ["JSON null", jsonBody({ thumbnail: null }), ""],
    ["a bare query key", jsonBody({}), "?thumbnail"],
    ["a bare form key", { body: "thumbnail", contentType: "application/x-www-form-urlencoded" }, ""],
  ] as [string, Body, string][])(
    "sends a removal once (%s): its lost reply answers 503, and a thumbnail linked meanwhile stays current (T19)",
    async (_, body, query) => {
      const w = await routeWorld();
      const parent = await completed(w);
      expect((await send(w, method, parent.id, multipartBody([thumbPart()]))).status).toBe(200);
      const held = w.gate.hold("updateMedia", "after");
      const reached = w.gate.reached("updateMedia");
      const removal = send(w, method, parent.id, body, query);
      await reached;
      expect((await send(w, method, parent.id, multipartBody([thumbPart(bytes(WEBP_PLAIN))]))).status).toBe(200);
      const b = await current(w, parent.id);
      w.gate.drops.set("updateMedia", 1);
      held.resolve();
      expect(await answerOf<Record<string, unknown>>(await removal)).toEqual({
        status: 503,
        body: { error: "Media processing is unavailable. Try again later." },
      });
      expect(await current(w, parent.id)).toEqual(b);
      expect((await w.h.request(`/media/${b?.token}/small.webp`)).status).toBe(200);
    },
  );
});

describe.each(["PUT", "PATCH"] as const)(
  "%s /api/v1/media/:id of an image with a bare thumbnail key (C66)",
  (method) => {
    it.each([
      ["the query", jsonBody({ description: "described", focus: "0.5,-0.25" }), "?thumbnail"],
      [
        "a form body",
        { body: "thumbnail&description=described&focus=0.5,-0.25", contentType: "application/x-www-form-urlencoded" },
        "",
      ],
    ] as [string, Body, string][])(
      "applies the description and focus, the bare key in %s no thumbnail (200)",
      async (_, body, query) => {
        const w = await routeWorld();
        const image = await imageUpload(w);
        const response = await answerOf<Record<string, unknown>>(await send(w, method, image, body, query));
        expect(response).toEqual({
          status: 200,
          body: expect.objectContaining({
            id: image,
            description: "described",
            meta: expect.objectContaining({ focus: { x: 0.5, y: -0.25 } }),
          }),
        });
      },
    );
  },
);

describe("PUT /api/v1/media/:id with a thumbnail and no media processor bound (fork c)", () => {
  it("makes and links it", async () => {
    const codec = new TestCodec();
    const w = await avWorld({ images: () => codec });
    w.h.now.mockImplementation(() => Date.now());
    const parent = await completed(w);
    const { body, contentType } = multipartBody([thumbPart()]);
    const response = await w.h.request(`/api/v1/media/${parent.id}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${w.h.users.alice.token}`, "content-type": contentType },
      body,
    });
    expect(response.status).toBe(200);
    expect(codec.encodeCalls.length).toBeGreaterThan(0);
    const [child] = await sql<{ file_token: string }>(
      w.store,
      "SELECT file_token FROM media_attachments WHERE thumbnail_of = ? AND gc_at IS NULL",
      parent.id,
    );
    expect(child).toBeDefined();
    const shown = await response.json<Record<string, unknown>>();
    expect(shown["preview_url"]).toContain(`/media/${child?.file_token ?? "?"}/small.`);
  });
});

// An image upload of alice's through the image pipeline, as before #1828 (uploads active, so a candidate reservation
// that the image path takes).
async function imageUpload(w: RouteWorld): Promise<string> {
  const response = await postMedia(
    w,
    multipartBody([{ name: "file", data: bytes(PNG_PLAIN), filename: "a.png", type: "image/png" }]),
  );
  const body = await response.json<{ id: string }>();
  return body.id;
}
