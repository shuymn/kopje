// The part of jsonld that federation/author-proof.ts uses, through @fedify/vocab-runtime/jsonld (Fedify's own jsonld
// instance, whose declaration names this module; jsonld ships no types): expansion of a document whose contexts the
// loader serves.
declare module "jsonld" {
  type Loaded = { document: unknown; documentUrl: string; contextUrl: string | null };
  export function expand(
    input: unknown,
    options: { documentLoader: (url: string) => Promise<Loaded> },
  ): Promise<unknown[]>;
}
