// Proof values nested to depth 3, each the proof of a QuoteRequest whose type its context leaves undefined: Mastodon
// reads such a body as received only where its compaction fails, which a proof under the data-integrity contexts'
// @graph container makes it do when JSON-LD's expansion keeps something of the proof (ld-signed-proof-shapes.test.ts).
// The shapes are generated in a fixed order (the depth-3 sample by a seeded generator), and proof-shapes.json holds
// Mastodon's reading of each, in that order. To capture it, from packages/kopje:
//
//   node test/fixtures/ld-signed/proof-shapes-in.mjs > proof-shapes-in.json
//   docker run --rm --network none -v "$PWD/test/fixtures/ld-signed:/f:ro" -v "$PWD:/w" --entrypoint bundle \
//     ghcr.io/mastodon/mastodon:v4.7.5 exec ruby /f/readings.rb /w/proof-shapes-in.json \
//     > test/fixtures/ld-signed/proof-shapes.json
//
// proof-shapes-in.json carries Fedify's preloaded copy of each context the bodies name, which the script serves in
// place of Mastodon's fetch, so the capture runs with no network.

const AS = "https://www.w3.org/ns/activitystreams";
const SEC = "https://w3id.org/security/v1";
const DI1 = "https://w3id.org/security/data-integrity/v1";
const DI2 = "https://w3id.org/security/data-integrity/v2";

export const PROOF_SHAPE_CONTEXTS = { DI2: [AS, SEC, DI2], DI1: [AS, SEC, DI1], "DI2 first": [DI2, AS] };

/** @typedef {keyof typeof PROOF_SHAPE_CONTEXTS} ProofShapeContext */
/** @typedef {{ context: ProofShapeContext, proof: unknown }} ProofShape */

// The body each shape is the proof of: bob's QuoteRequest for alice's status, LD-signed (the signature a placeholder).
/** @param {ProofShape} shape */
export function proofShapeBody({ context, proof }) {
  return {
    "@context": PROOF_SHAPE_CONTEXTS[context],
    id: "https://mastodon.example/users/bob/activities/proof-shape",
    type: "QuoteRequest",
    actor: "https://mastodon.example/users/bob",
    object: "https://kopje.test/ap/o/local-1",
    instrument: "https://mastodon.example/users/bob/statuses/quoting",
    signature: {
      type: "RsaSignature2017",
      creator: "https://mastodon.example/users/bob#main-key",
      created: "2026-11-17T12:00:00Z",
      signatureValue: "placeholder-signature-value",
    },
    proof,
  };
}

const LEAVES = [
  null,
  "x",
  "https://mastodon.example/p",
  "",
  "@x",
  "en",
  "@json",
  "DataIntegrityProof",
  0,
  false,
  [],
  {},
];
const KEYS = [
  "foo", // undefined: `_:foo` by ActivityStreams' @vocab
  "content", // untyped
  "contentMap", // a @language container
  "to", // typed @id
  "orderedItems", // a @list container
  "cryptosuite", // the data-integrity contexts' (scoped to DataIntegrityProof in v2)
  "id",
  "type",
  "@id",
  "@type",
  "@value",
  "@language",
  "@direction",
  "@index",
  "@list",
  "@set",
  "@nest",
];
const DEEP_KEYS = ["foo", "contentMap", "orderedItems", "@set", "@list", "@nest", "@value"];

// Each key given each value, each beside a @language (a map of @language alone expands to nothing), and each value in
// an array.
/** @type {(values: unknown[], keys: string[]) => unknown[]} */
const level = (values, keys) => [
  ...keys.flatMap((key) => values.map((value) => ({ [key]: value }))),
  ...keys
    .filter((key) => key !== "@language")
    .flatMap((key) => values.map((value) => ({ "@language": "en", [key]: value }))),
  ...values.map((value) => [value]),
];

// Proofs of a @language beside members that expand to nothing, which leave nothing as a map of @language alone does,
// and two that keep something (an empty array is a value of its name; a node), as { context, proof, kept }.
/** @type {(ProofShape & { kept: boolean })[]} */
export const LANGUAGE_PROOFS = [
  { context: "DI1", proof: { "@language": "en", foo: null }, kept: false },
  { context: "DI2", proof: { "@language": "en", content: null }, kept: false },
  { context: "DI2", proof: { "@language": "en", foo: { "@value": null } }, kept: false },
  { context: "DI2 first", proof: { "@language": "en", "@nest": {} }, kept: false },
  { context: "DI2", proof: [{ "@language": "en", foo: null }], kept: false },
  { context: "DI1", proof: { "@set": [{ "@language": "en", foo: null }] }, kept: false },
  { context: "DI2", proof: { "@context": DI2, "@language": "en", foo: null }, kept: false },
  { context: "DI2", proof: { "@language": "en", foo: [] }, kept: true },
  {
    context: "DI2",
    proof: { type: "DataIntegrityProof", cryptosuite: "eddsa-jcs-2022", proofValue: "z3placeholder" },
    kept: true,
  },
];

/** @type {(values: unknown[], count: number) => unknown[]} */
function sample(values, count) {
  let seed = 1680;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, count);
}

// Every shape, as { context, proof }, in the order of proof-shapes.json.
/** @returns {ProofShape[]} */
export function proofShapes() {
  const depth1 = [
    ...level(LEAVES, KEYS),
    ...LEAVES.map((value) => [null, value]),
    ...LEAVES.map((value) => ({ "@value": null, "@index": value })),
    ...KEYS.flatMap((key) => LEAVES.map((value) => ({ "@context": DI2, "@language": "en", [key]: value }))),
  ];
  const depth2 = level(depth1, KEYS);
  const depth3 = level(sample(depth2, 1200), DEEP_KEYS);
  /** @type {ProofShape[]} */
  const shapes = [];
  const seen = new Set();
  const every = /** @type {ProofShapeContext[]} */ (Object.keys(PROOF_SHAPE_CONTEXTS));
  /** @type {[unknown[], ProofShapeContext[]][]} */
  const sets = [
    [LEAVES, every],
    [depth1, every],
    [depth2, ["DI2", "DI2 first"]],
    [depth3, ["DI2", "DI1"]],
    ...LANGUAGE_PROOFS.map(
      ({ context, proof }) => /** @type {[unknown[], ProofShapeContext[]]} */ ([[proof], [context]]),
    ),
  ];
  for (const [values, contexts] of sets) {
    for (const context of contexts) {
      for (const proof of values) {
        const key = `${context} ${JSON.stringify(proof)}`;
        if (!seen.has(key)) {
          seen.add(key);
          shapes.push({ context, proof });
        }
      }
    }
  }
  return shapes;
}
