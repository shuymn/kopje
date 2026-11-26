import { env } from "cloudflare:workers";

import { incomingKey } from "../src/platform/media-files";
import type { MediaProcessorClient } from "../src/platform/media-transcoder";
import type { StoreStub } from "../src/platform/store-client";
import { sql } from "./api-helpers";
import { concat } from "./av-helpers";
import { deferred } from "./helpers";
import { TestCodec } from "./media-helpers";
import { type AvWorld, avWorld, clock } from "./media-processing-helpers";

// The upload route's world (mastodon/media-av.ts, #1828 PR4-4): avWorld with the processor bound (a client recording
// each `run`), MEDIA_UPLOAD_MONTHLY_JOBS set, the route's waits held by RouteTimers, and Store calls the test may hold
// or drop by name. The Store's clock is Date (clock()); the route's is Date plus `skew`.

export type Run = { id: string; token: string; teardownId: string };

// The route's waits (deps.wait), each due at the route's time it was asked at plus its duration, resolved only when the
// test moves the clocks past it (advance).
export class RouteTimers {
  readonly #waits: { at: number; resolve: () => void }[] = [];
  readonly #listeners: ((ms: number) => void)[] = [];
  constructor(readonly now: () => number) {}

  // A wait the route cancels (its signal aborted) leaves the pending ones.
  wait = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise<void>((resolve) => {
      const wait = { at: this.now() + ms, resolve };
      this.#waits.push(wait);
      signal?.addEventListener("abort", () => {
        const i = this.#waits.indexOf(wait);
        if (i !== -1) {
          this.#waits.splice(i, 1);
        }
      });
      for (const listener of this.#listeners.splice(0)) {
        listener(ms);
      }
    });

  // Resolves when the route next asks for a wait of exactly `ms` (the v1 poll's V1_POLL_MS).
  async waitFor(ms: number): Promise<void> {
    for (;;) {
      const asked = await new Promise<number>((resolve) => this.#listeners.push(resolve));
      if (asked === ms) {
        return;
      }
    }
  }

  // The due times of the waits not yet fired, on the route's clock.
  get pending(): number[] {
    return this.#waits.map((w) => w.at).toSorted((a, b) => a - b);
  }

  // Fires the waits due at the route's time now.
  fire(): void {
    const now = this.now();
    for (let i = this.#waits.length - 1; i >= 0; i--) {
      const w = this.#waits[i];
      if (w !== undefined && w.at <= now) {
        this.#waits.splice(i, 1);
        w.resolve();
      }
    }
  }
}

// The Store calls of the upload route a test may gate.
const GATED = new Set([
  "reserveMedia",
  "takeAvSlot",
  "releaseStaging",
  "queueNormalize",
  "v1Outcome",
  "v1Final",
  "abandonMedia",
  "startTransforms",
  "completeMedia",
  "getMedia",
  "updateMedia",
  "mediaUpdateTarget",
  "deleteMedia",
]);

// A Store whose calls by name can be held (each call awaits the test's release, before or after the Store answers) or
// have their reply dropped (the Store commits, the caller gets an error) or fail before the Store is called.
export class StoreGate {
  readonly holds = new Map<
    string,
    { before?: PromiseWithResolvers<void>; after?: PromiseWithResolvers<void>; skip: number }
  >();
  readonly drops = new Map<string, number>();
  readonly fails = new Map<string, number>();
  readonly calls: string[] = [];
  readonly #reached = new Map<string, PromiseWithResolvers<void>>();

  // Holds a call of `name` (the next, or the one after `skip` more) before the Store runs it (`before`) or after it
  // answered (`after`).
  hold(name: string, at: "before" | "after" = "before", skip = 0): PromiseWithResolvers<void> {
    const gate = deferred();
    this.holds.set(name, { ...this.holds.get(name), [at]: gate, skip });
    return gate;
  }

  // Resolves when a call of `name` reaches its gate.
  reached(name: string): Promise<void> {
    const reached = this.#reached.get(name) ?? deferred();
    this.#reached.set(name, reached);
    return reached.promise;
  }

  wrap = (store: StoreStub): StoreStub =>
    new Proxy(store, {
      get: (target, method) => {
        // An RPC method is taken from the stub as it is: detached from it, it does not reach the Store (storeWith).
        if (typeof method !== "string" || !GATED.has(method)) {
          return Reflect.get(target, method) as unknown;
        }
        return async (...args: unknown[]) => {
          this.calls.push(method);
          let held = this.holds.get(method);
          if (held !== undefined && held.skip > 0) {
            held.skip--;
            held = undefined;
          } else if (held !== undefined) {
            this.holds.delete(method);
          }
          if (held?.before !== undefined) {
            this.#reach(method);
            await held.before.promise;
          }
          const failing = this.fails.get(method) ?? 0;
          if (failing > 0) {
            this.fails.set(method, failing - 1);
            throw new Error(`${method} failed before the Store`);
          }
          const answer = await (target as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method]?.(
            ...args,
          );
          if (held?.after !== undefined) {
            this.#reach(method);
            await held.after.promise;
          }
          const dropping = this.drops.get(method) ?? 0;
          if (dropping > 0) {
            this.drops.set(method, dropping - 1);
            throw new Error(`${method} reply lost`);
          }
          return answer;
        };
      },
    });

  #reach(name: string): void {
    const reached = this.#reached.get(name) ?? deferred();
    this.#reached.set(name, reached);
    reached.resolve();
    this.#reached.delete(name);
  }
}

export type RouteWorld = AvWorld & {
  runs: Run[];
  timers: RouteTimers;
  gate: StoreGate;
  codec: TestCodec;
  // The route's clock less the Store's.
  skew: { ms: number };
  // Moves the Store's clock to `at` (the route's to `at` + skew) and fires the route's waits due then.
  advance(at: number): Promise<void>;
};

// bucket: the media bucket the route writes to (default: the test's, env.MEDIA).
// probe: the normalize verdict (default a pass, so uploads are active).
export async function routeWorld(
  options: { budget?: number; bucket?: R2Bucket; probe?: "pass" | "fail" | "absent" } = {},
): Promise<RouteWorld> {
  const runs: Run[] = [];
  const skew = { ms: 0 };
  const timers = new RouteTimers(() => Date.now() + skew.ms);
  const gate = new StoreGate();
  const codec = new TestCodec();
  const processor: MediaProcessorClient = {
    stills: {
      still: () => Promise.reject(new Error("no still in a route test")),
      remote: () => Promise.reject(new Error("no still in a route test")),
      probe: () => Promise.reject(new Error("no still in a route test")),
      probeInput: new Uint8Array(),
    },
    uploads: {
      run: (id, token, teardownId) => {
        runs.push({ id, token, teardownId });
        return Promise.resolve();
      },
      probeNormalize: () => Promise.reject(new Error("no probe in a route test")),
      probeInput: new Uint8Array(),
    },
  };
  const w = await avWorld(
    { mediaProcessor: () => processor, wait: timers.wait, wrapStore: gate.wrap, images: () => codec },
    {
      MEDIA_UPLOAD_MONTHLY_JOBS: String(options.budget ?? 10),
      ...(options.bucket === undefined ? {} : { MEDIA: options.bucket }),
    },
    options.probe,
  );
  w.h.now.mockImplementation(() => Date.now() + skew.ms);
  const advance = async (at: number) => {
    clock(at);
    timers.fire();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  };
  return { ...w, runs, timers, gate, codec, skew, advance };
}

// ---- Bodies

export type Part = { name: string; data: Uint8Array | string; filename?: string; type?: string };

const BOUNDARY = "kopje-route-boundary";

// A multipart body of `parts` in order, as a browser sends one.
export function multipartBody(parts: readonly Part[]): { body: Uint8Array; contentType: string } {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    const disposition =
      part.filename === undefined
        ? `form-data; name="${part.name}"`
        : `form-data; name="${part.name}"; filename="${part.filename}"`;
    const type = part.filename === undefined ? "" : `\r\nContent-Type: ${part.type ?? "application/octet-stream"}`;
    chunks.push(encoder.encode(`--${BOUNDARY}\r\nContent-Disposition: ${disposition}${type}\r\n\r\n`));
    chunks.push(typeof part.data === "string" ? encoder.encode(part.data) : part.data);
    chunks.push(encoder.encode("\r\n"));
  }
  chunks.push(encoder.encode(`--${BOUNDARY}--\r\n`));
  return { body: concat(...chunks), contentType: `multipart/form-data; boundary=${BOUNDARY}` };
}

// An MP4's first bytes (an `isom` ftyp, which sniffAvUpload reads as video) followed by `size` - 16 bytes.
export function mp4(size = 4096): Uint8Array {
  const bytes = new Uint8Array(size).fill(7);
  bytes.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]);
  return bytes;
}

// An MP3 (ID3) of `size` bytes: audio.
export function mp3(size = 4096): Uint8Array {
  const bytes = new Uint8Array(size).fill(5);
  bytes.set([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]);
  return bytes;
}

export function videoPart(data: Uint8Array = mp4()): Part {
  return { name: "file", data, filename: "clip.mp4", type: "video/mp4" };
}

// A body sent in chunks of `chunk` bytes, which stops after `holdAt` bytes until `release` (or never ends: `open`),
// counting what was pulled.
export class SlowBody {
  pulled = 0;
  readonly #bytes: Uint8Array;
  readonly #chunk: number;
  #holdAt: number;
  #release = deferred();
  cancelled = false;
  readonly reachedHold = deferred();

  readonly #stallCancel: boolean;

  // stallCancel: the stream's cancel never settles.
  constructor(bytes: Uint8Array, options: { chunk?: number; holdAt?: number; stallCancel?: boolean } = {}) {
    this.#stallCancel = options.stallCancel ?? false;
    this.#bytes = bytes;
    this.#chunk = options.chunk ?? 64 * 1024;
    this.#holdAt = options.holdAt ?? Infinity;
  }

  release(): void {
    this.#holdAt = Infinity;
    this.#release.resolve();
  }

  stream(): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (this.pulled >= this.#holdAt) {
          this.reachedHold.resolve();
          await this.#release.promise;
        }
        if (this.pulled >= this.#bytes.byteLength) {
          controller.close();
          return;
        }
        const end = Math.min(this.pulled + this.#chunk, this.#bytes.byteLength, this.#holdAt);
        controller.enqueue(this.#bytes.slice(this.pulled, end));
        this.pulled = end;
      },
      cancel: () => {
        this.cancelled = true;
        return this.#stallCancel ? new Promise<void>(() => {}) : undefined;
      },
    });
  }
}

// POST /api/{version}/media as alice (or `who`) with `body` (bytes or a stream).
export function postMedia(
  w: RouteWorld,
  body: { body: Uint8Array | ReadableStream<Uint8Array>; contentType: string },
  version: "v1" | "v2" = "v2",
  who: "alice" | "bob" = "alice",
): Promise<Response> {
  return w.h.request(`/api/${version}/media`, {
    method: "POST",
    headers: { authorization: `Bearer ${w.h.users[who].token}`, "content-type": body.contentType },
    body: body.body,
  });
}

export async function answerOf(response: Response): Promise<{ status: number; body: unknown }> {
  return { status: response.status, body: await response.json() };
}

// The staged input of upload `id`, or null.
export async function input(id: string): Promise<Uint8Array | null> {
  const object = await env.MEDIA.get(incomingKey(id));
  return object === null ? null : new Uint8Array(await object.arrayBuffer());
}

// The id of `who`'s latest reservation.
export async function lastUpload(w: RouteWorld, who: "alice" | "bob" = "alice"): Promise<string> {
  const [row] = await sql<{ id: string }>(
    w.store,
    "SELECT id FROM media_attachments WHERE account_id = ? ORDER BY id DESC LIMIT 1",
    w.h.users[who].id,
  );
  if (row === undefined) {
    throw new Error("no reservation");
  }
  return row.id;
}

// ---- An R2 bucket whose multipart calls a test may hold, observe or count

export type BucketHooks = {
  // The create's reply, held after R2 created the upload.
  holdCreate?: Promise<void>;
  // Each part's reply, held after R2 stored the part (the last part sent: the final one of a small file).
  holdPart?: Promise<void>;
  // Each part as the route sends it, before R2 stores it.
  onPart?: (part: Uint8Array) => void;
  // complete()'s reply, held after R2 committed the object; `committed` is called then.
  holdComplete?: { committed: () => void; reply: Promise<void> };
  // abort() and delete() that never answer.
  stallAbort?: boolean;
  stallDelete?: boolean;
};

export type BucketCounts = { creates: number; parts: number; completes: number; aborts: number; deletes: number };

export function hookedBucket(hooks: BucketHooks): {
  bucket: R2Bucket;
  counts: BucketCounts;
  partReached: Promise<void>;
} {
  const counts: BucketCounts = { creates: 0, parts: 0, completes: 0, aborts: 0, deletes: 0 };
  const partReached = deferred();
  const never = new Promise<never>(() => {});
  const bucket = new Proxy(env.MEDIA, {
    get(target, method: string) {
      if (method === "delete") {
        return (key: string | string[]) => {
          counts.deletes++;
          return hooks.stallDelete === true ? never : target.delete(key);
        };
      }
      if (method !== "createMultipartUpload") {
        const value = Reflect.get(target, method) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      }
      return async (key: string) => {
        counts.creates++;
        const upload = await target.createMultipartUpload(key);
        await hooks.holdCreate;
        return {
          key: upload.key,
          uploadId: upload.uploadId,
          uploadPart: async (n: number, part: Uint8Array) => {
            counts.parts++;
            hooks.onPart?.(part);
            const uploaded = await upload.uploadPart(n, part);
            partReached.resolve();
            await hooks.holdPart;
            return uploaded;
          },
          complete: async (p: R2UploadedPart[]) => {
            counts.completes++;
            const object = await upload.complete(p);
            if (hooks.holdComplete !== undefined) {
              hooks.holdComplete.committed();
              await hooks.holdComplete.reply;
            }
            return object;
          },
          abort: () => {
            counts.aborts++;
            return hooks.stallAbort === true ? never : upload.abort();
          },
        };
      };
    },
  });
  return { bucket, counts, partReached: partReached.promise };
}

// POST like postMedia, also giving the response as it is sent (before the background work it leaves settles) and the
// number of waitUntil registrations made so far.
export function postWatched(
  w: RouteWorld,
  body: { body: Uint8Array | ReadableStream<Uint8Array>; contentType: string },
  version: "v1" | "v2" = "v2",
): { answered: Promise<Response>; done: Promise<Response>; registered: () => number } {
  const answered = deferred<Response>();
  let registered = 0;
  const stop = w.h.watch({ registered: () => registered++, answered: (response) => answered.resolve(response) });
  const done = postMedia(w, body, version).finally(stop);
  done.catch(() => {});
  return { answered: answered.promise, done, registered: () => registered };
}
