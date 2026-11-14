// The depth guard of the Store's SQL, measured on Node: the SQLite of Durable Objects refuses a statement whose
// expression tree is deeper than 100, and SQLite 3.54.1 one that resolves a CTE after 100 numbered cursors less 2
// (less 3 for a recursive CTE; docs/engineering.md "Queries"). workerd cannot lower that limit, while node:sqlite
// can, and both rules read it. The cursor rule is enforced here only: mise.lock pins a Node whose SQLite (3.54.1) has
// it, while workerd from 1.20261111.1 backs it out (test/sql-cursor-calibration.test.ts checks the runtime's success
// side). A Node update that loses the rule fails the calibration below, and is decided then: keep a Node with the rule
// for the guard, or retire the guard by the owner's decision. The Workers suites send every statement they run through Db here
// (test/sql-depth-setup.ts, through the SQL_DEPTH binding of vitest.config.ts), so a statement nearing either refusal
// fails the suite that runs it, not a request in production.

import type { DatabaseSync } from "node:sqlite";

import { createKopjeDatabase } from "../cli/lib/cutover/kopje-db.js";
import { CURSOR_REFUSAL, flatCteAfter } from "../test/sql-cursor-pads.js";

// The suites prepare each statement at a limit 4 below the Store's: a variant of a statement no test runs (another
// viewer kind, an extra filter) nests a few levels or cursors more or less than the one a test runs.
const CTE_GUARD_LIMIT = 96;
const MEASURED_UP_TO = 1000;
const DEPTH_REFUSAL = "Expression tree is too large";

// As test/sql-depth-setup.ts reads it: a statement refused at CTE_GUARD_LIMIT, with the lowest limit it prepares at
// (null: none up to MEASURED_UP_TO).
type DeepStatement = { limit: number | null; sql: string };

let database: DatabaseSync | undefined;

// Whether `sql` prepares at `limit`. A statement that fails to compile for another reason throws, and so does a batch
// (SqlStorage.exec runs every statement of a text, prepare compiles the first): the guard does not skip what it cannot
// measure.
function prepares(db: DatabaseSync, sql: string, limit: number): boolean {
  db.limits.exprDepth = limit;
  try {
    if (db.prepare(sql).sourceSQL.trimEnd() !== sql.trimEnd()) {
      throw new Error("a batch of statements");
    }
    return true;
  } catch (error) {
    if (error instanceof Error && (error.message.startsWith(DEPTH_REFUSAL) || error.message === CURSOR_REFUSAL)) {
      return false;
    }
    throw new Error(`cannot compile a Store statement on Node: ${String(error)}\n${sql}`, { cause: error });
  }
}

// The host's SQLite must apply the cursor rule as the Store's does, or the guard would pass what the Store refuses: a
// flat CTE after CTE_GUARD_LIMIT - 2 cursors prepares at the guard's limit, and after one more it is refused.
function calibrated(db: DatabaseSync): void {
  const version = (db.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v;
  const fails = (k: number) => {
    try {
      return !prepares(db, flatCteAfter(k, "main.accounts"), CTE_GUARD_LIMIT);
    } catch {
      return false;
    }
  };
  if (fails(CTE_GUARD_LIMIT - 2) || !fails(CTE_GUARD_LIMIT - 1)) {
    throw new Error(
      `the host's SQLite ${version} does not refuse a CTE after ${CTE_GUARD_LIMIT - 1} cursors at limit ${CTE_GUARD_LIMIT}`,
    );
  }
}

function guardDatabase(): DatabaseSync {
  if (database === undefined) {
    const db = createKopjeDatabase();
    calibrated(db);
    database = db;
  }
  return database;
}

// Each statement of `statements` refused at CTE_GUARD_LIMIT, with the lowest limit it prepares at.
function deepStatements(statements: string[]): DeepStatement[] {
  const db = guardDatabase();
  const deep: DeepStatement[] = [];
  for (const sql of statements) {
    if (prepares(db, sql, CTE_GUARD_LIMIT)) {
      continue;
    }
    if (!prepares(db, sql, MEASURED_UP_TO)) {
      deep.push({ limit: null, sql });
      continue;
    }
    let low = CTE_GUARD_LIMIT + 1;
    let high = MEASURED_UP_TO;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (prepares(db, sql, middle)) {
        high = middle;
      } else {
        low = middle + 1;
      }
    }
    deep.push({ limit: low, sql });
  }
  return deep;
}

// The SQL_DEPTH binding: a JSON array of statements in, the refused ones out.
export async function sqlDepthService(request: Request): Promise<Response> {
  return Response.json(deepStatements((await request.json()) as string[]));
}
