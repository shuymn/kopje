// The media processor (#1828; design: one unit of work per Durable Object and container lifetime). MediaProcessor is a
// Container Durable Object: the instance template's optional block (deploy/wrangler.jsonc, "Video and audio") binds it
// as MEDIA_PROCESSOR and builds its image from the kopje package's container/. Without the block the class is exported
// and never instantiated, and processorClient answers null.
//
// A profile's probe runs on one object per profile and Worker version (p:<version>:<profile>), so at most one container
// of that profile and version runs by construction. (Across a rollout the previous version's object may still hold
// its container; that object's own alarm ends it.) The object starts its container with Internet access disabled on
// the profile's instance type, waits for /healthz, gives the container its one input as the request body of the one
// operation, reads the output as the response body within its limit, and destroys the container before it answers.
//
// The rule, in one place: a probe call owns its container for its whole life and bounds every stage itself. Every
// stage (the healthz polls, the image inspection, the operation and both bodies) ends at one deadline, PROBE_MS from
// before the start, and a result that settles after it is refused; the destroy is bounded by DESTROY_MS after it.
// Before the start the call sets the object's alarm past both (deadline + DESTROY_MS) and confirms it durable
// (storage.sync), so an alarm exists before a container does even if the instance dies; when that fails nothing
// starts. The alarm acts only when no probe call is in flight in this instance (a flag set at the call's entry,
// before any await): then any running container is an orphan, whose call died with an earlier instance or returned
// after a destroy that failed, and the alarm destroys it (bounded), or tries again every CLEANUP_RETRY_MS. With a call
// in flight the alarm only sets itself again for after that call's own bound. A probe that finds an orphan running,
// or the alarm destroying one, answers "busy" (setting the alarm for now in the first case); a constructor that finds
// one sets the alarm for now and does nothing else. The object stores nothing but its alarm.
//
// probeNormalize is the activation probe of normalize@standard-4 (mastodon/media-activation.ts probeWork) on a copy of
// the packaged clip. stillNow runs /still on standard-1 for the media rebuild (design 4.16, mastodon/media-rebuild-av.ts)
// and the still check of `kopje-admin media-processor probe`: its one input key is read from the media bucket once and
// streamed as the request body, and the PNG comes back to the caller, which checks it. On a probe object it is the
// still@standard-1 probe and follows the same single-owner rule as probeNormalize; on a fresh object (rb:<nonce>) it is
// one rebuild still. Both answer only once the container is destroyed, and a still
// only by its deadline: its destroy ends STILL_CLEANUP_MS before it, the removal of the object's storage and alarm is
// awaited until it, and one that has not finished by then is left to the alarm, which repeats it until it is done.
import { DurableObject } from "cloudflare:workers";

import type { MonthlyTransforms } from "./domain/media";
import { HARD_HOLD_MS, V2_PROCESS_MS } from "./domain/media-processing";
import { R2_CALL_MS, runUpload } from "./jobs/media-jobs";
import { type ContainerControl, probeWork } from "./mastodon/media-activation";
import { PROBE_FIXTURE_BASE64 } from "./media-probe-fixture";
import { AV_OUTPUT_LIMIT, plannedDuration, STILL_OUTPUT_LIMIT } from "./platform/av-bytes";
import { accountMonthlyTransforms, envInMaintenance, readConfig } from "./platform/config";
import { errorFields } from "./platform/error-message";
import { type ImageCodec, imagesCodec } from "./platform/images";
import { incomingKey } from "./platform/media-files";
import {
  type MediaProcessorClient,
  NORMALIZE_INPUT_FAILURES,
  NORMALIZE_REFUSALS,
  type NormalizeJob,
  type NormalizeResult,
  type ProbeProfile,
  type ProbeVerdict,
  STILL_INPUT_REFUSALS,
  type StillInputRefusal,
  type StillOutcome,
  TranscoderUnavailable,
} from "./platform/media-transcoder";
import { defaultStore, type StoreStub } from "./platform/store-client";
import { buildOf } from "./version";

// The port container/server listens on.
const PORT = 8080;
// The first start on a host pulls the image (the experiment's first pulls took 3.2 and 7.9 s); a probe waits longer.
const READY_MS = 90_000;
const READY_POLL_MS = 250;
// The work deadline the activation probe gives normalize (container/server/main.go), and the bound on the whole
// operation.
const PROBE_WORK_MS = 70_000;
const OPERATION_MS = 120_000;
// AV_OUTPUT_LIMIT and STILL_OUTPUT_LIMIT (platform/av-bytes.ts) bound what is read of a response body
// (container/server/main.go refuses first).
export { AV_OUTPUT_LIMIT };
export const CLEANUP_RETRY_MS = 60_000;
// The most a destroy is awaited; one that has not settled by then counts as failed.
export const DESTROY_MS = 30_000;
// The probe's one deadline, from before the start: readiness, then the operation.
export const PROBE_MS = READY_MS + OPERATION_MS;
// The most a stillNow call is given, readiness included: the rebuild's still stage (mastodon/media-rebuild-av.ts).
export const STILL_CALL_MS = 75_000;
// Of a stillNow call's time, what is kept for the destroy after the operation, and of that, what is kept after the
// destroy for removing the object's alarm and storage before the call answers.
export const STILL_TEARDOWN_MS = 10_000;
const STILL_CLEANUP_MS = 2_000;
const STILL_PROFILE = "still@standard-1" satisfies ProbeProfile;

type ProcessorEnv = Env & { MEDIA_PROCESSOR?: DurableObjectNamespace<MediaProcessor> };

export type ProbeDeps = {
  now: () => number;
  wait: (ms: number) => Promise<void>;
};

const defaultDeps: ProbeDeps = { now: () => Date.now(), wait: (ms) => scheduler.wait(ms) };

function decodeFixture(): Uint8Array<ArrayBuffer> {
  const binary = atob(PROBE_FIXTURE_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

const TIMED_OUT: unique symbol = Symbol("timed out");

// Settles with the promise, or with TIMED_OUT once the deadline (on deps' clock) passes, including a result that
// settles at or after the deadline before the timer does; aborts `controller` then.
async function before<T>(
  promise: Promise<T>,
  deadline: number,
  deps: ProbeDeps,
  controller?: AbortController,
): Promise<T | typeof TIMED_OUT> {
  promise.catch(() => {});
  const left = deadline - deps.now();
  const settled: T | typeof TIMED_OUT =
    left <= 0 ? TIMED_OUT : await Promise.race([promise, deps.wait(left).then((): typeof TIMED_OUT => TIMED_OUT)]);
  const result = deps.now() >= deadline ? TIMED_OUT : settled;
  if (result === TIMED_OUT) {
    controller?.abort();
  }
  return result;
}

class ProbeFailure extends Error {
  constructor(
    readonly failure: string,
    // The container refused the input itself (readStill).
    readonly input?: StillInputRefusal,
  ) {
    super(failure);
  }
}

// A refusal of a still's input, from the response's status and code together: 422 with one of the plan's input
// refusals, or 413 too_large. A code under any other status is not one.
function inputRefusal(status: number, code: string | null): StillInputRefusal | undefined {
  const refusal = STILL_INPUT_REFUSALS.find((known) => known === code);
  if (refusal === undefined) {
    return undefined;
  }
  return (refusal === "too_large" ? status === 413 : status === 422) ? refusal : undefined;
}

// The body of a 200 image/png response, read within STILL_OUTPUT_LIMIT and its declared length, as bytes.
async function readStill(response: Response): Promise<Uint8Array> {
  if (response.status !== 200 || response.headers.get("content-type") !== "image/png") {
    await response.body?.cancel();
    const code = response.headers.get("kopje-error");
    throw new ProbeFailure(
      code !== null && /^[a-z_]{1,32}$/.test(code) ? `still:${code}` : "still-status",
      inputRefusal(response.status, code),
    );
  }
  const declared = Number(response.headers.get("content-length"));
  if (!Number.isSafeInteger(declared) || declared <= 0 || declared > STILL_OUTPUT_LIMIT || response.body === null) {
    await response.body?.cancel();
    throw new ProbeFailure("still-length");
  }
  // From here the headers kept the contract: a body that ends short is the connection's (still-truncated); one longer
  // than declared is not (still-length).
  const out = new Uint8Array(declared);
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  let read = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (read + value.byteLength > declared) {
      await reader.cancel();
      throw new ProbeFailure("still-length");
    }
    out.set(value, read);
    read += value.byteLength;
  }
  if (read !== declared) {
    throw new ProbeFailure("still-truncated");
  }
  return out;
}

// The server's stage times (its Kopje-*-Ms headers), each a whole number of milliseconds.
function stageTimes(headers: Headers): Record<string, number> {
  const stages: Record<string, number> = {};
  for (const name of ["input", "probe", "encode", "still", "encode-cpu", "estimate"]) {
    const text = headers.get(`kopje-${name}-ms`);
    const value = Number(text);
    if (text !== null && /^\d{1,9}$/.test(text) && Number.isSafeInteger(value)) {
      stages[name] = value;
    }
  }
  return stages;
}

// The server's error code of a response, when it is one.
function errorCode(response: Response): string | null {
  const code = response.headers.get("kopje-error");
  return code !== null && /^[a-z_]{1,32}$/.test(code) ? code : null;
}

// Replies outside the input's outcomes that say nothing of the build: 408 input_timeout (the input arrived too slowly),
// 429 busy, 500 internal (the server could not set up its work: a directory, ffprobe), and a gateway's 502, 503 or 504.
const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

// The normalize adapter (design 4.2; #1828 PR4 plan, section 3 "PR4-2"): one POST /normalize on a ready container with
// the job's input as its body and its work deadline, its answer read against the server's contract
// (container/server/main.go). An input refused, outside the envelope, failed as A5 states or past a stage's cut is the
// input's outcome; anything else throws TranscoderUnavailable. The output is not read here: `file` streams it, for the
// caller to read through the verifier within AV_OUTPUT_LIMIT.
export async function normalize(port: Fetcher, job: NormalizeJob): Promise<NormalizeResult> {
  let response: Response;
  try {
    response = await port.fetch(`http://container/normalize?work_ms=${job.workMs}&still_ms=${job.stillMs}`, {
      method: "POST",
      body: job.input.body.pipeThrough(new FixedLengthStream(job.input.size)),
      headers: { "content-type": "application/octet-stream", "content-length": String(job.input.size) },
      ...(job.signal === undefined ? {} : { signal: job.signal }),
    });
  } catch {
    throw new TranscoderUnavailable("normalize-fetch");
  }
  const stages = stageTimes(response.headers);
  const code = errorCode(response);
  if (response.status !== 200) {
    await response.body?.cancel();
    const refused = NORMALIZE_REFUSALS.find((known) => known === code);
    if (code === "envelope" && response.status === 422) {
      return { ok: false, outcome: "envelope", code, stages };
    }
    if (refused !== undefined && response.status === (refused === "too_large" ? 413 : 422)) {
      return { ok: false, outcome: "refused", code: refused, stages };
    }
    if (response.status === 500 && NORMALIZE_INPUT_FAILURES.some((known) => known === code)) {
      return { ok: false, outcome: "refused", code: code as string, stages };
    }
    if (response.status === 504 && code === "timeout") {
      return { ok: false, outcome: "timeout", code, stages };
    }
    // Busy, a slow input, the server's own internal failure and a gateway's reply are the moment's (TRANSIENT_STATUSES);
    // any other reply here is outside the server's contract, the build's.
    throw new TranscoderUnavailable(`normalize:${code ?? response.status}`, !TRANSIENT_STATUSES.has(response.status));
  }
  const type = response.headers.get("content-type");
  const kind = response.headers.get("kopje-kind");
  const length = Number(response.headers.get("content-length"));
  const duration = plannedDuration(response.headers.get("kopje-duration-ms"));
  const still = response.headers.get("kopje-still");
  const typed =
    (type === "video/mp4" && kind === "video" && (still === "true" || still === "false")) ||
    (type === "audio/mpeg" && kind === "audio" && still === null);
  if (
    !typed ||
    !Number.isSafeInteger(length) ||
    length <= 0 ||
    length > AV_OUTPUT_LIMIT ||
    duration === undefined ||
    response.body === null
  ) {
    await response.body?.cancel();
    throw new TranscoderUnavailable("normalize-contract", true);
  }
  return {
    ok: true,
    kind,
    type,
    file: response.body as ReadableStream<Uint8Array>,
    length,
    duration,
    stages,
    still: async () => (still === "true" ? normalizeStill(port, job.signal) : null),
  };
}

// The still a video's normalize kept (GET /normalize/still), read within STILL_OUTPUT_LIMIT and its declared length;
// null when the server has none. Any other failure throws TranscoderUnavailable.
async function normalizeStill(port: Fetcher, signal: AbortSignal | undefined): Promise<Uint8Array | null> {
  let response: Response;
  try {
    response = await port.fetch("http://container/normalize/still", signal === undefined ? {} : { signal });
  } catch {
    throw new TranscoderUnavailable("still-fetch");
  }
  if (response.status === 404 && errorCode(response) === "no_still") {
    await response.body?.cancel();
    return null;
  }
  try {
    return await readStill(response);
  } catch (error) {
    // A status, type or length the server never answers for the still is the build's; a body cut short, or a read
    // that fails, may be the connection's.
    const failure = error instanceof ProbeFailure ? error.failure : "still-read";
    throw new TranscoderUnavailable(
      failure,
      failure === "still-status" || failure === "still-length" || failure.startsWith("still:"),
    );
  }
}

// Starts the container with Internet access disabled on `instance`, polls /healthz until it answers (within READY_MS
// of `started` and `deadline`), and reads the image it runs.
async function startReady(
  container: Container,
  image: string,
  operation: "normalize" | "still",
  instance: "standard-1" | "standard-3" | "standard-4",
  deps: ProbeDeps,
  started: number,
  deadline: number,
): Promise<{ port: Fetcher; readyMs: number; running: string | null }> {
  container.start({
    image: image,
    instance,
    enableInternet: false,
    labels: { app: "kopje-media", operation, instance },
  });
  const port = container.getTcpPort(PORT);
  const readyBy = Math.min(started + READY_MS, deadline);
  for (;;) {
    const poll = new AbortController();
    const ready = await before(
      port.fetch("http://container/healthz", { signal: poll.signal }).then(
        async (response) => {
          await response.body?.cancel();
          return response.ok;
        },
        () => false,
      ),
      readyBy,
      deps,
      poll,
    );
    if (ready === true) {
      break;
    }
    if (ready === TIMED_OUT || deps.now() >= readyBy) {
      throw new ProbeFailure("ready");
    }
    await deps.wait(Math.min(READY_POLL_MS, readyBy - deps.now()));
  }
  const readyMs = deps.now() - started;
  const info = await before(
    container.inspect().catch(() => null),
    readyBy,
    deps,
  );
  return { port, readyMs, running: info === TIMED_OUT ? null : (info?.image ?? null) };
}

// The still of the object at `key` on a container that is not running: start on standard-1, readiness, one read of the
// key streamed into /still with its length, the PNG read back, and destroy. Everything ends at one absolute `deadline`:
// the operation by STILL_TEARDOWN_MS before it (a read of the key that answers later has its body cancelled and nothing
// is sent to the container), the destroy by the deadline itself, and an answer whose teardown ended past it is not ok.
// It never throws; the destroy is attempted whatever happened before it, and one that did not finish is `pending`.
async function runStill(
  container: Container,
  bucket: Pick<R2Bucket, "get">,
  key: string,
  deps: ProbeDeps,
  deadline: number,
): Promise<StillOutcome & { destroyed: boolean }> {
  const started = deps.now();
  const operationEnd = deadline - STILL_TEARDOWN_MS;
  let image: string | null = container.images.media ?? null;
  let result: StillOutcome;
  try {
    if (image === null) {
      throw new ProbeFailure("no-image");
    }
    const ready = await startReady(container, image, "still", "standard-1", deps, started, operationEnd);
    image = ready.running ?? image;
    const aborted = new AbortController();
    const run = async () => {
      const object = await bucket.get(key);
      if (object === null) {
        throw new ProbeFailure("input-missing");
      }
      // Answered at or past the operation's end: the call has given up, so the container is not given the input.
      if (aborted.signal.aborted || deps.now() >= operationEnd) {
        await object.body.cancel();
        throw new ProbeFailure("operation-deadline");
      }
      const response = await ready.port.fetch("http://container/still", {
        method: "POST",
        body: object.body.pipeThrough(new FixedLengthStream(object.size)),
        headers: { "content-type": "application/octet-stream", "content-length": String(object.size) },
        signal: aborted.signal,
      });
      return readStill(response);
    };
    const png = await before(run(), operationEnd, deps, aborted);
    if (png === TIMED_OUT) {
      throw new ProbeFailure("operation-deadline");
    }
    result = { ok: true, png, image };
  } catch (error) {
    if (error instanceof ProbeFailure) {
      result = {
        ok: false,
        failure: error.failure,
        image,
        ...(error.input === undefined ? {} : { input: error.input }),
      };
    } else {
      result = { ok: false, failure: "operation", image };
      console.warn({ event: "kopje.media.still.failed", ...errorFields(error) });
    }
  }
  const destroyed = await destroyContainer(container, deps, deadline - STILL_CLEANUP_MS);
  if (!destroyed) {
    return { ok: false, failure: "destroy", image, pending: true, destroyed };
  }
  if (result.ok && deps.now() > deadline - STILL_CLEANUP_MS) {
    return { ok: false, failure: "late", image, destroyed };
  }
  return { ...result, destroyed };
}

// Destroys a running container within DESTROY_MS (and by `by`, when given); true once it no longer runs.
async function destroyContainer(container: Container, deps: ProbeDeps, by?: number): Promise<boolean> {
  try {
    if (container.running) {
      const settled = await before(container.destroy(), Math.min(by ?? Infinity, deps.now() + DESTROY_MS), deps);
      if (settled === TIMED_OUT) {
        console.warn({ event: "kopje.media.destroy.failed", reason: "timeout" });
        return false;
      }
    }
    return !container.running;
  } catch (error) {
    console.warn({ event: "kopje.media.destroy.failed", ...errorFields(error) });
    return false;
  }
}

// The parts of a Durable Object's state a unit of work uses.
export type UnitState = {
  readonly container?: Container | undefined;
  // The media bucket, which stillNow reads its input from.
  readonly bucket?: Pick<R2Bucket, "get">;
  // Images, which the activation probe's still goes through.
  readonly images?: ImageCodec;
  readonly storage: Pick<DurableObjectStorage, "setAlarm" | "deleteAll" | "sync">;
};

// What MediaProcessor does, over the parts of its state it uses.
export class ProcessorUnit {
  // The deadline of the probe call in flight in this instance, or null. Set at the call's entry, before any await.
  #inFlight: number | null = null;
  // The alarm is destroying an orphan: a probe call answers busy meanwhile (the container may stop before the
  // destroy's reply).
  #cleaning = false;

  constructor(
    private readonly state: UnitState,
    private readonly deps: ProbeDeps = defaultDeps,
  ) {}

  // A restart while a container runs: its call died with the earlier instance, so it is an orphan for the alarm.
  start(): void {
    if (this.state.container?.running === true) {
      void this.alarmNow();
    }
  }

  // A still of the object at `key` (the rebuild's still or its still probe), within `ms` of now and at most
  // STILL_CALL_MS.
  async stillNow(key: string, ms: number): Promise<StillOutcome> {
    const bucket = this.state.bucket;
    const owned = await this.#owned<StillOutcome & { destroyed: boolean }>(
      Math.min(ms, STILL_CALL_MS),
      async (deadline, container) =>
        bucket === undefined
          ? { ok: false as const, failure: "no-bucket", image: null, destroyed: true }
          : runStill(container, bucket, key, this.deps, deadline),
      (deadline) => deadline,
      // A still whose cleanup ran past the call's deadline is not used: the caller has given up on it.
      (outcome) =>
        outcome.ok ? { ok: false, failure: "late", image: outcome.image, destroyed: outcome.destroyed } : outcome,
    );
    if ("refused" in owned) {
      return { ok: false, failure: owned.refused, image: null };
    }
    const { destroyed: _destroyed, ...outcome } = owned;
    return outcome;
  }

  // The activation probe of normalize@standard-4 on the copy of the clip at `key` (mastodon/media-activation.ts
  // probeWork), on this object's one container under the single-owner rule (#owned), every stage ending at its one
  // deadline (PROBE_MS): one that has not answered by then reaches no verdict, its requests aborted. A probe that cannot
  // run here (busy, no container, storage) reaches no verdict.
  async probeNormalize(key: string): Promise<ProbeVerdict & { image: string | null }> {
    const { bucket, images } = this.state;
    const owned = await this.#owned<ProbeVerdict & { image: string | null; destroyed: boolean }>(
      PROBE_MS,
      async (deadline, container) => {
        if (bucket === undefined || images === undefined) {
          return { outcome: "no-verdict", reason: "no-bucket", image: null, destroyed: true };
        }
        const control = containerControl(container, this.deps, "normalize", "standard-4");
        const aborted = new AbortController();
        const settled = await before(
          probeWork({ ...control, bucket, images, now: this.deps.now }, key, deadline, PROBE_WORK_MS, aborted.signal),
          deadline,
          this.deps,
          aborted,
        );
        const verdict: ProbeVerdict =
          settled === TIMED_OUT ? { outcome: "no-verdict", reason: "operation-deadline" } : settled;
        const destroyed = await destroyContainer(container, this.deps);
        return { ...verdict, image: control.image(), destroyed };
      },
      (deadline) => deadline + DESTROY_MS,
      (verdict) => verdict,
    );
    if ("refused" in owned) {
      return { outcome: "no-verdict", reason: owned.refused, image: null };
    }
    const { destroyed: _destroyed, ...verdict } = owned;
    return verdict;
  }

  // Runs one operation that owns this object's container (design 4.5): refused as busy while another runs here or an
  // orphan still runs; the alarm set past its bound and confirmed durable before anything starts; then, once the
  // container is destroyed, its storage and alarm removed, or the alarm brought forward to retry the destroy. That
  // cleanup is awaited only until `replyBy(deadline)`: one that has not finished by then leaves the alarm, which removes
  // the storage itself (alarm), and the result goes through `late`.
  async #owned<R extends { destroyed: boolean }>(
    ms: number,
    run: (deadline: number, container: Container) => Promise<R>,
    replyBy: (deadline: number) => number,
    late: (report: R) => R,
  ): Promise<R | { refused: string; destroyed: boolean }> {
    const container = this.state.container;
    if (container === undefined) {
      return { refused: "no-container", destroyed: true };
    }
    if (this.#inFlight !== null || this.#cleaning) {
      return { refused: "busy", destroyed: true };
    }
    const deadline = this.deps.now() + ms;
    if (container.running) {
      // An orphan; the alarm owns it. Setting it for now is awaited only until the call's deadline.
      await before(this.alarmNow(), deadline, this.deps);
      return { refused: "busy", destroyed: false };
    }
    // No await since the checks above: two calls cannot both pass.
    this.#inFlight = deadline;
    try {
      // The alarm's write and its commit are awaited within the call's deadline too.
      const stored = await before(
        (async () => {
          await this.state.storage.setAlarm(deadline + DESTROY_MS);
          await this.state.storage.sync();
          return true;
        })().catch((error: unknown) => {
          console.warn({ event: "kopje.media.cleanup.failed", ...errorFields(error) });
          return false;
        }),
        deadline,
        this.deps,
      );
      if (stored === false) {
        return { refused: "storage", destroyed: true };
      }
      // A commit that settled past the deadline leaves no time: nothing is started.
      if (stored === TIMED_OUT || this.deps.now() >= deadline) {
        return { refused: "storage-late", destroyed: true };
      }
      const report = await run(deadline, container);
      // Nothing to clean up once the container is gone (the object's storage goes too, so a fresh object leaves
      // nothing billed behind); otherwise the alarm comes sooner than its bound when it can.
      const after = report.destroyed ? this.#clear() : this.state.storage.setAlarm(this.deps.now() + CLEANUP_RETRY_MS);
      const cleaned = await before(
        after.then(
          () => true,
          (error: unknown) => {
            console.warn({ event: "kopje.media.cleanup.failed", ...errorFields(error) });
            return true;
          },
        ),
        replyBy(deadline),
        this.deps,
      );
      return cleaned === TIMED_OUT ? late(report) : report;
    } finally {
      this.#inFlight = null;
    }
  }

  // No container runs: the object's storage and its alarm are removed, in one step (deleteAll removes the alarm too
  // from compatibility date 2026-02-24; this Worker's is 2026-10-11). A removal that fails or never finishes leaves the
  // alarm to run it again, and no separate alarm delete can land after a later call set its own.
  async #clear(): Promise<void> {
    await this.state.storage.deleteAll();
  }

  // The alarm: with a probe call in flight, again after its bound; otherwise any running container is an orphan, and
  // once none runs (destroyed here, or already stopped: a destroy that finished after its call answered) the object's
  // storage is removed. A removal that fails sets the alarm again.
  async alarm(): Promise<void> {
    if (this.#inFlight !== null) {
      await this.state.storage.setAlarm(Math.max(this.#inFlight + DESTROY_MS, this.deps.now() + 1_000));
      return;
    }
    const container = this.state.container;
    if (this.#cleaning) {
      return;
    }
    this.#cleaning = true;
    try {
      if (container?.running === true && !(await destroyContainer(container, this.deps))) {
        await this.state.storage.setAlarm(this.deps.now() + CLEANUP_RETRY_MS);
        return;
      }
      await this.#clear().catch(async (error: unknown) => {
        console.warn({ event: "kopje.media.cleanup.failed", ...errorFields(error) });
        await this.state.storage.setAlarm(this.deps.now() + CLEANUP_RETRY_MS);
      });
    } finally {
      this.#cleaning = false;
    }
  }

  private async alarmNow(): Promise<void> {
    await this.state.storage.setAlarm(this.deps.now()).catch((error: unknown) => {
      console.warn({ event: "kopje.media.cleanup.failed", ...errorFields(error) });
    });
  }
}

// The container of one unit of work as jobs/media-jobs.ts drives it: started on `instance` with Internet access
// disabled and polled at /healthz until `by` (a 404 there, which the server never answers, is `wrong`: a build without
// the server), the normalize adapter, and the confirmed stop (destroyContainer).
function containerControl(
  container: Container,
  deps: ProbeDeps,
  operation: "normalize",
  instance: "standard-4",
): ContainerControl & { image: () => string | null } {
  let image: string | null = container.images.media ?? null;
  return {
    image: () => image,
    async ready(by) {
      if (image === null || deps.now() >= by) {
        return null;
      }
      container.start({ image, instance, enableInternet: false, labels: { app: "kopje-media", operation, instance } });
      const port = container.getTcpPort(PORT);
      for (;;) {
        const poll = new AbortController();
        const status = await before(
          port.fetch("http://container/healthz", { signal: poll.signal }).then(
            async (response) => {
              await response.body?.cancel();
              return response.status;
            },
            () => null,
          ),
          by,
          deps,
          poll,
        );
        if (status === 200) {
          const info = await before(
            container.inspect().catch(() => null),
            by,
            deps,
          );
          image = info === TIMED_OUT ? image : (info?.image ?? image);
          return port;
        }
        if (status === 404) {
          return "wrong";
        }
        if (status === TIMED_OUT || deps.now() >= by) {
          return null;
        }
        await deps.wait(Math.min(READY_POLL_MS, by - deps.now()));
      }
    },
    normalize,
    stop: () => destroyContainer(container, deps),
  };
}

// ---- Uploads (#1828 PR4 plan, section 1.3)
//
// An upload's object, u:<id>:<token>, runs its work in alarm(), which the platform runs one at a time; its record
// (`upload`: the id, the file token, the teardown_id and when run first stored it, on this object's clock) is the only
// thing it stores besides its alarm. The steps, each set and confirmed after the one alarm D1 arms:
//   D0 run         the record and an alarm for now in one storage transaction; a record without an alarm gets one;
//                  otherwise nothing, so a repeated run, or one during alarm(), starts no second invocation
//   D1 entry       the record-age stop: a record V2_PROCESS_MS + HARD_HOLD_MS old with no container running deletes
//                  the input, then the storage (W9; a failed delete keeps the record for the alarm's repeat); else an invocation id drawn in memory and the alarm set for
//                  CLEANUP_RETRY_MS later and confirmed (sync), which every later step relies on
//   D2 S4          started: runUpload (D3-D7, jobs/media-jobs.ts); settled or gone: the cleanup replay; maintenance
//                  (or no answer): a running container is stopped, and the invocation ends with the record and alarm
//                  kept, so the alarm repeats it
//   D4             the confirmed stop; an unconfirmed one ends the invocation with no Store write, its granted slot
//                  counting, and the alarm repeats it
//   D8 input       incoming/<id> deleted, awaited at most R2_CALL_MS; D9 follows whatever it did, so the slot is
//                  released on its own
//   D9 S8          the stop confirmation with the record's teardown_id, only after a confirmed stop: `released`, with
//                  the input deleted, deletes the storage (its alarm too); anything else ends the invocation and the
//                  alarm repeats D8, D9 (MEDIA-3: an attached upload's input is held from the orphan pass)
// The cleanup replay (S4 not `started`): the stop under D4's rule, then D8 and D9.
const UPLOAD_KEY = "upload";

type UploadRecord = { id: string; token: string; teardownId: string; at: number };

export type UploadState = {
  readonly container?: Container | undefined;
  readonly bucket: R2Bucket;
  readonly storage: Pick<
    DurableObjectStorage,
    "get" | "put" | "transaction" | "getAlarm" | "setAlarm" | "deleteAll" | "sync"
  >;
};

export type UploadUnitDeps = ProbeDeps & {
  build: string;
  store: () => StoreStub;
  images: ImageCodec;
  monthlyTransforms: () => MonthlyTransforms;
  // The Worker's env holds it in maintenance (MAINTENANCE not off): no job starts.
  maintenance: () => boolean;
};

export class UploadUnit {
  constructor(
    private readonly state: UploadState,
    private readonly deps: UploadUnitDeps,
  ) {}

  // D0.
  async run(id: string, token: string, teardownId: string): Promise<void> {
    const at = this.deps.now();
    await this.state.storage.transaction(async (txn) => {
      if ((await txn.get<UploadRecord>(UPLOAD_KEY)) === undefined) {
        await txn.put(UPLOAD_KEY, { id, token, teardownId, at } satisfies UploadRecord);
        await txn.setAlarm(at);
      } else if ((await txn.getAlarm()) === null) {
        await txn.setAlarm(at);
      }
    });
  }

  async holds(): Promise<boolean> {
    return (await this.state.storage.get<UploadRecord>(UPLOAD_KEY)) !== undefined;
  }

  // D1-D9. A failure is logged and leaves the alarm D1 set, which repeats the cleanup.
  async alarm(): Promise<void> {
    const record = await this.state.storage.get<UploadRecord>(UPLOAD_KEY);
    if (record === undefined) {
      return;
    }
    const { storage, container } = this.state;
    const now = this.deps.now();
    if (now - record.at >= V2_PROCESS_MS + HARD_HOLD_MS && container?.running !== true) {
      console.warn({ event: "kopje.media.job.record_aged", id: record.id });
      // The record goes only with the input (MEDIA-3): the retry is armed first, so a delete that fails or never
      // answers is repeated by the alarm.
      await storage.setAlarm(now + CLEANUP_RETRY_MS);
      if (await this.#dropInput(record)) {
        await storage.deleteAll();
      }
      return;
    }
    const invocation = crypto.randomUUID();
    await storage.setAlarm(now + CLEANUP_RETRY_MS);
    await storage.sync();
    try {
      // The Worker's maintenance gates the start as the Store's does: the record and D1's alarm stay, so it repeats.
      if (this.deps.maintenance()) {
        await this.#stop();
        return;
      }
      const asked = this.deps.now();
      const started = await this.deps
        .store()
        .startNormalize(this.deps.build, { id: record.id, token: record.token, invocation });
      if (started.status === "maintenance") {
        await this.#stop();
        return;
      }
      if (started.status !== "started") {
        await this.#cleanup(record);
        return;
      }
      const control = containerControlOf(container, this.deps);
      const end = await runUpload(
        {
          ...control,
          build: this.deps.build,
          store: this.deps.store(),
          bucket: this.state.bucket,
          images: this.deps.images,
          monthlyTransforms: this.deps.monthlyTransforms(),
          now: this.deps.now,
          wait: this.deps.wait,
        },
        {
          id: record.id,
          token: record.token,
          startId: started.startId,
          endpoint: started.endpoint,
          inputBytes: started.inputBytes,
          deadline: asked + started.msLeft,
        },
      );
      if (end.stopped) {
        await this.#release(record);
      }
    } catch (error) {
      console.warn({ event: "kopje.media.job.alarm_failed", id: record.id, ...errorFields(error) });
      await this.#stop();
    }
  }

  // The cleanup replay: the stop under D4's rule, then D8 and D9.
  async #cleanup(record: UploadRecord): Promise<void> {
    if (await this.#stop()) {
      await this.#release(record);
    }
  }

  // Whether no container runs here: destroyed and confirmed, or none was running.
  async #stop(): Promise<boolean> {
    const container = this.state.container;
    return container === undefined || !container.running || destroyContainer(container, this.deps);
  }

  // D8: true once incoming/<id> is deleted (R2's delete answers for a key that is already gone too); false when the
  // delete fails or has not answered within R2_CALL_MS.
  async #dropInput(record: UploadRecord): Promise<boolean> {
    try {
      const deleting = this.state.bucket.delete(incomingKey(record.id));
      if ((await before(deleting, this.deps.now() + R2_CALL_MS, this.deps)) === TIMED_OUT) {
        console.warn({ event: "kopje.media.job.input_delete_failed", id: record.id, reason: "timeout" });
        return false;
      }
      return true;
    } catch (error) {
      console.warn({ event: "kopje.media.job.input_delete_failed", id: record.id, ...errorFields(error) });
      return false;
    }
  }

  // D8, then D9 whatever D8 did, so the slot is released on its own: the storage goes only once S8 answers `released`
  // and the input is deleted. A failed delete leaves the record and D1's alarm, whose replay repeats D8 and D9 (S8 again
  // answers `released`): a completed upload's input is no sweep's, and the orphan pass holds an attached one (MEDIA-3).
  async #release(record: UploadRecord): Promise<void> {
    const dropped = await this.#dropInput(record);
    const released = await this.deps
      .store()
      .releaseAvSlot(this.deps.build, { id: record.id, teardownId: record.teardownId });
    if (released.status === "released" && dropped) {
      await this.state.storage.deleteAll();
    }
  }
}

// An upload's container control, or one that never becomes ready when the object has no container.
function containerControlOf(container: Container | undefined, deps: ProbeDeps): ContainerControl {
  if (container === undefined) {
    return { ready: () => Promise.resolve(null), normalize, stop: () => Promise.resolve(true) };
  }
  return containerControl(container, deps, "normalize", "standard-4");
}

export class MediaProcessor extends DurableObject<Env> {
  readonly #unit: ProcessorUnit;
  readonly #upload: UploadUnit;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const images = imagesCodec(env.IMAGES);
    this.#unit = new ProcessorUnit({ container: ctx.container, storage: ctx.storage, bucket: env.MEDIA, images });
    this.#upload = new UploadUnit(
      { container: ctx.container, storage: ctx.storage, bucket: env.MEDIA },
      {
        ...defaultDeps,
        build: buildOf(env),
        store: () => defaultStore(env),
        images,
        monthlyTransforms: () => {
          const config = readConfig(env);
          return config.ok
            ? { instance: config.config.IMAGES_MONTHLY_TRANSFORMS, account: accountMonthlyTransforms(config.config) }
            : { instance: 0, account: 0 };
        },
        maintenance: () => envInMaintenance(env),
      },
    );
    this.#unit.start();
  }

  run(id: string, token: string, teardownId: string): Promise<void> {
    return this.#upload.run(id, token, teardownId);
  }

  probeNormalize(key: string): Promise<ProbeVerdict & { image: string | null }> {
    return this.#unit.probeNormalize(key);
  }

  stillNow(key: string, ms: number): Promise<StillOutcome> {
    return this.#unit.stillNow(key, ms);
  }

  // An upload's object holds its record; any other object's alarm is the probe and still cleanup.
  override async alarm(): Promise<void> {
    if (await this.#upload.holds()) {
      return this.#upload.alarm();
    }
    return this.#unit.alarm();
  }
}

// The processor through the MEDIA_PROCESSOR binding, or null when the instance has not added the block.
export function processorClient(env: Env, build: string) {
  const namespace = (env as ProcessorEnv).MEDIA_PROCESSOR;
  if (namespace === undefined) {
    return null;
  }
  // A call that does not answer (the object or its RPC failed) is an infrastructure failure of the still.
  const still = (name: string, key: string, ms: number): Promise<StillOutcome> =>
    namespace
      .getByName(name)
      .stillNow(key, ms)
      .catch((error: unknown): StillOutcome => {
        console.warn({ event: "kopje.media.still.failed", ...errorFields(error) });
        return { ok: false, failure: "unavailable", image: null };
      });
  return {
    stills: {
      still: (key, ms) => still(`rb:${crypto.randomUUID()}`, key, ms),
      probe: (key, ms) => still(`p:${build}:${STILL_PROFILE}`, key, ms),
      probeInput: decodeFixture(),
    },
    uploads: {
      run: (id, token, teardownId) => namespace.getByName(`u:${id}:${token}`).run(id, token, teardownId),
      probeNormalize: (key) => namespace.getByName(`p:${build}:normalize@standard-4`).probeNormalize(key),
      probeInput: decodeFixture(),
    },
  } satisfies MediaProcessorClient;
}
