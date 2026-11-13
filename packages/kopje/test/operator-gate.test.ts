import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { readOperation, writeOperation } from "../src/domain/operation";
import type { MaintenanceReason } from "../src/platform/store-errors";
import { flagRefusal, type OperatorFlags, readFlags, readGate } from "../src/platform/store-flags";
import type { OperationKind, StoreOperation } from "../src/platform/store-kernel";
import { NOW } from "./app-helpers";
import { BUILD, migratedStore, testKernel } from "./helpers";
import { queryPlan } from "./plan-audit-store";
import { observedSql, type SqlRow } from "./read-helpers";

// Admission reads the operator gate (store-flags.ts readGate), not the operator records (readFlags).

// The decision admission made over the full records (store-flags.ts flagRefusal and activeDump before the gate),
// kept literally as the baseline the gate is compared with.
function recordsRefusal(flags: OperatorFlags, kind: OperationKind, now: number): MaintenanceReason | null {
  const activeDump = flags.dump !== null && now < flags.dump.leaseUntil ? flags.dump : null;
  if (flags.import !== null) {
    return "import-in-progress";
  }
  if (kind !== "read" && activeDump !== null) {
    return "dump-in-progress";
  }
  const write = kind === "write" || kind === "media-delete";
  if (write && flags.maintenance !== null) {
    return "maintenance";
  }
  if (write && flags.unpublished !== null) {
    return "unpublished";
  }
  if (kind === "media-delete" && flags.media_rebuild_lease !== null && flags.media_rebuild_lease.until > now) {
    return "rebuild-in-progress";
  }
  return null;
}

const KINDS: readonly OperationKind[] = ["read", "session", "write", "media-delete", "media-rebuild"];

// A stored value: JSON text, other text, or a BLOB; undefined is an absent row.
type Stored = string | Uint8Array | undefined;

// Values every flag can hold, well-formed or not: absent, a JSON null, JSON of the wrong shape, text that is not JSON
// (JSON5 too, which SQLite's JSON functions accept and JSON.parse refuses) and a BLOB holding JSON bytes.
const MALFORMED: readonly Stored[] = [
  undefined,
  " null ",
  "1",
  '"x"',
  "{",
  "{mode: 'readonly'}",
  new TextEncoder().encode("{}"),
];

// A lease end (`field` of dump and media_rebuild_lease) live, ended, missing, and of every other JSON type.
function leases(field: string): Stored[] {
  const at = (value: string) => `{"id":"d","${field}":${value}}`;
  return [
    at(String(NOW + 1)),
    at(String(NOW)),
    at(String(NOW - 1)),
    at(`${NOW}.5`),
    at("0"),
    at("-1e400"),
    at("1e400"),
    at("9007199254740993"),
    at(`"${NOW + 1}"`),
    at(`"\\u0039${NOW}"`),
    at('"later"'),
    at("true"),
    at("null"),
    at(`[${NOW + 1}]`),
    at(`{"at":${NOW + 1}}`),
    `{"id":"d"}`,
    ...MALFORMED,
  ];
}

const VALUES: Record<"maintenance" | "import" | "unpublished" | "dump" | "media_rebuild_lease", Stored[]> = {
  maintenance: ['{"mode":"readonly","at":1}', ...MALFORMED],
  import: ['{"id":"i","state":"receiving"}', ...MALFORMED],
  unpublished: ['{"at":1,"import":"i"}', ...MALFORMED],
  dump: leases("leaseUntil"),
  media_rebuild_lease: leases("until"),
};

type Decision = { threw: true } | { refused: MaintenanceReason | null }[];

function decide(read: () => (kind: OperationKind) => MaintenanceReason | null): Decision {
  let refusal: (kind: OperationKind) => MaintenanceReason | null;
  try {
    refusal = read();
  } catch {
    return { threw: true };
  }
  return KINDS.map((kind) => ({ refused: refusal(kind) }));
}

function* combinations(): Generator<[keyof typeof VALUES, Stored][]> {
  const names = Object.keys(VALUES) as (keyof typeof VALUES)[];
  const walk = function* (i: number, acc: [keyof typeof VALUES, Stored][]): Generator<[keyof typeof VALUES, Stored][]> {
    const name = names[i];
    if (name === undefined) {
      yield acc;
      return;
    }
    for (const value of VALUES[name]) {
      yield* walk(i + 1, [...acc, [name, value]]);
    }
  };
  yield* walk(0, []);
}

const textBytes = new TextEncoder();

// The bytes of the values `rows` hand to the caller: a string's UTF-8 length, a BLOB's length, 8 for a number.
function bytesOf(rows: readonly SqlRow[]): number {
  let total = 0;
  for (const row of rows) {
    for (const value of Object.values(row)) {
      if (typeof value === "string") {
        total += textBytes.encode(value).byteLength;
      } else if (value instanceof ArrayBuffer) {
        total += value.byteLength;
      } else if (value !== null) {
        total += 8;
      }
    }
  }
  return total;
}

// A DurableObjectState whose SQL handle adds the bytes each statement over kopje_state returns to `read.bytes`.
function observedState(state: DurableObjectState, read: { bytes: number }): DurableObjectState {
  const sql = observedSql(state.storage.sql, (rows, query) => {
    if (/\bkopje_state\b/.test(query)) {
      read.bytes += bytesOf(rows);
    }
  });
  const storage = new Proxy(state.storage, {
    get: (real, name) => {
      if (name === "sql") {
        return sql;
      }
      const value = Reflect.get(real, name) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(real) : value;
    },
  });
  return new Proxy(state, {
    get: (real, name) => (name === "storage" ? storage : (Reflect.get(real, name) as unknown)),
  });
}

const touch = writeOperation<string, void>((db, name) => {
  db.run("INSERT OR REPLACE INTO instance_settings (name, value) VALUES (?, 'x')", name);
});
const look = readOperation<string, unknown>((db, name) =>
  db.first("SELECT value FROM instance_settings WHERE name = ?", name),
);

// The bytes of kopje_state one execution of `operation` reads in the kernel (admission and the kernel's own state).
async function admissionBytes<I>(state: DurableObjectState, operation: StoreOperation<I, unknown>, input: I) {
  const read = { bytes: 0 };
  await testKernel(observedState(state, read)).execute(BUILD, operation, input);
  return read.bytes;
}

describe("operator gate", () => {
  it("decides admission as the full records do, for every flag state, malformed values included", async () => {
    const store = await migratedStore();
    const differences = await runInDurableObject(store, (_instance, state) => {
      const sql = state.storage.sql;
      const out: { stored: [string, Stored][]; records: Decision; gate: Decision }[] = [];
      let compared = 0;
      // Each combination rewrites only the rows that differ from the previous one.
      const current = new Map<string, Stored>();
      for (const stored of combinations()) {
        for (const [name, value] of stored) {
          if (current.has(name) && current.get(name) === value) {
            continue;
          }
          current.set(name, value);
          if (value === undefined) {
            sql.exec("DELETE FROM kopje_state WHERE name = ?", name);
          } else {
            sql.exec("INSERT OR REPLACE INTO kopje_state (name, value) VALUES (?, ?)", name, value);
          }
        }
        const records = decide(() => {
          const flags = readFlags(sql);
          return (kind) => recordsRefusal(flags, kind, NOW);
        });
        const gate = decide(() => {
          const flags = readGate(sql, NOW);
          return (kind) => flagRefusal(flags, kind, NOW);
        });
        compared++;
        if (JSON.stringify(records) !== JSON.stringify(gate) && out.length < 5) {
          out.push({ stored, records, gate });
        }
      }
      sql.exec(
        "DELETE FROM kopje_state WHERE name IN ('maintenance', 'import', 'unpublished', 'dump', 'media_rebuild_lease')",
      );
      return { compared, out };
    });
    expect(differences.out).toEqual([]);
    const expected = Object.values(VALUES).reduce((n, values) => n * values.length, 1);
    expect(differences.compared).toBe(expected);
  }, 120_000);

  it("reads one primary-key lookup per name", async () => {
    const store = await migratedStore();
    const plan = await runInDurableObject(store, (_instance, state) => {
      let gateSql = "";
      readGate(
        observedSql(state.storage.sql, (_rows, query) => {
          gateSql = query;
        }),
        NOW,
      );
      return queryPlan(state.storage.sql, gateSql, [NOW]).map((row) => row.detail);
    });
    expect(plan).toEqual(["SEARCH kopje_state USING PRIMARY KEY (name=?)"]);
  });

  it("reads no more of kopje_state after a completed dump, and a repeated finish answers the same trailer", async () => {
    const store = await migratedStore();
    const before = await runInDurableObject(store, async (_instance, state) => ({
      read: await admissionBytes(state, look, "a"),
      write: await admissionBytes(state, touch, "a"),
    }));
    const started = await store.dumpStart(BUILD);
    if (!started.ok) {
      throw new Error(started.message);
    }
    let cursor = started.cursor;
    for (;;) {
      const step = await store.dumpNext(BUILD, cursor);
      if (!step.ok) {
        throw new Error(step.message);
      }
      cursor = step.cursor;
      if (step.done) {
        break;
      }
    }
    const finished = await store.dumpFinish(BUILD, cursor);
    expect(finished).toMatchObject({ ok: true, aborted: false });
    // The receipt is kept, and is what a full read of the records would hand every operation.
    const receipt = await runInDurableObject(store, (_instance, state) =>
      bytesOf(state.storage.sql.exec("SELECT value FROM kopje_state WHERE name = 'dump'").toArray()),
    );
    expect(receipt).toBeGreaterThan(10_000);
    const after = await runInDurableObject(store, async (_instance, state) => ({
      read: await admissionBytes(state, look, "b"),
      write: await admissionBytes(state, touch, "b"),
    }));
    expect(after).toEqual(before);
    expect(await store.dumpFinish(BUILD, cursor)).toEqual(finished);
    expect(await store.health(BUILD)).toMatchObject({ readonly: false, maintenance: false, dump: null, import: null });
  });

  it("reports a running import in health from its record", async () => {
    const store = await migratedStore();
    await runInDurableObject(store, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO kopje_state (name, value) VALUES ('import', ?)",
        JSON.stringify({ id: "i", mode: "access", state: "receiving", lastSeq: 3 }),
      );
    });
    expect(await store.health(BUILD)).toMatchObject({
      readonly: true,
      dump: null,
      import: { id: "i", state: "receiving", lastSeq: 3 },
    });
  });
});
