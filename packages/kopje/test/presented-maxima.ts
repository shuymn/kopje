// The figures test/status-bounds.test.ts asserts for docs/threat-model.md "Maxima of presented units" and "Heap at
// 8 MiB per answer" (RES-3): what each fill measures, the conservative JSON, the moved-to account's and the Note's
// maxima, and the heap model's peaks. test-node/presented-maxima.test.ts compares the document's tables with them cell
// by cell. It imports nothing, so workerd and Node both load it.

// The ceiling of every atomic shape's JSON, in whole percent of ANSWER_BYTES: the least that keeps the conversation's
// spare at least SPARE_FLOOR (status-bounds.test.ts asserts both).
export const SHAPE_CEILING_PERCENT = 86;

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
    account: { sqlite: 103_606, json: 142_608, rows: 1, nodes: 104 },
    status: { sqlite: 2_769_624, json: 2_687_602, rows: 1488, nodes: 2411 },
    quote: { sqlite: 4_960_963, json: 5_365_557, rows: 1923, nodes: 4804 },
    boostOfQuote: { sqlite: 5_107_843, json: 5_776_669, rows: 1982, nodes: 5775 },
    conversation: { sqlite: 6_320_629, json: 7_076_822, rows: 1974, nodes: 6043 },
    group: { sqlite: 5_823_941, json: 6_506_845, rows: 1974, nodes: 5648 },
    report: { sqlite: 5_272_516, json: 5_970_388, rows: 1941, nodes: 5157 },
    reportNotification: { sqlite: 823_521, json: 411_542, rows: 1066, nodes: 372 },
    warningNotification: { sqlite: 92_521, json: 294_570, rows: 8, nodes: 238 },
    warningGroup: { sqlite: 92_521, json: 294_759, rows: 8, nodes: 245 },
    filteredNotification: { sqlite: 5_069_748, json: 5_508_291, rows: 1946, nodes: 4912 },
  },
  derived: {
    account: { sqlite: 103_606, json: 142_608, rows: 1, nodes: 104 },
    status: { sqlite: 2_361_624, json: 2_687_602, rows: 1488, nodes: 2411 },
    quote: { sqlite: 4_144_963, json: 5_365_557, rows: 1923, nodes: 4804 },
    boostOfQuote: { sqlite: 4_291_843, json: 5_776_669, rows: 1982, nodes: 5775 },
    conversation: { sqlite: 5_504_629, json: 7_076_822, rows: 1974, nodes: 6043 },
    group: { sqlite: 5_007_941, json: 6_506_845, rows: 1974, nodes: 5648 },
    report: { sqlite: 4_441_516, json: 5_880_388, rows: 1941, nodes: 5157 },
    reportNotification: { sqlite: 808_521, json: 321_542, rows: 1066, nodes: 372 },
    warningNotification: { sqlite: 92_521, json: 294_570, rows: 8, nodes: 238 },
    warningGroup: { sqlite: 92_521, json: 294_759, rows: 8, nodes: 245 },
    filteredNotification: { sqlite: 4_253_748, json: 5_508_291, rows: 1946, nodes: 4912 },
  },
  raw: {
    account: { sqlite: 124_499, json: 124_972, rows: 1, nodes: 92 },
    status: { sqlite: 4_454_913, json: 2_188_360, rows: 1492, nodes: 2399 },
    quote: { sqlite: 6_831_214, json: 4_367_073, rows: 1931, nodes: 4780 },
    boostOfQuote: { sqlite: 7_127_523, json: 4_606_951, rows: 1994, nodes: 5739 },
    conversation: { sqlite: 8_530_397, json: 5_866_706, rows: 2030, nodes: 5875 },
    group: { sqlite: 7_906_608, json: 5_367_273, rows: 2014, nodes: 5528 },
    report: { sqlite: 7_216_764, json: 4_827_242, rows: 1957, nodes: 5109 },
    reportNotification: { sqlite: 2_374_225, json: 276_270, rows: 1074, nodes: 348 },
    warningNotification: { sqlite: 134_434, json: 238_308, rows: 8, nodes: 230 },
    warningGroup: { sqlite: 134_434, json: 238_497, rows: 8, nodes: 237 },
    filteredNotification: { sqlite: 6_966_551, json: 4_492_171, rows: 1958, nodes: 4876 },
  },
  "emoji-poll": {
    account: { sqlite: 103_606, json: 142_608, rows: 1, nodes: 104 },
    status: { sqlite: 2_768_776, json: 2_699_703, rows: 1488, nodes: 2463 },
    quote: { sqlite: 4_959_267, json: 5_389_759, rows: 1923, nodes: 4908 },
    boostOfQuote: { sqlite: 5_106_147, json: 5_800_871, rows: 1982, nodes: 5879 },
    conversation: { sqlite: 6_318_933, json: 7_101_024, rows: 1974, nodes: 6147 },
    group: { sqlite: 5_822_245, json: 6_531_047, rows: 1974, nodes: 5752 },
    report: { sqlite: 5_270_820, json: 5_994_590, rows: 1941, nodes: 5261 },
    reportNotification: { sqlite: 823_521, json: 411_542, rows: 1066, nodes: 372 },
    warningNotification: { sqlite: 92_521, json: 294_570, rows: 8, nodes: 238 },
    warningGroup: { sqlite: 92_521, json: 294_759, rows: 8, nodes: 245 },
    filteredNotification: { sqlite: 5_068_052, json: 5_532_493, rows: 1946, nodes: 5016 },
  },
  "emoji-cache": {
    account: { sqlite: 103_190, json: 141_296, rows: 1, nodes: 216 },
    status: { sqlite: 2_765_772, json: 2_683_031, rows: 1488, nodes: 2735 },
    quote: { sqlite: 4_953_259, json: 5_356_415, rows: 1923, nodes: 5452 },
    boostOfQuote: { sqlite: 5_099_965, json: 5_766_215, rows: 1982, nodes: 6535 },
    conversation: { sqlite: 6_309_120, json: 7_051_936, rows: 1974, nodes: 8035 },
    group: { sqlite: 5_814_845, json: 6_487_207, rows: 1974, nodes: 7192 },
    report: { sqlite: 5_262_747, json: 5_958_594, rows: 1941, nodes: 6485 },
    reportNotification: { sqlite: 823_173, json: 408_918, rows: 1066, nodes: 596 },
    warningNotification: { sqlite: 90_804, json: 294_542, rows: 8, nodes: 694 },
    warningGroup: { sqlite: 90_804, json: 294_731, rows: 8, nodes: 701 },
    filteredNotification: { sqlite: 5_061_870, json: 5_497_837, rows: 1946, nodes: 5672 },
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
  account: 150_428,
  status: 2_706_431,
  quote: 5_402_972,
  boostOfQuote: 5_820_048,
  conversation: 7_157_017,
  group: 6_572_780,
  report: 6_015_173,
  reportNotification: 444_352,
  warningNotification: 364_965,
  warningGroup: 365_154,
  filteredNotification: 5_549_271,
};

// The nested moved-to account, derived from its caps: its JSON, and the SQLite bytes, count and heap of its rows.
export const MOVED_ACCOUNT_MAXIMA = { json: 11_340, sqlite: 12_464, rows: 1, heap: 25_664 };

// The Profile (/api/v1/profile): the JSON of a witness with every part at its cap, and the conservative JSON derived
// from the caps (test/profile-api.test.ts).
export const PROFILE_MAXIMA = { json: 326_185, conservative: 372_038 };

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
    rows: 19_341_217.5,
    largestRow: 1_204_476,
    rejected: 17_460_144,
    normal: 61_985_245.5,
    backstop: 63_992_600.5,
    single: 61_985_245.5,
  },
  groups: {
    rows: 21_398_355,
    largestRow: 1_204_476,
    rejected: 19_718_340,
    normal: 76_400_579,
    backstop: 79_216_894,
    single: 76_400_579,
  },
  reports: {
    rows: 19_572_197.5,
    largestRow: 1_204_476,
    rejected: 18_045_519,
    normal: 75_301_600.5,
    backstop: 78_117_915.5,
    single: 75_301_600.5,
  },
};

// The largest frame a stream socket is sent (stream-hub.ts envelope): STREAM_LIMITS.payloadBytes, the envelope's keys,
// the longest event and the longest stream. And a stream unit's isolate peak for each streamed kind, in bytes
// (status-bounds.test.ts "bounds a stream unit's isolate peak by the most a subject presents", RES-6): its rows with
// 25% headroom, its presented objects, its strings and scratch (four frames of MESSAGE_MAX and the presentation's), and
// their sum.
export const MESSAGE_MAX = 261_706;
export type UnitPeak = { rows: number; objects: number; transient: number; peak: number };
export const STREAM_UNIT_PEAKS: Record<"status" | "conversation" | "notification" | "announcement", UnitPeak> = {
  status: { rows: 19_341_217.5, objects: 17_460_144, transient: 1_064_884, peak: 37_866_245.5 },
  conversation: { rows: 23_025_670, objects: 21_471_051, transient: 1_064_884, peak: 45_561_605 },
  notification: { rows: 25_888_877.5, objects: 19_888_095, transient: 1_064_884, peak: 46_841_856.5 },
  announcement: { rows: 7_283_520, objects: 746_991, transient: 1_918_042, peak: 9_948_553 },
};
