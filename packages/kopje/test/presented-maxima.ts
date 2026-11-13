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
    status: { sqlite: 2_769_192, json: 2_685_396, rows: 1486, nodes: 2399 },
    quote: { sqlite: 4_960_117, json: 5_361_173, rows: 1919, nodes: 4780 },
    boostOfQuote: { sqlite: 5_106_583, json: 5_770_107, rows: 1976, nodes: 5739 },
    conversation: { sqlite: 6_314_456, json: 7_046_302, rows: 1945, nodes: 5875 },
    group: { sqlite: 5_819_783, json: 6_485_037, rows: 1954, nodes: 5528 },
    report: { sqlite: 5_269_432, json: 5_957_606, rows: 1932, nodes: 5095 },
    reportNotification: { sqlite: 812_382, json: 403_264, rows: 1060, nodes: 294 },
    warningNotification: { sqlite: 92_165, json: 290_370, rows: 7, nodes: 223 },
    warningGroup: { sqlite: 92_165, json: 290_559, rows: 7, nodes: 230 },
    filteredNotification: { sqlite: 5_068_488, json: 5_501_729, rows: 1940, nodes: 4876 },
  },
  derived: {
    account: { sqlite: 103_274, json: 140_430, rows: 1, nodes: 92 },
    status: { sqlite: 2_361_192, json: 2_275_796, rows: 1486, nodes: 2399 },
    quote: { sqlite: 4_144_117, json: 4_541_973, rows: 1919, nodes: 4780 },
    boostOfQuote: { sqlite: 4_290_583, json: 4_950_907, rows: 1976, nodes: 5739 },
    conversation: { sqlite: 5_498_456, json: 6_227_102, rows: 1945, nodes: 5875 },
    group: { sqlite: 5_003_783, json: 5_665_837, rows: 1954, nodes: 5528 },
    report: { sqlite: 4_438_432, json: 5_048_406, rows: 1932, nodes: 5095 },
    reportNotification: { sqlite: 797_382, json: 313_264, rows: 1060, nodes: 294 },
    warningNotification: { sqlite: 92_165, json: 290_370, rows: 7, nodes: 223 },
    warningGroup: { sqlite: 92_165, json: 290_559, rows: 7, nodes: 230 },
    filteredNotification: { sqlite: 4_252_488, json: 4_682_529, rows: 1940, nodes: 4876 },
  },
  raw: {
    account: { sqlite: 123_267, json: 123_394, rows: 1, nodes: 80 },
    status: { sqlite: 4_453_581, json: 2_186_754, rows: 1490, nodes: 2387 },
    quote: { sqlite: 6_828_568, json: 4_363_889, rows: 1927, nodes: 4756 },
    boostOfQuote: { sqlite: 7_123_563, json: 4_602_189, rows: 1988, nodes: 5703 },
    conversation: { sqlite: 8_510_724, json: 5_844_586, rows: 2001, nodes: 5707 },
    group: { sqlite: 7_893_450, json: 5_351_465, rows: 1994, nodes: 5408 },
    report: { sqlite: 7_209_180, json: 4_818_060, rows: 1948, nodes: 5047 },
    reportNotification: { sqlite: 2_361_286, json: 269_192, rows: 1068, nodes: 270 },
    warningNotification: { sqlite: 133_178, json: 235_308, rows: 7, nodes: 215 },
    warningGroup: { sqlite: 133_178, json: 235_497, rows: 7, nodes: 222 },
    filteredNotification: { sqlite: 6_962_591, json: 4_487_409, rows: 1952, nodes: 4840 },
  },
  "emoji-poll": {
    account: { sqlite: 103_274, json: 140_430, rows: 1, nodes: 92 },
    status: { sqlite: 2_768_344, json: 2_697_497, rows: 1486, nodes: 2451 },
    quote: { sqlite: 4_958_421, json: 5_385_375, rows: 1919, nodes: 4884 },
    boostOfQuote: { sqlite: 5_104_887, json: 5_794_309, rows: 1976, nodes: 5843 },
    conversation: { sqlite: 6_312_760, json: 7_070_504, rows: 1945, nodes: 5979 },
    group: { sqlite: 5_818_087, json: 6_509_239, rows: 1954, nodes: 5632 },
    report: { sqlite: 5_267_736, json: 5_981_808, rows: 1932, nodes: 5199 },
    reportNotification: { sqlite: 812_382, json: 403_264, rows: 1060, nodes: 294 },
    warningNotification: { sqlite: 92_165, json: 290_370, rows: 7, nodes: 223 },
    warningGroup: { sqlite: 92_165, json: 290_559, rows: 7, nodes: 230 },
    filteredNotification: { sqlite: 5_066_792, json: 5_525_931, rows: 1940, nodes: 4980 },
  },
  "emoji-cache": {
    account: { sqlite: 102_858, json: 139_118, rows: 1, nodes: 204 },
    status: { sqlite: 2_765_340, json: 2_680_825, rows: 1486, nodes: 2723 },
    quote: { sqlite: 4_952_413, json: 5_352_031, rows: 1919, nodes: 5428 },
    boostOfQuote: { sqlite: 5_098_705, json: 5_759_653, rows: 1976, nodes: 6499 },
    conversation: { sqlite: 6_302_947, json: 7_021_416, rows: 1945, nodes: 7867 },
    group: { sqlite: 5_810_687, json: 6_465_399, rows: 1954, nodes: 7072 },
    report: { sqlite: 5_259_663, json: 5_945_812, rows: 1932, nodes: 6423 },
    reportNotification: { sqlite: 812_034, json: 400_640, rows: 1060, nodes: 518 },
    warningNotification: { sqlite: 90_448, json: 290_342, rows: 7, nodes: 679 },
    warningGroup: { sqlite: 90_448, json: 290_531, rows: 7, nodes: 686 },
    filteredNotification: { sqlite: 5_060_610, json: 5_491_275, rows: 1940, nodes: 5636 },
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
  status: 2_703_965,
  quote: 5_398_068,
  boostOfQuote: 5_812_706,
  conversation: 7_122_857,
  group: 6_548_372,
  report: 6_001_111,
  reportNotification: 409_874,
  warningNotification: 332_194,
  warningGroup: 332_383,
  filteredNotification: 5_541_929,
};

// The nested moved-to account, derived from its caps: its JSON, and the SQLite bytes, count and heap of its rows.
export const MOVED_ACCOUNT_MAXIMA = { json: 11_021, sqlite: 12_432, rows: 1, heap: 25_536 };

// The ActivityPub Note of a local status at its bounds, addressed to MAX_LOCAL_ADDRESSED accounts: what its read
// takes out of SQLite, the rows and nodes, and the JSON of the Note and of its Create.
export const NOTE_MAXIMA = { sqlite: 3_697_531, rows: 1_337, nodes: 3_169, note: 4_243_523, create: 6_299_611 };

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
    rows: 19_329_597.5,
    largestRow: 1_204_476,
    rejected: 17_438_118,
    normal: 61_951_599.5,
    backstop: 63_989_674.5,
    single: 61_951_599.5,
  },
  groups: {
    rows: 21_359_820,
    largestRow: 1_204_476,
    rejected: 19_645_116,
    normal: 76_288_820,
    backstop: 79_105_135,
    single: 76_288_820,
  },
  reports: {
    rows: 19_550_597.5,
    largestRow: 1_204_476,
    rejected: 18_003_333,
    normal: 75_237_814.5,
    backstop: 78_054_129.5,
    single: 75_237_814.5,
  },
};
