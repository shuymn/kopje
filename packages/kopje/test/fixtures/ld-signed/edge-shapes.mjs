// LD-signed bodies where jsonld.js and Mastodon's json-ld part (ld-signed-proof-shapes.test.ts): the proof of a
// QuoteRequest left undefined holding each key that starts with @ (every keyword of JSON-LD 1.1 and of its framing,
// those jsonld.js adds, and strings shaped like one), which Mastodon's json-ld drops where jsonld.js may keep it; and a
// type array of two values or more one of which is not a string, in each place of a body, which Mastodon's json-ld
// sorts and raises on. edge-shapes.json holds Mastodon's reading of each, in this order. To capture it, from
// packages/kopje:
//
//   node test/fixtures/ld-signed/edge-shapes-in.mjs > edge-shapes-in.json
//   docker run --rm --network none -v "$PWD/test/fixtures/ld-signed:/f:ro" -v "$PWD:/w" --entrypoint bundle \
//     ghcr.io/mastodon/mastodon:v4.7.5 exec ruby /f/readings.rb /w/edge-shapes-in.json \
//     > test/fixtures/ld-signed/edge-shapes.json

import { PROOF_SHAPE_CONTEXTS, proofShapeBody } from "./proof-shapes.mjs";

const AS = "https://www.w3.org/ns/activitystreams";
const SEC = "https://w3id.org/security/v1";
const DI2 = "https://w3id.org/security/data-integrity/v2";
const BOB = "https://mastodon.example/users/bob";

/** @typedef {import("./proof-shapes.mjs").ProofShapeContext} ProofShapeContext */
/** @typedef {{ name: string, body: Record<string, unknown> }} EdgeShape */

// JSON-LD 1.1's keywords (its §1.7).
const JSONLD_KEYWORDS = [
  "@base",
  "@container",
  "@context",
  "@direction",
  "@graph",
  "@id",
  "@import",
  "@included",
].concat(
  ["@index", "@json", "@language", "@list", "@nest", "@none", "@prefix", "@propagate", "@protected", "@reverse"],
  ["@set", "@type", "@value", "@version", "@vocab"],
);
// JSON-LD 1.1 Framing's (its §1.4) and the values of @embed.
const FRAMING_KEYWORDS = ["@default", "@embed", "@explicit", "@null", "@omitDefault", "@requireAll", "@always"].concat([
  "@once",
  "@never",
]);
// Every key the proofs hold: those, the ones jsonld.js adds (@any, @preserve), and strings shaped like a keyword.
export const PROOF_KEYWORDS = JSONLD_KEYWORDS.concat(
  FRAMING_KEYWORDS,
  ["@any", "@preserve"],
  ["@foo", "@ID", "@x1", "@"],
);

const VALUES = [
  null,
  "x",
  "",
  "https://mastodon.example/p",
  "@id",
  true,
  0,
  [],
  {},
  { "@value": null },
  ["x"],
  { foo: "x" },
];

// Each key given each value: alone, beside a @language (a map of @language alone expands to nothing), in a node under
// an undefined name, under @nest, and in an array.
/** @type {(key: string, value: unknown) => unknown[]} */
const forms = (key, value) => [
  { [key]: value },
  { "@language": "en", [key]: value },
  { "@language": "en", foo: { "@language": "en", [key]: value } },
  { "@language": "en", "@nest": { [key]: value } },
  [{ "@language": "en", [key]: value }],
];

// Proofs among those of a @language beside a keyword jsonld.js keeps and Mastodon's json-ld drops, each of which
// Mastodon compacts, and one beside a keyword both drop.
/** @type {{ context: ProofShapeContext, proof: unknown }[]} */
export const KEYWORD_PROOFS = [
  { context: "DI2", proof: { "@language": "en", "@version": "x" } },
  { context: "DI1", proof: { "@language": "en", "@vocab": {} } },
  { context: "DI2 first", proof: { "@language": "en", "@none": "x" } },
  { context: "DI2", proof: { "@language": "en", foo: { "@language": "en", "@container": [] } } },
  { context: "DI2", proof: { "@language": "en", "@nest": { "@protected": true } } },
  { context: "DI2", proof: { "@language": "en", "@propagate": "x" } },
];

const signature = (extra = {}) => ({
  type: "RsaSignature2017",
  creator: `${BOB}#main-key`,
  created: "2026-11-17T12:00:00Z",
  signatureValue: "placeholder-signature-value",
  ...extra,
});

// The places a type array is given in: bob's QuoteRequest for alice's status, its type defined, or bob's Delete of his
// own status. Each is given `type` as the place makes it, from the string the place's type is otherwise.
/** @type {Record<string, { type: string, body: (type: unknown) => Record<string, unknown> }>} */
export const TYPE_PLACES = {
  "the activity's type": { type: "QuoteRequest", body: (type) => quoteRequest({ type }) },
  "the instrument's type": {
    type: "Note",
    body: (type) => quoteRequest({ instrument: { id: `${BOB}/statuses/quoting`, type } }),
  },
  "a node's type under an undefined name": { type: "x", body: (type) => quoteRequest({ foo: { type } }) },
  "the proof's type": { type: "DataIntegrityProof", body: (type) => quoteRequest({ proof: { type } }) },
  "the proof's @type": { type: "DataIntegrityProof", body: (type) => quoteRequest({ proof: { "@type": type } }) },
  "a node's type in the proof": { type: "x", body: (type) => quoteRequest({ proof: { foo: { type } } }) },
  "the signature's type": {
    type: "RsaSignature2017",
    body: (type) => quoteRequest({ signature: signature({ type }) }),
  },
  "a Delete's object's type": {
    type: "Tombstone",
    body: (type) => ({
      "@context": [AS, SEC],
      id: `${BOB}/activities/edge-delete`,
      type: "Delete",
      actor: BOB,
      to: [`${AS}#Public`],
      object: { id: `${BOB}/statuses/deleted`, type },
      signature: signature(),
    }),
  },
};

/** @param {Record<string, unknown>} extra */
function quoteRequest(extra) {
  return {
    "@context": [AS, SEC, DI2, { QuoteRequest: "https://w3id.org/fep/044f#QuoteRequest" }],
    id: `${BOB}/activities/edge-quote-request`,
    type: "QuoteRequest",
    actor: BOB,
    object: "https://kopje.test/ap/o/local-1",
    instrument: `${BOB}/statuses/quoting`,
    signature: signature(),
    ...extra,
  };
}

// The arrays given, from the string the place's type is otherwise: Ruby sorts an array before it reads it, and a
// string compared with any other value raises; an array of other values alone may sort, and one value is not sorted.
/** @type {(type: string) => [string, unknown][]} */
export const typeArrays = (type) => [
  ["[null, type]", [null, type]],
  ["[type, null]", [type, null]],
  ["[5, type]", [5, type]],
  ["[true, type]", [true, type]],
  ["[{}, type]", [{}, type]],
  ["[[type], type]", [[type], type]],
  ["[null, null]", [null, null]],
  ["[5, 6]", [5, 6]],
  ["[type, y]", [type, "y"]],
  ["[null]", [null]],
  ["type", type],
];

// Every shape, as { name, body }, in the order of edge-shapes.json.
/** @returns {EdgeShape[]} */
export function edgeShapes() {
  const contexts = /** @type {ProofShapeContext[]} */ (Object.keys(PROOF_SHAPE_CONTEXTS));
  /** @type {EdgeShape[]} */
  const shapes = [];
  for (const context of contexts) {
    for (const key of PROOF_KEYWORDS) {
      for (const value of VALUES) {
        for (const proof of forms(key, value)) {
          const name = `${context} ${JSON.stringify(proof)}`;
          // @language beside @language is one key.
          if (!shapes.some((shape) => shape.name === name)) {
            shapes.push({ name, body: proofShapeBody({ context, proof }) });
          }
        }
      }
    }
  }
  for (const [place, { type, body }] of Object.entries(TYPE_PLACES)) {
    for (const [given, value] of typeArrays(type)) {
      shapes.push({ name: `${place}: ${given}`, body: body(value) });
    }
  }
  return shapes;
}
