# frozen_string_literal: true

# Mastodon's reading of each received body (ActivityPub::ProcessActivityService#call, process_activity_service.rb:23-38
# in v4.7.5): when its signature is an object, check_jsonld_limits!, compact under full_context, check_jsonld_limits!
# again; Mastodon::InvalidJsonLdError or JSON::LD::JsonLdError reads the body as received without signature. Run inside
# the reference release's web container, with the entries capture.rb, fedify.mjs or forms.mjs wrote:
#
#   docker compose exec -T web bin/rails runner "$(cat compact.rb)" < entries.json > read.json
#
# Each entry gains `reference` (the release that read it) and `mastodon` (its compaction), or `fallback` (the error)
# when Mastodon read it as received without its signature. Any other error is recorded as `error`, with no reading:
# Mastodon's job raises then, and Sidekiq retries it. corpus.json is this over capture.rb's output from each release and
# fedify.mjs's; forms.json over forms.mjs's. Writes nothing but the context cache Mastodon keeps itself.

include JsonLdHelper

entries = JSON.parse($stdin.read)
entries.each do |entry|
  json = entry['received']
  entry['reference'] = "mastodon-#{Mastodon::Version}"
  begin
    if json['signature'].is_a?(Hash)
      check_jsonld_limits!(json)
      json = compact(json)
    end
    check_jsonld_limits!(json)
    entry['mastodon'] = json
  rescue Mastodon::InvalidJsonLdError, JSON::LD::JsonLdError => e
    entry['fallback'] = "#{e.class}: #{e.message}"
  rescue StandardError => e
    entry['error'] = "#{e.class}: #{e.message}"
  end
end
puts JSON.pretty_generate(entries)
