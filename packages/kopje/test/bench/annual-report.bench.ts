import { runInDurableObject } from "cloudflare:test";
import { expect, inject, it } from "vitest";

import {
  annualReportState,
  archetypeOf,
  generateAnnualReport,
  REPORT_FOLLOWERS,
  REPORT_HASHTAG_BYTES,
  REPORT_HASHTAG_USES,
  REPORT_TAG_CANDIDATES,
  REPORT_YEAR_STATUSES,
} from "../../src/domain/annual-reports";
import { sha256Hex } from "../../src/security/tokens";
import { buildWitness, IN_CAMPAIGN, YEAR } from "../annual-report-fixtures";
import { GENERATE_STATEMENTS, namedStatements, STATE_STATEMENTS } from "../annual-report-statements";
import { apiHarness, seedAccount, sql } from "../api-helpers";
import { NOW } from "../app-helpers";
import { measuredStatements, scopedToken } from "../read-helpers";

// The annual report cost benchmark (RES-7; the caps of src/domain/annual-reports.ts are chosen with it): `state` and
// `generate` for the campaign year on the all-caps witness (test/annual-report-fixtures.ts buildWitness, the
// admissible hashtag ranked REPORT_TAG_CANDIDATES-th, every statement on its slowest path), in a Store whose tables
// those statements read are populated as test/bench/migration-cost.ts populates them (scaled by KOPJE_BENCH_SCALE):
// 1,000,000 accounts, 3,000,000 accepted follows (three per account), 2,000,000 statuses of the remote accounts in
// turn, every other one a reply, each with a hashtag of 1,000 names. Statistics are taken before the witness is built,
// so they are older than the data, as on a Store that grew since its last ANALYZE.
//
// SAMPLES samples on a Store in the same state: no report exists when one starts (the previous sample's is deleted,
// untimed). Each times `state` (asserting `eligible` and the slowest-path reads of C1 to C4, so it cannot be timing
// `available` or an early stop) and then `generate` (asserting the report it wrote and the slowest-path reads of G1 to
// G4, G3 returning REPORT_TAG_CANDIDATES rows). Each call runs the operation inside the Store through
// measuredStatements, the same recording in every sample and candidate, timed around it. The bench prints each sample,
// the medians and their sum, the caps and the machine's load when the run started, and fails when the median `state`
// plus the median `generate` passes BUDGET_MS. Local wall time stands in for CPU time; it varies with the machine's
// load, so run `uptime` with it.
//
//   pnpm --filter kopje bench:annual-report          (vitest.annual-report-bench.config.ts)
//   KOPJE_BENCH_SCALE=0.01 pnpm --filter kopje bench:annual-report     a quick check of the script (not a measure)

const SAMPLES = 3;
const BUDGET_MS = 1_000;

declare module "vitest" {
  interface ProvidedContext {
    annualReportBenchScale: string;
    annualReportBenchLoad: string;
  }
}

const SHAPE = { accounts: 1_000_000, local: 20, domains: 1_000, follows: 3, statuses: 2_000_000, tagNames: 1_000 };

// The tables the year's statements read, in migration-cost.ts's shape, through its batch form.
function populate(storage: DurableObjectStorage, scale: number): void {
  const sqlStorage = storage.sql;
  // Numbers are bound as REAL by workerd, which SQLite's % keeps REAL: every number is cast to an integer first.
  const run = (query: string, ...params: SqlStorageValue[]) =>
    storage.transactionSync(() =>
      sqlStorage
        .exec(
          query.replace(/\?(\d)/g, (_, n: string) =>
            typeof params[Number(n) - 1] === "number" ? `CAST(?${n} AS INTEGER)` : `?${n}`,
          ),
          ...params,
        )
        .toArray(),
    );
  const now = "2026-10-01T00:00:00.000Z";
  const accounts = Math.round(SHAPE.accounts * scale);
  const statuses = Math.round(SHAPE.statuses * scale);
  const remote = accounts - SHAPE.local;
  run(
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
		INSERT INTO accounts (id, uri, username, domain, display_name, inbox_url, shared_inbox_url, created_at)
		SELECT CAST(100000000000000000 + i AS TEXT),
			CASE WHEN i < ?2 THEN 'https://kopje.bench/ap/users/l' || i ELSE 'https://d' || (i % ?3) || '.bench/users/u' || i END,
			CASE WHEN i < ?2 THEN 'l' || i ELSE 'u' || i END,
			CASE WHEN i < ?2 THEN NULL ELSE 'd' || (i % ?3) || '.bench' END,
			'Account ' || i,
			CASE WHEN i < ?2 THEN NULL ELSE 'https://d' || (i % ?3) || '.bench/users/u' || i || '/inbox' END,
			CASE WHEN i < ?2 THEN NULL ELSE 'https://d' || (i % ?3) || '.bench/inbox' END,
			?4
		FROM n`,
    accounts,
    SHAPE.local,
    SHAPE.domains,
    now,
  );
  // The bench's local accounts only: the harness's own already have their rows.
  run(
    `INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey)
		SELECT id, username || '@kopje.bench', X'00', X'00', 'k' FROM accounts
		WHERE domain IS NULL AND id >= '100000000000000000' AND id < ?1`,
    String(100000000000000000n + BigInt(SHAPE.local)),
  );
  for (let k = 1; k <= SHAPE.follows; k++) {
    run(
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
			INSERT INTO follows (account_id, target_account_id, state, created_at)
			SELECT CAST(100000000000000000 + i AS TEXT), CAST(100000000000000000 + (i + ?2) % ?1 AS TEXT), 'accepted', ?3
			FROM n`,
      accounts,
      k,
      now,
    );
  }
  const batch = 250_000;
  for (let start = 0; start < statuses; start += batch) {
    run(
      `WITH RECURSIVE n(i) AS (SELECT ?1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2 - 1)
			INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, created_at, in_reply_to_uri,
				in_reply_to_id)
			SELECT CAST(500000000000000000 + i AS TEXT), 'https://bench.example/s/' || i,
				CAST(100000000000000000 + ?3 + i % ?4 AS TEXT), 'public', '<p>status ' || i || '</p>', ?5, ?5,
				CASE WHEN i % 2 = 1 THEN 'https://bench.example/s/' || (i - 1) END,
				CASE WHEN i % 2 = 1 THEN CAST(500000000000000000 + i - 1 AS TEXT) END
			FROM n`,
      start,
      Math.min(start + batch, statuses),
      SHAPE.local,
      remote,
      now,
    );
    run(
      `WITH RECURSIVE n(i) AS (SELECT ?1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2 - 1)
			INSERT INTO status_tags (status_id, name, public)
			SELECT CAST(500000000000000000 + i AS TEXT), 'tag' || (i % ?3), 1 FROM n`,
      start,
      Math.min(start + batch, statuses),
      SHAPE.tagNames,
    );
  }
}

const median = (values: readonly number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

it("states and generates the all-caps witness's report within the budget", async () => {
  const scale = Number(inject("annualReportBenchScale") || "1");
  const h = await apiHarness();
  const alice = await seedAccount(h.store, { username: "alice", email: "alice@example.com" });
  const bob = await seedAccount(h.store, { username: "bob", email: "bob@example.com" });
  const tokenHash = await sha256Hex(await scopedToken(h, "read write"));
  await runInDurableObject(h.store, (_instance, state) => populate(state.storage, scale));
  await sql(h.store, "ANALYZE");
  const witness = await runInDurableObject(h.store, (_instance, state) =>
    buildWitness(state.storage.sql, alice, bob, "admissible-32nd"),
  );
  expect(witness.admissible).not.toBeNull();
  const expected = {
    archetype: archetypeOf(witness),
    statuses: witness.counted,
    followers: witness.followersInYear,
    top_status_id: witness.top,
    top_hashtag: witness.admissible,
    top_hashtag_uses: 2,
  };
  const input = (scope: string) => ({
    credential: { tokenHash, scope, now: NOW } as never,
    year: String(YEAR),
    storeNow: IN_CAMPAIGN,
  });
  // Date.now() moves only between I/O events: the clock is read across an await on each side.
  const timed = async <T>(call: () => Promise<T>): Promise<{ value: T; ms: number }> => {
    await scheduler.wait(1);
    const started = Date.now();
    const value = await call();
    await scheduler.wait(1);
    return { value, ms: Date.now() - started - 1 };
  };
  // Each statement on its slowest path (test/annual-report-statements.ts), in the order the operation runs them.
  const slowest = (statements: Parameters<typeof namedStatements>[0], names: readonly string[]) => {
    const named = namedStatements(statements);
    expect(named.map((s) => s.name)).toEqual(names);
    for (const s of named) {
      expect(s.rows, `${s.name} reads at least ${s.bound.min}`).toBeGreaterThanOrEqual(s.bound.min);
      expect(s.rows, `${s.name} reads at most ${s.bound.max}`).toBeLessThanOrEqual(s.bound.max);
    }
    return Object.fromEntries(named.map((s) => [s.name, s]));
  };
  const samples: { stateMs: number; generateMs: number; rows: Record<string, number> }[] = [];
  for (let sample = 0; sample < SAMPLES; sample++) {
    const state = await timed(() => measuredStatements(h, annualReportState, input("read:accounts")));
    expect(state.value.output).toEqual({ status: "ok", value: "eligible" });
    const stated = slowest(state.value.statements, STATE_STATEMENTS);
    const generated = await timed(() => measuredStatements(h, generateAnnualReport, input("write:accounts"), true));
    expect(generated.value.output).toEqual({ status: "ok", value: undefined });
    const made = slowest(generated.value.statements, GENERATE_STATEMENTS);
    expect(made.G3?.returned).toBe(REPORT_TAG_CANDIDATES);
    expect(
      await sql(
        h.store,
        "SELECT archetype, statuses, followers, top_status_id, top_hashtag, top_hashtag_uses FROM annual_reports",
      ),
    ).toEqual([expected]);
    await sql(h.store, "DELETE FROM annual_reports");
    samples.push({
      stateMs: state.ms,
      generateMs: generated.ms,
      rows: Object.fromEntries(
        [...Object.values(stated), ...Object.values(made)].map((s) => [s.name, s.rows] as const),
      ),
    });
  }
  const stateMs = median(samples.map((s) => s.stateMs));
  const generateMs = median(samples.map((s) => s.generateMs));
  console.log(
    JSON.stringify({
      annualReport: {
        caps: {
          REPORT_YEAR_STATUSES,
          REPORT_HASHTAG_USES,
          REPORT_HASHTAG_BYTES,
          REPORT_FOLLOWERS,
          REPORT_TAG_CANDIDATES,
        },
        scale,
        load: inject("annualReportBenchLoad"),
        samples,
        medianMs: { state: stateMs, generate: generateMs, sum: stateMs + generateMs },
      },
    }),
  );
  expect(stateMs + generateMs).toBeLessThanOrEqual(BUDGET_MS);
});
