// Removing a set of characters from the ends of a string. Each end is scanned by index, so the time is linear in the
// string's length. A set holds only characters of one UTF-16 code unit, none a surrogate, so a scan never splits a
// surrogate pair.

// Ruby's String#strip as Mastodon 4.7.5's Ruby (4.0) has it: NUL, tab, LF, VT, FF, CR and space, at either end; no
// other character (not NBSP, U+0085 or another Unicode space).
const RUBY_STRIP = "\0\t\n\v\f\r ";

// `value` without the characters of `set` at its start and at its end.
export function stripEnds(value: string, set: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && set.includes(value.charAt(start))) {
    start++;
  }
  while (end > start && set.includes(value.charAt(end - 1))) {
    end--;
  }
  return value.slice(start, end);
}

export function rubyStrip(value: string): string {
  return stripEnds(value, RUBY_STRIP);
}
