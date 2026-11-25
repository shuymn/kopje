import { env } from "cloudflare:workers";
import { expect } from "vitest";

import { UploadUnit, type UploadState } from "../src/media-processor";
import { incomingKey } from "../src/platform/media-files";
import { avFixture, verifyBytes } from "./av-helpers";
import { BUILD } from "./helpers";
import { TestCodec } from "./media-helpers";
import { putInput, stillPng } from "./media-job-helpers";
import { type AvWorld, clock, held, queued } from "./media-processing-helpers";

// An upload's object (UploadUnit, media-processor.ts) on a platform of the test's own over the production Store and
// the media bucket: it fires the armed alarm when it is due, runs one alarm() at a time, and, when an invocation is
// killed (a step that never answers, its instance abandoned), keeps the fired alarm due unless D1 replaced it.

// A Durable Object's storage: a record map and one alarm; a transaction commits its writes together at its end, or
// none of them.
export class Storage {
  map = new Map<string, unknown>();
  alarm: number | null = null;
  // A hold on a named storage call: it never answers.
  hold: string | null = null;
  constructor(private readonly kill: (name: string) => Promise<never> | null) {}
  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.map.get(key) as T | undefined);
  }
  put(key: string, value: unknown): Promise<void> {
    this.map.set(key, value);
    return Promise.resolve();
  }
  getAlarm(): Promise<number | null> {
    return Promise.resolve(this.alarm);
  }
  setAlarm(at: number): Promise<void> {
    this.alarm = at;
    return Promise.resolve();
  }
  deleteAll(): Promise<void> {
    this.map.clear();
    this.alarm = null;
    return Promise.resolve();
  }
  sync(): Promise<void> {
    return Promise.resolve();
  }
  async transaction<T>(work: (txn: Storage) => Promise<T>): Promise<T> {
    const txn = new Storage(this.kill);
    txn.map = new Map(this.map);
    txn.alarm = this.alarm;
    const out = await work(txn);
    await (this.kill("commit:run") ?? Promise.resolve());
    this.map = txn.map;
    this.alarm = txn.alarm;
    return out;
  }
}

// A container as ctx.container presents it, answering as container/server/main.go does.
function container(
  platform: {
    kill: (name: string) => Promise<never> | null;
    destroyFails: () => boolean;
    // The /normalize answer never comes ("reply"), or stops after half its body ("body"), until the request is
    // aborted; `hung` is called when it starts hanging.
    hang: () => "reply" | "body" | "still" | null;
    hung: () => void;
    // Called when the hanging request's signal aborts.
    aborted: () => void;
  },
  output: {
    bytes: Uint8Array;
    durationMs: number;
    still: Uint8Array;
  },
) {
  let running = false;
  let starts = 0;
  let startedWith: unknown = null;
  const port = {
    fetch: async (input: string, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path === "/healthz") {
        return Response.json({ ok: true });
      }
      if (path === "/normalize/still") {
        if (platform.hang() === "still") {
          init?.signal?.addEventListener("abort", platform.aborted);
          platform.hung();
          return new Promise<never>((_, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          });
        }
        return new Response(output.still, {
          headers: { "content-type": "image/png", "content-length": String(output.still.byteLength) },
        });
      }
      await request.arrayBuffer();
      const signal = init?.signal ?? undefined;
      const aborted = () =>
        new Promise<never>((_, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      const hang = platform.hang();
      if (hang === "reply" || hang === "body") {
        signal?.addEventListener("abort", platform.aborted);
      }
      if (hang === "reply") {
        platform.hung();
        return aborted();
      }
      const body =
        hang === "body"
          ? new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(output.bytes.subarray(0, output.bytes.byteLength >> 1));
                platform.hung();
                signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
              },
            })
          : output.bytes;
      return new Response(body, {
        headers: {
          "content-type": "video/mp4",
          "content-length": String(output.bytes.byteLength),
          "kopje-kind": "video",
          "kopje-still": "true",
          "kopje-duration-ms": String(output.durationMs),
        },
      });
    },
  };
  const fake = {
    get running() {
      return running;
    },
    images: { media: "registry.cloudflare.com/acct/media@sha256:abc" },
    start(options: unknown) {
      startedWith = options;
      starts++;
      running = true;
    },
    async destroy() {
      await (platform.kill("destroy") ?? Promise.resolve());
      if (platform.destroyFails()) {
        throw new Error("destroy failed");
      }
      running = false;
    },
    inspect: () => Promise.resolve({ image: "registry.cloudflare.com/acct/media@sha256:abc", labels: {} }),
    getTcpPort: () => port,
  };
  return { container: fake as unknown as Container, starts: () => starts, startedWith: () => startedWith };
}

export type Platform = Awaited<ReturnType<typeof platformFor>>;

// The platform of one upload's object, over the world's Store and the media bucket. `killAt` names the call at which
// the next invocation dies: "before:<method>" (the call is never sent), "after:<method>" (it commits, its reply never
// arrives), or "destroy", "commit:run", "delete" (the input's).
export async function platformFor(w: AvWorld) {
  const bytes = await avFixture("r1-silent.mp4");
  const verdict = await verifyBytes("video/mp4", bytes);
  if (!verdict.ok) {
    throw new Error("fixture refused");
  }
  const state = { killAt: null as string | null, killed: null as PromiseWithResolvers<void> | null };
  let destroyFails = false;
  let storeCalls: string[] = [];
  // Work run once before a Store call is sent (an operator gate set at that moment).
  const before = new Map<string, () => Promise<void>>();
  // Work run once after a Store call committed, before its reply arrives (a reply held across it).
  const after = new Map<string, () => Promise<void>>();
  // Work run once before a final write starts ("original", "full", "small"), and the writes started.
  const beforeWrite = new Map<string, () => Promise<void>>();
  const writes: string[] = [];
  // The multipart uploads aborted, by kind.
  const aborts: string[] = [];
  let maintenance = false;
  // Bucket calls held until released ("get" of the input, "create:<kind>", "abort:<kind>"), and those reached.
  const holds = new Map<string, Promise<void>>();
  const releases = new Map<string, () => void>();
  const held: string[] = [];
  // The keys the bucket was asked to delete, and how many of the next deletes fail.
  const deletes: string[] = [];
  let failingDeletes = 0;
  let hang: "reply" | "body" | "still" | null = null;
  let hung = false;
  let requestAborted = false;
  // The unit's waits (deps.wait), each due at its time on the faked clock; they resolve only when a test expires them.
  const waits: { due: number; resolve: () => void }[] = [];
  const writing = async (name: string) => {
    const hook = beforeWrite.get(name);
    beforeWrite.delete(name);
    await hook?.();
    writes.push(name);
  };
  // The next invocation's death at `name`: a call that never answers.
  const kill = (name: string): Promise<never> | null => {
    if (state.killAt !== name) {
      return null;
    }
    state.killAt = null;
    state.killed?.resolve();
    return new Promise<never>(() => {});
  };
  const store = new Proxy(w.store, {
    get(target, method: string) {
      const call = (target as unknown as Record<string, unknown>)[method];
      if (typeof call !== "function") {
        return call;
      }
      return async (...args: unknown[]) => {
        storeCalls.push(method);
        const hook = before.get(method);
        before.delete(method);
        await hook?.();
        await (kill(`before:${method}`) ?? Promise.resolve());
        const answer: unknown = await (target as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[
          method
        ]!(...args);
        const held = after.get(method);
        after.delete(method);
        await held?.();
        await (kill(`after:${method}`) ?? Promise.resolve());
        return answer;
      };
    },
  });
  const bucket = new Proxy(env.MEDIA, {
    get(target, method: string) {
      const value = (target as unknown as Record<string, unknown>)[method];
      if (typeof value !== "function") {
        return value;
      }
      return async (...args: unknown[]) => {
        const key = String(args[0]);
        if (method === "get" && key.startsWith("incoming/") && holds.has("get")) {
          held.push("get");
          await holds.get("get");
        }
        if (method === "createMultipartUpload") {
          const name = key.startsWith("originals/") ? "original" : "full";
          if (holds.has(`create:${name}`)) {
            held.push(`create:${name}`);
            await holds.get(`create:${name}`);
          }
        }
        if (method === "delete") {
          await (kill("delete") ?? Promise.resolve());
          deletes.push(String(args[0]));
          if (failingDeletes > 0) {
            failingDeletes--;
            throw new Error("r2 delete failed");
          }
        }
        if (method === "put" && String(args[0]).endsWith("/small")) {
          await writing("small");
        }
        const out = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        if (method === "createMultipartUpload") {
          const upload = out as R2MultipartUpload;
          const name = String(args[0]).startsWith("originals/") ? "original" : "full";
          const complete = upload.complete.bind(upload);
          return Object.assign(Object.create(Object.getPrototypeOf(upload) as object) as R2MultipartUpload, {
            key: upload.key,
            uploadId: upload.uploadId,
            uploadPart: upload.uploadPart.bind(upload),
            abort: async () => {
              aborts.push(name);
              await holds.get(`abort:${name}`);
              await upload.abort();
            },
            complete: async (parts: R2UploadedPart[]) => {
              await writing(name);
              await (kill(`complete:${name}`) ?? Promise.resolve());
              return complete(parts);
            },
          });
        }
        return out;
      };
    },
  });
  const storage = new Storage(kill);
  const made = container(
    {
      kill,
      destroyFails: () => destroyFails,
      hang: () => hang,
      hung: () => void (hung = true),
      aborted: () => void (requestAborted = true),
    },
    {
      bytes,
      durationMs: Math.round(verdict.facts.duration * 1000),
      still: await stillPng(),
    },
  );
  const unit = () =>
    new UploadUnit({ container: made.container, storage, bucket } as unknown as UploadState, {
      now: () => Date.now(),
      wait: (ms: number) => new Promise<void>((resolve) => void waits.push({ due: Date.now() + ms, resolve })),
      build: BUILD,
      store: () => store,
      images: new TestCodec(),
      monthlyTransforms: () => ({ instance: 4000, account: 400 }),
      maintenance: () => maintenance,
    });
  return {
    storage,
    starts: made.starts,
    startedWith: made.startedWith,
    running: () => made.container.running,
    unit,
    storeCalls: () => storeCalls,
    clearCalls: () => void (storeCalls = []),
    failDestroy: (on: boolean) => void (destroyFails = on),
    killNext: (at: string) => void (state.killAt = at),
    beforeCall: (method: string, work: () => Promise<void>) => void before.set(method, work),
    afterCall: (method: string, work: () => Promise<void>) => void after.set(method, work),
    beforeWrite: (name: "original" | "full" | "small", work: () => Promise<void>) => void beforeWrite.set(name, work),
    writes: () => writes,
    aborts: () => aborts,
    deletes: () => deletes,
    hold(call: "get" | "create:original" | "create:full" | "abort:original" | "abort:full"): void {
      holds.set(call, new Promise<void>((resolve) => releases.set(call, resolve)));
    },
    release: (call: string) => releases.get(call)?.(),
    held: () => held,
    failDeletes: (count: number) => void (failingDeletes = count),
    envMaintenance: (on: boolean) => void (maintenance = on),
    hangNormalize: (how: "reply" | "body" | "still") => void (hang = how),
    hung: () => hung,
    requestAborted: () => requestAborted,
    // The latest wait's time, or null (a wait raced and won by its work stays pending, as a timer would).
    lastWait: () => waits.at(-1)?.due ?? null,
    // The clock set to `at`, and every wait due by then resolved.
    expire(at: number): void {
      clock(at);
      for (const wait of waits.filter((pending) => pending.due <= at)) {
        waits.splice(waits.indexOf(wait), 1);
        wait.resolve();
      }
    },
    // Fires the armed alarm once, on a new instance, at its time: the alarm is consumed while it runs; an invocation
    // that dies leaves it due again unless it set another.
    async fire(): Promise<"returned" | "killed"> {
      const due = storage.alarm;
      if (due === null) {
        throw new Error("no alarm armed");
      }
      clock(Math.max(Date.now(), due));
      storage.alarm = null;
      state.killed = Promise.withResolvers<void>();
      const ran = unit()
        .alarm()
        .then(() => "returned" as const);
      const ended = await Promise.race([ran, state.killed.promise.then(() => "killed" as const)]);
      if (ended === "killed" && storage.alarm === null) {
        storage.alarm = due;
      }
      return ended;
    },
    // The platform runs every alarm that comes due, at most `limit`.
    async settle(limit = 20): Promise<number> {
      let fired = 0;
      while (storage.alarm !== null && fired < limit) {
        await this.fire();
        fired++;
      }
      return fired;
    },
  };
}

export async function upload(w: AvWorld, p: Platform) {
  const up = await queued(w);
  await putInput(up.id);
  await p.unit().run(up.id, up.token, up.teardownId);
  return up;
}

export async function cleared(w: AvWorld, p: Platform, id: string) {
  expect(p.storage.map.size).toBe(0);
  expect(p.storage.alarm).toBeNull();
  expect((await held(w.store, id)).slot).toBeNull();
  expect(await env.MEDIA.head(incomingKey(id))).toBeNull();
  expect(p.running()).toBe(false);
}
