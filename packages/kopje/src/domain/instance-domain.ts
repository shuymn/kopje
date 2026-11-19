import { type ColumnMap, selectSql } from "../db/columns";
import type { Db } from "../db/sql";
import { onDomain } from "../platform/instance-host";

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

declare const CONFIGURED: unique symbol;

// The domain /setup fixed (`name`, null before setup), as configuredDomain read it in the Store: a value only this
// module makes, so where a collection is decided (#1589's D3) a request's host cannot stand in for it, and one read
// serves a whole resolution.
export type ConfiguredDomain = { readonly name: string | null; readonly [CONFIGURED]: true };

export function configuredDomain(db: Db): ConfiguredDomain {
  return { name: instanceDomainOf(db) } as ConfiguredDomain;
}

// Whether `url` is on the configured `domain` (onDomain, the routes' own test: its host, whatever its scheme).
export function onConfiguredDomain(url: URL, domain: ConfiguredDomain): boolean {
  return domain.name !== null && onDomain(url, domain.name);
}

// The instance's origin on that domain, or null before /setup: what the Store presents with where no request gives
// one (pushes, streamed messages, announcements).
export function instanceOrigin(db: Db): string | null {
  const domain = instanceDomainOf(db);
  return domain === null ? null : `https://${domain}`;
}
