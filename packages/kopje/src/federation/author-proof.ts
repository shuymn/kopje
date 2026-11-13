import { type DocumentLoader, preloadedContexts, verifyJsonLd, verifyObject } from "@fedify/fedify";
import { Delete } from "@fedify/vocab";

import { RefusedFetchError } from "./loader";
import { MASTODON_CONTEXT_TERMS } from "./mastodon-context";

// The author's own proof on a Delete (ID-1's exception, domain/inbox.ts relayedDelete, and the forward of an author's
// own Delete, recordForwards): a Linked Data Signature (RsaSignature2017, as Mastodon signs a status's or a stamp's
// Delete with always_sign) or an FEP-8b32 Object Integrity Proof, which Fedify verifies. A body is considered only in
// one of the closed forms below (PROFILES), taken from its sender's source: its @context deep-equal to the profile's
// (or, as Mastodon forwards it, activitystreams, security/v1 and an object of MASTODON_CONTEXT_TERMS alone), every URL
// in it preloaded, and every key at every level one the sender writes. In that form the body's JSON-LD meaning is its
// literal JSON, so what Fedify verifies is what Kopje reads: no inline term can nest, drop, alias or redefine a key
// (`@nest`, `null`, `proof`, `type`), and no context resolves differently between verification and parsing. Any other
// form, a relayed Delete from Misskey or from a Mastodon release with another context included, is answered as a proof
// that does not verify (docs/mastodon-deviations.md): relayed, 401 (inbound.ts relayed, proof-invalid); the author's
// own Delete applies as unproven and forwards nothing (inbound.ts proveDelete).
//   - The key must be one the actor's own document embeds: the verifiers load keys through a loader that serves only
//     that document (fetched and checked as any actor's, inbound.ts), so a key elsewhere, a did:key or a key of
//     another actor is never found. Fedify then requires the key's owner (or controller) to be the activity's actor.
//   - Contexts come from Fedify's preloaded set alone, for the verification and every parse: never fetched, never from
//     the request's loaders or their cache.
//   - The proven Delete has exactly the literal id, one actor (the author) and one object, the literal object's id.

type Json = Record<string, unknown>;

export type ProvenDelete = { id: string; actor: string; object: string };

const AS = "https://www.w3.org/ns/activitystreams";
const SECURITY = "https://w3id.org/security/v1";
const IDENTITY = "https://w3id.org/identity/v1";

type Profile = {
  // The proof: an RsaSignature2017 signature as Mastodon's LinkedDataSignature#sign! writes it, or as Fedify's
  // createSignature does (with its own @context, identity/v1), or FEP-8b32 proofs.
  form: "mastodon" | "fedify" | "proof";
  // The sender's @context, or "forwarded": as Mastodon compacts a body it forwards (isForwardedContext).
  context: readonly unknown[] | "forwarded";
  // The top-level keys the sender may write besides @context, id, type, actor, object and its proof.
  extra: readonly string[];
  // The object: an IRI string, or an embedded object with exactly these keys, its `type` this one, every value a string.
  object: "iri" | { type: string; keys: readonly string[] };
};

const TOMBSTONE = { type: "Tombstone", keys: ["id", "type", "atomUri"] } as const;
const QUOTE_AUTHORIZATION = {
  type: "QuoteAuthorization",
  keys: ["id", "type", "attributedTo", "interactingObject", "interactionTarget"],
} as const;

// The accepted forms, each its sender's @context verbatim and the keys its serializer writes.
export const PROFILES: Readonly<Record<string, Profile>> = {
  // Mastodon 4.5's status Delete: ActivityPub::DeleteSerializer (its TombstoneSerializer's context_extensions
  // :atom_uri, app/helpers/context_helper.rb atom_uri), signed by LinkedDataSignature#sign!, which appends security/v1.
  mastodonStatus: {
    form: "mastodon",
    context: [AS, { ostatus: "http://ostatus.org#", atomUri: "ostatus:atomUri" }, SECURITY],
    extra: ["to"],
    object: TOMBSTONE,
  },
  // Mastodon 4.5's stamp Delete: ActivityPub::DeleteQuoteAuthorizationSerializer, its object the
  // QuoteAuthorizationSerializer's (context_helper.rb quote_authorizations), signed as above (RevokeQuoteService).
  mastodonStamp: {
    form: "mastodon",
    context: [
      AS,
      {
        gts: "https://gotosocial.org/ns#",
        QuoteAuthorization: "https://w3id.org/fep/044f#QuoteAuthorization",
        interactingObject: { "@id": "gts:interactingObject", "@type": "@id" },
        interactionTarget: { "@id": "gts:interactionTarget", "@type": "@id" },
      },
      SECURITY,
    ],
    extra: ["to"],
    object: QUOTE_AUTHORIZATION,
  },
  // Kopje's status Delete (domain/activities.ts deleteSigning, SIGNED_DELETE_CONTEXT; federation/ld-sign.ts).
  kopjeStatus: {
    form: "fedify",
    context: [
      AS,
      { sensitive: "as:sensitive", Hashtag: "as:Hashtag", ostatus: "http://ostatus.org#", atomUri: "ostatus:atomUri" },
      SECURITY,
    ],
    extra: ["to"],
    object: TOMBSTONE,
  },
  // Kopje's stamp Delete (domain/activities.ts stampDeleteActivity; federation/ld-sign.ts).
  kopjeStamp: { form: "fedify", context: [AS, SECURITY], extra: ["to"], object: "iri" },
  // Each of the above with an LD signature, as a Mastodon (4.4 or 4.5) that holds a boost or quote of the status or a
  // quote with the stamp forwards it: ActivityPub::ProcessCollectionService replaces the body with its compaction
  // under full_context (JsonLdHelper#compact, the signature kept as received), patch_for_forwarding! puts back the
  // values compaction changed (Public, single-item arrays) but not the @context, and ActivityPub::Forwarder sends that
  // copy. The keys of these senders' bodies are all full_context terms, so only the @context changes.
  mastodonForwardedStatus: { form: "mastodon", context: "forwarded", extra: ["to"], object: TOMBSTONE },
  mastodonForwardedStamp: { form: "mastodon", context: "forwarded", extra: ["to"], object: QUOTE_AUTHORIZATION },
  kopjeForwardedStatus: { form: "fedify", context: "forwarded", extra: ["to"], object: TOMBSTONE },
  kopjeForwardedStamp: { form: "fedify", context: "forwarded", extra: ["to"], object: "iri" },
  // A Delete Fedify signs with an FEP-8b32 proof (signObject) under its default Delete context (@fedify/vocab 2.4.5
  // Delete#toJsonLd docContext), which copies that context into the proof.
  fedifyProof: {
    form: "proof",
    context: [
      IDENTITY,
      AS,
      "https://w3id.org/security/data-integrity/v1",
      "https://gotosocial.org/ns",
      {
        toot: "http://joinmastodon.org/ns#",
        misskey: "https://misskey-hub.net/ns#",
        fedibird: "http://fedibird.com/ns#",
        sensitive: "as:sensitive",
        votersCount: { "@id": "toot:votersCount", "@type": "http://www.w3.org/2001/XMLSchema#nonNegativeInteger" },
        Emoji: "toot:Emoji",
        Hashtag: "as:Hashtag",
        ChatMessage: "http://litepub.social/ns#ChatMessage",
        quote: { "@id": "https://w3id.org/fep/044f#quote", "@type": "@id" },
        quoteUrl: "as:quoteUrl",
        _misskey_quote: "misskey:_misskey_quote",
        quoteUri: "fedibird:quoteUri",
        QuoteAuthorization: "https://w3id.org/fep/044f#QuoteAuthorization",
        QuoteRequest: "https://w3id.org/fep/044f#QuoteRequest",
        quoteAuthorization: { "@id": "https://w3id.org/fep/044f#quoteAuthorization", "@type": "@id" },
      },
    ],
    extra: ["to", "cc"],
    object: "iri",
  },
};

const SIGNATURE_KEYS = ["type", "creator", "created", "signatureValue"];
const PROOF_KEYS = ["type", "cryptosuite", "verificationMethod", "proofPurpose", "proofValue", "created"];

function isJson(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// JSON equality, member order aside.
function deepEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isJson(a) && isJson(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return a === b;
}

// Whether `value` has every key of `required`, and no key outside `required` and `optional`.
function hasKeys(value: Json, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return (
    required.every((k) => Object.hasOwn(value, k)) && keys.every((k) => required.includes(k) || optional.includes(k))
  );
}

function isAddress(value: unknown): boolean {
  return typeof value === "string" || (Array.isArray(value) && value.every((v) => typeof v === "string"));
}

function everyString(value: Json): boolean {
  return Object.values(value).every((v) => typeof v === "string");
}

// The @context of a body Mastodon forwards: activitystreams, security/v1 and one object, each of whose terms is one
// MASTODON_CONTEXT_TERMS lists, with a definition a release gave it.
function isForwardedContext(context: unknown): boolean {
  return (
    Array.isArray(context) &&
    context.length === 3 &&
    context[0] === AS &&
    context[1] === SECURITY &&
    isJson(context[2]) &&
    Object.entries(context[2]).every(
      ([term, definition]) =>
        Object.hasOwn(MASTODON_CONTEXT_TERMS, term) &&
        MASTODON_CONTEXT_TERMS[term]!.some((allowed) => deepEqual(allowed, definition)),
    )
  );
}

// The profile `json` is in exactly, and its literal object id; null when it is in none.
function profileOf(json: Json): { profile: Profile; object: string } | null {
  for (const profile of Object.values(PROFILES)) {
    const context = json["@context"];
    if (profile.context === "forwarded" ? !isForwardedContext(context) : !deepEqual(context, profile.context)) {
      continue;
    }
    const base = ["@context", "id", "type", "actor", "object", profile.form === "proof" ? "proof" : "signature"];
    if (
      !hasKeys(json, base, profile.extra) ||
      json.type !== "Delete" ||
      typeof json.id !== "string" ||
      typeof json.actor !== "string" ||
      !profile.extra.every((k) => json[k] === undefined || isAddress(json[k]))
    ) {
      continue;
    }
    const object = objectId(json.object, profile.object);
    if (object === null || !(profile.form === "proof" ? isProof(json) : isSignature(json.signature, profile.form))) {
      continue;
    }
    return { profile, object };
  }
  return null;
}

function objectId(value: unknown, form: Profile["object"]): string | null {
  if (form === "iri") {
    return typeof value === "string" ? value : null;
  }
  return isJson(value) && hasKeys(value, form.keys) && everyString(value) && value.type === form.type
    ? (value.id as string)
    : null;
}

// Fedify's createSignature names identity/v1 as the signature's own @context (@fedify/fedify 2.4.5 ld-*.mjs); Mastodon
// writes none.
function isSignature(value: unknown, form: "mastodon" | "fedify"): boolean {
  if (!isJson(value)) {
    return false;
  }
  const required = form === "fedify" ? [...SIGNATURE_KEYS, "@context"] : SIGNATURE_KEYS;
  return (
    hasKeys(value, required) &&
    everyString(value) &&
    value.type === "RsaSignature2017" &&
    (form === "mastodon" || value["@context"] === IDENTITY)
  );
}

// One proof (alone, or alone in an array, as Fedify's signObject writes one), a DataIntegrityProof (eddsa-jcs-2022)
// whose own @context, when it has one, is the body's. A second proof is refused, whatever it is: no sender of a profile
// writes one, so how Fedify judges several (2.4.5 refuses the body when any of them fails) is not relied on.
function isProof(json: Json): boolean {
  const proofs = Array.isArray(json.proof) ? json.proof : [json.proof];
  return (
    proofs.length === 1 &&
    proofs.every((proof) => {
      if (!isJson(proof) || !hasKeys(proof, PROOF_KEYS, ["@context"])) {
        return false;
      }
      const { "@context": context, ...rest } = proof;
      return (
        everyString(rest) &&
        rest.type === "DataIntegrityProof" &&
        rest.cryptosuite === "eddsa-jcs-2022" &&
        (context === undefined || deepEqual(context, json["@context"]))
      );
    })
  );
}

// Fedify's preloaded contexts, and nothing else: no fetch, no shared cache.
const preloaded: DocumentLoader = (url) => {
  const document = preloadedContexts[url];
  return document === undefined
    ? Promise.reject(new RefusedFetchError(new URL(url), "Not a preloaded JSON-LD context"))
    : Promise.resolve({ document, documentUrl: url, contextUrl: null });
};

function withoutFragment(url: string): string {
  const hash = url.indexOf("#");
  return hash === -1 ? url : url.slice(0, hash);
}

// The key ids a body in a profile names (its signature's creator, every proof's verificationMethod): strings there.
function keyIdsOf(json: Json): string[] {
  if (isJson(json.signature)) {
    return [json.signature.creator as string];
  }
  return (Array.isArray(json.proof) ? json.proof : [json.proof]).map(
    (proof) => (proof as Json).verificationMethod as string,
  );
}

// Whether the body carries an author proof at all (an LD signature or an FEP-8b32 proof), valid or not.
export function hasAuthorProof(json: Json): boolean {
  return (json.signature !== undefined && json.signature !== null) || (json.proof !== undefined && json.proof !== null);
}

// Whether `json` is, in one of the PROFILES, a Delete of exactly `expected` proven by a key the actor's document
// embeds.
export async function verifyAuthorProof(json: Json, expected: ProvenDelete, actorDocument: unknown): Promise<boolean> {
  const matched = profileOf(json);
  if (
    matched === null ||
    json.id !== expected.id ||
    json.actor !== expected.actor ||
    matched.object !== expected.object ||
    !keyIdsOf(json).every((id) => withoutFragment(id) === expected.actor)
  ) {
    return false;
  }
  const documentLoader: DocumentLoader = (url) =>
    withoutFragment(url) === expected.actor
      ? Promise.resolve({ document: actorDocument, documentUrl: expected.actor, contextUrl: null })
      : Promise.reject(new RefusedFetchError(new URL(url), "Not the actor document"));
  const options = { documentLoader, contextLoader: preloaded };
  try {
    let proven: unknown;
    if (matched.profile.form !== "proof") {
      proven = (await verifyJsonLd(json, options)) ? await Delete.fromJsonLd(json, options) : null;
    } else {
      proven = await verifyObject(Delete, json, options);
    }
    return (
      proven instanceof Delete &&
      proven.id?.href === expected.id &&
      proven.actorIds.length === 1 &&
      proven.actorIds[0]?.href === expected.actor &&
      proven.objectIds.length === 1 &&
      proven.objectIds[0]?.href === expected.object
    );
  } catch {
    return false;
  }
}
