// Held stream output (RES-6, #1610): what a socket is charged for everything the hub hands it, from the send until the
// socket leaves getWebSockets(), and the caps the charges are held to. No signal of unsent output reaches JavaScript,
// and only the end of a connection proves its queue drained, so a charge returns only when its socket is no longer
// listed. The charges model workerd's allocations under the allocator assumption `alloc` (every block rounded up to a
// power of two, plus 16 bytes of header), from workerd's and KJ's source as test-node/stream-output.test.ts cites them;
// that test derives every constant here and fails when one moves.

// The bytes a heap block of `bytes` takes under the allocator assumption.
export function alloc(bytes: number): number {
  return 2 ** Math.ceil(Math.log2(Math.max(1, bytes))) + 16;
}

// KJ's promise arena: a chain a frame keeps alive is one.
const ARENA = 1024;

// A frame of `bytes` UTF-8 bytes: its text and a NUL (`send` copies it into a kj::String), the output gate's branch it
// waits on, and the hub of the write generation that branch keeps.
export function frame(bytes: number): number {
  return alloc(bytes + 1) + 2 * alloc(ARENA);
}

// A queued frame's row (GatedMessage: an optional promise 16, a kj::WebSocket::Message 40, a count 8, an optional
// external-memory adjustment 32) and the insertion-order index's link.
const QUEUE_ROW = 96;
const QUEUE_LINK = 8;

// The socket queue's row vector and index for the most frames it may have held, `n` (every frame it was handed, its
// Close included), each with the previous array alive beside it while it grows; nothing is freed while frames wait.
export function capacity(n: number): number {
  if (n <= 0) {
    return 0;
  }
  const rows = Math.max(4, 2 ** Math.ceil(Math.log2(n)));
  const links = Math.max(8, 2 ** (Math.floor(Math.log2(n)) + 1));
  return (
    alloc(QUEUE_ROW * rows) +
    alloc((QUEUE_ROW / 2) * rows) +
    alloc(QUEUE_LINK * links) +
    alloc((QUEUE_LINK / 2) * links)
  );
}

// The runtime's limit on an attachment's structured clone, and on a close reason's UTF-8 bytes.
export const ATTACHMENT_MAX = 16 * 1024;
const CLOSE_REASON_MAX = 123;

// The socket's other objects: the total of the ownership table (test-node/stream-output.test.ts), the WebSocket pipe's
// send, Close and pumps included (KJ's coroutine frames and promise arenas live at once, at most, per socket).
export const SOCKET_OBJECTS = 59_552;

// What every listed socket is charged besides its frames: its attachment at the runtime's limit, its Close and its
// objects.
export const SOCKET_BYTES = alloc(ATTACHMENT_MAX) + frame(CLOSE_REASON_MAX) + SOCKET_OBJECTS;

// The idle Store isolate as `pnpm --filter kopje bench:store-baseline` measured it (the largest of three runs), with
// the workerd it ran on; RELEASING.md re-measures it before a release.
export const STORE_BASELINE = { bytes: 20_490_906, workerd: "1.20261113.1", date: "2026-11-17" };

// The caps (RES-6): `instanceBytes` leaves the baseline with 25% headroom, the largest peak of one request and the
// runtime's tables at their largest within the isolate's 128 MB (the hibernation manager's tag table at the sockets
// these charges admit; the event loop's registry of events in delivery, which never shrinks and outlives the manager,
// at the most sockets the runtime lists, which a previous release's may reach); `socketBytes` is the largest multiple
// of 1 MiB within a third of it, and takes any unit on a fresh socket. Tests set them (the seam, as STREAM_LIMITS is).
export const STREAM_OUTPUT = { socketBytes: 5 * 1024 * 1024, instanceBytes: 16 * 1024 * 1024 };

// A socket's charge: `charged` the sum of `frame` over the frames it was handed, `frames` their number.
export function socketCharge(charged: number, frames: number): number {
  return SOCKET_BYTES + charged + capacity(frames + 1);
}

// What handing a socket that holds `frames` frames more frames of `sizes` UTF-8 bytes adds to its charge.
export function outputNeed(frames: number, sizes: readonly number[]): number {
  return (
    sizes.reduce((sum, bytes) => sum + frame(bytes), 0) + capacity(frames + 1 + sizes.length) - capacity(frames + 1)
  );
}

// An attachment's `out`, [charged, frames], as a socket of this release writes it: two safe integers, neither
// negative, `charged` at most a socket's cap. Anything else is a charge nothing bounds.
export function validOut(out: unknown): out is [number, number] {
  return (
    Array.isArray(out) &&
    out.length === 2 &&
    out.every((n) => Number.isSafeInteger(n) && n >= 0) &&
    (out[0] as number) <= STREAM_OUTPUT.socketBytes
  );
}

// An upper bound on the bytes of `value`'s structured clone (V8's serializer): 16 bytes for each value besides a
// string's characters, and one byte a code unit for a string whose code units are all at most U+00FF, two otherwise.
export function cloneBound(value: unknown): number {
  if (typeof value === "string") {
    let latin1 = true;
    for (let i = 0; i < value.length && latin1; i++) {
      latin1 = value.charCodeAt(i) <= 0xff;
    }
    return 16 + (latin1 ? value.length : 2 * value.length);
  }
  if (Array.isArray(value)) {
    return value.reduce((sum: number, item: unknown) => sum + cloneBound(item), 16);
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).reduce((sum, [key, item]) => sum + cloneBound(key) + cloneBound(item), 16);
  }
  return 16;
}
