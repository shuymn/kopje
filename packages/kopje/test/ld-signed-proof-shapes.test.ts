import { describe, expect, it } from "vitest";

import { ldSignedReading, type Rules } from "../src/federation/ld-signed-body";
import edgeCaptured from "./fixtures/ld-signed/edge-shapes.json";
import { edgeShapes } from "./fixtures/ld-signed/edge-shapes.mjs";
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

// The rules but (5), the second layer under it (ldSignedReading): each sweep holds that layer alone to Mastodon's
// reading, and then all the rules, under which rule (5) refuses every shape but the proofs Fedify writes.
const SECOND_LAYER: Rules = { senderShapes: false };

type Kopje = "received" | "named" | "refused";
async function kopjeReading(body: Json, rules: Rules = {}): Promise<Kopje> {
  const reading = await ldSignedReading(body, rules);
  return reading === null ? "refused" : reading.body === body ? "received" : "named";
}

// Reads more than Mastodon: Mastodon compacts the body (`c`) and Kopje reads it as received, or Mastodon's job raises
// (`e`) and Kopje does not refuse it.
const readsMore = (mastodon: string, kopje: Kopje) =>
  (mastodon === "c" && kopje === "received") || (mastodon === "e" && kopje !== "refused");

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
// proof kept something), `r` refused by JSON::LD, `e` any other error (its job raises and applies nothing, so that
// such a body is refused: each is a type array Ruby's json-ld cannot sort, typesSortable). Rule (5) reads only a proof
// of names given strings, so the second layer is held to Mastodon's reading of every shape alone.
describe("an LD-signed body with a data-integrity proof, read as Mastodon's compaction keeps the proof (ID-1)", () => {
  const shapes = proofShapes();

  it("proof-shapes.json is Mastodon 4.7.5's reading of each shape", () => {
    expect(captured.reference).toBe("mastodon-4.7.5");
    expect(captured.readings).toHaveLength(shapes.length);
  });

  it("under the second layer, reads as received no body Mastodon compacts, and as named none whose proof it keeps but those listed", async () => {
    const more: string[] = [];
    const less: string[] = [];
    const tally: Record<string, number> = {};
    for (const [index, shape] of shapes.entries()) {
      const kopje = await kopjeReading(proofShapeBody(shape), SECOND_LAYER);
      const mastodon = captured.readings[index]!;
      const label = `${shape.context} ${JSON.stringify(shape.proof)}`;
      if ((mastodon === "c" && kopje !== "named") || (mastodon === "e" && kopje !== "refused")) {
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
      "r named": 59125,
      "r received": 467,
      "r refused": 20,
      "e refused": 106,
    });
  }, 300_000);

  it("under every rule, refuses each but a proof as Fedify writes one, and reads more than Mastodon nowhere", async () => {
    const more: string[] = [];
    const tally: Record<string, number> = {};
    for (const [index, shape] of shapes.entries()) {
      const kopje = await kopjeReading(proofShapeBody(shape));
      const mastodon = captured.readings[index]!;
      if (readsMore(mastodon, kopje)) {
        more.push(`${shape.context} ${JSON.stringify(shape.proof)}`);
      }
      tally[`${mastodon} ${kopje}`] = (tally[`${mastodon} ${kopje}`] ?? 0) + 1;
    }
    expect(more).toEqual([]);
    // Mastodon compacts or keeps each, so that Kopje reads less, but for the proofs of names given strings it reads.
    expect(tally).toEqual({
      "c refused": 997,
      "k received": 272,
      "k refused": 20207,
      "r refused": 59612,
      "e refused": 106,
    });
  }, 300_000);
});

// ID-1: edge-shapes.json is Mastodon 4.7.5's reading of each body edge-shapes.mjs writes, where jsonld.js and Mastodon's
// json-ld part: a proof holding a key that starts with @ (each keyword of JSON-LD 1.1 and its framing, and strings
// shaped like one) or a name a line of which is shaped like one ("x\n@abc", defined in the body's context), which
// Kopje compares only for a node's keywords (comparableProof); and a type array Ruby's json-ld cannot sort (an entry
// not a string or shaped like a keyword on a line, `type` and `@type` together) and a type beside a @set, in each place
// of a body, which Kopje refuses (typesSortable). Rule (5) refuses each but a few of these, so both layers are held.
describe("an LD-signed body where jsonld.js and Mastodon's json-ld part, read no more than Mastodon (ID-1)", () => {
  const shapes = edgeShapes();

  it("edge-shapes.json is Mastodon 4.7.5's reading of each shape", () => {
    expect(edgeCaptured.reference).toBe("mastodon-4.7.5");
    expect(edgeCaptured.readings).toHaveLength(shapes.length);
  });

  it.each([
    [
      "the second layer",
      SECOND_LAYER,
      {
        "c named": 3588,
        "k received": 896,
        "k named": 1182,
        "k refused": 12,
        "r named": 1232,
        "r received": 12,
        "r refused": 19,
        "e refused": 106,
      },
    ],
    [
      "every rule",
      {},
      { "c named": 12, "c refused": 3576, "k received": 2, "k refused": 2088, "r refused": 1263, "e refused": 106 },
    ],
  ] as [string, Rules, Record<string, number>][])(
    "under %s, reads as received no body Mastodon compacts, and refuses each whose job raises",
    async (_, rules, expected) => {
      const more: string[] = [];
      const tally: Record<string, number> = {};
      for (const [index, { name, body }] of shapes.entries()) {
        const kopje = await kopjeReading(body, rules);
        const mastodon = edgeCaptured.readings[index]!;
        if (readsMore(mastodon, kopje)) {
          more.push(name);
        }
        tally[`${mastodon} ${kopje}`] = (tally[`${mastodon} ${kopje}`] ?? 0) + 1;
      }
      expect(more).toEqual([]);
      expect(tally).toEqual(expected);
    },
  );
});
