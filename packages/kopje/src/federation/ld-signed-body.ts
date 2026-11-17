import { preloadedContexts } from "@fedify/fedify";
import jsonld from "jsonld/dist/jsonld.esm.js";

import { railsBoolean } from "../platform/rails-boolean";
import { FEDIFY_CONTEXT_TERMS } from "./fedify-context";
import { isObject } from "./json-shapes";
import { MASTODON_CONTEXT_TERMS, MASTODON_NAMED_CONTEXTS, MASTODON_OLM_TERMS } from "./mastodon-context";

// ID-1, VIS-1: an activity that carries a Linked Data signature is read as received, as every activity is, where
// Mastodon 4.7 reads it as its compaction under full_context, patched toward the body as received
// (process_activity_service.rb:23-38 and 66-72, JsonLdHelper#patch_for_forwarding!; docs/mastodon-deviations.md,
// "Reading inbound activities"). Under each key the body and its compaction share, the patch makes a one-element array
// the compaction made a single value an array again and as:Public the public collection's IRI again; a key the
// compaction renamed, a value it expanded or typed, and members it merged or dropped stay as it left them. So that
// nothing Kopje reads takes another meaning there, such a body is read only when (ldSignedReading,
// ldSignedBodyReadable):
//
//   1. its @context is the ActivityStreams URL, or an array of it, of URLs of SIGNED_CONTEXT_URLS in their positions,
//      and of objects of plain definitions (2);
//   2. each inline definition names a plain name (no keyword, no ':'). An ActivityStreams term has the definition
//      ActivityStreams gives it; any other name a string IRI, or an object of @id (required), @type (@id or an IRI)
//      and @container (@set or @list) only, each IRI absolute or compact over a namespace prefix of the active context
//      written as an absolute IRI: a name of ACTIVITY_VOCABULARY its IRI there, any other name an IRI outside it;
//   3. every key of the body but the top-level @context, signature and proof is a plain name (a retraction's, once its
//      node references are read as IRIs where Kopje shows the compaction writes them so, referencesAsIris);
//   4. no node in it, outside the signature (which the compaction leaves out) and a @context, gives Ruby's json-ld
//      types it cannot sort or a @set it cannot read (typesSortable), which raise an error Mastodon does not rescue, so
//      that its job applies nothing;
//   5. it holds only what real senders write (senderShaped): no key with a control character or a line break, no key
//      that starts with @ but a keyword of JSON-LD 1.1, no context URL twice in one @context, no inline definition but
//      one Mastodon or Fedify writes, exactly (MASTODON_CONTEXT_TERMS, MASTODON_OLM_TERMS, FEDIFY_CONTEXT_TERMS), no
//      type but a plain term or an absolute IRI, and a proof only as Fedify writes one: an object, or an array of at
//      most MAX_PROOFS, of a @context and of plain names given strings. It is checked before the others.
//
// Rule (5) is the primary guard against a form neither reader expects, where Ruby's json-ld and jsonld.js part or a
// proof's expansion grows: rule (4) and the proof's comparison (comparableProof) are a second layer under it, refusing
// or reading as named the forms it already refuses, and test/ld-signed-proof-shapes.test.ts holds that layer alone.
//
// Then every name of the vocabulary means what full_context makes it, no other name or keyword alias reaches one of its
// IRIs, and no base or vocabulary is set: no key Kopje reads is renamed, aliased or given another meaning by the
// compaction, and no member is merged into one. The rules do not make the readings equal. The compaction writes a type
// given as an IRI (as:Follow, or the absolute one) as the vocabulary's name for it, and Kopje reads the activity's type
// and its embedded object's so where it shows the compaction succeeds (mastodonCompacts); it writes a name, as a key or
// a type, only where the name means in the body's contexts what it means in full_context (one full_context defines that
// the body's contexts leave undefined it writes as a blank node's), and under it only the values its type takes, and
// Kopje reads the body so named (namedAsCompacted); it also drops nulls, flattens arrays, and drops or renames what the
// vocabulary does not define, and the readers on each side read some shapes differently. Those differences are listed
// by form in the deviations page. The tables are built once from the preloaded contexts and MASTODON_CONTEXT_TERMS,
// with no JSON-LD processing; test/ld-signed-vocabulary.test.ts holds them to jsonld.js's processing of Mastodon's
// full_context and of each preloaded context. Only a data-integrity proof is expanded, by jsonld.js, to tell whether
// Mastodon reads the body as received (proofExpandsToSomething). Kopje reads, from an activity, no name outside the
// vocabulary that Mastodon also reads (EmojiReact and EmojiReaction, which Kopje reads as a favourite, Mastodon reads
// in no form; test/inbox-signed-forms.test.ts).

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

// The name the compaction under full_context writes for a type whose IRI is one of the vocabulary's (IRI Compaction
// with no value, then Term Selection): a name with no container or a @set one, typed @id or untyped; a name with
// another container, another type or a language is never written. No two such names share an IRI (JSON-LD would rank
// them by container, type, length and order); test/ld-signed-vocabulary.test.ts holds every IRI to jsonld.js.
// Mastodon's extension object comes last in full_context, so its definition holds.
function typeNames(): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const [name, iri] of ACTIVITY_VOCABULARY) {
    const definition = MASTODON_CONTEXT_TERMS[name]?.at(-1) ?? AS_DEFINITIONS[name];
    const { "@container": container, "@type": type, "@language": language } = isObject(definition) ? definition : {};
    const written = type === undefined ? language === undefined : type === "@id";
    if (!iri.startsWith("@") && (container === undefined || container === "@set") && written) {
      names.set(iri, name);
    }
  }
  return names;
}

const TYPE_NAMES = typeNames();

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

// What a definition makes a name mean to a compaction (namedAsCompacted): its IRI, and how it coerces a value, its
// @type and its containers (but @set, which changes nothing a compaction writes) and any other member but @protected.
// Two definitions that mean the same have equal keys. A name with no container, typed @id or untyped and with no
// language or reverse property (a scoped context changes nothing a term is selected by) is one the compaction may write
// for its IRI as a type (FULL_TYPE_NAMES). `scoped` is what its own context makes each name it defines mean, inside a
// node of that type (the data-integrity contexts' DataIntegrityProof, the CID and Multikey contexts' Multikey).
// `contained`: it has a container, @set included, so that the compaction writes no value of it alone.
type Meaning = {
  iri: string | null;
  coercion: string | null;
  key: string;
  containers: readonly string[];
  contained: boolean;
  typeName: boolean;
  scoped: ReadonlyMap<string, Meaning>;
};

const SELECTION_NEUTRAL = new Set(["@context", "@prefix", "@nest"]);

function meaningOf(definition: unknown, prefix: (name: string) => string | undefined): Meaning {
  const resolve = (value: unknown) =>
    typeof value === "string" && !value.startsWith("@") ? expand(value, prefix) : (value ?? null);
  const object = typeof definition === "string" ? { "@id": definition } : isObject(definition) ? definition : {};
  const { "@id": id, "@type": type, "@container": container, "@protected": _, ...rest } = object;
  const containers = (Array.isArray(container) ? container : [container])
    .filter((c) => c !== undefined && c !== "@set")
    .map(String);
  const iri = resolve(id);
  const coercion = resolve(type);
  const context = rest["@context"];
  return {
    iri: typeof iri === "string" ? iri : null,
    coercion: typeof coercion === "string" ? coercion : null,
    key: JSON.stringify([iri, coercion, containers.toSorted((a, b) => a.localeCompare(b)), rest]),
    containers,
    contained: container !== undefined,
    typeName:
      containers.length === 0 &&
      (coercion === null || coercion === "@id") &&
      Object.keys(rest).every((key) => SELECTION_NEUTRAL.has(key)),
    scoped: isObject(context) ? meaningsOf(context, prefix) : new Map(),
  };
}

// What each name a context object defines means, its compact IRIs over its own prefixes or else `outer`'s.
function meaningsOf(definitions: Json, outer: (name: string) => string | undefined): Map<string, Meaning> {
  const own = new Map<string, string>();
  applyPrefixes(definitions, own);
  const prefix = (name: string) => (Object.hasOwn(definitions, name) ? own.get(name) : outer(name));
  const names = Object.entries(definitions).filter(([name]) => isName(name));
  return new Map(names.map(([name, definition]) => [name, meaningOf(definition, prefix)]));
}

// Each allowed context URL's meanings, its compact IRIs over its own prefixes or ActivityStreams'.
const URL_MEANINGS = new Map(
  [...URL_DEFINITIONS].map(([url, definitions]) => [url, meaningsOf(definitions, (name) => AS_PREFIXES.get(name))]),
);

// Rules (1) and (2) over a body's @context: the IRI of each name its inline objects define, in order (a later
// definition of a name replaces an earlier one), the namespace prefixes it leaves active, and what each name it
// defines means; null when the context is not one the body is read under.
function readContext(
  context: unknown,
): { iris: Map<string, string>; prefixes: Prefixes; meanings: ReadonlyMap<string, Meaning> } | null {
  const entries = Array.isArray(context) ? context : [context];
  const lastActivityStreams = entries.lastIndexOf(AS);
  if (lastActivityStreams < 0) {
    return null;
  }
  const active = new Map<string, string>();
  const iris = new Map<string, string>();
  const meanings = new Map<string, Meaning>();
  for (const [index, entry] of entries.entries()) {
    if (typeof entry === "string") {
      const position = entry === AS ? "anywhere" : SIGNED_CONTEXT_URLS.get(entry);
      if (position === undefined || (position === "before-activitystreams" && index > lastActivityStreams)) {
        return null;
      }
      applyPrefixes(URL_DEFINITIONS.get(entry)!, active);
      for (const [name, meaning] of URL_MEANINGS.get(entry)!) {
        meanings.set(name, meaning);
      }
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
      meanings.set(name, meaningOf(definition, prefix));
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
  return { iris, prefixes: active, meanings };
}

export function inlineDefinitionIris(context: unknown): Map<string, string> | null {
  return readContext(context)?.iris ?? null;
}

// Rule (3): every key of every object in the body is a plain name, but the top-level @context (rules 1 and 2),
// signature and proof. Mastodon leaves the signature out of the compaction; a proof it compacts as any other member,
// keywords included, so the rule does not hold a proof's keys and D5 renames no type in a body that has one but a
// retraction's whose proof holds plain names only (mastodonCompacts).
function bodyKeysReadable(json: Json): boolean {
  return namedThroughout([Object.fromEntries(Object.entries(json).filter(([key]) => !AS_RECEIVED.has(key)))]);
}

// Whether every key of every object in `values`, at any depth, is a plain name. Each value is visited once.
function namedThroughout(values: unknown[]): boolean {
  const pending = [...values];
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

// Mastodon reads an LD-signed body as received, without its signature, wherever it gives up the compaction
// (process_activity_service.rb:23-38): when JsonLdHelper#check_jsonld_limits! (json_ld_helper.rb:132-152) refuses the
// body before or after it (more than 1,000 values, or a @graph, @included or @reverse key), or when JSON::LD raises.
// Kopje runs no JSON-LD processing, so it renames a type only in a body of a closed shape whose compaction it can show
// succeeds, and reads every other body's types as given: a retraction Mastodon applies may then be missed, never one it
// does not apply be applied. Under the ActivityStreams context every name expands, by its terms or by its @vocab "_:",
// and `id` and `type` are the only keyword aliases it and security/v1 define; the rules (3) hold every key but the
// top-level @context, signature and proof to a plain name. The shape (mastodonCompacts):
//   - its @context is the ActivityStreams URL, alone or with security/v1's (both in full_context), and it has no proof
//     (JSON-LD expands a proof's members as any other's, keywords included; the signature is not compacted);
//   - as received it holds no key check_jsonld_limits! refuses and at most 1,000 values, whatever its @context holds;
//     and the compaction holds at most 1,000 too: full_context (90 values) for its @context, its signature once as
//     received, and at most three for each other value (a scalar may become a value object of value and type, or a
//     list);
//   - every `id`, and every value of a name either context types @id but a null or an object, is a string that is an
//     http(s) IRI as written or over a prefix of the body's context (an IRI with an authority, which the compaction
//     cannot confuse with a prefix of full_context); every `type` is such an IRI or a name other than `id` and `type`
//     (which expand to keywords), or an array of them;
//   - every value of a language map name is itself a map of language tags to strings or nulls (JSON-LD reads a
//     language map only from a map: each member of an array there is a value of the term, a node for an object);
//   - no array is directly in another.
// A member of an array is held to its key's rule, as JSON-LD expands it under the same term (its type coercion
// included); an object is a node under any other key.
// A retraction's body (RETRACTIONS) may hold more, each of a shape both Mastodon's compaction (test/fixtures/ld-signed/
// forms.json, "form 4") and jsonld.js's write without an error and alike (#1717):
//   - an inline context of definitions real senders write (SENDER_DEFINITIONS, rule 5), which JSON-LD processes as
//     Mastodon's own and Fedify's bodies are processed: each value of a name it types @id is held to the rule above
//     too, as the compaction writes it as an IRI (one over a prefix only full_context defines raises);
//   - an array directly in another, which JSON-LD's expansion flattens, but under a name either context gives a @list
//     container (a list of lists);
//   - a proof whose keys are plain names at any depth (rule 3 does not hold a proof's), which JSON-LD expands as any
//     other member (its nodes held to the rules above), and the compaction writes as given: the contexts the shape
//     takes leave `proof` undefined (the ActivityStreams and security contexts, and no sender's inline definition names
//     it), so that it is no data-integrity proof's @graph container (mastodonReadsAsReceived);
//   - a number or a boolean as a value of a name typed @id, which JSON-LD expands as a value (no IRI) and the
//     compaction writes under the name's IRI, but as an `object` or an `actor`, which a retraction's handlers read;
//   - an id or a value of a name typed @id of another shape than an http(s) IRI that the compaction writes as given
//     (writtenAsGiven);
//   - a type naming `id` or `type`, which JSON-LD expands to the keyword it aliases and the compaction writes as that
//     alias again, as given;
//   - under a language map name, a string or an array of strings, which JSON-LD reads as values of the name (a
//     language map only from a map) and the compaction writes under another (`content` for `contentMap`), and a map
//     whose tag, lower-case, holds an array of strings, which it expands to a value for each (jsonld.js lower-cases a
//     tag, which Ruby's json-ld keeps); not a number or a node there, nor an array in such an array;
//   - more values once compacted than three for each allows, within 1,000 as writtenValues counts them.
const JSONLD_BUDGET = 1_000;
const UNSUPPORTED_JSONLD_KEYWORDS = new Set(["@graph", "@included", "@reverse"]);
const SECURITY_V1 = "https://w3id.org/security/v1";
const LANGUAGE_TAG = /^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$/;
const HTTP_IRI = /^https?:\/\//;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*$/;

// Values as check_jsonld_limits! counts them (each object, array and scalar), or Infinity for a key it refuses.
function jsonLdValues(value: unknown): number {
  let count = 0;
  const pending = [value];
  while (pending.length > 0) {
    const next = pending.pop();
    count++;
    if (Array.isArray(next)) {
      pending.push(...(next as unknown[]));
    } else if (isObject(next)) {
      for (const [key, member] of Object.entries(next)) {
        if (UNSUPPORTED_JSONLD_KEYWORDS.has(key)) {
          return Infinity;
        }
        pending.push(member);
      }
    }
  }
  return count;
}

// Mastodon 4.7's full_context: its named contexts and its extension object, in order.
const FULL_CONTEXT = [
  ...MASTODON_NAMED_CONTEXTS.at(-1)!,
  Object.fromEntries(Object.entries(MASTODON_CONTEXT_TERMS).map(([name, definitions]) => [name, definitions.at(-1)])),
];

export const FULL_CONTEXT_VALUES = jsonLdValues(FULL_CONTEXT);

function namesOf(url: string, test: (definition: unknown) => boolean): Set<string> {
  return new Set(Object.entries(definitionsOf(url)).flatMap(([name, definition]) => (test(definition) ? [name] : [])));
}

const typedId = (definition: unknown) => isObject(definition) && definition["@type"] === "@id";
const IRI_VALUED = new Set([...namesOf(AS, typedId), ...namesOf(SECURITY_V1, typedId)]);
const LANGUAGE_MAPS = namesOf(AS, (definition) => isObject(definition) && definition["@container"] === "@language");

type ContextRead = NonNullable<ReturnType<typeof readContext>>;

// Whether the compaction writes as given, and jsonld.js alike, a string given as an id or a value of a name typed @id
// that is no http(s) IRI (form 4): a blank node, an IRI of another scheme and a relative reference, which JSON-LD keeps
// as it is, Mastodon's compaction having no base. Not one shaped like a keyword (`@foo`), which the expansion drops; a
// blank node with no label or one holding `_:`, which Ruby's json-ld labels anew; one whose scheme is a prefix
// full_context defines (and the body's contexts do not; one they do is an http(s) IRI), which raises
// IRIConfusedWithPrefix; nor one jsonld.js, resolving it against an empty base, writes otherwise: empty, a network-path
// reference, or one holding whitespace; nor one with a `.` or `..` segment before its first `?` or `#`, one either ends
// too (jsonld.js removes them from a relative reference's path, which ends there, and keeps a query or a fragment as
// given), or `//` anywhere but right after a scheme that is no name of full_context (an authority): the shapes captured
// (forms.json), a scheme spelled as a name of full_context and an authority among them, but not the two together.
function writtenAsGiven(value: string): boolean {
  const colon = value.indexOf(":");
  const scheme = value.slice(0, colon);
  const authority =
    colon > 0 && SCHEME.test(scheme) && !FULL_CONTEXT_MEANINGS.has(scheme) && value.startsWith("//", colon + 1);
  return !(
    value === "" ||
    /\s/.test(value) ||
    value.startsWith("@") ||
    (authority ? value.slice(colon + 3) : value).includes("//") ||
    (value.startsWith("_:") && (value.length === 2 || value.includes("_:", 2))) ||
    (colon > 0 && FULL_CONTEXT_PREFIXES.has(scheme)) ||
    value
      .split(/[?#]/, 1)[0]!
      .split("/")
      .some((segment) => segment === "." || segment === "..")
  );
}

// `received` is the values check_jsonld_limits! counts before the compaction, of the body as received, of which a
// retraction's references read as IRIs (referencesAsIris) leave fewer; `retracts`, whether the body is a retraction's,
// whose compaction's values are counted as retractionWritten counts them, and any other's as three for each value.
function mastodonCompacts(
  json: Json,
  { prefixes, meanings }: ContextRead,
  received: number,
  retracts: boolean,
): boolean {
  const context = json["@context"];
  if (
    received > JSONLD_BUDGET ||
    (json.proof !== undefined && !(retracts && namedThroughout([json.proof]))) ||
    !(Array.isArray(context) ? context : [context]).every(
      (entry) => entry === AS || entry === SECURITY_V1 || (retracts && definedAsSent(entry)),
    )
  ) {
    return false;
  }
  const kept = jsonLdValues(json.signature);
  const written = retracts
    ? retractionWritten(json, meanings)
    : 1 + FULL_CONTEXT_VALUES + kept + 3 * (received - 1 - jsonLdValues(context) - kept);
  if (written > JSONLD_BUDGET) {
    return false;
  }
  const iri = (value: unknown) =>
    typeof value === "string" && HTTP_IRI.test(expand(value, (prefix) => prefixes.get(prefix)) ?? "");
  const reference = (value: unknown) => iri(value) || (retracts && typeof value === "string" && writtenAsGiven(value));
  const typeName = (value: unknown) =>
    iri(value) || (typeof value === "string" && isName(value) && (retracts || (value !== "id" && value !== "type")));
  const iriValued = (key: string) => IRI_VALUED.has(key) || (retracts && meanings.get(key)?.coercion === "@id");
  const scalar = (key: string, value: unknown) =>
    (typeof value === "number" || typeof value === "boolean") && key !== "object" && key !== "actor";
  const texts = (value: unknown) =>
    typeof value === "string" || (Array.isArray(value) && value.every((item) => typeof item === "string"));
  const listed = (key: string) =>
    [meanings.get(key), FULL_CONTEXT_MEANINGS.get(key)].some(
      (meaning) => meaning?.containers.includes("@list") === true,
    );
  const node = Object.fromEntries(Object.entries(json).filter(([key]) => key !== "@context" && key !== "signature"));
  const pending: [string, unknown][] = [["", node]];
  while (pending.length > 0) {
    const [key, value] = pending.pop()!;
    if (LANGUAGE_MAPS.has(key)) {
      if (
        !(isObject(value)
          ? Object.entries(value).every(
              ([tag, member]) =>
                LANGUAGE_TAG.test(tag) &&
                (member === null ||
                  typeof member === "string" ||
                  (retracts && Array.isArray(member) && texts(member) && tag === tag.toLowerCase())),
            )
          : retracts && texts(value))
      ) {
        return false;
      }
    } else if (Array.isArray(value)) {
      if (value.some(Array.isArray) && (!retracts || listed(key))) {
        return false;
      }
      pending.push(...value.map((item): [string, unknown] => [key, item]));
    } else if (isObject(value)) {
      if (
        (Object.hasOwn(value, "id") && !reference(value.id)) ||
        (Object.hasOwn(value, "type") && !(Array.isArray(value.type) ? value.type : [value.type]).every(typeName))
      ) {
        return false;
      }
      pending.push(...Object.entries(value).filter(([member]) => member !== "id" && member !== "type"));
    } else if (iriValued(key) && value !== null && !reference(value) && !(retracts && scalar(key, value))) {
      return false;
    }
  }
  return true;
}

// An upper bound on the values check_jsonld_limits! counts of a retraction's compaction under full_context, patched
// (form 4): full_context for its @context, its signature once as received, and its other members as writtenValues
// counts them. Pinned against Ruby's compaction of each captured body, and jsonld.js's of generated ones.
function retractionWritten(json: Json, meanings: ReadonlyMap<string, Meaning>): number {
  const node = Object.fromEntries(Object.entries(json).filter(([key]) => key !== "@context" && key !== "signature"));
  return FULL_CONTEXT_VALUES + jsonLdValues(json.signature) + writtenValues(node, meanings);
}

// The bound retractionWritten gives an LD-signed retraction's body, as mastodonCompacts takes it (its references read
// as IRIs); null for a body readContext refuses or no retraction's. For tests.
export function retractionWrittenBound(json: Json): number | null {
  const context = readContext(json["@context"]);
  if (context === null || !retraction(json.type, context.prefixes)) {
    return null;
  }
  return retractionWritten(referencesAsIris(json, context.meanings), context.meanings);
}

// An upper bound on the values the compaction under full_context, patched (patch_for_forwarding!), writes of a node of
// a retraction's body: the node one; a member whose name means the same on both sides, with no container on either
// side and not one full_context shadows, its own (ownValues), as the compaction writes each of its values under the
// name, or one the name does not take under the name's IRI as given (a number for a name typed @id, a node for one
// typed with a datatype), which no other member's value joins; and any other three for each of its values, as the
// closed shape counts them all (a scalar may become a value object of value and type, or a list; values written under
// another name may join that name's in an array).
function writtenValues(object: Json, meanings: ReadonlyMap<string, Meaning>): number {
  const [own, full] = scopedMeanings(object.type, meanings);
  let count = 1;
  for (const [key, value] of Object.entries(object)) {
    const meaning = own.get(key) ?? meanings.get(key);
    const compacted = full.get(key) ?? FULL_CONTEXT_MEANINGS.get(key);
    const asGiven =
      meaning?.key === compacted?.key &&
      ![meaning, compacted].some((each) => each?.contained === true) &&
      !FULL_CONTEXT_SHADOWED.has(key);
    count += asGiven ? ownValues(value, meanings) : 3 * jsonLdValues(value);
  }
  return count;
}

// The values of a value a name writes as given (writtenValues): a node's as writtenValues counts them, an array one and
// its items' (the patch puts back one the compaction shortens to its item), any other one.
function ownValues(value: unknown, meanings: ReadonlyMap<string, Meaning>): number {
  if (Array.isArray(value)) {
    return 1 + (value as unknown[]).reduce<number>((sum, item) => sum + ownValues(item, meanings), 0);
  }
  return isObject(value) ? writtenValues(value, meanings) : 1;
}

// What each name full_context defines means, its namespace prefixes, and their namespaces.
const FULL_CONTEXT_MEANINGS = readContext(FULL_CONTEXT)!.meanings;
const FULL_CONTEXT_PREFIXES = readContext(FULL_CONTEXT)!.prefixes;
const FULL_CONTEXT_NAMESPACES = [...FULL_CONTEXT_PREFIXES.values()];

// The name the compaction under full_context writes for a type's IRI, of every name it defines (TYPE_NAMES is the
// vocabulary's). No two such names share an IRI (JSON-LD would rank them by length and order);
// test/ld-signed-vocabulary.test.ts holds every one to jsonld.js.
function fullTypeNames(): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const [name, { iri, typeName }] of FULL_CONTEXT_MEANINGS) {
    if (typeName && iri !== null && !iri.startsWith("@")) {
      if (names.has(iri)) {
        throw new Error(`${iri} has two type names`);
      }
      names.set(iri, name);
    }
  }
  return names;
}

const FULL_TYPE_NAMES = fullTypeNames();

// The values of a value, arrays flattened, as JSON-LD expands them under one term.
const leaves = (value: unknown): unknown[] => (Array.isArray(value) ? value.flatMap(leaves) : [value]);

// JSON-LD's order of names: by code point (Term Selection's ties, a node's types).
const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// Whether the compaction under full_context writes one value under a name that means there what it means in the body
// (Term Selection): one typed @id takes a string (an IRI) or an object (a node), one typed with a datatype anything but
// an object (a scalar becomes a value of that type), an untyped one any value. Any other value it writes under the
// name's IRI, which no reader reads. test/ld-signed-vocabulary.test.ts holds every name of full_context to jsonld.js.
function takes(meaning: Meaning | undefined, value: unknown): boolean {
  const coercion = meaning?.coercion ?? null;
  if (coercion === "@id" || coercion === "@vocab") {
    return typeof value === "string" || isObject(value);
  }
  return coercion === null || coercion === "@json" || !isObject(value);
}

// What the compaction writes under such a name of what the body gives it: a language map only as a map that holds a
// text (an array or a scalar there is a value it writes under another name, `content` for `contentMap`), a list only if
// it takes every member (it selects a list's term by all its members), and otherwise each value it takes; undefined for
// none.
function writtenUnder(meaning: Meaning | undefined, value: unknown): unknown {
  if (meaning?.containers.includes("@language") === true) {
    const texts = isObject(value) && leaves(Object.values(value)).some((text) => text !== null);
    return value === null || texts ? value : undefined;
  }
  const values = leaves(value).filter((item) => item !== null);
  const taken = values.filter((item) => takes(meaning, item));
  if (taken.length === values.length) {
    return value;
  }
  return taken.length === 0 || meaning?.containers.includes("@list") === true ? undefined : taken;
}

// The names full_context defines as it defines a shorter one (or one as long that sorts first), which Term Selection
// then always prefers: the compaction never writes them (`expiration`, written `expires`).
function shadowedNames(): ReadonlySet<string> {
  const first = new Map<string, string>();
  for (const name of [...FULL_CONTEXT_MEANINGS.keys()].toSorted((a, b) => a.length - b.length || byCodePoint(a, b))) {
    const { key } = FULL_CONTEXT_MEANINGS.get(name)!;
    if (!first.has(key)) {
      first.set(key, name);
    }
  }
  return new Set([...FULL_CONTEXT_MEANINGS].filter(([name, { key }]) => first.get(key) !== name).map(([name]) => name));
}

const FULL_CONTEXT_SHADOWED = shadowedNames();

const SENSITIVE_IRI = FULL_CONTEXT_MEANINGS.get("sensitive")?.iri;

// `sensitive` the body's contexts define otherwise than full_context, which leaves it untyped and so takes any value
// (takes): the compaction still writes it under the name, an IRI or a typed value as an object, a list as a @list
// object, an array (an empty one too) as an array, and a lone boolean or number the definition types @id or @vocab as
// it is, and Mastodon marks the status as its boolean column casts that value (an object, an array or a float 0 as
// true). Kopje reads it as true wherever Mastodon may mark the status, so that a status Mastodon marks is never shown
// unmarked: a lone boolean written as it is by railsBoolean, as an unsigned body's (remote-status.ts), and a lone
// number as true, 0 included, since its JSON does not tell an integer 0, which Mastodon leaves unmarked, from a float
// one (0.0), which it marks. null is written as nothing.
function marksSensitive(meaning: Meaning | undefined, value: unknown): boolean {
  if (meaning === undefined || meaning.iri !== SENSITIVE_IRI || value === null) {
    return false;
  }
  const plain = meaning.coercion === "@id" || meaning.coercion === "@vocab";
  const asIs =
    plain && !meaning.containers.includes("@list") && (typeof value === "boolean" || typeof value === "number");
  return !asIs || typeof value === "number" || railsBoolean(value) === true;
}

// What a node's types' own contexts make its members mean, in the body (each type a name it defines) and in the
// compaction (the name full_context gives the type's IRI), applied in the order of the names.
function scopedMeanings(
  types: unknown,
  meanings: ReadonlyMap<string, Meaning>,
): [Map<string, Meaning>, Map<string, Meaning>] {
  const body = new Map<string, Meaning>();
  const full = new Map<string, Meaning>();
  for (const name of leaves(types)
    .filter((type): type is string => typeof type === "string" && isName(type))
    .toSorted(byCodePoint)) {
    const meaning = meanings.get(name);
    const iri = meaning?.iri ?? null;
    const compacted = iri === null ? undefined : FULL_TYPE_NAMES.get(iri);
    for (const [scoped, definitions] of [
      [body, meaning?.scoped],
      [full, compacted === undefined ? undefined : FULL_CONTEXT_MEANINGS.get(compacted)?.scoped],
    ] as const) {
      for (const [key, value] of definitions ?? []) {
        scoped.set(key, value);
      }
    }
  }
  return [body, full];
}

// An LD-signed body with its names, as members and as types, read only where Mastodon's compaction under full_context
// writes them so, whatever D5 decides (ID-1). Mastodon's readers read a member by its name only where the compaction
// writes that name, and Kopje's readers, given this body, read one only there too; any other is renamed `_:name`, which
// neither reads:
//   - a member's name means the same in the body's contexts and in full_context, or is defined by neither (it expands
//     by ActivityStreams' @vocab "_:" to a blank node's IRI, which the compaction writes as the name again), and holds
//     only the values the compaction writes under it (writtenUnder: a boolean or a number of a name typed @id, an
//     object of one typed with a datatype, a language map but a map that holds a text, and any value of a name
//     full_context writes as another, it writes elsewhere). In a typed node a member means what the type's own context
//     makes it mean, in the body and in the compaction (scopedMeanings). One full_context defines that the body leaves
//     undefined (`QuoteRequest`, `Hashtag`, `Emoji`, `PropertyValue`, `sensitive`, `quote`, `interactionPolicy`, …
//     under the ActivityStreams and security contexts alone) the compaction writes as `_:name`; one the body defines
//     otherwise (another type or container, or a name full_context leaves undefined), as its IRI. That last holds for
//     the values a definition coerces; a value of another shape (an object for a name typed @id, say) the compaction
//     may still write under the name, and Kopje then reads less than Mastodon, but for `sensitive` (marksSensitive);
//   - a type name is the one the compaction writes for the IRI the body's contexts give it (FULL_TYPE_NAMES), or is
//     defined by neither. A name aliasing a keyword is left as it is (no reader reads one as a type).
// Kept as they are: a language map's tags, the top-level @context, signature and proof. A body Kopje can show Mastodon
// reads as received (mastodonReadsAsReceived) is read as received; where Mastodon gives the compaction up otherwise, a
// name so renamed is read less than Mastodon reads it (docs/mastodon-deviations.md).
function namedAsCompacted(json: Json, meanings: ReadonlyMap<string, Meaning>): Json {
  const blank = (name: string) => `_:${name}`;
  const typeNamed = (name: string) => {
    const meaning = meanings.get(name);
    if (meaning === undefined) {
      return FULL_CONTEXT_MEANINGS.has(name) ? blank(name) : name;
    }
    return meaning.iri?.startsWith("@") || (meaning.iri !== null && FULL_TYPE_NAMES.get(meaning.iri) === name)
      ? name
      : blank(name);
  };
  const typed = (value: unknown) => (typeof value === "string" && isName(value) ? typeNamed(value) : value);
  const member = (
    key: string,
    value: unknown,
    [own, full]: [Map<string, Meaning>, Map<string, Meaning>],
  ): [string, unknown] => {
    const meaning = own.get(key) ?? meanings.get(key);
    if (meaning?.key !== (full.get(key) ?? FULL_CONTEXT_MEANINGS.get(key))?.key) {
      return key === "sensitive" && marksSensitive(meaning, value) ? [key, true] : [blank(key), node(value)];
    }
    if (key === "type") {
      return [key, Array.isArray(value) ? value.map(typed) : typed(value)];
    }
    const written = FULL_CONTEXT_SHADOWED.has(key) ? undefined : writtenUnder(meaning, value);
    if (written === undefined) {
      return [blank(key), node(value)];
    }
    return [key, meaning?.containers.includes("@language") === true ? written : node(written)];
  };
  const members = (object: Json, kept?: ReadonlySet<string>): Json => {
    const scoped = scopedMeanings(object.type, meanings);
    return Object.fromEntries(
      Object.entries(object).map(([key, value]) => (kept?.has(key) ? [key, value] : member(key, value, scoped))),
    );
  };
  const node = (value: unknown): unknown =>
    Array.isArray(value) ? value.map(node) : isObject(value) ? members(value) : value;
  return members(json, AS_RECEIVED);
}

const AS_RECEIVED: ReadonlySet<string> = new Set(["@context", "signature", "proof"]);

// Fedify's preloaded contexts, and nothing else: no fetch.
const preloaded = (url: string) => {
  const document = preloadedContexts[url];
  return document === undefined
    ? Promise.reject(new Error(`Not a preloaded JSON-LD context: ${url}`))
    : Promise.resolve({ document, documentUrl: url, contextUrl: null });
};

// The contexts a proof may name, at any depth, as a body's (1): each preloaded, giving no name a keyword but @id and
// @type.
const PROOF_CONTEXTS: ReadonlySet<string> = new Set([AS, ...SIGNED_CONTEXT_URLS.keys()]);

// The contexts a body and its proof may give before the proof is expanded, each URL or object of a @context, each type
// (whose context, if it has one, applies in its node) and each value under a key of SCOPED_NAMES (whose context
// applies in each): jsonld.js processes a context again in each node whose active context differs, so their number,
// more than their size, makes the expansion's cost. A real body and its proof give a dozen.
const PROOF_CONTEXT_LIMIT = 32;

const contextEntries = (value: unknown) => (Array.isArray(value) ? value.length : value === undefined ? 0 : 1);

// The names a context in PROOF_CONTEXTS defines with a context of their own, at any depth (DataIntegrityProof,
// proofPurpose, service, Multikey, JsonWebKey): JSON-LD processes that context wherever the name is a key (a
// property-scoped context), as it does wherever the name is a type. An inline definition has none (2).
function scopedNames(definitions: Json, names: Set<string>): Set<string> {
  for (const [name, definition] of Object.entries(definitions)) {
    if (isObject(definition) && definition["@context"] !== undefined) {
      names.add(name);
      if (isObject(definition["@context"])) {
        scopedNames(definition["@context"], names);
      }
    }
  }
  return names;
}
const SCOPED_NAMES: ReadonlySet<string> = [...URL_DEFINITIONS.values()].reduce(
  (names, definitions) => scopedNames(definitions, names),
  new Set<string>(),
);

// The keywords a node, value, list or set object holds that both expanders read alike; a @graph, @included or
// @reverse key has Mastodon read the body as received before anything is expanded (jsonLdValues). Every other key that
// starts with @ (a keyword of contexts and frames such as @version, @vocab, @none or @json, or a string shaped like a
// keyword) Ruby's json-ld drops and jsonld.js keeps as a member, so a proof with one is not compared; and Ruby's
// json-ld drops a key or a type any line of which is shaped like a keyword (RUBY_KEYWORD_LIKE: its ^ and $ match at
// each line, context.rb), which jsonld.js reads as a term ("x\n@abc" defined inline) or an IRI. JavaScript's m flag
// also ends a line at \r, U+2028 and U+2029, so it matches more lines than Ruby's, never fewer.
const RUBY_KEYWORD_LIKE = /^@[a-zA-Z]+$/m;
const NODE_KEYWORDS: ReadonlySet<string> = new Set([
  "@context",
  "@id",
  "@type",
  "@value",
  "@language",
  "@direction",
  "@index",
  "@list",
  "@set",
  "@nest",
]);

// A proof as Mastodon's JSON-LD library and jsonld.js both expand it, or undefined: each @context in it, at any depth,
// one the rules (1, 2) read, or URLs of PROOF_CONTEXTS alone, so that no name there is a keyword but @id and @type and
// no context is fetched; no more contexts, types and values under keys of SCOPED_NAMES than `contexts` leaves (each
// value counts, its object reverting a type's context first); no key of an object that starts with @, or that has a
// line shaped like a keyword, but NODE_KEYWORDS; and each @set object (with an @index or not) its value, which Mastodon's
// library reads it as, so that one of nothing leaves nothing where jsonld.js leaves an empty node. A @value is left as
// it is (a JSON literal's value is data), and so is a language map, an object under a name of LANGUAGE_MAPS (its keys
// are tags, its values strings, and jsonld.js refuses any other); an array there holds values and nodes, compared as
// any other. A map under @nest is not a node, its members its node's: one with a @set is not read, nor a @set object
// with a @context.
function comparableProof(value: unknown, contexts: { left: number }, nested = false): { value: unknown } | undefined {
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value) {
      const comparable = comparableProof(item, contexts, nested);
      if (comparable === undefined) {
        return undefined;
      }
      items.push(comparable.value);
    }
    return { value: items };
  }
  if (!isObject(value)) {
    return { value };
  }
  const { "@context": context } = value;
  contexts.left -= contextEntries(context) + contextEntries(value.type) + contextEntries(value["@type"]);
  if (contexts.left < 0) {
    return undefined;
  }
  if (context !== undefined) {
    const urls = (Array.isArray(context) ? context : [context]).every(
      (url) => typeof url === "string" && PROOF_CONTEXTS.has(url),
    );
    if (!urls && readContext(context) === null) {
      return undefined;
    }
  }
  if (Object.hasOwn(value, "@set")) {
    if (nested || !Object.keys(value).every((key) => key === "@set" || key === "@index")) {
      return undefined;
    }
    return comparableProof(value["@set"], contexts);
  }
  const members: [string, unknown][] = [];
  for (const [key, member] of Object.entries(value)) {
    if (!NODE_KEYWORDS.has(key) && (key.startsWith("@") || RUBY_KEYWORD_LIKE.test(key))) {
      return undefined;
    }
    if (SCOPED_NAMES.has(key) && (contexts.left -= Math.max(1, leaves(member).length)) < 0) {
      return undefined;
    }
    const comparable =
      key === "@context" || key === "@value" || (LANGUAGE_MAPS.has(key) && isObject(member))
        ? { value: member }
        : comparableProof(member, contexts, key === "@nest");
    if (comparable === undefined) {
      return undefined;
    }
    members.push([key, comparable.value]);
  }
  return { value: Object.fromEntries(members) };
}

const PROOF_IRI = "https://w3id.org/security#proof";

// Whether JSON-LD's expansion keeps anything of the body's proof, which in the data-integrity contexts is a @graph
// container: Mastodon's compaction then writes it as a graph object, under a @graph key check_jsonld_limits! refuses.
// The proof (comparableProof) is expanded by jsonld.js (the copy Fedify's signatures use), with Fedify's preloaded
// contexts and no fetch, under the body's @context and type, as the value of its IRI written out, which no context
// defines: jsonld.js, unlike JSON-LD 1.1 and Mastodon's json-ld, drops from a @graph container's values an empty node,
// a value, a list and a bare node reference, and the value of a name no context defines expands as one of `proof` but
// for that container and its @id typing (which only makes a string a node reference, kept either way). Where the proof
// is not comparable or the expansion raises, the body is read as named, less than Mastodon reads where it reads it as
// received. Mastodon's 1,000 values (checked first) and PROOF_CONTEXT_LIMIT bound the expansion (RES-6):
// test/inbox-signed-forms.test.ts holds its time at those bounds on each path a context applies by, and
// test/ld-signed-proof-shapes.test.ts its result to Mastodon's reading of each proof to depth 3 and of a proof holding
// each keyword of JSON-LD 1.1 and its framing.
async function proofExpandsToSomething(json: Json): Promise<boolean> {
  const left = PROOF_CONTEXT_LIMIT - contextEntries(json["@context"]) - contextEntries(json.type);
  const proof = left < 0 ? undefined : comparableProof(json.proof, { left });
  if (proof === undefined) {
    return false;
  }
  const probe = {
    "@context": json["@context"],
    ...(Object.hasOwn(json, "type") ? { type: json.type } : {}),
    [PROOF_IRI]: proof.value,
  };
  try {
    const [node] = await jsonld.expand(probe, { documentLoader: preloaded });
    const kept = node?.[PROOF_IRI];
    return Array.isArray(kept) && kept.length > 0;
  } catch {
    return false;
  }
}

// Whether Mastodon reads an LD-signed body as received, as Kopje can show: its JSON-LD limits refuse it before the
// compaction (more than 1,000 values, or a @graph, @included or @reverse key; check_jsonld_limits!), or after it, for
// a proof its contexts make a @graph container of which the expansion keeps something (proofExpandsToSomething). A
// proof elsewhere than at the top is not shown: Kopje then reads the body as named. `received` is the values of the
// body as received (readBody counts them once, for mastodonCompacts too).
async function mastodonReadsAsReceived(
  json: Json,
  meanings: ReadonlyMap<string, Meaning>,
  received: number,
): Promise<boolean> {
  if (received > JSONLD_BUDGET) {
    return true;
  }
  const graph = meanings.get("proof")?.containers.includes("@graph") === true;
  return graph && json.proof !== undefined && (await proofExpandsToSomething(json));
}

// A type as Mastodon reads it in an LD-signed body of the shape whose compaction Kopje shows succeeds
// (mastodonCompacts): the compaction writes one given as a compact IRI over a prefix the body's context defines, or as
// an absolute IRI, as the vocabulary's name for that IRI, and the patch puts no type back. A name keeps the meaning
// the rules hold it to; any other type, and every type of a body outside that shape, is read as given.
export type TypeReader = (type: string) => string;

// Rule (4), under rule (5): no node of the body (its proof included) outside the signature and a @context gives, under
// `type` and `@type` together, two types or more one of which is not a string or is one Ruby's json-ld expands to
// nothing (RUBY_KEYWORD_LIKE: "@foo", "x\n@abc"), nor a type beside a @set. Ruby's json-ld sorts the values of every
// key that expands to @type (expand.rb, the type-scoped contexts), merges a node's `type` and `@type` into one array,
// and sorts its types again as it compacts them (compact.rb), and a string compared with any other value or a nil
// raises an ArgumentError; a @set beside a single type is kept as a node and raises a NoMethodError. Neither is one
// ProcessActivityService rescues, so Mastodon's job raises and applies nothing. Such types may sort, and JSON::LD then
// refuse them (Mastodon reads the body as received), as may a @set with a value, or a body past Mastodon's JSON-LD
// limits, which it reads as received unexpanded: Kopje refuses those too, and reads less. Each value is visited once.
function typesSortable(json: Json): boolean {
  const pending: unknown[] = [json];
  while (pending.length > 0) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      pending.push(...(value as unknown[]));
    } else if (isObject(value)) {
      // As Ruby's Array(): an array as it is, any other value as one.
      const types = ["type", "@type"].flatMap((key) => (Object.hasOwn(value, key) ? [value[key]].flat() : []));
      if (
        (types.length > 1 && types.some((type) => typeof type !== "string" || RUBY_KEYWORD_LIKE.test(type))) ||
        (types.length > 0 && Object.hasOwn(value, "@set"))
      ) {
        return false;
      }
      for (const [key, member] of Object.entries(value)) {
        if (key !== "@context" && !(value === json && key === "signature")) {
          pending.push(member);
        }
      }
    }
  }
  return true;
}

// JSON-LD 1.1's keywords (its §1.7).
const JSONLD_KEYWORDS: ReadonlySet<string> = new Set([
  "@base",
  "@container",
  "@context",
  "@direction",
  "@graph",
  "@id",
  "@import",
  "@included",
  "@index",
  "@json",
  "@language",
  "@list",
  "@nest",
  "@none",
  "@prefix",
  "@propagate",
  "@protected",
  "@reverse",
  "@set",
  "@type",
  "@value",
  "@version",
  "@vocab",
]);

// A control character (C0, DEL, C1) or a line break (\n and \r among C0, U+2028, U+2029).
function controlOrBreak(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || (code >= 0x7f && code < 0xa0) || code === 0x2028 || code === 0x2029) {
      return true;
    }
  }
  return false;
}

// Each inline definition Mastodon (3.5 to 4.7.5) or Fedify writes, by name.
const SENDER_DEFINITIONS = new Map<string, readonly unknown[]>();
for (const terms of [MASTODON_CONTEXT_TERMS, MASTODON_OLM_TERMS, FEDIFY_CONTEXT_TERMS]) {
  for (const [name, definitions] of Object.entries(terms)) {
    SENDER_DEFINITIONS.set(name, [...(SENDER_DEFINITIONS.get(name) ?? []), ...definitions]);
  }
}

// An inline context of definitions only, each one a real sender writes for its name.
function definedAsSent(entry: unknown): boolean {
  return (
    isObject(entry) &&
    Object.entries(entry).every(([name, definition]) =>
      (SENDER_DEFINITIONS.get(name) ?? []).some((written) => sameDefinition(written, definition)),
    )
  );
}

// A @context as real senders write one: no URL twice (readContext reads each entry, so a repeated one would multiply its
// work), and every inline definition one a real sender writes for that name.
function contextAsSent(context: unknown): boolean {
  const entries = [context].flat();
  const urls = entries.filter((entry) => typeof entry === "string");
  return (
    new Set(urls).size === urls.length && entries.every((entry) => typeof entry === "string" || definedAsSent(entry))
  );
}

// A type as real senders write one: a plain term (letters, digits, _ and -) or an absolute IRI with no space or
// control character.
const PLAIN_TERM = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const NO_SPACE = /^\S+$/;
const typeAsSent = (type: unknown) =>
  typeof type === "string" &&
  (PLAIN_TERM.test(type) || (ABSOLUTE_IRI.test(type) && NO_SPACE.test(type) && !controlOrBreak(type)));

// A proof as Fedify writes one: an object, or an array of at most MAX_PROOFS, of plain names given strings and of a
// @context the rules (1, 2, 5) read. Fedify writes one proof for each Ed25519 key it signs with (one, as real senders
// configure it, and one alone where the activity embeds a signed object); Mastodon writes none.
const MAX_PROOFS = 4;
function proofAsSent(proof: unknown): boolean {
  const items = [proof].flat();
  return (
    items.length > 0 &&
    items.length <= MAX_PROOFS &&
    items.every(
      (item) =>
        isObject(item) &&
        Object.entries(item).every(([key, value]) =>
          key === "@context"
            ? contextAsSent(value) && readContext(value) !== null
            : isName(key) && typeof value === "string",
        ),
    )
  );
}

// Rule (5): the body holds only what real senders write, the primary guard against forms where Ruby's json-ld and
// jsonld.js part (ID-1) or a proof's expansion grows (RES-6). Mastodon 3.5 to 4.7.5, Fedify (Kopje's own LD-signed
// deliveries among them) and every corpus sender write no key with a control character or a line break, no key that
// starts with @ but a keyword, no context URL twice, an inline definition only from their own tables, types only as
// plain terms or absolute IRIs, and a proof (Fedify's FEP-8b32 one, one for each key it signs with) of a @context and
// of names given strings: a body outside that is refused, so that it applies nothing, where Mastodon may apply it, and
// the deviations page lists the forms. It runs before any context is read, and visits each value once.
function senderShaped(json: Json): boolean {
  if (!contextAsSent(json["@context"]) || (Object.hasOwn(json, "proof") && !proofAsSent(json.proof))) {
    return false;
  }
  const pending: unknown[] = [json];
  while (pending.length > 0) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      pending.push(...(value as unknown[]));
    } else if (isObject(value)) {
      for (const [key, member] of Object.entries(value)) {
        if (controlOrBreak(key) || (key.startsWith("@") && !JSONLD_KEYWORDS.has(key))) {
          return false;
        }
        if (key === "@context") {
          continue;
        }
        if ((key === "type" || key === "@type") && ![member].flat().every(typeAsSent)) {
          return false;
        }
        pending.push(member);
      }
    }
  }
  return true;
}

// The rules a body is read under: all of them, or, for tests of the second layer, all but rule (5); and, for the test
// that the retractions' forms change no other reading, a retraction read as any other activity.
export type Rules = { senderShapes?: boolean; retractions?: boolean };

// Rules (3) and (4).
const keysAndTypesReadable = (json: Json) => bodyKeysReadable(json) && typesSortable(json);

// The retractions (#1717): an LD-signed Reject, Undo, Block or Delete, by the name its type is read as (D5), is read
// in the forms below as Mastodon's compaction writes them, where Kopje shows the compaction succeeds
// (mastodonCompacts); anywhere else it is read as received. Each ends what its signer did or holds (a follow, a block,
// a favourite, a boost, a status, its account, its acceptance of a follow) or lifts its own block, and the envelope
// holds its actor to the signer (inbound.ts activityEnvelope), so that a misreading grants nothing the signer could not
// send directly under its own HTTP signature. Every other type keeps the reading as received, where a misreading could
// grant something new.
const RETRACTIONS: ReadonlySet<string> = new Set(["Reject", "Undo", "Block", "Delete"]);

function retraction(type: unknown, prefixes: Prefixes): boolean {
  if (typeof type !== "string") {
    return false;
  }
  const name = isName(type) ? type : TYPE_NAMES.get(expand(type, (prefix) => prefixes.get(prefix)) ?? "");
  return name !== undefined && RETRACTIONS.has(name);
}

// A retraction's actor as an array of one string or one node with an id, in arrays in it or not, read as that element:
// JSON-LD's expansion flattens an array in another (an empty one leaves nothing), Mastodon tells a relay by the actor
// of the compaction, which writes the array as its element (process_activity_service.rb different_actor?), and applies
// the activity as its signer's (Activity.factory with the signer), whatever the patch puts back. Two elements, or a
// null, are left as they are, so the envelope finds no actor.
function actorAsCompacted(json: Json): Json {
  const [actor, ...rest] = Array.isArray(json.actor) ? (json.actor as unknown[]).flat(Infinity) : [];
  const single = rest.length === 0 && (typeof actor === "string" || (isObject(actor) && typeof actor.id === "string"));
  return single ? { ...json, actor } : json;
}

// A retraction's node references given as objects whose only key is @id, read as their IRIs (form 3): under a name
// both contexts give the same meaning, typed @id with no container, which full_context does not shadow, JSON-LD expands
// such an object as it expands its IRI given as a string, and the compaction writes the IRI as given where it is an
// http(s) IRI under no namespace of full_context's prefixes (one under a namespace it writes as a compact IRI,
// `as:Public`). The patch puts back no object the compaction made a string (it patches only an object into an object),
// so Mastodon reads the IRI; in an array too, which keeps its shape as the patch makes it an array again, and in every
// node of the body (an embedded activity's `object` too), but none in a language map. Any other object is left as it
// is, for rule (3) to refuse; the same body is returned when none is read so.
function referencesAsIris(json: Json, meanings: ReadonlyMap<string, Meaning>): Json {
  let read = false;
  const reference = (value: unknown): unknown => {
    const iri = isObject(value) ? value["@id"] : undefined;
    if (
      typeof iri !== "string" ||
      Object.keys(value as Json).length !== 1 ||
      !HTTP_IRI.test(iri) ||
      FULL_CONTEXT_NAMESPACES.some((namespace) => iri.startsWith(namespace))
    ) {
      return node(value);
    }
    read = true;
    return iri;
  };
  const members = (object: Json, kept?: ReadonlySet<string>): Json => {
    const [own, full] = scopedMeanings(object.type, meanings);
    return Object.fromEntries(
      Object.entries(object).map(([key, value]) => {
        const meaning = own.get(key) ?? meanings.get(key);
        const compacted = full.get(key) ?? FULL_CONTEXT_MEANINGS.get(key);
        // A language map's keys are language tags, and its values no nodes: it is left as received, for rule (3) to
        // refuse a reference in it, as JSON-LD refuses the map (Mastodon then reads the body as received).
        if (kept?.has(key) || [meaning, compacted].some((each) => each?.containers.includes("@language") === true)) {
          return [key, value];
        }
        const references =
          meaning !== undefined &&
          meaning.key === compacted?.key &&
          meaning.coercion === "@id" &&
          !meaning.contained &&
          !compacted.contained &&
          !FULL_CONTEXT_SHADOWED.has(key);
        return [key, references ? (Array.isArray(value) ? value.map(reference) : reference(value)) : node(value)];
      }),
    );
  };
  const node = (value: unknown): unknown =>
    Array.isArray(value) ? value.map(node) : isObject(value) ? members(value) : value;
  const body = members(json, AS_RECEIVED);
  return read ? body : json;
}

// JavaScript orders the keys of a parsed object as written but those shaped like array indexes, which it puts first;
// Ruby keeps them as written. In an object holding one, Kopje cannot tell where Mastodon's patch stops.
const ARRAY_INDEX = /^(?:0|[1-9]\d*)$/;
const arrayIndex = (key: string) => ARRAY_INDEX.test(key) && Number(key) < 2 ** 32 - 1;

// A retraction's members where Mastodon's patch stops (form 2; json_ld_helper.rb patch_for_forwarding!): in each object
// it patches, it walks the members as received (but @context and signature), skips a null one and one the compaction
// does not write under the same name, patches an object into an object and an array element by element, and stops at
// the first array whose length the compaction changed, leaving every member after it in that object as the compaction
// wrote it, and the objects in them unpatched; a stop in an object it patched stops only that object. Kopje reads a
// stop only where it is certain: an array holding a null under a name both contexts type @id with no container, its
// other values http(s) IRIs (JSON-LD drops the null and keeps each IRI). After it, a one-element array of a string or
// an object under a name with no container in full_context is read as its element, as the compaction writes it, and so
// in every object in the members after it. Any other array, and every member of an object holding a key shaped like an
// array index, is left as received: where Mastodon stops elsewhere, Kopje reads less (an `object` given as an array is
// refused). `named` is `json` as namedAsCompacted names it, member for member.
function patchedAsMastodon(json: Json, named: Json, meanings: ReadonlyMap<string, Meaning>): Json {
  const stops = (value: unknown[], meaning: Meaning | undefined, compacted: Meaning | undefined) => {
    const values = value.filter((item) => item !== null);
    return (
      values.length < value.length &&
      meaning?.coercion === "@id" &&
      !meaning.contained &&
      compacted?.contained === false &&
      values.every((item) => typeof item === "string" && HTTP_IRI.test(item))
    );
  };
  // A member as the compaction writes it, read as namedAsCompacted names it (a renamed one left as it is).
  const compacted = (member: unknown, meaning: Meaning | undefined): unknown => {
    const [only, ...rest] = Array.isArray(member) ? (member as unknown[]) : [];
    const single = rest.length === 0 && (typeof only === "string" || isObject(only)) && !meaning?.contained;
    const written = single ? only : member;
    return Array.isArray(written) ? written.map(unpatched) : unpatched(written);
  };
  const unpatched = (value: unknown): unknown => {
    if (!isObject(value)) {
      return value;
    }
    const [, full] = scopedMeanings(value.type, meanings);
    return Object.fromEntries(
      Object.entries(value).map(([key, member]) => [
        key,
        key.startsWith("_:") ? member : compacted(member, full.get(key) ?? FULL_CONTEXT_MEANINGS.get(key)),
      ]),
    );
  };
  const patched = (got: Json, read: Json, kept?: ReadonlySet<string>): Json => {
    const keys = Object.keys(got);
    const names = Object.keys(read);
    if (keys.some(arrayIndex) || names.length !== keys.length) {
      return read;
    }
    const [own, full] = scopedMeanings(got.type, meanings);
    let stopped = false;
    return Object.fromEntries(
      keys.map((key, index) => {
        const name = names[index]!;
        const value = got[key];
        const member = read[name];
        const compactedMeaning = full.get(key) ?? FULL_CONTEXT_MEANINGS.get(key);
        if (kept?.has(key) || key === "@context" || key === "signature" || name !== key) {
          return [name, member];
        }
        if (stopped) {
          return [name, compacted(member, compactedMeaning)];
        }
        if (isObject(value) && isObject(member)) {
          return [name, patched(value, member)];
        }
        if (!Array.isArray(value)) {
          return [name, member];
        }
        const values = value as unknown[];
        if (stops(values, own.get(key) ?? meanings.get(key), compactedMeaning)) {
          stopped = true;
          return [name, member];
        }
        const elements = Array.isArray(member) && member.length === values.length ? (member as unknown[]) : undefined;
        return [
          name,
          elements?.map((item, at) => {
            const given = values[at];
            return isObject(given) && isObject(item) ? patched(given, item) : item;
          }) ?? member,
        ];
      }),
    );
  };
  return patched(json, named, AS_RECEIVED);
}

// The rules (1-5) over an LD-signed body in their order, and the body they read: rule (5) over the body as received,
// rules (1) and (2) over its context, then a retraction's references read as IRIs (referencesAsIris) where Kopje shows
// the compaction succeeds so (rules 3 and 4 hold of it, and mastodonCompacts, its values counted as received, which
// also shows Mastodon does not read the body as received: no proof, and at most 1,000 values), else the body as
// received, and rules (3) and (4) over the body read. Where Mastodon gives the compaction up, it reads such an object
// as no IRI (value_or_id), and applies nothing; Kopje's rule (3) refuses it. null when the rules refuse the body.
function readBody(
  json: Json,
  { senderShapes = true, retractions = true }: Rules,
): { body: Json; context: NonNullable<ReturnType<typeof readContext>>; received: number; retracts: boolean } | null {
  // Rule (5) first, so that readContext reads only a context as senders write one.
  if (senderShapes && !senderShaped(json)) {
    return null;
  }
  const context = readContext(json["@context"]);
  if (context === null) {
    return null;
  }
  const retracts = retractions && retraction(json.type, context.prefixes);
  const references = retracts ? referencesAsIris(json, context.meanings) : json;
  // The values of the body as received, counted once for both judgements of Mastodon's limits.
  const received = jsonLdValues(json);
  const body =
    references !== json && keysAndTypesReadable(references) && mastodonCompacts(references, context, received, retracts)
      ? references
      : json;
  return keysAndTypesReadable(body) ? { body, context, received, retracts } : null;
}

// Whether an LD-signed activity is read (its signature an object), and then how its types are read and its body as
// Mastodon's compaction names its members (namedAsCompacted): null when the rules refuse it. Run after
// withinJsonBounds, so the work is bounded by its values, and a proof's expansion by Mastodon's 1,000 values and
// PROOF_CONTEXT_LIMIT too.
export async function ldSignedReading(
  json: Json,
  rules: Rules = {},
): Promise<{ readType: TypeReader; body: Json } | null> {
  const read = readBody(json, rules);
  if (read === null) {
    return null;
  }
  const { body, context, received, retracts } = read;
  let compacts: boolean | undefined;
  const shown = () => (compacts ??= mastodonCompacts(body, context, received, retracts));
  const readType: TypeReader = (type) => {
    const iri = expand(type, (prefix) => context.prefixes.get(prefix));
    const name = iri === null ? undefined : TYPE_NAMES.get(iri);
    return name !== undefined && shown() ? name : type;
  };
  // The body read is the body as received there (readBody).
  if (await mastodonReadsAsReceived(json, context.meanings, received)) {
    return { readType, body: json };
  }
  const named = namedAsCompacted(body, context.meanings);
  if (!(retracts && shown())) {
    return { readType, body: named };
  }
  const patched = actorAsCompacted(patchedAsMastodon(body, named, context.meanings));
  return undoesByArray(patched, readType) ? null : { readType, body: patched };
}

// Whether an Undo of a Follow, a Block or a Like gives the undone activity's `object` as an array where Mastodon's
// reading does too (patchedAsMastodon: the patch puts back each array the compaction did not shorten, one in another
// flattened): undo.rb seeks what to end by it (target_uri, value_or_id), which raises on an array, so Mastodon applies
// nothing, where Kopje's handler would end the activity by its id. Refused; Kopje reads less where the patch stops
// before it at a member Kopje does not read the stop at.
const UNDONE_BY_TARGET: ReadonlySet<string> = new Set(["Follow", "Block", "Like"]);
function undoesByArray(read: Json, readType: TypeReader): boolean {
  const undone = read.object;
  return (
    typeof read.type === "string" &&
    readType(read.type) === "Undo" &&
    isObject(undone) &&
    typeof undone.type === "string" &&
    UNDONE_BY_TARGET.has(readType(undone.type)) &&
    Array.isArray(undone.object)
  );
}

// Whether the rules (1-5) read an LD-signed body at all (ldSignedReading is null for no other).
export function ldSignedBodyReadable(json: Json, rules: Rules = {}): boolean {
  return readBody(json, rules) !== null;
}
