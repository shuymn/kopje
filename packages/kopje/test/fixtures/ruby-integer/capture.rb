# frozen_string_literal: true

# Ruby's Kernel#Integer, as VoteService reads each of a vote's choices (Integer(choice)), for integer.json
# (params.test.ts, "rubyInteger"): each string and what Integer() reads it as, or null where it raises; then each JSON
# number as Rails' JSON params hold it (a Float or an Integer) and what Integer() reads it as. Written as text, so a
# value past 2^53 keeps its digits. Mastodon 4.7.5 runs on Ruby 4.0.9; capture with its image, without network:
#
#   docker run --rm -i --network none --entrypoint ruby ghcr.io/mastodon/mastodon:v4.7.5 - < capture.rb > integer.json

require 'json'

STRINGS = [
  # The review's cases: each is 1.
  '0d1', '0b1', '0x1', '0_1',
  # Whitespace: ASCII (ISSPACE) only, before and after.
  ' 1', '1 ', " \t1\n ", "\v1\f", "\r1", " 1", "1 ", "　1", "1\u0000", "\u00001", '1 2', "1\n2",
  # One sign, then the number at once.
  '+1', '-1', '+-1', '--1', '+', '-', '- 1', '+ 1', ' -1', '-1 ', '-+1',
  # Zero.
  '0', '00', '-0', '+0', '000', '0_0', '0_', '0__0', '-0_', '0 ', ' 0', '_0',
  # Decimal.
  '1', '9', '10', '1_000', '1_0', '1__0', '_1', '1_', '12abc', '1.5', '1e3', '1,000', "١", "１", '',
  # A leading 0 is octal.
  '01', '07', '08', '010', '0_1', '00_1', '0_0_1', '0__1', '0_8', '-010', '0o17', '0O17', '0o8', '0o', '0o_1',
  '0o1_7', '0o1__7', '0o01',
  # Hexadecimal.
  '0x1A', '0X1', '0x1a', '0xG', '0x', '0x_1', '0x1_f', '0x1__f', '-0x1A', '+0x1', '0x 1', '0x1 ', ' 0x1', '0x0_1',
  '0x0_', '0xff_',
  # Binary.
  '0B1', '0b101', '0b2', '0b', '0b_1', '0b1_0', '-0b1', '0b01',
  # The 0d prefix.
  '0D1', '0d09', '0d', '0d_1', '0d1_0', '0da', '-0d5', '0d0d5', '0d0_1',
  # Two prefixes, or a prefix after zeros.
  '0x0x1', '00x1', '0b0x1', '0x-1', '0-1',
  # Magnitudes.
  '9007199254740991', '9007199254740992', '-9007199254740993', '9' * 30, "-#{'9' * 30}", "0x#{'f' * 20}",
  "0b#{'1' * 60}", "#{'0' * 40}5", "0d#{'0' * 40}5"
].freeze

# JSON texts, parsed as Rails parses a JSON body.
NUMBERS = %w[0 1 -1 3.9 -3.9 0.5 -0.5 -0.0 1.0 1e-7 -1e-7 1e21 -1e21 1E3 1.5e2 2.5e-1 12345678901234567890123
             -12345678901234567890123 9007199254740993 1e400].freeze

def integer(value)
  Integer(value).to_s
rescue ArgumentError, TypeError, FloatDomainError
  nil
end

puts JSON.pretty_generate(
  {
    ruby: RUBY_VERSION,
    strings: STRINGS.map { |value| { value: value, integer: integer(value) } },
    numbers: NUMBERS.map { |json| { json: json, integer: integer(JSON.parse(json)) } }
  }
)
