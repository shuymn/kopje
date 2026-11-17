# frozen_string_literal: true

# What Mastodon does with each retraction retractions.mjs writes, sent by its signer: its own
# ActivityPub::ProcessActivityService#call (process_activity_service.rb: check_jsonld_limits!, the compaction under
# full_context, the fallback to the body as received, different_actor?, patch_for_forwarding!) run as it is, outside
# Rails, with JsonLdHelper, context_helper.rb, ActivityPub::Activity and Mastodon's JSON-LD preloads, and each context
# it would fetch served from the copy the input carries (Fedify's preloaded one), so it runs with no network. Stubbed
# around it: the signer's account (a remote one, not suspended), the Linked Data signature's verification (a
# placeholder never verifies; it records that the relay reached it), the logger (production's, which evaluates no debug
# block) and Activity.factory, which records the activity it is handed instead of performing it. Writes
# { reference, readings }, one per entry in order: { name, reading } where the factory was reached, reading being what
# the activity's handler reads (its type, ActivityPub::Activity#object_uri, and of an embedded object its type and the
# ids of its actor and object, as value_or_id reads them), or { name, error } where the service or one of those reads
# raised (the job then applies nothing), or { name, relayed: true } where it judged the body relayed, or { name } where
# it returned without one. Each also gains `inbox`, the error where Mastodon's inbox raises on the body as received
# before it queues the job (inboxes_controller.rb skip_unknown_actor_activity: its own unknown_affected_account?, read
# from the controller's source, with the account lookup that follows the read stubbed), so that the request answers 500
# and nothing is applied whatever the service reads. Run as retractions.mjs says.

require 'bundler/setup'
require 'json'
require 'json/ld'
require 'json/ld/preloaded'
require 'active_model'
require 'active_support/all'
require 'addressable/uri'
Dir['/opt/mastodon/config/initializers/json_ld_*.rb'].sort.each { |file| load file }
module Mastodon
  class Error < StandardError; end
  class InvalidJsonLdError < Error; end
end
module Rails
  class Logger
    def debug(*) = nil
  end

  def self.logger = Logger.new
end
module ActivityPub
  class TagManager
    CONTEXT = 'https://www.w3.org/ns/activitystreams'
  end

  module OpenTelemetry
    def self.decorate_current_span(**) = nil
  end

  class LinkedDataSignature
    def initialize(_json) = nil

    def verify_actor!
      $relayed = true
      nil
    end
  end
end
class BaseService; end
module DomainControlHelper
  def domain_not_allowed?(_uri) = false
end
module Redisable; end
module Lockable; end
class Account
  attr_reader :uri

  def initialize(uri) = (@uri = uri)
  def suspended? = false
  def local? = false
  def self.exists?(**) = true
end
load '/opt/mastodon/lib/mastodon/version.rb'
load '/opt/mastodon/app/helpers/context_helper.rb'
load '/opt/mastodon/app/helpers/json_ld_helper.rb'
load '/opt/mastodon/app/lib/activitypub/activity.rb'
load '/opt/mastodon/app/services/activitypub/process_activity_service.rb'

input = JSON.parse(File.read(ARGV[0]))
CONTEXTS = input['contexts']

class ActivityPub::ProcessActivityService
  def load_jsonld_context(url, _options = {})
    raise JSON::LD::JsonLdError::LoadingDocumentFailed, "not carried: #{url}" unless CONTEXTS.key?(url)

    document = JSON::LD::API::RemoteDocument.new(JSON.generate(CONTEXTS[url]), documentUrl: url)
    block_given? ? yield(document) : document
  end
end

class ActivityPub::Activity
  def self.factory(json, account, **)
    $handed = new(json, account)
    nil
  end

  # What the handlers read (delete.rb, block.rb, undo.rb, reject.rb).
  def reading
    reading = { type: @json['type'], object: object_uri }
    return reading unless @object.is_a?(Hash)

    reading.merge(object_type: @object['type'], object_actor: value_or_id(@object['actor']),
                  object_object: value_or_id(@object['object']))
  end
end

# The request's check before the job: the controller's own method over the body it parses.
class InboxCheck
  include JsonLdHelper

  CONTROLLER = File.read('/opt/mastodon/app/controllers/activitypub/inboxes_controller.rb')
  class_eval(CONTROLLER[/^  def unknown_affected_account\?\n.*?^  end\n/m] || raise('no unknown_affected_account?'))

  attr_reader :parsed_body

  def initialize(body) = (@parsed_body = JSON.parse(body))
end

readings = input['entries'].map do |entry|
  $handed = nil
  $relayed = false
  signer = Account.new(entry['signer'])
  result = { name: entry['name'] }
  begin
    ActivityPub::ProcessActivityService.new.call(JSON.generate(entry['body']), signer)
    result[:reading] = $handed.reading if $handed
  rescue StandardError => e
    result[:error] = "#{e.class}: #{e.message[0, 80]}"
  end
  result[:relayed] = true if $relayed
  begin
    InboxCheck.new(JSON.generate(entry['body'])).unknown_affected_account?
  rescue StandardError => e
    result[:inbox] = "#{e.class}: #{e.message[0, 80]}"
  end
  result
end
puts JSON.pretty_generate({ reference: "mastodon-#{Mastodon::Version.to_a.join('.')}", readings: readings })
