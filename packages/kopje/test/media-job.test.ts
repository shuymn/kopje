import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TRANSFORMS_PER_POSTER } from "../src/domain/media";
import { allocate } from "../src/domain/media-processing";
import { incomingOrphans, runUpload } from "../src/jobs/media-jobs";
import { fileKey, incomingKey, originalKey, probeInputKey } from "../src/platform/media-files";
import { sql } from "./api-helpers";
import { avFixture, syntheticMp4, verifyBytes } from "./av-helpers";
import { BUILD } from "./helpers";
import { TestCodec } from "./media-helpers";
import { fakeControl, jobOf, multipartLog, putInput, stillPng, uploadDeps } from "./media-job-helpers";
import { avWorld, clock, held, HOUR, started } from "./media-processing-helpers";

// The plan's T_COMMIT and the output transfer's share of it (domain/media-processing.ts).
const T_COMMIT_MS = 6000;
const T_TRANSFER_MS = 5000;
type Cuts = { still: number; transfer: number; preview: number };
import { encodeWebp } from "./webp-fixtures";

// runUpload (jobs/media-jobs.ts, the PR4 plan's 1.3 D3-D7) through the production Store and the media bucket, the
// container answering as container/server/main.go does.

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function objects(id: string, token: string) {
  const [original, full, small] = await Promise.all([
    env.MEDIA.head(originalKey(id)),
    env.MEDIA.head(fileKey(token, "full")),
    env.MEDIA.head(fileKey(token, "small")),
  ]);
  return { original: original !== null, full: full !== null, small };
}

async function durationMs(name: string): Promise<number> {
  const verdict = await verifyBytes("video/mp4", await avFixture(name));
  if (!verdict.ok) {
    throw new Error("fixture refused");
  }
  return Math.round(verdict.facts.duration * 1000);
}

async function transformsUsed(w: Awaited<ReturnType<typeof avWorld>>): Promise<number> {
  const rows = await sql<{ value: string }>(
    w.store,
    "SELECT value FROM kopje_state WHERE name LIKE 'images_transforms:%' OR name LIKE 'images_account_transforms:%'",
  );
  return rows.reduce((sum, row) => sum + Number(row.value), 0);
}

describe("runUpload (P12)", () => {
  it("publishes a genuine output with the verifier's facts, its still as the preview, the container stopped first", async () => {
    const w = await avWorld();
    const up = await started(w);
    await putInput(up.id);
    const output = await avFixture("r1-av.mp4");
    const fake = fakeControl({ output, durationMs: String(await durationMs("r1-av.mp4")), still: await stillPng() });
    const end = await runUpload(uploadDeps(w, fake.control), await jobOf(w, up));
    expect(end).toEqual({ stopped: true });
    const after = await held(w.store, up.id);
    expect(after.row).toBeNull();
    expect(after.att).toMatchObject({ processed: 1, type: "video" });
    const files = await objects(up.id, up.token);
    expect(files).toMatchObject({ original: true, full: true });
    expect(files.small?.customMetadata).toMatchObject({ width: "320", height: "180" });
    // The stop comes after the still was read and before any write.
    expect(fake.calls.indexOf("stop")).toBeGreaterThan(fake.calls.indexOf("GET /normalize/still"));
    expect(new Uint8Array(await (await env.MEDIA.get(fileKey(up.token, "full")))!.arrayBuffer())).toEqual(output);
  });

  it("reads the declared duration in seconds through the adapter: declared as long it passes, 4 s longer it is refused (M9)", async () => {
    const w = await avWorld();
    const output = await avFixture("r1-silent.mp4");
    const ms = await durationMs("r1-silent.mp4");
    const ok = await started(w);
    await putInput(ok.id);
    await runUpload(uploadDeps(w, fakeControl({ output, durationMs: String(ms) }).control), await jobOf(w, ok));
    expect((await held(w.store, ok.id)).att?.processed).toBe(1);
    const long = await started(w);
    await putInput(long.id);
    const fake = fakeControl({ output, durationMs: String(ms + 4000) });
    const end = await runUpload(uploadDeps(w, fake.control), await jobOf(w, long));
    expect(end).toEqual({ stopped: true });
    expect((await held(w.store, long.id)).row).toMatchObject({ state: "failed", failure: "verifier" });
    // Both multipart uploads stay uncompleted.
    expect(await objects(long.id, long.token)).toMatchObject({ original: false, full: false, small: null });
  });

  it.each([
    ["an early end of the output", { truncateAt: 1000 }],
    ["an output that is not a verified MP4", { output: new Uint8Array(5000).fill(3) }],
  ])("refuses %s as the verifier's, completing neither upload", async (_name, answer) => {
    const w = await avWorld();
    const up = await started(w);
    await putInput(up.id);
    const output = await avFixture("r1-silent.mp4");
    const fake = fakeControl({ output, durationMs: String(await durationMs("r1-silent.mp4")), ...answer });
    await runUpload(uploadDeps(w, fake.control), await jobOf(w, up));
    expect((await held(w.store, up.id)).row).toMatchObject({ state: "failed", failure: "verifier" });
    expect(await objects(up.id, up.token)).toMatchObject({ original: false, full: false });
  });

  async function refusedMp3(): Promise<{ output: Uint8Array; durationMs: string }> {
    // The last byte of the last frame's audio changed: frame data is not parsed, so only the Xing frame's music CRC,
    // checked once the stream has ended, refuses it (PR3's case).
    const output = (await avFixture("mp3.mp3")).slice();
    const verdict = await verifyBytes("audio/mpeg", output);
    if (!verdict.ok) {
      throw new Error("fixture refused");
    }
    output[output.length - 1]! ^= 0xff;
    return { output, durationMs: String(Math.round(verdict.facts.duration * 1000)) };
  }

  it.each([
    [
      "an MP3 whose music CRC refuses it at its end",
      async () => ({ ...(await refusedMp3()), type: "audio/mpeg" as const }),
    ],
    [
      "the same MP3, its body ending in an empty chunk",
      async () => ({ ...(await refusedMp3()), type: "audio/mpeg" as const, emptyTail: true }),
    ],
    [
      "an output 100 bytes longer than its declared length",
      async () => ({
        output: await avFixture("r1-silent.mp4"),
        durationMs: String(await durationMs("r1-silent.mp4")),
        lengthOff: -100,
      }),
    ],
    [
      "an output that ends early",
      async () => ({
        output: await avFixture("r1-silent.mp4"),
        durationMs: String(await durationMs("r1-silent.mp4")),
        truncateAt: 1000,
      }),
    ],
  ])("aborts both multipart uploads, completing neither, for %s (P12)", async (_name, answer) => {
    const w = await avWorld();
    const up = await started(w);
    await putInput(up.id);
    const { bucket, log } = multipartLog();
    await runUpload(uploadDeps(w, fakeControl(await answer()).control, { bucket }), await jobOf(w, up));
    expect((await held(w.store, up.id)).row).toMatchObject({ state: "failed", failure: "verifier" });
    expect(log.filter((entry) => entry.startsWith("complete:"))).toEqual([]);
    expect(log.filter((entry) => entry.startsWith("abort:")).toSorted()).toEqual(["abort:full", "abort:original"]);
    expect(await objects(up.id, up.token)).toMatchObject({ original: false, full: false });
  });

  it("fails a reply that rejects at its cut timeout, not unavailable", async () => {
    const w = await avWorld();
    const up = await started(w);
    await putInput(up.id);
    const job = await jobOf(w, up);
    const { cuts } = allocate("v2", Date.now(), job.deadline, job.inputBytes);
    const output = await avFixture("r1-silent.mp4");
    const fake = fakeControl(
      { output, durationMs: String(await durationMs("r1-silent.mp4")) },
      {
        onReply: () => {
          clock(cuts.still);
          throw new Error("connection lost");
        },
      },
    );
    await runUpload(uploadDeps(w, fake.control), job);
    expect((await held(w.store, up.id)).row).toMatchObject({ state: "failed", failure: "timeout" });
  });

  it("fails an output whose part upload R2 rejects unavailable, and cancels the container's body", async () => {
    const w = await avWorld();
    const up = await started(w);
    await putInput(up.id);
    // 300 samples of 40,000 bytes at 30 fps: 10 s and 12 MB, past one 8 MiB part.
    const made = syntheticMp4(await avFixture("r1-silent.mp4"), { samples: 300, size: 40_000, delta: 512 });
    const output = await new Response(made.stream()).bytes();
    const { bucket, log } = multipartLog({ failPart: true });
    const fake = fakeControl({ output, durationMs: "10000" }, { open: true });
    await runUpload(uploadDeps(w, fake.control, { bucket }), await jobOf(w, up));
    expect((await held(w.store, up.id)).row).toMatchObject({ state: "failed", failure: "unavailable" });
    expect(fake.cancels()).toBe(1);
    expect(log.filter((entry) => entry.startsWith("abort:")).toSorted()).toEqual(["abort:full", "abort:original"]);
  });

  it("logs a rejected abort with its key and still stops the container and records the cause (M2)", async () => {
    const w = await avWorld();
    const up = await started(w);
    await putInput(up.id);
    const logged: { event?: string; key?: string }[] = [];
    vi.spyOn(console, "warn").mockImplementation((entry: { event?: string; key?: string }) => void logged.push(entry));
    const { bucket, log } = multipartLog({ failAbort: true });
    const output = await avFixture("r1-silent.mp4");
    const fake = fakeControl({ output, durationMs: String(await durationMs("r1-silent.mp4")), truncateAt: 1000 });
    await runUpload(uploadDeps(w, fake.control, { bucket }), await jobOf(w, up));
    expect(log.filter((entry) => entry.startsWith("abort:")).toSorted()).toEqual(["abort:full", "abort:original"]);
    expect(logged.filter((entry) => entry.event === "kopje.media.job.abort_failed").map((entry) => entry.key)).toEqual(
      expect.arrayContaining([fileKey(up.token, "full"), originalKey(up.id)]),
    );
    expect(logged.filter((entry) => entry.event === "kopje.media.job.abort_failed")).toHaveLength(2);
    expect(fake.stops()).toBe(1);
    expect((await held(w.store, up.id)).row).toMatchObject({ state: "failed", failure: "verifier" });
  });

  it.each([
    [{ status: 422, code: "envelope" }, "envelope"],
    [{ status: 422, code: "pixels" }, "refused"],
    [{ status: 500, code: "encode_failed" }, "refused"],
    [{ status: 504, code: "timeout" }, "timeout"],
    [{ status: 500, code: "internal" }, "unavailable"],
    [{ status: 429, code: "busy" }, "unavailable"],
  ])("records %o as %s after the confirmed stop", async (failure, cause) => {
    const w = await avWorld();
    const up = await started(w);
    await putInput(up.id);
    const fake = fakeControl({ failure });
    expect(await runUpload(uploadDeps(w, fake.control), await jobOf(w, up))).toEqual({ stopped: true });
    expect(fake.stops()).toBe(1);
    expect((await held(w.store, up.id)).row).toMatchObject({ state: "failed", failure: cause });
  });

  it("records unavailable and reports the stop unconfirmed when the container does not stop", async () => {
    const w = await avWorld();
    const up = await started(w);
    await putInput(up.id);
    const fake = fakeControl({ failure: { status: 422, code: "envelope" } }, { stop: () => Promise.resolve(false) });
    expect(await runUpload(uploadDeps(w, fake.control), await jobOf(w, up))).toEqual({ stopped: false });
    expect((await held(w.store, up.id)).row).toMatchObject({ state: "failed", failure: "unavailable" });
  });

  it("keeps a container's or R2's body out of the log and the recorded failure (DATA-5)", async () => {
    const w = await avWorld();
    const up = await started(w);
    await putInput(up.id);
    const logged: unknown[] = [];
    vi.spyOn(console, "warn").mockImplementation((entry: unknown) => void logged.push(entry));
    const body = "SECRET-CONTAINER-BODY";
    await runUpload(
      uploadDeps(w, fakeControl({ failure: { status: 500, code: "internal", body } }).control),
      await jobOf(w, up),
    );
    const failing = { ...env.MEDIA, get: () => Promise.reject(new Error("SECRET-R2-BODY")) } as unknown as R2Bucket;
    const other = await started(w);
    await runUpload(uploadDeps(w, fakeControl({}).control, { bucket: failing }), await jobOf(w, other));
    const text = JSON.stringify(logged) + JSON.stringify(await held(w.store, up.id));
    expect(logged.length).toBeGreaterThan(0);
    expect(text).not.toContain(body);
    expect((await held(w.store, other.id)).row).toMatchObject({ failure: "unavailable" });
  });
});

describe("the upload's still (G2-3, C2-M4)", () => {
  async function run(codec: TestCodec, monthly = { instance: 4000, account: 400 }) {
    const w = await avWorld();
    const up = await started(w);
    await putInput(up.id);
    const output = await avFixture("r1-av.mp4");
    const fake = fakeControl({ output, durationMs: String(await durationMs("r1-av.mp4")), still: await stillPng() });
    const before = await transformsUsed(w);
    await runUpload(uploadDeps(w, fake.control, { images: codec, monthlyTransforms: monthly }), await jobOf(w, up));
    const records = await w.store.mediaProbeRecords(BUILD, { profile: "normalize@standard-4" });
    return {
      after: await held(w.store, up.id),
      files: await objects(up.id, up.token),
      failure: records.failure,
      charged: (await transformsUsed(w)) - before,
    };
  }

  it("completes with the poster and records an infrastructure failure when Images refuses a still verifyStill passed (9412)", async () => {
    const codec = new TestCodec();
    codec.failEncode = 9412;
    const { after, files, failure } = await run(codec);
    expect(after.att?.processed).toBe(1);
    expect(files.small).toBeNull();
    expect(failure).toMatchObject({ version: BUILD });
  });

  it("completes with the poster and records nothing on Images' 9422", async () => {
    const codec = new TestCodec();
    codec.failEncode = 9422;
    const { after, files, failure } = await run(codec);
    expect(after.att?.processed).toBe(1);
    expect(files.small).toBeNull();
    expect(failure).toBeNull();
  });

  it("charges TRANSFORMS_PER_POSTER once for a video's still, and nothing when the budgets have no room (P15)", async () => {
    expect((await run(new TestCodec())).charged).toBe(2 * TRANSFORMS_PER_POSTER);
    const spent = await run(new TestCodec(), { instance: 0, account: 0 });
    expect(spent.charged).toBe(0);
    expect(spent.files.small).toBeNull();
    expect(spent.after.att?.processed).toBe(1);
  });

  it("writes no small Images made past STILL_LONG_EDGE, as the rebuild refuses it, and completes with the poster (M5)", async () => {
    const codec = new TestCodec();
    const wide = await encodeWebp(700, 100, { fill: "flat" });
    codec.encodeResponder = (options) => (options.format === "image/webp" ? wide : null);
    const { after, files } = await run(codec);
    expect(after.att?.processed).toBe(1);
    expect(files.small).toBeNull();
  });

  it("charges no Images transformation for audio, which has no still (P15)", async () => {
    const w = await avWorld();
    const up = await started(w);
    await putInput(up.id);
    const output = await avFixture("mp3.mp3");
    const verdict = await verifyBytes("audio/mpeg", output);
    if (!verdict.ok) {
      throw new Error("fixture refused");
    }
    const durationMs = String(Math.round(verdict.facts.duration * 1000));
    const before = await transformsUsed(w);
    const fake = fakeControl({ output, type: "audio/mpeg", durationMs });
    await runUpload(uploadDeps(w, fake.control), await jobOf(w, up));
    expect((await held(w.store, up.id)).att).toMatchObject({ processed: 1, type: "audio" });
    expect((await transformsUsed(w)) - before).toBe(0);
    expect(fake.calls).not.toContain("GET /normalize/still");
  });

  // In execution order (M3): the output's transfer has T_TRANSFER from the still's cut, then the still and its preview
  // until T_COMMIT less T_TRANSFER before the deadline, which is left for the stop and the writes.
  async function blurhashWith(options: {
    replyAt?: (cut: Cuts) => number;
    transferMs?: number;
    stillAt?: (cut: Cuts) => number;
  }) {
    const w = await avWorld();
    const up = await started(w);
    await putInput(up.id);
    const job = await jobOf(w, up);
    const { cuts, deadline } = allocate("v2", Date.now(), job.deadline, job.inputBytes);
    const at: Cuts = {
      still: cuts.still,
      transfer: cuts.still + T_TRANSFER_MS,
      preview: deadline - (T_COMMIT_MS - T_TRANSFER_MS),
    };
    const output = await avFixture("r1-av.mp4");
    const fake = fakeControl(
      { output, durationMs: String(await durationMs("r1-av.mp4")), still: await stillPng() },
      {
        ...(options.replyAt === undefined ? {} : { onReply: () => clock(options.replyAt!(at)) }),
        ...(options.transferMs === undefined ? {} : { transferMs: options.transferMs }),
        ...(options.stillAt === undefined ? {} : { onStill: () => clock(options.stillAt!(at)) }),
      },
    );
    await runUpload(uploadDeps(w, fake.control), job);
    return {
      held: await held(w.store, up.id),
      blurhash: (await objects(up.id, up.token)).small?.customMetadata?.blurhash,
    };
  }

  it("gives a preview begun after the whole transfer a blurhash, and none with 2 s left before its cut", async () => {
    expect((await blurhashWith({ stillAt: (at) => at.transfer })).blurhash).toMatch(/^.{6,}$/);
    expect((await blurhashWith({ stillAt: (at) => at.preview - 2000 })).blurhash).toBe("");
  });

  it("completes an output whose headers come 50 ms before the still's cut and whose body takes 4.2 s (M3)", async () => {
    const { held: after } = await blurhashWith({ replyAt: (at) => at.still - 50, transferMs: 4200 });
    expect(after.att).toMatchObject({ processed: 1 });
  });

  it("keeps a healthy blurhash after a 1.2 s transfer that began at the still's cut (M3)", async () => {
    const { blurhash } = await blurhashWith({ replyAt: (at) => at.still - 50, transferMs: 1200 });
    expect(blurhash).toMatch(/^.{6,}$/);
  });
});

// The Store's clock (and this isolate's Date) set `ms` past the real time, which R2 stamps an object's upload with.
function pastRealTime(ms: number): void {
  vi.useRealTimers();
  const real = Date.now();
  vi.useFakeTimers({ toFake: ["Date"] });
  clock(real + ms);
}

describe("incomingOrphans (G14, W3)", () => {
  it("a round that dies between its delete and its checkpoint is repeated harmlessly, and the cursor wraps", async () => {
    const w = await avWorld();
    const orphan = incomingKey("300000000000009997");
    await env.MEDIA.put(orphan, "x");
    pastRealTime(25 * HOUR);
    const dying = new Proxy(w.store, {
      get(target, method: string) {
        if (method === "incomingSwept") {
          return () => Promise.reject(new Error("died"));
        }
        return (...args: unknown[]) =>
          (target as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method]!(...args);
      },
    });
    await expect(incomingOrphans({ build: BUILD, store: dying, bucket: env.MEDIA })).rejects.toThrow("died");
    expect(await env.MEDIA.head(orphan)).toBeNull();
    pastRealTime(27 * HOUR);
    await incomingOrphans({ build: BUILD, store: w.store, bucket: env.MEDIA });
    const [state] = await sql<{ value: string }>(
      w.store,
      "SELECT value FROM kopje_state WHERE name = 'media_incoming_sweep'",
    );
    // One page held every key: the checkpoint wraps to the start.
    expect(JSON.parse(state?.value ?? "{}")).toMatchObject({ cursor: "" });
  });

  it("removes an unheld incoming/ key older than a day and a probe copy, keeps a held one, and checkpoints", async () => {
    const w = await avWorld();
    const up = await started(w);
    await putInput(up.id);
    const orphan = incomingKey("300000000000009999");
    const probe = probeInputKey("0".repeat(32));
    await env.MEDIA.put(orphan, "x");
    await env.MEDIA.put(probe, "x");
    pastRealTime(25 * HOUR);
    await incomingOrphans({ build: BUILD, store: w.store, bucket: env.MEDIA });
    expect(await env.MEDIA.head(orphan)).toBeNull();
    expect(await env.MEDIA.head(probe)).toBeNull();
    expect(await env.MEDIA.head(incomingKey(up.id))).not.toBeNull();
  });

  it("keeps the cursor when the delete fails, and repeats the page harmlessly on the next claim", async () => {
    const w = await avWorld();
    const orphan = incomingKey("300000000000009998");
    await env.MEDIA.put(orphan, "x");
    pastRealTime(25 * HOUR);
    const failing = {
      ...env.MEDIA,
      list: env.MEDIA.list.bind(env.MEDIA),
      delete: () => Promise.reject(new Error("r2")),
    };
    await expect(incomingOrphans({ build: BUILD, store: w.store, bucket: failing })).rejects.toThrow("r2");
    const [state] = await sql<{ value: string }>(
      w.store,
      "SELECT value FROM kopje_state WHERE name = 'media_incoming_sweep'",
    );
    expect(JSON.parse(state?.value ?? "{}")).toMatchObject({ cursor: "" });
    expect((JSON.parse(state?.value ?? "{}") as { claim: unknown }).claim).not.toBeNull();
    pastRealTime(27 * HOUR);
    await incomingOrphans({ build: BUILD, store: w.store, bucket: env.MEDIA });
    expect(await env.MEDIA.head(orphan)).toBeNull();
  });
});
