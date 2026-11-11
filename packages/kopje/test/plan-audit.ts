// The plan audit of RES-7 ("Queries" in docs/engineering.md): every statement the domain code runs in a Workers suite
// is planned with EXPLAIN QUERY PLAN on a Store holding singleton statistics (test/plan-audit-store.ts), and a plan that
// reads a whole table or index fails the suite unless an entry of test/plan-audit-entries.ts lists that statement and
// that scan. This module is the audit's pure part (identity, provenance, scope resolution, classification, the
// decision), shared by the suites' setup (test/sql-depth-setup.ts) and its own tests (test-node/plan-audit.test.ts).

// What is known of a listed scan:
// - pending: a request's read to fix, `issue` naming its tracking issue and group;
// - write: a request's UPDATE or DELETE that can scan, `issue` as for pending;
// - background: a job or round traversal, `reason` citing the round's bound;
// - bounded: a table whose size a trigger, a CHECK or a reviewed constant bounds, `reason` citing it;
// - deliberate: a documented scan, `reason` citing the document.
export type Disposition = "pending" | "write" | "background" | "bounded" | "deliberate";

// A reviewed scan of one statement identity. `scans` are signatures as planSignatures gives them, or `unplannable` for
// a statement EXPLAIN QUERY PLAN refuses on the audit Store (one that names runtime state, for example), which an entry
// lists only with a `reason`. `site` is where the suites saw it run (metadata; the identity is the key). `witness`
// names a test showing the bound.
export type PlanAuditEntry = {
  id: string;
  scans: readonly string[];
  site: string;
  disposition: Disposition;
  issue?: string;
  reason?: string;
  witness?: string;
};

export const UNPLANNABLE = "unplannable";

// A row of EXPLAIN QUERY PLAN.
export type PlanRow = { id: number; parent: number; detail: string };

// The Store's schema as the classifier needs it: its tables, and the table of each index.
export type PlanSchema = { tables: ReadonlySet<string>; indexes: ReadonlyMap<string, string> };

// One sample of a statement's parameters, as planned on the audit Store: its plan and violations, or why EXPLAIN QUERY
// PLAN refused it.
export type PlannedSample = {
  params: readonly unknown[];
  plan: readonly PlanRow[];
  violations: readonly string[];
  error?: string;
};

// A statement a suite executed, with each sample of its parameters as planned.
export type AuditedStatement = { id: string; sql: string; sites: readonly string[]; samples: readonly PlannedSample[] };

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

// A statement's parameters as one sample's key: values of different types or bytes are different samples.
export function sampleKey(params: readonly unknown[]): string {
  return JSON.stringify(
    params.map((value) =>
      value instanceof ArrayBuffer
        ? { blob: [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("") }
        : { [typeof value]: value },
    ),
  );
}

// Where the operations dispatch: a chain of callers ends there.
const DISPATCH = new Set(["src/domain/operation.ts", "src/platform/store-kernel.ts"]);
const RECORDER = new Set(["test/sql-depth-setup.ts", "src/db/sql.ts"]);

// The callers of a call into Db from its stack, innermost first, each as `file:line function` with the file relative to
// the package: the frames under src/ up to the operations' dispatch, or the one frame that called Db when no domain
// code did. The recorder's and Db's own frames are dropped, and so are native frames (`Array.from (<anonymous>)`,
// through which a bound Db method can be called); `production` is whether the first frame with a source file is
// under src/.
export function callerFrames(stack: string): { frames: string[]; production: boolean } {
  const frames: string[] = [];
  for (const line of stack.split("\n").slice(1)) {
    const frame = /^\s*at (?:(.*?) \()?(.*?):(\d+):\d+\)?$/.exec(line);
    if (frame === null) {
      continue;
    }
    const file = frame[2]!.replace(/^.*\/packages\/kopje\//, "");
    if (RECORDER.has(file)) {
      continue;
    }
    if (DISPATCH.has(file) || (frames.length > 0 && !file.startsWith("src/"))) {
      break;
    }
    frames.push(`${file}:${frame[3]} ${frame[1] ?? "<anonymous>"}`);
    if (!file.startsWith("src/")) {
      break;
    }
  }
  return { frames, production: frames[0]?.startsWith("src/") ?? false };
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
const QUERY_START = new Set(["SELECT", "VALUES", "WITH"]);

// What a name in a plan can stand for: a base table, the result of a CTE or subquery, or a table-valued function.
type Target = { table: string } | "derived" | "function";

// A query scope: the top-level statement, a CTE's body or a subquery, with the names its FROM items bind (a compound
// select's members share their scope). `name` is the CTE's name or the derived table's alias, as a plan names it.
export type QueryScope = { name: string | undefined; bindings: Map<string, Target[]>; children: QueryScope[] };

function nameOf(token: Token): string {
  return (token.kind === "quoted" ? token.text.slice(1, -1) : token.text).toLowerCase();
}

// The query scopes of `sql`, from the top-level statement down.
export function queryScopes(sql: string, schema: PlanSchema): QueryScope {
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
  const startsQuery = (open: number) => tokens[open]?.text === "(" && QUERY_START.has(upper(open + 1));
  // CTEs: `name [(columns)] AS [[NOT] MATERIALIZED] (SELECT | VALUES | WITH …)`, by the parenthesis of the body.
  const ctes = new Set<string>();
  const named = new Map<number, string>();
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
    if (startsQuery(k)) {
      ctes.add(nameOf(tokens[n]!));
      named.set(k, nameOf(tokens[n]!));
    }
  }
  const root: QueryScope = { name: undefined, bindings: new Map(), children: [] };
  // Each open parenthesis: its scope, and whether its FROM list has begun (a comma there adds an item).
  const frames: { scope: QueryScope; inFrom: boolean }[] = [{ scope: root, inFrom: false }];
  const top = () => frames.at(-1)!;
  const bind = (name: string, target: Target) => {
    const { bindings } = top().scope;
    bindings.set(name, [...(bindings.get(name) ?? []), target]);
  };
  // Parenthesized FROM items that hold tables or joins rather than a query: their items are read inside them.
  const tableLists = new Set<number>();
  // A FROM item at token n, introduced by `keyword`; the index to go on from.
  const item = (n: number, keyword: string): number => {
    if (tokens[n]?.text === "(") {
      const close = match(n);
      let k = close + 1;
      if (upper(k) === "AS") {
        k++;
      }
      const alias = isName(k) ? nameOf(tokens[k]!) : undefined;
      if (startsQuery(n)) {
        if (alias !== undefined) {
          named.set(n, alias);
          bind(alias, "derived");
        }
      } else {
        tableLists.add(n);
        // `(t) AS a` names the table t; an alias of a join list is left unbound, so a plan line naming it fails closed.
        if (alias !== undefined && close === n + 2 && isName(n + 1)) {
          bind(alias, { table: nameOf(tokens[n + 1]!) });
        }
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
  for (let n = 0; n < tokens.length; n++) {
    const text = tokens[n]!.text;
    const keyword = upper(n);
    if (text === "(") {
      if (startsQuery(n)) {
        const scope: QueryScope = { name: named.get(n), bindings: new Map(), children: [] };
        top().scope.children.push(scope);
        frames.push({ scope, inFrom: false });
      } else if (tableLists.has(n)) {
        frames.push({ scope: top().scope, inFrom: true });
        n = item(n + 1, "FROM") - 1;
      } else {
        frames.push({ scope: top().scope, inFrom: false });
      }
    } else if (text === ")") {
      if (frames.length > 1) {
        frames.pop();
      }
    } else if (text === "," && top().inFrom) {
      n = item(n + 1, "FROM") - 1;
    } else if (ENDS_FROM.has(keyword)) {
      top().inFrom = false;
    } else if ((keyword === "FROM" && upper(n - 1) !== "DISTINCT") || keyword === "JOIN") {
      top().inFrom = true;
      n = item(n + 1, "FROM") - 1;
    } else if (keyword === "UPDATE" || keyword === "INTO") {
      n = item(n + 1, keyword) - 1;
    }
  }
  return root;
}

function descendants(scope: QueryScope): QueryScope[] {
  return scope.children.flatMap((child) => [child, ...descendants(child)]);
}

// What `name` stands for in `scopes`: in their own bindings first, then in the scopes nested in them (a subquery or CTE
// the planner flattened into them names its tables there). A base table when every binding found agrees on it; null
// when each is a CTE's or subquery's result or a table-valued function; `?` otherwise (unbound, or bound to different
// things).
function resolveName(name: string, scopes: readonly QueryScope[]): string | null {
  const own = scopes.flatMap((scope) => scope.bindings.get(name) ?? []);
  const nested = scopes.flatMap(descendants).flatMap((scope) => scope.bindings.get(name) ?? []);
  const targets = own.length > 0 ? own : nested;
  if (targets.length > 0 && targets.every((t) => t === "derived" || t === "function")) {
    return null;
  }
  const tables = new Set(targets.map((t) => (typeof t === "object" ? t.table : "?")));
  return tables.size === 1 && !tables.has("?") ? [...tables][0]! : "?";
}

const NAMED_CONTAINER = /^(?:MATERIALIZE|CO-ROUTINE) (\S+)$/;
const isContainer = (detail: string) => NAMED_CONTAINER.test(detail) || /SUBQUERY \d+$/.test(detail);
const PLAN_NAME = /^(?:SCAN|SEARCH|BLOOM FILTER ON|MATERIALIZE|CO-ROUTINE) (\S+)/;

// The plan as a tree: each row's children.
function childrenOf(plan: readonly PlanRow[]): Map<number, PlanRow[]> {
  const children = new Map<number, PlanRow[]>();
  for (const row of plan) {
    children.set(row.parent, [...(children.get(row.parent) ?? []), row]);
  }
  return children;
}

// The names a container's own lines use (a compound's members included, a nested subquery's lines not).
function containerNames(container: PlanRow, children: ReadonlyMap<number, PlanRow[]>): Set<string> {
  const names = new Set<string>();
  const visit = (row: PlanRow) => {
    for (const child of children.get(row.id) ?? []) {
      const name = PLAN_NAME.exec(child.detail)?.[1]
        ?.replace(/^main\./, "")
        .toLowerCase();
      if (name !== undefined && name !== "constant" && !name.startsWith("(")) {
        names.add(name);
      }
      if (!isContainer(child.detail)) {
        visit(child);
      }
    }
  };
  visit(container);
  return names;
}

// Whether `scope`, or a scope nested in it, binds or defines `name`.
function knows(scope: QueryScope, name: string): boolean {
  return [scope, ...descendants(scope)].some(
    (s) => s.bindings.has(name) || s.children.some((child) => child.name === name),
  );
}

// The scopes a plan line belongs to. Its nearest MATERIALIZE or CO-ROUTINE ancestor names a CTE's body or a derived
// table, else the line is in the statement; each unnamed subquery between is the deepest unnamed scope (an expression
// subquery, or a derived table without an alias) nested in the last that knows every name its own lines use; where
// none does, every nested scope, which can only make the line's name ambiguous.
function lineScopes(
  row: PlanRow,
  byId: ReadonlyMap<number, PlanRow>,
  children: ReadonlyMap<number, PlanRow[]>,
  root: QueryScope,
): QueryScope[] {
  const path: PlanRow[] = [];
  let scopes: QueryScope[] = [root];
  const seen = new Set<number>();
  for (let parent = byId.get(row.parent); parent !== undefined; parent = byId.get(parent.parent)) {
    if (seen.has(parent.id)) {
      break;
    }
    seen.add(parent.id);
    const container = NAMED_CONTAINER.exec(parent.detail)?.[1];
    if (container !== undefined && !container.startsWith("(")) {
      const name = container.toLowerCase();
      const named = [root, ...descendants(root)].filter((scope) => scope.name === name);
      scopes = named.length > 0 ? named : [root];
      break;
    }
    if (isContainer(parent.detail)) {
      path.unshift(parent);
    }
  }
  for (const container of path) {
    const names = [...containerNames(container, children)];
    const nested = scopes.flatMap(descendants);
    const fitting = nested.filter((scope) => scope.name === undefined && names.every((name) => knows(scope, name)));
    const deepest = fitting.filter((scope) => !descendants(scope).some((inner) => fitting.includes(inner)));
    scopes = deepest.length > 0 ? deepest : nested;
  }
  return scopes;
}

// The lines of `plan` that read a whole table or index of a base table (a scan, through an index or not; an
// automatic index or a Bloom filter, built by reading one; a skip-scan, `ANY(…)`), at any depth, each as
// `table: detail`. The table is the one the line's index belongs to, else what its name stands for in the line's own
// query scope (resolveName); `?` when that is not one base table, which is a violation too. A virtual table, a constant
// row, or a CTE's or subquery's result is not one: the lines that fill those are checked themselves.
export function planSignatures(sql: string, plan: readonly PlanRow[], schema: PlanSchema): string[] {
  let root: QueryScope | undefined;
  const byId = new Map(plan.map((row) => [row.id, row]));
  const children = childrenOf(plan);
  const signatures: string[] = [];
  for (const row of plan) {
    const { detail } = row;
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
      root ??= queryScopes(sql, schema);
      const resolved = resolveName(name, lineScopes(row, byId, children, root));
      if (resolved === null) {
        continue;
      }
      table = resolved;
    }
    signatures.push(`${table}: ${detail}`);
  }
  return [...new Set(signatures)].toSorted();
}

// Words that end the operand after LIKE or GLOB.
const OPERAND_END = new Set(
  (
    "AND OR NOT ESCAPE THEN WHEN ELSE END LIMIT OFFSET ORDER GROUP HAVING WHERE FROM ON USING JOIN UNION EXCEPT " +
    "INTERSECT RETURNING WINDOW IS IN BETWEEN COLLATE AS ASC DESC LIKE GLOB MATCH REGEXP SELECT"
  ).split(" "),
);

// Whether a LIKE or GLOB pattern of `sql` takes a parameter: the operand after the operator (up to the end of its
// expression), or the first argument of the like() or glob() function, quoted or not. Without STAT4 a bound value
// changes a plan through such a pattern (the LIKE optimization re-prepares with it) and through a partial index's
// condition; the audit plans each statement with the samples the suites gave it, so the domain SQL keeps its
// patterns literal.
export function bindsPattern(sql: string): boolean {
  const { tokens } = tokenize(sql);
  const wordOf = (t: Token | undefined) =>
    t === undefined ? "" : t.kind === "word" || t.kind === "quoted" ? nameOf(t).toUpperCase() : "";
  for (let n = 0; n < tokens.length; n++) {
    const word = wordOf(tokens[n]);
    if (word !== "LIKE" && word !== "GLOB") {
      continue;
    }
    const call = tokens[n + 1]?.text === "(";
    if (!call && tokens[n]!.kind !== "word") {
      continue;
    }
    let depth = 0;
    for (let k = n + 1; k < tokens.length; k++) {
      const t = tokens[k]!;
      if (t.text === "(") {
        depth++;
      } else if (t.text === ")") {
        if (--depth < 0 || (call && depth === 0)) {
          break;
        }
      } else if (depth === (call ? 1 : 0) && (t.text === "," || (t.kind === "word" && OPERAND_END.has(wordOf(t))))) {
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

const typeOf = (p: unknown) => (p === null ? "null" : p instanceof ArrayBuffer ? "blob" : typeof p);

// A statement's violations over all its samples, `unplannable` for a sample EXPLAIN QUERY PLAN refused.
export function violationsOf(statement: AuditedStatement): string[] {
  const found = statement.samples.flatMap((sample) => (sample.error === undefined ? sample.violations : [UNPLANNABLE]));
  return [...new Set(found)].toSorted();
}

// The audit's decision on the statements a suite executed: a failure for each statement with a violation (in any
// sample of its parameters) that no entry for its identity lists, or a refusal to plan it; for each listed scan that
// no longer appears (remove it, or the whole entry); and for an identity listed twice. Entries of statements the suite
// did not execute are not judged.
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
    const found = violationsOf(statement);
    const entry = byId.get(statement.id);
    const listed = new Set(entry?.scans ?? []);
    const unlisted = found.filter((scan) => !listed.has(scan));
    const gone = [...listed].filter((scan) => !found.includes(scan));
    const context = [
      `  sites: ${statement.sites.join(", ")}`,
      `  sql: ${normalizeSql(statement.sql)}`,
      ...statement.samples.map((sample, n) =>
        [
          `  sample ${n + 1}, parameter types [${sample.params.map(typeOf).join(", ")}]:`,
          sample.error === undefined
            ? `  plan (singleton statistics):\n${planTree(sample.plan)}`
            : `  EXPLAIN QUERY PLAN refused it: ${sample.error}`,
        ].join("\n"),
      ),
    ];
    if (unlisted.length > 0) {
      const site = (statement.sites[0] ?? "").replaceAll(/:\d+ /g, "#");
      const paste = { id: statement.id, scans: found, site, disposition: "pending", issue: "#1468" };
      failures.push(
        [
          unlisted.includes(UNPLANNABLE)
            ? `plan audit: ${statement.id} cannot be planned on the audit Store, and no entry lists it`
            : `plan audit: ${statement.id} reads a whole table or index, and no entry lists it`,
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
