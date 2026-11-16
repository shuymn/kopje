// Ruby's String#to_i in base 10, as Mastodon 4.7.5 (Ruby 4.0.9, rb_int_parse_cstr in bignum.c) reads an integer
// parameter: after ASCII whitespace (ISSPACE), one `+` or `-`, an optional `0d` or `0D`, then digits with single
// underscores between them; whatever follows is ignored, and a value without such digits is 0. So `1__0` is 1, and `_1`
// and a no-break space before `5` are 0 (test/fixtures/ruby-to-i, captured from Ruby). A magnitude past
// Number.MAX_SAFE_INTEGER is read as that, where Ruby reads any length (docs/mastodon-deviations.md, "Request
// parameters"), so every reader gets a safe integer.
const RUBY_TO_I = /^[\t\n\v\f\r ]*([+-]?)(?:0[dD])?([0-9]+(?:_[0-9]+)*)/;

export function rubyToI(value: string): number {
  const match = RUBY_TO_I.exec(value);
  if (match === null) {
    return 0;
  }
  // Number() of a decimal past 2^53 rounds to at least 2^53, so the cap takes every such value.
  const magnitude = Math.min(Number((match[2] ?? "0").replaceAll("_", "")), Number.MAX_SAFE_INTEGER);
  // 0 - 0 is 0, where -0 would be -0.
  return match[1] === "-" ? 0 - magnitude : magnitude;
}
