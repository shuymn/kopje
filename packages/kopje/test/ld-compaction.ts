import { preloadedContexts } from "@fedify/fedify";
import jsonld from "jsonld/dist/jsonld.esm.js";

// Mastodon 4.7.5's compaction of an LD-signed body as jsonld.js computes it, with Fedify's preloaded contexts and no
// fetch: JsonLdHelper#compact under full_context (the signature put back as received), patch_for_forwarding! and
// check_jsonld_limits! as JavaScript copies (json_ld_helper.rb). #1717's form 4 holds Kopje's reading to it.

type Json = Record<string, unknown>;

const PUBLIC_IRI = "https://www.w3.org/ns/activitystreams#Public";

const documentLoader = (url: string) =>
  Object.hasOwn(preloadedContexts, url)
    ? Promise.resolve({ contextUrl: null, document: preloadedContexts[url], documentUrl: url })
    : Promise.reject(new Error(`not preloaded: ${url}`));

const isMap = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

// The values check_jsonld_limits! counts (each object, array and scalar), or Infinity for a key it refuses.
export function jsonValues(value: unknown): number {
  let values = 0;
  const pending = [value];
  while (pending.length > 0) {
    const next = pending.pop();
    values++;
    if (Array.isArray(next)) {
      pending.push(...(next as unknown[]));
    } else if (isMap(next)) {
      if (["@graph", "@included", "@reverse"].some((key) => Object.hasOwn(next, key))) {
        return Infinity;
      }
      pending.push(...Object.values(next));
    }
  }
  return values;
}

// patch_for_forwarding!: each member of the body as received but @context and signature, an object into an object and
// an array element by element, stopping at the first array whose length the compaction changed.
function patch(received: Json, compacted: Json): void {
  for (const [key, value] of Object.entries(received)) {
    if (key === "@context" || key === "signature" || value === null || !Object.hasOwn(compacted, key)) {
      continue;
    }
    const written = compacted[key];
    if (isMap(value) && isMap(written)) {
      patch(value, written);
    } else if (Array.isArray(value)) {
      const items: unknown[] = Array.isArray(written) ? (written as unknown[]) : [written];
      if (items.length !== value.length) {
        return;
      }
      compacted[key] = (value as unknown[]).map((item, at) => {
        const given = items[at];
        if (isMap(item) && isMap(given)) {
          patch(item, given);
          return given;
        }
        return item === PUBLIC_IRI && given === "as:Public" ? item : given;
      });
    } else if (value === PUBLIC_IRI && written === "as:Public") {
      compacted[key] = value;
    }
  }
}

// The compaction under `fullContext` with the signature put back as received (JsonLdHelper#compact); undefined where
// jsonld.js refuses the body.
async function compacted(received: Json, fullContext: unknown): Promise<Json | undefined> {
  const { signature, ...unsigned } = received;
  const written = await jsonld.compact(unsigned, fullContext as never, { documentLoader }).catch(() => undefined);
  return written === undefined ? undefined : { ...(written as Json), signature };
}

// The compaction, patched; undefined where jsonld.js refuses the body.
export async function compactedAndPatched(received: Json, fullContext: unknown): Promise<Json | undefined> {
  const reading = await compacted(received, fullContext);
  if (reading !== undefined) {
    patch(received, reading);
  }
  return reading;
}

// Mastodon's reading (process_activity_service.rb:23-38, 71): the compaction where check_jsonld_limits! passes the
// body before it and the compaction after it, then patched; undefined where Mastodon reads the body as received.
export async function mastodonCompaction(received: Json, fullContext: unknown): Promise<Json | undefined> {
  if (jsonValues(received) > 1_000) {
    return undefined;
  }
  const reading = await compacted(received, fullContext);
  if (reading === undefined || jsonValues(reading) > 1_000) {
    return undefined;
  }
  patch(received, reading);
  return reading;
}
