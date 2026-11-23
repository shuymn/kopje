import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import { run } from "../cli/lib/main.js";
import { createApp } from "../src/app/app";
import { PROBE_FIXTURE_BASE64 } from "../src/media-probe-fixture";
import {
  AV_OUTPUT_LIMIT,
  CLEANUP_RETRY_MS,
  LEASE_MS,
  processorClient,
  ProcessorUnit,
  READY_MS,
  smokeProbe,
  WATCHDOG_MS,
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
    },
    async destroy() {
      calls.push("destroy");
      await (options.destroy ?? (async () => {}))();
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
  return { container: container as unknown as Container, calls, bodies, started: () => started };
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

// A Durable Object state with the parts MediaProcessor uses.
// `setAlarm` fails from its `failAlarmFrom`-th call on.
function fakeState(container: Container | undefined, options: { failAlarmFrom?: number } = {}) {
  const stored = new Map<string, unknown>();
  let alarm: number | null = null;
  let alarms = 0;
  const blocked: Promise<unknown>[] = [];
  const storage = {
    get: (key: string) => Promise.resolve(stored.get(key)),
    put: (key: string, value: unknown) => Promise.resolve(void stored.set(key, value)),
    delete: (key: string) => Promise.resolve(stored.delete(key)),
    deleteAll: () => Promise.resolve(stored.clear()),
    setAlarm: (at: number) => {
      alarms++;
      if (options.failAlarmFrom !== undefined && alarms >= options.failAlarmFrom) {
        return Promise.reject(new Error("storage unavailable"));
      }
      alarm = at;
      return Promise.resolve();
    },
    deleteAlarm: () => Promise.resolve(void (alarm = null)),
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
function unit(state: UnitState): ProcessorUnit {
  const made = new ProcessorUnit(state);
  made.start();
  return made;
}

describe("MediaProcessor", () => {
  it("answers no-container when the class runs without a container", async () => {
    const state = fakeState(undefined);
    const report = await unit(state.ctx).probeNow("still@standard-1");
    expect(report).toMatchObject({ ok: false, failure: "no-container" });
  });

  it("leaves no storage after a probe whose container was destroyed", async () => {
    const fake = fakeContainer(server());
    const state = fakeState(fake.container);
    state.stored.set("leftover", 1);
    const report = await unit(state.ctx).probeNow("still@standard-1");
    expect(report.ok).toBe(true);
    expect(state.stored.size).toBe(0);
    expect(state.alarm()).toBeNull();
  });

  it("keeps a cleanup alarm when destroy throws, and the alarm destroys and then deletes its storage", async () => {
    let fail = true;
    const fake = fakeContainer(server(), {
      destroy: () => (fail ? Promise.reject(new Error("destroy failed")) : Promise.resolve()),
    });
    const state = fakeState(fake.container);
    const object = unit(state.ctx);
    const before = Date.now();
    expect((await object.probeNow("still@standard-1")).destroyed).toBe(false);
    expect(state.stored.get("cleanup")).toBe(true);
    expect(state.alarm()).toBeGreaterThanOrEqual(before + CLEANUP_RETRY_MS);

    // Still failing: the alarm is set again and the storage kept.
    await object.alarm();
    expect(state.stored.get("cleanup")).toBe(true);
    expect(fake.container.running).toBe(true);

    fail = false;
    await object.alarm();
    expect(fake.container.running).toBe(false);
    expect(state.stored.size).toBe(0);
    expect(state.alarm()).toBeNull();
  });

  // The watchdog is stored before the container starts, so an invocation that ends after the start, or an alarm write
  // that fails after it, still leaves an alarm that destroys the container.
  it("stores a cleanup watchdog before the start and clears it only after a confirmed teardown", async () => {
    let atStart: { alarm: number | null; cleanup: unknown } | undefined;
    const fake = fakeContainer(server(), {
      // Called at the start, after state below is set.
      onStart: () => (atStart = { alarm: state.alarm(), cleanup: state.stored.get("cleanup") }),
    });
    const state = fakeState(fake.container);
    const before = Date.now();
    expect((await unit(state.ctx).probeNow("still@standard-1")).destroyed).toBe(true);
    expect(atStart?.cleanup).toBe(true);
    expect(atStart?.alarm).toBeGreaterThanOrEqual(before + WATCHDOG_MS);
    expect(state.alarm()).toBeNull();
    expect(state.stored.size).toBe(0);
  });

  it("keeps the watchdog when destroy throws and the sooner retry cannot be written", async () => {
    const fake = fakeContainer(server(), { destroy: () => Promise.reject(new Error("destroy failed")) });
    const state = fakeState(fake.container, { failAlarmFrom: 2 });
    const before = Date.now();
    const report = await unit(state.ctx).probeNow("still@standard-1");
    expect(report.destroyed).toBe(false);
    expect(fake.container.running).toBe(true);
    expect(state.stored.get("cleanup")).toBe(true);
    expect(state.alarm()).toBeGreaterThanOrEqual(before + WATCHDOG_MS);
  });

  it("starts nothing when the watchdog cannot be stored", async () => {
    const fake = fakeContainer(server());
    const state = fakeState(fake.container, { failAlarmFrom: 1 });
    await expect(unit(state.ctx).probeNow("still@standard-1")).rejects.toThrow("storage unavailable");
    expect(fake.calls).toEqual([]);
  });

  it("destroys a container it finds running when it starts", async () => {
    const fake = fakeContainer(server());
    fake.container.start({ image: "x" });
    const state = fakeState(fake.container);
    unit(state.ctx);
    await state.settled();
    expect(fake.calls).toEqual(["start", "destroy"]);
    expect(fake.container.running).toBe(false);
  });
});

describe("processorClient", () => {
  it("is null without the binding", () => {
    expect("MEDIA_PROCESSOR" in env).toBe(false);
    expect(processorClient(env, "build")).toBeNull();
  });

  // A namespace of units over fake states, each name its own object; probes run on containers from `container`.
  function fakeNamespace(container: () => Container) {
    const objects = new Map<string, ProcessorUnit>();
    const names: string[] = [];
    return {
      names,
      namespace: {
        getByName(name: string) {
          names.push(name);
          let object = objects.get(name);
          if (object === undefined) {
            object = unit(fakeState(name.startsWith("p:") ? container() : undefined).ctx);
            objects.set(name, object);
          }
          return object;
        },
      },
    };
  }

  it("probes each profile on a fresh object named for the version, the profile and a nonce", async () => {
    const { names, namespace } = fakeNamespace(() => fakeContainer(server()).container);
    let n = 0;
    const client = processorClient({ ...env, MEDIA_PROCESSOR: namespace } as never, "v1", () => `n${++n}`);
    expect((await client?.probeNow("still@standard-1"))?.ok).toBe(true);
    expect((await client?.probeNow("still@standard-1"))?.ok).toBe(true);
    expect(names.filter((name) => name.startsWith("p:"))).toEqual([
      "p:v1:still@standard-1:n1",
      "p:v1:still@standard-1:n2",
    ]);
  });

  // One probe of a profile at a time: a second, while the first holds the profile's lease, starts nothing.
  it("starts one container per profile for concurrent probes, and frees the profile after teardown", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let starts = 0;
    let gate = true;
    const { namespace } = fakeNamespace(
      () =>
        fakeContainer(
          server({
            "/still": async () => {
              if (gate) {
                await held;
              }
              return ok(PNG, "image/png");
            },
          }),
          { onStart: () => void starts++ },
        ).container,
    );
    let n = 0;
    const client = processorClient({ ...env, MEDIA_PROCESSOR: namespace } as never, "v1", () => `n${++n}`);
    const first = client?.probeNow("still@standard-1");
    await vi.waitFor(() => expect(starts).toBe(1));
    const second = await client?.probeNow("still@standard-1");
    expect(second).toMatchObject({ ok: false, failure: "busy" });
    // Another profile is not held.
    gate = false;
    expect((await client?.probeNow("normalize@standard-3"))?.failure).not.toBe("busy");
    gate = true;
    release();
    expect((await first)?.ok).toBe(true);
    expect(starts).toBe(2);
    gate = false;
    expect((await client?.probeNow("still@standard-1"))?.ok).toBe(true);
  });

  it("keeps the lease of a probe whose container was not destroyed until LEASE_MS", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { namespace } = fakeNamespace(
        () => fakeContainer(server(), { destroy: () => Promise.reject(new Error("destroy failed")) }).container,
      );
      let n = 0;
      const client = processorClient({ ...env, MEDIA_PROCESSOR: namespace } as never, "v1", () => `n${++n}`);
      expect((await client?.probeNow("still@standard-1"))?.destroyed).toBe(false);
      expect((await client?.probeNow("still@standard-1"))?.failure).toBe("busy");
      vi.advanceTimersByTime(LEASE_MS + 1);
      expect((await client?.probeNow("still@standard-1"))?.failure).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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
