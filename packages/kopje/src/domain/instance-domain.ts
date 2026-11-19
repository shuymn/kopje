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

// The domain /setup fixed, as configuredDomain read it in the Store (null before setup), which decides where a
// collection is (#1589's D3) and serves a whole resolution from one read. An instance of a class this module does not
// export, with no public member: its name is in an ECMAScript private field, which only the class's static block reads
// and writes, through `named` and `nameOf`, two functions of this module. So no other module makes one that has a
// name: a literal, a spread or a cast object has no such field (no ConfiguredDomain to the type checker, and
// onConfiguredDomain throws a TypeError on reading it), and the constructor, reachable from a real one, makes one with
// none, which is on no domain.
let named: (name: string | null) => Configured;
let nameOf: (domain: Configured) => string | null;

class Configured {
  #name: string | null = null;

  static {
    named = (name) => {
      const domain = new Configured();
      domain.#name = name;
      return domain;
    };
    nameOf = (domain) => domain.#name;
  }
}

export type ConfiguredDomain = Configured;

export function configuredDomain(db: Db): ConfiguredDomain {
  return named(instanceDomainOf(db));
}

// Whether `url` is on the configured `domain` (onDomain, the routes' own test: its host, whatever its scheme).
export function onConfiguredDomain(url: URL, domain: ConfiguredDomain): boolean {
  const name = nameOf(domain);
  return name !== null && onDomain(url, name);
}

// The instance's origin on that domain, or null before /setup: what the Store presents with where no request gives
// one (pushes, streamed messages, announcements).
export function instanceOrigin(db: Db): string | null {
  const domain = instanceDomainOf(db);
  return domain === null ? null : `https://${domain}`;
}
