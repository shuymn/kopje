// LD-signed retractions in the forms Mastodon 4.7.5 applies where Kopje reads them as its compaction writes them
// (#1717, ld-signed-body.ts RETRACTIONS), each beside its controls (inbox-signed-forms.test.ts). Each entry is
// { name, signer, body }; retractions.json holds, in this order, what Mastodon's ActivityPub::ProcessActivityService did
// with each when its signer sent it (retractions.rb). To capture it, from packages/kopje:
//
//   node test/fixtures/ld-signed/retractions-in.mjs > retractions-in.json
//   docker run --rm --network none -v "$PWD/test/fixtures/ld-signed:/f:ro" -v "$PWD:/w" --entrypoint bundle \
//     ghcr.io/mastodon/mastodon:v4.7.5 exec ruby /f/retractions.rb /w/retractions-in.json \
//     > test/fixtures/ld-signed/retractions.json
//
// The signature is a placeholder: Mastodon compacts a body whose signature is an object before it verifies anything,
// and verifies it only when the compaction's actor is not the signer. The signer is bob on mastodon.example and carol
// another actor there; alice is local (kopje.test), LOCAL_STATUS stands for a status of hers and OUR_FOLLOW for her
// follow of bob, which the tests replace with ones they create.

export const AS = "https://www.w3.org/ns/activitystreams";
const SEC = "https://w3id.org/security/v1";
export const BOB = "https://mastodon.example/users/bob";
export const CAROL = "https://mastodon.example/users/carol";
export const ALICE = "https://kopje.test/ap/users/alice";
export const LOCAL_STATUS = "https://kopje.test/ap/o/local-1";
export const OUR_FOLLOW = "https://kopje.test/ap/follows/1";
// bob's activities and status the retractions name.
export const BOB_FOLLOW = `${BOB}/follows/14`;
export const BOB_LIKE = "https://mastodon.example/likes/1";
export const BOB_BOOST = `${BOB}/statuses/boost/activity`;
export const BOB_BLOCK = `${BOB}/blocks/1`;
export const BOB_STATUS = `${BOB}/statuses/deleted`;

const SIGNATURE = {
  type: "RsaSignature2017",
  creator: `${BOB}#main-key`,
  created: "2026-11-16T12:00:00Z",
  signatureValue: "placeholder-signature-value",
};

/** @typedef {Record<string, unknown>} Json */
/** @typedef {{ name: string, signer: string, body: Json }} RetractionEntry */

// Each retraction as Mastodon 4.7.5's serializers write it, its object embedded where they embed one.
export const RETRACTIONS = {
  "Undo(Follow)": { type: "Undo", object: { id: BOB_FOLLOW, type: "Follow", actor: BOB, object: ALICE } },
  "Reject(Follow)": { type: "Reject", object: { id: OUR_FOLLOW, type: "Follow", actor: ALICE, object: BOB } },
  "Undo(Like)": { type: "Undo", object: { id: BOB_LIKE, type: "Like", actor: BOB, object: LOCAL_STATUS } },
  "Undo(Announce)": { type: "Undo", object: { id: BOB_BOOST, type: "Announce", actor: BOB, object: LOCAL_STATUS } },
  Block: { type: "Block", object: ALICE },
  "Undo(Block)": { type: "Undo", object: { id: BOB_BLOCK, type: "Block", actor: BOB, object: ALICE } },
  "Delete(status)": { type: "Delete", object: { id: BOB_STATUS, type: "Tombstone", atomUri: BOB_STATUS } },
  "Delete(actor)": { type: "Delete", object: BOB },
};

/** @typedef {keyof typeof RETRACTIONS} Retraction */

let sequence = 0;

/**
 * The retraction `name` as bob sends it, LD-signed, under its own activity id, with `extra` members after its object.
 * @param {Retraction} name
 * @param {Json} [extra]
 * @returns {Json}
 */
export function retraction(name, extra = {}) {
  const { type, object } = RETRACTIONS[name];
  return {
    "@context": [AS, SEC],
    id: `${BOB}/activities/retraction-${++sequence}`,
    type,
    actor: BOB,
    object,
    ...extra,
    signature: SIGNATURE,
  };
}

// The forms (#1717), each a change of a retraction as bob sends it.
export const FORMS = {
  /** @param {Json} body */
  "actor as a one-element array": (body) => ({ ...body, actor: [body.actor] }),
};

/** @typedef {keyof typeof FORMS} Form */

/** @returns {RetractionEntry[]} */
export function retractionEntries() {
  /** @type {RetractionEntry[]} */
  const entries = [];
  /**
   * @param {string} name
   * @param {Json} body
   */
  const add = (name, body) => entries.push({ name, signer: BOB, body });
  const actorArray = FORMS["actor as a one-element array"];
  for (const name of /** @type {Retraction[]} */ (Object.keys(RETRACTIONS))) {
    add(`${name}, actor as a one-element array`, actorArray(retraction(name)));
  }
  const status = () => retraction("Delete(status)");
  add("Delete(status), actor as an array of bob and carol", { ...status(), actor: [BOB, CAROL] });
  add("Delete(status), actor as an array of carol", { ...status(), actor: [CAROL] });
  add("Delete(status), actor as an array of null", { ...status(), actor: [null] });
  add("Delete(status), actor as an array of bob's node", { ...status(), actor: [{ id: BOB, type: "Person" }] });
  add("Delete(status), actor as a one-element array, with a target whose id is null", {
    ...actorArray(status()),
    target: { id: null },
  });
  add("Undo(Follow) typed as absolute IRIs, actor as a one-element array", {
    ...actorArray(retraction("Undo(Follow)")),
    type: `${AS}#Undo`,
    object: { ...RETRACTIONS["Undo(Follow)"].object, type: `${AS}#Follow` },
  });
  add("Create, actor as a one-element array", {
    ...status(),
    type: "Create",
    actor: [BOB],
    object: { id: `${BOB}/statuses/created`, type: "Note", attributedTo: BOB, to: [`${AS}#Public`], content: "new" },
  });
  return entries;
}
