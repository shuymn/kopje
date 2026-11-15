import { type DefaultTreeAdapterMap, html, parseFragment } from "parse5";
import { describe, expect, it } from "vitest";

import { REMOTE_FIELDS_BYTES } from "../src/domain/account-columns";
import { BIO_JSON_BYTES, CONTENT_JSON_BYTES } from "../src/platform/stored-bounds";
import {
  jsonStringBytes,
  REMOTE_BIO_BYTES,
  REMOTE_HTML_RAW_LIMIT,
  remoteHtmlText,
  remotePlainText,
  sanitizeDocumentHtml,
  sanitizeRemoteContent,
  sanitizeRemoteHtml,
  sanitizeStoredHtml,
  STATUS_CONTENT_BYTES,
  STORED_HTML_LIMIT,
} from "../src/security/html";
import { DOMPURIFY_VECTORS } from "./fixtures/html.vectors.dompurify";
import { HTML5SEC_VECTORS } from "./fixtures/html.vectors.html5sec";
import { OWASP_VECTORS } from "./fixtures/html.vectors.owasp";
import { SANITIZE_HTML_VECTORS } from "./fixtures/html.vectors.sanitize-html";

// HTML-1: remote HTML is sanitized by allowlist. The vector suites are the ones in test/fixtures (each file
// keeps its source's license); the oracle is parse5, the spec HTML parser, reading the output as a browser would
// inside the <div> a client renders it in. The allowlist is Mastodon's MASTODON_STRICT, with http(s) links only
// (HTML-3) and the rel and target every link gets, and lang on every element (`:all => %w(lang)`).

type ChildNode = DefaultTreeAdapterMap["childNode"];
type ParentNode = DefaultTreeAdapterMap["parentNode"];
type Element = DefaultTreeAdapterMap["element"];

const STRICT: [string, string[]][] = [
  ["a", ["href", "class", "translate", "rel", "target"]],
  ["b", []],
  ["blockquote", []],
  ["br", []],
  ["code", []],
  ["del", []],
  ["em", []],
  ["i", []],
  ["li", ["value"]],
  ["ol", ["start", "reversed"]],
  ["p", ["class"]],
  ["pre", []],
  ["rp", []],
  ["rt", []],
  ["ruby", []],
  ["s", []],
  ["span", ["class", "translate"]],
  ["strong", []],
  ["u", []],
  ["ul", []],
];
const ALLOWED = new Map<string, readonly string[]>(STRICT.map(([tag, attributes]) => [tag, [...attributes, "lang"]]));

const DIV = parseFragment("<div></div>").childNodes[0] as Element;

// Iterative: the worst cases nest deeper than the call stack.
function elements(root: ParentNode | ChildNode): Element[] {
  const found: Element[] = [];
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if ("tagName" in node) {
      found.push(node);
    }
    if ("childNodes" in node) {
      pending.push(...node.childNodes);
    }
    if ("content" in node) {
      pending.push(node.content);
    }
  }
  return found;
}

// The operator's documents keep their headings, with no attributes, lang included (sanitizeDocumentHtml).
const DOCUMENT_ALLOWED = new Map<string, readonly string[]>([...ALLOWED, ["h2", []], ["h3", []], ["h4", []]]);

// Why the markup is not safe as a browser parses it, or an empty list.
function unsafeParts(markup: string, allowlist = ALLOWED): string[] {
  const problems: string[] = [];
  for (const element of elements(parseFragment(DIV, markup, {}))) {
    const name = element.tagName;
    if (element.namespaceURI !== html.NS.HTML) {
      problems.push(`<${name}> in namespace ${element.namespaceURI}`);
    }
    const allowed = allowlist.get(name);
    if (allowed === undefined) {
      problems.push(`<${name}>`);
    }
    for (const { name: attribute, value } of element.attrs) {
      if (!(allowed ?? []).includes(attribute)) {
        problems.push(`${name}@${attribute}`);
      }
      if (attribute === "href") {
        let protocol: string | null = null;
        try {
          protocol = new URL(value).protocol;
        } catch {
          // not an absolute URL
        }
        if (protocol !== "http:" && protocol !== "https:") {
          problems.push(`href ${JSON.stringify(value)}`);
        }
      }
      if (
        attribute === "class" &&
        !value.split(" ").every((c) => /^((h|p|u|dt|e)-.|mention$|hashtag$|ellipsis$|invisible$|quote-inline$)/.test(c))
      ) {
        problems.push(`class ${JSON.stringify(value)}`);
      }
    }
  }
  return problems;
}

const SUITES = [
  ["DOMPurify", DOMPURIFY_VECTORS],
  ["OWASP XSS Filter Evasion Cheat Sheet", OWASP_VECTORS],
  ["html5sec.org", HTML5SEC_VECTORS],
  ["sanitize-html", SANITIZE_HTML_VECTORS],
] as const;

describe("the oracle", () => {
  it("flags unsafe markup", () => {
    expect(unsafeParts('<p>x <a href="https://a.example" rel="nofollow noopener" target="_blank">y</a></p>')).toEqual(
      [],
    );
    expect(unsafeParts("<img src=x onerror=alert(1)>")).not.toEqual([]);
    expect(unsafeParts('<a href="jav&#x61;script:alert(1)">x</a>')).not.toEqual([]);
    expect(unsafeParts('<p title="x">x</p>')).not.toEqual([]);
    expect(unsafeParts("<p><svg><p>x</p></svg></p>")).not.toEqual([]);
    expect(unsafeParts('<span class="evil">x</span>')).not.toEqual([]);
  });
});

describe.each(SUITES)("HTML-1: XSS vectors from %s", (_, vectors) => {
  it.each(vectors)("%s", (_, payload) => {
    const sanitized = sanitizeRemoteHtml(payload);
    expect(unsafeParts(sanitized), sanitized).toEqual([]);
    expect(sanitizeRemoteHtml(sanitized), "sanitizing again changes the output").toBe(sanitized);
    // An operator's document, through its own allowlist (the same, with headings).
    const document = sanitizeDocumentHtml(payload);
    expect(unsafeParts(document, DOCUMENT_ALLOWED), document).toEqual([]);
    expect(sanitizeDocumentHtml(document), "sanitizing again changes the output").toBe(document);
  });
});

describe("HTML-1: an operator’s document", () => {
  it("keeps headings as h2 to h4, without attributes, under the page’s own h1", () => {
    expect(
      sanitizeDocumentHtml(
        '<h1 id="a" onclick="x()">One</h1><h2 class="h-x">Two</h2><h3>Three</h3><h4>Four</h4><h5>Five</h5><h6>Six</h6>',
      ),
    ).toBe("<h2>One</h2><h2>Two</h2><h3>Three</h3><h4>Four</h4><h4>Five</h4><h4>Six</h4>");
    // Everything else is the remote allowlist's.
    expect(sanitizeDocumentHtml('<p>a <a href="javascript:x">b</a><img src=x></p>')).toBe(
      sanitizeRemoteHtml('<p>a <a href="javascript:x">b</a><img src=x></p>'),
    );
    // Federated HTML still turns them into strong paragraphs.
    expect(sanitizeRemoteHtml("<h2>Two</h2>")).toBe("<p><strong>Two</strong></p>");
  });

  it("keeps lang on its other elements and none on its headings", () => {
    const input = '<h1 lang="ja">One</h1><h3 lang="en">Three</h3><p lang="fr">a<span lang="de">b</span></p>';
    const document = sanitizeDocumentHtml(input);
    expect(document).toBe('<h2>One</h2><h3>Three</h3><p lang="fr">a<span lang="de">b</span></p>');
    expect(unsafeParts(document, DOCUMENT_ALLOWED)).toEqual([]);
  });
});

describe("HTML-1: Mastodon’s MASTODON_STRICT", () => {
  it.each([
    [
      "keeps the allowlisted tags",
      "<p>a<br>b <b>c</b> <i>d</i> <u>e</u> <s>f</s> <del>g</del> <code>h</code></p><pre>i</pre><blockquote>j</blockquote>",
    ],
    ["keeps lists and their attributes", '<ol start="3" reversed><li value="5">x</li></ol><ul><li>y</li></ul>'],
    ["keeps ruby", "<ruby>漢<rp>(</rp><rt>かん</rt><rp>)</rp></ruby>"],
  ])("%s", (_, input) => {
    expect(sanitizeRemoteHtml(input)).toBe(input);
  });

  it.each([
    [
      "filters classes to microformats and the semantic ones",
      '<span class="h-card evil mention">x</span><p class="ellipsis bad">y</p>',
      '<span class="h-card mention">x</span><p class="ellipsis">y</p>',
    ],
    [
      "keeps a quote fallback’s quote-inline class, as Mastodon does",
      '<p class="quote-inline quote-inline-x">RE: <a href="https://a.example/1">https://a.example/1</a></p>',
      '<p class="quote-inline">RE: <a href="https://a.example/1" rel="nofollow noopener" target="_blank">https://a.example/1</a></p>',
    ],
    [
      "adds rel and target to links and drops other link attributes",
      '<a href="https://a.example/?x=1&amp;y=2" rel="me" target="_self" title="t" translate="no">a</a>',
      '<a href="https://a.example/?x=1&amp;y=2" translate="no" rel="nofollow noopener" target="_blank">a</a>',
    ],
    ['keeps translate only as "no"', '<span translate="yes">x</span>', "<span>x</span>"],
    ["turns headings into strong paragraphs", "<h1>Title</h1>", "<p><strong>Title</strong></p>"],
    ["unwraps unknown tags and keeps their text", "<div><article>text</article></div>", "text"],
    [
      "drops script, style, svg and math with their content",
      "<script>a</script><style>b</style><svg><p>c</p></svg><math>d</math>e",
      "e",
    ],
    ["removes comments", "a<!-- b -->c", "ac"],
    // HTML-3: links are http(s) only; Mastodon would keep some other schemes.
    [
      "drops the href of a non-http(s) link",
      '<a href="gemini://x.example">g</a><a href="/relative">r</a>',
      '<a rel="nofollow noopener" target="_blank">g</a><a rel="nofollow noopener" target="_blank">r</a>',
    ],
    ["puts a heading’s lang on its strong", '<h1 lang="ja">t</h1>', '<p><strong lang="ja">t</strong></p>'],
    ["puts a heading’s empty lang on its strong", '<h2 lang="">t</h2>', '<p><strong lang="">t</strong></p>'],
    ["drops a heading’s other attributes", '<h3 id="x" class="h-x">t</h3>', "<p><strong>t</strong></p>"],
    ["drops lang with an element it unwraps", '<div lang="x">a</div>', "a"],
    ["drops lang with an element it drops", '<script lang="x">a</script>b', "b"],
  ])("%s", (_, input, expected) => {
    expect(sanitizeRemoteHtml(input)).toBe(expected);
  });

  // MASTODON_STRICT's `:all => %w(lang)` (`mastodon#39114`): any value, an empty one included.
  const LANG_KEPT =
    '<p lang="ja">a<span lang="en">b</span><b lang="fr">c</b><a href="https://x.example/" lang="es" class="mention">e</a>' +
    '<ruby lang="zh">f<rt lang="">g</rt></ruby></p><ol lang="de" start="2"><li lang="it" value="3">d</li></ol>';
  const HEADING_LANG = '<h1 lang="ja">t</h1>';
  const BR_LANG = 'a<br lang="en">b';

  it("keeps lang on every kept element, an empty one included", () => {
    const sanitized = sanitizeRemoteHtml(LANG_KEPT);
    expect(sanitized).toBe(
      '<p lang="ja">a<span lang="en">b</span><b lang="fr">c</b>' +
        '<a href="https://x.example/" class="mention" lang="es" rel="nofollow noopener" target="_blank">e</a>' +
        '<ruby lang="zh">f<rt lang="">g</rt></ruby></p><ol lang="de" start="2"><li lang="it" value="3">d</li></ol>',
    );
    expect(unsafeParts(sanitized)).toEqual([]);
  });

  // HTML-1: a lang value is written double-quoted and escaped, also on the br and the heading Kopje rewrites.
  it.each([
    ["p", `<p lang='"><img src=x onerror=alert(1)>'>a</p>`, '"><img src=x onerror=alert(1)>'],
    ["br", `<br lang='" onload="x'>`, '" onload="x'],
    ["br", `<br lang="a>b">`, "a>b"],
    ["strong", `<h1 lang='"><script>x</script>'>t</h1>`, '"><script>x</script>'],
  ])("keeps a hostile lang as one attribute of one %s", (tag, input, value) => {
    const sanitized = sanitizeRemoteHtml(input);
    expect(unsafeParts(sanitized), sanitized).toEqual([]);
    const found = elements(parseFragment(DIV, sanitized, {})).filter((e) => e.tagName !== "p" || tag === "p");
    expect(found.map((e) => [e.tagName, e.attrs])).toEqual([[tag, [{ name: "lang", value }]]]);
  });

  it("writes a br with lang as HTML and ends a line there", () => {
    expect(sanitizeRemoteHtml(BR_LANG)).toBe(BR_LANG);
    expect(remotePlainText(sanitizeRemoteHtml(BR_LANG))).toBe("a\nb");
    expect(remoteHtmlText(sanitizeRemoteHtml(BR_LANG))).toBe("a b");
    // A run of br elements, whatever their attributes, ends one line, as Mastodon's `(<br />|<br>|</p>)+`.
    expect(remotePlainText(sanitizeRemoteHtml('<p>a<br lang="en"><br>b</p>'))).toBe("a\nb");
  });

  // #1586: sanitize-html lowercases tag names, so <BR> is a br like any other.
  it("ends a line at <BR>", () => {
    expect(sanitizeRemoteHtml("foo<BR>bar")).toBe("foo<br>bar");
    expect(remotePlainText(sanitizeRemoteHtml("foo<BR>bar"))).toBe("foo\nbar");
  });

  it("sanitizes idempotently with lang", () => {
    for (const input of [LANG_KEPT, HEADING_LANG, BR_LANG, '<ol reversed lang=""><li>x</li></ol>']) {
      const once = sanitizeRemoteHtml(input);
      expect(sanitizeRemoteHtml(once), once).toBe(once);
      const document = sanitizeDocumentHtml(input);
      expect(sanitizeDocumentHtml(document), document).toBe(document);
    }
  });

  // RES-1, RES-2: the input is cut at the raw cap, and the worst cases at the cap finish quickly.
  it.each(worstCases(REMOTE_HTML_RAW_LIMIT))("handles %s at the raw cap within a generous time", (_, input) => {
    const started = performance.now();
    const sanitized = sanitizeRemoteHtml(input + input);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(unsafeParts(sanitized)).toEqual([]);
  });
});

// The worst inputs for the sanitizer, each about `cap` code units.
function worstCases(cap: number): [string, string][] {
  return [
    ["nested tags", "<b>".repeat(Math.floor(cap / 3))],
    ["unclosed attribute quotes", '<a href="'.repeat(Math.floor(cap / 9))],
    ["angle brackets", "<".repeat(cap)],
    ["dropped tag openers", "<script>".repeat(Math.floor(cap / 8))],
  ];
}

describe("HTML-1, RES-2: stored HTML sanitized again", () => {
  // Sanitizing lengthens each past the raw cap: `"` in a kept attribute value is written `&quot;` (lang, and before it
  // a microformats class, an href, ol@start and li@value), `&` in text `&amp;`.
  const QUOTES = '"'.repeat(9000);
  it.each([
    ["lang", `<p lang='${QUOTES}'>SENTINEL</p>`],
    ["class", `<p class='h-${QUOTES}'>SENTINEL</p>`],
    ["href", `<a href='https://x.example/?${QUOTES}'>SENTINEL</a>`],
    ["ol start", `<ol start='${QUOTES}'><li>SENTINEL</li></ol>`],
    ["li value", `<ol><li value='${QUOTES}'>SENTINEL</li></ol>`],
    ["text", `<p>${"&".repeat(11_000)}SENTINEL</p>`],
  ])("keeps a stored value whose %s sanitizing lengthened past the raw cap", (_, raw) => {
    const stored = sanitizeRemoteContent(raw);
    expect(stored.length).toBeGreaterThan(REMOTE_HTML_RAW_LIMIT);
    expect(stored).toContain("SENTINEL");
    expect(sanitizeStoredHtml(stored)).toBe(stored);
  });

  // A value within B UTF-8 bytes as a JSON string is at most B - 2 code units, each taking a byte at least.
  it("cuts at a bound that admits every stored value", () => {
    for (const bytes of [
      STATUS_CONTENT_BYTES,
      CONTENT_JSON_BYTES,
      REMOTE_BIO_BYTES,
      BIO_JSON_BYTES,
      REMOTE_FIELDS_BYTES,
    ]) {
      expect(STORED_HTML_LIMIT).toBeGreaterThanOrEqual(bytes - 2);
    }
    const longest = `<p>${"a".repeat(STATUS_CONTENT_BYTES - 2 - "<p></p>".length)}</p>`;
    expect(jsonStringBytes(longest)).toBe(STATUS_CONTENT_BYTES);
    expect(sanitizeStoredHtml(longest)).toBe(longest);
  });

  it.each(worstCases(STORED_HTML_LIMIT))("handles %s at the stored cap within a generous time", (_, input) => {
    const started = performance.now();
    const sanitized = sanitizeStoredHtml(input + input);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(unsafeParts(sanitized)).toEqual([]);
  });
});
