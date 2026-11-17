import { describe, expect, it } from "vitest";

import { readParams } from "../src/mastodon/params";
import type { RailsParam } from "../src/platform/rails-params";
import corpus from "./fixtures/rails-params/objects.jsonl?raw";

type Encoded = string | null | Encoded[] | { hash: [string, Encoded][] };
// The stage of a refusal, or Rails' tree and `params.permit(a: FIELDS)["a"]` (null where it permits none).
type Answer = "request" | "controller" | { tree: Encoded; objects: Encoded };

const [fieldsLine = "[]", ...rowLines] = corpus.trimEnd().split("\n");
const FIELDS = new Set(JSON.parse(fieldsLine) as string[]);
const ROWS = rowLines.map((line) => JSON.parse(line) as [string, Answer]);
// Parameters.nested_attribute?'s key.
const INDEX = /^-?\d+$/;

function encode(value: RailsParam<string | File> | ReadonlyMap<string, RailsParam<string | File>>): Encoded {
  if (value instanceof Map) {
    return { hash: [...value].map(([key, item]): [string, Encoded] => [key, encode(item)]) };
  }
  if (Array.isArray(value)) {
    return value.map(encode);
  }
  return typeof value === "string" || value === null ? value : "(file)";
}

// A permitted field's value as objects() reads it: nil as blank (permit holds no other kind but a String).
const scalar = (value: Encoded) => (value === null ? "" : typeof value === "string" ? value : JSON.stringify(value));
const fields = (pairs: [string, string][]) => pairs.toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
const isHash = (value: Encoded | undefined): value is { hash: [string, Encoded][] } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Rails' permitted objects as Kopje reads them, in Rails' order, each as its sorted fields (nil read as blank), or
// none for the one class docs/mastodon-deviations.md lists: a Hash with no index holding a Hash, which Rails permits
// as one object (`listed`).
function expected(answer: { tree: Encoded; objects: Encoded }): { objects: [string, string][][]; listed: boolean } {
  const tree = isHash(answer.tree) ? answer.tree.hash.find(([key]) => key === "a")?.[1] : undefined;
  if (isHash(tree) && !tree.hash.some(([key, item]) => INDEX.test(key) && isHash(item))) {
    return { objects: [], listed: true };
  }
  const items = Array.isArray(answer.objects)
    ? answer.objects
    : isHash(answer.objects)
      ? answer.objects.hash.map(([, item]) => item)
      : [];
  const object = (item: Encoded) =>
    fields(isHash(item) ? item.hash.map(([field, value]): [string, string] => [field, scalar(value)]) : []);
  return { objects: items.map(object), listed: false };
}

// Whether Rails' objects of the answer are under indexes not sent in index order.
function reordered(answer: { objects: Encoded }): boolean {
  const indexes = isHash(answer.objects) ? answer.objects.hash.map(([key]) => Number(key)) : [];
  return indexes.some((index, at) => at > 0 && index < indexes[at - 1]!);
}

// objects.jsonl is Rack's and Rails' answer (Mastodon 4.7.5) to urlencoded bodies (capture.rb): every fragment alone and
// seeded combinations of arrays of objects with nested fields, fields named as a JavaScript object's properties,
// malformed brackets, items that are not objects, indexed objects, scalars and nil. Kopje refuses what either refuses,
// builds the same tree, and reads the objects of `a` with the boundaries Rails gives them, as `permit(a: FIELDS)`
// does, but for the listed differences (expected).
describe("objects: the recorded Rails corpus", () => {
  it("covers each answer and each class", () => {
    const counts: Record<string, number> = { request: 0, controller: 0, read: 0, listed: 0, reordered: 0 };
    for (const [, answer] of ROWS) {
      if (typeof answer === "string") {
        counts[answer]! += 1;
        continue;
      }
      counts[expected(answer).listed ? "listed" : "read"]! += 1;
      counts.reordered! += reordered(answer) ? 1 : 0;
    }
    expect([ROWS.length, counts]).toEqual([
      1452,
      { request: 321, controller: 3, read: 1096, listed: 32, reordered: 89 },
    ]);
  });

  it("refuses, builds and groups each recorded body as Rails does", async () => {
    const answers = [];
    const wanted = [];
    for (const [body, answer] of ROWS) {
      const read = await readParams(
        new Request("https://kopje.test/x", {
          method: "POST",
          body,
          headers: { "content-type": "application/x-www-form-urlencoded" },
        }),
      );
      if (typeof answer === "string") {
        answers.push([body, read.ok || read.status]);
        wanted.push([body, 400]);
        continue;
      }
      const objects = read.ok
        ? read.params
            .objects("a")
            .map((object) => fields(Object.entries(object).filter(([field]) => FIELDS.has(field))))
        : read.status;
      answers.push([body, read.ok ? encode(read.params.trees) : read.status, objects]);
      wanted.push([body, answer.tree, expected(answer).objects]);
    }
    expect(answers).toEqual(wanted);
  });
});
