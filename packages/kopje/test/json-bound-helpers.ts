import { MAX_JSON_NODES } from "../src/platform/json-bounds";

// The values (objects, arrays and scalars) of a parsed JSON document, the root included, as jsonRefusal counts them.
function jsonValues(value: unknown): number {
  return (
    1 +
    (typeof value === "object" && value !== null
      ? Object.values(value).reduce<number>((n, member) => n + jsonValues(member), 0)
      : 0)
  );
}

// Distinct ASCII strings that, listed by `build` (one value each), fill its document to exactly MAX_JSON_NODES values
// and `limit` bytes of JSON text: padded evenly, the first taking the remainder. `build([])` is the document without
// them.
export function boundFillers(build: (entries: string[]) => unknown, limit: number): string[] {
  const count = MAX_JSON_NODES - jsonValues(build([]));
  const short = Array.from({ length: count }, (_, i) => `${i}`);
  const room = limit - JSON.stringify(build(short)).length;
  return short.map((n, i) => n + "x".repeat(Math.floor(room / count) + (i === 0 ? room % count : 0)));
}
