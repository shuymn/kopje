import { exportSpki, signJsonLd, signObject } from "@fedify/fedify";
import { CryptographicKey, Delete, Multikey, Person } from "@fedify/vocab";
import jsonld from "jsonld/dist/jsonld.esm.js";

import { RSA_ALGORITHM } from "../src/security/key-wrap";
import { NOW } from "./app-helpers";
import { MASTODON, mastodonActor, type RemoteWeb, serveOwnHandle, type TestActor } from "./inbox-helpers";
import { AS, PUBLIC } from "./inbox-status-helpers";
import { contexts } from "./quote-helpers";

// Signed Deletes as Mastodon 4.4 to 4.7 send them (federation/author-proof.ts PROFILES), for the tests that relay or
// forward them.

type Json = Record<string, unknown>;

const SECURITY = "https://w3id.org/security/v1";

// ActivityPub::DeleteSerializer's status Delete: the TombstoneSerializer's atom_uri extension
// (app/helpers/context_helper.rb), and security/v1 that LinkedDataSignature#sign! appends. `id` defaults to the
// serializer's `<status>#delete`.
export function mastodonDelete(actor: TestActor, uri: string, id = `${uri}#delete`): Json {
  return {
    "@context": [AS, { ostatus: "http://ostatus.org#", atomUri: "ostatus:atomUri" }, SECURITY],
    id,
    type: "Delete",
    actor: actor.uri,
    to: [PUBLIC],
    object: { id: uri, type: "Tombstone", atomUri: uri },
  };
}

// ActivityPub::DeleteQuoteAuthorizationSerializer's stamp Delete, its object the QuoteAuthorizationSerializer's
// (context_helper.rb quote_authorizations), with security/v1 that sign! appends.
export function mastodonStampDelete(actor: TestActor, stamp: { uri: string; quoting: string; quoted: string }): Json {
  return {
    "@context": [
      AS,
      {
        gts: "https://gotosocial.org/ns#",
        QuoteAuthorization: "https://w3id.org/fep/044f#QuoteAuthorization",
        interactingObject: { "@id": "gts:interactingObject", "@type": "@id" },
        interactionTarget: { "@id": "gts:interactionTarget", "@type": "@id" },
      },
      SECURITY,
    ],
    id: `${stamp.uri}#delete`,
    type: "Delete",
    actor: actor.uri,
    to: [PUBLIC],
    object: {
      id: stamp.uri,
      type: "QuoteAuthorization",
      attributedTo: actor.uri,
      interactingObject: stamp.quoting,
      interactionTarget: stamp.quoted,
    },
  };
}

// The RsaSignature2017 LinkedDataSignature#sign! writes up to 4.6 (type, creator, created, signatureValue: no @context
// of its own, which Fedify's signJsonLd adds and its verification ignores), by `signer`'s key.
export async function mastodonSigned(json: Json, signer: TestActor): Promise<Json> {
  const signed = (await signJsonLd(json, signer.privateKey, new URL(signer.keyId), {
    contextLoader: contexts,
  })) as Json;
  const { "@context": _context, ...signature } = signed.signature as Json;
  return { ...signed, signature };
}

// The time sign! writes: Time#iso8601 of a UTC time, whole seconds.
export function signTime(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(0, 19)}Z`;
}

// The RsaSignature2017 LinkedDataSignature#sign! writes from 4.7.0 (Mastodon v4.7.3 linked_data_signature.rb:39-58),
// by `signer`'s key: the options type, creator, created and expires (by default the test's NOW and two days later); the
// message the hex SHA-256 of the options but type under identity/v1, then that of the body without its signature, each
// canonicalized with RDFC-1.0 (as Fedify's verification hashes them); the body's @context as sign! leaves it (it
// appends security/v1 once, which these bodies already end with).
export async function mastodon47Signed(
  json: Json,
  signer: TestActor,
  options: { created?: string; expires?: string | number } = {},
): Promise<Json> {
  const { signature: _signature, ...body } = json;
  const created = options.created ?? signTime(NOW);
  const expires = options.expires ?? signTime(NOW + 2 * 24 * 60 * 60 * 1000);
  const hash = async (document: unknown) => {
    const canonical = await jsonld.canonize(document, {
      algorithm: "RDFC-1.0",
      format: "application/n-quads",
      documentLoader: contexts,
    });
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  };
  const message =
    (await hash({ creator: signer.keyId, created, expires, "@context": "https://w3id.org/identity/v1" })) +
    (await hash(body));
  const value = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signer.privateKey, new TextEncoder().encode(message));
  const signatureValue = btoa(String.fromCharCode(...new Uint8Array(value)));
  return { ...body, signature: { type: "RsaSignature2017", creator: signer.keyId, created, expires, signatureValue } };
}

// A Mastodon 4.7 Person (ActivityPub::ActorSerializer of v4.7.5: `context :security, :webfinger` and its extensions,
// webfinger, showFeatured, showMedia and showRepliesInMedia), its key one created on 4.7 (Account#generate_keys:
// `#rsa-` and 16 hex digits), served on `web` in place of mastodonActor's.
export async function mastodon47Actor(
  web: RemoteWeb,
  username: string,
  options: { key?: number; origin?: string } = {},
): Promise<TestActor> {
  const actor = await mastodonActor(web, username, options);
  const keyId = `${actor.uri}#rsa-0123456789abcdef`;
  const document: Json = {
    ...actor.document,
    "@context": [
      AS,
      SECURITY,
      "https://purl.archive.org/socialweb/webfinger",
      {
        manuallyApprovesFollowers: "as:manuallyApprovesFollowers",
        toot: "http://joinmastodon.org/ns#",
        featured: { "@id": "toot:featured", "@type": "@id" },
        featuredTags: { "@id": "toot:featuredTags", "@type": "@id" },
        alsoKnownAs: { "@id": "as:alsoKnownAs", "@type": "@id" },
        movedTo: { "@id": "as:movedTo", "@type": "@id" },
        schema: "http://schema.org#",
        PropertyValue: "schema:PropertyValue",
        value: "schema:value",
        discoverable: "toot:discoverable",
        suspended: "toot:suspended",
        memorial: "toot:memorial",
        indexable: "toot:indexable",
        attributionDomains: { "@id": "toot:attributionDomains", "@container": "@set" },
        showFeatured: "toot:showFeatured",
        showMedia: "toot:showMedia",
        showRepliesInMedia: "toot:showRepliesInMedia",
        gts: "https://gotosocial.org/ns#",
        interactionPolicy: { "@id": "gts:interactionPolicy", "@type": "@id" },
        canFeature: { "@id": "https://w3id.org/fep/7aa9#canFeature", "@type": "@id" },
        canQuote: { "@id": "gts:canQuote", "@type": "@id" },
        automaticApproval: { "@id": "gts:automaticApproval", "@type": "@id" },
        manualApproval: { "@id": "gts:manualApproval", "@type": "@id" },
        focalPoint: { "@container": "@list", "@id": "toot:focalPoint" },
      },
    ],
    webfinger: `${username}@${new URL(actor.uri).host}`,
    showFeatured: true,
    showMedia: true,
    showRepliesInMedia: true,
    publicKey: { id: keyId, owner: actor.uri, publicKeyPem: actor.pem },
  };
  web.serve(actor.uri, document);
  return { ...actor, keyId, document };
}

// The @context of a Delete Mastodon 4.5.21 forwarded, as received from it: its full_context
// (app/helpers/context_helper.rb), which ActivityPub::ProcessCollectionService compacts a signed body under before
// ActivityPub::Forwarder sends it.
export const MASTODON_45_FORWARDED_CONTEXT = [
  "https://www.w3.org/ns/activitystreams",
  "https://w3id.org/security/v1",
  {
    manuallyApprovesFollowers: "as:manuallyApprovesFollowers",
    sensitive: "as:sensitive",
    Hashtag: "as:Hashtag",
    movedTo: { "@id": "as:movedTo", "@type": "@id" },
    alsoKnownAs: { "@id": "as:alsoKnownAs", "@type": "@id" },
    toot: "http://joinmastodon.org/ns#",
    Emoji: "toot:Emoji",
    featured: { "@id": "toot:featured", "@type": "@id" },
    featuredTags: { "@id": "toot:featuredTags", "@type": "@id" },
    schema: "http://schema.org#",
    PropertyValue: "schema:PropertyValue",
    value: "schema:value",
    ostatus: "http://ostatus.org#",
    atomUri: "ostatus:atomUri",
    inReplyToAtomUri: "ostatus:inReplyToAtomUri",
    conversation: "ostatus:conversation",
    focalPoint: { "@container": "@list", "@id": "toot:focalPoint" },
    blurhash: "toot:blurhash",
    discoverable: "toot:discoverable",
    indexable: "toot:indexable",
    memorial: "toot:memorial",
    votersCount: "toot:votersCount",
    suspended: "toot:suspended",
    attributionDomains: { "@id": "toot:attributionDomains", "@container": "@set" },
    QuoteRequest: "https://w3id.org/fep/044f#QuoteRequest",
    quote: { "@id": "https://w3id.org/fep/044f#quote", "@type": "@id" },
    quoteUri: "http://fedibird.com/ns#quoteUri",
    _misskey_quote: "https://misskey-hub.net/ns#_misskey_quote",
    quoteAuthorization: { "@id": "https://w3id.org/fep/044f#quoteAuthorization", "@type": "@id" },
    gts: "https://gotosocial.org/ns#",
    interactionPolicy: { "@id": "gts:interactionPolicy", "@type": "@id" },
    canQuote: { "@id": "gts:canQuote", "@type": "@id" },
    automaticApproval: { "@id": "gts:automaticApproval", "@type": "@id" },
    manualApproval: { "@id": "gts:manualApproval", "@type": "@id" },
    QuoteAuthorization: "https://w3id.org/fep/044f#QuoteAuthorization",
    interactingObject: { "@id": "gts:interactingObject", "@type": "@id" },
    interactionTarget: { "@id": "gts:interactionTarget", "@type": "@id" },
  },
];

// full_context's extension object at every tag v4.6.0 to v4.7.5, in Ruby's merge order. Regenerate with
// `SRC="$(git -C <mastodon> show v4.7.5:app/helpers/context_helper.rb)" ruby -rjson -e 'eval(ENV["SRC"]);
// o=Object.new; o.extend(ContextHelper); puts JSON.pretty_generate(o.full_context)'`.
const MASTODON_46_EXTENSIONS = {
  manuallyApprovesFollowers: "as:manuallyApprovesFollowers",
  sensitive: "as:sensitive",
  Hashtag: "as:Hashtag",
  movedTo: { "@id": "as:movedTo", "@type": "@id" },
  alsoKnownAs: { "@id": "as:alsoKnownAs", "@type": "@id" },
  toot: "http://joinmastodon.org/ns#",
  Emoji: "toot:Emoji",
  featured: { "@id": "toot:featured", "@type": "@id" },
  featuredTags: { "@id": "toot:featuredTags", "@type": "@id" },
  schema: "http://schema.org#",
  PropertyValue: "schema:PropertyValue",
  value: "schema:value",
  ostatus: "http://ostatus.org#",
  atomUri: "ostatus:atomUri",
  inReplyToAtomUri: "ostatus:inReplyToAtomUri",
  conversation: "ostatus:conversation",
  focalPoint: { "@container": "@list", "@id": "toot:focalPoint" },
  blurhash: "toot:blurhash",
  discoverable: "toot:discoverable",
  indexable: "toot:indexable",
  memorial: "toot:memorial",
  votersCount: "toot:votersCount",
  suspended: "toot:suspended",
  attributionDomains: { "@id": "toot:attributionDomains", "@container": "@set" },
  showFeatured: "toot:showFeatured",
  showMedia: "toot:showMedia",
  showRepliesInMedia: "toot:showRepliesInMedia",
  QuoteRequest: "https://w3id.org/fep/044f#QuoteRequest",
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
  QuoteAuthorization: "https://w3id.org/fep/044f#QuoteAuthorization",
  interactingObject: { "@id": "gts:interactingObject", "@type": "@id" },
  interactionTarget: { "@id": "gts:interactionTarget", "@type": "@id" },
  FeatureRequest: "https://w3id.org/fep/7aa9#FeatureRequest",
  FeaturedCollection: "https://w3id.org/fep/7aa9#FeaturedCollection",
  FeaturedItem: "https://w3id.org/fep/7aa9#FeaturedItem",
  FeatureAuthorization: "https://w3id.org/fep/7aa9#FeatureAuthorization",
  topic: { "@id": "https://w3id.org/fep/7aa9#topic", "@type": "@id" },
  featuredObject: { "@id": "https://w3id.org/fep/7aa9#featuredObject", "@type": "@id" },
  featureAuthorization: { "@id": "https://w3id.org/fep/7aa9#featureAuthorization", "@type": "@id" },
};

// The @context of a Delete Mastodon 4.6.11 forwards (ActivityPub::ProcessCollectionService), and of one Mastodon 4.7.5
// forwards (ActivityPub::ProcessActivityService): full_context at those tags.
export const MASTODON_46_FORWARDED_CONTEXT = [
  "https://www.w3.org/ns/activitystreams",
  "https://w3id.org/security/v1",
  "https://purl.archive.org/socialweb/webfinger",
  MASTODON_46_EXTENSIONS,
];
export const MASTODON_47_FORWARDED_CONTEXT = [
  "https://www.w3.org/ns/activitystreams",
  "https://w3id.org/security/v1",
  "https://www.w3.org/ns/cid/v1",
  "https://purl.archive.org/socialweb/webfinger",
  MASTODON_46_EXTENSIONS,
];

// The @context a Mastodon of each release line forwards under (full_context at v4.5.21, v4.6.11 and v4.7.5).
export const MASTODON_FORWARDED_CONTEXTS = [
  ["4.5.21", MASTODON_45_FORWARDED_CONTEXT],
  ["4.6.11", MASTODON_46_FORWARDED_CONTEXT],
  ["4.7.5", MASTODON_47_FORWARDED_CONTEXT],
] as const;

// `signed` with its @context replaced by `context` and its signature kept: what a Mastodon holding a boost or quote of a
// status forwards of its signed Delete (JsonLdHelper#compact under full_context, then patch_for_forwarding! putting back
// every value but the @context). Every key of Mastodon's and Kopje's status Deletes is a full_context term, so the
// compaction changes nothing else (checked once with jsonld.js, not with Mastodon's Ruby). Mastodon's stamp Delete
// (4.5.10 on) and Kopje's are forwarded this way too (checked with jsonld.js, not with Mastodon's Ruby).
export function mastodonForwarded(signed: Json, context: unknown = MASTODON_45_FORWARDED_CONTEXT): Json {
  return { ...signed, "@context": context };
}

// What a Mastodon 4.7 forwards of a signed activity it did not author, as received: a reply to a local status
// (Activity::Create#forward_for_reply, signed by the replied-to account) or an edit of a status a local account shared
// (ProcessStatusUpdateService#forward_activity!, signed by a sharer). ProcessActivityService compacts the body under
// full_context, which drops null values, and patch_for_forwarding! puts back every other value of these bodies (Public,
// single-item arrays); the signature is kept. Checked once with jsonld.js and a port of patch_for_forwarding! (equal,
// member order aside), not with Mastodon's Ruby.
export function mastodonForwardedActivity(signed: Json, context: unknown = MASTODON_47_FORWARDED_CONTEXT): Json {
  const compacted = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(compacted)
      : typeof value === "object" && value !== null
        ? Object.fromEntries(
            Object.entries(value)
              .filter(([, v]) => v !== null)
              .map(([k, v]) => [k, compacted(v)]),
          )
        : value;
  const { signature, ...body } = signed;
  return { ...(compacted(body) as Json), "@context": context, signature };
}

// An actor of mastodon.example with an RSA key (its HTTP signatures) and an Ed25519 assertion method (Multikey, its
// FEP-8b32 proofs), served on `web`, with two signers by that key:
//   - fedify: the Delete Fedify's signObject writes (its default Delete context, copied into the proof), as a sender
//     built on Fedify sends it;
//   - sign: an eddsa-jcs-2022 proof over any document (vc-di-eddsa §3.3: the SHA-256 of the JCS of the proof
//     configuration, its @context `proofContext`, by default the document's, then of the document), its proof carrying
//     that @context unless `omitContext`, and the proof options `extra` in its configuration and proof.
export async function fepActor(web: RemoteWeb, username: string) {
  const rsa = (await crypto.subtle.generateKey(
    { ...RSA_ALGORITHM, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const ed = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const uri = `${MASTODON}/users/${username}`;
  const keyId = `${uri}#ed25519-key`;
  const person = new Person({
    id: new URL(uri),
    preferredUsername: username,
    inbox: new URL(`${uri}/inbox`),
    publicKey: new CryptographicKey({ id: new URL(`${uri}#main-key`), owner: new URL(uri), publicKey: rsa.publicKey }),
    assertionMethods: [new Multikey({ id: new URL(keyId), controller: new URL(uri), publicKey: ed.publicKey })],
  });
  const document = (await person.toJsonLd({ format: "compact", contextLoader: contexts })) as Json;
  web.serve(uri, document);
  serveOwnHandle(web, document);
  const actor: TestActor = {
    uri,
    keyId: `${uri}#main-key`,
    privateKey: rsa.privateKey,
    pem: await exportSpki(rsa.publicKey),
    document,
  };
  const fedify = async (id: string, object: string): Promise<Json> => {
    const unsigned = new Delete({ id: new URL(id), actor: new URL(uri), object: new URL(object) });
    const signed = await signObject(unsigned, ed.privateKey, new URL(keyId), {
      contextLoader: contexts,
      documentLoader: contexts,
    });
    return (await signed.toJsonLd({ format: "compact", contextLoader: contexts })) as Json;
  };
  const sign = async (
    body: Json,
    options: { proofContext?: unknown; omitContext?: boolean; extra?: Json } = {},
  ): Promise<Json> => {
    const config = {
      "@context": options.proofContext ?? body["@context"],
      type: "DataIntegrityProof",
      cryptosuite: "eddsa-jcs-2022",
      verificationMethod: keyId,
      proofPurpose: "assertionMethod",
      created: "2026-11-13T00:00:00Z",
      ...options.extra,
    };
    const digest = async (value: unknown) =>
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value))));
    const message = new Uint8Array([...(await digest(config)), ...(await digest(body))]);
    const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", ed.privateKey, message));
    const { "@context": context, ...rest } = config;
    const proof = { ...(options.omitContext === true ? {} : { "@context": context }), ...rest };
    return { ...body, proof: { ...proof, proofValue: `z${base58btc(signature)}` } };
  };
  return { actor, fedify, sign };
}

// JCS (RFC 8785) of JSON made of strings, arrays, objects, booleans and null: members sorted by their UTF-16 names.
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58btc(bytes: Uint8Array): string {
  let n = 0n;
  for (const byte of bytes) {
    n = n * 256n + BigInt(byte);
  }
  let out = "";
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) {
      break;
    }
    out = `1${out}`;
  }
  return out;
}
