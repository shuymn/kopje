import { storeMaintenanceError } from "./store-errors";

// The restore marker (media-files.ts restoreMarkerKey) as every reader takes it, in three states: null, no restore
// recorded (the R2 object is absent); a time, the restore the marker records ({ at } in epoch milliseconds, a
// non-negative safe integer, as the restore writes it); `unknown`, a read that failed or a marker without such a time.
// The Store reads it once per call (readRestore) and hands it to the operation, which asks for the time only where K3's
// fence decides its answer or its write (restoreTime): an `unknown` marker refuses that operation and no other.
export type Restore = number | null | "unknown";

export function parseRestore(text: string): Exclude<Restore, null> {
  try {
    const parsed = JSON.parse(text) as unknown;
    const at = typeof parsed === "object" && parsed !== null ? (parsed as { at?: unknown }).at : undefined;
    return typeof at === "number" && Number.isSafeInteger(at) && at >= 0 ? at : "unknown";
  } catch {
    return "unknown";
  }
}

export async function readRestore(bucket: R2Bucket, key: string): Promise<Restore> {
  try {
    const marker = await bucket.get(key);
    return marker === null ? null : parseRestore(await marker.text());
  } catch {
    return "unknown";
  }
}

// The time of the last restore, for an answer or a write K3 decides. An `unknown` marker refuses the operation as
// transient (the Worker answers 503, the transaction writes nothing), so a restore whose time is lost is never taken
// for none.
export function restoreTime(restore: Restore): number | null {
  if (restore === "unknown") {
    throw storeMaintenanceError("transient");
  }
  return restore;
}
