// LD-signed Notes with a picture whose context defines `sensitive` otherwise than full_context (which leaves it
// untyped), each given each shape of value: the compaction writes it under the name all the same where the definition
// takes it, and Mastodon marks the status sensitive by what its boolean column makes of it
// (inbox-signed-forms.test.ts). sensitive-shapes.json holds Mastodon's reading of each, in this order. To capture it,
// from packages/kopje:
//
//   node test/fixtures/ld-signed/sensitive-shapes-in.mjs > sensitive-shapes-in.json
//   docker run --rm --network none -v "$PWD/test/fixtures/ld-signed:/f:ro" -v "$PWD:/w" --entrypoint bundle \
//     ghcr.io/mastodon/mastodon:v4.7.5 exec ruby /f/readings.rb /w/sensitive-shapes-in.json sensitive \
//     > test/fixtures/ld-signed/sensitive-shapes.json

const AS = "https://www.w3.org/ns/activitystreams";
const SEC = "https://w3id.org/security/v1";
const BOB = "https://mastodon.example/users/bob";
const XSD = "http://www.w3.org/2001/XMLSchema#";

// Each definition of `sensitive` the rules (ld-signed-body.ts) admit that gives it full_context's IRI and another
// meaning.
const DEFINITIONS = {
  "typed @id": { "@id": "as:sensitive", "@type": "@id" },
  "typed @id, a set": { "@id": "as:sensitive", "@type": "@id", "@container": "@set" },
  "a list": { "@id": "as:sensitive", "@container": "@list" },
  "typed @id, a list": { "@id": "as:sensitive", "@type": "@id", "@container": "@list" },
  "typed as a boolean": { "@id": "as:sensitive", "@type": `${XSD}boolean` },
  "typed as a string": { "@id": "as:sensitive", "@type": `${XSD}string` },
  // Mastodon's json-ld raises on a datatype given as a compact IRI over a prefix of the ActivityStreams context, and
  // Mastodon reads the body as received.
  "typed as xsd:boolean": { "@id": "as:sensitive", "@type": "xsd:boolean" },
};

/** @typedef {keyof typeof DEFINITIONS} SensitiveDefinition */
/** @typedef {{ definition: SensitiveDefinition, value: string, name: string, given: unknown }} SensitiveShape */

/** @type {[string, unknown][]} */
const VALUES = [
  ["false", false],
  ["true", true],
  ["0", 0],
  ["1", 1],
  ['"false"', "false"],
  ['"x"', "x"],
  ["an IRI", `${BOB}/sensitive`],
  ["a node", { id: `${BOB}/sensitive` }],
  ["[]", []],
  ["[null]", [null]],
  ["[false]", [false]],
  ["[true]", [true]],
  ["[false, false]", [false, false]],
];

// Every shape, as { definition, value, name, given }, in the order of sensitive-shapes.json.
/** @returns {SensitiveShape[]} */
export function sensitiveShapes() {
  return /** @type {SensitiveDefinition[]} */ (Object.keys(DEFINITIONS)).flatMap((definition) =>
    VALUES.map(([value, given]) => ({
      definition,
      value,
      name: `${definition}, given ${value}`,
      given,
    })),
  );
}

/** @param {SensitiveShape} shape */
export function sensitiveShapeBody({ definition, given }) {
  return {
    "@context": [AS, SEC, { sensitive: DEFINITIONS[definition] }],
    id: `${BOB}/statuses/sensitive/activity`,
    type: "Create",
    actor: BOB,
    to: [`${AS}#Public`],
    object: {
      id: `${BOB}/statuses/sensitive`,
      type: "Note",
      attributedTo: BOB,
      content: "<p>a picture</p>",
      published: "2026-11-17T12:00:00Z",
      to: [`${AS}#Public`],
      sensitive: given,
      attachment: [{ type: "Document", mediaType: "image/png", url: "https://mastodon.example/media/5.png" }],
    },
    signature: {
      type: "RsaSignature2017",
      creator: `${BOB}#main-key`,
      created: "2026-11-17T12:00:00Z",
      signatureValue: "placeholder-signature-value",
    },
  };
}
