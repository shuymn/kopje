// The media processor (#1828; design: one unit of work per Durable Object and container lifetime). MediaProcessor is a
// Container Durable Object: the instance template's optional block (deploy/wrangler.jsonc, "Video and audio") binds it
// as MEDIA_PROCESSOR and builds its image from the kopje package's container/. Without the block the class is exported
// and never instantiated, and processorClient answers null.
//
// A profile's probe runs on one object per profile and Worker version (p:<version>:<profile>), so at most one container
// of that profile runs by construction: a probe while another runs on the object, or while a container it cannot
// destroy is still running, answers "busy" and starts nothing. The object starts its container with Internet access
// disabled on the profile's instance type, waits for /healthz, gives the container its one input as the request body
// of the one operation, reads the output as the response body within its limit, and destroys the container before it
// answers. Before the start it computes one absolute deadline (PROBE_MS on) and stores it once, as the object's alarm;
// every stage (the healthz polls, the image inspection, the operation and both bodies) ends at that same instant
// however a call stalls, and a result that settles after it is refused. The alarm is the watchdog: an invocation that
// dies after the start still leaves an alarm that destroys the container at the deadline. When the deadline cannot be
// stored nothing starts. After a confirmed teardown the alarm and the storage are deleted; when that fails, the alarm
// finds nothing running and deletes them then. A destroy that fails is retried by the alarm every CLEANUP_RETRY_MS. An
// object restarted while its container runs destroys it before anything else.
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
    report.destroyed = await destroyContainer(container);
    report.ok &&= report.destroyed;
    report.wallMs = deps.now() - started;
  }
  return report;
}

async function destroyContainer(container: Container): Promise<boolean> {
  try {
    if (container.running) {
      await container.destroy();
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
  readonly storage: Pick<DurableObjectStorage, "setAlarm" | "deleteAlarm" | "deleteAll">;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
};

// What MediaProcessor does, over the parts of its state it uses.
export class ProcessorUnit {
  // A probe is running on this object (set and checked with no await between, so two calls cannot both pass).
  #probing = false;

  constructor(
    private readonly state: UnitState,
    private readonly deps: ProbeDeps = defaultDeps,
  ) {}

  // A restart while the container runs: nothing the earlier object read is used; the container goes first.
  start(): void {
    const container = this.state.container;
    if (container?.running === true) {
      void this.state.blockConcurrencyWhile(async () => {
        if (!(await destroyContainer(container))) {
          await this.retryCleanup();
        }
      });
    }
  }

  async probeNow(profile: ProbeProfile): Promise<ProbeReport> {
    const container = this.state.container;
    if (container === undefined) {
      return unstarted(profile, "no-container");
    }
    if (this.#probing) {
      return unstarted(profile, "busy");
    }
    this.#probing = true;
    try {
      // A container an earlier probe could not destroy: this probe tries once more, and is busy while it runs.
      if (container.running && !(await destroyContainer(container))) {
        await this.retryCleanup();
        return { ...unstarted(profile, "busy"), destroyed: false };
      }
      const deadline = this.deps.now() + PROBE_MS;
      try {
        await this.state.storage.setAlarm(deadline);
      } catch (error) {
        console.warn({ event: "kopje.media.cleanup.failed", ...errorFields(error) });
        return unstarted(profile, "storage");
      }
      const report = await smokeProbe(container, profile, this.deps, deadline);
      if (report.destroyed) {
        await this.clear();
      } else {
        await this.retryCleanup();
      }
      return report;
    } finally {
      this.#probing = false;
    }
  }

  // The alarm: the probe's deadline or a cleanup retry. Destroys the container, then deletes the alarm and the storage
  // (a SQLite object is billed for its stored data until it is removed).
  async alarm(): Promise<void> {
    const container = this.state.container;
    if (container !== undefined && !(await destroyContainer(container))) {
      await this.state.storage.setAlarm(this.deps.now() + CLEANUP_RETRY_MS);
      return;
    }
    await this.clear();
  }

  // After a confirmed teardown. A failure leaves the alarm, which finds nothing running and clears again.
  private async clear(): Promise<void> {
    try {
      await this.state.storage.deleteAll();
      await this.state.storage.deleteAlarm();
    } catch (error) {
      console.warn({ event: "kopje.media.cleanup.failed", ...errorFields(error) });
    }
  }

  // A sooner destroy than the deadline's alarm; when it cannot be written, the deadline's alarm still stands.
  private async retryCleanup(): Promise<void> {
    await this.state.storage.setAlarm(this.deps.now() + CLEANUP_RETRY_MS).catch((error: unknown) => {
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
