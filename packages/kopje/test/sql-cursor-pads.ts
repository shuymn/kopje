// Statements that resolve a CTE after exactly `k` numbered cursors, for calibrating SQLite's cursor rule
// (docs/engineering.md "Queries"): from 3.54.1, the reference of a CTE fails to prepare ("VIEWs and/or subqueries
// nested too deep") once the cursors numbered before it reach the expression depth limit, less 2 for a flat CTE and
// less 3 for a recursive one. The pads are FROM subqueries of up to PAD_TABLES tables each (a subquery and its tables,
// one cursor each, numbered before the CTE that ends the FROM list), with no expression depth; each subquery's LIMIT
// keeps the planner from flattening them into one join past SQLite's 64 tables. `table` names a table of the schema;
// LIMIT 0 reads none of it.

const PAD_TABLES = 40;

function padsSql(k: number, table: string): string {
  const items: string[] = [];
  let numbered = 0;
  while (numbered < k) {
    const left = k - numbered;
    const name = `cp${items.length}`;
    if (left === 1) {
      items.push(`${table} ${name}`);
      numbered += 1;
    } else {
      const tables = Math.min(PAD_TABLES, left - 1);
      const from = Array.from({ length: tables }, (_, i) => `${table} ${name}_${i}`).join(", ");
      items.push(`(SELECT 1 FROM ${from} LIMIT 1) ${name}`);
      numbered += tables + 1;
    }
  }
  return items.map((item) => `${item}, `).join("");
}

// A flat CTE referenced after `k` cursors.
export function flatCteAfter(k: number, table: string): string {
  return `WITH cc(v) AS (SELECT 1) SELECT 1 FROM ${padsSql(k, table)}cc LIMIT 0`;
}

// A recursive CTE referenced after `k` cursors.
export function recursiveCteAfter(k: number, table: string): string {
  return `WITH RECURSIVE cc(v) AS (SELECT 1 UNION ALL SELECT v + 1 FROM cc WHERE v < 2)
		SELECT 1 FROM ${padsSql(k, table)}cc LIMIT 0`;
}

// The error SQLite gives a statement that breaks the rule.
export const CURSOR_REFUSAL = "VIEWs and/or subqueries nested too deep";
