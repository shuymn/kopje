import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { classify, type Observation } from "../bench/held-output/classify.mjs";
import {
  CLIENT_BACKLOG_BYTES,
  framesToHand,
  m1,
  OFFERED_BYTES_PER_SECOND,
  PACED_FRAME_BYTES,
  Run,
} from "../bench/held-output/run.mjs";

// The held-output bench's driver (bench/held-output/run.mjs, #1610) against a fake of its object (worker.ts): the
// same routes and frames, served from Node, with the faults the real runtime can produce injected on demand.

const KIB = 1024;
const MIB = 1024 * KIB;
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function serverFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  if (length < 126) {
    return Buffer.concat([Buffer.from([0x80 | opcode, length]), payload]);
  }
  if (length < 65_536) {
    const head = Buffer.from([0x80 | opcode, 126, 0, 0]);
    head.writeUInt16BE(length, 2);
    return Buffer.concat([head, payload]);
  }
  const head = Buffer.alloc(10);
  head[0] = 0x80 | opcode;
  head[1] = 127;
  head.writeBigUInt64BE(BigInt(length), 2);
  return Buffer.concat([head, payload]);
}

type Totals = { seq: number; frames: number; bytes: number };

// The object: one start at a time, its sockets by name, its persistent totals and ends.
class FakeObject {
  start = { id: "", at: 0, kind: "fresh" as "fresh" | "wake" };
  sendReturns = "unknown";
  heldMib = 0;
  readonly sockets = new Map<string, Duplex>();
  readonly totals: Record<string, Totals> = {};
  readonly events: { at: number; name: string; kind: string; code: number | null; reason: string }[] = [];
  readonly sent = new Map<string, number>();
  // Faults: an answer lost after the frames left, hands refused, a listing that shows no socket, a reset past a heap,
  // a connection the object keeps open after the client's Close, and state answers held back (each read as it was
  // asked) until released.
  loseHandAnswers = false;
  refuseHands: (name: string) => boolean = () => false;
  hideSockets = false;
  resetPastMib = Number.POSITIVE_INFINITY;
  keepOpenAfterClose = false;
  holdState = false;
  readonly heldStates: (() => void)[] = [];
  readonly server: Server;

  constructor() {
    this.#restart();
    this.server = createServer((req, res) => this.#request(req, res));
    this.server.on("upgrade", (req: IncomingMessage, socket: Duplex) => this.#upgrade(req, socket));
  }

  listen(): Promise<number> {
    return new Promise((done) => {
      this.server.listen(0, "127.0.0.1", () => {
        const address = this.server.address();
        done(typeof address === "object" && address !== null ? address.port : 0);
      });
    });
  }

  stop() {
    for (const socket of this.sockets.values()) {
      socket.destroy();
    }
    this.server.closeAllConnections();
    this.server.close();
  }

  releaseState() {
    this.holdState = false;
    for (const answer of this.heldStates.splice(0)) {
      answer();
    }
  }

  // A reset: every socket ends, the heap is gone, and the object starts fresh.
  reset() {
    for (const socket of this.sockets.values()) {
      socket.destroy();
    }
    this.sockets.clear();
    this.heldMib = 0;
    this.#restart();
  }

  #restart() {
    // A start id as the object makes it: a UUID, so frame 0 carries one at full length.
    this.start = { id: randomUUID(), at: Date.now(), kind: "fresh" };
    this.sendReturns = "unknown";
  }

  #send(name: string, frames: number, bytes: number, extra = "") {
    const socket = this.sockets.get(name);
    const totals = this.totals[name] ?? { seq: 0, frames: 0, bytes: 0 };
    const at = Date.now();
    for (let i = 0; i < frames; i += 1) {
      const head = `${totals.seq + i} ${at} ${i === 0 ? extra : ""}`;
      socket?.write(serverFrame(1, Buffer.from(head.padEnd(bytes, "x"))));
    }
    this.totals[name] = {
      seq: totals.seq + frames,
      frames: totals.frames + frames,
      bytes: totals.bytes + frames * bytes,
    };
    this.sent.set(name, (this.sent.get(name) ?? 0) + frames * bytes);
    this.sendReturns = "undefined";
    return { start: this.start, at, firstSeq: totals.seq, frames, bytes: frames * bytes };
  }

  #upgrade(req: IncomingMessage, socket: Duplex) {
    const url = new URL(req.url ?? "/", "http://fake");
    const name = url.searchParams.get("name") ?? "";
    const accept = createHash("sha1")
      .update(`${String(req.headers["sec-websocket-key"])}${GUID}`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    this.sockets.set(name, socket);
    socket.on("error", () => {});
    socket.on("close", () => {
      if (this.sockets.get(name) === socket) {
        this.sockets.delete(name);
      }
    });
    // The client's frames are masked; only its Close matters here.
    socket.on("data", (data: Buffer) => {
      if ((data[0]! & 0x0f) !== 8) {
        return;
      }
      const mask = data.subarray(2, 6);
      const code = ((data[6]! ^ mask[0]!) << 8) | (data[7]! ^ mask[1]!);
      this.events.push({ at: Date.now(), name, kind: "close", code, reason: "" });
      if (!this.keepOpenAfterClose) {
        socket.end();
      }
    });
    this.#send(name, 1, 64, `${this.start.id} ${this.start.kind} `);
  }

  #request(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://fake");
    const name = url.searchParams.get("name") ?? "";
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    switch (`${req.method} ${url.pathname}`) {
      case "GET /state": {
        const body = {
          start: this.start,
          at: Date.now(),
          heldMib: this.heldMib,
          keepalive: true,
          sockets: this.hideSockets ? [] : [...this.sockets.keys()].map((n) => ({ name: n, readyState: 1 })),
          names: this.totals,
          events: this.events,
          surface: { bufferedAmount: false, ping: false, sendReturns: this.sendReturns, webSocket: [], state: [] },
        };
        if (this.holdState) {
          this.heldStates.push(() => json(200, body));
        } else {
          json(200, body);
        }
        return;
      }
      case "POST /hand": {
        if (!this.sockets.has(name) || this.refuseHands(name)) {
          json(409, { error: "no open socket", start: this.start });
          return;
        }
        const answer = this.#send(name, Number(url.searchParams.get("frames")), Number(url.searchParams.get("bytes")));
        if (this.loseHandAnswers) {
          req.socket.destroy();
          return;
        }
        json(200, answer);
        return;
      }
      case "POST /close":
        this.sockets.get(name)?.write(serverFrame(8, Buffer.from([0x03, 0xf5])));
        this.events.push({ at: Date.now(), name, kind: "closed", code: 1013, reason: "bench" });
        json(200, { start: this.start, at: Date.now(), closed: 1 });
        return;
      case "POST /alloc":
        if (this.heldMib + 1 > this.resetPastMib) {
          this.reset();
          json(500, { error: "exceeded its memory limit" });
          return;
        }
        this.heldMib += 1;
        json(200, { start: this.start, heldMib: this.heldMib });
        return;
      case "POST /release":
        this.heldMib = 0;
        json(200, { start: this.start, heldMib: 0 });
        return;
      case "POST /keepalive":
        json(200, { start: this.start, keepalive: true });
        return;
      default:
        json(404, { error: "not found" });
    }
  }
}

async function eventually(ready: () => boolean) {
  for (let i = 0; i < 200 && !ready(); i += 1) {
    await new Promise((done) => setTimeout(done, 10));
  }
  expect(ready()).toBe(true);
}

let fake: FakeObject;

afterEach(() => fake.stop());

async function setup(plan: unknown = {}) {
  fake = new FakeObject();
  const port = await fake.listen();
  const records: Observation[] = [];
  const signal = new AbortController().signal;
  const context = {
    signal,
    plan: plan as Parameters<typeof m1>[0]["plan"],
    write: (observation: Record<string, unknown>) => records.push(observation as Observation),
    log: () => {},
  };
  const target = {
    base: `http://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`,
    port,
    token: "token",
    local: true,
    workerdPid: null,
    signal,
  };
  return { records, context, target };
}

describe("held-output driver", () => {
  it("reserves a hand's bytes before asking, so a lost answer still counts against the backlog", async () => {
    const { records, context, target } = await setup();
    const run = new Run(context, target, "r2", { measurement: "m3" });
    await run.begin();
    const client = await run.client("t", { mode: "stopped" });
    fake.loseHandAnswers = true;
    for (let i = 0; i < 9; i += 1) {
      const [frames = 0] = framesToHand(
        [{ handed: client.handedBytes, received: client.receivedBytes }],
        PACED_FRAME_BYTES,
        OFFERED_BYTES_PER_SECOND / PACED_FRAME_BYTES,
      );
      if (frames > 0) {
        await run.hand(client, frames, PACED_FRAME_BYTES);
      }
    }
    await run.done();
    const sent = fake.sent.get(client.name) ?? 0;
    // Frames left on every hand whose answer was lost, and the schedule stopped at the limit all the same.
    expect(sent).toBeGreaterThan(3 * MIB);
    expect(sent - client.receivedBytes).toBeLessThanOrEqual(CLIENT_BACKLOG_BYTES);
    expect(records.filter((r) => r.type === "hand-unknown").length).toBeGreaterThan(0);
    // The object's totals, recorded before the run's end, give the outcome what was handed.
    const outcome = classify(records).runs.find((r) => r.run === "r2");
    expect(outcome?.clients[0]?.handed.bytes).toBe(sent);
  });

  it("catches a reset between polls from the starts its accepts and hands saw", async () => {
    const { records, context, target } = await setup();
    // The listing never shows the socket: only the run's own history can tell that it held one.
    fake.hideSockets = true;
    const run = new Run(context, target, "r4", { measurement: "m3" });
    await run.begin();
    const client = await run.client("t", { mode: "control" });
    await run.hand(client, 2, KIB);
    fake.reset();
    await client.closed;
    await run.poll();
    await run.done();
    const outcome = classify(records).runs.find((r) => r.run === "r4");
    expect(outcome?.class).toBe("inconclusive");
    expect(outcome?.resets).toHaveLength(1);
    expect(outcome?.clients[0]?.ends.map((e) => e.cause)).toEqual(["reset"]);
  });

  it("reads the start a hello names in full", async () => {
    const { records, context, target } = await setup();
    const run = new Run(context, target, "r8", { measurement: "m2" });
    await run.begin();
    await run.client("a", { mode: "control" });
    fake.reset();
    // No state answer comes: only the second client's frame 0 can name the new start.
    fake.holdState = true;
    await run.client("b", { mode: "control" });
    expect(records.filter((r) => r.type === "start").map((r) => r.id)).toEqual([fake.start.id]);
    fake.releaseState();
    await run.done();
  });

  it("keeps a start's last sighting at when it was asked about, so a late state answer hides no reset", async () => {
    const { records, context, target } = await setup();
    const run = new Run(context, target, "r7", { measurement: "m3" });
    await run.begin();
    // A state read before the client exists, answered only after the client was handed frames and the reset ended it.
    fake.holdState = true;
    const polled = run.poll();
    await eventually(() => fake.heldStates.length === 1);
    const pending = run.client("t", { mode: "control" });
    await eventually(() => (run.clients[0]?.receivedFrames ?? 0) > 0);
    const client = run.clients[0]!;
    await run.hand(client, 2, KIB);
    fake.reset();
    await client.closed;
    await new Promise((done) => setTimeout(done, 5));
    fake.releaseState();
    await polled;
    await pending;
    await run.poll();
    await run.done();
    const outcome = classify(records).runs.find((r) => r.run === "r7");
    expect(outcome?.class).toBe("inconclusive");
    expect(outcome?.resets).toHaveLength(1);
    expect(outcome?.clients[0]?.ends.map((e) => e.cause)).toEqual(["reset"]);
  });

  it("samples the runtime's surface after the hello's send and before the run's end", async () => {
    const { records, context, target } = await setup();
    const run = new Run(context, target, "r5", { measurement: "m2" });
    await run.begin();
    const client = await run.client("c", { mode: "control" });
    await run.hand(client, 1, 64);
    // A runtime whose `send` came to return something: the sample before the end must show it.
    fake.sendReturns = "promise";
    await run.done();
    const sendReturns = (r: Observation) =>
      r.type === "surface" ? (r.surface as { sendReturns: string }).sendReturns : null;
    const afterHello = records.findIndex((r) => sendReturns(r) === "undefined");
    const firstHand = records.findIndex((r) => r.type === "hand" && r.firstSeq > 0);
    const beforeEnd = records.findIndex((r) => sendReturns(r) === "promise");
    expect(sendReturns(records.find((r) => r.type === "surface")!)).toBe("unknown");
    expect(afterHello).toBeGreaterThan(-1);
    expect(afterHello).toBeLessThan(firstHand);
    expect(beforeEnd).toBeGreaterThan(-1);
    expect(beforeEnd).toBeLessThan(records.findIndex((r) => r.type === "done"));
    expect(classify(records).surface).toMatchObject({ afterSend: true, signal: true });
  });

  it("counts what a client received by the time each side of its end was recorded", async () => {
    const { records, context, target } = await setup();
    // The object answers the client's Close but keeps the connection open, so the client's own end comes late.
    fake.keepOpenAfterClose = true;
    const run = new Run(context, target, "r6", { measurement: "m2" });
    await run.begin();
    const client = await run.client("s4", { mode: "stopped" });
    await run.hand(client, 4, KIB);
    await run.closeByObject(client);
    client.resume();
    await eventually(() => fake.events.some((e) => e.kind === "close"));
    await run.poll();
    await run.done();
    const outcome = classify(records).runs.find((r) => r.run === "r6");
    const server = outcome?.clients[0]?.ends.find((e) => e.side === "server");
    expect(server).toMatchObject({ receivedFrames: 5, handedFrames: 5, cause: "closed" });
    // The object's end carries what the client had received, and the frames before the Close were summarized as the
    // Close arrived, before that end.
    const raw = records.find((r) => r.type === "end" && r.side === "server");
    expect(raw).toMatchObject({ receivedFrames: 5, receivedBytes: 64 + 4 * KIB });
    const summarized = records
      .filter((r) => r.type === "recv" && r.at <= (raw?.at ?? 0))
      .reduce((sum, r) => sum + (r.type === "recv" ? r.frames : 0), 0);
    expect(summarized).toBe(5);
  });

  it("classifies an M1 volume whose stopped clients were never filled as inconclusive", async () => {
    const { records, context, target } = await setup({
      m1: { volumes: [MIB], shapes: [{ frameBytes: 512 * KIB, frames: 2 }], attempts: 1, batchMs: 1, stopped: 2 },
    });
    fake.resetPastMib = 20;
    // Every hand to a stopped client is refused: the fill ends at nothing, and the headroom is the baseline's.
    fake.refuseHands = (name) => /\.s\d/.test(name);
    await m1(context, target);
    const result = classify(records).m1;
    expect(result?.volumes.map((v) => [v.run, v.class])).toEqual([["m1-524288b-1m", "inconclusive"]]);
    expect(records.filter((r) => r.type === "headroom").map((r) => (r as { bytes: number | null }).bytes)).toEqual([
      20 * MIB,
      20 * MIB,
    ]);
    expect(records.find((r) => r.type === "headroom" && r.run === "m1-524288b-1m")).toMatchObject({
      held: { bytes: 0, unknown: 0, ended: 0, endedDuringProbe: 0 },
    });
  });
});
