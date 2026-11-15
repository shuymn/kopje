// The held-output bench (#1610): measures what the streaming hub's handling of slow clients rests on, on the runtime
// itself, since no signal of unsent output reaches JavaScript (RES-6). It deploys `worker.ts` as a temporary Worker
// named `kopje-bench-held-<random>` at the compatibility date and flags of the package's wrangler.jsonc, drives it
// with clients of its own, writes what it observed as JSON lines and the outcomes `classify.mjs` gives them, and
// deletes the Worker, also when a run fails (printing the delete command if that fails too). `--local` runs the same
// object under `wrangler dev` on the pinned workerd instead and samples the workerd process's resident memory.
//
//   pnpm --filter kopje bench:held-output [--local] [--runs m1,m2,...] [--out <dir>] [--quick]
//
// Deployed, it uses wrangler's login (CLOUDFLARE_ACCOUNT_ID picks the account when the login has several) and takes
// about five hours: M1 then M5 on one Worker, M2, M3 and M4 each on their own at the same time, so a reset elsewhere
// cannot end them. Locally it runs M5 and M6 by default, one `wrangler dev` each. `--quick` shrinks every volume and
// duration to check the tool itself; its outcomes measure nothing. The output directory (default
// `held-output-<time>` in the directory pnpm was run from) receives observations.jsonl, outcomes.json and the
// wrangler logs.
//
// Measurements (each run's clients are `node:tls` WebSocket clients, plain TCP locally, that record each frame's age
// from the hand time it carries):
//   M1  headroom (/alloc in 1 MiB steps until the probe's own reset, three times) with nothing held, and with stopped
//       clients holding 64 MiB, 256 MiB and 1 GiB, handed in paced batches of 2 frames of 512 KiB every 2 s, and
//       separately of 16,384 frames of 64 bytes, the control drained before every batch; the clients then resume
//   M2  three stopped clients and the control, each handed 4 frames of 4 KiB every 10 s, up to 4 hours; a fourth
//       stopped client holding 32 MiB is closed with 1013 by the object and resumes after an hour
//   M3  throttled clients reading 1, 16 and 256 KiB/s, up to 4 hours
//   M4  intermittent clients reading 1 MiB every 10, 60 and 100 minutes, up to 4 hours
//   M5  with the object kept in memory, 64 then 256 stopped sockets, each in turn handed 8,192 frames of 64 bytes,
//       drained and left open, then all closed: resident memory per stage locally, headroom with and without the
//       drained sockets deployed
//   M6  locally, 1, 16 and 64 stopped clients each handed 65,536 frames of 64 bytes: resident memory per stage
// M3 and M4 hand their clients 512 KiB a second each, but only while each backlog (handed less received) stays within
// CLIENT_BACKLOG_BYTES and all of them together within TOTAL_BACKLOG_BYTES (`framesToHand`), so no run's own output
// approaches the isolate's memory.
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { connect as tcpConnect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { classify, parseObservations } from "./classify.mjs";

const KIB = 1024;
const MIB = 1024 * KIB;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

// The backlog limits of a throttled or intermittent client, and of all of them together.
export const CLIENT_BACKLOG_BYTES = 4 * MIB;
export const TOTAL_BACKLOG_BYTES = 16 * MIB;
// What M3 and M4 offer each client every second, in frames of PACED_FRAME_BYTES.
export const OFFERED_BYTES_PER_SECOND = 512 * KIB;
export const PACED_FRAME_BYTES = 16 * KIB;
// M3's throttled clients, in bytes a second.
export const THROTTLED_RATES = [KIB, 16 * KIB, 256 * KIB];

// How often each run reads the object's state and each client summarizes what it received.
const STATE_MS = 5_000;
// The headroom probe stops at this many MiB without a reset: locally workerd enforces no isolate limit.
const PROBE_CAP_MIB = { local: 512, deployed: 4096 };
// How long a resumed client may take to receive what it was handed.
const DRAIN_WAIT_MS = 10 * MINUTE_MS;
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "../..");
const require = createRequire(import.meta.url);
const wrangler = join(dirname(require.resolve("wrangler/package.json")), "bin", "wrangler.js");

/**
 * The frames to hand each client this tick: up to `offered` each, while its backlog stays within CLIENT_BACKLOG_BYTES
 * and all clients' backlogs together within TOTAL_BACKLOG_BYTES.
 * @param {{ handed: number, received: number }[]} clients bytes handed and received so far
 * @param {number} frameBytes
 * @param {number} offered
 * @returns {number[]}
 */
export function framesToHand(clients, frameBytes, offered) {
  let total = clients.reduce((sum, c) => sum + c.handed - c.received, 0);
  return clients.map((c) => {
    const room = Math.min(CLIENT_BACKLOG_BYTES - (c.handed - c.received), TOTAL_BACKLOG_BYTES - total);
    const frames = Math.max(0, Math.min(offered, Math.floor(room / frameBytes)));
    total += frames * frameBytes;
    return frames;
  });
}

/**
 * The volumes and durations of each measurement; `quick` shrinks them to check the tool.
 * @param {boolean} quick
 */
function planOf(quick) {
  return {
    durationMs: quick ? 2 * MINUTE_MS : 4 * HOUR_MS,
    m1: {
      volumes: quick ? [4 * MIB] : [64 * MIB, 256 * MIB, 1024 * MIB],
      shapes: [
        { frameBytes: 512 * KIB, frames: 2 },
        { frameBytes: 64, frames: 16_384 },
      ],
      attempts: quick ? 1 : 3,
      batchMs: 2_000,
      stopped: 4,
    },
    m2: {
      handMs: 10_000,
      frames: 4,
      frameBytes: 4 * KIB,
      closedVolume: quick ? 2 * MIB : 32 * MIB,
      resumeAfterMs: quick ? 30_000 : HOUR_MS,
    },
    m4: {
      bytes: MIB,
      periodsMs: quick ? [20_000, 40_000, 60_000] : [10 * MINUTE_MS, 60 * MINUTE_MS, 100 * MINUTE_MS],
    },
    m5: { sockets: quick ? [4, 8] : [64, 256], frames: quick ? 1_024 : 8_192, attempts: quick ? 1 : 3 },
    m6: { clients: quick ? [1, 4] : [1, 16, 64], frames: quick ? 4_096 : 65_536 },
  };
}

/** @typedef {ReturnType<typeof planOf>} Plan */
/** @typedef {{ id: string, at: number, kind: "fresh" | "wake" }} Start */
/**
 * @typedef {{ start: Start, at: number, heldMib: number, keepalive: boolean,
 *   sockets: { name: string, readyState: number }[],
 *   events: { at: number, name: string, kind: string, code: number | null, reason: string | null }[],
 *   surface: unknown }} State
 */
/** @typedef {{ start: Start, at: number, firstSeq: number, frames: number, bytes: number }} HandAnswer */

/**
 * @param {number} ms
 * @param {AbortSignal} signal
 */
function sleep(ms, signal) {
  return new Promise((done, fail) => {
    if (signal.aborted) {
      fail(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      done(undefined);
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      fail(new Error("aborted"));
    };
    signal.addEventListener("abort", stop, { once: true });
  });
}

/**
 * Waits until `ready()` holds, checking every 200 ms; false after `timeoutMs`.
 * @param {() => boolean} ready
 * @param {number} timeoutMs
 * @param {AbortSignal} signal
 */
async function until(ready, timeoutMs, signal) {
  const end = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() >= end) {
      return false;
    }
    await sleep(200, signal);
  }
  return true;
}

/** A WebSocket client over a raw socket, which reads as its mode says and records what it received. */
class Client {
  /** @type {import("node:net").Socket | null} */
  #socket = null;
  #header = Buffer.alloc(14);
  #headerLength = 0;
  /** @type {{ fin: boolean, opcode: number, length: number } | null} */
  #frame = null;
  #need = 0;
  /** @type {Buffer[]} */
  #control = [];
  /** @type {Buffer[]} */
  #head = [];
  #headLength = 0;
  #messageBytes = 0;
  #closeCode = /** @type {number | null} */ (null);
  #closeReason = "";
  // Summary of the frames received since the last flush.
  #summary = { frames: 0, bytes: 0, lastSeq: -1, minAge: Infinity, maxAge: -Infinity };
  #readSince = 0;
  #throttleStart = 0;
  #throttleRead = 0;
  /** @type {NodeJS.Timeout | null} */
  #timer = null;
  #paused = false;

  handedBytes = 0;
  receivedBytes = 0;
  receivedFrames = 0;
  ended = false;
  /** @type {Promise<void>} */
  closed;
  /** @type {() => void} */
  #onClosed = () => {};

  /**
   * @param {Run} run
   * @param {string} name
   * @param {{ mode: "control" | "stopped" } | { mode: "throttled", rate: number }
   *   | { mode: "intermittent", bytes: number, periodMs: number }} reading
   */
  constructor(run, name, reading) {
    this.run = run;
    this.name = name;
    this.reading = reading;
    this.closed = new Promise((done) => {
      this.#onClosed = done;
    });
  }

  get backlog() {
    return this.handedBytes - this.receivedBytes;
  }

  /** Opens the socket and resolves once the 101 arrived. */
  connect() {
    const { target } = this.run;
    const key = randomBytes(16).toString("base64");
    const request = [
      `GET /ws?name=${encodeURIComponent(this.name)} HTTP/1.1`,
      `Host: ${target.host}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      `Authorization: Bearer ${target.token}`,
      "",
      "",
    ].join("\r\n");
    const accept = createHash("sha1")
      .update(key + WEBSOCKET_GUID)
      .digest("base64");
    return new Promise((done, fail) => {
      const socket = !target.local
        ? tlsConnect({ host: target.host, port: target.port, servername: target.host }, () => socket.write(request))
        : tcpConnect({ host: "127.0.0.1", port: target.port }, () => socket.write(request));
      this.#socket = socket;
      /** @type {Buffer[]} */
      const response = [];
      /** @param {Buffer} chunk */
      const onHandshake = (chunk) => {
        response.push(chunk);
        const all = Buffer.concat(response);
        const end = all.indexOf("\r\n\r\n");
        if (end < 0) {
          return;
        }
        socket.off("data", onHandshake);
        const head = all.subarray(0, end).toString("latin1");
        const accepted = head
          .split("\r\n")
          .some((line) => /^sec-websocket-accept:/i.test(line) && line.slice(line.indexOf(":") + 1).trim() === accept);
        if (!head.startsWith("HTTP/1.1 101 ") || !accepted) {
          socket.destroy();
          fail(new Error(`${this.name}: handshake refused: ${head.split("\r\n")[0] ?? ""}`));
          return;
        }
        socket.on("data", (data) => this.#onData(/** @type {Buffer} */ (data)));
        this.#throttleStart = Date.now();
        if (this.reading.mode === "intermittent") {
          this.#timer = setInterval(() => this.#readPeriod(), this.reading.periodMs);
        }
        done(undefined);
        const rest = all.subarray(end + 4);
        if (rest.length > 0) {
          this.#onData(rest);
        }
      };
      socket.on("data", onHandshake);
      socket.on("error", (error) => {
        this.#closeReason ||= String(error);
        fail(error);
      });
      socket.on("close", () => this.#ended());
    });
  }

  /** @param {Buffer} chunk */
  #onData(chunk) {
    let i = 0;
    while (i < chunk.length) {
      if (this.#frame === null) {
        const take = Math.min(chunk.length - i, this.#header.length - this.#headerLength);
        chunk.copy(this.#header, this.#headerLength, i, i + take);
        const before = this.#headerLength;
        this.#headerLength += take;
        const parsed = parseFrameHeader(this.#header, this.#headerLength);
        if (parsed === null) {
          i += take;
          continue;
        }
        i += parsed.headerLength - before;
        this.#headerLength = 0;
        this.#frame = parsed;
        this.#need = parsed.length;
        if (parsed.opcode === 1 || parsed.opcode === 2) {
          this.#head = [];
          this.#headLength = 0;
          this.#messageBytes = 0;
        }
      } else {
        const take = Math.min(chunk.length - i, this.#need);
        const part = chunk.subarray(i, i + take);
        if (this.#frame.opcode >= 8) {
          this.#control.push(Buffer.from(part));
        } else {
          if (this.#headLength < 48) {
            const kept = Buffer.from(part.subarray(0, 48 - this.#headLength));
            this.#head.push(kept);
            this.#headLength += kept.length;
          }
          this.#messageBytes += take;
        }
        this.#need -= take;
        i += take;
      }
      if (this.#frame !== null && this.#need === 0) {
        this.#endFrame(this.#frame);
        this.#frame = null;
      }
    }
    if (this.reading.mode === "throttled") {
      // A token bucket: past the rate, the socket pauses until the rate has caught up.
      this.#throttleRead += chunk.length;
      const ahead = this.#throttleRead - ((Date.now() - this.#throttleStart) * this.reading.rate) / 1000;
      if (ahead > 0 && !this.#paused) {
        this.#paused = true;
        this.#socket?.pause();
        setTimeout(
          () => {
            this.#paused = false;
            this.#socket?.resume();
          },
          (ahead / this.reading.rate) * 1000,
        );
      }
    }
  }

  /** @param {{ fin: boolean, opcode: number }} frame */
  #endFrame(frame) {
    if (frame.opcode >= 8) {
      const payload = Buffer.concat(this.#control);
      this.#control = [];
      if (frame.opcode === 8) {
        this.#closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        this.#closeReason = payload.subarray(2).toString("utf8");
        this.#write(8, payload.subarray(0, 2));
        this.#socket?.end();
      } else if (frame.opcode === 9) {
        this.#write(10, payload);
      }
      return;
    }
    if (!frame.fin) {
      return;
    }
    const head = Buffer.concat(this.#head).toString("latin1");
    const match = /^(\d+) (\d+) /.exec(head);
    const seq = Number(match?.[1] ?? -1);
    const handAt = Number(match?.[2] ?? Number.NaN);
    const age = Date.now() - handAt;
    if (seq === 0) {
      // Frame 0 is handed by the object as it accepts the socket.
      this.handedBytes += this.#messageBytes;
      this.run.record({
        type: "hand",
        client: this.name,
        at: handAt,
        firstSeq: 0,
        frames: 1,
        bytes: this.#messageBytes,
      });
    }
    this.receivedFrames += 1;
    this.receivedBytes += this.#messageBytes;
    const s = this.#summary;
    s.frames += 1;
    s.bytes += this.#messageBytes;
    s.lastSeq = Math.max(s.lastSeq, seq);
    s.minAge = Math.min(s.minAge, age);
    s.maxAge = Math.max(s.maxAge, age);
    this.#readSince += this.#messageBytes;
    if (this.reading.mode === "stopped" && seq === 0) {
      this.pause();
    } else if (this.reading.mode === "intermittent" && this.#readSince >= this.reading.bytes && !this.#paused) {
      this.pause();
    }
  }

  // An intermittent client's period: it reads its amount, then pauses until the next period.
  #readPeriod() {
    this.#readSince = 0;
    this.resume();
  }

  pause() {
    if (this.#socket !== null && !this.ended) {
      this.#paused = true;
      this.#socket.pause();
      this.run.record({ type: "pause", client: this.name, at: Date.now() });
    }
  }

  resume() {
    if (this.#socket !== null && !this.ended) {
      this.#paused = false;
      this.#socket.resume();
      this.run.record({ type: "resume", client: this.name, at: Date.now() });
    }
  }

  /**
   * @param {number} opcode
   * @param {Buffer} payload at most 125 bytes
   */
  #write(opcode, payload) {
    if (this.#socket === null || this.#socket.destroyed) {
      return;
    }
    const mask = randomBytes(4);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i += 1) {
      masked[i] = /** @type {number} */ (masked[i]) ^ /** @type {number} */ (mask[i % 4]);
    }
    this.#socket.write(Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | masked.length]), mask, masked]));
  }

  /** Records a summary of the frames received since the last one, if any. */
  flush() {
    const s = this.#summary;
    if (s.frames > 0) {
      this.run.record({ type: "recv", client: this.name, at: Date.now(), ...s });
    }
    this.#summary = { frames: 0, bytes: 0, lastSeq: -1, minAge: Infinity, maxAge: -Infinity };
  }

  /** Closes the socket from this side, as the driver's own step (not an end the runtime chose). */
  close() {
    if (this.#socket === null || this.ended) {
      return;
    }
    this.run.record({ type: "closed", client: this.name, at: Date.now(), by: "client" });
    this.#socket.destroy();
  }

  #ended() {
    if (this.ended) {
      return;
    }
    this.ended = true;
    if (this.#timer !== null) {
      clearInterval(this.#timer);
    }
    this.flush();
    this.run.record({
      type: "end",
      client: this.name,
      at: Date.now(),
      side: "client",
      code: this.#closeCode ?? 1006,
      reason: this.#closeReason,
    });
    this.#onClosed();
  }
}

/**
 * A WebSocket frame header from a server (unmasked), or null while incomplete.
 * @param {Buffer} buffer
 * @param {number} length
 */
function parseFrameHeader(buffer, length) {
  if (length < 2) {
    return null;
  }
  const b0 = /** @type {number} */ (buffer[0]);
  const b1 = /** @type {number} */ (buffer[1]);
  if ((b1 & 0x80) !== 0) {
    throw new Error("a masked frame from the server");
  }
  const short = b1 & 0x7f;
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  if (short < 126) {
    return { fin, opcode, length: short, headerLength: 2 };
  }
  if (short === 126) {
    return length < 4 ? null : { fin, opcode, length: buffer.readUInt16BE(2), headerLength: 4 };
  }
  return length < 10 ? null : { fin, opcode, length: Number(buffer.readBigUInt64BE(2)), headerLength: 10 };
}

/**
 * Where a run's object answers.
 * @typedef {{ base: string, host: string, port: number, token: string, local: boolean, workerdPid: number | null }}
 *   Target
 */

/**
 * @param {Target} target
 * @param {"GET" | "POST"} method
 * @param {string} path
 * @returns {Promise<{ status: number, body: unknown }>}
 */
async function call(target, method, path) {
  const response = await fetch(target.base + path, {
    method,
    headers: { authorization: `Bearer ${target.token}` },
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  let body;
  try {
    body = /** @type {unknown} */ (JSON.parse(text));
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

/**
 * The object's state, or null when it does not answer.
 * @param {Target} target
 * @returns {Promise<State | null>}
 */
async function stateOf(target) {
  try {
    const { status, body } = await call(target, "GET", "/state");
    return status === 200 ? /** @type {State} */ (body) : null;
  } catch {
    return null;
  }
}

/**
 * @param {Target} target
 * @param {number} timeoutMs
 * @param {AbortSignal} signal
 */
async function answeringState(target, timeoutMs, signal) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const state = await stateOf(target);
    if (state !== null) {
      return state;
    }
    if (Date.now() >= end) {
      throw new Error(`${target.base} does not answer`);
    }
    await sleep(1_000, signal);
  }
}

/** One run: its records, its clients, and the poller that reads the object's state. */
class Run {
  /** @type {Client[]} */
  clients = [];
  probing = false;
  // The MiB the running headroom probe holds.
  probeHeld = 0;
  /** @type {State | null} */
  #last = null;
  #lastAt = 0;
  #seenEvents = 0;
  #listing = "";
  /** @type {Promise<void>} */
  #polling = Promise.resolve();
  /** @type {NodeJS.Timeout | null} */
  #timer = null;

  /**
   * @param {Context} context
   * @param {Target} target
   * @param {string} id
   * @param {Record<string, unknown>} head
   */
  constructor(context, target, id, head) {
    this.context = context;
    this.target = target;
    this.id = id;
    this.signal = context.signal;
    this.record({ type: "run", at: Date.now(), mode: target.local ? "local" : "deployed", ...head });
  }

  /** @param {Record<string, unknown>} observation */
  record(observation) {
    this.context.write({ ...observation, run: this.id });
  }

  async begin() {
    const state = await answeringState(this.target, 60_000, this.signal);
    this.#last = state;
    this.#lastAt = Date.now();
    this.#seenEvents = state.events.length;
    this.record({ type: "surface", at: Date.now(), surface: state.surface });
    this.#timer = setInterval(() => {
      void this.poll();
      for (const client of this.clients) {
        client.flush();
      }
    }, STATE_MS);
  }

  /** Reads the object's state once, after any read already running. */
  poll() {
    this.#polling = this.#polling.then(() => this.#pollOnce());
    return this.#polling;
  }

  async #pollOnce() {
    const state = await stateOf(this.target);
    if (state === null) {
      return;
    }
    const last = this.#last;
    if (last !== null && state.start.id !== last.start.id) {
      this.record({
        type: "start",
        at: Date.now(),
        id: state.start.id,
        kind: state.start.kind,
        since: this.#lastAt,
        listedBefore: last.sockets.filter((s) => s.name.startsWith(`${this.id}.`)).length,
        heldMibBefore: Math.max(last.heldMib, this.probing ? this.probeHeld : 0),
        probe: this.probing,
      });
    }
    const mine = state.sockets.filter((s) => s.name.startsWith(`${this.id}.`));
    const listing = JSON.stringify(mine.map((s) => [s.name, s.readyState]));
    if (listing !== this.#listing) {
      this.#listing = listing;
      this.record({ type: "listed", at: Date.now(), sockets: mine.map((s) => [s.name, s.readyState]) });
    }
    for (const event of state.events.slice(this.#seenEvents)) {
      if ((event.kind === "close" || event.kind === "error") && event.name.startsWith(`${this.id}.`)) {
        this.record({
          type: "end",
          client: event.name,
          at: event.at,
          side: "server",
          code: event.code,
          reason: event.reason ?? "",
        });
      }
    }
    this.#seenEvents = state.events.length;
    this.#last = state;
    this.#lastAt = Date.now();
  }

  /**
   * Opens a client named `<run>.<role>` and waits for its frame 0.
   * @param {string} role
   * @param {ConstructorParameters<typeof Client>[2]} reading
   */
  async client(role, reading) {
    const client = new Client(this, `${this.id}.${role}`, reading);
    this.clients.push(client);
    await client.connect();
    await until(() => client.receivedFrames > 0 || client.ended, 60_000, this.signal);
    return client;
  }

  /**
   * Hands `frames` frames of `bytes` to `client`; null when its socket is no longer open.
   * @param {Client} client
   * @param {number} frames
   * @param {number} bytes
   */
  async hand(client, frames, bytes) {
    if (client.ended) {
      return null;
    }
    // What the client received so far is recorded before the hand, so the backlog read from the records is the one
    // the driver saw.
    client.flush();
    const query = `name=${encodeURIComponent(client.name)}&frames=${frames}&bytes=${bytes}`;
    let answer;
    try {
      answer = await call(this.target, "POST", `/hand?${query}`);
    } catch (error) {
      this.record({ type: "hand-failed", client: client.name, at: Date.now(), error: String(error) });
      return null;
    }
    if (answer.status !== 200) {
      this.record({ type: "hand-failed", client: client.name, at: Date.now(), status: answer.status });
      return null;
    }
    const hand = /** @type {HandAnswer} */ (answer.body);
    client.handedBytes += hand.bytes;
    this.record({
      type: "hand",
      client: client.name,
      at: hand.at,
      firstSeq: hand.firstSeq,
      frames: hand.frames,
      bytes: hand.bytes,
    });
    return hand;
  }

  /**
   * The object closes `client` with 1013.
   * @param {Client} client
   */
  async closeByObject(client) {
    const { body } = await call(this.target, "POST", `/close?name=${encodeURIComponent(client.name)}`);
    this.record({ type: "closed", client: client.name, at: /** @type {{ at: number }} */ (body).at, by: "object" });
  }

  /**
   * The workerd process's resident memory, sampled after `settleMs` (local only).
   * @param {string} stage
   * @param {number} attempt
   */
  async sampleRss(stage, attempt) {
    const pid = this.target.workerdPid;
    if (pid === null) {
      return;
    }
    await sleep(2_000, this.signal);
    const kib = Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim());
    this.record({ type: "rss", at: Date.now(), attempt, stage, bytes: kib * KIB });
  }

  /**
   * The headroom probe: /alloc in 1 MiB steps until the object resets, records the MiB it held before.
   * @param {number} attempt
   * @param {string | undefined} stage
   */
  async probe(attempt, stage) {
    await this.poll();
    const cap = this.target.local ? PROBE_CAP_MIB.local : PROBE_CAP_MIB.deployed;
    const before = (await answeringState(this.target, 60_000, this.signal)).start.id;
    this.probing = true;
    let held = 0;
    let capped = false;
    let error = null;
    for (;;) {
      if (held >= cap) {
        capped = true;
        break;
      }
      let answer;
      try {
        answer = await call(this.target, "POST", "/alloc?mib=1");
      } catch (thrown) {
        error = String(thrown);
        break;
      }
      const body = /** @type {{ start?: Start, heldMib?: number }} */ (answer.body);
      if (answer.status !== 200 || body.start?.id !== before) {
        error = `status ${answer.status}`;
        break;
      }
      held = body.heldMib ?? held;
      this.probeHeld = held;
    }
    const after = await answeringState(this.target, 5 * MINUTE_MS, this.signal);
    // A wake from hibernation also starts the object anew, but keeps its sockets and loses no output: not a reset.
    const reset = after.start.id !== before && after.start.kind === "fresh";
    await this.poll();
    this.probing = false;
    this.probeHeld = 0;
    if (!reset) {
      await call(this.target, "POST", "/release");
    }
    this.record({
      type: "headroom",
      at: Date.now(),
      attempt,
      ...(stage === undefined ? {} : { stage }),
      bytes: reset ? held * MIB : null,
      capped,
      error: reset ? null : error,
    });
  }

  /** Ends the run: its last summaries and state, then the `done` record; then closes the clients still open. */
  async done() {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
    }
    for (const client of this.clients) {
      client.flush();
    }
    await this.poll();
    this.record({ type: "done", at: Date.now() });
    for (const client of this.clients) {
      client.close();
    }
  }
}

/**
 * @typedef {{ signal: AbortSignal, plan: Plan, write: (observation: Record<string, unknown>) => void,
 *   log: (line: string) => void }} Context
 */

/**
 * @param {Context} context
 * @param {Target} target
 */
async function m1(context, target) {
  const { plan, signal } = context;
  const { volumes, shapes, attempts, batchMs, stopped } = plan.m1;
  await call(target, "POST", "/keepalive?on=1");
  const baseline = new Run(context, target, "m1-none", { measurement: "m1", volume: 0 });
  await baseline.begin();
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    context.log(`m1: headroom with nothing held, attempt ${attempt}`);
    await baseline.probe(attempt, undefined);
  }
  await baseline.done();
  for (const shape of shapes) {
    for (const volume of volumes) {
      const id = `m1-${shape.frameBytes}b-${volume / MIB}m`;
      const run = new Run(context, target, id, {
        measurement: "m1",
        volume,
        frameBytes: shape.frameBytes,
        baseline: baseline.id,
      });
      await run.begin();
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        context.log(`${id}: holding, attempt ${attempt}`);
        const control = await run.client(`c${attempt}`, { mode: "control" });
        /** @type {Client[]} */
        const clients = [];
        for (let i = 0; i < stopped; i += 1) {
          clients.push(await run.client(`s${attempt}-${i}`, { mode: "stopped" }));
        }
        let handed = 0;
        for (let batch = 0; handed < volume; batch += 1) {
          const tick = Date.now();
          await run.hand(control, 1, 64);
          await until(() => control.backlog <= 0 || control.ended, MINUTE_MS, signal);
          const client = /** @type {Client} */ (clients[batch % clients.length]);
          const frames = Math.min(shape.frames, Math.ceil((volume - handed) / shape.frameBytes));
          const answer = await run.hand(client, frames, shape.frameBytes);
          if (answer === null) {
            break;
          }
          handed += answer.bytes;
          await sleep(Math.max(0, tick + batchMs - Date.now()), signal);
        }
        context.log(`${id}: headroom with ${handed} bytes handed, attempt ${attempt}`);
        await run.probe(attempt, undefined);
        for (const client of clients) {
          client.resume();
        }
        await until(() => clients.every((c) => c.ended || c.backlog <= 0), DRAIN_WAIT_MS, signal);
        for (const client of [control, ...clients]) {
          client.flush();
          client.close();
        }
      }
      await run.done();
    }
  }
}

/**
 * @param {Context} context
 * @param {Target} target
 */
async function m2(context, target) {
  const { plan, signal } = context;
  const p = plan.m2;
  const run = new Run(context, target, "m2", { measurement: "m2" });
  await run.begin();
  const control = await run.client("c", { mode: "control" });
  /** @type {Client[]} */
  const stopped = [];
  for (const role of ["s1", "s2", "s3"]) {
    stopped.push(await run.client(role, { mode: "stopped" }));
  }
  const closing = await run.client("s4", { mode: "stopped" });
  context.log(`m2: handing ${p.closedVolume} bytes to the client the object closes`);
  for (let handed = 0; handed < p.closedVolume;) {
    const answer = await run.hand(closing, 2, 512 * KIB);
    if (answer === null) {
      break;
    }
    handed += answer.bytes;
    await sleep(2_000, signal);
  }
  await run.closeByObject(closing);
  const start = Date.now();
  let resumed = false;
  while (Date.now() - start < plan.durationMs && ![...stopped, closing].every((c) => c.ended)) {
    const tick = Date.now();
    await Promise.all([control, ...stopped].map((c) => run.hand(c, p.frames, p.frameBytes)));
    if (!resumed && Date.now() - start >= p.resumeAfterMs) {
      context.log("m2: the closed client resumes");
      closing.resume();
      resumed = true;
    }
    await sleep(Math.max(0, tick + p.handMs - Date.now()), signal);
  }
  await run.done();
}

/**
 * Hands each client what `framesToHand` allows every second, and the control a frame every 10 s, for the plan's
 * duration or until every paced client ended.
 * @param {Context} context
 * @param {Run} run
 * @param {Client} control
 * @param {Client[]} clients
 */
async function paced(context, run, control, clients) {
  const start = Date.now();
  for (let second = 0; Date.now() - start < context.plan.durationMs; second += 1) {
    const open = clients.filter((c) => !c.ended);
    if (open.length === 0) {
      break;
    }
    const tick = Date.now();
    const counts = framesToHand(
      open.map((c) => ({ handed: c.handedBytes, received: c.receivedBytes })),
      PACED_FRAME_BYTES,
      OFFERED_BYTES_PER_SECOND / PACED_FRAME_BYTES,
    );
    await Promise.all(
      open.map((c, i) =>
        (counts[i] ?? 0) > 0 ? run.hand(c, counts[i] ?? 0, PACED_FRAME_BYTES) : Promise.resolve(null),
      ),
    );
    if (second % 10 === 0) {
      await run.hand(control, 1, 64);
    }
    await sleep(Math.max(0, tick + 1_000 - Date.now()), context.signal);
  }
  await run.done();
}

/**
 * @param {Context} context
 * @param {Target} target
 */
async function m3(context, target) {
  const run = new Run(context, target, "m3", { measurement: "m3" });
  await run.begin();
  const control = await run.client("c", { mode: "control" });
  /** @type {Client[]} */
  const clients = [];
  for (const rate of THROTTLED_RATES) {
    clients.push(await run.client(`t${rate / KIB}k`, { mode: "throttled", rate }));
  }
  context.log("m3: throttled clients");
  await paced(context, run, control, clients);
}

/**
 * @param {Context} context
 * @param {Target} target
 */
async function m4(context, target) {
  const { bytes, periodsMs } = context.plan.m4;
  const run = new Run(context, target, "m4", { measurement: "m4" });
  await run.begin();
  const control = await run.client("c", { mode: "control" });
  /** @type {Client[]} */
  const clients = [];
  for (const periodMs of periodsMs) {
    const client = await run.client(`i${periodMs / 1000}s`, { mode: "intermittent", bytes, periodMs });
    client.pause();
    clients.push(client);
  }
  context.log("m4: intermittent clients");
  await paced(context, run, control, clients);
}

/**
 * @param {Context} context
 * @param {Target} target
 */
async function m5(context, target) {
  const { plan, signal } = context;
  await call(target, "POST", "/keepalive?on=1");
  for (const count of plan.m5.sockets) {
    const run = new Run(context, target, `m5-${count}`, { measurement: "m5", sockets: count });
    await run.begin();
    for (let attempt = 1; attempt <= plan.m5.attempts; attempt += 1) {
      context.log(`m5: ${count} sockets, attempt ${attempt}`);
      if (target.local) {
        await run.sampleRss("baseline", attempt);
      } else {
        await run.probe(attempt, "baseline");
      }
      /** @type {Client[]} */
      const clients = [];
      for (let i = 0; i < count; i += 1) {
        clients.push(await run.client(`a${attempt}-${i}`, { mode: "stopped" }));
      }
      await run.sampleRss("open", attempt);
      for (const client of clients) {
        await run.hand(client, plan.m5.frames, 64);
        client.resume();
        await until(() => client.ended || client.backlog <= 0, DRAIN_WAIT_MS, signal);
      }
      if (target.local) {
        await run.sampleRss("drained", attempt);
      } else {
        await run.probe(attempt, "drained");
      }
      for (const client of clients) {
        client.close();
      }
      await Promise.all(clients.map((c) => c.closed));
      await run.sampleRss("closed", attempt);
    }
    await run.done();
  }
}

/**
 * @param {Context} context
 * @param {Target} target
 */
async function m6(context, target) {
  const { plan } = context;
  if (!target.local) {
    context.log("m6: local only, skipped");
    return;
  }
  for (const count of plan.m6.clients) {
    const run = new Run(context, target, `m6-${count}`, { measurement: "m6", clients: count });
    await run.begin();
    context.log(`m6: ${count} stopped clients`);
    await run.sampleRss("baseline", 1);
    /** @type {Client[]} */
    const clients = [];
    for (let i = 0; i < count; i += 1) {
      clients.push(await run.client(`s${i}`, { mode: "stopped" }));
    }
    for (const client of clients) {
      await run.hand(client, plan.m6.frames, 64);
    }
    await run.sampleRss("held", 1);
    for (const client of clients) {
      client.close();
    }
    await Promise.all(clients.map((c) => c.closed));
    await run.sampleRss("closed", 1);
    await run.done();
  }
}

const MEASUREMENTS = { m1, m2, m3, m4, m5, m6 };
/** @typedef {keyof typeof MEASUREMENTS} Measurement */

// The compatibility date and flags the package deploys with.
async function compatibility() {
  // The reader wrangler deploys with; its declared types live in a package this one does not depend on.
  const { experimental_readRawConfig: readRawConfig } =
    /** @type {{ experimental_readRawConfig: (args: { config: string }) => { rawConfig: unknown } }} */ (
      /** @type {unknown} */ (await import("wrangler"))
    );
  const raw = /** @type {{ compatibility_date?: string, compatibility_flags?: string[] }} */ (
    readRawConfig({ config: join(packageRoot, "wrangler.jsonc") }).rawConfig
  );
  if (raw.compatibility_date === undefined) {
    throw new Error("wrangler.jsonc names no compatibility_date");
  }
  return { date: raw.compatibility_date, flags: raw.compatibility_flags ?? [] };
}

/**
 * @param {string} name
 * @param {{ date: string, flags: string[] }} compat
 * @param {string} token what every request to the object must carry
 */
function workerConfig(name, compat, token) {
  return {
    name,
    main: "worker.ts",
    compatibility_date: compat.date,
    compatibility_flags: compat.flags,
    workers_dev: true,
    vars: { BENCH_TOKEN: token },
    durable_objects: { bindings: [{ name: "HELD", class_name: "HeldOutput" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["HeldOutput"] }],
  };
}

/**
 * A free TCP port on 127.0.0.1.
 * @returns {Promise<number>}
 */
function freePort() {
  return new Promise((done, fail) => {
    const server = createServer();
    server.on("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => done(typeof address === "object" && address !== null ? address.port : 0));
    });
  });
}

/**
 * The PID of the workerd process under `root`, from the process table.
 * @param {number} root
 */
function workerdUnder(root) {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,comm="], { encoding: "utf8" })
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((m) => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), comm: basename(m[3] ?? "") }));
  const under = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) {
      if (under.has(row.ppid) && !under.has(row.pid)) {
        under.add(row.pid);
        grew = true;
      }
    }
  }
  return rows.find((row) => under.has(row.pid) && row.comm.includes("workerd"))?.pid ?? null;
}

/**
 * Runs `fn` against the bench object, deployed or local, and removes it however `fn` ends.
 * @param {{ local: boolean, compat: { date: string, flags: string[] }, out: string, label: string,
 *   signal: AbortSignal, log: (line: string) => void }} options
 * @param {(target: Target) => Promise<void>} fn
 */
async function withTarget({ local, compat, out, label, signal, log }, fn) {
  const dir = mkdtempSync(join(tmpdir(), "kopje-bench-held-"));
  const name = `kopje-bench-held-${randomBytes(4).toString("hex")}`;
  // The deployed object is public on workers.dev while it runs: it answers only requests that carry this run's token.
  const token = randomBytes(32).toString("hex");
  const config = join(dir, "wrangler.jsonc");
  // A copy of the object's source: `wrangler dev` reloads on a change to its main module, which would reset the
  // object mid-run if the tree were edited.
  copyFileSync(join(here, "worker.ts"), join(dir, "worker.ts"));
  writeFileSync(config, JSON.stringify(workerConfig(name, compat, token), null, 2));
  const setup = { dir, name, config, token, logFile: join(out, `wrangler-${label}.log`), signal, log };
  try {
    if (local) {
      await runLocal(setup, fn);
    } else {
      await runDeployed(setup, fn);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * @typedef {{ dir: string, name: string, config: string, token: string, logFile: string, signal: AbortSignal,
 *   log: (line: string) => void }} Setup
 */

/**
 * @param {Setup} setup
 * @param {(target: Target) => Promise<void>} fn
 */
async function runLocal({ dir, config, token, logFile, signal, log }, fn) {
  const port = await freePort();
  const inspector = await freePort();
  const output = createWriteStream(logFile);
  const child = spawn(
    process.execPath,
    [
      wrangler,
      "dev",
      "--config",
      config,
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      String(inspector),
      "--persist-to",
      join(dir, "state"),
      "--log-level",
      "warn",
    ],
    { cwd: dir, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
  );
  child.stdout.pipe(output);
  child.stderr.pipe(output);
  const exited = new Promise((done) => child.on("exit", done));
  let workerd = null;
  try {
    /** @type {Target} */
    const target = {
      base: `http://127.0.0.1:${port}`,
      host: `127.0.0.1:${port}`,
      port,
      token,
      local: true,
      workerdPid: null,
    };
    await answeringState(target, 2 * MINUTE_MS, signal);
    workerd = child.pid === undefined ? null : workerdUnder(child.pid);
    target.workerdPid = workerd;
    log(`local: wrangler dev on port ${port}, workerd ${workerd ?? "not found"}`);
    await fn(target);
  } finally {
    child.kill("SIGINT");
    /** @type {Promise<boolean>} */
    const waited = new Promise((done) => setTimeout(() => done(false), 15_000));
    const stopped = await Promise.race([exited.then(() => true), waited]);
    if (!stopped) {
      child.kill("SIGKILL");
    }
    // The workerd process wrangler started stops with it; if it outlives it, it is stopped by its own PID.
    if (workerd !== null) {
      try {
        process.kill(workerd, 0);
        process.kill(workerd, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    output.end();
  }
}

/**
 * @param {Setup} setup
 * @param {(target: Target) => Promise<void>} fn
 */
async function runDeployed({ dir, name, config, token, logFile, signal, log }, fn) {
  try {
    log(`deploying ${name}`);
    let printed;
    try {
      printed = execFileSync(process.execPath, [wrangler, "deploy", "--config", config], {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const { stdout, stderr } = /** @type {{ stdout?: string, stderr?: string }} */ (error);
      writeFileSync(logFile, `${stdout ?? ""}${stderr ?? ""}`);
      throw error;
    }
    writeFileSync(logFile, printed);
    const url = /https:\/\/[\w.-]+\.workers\.dev/.exec(printed)?.[0];
    if (url === undefined) {
      throw new Error(`${name}: deploy printed no workers.dev URL (${logFile})`);
    }
    const host = new URL(url).host;
    /** @type {Target} */
    const target = { base: url, host, port: 443, token, local: false, workerdPid: null };
    await answeringState(target, 5 * MINUTE_MS, signal);
    log(`${name}: ${url}`);
    await fn(target);
  } finally {
    log(`deleting ${name}`);
    try {
      execFileSync(process.execPath, [wrangler, "delete", "--config", config, "--force"], {
        cwd: dir,
        stdio: ["ignore", "ignore", "inherit"],
      });
    } catch {
      console.error(`held-output: deleting ${name} failed; delete it with: pnpm exec wrangler delete ${name} --force`);
    }
  }
}

/** @param {string[]} argv */
async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      local: { type: "boolean", default: false },
      runs: { type: "string" },
      out: { type: "string" },
      quick: { type: "boolean", default: false },
    },
  });
  const local = values.local;
  const known = /** @type {Measurement[]} */ (Object.keys(MEASUREMENTS));
  const runs = /** @type {Measurement[]} */ (
    (values.runs ?? (local ? "m5,m6" : "m1,m2,m3,m4,m5")).split(",").map((r) => r.trim().toLowerCase())
  );
  const unknown = runs.filter((r) => !known.includes(r));
  if (unknown.length > 0) {
    throw new Error(`unknown runs: ${unknown.join(", ")} (known: ${known.join(", ")})`);
  }
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const out = resolve(values.out ?? join(process.env["INIT_CWD"] ?? process.cwd(), `held-output-${stamp}`));
  mkdirSync(out, { recursive: true });
  const observations = join(out, "observations.jsonl");
  const stream = createWriteStream(observations, { flags: "a" });
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort(new Error("interrupted")));
  /** @param {string} line */
  const log = (line) => console.log(`held-output: ${line}`);
  /** @type {Context} */
  const context = {
    signal: controller.signal,
    plan: planOf(values.quick),
    write: (observation) => stream.write(`${JSON.stringify(observation)}\n`),
    log,
  };
  const compat = await compatibility();
  log(`compatibility ${compat.date} [${compat.flags.join(", ")}], ${local ? "local" : "deployed"}, output ${out}`);
  // Deployed, M1 and M5 share a Worker and the others each get their own, all at once; locally each runs in turn.
  /** @type {Measurement[][]} */
  const groups = local
    ? runs.map((r) => [r])
    : [runs.filter((r) => r === "m1" || r === "m5"), ...runs.filter((r) => r !== "m1" && r !== "m5").map((r) => [r])];
  /** @param {Measurement[]} group */
  const runGroup = (group) =>
    withTarget({ local, compat, out, label: group.join("-"), signal: controller.signal, log }, async (target) => {
      for (const measurement of group) {
        await MEASUREMENTS[measurement](context, target);
      }
    });
  /** @type {unknown} */
  let failure = null;
  try {
    if (local) {
      for (const group of groups) {
        await runGroup(group);
      }
    } else {
      const settled = await Promise.allSettled(groups.filter((g) => g.length > 0).map(runGroup));
      const rejected = settled.find((s) => s.status === "rejected");
      failure = rejected === undefined ? null : /** @type {unknown} */ (rejected.reason);
    }
  } catch (error) {
    failure = error;
  } finally {
    await new Promise((done) => stream.end(done));
  }
  const report = classify(parseObservations(readFileSync(observations, "utf8")));
  writeFileSync(join(out, "outcomes.json"), `${JSON.stringify(report, null, 2)}\n`);
  for (const run of report.runs) {
    log(`${run.run}: ${run.class}${run.reasons.length > 0 ? ` (${run.reasons.join("; ")})` : ""}`);
  }
  if (report.m1 !== null) {
    log(`m1: ${report.m1.class}`);
  }
  log(`outcomes in ${join(out, "outcomes.json")}`);
  if (failure !== null) {
    throw failure instanceof Error ? failure : new Error("a measurement failed", { cause: failure });
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((/** @type {unknown} */ error) => {
    console.error(error);
    process.exit(1);
  });
}
