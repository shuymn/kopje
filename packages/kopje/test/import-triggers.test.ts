import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { readCatalog } from "../src/platform/dump-catalog";
import type { DumpTrailer, TableResult } from "../src/platform/dump-format";
import { type SqlToken, tokenizeSql } from "../src/platform/readonly-sql";
import { MAX_IMPORT_CHUNK_STATEMENTS, StoreAdmin } from "../src/platform/store-admin";
import type { StoreStub } from "../src/platform/store-client";
import { checksumStep } from "../src/platform/store-dump";
import { readFlags, writeFlag } from "../src/platform/store-flags";
import {
  applyStagedLinks,
  correctQuoteCounts,
  QUOTE_COUNTS_DONE,
  type VerifyReport,
} from "../src/platform/store-import";
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
import { singletonStatistics } from "./plan-audit-store";

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

// Columns the importer updates after inserting the rows, besides the links (deferred columns): the quote counts.
const IMPORTER_UPDATES: Record<string, string[]> = { statuses: ["quotes_count"] };

type Trigger = {
  name: string;
  // Identifiers as SQLite compares them: unquoted, lower-cased (ASCII case is ignored).
  table: string;
  event: "INSERT" | "UPDATE" | "DELETE";
  columns: string[] | null;
  when: string | null;
  writes: boolean;
};

// The identifier a token spells, unquoted and lower-cased, or null when the token is no identifier.
function identifier(sql: string, token: SqlToken | undefined): string | null {
  if (token?.kind === "word") {
    return token.text.toLowerCase();
  }
  if (token?.kind !== "other" || !['"', "`", "["].includes(token.text)) {
    return null;
  }
  const close = token.text === "[" ? "]" : token.text;
  let value = "";
  for (let i = token.at + 1; i < sql.length; i++) {
    if (sql[i] === close) {
      if (close !== "]" && sql[i + 1] === close) {
        value += close;
        i++;
        continue;
      }
      return value.toLowerCase();
    }
    value += sql[i];
  }
  return null;
}

// Parses a CREATE TRIGGER statement as sqlite_master keeps it (src/platform/readonly-sql.ts tokens, so comments,
// strings and quoted identifiers are read as SQLite reads them). Throws on any header it cannot read, so a trigger is
// never left out of the inventory for its spelling.
function parseTrigger(sql: string): Trigger {
  const tokens = tokenizeSql(sql);
  const fail = (why: string): never => {
    throw new Error(`cannot read the trigger header (${why}): ${sql.slice(0, 200)}`);
  };
  if (typeof tokens === "string") {
    return fail(tokens);
  }
  let i = 0;
  const word = (...texts: string[]) => {
    const token = tokens[i];
    if (token?.kind === "word" && texts.includes(token.text)) {
      i++;
      return token.text;
    }
    return null;
  };
  // [schema .] name
  const qualified = (what: string) => {
    let name = identifier(sql, tokens[i]) ?? fail(`no ${what}`);
    i++;
    if (tokens[i]?.kind === "punct" && tokens[i]?.text === ".") {
      i++;
      name = identifier(sql, tokens[i]) ?? fail(`no ${what} after its schema`);
      i++;
    }
    return name;
  };
  if (word("CREATE") === null) fail("no CREATE");
  word("TEMP", "TEMPORARY");
  if (word("TRIGGER") === null) fail("no TRIGGER");
  if (word("IF") !== null && (word("NOT") === null || word("EXISTS") === null)) fail("IF without NOT EXISTS");
  const name = qualified("name");
  // An omitted timing is BEFORE.
  if (word("BEFORE", "AFTER") === null && word("INSTEAD") !== null && word("OF") === null) fail("INSTEAD without OF");
  const event = (word("INSERT", "UPDATE", "DELETE") ?? fail("no event")) as Trigger["event"];
  let columns: string[] | null = null;
  if (event === "UPDATE" && word("OF") !== null) {
    columns = [];
    for (;;) {
      columns.push(identifier(sql, tokens[i]) ?? fail("no column"));
      i++;
      if (!(tokens[i]?.kind === "punct" && tokens[i]?.text === ",")) break;
      i++;
    }
  }
  if (word("ON") === null) fail("no ON");
  const table = qualified("table");
  if (word("FOR") !== null && (word("EACH") === null || word("ROW") === null)) fail("FOR without EACH ROW");
  let when: string | null = null;
  const whenToken = tokens[i];
  if (word("WHEN") !== null) {
    const begin = tokens.findIndex((t, at) => at > i && t.kind === "word" && t.text === "BEGIN");
    if (begin === -1) fail("no BEGIN after WHEN");
    when = sql.slice((whenToken?.at ?? 0) + 4, tokens[begin]?.at).trim();
    i = begin;
  }
  if (word("BEGIN") === null) fail("no BEGIN");
  // The body writes when it holds an INSERT, UPDATE, DELETE or REPLACE statement keyword (a replace() call counts
  // too: the inventory then asks for an entry it does not need, never the reverse).
  const writes = tokens
    .slice(i)
    .some((t) => t.kind === "word" && ["INSERT", "UPDATE", "DELETE", "REPLACE"].includes(t.text));
  if (name === "") fail("empty name");
  return { name, table, event, columns, when, writes };
}

// The writing triggers an import runs: on INSERT, or on an UPDATE that may name a column the importer updates.
function importTriggers(sql: SqlStorage): Trigger[] {
  const updated = new Map<string, Set<string>>();
  for (const spec of readCatalog(sql)) {
    const columns = [...spec.deferred, ...(IMPORTER_UPDATES[spec.name] ?? [])];
    updated.set(spec.name.toLowerCase(), new Set(columns.map((c) => c.toLowerCase())));
  }
  return sql
    .exec<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
    .toArray()
    .map((row) => parseTrigger(row.sql))
    .filter(
      (t) =>
        t.writes &&
        (t.event === "INSERT" ||
          (t.event === "UPDATE" &&
            (updated.get(t.table)?.size ?? 0) > 0 &&
            (t.columns === null || t.columns.some((c) => updated.get(t.table)?.has(c))))),
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

// Adds to `store`, before an import, two probes beside each listed trigger: one that records the insert or update it
// is attached to (reached) and one with a copy of the trigger's WHEN (fired), both in kopje_state names no dump holds.
// They are sibling triggers on the same event: they show which rows reach each trigger and satisfy its WHEN, not what
// the production trigger's body did (the snapshot comparison covers that).
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
    const all = await runInDurableObject(store, (_instance, state) =>
      state.storage.sql
        .exec<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'trigger'")
        .toArray()
        .map((row) => parseTrigger(row.sql)),
    );
    expect(all.find((t) => t.name === "statuses_last_status_changed")).toMatchObject({
      event: "UPDATE",
      columns: ["visibility", "account_id"],
      writes: true,
    });
    expect(all.find((t) => t.name === "statuses_bounds_insert")).toMatchObject({ event: "INSERT", writes: false });
    expect(found.map((t) => t.name)).not.toContain("statuses_last_status_changed");
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

  it("reads a trigger with no timing, an identifier in another case and quoted identifiers, and refuses a header it cannot read", async () => {
    const store = await migratedStore();
    const found = await runInDurableObject(store, (_instance, state) => {
      const sql = state.storage.sql;
      // No timing (BEFORE), on INSERT.
      sql.exec(
        "CREATE TRIGGER fixture_untimed INSERT ON quotes BEGIN UPDATE statuses SET quotes_count = 0 WHERE 0; END",
      );
      // An importer-updated column in upper case.
      sql.exec(
        "CREATE TRIGGER fixture_upper AFTER UPDATE OF QUOTES_COUNT ON statuses BEGIN DELETE FROM stream_events WHERE 0; END",
      );
      // A linked column, the trigger and its table quoted three ways, and a schema-qualified table.
      sql.exec(
        `CREATE TRIGGER "fixture ""quoted""" AFTER UPDATE OF \`In_Reply_To_Id\` ON main.[statuses]
         BEGIN DELETE FROM stream_events WHERE 0; END`,
      );
      return importTriggers(sql).map((t) => t.name);
    });
    expect(found).toEqual(
      expect.arrayContaining([
        "fixture_untimed",
        "fixture_upper",
        'fixture "quoted"',
        ...Object.keys(WRITING_TRIGGERS),
      ]),
    );
    expect(found).toHaveLength(Object.keys(WRITING_TRIGGERS).length + 3);
    expect(() => parseTrigger("CREATE TRIGGER t SOMETIMES INSERT ON quotes BEGIN DELETE FROM quotes; END")).toThrow(
      /cannot read the trigger header \(no event\)/,
    );
    expect(() => parseTrigger("CREATE TRIGGER t INSERT quotes BEGIN DELETE FROM quotes; END")).toThrow(/no ON/);
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

  it("resumes each step after the last quote it read", async () => {
    const store = await quotedStore();
    await runInDurableObject(store, (_instance, state) => {
      const sql = state.storage.sql;
      // A step reads at most maxRows quotes and resumes after the last it read.
      const tables = readCatalog(sql);
      const before = sql.exec(QUOTE_COUNTS).toArray();
      const first = correctQuoteCounts(sql, tables, null, 1 << 20, 2);
      expect(first).toBe(
        sql.exec<{ at: string }>("SELECT quote(status_id) AS at FROM quotes ORDER BY status_id LIMIT 1 OFFSET 1").one()
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

  it("verifies an import whose checksums an earlier version began before the counts were corrected", async () => {
    const source = await quotedStore();
    const { text } = await dumpViaRpc(source);
    const target = await migratedStore();
    await copyConfig(source, target);
    const importId = await beginImport(target, text);
    let seq = 0;
    for (const chunk of await importChunks(text, 64 * 1024)) {
      expect(await target.importChunk(BUILD, ACCESS, importId, ++seq, chunk)).toMatchObject({ ok: true });
    }
    expect(await target.importFinish(BUILD, ACCESS, importId, splitDump(text).trailer)).toMatchObject({ ok: true });
    await runInDurableObject(target, async (_instance, state) => {
      const sql = state.storage.sql;
      const record = readFlags(sql).import!;
      const tables = record.header.tables;
      // What an earlier version's verify calls left: links applied, then checksums taken over the raised counts
      // past the whole statuses table, in a record with no quoteCounts.
      while (applyStagedLinks(sql, tables, 1 << 20, 2000)) {
        // applied in steps
      }
      let position = record.verify!.position;
      const results: TableResult[] = [];
      while (!results.some((r) => r.name === "statuses")) {
        const step = checksumStep(sql, tables, position, 1024, () => null);
        position = step.position;
        results.push(...step.finished);
      }
      expect(sql.exec("SELECT quotes_count FROM statuses WHERE id = ?", id(20)).one().quotes_count).toBe(4);
      writeFlag(sql, "import", { ...record, verify: { position, results } });
      let report: VerifyReport | null = null;
      for (let call = 0; call < 100; call++) {
        const step = await admin(state).importVerify(BUILD, ACCESS, record.id);
        if (!step.ok) throw new Error(step.message);
        if (step.done) {
          report = step.report;
          break;
        }
      }
      expect(report).toMatchObject({ ok: true, problems: [] });
      expect(sql.exec("SELECT quotes_count FROM statuses WHERE id = ?", id(20)).one().quotes_count).toBe(2);
    });
  });

  // RES-7 witness of the correction's two statements, captured as correctQuoteCounts runs them: under the plan
  // audit's singleton statistics, and under ANALYZE taken while the Store held the seed's six quotes, a step reads by a
  // seek on the quotes' primary key however many quotes the Store holds (grown past MAX_IMPORT_CHUNK_STATEMENTS, the
  // step's row cap), and its rows read stay flat as the quotes grow.
  it("reads each step's quotes by a primary-key seek, flat as the quotes grow under stale statistics", async () => {
    for (const statistics of ["singleton", "stale"] as const) {
      const store = await quotedStore();
      const measured: { quotes: number; select: number; first: number; plans: string[] }[] = [];
      for (const grown of [MAX_IMPORT_CHUNK_STATEMENTS + 1000, 3 * MAX_IMPORT_CHUNK_STATEMENTS]) {
        measured.push(
          await runInDurableObject(store, (_instance, state) => {
            const sql = state.storage.sql;
            if (statistics === "stale" && measured.length === 0) {
              sql.exec("ANALYZE");
            }
            const have = sql.exec<{ n: number }>("SELECT count(*) AS n FROM quotes").one().n;
            sql.exec(
              `WITH RECURSIVE n(i) AS (SELECT CAST(?1 AS INTEGER) UNION ALL SELECT i + 1 FROM n WHERE i < CAST(?2 AS INTEGER))
               INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
               SELECT CAST(140000000000000000 + i AS TEXT), 'https://remote.test/q/' || i, ?3, 'public', 'q',
                 '2026-10-12T00:00:00.000Z' FROM n`,
              have,
              grown - 1,
              id(2),
            );
            sql.exec(
              `INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, updated_at)
               SELECT id, 'https://kopje.test/ap/o/20', ?1, ?2, 'accepted', '2026-10-12T00:00:00.000Z'
               FROM statuses WHERE id >= '140000000000000000' AND id NOT IN (SELECT status_id FROM quotes)`,
              id(20),
              id(1),
            );
            const quotes = sql.exec<{ n: number }>("SELECT count(*) AS n FROM quotes").one().n;
            if (statistics === "singleton") {
              singletonStatistics(sql);
            }
            const seen: {
              query: string;
              params: SqlStorageValue[];
              cursor: SqlStorageCursor<Record<string, SqlStorageValue>>;
            }[] = [];
            const recording = {
              exec: (query: string, ...params: SqlStorageValue[]) => {
                const cursor = sql.exec(query, ...params);
                seen.push({ query, params, cursor });
                return cursor;
              },
            } as unknown as SqlStorage;
            const tables = readCatalog(sql);
            const plan = (s: (typeof seen)[number]) =>
              sql
                .exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${s.query}`, ...s.params)
                .toArray()
                .map((r) => r.detail)
                .join(" | ");
            // A step that starts 50 quotes before the end, and the first step.
            const near = sql
              .exec<{ at: string }>(
                "SELECT quote(status_id) AS at FROM quotes ORDER BY status_id DESC LIMIT 1 OFFSET 50",
              )
              .one().at;
            state.storage.transactionSync(() => {
              expect(correctQuoteCounts(recording, tables, near, 1 << 30, MAX_IMPORT_CHUNK_STATEMENTS)).toBe(
                QUOTE_COUNTS_DONE,
              );
            });
            const resumed = seen.splice(0);
            state.storage.transactionSync(() => {
              correctQuoteCounts(recording, tables, null, 1 << 30, MAX_IMPORT_CHUNK_STATEMENTS);
            });
            const started = seen.splice(0);
            const select = resumed.filter((s) => s.query.startsWith("SELECT"));
            const updates = [...resumed, ...started].filter((s) => s.query.startsWith("UPDATE"));
            expect(select).toHaveLength(1);
            expect(resumed.filter((s) => s.query.startsWith("UPDATE"))).toHaveLength(50);
            // Each update: the quote by rowid and its status by key.
            for (const u of updates.slice(0, 3)) {
              expect(plan(u)).toBe(
                "SEARCH statuses USING INDEX sqlite_autoindex_statuses_1 (id=?) | SCALAR SUBQUERY 1 | SEARCH quotes USING INTEGER PRIMARY KEY (rowid=?)",
              );
            }
            expect(Math.max(...updates.map((u) => u.cursor.rowsRead))).toBeLessThanOrEqual(3);
            const first = started.find((s) => s.query.startsWith("SELECT"))!;
            return {
              quotes,
              select: select[0]!.cursor.rowsRead,
              first: first.cursor.rowsRead,
              plans: [plan(select[0]!), plan(first)],
            };
          }),
        );
      }
      const [small, large] = measured;
      expect(large!.quotes, statistics).toBeGreaterThan(small!.quotes);
      expect(small!.quotes, statistics).toBeGreaterThan(MAX_IMPORT_CHUNK_STATEMENTS);
      for (const m of measured) {
        expect(m.plans, statistics).toEqual([
          "SEARCH quotes USING INDEX sqlite_autoindex_quotes_1 (status_id>?)",
          "SCAN quotes USING INDEX sqlite_autoindex_quotes_1",
        ]);
        // The resumed step reads the 50 quotes left; the first reads at most its cap, in primary-key order.
        expect(m.select, statistics).toBeLessThanOrEqual(51);
        expect(m.first, statistics).toBeLessThanOrEqual(MAX_IMPORT_CHUNK_STATEMENTS + 1);
      }
      expect(large!.select, statistics).toBe(small!.select);
      expect(large!.first, statistics).toBe(small!.first);
    }
  }, 120_000);
});
