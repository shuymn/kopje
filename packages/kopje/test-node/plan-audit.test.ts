import { describe, expect, it } from "vitest";

import { ROWS_1468 } from "../test/plan-audit-1468.js";
import { PLAN_AUDIT_ENTRIES } from "../test/plan-audit-entries.js";
import {
  type AuditedStatement,
  auditDecision,
  bindsPattern,
  callerFrames,
  normalizeSql,
  type PlanAuditEntry,
  type PlanRow,
  type PlanSchema,
  planSignatures,
  sampleKey,
  statementId,
} from "../test/plan-audit.js";

// The pure part of the plan audit (test/plan-audit.ts): identity, provenance, classification and the decision. Its
// claims on workerd's planner are test/plan-audit.test.ts.

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
// A plan as a tree: each line `[depth, detail]`.
const tree = (...lines: [number, string][]): PlanRow[] => {
  const parents: number[] = [0];
  return lines.map(([depth, detail], n) => {
    parents[depth + 1] = n + 1;
    return { id: n + 1, parent: parents[depth]!, detail };
  });
};

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
    const plan = tree(
      [0, "SEARCH s USING INDEX statuses_account (account_id=?)"],
      [0, "CORRELATED SCALAR SUBQUERY 1"],
      [1, "SEARCH f USING AUTOMATIC COVERING INDEX (target_id=?)"],
      [0, "BLOOM FILTER ON f (target_id=?)"],
      [0, "SEARCH s USING INDEX statuses_account (ANY(account_id) AND id>?)"],
    );
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
        "CO-ROUTINE d",
        "SCAN d",
        "SCAN (subquery-2)",
        "SCAN j VIRTUAL TABLE INDEX 1:",
        "SCAN CONSTANT ROW",
        "SEARCH a USING INDEX sqlite_autoindex_accounts_1 (id=?)",
        "SEARCH s USING INTEGER PRIMARY KEY (rowid=?)",
      ),
    ).toEqual([]);
    // The CTE's own scan is checked on its own line.
    expect(planSignatures(sql, tree([0, "MATERIALIZE c"], [1, "SCAN accounts"]), SCHEMA)).toEqual([
      "accounts: SCAN accounts",
    ]);
  });

  it("resolves a name in the query scope of its plan line", () => {
    // The outer scan reads the CTE's result; the CTE's body reads accounts.
    const cte = "WITH x AS MATERIALIZED (SELECT username FROM accounts a WHERE a.id = '1') SELECT * FROM x a";
    expect(planSignatures(cte, tree([0, "MATERIALIZE x"], [1, "SCAN a"], [0, "SCAN a"]), SCHEMA)).toEqual([
      "accounts: SCAN a",
    ]);
    expect(
      planSignatures(
        cte,
        tree([0, "MATERIALIZE x"], [1, "SEARCH a USING INDEX sqlite_autoindex_accounts_1 (id=?)"], [0, "SCAN a"]),
        SCHEMA,
      ),
    ).toEqual([]);
    // A recursive CTE named as an outer table's alias (audience.ts availableSql): its steps scan the CTE itself.
    const recursive = `SELECT 1 FROM accounts ps WHERE ps.id = ?1 AND (SELECT count(*) FROM (WITH RECURSIVE ps(d) AS
			(SELECT ?2 UNION ALL SELECT substr(d, 2) FROM ps WHERE d <> '') SELECT d FROM ps)) > 0`;
    const plan = tree(
      [0, "SCAN ps"],
      [0, "CORRELATED SCALAR SUBQUERY 3"],
      [1, "CO-ROUTINE ps"],
      [2, "SETUP"],
      [3, "SCAN CONSTANT ROW"],
      [2, "RECURSIVE STEP"],
      [3, "SCAN ps"],
      [1, "SCAN ps"],
    );
    expect(planSignatures(recursive, plan, SCHEMA)).toEqual(["accounts: SCAN ps"]);
    // The same name for an account in one subquery and for the CTE in another: an expression subquery is the unnamed
    // scope that knows every name its own lines use.
    const both = `SELECT 1 FROM statuses s WHERE (SELECT 1 FROM accounts ps WHERE ps.id = s.account_id)
			AND (WITH RECURSIVE ps(d) AS (SELECT ?1 UNION ALL SELECT substr(d, 2) FROM ps WHERE d <> '')
				SELECT 1 FROM ps JOIN follows pr ON pr.id = ps.d)`;
    const twoSubqueries = (first: string) =>
      tree(
        [0, "SEARCH s USING INDEX statuses_account (account_id=?)"],
        [0, "CORRELATED SCALAR SUBQUERY 1"],
        [1, first],
        [0, "CORRELATED SCALAR SUBQUERY 4"],
        [1, "CO-ROUTINE ps"],
        [2, "SETUP"],
        [3, "SCAN CONSTANT ROW"],
        [2, "RECURSIVE STEP"],
        [3, "SCAN ps"],
        [1, "SCAN ps"],
        [1, "SEARCH pr USING INTEGER PRIMARY KEY (rowid=?)"],
      );
    expect(planSignatures(both, twoSubqueries("SEARCH ps USING INTEGER PRIMARY KEY (rowid=?)"), SCHEMA)).toEqual([]);
    // A lone line naming `ps` fits both subqueries: it may be either, so it fails closed.
    expect(planSignatures(both, twoSubqueries("SCAN ps"), SCHEMA)).toEqual(["?: SCAN ps"]);
    // A CTE or derived table the plan does not materialize was flattened: a line naming its alias reads what its body
    // binds under that name.
    for (const flattened of [
      "WITH x AS (SELECT username FROM accounts a) SELECT * FROM x a",
      "WITH x AS NOT MATERIALIZED (SELECT username FROM accounts a) SELECT * FROM x a",
      "SELECT * FROM (SELECT username FROM accounts a) a",
    ]) {
      expect(planSignatures(flattened, tree([0, "SCAN a"]), SCHEMA), flattened).toEqual(["accounts: SCAN a"]);
    }
    // Flattened, but its body binds nothing under the name: unresolved.
    expect(
      planSignatures("WITH x AS (SELECT username FROM accounts b) SELECT * FROM x a", tree([0, "SCAN a"]), SCHEMA),
    ).toEqual(["?: SCAN a"]);
    // Materialized, the line reads the CTE's result.
    const materialized = "WITH x AS MATERIALIZED (SELECT username FROM accounts a) SELECT * FROM x a";
    expect(
      planSignatures(
        materialized,
        tree([0, "MATERIALIZE x"], [1, "SEARCH a USING INDEX sqlite_autoindex_accounts_1 (id=?)"], [0, "SCAN a"]),
        SCHEMA,
      ),
    ).toEqual([]);
    // One alias, two tables in different scopes: the line's scope decides.
    const twice = `SELECT 1 FROM accounts a WHERE EXISTS (SELECT 1 FROM statuses a WHERE a.id = ?)`;
    expect(planSignatures(twice, tree([0, "SCAN a"]), SCHEMA)).toEqual(["accounts: SCAN a"]);
    expect(planSignatures(twice, tree([0, "CORRELATED SCALAR SUBQUERY 1"], [1, "SCAN a"]), SCHEMA)).toEqual([
      "statuses: SCAN a",
    ]);
  });

  it("fails closed on a name it cannot resolve", () => {
    expect(signatures("SELECT 1 FROM accounts", "SCAN q")).toEqual(["?: SCAN q"]);
    // Two subqueries bind `a` to different tables, and the line could be in either.
    const two = `SELECT (SELECT 1 FROM accounts a WHERE a.id = ?), (SELECT 1 FROM statuses a WHERE a.id = ?)`;
    expect(planSignatures(two, tree([0, "SCALAR SUBQUERY 1"], [1, "SCAN a"]), SCHEMA)).toEqual(["?: SCAN a"]);
    // A join list in parentheses under one alias.
    const joined = "SELECT 1 FROM (accounts a JOIN statuses s ON s.account_id = a.id) j";
    expect(signatures(joined, "SCAN j")).toEqual(["?: SCAN j"]);
  });

  it("reads tables in parenthesized FROM items, comma joins and the targets of writes", () => {
    expect(signatures("SELECT a.username FROM (accounts) AS a", "SCAN a")).toEqual(["accounts: SCAN a"]);
    expect(signatures("SELECT 1 FROM (accounts a JOIN statuses s ON s.account_id = a.id)", "SCAN s", "SCAN a")).toEqual(
      ["accounts: SCAN a", "statuses: SCAN s"],
    );
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
    expect(bindsPattern('SELECT "like"(?, username) FROM accounts')).toBe(true);
    expect(bindsPattern("SELECT 1 FROM accounts WHERE glob(?, username)")).toBe(true);
    expect(bindsPattern("SELECT 1 FROM accounts WHERE username LIKE 'a%' AND id = ?")).toBe(false);
    expect(bindsPattern("SELECT 1 FROM accounts WHERE username LIKE 'a%' LIMIT ?")).toBe(false);
    expect(bindsPattern("SELECT 1 FROM accounts WHERE username LIKE 'a%' ORDER BY id LIMIT ?")).toBe(false);
    expect(bindsPattern("SELECT 1 FROM accounts WHERE x GLOB '*[^0-9]*' OR id = ?")).toBe(false);
    expect(bindsPattern("SELECT like('a%', ?) FROM accounts")).toBe(false);
    expect(bindsPattern("SELECT 'LIKE ?' FROM accounts WHERE id = ?")).toBe(false);
  });
});

describe("plan audit provenance", () => {
  const at = (frame: string) => `    at ${frame}`;
  const stack = (...frames: string[]) => ["Error", ...frames.map(at)].join("\n");
  const ROOT = "/w/packages/kopje";

  it("names the domain code that called Db, through native frames, up to the dispatch", () => {
    const traced = callerFrames(
      stack(
        `capture (${ROOT}/test/sql-depth-setup.ts:70:17)`,
        `Db.all (${ROOT}/test/sql-depth-setup.ts:120:5)`,
        `Db.first (${ROOT}/src/db/sql.ts:39:17)`,
        "Array.from (<anonymous>)",
        `reader (${ROOT}/src/domain/x.ts:10:3)`,
        `${ROOT}/src/domain/x.ts:20:5`,
        `Object.run (${ROOT}/src/domain/operation.ts:10:5)`,
        `${ROOT}/test/a.test.ts:5:1`,
      ),
    );
    expect(traced).toEqual({
      frames: ["src/domain/x.ts:10 reader", "src/domain/x.ts:20 <anonymous>"],
      production: true,
    });
  });

  it("tells a test's own statement from the domain code's", () => {
    const traced = callerFrames(
      stack(`Db.all (${ROOT}/test/sql-depth-setup.ts:120:5)`, `${ROOT}/test/a.test.ts:5:1`, `${ROOT}/src/x.ts:1:1`),
    );
    expect(traced).toEqual({ frames: ["test/a.test.ts:5 <anonymous>"], production: false });
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

  it("tells parameter samples apart by type and bytes", () => {
    const keys = [[1], ["1"], [null], [new Uint8Array([1]).buffer], [new Uint8Array([2]).buffer]].map(sampleKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(sampleKey([new Uint8Array([1]).buffer])).toBe(sampleKey([new Uint8Array([1]).buffer]));
  });
});

describe("plan audit baseline", () => {
  it("lists each identity once, with what is known of it", () => {
    const ids = PLAN_AUDIT_ENTRIES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of PLAN_AUDIT_ENTRIES) {
      expect(entry.scans.length).toBeGreaterThan(0);
      if (entry.disposition === "pending" || entry.disposition === "write") {
        expect(entry.issue, entry.id).toMatch(/^#1468 group [1-9]$/);
      } else {
        expect(entry.reason, entry.id).toMatch(/\S/);
      }
    }
  });

  // AC8: every row of #1468 is observed, outside the predicate, or unobserved; an identity a row names is an entry of
  // the row's group, recorded at one of the row's functions (or, for a fragment, scanning by its pattern), and named by
  // no other row.
  it("maps the rows of #1468 onto the entries", () => {
    const byId = new Map(PLAN_AUDIT_ENTRIES.map((entry) => [entry.id, entry]));
    const at = (frame: string, site: string) => {
      const [path, name] = site.split("#") as [string, string];
      if (!frame.startsWith(`${path}#`)) {
        return false;
      }
      const [head, enclosing] = frame.slice(path.length + 1).split(" in ");
      return head === name || head!.endsWith(`.${name}`) || enclosing === name;
    };
    const named = ROWS_1468.flatMap((row) => ("ids" in row && row.ids !== undefined ? row.ids : []));
    expect(new Set(named).size).toBe(named.length);
    expect(named.length).toBeGreaterThan(0);
    for (const row of ROWS_1468) {
      for (const id of "ids" in row && row.ids !== undefined ? row.ids : []) {
        const entry = byId.get(id);
        const where = `${row.statement}: ${id}`;
        expect(entry?.issue, where).toBe(`#1468 group ${row.group}`);
        const frames = entry!.site.split(" < ");
        if (row.sites.length > 0) {
          expect(
            frames.some((frame) => row.sites.some((site) => at(frame, site))),
            where,
          ).toBe(true);
        }
        if (row.scans !== undefined) {
          expect(
            entry!.scans.some((scan) => new RegExp(row.scans!).test(scan)),
            where,
          ).toBe(true);
        }
      }
    }
  });
});

describe("plan audit decision", () => {
  const failuresOf = (audited: AuditedStatement[], entries: PlanAuditEntry[]) =>
    auditDecision(audited, entries).failures;
  const sample = (violations: string[], error?: string) => ({
    params: ["x", 1, null],
    plan: rows("SCAN a"),
    violations,
    ...(error === undefined ? {} : { error }),
  });
  const statement = (id: string, violations: string[], error?: string): AuditedStatement => ({
    id,
    sql: "SELECT 1",
    sites: ["src/domain/x.ts:1 reader"],
    samples: [sample(violations, error)],
  });
  const entry = (id: string, scans: string[], extra: Partial<PlanAuditEntry> = {}): PlanAuditEntry => ({
    id,
    scans,
    site: "x",
    disposition: "pending",
    issue: "#1468 group 9",
    ...extra,
  });

  it("fails a scan no entry lists, with a paste-ready entry", () => {
    const [failure, ...rest] = failuresOf([statement("aa", ["accounts: SCAN a"])], []);
    expect(rest).toEqual([]);
    expect(failure).toContain("aa reads a whole table or index, and no entry lists it");
    expect(failure).toContain("sample 1, parameter types [string, number, null]:");
    expect(failure).toContain(
      'paste-ready entry: {"id":"aa","scans":["accounts: SCAN a"],"site":"src/domain/x.ts#reader","disposition":"pending","issue":"#1468"}',
    );
  });

  it("judges a statement by the union of its samples' violations", () => {
    const sampled: AuditedStatement = { ...statement("aa", []), samples: [sample([]), sample(["accounts: SCAN a"])] };
    expect(failuresOf([sampled], [])).toEqual([expect.stringContaining("    accounts: SCAN a")]);
    expect(failuresOf([sampled], [entry("aa", ["accounts: SCAN a"])])).toEqual([]);
  });

  it("passes a listed scan, and fails a new scan of a listed statement", () => {
    const listed = entry("aa", ["accounts: SCAN a"]);
    expect(failuresOf([statement("aa", ["accounts: SCAN a"])], [listed])).toEqual([]);
    const failures = failuresOf([statement("aa", ["accounts: SCAN a", "follows: SCAN f"])], [listed]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/offending lines:\n {4}follows: SCAN f$/m);
    // An entry lists one identity: another statement's same scan is not covered.
    expect(failuresOf([statement("bb", ["accounts: SCAN a"])], [listed])).toHaveLength(1);
  });

  // A plan can depend on a parameter another suite passes, so an absent scan is advice, never a failure.
  it("advises on a listed scan the suite's samples did not show, without failing", () => {
    const listed = entry("aa", ["accounts: SCAN a", "follows: SCAN f"]);
    expect(auditDecision([statement("aa", [])], [listed])).toEqual({
      failures: [],
      unseen: ["plan audit: aa did not read here: accounts: SCAN a; follows: SCAN f"],
    });
    expect(auditDecision([statement("aa", ["accounts: SCAN a"])], [listed])).toEqual({
      failures: [],
      unseen: ["plan audit: aa did not read here: follows: SCAN f"],
    });
    // A new scan of a listed statement still fails, with the advice beside it.
    const decision = auditDecision([statement("aa", ["quotes: SCAN q"])], [listed]);
    expect(decision.failures).toEqual([expect.stringMatching(/offending lines:\n {4}quotes: SCAN q$/m)]);
    expect(decision.unseen).toHaveLength(1);
  });

  it("does not judge an entry whose statement the run did not execute", () => {
    expect(failuresOf([statement("aa", [])], [entry("zz", ["accounts: SCAN a"])])).toEqual([]);
  });

  it("fails a statement it cannot plan unless listed as unplannable, and an identity listed twice", () => {
    expect(failuresOf([statement("aa", [], "no such table")], [])).toEqual([
      expect.stringContaining("EXPLAIN QUERY PLAN refused it: no such table"),
    ]);
    const unplannable = entry("aa", ["unplannable"], { disposition: "deliberate", reason: "r" });
    expect(failuresOf([statement("aa", [], "no such table")], [unplannable])).toEqual([]);
    expect(failuresOf([], [unplannable, unplannable])).toEqual([expect.stringContaining("aa is listed twice")]);
  });
});
