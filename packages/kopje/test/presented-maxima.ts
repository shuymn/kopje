// The figures test/status-bounds.test.ts asserts for docs/threat-model.md "Maxima of presented units" and "Heap at
// 8 MiB per answer" (RES-3): what each fill measures, the conservative JSON, the moved-to account's and the Note's
// maxima, and the heap model's peaks. test-node/presented-maxima.test.ts compares the document's tables with them cell
// by cell. It imports nothing, so workerd and Node both load it.

// The fills of test/status-bounds.test.ts, described where it defines how a fixture fills text.
export type Fill = "escaped" | "derived" | "raw" | "emoji-poll" | "emoji-cache";
export const FILLS = ["escaped", "derived", "raw", "emoji-poll", "emoji-cache"] as const satisfies readonly Fill[];

// What one read of a shape takes out of SQLite (UTF-8 bytes of every value, 8 per number) and presents (JSON bytes),
// the rows it returns, and the objects, arrays and strings it presents.
export type Shape = { sqlite: number; json: number; rows: number; nodes: number };
export type ShapeName =
  | "account"
  | "status"
  | "quote"
  | "boostOfQuote"
  | "conversation"
  | "group"
  | "report"
  | "reportNotification"
  | "warningNotification"
  | "warningGroup"
  | "filteredNotification";

export const FILL_SHAPES: Record<Fill, Record<ShapeName, Shape>> = {
  escaped: {
    account: { sqlite: 103_274, json: 140_430, rows: 1, nodes: 92 },
    status: { sqlite: 2_769_210, json: 2_685_424, rows: 1486, nodes: 2399 },
    quote: { sqlite: 4_960_135, json: 5_361_201, rows: 1919, nodes: 4780 },
    boostOfQuote: { sqlite: 5_106_601, json: 5_770_135, rows: 1976, nodes: 5739 },
    conversation: { sqlite: 6_314_474, json: 7_046_330, rows: 1945, nodes: 5875 },
    group: { sqlite: 5_819_801, json: 6_485_065, rows: 1954, nodes: 5528 },
    report: { sqlite: 5_269_450, json: 5_957_634, rows: 1932, nodes: 5095 },
    reportNotification: { sqlite: 817_546, json: 406_117, rows: 1062, nodes: 297 },
    warningNotification: { sqlite: 92_165, json: 290_594, rows: 7, nodes: 226 },
    warningGroup: { sqlite: 92_165, json: 290_783, rows: 7, nodes: 233 },
    filteredNotification: { sqlite: 5_068_506, json: 5_501_757, rows: 1940, nodes: 4876 },
  },
  derived: {
    account: { sqlite: 103_274, json: 140_430, rows: 1, nodes: 92 },
    status: { sqlite: 2_361_210, json: 2_275_824, rows: 1486, nodes: 2399 },
    quote: { sqlite: 4_144_135, json: 4_542_001, rows: 1919, nodes: 4780 },
    boostOfQuote: { sqlite: 4_290_601, json: 4_950_935, rows: 1976, nodes: 5739 },
    conversation: { sqlite: 5_498_474, json: 6_227_130, rows: 1945, nodes: 5875 },
    group: { sqlite: 5_003_801, json: 5_665_865, rows: 1954, nodes: 5528 },
    report: { sqlite: 4_438_450, json: 5_048_434, rows: 1932, nodes: 5095 },
    reportNotification: { sqlite: 802_546, json: 316_117, rows: 1062, nodes: 297 },
    warningNotification: { sqlite: 92_165, json: 290_594, rows: 7, nodes: 226 },
    warningGroup: { sqlite: 92_165, json: 290_783, rows: 7, nodes: 233 },
    filteredNotification: { sqlite: 4_252_506, json: 4_682_557, rows: 1940, nodes: 4876 },
  },
  raw: {
    account: { sqlite: 123_267, json: 123_394, rows: 1, nodes: 80 },
    status: { sqlite: 4_453_599, json: 2_186_782, rows: 1490, nodes: 2387 },
    quote: { sqlite: 6_828_586, json: 4_363_917, rows: 1927, nodes: 4756 },
    boostOfQuote: { sqlite: 7_123_581, json: 4_602_217, rows: 1988, nodes: 5703 },
    conversation: { sqlite: 8_510_742, json: 5_844_614, rows: 2001, nodes: 5707 },
    group: { sqlite: 7_893_468, json: 5_351_493, rows: 1994, nodes: 5408 },
    report: { sqlite: 7_209_198, json: 4_818_088, rows: 1948, nodes: 5047 },
    reportNotification: { sqlite: 2_366_450, json: 272_045, rows: 1070, nodes: 273 },
    warningNotification: { sqlite: 133_178, json: 235_532, rows: 7, nodes: 218 },
    warningGroup: { sqlite: 133_178, json: 235_721, rows: 7, nodes: 225 },
    filteredNotification: { sqlite: 6_962_609, json: 4_487_437, rows: 1952, nodes: 4840 },
  },
  "emoji-poll": {
    account: { sqlite: 103_274, json: 140_430, rows: 1, nodes: 92 },
    status: { sqlite: 2_768_362, json: 2_697_525, rows: 1486, nodes: 2451 },
    quote: { sqlite: 4_958_439, json: 5_385_403, rows: 1919, nodes: 4884 },
    boostOfQuote: { sqlite: 5_104_905, json: 5_794_337, rows: 1976, nodes: 5843 },
    conversation: { sqlite: 6_312_778, json: 7_070_532, rows: 1945, nodes: 5979 },
    group: { sqlite: 5_818_105, json: 6_509_267, rows: 1954, nodes: 5632 },
    report: { sqlite: 5_267_754, json: 5_981_836, rows: 1932, nodes: 5199 },
    reportNotification: { sqlite: 817_546, json: 406_117, rows: 1062, nodes: 297 },
    warningNotification: { sqlite: 92_165, json: 290_594, rows: 7, nodes: 226 },
    warningGroup: { sqlite: 92_165, json: 290_783, rows: 7, nodes: 233 },
    filteredNotification: { sqlite: 5_066_810, json: 5_525_959, rows: 1940, nodes: 4980 },
  },
  "emoji-cache": {
    account: { sqlite: 102_858, json: 139_118, rows: 1, nodes: 204 },
    status: { sqlite: 2_765_358, json: 2_680_853, rows: 1486, nodes: 2723 },
    quote: { sqlite: 4_952_431, json: 5_352_059, rows: 1919, nodes: 5428 },
    boostOfQuote: { sqlite: 5_098_723, json: 5_759_681, rows: 1976, nodes: 6499 },
    conversation: { sqlite: 6_302_965, json: 7_021_444, rows: 1945, nodes: 7867 },
    group: { sqlite: 5_810_705, json: 6_465_427, rows: 1954, nodes: 7072 },
    report: { sqlite: 5_259_681, json: 5_945_840, rows: 1932, nodes: 6423 },
    reportNotification: { sqlite: 817_198, json: 403_493, rows: 1062, nodes: 521 },
    warningNotification: { sqlite: 90_448, json: 290_566, rows: 7, nodes: 682 },
    warningGroup: { sqlite: 90_448, json: 290_755, rows: 7, nodes: 689 },
    filteredNotification: { sqlite: 5_060_628, json: 5_491_303, rows: 1940, nodes: 5636 },
  },
};

// The fill each measured column of the table of maxima comes from: for every shape, it gives the most of all fills.
export const COLUMN_FILL: Record<keyof Shape, Fill> = {
  sqlite: "raw",
  json: "emoji-poll",
  rows: "raw",
  nodes: "emoji-cache",
};

// The conservative JSON of each shape (status-bounds.test.ts conservativeJson).
export const CONSERVATIVE_JSON: Record<ShapeName, number> = {
  account: 147_990,
  status: 2_703_993,
  quote: 5_398_096,
  boostOfQuote: 5_812_734,
  conversation: 7_122_885,
  group: 6_548_400,
  report: 6_001_139,
  reportNotification: 438_407,
  warningNotification: 360_727,
  warningGroup: 360_916,
  filteredNotification: 5_541_957,
};

// The nested moved-to account, derived from its caps: its JSON, and the SQLite bytes, count and heap of its rows.
export const MOVED_ACCOUNT_MAXIMA = { json: 11_021, sqlite: 12_432, rows: 1, heap: 25_536 };

// The ActivityPub Note of a local status at its bounds, its card's Link included, addressed to MAX_LOCAL_ADDRESSED
// accounts: what its read takes out of SQLite, the rows and nodes, and the JSON of the Note and of its Create.
export const NOTE_MAXIMA = { sqlite: 3_700_089, rows: 1_338, nodes: 3_172, note: 4_245_597, create: 6_301_685 };

// The peaks of the heap model (status-bounds.test.ts peaks), in bytes, for answers whose largest item is a timeline's
// item, a group or a report: the item's rows with 25% headroom, the largest single row, the rejected item's objects,
// and the answer's peak normally, with the backstop fired and the dropped chunk still live, and for a single item.
export type Peaks = {
  rows: number;
  largestRow: number;
  rejected: number;
  normal: number;
  backstop: number;
  single: number;
};
export const HEAP_PEAKS: Record<"timelines" | "groups" | "reports", Peaks> = {
  timelines: {
    rows: 19_329_682.5,
    largestRow: 1_204_476,
    rejected: 17_438_202,
    normal: 61_951_768.5,
    backstop: 63_989_843.5,
    single: 61_951_768.5,
  },
  groups: {
    rows: 21_359_905,
    largestRow: 1_204_476,
    rejected: 19_645_200,
    normal: 76_288_989,
    backstop: 79_105_304,
    single: 76_288_989,
  },
  reports: {
    rows: 19_550_682.5,
    largestRow: 1_204_476,
    rejected: 18_003_417,
    normal: 75_237_983.5,
    backstop: 78_054_298.5,
    single: 75_237_983.5,
  },
};
