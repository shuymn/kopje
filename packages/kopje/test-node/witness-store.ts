import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { createKopjeDatabase } from "../cli/lib/cutover/kopje-db.js";

// The worlds and flows of test/main-runtime/witness-world.ts on Node's SQLite, for the suites that run them here
// (witness-recording.test.ts, shown-walk-work.test.ts).

export type World = { blocks: string; shape: string };
export type Transact = <T>(fn: () => T) => T;
type Run = (sql: unknown, transact: Transact, context: unknown) => unknown;
export type WitnessWorld = {
  buildWorld: (sql: unknown, world: World) => unknown;
  FLOWS: Record<string, { run: Run }>;
  WORLDS: World[];
  worldName: (world: World) => string;
};

// witness-world.ts under `root` (a package directory), loaded by a computed specifier: it is typed against the Workers
// runtime, which this suite's TypeScript project does not include.
export async function witnessWorld(root: URL): Promise<WitnessWorld> {
  return (await import(new URL("test/main-runtime/witness-world.ts", root).href)) as WitnessWorld;
}

// An empty Store, its expression depth limit at 1,000 so that main's statements prepare on SQLite 3.54.1.
export function witnessDatabase(): DatabaseSync {
  const db = createKopjeDatabase();
  db.limits.exprDepth = 1_000;
  return db;
}

// The SqlStorage surface the Store's code reads (Db in src/db/sql.ts), over node:sqlite: each statement's rows from
// `rows` (by default, the statement run as given).
export function nodeStorage(
  db: DatabaseSync,
  rows: (query: string, params: SQLInputValue[]) => unknown[] = (query, params) => db.prepare(query).all(...params),
) {
  const changes = db.prepare("SELECT total_changes() AS n");
  return {
    exec(query: string, ...params: SQLInputValue[]) {
      const before = changes.get()!.n as number;
      const read = rows(query, params);
      const rowsWritten = (changes.get()!.n as number) - before;
      return {
        rowsRead: 0,
        rowsWritten,
        toArray: () => read,
        one: () => read[0],
        [Symbol.iterator]: () => read[Symbol.iterator](),
      };
    },
  };
}

// storage.transactionSync over `db`: a savepoint, released on return and rolled back on a throw.
export function transaction(db: DatabaseSync): Transact {
  let savepoints = 0;
  return (fn) => {
    const name = `s${++savepoints}`;
    db.exec(`SAVEPOINT ${name}`);
    try {
      const result = fn();
      db.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      db.exec(`ROLLBACK TO ${name}`);
      db.exec(`RELEASE ${name}`);
      throw error;
    }
  };
}

// Runs `fn` in a savepoint rolled back after it, so that each flow starts from its world as built.
export function rolledBack(db: DatabaseSync, fn: () => void): void {
  db.exec("SAVEPOINT flow");
  try {
    fn();
  } finally {
    db.exec("ROLLBACK TO flow");
    db.exec("RELEASE flow");
  }
}
