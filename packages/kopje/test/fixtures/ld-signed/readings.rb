# frozen_string_literal: true

# Mastodon's reading of each body proof-shapes.mjs, edge-shapes.mjs or sensitive-shapes.mjs writes, as compact.rb reads
# a body (ActivityPub::ProcessActivityService#call in v4.7.5: check_jsonld_limits!, compact under full_context,
# check_jsonld_limits! again, patch_for_forwarding!), with Mastodon's own JsonLdHelper, context_helper.rb and JSON-LD
# preloads, outside Rails: each context Mastodon would fetch is served from the copy the input carries (Fedify's
# preloaded one), so it runs with no network. Writes { reference, readings }, one letter per body in order: `c`
# compacted, `k` compacted and then refused by the limits (a @graph the compaction wrote: a proof kept something), `r`
# refused by JSON::LD (Mastodon reads both of those as received, without the signature), `e` any other error (its job
# raises, and applies nothing). With `sensitive`, also { sensitive }, one letter per body: `t` where the status Mastodon
# creates from the object it reads is sensitive (Create#process_status, create.rb:115: the object's `sensitive` or
# false, as its boolean column casts it), `f` where not. Run as each generator says.

require 'bundler/setup'
require 'json'
require 'json/ld'
require 'json/ld/preloaded'
require 'active_model'
require 'active_support/all'
Dir['/opt/mastodon/config/initializers/json_ld_*.rb'].sort.each { |file| load file }
module Mastodon
  class Error < StandardError; end
  class InvalidJsonLdError < Error; end
end
module ActivityPub
  class TagManager
    CONTEXT = 'https://www.w3.org/ns/activitystreams'
  end
end
load '/opt/mastodon/lib/mastodon/version.rb'
load '/opt/mastodon/app/helpers/context_helper.rb'
load '/opt/mastodon/app/helpers/json_ld_helper.rb'

input = JSON.parse(File.read(ARGV[0]))
CONTEXTS = input['contexts']

class Reader
  include JsonLdHelper

  def load_jsonld_context(url, _options = {})
    raise JSON::LD::JsonLdError::LoadingDocumentFailed, "not carried: #{url}" unless CONTEXTS.key?(url)

    document = JSON::LD::API::RemoteDocument.new(JSON.generate(CONTEXTS[url]), documentUrl: url)
    block_given? ? yield(document) : document
  end

  # The reading's letter and the body Mastodon reads.
  def reading(received)
    check_jsonld_limits!(received)
    json = compact(received)
    check_jsonld_limits!(json)
    patch_for_forwarding!(received, json) if json['signature'].present?
    ['c', json]
  rescue Mastodon::InvalidJsonLdError
    ['k', received.without('signature')]
  rescue JSON::LD::JsonLdError
    ['r', received.without('signature')]
  rescue StandardError
    ['e', nil]
  end
end

reader = Reader.new
readings = input['bodies'].map { |body| reader.reading(body) }
output = { reference: "mastodon-#{Mastodon::Version.to_a.join('.')}", readings: readings.map(&:first).join }
if ARGV[1] == 'sensitive'
  boolean = ActiveModel::Type::Boolean.new
  output[:sensitive] = readings.map do |_, json|
    object = json && json['object']
    object.is_a?(Hash) && boolean.cast(object['sensitive'] || false) ? 't' : 'f'
  end.join
end
puts JSON.generate(output)
