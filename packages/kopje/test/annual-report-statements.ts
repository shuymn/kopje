import {
  ARCHETYPE_SQL,
  DISTRIBUTABLE_YEAR_SQL,
  FOLLOWERS_IN_YEAR_SQL,
  FOLLOWERS_SQL,
  INSERT_REPORT_SQL,
  REPORT_EXISTS_SQL,
  REPORT_FOLLOWERS,
  REPORT_HASHTAG_USES,
  REPORT_TAG_CANDIDATES,
  REPORT_YEAR_STATUSES,
  TAG_USES_SQL,
  TOP_HASHTAG_SQL,
  TOP_STATUS_SQL,
  WRAPSTODON_SQL,
  YEAR_STATUSES_SQL,
} from "../src/domain/annual-reports";
import type { MeasuredStatement } from "./read-helpers";

// The statements `state` and `generate` run for the campaign year without a report (src/domain/annual-reports.ts),
// each matched by its exported text, with the rows it reads at most, derived from the caps (each statement's
// candidates times what each costs: an index entry, a table row, a probe), and at least on its slowest path, where
// every input is at its cap (the all-caps witness, test/annual-report-fixtures.ts buildWitness). Shared by the ceiling
// test (test/annual-report-bounds.test.ts) and the cost bench (test/bench/annual-report.bench.ts).

const S = REPORT_YEAR_STATUSES;
const T = REPORT_HASHTAG_USES;
const F = REPORT_FOLLOWERS;
const K = REPORT_TAG_CANDIDATES;
// The year's rows (YEAR_ROWS_SQL): S rows through statuses_account, and the entry that ends the range.
const Y = S + 1;

export type StatementBound = { name: string; matches: (query: string) => boolean; max: number; min: number };

const exactly = (text: string) => (query: string) => query === text;

export const STATEMENT_BOUNDS: readonly StatementBound[] = [
  // The credential, by key: the token, its client, its account (auth.ts authorize).
  { name: "authorize", matches: (q) => q.startsWith("SELECT t.scopes, t.account_id"), max: 3, min: 1 },
  { name: "A1", matches: exactly(REPORT_EXISTS_SQL), max: 1, min: 0 },
  { name: "S1", matches: exactly(WRAPSTODON_SQL), max: 1, min: 0 },
  // C1: one covering index entry per row, and the one that ends the range.
  { name: "C1", matches: exactly(YEAR_STATUSES_SQL), max: S + 1, min: S },
  // C2: one covering index entry per accepted follow, and the one that ends the key.
  { name: "C2", matches: exactly(FOLLOWERS_SQL), max: F + 1, min: F },
  // C3: the year's rows, then per row a primary-key probe of status_tags: its tag rows (T + 1 at most, the LIMIT) and
  // the entry that ends it.
  { name: "C3", matches: exactly(TAG_USES_SQL), max: Y + (T + 1) + S, min: S + T },
  // C4: the year's rows, its only counted public status last.
  { name: "C4", matches: exactly(DISTRIBUTABLE_YEAR_SQL), max: Y, min: S },
  // G1: the year's rows and one polls row per counted row at most.
  { name: "G1", matches: exactly(ARCHETYPE_SQL), max: Y + S, min: S },
  // G2: the year's rows and the top-1 sort's row.
  { name: "G2", matches: exactly(TOP_STATUS_SQL), max: Y + 1, min: S },
  // G3: C3's walk, the grouping's sorter (one row per tag row) and the ordering's REPORT_TAG_CANDIDATES rows.
  { name: "G3", matches: exactly(TOP_HASHTAG_SQL), max: Y + (T + 1) + S + (T + 1) + K, min: S + T },
  // G4: one table row per accepted follow, and the entry that ends the key.
  { name: "G4", matches: exactly(FOLLOWERS_IN_YEAR_SQL), max: F + 1, min: F },
  { name: "G5", matches: exactly(INSERT_REPORT_SQL), max: 1, min: 0 },
];

// The statements each operation runs, in order, for the campaign year without a report and within every cap.
export const STATE_STATEMENTS = ["authorize", "A1", "S1", "C1", "C2", "C3", "C4"];
export const GENERATE_STATEMENTS = ["authorize", "S1", "A1", "C1", "C2", "C3", "G1", "G2", "G3", "G4", "G5"];

export function ceiling(names: readonly string[]): number {
  return names.reduce((sum, name) => sum + (STATEMENT_BOUNDS.find((b) => b.name === name)?.max ?? Infinity), 0);
}

export type NamedStatement = MeasuredStatement & { name: string; bound: StatementBound };

// Each recorded statement with the bound it matches; one that matches none throws.
export function namedStatements(statements: readonly MeasuredStatement[]): NamedStatement[] {
  return statements.map((statement) => {
    const bound = STATEMENT_BOUNDS.find((candidate) => candidate.matches(statement.query));
    if (bound === undefined) {
      throw new Error(`a statement no bound names: ${statement.query.slice(0, 120)}`);
    }
    return { ...statement, name: bound.name, bound };
  });
}
