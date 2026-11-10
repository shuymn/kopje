import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import {
  type CssNode,
  generate,
  type List,
  parse as parseCss,
  type Selector,
  type SelectorList,
  type StyleSheet,
  walk as walkCss,
} from "css-tree";
import type { Node } from "oxc-parser";
import { describe, expect, it } from "vitest";

import { ASSET_HEADERS, FINGERPRINTED_HEADERS } from "../browser/headers.js";
import { drift, releaseForCheck, stylesheet } from "../scripts/build-assets.mjs";
import { L1_SCRIPT, PREVIOUS_STYLESHEET, STYLESHEET } from "../src/web/asset-versions.js";
import { contrast as contrastOf } from "./contrast.js";
import { parse, type Source, sources, walk } from "./source-scan.js";

// The web stylesheet (docs/web-pages.md) and its publication (scripts/build-assets.mjs). The Workers suites call
// app.fetch directly and never reach Static Assets, so the asset rules are checked here, on the files. The rules are
// checked on the served file, minified from src/web/kopje.css, so the patterns allow any whitespace.

const PACKAGE = new URL("../", import.meta.url);
const SERVED = readFileSync(new URL(`public${STYLESHEET}`, PACKAGE));
const CSS = SERVED.toString("utf8");
const HEADERS = readFileSync(new URL("public/_headers", PACKAGE), "utf8");
const ASSET_NAMES = readdirSync(new URL("public/assets/", PACKAGE));

// A declaration in source order: the preludes it is nested in (an at-rule's as `@name prelude`) and their join,
// whether the innermost one is a rule ending every selector at a heading element, its value as CSSTree prints it
// (`!important` kept), the value's top-level parts, and whether a comment sits directly above it (only whitespace
// between).
type Declaration = {
  context: string[];
  selector: string;
  heading: boolean;
  property: string;
  value: string;
  parts: string[];
  commented: boolean;
};

// A stylesheet as CSSTree reads it: the declarations, every rule's full selector (nesting resolved: `&` is its parent,
// a list of several as :is()), and the at-rules' names. Any parse error throws, so nothing CSSTree cannot read is kept
// as raw text and passed unchecked; a rule nested without `&` is one.
type Sheet = { declarations: Declaration[]; selectors: SelectorList[]; atrules: string[] };

const refuse = (error: Error): never => {
  throw error;
};

function selectorList(text: string): SelectorList {
  return parseCss(text, { context: "selectorList", onParseError: refuse }) as SelectorList;
}

function readSheet(css: string): Sheet {
  // The offset of the first non-space after each comment: a declaration starting there is commented.
  const afterComment = new Set<number>();
  const next = /\S/g;
  const tree = parseCss(css, {
    positions: true,
    parseCustomProperty: true,
    onParseError: refuse,
    onComment: (_, loc) => {
      next.lastIndex = loc.end.offset;
      const found = next.exec(css);
      if (found !== null) {
        afterComment.add(found.index);
      }
    },
  });
  const sheet: Sheet = { declarations: [], selectors: [], atrules: [] };
  const visit = (nodes: List<CssNode>, context: string[], rule: SelectorList | null, parent: SelectorList | null) => {
    for (const node of nodes) {
      if (node.type === "Declaration") {
        const value = generate(node.value) + (node.important === false ? "" : " !important");
        sheet.declarations.push({
          context,
          selector: context.join(" "),
          heading: rule !== null && headingRule(rule),
          property: node.property,
          value,
          parts: node.value.type === "Value" ? node.value.children.toArray().map((part) => generate(part)) : [value],
          commented: afterComment.has(node.loc!.start.offset),
        });
      } else if (node.type === "Rule") {
        const own = node.prelude as SelectorList;
        let full = own;
        if (parent !== null) {
          let nested = false;
          walkCss(own, (inner) => {
            nested ||= inner.type === "NestingSelector";
          });
          const outer = parent.children.size > 1 ? `:is(${generate(parent)})` : generate(parent);
          full = selectorList((nested ? generate(own) : `& ${generate(own)}`).replaceAll("&", outer));
        }
        sheet.selectors.push(full);
        visit(node.block.children, [...context, generate(own)], own, full);
      } else if (node.type === "Atrule") {
        sheet.atrules.push(node.name);
        if (node.block !== null) {
          const prelude = node.prelude === null ? "" : ` ${generate(node.prelude)}`;
          visit(node.block.children, [...context, `@${node.name}${prelude}`], null, parent);
        }
      }
    }
  };
  visit((tree as StyleSheet).children, [], null, null);
  return sheet;
}

// A selector's compounds: its nodes split at each combinator.
function compounds(selector: Selector): CssNode[][] {
  const found: CssNode[][] = [[]];
  for (const node of selector.children) {
    if (node.type === "Combinator") {
      found.push([]);
    } else {
      found.at(-1)!.push(node);
    }
  }
  return found;
}

// Whether a node, or any node inside it, passes `test`.
function contains(node: CssNode, test: (inner: CssNode) => boolean): boolean {
  let found = false;
  walkCss(node, (inner) => {
    found ||= test(inner);
  });
  return found;
}

// Whether every selector of a rule ends at a heading element (h1.oneline, not h1 span).
const headingRule = (rule: SelectorList) =>
  rule.children.toArray().every((selector) => {
    const first = compounds(selector as Selector)
      .at(-1)!
      .find((node) => node.type !== "NestingSelector");
    return first?.type === "TypeSelector" && /^h[1-6]$/i.test(first.name);
  });

// The light and dark value of each token: `--name: light-dark(#light, #dark)`.
function tokens(css: string): Map<string, { light: string; dark: string }> {
  const found = new Map<string, { light: string; dark: string }>();
  for (const { property, value } of declarations(css, true)) {
    const [, light, dark] = /^light-dark\((#[0-9a-f]{3,6}),\s*(#[0-9a-f]{3,6})\)$/.exec(value) ?? [];
    if (light !== undefined && dark !== undefined) {
      found.set(property.slice(2), { light, dark });
    }
  }
  return found;
}

// A hex colour's channels (#rgb or #rrggbb), for the contrast ratio (contrast.ts).
function channels(hex: string): number[] {
  const digits =
    hex.length === 4 ? Array.from(hex.slice(1), (d) => d + d) : [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)];
  return digits.map((d) => parseInt(d, 16));
}

function contrast(a: string, b: string): number {
  return contrastOf(channels(a), channels(b));
}

// public/_headers as rules: the path pattern and its header lines.
function headerRules(text: string): { pattern: string; headers: string[] }[] {
  const rules: { pattern: string; headers: string[] }[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "" || line.startsWith("#")) {
      continue;
    }
    if (/^\s/.test(line)) {
      rules.at(-1)?.headers.push(line.trim());
    } else {
      rules.push({ pattern: line.trim(), headers: [] });
    }
  }
  return rules;
}

// A _headers path pattern: `*` matches any run of characters.
const matches = (pattern: string, path: string) =>
  new RegExp(
    `^${pattern
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  ).test(path);

const IMMUTABLE = "Cache-Control: public, max-age=31536000, immutable";

// The header lines public/_headers gives a path.
const HEADER_RULES = headerRules(HEADERS);
const headerLinesOf = (path: string) =>
  HEADER_RULES.filter((rule) => matches(rule.pattern, path)).flatMap((rule) => rule.headers);

// Every full selector with a dialog compound that does not name it open: a rule that could give a closed dialog a
// display.
function closedDialogs(css: string): string[] {
  return readSheet(css)
    .selectors.flatMap((list) => list.children.toArray() as Selector[])
    .filter((selector) =>
      compounds(selector).some(
        (compound) =>
          compound.some((node) => node.type === "TypeSelector" && node.name === "dialog") &&
          !compound.some((node) => node.type === "AttributeSelector" && node.name.name === "open"),
      ),
    )
    .map((selector) => generate(selector));
}

// The animation and transition declarations outside a prefers-reduced-motion: no-preference block.
function motionOutside(css: string): string[] {
  return declarations(css)
    .filter(
      ({ context, property }) =>
        /^(animation|transition)(-|$)/.test(property) &&
        !context.includes("@media (prefers-reduced-motion:no-preference)"),
    )
    .map(({ selector, property, value }) => `${selector} { ${property}: ${value} }`);
}

describe("the stylesheet", () => {
  const TOKENS = tokens(CSS);
  const pair = (name: string) => {
    const token = TOKENS.get(name);
    expect(token, name).toBeDefined();
    return token!;
  };

  it("declares both colour schemes and every token for each", () => {
    expect(CSS).toMatch(/:root\s*\{\s*color-scheme:\s*light dark;/);
    for (const name of ["ground", "surface", "raised", "ink", "muted", "line", "accent", "on-accent", "soft"]) {
      pair(name);
    }
    for (const name of [
      "control-line",
      "danger",
      "ok",
      "warn",
      "scrim",
      "share",
      "share-lead",
      "primary",
      "on-primary",
    ]) {
      pair(name);
    }
  });

  it("keeps text at 4.5:1 and controls and the focus ring at 3:1 in both schemes (WCAG 1.4.3, 1.4.11)", () => {
    const text: [string, string][] = [];
    for (const fg of ["ink", "muted", "accent"]) {
      for (const bg of ["ground", "surface", "raised", "soft"]) {
        text.push([fg, bg]);
      }
    }
    text.push(
      ["on-accent", "accent"],
      ["on-primary", "primary"],
      ["danger", "ground"],
      ["danger", "surface"],
      ["warn", "surface"],
    );
    // A poll choice's text over its share's fill.
    text.push(["ink", "share"], ["ink", "share-lead"]);
    const controls: [string, string][] = [];
    // Controls, the focus ring, and an alert's bar and icon.
    for (const fg of ["control-line", "accent", "ok", "warn", "danger"]) {
      for (const bg of ["ground", "surface", "raised"]) {
        controls.push([fg, bg]);
      }
    }
    for (const scheme of ["light", "dark"] as const) {
      for (const [fg, bg] of text) {
        expect(contrast(pair(fg)[scheme], pair(bg)[scheme]), `${scheme} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
      for (const [fg, bg] of controls) {
        expect(contrast(pair(fg)[scheme], pair(bg)[scheme]), `${scheme} ${fg} on ${bg}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("loads nothing else and shows focus with an outline", () => {
    expect(CSS).not.toMatch(/@import|@font-face/);
    expect(CSS).not.toMatch(/url\(/);
    expect(CSS).toMatch(/:focus-visible\s*\{\s*outline:\s*2px solid var\(--accent\);/);
    expect(CSS).not.toMatch(/outline:\s*(none|0)\b/);
  });

  it("keeps hidden things hidden and closed dialogs unrendered", () => {
    expect(CSS).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
    expect(closedDialogs(CSS)).toEqual([]);
    for (const css of [
      "dialog { display: grid; }",
      ".x, dialog { gap: 0; }",
      "dialog { &[open] { gap: 0; } }",
      ".x { & dialog { gap: 0; } }",
    ]) {
      expect(closedDialogs(css), css).toHaveLength(1);
    }
    for (const css of ["dialog[open] { display: grid; }", "dialog[open]::backdrop, .x dialog[open] .y { gap: 0; }"]) {
      expect(closedDialogs(css), css).toEqual([]);
    }
  });

  it("animates nothing outside prefers-reduced-motion: no-preference, and has no global override", () => {
    expect(CSS).not.toMatch(/prefers-reduced-motion:\s*reduce/);
    expect(motionOutside(CSS)).toEqual([]);
    for (const css of [
      "a { transition: color 1s; }",
      "a { animation-name: spin; }",
      "@media (prefers-reduced-motion: no-preference) { a { gap: 0; } } a { transition-delay: 1s; }",
      "@media screen and (prefers-reduced-motion: no-preference) { a { animation: spin 1s; } }",
      "@media (prefers-color-scheme: dark) { a { transition: color 1s; } }",
    ]) {
      expect(motionOutside(css), css).toHaveLength(1);
    }
    for (const css of [
      "@media (prefers-reduced-motion: no-preference) { a { transition: color 1s; } .b { animation: spin 1s; } }",
      "@media (prefers-reduced-motion:no-preference) { @supports (color: red) { a { animation-name: spin; } } }",
    ]) {
      expect(motionOutside(css), css).toEqual([]);
    }
  });

  it("declares color-scheme in the order the pages’ meta tags use", () => {
    expect(CSS).toMatch(/color-scheme:\s*light dark;/);
    for (const file of ["src/web/components/layout.tsx", "src/web/pages/embed.tsx"]) {
      expect(readFileSync(new URL(file, PACKAGE), "utf8"), file).toContain(
        '<meta name="color-scheme" content="light dark" />',
      );
    }
  });

  it("stays within 16 KiB raw and 5 KiB gzip as served", () => {
    expect(SERVED.byteLength).toBeLessThanOrEqual(16 * 1024);
    expect(gzipSync(SERVED).byteLength).toBeLessThanOrEqual(5 * 1024);
  });
});

// A stylesheet's declarations (readSheet). `custom`: the custom-property definitions (`--name: value`) instead of the
// other declarations.
function declarations(css: string, custom = false): Declaration[] {
  return readSheet(css).declarations.filter(({ property }) => property.startsWith("--") === custom);
}

const SPACING = /^(margin|padding)(-|$)|^(row-|column-)?gap$/;
const GEOMETRY = /^(top|right|bottom|left|inset)(-|$)/;
const RADIUS = /^border(-[a-z]+)*-radius$/;
const STEP = /^var\(--(s[1-6]|pad)\)$/;
const NEGATIVE_STEP = /^calc\(-1\*var\(--(s[1-6]|pad)\)\)$/;
const COLOUR_FUNCTION = /\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark|device-cmyk)\(/i;
// Properties whose values name things other than colours.
const NOT_COLOURS = /^(font-family|content|counter-|container|grid-|animation|transition|will-change)/;
// CSS Color 4's named colours (https://www.w3.org/TR/css-color-4/#named-colors), which a token stands for here.
const NAMED_COLOURS = new Set([
  "aliceblue",
  "antiquewhite",
  "aqua",
  "aquamarine",
  "azure",
  "beige",
  "bisque",
  "black",
  "blanchedalmond",
  "blue",
  "blueviolet",
  "brown",
  "burlywood",
  "cadetblue",
  "chartreuse",
  "chocolate",
  "coral",
  "cornflowerblue",
  "cornsilk",
  "crimson",
  "cyan",
  "darkblue",
  "darkcyan",
  "darkgoldenrod",
  "darkgray",
  "darkgreen",
  "darkgrey",
  "darkkhaki",
  "darkmagenta",
  "darkolivegreen",
  "darkorange",
  "darkorchid",
  "darkred",
  "darksalmon",
  "darkseagreen",
  "darkslateblue",
  "darkslategray",
  "darkslategrey",
  "darkturquoise",
  "darkviolet",
  "deeppink",
  "deepskyblue",
  "dimgray",
  "dimgrey",
  "dodgerblue",
  "firebrick",
  "floralwhite",
  "forestgreen",
  "fuchsia",
  "gainsboro",
  "ghostwhite",
  "gold",
  "goldenrod",
  "gray",
  "green",
  "greenyellow",
  "grey",
  "honeydew",
  "hotpink",
  "indianred",
  "indigo",
  "ivory",
  "khaki",
  "lavender",
  "lavenderblush",
  "lawngreen",
  "lemonchiffon",
  "lightblue",
  "lightcoral",
  "lightcyan",
  "lightgoldenrodyellow",
  "lightgray",
  "lightgreen",
  "lightgrey",
  "lightpink",
  "lightsalmon",
  "lightseagreen",
  "lightskyblue",
  "lightslategray",
  "lightslategrey",
  "lightsteelblue",
  "lightyellow",
  "lime",
  "limegreen",
  "linen",
  "magenta",
  "maroon",
  "mediumaquamarine",
  "mediumblue",
  "mediumorchid",
  "mediumpurple",
  "mediumseagreen",
  "mediumslateblue",
  "mediumspringgreen",
  "mediumturquoise",
  "mediumvioletred",
  "midnightblue",
  "mintcream",
  "mistyrose",
  "moccasin",
  "navajowhite",
  "navy",
  "oldlace",
  "olive",
  "olivedrab",
  "orange",
  "orangered",
  "orchid",
  "palegoldenrod",
  "palegreen",
  "paleturquoise",
  "palevioletred",
  "papayawhip",
  "peachpuff",
  "peru",
  "pink",
  "plum",
  "powderblue",
  "purple",
  "rebeccapurple",
  "red",
  "rosybrown",
  "royalblue",
  "saddlebrown",
  "salmon",
  "sandybrown",
  "seagreen",
  "seashell",
  "sienna",
  "silver",
  "skyblue",
  "slateblue",
  "slategray",
  "slategrey",
  "snow",
  "springgreen",
  "steelblue",
  "tan",
  "teal",
  "thistle",
  "tomato",
  "turquoise",
  "violet",
  "wheat",
  "white",
  "whitesmoke",
  "yellow",
  "yellowgreen",
]);

// Whether a value writes a colour: a hex, a colour function or a named colour.
function writesColour(value: string): boolean {
  return (
    /#[0-9a-f]{3,8}\b/i.test(value) ||
    COLOUR_FUNCTION.test(value) ||
    value
      .toLowerCase()
      .split(/[\s,()/]+/)
      .some((word) => NAMED_COLOURS.has(word))
  );
}

// Every margin, padding and gap declaration outside the spacing scale, and every font size, weight and line height
// outside the type scale (kopje.css's header, docs/web-pages.md "UI rules"). A spacing part is a step, 0 or auto; a
// negative step, a negative length (a bleed) or an em length (rich content) only with a comment directly above. A
// size is a --t token or inherit; a weight 400 or 600, or 700 on a heading; a line height 1, 1.25 or 1.6, another
// only commented. A radius (and each corner's) is a --r token. An offset (top, inset and their kin) is 0, auto, a
// percentage or a step; any other length, a calc() of one included, only commented. A colour is a token: none is
// written outside :root, as a hex, a function or a name.
function offScale(css: string): string[] {
  const off: string[] = [];
  for (const { selector, heading, property, value, parts, commented } of declarations(css)) {
    const allowed = (() => {
      if (SPACING.test(property)) {
        return parts.every(
          (part) =>
            part === "0" ||
            part === "auto" ||
            STEP.test(part) ||
            (commented && (NEGATIVE_STEP.test(part) || /^-[\d.]+(px|rem)$/.test(part) || /^[\d.]+em$/.test(part))),
        );
      }
      if (GEOMETRY.test(property)) {
        return (
          commented ||
          parts.every((part) => part === "0" || part === "auto" || /^-?[\d.]+%$/.test(part) || STEP.test(part))
        );
      }
      if (RADIUS.test(property)) {
        return parts.every((part) => /^var\(--r-(control|inset|card|pill)\)$/.test(part));
      }
      if (!NOT_COLOURS.test(property) && selector !== ":root" && writesColour(value)) {
        return false;
      }
      switch (property) {
        case "font-size":
          return /^var\(--t[1-5]\)$/.test(value) || value === "inherit";
        case "font-weight":
          return value === "400" || value === "600" || (value === "700" && heading);
        case "line-height":
          return ["1", "1.25", "1.6"].includes(value) || commented;
        case "font":
          return value === "inherit";
        default:
          // An em length (rich content's spacing, an emoji's size) is a commented exception wherever it is.
          return commented || !/(^|[^\w.])[\d.]+em\b/.test(value);
      }
    })();
    if (!allowed) {
      off.push(`${selector} { ${property}: ${value} }`);
    }
  }
  return off;
}

describe('the stylesheet’s scales (docs/web-pages.md, "UI rules")', () => {
  const SOURCE = readFileSync(new URL("src/web/kopje.css", PACKAGE), "utf8");

  it("defines the spacing and type scales on :root", () => {
    const root = declarations(SOURCE, true).filter(({ selector }) => selector === ":root");
    const value = (name: string) => root.find(({ property }) => property === `--${name}`)?.value;
    expect(["s1", "s2", "s3", "s4", "s5", "s6", "pad"].map(value)).toEqual([
      "0.25rem",
      "0.5rem",
      "0.75rem",
      "1rem",
      "1.5rem",
      "2.5rem",
      "var(--s5)",
    ]);
    expect(["t1", "t2", "t3", "t4", "t5"].map(value)).toEqual(["0.875rem", "1rem", "1.125rem", "1.5rem", "2rem"]);
  });

  it("spaces, sets type, rounds and colours only by the tokens, its exceptions commented", () => {
    expect(declarations(SOURCE).length).toBeGreaterThan(300);
    expect(offScale(SOURCE)).toEqual([]);
  });

  it("flags each kind of declaration off the scales, and passes the scales and commented exceptions", () => {
    const flagged = [
      "a { margin: 0.6rem; }",
      "a { padding: 0 1.25rem; }",
      "a { gap: 12px; }",
      "a { column-gap: var(--t1); }",
      "a { margin-top: -1px; }",
      "a { margin: calc(-1 * var(--s3)); }",
      "a { margin-top: 0.75em; }",
      "/* a comment */ a { padding: 0.4rem; }",
      "a { font-size: 0.9375rem; }",
      "a { font-size: 0.92em; }",
      "a { font-weight: 700; }",
      "a { font-weight: 500; }",
      "a { line-height: 1.45; }",
      "a { font: 600 1rem sans-serif; }",
      "a { & b { gap: 1rem; } }",
      "a { border-radius: 8px; }",
      "a { color: #fff; }",
      "a { background: light-dark(#2228, #0009); }",
      "a { border-color: rgb(0 0 0); }",
      "a { border-top-left-radius: 8px; }",
      "a { border-start-end-radius: var(--r-pill) 4px; }",
      "a { color: red; }",
      "a { outline: 2px solid RebeccaPurple; }",
      "a { color: oklch(0.5 0.1 200); }",
      "a { background: hsl(0 0% 0%); }",
      "a { fill: color-mix(in srgb, var(--ink), white); }",
      "a { top: calc(100% + 3px); }",
      "a { inset-inline-start: 1rem; }",
      "a { left: -10rem; }",
      "h1 span { font-weight: 700; }",
      "a { block-size: 1.2em; }",
      ".x { & h2 a { font-weight: 700; } }",
    ];
    for (const css of flagged) {
      expect(offScale(css), css).toHaveLength(1);
    }
    const passed = [
      "a { margin: 0 auto; padding: var(--s2) var(--pad); gap: 0 var(--s3); row-gap: var(--s6); }",
      "a {\n\t/* Bleed: over the banner. */\n\tmargin-top: -1.75rem;\n}",
      "a { /* Bleed. */ margin: calc(-1 * var(--s3)); }",
      "a { /* Rich content. */ margin-top: 0.75em; }",
      "a { font-size: var(--t1); font-weight: 600; line-height: 1.6; font: inherit; }",
      "h1, h2 { font-weight: 700; line-height: 1.25; } .x > h2 { font-weight: 700; }",
      "a { /* A control. */ line-height: 1.1; } a { --s9: 3px; }",
      "a::before { content: '; gap: 9px'; }",
      "a { border-radius: var(--r-pill); color: var(--ink); } :root { --x: #fff; color: light-dark(#000, #fff); }",
      "a { border-top-left-radius: var(--r-card); color: transparent; border-color: currentColor; }",
      "a { font-family: 'Red Hat', Tan; content: 'red'; }",
      "a { inset: 0; top: 100%; left: var(--s4); inset-block-start: -50%; }",
      "a {\n\t/* Geometry: past the avatar. */\n\tinset-inline-start: calc(var(--pad) + 21px);\n}",
      "h1.oneline, h2 { font-weight: 700; } .x { & > h3 { font-weight: 700; } }",
      "a {\n\t/* Em: an emoji. */\n\tblock-size: 1.2em;\n\tinline-size: 2rem;\n}",
    ];
    for (const css of passed) {
      expect(offScale(css), css).toEqual([]);
    }
  });

  it("refuses a stylesheet it cannot parse rather than skip what it could not read", () => {
    for (const css of ["a { gap 9px; }", "a { gap: var(--s3; }", "a { .b { gap: 9px; } }", "a, { gap: 9px; }"]) {
      expect(() => offScale(css), css).toThrow(/is expected/);
    }
    expect(offScale("a { gap: 9px; }")).toHaveLength(1);
  });
});

// The token definitions off their scales (docs/web-pages.md, "UI rules"): a token is defined exactly once, in the
// top-level :root, the scale tokens at their canonical values (the spacing, type and radius scales and --pad as
// docs/web-pages.md gives them), a scheme colour as light-dark() of two hex colours, the font stacks as written; the
// only other definitions are the documented exceptions, --pad as a step in a media query's :root (narrow screens) and
// --tone as a colour token in a status's rule (alerts and chips). No custom property is registered (@property, which
// could give one an initial value of its own). So a component cannot redefine a token (`.who { --s3: 13px }`, a second
// :root) to pass the declaration guards with var(--s3).
const CANONICAL: Record<string, string> = {
  "--s1": "0.25rem",
  "--s2": "0.5rem",
  "--s3": "0.75rem",
  "--s4": "1rem",
  "--s5": "1.5rem",
  "--s6": "2.5rem",
  "--pad": "var(--s5)",
  "--t1": "0.875rem",
  "--t2": "1rem",
  "--t3": "1.125rem",
  "--t4": "1.5rem",
  "--t5": "2rem",
  "--r-control": "10px",
  "--r-inset": "12px",
  "--r-card": "16px",
  "--r-pill": "999px",
};
const FONT_STACKS = new Set(["--sans", "--mono"]);
const SCHEME_COLOUR = /^light-dark\(#[0-9a-f]{3,8},\s*#[0-9a-f]{3,8}\)$/;

function offScaleTokens(css: string): string[] {
  const registered = readSheet(css)
    .atrules.filter((name) => name === "property")
    .map((name) => `@${name}`);
  const defined = declarations(css, true);
  const colours = new Set(
    defined.filter((d) => d.selector === ":root" && SCHEME_COLOUR.test(d.value)).map((d) => d.property),
  );
  const seen = new Set<string>();
  const off = defined
    .filter(({ selector, property, value }) => {
      if (selector === ":root") {
        // A second definition is off whatever its value: the top-level :root defines each token once.
        const again = seen.has(property);
        seen.add(property);
        const canonical = CANONICAL[property];
        const valid =
          canonical !== undefined ? value === canonical : FONT_STACKS.has(property) || SCHEME_COLOUR.test(value);
        return again || !valid;
      }
      if (/^@media\b[^{]*:root$/.test(selector)) {
        return !(property === "--pad" && /^var\(--s[1-6]\)$/.test(value));
      }
      const token = /^var\((--[a-z0-9-]+)\)$/.exec(value)?.[1];
      return !(property === "--tone" && token !== undefined && colours.has(token));
    })
    .map(({ selector, property, value }) => `${selector} { ${property}: ${value} }`);
  return [...registered, ...off];
}

describe('the stylesheet’s tokens (docs/web-pages.md, "UI rules")', () => {
  const SOURCE = readFileSync(new URL("src/web/kopje.css", PACKAGE), "utf8");

  it("defines each token once at its scale, and redefines only --pad and --tone where documented", () => {
    expect(declarations(SOURCE, true).length).toBeGreaterThan(40);
    expect(offScaleTokens(SOURCE)).toEqual([]);
  });

  it("flags a token redefined off its scale or outside the documented exceptions", () => {
    const root = ":root { --ink: light-dark(#000, #fff); --s3: 0.75rem; } ";
    const flagged = [
      ".who { --s3: 13px; gap: var(--s3); }",
      ".who { --s3: 0.75rem; }",
      ".x { --t2: 1rem; }",
      ".x { --r-card: 16px; }",
      ".x { --ink: #000; }",
      ".x { --pad: var(--s4); }",
      ".x { & .y { --s1: 1px; } }",
      ":root { --s3: 13px; }",
      ":root { --t1: 14px; }",
      ":root { --r-card: 1rem; }",
      ":root { --pad: 1rem; }",
      ":root { --accent: #8a5a00; }",
      ":root { --accent: light-dark(red, blue); }",
      "@media (width < 44rem) { :root { --pad: 12px; } }",
      "@media (width < 44rem) { :root { --s4: 1rem; } }",
      ".alert { --tone: #f00; }",
      ".alert { --tone: var(--s1); }",
      ".alert { --other: var(--ink); }",
      // A second top-level :root, at the scale or off it, and a value that is a step but not the canonical one.
      ":root { --s3: 13rem; }",
      ":root { --s3: 0.75rem; }",
      ":root { --s2: 0.6rem; }",
      ":root { --pad: var(--s4); }",
      // A registered custom property, at any depth.
      '@property --s3 { syntax: "<length>"; inherits: true; initial-value: 13px; }',
      '@media (width < 44rem) { @property --x { syntax: "*"; inherits: false; } }',
      '.x { @supports (display: grid) { @property --y { syntax: "*"; inherits: false; } } }',
    ];
    for (const css of flagged) {
      expect(offScaleTokens(root + css), css).toHaveLength(1);
    }
    const passed = [
      ":root { --s1: 0.25rem; --t5: 2rem; --r-pill: 999px; --pad: var(--s5); --sans: system-ui, sans-serif; }",
      ":root { --ink: light-dark(#22201b, #ece6d8); --scrim: light-dark(#2228, #0009); }",
      "@media (width < 44rem) { :root { --pad: var(--s4); } }",
      ":root { --ok: light-dark(#000, #fff); } :where(.alert) { &.ok { --tone: var(--ok); } }",
    ];
    for (const css of passed) {
      expect(offScaleTokens(css), css).toEqual([]);
    }
  });
});

// The classes a stylesheet's selectors name.
function selectorClasses(css: string): string[] {
  const found = new Set<string>();
  for (const list of readSheet(css).selectors) {
    walkCss(list, (node) => {
      if (node.type === "ClassSelector") {
        found.add(node.name);
      }
    });
  }
  return [...found].toSorted();
}

// What names a class: a JSX `class` or `className` attribute, a `class:` or `className:` property (a component's
// props), or an explicit class map, a constant a class expression reads (AVATAR_CLASS, ALERT_STATUS).
const CLASS_NAMES = new Set(["class", "className"]);

function classValue(node: Node): Node | null {
  if (node.type === "JSXAttribute" && node.name.type === "JSXIdentifier" && CLASS_NAMES.has(node.name.name)) {
    return node.value;
  }
  if (node.type === "Property" && !node.computed) {
    const key = node.key.type === "Identifier" ? node.key.name : node.key.type === "Literal" ? node.key.value : null;
    return typeof key === "string" && CLASS_NAMES.has(key) ? node.value : null;
  }
  return null;
}

// The const a node initializes, or is a part of the initializer of (a record's value), or null.
function initializedConstant(parents: readonly Node[]): string | null {
  for (const [i, parent] of parents.entries()) {
    if (parent.type === "VariableDeclarator") {
      const declaration = parents[i + 1];
      return parent.id.type === "Identifier" &&
        declaration?.type === "VariableDeclaration" &&
        declaration.kind === "const"
        ? parent.id.name
        : null;
    }
    if (/Function|Class|Program/.test(parent.type)) {
      return null;
    }
  }
  return null;
}

// The whole tokens of the class-bearing string and template literals of the sources: inside a class expression, or a
// value of a class map. A literal elsewhere (a stray 'ghost') keeps no class alive.
function classTokens(files: readonly Source[]): Set<string> {
  const tokens = new Set<string>();
  for (const source of files) {
    const { program, literals } = parse(source);
    const maps = new Set<string>();
    walk(program, (node) => {
      const value = classValue(node);
      if (value !== null) {
        walk(value, (inner) => {
          if (inner.type === "Identifier") {
            maps.add(inner.name);
          }
        });
      }
    });
    for (const literal of literals) {
      const constant = initializedConstant(literal.parents);
      if (
        !literal.parents.some((parent) => classValue(parent) !== null) &&
        (constant === null || !maps.has(constant))
      ) {
        continue;
      }
      // A string joined to another value ('ghost' + '-row') is a fragment, no class.
      if (literal.parents[0]?.type === "BinaryExpression" && literal.parents[0].operator === "+") {
        continue;
      }
      for (const token of wholeTokens(literal.parts)) {
        tokens.add(token);
      }
    }
  }
  return tokens;
}

// The whitespace-separated tokens of a literal's text, whole: a token that touches an interpolation (`av${n}`,
// `${a}-row`) is part of a class built from a value, so it is none.
function wholeTokens(parts: readonly ({ text: string } | object)[]): string[] {
  const found: string[] = [];
  parts.forEach((part, i) => {
    if (!("text" in part)) {
      return;
    }
    const words = part.text.split(/\s+/);
    const from = i > 0 && !/^\s/.test(part.text) ? 1 : 0;
    const to = i < parts.length - 1 && !/\s$/.test(part.text) ? words.length - 1 : words.length;
    found.push(...words.slice(from, to).filter((word) => word !== ""));
  });
  return found;
}

// Sanitized content's own classes, which stored HTML carries and no source writes (src/security/html.ts,
// ALLOWED_CLASS, Mastodon's): the stylesheet hides or marks them.
const CONTENT_CLASSES = new Set(["invisible", "ellipsis", "quote-inline"]);

// The classes the stylesheet styles that no class-bearing literal of the sources names: rules nothing renders.
function unusedClasses(css: string, files: readonly Source[]): string[] {
  const tokens = classTokens(files);
  return selectorClasses(css).filter((name) => !tokens.has(name) && !CONTENT_CLASSES.has(name));
}

// A button's kinds (docs/web-pages.md, "UI rules"): the modifiers a selector puts on a button or .btn, and the one
// component a button styles of its own (the ALT badge).
const BUTTON_KINDS = new Set(["primary", "quiet", "danger", "icon", "alt"]);

const isButton = (node: CssNode) =>
  (node.type === "TypeSelector" && node.name === "button") || (node.type === "ClassSelector" && node.name === "btn");

// Every class a compound that is a button puts on it, wherever in the compound it is written (before or after the
// type, after a pseudo-class, inside :is() or :where()): a compound is a button by its type or by .btn, at any depth
// (an :is() or :where() offering either).
function buttonModifiers(css: string): string[] {
  return readSheet(css)
    .selectors.flatMap((list) => list.children.toArray() as Selector[])
    .flatMap((selector) =>
      compounds(selector).flatMap((compound) => {
        if (!compound.some((node) => contains(node, isButton))) {
          return [];
        }
        const classes: string[] = [];
        for (const node of compound) {
          walkCss(node, (inner) => {
            if (inner.type === "ClassSelector" && inner.name !== "btn") {
              classes.push(inner.name);
            }
          });
        }
        return classes;
      }),
    );
}

describe("the stylesheet’s classes", () => {
  const SOURCE = readFileSync(new URL("src/web/kopje.css", PACKAGE), "utf8");
  const SRC = sources("src");

  it("styles only classes the source names, each as a literal", () => {
    expect(selectorClasses(SOURCE).length).toBeGreaterThan(80);
    expect(unusedClasses(SOURCE, SRC)).toEqual([]);
    // Each content class is one the sanitizer keeps.
    const sanitizer = readFileSync(new URL("src/security/html.ts", PACKAGE), "utf8");
    for (const name of CONTENT_CLASSES) {
      expect(sanitizer, name).toMatch(new RegExp(`ALLOWED_CLASS = .*\\b${name}\\b`));
    }
  });

  it("flags a rule nothing renders, and a class whose literal is gone", () => {
    expect(unusedClasses(".who { gap: 0; } .unused-x {} .who .id:hover {}", SRC)).toEqual(["unused-x"]);
    const without: Source[] = [{ path: "src/x.tsx", text: "export const a = <p class=\"other\">{`id ${'x'}`}</p>" }];
    expect(unusedClasses(".who {} .other {} .id {}", without)).toEqual(["id", "who"]);
    // A stray string is no class: only a class attribute or property, or a map a class expression reads, names one.
    const stray: Source[] = [
      {
        path: "src/z.tsx",
        text: [
          "const label = 'ghost'",
          "const MAP = { a: 'mapped' }",
          "const OTHER = { a: 'loose' }",
          "export const z = <p class={MAP.a} title={label} />",
          "export const props = { class: 'prop', title: 'titled' }",
          "export const joined = <p class={'ghost' + '-row'} />",
          "export const built = (n: string) => <p class={`row ${n}-x half${n}`} />",
        ].join("\n"),
      },
    ];
    expect(
      unusedClasses(".ghost {} .mapped {} .loose {} .prop {} .titled {} .ghost-row {} .row {} .half {}", stray),
    ).toEqual(["ghost", "ghost-row", "half", "loose", "titled"]);
    // Not a literal: a class built from a value, or named in a comment.
    const built: Source[] = [{ path: "src/y.ts", text: "// av40\nexport const c = (n: number) => `av${n}`" }];
    expect(unusedClasses(".av40 {}", built)).toEqual(["av40"]);
  });

  it("gives buttons only their kinds: primary, quiet, danger and icon, and the ALT badge", () => {
    const modifiers = buttonModifiers(SOURCE);
    expect(modifiers.length).toBeGreaterThan(3);
    expect(modifiers.filter((name) => !BUTTON_KINDS.has(name))).toEqual([]);
    expect(buttonModifiers(".btn.off {}")).toEqual(["off"]);
    expect(buttonModifiers(":is(button, .btn) { &.ghost {} } .meta .btn.quiet {} button.x {}")).toEqual([
      "ghost",
      "quiet",
      "x",
    ]);
    expect(buttonModifiers(".btnish.x {} .button.y {} .card.pad {}")).toEqual([]);
    // Wherever the compound writes it: before the button, after a pseudo-class, inside :is().
    for (const css of [".ghost.btn {}", "button:hover.ghost {}", ".btn:is(.ghost) {}", ":where(button).ghost {}"]) {
      expect(buttonModifiers(css), css).toEqual(["ghost"]);
    }
  });
});

describe("the stylesheet’s publication", () => {
  it("names the file holding the stylesheet’s bytes by their hash, and serves the source minified", () => {
    const hash = createHash("sha256").update(SERVED).digest("hex").slice(0, 10);
    expect(STYLESHEET).toBe(`/assets/kopje.${hash}.css`);
    expect(SERVED.equals(stylesheet(fileURLToPath(PACKAGE)))).toBe(true);
    expect(SERVED.byteLength).toBeLessThan(readFileSync(new URL("src/web/kopje.css", PACKAGE)).byteLength);
    expect(CSS).not.toContain("/*");
  });

  it("keeps the previous release’s stylesheet and no older one", () => {
    const kept = ASSET_NAMES.filter((name) => /^kopje(\.[0-9a-f]{10})?\.css$/.test(name)).toSorted();
    const expected = [STYLESHEET, PREVIOUS_STYLESHEET].map((path) => path.slice("/assets/".length));
    expect(kept).toEqual([...new Set(expected)].toSorted());
  });

  it("is what scripts/build-assets.mjs writes", () => {
    // Against the latest release tag when the history has it; a shallow clone falls back to the recorded file
    // (scripts/build-assets.mjs), and the packing job, with the whole history, requires the tags.
    const root = fileURLToPath(PACKAGE);
    expect(drift(root, releaseForCheck(root).released)).toEqual([]);
  });

  it("serves the fingerprinted assets as immutable, and nothing else", () => {
    for (const name of ASSET_NAMES) {
      const headers = headerLinesOf(`/assets/${name}`);
      expect(headers, name).toContain("X-Content-Type-Options: nosniff");
      const fingerprinted = /^kopje\.[0-9a-f]{10}\.(css|js)$/.test(name);
      expect(headers.includes(IMMUTABLE), name).toBe(fingerprinted);
    }
    for (const path of ["/assets/kopje.0123456789.css", "/assets/kopje.0123456789.js"]) {
      expect(headerLinesOf(path), path).toContain(IMMUTABLE);
    }
    for (const path of ["/assets/kopje.css", "/assets/embed.js", "/assets/embed-status.js", "/assets/avatar.jpg"]) {
      expect(headerLinesOf(path), path).not.toContain(IMMUTABLE);
    }
  });

  it("gives each asset the headers the browser job serves it with", () => {
    const headersOf = (path: string) =>
      Object.fromEntries(
        headerLinesOf(path).map((line) => {
          const at = line.indexOf(":");
          return [line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim()];
        }),
      );
    expect(headersOf(STYLESHEET)).toEqual(FINGERPRINTED_HEADERS);
    expect(headersOf(L1_SCRIPT)).toEqual(FINGERPRINTED_HEADERS);
    for (const path of ["/assets/embed-status.js", "/assets/avatar.jpg", "/assets/favicon.ico"]) {
      expect(ASSET_NAMES, path).toContain(path.slice("/assets/".length));
      expect(headersOf(path), path).toEqual(ASSET_HEADERS);
    }
  });
});
