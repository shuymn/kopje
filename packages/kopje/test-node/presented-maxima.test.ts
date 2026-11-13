import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  COLUMN_FILL,
  CONSERVATIVE_JSON,
  FILL_SHAPES,
  FILLS,
  HEAP_PEAKS,
  MOVED_ACCOUNT_MAXIMA,
  NOTE_MAXIMA,
  type Peaks,
  type Shape,
  type ShapeName,
} from "../test/presented-maxima.js";

// docs/threat-model.md "Maxima of presented units" and "Heap at 8 MiB per answer" (RES-3) state the figures
// test/status-bounds.test.ts asserts from test/presented-maxima.ts: each cell of their tables equals the module's
// figure, written as the document writes it.

const DOCUMENT = readFileSync(new URL("../docs/threat-model.md", import.meta.url), "utf8");
const ANSWER_BYTES = 8 * 1024 * 1024;

type Row = { label: string; cells: string[] };

const cellsOf = (line: string) =>
  line
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());

/** The rows of the one table whose first heading is `header[0]`, after checking every heading (names, order, units)
 * and that each row has a cell for each heading. */
function table(header: readonly string[]): Row[] {
  const lines = DOCUMENT.split("\n");
  const starts = lines.flatMap((line, i) => (line.startsWith(`| ${header[0]} `) ? [i] : []));
  expect(starts, `one table headed "${header[0]}"`).toHaveLength(1);
  expect(cellsOf(lines[starts[0]!]!), `the headings of "${header[0]}"`).toEqual(header);
  const rows: Row[] = [];
  for (const line of lines.slice(starts[0]! + 2)) {
    if (!line.startsWith("|")) break;
    const [label = "", ...cells] = cellsOf(line);
    expect(cells, `the cells of "${label}"`).toHaveLength(header.length - 1);
    rows.push({ label, cells });
  }
  return rows;
}

const MAXIMA_HEADER = [
  "Shape",
  "Most SQLite bytes",
  "Most JSON bytes",
  "Conservative JSON",
  "Rows read",
  "Nodes",
  "Share of 8 MiB",
];
const ITEM_HEADER = ["Item", "Rows, with 25% headroom", "Rejected-item objects"];
const ANSWER_HEADER = [
  "Answer (Store isolate)",
  "Normal",
  "Backstop fired, the dropped chunk still live",
  "A single item",
];
const PHASE_HEADER = ["Phase", "Store isolate", "Worker isolate"];
const PHASES = [
  "RPC copy (serialized; deserialized in the Worker)",
  "The Worker's JSON string and the body",
  "Peak, normal",
  "Peak, the backstop fired",
];

const count = (n: number | undefined) => (n === undefined ? "" : n.toLocaleString("en-US"));
const share = (n: number) => `${((100 * n) / ANSWER_BYTES).toFixed(1)}%`;
const mb = (n: number) => `${(n / 1e6).toFixed(2)} MB`;

/** Compares each row the module holds with the document's, printing the expected row on a mismatch. */
function compare(rows: readonly Row[], expected: ReadonlyMap<string, string[]>): void {
  for (const [label, cells] of expected) {
    const row = rows.find((r) => r.label === label);
    const line = `| ${[label, ...cells].join(" | ")} |`;
    expect(row?.cells, `expected row (before oxfmt pads it):\n${line}\n`).toEqual(cells);
  }
}

// The table of maxima's measured cells: each column the most any fill gives, which is COLUMN_FILL's fill.
function measured(name: ShapeName): Record<keyof Shape, number> {
  return {
    sqlite: FILL_SHAPES[COLUMN_FILL.sqlite][name].sqlite,
    json: FILL_SHAPES[COLUMN_FILL.json][name].json,
    rows: FILL_SHAPES[COLUMN_FILL.rows][name].rows,
    nodes: FILL_SHAPES[COLUMN_FILL.nodes][name].nodes,
  };
}

const SHAPE_ROWS: [string, ShapeName][] = [
  ["Account occurrence, with the account it moved to", "account"],
  ["Status", "status"],
  ["Quote (the status and its quoted status)", "quote"],
  ["Boost of a quote", "boostOfQuote"],
  ["Conversation: 12 participants presented, its last status a quote", "conversation"],
  ["Notification group: 8 sample accounts, its status a quote", "group"],
  ["Report: its first status a quote past the 2 MiB allowance", "report"],
  ["An admin.report notification of that report", "reportNotification"],
  ["A moderation_warning notification, its local account at bounds", "warningNotification"],
  ["Its notification group", "warningGroup"],
  ["A filtered favourite of the quote, as include_filtered lists it", "filteredNotification"],
];
// Rows other suites hold, derived from their caps (test/announcement-bounds.test.ts, test/trends-maxima.test.ts,
// test/instance-activity.test.ts); this module does not.
const OTHER_ROWS = [
  "Announcement: each part derived from its caps",
  "Trending hashtag (Tag with history), derived from its caps",
  "Listed hashtag (search, followed, suggested), from its caps",
  "Access admin's trending hashtag, derived from its caps",
  "Access admin's trending status, derived from its caps",
  "Trending link (TrendsLink), derived from its caps",
  "Access admin's trending link, derived from its caps",
  "Instance activity (12 weeks), derived from its caps",
];

// Most SQLite bytes, most JSON bytes, conservative JSON, rows read, nodes, share of 8 MiB (of the conservative JSON
// where there is one).
function maximaRows(): Map<string, string[]> {
  const rows = new Map<string, string[]>();
  for (const [label, name] of SHAPE_ROWS) {
    const m = measured(name);
    const conservative = CONSERVATIVE_JSON[name];
    rows.set(label, [
      count(m.sqlite),
      count(m.json),
      count(conservative),
      count(m.rows),
      count(m.nodes),
      share(conservative),
    ]);
    if (name === "account") {
      const moved = MOVED_ACCOUNT_MAXIMA;
      rows.set("Moved-to account (nested), derived from its caps", [
        count(moved.sqlite),
        "",
        count(moved.json),
        count(moved.rows),
        "",
        share(moved.json),
      ]);
    }
  }
  const note = NOTE_MAXIMA;
  rows.set("ActivityPub Note: a local status at its bounds, 1,000 addressed", [
    count(note.sqlite),
    count(note.note),
    "",
    count(note.rows),
    count(note.nodes),
    share(note.note),
  ]);
  rows.set("Its Create (the Note and its addressing again)", ["", count(note.create), "", "", "", share(note.create)]);
  return rows;
}

const ITEMS: [string, keyof typeof HEAP_PEAKS][] = [
  ["Boost of a quote (the largest timeline item)", "timelines"],
  ["Group: its status (a quote), 8 sample accounts", "groups"],
  ["Report: its status and 4 accounts", "reports"],
];
const ANSWERS: [string, keyof typeof HEAP_PEAKS][] = [
  ["Timelines (largest item a boost of a quote)", "timelines"],
  ["Groups", "groups"],
  ["Reports", "reports"],
];

describe("the table of maxima (RES-3)", () => {
  it("takes each measured column from the fill that gives every shape's most", () => {
    for (const column of Object.keys(COLUMN_FILL) as (keyof Shape)[]) {
      for (const name of Object.keys(CONSERVATIVE_JSON) as ShapeName[]) {
        const most = Math.max(...FILLS.map((fill) => FILL_SHAPES[fill][name][column]));
        expect(FILL_SHAPES[COLUMN_FILL[column]][name][column], `${column} of ${name}`).toBe(most);
      }
    }
  });

  it("states every figure the status bounds test asserts, and only rows it classifies", () => {
    const rows = table(MAXIMA_HEADER);
    const expected = maximaRows();
    expect(rows.map((row) => row.label)).toEqual([...expected.keys(), ...OTHER_ROWS]);
    compare(rows, expected);
  });
});

describe("the heap tables (RES-3)", () => {
  const peaks = (rows: [string, keyof typeof HEAP_PEAKS][], cells: (p: Peaks) => string[]) =>
    new Map(rows.map(([label, name]) => [label, cells(HEAP_PEAKS[name])]));

  it("states the item rows and the rejected items' objects the peaks test asserts", () => {
    const rows = table(ITEM_HEADER);
    expect(rows.map((row) => row.label)).toEqual(ITEMS.map(([label]) => label));
    compare(
      rows,
      peaks(ITEMS, (p) => [mb(p.rows), mb(p.rejected)]),
    );
  });

  it("states the answers' peaks the peaks test asserts", () => {
    const rows = table(ANSWER_HEADER);
    expect(rows.map((row) => row.label)).toEqual(ANSWERS.map(([label]) => label));
    compare(
      rows,
      peaks(ANSWERS, (p) => [mb(p.normal), mb(p.backstop), mb(p.single)]),
    );
    // The phases' Store peaks are the timelines'; the other cells are not the module's.
    const phases = table(PHASE_HEADER);
    expect(phases.map((row) => row.label)).toEqual(PHASES);
    expect(phases.slice(2).map((row) => row.cells[0])).toEqual([
      mb(HEAP_PEAKS.timelines.normal),
      mb(HEAP_PEAKS.timelines.backstop),
    ]);
  });
});
