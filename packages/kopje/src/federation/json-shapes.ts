// The shapes of compacted ActivityStreams JSON as remote objects are read (remote-status.ts, remote-emoji.ts): an
// object, a value or an array of values, a type that may be a list, and an actor's `published` (railsTime).

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asArray(value: unknown): unknown[] {
  return value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
}

// Date._parse refuses a longer string (its `limit:`, 128 characters), so ActiveRecord's cast is nil for it.
const DATE_PARSE_LIMIT = 128;

// Ruby's `\s`, which Date._parse skips, around the value.
const RUBY_SPACE = "[\\t\\n\\v\\f\\r ]*";
// YYYY-MM-DD; optionally `T`, `t` or a space and HH:MM, then optionally :SS and a fraction after `.` or `,`, then
// optionally spaces and `Z`, `z`, ±HH, ±HHMM or ±HH:MM.
const RAILS_TIME = new RegExp(
  `^${RUBY_SPACE}(?<year>\\d{4})-(?<month>\\d{2})-(?<day>\\d{2})` +
    "(?:[Tt ](?<hour>\\d{2}):(?<minute>\\d{2})(?::(?<second>\\d{2})(?:[.,](?<fraction>\\d+))?)?" +
    "(?: *(?:[Zz]|(?<sign>[+-])(?<offsetHours>\\d{2})(?::?(?<offsetMinutes>\\d{2}))?))?)?" +
    `${RUBY_SPACE}$`,
);

// A time as Mastodon 4.7 assigns a remote actor's `published` to accounts.created_at
// (process_account_service.rb:231): ActiveRecord 8.1.3.1's time-zone-aware cast, in UTC (ActiveSupport's
// `TimeZone#parse`, which reads the string with Date._parse and builds it with Ruby 4.0.9's `Time.new`, always with an
// offset, 0 when the string gives none), on the forms of RAILS_TIME, as rubyTime builds it. The fraction is cut to
// milliseconds, as the Store keeps them (Rails keeps microseconds). The instant as ISO 8601, or null for anything else:
// a value that is not a string, another form (one only Rails reads, test/fixtures/rails-time.json,
// docs/mastodon-deviations.md), a field `Time.new` refuses, or a string past DATE_PARSE_LIMIT UTF-16 code units.
export function railsTime(value: unknown): string | null {
  if (typeof value !== "string" || value.length > DATE_PARSE_LIMIT) {
    return null;
  }
  const parts = RAILS_TIME.exec(value)?.groups;
  if (parts === undefined) {
    return null;
  }
  const field = (name: string): number => Number(parts[name] ?? 0);
  const offsetMinutes = (parts.sign === "-" ? -1 : 1) * (field("offsetHours") * 60 + field("offsetMinutes"));
  const fields = {
    year: field("year"),
    month: field("month"),
    day: field("day"),
    hour: field("hour"),
    minute: field("minute"),
    second: field("second"),
  };
  const ms = rubyTime(fields, field("offsetMinutes") > 59 ? null : offsetMinutes);
  return ms === null ? null : new Date(ms + Number((parts.fraction ?? "").slice(0, 3).padEnd(3, "0"))).toISOString();
}

type TimeFields = { year: number; month: number; day: number; hour: number; minute: number; second: number };

// Ruby 4.0.9's `Time.new(year, month, day, hour, minute, second, offset)` for a whole-minute offset (time.c
// time_init_vtm, a fixed offset), as the epoch milliseconds of its whole second, or null where it raises. validate_vtm
// takes a month of 1 to 12, a day of 1 to 31 whatever the month, an hour of 0 to 24, a minute of 0 to 59 and a second
// of 0 to 60 (both 0 at hour 24), and an offset under a day. vtm_add_offset then subtracts the offset from the fields
// (vtm_add_day for a day it crosses) before timegmw counts them linearly (a day past the month's end, hour 24 and
// second 60 roll over; the image's time zone knows no leap second). vtm_add_day moves a day 31 of a shorter month to
// day 32, which struct vtm's 5-bit `mday` holds as 0, the last day of the month before (`2020-04-31T23:59:60-00:01` is
// 2020-03-31T00:01Z). test/fixtures/rails-time.json holds every such crossing.
function rubyTime(input: TimeFields, offsetMinutes: number | null): number | null {
  const t = { ...input };
  if (
    offsetMinutes === null ||
    Math.abs(offsetMinutes) >= 24 * 60 ||
    t.month < 1 ||
    t.month > 12 ||
    t.day < 1 ||
    t.day > 31 ||
    t.hour > 24 ||
    t.minute > (t.hour === 24 ? 0 : 59) ||
    t.second > (t.hour === 24 ? 0 : 60)
  ) {
    return null;
  }
  // vtm_add_offset(vtm, offset, -1): the offset's minutes and hours, each added with its carry when not 0.
  const sign = offsetMinutes < 0 ? 1 : -1;
  let minute = sign * (Math.abs(offsetMinutes) % 60);
  let hour = sign * Math.floor(Math.abs(offsetMinutes) / 60);
  let day = 0;
  if (minute !== 0) {
    minute += t.minute;
    if (minute < 0) {
      minute += 60;
      hour -= 1;
    }
    if (minute >= 60) {
      minute -= 60;
      hour += 1;
    }
    t.minute = minute;
  }
  if (hour !== 0) {
    hour += t.hour;
    if (hour < 0) {
      hour += 24;
      day = -1;
    }
    if (hour >= 24) {
      hour -= 24;
      day = 1;
    }
    t.hour = hour;
  }
  // vtm_add_day.
  if (day < 0) {
    if (t.month === 1 && t.day === 1) {
      Object.assign(t, { year: t.year - 1, month: 12, day: 31 });
    } else if (t.day === 1) {
      t.month -= 1;
      t.day = daysInMonth(t.year, t.month);
    } else {
      t.day -= 1;
    }
  } else if (day > 0) {
    if (t.month === 12 && t.day === 31) {
      Object.assign(t, { year: t.year + 1, month: 1, day: 1 });
    } else if (t.day === daysInMonth(t.year, t.month)) {
      t.month += 1;
      t.day = 1;
    } else {
      t.day = (t.day + 1) & 31;
    }
  }
  // timegmw_noleapsecond.
  const time = new Date(0);
  time.setUTCFullYear(t.year, t.month - 1, t.day);
  time.setUTCHours(t.hour, t.minute, t.second, 0);
  return time.getTime();
}

// The days of `month` (1 to 12) in the proleptic Gregorian `year`, as time.c's days_in_month_in_v.
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(2000, month, 0)).getUTCDate() - (month === 2 && !leapYear(year) ? 1 : 0);
}

function leapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

// JsonLdHelper#equals_or_includes_any?
export function typeIs(value: unknown, types: readonly string[]): boolean {
  return asArray(value).some((type) => typeof type === "string" && types.includes(type));
}

// A collection page's items (JsonLdHelper#collection_page_items: Collection and CollectionPage, items; the ordered
// ones, orderedItems), or null for anything else.
export function itemsOf(collection: Record<string, unknown>): unknown[] | null {
  const items =
    collection.type === "Collection" || collection.type === "CollectionPage"
      ? collection.items
      : collection.type === "OrderedCollection" || collection.type === "OrderedCollectionPage"
        ? collection.orderedItems
        : undefined;
  return items === undefined ? null : Array.isArray(items) ? items : items === null ? [] : [items];
}
