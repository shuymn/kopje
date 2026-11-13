import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { readCatalog, writeDump } from "../cli/lib/cutover/kopje-db.js";
import { valueLiteral } from "../cli/lib/cutover/kopje-runtime.js";
import { workspace } from "./cutover-helpers.js";

// The converter writes its dump with the Store's own catalog and literals (src/platform/dump-catalog.ts and
// dump-literals.ts) over node:sqlite, which returns TEXT read as BLOB and BLOB values as Uint8Array where SqlStorage
// returns an ArrayBuffer. A row whose literals are exact bytes must come out of the converter as the Store writes it.

type SqlValue = ArrayBuffer | string | number | null;

// The Store's table scan (src/platform/dump-scan.ts), loaded by a computed path: test-node's tsconfig lacks the
// Workers types it is checked with (the package's own tsc run checks it).
// oxlint-disable-next-line typescript/no-unnecessary-template-expression -- a literal path would be type-checked
const store = import(`../src/platform/${"dump-scan"}.ts`) as Promise<{
  scanTable: (
    sql: { exec: (query: string, ...bindings: SqlValue[]) => { raw: () => Iterable<SqlValue[]> } },
    spec: unknown,
    mode: "rows",
    after: null,
    visit: (row: { literals: string[] }) => boolean,
  ) => void;
}>;

// SqlStorage over a node database: its values as the Store reads them, each TEXT or BLOB as an ArrayBuffer of its
// bytes.
function sqlStorage(db: DatabaseSync) {
  return {
    exec: (query: string, ...bindings: SqlValue[]) => ({
      raw: () => {
        const statement = db.prepare(query);
        statement.setReturnArrays(true);
        const params = bindings.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v));
        return (statement.all(...params) as unknown as unknown[][]).map((row) =>
          row.map((v) => (v instanceof Uint8Array ? new Uint8Array(v).buffer : (v as SqlValue))),
        );
      },
    }),
  };
}

const TEXT_WITH_NUL = Buffer.from("nul\0inside 'q' ;\n");
const MALFORMED_TEXT = Buffer.from([0x68, 0x74, 0x74, 0x70, 0x73, 0x3a, 0xff]);
const BLOB = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x27, 0x0a]);
// The literals of the row, written out by hand (docs/dump-format.md); test/dump-import.test.ts checks that a Store
// dumps the first and the third so.
const EXPECTED = [
  "1",
  "CAST(X'6E756C00696E7369646520277127203B0A' AS TEXT)",
  "CAST(X'68747470733AFF' AS TEXT)",
  "X'000102FF270A'",
  "'plain ''text'''",
];

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, nul TEXT, malformed TEXT, data BLOB, plain TEXT)");
  db.prepare("INSERT INTO t (id, nul, malformed, data, plain) VALUES (1, CAST(? AS TEXT), CAST(? AS TEXT), ?, ?)").run(
    TEXT_WITH_NUL,
    MALFORMED_TEXT,
    BLOB,
    "plain 'text'",
  );
  return db;
}

describe("the converter's dump literals", () => {
  const space = workspace();

  it("are the Store's for a row of a BLOB, a malformed TEXT and a TEXT with NUL, and checksum the same", async () => {
    const db = database();
    const catalog = readCatalog(db);
    const path = join(space.dir, "t.dump");
    const trailer = writeDump(db, {
      path,
      catalog,
      migrations: [],
      createdAt: "2026-11-14T00:00:00.000Z",
      source: { build: "test", version: "test" },
    });
    const insert = (await readFile(path, "utf8")).split("\n").find((line) => line.startsWith('INSERT INTO "t"'));
    expect(insert).toBe(`INSERT INTO "t" ("id","nul","malformed","data","plain") VALUES (${EXPECTED.join(",")});`);

    const { scanTable } = await store;
    const rows: string[][] = [];
    scanTable(sqlStorage(db), catalog[0], "rows", null, ({ literals }) => rows.push(literals) > 0);
    expect(rows).toEqual([EXPECTED]);
    const checksum = createHash("sha256")
      .update(`${EXPECTED.join(",")}\n`)
      .digest("hex");
    expect(trailer.tables).toEqual([{ name: "t", rows: 1, checksum }]);
    db.close();
  });

  it("read a view at an offset in a larger buffer as its own bytes", () => {
    const backing = new Uint8Array([0xaa, 0xbb, ...BLOB, 0xcc]);
    const view = new Uint8Array(backing.buffer, 2, BLOB.length);
    expect(valueLiteral("blob", view)).toBe("X'000102FF270A'");
    const text = new Uint8Array([0xaa, ...TEXT_WITH_NUL, 0xcc]);
    expect(valueLiteral("text", new Uint8Array(text.buffer, 1, TEXT_WITH_NUL.length))).toBe(EXPECTED[1]);
    expect(valueLiteral("text", new Uint8Array(new Uint8Array([0, 0x61, 0x62]).buffer, 1, 2))).toBe("'ab'");
    expect(valueLiteral("blob", Uint8Array.from(BLOB).buffer)).toBe("X'000102FF270A'");
  });
});
