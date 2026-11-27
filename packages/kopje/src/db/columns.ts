import { ROW_OBJECT_BYTES, VALUE_BYTES } from "./sql";

// A query's result columns as one map (name to SQL expression) generate both its select list and its row heap bound,
// so the bound cannot drift from what it reads (RES-3, "Heap at 8 MiB per answer" in docs/threat-model.md). Imports
// only src/db/sql.ts, a leaf, so modules that build SQL at load can use it whatever the import order.

export type ColumnMap = Readonly<Record<string, string>>;

export function selectSql(columns: ColumnMap): string {
  return Object.entries(columns)
    .map(([name, expression]) => `${expression} AS ${name}`)
    .join(", ");
}

// The expressions marked fixedNumeric, which rowHeapSql counts without evaluating them.
const FIXED_NUMERIC = new Set<string>();

// Marks `expression`, a column of a ColumnMap whose value is 0, 1 or NULL, as one digit at most: rowHeapSql counts it as
// VALUE_BYTES + 2 and never evaluates it, so an expression that costs a read (a domain block's rule) adds none to the
// heap estimate.
export function fixedNumeric(expression: string): string {
  FIXED_NUMERIC.add(expression);
  return expression;
}

// Bounds rowHeapBytes (src/db/sql.ts): ROW_OBJECT_BYTES, plus VALUE_BYTES and twice each value's UTF-8 bytes.
// octet_length loads no value; UTF-8 bytes bound UTF-16 code units. A number overcounts by its decimal digits, NULL
// adds nothing; a fixedNumeric column counts as one digit. balancedSum keeps the expression depth logarithmic (SQLite
// refuses deeper than 100; test-node/sql-depth.ts).
export function rowHeapSql(columns: ColumnMap): string {
  return balancedSum([
    String(ROW_OBJECT_BYTES),
    ...Object.values(columns).map((expression) =>
      FIXED_NUMERIC.has(expression)
        ? String(VALUE_BYTES + 2)
        : `(${VALUE_BYTES} + coalesce(2 * octet_length(${expression}), 0))`,
    ),
  ]);
}

export function balancedSum(terms: readonly string[]): string {
  if (terms.length === 0) {
    return "0";
  }
  if (terms.length === 1) {
    return terms[0]!;
  }
  const half = Math.ceil(terms.length / 2);
  return `(${balancedSum(terms.slice(0, half))} + ${balancedSum(terms.slice(half))})`;
}

// Columns whose values have a fixed largest size (ids, flags, numbers): the heap of one row is a constant.
export type FixedColumns = { readonly columns: ColumnMap; readonly rowHeap: number };

// `bytes`: the most UTF-8 bytes each column's value takes as text (0 for a number).
export function fixedColumns<C extends ColumnMap>(
  columns: C,
  bytes: { readonly [K in keyof C]: number },
): FixedColumns {
  return {
    columns,
    rowHeap: Object.keys(columns).reduce((sum, name) => sum + VALUE_BYTES + 2 * bytes[name]!, ROW_OBJECT_BYTES),
  };
}
