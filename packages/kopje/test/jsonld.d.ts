// jsonld ships no types: the functions the tests call, from the ESM build @fedify/vocab-runtime imports: canonize for
// the signature fixtures (test/author-proof-helpers.ts), processContext for the vocabulary of LD-signed bodies
// (test/ld-signed-vocabulary.test.ts).
declare module "jsonld/dist/jsonld.esm.js" {
  type TermDefinition = { "@id"?: string; "@type"?: string; "@container"?: string[]; "@context"?: unknown };
  type ActiveContext = { "@base"?: unknown; "@vocab"?: unknown; mappings: Map<string, TermDefinition | null> };
  const jsonld: {
    canonize(
      input: unknown,
      options: { algorithm: "RDFC-1.0"; format: "application/n-quads"; documentLoader: unknown },
    ): Promise<string>;
    processContext(
      active: ActiveContext | object,
      local: unknown,
      options: { documentLoader: (url: string) => Promise<unknown> },
    ): Promise<ActiveContext>;
  };
  export default jsonld;
}
