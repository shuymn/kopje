import type { Db } from "../db/sql";

// The domain /setup fixed, or null before setup. A module of its own, so a module actors.ts reaches (the collection
// documents) reads it without a cycle.
export function instanceDomainOf(db: Db): string | null {
  return db.first<{ value: string }>("SELECT value FROM instance_settings WHERE name = 'domain'")?.value ?? null;
}
