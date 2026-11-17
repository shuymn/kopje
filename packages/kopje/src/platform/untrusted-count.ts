import { railsBlank } from "./rails-blank";
import { rubyToI } from "./ruby-to-i";
import { MAX_UNTRUSTED_COUNT } from "./stored-bounds";

// A remote status's `likes` or `shares` as Mastodon 4.7.5 stores its count (statuses.untrusted_favourites_count and
// untrusted_reblogs_count, migration 0114_untrusted_counts): StatusParser#favourites_count and #reblogs_count read the
// collection's totalItems only when the collection is a JSON object (status_parser.rb:118-124), update_counts! and
// Create#attach_counts assign it only when it is not nil (process_status_update_service.rb:393-405, create.rb:206-216),
// ActiveModel's BigInteger casts it, and StatusStat#clamp_untrusted_counts clamps it to 0..MAX_UNTRUSTED_COUNT
// (test/fixtures/untrusted-counts.json, captured from Mastodon's image). So undefined when nothing is assigned (the
// stored count stays), null when the cast is nil (a blank string, a non-finite number, an array or an object: the
// stored count is cleared), else the count. A string is read by String#to_i, a number toward zero, true as 1 and false
// as 0; a magnitude past Number.MAX_SAFE_INTEGER clamps as Ruby's exact integer does.
export function untrustedCount(collection: unknown): number | null | undefined {
  if (typeof collection !== "object" || collection === null || Array.isArray(collection)) {
    return undefined;
  }
  const value: unknown = (collection as Record<string, unknown>).totalItems;
  if (value === undefined || value === null) {
    return undefined;
  }
  let count: number;
  if (typeof value === "string") {
    if (railsBlank(value)) {
      return null;
    }
    count = rubyToI(value);
  } else if (typeof value === "number") {
    // A Float past its range (1e400) is Infinity, whose to_i raises FloatDomainError, which the cast rescues as nil.
    if (!Number.isFinite(value)) {
      return null;
    }
    count = Math.trunc(value);
  } else if (typeof value === "boolean") {
    count = value ? 1 : 0;
  } else {
    return null;
  }
  return Math.min(Math.max(count, 0), MAX_UNTRUSTED_COUNT);
}
