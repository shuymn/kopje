// The media processor (#1828; design: one unit of work per Durable Object and container lifetime). MediaProcessor is a
// Container Durable Object: the instance template's optional block (deploy/wrangler.jsonc, "Video and audio") binds it
// as MEDIA_PROCESSOR and builds its image from the kopje package's container/. Without the block the class is exported
// and never instantiated, and processorClient answers null.
//
// Each unit of work runs on a fresh object under a name used once (a probe: p:<version>:<profile>:<nonce>). The object
// starts its container with Internet access disabled on the profile's instance type, waits for /healthz, gives the
// container its one input as the request body of the one operation, reads the output as the response body within its
// limit, and destroys the container before it answers. A destroy that throws leaves a cleanup alarm, which retries it
// every CLEANUP_RETRY_MS and then deletes the object's storage. An object restarted while its container runs destroys
// it before anything else.
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
const CLEANUP_KEY = "cleanup";

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
// and destroy. It never throws; destroy() is attempted whatever happened before it, and its failure is reported as
// `destroyed: false` for the caller to clean up.
export async function smokeProbe(
  container: Container,
  profile: ProbeProfile,
  deps: ProbeDeps = defaultDeps,
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
    for (;;) {
      const ready = await port.fetch("http://container/healthz").then(
        async (response) => {
          await response.body?.cancel();
          return response.ok;
        },
        () => false,
      );
      if (ready) {
        break;
      }
      if (deps.now() - started > READY_MS) {
        throw new ProbeFailure("ready");
      }
      await deps.wait(READY_POLL_MS);
    }
    report.startToReadyMs = deps.now() - started;
    report.image.running = (await container.inspect())?.image ?? null;

    const fixture = decodeFixture();
    const begun = deps.now();
    const spec = OPERATIONS[operation];
    const signal = AbortSignal.timeout(OPERATION_MS);
    const response = await port.fetch(`http://container${spec.path}`, {
      method: "POST",
      body: fixture,
      headers: { "content-type": "application/octet-stream", "content-length": String(fixture.byteLength) },
      signal,
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
      const still = await port.fetch("http://container/normalize/still", { signal });
      report.stillBytes = await expectOutput(still, "image/png", STILL_OUTPUT_LIMIT, "normalize-still");
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

// The parts of a Durable Object's state a unit of work uses.
export type UnitState = {
  readonly container?: Container | undefined;
  readonly storage: Pick<DurableObjectStorage, "put" | "setAlarm" | "deleteAlarm" | "deleteAll">;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
};

// What MediaProcessor does, over the parts of its state it uses.
export class ProcessorUnit {
  constructor(private readonly state: UnitState) {}

  // A restart while the container runs: nothing the earlier object read is used; the container goes first.
  start(): void {
    const container = this.state.container;
    if (container?.running === true) {
      void this.state.blockConcurrencyWhile(async () => {
        if (!(await destroyContainer(container))) {
          await this.keepCleaning();
        }
      });
    }
  }

  async probeNow(profile: ProbeProfile): Promise<ProbeReport> {
    const container = this.state.container;
    if (container === undefined) {
      return {
        ok: false,
        profile,
        failure: "no-container",
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
    if (container.running && !(await destroyContainer(container))) {
      await this.keepCleaning();
      throw new Error("a container from an earlier start could not be destroyed");
    }
    const report = await smokeProbe(container, profile);
    if (report.destroyed) {
      await this.state.storage.deleteAll();
    } else {
      await this.keepCleaning();
    }
    return report;
  }

  // The cleanup alarm: destroy the container, then delete the object's storage (a SQLite object is billed for its
  // stored data until it is removed).
  async alarm(): Promise<void> {
    const container = this.state.container;
    if (container !== undefined && !(await destroyContainer(container))) {
      await this.state.storage.setAlarm(Date.now() + CLEANUP_RETRY_MS);
      return;
    }
    await this.state.storage.deleteAlarm();
    await this.state.storage.deleteAll();
  }

  private async keepCleaning(): Promise<void> {
    await this.state.storage.put(CLEANUP_KEY, true);
    await this.state.storage.setAlarm(Date.now() + CLEANUP_RETRY_MS);
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
export function processorClient(env: Env, build: string, nonce: () => string = () => crypto.randomUUID()) {
  const namespace = (env as ProcessorEnv).MEDIA_PROCESSOR;
  if (namespace === undefined) {
    return null;
  }
  return {
    probeNow: (profile: ProbeProfile) => namespace.getByName(`p:${build}:${profile}:${nonce()}`).probeNow(profile),
  } satisfies MediaProcessorClient;
}
