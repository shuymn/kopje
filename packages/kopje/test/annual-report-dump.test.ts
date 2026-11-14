import { describe, expect, it } from "vitest";

import type { DumpTrailer } from "../src/platform/dump-format";
import { Sha256 } from "../src/platform/sha256";
import type { StoreStub } from "../src/platform/store-client";
import { seedAccount, sql } from "./api-helpers";
import { BUILD, migratedStore } from "./helpers";
import {
  ACCESS,
  accessAdminStore,
  beginImport,
  copyConfig,
  dumpViaRpc,
  importChunks,
  importViaRpc,
  resetImport,
  splitDump,
} from "./ops-helpers";

// Annual reports in dumps (docs/dump-format.md "Stored bounds"): a report round-trips with the account it names, an
// import is held to the CHECKs, foreign key and triggers of 0093_annual_reports (refused with their names), the
// conversions SQLite's column affinity makes are accepted as the stored type, and a reset leaves no report.

const CREATED = "2026-12-10T01:02:03.004Z";
const VIEWED = "2026-12-11T05:06:07.008Z";
const TOP = "300000000000000001";
const COLUMNS = [
  "account_id",
  "year",
  "archetype",
  "statuses",
  "followers",
  "top_status_id",
  "top_hashtag",
  "top_hashtag_uses",
  "viewed_at",
  "created_at",
] as const;
type Column = (typeof COLUMNS)[number];

async function source() {
  const store = await accessAdminStore();
  const alice = await seedAccount(store, { username: "alice", email: "alice@example.com" });
  await sql(
    store,
    `INSERT INTO annual_reports (account_id, year, archetype, statuses, followers, top_status_id, top_hashtag,
			top_hashtag_uses, viewed_at, created_at) VALUES (?, 2026, 'oracle', 120, 3, ?, 'kopje', 4, NULL, ?),
			(?, 2025, 'lurker', 0, 0, NULL, NULL, NULL, ?, ?)`,
    alice,
    TOP,
    CREATED,
    alice,
    VIEWED,
    CREATED,
  );
  await sql(store, "INSERT INTO instance_settings (name, value) VALUES ('wrapstodon', 'false')");
  return { store, alice };
}

const reports = (store: StoreStub) => sql(store, "SELECT * FROM annual_reports ORDER BY account_id, year");

// The dump with the 2026 report's literals replaced by `change` (each column's literal as the dump writes it), and its
// trailer recomputed for the new body, so a refusal can only come from the row.
function withReport(text: string, change: Partial<Record<Column, string>>): string {
  const line = /^INSERT INTO "annual_reports" \(([^)]*)\) VALUES \((.*),2026,(.*)\);$/m.exec(text);
  if (line === null) {
    throw new Error("no 2026 report in the dump");
  }
  const columns = line[1]!.split(",").map((name) => JSON.parse(name) as Column);
  expect(columns).toEqual([...COLUMNS]);
  const values = [line[2]!, "2026", ...splitLiterals(line[3]!)];
  const literals = columns.map((column, i) => change[column] ?? values[i]!);
  const edited = text.replace(line[0], `INSERT INTO "annual_reports" (${line[1]}) VALUES (${literals.join(",")});`);
  const { body, trailer } = splitDump(edited) as { body: string; trailer: DumpTrailer };
  const bytes = new TextEncoder().encode(body);
  const fixed = {
    ...trailer,
    body: { ...trailer.body, bytes: bytes.byteLength, sha256: new Sha256().update(bytes).hex() },
  };
  const at = edited.lastIndexOf("\n-- kopje-dump-trailer ") + 1;
  const end = edited.indexOf("\n", at);
  return `${edited.slice(0, at)}-- kopje-dump-trailer ${JSON.stringify(fixed)}${edited.slice(end)}`;
}

// The fixture's literals: quoted text without a comma, numbers and NULL.
function splitLiterals(text: string): string[] {
  return text.match(/'(?:[^']|'')*'|[^,]+/g) ?? [];
}

async function imported(source: StoreStub, text: string) {
  const target = await migratedStore();
  await copyConfig(source, target);
  return { target, result: importViaRpc(target, text) };
}

describe("annual reports in dumps", () => {
  it("round-trip with their account and the switch", async () => {
    const { store } = await source();
    const { text } = await dumpViaRpc(store);
    const { target, result } = await imported(store, text);
    expect((await result).report).toMatchObject({ ok: true, problems: [] });
    expect(await reports(target)).toEqual(await reports(store));
    expect(await reports(target)).toHaveLength(2);
    expect(await sql(target, "SELECT value FROM instance_settings WHERE name = 'wrapstodon'")).toEqual([
      { value: "false" },
    ]);
  }, 60_000);

  // Each converted literal stores the source's value, so the import's checksums still match the dump's.
  it("import the conversions affinity makes as the column's type", async () => {
    const { store } = await source();
    const { text } = await dumpViaRpc(store);
    const cases: [Partial<Record<Column, string>>, Column, SqlStorageValue, string][] = [
      [{ year: "'2026'" }, "year", 2026, "integer"],
      [{ year: "2026.0" }, "year", 2026, "integer"],
      [{ top_hashtag_uses: "4.0" }, "top_hashtag_uses", 4, "integer"],
      [{ top_status_id: TOP }, "top_status_id", TOP, "text"],
    ];
    for (const [change, column, value, type] of cases) {
      const { target, result } = await imported(store, withReport(text, change));
      expect((await result).report, JSON.stringify(change)).toMatchObject({ ok: true, problems: [] });
      expect(
        await sql(target, `SELECT ${column} AS value, typeof(${column}) AS type FROM annual_reports WHERE year = 2026`),
        JSON.stringify(change),
      ).toEqual([{ value, type }]);
    }
  }, 180_000);

  it("are refused on import past their bounds, with the constraint’s name", async () => {
    const { store } = await source();
    const { text } = await dumpViaRpc(store);
    const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    const text_ = (value: string) => `CAST(X'${hex(new TextEncoder().encode(value))}' AS TEXT)`;
    const cases: [Partial<Record<Column, string>>, RegExp][] = [
      [{ year: "0" }, /annual_report_year/],
      [{ year: "10000" }, /annual_report_year/],
      [{ year: "'2026x'" }, /annual_report_year/],
      [{ year: "2026.5" }, /annual_report_year/],
      [{ archetype: "'sage'" }, /annual_report_archetype/],
      [{ statuses: "-1" }, /annual_report_statuses/],
      [{ statuses: "2.5" }, /annual_report_statuses/],
      [{ followers: "'12x'" }, /annual_report_followers/],
      [{ top_status_id: "'30000000000000001'" }, /annual_report_top_status_id/],
      [{ top_status_id: "'30000000000000000１'" }, /annual_report_top_status_id/],
      [{ top_hashtag: text_("kop\u0000je") }, /annual_report_top_hashtag/],
      [{ top_hashtag: `'${"a".repeat(1025)}'` }, /annual_report_top_hashtag/],
      [{ top_hashtag: `'${"é".repeat(257)}'` }, /annual_report_top_hashtag/],
      [{ top_hashtag: "X'6B6F706A65'" }, /annual_report_top_hashtag/],
      [{ top_hashtag_uses: "1" }, /annual_report_top_hashtag_uses/],
      [{ top_hashtag_uses: "2.5" }, /annual_report_top_hashtag_uses/],
      [{ top_hashtag_uses: "'3x'" }, /annual_report_top_hashtag_uses/],
      [{ top_hashtag_uses: "NULL" }, /annual_report_top_hashtag_pair/],
      [{ viewed_at: `'${"x".repeat(24)}'` }, /annual_report_viewed_at/],
      [{ created_at: `'${"x".repeat(24)}'` }, /annual_report_created_at/],
      [{ created_at: "'2026-12-10T24:00:00.000Z'" }, /annual_report_created_at/],
      [{ created_at: "'2026-12-10T01:02:03.004é'" }, /annual_report_created_at/],
      [{ created_at: "'2026-12-10T01:02:03.00é'" }, /annual_report_created_at/],
      [{ created_at: text_("2026-12-10T01:02:03.004\u0000") }, /annual_report_created_at/],
      [{ created_at: `X'${hex(new TextEncoder().encode(CREATED))}'` }, /annual_report_created_at/],
      [{ created_at: "20261210" }, /annual_report_created_at/],
      [{ account_id: "'900000000000000009'" }, /chunk-failed: FOREIGN KEY constraint failed/],
    ];
    for (const [change, refused] of cases) {
      const changed = withReport(text, change);
      expect(changed, JSON.stringify(change)).not.toBe(text);
      const { result } = await imported(store, changed);
      await expect(result, JSON.stringify(change)).rejects.toThrow(refused);
    }
  }, 600_000);

  it("refuses a wrapstodon value other than true or false through the trigger", async () => {
    const { store } = await source();
    const { text } = await dumpViaRpc(store);
    const line = `INSERT INTO "instance_settings" ("name","value") VALUES ('wrapstodon','false');`;
    expect(text).toContain(line);
    const changed = withReport(text.replace(line, line.replace("'false'", "'maybe'")), {});
    const { result } = await imported(store, changed);
    await expect(result).rejects.toThrow(/instance_settings: a value past its stored bound/);
  }, 60_000);

  it("are deleted by a reset", async () => {
    const { store } = await source();
    const { text } = await dumpViaRpc(store);
    const target = await migratedStore();
    await copyConfig(store, target);
    const id = await beginImport(target, text);
    for (const [i, chunk] of (await importChunks(text, 1 << 20)).entries()) {
      expect(await target.importChunk(BUILD, ACCESS, id, i + 1, chunk)).toMatchObject({ ok: true });
    }
    expect(await reports(target)).toHaveLength(2);
    expect(await resetImport(target, id)).toMatchObject({ ok: true, done: true });
    expect(await reports(target)).toEqual([]);
    expect(await sql(target, "SELECT 1 FROM local_accounts")).toEqual([]);
  }, 60_000);
});
