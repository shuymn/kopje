// The figures test/status-bounds.test.ts asserts for docs/threat-model.md "Maxima of presented units" and "Heap at
// 8 MiB per answer" (RES-3): what each fill measures, the conservative JSON, the moved-to account's and the Note's
// maxima, and the heap model's peaks. test-node/presented-maxima.test.ts compares the document's tables with them cell
// by cell. It imports nothing, so workerd and Node both load it.

// The ceiling of every atomic shape's JSON, in whole percent of ANSWER_BYTES: the least that keeps the conversation's
// spare at least SPARE_FLOOR (status-bounds.test.ts asserts both).
export const SHAPE_CEILING_PERCENT = 89;

// The heap model's bounds (status-bounds.test.ts): half of the Store isolate's 128 MB, within which a timeline's peak
// stays; the least spare the timeline heap and the conversation's JSON keep, which a change may not cross without a
// review (#1142); the step STATUS_ANSWER_BYTES is derived in; and the chunk caps the peaks are measured at
// (status-presenter.ts PAGE_CHUNKS and LARGE_ITEM_CHUNKS, which the test holds equal).
export const HALF = 64_000_000;
export const SPARE_FLOOR = 4096;
export const CAP_STEP = 8 * 1024;
export const TIMELINE_CHUNK_BYTES = 392 * 1024;
export const LARGE_ITEM_CHUNK_BYTES = 1024 * 1024;

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
    status: { sqlite: 2_817_590, json: 2_805_797, rows: 1597, nodes: 2972 },
    quote: { sqlite: 5_056_885, json: 5_601_947, rows: 2140, nodes: 5926 },
    boostOfQuote: { sqlite: 5_203_765, json: 6_013_083, rows: 2199, nodes: 6898 },
    conversation: { sqlite: 6_416_551, json: 7_313_212, rows: 2191, nodes: 7165 },
    group: { sqlite: 5_919_863, json: 6_743_235, rows: 2191, nodes: 6770 },
    report: { sqlite: 5_368_438, json: 6_206_778, rows: 2158, nodes: 6279 },
    reportNotification: { sqlite: 823_521, json: 411_542, rows: 1066, nodes: 372 },
    warningNotification: { sqlite: 92_521, json: 294_570, rows: 8, nodes: 238 },
    warningGroup: { sqlite: 92_521, json: 294_759, rows: 8, nodes: 245 },
    filteredNotification: { sqlite: 5_165_670, json: 5_744_681, rows: 2163, nodes: 6034 },
  },
  derived: {
    account: { sqlite: 103_606, json: 142_608, rows: 1, nodes: 104 },
    status: { sqlite: 2_409_590, json: 2_805_797, rows: 1597, nodes: 2972 },
    quote: { sqlite: 4_240_885, json: 5_601_947, rows: 2140, nodes: 5926 },
    boostOfQuote: { sqlite: 4_387_765, json: 6_013_083, rows: 2199, nodes: 6898 },
    conversation: { sqlite: 5_600_551, json: 7_313_212, rows: 2191, nodes: 7165 },
    group: { sqlite: 5_103_863, json: 6_743_235, rows: 2191, nodes: 6770 },
    report: { sqlite: 4_537_438, json: 6_116_778, rows: 2158, nodes: 6279 },
    reportNotification: { sqlite: 808_521, json: 321_542, rows: 1066, nodes: 372 },
    warningNotification: { sqlite: 92_521, json: 294_570, rows: 8, nodes: 238 },
    warningGroup: { sqlite: 92_521, json: 294_759, rows: 8, nodes: 245 },
    filteredNotification: { sqlite: 4_349_670, json: 5_744_681, rows: 2163, nodes: 6034 },
  },
  raw: {
    account: { sqlite: 124_499, json: 124_972, rows: 1, nodes: 92 },
    status: { sqlite: 4_619_421, json: 2_188_824, rows: 1500, nodes: 2404 },
    quote: { sqlite: 7_160_230, json: 4_368_001, rows: 1947, nodes: 4790 },
    boostOfQuote: { sqlite: 7_456_539, json: 4_607_903, rows: 2010, nodes: 5750 },
    conversation: { sqlite: 8_859_413, json: 5_867_634, rows: 2046, nodes: 5885 },
    group: { sqlite: 8_235_624, json: 5_368_201, rows: 2030, nodes: 5538 },
    report: { sqlite: 7_545_780, json: 4_828_170, rows: 1973, nodes: 5119 },
    reportNotification: { sqlite: 2_374_225, json: 276_270, rows: 1074, nodes: 348 },
    warningNotification: { sqlite: 134_434, json: 238_308, rows: 8, nodes: 230 },
    warningGroup: { sqlite: 134_434, json: 238_497, rows: 8, nodes: 237 },
    filteredNotification: { sqlite: 7_295_567, json: 4_493_099, rows: 1974, nodes: 4886 },
  },
  "emoji-poll": {
    account: { sqlite: 103_606, json: 142_608, rows: 1, nodes: 104 },
    status: { sqlite: 2_816_742, json: 2_817_898, rows: 1597, nodes: 3024 },
    quote: { sqlite: 5_055_189, json: 5_626_149, rows: 2140, nodes: 6030 },
    boostOfQuote: { sqlite: 5_202_069, json: 6_037_285, rows: 2199, nodes: 7002 },
    conversation: { sqlite: 6_414_855, json: 7_337_414, rows: 2191, nodes: 7269 },
    group: { sqlite: 5_918_167, json: 6_767_437, rows: 2191, nodes: 6874 },
    report: { sqlite: 5_366_742, json: 6_230_980, rows: 2158, nodes: 6383 },
    reportNotification: { sqlite: 823_521, json: 411_542, rows: 1066, nodes: 372 },
    warningNotification: { sqlite: 92_521, json: 294_570, rows: 8, nodes: 238 },
    warningGroup: { sqlite: 92_521, json: 294_759, rows: 8, nodes: 245 },
    filteredNotification: { sqlite: 5_163_974, json: 5_768_883, rows: 2163, nodes: 6138 },
  },
  "emoji-cache": {
    account: { sqlite: 103_190, json: 141_296, rows: 1, nodes: 216 },
    status: { sqlite: 2_813_738, json: 2_801_226, rows: 1597, nodes: 3296 },
    quote: { sqlite: 5_049_181, json: 5_592_805, rows: 2140, nodes: 6574 },
    boostOfQuote: { sqlite: 5_195_887, json: 6_002_629, rows: 2199, nodes: 7658 },
    conversation: { sqlite: 6_405_042, json: 7_288_326, rows: 2191, nodes: 9157 },
    group: { sqlite: 5_910_767, json: 6_723_597, rows: 2191, nodes: 8314 },
    report: { sqlite: 5_358_669, json: 6_194_984, rows: 2158, nodes: 7607 },
    reportNotification: { sqlite: 823_173, json: 408_918, rows: 1066, nodes: 596 },
    warningNotification: { sqlite: 90_804, json: 294_542, rows: 8, nodes: 694 },
    warningGroup: { sqlite: 90_804, json: 294_731, rows: 8, nodes: 701 },
    filteredNotification: { sqlite: 5_157_792, json: 5_734_227, rows: 2163, nodes: 6794 },
  },
};

// The fill each measured column of the table of maxima comes from: for every shape, it gives the most of all fills.
// The rows read come from no one fill: the raw fill's tagged collections are restored text, which shows none of them
// and so reads none of their items, so each shape's rows are the most any fill gives.
export const COLUMN_FILL: Record<Exclude<keyof Shape, "rows">, Fill> = {
  sqlite: "raw",
  json: "emoji-poll",
  nodes: "emoji-cache",
};

// The conservative JSON of each shape (status-bounds.test.ts conservativeJson).
export const CONSERVATIVE_JSON: Record<ShapeName, number> = {
  account: 150_428,
  status: 2_825_702,
  quote: 5_641_514,
  boostOfQuote: 6_058_614,
  conversation: 7_395_559,
  group: 6_811_322,
  report: 6_253_715,
  reportNotification: 444_352,
  warningNotification: 364_965,
  warningGroup: 365_154,
  filteredNotification: 5_787_813,
};

// The nested moved-to account, derived from its caps: its JSON, and the SQLite bytes, count and heap of its rows.
export const MOVED_ACCOUNT_MAXIMA = { json: 11_340, sqlite: 12_464, rows: 1, heap: 25_664 };

// The Profile (/api/v1/profile): the JSON of a witness with every part at its cap, and the conservative JSON derived
// from the caps (test/profile-api.test.ts).
export const PROFILE_MAXIMA = { json: 326_185, conservative: 372_038 };

// The ActivityPub Note of a local status at its bounds, its card's Link included, addressed to MAX_LOCAL_ADDRESSED
// accounts, in each fill of its parts (status-bounds.test.ts): what its read takes out of SQLite, the rows and nodes,
// and the JSON of the Note and of its Create.
type NoteShape = { sqlite: number; rows: number; nodes: number; note: number; create: number };
export const NOTE_FILLS: Record<Fill, NoteShape> = {
  escaped: { sqlite: 3_770_275, rows: 1_343, nodes: 3_188, note: 4_262_329, create: 6_318_913 },
  derived: { sqlite: 3_770_275, rows: 1_343, nodes: 3_188, note: 4_262_329, create: 6_318_913 },
  raw: { sqlite: 3_813_152, rows: 1_343, nodes: 3_188, note: 3_974_223, create: 6_030_807 },
  "emoji-poll": { sqlite: 3_770_090, rows: 1_343, nodes: 3_188, note: 4_262_144, create: 6_318_728 },
  "emoji-cache": { sqlite: 3_770_275, rows: 1_343, nodes: 3_188, note: 4_262_329, create: 6_318_913 },
};

// Each column's most of NOTE_FILLS, as the table of maxima states it.
export const NOTE_MAXIMA: NoteShape = {
  sqlite: Math.max(...FILLS.map((fill) => NOTE_FILLS[fill].sqlite)),
  rows: Math.max(...FILLS.map((fill) => NOTE_FILLS[fill].rows)),
  nodes: Math.max(...FILLS.map((fill) => NOTE_FILLS[fill].nodes)),
  note: Math.max(...FILLS.map((fill) => NOTE_FILLS[fill].note)),
  create: Math.max(...FILLS.map((fill) => NOTE_FILLS[fill].create)),
};

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
    rows: 20_273_142.5,
    largestRow: 1_204_476,
    rejected: 18_175_842,
    normal: 61_986_276.5,
    backstop: 63_993_631.5,
    single: 61_986_276.5,
  },
  groups: {
    rows: 22_330_280,
    largestRow: 1_204_476,
    rejected: 20_433_966,
    normal: 76_401_538,
    backstop: 79_217_853,
    single: 76_401_538,
  },
  reports: {
    rows: 20_504_122.5,
    largestRow: 1_204_476,
    rejected: 18_761_145,
    normal: 75_302_559.5,
    backstop: 78_118_874.5,
    single: 75_302_559.5,
  },
};

// An announcement's conservative JSON, in bytes: derivedAnnouncementMaxima's entity (test/announcement-helpers.ts),
// derived from the caps, which test/announcement-bounds.test.ts asserts. The list holds MAX_LIVE_ANNOUNCEMENTS of them
// and a stream payload one, double-encoded.
export const ANNOUNCEMENT_JSON = 248_997;

// The largest frame a stream socket is sent (stream-hub.ts envelope): STREAM_LIMITS.payloadBytes, the envelope's keys,
// the longest event and the longest stream. And a stream unit's isolate peak for each streamed kind, in bytes
// (status-bounds.test.ts "bounds a stream unit's isolate peak by the most a subject presents", RES-6): its rows with
// 25% headroom, its presented objects, its strings and scratch (four frames of MESSAGE_MAX and the presentation's), and
// their sum.
export const MESSAGE_MAX = 261_706;
export type UnitPeak = { rows: number; objects: number; transient: number; peak: number };
export const STREAM_UNIT_PEAKS: Record<"status" | "conversation" | "notification" | "announcement", UnitPeak> = {
  status: { rows: 20_273_142.5, objects: 18_175_842, transient: 1_064_884, peak: 39_513_868.5 },
  conversation: { rows: 23_957_595, objects: 22_186_677, transient: 1_064_884, peak: 47_209_156 },
  notification: { rows: 26_820_802.5, objects: 20_603_793, transient: 1_064_884, peak: 48_489_479.5 },
  announcement: { rows: 7_283_520, objects: 746_991, transient: 1_918_042, peak: 9_948_553 },
};
