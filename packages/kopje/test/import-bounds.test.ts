import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { SEQUENCE_TABLE } from "../src/platform/dump-catalog";
import { type DumpTrailer, trailerLines } from "../src/platform/dump-format";
import type { StoreStub } from "../src/platform/store-client";
import { autoincrementTables } from "../src/platform/store-import";
import { migratedStore, rejectionOf } from "./helpers";
import { copyConfig, dumpViaRpc, importViaRpc, seedStore, splitDump } from "./ops-helpers";

// The import's bound of what SQLite keeps (RES-6, docs/dump-format.md): a sqlite_sequence row names one of the
// schema's AUTOINCREMENT tables, refused with its chunk otherwise. Kopje's own export holds no other, an upgraded
// Store's neither (SQLite drops and renames a table's counter with it), so a fresh one round-trips; a dump past the
// bound is crafted or corrupted. The pending apps are not bounded on import: test/dump-import.test.ts restores a Store
// whose upgrade through 0086 left more than registration keeps.

const SEQUENCE_LINE = /^INSERT INTO "sqlite_sequence" .*$/m;

async function seeded(): Promise<StoreStub> {
  const store = await migratedStore();
  await seedStore(store, 3);
  return store;
}

// `text` with its trailer's body sealed again over its edited body, as a crafted dump would be: the import's own checks
// of the body pass, and only the row's refusal stands between it and the Store.
async function resealed(text: string): Promise<string> {
  const { body, trailer } = splitDump(text) as { body: string; trailer: DumpTrailer };
  const bytes = new TextEncoder().encode(body);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const sha256 = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  const sealed = { ...trailer, body: { ...trailer.body, bytes: bytes.length, sha256 } };
  return text.slice(0, text.lastIndexOf("\n-- kopje-dump-trailer ") + 1) + trailerLines(sealed);
}

async function restore(source: StoreStub, text: string) {
  const target = await migratedStore();
  await copyConfig(source, target);
  return importViaRpc(target, text);
}

describe("the schema's AUTOINCREMENT tables", () => {
  it("are read from the live schema, and hold every counter a seeded Store keeps", async () => {
    const store = await seeded();
    const { tables, counters } = await runInDurableObject(store, (_instance, state) => ({
      tables: [...autoincrementTables(state.storage.sql)].toSorted(),
      counters: state.storage.sql
        .exec<{ name: string }>(`SELECT name FROM ${SEQUENCE_TABLE} ORDER BY name`)
        .toArray()
        .map((row) => row.name),
    }));
    expect(tables).toEqual(expect.arrayContaining(["conversations", "deliveries", "follows", "push_deliveries"]));
    expect(tables).not.toContain("statuses");
    // Its CREATE TABLE names AUTOINCREMENT in a comment only (migrations/0026_streaming.sql).
    expect(tables).not.toContain("stream_events");
    expect(counters.length).toBeGreaterThan(0);
    expect(tables).toEqual(expect.arrayContaining(counters));
  });

  // What an upgrade does to a counter: a table renamed takes its counter's name, and a table dropped takes its counter.
  it("keep their counters through a rename and a drop, as an upgrade's rebuild does", async () => {
    const store = await migratedStore();
    const counters = await runInDurableObject(store, (_instance, state) => {
      const sql = state.storage.sql;
      const names = () =>
        sql
          .exec<{ name: string }>(`SELECT name FROM ${SEQUENCE_TABLE} WHERE name GLOB 'rebuilt*' ORDER BY name`)
          .toArray()
          .map((row) => row.name);
      sql.exec("CREATE TABLE rebuilt_old (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)");
      sql.exec("INSERT INTO rebuilt_old (v) VALUES ('a')");
      const created = names();
      sql.exec("ALTER TABLE rebuilt_old RENAME TO rebuilt_new");
      const renamed = names();
      sql.exec("DROP TABLE rebuilt_new");
      return { created, renamed, dropped: names() };
    });
    expect(counters).toEqual({ created: ["rebuilt_old"], renamed: ["rebuilt_new"], dropped: [] });
  });
});

describe("a dump's sqlite_sequence (RES-6)", () => {
  it("round-trips a fresh export, its counters each of an AUTOINCREMENT table", async () => {
    const source = await seeded();
    const { text } = await dumpViaRpc(source, 8 * 1024);
    expect(text).toMatch(SEQUENCE_LINE);
    expect((await restore(source, text)).report).toMatchObject({ ok: true, problems: [] });
  });

  it("refuses with its chunk a counter of a table the Store does not declare AUTOINCREMENT", async () => {
    const source = await seeded();
    const { text } = await dumpViaRpc(source, 8 * 1024);
    const line = text.match(SEQUENCE_LINE)![0];
    const crafted = await resealed(text.replace(line, line.replace(/\('[^']*'/, "('statuses'")));
    expect(crafted).not.toBe(text);
    expect(String(await rejectionOf(restore(source, crafted)))).toMatch(
      /sequence-not-allowed|names no AUTOINCREMENT table/,
    );
  });
});
