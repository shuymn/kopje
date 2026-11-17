# frozen_string_literal: true

# Mastodon's untrusted counts of a remote status, for untrusted-counts.json (test/untrusted-counts.test.ts, UC1): each
# `likes` value as JSON text, parsed as Mastodon parses an inbound or fetched body (JSON.parse), read by
# StatusParser#favourites_count (status_parser.rb:118-120) and assigned as update_counts! assigns it
# (process_status_update_service.rb:393-405, create.rb:206-216): only when not nil, to the bigint column
# (ActiveModel::Type::BigInteger), clamped before validation (StatusStat#clamp_untrusted_counts). `assigned` is whether
# the stored count changes at all, `stored` what it holds then. The parser's and the clamp's methods are read from the
# image's own sources. Run without a database, in a container of Mastodon's image, without network:
#
#   docker run --rm -i --network none --entrypoint bundle ghcr.io/mastodon/mastodon:v4.7.5 exec ruby - \
#     < untrusted-counts.rb > untrusted-counts.json

require 'json'
require 'active_model'

APP = '/opt/mastodon/app'

def method_source(path, name)
  File.read(path)[/^  def #{name}\n.*?^  end\n/m] or raise "#{name} not in #{path}"
end

class Parser
  def initialize(object)
    @object = object
  end

  class_eval(method_source("#{APP}/lib/activitypub/parser/status_parser.rb", 'favourites_count'))
end

class Stat
  include ActiveModel::Model
  include ActiveModel::Attributes
  include ActiveModel::Validations::Callbacks

  MAX_UNTRUSTED_COUNT = Integer(File.read("#{APP}/models/status_stat.rb")[/MAX_UNTRUSTED_COUNT = ([\d_]+)/, 1])

  attribute :untrusted_favourites_count, :big_integer
  attribute :untrusted_reblogs_count, :big_integer
  before_validation :clamp_untrusted_counts

  class_eval(method_source("#{APP}/models/status_stat.rb", 'clamp_untrusted_counts'))
end

LIKES = [
  # Not an object, or an object without a count: nothing assigned.
  nil, 'null', '"https://remote.test/likes"', '42', 'true', '[]', '[{"totalItems":3}]', '{}', '{"type":"Collection"}',
  '{"totalItems":null}',
  # Strings: blank is nil, anything else String#to_i.
  '{"totalItems":""}', '{"totalItems":" "}', '{"totalItems":"\\u00a0"}', '{"totalItems":"\\u3000"}',
  '{"totalItems":"\\u0085"}', '{"totalItems":"\\ufeff"}', '{"totalItems":"12"}', '{"totalItems":" 12"}',
  '{"totalItems":"\\t12"}', '{"totalItems":"+5"}', '{"totalItems":"-5"}', '{"totalItems":"12abc"}',
  '{"totalItems":"1e3"}', '{"totalItems":"3.9"}', '{"totalItems":"0x1A"}', '{"totalItems":"0d12"}',
  '{"totalItems":"1_000"}', '{"totalItems":"1__0"}', '{"totalItems":"\\uff11\\uff12"}', '{"totalItems":"\\u00a05"}',
  '{"totalItems":"abc"}', '{"totalItems":"\\u0000"}', '{"totalItems":"1\\u00002"}', '{"totalItems":"-0"}',
  '{"totalItems":"100000000"}', '{"totalItems":"100000001"}',
  '{"totalItems":"99999999999999999999999"}', '{"totalItems":"-99999999999999999999999"}',
  # Numbers: to_i toward zero, then the clamp; a non-finite Float casts to nil.
  '{"totalItems":0}', '{"totalItems":1}', '{"totalItems":42}', '{"totalItems":-1}', '{"totalItems":1.9}',
  '{"totalItems":-1.9}', '{"totalItems":0.5}', '{"totalItems":-0.0}', '{"totalItems":-0}', '{"totalItems":1E2}',
  '{"totalItems":1.5e2}', '{"totalItems":100000000}', '{"totalItems":100000000.9}', '{"totalItems":100000001}',
  '{"totalItems":99999999.9999999999}', '{"totalItems":1e30}', '{"totalItems":-1e30}', '{"totalItems":1e400}',
  '{"totalItems":-1e400}', '{"totalItems":1e-400}', '{"totalItems":9007199254740993}',
  '{"totalItems":12345678901234567890}', '{"totalItems":-9223372036854775809}',
  # Booleans, arrays and objects.
  '{"totalItems":true}', '{"totalItems":false}', '{"totalItems":[]}', '{"totalItems":[3]}', '{"totalItems":["3"]}',
  '{"totalItems":{}}', '{"totalItems":{"a":1}}',
  # A later duplicate key wins, as in any JSON object.
  '{"totalItems":5,"totalItems":7}'
].freeze

KEPT = 42

rows = LIKES.map do |likes|
  object = JSON.parse(likes.nil? ? '{}' : "{\"likes\":#{likes}}")
  count = Parser.new(object).favourites_count
  stat = Stat.new(untrusted_favourites_count: KEPT)
  stat.untrusted_favourites_count = count unless count.nil?
  stat.valid?
  { likes: likes, assigned: !count.nil?, stored: stat.untrusted_favourites_count }
end

puts JSON.pretty_generate({ ruby: RUBY_VERSION, activemodel: ActiveModel.version.to_s, json: JSON::VERSION,
                            max: Stat::MAX_UNTRUSTED_COUNT, kept: KEPT, rows: rows })
