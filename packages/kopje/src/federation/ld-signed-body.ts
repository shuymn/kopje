import { preloadedContexts } from "@fedify/fedify";

import { isObject } from "./json-shapes";
import { MASTODON_CONTEXT_TERMS, MASTODON_NAMED_CONTEXTS } from "./mastodon-context";

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
//   3. every key of the body but the top-level @context, signature and proof is a plain name.
//
// Then every name of the vocabulary means what full_context makes it, no other name or keyword alias reaches one of its
// IRIs, and no base or vocabulary is set: no key Kopje reads is renamed, aliased or given another meaning by the
// compaction, and no member is merged into one. The rules do not make the readings equal. The compaction writes a type
// given as an IRI (as:Follow, or the absolute one) as the vocabulary's name for it, and Kopje reads the activity's
// type and its embedded object's so where it shows the compaction succeeds (mastodonCompacts); it writes a name, as a
// key or a type, only where the name means in the body's contexts what it means in full_context (one full_context
// defines that the body's contexts leave undefined it writes as a blank node's), and Kopje reads the body so named
// (namedAsCompacted); it also drops nulls, flattens arrays, and drops or renames what the vocabulary does not define,
// and the readers on each side read some shapes differently. Those differences
// are listed by form in the deviations page. The tables are built once from the preloaded contexts and
// MASTODON_CONTEXT_TERMS, with no JSON-LD processing; test/ld-signed-vocabulary.test.ts holds them to jsonld.js's
// processing of Mastodon's full_context and of each preloaded context. Kopje reads, from an activity, no name outside
// the vocabulary that Mastodon also reads (EmojiReact and EmojiReaction, which Kopje reads as a favourite, Mastodon
// reads in no form; test/inbox-signed-forms.test.ts).

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
// for its IRI as a type (FULL_TYPE_NAMES).
type Meaning = { iri: string | null; key: string; containers: readonly string[]; typeName: boolean };

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
  return {
    iri: typeof iri === "string" ? iri : null,
    key: JSON.stringify([iri, coercion, containers.toSorted((a, b) => a.localeCompare(b)), rest]),
    containers,
    typeName:
      containers.length === 0 &&
      (coercion === null || coercion === "@id") &&
      Object.keys(rest).every((key) => SELECTION_NEUTRAL.has(key)),
  };
}

// Each allowed context URL's meanings, its compact IRIs over its own prefixes or ActivityStreams'.
const URL_MEANINGS = new Map(
  [...URL_DEFINITIONS].map(([url, definitions]) => {
    const own = new Map<string, string>();
    applyPrefixes(definitions, own);
    const prefix = (name: string) => own.get(name) ?? AS_PREFIXES.get(name);
    const meanings = Object.entries(definitions).filter(([name]) => isName(name));
    return [url, new Map(meanings.map(([name, definition]) => [name, meaningOf(definition, prefix)]))];
  }),
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
// keywords included, so the rule does not hold a proof's keys and D5 renames no type in a body that has one
// (mastodonCompacts). Each value is visited once.
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
const JSONLD_BUDGET = 1_000;
const UNSUPPORTED_JSONLD_KEYWORDS = new Set(["@graph", "@included", "@reverse"]);
const SECURITY_V1 = "https://w3id.org/security/v1";
const LANGUAGE_TAG = /^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$/;
const HTTP_IRI = /^https?:\/\//;

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

export const FULL_CONTEXT_VALUES = jsonLdValues([
  ...MASTODON_NAMED_CONTEXTS.at(-1)!,
  Object.fromEntries(Object.entries(MASTODON_CONTEXT_TERMS).map(([name, definitions]) => [name, definitions.at(-1)])),
]);

function namesOf(url: string, test: (definition: unknown) => boolean): Set<string> {
  return new Set(Object.entries(definitionsOf(url)).flatMap(([name, definition]) => (test(definition) ? [name] : [])));
}

const typedId = (definition: unknown) => isObject(definition) && definition["@type"] === "@id";
const IRI_VALUED = new Set([...namesOf(AS, typedId), ...namesOf(SECURITY_V1, typedId)]);
const LANGUAGE_MAPS = namesOf(AS, (definition) => isObject(definition) && definition["@container"] === "@language");

function mastodonCompacts(json: Json, prefixes: Prefixes): boolean {
  const context = json["@context"];
  const received = jsonLdValues(json);
  if (
    received > JSONLD_BUDGET ||
    json.proof !== undefined ||
    !(Array.isArray(context) ? context : [context]).every((entry) => entry === AS || entry === SECURITY_V1)
  ) {
    return false;
  }
  const kept = jsonLdValues(json.signature);
  const body = received - 1 - jsonLdValues(context) - kept;
  if (1 + FULL_CONTEXT_VALUES + kept + 3 * body > JSONLD_BUDGET) {
    return false;
  }
  const iri = (value: unknown) =>
    typeof value === "string" && HTTP_IRI.test(expand(value, (prefix) => prefixes.get(prefix)) ?? "");
  const typeName = (value: unknown) =>
    iri(value) || (typeof value === "string" && isName(value) && value !== "id" && value !== "type");
  const node = Object.fromEntries(Object.entries(json).filter(([key]) => key !== "@context" && key !== "signature"));
  const pending: [string, unknown][] = [["", node]];
  while (pending.length > 0) {
    const [key, value] = pending.pop()!;
    if (Array.isArray(value)) {
      if (LANGUAGE_MAPS.has(key) || value.some(Array.isArray)) {
        return false;
      }
      pending.push(...value.map((item): [string, unknown] => [key, item]));
    } else if (LANGUAGE_MAPS.has(key)) {
      if (
        !isObject(value) ||
        !Object.entries(value).every(
          ([tag, member]) => LANGUAGE_TAG.test(tag) && (member === null || typeof member === "string"),
        )
      ) {
        return false;
      }
    } else if (isObject(value)) {
      if (
        (Object.hasOwn(value, "id") && !iri(value.id)) ||
        (Object.hasOwn(value, "type") && !(Array.isArray(value.type) ? value.type : [value.type]).every(typeName))
      ) {
        return false;
      }
      pending.push(...Object.entries(value).filter(([member]) => member !== "id" && member !== "type"));
    } else if (IRI_VALUED.has(key) && value !== null && !iri(value)) {
      return false;
    }
  }
  return true;
}

// What each name full_context defines means: Mastodon 4.7's named contexts and its extension object, in order.
const FULL_CONTEXT_MEANINGS = readContext([
  ...MASTODON_NAMED_CONTEXTS.at(-1)!,
  Object.fromEntries(Object.entries(MASTODON_CONTEXT_TERMS).map(([name, definitions]) => [name, definitions.at(-1)])),
])!.meanings;

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

// An LD-signed body with its names, as members and as types, read only where Mastodon's compaction under full_context
// writes them so, whatever D5 decides (ID-1). Mastodon's readers read a member by its name only where the compaction
// writes that name, and Kopje's readers, given this body, read one only there too; any other is renamed `_:name`, which
// neither reads:
//   - a member's name means the same in the body's contexts and in full_context, or is defined by neither (it expands
//     by ActivityStreams' @vocab "_:" to a blank node's IRI, which the compaction writes as the name again). One
//     full_context defines that the body leaves undefined (`QuoteRequest`, `Hashtag`, `Emoji`, `PropertyValue`,
//     `sensitive`, `quote`, `interactionPolicy`, … under the ActivityStreams and security contexts alone) the
//     compaction writes as `_:name`; one the body defines otherwise (another type or container, or a name full_context
//     leaves undefined), as its IRI. That last holds for the values a definition coerces; a value of another shape
//     (an object for a name typed @id, say) the compaction may still write under the name, and Kopje then reads less
//     than Mastodon;
//   - a type name is the one the compaction writes for the IRI the body's contexts give it (FULL_TYPE_NAMES), or is
//     defined by neither. A name aliasing a keyword is left as it is (no reader reads one as a type).
// Kept as they are: a language map's tags, the top-level @context, signature and proof. A body Kopje can show Mastodon
// reads as received (mastodonReadsAsReceived) is read as received; where Mastodon gives the compaction up otherwise, a
// name so renamed is read less than Mastodon reads it (docs/mastodon-deviations.md).
function namedAsCompacted(json: Json, meanings: ReadonlyMap<string, Meaning>): Json {
  const blank = (name: string) => `_:${name}`;
  const named = (name: string) =>
    meanings.get(name)?.key === FULL_CONTEXT_MEANINGS.get(name)?.key ? name : blank(name);
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
  const member = (key: string, value: unknown): unknown =>
    key === "type"
      ? Array.isArray(value)
        ? value.map(typed)
        : typed(value)
      : LANGUAGE_MAPS.has(key) && isObject(value)
        ? value
        : node(value);
  const members = (object: Json, kept?: ReadonlySet<string>): Json =>
    Object.fromEntries(
      Object.entries(object).map(([key, value]) => (kept?.has(key) ? [key, value] : [named(key), member(key, value)])),
    );
  const node = (value: unknown): unknown =>
    Array.isArray(value) ? value.map(node) : isObject(value) ? members(value) : value;
  return members(json, AS_RECEIVED);
}

const AS_RECEIVED: ReadonlySet<string> = new Set(["@context", "signature", "proof"]);

// The contexts a proof's own @context may name without the rules (1, 2) over it, as a body's may (SIGNED_CONTEXT_URLS).
const PROOF_CONTEXTS: ReadonlySet<string> = new Set([AS, ...SIGNED_CONTEXT_URLS.keys()]);

// Whether JSON-LD's expansion leaves anything of a value of a @graph container name (`proof` in the data-integrity
// contexts, typed @id), which the compaction then writes as a graph object, under a @graph key check_jsonld_limits!
// refuses. It leaves nothing of a null, an array of nothing, a value object whose @value is null (but a JSON
// literal's), a map of @language alone or a @set of nothing; anything else is a node, a value or a list (a scalar a
// node reference or a value). A proof's own @context it follows only where the rules (1, 2) accept it or it names
// contexts a body's may, so that no plain name there aliases a keyword but @id and @type. Where the expansion raises (a
// keyword given a value of the wrong shape) Mastodon reads the body as received too, which this does not show.
// test/inbox-signed-forms.test.ts holds the shapes to Mastodon's reading.
function expandsToSomething(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(expandsToSomething);
  }
  if (!isObject(value)) {
    return value !== null && value !== undefined;
  }
  const { "@context": context, ...object } = value;
  const urls = (Array.isArray(context) ? context : [context]).every(
    (url) => typeof url === "string" && PROOF_CONTEXTS.has(url),
  );
  if (context !== undefined && !urls && readContext(context) === null) {
    return false;
  }
  if (Object.hasOwn(object, "@value")) {
    return object["@value"] !== null || object["@type"] === "@json";
  }
  if (Object.hasOwn(object, "@list")) {
    return true;
  }
  if (Object.hasOwn(object, "@set")) {
    return expandsToSomething(object["@set"]);
  }
  const keys = Object.keys(object);
  return !(keys.length === 1 && keys[0] === "@language");
}

// Whether Mastodon reads an LD-signed body as received, as Kopje can show: its JSON-LD limits refuse it before the
// compaction (more than 1,000 values, or a @graph, @included or @reverse key; check_jsonld_limits!), or after it, for
// a proof its contexts make a @graph container of which the expansion leaves something (expandsToSomething). A proof
// elsewhere than at the top, or one the expansion refuses, is not shown: Kopje then reads the body as named.
function mastodonReadsAsReceived(json: Json, meanings: ReadonlyMap<string, Meaning>): boolean {
  const graph = meanings.get("proof")?.containers.includes("@graph") === true;
  return jsonLdValues(json) > JSONLD_BUDGET || (graph && expandsToSomething(json.proof));
}

// A type as Mastodon reads it in an LD-signed body of the shape whose compaction Kopje shows succeeds
// (mastodonCompacts): the compaction writes one given as a compact IRI over a prefix the body's context defines, or as
// an absolute IRI, as the vocabulary's name for that IRI, and the patch puts no type back. A name keeps the meaning
// the rules hold it to; any other type, and every type of a body outside that shape, is read as given.
export type TypeReader = (type: string) => string;

// Whether an LD-signed activity is read (its signature an object), and then how its types are read and its body as
// Mastodon's compaction names its members (namedAsCompacted): null when the rules refuse it. Run after
// withinJsonBounds, so the work is bounded by its values.
export function ldSignedReading(json: Json): { readType: TypeReader; body: Json } | null {
  const context = readContext(json["@context"]);
  if (context === null || !bodyKeysReadable(json)) {
    return null;
  }
  let compacts: boolean | undefined;
  const readType: TypeReader = (type) => {
    const iri = expand(type, (prefix) => context.prefixes.get(prefix));
    const name = iri === null ? undefined : TYPE_NAMES.get(iri);
    if (name === undefined) {
      return type;
    }
    compacts ??= mastodonCompacts(json, context.prefixes);
    return compacts ? name : type;
  };
  const asReceived = mastodonReadsAsReceived(json, context.meanings);
  return { readType, body: asReceived ? json : namedAsCompacted(json, context.meanings) };
}

export function ldSignedBodyReadable(json: Json): boolean {
  return ldSignedReading(json) !== null;
}
