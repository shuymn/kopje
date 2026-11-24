import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import { TRANSFORMS_PER_UPLOAD, UPLOAD_BUDGET } from "../src/domain/media";
import { handleScheduled } from "../src/jobs/scheduled";
import { sweepMedia, THUMBNAIL_MUST_BE_BLANK, UPLOAD_SAVE_RESERVE_MS } from "../src/mastodon/media";
import { accountMonthlyTransforms, readConfig } from "../src/platform/config";
import { retainedMetadata } from "../src/platform/image-bytes";
import { RGBA_CALL_MS, RGBA_MIN_CALL_MS } from "../src/platform/images";
import { remoteImageMetadata } from "../src/platform/remote-media-bytes";
import { MAX_MEDIA_DESCRIPTION_LENGTH } from "../src/platform/stored-bounds";
import { sha256Hex } from "../src/security/tokens";
import { bearer, json, login, settle, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { avFixture } from "./av-helpers";
import { deleteSignature } from "./delete-job-helpers";
import {
  GIF,
  JPEG_WITH_GPS,
  PNG_ICC,
  PNG_PLAIN,
  PNG_WITH_GPS,
  WEBP_ICC,
  WEBP_SERIAL,
  WEBP_XMP,
  WIDE_PNG,
} from "./fixtures/images";
import { BUILD } from "./helpers";
import {
  type Attachment,
  bytes,
  DESCRIPTION_TOO_LONG,
  jpegWithSegment,
  mediaForm,
  multipartForm,
  OVERLONG_DESCRIPTIONS,
  pathOf,
  pngWithChunk,
  r2Keys,
  TestCodec,
  upload,
  uploaded,
} from "./media-helpers";
import { animatedWebp, exifOrientation, webpChunk } from "./remote-media-fixtures";
import {
  community,
  getJson,
  mediaNotFound,
  outbound,
  post,
  posting,
  remoteAccount,
  remoteFollows,
  type Status,
} from "./status-helpers";
import { encodeWebp } from "./webp-fixtures";

const HOUR = 60 * 60 * 1000;

// An update through `send` takes a description of MAX_MEDIA_DESCRIPTION_LENGTH four-byte code points, stored whole,
// and refuses one code point more, leaving it as it was; then restores `kept`.
async function described(
  h: { store: Parameters<typeof sql>[0] },
  send: (token: string, body: Record<string, unknown>) => Promise<Response>,
  token: string,
  id: string,
  kept: string,
): Promise<void> {
  const longest = "\u{1F600}".repeat(MAX_MEDIA_DESCRIPTION_LENGTH);
  const accepted = await send(token, { description: longest });
  expect([accepted.status, (await accepted.json<Attachment>()).description]).toEqual([200, longest]);
  const stored = () => sql(h.store, "SELECT length(description) AS n FROM media_attachments WHERE id = ?", id);
  expect(await stored()).toEqual([{ n: MAX_MEDIA_DESCRIPTION_LENGTH }]);
  for (const description of OVERLONG_DESCRIPTIONS) {
    const refused = await send(token, { description });
    expect([description.length, refused.status, await refused.json()]).toEqual([
      description.length,
      422,
      DESCRIPTION_TOO_LONG,
    ]);
  }
  expect(await stored()).toEqual([{ n: MAX_MEDIA_DESCRIPTION_LENGTH }]);
  expect((await send(token, { description: kept })).status).toBe(200);
}

async function users(names: readonly string[] = ["alice", "bob"], codec = new TestCodec()) {
  const h = await community(names as ["alice", "bob"], "read write follow", { images: () => codec });
  return { ...h, codec };
}

function sweep(h: { store: Parameters<typeof sql>[0] }, at: number) {
  return sweepMedia(env, { build: () => env.CF_VERSION_METADATA.id, now: () => at, store: () => h.store });
}

async function row(h: { store: Parameters<typeof sql>[0] }, id: string) {
  const [found] = await sql<{ file_token: string; status_id: string | null; gc_at: string | null; processed: number }>(
    h.store,
    "SELECT file_token, status_id, gc_at, processed FROM media_attachments WHERE id = ?",
    id,
  );
  return found;
}

async function keysOf(h: { store: Parameters<typeof sql>[0] }, id: string): Promise<string[]> {
  const found = await row(h, id);
  if (found === undefined) {
    throw new Error(`no media row ${id}`);
  }
  return [`files/${found.file_token}/full`, `files/${found.file_token}/small`, `originals/${id}`];
}

async function stored(keys: string[]): Promise<string[]> {
  const present: string[] = [];
  for (const key of keys) {
    if ((await env.MEDIA.head(key)) !== null) {
      present.push(key);
    }
  }
  return present;
}

describe("POST /api/v2/media", () => {
  it("reads the last of repeated file parts, as Rails assigns them", async () => {
    const h = await users();
    const stringThenFile = new FormData();
    stringThenFile.append("file", "x");
    stringThenFile.append("file", new File([bytes(PNG_PLAIN)], "p.png", { type: "image/png" }));
    expect((await upload(h, h.users.alice, stringThenFile)).status).toBe(200);
    const fileThenString = mediaForm(bytes(PNG_PLAIN), { file: "x" }, "p.png", "image/png");
    const refused = await upload(h, h.users.alice, fileThenString);
    expect([refused.status, await refused.json()]).toEqual([422, { error: "Validation failed: File can't be blank" }]);
  });

  it("re-encodes an image without its location, keeps the original private, and serves only the re-encoding (MEDIA-3)", async () => {
    const h = await users();
    const media = await uploaded(h, h.users.alice, mediaForm(bytes(JPEG_WITH_GPS), { description: "a red square" }));
    expect(media).toMatchObject({
      type: "image",
      description: "a red square",
      meta: {
        original: { width: 80, height: 60, size: "80x60", aspect: 80 / 60 },
        small: { width: 80, height: 60 },
      },
    });
    // Sent without a focus, so its meta has none (MediaAttachment#focus=).
    expect(Object.keys(media.meta ?? {})).toEqual(["original", "small"]);
    expect(media.url).toMatch(/^https:\/\/kopje\.test\/media\/[A-Za-z0-9_-]{32,64}\/full\.webp$/);
    expect(media.preview_url).toMatch(/^https:\/\/kopje\.test\/media\/[A-Za-z0-9_-]{32,64}\/small\.webp$/);
    const served = await h.request(pathOf(media.url));
    expect(served.status).toBe(200);
    // JPEG becomes WebP, for which Images discards all metadata.
    expect(served.headers.get("content-type")).toBe("image/webp");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    const body = new Uint8Array(await served.arrayBuffer());
    expect(retainedMetadata(body, "image/webp")).toBeNull();
    expect(body).not.toEqual(bytes(JPEG_WITH_GPS));
    // The original is stored as uploaded, under its id, and no URL reaches it.
    const original = await env.MEDIA.get(`originals/${media.id}`);
    expect(new Uint8Array(await (original as R2ObjectBody).arrayBuffer())).toEqual(bytes(JPEG_WITH_GPS));
    expect(await row(h, media.id)).toMatchObject({ processed: 1, status_id: null });
  });

  it("caps the long edge and makes a preview; PNG stays PNG, GIF becomes WebP", async () => {
    const h = await users();
    const wide = await uploaded(h, h.users.alice, mediaForm(bytes(WIDE_PNG), {}, "wide.png", "image/png"));
    expect(wide.meta).toMatchObject({ original: { width: 3840, height: 960 }, small: { width: 640, height: 160 } });
    expect(wide.url).toMatch(/\/full\.png$/);
    // A FULL_EDGE square bounds the long edge whichever way the image turns; meta takes the size Images served.
    expect(h.codec.encodeCalls).toEqual([
      { width: 3840, height: 3840, format: "image/png" },
      { width: 640, height: 160, format: "image/png", still: true },
      { width: 640, height: 160, format: "rgba", limit: 4 * 640 * 160, guard: expect.any(Function) },
    ]);
    const gif = await uploaded(h, h.users.alice, mediaForm(bytes(GIF), {}, "a.gif", "image/gif"));
    expect(gif.url).toMatch(/\/full\.webp$/);
    expect((await h.request(pathOf(gif.preview_url))).headers.get("content-type")).toBe("image/webp");
  });

  it("accepts v1 too, with description and focus", async () => {
    const h = await users();
    const response = await upload(
      h,
      h.users.alice,
      mediaForm(bytes(PNG_WITH_GPS), { description: "alt", focus: "0.5,-2" }, "p.png", "image/png"),
      "v1",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ description: "alt", meta: { focus: { x: 0.5, y: -1 } } });
  });

  it("refuses a failed transformation and serves nothing (MEDIA-3)", async () => {
    const h = await users();
    h.codec.failEncode = 9523;
    const response = await upload(h, h.users.alice, mediaForm(bytes(JPEG_WITH_GPS)));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Error processing uploaded media" });
    const [doomed] = await sql<{ id: string }>(h.store, "SELECT id FROM media_attachments");
    expect(doomed).toBeDefined();
    const id = (doomed as { id: string }).id;
    // Neither the original nor a file reached R2, the row cannot be read or attached, and the sweep removes it.
    expect(await stored(await keysOf(h, id))).toEqual([]);
    expect((await getJson(h, `/api/v1/media/${id}`, h.users.alice.token)).status).toBe(404);
    const attach = await h.request("/api/v1/statuses", bearer(h.users.alice.token, json({ media_ids: [id] })));
    expect(attach.status).toBe(422);
    expect(await sweep(h, NOW)).toBe(1);
    expect(await row(h, id)).toBeUndefined();
  });

  // The codec stands in for an Images output that kept metadata; each is stripped before the check (MEDIA-3).
  const KEPT: [string, string, Uint8Array][] = [
    ["a WebP EXIF chunk with a serial number and no GPS", "jpeg", bytes(WEBP_SERIAL)],
    ["WebP XMP", "jpeg", bytes(WEBP_XMP)],
    ["PNG eXIf with GPS", "png", bytes(PNG_WITH_GPS)],
    ["PNG tEXt", "png", pngWithChunk(bytes(PNG_PLAIN), "tEXt", "Author\0alice")],
    ["PNG iTXt", "png", pngWithChunk(bytes(PNG_PLAIN), "iTXt", "XML:com.adobe.xmp\0\0\0\0\0<x/>")],
  ];
  for (const [name, input, output] of KEPT) {
    it(`strips ${name} from an output and serves the image without it (MEDIA-3)`, async () => {
      const h = await users();
      h.codec.encodeResult = output;
      const file =
        input === "jpeg" ? mediaForm(bytes(JPEG_WITH_GPS)) : mediaForm(bytes(WIDE_PNG), {}, "a.png", "image/png");
      const media = await uploaded(h, h.users.alice, file);
      const type = input === "jpeg" ? "image/webp" : "image/png";
      expect(retainedMetadata(output, type)).not.toBeNull();
      for (const url of [media.url, media.preview_url]) {
        const served = new Uint8Array(await (await h.request(pathOf(url))).arrayBuffer());
        expect(retainedMetadata(served, type)).toBeNull();
      }
    });
  }

  it("refuses an output that does not walk, and deletes what it wrote (MEDIA-3)", async () => {
    const h = await users();
    // A plain PNG whose only defect is a byte after IEND: the strip refuses it rather than keep what follows the image.
    h.codec.encodeResult = new Uint8Array([...bytes(PNG_PLAIN), 0]);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await upload(h, h.users.alice, mediaForm(bytes(WIDE_PNG), {}, "a.png", "image/png"));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Error processing uploaded media" });
    // The strip's refusal, not the metadata check's.
    expect(errors.mock.calls).toContainEqual([
      { event: "kopje.media.transform_failed", detail: "output is malformed" },
    ]);
    errors.mockRestore();
    const [media] = await sql<{ id: string }>(h.store, "SELECT id FROM media_attachments");
    expect(await stored(await keysOf(h, (media as { id: string }).id))).toEqual([]);
  });

  it("drops another chunk inside an animated WebP output's frame, and serves the animation (MEDIA-3)", async () => {
    const h = await users();
    const first = await encodeWebp(16, 12);
    const second = await encodeWebp(16, 12, { fill: "flat" });
    // A one-byte JUNK chunk after the second frame's image data, which the format allows there.
    const output = animatedWebp(
      [first, second],
      { width: 16, height: 12 },
      {
        frameChunks: (chunks, i) => (i === 1 ? [...chunks, webpChunk("JUNK", new Uint8Array(1))] : chunks),
      },
    );
    h.codec.encodeResponder = (_options, index) => (index === 0 ? output : null);
    const media = await uploaded(h, h.users.alice, mediaForm(bytes(GIF), {}, "a.gif", "image/gif"));
    const served = new Uint8Array(await (await h.request(pathOf(media.url))).arrayBuffer());
    expect(served).toEqual(animatedWebp([first, second], { width: 16, height: 12 }));
    expect(remoteImageMetadata(served, "image/webp")).toBeNull();
  });

  // Production Images keeps a macOS screenshot's eXIf and XMP iTXt in its PNG output (platform/images.ts): the codec
  // adds an eXIf to each PNG output of the local binding.
  const keepsExif = (output: Uint8Array, options: { format: string }) =>
    options.format === "image/png" ? pngWithChunk(output, "eXIf", exifOrientation(1).subarray(6)) : output;

  it("uploads a screenshot whose Images output keeps its eXIf, and serves it without (MEDIA-3)", async () => {
    const h = await users();
    h.codec.encodeOutput = keepsExif;
    const screenshot = pngWithChunk(
      pngWithChunk(
        pngWithChunk(bytes(PNG_ICC), "eXIf", exifOrientation(1).subarray(6)),
        "iTXt",
        "XML:com.adobe.xmp\0\0\0\0\0<x/>",
      ),
      "iDOT",
      "\0\0\0\x02",
    );
    const media = await uploaded(h, h.users.alice, mediaForm(screenshot, {}, "a.png", "image/png"));
    for (const url of [media.url, media.preview_url]) {
      const served = await h.request(pathOf(url));
      expect(served.headers.get("content-type")).toBe("image/png");
      expect(retainedMetadata(new Uint8Array(await served.arrayBuffer()), "image/png")).toBeNull();
    }
  });

  it("gives Images the upload whole, so a PNG's Exif orientation is applied (MEDIA-3)", async () => {
    const h = await users();
    h.codec.encodeOutput = keepsExif;
    const inputs: Uint8Array[] = [];
    h.codec.encodeResponder = (_options, _index, input) => {
      inputs.push(input);
      return null;
    };
    // 40 x 10, turned 90 degrees clockwise for display (Orientation 6).
    const wide = await h.codec.real.encode(bytes(WIDE_PNG), { width: 40, height: 10, format: "image/png" });
    const rotated = pngWithChunk(wide, "eXIf", exifOrientation(6).subarray(6));
    const media = await uploaded(h, h.users.alice, mediaForm(rotated, {}, "a.png", "image/png"));
    expect(retainedMetadata(inputs[0]!, "image/png")).toBe("exif");
    const served = new Uint8Array(await (await h.request(pathOf(media.url))).arrayBuffer());
    expect(await h.codec.real.info(served)).toMatchObject({ width: 10, height: 40 });
  });

  it("serves a large Exif-rotated PNG and JPEG at full resolution, turned, with meta to match", async () => {
    const h = await users();
    h.codec.encodeOutput = keepsExif;
    // 4,000 x 1,000, turned 90 degrees clockwise for display (Orientation 6): 1,000 x 4,000 as shown.
    const png = pngWithChunk(bytes(WIDE_PNG), "eXIf", exifOrientation(6).subarray(6));
    const jpeg = jpegWithSegment(
      await h.codec.real.encode(bytes(WIDE_PNG), { format: "image/jpeg" as "image/png" }),
      0xe1,
      exifOrientation(6),
    );
    for (const [file, name, type] of [
      [png, "a.png", "image/png"],
      [jpeg, "a.jpg", "image/jpeg"],
    ] as const) {
      const media = await uploaded(h, h.users.alice, mediaForm(file, {}, name, type));
      expect(media.meta, name).toMatchObject({
        original: { width: 960, height: 3840 },
        small: { width: 160, height: 640 },
      });
      for (const [url, size] of [
        [media.url, { width: 960, height: 3840 }],
        [media.preview_url, { width: 160, height: 640 }],
      ] as const) {
        const served = new Uint8Array(await (await h.request(pathOf(url))).arrayBuffer());
        expect(await h.codec.real.info(served), `${name} ${url}`).toMatchObject(size);
      }
    }
  });

  it("keeps a PNG output's colour signalling: cICP, mDCV and cLLI (MEDIA-3)", async () => {
    const h = await users();
    // Display P3 (primaries 12, transfer 13, matrix 0, full range), from a codec that writes them: production Images
    // converts to sRGB and writes none (platform/images.ts), so this is Kopje's strip and check keeping them.
    const colour = (output: Uint8Array, options: { format: string }) =>
      options.format === "image/png"
        ? pngWithChunk(
            pngWithChunk(
              pngWithChunk(keepsExif(output, options), "cICP", new Uint8Array([12, 13, 0, 1])),
              "mDCV",
              new Uint8Array(24),
            ),
            "cLLI",
            new Uint8Array(8),
          )
        : output;
    h.codec.encodeOutput = colour;
    const media = await uploaded(h, h.users.alice, mediaForm(bytes(PNG_ICC), {}, "a.png", "image/png"));
    const served = new Uint8Array(await (await h.request(pathOf(media.url))).arrayBuffer());
    expect(retainedMetadata(served, "image/png")).toBeNull();
    const text = new TextDecoder("latin1").decode(served);
    for (const chunk of ["cICP", "mDCV", "cLLI"]) {
      expect(text).toContain(chunk);
    }
  });

  it("accepts an output that keeps only a colour profile", async () => {
    const h = await users();
    h.codec.encodeResult = bytes(WEBP_ICC);
    expect((await upload(h, h.users.alice, mediaForm(bytes(JPEG_WITH_GPS)))).status).toBe(200);
  });

  it("answers 503 when the transformation allowance is used up, and 422 for what Images cannot read", async () => {
    const h = await users();
    h.codec.failInfo = 9422;
    expect((await upload(h, h.users.alice, mediaForm(bytes(JPEG_WITH_GPS)))).status).toBe(503);
    h.codec.failInfo = 9412;
    expect((await upload(h, h.users.alice, mediaForm(bytes(JPEG_WITH_GPS)))).status).toBe(422);
  });

  it("refuses active and unsupported types by their bytes, before Images is called (MEDIA-4)", async () => {
    const h = await users();
    const refused = [
      ["<!doctype html><script>alert(1)</script>", "x.jpg", "image/jpeg"],
      ['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "x.svg", "image/svg+xml"],
      [
        new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]),
        "v.mp4",
        "video/mp4",
      ],
      ["ID3\u0004\u0000", "a.mp3", "audio/mpeg"],
    ] as const;
    for (const [file, name, type] of refused) {
      const response = await upload(h, h.users.alice, mediaForm(file, {}, name, type));
      expect(response.status, name).toBe(422);
      expect(await response.json()).toEqual({ error: "Validation failed: File content type is invalid" });
    }
    expect(h.codec.calls).toBe(0);
  });

  it("refuses an image the service reads as another type, and one over the pixel limit (MEDIA-4, RES-1)", async () => {
    const h = await users();
    h.codec.infoResult = { format: "image/svg+xml" };
    expect((await upload(h, h.users.alice, mediaForm(bytes(JPEG_WITH_GPS)))).status).toBe(422);
    const big = await users();
    big.codec.infoResult = { format: "image/jpeg", width: 5000, height: 4000 };
    const response = await upload(big, big.users.alice, mediaForm(bytes(JPEG_WITH_GPS)));
    expect(response.status).toBe(422);
    expect(big.codec.encodeCalls).toEqual([]);
  });

  it("refuses a file over 16 MB without transforming it (RES-1)", async () => {
    const h = await users();
    const huge = new Uint8Array(16 * 1024 * 1024 + 1);
    huge.set(bytes(JPEG_WITH_GPS));
    const response = await upload(h, h.users.alice, mediaForm(huge));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "Validation failed: File file size must be less than 16 MB" });
    expect(h.codec.calls).toBe(0);
  });

  // MediaAttachment::MAX_DESCRIPTION_LENGTH in code points: one of four-byte code points is kept whole, and one code
  // point more is refused before anything is transformed or written.
  it(`takes a description of ${MAX_MEDIA_DESCRIPTION_LENGTH} code points and refuses a longer one`, async () => {
    const h = await users();
    const longest = "\u{1F600}".repeat(MAX_MEDIA_DESCRIPTION_LENGTH);
    const media = await uploaded(h, h.users.alice, mediaForm(bytes(JPEG_WITH_GPS), { description: longest }));
    expect(media.description).toBe(longest);
    expect(await sql(h.store, "SELECT length(description) AS n FROM media_attachments")).toEqual([
      { n: MAX_MEDIA_DESCRIPTION_LENGTH },
    ]);
    const calls = h.codec.calls;
    const response = await upload(
      h,
      h.users.alice,
      mediaForm(bytes(JPEG_WITH_GPS), { description: "x".repeat(MAX_MEDIA_DESCRIPTION_LENGTH + 1) }),
    );
    expect([response.status, await response.json()]).toEqual([422, DESCRIPTION_TOO_LONG]);
    expect(h.codec.calls).toBe(calls);
    // The refused upload's reservation is abandoned, with nothing written to it.
    expect(
      await sql(h.store, "SELECT length(description) AS n, url = '' AS abandoned FROM media_attachments ORDER BY id"),
    ).toEqual([
      { n: MAX_MEDIA_DESCRIPTION_LENGTH, abandoned: 0 },
      { n: 0, abandoned: 1 },
    ]);
  });

  // Every description too long gets the description's message, whatever its plane or length: the upload form's field
  // bound leaves the description to its own rule.
  it.each(["v1", "v2"] as const)("refuses every description too long with its message on %s", async (version) => {
    const h = await users();
    for (const description of OVERLONG_DESCRIPTIONS) {
      const response = await upload(h, h.users.alice, mediaForm(bytes(JPEG_WITH_GPS), { description }), version);
      expect([description.length, response.status, await response.json()]).toEqual([
        description.length,
        422,
        DESCRIPTION_TOO_LONG,
      ]);
    }
    expect(h.codec.calls).toBe(0);
  });

  it("needs a token with write:media before anything is read or transformed", async () => {
    const h = await users();
    const anonymous = await h.request("/api/v2/media", { method: "POST", body: mediaForm(bytes(JPEG_WITH_GPS)) });
    expect(anonymous.status).toBe(401);
    const { token } = await login(h, { scope: "read", email: "alice@example.com" });
    const reader = await h.request(
      "/api/v2/media",
      bearer(token, { method: "POST", body: mediaForm(bytes(JPEG_WITH_GPS)) }),
    );
    expect(reader.status).toBe(403);
    expect(h.codec.calls).toBe(0);
    expect(await sql(h.store, "SELECT id FROM media_attachments")).toEqual([]);
  });

  it(`counts upload attempts, so upload and delete cannot loop past ${UPLOAD_BUDGET.count} in 30 minutes (RES-6)`, async () => {
    const h = await users();
    const { alice, bob } = h.users;
    for (let i = 0; i < UPLOAD_BUDGET.count; i++) {
      const media = await uploaded(h, alice, mediaForm(bytes(PNG_PLAIN), {}, "a.png", "image/png"));
      const status = await post(h, alice, { status: `${i}`, media_ids: [media.id] });
      await h.request(`/api/v1/statuses/${status.id}?delete_media=true`, bearer(alice.token, { method: "DELETE" }));
    }
    expect(await sql(h.store, "SELECT id FROM media_attachments")).toEqual([]);
    const calls = h.codec.calls;
    const response = await upload(h, alice, mediaForm(bytes(PNG_PLAIN), {}, "a.png", "image/png"));
    expect(response.status).toBe(429);
    expect(h.codec.calls).toBe(calls);
    // Another account has its own budget, and the window moves on.
    expect((await upload(h, bob, mediaForm(bytes(PNG_PLAIN), {}, "a.png", "image/png"))).status).toBe(200);
    h.now.mockReturnValue(NOW + 31 * 60 * 1000);
    expect((await upload(h, alice, mediaForm(bytes(PNG_PLAIN), {}, "a.png", "image/png"))).status).toBe(200);
  }, 30_000);

  it("counts failed uploads too (RES-6)", async () => {
    const h = await users();
    h.codec.failEncode = 9523;
    for (let i = 0; i < UPLOAD_BUDGET.count; i++) {
      expect((await upload(h, h.users.alice, mediaForm(bytes(PNG_PLAIN), {}, "a.png", "image/png"))).status).toBe(500);
      await sweep(h, NOW);
    }
    const calls = h.codec.calls;
    expect((await upload(h, h.users.alice, mediaForm(bytes(PNG_PLAIN), {}, "a.png", "image/png"))).status).toBe(429);
    expect(h.codec.calls).toBe(calls);
  }, 30_000);

  it("stops one account at its monthly share without locking out the others (RES-6, R4)", async () => {
    const base = readConfig(env);
    expect(base.ok && accountMonthlyTransforms(base.config)).toBe(400);
    const custom = readConfig({ ...env, IMAGES_ACCOUNT_MONTHLY_TRANSFORMS: "6" });
    expect(custom.ok && accountMonthlyTransforms(custom.config)).toBe(6);
    const h = await users();
    const month = new Date(NOW).toISOString().slice(0, 7);
    await sql(
      h.store,
      "INSERT INTO kopje_state (name, value) VALUES (?, ?)",
      `images_account_transforms:${month}:${h.users.alice.id}`,
      String(400 - TRANSFORMS_PER_UPLOAD),
    );
    expect((await upload(h, h.users.alice, mediaForm(bytes(PNG_PLAIN), {}, "a.png", "image/png"))).status).toBe(200);
    const calls = h.codec.calls;
    const refused = await upload(h, h.users.alice, mediaForm(bytes(PNG_PLAIN), {}, "a.png", "image/png"));
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "Your media processing budget for the month is used up" });
    expect(h.codec.calls).toBe(calls);
    expect((await upload(h, h.users.bob, mediaForm(bytes(PNG_PLAIN), {}, "a.png", "image/png"))).status).toBe(200);
  });

  it("stops all uploads once the monthly Images budget is reserved, before any transformation (RES-6)", async () => {
    const base = readConfig(env);
    expect(base.ok && base.config.IMAGES_MONTHLY_TRANSFORMS).toBe(4000);
    const custom = readConfig({ ...env, IMAGES_MONTHLY_TRANSFORMS: "10" });
    expect(custom.ok && custom.config.IMAGES_MONTHLY_TRANSFORMS).toBe(10);
    const h = await users();
    const month = `images_transforms:${new Date(NOW).toISOString().slice(0, 7)}`;
    await sql(
      h.store,
      "INSERT INTO kopje_state (name, value) VALUES (?, ?)",
      month,
      String(4000 - TRANSFORMS_PER_UPLOAD),
    );
    expect((await upload(h, h.users.alice, mediaForm(bytes(PNG_PLAIN), {}, "a.png", "image/png"))).status).toBe(200);
    const calls = h.codec.calls;
    const refused = await upload(h, h.users.bob, mediaForm(bytes(PNG_PLAIN), {}, "a.png", "image/png"));
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "This server's media processing budget for the month is used up" });
    expect(h.codec.calls).toBe(calls);
    // A new month starts a new budget.
    h.now.mockReturnValue(Date.parse("2026-11-01T00:00:00.000Z"));
    expect((await upload(h, h.users.bob, mediaForm(bytes(PNG_PLAIN), {}, "a.png", "image/png"))).status).toBe(200);
  });
});

describe("GET and PUT /api/v1/media/:id", () => {
  it("shows and updates own unattached media only (MEDIA-1, foreign attachment)", async () => {
    const h = await users();
    const { alice, bob } = h.users;
    const media = await uploaded(h, alice, mediaForm(bytes(JPEG_WITH_GPS)));
    expect((await getJson<Attachment>(h, `/api/v1/media/${media.id}`, alice.token)).body).toMatchObject({
      id: media.id,
    });
    expect((await getJson(h, `/api/v1/media/${media.id}`, bob.token)).status).toBe(404);
    const put = (token: string, body: Record<string, unknown>) =>
      h.request(`/api/v1/media/${media.id}`, bearer(token, json(body, { method: "PUT" })));
    expect((await put(bob.token, { description: "mine now" })).status).toBe(404);
    const updated = await put(alice.token, { description: "described", focus: "-0.25,0.75" });
    expect(await updated.json()).toMatchObject({ description: "described", meta: { focus: { x: -0.25, y: 0.75 } } });
    await described(h, put, alice.token, media.id, "described");
    // A multipart update's description is judged by the same rule.
    const multipart = await h.request(
      `/api/v1/media/${media.id}`,
      bearer(alice.token, { method: "PUT", body: multipartForm([["description", OVERLONG_DESCRIPTIONS[1]!]]) }),
    );
    expect([multipart.status, await multipart.json()]).toEqual([422, DESCRIPTION_TOO_LONG]);

    // bob cannot attach it; alice can, after which it is no longer read or updated through /media.
    expect(await posting(h, bob.token, { status: "x", media_ids: [media.id] })).toEqual(mediaNotFound(media.id));
    expect(await sql(h.store, "SELECT id FROM statuses")).toEqual([]);
    const status = await post(h, alice, { status: "with media", media_ids: [media.id] });
    expect(status.media_attachments).toMatchObject([{ id: media.id, description: "described" }]);
    expect((await getJson(h, `/api/v1/media/${media.id}`, alice.token)).status).toBe(404);
    expect((await put(alice.token, { description: "later" })).status).toBe(404);
    // Attached media cannot be moved to another status either.
    expect(await posting(h, alice.token, { status: "other", media_ids: [media.id] })).toEqual(mediaNotFound(media.id));
    expect(await sql(h.store, "SELECT id FROM statuses")).toEqual([{ id: status.id }]);
  });

  // MediaController#set_media_attachment finds own unattached media (404) before update! validates the parameters
  // (422).
  it("a too-long description on attached media answers 404", async () => {
    const h = await users();
    const { alice, bob } = h.users;
    const media = await uploaded(h, alice, mediaForm(bytes(JPEG_WITH_GPS)));
    const update = async (token: string, body: Record<string, unknown>, method = "PUT") => {
      const response = await h.request(`/api/v1/media/${media.id}`, bearer(token, json(body, { method })));
      return [method, response.status, await response.json()];
    };
    const overlong = { description: OVERLONG_DESCRIPTIONS[1]! };
    const thumbnail = { thumbnail: "x" };
    const notFound = { error: "Record not found" };
    // The checks run on the uploader's own unattached media, and not on anyone else's.
    expect(await update(alice.token, overlong)).toEqual(["PUT", 422, DESCRIPTION_TOO_LONG]);
    expect(await update(alice.token, thumbnail)).toEqual(["PUT", 422, { error: THUMBNAIL_MUST_BE_BLANK }]);
    expect(await update(bob.token, overlong)).toEqual(["PUT", 404, notFound]);
    await post(h, alice, { status: "with media", media_ids: [media.id] });
    for (const method of ["PUT", "PATCH"]) {
      expect(await update(alice.token, overlong, method)).toEqual([method, 404, notFound]);
      expect(await update(alice.token, thumbnail, method)).toEqual([method, 404, notFound]);
    }
    expect(await sql(h.store, "SELECT description FROM media_attachments WHERE id = ?", media.id)).toEqual([
      { description: "" },
    ]);
  });
});

// MediaAttachment#focus= (Mastodon 4.7.5): meta holds a focus only once one is given, an explicit 0,0 included; a
// blank one changes nothing, so nothing removes it. Kopje keeps whether it was given (focus_given) beside the point.
describe("the focus of an image (#1767)", () => {
  const png = (fields: Record<string, string> = {}) => mediaForm(bytes(PNG_PLAIN), fields, "p.png", "image/png");
  const focusOf = (media: { meta: Attachment["meta"] }) => media.meta?.focus;
  type Shown = { media_attachments: { meta: Attachment["meta"] }[] };

  it("shows one only once it is given, on an upload, an update and a status", async () => {
    const h = await users();
    const { alice } = h.users;
    const none = await uploaded(h, alice, png());
    const centre = await uploaded(h, alice, png({ focus: "0,0" }));
    const set = await uploaded(h, alice, png({ focus: "0.5,-0.25" }));
    const v1 = await upload(h, alice, png({ focus: "0,0" }), "v1");
    expect([none, centre, set, await v1.json<Attachment>()].map(focusOf)).toEqual([
      undefined,
      { x: 0, y: 0 },
      { x: 0.5, y: -0.25 },
      { x: 0, y: 0 },
    ]);
    expect(
      await sql(
        h.store,
        "SELECT focus_x AS x, focus_y AS y, focus_given AS g FROM media_attachments WHERE id IN (?, ?, ?) ORDER BY id",
        none.id,
        centre.id,
        set.id,
      ),
    ).toEqual([
      { x: 0, y: 0, g: 0 },
      { x: 0, y: 0, g: 1 },
      { x: 0.5, y: -0.25, g: 1 },
    ]);
    const shown = async (id: string) =>
      focusOf((await getJson<Attachment>(h, `/api/v1/media/${id}`, alice.token)).body);
    expect([await shown(none.id), await shown(centre.id)]).toEqual([undefined, { x: 0, y: 0 }]);

    // An update without a focus, or with one blank to Rails or null, leaves it as it is: none stays none.
    const put = async (id: string, body: Record<string, unknown>) =>
      focusOf(
        await (await h.request(`/api/v1/media/${id}`, bearer(alice.token, json(body, { method: "PUT" })))).json(),
      );
    for (const body of [{ description: "d" }, { focus: "" }, { focus: " \u0085" }, { focus: null }]) {
      expect(await put(none.id, body), JSON.stringify(body)).toBeUndefined();
      expect(await put(set.id, body), JSON.stringify(body)).toEqual({ x: 0.5, y: -0.25 });
    }
    const multipart = await h.request(
      `/api/v1/media/${none.id}`,
      bearer(alice.token, { method: "PUT", body: multipartForm([["focus", "0,0"]]) }),
    );
    expect(focusOf(await multipart.json())).toEqual({ x: 0, y: 0 });
    expect(await put(set.id, { focus: "0,0" })).toEqual({ x: 0, y: 0 });

    // A status shows each as its attachment does, and so does its read.
    const plain = await uploaded(h, alice, png());
    const status = (await post(h, alice, { status: "x", media_ids: [plain.id, centre.id, set.id] })) as Status & Shown;
    const expected = [undefined, { x: 0, y: 0 }, { x: 0, y: 0 }];
    expect(status.media_attachments.map(focusOf)).toEqual(expected);
    const read = await getJson<Shown>(h, `/api/v1/statuses/${status.id}`, alice.token);
    expect(read.body.media_attachments.map(focusOf)).toEqual(expected);
  });

  // A row the upgrade carried holds focus_given 0, and an omitted focus as 0,0: it shows none at 0,0 (an explicit
  // centre given before the upgrade too, which clients draw at the centre either way) and its point otherwise.
  it("shows a row the upgrade carried without a focus at 0,0, and with its point otherwise", async () => {
    const h = await users();
    const { alice } = h.users;
    const media = await uploaded(h, alice, png({ focus: "0,0" }));
    const status = await post(h, alice, { status: "x", media_ids: [media.id] });
    const read = async () =>
      focusOf((await getJson<Shown>(h, `/api/v1/statuses/${status.id}`, alice.token)).body.media_attachments[0]!);
    expect(await read()).toEqual({ x: 0, y: 0 });
    await sql(h.store, "UPDATE media_attachments SET focus_given = 0 WHERE id = ?", media.id);
    expect(await read()).toBeUndefined();
    for (const [x, y] of [
      [0.5, 0],
      [0, -0.25],
    ] as const) {
      await sql(h.store, "UPDATE media_attachments SET focus_x = ?, focus_y = ? WHERE id = ?", x, y, media.id);
      expect(await read()).toEqual({ x, y });
    }
  });

  // UpdateStatusService: a focus given where none was changes the attachment's meta (significantly_changed?), so the
  // edit is recorded, 0,0 included; the same focus again changes nothing.
  it("records an edit that gives a focus where none was shown, 0,0 included, and not one that repeats it", async () => {
    const h = await users();
    const { alice } = h.users;
    const media = await uploaded(h, alice, png());
    const status = await post(h, alice, { status: "x", media_ids: [media.id] });
    const edit = async (focus: string) => {
      const body = { status: "x", media_ids: [media.id], media_attributes: [{ id: media.id, focus }] };
      const response = await h.request(
        `/api/v1/statuses/${status.id}`,
        bearer(alice.token, json(body, { method: "PUT" })),
      );
      return focusOf((await response.json<Shown>()).media_attachments[0]!);
    };
    const versions = async () =>
      (await getJson<Shown[]>(h, `/api/v1/statuses/${status.id}/history`, alice.token)).body.map((v) =>
        focusOf(v.media_attachments[0]!),
      );
    expect(await edit("0,0")).toEqual({ x: 0, y: 0 });
    expect(await versions()).toEqual([undefined, { x: 0, y: 0 }]);
    expect(await edit("0,0")).toEqual({ x: 0, y: 0 });
    expect(await versions()).toEqual([undefined, { x: 0, y: 0 }]);
    expect(await sql(h.store, "SELECT focus_given AS g FROM media_attachments WHERE id = ?", media.id)).toEqual([
      { g: 1 },
    ]);
    // A point given, then an edit of the description alone: the focus shown is kept (focus = nil changes nothing).
    expect(await edit("0.5,-0.25")).toEqual({ x: 0.5, y: -0.25 });
    const described = await h.request(
      `/api/v1/statuses/${status.id}`,
      bearer(
        alice.token,
        json(
          { status: "x", media_ids: [media.id], media_attributes: [{ id: media.id, description: "now described" }] },
          { method: "PUT" },
        ),
      ),
    );
    const kept = (await described.json<{ media_attachments: Attachment[] }>()).media_attachments[0]!;
    expect([kept.description, focusOf(kept)]).toEqual(["now described", { x: 0.5, y: -0.25 }]);
    expect(
      await sql(
        h.store,
        "SELECT focus_x AS x, focus_y AS y, focus_given AS g FROM media_attachments WHERE id = ?",
        media.id,
      ),
    ).toEqual([{ x: 0.5, y: -0.25, g: 1 }]);
  });
});

describe("PATCH and DELETE /api/v1/media/:id", () => {
  it("updates through PATCH as through PUT", async () => {
    const h = await users();
    const { alice, bob } = h.users;
    const media = await uploaded(h, alice, mediaForm(bytes(JPEG_WITH_GPS)));
    const patch = (token: string, body: Record<string, unknown>) =>
      h.request(`/api/v1/media/${media.id}`, bearer(token, json(body, { method: "PATCH" })));
    expect((await patch(bob.token, { description: "mine now" })).status).toBe(404);
    const updated = await patch(alice.token, { description: "patched", focus: "0.5,-0.5" });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ description: "patched", meta: { focus: { x: 0.5, y: -0.5 } } });
    await described(h, patch, alice.token, media.id, "patched");
  });

  it("deletes own unattached media with its R2 objects, and nobody else’s (MEDIA-1)", async () => {
    const h = await users();
    const { alice, bob } = h.users;
    const media = await uploaded(h, alice, mediaForm(bytes(JPEG_WITH_GPS)));
    const keys = await keysOf(h, media.id);
    const destroy = (token: string, id = media.id) =>
      h.request(`/api/v1/media/${id}`, bearer(token, { method: "DELETE" }));
    const foreign = await destroy(bob.token);
    expect([foreign.status, await foreign.json()]).toEqual([404, { error: "Record not found" }]);
    expect((await destroy(alice.token, "999999999999999999")).status).toBe(404);
    expect(await stored(keys)).toEqual(keys);

    const deleted = await destroy(alice.token);
    expect([deleted.status, await deleted.json()]).toEqual([200, {}]);
    expect(await stored(keys)).toEqual([]);
    expect(await row(h, media.id)).toBeUndefined();
    expect((await h.request(pathOf(media.url))).status).toBe(404);
    expect((await destroy(alice.token)).status).toBe(404);
    expect(await posting(h, alice.token, { status: "x", media_ids: [media.id] })).toEqual(mediaNotFound(media.id));
  });

  it("refuses media a status uses, and deletes it once a status deletion detached it", async () => {
    const h = await users();
    const { alice } = h.users;
    const media = await uploaded(h, alice, mediaForm(bytes(JPEG_WITH_GPS)));
    const keys = await keysOf(h, media.id);
    const status = await post(h, alice, { status: "x", media_ids: [media.id] });
    const destroy = () => h.request(`/api/v1/media/${media.id}`, bearer(alice.token, { method: "DELETE" }));
    const refused = await destroy();
    expect([refused.status, await refused.json()]).toEqual([
      422,
      { error: "Media attachment is currently used by a status" },
    ]);
    expect(await stored(keys)).toEqual(keys);
    expect(await row(h, media.id)).toMatchObject({ status_id: status.id });

    // Deleting the status keeps the media for a redraft; deleting the media then removes it at once.
    await h.request(`/api/v1/statuses/${status.id}`, bearer(alice.token, { method: "DELETE" }));
    expect((await destroy()).status).toBe(200);
    expect(await stored(keys)).toEqual([]);
    expect(await row(h, media.id)).toBeUndefined();
  });
});

describe("media an edit drops", () => {
  async function dropped(h: Awaited<ReturnType<typeof users>>) {
    const { alice } = h.users;
    await remoteFollows(h.store, await remoteAccount(h.store, "fan"), alice.id);
    const [kept, drop] = [
      await uploaded(h, alice, mediaForm(bytes(JPEG_WITH_GPS), { description: "kept" })),
      await uploaded(h, alice, mediaForm(bytes(JPEG_WITH_GPS), { description: "dropped" })),
    ];
    const status = await post(h, alice, { status: "two", media_ids: [kept.id, drop.id] });
    const edit = await h.request(
      `/api/v1/statuses/${status.id}`,
      bearer(alice.token, json({ status: "one", media_ids: [kept.id] }, { method: "PUT" })),
    );
    expect(edit.status).toBe(200);
    expect((await edit.json<Status>()).media_attachments).toMatchObject([{ id: kept.id }]);
    return { status, kept, drop, keys: await keysOf(h, drop.id) };
  }

  it("stays with its status for the history, however long after the grace period", async () => {
    const h = await users();
    const { alice, bob } = h.users;
    const { status, kept, drop, keys } = await dropped(h);

    expect(await sweep(h, NOW + 30 * 24 * HOUR)).toBe(0);
    expect(await stored(keys)).toEqual(keys);
    expect(await row(h, drop.id)).toMatchObject({ status_id: status.id, gc_at: null });
    const history = await getJson<{ media_attachments: { id: string; url: string }[] }[]>(
      h,
      `/api/v1/statuses/${status.id}/history`,
      bob.token,
    );
    expect(history.body.map((version) => version.media_attachments.map((m) => m.id))).toEqual([
      [kept.id, drop.id],
      [kept.id],
    ]);
    expect(history.body[0]?.media_attachments[1]?.url).toBe(drop.url);
    expect((await h.request(pathOf(drop.url))).status).toBe(200);
    // The status shows only what it shows now, in the API and in the Update.
    expect((await getJson<Status>(h, `/api/v1/statuses/${status.id}`, bob.token)).body.media_attachments).toMatchObject(
      [{ id: kept.id }],
    );
    // The activity the edit recorded (an Update, or the Create of the current version still pending) carries it.
    const latest = (await outbound(h.store)).at(-1)?.activity.object as { attachment: { url: string }[] };
    expect(latest.attachment.map((a) => a.url)).toEqual([kept.url]);
    // It is the status's: neither shown, updated nor deleted as an upload.
    expect((await h.request(`/api/v1/media/${drop.id}`, bearer(alice.token))).status).toBe(404);
    const destroy = await h.request(`/api/v1/media/${drop.id}`, bearer(alice.token, { method: "DELETE" }));
    expect([destroy.status, await destroy.json()]).toEqual([
      422,
      { error: "Media attachment is currently used by a status" },
    ]);
  });

  it("may be shown again by a later edit of the same status, and by nothing else", async () => {
    const h = await users();
    const { alice } = h.users;
    const { status, kept, drop } = await dropped(h);

    expect(await posting(h, alice.token, { status: "other", media_ids: [drop.id] })).toEqual(mediaNotFound(drop.id));
    const scheduled = await posting(h, alice.token, {
      status: "later",
      media_ids: [drop.id],
      scheduled_at: new Date(NOW + HOUR).toISOString(),
    });
    expect(scheduled).toEqual(mediaNotFound(drop.id));
    expect(await sql(h.store, "SELECT id FROM scheduled_statuses")).toEqual([]);
    // An edit of another status cannot take it: the edit target is a status made without it.
    const other = await post(h, alice, { status: "other" });
    const otherEdit = await h.request(
      `/api/v1/statuses/${other.id}`,
      bearer(alice.token, json({ status: "other", media_ids: [drop.id] }, { method: "PUT" })),
    );
    expect({ status: otherEdit.status, body: await otherEdit.json() }).toEqual(mediaNotFound(drop.id));
    expect(await row(h, drop.id)).toMatchObject({ status_id: status.id });

    const again = await h.request(
      `/api/v1/statuses/${status.id}`,
      bearer(alice.token, json({ status: "both", media_ids: [drop.id, kept.id] }, { method: "PUT" })),
    );
    expect(again.status).toBe(200);
    expect((await again.json<Status>()).media_attachments).toMatchObject([{ id: drop.id }, { id: kept.id }]);
  });

  it("goes with its status, after the grace period or at once with delete_media", async () => {
    for (const deleteMedia of [false, true]) {
      const h = await users();
      const { alice } = h.users;
      const { status, kept, drop, keys } = await dropped(h);
      const deleted = await h.request(
        `/api/v1/statuses/${status.id}${deleteMedia ? "?delete_media=true" : ""}`,
        bearer(alice.token, { method: "DELETE" }),
      );
      expect(deleted.status).toBe(200);
      expect((await deleted.json<Status>()).media_attachments).toMatchObject([{ id: kept.id }]);
      // The answer's media is detached at once, the media the edit dropped by the status's job, with the same
      // deadline (MEDIA-1).
      expect(await sql(h.store, "SELECT id FROM media_attachments WHERE status_id IS NOT NULL")).toEqual([
        { id: drop.id },
      ]);
      await settle(h.store);
      expect(await sql(h.store, "SELECT id FROM media_attachments WHERE status_id IS NOT NULL")).toEqual([]);
      expect(new Set((await sql(h.store, "SELECT gc_at FROM media_attachments")).map((m) => m.gc_at)).size).toBe(1);
      if (!deleteMedia) {
        expect(await sweep(h, NOW + 23 * HOUR)).toBe(0);
        expect(await stored(keys)).toEqual(keys);
      }
      // With delete_media the sweep after the answer took the media it doomed; the media its job doomed goes with the
      // next sweep.
      expect(await sweep(h, NOW + 25 * HOUR)).toBe(deleteMedia ? 1 : 2);
      expect(await stored(keys)).toEqual([]);
      expect(await row(h, drop.id)).toBeUndefined();
      expect(await row(h, kept.id)).toBeUndefined();
    }
  });
});

describe("media the cutover kept", () => {
  it("refuses to delete an image the cutover kept unattached, and keeps its files", async () => {
    const h = await users();
    const { alice } = h.users;
    const status = await post(h, alice, { status: "edited" });
    // A row migration 0015_media_shown did not link to a status: unattached and processed, of the author, with a
    // file token and no gc_at. The earlier version naming it is written after the Store was migrated.
    const id = "100000000000000088";
    const token = "E".repeat(43);
    const url = `https://kopje.test/media/${token}/full.png`;
    await sql(
      h.store,
      `INSERT INTO media_attachments (id, account_id, status_id, position, type, url, preview_url, description, meta,
				file_token, content_type, processed, legacy_ap_o, created_at)
			VALUES (?, ?, NULL, 0, 'image', ?, ?, '', NULL, ?, 'image/png', 1, NULL, ?)`,
      id,
      alice.id,
      url,
      `https://kopje.test/media/${token}/small.png`,
      token,
      new Date(NOW).toISOString(),
    );
    await sql(
      h.store,
      "INSERT INTO status_edits (status_id, content, media_json, created_at) VALUES (?, ?, ?, ?)",
      status.id,
      "<p>before</p>",
      JSON.stringify([{ id, type: "image", url }]),
      new Date(NOW).toISOString(),
    );
    const keys = [`files/${token}/full`, `files/${token}/small`, `originals/${id}`];
    for (const key of keys) {
      await env.MEDIA.put(key, bytes(PNG_PLAIN));
    }

    const refused = await h.request(`/api/v1/media/${id}`, bearer(alice.token, { method: "DELETE" }));
    expect([refused.status, await refused.json()]).toEqual([
      422,
      { error: "Media attachment is currently used by a status" },
    ]);
    expect(await row(h, id)).toMatchObject({ status_id: null, gc_at: null });
    expect(await sweep(h, NOW + 30 * 24 * HOUR)).toBe(0);
    expect(await stored(keys)).toEqual(keys);
  });
});

describe("explicit deletion", () => {
  it("is final for a post or schedule that started before it", async () => {
    const h = await users();
    const { alice } = h.users;
    const [deleted, held, viaStatus] = [
      await uploaded(h, alice, mediaForm(bytes(JPEG_WITH_GPS))),
      await uploaded(h, alice, mediaForm(bytes(JPEG_WITH_GPS))),
      await uploaded(h, alice, mediaForm(bytes(JPEG_WITH_GPS))),
    ];
    const status = await post(h, alice, { status: "x", media_ids: [viaStatus.id] });
    // The Store commits the deletions at a later time than the requests below carry (the harness clock stays at
    // NOW). They are called directly, so no sweep removes the rows before those requests run.
    const later = NOW + 60_000;
    const credential = { tokenHash: await sha256Hex(alice.token), scope: "write", now: later } as const;
    for (const id of [deleted.id, held.id]) {
      expect(await h.store.deleteMedia(BUILD, { credential, id, now: later })).toEqual({
        status: "ok",
        value: "deleted",
      });
    }
    const removed = await h.store.deleteStatus(BUILD, {
      credential,
      id: status.id,
      deleteMedia: true,
      signed: await deleteSignature(h.store, credential, status.id),
      now: later,
      present: { origin: "https://kopje.test" },
    });
    expect(removed.status).toBe("ok");

    expect(await posting(h, alice.token, { status: "late", media_ids: [deleted.id, viaStatus.id] })).toEqual(
      mediaNotFound(deleted.id, viaStatus.id),
    );
    const scheduled = await posting(h, alice.token, {
      status: "later",
      media_ids: [held.id],
      scheduled_at: new Date(NOW + HOUR).toISOString(),
    });
    expect(scheduled).toEqual(mediaNotFound(held.id));
    expect(await sql(h.store, "SELECT id FROM statuses WHERE id <> ?", status.id)).toEqual([]);
    expect(
      await sql(
        h.store,
        "SELECT id FROM media_attachments WHERE status_id IS NOT NULL OR scheduled_status_id IS NOT NULL",
      ),
    ).toEqual([]);
    // The sweep then deletes all three.
    expect(await sweep(h, NOW)).toBe(3);
  });
});

describe("GET /media/:token/:file", () => {
  it("serves only well-formed paths of served files (MEDIA-2, unsafe R2 key)", async () => {
    const h = await users();
    const media = await uploaded(h, h.users.alice, mediaForm(bytes(JPEG_WITH_GPS)));
    const token = (/\/media\/([^/]+)\//.exec(media.url ?? "") ?? [])[1] ?? "";
    for (const path of [
      `/media/${token}/original.jpg`,
      `/media/${token}/full.html`,
      `/media/${token}/full`,
      `/media/${token}%2F..%2F..%2Foriginals%2F${media.id}/full.jpg`,
      `/media/..%2Foriginals%2F${media.id}/full.jpg`,
      `/media/originals/${media.id}`,
      `/media/${token}/../../originals/${media.id}`,
      `/media/${"A".repeat(43)}/full.jpg`,
    ]) {
      const response = await h.request(path);
      expect(response.status, path).toBe(404);
      expect(response.headers.get("content-type"), path).not.toMatch(/^image\//);
    }
  });

  it("never serves a stored object of another type, whatever its metadata says (MEDIA-4)", async () => {
    const h = await users();
    const token = "B".repeat(43);
    await env.MEDIA.put(`files/${token}/full`, "<script>alert(1)</script>", {
      httpMetadata: { contentType: "text/html" },
    });
    await env.MEDIA.put(`files/${token}/small`, "<svg/>", { httpMetadata: { contentType: "image/svg+xml" } });
    expect((await h.request(`/media/${token}/full.jpg`)).status).toBe(404);
    expect((await h.request(`/media/${token}/small.webp`)).status).toBe(404);
    // A served type under the wrong extension is refused too.
    await env.MEDIA.put(`files/${token}/full`, bytes(WIDE_PNG), { httpMetadata: { contentType: "image/png" } });
    expect((await h.request(`/media/${token}/full.jpg`)).status).toBe(404);
    const png = await h.request(`/media/${token}/full.png`);
    expect(png.status).toBe(200);
    expect(png.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
  });

  // P14, MEDIA-4, WEB-5: the processor's output, written to R2 here as PR4's upload will write it.
  it("serves ranges of a local video", async () => {
    const h = await users();
    const token = "V".repeat(43);
    const video = await avFixture("r1-av.mp4");
    const audio = await avFixture("m4a.mp3");
    await env.MEDIA.put(`files/${token}/full`, video, { httpMetadata: { contentType: "video/mp4" } });
    const size = video.length;
    const fixed = {
      "content-type": "video/mp4",
      "accept-ranges": "bytes",
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "cross-origin",
      "access-control-allow-origin": "*",
    };
    const url = `/media/${token}/full.mp4`;
    const whole = await h.request(url);
    expect(whole.status).toBe(200);
    expect(Object.fromEntries(whole.headers)).toMatchObject({ ...fixed, "content-length": String(size) });
    expect(new Uint8Array(await whole.arrayBuffer())).toEqual(video);
    const etag = whole.headers.get("etag") ?? "";
    expect(etag).not.toBe("");

    // HEAD from the object's head: the length, no body.
    const head = await h.request(url, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(Object.fromEntries(head.headers)).toMatchObject({ ...fixed, "content-length": String(size), etag });
    expect((await head.arrayBuffer()).byteLength).toBe(0);

    // One satisfiable and one unsatisfiable range; the remote route's tests cover the other spellings through the same
    // serveObject.
    for (const [range, status, contentRange, from, to] of [
      ["bytes=0-99", 206, `bytes 0-99/${size}`, 0, 100],
      [`bytes=${size}-`, 416, `bytes */${size}`, 0, 0],
    ] as const) {
      const response = await h.request(url, { headers: { range } });
      expect(response.status, range).toBe(status);
      expect(response.headers.get("content-range"), range).toBe(contentRange);
      expect(response.headers.get("x-content-type-options"), range).toBe("nosniff");
      expect(response.headers.get("content-security-policy"), range).toBe("default-src 'none'; sandbox");
      expect(new Uint8Array(await response.arrayBuffer()), range).toEqual(video.slice(from, to));
    }
    for (const method of ["GET", "HEAD"]) {
      const response = await h.request(url, { method, headers: { "if-none-match": etag } });
      expect(response.status, method).toBe(304);
      expect(response.headers.get("cache-control"), method).toBe(fixed["cache-control"]);
    }
    // If-None-Match before Range (RFC 9110 13.2.2): a matching tag is 304 whatever the range.
    for (const [range, tag, status] of [
      ["bytes=-0", etag, 304],
      ["bytes=0-9", etag, 304],
      ["bytes=-0", '"other"', 416],
    ] as const) {
      const response = await h.request(url, { headers: { range, "if-none-match": tag } });
      expect(response.status, `${range} ${tag}`).toBe(status);
    }

    // Only as full, and only under its own type's extension.
    await env.MEDIA.put(`files/${token}/small`, video, { httpMetadata: { contentType: "video/mp4" } });
    for (const path of [`/media/${token}/small.mp4`, `/media/${token}/small.mp3`, `/media/${token}/full.mp3`]) {
      for (const method of ["GET", "HEAD"]) {
        const response = await h.request(path, { method, headers: { range: "bytes=0-9" } });
        expect(response.status, `${method} ${path}`).toBe(404);
        expect(response.headers.get("content-type"), path).not.toMatch(/^video\//);
      }
    }
    // A stored type the extension does not name is refused, whatever its metadata says.
    await env.MEDIA.put(`files/${token}/full`, "<script>alert(1)</script>", {
      httpMetadata: { contentType: "text/html" },
    });
    expect((await h.request(url)).status).toBe(404);
    expect((await h.request(url, { headers: { range: `bytes=${size}-` } })).status).toBe(404);

    // MP3 as audio/mpeg.
    await env.MEDIA.put(`files/${token}/full`, audio, { httpMetadata: { contentType: "audio/mpeg" } });
    const mp3 = await h.request(`/media/${token}/full.mp3`, { headers: { range: "bytes=0-3" } });
    expect(mp3.status).toBe(206);
    expect(mp3.headers.get("content-type")).toBe("audio/mpeg");
    expect(new Uint8Array(await mp3.arrayBuffer())).toEqual(audio.slice(0, 4));
    expect((await h.request(url)).status).toBe(404);
  });
});

describe("media lifecycle", () => {
  it("deletes the R2 objects of a status deleted with delete_media, and federates the Delete", async () => {
    const h = await users();
    const { alice } = h.users;
    await remoteFollows(h.store, await remoteAccount(h.store, "fan"), alice.id);
    const media = await uploaded(h, alice, mediaForm(bytes(JPEG_WITH_GPS)));
    const keys = await keysOf(h, media.id);
    const status = await post(h, alice, { status: "x", media_ids: [media.id] });
    const deleted = await h.request(
      `/api/v1/statuses/${status.id}?delete_media=true`,
      bearer(alice.token, { method: "DELETE" }),
    );
    expect(deleted.status).toBe(200);
    expect(await stored(keys)).toEqual([]);
    expect(await row(h, media.id)).toBeUndefined();
    expect((await h.request(pathOf(media.url))).status).toBe(404);
    const activities = (await outbound(h.store)).map((o) => o.activity);
    expect(activities.map((a) => a.type)).toEqual(["Create", "Delete"]);
    expect(activities[1]?.object).toMatchObject({ id: status.uri });
  });

  it("keeps detached media for a redraft, then sweeps it after the grace period", async () => {
    const h = await users();
    const { alice } = h.users;
    const media = await uploaded(h, alice, mediaForm(bytes(JPEG_WITH_GPS)));
    const keys = await keysOf(h, media.id);
    const status = await post(h, alice, { status: "x", media_ids: [media.id] });
    await h.request(`/api/v1/statuses/${status.id}`, bearer(alice.token, { method: "DELETE" }));
    expect(await sweep(h, NOW + 23 * HOUR)).toBe(0);
    expect(await stored(keys)).toEqual(keys);
    const redraft = await post(h, alice, { status: "again", media_ids: [media.id] });
    expect(redraft.media_attachments).toMatchObject([{ id: media.id }]);

    // Deleted again, it is detached again; after a day it can no longer be attached and is swept.
    await h.request(`/api/v1/statuses/${redraft.id}`, bearer(alice.token, { method: "DELETE" }));
    expect(await row(h, media.id)).toMatchObject({ status_id: null });
    expect(await sweep(h, NOW + 25 * HOUR)).toBe(1);
    expect(await stored(keys)).toEqual([]);
    expect(await row(h, media.id)).toBeUndefined();
  });

  it("sweeps a reservation that never completed, and leaves attached media alone", async () => {
    const h = await users();
    const { alice } = h.users;
    const kept = await uploaded(h, alice, mediaForm(bytes(JPEG_WITH_GPS)));
    await post(h, alice, { status: "x", media_ids: [kept.id] });
    await sql(
      h.store,
      `INSERT INTO media_attachments (id, account_id, type, url, file_token, processed, gc_at)
			VALUES ('100000000000000077', ?, 'image', '', ?, 0, ?)`,
      alice.id,
      "C".repeat(43),
      new Date(NOW + HOUR).toISOString(),
    );
    await env.MEDIA.put("originals/100000000000000077", "partial");
    expect(await sweep(h, NOW + 30 * 60 * 1000)).toBe(0);
    expect(await sweep(h, NOW + 2 * HOUR)).toBe(1);
    expect(await env.MEDIA.head("originals/100000000000000077")).toBeNull();
    expect(await stored(await keysOf(h, kept.id))).toHaveLength(3);
    expect(await r2Keys(`originals/${kept.id}`)).toEqual([`originals/${kept.id}`]);
  });

  it("runs the sweep from the cron, but not while the env sets maintenance", async () => {
    const h = await users();
    const media = await uploaded(h, h.users.alice, mediaForm(bytes(JPEG_WITH_GPS)));
    const keys = await keysOf(h, media.id);
    const deps = { build: () => env.CF_VERSION_METADATA.id, now: () => NOW + 25 * HOUR, store: () => h.store };
    await handleScheduled({ ...env, MAINTENANCE: "readonly" } as Env, deps);
    expect(await stored(keys)).toEqual(keys);
    await handleScheduled(env, deps);
    expect(await stored(keys)).toEqual([]);
    expect(await row(h, media.id)).toBeUndefined();
  });

  it("presents media in statuses with meta, and publishes its type in the Note", async () => {
    const h = await users();
    await remoteFollows(h.store, await remoteAccount(h.store, "fan"), h.users.alice.id);
    const media = await uploaded(h, h.users.alice, mediaForm(bytes(JPEG_WITH_GPS)));
    const status = await post(h, h.users.alice, { status: "x", media_ids: [media.id] });
    expect(status.media_attachments).toEqual([media]);
    const [create] = await outbound(h.store);
    expect((create!.activity.object as { attachment: unknown }).attachment).toEqual([
      { type: "Document", mediaType: "image/webp", url: media.url, name: null, blurhash: media.blurhash },
    ]);
  });
});

// The blurhash of a local upload (platform/images.ts processImage): its preview's, stored, presented and published in
// the Note's Document with Mastodon's toot:blurhash term; any failure of the RGBA output keeps the upload without one.
describe("the blurhash of a local upload", () => {
  const AP = { headers: { accept: "application/activity+json" } };
  const formats = (codec: TestCodec) => codec.outputs.map((call) => call.options.format);

  async function storedBlurhash(h: { store: Parameters<typeof sql>[0] }, id: string): Promise<unknown> {
    return (
      await sql<{ blurhash: string | null }>(h.store, "SELECT blurhash FROM media_attachments WHERE id = ?", id)
    )[0]?.blurhash;
  }

  it("agrees in the upload answer, GET and the stored row", async () => {
    const h = await users();
    const media = await uploaded(h, h.users.alice, mediaForm(bytes(WIDE_PNG), {}, "w.png", "image/png"));
    expect(media.blurhash).toMatch(/^U.{35}$/);
    const got = await getJson<{ blurhash: string | null }>(h, `/api/v1/media/${media.id}`, h.users.alice.token);
    expect(got.body.blurhash).toBe(media.blurhash);
    expect(await storedBlurhash(h, media.id)).toBe(media.blurhash);
  });

  it.each([9520, 9422])("keeps the upload without one when the RGBA output fails with %i", async (code) => {
    const h = await users();
    h.codec.failRgba = code;
    const warn = vi.spyOn(console, "warn");
    const response = await upload(h, h.users.alice, mediaForm(bytes(WIDE_PNG), {}, "w.png", "image/png"));
    expect(response.status).toBe(200);
    const media = await response.json<Attachment>();
    expect(formats(h.codec)).toEqual(["image/png", "image/png", "rgba"]);
    expect(media.blurhash).toBeNull();
    expect(await storedBlurhash(h, media.id)).toBeNull();
    expect((await h.request(pathOf(media.url))).status).toBe(200);
    expect((await h.request(pathOf(media.preview_url))).status).toBe(200);
    expect(warn).toHaveBeenCalledWith({ event: "kopje.media.no_blurhash" });
    warn.mockRestore();
  });

  it.each(["output", "read"] as const)(
    "gives up a stalled RGBA %s before the save reserve and saves the upload without one",
    async (stall) => {
      const h = await users();
      h.codec.stallRgba = stall;
      // Once the preview is made, the clock stands just past RGBA_MIN_CALL_MS before the RGBA output's end.
      const late = NOW + 15 * 60 * 1000 - UPLOAD_SAVE_RESERVE_MS - RGBA_MIN_CALL_MS - 300;
      const encode = h.codec.encode.bind(h.codec);
      h.codec.encode = async (input, options) => {
        const output = await encode(input, options);
        if (options.still === true) {
          h.now.mockReturnValue(late);
        }
        return output;
      };
      const response = await upload(h, h.users.alice, mediaForm(bytes(WIDE_PNG), {}, "w.png", "image/png"));
      expect(response.status).toBe(200);
      const media = await response.json<Attachment>();
      expect(formats(h.codec)).toEqual(["image/png", "image/png", "rgba"]);
      expect(media.blurhash).toBeNull();
      expect(h.codec.rgbaCancelled).toBe(stall === "read" ? 1 : 0);
      expect((await h.request(pathOf(media.url))).status).toBe(200);
    },
    30_000,
  );

  it.each(["output", "read"] as const)(
    "gives up a stalled RGBA %s RGBA_CALL_MS after it starts, long before the save reserve, and saves without one",
    async (stall) => {
      const h = await users();
      h.codec.stallRgba = stall;
      // Once the preview is made, a minute after the reservation, each reading of the clock is RGBA_CALL_MS - 300 ms
      // later: the RGBA guard has 300 ms of its cap left, with the save reserve thirteen minutes away.
      const encode = h.codec.encode.bind(h.codec);
      h.codec.encode = async (input, options) => {
        const output = await encode(input, options);
        if (options.still === true) {
          let reads = 0;
          h.now.mockImplementation(() => NOW + 60_000 + reads++ * (RGBA_CALL_MS - 300));
        }
        return output;
      };
      const started = Date.now();
      const response = await upload(h, h.users.alice, mediaForm(bytes(WIDE_PNG), {}, "w.png", "image/png"));
      expect(Date.now() - started).toBeLessThan(25_000);
      expect(response.status).toBe(200);
      const media = await response.json<Attachment>();
      expect(formats(h.codec)).toEqual(["image/png", "image/png", "rgba"]);
      expect(media.blurhash).toBeNull();
      expect(h.codec.rgbaCancelled).toBe(stall === "read" ? 1 : 0);
      expect((await h.request(pathOf(media.url))).status).toBe(200);
    },
    30_000,
  );

  it("charges as many transformations as the upload asked Images for", async () => {
    const h = await users();
    const counters = async () =>
      (
        await sql<{ value: string }>(
          h.store,
          "SELECT value FROM kopje_state WHERE name LIKE 'images%transforms:%' ORDER BY name",
        )
      ).map((row) => Number(row.value));
    expect((await upload(h, h.users.alice, mediaForm(bytes(WIDE_PNG), {}, "w.png", "image/png"))).status).toBe(200);
    expect(h.codec.encodeCalls).toHaveLength(3);
    expect(await counters()).toEqual([3, 3]);
  });

  it("publishes a blurhash in each Document that has one, with Mastodon's term, in the Create, Update and outbox", async () => {
    const h = await users();
    const { alice } = h.users;
    await remoteFollows(h.store, await remoteAccount(h.store, "fan"), alice.id);
    const hashed = await uploaded(h, alice, mediaForm(bytes(WIDE_PNG), {}, "w.png", "image/png"));
    h.codec.failRgba = 9520;
    const bare = await uploaded(h, alice, mediaForm(bytes(PNG_PLAIN), {}, "p.png", "image/png"));
    const plain = await uploaded(h, alice, mediaForm(bytes(PNG_PLAIN), {}, "p.png", "image/png"));
    const both = await post(h, alice, { status: "both", media_ids: [hashed.id, bare.id] });
    await post(h, alice, { status: "none", media_ids: [plain.id] });
    await h.request(
      `/api/v1/statuses/${both.id}`,
      bearer(alice.token, json({ status: "both, edited", media_ids: [hashed.id, bare.id] }, { method: "PUT" })),
    );
    const sent = await outbound(h.store);
    type Note = { attachment: Record<string, unknown>[] };
    const documents = (activity: Record<string, unknown> | undefined) => (activity!.object as Note).attachment;
    const contextOf = (activity: Record<string, unknown> | undefined) =>
      (activity!["@context"] as [string, Record<string, unknown>])[1];
    const find = (type: string, content: string) =>
      sent.find(
        (item) =>
          item.activity.type === type && (item.activity.object as { content: string }).content.includes(content),
      )?.activity;
    const [create, none, update] = [find("Create", "both"), find("Create", "none"), find("Update", "edited")];
    for (const activity of [create, update]) {
      expect(documents(activity)).toEqual([
        expect.objectContaining({ url: hashed.url, blurhash: hashed.blurhash }),
        expect.not.objectContaining({ blurhash: expect.anything() }),
      ]);
      expect(contextOf(activity)).toMatchObject({ toot: "http://joinmastodon.org/ns#", blurhash: "toot:blurhash" });
    }
    expect(documents(none)).toEqual([expect.not.objectContaining({ blurhash: expect.anything() })]);
    expect(contextOf(none)).not.toHaveProperty("blurhash");
    // The object endpoint, the outbox and the featured collection read the Note again through Fedify, which serves the
    // JSON-LD it read: each keeps the blurhash and the term.
    const TERM = { toot: "http://joinmastodon.org/ns#", blurhash: "toot:blurhash" };
    type Served = Note & { id: string; "@context": [string, Record<string, unknown>] };
    const expected = [
      expect.objectContaining({ url: hashed.url, blurhash: hashed.blurhash }),
      expect.not.objectContaining({ blurhash: expect.anything() }),
    ];
    const served = await (await h.request(new URL(both.uri as string).pathname, AP)).json<Served>();
    expect(served.attachment).toEqual(expected);
    expect(served["@context"][1]).toMatchObject(TERM);
    const outbox = await (await h.request("/ap/users/alice/outbox", AP)).json<{ first: string }>();
    const first = new URL(outbox.first);
    const page = await (
      await h.request(first.pathname + first.search, AP)
    ).json<{
      orderedItems: { "@context": [string, Record<string, unknown>]; object: Served }[];
    }>();
    const listed = page.orderedItems.find((item) => item.object.id === both.uri);
    expect(listed?.object.attachment).toEqual(expected);
    expect(listed?.["@context"][1]).toMatchObject(TERM);
    await h.request(`/api/v1/statuses/${both.id}/pin`, bearer(alice.token, { method: "POST" }));
    const featured = await (
      await h.request("/ap/users/alice/collections/featured", AP)
    ).json<{
      orderedItems: Served[];
    }>();
    const pinned = featured.orderedItems.find((item) => item.id === both.uri);
    expect(pinned?.attachment).toEqual(expected);
    expect(pinned?.["@context"][1]).toMatchObject(TERM);
  });
});

// #1828 plan Q1, the Store's side: on the active path (avCandidate, passed by the media upload route alone with the
// processor bound and a positive upload budget, and a passed normalize probe for its build) a reservation is not
// refused for the Images budgets: it counts the attempt and names the budget an image would be refused for, the
// account's share first. Otherwise, and for every route of this release, it is today's reservation.
describe("the active path's reservation (Q1)", () => {
  const month = new Date(NOW).toISOString().slice(0, 7);

  async function world(probe: string | null) {
    const h = await users();
    if (probe !== null) {
      await sql(
        h.store,
        "INSERT INTO kopje_state (name, value) VALUES ('media_probe:normalize@standard-4', ?)",
        JSON.stringify({ version: probe, imageTag: null, at: NOW, ok: true, imagesVerified: true }),
      );
    }
    const credential = { tokenHash: await sha256Hex(h.users.alice.token), scope: "write:media" as const, now: NOW };
    const reserve = (monthlyTransforms: { instance: number; account: number }, avCandidate?: { build: string }) =>
      h.store.reserveMedia(BUILD, {
        credential,
        token: `q1${crypto.randomUUID().replaceAll("-", "")}`,
        monthlyTransforms,
        avCandidate,
        now: NOW,
      });
    const attempts = async () => {
      const [found] = await sql<{ value: string }>(
        h.store,
        "SELECT value FROM kopje_state WHERE name = ?",
        `media_attempts:${h.users.alice.id}`,
      );
      return found === undefined ? 0 : (JSON.parse(found.value) as number[]).length;
    };
    return { h, reserve, attempts };
  }

  it("inactive: Images spent answers today's refusal, no attempt counted", async () => {
    const w = await world(null);
    expect(await w.reserve({ instance: 0, account: 400 }, { build: BUILD })).toEqual({
      status: "ok",
      value: { status: "budget_exhausted", scope: "instance" },
    });
    expect(await w.attempts()).toBe(0);
    // A pass for another build is no pass for this one.
    const other = await world("another-build");
    expect(await other.reserve({ instance: 400, account: 0 }, { build: BUILD })).toEqual({
      status: "ok",
      value: { status: "budget_exhausted", scope: "account" },
    });
    expect(await other.attempts()).toBe(0);
  });

  it("active: counts the attempt and answers account, account first when both are spent", async () => {
    const w = await world(BUILD);
    expect(await w.reserve({ instance: 0, account: 0 }, { build: BUILD })).toMatchObject({
      status: "ok",
      value: { status: "ok", imagesRefusal: "account" },
    });
    expect(await w.attempts()).toBe(1);
  });

  it("active: answers instance with the account's share left, and null with room in both", async () => {
    const w = await world(BUILD);
    expect(await w.reserve({ instance: 0, account: 400 }, { build: BUILD })).toMatchObject({
      value: { status: "ok", imagesRefusal: "instance" },
    });
    expect(await w.reserve({ instance: 4000, account: 400 }, { build: BUILD })).toMatchObject({
      value: { status: "ok", imagesRefusal: null },
    });
    // Without avCandidate the same reservation is today's: no imagesRefusal.
    const today = await w.reserve({ instance: 4000, account: 400 });
    expect(today).toMatchObject({ value: { status: "ok" } });
    expect(today.status === "ok" && today.value.status === "ok" && "imagesRefusal" in today.value).toBe(false);
    expect(await w.attempts()).toBe(3);
  });

  it("the attempt budget still refuses first on the active path", async () => {
    const w = await world(BUILD);
    for (let i = 0; i < UPLOAD_BUDGET.count; i++) {
      await w.reserve({ instance: 0, account: 0 }, { build: BUILD });
    }
    expect(await w.reserve({ instance: 0, account: 0 }, { build: BUILD })).toEqual({
      status: "ok",
      value: { status: "rate_limited" },
    });
  });

  it("no route passes avCandidate: an image upload and a profile image with Images spent answer today's 429", async () => {
    const w = await world(BUILD);
    await sql(w.h.store, "INSERT INTO kopje_state (name, value) VALUES (?, '4000')", `images_transforms:${month}`);
    const refused = await upload(w.h, w.h.users.alice, mediaForm(bytes(PNG_PLAIN), {}, "a.png", "image/png"));
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "This server's media processing budget for the month is used up" });
    const avatar = new FormData();
    avatar.append("avatar", new File([bytes(PNG_PLAIN)], "a.png", { type: "image/png" }));
    const profile = await w.h.request("/api/v1/accounts/update_credentials", {
      method: "PATCH",
      body: avatar,
      headers: { authorization: `Bearer ${w.h.users.alice.token}` },
    });
    expect(profile.status).toBe(429);
    expect(await w.attempts()).toBe(0);
    expect(await sql(w.h.store, "SELECT count(*) AS n FROM media_attachments")).toEqual([{ n: 0 }]);
  });
});
