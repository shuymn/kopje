import { decodeHTML, decodeHTMLAttribute } from "entities/decode";

// A bounded scan of a fetched HTML page (federation/web-page.ts, NET-3) for what Mastodon's link verification and link
// cards read: rel=me links, <link> elements, <meta> properties, the first <title>, the root's lang and JSON-LD scripts;
// and, as a collector of its own beside rel=me (scanAlternate), the alternate <link> search resolution follows
// (federation/resolve.ts), which refuses the contexts below and also <template> and <table> (ALTERNATE_CONTEXTS).
// It runs on workerd's HTMLRewriter (lol-html): a spec tokenizer with a tree-builder simulator that tracks namespaces,
// foreign content and integration points, streaming natively. Facts it rests on are pinned by
// test/html-rewriter-facts.test.ts: attribute values and text chunks come raw (references undecoded, CR kept), the
// first of duplicate attributes wins, an end tag handler runs for the end tag that closes the element, an ancestor's
// included, with that tag's name lowercased (never for an element the end of the input closes), onEndTag throws on a
// self-closing foreign element, a meta charset is not re-sniffed, an unsupported label fails construction, and a
// parsing ambiguity or the 3 MiB buffer limit fails the stream. Any failure is a failure of the whole scan: nothing
// partial is returned.
//
// Kopje follows lol-html where it differs from Mastodon's parser (Nokogiri's HTML5 parser, scripting off):
//   - lol-html parses <noscript> as raw text (scripting on), so markup a scripting-off parser puts in a comment can
//     surface as elements. An HTML <noscript> outside an SVG region opens a region whose raw text is kept up to
//     NOSCRIPT_CHARS; rel=me collection resumes at its </noscript> when plainNoscript accepts the text, where every
//     later <a> or <link> is an element for both parsers, in the same order (the scripting-off parser ends the
//     noscript at the same end tag, or ignores it with an ordinary element still open). Any other noscript latches:
//     no rel=me after it is collected (relMeAfterNoscript). Card metadata after a noscript may differ from Mastodon's.
//   - lol-html does not model the "in select" insertion mode, where a scripting-off parser ignores <a> and <link>
//     start tags, nor how <template> and end tags inside a select change it: no rel=me after the first <select> start
//     tag is collected (relMeAfterSelect).
//   - nor does it model <frameset>, which replaces the body (or makes later markup ignored), and it does not see one
//     inside a <noscript>: a page with "<frameset" anywhere in its bytes returns no rel=me (relMeWithFrameset).
//   - its foreign-content model differs from the spec's in places (an <svg> inside <math> enters SVG, where the spec
//     keeps MathML; a <template> or a stray end tag can leave it in HTML where the spec stays foreign). An SVG <svg>
//     outside a region opens one, and rel=me collection resumes when its end tag handler runs for "svg" and every
//     element started in it was an SVG element of PLAIN_SVG, or an SVG <title> or <desc> with no start tag in it closed
//     by its own end tag, and no comment in it began "[CDATA[" (inside an SVG <title> or <desc>, lol-html reads
//     <![CDATA[ as a comment ending at the first ">", where Nokogiri reads a CDATA section to "]]>"). PLAIN_SVG are
//     ordinary elements to the HTML tree builder too, should a </p> or </br> have left foreign content. Anything
//     else, a <math>, a self-closing <svg> or an <svg> closed by another element's end tag latches: no rel=me after it
//     is collected (relMeAfterForeign). A rel=me candidate inside an open region latches too.
//   - nor does it model table foster parenting, which moves a rel=me misplaced in a <table> before the table in the
//     tree's document order, so relMe's order can differ from Mastodon's after a <table> start tag
//     (relMeOrderAfterTable; its caller does not HEAD the first rel=me then).
//   - nor the insertion modes of <template> contents, where a scripting-off parser can drop an <a> or <link> (after
//     a <col>) or move it (after a <tr>): a <template> start tag, in any namespace, opens a region that ends when its
//     end tag handler runs for "template" (nested ones counted). A rel=me candidate inside one, or after a template
//     that ended otherwise, is refused and latches (relMeInTemplate), and so is any after a table-structure start tag
//     inside one (TABLE_IN_TEMPLATE, in any namespace), which switches the template's insertion mode to one where the
//     spec parser ignores or moves tags lol-html honors (<template><col><style></template>…, or an <svg> whose CDATA
//     section lol-html reads), or after an HTML raw-text, RCDATA or tokenizer-switching start tag inside one
//     (RAW_IN_TEMPLATE). A rel=me after a template of ordinary elements that ended is kept.
//   - only elements in the HTML namespace count; SVG and MathML elements are skipped, and HTML elements inside an
//     integration point are HTML; an integration point element itself (an SVG <title>, <desc> or <foreignObject>, a
//     MathML <mi>) is foreign, as in the spec. Where the foreign-content model differs (above), a foreign <title> can
//     be reported as HTML, so no <title> after the first <svg> or <math> start tag is taken, after a region that
//     resumed rel=me too.
//   - lol-html keeps a stack of open elements, and each start tag's attributes, within one shared 3 MiB budget: some
//     50,000 unclosed elements, or a start tag of tens of thousands of attributes, fail the scan (memory). The budget is
//     shared, so no attribute count is guaranteed to pass.
//   - a capture (title, JSON-LD) cut by the end of the input is dropped; a start tag cut by it is never emitted.
//   - a rel attribute past REL_CHARS decoded units is not tokenized: no rel=me at or after it is collected
//     (relMeAfterLongRel), so a later anchor never stands first where Mastodon would find an earlier one.

export type ScanLimits = {
  relMe: number;
  links: number;
  metas: number;
  jsonLd: number;
  // Raw UTF-16 code units of one JSON-LD script, kept undecoded.
  jsonLdChars: number;
  // Decoded UTF-16 code units of an href, a meta content or the title.
  valueChars: number;
  // Decoded UTF-16 code units of a meta property or name, or a link type.
  keyChars: number;
  relTokens: number;
  relTokenChars: number;
  langChars: number;
};

// The defaults, and the most a caller may ask for: limits passed to scanHtml only lower them.
export const SCAN_LIMITS: Readonly<ScanLimits> = Object.freeze({
  relMe: 32,
  links: 64,
  metas: 128,
  jsonLd: 4,
  jsonLdChars: 32_768,
  valueChars: 2048,
  keyChars: 128,
  relTokens: 16,
  relTokenChars: 64,
  langChars: 64,
});

// Raw UTF-16 code units of an attribute value or the title text read before decoding; past it the value is dropped
// whole. A character reference never decodes to more code units than it spans, so this bounds decoding work only.
export const RAW_VALUE_CHARS = 8192;
// Raw UTF-16 code units of a <noscript>'s text kept for its region check (plainNoscript); past it the region latches.
export const NOSCRIPT_CHARS = 4096;
// Decoded UTF-16 code units of a rel attribute tokenized whole for the token "me"; links[].rel keeps the first
// relTokens tokens of at most relTokenChars each.
export const REL_CHARS = 2048;

// The most UTF-16 code units a scan returns in its strings, from SCAN_LIMITS (test/html-scan.test.ts recomputes it):
// relMe 32 × 2,048 + links 64 × (2,048 + 128 + 16 × 64) + metas 128 × (128 + 128 + 2,048) + title 2,048 + lang 64 +
// jsonLd 4 × 32,768 = 698,432. At most 3 UTF-8 bytes and 6 JSON-escaped bytes per unit.
export function outputMaxUnits(limits: ScanLimits = SCAN_LIMITS): number {
  return (
    limits.relMe * limits.valueChars +
    limits.links * (limits.valueChars + limits.keyChars + limits.relTokens * limits.relTokenChars) +
    limits.metas * (2 * limits.keyChars + limits.valueChars) +
    limits.valueChars +
    limits.langChars +
    limits.jsonLd * limits.jsonLdChars
  );
}
export const OUTPUT_MAX_UNITS = outputMaxUnits();

export type PageLink = { rel: string[]; href: string | null; type: string | null };
export type PageMeta = { property: string | null; name: string | null; content: string | null };

export type PageScan = {
  // The first <html lang>, decoded.
  lang: string | null;
  // The first HTML <title> whose end tag was seen, before any <svg> or <math> start tag, decoded and untrimmed.
  title: string | null;
  // The href of each <a> or <link> whose rel has the token "me" among all its tokens, ASCII case-insensitively (as
  // Mastodon's NokogiriHandler.link_rel_include downcases both), in document order; null when it is missing or past its
  // cap, the slot kept.
  relMe: (string | null)[];
  // Whether a rel=me candidate was skipped for following (or standing in) a <noscript> or an <svg> outside the region
  // rules (header), a <select> or <math> start tag, or for being or following an <a> or <link> whose rel is past
  // REL_CHARS. A region that resumed and refused nothing leaves them false. relMeInTemplate: whether one stood inside
  // an open <template>, or followed a template that did not end with its own end tag.
  relMeAfterNoscript: boolean;
  relMeAfterSelect: boolean;
  relMeAfterForeign: boolean;
  relMeAfterLongRel: boolean;
  relMeInTemplate: boolean;
  // Whether the page has the bytes of a <frameset> start tag anywhere (a <noscript> included), which can replace the
  // body: then no rel=me is returned.
  relMeWithFrameset: boolean;
  // Whether a rel=me was collected after a <table> start tag (in any namespace): foster parenting can move a rel=me
  // misplaced in a table before the table in the tree's document order, so relMe's order may not be Mastodon's.
  relMeOrderAfterTable: boolean;
  // The regions that ended and let rel=me collection resume after them (templates: each ended by its own end tag).
  resumed: { svg: number; noscript: number; template: number };
  // Every <link>, rel tokens lowercased.
  links: PageLink[];
  // Every <meta> with a property or a name, both lowercased; first wins is the caller's rule.
  metas: PageMeta[];
  // The raw text of each completed <script type="application/ld+json"> (exact, case-sensitive), not decoded.
  jsonLd: string[];
  // What was not collected: candidates past a cap or in a refused context, and values past their bounds.
  dropped: { relMe: number; links: number; metas: number; jsonLd: number; values: number };
  // UTF-16 code units in the returned strings, at most OUTPUT_MAX_UNITS.
  outputUnits: number;
  // Element handler calls, and text chunks and comments seen, for the work bounds.
  work: { elements: number; textChunks: number };
};

export type ScanFailure = { failed: "ambiguity" | "memory" | "parser" };

const XHTML = "http://www.w3.org/1999/xhtml";
// The raw-text, RCDATA and tokenizer-switching elements, and the table-structure ones (in any namespace), that latch
// rel=me inside an open <template> (header).
const TABLE_IN_TEMPLATE = "col, colgroup, caption, table, tbody, thead, tfoot, tr, td, th";
const RAW_IN_TEMPLATE = "style, script, title, textarea, iframe, xmp, noembed, noframes, noscript, plaintext";
const SVG = "http://www.w3.org/2000/svg";
// The elements an SVG region may hold, as lol-html reports tagName (lowercased): ordinary elements to the HTML tree
// builder too, should a </p> or </br> have taken the region out of foreign content.
const PLAIN_SVG: ReadonlySet<string> = new Set([
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "defs",
  "use",
  "symbol",
  "lineargradient",
  "radialgradient",
  "stop",
  "clippath",
  "mask",
]);
const REL_SEPARATOR = /[\t\n\f\r ]+/;
// Labels lol-html does not decode natively (not ASCII-compatible): transcoded to UTF-8 first.
const TRANSCODED = new Set(["utf-16le", "utf-16be", "iso-2022-jp"]);

const asciiLower = (value: string) => value.replace(/[A-Z]+/g, (upper) => upper.toLowerCase());

// The tags a <noscript> region may hold (plainNoscript), as start or end tags, and those it may hold only as a start
// tag followed by text with no "<" and their own end tag.
const NOSCRIPT_TAGS: ReadonlySet<string> = new Set([
  "img",
  "br",
  "meta",
  "link",
  "a",
  "div",
  "p",
  "span",
  "b",
  "i",
  "em",
  "strong",
  "picture",
  "source",
]);
const NOSCRIPT_RAW_TAGS: ReadonlySet<string> = new Set(["iframe", "style"]);

// HTML whitespace, ASCII alphanumerics, the attribute name characters [A-Za-z0-9_:.-], and what an unquoted value
// may hold (anything but whitespace, quotes, "=", "<", ">" and "`"), by UTF-16 code unit; NaN past the end is none.
const isSpace = (c: number) => c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x20;
const isAlphanumeric = (c: number) => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
const isAttributeName = (c: number) => isAlphanumeric(c) || c === 0x5f || c === 0x3a || c === 0x2e || c === 0x2d;
const isUnquoted = (c: number) =>
  !Number.isNaN(c) && !isSpace(c) && c !== 0x22 && c !== 0x27 && c !== 0x3d && c !== 0x3c && c !== 0x3e && c !== 0x60;

// Whether a <noscript>'s raw text (as lol-html reads it, scripting on) holds only what a scripting-off parser reads as
// ordinary elements and text, so every later <a> or <link> is an element for both, in the same order (header): text
// with no "<"; start and end tags of NOSCRIPT_TAGS written plainly (an ASCII alphanumeric name; attributes as name,
// name=value, name="…" or name='…' after whitespace; an optional "/" before ">"; end tags as </name> with optional
// whitespace before ">"); a NOSCRIPT_RAW_TAGS start tag, text with no "<" and its own end tag; no NUL; and no <a> or
// <link> with a rel attribute holding "&" or the token "me" (Mastodon finds a rel=me inside a <noscript>, so resuming
// after one would put a later link first). Names and rel tokens compare ASCII case-insensitively. One linear pass.
function plainNoscript(text: string): boolean {
  if (text.includes("\0")) {
    return false;
  }
  const at = (i: number) => text.charCodeAt(i);
  const name = (from: number): number => {
    let i = from;
    while (isAlphanumeric(at(i))) {
      i++;
    }
    return i;
  };
  // The index past "</name" + whitespace + ">" at `from`, or -1.
  const endTag = (from: number, expected: ReadonlySet<string> | string): number => {
    if (at(from) !== 0x3c || at(from + 1) !== 0x2f) {
      return -1;
    }
    const end = name(from + 2);
    const tag = asciiLower(text.slice(from + 2, end));
    if (end === from + 2 || (typeof expected === "string" ? tag !== expected : !expected.has(tag))) {
      return -1;
    }
    let i = end;
    while (isSpace(at(i))) {
      i++;
    }
    return at(i) === 0x3e ? i + 1 : -1;
  };
  let i = 0;
  for (let lt = text.indexOf("<"); lt >= 0; lt = text.indexOf("<", i)) {
    if (at(lt + 1) === 0x2f) {
      i = endTag(lt, NOSCRIPT_TAGS);
      if (i < 0) {
        return false;
      }
      continue;
    }
    const nameEnd = name(lt + 1);
    const tag = asciiLower(text.slice(lt + 1, nameEnd));
    const raw = NOSCRIPT_RAW_TAGS.has(tag);
    if (nameEnd === lt + 1 || !(raw || NOSCRIPT_TAGS.has(tag))) {
      return false;
    }
    i = nameEnd;
    for (;;) {
      const spaced = isSpace(at(i));
      while (isSpace(at(i))) {
        i++;
      }
      if (at(i) === 0x3e || (at(i) === 0x2f && at(i + 1) === 0x3e)) {
        i += at(i) === 0x3e ? 1 : 2;
        break;
      }
      if (!spaced || !isAttributeName(at(i))) {
        return false;
      }
      const attributeStart = i;
      while (isAttributeName(at(i))) {
        i++;
      }
      const attribute = asciiLower(text.slice(attributeStart, i));
      let value = "";
      if (at(i) === 0x3d) {
        const quote = at(i + 1);
        if (quote === 0x22 || quote === 0x27) {
          const close = text.indexOf(text[i + 1] ?? "", i + 2);
          if (close < 0) {
            return false;
          }
          value = text.slice(i + 2, close);
          i = close + 1;
        } else {
          const valueStart = i + 1;
          i = valueStart;
          while (isUnquoted(at(i))) {
            i++;
          }
          if (i === valueStart) {
            return false;
          }
          value = text.slice(valueStart, i);
        }
      }
      if (
        (tag === "a" || tag === "link") &&
        attribute === "rel" &&
        (value.includes("&") || value.split(REL_SEPARATOR).some((token) => asciiLower(token) === "me"))
      ) {
        return false;
      }
    }
    if (raw) {
      const close = text.indexOf("<", i);
      i = close < 0 ? -1 : endTag(close, tag);
      if (i < 0) {
        return false;
      }
    }
  }
  return true;
}

// A raw attribute value or title text, normalized as the tokenizer would (CR and CRLF to LF, NUL to U+FFFD) and then
// decoded once. An encoded &#13; stays a CR.
function decodedWhole(raw: string, attribute: boolean): string {
  const normalized = raw.replace(/\r\n?/g, "\n").replaceAll("\0", "�");
  return attribute ? decodeHTMLAttribute(normalized) : decodeHTML(normalized);
}

// decodedWhole, or null past RAW_VALUE_CHARS raw or `cap` decoded units.
function decoded(raw: string | null, cap: number, attribute: boolean): string | null {
  if (raw === null || raw.length > RAW_VALUE_CHARS) {
    return null;
  }
  const value = decodedWhole(raw, attribute);
  return value.length > cap ? null : value;
}

function clamp(limits: Partial<ScanLimits> | undefined): ScanLimits {
  const out = { ...SCAN_LIMITS };
  for (const key of Object.keys(out) as (keyof ScanLimits)[]) {
    const given = limits?.[key];
    if (given !== undefined && Number.isFinite(given)) {
      out[key] = Math.max(0, Math.min(out[key], Math.floor(given)));
    }
  }
  return out;
}

const FRAMESET = [0x66, 0x72, 0x61, 0x6d, 0x65, 0x73, 0x65, 0x74];

// Whether "<frameset" (ASCII case-insensitive) occurs in the bytes the rewriter reads: in a tag, a comment, a script
// or a noscript alike. O(n).
function hasFrameset(bytes: Uint8Array): boolean {
  for (let at = bytes.indexOf(0x3c); at >= 0; at = bytes.indexOf(0x3c, at + 1)) {
    let i = 0;
    while (i < FRAMESET.length && ((bytes[at + 1 + i] ?? 0) | 0x20) === FRAMESET[i]) {
      i++;
    }
    if (i === FRAMESET.length) {
      return true;
    }
  }
  return false;
}

// The rewriter's input in SCAN_CHUNK pieces, each after a turn of the event loop, so a deadline timer can abort a scan
// between them: given whole, the input is scanned in one native step that nothing interrupts.
const SCAN_CHUNK = 64 * 1024;

// What is awaited between chunks: one turn of the event loop, or, through createScanner, a test's hold.
export type ScanPause = (chunk: number) => Promise<void>;
const nextTurn: ScanPause = () => new Promise((resolve) => setTimeout(resolve, 0));

function chunks(bytes: Uint8Array, signal: AbortSignal | undefined, pause: ScanPause): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offset > 0 && offset < bytes.byteLength) {
        await pause(offset / SCAN_CHUNK);
      }
      // Past an abort the drain has rejected already; the rest of the input is not read.
      if (signal?.aborted === true || offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(offset, offset + SCAN_CHUNK));
      offset += SCAN_CHUNK;
    },
  });
}

function failureOf(error: unknown): ScanFailure {
  const message = error instanceof Error ? error.message : String(error);
  if (/ambigu/i.test(message)) {
    return { failed: "ambiguity" };
  }
  return { failed: /memory/i.test(message) ? "memory" : "parser" };
}

export type Scanner = (
  input: Uint8Array,
  charset: { label: string; bomLength: number },
  limits?: Partial<ScanLimits>,
  signal?: AbortSignal,
) => Promise<PageScan | ScanFailure>;

// Scans `input` (the page's bytes from its BOM on) decoded as `charset.label`. The rewriter consumes all of it
// natively; every handler is synchronous, returns before reading attributes past a cap, reads at most 3 attributes
// and never iterates them. An abort of `signal` stops the drain and the collection, and the scan rejects with the
// signal's reason: a late or partial collection is never returned.
export const scanHtml: Scanner = (input, charset, limits, signal) =>
  scanPaced(input, charset, limits, signal, nextTurn);

// scanHtml with another pause between chunks: for tests that hold a scan mid-way (test/web-page.test.ts), never for
// a caller, which would lose the turns a deadline needs.
export function createScanner(pause: ScanPause): Scanner {
  return (input, charset, limits, signal) => scanPaced(input, charset, limits, signal, pause);
}

async function scanPaced(
  input: Uint8Array,
  charset: { label: string; bomLength: number },
  limits: Partial<ScanLimits> | undefined,
  signal: AbortSignal | undefined,
  pause: ScanPause,
): Promise<PageScan | ScanFailure> {
  signal?.throwIfAborted();
  const caps = clamp(limits);
  const maxUnits = outputMaxUnits(caps);
  const scan: PageScan = {
    lang: null,
    title: null,
    relMe: [],
    relMeAfterNoscript: false,
    relMeAfterSelect: false,
    relMeAfterForeign: false,
    relMeAfterLongRel: false,
    relMeInTemplate: false,
    relMeWithFrameset: false,
    relMeOrderAfterTable: false,
    resumed: { svg: 0, noscript: 0, template: 0 },
    links: [],
    metas: [],
    jsonLd: [],
    dropped: { relMe: 0, links: 0, metas: 0, jsonLd: 0, values: 0 },
    outputUnits: 0,
    work: { elements: 0, textChunks: 0 },
  };
  let afterNoscript = false;
  let afterSelect = false;
  // Latched for good by an <svg> outside the region rules, or a <math>.
  let afterForeign = false;
  // The open SVG region (header), and the SVG <title> or <desc> open in it: rel=me is collected again once its </svg>
  // ends it.
  let svgRegion: { inside: "title" | "desc" | null } | null = null;
  let titleAfterForeign = false;
  // The open <noscript> region (header): its raw text, kept up to NOSCRIPT_CHARS.
  let noscriptRegion: { raw: string } | null = null;
  let afterLongRel = false;
  let afterTable = false;
  // The <template> elements open (header), and whether a candidate inside one, or a template ended otherwise than by
  // its own end tag, refused rel=me for good.
  let templateDepth = 0;
  let afterTemplate = false;
  let langSeen = false;
  // The first HTML title: its raw text while open, then done.
  let title: { raw: string; overflow: boolean } | null = null;
  let titleDone = false;
  let script: { raw: string; overflow: boolean } | null = null;
  let broken = false;

  // Adds `units` to the output, or refuses when the total would pass the maximum (never, under the caps).
  const fits = (units: number): boolean => {
    if (scan.outputUnits + units > maxUnits) {
      return false;
    }
    scan.outputUnits += units;
    return true;
  };
  const value = (raw: string | null, cap: number, attribute = true): string | null => {
    const result = decoded(raw, cap, attribute);
    if (raw !== null && result === null) {
      scan.dropped.values++;
    }
    return result;
  };
  // The decoded rel's tokens: whether one is "me" (ASCII case-insensitive), and the first relTokens of at most
  // relTokenChars lowercased, for links[].rel. A rel past REL_CHARS is not tokenized: it refuses rel=me from here on.
  const relOf = (element: Element): { me: boolean; tokens: string[] } => {
    const raw = element.getAttribute("rel");
    const rel = value(raw, REL_CHARS);
    if (raw !== null && rel === null) {
      afterLongRel = true;
      scan.relMeAfterLongRel = true;
      scan.dropped.relMe++;
      return { me: false, tokens: [] };
    }
    let me = false;
    const tokens: string[] = [];
    for (const token of rel?.split(REL_SEPARATOR) ?? []) {
      const lower = asciiLower(token);
      me ||= lower === "me";
      if (token !== "" && token.length <= caps.relTokenChars && tokens.length < caps.relTokens) {
        tokens.push(lower);
      }
    }
    return { me, tokens };
  };
  // Whether a rel=me candidate here is refused for its context, noted when it is.
  // No candidate reaches here inside an open SVG or noscript region: "svg *" refuses every element in an SVG region
  // first, and a noscript's content is raw text.
  const refusedContext = (): boolean => {
    afterTemplate ||= templateDepth > 0;
    scan.relMeAfterNoscript ||= afterNoscript;
    scan.relMeAfterSelect ||= afterSelect;
    scan.relMeAfterForeign ||= afterForeign;
    scan.relMeAfterLongRel ||= afterLongRel;
    scan.relMeInTemplate ||= afterTemplate;
    return afterNoscript || afterSelect || afterForeign || afterLongRel || afterTemplate;
  };
  const addRelMe = (href: string | null) => {
    if (refusedContext() || scan.relMe.length >= caps.relMe) {
      scan.dropped.relMe++;
    } else {
      scan.relMeOrderAfterTable ||= afterTable;
      scan.relMe.push(href !== null && fits(href.length) ? href : null);
    }
  };
  function latchForeign() {
    afterForeign = true;
    svgRegion = null;
  }
  function latchNoscript() {
    afterNoscript = true;
    noscriptRegion = null;
  }
  // Every handler is wrapped: a throw would fail the stream with no reason given, so it marks the scan broken.
  const guarded = <T>(handler: (node: T) => void) => {
    return (node: T) => {
      if (broken || signal?.aborted) {
        return;
      }
      try {
        handler(node);
      } catch {
        broken = true;
      }
    };
  };
  const counted = (handler: (element: Element) => void) =>
    guarded<Element>((element) => {
      scan.work.elements++;
      if (element.namespaceURI === XHTML) {
        handler(element);
      }
    });

  const rewriter = new HTMLRewriter()
    .on("svg, math", {
      element: guarded<Element>((element) => {
        scan.work.elements++;
        titleAfterForeign = true;
        if (afterForeign) {
          return;
        }
        if (svgRegion !== null || element.tagName !== "svg" || element.namespaceURI !== SVG) {
          latchForeign();
          return;
        }
        const region: { inside: "title" | "desc" | null } = { inside: null };
        svgRegion = region;
        try {
          // Throws on <svg/>, which has no end tag.
          element.onEndTag(
            guarded((end) => {
              if (svgRegion !== region) {
                return;
              }
              if (end.name === "svg" && region.inside === null) {
                svgRegion = null;
                scan.resumed.svg++;
              } else {
                latchForeign();
              }
            }),
          );
        } catch {
          latchForeign();
        }
      }),
      // Inside an SVG <title> or <desc>, lol-html reads <![CDATA[ as a comment ending at the first ">", where Nokogiri
      // reads a CDATA section up to "]]>".
      comments: guarded<Comment>((comment) => {
        scan.work.textChunks++;
        if (svgRegion !== null && comment.text.startsWith("[CDATA[")) {
          latchForeign();
        }
      }),
    })
    .on("svg *", {
      element: guarded<Element>((element) => {
        scan.work.elements++;
        if (afterForeign) {
          return;
        }
        const region = svgRegion;
        // A start tag inside a <title> or <desc> is refused before the element list. Redundant on this runtime (one
        // there is XHTML, or an <svg> or <math> the region opener refuses), kept as the rule's own statement (A3).
        if (region === null || region.inside !== null || element.namespaceURI !== SVG) {
          latchForeign();
          return;
        }
        const name = element.tagName;
        if (name !== "title" && name !== "desc") {
          if (!PLAIN_SVG.has(name)) {
            latchForeign();
          }
          return;
        }
        region.inside = name;
        try {
          // Throws on <title/> or <desc/>.
          element.onEndTag(
            guarded((end) => {
              if (svgRegion !== region) {
                return;
              }
              if (end.name === name) {
                region.inside = null;
              } else {
                latchForeign();
              }
            }),
          );
        } catch {
          latchForeign();
        }
      }),
    })
    .on("noscript", {
      element: guarded<Element>((element) => {
        scan.work.elements++;
        if (afterNoscript) {
          return;
        }
        if (noscriptRegion !== null || svgRegion !== null || element.namespaceURI !== XHTML) {
          latchNoscript();
          return;
        }
        const region = { raw: "" };
        noscriptRegion = region;
        try {
          element.onEndTag(
            guarded((end) => {
              if (noscriptRegion !== region) {
                return;
              }
              if (end.name === "noscript" && plainNoscript(region.raw)) {
                noscriptRegion = null;
                scan.resumed.noscript++;
              } else {
                latchNoscript();
              }
            }),
          );
        } catch {
          latchNoscript();
        }
      }),
      text: guarded<Text>((chunk) => {
        scan.work.textChunks++;
        const region = noscriptRegion;
        if (region === null) {
          return;
        }
        if (region.raw.length + chunk.text.length > NOSCRIPT_CHARS) {
          latchNoscript();
        } else {
          region.raw += chunk.text;
        }
      }),
    })
    .on("template", {
      // In any namespace. Template contents follow their own insertion modes (a <col> or <tr> context drops or moves
      // an <a> or <link>), which lol-html does not model.
      element: guarded<Element>((element) => {
        scan.work.elements++;
        if (afterTemplate) {
          return;
        }
        templateDepth++;
        try {
          element.onEndTag(
            guarded((end) => {
              if (end.name === "template" && !afterTemplate) {
                templateDepth--;
                scan.resumed.template++;
              } else {
                afterTemplate = true;
              }
            }),
          );
        } catch {
          afterTemplate = true;
        }
      }),
    })
    .on(TABLE_IN_TEMPLATE, {
      // In an open template, a table-structure start tag switches the template's insertion mode (column group, table,
      // table body, row, cell), which lol-html does not model: later tags are ignored or honored differently.
      element: guarded<Element>(() => {
        scan.work.elements++;
        if (templateDepth > 0) {
          afterTemplate = true;
        }
      }),
    })
    .on(RAW_IN_TEMPLATE, {
      // In an open template, an HTML raw-text, RCDATA or tokenizer-switching element that a template's insertion mode
      // can ignore (a <style> after a <col>) makes lol-html and the spec parser end the template at different tags.
      element: guarded<Element>((element) => {
        scan.work.elements++;
        if (templateDepth > 0 && element.namespaceURI === XHTML) {
          afterTemplate = true;
        }
      }),
    })
    .on("table", {
      // In any namespace: the flag only gives up the order.
      element: guarded<Element>(() => {
        scan.work.elements++;
        afterTable = true;
      }),
    })
    .on("select", {
      // In any namespace: a refusal only misses.
      element: guarded<Element>(() => {
        scan.work.elements++;
        afterSelect = true;
      }),
    })
    .on("a[rel]", {
      element: counted((element) => {
        if (scan.relMe.length >= caps.relMe) {
          // Whether it is rel=me is not read past the cap: counted as a candidate.
          scan.dropped.relMe++;
          return;
        }
        if (relOf(element).me) {
          addRelMe(value(element.getAttribute("href"), caps.valueChars));
        }
      }),
    })
    .on("link", {
      element: counted((element) => {
        const relMeFull = scan.relMe.length >= caps.relMe;
        const linksFull = scan.links.length >= caps.links;
        if (linksFull) {
          scan.dropped.links++;
        }
        if (linksFull && relMeFull) {
          return;
        }
        const { me, tokens: rel } = relOf(element);
        const href = value(element.getAttribute("href"), caps.valueChars);
        if (me) {
          addRelMe(href);
        }
        if (linksFull) {
          return;
        }
        const type = value(element.getAttribute("type"), caps.keyChars);
        const units = rel.reduce((sum, token) => sum + token.length, 0) + (href?.length ?? 0) + (type?.length ?? 0);
        if (fits(units)) {
          scan.links.push({ rel, href, type });
        } else {
          scan.dropped.links++;
        }
      }),
    })
    .on("meta", {
      element: counted((element) => {
        if (scan.metas.length >= caps.metas) {
          scan.dropped.metas++;
          return;
        }
        const rawProperty = element.getAttribute("property");
        const rawName = element.getAttribute("name");
        if (rawProperty === null && rawName === null) {
          return;
        }
        const property = value(rawProperty, caps.keyChars);
        const name = value(rawName, caps.keyChars);
        const content = value(element.getAttribute("content"), caps.valueChars);
        const entry = {
          property: property === null ? null : asciiLower(property),
          name: name === null ? null : asciiLower(name),
          content,
        };
        if (fits((property?.length ?? 0) + (name?.length ?? 0) + (content?.length ?? 0))) {
          scan.metas.push(entry);
        } else {
          scan.dropped.metas++;
        }
      }),
    })
    .on("html[lang]", {
      element: counted((element) => {
        if (langSeen) {
          return;
        }
        langSeen = true;
        const lang = value(element.getAttribute("lang"), caps.langChars);
        if (lang !== null && fits(lang.length)) {
          scan.lang = lang;
        }
      }),
    })
    .on("title", {
      element: counted((element) => {
        if (titleDone || title !== null || titleAfterForeign) {
          return;
        }
        const open = { raw: "", overflow: false };
        title = open;
        element.onEndTag(
          guarded(() => {
            titleDone = true;
            title = null;
            const text = open.overflow ? null : decoded(open.raw, caps.valueChars, false);
            if (text === null || !fits(text.length)) {
              scan.dropped.values++;
            } else {
              scan.title = text;
            }
          }),
        );
      }),
      text: guarded<Text>((chunk) => {
        scan.work.textChunks++;
        const open = title;
        if (open === null || open.overflow) {
          return;
        }
        if (open.raw.length + chunk.text.length > RAW_VALUE_CHARS) {
          open.overflow = true;
          open.raw = "";
        } else {
          open.raw += chunk.text;
        }
      }),
    })
    .on("script", {
      element: counted((element) => {
        if (decoded(element.getAttribute("type"), caps.keyChars, true) !== "application/ld+json") {
          return;
        }
        if (scan.jsonLd.length >= caps.jsonLd) {
          scan.dropped.jsonLd++;
          return;
        }
        const open = { raw: "", overflow: false };
        script = open;
        element.onEndTag(
          guarded(() => {
            script = null;
            if (open.overflow || scan.jsonLd.length >= caps.jsonLd || !fits(open.raw.length)) {
              scan.dropped.jsonLd++;
            } else {
              scan.jsonLd.push(open.raw);
            }
          }),
        );
      }),
      text: guarded<Text>((chunk) => {
        scan.work.textChunks++;
        const open = script;
        if (open === null || open.overflow) {
          return;
        }
        if (open.raw.length + chunk.text.length > caps.jsonLdChars) {
          open.overflow = true;
          open.raw = "";
        } else {
          open.raw += chunk.text;
        }
      }),
    });

  const bytes = await pump(rewriter, input, charset, signal, pause);
  if ("failed" in bytes) {
    return bytes;
  }
  if (broken) {
    return { failed: "parser" };
  }
  if (hasFrameset(bytes)) {
    scan.relMeWithFrameset = true;
    scan.dropped.relMe += scan.relMe.length;
    scan.outputUnits -= scan.relMe.reduce((sum, href) => sum + (href?.length ?? 0), 0);
    scan.relMe = [];
  }
  return scan;
}

// Runs `rewriter` over `input` (from its BOM on) decoded as `charset.label`, in SCAN_CHUNK pieces: the bytes it read
// (transcoded to UTF-8 for a label lol-html does not decode natively), or the scan's failure. An abort of `signal`
// rejects with its reason.
async function pump(
  rewriter: HTMLRewriter,
  input: Uint8Array,
  charset: { label: string; bomLength: number },
  signal: AbortSignal | undefined,
  pause: ScanPause,
): Promise<Uint8Array | ScanFailure> {
  const body = input.subarray(charset.bomLength);
  const native = !TRANSCODED.has(charset.label);
  const bytes = native ? body : new TextEncoder().encode(new TextDecoder(charset.label).decode(body));
  let transformed: Response;
  try {
    // An unsupported label fails here, synchronously, before any pumping.
    transformed = rewriter.transform(
      new Response(chunks(bytes, signal, pause), {
        headers: { "content-type": `text/html; charset=${native ? charset.label : "utf-8"}` },
      }),
    );
  } catch {
    return { failed: "parser" };
  }
  try {
    await transformed.body?.pipeTo(new WritableStream(), signal === undefined ? {} : { signal });
  } catch (error) {
    signal?.throwIfAborted();
    return failureOf(error);
  }
  signal?.throwIfAborted();
  return bytes;
}

// The start tags after which no alternate is taken (scanAlternate), and why: lol-html reads <noscript> as raw text
// (a scripting-off parser makes elements of a head <noscript>'s <link>), does not model "in select" (which ignores a
// <link>), <template> (whose content //link may or may not reach), table foster parenting (which moves a <link>
// misplaced in a table before the table, so <table><tr><td><link A></td></tr><b><link B></b></table> streams A, B
// where the tree's document order is B, A) or every foreign-content rule (an <svg> or <math> <link> is no HTML link).
const ALTERNATE_CONTEXTS = ["noscript", "select", "template", "table", "svg", "math"] as const;

// What ended an alternate search before a match: one of the start tags above, a <link> rel past RAW_VALUE_CHARS raw
// or REL_CHARS decoded units, or the page's <frameset> bytes.
type AlternateRefusal = (typeof ALTERNATE_CONTEXTS)[number] | "long-rel" | "frameset";

// The page's alternate link for search resolution (federation/resolve.ts), as Mastodon's
// FetchResourceService#process_html selects it (v4.7.5): the first <link> in document order whose rel holds the token
// "alternate" among all its tokens (split on ASCII whitespace, ASCII-lowercased, as NokogiriHandler.link_rel_include
// downcases them; the rel decoded up to REL_CHARS units) and whose decoded type equals one of `types` exactly (case and
// whitespace kept). `link` is that match, its href decoded (null when it has none or one past RAW_VALUE_CHARS raw or
// SCAN_LIMITS.valueChars decoded units, however short it decodes), or null. Only an element in the HTML namespace counts, and the first of duplicate attributes wins, as in an HTML5
// tree. Where lol-html cannot place a <link> as Nokogiri's HTML5 tree does (scripting off), in presence or in order,
// nothing is taken and `refused` names why: at or after the first ALTERNATE_CONTEXTS start tag (in any namespace), at
// or after a <link> whose rel is past RAW_VALUE_CHARS raw or REL_CHARS decoded units, and on a page with <frameset> bytes; so Kopje may resolve nothing
// where Mastodon resolves, never a different link. A match before any of them is taken. No link-count cap: the
// caller's 1 MiB body and the rewriter's 3 MiB budget bound the scan, which fails whole as scanHtml does.
export type AlternateScan = { link: { href: string | null } | null; refused: AlternateRefusal | null };

export async function scanAlternate(
  input: Uint8Array,
  charset: { label: string; bomLength: number },
  types: readonly string[],
  signal?: AbortSignal,
): Promise<AlternateScan | ScanFailure> {
  signal?.throwIfAborted();
  let link: AlternateScan["link"] = null;
  let refused: AlternateRefusal | null = null;
  let broken = false;
  const handler = (handle: (element: Element) => void) => (element: Element) => {
    if (broken || signal?.aborted || link !== null || refused !== null) {
      return;
    }
    try {
      handle(element);
    } catch {
      broken = true;
    }
  };
  const rewriter = new HTMLRewriter();
  for (const context of ALTERNATE_CONTEXTS) {
    rewriter.on(context, { element: handler(() => (refused = context)) });
  }
  rewriter.on("link", {
    element: handler((element) => {
      if (element.namespaceURI !== XHTML) {
        return;
      }
      const raw = element.getAttribute("rel");
      const rel = decoded(raw, REL_CHARS, true);
      if (raw !== null && rel === null) {
        refused = "long-rel";
        return;
      }
      const type = element.getAttribute("type");
      if (
        rel?.split(REL_SEPARATOR).some((token) => asciiLower(token) === "alternate") === true &&
        type !== null &&
        // Decoded whole, whatever its length: a reference never decodes to more units than it spans, but a long raw
        // value (leading zeros in a numeric reference) can decode to one of `types`.
        types.includes(decodedWhole(type, true))
      ) {
        link = { href: decoded(element.getAttribute("href"), SCAN_LIMITS.valueChars, true) };
      }
    }),
  });
  const bytes = await pump(rewriter, input, charset, signal, nextTurn);
  if ("failed" in bytes) {
    return bytes;
  }
  if (broken) {
    return { failed: "parser" };
  }
  return hasFrameset(bytes) ? { link: null, refused: "frameset" } : { link, refused };
}
