# frozen_string_literal: true

# Mastodon's reading of a remote actor's `published`, for rails-time.json (remote-actor-view.test.ts, "reads an
# actor's published as Rails casts it"). ProcessAccountService#set_immediate_protocol_attributes! assigns
# `@account.created_at = @json['published'] if @json['published'].present?` (process_account_service.rb:231), and
# ActiveRecord casts it for the column (accounts.created_at, a timestamp without precision) with its time-zone-aware
# converter over PostgreSQL's datetime type, Time.zone UTC (Mastodon sets no config.time_zone). For each string,
# `rails` is what is assigned: the instant as the PostgreSQL adapter writes it (ISO 8601, cut to microseconds), null
# when the cast is nil, "blank" when the value is not assigned, or "infinity" and "-infinity". `listed` marks a form
# only Rails reads (docs/mastodon-deviations.md), passed through as written here. A week or ordinal date is read
# against the day of the run. `crossing` holds every date around a month's or a year's end, a day past it included, at
# the times next to midnight, under each offset that moves it across a day (and none), as `[value, rails]`: Ruby's
# Time.new moves a day 31 of a shorter month that an offset carries into the next day to the month before (time.c
# vtm_add_day into struct vtm's 5-bit mday). Run without a database, in a container of Mastodon's image, without
# network:
#
#   docker run --rm -i --network none --entrypoint bundle ghcr.io/mastodon/mastodon:v4.7.5 exec ruby - \
#     < rails-time.rb > rails-time.json

require 'json'
require 'active_record'
require 'active_record/connection_adapters/postgresql_adapter'

Time.zone = 'UTC'
CAST = ActiveRecord::AttributeMethods::TimeZoneConversion::TimeZoneConverter.new(
  ActiveRecord::ConnectionAdapters::PostgreSQL::OID::DateTime.new
)

def assigned(value)
  return 'blank' unless value.present?

  time = CAST.cast(value)
  if time.nil?
    nil
  elsif time.is_a?(Float)
    time.positive? ? 'infinity' : '-infinity'
  else
    time.utc.iso8601(6)
  end
end

# The longest string Date._parse reads (its limit: 128 characters), and one past it, by a fraction or leading spaces.
FRACTION = '2020-01-05T10:00:00.'
LIMIT = [
  "#{FRACTION}#{'1' * (128 - FRACTION.length - 1)}Z",
  "#{' ' * 108}2020-01-05T10:00:00Z",
].freeze
PAST_LIMIT = [
  "#{FRACTION}#{'1' * (129 - FRACTION.length - 1)}Z",
  "#{' ' * 109}2020-01-05T10:00:00Z",
].freeze

READ = [
  '2020-01-05',
  '2020-01-05T10:00:00Z',
  '2020-01-05T10:00',
  '2020-01-05T10:00Z',
  '2020-01-05 10:00:00',
  '2020-01-05t10:00:00z',
  '2020-01-05t10:00Z',
  '2021-02-29',
  '2020-02-31',
  '2020-04-31T00:00:00Z',
  '2020-06-31',
  '1900-02-29',
  '2019-02-29T00:00:00Z',
  '2020-02-29T00:00:00Z',
  '2021-02-29T24:00:00Z',
  '2020-01-05T24:00:00Z',
  '2020-01-05T24:00Z',
  '2020-01-05 24:00',
  '2020-01-05T24:00:00.5Z',
  '2020-01-05T24:00:00.000Z',
  '2020-01-05T24:00:00+09:00',
  '2020-12-31T24:00:00-01:00',
  '2020-01-05T23:59:60Z',
  '2020-01-05T23:59:60.5Z',
  '2020-01-31T23:59:60+00:00',
  '2020-01-05T23:59:60-23:59',
  '9999-12-31T24:00:00Z',
  '9999-12-31T23:59:60Z',
  '0000-01-05',
  '0000-01-01T00:00:00+01:00',
  '0001-01-01T00:00:00Z',
  '0099-01-05',
  '1969-12-31T23:59:59.999Z',
  '2020-01-05T10:00:00,5Z',
  '2020-01-05T10:00:00.123456789Z',
  '2020-01-05T10:00:00.9999999Z',
  '2020-01-05T10:00:00+0900',
  '2020-01-05T10:00:00+09',
  '2020-01-05T10:00:00+09:00',
  '2020-01-05T10:00:00 +09:00',
  '2020-01-05T10:00:00  +09:00',
  '2020-01-05T10:00:00 Z',
  '2020-01-05T10:00:00 z',
  '2020-01-05T10:00:00+23:59',
  '2020-01-05T10:00:00-23:59',
  '2020-01-05T10:00:00+2359',
  '2020-01-05T00:00:00+00:01',
  '2020-01-05T00:00:00-00:30',
  '2020-01-05T10:00:00-00:00',
  '2020-01-05T10:00:00+00',
  '2020-01-05T10:00+09',
  ' 2020-01-05T10:00:00Z ',
  "\t\n\v\f\r2020-01-05T10:00:00Z\t\n\v\f\r",
  '  2020-01-05 10:00:00 +0900 ',
  *LIMIT,
].freeze

NONE = [
  '0',
  '5',
  '2020',
  'garbage',
  '',
  '   ',
  "　",
  '2020-02-32',
  '2020-02-32T10:00:00Z',
  '2020-13-01',
  '2020-13-01T10:00:00Z',
  '2020-00-01',
  '2020-01-00',
  '2020-01-05T24:00:01Z',
  '2020-01-05T24:01:00Z',
  '2020-01-05T24:00:60Z',
  '2020-01-05T25:00:00Z',
  '2020-01-05T23:60:00Z',
  '2020-01-05T23:59:61Z',
  '2020-01-05T10:00:00+2400',
  *PAST_LIMIT,
].freeze

LISTED = [
  '01/02/2020',
  'Jan 2 2020',
  'Thu, 02 Jan 2020 10:00:00 +0900',
  '20200105T100000Z',
  '2020-1-5',
  '2020-01-05T1:00:00Z',
  '2020-01-05T10:0:00Z',
  '+2020-01-05',
  '-2020-01-05',
  '12020-01-05',
  '2020-01-05 BC',
  '2020-01-05T10:00:00Z trailing',
  '2020-01-05 trailing',
  '2020-01-05T10:00:00ZZ',
  '2020-W02-1',
  '2020-005',
  '2020-01-05T10Z',
  'infinity',
  '-infinity',
  '2020-01-05T10:00:00+24:00',
  '2020-01-05T10:00:00+09:60',
  '2020-01-05T10:00:00+0960',
  '2020-01-05T10:00:00+9',
  '2020-01-05T10:00:00+090',
  '2020-01-05T10:00:00+09:',
  '2020-01-05T10:00:00+09:00:30',
  '2020-01-05T10:00:00UTC',
  '2020-01-05T10:00:00 JST',
  '2020-01-05T10:00:00GMT+9',
  '2020-01-05+09:00',
  '2020-01-05 +09:00',
  '2020-01-05Z',
  '2020-01-05T10:00:00.Z',
  '2020-01-05T10:00.5Z',
  '2020-01-05  10:00:00',
  "2020-01-05\t10:00:00",
  "2020-01-05T10:00:00\t+09:00",
  '2020-01-05T10 : 00 : 00Z',
  '2020-01-05 T10:00:00Z',
  " 2020-01-05T10:00:00Z",
  "2020-01-05　",
].freeze

rows = [[READ, false], [NONE, false], [LISTED, true]].flat_map do |values, listed|
  values.map { |value| { value: value, rails: assigned(value), listed: listed } }
end

DATES = %w[
  2019-02-28 2019-02-29 2019-02-30 2019-02-31 2020-02-29 2020-02-30 2020-02-31 2020-01-31 2020-03-01 2020-04-30
  2020-04-31 2020-06-31 2020-12-31 2021-01-01 0000-01-01 9999-12-31
].freeze
TIMES = %w[00:00:00 00:30:00 23:30:00 23:59:00 23:59:59 23:59:60 23:59:60.5 24:00:00].freeze
OFFSETS = ['', 'Z', '-23:59', '-12:00', '-01:00', '-00:30', '-00:01', '+00:01', '+00:30', '+01:00', '+12:00',
           '+23:59'].freeze
crossing = DATES.product(TIMES, OFFSETS).map do |date, time, offset|
  value = "#{date}T#{time}#{offset}"
  [value, assigned(value)]
end

# The rows pretty, each crossing pair on one line.
head = JSON.pretty_generate({ activerecord: ActiveRecord.version.to_s, ruby: RUBY_VERSION, rows: rows })
pairs = crossing.map { |pair| "    #{JSON.generate(pair)}" }.join(",\n")
puts "#{head.delete_suffix("\n}")},\n  \"crossing\": [\n#{pairs}\n  ]\n}"
