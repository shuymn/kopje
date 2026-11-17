# frozen_string_literal: true

# compact.rb run outside Rails, with no network, in the reference release's image: Mastodon's own JsonLdHelper and
# context_helper.rb, the json-ld gem and the contexts the release preloads (config/initializers/json_ld_*.rb and
# json/ld/preloaded), and a context cache that refuses every other URL instead of fetching it. Around it: Mastodon's
# JSON-LD error classes, and a configuration that gives Mastodon::Version no prerelease or build metadata. A body that
# names only preloaded contexts reads as compact.rb reads it in a running web container; one naming another fails
# with LoadingDocumentFailed. From packages/kopje:
#
#   node test/fixtures/ld-signed/forms.mjs > forms-in.json
#   docker run --rm --network none -i -v "$PWD/test/fixtures/ld-signed:/f:ro" --entrypoint bundle \
#     ghcr.io/mastodon/mastodon:v4.7.5 exec ruby /f/compact-offline.rb /f/compact.rb < forms-in.json > read.json

require 'bundler/setup'
require 'json'
require 'json/ld'
require 'json/ld/preloaded'
require 'active_support/all'
require 'addressable/uri'
Dir['/opt/mastodon/config/initializers/json_ld_*.rb'].sort.each { |file| load file }
module Mastodon
  class Error < StandardError; end
  class InvalidJsonLdError < Error; end
end
module Rails
  class Cache
    def fetch(key, **) = raise(JSON::LD::JsonLdError::LoadingDocumentFailed, "not preloaded: #{key}")
  end

  def self.cache = Cache.new
  def self.configuration = Struct.new(:x).new(Struct.new(:mastodon).new(Struct.new(:version, :source).new({}, {})))
end
load '/opt/mastodon/lib/mastodon/version.rb'
load '/opt/mastodon/app/helpers/context_helper.rb'
load '/opt/mastodon/app/helpers/json_ld_helper.rb'
load ARGV.fetch(0)
