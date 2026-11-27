import { env } from "cloudflare:workers";
import { vi } from "vitest";

import {
  type EncodeOptions,
  type ImageCodec,
  ImageCodecError,
  type ImageInfo,
  imagesCodec,
} from "../src/platform/images";
import { MAX_MEDIA_DESCRIPTION_LENGTH } from "../src/platform/stored-bounds";
import { bearer, type ApiHarness } from "./api-helpers";
import { ANIMATED_WEBP } from "./fixtures/images";
import { localRgba, type OutputCall, type RgbaControl } from "./images-binding";
import type { User } from "./status-helpers";

// Media fixtures: base64 fixtures as bytes, multipart uploads, R2 listings, and a codec to stand in for Images.

// Mastodon's answer to a local description past MediaAttachment::MAX_DESCRIPTION_LENGTH, on upload, media update and
// status edit alike.
export const DESCRIPTION_TOO_LONG = {
  error: "Validation failed: Description is too long (maximum is 10000 characters)",
};

// Descriptions past it: one code point past the limit, of the Basic Multilingual Plane and past it (20,002 UTF-16
// code units, more than the upload form's field bound), and one longer than any valid one by its length alone.
export const OVERLONG_DESCRIPTIONS = [
  "x".repeat(MAX_MEDIA_DESCRIPTION_LENGTH + 1),
  "\u{1F600}".repeat(MAX_MEDIA_DESCRIPTION_LENGTH + 1),
  "x".repeat(2 * MAX_MEDIA_DESCRIPTION_LENGTH + 1),
];

export function bytes(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

export function mediaForm(
  file: Uint8Array | string,
  fields: Record<string, string> = {},
  name = "photo.jpg",
  type = "image/jpeg",
): FormData {
  const form = new FormData();
  form.append("file", new File([file], name, { type }));
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }
  return form;
}

// A multipart form of `parts` in order, repeated names kept.
export function multipartForm(parts: readonly [string, string | File][]): FormData {
  const form = new FormData();
  for (const [name, value] of parts) {
    form.append(name, value);
  }
  return form;
}

export type Attachment = {
  id: string;
  type: string;
  url: string | null;
  preview_url: string | null;
  description: string | null;
  blurhash: string | null;
  meta: {
    original?: { width: number; height: number; size: string; aspect: number };
    small?: { width: number; height: number };
    focus?: { x: number; y: number };
  } | null;
};

export function upload(h: ApiHarness, user: User, form: FormData, version: "v1" | "v2" = "v2"): Promise<Response> {
  return h.request(`/api/${version}/media`, bearer(user.token, { method: "POST", body: form }));
}

export async function uploaded(h: ApiHarness, user: User, form: FormData): Promise<Attachment> {
  const response = await upload(h, user, form);
  if (response.status !== 200) {
    throw new Error(`upload failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

// Every R2 key in the media bucket under a prefix.
export async function r2Keys(prefix = ""): Promise<string[]> {
  const listed = await env.MEDIA.list({ prefix });
  return listed.objects.map((object) => object.key).toSorted();
}

// The served path of a media URL (https://kopje.test/media/...).
export function pathOf(url: string | null): string {
  if (url === null) {
    throw new Error("no url");
  }
  return new URL(url).pathname;
}

// A codec over the local Images binding (Miniflare's, backed by sharp) with Images' 'rgba' output stood in for
// (images-binding.ts localRgba, whose output() calls are in `outputs`), that records calls and can be told to
// misbehave: fail with an Images error code, return given bytes instead of a re-encoding (to inject EXIF), for every
// call (encodeResult) or per call (encodeResponder, given the call's options, its 0-based index and its input; null
// falls through to the real binding), or rewrite the real binding's output (encodeOutput, given the output, the call's
// options and its input: Images keeping metadata, as production does); the 'rgba' output by RgbaControl. Given bytes
// are answered as a copy, since an output is the caller's to strip in place (ImageCodec). Miniflare's binding decodes
// only the first frame and ignores anim, so an animated output is stood in for through these.
export class TestCodec implements ImageCodec, RgbaControl {
  failRgba: number | null = null;
  stallRgba: "output" | "read" | null = null;
  rgbaCancelled = 0;
  private readonly stand = localRgba(env.IMAGES, this);
  readonly real = imagesCodec(this.stand.binding);
  infoCalls = 0;
  encodeCalls: EncodeOptions[] = [];
  failInfo: number | null = null;
  failEncode: number | null = null;
  encodeResult: Uint8Array | null = null;
  encodeResponder: ((options: EncodeOptions, index: number, input: Uint8Array) => Uint8Array | null) | null = null;
  encodeOutput: ((output: Uint8Array, options: EncodeOptions, input: Uint8Array) => Uint8Array) | null = null;
  infoResult: ImageInfo | null = null;

  info(bytes: Uint8Array): Promise<ImageInfo> {
    this.infoCalls++;
    if (this.failInfo !== null) {
      return Promise.reject(new ImageCodecError(this.failInfo, "injected"));
    }
    if (this.infoResult !== null && this.infoCalls === 1) {
      return Promise.resolve(this.infoResult);
    }
    return this.real.info(bytes);
  }

  encode(bytes: Uint8Array, options: EncodeOptions): Promise<Uint8Array> {
    this.encodeCalls.push(options);
    if (this.failEncode !== null) {
      return Promise.reject(new ImageCodecError(this.failEncode, "injected"));
    }
    if (this.encodeResult !== null) {
      return Promise.resolve(this.encodeResult.slice());
    }
    const given = this.encodeResponder?.(options, this.encodeCalls.length - 1, bytes) ?? null;
    if (given !== null) {
      return Promise.resolve(given.slice());
    }
    const rewrite = this.encodeOutput;
    const encoded = this.real.encode(bytes, options);
    return rewrite === null ? encoded : encoded.then((output) => rewrite(output, options, bytes));
  }

  get calls(): number {
    return this.infoCalls + this.encodeCalls.length;
  }

  // The output() calls that reached the binding.
  get outputs(): OutputCall[] {
    return this.stand.outputs;
  }
}

// The bytes of every RGBA output `codec` answered, each copied as it came.
export function recordRgba(codec: TestCodec): Uint8Array[] {
  const seen: Uint8Array[] = [];
  const encode = codec.encode.bind(codec);
  codec.encode = async (input: Uint8Array, options: EncodeOptions) => {
    const output = await encode(input, options);
    if (options.format === "rgba") {
      seen.push(output.slice());
    }
    return output;
  };
  return seen;
}

// A TestCodec standing in for Images keeping an animated input's frames: Miniflare's binding decodes one frame only and
// ignores anim (docs/setup.md checks the real one), so every WebP served file (an encode without `still`) is
// ANIMATED_WEBP, and previews and other formats go through the local binding.
export function framesKeepingCodec(): TestCodec {
  const codec = new TestCodec();
  codec.encodeResponder = (options) =>
    options.format === "image/webp" && options.still !== true ? bytes(ANIMATED_WEBP) : null;
  return codec;
}

const ascii = (value: string) => new TextEncoder().encode(value);

// A JPEG with one more segment right after its signature (the walker does not check what the segment means).
export function jpegWithSegment(jpeg: Uint8Array, marker: number, payload: Uint8Array | string): Uint8Array {
  const data = typeof payload === "string" ? ascii(payload) : payload;
  const length = data.length + 2;
  return new Uint8Array([
    ...jpeg.subarray(0, 2),
    0xff,
    marker,
    length >> 8,
    length & 0xff,
    ...data,
    ...jpeg.subarray(2),
  ]);
}

// The CRC-32 of PNG chunks (ISO 3309).
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// A PNG's chunk with its CRC (ISO/IEC 15948 section 5.3), so a real decoder reads it.
export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(ascii(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

// An RGB PNG of `width` x `height` whose column x is the colour `colourAt(x)` on every row: an image whose crop or
// scale shows in its pixels, of any size (the rows are deflated with CompressionStream).
export async function columnsPng(
  width: number,
  height: number,
  colourAt: (x: number) => readonly [number, number, number] = () => [0, 0, 0],
): Promise<Uint8Array> {
  const row = new Uint8Array(1 + 3 * width);
  for (let x = 0; x < width; x++) {
    row.set(colourAt(x), 1 + 3 * x);
  }
  const raw = new Uint8Array(row.length * height);
  for (let y = 0; y < height; y++) {
    raw.set(row, y * row.length);
  }
  const deflated = new Uint8Array(
    await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer(),
  );
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return new Uint8Array([
    ...signature,
    ...pngChunk("IHDR", ihdr),
    ...pngChunk("IDAT", deflated),
    ...pngChunk("IEND", new Uint8Array()),
  ]);
}

// `png` with a chunk inserted right after IHDR.
export function pngWithChunk(png: Uint8Array, type: string, payload: string | Uint8Array): Uint8Array {
  const ihdrEnd = 8 + 25;
  const data = typeof payload === "string" ? ascii(payload) : payload;
  return new Uint8Array([...png.subarray(0, ihdrEnd), ...pngChunk(type, data), ...png.subarray(ihdrEnd)]);
}

// A minimal little-endian TIFF block for an EXIF segment holding one ASCII tag in IFD0 (no GPS IFD).
export function exifWithTag(tag: number, value: string): Uint8Array {
  const text = ascii(`${value}\0`);
  const tiff = new Uint8Array(8 + 2 + 12 + 4 + text.length);
  const view = new DataView(tiff.buffer);
  tiff.set(ascii("II*\0"));
  view.setUint32(4, 8, true);
  view.setUint16(8, 1, true);
  view.setUint16(10, tag, true);
  view.setUint16(12, 2, true);
  view.setUint32(14, text.length, true);
  view.setUint32(18, 26, true);
  tiff.set(text, 26);
  return new Uint8Array([...ascii("Exif\0\0"), ...tiff]);
}

// Sets the Store's clock (this isolate's Date, which the Store's kernel reads) to `at`, faking Date if it is not yet:
// the test then restores real timers itself (afterEach).
export function storeClock(at: number): void {
  if (!vi.isFakeTimers()) {
    vi.useFakeTimers({ toFake: ["Date"] });
  }
  vi.setSystemTime(at);
}

// Moves both clocks to `at`: the Worker's (the harness's `now`) and the Store's.
export function clocksAt(h: { now: { mockReturnValue(value: number): unknown } }, at: number): void {
  h.now.mockReturnValue(at);
  storeClock(at);
}

// Runs `run` with the Store's clock (this isolate's Date, which the Store's kernel reads) at `at`: the sweep,
// reconciliation and every other media operation judge stored media times at the Store's time (#1828 plan section 3,
// "One media clock"), so a test moves that clock, not only the Worker's. Fake timers already in use keep the clock at
// `at`; otherwise the real clock is back once `run` settles.
export async function atStoreTime<T>(at: number, run: () => Promise<T>): Promise<T> {
  const faked = vi.isFakeTimers();
  if (!faked) {
    vi.useFakeTimers({ toFake: ["Date"] });
  }
  vi.setSystemTime(at);
  try {
    return await run();
  } finally {
    if (!faked) {
      vi.useRealTimers();
    }
  }
}
