// What a dump contains, read from the live schema so a new migration needs no change here.
//
// No relative imports and no Workers types: the cutover's dump writer runs this module from the sources on Node
// (cli/lib/cutover/kopje-runtime.js) over node:sqlite.
//
// Excluded, never restored blindly:
//   kopje_migrations      the header carries the applied migrations; the target recreates them with its runner
//   kopje_state           except the names in DUMPED_STATE. hold, upgrade, upgrade_bookmark (the bookmark belongs to
//                         the source object), maintenance, dump and import are state of one object at one time
//   media_orphans         tombstones of R2 objects to delete; a restored Store must not delete what it restores
//   backup_media          the backup's media index for one bucket; a restored Store starts a fresh media baseline
//   stream_*              the streaming API's registry, journal and position: state of the sockets of one object
//   _cf_*                 platform internals
//   sqlite_* internals    except sqlite_sequence (AUTOINCREMENT counters), which is restored by name
export const STATE_TABLE = "kopje_state";
export const DUMPED_STATE = ["last_local_id", "profile_updates"] as const;
export const SEQUENCE_TABLE = "sqlite_sequence";

// The local accounts whose avatar or header a cutover conversion changed (`convert --images`): a JSON array of account
// ids, which publication announces with an Update each and then deletes (domain/actor-update.ts). Only a converted dump
// holds it, so a Store dumped after publication never does. Publication records them all in one transaction, so the
// list holds distinct ids and at most MAX_PROFILE_UPDATES of them, far above the local accounts of the single-user or
// small instance Kopje is for (the converter stops above it: cli/lib/cutover/convert.js).
export const PROFILE_UPDATES = "profile_updates";
export const MAX_PROFILE_UPDATES = 100;

// The account ids of a PROFILE_UPDATES value, or null when it is not a JSON array of at most MAX_PROFILE_UPDATES
// distinct non-empty strings.
export function parseProfileUpdates(value: unknown): string[] | null {
  if (typeof value !== "string") {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  return Array.isArray(parsed) &&
    parsed.length <= MAX_PROFILE_UPDATES &&
    new Set(parsed).size === parsed.length &&
    parsed.every((id) => typeof id === "string" && id !== "")
    ? (parsed as string[])
    : null;
}

function excluded(name: string): boolean {
  return (
    name === "kopje_migrations" ||
    name === "media_orphans" ||
    name === "card_images" ||
    name === "remote_media" ||
    name === "remote_media_objects" ||
    name === "remote_media_usage" ||
    name === "backup_media" ||
    name.startsWith("stream_") ||
    name.startsWith("_cf_") ||
    (name.startsWith("sqlite_") && name !== SEQUENCE_TABLE)
  );
}

// Ordering of a table's rows, which the per-table checksum depends on.
//   rowid  : ascending rowid (for INTEGER PRIMARY KEY tables that is the key; otherwise insertion order)
//   key    : ascending by the listed columns (BINARY collation), for WITHOUT ROWID tables and sqlite_sequence
type TableOrder = { by: "rowid" } | { by: "key"; columns: string[] };

// One table of the catalog, as the dump header carries it (dump-format.ts).
export type TableSpec = {
  name: string;
  columns: string[];
  order: TableOrder;
  // Primary key columns (used by link statements).
  key: string[];
  // FK columns referencing the same table (or a table later in the order). INSERTs write NULL there and a link
  // statement sets the value after all rows are in.
  deferred: string[];
  // Only these rows are part of the dump (kopje_state keeps only allowlisted names).
  only?: { column: string; values: string[] };
};

type ForeignKey = { parent: string; columns: string[] };

export class CatalogError extends Error {}

// The part of SqlStorage the catalog reads.
type CatalogSql = {
  exec<T extends Record<string, ArrayBuffer | string | number | null>>(
    query: string,
    ...bindings: string[]
  ): { toArray(): T[] };
};

export function readCatalog(sql: CatalogSql): TableSpec[] {
  const tables = sql
    .exec<{ name: string; sql: string | null }>(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name COLLATE BINARY",
    )
    .toArray()
    .filter((t) => !excluded(t.name));

  const specs = new Map<string, TableSpec>();
  const foreignKeys = new Map<string, ForeignKey[]>();
  for (const table of tables) {
    const info = sql
      .exec<{ name: string; pk: number; hidden: number }>(
        "SELECT name, pk, hidden FROM pragma_table_xinfo(?) ORDER BY cid",
        table.name,
      )
      .toArray()
      .filter((c) => c.hidden === 0);
    const columns = info.map((c) => c.name);
    const key = info
      .filter((c) => c.pk > 0)
      .toSorted((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    const withoutRowid = /\)\s*WITHOUT\s+ROWID\s*$/i.test(table.sql ?? "");
    const spec: TableSpec = {
      name: table.name,
      columns,
      order:
        table.name === SEQUENCE_TABLE
          ? { by: "key", columns: ["name"] }
          : withoutRowid
            ? { by: "key", columns: key }
            : { by: "rowid" },
      key: table.name === SEQUENCE_TABLE ? ["name"] : key,
      deferred: [],
    };
    if (table.name === STATE_TABLE) {
      spec.only = { column: "name", values: [...DUMPED_STATE] };
    }
    specs.set(table.name, spec);

    const byId = new Map<number, ForeignKey>();
    for (const fk of sql
      .exec<{
        id: number;
        table: string;
        from: string;
      }>('SELECT id, "table", "from" FROM pragma_foreign_key_list(?) ORDER BY id, seq', table.name)
      .toArray()) {
      const entry = byId.get(fk.id) ?? { parent: fk.table, columns: [] };
      entry.columns.push(fk.from);
      byId.set(fk.id, entry);
    }
    foreignKeys.set(table.name, [...byId.values()]);
  }

  // Parents before children (names break ties). A reference to the same table or, in a cycle, to a table not yet
  // placed is deferred: rows are inserted with NULL there and linked after all rows are in.
  const ordered: TableSpec[] = [];
  const placed = new Set<string>();
  const remaining = [...specs.keys()].filter((name) => name !== SEQUENCE_TABLE);
  while (remaining.length > 0) {
    const ready = remaining.findIndex((name) =>
      (foreignKeys.get(name) ?? []).every((fk) => fk.parent === name || placed.has(fk.parent) || !specs.has(fk.parent)),
    );
    const index = ready === -1 ? 0 : ready;
    const name = remaining.splice(index, 1)[0] ?? "";
    const spec = specs.get(name);
    if (spec === undefined) {
      continue;
    }
    const deferred = new Set<string>();
    for (const fk of foreignKeys.get(name) ?? []) {
      if (fk.parent === name || (specs.has(fk.parent) && !placed.has(fk.parent))) {
        fk.columns.forEach((column) => deferred.add(column));
      }
    }
    spec.deferred = spec.columns.filter((column) => deferred.has(column));
    if (spec.deferred.length > 0 && spec.key.length === 0) {
      throw new CatalogError(`${name} has deferred references but no primary key`);
    }
    placed.add(name);
    ordered.push(spec);
  }
  const sequence = specs.get(SEQUENCE_TABLE);
  if (sequence !== undefined) {
    ordered.push(sequence);
  }
  return ordered;
}
