import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProbeOutcome, ProbeProfile } from "../src/domain/media-probes";
import { probeName } from "../src/domain/media-probes";
import type { StoreStub } from "../src/platform/store-client";
import { sql } from "./api-helpers";
import { avFixture } from "./av-helpers";
import { BUILD, rejectionOf } from "./helpers";
import { mediaForm } from "./media-helpers";
import { ACTIVE, avWorld, clock, gate, HOUR, passProbe, SECOND, staged, T0, TEXT } from "./media-processing-helpers";
import { community } from "./status-helpers";

// The probe records and activation, the Store's side (#1828 design 4.15, plan P4): one record per profile and build,
// one claim shared by the CLI and the probe round, its result recorded only under it, a pass kept over a probe that
// reached no verdict, a pass Images did not verify claimable again after PROBE_RETRY_MS, and an infrastructure failure
// that makes the profile due without revoking admission. The rebuild's own still probe keeps its cases in
// test/media-rebuild-av.test.ts.

afterEach(() => {
  vi.useRealTimers();
});

const NORMALIZE: ProbeProfile = "normalize@standard-4";
const STILL: ProbeProfile = "still@standard-1";

async function claim(store: StoreStub, profile: ProbeProfile, build: string, due: boolean) {
  return store.claimMediaProbe(BUILD, { profile, build, due });
}

async function probe(
  store: StoreStub,
  profile: ProbeProfile,
  build: string,
  outcome: ProbeOutcome,
  imagesVerified = true,
): Promise<void> {
  const claimed = await claim(store, profile, build, false);
  if (claimed.status !== "claimed") {
    throw new Error(claimed.status);
  }
  expect(
    await store.recordMediaProbeResult(BUILD, {
      profile,
      claim: claimed.claim,
      outcome,
      imagesVerified,
      imageTag: "img:1",
    }),
  ).toEqual({ status: "recorded" });
}

const activation = (store: StoreStub, build = BUILD) => store.avActivation(BUILD, { binding: true, budget: 5, build });

describe("admission per profile and build", () => {
  it("is active only with a passed normalize probe for the running build", async () => {
    const w = await avWorld();
    expect(await activation(w.store)).toMatchObject({ active: true });
    // Another build has no verdict: inactive until it is probed.
    expect(await activation(w.store, "build-2")).toMatchObject({ active: false });
    clock(T0 + SECOND);
    await probe(w.store, NORMALIZE, "build-2", "pass");
    expect(await activation(w.store, "build-2")).toMatchObject({ active: true });
    // The record is now build-2's: the old build is no longer admitted.
    expect(await activation(w.store)).toMatchObject({ active: false });
  });

  it("the still profile's record admits no upload", async () => {
    const w = await avWorld();
    clock(T0 + SECOND);
    // The normalize record moves to another build; the still profile passes for this one (as the rebuild records it).
    await probe(w.store, NORMALIZE, "build-2", "fail");
    await sql(
      w.store,
      "INSERT OR REPLACE INTO kopje_state (name, value) VALUES (?, ?)",
      probeName("record", STILL),
      JSON.stringify({ version: BUILD, imageTag: null, at: T0 + SECOND, ok: true, imagesVerified: true }),
    );
    expect(await activation(w.store)).toMatchObject({ active: false });
  });

  it("the generic probe RPCs write the normalize profile only; the still profile stays on the rebuild's lease (L4)", async () => {
    const w = await avWorld();
    clock(T0 + HOUR);
    const before = await w.store.mediaProbeRecords(BUILD, { profile: STILL });
    for (const call of [
      () => claim(w.store, STILL, BUILD, false),
      () =>
        w.store.recordMediaProbeResult(BUILD, {
          profile: STILL,
          claim: "c",
          outcome: "pass",
          imagesVerified: true,
          imageTag: null,
        }),
      () => w.store.recordMediaInfrastructureFailure(BUILD, { profile: STILL, build: BUILD }),
    ]) {
      expect(await rejectionOf(call())).toBeInstanceOf(Error);
    }
    expect(await w.store.mediaProbeRecords(BUILD, { profile: STILL })).toEqual(before);
  });

  it("a failed probe revokes admission: S3 refuses a staged upload inactive, with its input (M5)", async () => {
    const w = await avWorld();
    const c = await staged(w);
    // A probe of the next build (claimable at once, the build changed) fails: the verdict no longer passes this one.
    clock(T0 + 2 * SECOND);
    await probe(w.store, NORMALIZE, "build-2", "fail");
    expect(await w.store.queueNormalize(BUILD, { ...c, bytes: 1000, text: TEXT, activation: ACTIVE })).toEqual({
      status: "refused_cleanup_yours",
      reason: "inactive",
    });
  });

  it("is inactive without the binding or a positive budget, and reports a spent budget as active", async () => {
    const w = await avWorld();
    expect(await w.store.avActivation(BUILD, { binding: false, budget: 5, build: BUILD })).toMatchObject({
      active: false,
    });
    expect(await w.store.avActivation(BUILD, { binding: true, budget: 0, build: BUILD })).toMatchObject({
      active: false,
    });
    expect(await w.store.avActivation(BUILD, { binding: true, budget: 1, build: BUILD })).toMatchObject({
      active: true,
      spent: 0,
      slots: 0,
    });
  });
});

describe("one claim", () => {
  it("is shared by the CLI and the round: the second within PROBE_RETRY_MS is refused, unless the build changed", async () => {
    const w = await avWorld();
    clock(T0 + HOUR);
    const cli = await claim(w.store, NORMALIZE, BUILD, false);
    expect(cli).toMatchObject({ status: "claimed" });
    expect(await claim(w.store, NORMALIZE, BUILD, false)).toEqual({ status: "cooldown", retryAt: T0 + 2 * HOUR });
    expect(await claim(w.store, NORMALIZE, "build-2", false)).toMatchObject({ status: "claimed" });
    clock(T0 + 2 * HOUR - 1);
    expect(await claim(w.store, NORMALIZE, "build-2", false)).toMatchObject({ status: "cooldown" });
    expect(await claim(w.store, NORMALIZE, BUILD, false)).toMatchObject({ status: "claimed" });
  });

  it("records only under the last claim: an earlier one is stale", async () => {
    const w = await avWorld();
    clock(T0 + HOUR);
    const first = await claim(w.store, NORMALIZE, BUILD, false);
    clock(T0 + 2 * HOUR);
    const second = await claim(w.store, NORMALIZE, BUILD, false);
    if (first.status !== "claimed" || second.status !== "claimed") {
      throw new Error("not claimed");
    }
    const record = (c: string, outcome: ProbeOutcome) =>
      w.store.recordMediaProbeResult(BUILD, {
        profile: NORMALIZE,
        claim: c,
        outcome,
        imagesVerified: true,
        imageTag: null,
      });
    expect(await record(first.claim, "fail")).toEqual({ status: "stale" });
    expect(await activation(w.store)).toMatchObject({ active: true });
    expect(await record(second.claim, "fail")).toEqual({ status: "recorded" });
    expect(await activation(w.store)).toMatchObject({ active: false });
  });

  it("records once: a repeat of the claim's result answers recorded and changes nothing", async () => {
    const w = await avWorld();
    clock(T0 + HOUR);
    const claimed = await claim(w.store, NORMALIZE, BUILD, false);
    if (claimed.status !== "claimed") {
      throw new Error(claimed.status);
    }
    const record = (outcome: ProbeOutcome) =>
      w.store.recordMediaProbeResult(BUILD, {
        profile: NORMALIZE,
        claim: claimed.claim,
        outcome,
        imagesVerified: true,
        imageTag: null,
      });
    expect(await record("pass")).toEqual({ status: "recorded" });
    const before = await w.store.mediaProbeRecords(BUILD, { profile: NORMALIZE });
    clock(T0 + HOUR + SECOND);
    expect(await record("fail")).toEqual({ status: "recorded" });
    expect(await w.store.mediaProbeRecords(BUILD, { profile: NORMALIZE })).toEqual({
      ...before,
      now: T0 + HOUR + SECOND,
    });
    expect(await activation(w.store)).toMatchObject({ active: true });
  });

  it("is refused in maintenance", async () => {
    const w = await avWorld();
    clock(T0 + 2 * HOUR);
    await gate(w.store, "maintenance", true);
    const refused = await claim(w.store, NORMALIZE, BUILD, false).then(
      () => null,
      (error: unknown) => error,
    );
    expect(String(refused)).toMatch(/maintenance/);
  });
});

describe("the verdict", () => {
  it("a pass is kept over a probe that reached no verdict", async () => {
    const w = await avWorld();
    clock(T0 + HOUR);
    await probe(w.store, NORMALIZE, BUILD, "no-verdict");
    expect(await activation(w.store)).toMatchObject({ active: true });
    const records = await w.store.mediaProbeRecords(BUILD, { profile: NORMALIZE });
    expect(records).toMatchObject({
      record: { ok: true, version: BUILD },
      attempt: { version: BUILD, result: "no-verdict" },
    });
  });

  it("a pass Images did not verify admits, and is claimable again by the round after PROBE_RETRY_MS", async () => {
    const w = await avWorld();
    clock(T0 + HOUR);
    await probe(w.store, NORMALIZE, BUILD, "pass", false);
    expect(await activation(w.store)).toMatchObject({ active: true });
    clock(T0 + 2 * HOUR - 1);
    expect(await claim(w.store, NORMALIZE, BUILD, true)).toMatchObject({ status: "cooldown" });
    clock(T0 + 2 * HOUR);
    expect(await claim(w.store, NORMALIZE, BUILD, true)).toMatchObject({ status: "claimed" });
  });

  it("a verified pass is not due for the round, whatever the cooldown", async () => {
    const w = await avWorld();
    clock(T0 + 5 * HOUR);
    expect(await claim(w.store, NORMALIZE, BUILD, true)).toEqual({ status: "not_due" });
    // The CLI probes on request.
    expect(await claim(w.store, NORMALIZE, BUILD, false)).toMatchObject({ status: "claimed" });
  });

  it("an infrastructure failure makes the profile due and revokes nothing", async () => {
    const w = await avWorld();
    clock(T0 + 5 * HOUR);
    expect(await w.store.recordMediaInfrastructureFailure(BUILD, { profile: NORMALIZE, build: BUILD })).toEqual({
      status: "recorded",
    });
    expect(await activation(w.store)).toMatchObject({ active: true });
    const due = await claim(w.store, NORMALIZE, BUILD, true);
    expect(due).toMatchObject({ status: "claimed" });
    if (due.status !== "claimed") {
      throw new Error(due.status);
    }
    // A pass answers the failure: the profile is no longer due.
    await w.store.recordMediaProbeResult(BUILD, {
      profile: NORMALIZE,
      claim: due.claim,
      outcome: "pass",
      imagesVerified: true,
      imageTag: null,
    });
    clock(T0 + 7 * HOUR);
    expect(await claim(w.store, NORMALIZE, BUILD, true)).toEqual({ status: "not_due" });
  });
});

// G1: in this release a passed activation probe enables nothing; video and audio still take the image path's answer on
// both upload routes, and no upload reaches the processor.
describe("uploads after a passing activation probe (G1)", () => {
  it("answers an MP4 and an MP3 on /api/v1/media and /api/v2/media as the image path does, with no media_processing row", async () => {
    const h = await community(["alice"], "read write", {}, { MEDIA_UPLOAD_MONTHLY_JOBS: "10", MEDIA_PROCESSOR: {} });
    await passProbe(h.store);
    expect((await h.store.mediaProbeRecords(BUILD, { profile: NORMALIZE })).record).toMatchObject({
      ok: true,
      version: BUILD,
    });
    const files = [
      [await avFixture("r1-silent.mp4"), "v.mp4", "video/mp4"],
      [await avFixture("mp3.mp3"), "a.mp3", "audio/mpeg"],
    ] as const;
    for (const route of ["/api/v1/media", "/api/v2/media"]) {
      for (const [bytes, name, type] of files) {
        const response = await h.request(route, {
          method: "POST",
          headers: { authorization: `Bearer ${h.users.alice.token}` },
          body: mediaForm(bytes, {}, name, type),
        });
        expect(response.status, `${route} ${name}`).toBe(422);
        expect(await response.json()).toEqual({ error: "Validation failed: File content type is invalid" });
      }
    }
    expect(await sql(h.store, "SELECT count(*) AS n FROM media_processing")).toEqual([{ n: 0 }]);
  });
});
