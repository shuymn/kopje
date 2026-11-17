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
import { type MaintenanceReason, toStoreUnavailable } from "../src/platform/store-errors";
import type {
  KernelOptions,
  Migration,
  OperationKind,
  StoreKernel,
  StoreOperation,
  UpgradePhase,
} from "../src/platform/store-kernel";
import fixture from "./fixtures/upgrade-phases.json";
import { BUILD, deferred, migratedStore, testKernel as kernel } from "./helpers";

// What the Store admits in each phase of an upgrade. test/fixtures/upgrade-phases.json lists the phases in order, and
// for each the reason every kind of operation is refused (null: admitted) and what health reports;
// test-node/upgrade-phases.test.ts holds docs/upgrade.md's table to the same file. Each phase a Store can be found in
// is built here by the upgrade itself, with a failure or a stop injected where the phase begins, and read by the
// kernel of a new isolate (and, for a hold, by the kernel that failed). The Store applies and verifies in one
// invocation, so a request that arrives meanwhile waits for it to end ("applying").

type Health = {
  schema: "current" | "pending" | "diverged";
  readonly: boolean;
  upgrading: boolean;
  hold: MaintenanceReason | null;
};
type Admissions = { refusals: Record<OperationKind, MaintenanceReason | null>; health: Health };
type Phase = { id: string; label: string } & ({ waits: true } | ({ waits: false } & Admissions));

const PHASES = fixture as unknown as readonly Phase[];
const DURABLE = PHASES.filter((p): p is Phase & { waits: false } => !p.waits);

function phase(id: string): Phase {
  const found = PHASES.find((p) => p.id === id);
  if (found === undefined) {
    throw new Error(`no phase ${id} in the fixture`);
  }
  return found;
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

// The reason the kernel refuses an operation of this kind, or null once the operation ran: the read answered the
// count, and a write left its row. A refused operation leaves none.
async function admission(k: StoreKernel, sql: SqlStorage, kind: OperationKind): Promise<MaintenanceReason | null> {
  const before = sql.exec<{ n: number }>("SELECT count(*) AS n FROM instance_settings").one().n;
  const after = () => sql.exec<{ n: number }>("SELECT count(*) AS n FROM instance_settings").one().n;
  try {
    const output = await k.execute(BUILD, OPERATIONS[kind], undefined);
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

async function observe(k: StoreKernel, sql: SqlStorage): Promise<Admissions> {
  const reported = await k.health(BUILD);
  const health = {
    schema: reported.schema.status,
    readonly: reported.readonly,
    upgrading: reported.upgrading,
    hold: reported.hold,
  };
  const refusals = {} as Admissions["refusals"];
  for (const kind of KINDS) {
    refusals[kind] = await admission(k, sql, kind);
  }
  return { refusals, health };
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

function newFiles(sql: SqlStorage): string[] {
  return sql
    .exec<{ name: string }>("SELECT name FROM kopje_migrations WHERE name >= ? ORDER BY name", FIRST.name)
    .toArray()
    .map((m) => m.name);
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

// Each durable phase, in the fixture's order: the kernels that read it once built.
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
    return [await upgradeFailing(state, { inject: failAt("bookmark", 1, false) }, failed, []), kernel(state, NEXT)];
  },
  "upgrade-failed-unapplied": async (state) => {
    const failed = { ok: false, reason: "upgrade-failed" };
    return [
      await upgradeFailing(state, { inject: failAt("apply", 2, false) }, failed, [FIRST.name]),
      kernel(state, NEXT),
    ];
  },
  // The last file's transaction is durable, but reports an error (a timeout after the commit).
  "upgrade-failed-applied": async (state) => {
    let thrown = false;
    const transaction = <T>(fn: () => T): T => {
      const value = state.storage.transactionSync(fn);
      if (!thrown && newFiles(state.storage.sql).includes(SECOND.name)) {
        thrown = true;
        throw new Error("Durable Object storage operation exceeded timeout");
      }
      return value;
    };
    const failed = { ok: false, reason: "upgrade-failed" };
    return [await upgradeFailing(state, { transaction }, failed, [FIRST.name, SECOND.name]), kernel(state, NEXT)];
  },
  "verify-failed": async (state) => {
    const failed = { ok: false, reason: "verify-failed" };
    return [
      await upgradeFailing(state, { inject: failAt("verify", 1, false) }, failed, [FIRST.name, SECOND.name]),
      kernel(state, NEXT),
    ];
  },
  // The code rolled back across the upgrade: the Store has files this build does not ship.
  diverged: async (state) => {
    await upgradeFailing(state, {}, { ok: true }, [FIRST.name, SECOND.name]);
    return [kernel(state, MIGRATIONS)];
  },
  upgraded: async (state) => [
    await upgradeFailing(state, {}, { ok: true }, [FIRST.name, SECOND.name]),
    kernel(state, NEXT),
  ],
};

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

describe("what the Store admits in each phase of an upgrade", () => {
  it("builds every phase of the fixture that a Store can be found in, and only the upgrade's own invocation waits", () => {
    expect(Object.keys(BUILDERS)).toEqual(DURABLE.map((p) => p.id));
    expect(PHASES.filter((p) => p.waits).map((p) => p.id)).toEqual(["applying"]);
  });

  it.each(DURABLE.map((p) => [p.id, p] as const))("%s", async (id, expected) => {
    const store = await phaseStore();
    await runInDurableObject(store, async (_instance, state) => {
      const views = await BUILDERS[id]!(state);
      for (const view of views) {
        expect(await observe(view, state.storage.sql)).toEqual({
          refusals: expected.refusals,
          health: expected.health,
        });
      }
    });
  });
});

// The member `key` of `target`, a method bound to it, so that a proxy can stand in for a platform object.
function member(target: object, key: string | symbol): unknown {
  const value: unknown = Reflect.get(target, key, target);
  return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
}

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
    const pending = phase("pending");
    expect(pending.waits).toBe(false);
    expect(phase("applying").waits).toBe(true);
    const store = await phaseStore();
    await runInDurableObject(store, async (_instance, state) => {
      // The kernel's storage, whose bookmark is held until released.
      const requested = deferred();
      const release = deferred();
      const storage = new Proxy(state.storage, {
        get(target, key) {
          if (key === "getCurrentBookmark") {
            return async () => {
              requested.resolve();
              await release.promise;
              return target.getCurrentBookmark();
            };
          }
          return member(target, key);
        },
      });
      const held = new Proxy(state, {
        get(target, key) {
          if (key === "storage") {
            return storage;
          }
          return member(target, key);
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
      // The upgrade yields while it awaits the bookmark: a request meets the pending phase.
      if (!pending.waits) {
        expect(await observe(k, state.storage.sql)).toEqual({ refusals: pending.refusals, health: pending.health });
      }

      release.resolve();
      expect(await upgrading).toMatchObject({ ok: true, applied: [FIRST.name, SECOND.name] });
      expect(arrivals).toHaveLength(3);
      for (const arrival of arrivals) {
        expect(await arrival).toEqual({ recorded: NEXT.length, tables: ["phase_first", "phase_second"] });
      }
    });
  });
});
