// The Store baseline bench's measure of one run (run.mjs, RES-3): from the replies of `Runtime.getHeapUsage` and
// `HeapProfiler.takeHeapSnapshot` over the inspector, the sum
//
//   totalSize + backingStorageSize + embedderHeapUsedSize + native
//
// the V8 heap committed, the memory the embedder reports to V8 as held outside its heap (ArrayBuffer backing stores
// among it), cppgc's used bytes, and the summed `self_size` of the snapshot's nodes of type `native`, the objects
// workerd's memory tracker adds for its C++ API objects and their strings, which no `getHeapUsage` field covers. The
// parts are not shown disjoint: an object counted by two of them is counted twice, which overstates. A reply that lacks
// a field, the snapshot's `type` or `self_size` column or its `native` type fails the run instead of counting 0.

/** The `getHeapUsage` fields the measure reads (V8's `v8-runtime-agent-impl.cc`, `getHeapUsage`). */
export const HEAP_USAGE_FIELDS = /** @type {const} */ ([
  "usedSize",
  "totalSize",
  "backingStorageSize",
  "embedderHeapUsedSize",
]);

/**
 * @typedef {{ usedSize: number, totalSize: number, backingStorageSize: number, embedderHeapUsedSize: number,
 *   native: number, nodes: number, selfSize: number, byType: Record<string, number>, sum: number }} Measure
 */

/**
 * @param {unknown} usage the result of `Runtime.getHeapUsage`
 * @param {unknown} snapshot the heap snapshot, parsed from its chunks
 * @returns {Measure}
 */
export function measure(usage, snapshot) {
  const heap = /** @type {Record<string, unknown>} */ (typeof usage === "object" && usage !== null ? usage : {});
  /** @type {Record<string, number>} */
  const fields = {};
  for (const field of HEAP_USAGE_FIELDS) {
    const value = heap[field];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`Runtime.getHeapUsage has no ${field}`);
    }
    fields[field] = value;
  }
  const parsed =
    /** @type {{ snapshot?: { meta?: { node_fields?: unknown, node_types?: unknown } }, nodes?: unknown }} */ (
      typeof snapshot === "object" && snapshot !== null ? snapshot : {}
    );
  const nodeFields = parsed.snapshot?.meta?.node_fields;
  const nodeTypes = parsed.snapshot?.meta?.node_types;
  const nodes = parsed.nodes;
  if (!Array.isArray(nodeFields) || !Array.isArray(nodeTypes) || !Array.isArray(nodes)) {
    throw new Error("the heap snapshot has no meta.node_fields, meta.node_types or nodes");
  }
  const typeAt = nodeFields.indexOf("type");
  const sizeAt = nodeFields.indexOf("self_size");
  if (typeAt < 0 || sizeAt < 0) {
    throw new Error(`the heap snapshot has no ${typeAt < 0 ? "type" : "self_size"} column`);
  }
  const typeNames = /** @type {unknown} */ (nodeTypes[typeAt]);
  const nativeType = Array.isArray(typeNames) ? typeNames.indexOf("native") : -1;
  if (nativeType < 0) {
    throw new Error("the heap snapshot has no native node type");
  }
  const rows = /** @type {unknown[]} */ (nodes);
  const names = /** @type {unknown[]} */ (Array.isArray(typeNames) ? typeNames : []);
  const width = nodeFields.length;
  if (rows.length % width !== 0) {
    throw new Error(`the heap snapshot's nodes are not a multiple of its ${width} columns`);
  }
  let native = 0;
  let selfSize = 0;
  /** @type {Record<string, number>} */
  const byType = {};
  for (let i = 0; i < rows.length; i += width) {
    const size = rows[i + sizeAt];
    const type = rows[i + typeAt];
    if (typeof size !== "number") {
      throw new Error(`the heap snapshot's node ${i / width} has no self_size`);
    }
    selfSize += size;
    if (type === nativeType) {
      native += size;
    }
    const name = String(typeof type === "number" ? (names[type] ?? type) : type);
    byType[name] = (byType[name] ?? 0) + size;
  }
  const { usedSize = 0, totalSize = 0, backingStorageSize = 0, embedderHeapUsedSize = 0 } = fields;
  return {
    usedSize,
    totalSize,
    backingStorageSize,
    embedderHeapUsedSize,
    native,
    nodes: rows.length / width,
    selfSize,
    byType,
    sum: totalSize + backingStorageSize + embedderHeapUsedSize + native,
  };
}
