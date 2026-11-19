import type { Db } from "../db/sql";

// The domain /setup fixed, or null before setup. A module of its own, so a module actors.ts reaches (the collection
// documents and presenter) reads it without a cycle.
export function instanceDomainOf(db: Db): string | null {
  return db.first<{ value: string }>("SELECT value FROM instance_settings WHERE name = 'domain'")?.value ?? null;
}

// The instance's origin on that domain, the one host the routes answer on (platform/instance-host.ts offDomain), or null
// before /setup: what the Store presents with where no request gives one (pushes, streamed messages, announcements),
// where a link or a tag names a local collection, and where no remote collection's id is (#1589's D2, D3).
export function instanceOrigin(db: Db): string | null {
  const domain = instanceDomainOf(db);
  return domain === null ? null : `https://${domain}`;
}
