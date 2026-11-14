import { importMultibaseKey, importPem, preloadedContexts } from "@fedify/fedify";

import { withinJsonBounds } from "../platform/json-bounds";

// The key entries of a fetched document as Mastodon 4.7 reads them (ID-1, RES-6): of `publicKey` (legacy keys) and of
// `assertionMethod` (FEP-521a Multikeys), the first MAX_PUBLIC_KEYS entries each, an entry whose key cannot be imported
// left out. Applied by the safe loader to every document it reads (loader.ts readDocument), so that every reader of an
// actor (Kopje's fetchActor, Fedify's key fetch, the author proof's verifier on the stored document, the rollback
// drain, search, collections) sees the same entries: Fedify 2.4.5 cannot parse a document that embeds a key it cannot
// import (an ML-DSA-44 Multikey, an EC key, an unknown multicodec), and would make the whole actor unusable, where
// Mastodon 4.7 skips the key (ProcessAccountService#public_keys). Removing an entry never grants a key: ID-1 only
// needs a key to be present.
//
// Fedify reads both properties by their JSON-LD meaning, not their spelling, so an entry is changed only where the
// root's @context alone establishes that meaning (keyTermsOf): every string member one of Fedify's preloaded contexts,
// one of which defines the term (KEY_TERM_CONTEXTS), no null anywhere (it resets every definition before it), and no
// inline object, at any depth, that names the term or holds @context (a scoped context) or @import. Mastodon's and
// Fedify's actor contexts are of that form. Any other document (a context served by its own instance, as Pleroma's
// litepub-0.1.jsonld, an inline redefinition, a Link-header context) is left as fetched, and its keys are bounded
// where they are stored (remote-actor.ts ownKeys, inbound.ts withVerifiedReference).

// Mastodon's ProcessAccountService::MAX_PUBLIC_KEYS (v4.6, v4.7): it takes that many entries of each form, references
// and nulls counted, before it reads any.
export const MAX_PUBLIC_KEYS = 10;

export type KeyTerm = "publicKey" | "assertionMethod";

// The preloaded contexts (Fedify 2.4.5 preloadedContexts) that define each term, as the security vocabulary's
// property; test/key-entries.test.ts walks every preloaded context to hold this list to them.
export const KEY_TERM_CONTEXTS: Readonly<Record<KeyTerm, readonly string[]>> = {
  publicKey: ["https://w3id.org/security/v1", "https://w3id.org/identity/v1"],
  assertionMethod: ["https://www.w3.org/ns/did/v1", "https://www.w3.org/ns/cid/v1"],
};

const TERMS = Object.keys(KEY_TERM_CONTEXTS) as KeyTerm[];

// The member of an embedded entry that holds its key material, read by Fedify's parser with the importer of the same
// name (CryptographicKey#publicKeyPem, Multikey#publicKeyMultibase).
const MATERIAL: Readonly<Record<KeyTerm, "publicKeyPem" | "publicKeyMultibase">> = {
  publicKey: "publicKeyPem",
  assertionMethod: "publicKeyMultibase",
};

export type KeyImporters = Record<KeyTerm, (material: string) => Promise<unknown>>;

const FEDIFY_IMPORTERS: KeyImporters = { publicKey: importPem, assertionMethod: importMultibaseKey };

type Json = Record<string, unknown>;

function isJson(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The terms a root @context establishes as the security key properties (see the header). A context past the JSON
// bounds (RES-2) establishes nothing, which also bounds this walk.
export function keyTermsOf(context: unknown): KeyTerm[] {
  if (context === undefined || !withinJsonBounds(context)) {
    return [];
  }
  const members = Array.isArray(context) ? context : [context];
  const named = new Set<string>();
  const defined = new Set<KeyTerm>();
  for (const member of members) {
    if (typeof member === "string") {
      if (!Object.hasOwn(preloadedContexts, member)) {
        return [];
      }
      for (const term of TERMS) {
        if (KEY_TERM_CONTEXTS[term].includes(member)) {
          defined.add(term);
        }
      }
    } else if (!isJson(member) || !inlineNames(member, named)) {
      return [];
    }
  }
  return TERMS.filter((term) => defined.has(term) && !named.has(term));
}

// Adds every key an inline context object names, at any depth, to `named`; false if it holds a null, an @context or
// an @import anywhere.
function inlineNames(object: Json, named: Set<string>): boolean {
  const stack: unknown[] = [object];
  while (stack.length > 0) {
    const value = stack.pop();
    if (value === null) {
      return false;
    }
    if (Array.isArray(value)) {
      stack.push(...(value as unknown[]));
    } else if (isJson(value)) {
      for (const [key, inner] of Object.entries(value)) {
        if (key === "@context" || key === "@import") {
          return false;
        }
        named.add(key);
        stack.push(inner);
      }
    }
  }
  return true;
}

// `document` with, for each term its context establishes, the first MAX_PUBLIC_KEYS entries of that property (a single
// value is one entry; an array's members are its entries, as Mastodon's as_array), less each embedded entry whose key
// material is present and is not a string the importer imports; the property is removed if its only entry is. The
// same object when nothing changes. At most MAX_PUBLIC_KEYS imports per term.
export async function readableKeys(document: unknown, importers: KeyImporters = FEDIFY_IMPORTERS): Promise<unknown> {
  if (!isJson(document)) {
    return document;
  }
  let result: Json | null = null;
  for (const term of keyTermsOf(document["@context"])) {
    const value = document[term];
    if (value === undefined) {
      continue;
    }
    const entries = Array.isArray(value) ? (value as unknown[]) : [value];
    const kept: unknown[] = [];
    for (const entry of entries.slice(0, MAX_PUBLIC_KEYS)) {
      if (await readable(entry, MATERIAL[term], importers[term])) {
        kept.push(entry);
      }
    }
    if (kept.length === entries.length) {
      continue;
    }
    const base: Json = result ?? document;
    result = Array.isArray(value)
      ? { ...base, [term]: kept }
      : Object.fromEntries(Object.entries(base).filter(([key]) => key !== term));
  }
  return result ?? document;
}

async function readable(entry: unknown, member: string, importer: (material: string) => Promise<unknown>) {
  if (!isJson(entry) || !Object.hasOwn(entry, member)) {
    return true;
  }
  const material = entry[member];
  if (typeof material !== "string") {
    return false;
  }
  try {
    await importer(material);
    return true;
  } catch {
    return false;
  }
}
