import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import fixture from "../test/fixtures/upgrade-phases.json" with { type: "json" };

// docs/upgrade.md, "What the Store serves in each phase", states test/fixtures/upgrade-phases.json, which
// test/upgrade-phases.test.ts holds the Store's kernel to: its headings in order, a row per phase in the fixture's
// order under the phase's label, a cell under each heading, and each cell as the phase's admissions and health give it;
// and no two phases report the same health, so health tells the row. The passages on `limits.cpu_ms` (docs/upgrade.md, docs/setup.md and the template's wrangler.jsonc) describe the
// fixture's two stopped phases in the same words.

const KINDS = ["read", "session", "write", "media-delete", "media-rebuild"] as const;
type Kind = (typeof KINDS)[number];
type Health = { schema: string; readonly: boolean; upgrading: boolean; hold: string | null };
type Durable = { id: string; label: string; waits: false; refusals: Record<Kind, string | null>; health: Health };
type Phase = Durable | { id: string; label: string; waits: true };

const PHASES = fixture as unknown as readonly Phase[];

function durable(id: string): Durable {
  const found = PHASES.find((p) => p.id === id);
  if (found === undefined || found.waits) {
    throw new Error(`no durable phase ${id} in the fixture`);
  }
  return found;
}

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const HEADER = [
  "Phase",
  "Reads",
  "Sign-in",
  "Writes",
  "Refused as",
  "Inbox",
  "Actor, WebFinger, NodeInfo",
  "`schema.status`",
  "`readonly`",
  "`upgrading`",
  "`hold`",
];

const code = (value: string | boolean | null) => `\`${String(value)}\``;

// The reasons a phase refuses with, each once.
const reasons = (p: Durable) => [...new Set(KINDS.flatMap((kind) => p.refusals[kind] ?? []))];

// A phase's cells after its label, as the document writes them. One "Writes" cell stands for every kind that writes,
// and one "Refused as" cell for every refused kind; the fixture test below holds each phase to that.
function cells(p: Phase): string[] {
  if (p.waits) {
    return ["wait", "wait", "wait", "—", "wait", "wait", "wait", "wait", "wait", "wait"];
  }
  const answer = (kind: Kind) => (p.refusals[kind] === null ? "served" : "503");
  const refused = reasons(p);
  return [
    answer("read"),
    answer("session"),
    answer("write"),
    refused.length === 0 ? "—" : code(refused[0]!),
    // The inbox processes an activity only when it may write (federation/inbox.ts), and spools it otherwise.
    p.refusals.write === null ? "processed" : "spooled",
    // A refused read of these answers from the snapshot (app.ts, federation/snapshot.ts).
    p.refusals.read === null ? "served" : "snapshot",
    code(p.health.schema),
    code(p.health.readonly),
    code(p.health.upgrading),
    code(p.health.hold),
  ];
}

const cellsOf = (line: string) =>
  line
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());

/** The rows of the table under `heading`, after checking its headings and each row's cell count. */
function table(text: string, heading: string): { label: string; cells: string[] }[] {
  const lines = text.split("\n");
  const at = lines.indexOf(heading);
  expect(at, `the heading "${heading}"`).toBeGreaterThan(-1);
  const end = lines.findIndex((line, i) => i > at && line.startsWith("#"));
  const section = lines.slice(at + 1, end === -1 ? undefined : end);
  const starts = section.flatMap((line, i) => (line.startsWith("|") && !section[i - 1]?.startsWith("|") ? [i] : []));
  expect(starts, `one table under "${heading}"`).toHaveLength(1);
  const start = starts[0]!;
  expect(cellsOf(section[start]!), "the headings").toEqual(HEADER);
  expect(cellsOf(section[start + 1]!).every((cell) => /^:?-+:?$/.test(cell))).toBe(true);
  const rows = [];
  for (const line of section.slice(start + 2)) {
    if (!line.startsWith("|")) {
      break;
    }
    const [label = "", ...rest] = cellsOf(line);
    expect(rest, `the cells of "${label}"`).toHaveLength(HEADER.length - 1);
    rows.push({ label, cells: rest });
  }
  return rows;
}

describe("the upgrade phases in docs/upgrade.md", () => {
  it("are the fixture's, each as one row the document's cells can state", () => {
    expect(PHASES.filter((p) => p.waits).map((p) => p.id)).toEqual(["applying"]);
    for (const p of PHASES) {
      if (p.waits) {
        continue;
      }
      expect(Object.keys(p.refusals), p.id).toEqual([...KINDS]);
      // The "Writes" cell: the kinds that delete media or rebuild it are refused as writes are.
      expect([p.refusals["media-delete"], p.refusals["media-rebuild"]], p.id).toEqual([
        p.refusals.write,
        p.refusals.write,
      ]);
      // The "Refused as" cell: one reason for every refused kind.
      expect(reasons(p).length, p.id).toBeLessThanOrEqual(1);
      // The notes under the table: `readonly: true` means that writes are refused, and a schema that is not current
      // refuses reads and sign-ins too.
      expect(p.health.readonly, p.id).toBe(p.refusals.write !== null);
      if (p.health.schema !== "current") {
        expect([p.refusals.read, p.refusals.session], p.id).not.toContain(null);
      }
    }
  });

  it("are stated by its table, in order", () => {
    const rows = table(read("docs/upgrade.md"), "### What the Store serves in each phase");
    expect(rows.map((row) => row.label)).toEqual(PHASES.map((p) => p.label));
    for (const p of PHASES) {
      const row = rows.find((r) => r.label === p.label);
      const line = `| ${[p.label, ...cells(p)].join(" | ")} |`;
      expect(row?.cells, `expected row (before oxfmt pads it):\n${line}\n`).toEqual(cells(p));
    }
  });

  // A hold is reported before or after the transaction that records or clears the upgrade's marker commits, and a
  // rollback keeps the marker of an upgrade that did not finish, so phases that share a hold differ by `upgrading`.
  it("are each told apart by what health reports, as the notes under the table say", () => {
    const told = PHASES.flatMap((p) =>
      p.waits ? [] : [`${p.health.schema} upgrading=${p.health.upgrading} hold=${p.health.hold}`],
    );
    expect(new Set(told).size, told.join("\n")).toBe(told.length);
    const notes = read("docs/upgrade.md").replace(/\s+/g, " ");
    expect(notes).toContain(
      "Each row has its own `schema.status`, `upgrading` and `hold`, so `kopje-admin health` tells which row the Store is in.",
    );
  });
});

// The words for a stopped phase: "refuses every request" when it admits nothing, "readonly" when it admits reads and
// sessions only.
function words(p: Durable): string {
  const admitted = KINDS.filter((kind) => p.refusals[kind] === null);
  if (admitted.length === 0) {
    return "refuses every request";
  }
  expect(admitted, `${p.id}: the words for what it admits`).toEqual(["read", "session"]);
  return "readonly";
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
  const stoppedApplying = durable("stopped-applying");
  const stoppedVerifying = durable("stopped-verifying");

  it.each([
    ["docs/upgrade.md", '`"limits": { "cpu_ms": 60000 }`', false],
    ["docs/setup.md", "`limits.cpu_ms`", false],
    ["../../deploy/wrangler.jsonc", '"limits": { "cpu_ms": 60000 }', true],
  ] as const)("%s describes the two stopped phases as the fixture does", (path, marker, comment) => {
    // Stopped while applying: the schema is pending. Stopped before verifying: current, and still upgrading.
    expect(stoppedApplying.health).toMatchObject({ schema: "pending", hold: null });
    expect(stoppedVerifying.health).toMatchObject({ schema: "current", upgrading: true, hold: null });
    const text = passage(read(path), marker, comment);
    const said = new RegExp(
      `the Store ${words(stoppedApplying)}\\b[^.]* while migrations remain unapplied\\b[^.]*\\bstays ${words(stoppedVerifying)} (?:once they are applied but not yet verified|until they are verified)`,
    );
    expect(text).toMatch(said);
  });
});
