import { NORMALIZE_PROFILE, probeImageTag } from "../domain/media-probes";
import { T_STILL } from "../domain/media-processing";
import { avVerifier, verifyStill } from "../platform/av-bytes";
import { DeadlinePassed, within } from "../platform/deadline";
import { errorFields } from "../platform/error-message";
import { toHex } from "../platform/hex";
import { type ImageCodec, type Size, stillEncodes } from "../platform/images";
import { probeInputKey } from "../platform/media-files";
import {
  type NormalizeJob,
  type NormalizeResult,
  type ProbeVerdict,
  type StillMaker,
  TranscoderUnavailable,
  type UploadProcessor,
} from "../platform/media-transcoder";
import type { StoreStub } from "../platform/store-client";

// The activation probe of the media processor's normalize@standard-4 profile (#1828 design 4.15; the PR4 plan's
// "Probe outcomes"), shared by the probe round (jobs/media-jobs.ts) and the probe command (app/admin.ts), and the
// container control both it and an upload's work drive (media-processor.ts).

// The container of one unit of work, as the Durable Object drives it: started and ready by `by` (null: not ready,
// `wrong` when it answered readiness with a status the server never gives, which a probe takes as the build's), the
// adapter (media-processor.ts normalize), and the stop, true once confirmed (destroy() answered and it no longer runs).
export type ContainerControl = {
  ready: (by: number) => Promise<Fetcher | "wrong" | null>;
  normalize: (port: Fetcher, job: NormalizeJob) => Promise<NormalizeResult>;
  stop: () => Promise<boolean>;
};

// The PNG's dimensions from its IHDR, which verifyStill has walked.
export function pngSize(png: Uint8Array): Size {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

// ---- The activation probe of normalize@standard-4 (design 4.15; the PR4 plan's "Probe outcomes")

// The work a probe object does for one probe (on the profile's object, its single owner, media-processor.ts), on the
// probe's copy of the clip at `key`, read once: the container ready (a readiness answered 404, a build that serves no
// /healthz, fails), normalize with the work deadline, the output through the verifier held to the declared duration,
// the still through verifyStill, the stop, and the still through Images (stillEncodes). `pass` with imagesVerified
// false when every earlier check passed and Images answered 9422; `fail` when the build answered deterministically
// wrong (readiness 404, a reply outside the /normalize contract), refused the clip, or its output or still was refused;
// `no-verdict` for a start never ready, a timeout, any other failure of the processor or of Images.
// The container's least work_ms (container/server/main.go minWorkMs).
const MIN_WORK_MS = 100;

export async function probeWork(
  deps: ContainerControl & { bucket: Pick<R2Bucket, "get">; images: ImageCodec; now: () => number },
  key: string,
  deadline: number,
  workMs: number,
  signal?: AbortSignal,
): Promise<ProbeVerdict> {
  try {
    const port = await deps.ready(deadline);
    if (port === "wrong") {
      return { outcome: "fail", reason: "healthz" };
    }
    if (port === null) {
      return { outcome: "no-verdict", reason: "ready" };
    }
    const object = await deps.bucket.get(key);
    if (object === null) {
      return { outcome: "no-verdict", reason: "input-missing" };
    }
    // The work deadline the container is given must exceed the still's reserve (and its 100 ms floor): with less
    // time left, nothing is sent, and the probe says nothing of the build.
    const left = Math.min(workMs, deadline - deps.now());
    if (left <= Math.max(T_STILL, MIN_WORK_MS)) {
      await object.body.cancel();
      return { outcome: "no-verdict", reason: "timeout" };
    }
    const result = await deps.normalize(port, {
      input: { body: object.body as ReadableStream<Uint8Array>, size: object.size },
      workMs: left,
      stillMs: T_STILL,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!result.ok) {
      // A timeout, and a 500 no_output (the server could not open its own file), say nothing of the build.
      if (result.outcome === "timeout") {
        return { outcome: "no-verdict", reason: "timeout" };
      }
      return result.code === "no_output"
        ? { outcome: "no-verdict", reason: "normalize:no_output" }
        : { outcome: "fail", reason: `normalize:${result.code}` };
    }
    const { stream, verdict, abort } = avVerifier(result.type, result.length, { expectedDuration: result.duration });
    await result.file.pipeThrough(stream).pipeTo(new WritableStream()).catch(abort);
    const verified = await verdict;
    if (!verified.ok || result.kind !== "video") {
      return { outcome: "fail", reason: verified.ok ? "kind" : `output:${verified.rule}` };
    }
    const png = await result.still();
    if (png === null || verifyStill(png) !== null) {
      return { outcome: "fail", reason: "still" };
    }
    if (!(await deps.stop())) {
      return { outcome: "no-verdict", reason: "destroy" };
    }
    const encoded = await stillEncodes(deps.images, png, pngSize(png), (work) => within(work, deadline, deps.now));
    if (encoded === "passed" || encoded === "quota") {
      return { outcome: "pass", imagesVerified: encoded === "passed" };
    }
    return encoded === "failed" ? { outcome: "fail", reason: "images" } : { outcome: "no-verdict", reason: "images" };
  } catch (error) {
    if (error instanceof TranscoderUnavailable) {
      return error.protocol
        ? { outcome: "fail", reason: error.reason }
        : { outcome: "no-verdict", reason: error.reason };
    }
    return { outcome: "no-verdict", reason: error instanceof DeadlinePassed ? "timeout" : "operation" };
  }
}

type ProbeStore = Pick<StoreStub, "claimMediaProbe" | "recordMediaProbeResult">;

// The probes run on an HTTP request (the CLI's) as well as in the cron, so each of their own calls is bounded here: the
// clip's copy put or delete in R2 at most PROBE_COPY_MS (a copy whose delete never answers is the orphan pass's), and
// the call to the probe object at most its own deadline and destroy (media-processor.ts PROBE_MS, 210 s, and
// DESTROY_MS, 30 s) plus its way there and back.
export const PROBE_COPY_MS = 10_000;
export const PROBE_CALL_MS = 250_000;
// The still check's call: STILL_CHECK_MS, which includes the object's destroy, plus its way there and back.
const STILL_CHECK_CALL_MS = 85_000;

type Wait = (ms: number) => Promise<void>;
const timerWait: Wait = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const OVER: unique symbol = Symbol("over");

// `work`'s value, or OVER when `ms` passes first (a late answer is ignored; a rejection passes on).
async function bounded<T>(work: Promise<T>, ms: number, wait: Wait): Promise<T | typeof OVER> {
  work.catch(() => {});
  return Promise.race([work, wait(ms).then((): typeof OVER => OVER)]);
}

// The probe copy's delete, bounded; one that fails or does not answer is left to the orphan pass.
async function dropCopy(bucket: Pick<R2Bucket, "delete">, key: string, wait: Wait): Promise<void> {
  try {
    if ((await bounded(bucket.delete(key), PROBE_COPY_MS, wait)) === OVER) {
      console.warn({ event: "kopje.media.probe.copy_failed", step: "delete", reason: "timeout" });
    }
  } catch (error) {
    console.warn({ event: "kopje.media.probe.copy_failed", step: "delete", ...errorFields(error) });
  }
}

export type ProbeRun =
  | { status: "recorded"; verdict: ProbeVerdict }
  | { status: "cooldown"; retryAt: number }
  | { status: "not_due" }
  | { status: "stale"; verdict: ProbeVerdict };

// One activation probe of normalize@standard-4 for `build`: one claim (shared by the CLI and the round; `due` for the
// round), the clip copied to incoming/probe-<nonce>, the probe on the profile's object, the copy deleted, and the
// verdict recorded under the claim. A probe that throws reaches no verdict; a copy a dead Worker left is the orphan
// pass's.
export async function activationProbe(
  deps: {
    build: string;
    store: ProbeStore;
    bucket: Pick<R2Bucket, "put" | "delete">;
    processor: UploadProcessor;
    wait?: Wait;
  },
  due: boolean,
): Promise<ProbeRun> {
  const wait = deps.wait ?? timerWait;
  const claim = await deps.store.claimMediaProbe(deps.build, { profile: NORMALIZE_PROFILE, build: deps.build, due });
  if (claim.status !== "claimed") {
    return claim;
  }
  const key = probeInputKey(toHex(crypto.getRandomValues(new Uint8Array(16))));
  let verdict: ProbeVerdict & { image?: string | null };
  try {
    if ((await bounded(deps.bucket.put(key, deps.processor.probeInput), PROBE_COPY_MS, wait)) === OVER) {
      verdict = { outcome: "no-verdict", reason: "copy" };
    } else {
      const answered = await bounded(deps.processor.probeNormalize(key), PROBE_CALL_MS, wait);
      verdict = answered === OVER ? { outcome: "no-verdict", reason: "timeout" } : answered;
    }
  } catch (error) {
    console.warn({ event: "kopje.media.probe.failed", ...errorFields(error) });
    verdict = { outcome: "no-verdict", reason: "unavailable" };
  } finally {
    await dropCopy(deps.bucket, key, wait);
  }
  const { image = null, ...result } = verdict;
  const recorded = await deps.store.recordMediaProbeResult(deps.build, {
    profile: NORMALIZE_PROFILE,
    claim: claim.claim,
    outcome: result.outcome,
    imagesVerified: result.outcome === "pass" && result.imagesVerified,
    imageTag: probeImageTag(image),
  });
  if (result.outcome !== "pass") {
    console.warn({ event: "kopje.media.probe.verdict", outcome: result.outcome, reason: result.reason });
  }
  return recorded.status === "recorded"
    ? { status: "recorded", verdict: result }
    : { status: "stale", verdict: result };
}

// ---- The still check of still@standard-1 (kopje-admin media-processor probe)

// The most the check gives its still: the rebuild's still stage (STILL_CALL_MS in media-processor.ts).
const STILL_CHECK_MS = 75_000;

// The still profile's check on request: the packaged clip copied to incoming/probe-<nonce>, a still of it on the
// profile's object (stills.probe), verifyStill, and Images (stillEncodes); the copy deleted. It records nothing: the
// profile's record is the media rebuild's, which probes it under its own lease (L4). `fail` when the container refuses
// the clip as input, verifyStill refuses the PNG, or Images refuses it; `pass` with imagesVerified false when Images
// answered 9422; `no-verdict` for any other failure of the processor or of Images.
export async function stillCheck(deps: {
  bucket: Pick<R2Bucket, "put" | "delete">;
  stills: StillMaker;
  images: ImageCodec;
  now: () => number;
  wait?: Wait;
}): Promise<ProbeVerdict & { image: string | null }> {
  const wait = deps.wait ?? timerWait;
  const key = probeInputKey(toHex(crypto.getRandomValues(new Uint8Array(16))));
  const deadline = deps.now() + STILL_CHECK_MS;
  try {
    if ((await bounded(deps.bucket.put(key, deps.stills.probeInput), PROBE_COPY_MS, wait)) === OVER) {
      return { outcome: "no-verdict", reason: "copy", image: null };
    }
    const out = await bounded(deps.stills.probe(key, STILL_CHECK_MS), STILL_CHECK_CALL_MS, wait);
    if (out === OVER) {
      return { outcome: "no-verdict", reason: "timeout", image: null };
    }
    if (!out.ok) {
      return out.input === undefined
        ? { outcome: "no-verdict", reason: out.failure, image: out.image }
        : { outcome: "fail", reason: `input:${out.input}`, image: out.image };
    }
    if (verifyStill(out.png) !== null) {
      return { outcome: "fail", reason: "still", image: out.image };
    }
    const png = out.png;
    const encoded = await stillEncodes(deps.images, png, pngSize(png), (work) => within(work, deadline, deps.now));
    if (encoded === "passed" || encoded === "quota") {
      return { outcome: "pass", imagesVerified: encoded === "passed", image: out.image };
    }
    return { outcome: encoded === "failed" ? "fail" : "no-verdict", reason: "images", image: out.image };
  } catch (error) {
    if (error instanceof DeadlinePassed) {
      return { outcome: "no-verdict", reason: "timeout", image: null };
    }
    console.warn({ event: "kopje.media.probe.failed", ...errorFields(error) });
    return { outcome: "no-verdict", reason: "unavailable", image: null };
  } finally {
    await dropCopy(deps.bucket, key, wait);
  }
}
