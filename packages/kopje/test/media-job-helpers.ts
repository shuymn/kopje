import { env } from "cloudflare:workers";

import type { Endpoint } from "../src/domain/media-processing";
import type { UploadDeps, UploadJob } from "../src/jobs/media-jobs";
import { type ContainerControl, probeWork } from "../src/mastodon/media-activation";
import { normalize } from "../src/media-processor";
import type { ImageCodec } from "../src/platform/images";
import { incomingKey } from "../src/platform/media-files";
import type { UploadProcessor } from "../src/platform/media-transcoder";
import { sql } from "./api-helpers";
import { BUILD } from "./helpers";
import { pngOf } from "./local-emoji-helpers";
import { TestCodec } from "./media-helpers";
import { type AvWorld, clock, type Started } from "./media-processing-helpers";

// The processor's side of an upload for jobs/media-jobs.ts runUpload, with a container answering as
// container/server/main.go does and recording what was asked of it.

export type ServerAnswer = {
  output?: Uint8Array;
  type?: "video/mp4" | "audio/mpeg";
  durationMs?: string | null;
  still?: Uint8Array | null;
  // A status and code in place of the output.
  failure?: { status: number; code: string; body?: string };
  // The response's body ends after this many bytes, whatever its Content-Length says.
  truncateAt?: number;
  // The Content-Length declared this many bytes off the body's length.
  lengthOff?: number;
  // The body ends with one empty chunk.
  emptyTail?: boolean;
};

export function fakeControl(
  answer: ServerAnswer,
  options: {
    stop?: () => Promise<boolean>;
    ready?: Fetcher | "wrong" | null | undefined;
    // Run as the still is asked for.
    onStill?: () => void;
    // Run as /normalize answers (its headers), and the time its body takes after them on the faked clock.
    onReply?: () => void;
    transferMs?: number;
    // The body stays open after the output (a container still sending), until it is cancelled.
    open?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const port = {
    fetch: async (input: string, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      calls.push(`${request.method} ${url.pathname}${url.search}`);
      if (url.pathname === "/normalize/still") {
        options.onStill?.();
        const png = answer.still ?? null;
        return png === null
          ? new Response(null, { status: 404, headers: { "kopje-error": "no_still" } })
          : new Response(png, { headers: { "content-type": "image/png", "content-length": String(png.byteLength) } });
      }
      await request.arrayBuffer();
      if (answer.failure !== undefined) {
        const { status, code, body } = answer.failure;
        return new Response(body ?? `{"error":"${code}"}`, { status, headers: { "kopje-error": code } });
      }
      const output = answer.output ?? new Uint8Array();
      const type = answer.type ?? "video/mp4";
      const sent = answer.truncateAt === undefined ? output : output.subarray(0, answer.truncateAt);
      options.onReply?.();
      const half = sent.byteLength >> 1;
      let pulled = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller): Promise<void> | undefined {
          pulled++;
          if (pulled === 1) {
            controller.enqueue(options.transferMs === undefined ? sent : sent.subarray(0, half));
            return undefined;
          }
          if (options.transferMs !== undefined && pulled === 2) {
            clock(Date.now() + options.transferMs);
            controller.enqueue(sent.subarray(half));
            return undefined;
          }
          if (options.open === true) {
            return new Promise<void>(() => {});
          }
          if (answer.emptyTail === true) {
            controller.enqueue(new Uint8Array(0));
          }
          controller.close();
          return undefined;
        },
        cancel() {
          cancels++;
        },
      });
      return new Response(body, {
        headers: {
          "content-type": type,
          "content-length": String(output.byteLength + (answer.lengthOff ?? 0)),
          "kopje-kind": type === "video/mp4" ? "video" : "audio",
          ...(type === "video/mp4" ? { "kopje-still": String((answer.still ?? null) !== null) } : {}),
          ...(answer.durationMs === null ? {} : { "kopje-duration-ms": answer.durationMs ?? "2000" }),
        },
      });
    },
  } as unknown as Fetcher;
  let stops = 0;
  let cancels = 0;
  const control: ContainerControl = {
    ready: () => {
      calls.push("ready");
      return Promise.resolve(options.ready === undefined ? port : options.ready);
    },
    normalize,
    stop: () => {
      calls.push("stop");
      stops++;
      return options.stop?.() ?? Promise.resolve(true);
    },
  };
  return { control, calls, stops: () => stops, cancels: () => cancels };
}

export async function stillPng(): Promise<Uint8Array> {
  return pngOf(320, 180);
}

// runUpload's deps for `w`'s Store and the media bucket.
export function uploadDeps(w: AvWorld, control: ContainerControl, overrides: Partial<UploadDeps> = {}): UploadDeps {
  return {
    ...control,
    build: BUILD,
    store: w.store,
    bucket: env.MEDIA,
    images: new TestCodec(),
    monthlyTransforms: { instance: 4000, account: 400 },
    now: () => Date.now(),
    // No cut fires unless a test sets one.
    wait: () => new Promise<void>(() => {}),
    ...overrides,
  };
}

// The job S4 started for `up`, its deadline the Store's own (Date is the Store's clock in these tests).
export async function jobOf(w: AvWorld, up: Started, endpoint: Endpoint = "v2"): Promise<UploadJob> {
  const [row] = await sql<{ deadline_at: number; input_bytes: number }>(
    w.store,
    "SELECT deadline_at, input_bytes FROM media_processing WHERE media_id = ?",
    up.id,
  );
  return {
    id: up.id,
    token: up.token,
    startId: up.startId,
    endpoint,
    inputBytes: row?.input_bytes ?? 0,
    deadline: row?.deadline_at ?? 0,
  };
}

export async function putInput(id: string, bytes = new Uint8Array(1000).fill(1)): Promise<void> {
  await env.MEDIA.put(incomingKey(id), bytes);
}

// The activation probe's processor with the probe object's work (probeWork) run here on `control`'s container,
// the clip copied to the bucket as activationProbe copies it.
export function probeProcessor(control: ContainerControl, images: ImageCodec, clip: Uint8Array): UploadProcessor {
  return {
    run: () => Promise.reject(new Error("no upload in a probe test")),
    probeInput: clip,
    probeNormalize: async (key) => ({
      ...(await probeWork(
        { ...control, bucket: env.MEDIA, images, now: () => Date.now() },
        key,
        Date.now() + 70_000,
        70_000,
      )),
      image: null,
    }),
  };
}

function crc32(bytes: Uint8Array): number {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

// A 1x1 PNG whose IDAT holds a deflate stream cut before its end, its CRC recomputed: verifyStill walks its chunks
// and passes it; a decoder cannot read its pixels.
export async function truncatedStill(): Promise<Uint8Array> {
  const png = await pngOf(1, 1);
  const view = new DataView(png.buffer, png.byteOffset);
  const idatAt = 33;
  const data = png.subarray(idatAt + 8, idatAt + 8 + view.getUint32(idatAt) - 4);
  const typed = new Uint8Array(4 + data.length);
  typed.set(new TextEncoder().encode("IDAT"));
  typed.set(data, 4);
  const out = new Uint8Array(33 + 12 + data.length + 12);
  out.set(png.subarray(0, 33));
  const outView = new DataView(out.buffer);
  outView.setUint32(33, data.length);
  out.set(typed, 37);
  outView.setUint32(37 + typed.length, crc32(typed));
  out.set(png.subarray(png.length - 12), 33 + 12 + data.length);
  return out;
}

// The media bucket, logging each multipart upload's creation, completion and abort by its kind ("original", "full").
export function multipartLog(fault: { failAbort?: boolean; failPart?: boolean } = {}): {
  bucket: R2Bucket;
  log: string[];
} {
  const log: string[] = [];
  const kind = (key: string) => (key.startsWith("originals/") ? "original" : "full");
  const bucket = new Proxy(env.MEDIA, {
    get(target, method: string) {
      const value = (target as unknown as Record<string, unknown>)[method];
      if (method !== "createMultipartUpload") {
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      }
      return async (key: string, options?: R2MultipartOptions) => {
        const upload = await target.createMultipartUpload(key, options);
        log.push(`create:${kind(key)}`);
        return {
          key: upload.key,
          uploadId: upload.uploadId,
          uploadPart: async (number: number, part: Uint8Array) => {
            if (fault.failPart === true) {
              throw new Error("r2 part failed");
            }
            return upload.uploadPart(number, part);
          },
          abort: async () => {
            log.push(`abort:${kind(key)}`);
            if (fault.failAbort === true) {
              throw new Error("r2 abort failed");
            }
            await upload.abort();
          },
          complete: async (parts: R2UploadedPart[]) => {
            log.push(`complete:${kind(key)}`);
            return upload.complete(parts);
          },
        };
      };
    },
  });
  return { bucket, log };
}
