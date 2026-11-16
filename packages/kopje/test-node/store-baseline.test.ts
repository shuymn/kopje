import { describe, expect, it } from "vitest";

import { HEAP_USAGE_FIELDS, measure } from "../bench/store-baseline/measure.mjs";

// The Store baseline bench's measure of a run (bench/store-baseline/measure.mjs, #1610) over recorded CDP replies: the
// sum of the V8 heap committed, the external memory, cppgc's used bytes and the snapshot's native nodes, its columns
// found from the snapshot's meta; a reply missing a part fails the run.

const USAGE = { usedSize: 900, totalSize: 1_000, backingStorageSize: 200, embedderHeapUsedSize: 30 };

// A snapshot whose columns are in another order than V8's usual one, so a measure that assumed positions would misread
// it: node_fields [id, self_size, type, name], types [hidden, native, string].
function snapshot(rows: [type: number, size: number][]) {
  return {
    snapshot: {
      meta: {
        node_fields: ["id", "self_size", "type", "name"],
        node_types: ["number", "number", ["hidden", "native", "string"], "string"],
      },
    },
    nodes: rows.flatMap(([type, size], i) => [i, size, type, 0]),
  };
}

describe("the Store baseline's measure", () => {
  it("sums the heap committed, the external and cppgc memory and the native nodes", () => {
    const result = measure(
      USAGE,
      snapshot([
        [1, 40],
        [2, 500],
        [1, 7],
        [0, 3],
      ]),
    );
    expect(result).toEqual({
      ...USAGE,
      native: 47,
      nodes: 4,
      selfSize: 550,
      byType: { native: 47, string: 500, hidden: 3 },
      sum: 1_000 + 200 + 30 + 47,
    });
    // Not the largest part alone, nor the used heap in place of the committed one.
    expect(result.sum).toBeGreaterThan(Math.max(USAGE.totalSize, USAGE.backingStorageSize, 47));
  });

  it.each(HEAP_USAGE_FIELDS)("fails a run whose getHeapUsage has no %s", (field) => {
    const usage = Object.fromEntries(Object.entries(USAGE).filter(([key]) => key !== field));
    expect(() => measure(usage, snapshot([[1, 40]]))).toThrow(`Runtime.getHeapUsage has no ${field}`);
    expect(() => measure({ ...USAGE, [field]: "1" }, snapshot([[1, 40]]))).toThrow(field);
  });

  it("fails a snapshot without its type or self_size column or its native type", () => {
    const base = snapshot([[1, 40]]);
    const without = (column: string) => ({
      ...base,
      snapshot: {
        meta: {
          ...base.snapshot.meta,
          node_fields: base.snapshot.meta.node_fields.map((f) => (f === column ? "x" : f)),
        },
      },
    });
    expect(() => measure(USAGE, without("type"))).toThrow("no type column");
    expect(() => measure(USAGE, without("self_size"))).toThrow("no self_size column");
    const noNative = {
      ...base,
      snapshot: { meta: { ...base.snapshot.meta, node_types: ["number", "number", ["hidden", "string"], "string"] } },
    };
    expect(() => measure(USAGE, noNative)).toThrow("no native node type");
    expect(() => measure(USAGE, { snapshot: {} })).toThrow("no meta.node_fields");
  });
});
