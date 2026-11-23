import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import { run } from "../cli/lib/main.js";
import { createApp } from "../src/app/app";
import { PROBE_FIXTURE_BASE64 } from "../src/media-probe-fixture";
import {
  AV_OUTPUT_LIMIT,
  CLEANUP_RETRY_MS,
  DESTROY_MS,
  PROBE_MS,
  type ProbeDeps,
  processorClient,
  ProcessorUnit,
  READY_MS,
  smokeProbe,
  type UnitState,
} from "../src/media-processor";
import { PROBE_PROFILES, type ProbeProfile, type ProbeReport } from "../src/platform/media-transcoder";
import { accessToken, adminClaims, adminTeam, serviceClaims, setTeamAccess } from "./access-helpers";
import { NOW } from "./app-helpers";
import { BUILD, migratedStore } from "./helpers";
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

const MP4 = new Uint8Array(1000).fill(7);
const PNG = new Uint8Array(300).fill(9);

function ok(body: Uint8Array, type: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    headers: { "content-type": type, "content-length": String(body.byteLength), ...headers },
  });
}

// The container server as container/server/main.go answers: healthz, normalize (with a still) and still.
function server(overrides: Partial<Record<string, Handler>> = {}): Handler {
  const routes: Record<string, Handler> = {
    "/healthz": () => Response.json({ ok: true }),
    "/normalize": () =>
      ok(MP4, "video/mp4", {
        "kopje-kind": "video",
        "kopje-still": "true",
        "kopje-encode-ms": "1200",
        "kopje-probe-ms": "15",
      }),
    "/normalize/still": () => ok(PNG, "image/png"),
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

describe("smoke probe", () => {
  it("runs normalize on the profile's instance type without Internet, streams the fixture and destroys", async () => {
    const fake = fakeContainer(server());
    const report = await smokeProbe(fake.container, "normalize@standard-4", clock());
    expect(report).toMatchObject({
      ok: true,
      failure: null,
      outputBytes: MP4.byteLength,
      stillBytes: PNG.byteLength,
      destroyed: true,
      stages: { encode: 1200, probe: 15 },
      image: {
        configured: "registry.cloudflare.com/acct/media@sha256:abc",
        running: "registry.cloudflare.com/acct/media@sha256:abc-running",
      },
    });
    expect(fake.started()).toMatchObject({ instance: "standard-4", enableInternet: false });
    expect(fake.calls).toEqual([
      "start",
      "GET /healthz",
      "POST /normalize?probe_ms=10000&encode_ms=60000",
      "GET /normalize/still",
      "destroy",
    ]);
    // The input is the packaged fixture, as the request body.
    expect(fake.bodies).toEqual([fixtureBytes()]);
    expect(fake.container.running).toBe(false);
  });

  it("runs still on standard-1", async () => {
    const fake = fakeContainer(server());
    const report = await smokeProbe(fake.container, "still@standard-1", clock());
    expect(report).toMatchObject({ ok: true, outputBytes: PNG.byteLength, stillBytes: null, destroyed: true });
    expect(fake.started()).toMatchObject({ instance: "standard-1", enableInternet: false });
    expect(fake.calls).toEqual(["start", "GET /healthz", "POST /still", "destroy"]);
  });

  it("waits for readiness and gives up after READY_MS, destroying the container", async () => {
    let answered = 0;
    const slow = fakeContainer(
      server({
        "/healthz": () => {
          answered++;
          return answered < 4 ? new Response(null, { status: 503 }) : Response.json({ ok: true });
        },
      }),
    );
    const time = clock();
    const report = await smokeProbe(slow.container, "still@standard-1", time);
    expect(report).toMatchObject({ ok: true, failure: null });
    expect(report.startToReadyMs).toBe(750);

    const never = fakeContainer(
      server({
        "/healthz": () => {
          throw new Error("connection refused");
        },
      }),
    );
    const refused = await smokeProbe(never.container, "still@standard-1", clock());
    expect(refused).toMatchObject({ ok: false, failure: "ready", destroyed: true, outputBytes: null });
    expect(refused.wallMs).toBe(READY_MS);
    expect(never.calls.at(-1)).toBe("destroy");
    expect(never.calls.filter((c) => c.startsWith("POST"))).toEqual([]);
  });

  // One absolute deadline covers a healthz call that never settles, the image inspection and the operation.
  it("ends a stalled readiness call, inspection or operation at its deadline and destroys the container", async () => {
    const never = () => new Promise<Response>(() => {});
    const stalled = fakeContainer(server({ "/healthz": never }));
    const time = clock();
    const ready = await smokeProbe(stalled.container, "still@standard-1", time);
    expect(ready).toMatchObject({ ok: false, failure: "ready", destroyed: true });
    expect(ready.wallMs).toBe(READY_MS);
    expect(stalled.calls).toEqual(["start", "GET /healthz", "destroy"]);

    const inspecting = fakeContainer(server(), { inspect: () => new Promise(() => {}) });
    const inspected = await smokeProbe(inspecting.container, "still@standard-1", clock());
    expect(inspected).toMatchObject({ ok: true, image: { running: null }, destroyed: true });

    const operating = fakeContainer(server({ "/still": never }));
    const operated = await smokeProbe(operating.container, "still@standard-1", clock());
    expect(operated).toMatchObject({ ok: false, failure: "operation-deadline", destroyed: true });
    expect(operating.calls.at(-1)).toBe("destroy");
  });

  it("reports the server's error code and nothing of its body", async () => {
    const fake = fakeContainer(
      server({
        "/normalize": () =>
          new Response('{"error":"envelope"} ffmpeg said something', {
            status: 422,
            headers: { "kopje-error": "envelope", "content-type": "application/json" },
          }),
      }),
    );
    const report = await smokeProbe(fake.container, "normalize@standard-3", clock());
    expect(report).toMatchObject({ ok: false, failure: "normalize:envelope", destroyed: true, outputBytes: null });
    expect(JSON.stringify(report)).not.toContain("ffmpeg");
    // A code outside the server's shape is not repeated.
    const odd = fakeContainer(
      server({ "/still": () => new Response(null, { status: 500, headers: { "kopje-error": "Some <b>Thing</b>" } }) }),
    );
    expect((await smokeProbe(odd.container, "still@standard-1", clock())).failure).toBe("still-status");
  });

  it("refuses an output whose length differs from its declared length or passes the limit", async () => {
    const cases: [string, Handler, string][] = [
      // Declared shorter than sent: refused at the first byte past it.
      [
        "longer",
        () => new Response(new Uint8Array(20), { headers: { "content-type": "image/png", "content-length": "10" } }),
        "still-length",
      ],
      [
        "shorter",
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(5));
                controller.close();
              },
            }),
            { headers: { "content-type": "image/png", "content-length": "10" } },
          ),
        "still-length",
      ],
      [
        "over the still limit",
        () =>
          new Response(new Uint8Array(1), {
            headers: { "content-type": "image/png", "content-length": String(3 * 1024 * 1024) },
          }),
        "still-length",
      ],
      [
        "no length",
        () => new Response(new Uint8Array(10), { headers: { "content-type": "image/png" } }),
        "still-length",
      ],
      ["another type", () => ok(PNG, "image/jpeg"), "still-status"],
    ];
    for (const [name, handler, failure] of cases) {
      const fake = fakeContainer(server({ "/still": handler }));
      const report = await smokeProbe(fake.container, "still@standard-1", clock());
      expect(report, name).toMatchObject({ ok: false, failure, destroyed: true });
    }
    const huge = fakeContainer(
      server({
        "/normalize": () =>
          new Response(new Uint8Array(1), {
            headers: { "content-type": "video/mp4", "content-length": String(AV_OUTPUT_LIMIT + 1) },
          }),
      }),
    );
    expect((await smokeProbe(huge.container, "normalize@standard-3", clock())).failure).toBe("normalize-length");
  });

  // The reader stops at the first chunk past the declared length, however much more the container sends.
  it("stops reading an output at the first byte past its declared length", async () => {
    let pulled = 0;
    const endless = fakeContainer(
      server({
        "/still": () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                pulled++;
                controller.enqueue(new Uint8Array(8));
                if (pulled === 1000) {
                  controller.close();
                }
              },
            }),
            { headers: { "content-type": "image/png", "content-length": "10" } },
          ),
      }),
    );
    expect((await smokeProbe(endless.container, "still@standard-1", clock())).failure).toBe("still-length");
    expect(pulled).toBeLessThan(10);
  });

  it("refuses a normalize without its video still", async () => {
    const audio = fakeContainer(server({ "/normalize": () => ok(MP4, "video/mp4", { "kopje-kind": "audio" }) }));
    expect((await smokeProbe(audio.container, "normalize@standard-3", clock())).failure).toBe("normalize-kind");
    const noStill = fakeContainer(
      server({ "/normalize/still": () => new Response(null, { status: 404, headers: { "kopje-error": "no_still" } }) }),
    );
    expect((await smokeProbe(noStill.container, "normalize@standard-3", clock())).failure).toBe(
      "normalize-still:no_still",
    );
  });

  it("reports a destroy that throws, and is not ok then", async () => {
    const fake = fakeContainer(server(), {
      destroy: () => Promise.reject(new Error("destroy failed")),
    });
    const report = await smokeProbe(fake.container, "still@standard-1", clock());
    expect(report).toMatchObject({ ok: false, failure: null, destroyed: false, outputBytes: PNG.byteLength });
  });

  it("starts nothing without a configured image", async () => {
    const fake = fakeContainer(server(), { image: null });
    expect(await smokeProbe(fake.container, "still@standard-1", clock())).toMatchObject({
      ok: false,
      failure: "no-image",
      destroyed: true,
    });
    expect(fake.calls).toEqual([]);
  });
});

// A Durable Object state with the parts MediaProcessor uses. `setAlarm` fails on the calls numbered in `failAlarmOn`
// (from 1), `deleteAll` on those in `failDeleteAllOn`; `sync` waits for `sync()` when given (a delayed commit).
function fakeState(
  container: Container | undefined,
  options: { failAlarmOn?: number[]; failDeleteAllOn?: number[]; sync?: () => Promise<void> } = {},
) {
  const stored = new Map<string, unknown>();
  let alarm: number | null = null;
  let alarms = 0;
  let deletes = 0;
  const blocked: Promise<unknown>[] = [];
  const storage = {
    get: (key: string) => Promise.resolve(stored.get(key)),
    put: (key: string, value: unknown) => Promise.resolve(void stored.set(key, value)),
    deleteAll: () => {
      deletes++;
      if (options.failDeleteAllOn?.includes(deletes) === true) {
        return Promise.reject(new Error("storage unavailable"));
      }
      return Promise.resolve(stored.clear());
    },
    getAlarm: () => Promise.resolve(alarm),
    setAlarm: (at: number) => {
      alarms++;
      if (options.failAlarmOn?.includes(alarms) === true) {
        return Promise.reject(new Error("storage unavailable"));
      }
      alarm = at;
      return Promise.resolve();
    },
    deleteAlarm: () => Promise.resolve(void (alarm = null)),
    sync: () => options.sync?.() ?? Promise.resolve(),
  };
  const ctx = {
    container,
    storage,
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => {
      const p = fn();
      blocked.push(p);
      return p;
    },
  };
  return {
    ctx: ctx as UnitState,
    stored,
    alarm: () => alarm,
    settled: () => Promise.all(blocked),
  };
}

// The unit as MediaProcessor's constructor makes it.
function unit(state: UnitState, deps?: ProbeDeps): ProcessorUnit {
  const made = new ProcessorUnit(state, deps);
  made.start();
  return made;
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

describe("MediaProcessor", () => {
  it("answers no-container when the class runs without a container", async () => {
    const state = fakeState(undefined);
    const report = await unit(state.ctx).probeNow("still@standard-1");
    expect(report).toMatchObject({ ok: false, failure: "no-container" });
  });

  it("leaves no storage and no alarm after a probe whose container was destroyed", async () => {
    const fake = fakeContainer(server());
    const state = fakeState(fake.container);
    state.stored.set("leftover", 1);
    const report = await unit(state.ctx).probeNow("still@standard-1");
    expect(report.ok).toBe(true);
    expect(state.stored.size).toBe(0);
    expect(state.alarm()).toBeNull();
  });

  // The deadline is computed once before the start and stored, with the alarm at it; the operation ends at it.
  it("stores the watchdog with the alarm at the probe's one deadline before the start, and ends there", async () => {
    const time = clock();
    let atStart: { alarm: number | null; watch: unknown } | undefined;
    const fake = fakeContainer(server({ "/still": () => new Promise<Response>(() => {}) }), {
      onStart: () => (atStart = { alarm: state.alarm(), watch: state.stored.get("watch") }),
    });
    const state = fakeState(fake.container);
    const begun = time.now();
    const report = await unit(state.ctx, time).probeNow("still@standard-1");
    expect(atStart?.alarm).toBe(begun + PROBE_MS);
    expect(atStart?.watch).toMatchObject({ deadline: begun + PROBE_MS });
    expect(report).toMatchObject({ ok: false, failure: "operation-deadline", destroyed: true });
    // The operation gave up at the alarm's instant, not before and not after it.
    expect(begun + report.wallMs).toBe(atStart?.alarm);
    expect(state.alarm()).toBeNull();
    expect(state.stored.size).toBe(0);
  });

  // A commit confirmed only later: the container starts after it, and not at all when it fails.
  it("starts the container only after the watchdog's write is confirmed", async () => {
    let confirm: (ok: boolean) => void = () => {};
    const fake = counted();
    const state = fakeState(fake.container, {
      sync: () =>
        new Promise<void>((resolve, reject) => (confirm = (ok) => (ok ? resolve() : reject(new Error("commit"))))),
    });
    const object = unit(state.ctx);
    const pending = object.probeNow("still@standard-1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.starts()).toBe(0);
    confirm(true);
    expect((await pending).ok).toBe(true);
    expect(fake.starts()).toBe(1);

    const failed = object.probeNow("still@standard-1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    confirm(false);
    expect(await failed).toMatchObject({ ok: false, failure: "storage", destroyed: true });
    expect(fake.starts()).toBe(1);
    expect(state.stored.size).toBe(0);
  });

  // An output that settles at the deadline, before the deadline's timer runs, is refused; one just before it is not.
  it("refuses an output that arrives at the deadline", async () => {
    for (const [late, failure] of [
      [0, "operation-deadline"],
      [-1, null],
    ] as const) {
      let t = 5_000_000;
      const deps: ProbeDeps = { now: () => t, wait: () => new Promise(() => {}) };
      const fake = fakeContainer(
        server({
          "/still": () => {
            t = 5_000_000 + PROBE_MS + late;
            return ok(PNG, "image/png");
          },
        }),
      );
      const report = await unit(fakeState(fake.container).ctx, deps).probeNow("still@standard-1");
      expect(report.failure, `late by ${late}`).toBe(failure);
      expect(report.destroyed).toBe(true);
    }
  });

  it("starts one container for concurrent probes of its profile, and the next probe after it starts cleanly", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const fake = counted(undefined, {
      "/still": async () => {
        await held;
        return ok(PNG, "image/png");
      },
    });
    const object = unit(fakeState(fake.container).ctx);
    const first = object.probeNow("still@standard-1");
    await vi.waitFor(() => expect(fake.starts()).toBe(1));
    expect(await object.probeNow("still@standard-1")).toMatchObject({ ok: false, failure: "busy", destroyed: true });
    release();
    expect((await first).ok).toBe(true);
    expect(fake.starts()).toBe(1);
    expect((await object.probeNow("still@standard-1")).ok).toBe(true);
    expect(fake.starts()).toBe(2);
  });

  // However long the destroy keeps failing, the object's one container is the only one: every probe meanwhile is busy.
  it("starts no second container while one it could not destroy runs, and probes again once it is gone", async () => {
    let failing = true;
    const fake = flaky(() => failing);
    const state = fakeState(fake.container);
    const object = unit(state.ctx);
    const before = Date.now();
    expect(await object.probeNow("still@standard-1")).toMatchObject({ failure: null, destroyed: false });
    expect(state.alarm()).toBeGreaterThanOrEqual(before + CLEANUP_RETRY_MS);
    for (let i = 0; i < 10; i++) {
      await object.alarm();
      expect(await object.probeNow("still@standard-1")).toMatchObject({ failure: "busy", destroyed: false });
    }
    expect(fake.starts()).toBe(1);
    expect(fake.container.running).toBe(true);
    expect(state.alarm()).not.toBeNull();

    failing = false;
    await object.alarm();
    expect(fake.container.running).toBe(false);
    expect(state.alarm()).toBeNull();
    expect((await object.probeNow("still@standard-1")).ok).toBe(true);
    expect(fake.starts()).toBe(2);
  });

  // The review's schedule: the alarm is in its destroy when the container stops; a probe arrives before the destroy's
  // reply. The probe is busy (the record is the alarm's), so the alarm never meets a newer container or its deadline.
  it("answers busy while the alarm is still destroying, and the next probe's deadline stays its own", async () => {
    let failing = true;
    let reply = () => {};
    let deferred = true;
    // A clock whose timers never fire: the destroy's reply, not its bound, ends the alarm's wait.
    const time: ProbeDeps = { now: () => 7_000_000, wait: () => new Promise(() => {}) };
    let atStart: number | null = null;
    const fake = fakeContainer(server(), {
      destroy: () => {
        if (failing) {
          return Promise.reject(new Error("destroy failed"));
        }
        // The alarm's destroy: the container stops at once, the reply comes later. Later destroys answer at once.
        stop();
        if (deferred) {
          deferred = false;
          return new Promise<void>((resolve) => (reply = resolve));
        }
        return Promise.resolve();
      },
      onStart: () => (atStart = state.alarm()),
    });
    const stop = () => fake.stop();
    const state = fakeState(fake.container);
    const object = unit(state.ctx, time);
    expect((await object.probeNow("still@standard-1")).destroyed).toBe(false);
    failing = false;
    const alarming = object.alarm();
    await vi.waitFor(() => expect(fake.container.running).toBe(false));
    expect(await object.probeNow("still@standard-1")).toMatchObject({ failure: "busy", destroyed: true });
    reply();
    await alarming;
    expect(state.stored.size).toBe(0);
    expect(state.alarm()).toBeNull();
    const begun = time.now();
    expect((await object.probeNow("still@standard-1")).ok).toBe(true);
    expect(atStart).toBe(begun + PROBE_MS);
  });

  // The alarm fires at a probe's deadline while the probe still runs; the probe confirms its own teardown and clears its
  // record, and a new probe starts before the alarm's destroy replies. The alarm leaves the new probe's record alone.
  it("leaves a newer probe's record and deadline alone when its destroy replies late", async () => {
    let t = 8_000_000;
    const time: ProbeDeps = { now: () => t, wait: () => new Promise(() => {}) };
    const gates: (() => void)[] = [];
    let reply = () => {};
    let deferred = true;
    const fake = counted(
      () => {
        fake.stop();
        if (deferred) {
          deferred = false;
          return new Promise<void>((resolve) => (reply = resolve));
        }
        return Promise.resolve();
      },
      { "/still": () => new Promise<Response>((resolve) => gates.push(() => resolve(ok(PNG, "image/png")))) },
    );
    const state = fakeState(fake.container);
    const object = unit(state.ctx, time);
    const first = object.probeNow("still@standard-1");
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    const alarming = object.alarm();
    await vi.waitFor(() => expect(fake.container.running).toBe(false));
    gates[0]?.();
    expect(await first).toMatchObject({ destroyed: true });

    t += 1_000;
    const second = object.probeNow("still@standard-1");
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    expect(fake.starts()).toBe(2);
    reply();
    await alarming;
    expect(state.alarm()).toBe(t + PROBE_MS);
    expect(fake.container.running).toBe(true);
    gates[1]?.();
    expect((await second).ok).toBe(true);
  });

  // A destroy that never settles counts as failed after DESTROY_MS: the probe answers, and the alarm owns the rest.
  it("bounds a stalled destroy, and the alarm clears the record once the container is gone", async () => {
    let stalled = true;
    const time = clock();
    const fake = counted(() => (stalled ? new Promise<void>(() => {}) : Promise.resolve()));
    const state = fakeState(fake.container);
    const object = unit(state.ctx, time);
    const begun = time.now();
    const report = await object.probeNow("still@standard-1");
    expect(report).toMatchObject({ ok: false, destroyed: false });
    expect(report.wallMs).toBeGreaterThanOrEqual(DESTROY_MS);
    expect(time.now() - begun).toBeLessThan(PROBE_MS);
    expect(await object.probeNow("still@standard-1")).toMatchObject({ failure: "busy", destroyed: false });
    await object.alarm();
    expect(state.stored.get("watch")).toBeDefined();
    stalled = false;
    await object.alarm();
    expect(state.stored.size).toBe(0);
    expect((await object.probeNow("still@standard-1")).ok).toBe(true);
    expect(fake.starts()).toBe(2);
  });

  it("keeps the deadline's alarm when destroy throws and the sooner retry cannot be written", async () => {
    const time = clock();
    const fake = flaky(() => true);
    const state = fakeState(fake.container, { failAlarmOn: [2] });
    const begun = time.now();
    const report = await unit(state.ctx, time).probeNow("still@standard-1");
    expect(report.destroyed).toBe(false);
    expect(fake.container.running).toBe(true);
    expect(state.alarm()).toBe(begun + PROBE_MS);
    expect(state.stored.get("watch")).toBeDefined();
  });

  // A storage write that fails leaves no busy profile behind: an immediate retry starts cleanly.
  it("starts nothing when the deadline cannot be stored, and a retry right after starts cleanly", async () => {
    const fake = flaky(() => false);
    const state = fakeState(fake.container, { failAlarmOn: [1] });
    const object = unit(state.ctx);
    expect(await object.probeNow("still@standard-1")).toMatchObject({ ok: false, failure: "storage", destroyed: true });
    expect(fake.starts()).toBe(0);
    expect((await object.probeNow("still@standard-1")).ok).toBe(true);
    expect(fake.starts()).toBe(1);
  });

  // The record stays when the storage cannot be deleted after a teardown; the next probe hands it to an alarm now,
  // which finds nothing running and clears it.
  it("hands a record left after a confirmed teardown to an alarm now, and probes again after it", async () => {
    const time = clock();
    const fake = flaky(() => false);
    const state = fakeState(fake.container, { failDeleteAllOn: [1] });
    const object = unit(state.ctx, time);
    expect(await object.probeNow("still@standard-1")).toMatchObject({ ok: true, destroyed: true });
    expect(state.stored.get("watch")).toBeDefined();
    expect(await object.probeNow("still@standard-1")).toMatchObject({ failure: "busy", destroyed: true });
    expect(state.alarm()).toBe(time.now());
    await object.alarm();
    expect(state.stored.size).toBe(0);
    expect((await object.probeNow("still@standard-1")).ok).toBe(true);
    expect(fake.starts()).toBe(2);
  });

  it("destroys a container it finds running when it starts, and the alarm owns one it cannot", async () => {
    const fake = fakeContainer(server());
    fake.container.start({ image: "x" });
    const state = fakeState(fake.container);
    unit(state.ctx);
    await state.settled();
    expect(fake.calls).toEqual(["start", "destroy"]);
    expect(fake.container.running).toBe(false);

    const stuck = flaky(() => true);
    stuck.container.start({ image: "x" });
    const stuckState = fakeState(stuck.container);
    const object = unit(stuckState.ctx);
    await stuckState.settled();
    expect(stuckState.stored.get("watch")).toBeDefined();
    expect(stuckState.alarm()).not.toBeNull();
    expect(await object.probeNow("still@standard-1")).toMatchObject({ failure: "busy", destroyed: false });
    expect(stuck.starts()).toBe(1);
  });
});

describe("processorClient", () => {
  it("is null without the binding", () => {
    expect("MEDIA_PROCESSOR" in env).toBe(false);
    expect(processorClient(env, "build")).toBeNull();
  });

  it("probes each profile on its one object, named for the version and the profile", async () => {
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
    expect((await client?.probeNow("still@standard-1"))?.ok).toBe(true);
    expect((await client?.probeNow("still@standard-1"))?.ok).toBe(true);
    expect((await client?.probeNow("normalize@standard-3"))?.ok).toBe(true);
    expect(names).toEqual(["p:v1:still@standard-1", "p:v1:still@standard-1", "p:v1:normalize@standard-3"]);
  });
});

describe("POST /admin/media-processor/probe and kopje-admin media-processor probe", () => {
  function report(profile: ProbeProfile, ok = true): ProbeReport {
    return {
      ok,
      profile,
      failure: ok ? null : "ready",
      image: { configured: null, running: null },
      startToReadyMs: null,
      operationMs: null,
      wallMs: 1,
      stages: {},
      outputBytes: null,
      stillBytes: null,
      destroyed: true,
    };
  }

  // The admin app with this processor (null: no binding), and the CLI's fetch through an Access edge that turns its
  // service token into a JWT.
  async function harness(probe: ((profile: ProbeProfile) => Promise<ProbeReport>) | null) {
    const team = await adminTeam();
    const store = await migratedStore();
    await setTeamAccess(store, team);
    const app = createApp({
      build: () => BUILD,
      now: () => NOW,
      store: () => store,
      fetch: team.fetch,
      mediaProcessor: () => (probe === null ? null : { probeNow: probe }),
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
    const probe = vi.fn((profile: ProbeProfile) => Promise.resolve(report(profile)));
    const bound = await harness(probe);
    expect((await bound.post("normalize@standard-2")).status).toBe(400);
    expect((await bound.post(undefined)).status).toBe(400);
    expect(probe).not.toHaveBeenCalled();
    const good = await bound.post("still@standard-1");
    expect(good.status).toBe(200);
    expect(await good.json()).toEqual({ report: report("still@standard-1") });
    expect(probe).toHaveBeenCalledOnce();

    const refused = await (await harness(null)).post("still@standard-1");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "media-processor-unbound" });
  });

  it("probes every profile by default, prints each report and exits by the outcome", async () => {
    const seen: ProbeProfile[] = [];
    const all = await harness((profile) => {
      seen.push(profile);
      return Promise.resolve(report(profile));
    });
    const passed = await all.cli(["media-processor", "probe"]);
    expect(passed.code, passed.err).toBe(0);
    // The CLI's list is the Worker's.
    expect(seen).toEqual([...PROBE_PROFILES]);
    expect(passed.out).toContain('"profile": "still@standard-1"');

    const one = await harness((profile) => Promise.resolve(report(profile, profile !== "normalize@standard-4")));
    expect((await one.cli(["media-processor", "probe", "normalize@standard-3"])).code).toBe(0);
    expect((await one.cli(["media-processor", "probe", "normalize@standard-4"])).code).toBe(1);
    expect((await one.cli(["media-processor", "probe", "normalize@standard-2"])).code).toBe(2);
    expect((await one.cli(["media-processor"])).code).toBe(2);

    const unbound = await (await harness(null)).cli(["media-processor", "probe"]);
    expect(unbound.code).toBe(3);
    expect(unbound.err).toContain("not bound");
  });
});
