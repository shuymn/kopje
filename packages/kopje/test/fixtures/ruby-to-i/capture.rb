# frozen_string_literal: true

# Ruby's String#to_i (base 10, rb_int_parse_cstr in bignum.c) for to-i.json (params.test.ts, "rubyToI"): each value and
# what Ruby reads it as; then each JSON number as Rails' JSON params hold it (a Float or an Integer) and its to_i (null
# where it raises). Written as text, so a value past 2^53 keeps its digits. Mastodon 4.7.5 runs on Ruby 4.0.9; capture
# with its image, without network:
#
#   docker run --rm -i --network none --entrypoint ruby ghcr.io/mastodon/mastodon:v4.7.5 - < capture.rb > to-i.json

require 'json'

VALUES = [
  # Whitespace: ASCII (ISSPACE) only.
  ' 12', "\t-3", "\n\n42\n", "\v7", "\f8", "\r9", "\t\n\v\f\r-3", "\u00a05", "\u00a0-1", "\u20005", "\u30005",
  "\u00001", "1\u00002",
  # One sign.
  '+4', '-2', '2', '+', '-', '++1', '--1', '+-1', '-+1', '- 1', '  +  3',
  # The 0d prefix, in either case, once.
  '0d15', '0D9', '-0d7', '+0d1_0', '-0d5', '-0D5', '-0d0_1', '0d', '-0d', '0d_1', '-0d_5', '-0dx5', '-0d0d5', '0d+5',
  '0d-5', '+0d-5',
  # Underscores between digits, one at a time.
  '1_000', '1_0', '-1_0', '1_2_3', '1__0', '-1__2', '_1', '-_1', '1_', '12_', '-1_', '0_0', '-0_0', '-0_1', '-0_',
  '-0__1', '-0_ 1', '1 000',
  # Whatever follows the digits is ignored; nothing else is a digit.
  '12abc', '-2abc', '500px', '-1e3', '1e3', '3.9', '-2.5', '-0.5', '0x1A', '-0x5', '0b101', '-0b1', '0o17', '-0o7',
  "\uff11\uff12", "-\u0663", "\u{1f600}1", '', 'abc', '-abc', "  \t-0_0_1x",
  # Zeros and magnitudes.
  '-0', '-00', '00012', "#{'0' * 40}5", '9007199254740991', '9007199254740992', '-9007199254740993', '9' * 30,
  "-#{'9' * 30}"
].freeze

# JSON texts, parsed as Rails parses a JSON body: `1e21` is a Float, where the string "1e21" reads as 1.
NUMBERS = %w[0 1 -1 3.9 -3.9 0.5 -0.5 -0.0 1.0 1e-7 -1e-7 1e21 -1e21 1E3 1.5e2 2.5e-1 12345678901234567890123
             -12345678901234567890123 9007199254740993 1e400].freeze

def to_i(number)
  number.to_i.to_s
rescue FloatDomainError
  nil
end

puts JSON.pretty_generate(
  {
    ruby: RUBY_VERSION,
    rows: VALUES.map { |value| { value: value, to_i: value.to_i.to_s } },
    numbers: NUMBERS.map { |json| { json: json, to_i: to_i(JSON.parse(json)) } }
  }
)
