// jsonld ships no types: the one function the signature fixtures call (test/author-proof-helpers.ts), from the ESM build
// @fedify/vocab-runtime imports.
declare module "jsonld/dist/jsonld.esm.js" {
  const jsonld: {
    canonize(
      input: unknown,
      options: { algorithm: "RDFC-1.0"; format: "application/n-quads"; documentLoader: unknown },
    ): Promise<string>;
  };
  export default jsonld;
}
