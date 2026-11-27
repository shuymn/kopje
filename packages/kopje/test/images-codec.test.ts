import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { imageBlurhash } from "../src/platform/blurhash";
import { DeadlinePassed, within } from "../src/platform/deadline";
import { isAnimated } from "../src/platform/image-bytes";
import {
  AVATAR_EDGE,
  type CallGuard,
  type EncodeOptions,
  HEADER_PIXELS,
  ImageCodecError,
  imagesCodec,
  PREVIEW_RGBA_LIMIT,
  processImage,
  type ProcessOptions,
  RGBA_CALL_MS,
  RGBA_MIN_CALL_MS,
  SMALL_EDGE,
  stillEncodes,
} from "../src/platform/images";
import {
  ANIMATED_GIF,
  ANIMATED_WEBP,
  APNG,
  GIF,
  JPEG_SERIAL,
  PNG_PLAIN,
  WEBP_PLAIN,
  WIDE_PNG,
} from "./fixtures/images";
import { fakeBinding } from "./images-binding";
import { bytes, columnsPng, recordRgba, TestCodec } from "./media-helpers";
import { animatedWebp } from "./remote-media-fixtures";
import { encodeWebp } from "./webp-fixtures";

// The chunks of a PNG (type, data) and of a WebP, walked plainly to check the fixtures.
function pngChunks(file: Uint8Array): { type: string; data: Uint8Array }[] {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const chunks = [];
  for (let i = 8; i + 12 <= file.length; i += 12 + view.getUint32(i)) {
    const length = view.getUint32(i);
    chunks.push({
      type: String.fromCharCode(...file.subarray(i + 4, i + 8)),
      data: file.subarray(i + 8, i + 8 + length),
    });
  }
  return chunks;
}

function webpChunks(file: Uint8Array): string[] {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const chunks = [];
  for (let i = 12; i + 8 <= file.length;) {
    const length = view.getUint32(i + 4, true);
    chunks.push(String.fromCharCode(...file.subarray(i, i + 4)));
    i += 8 + length + (length % 2);
  }
  return chunks;
}

// The image descriptors of a GIF (GIF89a: header, logical screen descriptor, global colour table, then blocks).
function gifFrames(file: Uint8Array): number {
  let i = 13 + ((file[10] ?? 0) & 0x80 ? 3 * 2 ** (((file[10] ?? 0) & 7) + 1) : 0);
  const subBlocks = () => {
    while ((file[i] ?? 0) !== 0) {
      i += (file[i] ?? 0) + 1;
    }
    i += 1;
  };
  let frames = 0;
  while (i < file.length && file[i] !== 0x3b) {
    if (file[i] === 0x21) {
      i += 2;
      subBlocks();
    } else if (file[i] === 0x2c) {
      const packed = file[i + 9] ?? 0;
      i += 10 + (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0) + 1;
      subBlocks();
      frames++;
    } else {
      throw new Error(`unexpected GIF block at ${i}`);
    }
  }
  return frames;
}

type Recorded = { input: number; transforms: unknown[]; output: unknown[] };

// An ImagesBinding that records what the adapter asks for and answers with `answer`, or fails with `fail`.
function recordingBinding(answer: Uint8Array, fail?: { code: number; message: string }) {
  const recorded: Recorded = { input: 0, transforms: [], output: [] };
  const transformer = {
    transform(transform: unknown) {
      recorded.transforms.push(transform);
      return transformer;
    },
    output(options: unknown) {
      recorded.output.push(options);
      if (fail !== undefined) {
        return Promise.reject(Object.assign(new Error(fail.message), { code: fail.code }));
      }
      return Promise.resolve({ image: () => new Blob([answer]).stream(), contentType: () => "image/webp" });
    },
  };
  const binding = {
    info: () => Promise.resolve({ format: "image/webp", width: 3, height: 2, fileSize: answer.length }),
    input: () => {
      recorded.input++;
      return transformer;
    },
  };
  return { binding: binding as unknown as ImagesBinding, recorded };
}

describe("imagesCodec", () => {
  it("asks for anim: true only for a WebP output without `still`", async () => {
    const { binding, recorded } = recordingBinding(bytes(WEBP_PLAIN));
    const codec = imagesCodec(binding);
    expect(await codec.encode(bytes(PNG_PLAIN), { width: 4, height: 3, format: "image/webp", still: true })).toEqual(
      bytes(WEBP_PLAIN),
    );
    await codec.encode(bytes(PNG_PLAIN), { format: "image/webp" });
    await codec.encode(bytes(PNG_PLAIN), { format: "image/png" });
    expect(recorded).toEqual({
      input: 3,
      transforms: [{ width: 4, height: 3, fit: "scale-down" }],
      output: [
        { format: "image/webp", anim: false },
        { format: "image/webp", anim: true },
        { format: "image/png", anim: false },
      ],
    });
    expect(await codec.info(bytes(WEBP_PLAIN))).toMatchObject({ format: "image/webp", width: 3, height: 2 });
  });

  it("maps a binding error to its Images code", async () => {
    const { binding } = recordingBinding(new Uint8Array(), { code: 9422, message: "quota" });
    const error = await imagesCodec(binding)
      .encode(bytes(PNG_PLAIN), { format: "image/png" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImageCodecError);
    expect(error).toMatchObject({ code: 9422, message: "quota" });
  });
});

describe("animated fixtures", () => {
  it("are decoded by the local binding and really hold two frames", async () => {
    const real = imagesCodec(env.IMAGES);
    expect(await real.info(bytes(ANIMATED_WEBP))).toMatchObject({ format: "image/webp", width: 8, height: 6 });
    expect(await real.info(bytes(APNG))).toMatchObject({ format: "image/png", width: 8, height: 6 });
    expect(webpChunks(bytes(ANIMATED_WEBP)).filter((type) => type === "ANMF")).toHaveLength(2);
    const apng = pngChunks(bytes(APNG));
    const acTL = apng.find((chunk) => chunk.type === "acTL");
    expect(acTL === undefined ? 0 : new DataView(acTL.data.buffer, acTL.data.byteOffset).getUint32(0)).toBe(2);
    expect(apng.filter((chunk) => chunk.type === "fdAT")).toHaveLength(1);
    expect(gifFrames(bytes(ANIMATED_GIF))).toBeGreaterThanOrEqual(2);
  });
});

describe("processImage of an animated upload", () => {
  it("encodes the preview as a still and reports which output is animated", async () => {
    const codec = new TestCodec();
    // The full image stands in for Images keeping the frames; the preview comes from the local binding.
    codec.encodeResponder = (_options, index) => (index === 0 ? bytes(ANIMATED_WEBP) : null);
    const result = await processImage(codec, bytes(ANIMATED_WEBP));
    expect(codec.encodeCalls).toEqual([
      { format: "image/webp" },
      { width: 8, height: 6, format: "image/webp", still: true },
    ]);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect([result.image.full.animated, result.image.small.animated]).toEqual([true, false]);
    expect(isAnimated(result.image.small.bytes, "image/webp")).toBe(false);
  });

  it("fails when the preview asked for as a still is animated", async () => {
    const codec = new TestCodec();
    codec.encodeResponder = () => bytes(ANIMATED_WEBP);
    expect(await processImage(codec, bytes(ANIMATED_WEBP))).toEqual({
      ok: false,
      reason: "failed",
      detail: "output is animated",
    });
  });

  it("reads a GIF as still through the local binding, which decodes one frame (the real one: docs/setup.md)", async () => {
    const result = await processImage(new TestCodec(), bytes(ANIMATED_GIF));
    expect(result.ok && [result.image.full.animated, result.image.small.animated]).toEqual([false, false]);
  });
});

// The preview's blurhash (platform/images.ts processImage, previewBlurhash): Images' RGBA output of the preview's own
// input and transformation, read within 4 × w × h of its checked size; any failure keeps the image without one.
describe("processImage, the preview blurhash", () => {
  // The blurhash asked for, with its outer deadline a minute away by the real clock.
  const hashed = (): ProcessOptions => ({ blurhash: { end: Date.now() + 60_000, now: Date.now } });

  it("asks for the RGBA of the preview: its input and transformation, within 4 × w × h of its checked size", async () => {
    expect(PREVIEW_RGBA_LIMIT).toBe(4 * SMALL_EDGE ** 2);
    const codec = new TestCodec();
    const result = await processImage(codec, bytes(WIDE_PNG), hashed());
    if (!result.ok) {
      throw new Error(result.reason);
    }
    const { small } = result.image;
    const [full, preview, rgba] = codec.outputs;
    expect(codec.outputs).toHaveLength(3);
    // The full image's bytes, not the original's; the preview's transformation, not the full image's.
    expect(rgba?.input).toEqual(preview?.input);
    expect(rgba?.input).not.toEqual(bytes(WIDE_PNG));
    expect(rgba?.transforms).toEqual(preview?.transforms);
    expect(rgba?.transforms).not.toEqual(full?.transforms);
    expect(rgba?.options).toEqual({ format: "rgba", anim: false });
    expect(codec.encodeCalls[2]).toEqual({
      width: 640,
      height: 160,
      format: "rgba",
      limit: 4 * small.width * small.height,
      guard: expect.any(Function),
    });
    expect(result.blurhashStop).toBeNull();
  });

  it("reads the RGBA within the preview's checked size, not the size it asked for", async () => {
    const codec = new TestCodec();
    const info = codec.info.bind(codec);
    // The preview's info() (the third) answers half the asked size.
    codec.info = async (input: Uint8Array) =>
      codec.infoCalls === 2 ? (codec.infoCalls++, { format: "image/png", width: 320, height: 80 }) : info(input);
    const result = await processImage(codec, bytes(WIDE_PNG), hashed());
    expect(result.ok && result.image.small).toMatchObject({ width: 320, height: 80 });
    expect(codec.encodeCalls[2]).toMatchObject({ width: 640, height: 160, format: "rgba", limit: 4 * 320 * 80 });
    // The output, of the asked size, is past that bound.
    expect(result.ok && result.image.blurhash).toBeNull();
  });

  it("computes the 4 × 4 blurhash of the pixels Images answered", async () => {
    const codec = new TestCodec();
    const seen = recordRgba(codec);
    const result = await processImage(codec, bytes(WIDE_PNG), hashed());
    if (!result.ok) {
      throw new Error(result.reason);
    }
    const { small, blurhash } = result.image;
    expect(blurhash).toHaveLength(36);
    expect(blurhash?.[0]).toBe("U");
    expect(seen).toHaveLength(1);
    const data = new Uint8ClampedArray(seen[0]!.buffer);
    expect(blurhash).toBe(imageBlurhash({ data, width: small.width, height: small.height }));
  });

  it.each([
    ["one byte short", -1],
    ["one byte long", 1],
  ])("keeps the image without a blurhash for an RGBA output %s", async (_name, delta) => {
    const codec = new TestCodec();
    codec.encodeResponder = (options) =>
      options.format === "rgba" ? new Uint8Array((options.limit ?? 0) + delta).fill(200) : null;
    const result = await processImage(codec, bytes(WIDE_PNG), hashed());
    expect(codec.encodeCalls.map((call) => call.format)).toEqual(["image/png", "image/png", "rgba"]);
    expect(result).toMatchObject({ ok: true, image: { blurhash: null }, blurhashStop: null });
  });

  it.each<[number, "quota" | null]>([
    [9422, "quota"],
    [9520, null],
    [9523, null],
  ])("keeps the image without a blurhash when the RGBA output fails with %i", async (code, stop) => {
    const codec = new TestCodec();
    codec.failRgba = code;
    const result = await processImage(codec, bytes(WIDE_PNG), hashed());
    expect(codec.outputs.map((call) => call.options.format)).toEqual(["image/png", "image/png", "rgba"]);
    expect(result).toMatchObject({ ok: true, image: { blurhash: null }, blurhashStop: stop });
    expect(result.ok && result.image.small.bytes.length).toBeGreaterThan(0);
  });

  // processImage reads `now` only for the RGBA output, so a clock it is given fixes the time left after the preview
  // whatever the preview took.
  const T = Date.parse("2026-10-12T00:00:00.000Z");

  it.each(["output", "read"] as const)(
    "gives up a stalled RGBA %s at its end, cancelling the read, and keeps the image",
    async (stall) => {
      const codec = new TestCodec();
      codec.stallRgba = stall;
      // RGBA_MIN_CALL_MS and 300 ms left at a stopped clock: the end comes before RGBA_CALL_MS, and the RGBA output
      // is given up at it (measured in real time from the RGBA call, whatever the preview took).
      const encode = codec.encode.bind(codec);
      let rgbaAt = 0;
      codec.encode = (input: Uint8Array, options: EncodeOptions) => {
        if (options.format === "rgba") {
          rgbaAt = Date.now();
        }
        return encode(input, options);
      };
      const result = await processImage(codec, bytes(WIDE_PNG), {
        blurhash: { end: T + RGBA_MIN_CALL_MS + 300, now: () => T },
      });
      expect(Date.now() - rgbaAt).toBeLessThan(RGBA_CALL_MS - 1_000);
      expect(codec.outputs.map((call) => call.options.format)).toEqual(["image/png", "image/png", "rgba"]);
      expect(result).toMatchObject({ ok: true, image: { blurhash: null }, blurhashStop: "deadline" });
      expect(codec.rgbaCancelled).toBe(stall === "read" ? 1 : 0);
    },
    30_000,
  );

  it.each(["output", "read"] as const)(
    "gives up a stalled RGBA %s RGBA_CALL_MS after it starts, long before its end",
    async (stall) => {
      expect(RGBA_CALL_MS).toBeLessThan(10 * 60_000);
      const codec = new TestCodec();
      codec.stallRgba = stall;
      // The clock's first readings are each RGBA_CALL_MS - 300 ms later: the skip check, the cap's start, then the
      // guard, which has 300 ms of the cap left, where it stays; the end is ten minutes away.
      let reads = 0;
      const now = () => T + Math.min(reads++, 2) * (RGBA_CALL_MS - 300);
      const started = Date.now();
      const result = await processImage(codec, bytes(WIDE_PNG), { blurhash: { end: T + 10 * 60_000, now } });
      expect(Date.now() - started).toBeLessThan(25_000);
      expect(codec.outputs.map((call) => call.options.format)).toEqual(["image/png", "image/png", "rgba"]);
      expect(result).toMatchObject({ ok: true, image: { blurhash: null }, blurhashStop: "deadline" });
      expect(codec.rgbaCancelled).toBe(stall === "read" ? 1 : 0);
    },
    30_000,
  );

  it("does not ask for the RGBA with less than RGBA_MIN_CALL_MS before its end", async () => {
    const codec = new TestCodec();
    const result = await processImage(codec, bytes(WIDE_PNG), {
      blurhash: { end: T + RGBA_MIN_CALL_MS - 1, now: () => T },
    });
    expect(codec.encodeCalls.map((call) => call.format)).toEqual(["image/png", "image/png"]);
    expect(result).toMatchObject({ ok: true, image: { blurhash: null }, blurhashStop: "deadline" });
  });

  it("asks for no RGBA without the option (a custom emoji)", async () => {
    const codec = new TestCodec();
    const result = await processImage(codec, bytes(WIDE_PNG));
    expect(codec.outputs.map((call) => call.options.format)).toEqual(["image/png", "image/png"]);
    expect(result).toMatchObject({ ok: true, image: { blurhash: null }, blurhashStop: null });
  });
});

describe("stillEncodes's body read (r2 M6)", () => {
  it("ends at its guard's deadline when Images answers and then holds its body", async () => {
    // Headers at once, then a body that never ends.
    const held = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(10));
      },
    });
    const codec = imagesCodec(fakeBinding({ info: { format: "image/png", width: 320, height: 180 }, output: held }));
    const end = Date.now() + 50;
    const answer = stillEncodes(codec, bytes(PNG_PLAIN), { width: 320, height: 180 }, (work) =>
      within(work, end, Date.now),
    );
    const late = new Promise<"still waiting">((resolve) => setTimeout(() => resolve("still waiting"), 500));
    // The guard's give-up passes on (the probe's no-verdict `timeout`), at the deadline rather than never.
    const settled = await Promise.race([answer.catch((error: unknown) => error), late]);
    expect(settled).toBeInstanceOf(DeadlinePassed);
  });
});

// Each read of an output starts inside the guard, so one the guard refuses is never started (PR6-2 code review r1 M6):
// the whole output (an upload's thumbnail) and one read within a limit (the RGBA output).
describe("imagesCodec's guarded output reads (r1 M6)", () => {
  it.each([
    ["whole", { format: "image/png" }],
    ["within a limit", { format: "rgba", limit: 10 }],
  ] as const)("starts no read once the guard refuses (%s)", async (_, options) => {
    let reads = 0;
    let approved = 0;
    const guard: CallGuard = async (work) => {
      if (approved === 2) {
        throw new DeadlinePassed();
      }
      const result = await work();
      approved++;
      return result;
    };
    const image = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.enqueue(Uint8Array.of(++reads));
        },
      },
      { highWaterMark: 0 },
    );
    const binding = {
      input: () => ({ output: () => Promise.resolve({ image: () => image }) }),
    } as unknown as ImagesBinding;
    await expect(imagesCodec(binding).encode(Uint8Array.of(0), { ...options, guard })).rejects.toBeInstanceOf(
      DeadlinePassed,
    );
    expect(reads).toBe(1);
  });
});

// A profile image's full image takes its role's shape (platform/images.ts fullBox, shapeProblem): an avatar a 400×400
// cover, a header within Mastodon's 750,000-pixel box as a square; an animation Images leaves unshaped is made again
// as a still of that shape, within the three outputs an upload is charged.
describe("processImage of a profile image", () => {
  const hashed = (): ProcessOptions => ({ blurhash: { end: Date.now() + 60_000, now: Date.now } });
  const sizeOf = (image: { width: number; height: number }) => [image.width, image.height];

  it("makes an avatar's full image a 400×400 cover and its preview from it", async () => {
    expect(AVATAR_EDGE).toBe(400);
    const codec = new TestCodec();
    const result = await processImage(codec, bytes(WIDE_PNG), { ...hashed(), role: "avatar" });
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(codec.encodeCalls[0]).toEqual({ width: 400, height: 400, fit: "cover", format: "image/png" });
    expect(codec.encodeCalls[1]).toEqual({ width: 400, height: 400, format: "image/png", still: true });
    const [full, preview, rgba] = codec.outputs;
    expect(full?.transforms).toEqual([{ width: 400, height: 400, fit: "cover" }]);
    expect(preview?.transforms).toEqual([{ width: 400, height: 400, fit: "scale-down" }]);
    // The preview and its RGBA are made from the served full image.
    expect(preview?.input).toEqual(result.image.full.bytes);
    expect(rgba?.input).toEqual(result.image.full.bytes);
    expect([sizeOf(result.image.full), sizeOf(result.image.small)]).toEqual([
      [400, 400],
      [400, 400],
    ]);
    expect(result.image.blurhash).toMatch(/^U.{35}$/);
  });

  it("enlarges a small avatar to 400×400", async () => {
    const codec = new TestCodec();
    const result = await processImage(codec, await columnsPng(200, 50), { role: "avatar" });
    expect(result.ok && sizeOf(result.image.full)).toEqual([400, 400]);
  });

  it("keeps an attachment's shape when no role is given", async () => {
    const codec = new TestCodec();
    const result = await processImage(codec, bytes(WIDE_PNG));
    expect(codec.encodeCalls[0]).toEqual({ width: 3840, height: 3840, format: "image/png" });
    expect(codec.outputs[0]?.transforms).toEqual([{ width: 3840, height: 3840, fit: "scale-down" }]);
    expect(result.ok && sizeOf(result.image.full)).toEqual([3840, 960]);
  });

  it.each([
    // [input, the box asked for, the full image served]
    [[4000, 1000], 1732, [1732, 433]],
    [[1000, 750], null, [1000, 750]],
    [[1000, 751], 999, [999, 750]],
    [[8000, 200], 3840, [3840, 96]],
    [[896, 864], 882, [882, 851]],
    [[8000, 50], 3840, [3840, 24]],
  ] as const)("sizes a header's box from its long and short edges: %j in %j", async ([width, height], box, served) => {
    expect(HEADER_PIXELS).toBe(750_000);
    const codec = new TestCodec();
    const result = await processImage(codec, await columnsPng(width, height), { role: "header" });
    expect(codec.outputs[0]?.transforms).toEqual(box === null ? [] : [{ width: box, height: box, fit: "scale-down" }]);
    expect(result.ok && sizeOf(result.image.full)).toEqual(served);
  });

  it("boxes a header in a square, whatever its orientation", async () => {
    const shapes: unknown[] = [];
    for (const [width, height] of [
      [4000, 1000],
      [1000, 4000],
    ] as const) {
      const codec = new TestCodec();
      const result = await processImage(codec, await columnsPng(width, height), { role: "header" });
      shapes.push([codec.outputs[0]?.transforms, result.ok && sizeOf(result.image.full)]);
    }
    expect(shapes).toEqual([
      [[{ width: 1732, height: 1732, fit: "scale-down" }], [1732, 433]],
      [[{ width: 1732, height: 1732, fit: "scale-down" }], [433, 1732]],
    ]);
  });

  it.each<[string, "avatar" | "header", [number, number], [number, number]]>([
    ["an avatar of 401×400", "avatar", [4000, 1000], [401, 400]],
    ["a header past its box", "header", [4000, 1000], [1733, 433]],
    ["a 1×1 header", "header", [4000, 1000], [1, 1]],
    ["a header resized where none was asked", "header", [1000, 750], [999, 750]],
    ["a header past its box on a thin image", "header", [7000, 500], [3241, 231]],
    ["a header past FULL_EDGE", "header", [5000, 100], [5000, 100]],
    ["a header of another ratio", "header", [4000, 1000], [1732, 500]],
  ])("refuses a role's output that is not its shape: %s", async (_name, role, [width, height], [w, h]) => {
    const output = await columnsPng(w, h);
    const codec = new TestCodec();
    codec.encodeResponder = (_options, index) => (index === 0 ? output : null);
    const result = await processImage(codec, await columnsPng(width, height), { ...hashed(), role });
    expect(result).toEqual({ ok: false, reason: "failed", detail: `output is not of the ${role}'s shape` });
    // One full output started, and no other: a still input has no fallback.
    expect(codec.encodeCalls).toHaveLength(1);
  });

  it.each([
    ["a still JPEG", bytes(JPEG_SERIAL)],
    ["a single-frame GIF", bytes(GIF)],
    ["an APNG", bytes(APNG)],
  ])("never falls back for %s", async (_name, input) => {
    const webp = await encodeWebp(401, 400);
    const png = await columnsPng(401, 400);
    const codec = new TestCodec();
    codec.encodeResponder = (options, index) => (index === 0 ? (options.format === "image/png" ? png : webp) : null);
    const result = await processImage(codec, input, { ...hashed(), role: "avatar" });
    expect(result).toEqual({ ok: false, reason: "failed", detail: "output is not of the avatar's shape" });
    expect(codec.encodeCalls).toHaveLength(1);
  });

  it("falls back to a still avatar for an animation Images left unshaped", async () => {
    const codec = new TestCodec();
    // Images answers the animation at its own size: not a 400×400 avatar.
    codec.encodeResponder = (_options, index) => (index === 0 ? bytes(ANIMATED_WEBP) : null);
    const result = await processImage(codec, bytes(ANIMATED_WEBP), { ...hashed(), role: "avatar" });
    if (!result.ok) {
      throw new Error(result.reason);
    }
    // The animated full, the still full, and the RGBA of the still full: three outputs, no preview of its own.
    expect(codec.encodeCalls).toEqual([
      { width: 400, height: 400, fit: "cover", format: "image/webp" },
      { width: 400, height: 400, fit: "cover", format: "image/webp", still: true },
      { width: 400, height: 400, format: "rgba", limit: 4 * 400 * 400, guard: expect.any(Function) },
    ]);
    const { full, small, blurhash } = result.image;
    expect([sizeOf(full), full.animated, isAnimated(full.bytes, "image/webp")]).toEqual([[400, 400], false, false]);
    expect(small).toBe(full);
    expect(blurhash).toMatch(/^U.{35}$/);
    // The responder answered the first; the RGBA is the last output that reached the binding.
    expect(codec.outputs.at(-1)?.input).toEqual(full.bytes);
  });

  it("falls back to a still header, with no RGBA, for an animation Images left unshaped", async () => {
    const input = animatedWebp([await encodeWebp(2000, 1000), await encodeWebp(2000, 1000, { fill: "flat" })], {
      width: 2000,
      height: 1000,
    });
    const codec = new TestCodec();
    codec.encodeResponder = (_options, index) => (index === 0 ? bytes(ANIMATED_WEBP) : null);
    const result = await processImage(codec, input, { ...hashed(), role: "header" });
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(codec.encodeCalls.map(({ guard: _guard, ...call }) => call)).toEqual([
      { width: 1225, height: 1225, format: "image/webp" },
      { width: 1225, height: 1225, format: "image/webp", still: true },
      { width: 640, height: expect.any(Number), format: "image/webp", still: true },
    ]);
    const { full, small, blurhash } = result.image;
    expect([full.animated, small.animated, blurhash, result.blurhashStop]).toEqual([false, false, null, null]);
    expect(Math.max(full.width, full.height)).toBe(1225);
    expect(Math.max(small.width, small.height)).toBe(640);
  }, 30_000);

  it("falls back for an animated GIF whose output came back as another type", async () => {
    const codec = new TestCodec();
    codec.encodeResponder = (_options, index) => (index === 0 ? bytes(ANIMATED_GIF) : null);
    const result = await processImage(codec, bytes(ANIMATED_GIF), { ...hashed(), role: "avatar" });
    expect(codec.encodeCalls.map((call) => [call.format, call.still ?? false])).toEqual([
      ["image/webp", false],
      ["image/webp", true],
      ["rgba", false],
    ]);
    expect(result.ok && [sizeOf(result.image.full), result.image.full.animated]).toEqual([[400, 400], false]);
  });

  it("fails when the still is not of the role's shape either", async () => {
    const codec = new TestCodec();
    codec.encodeResponder = (_options, index) =>
      index === 0 ? bytes(ANIMATED_WEBP) : index === 1 ? bytes(WEBP_PLAIN) : null;
    const result = await processImage(codec, bytes(ANIMATED_WEBP), { ...hashed(), role: "avatar" });
    expect(result).toEqual({ ok: false, reason: "failed", detail: "output is not of the avatar's shape" });
    expect(codec.encodeCalls).toHaveLength(2);
  });

  it("does not fall back after an output that does not walk", async () => {
    const codec = new TestCodec();
    codec.encodeResponder = (_options, index) => (index === 0 ? new Uint8Array([...bytes(ANIMATED_WEBP), 0]) : null);
    const result = await processImage(codec, bytes(ANIMATED_WEBP), { ...hashed(), role: "avatar" });
    expect(result).toEqual({ ok: false, reason: "failed", detail: "output is malformed" });
    expect(codec.encodeCalls).toHaveLength(1);
  });

  it("boxes a header by its edges as info() reads them, and takes the rotated output Images serves", async () => {
    const codec = new TestCodec();
    // info() reads a landscape 4000×1000 (the stored size); Images applies the orientation and serves a portrait.
    codec.infoResult = { format: "image/png", width: 4000, height: 1000 };
    const result = await processImage(codec, await columnsPng(1000, 4000), { role: "header" });
    expect(codec.outputs[0]?.transforms).toEqual([{ width: 1732, height: 1732, fit: "scale-down" }]);
    expect(result.ok && [sizeOf(result.image.full), sizeOf(result.image.small)]).toEqual([
      [433, 1732],
      [160, 640],
    ]);
  });

  it("asks for a thin header's preview in a 640 square, so its long edge is 640", async () => {
    const codec = new TestCodec();
    const result = await processImage(codec, await columnsPng(1000, 99), { ...hashed(), role: "header" });
    const [full, preview, rgba] = codec.outputs;
    expect(full?.transforms).toEqual([]);
    expect(preview?.transforms).toEqual([{ width: 640, height: 640, fit: "scale-down" }]);
    expect(rgba?.transforms).toEqual(preview?.transforms);
    expect(result.ok && [sizeOf(result.image.full), sizeOf(result.image.small)]).toEqual([
      [1000, 99],
      [640, 63],
    ]);
    expect(result.ok && result.image.blurhash).toMatch(/^U.{35}$/);
  });

  it("requires an animated avatar's static to be 400×400", async () => {
    const frame = await encodeWebp(400, 400);
    const full = animatedWebp([frame, frame], { width: 400, height: 400 });
    const wrong = await encodeWebp(401, 400);
    const codec = new TestCodec();
    codec.encodeResponder = (options) => (options.format === "rgba" ? null : options.still === true ? wrong : full);
    const result = await processImage(codec, bytes(ANIMATED_WEBP), { ...hashed(), role: "avatar" });
    expect(result).toEqual({ ok: false, reason: "failed", detail: "preview is not of the avatar's shape" });
    // No RGBA is asked for a refused preview.
    expect(codec.encodeCalls.map((call) => call.format)).toEqual(["image/webp", "image/webp"]);
  });

  it.each<[string, () => Promise<Uint8Array>, string]>([
    ["of the wrong size", () => encodeWebp(1000, 250), "preview is not of the header's shape"],
    ["of another type", () => Promise.resolve(bytes(PNG_PLAIN)), "output is not of the requested type"],
  ])(
    "fails a header whose fallback's preview is %s",
    async (_name, make, detail) => {
      const input = animatedWebp([await encodeWebp(2000, 1000), await encodeWebp(2000, 1000, { fill: "flat" })], {
        width: 2000,
        height: 1000,
      });
      const preview = await make();
      const codec = new TestCodec();
      codec.encodeResponder = (_options, index) => (index === 0 ? bytes(ANIMATED_WEBP) : index === 2 ? preview : null);
      const result = await processImage(codec, input, { ...hashed(), role: "header" });
      expect(result).toEqual({ ok: false, reason: "failed", detail });
      expect(codec.encodeCalls).toHaveLength(3);
    },
    30_000,
  );

  it("does not fall back without a role", async () => {
    const codec = new TestCodec();
    codec.encodeResponder = (_options, index) => (index === 0 ? bytes(ANIMATED_GIF) : null);
    const result = await processImage(codec, bytes(ANIMATED_GIF), hashed());
    expect(result).toEqual({ ok: false, reason: "failed", detail: "output is not of the requested type" });
    expect(codec.encodeCalls).toHaveLength(1);
  });
});
