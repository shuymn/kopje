import { NORMALIZE_PROFILE, probeImageTag } from "../domain/media-probes";
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

// A probe answers `fail` only on positive evidence that the build is wrong, and `no-verdict` on anything else (an
// existing pass kept, health unchanged). The evidence, exhaustively: /healthz answered 404 (a build without the
// server); /normalize or /normalize/still answered 404 with /healthz healthy (TranscoderUnavailable `protocol`); a 200
// that breaks the reply's contract (its headers, kind or length); an output the verifier refuses, or whose declared
// duration disagrees with the file; a still verifyStill refuses; Images refusing that verified still as input
// (stillEncodes `failed`). Every other answer (any code the server answers, envelope, encode_failed, internal, truncated
// and no_output among them; a video answered without a still; busy, a timeout, a lost connection) says nothing of the
// build. An ordinary upload keeps A5: its input's failures are its outcome (jobs/media-jobs.ts).

// The packaged clip's envelope (container/probe.mp4: 192x144 H.264 at 15 fps for 2 s, with AAC): planVideo's estimate
// (container/server/plan.go) is 1500 + 192·144·30·1.0/1e6 + 192·144·30·21/1e6 + 2·40 = 1,598.25 ms, which fits
// estimateSafety (0.7) of an encode time of 2,284 ms and no less (plan_test.go TestProbeClipEnvelope holds the two
// equal).
export const PROBE_ENVELOPE_MS = 2_284;
// The clip's way in before the encode (its 0.2 MB body received, then ffprobe twice): not in plan.go's arithmetic, so a
// starting value that the den-test runs measure, as T_FINISH (Kopje-Input-Ms and Kopje-Probe-Ms).
const PROBE_STAGES_MS = 1_000;
// The probe's still reserve: room for contention, within G13's 5 s and server's still_ms < work_ms.
const PROBE_STILL_MS = 5_000;
// The least work deadline a probe is sent with: the still at most half of it leaves the stages and the envelope.
export const PROBE_FLOOR_MS = 2 * (PROBE_ENVELOPE_MS + PROBE_STAGES_MS);

// What the container work of a probe reaches: a verdict, or the verified still, which Images is asked about only once
// the container's owner has confirmed its stop (probeFinish).
export type ProbeStage = ProbeVerdict | { outcome: "still"; png: Uint8Array };

// The container work of one probe (on the profile's object, its single owner, media-processor.ts), on the probe's copy
// of the clip at `key`, read once: the container ready, normalize with the work deadline (sent only with
// PROBE_FLOOR_MS left), the output through the verifier held to the declared duration, and the still through
// verifyStill. It never stops the container: the owner does, outside this work, so a late answer here touches no later
// probe's container.
export async function probeWork(
  deps: Pick<ContainerControl, "ready" | "normalize"> & { bucket: Pick<R2Bucket, "get">; now: () => number },
  key: string,
  deadline: number,
  workMs: number,
  signal?: AbortSignal,
): Promise<ProbeStage> {
  const left = () => Math.min(workMs, deadline - deps.now());
  try {
    const port = await deps.ready(deadline);
    if (port === "wrong") {
      return { outcome: "fail", reason: "healthz" };
    }
    if (port === null) {
      return { outcome: "no-verdict", reason: "ready" };
    }
    if (left() < PROBE_FLOOR_MS) {
      return { outcome: "no-verdict", reason: "budget" };
    }
    const object = await deps.bucket.get(key);
    if (object === null) {
      return { outcome: "no-verdict", reason: "input-missing" };
    }
    // The time left once the copy is read: too little for the clip's envelope says nothing of the build.
    const workLeft = left();
    if (workLeft < PROBE_FLOOR_MS) {
      await object.body.cancel();
      return { outcome: "no-verdict", reason: "budget" };
    }
    const result = await deps.normalize(port, {
      input: { body: object.body as ReadableStream<Uint8Array>, size: object.size },
      workMs: workLeft,
      stillMs: Math.min(PROBE_STILL_MS, Math.floor(workLeft / 2)),
      ...(signal === undefined ? {} : { signal }),
    });
    if (!result.ok) {
      return { outcome: "no-verdict", reason: `normalize:${result.code}` };
    }
    const { stream, verdict, abort } = avVerifier(result.type, result.length, { expectedDuration: result.duration });
    await result.file.pipeThrough(stream).pipeTo(new WritableStream()).catch(abort);
    const verified = await verdict;
    if (!verified.ok || result.kind !== "video") {
      return { outcome: "fail", reason: verified.ok ? "kind" : `output:${verified.rule}` };
    }
    const png = await result.still();
    if (png === null) {
      return { outcome: "no-verdict", reason: "no-still" };
    }
    if (verifyStill(png) !== null) {
      return { outcome: "fail", reason: "still" };
    }
    return { outcome: "still", png };
  } catch (error) {
    if (error instanceof TranscoderUnavailable) {
      return error.protocol
        ? { outcome: "fail", reason: error.reason }
        : { outcome: "no-verdict", reason: error.reason };
    }
    return { outcome: "no-verdict", reason: error instanceof DeadlinePassed ? "timeout" : "operation" };
  }
}

// The probe's verdict once its container work settled and its owner tried the stop (`stopped`): the verified still
// through Images (stillEncodes) by `deadline`, only after a confirmed stop. `pass` with imagesVerified false when Images
// answered 9422.
export async function probeFinish(
  stage: ProbeStage,
  stopped: boolean,
  images: ImageCodec,
  deadline: number,
  now: () => number,
): Promise<ProbeVerdict> {
  if (stage.outcome !== "still") {
    return stage;
  }
  if (!stopped) {
    return { outcome: "no-verdict", reason: "destroy" };
  }
  try {
    const encoded = await stillEncodes(images, stage.png, pngSize(stage.png), (work) => within(work, deadline, now));
    if (encoded === "passed" || encoded === "quota") {
      return { outcome: "pass", imagesVerified: encoded === "passed" };
    }
    return { outcome: encoded === "failed" ? "fail" : "no-verdict", reason: "images" };
  } catch (error) {
    return { outcome: "no-verdict", reason: error instanceof DeadlinePassed ? "timeout" : "operation" };
  }
}

type ProbeStore = Pick<StoreStub, "claimMediaProbe" | "recordMediaProbeResult">;

// The probes run on an HTTP request (the CLI's) as well as in the cron, where no alarm or cron limit bounds them, so
// the request has one deadline, PROBE_ROUTE_MS from its start (app/admin.ts), and each of its steps ends at the
// earlier of that deadline and its own bound (probeSteps): reading the request body, a Store call (the still check's
// health, the claim, the record) at most PROBE_STORE_MS, the clip's copy put or delete in R2 at most PROBE_COPY_MS (a
// copy whose delete never answers is the orphan pass's; one whose put answers late is deleted then), and the call to
// the probe object at most its own deadline and destroy (media-processor.ts PROBE_MS, 210 s, and DESTROY_MS, 30 s) plus
// its way there and back, PROBE_CALL_MS. The bounds add up to the deadline.
export const PROBE_COPY_MS = 10_000;
export const PROBE_CALL_MS = 250_000;
export const PROBE_STORE_MS = 20_000;
export const PROBE_BODY_MS = 10_000;
export const PROBE_ROUTE_MS = PROBE_BODY_MS + 2 * PROBE_STORE_MS + 2 * PROBE_COPY_MS + PROBE_CALL_MS;
// The still check's call: STILL_CHECK_MS, which includes the object's destroy, plus its way there and back.
const STILL_CHECK_CALL_MS = 85_000;

type Wait = (ms: number) => Promise<void>;
const timerWait: Wait = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export const OVER: unique symbol = Symbol("over");

// The steps of one probe request, each ending at the earlier of `end` and its own bound `ms`: `work`'s value, or OVER
// when that passes first (a late answer is ignored; a rejection passes on).
export function probeSteps(end: number, now: () => number, wait: Wait = timerWait) {
  return async <P extends PromiseLike<unknown>>(work: P, ms: number): Promise<Awaited<P> | typeof OVER> => {
    const running = Promise.resolve<Awaited<P>>(work as PromiseLike<Awaited<P>>);
    running.catch(() => {});
    return Promise.race([running, wait(Math.max(0, Math.min(ms, end - now()))).then((): typeof OVER => OVER)]);
  };
}
type Step = ReturnType<typeof probeSteps>;

// The probe copy's put of `input` at `key`, bounded: false when it did not answer in time, and the copy it may still
// make is deleted once it does.
async function putCopy(step: Step, bucket: Pick<R2Bucket, "put" | "delete">, key: string, input: Uint8Array) {
  const put = bucket.put(key, input);
  if ((await step(put, PROBE_COPY_MS)) !== OVER) {
    return true;
  }
  put.then(
    () => bucket.delete(key).catch(() => {}),
    () => {},
  );
  return false;
}

// The probe copy's delete, bounded; one that fails or does not answer is left to the orphan pass.
async function dropCopy(step: Step, bucket: Pick<R2Bucket, "delete">, key: string): Promise<void> {
  try {
    if ((await step(bucket.delete(key), PROBE_COPY_MS)) === OVER) {
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
  | { status: "stale"; verdict: ProbeVerdict }
  // The claim or the record did not answer by its step's end: the verdict (null before the claim) is unrecorded as far
  // as this request knows, and a record that commits late still does so only under its claim's fence.
  | { status: "unconfirmed"; verdict: ProbeVerdict | null };

// One activation probe of normalize@standard-4 for `build`: one claim (shared by the CLI and the round; `due` for the
// round), the clip copied to incoming/probe-<nonce>, the probe on the profile's object, the copy deleted, and the
// verdict recorded under the claim, each step ending by `end` (probeSteps; PROBE_ROUTE_MS from now when not given). A
// probe that throws reaches no verdict; a copy a dead Worker left is the orphan pass's.
export async function activationProbe(
  deps: {
    build: string;
    store: ProbeStore;
    bucket: Pick<R2Bucket, "put" | "delete">;
    processor: UploadProcessor;
    wait?: Wait;
    now?: () => number;
    end?: number;
  },
  due: boolean,
): Promise<ProbeRun> {
  const now = deps.now ?? Date.now;
  const step = probeSteps(deps.end ?? now() + PROBE_ROUTE_MS, now, deps.wait);
  const claim = await step(
    deps.store.claimMediaProbe(deps.build, { profile: NORMALIZE_PROFILE, build: deps.build, due }),
    PROBE_STORE_MS,
  );
  if (claim === OVER) {
    console.warn({ event: "kopje.media.probe.unconfirmed", step: "claim" });
    return { status: "unconfirmed", verdict: null };
  }
  if (claim.status !== "claimed") {
    return claim;
  }
  const key = probeInputKey(toHex(crypto.getRandomValues(new Uint8Array(16))));
  let verdict: ProbeVerdict & { image?: string | null };
  try {
    if (!(await putCopy(step, deps.bucket, key, deps.processor.probeInput))) {
      verdict = { outcome: "no-verdict", reason: "copy" };
    } else {
      const answered = await step(deps.processor.probeNormalize(key), PROBE_CALL_MS);
      verdict = answered === OVER ? { outcome: "no-verdict", reason: "timeout" } : answered;
    }
  } catch (error) {
    console.warn({ event: "kopje.media.probe.failed", ...errorFields(error) });
    verdict = { outcome: "no-verdict", reason: "unavailable" };
  } finally {
    await dropCopy(step, deps.bucket, key);
  }
  const { image = null, ...result } = verdict;
  if (result.outcome !== "pass") {
    console.warn({ event: "kopje.media.probe.verdict", outcome: result.outcome, reason: result.reason });
  }
  const recorded = await step(
    deps.store.recordMediaProbeResult(deps.build, {
      profile: NORMALIZE_PROFILE,
      claim: claim.claim,
      outcome: result.outcome,
      imagesVerified: result.outcome === "pass" && result.imagesVerified,
      imageTag: probeImageTag(image),
    }),
    PROBE_STORE_MS,
  );
  if (recorded === OVER) {
    console.warn({ event: "kopje.media.probe.unconfirmed", step: "record" });
    return { status: "unconfirmed", verdict: result };
  }
  return recorded.status === "recorded"
    ? { status: "recorded", verdict: result }
    : { status: "stale", verdict: result };
}

// ---- The still check of still@standard-1 (kopje-admin media-processor probe)

// The most the check gives its still: the rebuild's still stage (STILL_CALL_MS in media-processor.ts).
const STILL_CHECK_MS = 75_000;

// The still profile's check on request: the packaged clip copied to incoming/probe-<nonce>, a still of it on the
// profile's object (stills.probe), verifyStill, and Images (stillEncodes); the copy deleted, each step ending by `end`
// (probeSteps). It records nothing: the profile's record is the media rebuild's, which probes it under its own lease
// (L4). As the activation probe, `fail` only on evidence of the build: the /still route answered 404, verifyStill
// refusing the PNG, or Images refusing it; `pass` with imagesVerified false when Images answered 9422; `no-verdict`
// for anything else (the container's refusal of the clip and every other code among them).
export async function stillCheck(deps: {
  bucket: Pick<R2Bucket, "put" | "delete">;
  stills: StillMaker;
  images: ImageCodec;
  now: () => number;
  wait?: Wait;
  end?: number;
}): Promise<ProbeVerdict & { image: string | null }> {
  const step = probeSteps(deps.end ?? deps.now() + PROBE_ROUTE_MS, deps.now, deps.wait);
  const key = probeInputKey(toHex(crypto.getRandomValues(new Uint8Array(16))));
  const deadline = deps.now() + STILL_CHECK_MS;
  try {
    if (!(await putCopy(step, deps.bucket, key, deps.stills.probeInput))) {
      return { outcome: "no-verdict", reason: "copy", image: null };
    }
    const out = await step(deps.stills.probe(key, STILL_CHECK_MS), STILL_CHECK_CALL_MS);
    if (out === OVER) {
      return { outcome: "no-verdict", reason: "timeout", image: null };
    }
    if (!out.ok) {
      return {
        outcome: out.failure === "still:not_found" ? "fail" : "no-verdict",
        reason: out.failure,
        image: out.image,
      };
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
    await dropCopy(step, deps.bucket, key);
  }
}
