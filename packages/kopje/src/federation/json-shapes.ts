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
// (process_account_service.rb:231): ActiveRecord 8.1.3.1's time-zone-aware cast, in UTC (`Time.zone.parse`, which
// reads the string with Date._parse and builds it with Ruby's Time.new), on the forms of RAILS_TIME. A day 29 to 31
// past the month's end rolls over as Time.new rolls it, hour 24 at minute and second 0 is the next midnight, second
// 60 the next minute; the fraction is cut to milliseconds, as the Store keeps them (Rails keeps microseconds); an
// offset is at most 23:59. The instant as ISO 8601, or null for anything else: a value that is not a string, another
// form (one only Rails reads, test/fixtures/rails-time.json, docs/mastodon-deviations.md), a field out of range, or a
// string past DATE_PARSE_LIMIT UTF-16 code units.
export function railsTime(value: unknown): string | null {
  if (typeof value !== "string" || value.length > DATE_PARSE_LIMIT) {
    return null;
  }
  const parts = RAILS_TIME.exec(value)?.groups;
  if (parts === undefined) {
    return null;
  }
  const field = (name: string): number => Number(parts[name] ?? 0);
  const [month, day, hour, minute] = [field("month"), field("day"), field("hour"), field("minute")];
  const [second, offsetHours, offsetMinutes] = [field("second"), field("offsetHours"), field("offsetMinutes")];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 24 ||
    (hour === 24 && (minute !== 0 || second !== 0)) ||
    minute > 59 ||
    second > 60 ||
    offsetHours > 23 ||
    offsetMinutes > 59
  ) {
    return null;
  }
  const time = new Date(0);
  time.setUTCFullYear(field("year"), month - 1, day);
  time.setUTCHours(hour, minute, second, Number((parts.fraction ?? "").slice(0, 3).padEnd(3, "0")));
  const offset = (parts.sign === "-" ? -1 : 1) * (offsetHours * 60 + offsetMinutes) * 60_000;
  return new Date(time.getTime() - offset).toISOString();
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
