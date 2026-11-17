import { encodedTwiceBytes, jsonBytes } from "./domain/answer-budget";
import { compareIntegers, isIntegerText } from "./domain/ids";
import { keepInstanceActivity, noteActivity } from "./domain/instance-activity";
import { JOURNAL_SPAN } from "./domain/stream-journal";
import {
  CONVERSATIONS_PER_TURN,
  hashtagKey,
  isFeedKey,
  keyHashtag,
  keyList,
  listKey,
  mayCarry,
  maySubscribe,
  STREAM_NAMES,
  STREAM_OPERATIONS,
  streamAccept,
  streamAdvance,
  streamCaughtUp,
  streamConversations,
  streamDeleteUnits,
  streamEnterConversation,
  type StreamEvent,
  streamEvents,
  type StreamGrant,
  type StreamKeys,
  streamListOwned,
  type StreamPosition,
  streamPrune,
  streamReconcile,
  streamRegister,
  type StreamSubject,
  streamTokens,
  streamUnitAdvance,
  type StreamUnitAfter,
} from "./domain/streaming";
import { normalizeTag } from "./domain/tag-name";
import { utf8Length } from "./platform/dump-format";
import { errorFields } from "./platform/error-message";
import { toStoreUnavailable } from "./platform/store-errors";
import type { StoreKernel, StoreOperation } from "./platform/store-kernel";
import {
  ATTACHMENT_MAX,
  capacity,
  cloneBound,
  frame,
  outputNeed,
  SOCKET_BYTES,
  socketCharge,
  STREAM_OUTPUT,
  validOut,
} from "./stream-output";

// The streaming API's sockets, in the Store, with WebSocket Hibernation (Mastodon 4.5's streaming server). The Worker
// (mastodon/streaming.ts) authenticates nothing itself: it forwards the upgrade with the token's sha256 only, and the
// Store accepts the socket once the token is a user's (domain/streaming.ts). Each
// socket carries its state in its attachment (Attachment), which survives hibernation; the Store's SQLite holds the
// registry of subscribed stream keys, the journal of events and the fan-out's position (migration 0026_streaming).
//
// Fan-out runs in turns, one at a time. Every turn is an incoming request to the Store's own stub, which restores the
// CPU allowance (an incoming request resets it; nothing else is documented to): requested after a write commits while
// sockets are open, by the cron every 5 minutes, and by a turn that ran out of budget. A turn re-checks every open
// socket's token (a revoked or expired token, or a suspended account's, closes with 1008), then sends units in the
// journal's order until its budget cannot cover a unit's worst case. Each unit is made in its own transaction, the
// position past it persisted before its messages are sent (at most once); a send that fails closes the sockets left
// without the unit (1011), and their clients read REST again.
//
// Held output (RES-6, stream-output.ts): every frame handed to a socket is charged to it, in its attachment's `out`,
// until the socket leaves getWebSockets(). A unit's frames, an error reply and an upgrade are admitted from the latest
// attachments in one synchronous step that writes the new charge before anything is sent; a socket the unit would take
// past its cap or the instance's is closed (1013) and sent none of it, and an upgrade the instance cannot hold answers
// 503. While a listed socket's charge is unknown (an attachment that does not read as this release's), nothing is
// admitted and every upgrade answers 503.

// The caps (RES-6, RES-7). socketsPerInstance can be lowered in tests (STREAM_LIMITS is the seam).
export const STREAM_LIMITS = {
  socketsPerAccount: 16,
  socketsPerInstance: 256,
  subscriptionsPerSocket: 16,
  keysPerAccount: 16,
  // A text message read at most this many UTF-8 bytes; a larger one closes the socket (1008).
  messageBytes: 4096,
  // Messages a socket may send per minute; one more closes it (1008).
  messagesPerMinute: 120,
  attachmentBytes: 12 * 1024,
  // A hashtag stream's `tag`, as sent and normalized, at most this many UTF-8 bytes.
  tagBytes: 256,
  // A presented subject whose payload passes this many UTF-8 bytes, measured before it is encoded, is skipped and
  // logged; the events media descriptions at their length can push past it are an accepted departure
  // (docs/mastodon-deviations.md, "Streaming."). 254 KiB keeps the largest frame (MESSAGE_MAX, its envelope with the
  // longest stream and event) and its terminating NUL within 2^18 bytes, so a fresh socket takes any unit (RES-6).
  payloadBytes: 254 * 1024,
};

// Test hooks. dropContinuation: a turn that leaves work calls it instead of requesting a continuation, as if it failed
// (cron resumes). beforeAdmission: a gate a unit awaits once made, before its admission; beforeAccept: one an upgrade
// awaits after its token check. failWrite, failSend and failAdmission: whether a socket's attachment write, a
// send to it (with the stream, "" for an error reply) or its admission throws. Unset, none adds an await or a throw.
export const STREAM_FAULTS: {
  dropContinuation: (() => void) | null;
  beforeAdmission: (() => Promise<void>) | null;
  beforeAccept: (() => Promise<void>) | null;
  failWrite: ((ws: WebSocket) => boolean) | null;
  failSend: ((ws: WebSocket, stream: string) => boolean) | null;
  failAdmission: ((ws: WebSocket) => boolean) | null;
} = {
  dropContinuation: null,
  beforeAdmission: null,
  beforeAccept: null,
  failWrite: null,
  failSend: null,
  failAdmission: null,
};

type Charge = { checks: number; presentations: number; bytes: number; sends: number };

// What one turn may do, and what one unit may do at most: 16 token checks and the reference reads of an edit (home, the
// mention, one for each list, `public*` and `hashtag*` key: an account has at most 16 keys, and an edit reads home and
// the mention whatever it subscribes to; and the mention filter once a feed returned the status), one presentation,
// and a send to each of 16 subscriptions on each of 16 sockets. A delete reads at most 16 lists and its tombstone.
// Bytes are presented payloads' UTF-8 bytes, a unit's charged whole once presented, sent or skipped: a turn starts no
// unit once less than a unit's worst is left, and the unit that crosses TURN_BUDGET.bytes is bounded by the most a
// streamed subject presents (RES-6, docs/threat-model.md).
export const TURN_BUDGET: Charge = { checks: 512, presentations: 64, bytes: 4 * 1024 * 1024, sends: 4096 };
export const UNIT_WORST: Charge = { checks: 35, presentations: 1, bytes: STREAM_LIMITS.payloadBytes, sends: 256 };

// Journal events read per scan of a turn.
const SCAN = 64;

const TURN_HEADER = "x-kopje-turn";

// A socket's state. since: the journal head when it opened (it receives later events only); convSeq: the
// highest conversation change sent or skipped on `direct` (raised, and written, before a conversation is sent); rate:
// the minute its message count started; subs: its subscriptions' keys (a stream's name, `list:<id>`, or
// `hashtag[:local]:<tag>`), in order; tags: each hashtag key's `tag` as the client sent it (its messages echo it);
// out: the output handed to it over its life, [the sum of frame() over its frames, their number] (stream-output.ts).
type Attachment = {
  v: 2;
  tokenHash: string;
  accountId: string;
  grant: StreamGrant;
  since: string;
  convSeq: string;
  rate: { window: number; count: number };
  subs: string[];
  tags: Record<string, string>;
  out: [charged: number, frames: number];
};

type Socket = { ws: WebSocket; at: Attachment };

// One subject of an event for one viewer, with the viewer's sockets that may carry it, the list ids it may go on, and
// the `public*` and `hashtag*` keys those sockets subscribe to.
type Unit = { subject: StreamSubject; viewer: string; sockets: Socket[]; lists: string[]; feeds: string[] };

// A scan's walk: the position as this turn moved it, and an event passed over whose position write is pending.
type Walk = { from: StreamPosition; skipTo: StreamPosition | null; ceiling: string };

// A delete's units are read this many viewers at a time (at most 41 units each).
const DELETE_PAGE = 8;

class Budget {
  readonly #left: Charge;

  constructor(limit: Charge) {
    this.#left = { ...limit };
  }

  covers(need: Charge): boolean {
    return (Object.keys(need) as (keyof Charge)[]).every((k) => this.#left[k] >= need[k]);
  }

  charge(spent: Partial<Charge>): void {
    for (const [k, n] of Object.entries(spent) as [keyof Charge, number][]) {
      this.#left[k] -= n;
    }
  }
}

export class StreamHub {
  readonly #ctx: DurableObjectState;
  readonly #kernel: StoreKernel;
  readonly #turnRequest: (headers: HeadersInit) => Promise<Response>;
  // One turn at a time: a turn running, a request for one issued and not started yet (by its number), and whether
  // another was asked for meanwhile.
  #running = false;
  #pending: number | null = null;
  #requests = 0;
  #again = false;
  #failed = false;
  #turns = 0;
  // The registry is rebuilt from the open sockets by the first turn of this instance.
  #reconciled = false;
  #idle: (() => void)[] = [];
  // The listed sockets' charge (RES-6): null until recomputed from their attachments (after a wake), recomputed at
  // each turn and upgrade, raised by each admission, so between recomputations it only overstates. `#unknown` counts
  // the listed sockets the last recomputation or read found without a charge; `#nearArmed`, whether the instance's
  // next crossing of three quarters of its cap logs.
  #charged: number | null = null;
  #unknown = 0;
  #nearArmed = true;

  constructor(ctx: DurableObjectState, kernel: StoreKernel, turnRequest: (headers: HeadersInit) => Promise<Response>) {
    this.#ctx = ctx;
    this.#kernel = kernel;
    this.#turnRequest = turnRequest;
  }

  // The Store's fetch: the upgrade the Worker forwards, and the turns the Store asks of itself.
  fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/stream/turn") {
      return this.#turn(request);
    }
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return this.#upgrade(request, url);
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  }

  // After a write commits: a turn, if a socket is open and the write was not the hub's own, an activity stamp or the
  // instance activity's kept answer (both instance-activity.ts), which no stream shows.
  written(operation: StoreOperation<never, unknown>): void {
    if (
      !STREAM_OPERATIONS.has(operation) &&
      operation !== noteActivity &&
      operation !== keepInstanceActivity &&
      this.#ctx.getWebSockets().length > 0
    ) {
      this.#request();
    }
  }

  // The cron's turn: closes the sockets of tokens that expired, and prunes the journal.
  tick(): void {
    this.#request();
  }

  // Resolves once no turn runs or is requested and the position is at the journal's head (the streaming tests' drain
  // barrier), with the number of turns this instance ran. Never polls: it waits for turns to end.
  async drained(): Promise<{ turns: number }> {
    for (;;) {
      if (!this.#running && this.#pending === null) {
        if (this.#failed) {
          throw new Error("the last stream turn failed");
        }
        if (await this.#run(streamCaughtUp, undefined)) {
          return { turns: this.#turns };
        }
        this.#request();
      }
      await new Promise<void>((resolve) => this.#idle.push(resolve));
    }
  }

  // Closes every socket, for a Store that can no longer serve them (an import begins, maintenance refuses a turn).
  closeAll(code: number, reason: string): void {
    for (const ws of this.#ctx.getWebSockets()) {
      close(ws, code, reason);
    }
    this.#reconciled = false;
  }

  async message(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const at = this.#restore(ws);
    if (at === null) {
      return;
    }
    if (typeof message !== "string") {
      return this.#drop(ws, at, 1003, "binary messages are not supported");
    }
    if (exceeds(message, STREAM_LIMITS.messageBytes)) {
      return this.#drop(ws, at, 1008, "message too large");
    }
    const now = Date.now();
    at.rate = now - at.rate.window >= 60_000 ? { window: now, count: 1 } : { ...at.rate, count: at.rate.count + 1 };
    if (at.rate.count > STREAM_LIMITS.messagesPerMinute) {
      return this.#drop(ws, at, 1008, "too many messages");
    }
    serialize(ws, at);
    const json = parseObject(message);
    if (json?.type === "subscribe") {
      await this.#subscribe(ws, at, json);
    } else if (json?.type === "unsubscribe") {
      await this.#unsubscribe(ws, at, json);
    }
  }

  async closed(ws: WebSocket, code: number): Promise<void> {
    close(ws, code === 1005 || code === 1006 ? 1000 : code, "");
    const at = peek(ws);
    if (at !== null) {
      await this.#sync(at.accountId, ws);
    }
  }

  async #upgrade(request: Request, url: URL): Promise<Response> {
    const build = request.headers.get("x-kopje-build") ?? "";
    const tokenHash = request.headers.get("x-kopje-token-hash") ?? "";
    const now = Number(request.headers.get("x-kopje-now"));
    if (!TOKEN_HASH.test(tokenHash) || !Number.isFinite(now)) {
      return refusal(400, "Bad request");
    }
    let accepted;
    try {
      accepted = await this.#kernel.execute(build, streamAccept, { tokenHash, now });
    } catch (error) {
      if (toStoreUnavailable(error) !== undefined) {
        return refusal(503, "Service Unavailable");
      }
      throw error;
    }
    if (accepted.status !== "ok") {
      return refusal(401, "Invalid access token");
    }
    if (STREAM_FAULTS.beforeAccept !== null) {
      await STREAM_FAULTS.beforeAccept();
    }
    const { accountId } = accepted;
    if (this.#open(accountTag(accountId)).length >= STREAM_LIMITS.socketsPerAccount) {
      return refusal(429, "Too many connections");
    }
    if (this.#open().length >= STREAM_LIMITS.socketsPerInstance) {
      return refusal(503, "Too many connections");
    }
    // RES-6: a socket is charged from the moment it is listed, so the instance's charge, recomputed now, must leave it
    // room, and its attachment is written before it is accepted.
    const instance = this.#recompute();
    const need = SOCKET_BYTES + capacity(1);
    if (instance.unknown > 0 || instance.charge + need > STREAM_OUTPUT.instanceBytes) {
      console.warn({
        event: "kopje.stream.output_refused",
        scope: instance.unknown > 0 ? "unknown" : "instance",
        charge: instance.charge,
        need,
        cap: STREAM_OUTPUT.instanceBytes,
        listed: instance.listed,
        unknown: instance.unknown,
      });
      return refusal(503, "Too many connections");
    }
    const { 0: client, 1: server } = new WebSocketPair();
    const at: Attachment = {
      v: 2,
      tokenHash,
      accountId,
      grant: accepted.grant,
      since: accepted.since,
      convSeq: "0",
      rate: { window: Date.now(), count: 0 },
      subs: [],
      tags: {},
      out: [0, 0],
    };
    try {
      serialize(server, at);
    } catch (error) {
      console.error({ event: "kopje.stream.accept_failed", ...errorFields(error) });
      return refusal(500, "An unexpected error occurred");
    }
    this.#ctx.acceptWebSocket(server, [accountTag(accountId), `t:${tokenHash}`]);
    this.#raise(instance.charge + need);
    // ?stream= (with tag and list) subscribes on connect, as a first message would, uncounted.
    const stream = url.searchParams.get("stream");
    if (stream !== null) {
      await this.#subscribe(server, at, {
        stream,
        tag: url.searchParams.get("tag"),
        list: url.searchParams.get("list"),
      });
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  // Mastodon's order (subscribeWebsocketToChannel): the scope first, then the stream and its parameter (a list must be
  // the account's), and a stream already subscribed is ignored. There is no acknowledgement; a refusal is an error
  // message.
  async #subscribe(ws: WebSocket, at: Attachment, json: Record<string, unknown>): Promise<void> {
    const name = firstParam(json.stream);
    if (!maySubscribe(at.grant, name)) {
      return this.#reply(ws, { error: "Access token does not have the required scopes", status: 401 });
    }
    const stream = STREAM_NAMES.find((known) => known === name);
    if (stream === undefined) {
      return this.#reply(ws, { error: "Unknown stream type", status: 400 });
    }
    let key: string = stream;
    // A hashtag's tag as the client sent it (Mastodon echoes it); the key holds it normalized, so `#Cats` and `cats`
    // are one subscription, as Mastodon's channel is one.
    let raw: string | null = null;
    if (stream === "list") {
      if (json.list === undefined || json.list === null || json.list === "") {
        return this.#reply(ws, { error: "Missing list name parameter", status: 400 });
      }
      if (typeof json.list !== "string" || !LIST_ID.test(json.list)) {
        return this.#reply(ws, { error: "Invalid parameter", status: 400 });
      }
      key = listKey(json.list);
    } else if (stream === "hashtag" || stream === "hashtag:local") {
      if (json.tag === undefined || json.tag === null || json.tag === "") {
        return this.#reply(ws, { error: "Missing tag name parameter", status: 400 });
      }
      const tag = typeof json.tag === "string" ? normalizeTag(json.tag) : null;
      if (
        typeof json.tag !== "string" ||
        tag === null ||
        exceeds(json.tag, STREAM_LIMITS.tagBytes) ||
        exceeds(tag, STREAM_LIMITS.tagBytes)
      ) {
        return this.#reply(ws, { error: "Invalid parameter", status: 400 });
      }
      key = hashtagKey(stream, tag);
      raw = json.tag;
    }
    if (at.subs.includes(key)) {
      return;
    }
    const next: Attachment = {
      ...at,
      subs: [...at.subs, key],
      tags: raw === null ? at.tags : { ...at.tags, [key]: raw },
    };
    const keys = this.#keys(at.accountId, ws);
    for (const sub of next.subs) {
      keys.set(sub, (keys.get(sub) ?? 0) + 1);
    }
    // The attachment's clone must fit the runtime's limit with any `out` (cloneBound counts each number as 16 bytes).
    if (
      next.subs.length > STREAM_LIMITS.subscriptionsPerSocket ||
      keys.size > STREAM_LIMITS.keysPerAccount ||
      exceeds(JSON.stringify(next), STREAM_LIMITS.attachmentBytes) ||
      cloneBound(next) > ATTACHMENT_MAX
    ) {
      return this.#reply(ws, { error: "Too many subscriptions", status: 429 });
    }
    // The registry first: a subscription it does not hold would journal nothing for the account. A refused write (a
    // dump's freeze, maintenance) leaves the socket unsubscribed and says so, as Mastodon answers an unexpected
    // failure, so the client subscribes again.
    let registered;
    try {
      const list = keyList(key);
      if (list !== null && !(await this.#run(streamListOwned, { accountId: at.accountId, listId: list }))) {
        return await this.#reply(ws, { error: "Not authorized to stream this list", status: 401 });
      }
      registered = await this.#run(streamRegister, { accountId: at.accountId, keys: keysOf(keys) });
    } catch (error) {
      // A refusal (maintenance, a dump's freeze) is expected; anything else is not.
      if (toStoreUnavailable(error) === undefined) {
        console.error({ event: "kopje.stream.register-failed", ...errorFields(error) });
      } else {
        console.warn({ event: "kopje.stream.register-failed", ...errorFields(error) });
      }
      return this.#reply(ws, { error: "An unexpected error occurred", status: 500 });
    }
    // On the attachment as it is now (a turn may have raised its convSeq meanwhile); `direct` starts at the mark.
    this.#update(ws, (current) =>
      current.subs.includes(key)
        ? current
        : {
            ...current,
            subs: [...current.subs, key],
            tags: raw === null ? current.tags : { ...current.tags, [key]: raw },
            convSeq: key === "direct" ? (registered.convSeq ?? "0") : current.convSeq,
          },
    );
  }

  // Mastodon's unsubscribeWebsocketFromChannel: a stream it cannot resolve answers its one unsubscribe error.
  async #unsubscribe(ws: WebSocket, at: Attachment, json: Record<string, unknown>): Promise<void> {
    const name = firstParam(json.stream);
    const missing = (name === "list" && !json.list) || ((name === "hashtag" || name === "hashtag:local") && !json.tag);
    if (!STREAM_NAMES.includes(name) || missing) {
      return this.#reply(ws, { error: "Error unsubscribing from channel" });
    }
    const key =
      name === "list"
        ? listKey(String(json.list))
        : name === "hashtag" || name === "hashtag:local"
          ? hashtagKey(name, normalizeTag(String(json.tag)))
          : name;
    if (!at.subs.includes(key)) {
      return;
    }
    this.#update(ws, (current) => ({
      ...current,
      subs: current.subs.filter((sub) => sub !== key),
      tags: Object.fromEntries(Object.entries(current.tags).filter(([tagged]) => tagged !== key)),
    }));
    await this.#sync(at.accountId);
  }

  // Rewrites a socket's attachment from its current one (an await may have let another handler or a turn write it),
  // keeping its `out`.
  #update(ws: WebSocket, change: (at: Attachment) => Attachment): void {
    const current = peek(ws);
    if (current !== null) {
      serialize(ws, { ...change(current), out: current.out });
    }
  }

  // An error reply (Mastodon's): admitted as one frame, and sent only once admitted. A socket that is not open is not
  // answered, and one the reply would take past a cap is closed (1013) instead.
  async #reply(ws: WebSocket, message: Record<string, unknown>): Promise<void> {
    const text = JSON.stringify(message);
    const refused: string[] = [];
    try {
      this.#ensureCharged();
      if (this.#admit(ws, [utf8Length(text)], null, refused)) {
        if (STREAM_FAULTS.failSend?.(ws, "") === true) {
          throw new Error("injected send failure");
        }
        ws.send(text);
      }
    } catch (error) {
      console.warn({ event: "kopje.stream.send-failed", ...errorFields(error) });
      close(ws, 1011, "send failed");
    }
    await this.#syncAccounts(refused);
  }

  // The listed sockets' charge, recomputed from their attachments; a socket whose charge is unknown is closed (1011)
  // and counted, and stays listed until its connection ends. Reads at most one attachment per listed socket, and every
  // socket this release lists counts at least SOCKET_BYTES + capacity(1) within instanceBytes.
  #recompute(): { charge: number; listed: number; unknown: number; closing: number } {
    const listed = this.#ctx.getWebSockets();
    let charge = 0;
    let unknown = 0;
    let closing = 0;
    for (const ws of listed) {
      if (ws.readyState !== WebSocket.OPEN) {
        closing++;
      }
      const at = peek(ws);
      if (at === null) {
        unknown++;
        this.#restore(ws);
      } else {
        charge += socketCharge(at.out[0], at.out[1]);
      }
    }
    this.#charged = charge;
    this.#unknown = unknown;
    if (charge <= 0.75 * STREAM_OUTPUT.instanceBytes) {
      this.#nearArmed = true;
    } else {
      this.#near(charge, listed.length, closing);
    }
    return { charge, listed: listed.length, unknown, closing };
  }

  #ensureCharged(): void {
    if (this.#charged === null) {
      this.#recompute();
    }
  }

  // The instance's charge after an admission or an accepted upgrade; a crossing of three quarters of its cap logs.
  #raise(charge: number): void {
    const before = this.#charged ?? 0;
    this.#charged = charge;
    if (before <= 0.75 * STREAM_OUTPUT.instanceBytes && charge > 0.75 * STREAM_OUTPUT.instanceBytes) {
      const listed = this.#ctx.getWebSockets();
      this.#near(charge, listed.length, listed.filter((ws) => ws.readyState !== WebSocket.OPEN).length);
    }
  }

  #near(charge: number, listed: number, closing: number): void {
    if (this.#nearArmed) {
      this.#nearArmed = false;
      console.warn({
        event: "kopje.stream.output_near",
        scope: "instance",
        charge,
        cap: STREAM_OUTPUT.instanceBytes,
        listed,
        closing,
        unknown: this.#unknown,
      });
    }
  }

  // Admits frames of `sizes` UTF-8 bytes to `ws`, from its latest attachment, in one synchronous step: writes its new
  // `out` (and, for a conversation, its convSeq raised to `convSeq`) and adds what they need to the instance's charge.
  // Returns whether they may be sent. A socket that is not open gets nothing; one whose attachment does not read is
  // closed (1011); while a charge is unknown, or when the frames would take the socket past socketBytes or the listed
  // sockets past instanceBytes, it is closed (1013, `refused` gets its account) and handed nothing. A write that throws
  // closes it (1011) with its `out` as it was.
  #admit(ws: WebSocket, sizes: readonly number[], convSeq: string | null, refused: string[]): boolean {
    if (ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    if (STREAM_FAULTS.failAdmission?.(ws) === true) {
      throw new Error("injected admission failure");
    }
    const at = this.#restore(ws);
    if (at === null) {
      return false;
    }
    const [charged, frames] = at.out;
    const raised = convSeq === null || compareIntegers(at.convSeq, convSeq) >= 0 ? at.convSeq : convSeq;
    if (sizes.length === 0) {
      if (raised !== at.convSeq) {
        this.#write(ws, { ...at, convSeq: raised });
      }
      return false;
    }
    const need = outputNeed(frames, sizes);
    const charge = socketCharge(charged, frames);
    const instance = this.#charged ?? 0;
    const scope =
      this.#unknown > 0
        ? "unknown"
        : charge + need > STREAM_OUTPUT.socketBytes
          ? "socket"
          : instance + need > STREAM_OUTPUT.instanceBytes
            ? "instance"
            : null;
    if (scope !== null) {
      const fields = { scope, frames, charged, need, instance, listed: this.#ctx.getWebSockets().length };
      if (scope === "socket") {
        console.log({ event: "kopje.stream.output_closed", ...fields });
      } else {
        console.warn({ event: "kopje.stream.output_closed", ...fields });
      }
      close(ws, 1013, "output allowance");
      refused.push(at.accountId);
      return false;
    }
    const handed = sizes.reduce((sum, bytes) => sum + frame(bytes), 0);
    if (!this.#write(ws, { ...at, convSeq: raised, out: [charged + handed, frames + sizes.length] })) {
      return false;
    }
    const nearSocket = 0.75 * STREAM_OUTPUT.socketBytes;
    if (charge <= nearSocket && charge + need > nearSocket) {
      const listed = this.#ctx.getWebSockets();
      console.log({
        event: "kopje.stream.output_near",
        scope: "socket",
        charge: charge + need,
        cap: STREAM_OUTPUT.socketBytes,
        listed: listed.length,
        closing: listed.filter((socket) => socket.readyState !== WebSocket.OPEN).length,
        unknown: this.#unknown,
      });
    }
    this.#raise(instance + need);
    return true;
  }

  // Writes a socket's attachment; a write that throws (the clone past the runtime's limit) leaves the attachment as it
  // was and closes the socket (1011).
  #write(ws: WebSocket, at: Attachment): boolean {
    try {
      serialize(ws, at);
      return true;
    } catch (error) {
      console.warn({ event: "kopje.stream.send-failed", ...errorFields(error) });
      close(ws, 1011, "invalid state");
      return false;
    }
  }

  async #syncAccounts(accounts: readonly string[]): Promise<void> {
    for (const accountId of new Set(accounts)) {
      await this.#sync(accountId);
    }
  }

  async #drop(ws: WebSocket, at: Attachment, code: number, reason: string): Promise<void> {
    close(ws, code, reason);
    await this.#sync(at.accountId, ws);
  }

  #keys(accountId: string, except?: WebSocket): Map<string, number> {
    const keys = new Map<string, number>();
    for (const { ws, at } of this.#open(accountTag(accountId))) {
      if (ws !== except) {
        for (const sub of at.subs) {
          keys.set(sub, (keys.get(sub) ?? 0) + 1);
        }
      }
    }
    return keys;
  }

  // Records an account's stream keys from its open sockets (but `closing`). A refusal (maintenance) is logged: the
  // first turn after the Store restarts rebuilds the registry.
  async #sync(accountId: string, closing?: WebSocket): Promise<void> {
    try {
      await this.#run(streamRegister, { accountId, keys: keysOf(this.#keys(accountId, closing)) });
    } catch (error) {
      console.warn({ event: "kopje.stream.register-failed", ...errorFields(error) });
    }
  }

  // The open sockets (of a tag) with valid attachments; an invalid one is closed (1011).
  #open(tag?: string): Socket[] {
    return this.#ctx.getWebSockets(tag).flatMap((ws) => {
      if (ws.readyState !== WebSocket.OPEN) {
        return [];
      }
      const at = this.#restore(ws);
      return at === null ? [] : [{ ws, at }];
    });
  }

  // A socket's attachment, or null after closing it (1011) for one that does not validate: its account is unknown, so
  // the next turn rebuilds the registry, and so is its charge, so nothing is admitted until a recomputation lists none.
  // Its close is logged once, as it leaves the open state (`output_closed`, scope `unknown`, its own numbers null: a
  // previous release's socket at the transition, or an attachment that does not read).
  #restore(ws: WebSocket): Attachment | null {
    const at = peek(ws);
    if (at === null) {
      if (ws.readyState === WebSocket.OPEN) {
        console.warn({
          event: "kopje.stream.output_closed",
          scope: "unknown",
          frames: null,
          charged: null,
          need: null,
          instance: this.#charged,
          listed: this.#ctx.getWebSockets().length,
        });
      }
      close(ws, 1011, "invalid state");
      this.#reconciled = false;
      this.#unknown = Math.max(this.#unknown, 1);
    }
    return at;
  }

  #run<I, O>(operation: StoreOperation<I, O>, input: I): Promise<O> {
    return this.#kernel.execute(this.#kernel.build, operation, input);
  }

  #request(): void {
    if (this.#running) {
      this.#again = true;
      return;
    }
    if (this.#pending !== null) {
      return;
    }
    const seq = ++this.#requests;
    this.#pending = seq;
    this.#ctx.waitUntil(
      this.#turnRequest({ [TURN_HEADER]: String(seq) })
        .then((response) => response.body?.cancel())
        .catch((error: unknown) => {
          // An overloaded or reset object is retried by the next request; anything else is not expected.
          if (toStoreUnavailable(error) === undefined) {
            console.error({ event: "kopje.stream.turn-request-failed", ...errorFields(error) });
          } else {
            console.warn({ event: "kopje.stream.turn-request-failed", ...errorFields(error) });
          }
        })
        .finally(() => {
          if (this.#pending === seq) {
            this.#pending = null;
          }
          this.#notify();
        }),
    );
  }

  #notify(): void {
    for (const resolve of this.#idle.splice(0)) {
      resolve();
    }
  }

  async #turn(request: Request): Promise<Response> {
    if (this.#pending === Number(request.headers.get(TURN_HEADER))) {
      this.#pending = null;
    }
    if (this.#running) {
      this.#again = true;
      return new Response(null, { status: 202 });
    }
    this.#running = true;
    this.#again = false;
    this.#turns++;
    let more = false;
    try {
      more = await this.#fanOut(new Budget(TURN_BUDGET));
      this.#failed = false;
    } catch (error) {
      this.#failed = true;
      if (toStoreUnavailable(error) !== undefined) {
        // The Store refuses its own operations (an import, a schema not current): the sockets cannot be served.
        this.closeAll(1012, "service restart");
      }
      console.error({ event: "kopje.stream.turn-failed", ...errorFields(error) });
    } finally {
      this.#running = false;
    }
    if (more || this.#again) {
      if (STREAM_FAULTS.dropContinuation === null) {
        this.#request();
      } else {
        STREAM_FAULTS.dropContinuation();
      }
    }
    this.#notify();
    return new Response(null, { status: 204 });
  }

  // One turn. Returns whether work is left for the next.
  async #fanOut(budget: Budget): Promise<boolean> {
    this.#recompute();
    if (!this.#reconciled) {
      await this.#reconcile();
    }
    await this.#sweep(budget);
    let full = false;
    for (;;) {
      if (!budget.covers(UNIT_WORST)) {
        return true;
      }
      const scan = await this.#run(streamEvents, { limit: SCAN });
      budget.charge({ checks: 1 });
      if (!full && BigInt(scan.head) - BigInt(scan.tail) >= BigInt(JOURNAL_SPAN - 1)) {
        full = true;
        console.warn({ event: "kopje.stream.journal-full", head: scan.head, tail: scan.tail });
      }
      const state: Walk = { from: scan.position, skipTo: null, ceiling: scan.ceiling };
      for (const event of scan.events) {
        const outcome = await this.#event(event, state, budget);
        if (outcome !== "next") {
          return outcome === "budget";
        }
      }
      if (!(await this.#flush(state))) {
        return false;
      }
      if (scan.events.length < SCAN) {
        const { from } = state;
        const finished = from.account === null ? from.event : String(BigInt(from.event) - 1n);
        // What is left to prune takes further turns, a bounded batch each.
        return (await this.#run(streamPrune, { upTo: finished })).more;
      }
    }
  }

  // The units of one event, sent in order from the position. A delete's are read a page of viewers at a time, each
  // page charged to the turn, so neither the work nor the memory of a turn grows with the capture. What was read and
  // had nothing to send (an event, or a page of a delete's viewers, whose viewers have no socket that takes it) is
  // passed over by a pending position (`skipTo`), written before the next unit, at the end of the scan, and before the
  // turn stops for its budget, so every turn that read something moves the position. Returns whether the walk goes on
  // to the next event, stops for the budget, or lost the position to another turn.
  async #event(event: StreamEvent, state: Walk, budget: Budget): Promise<"next" | "budget" | "lost"> {
    const stop = async () => ((await this.#flush(state)) ? "budget" : "lost");
    let after: StreamUnitAfter =
      state.from.event === event.id && state.from.account !== null
        ? { account: state.from.account, subject: state.from.subject }
        : null;
    for (let more = true; more;) {
      let units: Unit[];
      if (event.kind === "delete") {
        if (!budget.covers(UNIT_WORST)) {
          return stop();
        }
        const page = await this.#run(streamDeleteUnits, {
          eventId: event.id,
          statusId: event.subject,
          after,
          rows: DELETE_PAGE,
        });
        budget.charge({ checks: 1 });
        units = this.#units(event, page.units);
        after = page.next;
        more = page.next !== null;
      } else if (event.kind === "conversation") {
        if (!budget.covers(UNIT_WORST)) {
          return stop();
        }
        const sockets = this.#directSockets(event.subject);
        units = [];
        if (sockets.length > 0) {
          if (after === null) {
            // Entering the event fixes its ceiling; a change after it goes to the owner's next row.
            if (!(await this.#flush(state))) {
              return "lost";
            }
            const ceiling = await this.#run(streamEnterConversation, {
              from: state.from,
              eventId: event.id,
              owner: event.subject,
            });
            if (ceiling === null) {
              return "lost";
            }
            state.from = { event: event.id, subject: "0", account: event.subject };
            state.ceiling = ceiling;
            after = { account: event.subject, subject: "0" };
          }
          units = await this.#conversationUnits(event.subject, sockets, after.subject, state.ceiling);
          budget.charge({ checks: 1 });
        }
        after = null;
        more = false;
      } else {
        units = this.#units(
          event,
          event.viewers.map((viewer) => ({ viewer, subject: { index: "0", id: event.subject } })),
        );
        // The event's viewers after the position were all read: none is left to pass over.
        after = null;
        more = false;
      }
      for (const [i, unit] of units.entries()) {
        if (!budget.covers(UNIT_WORST)) {
          return stop();
        }
        if (!(await this.#flush(state))) {
          return "lost";
        }
        // The event's last unit moves the position past the event directly.
        const last = !more && i === units.length - 1;
        const to = {
          event: event.id,
          subject: last ? "0" : unit.subject.index,
          account: last ? null : unit.viewer,
        };
        if (!(await this.#unit(event, unit, state.from, to, budget))) {
          return "lost";
        }
        state.from = to;
      }
      // The page's viewers are done: the next page starts after its last, sent to or not.
      if (after !== null) {
        state.skipTo = { event: event.id, subject: after.subject, account: after.account };
      }
    }
    if (state.from.event !== event.id || state.from.account !== null) {
      state.skipTo = { event: event.id, subject: "0", account: null };
    }
    return "next";
  }

  // Writes the pending position, if any. False when another turn moved the position first.
  async #flush(state: Walk): Promise<boolean> {
    if (state.skipTo === null) {
      return true;
    }
    if (!(await this.#run(streamAdvance, { from: state.from, to: state.skipTo }))) {
      return false;
    }
    state.from = state.skipTo;
    state.skipTo = null;
    return true;
  }

  // An event's units in candidate order: each viewer's sockets opened before the event with a subscription that may
  // carry it, with their subscribed lists (a delete's: only those its capture allowed) and `public*`/`hashtag*` keys.
  #units(
    event: StreamEvent,
    candidates: readonly { viewer: string; subject: StreamSubject; lists?: readonly string[] }[],
  ): Unit[] {
    // A viewer's sockets are selected once for all its subjects (a delete has up to 41 each).
    const selected = new Map<string, { sockets: Socket[]; lists: Set<string>; feeds: string[] }>();
    return candidates.flatMap(({ viewer, subject, lists }) => {
      let found = selected.get(viewer);
      if (found === undefined) {
        const sockets = this.#open(accountTag(viewer)).filter(
          ({ at }) =>
            compareIntegers(at.since, event.id) < 0 && at.subs.some((sub) => mayCarry(event.kind, at.grant, sub)),
        );
        const subscribed = sockets.flatMap(({ at }) => at.subs.flatMap((sub) => keyList(sub) ?? []));
        const feeds = new Set(sockets.flatMap(({ at }) => at.subs.filter(isFeedKey)));
        found = { sockets, lists: new Set(subscribed), feeds: [...feeds].toSorted() };
        selected.set(viewer, found);
      }
      const { sockets, lists: subscribed, feeds } = found;
      const unitLists = lists === undefined ? [...subscribed] : lists.filter((list) => subscribed.has(list));
      return sockets.length === 0 ? [] : [{ subject, viewer, sockets, lists: unitLists.toSorted(), feeds }];
    });
  }

  // A conversation event's units (its subject is the owner): the owner's newest CONVERSATIONS_PER_TURN changes (older
  // ones skipped) above both the lowest convSeq of its `direct` sockets and the position within the event, up to the
  // event's fixed ceiling (see streamEnterConversation), oldest first. Each unit is one conversation, indexed by its
  // change's sequence, and goes to the sockets whose convSeq is below it. Use convSeq (what the socket has been sent,
  // set from the owner's mark on subscribe), not `since`: a change written after it opened may join a row journaled
  // before.
  async #conversationUnits(owner: string, sockets: Socket[], position: string, ceiling: string): Promise<Unit[]> {
    // Each sequence parsed once, exactly (DATA-6).
    const sent = sockets.map(({ at }) => BigInt(at.convSeq));
    const lowest = sent.reduce((a, b) => (a <= b ? a : b));
    const within = BigInt(position);
    const changes = await this.#run(streamConversations, {
      accountId: owner,
      after: String(lowest >= within ? lowest : within),
      upTo: ceiling,
      limit: CONVERSATIONS_PER_TURN,
    });
    return changes
      .map(({ id, seq }) => {
        const change = BigInt(seq);
        return {
          subject: { index: seq, id },
          viewer: owner,
          sockets: sockets.filter((_, i) => sent[i]! < change),
          lists: [],
          feeds: [],
        };
      })
      .filter((unit) => unit.sockets.length > 0);
  }

  #directSockets(owner: string): Socket[] {
    return this.#open(accountTag(owner)).filter(
      ({ at }) => mayCarry("conversation", at.grant, "direct") && at.subs.includes("direct"),
    );
  }

  // One unit: made (tokens checked, the reference reads, the presentation) and the position moved past it in one
  // transaction, then, for a conversation, the convSeq of the sockets it goes to raised to its change, then sent.
  // Returns false, having sent nothing, when another turn moved the position first.
  async #unit(
    event: StreamEvent,
    unit: Unit,
    from: StreamPosition,
    to: StreamPosition,
    budget: Budget,
  ): Promise<boolean> {
    const { kind } = event;
    const tokenHashes = [...new Set(unit.sockets.map(({ at }) => at.tokenHash))];
    const made = await this.#run(streamUnitAdvance, {
      from,
      to,
      kind,
      subject: unit.subject.id,
      accountId: unit.viewer,
      tokenHashes,
      lists: unit.lists,
      feeds: unit.feeds,
      eventId: event.id,
      now: Date.now(),
    });
    if (made === null) {
      return false;
    }
    budget.charge({ checks: tokenHashes.length + made.checks });
    const payload = made.streams.length > 0 ? encodedPayload(kind, made.payload, budget) : null;
    if (STREAM_FAULTS.beforeAdmission !== null) {
      await STREAM_FAULTS.beforeAdmission();
    }
    // Each socket's frames, from the unit's snapshot: the streams as it named them (streamOf) of its subscriptions that
    // carry the unit, each frame's UTF-8 bytes computed from the envelope's parts (stream-hub envelope).
    const revoked: Socket[] = [];
    const plans: { ws: WebSocket; streams: string[] }[] = [];
    for (const socket of unit.sockets) {
      const grant = made.grants[socket.at.tokenHash];
      if (grant === undefined) {
        revoked.push(socket);
        continue;
      }
      const streams: string[] = [];
      if (payload !== null) {
        for (const sub of socket.at.subs) {
          const target = made.streams.find(({ stream }) => stream === sub);
          if (target !== undefined && grants(grant, target.needs)) {
            streams.push(streamOf(sub, socket.at.tags[sub]));
          }
        }
      }
      plans.push({ ws: socket.ws, streams });
    }
    const eventBytes = utf8Length(JSON.stringify(made.event));
    const frameBytes = (stream: string) => ENVELOPE_KEYS + utf8Length(stream) + eventBytes + (payload?.bytes ?? 0);
    // One synchronous section from the first admission to the last send (RES-6). `owed` counts each socket's frames not
    // yet sent; a socket not admitted owes none. The frames are then grouped by stream as B sends them: each stream's
    // envelope is made, sent to every admitted socket that subscribes with that name, and dropped before the next
    // stream's, so the isolate holds one envelope at a time.
    const owed = new Map(plans.map(({ ws, streams }) => [ws, streams.length]));
    const refused: string[] = [];
    try {
      this.#ensureCharged();
      for (const { ws, streams } of plans) {
        const convSeq = kind === "conversation" ? unit.subject.index : null;
        if (!this.#admit(ws, streams.map(frameBytes), convSeq, refused)) {
          owed.set(ws, 0);
        }
      }
      const recipients = new Map<string, WebSocket[]>();
      for (const { ws, streams } of plans) {
        if (owed.get(ws)! > 0) {
          for (const stream of streams) {
            recipients.set(stream, [...(recipients.get(stream) ?? []), ws]);
          }
        }
      }
      for (const [stream, sockets] of recipients) {
        const text = envelope(stream, made.event, payload!.text);
        for (const ws of sockets) {
          if (STREAM_FAULTS.failSend?.(ws, stream) === true) {
            throw new Error("injected send failure");
          }
          ws.send(text);
          owed.set(ws, owed.get(ws)! - 1);
          budget.charge({ sends: 1 });
        }
      }
    } catch (error) {
      // The sockets left without one of the unit's frames, admitted or not yet decided; an admitted one stays charged.
      console.warn({ event: "kopje.stream.send-failed", ...errorFields(error) });
      for (const [ws, left] of owed) {
        if (left > 0) {
          close(ws, 1011, "send failed");
        }
      }
    }
    await this.#syncAccounts(refused);
    await this.#revoke(revoked);
    return true;
  }

  async #revoke(sockets: Socket[]): Promise<void> {
    for (const { ws } of sockets) {
      close(ws, 1008, "token revoked");
    }
    for (const accountId of new Set(sockets.map(({ at }) => at.accountId))) {
      await this.#sync(accountId);
    }
  }

  // Every open socket's token, checked at the start of each turn (VIS-26).
  async #sweep(budget: Budget): Promise<void> {
    const open = this.#open();
    const pairs = new Map(open.map(({ at }) => [at.tokenHash, at.accountId]));
    if (pairs.size === 0) {
      return;
    }
    const valid = new Set(
      await this.#run(streamTokens, {
        sockets: [...pairs].map(([tokenHash, accountId]) => ({ tokenHash, accountId })),
        now: Date.now(),
      }),
    );
    budget.charge({ checks: pairs.size });
    await this.#revoke(open.filter(({ at }) => !valid.has(at.tokenHash)));
  }

  async #reconcile(): Promise<void> {
    const accounts = new Map<string, Map<string, number>>();
    for (const { at } of this.#open()) {
      const keys = accounts.get(at.accountId) ?? new Map<string, number>();
      for (const sub of at.subs) {
        keys.set(sub, (keys.get(sub) ?? 0) + 1);
      }
      accounts.set(at.accountId, keys);
    }
    await this.#run(streamReconcile, {
      accounts: [...accounts].map(([accountId, keys]) => ({ accountId, keys: keysOf(keys) })),
    });
    this.#reconciled = true;
  }
}

const TOKEN_HASH = /^[0-9a-f]{64}$/;

function grants(grant: StreamGrant, needs: StreamGrant): boolean {
  return (!needs.statuses || grant.statuses) && (!needs.notifications || grant.notifications);
}

function accountTag(accountId: string): string {
  return `a:${accountId}`;
}

function keysOf(keys: Map<string, number>): StreamKeys {
  return [...keys].map(([key, sockets]) => ({ key, sockets }));
}

// The attachment of a socket, validated: version, field types and sizes. Null for anything else.
function peek(ws: WebSocket): Attachment | null {
  let value: unknown;
  try {
    value = ws.deserializeAttachment();
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const at = value as Partial<Record<keyof Attachment, unknown>>;
  const grant = at.grant as Partial<Record<keyof StreamGrant, unknown>> | null | undefined;
  const rate = at.rate as Partial<Record<"window" | "count", unknown>> | null | undefined;
  const subs = at.subs;
  const tags = at.tags as Record<string, unknown> | null | undefined;
  const valid =
    at.v === 2 &&
    validOut(at.out) &&
    typeof at.tokenHash === "string" &&
    TOKEN_HASH.test(at.tokenHash) &&
    typeof at.accountId === "string" &&
    /^\d{1,19}$/.test(at.accountId) &&
    typeof grant === "object" &&
    grant !== null &&
    typeof grant.statuses === "boolean" &&
    typeof grant.notifications === "boolean" &&
    isIntegerText(at.since) &&
    isIntegerText(at.convSeq) &&
    typeof rate === "object" &&
    rate !== null &&
    Number.isFinite(rate.window) &&
    Number.isSafeInteger(rate.count) &&
    Array.isArray(subs) &&
    subs.length <= STREAM_LIMITS.subscriptionsPerSocket &&
    new Set(subs).size === subs.length &&
    subs.every((sub) => typeof sub === "string" && validKey(sub)) &&
    typeof tags === "object" &&
    tags !== null &&
    !Array.isArray(tags) &&
    Object.entries(tags).every(
      ([key, raw]) =>
        subs.includes(key) &&
        keyHashtag(key) !== null &&
        typeof raw === "string" &&
        !exceeds(raw, STREAM_LIMITS.tagBytes),
    ) &&
    (subs as string[]).every((sub) => keyHashtag(sub) === null || Object.hasOwn(tags, sub));
  return valid ? (value as Attachment) : null;
}

// A list id as a `list` parameter may name one (Kopje's are 18 digits; Mastodon's at most 19).
const LIST_ID = /^\d{1,19}$/;

// Whether `key` is a subscription key: a stream's name (but those that take a parameter), `list:<id>`, or a hashtag
// key with its tag within bounds.
function validKey(key: string): boolean {
  const list = keyList(key);
  if (list !== null) {
    return LIST_ID.test(list);
  }
  const hashtag = keyHashtag(key);
  if (hashtag !== null) {
    return !exceeds(hashtag.tag, STREAM_LIMITS.tagBytes);
  }
  return STREAM_NAMES.includes(key) && !["list", "hashtag", "hashtag:local"].includes(key);
}

// A message's `stream`: its first element if it is an array (streaming/utils.js firstParam), as a string.
function firstParam(value: unknown): string {
  const first: unknown = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" ? first : "";
}

// A client message: a JSON object, or null (Mastodon ignores what it cannot parse).
function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// The stream of the key `key` as the client named it (streaming/index.js streamNameFromChannelName), encoded: a list's
// as `["list", id]`, a hashtag's as `["hashtag", tag]` or `["hashtag:local", tag]` with the tag as the client sent it
// (`raw`), any other as `[name]`.
function streamOf(key: string, raw: string | undefined): string {
  const list = keyList(key);
  const hashtag = keyHashtag(key);
  const stream = list !== null ? ["list", list] : hashtag !== null ? [hashtag.stream, raw ?? hashtag.tag] : [key];
  return JSON.stringify(stream);
}

// An outgoing message (streaming/index.js streamToWs): the stream as the client named it (streamOf), the event, and the
// payload, a JSON string already encoded once for all envelopes. ENVELOPE_KEYS is its bytes besides those three.
const ENVELOPE_KEYS = '{"stream":,"event":,"payload":}'.length;

function envelope(stream: string, event: string, encodedPayload: string): string {
  return `{"stream":${stream},"event":${JSON.stringify(event)},"payload":${encodedPayload}}`;
}

// A unit's payload as its frames carry it, or null when it is skipped (RES-6): an object as its JSON encoded again as a
// JSON string, a string (a deleted status's id) encoded once. An object is measured from its presented form
// (encodedTwiceBytes), with no string made, and charged whole, sent or skipped; a payload past payloadBytes is skipped
// and logged before any of it is encoded.
function encodedPayload(kind: string, payload: unknown, budget: Budget): { text: string; bytes: number } | null {
  const object = typeof payload !== "string";
  const bytes = object ? encodedTwiceBytes(payload) : jsonBytes(payload);
  if (object) {
    budget.charge({ presentations: 1, bytes });
  }
  if (bytes > STREAM_LIMITS.payloadBytes) {
    console.warn({ event: "kopje.stream.payload-skipped", kind });
    return null;
  }
  return { text: JSON.stringify(object ? JSON.stringify(payload) : payload), bytes };
}

// A socket's attachment write: the one seam a test may make throw (STREAM_FAULTS.failWrite).
function serialize(ws: WebSocket, at: Attachment): void {
  if (STREAM_FAULTS.failWrite?.(ws) === true) {
    throw new Error("injected attachment write failure");
  }
  ws.serializeAttachment(at);
}

function close(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    // Already closed.
  }
}

// Whether `text` is longer than `limit` bytes of UTF-8. Each UTF-16 unit is one to three bytes, so a text too long or
// short enough by its length is never encoded.
function exceeds(text: string, limit: number): boolean {
  return text.length > limit || (text.length * 3 > limit && new TextEncoder().encode(text).byteLength > limit);
}

// Mastodon's answer to a refused upgrade: the status, no body, and the message in X-Error-Message.
function refusal(status: number, message: string): Response {
  return new Response(null, { status, headers: { "x-error-message": message } });
}
