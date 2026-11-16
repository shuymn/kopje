// Mastodon's full_context (app/helpers/context_helper.rb: NAMED_CONTEXT_MAP in order, then the merged
// CONTEXT_EXTENSION_MAP, serialized_context), read from each release tag's source: v4.4.0 to v4.4.28, v4.5.0 to
// v4.5.21, v4.6.0 to v4.6.11 and v4.7.0 to v4.7.5. Mastodon compacts a signed activity under full_context before it
// forwards it (ActivityPub::ProcessCollectionService in 4.4 to 4.6, ActivityPub::ProcessActivityService in 4.7;
// JsonLdHelper#compact), so a Delete another Mastodon forwards carries one release line's named contexts and then one
// such object (federation/author-proof.ts, the forwarded profiles).

const AS = "https://www.w3.org/ns/activitystreams";
const SECURITY = "https://w3id.org/security/v1";
const CID = "https://www.w3.org/ns/cid/v1";
const WEBFINGER = "https://purl.archive.org/socialweb/webfinger";

// NAMED_CONTEXT_MAP of each release line, in order: 4.4 and 4.5; 4.6, which adds webfinger; 4.7, which adds cid/v1
// before it. Every URL is one of Fedify's preloaded contexts. cid/v1's scoped contexts apply only under a `service` key
// or to a node typed Multikey or JsonWebKey, which no profile body can carry (its keys and types are closed).
export const MASTODON_NAMED_CONTEXTS: readonly (readonly string[])[] = [
  [AS, SECURITY],
  [AS, SECURITY, WEBFINGER],
  [AS, SECURITY, CID, WEBFINGER],
];

// Every term full_context defines in its extension object, with each definition any release gave it: the union over
// the tags above (4.6 and 4.7 share one object, which adds showFeatured to featureAuthorization to 4.5's terms). A term
// whose definition changed between releases lists each one, the one 4.6 and 4.7 give last. test/author-proof.test.ts
// shows no term is, or aliases, one the decision reads.
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
  showFeatured: ["toot:showFeatured"],
  showMedia: ["toot:showMedia"],
  showRepliesInMedia: ["toot:showRepliesInMedia"],
  QuoteRequest: ["https://w3id.org/fep/044f#QuoteRequest"],
  gts: ["https://gotosocial.org/ns#"],
  interactionPolicy: [{ "@id": "gts:interactionPolicy", "@type": "@id" }],
  canFeature: [{ "@id": "https://w3id.org/fep/7aa9#canFeature", "@type": "@id" }],
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
  FeatureRequest: ["https://w3id.org/fep/7aa9#FeatureRequest"],
  FeaturedCollection: ["https://w3id.org/fep/7aa9#FeaturedCollection"],
  FeaturedItem: ["https://w3id.org/fep/7aa9#FeaturedItem"],
  FeatureAuthorization: ["https://w3id.org/fep/7aa9#FeatureAuthorization"],
  topic: [{ "@id": "https://w3id.org/fep/7aa9#topic", "@type": "@id" }],
  featuredObject: [{ "@id": "https://w3id.org/fep/7aa9#featuredObject", "@type": "@id" }],
  featureAuthorization: [{ "@id": "https://w3id.org/fep/7aa9#featureAuthorization", "@type": "@id" }],
};

// full_context as 4.7 (v4.7.0 to v4.7.5) serializes it: its named contexts, then its extension object, each term
// with the definition 4.7 gives (the last MASTODON_CONTEXT_TERMS lists).
export const MASTODON_FULL_CONTEXT: readonly unknown[] = [
  ...MASTODON_NAMED_CONTEXTS[2]!,
  Object.fromEntries(Object.entries(MASTODON_CONTEXT_TERMS).map(([term, definitions]) => [term, definitions.at(-1)])),
];
