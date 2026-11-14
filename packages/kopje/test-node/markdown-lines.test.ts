import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { frontMatterLines, type MarkdownNode, parseMarkdown, visit } from "./markdown.js";

// Markdown prose stays within the 120 columns of .oxfmtrc.json's printWidth, which oxfmt does not enforce on prose (it
// keeps prose wrapping as written). Each file is read through its GFM parse (markdown.ts). A line may be longer only
// where it cannot be wrapped:
// - inside a `table`, `code`, `heading` or `definition` node, a block-level `html` node (a child of the root, a list
//   item or a quote; inline HTML in a paragraph is prose), or front matter, which a line break would change;
// - when it has no break point: a space after its first word, outside a link or image node (and its reference forms),
//   whose remainder would not start a block (a list item, a heading, a quote, a table, a fence, HTML or a setext
//   underline). So a long URL or link stands on its own line, and only text that cannot move off it may follow.
// Columns are code points; a line's indentation, quote markers and list marker count.
//
// The files are the Markdown under packages/kopje and deploy/, the paths whose changes run this suite
// (scripts/test-affected.sh). The repository's other Markdown is wrapped the same way but not checked here: CI runs
// only the suites a change affects, so a check over files outside them would fail a later, unrelated change.
// Of the CHANGELOG only the `[Unreleased]` section and what precedes it are read: released entries stay as they were
// published.
const CHANGELOG = "packages/kopje/CHANGELOG.md";

const MAX = 120;
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const ROOTS = ["packages/kopje", "deploy"];
const SKIPPED = new Set(["node_modules", ".wrangler", "dist"]);
const EXEMPT = new Set(["table", "code", "heading", "definition"]);
// The parents of a block-level `html` node; an `html` node inside a paragraph is inline HTML, which prose wraps around.
const CONTAINERS = new Set(["root", "listItem", "blockquote"]);
const LINKS = new Set(["link", "image", "linkReference", "imageReference"]);

// A remainder that would start a block if a break put it at the start of a line.
const BLOCK = /^(?:[-*+](?:\s|$)|\d+[.)](?:\s|$)|#{1,6}(?:\s|$)|>|\||=+\s*$|-+\s*$|`{3}|~{3}|<)/;

function markdownFiles(): string[] {
  const walk = (path: string): string[] =>
    readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        return SKIPPED.has(entry.name) ? [] : walk(child);
      }
      return entry.name.endsWith(".md") ? [relative(ROOT, child).replaceAll("\\", "/")] : [];
    });
  return ROOTS.flatMap((dir) => walk(join(ROOT, dir))).toSorted();
}

// The part of a file the check reads: for the CHANGELOG, its lines before the first level-2 heading after the
// `## [Unreleased]` one, of the headings that are children of the root (not one in a quote or a list).
function checkedText(path: string, text: string): string {
  if (path !== CHANGELOG) {
    return text;
  }
  const headings = (parseMarkdown(text).children ?? []).filter((node) => node.type === "heading" && node.depth === 2);
  const source = (node: MarkdownNode) => text.slice(node.position?.start.offset, node.position?.end.offset);
  const unreleased = headings.findIndex((node) => source(node) === "## [Unreleased]");
  if (unreleased === -1) {
    throw new Error(`${path}: no [Unreleased] section`);
  }
  const next = headings[unreleased + 1]?.position?.start.line;
  return next === undefined
    ? text
    : text
        .split("\n")
        .slice(0, next - 1)
        .join("\n");
}

const width = (text: string) => [...text].length;

// Whether a line holding offsets [start, start + line.length) has a break point outside `links` (offset ranges).
function wrappable(line: string, start: number, links: readonly [number, number][]): boolean {
  const prefix = /^\s*(?:>\s?)*(?:(?:[-*+]|\d+[.)])\s+)?/.exec(line)?.[0] ?? "";
  const first = line.indexOf(" ", prefix.length);
  if (first === -1) {
    return false;
  }
  for (let i = first; i < line.length; i++) {
    const at = start + i;
    if (line[i] !== " " || line[i + 1] === " " || links.some(([from, to]) => at >= from && at < to)) {
      continue;
    }
    const rest = line.slice(i + 1);
    if (rest !== "" && !BLOCK.test(rest)) {
      return true;
    }
  }
  return false;
}

// The over-long prose lines of a Markdown text, as `line: text`.
function longLines(text: string): string[] {
  const exempt = new Set(frontMatterLines(text));
  const links: [number, number][] = [];
  visit(parseMarkdown(text), (node, parent) => {
    const position = node.position;
    if (position === undefined) {
      return;
    }
    if (EXEMPT.has(node.type) || (node.type === "html" && CONTAINERS.has(parent?.type ?? ""))) {
      for (let line = position.start.line; line <= position.end.line; line++) {
        exempt.add(line);
      }
    } else if (LINKS.has(node.type)) {
      links.push([position.start.offset, position.end.offset]);
    }
  });
  const found: string[] = [];
  let start = 0;
  text.split("\n").forEach((line, i) => {
    if (!exempt.has(i + 1) && width(line) > MAX && wrappable(line, start, links)) {
      found.push(`${i + 1}: ${line}`);
    }
    start += line.length + 1;
  });
  return found;
}

const lineNumbers = (found: readonly string[]) => found.map((line) => line.split(":")[0]);

describe("Markdown line length", () => {
  const files = markdownFiles();

  it("reads the package's and the template's Markdown", () => {
    expect(files).toEqual(expect.arrayContaining(["deploy/README.md", "packages/kopje/docs/threat-model.md"]));
  });

  it.each(files)("%s keeps prose within 120 columns", (path) => {
    expect(longLines(checkedText(path, readFileSync(join(ROOT, path), "utf8")))).toEqual([]);
  });

  it("reads the CHANGELOG's [Unreleased] section and no released one", () => {
    const long = "word ".repeat(30).trim();
    const changelog = [
      "# Changelog",
      "",
      "## [Unreleased]",
      "",
      `- ${long}`,
      "",
      "```md",
      "## Not a release",
      "```",
      "",
      `- ${long}`,
      "",
      "> ## Sample",
      "",
      "- ## In a list",
      "",
      `- ${long}`,
      "",
      "## [0.1.0] - 2026-01-01",
      "",
      long,
    ].join("\n");
    expect(lineNumbers(longLines(checkedText(CHANGELOG, changelog)))).toEqual(["5", "11", "17"]);
    expect(lineNumbers(longLines(checkedText("packages/kopje/docs/a.md", changelog)))).toEqual(["5", "11", "17", "21"]);
  });

  it("flags prose that can wrap and passes what cannot", () => {
    const long = "word ".repeat(30).trim();
    const url = `https://example.com/${"a".repeat(120)}`;
    // Blocks separated by blank lines, so that each is the node it shows; the flagged ones are marked.
    const blocks: [string, boolean][] = [
      ["---\ndescription: " + long + "\n---", false],
      [long, true],
      [`- ${long}`, true],
      [`  > ${long}`, true],
      [`[a link to it](${url}) and more`, true],
      [`# ${long}`, false],
      [`| ${long} |`, true],
      [`[ref]: ${url} "${long}"`, false],
      ["```\n" + long + "\n```", false],
      [url, false],
      [`  [a link to it](${url})`, false],
      [`[![an image](${url})](${url})`, false],
      [`[a link to it](${url}) -`, false],
      ["~~~~\n" + long + "\n~~~~", false],
      [`| ${long} | b |\n| --- | :-: |\n| ${long} | b |\n${long} | b`, false],
      [`| ${long} |\n| ${long} |`, true],
      // A delimiter row whose cells do not match the header's: a paragraph, not a table.
      [`| ${long} | B |\n| --- |`, true],
      // Blocks right after a table are not its rows.
      [`| a | b |\n| --- | --- |\n| c | d |\n- ${long} | tail\n\n| a | b |\n| --- | --- |\n> ${long} | tail`, true],
      [`<div>\n${long}\n</div>`, false],
      [`> <div>\n> ${long}\n> </div>`, false],
      // Inline HTML in a paragraph is prose.
      [`Press <kbd>Enter</kbd> to continue. ${long}`, true],
    ];
    const text = blocks.map(([block]) => block).join("\n\n");
    const expected: string[] = [];
    let line = 1;
    for (const [block, flagged] of blocks) {
      block.split("\n").forEach((content, i) => {
        if (flagged && width(content) > MAX) {
          expected.push(String(line + i));
        }
      });
      line += block.split("\n").length + 1;
    }
    expect(expected.length).toBeGreaterThan(8);
    expect(lineNumbers(longLines(text))).toEqual(expected);
  });
});
