import { CatalogError } from "./dump-catalog";
import { isLiteral, type TableSpec } from "./dump-format";
import { bindAll, quoteIdentifier, readColumn, textLiteral, valueLiteral } from "./dump-literals";

// The rows of a table of the dump catalog (dump-catalog.ts), read in its order as canonical literals.

export type ScanMode = "rows" | "links";

// One row of a scan: the ordering key (to resume after it) and the canonical literals (dump-literals.ts) of the
// selected columns. In rows mode those are all columns; in links mode the deferred columns followed by the primary
// key columns.
export type ScannedRow = { after: string[]; literals: string[] };

// Reads a table in its order, starting after a cursor key, and hands each row to `visit` until it returns false.
export function scanTable(
  sql: SqlStorage,
  spec: TableSpec,
  mode: ScanMode,
  after: readonly string[] | null,
  visit: (row: ScannedRow) => boolean,
): void {
  const byRowid = spec.order.by === "rowid";
  const orderColumns = spec.order.by === "key" ? spec.order.columns : [];
  const selected = mode === "rows" ? spec.columns : [...spec.deferred, ...spec.key];
  const where: string[] = [];
  const bindings: SqlStorageValue[] = [];
  if (spec.only !== undefined) {
    where.push(`${quoteIdentifier(spec.only.column)} IN (${spec.only.values.map(textLiteral).join(",")})`);
  }
  if (mode === "links") {
    where.push(`(${spec.deferred.map((c) => `${quoteIdentifier(c)} IS NOT NULL`).join(" OR ")})`);
  }
  if (after !== null) {
    if (byRowid) {
      if (after.length !== 1 || !/^-?\d{1,19}$/.test(after[0] ?? "")) {
        throw new CatalogError(`invalid cursor key for ${spec.name}`);
      }
      where.push("rowid > CAST(? AS INTEGER)");
      bindings.push(after[0] ?? "");
    } else {
      if (after.length !== orderColumns.length || !after.every(isLiteral)) {
        throw new CatalogError(`invalid cursor key for ${spec.name}`);
      }
      let bound;
      try {
        bound = bindAll(after);
      } catch {
        throw new CatalogError(`invalid cursor key for ${spec.name}`);
      }
      where.push(`(${orderColumns.map(quoteIdentifier).join(",")}) > (${bound.exprs.join(",")})`);
      bindings.push(...bound.params);
    }
  }
  const keyColumns = byRowid ? ["CAST(rowid AS TEXT)"] : orderColumns.flatMap(readColumn);
  const order = byRowid ? "rowid" : orderColumns.map(quoteIdentifier).join(",");
  const query =
    `SELECT ${[...keyColumns, ...selected.flatMap(readColumn)].join(", ")} FROM ${quoteIdentifier(spec.name)}` +
    (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
    ` ORDER BY ${order}`;
  const keyWidth = keyColumns.length;
  for (const raw of sql.exec(query, ...bindings).raw()) {
    const keys = byRowid ? [raw[0] as string] : pairsToLiterals(raw, 0, keyWidth);
    if (!visit({ after: keys, literals: pairsToLiterals(raw, keyWidth, raw.length) })) {
      return;
    }
  }
}

function pairsToLiterals(raw: SqlStorageValue[], from: number, to: number): string[] {
  const literals: string[] = [];
  for (let i = from; i < to; i += 2) {
    literals.push(valueLiteral(raw[i] ?? null, raw[i + 1] ?? null));
  }
  return literals;
}

// Whether a table has a dumped row (kopje_state: an allowlisted one) outside `except`. EXISTS stops at the first
// row; count(*) would scan the table.
export function hasRows(
  sql: SqlStorage,
  spec: TableSpec,
  except?: { column: string; values: readonly string[] },
): boolean {
  const where: string[] = [];
  if (spec.only !== undefined) {
    where.push(`${quoteIdentifier(spec.only.column)} IN (${spec.only.values.map(textLiteral).join(",")})`);
  }
  if (except !== undefined) {
    where.push(`${quoteIdentifier(except.column)} NOT IN (${except.values.map(() => "?").join(",")})`);
  }
  const filter = where.length === 0 ? "" : ` WHERE ${where.join(" AND ")}`;
  const query = `SELECT EXISTS (SELECT 1 FROM ${quoteIdentifier(spec.name)}${filter}) AS found`;
  return sql.exec<{ found: number }>(query, ...(except?.values ?? [])).one().found === 1;
}
