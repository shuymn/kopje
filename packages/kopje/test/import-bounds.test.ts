import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { SEQUENCE_TABLE } from "../src/platform/dump-catalog";
import { type DumpTrailer, trailerLines } from "../src/platform/dump-format";
import { MAX_PENDING_APPS } from "../src/platform/pending-apps";
import type { StoreStub } from "../src/platform/store-client";
import { autoincrementTables } from "../src/platform/store-import";
import { migratedStore, rejectionOf } from "./helpers";
import { copyConfig, dumpViaRpc, importViaRpc, seedStore, splitDump } from "./ops-helpers";

// The import's bounds of what registration and SQLite keep (RES-6, docs/dump-format.md): a sqlite_sequence row names
// one of the schema's AUTOINCREMENT tables, refused with its chunk otherwise; the pending apps of a verified import
// number at most MAX_PENDING_APPS, by registration's own predicate, refused at verification otherwise. Kopje's own
// export holds neither, so a fresh one round-trips; a dump past either bound is crafted or corrupted.

const SEQUENCE_LINE = /^INSERT INTO "sqlite_sequence" .*$/m;

// A seeded Store with `pending` apps no user has authorized (and one that one has, never counted).
async function withApps(pending: number): Promise<StoreStub> {
  const store = await migratedStore();
  await seedStore(store, 3);
  await runInDurableObject(store, (_instance, state) => {
    state.storage.sql.exec(
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
			INSERT INTO oauth_clients (id, secret, name, redirect_uris, authorized)
			SELECT 'pending-' || i, 's', 'p', 'urn:x', 0 FROM n WHERE ?1 > 0`,
      pending,
    );
    state.storage.sql.exec(
      "INSERT INTO oauth_clients (id, secret, name, redirect_uris, authorized) VALUES ('authorized', 's', 'a', 'urn:x', 1)",
    );
  });
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
  return { target, run: importViaRpc(target, text) };
}

describe("the schema's AUTOINCREMENT tables", () => {
  it("are read from the live schema, and hold every counter a seeded Store keeps", async () => {
    const store = await withApps(0);
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
});

describe("a dump's sqlite_sequence (RES-6)", () => {
  it("round-trips a fresh export, its counters each of an AUTOINCREMENT table", async () => {
    const source = await withApps(1);
    const { text } = await dumpViaRpc(source, 8 * 1024);
    expect(text).toMatch(SEQUENCE_LINE);
    const { run } = await restore(source, text);
    expect((await run).report).toMatchObject({ ok: true, problems: [] });
  });

  it("refuses with its chunk a counter of a table the Store does not declare AUTOINCREMENT", async () => {
    const source = await withApps(1);
    const { text } = await dumpViaRpc(source, 8 * 1024);
    const line = text.match(SEQUENCE_LINE)![0];
    const crafted = await resealed(text.replace(line, line.replace(/\('[^']*'/, "('statuses'")));
    expect(crafted).not.toBe(text);
    const { run } = await restore(source, crafted);
    expect(String(await rejectionOf(run))).toMatch(/sequence-not-allowed|names no AUTOINCREMENT table/);
  });
});

describe("a dump's pending apps (RES-6)", () => {
  it(`accepts ${MAX_PENDING_APPS} pending apps, as registration keeps at most`, async () => {
    const source = await withApps(MAX_PENDING_APPS);
    const { text } = await dumpViaRpc(source, 64 * 1024);
    const { target, run } = await restore(source, text);
    expect((await run).report).toMatchObject({ ok: true, problems: [] });
    const pending = await runInDurableObject(
      target,
      (_instance, state) =>
        state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM oauth_clients WHERE authorized = 0").one().n,
    );
    expect(pending).toBe(MAX_PENDING_APPS);
  });

  it(`refuses at verification one more than ${MAX_PENDING_APPS}`, async () => {
    const source = await withApps(MAX_PENDING_APPS + 1);
    const { text } = await dumpViaRpc(source, 64 * 1024);
    const { run } = await restore(source, text);
    expect((await run).report).toMatchObject({
      ok: false,
      problems: [expect.stringContaining("more than MAX_PENDING_APPS")],
    });
  });
});
