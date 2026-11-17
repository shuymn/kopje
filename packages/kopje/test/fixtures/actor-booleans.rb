# frozen_string_literal: true

# Mastodon's reading of a remote actor's manuallyApprovesFollowers, discoverable and indexable, for actor-booleans.json
# (remote-actor-booleans.test.ts). ProcessAccountService#set_immediate_attributes! assigns each member's
# `@json[name] || false` to accounts.locked, discoverable and indexable (process_account_service.rb:252-256), which
# ActiveModel::Type::Boolean casts. Each assignment's right-hand side is read from the image's own source and evaluated
# as written, and each column's NOT NULL from its db/schema.rb: a NOT NULL column refuses the nil the cast gives, and
# the account is not saved. For each value, given as its JSON text (absent: null) so that JSON.parse keeps a float a
# Float, `rails` is the value cast. `listed` is Kopje's value where it differs (docs/mastodon-deviations.md: a float
# zero, which JavaScript's JSON.parse reads as the integer 0), passed through as written here, else null. Run without a
# database, in a container of Mastodon's image, without network:
#
#   docker run --rm -i --network none --entrypoint bundle ghcr.io/mastodon/mastodon:v4.7.5 exec ruby - \
#     < actor-booleans.rb > actor-booleans.json

require 'active_model'
require 'json'

SERVICE = 'app/services/activitypub/process_account_service.rb'
SCHEMA = 'db/schema.rb'
COLUMNS = { 'locked' => 'manuallyApprovesFollowers', 'discoverable' => 'discoverable', 'indexable' => 'indexable' }.freeze

source = File.read(SERVICE)
accounts = File.read(SCHEMA)[/^  create_table "accounts".*?^  end$/m] or raise 'no accounts table'
columns = COLUMNS.map do |column, member|
  assigned = source[/^\s*@account\.#{column}\s*=\s*(.+)$/, 1] or raise "#{column} is not assigned in #{SERVICE}"
  raise "#{column} reads #{assigned}" unless assigned.include?("@json['#{member}']")

  definition = accounts[/^\s*t\.boolean "#{column}"(.*)$/, 1] or raise "#{column} is not a boolean in #{SCHEMA}"
  { column: column, member: member, assigned: assigned.strip, null: !definition.include?('null: false') }
end

# Evaluates `assigned` with @json as the document holds the member.
class Assignment
  def initialize(json)
    @json = json
  end

  def value(assigned)
    instance_eval(assigned)
  end
end

CAST = ActiveModel::Type::Boolean.new

# Kopje's value for a float zero (listed).
LISTED = { '0.0' => false, '-0.0' => false, '0e0' => false, '0.00' => false, '0E+2' => false }.freeze

VALUES = [
  # Cast to true.
  'true', '"true"', '"True"', '"TRUE"', '"t"', '"T"', '"1"', '1', '2', '-1', '0.5', '1.0', '1e0', '"yes"', '"no"',
  '"on"', '"On"', '"y"', '"n"', '"False"', '"fALSE"', '"Off"', '"oFF"', '" "', '"\t"', '" false"', '"false "', '"0 "',
  '" 0"', '"0.0"', '"00"', '"null"', '"nil"', '"０"', '"\u0000"', '[]', '[false]', '[true]', '[0]', '{}',
  '{"@value":false}', '{"@value":"false"}',
  # Cast to false.
  'false', '"false"', '"FALSE"', '"0"', '0', '-0', '"f"', '"F"', '"off"', '"OFF"',
  # Nil, which `|| false` makes false; absent.
  'null', nil,
  # Cast to nil.
  '""',
  # A float zero.
  *LISTED.keys,
].freeze

rows = VALUES.map do |text|
  casts = columns.map do |column|
    json = text.nil? ? {} : { column[:member] => JSON.parse(text) }
    CAST.cast(Assignment.new(json).value(column[:assigned]))
  end
  raise "the columns cast #{text} apart: #{casts}" unless casts.uniq.length == 1

  { json: text, rails: casts.first, listed: LISTED.fetch(text, nil) }
end

puts JSON.pretty_generate(
  {
    activemodel: ActiveModel.version.to_s,
    ruby: RUBY_VERSION,
    columns: columns.map { |c| c.slice(:column, :member, :null) },
    rows: rows,
  }
)
