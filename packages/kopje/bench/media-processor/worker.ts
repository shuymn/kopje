// The media processor bench (#1828, P27): a standalone Worker that runs the package's container image
// (container/Dockerfile, wrangler.jsonc beside this file) on any input the operator puts in its bucket, on a chosen
// instance type and ffmpeg threading option, and reports the stages the design's allocation is made of. It has no
// Kopje code and no Store; measure.sh drives it. Every route needs `Authorization: Bearer <BENCH_TOKEN>`.
//
//   PUT    /object/<key>   stream an input into R2 (Content-Length required); answers the time it took (ingress)
//   DELETE /object/<key>   delete one object
//   POST   /run?op=normalize|still&key=<key>&expect=video|audio&instance=standard-1|standard-3|standard-4
//                         [&threads=default|filters:N|all:N][&encode_ms=<ms>]
//          one unit of work on a fresh object, as Kopje's MediaProcessor runs it: start with no Internet, /healthz,
//          the input read once from R2 and streamed as the request body, the output streamed into R2 under out/,
//          for a video normalize the still too, then the still through Images (WebP, long edge 640, and its RGBA
//          output), then destroy. `expect` is the fixture's kind (measure.sh's table): a video normalize fetches its
//          still whatever the server's Kopje-Kind says. Answers JSON with each stage's time; spaces are sent every
//          10 s before it. `ok` is true only when the run succeeded end to end (outcome.mjs); `run` is the id the
//          container carries as its `run` label, which billing.sh joins the billed usage on.
//   POST   /dispatch       how long an alarm set for now takes to run (the upload dispatch)
//   GET    /hold?seconds=<n>
//          answers 200 only after n seconds with no byte sent before (whether a Worker may hold its headers past
//          100 s, design #1828 F1)
import { DurableObject } from "cloudflare:workers";

import { endToEnd } from "./outcome.mjs";

interface Env {
  BENCH: DurableObjectNamespace<BenchUnit>;
  BUCKET: R2Bucket;
  IMAGES: ImagesBinding;
  BENCH_TOKEN: string;
}

const PORT = 8080;
const READY_MS = 180_000;
const INPUT_LIMIT = 94_371_840;
const INSTANCES = ["standard-1", "standard-3", "standard-4"] as const;
type Instance = (typeof INSTANCES)[number];
const THREADS = /^(default|ffmpeg|filters:\d{1,2}|all:\d{1,2})$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;

type RunResult = {
  op: "normalize" | "still";
  expect: "video" | "audio";
  instance: Instance;
  threads: string;
  key: string;
  run: string;
  ok: boolean;
  inputBytes: number;
  outputBytes: number | null;
  stillBytes: number | null;
  status: number | null;
  error: string | null;
  mediaKind: string | null; // the server's Kopje-Kind
  contentType: string | null;
  // Times in milliseconds: the object's clock, then the server's stage headers.
  startToReadyMs: number | null;
  operationMs: number | null; // the POST until its response headers (input streaming, probe, encode, still)
  outputToR2Ms: number | null; // the response body streamed into R2
  stillToR2Ms: number | null;
  imagesWebpMs: number | null;
  imagesRgbaMs: number | null;
  destroyMs: number | null;
  wallMs: number;
  server: Record<string, number>;
};

function sized(body: ReadableStream, length: number): ReadableStream<Uint8Array> {
  const fixed = new FixedLengthStream(length);
  void body.pipeTo(fixed.writable).catch(() => {});
  return fixed.readable;
}

function serverTimes(headers: Headers): Record<string, number> {
  const times: Record<string, number> = {};
  for (const [name, value] of headers) {
    const m = /^kopje-(.+)-ms$/.exec(name);
    if (m?.[1] !== undefined && /^\d+$/.test(value)) {
      times[m[1]] = Number(value);
    }
  }
  return times;
}

export class BenchUnit extends DurableObject<Env> {
  async run(
    op: "normalize" | "still",
    expect: "video" | "audio",
    key: string,
    instance: Instance,
    threads: string,
    encodeMs: number,
  ) {
    const t0 = Date.now();
    const runId = this.ctx.id.toString().slice(0, 12);
    const r: RunResult = {
      op,
      expect,
      instance,
      threads,
      key,
      run: runId,
      ok: false,
      inputBytes: 0,
      outputBytes: null,
      stillBytes: null,
      status: null,
      error: null,
      mediaKind: null,
      contentType: null,
      startToReadyMs: null,
      operationMs: null,
      outputToR2Ms: null,
      stillToR2Ms: null,
      imagesWebpMs: null,
      imagesRgbaMs: null,
      destroyMs: null,
      wallMs: 0,
      server: {},
    };
    const c = this.ctx.container;
    try {
      if (c === undefined) {
        throw new Error("no container");
      }
      const object = await this.env.BUCKET.get(key);
      if (object === null || object.size > INPUT_LIMIT) {
        throw new Error(object === null ? "no input" : "input over the limit");
      }
      r.inputBytes = object.size;
      c.start({
        image: c.images.media ?? "",
        instance,
        enableInternet: false,
        env: threads === "default" ? {} : { MEDIASRV_THREADS: threads },
        labels: { app: "kopje-media-bench", instance, threads, op, run: runId },
      });
      const port = c.getTcpPort(PORT);
      for (;;) {
        const ok = await port.fetch("http://container/healthz").then(
          (res) => res.ok,
          () => false,
        );
        if (ok) {
          break;
        }
        if (Date.now() - t0 > READY_MS) {
          throw new Error("not ready");
        }
        await scheduler.wait(100);
      }
      r.startToReadyMs = Date.now() - t0;
      const path = op === "normalize" ? `/normalize?probe_ms=30000&encode_ms=${encodeMs}` : "/still";
      const t1 = Date.now();
      const res = await port.fetch(`http://container${path}`, {
        method: "POST",
        body: object.body,
        headers: { "content-length": String(object.size), "content-type": "application/octet-stream" },
      });
      r.operationMs = Date.now() - t1;
      r.status = res.status;
      r.server = serverTimes(res.headers);
      r.mediaKind = res.headers.get("kopje-kind");
      r.contentType = res.headers.get("content-type");
      const length = Number(res.headers.get("content-length"));
      if (res.status !== 200 || res.body === null || !Number.isSafeInteger(length)) {
        r.error = res.headers.get("kopje-error") ?? `status ${res.status}`;
        await res.body?.cancel();
        return r;
      }
      const t2 = Date.now();
      await this.env.BUCKET.put(`out/${runId}/output`, sized(res.body, length));
      r.outputToR2Ms = Date.now() - t2;
      r.outputBytes = length;
      let still: Uint8Array | null = null;
      if (op === "still") {
        still = new Uint8Array(await (await this.env.BUCKET.get(`out/${runId}/output`))!.arrayBuffer());
      } else if (expect === "video") {
        const s = await port.fetch("http://container/normalize/still");
        if (s.status !== 200) {
          await s.body?.cancel();
          throw new Error(`still: status ${s.status}`);
        }
        const t3 = Date.now();
        still = new Uint8Array(await s.arrayBuffer());
        await this.env.BUCKET.put(`out/${runId}/still.png`, still);
        r.stillToR2Ms = Date.now() - t3;
      }
      if (still !== null) {
        r.stillBytes = still.byteLength;
        const t4 = Date.now();
        const webp = await this.env.IMAGES.input(new Response(still).body as ReadableStream<Uint8Array>)
          .transform({ width: 640, height: 640, fit: "scale-down" })
          .output({ format: "image/webp", anim: false });
        await new Response(webp.image()).arrayBuffer();
        r.imagesWebpMs = Date.now() - t4;
        const t5 = Date.now();
        const rgba = await this.env.IMAGES.input(new Response(still).body as ReadableStream<Uint8Array>)
          .transform({ width: 32, height: 32, fit: "scale-down" })
          .output({ format: "rgba" });
        await new Response(rgba.image()).arrayBuffer();
        r.imagesRgbaMs = Date.now() - t5;
      }
    } catch (error) {
      r.error = error instanceof Error ? error.message : String(error);
    } finally {
      const t6 = Date.now();
      if (c?.running === true) {
        await c.destroy().catch((error: unknown) => {
          r.error ??= `destroy: ${String(error)}`;
        });
      }
      r.destroyMs = Date.now() - t6;
      r.wallMs = Date.now() - t0;
      r.ok = endToEnd(r);
      await this.ctx.storage.deleteAll();
    }
    return r;
  }

  async dispatch(): Promise<number> {
    const at = Date.now();
    await this.ctx.storage.put("set", at);
    await this.ctx.storage.setAlarm(at);
    for (let i = 0; i < 600; i++) {
      const fired = await this.ctx.storage.get<number>("fired");
      if (fired !== undefined) {
        await this.ctx.storage.deleteAll();
        return fired - at;
      }
      await scheduler.wait(50);
    }
    return -1;
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.put("fired", Date.now());
  }
}

async function authorized(request: Request, token: string | undefined): Promise<boolean> {
  if (token === undefined || token.length < 32) {
    return false;
  }
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(request.headers.get("authorization") ?? "")),
    crypto.subtle.digest("SHA-256", enc.encode(`Bearer ${token}`)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

// Sends a space every 10 s until the JSON is ready (JSON parsers skip leading spaces), so no idle timeout ends a long
// job's request.
function keepAlive(ctx: ExecutionContext, work: Promise<unknown>): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const tick = setInterval(() => void writer.write(enc.encode(" ")).catch(() => {}), 10_000);
  ctx.waitUntil(
    work
      .then(
        (r) => JSON.stringify(r),
        (e: unknown) => JSON.stringify({ error: String(e) }),
      )
      .then(async (body) => {
        clearInterval(tick);
        await writer.write(enc.encode(`${body}\n`));
        await writer.close();
      }),
  );
  return new Response(readable, { headers: { "content-type": "application/json" } });
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    if (!(await authorized(request, env.BENCH_TOKEN))) {
      return new Response("unauthorized", { status: 401 });
    }
    const url = new URL(request.url);
    if (url.pathname.startsWith("/object/")) {
      const key = decodeURIComponent(url.pathname.slice("/object/".length));
      if (!KEY.test(key) || key.split("/").some((s) => s === "." || s === "..")) {
        return Response.json({ error: "bad key" }, { status: 400 });
      }
      if (request.method === "DELETE") {
        await env.BUCKET.delete(key);
        return new Response(null, { status: 204 });
      }
      const length = Number(request.headers.get("content-length"));
      if (request.method !== "PUT" || request.body === null || !Number.isSafeInteger(length) || length <= 0) {
        return Response.json({ error: "PUT with Content-Length" }, { status: 400 });
      }
      const t0 = Date.now();
      await env.BUCKET.put(key, sized(request.body, length));
      return Response.json({ key, bytes: length, ingressMs: Date.now() - t0 });
    }
    if (url.pathname === "/run" && request.method === "POST") {
      const op = url.searchParams.get("op");
      const expect = url.searchParams.get("expect");
      const key = url.searchParams.get("key") ?? "";
      const instance = url.searchParams.get("instance") as Instance;
      const threads = url.searchParams.get("threads") ?? "default";
      const encodeMs = Number(url.searchParams.get("encode_ms") ?? 1_800_000);
      if (
        (op !== "normalize" && op !== "still") ||
        (expect !== "video" && expect !== "audio") ||
        !KEY.test(key) ||
        !INSTANCES.includes(instance) ||
        !THREADS.test(threads) ||
        !Number.isSafeInteger(encodeMs)
      ) {
        return Response.json({ error: "bad parameters" }, { status: 400 });
      }
      const unit = env.BENCH.getByName(`run:${crypto.randomUUID()}`);
      return keepAlive(ctx, unit.run(op, expect, key, instance, threads, encodeMs));
    }
    if (url.pathname === "/dispatch" && request.method === "POST") {
      return Response.json({ dispatchMs: await env.BENCH.getByName(`dispatch:${crypto.randomUUID()}`).dispatch() });
    }
    if (url.pathname === "/hold" && request.method === "GET") {
      const seconds = Number(url.searchParams.get("seconds"));
      if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 600) {
        return Response.json({ error: "seconds 0-600" }, { status: 400 });
      }
      await scheduler.wait(seconds * 1000);
      return Response.json({ heldSeconds: seconds });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
