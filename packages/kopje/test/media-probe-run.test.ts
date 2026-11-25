import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { healthReport } from "../src/app/health";
import { PROBE_RETRY_MS } from "../src/domain/media-probes";
import { runUpload } from "../src/jobs/media-jobs";
import {
  activationProbe,
  PROBE_CALL_MS,
  PROBE_COPY_MS,
  PROBE_FLOOR_MS,
  PROBE_STORE_MS,
  probeWork,
  stillCheck,
} from "../src/mastodon/media-activation";
import { readConfig } from "../src/platform/config";
import { probeInputKey } from "../src/platform/media-files";
import type { StillOutcome } from "../src/platform/media-transcoder";
import type { StoreStub } from "../src/platform/store-client";
import { avFixture, verifyBytes } from "./av-helpers";
import { BUILD } from "./helpers";
import { TestCodec } from "./media-helpers";
import {
  fakeControl,
  jobOf,
  probeProcessor,
  putInput,
  type ServerAnswer,
  stillPng,
  truncatedStill,
  uploadDeps,
} from "./media-job-helpers";
import { avWorld, clock, SECOND, started, T0 } from "./media-processing-helpers";
import { community } from "./status-helpers";
import { encodeWebp } from "./webp-fixtures";

// The activation probe of normalize@standard-4 as the round and the CLI run it (mastodon/media-activation.ts
// activationProbe and probeWork, the PR4 plan's "Probe outcomes"), the container answering as
// container/server/main.go does, the verdict recorded by the production Store and read back as health shows it.

afterEach(() => {
  vi.useRealTimers();
});

async function freshStore(): Promise<StoreStub> {
  const h = await community(["alice"], "read write");
  vi.useFakeTimers({ toFake: ["Date"] });
  clock(T0);
  return h.store;
}

const ACTIVE_CONFIG = () => readConfig({ ...env, MEDIA_UPLOAD_MONTHLY_JOBS: "10" });

async function health(store: StoreStub) {
  const report = await healthReport(BUILD, ACTIVE_CONFIG(), () => store, { mediaProcessor: { binding: true } });
  return report.checks.mediaProcessor;
}

async function genuine(extra: Partial<ServerAnswer> = {}): Promise<ServerAnswer> {
  const output = await avFixture("r1-av.mp4");
  const verdict = await verifyBytes("video/mp4", output);
  if (!verdict.ok) {
    throw new Error("fixture refused");
  }
  return {
    output,
    durationMs: String(Math.round(verdict.facts.duration * 1000)),
    still: await stillPng(),
    ...extra,
  };
}

async function probeOnce(
  store: StoreStub,
  answer: ServerAnswer,
  options: { codec?: TestCodec; ready?: Fetcher | "wrong" | null | undefined; due?: boolean } = {},
) {
  const fake = fakeControl(answer, { ready: options.ready });
  const processor = probeProcessor(fake.control, options.codec ?? new TestCodec(), await avFixture("r1-av.mp4"));
  const run = await activationProbe({ build: BUILD, store, bucket: env.MEDIA, processor }, options.due ?? false);
  return { run, fake };
}

describe("the activation probe's outcomes (P4, P5)", () => {
  it("passes a genuine output whose still Images re-encodes, and the copy is gone", async () => {
    const store = await freshStore();
    const { run } = await probeOnce(store, await genuine());
    expect(run).toEqual({ status: "recorded", verdict: { outcome: "pass", imagesVerified: true } });
    expect(await health(store)).toMatchObject({ ok: true, state: "ready", imagesVerified: true });
    expect((await env.MEDIA.list({ prefix: "incoming/probe-" })).objects).toEqual([]);
  });

  it("Images' 9422 passes unverified, is not claimable within PROBE_RETRY_MS and is after it; then an undecodable still fails and revokes", async () => {
    const store = await freshStore();
    const quota = new TestCodec();
    quota.failEncode = 9422;
    expect((await probeOnce(store, await genuine(), { codec: quota })).run).toEqual({
      status: "recorded",
      verdict: { outcome: "pass", imagesVerified: false },
    });
    expect(await health(store)).toMatchObject({ state: "ready", imagesVerified: false });
    expect((await probeOnce(store, await genuine(), { due: true })).run.status).toBe("cooldown");
    clock(T0 + PROBE_RETRY_MS + SECOND);
    const refusing = new TestCodec();
    refusing.failEncode = 9412;
    const { run } = await probeOnce(store, await genuine({ still: await truncatedStill() }), {
      codec: refusing,
      due: true,
    });
    expect(run).toEqual({ status: "recorded", verdict: { outcome: "fail", reason: "images" } });
    expect(await health(store)).toMatchObject({ ok: false, state: "degraded" });
    expect((await store.avActivation(BUILD, { binding: true, budget: 10, build: BUILD })).active).toBe(false);
  });

  // r4: fail only on positive evidence that the build is wrong, each row of it.
  it.each([
    ["a readiness answered 404", {}, "wrong" as const, "healthz"],
    // M10: a healthy /healthz with no /normalize, or no /normalize/still, is the build's.
    ["a /normalize answered 404", { failure: { status: 404, code: "not_found" } }, undefined, "normalize:not_found"],
    ["a still route answered 404", { stillFailure: { status: 404, code: "not_found" } }, undefined, "still:not_found"],
    ["a 200 without its declared duration", { durationMs: null }, undefined, "normalize-contract"],
    ["a 200 whose length breaks the contract", { lengthOff: 1 }, undefined, "output:"],
    ["a still with no Content-Length", { stillLength: "none" as const }, undefined, "still-length"],
    ["an output the verifier refuses", { output: new Uint8Array(4096).fill(7) }, undefined, "output:"],
    ["an output declared 4 s longer than it is", { durationMs: "6000" }, undefined, "output:"],
    ["a still verifyStill refuses", { still: new Uint8Array(10) }, undefined, "still"],
  ])("fails on %s, and health is degraded", async (_name, extra, ready, reason) => {
    const store = await freshStore();
    const { run } = await probeOnce(store, await genuine(extra), { ready });
    expect(run).toMatchObject({ status: "recorded", verdict: { outcome: "fail" } });
    expect(run.status === "recorded" && run.verdict.outcome === "fail" && run.verdict.reason).toContain(reason);
    expect(await health(store)).toMatchObject({ ok: false, state: "degraded" });
  });

  // r4: every other answer says nothing of the build: the existing pass is kept.
  it.each([
    // Codex r4: what Go answers to a work deadline too short for the clip's envelope.
    ["422 envelope", { failure: { status: 422, code: "envelope" } }],
    // Gemini r4: an ffmpeg the host killed answers encode_failed.
    ["500 encode_failed", { failure: { status: 500, code: "encode_failed" } }],
    // Gemini r4: a still past its reserve under contention answers the video with Kopje-Still: false.
    ["a video answered without its still", { still: null }],
    ["422 pixels (a refusal of the packaged clip)", { failure: { status: 422, code: "pixels" } }],
    ["422 truncated", { failure: { status: 422, code: "truncated" } }],
    ["400 truncated", { failure: { status: 400, code: "truncated" } }],
    ["400 bad_request", { failure: { status: 400, code: "bad_request" } }],
    ["405 method_not_allowed", { failure: { status: 405, code: "method_not_allowed" } }],
    ["408 input_timeout", { failure: { status: 408, code: "input_timeout" } }],
    ["429 busy", { failure: { status: 429, code: "busy" } }],
    ["500 internal", { failure: { status: 500, code: "internal" } }],
    ["500 no_output", { failure: { status: 500, code: "no_output" } }],
    ["500 strip_failed", { failure: { status: 500, code: "strip_failed" } }],
    ["502", { failure: { status: 502 } }],
    ["503", { failure: { status: 503 } }],
    ["504 timeout", { failure: { status: 504, code: "timeout" } }],
    ["a code no server answers", { failure: { status: 418, code: "teapot" } }],
    ["a still cut short of its Content-Length", { stillLength: "short" as const }],
    ["a still answered 502", { stillFailure: { status: 502 } }],
    ["a still answered 500 internal", { stillFailure: { status: 500, code: "internal" } }],
    ["a still answered 405", { stillFailure: { status: 405, code: "method_not_allowed" } }],
  ])("keeps an existing pass on %s: no verdict, health ready", async (_name, extra) => {
    const store = await freshStore();
    expect((await probeOnce(store, await genuine())).run).toMatchObject({ verdict: { outcome: "pass" } });
    // An upload's infrastructure failure makes the profile due again.
    await store.recordMediaInfrastructureFailure(BUILD, { profile: "normalize@standard-4", build: BUILD });
    clock(T0 + PROBE_RETRY_MS + SECOND);
    const { run } = await probeOnce(store, await genuine(extra), { due: true });
    expect(run).toMatchObject({ status: "recorded", verdict: { outcome: "no-verdict" } });
    expect(await health(store)).toMatchObject({ ok: true, state: "ready" });
  });

  // r4 (Codex M2): the copy read with less than the clip's floor left (1,500 ms here) sends nothing; with the floor
  // left the probe is sent, its still reserve half of it, and with the whole budget its reserve is PROBE_STILL_MS.
  it.each([
    ["1,500 ms", 1_500, null],
    ["one millisecond under PROBE_FLOOR_MS", PROBE_FLOOR_MS - 1, null],
    ["PROBE_FLOOR_MS", PROBE_FLOOR_MS, `work_ms=${PROBE_FLOOR_MS}&still_ms=${Math.floor(PROBE_FLOOR_MS / 2)}`],
    ["70 s", 70_000, "work_ms=70000&still_ms=5000"],
  ])("sends a probe whose copy is read with %s left only with the clip's floor", async (_name, left, query) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    clock(T0);
    const fake = fakeControl(await genuine());
    const deadline = Date.now() + 70_000;
    const bucket = {
      get: async (key: string) => {
        clock(deadline - left);
        return env.MEDIA.get(key);
      },
    };
    const key = probeInputKey("1".repeat(32));
    await env.MEDIA.put(key, await avFixture("r1-av.mp4"));
    try {
      const stage = await probeWork({ ...fake.control, bucket, now: () => Date.now() }, key, deadline, 70_000);
      const sent = fake.calls.filter((call) => call.startsWith("POST /normalize"));
      if (query === null) {
        expect(stage).toEqual({ outcome: "no-verdict", reason: "budget" });
        expect(sent).toEqual([]);
      } else {
        expect(stage).toMatchObject({ outcome: "still" });
        expect(sent).toEqual([`POST /normalize?${query}`]);
      }
    } finally {
      await env.MEDIA.delete(key);
    }
  });

  it("revokes an existing pass on a /normalize answered 404 by a healthy container", async () => {
    const store = await freshStore();
    expect((await probeOnce(store, await genuine())).run).toMatchObject({ verdict: { outcome: "pass" } });
    // An upload's infrastructure failure makes the profile due again.
    await store.recordMediaInfrastructureFailure(BUILD, { profile: "normalize@standard-4", build: BUILD });
    clock(T0 + PROBE_RETRY_MS + SECOND);
    const { run } = await probeOnce(store, await genuine({ failure: { status: 404, code: "not_found" } }), {
      due: true,
    });
    expect(run).toMatchObject({ status: "recorded", verdict: { outcome: "fail" } });
    expect(await health(store)).toMatchObject({ ok: false, state: "degraded" });
  });

  it("fails a still Images made past STILL_LONG_EDGE, on both profiles, as the rebuild refuses it (M5)", async () => {
    const wide = await encodeWebp(700, 100, { fill: "flat" });
    const codec = () => {
      const made = new TestCodec();
      made.encodeResponder = (options) => (options.format === "image/webp" ? wide : null);
      return made;
    };
    const store = await freshStore();
    const { run } = await probeOnce(store, await genuine(), { codec: codec() });
    expect(run).toMatchObject({ status: "recorded", verdict: { outcome: "fail", reason: "images" } });
    const checked = await stillCheck({
      bucket: env.MEDIA,
      stills: {
        still: () => Promise.reject(new Error("unused")),
        probe: async () => ({ ok: true, png: await stillPng(), image: null }),
        probeInput: new Uint8Array([1, 2, 3]),
      },
      images: codec(),
      now: () => Date.now(),
    });
    expect(checked).toMatchObject({ outcome: "fail", reason: "images" });
  });

  it("a busy container reaches no verdict: the last verdict stands", async () => {
    const store = await freshStore();
    const { run } = await probeOnce(store, await genuine({ failure: { status: 429, code: "busy" } }));
    expect(run).toMatchObject({ status: "recorded", verdict: { outcome: "no-verdict" } });
    expect(await health(store)).toMatchObject({ state: "provisioned", lastProbe: "unavailable" });
  });

  it("a start never ready reaches no verdict: provisioned with lastProbe unavailable, and after a pass the pass is kept (M10)", async () => {
    const store = await freshStore();
    expect(await health(store)).toMatchObject({ state: "provisioned", lastProbe: "never" });
    const { run } = await probeOnce(store, await genuine(), { ready: null });
    expect(run).toEqual({ status: "recorded", verdict: { outcome: "no-verdict", reason: "ready" } });
    expect(await health(store)).toMatchObject({ ok: true, state: "provisioned", lastProbe: "unavailable" });
    clock(T0 + PROBE_RETRY_MS + SECOND);
    await probeOnce(store, await genuine());
    clock(T0 + 2 * PROBE_RETRY_MS + 2 * SECOND);
    await probeOnce(store, await genuine(), { ready: null });
    expect(await health(store)).toMatchObject({ ok: true, state: "ready" });
  });

  it("an upload's encode_failed is the input's: no infrastructure failure, health and the probe schedule unchanged (A5)", async () => {
    const w = await avWorld();
    const up = await started(w);
    await putInput(up.id);
    await runUpload(
      uploadDeps(w, fakeControl({ failure: { status: 500, code: "encode_failed" } }).control),
      await jobOf(w, up),
    );
    expect((await w.store.mediaProbeRecords(BUILD, { profile: "normalize@standard-4" })).failure).toBeNull();
    expect(await health(w.store)).not.toHaveProperty("infrastructureFailure");
    expect(
      (await w.store.claimMediaProbe(BUILD, { profile: "normalize@standard-4", build: BUILD, due: true })).status,
    ).toBe("not_due");
  });
});

describe("health's mediaProcessor (P23)", () => {
  it("is disabled without the binding or with a budget of 0, and names which", async () => {
    const store = await freshStore();
    const off = await healthReport(BUILD, ACTIVE_CONFIG(), () => store, { mediaProcessor: { binding: false } });
    expect(off.checks.mediaProcessor).toMatchObject({ ok: true, state: "disabled", reason: "binding" });
    const zero = await healthReport(BUILD, readConfig(env), () => store, { mediaProcessor: { binding: true } });
    expect(zero.checks.mediaProcessor).toMatchObject({ ok: true, state: "disabled", reason: "budget" });
  });

  it("is ready with an infrastructure failure noted after an upload's still met one, admission kept", async () => {
    const w = await avWorld();
    const up = await started(w);
    await putInput(up.id);
    clock(T0 + SECOND);
    const refusing = new TestCodec();
    refusing.failEncode = 9412;
    await runUpload(uploadDeps(w, fakeControl(await genuine()).control, { images: refusing }), await jobOf(w, up));
    expect(await health(w.store)).toMatchObject({ ok: true, state: "ready", infrastructureFailure: true, budget: 10 });
  });

  it("notes an infrastructure failure stamped in the pass's millisecond, as the probe schedule makes a probe due", async () => {
    const w = await avWorld();
    await w.store.recordMediaInfrastructureFailure(BUILD, { profile: "normalize@standard-4", build: BUILD });
    // Due within the pass's cooldown (not_due when it is not).
    expect(
      (await w.store.claimMediaProbe(BUILD, { profile: "normalize@standard-4", build: BUILD, due: true })).status,
    ).toBe("cooldown");
    expect(await health(w.store)).toMatchObject({ ok: true, state: "ready", infrastructureFailure: true });
  });
});

describe("the still check of still@standard-1 (kopje-admin media-processor probe)", () => {
  async function check(out: StillOutcome, codec = new TestCodec()) {
    const store = await freshStore();
    const before = await store.mediaProbeRecords(BUILD, { profile: "still@standard-1" });
    const verdict = await stillCheck({
      bucket: env.MEDIA,
      stills: {
        still: () => Promise.reject(new Error("unused")),
        probe: () => Promise.resolve(out),
        probeInput: new Uint8Array([1, 2, 3]),
      },
      images: codec,
      now: () => Date.now(),
    });
    // It records nothing: the profile's record is the rebuild's (L4).
    expect(await store.mediaProbeRecords(BUILD, { profile: "still@standard-1" })).toEqual(before);
    expect((await env.MEDIA.list({ prefix: "incoming/probe-" })).objects).toEqual([]);
    return verdict;
  }

  it("passes a still Images re-encodes, unverified on 9422, and fails one Images refuses", async () => {
    const png = await stillPng();
    expect(await check({ ok: true, png, image: "img" })).toEqual({
      outcome: "pass",
      imagesVerified: true,
      image: "img",
    });
    const quota = new TestCodec();
    quota.failEncode = 9422;
    expect(await check({ ok: true, png, image: null }, quota)).toMatchObject({
      outcome: "pass",
      imagesVerified: false,
    });
    const refusing = new TestCodec();
    refusing.failEncode = 9412;
    expect(await check({ ok: true, png: await truncatedStill(), image: null }, refusing)).toMatchObject({
      outcome: "fail",
      reason: "images",
    });
  });

  it("fails a /still route answered 404 and a PNG verifyStill refuses; anything else, a refusal of the clip among it, reaches no verdict", async () => {
    expect(await check({ ok: false, failure: "still:not_found", image: null })).toMatchObject({
      outcome: "fail",
      reason: "still:not_found",
    });
    expect(await check({ ok: false, failure: "still:pixels", input: "pixels", image: null })).toMatchObject({
      outcome: "no-verdict",
    });
    expect(await check({ ok: true, png: new Uint8Array(10), image: null })).toMatchObject({
      outcome: "fail",
      reason: "still",
    });
    expect(await check({ ok: false, failure: "ready", image: null })).toMatchObject({
      outcome: "no-verdict",
      reason: "ready",
    });
  });
});

// r3 M4: the probes' copy I/O and the call to the probe object run on an HTTP request, where no alarm or cron limit
// applies: each is bounded, and a copy whose delete never answers is left to the orphan pass.
describe("the probes' copy I/O, bounded on the request path", () => {
  // A wait the test expires by its length, and the bucket calls it holds.
  function harness(hold: "put" | "late-put" | "delete" | "none") {
    const waits: { ms: number; resolve: () => void }[] = [];
    const wait = (ms: number) => new Promise<void>((resolve) => void waits.push({ ms, resolve }));
    const expire = (ms: number) => {
      for (const pending of waits.filter((entry) => entry.ms === ms)) {
        pending.resolve();
      }
    };
    // A put held until `release`, which then makes it (the copy landing late).
    const late: (() => Promise<void>)[] = [];
    const release = () => Promise.all(late.map((put) => put()));
    const bucket = {
      put: (key: string, value: Uint8Array) => {
        if (hold === "put") {
          return new Promise<never>(() => {});
        }
        if (hold === "late-put") {
          return new Promise((resolve) => late.push(async () => resolve(await env.MEDIA.put(key, value))));
        }
        return env.MEDIA.put(key, value);
      },
      delete: (key: string) => (hold === "delete" ? new Promise<never>(() => {}) : env.MEDIA.delete(key)),
      get: (key: string) => env.MEDIA.get(key),
    } as unknown as R2Bucket;
    return { waits, wait, expire, bucket, release };
  }
  const copies = async () => (await env.MEDIA.list({ prefix: "incoming/probe-" })).objects.map((o) => o.key);

  // r4 LOW: a put past its bound that lands after the probe's delete is deleted once it lands, on both profiles.
  it.each(["normalize", "still"] as const)(
    "a %s probe's copy put that lands after its bound is deleted then",
    async (profile) => {
      const store = await freshStore();
      const h = harness("late-put");
      const before = await copies();
      const processor = probeProcessor(
        fakeControl(await genuine()).control,
        new TestCodec(),
        await avFixture("r1-av.mp4"),
      );
      const running =
        profile === "normalize"
          ? activationProbe({ build: BUILD, store, bucket: h.bucket, processor, wait: h.wait }, false)
          : stillCheck({
              bucket: h.bucket,
              stills: {
                still: () => Promise.reject(new Error("unused")),
                probe: () => Promise.reject(new Error("unused")),
                probeInput: new Uint8Array([1, 2, 3]),
              },
              images: new TestCodec(),
              now: () => Date.now(),
              wait: h.wait,
            });
      // The put's bound, then the delete's (of a key not yet there).
      await vi.waitFor(() => expect(h.waits.filter((entry) => entry.ms === PROBE_COPY_MS)).toHaveLength(1));
      h.expire(PROBE_COPY_MS);
      await vi.waitFor(() => expect(h.waits.filter((entry) => entry.ms === PROBE_COPY_MS)).toHaveLength(2));
      h.expire(PROBE_COPY_MS);
      expect(await running).toMatchObject(
        profile === "normalize" ? { verdict: { outcome: "no-verdict", reason: "copy" } } : { reason: "copy" },
      );
      await h.release();
      await vi.waitFor(async () => expect(await copies()).toEqual(before));
    },
  );

  // r4 M1: the request's Store calls end by their bound: a claim not answered runs nothing, a record not answered
  // leaves the claim's fence, under which a late record still commits.
  it("a claim that never answers ends at PROBE_STORE_MS, unconfirmed, nothing copied or probed", async () => {
    const store = await freshStore();
    const h = harness("none");
    const before = await copies();
    const fake = fakeControl(await genuine());
    const processor = probeProcessor(fake.control, new TestCodec(), await avFixture("r1-av.mp4"));
    const held = {
      claimMediaProbe: () => new Promise<never>(() => {}),
      recordMediaProbeResult: store.recordMediaProbeResult.bind(store),
    } as unknown as StoreStub;
    const running = activationProbe({ build: BUILD, store: held, bucket: h.bucket, processor, wait: h.wait }, false);
    await vi.waitFor(() => expect(h.waits.map((entry) => entry.ms)).toContain(PROBE_STORE_MS));
    h.expire(PROBE_STORE_MS);
    expect(await running).toEqual({ status: "unconfirmed", verdict: null });
    expect(fake.calls).toEqual([]);
    expect(await copies()).toEqual(before);
  });

  it("a record that never answers ends at PROBE_STORE_MS, unconfirmed with its verdict, and the claim's fence stays for a late record", async () => {
    const store = await freshStore();
    const h = harness("none");
    const processor = probeProcessor(
      fakeControl(await genuine()).control,
      new TestCodec(),
      await avFixture("r1-av.mp4"),
    );
    let claimed: string | null = null;
    const held = {
      claimMediaProbe: async (build: string, input: Parameters<StoreStub["claimMediaProbe"]>[1]) => {
        const claim = await store.claimMediaProbe(build, input);
        claimed = claim.status === "claimed" ? claim.claim : null;
        return claim;
      },
      recordMediaProbeResult: () => new Promise<never>(() => {}),
    } as unknown as StoreStub;
    const running = activationProbe({ build: BUILD, store: held, bucket: h.bucket, processor, wait: h.wait }, false);
    await vi.waitFor(() => expect(h.waits.filter((entry) => entry.ms === PROBE_STORE_MS)).toHaveLength(2), {
      timeout: 5000,
    });
    h.expire(PROBE_STORE_MS);
    expect(await running).toEqual({ status: "unconfirmed", verdict: { outcome: "pass", imagesVerified: true } });
    // The claim is not released: another probe is not claimed meanwhile, and the late record commits under it.
    expect(
      (await store.claimMediaProbe(BUILD, { profile: "normalize@standard-4", build: BUILD, due: false })).status,
    ).not.toBe("claimed");
    expect(
      await store.recordMediaProbeResult(BUILD, {
        profile: "normalize@standard-4",
        claim: claimed!,
        outcome: "pass",
        imagesVerified: true,
        imageTag: null,
      }),
    ).toEqual({ status: "recorded" });
    expect(await health(store)).toMatchObject({ state: "ready" });
  });

  it("a normalize probe whose copy put never answers reaches no verdict at PROBE_COPY_MS, the object never called", async () => {
    const store = await freshStore();
    const h = harness("put");
    const fake = fakeControl(await genuine());
    const processor = probeProcessor(fake.control, new TestCodec(), await avFixture("r1-av.mp4"));
    const running = activationProbe({ build: BUILD, store, bucket: h.bucket, processor, wait: h.wait }, false);
    await vi.waitFor(() => expect(h.waits.map((entry) => entry.ms)).toContain(PROBE_COPY_MS));
    h.expire(PROBE_COPY_MS);
    await vi.waitFor(() => expect(h.waits.filter((entry) => entry.ms === PROBE_COPY_MS)).toHaveLength(2));
    h.expire(PROBE_COPY_MS);
    expect(await running).toMatchObject({ status: "recorded", verdict: { outcome: "no-verdict", reason: "copy" } });
    expect(fake.calls).toEqual([]);
  });

  it("a probe object that never answers reaches no verdict at PROBE_CALL_MS, and the copy is deleted", async () => {
    const store = await freshStore();
    const h = harness("none");
    const processor = {
      ...probeProcessor(fakeControl(await genuine()).control, new TestCodec(), await avFixture("r1-av.mp4")),
      probeNormalize: () => new Promise<never>(() => {}),
    };
    const running = activationProbe({ build: BUILD, store, bucket: h.bucket, processor, wait: h.wait }, false);
    await vi.waitFor(() => expect(h.waits.map((entry) => entry.ms)).toContain(PROBE_CALL_MS));
    h.expire(PROBE_CALL_MS);
    expect(await running).toMatchObject({ status: "recorded", verdict: { outcome: "no-verdict", reason: "timeout" } });
    expect((await env.MEDIA.list({ prefix: "incoming/probe-" })).objects).toEqual([]);
  });

  it("a normalize probe whose copy delete never answers records its verdict at PROBE_COPY_MS", async () => {
    const store = await freshStore();
    const h = harness("delete");
    const processor = probeProcessor(
      fakeControl(await genuine()).control,
      new TestCodec(),
      await avFixture("r1-av.mp4"),
    );
    const running = activationProbe({ build: BUILD, store, bucket: h.bucket, processor, wait: h.wait }, false);
    // The put's bound, then the delete's.
    await vi.waitFor(() => expect(h.waits.filter((entry) => entry.ms === PROBE_COPY_MS)).toHaveLength(2), {
      timeout: 5000,
    });
    h.expire(PROBE_COPY_MS);
    expect(await running).toMatchObject({ status: "recorded", verdict: { outcome: "pass" } });
    // The copy is the orphan pass's.
    const copies = (await env.MEDIA.list({ prefix: "incoming/probe-" })).objects;
    expect(copies).toHaveLength(1);
    await env.MEDIA.delete(copies.map((object) => object.key));
  });

  it("a still check whose copy delete never answers gives its verdict at PROBE_COPY_MS", async () => {
    await freshStore();
    const h = harness("delete");
    const checking = stillCheck({
      bucket: h.bucket,
      stills: {
        still: () => Promise.reject(new Error("unused")),
        probe: async () => ({ ok: true, png: await stillPng(), image: null }),
        probeInput: new Uint8Array([1, 2, 3]),
      },
      images: new TestCodec(),
      now: () => Date.now(),
      wait: h.wait,
    });
    // The put's bound, then the delete's.
    await vi.waitFor(() => expect(h.waits.filter((entry) => entry.ms === PROBE_COPY_MS)).toHaveLength(2), {
      timeout: 5000,
    });
    h.expire(PROBE_COPY_MS);
    expect(await checking).toMatchObject({ outcome: "pass" });
    const copies = (await env.MEDIA.list({ prefix: "incoming/probe-" })).objects;
    await env.MEDIA.delete(copies.map((object) => object.key));
  });
});
