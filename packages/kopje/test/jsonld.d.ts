// jsonld ships no types: the functions the signature fixtures (test/author-proof-helpers.ts) and the actor's term checks
// (test/federation.test.ts, test/actor-update.test.ts) call, from the ESM build @fedify/vocab-runtime imports.
declare module "jsonld/dist/jsonld.esm.js" {
  const jsonld: {
    canonize(
      input: unknown,
      options: { algorithm: "RDFC-1.0"; format: "application/n-quads"; documentLoader: unknown },
    ): Promise<string>;
    expand(input: unknown, options: { documentLoader: unknown }): Promise<Record<string, unknown>[]>;
  };
  export default jsonld;
}
