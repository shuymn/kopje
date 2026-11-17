# frozen_string_literal: true

# Mastodon's reading of an actor's shared inbox, for spellings.json (remote-actor-images.test.ts, "reads the shared
# inbox as Mastodon"). For each spelling: whether Mastodon stores it (ProcessAccountService#valid_collection_uri,
# process_account_service.rb:235-245), the string it stores (Addressable's parse, written back), and the URL its
# Request POSTs to for that stored string (Request#initialize, request.rb:97, through
# normalize_preserving_url_encodings, :212-236, copied below). `refused` is Kopje's decision for the row (none: the
# personal inbox is used), passed through as written here. Run with the Addressable that Mastodon's Gemfile.lock pins,
# in a container of its image, without network:
#
#   docker run --rm -i --network none --entrypoint bundle ghcr.io/mastodon/mastodon:v4.7.5 exec ruby - \
#     < capture.rb > spellings.json

require 'active_support/core_ext/object/blank'
require 'addressable/uri'
require 'json'

VALID_URI_SCHEMES = %w(http https).freeze
SAFE_PRESERVED_CHARS = '+,'

def valid_collection_uri(uri)
  uri = uri.first if uri.is_a?(Array)
  uri = uri['id'] if uri.is_a?(Hash)
  return '' unless uri.is_a?(String)

  parsed_uri = Addressable::URI.parse(uri)

  VALID_URI_SCHEMES.include?(parsed_uri.scheme) && parsed_uri.host.present? ? parsed_uri : ''
rescue Addressable::URI::InvalidURIError
  ''
end

def normalize_preserving_url_encodings(url, preserved_chars = SAFE_PRESERVED_CHARS, *flags)
  original_uri = Addressable::URI.parse(url)
  normalized_uri = original_uri.normalize

  if original_uri.query
    modified_query_class = Addressable::URI::CharacterClasses::QUERY.dup
    modified_query_class.sub!('\\&', '').sub!('\\;', '')

    pairs = original_uri.query.split('&', -1)
    pairs.delete_if(&:empty?).uniq! if flags.include?(:compacted)
    pairs.sort! if flags.include?(:sorted)

    normalized_query = pairs.map do |pair|
      Addressable::URI.normalize_component(
        pair,
        modified_query_class,
        preserved_chars
      )
    end.join('&')

    normalized_uri.query = normalized_query == '' ? nil : normalized_query
  end

  normalized_uri
end

H ='https://peer.example'

# [spelling, refused by Kopje]
ROWS = [
  # Ports: 0 is the default port to Mastodon and :0 to the URL parser; past 65535 no connection is made.
  ["#{H}:0/inbox", true],
  ["#{H}:00/inbox", true],
  ["#{H}:65536/inbox", true],
  ["#{H}:99999/inbox", true],
  ["#{H}:8443/inbox", false],
  ["#{H}:080/inbox", false],
  ["#{H}:443/inbox", false],
  ["#{H}:0443/inbox", false],
  ["#{H}:08443/inbox", false],
  ["#{H}:/inbox", false],
  ['http://peer.example:80/inbox', false],
  ['http://peer.example/inbox', false],
  # Hosts.
  ['https://peer.example./inbox', true],
  ['https://peer..example/inbox', true],
  ['https://.peer.example/inbox', true],
  ['https://0x7f.1/inbox', true],
  ['https://peer.123/inbox', true],
  ['https://127.0.0.1/inbox', true],
  ['https://[::1]/inbox', true],
  ['https://xn--zz.example/inbox', false],
  ['https://peer_x.example/inbox', true],
  ['https://pèer.example/inbox', true],
  ['https://user@peer.example/inbox', true],
  ['https://user:pass@peer.example/inbox', true],
  ['https:///inbox', true],
  ['https://PEER.Example/inbox', false],
  ['https://-peer-.example/inbox', false],
  ['https://XN--Bcher-kva.example/inbox', false],
  ['https://peer.x1/inbox', false],
  # Schemes.
  ['HTTPS://peer.example/inbox', true],
  ['Https://peer.example/inbox', true],
  ['ftp://peer.example/inbox', true],
  ['https:/peer.example/inbox', true],
  ['https:peer.example/inbox', true],
  ['/inbox', true],
  [' https://peer.example/inbox', true],
  # Paths: characters outside RFC 3986's pchar.
  ["#{H}/in\\box", true],
  ["#{H}/in\tbox", true],
  ["#{H}/in\rbox", true],
  ["#{H}/in\nbox", true],
  ["#{H}/in box", true],
  ["#{H}/in|box", true],
  ["#{H}/in[box", true],
  ["#{H}/in]box", true],
  ["#{H}/in\"box", true],
  ["#{H}/in{box", true],
  ["#{H}/in^box", true],
  ["#{H}/in`box", true],
  ["#{H}/in<box", true],
  ["#{H}/inbôx", true],
  # Paths: escapes that either side decodes, re-cases or re-encodes.
  ["#{H}/%7einbox", true],
  ["#{H}/%7Einbox", true],
  ["#{H}/%41inbox", true],
  ["#{H}/%40inbox", true],
  ["#{H}/%2Einbox", true],
  ["#{H}/a%2fb", true],
  ["#{H}/%c3%a9", true],
  ["#{H}/%C3%A9", true],
  ["#{H}/e%CC%81", true],
  ["#{H}/%zz", true],
  ["#{H}/%", true],
  ["#{H}/%4", true],
  # Paths: dot segments.
  ["#{H}/./inbox", true],
  ["#{H}/../inbox", true],
  ["#{H}/a/.", true],
  ["#{H}/a/..", true],
  ["#{H}/a/%2E%2E/b", true],
  # Queries and fragments.
  ["#{H}/inbox?", true],
  ["#{H}/inbox?x=1", true],
  ["#{H}/inbox?x=a'b", true],
  ["#{H}/inbox?a=;", true],
  ["#{H}/inbox?y=%3D", true],
  ["#{H}/inbox#f", true],
  ["#{H}/inbox#", true],
  # Paths both write alike.
  [H, false],
  ["#{H}/", false],
  ["#{H}//x", false],
  ["#{H}/inbox/", false],
  ["#{H}/inbox", false],
  ["#{H}/a.b/..c/c../.d", false],
  ["#{H}/a%2Fb", false],
  ["#{H}/a%20b", false],
  ["#{H}/a%25b", false],
  ["#{H}/a%5Cb", false],
  ["#{H}/a%7Cb", false],
  ["#{H}/a%00b", false],
  ["#{H}/a%7Fb", false],
  ["#{H}/!$&'()*+,;=", false],
  ["#{H}/a:b@c", false],
  ["#{H}/-._~", false],
].freeze

out = ROWS.map do |value, refused|
  stored = valid_collection_uri(value)
  stored = stored == '' ? nil : stored.to_s
  destination = nil
  error = nil
  begin
    destination = normalize_preserving_url_encodings(stored).to_s unless stored.nil?
  rescue StandardError => e
    error = e.class.name
  end
  { value: value, refused: refused, mastodon: { stored: stored, destination: destination, error: error }.compact }
end

puts JSON.pretty_generate({ addressable: Addressable::VERSION::STRING, ruby: RUBY_VERSION, rows: out })
