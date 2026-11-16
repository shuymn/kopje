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
    status: { sqlite: 2_769_540, json: 2_687_428, rows: 1486, nodes: 2403 },
    quote: { sqlite: 4_960_813, json: 5_365_237, rows: 1919, nodes: 4788 },
    boostOfQuote: { sqlite: 5_107_627, json: 5_776_203, rows: 1976, nodes: 5751 },
    conversation: { sqlite: 6_319_652, json: 7_074_750, rows: 1945, nodes: 5931 },
    group: { sqlite: 5_823_263, json: 6_505_357, rows: 1954, nodes: 5568 },
    report: { sqlite: 5_271_148, json: 5_969_566, rows: 1932, nodes: 5115 },
    reportNotification: { sqlite: 818_242, json: 410_181, rows: 1062, nodes: 305 },
    warningNotification: { sqlite: 92_489, json: 294_426, rows: 7, nodes: 230 },
    warningGroup: { sqlite: 92_489, json: 294_615, rows: 7, nodes: 237 },
    filteredNotification: { sqlite: 5_069_532, json: 5_507_825, rows: 1940, nodes: 4888 },
  },
  derived: {
    account: { sqlite: 103_598, json: 142_462, rows: 1, nodes: 96 },
    status: { sqlite: 2_361_540, json: 2_277_828, rows: 1486, nodes: 2403 },
    quote: { sqlite: 4_144_813, json: 4_546_037, rows: 1919, nodes: 4788 },
    boostOfQuote: { sqlite: 4_291_627, json: 4_957_003, rows: 1976, nodes: 5751 },
    conversation: { sqlite: 5_503_652, json: 6_255_550, rows: 1945, nodes: 5931 },
    group: { sqlite: 5_007_263, json: 5_686_157, rows: 1954, nodes: 5568 },
    report: { sqlite: 4_440_148, json: 5_060_366, rows: 1932, nodes: 5115 },
    reportNotification: { sqlite: 803_242, json: 320_181, rows: 1062, nodes: 305 },
    warningNotification: { sqlite: 92_489, json: 294_426, rows: 7, nodes: 230 },
    warningGroup: { sqlite: 92_489, json: 294_615, rows: 7, nodes: 237 },
    filteredNotification: { sqlite: 4_253_532, json: 4_688_625, rows: 1940, nodes: 4888 },
  },
  raw: {
    account: { sqlite: 124_491, json: 124_826, rows: 1, nodes: 84 },
    status: { sqlite: 4_454_829, json: 2_188_186, rows: 1490, nodes: 2391 },
    quote: { sqlite: 6_831_064, json: 4_366_753, rows: 1927, nodes: 4764 },
    boostOfQuote: { sqlite: 7_127_307, json: 4_606_485, rows: 1988, nodes: 5715 },
    conversation: { sqlite: 8_529_420, json: 5_864_634, rows: 2001, nodes: 5763 },
    group: { sqlite: 7_905_930, json: 5_365_785, rows: 1994, nodes: 5448 },
    report: { sqlite: 7_215_396, json: 4_826_420, rows: 1948, nodes: 5067 },
    reportNotification: { sqlite: 2_368_946, json: 274_909, rows: 1070, nodes: 281 },
    warningNotification: { sqlite: 134_402, json: 238_164, rows: 7, nodes: 222 },
    warningGroup: { sqlite: 134_402, json: 238_353, rows: 7, nodes: 229 },
    filteredNotification: { sqlite: 6_966_335, json: 4_491_705, rows: 1952, nodes: 4852 },
  },
  "emoji-poll": {
    account: { sqlite: 103_598, json: 142_462, rows: 1, nodes: 96 },
    status: { sqlite: 2_768_692, json: 2_699_529, rows: 1486, nodes: 2455 },
    quote: { sqlite: 4_959_117, json: 5_389_439, rows: 1919, nodes: 4892 },
    boostOfQuote: { sqlite: 5_105_931, json: 5_800_405, rows: 1976, nodes: 5855 },
    conversation: { sqlite: 6_317_956, json: 7_098_952, rows: 1945, nodes: 6035 },
    group: { sqlite: 5_821_567, json: 6_529_559, rows: 1954, nodes: 5672 },
    report: { sqlite: 5_269_452, json: 5_993_768, rows: 1932, nodes: 5219 },
    reportNotification: { sqlite: 818_242, json: 410_181, rows: 1062, nodes: 305 },
    warningNotification: { sqlite: 92_489, json: 294_426, rows: 7, nodes: 230 },
    warningGroup: { sqlite: 92_489, json: 294_615, rows: 7, nodes: 237 },
    filteredNotification: { sqlite: 5_067_836, json: 5_532_027, rows: 1940, nodes: 4992 },
  },
  "emoji-cache": {
    account: { sqlite: 103_182, json: 141_150, rows: 1, nodes: 208 },
    status: { sqlite: 2_765_688, json: 2_682_857, rows: 1486, nodes: 2727 },
    quote: { sqlite: 4_953_109, json: 5_356_095, rows: 1919, nodes: 5436 },
    boostOfQuote: { sqlite: 5_099_749, json: 5_765_749, rows: 1976, nodes: 6511 },
    conversation: { sqlite: 6_308_143, json: 7_049_864, rows: 1945, nodes: 7923 },
    group: { sqlite: 5_814_167, json: 6_485_719, rows: 1954, nodes: 7112 },
    report: { sqlite: 5_261_379, json: 5_957_772, rows: 1932, nodes: 6443 },
    reportNotification: { sqlite: 817_894, json: 407_557, rows: 1062, nodes: 529 },
    warningNotification: { sqlite: 90_772, json: 294_398, rows: 7, nodes: 686 },
    warningGroup: { sqlite: 90_772, json: 294_587, rows: 7, nodes: 693 },
    filteredNotification: { sqlite: 5_061_654, json: 5_497_371, rows: 1940, nodes: 5648 },
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
  status: 2_705_997,
  quote: 5_402_132,
  boostOfQuote: 5_818_802,
  conversation: 7_151_305,
  group: 6_568_692,
  report: 6_013_071,
  reportNotification: 442_471,
  warningNotification: 364_559,
  warningGroup: 364_748,
  filteredNotification: 5_548_025,
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
    rows: 19_339_557.5,
    largestRow: 1_204_476,
    rejected: 17_456_406,
    normal: 61_979_847.5,
    backstop: 63_987_202.5,
    single: 61_979_847.5,
  },
  groups: {
    rows: 21_393_020,
    largestRow: 1_204_476,
    rejected: 19_706_076,
    normal: 76_382_980,
    backstop: 79_199_295,
    single: 76_382_980,
  },
  reports: {
    rows: 19_567_077.5,
    largestRow: 1_204_476,
    rejected: 18_039_213,
    normal: 75_290_174.5,
    backstop: 78_106_489.5,
    single: 75_290_174.5,
  },
};
