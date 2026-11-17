import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import fixture from "../test/fixtures/upgrade-phases.json" with { type: "json" };

// docs/upgrade.md, "What the Store serves in each state", states test/fixtures/upgrade-phases.json, which
// test/upgrade-phases.test.ts holds the Store's kernel to over every state its health can report. Its table of rules
// has the fixture's rules in order, and its table of examples the fixture's examples in order: the headings, a cell
// under each, and each cell as the fixture gives it. The passages on `limits.cpu_ms` (docs/upgrade.md, docs/setup.md
// and the template's wrangler.jsonc) describe the two stopped examples in the words of the rules they match.

const KINDS = ["read", "session", "write", "media-delete", "media-rebuild"] as const;
type Kind = (typeof KINDS)[number];
type Rule = {
  schema: string;
  hold: "any" | "set" | null;
  upgrading: "any" | boolean;
  refusals: Record<Kind, string | null>;
  readonly: boolean;
};
type Example = { id: string; label: string; schema: string; hold: string | null; upgrading: boolean };

const { rules: RULES, examples: EXAMPLES } = fixture as unknown as {
  rules: readonly Rule[];
  examples: readonly Example[];
};

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const RULE_HEADER = [
  "`schema.status`",
  "`hold`",
  "`upgrading`",
  "Reads",
  "Sign-in",
  "Writes",
  "Refused as",
  "Inbox",
  "Actor, WebFinger, NodeInfo",
  "`readonly`",
];
const EXAMPLE_HEADER = ["How the Store gets there", "`schema.status`", "`hold`", "`upgrading`"];

const code = (value: string | boolean | null) => `\`${String(value)}\``;

// The reasons a rule refuses with, each once ("hold": the hold's own).
const reasons = (r: Rule) => [...new Set(KINDS.flatMap((kind) => r.refusals[kind] ?? []))];

// A rule's cells, as the document writes them. One "Writes" cell stands for every kind that writes, and one "Refused
// as" cell for every refused kind; the first test below holds each rule to that.
function ruleCells(r: Rule): string[] {
  const answer = (kind: Kind) => (r.refusals[kind] === null ? "served" : "503");
  const refused = reasons(r);
  return [
    code(r.schema),
    r.hold === "any" ? "any" : r.hold === "set" ? "a reason" : code(r.hold),
    r.upgrading === "any" ? "any" : code(r.upgrading),
    answer("read"),
    answer("session"),
    answer("write"),
    refused.length === 0 ? "—" : refused[0] === "hold" ? "the `hold`" : code(refused[0]!),
    // The inbox processes an activity only when it may write (federation/inbox.ts), and spools it otherwise.
    r.refusals.write === null ? "processed" : "spooled",
    // A refused read of these answers from the snapshot (app.ts, federation/snapshot.ts).
    r.refusals.read === null ? "served" : "snapshot",
    code(r.readonly),
  ];
}

const exampleCells = (e: Example) => [e.label, code(e.schema), code(e.hold), code(e.upgrading)];

// The one rule an example's state matches.
function ruleOf(e: Example): Rule {
  const matched = RULES.filter(
    (r) =>
      r.schema === e.schema &&
      (r.hold === "any" || (r.hold === "set" ? e.hold !== null : e.hold === null)) &&
      (r.upgrading === "any" || r.upgrading === e.upgrading),
  );
  expect(matched, `the rules for ${e.id}`).toHaveLength(1);
  return matched[0]!;
}

const cellsOf = (line: string) =>
  line
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());

/** The rows of the one table under `heading` (up to the next heading), after checking its headings and each row's
 * cell count. */
function table(text: string, heading: string, header: readonly string[]): string[][] {
  const lines = text.split("\n");
  const at = lines.indexOf(heading);
  expect(at, `the heading "${heading}"`).toBeGreaterThan(-1);
  const end = lines.findIndex((line, i) => i > at && line.startsWith("#"));
  const section = lines.slice(at + 1, end === -1 ? undefined : end);
  const starts = section.flatMap((line, i) => (line.startsWith("|") && !section[i - 1]?.startsWith("|") ? [i] : []));
  expect(starts, `one table under "${heading}"`).toHaveLength(1);
  const start = starts[0]!;
  expect(cellsOf(section[start]!), "the headings").toEqual(header);
  expect(cellsOf(section[start + 1]!).every((cell) => /^:?-+:?$/.test(cell))).toBe(true);
  const rows = [];
  for (const line of section.slice(start + 2)) {
    if (!line.startsWith("|")) {
      break;
    }
    const row = cellsOf(line);
    expect(row, `the cells of "${row[0]}"`).toHaveLength(header.length);
    rows.push(row);
  }
  return rows;
}

/** Compares the document's rows with the expected ones, printing each expected row on a mismatch. */
function compare(rows: readonly string[][], expected: readonly string[][]): void {
  const lines = expected.map((row) => `| ${row.join(" | ")} |`).join("\n");
  expect(rows, `expected rows (before oxfmt pads them):\n${lines}\n`).toEqual(expected);
}

describe("the states of an upgrade in docs/upgrade.md", () => {
  it("are the fixture's rules, each one row the document's cells can state", () => {
    for (const r of RULES) {
      const name = JSON.stringify([r.schema, r.hold, r.upgrading]);
      expect(Object.keys(r.refusals), name).toEqual([...KINDS]);
      // The "Writes" cell: the kinds that delete media or rebuild it are refused as writes are.
      expect([r.refusals["media-delete"], r.refusals["media-rebuild"]], name).toEqual([
        r.refusals.write,
        r.refusals.write,
      ]);
      // The "Refused as" cell: one reason for every refused kind, the hold's own only where a hold is set.
      expect(reasons(r).length, name).toBeLessThanOrEqual(1);
      expect(reasons(r).includes("hold") && r.hold !== "set", name).toBe(false);
      // The notes under the table: `readonly: true` means that writes are refused, and a schema that is not current
      // refuses reads and sign-ins too.
      expect(r.readonly, name).toBe(r.refusals.write !== null);
      if (r.schema !== "current") {
        expect([r.refusals.read, r.refusals.session], name).not.toContain(null);
      }
    }
  });

  it("are stated by its table of rules", () => {
    const rows = table(read("docs/upgrade.md"), "### What the Store serves in each state", RULE_HEADER);
    compare(rows, RULES.map(ruleCells));
  });

  it("are reached as its table of examples says, each example in one rule", () => {
    const rows = table(read("docs/upgrade.md"), "#### How a Store reaches each state", EXAMPLE_HEADER);
    compare(rows, EXAMPLES.map(exampleCells));
    for (const e of EXAMPLES) {
      ruleOf(e);
    }
  });
});

// The words for a stopped example: "refuses every request" when its rule admits nothing, "readonly" when it admits
// reads and sessions only.
function words(e: Example): string {
  const admitted = KINDS.filter((kind) => ruleOf(e).refusals[kind] === null);
  if (admitted.length === 0) {
    return "refuses every request";
  }
  expect(admitted, `${e.id}: the words for what it admits`).toEqual(["read", "session"]);
  return "readonly";
}

function example(id: string): Example {
  const found = EXAMPLES.find((e) => e.id === id);
  if (found === undefined) {
    throw new Error(`no example ${id} in the fixture`);
  }
  return found;
}

// The paragraph or comment that mentions `marker`, its lines joined, without comment markers.
function passage(text: string, marker: string, comment: boolean): string {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.includes(marker));
  expect(at, `a line with ${marker}`).toBeGreaterThan(-1);
  const within = comment
    ? (line: string) => line.trimStart().startsWith("//")
    : (line: string) => line.trim() !== "" && !line.startsWith("#");
  let start = comment ? at - 1 : at;
  while (start > 0 && within(lines[start - 1]!)) {
    start -= 1;
  }
  let end = comment ? at : at + 1;
  while (!comment && end < lines.length && within(lines[end]!)) {
    end += 1;
  }
  return lines
    .slice(start, end)
    .map((line) => line.replace(/^\s*\/\/\s?/, "").trim())
    .join(" ");
}

describe("the documents on limits.cpu_ms", () => {
  const stoppedApplying = example("stopped-applying");
  const stoppedVerifying = example("stopped-verifying");

  it.each([
    ["docs/upgrade.md", '`"limits": { "cpu_ms": 60000 }`', false],
    ["docs/setup.md", "`limits.cpu_ms`", false],
    ["../../deploy/wrangler.jsonc", '"limits": { "cpu_ms": 60000 }', true],
  ] as const)("%s describes the two stopped examples as the fixture does", (path, marker, comment) => {
    // Stopped while applying: the schema is pending. Stopped before verifying: current, and still upgrading.
    expect(stoppedApplying).toMatchObject({ schema: "pending", hold: null });
    expect(stoppedVerifying).toMatchObject({ schema: "current", upgrading: true, hold: null });
    const text = passage(read(path), marker, comment);
    const said = new RegExp(
      `the Store ${words(stoppedApplying)}\\b[^.]* while migrations remain unapplied\\b[^.]*\\bstays ${words(stoppedVerifying)} (?:once they are applied but not yet verified|until they are verified)`,
    );
    expect(text).toMatch(said);
  });
});
