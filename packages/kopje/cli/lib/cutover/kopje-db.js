// A local SQLite database with the Kopje Store schema, its dump catalog, and a dump writer, for the cutover. The
// catalog and the literals are the Store's own (src/platform/dump-catalog.ts and dump-literals.ts, through
// kopje-runtime.js; docs/dump-format.md).

import { createHash } from "node:crypto";
import { closeSync, fsyncSync, openSync, readdirSync, readFileSync, writeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { END_LINE, HEADER_PREFIX, TRAILER_PREFIX } from "../format.js";
import {
  MAX_PROFILE_UPDATES,
  quoteIdentifier,
  readCatalog as storeCatalog,
  readColumn,
  valueLiteral,
} from "./kopje-runtime.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations/", import.meta.url));

/** @returns {{ name: string, sql: string }[]} */
function kopjeMigrations() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .toSorted()
    .map((f) => ({ name: f.slice(0, -".sql".length), sql: readFileSync(`${MIGRATIONS_DIR}${f}`, "utf8") }));
}

/** @param {string | Uint8Array} data */
export function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

/** @returns {{ name: string, checksum: string }[]} */
export function migrationRecords() {
  return kopjeMigrations().map((m) => ({ name: m.name, checksum: sha256Hex(m.sql) }));
}

/**
 * An empty database with the Store's schema and bookkeeping tables (as the Store kernel creates them).
 * @param {string} [path]
 */
export function createKopjeDatabase(path = ":memory:") {
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE IF NOT EXISTS kopje_migrations (name TEXT NOT NULL PRIMARY KEY, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL) WITHOUT ROWID;" +
      "CREATE TABLE IF NOT EXISTS kopje_state (name TEXT NOT NULL PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID",
  );
  for (const migration of kopjeMigrations()) {
    db.exec("BEGIN");
    db.exec(migration.sql);
    db.exec("COMMIT");
  }
  return db;
}

/** @typedef {ReturnType<typeof storeCatalog>[number]} TableSpec */

export { MAX_PROFILE_UPDATES };

/**
 * The dump catalog of a database, by the Store's readCatalog over a SqlStorage-shaped view of node:sqlite.
 * @param {DatabaseSync} db
 * @returns {TableSpec[]}
 */
export function readCatalog(db) {
  const sql = {
    /** @param {string} query @param {string[]} bindings */
    exec: (query, ...bindings) => ({ toArray: () => db.prepare(query).all(...bindings) }),
  };
  return storeCatalog(/** @type {Parameters<typeof storeCatalog>[0]} */ (/** @type {unknown} */ (sql)));
}

/**
 * Rows of a table in its dump order, as canonical literals of the selected columns.
 * @param {DatabaseSync} db
 * @param {TableSpec} spec
 * @param {string[]} selected
 * @param {string} [filter]
 * @returns {Generator<string[]>}
 */
function* scan(db, spec, selected, filter) {
  const where = [];
  if (spec.only !== undefined) {
    where.push(`${quoteIdentifier(spec.only.column)} IN (${spec.only.values.map((v) => `'${v}'`).join(",")})`);
  }
  if (filter !== undefined) {
    where.push(filter);
  }
  const order = spec.order.by === "rowid" ? "rowid" : spec.order.columns.map(quoteIdentifier).join(",");
  const statement = db.prepare(
    `SELECT ${selected.flatMap(readColumn).join(", ")} FROM ${quoteIdentifier(spec.name)}` +
      (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
      ` ORDER BY ${order}`,
  );
  statement.setReturnArrays(true);
  for (const row of statement.iterate()) {
    // readColumn reads each column as (storage class, TEXT for an integer, a number, or a Uint8Array of the bytes).
    const values = /** @type {(string | number | null | Uint8Array)[]} */ (/** @type {unknown} */ (row));
    /** @type {string[]} */
    const literals = [];
    for (let i = 0; i < values.length; i += 2) {
      literals.push(valueLiteral(/** @type {string} */ (values[i]), values[i + 1] ?? null));
    }
    yield literals;
  }
}

const encoder = new TextEncoder();

/**
 * Writes the database as a Kopje dump to `path` and returns the trailer.
 * @param {DatabaseSync} db
 * @param {{ path: string, catalog: TableSpec[], migrations: { name: string, checksum: string }[], createdAt: string,
 *   source: { build: string, version: string } }} options
 */
export function writeDump(db, { path, catalog, migrations, createdAt, source }) {
  // Created exclusively: an existing file or link at the path is never followed or reused.
  const fd = openSync(path, "wx", 0o600);
  try {
    const header = { format: 1, createdAt, source, migrations, tables: catalog };
    writeSync(fd, `${HEADER_PREFIX}${JSON.stringify(header)}\n`);
    const body = createHash("sha256");
    let statements = 0;
    let bytes = 0;
    /** @type {string[]} */
    let pending = [];
    let pendingBytes = 0;
    /** @param {string} line */
    const emit = (line) => {
      const buffer = encoder.encode(line);
      body.update(buffer);
      bytes += buffer.length;
      statements++;
      pending.push(line);
      pendingBytes += buffer.length;
      if (pendingBytes > 1 << 20) {
        writeSync(fd, pending.join(""));
        pending = [];
        pendingBytes = 0;
      }
    };
    /** @type {{ name: string, rows: number, checksum: string }[]} */
    const tables = [];
    for (const spec of catalog) {
      const prefix = `INSERT INTO ${quoteIdentifier(spec.name)} (${spec.columns.map(quoteIdentifier).join(",")}) VALUES (`;
      const deferred = spec.columns.map((c) => spec.deferred.includes(c));
      const checksum = createHash("sha256");
      let rows = 0;
      for (const literals of scan(db, spec, spec.columns)) {
        checksum.update(`${literals.join(",")}\n`);
        emit(`${prefix}${literals.map((l, i) => (deferred[i] ? "NULL" : l)).join(",")});\n`);
        rows++;
      }
      tables.push({ name: spec.name, rows, checksum: checksum.digest("hex") });
    }
    for (const spec of catalog) {
      if (spec.deferred.length === 0) {
        continue;
      }
      const filter = `(${spec.deferred.map((c) => `${quoteIdentifier(c)} IS NOT NULL`).join(" OR ")})`;
      for (const literals of scan(db, spec, [...spec.deferred, ...spec.key], filter)) {
        const set = spec.deferred.map((c, i) => `${quoteIdentifier(c)}=${literals[i]}`).join(",");
        const where = spec.key
          .map((c, i) => `${quoteIdentifier(c)}=${literals[spec.deferred.length + i]}`)
          .join(" AND ");
        emit(`UPDATE ${quoteIdentifier(spec.name)} SET ${set} WHERE ${where};\n`);
      }
    }
    writeSync(fd, pending.join(""));
    const trailer = { tables, body: { statements, bytes, sha256: body.digest("hex") } };
    writeSync(fd, `${TRAILER_PREFIX}${JSON.stringify(trailer)}\n${END_LINE}\n`);
    fsyncSync(fd);
    return trailer;
  } finally {
    closeSync(fd);
  }
}

/**
 * Executes a dump's statements against a database with the Kopje schema (a dump is a valid SQLite script for one).
 * Used to inspect a converted dump locally and, in tests, to change one and dump it again.
 * @param {DatabaseSync} db
 * @param {string} text
 */
export function loadDump(db, text) {
  const start = text.indexOf("\n") + 1;
  const end = text.lastIndexOf(`\n${TRAILER_PREFIX}`) + 1;
  const body = text.slice(start, end);
  // sqlite_sequence rows replace the counter of their name, as the Store's importer does.
  const sequence = /^INSERT INTO "sqlite_sequence" \("name","seq"\) VALUES \('([^']+)',(\d+)\);\n/gm;
  const counters = [...body.matchAll(sequence)];
  db.exec("BEGIN");
  try {
    db.exec(body.replace(sequence, ""));
    for (const [, name, seq] of counters) {
      db.prepare("DELETE FROM sqlite_sequence WHERE name = ?").run(name ?? "");
      db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)").run(name ?? "", BigInt(seq ?? "0"));
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
