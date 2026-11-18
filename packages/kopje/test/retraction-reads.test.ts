import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { completeItemChecks } from "../src/domain/collection-checks";
import { runInboundJobs } from "../src/domain/inbox";
import { SWEEP_BATCH } from "../src/domain/remote-actors";
import {
  canRetract,
  isDeleted,
  MAX_RETRACTIONS_PER_ACTOR,
  recordDeletedObject,
  RETRACTION_TTL_MS,
  retract,
  retractEdge,
} from "../src/domain/retractions";
import type { StoreStub } from "../src/platform/store-client";
import { sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { migratedStore } from "./helpers";
import { plannedRun, type SqlRow, staleStatistics, watchedCursor } from "./read-helpers";

// The reads of inbound_retractions under statistics older than its growth (RES-4's per-actor cap, RES-7; #1787): the
// cap's count reads only the counted actor's live entries, at most MAX_RETRACTIONS_PER_ACTOR, and every other
// statement on the table reads by its key, as many rows as it did on a small table.

const ACTOR = "https://a.example/users/a";
const OTHER = "https://b.example/users/b";
const LIVE = NOW + RETRACTION_TTL_MS;

// `count` retractions by `actor` of the ids `<actor>/<tag>/<from + i>`, expiring at `expires`.
async function seed(store: StoreStub, actor: string, tag: string, from: number, count: number, expires: number) {
  await sql(
    store,
    `WITH RECURSIVE n(i) AS (SELECT ?3 UNION ALL SELECT i + 1 FROM n WHERE i < ?3 + ?4 - 1)
		INSERT INTO inbound_retractions (actor_uri, target_uri, expires_at)
		SELECT ?1, ?1 || '/' || ?2 || '/' || i, ?5 FROM n WHERE ?4 > 0`,
    actor,
    tag,
    from,
    count,
    expires,
  );
}

const live = async (store: StoreStub, actor: string) =>
  (
    await sql<{ n: number }>(
      store,
      "SELECT count(*) AS n FROM inbound_retractions WHERE actor_uri = ? AND expires_at > ?",
      actor,
      NOW,
    )
  )[0]!.n;

type Traced = { query: string; plan: string[]; rows: number; returned: SqlRow[] };

// Runs `fn` on a Db whose statements on inbound_retractions are each recorded with their plan (taken before they run),
// the rows they read and the rows they returned.
async function traced<T>(store: StoreStub, fn: (db: Db) => T): Promise<{ result: T; statements: Traced[] }> {
  return runInDurableObject(store, (_instance, state) => {
    const real = state.storage.sql;
    const statements: Traced[] = [];
    const tracing = {
      exec: (query: string, ...params: SqlStorageValue[]) => {
        if (!query.includes("inbound_retractions")) {
          return real.exec(query, ...params);
        }
        const plan = real
          .exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, ...params)
          .toArray()
          .map((row) => row.detail);
        const cursor = real.exec<SqlRow>(query, ...params);
        const entry: Traced = { query, plan, rows: 0, returned: [] };
        statements.push(entry);
        return watchedCursor(
          cursor,
          () => (entry.rows = cursor.rowsRead),
          (rows) => (entry.returned = rows),
        );
      },
    } as unknown as SqlStorage;
    const db = new Db(tracing, (inner) => state.storage.transactionSync(inner));
    return { result: state.storage.transactionSync(() => fn(db)), statements };
  });
}

// The cap's count among `statements`: its plan's details on inbound_retractions, the rows it read and the count.
function countOf(statements: readonly Traced[]) {
  const counts = statements.filter((s) => s.query.includes("count(*)"));
  expect(counts).toHaveLength(1);
  const [count] = counts;
  return {
    plan: count!.plan.filter((detail) => detail.includes("inbound_retractions")),
    rows: count!.rows,
    n: count!.returned[0]?.n,
  };
}

const RANGE = [
  "SEARCH inbound_retractions USING COVERING INDEX inbound_retractions_actor_expires (actor_uri=? AND expires_at>?)",
];
const KEY = ["SEARCH inbound_retractions USING PRIMARY KEY (actor_uri=? AND target_uri=?)"];

describe("the retraction cap's count (#1787)", () => {
  it("reads only the actor's live range, the statistics taken over 200 rows of that actor alone", async () => {
    const store = await migratedStore();
    await seed(store, ACTOR, "early", 0, 200, LIVE);
    const fresh = `${ACTOR}/statuses/fresh`;
    const capture = () => traced(store, (db) => canRetract(db, ACTOR, [fresh], NOW));
    const { before, after } = await staleStatistics(
      { store },
      {
        capture,
        grow: async () => {
          await seed(store, OTHER, "other", 0, 100_000, LIVE);
          await seed(store, ACTOR, "late", 0, 4_800, LIVE);
          // Expired, not swept yet: outside the live range the count reads.
          await seed(store, ACTOR, "expired", 0, 1_000, NOW - 1);
        },
      },
    );
    expect(await live(store, ACTOR)).toBe(5_000);
    expect(await live(store, OTHER)).toBe(100_000);
    // The statistics are those of the small table: one actor, 200 rows.
    expect(await sql(store, "SELECT stat FROM sqlite_stat1 WHERE idx = 'inbound_retractions'")).toEqual([
      { stat: "200 200 1" },
    ]);
    const phases = [
      ["before", before, 200],
      ["after", after, 5_000],
    ] as const;
    for (const [phase, run, n] of phases) {
      expect([phase, run.result, countOf(run.statements).n]).toEqual([phase, true, n]);
      // The live range and the read that finds its end.
      expect(countOf(run.statements).rows, phase).toBeLessThanOrEqual(n + 1);
    }
    for (const [phase, run] of phases) {
      expect([phase, countOf(run.statements).plan]).toEqual([phase, RANGE]);
      const probe = run.statements.find((s) => s.query.includes("target_uri = ?"));
      expect([phase, probe?.plan, probe!.rows]).toEqual([phase, KEY, 0]);
    }
  }, 60_000);

  it("reads at most MAX_RETRACTIONS_PER_ACTOR entries at the cap and past it, deciding as the whole count", async () => {
    const store = await migratedStore();
    await seed(store, ACTOR, "early", 0, 200, LIVE);
    await sql(store, "ANALYZE");
    await seed(store, OTHER, "other", 0, 100_000, LIVE);
    await seed(store, ACTOR, "late", 0, MAX_RETRACTIONS_PER_ACTOR - 200 - 2, LIVE);
    await seed(store, ACTOR, "expired", 0, 1_000, NOW - 1);
    const one = [`${ACTOR}/statuses/one`];
    const two = [...one, `${ACTOR}/statuses/two`];
    // From MAX_RETRACTIONS_PER_ACTOR - 2 live entries to 5,000 past the cap (as an import may hold): one row more each
    // step around the cap, then the rest at once.
    let next = 0;
    const seen: unknown[] = [];
    for (const add of [0, 1, 1, 1, 1, 4_998]) {
      await seed(store, ACTOR, "more", next, add, LIVE);
      next += add;
      const whole = await live(store, ACTOR);
      for (const targets of [one, two]) {
        const run = await traced(store, (db) => canRetract(db, ACTOR, targets, NOW));
        const count = countOf(run.statements);
        // As main's count, which read every live entry: the decision of the whole count.
        expect([whole, targets.length, run.result]).toEqual([
          whole,
          targets.length,
          whole + targets.length <= MAX_RETRACTIONS_PER_ACTOR,
        ]);
        expect([whole, count.n]).toEqual([whole, Math.min(whole, MAX_RETRACTIONS_PER_ACTOR)]);
        expect(count.rows, `${whole}`).toBeLessThanOrEqual(MAX_RETRACTIONS_PER_ACTOR);
        expect([whole, count.plan]).toEqual([whole, RANGE]);
        seen.push([whole, targets.length, run.result]);
      }
    }
    // The steps crossed the cap: refused with room for one, then for none, then at 5,000 past it.
    expect(seen).toEqual([
      [MAX_RETRACTIONS_PER_ACTOR - 2, 1, true],
      [MAX_RETRACTIONS_PER_ACTOR - 2, 2, true],
      [MAX_RETRACTIONS_PER_ACTOR - 1, 1, true],
      [MAX_RETRACTIONS_PER_ACTOR - 1, 2, false],
      [MAX_RETRACTIONS_PER_ACTOR, 1, false],
      [MAX_RETRACTIONS_PER_ACTOR, 2, false],
      [MAX_RETRACTIONS_PER_ACTOR + 1, 1, false],
      [MAX_RETRACTIONS_PER_ACTOR + 1, 2, false],
      [MAX_RETRACTIONS_PER_ACTOR + 2, 1, false],
      [MAX_RETRACTIONS_PER_ACTOR + 2, 2, false],
      [MAX_RETRACTIONS_PER_ACTOR + 5_000, 1, false],
      [MAX_RETRACTIONS_PER_ACTOR + 5_000, 2, false],
    ]);
  }, 60_000);

  it("keeps every other statement on inbound_retractions on its key, as many rows as on the small table", async () => {
    const store = await migratedStore();
    await seed(store, ACTOR, "early", 0, 200, LIVE);
    // As many expired rows as one sweep removes, in each phase.
    await seed(store, ACTOR, "expired-before", 0, SWEEP_BATCH, NOW - 1);
    const edge = { table: "follows", id: "1" } as const;
    // Each reader and writer of the table but the count, on ids of its phase: the probes (isDeleted's two, the edge's),
    // the writes (retract's insert, recordDeletedObject's, retractEdge's), the sweep (runInboundJobs) and the collection
    // check's join (completeItemChecks, planned before it runs).
    const capture = async (phase: string) => {
      const target = `${ACTOR}/statuses/${phase}`;
      const probes = await traced(store, (db) => {
        isDeleted(db, ACTOR, target, NOW);
        canRetract(db, ACTOR, [], NOW, edge);
        retract(db, ACTOR, target, NOW);
        recordDeletedObject(db, target, NOW);
        retractEdge(db, ACTOR, edge, NOW);
        return null;
      });
      const sweep = await plannedRun({ store }, /inbound_retractions/, runInboundJobs, { now: NOW }, true);
      const check = await plannedRun(
        { store },
        /inbound_retractions/,
        completeItemChecks,
        { now: NOW, results: [{ item: "1", token: "t", outcome: "match" }] },
        true,
      );
      return [...probes.statements, ...sweep.plans, ...check.plans]
        .filter(({ query }) => !query.startsWith("SELECT count(*)"))
        .map(({ query, plan, rows }) => ({
          query: query.replace(/\s+/g, " ").slice(0, 40),
          // Its reads of inbound_retractions (r in the collection check).
          plan: plan.filter((detail) => /^(SEARCH|SCAN) (inbound_retractions|r) /.test(detail)),
          rows,
        }));
    };
    const { before, after } = await staleStatistics(
      { store },
      {
        capture,
        grow: async () => {
          await seed(store, OTHER, "other", 0, 100_000, LIVE);
          await seed(store, ACTOR, "late", 0, 4_800, LIVE);
          await seed(store, ACTOR, "expired-after", 0, SWEEP_BATCH, NOW - 1);
        },
      },
    );
    expect(await live(store, OTHER)).toBe(100_000);
    // Each phase's sweep removed its expired rows.
    expect(await sql(store, "SELECT count(*) AS n FROM inbound_retractions WHERE expires_at <= ?", NOW)).toEqual([
      { n: 0 },
    ]);
    const walk = "SEARCH inbound_retractions USING COVERING INDEX inbound_retractions_expires (expires_at<?)";
    expect(before.map(({ plan, rows }) => ({ plan, rows }))).toEqual([
      // isDeleted: the actor's retraction, then any actor's.
      { plan: KEY, rows: 0 },
      { plan: KEY, rows: 0 },
      // The edge's probe, its uri read from the edge's row.
      { plan: KEY, rows: 1 },
      // retract: its probe, then its insert; recordDeletedObject's insert; retractEdge's insert, from the edge's row.
      { plan: KEY, rows: 0 },
      { plan: [], rows: 0 },
      { plan: [], rows: 0 },
      { plan: [], rows: 1 },
      // The sweep: one batch in expiry order, each deleted by its key.
      { plan: [...KEY, walk], rows: 4 * SWEEP_BATCH },
      // The collection check's join, by the member's uri and the candidate.
      { plan: ["SEARCH r USING PRIMARY KEY (actor_uri=? AND target_uri=?)"], rows: 0 },
    ]);
    expect(after).toEqual(before);
  }, 60_000);
});
