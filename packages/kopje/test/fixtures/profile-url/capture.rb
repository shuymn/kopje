# frozen_string_literal: true

# Mastodon's profile URL of a remote account, for urls.json (remote-actor-url.test.ts). For each actor `url` member
# and actor id: what ProcessAccountService#url (process_account_service.rb:454-465) answers, through
# JsonLdHelper#url_to_href (json_ld_helper.rb:46-61), #unsupported_uri_scheme? (:95-97) and
# ProcessAccountService#mismatching_origin? (process_account_service.rb:475-480), each read from the image's own source
# and run as written; `raises` names the exception it raises instead, which fails the actor's processing (Mastodon
# stores `url || @uri`, :228, only when it returns). `listed` is Kopje's documented difference for the row
# (docs/mastodon-deviations.md), passed through as written here. Run in a container of Mastodon's image, without
# network:
#
#   docker run --rm -i --network none --entrypoint bundle ghcr.io/mastodon/mastodon:v4.7.5 exec ruby - \
#     < capture.rb > urls.json

require 'active_support/core_ext/object/blank'
require 'addressable/uri'
require 'json'

HELPER = 'app/helpers/json_ld_helper.rb'
SERVICE = 'app/services/activitypub/process_account_service.rb'

# The method `name` as `path` defines it, at two spaces of indentation.
def method_source(path, name)
  File.read(path)[/^  def #{Regexp.escape(name)}(?=[\s(]).*?^  end\n/m] or raise "#{name} is not in #{path}"
end

class Probe
  [[HELPER, 'url_to_href'], [HELPER, 'unsupported_uri_scheme?'], [SERVICE, 'url'],
   [SERVICE, 'mismatching_origin?']].each do |path, name|
    class_eval(method_source(path, name), path)
  end

  def initialize(json, uri)
    @json = json
    @uri = uri
  end
end

A = 'https://actor.example/users/a'
P = 'https://actor.example/@a'
O = 'https://other.example/@a'
HTML = { 'type' => 'Link', 'mimeType' => 'text/html', 'href' => P }.freeze
HTML_OTHER = { 'type' => 'Link', 'mimeType' => 'text/html', 'href' => O }.freeze
PNG = { 'type' => 'Link', 'mimeType' => 'image/png', 'href' => 'https://actor.example/a.png' }.freeze
PNG_OTHER = { 'type' => 'Link', 'mimeType' => 'image/png', 'href' => 'https://other.example/a.png' }.freeze
LONG = "https://actor.example/#{'x' * 2026}"
LONGER = "https://actor.example/#{'x' * 2027}"

# [url member, actor id, Kopje's listed difference or nil]
ROWS = [
  # Blank: none.
  [nil, A, nil],
  [false, A, nil],
  ['', A, nil],
  [" \t", A, nil],
  ["\u0085", A, nil],
  [[], A, nil],
  [{}, A, nil],
  # A string: on the actor id's host, whatever the scheme, port, ASCII case or userinfo.
  [P, A, nil],
  ['http://actor.example/@a', A, nil],
  ['https://actor.example:8443/@a', A, nil],
  ['https://ACTOR.Example/@a', A, nil],
  [P, 'https://ACTOR.example/users/a', nil],
  [P, 'http://actor.example:8080/users/a', nil],
  ['https://user:pass@actor.example/@a', A, nil],
  ['https://actor.example', A, nil],
  ['https://actor.example/@a b', A, nil],
  ['https://actor.example/@a#about', A, nil],
  [LONG, A, nil],
  # Another host, a trailing dot, a subdomain, an IP literal: none.
  [O, A, nil],
  ['https://actor.example./@a', A, nil],
  [P, 'https://actor.example./users/a', nil],
  ['https://sub.actor.example/@a', A, nil],
  ['https://[::1]/@a', A, nil],
  ['https:///@a', A, nil],
  # Not a literal http(s):// prefix: none.
  ['HTTPS://actor.example/@a', A, nil],
  ['Https://actor.example/@a', A, nil],
  [" #{P}", A, nil],
  ['/@a', A, nil],
  ['@a', A, nil],
  ['not a url', A, nil],
  ['mailto:a@actor.example', A, nil],
  ['ftp://actor.example/@a', A, nil],
  ['https:/actor.example/@a', A, nil],
  ['javascript://actor.example/%0Aalert(1)', A, nil],
  # Host spellings the URL parser reads otherwise than Addressable's host.
  ['https://%61ctor.example/@a', A, 'host'],
  ['https://bücher.example/@a', 'https://xn--bcher-kva.example/users/a', 'host'],
  ['https://xn--bcher-kva.example/@a', 'https://bücher.example/users/a', 'host'],
  ['https://BÜCHER.example/@a', 'https://bücher.example/users/a', 'host'],
  ['https://bücher.example/@a', 'https://bücher.example/users/a', nil],
  ["https://act\tor.example/@a", A, 'raises'],
  ['https://actor.example:99999/@a', A, 'unparsed'],
  ['https://actor.example:x/@a', A, 'raises'],
  # Past PROFILE_URL_LIMIT serialized.
  [LONGER, A, 'bound'],
  # A Link: its href, when its mimeType is blank or exactly text/html; mediaType is not read.
  [HTML, A, nil],
  [{ 'href' => P }, A, nil],
  [{ 'type' => 'Link', 'href' => P }, A, nil],
  [{ 'type' => 'Link', 'href' => P, 'nameMap' => { 'en' => 5 } }, A, nil],
  [{ 'type' => 'Link', 'href' => P, 'mimeType' => '' }, A, nil],
  [{ 'type' => 'Link', 'href' => P, 'mimeType' => ' ' }, A, nil],
  [{ 'type' => 'Link', 'href' => P, 'mimeType' => [] }, A, nil],
  [{ 'type' => 'Link', 'href' => P, 'mimeType' => false }, A, nil],
  [{ 'type' => 'Link', 'href' => P, 'mimeType' => nil }, A, nil],
  [{ 'type' => 'Link', 'href' => P, 'mimeType' => 'image/png' }, A, nil],
  [{ 'type' => 'Link', 'href' => P, 'mimeType' => 'TEXT/HTML' }, A, nil],
  [{ 'type' => 'Link', 'href' => P, 'mimeType' => 'text/html; charset=utf-8' }, A, nil],
  [{ 'type' => 'Link', 'href' => P, 'mimeType' => 5 }, A, nil],
  [{ 'type' => 'Link', 'href' => P, 'mimeType' => ['text/html'] }, A, nil],
  [{ 'type' => 'Link', 'href' => P, 'mediaType' => 'image/png' }, A, nil],
  [{ 'type' => 'Link', 'href' => P, 'mediaType' => 'text/html', 'mimeType' => 'image/png' }, A, nil],
  [HTML_OTHER, A, nil],
  [{ 'type' => 'Link' }, A, nil],
  [{ 'type' => 'Link', 'href' => nil }, A, nil],
  [{ 'type' => 'Link', 'href' => '/@a' }, A, nil],
  [{ 'type' => 'Link', 'href' => 5 }, A, 'raises'],
  [{ 'type' => 'Link', 'href' => [P] }, A, 'raises'],
  [{ 'type' => 'Link', 'href' => { 'href' => P } }, A, 'raises'],
  [{ 'type' => 'Link', 'href' => true }, A, 'raises'],
  # An array whose first value is a string: that string alone.
  [[P], A, nil],
  [[P, 'https://actor.example/@b'], A, nil],
  [[O, HTML], A, nil],
  [['/@a', HTML], A, nil],
  [[P, nil], A, nil],
  # Any other array: the first Link whose mimeType is blank or text/html, a later string read as one without a
  # mimeType unless it holds the text `mimeType`; never a later candidate once one is chosen.
  [[HTML], A, nil],
  [[HTML_OTHER, HTML], A, nil],
  [[PNG_OTHER, HTML], A, nil],
  [[PNG, HTML_OTHER], A, nil],
  [[PNG, PNG_OTHER], A, nil],
  [[PNG, P], A, nil],
  [[PNG, O, HTML], A, nil],
  [[PNG, 'https://actor.example/mimeType', HTML], A, nil],
  [[PNG, 'https://actor.example/mimeType'], A, nil],
  [[{}, HTML], A, nil],
  [[HTML, nil], A, nil],
  [[HTML, 5], A, nil],
  [[PNG, nil, HTML], A, 'raises'],
  [[PNG, 5, HTML], A, 'raises'],
  [[PNG, [HTML], HTML], A, 'raises'],
  [[PNG, true, HTML], A, 'raises'],
  [[nil, P], A, 'raises'],
  [[5], A, 'raises'],
  [[[P]], A, 'raises'],
  # Another scalar.
  [5, A, 'raises'],
  [0.5, A, 'raises'],
  [true, A, 'raises'],
].freeze

rows = ROWS.map do |value, uri, listed|
  mastodon = begin
    { 'url' => Probe.new({ 'url' => value }, uri).url }
  rescue StandardError => e
    { 'raises' => e.class.name }
  end
  { 'value' => value, 'uri' => uri, 'listed' => listed, 'mastodon' => mastodon }
end

puts JSON.pretty_generate({ 'ruby' => RUBY_VERSION, 'addressable' => Addressable::VERSION::STRING, 'rows' => rows })
