import fc from "fast-check";
import { type DefaultTreeAdapterMap, html as parse5Html, parse } from "parse5";
import { describe, expect, it } from "vitest";

import { type AlternateScan, REL_CHARS, RAW_VALUE_CHARS, SCAN_LIMITS, scanAlternate } from "../src/platform/html-scan";
import { LINK_HEADER_CHARS, LINK_HEADER_LINKS, parseLinkHeader } from "../src/platform/link-header";
import { runs } from "./policy-world";

// The alternate search resolution takes from a page (platform/html-scan.ts scanAlternate, D13 of #1585) and from a Link
// header (platform/link-header.ts), against what Mastodon 4.7.5's FetchResourceService takes.

const AP = "application/activity+json";
const LD = 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"';
const TYPES = [AP, LD];
const UTF8 = { label: "utf-8", bomLength: 0 };

async function alternate(page: string): Promise<AlternateScan> {
  const result = await scanAlternate(new TextEncoder().encode(page), UTF8, TYPES);
  if ("failed" in result) {
    throw new Error(`scan failed: ${result.failed}`);
  }
  return result;
}

const link = (href: string, type = AP, rel = "alternate") =>
  `<link rel="${rel}" type="${type.replaceAll('"', "&quot;")}" href="${href}">`;

type Node = DefaultTreeAdapterMap["node"];

// The oracle: the href of the first <link> in document order that a spec parser with scripting off builds (as
// Mastodon's Nokogiri::HTML5), HTML namespace only, whose rel holds "alternate" (NokogiriHandler.link_rel_include) and
// whose type is one of TYPES; with or without template contents, which Kopje does not know whether //link reaches.
function parse5Alternate(page: string, templates: boolean): string | null | undefined {
  let found: string | null | undefined;
  const walk = (node: Node) => {
    if (found !== undefined) {
      return;
    }
    if ("tagName" in node) {
      const attribute = (name: string) => node.attrs.find((a) => a.name === name)?.value;
      const rel = attribute("rel");
      const type = attribute("type");
      if (
        node.namespaceURI === parse5Html.NS.HTML &&
        node.tagName === "link" &&
        rel !== undefined &&
        rel
          .toLowerCase()
          .split(/[\t\n\f\r ]+/)
          .includes("alternate") &&
        type !== undefined &&
        TYPES.includes(type)
      ) {
        found = attribute("href") ?? null;
        return;
      }
      if (templates && node.tagName === "template" && "content" in node) {
        walk(node.content);
      }
    }
    if ("childNodes" in node) {
      for (const child of node.childNodes) {
        walk(child);
      }
    }
  };
  walk(parse(page, { scriptingEnabled: false }));
  return found;
}

describe("scanAlternate contexts (T10.18)", () => {
  // Each with a matching <link> after the context and none before: nothing, and the refusal named.
  it.each([
    ["inside <select>", "<body><select><link rel=alternate type=application/activity+json href=in></select>", "select"],
    ["after </select>", "<body><select></select>LINK", "select"],
    ["in a head <noscript>", "<head><noscript>LINK</noscript></head>", "noscript"],
    ["after <template>", "<body><template>LINK</template>", "template"],
    ["after <svg>", "<body><svg></svg>LINK", "svg"],
    ["after <math>", "<body><math></math>LINK", "math"],
    ["after <table>", "<body><table></table>LINK", "table"],
    ["on a page with <frameset> bytes", "<!-- <frameset> -->LINK", "frameset"],
    [
      "after a rel past REL_CHARS",
      `<link rel="${"x ".repeat(REL_CHARS / 2)}alternate" type=text/html href=l>LINK`,
      "long-rel",
    ],
  ])("takes no alternate %s", async (_label, page, refused) => {
    const result = await alternate(page.replace("LINK", link("after")));
    expect(result).toEqual({ link: null, refused });
  });

  it("refuses table foster parenting, where the tree's first <link> is not the stream's", async () => {
    const page = `<body><table><tr><td>${link("A")}</td></tr><b>${link("B")}</b></table>`;
    // An HTML5 tree moves B before the table: its first alternate is B; lol-html streams A first.
    expect(parse5Alternate(page, true)).toBe("B");
    expect(await alternate(page)).toEqual({ link: null, refused: "table" });
  });

  it("takes a matching <link> before any refused context", async () => {
    for (const context of ["<select>", "<noscript>", "<template>", "<table>", "<svg>", "<math>"]) {
      const page = `<head>${link("first")}</head><body>${context}${link("later")}`;
      expect(parse5Alternate(page, true)).toBe("first");
      expect(await alternate(page), context).toEqual({ link: { href: "first" }, refused: null });
    }
    // At exactly REL_CHARS decoded units the rel is read whole.
    const atCap = `${"x".repeat(REL_CHARS - "alternate".length - 1)} alternate`;
    expect(await alternate(link("cap", AP, atCap))).toEqual({ link: { href: "cap" }, refused: null });
  });
});

describe("scanAlternate attributes (T10.19)", () => {
  it("finds alternate among all rel tokens, ASCII case-insensitively", async () => {
    const tokens = Array.from({ length: 16 }, (_, i) => `t${i}`).join(" ");
    expect(SCAN_LIMITS.relTokens).toBe(16);
    expect(await alternate(link("17th", AP, `${tokens} alternate`))).toMatchObject({ link: { href: "17th" } });
    expect(await alternate(link("upper", AP, "ALTERNATE"))).toMatchObject({ link: { href: "upper" } });
    expect(await alternate(link("listed", AP, "nofollow\talternate\n"))).toMatchObject({ link: { href: "listed" } });
    expect(await alternate(link("no", AP, "alternates"))).toEqual({ link: null, refused: null });
  });

  it("compares the decoded type exactly, the first of duplicate attributes winning", async () => {
    expect(await alternate(`<link rel=alternate type="${AP}" type=text/html href=first>`)).toMatchObject({
      link: { href: "first" },
    });
    expect(await alternate(`<link rel=alternate type=text/html type="${AP}" href=second>`)).toEqual({
      link: null,
      refused: null,
    });
    for (const type of [`${AP}; charset=utf-8`, "Application/Activity+JSON", ` ${AP}`, "application/ld+json"]) {
      expect(await alternate(link("x", type)), type).toEqual({ link: null, refused: null });
    }
    // Entities decode to the ld+json string, a long run of leading zeros included (decoded whole).
    expect(await alternate(link("entities", LD))).toMatchObject({ link: { href: "entities" } });
    const padded = `application/activity&#x${"0".repeat(RAW_VALUE_CHARS)}2B;json`;
    expect(await alternate(`<link rel=alternate type="${padded}" href=zeros>`)).toMatchObject({
      link: { href: "zeros" },
    });
  });

  it("takes the first match whatever its href: none, relative or padded is unusable, and a later one is not tried", async () => {
    for (const first of [`<link rel=alternate type="${AP}">`, link("/relative"), link(" https://a.example/x ")]) {
      const result = await alternate(`${first}${link("https://b.example/y")}`);
      expect(result.link?.href).not.toBe("https://b.example/y");
    }
    expect(await alternate(`<link rel=alternate type="${AP}">${link("later")}`)).toEqual({
      link: { href: null },
      refused: null,
    });
    const long = "x".repeat(SCAN_LIMITS.valueChars + 1);
    expect(await alternate(`${link(long)}${link("later")}`)).toEqual({ link: { href: null }, refused: null });
  });

  it("counts only HTML <link> elements", async () => {
    expect(await alternate(`<a rel=alternate type="${AP}" href=anchor></a>`)).toEqual({ link: null, refused: null });
  });

  it("fails whole on a parsing ambiguity, and rejects at an abort", async () => {
    // A match before the ambiguity is not returned: the scan fails whole.
    const page = `${link("x")}<select><xmp>${link("y")}</xmp></select>`;
    expect(await scanAlternate(new TextEncoder().encode(page), UTF8, TYPES)).toEqual({ failed: "ambiguity" });
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(scanAlternate(new TextEncoder().encode(link("x")), UTF8, TYPES, controller.signal)).rejects.toThrow(
      "stop",
    );
  });

  // A token soup of the constructs the refusals cover and others; Kopje may take nothing where the tree has an
  // alternate, never a different one, with or without template contents.
  const FRAGMENTS = [
    "LINK",
    '<link rel="ALTERNATE nofollow" type="application/activity+json" href=ID>',
    '<link rel=alternate type="application/ld+json; profile=&quot;https://www.w3.org/ns/activitystreams&quot;" href=ID>',
    "<link rel=alternate type=text/html href=ID>",
    "<select>",
    "</select>",
    "<template>",
    "</template>",
    "<table>",
    "<tr>",
    "<td>",
    "</td>",
    "</table>",
    "<b>",
    "</b>",
    "<noscript>",
    "</noscript>",
    "<svg>",
    "</svg>",
    "<math>",
    "<mi>",
    "<foreignObject>",
    "<head>",
    "</head>",
    "<body>",
    "<p>",
    "<!--",
    "-->",
    "<script>",
    "</script>",
    "<title>",
    "</title>",
    "<textarea>",
    "<style>",
    "<plaintext>",
    "<iframe>",
    "<frameset>",
    "<option>",
    "<caption>",
    "text",
    " ",
    '"',
    "<",
    ">",
  ];

  it("never takes an alternate other than the HTML5 tree's first", { timeout: 120_000 }, async () => {
    let taken = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(fc.constantFrom(...FRAGMENTS), { maxLength: 30 }), async (parts) => {
        let id = 0;
        const page = parts
          .map((part) => (part === "LINK" ? link(`h${id++}`) : part.replace("ID", () => `h${id++}`)))
          .join("");
        const result = await scanAlternate(new TextEncoder().encode(page), UTF8, TYPES);
        if ("failed" in result || result.link === null) {
          return;
        }
        taken++;
        for (const templates of [true, false]) {
          expect(result.link.href, JSON.stringify(page)).toBe(parse5Alternate(page, templates));
        }
      }),
      runs(3000),
    );
    // The comparison ran on pages where an alternate was taken.
    expect(taken).toBeGreaterThan(0);
  });
});

describe("parseLinkHeader, as the link_header gem 0.0.8 reads a value", () => {
  it("reads hrefs and parameters in order, names and values as written", () => {
    expect(
      parseLinkHeader(
        '< https://a.example/x >; rel="alternate"; type="application/activity+json", <https://b.example/>;REL=alternate;type=application/activity+json',
      ),
    ).toEqual([
      {
        href: "https://a.example/x ",
        params: [
          ["rel", "alternate"],
          ["type", "application/activity+json"],
        ],
      },
      {
        href: "https://b.example/",
        params: [
          ["REL", "alternate"],
          ["type", "application/activity+json"],
        ],
      },
    ]);
  });

  it('unescapes only \\" in a quoted value, and stops at the first part it cannot read', () => {
    expect(parseLinkHeader('<x>; type="a\\"b\\\\c"')).toEqual([{ href: "x", params: [["type", 'a"b\\\\c']] }]);
    expect(parseLinkHeader("<x>; rel=alternate; broken; type=a, <y>; rel=alternate")).toEqual([
      { href: "x", params: [["rel", "alternate"]] },
    ]);
    expect(parseLinkHeader("junk <x>; rel=alternate")).toEqual([]);
    expect(parseLinkHeader('<x>; rel = "alternate" ,<y>')).toEqual([
      { href: "x", params: [["rel", "alternate"]] },
      { href: "y", params: [] },
    ]);
  });

  it("reads a value at LINK_HEADER_CHARS in linear time, where the gem's href pattern backtracks", () => {
    const started = performance.now();
    expect(parseLinkHeader(`<${" ".repeat(LINK_HEADER_CHARS - 1)}`)).toEqual([]);
    expect(parseLinkHeader(`${" ".repeat(LINK_HEADER_CHARS / 2)}<${" ".repeat(LINK_HEADER_CHARS / 2 - 1)}`)).toEqual(
      [],
    );
    expect(parseLinkHeader(`<a>; c="${"d".repeat(LINK_HEADER_CHARS - 8)}`)).toEqual([{ href: "a", params: [] }]);
    // The backtracking pattern takes seconds at a quarter of the cap; the scan, milliseconds at the cap.
    expect(performance.now() - started).toBeLessThan(1000);
    expect(parseLinkHeader("<  >")).toEqual([{ href: "", params: [] }]);
  });

  it("reads nothing past LINK_HEADER_CHARS or LINK_HEADER_LINKS", () => {
    const links = (n: number) => Array.from({ length: n }, (_, i) => `<h${i}>`).join(", ");
    expect(parseLinkHeader(links(LINK_HEADER_LINKS))).toHaveLength(LINK_HEADER_LINKS);
    expect(parseLinkHeader(links(LINK_HEADER_LINKS + 1))).toBeNull();
    const value = `<${"x".repeat(LINK_HEADER_CHARS - 2)}>`;
    expect(parseLinkHeader(value)).toHaveLength(1);
    expect(parseLinkHeader(`${value} `)).toBeNull();
  });
});
