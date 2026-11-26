import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ANSWER_BYTES, OUTBOX_BYTES, STATUS_ANSWER_BYTES } from "../src/domain/answer-bytes.js";
import { MAX_LIVE_ANNOUNCEMENTS } from "../src/platform/stored-bounds.js";
import {
  ANNOUNCEMENT_JSON,
  CAP_STEP,
  COLUMN_FILL,
  CONSERVATIVE_JSON,
  FILL_SHAPES,
  FILLS,
  HALF,
  HEAP_PEAKS,
  LARGE_ITEM_CHUNK_BYTES,
  MESSAGE_MAX,
  MOVED_ACCOUNT_MAXIMA,
  NOTE_MAXIMA,
  type Peaks,
  PROFILE_MAXIMA,
  SHAPE_CEILING_PERCENT,
  type Shape,
  type ShapeName,
  SPARE_FLOOR,
  STREAM_UNIT_PEAKS,
  TIMELINE_CHUNK_BYTES,
} from "../test/presented-maxima.js";

// docs/threat-model.md "Maxima of presented units" and "Heap at 8 MiB per answer" (RES-3) state the figures
// test/status-bounds.test.ts asserts from test/presented-maxima.ts: each cell of their tables equals the module's
// figure, written as the document writes it, and so do the stream unit's figures in its prose and RES-6, and every
// figure the documents give of the answer budgets (src/domain/answer-bytes.ts, whose values this reads), of an
// announcement's maximum (ANNOUNCEMENT_JSON) and of the largest row, in RES-3, the maxima and heap prose,
// docs/response-inventory.md and docs/mastodon-deviations.md.

const DOCUMENT = readFileSync(new URL("../docs/threat-model.md", import.meta.url), "utf8");
const INVENTORY = readFileSync(new URL("../docs/response-inventory.md", import.meta.url), "utf8");
const DEVIATIONS = readFileSync(new URL("../docs/mastodon-deviations.md", import.meta.url), "utf8");

/** A whole number of MiB as the documents write it. */
function mib(n: number): string {
  expect(n % (1024 * 1024), `${n} is a whole number of MiB`).toBe(0);
  return `${n / 1024 / 1024} MiB`;
}

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
  `Share of ${mib(ANSWER_BYTES)}`,
];
const ITEM_HEADER = ["Item", "Rows, with 25% headroom", "Rejected-item objects"];
const ANSWER_HEADER = [
  "Answer (Store isolate)",
  "Normal",
  "Backstop fired, the dropped chunk still live",
  "A single item",
];
const PHASE_HEADER = ["Phase", "Store isolate", "Worker isolate"];
const UNIT_HEADER = [
  "Stream unit (Store isolate)",
  "Rows, with 25% headroom",
  "Presented objects",
  "Strings and scratch",
  "Peak",
];
const UNITS: [string, keyof typeof STREAM_UNIT_PEAKS][] = [
  ["Status (`update`, `status.update`: a boost of a quote)", "status"],
  ["Conversation (its last status a quote)", "conversation"],
  ["Notification (its status, report and warning together)", "notification"],
  ["Announcement", "announcement"],
];
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

// The table of maxima's measured cells: each column the most any fill gives, which is COLUMN_FILL's fill where it
// names one.
function measured(name: ShapeName): Record<keyof Shape, number> {
  return {
    sqlite: FILL_SHAPES[COLUMN_FILL.sqlite][name].sqlite,
    json: FILL_SHAPES[COLUMN_FILL.json][name].json,
    rows: Math.max(...FILLS.map((fill) => FILL_SHAPES[fill][name].rows)),
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
// test/instance-activity.test.ts, test/scheduled-statuses.test.ts); this module does not.
const OTHER_ROWS = [
  "Announcement: each part derived from its caps",
  "Trending hashtag (Tag with history), derived from its caps",
  "Listed hashtag (search, followed, suggested), from its caps",
  "Access admin's trending hashtag, derived from its caps",
  "Access admin's trending status, derived from its caps",
  "Trending link (TrendsLink), derived from its caps",
  "Access admin's trending link, derived from its caps",
  "Instance activity (12 weeks), derived from its caps",
  "Scheduled status, derived from its caps",
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
  const profile = PROFILE_MAXIMA;
  rows.set("Profile, derived from its caps", [
    "",
    count(profile.json),
    count(profile.conservative),
    "",
    "",
    share(profile.conservative),
  ]);
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
    for (const column of Object.keys(COLUMN_FILL) as (keyof typeof COLUMN_FILL)[]) {
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
    // The announcement's row is another suite's, but its conservative JSON and share are ANNOUNCEMENT_JSON's.
    const announcement = rows.find((row) => row.label === OTHER_ROWS[0])?.cells;
    expect([announcement?.[2], announcement?.[5]]).toEqual([count(ANNOUNCEMENT_JSON), share(ANNOUNCEMENT_JSON)]);
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
    // The phases' Store peaks are the timelines'; the RPC copy is the answer's bytes, and in the Worker, as the prose
    // below the table counts it, three times them: the copy deserialized, then the JSON string at two bytes a character
    // and the body, both held at the peak.
    const phases = table(PHASE_HEADER);
    expect(phases.map((row) => row.label)).toEqual(PHASES);
    const tenth = (n: number) => `${(n / 1e6).toFixed(1)} MB`;
    const worker = `${Math.round((6 * ANSWER_BYTES) / 1e6)} MB`;
    expect(phases.map((row) => row.cells)).toEqual([
      [tenth(ANSWER_BYTES), tenth(3 * ANSWER_BYTES)],
      ["", tenth(3 * ANSWER_BYTES)],
      [mb(HEAP_PEAKS.timelines.normal), worker],
      [mb(HEAP_PEAKS.timelines.backstop), worker],
    ]);
    expect(DOCUMENT.replace(/\s+/g, " ")).toContain(
      `The Worker's JSON string is counted at two bytes a character (${tenth(2 * ANSWER_BYTES)})`,
    );
  });

  // Every place the documents give ANSWER_BYTES or a figure that follows from it: its MiB where they name it, the
  // ceiling of every shape (SHAPE_CEILING_PERCENT of it) and the conversation's spare under it, an announcement's
  // maximum with its share of it and the list's and the stream payload's that follow from it, the admitted answer's
  // heap at it (three times it) and a limit=0 list's bound.
  it("states the answer budget as the code gives it", () => {
    const document = DOCUMENT.replace(/\s+/g, " ");
    const answer = mib(ANSWER_BYTES);
    expect(document).toContain(`\`ANSWER_BYTES\` (${answer}, \`src/domain/answer-bytes.ts\`)`);
    expect(INVENTORY.replace(/\s+/g, " ")).toContain(`\`ANSWER_BYTES\` (${answer}, \`src/domain/answer-bytes.ts\`)`);
    expect(document).toContain(`\`ANSWER_BYTES\` (${answer} of the answer's JSON, containers included)`);
    expect(document).toContain(`returns within \`ANSWER_BYTES\` (${answer})`);
    expect(document).toContain(
      `Heap at ${answer} per answer. Assumptions: one request at a time per isolate; the answer's
JSON is at most ${answer},`.replace(/\s+/g, " "),
    );
    const ceiling = Math.floor((SHAPE_CEILING_PERCENT / 100) * ANSWER_BYTES);
    const spare = ceiling - CONSERVATIVE_JSON.conversation;
    expect(document).toContain(`Every shape stays within ${SHAPE_CEILING_PERCENT}% of an answer of ${answer}`);
    expect(document).toContain(
      `conservative JSON is ${count(spare)} bytes within ${SHAPE_CEILING_PERCENT}% of ${answer} (${count(ceiling)})`,
    );
    expect(document).toContain(`the conversation's JSON keeps ${count(spare)} under its ceiling`);
    expect(document).toContain(
      `the least whole percent that keeps it at least the ${count(SPARE_FLOOR)} bytes a change may not cross`,
    );
    const stream = count(2 * ANNOUNCEMENT_JSON + 2);
    expect(document).toContain(
      `One announcement is at most ${count(ANNOUNCEMENT_JSON)} bytes (${share(ANNOUNCEMENT_JSON)} of ${answer}), ` +
        `the list at most ${count(MAX_LIVE_ANNOUNCEMENTS * ANNOUNCEMENT_JSON + MAX_LIVE_ANNOUNCEMENTS + 1)}, ` +
        `a stream payload double-encoded at most ${stream},`,
    );
    expect(document).toContain(
      `each within its derived conservative maximum of ${count(ANNOUNCEMENT_JSON)} JSON bytes`,
    );
    expect(DEVIATIONS.replace(/\s+/g, " ")).toContain(`an announcement near its derived maximum (${stream})`);
    expect(document).toContain(`the admitted answer's ${((3 * ANSWER_BYTES) / 1e6).toFixed(1)} MB (`);
    expect(document).toContain(`at most ${answer} of accounts, linking \`next\` to the rest`);
    expect(document).toContain(`1,000 and ${answer} keep it well within the isolate's 128 MB`);
  });

  // Every place the documents give STATUS_ANSWER_BYTES: its bytes and what it leaves of ANSWER_BYTES, its share of
  // ANSWER_BYTES and the shares of it the shape ceiling and the largest shape's conservative JSON take, the admitted
  // answer's heap at it (three times the budget), how far one 8 KiB step more would pass half the isolate (64 MB) and
  // the largest row the backstop adds, each from the code's figure.
  it("states the status budget, its heap and its next step as the code gives them", () => {
    const flat = (text: string) => text.replace(/\s+/g, " ");
    const answer = mib(ANSWER_BYTES);
    const budget = `${count(STATUS_ANSWER_BYTES)} bytes, ${answer} less ${(ANSWER_BYTES - STATUS_ANSWER_BYTES) / 1024} KiB`;
    expect(flat(DOCUMENT)).toContain(`\`STATUS_ANSWER_BYTES\` instead (${budget})`);
    expect(flat(INVENTORY)).toContain(`\`STATUS_ANSWER_BYTES\` (${budget})`);
    const percent = (n: number, of: number, digits: number) => `${((100 * n) / of).toFixed(digits)}%`;
    const largest = Math.max(...Object.values(CONSERVATIVE_JSON));
    expect(largest, "the conversation is the largest shape").toBe(CONSERVATIVE_JSON.conversation);
    expect(flat(DOCUMENT)).toContain(
      `within \`STATUS_ANSWER_BYTES\`, ${percent(STATUS_ANSWER_BYTES, ANSWER_BYTES, 1)} of ${answer}: ` +
        `${SHAPE_CEILING_PERCENT}% of ${answer} is ` +
        `${percent((SHAPE_CEILING_PERCENT / 100) * ANSWER_BYTES, STATUS_ANSWER_BYTES, 1)} of it, and the largest ` +
        `shape, the conversation's conservative JSON, ${percent(largest, STATUS_ANSWER_BYTES, 2)}.`,
    );
    const heaps = [
      ...flat(DOCUMENT).matchAll(
        /([\d.]+ MB) at `STATUS_ANSWER_BYTES`|`STATUS_ANSWER_BYTES` for each answer below \(([\d.]+ MB)\)/g,
      ),
    ].map((match) => match[1] ?? match[2]);
    expect(heaps).toEqual([mb(3 * STATUS_ANSWER_BYTES), mb(3 * STATUS_ANSWER_BYTES)]);
    const step = `${CAP_STEP / 1024} KiB`;
    const spare = `${count(SPARE_FLOOR)} bytes`;
    const isolate = `${(2 * HALF) / 1e6} MB`;
    expect(flat(DOCUMENT)).toContain(
      `the largest multiple of ${step} that keeps it at least ${spare} under half (\`test/status-bounds.test.ts\``,
    );
    expect(flat(DOCUMENT)).toContain(
      `asserts the timelines' peaks within half of the Store isolate's ${isolate} with at least ${spare} to spare`,
    );
    const chunk = (bytes: number) =>
      `${bytes % (1024 * 1024) === 0 ? mib(bytes) : `${bytes / 1024} KiB`} (${mb(bytes)})`;
    expect(flat(DOCUMENT)).toContain(
      `A chunk of several takes at most its target of heap: ${chunk(TIMELINE_CHUNK_BYTES)} for timelines, ` +
        `${chunk(LARGE_ITEM_CHUNK_BYTES)} for groups and reports.`,
    );
    // The largest single row, the one RowMeter passes its cap by at most: the same for every kind of answer.
    const largestRow = mb(HEAP_PEAKS.timelines.largestRow);
    expect(Object.values(HEAP_PEAKS).map((p) => mb(p.largestRow))).toEqual([largestRow, largestRow, largestRow]);
    expect(flat(DOCUMENT)).toContain(
      `past the cap by at most the row that passed it (at most ${largestRow}, measured:`,
    );
    expect(flat(DOCUMENT)).toContain(`each column's largest value the same way (${largestRow}, the escaped poll row`);
    expect(flat(DOCUMENT)).toContain(`With the backstop fired, 1.25 × (the target + ${largestRow}) of dropped rows`);
    // The next step leaves less than SPARE_FLOOR under half (test/status-bounds.test.ts asserts it).
    const left = HALF - (HEAP_PEAKS.timelines.backstop + 3 * CAP_STEP);
    expect(flat(DOCUMENT)).toContain(
      `The ${TIMELINE_CHUNK_BYTES / 1024} KiB timeline cap and \`STATUS_ANSWER_BYTES\`, the largest multiple of ` +
        `${step} that does with that cap (each byte of budget is three of heap, so ${step} more would leave ` +
        `${count(left)} bytes, under the spare below), keep the fallback below half the isolate's memory even while the dropped chunk ` +
        `remains live, with at least ${spare} to spare under ${HALF / 1e6} MB`,
    );
  });

  // The outbox's budget (RES-3): ANSWER_BYTES less the reserve answer-bytes.ts gives, the page size getOutbox reads
  // (local-notes.ts, which imports the Store's modules, so read from its source) and the share of it the largest
  // Create takes (NOTE_MAXIMA, over every fill).
  it("states the outbox budget as the code gives it", () => {
    const flat = (text: string) => text.replace(/\s+/g, " ");
    const pageSize = /\nconst OUTBOX_PAGE_SIZE = (\d+);\n/.exec(
      readFileSync(new URL("../src/domain/local-notes.ts", import.meta.url), "utf8"),
    )?.[1];
    expect(flat(INVENTORY)).toContain(
      `at most ${pageSize} activities within \`OUTBOX_BYTES\` (\`ANSWER_BYTES\` less ` +
        `${(ANSWER_BYTES - OUTBOX_BYTES) / 1024} KiB for the page around them)`,
    );
    expect(flat(DOCUMENT)).toContain(
      `the Create is ${Math.floor((100 * NOTE_MAXIMA.create) / OUTBOX_BYTES)}% of \`OUTBOX_BYTES\``,
    );
  });
});

describe("the stream unit's peaks (RES-3, RES-6)", () => {
  // The document's prose, its line breaks as spaces.
  const prose = DOCUMENT.replace(/\s+/g, " ");

  it("states each kind's peak, the largest frame and the largest peak the peak test asserts", () => {
    const rows = table(UNIT_HEADER);
    expect(rows.map((row) => row.label)).toEqual(UNITS.map(([label]) => label));
    compare(
      rows,
      new Map(
        UNITS.map(([label, kind]) => {
          const p = STREAM_UNIT_PEAKS[kind];
          return [label, [mb(p.rows), mb(p.objects), mb(p.transient), mb(p.peak)]];
        }),
      ),
    );
    expect(prose).toContain(`\`MESSAGE_MAX\` is the largest frame, ${count(MESSAGE_MAX)} bytes`);
    const most = Math.max(...Object.values(STREAM_UNIT_PEAKS).map((p) => p.peak));
    expect(prose).toContain(`four frames of the largest at most, ${count(most)} bytes`);
  });
});
