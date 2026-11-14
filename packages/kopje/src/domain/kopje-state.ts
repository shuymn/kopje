import type { Db } from "../db/sql";

// Reads and writes of one kopje_state value by name: the Store's own names, outside the dumped tables.

export function state(db: Db, name: string): string | undefined {
  return db.first<{ value: string }>("SELECT value FROM kopje_state WHERE name = ?", name)?.value;
}

export function setState(db: Db, name: string, value: string): void {
  db.run("INSERT OR REPLACE INTO kopje_state (name, value) VALUES (?, ?)", name, value);
}

// A value written by writeState, or null when the name is absent.
export function readState<T>(db: Db, name: string): T | null {
  const value = state(db, name);
  return value === undefined ? null : (JSON.parse(value) as T);
}

export function writeState(db: Db, name: string, value: unknown): void {
  setState(db, name, JSON.stringify(value));
}
