import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { readCatalog } from "../src/platform/dump-catalog";
import type { DumpTrailer } from "../src/platform/dump-format";
import { StoreAdmin } from "../src/platform/store-admin";
import type { StoreStub } from "../src/platform/store-client";
import { readFlags } from "../src/platform/store-flags";
import { correctQuoteCounts, QUOTE_COUNTS_DONE } from "../src/platform/store-import";
import { BUILD, migratedStore, testKernel } from "./helpers";
import {
  ACCESS,
  beginImport,
  copyConfig,
  dumpViaRpc,
  importChunks,
  importViaRpc,
  seedStore,
  splitDump,
  tableSnapshot,
} from "./ops-helpers";

// The import inserts every dumped row, so each trigger that writes on an INSERT runs during it, and so does each
// trigger that writes on an UPDATE of a column the importer itself updates: the deferred columns its links set, and
// statuses.quotes_count, which correctQuoteCounts sets. Each such trigger of the migrated schema is listed here with
// why an import leaves the dumped rows as the dump holds them; `fires` says whether an honest dump makes its WHEN true
// (the round trip below shows it does), or why it never does.
const WRITING_TRIGGERS: Record<string, { reason: string; fires: true } | { reason: string; fires: false }> = {
  quotes_count_inserted: {
    reason:
      "adds 1 to the quoted status's quotes_count, which its statuses row already holds (statuses precede quotes); correctQuoteCounts takes it off again before the checksums",
    fires: true,
  },
  quotes_withdrawn_inserted: {
    reason:
      "writes the quote's withdrawn only where it differs from the rule over its status (0091), which every Store keeps for each quote; its status precedes it, so an honest dump's value equals the rule and nothing is written",
    fires: true,
  },
  reject_replays_follow_stored: {
    reason:
      "deletes the held Reject of the pair a follow names when the follow's target is a local account; follows precede local_accounts and reject_replays in the catalog, so when a follow goes in its WHEN finds no local account and no hold is stored yet",
    fires: false,
  },
  statuses_last_status_stored: {
    reason:
      "raises accounts.last_status_id to a newer public, unlisted or private status; the dumped value is already the account's newest such status (0021's triggers keep it whatever writes statuses) and accounts precede statuses, so it matches no row",
    fires: true,
  },
  statuses_thread: {
    reason:
      "sets the status's own thread when it is NULL; every stored status has one (0009 backfilled them, the trigger sets it on every insert, and uri is NOT NULL), so its WHEN is false for each dumped row",
    fires: false,
  },
  stream_notification_inserted: {
    reason: "inserts into stream_events, which no dump holds or checksums (dump-catalog.ts excluded)",
    fires: true,
  },
  stream_status_inserted: {
    reason: "inserts into stream_events, which no dump holds or checksums (dump-catalog.ts excluded)",
    fires: true,
  },
};

// Columns the importer updates after inserting the rows: the links (deferred columns) and the quote counts.
const IMPORTER_UPDATES: Record<string, string[]> = { statuses: ["quotes_count"] };

type Trigger = { name: string; table: string; event: string; columns: string[] | null; when: string | null };

function readTriggers(sql: SqlStorage): Trigger[] {
  return sql
    .exec<{ name: string; tbl_name: string; sql: string }>(
      "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
    )
    .toArray()
    .map((row) => {
      const text = row.sql.replace(/--[^\n]*/g, "");
      const head = /\b(?:BEFORE|AFTER|INSTEAD\s+OF)\s+(INSERT|DELETE|UPDATE)(?:\s+OF\s+([\w\s,]+?))?\s+ON\s+\w+/i.exec(
        text,
      );
      const when = /\bON\s+\w+\s+(?:FOR\s+EACH\s+ROW\s+)?WHEN\s+([\s\S]*?)\s+BEGIN\b/i.exec(text);
      return {
        name: row.name,
        table: row.tbl_name,
        event: (head?.[1] ?? "?").toUpperCase(),
        columns: head?.[2] === undefined ? null : head[2].split(",").map((c) => c.trim()),
        when: when?.[1] ?? null,
        writes: text,
      };
    })
    .filter((t) => writes(t.writes))
    .map(({ writes: _sql, ...t }) => t);
}

// Whether a trigger body writes a row: an INSERT, UPDATE, DELETE or REPLACE after BEGIN, a RAISE aside.
function writes(sql: string): boolean {
  const body = sql.slice(sql.search(/\bBEGIN\b/i)).replace(/\bRAISE\s*\([^)]*\)/gi, "");
  return /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(body);
}

// The writing triggers an import runs: on INSERT, or on an UPDATE that may name a column the importer updates.
function importTriggers(sql: SqlStorage): Trigger[] {
  const updated = new Map<string, Set<string>>();
  for (const spec of readCatalog(sql)) {
    updated.set(spec.name, new Set([...spec.deferred, ...(IMPORTER_UPDATES[spec.name] ?? [])]));
  }
  return readTriggers(sql).filter(
    (t) =>
      t.event === "INSERT" ||
      (t.event === "UPDATE" &&
        (updated.get(t.table)?.size ?? 0) > 0 &&
        (t.columns === null || t.columns.some((c) => updated.get(t.table)?.has(c)))),
  );
}

function id(n: number): string {
  return String(110_000_000_000_000_000n + BigInt(n));
}

function admin(state: DurableObjectState): StoreAdmin {
  return new StoreAdmin(state, testKernel(state), { source: { build: BUILD, version: "test" }, log: () => {} });
}

const QUOTE_COUNTS = "SELECT id, CAST(quotes_count AS TEXT) AS n, typeof(quotes_count) AS t FROM statuses ORDER BY id";

function quoteCounts(store: StoreStub) {
  return runInDurableObject(store, (_instance, state) => state.storage.sql.exec(QUOTE_COUNTS).toArray());
}

// A Store with accepted, pending and revoked quotes (local and received, of a withdrawn status too), a remote follow of
// a local account beside another pair's held Reject, and public, private and direct statuses whose newest is not the
// last inserted. `bulk` adds that many accepted quotes, each of its own quoted status of `bulkBytes` of content.
async function quotedStore(bulk = 0, bulkBytes = 0): Promise<StoreStub> {
  const store = await migratedStore();
  await seedStore(store);
  await runInDurableObject(store, (_instance, state) => {
    const sql = state.storage.sql;
    const now = "2026-10-12T00:00:00.000Z";
    sql.exec(
      "INSERT INTO accounts (id, uri, username, domain) VALUES (?, 'https://remote.test/users/carol', 'carol', 'remote.test')",
      id(3),
    );
    const status = (n: number, account: number, visibility: string, content = "", withdrawn = 0) =>
      sql.exec(
        `INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, withdrawn)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id(n),
        `https://${account === 1 ? "kopje.test/ap/o" : "remote.test/s"}/${n}`,
        id(account),
        visibility,
        content,
        now,
        withdrawn,
      );
    // Inserted newest first, with a newer direct status, so accounts.last_status_id is not the last insert.
    status(39, 1, "direct");
    status(38, 2, "private");
    status(21, 1, "public", "quoted b");
    status(20, 1, "public", "quoted a");
    for (const n of [30, 31, 32, 33, 34, 35]) {
      status(n, n % 2 === 0 ? 1 : 2, "public", `quoting ${n}`, n === 34 ? 1 : 0);
    }
    const quote = (n: number, quoted: number | null, state: string, local: number) =>
      sql.exec(
        `INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, local, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id(n),
        `https://kopje.test/ap/o/${quoted ?? "gone"}`,
        quoted === null ? null : id(quoted),
        quoted === null ? null : id(1),
        state,
        local,
        now,
      );
    quote(30, 20, "accepted", 1);
    quote(31, 20, "accepted", 0);
    quote(32, 20, "pending", 0);
    quote(33, 21, "revoked", 0);
    quote(34, 21, "accepted", 1);
    quote(35, null, "pending", 0);
    for (let i = 0; i < bulk; i++) {
      status(2000 + i, 1, "public", `${i} ${"q".repeat(bulkBytes)}`);
      status(3000 + i, 2, "public", `quoting bulk ${i}`);
      quote(3000 + i, 2000 + i, "accepted", 0);
    }
    sql.exec(
      "INSERT INTO follows (account_id, target_account_id, state, uri) VALUES (?, ?, 'accepted', 'https://remote.test/f/1')",
      id(2),
      id(1),
    );
    sql.exec(
      "INSERT INTO reject_replays (account_id, follower_id, follow_uri, check_at) VALUES (?, ?, 'https://remote.test/f/2', 0)",
      id(1),
      id(3),
    );
  });
  return store;
}

// Adds to `store`, before an import, a probe beside each listed trigger: one that records the insert or update it is
// attached to (reached) and one with the trigger's own WHEN (fired), both in kopje_state names no dump holds.
async function addProbes(store: StoreStub): Promise<void> {
  await runInDurableObject(store, (_instance, state) => {
    const sql = state.storage.sql;
    for (const t of importTriggers(sql)) {
      const on = `AFTER ${t.event}${t.columns === null ? "" : ` OF ${t.columns.join(", ")}`} ON ${t.table}`;
      const record = (kind: string) =>
        `INSERT OR IGNORE INTO kopje_state (name, value) VALUES ('probe:${kind}:${t.name}', '1')`;
      sql.exec(`CREATE TRIGGER probe_reached_${t.name} ${on} BEGIN ${record("reached")}; END`);
      sql.exec(
        `CREATE TRIGGER probe_fired_${t.name} ${on}${t.when === null ? "" : ` WHEN ${t.when}`} BEGIN ${record("fired")}; END`,
      );
    }
    // The streaming triggers write only while a socket is subscribed; a target Store may hold one (stream_* is
    // never dumped, so it does not count against an empty Store).
    sql.exec("INSERT INTO stream_subscriptions (account_id, stream_key, sockets) VALUES (?, 'user', 1)", id(1));
  });
}

function probes(store: StoreStub, kind: string) {
  return runInDurableObject(store, (_instance, state) =>
    state.storage.sql
      .exec<{ name: string }>(
        "SELECT substr(name, ?) AS name FROM kopje_state WHERE name LIKE ? ORDER BY name",
        kind.length + 8,
        `probe:${kind}:%`,
      )
      .toArray()
      .map((r) => r.name),
  );
}

function withoutState(snapshot: Record<string, string[]>): Record<string, string[]> {
  const { kopje_state: _state, stream_events: _events, stream_subscriptions: _subscriptions, ...rest } = snapshot;
  return rest;
}

// Runs an import's verification to the end at `maxBytes` per call, recording where the quote counts stood after each.
async function verifyInSteps(store: StoreStub, text: string, maxBytes: number) {
  const id = await beginImport(store, text);
  let seq = 0;
  for (const chunk of await importChunks(text, 64 * 1024)) {
    expect(await store.importChunk(BUILD, ACCESS, id, ++seq, chunk)).toMatchObject({ ok: true });
  }
  expect(await store.importFinish(BUILD, ACCESS, id, splitDump(text).trailer)).toMatchObject({ ok: true });
  return runInDurableObject(store, async (_instance, state) => {
    const cursors: (string | undefined)[] = [];
    for (let calls = 1; ; calls++) {
      const step = await admin(state).importVerify(BUILD, ACCESS, id, maxBytes);
      if (!step.ok) throw new Error(step.message);
      cursors.push(readFlags(state.storage.sql).import?.verify?.quoteCounts);
      if (step.done) {
        return { report: step.report, calls, cursors };
      }
    }
  });
}

describe("writing triggers and the importer", () => {
  it("lists every trigger an import runs that writes, each with its reason", async () => {
    const store = await migratedStore();
    const found = await runInDurableObject(store, (_instance, state) => importTriggers(state.storage.sql));
    expect(found.map((t) => t.name)).toEqual(Object.keys(WRITING_TRIGGERS).toSorted());
    // The guard sees the trigger kinds it filters: a writing UPDATE trigger of an unlinked column and a check are left
    // out, and the importer's own updates name columns that exist.
    const all = await runInDurableObject(store, (_instance, state) => readTriggers(state.storage.sql));
    expect(all.map((t) => t.name)).toContain("statuses_last_status_changed");
    expect(all.map((t) => t.name)).not.toContain("statuses_bounds_insert");
    const columns = await runInDurableObject(store, (_instance, state) =>
      state.storage.sql
        .exec<{ name: string }>("SELECT name FROM pragma_table_info('statuses')")
        .toArray()
        .map((c) => c.name),
    );
    expect(columns).toEqual(expect.arrayContaining(IMPORTER_UPDATES.statuses!));
    // reject_replays_follow_stored rests on this order.
    const order = await runInDurableObject(store, (_instance, state) =>
      readCatalog(state.storage.sql).map((t) => t.name),
    );
    expect(order.indexOf("follows")).toBeLessThan(order.indexOf("local_accounts"));
    expect(order.indexOf("follows")).toBeLessThan(order.indexOf("reject_replays"));
    expect(order.indexOf("statuses")).toBeLessThan(order.indexOf("quotes"));
    expect(order.indexOf("accounts")).toBeLessThan(order.indexOf("statuses"));
  });

  it("round-trips accepted, pending and revoked quotes and rows that fire each writing trigger, keeping the dumped values", async () => {
    const source = await quotedStore();
    expect((await quoteCounts(source)).filter((r) => r.n !== "0")).toEqual([
      { id: id(20), n: "2", t: "integer" },
      { id: id(21), n: "1", t: "integer" },
    ]);
    const { text } = await dumpViaRpc(source, 4096);
    const { trailer } = splitDump(text) as { trailer: DumpTrailer };
    const target = await migratedStore();
    await copyConfig(source, target);
    await addProbes(target);
    const { report } = await importViaRpc(target, text, 8 * 1024);
    expect(report).toMatchObject({ ok: true, foreignKeyViolations: 0, problems: [] });
    expect(report?.tables.map((t) => [t.name, t.rows, t.checksum])).toEqual(
      trailer.tables.map((t) => [t.name, t.rows, t.checksum]),
    );
    expect(await quoteCounts(target)).toEqual(await quoteCounts(source));
    expect(withoutState(await tableSnapshot(target))).toEqual(withoutState(await tableSnapshot(source)));
    // Each listed trigger ran during the import, and each whose WHEN an honest dump makes true fired.
    const names = Object.keys(WRITING_TRIGGERS).toSorted();
    expect(await probes(target, "reached")).toEqual(names);
    expect(await probes(target, "fired")).toEqual(names.filter((n) => WRITING_TRIGGERS[n]!.fires));
  });

  it("gives the same Store when verification takes the smallest step per call as in one call", async () => {
    const quotes = 12;
    const source = await quotedStore(quotes, 2048);
    const { text } = await dumpViaRpc(source);
    const whole = await migratedStore();
    await copyConfig(source, whole);
    const once = await verifyInSteps(whole, text, 32 * 1024 * 1024);
    const split = await migratedStore();
    await copyConfig(source, split);
    const stepped = await verifyInSteps(split, text, 1024);
    expect(once.report).toMatchObject({ ok: true });
    expect(stepped.report).toMatchObject({ ok: true });
    // One call corrects them all at the largest step; at the smallest, each call stops after one large quoted status
    // (the call that corrects the last quote ends the correction and goes on to the checksums).
    expect(once.calls).toBe(1);
    const corrections = new Set(stepped.cursors.filter((c) => c !== undefined && c !== QUOTE_COUNTS_DONE));
    expect(corrections.size).toBeGreaterThanOrEqual(quotes - 1);
    expect(await quoteCounts(split)).toEqual(await quoteCounts(source));
    expect(withoutState(await tableSnapshot(split))).toEqual(withoutState(await tableSnapshot(whole)));
  });

  it("keeps a dumped quotes_count at either end of its integer range", async () => {
    const source = await quotedStore();
    await runInDurableObject(source, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE statuses SET quotes_count = CASE id WHEN ? THEN -9223372036854775808 ELSE 9223372036854775806 END WHERE id IN (?, ?)",
        id(20),
        id(20),
        id(21),
      );
    });
    const { text } = await dumpViaRpc(source);
    const target = await migratedStore();
    await copyConfig(source, target);
    expect((await importViaRpc(target, text)).report).toMatchObject({ ok: true });
    expect((await quoteCounts(target)).filter((r) => r.n !== "0")).toEqual([
      { id: id(20), n: "-9223372036854775808", t: "integer" },
      { id: id(21), n: "9223372036854775806", t: "integer" },
    ]);
  });

  it("reads quotes by rowid and names each quoted status by its key", async () => {
    const store = await quotedStore();
    await runInDurableObject(store, (_instance, state) => {
      const sql = state.storage.sql;
      const plan = (query: string, ...params: SqlStorageValue[]) =>
        sql
          .exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, ...params)
          .toArray()
          .map((r) => r.detail);
      expect(
        plan(
          "SELECT CAST(rowid AS TEXT) AS at, (state = 'accepted' AND quoted_status_id IS NOT NULL) AS counted FROM quotes WHERE rowid > CAST(? AS INTEGER) ORDER BY rowid LIMIT ?",
          "1",
          2000,
        ),
      ).toEqual(["SEARCH quotes USING INTEGER PRIMARY KEY (rowid>?)"]);
      expect(
        plan(
          "UPDATE statuses SET quotes_count = quotes_count - 1 WHERE id = (SELECT quoted_status_id FROM quotes WHERE rowid = CAST(? AS INTEGER))",
          "1",
        ),
      ).toEqual([
        "SEARCH statuses USING INDEX sqlite_autoindex_statuses_1 (id=?)",
        "SCALAR SUBQUERY 1",
        "SEARCH quotes USING INTEGER PRIMARY KEY (rowid=?)",
      ]);
      // A step reads at most maxRows quotes and resumes after the last it read.
      const tables = readCatalog(sql);
      const before = sql.exec(QUOTE_COUNTS).toArray();
      const first = correctQuoteCounts(sql, tables, null, 1 << 20, 2);
      expect(first).toBe(
        sql.exec<{ at: string }>("SELECT CAST(rowid AS TEXT) AS at FROM quotes ORDER BY rowid LIMIT 1 OFFSET 1").one()
          .at,
      );
      expect(correctQuoteCounts(sql, tables, first, 1 << 20, 2000)).toBe(QUOTE_COUNTS_DONE);
      // Every accepted quote taken off once: 2 and 1 become 0.
      expect(
        sql
          .exec(QUOTE_COUNTS)
          .toArray()
          .filter((r) => r.n !== "0"),
      ).toEqual([]);
      expect(before.filter((r) => r.n !== "0")).toHaveLength(2);
    });
  });
});
