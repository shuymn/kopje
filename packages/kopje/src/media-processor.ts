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
// This release has the smoke probe only (probeNow): the packaged fixture through the operation, no verifier.
import { DurableObject } from "cloudflare:workers";

import { PROBE_FIXTURE_BASE64 } from "./media-probe-fixture";
import { errorFields } from "./platform/error-message";
import type { MediaProcessorClient, ProbeProfile, ProbeReport } from "./platform/media-transcoder";

// The port container/server listens on.
const PORT = 8080;
// The first start on a host pulls the image (the experiment's first pulls took 3.2 and 7.9 s); a probe waits longer.
export const READY_MS = 90_000;
const READY_POLL_MS = 250;
// The stage times the probe gives normalize, and the bound on the whole operation.
const PROBE_STAGE_MS = 10_000;
const PROBE_ENCODE_MS = 60_000;
const OPERATION_MS = 120_000;
// AV_OUTPUT_LIMIT and STILL_OUTPUT_LIMIT: the most read of a response body (container/server/main.go refuses first).
export const AV_OUTPUT_LIMIT = 63 * 1024 * 1024;
const STILL_OUTPUT_LIMIT = 2 * 1024 * 1024;
export const CLEANUP_RETRY_MS = 60_000;
// The most a destroy is awaited; one that has not settled by then counts as failed.
export const DESTROY_MS = 30_000;
// The probe's one deadline, from before the start: readiness, then the operation.
export const PROBE_MS = READY_MS + OPERATION_MS;

const OPERATIONS = {
  normalize: { path: `/normalize?probe_ms=${PROBE_STAGE_MS}&encode_ms=${PROBE_ENCODE_MS}`, type: "video/mp4" },
  still: { path: "/still", type: "image/png" },
} as const;

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
  constructor(readonly failure: string) {
    super(failure);
  }
}

// Reads a response body of the declared length, at most `limit` bytes, counting as it reads: a body longer than its
// Content-Length or the limit is cancelled at the first byte past it.
async function readBounded(response: Response, limit: number, stage: string): Promise<number> {
  const declared = Number(response.headers.get("content-length"));
  if (!Number.isSafeInteger(declared) || declared <= 0 || declared > limit || response.body === null) {
    await response.body?.cancel();
    throw new ProbeFailure(`${stage}-length`);
  }
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  let read = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    read += value.byteLength;
    if (read > declared) {
      await reader.cancel();
      throw new ProbeFailure(`${stage}-length`);
    }
  }
  if (read !== declared) {
    throw new ProbeFailure(`${stage}-length`);
  }
  return read;
}

// A response of the operation: 200 with the expected type, or the server's error code.
async function expectOutput(response: Response, type: string, limit: number, stage: string): Promise<number> {
  if (response.status !== 200 || response.headers.get("content-type") !== type) {
    await response.body?.cancel();
    const code = response.headers.get("kopje-error");
    throw new ProbeFailure(code !== null && /^[a-z_]{1,32}$/.test(code) ? `${stage}:${code}` : `${stage}-status`);
  }
  return readBounded(response, limit, stage);
}

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

// The smoke probe of one profile on a container that is not running: start, readiness, the operation on the fixture,
// and destroy, every stage ending at `deadline`. It never throws; destroy() is attempted whatever happened before it,
// and its failure is reported as `destroyed: false` for the caller to clean up.
export async function smokeProbe(
  container: Container,
  profile: ProbeProfile,
  deps: ProbeDeps = defaultDeps,
  deadline: number = deps.now() + PROBE_MS,
): Promise<ProbeReport> {
  const started = deps.now();
  const [operation, instance] = profile.split("@") as [
    "normalize" | "still",
    "standard-1" | "standard-3" | "standard-4",
  ];
  const report: ProbeReport = {
    ok: false,
    profile,
    failure: null,
    image: { configured: container.images.media ?? null, running: null },
    startToReadyMs: null,
    operationMs: null,
    wallMs: 0,
    stages: {},
    outputBytes: null,
    stillBytes: null,
    destroyed: false,
  };
  try {
    if (report.image.configured === null) {
      throw new ProbeFailure("no-image");
    }
    container.start({
      image: report.image.configured,
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
    report.startToReadyMs = deps.now() - started;
    const info = await before(
      container.inspect().catch(() => null),
      readyBy,
      deps,
    );
    report.image.running = info === TIMED_OUT ? null : (info?.image ?? null);

    const fixture = decodeFixture();
    const begun = deps.now();
    const spec = OPERATIONS[operation];
    const aborted = new AbortController();
    const run = async () => {
      const response = await port.fetch(`http://container${spec.path}`, {
        method: "POST",
        body: fixture,
        headers: { "content-type": "application/octet-stream", "content-length": String(fixture.byteLength) },
        signal: aborted.signal,
      });
      report.stages = stageTimes(response.headers);
      report.outputBytes = await expectOutput(
        response,
        spec.type,
        operation === "normalize" ? AV_OUTPUT_LIMIT : STILL_OUTPUT_LIMIT,
        operation,
      );
      if (operation === "normalize") {
        if (response.headers.get("kopje-kind") !== "video" || response.headers.get("kopje-still") !== "true") {
          throw new ProbeFailure("normalize-kind");
        }
        const still = await port.fetch("http://container/normalize/still", { signal: aborted.signal });
        report.stillBytes = await expectOutput(still, "image/png", STILL_OUTPUT_LIMIT, "normalize-still");
      }
    };
    if ((await before(run(), deadline, deps, aborted)) === TIMED_OUT) {
      throw new ProbeFailure("operation-deadline");
    }
    report.operationMs = deps.now() - begun;
    report.ok = true;
  } catch (error) {
    report.failure = error instanceof ProbeFailure ? error.failure : "operation";
    if (!(error instanceof ProbeFailure)) {
      console.warn({ event: "kopje.media.probe.failed", profile, ...errorFields(error) });
    }
  } finally {
    report.destroyed = await destroyContainer(container, deps);
    report.ok &&= report.destroyed;
    report.wallMs = deps.now() - started;
  }
  return report;
}

// Destroys a running container within DESTROY_MS; true once it no longer runs.
async function destroyContainer(container: Container, deps: ProbeDeps): Promise<boolean> {
  try {
    if (container.running) {
      const settled = await before(container.destroy(), deps.now() + DESTROY_MS, deps);
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

// The report of a probe that started no container.
function unstarted(profile: ProbeProfile, failure: string): ProbeReport {
  return {
    ok: false,
    profile,
    failure,
    image: { configured: null, running: null },
    startToReadyMs: null,
    operationMs: null,
    wallMs: 0,
    stages: {},
    outputBytes: null,
    stillBytes: null,
    destroyed: true,
  };
}

// The parts of a Durable Object's state a unit of work uses.
export type UnitState = {
  readonly container?: Container | undefined;
  readonly storage: Pick<DurableObjectStorage, "setAlarm" | "deleteAlarm" | "sync">;
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

  async probeNow(profile: ProbeProfile): Promise<ProbeReport> {
    const container = this.state.container;
    if (container === undefined) {
      return unstarted(profile, "no-container");
    }
    if (this.#inFlight !== null || this.#cleaning) {
      return unstarted(profile, "busy");
    }
    if (container.running) {
      // An orphan; the alarm owns it.
      await this.alarmNow();
      return { ...unstarted(profile, "busy"), destroyed: false };
    }
    // No await since the checks above: two calls cannot both pass.
    const deadline = this.deps.now() + PROBE_MS;
    this.#inFlight = deadline;
    try {
      try {
        await this.state.storage.setAlarm(deadline + DESTROY_MS);
        await this.state.storage.sync();
      } catch (error) {
        console.warn({ event: "kopje.media.cleanup.failed", ...errorFields(error) });
        return unstarted(profile, "storage");
      }
      const report = await smokeProbe(container, profile, this.deps, deadline);
      // Nothing to clean up once the container is gone; otherwise the alarm comes sooner than its bound when it can.
      const after = report.destroyed
        ? this.state.storage.deleteAlarm()
        : this.state.storage.setAlarm(this.deps.now() + CLEANUP_RETRY_MS);
      await after.catch((error: unknown) => {
        console.warn({ event: "kopje.media.cleanup.failed", ...errorFields(error) });
      });
      return report;
    } finally {
      this.#inFlight = null;
    }
  }

  // The alarm: with a probe call in flight, again after its bound; otherwise any running container is an orphan.
  async alarm(): Promise<void> {
    if (this.#inFlight !== null) {
      await this.state.storage.setAlarm(Math.max(this.#inFlight + DESTROY_MS, this.deps.now() + 1_000));
      return;
    }
    const container = this.state.container;
    if (container?.running !== true || this.#cleaning) {
      return;
    }
    this.#cleaning = true;
    try {
      if (!(await destroyContainer(container, this.deps))) {
        await this.state.storage.setAlarm(this.deps.now() + CLEANUP_RETRY_MS);
      }
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

export class MediaProcessor extends DurableObject<Env> {
  readonly #unit: ProcessorUnit;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#unit = new ProcessorUnit(ctx);
    this.#unit.start();
  }

  probeNow(profile: ProbeProfile): Promise<ProbeReport> {
    return this.#unit.probeNow(profile);
  }

  override alarm(): Promise<void> {
    return this.#unit.alarm();
  }
}

// The processor through the MEDIA_PROCESSOR binding, or null when the instance has not added the block.
export function processorClient(env: Env, build: string) {
  const namespace = (env as ProcessorEnv).MEDIA_PROCESSOR;
  if (namespace === undefined) {
    return null;
  }
  return {
    probeNow(profile: ProbeProfile): Promise<ProbeReport> {
      return namespace.getByName(`p:${build}:${profile}`).probeNow(profile);
    },
  } satisfies MediaProcessorClient;
}
