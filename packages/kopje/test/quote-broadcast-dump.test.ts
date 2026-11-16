import { describe, expect, it } from "vitest";

import type { StoreStub } from "../src/platform/store-client";
import { sql } from "./api-helpers";
import { migratedStore } from "./helpers";
import { accessAdminStore, copyConfig, dumpViaRpc, importViaRpc } from "./ops-helpers";

// A received quote's work flag in dumps (docs/dump-format.md "Stored bounds"): quotes.broadcast of
// 0100_quote_broadcast round-trips as it is, and an import is held to its CHECK (refused with the constraint's text).

const AUTHOR = "100000000000000001";
// The quoting statuses and the flag of each one's quote.
const QUOTES = [
  ["200000000000000001", 0],
  ["200000000000000002", 1],
  ["200000000000000003", 2],
] as const;

async function source() {
  const store = await accessAdminStore();
  await sql(
    store,
    "INSERT INTO accounts (id, uri, username, domain) VALUES (?, 'https://x.test/u/1', 'u', 'x.test')",
    AUTHOR,
  );
  for (const [id, flag] of QUOTES) {
    await sql(
      store,
      `INSERT INTO statuses (id, uri, account_id, visibility, published_at)
				VALUES (?1, 'https://x.test/s/' || ?1, ?2, 'public', '2026-11-01T00:00:00.000Z')`,
      id,
      AUTHOR,
    );
    await sql(
      store,
      `INSERT INTO quotes (status_id, quoted_uri, state, verify_after, hops, updated_at, broadcast)
				VALUES (?1, 'https://y.test/s/1', 'pending', 0, 2, '2026-11-01T00:00:00.000Z', ?2)`,
      id,
      flag,
    );
  }
  return store;
}

const rows = (store: StoreStub) =>
  sql(store, "SELECT status_id, broadcast, typeof(broadcast) AS type FROM quotes ORDER BY status_id");

describe("received quotes' work flags in dumps", () => {
  it("round-trip as they are", async () => {
    const store = await source();
    const { text } = await dumpViaRpc(store);
    const target = await migratedStore();
    await copyConfig(store, target);
    expect((await importViaRpc(target, text)).report).toMatchObject({ ok: true, problems: [] });
    expect(await rows(target)).toEqual(
      QUOTES.map(([id, flag]) => ({ status_id: id, broadcast: flag, type: "integer" })),
    );
  }, 60_000);

  it("are refused on import past the CHECK, with the constraint's text", async () => {
    const store = await source();
    const { text } = await dumpViaRpc(store);
    // broadcast is the table's last column (0100 adds it), so the quote flagged 2 ends its row with it.
    const line = text.split("\n").find((l) => l.startsWith('INSERT INTO "quotes"') && l.endsWith(",2);"));
    expect(line).toMatch(/"broadcast"\) VALUES/);
    const changed = text.replace(line!, line!.replace(/,2\);$/, ",3);"));
    expect(changed).not.toBe(text);
    const target = await migratedStore();
    await copyConfig(store, target);
    await expect(importViaRpc(target, changed)).rejects.toThrow(
      /CHECK constraint failed: typeof\(broadcast\) = 'integer' AND broadcast IN \(0, 1, 2\)/,
    );
    // The same dump unchanged imports: the refusal is the value's.
    const control = await migratedStore();
    await copyConfig(store, control);
    expect((await importViaRpc(control, text)).report).toMatchObject({ ok: true });
  }, 120_000);
});
