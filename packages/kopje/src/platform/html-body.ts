import { type BodyPrefix, readBodyPrefix } from "./body";
import { type Charset, chooseCharset } from "./html-charset";
import type { MediaType } from "./media-type";

// The read of a fetched HTML body that the web-page sink (federation/web-page.ts, NET-3) and search resolution's page
// (federation/loader.ts readPage) share: the Content-Encodings workerd decodes, the bounded read after its decoding,
// and the page's charset.

// The Content-Encoding values workerd decodes (exactly "gzip" or "br"; any other value it passes through undecoded,
// test/web-page-encoding.test.ts), and identity.
const DECODED_ENCODINGS = new Set(["identity", "gzip", "br"]);

// Whether workerd hands over `response`'s body decoded: no Content-Encoding, or one of DECODED_ENCODINGS.
export function decodedEncoding(response: Response): boolean {
  const encoding = response.headers.get("content-encoding");
  return encoding === null || DECODED_ENCODINGS.has(encoding);
}

export type HtmlBody = BodyPrefix & { charset: Charset };

// An HTML answer's body of the type `media`: "encoding" before any byte is read when workerd would not decode it (the
// body is then the caller's to cancel); otherwise its first `maxBytes` bytes after workerd's decoding, read through
// `guard` (readBodyPrefix, whose `limitReached` tells a longer body), with the charset chosen from its BOM, the
// Content-Type's charset parameter or a meta prescan (html-charset.ts chooseCharset).
export async function readHtmlBody(
  response: Response,
  media: MediaType,
  maxBytes: number,
  guard: <T>(read: Promise<T>) => Promise<T>,
): Promise<HtmlBody | "encoding"> {
  if (!decodedEncoding(response)) {
    return "encoding";
  }
  const prefix = await readBodyPrefix(response.body, maxBytes, guard);
  return { ...prefix, charset: chooseCharset(prefix.bytes, media.parameters.get("charset") ?? null) };
}
