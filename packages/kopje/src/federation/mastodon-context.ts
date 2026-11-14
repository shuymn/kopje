// Every term Mastodon's full_context defines in its third entry, the object after activitystreams and security/v1
// (app/helpers/context_helper.rb: NAMED_CONTEXT_MAP and the merged CONTEXT_EXTENSION_MAP, serialized_context), with
// each definition any release gave it: the union over the tags v4.4.0 to v4.4.28 and v4.5.0 to v4.5.21, read from each
// tag's source. Mastodon compacts a signed activity under full_context before it forwards it
// (ActivityPub::ProcessCollectionService, JsonLdHelper#compact), so a Delete another Mastodon forwards carries such an
// object (federation/author-proof.ts, the forwarded profiles). A term whose definition changed between releases lists
// each one. test/author-proof.test.ts shows no term is, or aliases, one the decision reads.
export const MASTODON_CONTEXT_TERMS: Readonly<Record<string, readonly unknown[]>> = {
  manuallyApprovesFollowers: ["as:manuallyApprovesFollowers"],
  sensitive: ["as:sensitive"],
  Hashtag: ["as:Hashtag"],
  movedTo: [{ "@id": "as:movedTo", "@type": "@id" }],
  alsoKnownAs: [{ "@id": "as:alsoKnownAs", "@type": "@id" }],
  toot: ["http://joinmastodon.org/ns#"],
  Emoji: ["toot:Emoji"],
  featured: [{ "@id": "toot:featured", "@type": "@id" }],
  featuredTags: [{ "@id": "toot:featuredTags", "@type": "@id" }],
  schema: ["http://schema.org#"],
  PropertyValue: ["schema:PropertyValue"],
  value: ["schema:value"],
  ostatus: ["http://ostatus.org#"],
  atomUri: ["ostatus:atomUri"],
  inReplyToAtomUri: ["ostatus:inReplyToAtomUri"],
  conversation: ["ostatus:conversation"],
  focalPoint: [{ "@container": "@list", "@id": "toot:focalPoint" }],
  blurhash: ["toot:blurhash"],
  discoverable: ["toot:discoverable"],
  indexable: ["toot:indexable"],
  memorial: ["toot:memorial"],
  votersCount: ["toot:votersCount"],
  suspended: ["toot:suspended"],
  attributionDomains: [
    { "@id": "toot:attributionDomains", "@type": "@id" },
    { "@id": "toot:attributionDomains", "@container": "@set" },
  ],
  QuoteRequest: ["https://w3id.org/fep/044f#QuoteRequest"],
  gts: ["https://gotosocial.org/ns#"],
  interactionPolicy: [{ "@id": "gts:interactionPolicy", "@type": "@id" }],
  canQuote: [{ "@id": "gts:canQuote", "@type": "@id" }],
  automaticApproval: [{ "@id": "gts:automaticApproval", "@type": "@id" }],
  manualApproval: [{ "@id": "gts:manualApproval", "@type": "@id" }],
  quote: ["https://w3id.org/fep/044f#quote", { "@id": "https://w3id.org/fep/044f#quote", "@type": "@id" }],
  quoteUri: ["http://fedibird.com/ns#quoteUri"],
  _misskey_quote: ["https://misskey-hub.net/ns#_misskey_quote"],
  quoteAuthorization: [{ "@id": "https://w3id.org/fep/044f#quoteAuthorization", "@type": "@id" }],
  interactingObject: [{ "@id": "gts:interactingObject" }, { "@id": "gts:interactingObject", "@type": "@id" }],
  interactionTarget: [{ "@id": "gts:interactionTarget" }, { "@id": "gts:interactionTarget", "@type": "@id" }],
  QuoteAuthorization: ["https://w3id.org/fep/044f#QuoteAuthorization"],
};
