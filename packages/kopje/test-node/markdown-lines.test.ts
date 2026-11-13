import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Markdown prose stays within the 120 columns of .oxfmtrc.json's printWidth, which oxfmt does not enforce on prose (it
// keeps prose wrapping as written). A line may be longer only where it cannot be wrapped:
// - inside a fenced code block, a table row, an ATX heading, a link reference definition or front matter, which a line
//   break would change;
// - when it has no break point: a space after its first word, outside a link (`[text](url)`, images included), whose
//   remainder would not start a block (a list item, a heading, a quote, a table, a fence, HTML or a setext underline).
//   So a long URL or link stands on its own line, and only text that cannot move off it may follow.
// Columns are code points; a line's indentation, quote markers and list marker count.
//
// The files are the Markdown under packages/kopje and deploy/, the paths whose changes run this suite
// (scripts/test-affected.sh). The repository's other Markdown is wrapped the same way but not checked here: the push
// hook runs only the suites a change affects, so a check over files outside them would fail a later, unrelated push.
// Of the CHANGELOG only the `[Unreleased]` section and what precedes it are read: released entries stay as they were
// published.
const CHANGELOG = "packages/kopje/CHANGELOG.md";

// The part of a file the check reads: for the CHANGELOG, its text up to the release heading after `[Unreleased]`.
function checkedText(path: string, text: string): string {
  if (path !== CHANGELOG) {
    return text;
  }
  const unreleased = text.indexOf("\n## [Unreleased]\n");
  if (unreleased === -1) {
    throw new Error(`${path}: no [Unreleased] section`);
  }
  const next = text.indexOf("\n## ", unreleased + 1);
  return next === -1 ? text : text.slice(0, next + 1);
}

const MAX = 120;
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const ROOTS = ["packages/kopje", "deploy"];
const SKIPPED = new Set(["node_modules", ".wrangler", "dist"]);

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

const width = (text: string) => [...text].length;

// Whether offset `at` of `text` is inside a link's text or destination.
function inLink(text: string, at: number): boolean {
  let brackets = 0;
  let destination = false;
  for (let i = 0; i < at; i++) {
    const c = text[i];
    if (destination) {
      destination = c !== ")";
    } else if (c === "[") {
      brackets++;
    } else if (c === "]" && brackets > 0) {
      brackets--;
      destination = text[i + 1] === "(";
    }
  }
  return brackets > 0 || destination;
}

function wrappable(line: string): boolean {
  const prefix = /^\s*(?:>\s?)*(?:(?:[-*+]|\d+[.)])\s+)?/.exec(line)?.[0] ?? "";
  const body = line.slice(prefix.length);
  const first = body.search(/ /);
  if (first === -1) {
    return false;
  }
  for (let i = first; i < body.length; i++) {
    if (body[i] === " " && body[i + 1] !== " " && !inLink(body, i)) {
      const rest = body.slice(i + 1);
      if (rest !== "" && !BLOCK.test(rest)) {
        return true;
      }
    }
  }
  return false;
}

// The over-long prose lines of a Markdown text, as `line: text`.
function longLines(text: string): string[] {
  const found: string[] = [];
  const lines = text.split("\n");
  let fence: string | null = null;
  let front = lines[0] === "---";
  lines.forEach((line, i) => {
    if (front) {
      front = i === 0 || line !== "---";
      return;
    }
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === null) {
        fence = marker;
      } else if (line.trim().startsWith(fence)) {
        fence = null;
      }
      return;
    }
    if (fence !== null || width(line) <= MAX) {
      return;
    }
    if (/^\s*\|/.test(line) || /^#{1,6}\s/.test(line) || /^\s*\[[^\]]+\]:\s/.test(line)) {
      return;
    }
    if (wrappable(line)) {
      found.push(`${i + 1}: ${line}`);
    }
  });
  return found;
}

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
      "## [0.1.0] - 2026-01-01",
      "",
      long,
    ].join("\n");
    expect(longLines(checkedText(CHANGELOG, changelog)).map((line) => line.split(":")[0])).toEqual(["5"]);
    expect(longLines(checkedText("packages/kopje/docs/a.md", changelog)).map((line) => line.split(":")[0])).toEqual([
      "5",
      "9",
    ]);
  });

  it("flags prose that can wrap and passes what cannot", () => {
    const long = "word ".repeat(30).trim();
    const url = `https://example.com/${"a".repeat(120)}`;
    const text = [
      "---",
      `description: ${long}`,
      "---",
      long,
      `- ${long}`,
      `  > ${long}`,
      `[a link to it](${url}) and more`,
      `# ${long}`,
      `| ${long} |`,
      `[ref]: ${url} "${long}"`,
      "```",
      long,
      "```",
      url,
      `  [a link to it](${url})`,
      `[![an image](${url})](${url})`,
      `[a link to it](${url}) -`,
      "~~~~",
      long,
      "~~~~",
    ].join("\n");
    expect(longLines(text).map((line) => line.split(":")[0])).toEqual(["4", "5", "6", "7"]);
  });
});
