import { storeMaintenanceError } from "./store-errors";

// How far back a point-in-time restore may go (store-admin.ts refuses an older bookmark; Durable Object SQLite keeps
// 30 days).
export const PITR_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// The restore marker (media-files.ts restoreMarkerKey) as every reader takes it, in three states: null, no restore
// recorded (the R2 object is absent); a time, the restore the marker records ({ at } in epoch milliseconds, a
// non-negative safe integer, as the restore writes it); `unknown`, a read that failed or a marker without such a time.
export type Restore = number | null | "unknown";

// The marker as an operation takes it: `unread` until the operation reaches a point where K3's answer would change its
// reply or its committed state (restoreTime). Every outcome that each K3 outcome reaches alike is decided before that
// point, so an operation that never reaches one never reads the marker (withMarker).
export type Marker = Restore | "unread";

export async function readRestore(bucket: R2Bucket, key: string): Promise<Restore> {
  try {
    const marker = await bucket.get(key);
    if (marker === null) {
      return null;
    }
    const parsed = JSON.parse(await marker.text()) as unknown;
    const at = typeof parsed === "object" && parsed !== null ? (parsed as { at?: unknown }).at : undefined;
    return typeof at === "number" && Number.isSafeInteger(at) && at >= 0 ? at : "unknown";
  } catch {
    return "unknown";
  }
}

// Thrown by restoreTime for an `unread` marker: it leaves the operation's transaction, which writes nothing, for
// withMarker to run it again with the marker read.
const UNREAD = Symbol("restore marker unread");

function isUnread(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { [UNREAD]?: unknown })[UNREAD] === true;
}

// The time of the last restore, at the point where K3 decides an answer or a write. An `unread` marker leaves the
// operation to be run again with it (withMarker); an `unknown` one refuses the operation as transient (the Worker
// answers 503, the transaction writes nothing), so a restore whose time is lost is never taken for none.
export function restoreTime(marker: Marker): number | null {
  if (marker === "unread") {
    throw Object.assign(new Error("the restore marker is needed"), { [UNREAD]: true });
  }
  if (marker === "unknown") {
    throw storeMaintenanceError("transient");
  }
  return marker;
}

// Runs an operation in two passes: the first with the marker `unread`, which answers every call that never reaches
// restoreTime; one that reaches it leaves its transaction with nothing written, and runs again, in a transaction of its
// own that reads the record afresh, with the marker `read` (once).
export async function withMarker<T>(run: (marker: Marker) => Promise<T>, read: () => Promise<Restore>): Promise<T> {
  try {
    return await run("unread");
  } catch (error) {
    if (!isUnread(error)) {
      throw error;
    }
  }
  return run(await read());
}
