import { preloadedContexts } from "@fedify/fedify";
import jsonld from "jsonld/dist/jsonld.esm.js";
import { describe, expect, it } from "vitest";

import { ACTIVITY_VOCABULARY, inlineDefinitionIris, SIGNED_CONTEXT_URLS } from "../src/federation/ld-signed-body";
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
