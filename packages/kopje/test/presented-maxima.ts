// The figures test/status-bounds.test.ts asserts for docs/threat-model.md "Maxima of presented units" and "Heap at
// 8 MiB per answer" (RES-3): what each fill measures, the conservative JSON, the moved-to account's and the Note's
// maxima, and the heap model's peaks. test-node/presented-maxima.test.ts compares the document's tables with them cell
// by cell. It imports nothing, so workerd and Node both load it.

// The ceiling of every atomic shape's JSON, in whole percent of ANSWER_BYTES: the least that keeps the conversation's
// spare at least SPARE_FLOOR (status-bounds.test.ts asserts both).
export const SHAPE_CEILING_PERCENT = 89;

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
    status: { sqlite: 2_809_428, json: 2_805_357, rows: 1596, nodes: 2968 },
    quote: { sqlite: 5_040_571, json: 5_601_067, rows: 2139, nodes: 5918 },
    boostOfQuote: { sqlite: 5_187_451, json: 6_012_203, rows: 2198, nodes: 6890 },
    conversation: { sqlite: 6_400_237, json: 7_312_332, rows: 2190, nodes: 7157 },
    group: { sqlite: 5_903_549, json: 6_742_355, rows: 2190, nodes: 6762 },
    report: { sqlite: 5_352_124, json: 6_205_898, rows: 2157, nodes: 6271 },
    reportNotification: { sqlite: 823_521, json: 411_542, rows: 1066, nodes: 372 },
    warningNotification: { sqlite: 92_521, json: 294_570, rows: 8, nodes: 238 },
    warningGroup: { sqlite: 92_521, json: 294_759, rows: 8, nodes: 245 },
    filteredNotification: { sqlite: 5_149_356, json: 5_743_801, rows: 2162, nodes: 6026 },
  },
  derived: {
    account: { sqlite: 103_606, json: 142_608, rows: 1, nodes: 104 },
    status: { sqlite: 2_401_428, json: 2_805_357, rows: 1596, nodes: 2968 },
    quote: { sqlite: 4_224_571, json: 5_601_067, rows: 2139, nodes: 5918 },
    boostOfQuote: { sqlite: 4_371_451, json: 6_012_203, rows: 2198, nodes: 6890 },
    conversation: { sqlite: 5_584_237, json: 7_312_332, rows: 2190, nodes: 7157 },
    group: { sqlite: 5_087_549, json: 6_742_355, rows: 2190, nodes: 6762 },
    report: { sqlite: 4_521_124, json: 6_115_898, rows: 2157, nodes: 6271 },
    reportNotification: { sqlite: 808_521, json: 321_542, rows: 1066, nodes: 372 },
    warningNotification: { sqlite: 92_521, json: 294_570, rows: 8, nodes: 238 },
    warningGroup: { sqlite: 92_521, json: 294_759, rows: 8, nodes: 245 },
    filteredNotification: { sqlite: 4_333_356, json: 5_743_801, rows: 2162, nodes: 6026 },
  },
  raw: {
    account: { sqlite: 124_499, json: 124_972, rows: 1, nodes: 92 },
    status: { sqlite: 4_522_365, json: 2_287_683, rows: 1600, nodes: 2956 },
    quote: { sqlite: 6_966_118, json: 4_565_719, rows: 2147, nodes: 5894 },
    boostOfQuote: { sqlite: 7_262_427, json: 4_805_621, rows: 2210, nodes: 6854 },
    conversation: { sqlite: 8_665_301, json: 6_065_352, rows: 2246, nodes: 6989 },
    group: { sqlite: 8_041_512, json: 5_565_919, rows: 2230, nodes: 6642 },
    report: { sqlite: 7_351_668, json: 5_025_888, rows: 2173, nodes: 6223 },
    reportNotification: { sqlite: 2_374_225, json: 276_270, rows: 1074, nodes: 348 },
    warningNotification: { sqlite: 134_434, json: 238_308, rows: 8, nodes: 230 },
    warningGroup: { sqlite: 134_434, json: 238_497, rows: 8, nodes: 237 },
    filteredNotification: { sqlite: 7_101_455, json: 4_690_817, rows: 2174, nodes: 5990 },
  },
  "emoji-poll": {
    account: { sqlite: 103_606, json: 142_608, rows: 1, nodes: 104 },
    status: { sqlite: 2_808_580, json: 2_817_458, rows: 1596, nodes: 3020 },
    quote: { sqlite: 5_038_875, json: 5_625_269, rows: 2139, nodes: 6022 },
    boostOfQuote: { sqlite: 5_185_755, json: 6_036_405, rows: 2198, nodes: 6994 },
    conversation: { sqlite: 6_398_541, json: 7_336_534, rows: 2190, nodes: 7261 },
    group: { sqlite: 5_901_853, json: 6_766_557, rows: 2190, nodes: 6866 },
    report: { sqlite: 5_350_428, json: 6_230_100, rows: 2157, nodes: 6375 },
    reportNotification: { sqlite: 823_521, json: 411_542, rows: 1066, nodes: 372 },
    warningNotification: { sqlite: 92_521, json: 294_570, rows: 8, nodes: 238 },
    warningGroup: { sqlite: 92_521, json: 294_759, rows: 8, nodes: 245 },
    filteredNotification: { sqlite: 5_147_660, json: 5_768_003, rows: 2162, nodes: 6130 },
  },
  "emoji-cache": {
    account: { sqlite: 103_190, json: 141_296, rows: 1, nodes: 216 },
    status: { sqlite: 2_805_576, json: 2_800_786, rows: 1596, nodes: 3292 },
    quote: { sqlite: 5_032_867, json: 5_591_925, rows: 2139, nodes: 6566 },
    boostOfQuote: { sqlite: 5_179_573, json: 6_001_749, rows: 2198, nodes: 7650 },
    conversation: { sqlite: 6_388_728, json: 7_287_446, rows: 2190, nodes: 9149 },
    group: { sqlite: 5_894_453, json: 6_722_717, rows: 2190, nodes: 8306 },
    report: { sqlite: 5_342_355, json: 6_194_104, rows: 2157, nodes: 7599 },
    reportNotification: { sqlite: 823_173, json: 408_918, rows: 1066, nodes: 596 },
    warningNotification: { sqlite: 90_804, json: 294_542, rows: 8, nodes: 694 },
    warningGroup: { sqlite: 90_804, json: 294_731, rows: 8, nodes: 701 },
    filteredNotification: { sqlite: 5_141_478, json: 5_733_347, rows: 2162, nodes: 6786 },
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
  status: 2_825_262,
  quote: 5_640_634,
  boostOfQuote: 6_057_734,
  conversation: 7_394_679,
  group: 6_810_442,
  report: 6_252_835,
  reportNotification: 444_352,
  warningNotification: 364_965,
  warningGroup: 365_154,
  filteredNotification: 5_786_933,
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
    rows: 19_740_717.5,
    largestRow: 1_204_476,
    rejected: 18_173_202,
    normal: 61_967_307.5,
    backstop: 63_974_662.5,
    single: 61_967_307.5,
  },
  groups: {
    rows: 21_797_855,
    largestRow: 1_204_476,
    rejected: 20_431_326,
    normal: 76_382_569,
    backstop: 79_198_884,
    single: 76_382_569,
  },
  reports: {
    rows: 19_971_697.5,
    largestRow: 1_204_476,
    rejected: 18_758_505,
    normal: 75_283_590.5,
    backstop: 78_099_905.5,
    single: 75_283_590.5,
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
  status: { rows: 19_740_717.5, objects: 18_173_202, transient: 1_064_884, peak: 38_978_803.5 },
  conversation: { rows: 23_425_170, objects: 22_184_037, transient: 1_064_884, peak: 46_674_091 },
  notification: { rows: 26_288_377.5, objects: 20_601_153, transient: 1_064_884, peak: 47_954_414.5 },
  announcement: { rows: 7_283_520, objects: 746_991, transient: 1_918_042, peak: 9_948_553 },
};
