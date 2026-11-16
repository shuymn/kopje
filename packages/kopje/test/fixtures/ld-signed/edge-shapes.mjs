// LD-signed bodies where jsonld.js and Mastodon's json-ld part (ld-signed-proof-shapes.test.ts): the proof of a
// QuoteRequest left undefined holding each key that starts with @ (every keyword of JSON-LD 1.1 and of its framing,
// those jsonld.js adds, and strings shaped like one), which Mastodon's json-ld drops where jsonld.js may keep it; a type
// array of two values or more one of which is not a string or is shaped like a keyword on a line, in each place of a
// body, which Mastodon's json-ld sorts and raises on; a name with a line shaped like a keyword, defined in the body's
// context or not, in such a proof (Ruby's ^ and $ match at each line); and a @set beside a type in such a proof.
// edge-shapes.json holds Mastodon's reading of each, in this order. To capture it, from packages/kopje:
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
  "a Delete's object's type": { type: "Tombstone", body: (type) => deleteOf({ id: `${BOB}/statuses/deleted`, type }) },
  "a Delete's object's tag's type": {
    type: "Hashtag",
    body: (type) => deleteOf({ id: `${BOB}/statuses/deleted`, type: "Tombstone", tag: [{ type, name: "#x" }] }),
  },
  // Given under @type beside the proof's type, which Ruby's json-ld merges into one array.
  "the proof's @type beside its type": {
    type: "DataIntegrityProof",
    body: (type) => quoteRequest({ proof: { type: "DataIntegrityProof", "@type": type } }),
  },
};

/** @param {Record<string, unknown>} object */
function deleteOf(object) {
  return {
    "@context": [AS, SEC],
    id: `${BOB}/activities/edge-delete`,
    type: "Delete",
    actor: BOB,
    to: [`${AS}#Public`],
    object,
    signature: signature(),
  };
}

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
// A string any line of which is shaped like a keyword (but a keyword) Ruby expands to nil, which raises as it sorts.
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
  ['[type, "@foo"]', [type, "@foo"]],
  ['[type, "x\\n@abc"]', [type, "x\n@abc"]],
  ['[type, "@foo\\n"]', [type, "@foo\n"]],
  ['["@foo"]', ["@foo"]],
];

// Names with a line shaped like a keyword (and a plain one), each defined in the body's context as an IRI or not, given
// in a proof beside a @language, nested, and alone: Ruby's json-ld drops such a name before it reads its definition.
const KEYWORD_LINES = ["x\n@abc", "\n@abc", "x\n@abc\ny", "x\n@a", "x\r\n@abc", "x\n@version", "x\n@id"].concat([
  "x\n@context",
  "x\n@graph",
  "ok",
]);

// A @set beside a type in a proof, at its top and nested: Ruby's json-ld keeps a node of one type and a @set of nothing,
// and raises as it reads the @set.
const SETS = [null, { "@value": null }, { "@language": "en" }, { "@set": null }, [], "x"];
/** @type {[string, Record<string, unknown>][]} */
const SET_TYPES = [
  ["type", { type: "DataIntegrityProof" }],
  ["@type", { "@type": "DataIntegrityProof" }],
  ["type [DataIntegrityProof]", { type: ["DataIntegrityProof"] }],
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
  for (const name of KEYWORD_LINES) {
    for (const defined of [true, false]) {
      const context = [AS, SEC, DI2, { QuoteRequest: "https://w3id.org/fep/044f#QuoteRequest" }];
      if (defined) {
        context.push({ [name]: "https://example.org/p" });
      }
      for (const { form, proof } of [
        { form: "beside a @language", proof: { "@language": "en", [name]: "v" } },
        { form: "nested", proof: { "@language": "en", foo: { "@language": "en", [name]: "v" } } },
        { form: "alone", proof: { [name]: "v" } },
      ]) {
        shapes.push({
          name: `${JSON.stringify(name)} ${defined ? "defined" : "undefined"}, ${form}`,
          body: { ...quoteRequest({ proof }), "@context": context },
        });
      }
    }
  }
  for (const set of SETS) {
    for (const [given, type] of SET_TYPES) {
      shapes.push({
        name: `${given} beside @set ${JSON.stringify(set)}`,
        body: quoteRequest({ proof: { ...type, "@set": set } }),
      });
      shapes.push({
        name: `nested: ${given} beside @set ${JSON.stringify(set)}`,
        body: quoteRequest({ proof: { type: "DataIntegrityProof", n: [{ ...type, "@set": set }] } }),
      });
    }
  }
  return shapes;
}
