import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { deviationIds } from "../test/mastodon-conformance.js";

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

// The cited ids `defined` lacks, as `path:line: id`.
function undefinedIds(files: readonly File[], defined: ReadonlySet<string>): string[] {
  const families = [...new Set([...defined].filter((id) => id.includes("-")).map((id) => id.split("-")[0]))];
  const hyphenated = new RegExp(`\\b(?:${families.join("|")})-\\d+[a-z]?\\b`, "g");
  const found: string[] = [];
  for (const { path, text } of files) {
    const rules = path.startsWith("packages/kopje/src/") || path.endsWith(".md");
    text.split("\n").forEach((line, i) => {
      const ids = [...line.matchAll(hyphenated)].map((m) => m[0]);
      if (rules) {
        ids.push(...(line.match(/\bR\d+\b/g) ?? []));
      }
      for (const id of ids.filter((cited) => !defined.has(cited))) {
        found.push(`${path}:${i + 1}: ${id}`);
      }
    });
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
});
