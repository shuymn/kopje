import { type ColumnMap, selectSql } from "../db/columns";
import type { Db } from "../db/sql";

// The domain setting as a read returns it. A status presenter reads it (the tagged collections' decision,
// collection-presenter.ts taggable), so it is one of status-rows.ts's hydrate queries, which R charges.
export const INSTANCE_DOMAIN_COLUMNS = { value: "s.value" } as const satisfies ColumnMap;
export const INSTANCE_DOMAIN_FROM = "instance_settings s WHERE s.name = 'domain'";

// The domain /setup fixed, or null before setup. A module of its own, so a module actors.ts reaches (the collection
// documents and presenter) reads it without a cycle.
export function instanceDomainOf(db: Db): string | null {
  return (
    db.first<{ value: string }>(`SELECT ${selectSql(INSTANCE_DOMAIN_COLUMNS)} FROM ${INSTANCE_DOMAIN_FROM}`)?.value ??
    null
  );
}

// The instance's origin on that domain, the one host the routes answer on (platform/instance-host.ts offDomain), or null
// before /setup: what the Store presents with where no request gives one (pushes, streamed messages, announcements),
// where a link or a tag names a local collection, and where no remote collection's id is (#1589's D2, D3).
export function instanceOrigin(db: Db): string | null {
  const domain = instanceDomainOf(db);
  return domain === null ? null : `https://${domain}`;
}
