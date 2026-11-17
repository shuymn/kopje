import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_MEDIA_DESCRIPTION_LENGTH, MAX_STATUS_MEDIA } from "../../src/domain/status-bounds";
import { utf8Length } from "../../src/platform/dump-format";
import { STREAM_FAULTS, STREAM_LIMITS } from "../../src/stream-hub";
import { ATTACHMENT_MAX, cloneBound, STREAM_OUTPUT } from "../../src/stream-output";
import { bearer, sql } from "../api-helpers";
import { BUILD } from "../helpers";
import { community, follow, post, type User } from "../status-helpers";
import { describedMedia, encodedTwice, FILLS, payloadBytes, writeFilled } from "./payload-fills";
import { connect, Inbox, keepWriting, settled, type StreamMessage, upgrade } from "./stream-helpers";

// Held stream output (RES-6, src/stream-output.ts): every frame the hub hands a socket is charged to it until the socket
// leaves getWebSockets(), and a unit, an error reply or an upgrade past a cap closes the socket (1013) or answers 503.
// The caps are lowered where a case says (STREAM_OUTPUT). Sockets subscribe through the upgrade's `?stream=` or with
// their subscriptions waited for on the Store, never with an echo, whose error reply would be charged too. A client
// that must stay listed never accepts its end, so it reads nothing and never answers the Close.
//
// Each charge is worked out here from the inventory, not computed by src/stream-output.ts. A(x) = 2^⌈log₂ x⌉ + 16:
// - a frame of b bytes is A(b + 1) + 2 × A(1,024) = A(b + 1) + 2,080: of 1,024 to 2,047 bytes 2,064 + 2,080 = 4,144, of
//   32 to 63 bytes (every error reply here) 80 + 2,080 = 2,160, of 2^17 to 2^18 − 1 bytes 262,160 + 2,080 = 264,240;
// - capacity(n) = A(96R) + A(48R) + A(8L) + A(4L), R = max(4, 2^⌈log₂ n⌉), L = max(8, 2^(⌊log₂ n⌋ + 1)):
//   capacity(1 to 4) = 528 + 272 + 80 + 48 = 928, capacity(5 to 7) = 1,040 + 528 + 80 + 48 = 1,696, capacity(8) =
//   1,040 + 528 + 144 + 80 = 1,792, capacity(9 to 15) = 2,064 + 1,040 + 144 + 80 = 3,328, capacity(16) = 2,064 + 1,040
//   + 272 + 144 = 3,520, capacity(17) = 4,112 + 2,064 + 272 + 144 = 6,592;
// - SOCKET_BYTES = A(16,384) + A(124) + 2,080 + SOCKET_OBJECTS (59,552) = 16,400 + 144 + 2,080 + 59,552 = 78,176, so a
//   fresh socket is charged 78,176 + capacity(1) = 79,104;
// - a socket's charge is 78,176 + its frames' charges + capacity(frames + 1).
const FRESH = 79_104;
const FRAME_1K = 4_144;
const REPLY = 2_160;

const CAPS = { ...STREAM_OUTPUT };
const LIMITS = { ...STREAM_LIMITS };

afterEach(() => {
  Object.assign(STREAM_OUTPUT, CAPS);
  Object.assign(STREAM_LIMITS, LIMITS);
  Object.assign(STREAM_FAULTS, {
    beforeAdmission: null,
    beforeAccept: null,
    failWrite: null,
    failSend: null,
    failAdmission: null,
  });
  vi.restoreAllMocks();
});

type Out = [charged: number, frames: number];
type Server = { accountId: string; subs: string[]; out: Out; readyState: number };

// The listed sockets as the Store holds them, in the order it lists them (of one account when given).
function servers(h: { store: DurableObjectStub }, accountId?: string): Promise<Server[]> {
  return runInDurableObject(h.store as never, (_instance, state: DurableObjectState) =>
    state.getWebSockets(accountId === undefined ? undefined : `a:${accountId}`).map((ws) => {
      const at = ws.deserializeAttachment() as { accountId: string; subs: string[]; out: Out };
      return { accountId: at.accountId, subs: at.subs, out: at.out, readyState: ws.readyState };
    }),
  );
}

// Waits, without a fixed time, until `test` holds of the listed sockets.
async function until(h: { store: DurableObjectStub }, test: (listed: Server[]) => boolean): Promise<Server[]> {
  for (let i = 0; i < 500; i++) {
    const listed = await servers(h);
    if (test(listed)) {
      return listed;
    }
  }
  throw new Error("the listed sockets never matched");
}

// A reading socket of `user` subscribed to `streams`: the first by the upgrade, the rest by messages, waited for on the
// Store (the attachment holds them once the registry does).
async function opened(h: Parameters<typeof connect>[0] & { store: DurableObjectStub }, user: User, streams: string[]) {
  const before = (await servers(h, user.id)).length;
  const [first, ...rest] = streams;
  const inbox = await connect(h, user.token, { query: `stream=${first}` });
  for (const stream of rest) {
    inbox.send({ type: "subscribe", stream });
  }
  await until(h, () => true);
  for (let i = 0; i < 500; i++) {
    const own = await servers(h, user.id);
    if (own.length > before && own.at(-1)!.subs.length === streams.length) {
      return inbox;
    }
  }
  throw new Error("the subscriptions never took effect");
}

// A socket whose client never reads: upgraded with `?stream=`, its end not accepted until `read` is called.
async function stalled(h: Parameters<typeof upgrade>[0], user: User, stream: string) {
  const response = await upgrade(h, user.token, { query: `stream=${stream}` });
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  return {
    read: () => {
      const inbox = new Inbox(ws);
      ws.accept();
      return inbox;
    },
  };
}

// The output log entries written so far, by event.
function outputLogs(...spies: { mock: { calls: unknown[][] } }[]): Record<string, Record<string, unknown>[]> {
  const entries = spies.flatMap((spy) => spy.mock.calls.map(([entry]) => entry as Record<string, unknown>));
  const by: Record<string, Record<string, unknown>[]> = {};
  for (const entry of entries) {
    const event = typeof entry?.event === "string" ? entry.event : "";
    if (event.startsWith("kopje.stream.output_")) {
      (by[event] ??= []).push(entry);
    }
  }
  return by;
}

function spyLogs() {
  return {
    log: vi.spyOn(console, "log").mockImplementation(() => {}),
    warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
  };
}

const updates = (inbox: Inbox) => inbox.messages.filter((m) => m.event === "update");
const frameOf = (m: StreamMessage) => utf8Length(JSON.stringify(m));
// A frame's charge by its received UTF-8 bytes, worked out above for the sizes these cases send.
const chargeOf = (bytes: number) => {
  if (bytes >= 1_024 && bytes <= 2_047) {
    return FRAME_1K;
  }
  if (bytes >= 32 && bytes <= 63) {
    return REPLY;
  }
  throw new Error(`no literal charge for a frame of ${bytes} bytes`);
};

async function drain(h: { store: { streamDrained: (build: string) => Promise<unknown> } }): Promise<void> {
  await h.store.streamDrained(BUILD);
}

// A public status of `user`'s: a local one goes to `public` and `public:local`, one frame each of 1,024 to 2,047 bytes.
async function status(h: Parameters<typeof post>[0], user: User): Promise<string> {
  return (await post(h, user, { status: "output", visibility: "public" })).id;
}

describe("closing a socket at its output cap (RES-6)", () => {
  // bob on `public` and `public:local`: each of alice's statuses is two frames, every unit its own transaction and
  // write generation. After three units: 6 frames, 24,864 bytes, a charge of 78,176 + 24,864 + capacity(7) (1,696) =
  // 104,736. The fourth needs 2 × 4,144 + capacity(9) (3,328) − 1,696 = 9,920. At a cap of 104,736 the third is sent
  // (the comparison is ≤) and the fourth closes the socket; at 104,736 plus one more frame's need (4,144 + capacity(8) −
  // capacity(7) = 4,240), 108,976, the fourth still closes it, none of its frames sent (admission is per unit).
  it.each([
    ["at its charge", 104_736],
    ["one frame's need past it", 108_976],
  ] as const)("closes a socket at its output cap, sending none of the unit, with the cap %s", async (_name, cap) => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    STREAM_OUTPUT.socketBytes = cap;
    const logs = spyLogs();
    const inbox = await opened(h, bob, ["public", "public:local"]);
    const sent: string[] = [];
    for (let i = 0; i < 3; i++) {
      sent.push(await status(h, alice));
      await inbox.next((m) => m.event === "update" && m.stream?.[0] === "public:local");
    }
    const last = await status(h, alice);
    expect(await inbox.closed()).toEqual({ code: 1013, reason: "output allowance" });
    const frames = updates(inbox);
    expect(frames.map((m) => (JSON.parse(m.payload!) as { id: string }).id)).toEqual(sent.flatMap((id) => [id, id]));
    expect(frames.some((m) => m.payload!.includes(last))).toBe(false);
    const counted = frames.reduce((sum, m) => sum + chargeOf(frameOf(m)), 0);
    expect(counted).toBe(24_864);
    expect(outputLogs(logs.log, logs.warn)["kopje.stream.output_closed"]).toEqual([
      {
        event: "kopje.stream.output_closed",
        scope: "socket",
        frames: 6,
        charged: counted,
        need: 9_920,
        instance: 104_736,
        listed: 1,
      },
    ]);
  });

  // bob on `public:local`, one frame a unit. Three frames leave a charge of 78,176 + 12,432 + capacity(4) (928) =
  // 91,536; the fourth needs 4,144 + capacity(5) (1,696) − 928 = 4,912, as the queue reserves its Close past the four
  // frames. At a cap of 95,680, the charge the fourth would leave counted without its Close (78,176 + 16,576 + 928),
  // the fourth closes it.
  it("reserves the Close", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    STREAM_OUTPUT.socketBytes = 95_680;
    const logs = spyLogs();
    const inbox = await opened(h, bob, ["public:local"]);
    for (let i = 0; i < 3; i++) {
      await status(h, alice);
      await inbox.next((m) => m.event === "update");
    }
    await status(h, alice);
    expect((await inbox.closed()).code).toBe(1013);
    expect(updates(inbox)).toHaveLength(3);
    expect(outputLogs(logs.log, logs.warn)["kopje.stream.output_closed"]).toMatchObject([
      { scope: "socket", frames: 3, charged: 12_432, need: 4_912 },
    ]);
  });
});

describe("a fresh socket (RES-6)", () => {
  // The shipped caps. bob, following alice, subscribes to 16 streams that all carry her status: user, the four public
  // streams, six `hashtag` and five `hashtag:local` keys, one of them a tag of 256 bytes. The status's payload is
  // within 1 KiB of payloadBytes, so each of its 16 frames is longer than 2^17 bytes and charged 264,240: 4,227,840,
  // and the socket 78,176 + 4,227,840 + capacity(17) (6,592) = 4,312,608, within socketBytes. Its descriptions start as
  // ASCII and are raised to the target with U+0001 (+6 bytes a character), U+1F600 (+3) and U+3042 (+2).
  it("takes any unit on a fresh socket", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    await follow(h, bob, alice.id);
    const long = "a".repeat(256);
    const tags = ["t1", "t2", "t3", "t4", "t5"];
    const text = [...tags, long].map((tag) => `#${tag}`).join(" ");
    const fill = { ...FILLS.plain, text, spoiler: "" };
    // The probe status, written before bob subscribes, gives the payload with ASCII descriptions.
    const ascii = Array.from({ length: MAX_STATUS_MEDIA }, () => "a".repeat(MAX_MEDIA_DESCRIPTION_LENGTH));
    const probe = await writeFilled(h, alice, fill, await describedMedia(h, alice, ascii));
    await drain(h);
    const shown = async (id: string) =>
      payloadBytes(await (await h.request(`/api/v1/statuses/${id}`, bearer(bob.token))).text());
    const base = await shown(probe);
    const gap = STREAM_LIMITS.payloadBytes - 512 - base;
    const emoji = gap % 2;
    const controls = Math.floor((gap - 3 * emoji) / 6);
    const kana = (gap - 3 * emoji - 6 * controls) / 2;
    expect(controls + emoji + kana).toBeLessThanOrEqual(MAX_STATUS_MEDIA * MAX_MEDIA_DESCRIPTION_LENGTH);
    let left = { controls, emoji, kana };
    const descriptions = ascii.map(() => {
      const c = Math.min(left.controls, MAX_MEDIA_DESCRIPTION_LENGTH);
      const e = Math.min(left.emoji, MAX_MEDIA_DESCRIPTION_LENGTH - c);
      const k = Math.min(left.kana, MAX_MEDIA_DESCRIPTION_LENGTH - c - e);
      left = { controls: left.controls - c, emoji: left.emoji - e, kana: left.kana - k };
      return (
        "\u0001".repeat(c) +
        "\u{1F600}".repeat(e) +
        "あ".repeat(k) +
        "a".repeat(MAX_MEDIA_DESCRIPTION_LENGTH - c - e - k)
      );
    });
    expect(descriptions.reduce((sum, d) => sum + encodedTwice(d), 0) - 4 * encodedTwice(ascii[0]!)).toBe(gap);
    const media = await describedMedia(h, alice, descriptions);
    const streams = [
      "user",
      "public",
      "public:media",
      "public:local",
      "public:local:media",
      ...[...tags, long].map((tag) => `hashtag ${tag}`),
      ...[...tags.slice(0, 4), long].map((tag) => `hashtag:local ${tag}`),
    ];
    expect(streams).toHaveLength(STREAM_LIMITS.subscriptionsPerSocket);
    const inbox = await connect(h, bob.token);
    for (const stream of streams) {
      const [name, tag] = stream.split(" ");
      inbox.send({ type: "subscribe", stream: name, ...(tag === undefined ? {} : { tag }) });
    }
    await until(h, (listed) => listed.length === 1 && listed[0]!.subs.length === streams.length);
    const logs = spyLogs();
    const id = await writeFilled(h, alice, fill, media);
    await h.store.streamTick(BUILD);
    for (let i = 0; i < streams.length; i++) {
      await inbox.next((m) => m.event === "update");
    }
    await drain(h);
    const frames = updates(inbox);
    expect(frames).toHaveLength(16);
    const payload = await shown(id);
    expect(payload).toBeGreaterThan(STREAM_LIMITS.payloadBytes - 1024);
    expect(payload).toBeLessThanOrEqual(STREAM_LIMITS.payloadBytes);
    for (const m of frames) {
      expect(frameOf(m)).toBeGreaterThan(2 ** 17);
      expect(frameOf(m)).toBeLessThan(2 ** 18);
    }
    expect(inbox.isClosed).toBe(false);
    expect((await servers(h, bob.id))[0]!.out).toEqual([16 * 264_240, 16]);
    // Past three quarters of socketBytes, which logs output_near, and closes nothing.
    expect(outputLogs(logs.log, logs.warn)).toEqual({
      "kopje.stream.output_near": [
        {
          event: "kopje.stream.output_near",
          scope: "socket",
          charge: 4_312_608,
          cap: STREAM_OUTPUT.socketBytes,
          listed: 1,
          closing: 0,
          unknown: 0,
        },
      ],
    });
  }, 60_000);
});

describe("the instance's cap (RES-6)", () => {
  // bob on `public` and `public:local` (two frames a status), carol on `public:local` (one). Both fresh: the instance's
  // charge is 158,208. At a cap of 158,208 + 8,287, bob's unit (8,288) passes it and closes his socket; carol's (4,144)
  // fits and arrives.
  it("closes the recipient that would pass the instance's cap", async () => {
    const h = await community(["alice", "bob", "carol"]);
    const { alice, bob, carol } = h.users;
    const logs = spyLogs();
    const first = await opened(h, bob, ["public", "public:local"]);
    const second = await opened(h, carol, ["public:local"]);
    STREAM_OUTPUT.instanceBytes = 2 * FRESH + 2 * FRAME_1K - 1;
    const id = await status(h, alice);
    expect((await first.closed()).code).toBe(1013);
    expect(JSON.parse((await second.next((m) => m.event === "update")).payload!)).toMatchObject({ id });
    expect(updates(first)).toEqual([]);
    expect(outputLogs(logs.log, logs.warn)["kopje.stream.output_closed"]).toMatchObject([
      { scope: "instance", frames: 0, charged: 0, need: 8_288, instance: 158_208 },
    ]);
  });

  // bob's socket, its client never reading, is closed at its cap and stays listed (closing), still counted: with the
  // instance's cap at two fresh sockets less one byte, carol's upgrade is refused. Once bob's client reads the Close and
  // answers it, the socket leaves, and the next upgrade is accepted.
  it("counts a closed socket until it leaves", async () => {
    const h = await community(["alice", "bob", "carol"]);
    const { alice, bob, carol } = h.users;
    STREAM_OUTPUT.socketBytes = FRESH + FRAME_1K - 1;
    STREAM_OUTPUT.instanceBytes = 2 * FRESH - 1;
    const logs = spyLogs();
    const quiet = await stalled(h, bob, "public:local");
    await status(h, alice);
    await drain(h);
    expect((await servers(h, bob.id)).map((s) => s.readyState)).toEqual([WebSocket.CLOSING]);
    const refused = await upgrade(h, carol.token);
    expect([refused.status, refused.headers.get("x-error-message")]).toEqual([503, "Too many connections"]);
    expect(outputLogs(logs.log, logs.warn)["kopje.stream.output_refused"]).toEqual([
      {
        event: "kopje.stream.output_refused",
        scope: "instance",
        charge: FRESH,
        need: FRESH,
        cap: 2 * FRESH - 1,
        listed: 1,
        unknown: 0,
      },
    ]);
    const inbox = quiet.read();
    expect((await inbox.closed()).code).toBe(1013);
    await until(h, (listed) => listed.length === 0);
    const accepted = await upgrade(h, carol.token);
    expect(accepted.status).toBe(101);
    accepted.webSocket!.accept();
    accepted.webSocket!.close();
  });

  // bob's and carol's sockets on `public:local`, both fresh (158,208). bob's client closes; the socket leaves, and nothing
  // recomputes until alice's status starts a turn, which finds carol's alone (79,104): her frame (4,144) fits a cap of
  // 158,208 + 4,143, which the cached sum would pass.
  it("returns a departed socket's credit at the next turn", async () => {
    const h = await community(["alice", "bob", "carol"]);
    const { alice, bob, carol } = h.users;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const leaving = await opened(h, bob, ["public:local"]);
    const staying = await opened(h, carol, ["public:local"]);
    STREAM_OUTPUT.instanceBytes = 2 * FRESH + FRAME_1K - 1;
    leaving.ws.close();
    await until(h, (listed) => listed.length === 1);
    const id = await status(h, alice);
    expect(JSON.parse((await staying.next((m) => m.event === "update")).payload!)).toMatchObject({ id });
    expect(staying.isClosed).toBe(false);
  });

  // One fresh socket listed: an upgrade needs 79,104 more. At a cap one byte short it answers 503 and logs why; at the
  // cap, 101.
  it("refuses an upgrade the instance cannot hold", async () => {
    const h = await community(["bob", "carol"]);
    const { bob, carol } = h.users;
    const logs = spyLogs();
    await opened(h, bob, ["public:local"]);
    STREAM_OUTPUT.instanceBytes = 2 * FRESH - 1;
    const refused = await upgrade(h, carol.token);
    expect([refused.status, refused.headers.get("x-error-message")]).toEqual([503, "Too many connections"]);
    expect(outputLogs(logs.log, logs.warn)["kopje.stream.output_refused"]).toMatchObject([
      { scope: "instance", charge: FRESH, need: FRESH, cap: 2 * FRESH - 1, listed: 1 },
    ]);
    STREAM_OUTPUT.instanceBytes = 2 * FRESH;
    const accepted = await upgrade(h, carol.token);
    expect(accepted.status).toBe(101);
    accepted.webSocket!.accept();
    expect(await servers(h)).toHaveLength(2);
  });

  // At the derived caps, unlowered: instanceBytes, 16 MiB (16,777,216), holds 212 fresh sockets (16,770,048), fewer than
  // socketsPerInstance (256), and the 213th upgrade (16,849,152) answers 503. Once a socket's client closes and the
  // socket leaves, its charge returns and the next upgrade is accepted.
  it("admits 212 fresh sockets at the derived caps, and the 213th once one leaves", async () => {
    expect(STREAM_OUTPUT.instanceBytes).toBe(16_777_216);
    const names = Array.from({ length: 14 }, (_, i) => `fresh${i}`);
    const h = await community(names);
    const owner = (i: number) => h.users[names[Math.floor(i / STREAM_LIMITS.socketsPerAccount)]!]!;
    const logs = spyLogs();
    const inboxes: Inbox[] = [];
    for (let i = 0; i < 212; i++) {
      inboxes.push(await connect(h, owner(i).token));
    }
    const refused = await upgrade(h, owner(212).token);
    expect([refused.status, refused.headers.get("x-error-message")]).toEqual([503, "Too many connections"]);
    expect(outputLogs(logs.log, logs.warn)["kopje.stream.output_refused"]).toMatchObject([
      { scope: "instance", charge: 212 * FRESH, need: FRESH, cap: 16_777_216, listed: 212, unknown: 0 },
    ]);
    inboxes[0]!.ws.close();
    await until(h, (listed) => listed.length === 211);
    const accepted = await upgrade(h, owner(212).token);
    expect(accepted.status).toBe(101);
    accepted.webSocket!.accept();
  }, 120_000);

  // A case whose receiver the cap closes ends, and its producer with it: bob's first unit passes the instance's cap
  // (1013), his wait for it fails on the close, and alice's statuses stop by themselves at the close, far below their
  // bound.
  it("ends a case whose receiver the cap closes", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const inbox = await opened(h, bob, ["public:local"]);
    STREAM_OUTPUT.instanceBytes = FRESH + FRAME_1K - 1;
    const writing = keepWriting(
      async () => {
        await status(h, alice);
        await drain(h);
      },
      100,
      [inbox],
    );
    await expect(inbox.next((m) => m.event === "update")).rejects.toThrow("the socket closed (1013)");
    expect(await writing.done).toBeLessThan(100);
  });

  // An upgrade whose attachment write throws answers 500 and lists no socket: the attachment is written before the
  // socket is accepted.
  it("lists no socket for an upgrade whose attachment write fails", async () => {
    const h = await community(["bob"]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    let once = true;
    STREAM_FAULTS.failWrite = () => {
      const fail = once;
      once = false;
      return fail;
    };
    const failed = await upgrade(h, h.users.bob.token);
    expect(failed.status).toBe(500);
    expect(await servers(h)).toEqual([]);
    expect(once).toBe(false);
    const accepted = await upgrade(h, h.users.bob.token);
    expect(accepted.status).toBe(101);
  });
});

describe("charges across hibernation (RES-6)", () => {
  // bob's room after one frame is 4,143 bytes, less than the next frame's 4,144: after the Store is evicted, its
  // socket hibernated and its client still connected, the next unit closes it.
  it("keeps charges across hibernation", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    STREAM_OUTPUT.socketBytes = FRESH + 2 * FRAME_1K - 1;
    const inbox = await opened(h, bob, ["public:local"]);
    await status(h, alice);
    await inbox.next((m) => m.event === "update");
    await evictDurableObject(h.store);
    await status(h, alice);
    expect((await inbox.closed()).code).toBe(1013);
    expect(updates(inbox)).toHaveLength(1);
  });

  // After the Store is evicted, nothing has recomputed the instance's charge (79,104, bob's socket) when bob asks to
  // subscribe to an unknown stream: the reply's 2,160 would pass a cap of 79,104 + 2,159, so the socket is closed and
  // sent no reply.
  it("recomputes before the first frame after a wake", async () => {
    const h = await community(["bob"]);
    const inbox = await opened(h, h.users.bob, ["public:local"]);
    STREAM_OUTPUT.instanceBytes = FRESH + REPLY - 1;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await evictDurableObject(h.store);
    inbox.send({ type: "subscribe", stream: "kopje-unknown" });
    expect((await inbox.closed()).code).toBe(1013);
    expect(inbox.messages).toEqual([]);
  });
});

describe("error replies (RES-6)", () => {
  // A socket 2,159 bytes short of its cap, every error reply 2,160: each is refused, the socket closed with no reply.
  it.each([
    ["a subscribe to an unknown stream", { type: "subscribe", stream: "kopje-unknown" }],
    ["an unsubscribe of an unknown stream", { type: "unsubscribe", stream: "kopje-unknown" }],
    ["a subscribe refused after its registry read", { type: "subscribe", stream: "list", list: "123456789012345678" }],
  ] as const)("charges the reply to %s", async (_name, message) => {
    const h = await community(["bob"]);
    STREAM_OUTPUT.socketBytes = FRESH + REPLY - 1;
    const logs = spyLogs();
    const inbox = await opened(h, h.users.bob, ["public:local"]);
    inbox.send(message);
    expect((await inbox.closed()).code).toBe(1013);
    expect(inbox.messages).toEqual([]);
    expect(outputLogs(logs.log, logs.warn)["kopje.stream.output_closed"]).toMatchObject([
      { scope: "socket", frames: 0, charged: 0, need: REPLY },
    ]);
  });

  it("charges the reply to an upgrade's subscription to an unknown stream", async () => {
    const h = await community(["bob"]);
    STREAM_OUTPUT.socketBytes = FRESH + REPLY - 1;
    vi.spyOn(console, "log").mockImplementation(() => {});
    const inbox = await connect(h, h.users.bob.token, { query: "stream=kopje-unknown" });
    expect((await inbox.closed()).code).toBe(1013);
    expect(inbox.messages).toEqual([]);
  });
});

describe("admission from the latest attachment (RES-6)", () => {
  // A gate a unit waits at. The Store runs the gate, so the test learns that a unit reached it by asking the Store
  // (`until`), and releases it in the Store's context: a promise the Store settles runs its waiters there, where the
  // test's sockets cannot be used, and the reverse.
  function admissionGate(h: { store: DurableObjectStub }) {
    let release!: () => void;
    let reached = false;
    const gate = new Promise<void>((resolve) => (release = resolve));
    STREAM_FAULTS.beforeAdmission = () => {
      reached = true;
      return gate;
    };
    return {
      arrived: () => until(h, () => reached),
      release: () => runInDurableObject(h.store as never, () => release()),
    };
  }

  // A unit waits before its admission while bob's error reply is admitted (1 frame, 2,160). Released, the unit's frame
  // (4,144) adds to it: `out` is [6,304, 2], the charge 78,176 + 6,304 + capacity(3) (928) = 85,408, and an upgrade at
  // a cap of 85,408 + 79,104 − 1 is refused.
  it("takes the latest credit", async () => {
    const h = await community(["alice", "bob", "carol"]);
    const { alice, bob, carol } = h.users;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const inbox = await opened(h, bob, ["public:local"]);
    const { arrived, release } = admissionGate(h);
    const posted = status(h, alice);
    await arrived();
    inbox.send({ type: "subscribe", stream: "kopje-unknown" });
    await inbox.next((m) => m.error === "Unknown stream type");
    await release();
    await posted;
    await inbox.next((m) => m.event === "update");
    expect((await servers(h, bob.id))[0]!.out).toEqual([REPLY + FRAME_1K, 2]);
    STREAM_OUTPUT.instanceBytes = 85_408 + FRESH - 1;
    expect((await upgrade(h, carol.token)).status).toBe(503);
  });

  // bob's error reply is charged (one frame, 2,160); his next subscription, accepted with no reply, rewrites the
  // attachment and keeps that charge.
  it("keeps a socket's charge across its subscriptions", async () => {
    const h = await community(["bob"]);
    const inbox = await opened(h, h.users.bob, ["public:local"]);
    inbox.send({ type: "subscribe", stream: "kopje-unknown" });
    await inbox.next((m) => m.error === "Unknown stream type");
    expect((await servers(h))[0]!.out).toEqual([REPLY, 1]);
    inbox.send({ type: "subscribe", stream: "public" });
    const [socket] = await until(h, (listed) => listed[0]!.subs.length === 2);
    expect(socket).toMatchObject({ subs: ["public:local", "public"], out: [REPLY, 1] });
  });

  // A unit waits before its admission while bob subscribes to another stream; released, the attachment holds the new
  // subscription and the unit's charge.
  it("keeps a subscription made during a unit", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    const inbox = await opened(h, bob, ["public:local"]);
    const { arrived, release } = admissionGate(h);
    const posted = status(h, alice);
    await arrived();
    inbox.send({ type: "subscribe", stream: "public" });
    await until(h, (listed) => listed[0]!.subs.length === 2);
    await release();
    await posted;
    await inbox.next((m) => m.event === "update");
    expect(await servers(h, bob.id)).toMatchObject([{ subs: ["public:local", "public"], out: [FRAME_1K, 1] }]);
  });

  // Two upgrades wait together after their token checks, with room for one fresh socket: one is accepted, the other
  // refused, as each recomputes after its wait.
  it("counts concurrent upgrades", async () => {
    const h = await community(["bob", "carol"]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    STREAM_OUTPUT.instanceBytes = 2 * FRESH - 1;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let waiting = 0;
    let both!: () => void;
    const arrived = new Promise<void>((resolve) => (both = resolve));
    STREAM_FAULTS.beforeAccept = () => {
      if (++waiting === 2) {
        both();
      }
      return gate;
    };
    const pending = [upgrade(h, h.users.bob.token), upgrade(h, h.users.carol.token)];
    await arrived;
    release();
    const statuses = (await Promise.all(pending)).map((r) => r.status).toSorted((a, b) => a - b);
    expect(statuses).toEqual([101, 503]);
  });
});

describe("failures during a unit (RES-6)", () => {
  // bob's two sockets, one unit: the first (its client not reading, on `public:local`) fails its attachment write, so it
  // is sent nothing, closed (1011) with its `out` as it was, and still counted while listed; the second (on
  // `public:local` and `public`, listed after it) receives the unit and stays open, which a send to the first, throwing
  // on its closed socket, would prevent.
  it("sends nothing when the write fails", async () => {
    const h = await community(["alice", "bob", "dave"]);
    const { alice, bob, dave } = h.users;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const quiet = await stalled(h, bob, "public:local");
    const other = await opened(h, bob, ["public:local", "public"]);
    STREAM_FAULTS.failWrite = (ws) => (ws.deserializeAttachment() as { subs: string[] }).subs.length === 1;
    const id = await status(h, alice);
    await other.next((m) => m.event === "update" && m.stream?.[0] === "public");
    await other.next((m) => m.event === "update" && m.stream?.[0] === "public:local");
    await drain(h);
    STREAM_FAULTS.failWrite = null;
    expect(other.isClosed).toBe(false);
    expect(updates(other).map((m) => (JSON.parse(m.payload!) as { id: string }).id)).toEqual([id, id]);
    expect((await servers(h, bob.id)).map(({ out, readyState }) => ({ out, readyState }))).toEqual([
      { out: [0, 0], readyState: WebSocket.CLOSING },
      { out: [2 * FRAME_1K, 2], readyState: WebSocket.OPEN },
    ]);
    // The first's 79,104 and the second's 78,176 + 8,288 + capacity(3) (928) = 87,392 are listed: a fresh socket does
    // not fit one byte short.
    STREAM_OUTPUT.instanceBytes = FRESH + 87_392 + FRESH - 1;
    expect((await upgrade(h, dave.token)).status).toBe(503);
    const inbox = quiet.read();
    expect((await inbox.closed()).code).toBe(1011);
    expect(updates(inbox)).toEqual([]);
  });

  // One account's sockets X on `public`, Y on `public` and `public:local`, Z on `public:local`; a status carries both
  // streams. The send of Y's `public:local` frame throws after `public` was sent to X and Y: Y and Z are closed (1011),
  // Y's persisted `out` counting both its frames, and X stays open and receives the next unit.
  it("closes only the recipients a failure leaves unsent", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const x = await opened(h, bob, ["public"]);
    const y = await opened(h, bob, ["public", "public:local"]);
    const z = await opened(h, bob, ["public:local"]);
    let atFailure: Out | null = null;
    STREAM_FAULTS.failSend = (ws, stream) => {
      const at = ws.deserializeAttachment() as { subs: string[]; out: Out };
      if (stream === '["public:local"]' && at.subs.length === 2) {
        atFailure = at.out;
        return true;
      }
      return false;
    };
    await status(h, alice);
    expect((await y.closed()).code).toBe(1011);
    expect((await z.closed()).code).toBe(1011);
    expect(atFailure).toEqual([2 * FRAME_1K, 2]);
    STREAM_FAULTS.failSend = null;
    expect(updates(y)).toHaveLength(1);
    expect(updates(z)).toEqual([]);
    const id = await status(h, alice);
    expect(JSON.parse((await x.next((m) => m.event === "update" && m.payload!.includes(id))).payload!)).toMatchObject({
      id,
    });
    expect(x.isClosed).toBe(false);
  });

  // The admission of the second of three recipients throws: all three are closed (1011), none sent the unit, the first
  // already charged it.
  it("closes the recipients not yet decided when an admission fails", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const inboxes = [
      await opened(h, bob, ["public:local"]),
      await opened(h, bob, ["public:local"]),
      await opened(h, bob, ["public:local"]),
    ];
    let calls = 0;
    let first: Out | null = null;
    STREAM_FAULTS.failAdmission = () => {
      calls++;
      return calls === 2;
    };
    STREAM_FAULTS.failSend = (ws) => {
      first ??= (ws.deserializeAttachment() as { out: Out }).out;
      return false;
    };
    const charged = until(h, (listed) => listed.some((s) => s.out[1] === 1));
    await status(h, alice);
    for (const inbox of inboxes) {
      expect((await inbox.closed()).code).toBe(1011);
      expect(updates(inbox)).toEqual([]);
    }
    expect(first).toBeNull();
    expect(calls).toBe(2);
    expect((await charged).find((s) => s.out[1] === 1)?.out).toEqual([FRAME_1K, 1]);
  });
});

describe("unknown charges (RES-6)", () => {
  // bob's socket (its client not reading) has an attachment of the previous release's shape: the first turn closes it
  // (1011) and logs that close once (`output_closed`, scope `unknown`, its own numbers null, as the transition's close
  // of every socket of the previous release); while it is listed nothing is admitted (carol's unit and dave's error
  // reply close their sockets, 1013, each logged with its numbers) and upgrades answer 503; once it ends, accounting
  // resumes.
  it("stops output while a charge is unknown", async () => {
    const h = await community(["alice", "bob", "carol", "dave"]);
    const { alice, bob, carol, dave } = h.users;
    const logs = spyLogs();
    const quiet = await stalled(h, bob, "public:local");
    const recipient = await opened(h, carol, ["public:local"]);
    const replier = await opened(h, dave, ["user"]);
    await runInDurableObject(h.store, (_instance, state) => {
      const ws = state.getWebSockets(`a:${bob.id}`)[0]!;
      const { out: _out, ...rest } = ws.deserializeAttachment() as Record<string, unknown>;
      ws.serializeAttachment({ ...rest, v: 1 });
    });
    await status(h, alice);
    expect((await recipient.closed()).code).toBe(1013);
    replier.send({ type: "subscribe", stream: "kopje-unknown" });
    expect((await replier.closed()).code).toBe(1013);
    expect(updates(recipient)).toEqual([]);
    expect(replier.messages).toEqual([]);
    expect((await upgrade(h, carol.token)).status).toBe(503);
    const logged = outputLogs(logs.log, logs.warn);
    expect(logged["kopje.stream.output_closed"]).toMatchObject([
      { scope: "unknown", frames: null, charged: null, need: null, listed: 3 },
      { scope: "unknown", frames: 0, charged: 0, need: FRAME_1K },
      { scope: "unknown", frames: 0, charged: 0, need: REPLY },
    ]);
    expect(logged["kopje.stream.output_refused"]).toMatchObject([{ scope: "unknown", unknown: 1 }]);
    expect((await quiet.read().closed()).code).toBe(1011);
    await until(h, (listed) => listed.length === 0);
    const inbox = await opened(h, carol, ["public:local"]);
    const id = await status(h, alice);
    expect(JSON.parse((await inbox.next((m) => m.event === "update")).payload!)).toMatchObject({ id });
  });

  // An `out` that is missing, of one element, negative, not a number, a fraction or past socketBytes is unknown: the
  // next upgrade is refused.
  it.each([
    ["missing", undefined],
    ["one element", [0]],
    ["negative", [-1, 0]],
    ["not a number", [Number.NaN, 0]],
    ["a fraction", [0.5, 0]],
    ["past socketBytes", [CAPS.socketBytes + 1, 0]],
  ] as const)("refuses an out that is %s", async (_name, out) => {
    const h = await community(["bob", "carol"]);
    const logs = spyLogs();
    await opened(h, h.users.bob, ["public:local"]);
    await runInDurableObject(h.store, (_instance, state) => {
      const ws = state.getWebSockets()[0]!;
      const { out: _out, ...rest } = ws.deserializeAttachment() as Record<string, unknown>;
      ws.serializeAttachment(out === undefined ? rest : { ...rest, out });
    });
    expect((await upgrade(h, h.users.carol.token)).status).toBe(503);
    expect(outputLogs(logs.log, logs.warn)["kopje.stream.output_refused"]).toMatchObject([{ scope: "unknown" }]);
  });
});

describe("output_near (RES-6, DATA-5)", () => {
  // bob on `public:local` at a cap of 108,976 (three quarters: 81,732): his charge goes 79,104, 83,248 (the crossing),
  // 87,392, 91,536, 96,448, then, after the Store is evicted, 100,592, 104,736 and 108,976, the cap. One output_near.
  it("logs output_near once a socket", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    STREAM_OUTPUT.socketBytes = 108_976;
    const logs = spyLogs();
    const inbox = await opened(h, bob, ["public:local"]);
    for (let i = 0; i < 7; i++) {
      if (i === 4) {
        await evictDurableObject(h.store);
      }
      await status(h, alice);
      await inbox.next((m) => m.event === "update");
    }
    expect(inbox.isClosed).toBe(false);
    expect(outputLogs(logs.log, logs.warn)["kopje.stream.output_near"]).toEqual([
      {
        event: "kopje.stream.output_near",
        scope: "socket",
        charge: 83_248,
        cap: 108_976,
        listed: 1,
        closing: 0,
        unknown: 0,
      },
    ]);
  });

  // The instance at a cap of 228,000 (three quarters: 171,000). bob and carol on `public:local`: two statuses take them
  // to 87,392 each, the crossing (174,784). carol leaves; dave's upgrade recomputes 87,392 (re-armed) and adds 79,104;
  // a status takes them to 174,784 again, the second crossing. After the Store is evicted, the next turn's recompute
  // finds the same 174,784, past three quarters with the arming forgotten: the third.
  it("re-arms output_near for the instance", async () => {
    const h = await community(["alice", "bob", "carol", "dave"]);
    const { alice, bob, carol, dave } = h.users;
    STREAM_OUTPUT.instanceBytes = 228_000;
    const logs = spyLogs();
    const b = await opened(h, bob, ["public:local"]);
    const c = await opened(h, carol, ["public:local"]);
    for (let i = 0; i < 2; i++) {
      await status(h, alice);
      await b.next((m) => m.event === "update");
      await c.next((m) => m.event === "update");
    }
    c.ws.close();
    await until(h, (listed) => listed.length === 1);
    const d = await opened(h, dave, ["public:local"]);
    await status(h, alice);
    await b.next((m) => m.event === "update");
    await d.next((m) => m.event === "update");
    await evictDurableObject(h.store);
    await status(h, alice);
    await b.next((m) => m.event === "update");
    const near = outputLogs(logs.log, logs.warn)["kopje.stream.output_near"]!;
    expect(near.map((e) => [e.scope, e.charge])).toEqual([
      ["instance", 174_784],
      ["instance", 174_784],
      ["instance", 174_784],
    ]);
  });
});

describe("the attachment's bound (RES-6)", () => {
  // A subscription is refused when the attachment's clone could pass the runtime's 16 KiB with any `out`
  // (stream-hub.ts #subscribe). The largest attachments that bound admits, filled with a tag of one-byte characters or
  // of two-byte ones and with `out` at its largest numbers, are written for real.
  it.each([
    ["one-byte", "a", 1],
    ["two-byte", "\u0100", 2],
  ] as const)("writes the largest attachment it admits, of %s characters", async (_name, char, width) => {
    const h = await community(["bob"]);
    await opened(h, h.users.bob, ["public:local"]);
    const written = await runInDurableObject(h.store, (_instance, state) => {
      const ws = state.getWebSockets()[0]!;
      const at = ws.deserializeAttachment() as Record<string, unknown>;
      const base = { ...at, tags: { "hashtag:x": "" }, out: [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER] };
      const fill = char.repeat(Math.floor((ATTACHMENT_MAX - cloneBound(base)) / width));
      const largest = { ...base, tags: { "hashtag:x": fill } };
      ws.serializeAttachment(largest);
      return {
        bound: cloneBound(largest),
        whole: (ws.deserializeAttachment() as typeof largest).tags["hashtag:x"] === fill,
      };
    });
    expect(written.bound).toBeLessThanOrEqual(ATTACHMENT_MAX);
    expect(written.bound).toBeGreaterThan(ATTACHMENT_MAX - width);
    expect(written.whole).toBe(true);
  });
});

describe("the attachment's clone (RES-6)", () => {
  // With the JSON bound and the counts raised out of the way (STREAM_LIMITS), hashtag subscriptions of 256-byte tags
  // grow the attachment until its clone could pass the runtime's 16 KiB: that subscription is refused (429) before the
  // registry is written, the socket stays open with the subscriptions it had, and its attachment's clone is within the
  // bound. The shipped JSON bound (12 KiB) keeps every attachment below it, so this refusal is a backstop.
  it("refuses a subscription whose attachment's clone could pass the runtime's limit", async () => {
    const h = await community(["bob"]);
    Object.assign(STREAM_LIMITS, { attachmentBytes: 1024 * 1024, subscriptionsPerSocket: 64, keysPerAccount: 64 });
    const inbox = await connect(h, h.users.bob.token);
    let refused = -1;
    for (let i = 0; i < 64 && refused === -1; i++) {
      inbox.send({ type: "subscribe", stream: "hashtag", tag: `${"t".repeat(250)}${String(i).padStart(6, "0")}` });
      await settled(h, inbox);
      if (inbox.rest().some((m) => m.error === "Too many subscriptions")) {
        refused = i;
      }
    }
    expect(refused).toBeGreaterThan(0);
    expect(inbox.isClosed).toBe(false);
    const [socket] = await servers(h);
    expect(socket!.subs).toHaveLength(refused);
    const at = await runInDurableObject(
      h.store,
      (_instance, state) => state.getWebSockets()[0]!.deserializeAttachment() as unknown,
    );
    expect(cloneBound(at)).toBeLessThanOrEqual(ATTACHMENT_MAX);
    expect(await sql(h.store, "SELECT count(*) AS n FROM stream_subscriptions")).toEqual([{ n: refused }]);
  });
});

describe("the output logs (DATA-5)", () => {
  // Each output event carries its scope and counts only: never the account, the token or a stream (a hashtag here).
  it("logs the scope and counts only", async () => {
    const h = await community(["alice", "bob", "carol"]);
    const { alice, bob, carol } = h.users;
    const marker = "kopjeoutputmarker";
    const logs = spyLogs();
    STREAM_OUTPUT.socketBytes = FRESH + FRAME_1K + FRAME_1K - 1;
    STREAM_OUTPUT.instanceBytes = 2 * FRESH - 1;
    const inbox = await connect(h, bob.token, { query: `stream=hashtag&tag=${marker}` });
    await until(h, (listed) => listed.length === 1 && listed[0]!.subs.length === 1);
    STREAM_OUTPUT.socketBytes = FRESH + 1;
    // 79,104 is past three quarters of a cap of 79,105: the first reply's admission is refused.
    await post(h, alice, { status: `#${marker}`, visibility: "public" });
    expect((await inbox.closed()).code).toBe(1013);
    await until(h, (listed) => listed.length === 0);
    STREAM_OUTPUT.socketBytes = CAPS.socketBytes;
    await opened(h, bob, [`public:local`]);
    expect((await upgrade(h, carol.token)).status).toBe(503);
    const logged = outputLogs(logs.log, logs.warn);
    const fields = {
      "kopje.stream.output_closed": ["event", "scope", "frames", "charged", "need", "instance", "listed"],
      "kopje.stream.output_refused": ["event", "scope", "charge", "need", "cap", "listed", "unknown"],
      "kopje.stream.output_near": ["event", "scope", "charge", "cap", "listed", "closing", "unknown"],
    };
    expect(Object.keys(logged).toSorted()).toEqual(
      ["kopje.stream.output_closed", "kopje.stream.output_refused"].toSorted(),
    );
    for (const [event, entries] of Object.entries(logged)) {
      for (const entry of entries) {
        expect(Object.keys(entry)).toEqual(fields[event as keyof typeof fields]);
        const text = JSON.stringify(entry);
        for (const secret of [marker, bob.token, bob.id, carol.token, carol.id]) {
          expect(text).not.toContain(secret);
        }
      }
    }
  });
});
