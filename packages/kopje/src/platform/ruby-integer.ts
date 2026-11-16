// Ruby's Kernel#Integer of a string, as VoteService reads each vote choice (`Integer(choice)`) on Ruby 4.0.9
// (rb_int_parse_cstr in bignum.c, base 0, raising): ASCII whitespace (ISSPACE) around it, one `+` or `-`, then digits
// with single underscores between them, in the base a prefix names (`0x`, `0b`, `0o`, `0d`, either case), else octal
// after a leading 0 (`010` is 8, `0_1` is 1), else decimal. Null where Integer() raises ArgumentError: anything else,
// trailing text included, so `08`, `1.5` and `1e3` are null (test/fixtures/ruby-integer, captured from Ruby). A
// magnitude past Number.MAX_SAFE_INTEGER is read as that, as rubyToI caps it.
const SHAPE = /^[\t\n\v\f\r ]*([+-]?)(0[xXbBoOdD])?([0-9A-Za-z_]+)[\t\n\v\f\r ]*$/;

// A base's digits, and the prefix Number() reads it by.
type Base = { digits: RegExp; prefix: string };
const BINARY: Base = { digits: /^[01]+(?:_[01]+)*$/, prefix: "0b" };
const OCTAL: Base = { digits: /^[0-7]+(?:_[0-7]+)*$/, prefix: "0o" };
const DECIMAL: Base = { digits: /^[0-9]+(?:_[0-9]+)*$/, prefix: "" };
const HEXADECIMAL: Base = { digits: /^[0-9a-fA-F]+(?:_[0-9a-fA-F]+)*$/, prefix: "0x" };
const PREFIXED: Record<string, Base> = { x: HEXADECIMAL, b: BINARY, o: OCTAL, d: DECIMAL };

export function rubyInteger(value: string): number | null {
  const match = SHAPE.exec(value);
  if (match === null) {
    return null;
  }
  const [, sign, prefix, digits = ""] = match;
  const base =
    prefix === undefined
      ? digits.length > 1 && digits.startsWith("0")
        ? OCTAL
        : DECIMAL
      : PREFIXED[prefix.charAt(1).toLowerCase()];
  if (base === undefined || !base.digits.test(digits)) {
    return null;
  }
  // Number() of digits past 2^53 rounds to at least 2^53, so the cap takes every such value.
  const magnitude = Math.min(Number(base.prefix + digits.replaceAll("_", "")), Number.MAX_SAFE_INTEGER);
  // 0 - 0 is 0, where -0 would be -0.
  return sign === "-" ? 0 - magnitude : magnitude;
}
