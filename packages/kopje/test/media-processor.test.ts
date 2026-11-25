import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { run } from "../cli/lib/main.js";
import { createApp } from "../src/app/app";
import { PROBE_FIXTURE_BASE64 } from "../src/media-probe-fixture";
import {
  AV_OUTPUT_LIMIT,
  CLEANUP_RETRY_MS,
  DESTROY_MS,
  normalize,
  PROBE_MS,
  type ProbeDeps,
  processorClient,
  ProcessorUnit,
  STILL_CALL_MS,
  STILL_TEARDOWN_MS,
  type UnitState,
} from "../src/media-processor";
import {
  PROBE_PROFILES,
  type ProbeProfile,
  type StillMaker,
  TranscoderUnavailable,
  type UploadProcessor,
} from "../src/platform/media-transcoder";
import { accessToken, adminClaims, adminTeam, serviceClaims, setTeamAccess } from "./access-helpers";
import { NOW } from "./app-helpers";
import { avFixture, verifyBytes } from "./av-helpers";
import { BUILD, deferred, migratedStore } from "./helpers";
import { TestCodec } from "./media-helpers";
import { stillPng } from "./media-job-helpers";
import { gate, type GATES } from "./media-processing-helpers";
import { memoryIO } from "./ops-helpers";

type Handler = (request: Request) => Response | Promise<Response>;

// A container as ctx.container presents it, its port answering through `handler`. It records what the probe did.
function fakeContainer(
  handler: Handler,
  options: {
    destroy?: () => Promise<void>;
    image?: string | null;
    inspect?: () => Promise<ContainerInfo | null>;
    onStart?: () => void;
  } = {},
) {
  const calls: string[] = [];
  const bodies: Uint8Array[] = [];
  let running = false;
  let started: ContainerStartupOptions | undefined;
  let generation = 0;
  const image = options.image === undefined ? "registry.cloudflare.com/acct/media@sha256:abc" : options.image;
  const container = {
    get running() {
      return running;
    },
    images: image === null ? {} : { media: image },
    start(startup: ContainerStartupOptions) {
      options.onStart?.();
      calls.push("start");
      started = startup;
      running = true;
      generation++;
    },
    // A destroy stops the container it was called for, not one started while its reply was on the way.
    async destroy() {
      calls.push("destroy");
      const of = generation;
      await (options.destroy ?? (async () => {}))();
      if (of === generation) {
        running = false;
      }
    },
    stop() {
      running = false;
    },
    inspect() {
      return options.inspect?.() ?? Promise.resolve({ image: `${image}-running`, labels: {} });
    },
    getTcpPort(port: number) {
      expect(port).toBe(8080);
      return {
        fetch: async (input: string, init?: RequestInit) => {
          const request = new Request(input, init);
          calls.push(`${request.method} ${new URL(request.url).pathname}${new URL(request.url).search}`);
          if (request.method === "POST") {
            bodies.push(new Uint8Array(await request.arrayBuffer()));
          }
          return handler(request);
        },
      };
    },
  };
  return {
    container: container as unknown as Container,
    calls,
    bodies,
    started: () => started,
    // The container stops (as it does while a destroy's reply is still on its way).
    stop: () => container.stop(),
  };
}

// The probe route never makes a still.
const unusedStills: StillMaker = {
  still: () => Promise.reject(new Error("unused")),
  probe: () => Promise.reject(new Error("unused")),
  probeInput: new Uint8Array(),
};

// The probe route of still@standard-1 never runs an upload or the activation probe.
const unusedUploads: UploadProcessor = {
  run: () => Promise.reject(new Error("unused")),
  probeNormalize: () => Promise.reject(new Error("unused")),
  probeInput: new Uint8Array(),
};

const MP4 = new Uint8Array(1000).fill(7);
const PNG = new Uint8Array(300).fill(9);

// A genuine normalize answer (a verified MP4, its declared duration, a still verifyStill passes), which the activation
// probe passes; and the key of its input's copy in the media bucket.
const GENUINE: { mp4: Uint8Array; durationMs: string; still: Uint8Array } = {
  mp4: new Uint8Array(),
  durationMs: "",
  still: new Uint8Array(),
};
const PROBE_KEY = `incoming/probe-${"a".repeat(32)}`;
beforeAll(async () => {
  GENUINE.mp4 = await avFixture("r1-av.mp4");
  const verdict = await verifyBytes("video/mp4", GENUINE.mp4);
  if (!verdict.ok) {
    throw new Error("fixture refused");
  }
  GENUINE.durationMs = String(Math.round(verdict.facts.duration * 1000));
  GENUINE.still = await stillPng();
  await env.MEDIA.put(
    PROBE_KEY,
    Uint8Array.from(atob(PROBE_FIXTURE_BASE64), (c) => c.charCodeAt(0)),
  );
});

function genuine(): Response {
  return ok(GENUINE.mp4, "video/mp4", {
    "kopje-kind": "video",
    "kopje-still": "true",
    "kopje-duration-ms": GENUINE.durationMs,
  });
}

function ok(body: Uint8Array, type: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    headers: { "content-type": type, "content-length": String(body.byteLength), ...headers },
  });
}

// The container server as container/server/main.go answers: healthz, normalize (with a still) and still.
function server(overrides: Partial<Record<string, Handler>> = {}): Handler {
  const routes: Record<string, Handler> = {
    "/healthz": () => Response.json({ ok: true }),
    "/normalize": () => genuine(),
    "/normalize/still": () => ok(GENUINE.still, "image/png"),
    "/still": () => ok(PNG, "image/png", { "kopje-encode-ms": "40" }),
    ...overrides,
  };
  return (request) => {
    const route = routes[new URL(request.url).pathname];
    return route === undefined ? new Response(null, { status: 404 }) : route(request);
  };
}

// A virtual clock: pending waits fire in the order of their due times, the earliest each time the test has been idle
// for a few real milliseconds. So a call that settles at once wins its race against a deadline, one that never settles
// loses it, and a short poll fires before a long deadline.
function clock() {
  let t = 1_000_000;
  const pending: { due: number; resolve: () => void }[] = [];
  let pumping = false;
  const pump = () => {
    pumping = true;
    setTimeout(() => {
      pending.sort((a, b) => a.due - b.due);
      const next = pending.shift();
      if (next !== undefined) {
        t = Math.max(t, next.due);
        next.resolve();
      }
      if (pending.length > 0) {
        pump();
      } else {
        pumping = false;
      }
    }, 10);
  };
  return {
    now: () => t,
    wait: (ms: number) =>
      new Promise<void>((resolve) => {
        pending.push({ due: t + ms, resolve });
        if (!pumping) {
          pump();
        }
      }),
  };
}

function fixtureBytes(): Uint8Array {
  return Uint8Array.from(atob(PROBE_FIXTURE_BASE64), (c) => c.charCodeAt(0));
}

// The normalize adapter (#1828 PR4 plan, section 3 "PR4-2"): the work deadline protocol and the answer's contract.
describe("normalize adapter", () => {
  const input = (bytes: Uint8Array) => ({
    body: new Response(bytes).body as ReadableStream<Uint8Array>,
    size: bytes.byteLength,
  });
  const job = (bytes = fixtureBytes()) => ({ input: input(bytes), workMs: 41_000, stillMs: 1_000 });
  const video = (headers: Record<string, string> = {}) =>
    ok(MP4, "video/mp4", { "kopje-kind": "video", "kopje-still": "true", "kopje-duration-ms": "2000", ...headers });
  const failure = (status: number, code: string) =>
    new Response(`{"error":"${code}"}`, {
      status,
      headers: { "kopje-error": code, "content-type": "application/json" },
    });

  it("posts the input with its length and the work deadline, and reads the declared duration in seconds", async () => {
    const fake = fakeContainer(server({ "/normalize": () => video() }));
    fake.container.start({ enableInternet: false });
    const result = await normalize(fake.container.getTcpPort(8080), job());
    if (!result.ok) {
      throw new Error("refused");
    }
    expect(result).toMatchObject({ kind: "video", type: "video/mp4", length: MP4.byteLength, duration: 2 });
    expect(new Uint8Array(await new Response(result.file).arrayBuffer())).toEqual(MP4);
    expect(await result.still()).toEqual(GENUINE.still);
    expect(fake.calls).toEqual(["start", "POST /normalize?work_ms=41000&still_ms=1000", "GET /normalize/still"]);
    expect(fake.bodies).toEqual([fixtureBytes()]);
  });

  it("answers no still for audio without asking, and none for a video the container made none for", async () => {
    const audio = fakeContainer(
      server({ "/normalize": () => ok(MP4, "audio/mpeg", { "kopje-kind": "audio", "kopje-duration-ms": "1500" }) }),
    );
    const heard = await normalize(audio.container.getTcpPort(8080), job());
    expect(heard).toMatchObject({ ok: true, kind: "audio", duration: 1.5 });
    expect(heard.ok && (await heard.still())).toBeNull();
    expect(audio.calls).toEqual(["POST /normalize?work_ms=41000&still_ms=1000"]);
    const none = fakeContainer(
      server({ "/normalize": () => video(), "/normalize/still": () => failure(404, "no_still") }),
    );
    const seen = await normalize(none.container.getTcpPort(8080), job());
    expect(seen.ok && (await seen.still())).toBeNull();
    const unmade = fakeContainer(server({ "/normalize": () => video({ "kopje-still": "false" }) }));
    const unseen = await normalize(unmade.container.getTcpPort(8080), job());
    expect(unseen.ok && (await unseen.still())).toBeNull();
    expect(unmade.calls).toEqual(["POST /normalize?work_ms=41000&still_ms=1000"]);
  });

  it.each([
    [422, "envelope", { outcome: "envelope", code: "envelope" }],
    [422, "pixels", { outcome: "refused", code: "pixels" }],
    [422, "truncated", { outcome: "refused", code: "truncated" }],
    [413, "too_large", { outcome: "refused", code: "too_large" }],
    // A5: a well-formed 500 with a code is the input's outcome.
    [500, "encode_failed", { outcome: "refused", code: "encode_failed" }],
    [500, "output_size", { outcome: "refused", code: "output_size" }],
    [504, "timeout", { outcome: "timeout", code: "timeout" }],
  ])("answers %i %s as the input's outcome", async (status, code, expected) => {
    const fake = fakeContainer(server({ "/normalize": () => failure(status, code) }));
    expect(await normalize(fake.container.getTcpPort(8080), job())).toEqual({ ok: false, stages: {}, ...expected });
  });

  it.each([
    [500, "internal"],
    [429, "busy"],
    [400, "bad_request"],
    [408, "input_timeout"],
    [404, "not_found"],
    [422, "no_frame"],
    [413, "pixels"],
    [500, "not a code"],
  ])("throws TranscoderUnavailable for %i %s, which says nothing of the input", async (status, code) => {
    const fake = fakeContainer(server({ "/normalize": () => failure(status, code) }));
    const thrown = await normalize(fake.container.getTcpPort(8080), job()).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(TranscoderUnavailable);
    expect((thrown as TranscoderUnavailable).reason).not.toContain("error");
  });

  it.each([
    ["no declared duration", video({ "kopje-duration-ms": "" })],
    ["a duration that is not whole milliseconds", video({ "kopje-duration-ms": "2.5" })],
    ["a zero duration", video({ "kopje-duration-ms": "0" })],
    ["a kind that is not the type's", video({ "kopje-kind": "audio" })],
    ["a video without its still flag", ok(MP4, "video/mp4", { "kopje-kind": "video", "kopje-duration-ms": "2000" })],
    ["an output past AV_OUTPUT_LIMIT", video({ "content-length": String(AV_OUTPUT_LIMIT + 1) })],
  ])("throws TranscoderUnavailable for a 200 with %s (the contract)", async (_name, response) => {
    const fake = fakeContainer(server({ "/normalize": () => response }));
    await expect(normalize(fake.container.getTcpPort(8080), job())).rejects.toBeInstanceOf(TranscoderUnavailable);
  });

  it("throws TranscoderUnavailable for a connection that fails and for a still the server cannot give", async () => {
    const broken = {
      fetch: () => Promise.reject(new Error("network connection lost")),
    } as unknown as Fetcher;
    await expect(normalize(broken, job())).rejects.toBeInstanceOf(TranscoderUnavailable);
    const fake = fakeContainer(
      server({ "/normalize": () => video(), "/normalize/still": () => failure(500, "internal") }),
    );
    const result = await normalize(fake.container.getTcpPort(8080), job());
    await expect(result.ok && result.still()).rejects.toBeInstanceOf(TranscoderUnavailable);
  });
});

// A Durable Object state with the parts MediaProcessor uses. `setAlarm` fails on the calls numbered in `failAlarmOn`
// (from 1); `sync` waits for `sync()` when given (a delayed commit). `fire` runs the alarm as the runtime does: the
// alarm is consumed, and stays set only if the handler sets it again.
function fakeState(
  container: Container | undefined,
  options: {
    failAlarmOn?: number[];
    failDeleteAll?: boolean;
    sync?: () => Promise<void>;
    deleteAll?: () => Promise<void>;
    // The removal takes effect at once and answers once this settles (an ordered write whose reply is late).
    deleteAllAnswers?: () => Promise<void>;
    // setAlarm never answers while this is true.
    holdAlarm?: () => boolean;
  } = {},
) {
  let alarm: number | null = null;
  let alarms = 0;
  // deleteAll() calls: the object's storage removed.
  let cleared = 0;
  const storage = {
    setAlarm: (at: number) => {
      if (options.holdAlarm?.() === true) {
        return new Promise<void>(() => {});
      }
      alarms++;
      if (options.failAlarmOn?.includes(alarms) === true) {
        return Promise.reject(new Error("storage unavailable"));
      }
      alarm = at;
      return Promise.resolve();
    },
    // Removes the alarm too, in the same step (compatibility date 2026-02-24 and later).
    deleteAll: async () => {
      if (options.failDeleteAll === true) {
        throw new Error("storage unavailable");
      }
      await options.deleteAll?.();
      cleared++;
      alarm = null;
      await options.deleteAllAnswers?.();
    },
    // Not part of what the unit uses (UnitState): here for a test that would call it.
    deleteAlarm: () => Promise.resolve(void (alarm = null)),
    sync: () => options.sync?.() ?? Promise.resolve(),
  };
  return {
    ctx: { container, storage, bucket: env.MEDIA, images: new TestCodec() } as UnitState,
    alarm: () => alarm,
    cleared: () => cleared,
    fire: async (object: ProcessorUnit) => {
      alarm = null;
      await object.alarm();
    },
  };
}

// The unit as MediaProcessor's constructor makes it, and what probe() reads of it.
const units = new WeakMap<ProcessorUnit, { container: Container | undefined; now: () => number }>();
function unit(state: UnitState, deps?: ProbeDeps): ProcessorUnit {
  const made = new ProcessorUnit(state, deps);
  units.set(made, { container: state.container, now: deps?.now ?? (() => Date.now()) });
  made.start();
  return made;
}

// The activation probe on the unit (probeNormalize) of the clip's copy at PROBE_KEY, as the single-owner rule's tests
// read it: whether it passed, why not, whether its container no longer runs, and its wall time on the unit's clock.
async function probe(object: ProcessorUnit) {
  const { container, now } = units.get(object)!;
  const begun = now();
  const verdict = await object.probeNormalize(PROBE_KEY);
  return {
    ok: verdict.outcome === "pass",
    failure: verdict.outcome === "pass" ? null : verdict.reason,
    destroyed: container?.running !== true,
    wallMs: now() - begun,
  };
}

// A container whose destroy runs `destroy` (default: succeeds), counting its starts.
function counted(destroy?: () => Promise<void>, overrides: Partial<Record<string, Handler>> = {}) {
  let starts = 0;
  const fake = fakeContainer(server(overrides), {
    ...(destroy === undefined ? {} : { destroy }),
    onStart: () => void starts++,
  });
  return { ...fake, starts: () => starts };
}

// A container whose destroy fails while `failing()` is true.
function flaky(failing: () => boolean, overrides: Partial<Record<string, Handler>> = {}) {
  return counted(() => (failing() ? Promise.reject(new Error("destroy failed")) : Promise.resolve()), overrides);
}

// A clock whose timers never fire, at a time the test sets.
function frozen(at: number): { t: number; deps: ProbeDeps } {
  const time: { t: number; deps: ProbeDeps } = {
    t: at,
    deps: { now: () => time.t, wait: () => new Promise<void>(() => {}) },
  };
  return time;
}

describe("MediaProcessor", () => {
  it("answers no-container when the class runs without a container", async () => {
    const state = fakeState(undefined);
    const report = await probe(unit(state.ctx));
    expect(report).toMatchObject({ ok: false, failure: "no-container" });
  });

  it("leaves no alarm after a probe whose container was destroyed", async () => {
    const fake = fakeContainer(server());
    const state = fakeState(fake.container);
    const report = await probe(unit(state.ctx));
    expect(report.ok).toBe(true);
    expect(state.alarm()).toBeNull();
  });

  // One deadline from before the start ends every stage; the alarm, set before the start, is past it and the
  // destroy's bound.
  it("sets the alarm past the probe's deadline and destroy before the start, and ends the stages at the deadline", async () => {
    const time = clock();
    let atStart: number | null = null;
    const fake = fakeContainer(server({ "/normalize": () => new Promise<Response>(() => {}) }), {
      onStart: () => (atStart = state.alarm()),
    });
    const state = fakeState(fake.container);
    const begun = time.now();
    const report = await probe(unit(state.ctx, time));
    expect(atStart).toBe(begun + PROBE_MS + DESTROY_MS);
    expect(report).toMatchObject({ ok: false, failure: "operation-deadline", destroyed: true });
    expect(report.wallMs).toBe(PROBE_MS);
    expect(state.alarm()).toBeNull();
  });

  // A commit confirmed only later: the container starts after it, and not at all when it fails.
  it("starts the container only after the alarm's write is confirmed", async () => {
    let confirm: (ok: boolean) => void = () => {};
    const fake = counted();
    const state = fakeState(fake.container, {
      sync: () =>
        new Promise<void>((resolve, reject) => (confirm = (ok) => (ok ? resolve() : reject(new Error("commit"))))),
    });
    const object = unit(state.ctx);
    const pending = probe(object);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.starts()).toBe(0);
    confirm(true);
    expect((await pending).ok).toBe(true);
    expect(fake.starts()).toBe(1);

    const failed = probe(object);
    await new Promise((resolve) => setTimeout(resolve, 20));
    confirm(false);
    expect(await failed).toMatchObject({ ok: false, failure: "storage", destroyed: true });
    expect(fake.starts()).toBe(1);
    const retried = probe(object);
    await new Promise((resolve) => setTimeout(resolve, 20));
    confirm(true);
    expect((await retried).ok).toBe(true);
  });

  // The review's schedule: an alarm arrives while probe B awaits its commit. It changes nothing of B's: B's container
  // keeps its alarm, which comes after B's bound.
  it("leaves a probe in flight alone when an alarm arrives during its commit", async () => {
    const time = frozen(9_000_000);
    let confirm = () => {};
    let atStart: number | null = null;
    const fake = fakeContainer(server(), { onStart: () => (atStart = state.alarm()) });
    const state = fakeState(fake.container, { sync: () => new Promise<void>((resolve) => (confirm = resolve)) });
    const object = unit(state.ctx, time.deps);
    const b = probe(object);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await state.fire(object);
    expect(fake.calls).toEqual([]);
    expect(state.alarm()).toBe(9_000_000 + PROBE_MS + DESTROY_MS);
    confirm();
    expect((await b).ok).toBe(true);
    expect(atStart).toBe(9_000_000 + PROBE_MS + DESTROY_MS);
  });

  // A commit held past the probe's deadline: the alarms meanwhile re-arm, and once it settles nothing is started.
  it("starts nothing when the alarm's commit settles past the deadline", async () => {
    const time = frozen(9_000_000);
    let confirm = () => {};
    const fake = counted();
    const state = fakeState(fake.container, { sync: () => new Promise<void>((resolve) => (confirm = resolve)) });
    const object = unit(state.ctx, time.deps);
    const held = probe(object);
    await new Promise((resolve) => setTimeout(resolve, 20));
    time.t += PROBE_MS + DESTROY_MS;
    await state.fire(object);
    expect(await probe(object)).toMatchObject({ ok: false, failure: "busy" });
    time.t += 1;
    confirm();
    expect(await held).toMatchObject({ ok: false, failure: "storage-late", destroyed: true });
    expect(fake.starts()).toBe(0);
    // The next probe runs as usual.
    const next = probe(object);
    await new Promise((resolve) => setTimeout(resolve, 20));
    confirm();
    expect((await next).ok).toBe(true);
    expect(fake.starts()).toBe(1);
  });

  // An output that settles at the deadline, before the deadline's timer runs, is refused; one just before it is not.
  it("refuses an output that arrives at the deadline", async () => {
    for (const [late, atDeadline] of [
      [0, true],
      [-1, false],
    ] as const) {
      const time = frozen(5_000_000);
      const fake = fakeContainer(
        server({
          "/normalize": () => {
            time.t = 5_000_000 + PROBE_MS + late;
            return genuine();
          },
        }),
      );
      const report = await probe(unit(fakeState(fake.container).ctx, time.deps));
      // Just before the deadline the output is taken, and Images, left 1 ms, runs out of time.
      expect(report.failure, `late by ${late}`).toBe(atDeadline ? "operation-deadline" : "timeout");
      expect(report.destroyed).toBe(true);
    }
  });

  // Two calls in the same turn: the flag is set before any await, so the second is busy.
  it("answers busy to a second call made in the same turn", async () => {
    const fake = counted();
    const object = unit(fakeState(fake.container).ctx);
    const [first, second] = await Promise.all([probe(object), probe(object)]);
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ failure: "busy" });
    expect(fake.starts()).toBe(1);
  });

  it("starts one container for concurrent probes of its profile, and the next probe after it starts cleanly", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const fake = counted(undefined, {
      "/normalize": async () => {
        await held;
        return genuine();
      },
    });
    const object = unit(fakeState(fake.container).ctx);
    const first = probe(object);
    await vi.waitFor(() => expect(fake.starts()).toBe(1));
    expect(await probe(object)).toMatchObject({ ok: false, failure: "busy" });
    release();
    expect((await first).ok).toBe(true);
    expect(fake.starts()).toBe(1);
    expect((await probe(object)).ok).toBe(true);
    expect(fake.starts()).toBe(2);
  });

  // However long the destroy keeps failing, the object's one container is the only one: every probe meanwhile is busy.
  it("starts no second container while an orphan runs, and probes again once the alarm destroyed it", async () => {
    let failing = true;
    const fake = flaky(() => failing);
    const state = fakeState(fake.container);
    const object = unit(state.ctx);
    const before = Date.now();
    // The probe's own stop failed: no verdict, the container left to the alarm.
    expect(await probe(object)).toMatchObject({ failure: "destroy", destroyed: false });
    expect(state.alarm()).toBeGreaterThanOrEqual(before + CLEANUP_RETRY_MS);
    for (let i = 0; i < 10; i++) {
      await state.fire(object);
      // The alarm that failed set itself again.
      expect(state.alarm()).not.toBeNull();
      expect(await probe(object)).toMatchObject({ failure: "busy", destroyed: false });
    }
    expect(fake.starts()).toBe(1);
    expect(fake.container.running).toBe(true);
    expect(state.alarm()).not.toBeNull();

    expect(state.cleared()).toBe(0);
    failing = false;
    await state.fire(object);
    expect(fake.container.running).toBe(false);
    // The orphan is gone: the object's storage goes with it.
    expect(state.cleared()).toBe(1);
    expect((await probe(object)).ok).toBe(true);
    expect(fake.starts()).toBe(2);
  });

  // The alarm's destroy: the container stops at once and the reply comes later. A probe meanwhile is busy, so no
  // container starts that the late reply could meet.
  it("answers busy while the alarm is still destroying an orphan", async () => {
    let failing = true;
    let reply = () => {};
    let deferred = true;
    const time = frozen(7_000_000);
    const fake = fakeContainer(server(), {
      destroy: () => {
        if (failing) {
          return Promise.reject(new Error("destroy failed"));
        }
        fake.stop();
        if (deferred) {
          deferred = false;
          return new Promise<void>((resolve) => (reply = resolve));
        }
        return Promise.resolve();
      },
    });
    const state = fakeState(fake.container);
    const object = unit(state.ctx, time.deps);
    expect((await probe(object)).destroyed).toBe(false);
    failing = false;
    const alarming = state.fire(object);
    await vi.waitFor(() => expect(fake.container.running).toBe(false));
    expect(await probe(object)).toMatchObject({ failure: "busy" });
    reply();
    await alarming;
    expect((await probe(object)).ok).toBe(true);
  });

  // A destroy that never settles counts as failed after DESTROY_MS: the probe answers, and the alarm owns the rest.
  it("bounds a stalled destroy, and the alarm destroys the orphan once it can", async () => {
    let stalled = true;
    const time = clock();
    const fake = counted(() => (stalled ? new Promise<void>(() => {}) : Promise.resolve()));
    const state = fakeState(fake.container);
    const object = unit(state.ctx, time);
    const report = await probe(object);
    expect(report).toMatchObject({ ok: false, destroyed: false });
    expect(report.wallMs).toBeGreaterThanOrEqual(DESTROY_MS);
    expect(await probe(object)).toMatchObject({ failure: "busy", destroyed: false });
    await state.fire(object);
    expect(fake.container.running).toBe(true);
    stalled = false;
    await state.fire(object);
    expect(fake.container.running).toBe(false);
    expect((await probe(object)).ok).toBe(true);
    expect(fake.starts()).toBe(2);
  });

  it("keeps the alarm set before the start when destroy throws and the sooner retry cannot be written", async () => {
    const time = clock();
    const fake = flaky(() => true);
    const state = fakeState(fake.container, { failAlarmOn: [2] });
    const begun = time.now();
    const report = await probe(unit(state.ctx, time));
    expect(report.destroyed).toBe(false);
    expect(fake.container.running).toBe(true);
    expect(state.alarm()).toBe(begun + PROBE_MS + DESTROY_MS);
  });

  // A storage write that fails leaves no busy profile behind: an immediate retry starts cleanly.
  it("starts nothing when the alarm cannot be stored, and a retry right after starts cleanly", async () => {
    const fake = flaky(() => false);
    const state = fakeState(fake.container, { failAlarmOn: [1] });
    const object = unit(state.ctx);
    expect(await probe(object)).toMatchObject({ ok: false, failure: "storage", destroyed: true });
    expect(fake.starts()).toBe(0);
    expect((await probe(object)).ok).toBe(true);
    expect(fake.starts()).toBe(1);
  });

  // An alarm left after a confirmed teardown finds nothing to destroy; the next probe starts at once.
  it("starts the next probe at once when the storage cannot be removed after a teardown", async () => {
    const fake = flaky(() => false);
    const state = fakeState(fake.container, { failDeleteAll: true });
    const object = unit(state.ctx);
    expect(await probe(object)).toMatchObject({ ok: true, destroyed: true });
    expect(state.alarm()).not.toBeNull();
    await state.fire(object);
    expect(fake.calls.filter((c) => c === "destroy")).toHaveLength(1);
    expect((await probe(object)).ok).toBe(true);
    expect(fake.starts()).toBe(2);
  });

  // The constructor holds no gate: it sets the alarm for now, and the alarm destroys the orphan, however long a
  // destroy takes.
  it("leaves an orphan it finds at construction to the alarm, set for now", async () => {
    let stalled = true;
    const time = clock();
    const fake = counted(() => (stalled ? new Promise<void>(() => {}) : Promise.resolve()));
    fake.container.start({ image: "x" });
    const state = fakeState(fake.container);
    const object = unit(state.ctx, time);
    await vi.waitFor(() => expect(state.alarm()).toBe(time.now()));
    expect(fake.calls).toEqual(["start"]);
    expect(await probe(object)).toMatchObject({ failure: "busy", destroyed: false });
    await state.fire(object);
    expect(fake.container.running).toBe(true);
    stalled = false;
    await state.fire(object);
    expect(fake.container.running).toBe(false);
    expect((await probe(object)).ok).toBe(true);
  });
});

describe("MediaProcessor stillNow (#1828 design 4.5, 4.6, 4.16)", () => {
  // The media bucket with its reads counted.
  function bucket() {
    const reads: string[] = [];
    return {
      reads,
      get: async (key: string) => {
        reads.push(key);
        return env.MEDIA.get(key);
      },
    };
  }

  it("streams its one input key into /still on standard-1 without Internet, and answers the PNG once destroyed", async () => {
    const input = new Uint8Array(5000).fill(3);
    await env.MEDIA.put("originals/140000000000000001", input);
    const fake = counted();
    const media = bucket();
    const state = fakeState(fake.container);
    const object = unit({ ...state.ctx, bucket: media });
    const outcome = await object.stillNow("originals/140000000000000001", 75_000);
    expect(outcome).toEqual({ ok: true, png: PNG, image: "registry.cloudflare.com/acct/media@sha256:abc-running" });
    expect(media.reads).toEqual(["originals/140000000000000001"]);
    expect(fake.bodies).toEqual([input]);
    expect(fake.started()).toMatchObject({ instance: "standard-1", enableInternet: false });
    expect(fake.calls).toEqual(["start", "GET /healthz", "POST /still", "destroy"]);
    expect(fake.container.running).toBe(false);
    expect(state.alarm()).toBeNull();
    // Its storage goes too, so a fresh rb: object leaves nothing billed behind.
    expect(state.cleared()).toBe(1);
  });

  it.each([
    [422, "no_video", "no_video"],
    [422, "pixels", "pixels"],
    [422, "no_frame", "no_frame"],
    [500, "internal", undefined],
    [413, "too_large", "too_large"],
    [504, "timeout", undefined],
    [500, "no_video", undefined],
    [422, "still_failed", undefined],
  ] as const)("types a %i %s answer as a refusal of the input only when it is one", async (status, code, refused) => {
    await env.MEDIA.put("originals/140000000000000031", new Uint8Array([1]));
    const fake = counted(undefined, {
      "/still": () => new Response(null, { status, headers: { "kopje-error": code } }),
    });
    const object = unit({ ...fakeState(fake.container).ctx, bucket: bucket() });
    const outcome = await object.stillNow("originals/140000000000000031", 75_000);
    expect(outcome).toEqual({
      ok: false,
      failure: `still:${code}`,
      image: expect.any(String) as string,
      ...(refused === undefined ? {} : { input: refused }),
    });
  });

  it("is not ok when the PNG arrives past the operation's end, which keeps time for the destroy", async () => {
    await env.MEDIA.put("originals/140000000000000011", new Uint8Array([1]));
    const time = frozen(1_000_000);
    const fake = counted(undefined, {
      "/still": () => {
        time.t = 1_000_000 + 60_000 - STILL_TEARDOWN_MS;
        return ok(PNG, "image/png");
      },
    });
    const outcome = await unit({ ...fakeState(fake.container).ctx, bucket: bucket() }, time.deps).stillNow(
      "originals/140000000000000011",
      60_000,
    );
    expect(outcome).toMatchObject({ ok: false, failure: "operation-deadline" });
    expect(fake.calls.at(-1)).toBe("destroy");
  });

  it("reports its teardown pending when the destroy ends past the call's deadline, and its alarm removes the storage", async () => {
    await env.MEDIA.put("originals/140000000000000012", new Uint8Array([1]));
    const time = frozen(1_000_000);
    const fake = counted(() => {
      time.t = 1_000_000 + 60_000 + 1;
      return Promise.resolve();
    });
    const state = fakeState(fake.container);
    const object = unit({ ...state.ctx, bucket: bucket() }, time.deps);
    expect(await object.stillNow("originals/140000000000000012", 60_000)).toMatchObject({
      ok: false,
      failure: "destroy",
      pending: true,
    });
    expect(state.alarm()).not.toBeNull();
    expect(state.cleared()).toBe(0);
    // The destroy finished after the answer: no container runs when the alarm comes.
    expect(fake.container.running).toBe(false);
    await state.fire(object);
    expect(state.cleared()).toBe(1);
    expect(state.alarm()).toBeNull();
  });

  it("is not ok when removing its storage ends past the call's deadline", async () => {
    await env.MEDIA.put("originals/140000000000000021", new Uint8Array([1]));
    const time = frozen(1_000_000);
    const state = fakeState(counted().container, {
      deleteAll: () => {
        time.t = 1_000_000 + 60_000 + 1;
        return Promise.resolve();
      },
    });
    const outcome = await unit({ ...state.ctx, bucket: bucket() }, time.deps).stillNow(
      "originals/140000000000000021",
      60_000,
    );
    expect(outcome).toMatchObject({ ok: false, failure: "late" });
  });

  it("answers by its deadline when removing its storage stalls, and the alarm removes it later", async () => {
    await env.MEDIA.put("originals/140000000000000022", new Uint8Array([1]));
    const time = clock();
    let stalled = true;
    const state = fakeState(counted().container, {
      deleteAll: () => (stalled ? new Promise<void>(() => {}) : Promise.resolve()),
    });
    const object = unit({ ...state.ctx, bucket: bucket() }, time);
    const outcome = await object.stillNow("originals/140000000000000022", 60_000);
    expect(outcome).toMatchObject({ ok: false, failure: "late" });
    // The alarm is kept: it is removed only after the storage.
    expect(state.alarm()).not.toBeNull();
    stalled = false;
    await state.fire(object);
    expect(state.cleared()).toBe(1);
    expect(state.alarm()).toBeNull();
  });

  it("answers busy by its deadline when it finds an orphan and setting the alarm does not answer", async () => {
    const time = clock();
    const fake = counted();
    const state = fakeState(fake.container, { holdAlarm: () => true });
    const object = unit({ ...state.ctx, bucket: bucket() }, time);
    // A container left running by an earlier instance.
    fake.container.start({ image: "x", instance: "standard-1", enableInternet: false });
    expect(await object.stillNow("originals/140000000000000024", 60_000)).toMatchObject({
      ok: false,
      failure: "busy",
    });
  });

  it("removes the storage and the alarm in one step, so a late reply cannot remove the next call's alarm", async () => {
    await env.MEDIA.put("originals/140000000000000025", new Uint8Array([1]));
    let answer = () => {};
    let late = true;
    const time = clock();
    let gate: Promise<void> = Promise.resolve();
    const fake = counted(undefined, {
      "/still": async () => {
        await gate;
        return ok(PNG, "image/png");
      },
    });
    const state = fakeState(fake.container, {
      deleteAllAnswers: () =>
        late
          ? new Promise<void>((resolve) => {
              late = false;
              answer = resolve;
            })
          : Promise.resolve(),
    });
    const object = unit({ ...state.ctx, bucket: bucket() }, time);
    // The first still's removal took effect, but its reply comes after the call answered.
    expect(await object.stillNow("originals/140000000000000025", 60_000)).toMatchObject({ failure: "late" });
    const next = deferred();
    gate = next.promise;
    const second = object.stillNow("originals/140000000000000025", 60_000);
    await vi.waitFor(() => expect(state.alarm()).not.toBeNull());
    answer();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The second call's alarm stands while it runs.
    expect(state.alarm()).not.toBeNull();
    next.resolve();
    await second;
  });

  it("cancels a read of its input that answers past the operation's end, and gives the container nothing", async () => {
    await env.MEDIA.put("originals/140000000000000013", new Uint8Array([1, 2, 3]));
    const time = frozen(1_000_000);
    let cancelled = false;
    const late = {
      get: async () => {
        await Promise.resolve();
        time.t = 1_000_000 + 60_000 - STILL_TEARDOWN_MS;
        const body = new ReadableStream<Uint8Array>({
          pull: () => {},
          cancel: () => {
            cancelled = true;
          },
        });
        return { size: 3, body } as unknown as R2ObjectBody;
      },
    };
    const fake = counted();
    const outcome = await unit({ ...fakeState(fake.container).ctx, bucket: late }, time.deps).stillNow(
      "originals/140000000000000013",
      60_000,
    );
    expect(outcome).toMatchObject({ ok: false, failure: "operation-deadline" });
    expect(cancelled).toBe(true);
    expect(fake.calls).not.toContain("POST /still");
    expect(fake.calls.at(-1)).toBe("destroy");
  });

  it("starts nothing when the alarm's commit does not settle within the call's deadline", async () => {
    const time = clock();
    const fake = counted();
    const state = fakeState(fake.container, { sync: () => new Promise<void>(() => {}) });
    const outcome = await unit({ ...state.ctx, bucket: bucket() }, time).stillNow(
      "originals/140000000000000014",
      60_000,
    );
    expect(outcome).toMatchObject({ ok: false, failure: "storage-late" });
    expect(fake.starts()).toBe(0);
  });

  it("answers input-missing for a key the bucket lacks, and destroys the container", async () => {
    const fake = counted();
    const object = unit({ ...fakeState(fake.container).ctx, bucket: bucket() });
    expect(await object.stillNow("originals/140000000000000002", 75_000)).toMatchObject({
      ok: false,
      failure: "input-missing",
    });
    expect(fake.calls.at(-1)).toBe("destroy");
    expect(fake.container.running).toBe(false);
  });

  it("is busy while a probe runs on its object, and the probe is busy while a still runs: one container", async () => {
    await env.MEDIA.put("incoming/probe-0123456789abcdef0123456789abcdef", new Uint8Array([1, 2, 3]));
    const held = deferred();
    const fake = counted(undefined, {
      "/still": async () => {
        await held.promise;
        return ok(PNG, "image/png");
      },
    });
    const object = unit({ ...fakeState(fake.container).ctx, bucket: bucket() });
    const first = object.stillNow("incoming/probe-0123456789abcdef0123456789abcdef", 60_000);
    await vi.waitFor(() => expect(fake.starts()).toBe(1));
    expect(await probe(object)).toMatchObject({ ok: false, failure: "busy" });
    expect(await object.stillNow("incoming/probe-0123456789abcdef0123456789abcdef", 60_000)).toMatchObject({
      ok: false,
      failure: "busy",
    });
    held.resolve();
    expect((await first).ok).toBe(true);
    expect(fake.starts()).toBe(1);
  });

  it("is not ok when the destroy fails, and leaves the alarm to clean up", async () => {
    await env.MEDIA.put("originals/140000000000000003", new Uint8Array([1]));
    const fake = counted(() => Promise.reject(new Error("destroy failed")));
    const state = fakeState(fake.container);
    const outcome = await unit({ ...state.ctx, bucket: bucket() }).stillNow("originals/140000000000000003", 75_000);
    expect(outcome).toMatchObject({ ok: false, failure: "destroy" });
    expect(state.alarm()).not.toBeNull();
  });

  it("is bounded by STILL_CALL_MS whatever the caller asks", async () => {
    await env.MEDIA.put("originals/140000000000000004", new Uint8Array([1]));
    const time = frozen(1_000_000);
    const state = fakeState(counted().container);
    const alarms: number[] = [];
    const storage = {
      ...state.ctx.storage,
      setAlarm: (at: number) => {
        alarms.push(at);
        return state.ctx.storage.setAlarm(at);
      },
    };
    const object = unit({ container: state.ctx.container, storage, bucket: bucket() }, time.deps);
    await object.stillNow("originals/140000000000000004", 10 * STILL_CALL_MS);
    // The alarm set before the start is the call's bound and the destroy's.
    expect(alarms[0]).toBe(1_000_000 + STILL_CALL_MS + DESTROY_MS);
  });
});

describe("processorClient", () => {
  it("makes rebuild stills on fresh objects and the still probe on the profile's object, and a failed RPC is unavailable", async () => {
    await env.MEDIA.put("originals/140000000000000005", new Uint8Array([1]));
    const names: string[] = [];
    const namespace = {
      getByName(name: string) {
        names.push(name);
        if (name.startsWith("rb:") && names.length > 2) {
          return { stillNow: () => Promise.reject(new Error("object reset")) };
        }
        return unit({ ...fakeState(fakeContainer(server()).container).ctx, bucket: env.MEDIA });
      },
    };
    const client = processorClient({ ...env, MEDIA_PROCESSOR: namespace } as never, "v1")!;
    expect((await client.stills.still("originals/140000000000000005", 75_000)).ok).toBe(true);
    expect((await client.stills.probe("originals/140000000000000005", 60_000)).ok).toBe(true);
    expect(await client.stills.still("originals/140000000000000005", 75_000)).toEqual({
      ok: false,
      failure: "unavailable",
      image: null,
    });
    expect(names[0]).toMatch(/^rb:[0-9a-f-]{36}$/);
    expect(names[1]).toBe("p:v1:still@standard-1");
    expect(names[2]).toMatch(/^rb:/);
    expect(names[2]).not.toBe(names[0]);
    expect(client.stills.probeInput).toEqual(fixtureBytes());
  });

  it("is null without the binding", () => {
    expect("MEDIA_PROCESSOR" in env).toBe(false);
    expect(processorClient(env, "build")).toBeNull();
  });

  it("runs the activation probe on the profile's one object, named for the version and the profile", async () => {
    const names: string[] = [];
    const objects = new Map<string, ProcessorUnit>();
    const namespace = {
      getByName(name: string) {
        names.push(name);
        const object = objects.get(name) ?? unit(fakeState(fakeContainer(server()).container).ctx);
        objects.set(name, object);
        return object;
      },
    };
    const client = processorClient({ ...env, MEDIA_PROCESSOR: namespace } as never, "v1");
    expect((await client?.uploads.probeNormalize(PROBE_KEY))?.outcome).toBe("pass");
    expect((await client?.uploads.probeNormalize(PROBE_KEY))?.outcome).toBe("pass");
    expect(names).toEqual(["p:v1:normalize@standard-4", "p:v1:normalize@standard-4"]);
  });
});

describe("POST /admin/media-processor/probe and kopje-admin media-processor probe", () => {
  // The admin app with this processor (null: no binding), and the CLI's fetch through an Access edge that turns its
  // service token into a JWT.
  // `passes` answers whether the profile's container run passes (null: no binding).
  async function harness(
    passes: ((profile: ProbeProfile) => Promise<boolean>) | null,
    gated: keyof typeof GATES | null = null,
  ) {
    const team = await adminTeam();
    const store = await migratedStore();
    await setTeamAccess(store, team);
    if (gated !== null) {
      await gate(store, gated, true);
    }
    // normalize@standard-4's activation probe, and still@standard-1's still: a PNG verifyStill passes, or one it
    // refuses.
    const uploads: UploadProcessor = {
      ...unusedUploads,
      probeNormalize: async () =>
        (await passes!("normalize@standard-4"))
          ? { outcome: "pass", imagesVerified: true, image: null }
          : { outcome: "fail", reason: "ready", image: null },
    };
    const stills: StillMaker = {
      ...unusedStills,
      probeInput: new Uint8Array([1, 2, 3]),
      probe: async () => ({
        ok: true,
        png: (await passes!("still@standard-1")) ? GENUINE.still : new Uint8Array(10),
        image: null,
      }),
    };
    const app = createApp({
      build: () => BUILD,
      now: () => NOW,
      store: () => store,
      fetch: team.fetch,
      images: () => new TestCodec(),
      mediaProcessor: () => (passes === null ? null : { stills, uploads }),
    });
    const call = (request: Request) => app.fetch(request, env, createExecutionContext());
    const post = async (profile: unknown) =>
      call(
        new Request("https://admin.kopje.test/admin/media-processor/probe", {
          method: "POST",
          body: JSON.stringify({ profile }),
          headers: { "cf-access-jwt-assertion": await accessToken(team, adminClaims()) },
        }),
      );
    const cli = async (argv: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await run({
        argv,
        env: {
          KOPJE_ADMIN_URL: "https://admin.kopje.test",
          CF_ACCESS_CLIENT_ID: "id",
          CF_ACCESS_CLIENT_SECRET: "secret",
        },
        io: memoryIO(),
        stdout: { write: (text: string) => void out.push(text), isTTY: false },
        stderr: { write: (text: string) => void err.push(text), isTTY: false },
        fetch: async (input: string, init?: RequestInit) => {
          const headers = new Headers(init?.headers);
          headers.delete("CF-Access-Client-Id");
          headers.delete("CF-Access-Client-Secret");
          headers.set("Cf-Access-Jwt-Assertion", await accessToken(team, serviceClaims()));
          return call(new Request(input, { ...init, headers }));
        },
        sleep: () => Promise.resolve(),
        platform: "linux",
      });
      return { code, out: out.join(""), err: err.join("") };
    };
    return { post, cli };
  }

  it("refuses an unknown profile, and answers 409 without the binding", async () => {
    const passes = vi.fn(() => Promise.resolve(true));
    const bound = await harness(passes);
    expect((await bound.post("normalize@standard-2")).status).toBe(400);
    expect((await bound.post(undefined)).status).toBe(400);
    expect(passes).not.toHaveBeenCalled();
    const copies = async () => (await env.MEDIA.list({ prefix: "incoming/probe-" })).objects.map((o) => o.key);
    const before = await copies();
    const good = await bound.post("still@standard-1");
    expect(good.status).toBe(200);
    // The still check records nothing, and its copy of the clip is gone.
    expect(await good.json()).toEqual({
      probe: { status: "checked", verdict: { outcome: "pass", imagesVerified: true, image: null } },
    });
    expect(passes).toHaveBeenCalledOnce();
    expect(await copies()).toEqual(before);

    const refused = await (await harness(null)).post("still@standard-1");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "media-processor-unbound" });
  });

  it("probes every profile by default, prints each verdict and exits by the outcome", async () => {
    const seen: ProbeProfile[] = [];
    const all = await harness((profile) => {
      seen.push(profile);
      return Promise.resolve(true);
    });
    const passed = await all.cli(["media-processor", "probe"]);
    expect(passed.code, passed.err).toBe(0);
    // The CLI's list is the Worker's.
    expect(seen).toEqual([...PROBE_PROFILES]);
    expect(passed.out).toContain('"status": "checked"');
    expect(passed.out).toContain('"status": "recorded"');

    const one = await harness((profile) => Promise.resolve(profile !== "normalize@standard-4"));
    expect((await one.cli(["media-processor", "probe", "still@standard-1"])).code).toBe(0);
    expect((await one.cli(["media-processor", "probe", "normalize@standard-4"])).code).toBe(1);
    // A second normalize probe within the hour is not run: no verdict, exit 1.
    const again = await all.cli(["media-processor", "probe", "normalize@standard-4"]);
    expect(again.code).toBe(1);
    expect(again.out).toContain('"status": "cooldown"');
    const still = await harness((profile) => Promise.resolve(profile !== "still@standard-1"));
    const failed = await still.cli(["media-processor", "probe", "still@standard-1"]);
    expect(failed.code).toBe(1);
    expect(failed.out).toContain('"outcome": "fail"');
    // A type P27 did not choose is no profile.
    expect((await one.cli(["media-processor", "probe", "normalize@standard-3"])).code).toBe(2);
    expect((await one.cli(["media-processor", "probe", "normalize@standard-2"])).code).toBe(2);
    expect((await one.cli(["media-processor"])).code).toBe(2);

    const unbound = await (await harness(null)).cli(["media-processor", "probe"]);
    expect(unbound.code).toBe(3);
    expect(unbound.err).toContain("not bound");
  });

  it.each([
    ["maintenance", "normalize@standard-4"],
    ["dump", "normalize@standard-4"],
    ["maintenance", "still@standard-1"],
    ["dump", "still@standard-1"],
  ] as const)(
    "refuses a probe while the Store refuses writes (%s, %s), and the CLI prints the refusal",
    async (gated, profile) => {
      const passes = vi.fn(() => Promise.resolve(true));
      const refused = await harness(passes, gated);
      const answer = await refused.post(profile);
      expect(answer.status).toBe(503);
      expect(await answer.json()).toMatchObject({ code: gated === "maintenance" ? "maintenance" : "dump-in-progress" });
      const printed = await refused.cli(["media-processor", "probe", profile]);
      expect(printed.code).not.toBe(0);
      expect(printed.err).toMatch(gated === "maintenance" ? /maintenance/ : /dump/);
      expect(passes).not.toHaveBeenCalled();
    },
  );
});
