import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { MIGRATIONS } from "../src/db/migrations";
import type { Db } from "../src/db/sql";
import {
  mediaDeleteOperation,
  mediaRebuildOperation,
  readOperation,
  sessionOperation,
  writeOperation,
} from "../src/domain/operation";
import type { StoreStub } from "../src/platform/store-client";
import { MAINTENANCE_REASONS, type MaintenanceReason, toStoreUnavailable } from "../src/platform/store-errors";
import type {
  KernelOptions,
  Migration,
  OperationKind,
  SchemaState,
  StoreKernel,
  StoreOperation,
  UpgradePhase,
} from "../src/platform/store-kernel";
import fixture from "./fixtures/upgrade-phases.json";
import { BUILD, deferred, migratedStore, testKernel as kernel } from "./helpers";

// What the Store admits in each state its health reports. test/fixtures/upgrade-phases.json holds docs/upgrade.md's
// two tables (test-node/upgrade-phases.test.ts compares them): the rules, one row for each combination of
// `schema.status`, `hold` and `upgrading` ("any" matching every value, "set" every reason), with the reason each kind of
// operation is refused (null: admitted; "hold": the hold's own reason) and `readonly`; and examples of how a Store
// reaches a state. The first suite seeds every combination the kernel's types allow and holds the kernel's own
// decision to the one rule it matches, so a state no row covers fails. The second builds each example through the
// upgrade itself (a failure, a stop or a timeout after a commit injected where it begins, overlapping attempts, a
// rollback) and reads it from the kernel that failed or a new isolate's. The Store applies and verifies in one
// invocation, so a request that arrives meanwhile waits for it to end (the third suite).

type Status = SchemaState["status"];
type Key = { schema: Status; hold: MaintenanceReason | null; upgrading: boolean };
type Refusals = Record<OperationKind, MaintenanceReason | null>;
type Rule = {
  schema: Status;
  hold: "any" | "set" | null;
  upgrading: "any" | boolean;
  refusals: Record<OperationKind, MaintenanceReason | "hold" | null>;
  readonly: boolean;
};
type Example = Key & { id: string; label: string };

const { rules: RULES, examples: EXAMPLES } = fixture as unknown as {
  rules: readonly Rule[];
  examples: readonly Example[];
};

function example(id: string): Example {
  const found = EXAMPLES.find((e) => e.id === id);
  if (found === undefined) {
    throw new Error(`no example ${id} in the fixture`);
  }
  return found;
}

const keyOf = ({ schema, hold, upgrading }: Key): Key => ({ schema, hold, upgrading });

// What the one rule a state matches says the Store admits in it.
function ruled(key: Key): { refusals: Refusals; readonly: boolean } {
  const matched = RULES.filter(
    (r) =>
      r.schema === key.schema &&
      (r.hold === "any" || (r.hold === "set" ? key.hold !== null : key.hold === null)) &&
      (r.upgrading === "any" || r.upgrading === key.upgrading),
  );
  expect(matched, `the rows for ${JSON.stringify(key)}`).toHaveLength(1);
  const rule = matched[0]!;
  const refusals = {} as Refusals;
  for (const kind of KINDS) {
    const refused = rule.refusals[kind];
    refusals[kind] = refused === "hold" ? key.hold : refused;
  }
  return { refusals, readonly: rule.readonly };
}

let written = 0;
const insert = (db: Db) => {
  db.run("INSERT INTO instance_settings (name, value) VALUES (?, 'x')", `phase-${++written}`);
};
const countSettings = (db: Db) => db.first<{ n: number }>("SELECT count(*) AS n FROM instance_settings")?.n ?? 0;

// One operation of each kind. Only the kind matters to the kernel; each but the read writes a row of its own.
const OPERATIONS: Record<OperationKind, StoreOperation<void, unknown>> = {
  read: readOperation<void, number>(countSettings),
  session: sessionOperation<void, void>(insert),
  write: writeOperation<void, void>(insert),
  "media-delete": mediaDeleteOperation<void, void>(insert),
  "media-rebuild": mediaRebuildOperation<void, void>(insert),
};
const KINDS = Object.keys(OPERATIONS) as OperationKind[];

// The reason the kernel refuses an operation of this kind from a caller of its own build, or null once the operation
// ran: the read answered the count, and a write left its row. A refused operation leaves none.
async function admission(k: StoreKernel, sql: SqlStorage, kind: OperationKind): Promise<MaintenanceReason | null> {
  const before = sql.exec<{ n: number }>("SELECT count(*) AS n FROM instance_settings").one().n;
  const after = () => sql.exec<{ n: number }>("SELECT count(*) AS n FROM instance_settings").one().n;
  try {
    const output = await k.execute(k.build, OPERATIONS[kind], undefined);
    expect(output).toBe(kind === "read" ? before : undefined);
    expect(after()).toBe(kind === "read" ? before : before + 1);
    return null;
  } catch (error) {
    const refused = toStoreUnavailable(error);
    if (refused === undefined) {
      throw error;
    }
    expect(after()).toBe(before);
    return refused.reason;
  }
}

// What a kernel reports in health, and what it admits.
async function observe(
  k: StoreKernel,
  sql: SqlStorage,
): Promise<{ key: Key; admits: { refusals: Refusals; readonly: boolean } }> {
  const reported = await k.health(k.build);
  const refusals = {} as Refusals;
  for (const kind of KINDS) {
    refusals[kind] = await admission(k, sql, kind);
  }
  return {
    key: { schema: reported.schema.status, hold: reported.hold, upgrading: reported.upgrading },
    admits: { refusals, readonly: reported.readonly },
  };
}

// A stand-in for the Store's state whose storage has the members `overrides` gives, and the platform's otherwise.
function overriding(state: DurableObjectState, overrides: Record<string, unknown>): DurableObjectState {
  const storage = new Proxy(state.storage, {
    get: (target, key) => (typeof key === "string" && key in overrides ? overrides[key] : member(target, key)),
  });
  return new Proxy(state, { get: (target, key) => (key === "storage" ? storage : member(target, key)) });
}

// The member `key` of `target`, a method bound to it, so that a proxy can stand in for a platform object.
function member(target: object, key: string | symbol): unknown {
  const value: unknown = Reflect.get(target, key, target);
  return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
}

// Two files after the shipped ones, so that a phase can begin between them.
const FIRST: Migration = { name: "9998_phase_first", sql: "CREATE TABLE phase_first (a);" };
const SECOND: Migration = { name: "9999_phase_second", sql: "CREATE TABLE phase_second (a);" };
const NEXT = [...MIGRATIONS, FIRST, SECOND];

// Throws at the nth time the upgrade reaches `phase`. With `stop`, recording the hold throws too: an invocation the
// platform ends (the CPU limit) records none, and leaves only the upgrade marker.
function failAt(phase: UpgradePhase, nth: number, stop: boolean): NonNullable<KernelOptions["inject"]> {
  let reached = 0;
  return (at) => {
    if (at === phase && ++reached === nth) {
      throw new Error(`injected ${at} failure`);
    }
    if (at === "hold" && stop) {
      throw new Error("injected stop");
    }
  };
}

// The build of the code before the upgrade, deployed again by a rollback: it ships none of the new files.
const OLDER_BUILD = "older-build";

function newFiles(sql: SqlStorage): string[] {
  return sql
    .exec<{ name: string }>("SELECT name FROM kopje_migrations WHERE name >= ? ORDER BY name", FIRST.name)
    .toArray()
    .map((m) => m.name);
}

const marked = (sql: SqlStorage) =>
  sql.exec<{ n: number }>("SELECT count(*) AS n FROM kopje_state WHERE name = 'upgrade'").one().n === 1;

// A transaction that commits and then reports a timeout, once: the first time `committed` holds after a commit.
function timesOutAfter(state: DurableObjectState, committed: (sql: SqlStorage) => boolean) {
  let thrown = false;
  return <T>(fn: () => T): T => {
    const value = state.storage.transactionSync(fn);
    if (!thrown && committed(state.storage.sql)) {
      thrown = true;
      throw new Error("Durable Object storage operation exceeded timeout");
    }
    return value;
  };
}

// Upgrades through `inject` (or a transaction that fails), expecting `result`, and checks which new files are recorded.
async function upgradeFailing(
  state: DurableObjectState,
  options: Partial<KernelOptions>,
  result: object,
  recorded: string[],
): Promise<StoreKernel> {
  const k = kernel(state, NEXT, options);
  expect(await k.upgrade()).toMatchObject(result);
  expect(newFiles(state.storage.sql)).toEqual(recorded);
  return k;
}

// Each example, in the fixture's order: the kernels that read it once built.
const BUILDERS: Record<string, (state: DurableObjectState) => StoreKernel[] | Promise<StoreKernel[]>> = {
  // A new deployment's first call: the new files are pending, and the upgrade has not recorded its bookmark.
  pending: (state) => {
    expect(newFiles(state.storage.sql)).toEqual([]);
    return [kernel(state, NEXT)];
  },
  // The invocation ended while it applied the second file, after the first committed.
  "stopped-applying": async (state) => {
    await upgradeFailing(state, { inject: failAt("apply", 2, true) }, { ok: false }, [FIRST.name]);
    return [kernel(state, NEXT)];
  },
  // The invocation ended in verification, after every file committed.
  "stopped-verifying": async (state) => {
    await upgradeFailing(state, { inject: failAt("verify", 1, true) }, { ok: false }, [FIRST.name, SECOND.name]);
    return [kernel(state, NEXT)];
  },
  "bookmark-failed": async (state) => {
    const failed = { ok: false, reason: "bookmark-failed" };
    const k = await upgradeFailing(state, { inject: failAt("bookmark", 1, false) }, failed, []);
    expect(marked(state.storage.sql)).toBe(false);
    return [k, kernel(state, NEXT)];
  },
  // The transaction that records the upgrade (its marker and bookmark) commits, and then reports a timeout.
  "bookmark-failed-recorded": async (state) => {
    const failed = { ok: false, reason: "bookmark-failed" };
    const k = await upgradeFailing(state, { transaction: timesOutAfter(state, marked) }, failed, []);
    expect(marked(state.storage.sql)).toBe(true);
    return [k, kernel(state, NEXT)];
  },
  // An attempt that overlaps one that finishes (the alarm and `kopje-admin upgrade retry`; nothing serializes them).
  "bookmark-failed-overlapping": (state) => overlapping(state, {}, { ok: true }),
  "bookmark-failed-overlapping-verify-failed": (state) =>
    overlapping(state, { inject: failAt("verify", 1, false) }, { ok: false, reason: "verify-failed" }),
  "upgrade-failed-unapplied": async (state) => {
    const failed = { ok: false, reason: "upgrade-failed" };
    return [
      await upgradeFailing(state, { inject: failAt("apply", 2, false) }, failed, [FIRST.name]),
      kernel(state, NEXT),
    ];
  },
  // The last file's transaction is durable, but reports an error (a timeout after the commit).
  "upgrade-failed-applied": async (state) => {
    const transaction = timesOutAfter(state, (sql) => newFiles(sql).includes(SECOND.name));
    const failed = { ok: false, reason: "upgrade-failed" };
    return [await upgradeFailing(state, { transaction }, failed, [FIRST.name, SECOND.name]), kernel(state, NEXT)];
  },
  // The hold is written, then reading the state back fails once: the isolate keeps its conservative fallback (every
  // file pending, no marker) until it ends, while a new isolate reads what is stored.
  "upgrade-failed-unread": async (state) => {
    let armed = false;
    const sql = new Proxy(state.storage.sql, {
      get: (target, key) =>
        key !== "exec"
          ? member(target, key)
          : (query: string, ...bindings: SqlStorageValue[]) => {
              if (armed && query.startsWith("SELECT value FROM kopje_state")) {
                armed = false;
                throw new Error("storage unavailable");
              }
              return target.exec(query, ...bindings);
            },
    });
    const inject = (at: UpgradePhase | "hold") => {
      armed ||= at === "hold";
      failAt("apply", 1, false)(at);
    };
    const failed = { ok: false, reason: "upgrade-failed" };
    const k = await upgradeFailing(overriding(state, { sql }), { inject }, failed, []);
    expect(armed).toBe(false);
    const stored = await observe(kernel(state, NEXT), state.storage.sql);
    expect(stored.key).toEqual(keyOf(example("upgrade-failed-unapplied")));
    return [k];
  },
  "verify-failed": async (state) => {
    const failed = { ok: false, reason: "verify-failed" };
    const k = await upgradeFailing(state, { inject: failAt("verify", 1, false) }, failed, [FIRST.name, SECOND.name]);
    expect(marked(state.storage.sql)).toBe(true);
    return [k, kernel(state, NEXT)];
  },
  // The transaction that verifies and clears the marker commits, and then reports a timeout.
  "verify-failed-recorded": async (state) => {
    const transaction = timesOutAfter(state, (sql) => newFiles(sql).includes(SECOND.name) && !marked(sql));
    const failed = { ok: false, reason: "verify-failed" };
    const k = await upgradeFailing(state, { transaction }, failed, [FIRST.name, SECOND.name]);
    expect(marked(state.storage.sql)).toBe(false);
    return [k, kernel(state, NEXT)];
  },
  // The code rolled back across a finished upgrade: the Store has files the older build does not ship.
  diverged: async (state) => {
    await upgradeFailing(state, {}, { ok: true }, [FIRST.name, SECOND.name]);
    return rolledBack(state);
  },
  // The code rolled back across an upgrade whose invocation ended after the first file committed: the marker stays.
  "diverged-unfinished": async (state) => {
    await upgradeFailing(state, { inject: failAt("apply", 2, true) }, { ok: false }, [FIRST.name]);
    expect(marked(state.storage.sql)).toBe(true);
    return rolledBack(state);
  },
  upgraded: async (state) => [
    await upgradeFailing(state, {}, { ok: true }, [FIRST.name, SECOND.name]),
    kernel(state, NEXT),
  ],
};

// Two attempts on one kernel: the first runs to its end (with `first`'s options, giving `result`) while the second awaits
// its bookmark, which then fails, so the second's hold lands on the schema the first left.
async function overlapping(
  state: DurableObjectState,
  first: Partial<KernelOptions>,
  result: object,
): Promise<StoreKernel[]> {
  const asked = [deferred(), deferred()];
  const release = deferred();
  const refuse = deferred<string>();
  let calls = 0;
  const getCurrentBookmark = async () => {
    const n = calls++;
    asked[n]!.resolve();
    if (n > 0) {
      return refuse.promise;
    }
    await release.promise;
    return state.storage.getCurrentBookmark();
  };
  const k = kernel(overriding(state, { getCurrentBookmark }), NEXT, first);
  const earlier = k.upgrade();
  await asked[0]!.promise;
  const later = k.upgrade();
  await asked[1]!.promise;
  release.resolve();
  expect(await earlier).toMatchObject(result);
  refuse.reject(new Error("bookmark unavailable"));
  expect(await later).toMatchObject({ ok: false, reason: "bookmark-failed" });
  return [k, kernel(state, NEXT)];
}

// The older build's kernel once its alarm ran the upgrade, which changes nothing while the schema has files the build
// does not ship, and a fresh one.
async function rolledBack(state: DurableObjectState): Promise<StoreKernel[]> {
  const older = kernel(state, MIGRATIONS, { build: OLDER_BUILD });
  expect(await older.upgrade()).toMatchObject({ ok: false, reason: "schema-diverged" });
  return [older, kernel(state, MIGRATIONS, { build: OLDER_BUILD })];
}

// A migrated Store whose alarm is set an hour ahead: a kernel that finds the upgrade unfinished schedules one only
// when none is set, so no alarm upgrades the Store while a test holds it in a phase. Cleared after the test.
const created: StoreStub[] = [];
async function phaseStore(): Promise<StoreStub> {
  const store = await migratedStore();
  created.push(store);
  await runInDurableObject(store, (_instance, state) => state.storage.setAlarm(Date.now() + 3_600_000));
  return store;
}
afterEach(async () => {
  for (const store of created.splice(0)) {
    await runInDurableObject(store, (_instance, state) => state.storage.deleteAlarm());
  }
});

// Each schema status, by the migrations a kernel of a migrated Store expects.
const EXPECTING: Record<Status, readonly Migration[]> = {
  current: MIGRATIONS,
  pending: NEXT,
  diverged: MIGRATIONS.slice(0, -1),
};

describe("what the Store admits in every state its health can report", () => {
  it("matches each combination of schema status, hold and marker to one rule, and admits what it says", async () => {
    const store = await phaseStore();
    await runInDurableObject(store, async (_instance, state) => {
      const sql = state.storage.sql;
      const seen: Key[] = [];
      for (const schema of Object.keys(EXPECTING) as Status[]) {
        for (const hold of [null, ...MAINTENANCE_REASONS]) {
          for (const upgrading of [false, true]) {
            sql.exec("DELETE FROM kopje_state WHERE name IN ('hold', 'upgrade')");
            if (hold !== null) {
              const value = JSON.stringify({ reason: hold, build: BUILD, detail: "seeded", at: 0 });
              sql.exec("INSERT INTO kopje_state (name, value) VALUES ('hold', ?)", value);
            }
            if (upgrading) {
              const value = JSON.stringify({ build: BUILD, bookmark: "seeded", at: 0 });
              sql.exec("INSERT INTO kopje_state (name, value) VALUES ('upgrade', ?)", value);
            }
            const key = { schema, hold, upgrading };
            const observed = await observe(kernel(state, EXPECTING[schema]), sql);
            expect(observed.key).toEqual(key);
            expect(observed.admits, JSON.stringify(key)).toEqual(ruled(key));
            seen.push(key);
          }
        }
      }
      expect(seen).toHaveLength(3 * (MAINTENANCE_REASONS.length + 1) * 2);
    });
  });
});

describe("how a Store reaches each example", () => {
  it("builds every example of the fixture", () => {
    expect(Object.keys(BUILDERS)).toEqual(EXAMPLES.map((e) => e.id));
  });

  it.each(EXAMPLES.map((e) => [e.id, e] as const))("%s", async (id, expected) => {
    const store = await phaseStore();
    await runInDurableObject(store, async (_instance, state) => {
      const views = await BUILDERS[id]!(state);
      for (const view of views) {
        const observed = await observe(view, state.storage.sql);
        expect(observed.key).toEqual(keyOf(expected));
        expect(observed.admits).toEqual(ruled(observed.key));
      }
    });
  });
});

describe("the upgrade's own invocation", () => {
  // What a request sees of the schema: how many files are recorded, and which of the new files' tables exist.
  const schemaRead = readOperation<void, { recorded: number; tables: string[] }>((db) => ({
    recorded: db.first<{ n: number }>("SELECT count(*) AS n FROM kopje_migrations")?.n ?? 0,
    tables: db
      .all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('phase_first', 'phase_second') ORDER BY name",
      )
      .map((t) => t.name),
  }));

  it("refuses while the bookmark is awaited, and a request that arrives as it applies or verifies waits for the end", async () => {
    const pending = example("pending");
    const store = await phaseStore();
    await runInDurableObject(store, async (_instance, state) => {
      // The kernel's storage, whose bookmark is held until released.
      const requested = deferred();
      const release = deferred();
      const held = overriding(state, {
        getCurrentBookmark: async () => {
          requested.resolve();
          await release.promise;
          return state.storage.getCurrentBookmark();
        },
      });

      // A request arrives inside each file's transaction and inside verification's: it starts there, and goes on
      // when the upgrade next yields.
      const arrivals: Promise<{ recorded: number; tables: string[] }>[] = [];
      const k: StoreKernel = kernel(held, NEXT, {
        inject: (at) => {
          if (at === "apply" || at === "verify") {
            arrivals.push(k.execute(BUILD, schemaRead, undefined));
          }
        },
      });
      const upgrading = k.upgrade();
      await requested.promise;
      // The upgrade yields while it awaits the bookmark: a request meets the pending example's state.
      const observed = await observe(k, state.storage.sql);
      expect(observed.key).toEqual(keyOf(pending));
      expect(observed.admits).toEqual(ruled(observed.key));

      release.resolve();
      expect(await upgrading).toMatchObject({ ok: true, applied: [FIRST.name, SECOND.name] });
      expect(arrivals).toHaveLength(3);
      for (const arrival of arrivals) {
        expect(await arrival).toEqual({ recorded: NEXT.length, tables: ["phase_first", "phase_second"] });
      }
    });
  });
});
