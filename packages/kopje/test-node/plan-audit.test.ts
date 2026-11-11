import { describe, expect, it } from "vitest";

import { ROWS_1468 } from "../test/plan-audit-1468.js";
import { PLAN_AUDIT_ENTRIES } from "../test/plan-audit-entries.js";
import {
  type AuditedStatement,
  auditFailures,
  bindsPattern,
  normalizeSql,
  type PlanRow,
  type PlanSchema,
  planSignatures,
  statementId,
} from "../test/plan-audit.js";

// The pure part of the plan audit (test/plan-audit.ts): identity, classification and the decision. Its claims on
// workerd's planner are test/plan-audit.test.ts.

const SCHEMA: PlanSchema = {
  tables: new Set(["accounts", "local_accounts", "statuses", "follows"]),
  indexes: new Map([
    ["sqlite_autoindex_accounts_1", "accounts"],
    ["accounts_newest", "accounts"],
    ["statuses_account", "statuses"],
  ]),
};

const rows = (...details: string[]): PlanRow[] => details.map((detail, n) => ({ id: n + 1, parent: 0, detail }));
const signatures = (sql: string, ...details: string[]) => planSignatures(sql, rows(...details), SCHEMA);

describe("plan audit classifier", () => {
  it("counts a scan of a base table, through an index or not, as a violation", () => {
    const sql = "SELECT a.id FROM accounts a JOIN local_accounts l ON l.account_id = a.id";
    expect(signatures(sql, "SCAN a", "SCAN l USING COVERING INDEX x_unknown")).toEqual([
      "accounts: SCAN a",
      "local_accounts: SCAN l USING COVERING INDEX x_unknown",
    ]);
    // The index names the table, whatever the alias.
    expect(signatures("SELECT 1 FROM accounts", "SCAN zz USING COVERING INDEX accounts_newest")).toEqual([
      "accounts: SCAN zz USING COVERING INDEX accounts_newest",
    ]);
    expect(signatures("SELECT 1 FROM main.accounts", "SCAN main.accounts")).toEqual(["accounts: SCAN main.accounts"]);
  });

  it("counts automatic indexes, Bloom filters and skip-scans as violations, at any depth", () => {
    const sql = "SELECT 1 FROM statuses s WHERE EXISTS (SELECT 1 FROM follows f WHERE f.target_id = s.account_id)";
    const plan: PlanRow[] = [
      { id: 1, parent: 0, detail: "SEARCH s USING INDEX statuses_account (account_id=?)" },
      { id: 2, parent: 0, detail: "CORRELATED SCALAR SUBQUERY 1" },
      { id: 3, parent: 2, detail: "SEARCH f USING AUTOMATIC COVERING INDEX (target_id=?)" },
      { id: 4, parent: 0, detail: "BLOOM FILTER ON f (target_id=?)" },
      { id: 5, parent: 0, detail: "SEARCH s USING INDEX statuses_account (ANY(account_id) AND id>?)" },
    ];
    expect(planSignatures(sql, plan, SCHEMA)).toEqual([
      "follows: BLOOM FILTER ON f (target_id=?)",
      "follows: SEARCH f USING AUTOMATIC COVERING INDEX (target_id=?)",
      "statuses: SEARCH s USING INDEX statuses_account (ANY(account_id) AND id>?)",
    ]);
  });

  it("does not count a search, a virtual table, a constant row, or a CTE's or subquery's result", () => {
    const sql = `WITH c AS (SELECT id FROM accounts LIMIT 3)
			SELECT 1 FROM c x JOIN (SELECT id FROM statuses s WHERE s.id = ?) d JOIN json_each(?) j JOIN accounts a ON a.id = x.id`;
    expect(
      signatures(
        sql,
        "MATERIALIZE c",
        "SCAN x",
        "SCAN d",
        "SCAN (subquery-2)",
        "SCAN j VIRTUAL TABLE INDEX 1:",
        "SCAN CONSTANT ROW",
        "SEARCH a USING INDEX sqlite_autoindex_accounts_1 (id=?)",
        "SEARCH s USING INTEGER PRIMARY KEY (rowid=?)",
      ),
    ).toEqual([]);
    // The CTE's own scan is checked on its own line.
    expect(signatures(sql, "SCAN accounts")).toEqual(["accounts: SCAN accounts"]);
  });

  it("resolves a name within the statement's scopes, and fails closed on one it cannot resolve", () => {
    // `a` is a CTE in one scope and a table in another: a scan of `a` may be either, so it is a violation.
    const shadowed = `WITH x AS (SELECT id FROM accounts a WHERE a.id = ?) SELECT 1 FROM x a`;
    expect(signatures(shadowed, "SCAN a")).toEqual(["?: SCAN a"]);
    // Two tables under one alias in different scopes.
    const twice = `SELECT 1 FROM accounts a WHERE EXISTS (SELECT 1 FROM statuses a WHERE a.id = ?)`;
    expect(signatures(twice, "SCAN a")).toEqual(["?: SCAN a"]);
    // A name the statement does not bind.
    expect(signatures("SELECT 1 FROM accounts", "SCAN q")).toEqual(["?: SCAN q"]);
    // A table in a parenthesized FROM item, a comma join, and the targets of writes.
    expect(signatures("SELECT 1 FROM (SELECT id FROM statuses t) d, follows f", "SCAN t", "SCAN f")).toEqual([
      "follows: SCAN f",
      "statuses: SCAN t",
    ]);
    expect(signatures("UPDATE OR IGNORE statuses SET x = 1 WHERE id = ?", "SCAN statuses")).toEqual([
      "statuses: SCAN statuses",
    ]);
    expect(
      signatures("DELETE FROM follows AS f WHERE f.id IN (SELECT id FROM accounts)", "SCAN f", "SCAN accounts"),
    ).toEqual(["accounts: SCAN accounts", "follows: SCAN f"]);
  });

  it("refuses a LIKE or GLOB pattern taken from a parameter", () => {
    expect(bindsPattern("SELECT 1 FROM accounts WHERE username LIKE ?")).toBe(true);
    expect(bindsPattern("SELECT 1 FROM accounts WHERE username GLOB ?1 || '*'")).toBe(true);
    expect(bindsPattern("SELECT 1 FROM accounts WHERE username NOT LIKE ('%' || ? || '%') ESCAPE '\\'")).toBe(true);
    expect(bindsPattern("SELECT like(?, username) FROM accounts")).toBe(true);
    expect(bindsPattern("SELECT 1 FROM accounts WHERE username LIKE 'a%' AND id = ?")).toBe(false);
    expect(bindsPattern("SELECT 1 FROM accounts WHERE x GLOB '*[^0-9]*' OR id = ?")).toBe(false);
    expect(bindsPattern("SELECT like('a%', ?) FROM accounts")).toBe(false);
    expect(bindsPattern("SELECT 'LIKE ?' FROM accounts WHERE id = ?")).toBe(false);
  });
});

describe("plan audit identity", () => {
  it("ignores comments and insignificant whitespace", async () => {
    const id = await statementId("SELECT a.id FROM accounts a WHERE a.id = ?");
    expect(await statementId("SELECT  a.id -- the id\n\tFROM accounts a /* by key */ WHERE a.id = ?\n")).toBe(id);
    expect(normalizeSql("SELECT a.id -- x\nFROM  accounts a")).toBe("SELECT a.id FROM accounts a");
  });

  it("keeps literals, placeholders and qualifiers", async () => {
    const ids = await Promise.all(
      [
        "SELECT 1 FROM accounts WHERE id IN (?)",
        "SELECT 1 FROM accounts WHERE id IN (?, ?)",
        "SELECT 1 FROM accounts WHERE id IN (?1, ?2)",
        "SELECT 1 FROM main.accounts WHERE id IN (?)",
        "SELECT 1 FROM accounts WHERE id IN ('a  b')",
        "SELECT 1 FROM accounts WHERE id IN ('a b')",
        "SELECT 1 FROM accounts WHERE id IN ('a -- b')",
        "SELECT 1 FROM accounts INDEXED BY accounts_newest WHERE id IN (?)",
      ].map(statementId),
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(normalizeSql("SELECT 'a  -- b'  ,  \"x  y\"")).toBe("SELECT 'a  -- b' , \"x  y\"");
  });
});

describe("plan audit baseline", () => {
  it("lists each identity once, and links each to #1468", () => {
    const ids = PLAN_AUDIT_ENTRIES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of PLAN_AUDIT_ENTRIES) {
      expect(entry.issue ?? entry.reason).toMatch(/^#1468 group [1-9]$/);
      expect(entry.scans.length).toBeGreaterThan(0);
    }
  });

  // AC8: every row of #1468 is observed, outside the predicate, or unobserved; an identity a row names is an entry of
  // the row's group, named by no other row.
  it("maps the rows of #1468 onto the entries", () => {
    const groups = new Map(PLAN_AUDIT_ENTRIES.map((entry) => [entry.id, entry.issue]));
    const named = ROWS_1468.flatMap((row) => ("ids" in row && row.ids !== undefined ? row.ids : []));
    expect(new Set(named).size).toBe(named.length);
    for (const row of ROWS_1468) {
      for (const id of "ids" in row && row.ids !== undefined ? row.ids : []) {
        expect(groups.get(id), `${row.statement}: ${id}`).toBe(`#1468 group ${row.group}`);
      }
    }
    const grouped = PLAN_AUDIT_ENTRIES.filter((entry) => entry.issue !== "#1468 group 9").map((entry) => entry.id);
    expect(grouped.toSorted()).toEqual(named.toSorted());
  });
});

describe("plan audit decision", () => {
  const statement = (id: string, violations: string[], error?: string): AuditedStatement => ({
    id,
    sql: "SELECT 1",
    params: ["x", 1, null],
    sites: ["src/domain/x.ts:1 reader"],
    plan: rows("SCAN a"),
    violations,
    ...(error === undefined ? {} : { error }),
  });

  it("fails a scan no entry lists, with a paste-ready entry", () => {
    const [failure, ...rest] = auditFailures([statement("aa", ["accounts: SCAN a"])], []);
    expect(rest).toEqual([]);
    expect(failure).toContain("aa reads a whole table or index, and no entry lists it");
    expect(failure).toContain("parameter types: [string, number, null]");
    expect(failure).toContain(
      'paste-ready entry: {"id":"aa","scans":["accounts: SCAN a"],"site":"src/domain/x.ts#reader","issue":"#1468"}',
    );
  });

  it("passes a listed scan, and fails a new scan of a listed statement", () => {
    const entry = { id: "aa", scans: ["accounts: SCAN a"], site: "x", issue: "#1468" };
    expect(auditFailures([statement("aa", ["accounts: SCAN a"])], [entry])).toEqual([]);
    const failures = auditFailures([statement("aa", ["accounts: SCAN a", "follows: SCAN f"])], [entry]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/offending lines:\n {4}follows: SCAN f$/m);
    // An entry lists one identity: another statement's same scan is not covered.
    expect(auditFailures([statement("bb", ["accounts: SCAN a"])], [entry])).toHaveLength(1);
  });

  it("fails an entry whose executed statement no longer scans", () => {
    const entry = { id: "aa", scans: ["accounts: SCAN a", "follows: SCAN f"], site: "x", issue: "#1468" };
    expect(auditFailures([statement("aa", [])], [entry])).toEqual([
      expect.stringContaining("aa no longer reads what its entry lists: remove this entry"),
    ]);
    expect(auditFailures([statement("aa", ["accounts: SCAN a"])], [entry])).toEqual([
      expect.stringContaining("aa no longer reads follows: SCAN f: remove these scans from its entry"),
    ]);
  });

  it("does not judge an entry whose statement the run did not execute", () => {
    const entry = { id: "zz", scans: ["accounts: SCAN a"], site: "x", issue: "#1468" };
    expect(auditFailures([statement("aa", [])], [entry])).toEqual([]);
  });

  it("fails a statement it cannot plan unless listed as unplannable, and an identity listed twice", () => {
    expect(auditFailures([statement("aa", [], "no such table")], [])).toEqual([
      expect.stringContaining("EXPLAIN QUERY PLAN refused it: no such table"),
    ]);
    const entry = { id: "aa", scans: ["unplannable"], site: "x", reason: "r" };
    expect(auditFailures([statement("aa", [], "no such table")], [entry])).toEqual([]);
    expect(auditFailures([], [entry, entry])).toEqual([expect.stringContaining("aa is listed twice")]);
  });
});
