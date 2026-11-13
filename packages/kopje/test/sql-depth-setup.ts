import { env } from "cloudflare:workers";
import { afterAll, expect, inject } from "vitest";

import { MIGRATIONS } from "../src/db/migrations";
import { Db } from "../src/db/sql";
import {
  type AuditedStatement,
  auditDecision,
  bindsPattern,
  callerFrames,
  type PlannedSample,
  type PlanSchema,
  planSignatures,
  sampleKey,
  statementId,
} from "./plan-audit";
import { PLAN_AUDIT_ALLOWANCES } from "./plan-audit-allowances";
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

// A statement as the suite ran it: up to MAX_SAMPLES distinct samples of its parameters (the first runs of the domain
// code that differ; a test's own bindings take no slot), whether the domain code ran it (callerFrames, in any of its runs), whether its depth is measured, and
// up to MAX_SITES of the call chains it ran from. The depth is measured for what the domain code ran and for what a
// test ran through all or run; a test's own iterate reads tables of its own (test/status-rows.test.ts).
export type Recorded = { samples: SqlStorageValue[][]; production: boolean; measured: boolean; sites: string[] };

export const statements = new Map<string, Recorded>();

// As test-node/sql-depth.ts reports one.
export type DeepStatement = { depth: number; sql: string };

const MAX_SITES = 3;
// A bound value changes a plan through a partial index's condition (test/plan-audit.test.ts); values the suites never
// pass are not planned.
const MAX_SAMPLES = 3;
// Frames kept from the caller of Db on: enough to name the builder of a statement a shared reader runs (SQL composed
// in timelines.ts, run by audience.ts).
const SITE_FRAMES = 5;
const STACK_FRAMES = SITE_FRAMES + 8;

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
  const key = seen === undefined || seen.samples.length >= MAX_SAMPLES ? undefined : sampleKey(params);
  const newSample = seen === undefined || (key !== undefined && !seen.samples.some((s) => sampleKey(s) === key));
  const newSite = !(seen?.production === true && (seen.sites.length >= MAX_SITES || (looks.get(query) ?? 0) >= LOOKS));
  if (!newSample && !newSite) {
    return;
  }
  const { frames, production } = callerFrames((call ?? capture()).stack ?? "");
  const measured = production || call === undefined;
  const site = frames.slice(0, SITE_FRAMES).join(" < ");
  if (seen === undefined) {
    statements.set(query, { samples: production ? [params] : [], production, measured, sites: [site] });
    return;
  }
  if (production && newSample) {
    seen.samples.push(params);
  }
  if (!newSite) {
    return;
  }
  seen.measured ||= measured;
  if (production && !seen.production) {
    // The domain code's chain first: the one a failure names.
    seen.production = true;
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

// Each identity's plan and violations for each sample of its parameters, kept for the worker's later suites: a plan
// depends on the schema, the statistics and the bound values only (no STAT4, test/plan-audit.test.ts), so it is the
// same in every suite of a run. The cache, and the audit Store it plans on, are scoped to the run and to the migrations.
type PlanCache = {
  scope: string;
  store: ReturnType<typeof auditStore> | undefined;
  ids: Map<string, string>;
  plans: Map<string, PlannedSample>;
};
const PLAN_CACHE = Symbol.for("kopje.plan-audit.cache");

async function planCache(): Promise<PlanCache> {
  const scope = `${inject("planAuditRun")} ${await statementId(MIGRATIONS.map((m) => `${m.name}\n${m.sql}`).join("\n"))}`;
  const holder = globalThis as { [PLAN_CACHE]?: PlanCache };
  if (holder[PLAN_CACHE]?.scope !== scope) {
    holder[PLAN_CACHE] = { scope, store: undefined, ids: new Map(), plans: new Map() };
  }
  return holder[PLAN_CACHE];
}

// `queries` planned on the worker's audit Store, made again once if making it failed or the pool restarted it (the pool
// restarts a Durable Object whose module graph a later suite reloaded, and its error asks for a retry).
async function planOnAuditStore(
  cache: PlanCache,
  queries: { sql: string; params: SqlStorageValue[] }[],
): Promise<{ schema: PlanSchema; planned: PlannedOrRefused[] }> {
  for (let attempt = 0; ; attempt++) {
    const pending = (cache.store ??= auditStore());
    try {
      const store = await pending;
      return { schema: store.schema, planned: await store.plan(queries) };
    } catch (error) {
      if (cache.store === pending) {
        cache.store = undefined;
      }
      if (attempt > 0) {
        throw error;
      }
    }
  }
}

// The plan audit's failures for the statements of `recorded` the domain code ran, and its advice on listed scans the
// suite did not show (auditDecision).
export async function auditPlans(
  recorded: ReadonlyMap<string, Recorded>,
): Promise<{ failures: string[]; unseen: string[] }> {
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
  const keyOf = (sql: string, params: readonly unknown[]) => `${cache.ids.get(sql)!} ${sampleKey(params)}`;
  const unplanned = new Map<string, { sql: string; params: SqlStorageValue[] }>();
  for (const [sql, seen] of production) {
    for (const params of seen.samples) {
      const key = keyOf(sql, params);
      if (!cache.plans.has(key)) {
        unplanned.set(key, { sql, params });
      }
    }
  }
  if (unplanned.size > 0) {
    const { schema, planned } = await planOnAuditStore(cache, [...unplanned.values()]);
    [...unplanned].forEach(([key, { sql, params }], n) => {
      const { plan, error } = planned[n]!;
      const violations = error === undefined ? planSignatures(sql, plan, schema) : [];
      cache.plans.set(key, { params, plan, violations, ...(error === undefined ? {} : { error }) });
    });
  }
  const audited: AuditedStatement[] = production.map(([sql, seen]) => ({
    id: cache.ids.get(sql)!,
    sql,
    sites: seen.sites,
    samples: seen.samples.map((params) => cache.plans.get(keyOf(sql, params))!),
  }));
  const decision = auditDecision(audited, PLAN_AUDIT_ENTRIES, PLAN_AUDIT_ALLOWANCES);
  return { failures: [...failures, ...decision.failures], unseen: decision.unseen };
}

// The first suite of a worker migrates the audit Store and plans every statement it ran; on a loaded machine that
// passes the default 10 s.
const AUDIT_TIMEOUT_MS = 120_000;

afterAll(async () => {
  expect(await measure([...statements].filter(([, seen]) => seen.measured).map(([sql]) => sql))).toEqual([]);
  const { failures, unseen } = await auditPlans(statements);
  if (unseen.length > 0) {
    console.log(unseen.join("\n"));
  }
  if (failures.length > 0) {
    throw new Error(failures.join("\n\n"));
  }
}, AUDIT_TIMEOUT_MS);
