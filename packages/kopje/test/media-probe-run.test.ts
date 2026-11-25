import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { healthReport } from "../src/app/health";
import { PROBE_RETRY_MS } from "../src/domain/media-probes";
import { runUpload } from "../src/jobs/media-jobs";
import { activationProbe } from "../src/mastodon/media-activation";
import { readConfig } from "../src/platform/config";
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

  it.each([
    ["an output declared 4 s longer than it is", { durationMs: "6000" }, undefined, "output:"],
    ["a readiness answered 404", {}, "wrong" as const, "healthz"],
    ["a reply that breaks the /normalize contract", { durationMs: null }, undefined, "normalize-contract"],
    ["a refused clip", { failure: { status: 422, code: "pixels" } }, undefined, "normalize:pixels"],
  ])("fails on %s, and health is degraded", async (_name, extra, ready, reason) => {
    const store = await freshStore();
    const { run } = await probeOnce(store, await genuine(extra), { ready });
    expect(run).toMatchObject({ status: "recorded", verdict: { outcome: "fail" } });
    expect(run.status === "recorded" && run.verdict.outcome === "fail" && run.verdict.reason).toContain(reason);
    expect(await health(store)).toMatchObject({ ok: false, state: "degraded" });
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
});
