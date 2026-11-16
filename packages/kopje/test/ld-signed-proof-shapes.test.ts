import { describe, expect, it } from "vitest";

import { ldSignedReading } from "../src/federation/ld-signed-body";
import captured from "./fixtures/ld-signed/proof-shapes.json";
import { proofShapeBody, proofShapes } from "./fixtures/ld-signed/proof-shapes.mjs";

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Whether `test` holds of any object in a value, at any depth.
function anywhere(value: unknown, test: (object: Json) => boolean): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => anywhere(item, test));
  }
  return isObject(value) && (test(value) || Object.values(value).some((member) => anywhere(member, test)));
}

const empty = (value: unknown) => Array.isArray(value) && value.length === 0;
const holdsArrayOfArray = (value: unknown): boolean =>
  Array.isArray(value)
    ? value.some(Array.isArray) || value.some(holdsArrayOfArray)
    : isObject(value) && Object.values(value).some(holdsArrayOfArray);

// The proofs Mastodon's compaction keeps something of (it reads the body as received) that Kopje reads as named, so
// reading less: jsonld.js drops an empty type list, which Mastodon's json-ld keeps; Kopje does not read a @set in a map
// under @nest (comparableProof); and jsonld.js refuses a language map holding an array in an array.
function readLess(proof: unknown): boolean {
  return (
    anywhere(proof, (object) => empty(object.type) || empty(object["@type"])) ||
    anywhere(proof, (object) =>
      (Array.isArray(object["@nest"]) ? object["@nest"] : [object["@nest"]]).some(
        (nested) => isObject(nested) && Object.hasOwn(nested, "@set"),
      ),
    ) ||
    anywhere(proof, (object) => holdsArrayOfArray(object.contentMap))
  );
}

// ID-1: Mastodon reads an LD-signed body as received when its compaction fails, which a proof under the data-integrity
// contexts' @graph container makes it do when JSON-LD's expansion keeps something of the proof; Kopje reads such a body
// as received only then (proofExpandsToSomething), and as named otherwise. proof-shapes.json is Mastodon 4.7.5's
// reading of every shape proof-shapes.mjs writes: `c` compacted, `k` refused by the limits after the compaction (the
// proof kept something), `r` refused by JSON::LD, `e` any other error (its job raises and applies nothing, so that such
// a body, like one Mastodon compacts, is read as named).
describe("an LD-signed body with a data-integrity proof, read as Mastodon's compaction keeps the proof (ID-1)", () => {
  const shapes = proofShapes();

  it("proof-shapes.json is Mastodon 4.7.5's reading of each shape", () => {
    expect(captured.reference).toBe("mastodon-4.7.5");
    expect(captured.readings).toHaveLength(shapes.length);
  });

  it("reads as received no body Mastodon compacts, and as named none whose proof it keeps but those listed", async () => {
    const more: string[] = [];
    const less: string[] = [];
    const tally: Record<string, number> = {};
    for (const [index, shape] of shapes.entries()) {
      const body = proofShapeBody(shape);
      const reading = await ldSignedReading(body);
      const kopje = reading === null ? "refused" : reading.body === body ? "received" : "named";
      const mastodon = captured.readings[index]!;
      const label = `${shape.context} ${JSON.stringify(shape.proof)}`;
      if ((mastodon === "c" || mastodon === "e") && kopje !== "named") {
        more.push(label);
      }
      if (mastodon === "k" && kopje !== "received" && !readLess(shape.proof)) {
        less.push(label);
      }
      tally[`${mastodon} ${kopje}`] = (tally[`${mastodon} ${kopje}`] ?? 0) + 1;
    }
    expect(more).toEqual([]);
    expect(less).toEqual([]);
    // Every reading of each kind (and so each listed exception) is reached.
    expect(tally).toEqual({
      "c named": 997,
      "k received": 20323,
      "k named": 156,
      "r named": 59145,
      "r received": 467,
      "e named": 106,
    });
  }, 300_000);
});
