// jsonld ships no types: the functions Kopje calls, from the ESM build @fedify/vocab-runtime imports: expand for an
// LD-signed body's proof (ld-signed-body.ts) and the actor's term checks (test/federation.test.ts,
// test/actor-update.test.ts), canonize for the signature fixtures (test/author-proof-helpers.ts), processContext and
// compact for the vocabulary of LD-signed bodies (test/ld-signed-vocabulary.test.ts).
declare module "jsonld/dist/jsonld.esm.js" {
  type TermDefinition = { "@id"?: string; "@type"?: string; "@container"?: string[]; "@context"?: unknown };
  type ActiveContext = { "@base"?: unknown; "@vocab"?: unknown; mappings: Map<string, TermDefinition | null> };
  const jsonld: {
    canonize(
      input: unknown,
      options: { algorithm: "RDFC-1.0"; format: "application/n-quads"; documentLoader: unknown },
    ): Promise<string>;
    expand(input: unknown, options: { documentLoader: unknown }): Promise<Record<string, unknown>[]>;
    compact(input: unknown, context: unknown, options: { documentLoader: unknown }): Promise<Record<string, unknown>>;
    processContext(
      active: ActiveContext | object,
      local: unknown,
      options: { documentLoader: (url: string) => Promise<unknown> },
    ): Promise<ActiveContext>;
  };
  export default jsonld;
}
