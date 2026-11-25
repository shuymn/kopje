import type { MonthlyTransforms } from "../domain/media";
import { NORMALIZE_PROFILE } from "../domain/media-probes";
import {
  allocate,
  type AvFacts,
  type AvWrite,
  encodeLeft,
  type Endpoint,
  outputCuts,
  type ProcessorFailure,
  remainingOf,
  T_MIN_ENCODE,
  T_REPLY,
  T_STILL,
} from "../domain/media-processing";
import { activationProbe, type ContainerControl, pngSize } from "../mastodon/media-activation";
import { avVerifier, STILL_OUTPUT_LIMIT, verifyStill } from "../platform/av-bytes";
import { within } from "../platform/deadline";
import { errorFields } from "../platform/error-message";
import { type ImageCodec, type Size, stillPreview } from "../platform/images";
import { fileKey, incomingKey, originalKey } from "../platform/media-files";
import { type NormalizeResult, TranscoderUnavailable, type UploadProcessor } from "../platform/media-transcoder";
import type { StoreStub } from "../platform/store-client";

// The media processor's upload work and rounds (#1828; the PR4 plan's section 1.3 and section 3 "PR4-2").
//
// runUpload is an upload's D3-D7, run by the processor's Durable Object (src/media-processor.ts, UploadUnit) in the
// alarm that started the job (S4), on the Durable Object's clock: the container started on the normalize profile and
// ready, the input read once from incoming/<id> and streamed into /normalize with the work deadline the allocation
// leaves (the still's cut, T_STILL of it held for a video's still), the output streamed through the verifier
// (avVerifier, held to the declared duration) into two multipart uploads, originals/<id> and files/<token>/full, parts
// written and not completed; for a video the container's still through verifyStill, the poster's Images charge
// (TRANSFORMS_PER_POSTER, chargeAvPoster) and stillPreview (its blurhash given up at the preview stage's cut); then the
// confirmed stop (D4); then each final write after its own grant (S5, D6), and completion (S6) or failure (S7, D7).
// A failure before the writes stops the container first and records its cause: `refused` (the container refused the
// input, or failed it as A5 states), `envelope`, `verifier` (the output refused: no upload is completed), `timeout` (a
// stage cut passed before the job's deadline), `unavailable` (any other failure: the processor, R2, or an unconfirmed
// stop). Nothing is retried. Every wait on the container ends at a cut on the processor's clock, whatever the
// container does (R9 chooses its timing): its reply by the work deadline (the still's cut), the output's body by
// T_TRANSFER after it, and the still and its preview by the cut that leaves the rest of T_COMMIT for the stop and the
// writes (outputCuts). Past a cut the container's
// requests are aborted and the job ends as `timeout` (the Store records `deadline` instead once deadline_at has passed,
// K4).
//
// The rounds, each its own error boundary (jobs/scheduled.ts): the dispatch round (S12, S13), the probe round
// (normalize@standard-4's activation probe when it is due), and the incoming/ orphan pass. Logs carry codes and stage
// times, never a body (DATA-5).

const MIB = 1024 * 1024;
// The multipart part size of the two output uploads (R2 parts but the last are of one size).
const PART_BYTES = 8 * MIB;

// The Store calls an upload makes, as the processor reaches the Store.
type UploadStore = Pick<
  StoreStub,
  "chargeAvPoster" | "completeAvUpload" | "confirmAvWrite" | "failNormalize" | "recordMediaInfrastructureFailure"
>;

export type UploadDeps = ContainerControl & {
  build: string;
  store: UploadStore;
  bucket: R2Bucket;
  images: ImageCodec;
  monthlyTransforms: MonthlyTransforms;
  now: () => number;
  // Resolves `ms` later on the processor's clock (scheduler.wait), for the cuts on the container's waits.
  wait: (ms: number) => Promise<void>;
};

// A wait on the container that reached its cut.
class StageCut extends Error {}

const CUT: unique symbol = Symbol("cut");

// `work` until `end` on the processor's clock: past it (or when it settles at or after `end`), `cut` is aborted, which
// ends the container's requests and the bodies they stream, and StageCut is thrown.
async function bounded<T>(
  deps: Pick<UploadDeps, "now" | "wait">,
  work: Promise<T>,
  end: number,
  cut: AbortController,
): Promise<T> {
  work.catch(() => {});
  const left = end - deps.now();
  const settled = left <= 0 ? CUT : await Promise.race([work, deps.wait(left).then((): typeof CUT => CUT)]);
  if (settled === CUT || deps.now() >= end) {
    cut.abort();
    throw new StageCut();
  }
  return settled;
}

// A job S4 started: its start_id, and its deadline on the processor's clock (the reading taken before S4 plus the time
// left S4 answered).
export type UploadJob = {
  id: string;
  token: string;
  startId: string;
  endpoint: Endpoint;
  inputBytes: number;
  deadline: number;
};

// Whether the container's stop was confirmed: the processor then deletes the input and confirms it (D8, D9).
export type UploadEnd = { stopped: boolean };

type Verified = { facts: AvFacts; parts: [R2UploadedPart[], R2UploadedPart[]] };
type Preview = Size & { bytes: Uint8Array; blurhash: string | null };

// D3-D7 of one started job (above). It never throws.
export async function runUpload(deps: UploadDeps, job: UploadJob): Promise<UploadEnd> {
  const allocation = allocate(
    job.endpoint,
    deps.now(),
    job.deadline + (job.endpoint === "v1" ? T_REPLY : 0),
    job.inputBytes,
  );
  const output = outputCuts(allocation);
  const uploads: R2MultipartUpload[] = [];
  const stage = { name: "start", at: deps.now() };
  // Where the job is, for its log events: the stage and the time since it began.
  const at = () => ({ id: job.id, stage: stage.name, ms: deps.now() - stage.at });
  const fail = async (cause: ProcessorFailure) => {
    try {
      await deps.store.failNormalize(deps.build, { id: job.id, startId: job.startId, cause });
    } catch (error) {
      console.warn({ event: "kopje.media.job.fail_failed", ...at(), ...errorFields(error) });
    }
  };
  const abortUploads = async () => {
    for (const upload of uploads.splice(0)) {
      await upload.abort().catch(() => {});
    }
  };
  // D4, then the cause: an unconfirmed stop records `unavailable` whatever the cause was, and ends the invocation.
  const stopThen = async (cause: ProcessorFailure | null): Promise<UploadEnd> => {
    await abortUploads();
    if (!(await deps.stop())) {
      console.warn({ event: "kopje.media.job.stop_failed", ...at() });
      await fail("unavailable");
      return { stopped: false };
    }
    if (cause !== null) {
      console.warn({ event: "kopje.media.job.failed", ...at(), cause });
      await fail(cause);
    }
    return { stopped: true };
  };
  try {
    // The container starts only before the job's deadline, and must be ready while T_MIN_ENCODE is left.
    const readyBy = encodeLeft(allocation, 0, "input") - T_MIN_ENCODE;
    if (deps.now() >= Math.min(job.deadline, readyBy)) {
      return await stopThen("timeout");
    }
    const port = await deps.ready(readyBy);
    if (port === null || port === "wrong") {
      return await stopThen(deps.now() >= readyBy ? "timeout" : "unavailable");
    }
    stage.name = "input";
    stage.at = deps.now();
    const object = await deps.bucket.get(incomingKey(job.id));
    if (object === null) {
      console.warn({ event: "kopje.media.job.input_missing", ...at() });
      return await stopThen("unavailable");
    }
    const workMs = allocation.cuts.still - deps.now();
    if (workMs <= T_STILL) {
      await object.body.cancel();
      return await stopThen("timeout");
    }
    const cut = new AbortController();
    const result = await bounded(
      deps,
      deps.normalize(port, {
        input: { body: object.body as ReadableStream<Uint8Array>, size: object.size },
        workMs,
        stillMs: T_STILL,
        signal: cut.signal,
      }),
      allocation.cuts.still,
      cut,
    );
    if (!result.ok) {
      console.warn({ event: "kopje.media.job.output_refused", ...at(), code: result.code, stages: result.stages });
      return await stopThen(result.outcome);
    }
    stage.name = "output";
    stage.at = deps.now();
    const type = { httpMetadata: { contentType: result.type } };
    uploads.push(await deps.bucket.createMultipartUpload(originalKey(job.id), type));
    uploads.push(await deps.bucket.createMultipartUpload(fileKey(job.token, "full"), type));
    const verified = await bounded(
      deps,
      verifyInto(result, uploads as [R2MultipartUpload, R2MultipartUpload]),
      output.transfer,
      cut,
    );
    if ("rule" in verified) {
      console.warn({ event: "kopje.media.job.output_refused", ...at(), rule: verified.rule, stages: result.stages });
      return await stopThen("verifier");
    }
    // A video's still; the adapter answers null for audio, which has none (Kopje-Still is a video's header).
    stage.name = "still";
    stage.at = deps.now();
    const png = await bounded(deps, result.still(), output.preview, cut);
    const preview = png !== null && verifyStill(png) === null ? await poster(deps, job, output.preview, png) : null;
    // D4: the container stops before any final write.
    stage.name = "commit";
    stage.at = deps.now();
    if (!(await deps.stop())) {
      await abortUploads();
      console.warn({ event: "kopje.media.job.stop_failed", ...at() });
      await fail("unavailable");
      return { stopped: false };
    }
    const [original, full] = uploads as [R2MultipartUpload, R2MultipartUpload];
    const writes: [AvWrite, () => Promise<unknown>][] = [
      ["original", () => original.complete(verified.parts[0])],
      ["full", () => full.complete(verified.parts[1])],
    ];
    if (preview !== null) {
      const { bytes, width, height, blurhash } = preview;
      writes.push([
        "small",
        () =>
          deps.bucket.put(fileKey(job.token, "small"), bytes, {
            httpMetadata: { contentType: "image/webp" },
            customMetadata: { width: String(width), height: String(height), blurhash: blurhash ?? "" },
          }),
      ]);
    }
    for (const [write, start] of writes) {
      if (!(await granted(deps, job, write))) {
        // The job is not ours to write any more (deleted, past its deadline, restored, maintenance): what is left is
        // aborted, and what landed is the sweep's.
        await abortUploads();
        console.warn({ event: "kopje.media.job.write_refused", ...at(), write });
        return { stopped: true };
      }
      await start();
      if (write !== "small") {
        uploads.shift();
      }
    }
    const facts: AvFacts = { ...verified.facts, preview: preview === null ? null : previewFacts(preview) };
    const done = await deps.store.completeAvUpload(deps.build, {
      id: job.id,
      token: job.token,
      startId: job.startId,
      facts,
    });
    if (done.status !== "done") {
      console.warn({ event: "kopje.media.job.complete_refused", ...at(), status: done.status });
    }
    return { stopped: true };
  } catch (error) {
    if (error instanceof StageCut) {
      console.warn({ event: "kopje.media.job.cut", ...at() });
      return stopThen("timeout");
    }
    console.warn({
      event: "kopje.media.job.unavailable",
      ...at(),
      ...(error instanceof TranscoderUnavailable ? { reason: error.reason } : errorFields(error)),
    });
    return stopThen("unavailable");
  }
}

function previewFacts({ width, height, blurhash }: Preview): NonNullable<AvFacts["preview"]> {
  return { width, height, blurhash };
}

// S5 before one write: a grant counted on the processor's clock from the reading taken before the call, asked again
// when it ran out before the write could start. False when refused (or the Store refuses writes).
async function granted(deps: UploadDeps, job: UploadJob, write: AvWrite): Promise<boolean> {
  // Ends when S5 refuses, as it does from the job's deadline_at on the Store's clock (one media clock).
  for (;;) {
    const asked = deps.now();
    const grant = await deps.store.confirmAvWrite(deps.build, { id: job.id, startId: job.startId, write });
    if (grant.status !== "grant") {
      return false;
    }
    if (remainingOf(asked, grant.ms, deps.now()) > 0) {
      return true;
    }
  }
}

// The output through the verifier into both uploads, PART_BYTES a part, parts uploaded and not completed: the facts,
// or the verifier's refusal (a refused stream, an early end or a length that differs from the declared one).
async function verifyInto(
  result: Extract<NormalizeResult, { ok: true }>,
  [original, full]: [R2MultipartUpload, R2MultipartUpload],
): Promise<Verified | { rule: string }> {
  const { stream, verdict, abort } = avVerifier(result.type, result.length, { expectedDuration: result.duration });
  const parts: [R2UploadedPart[], R2UploadedPart[]] = [[], []];
  let buffer = new Uint8Array(PART_BYTES);
  let filled = 0;
  const flush = async () => {
    const part = buffer.subarray(0, filled);
    const number = parts[0].length + 1;
    const [a, b] = await Promise.all([original.uploadPart(number, part), full.uploadPart(number, part)]);
    parts[0].push(a);
    parts[1].push(b);
    buffer = new Uint8Array(PART_BYTES);
    filled = 0;
  };
  const reader = result.file.pipeThrough(stream).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      let offset = 0;
      while (offset < value.byteLength) {
        const take = Math.min(PART_BYTES - filled, value.byteLength - offset);
        buffer.set(value.subarray(offset, offset + take), filled);
        filled += take;
        offset += take;
        if (filled === PART_BYTES) {
          await flush();
        }
      }
    }
  } catch {
    abort();
  }
  const settled = await verdict;
  if (!settled.ok) {
    return { rule: settled.rule };
  }
  if (filled > 0) {
    await flush();
  }
  const { facts } = settled;
  if (facts.kind === "video" && result.type === "video/mp4") {
    const { kind, width, height, frameRate, duration, bitrate, bytes } = facts;
    return {
      facts: { contentType: "video/mp4", kind, width, height, frameRate, duration, bitrate, bytes, preview: null },
      parts,
    };
  }
  if (facts.kind === "audio" && result.type === "audio/mpeg") {
    const { kind, duration, bitrate, bytes } = facts;
    return { facts: { contentType: "audio/mpeg", kind, duration, bitrate, bytes, preview: null }, parts };
  }
  return { rule: "kind" };
}

// A video's preview from its still: charged right before stillPreview, or none (the poster) when the budgets have no
// room or Images does not make it. Images refusing a PNG verifyStill passed (9412, 9413, 9520) says the profile's
// stills are not usable: recorded as an infrastructure failure, which has the probe round probe again; 9422 is not.
async function poster(deps: UploadDeps, job: UploadJob, end: number, png: Uint8Array): Promise<Preview | null> {
  const charged = await deps.store.chargeAvPoster(deps.build, {
    id: job.id,
    startId: job.startId,
    monthlyTransforms: deps.monthlyTransforms,
  });
  if (charged.status !== "charged") {
    return null;
  }
  try {
    const made = await stillPreview(
      deps.images,
      png,
      pngSize(png),
      { end, now: deps.now },
      STILL_OUTPUT_LIMIT,
      (work) => within(work, end, deps.now),
    );
    if (made.ok) {
      return { bytes: made.small.bytes, width: made.small.width, height: made.small.height, blurhash: made.blurhash };
    }
    if (made.reason === "unsupported") {
      console.warn({ event: "kopje.media.job.still_refused", id: job.id });
      await deps.store.recordMediaInfrastructureFailure(deps.build, { profile: NORMALIZE_PROFILE, build: deps.build });
    }
  } catch (error) {
    console.warn({ event: "kopje.media.job.preview_failed", id: job.id, ...errorFields(error) });
  }
  return null;
}

// ---- The rounds

export type MediaRoundDeps = {
  build: string;
  store: StoreStub;
  bucket: R2Bucket;
  // null without the processor's binding.
  processor: UploadProcessor | null;
  // MEDIA_UPLOAD_MONTHLY_JOBS.
  budget: number;
};

// The dispatch round (S12 with S13): the Store's transitions, then a `run` for each pending upload it hands back
// (under the same object name, with its teardown_id). Without the binding the Store's transitions still run.
export async function mediaDispatchRound(deps: MediaRoundDeps): Promise<void> {
  const round = await deps.store.mediaDispatchRound(deps.build);
  if ("status" in round) {
    return;
  }
  for (const { id, token, teardownId } of round.runs) {
    try {
      await deps.processor?.run(id, token, teardownId);
    } catch (error) {
      console.warn({ event: "kopje.media.dispatch.run_failed", id, ...errorFields(error) });
    }
  }
}

// The probe round: the activation probe when the profile needs one for this build (the claim decides: no pass for
// it, an infrastructure failure since, or an unverified pass past PROBE_RETRY_MS), only with the binding and a
// positive budget, so an instance that has not turned uploads on starts no container.
export async function mediaProbeRound(deps: MediaRoundDeps): Promise<void> {
  if (deps.processor === null || deps.budget <= 0) {
    return;
  }
  await activationProbe({ ...deps, processor: deps.processor }, true);
}

// One R2 list page of incoming/.
const INCOMING_PAGE = 1000;

// The incoming/ orphan pass (hourly): the claim and its cursor, one list page of at most INCOMING_PAGE keys, the
// Store's classification under the claim, the delete of the orphans, then the checkpoint, which wraps to the start
// after the last page. A failed delete throws before the checkpoint, so the cursor stays; a round that dies between
// its delete and its checkpoint is repeated harmlessly (the delete is idempotent).
export async function incomingOrphans(deps: Pick<MediaRoundDeps, "build" | "store" | "bucket">): Promise<void> {
  const claimed = await deps.store.incomingSweepClaim(deps.build);
  if (claimed.status !== "claimed") {
    return;
  }
  const listed = await deps.bucket.list({
    prefix: "incoming/",
    limit: INCOMING_PAGE,
    ...(claimed.cursor === "" ? {} : { cursor: claimed.cursor }),
  });
  const keys = listed.objects.map((object) => ({ key: object.key, uploaded: object.uploaded.getTime() }));
  const classified = await deps.store.incomingClassify(deps.build, { claim: claimed.claim, keys });
  if (classified.status !== "ok") {
    return;
  }
  if (classified.orphans.length > 0) {
    await deps.bucket.delete(classified.orphans);
  }
  await deps.store.incomingSwept(deps.build, {
    claim: claimed.claim,
    cursor: listed.truncated ? listed.cursor : "",
  });
}
