import { preloadedContexts } from "@fedify/fedify";

import { isObject } from "./json-shapes";
import { MASTODON_CONTEXT_TERMS } from "./mastodon-context";

// ID-1, VIS-1: an activity that carries a Linked Data signature is read as received, as every activity is, where
// Mastodon 4.7 reads it as its compaction under full_context (process_activity_service.rb:23-38;
// docs/mastodon-deviations.md, "Reading inbound activities"). The two readings agree only where the body's literal JSON
// is what that compaction reads, so such a body is read only when (ldSignedBodyReadable):
//
//   1. its @context is the ActivityStreams URL, or an array of it, of URLs of SIGNED_CONTEXT_URLS in their positions,
//      and of objects of plain definitions (2);
//   2. each inline definition names a plain name (no keyword, no ':'). An ActivityStreams term has the definition
//      ActivityStreams gives it; any other name a string IRI, or an object of @id (required), @type (@id or an IRI)
//      and @container (@set or @list) only, each IRI absolute or compact over a namespace prefix of the active context
//      written as an absolute IRI: a name of ACTIVITY_VOCABULARY its IRI there, any other name an IRI outside it;
//   3. every key of the body but the top-level @context, signature and proof is a plain name.
//
// Then every name of the vocabulary means what full_context makes it, no other name or keyword alias reaches one of its
// IRIs, no base or vocabulary is set, so the compaction renames no key and merges none, and every string Kopje reads
// keeps its value. What still differs is listed by form in the deviations page. The tables are built once from the
// preloaded contexts and MASTODON_CONTEXT_TERMS, with no JSON-LD processing; test/ld-signed-vocabulary.test.ts
// holds them to jsonld.js's processing of Mastodon's full_context and of each preloaded context. Kopje reads, from an
// activity, no name outside the vocabulary that Mastodon also reads (EmojiReact and EmojiReaction, which Kopje reads
// as a favourite, Mastodon reads in no form; test/inbox-signed-forms.test.ts).

type Json = Record<string, unknown>;

const AS = "https://www.w3.org/ns/activitystreams";

// A preloaded context's definitions (each preloaded document is { "@context": object }).
function definitionsOf(url: string): Json {
  const document = preloadedContexts[url] as { "@context"?: unknown } | undefined;
  const context = document?.["@context"];
  if (!isObject(context)) {
    throw new Error(`no preloaded context object: ${url}`);
  }
  return context;
}

// A term, not a keyword or a compact or absolute IRI.
function isName(key: string): boolean {
  return key !== "" && !key.startsWith("@") && !key.includes(":");
}

const ABSOLUTE_IRI = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
// JSON-LD 1.1 uses a term as a prefix only when its definition is a string IRI ending with one of these.
const GEN_DELIM = /[:/?#[\]@]$/;

type Prefixes = ReadonlyMap<string, string>;

// The IRI of `value` in a definition: an absolute IRI as it is, a compact one over a namespace `prefix` resolves;
// null for anything else (a keyword, a blank node, a bare name, an unknown prefix).
function expand(value: string, prefix: (name: string) => string | undefined): string | null {
  if (ABSOLUTE_IRI.test(value)) {
    return value;
  }
  const colon = value.indexOf(":");
  // "_:" names a blank node whatever the context defines.
  if (colon <= 0 || value.startsWith("_:")) {
    return null;
  }
  const namespace = prefix(value.slice(0, colon));
  return namespace === undefined ? null : namespace + value.slice(colon + 1);
}

// The namespace prefixes a context object defines, and the names it defines otherwise (which shadow a prefix).
function applyPrefixes(definitions: Json, active: Map<string, string>): void {
  for (const [name, value] of Object.entries(definitions)) {
    if (typeof value === "string" && ABSOLUTE_IRI.test(value) && GEN_DELIM.test(value)) {
      active.set(name, value);
    } else {
      active.delete(name);
    }
  }
}

const AS_DEFINITIONS = definitionsOf(AS);
const AS_PREFIXES = new Map<string, string>();
applyPrefixes(AS_DEFINITIONS, AS_PREFIXES);

function iriOf(definition: unknown, prefixes: Prefixes): string {
  const value = typeof definition === "string" ? definition : isObject(definition) ? definition["@id"] : undefined;
  const iri =
    typeof value === "string" ? (value.startsWith("@") ? value : expand(value, (p) => prefixes.get(p))) : null;
  if (iri === null) {
    throw new Error(`no IRI for ${JSON.stringify(definition)}`);
  }
  return iri;
}

// The activity vocabulary: each ActivityStreams term (its prefixes and its aliases of @id and @type included) and each
// name of Mastodon's extension object but its namespace prefixes, with the IRI full_context gives it.
const MASTODON_PREFIXES = new Set(["toot", "schema", "ostatus", "gts"]);

function vocabulary(): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const [name, definition] of Object.entries(AS_DEFINITIONS)) {
    if (isName(name)) {
      names.set(name, iriOf(definition, AS_PREFIXES));
    }
  }
  const prefixes = new Map(AS_PREFIXES);
  for (const name of MASTODON_PREFIXES) {
    prefixes.set(name, MASTODON_CONTEXT_TERMS[name]![0] as string);
  }
  for (const [name, definitions] of Object.entries(MASTODON_CONTEXT_TERMS)) {
    if (!MASTODON_PREFIXES.has(name)) {
      const iri = iriOf(definitions[0], prefixes);
      if (names.has(name) && names.get(name) !== iri) {
        throw new Error(`${name} has two IRIs`);
      }
      names.set(name, iri);
    }
  }
  return names;
}

export const ACTIVITY_VOCABULARY = vocabulary();
const VOCABULARY_IRIS: ReadonlySet<string> = new Set(ACTIVITY_VOCABULARY.values());

// The preloaded contexts an LD-signed body may name, and where: anywhere, or only before the last ActivityStreams URL
// (identity/v1 gives five ActivityStreams terms other IRIs, which ActivityStreams then gives back). Each, processed
// after ActivityStreams (or before it), gives every name it defines, its scoped contexts included, a meaning (2)
// accepts, and sets no keyword but @version and @protected. Not schema.org (it sets @vocab, and before ActivityStreams
// still gives PropertyValue and value other IRIs than Mastodon's) nor join-lemmy.org (its expires aliases as:endTime).
export const SIGNED_CONTEXT_URLS: ReadonlyMap<string, "anywhere" | "before-activitystreams"> = new Map([
  ["https://w3id.org/security/v1", "anywhere"],
  ["https://w3id.org/security/data-integrity/v1", "anywhere"],
  ["https://w3id.org/security/data-integrity/v2", "anywhere"],
  ["https://www.w3.org/ns/did/v1", "anywhere"],
  ["https://w3id.org/security/multikey/v1", "anywhere"],
  ["https://www.w3.org/ns/cid/v1", "anywhere"],
  ["https://purl.archive.org/socialweb/webfinger", "anywhere"],
  ["https://gotosocial.org/ns", "anywhere"],
  ["https://w3id.org/fep/22cd", "anywhere"],
  ["https://w3id.org/fep/5711", "anywhere"],
  ["https://w3id.org/fep/ef61", "anywhere"],
  ["https://w3id.org/fep/7aa9", "anywhere"],
  ["https://w3id.org/fep/6757", "anywhere"],
  ["http://joinmastodon.org/ns", "anywhere"],
  ["https://purl.archive.org/miscellany", "anywhere"],
  ["https://w3id.org/identity/v1", "before-activitystreams"],
]);

const URL_DEFINITIONS = new Map([...SIGNED_CONTEXT_URLS.keys(), AS].map((url) => [url, definitionsOf(url)]));

// An inline definition's members (2), each compared with ActivityStreams' own by value.
const DEFINITION_KEYS = new Set(["@id", "@type", "@container"]);
const CONTAINERS = new Set(["@set", "@list"]);

function sameDefinition(a: unknown, b: unknown): boolean {
  if (typeof a === "string" || typeof b === "string") {
    return a === b;
  }
  if (!isObject(a) || !isObject(b)) {
    return false;
  }
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key]);
}

// The IRI rule (2) gives an inline definition, or null if it refuses it.
function definitionIri(definition: unknown, prefix: (name: string) => string | undefined): string | null {
  if (typeof definition === "string") {
    return expand(definition, prefix);
  }
  if (!isObject(definition) || !Object.keys(definition).every((key) => DEFINITION_KEYS.has(key))) {
    return null;
  }
  const { "@id": id, "@type": type, "@container": container } = definition;
  if (type !== undefined && type !== "@id" && (typeof type !== "string" || expand(type, prefix) === null)) {
    return null;
  }
  if (container !== undefined && (typeof container !== "string" || !CONTAINERS.has(container))) {
    return null;
  }
  return typeof id === "string" ? expand(id, prefix) : null;
}

// Rules (1) and (2) over a body's @context: the IRI of each name its inline objects define, in order (a later
// definition of a name replaces an earlier one), or null when the context is not one the body is read under.
export function inlineDefinitionIris(context: unknown): Map<string, string> | null {
  const entries = Array.isArray(context) ? context : [context];
  const lastActivityStreams = entries.lastIndexOf(AS);
  if (lastActivityStreams < 0) {
    return null;
  }
  const active = new Map<string, string>();
  const iris = new Map<string, string>();
  for (const [index, entry] of entries.entries()) {
    if (typeof entry === "string") {
      const position = entry === AS ? "anywhere" : SIGNED_CONTEXT_URLS.get(entry);
      if (position === undefined || (position === "before-activitystreams" && index > lastActivityStreams)) {
        return null;
      }
      applyPrefixes(URL_DEFINITIONS.get(entry)!, active);
      continue;
    }
    if (!isObject(entry)) {
      return null;
    }
    // A compact IRI in this object resolves over the object's own definition of its prefix, or else the active one.
    const own = new Map<string, string>();
    applyPrefixes(entry, own);
    const prefix = (name: string) => (Object.hasOwn(entry, name) ? own.get(name) : active.get(name));
    for (const [name, definition] of Object.entries(entry)) {
      if (!isName(name)) {
        return null;
      }
      // An ActivityStreams term (its aliases of @id and @type included) only as ActivityStreams defines it.
      if (Object.hasOwn(AS_DEFINITIONS, name)) {
        if (!sameDefinition(definition, AS_DEFINITIONS[name])) {
          return null;
        }
        iris.set(name, ACTIVITY_VOCABULARY.get(name)!);
        continue;
      }
      const iri = definitionIri(definition, prefix);
      const term = ACTIVITY_VOCABULARY.get(name);
      if (iri === null || (term === undefined ? VOCABULARY_IRIS.has(iri) : iri !== term)) {
        return null;
      }
      iris.set(name, iri);
    }
    applyPrefixes(entry, active);
  }
  return iris;
}

// Rule (3): every key of every object in the body is a plain name, but the top-level @context, signature and proof
// (whose contents Mastodon's reading leaves out or does not compact). Each value is visited once.
function bodyKeysReadable(json: Json): boolean {
  const pending: unknown[] = [];
  for (const [key, value] of Object.entries(json)) {
    if (key === "@context" || key === "signature" || key === "proof") {
      continue;
    }
    if (!isName(key)) {
      return false;
    }
    pending.push(value);
  }
  while (pending.length > 0) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      pending.push(...(value as unknown[]));
    } else if (isObject(value)) {
      for (const [key, member] of Object.entries(value)) {
        if (!isName(key)) {
          return false;
        }
        pending.push(member);
      }
    }
  }
  return true;
}

// Whether an LD-signed activity is read (its signature an object): only where its literal JSON is what Mastodon's
// compaction reads. Run after withinJsonBounds, so the work is bounded by its values.
export function ldSignedBodyReadable(json: Json): boolean {
  return inlineDefinitionIris(json["@context"]) !== null && bodyKeysReadable(json);
}
