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
    status: { sqlite: 2_817_694, json: 2_806_101, rows: 1_597, nodes: 2_968 },
    quote: { sqlite: 5_057_093, json: 5_602_555, rows: 2_140, nodes: 5_918 },
    boostOfQuote: { sqlite: 5_203_973, json: 6_013_691, rows: 2_199, nodes: 6_890 },
    conversation: { sqlite: 6_416_759, json: 7_313_820, rows: 2_191, nodes: 7_157 },
    group: { sqlite: 5_920_071, json: 6_743_843, rows: 2_191, nodes: 6_762 },
    report: { sqlite: 5_368_646, json: 6_207_386, rows: 2_158, nodes: 6_271 },
    reportNotification: { sqlite: 823_521, json: 411_542, rows: 1_066, nodes: 372 },
    warningNotification: { sqlite: 92_521, json: 294_570, rows: 8, nodes: 238 },
    warningGroup: { sqlite: 92_521, json: 294_759, rows: 8, nodes: 245 },
    filteredNotification: { sqlite: 5_165_878, json: 5_745_289, rows: 2_163, nodes: 6_026 },
  },
  derived: {
    account: { sqlite: 103_606, json: 142_608, rows: 1, nodes: 104 },
    status: { sqlite: 2_409_694, json: 2_806_101, rows: 1_597, nodes: 2_968 },
    quote: { sqlite: 4_241_093, json: 5_602_555, rows: 2_140, nodes: 5_918 },
    boostOfQuote: { sqlite: 4_387_973, json: 6_013_691, rows: 2_199, nodes: 6_890 },
    conversation: { sqlite: 5_600_759, json: 7_313_820, rows: 2_191, nodes: 7_157 },
    group: { sqlite: 5_104_071, json: 6_743_843, rows: 2_191, nodes: 6_762 },
    report: { sqlite: 4_537_646, json: 6_117_386, rows: 2_158, nodes: 6_271 },
    reportNotification: { sqlite: 808_521, json: 321_542, rows: 1_066, nodes: 372 },
    warningNotification: { sqlite: 92_521, json: 294_570, rows: 8, nodes: 238 },
    warningGroup: { sqlite: 92_521, json: 294_759, rows: 8, nodes: 245 },
    filteredNotification: { sqlite: 4_349_878, json: 5_745_289, rows: 2_163, nodes: 6_026 },
  },
  raw: {
    account: { sqlite: 124_499, json: 124_972, rows: 1, nodes: 92 },
    status: { sqlite: 4_619_873, json: 2_189_120, rows: 1_500, nodes: 2_400 },
    quote: { sqlite: 7_161_134, json: 4_368_593, rows: 1_947, nodes: 4_782 },
    boostOfQuote: { sqlite: 7_457_443, json: 4_608_495, rows: 2_010, nodes: 5_742 },
    conversation: { sqlite: 8_860_317, json: 5_868_226, rows: 2_046, nodes: 5_877 },
    group: { sqlite: 8_236_528, json: 5_368_793, rows: 2_030, nodes: 5_530 },
    report: { sqlite: 7_546_684, json: 4_828_762, rows: 1_973, nodes: 5_111 },
    reportNotification: { sqlite: 2_374_225, json: 276_270, rows: 1_074, nodes: 348 },
    warningNotification: { sqlite: 134_434, json: 238_308, rows: 8, nodes: 230 },
    warningGroup: { sqlite: 134_434, json: 238_497, rows: 8, nodes: 237 },
    filteredNotification: { sqlite: 7_296_471, json: 4_493_691, rows: 1_974, nodes: 4_878 },
  },
  "emoji-poll": {
    account: { sqlite: 103_606, json: 142_608, rows: 1, nodes: 104 },
    status: { sqlite: 2_816_846, json: 2_818_202, rows: 1_597, nodes: 3_020 },
    quote: { sqlite: 5_055_397, json: 5_626_757, rows: 2_140, nodes: 6_022 },
    boostOfQuote: { sqlite: 5_202_277, json: 6_037_893, rows: 2_199, nodes: 6_994 },
    conversation: { sqlite: 6_415_063, json: 7_338_022, rows: 2_191, nodes: 7_261 },
    group: { sqlite: 5_918_375, json: 6_768_045, rows: 2_191, nodes: 6_866 },
    report: { sqlite: 5_366_950, json: 6_231_588, rows: 2_158, nodes: 6_375 },
    reportNotification: { sqlite: 823_521, json: 411_542, rows: 1_066, nodes: 372 },
    warningNotification: { sqlite: 92_521, json: 294_570, rows: 8, nodes: 238 },
    warningGroup: { sqlite: 92_521, json: 294_759, rows: 8, nodes: 245 },
    filteredNotification: { sqlite: 5_164_182, json: 5_769_491, rows: 2_163, nodes: 6_130 },
  },
  "emoji-cache": {
    account: { sqlite: 103_190, json: 141_296, rows: 1, nodes: 216 },
    status: { sqlite: 2_813_842, json: 2_801_530, rows: 1_597, nodes: 3_292 },
    quote: { sqlite: 5_049_389, json: 5_593_413, rows: 2_140, nodes: 6_566 },
    boostOfQuote: { sqlite: 5_196_095, json: 6_003_237, rows: 2_199, nodes: 7_650 },
    conversation: { sqlite: 6_405_250, json: 7_288_934, rows: 2_191, nodes: 9_149 },
    group: { sqlite: 5_910_975, json: 6_724_205, rows: 2_191, nodes: 8_306 },
    report: { sqlite: 5_358_877, json: 6_195_592, rows: 2_158, nodes: 7_599 },
    reportNotification: { sqlite: 823_173, json: 408_918, rows: 1_066, nodes: 596 },
    warningNotification: { sqlite: 90_804, json: 294_542, rows: 8, nodes: 694 },
    warningGroup: { sqlite: 90_804, json: 294_731, rows: 8, nodes: 701 },
    filteredNotification: { sqlite: 5_158_000, json: 5_734_835, rows: 2_163, nodes: 6_786 },
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
  status: 2_826_006,
  quote: 5_642_122,
  boostOfQuote: 6_059_222,
  conversation: 7_396_167,
  group: 6_811_930,
  report: 6_254_323,
  reportNotification: 444_352,
  warningNotification: 364_965,
  warningGroup: 365_154,
  filteredNotification: 5_788_421,
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
  escaped: { sqlite: 3_778_727, rows: 1_343, nodes: 3_208, note: 4_278_825, create: 6_335_409 },
  derived: { sqlite: 3_778_727, rows: 1_343, nodes: 3_208, note: 4_278_825, create: 6_335_409 },
  raw: { sqlite: 3_821_604, rows: 1_343, nodes: 3_208, note: 3_982_611, create: 6_039_195 },
  "emoji-poll": { sqlite: 3_778_542, rows: 1_343, nodes: 3_208, note: 4_278_640, create: 6_335_224 },
  "emoji-cache": { sqlite: 3_778_727, rows: 1_343, nodes: 3_208, note: 4_278_825, create: 6_335_409 },
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
    rows: 20_275_922.5,
    largestRow: 1_204_476,
    rejected: 18_177_666,
    normal: 61_966_304.5,
    backstop: 63_973_659.5,
    single: 61_966_304.5,
  },
  groups: {
    rows: 22_333_060,
    largestRow: 1_204_476,
    rejected: 20_435_790,
    normal: 76_381_566,
    backstop: 79_197_881,
    single: 76_381_566,
  },
  reports: {
    rows: 20_506_902.5,
    largestRow: 1_204_476,
    rejected: 18_762_969,
    normal: 75_282_587.5,
    backstop: 78_098_902.5,
    single: 75_282_587.5,
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
  status: { rows: 20_275_922.5, objects: 18_177_666, transient: 1_064_884, peak: 39_518_472.5 },
  conversation: { rows: 23_960_375, objects: 22_188_501, transient: 1_064_884, peak: 47_213_760 },
  notification: { rows: 26_823_582.5, objects: 20_605_617, transient: 1_064_884, peak: 48_494_083.5 },
  announcement: { rows: 7_283_520, objects: 746_991, transient: 1_918_042, peak: 9_948_553 },
};
