// LD-signed bodies in the forms whose readings differ (docs/mastodon-deviations.md, "Reading inbound activities"), and
// the contexts and keys ldSignedBodyReadable refuses or keeps, for forms.json (inbox-signed-forms.test.ts). Each entry
// is { name, received }; compact.rb adds Mastodon's reading. Run from packages/kopje:
//
//   node test/fixtures/ld-signed/forms.mjs > forms-in.json
//
// compact-offline.rb reads each with no network as compact.rb read it in a running web container, but the nine that
// name a context Mastodon does not preload (data-integrity/v1, an unknown URL). The signature is a placeholder:
// Mastodon compacts a body whose signature is an object before it verifies anything. The sender is bob on
// mastodon.example; alice is local (kopje.test), and LOCAL_STATUS stands for a local status of hers, which the tests
// replace with one they create.

const AS = "https://www.w3.org/ns/activitystreams";
const SEC = "https://w3id.org/security/v1";
const CID = "https://www.w3.org/ns/cid/v1";
const WEBFINGER = "https://purl.archive.org/socialweb/webfinger";
const DATA_INTEGRITY = "https://w3id.org/security/data-integrity/v1";
const PUBLIC = `${AS}#Public`;
const BOB = "https://mastodon.example/users/bob";
const FOLLOWERS = `${BOB}/followers`;
const ALICE = "https://kopje.test/ap/users/alice";
const LOCAL_STATUS = "https://kopje.test/ap/o/local-1";
const SIGNATURE = {
  type: "RsaSignature2017",
  creator: `${BOB}#main-key`,
  created: "2026-11-16T12:00:00Z",
  signatureValue: "placeholder-signature-value",
};

// Mastodon 4.7.5's context for a status (CreateNoteSerializer), and its full_context's extension object.
const STATUS_EXTENSION = {
  ostatus: "http://ostatus.org#",
  atomUri: "ostatus:atomUri",
  inReplyToAtomUri: "ostatus:inReplyToAtomUri",
  conversation: "ostatus:conversation",
  sensitive: "as:sensitive",
  toot: "http://joinmastodon.org/ns#",
  votersCount: "toot:votersCount",
  quote: { "@id": "https://w3id.org/fep/044f#quote", "@type": "@id" },
  quoteUri: "http://fedibird.com/ns#quoteUri",
  _misskey_quote: "https://misskey-hub.net/ns#_misskey_quote",
  quoteAuthorization: { "@id": "https://w3id.org/fep/044f#quoteAuthorization", "@type": "@id" },
  gts: "https://gotosocial.org/ns#",
  interactionPolicy: { "@id": "gts:interactionPolicy", "@type": "@id" },
  canFeature: { "@id": "https://w3id.org/fep/7aa9#canFeature", "@type": "@id" },
  canQuote: { "@id": "gts:canQuote", "@type": "@id" },
  automaticApproval: { "@id": "gts:automaticApproval", "@type": "@id" },
  manualApproval: { "@id": "gts:manualApproval", "@type": "@id" },
  Hashtag: "as:Hashtag",
};
const STATUS_CONTEXT = [AS, STATUS_EXTENSION, SEC];
// The rest of Mastodon 4.7.5's extension object for a status's tags and media and an actor (full_context).
const ACTOR_EXTENSION = {
  Emoji: "toot:Emoji",
  focalPoint: { "@container": "@list", "@id": "toot:focalPoint" },
  blurhash: "toot:blurhash",
  featured: { "@id": "toot:featured", "@type": "@id" },
  manuallyApprovesFollowers: "as:manuallyApprovesFollowers",
  discoverable: "toot:discoverable",
  schema: "http://schema.org#",
  PropertyValue: "schema:PropertyValue",
  value: "schema:value",
};

// Misskey 2026.11.0's CONTEXT (packages/backend/src/core/activitypub/misc/contexts.ts).
const MISSKEY_CONTEXT = [
  AS,
  SEC,
  {
    Key: "sec:Key",
    manuallyApprovesFollowers: "as:manuallyApprovesFollowers",
    sensitive: "as:sensitive",
    Hashtag: "as:Hashtag",
    quoteUrl: "as:quoteUrl",
    toot: "http://joinmastodon.org/ns#",
    Emoji: "toot:Emoji",
    featured: "toot:featured",
    discoverable: "toot:discoverable",
    schema: "http://schema.org#",
    PropertyValue: "schema:PropertyValue",
    value: "schema:value",
    misskey: "https://misskey-hub.net/ns#",
    _misskey_content: "misskey:_misskey_content",
    _misskey_quote: "misskey:_misskey_quote",
    _misskey_reaction: "misskey:_misskey_reaction",
    _misskey_votes: "misskey:_misskey_votes",
    _misskey_summary: "misskey:_misskey_summary",
    _misskey_followedMessage: "misskey:_misskey_followedMessage",
    _misskey_requireSigninToViewContents: "misskey:_misskey_requireSigninToViewContents",
    _misskey_makeNotesFollowersOnlyBefore: "misskey:_misskey_makeNotesFollowersOnlyBefore",
    _misskey_makeNotesHiddenBefore: "misskey:_misskey_makeNotesHiddenBefore",
    _misskey_license: "misskey:_misskey_license",
    freeText: { "@id": "misskey:freeText", "@type": "schema:text" },
    isCat: "misskey:isCat",
    vcard: "http://www.w3.org/2006/vcard/ns#",
  },
];

/** @typedef {Record<string, unknown>} Json */

let n = 0;
/** @type {(context: unknown, body: Json) => Json} */
const signed = (context, body) => ({ "@context": context, ...body, signature: SIGNATURE });
/** @type {(type: unknown, extra?: Json) => Json} */
const activity = (type, extra = {}) => ({ id: `${BOB}/activities/${++n}`, type, actor: BOB, ...extra });

function note(extra = {}) {
  const id = `${BOB}/statuses/${++n}`;
  return {
    id,
    type: "Note",
    summary: null,
    inReplyTo: null,
    published: "2026-11-16T12:00:00Z",
    url: `https://mastodon.example/@bob/${n}`,
    attributedTo: BOB,
    to: [PUBLIC],
    cc: [FOLLOWERS],
    sensitive: false,
    atomUri: id,
    content: `<p>note ${n}</p>`,
    attachment: [],
    tag: [],
    ...extra,
  };
}

/** @type {(object: Json, context?: unknown, extra?: Json) => Json} */
const create = (object, context = STATUS_CONTEXT, extra = {}) =>
  signed(context, activity("Create", { to: object.to, cc: object.cc, object, ...extra }));
const follow = () => ({ id: `${BOB}/follows/${++n}`, type: "Follow", actor: BOB, object: ALICE });
// alice's follow of bob, and bob's of her, as effects.rb seeds them.
const OUR_FOLLOW = { id: "https://kopje.test/ap/follows/1", type: "Follow", actor: ALICE, object: BOB };
const BOBS_FOLLOW = { id: `${BOB}/follows/14`, type: "Follow", actor: BOB, object: ALICE };
// bob's block of alice, as effects.rb seeds it for an entry named for a block, with both types as IRIs.
const BLOCK = { id: `${BOB}/blocks/1`, type: "as:Block", actor: BOB, object: ALICE };
// bob's Undo of that block, both typed as absolute IRIs, which rule (5) reads (#1717, form 4: a retraction's body
// beyond the closed shape, which Mastodon compacts all the same).
/** @type {(extra?: Json, context?: unknown) => Json} */
const absoluteUndo = (extra = {}, context = [AS, SEC]) =>
  signed(context, activity(`${AS}#Undo`, { object: { ...BLOCK, type: `${AS}#Block` }, ...extra }));
const QUOTE_REQUEST = "https://w3id.org/fep/044f#QuoteRequest";
// alice's QuoteRequest for her status local-2, quoting bob's pinned status, as effects.rb seeds it for an entry named
// for our quote request.
const OUR_QUOTE_REQUEST = "https://kopje.test/ap/o/local-2#quote-request";
/** @type {(value: unknown) => number} The values JsonLdHelper#check_jsonld_limits! counts. */
const values = (value) => {
  /** @type {unknown[]} */
  const members = Array.isArray(value)
    ? value
    : typeof value === "object" && value !== null
      ? Object.values(value)
      : [];
  let count = 1;
  for (const member of members) {
    count += values(member);
  }
  return count;
};
/** @type {(body: Json, total: number) => Json} The body with a padding array of strings, `total` values in all. */
const padded = (body, total) => ({ ...body, padding: Array.from({ length: total - values(body) - 1 }, () => "x") });
const question = (options) =>
  note({ type: "Question", content: "<p>poll</p>", endTime: "2026-11-17T12:00:00Z", oneOf: options });
const option = (name) => ({ type: "Note", name, replies: { type: "Collection", totalItems: 0 } });
const hashtags = (count) =>
  Array.from({ length: count }, (_, i) => ({
    type: "Hashtag",
    href: `https://mastodon.example/tags/t${i}`,
    name: `#t${i}`,
  }));

const forms = {
  // §1.5 rows 1 and 3: the envelope.
  "type as a one-element array": signed([AS, SEC], activity(["Like"], { object: LOCAL_STATUS })),
  "type as a compact IRI": signed([AS, SEC], activity("as:Like", { object: LOCAL_STATUS })),
  "type as an absolute IRI": signed([AS, SEC], activity(`${AS}#Like`, { object: LOCAL_STATUS })),
  "actor as a one-element array": signed([AS, SEC], { ...activity("Like", { object: LOCAL_STATUS }), actor: [BOB] }),

  // Row 6: an object as a one-element array.
  "Follow object as a one-element array": signed([AS, SEC], activity("Follow", { object: [ALICE] })),
  "Block object as a one-element array": signed([AS, SEC], activity("Block", { object: [ALICE] })),
  "Like object as a one-element array": signed([AS, SEC], activity("Like", { object: [LOCAL_STATUS] })),
  "EmojiReact object as a one-element array": signed(
    [AS, SEC],
    activity("EmojiReact", { object: [LOCAL_STATUS], content: "👍" }),
  ),
  "Announce object as a one-element array": signed(
    [AS, SEC],
    activity("Announce", { object: [LOCAL_STATUS], to: [PUBLIC], cc: [FOLLOWERS] }),
  ),
  "Delete object as a one-element array": signed(
    [AS, SEC],
    activity("Delete", { object: [{ id: `${BOB}/statuses/deleted`, type: "Tombstone" }], to: [PUBLIC] }),
  ),
  "Add object as a one-element array": signed(
    [AS, SEC],
    activity("Add", { object: [`${BOB}/statuses/pinned`], target: `${BOB}/collections/featured` }),
  ),
  "Remove object as a one-element array": signed(
    [AS, SEC],
    activity("Remove", { object: [`${BOB}/statuses/pinned`], target: `${BOB}/collections/featured` }),
  ),
  "QuoteRequest object as a one-element array": signed(
    [AS, { QuoteRequest: "https://w3id.org/fep/044f#QuoteRequest" }, SEC],
    activity("QuoteRequest", { object: [LOCAL_STATUS], instrument: `${BOB}/statuses/quoting` }),
  ),

  // Row 7: the reference of an Undo, a Reject or an Accept.
  "Undo object as a one-element array": signed([AS, SEC], activity("Undo", { object: [follow()] })),
  "Undo object type as an IRI": signed([AS, SEC], activity("Undo", { object: { ...follow(), type: "as:Follow" } })),
  "Reject object as a one-element array": signed(
    [AS, SEC],
    activity("Reject", { object: [{ id: "https://kopje.test/ap/follows/1", type: "Follow" }] }),
  ),
  "Accept object type as an IRI": signed(
    [AS, SEC],
    activity("Accept", { object: { id: "https://kopje.test/ap/follows/1", type: "as:Follow" } }),
  ),

  // Rows 9 to 11: a target or an instrument as a one-element array.
  "Add target as a one-element array": signed(
    [AS, SEC],
    activity("Add", { object: `${BOB}/statuses/pinned`, target: [`${BOB}/collections/featured`] }),
  ),
  "Remove target as a one-element array": signed(
    [AS, SEC],
    activity("Remove", { object: `${BOB}/statuses/pinned`, target: [`${BOB}/collections/featured`] }),
  ),
  "Move target as a one-element array": signed(
    [AS, SEC],
    activity("Move", { object: BOB, target: ["https://mastodon.example/users/bob2"] }),
  ),
  "QuoteRequest instrument as a one-element array": signed(
    [AS, { QuoteRequest: "https://w3id.org/fep/044f#QuoteRequest" }, SEC],
    activity("QuoteRequest", { object: LOCAL_STATUS, instrument: [`${BOB}/statuses/quoting`] }),
  ),

  // Rows 12 to 17: a status's members.
  "Note type as an IRI": create(note({ type: "as:Note" })),
  "content as a one-element array": create(note({ content: ["<p>text</p>"] })),
  "summary as a one-element array": create(note({ summary: ["warning"] })),
  "name as a one-element array": create(note({ type: "Article", name: ["Title"] })),
  "inReplyTo as a one-element array": create(note({ inReplyTo: [LOCAL_STATUS] })),
  "sensitive as a one-element array": create(
    note({
      sensitive: [true],
      attachment: [{ type: "Document", mediaType: "image/png", url: "https://mastodon.example/media/1.png" }],
    }),
  ),
  "Mention type as an IRI": create(
    note({ cc: [FOLLOWERS, ALICE], tag: [{ type: "as:Mention", href: ALICE, name: "@alice@kopje.test" }] }),
  ),
  "Question with one option": create(question([option("Only")])),

  // Row 19, 20: the same effect.
  "Flag object as a one-element array": signed([AS, SEC], activity("Flag", { object: [ALICE], content: "a report" })),
  "more than 1,000 values": create(note({ tag: hashtags(260) })),
  "a proof in the data-integrity context": {
    ...create(question([option("Only")]), [AS, DATA_INTEGRITY, STATUS_EXTENSION]),
    proof: {
      "@context": DATA_INTEGRITY,
      type: "DataIntegrityProof",
      cryptosuite: "eddsa-jcs-2022",
      verificationMethod: `${BOB}#ed25519-key`,
      proofPurpose: "assertionMethod",
      proofValue: "placeholder-proof-value",
      created: "2026-11-16T12:00:00Z",
    },
  },

  // Row 22: an extension property the sender's context leaves undefined or types otherwise.
  "sensitive left undefined": create(
    note({
      sensitive: true,
      attachment: [{ type: "Document", mediaType: "image/png", url: "https://mastodon.example/media/2.png" }],
    }),
    [AS, SEC],
  ),
  "interactionPolicy left undefined": create(
    note({ interactionPolicy: { canQuote: { automaticApproval: [PUBLIC] } } }),
    [AS, SEC],
  ),
  "quote untyped": create(note({ quote: "https://other.example/statuses/1" }), [
    AS,
    { quote: "https://w3id.org/fep/044f#quote" },
    SEC,
  ]),
  "quoteUrl defined": create(note({ quoteUrl: "https://other.example/statuses/2" }), MISSKEY_CONTEXT),

  // ldSignedBodyReadable's refusals (§2.4): rows 2, 4, 5, 8, 13, 14, 16 and 21 included.
  "@base after ActivityStreams": create(note({ to: ["Public"], cc: [] }), [AS, { "@base": "https://other.example/" }]),
  "@base before ActivityStreams": create(note({ to: ["Public"], cc: [] }), [{ "@base": "https://other.example/" }, AS]),
  "a keyword alias beside the literal type": signed(
    [AS, { kind: "@type" }],
    activity("Like", { kind: "Create", object: LOCAL_STATUS }),
  ),
  "an alias of object beside the literal one": signed(
    [AS, { thing: { "@id": "as:object", "@type": "@id" } }],
    activity("Like", { object: LOCAL_STATUS, thing: "https://kopje.test/ap/o/local-2" }),
  ),
  "an alias of to with to redefined": create(note({ to: [PUBLIC], cc: [], aud: [FOLLOWERS] }), [
    AS,
    { to: "https://other.example/to", aud: { "@id": "as:to", "@type": "@id" } },
  ]),
  "an as:object key holding an object": signed(
    [AS, SEC],
    activity("Like", { object: LOCAL_STATUS, "as:object": { id: "https://kopje.test/ap/o/local-2" } }),
  ),
  "an absolute IRI key holding an object": signed(
    [AS, SEC],
    activity("Follow", { object: ALICE, [`${AS}#object`]: { id: "https://kopje.test/ap/users/dave" } }),
  ),
  "@id and @type in place of id and type": signed([AS, SEC], {
    "@id": `${BOB}/activities/${++n}`,
    "@type": "Like",
    actor: BOB,
    object: LOCAL_STATUS,
  }),
  "@type beside type": signed([AS, SEC], activity("Like", { "@type": "Create", object: LOCAL_STATUS })),
  "@id beside id": signed([AS, SEC], activity("Like", { "@id": `${BOB}/activities/other`, object: LOCAL_STATUS })),
  "@value in content": create(note({ content: { "@value": "<p>text</p>", "@language": "en" } })),
  "@nest in a status": create(note({ "@nest": { tag: [{ type: "Mention", href: ALICE, name: "@alice" }] } })),
  "@id in inReplyTo": create(note({ inReplyTo: { "@id": LOCAL_STATUS } })),
  "@id in a Mention's href": create(
    note({ cc: [FOLLOWERS, ALICE], tag: [{ type: "Mention", href: { "@id": ALICE }, name: "@alice@kopje.test" }] }),
  ),
  "@id in a Follow's object": signed([AS, SEC], activity("Follow", { object: { "@id": ALICE } })),
  "@id in an Undo's object": signed([AS, SEC], activity("Undo", { object: { "@id": `${BOB}/follows/1` } })),
  "@id in an Accept's result": signed(
    [AS, { QuoteRequest: "https://w3id.org/fep/044f#QuoteRequest" }, SEC],
    activity("Accept", {
      object: { id: "https://kopje.test/ap/quote_requests/1", type: "QuoteRequest" },
      result: { "@id": `${BOB}/quote_authorizations/1` },
    }),
  ),
  "@graph in the body": signed([AS, SEC], activity("Like", { object: LOCAL_STATUS, "@graph": [] })),
  "@included in the body": signed([AS, SEC], activity("Like", { object: LOCAL_STATUS, "@included": [] })),
  "@reverse in the body": signed([AS, SEC], activity("Like", { object: LOCAL_STATUS, "@reverse": {} })),
  "an inline to": create(note(), [AS, { to: "https://other.example/to" }, SEC]),
  "a null tag": create(note({ tag: [{ type: "Mention", href: ALICE, name: "@alice" }] }), [AS, { tag: null }, SEC]),
  "a redefined as": create(note(), [AS, { as: "https://other.example/as#" }, SEC]),
  "a redefined QuoteRequest": signed(
    [AS, { QuoteRequest: "https://other.example/QuoteRequest" }, SEC],
    activity("QuoteRequest", { object: LOCAL_STATUS, instrument: `${BOB}/statuses/quoting` }),
  ),
  "a redefined Like": signed(
    [AS, { Like: "https://www.w3.org/ns/activitystreams#Dislike" }],
    activity("Like", { object: LOCAL_STATUS }),
  ),
  "a prefix naming the ActivityStreams namespace": signed(
    [AS, { p: "https://www.w3.org/ns/activitystreams#" }],
    activity("Like", { object: LOCAL_STATUS }),
  ),
  "a scoped definition": create(note({ extra: { to: [PUBLIC] } }), [
    AS,
    { extra: { "@id": "https://other.example/extra", "@context": { "@base": "https://other.example/" } } },
  ]),
  "a prefix chain": create(note({ foo: "bar" }), [AS, { p: "https://other.example/", q: "p:ns#", foo: "q:foo" }]),
  "@vocab set": create(note({ to: ["Public"], cc: [] }), [AS, { "@vocab": "https://other.example/" }]),
  "@language set": create(note(), [AS, { "@language": "ja" }]),
  "@propagate before ActivityStreams": create(note(), [{ "@propagate": false }, AS]),
  "schema.org after ActivityStreams": signed([AS, "http://schema.org/"], activity("Like", { object: LOCAL_STATUS })),
  "identity/v1 after ActivityStreams": signed(
    [AS, "https://w3id.org/identity/v1"],
    activity("Like", { object: LOCAL_STATUS }),
  ),
  "a null context entry": signed([AS, null], activity("Like", { object: LOCAL_STATUS })),
  "an unknown context URL": signed(
    [AS, "https://unknown.example/context.jsonld"],
    activity("Like", { object: LOCAL_STATUS }),
  ),
  "a nested context array": signed([AS, [SEC]], activity("Like", { object: LOCAL_STATUS })),
  "a context in the object": create(note({ "@context": { to: "https://other.example/to" } })),
  "a context in a tag entry": create(
    note({ tag: [{ "@context": { href: "https://other.example/href" }, type: "Mention", href: ALICE, name: "@a" }] }),
  ),
  "a context in a proof of the object": create(
    note({ proof: { "@context": DATA_INTEGRITY, type: "DataIntegrityProof" } }),
  ),

  // Contexts and keys ldSignedBodyReadable keeps.
  "Misskey's context": create(
    note({ atomUri: undefined, _misskey_content: "note", _misskey_quote: undefined, quoteUrl: undefined }),
    MISSKEY_CONTEXT,
  ),
  "Mastodon 4.4 and 4.5's forwarded context": create(note(), [AS, SEC, STATUS_EXTENSION]),
  "Mastodon 4.6's forwarded context": create(note(), [AS, SEC, WEBFINGER, STATUS_EXTENSION]),
  "Mastodon 4.7's forwarded context": create(note(), [AS, SEC, CID, WEBFINGER, STATUS_EXTENSION]),
  "a name outside the vocabulary with a key of its own": create(note({ extra: "kept" }), [
    ...STATUS_CONTEXT,
    { extra: "https://other.example/ns#extra" },
  ]),
  "an inline prefix named https": create(note(), [...STATUS_CONTEXT, { https: "https://other.example/" }]),

  // An embedded actor whose inbox is [null] (#1673): not blank as received, blank as compacted.
  "Update(Person) whose embedded inbox is [null]": signed(
    [AS, SEC],
    activity("Update", {
      to: [PUBLIC],
      object: { id: BOB, type: "Person", preferredUsername: "bob", name: "Bob renamed", inbox: [null] },
    }),
  ),
  // The patch stops at a member whose array the compaction shortened (a null left out), so the members after it in
  // the same object stay as the compaction left them.
  "a null in an array before a one-element array": signed(
    [AS, SEC],
    activity("Follow", { to: [null], object: [ALICE] }),
  ),

  // Rows 1 and 7: a type as an IRI, which the compaction writes as the vocabulary's name and the patch leaves so. The
  // retractions among them: alice's accepted follow of bob (follows/1) ended by bob, and bob's follow of her (14).
  "Reject of an accepted follow, its object's type as:Follow": signed(
    [AS, SEC],
    activity("Reject", { object: { ...OUR_FOLLOW, type: "as:Follow" } }),
  ),
  "Reject of an accepted follow, its object's type the absolute IRI": signed(
    [AS, SEC],
    activity("Reject", { object: { ...OUR_FOLLOW, type: `${AS}#Follow` } }),
  ),
  "Undo object type as the absolute IRI": signed(
    [AS, SEC],
    activity("Undo", { object: { ...BOBS_FOLLOW, type: `${AS}#Follow` } }),
  ),
  "Accept object type as the absolute IRI": signed(
    [AS, SEC],
    activity("Accept", { object: { id: OUR_FOLLOW.id, type: `${AS}#Follow` } }),
  ),
  "Reject typed as:Reject, of an accepted follow": signed([AS, SEC], activity("as:Reject", { object: OUR_FOLLOW })),
  "Undo typed as:Undo": signed([AS, SEC], activity("as:Undo", { object: BOBS_FOLLOW })),
  "Block typed as:Block, by an accepted follow's target": signed([AS, SEC], activity("as:Block", { object: ALICE })),
  "Delete typed as:Delete": signed(
    [AS, SEC],
    activity("as:Delete", { object: { id: `${BOB}/statuses/deleted`, type: "Tombstone" }, to: [PUBLIC] }),
  ),

  // An answer whose object id is alice's follow of bob, its type naming another kind: Mastodon seeks the follow by the
  // id first (accept.rb:5, reject.rb:5-7).
  "Reject of an accepted follow, its object typed as the QuoteRequest IRI": signed(
    [AS, SEC],
    activity("Reject", { object: { id: OUR_FOLLOW.id, type: QUOTE_REQUEST } }),
  ),
  "Reject of an accepted follow, its object typed QuoteRequest": signed(
    [AS, { QuoteRequest: QUOTE_REQUEST }, SEC],
    activity("Reject", { object: { id: OUR_FOLLOW.id, type: "QuoteRequest" } }),
  ),
  "Accept of a follow request, its object typed QuoteRequest": signed(
    [AS, { QuoteRequest: QUOTE_REQUEST }, SEC],
    activity("Accept", { object: { id: OUR_FOLLOW.id, type: "QuoteRequest" } }),
  ),

  // bob's Undo of his block of alice, both typed as IRIs: Mastodon renames the types only where it compacts the body,
  // and reads it as received (applying nothing) where it gives the compaction up.
  "Undo of a block, both typed as IRIs": signed([AS, SEC], activity("as:Undo", { object: BLOCK })),
  "Undo of a block, both typed as IRIs, past the value limit as received": padded(
    signed([AS, SEC], activity("as:Undo", { object: BLOCK })),
    1_001,
  ),
  // Within the limit as received, past it once full_context (90 values) replaces the three of its @context.
  "Undo of a block, both typed as IRIs, past the value limit once compacted": padded(
    signed([AS, SEC], activity("as:Undo", { object: BLOCK })),
    990,
  ),
  "Undo of a block, both typed as IRIs, with a proof in the data-integrity context": signed([AS, DATA_INTEGRITY, SEC], {
    ...activity("as:Undo", { object: BLOCK }),
    proof: {
      type: "DataIntegrityProof",
      cryptosuite: "eddsa-jcs-2022",
      verificationMethod: `${BOB}#ed25519-key`,
      proofPurpose: "assertionMethod",
      proofValue: "z3placeholder",
      created: "2026-11-16T12:00:00Z",
    },
  }),
  "Undo of a block, both typed as IRIs, with a type that is not a string": signed(
    [AS, SEC],
    activity("as:Undo", { object: BLOCK, tag: [{ type: 5, name: "x" }] }),
  ),
  "Undo of a block, both typed as IRIs, with a language map member that is not a string": signed(
    [AS, SEC],
    activity("as:Undo", { object: BLOCK, contentMap: { en: 5 } }),
  ),
  "Undo of a block, both typed as IRIs, with an IRI over a prefix only full_context defines": signed(
    [AS, SEC],
    activity("as:Undo", { object: BLOCK, cc: ["toot:followers"] }),
  ),
  "Undo of a block, both typed as IRIs, with an array in an array": signed(
    [AS, SEC],
    activity("as:Undo", { object: BLOCK, cc: [[PUBLIC]] }),
  ),
  "Undo of a block, both typed as IRIs, under an inline context": signed(
    [AS, SEC, { extra: "https://other.example/ns#extra" }],
    activity("as:Undo", { object: BLOCK, extra: "kept" }),
  ),
  "Undo of a block, both typed as IRIs, with @graph in its signature": {
    "@context": [AS, SEC],
    ...activity("as:Undo", { object: BLOCK }),
    signature: { ...SIGNATURE, "@graph": [] },
  },
  // An id or a type JSON-LD refuses (a null, or a type over a prefix the compaction's full_context defines and the
  // body's context does not); members JSON-LD processes inside a proof, which neither context defines; an @context
  // that alone passes the value limit; and members the compaction writes as more values than it reads.
  "Undo of a block, both typed as IRIs, with a null id": signed(
    [AS, SEC],
    activity("as:Undo", { object: BLOCK, instrument: { id: null } }),
  ),
  "Undo of a block, both typed as IRIs, with a null type": signed(
    [AS, SEC],
    activity("as:Undo", { object: BLOCK, tag: [{ type: null }] }),
  ),
  "Undo of a block, both typed as IRIs, with a null in a type array": signed(
    [AS, SEC],
    activity("as:Undo", { object: BLOCK, tag: [{ type: [null] }] }),
  ),
  "Undo of a block, both typed as IRIs, with a type over the toot prefix": signed(
    [AS, SEC],
    activity("as:Undo", { object: BLOCK, tag: [{ type: "toot:Foo" }] }),
  ),
  "Undo of a block, both typed as IRIs, with a type over the schema prefix": signed(
    [AS, SEC],
    activity("as:Undo", { object: BLOCK, tag: [{ type: "schema:Foo" }] }),
  ),
  "Undo of a block, both typed as IRIs, with a proof typed by a number": signed(
    [AS, SEC],
    activity("as:Undo", { object: BLOCK, proof: { "@type": 5 } }),
  ),
  "Undo of a block, both typed as IRIs, with a proof of a number tagged with a language": signed(
    [AS, SEC],
    activity("as:Undo", { object: BLOCK, proof: { "@value": 5, "@language": "en" } }),
  ),
  "Undo of a block, both typed as IRIs, with a proof whose id is null": signed(
    [AS, SEC],
    activity("as:Undo", { object: BLOCK, proof: { "@id": null } }),
  ),
  "Undo of a block, both typed as IRIs, under the ActivityStreams context repeated past the value limit": signed(
    Array.from({ length: 1_000 }, () => AS),
    activity("as:Undo", { object: BLOCK }),
  ),
  "Undo of a block, both typed as IRIs, with numbers as list members past the value limit once compacted": signed(
    [AS, SEC],
    activity("as:Undo", { object: BLOCK, instrument: Array.from({ length: 225 }, () => ({ orderedItems: 5 })) }),
  ),
  "Undo of a block, both typed as IRIs, with IRIs as lists past the value limit once compacted": signed(
    [AS, SEC],
    activity("as:Undo", {
      object: BLOCK,
      instrument: Array.from({ length: 320 }, (_, i) => ({ orderedItems: `${BOB}/items/${i}` })),
    }),
  ),
  // Bodies Mastodon compacts that the gate does not hold to: a proof whose members are plain names, and a number where
  // an IRI is expected.
  "Undo of a block, both typed as IRIs, with a proof of plain names": signed(
    [AS, SEC],
    activity("as:Undo", {
      object: BLOCK,
      proof: { type: "DataIntegrityProof", cryptosuite: "eddsa-jcs-2022", proofValue: "z3placeholder" },
    }),
  ),
  "Undo of a block, both typed as IRIs, with a number where an IRI is expected": signed(
    [AS, SEC],
    activity("as:Undo", { object: BLOCK, instrument: 5 }),
  ),
  // A language map name given an array: JSON-LD reads each member as a value of the term (an object as a node), not as
  // a language map, so a node's null type or id is refused there too.
  "Undo of a block, both typed as IRIs, with a null type in a language map array": signed(
    [AS, SEC],
    activity("as:Undo", { object: BLOCK, contentMap: [{ type: null }] }),
  ),
  "Undo of a block, both typed as IRIs, with a null id in a language map array": signed(
    [AS, SEC],
    activity("as:Undo", { object: BLOCK, summaryMap: [{ id: null }] }),
  ),
  // A type naming a keyword alias, which the gate does not hold to.
  "Undo of a block, both typed as IRIs, with a type naming id": signed(
    [AS, SEC],
    activity("as:Undo", { object: BLOCK, tag: [{ type: "id" }] }),
  ),
  "Undo of a block, both typed as IRIs, with a type naming type": signed(
    [AS, SEC],
    activity("as:Undo", { object: BLOCK, tag: [{ type: "type" }] }),
  ),
  // Language tags that are also the contexts' keyword aliases (`id` is Indonesian's): a language map all the same.
  "Undo of a block, both typed as IRIs, with a language map tagged id and type": signed(
    [AS, SEC],
    activity("as:Undo", { object: BLOCK, summaryMap: { id: "diblokir", type: "text" } }),
  ),

  // Names full_context defines that the ActivityStreams and security contexts leave undefined, as types and as members
  // (row 22): Mastodon's compaction writes each as a blank node's name (`_:QuoteRequest`), which its readers do not
  // read. Each beside the same body under a context that defines them.
  ...Object.fromEntries(
    /** @type {[string, unknown][]} */ ([
      ["left undefined", [AS, SEC]],
      ["defined", [AS, { QuoteRequest: QUOTE_REQUEST }, STATUS_EXTENSION, ACTOR_EXTENSION, SEC]],
    ]).flatMap(([variant, context]) => [
      [
        `QuoteRequest, its type ${variant}`,
        signed(context, activity("QuoteRequest", { object: LOCAL_STATUS, instrument: `${BOB}/statuses/quoting` })),
      ],
      [
        `Accept of our quote request, its object's type ${variant}`,
        signed(
          context,
          activity("Accept", {
            object: { id: OUR_QUOTE_REQUEST, type: "QuoteRequest", actor: ALICE, object: `${BOB}/statuses/pinned` },
            result: `${BOB}/quote_authorizations/1`,
          }),
        ),
      ],
      [
        `Note, its extension members and tag types ${variant}`,
        create(
          note({
            sensitive: true,
            conversation: "tag:mastodon.example,2026-11-16:objectId=1:objectType=Conversation",
            tag: [
              { type: "Hashtag", href: "https://mastodon.example/tags/kopje", name: "#kopje" },
              {
                type: "Emoji",
                id: "https://mastodon.example/emojis/1",
                name: ":kopje:",
                icon: { type: "Image", mediaType: "image/png", url: "https://mastodon.example/emoji/kopje.png" },
              },
            ],
            attachment: [
              {
                type: "Document",
                mediaType: "image/png",
                url: "https://mastodon.example/media/3.png",
                blurhash: "UBL_:rOpGG-oBUNG,qRj2so|=eE1w^n4S5NH",
                focalPoint: [0.5, -0.5],
              },
            ],
            quote: LOCAL_STATUS,
            _misskey_quote: LOCAL_STATUS,
            quoteUri: LOCAL_STATUS,
            quoteAuthorization: `${BOB}/quote_authorizations/2`,
            interactionPolicy: { canQuote: { automaticApproval: [PUBLIC], manualApproval: [FOLLOWERS] } },
          }),
          context,
        ),
      ],
      [
        `Question, its votersCount ${variant}`,
        create({ ...question([option("Yes"), option("No")]), votersCount: 3 }, context),
      ],
      [
        `Delete by an atomUri ${variant}`,
        signed(
          context,
          activity("Delete", {
            object: { id: `${BOB}/statuses/elsewhere`, type: "Tombstone", atomUri: `${BOB}/statuses/deleted` },
            to: [PUBLIC],
          }),
        ),
      ],
      [
        `Add of a Hashtag, its type ${variant}`,
        signed(
          context,
          activity("Add", {
            object: { type: "Hashtag", href: "https://mastodon.example/tags/kopje", name: "#kopje" },
            target: `${BOB}/collections/featured`,
          }),
        ),
      ],
      [
        `Update(Person), its extension members and types ${variant}`,
        signed(
          context,
          activity("Update", {
            to: [PUBLIC],
            object: {
              id: BOB,
              type: "Person",
              preferredUsername: "bob",
              name: "Bob renamed",
              inbox: `${BOB}/inbox`,
              outbox: `${BOB}/outbox`,
              followers: FOLLOWERS,
              following: `${BOB}/following`,
              featured: `${BOB}/collections/featured`,
              manuallyApprovesFollowers: true,
              discoverable: true,
              attachment: [{ type: "PropertyValue", name: "Site", value: "https://bob.example/" }],
              tag: [
                {
                  type: "Emoji",
                  id: "https://mastodon.example/emojis/2",
                  name: ":bob:",
                  icon: { type: "Image", mediaType: "image/png", url: "https://mastodon.example/emoji/bob.png" },
                },
              ],
            },
          }),
        ),
      ],
    ]),
  ),

  // A proof in the data-integrity context, a @graph container: Mastodon reads the body as received only where JSON-LD's
  // expansion leaves something of the proof, which the compaction then writes under a @graph key; of one that expands
  // to nothing it reads the compaction, the QuoteRequest left undefined a blank node's type.
  ...Object.fromEntries(
    /** @type {[string, unknown][]} */ ([
      ["a null value", { "@value": null }],
      ["a language alone", { "@language": "en" }],
      ["an empty set", { "@set": [] }],
      ["an array of a null value", [{ "@value": null }]],
      ["plain names", { type: "DataIntegrityProof", cryptosuite: "eddsa-jcs-2022", proofValue: "z3placeholder" }],
    ]).map(([variant, proof]) => [
      `QuoteRequest, its type left undefined, with a proof of ${variant}`,
      {
        ...signed(
          [AS, SEC, DATA_INTEGRITY],
          activity("QuoteRequest", { object: LOCAL_STATUS, instrument: `${BOB}/statuses/quoting` }),
        ),
        proof,
      },
    ]),
  ),

  // A value of a shape a name's type does not take: the compaction writes it under the name's IRI, which no reader
  // reads (a boolean for a name typed @id, an object for one typed with a datatype).
  "Note, its quote given as true": create(note({ quote: true, _misskey_quote: LOCAL_STATUS })),
  "Note, its automaticApproval given as an array of true": create(
    note({ interactionPolicy: { canQuote: { automaticApproval: [true] } } }),
  ),
  "Question, its closed given as an object": create({
    ...question([option("Yes"), option("No")]),
    closed: { id: `${BOB}/closed` },
  }),

  // sensitive typed otherwise than full_context, which leaves it untyped: the compaction writes it under the name all
  // the same, an IRI or a typed value as an object.
  ...Object.fromEntries(
    /** @type {[string, unknown, unknown][]} */ ([
      ["typed @id, given an IRI", "@id", `${BOB}/sensitive`],
      ["typed @id, given false", "@id", false],
      ["typed as a boolean, given false", "http://www.w3.org/2001/XMLSchema#boolean", false],
    ]).map(([variant, type, sensitive]) => [
      `Note, its sensitive ${variant}`,
      create(
        note({
          sensitive,
          attachment: [{ type: "Document", mediaType: "image/png", url: "https://mastodon.example/media/4.png" }],
        }),
        [AS, { ...STATUS_EXTENSION, sensitive: { "@id": "as:sensitive", "@type": type } }, SEC],
      ),
    ]),
  ),

  // #1717, form 4: bob's Undo of his block typed as absolute IRIs, in a body of each shape beyond the closed one, and
  // beside it a body of the same shape Mastodon reads as received (JSON::LD refuses it) or Kopje cannot show it
  // compacts. An inline context of definitions real senders write.
  "Undo of a block, both typed as absolute IRIs, under Mastodon's inline context": absoluteUndo({}, STATUS_CONTEXT),
  "Undo of a block, both typed as absolute IRIs, under Mastodon's inline context, its quote an IRI": absoluteUndo(
    { quote: `${BOB}/statuses/quoted` },
    STATUS_CONTEXT,
  ),
  "Undo of a block, both typed as absolute IRIs, under Fedify's inline context": absoluteUndo(
    { featured: `${BOB}/collections/featured`, votersCount: 3 },
    [
      AS,
      SEC,
      {
        toot: "http://joinmastodon.org/ns#",
        featured: { "@id": "toot:featured", "@type": "@id" },
        votersCount: { "@id": "toot:votersCount", "@type": "http://www.w3.org/2001/XMLSchema#nonNegativeInteger" },
      },
    ],
  ),
  "Undo of a block, both typed as absolute IRIs, under Mastodon's inline context, its quote over a prefix only full_context defines":
    absoluteUndo({ quote: "schema:quoted" }, STATUS_CONTEXT),
  "Undo of a block, both typed as absolute IRIs, under an inline definition no sender writes": absoluteUndo(
    { sensitive: false },
    [AS, SEC, { sensitive: { "@id": "as:sensitive", "@type": "xsd:boolean" } }],
  ),
  // An array directly in another, which JSON-LD's expansion flattens (but in a list, where it makes a list of lists).
  "Undo of a block, both typed as absolute IRIs, with an array in an array": absoluteUndo({ cc: [[PUBLIC]] }),
  "Undo of a block, both typed as absolute IRIs, with arrays in an array": absoluteUndo({
    cc: [[PUBLIC, FOLLOWERS], [ALICE]],
  }),
  "Undo of a block, both typed as absolute IRIs, with an array in an array under a list": absoluteUndo({
    instrument: { orderedItems: [[ALICE]] },
  }),
  // A proof of plain names given strings, which the ActivityStreams and security contexts leave undefined.
  "Undo of a block, both typed as absolute IRIs, with a proof of plain names": absoluteUndo({
    proof: { type: "DataIntegrityProof", cryptosuite: "eddsa-jcs-2022", proofValue: "z3placeholder" },
  }),
  "Undo of a block, both typed as absolute IRIs, with two proofs of plain names": absoluteUndo({
    proof: [
      { type: "DataIntegrityProof", cryptosuite: "eddsa-jcs-2022", proofValue: "z3first" },
      { type: "DataIntegrityProof", cryptosuite: "eddsa-jcs-2022", proofValue: "z3second" },
    ],
  }),
  "Undo of a block, both typed as absolute IRIs, with a proof whose creator is over a prefix only full_context defines":
    absoluteUndo({ proof: { type: "DataIntegrityProof", creator: "toot:key" } }),
  "Undo of a block, both typed as absolute IRIs, with a proof whose @id is over a prefix only full_context defines":
    absoluteUndo({ proof: { "@id": "toot:proof", type: "DataIntegrityProof" } }),
  // A number or a boolean where an IRI is expected, which the compaction writes under the name's IRI.
  "Undo of a block, both typed as absolute IRIs, with a number where an IRI is expected": absoluteUndo({
    instrument: 5,
  }),
  "Undo of a block, both typed as absolute IRIs, with a boolean where an IRI is expected": absoluteUndo({ cc: true }),
  "Undo of a block, both typed as absolute IRIs, with a number among the IRIs of to": absoluteUndo({
    to: [5, PUBLIC],
  }),
  "Undo of a block, both typed as absolute IRIs, with a number as an id": absoluteUndo({ instrument: { id: 5 } }),
  // Where a retraction's handler reads an IRI: Mastodon reads no actor (the request's signer is its actor) and no
  // object of the block.
  "Undo of a block, both typed as absolute IRIs, with a number as its actor": absoluteUndo({ actor: 5 }),
  "Undo of a block, both typed as absolute IRIs, with a number as its block's object": absoluteUndo({
    object: { ...BLOCK, type: `${AS}#Block`, object: 5 },
  }),
  // A blank node, a relative reference or an IRI of another scheme, which the compaction writes as given (Mastodon's
  // has no base), but one whose scheme is a prefix only full_context defines, which raises.
  "Undo of a block, both typed as absolute IRIs, with a blank node as an id": absoluteUndo({
    instrument: { id: "_:client" },
  }),
  "Undo of a block, both typed as absolute IRIs, with a relative reference as an id": absoluteUndo({
    instrument: { id: "clients/1" },
  }),
  "Undo of a block, both typed as absolute IRIs, with IRIs of other schemes": absoluteUndo({
    cc: [
      "urn:uuid:9f0c3e1a",
      "tag:mastodon.example,2026:followers",
      "HTTPS://mastodon.example/users/bob/followers",
      "https:mastodon.example/users/bob/following",
      "mailto:bob@mastodon.example",
      "_:followers",
      "followers?page=1#top",
    ],
  }),
  "Undo of a block, both typed as absolute IRIs, with an id of another scheme": {
    ...absoluteUndo(),
    id: "urn:uuid:9f0c3e1a",
  },
  "Undo of a block, both typed as absolute IRIs, with a relative reference as its block's id": absoluteUndo({
    object: { ...BLOCK, id: "blocks/1", type: `${AS}#Block` },
  }),
  "Undo of a block, both typed as absolute IRIs, with an IRI whose scheme is a prefix of full_context": absoluteUndo({
    instrument: { id: "as://client" },
  }),
  "Undo of a block, both typed as absolute IRIs, with an IRI over the wf prefix": absoluteUndo({
    cc: ["wf:followers"],
  }),
  // Ones the compaction writes otherwise: a keyword-like one it drops, and a blank node with no label, or one holding
  // `_:`, that Ruby's json-ld labels anew. And ones jsonld.js writes otherwise, resolving them against an empty base:
  // an empty one, a network-path reference, one holding whitespace, and a relative reference of a dot segment.
  "Undo of a block, both typed as absolute IRIs, with a keyword-like id": absoluteUndo({
    instrument: { id: "@client" },
  }),
  "Undo of a block, both typed as absolute IRIs, with a blank node of no label": absoluteUndo({
    instrument: { id: "_:" },
  }),
  "Undo of a block, both typed as absolute IRIs, with a blank node whose label holds _:": absoluteUndo({
    instrument: { id: "_:_:client" },
  }),
  "Undo of a block, both typed as absolute IRIs, with an empty id": absoluteUndo({ instrument: { id: "" } }),
  "Undo of a block, both typed as absolute IRIs, with a network-path reference": absoluteUndo({
    instrument: { id: "//mastodon.example/client" },
  }),
  "Undo of a block, both typed as absolute IRIs, with an IRI holding whitespace": absoluteUndo({
    instrument: { id: "urn:client 1" },
  }),
  "Undo of a block, both typed as absolute IRIs, with a relative reference of a dot segment": absoluteUndo({
    instrument: { id: "./client" },
  }),
  "Undo of a block, both typed as absolute IRIs, with a relative reference of a double-dot segment": absoluteUndo({
    instrument: { id: "../client" },
  }),
  // A type naming a keyword alias, which JSON-LD expands to the keyword and the compaction writes as the alias again.
  "Undo of a block, both typed as absolute IRIs, with a type naming id": absoluteUndo({ tag: [{ type: "id" }] }),
  "Undo of a block, both typed as absolute IRIs, with a type naming type": absoluteUndo({ tag: [{ type: "type" }] }),
  // A language map name given strings otherwise than as a map of tags to strings: an array of them, or one, which
  // JSON-LD reads as values of the name, and a tag given an array of them; and, beside them, a number or a node, a tag
  // given a number, or an array in such an array, and an upper-case tag given an array.
  "Undo of a block, both typed as absolute IRIs, with a language map given as an array": absoluteUndo({
    contentMap: ["blocked", "unblocked"],
  }),
  "Undo of a block, both typed as absolute IRIs, with a language map given as a string": absoluteUndo({
    summaryMap: "blocked",
  }),
  "Undo of a block, both typed as absolute IRIs, with a language map of a tag to an array": absoluteUndo({
    nameMap: { en: ["blocked", "unblocked"], ja: "ブロック" },
  }),
  "Undo of a block, both typed as absolute IRIs, with a language map given as a number": absoluteUndo({
    summaryMap: 5,
  }),
  "Undo of a block, both typed as absolute IRIs, with a language map given as an array holding a node": absoluteUndo({
    contentMap: ["blocked", { type: "Note", content: "a node" }],
  }),
  "Undo of a block, both typed as absolute IRIs, with a language map member that is not a string": absoluteUndo({
    contentMap: { en: 5 },
  }),
  "Undo of a block, both typed as absolute IRIs, with a language map of a tag to an array in an array": absoluteUndo({
    nameMap: { en: [["blocked"]] },
  }),
  "Undo of a block, both typed as absolute IRIs, with a language map of an upper-case tag to an array": absoluteUndo({
    nameMap: { EN: ["blocked"] },
  }),
  // Within the value limit once compacted, where three for each value passes it, and past it.
  "Undo of a block, both typed as absolute IRIs, within the value limit once compacted": padded(absoluteUndo(), 700),
  "Undo of a block, both typed as absolute IRIs, past the value limit once compacted": padded(absoluteUndo(), 990),
};

// The same bodies without a signature: read as received by both.
const unsigned = Object.fromEntries(
  [
    "@base after ActivityStreams",
    "a keyword alias beside the literal type",
    "an alias of to with to redefined",
    "Reject of an accepted follow, its object's type as:Follow",
    "Accept object type as an IRI",
    "Reject of an accepted follow, its object typed QuoteRequest",
    "Accept of a follow request, its object typed QuoteRequest",
  ].map((name) => {
    const { signature: _, ...body } = forms[name];
    return [`${name}, unsigned`, body];
  }),
);

const entries = Object.entries({ ...forms, ...unsigned }).map(([name, received]) => ({
  name,
  received: /** @type {unknown} */ (JSON.parse(JSON.stringify(received))),
}));
console.log(JSON.stringify(entries, null, 2));
