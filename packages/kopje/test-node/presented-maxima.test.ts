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

/** The table whose header row starts with `| <first>`, its separator left out; the header must be unique. */
function table(first: string): Row[] {
  const lines = DOCUMENT.split("\n");
  const starts = lines.flatMap((line, i) => (line.startsWith(`| ${first} `) ? [i] : []));
  expect(starts, `one table headed "${first}"`).toHaveLength(1);
  const rows: Row[] = [];
  for (const line of lines.slice(starts[0]! + 2)) {
    if (!line.startsWith("|")) break;
    const [label = "", ...cells] = line
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim());
    rows.push({ label, cells });
  }
  return rows;
}

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
    const rows = table("Shape");
    const expected = maximaRows();
    expect(rows.map((row) => row.label)).toEqual([...expected.keys(), ...OTHER_ROWS]);
    compare(rows, expected);
  });
});

describe("the heap tables (RES-3)", () => {
  const peaks = (rows: [string, keyof typeof HEAP_PEAKS][], cells: (p: Peaks) => string[]) =>
    new Map(rows.map(([label, name]) => [label, cells(HEAP_PEAKS[name])]));

  it("states the item rows and the rejected items' objects the peaks test asserts", () => {
    const rows = table("Item");
    expect(rows.map((row) => row.label)).toEqual(ITEMS.map(([label]) => label));
    compare(
      rows,
      peaks(ITEMS, (p) => [mb(p.rows), mb(p.rejected)]),
    );
  });

  it("states the answers' peaks the peaks test asserts", () => {
    const rows = table("Answer (Store isolate)");
    expect(rows.map((row) => row.label)).toEqual(ANSWERS.map(([label]) => label));
    compare(
      rows,
      peaks(ANSWERS, (p) => [mb(p.normal), mb(p.backstop), mb(p.single)]),
    );
    // The phases' Store peak is the timelines'.
    const phases = table("Phase");
    for (const [label, peak] of [
      ["Peak, normal", HEAP_PEAKS.timelines.normal],
      ["Peak, the backstop fired", HEAP_PEAKS.timelines.backstop],
    ] as const) {
      expect(phases.find((row) => row.label === label)?.cells[0], label).toBe(mb(peak));
    }
  });
});
