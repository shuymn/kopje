// The held-output bench (#1610): measures what the streaming hub's handling of slow clients rests on, on the runtime
// itself, since no signal of unsent output reaches JavaScript (RES-6). It deploys `worker.ts` as a temporary Worker
// named `kopje-bench-held-<random>` at the compatibility date and flags of the package's wrangler.jsonc, drives it
// with clients of its own, writes what it observed as JSON lines and the outcomes `classify.mjs` gives them, and
// deletes the Worker, also when a run fails or the process gets SIGINT, SIGTERM or SIGHUP, and confirms it is gone.
// `--local` runs the same object under `wrangler dev` on the pinned workerd instead and samples the workerd process's
// resident memory.
//
//   pnpm --filter kopje bench:held-output [--local] [--runs m1,m2,...] [--out <dir>] [--quick]
//   pnpm --filter kopje bench:held-output cleanup
//
// Before each deploy, the driver picks a name no Worker of the account has, and writes a record of the Worker (its
// name, its run's id, account and times; no token) to `$XDG_STATE_HOME/kopje/bench-held-output` (`~/.local/state`
// without XDG_STATE_HOME). The Worker carries its run's id (OWNER_VAR), and the driver and `cleanup` delete only a
// Worker that carries the id its record holds; any other is reported, never deleted. A record goes only once its
// Worker is confirmed gone (CLEANUP) and its run's temporary directory, which holds the token's file, is removed. A
// record left behind (the driver was killed, or could not confirm) is what `cleanup` works from; the driver prints
// that command whenever it cannot finish.
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
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  createWriteStream,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createRequire } from "node:module";
import { connect as tcpConnect, createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { connect as tlsConnect } from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspect, parseArgs } from "node:util";

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
// What a client keeps of each message's start to parse: frame 0's `<seq> <ms> <start id> <kind> <generation> ` fits.
const HEAD_BYTES = 128;

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "../..");
const require = createRequire(import.meta.url);
const WRANGLER = join(dirname(require.resolve("wrangler/package.json")), "bin", "wrangler.js");
// How the removal of a deployed Worker waits. It is confirmed gone only when the API says it does not exist (code
// 10007) at least `landingMs` after its deploy command ended: wrangler sends its API requests through undici, whose
// default headers and body timeouts give up on an answer after 300 s, so a request it abandoned may still be carried
// out up to then; 10 minutes, twice that, leaves the API's own processing room. `retryMs` apart, it tries `attempts`
// times to delete it and confirm.
const CLEANUP = { landingMs: 10 * MINUTE_MS, retryMs: 15_000, attempts: 4 };
const RECORDS = join(process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state"), "kopje", "bench-held-output");
const CLEANUP_COMMAND = "pnpm --filter kopje bench:held-output cleanup";

// Every token this process made, in each form wrangler's output could carry it: as is, percent-encoded byte by byte
// (either case), and base64 or base64url at each of the three alignments it can have within a longer encoding.
/** @type {Set<string>} */
const tokenForms = new Set();

/** @param {string} token */
function addToken(token) {
  const bytes = Buffer.from(token, "utf8");
  const percent = [...bytes].map((b) => `%${b.toString(16).padStart(2, "0")}`).join("");
  tokenForms.add(token).add(percent).add(percent.toUpperCase());
  for (let offset = 0; offset < 3; offset += 1) {
    const encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString("base64");
    // The characters that come from the token's bytes alone, whatever precedes or follows them.
    const core = encoded.slice(Math.ceil((4 * offset) / 3), Math.floor((4 * (offset + bytes.length)) / 3));
    tokenForms.add(core).add(core.replaceAll("+", "-").replaceAll("/", "_"));
  }
}

/** @param {string} text */
function masked(text) {
  let result = text;
  for (const form of tokenForms) {
    result = result.replaceAll(form, "<token>");
  }
  return result;
}

/** @param {string} line */
function log(line) {
  console.log(`held-output: ${line}`);
}

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
/** @typedef {{ id: string, at: number, kind: "fresh" | "wake", generation: number }} Start */
// When a question to the object was asked: the clock, and its place among the run's questions and observations.
/** @typedef {{ at: number, seq: number }} Asked */
/**
 * @typedef {{ start: Start, at: number, heldMib: number, keepalive: boolean,
 *   sockets: { name: string, readyState: number }[],
 *   names: Record<string, { frames: number, bytes: number, seq: number }>,
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
  // When the client asked for its socket: the start that answers with frame 0 was alive then.
  /** @type {Asked | null} */
  #connecting = null;

  // Bytes handed, hands whose answer was lost included (`unknownBytes`), and received; frame 0 counts on both sides.
  handedBytes = 0;
  unknownBytes = 0;
  receivedBytes = 0;
  receivedFrames = 0;
  // When frame 0 arrived, and when the socket ended or the driver closed it.
  /** @type {number | null} */
  connectedAt = null;
  // Whether the bench asked for the socket's end (the object's close, or the driver's): such an end is no sign of a
  // reset.
  closeRequested = false;
  /** @type {number | null} */
  endedAt = null;
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
    this.#connecting = this.run.ask();
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
      socket.on("close", () => {
        this.#ended();
        fail(new Error(`${this.name}: closed before the handshake`));
      });
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
          if (this.#headLength < HEAD_BYTES) {
            const kept = Buffer.from(part.subarray(0, HEAD_BYTES - this.#headLength));
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
        // What arrived before the Close is recorded as it arrives, not when the connection finally ends.
        this.flush();
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
    const match = /^(\d+) (\d+) (?:(\S+) (fresh|wake) (\d+) )?/.exec(head);
    const seq = Number(match?.[1] ?? -1);
    const handAt = Number(match?.[2] ?? Number.NaN);
    const age = Date.now() - handAt;
    if (seq === 0) {
      // Frame 0 is handed by the object as it accepts the socket, and names the start that accepted it.
      if (match?.[3] !== undefined && this.#connecting !== null) {
        const start = { id: match[3], kind: match[4] === "wake" ? "wake" : "fresh", generation: Number(match[5]) };
        this.run.saw(/** @type {Start} */ (start), this.#connecting);
      }
      this.connectedAt = Date.now();
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
    this.closeRequested = true;
    this.endedAt ??= Date.now();
    this.run.record({ type: "closed", client: this.name, at: this.endedAt, by: "client" });
    this.#socket.destroy();
  }

  #ended() {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.endedAt ??= Date.now();
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
      receivedFrames: this.receivedFrames,
      receivedBytes: this.receivedBytes,
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
 * @typedef {{ base: string, host: string, port: number, token: string, local: boolean, workerdPid: number | null,
 *   signal: AbortSignal }} Target
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
    signal: AbortSignal.any([target.signal, AbortSignal.timeout(60_000)]),
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
export class Run {
  /** @type {Client[]} */
  clients = [];
  probing = false;
  // The MiB the running headroom probe holds.
  probeHeld = 0;
  // The newest start seen in any answer (a state, a hand, a close, a frame 0), by generation; when the latest of its
  // answers was asked for (the start was alive then, and no later moment is known, however late the answer came); and
  // where its first answer falls among the run's questions and observations.
  /** @type {{ id: string, generation: number, at: number, seenSeq: number } | null} */
  #start = null;
  // Counts the run's questions and observations, so their order never rests on the clock: many fall in one millisecond.
  #sequence = 0;
  // Each generation's start id, as seen since the object's storage was last found lost.
  /** @type {Map<number, string>} */
  #generations = new Map();
  // The run's sockets the newest state listed.
  /** @type {string[]} */
  #listed = [];
  #heldMib = 0;
  /** @type {State | null} */
  #state = null;
  #seenEvents = 0;
  #listing = "";
  #surface = "";
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
    // A stop closes the run's sockets, so nothing waits on a client that will not end by itself.
    this.signal.addEventListener(
      "abort",
      () => {
        for (const client of this.clients) {
          client.close();
        }
      },
      { once: true },
    );
  }

  /** @param {Record<string, unknown>} observation */
  record(observation) {
    this.context.write({ ...observation, run: this.id });
  }

  /**
   * Marks a question about to be asked of the object.
   * @returns {Asked}
   */
  ask() {
    this.#sequence += 1;
    return { at: Date.now(), seq: this.#sequence };
  }

  async begin() {
    const asked = this.ask();
    const state = await answeringState(this.target, 60_000, this.signal);
    this.#seenEvents = state.events.length;
    this.#observe(state, asked);
    this.#timer = setInterval(() => {
      void this.poll();
      for (const client of this.clients) {
        client.flush();
      }
    }, STATE_MS);
  }

  /** Reads the object's state once, after any read already running. */
  poll() {
    this.#polling = this.#polling.then(async () => {
      const asked = this.ask();
      const state = await stateOf(this.target);
      if (state !== null) {
        this.#observe(state, asked);
      }
    });
    return this.#polling;
  }

  /**
   * Notes the start an answer came from, and when that answer was asked for; an answer from an older generation than
   * the newest seen is late, and changes nothing, unless the generations went back (the object's storage was lost),
   * which is recorded as a new start that leaves the run inconclusive, or it cannot be told which (recorded as
   * unordered, which does too). A newer start is recorded with what the run held open under the one before: the
   * sockets the newest state listed and every client connected and not yet ended when the latest answer from that
   * start was asked for (so neither a reset between two polls nor a late answer hides one), less those whose end the
   * bench asked for, and the heap.
   * @param {Start} start
   * @param {Asked} asked
   */
  saw(start, asked) {
    const current = this.#start;
    if (current === null) {
      this.#start = { id: start.id, generation: start.generation, at: asked.at, seenSeq: (this.#sequence += 1) };
      this.#generations.set(start.generation, start.id);
      return;
    }
    // The generations restart when the object's storage is lost: then a generation already seen comes with another
    // start id, or an older generation answers a question asked after the newest start was seen (a late answer can
    // only be to a question asked before). An older generation not seen before, answering a question asked before,
    // is a late answer from a start in between or the first after the storage was lost; nothing tells which.
    const known = this.#generations.get(start.generation);
    const older = start.generation < current.generation;
    const lost = (known !== undefined && known !== start.id) || (older && asked.seq > current.seenSeq);
    if (!lost && start.generation <= current.generation) {
      if (!older) {
        current.at = Math.max(current.at, asked.at);
        return;
      }
      if (known === undefined) {
        this.#generations.set(start.generation, start.id);
        this.record({
          type: "unordered",
          at: Date.now(),
          id: start.id,
          generation: start.generation,
          newest: current.id,
        });
      }
      return;
    }
    const since = current.at;
    /** @param {string} name */
    const closed = (name) => this.clients.some((c) => c.name === name && c.ended && c.closeRequested);
    const open = new Set(this.#listed.filter((name) => !closed(name)));
    for (const c of this.clients) {
      // An end within the millisecond of that last answer may be the reset's own: it counts as held.
      if (c.connectedAt !== null && (c.endedAt === null || (c.endedAt >= since && !c.closeRequested))) {
        open.add(c.name);
      }
    }
    this.record({
      type: "start",
      at: Date.now(),
      id: start.id,
      kind: start.kind,
      generation: start.generation,
      since,
      listedBefore: open.size,
      heldMibBefore: Math.max(this.#heldMib, this.probing ? this.probeHeld : 0),
      probe: this.probing,
      ...(lost ? { storageLost: true } : {}),
    });
    if (lost) {
      this.#generations.clear();
    }
    this.#generations.set(start.generation, start.id);
    this.#start = { id: start.id, generation: start.generation, at: asked.at, seenSeq: (this.#sequence += 1) };
  }

  /**
   * @param {State} state
   * @param {Asked} asked
   */
  #observe(state, asked) {
    this.saw(state.start, asked);
    if (state.start.generation < (this.#start?.generation ?? 0)) {
      // A snapshot from a start already replaced is older than what the run knows of the object.
      return;
    }
    // The runtime's surface, per start, whenever it changes: `sendReturns` is known only once the start has sent.
    const surface = `${state.start.id} ${JSON.stringify(state.surface)}`;
    if (surface !== this.#surface) {
      this.#surface = surface;
      this.record({ type: "surface", at: Date.now(), start: state.start.id, surface: state.surface });
    }
    const mine = state.sockets.filter((s) => s.name.startsWith(`${this.id}.`));
    const listing = JSON.stringify(mine.map((s) => [s.name, s.readyState]));
    if (listing !== this.#listing) {
      this.#listing = listing;
      this.record({ type: "listed", at: Date.now(), sockets: mine.map((s) => [s.name, s.readyState]) });
    }
    this.#listed = mine.map((s) => s.name);
    this.#heldMib = state.heldMib;
    for (const event of state.events.slice(this.#seenEvents)) {
      if ((event.kind === "close" || event.kind === "error") && event.name.startsWith(`${this.id}.`)) {
        // No frame follows the object's view of an end, so what the client has received by now is what it received.
        const client = this.clients.find((c) => c.name === event.name);
        this.record({
          type: "end",
          client: event.name,
          at: event.at,
          side: "server",
          code: event.code,
          reason: event.reason ?? "",
          ...(client === undefined
            ? {}
            : { receivedFrames: client.receivedFrames, receivedBytes: client.receivedBytes }),
        });
      }
    }
    this.#seenEvents = Math.max(this.#seenEvents, state.events.length);
    // The object's totals are what it sent: a hand whose answer was lost is found here, and never counted below them.
    for (const client of this.clients) {
      const totals = state.names[client.name];
      if (totals !== undefined) {
        client.handedBytes = Math.max(client.handedBytes, totals.bytes);
      }
    }
    this.#state = state;
  }

  /**
   * Opens a client named `<run>.<role>` and waits for its frame 0; after the run's first, reads the state, so the
   * runtime's surface is sampled once the start has sent.
   * @param {string} role
   * @param {ConstructorParameters<typeof Client>[2]} reading
   */
  async client(role, reading) {
    const client = new Client(this, `${this.id}.${role}`, reading);
    this.clients.push(client);
    await client.connect();
    await until(() => client.receivedFrames > 0 || client.ended, 60_000, this.signal);
    if (this.clients.length === 1) {
      await this.poll();
    }
    return client;
  }

  /**
   * Hands `frames` frames of `bytes` to `client`; null when it was refused or its answer was lost.
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
    // Reserved before asking: the object may send every frame and the answer still be lost, so a hand counts as held
    // until its answer says otherwise.
    const planned = frames * bytes;
    client.handedBytes += planned;
    /** @param {{ error: string } | { status: number }} why */
    const unknown = (why) => {
      client.unknownBytes += planned;
      this.record({ type: "hand-unknown", client: client.name, at: Date.now(), frames, bytes: planned, ...why });
      return null;
    };
    const query = `name=${encodeURIComponent(client.name)}&frames=${frames}&bytes=${bytes}`;
    let answer;
    const asked = this.ask();
    try {
      answer = await call(this.target, "POST", `/hand?${query}`);
    } catch (error) {
      return unknown({ error: String(error) });
    }
    if (answer.status !== 200) {
      // 400 and 409 are answered before any frame is sent; any other status may come after the sends.
      if (answer.status !== 400 && answer.status !== 409) {
        return unknown({ status: answer.status });
      }
      client.handedBytes -= planned;
      this.record({ type: "hand-refused", client: client.name, at: Date.now(), status: answer.status });
      return null;
    }
    const hand = /** @type {HandAnswer} */ (answer.body);
    this.saw(hand.start, asked);
    client.handedBytes += hand.bytes - planned;
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
    client.closeRequested = true;
    const asked = this.ask();
    const { body } = await call(this.target, "POST", `/close?name=${encodeURIComponent(client.name)}`);
    const closed = /** @type {{ at: number, start: Start }} */ (body);
    this.saw(closed.start, asked);
    this.record({ type: "closed", client: client.name, at: closed.at, by: "object" });
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
   * The headroom probe: /alloc in 1 MiB steps until the object resets, records the MiB it held before. With `holders`
   * (M1's stopped clients), it also records what they held when it began: the bytes handed and not received, the
   * bytes of hands whose answer was lost, the clients already ended, and whether one ended while the probe ran.
   * @param {number} attempt
   * @param {string | undefined} stage
   * @param {Client[]} [holders]
   */
  async probe(attempt, stage, holders = []) {
    await this.poll();
    const cap = this.target.local ? PROBE_CAP_MIB.local : PROBE_CAP_MIB.deployed;
    const before = (await answeringState(this.target, 60_000, this.signal)).start.id;
    const held =
      holders.length === 0
        ? undefined
        : {
            bytes: holders.reduce((sum, c) => sum + c.handedBytes - c.unknownBytes - c.receivedBytes, 0),
            unknown: holders.reduce((sum, c) => sum + c.unknownBytes, 0),
            ended: holders.filter((c) => c.ended).length,
            endedDuringProbe: 0,
          };
    this.probing = true;
    let mib = 0;
    let capped = false;
    let error = null;
    for (;;) {
      if (mib >= cap) {
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
      mib = body.heldMib ?? mib;
      this.probeHeld = mib;
      // The object answered from the same start, so a holder that ended by now did not end by the probe's reset.
      if (held !== undefined) {
        held.endedDuringProbe = holders.filter((c) => c.ended).length - held.ended;
      }
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
      ...(held === undefined ? {} : { held }),
      bytes: reset ? mib * MIB : null,
      capped,
      error: reset ? null : error,
    });
  }

  /**
   * Ends the run: its last summaries and state, the object's totals for each client, then the `done` record; then
   * closes the clients still open.
   */
  async done() {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
    }
    for (const client of this.clients) {
      client.flush();
    }
    await this.poll();
    for (const client of this.clients) {
      const totals = this.#state?.names[client.name];
      if (totals !== undefined) {
        this.record({ type: "totals", client: client.name, at: Date.now(), ...totals });
      }
    }
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
export async function m1(context, target) {
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
        await run.probe(attempt, undefined, clients);
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

// The var each Worker the bench deploys carries, holding its run's id: the driver and `cleanup` delete only a Worker
// that carries the id its record holds, and only report any other.
const OWNER_VAR = "BENCH_RUN";

/** A Worker name under the bench's own prefix, with 64 random bits. */
function workerName() {
  return `kopje-bench-held-${randomBytes(8).toString("hex")}`;
}

/**
 * @param {string} name
 * @param {{ date: string, flags: string[] }} compat
 * @param {string} run the run's id, which marks the Worker as this run's
 */
function workerConfig(name, compat, run) {
  return {
    name,
    main: "worker.ts",
    compatibility_date: compat.date,
    compatibility_flags: compat.flags,
    workers_dev: true,
    vars: { [OWNER_VAR]: run },
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
 * What a caller may replace: the wrangler the driver runs, the waits of the removal, and where the records live.
 * @typedef {{ wrangler?: string, cleanup?: typeof CLEANUP, records?: string }} Overrides
 */

/**
 * Runs `fn` against the bench object, deployed or local, and removes it however `fn` ends.
 * @param {{ local: boolean, compat: { date: string, flags: string[] }, out: string, label: string,
 *   signal: AbortSignal, log: (line: string) => void } & Overrides} options
 * @param {(target: Target) => Promise<void>} fn
 */
export async function withTarget({ local, compat, out, label, signal, log, wrangler, cleanup, records }, fn) {
  const dir = mkdtempSync(join(tmpdir(), "kopje-bench-held-"));
  // Everything written to the directory, the token's file first among them, is removed with it however this ends.
  /** @type {unknown} */
  let failure = null;
  try {
    const name = workerName();
    const run = randomBytes(16).toString("hex");
    // The deployed object is public on workers.dev while it runs: it answers only requests that carry this run's
    // token. The token is a secret binding (`.dev.vars` locally, a secrets file deployed), whose value wrangler never
    // prints, unlike a var's; and whatever the driver prints or keeps shows it masked, wrangler's output included.
    const token = randomBytes(32).toString("hex");
    addToken(token);
    const config = join(dir, "wrangler.jsonc");
    // A copy of the object's source: `wrangler dev` reloads on a change to its main module, which would reset the
    // object mid-run if the tree were edited.
    copyFileSync(join(here, "worker.ts"), join(dir, "worker.ts"));
    writeFileSync(config, JSON.stringify(workerConfig(name, compat, run), null, 2));
    if (local) {
      writeFileSync(join(dir, ".dev.vars"), `BENCH_TOKEN=${token}\n`, { mode: 0o600 });
    } else {
      writeFileSync(join(dir, "secrets.json"), JSON.stringify({ BENCH_TOKEN: token }), { mode: 0o600 });
    }
    /** @type {Setup} */
    const setup = {
      dir,
      name,
      run,
      compat,
      config,
      token,
      env: wranglerEnv(dir),
      wrangler: wrangler ?? WRANGLER,
      cleanup: cleanup ?? CLEANUP,
      records: records ?? RECORDS,
      logFile: join(out, `wrangler-${label}.log`),
      signal,
      log,
    };
    if (local) {
      await runLocal(setup, fn);
    } else {
      await runDeployed(setup, fn);
    }
  } catch (error) {
    failure = error;
  }
  // A deployed run removed the directory already, before it decided on its record; this removes what is left.
  failure = withLeft(failure, removeDirectory(dir));
  if (failure !== null) {
    throw failure instanceof Error ? failure : new Error("the run failed", { cause: failure });
  }
}

/**
 * Removes a run's temporary directory, which holds the token's file: null once it is gone, or what is left, named.
 * @param {string} dir
 */
function removeDirectory(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
    return null;
  } catch (error) {
    return `could not remove ${dir}, which holds the token's file: ${String(error)}`;
  }
}

/**
 * A failure, joined by what was left behind, if anything was.
 * @param {unknown} failure
 * @param {string | null} left
 * @returns {unknown}
 */
function withLeft(failure, left) {
  if (left === null) {
    return failure;
  }
  const error = new Error(left);
  return failure === null ? error : new AggregateError([failure, error], left);
}

/**
 * @typedef {{ dir: string, name: string, run: string, compat: { date: string, flags: string[] }, config: string,
 *   token: string, env: NodeJS.ProcessEnv, wrangler: string, cleanup: typeof CLEANUP, records: string,
 *   logFile: string, signal: AbortSignal, log: (line: string) => void }} Setup
 * @typedef {{ cwd: string, env: NodeJS.ProcessEnv, wrangler: string }} WranglerAt
 */

/**
 * The environment wrangler runs in: no metrics, its debug log in `dir` (removed with it), and no dump of its
 * configuration or of a request's body, which carries the token, whatever the caller's environment asks: the default
 * log level, sanitized, and no output file.
 * @param {string} dir
 * @param {string} [accountId] the account every command acts on
 * @returns {NodeJS.ProcessEnv}
 */
function wranglerEnv(dir, accountId) {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("WRANGLER_OUTPUT_FILE_"))),
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_LOG: "log",
    WRANGLER_LOG_SANITIZE: "true",
    WRANGLER_LOG_PATH: join(dir, "logs"),
    ...(accountId === undefined ? {} : { CLOUDFLARE_ACCOUNT_ID: accountId }),
  };
}

/**
 * Runs wrangler in a process group of its own, so that a signal to the driver's group (a terminal's Ctrl-C, a SIGTERM
 * to the group) reaches the driver alone, which lets wrangler finish instead of cutting a deploy or a delete short.
 * @param {WranglerAt} at
 * @param {string[]} args
 * @param {(pid: number) => void} [started] called with the child's PID once it runs
 * @returns {Promise<{ code: number | null, stdout: string, output: string }>}
 */
function runWrangler({ cwd, env, wrangler }, args, started) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [wrangler, ...args], {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (child.pid !== undefined) {
      started?.(child.pid);
    }
    /** @type {Buffer[]} */
    const stdout = [];
    /** @type {Buffer[]} */
    const output = [];
    child.stdout.on("data", (data) => {
      stdout.push(/** @type {Buffer} */ (data));
      output.push(/** @type {Buffer} */ (data));
    });
    child.stderr.on("data", (data) => output.push(/** @type {Buffer} */ (data)));
    child.on("error", (error) => done({ code: null, stdout: "", output: String(error) }));
    child.on("close", (code) =>
      done({ code, stdout: Buffer.concat(stdout).toString("utf8"), output: Buffer.concat(output).toString("utf8") }),
    );
  });
}

/**
 * Keeps wrangler's output, masked, in `file`. A failed write is reported and changes nothing else, so it never stops
 * a removal.
 * @param {string | null} file
 * @param {string} text
 */
function keep(file, text) {
  if (file === null) {
    return;
  }
  try {
    appendFileSync(file, masked(text));
  } catch (error) {
    console.error(`held-output: could not keep wrangler's output in ${file}: ${String(error)}`);
  }
}

/**
 * What the driver keeps of a deployed Worker until it is confirmed gone and its run's temporary directory removed,
 * outside that directory, so that it can be found again however the driver ended: where it is, the run's id it
 * carries (OWNER_VAR), when it was made, its deploy's process, and the temporary directory (which holds the token's
 * file until it is removed); no token.
 * @typedef {{ name: string, run: string, accountId: string, startedAt: number, driverPid: number,
 *   deployPid: number | null, deployEndedAt: number | null, dir: string }} WorkerRecord
 */

/**
 * Writes the record durably: every byte to a new file, synced, renamed over the old one, the directory synced; then
 * reads it back, and throws unless it parses to the record.
 * @param {string} records
 * @param {WorkerRecord} record
 */
function saveRecord(records, record) {
  mkdirSync(records, { recursive: true, mode: 0o700 });
  const file = join(records, `${record.name}.json`);
  const text = `${JSON.stringify(record)}\n`;
  const bytes = Buffer.from(text, "utf8");
  const fd = openSync(`${file}.tmp`, "w", 0o600);
  try {
    // A write may take fewer bytes than it was given: the rest follows.
    let written = 0;
    while (written < bytes.length) {
      const took = writeSync(fd, bytes, written, bytes.length - written);
      if (took <= 0) {
        throw new Error(`${file}.tmp: a write took no bytes`);
      }
      written += took;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(`${file}.tmp`, file);
  syncDirectory(records);
  /** @type {unknown} */
  let back = null;
  try {
    back = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // Compared below.
  }
  if (JSON.stringify(back) !== JSON.stringify(record)) {
    throw new Error(`${file}: the record read back is not the one written`);
  }
}

/**
 * Updates the record; a failure is reported, and the removal goes on from what is in memory.
 * @param {string} records
 * @param {WorkerRecord} record
 */
function updateRecord(records, record) {
  try {
    saveRecord(records, record);
  } catch (error) {
    console.error(`held-output: could not update the record of ${record.name}: ${String(error)}`);
  }
}

/** @param {string} dir */
function syncDirectory(dir) {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Not every platform syncs a directory; the file itself was synced.
  }
}

/**
 * @param {string} records
 * @returns {WorkerRecord[]}
 */
function loadRecords(records) {
  /** @type {string[]} */
  let files = [];
  try {
    files = readdirSync(records).filter((file) => file.endsWith(".json"));
  } catch {
    return [];
  }
  /** @type {WorkerRecord[]} */
  const found = [];
  for (const file of files.toSorted()) {
    try {
      found.push(/** @type {WorkerRecord} */ (JSON.parse(readFileSync(join(records, file), "utf8"))));
    } catch (error) {
      console.error(`held-output: skipping the unreadable record ${join(records, file)}: ${String(error)}`);
    }
  }
  return found;
}

/** @param {number | null} pid */
function alive(pid) {
  if (pid === null) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {{ code?: string }} */ (error).code === "EPERM";
  }
}

/**
 * The account the Worker goes to: CLOUDFLARE_ACCOUNT_ID, or else the only account of wrangler's login.
 * @param {WranglerAt} at
 */
async function accountOf(at) {
  const chosen = process.env["CLOUDFLARE_ACCOUNT_ID"];
  if (chosen !== undefined && chosen !== "") {
    return chosen;
  }
  const whoami = await runWrangler(at, ["whoami", "--json"]);
  /** @type {{ id: string }[]} */
  let accounts = [];
  try {
    const json = whoami.stdout.slice(whoami.stdout.indexOf("{"), whoami.stdout.lastIndexOf("}") + 1);
    accounts = /** @type {{ accounts?: { id: string }[] }} */ (JSON.parse(json)).accounts ?? [];
  } catch {
    // Not logged in: no accounts.
  }
  const [only] = accounts;
  if (whoami.code !== 0 || only === undefined || accounts.length > 1) {
    throw new Error(`wrangler's login offers ${accounts.length} accounts: set CLOUDFLARE_ACCOUNT_ID to the one to use`);
  }
  return only.id;
}

/**
 * @param {Setup} setup
 * @param {(target: Target) => Promise<void>} fn
 */
async function runLocal({ dir, config, token, env, wrangler, logFile, signal, log }, fn) {
  const port = await freePort();
  const inspector = await freePort();
  // The output stays in the temporary directory until wrangler stops; only its masked copy is kept.
  const raw = join(dir, "dev.log");
  const output = createWriteStream(raw);
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
    { cwd: dir, stdio: ["ignore", "pipe", "pipe"], env },
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
      signal,
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
    await new Promise((done) => output.end(done));
    writeFileSync(logFile, masked(readFileSync(raw, "utf8")));
  }
}

/**
 * @param {Setup} setup
 * @param {(target: Target) => Promise<void>} fn
 */
async function runDeployed(setup, fn) {
  const { dir, config, token, run, records, logFile, signal, log } = setup;
  const accountId = await accountOf({ cwd: dir, env: setup.env, wrangler: setup.wrangler });
  /** @type {WranglerAt} */
  const at = { cwd: dir, env: { ...setup.env, CLOUDFLARE_ACCOUNT_ID: accountId }, wrangler: setup.wrangler };
  // The bench deploys only where no Worker is: a name taken already is never deployed over.
  const name = await freeName(at, setup.name);
  if (name !== setup.name) {
    writeFileSync(config, JSON.stringify(workerConfig(name, setup.compat, run), null, 2));
  }
  /** @type {WorkerRecord} */
  const record = {
    name,
    run,
    accountId,
    startedAt: Date.now(),
    driverPid: process.pid,
    deployPid: null,
    deployEndedAt: null,
    dir,
  };
  // Written, and read back, before the deploy starts, so that however the driver ends, the record finds the Worker.
  try {
    saveRecord(records, record);
  } catch (error) {
    rmSync(join(records, `${name}.json`), { force: true });
    throw new Error(`${name}: its record could not be written, so it is not deployed`, { cause: error });
  }
  /** @type {unknown} */
  let failure = null;
  try {
    log(`deploying ${name} (its record: ${join(records, `${name}.json`)})`);
    const secrets = join(dir, "secrets.json");
    const deploy = await runWrangler(at, ["deploy", "--config", config, "--secrets-file", secrets], (pid) => {
      record.deployPid = pid;
      updateRecord(records, record);
    });
    // The deploy's command has exited: from now on, only what its requests may still land is waited for.
    record.deployEndedAt = Date.now();
    updateRecord(records, record);
    rmSync(secrets, { force: true });
    keep(logFile, deploy.output);
    if (deploy.code !== 0) {
      // Its output stays in the masked log: an error carrying it would print it unmasked.
      throw new Error(`${name}: wrangler deploy exited with ${deploy.code ?? "an error"} (${logFile})`);
    }
    const url = /https:\/\/[\w.-]+\.workers\.dev/.exec(deploy.output)?.[0];
    if (url === undefined) {
      throw new Error(`${name}: deploy printed no workers.dev URL (${logFile})`);
    }
    const host = new URL(url).host;
    /** @type {Target} */
    const target = { base: url, host, port: 443, token, local: false, workerdPid: null, signal };
    await answeringState(target, 5 * MINUTE_MS, signal);
    log(`${name}: ${url}`);
    await fn(target);
  } catch (error) {
    failure = error;
  }
  const confirmed = await removeWorker(record, { wrangler: setup.wrangler, cleanup: setup.cleanup, records, logFile });
  const left = removeDirectory(dir);
  settleRecord(records, record, confirmed, left);
  failure = withLeft(failure, left);
  if (failure !== null) {
    throw failure instanceof Error ? failure : new Error("the run failed", { cause: failure });
  }
}

/**
 * A name for the Worker that no Worker of the account has: `first`, or another if that one is taken.
 * @param {WranglerAt} at
 * @param {string} first
 */
async function freeName(at, first) {
  let name = first;
  for (let tries = 0; tries < 3; tries += 1) {
    const status = await runWrangler(at, ["deployments", "status", "--name", name, "--json"]);
    if (missing(status)) {
      return name;
    }
    if (status.code !== 0) {
      throw new Error(`cannot tell whether a Worker named ${name} exists, so nothing is deployed: ${lastLine(status)}`);
    }
    log(`a Worker named ${name} exists already: trying another name`);
    name = workerName();
  }
  throw new Error("three random Worker names in a row exist already: nothing is deployed");
}

/**
 * Whether wrangler's answer says the Worker does not exist (the API's code 10007).
 * @param {{ code: number | null, output: string }} result
 */
function missing(result) {
  return result.code !== 0 && result.output.includes("[code: 10007]");
}

/** @param {{ output: string }} result */
function lastLine(result) {
  return masked(result.output.trim().split("\n").at(-1) ?? "");
}

/**
 * The JSON object in wrangler's output, or null.
 * @param {string} text
 * @returns {unknown}
 */
function jsonOf(text) {
  try {
    return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  } catch {
    return null;
  }
}

/**
 * Whose the Worker wrangler answered for is: this run's when every version of its latest deployment carries the
 * record's run id in OWNER_VAR, another's when one does not, unknown when that cannot be read.
 * @param {WranglerAt} at
 * @param {WorkerRecord} record
 * @param {string} status the output of `deployments status --json`
 * @param {string | null} logFile
 * @returns {Promise<"this run" | "another" | "unknown">}
 */
async function ownerOf(at, record, status, logFile) {
  const versions = /** @type {{ versions?: { version_id?: string }[] } | null} */ (jsonOf(status))?.versions ?? [];
  if (versions.length === 0) {
    return "unknown";
  }
  for (const { version_id: id } of versions) {
    if (id === undefined) {
      return "unknown";
    }
    const view = await runWrangler(at, ["versions", "view", id, "--name", record.name, "--json"]);
    keep(logFile, view.output);
    const version = /** @type {{ resources?: { bindings?: { name?: string, text?: string }[] } } | null} */ (
      jsonOf(view.stdout)
    );
    const bindings = version?.resources?.bindings;
    if (view.code !== 0 || bindings === undefined) {
      return "unknown";
    }
    if (!bindings.some((b) => b.name === OWNER_VAR && b.text === record.run)) {
      return "another";
    }
  }
  return "this run";
}

/**
 * Deletes the record's Worker and confirms it gone: the API says it does not exist, at least `landingMs` after its
 * deploy's command exited. It deletes only a Worker that carries the record's run id, and only reports any other. No
 * write here (a log, the record) stops it by failing. Returns whether the Worker was confirmed gone.
 * @param {WorkerRecord} record
 * @param {{ wrangler: string, cleanup: typeof CLEANUP, records: string, logFile: string | null }} options
 */
async function removeWorker(record, options) {
  return confirmGone(record, options).catch((/** @type {unknown} */ error) => {
    console.error(`held-output: removing ${record.name} failed: ${masked(String(error))}`);
    return false;
  });
}

/**
 * @param {WorkerRecord} record
 * @param {{ wrangler: string, cleanup: typeof CLEANUP, records: string, logFile: string | null }} options
 */
async function confirmGone(record, { wrangler, cleanup, records, logFile }) {
  const { name } = record;
  if (record.deployEndedAt === null) {
    // The driver ended before its deploy's command did. That command has ended only once its process is gone; until
    // then, and when the record names no process, the record stays.
    if (record.deployPid === null) {
      console.error(`held-output: the record of ${name} names no deploy process, so its deploy's end is unknown`);
      return false;
    }
    const until = Date.now() + cleanup.landingMs;
    while (alive(record.deployPid) && Date.now() < until) {
      log(`${name}: its deploy (pid ${record.deployPid}) still runs`);
      await delay(cleanup.retryMs);
    }
    if (alive(record.deployPid)) {
      console.error(`held-output: ${name}: its deploy (pid ${record.deployPid}) still runs`);
      return false;
    }
    record.deployEndedAt = Date.now();
    updateRecord(records, record);
  }
  // wrangler runs from an empty directory and names the Worker, so no configuration but the record's account applies.
  const dir = mkdtempSync(join(tmpdir(), "kopje-bench-held-cleanup-"));
  try {
    /** @type {WranglerAt} */
    const at = { cwd: dir, env: wranglerEnv(dir, record.accountId), wrangler };
    let attempt = 1;
    while (attempt <= cleanup.attempts) {
      const status = await runWrangler(at, ["deployments", "status", "--name", name, "--json"]);
      keep(logFile, status.output);
      if (missing(status)) {
        const wait = record.deployEndedAt + cleanup.landingMs - Date.now();
        if (wait <= 0) {
          return true;
        }
        // Gone for now; a deploy that ended less than `landingMs` ago may still land, so it is asked again after.
        log(`${name}: gone; confirming again in ${Math.ceil(wait / 1000)} s, once its deploy can no longer land`);
        await delay(wait);
        continue;
      }
      let deleted = false;
      const owner = status.code === 0 ? await ownerOf(at, record, status.stdout, logFile) : "unknown";
      if (owner === "another") {
        console.error(`held-output: a Worker named ${name} exists without this run's ${OWNER_VAR}: it is not deleted`);
        return false;
      }
      if (owner === "this run") {
        log(`deleting ${name}${attempt > 1 ? ` (attempt ${attempt})` : ""}`);
        const result = await runWrangler(at, ["delete", name, "--force"]);
        keep(logFile, result.output);
        deleted = result.code === 0;
      } else {
        log(`${name}: not known gone: ${lastLine(status)}`);
      }
      attempt += 1;
      // A delete that went through is confirmed at once; anything else is tried again after a pause.
      if (!deleted && attempt <= cleanup.attempts) {
        await delay(cleanup.retryMs);
      }
    }
    return false;
  } finally {
    removeDirectory(dir);
  }
}

/**
 * Removes the record once its Worker is confirmed gone and its run's temporary directory removed; otherwise keeps it
 * and says what remains. Returns whether the record was removed.
 * @param {string} records
 * @param {WorkerRecord} record
 * @param {boolean} confirmed
 * @param {string | null} left what is left of the temporary directory, or null
 */
function settleRecord(records, record, confirmed, left) {
  const file = join(records, `${record.name}.json`);
  if (confirmed && left === null) {
    try {
      rmSync(file, { force: true });
      syncDirectory(records);
      log(`${record.name}: deleted`);
      return true;
    } catch (error) {
      console.error(
        `held-output: ${record.name} is gone, but its record ${file} could not be removed: ${String(error)}`,
      );
      return false;
    }
  }
  const remains = [confirmed ? null : `${record.name} is not confirmed gone`, left].filter((r) => r !== null);
  console.error(`held-output: ${remains.join("; ")}; its record ${file} stays; run: ${CLEANUP_COMMAND}`);
  return false;
}

/**
 * `cleanup`: deletes the Worker of every record left behind and confirms each gone, and removes the temporary
 * directory its driver left; a record goes once both are done. A record whose driver still runs is left to it.
 * @param {Overrides} overrides
 */
async function cleanupCommand(overrides) {
  const records = overrides.records ?? RECORDS;
  const found = loadRecords(records);
  log(`${found.length} records in ${records}`);
  /** @type {string[]} */
  const left = [];
  for (const record of found) {
    if (record.driverPid !== process.pid && alive(record.driverPid)) {
      log(`${record.name}: its driver (pid ${record.driverPid}) still runs, and removes it itself`);
      left.push(record.name);
      continue;
    }
    const options = {
      wrangler: overrides.wrangler ?? WRANGLER,
      cleanup: overrides.cleanup ?? CLEANUP,
      records,
      logFile: null,
    };
    const confirmed = await removeWorker(record, options);
    if (!settleRecord(records, record, confirmed, removeDirectory(record.dir))) {
      left.push(record.name);
    }
  }
  if (left.length > 0) {
    throw new Error(`not resolved: ${left.join(", ")}; their records stay in ${records}`);
  }
}

/**
 * @param {string[]} argv
 * @param {Overrides} overrides
 */
async function main(argv, overrides) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      local: { type: "boolean", default: false },
      runs: { type: "string" },
      out: { type: "string" },
      quick: { type: "boolean", default: false },
    },
  });
  if (positionals[0] === "cleanup" && positionals.length === 1) {
    await cleanupCommand(overrides);
    return;
  }
  if (positionals.length > 0) {
    throw new Error(`unknown command: ${positionals.join(" ")} (known: cleanup)`);
  }
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
  if (!local) {
    const left = loadRecords(overrides.records ?? RECORDS).filter((r) => !alive(r.driverPid));
    if (left.length > 0) {
      log(`${left.length} Workers of earlier runs await removal: ${CLEANUP_COMMAND}`);
    }
  }
  // Every way the process is asked to stop takes one path: the abort ends each run's waits and sockets, and each
  // Worker is deleted (or wrangler dev stopped) before the process exits. A further signal while that runs is ignored,
  // and wrangler runs in a process group of its own, so neither a deploy nor a delete is cut short; an uncaught error
  // takes the same path. Only SIGKILL skips it, and the record of each deployed Worker then stays for `cleanup`.
  const controller = new AbortController();
  /**
   * @param {string} why
   * @param {unknown} [error]
   */
  const stop = (why, error) => {
    if (controller.signal.aborted) {
      log(`${why}: already stopping`);
      return;
    }
    log(`${why}: stopping, then removing what was started`);
    controller.abort(new Error(why, { cause: error }));
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => stop(signal));
  }
  process.on("uncaughtException", (error) => stop("uncaught exception", error));
  process.on("unhandledRejection", (error) => stop("unhandled rejection", error));
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
    withTarget(
      { local, compat, out, label: group.join("-"), signal: controller.signal, log, ...overrides },
      async (target) => {
        for (const measurement of group) {
          await MEASUREMENTS[measurement](context, target);
        }
      },
    );
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

/**
 * The command: runs the measurements (or `cleanup`), and on a failure prints it with every token masked and exits
 * with 1.
 * @param {string[]} argv
 * @param {Overrides} [overrides]
 */
export async function cli(argv, overrides = {}) {
  // A terminal gone (SIGHUP) makes every later write fail: that must not stop the removal of what was started.
  process.stdout.on("error", () => {});
  process.stderr.on("error", () => {});
  try {
    await main(argv, overrides);
  } catch (error) {
    process.stderr.write(`${masked(inspect(error))}\n`, () => process.exit(1));
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void cli(process.argv.slice(2));
}
