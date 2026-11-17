# frozen_string_literal: true

# Whether Mastodon's JSON parser (json 2.21.2, JSON.parse as Mastodon 4.7.5 calls it on remote JSON) parses each text,
# for verdicts.json (test-node/json-bounds.test.ts, "jsonTextMalformed"): unpaired surrogate escapes in keys and values,
# where a later duplicate key replaces them, after an escaped backslash, and well-formed controls. Every text is
# UTF-8, as a body decoded from bytes is. This is the parser alone: Mastodon's inbox reads a body as Rails request
# parameters first, which refuses invalid UTF-8 in a value (docs/mastodon-deviations.md, "Reading inbound activities").
# Capture with the release's image, without network:
#
#   docker run --rm -i --network none --entrypoint ruby ghcr.io/mastodon/mastodon:v4.7.5 - < capture.rb > verdicts.json

require 'json'

TEXTS = [
  # One string token.
  '{"a":"\ud800"}', '{"a":"\udc00"}', '{"a":"\ud800\udc00"}', '{"a":"\uD83D\uDE00"}', '{"a":"\uD83D"}',
  '{"a":"\ud800A"}', '{"a":"\ud800\ud800"}', '{"a":"\ud800\u0041"}', '{"a":"\udc00\ud800"}', '{"a":"\ud800\n"}',
  '{"a":"\ud800\"","b":1}', '{"a":"x\udbff\udfffy"}', '{"a":"\ud83d\ude00\ud800"}', "{\"a\":\"\\ud83d\u{1f600}\"}",
  "{\"a\":\"\u{1f600}\"}", '{"a":"\u00e9\u0000"}', '"\ud800"', '["ok","\ud800"]', '[1,"\udc00",2]',
  # Keys.
  '{"\ud800":1}', '{"\udc00":1}', '{"\ud83d\ude00":1}', '{"a\ud800b":{}}',
  # An escaped backslash before a u is no escape.
  '{"a":"\\\\ud800"}', '{"a":"\\\\\ud800"}', '{"a":"\\\\\\\\ud800"}', '{"\\\\ud800":"\\\\udc00"}',
  # A later duplicate key replaces the token JSON.parse in JavaScript keeps.
  '{"a":"\ud800","a":"ok"}', '{"a":"ok","a":"\ud800"}', '{"\ud800":1,"\ud800":2}', '{"a":{"b":"\ud800"},"a":{}}',
  '{"a":["\ud800"],"a":[]}', '{"x":{"k":"\udc00","k":"ok"}}', '{"a":"\ud800\udc00","a":"\udc00"}',
  '{"a":"\udc00","a":"ok"}'
].freeze

cases = TEXTS.map do |text|
  JSON.parse(text)
  { text: text, parses: true }
rescue JSON::ParserError => e
  { text: text, parses: false, error: e.message.split(' at ').first }
end

puts JSON.pretty_generate({ json: JSON::VERSION, ruby: RUBY_VERSION, cases: cases })
