// jsonld ships no types: the functions Kopje calls, from the ESM build @fedify/vocab-runtime imports (the same copy):
// compact, which reads an LD-signed activity as Mastodon does (ld-compaction.ts), and canonize, which the signature
// fixtures call (test/author-proof-helpers.ts).
declare module "jsonld/dist/jsonld.esm.js" {
  const jsonld: {
    compact(input: unknown, context: unknown, options: { documentLoader: unknown }): Promise<Record<string, unknown>>;
    canonize(
      input: unknown,
      options: { algorithm: "RDFC-1.0"; format: "application/n-quads"; documentLoader: unknown },
    ): Promise<string>;
  };
  export default jsonld;
}
