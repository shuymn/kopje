import { NORMALIZE_PROFILE, probeImageTag } from "../domain/media-probes";
import { T_STILL } from "../domain/media-processing";
import { avVerifier, verifyStill } from "../platform/av-bytes";
import { within } from "../platform/deadline";
import { errorFields } from "../platform/error-message";
import { toHex } from "../platform/hex";
import { type ImageCodec, type Size, stillEncodes } from "../platform/images";
import { probeInputKey } from "../platform/media-files";
import {
  type NormalizeJob,
  type NormalizeResult,
  type ProbeVerdict,
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
export async function probeWork(
  deps: ContainerControl & { bucket: Pick<R2Bucket, "get">; images: ImageCodec; now: () => number },
  key: string,
  deadline: number,
  workMs: number,
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
    const result = await deps.normalize(port, {
      input: { body: object.body as ReadableStream<Uint8Array>, size: object.size },
      workMs: Math.min(workMs, deadline - deps.now()),
      stillMs: T_STILL,
    });
    if (!result.ok) {
      return result.outcome === "timeout"
        ? { outcome: "no-verdict", reason: "timeout" }
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
      return error.reason === "normalize-contract"
        ? { outcome: "fail", reason: error.reason }
        : { outcome: "no-verdict", reason: error.reason };
    }
    return { outcome: "no-verdict", reason: "operation" };
  }
}

type ProbeStore = Pick<StoreStub, "claimMediaProbe" | "recordMediaProbeResult">;

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
  deps: { build: string; store: ProbeStore; bucket: Pick<R2Bucket, "put" | "delete">; processor: UploadProcessor },
  due: boolean,
): Promise<ProbeRun> {
  const claim = await deps.store.claimMediaProbe(deps.build, { profile: NORMALIZE_PROFILE, build: deps.build, due });
  if (claim.status !== "claimed") {
    return claim;
  }
  const key = probeInputKey(toHex(crypto.getRandomValues(new Uint8Array(16))));
  let verdict: ProbeVerdict & { image?: string | null };
  try {
    await deps.bucket.put(key, deps.processor.probeInput);
    verdict = await deps.processor.probeNormalize(key);
  } catch (error) {
    console.warn({ event: "kopje.media.probe.failed", ...errorFields(error) });
    verdict = { outcome: "no-verdict", reason: "unavailable" };
  } finally {
    await deps.bucket.delete(key).catch(() => {});
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
