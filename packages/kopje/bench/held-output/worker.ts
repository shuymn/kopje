// The held-output bench's object (#1610, `run.mjs`): one Durable Object with hibernatable sockets and no Kopje code,
// which hands frames to the bench's clients on request and reports what it handed, which sockets the runtime lists and
// how each ended. The driver deploys it under a temporary name, or runs it under `wrangler dev` with `--local`.
//
//   GET  /ws?name=<n>                          accept a socket tagged n; it is handed frame 0 at once
//   POST /hand?name=<n>&frames=<k>&bytes=<b>   hand k frames of b ASCII bytes to n's socket
//   POST /close?name=<n>                       close n's socket with 1013
//   POST /keepalive?on=1|0                     an alarm every 5 s, so the object stays in memory instead of hibernating
//   POST /alloc?mib=<m>                        hold m more MiB of JavaScript heap (the headroom probe)
//   POST /release                              drop what /alloc holds
//   GET  /state                                the start, the listed sockets, per name what was handed and its ends,
//                                              and the runtime's WebSocket surface
//
// Each request carries the run's token (the secret `BENCH_TOKEN`, made per run by run.mjs) as
// `Authorization: Bearer <token>`, or is refused with 403: the deployed object is reachable on workers.dev while it
// runs.
//
// A frame is `<seq> <hand time in ms> ` padded with `x` to its size, so a client reads each frame's age without the
// object keeping one record per frame; frame 0 also names the start that accepted the socket
// (`<id> <kind> <generation> `). Totals and ends live in the object's storage, so a reset loses none; the start id is
// random per start of the object, its generation counts the object's starts in its storage (so answers order by
// start however late they arrive), and `kind` says whether the start found sockets still listed (a wake from
// hibernation, which the runtime keeps connected) or none (a fresh start, which after a reset means its sockets
// ended).
import { DurableObject } from "cloudflare:workers";

interface Env {
  HELD: DurableObjectNamespace<HeldOutput>;
  BENCH_TOKEN: string;
}

const MIB = 1024 * 1024;
// One MiB of the heap: a packed array of doubles stores each element unboxed in eight bytes.
const DOUBLES_PER_MIB = MIB / 8;
const KEEPALIVE_MS = 5_000;
// What one /hand may ask: a fixed ceiling on the request's own work.
const MAX_FRAMES = 65_536;
const MAX_FRAME_BYTES = MIB;
const HELLO_BYTES = 96;

type Start = { id: string; at: number; kind: "fresh" | "wake"; generation: number };

// What the runtime's WebSocket offers JavaScript: any of these would be a signal of unsent output (RES-6).
type Surface = {
  bufferedAmount: boolean;
  ping: boolean;
  sendReturns: string;
  webSocket: string[];
  state: string[];
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function frame(seq: number, at: number, bytes: number, extra: string): string {
  const head = `${seq} ${at} ${extra}`;
  return head + "x".repeat(Math.max(0, bytes - head.length));
}

function ownNames(value: object | null): string[] {
  return value === null ? [] : Object.getOwnPropertyNames(value).toSorted();
}

export class HeldOutput extends DurableObject<Env> {
  readonly #start: Start;
  #held: number[][] = [];
  #sendReturns = "unknown";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS totals
       (name TEXT PRIMARY KEY, seq INTEGER NOT NULL, frames INTEGER NOT NULL, bytes INTEGER NOT NULL)`,
    );
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS events
       (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
        code INTEGER, reason TEXT)`,
    );
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value INTEGER NOT NULL)");
    ctx.storage.sql.exec(
      `INSERT INTO settings (key, value) VALUES ('generation', 1)
       ON CONFLICT (key) DO UPDATE SET value = value + 1`,
    );
    this.#start = {
      id: crypto.randomUUID(),
      at: Date.now(),
      kind: ctx.getWebSockets().length > 0 ? "wake" : "fresh",
      generation: this.#setting("generation") ?? 1,
    };
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const name = url.searchParams.get("name") ?? "";
    switch (`${request.method} ${url.pathname}`) {
      case "GET /ws":
        return this.#accept(request, name);
      case "POST /hand":
        return this.#hand(name, Number(url.searchParams.get("frames")), Number(url.searchParams.get("bytes")));
      case "POST /close":
        return this.#close(name);
      case "POST /keepalive":
        return this.#keepalive(url.searchParams.get("on") === "1");
      case "POST /alloc":
        return this.#alloc(Number(url.searchParams.get("mib")));
      case "POST /release":
        this.#held = [];
        return json({ start: this.#start, heldMib: 0 });
      case "GET /state":
        return json(this.#state());
      default:
        return json({ error: "not found" }, 404);
    }
  }

  override webSocketMessage(): void {}

  override webSocketClose(ws: WebSocket, code: number, reason: string): void {
    this.#ended(ws, "close", code, reason);
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "");
    } catch {
      // Already closed: the runtime answered the client's Close itself.
    }
  }

  override webSocketError(ws: WebSocket, error: unknown): void {
    this.#ended(ws, "error", null, String(error));
  }

  override async alarm(): Promise<void> {
    if (this.#setting("keepalive") === 1) {
      await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_MS);
    }
  }

  #accept(request: Request, name: string): Response {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket" || name === "") {
      return json({ error: "expected a WebSocket upgrade with a name" }, 400);
    }
    if (this.ctx.getWebSockets(name).length > 0) {
      return json({ error: "name in use" }, 409);
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [name]);
    this.#record(Date.now(), name, "accept", null, null);
    const { id, kind, generation } = this.#start;
    this.#sendFrames(server, name, 1, HELLO_BYTES, `${id} ${kind} ${generation} `);
    return new Response(null, { status: 101, webSocket: client });
  }

  #hand(name: string, frames: number, bytes: number): Response {
    if (
      !Number.isSafeInteger(frames) ||
      frames < 1 ||
      frames > MAX_FRAMES ||
      !Number.isSafeInteger(bytes) ||
      bytes < 32 ||
      bytes > MAX_FRAME_BYTES
    ) {
      return json({ error: "frames or bytes out of range" }, 400);
    }
    const [ws] = this.ctx.getWebSockets(name);
    if (ws === undefined || ws.readyState !== WebSocket.OPEN) {
      return json({ error: "no open socket", start: this.#start }, 409);
    }
    return json({ start: this.#start, ...this.#sendFrames(ws, name, frames, bytes) });
  }

  // Sends `frames` frames to `ws` and adds them to `name`'s totals; a send that throws ends the batch, and only the
  // frames sent before it count.
  #sendFrames(ws: WebSocket, name: string, frames: number, bytes: number, extra = "") {
    const sql = this.ctx.storage.sql;
    const row = sql.exec<{ seq: number }>("SELECT seq FROM totals WHERE name = ?", name).toArray()[0];
    const first = row?.seq ?? 0;
    const at = Date.now();
    let sent = 0;
    let sentBytes = 0;
    let failure: string | null = null;
    for (; sent < frames; sent += 1) {
      const text = frame(first + sent, at, bytes, sent === 0 ? extra : "");
      try {
        const returned: unknown = ws.send(text);
        if (this.#sendReturns === "unknown") {
          this.#sendReturns = returned instanceof Promise ? "promise" : typeof returned;
        }
      } catch (error) {
        failure = String(error);
        break;
      }
      sentBytes += text.length;
    }
    sql.exec(
      `INSERT INTO totals (name, seq, frames, bytes) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (name) DO UPDATE SET seq = ?2, frames = frames + ?3, bytes = bytes + ?4`,
      name,
      first + sent,
      sent,
      sentBytes,
    );
    return { at, firstSeq: first, frames: sent, bytes: sentBytes, failure };
  }

  #close(name: string): Response {
    const sockets = this.ctx.getWebSockets(name);
    const at = Date.now();
    for (const ws of sockets) {
      ws.close(1013, "bench");
    }
    if (sockets.length > 0) {
      this.#record(at, name, "closed", 1013, "bench");
    }
    return json({ start: this.#start, at, closed: sockets.length });
  }

  async #keepalive(on: boolean): Promise<Response> {
    this.ctx.storage.sql.exec(
      "INSERT INTO settings (key, value) VALUES ('keepalive', ?1) ON CONFLICT (key) DO UPDATE SET value = ?1",
      on ? 1 : 0,
    );
    if (on) {
      await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_MS);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
    return json({ start: this.#start, keepalive: on });
  }

  #alloc(mib: number): Response {
    if (!Number.isSafeInteger(mib) || mib < 1 || mib > 64) {
      return json({ error: "mib out of range" }, 400);
    }
    for (let i = 0; i < mib; i += 1) {
      this.#held.push(Array.from({ length: DOUBLES_PER_MIB }, (_, j) => j + 0.5));
    }
    return json({ start: this.#start, heldMib: this.#held.length });
  }

  #state() {
    const sql = this.ctx.storage.sql;
    const names: Record<string, { frames: number; bytes: number; seq: number }> = {};
    for (const row of sql.exec<{ name: string; seq: number; frames: number; bytes: number }>("SELECT * FROM totals")) {
      names[row.name] = { frames: row.frames, bytes: row.bytes, seq: row.seq };
    }
    const events = sql
      .exec<{ at: number; name: string; kind: string; code: number | null; reason: string | null }>(
        "SELECT at, name, kind, code, reason FROM events ORDER BY id",
      )
      .toArray();
    // A listed socket shows instance properties as well as the prototype's; with none listed, the prototype's.
    const sample: object = this.ctx.getWebSockets()[0] ?? WebSocket.prototype;
    const surface: Surface = {
      bufferedAmount: "bufferedAmount" in sample,
      ping: "ping" in sample,
      sendReturns: this.#sendReturns,
      webSocket: [...new Set([...ownNames(WebSocket.prototype), ...ownNames(sample)])].toSorted(),
      state: ownNames(Object.getPrototypeOf(this.ctx) as object | null),
    };
    return {
      start: this.#start,
      at: Date.now(),
      heldMib: this.#held.length,
      keepalive: this.#setting("keepalive") === 1,
      sockets: this.ctx
        .getWebSockets()
        .map((ws) => ({ name: this.ctx.getTags(ws)[0] ?? "", readyState: ws.readyState })),
      names,
      events,
      surface,
    };
  }

  #ended(ws: WebSocket, kind: "close" | "error", code: number | null, reason: string) {
    this.#record(Date.now(), this.ctx.getTags(ws)[0] ?? "", kind, code, reason);
  }

  #record(at: number, name: string, kind: string, code: number | null, reason: string | null) {
    this.ctx.storage.sql.exec(
      "INSERT INTO events (at, name, kind, code, reason) VALUES (?, ?, ?, ?, ?)",
      at,
      name,
      kind,
      code,
      reason,
    );
  }

  #setting(key: string): number | undefined {
    return this.ctx.storage.sql.exec<{ value: number }>("SELECT value FROM settings WHERE key = ?", key).toArray()[0]
      ?.value;
  }
}

const ENCODER = new TextEncoder();

// Whether the request carries the run's token, compared in constant time.
function authorized(request: Request, token: string): boolean {
  const given = ENCODER.encode(request.headers.get("authorization") ?? "");
  const expected = ENCODER.encode(`Bearer ${token}`);
  return token !== "" && given.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(given, expected);
}

export default {
  fetch(request, env) {
    if (!authorized(request, env.BENCH_TOKEN)) {
      return json({ error: "forbidden" }, 403);
    }
    return env.HELD.get(env.HELD.idFromName("bench")).fetch(request);
  },
} satisfies ExportedHandler<Env>;
