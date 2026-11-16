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
    account: { sqlite: 103_598, json: 142_462, rows: 1, nodes: 96 },
    status: { sqlite: 2_769_558, json: 2_687_456, rows: 1486, nodes: 2403 },
    quote: { sqlite: 4_960_831, json: 5_365_265, rows: 1919, nodes: 4788 },
    boostOfQuote: { sqlite: 5_107_645, json: 5_776_231, rows: 1976, nodes: 5751 },
    conversation: { sqlite: 6_319_670, json: 7_074_778, rows: 1945, nodes: 5931 },
    group: { sqlite: 5_823_281, json: 6_505_385, rows: 1954, nodes: 5568 },
    report: { sqlite: 5_272_217, json: 5_969_638, rows: 1932, nodes: 5115 },
    reportNotification: { sqlite: 819_293, json: 411_250, rows: 1062, nodes: 356 },
    warningNotification: { sqlite: 92_489, json: 294_426, rows: 7, nodes: 230 },
    warningGroup: { sqlite: 92_489, json: 294_615, rows: 7, nodes: 237 },
    filteredNotification: { sqlite: 5_069_550, json: 5_507_853, rows: 1940, nodes: 4888 },
  },
  derived: {
    account: { sqlite: 103_598, json: 142_462, rows: 1, nodes: 96 },
    status: { sqlite: 2_361_558, json: 2_277_856, rows: 1486, nodes: 2403 },
    quote: { sqlite: 4_144_831, json: 4_546_065, rows: 1919, nodes: 4788 },
    boostOfQuote: { sqlite: 4_291_645, json: 4_957_031, rows: 1976, nodes: 5751 },
    conversation: { sqlite: 5_503_670, json: 6_255_578, rows: 1945, nodes: 5931 },
    group: { sqlite: 5_007_281, json: 5_686_185, rows: 1954, nodes: 5568 },
    report: { sqlite: 4_441_217, json: 5_060_438, rows: 1932, nodes: 5115 },
    reportNotification: { sqlite: 804_293, json: 321_250, rows: 1062, nodes: 356 },
    warningNotification: { sqlite: 92_489, json: 294_426, rows: 7, nodes: 230 },
    warningGroup: { sqlite: 92_489, json: 294_615, rows: 7, nodes: 237 },
    filteredNotification: { sqlite: 4_253_550, json: 4_688_653, rows: 1940, nodes: 4888 },
  },
  raw: {
    account: { sqlite: 124_491, json: 124_826, rows: 1, nodes: 84 },
    status: { sqlite: 4_454_847, json: 2_188_214, rows: 1490, nodes: 2391 },
    quote: { sqlite: 6_831_082, json: 4_366_781, rows: 1927, nodes: 4764 },
    boostOfQuote: { sqlite: 7_127_325, json: 4_606_513, rows: 1988, nodes: 5715 },
    conversation: { sqlite: 8_529_438, json: 5_864_662, rows: 2001, nodes: 5763 },
    group: { sqlite: 7_905_948, json: 5_365_813, rows: 1994, nodes: 5448 },
    report: { sqlite: 7_216_465, json: 4_826_492, rows: 1948, nodes: 5067 },
    reportNotification: { sqlite: 2_369_997, json: 275_978, rows: 1070, nodes: 332 },
    warningNotification: { sqlite: 134_402, json: 238_164, rows: 7, nodes: 222 },
    warningGroup: { sqlite: 134_402, json: 238_353, rows: 7, nodes: 229 },
    filteredNotification: { sqlite: 6_966_353, json: 4_491_733, rows: 1952, nodes: 4852 },
  },
  "emoji-poll": {
    account: { sqlite: 103_598, json: 142_462, rows: 1, nodes: 96 },
    status: { sqlite: 2_768_710, json: 2_699_557, rows: 1486, nodes: 2455 },
    quote: { sqlite: 4_959_135, json: 5_389_467, rows: 1919, nodes: 4892 },
    boostOfQuote: { sqlite: 5_105_949, json: 5_800_433, rows: 1976, nodes: 5855 },
    conversation: { sqlite: 6_317_974, json: 7_098_980, rows: 1945, nodes: 6035 },
    group: { sqlite: 5_821_585, json: 6_529_587, rows: 1954, nodes: 5672 },
    report: { sqlite: 5_270_521, json: 5_993_840, rows: 1932, nodes: 5219 },
    reportNotification: { sqlite: 819_293, json: 411_250, rows: 1062, nodes: 356 },
    warningNotification: { sqlite: 92_489, json: 294_426, rows: 7, nodes: 230 },
    warningGroup: { sqlite: 92_489, json: 294_615, rows: 7, nodes: 237 },
    filteredNotification: { sqlite: 5_067_854, json: 5_532_055, rows: 1940, nodes: 4992 },
  },
  "emoji-cache": {
    account: { sqlite: 103_182, json: 141_150, rows: 1, nodes: 208 },
    status: { sqlite: 2_765_706, json: 2_682_885, rows: 1486, nodes: 2727 },
    quote: { sqlite: 4_953_127, json: 5_356_123, rows: 1919, nodes: 5436 },
    boostOfQuote: { sqlite: 5_099_767, json: 5_765_777, rows: 1976, nodes: 6511 },
    conversation: { sqlite: 6_308_161, json: 7_049_892, rows: 1945, nodes: 7923 },
    group: { sqlite: 5_814_185, json: 6_485_747, rows: 1954, nodes: 7112 },
    report: { sqlite: 5_262_448, json: 5_957_844, rows: 1932, nodes: 6443 },
    reportNotification: { sqlite: 818_945, json: 408_626, rows: 1062, nodes: 580 },
    warningNotification: { sqlite: 90_772, json: 294_398, rows: 7, nodes: 686 },
    warningGroup: { sqlite: 90_772, json: 294_587, rows: 7, nodes: 693 },
    filteredNotification: { sqlite: 5_061_672, json: 5_497_399, rows: 1940, nodes: 5648 },
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
  account: 150_022,
  status: 2_706_025,
  quote: 5_402_160,
  boostOfQuote: 5_818_830,
  conversation: 7_151_333,
  group: 6_568_720,
  report: 6_013_143,
  reportNotification: 443_540,
  warningNotification: 364_559,
  warningGroup: 364_748,
  filteredNotification: 5_548_053,
};

// The nested moved-to account, derived from its caps: its JSON, and the SQLite bytes, count and heap of its rows.
export const MOVED_ACCOUNT_MAXIMA = { json: 11_137, sqlite: 12_456, rows: 1, heap: 25_632 };

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
    rows: 19_339_642.5,
    largestRow: 1_204_476,
    rejected: 17_456_490,
    normal: 61_980_016.5,
    backstop: 63_987_371.5,
    single: 61_980_016.5,
  },
  groups: {
    rows: 21_393_105,
    largestRow: 1_204_476,
    rejected: 19_706_160,
    normal: 76_383_149,
    backstop: 79_199_464,
    single: 76_383_149,
  },
  reports: {
    rows: 19_569_830,
    largestRow: 1_204_476,
    rejected: 18_039_429,
    normal: 75_293_143,
    backstop: 78_109_458,
    single: 75_293_143,
  },
};

// The largest frame a stream socket is sent (stream-hub.ts envelope): STREAM_LIMITS.payloadBytes, the envelope's keys,
// the longest event and the longest stream. And a stream unit's isolate peak for each streamed kind, in bytes
// (status-bounds.test.ts "bounds a stream unit's isolate peak by the most a subject presents", RES-6): its rows with
// 25% headroom, its presented objects, its strings and scratch (four frames of MESSAGE_MAX and the presentation's), and
// their sum.
export const MESSAGE_MAX = 525_898;
export type UnitPeak = { rows: number; objects: number; transient: number; peak: number };
export const STREAM_UNIT_PEAKS: Record<"status" | "conversation" | "notification" | "announcement", UnitPeak> = {
  status: { rows: 19_339_642.5, objects: 17_456_490, transient: 2_121_652, peak: 38_917_784.5 },
  conversation: { rows: 23_018_052.5, objects: 21_453_999, transient: 2_121_652, peak: 46_593_703.5 },
  notification: { rows: 25_873_005, objects: 19_877_580, transient: 2_121_652, peak: 47_872_237 },
  announcement: { rows: 7_283_520, objects: 746_991, transient: 2_974_810, peak: 11_005_321 },
};
