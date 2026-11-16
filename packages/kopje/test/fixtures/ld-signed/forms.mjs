// LD-signed bodies in the forms whose readings differ (docs/mastodon-deviations.md, "Reading inbound activities"), and
// the contexts and keys ldSignedBodyReadable refuses or keeps, for forms.json (inbox-signed-forms.test.ts). Each entry
// is { name, received }; compact.rb adds Mastodon's reading. Run from packages/kopje:
//
//   node test/fixtures/ld-signed/forms.mjs > forms-in.json
//
// The signature is a placeholder: Mastodon compacts a body whose signature is an object before it verifies anything.
// The sender is bob on mastodon.example; alice is local (kopje.test), and LOCAL_STATUS stands for a local status of
// hers, which the tests replace with one they create.

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
};

// The same bodies without a signature: read as received by both.
const unsigned = Object.fromEntries(
  ["@base after ActivityStreams", "a keyword alias beside the literal type", "an alias of to with to redefined"].map(
    (name) => {
      const { signature: _, ...body } = forms[name];
      return [`${name}, unsigned`, body];
    },
  ),
);

const entries = Object.entries({ ...forms, ...unsigned }).map(([name, received]) => ({
  name,
  received: /** @type {unknown} */ (JSON.parse(JSON.stringify(received))),
}));
console.log(JSON.stringify(entries, null, 2));
