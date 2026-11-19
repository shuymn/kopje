import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  alloc,
  ATTACHMENT_MAX,
  capacity,
  frame,
  outputNeed,
  SOCKET_BYTES,
  SOCKET_OBJECTS,
  socketCharge,
  STORE_BASELINE,
  STREAM_OUTPUT,
} from "../src/stream-output.js";
import { HEAP_PEAKS, MESSAGE_MAX, STREAM_UNIT_PEAKS } from "../test/presented-maxima.js";

// Held stream output (RES-6, src/stream-output.ts, #1610): the charges' model of workerd's allocations, the ownership
// table behind SOCKET_OBJECTS, and the caps derived from it, the measured idle isolate and the largest Store peak.
// Sources are cited as in workerd 1.20261113.1 (W/ its src/workerd/) and the capnproto it pins, ad77201 (K/ its
// c++/src/kj/).

const MIB = 1024 * 1024;
// STREAM_LIMITS as src/stream-hub.ts declares them (the hub's module graph is the Worker's, not Node's): the open sockets
// an instance takes, the subscriptions a socket holds, and the payload limit in KiB.
const HUB = readFileSync(new URL("../src/stream-hub.ts", import.meta.url), "utf8");
function limit(pattern: RegExp): number {
  const found = pattern.exec(HUB);
  if (found === null) {
    throw new Error(`src/stream-hub.ts declares no ${pattern.source}`);
  }
  return Number(found[1]);
}
const STREAM_LIMITS = {
  socketsPerInstance: limit(/^ {2}socketsPerInstance: (\d+),$/m),
  subscriptionsPerSocket: limit(/^ {2}subscriptionsPerSocket: (\d+),$/m),
  payloadBytes: limit(/^ {2}payloadBytes: (\d+) \* 1024,$/m) * 1024,
};
// The Store isolate's limit, in bytes (RES-3).
const ISOLATE = 128_000_000;
// A frame's bytes besides its payload at their largest (status-bounds.test.ts "bounds a stream unit's isolate peak"):
// the envelope's keys 31, the longest event 23 and the longest stream 1,556.
const ENVELOPE_MAX = 31 + 23 + 1_556;

// KJ's growth rules, step by step: a kj::Vector of rows doubles from 4 when full (K/vector.h:134-144), its previous
// array alive while the rows move; an InsertionOrderIndex's links grow, when a row's position reaches their capacity,
// to the power of two above the rows, at least 8 (K/table.c++:804-829, :840-851), the previous links alive while they
// are copied. For each n up to `most`, the most bytes the queue's arrays held at once after n inserts (index 0: none).
function simulatedQueue(most: number): number[] {
  const peaks = [0];
  let rows = 0;
  let links = 0;
  let peakRows = 0;
  let peakLinks = 0;
  for (let size = 1; size <= most; size++) {
    const pos = size - 1;
    if (links === 0 || pos >= links - 1) {
      const next = Math.max(8, 2 ** (Math.floor(Math.log2(size)) + 1));
      peakLinks = alloc(8 * next) + (links === 0 ? 0 : alloc(8 * links));
      links = next;
    }
    if (pos >= rows) {
      const next = rows === 0 ? 4 : 2 * rows;
      peakRows = alloc(96 * next) + (rows === 0 ? 0 : alloc(96 * rows));
      rows = next;
    }
    peaks.push(peakRows + peakLinks);
  }
  return peaks;
}

// A kj::HashMap of `rowBytes` rows under a sequence of inserts (true) and erases (false), by KJ's rules: its rows a
// kj::Vector as above, an erase moving the last row into the gap and keeping the capacity (K/table.h:770-782); its
// buckets rehashed when an insert would take the live and erased ones past two thirds' load, to the power of two above
// three times the rows and never fewer than before (K/table.h:928-936, K/table.c++:60-79), the previous buckets alive
// while they are copied; an erase only marking its bucket (K/table.h:964-975). An insert that reuses an erased bucket
// is not modeled, which only rehashes sooner. The most bytes held at once, at the last insert and at the end.
function simulatedMap(ops: readonly boolean[], rowBytes: number) {
  let size = 0;
  let rows = 0;
  let buckets = 0;
  let erased = 0;
  let peak = 0;
  let lastInsert = 0;
  const held = () => (rows === 0 ? 0 : alloc(rowBytes * rows)) + (buckets === 0 ? 0 : alloc(8 * buckets));
  for (const insert of ops) {
    if (!insert) {
      size--;
      erased++;
      continue;
    }
    if (buckets * 2 < (size + 1 + erased) * 3) {
      const next = Math.max(buckets, 2 ** (Math.floor(Math.log2((size + 1) * 3)) + 1));
      peak = Math.max(peak, held() + alloc(8 * next));
      buckets = next;
      erased = 0;
    }
    if (size === rows) {
      const next = rows === 0 ? 4 : 2 * rows;
      peak = Math.max(peak, held() + alloc(rowBytes * next));
      rows = next;
    }
    size++;
    lastInsert = held();
    peak = Math.max(peak, lastInsert);
  }
  return { peak, lastInsert, held: held() };
}

// A sequence of inserts and erases with at most `entries` entries at once, reaching it, then every entry erased: a
// random walk from a fixed seed.
function walk(entries: number, seed: number): boolean[] {
  let state = seed;
  const random = () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
  const ops: boolean[] = [];
  let size = 0;
  for (let step = 0; step < 3 * entries; step++) {
    const insert = size === 0 || (size < entries && random() < 0.6);
    ops.push(insert);
    size += insert ? 1 : -1;
  }
  for (; size < entries; size++) {
    ops.push(true);
  }
  for (; size > 0; size--) {
    ops.push(false);
  }
  return ops;
}

// A HashMap's arrays for at most `entries` at once (the design's formula): rows R = max(4, 2^⌈log₂ E⌉) of `rowBytes`,
// buckets B = 2^(⌊log₂ 3E⌋ + 1) of 8, each with its previous array alive while it grows. A rehash that only clears
// erased buckets keeps their number, so the previous buckets are charged at B.
function mapBytes(entries: number, rowBytes: number): number {
  const rows = Math.max(4, 2 ** Math.ceil(Math.log2(entries)));
  const buckets = 2 ** (Math.floor(Math.log2(3 * entries)) + 1);
  return alloc(rowBytes * rows) + alloc((rowBytes / 2) * rows) + 2 * alloc(8 * buckets);
}

// What a socket owns besides its attachment, its Close, its frames and its queue's arrays: one row an owner, its
// members' 64-bit sizes (a pointer, a count or a kj::Own with a static disposer 8; a kj::Own with a disposer, a Maybe of
// a pointer or a kj::Rc 16; a kj::String, kj::Array or kj::Vector header 24; a OneOf its tag and largest member; a
// promise 8, its chain KJ's 1,024-byte arena), its bound under `alloc`, and its basis: layout (members and arenas),
// assumed (an allowance: a coroutine frame F = alloc(4,096), the compiler's size, and a JavaScript object's).
//
// A chain is KJ's promise arena: newAdaptedPromise and a node appended to a promise that is not in an arena (a
// coroutine's own node) start a new one; then(), attach() and a join appended to an arena-allocated promise share its
// arena while it has room (K/async-inl.h:296-353, :1755-1762). The WebSocketPair pipe's operations (rows from "the
// pipe's send or Close in flight" on) are counted at the most of each that can be alive at once for one socket; the
// transport beyond the pipe (the connection the client end is coupled to, its send copies and its reads) is not KJ's
// pipe and stays outside, as the message being received does.
const F = alloc(4096);
const CHAIN = alloc(1024);
type Owner = { owner: string; cite: string; members: string; bytes: number; basis: "layout" | "assumed" };
const OWNERSHIP: Owner[] = [
  {
    owner: "api::WebSocket and its V8 wrapper",
    cite: "W/api/web-socket.h:129-373",
    members: "the object alloc(512), its wrapper alloc(256)",
    bytes: alloc(512) + alloc(256),
    basis: "assumed",
  },
  {
    owner: "LegacyWebSocketAdapter",
    cite: "W/api/web-socket.h:524-901, members :839-900",
    members: "328 bytes of members; a WebSocketPair's server end has no url, protocol or extensions string",
    bytes: alloc(328),
    basis: "layout",
  },
  {
    owner: "Native with Accepted and Hibernatable",
    cite: "W/api/web-socket.h:708-731, :619-701, :622-634",
    members: "Native 144; the tags array (two kj::String) 48; `a:` and 19 digits 22; `t:` and 64 hex digits 67",
    bytes: alloc(144) + alloc(48) + alloc(22) + alloc(67),
    basis: "layout",
  },
  {
    owner: "Accepted.whenAbortedTask and the pump's canceler",
    cite: "W/api/web-socket.h:690, :679-681, :700",
    members: "two chains",
    bytes: 2 * CHAIN,
    basis: "layout",
  },
  {
    owner: "AutoResponse and maybePumpCompletion",
    cite: "W/api/web-socket.h:744-769; W/api/web-socket.c++:1238-1241",
    members: "AutoResponse 128; the fork's and the fulfiller's chains; the WeakFulfiller 64",
    bytes: alloc(128) + 2 * CHAIN + alloc(64),
    basis: "layout",
  },
  {
    owner: "OutgoingMessagesMap's object",
    cite: "W/api/web-socket.h:740",
    members: "the row vector 24, the index (capacity 8, links 8, its header 8) 24; its arrays are capacity(n)",
    bytes: alloc(48),
    basis: "layout",
  },
  {
    owner: "four IoOwn nodes",
    cite: "W/io/io-own.h:64-73; W/api/web-socket.h:879, :889, :893; W/api/web-socket.c++:1258",
    members:
      "SpecificOwnedObject 40 each (next 16, prev 8, ptr 16): farNative, outgoingMessages, autoResponse, awaitIo",
    bytes: 4 * alloc(40),
    basis: "layout",
  },
  {
    owner: "the pump coroutine and its JavaScript promise",
    cite: "W/api/web-socket.c++:1355-1512, :1250-1258",
    members: "F; the promise and its continuations alloc(512)",
    bytes: F + alloc(512),
    basis: "assumed",
  },
  {
    owner: "HibernatableWebSocket",
    cite: "W/io/legacy-hibernation-manager.h:108-173, :92-99",
    members: "392 bytes; its std::list node 32; two TagListItems 128; maybeWriteBarrier's fork",
    bytes: alloc(392) + alloc(32) + alloc(128) + CHAIN,
    basis: "layout",
  },
  {
    owner: "two TagCollections",
    cite: "W/io/legacy-hibernation-manager.h:230-236; W/io/legacy-hibernation-manager.c++:190-195",
    members: "each 48 (tag, list), its list node 24, its string and the table's copy (22 and 22; 67 and 67)",
    bytes: 2 * (alloc(48) + alloc(24)) + 2 * alloc(22) + 2 * alloc(67),
    basis: "layout",
  },
  {
    owner: "HibernationPackage",
    cite: "W/api/web-socket.h:140-159",
    members: "in place of the adapter while hibernated, smaller than it: charged in the adapter's row",
    bytes: 0,
    basis: "layout",
  },
  {
    owner: "handleReadLoop and readLoop",
    cite: "W/io/legacy-hibernation-manager.c++:217-233, :548-664",
    members: "two coroutines F; their task's and the pending receive's chains",
    bytes: 2 * F + 2 * CHAIN,
    basis: "assumed",
  },
  {
    owner: "the WebSocketPair pipe",
    cite: "W/api/web-socket.c++:1636; K/compat/http.c++:4204, :4813",
    members: "two WebSocketPipeImpl 256 each; two WebSocketPipeEnd 64 each",
    bytes: 2 * alloc(256) + 2 * alloc(64),
    basis: "layout",
  },
  {
    owner: "an event in delivery",
    cite: "W/io/legacy-hibernation-manager.c++:441-447, :482-484, :631-634",
    members: "its id three times (36 and a NUL); the delivery's chain; the event's objects alloc(512)",
    bytes: 3 * alloc(37) + CHAIN + alloc(512),
    basis: "assumed",
  },
  {
    // The adapter's pump awaits each send and its Close before the next (W/api/web-socket.c++:1442, :1450), and the
    // pipe refuses a second while one is in progress (K/compat/http.c++:4374-4386, :4656), so one is alive at a time.
    owner: "the pipe's send or Close in flight",
    cite: "K/compat/http.c++:4234-4258, :4352-4433, :4655-4677",
    members:
      "WebSocketPipeImpl::send or close, a coroutine F; awaiting BlockedSend's adapted promise, or BlockedPumpTo's " +
      "canceler wrap of the transport's send (one chain) or of its close and then() (two chains)",
    bytes: F + 2 * CHAIN,
    basis: "assumed",
  },
  {
    // coupleImpl pumps the client end to the transport for the connection's life (W/api/web-socket.c++:675). A pump
    // that finds a BlockedSend sends it and continues with a second pumpTo (K/compat/http.c++:4408-4427), which finds
    // no state (the sender resumes only later) and holds BlockedPumpTo until the Close (:4630-4677): two levels at most.
    owner: "the client end's pump to the transport",
    cite: "W/api/web-socket.c++:674-675; K/compat/http.c++:4285-4304, :4408-4433, :4630-4721, :4856-4862",
    members:
      "first level: pumpToNoAbort F, its abort watch, its exclusiveJoin with attach, BlockedSend::pumpTo's then() " +
      "and canceler wrap (four chains); second: pumpToNoAbort F, its abort watch, its exclusiveJoin, " +
      "BlockedPumpTo's adapted promise (three chains)",
    bytes: 2 * F + 7 * CHAIN,
    basis: "assumed",
  },
  {
    // The transport's pump into the client end (W/api/web-socket.c++:674): KJ's default pumpTo takes the pipe's
    // tryPumpFrom (K/compat/http.c++:4181-4199, :4273-4278, :4590-4603, :4841-4853: adapted promises and wraps, three
    // chains at most), else loops (:4151-4179), sending each message into the pipe one at a time.
    owner: "the transport's pump into the client end",
    cite: "W/api/web-socket.c++:674; K/compat/http.c++:4151-4199, :4234-4250, :4273-4278, :4590-4603, :4841-4853",
    members:
      "the loop: pumpWebSocketLoop F, its abort watch and its exclusiveJoin (two chains), and one send into the " +
      "pipe, a coroutine F awaiting BlockedSend (one chain)",
    bytes: 2 * F + 3 * CHAIN,
    basis: "assumed",
  },
];

describe("a socket's charges (RES-6)", () => {
  it("bounds the queue's arrays by KJ's growth rules", () => {
    expect(capacity(0)).toBe(0);
    const peaks = simulatedQueue(70_000);
    let previous = 0;
    for (let n = 1; n <= 70_000; n++) {
      const bound = capacity(n);
      const simulated = peaks[n]!;
      expect(bound).toBeGreaterThanOrEqual(previous);
      // Equal once both arrays have grown from their first allocation; above it before.
      if (n >= 8) {
        if (bound !== simulated) {
          expect({ n, bound }).toEqual({ n, bound: simulated });
        }
      } else {
        expect(bound).toBeGreaterThan(simulated);
      }
      previous = bound;
    }
    expect([1, 4, 5, 7, 8, 9, 15, 16, 17].map(capacity)).toEqual([
      928, 928, 1_696, 1_696, 1_792, 3_328, 3_328, 3_520, 6_592,
    ]);
  });

  it("charges a frame's block, its branch arena and its hub arena", () => {
    expect([127, 128, 2_047, 2_048, 4_096].map(frame)).toEqual([2_224, 2_352, 4_144, 6_192, 10_288]);
    expect(frame(MESSAGE_MAX)).toBe(264_240);
  });

  it("pins the ownership table's owners and total", () => {
    expect(OWNERSHIP.map((row) => row.owner)).toEqual([
      "api::WebSocket and its V8 wrapper",
      "LegacyWebSocketAdapter",
      "Native with Accepted and Hibernatable",
      "Accepted.whenAbortedTask and the pump's canceler",
      "AutoResponse and maybePumpCompletion",
      "OutgoingMessagesMap's object",
      "four IoOwn nodes",
      "the pump coroutine and its JavaScript promise",
      "HibernatableWebSocket",
      "two TagCollections",
      "HibernationPackage",
      "handleReadLoop and readLoop",
      "the WebSocketPair pipe",
      "an event in delivery",
      "the pipe's send or Close in flight",
      "the client end's pump to the transport",
      "the transport's pump into the client end",
    ]);
    const total = OWNERSHIP.reduce((sum, row) => sum + row.bytes, 0);
    expect(total).toBe(59_552);
    expect(SOCKET_OBJECTS).toBe(total);
    expect(SOCKET_BYTES).toBe(alloc(ATTACHMENT_MAX) + frame(123) + total);
    expect(SOCKET_BYTES).toBe(78_176);
  });

  it("charges a socket its objects, its frames and its queue with the Close", () => {
    expect(socketCharge(0, 0)).toBe(79_104);
    expect(outputNeed(0, [1_024, 1_024])).toBe(2 * 4_144);
    // A third frame grows the rows from 4 to 8 and the links from 8 to 16 once the Close is counted.
    expect(outputNeed(3, [1_024])).toBe(4_144 + capacity(5) - capacity(4));
    expect(socketCharge(0, 0) + outputNeed(0, [1_024, 1_024, 1_024])).toBe(socketCharge(3 * 4_144, 3));
  });
});

// The largest Store-isolate peak of one request: the answers' backstop peaks, and a turn's unit peak plus its
// attachments' working memory (a deserialized attachment of each open socket three times, and one write's buffers).
const ATTACHMENT_WORKING =
  STREAM_LIMITS.socketsPerInstance * 3 * ATTACHMENT_MAX + alloc(ATTACHMENT_MAX) + alloc(2 * ATTACHMENT_MAX);
const UNIT_PEAK = Math.max(...Object.values(STREAM_UNIT_PEAKS).map((p) => p.peak));
const P = Math.max(...Object.values(HEAP_PEAKS).map((p) => p.backstop), UNIT_PEAK + ATTACHMENT_WORKING);
// The most sockets of this release listed at once: each counts at least a fresh socket's charge.
const N = Math.floor((ISOLATE - P) / socketCharge(0, 0));
// The most sockets a hibernation manager lists: its ACTIVE_CONNECTION_LIMIT, 1024 * 32
// (W/io/legacy-hibernation-manager.h:303-305). acceptWebSocket throws once the manager holds that many (allWs,
// .c++:165-166), and a socket stays in allWs until it is destroyed (.c++:162-163), open or closing. A previous release
// limited only its open sockets, so nothing smaller bounds the ones its manager held.
const LISTED_MAX = 32 * 1024;
// Reservations that never return. The hibernation manager's tag table: two tags a socket, rows of a kj::String key and a
// kj::Own, 40 bytes (K/map.h:49-52, W/io/legacy-hibernation-manager.h:251), at this release's N; what a previous
// release's sockets grew is outside until the manager goes (RES-6). The registry of events in delivery: rows of a
// kj::String and two pointers, 40 bytes (W/io/legacy-hibernation-manager.h:181-200); one event a socket at a time (the
// read loop's, cancelled before its next receive, and then the termination's: .c++:482-484, :631-634). It is an
// EventLoopLocal (.c++:16-19) shared by every manager on the loop, and a row is only ever erased (.c++:145-147, :437,
// :456), so its arrays keep their high-water for the event loop's life, past the sockets and the manager that grew
// them. A previous release's sockets, which nothing here bounds, may reach the most a manager lists, so it is reserved
// there; rows of other Workers' objects on the same loop are outside, as those objects' memory is.
const TAG_TABLE_BYTES = mapBytes(2 * N, 40);
const EVENT_TABLE_BYTES = mapBytes(Math.max(N, LISTED_MAX), 40);

describe("the caps (RES-6)", () => {
  // The tag table's reservation at its largest (no socket's objects: N = 2,545, E = 5,090) and below: for every most
  // entries at once E, a walk of inserts and erases that reaches E holds at most the formula's bytes, and keeps its
  // arrays once every entry is erased.
  it("reserves the hash tables' arrays at their high-water", () => {
    for (let entries = 1; entries <= 5_090; entries++) {
      const ops = walk(entries, entries);
      const walked = simulatedMap(ops, 40);
      expect(walked.peak).toBeLessThanOrEqual(mapBytes(entries, 40));
      expect(walked.held).toBe(walked.lastInsert);
    }
    expect(mapBytes(5_090, 40)).toBe(1_048_640);
  });

  // The registry's arrays after every event is gone: inserts to E, then all erased (as cancelEvent and a manager's
  // destruction do), hold the high-water. 4,097 events leave 655,392 bytes, past a reservation at this Store's N; the
  // most a manager lists, reached and emptied, and a walk to it, stay within EVENT_TABLE_BYTES.
  it("reserves the event registry at the most sockets a manager lists", () => {
    const filledThenEmptied = (entries: number) =>
      simulatedMap([...Array<boolean>(entries).fill(true), ...Array<boolean>(entries).fill(false)], 40);
    expect(filledThenEmptied(4_097).held).toBe(655_392);
    expect(filledThenEmptied(4_097).held).toBeGreaterThan(mapBytes(N, 40));
    const most = filledThenEmptied(LISTED_MAX);
    expect(most.held).toBe(most.lastInsert);
    expect(most.peak).toBeLessThanOrEqual(EVENT_TABLE_BYTES);
    expect(simulatedMap(walk(LISTED_MAX, 7), 40).peak).toBeLessThanOrEqual(EVENT_TABLE_BYTES);
  });

  it("derives instanceBytes and socketBytes from the baseline, the largest peak and the tables", () => {
    expect({ ATTACHMENT_WORKING, UNIT_PEAK, P, N, TAG_TABLE_BYTES, EVENT_TABLE_BYTES }).toEqual({
      ATTACHMENT_WORKING: 12_632_096,
      UNIT_PEAK: 48_502_314.5,
      P: HEAP_PEAKS.groups.backstop,
      N: 616,
      TAG_TABLE_BYTES: 262_208,
      EVENT_TABLE_BYTES: 5_242_944,
    });
    const room = ISOLATE - Math.ceil(1.25 * STORE_BASELINE.bytes) - P - TAG_TABLE_BYTES - EVENT_TABLE_BYTES;
    expect(room).toBe(17_675_103);
    const instanceBytes = Math.floor(room / MIB) * MIB;
    expect(STREAM_OUTPUT.instanceBytes).toBe(instanceBytes);
    expect(STREAM_OUTPUT.socketBytes).toBe(Math.floor(instanceBytes / 3 / MIB) * MIB);
    expect([STREAM_OUTPUT.instanceBytes / MIB, STREAM_OUTPUT.socketBytes / MIB]).toEqual([16, 5]);
  });

  // The fresh sockets instanceBytes holds, fewer than socketsPerInstance: the socket limit is reached only if the output
  // allowance allows, as docs/threat-model.md (RES-6) and docs/mastodon-deviations.md ("Streaming output") state.
  it("holds fewer fresh sockets than socketsPerInstance", () => {
    const fresh = Math.floor(STREAM_OUTPUT.instanceBytes / socketCharge(0, 0));
    expect(fresh).toBe(212);
    expect(fresh).toBeLessThan(STREAM_LIMITS.socketsPerInstance);
    const flat = (doc: string) => readFileSync(new URL(`../docs/${doc}`, import.meta.url), "utf8").replace(/\s+/g, " ");
    expect(flat("threat-model.md")).toContain(`\`instanceBytes\` holds ${fresh} fresh sockets`);
    expect(flat("mastodon-deviations.md")).toContain(`it holds ${fresh} fresh connections`);
  });

  // A fresh socket subscribed to every stream it may hold takes a unit of the largest frame on each, with its Close.
  it("takes any unit on a fresh socket", () => {
    const need = socketCharge(0, 0) + outputNeed(0, Array(STREAM_LIMITS.subscriptionsPerSocket).fill(MESSAGE_MAX));
    expect(need).toBe(SOCKET_BYTES + 16 * frame(MESSAGE_MAX) + capacity(17));
    expect(need).toBe(4_312_608);
    expect(need).toBeLessThanOrEqual(STREAM_OUTPUT.socketBytes);
  });

  // payloadBytes is the largest multiple of 1 KiB whose largest frame and its NUL fit 2^18 bytes: a frame's block then
  // rounds to 2^18 at most.
  it("keeps the largest frame's block within 2^18 bytes", () => {
    const { payloadBytes } = STREAM_LIMITS;
    expect(MESSAGE_MAX).toBe(payloadBytes + ENVELOPE_MAX);
    expect(payloadBytes % 1024).toBe(0);
    expect(MESSAGE_MAX + 1).toBeLessThanOrEqual(2 ** 18);
    expect(payloadBytes + 1024 + ENVELOPE_MAX + 1).toBeGreaterThan(2 ** 18);
  });

  // A client reading as fast as frames come is closed once its frames would pass socketBytes: the most it is handed.
  it("closes a reading client after its frames reach the cap", () => {
    const most = (bytes: number) => {
      let frames = 0;
      while (socketCharge(0, 0) + outputNeed(0, Array(frames + 1).fill(bytes)) <= STREAM_OUTPUT.socketBytes) {
        frames++;
      }
      return frames;
    };
    expect([most(2_048), most(4_096)]).toEqual([800, 491]);
    // docs/mastodon-deviations.md, "Streaming output", states them.
    const deviations = readFileSync(new URL("../docs/mastodon-deviations.md", import.meta.url), "utf8");
    expect(deviations.replace(/\s+/g, " ")).toContain("closed after 491 to 800 frames of 4 to 2 KB");
  });

  it("records the baseline on the pinned workerd", () => {
    const require = createRequire(import.meta.url);
    const wrangler = dirname(require.resolve("wrangler/package.json"));
    const miniflare = dirname(createRequire(join(wrangler, "package.json")).resolve("miniflare/package.json"));
    const workerd = createRequire(join(miniflare, "package.json")).resolve("workerd/package.json");
    expect(STORE_BASELINE.workerd).toBe((JSON.parse(readFileSync(workerd, "utf8")) as { version: string }).version);
  });
});
