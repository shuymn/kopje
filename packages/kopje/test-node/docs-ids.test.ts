import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { deviationIds } from "../test/mastodon-conformance.js";
import { textRuns } from "./markdown.js";
import { lineOf } from "./source-scan.js";

// The ids other documents, code comments and tests cite: each threat-model entry (`- **VIS-17: ...**`), each rule of
// docs/visibility.md's rule table (`| R18 reblog, R19 favourite |`) and each accepted Mastodon departure
// (docs/mastodon-deviations.md, `- **MD-1: ...**`) is defined once.
function doc(name: string): string {
  return readFileSync(new URL(`../docs/${name}`, import.meta.url), "utf8");
}

function repeated(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
}

const threatIds = (text: string) => [...text.matchAll(/^- \*\*([A-Z]+-\d+[a-z]?):/gm)].map((m) => m[1] ?? "");

function ruleIds(text: string): string[] {
  const section = text.split("\n## The rules as the module implements them\n")[1] ?? "";
  const table = section.split("\n## ")[0] ?? "";
  return [...table.matchAll(/^\| ([^|]+)\|/gm)].flatMap((m) => (m[1] ?? "").match(/\bR\d+\b/g) ?? []);
}

// Every id cited in the package and the instance template is defined: an id of a family the threat model or the
// deviations define (`VIS-3`, `MD-2`) anywhere in their tracked text files, and a visibility rule (`R12`) in src/ and
// the Markdown. Tests also name remote accounts R0, R1, ..., so a bare R-number there is not a citation.
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const BINARY = /\.(?:png|jpe?g|ico|gif|webp)$/;

type File = { path: string; text: string };

function tracked(): File[] {
  return execFileSync("git", ["ls-files", "-z", "--", "packages/kopje", "deploy"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter((path) => path !== "" && !BINARY.test(path))
    .map((path) => ({ path, text: readFileSync(join(ROOT, path), "utf8") }));
}

function definedIds(): Set<string> {
  return new Set([
    ...threatIds(doc("threat-model.md")),
    ...ruleIds(doc("visibility.md")),
    ...deviationIds(doc("mastodon-deviations.md")),
  ]);
}

type Run = { value: string; line: number };

// The texts a range is read from, each with its first line in the file. Markdown: the text a reader sees
// (markdown.ts), so quote markers and list indentation never sit inside a range. Other files: the file itself, and each
// comment block with its markers removed, consecutive `//` lines or one `/* ... */` with each line's leading `*`.
function rangeRuns(path: string, text: string): Run[] {
  if (path.endsWith(".md")) {
    return textRuns(text);
  }
  const runs: Run[] = [{ value: text, line: 1 }];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const block: string[] = [];
    while (i + block.length < lines.length && /^\s*\/\//.test(lines[i + block.length] ?? "")) {
      block.push((lines[i + block.length] ?? "").replace(/^\s*\/\/+/, ""));
    }
    if (block.length > 1) {
      runs.push({ value: block.join("\n"), line: i + 1 });
      i += block.length - 1;
    }
  }
  for (const match of text.matchAll(/\/\*[\s\S]*?\*\//g)) {
    const inner = match[0].slice(2, -2).replace(/^[ \t]*\*(?!\/)/gm, "");
    runs.push({ value: inner, line: lineOf(text, match.index) });
  }
  return runs;
}

// The cited ids `defined` lacks, as `path:line: id`. A range (`VIS-1 to VIS-4`, `R1 to R25`, `through` or an en
// dash, across a line break too) cites each id in it, so a range over an undefined id fails: cite a list instead.
function undefinedIds(files: readonly File[], defined: ReadonlySet<string>): string[] {
  const families = [...new Set([...defined].filter((id) => id.includes("-")).map((id) => id.split("-")[0]))];
  const prefix = `(?:${families.join("|")})-`;
  const hyphenated = new RegExp(`\\b${prefix}\\d+[a-z]?\\b`, "g");
  const ranges = new RegExp(`\\b(${prefix}|R)(\\d+)\\s*(?:\\bto\\b|\\bthrough\\b|–)\\s*\\1(\\d+)\\b`, "g");
  const found: string[] = [];
  for (const { path, text } of files) {
    const rules = path.startsWith("packages/kopje/src/") || path.endsWith(".md");
    const cited = new Map<string, { line: number; id: string }>();
    const cite = (line: number, id: string) => {
      if (!defined.has(id)) {
        cited.set(`${line}:${id}`, { line, id });
      }
    };
    for (const match of text.matchAll(hyphenated)) {
      cite(lineOf(text, match.index), match[0]);
    }
    if (rules) {
      for (const match of text.matchAll(/\bR\d+\b/g)) {
        cite(lineOf(text, match.index), match[0]);
      }
    }
    for (const { value, line } of rangeRuns(path, text)) {
      for (const match of value.matchAll(ranges)) {
        const [, family = "", first = "", last = ""] = match;
        if (family !== "R" || rules) {
          for (let n = Number(first) + 1; n < Number(last); n++) {
            cite(line + lineOf(value, match.index) - 1, `${family}${n}`);
          }
        }
      }
    }
    const sorted = [...cited.values()].toSorted((a, b) => a.line - b.line);
    found.push(...sorted.map(({ line, id }) => `${path}:${line}: ${id}`));
  }
  return found;
}

describe("document ids", () => {
  it("defines each threat-model id once", () => {
    const ids = threatIds(doc("threat-model.md"));
    expect(ids.length).toBeGreaterThan(50);
    expect(repeated(ids)).toEqual([]);
  });

  it("defines each visibility rule once", () => {
    const ids = ruleIds(doc("visibility.md"));
    expect(ids.length).toBeGreaterThan(20);
    expect(repeated(ids)).toEqual([]);
  });

  it("defines each Mastodon deviation id once", () => {
    const ids = deviationIds(doc("mastodon-deviations.md"));
    expect(ids.length).toBeGreaterThan(0);
    expect(repeated(ids)).toEqual([]);
  });

  it("finds an id defined twice, and not one only cited again", () => {
    const deviations = "- **MD-1: a.** text\n- **MD-2: b.** MD-1 again\n- **MD-1: c.** text\n";
    expect(repeated(deviationIds(deviations))).toEqual(["MD-1"]);
    const threats = "- **VIS-1: a.** text\n- **VIS-2: b.** VIS-1 again\n- **VIS-1: c.** text\n";
    expect(repeated(threatIds(threats))).toEqual(["VIS-1"]);
    const rules = [
      "## The rules as the module implements them",
      "",
      "| Rule | Code |",
      "| R1 read, R2 list | R1 cited |",
      "| R2 again | x |",
      "",
      "## Next",
      "| R3 | x |",
      "| R3 | x |",
    ].join("\n");
    expect(repeated(ruleIds(`\n${rules}`))).toEqual(["R2"]);
  });

  it("defines every id the package and the template cite", () => {
    const files = tracked();
    expect(files.map((file) => file.path)).toEqual(
      expect.arrayContaining(["deploy/README.md", "packages/kopje/src/store.ts", "packages/kopje/docs/visibility.md"]),
    );
    expect(undefinedIds(files, definedIds())).toEqual([]);
  });

  // The fixtures' undefined ids are built from parts, so this file cites none.
  it("finds a cited id that is not defined, and an R-number only where it names a rule", () => {
    const defined = new Set(["VIS-1", "VIS-2", "MD-1", "R1"]);
    const missing = ["VIS-", "3"].join("");
    const files = [
      { path: "packages/kopje/src/a.ts", text: `// VIS-1, VIS-2, MD-1, R1\n// ${missing} and R2\n` },
      { path: "packages/kopje/test/a.test.ts", text: `const R0 = 4; // R1 ${["MD-", "9"].join("")}\n` },
      { path: "deploy/README.md", text: `See R7 and ${["OPS", "-1"].join("")}.\n` },
    ];
    expect(undefinedIds(files, defined)).toEqual([
      `packages/kopje/src/a.ts:2: ${missing}`,
      "packages/kopje/src/a.ts:2: R2",
      `packages/kopje/test/a.test.ts:1: ${["MD-", "9"].join("")}`,
      "deploy/README.md:1: R7",
    ]);
  });

  it("reads a range as each id in it", () => {
    const defined = new Set(["VIS-1", "VIS-2", "VIS-4", "MD-1", "MD-2", "MD-3", "R1", "R2", "R4"]);
    const range = (a: string, b: string) => `${a} to ${b}`;
    const files = [
      { path: "packages/kopje/docs/a.md", text: `(${range("VIS-1", "VIS-2")}; MD-1 through\nMD-3)\n` },
      { path: "packages/kopje/docs/b.md", text: `(VIS-1 to\nVIS-4, R1–R4)\n` },
      { path: "packages/kopje/test/a.test.ts", text: `// R1 to R4, ${range("VIS-1", "VIS-4")}\n` },
    ];
    expect(undefinedIds(files, defined)).toEqual([
      "packages/kopje/docs/b.md:1: VIS-3",
      "packages/kopje/docs/b.md:2: R3",
      "packages/kopje/test/a.test.ts:1: VIS-3",
    ]);
  });

  it("reads a range across comment lines and quote markers", () => {
    const defined = new Set(["VIS-1", "VIS-2", "VIS-4"]);
    const files = [
      { path: "packages/kopje/src/a.ts", text: "// a\n// VIS-1 to\n// VIS-4\nf();\n/* b\n * VIS-1 to\n * VIS-4 */\n" },
      { path: "packages/kopje/docs/a.md", text: "> VIS-1 to\n> VIS-4\n\n- VIS-1 to\n  VIS-4\n" },
    ];
    expect(undefinedIds(files, defined)).toEqual([
      "packages/kopje/src/a.ts:2: VIS-3",
      "packages/kopje/src/a.ts:6: VIS-3",
      "packages/kopje/docs/a.md:1: VIS-3",
      "packages/kopje/docs/a.md:4: VIS-3",
    ]);
  });
});
