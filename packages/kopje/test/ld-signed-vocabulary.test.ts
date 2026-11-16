import { preloadedContexts } from "@fedify/fedify";
import jsonld from "jsonld/dist/jsonld.esm.js";
import { describe, expect, it } from "vitest";

import {
  ACTIVITY_VOCABULARY,
  FULL_CONTEXT_VALUES,
  inlineDefinitionIris,
  ldSignedReading,
  SIGNED_CONTEXT_URLS,
} from "../src/federation/ld-signed-body";
import corpus from "./fixtures/ld-signed/corpus.json";
import forms from "./fixtures/ld-signed/forms.json";

// ldSignedBodyReadable's tables (src/federation/ld-signed-body.ts) are built without JSON-LD processing; here jsonld.js
// (the copy Fedify resolves) processes Mastodon 4.7.5's full_context and each preloaded context, and the tables must be
// what that processing gives (ID-1, docs/mastodon-deviations.md "Reading inbound activities").

type Json = Record<string, unknown>;
type ActiveContext = Awaited<ReturnType<typeof jsonld.processContext>>;

const AS = "https://www.w3.org/ns/activitystreams";
const MASTODON_PREFIXES = ["toot", "schema", "ostatus", "gts"];

const documentLoader = (url: string) => {
  if (!Object.hasOwn(preloadedContexts, url)) {
    return Promise.reject(new Error(`not preloaded: ${url}`));
  }
  return Promise.resolve({ contextUrl: null, document: preloadedContexts[url], documentUrl: url });
};
const options = { documentLoader };
const process = (active: ActiveContext, local: unknown) => jsonld.processContext(active, local, options);
const initial = () => jsonld.processContext({}, null, options);

// Mastodon 4.7.5's full_context, as its own compaction writes it (the corpus's readings).
const fullContext = (corpus as { reference: string; mastodon?: Json }[]).find((entry) => entry.mastodon)!.mastodon![
  "@context"
] as unknown[];

const isName = (key: string) => key !== "" && !key.startsWith("@") && !key.includes(":");

function definitions(url: string): Json {
  return (preloadedContexts[url] as { "@context": Json })["@context"];
}

const asNames = Object.keys(definitions(AS)).filter(isName);

// What a term definition means, without jsonld.js's bookkeeping (a protected flag included: protection changes no
// meaning, and redefining a protected term is an error, on which Mastodon reads the body as received).
type Definition = ActiveContext["mappings"] extends Map<string, infer D> ? D : never;
const meaning = (definition: Definition | undefined) =>
  JSON.stringify(
    definition === undefined || definition === null
      ? null
      : (["@id", "@type", "@container", "@language", "@direction", "@context", "reverse"] as const).map((key) =>
          key in definition ? (definition as Record<string, unknown>)[key] : undefined,
        ),
  );
const extension = fullContext.at(-1) as Json;

describe("ldSignedBodyReadable's tables", () => {
  it("full_context counts as many values against Mastodon's JSON-LD limit as its own compaction writes", () => {
    const values = (value: unknown): number =>
      1 +
      (Array.isArray(value)
        ? value.reduce<number>((sum, member) => sum + values(member), 0)
        : value !== null && typeof value === "object"
          ? Object.values(value).reduce<number>((sum, member) => sum + values(member), 0)
          : 0);
    expect(FULL_CONTEXT_VALUES).toBe(values(fullContext));
  });

  it("the vocabulary is jsonld.js's processing of Mastodon 4.7.5's full_context, restricted to its names", async () => {
    expect(fullContext.slice(0, -1)).toEqual([
      AS,
      "https://w3id.org/security/v1",
      "https://www.w3.org/ns/cid/v1",
      "https://purl.archive.org/socialweb/webfinger",
    ]);
    const active = await process(await initial(), fullContext);
    const names = [...asNames, ...Object.keys(extension).filter((name) => !MASTODON_PREFIXES.includes(name))];
    const computed = new Map(names.map((name) => [name, active.mappings.get(name)?.["@id"]]));
    expect(Object.fromEntries(ACTIVITY_VOCABULARY)).toEqual(Object.fromEntries(computed));
  });

  // Whether the preloaded context `url`, processed after ActivityStreams (or before it), keeps the vocabulary: every
  // ActivityStreams term as ActivityStreams defines it, every other name of the vocabulary with its IRI, every other
  // name it defines (its scoped contexts' included) an IRI outside the vocabulary's and no keyword, no base, and
  // ActivityStreams' @vocab. A processing error keeps it too: Mastodon then reads the body as received.
  async function keeps(url: string, after: boolean): Promise<boolean> {
    const vocabularyIris = new Set(ACTIVITY_VOCABULARY.values());
    const baseline = await process(await initial(), AS);
    let active: ActiveContext;
    try {
      active = after ? await process(baseline, url) : await process(await process(await initial(), url), AS);
    } catch {
      return true;
    }
    const kept = async (context: ActiveContext, depth: number): Promise<boolean> => {
      if (context["@vocab"] !== baseline["@vocab"] || context["@base"] !== baseline["@base"]) {
        return false;
      }
      for (const name of asNames) {
        if (meaning(context.mappings.get(name)) !== meaning(baseline.mappings.get(name))) {
          return false;
        }
      }
      for (const [name, definition] of context.mappings) {
        const iri = definition?.["@id"];
        const term = ACTIVITY_VOCABULARY.get(name);
        if (term !== undefined ? iri !== term : iri === undefined || iri.startsWith("@") || vocabularyIris.has(iri)) {
          return false;
        }
        if (definition?.["@context"] !== undefined && depth < 4) {
          let scoped: ActiveContext;
          try {
            scoped = await process(context, definition["@context"]);
          } catch {
            continue;
          }
          if (!(await kept(scoped, depth + 1))) {
            return false;
          }
        }
      }
      return true;
    };
    return kept(active, 0);
  }

  it("the allowed context URLs are the preloaded ones that keep the vocabulary, by position", async () => {
    const computed = new Map<string, "anywhere" | "before-activitystreams">();
    for (const url of Object.keys(preloadedContexts).filter((url) => url !== AS)) {
      const after = await keeps(url, true);
      const before = await keeps(url, false);
      if (after && before) {
        computed.set(url, "anywhere");
      } else if (before) {
        computed.set(url, "before-activitystreams");
      }
    }
    expect(Object.fromEntries(SIGNED_CONTEXT_URLS)).toEqual(Object.fromEntries(computed));
    // The two preloaded contexts left out.
    expect(Object.keys(preloadedContexts).filter((url) => url !== AS && !computed.has(url))).toEqual(
      expect.arrayContaining(["http://schema.org/", "https://join-lemmy.org/context.json"]),
    );
    expect(Object.keys(preloadedContexts).length - computed.size).toBe(3);
  });

  // A type given as an IRI of the vocabulary, absolute or over ActivityStreams' prefix: the name Kopje reads it as
  // (ldSignedReading) is the one jsonld.js's compaction under full_context writes, and any type it writes as an
  // IRI is read as given.
  it("reads a type given as a vocabulary IRI as jsonld.js's compaction under full_context names it", async () => {
    const context = [AS, "https://w3id.org/security/v1"];
    const { readType } = ldSignedReading({ "@context": context })!;
    const named: string[] = [];
    for (const iri of new Set(ACTIVITY_VOCABULARY.values())) {
      if (iri.startsWith("@")) {
        continue;
      }
      const given = iri.startsWith(`${AS}#`) ? [iri, `as:${iri.slice(AS.length + 1)}`] : [iri];
      for (const type of given) {
        const expanded = await jsonld.expand({ "@context": context, type }, options);
        const compacted = (await jsonld.compact(expanded, { "@context": fullContext }, options)).type as string;
        expect(readType(type), type).toBe(isName(compacted) ? compacted : type);
        if (isName(compacted)) {
          named.push(compacted);
        }
      }
    }
    expect(named).toEqual(expect.arrayContaining(["Follow", "Like", "Undo", "Reject", "Block", "Delete", "Note"]));
    expect(named).toContain("QuoteRequest");
  });

  // A name full_context defines that the body's contexts leave undefined, as a member or as a type, is read as the
  // blank node's name jsonld.js's compaction under full_context writes (`_:QuoteRequest`); a name they define, and one
  // full_context does not define, keep their own (ldSignedReading's body). Each such name, under the ActivityStreams
  // and security contexts alone and with full_context's extension object (which leaves the cid and webfinger
  // contexts' names undefined).
  it("names each member and type as jsonld.js's compaction under full_context names it", async () => {
    const base = new Set([AS, "https://w3id.org/security/v1"].flatMap((url) => Object.keys(definitions(url))));
    const names = [
      ...new Set(
        fullContext.flatMap((entry) => Object.keys(typeof entry === "string" ? definitions(entry) : (entry as Json))),
      ),
    ].filter((name) => isName(name) && !base.has(name));
    expect(names).toEqual(expect.arrayContaining(["QuoteRequest", "Hashtag", "Emoji", "PropertyValue", "sensitive"]));
    const tested = [...names, "quoteUrl", "kopjeUndefined"];
    const lists = fullContext.flatMap((entry) =>
      Object.entries(typeof entry === "string" ? definitions(entry) : (entry as Json)).flatMap(([name, definition]) =>
        names.includes(name) && (definition as Json | null)?.["@container"] === "@list" ? [name] : [],
      ),
    );
    expect(lists).toEqual(["focalPoint"]);
    let renamed = 0;
    for (const context of [
      [AS, "https://w3id.org/security/v1"],
      [AS, "https://w3id.org/security/v1", extension],
    ]) {
      const body = {
        "@context": context,
        id: "https://mastodon.example/users/bob/activities/1",
        type: "Create",
        actor: "https://mastodon.example/users/bob",
        object: {
          id: "https://mastodon.example/users/bob/statuses/1",
          // A language map's keys are tags, whatever names they spell.
          summaryMap: { value: "v", quote: "q", toot: "t" },
          // focalPoint is a list term: the compaction writes it by its name only for a list (its two numbers).
          ...Object.fromEntries(
            tested.map((name) => [name, name === "focalPoint" ? [0.5, -0.5] : "https://mastodon.example/value"]),
          ),
        },
        // A type named after a list term (focalPoint) the compaction writes as its IRI: no type Kopje reads is one.
        tag: tested.filter((name) => name !== "focalPoint").map((name) => ({ type: name })),
      };
      const compacted = (await jsonld.compact(
        await jsonld.expand(body, options),
        { "@context": fullContext },
        options,
      )) as Json;
      const read = ldSignedReading({ ...body, signature: { type: "RsaSignature2017" } })!.body;
      const keys = (json: Json) => Object.keys(json.object as Json).toSorted();
      const types = (json: Json) => (json.tag as Json[]).map((tag) => tag.type);
      expect(keys(read), JSON.stringify(context)).toEqual(keys(compacted));
      expect(types(read), JSON.stringify(context)).toEqual(types(compacted));
      expect((read.object as Json).summaryMap).toEqual((compacted.object as Json).summaryMap);
      renamed += types(read).filter((type) => String(type).startsWith("_:")).length;
    }
    // Each name full_context defines is renamed under the two contexts alone, and the cid and webfinger contexts'
    // names under the extension object too.
    expect(renamed).toBeGreaterThan(names.length);
  });

  // A name the body's contexts define otherwise than full_context, here each of its extension object's names but its
  // namespace prefixes and its list term (focalPoint) and those ActivityStreams defines (which the rules hold to it),
  // typed @id where full_context leaves it untyped and untyped where it types it @id: Kopje reads none of them. The
  // compaction writes none given a value the definition coerces to a literal (an IRI string, untyped), and so reads it
  // nowhere Kopje does not; given a node (an IRI string, typed @id, or an object with an id) it still writes the name,
  // where Kopje reads less than Mastodon. Types are read by their IRI, the same in both.
  it("reads no member its context defines otherwise, where jsonld.js's compaction may still write one", async () => {
    const base = new Set([AS, "https://w3id.org/security/v1"].flatMap((url) => Object.keys(definitions(url))));
    const flippable = Object.keys(extension).filter(
      (name) => isName(name) && !base.has(name) && !MASTODON_PREFIXES.includes(name) && name !== "focalPoint",
    );
    const flipped = Object.fromEntries(
      Object.entries(extension).map(([name, definition]) => {
        if (!flippable.includes(name)) {
          return [name, definition];
        }
        const { "@id": id, "@type": type } =
          typeof definition === "string" ? { "@id": definition } : (definition as Json);
        return [name, type === "@id" ? id : { "@id": id, "@type": "@id" }];
      }),
    );
    const typedId = flippable.filter((name) => typeof flipped[name] !== "string");
    expect(typedId).toEqual(expect.arrayContaining(["sensitive", "Hashtag", "votersCount", "conversation"]));
    expect(flippable.filter((name) => !typedId.includes(name))).toEqual(
      expect.arrayContaining(["quote", "quoteAuthorization", "interactionPolicy", "featured"]),
    );
    const context = [AS, "https://w3id.org/security/v1", flipped];
    for (const [value, written] of [
      ["https://mastodon.example/value", typedId],
      [{ id: "https://mastodon.example/value" }, flippable],
    ] as const) {
      const body = {
        "@context": context,
        id: "https://mastodon.example/users/bob/activities/1",
        type: "Create",
        actor: "https://mastodon.example/users/bob",
        object: {
          id: "https://mastodon.example/users/bob/statuses/1",
          ...Object.fromEntries(flippable.map((name) => [name, value])),
        },
        tag: flippable.map((name) => ({ type: name })),
      };
      const compacted = (await jsonld.compact(
        await jsonld.expand(body, options),
        { "@context": fullContext },
        options,
      )) as Json;
      const read = ldSignedReading({ ...body, signature: { type: "RsaSignature2017" } })!.body;
      const names = (json: Json) => Object.keys(json.object as Json).filter((name) => flippable.includes(name));
      const types = (json: Json) => (json.tag as Json[]).map((tag) => tag.type);
      expect(names(read)).toEqual([]);
      expect(names(compacted).toSorted()).toEqual([...written].toSorted());
      expect(types(read)).toEqual(types(compacted));
    }
  });

  it("the rule's IRI for every inline definition in the fixtures equals jsonld.js's", async () => {
    let checked = 0;
    const bodies = [...corpus, ...forms].flatMap((entry) => {
      const { received, mastodon } = entry as { received: Json; mastodon?: Json };
      return mastodon === undefined ? [received] : [received, mastodon];
    });
    for (const body of bodies) {
      const iris = inlineDefinitionIris(body["@context"]);
      if (iris === null) {
        continue;
      }
      const active = await process(await initial(), body["@context"]);
      for (const [name, iri] of iris) {
        expect(active.mappings.get(name)?.["@id"], name).toBe(iri);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1_000);
  });
});
