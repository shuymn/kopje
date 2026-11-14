import { Db } from "../db/sql";
import type { OperationKind, StoreClock, StoreOperation, TimedOperation } from "../platform/store-kernel";

// Declares a domain operation. The Store runs it as one RPC inside one transactionSync, so "read, decide, write"
// is atomic. Operations are synchronous and do no external I/O; time arrives in the input, and local IDs are minted in
// the Store, inside the operation that uses them (allocateLocalId in ids.ts). The kernel also passes
// a nested transactionSync, so a step can run in a savepoint of that transaction (Db.savepoint).
// `.atStoreTime(field)` declares one that takes the Store's own time in `field` (TimedOperation): the kernel fills it,
// and a caller through the Store passes the rest.
function declare(kind: OperationKind) {
  const operation = <I, O>(run: (db: Db, input: I) => O): StoreOperation<I, O> => ({
    kind,
    run: (sql, input, savepoint) => run(new Db(sql, savepoint), input),
  });
  const atStoreTime =
    <C extends StoreClock>(clock: C) =>
    <I extends Record<C, number>, O>(run: (db: Db, input: I) => O): TimedOperation<I, O, C> => ({
      ...operation(run),
      clock,
    });
  return Object.assign(operation, { atStoreTime });
}

export const readOperation = declare("read");

// A login or Web Push registration write: still served while the Store is readonly.
export const sessionOperation = declare("session");

export const writeOperation = declare("write");

// A write that dooms or deletes media, or picks R2 objects to delete: refused like any write, and also while the media
// rebuild holds its lease (platform/store-flags.ts).
export const mediaDeleteOperation = declare("media-delete");

// The media rebuild's writes only (domain/media-rebuild.ts); the gate admits them in readonly maintenance and while an
// import is unpublished (platform/store-flags.ts). Nothing else may be declared with it.
export const mediaRebuildOperation = declare("media-rebuild");
