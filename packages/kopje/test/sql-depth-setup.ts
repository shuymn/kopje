import { env } from "cloudflare:workers";
import { afterAll, expect, inject } from "vitest";

import { MIGRATIONS } from "../src/db/migrations";
import { Db } from "../src/db/sql";
import { type AuditedStatement, auditFailures, bindsPattern, planSignatures, statementId } from "./plan-audit";
import { PLAN_AUDIT_ENTRIES } from "./plan-audit-entries";
import { auditStore, type PlannedOrRefused } from "./plan-audit-store";

// Setup of every Workers suite (vitest.config.ts, vitest.streaming.config.ts): records each distinct statement the
// suite runs through Db, in the Store or in a test, and after the suite has its expression depth measured on Node
// (test-node/sql-depth.ts) and the plan of each statement the domain code ran audited (test/plan-audit.ts). Db is where
// the domain code, and the policy fragments it composes (src/domain/audience.ts), run their SQL; the Store kernel's
// migrations and the dump, import and backup statements run on SqlStorage directly, as fixed or catalog-generated text
// without such nesting.

declare module "vitest" {
  interface ProvidedContext {
    // Changes on each run and each watch rerun (test-node/plan-audit-run.ts): the plan cache's scope.
    planAuditRun: string;
  }
}

// A statement as the suite ran it: the parameters of its first run (of the domain code's first, once it ran it),
// whether the domain code ran it (the caller of Db is under src/ in any of its runs), whether its depth is measured,
// and up to MAX_SITES of the call chains it ran from. The depth is measured for what the domain code ran and for what
// a test ran through all or run; a test's own iterate reads tables of its own (test/status-rows.test.ts).
export type Recorded = { params: SqlStorageValue[]; production: boolean; measured: boolean; sites: string[] };

export const statements = new Map<string, Recorded>();

// As test-node/sql-depth.ts reports one.
export type DeepStatement = { depth: number; sql: string };

const MAX_SITES = 3;
// Frames kept from the caller of Db on: enough to name the builder of a statement a shared reader runs (SQL composed
// in timelines.ts, run by audience.ts).
const SITE_FRAMES = 5;
const STACK_FRAMES = SITE_FRAMES + 8;

// Where the operations dispatch: a chain of callers ends there.
const DISPATCH = new Set(["src/domain/operation.ts", "src/platform/store-kernel.ts"]);

// The callers of a call into Db, innermost first, each as `file:line function` with the file relative to the package:
// the frames under src/ up to the operations' dispatch, or the one frame that called Db when no domain code did.
function callerFrames(stack: string): string[] {
  const frames: string[] = [];
  for (const line of stack.split("\n").slice(1)) {
    const frame = /^\s*at (?:(.*?) \()?(.*?):(\d+):\d+\)?$/.exec(line);
    const file = frame?.[2]?.replace(/^.*\/packages\/kopje\//, "") ?? line.trim();
    if (file === "test/sql-depth-setup.ts" || file === "src/db/sql.ts") {
      continue;
    }
    if (DISPATCH.has(file) || (frames.length > 0 && !file.startsWith("src/"))) {
      break;
    }
    frames.push(`${file}:${frame?.[3] ?? "?"} ${frame?.[1] ?? "<anonymous>"}`);
    if (!file.startsWith("src/")) {
      break;
    }
  }
  return frames;
}

// An error whose stack holds the STACK_FRAMES innermost frames of its caller.
function capture(): Error {
  const V8 = Error as ErrorConstructor & { stackTraceLimit: number };
  const limit = V8.stackTraceLimit;
  V8.stackTraceLimit = STACK_FRAMES;
  const error = new Error();
  V8.stackTraceLimit = limit;
  return error;
}

// Once the domain code is seen running a statement it stays production; the stacks of later runs are looked at only
// until MAX_SITES call chains are kept or LOOKS more runs found none new. A statement only tests ran is looked at on
// every run, so a later run from the domain code still classifies it.
const LOOKS = 20;
const looks = new Map<string, number>();

function record(query: string, params: SqlStorageValue[], call?: Error): void {
  const seen = statements.get(query);
  if (seen?.production === true && (seen.sites.length >= MAX_SITES || (looks.get(query) ?? 0) >= LOOKS)) {
    return;
  }
  const frames = callerFrames((call ?? capture()).stack ?? "");
  const production = frames[0]?.startsWith("src/") ?? false;
  const measured = production || call === undefined;
  const site = frames.slice(0, SITE_FRAMES).join(" < ");
  if (seen === undefined) {
    statements.set(query, { params, production, measured, sites: [site] });
    return;
  }
  seen.measured ||= measured;
  if (production && !seen.production) {
    // The domain code's chain first: the one a failure names.
    seen.production = true;
    seen.params = params;
    seen.sites = [site, ...seen.sites.filter((s) => s !== site)].slice(0, MAX_SITES);
  } else if (seen.sites.length < MAX_SITES && !seen.sites.includes(site)) {
    seen.sites.push(site);
  } else if (seen.production) {
    looks.set(query, (looks.get(query) ?? 0) + 1);
  }
}

// The suites run without isolation, so Db is loaded once per worker while this file runs again for each suite: Db is
// wrapped once, and each run points the wrapper at its own suite's recorder. iterate stays lazy: its statement is
// recorded, with the frames of its call, when the cursor first steps.
const recorder = Symbol.for("kopje.sql-depth.statements");
const prototype = Db.prototype as Db & { [recorder]?: typeof record };
if (prototype[recorder] === undefined) {
  // oxlint-disable-next-line typescript/unbound-method -- each is called back on the Db it was called on
  const { all, run, iterate } = prototype;
  prototype.all = function (this: Db, query: string, ...params: SqlStorageValue[]) {
    prototype[recorder]!(query, params);
    return all.call(this, query, ...params);
  } as typeof all;
  prototype.run = function (this: Db, query: string, ...params: SqlStorageValue[]) {
    prototype[recorder]!(query, params);
    return run.call(this, query, ...params);
  };
  prototype.iterate = function (this: Db, query: string, ...params: SqlStorageValue[]) {
    const rows = iterate.call(this, query, ...params);
    const call = capture();
    return (function* () {
      prototype[recorder]!(query, params, call);
      return yield* rows;
    })();
  } as typeof iterate;
}
prototype[recorder] = record;

export async function measure(sql: string[]): Promise<DeepStatement[]> {
  const service = (env as unknown as { SQL_DEPTH: Fetcher }).SQL_DEPTH;
  const response = await service.fetch("http://sql-depth/", { method: "POST", body: JSON.stringify(sql) });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json();
}

// Each identity's plan and violations, kept for the worker's later suites: a plan depends on the schema and the
// statistics only (no STAT4, test/plan-audit.test.ts; no bound LIKE or GLOB pattern, bindsPattern), so it is the same in
// every suite of a run. The cache, and the audit Store it plans on, are scoped to the run and to the migrations.
type PlanCache = {
  scope: string;
  store?: ReturnType<typeof auditStore>;
  ids: Map<string, string>;
  plans: Map<string, PlannedOrRefused & { violations: string[] }>;
};
const PLAN_CACHE = Symbol.for("kopje.plan-audit.cache");

async function planCache(): Promise<PlanCache> {
  const scope = `${inject("planAuditRun")} ${await statementId(MIGRATIONS.map((m) => `${m.name}\n${m.sql}`).join("\n"))}`;
  const holder = globalThis as { [PLAN_CACHE]?: PlanCache };
  if (holder[PLAN_CACHE]?.scope !== scope) {
    holder[PLAN_CACHE] = { scope, ids: new Map(), plans: new Map() };
  }
  return holder[PLAN_CACHE];
}

// The plan audit's failures for the statements of `recorded` the domain code ran.
export async function auditPlans(recorded: ReadonlyMap<string, Recorded>): Promise<string[]> {
  const cache = await planCache();
  const failures: string[] = [];
  const production = [...recorded].filter(([, seen]) => seen.production);
  for (const [sql, seen] of production) {
    if (!cache.ids.has(sql)) {
      cache.ids.set(sql, await statementId(sql));
    }
    if (bindsPattern(sql)) {
      failures.push(`plan audit: a LIKE or GLOB pattern takes a parameter (${seen.sites[0]})\n  sql: ${sql}`);
    }
  }
  const unplanned = new Map<string, { sql: string; params: SqlStorageValue[] }>();
  for (const [sql, seen] of production) {
    const id = cache.ids.get(sql)!;
    if (!cache.plans.has(id) && !unplanned.has(id)) {
      unplanned.set(id, { sql, params: seen.params });
    }
  }
  if (unplanned.size > 0) {
    let store = await (cache.store ??= auditStore());
    let planned: PlannedOrRefused[];
    try {
      planned = await store.plan([...unplanned.values()]);
    } catch (error) {
      // The pool restarts a Durable Object whose module graph a later suite reloaded; the worker's audit Store is then
      // gone, and a new one is made, as the error asks.
      if (!String(error).includes("invalidating this Durable Object")) {
        throw error;
      }
      store = await (cache.store = auditStore());
      planned = await store.plan([...unplanned.values()]);
    }
    [...unplanned].forEach(([id, { sql }], n) => {
      const result = planned[n]!;
      cache.plans.set(id, { ...result, violations: planSignatures(sql, result.plan, store.schema) });
    });
  }
  const audited: AuditedStatement[] = production.map(([sql, seen]) => {
    const id = cache.ids.get(sql)!;
    return { id, sql, params: seen.params, sites: seen.sites, ...cache.plans.get(id)! };
  });
  return [...failures, ...auditFailures(audited, PLAN_AUDIT_ENTRIES)];
}

// The first suite of a worker migrates the audit Store and plans every statement it ran; on a loaded machine that
// passes the default 10 s.
const AUDIT_TIMEOUT_MS = 120_000;

afterAll(async () => {
  expect(await measure([...statements].filter(([, seen]) => seen.measured).map(([sql]) => sql))).toEqual([]);
  const failures = await auditPlans(statements);
  if (failures.length > 0) {
    throw new Error(failures.join("\n\n"));
  }
}, AUDIT_TIMEOUT_MS);
