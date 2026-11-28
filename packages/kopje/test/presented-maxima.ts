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
    account: { sqlite: 103_614, json: 142_608, rows: 1, nodes: 104 },
    status: { sqlite: 2_817_750, json: 2_806_101, rows: 1_597, nodes: 2_968 },
    quote: { sqlite: 5_057_205, json: 5_602_555, rows: 2_140, nodes: 5_918 },
    boostOfQuote: { sqlite: 5_204_109, json: 6_013_691, rows: 2_199, nodes: 6_890 },
    conversation: { sqlite: 6_417_071, json: 7_313_820, rows: 2_191, nodes: 7_157 },
    group: { sqlite: 5_920_311, json: 6_743_843, rows: 2_191, nodes: 6_762 },
    report: { sqlite: 5_368_870, json: 6_207_386, rows: 2_158, nodes: 6_271 },
    reportNotification: { sqlite: 823_553, json: 411_542, rows: 1_066, nodes: 372 },
    warningNotification: { sqlite: 92_529, json: 294_570, rows: 8, nodes: 238 },
    warningGroup: { sqlite: 92_529, json: 294_759, rows: 8, nodes: 245 },
    filteredNotification: { sqlite: 5_166_006, json: 5_745_289, rows: 2_163, nodes: 6_026 },
  },
  derived: {
    account: { sqlite: 103_614, json: 142_608, rows: 1, nodes: 104 },
    status: { sqlite: 2_409_750, json: 2_806_101, rows: 1_597, nodes: 2_968 },
    quote: { sqlite: 4_241_205, json: 5_602_555, rows: 2_140, nodes: 5_918 },
    boostOfQuote: { sqlite: 4_388_109, json: 6_013_691, rows: 2_199, nodes: 6_890 },
    conversation: { sqlite: 5_601_071, json: 7_313_820, rows: 2_191, nodes: 7_157 },
    group: { sqlite: 5_104_311, json: 6_743_843, rows: 2_191, nodes: 6_762 },
    report: { sqlite: 4_537_870, json: 6_117_386, rows: 2_158, nodes: 6_271 },
    reportNotification: { sqlite: 808_553, json: 321_542, rows: 1_066, nodes: 372 },
    warningNotification: { sqlite: 92_529, json: 294_570, rows: 8, nodes: 238 },
    warningGroup: { sqlite: 92_529, json: 294_759, rows: 8, nodes: 245 },
    filteredNotification: { sqlite: 4_350_006, json: 5_745_289, rows: 2_163, nodes: 6_026 },
  },
  raw: {
    account: { sqlite: 124_507, json: 124_972, rows: 1, nodes: 92 },
    status: { sqlite: 4_631_453, json: 2_204_016, rows: 1_500, nodes: 2_392 },
    quote: { sqlite: 7_184_294, json: 4_398_385, rows: 1_947, nodes: 4_766 },
    boostOfQuote: { sqlite: 7_480_627, json: 4_638_287, rows: 2_010, nodes: 5_726 },
    conversation: { sqlite: 8_883_677, json: 5_898_018, rows: 2_046, nodes: 5_861 },
    group: { sqlite: 8_259_816, json: 5_398_585, rows: 2_030, nodes: 5_514 },
    report: { sqlite: 7_569_956, json: 4_858_554, rows: 1_973, nodes: 5_095 },
    reportNotification: { sqlite: 2_374_257, json: 276_270, rows: 1_074, nodes: 348 },
    warningNotification: { sqlite: 134_442, json: 238_308, rows: 8, nodes: 230 },
    warningGroup: { sqlite: 134_442, json: 238_497, rows: 8, nodes: 237 },
    filteredNotification: { sqlite: 7_319_647, json: 4_523_483, rows: 1_974, nodes: 4_862 },
  },
  "emoji-poll": {
    account: { sqlite: 103_614, json: 142_608, rows: 1, nodes: 104 },
    status: { sqlite: 2_816_902, json: 2_818_202, rows: 1_597, nodes: 3_020 },
    quote: { sqlite: 5_055_509, json: 5_626_757, rows: 2_140, nodes: 6_022 },
    boostOfQuote: { sqlite: 5_202_413, json: 6_037_893, rows: 2_199, nodes: 6_994 },
    conversation: { sqlite: 6_415_375, json: 7_338_022, rows: 2_191, nodes: 7_261 },
    group: { sqlite: 5_918_615, json: 6_768_045, rows: 2_191, nodes: 6_866 },
    report: { sqlite: 5_367_174, json: 6_231_588, rows: 2_158, nodes: 6_375 },
    reportNotification: { sqlite: 823_553, json: 411_542, rows: 1_066, nodes: 372 },
    warningNotification: { sqlite: 92_529, json: 294_570, rows: 8, nodes: 238 },
    warningGroup: { sqlite: 92_529, json: 294_759, rows: 8, nodes: 245 },
    filteredNotification: { sqlite: 5_164_310, json: 5_769_491, rows: 2_163, nodes: 6_130 },
  },
  "emoji-cache": {
    account: { sqlite: 103_198, json: 141_296, rows: 1, nodes: 216 },
    status: { sqlite: 2_813_898, json: 2_801_530, rows: 1_597, nodes: 3_292 },
    quote: { sqlite: 5_049_501, json: 5_593_413, rows: 2_140, nodes: 6_566 },
    boostOfQuote: { sqlite: 5_196_231, json: 6_003_237, rows: 2_199, nodes: 7_650 },
    conversation: { sqlite: 6_405_562, json: 7_288_934, rows: 2_191, nodes: 9_149 },
    group: { sqlite: 5_911_215, json: 6_724_205, rows: 2_191, nodes: 8_306 },
    report: { sqlite: 5_359_101, json: 6_195_592, rows: 2_158, nodes: 7_599 },
    reportNotification: { sqlite: 823_205, json: 408_918, rows: 1_066, nodes: 596 },
    warningNotification: { sqlite: 90_812, json: 294_542, rows: 8, nodes: 694 },
    warningGroup: { sqlite: 90_812, json: 294_731, rows: 8, nodes: 701 },
    filteredNotification: { sqlite: 5_158_128, json: 5_734_835, rows: 2_163, nodes: 6_786 },
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
export const MOVED_ACCOUNT_MAXIMA = { json: 11_340, sqlite: 12_472, rows: 1, heap: 25_696 };

// The Profile (/api/v1/profile): the JSON of a witness with every part at its cap, and the conservative JSON derived
// from the caps (test/profile-api.test.ts).
export const PROFILE_MAXIMA = { json: 326_185, conservative: 372_038 };

// The ActivityPub Note of a local status at its bounds, its card's Link included, addressed to MAX_LOCAL_ADDRESSED
// accounts, in each fill of its parts (status-bounds.test.ts): what its read takes out of SQLite, the rows and nodes,
// and the JSON of the Note and of its Create.
type NoteShape = { sqlite: number; rows: number; nodes: number; note: number; create: number };
export const NOTE_FILLS: Record<Fill, NoteShape> = {
  escaped: { sqlite: 3_778_771, rows: 1_343, nodes: 3_212, note: 4_279_101, create: 6_335_745 },
  derived: { sqlite: 3_778_771, rows: 1_343, nodes: 3_212, note: 4_279_101, create: 6_335_745 },
  raw: { sqlite: 3_821_648, rows: 1_343, nodes: 3_212, note: 3_982_887, create: 6_039_531 },
  "emoji-poll": { sqlite: 3_778_586, rows: 1_343, nodes: 3_212, note: 4_278_916, create: 6_335_560 },
  "emoji-cache": { sqlite: 3_778_771, rows: 1_343, nodes: 3_212, note: 4_279_101, create: 6_335_745 },
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
    rows: 20_334_382.5,
    largestRow: 1_204_476,
    rejected: 18_177_666,
    normal: 61_975_612.5,
    backstop: 63_982_967.5,
    single: 61_975_612.5,
  },
  groups: {
    rows: 22_392_040,
    largestRow: 1_204_476,
    rejected: 20_435_790,
    normal: 76_391_394,
    backstop: 79_207_709,
    single: 76_391_394,
  },
  reports: {
    rows: 20_565_742.5,
    largestRow: 1_204_476,
    rejected: 18_762_969,
    normal: 75_292_275.5,
    backstop: 78_108_590.5,
    single: 75_292_275.5,
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
  status: { rows: 20_334_382.5, objects: 18_177_666, transient: 1_064_884, peak: 39_576_932.5 },
  conversation: { rows: 24_019_715, objects: 22_188_501, transient: 1_064_884, peak: 47_273_100 },
  notification: { rows: 26_882_242.5, objects: 20_605_617, transient: 1_064_884, peak: 48_552_743.5 },
  announcement: { rows: 7_283_520, objects: 746_991, transient: 1_918_042, peak: 9_948_553 },
};
