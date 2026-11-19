import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  ARCHETYPE_SQL,
  annualReports,
  annualReportState,
  archetypeOf,
  DISTRIBUTABLE_YEAR_SQL,
  FOLLOWERS_IN_YEAR_SQL,
  FOLLOWERS_SQL,
  generateAnnualReport,
  PENDING_REPORTS_SQL,
  REPORT_EXISTS_SQL,
  REPORT_FOLLOWERS,
  REPORT_HASHTAG_BYTES,
  REPORT_HASHTAG_USES,
  REPORT_JSON_BYTES,
  REPORT_TAG_CANDIDATES,
  REPORT_YEAR_STATUSES,
  REPORTS_LISTED,
  TAG_USES_SQL,
  TOP_HASHTAG_SQL,
  TOP_STATUS_SQL,
  YEAR_STATUSES_SQL,
} from "../src/domain/annual-reports";
import { jsonBytes, STATUS_ANSWER_BYTES } from "../src/domain/answer-budget";
import { TAG_NAME_BYTES } from "../src/domain/status-bounds";
import { TAG_NAME_JSON_BYTES } from "../src/domain/tag-bounds";
import { sha256Hex } from "../src/security/tokens";
import {
  buildWitness,
  IN_CAMPAIGN,
  idIn,
  insertAccounts,
  insertFollows,
  insertPost,
  type Witness,
  type WitnessVariant,
  YEAR,
  yearEnd,
} from "./annual-report-fixtures";
import { expectStatements, GENERATE_STATEMENTS, STATE_STATEMENTS } from "./annual-report-statements";
import { apiHarness, seedAccount, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { answer, bigStatus, expectStatusBudgetCut, statusBudgetEdge } from "./budget-helpers";
import { singletonStatistics } from "./plan-audit-store";
import { explainPlan, measuredStatements, scansOf, scopedToken } from "./read-helpers";

// The read ceiling of `state` and `generate` (RES-7), derived from the caps of src/domain/annual-reports.ts
// (test/annual-report-statements.ts: each statement's reads at most and on its slowest path), and held by the all-caps
// witness (test/annual-report-fixtures.ts buildWitness), in which every input the year's reads take is at its cap at
// once and every statement is on its slowest path:
//
//   input                                         constant               the witness
//   the owner's year rows (raw)                   REPORT_YEAR_STATUSES   = the cap, the only counted public one last
//   their tag rows (raw)                          REPORT_HASHTAG_USES    = the cap, all on counted rows, all grouped
//   those rows' name bytes                        REPORT_HASHTAG_BYTES   = the cap, over as many names as the uses
//   the names G3 ranks before the stored one      REPORT_TAG_CANDIDATES  31 (stored 32nd), 32 (none), 33 (none)
//   accepted followers (raw)                      REPORT_FOLLOWERS       = the cap, half in the year, a tenth malformed
//
// Each statement's reads are counted on their own (measuredStatements) and matched to its exported text; a statement
// that matches none fails. The witness runs after ANALYZE taken before it was built, and again under the plan audit's
// singleton statistics.

const S = REPORT_YEAR_STATUSES;
const T = REPORT_HASHTAG_USES;
const F = REPORT_FOLLOWERS;
const K = REPORT_TAG_CANDIDATES;
const STATE = STATE_STATEMENTS;
const GENERATE = GENERATE_STATEMENTS;

async function world() {
  const h = await apiHarness();
  const alice = await seedAccount(h.store, { username: "alice", email: "alice@example.com" });
  const bob = await seedAccount(h.store, { username: "bob", email: "bob@example.com" });
  const tokenHash = await sha256Hex(await scopedToken(h, "read write"));
  const read = { tokenHash, scope: "read:accounts", now: NOW } as never;
  const write = { tokenHash, scope: "write:accounts", now: NOW } as never;
  const state = () =>
    measuredStatements(h, annualReportState, { credential: read, year: String(YEAR), storeNow: IN_CAMPAIGN });
  const generate = () =>
    measuredStatements(h, generateAnnualReport, { credential: write, year: String(YEAR), storeNow: IN_CAMPAIGN }, true);
  const list = () =>
    measuredStatements(h, annualReports, { credential: read, present: { origin: "https://kopje.test" } });
  const inStore = <R>(fn: (s: SqlStorage) => R) => runInDurableObject(h.store, (_i, st) => fn(st.storage.sql));
  return { h, alice, bob, state, generate, list, inStore };
}

type World = Awaited<ReturnType<typeof world>>;

// G3's ordered keys as JavaScript receives them: REPORT_TAG_CANDIDATES rows, each a hex key within 2 × TAG_NAME_BYTES.
async function expectKeysWithin(w: World): Promise<void> {
  const keys = await sql<{ key: string; uses: number }>(
    w.h.store,
    TOP_HASHTAG_SQL,
    w.alice,
    idIn(YEAR, 0),
    yearEnd(YEAR),
  );
  expect(keys).toHaveLength(K);
  expect(Math.max(...keys.map((k) => k.key.length))).toBeLessThanOrEqual(2 * TAG_NAME_BYTES);
}

// Each statement's plan under the statistics in place: its pinned index, and no table scanned.
async function expectPlans(w: World): Promise<void> {
  const range = [w.alice, idIn(YEAR, 0), yearEnd(YEAR)];
  const plans = await w.inStore((s) => ({
    C1: explainPlan(s, YEAR_STATUSES_SQL, ...range),
    C2: explainPlan(s, FOLLOWERS_SQL, w.alice),
    C3: explainPlan(s, TAG_USES_SQL, ...range),
    C4: explainPlan(s, DISTRIBUTABLE_YEAR_SQL, ...range),
    G1: explainPlan(s, ARCHETYPE_SQL, ...range),
    G2: explainPlan(s, TOP_STATUS_SQL, ...range),
    G3: explainPlan(s, TOP_HASHTAG_SQL, ...range),
    G4: explainPlan(s, FOLLOWERS_IN_YEAR_SQL, w.alice, "2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z"),
    A1: explainPlan(s, REPORT_EXISTS_SQL, w.alice, YEAR),
  }));
  const tables = ["statuses", "s", "status_tags", "t", "follows", "f", "polls", "p", "annual_reports", "r"];
  for (const [name, plan] of Object.entries(plans)) {
    expect(scansOf(plan.split(" | "), tables), `${name}: ${plan}`).toEqual([]);
  }
  const year = "USING INDEX statuses_account (account_id=? AND id>? AND id<?)";
  expect(plans.C1).toContain("SEARCH statuses USING COVERING INDEX statuses_account (account_id=? AND id>? AND id<?)");
  expect(plans.C2).toContain("SEARCH follows USING COVERING INDEX follows_target (target_account_id=? AND state=?)");
  for (const name of ["C3", "C4", "G1", "G2", "G3"] as const) {
    expect(plans[name], name).toContain(`SEARCH s ${year}`);
  }
  for (const name of ["C3", "G3"] as const) {
    expect(plans[name], name).toContain("SEARCH t USING PRIMARY KEY (status_id=?)");
  }
  expect(plans.G1).toMatch(/SEARCH p USING (?:COVERING )?INDEX sqlite_autoindex_polls_1 \(status_id=\?\)/);
  expect(plans.G3).toContain("USE TEMP B-TREE FOR GROUP BY");
  expect(plans.G4).toContain("SEARCH f USING INDEX follows_target (target_account_id=? AND state=?)");
  expect(plans.A1).toContain("SEARCH r USING PRIMARY KEY (account_id=? AND year=?)");
}

const report = (h: { store: Parameters<typeof sql>[0] }) =>
  sql(
    h.store,
    "SELECT archetype, statuses, followers, top_status_id, top_hashtag, top_hashtag_uses FROM annual_reports",
  );

function expectedReport(witness: Witness) {
  return {
    archetype: archetypeOf(witness),
    statuses: witness.counted,
    followers: witness.followersInYear,
    top_status_id: witness.top,
    top_hashtag: witness.admissible,
    top_hashtag_uses: witness.admissible === null ? null : 2,
  };
}

describe("the all-caps witness", () => {
  it.each<WitnessVariant>(["admissible-32nd", "admissible-33rd", "all-refused"])(
    "%s: every statement reads within its derived bound and at least its slowest path, under both statistics",
    async (variant) => {
      const w = await world();
      // Statistics of the small world, before the witness grew it.
      await sql(w.h.store, "ANALYZE");
      const witness = await w.inStore((s) => buildWitness(s, w.alice, w.bob, variant));
      expect([witness.statuses, witness.uses, witness.bytes, witness.followers]).toEqual([
        REPORT_YEAR_STATUSES,
        REPORT_HASHTAG_USES,
        REPORT_HASHTAG_BYTES,
        REPORT_FOLLOWERS,
      ]);
      for (const statistics of ["stale", "singleton"] as const) {
        if (statistics === "singleton") {
          await w.inStore((s) => singletonStatistics(s));
        }
        // The admissible-32nd witness also carries G3's key sizes (under the stale statistics) and each statement's
        // plan (under the singleton ones), read apart from the operations whose statements are recorded.
        if (variant === "admissible-32nd") {
          await (statistics === "stale" ? expectKeysWithin(w) : expectPlans(w));
        }
        const state = await w.state();
        expect(state.output, statistics).toEqual({ status: "ok", value: "eligible" });
        expectStatements(state.statements, STATE, true);
        const generated = await w.generate();
        expect(generated.output).toEqual({ status: "ok", value: undefined });
        const g = expectStatements(generated.statements, GENERATE, true);
        // G3 handed REPORT_TAG_CANDIDATES rows to JavaScript, and the stored name is the 32nd, or none.
        expect(g.G3?.returned).toBe(K);
        expect(await report(w.h), statistics).toEqual([expectedReport(witness)]);
        await sql(w.h.store, "DELETE FROM annual_reports");
      }
    },
    600_000,
  );
});

describe("growth", () => {
  it("leaves every statement's reads flat as the keys around the owner's year grow, and stops at a cap however far it is passed", async () => {
    const w = await world();
    const witness = await w.inStore((s) => buildWitness(s, w.alice, w.bob, "admissible-32nd"));
    const baseline = expectStatements((await w.state()).statements, STATE, true);
    const carol = await seedAccount(w.h.store, { username: "carol", email: "carol@example.com" });
    // Keys that are not the owner's year: the other account's rows in the range and their uses of the same names,
    // the owner's rows outside the year, and pending requests.
    await w.inStore((s) => {
      s.exec(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
				SELECT CAST(?2 + i AS TEXT), 'https://kopje.test/ap/o/' || (?2 + i), ?3, 'public', '<p>x</p>',
					'2026-06-01T00:00:00.000Z' FROM n`,
        S,
        idIn(YEAR, 4 * S),
        carol,
      );
      s.exec(
        `INSERT INTO status_tags (status_id, name) SELECT s.id, t.name FROM statuses s
					CROSS JOIN (SELECT DISTINCT name FROM status_tags LIMIT 50) t WHERE s.account_id = ?1`,
        carol,
      );
      s.exec(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
				SELECT CAST(?2 - 1 - i AS TEXT), 'https://kopje.test/ap/o/before' || i, ?3, 'public', '<p>x</p>',
					'2025-06-01T00:00:00.000Z' FROM n`,
        S,
        idIn(YEAR, -1),
        w.alice,
      );
      insertAccounts(s, F, 900000000000000000n);
      insertFollows(s, w.alice, F, 900000000000000000n, "pending", "2026-03-01T00:00:00.000Z");
    });
    const grown = expectStatements((await w.state()).statements, STATE, true);
    for (const name of STATE) {
      expect(grown[name]?.rows, name).toBe(baseline[name]?.rows);
    }
    // Each cap passed alone, by as much again as the cap, stops the read there, within the ceiling, and the account is
    // ineligible.
    const more = (s: SqlStorage, insert: string, count: number, ...params: SqlStorageValue[]) =>
      s.exec(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1) ${insert}`,
        count,
        ...params,
      );
    const passes: [string, (s: SqlStorage) => void, (s: SqlStorage) => void, string[]][] = [
      [
        "statuses",
        (s) =>
          more(
            s,
            `INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
					SELECT CAST(?2 + i AS TEXT), 'https://kopje.test/ap/o/more' || i, ?3, 'public', '<p>x</p>',
						'2026-06-01T00:00:00.000Z' FROM n`,
            S,
            idIn(YEAR, 6 * S),
            w.alice,
          ),
        (s) => s.exec("DELETE FROM statuses WHERE uri GLOB 'https://kopje.test/ap/o/more*'"),
        ["authorize", "A1", "S1", "C1"],
      ],
      [
        "followers",
        (s) => {
          insertAccounts(s, F, 950000000000000000n);
          insertFollows(s, w.alice, F, 950000000000000000n, "accepted", "2026-03-01T00:00:00.000Z");
        },
        (s) => s.exec("DELETE FROM follows WHERE account_id >= '950000000000000000'"),
        ["authorize", "A1", "S1", "C1", "C2"],
      ],
      [
        "hashtag_uses",
        (s) => more(s, "INSERT INTO status_tags (status_id, name) SELECT ?2, 'zzgrowth' || i FROM n", T, witness.top),
        (s) => s.exec("DELETE FROM status_tags WHERE name GLOB 'zzgrowth*'"),
        ["authorize", "A1", "S1", "C1", "C2", "C3"],
      ],
    ];
    for (const [cap, add, remove, ran] of passes) {
      await w.inStore(add);
      const past = await w.state();
      expect(past.output, cap).toEqual({ status: "ok", value: "ineligible" });
      expectStatements(past.statements, ran, false);
      await w.inStore(remove);
    }
    expect((await w.state()).output).toEqual({ status: "ok", value: "eligible" });
  }, 600_000);
});

describe("the list", () => {
  it("reads at most REPORTS_LISTED of the owner's pending reports, however many reports grow around them", async () => {
    const w = await world();
    // `count` reports of `account` from year `first` down, pending or viewed.
    const reports = (account: string, first: number, count: number, viewed: boolean) =>
      w.inStore((s) =>
        s.exec(
          `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
					INSERT INTO annual_reports (account_id, year, archetype, statuses, followers, viewed_at, created_at)
					SELECT ?2, ?3 - i, 'oracle', 1, 1, ?4, '2026-12-11T00:00:00.000Z' FROM n`,
          count,
          account,
          first,
          viewed ? "2026-12-12T00:00:00.000Z" : null,
        ),
      );
    const a2 = async () => {
      const answer = await w.list();
      if (answer.output.status !== "ok") throw new Error(answer.output.status);
      const [statement, ...others] = answer.statements.filter((s) => s.query === PENDING_REPORTS_SQL);
      expect(others).toEqual([]);
      return { rows: statement?.rows, years: answer.output.value.annual_reports.map((r) => r.year) };
    };
    await reports(w.alice, 9999, REPORTS_LISTED, false);
    const baseline = await a2();
    expect(baseline.rows).toBe(REPORTS_LISTED);
    // The owner's older pending reports, their viewed ones, and another account's of every year.
    await reports(w.alice, 9999 - REPORTS_LISTED, 1_000, false);
    await reports(w.alice, 5000, 1_000, true);
    await reports(w.bob, 9999, 2_000, false);
    await w.inStore((s) => singletonStatistics(s));
    expect(await a2()).toEqual(baseline);
    const plan = await w.inStore((s) => explainPlan(s, PENDING_REPORTS_SQL, w.alice));
    expect(plan).toContain("SEARCH r USING INDEX annual_reports_pending (account_id=?)");
  });
});

describe("sizes", () => {
  it("presents a report at its bounds in REPORT_JSON_BYTES, and an answer of REPORTS_LISTED of them within STATUS_ANSWER_BYTES", async () => {
    const w = await world();
    const top = idIn(YEAR, 1);
    // A name of MAX_TAG_LENGTH characters that each escape to six bytes: TAG_NAME_JSON_BYTES.
    const name = "\u0001".repeat(TAG_NAME_JSON_BYTES / 6);
    await w.inStore((s) => {
      insertPost(s, { id: top, account: w.alice, reblogs: 1 });
      s.exec(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO annual_reports (account_id, year, archetype, statuses, followers, top_status_id, top_hashtag,
					top_hashtag_uses, created_at)
				SELECT ?2, 9999 - i, 'pollster', ?3, ?3, ?4, ?5, ?3, '2026-12-11T00:00:00.000Z' FROM n`,
        REPORTS_LISTED,
        w.alice,
        Number.MAX_SAFE_INTEGER,
        top,
        name,
      );
    });
    const tokenHash = (await sql<{ token_hash: string }>(w.h.store, "SELECT token_hash FROM oauth_tokens LIMIT 1"))[0]!
      .token_hash;
    const answer = await measuredStatements(w.h, annualReports, {
      credential: { tokenHash, scope: "read:accounts", now: NOW } as never,
      present: { origin: "https://kopje.test" },
    });
    if (answer.output.status !== "ok") throw new Error(answer.output.status);
    const reports = answer.output.value.annual_reports;
    expect(reports).toHaveLength(REPORTS_LISTED);
    expect(reports[0]?.data.top_hashtags).toEqual([{ name, count: Number.MAX_SAFE_INTEGER }]);
    expect(reports[0]?.data.top_statuses.by_reblogs).toBe(top);
    for (const r of reports) {
      expect(jsonBytes(r)).toBe(REPORT_JSON_BYTES);
    }
    expect(jsonBytes(answer.output.value)).toBeLessThanOrEqual(STATUS_ANSWER_BYTES);
    expect(REPORTS_LISTED * (REPORT_JSON_BYTES + 1)).toBeLessThan(STATUS_ANSWER_BYTES / 2);
  });

  it("ends the top statuses where STATUS_ANSWER_BYTES ends", async () => {
    const w = await world();
    const author = await seedAccount(w.h.store, { username: "top", domain: "remote.example" });
    // A pending report of each year whose top status is one of statusBudgetEdge's, newest first.
    const { big, edge } = await statusBudgetEdge(async (i, share) => {
      const top = await bigStatus(w.h, author, NOW - (20 - i) * 60_000, {}, share);
      await sql(
        w.h.store,
        `INSERT INTO annual_reports (account_id, year, archetype, statuses, followers, top_status_id, created_at)
				VALUES (?, ?, 'pollster', 1, 1, ?, '2026-12-11T00:00:00.000Z')`,
        w.alice,
        9999 - i,
        top,
      );
      return top;
    });
    const listed = await w.list();
    if (listed.output.status !== "ok") throw new Error(listed.output.status);
    expect(listed.output.value.statuses.map((status) => status.id)).toEqual(big);
    const token = await scopedToken(w.h, "read");
    const next = (await answer<unknown>(w.h, `/api/v1/statuses/${edge}`, token)).bytes;
    expectStatusBudgetCut("annual reports", jsonBytes(listed.output.value), next);
  }, 300_000);
});
