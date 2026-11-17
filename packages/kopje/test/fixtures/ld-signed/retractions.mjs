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

/** @param {unknown} value */
const idOf = (value) => (typeof value === "string" ? value : /** @type {Json} */ (value).id);

/**
 * `body` with the members of `before`, and then its object as a one-element array, after its other members.
 * @param {Json} body
 * @param {Json} before
 * @returns {Json}
 */
export function objectAfter(body, before) {
  const { object, signature, ...rest } = body;
  return { ...rest, ...before, object: [object], ...(signature === undefined ? {} : { signature }) };
}

// The forms (#1717), each a change of a retraction as bob sends it.
export const FORMS = {
  /** @param {Json} body */
  "actor as a one-element array": (body) => ({ ...body, actor: [body.actor] }),
  /** @param {Json} body */
  'object as {"@id": its id}': (body) => ({ ...body, object: { "@id": idOf(body.object) } }),
  /** @param {Json} body */
  "object as a one-element array after to: [null]": (body) => objectAfter(body, { to: [null] }),
};

/** @typedef {keyof typeof FORMS} Form */

/**
 * bob's Delete of BOB_STATUS under the ActivityStreams context alone, its object and each of `n` other IRIs in cc given
 * as {"@id": …}: 13 + 2n values as received, and two fewer for each read as an IRI.
 * @param {number} n
 * @returns {Json}
 */
export function referencesDelete(n) {
  return {
    "@context": AS,
    id: `${BOB}/activities/retraction-${++sequence}`,
    type: "Delete",
    actor: BOB,
    object: { "@id": BOB_STATUS },
    cc: Array.from({ length: n }, (_, i) => ({ "@id": `${BOB}/collections/${i}` })),
    signature: SIGNATURE,
  };
}

/** @returns {RetractionEntry[]} */
export function retractionEntries() {
  /** @type {RetractionEntry[]} */
  const entries = [];
  /**
   * @param {string} name
   * @param {Json} body
   */
  const add = (name, body) => entries.push({ name, signer: BOB, body });
  for (const [form, change] of Object.entries(FORMS)) {
    for (const name of /** @type {Retraction[]} */ (Object.keys(RETRACTIONS))) {
      add(`${name}, ${form}`, change(retraction(name)));
    }
  }
  const actorArray = FORMS["actor as a one-element array"];
  const reference = FORMS['object as {"@id": its id}'];
  const status = () => retraction("Delete(status)");
  add("Delete(status), actor as an array of bob and carol", { ...status(), actor: [BOB, CAROL] });
  add("Delete(status), actor as an array of carol", { ...status(), actor: [CAROL] });
  add("Delete(status), actor as an array of null", { ...status(), actor: [null] });
  add("Delete(status), actor as an array of bob's node", { ...status(), actor: [{ id: BOB, type: "Person" }] });
  for (const [form, change] of Object.entries(FORMS)) {
    add(`Delete(status), ${form}, with a target whose id is null`, { ...change(status()), target: { id: null } });
  }
  add("Delete(status), object as a string, with a target whose id is null", {
    ...status(),
    object: BOB_STATUS,
    target: { id: null },
  });
  add('Delete(status), object as an array of {"@id": its id}', { ...status(), object: [{ "@id": BOB_STATUS }] });
  add('Undo(Follow), object as {"@id": its id} with its type', {
    ...retraction("Undo(Follow)"),
    object: { "@id": BOB_FOLLOW, type: "Follow" },
  });
  add('Delete(status), object as {"@id": its id}, content as {"@id": an IRI}', {
    ...reference(status()),
    content: { "@id": `${BOB}/statuses/deleted/content` },
  });
  add('Delete(status), object as {"@id": its id}, to as [{"@id": the public collection}]', {
    ...reference(status()),
    to: [{ "@id": `${AS}#Public` }],
  });
  add('Delete(status), object as {"@id": its id}, under a context that leaves object untyped', {
    ...reference(status()),
    "@context": [AS, SEC, { object: "as:object" }],
  });
  const { signature: _, ...unsigned } = reference(status());
  add('Delete(status), object as {"@id": its id}, unsigned', unsigned);
  for (const n of [10, 493, 494]) {
    add(`Delete(status), object and ${n} IRIs in cc as {"@id": …}`, referencesDelete(n));
  }
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
  // Where the patch stops (form 2), and where it does not or Kopje cannot tell.
  const stopped = FORMS["object as a one-element array after to: [null]"];
  const { object: tombstone, signature, ...head } = status();
  add("Delete(status), object as a one-element array before to: [null]", {
    ...head,
    object: [tombstone],
    to: [null],
    signature,
  });
  add(
    "Delete(status), object as a one-element array after to of carol twice",
    objectAfter(status(), { to: [CAROL, CAROL] }),
  );
  add(
    "Delete(status), object as a one-element array after to of carol twice and null",
    objectAfter(status(), { to: [CAROL, CAROL, null] }),
  );
  add(
    "Delete(status), object as a one-element array after published: [null]",
    objectAfter(status(), { published: [null] }),
  );
  add(
    "Delete(status), object as a one-element array after a target that holds to: [null]",
    objectAfter(status(), { target: { id: `${BOB}/collections/target`, type: "Collection", to: [null] } }),
  );
  add('Delete(status), object as a one-element array after to: [null], beside a key "0"', {
    0: "zero",
    ...stopped(status()),
  });
  const followed = RETRACTIONS["Undo(Follow)"].object;
  add("Undo(Follow), its Follow's actor and object as one-element arrays after to: [null]", {
    ...retraction("Undo(Follow)"),
    object: { id: followed.id, type: followed.type, to: [null], actor: [followed.actor], object: [followed.object] },
  });
  add('Create, object as {"@id": its id}', {
    ...status(),
    type: "Create",
    object: { "@id": `${BOB}/statuses/created` },
  });
  // The rules the forms leave as they are (D4): rule (3) refuses a keyword as a key, rule (5) a type as a compact IRI
  // and an inline definition no sender writes.
  const follow = RETRACTIONS["Undo(Follow)"].object;
  add("Undo(Follow), its Follow typed by @type", {
    ...retraction("Undo(Follow)"),
    object: { id: follow.id, "@type": follow.type, actor: follow.actor, object: follow.object },
  });
  add("Undo(Follow) typed as a compact IRI", { ...retraction("Undo(Follow)"), type: "as:Undo" });
  add("Undo(Follow) under a definition no sender writes", {
    ...retraction("Undo(Follow)"),
    "@context": [AS, SEC, { mood: "https://other.example/ns#mood" }],
  });
  return entries;
}
