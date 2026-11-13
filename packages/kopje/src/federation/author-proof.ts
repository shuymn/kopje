import { type DocumentLoader, verifyJsonLd, verifyObject } from "@fedify/fedify";
import { Delete, Object as ApObject } from "@fedify/vocab";
import jsonld from "@fedify/vocab-runtime/jsonld";

import { isTransientLoadError, loadFailureOf, RefusedFetchError } from "./loader";

// The author's own proof on an activity another server relayed (ID-1's exception, domain/inbox.ts relayedDelete):
// a Linked Data Signature (RsaSignature2017, as Mastodon signs a status's or a stamp's Delete with always_sign) or an
// FEP-8b32 Object Integrity Proof. Fedify verifies both; Kopje only chooses the key and reads what was proven:
//   - The key must be one the actor's own document embeds: the verifiers load keys through a loader that serves only
//     that document (fetched and checked as any actor's, inbound.ts), so a key elsewhere, a did:key or a key of
//     another actor is never found. Fedify then requires the key's owner (or controller) to be the activity's actor.
//   - What was proven is read only from the document the verifier hashed (signedDocument), never from the body as
//     received: a context entry the signature does not cover (a `@nest`ed `signature`, a term redefined after the
//     proof's context) can make the body read differently from the signed graph. That document's expanded node must
//     be typed as:Delete and nothing else (Delete.fromJsonLd accepts a node of no type, and Fedify's decoder picks
//     Delete from several), with exactly the id, actor and object Kopje read. Fedify's LD verification refuses @graph,
//     @included and @reverse, and their aliases, before and after compacting the document (the class of bypass
//     Mastodon fixed in 4.5.10, GHSA-53m7-2wrh-q839).

type Json = Record<string, unknown>;

export type ProvenDelete = { id: string; actor: string; object: string };

const AS_DELETE = "https://www.w3.org/ns/activitystreams#Delete";

function withoutFragment(url: string): string {
  const hash = url.indexOf("#");
  return hash === -1 ? url : url.slice(0, hash);
}

// Whether the body carries an author proof at all (an LD signature or an FEP-8b32 proof), valid or not.
export function hasAuthorProof(json: Json): boolean {
  return (json.signature !== undefined && json.signature !== null) || (json.proof !== undefined && json.proof !== null);
}

function proofsOf(json: Json): unknown[] {
  return Array.isArray(json.proof) ? json.proof : json.proof === undefined || json.proof === null ? [] : [json.proof];
}

// The ids of the keys a proof names: the LD signature's creator and every proof's verificationMethod.
function proofKeyIds(json: Json): unknown[] {
  const signature = json.signature as Json | null | undefined;
  return [
    ...(signature === undefined || signature === null ? [] : [signature.creator]),
    ...proofsOf(json).map((proof) =>
      typeof proof === "object" && proof !== null ? (proof as Json).verificationMethod : null,
    ),
  ];
}

// The document a form's verifier hashes, or null when Kopje cannot tell it from the body:
//   - signature: the body without `signature` (@fedify/fedify ld-*.mjs: compactJsonLd detaches it before compacting,
//     detachSignature, and verifySignature hashes the compacted document without it; compaction keeps the graph).
//   - proof: the body without `proof`, its @context replaced by the proof's (proof-*.mjs createProofMessageDigests,
//     which also accepts the same message with its public audience and attachments normalized, a change of neither
//     type, id, actor nor object; createProofConfiguration takes the proof's @context, else the body's). Kopje
//     requires every proof's @context, when it has one, to be the body's, so the body read is the one hashed.
function signedDocument(json: Json, form: "signature" | "proof"): Json | null {
  if (form === "signature") {
    const { signature: _signature, ...document } = json;
    return document;
  }
  const context = JSON.stringify(json["@context"] ?? null);
  const sameContext = proofsOf(json).every(
    (proof) =>
      typeof proof === "object" &&
      proof !== null &&
      (!("@context" in proof) || JSON.stringify((proof as Json)["@context"]) === context),
  );
  if (!sameContext) {
    return null;
  }
  const { proof: _proof, ...document } = json;
  return document;
}

// Whether `document`, the one a verifier hashed, is a Delete of exactly `expected`: its single expanded node typed
// as:Delete alone, and Fedify's reading of the same document naming the same id, one actor and one object.
async function provesDelete(document: Json, expected: ProvenDelete, contextLoader: DocumentLoader): Promise<boolean> {
  const expanded = (await jsonld.expand(document, { documentLoader: contextLoader })) as Json[];
  const types = expanded.length === 1 ? expanded[0]!["@type"] : undefined;
  if (!Array.isArray(types) || types.length !== 1 || types[0] !== AS_DELETE) {
    return false;
  }
  const proven = await Delete.fromJsonLd(document, { contextLoader, documentLoader: contextLoader });
  return (
    proven.id?.href === expected.id &&
    proven.actorIds.length === 1 &&
    proven.actorIds[0]?.href === expected.actor &&
    proven.objectIds.length === 1 &&
    proven.objectIds[0]?.href === expected.object
  );
}

// true: proven by a key the actor's document embeds, and the proof covers exactly `expected`; false: no such proof;
// 'transient': a JSON-LD context could not be loaded in a way that may pass.
export async function verifyAuthorProof(
  json: Json,
  expected: ProvenDelete,
  actorDocument: unknown,
  contextLoader: DocumentLoader,
): Promise<boolean | "transient"> {
  const keyIds = proofKeyIds(json);
  if (keyIds.length === 0 || !keyIds.every((id) => typeof id === "string" && withoutFragment(id) === expected.actor)) {
    return false;
  }
  const documentLoader: DocumentLoader = (url) =>
    withoutFragment(url) === expected.actor
      ? Promise.resolve({ document: actorDocument, documentUrl: expected.actor, contextUrl: null })
      : Promise.reject(new RefusedFetchError(new URL(url), "Not the actor document"));
  const options = { documentLoader, contextLoader };
  const verifiers = {
    proof: async () => (await verifyObject(ApObject, json, options)) !== null,
    signature: () => verifyJsonLd(json, options),
  };
  // Each form on its own: a malformed proof does not hide a valid signature.
  let transient = false;
  for (const form of ["proof", "signature"] as const) {
    if (json[form] === undefined || json[form] === null) {
      continue;
    }
    const document = signedDocument(json, form);
    try {
      if (document !== null && (await verifiers[form]()) && (await provesDelete(document, expected, contextLoader))) {
        return true;
      }
    } catch (error) {
      const failure = loadFailureOf(error);
      transient ||= failure !== undefined && isTransientLoadError(failure);
    }
  }
  return transient ? "transient" : false;
}
