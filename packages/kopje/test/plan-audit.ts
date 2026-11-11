// The plan audit of RES-7 ("Queries" in docs/engineering.md): every statement the domain code runs in a Workers suite
// is planned with EXPLAIN QUERY PLAN on a Store holding singleton statistics (test/plan-audit-store.ts), and a plan that
// reads a whole table or index fails the suite unless an entry of test/plan-audit-entries.ts lists that statement and
// that scan. This module is the audit's pure part (identity, scope resolution, classification, the decision), shared by
// the suites' setup (test/sql-depth-setup.ts) and its own tests (test-node/plan-audit.test.ts).

// A reviewed scan of one statement. `scans` are signatures as planSignatures gives them. `issue` names the tracking issue
// and group of a scan to fix; `reason` the bound that makes a deliberate scan safe, with the `witness` test showing it.
export type PlanAuditEntry = {
  id: string;
  scans: readonly string[];
  site: string;
  issue?: string;
  reason?: string;
  witness?: string;
};

// A row of EXPLAIN QUERY PLAN.
export type PlanRow = { id: number; parent: number; detail: string };

// The Store's schema as the classifier needs it: its tables, and the table of each index.
export type PlanSchema = { tables: ReadonlySet<string>; indexes: ReadonlyMap<string, string> };

// A statement a suite executed, as planned on the audit Store: its plan, or why EXPLAIN QUERY PLAN refused it.
export type AuditedStatement = {
  id: string;
  sql: string;
  params: readonly unknown[];
  sites: readonly string[];
  plan: readonly PlanRow[];
  // planSignatures of the plan; empty when EXPLAIN QUERY PLAN refused the statement (`error`).
  violations: readonly string[];
  error?: string;
};

type Token = { kind: "word" | "quoted" | "string" | "param" | "punct"; start: number; end: number; text: string };

// The tokens of `sql` with their source spans, and whether a separator (whitespace or a comment) precedes each.
function tokenize(sql: string): { tokens: Token[]; separated: boolean[] } {
  const tokens: Token[] = [];
  const separated: boolean[] = [];
  let gap = false;
  let i = 0;
  const closing = (from: number, close: string, doubled: boolean): number => {
    let j = from + 1;
    while (j < sql.length) {
      if (sql[j] === close) {
        if (doubled && sql[j + 1] === close) {
          j += 2;
          continue;
        }
        return j + 1;
      }
      j++;
    }
    return sql.length;
  };
  const push = (kind: Token["kind"], end: number) => {
    tokens.push({ kind, start: i, end, text: sql.slice(i, end) });
    separated.push(gap);
    gap = false;
    i = end;
  };
  while (i < sql.length) {
    const c = sql[i]!;
    if (/\s/.test(c)) {
      gap = true;
      i++;
    } else if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
      gap = true;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      gap = true;
    } else if (c === "'") {
      push("string", closing(i, "'", true));
    } else if (c === '"') {
      push("quoted", closing(i, '"', true));
    } else if (c === "`") {
      push("quoted", closing(i, "`", true));
    } else if (c === "[") {
      push("quoted", closing(i, "]", false));
    } else if (c === "?") {
      push("param", i + 1 + (/^\d*/.exec(sql.slice(i + 1))?.[0].length ?? 0));
    } else if ((c === ":" || c === "@" || c === "$") && /[A-Za-z_]/.test(sql[i + 1] ?? "")) {
      push("param", i + 1 + /^[\w$]*/.exec(sql.slice(i + 1))![0].length);
    } else if (/[\w\u0080-￿]/.test(c)) {
      push("word", i + /^[\w$\u0080-￿]*/.exec(sql.slice(i))![0].length);
    } else {
      push("punct", i + 1);
    }
  }
  return { tokens, separated };
}

// The statement's text as it identifies it: comments dropped and each run of whitespace and comments made one space,
// every token kept as its source spells it (literals, placeholders and their numbering, schema qualifiers), since
// each of those can change a plan (`IN (?)` and `IN (?, ?)`; `main.` changes name resolution).
export function normalizeSql(sql: string): string {
  const { tokens, separated } = tokenize(sql);
  return tokens.map((token, n) => (n > 0 && separated[n] ? " " : "") + token.text).join("");
}

// The identity of a statement: the first 16 hex digits of the SHA-256 of normalizeSql.
export async function statementId(sql: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalizeSql(sql)));
  return [...new Uint8Array(digest).subarray(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const NOT_ALIAS = new Set(
  (
    "ON USING WHERE JOIN LEFT RIGHT FULL INNER OUTER CROSS NATURAL INDEXED NOT GROUP ORDER LIMIT OFFSET HAVING WINDOW " +
    "UNION EXCEPT INTERSECT RETURNING SET VALUES SELECT DEFAULT DO WHEN THEN ELSE END AND OR FROM AS"
  ).split(" "),
);
const ENDS_FROM = new Set(
  "WHERE GROUP ORDER LIMIT HAVING WINDOW UNION EXCEPT INTERSECT RETURNING SET VALUES SELECT".split(" "),
);

// What a name in a plan can stand for: a base table, the result of a CTE or subquery, or a table-valued function.
type Target = { table: string } | "derived" | "function";

function nameOf(token: Token): string {
  return (token.kind === "quoted" ? token.text.slice(1, -1) : token.text).toLowerCase();
}

// Each name the statement gives a FROM item (its alias, else its own name), in every scope, with what it stands for.
// A name bound in several scopes keeps each binding, so a plan line naming it resolves only when they agree.
export function nameBindings(sql: string, schema: PlanSchema): Map<string, Target[]> {
  const { tokens } = tokenize(sql);
  const upper = (n: number) => (tokens[n]?.kind === "word" ? tokens[n].text.toUpperCase() : "");
  const isName = (n: number) =>
    tokens[n] !== undefined && (tokens[n].kind === "quoted" || (tokens[n].kind === "word" && !NOT_ALIAS.has(upper(n))));
  const match = (open: number): number => {
    let depth = 0;
    for (let n = open; n < tokens.length; n++) {
      if (tokens[n]!.text === "(") {
        depth++;
      } else if (tokens[n]!.text === ")" && --depth === 0) {
        return n;
      }
    }
    return tokens.length - 1;
  };
  // CTE names: `name [(columns)] AS [[NOT] MATERIALIZED] (SELECT | VALUES | WITH …)`.
  const ctes = new Set<string>();
  for (let n = 0; n < tokens.length; n++) {
    if (!isName(n)) {
      continue;
    }
    let k = n + 1;
    if (tokens[k]?.text === "(") {
      k = match(k) + 1;
    }
    if (upper(k) !== "AS") {
      continue;
    }
    k++;
    if (upper(k) === "NOT") {
      k++;
    }
    if (upper(k) === "MATERIALIZED") {
      k++;
    }
    if (tokens[k]?.text === "(" && ["SELECT", "VALUES", "WITH"].includes(upper(k + 1))) {
      ctes.add(nameOf(tokens[n]!));
    }
  }
  const bindings = new Map<string, Target[]>();
  const bind = (name: string, target: Target) => {
    const list = bindings.get(name) ?? [];
    list.push(target);
    bindings.set(name, list);
  };
  // A FROM item at token n, introduced by `keyword`; the index to go on from. A parenthesized item binds its alias,
  // and its own items are read as the walk enters it.
  const item = (n: number, keyword: string): number => {
    if (tokens[n]?.text === "(") {
      let k = match(n) + 1;
      if (upper(k) === "AS") {
        k++;
      }
      if (isName(k)) {
        bind(nameOf(tokens[k]!), "derived");
      }
      return n;
    }
    if (keyword === "UPDATE" && upper(n) === "OR") {
      n += 2;
    }
    if (!isName(n)) {
      return n + 1;
    }
    let name = nameOf(tokens[n]!);
    let k = n + 1;
    if (tokens[k]?.text === "." && tokens[k + 1] !== undefined) {
      name = nameOf(tokens[k + 1]!);
      k += 2;
    }
    let target: Target[];
    if (keyword !== "INTO" && tokens[k]?.text === "(") {
      target = ["function"];
      k = match(k) + 1;
    } else if (ctes.has(name)) {
      target = schema.tables.has(name) ? ["derived", { table: name }] : ["derived"];
    } else {
      target = [{ table: name }];
    }
    let alias = name;
    if (upper(k) === "AS" && isName(k + 1)) {
      alias = nameOf(tokens[k + 1]!);
      k += 2;
    } else if (keyword !== "INTO" && isName(k)) {
      alias = nameOf(tokens[k]!);
      k++;
    }
    for (const t of target) {
      bind(alias, t);
    }
    return k;
  };
  // Whether the FROM list of each open parenthesis (and of the top level) has begun, so a comma there adds an item.
  const inFrom: boolean[] = [false];
  for (let n = 0; n < tokens.length; n++) {
    const text = tokens[n]!.text;
    const keyword = upper(n);
    if (text === "(") {
      inFrom.push(false);
    } else if (text === ")") {
      if (inFrom.length > 1) {
        inFrom.pop();
      }
    } else if (text === "," && inFrom.at(-1) === true) {
      n = item(n + 1, "FROM") - 1;
    } else if (ENDS_FROM.has(keyword)) {
      inFrom[inFrom.length - 1] = false;
    } else if ((keyword === "FROM" && upper(n - 1) !== "DISTINCT") || keyword === "JOIN") {
      inFrom[inFrom.length - 1] = true;
      n = item(n + 1, "FROM") - 1;
    } else if (keyword === "UPDATE" || keyword === "INTO") {
      n = item(n + 1, keyword) - 1;
    }
  }
  return bindings;
}

// The lines of `plan` that read a whole table or index of a base table (a scan, through an index or not; an
// automatic index or a Bloom filter, built by reading one; a skip-scan, `ANY(…)`), at any depth, each as
// `table: detail`. Its name resolves within the statement (nameBindings), or through the index it names; a name that
// does not resolve to one base table is `?`, a violation too. A virtual table, a constant row, or a CTE's or
// subquery's result is not one: the lines that fill those are checked themselves.
export function planSignatures(sql: string, plan: readonly PlanRow[], schema: PlanSchema): string[] {
  let bindings: Map<string, Target[]> | undefined;
  const signatures: string[] = [];
  for (const { detail } of plan) {
    const line =
      /^SCAN (\S+)/.exec(detail) ??
      /^SEARCH (\S+) USING AUTOMATIC /.exec(detail) ??
      /^BLOOM FILTER ON (\S+)/.exec(detail) ??
      /^SEARCH (\S+) .*\(ANY\(/.exec(detail);
    if (line === null || detail === "SCAN CONSTANT ROW" || detail.includes(" VIRTUAL TABLE")) {
      continue;
    }
    const name = line[1]!.replace(/^main\./, "").toLowerCase();
    const index = /USING (?:COVERING )?INDEX (\S+)/.exec(detail)?.[1];
    let table = index === undefined ? undefined : schema.indexes.get(index);
    if (table === undefined) {
      if (name.startsWith("(subquery-")) {
        continue;
      }
      bindings ??= nameBindings(sql, schema);
      const targets = bindings.get(name) ?? [];
      if (targets.length > 0 && targets.every((t) => t === "derived" || t === "function")) {
        continue;
      }
      const tables = new Set(targets.map((t) => (typeof t === "object" ? t.table : t)));
      table = tables.size === 1 && targets.every((t) => typeof t === "object") ? [...tables][0]! : "?";
    }
    signatures.push(`${table}: ${detail}`);
  }
  return [...new Set(signatures)].toSorted();
}

// Whether a LIKE or GLOB pattern of `sql` takes a parameter. Without STAT4 a bound value changes the plan only there
// (the LIKE optimization re-prepares with the value), and the audit plans each statement with one sample of its
// parameters, so the domain SQL keeps its patterns literal.
export function bindsPattern(sql: string): boolean {
  const { tokens } = tokenize(sql);
  const stops = new Set(["AND", "OR", "ESCAPE", "THEN", "WHEN", "ELSE", "END"]);
  for (let n = 0; n < tokens.length; n++) {
    const word = tokens[n]!.kind === "word" ? tokens[n]!.text.toUpperCase() : "";
    if (word !== "LIKE" && word !== "GLOB") {
      continue;
    }
    // The function form like(pattern, value): its first argument; the operator form: the operand that follows.
    const call = tokens[n + 1]?.text === "(";
    let depth = 0;
    for (let k = n + 1; k < tokens.length; k++) {
      const t = tokens[k]!;
      if (t.text === "(") {
        depth++;
      } else if (t.text === ")") {
        if (--depth < 0 || (call && depth === 0)) {
          break;
        }
      } else if (
        depth === (call ? 1 : 0) &&
        (t.text === "," || (t.kind === "word" && stops.has(t.text.toUpperCase())))
      ) {
        break;
      } else if (t.kind === "param") {
        return true;
      }
    }
  }
  return false;
}

// The plan as EXPLAIN QUERY PLAN's tree, one line a row, indented by depth.
export function planTree(plan: readonly PlanRow[]): string {
  const depth = new Map<number, number>();
  return plan
    .map((row) => {
      const d = (depth.get(row.parent) ?? -1) + 1;
      depth.set(row.id, d);
      return `${"  ".repeat(d + 1)}${row.detail}`;
    })
    .join("\n");
}

const UNPLANNABLE = "unplannable";

// The audit's decision on the statements a suite executed: a failure for each statement with a violation no entry for
// its identity lists, or a refusal to plan it; for each listed scan that no longer appears (remove it, or the whole
// entry); and for an identity listed twice. Entries of statements the suite did not execute are not judged.
export function auditFailures(audited: readonly AuditedStatement[], entries: readonly PlanAuditEntry[]): string[] {
  const failures: string[] = [];
  const byId = new Map<string, PlanAuditEntry>();
  for (const entry of entries) {
    if (byId.has(entry.id)) {
      failures.push(`plan audit: ${entry.id} is listed twice in test/plan-audit-entries.ts`);
    }
    byId.set(entry.id, entry);
  }
  for (const statement of audited) {
    const found = statement.error === undefined ? statement.violations : [UNPLANNABLE];
    const entry = byId.get(statement.id);
    const listed = new Set(entry?.scans ?? []);
    const unlisted = found.filter((scan) => !listed.has(scan));
    const gone = [...listed].filter((scan) => !found.includes(scan));
    const context = [
      `  sites: ${statement.sites.join(", ")}`,
      `  sql: ${normalizeSql(statement.sql)}`,
      `  parameter types: [${statement.params.map((p) => (p === null ? "null" : p instanceof ArrayBuffer ? "blob" : typeof p)).join(", ")}]`,
      statement.error === undefined
        ? `  plan (singleton statistics):\n${planTree(statement.plan)}`
        : `  EXPLAIN QUERY PLAN refused it: ${statement.error}`,
    ];
    if (unlisted.length > 0) {
      const site = (statement.sites[0] ?? "").replaceAll(/:\d+ /g, "#");
      const paste = { id: statement.id, scans: found, site, issue: "#1468" };
      failures.push(
        [
          statement.error === undefined
            ? `plan audit: ${statement.id} reads a whole table or index, and no entry lists it`
            : `plan audit: ${statement.id} cannot be planned on the audit Store, and no entry lists it`,
          ...context,
          `  offending lines:\n${unlisted.map((scan) => `    ${scan}`).join("\n")}`,
          `  paste-ready entry: ${JSON.stringify(paste)}`,
        ].join("\n"),
      );
    }
    if (entry !== undefined && gone.length > 0) {
      failures.push(
        [
          gone.length === listed.size
            ? `plan audit: ${statement.id} no longer reads what its entry lists: remove this entry`
            : `plan audit: ${statement.id} no longer reads ${gone.join("; ")}: remove these scans from its entry`,
          ...context,
        ].join("\n"),
      );
    }
  }
  return failures;
}
