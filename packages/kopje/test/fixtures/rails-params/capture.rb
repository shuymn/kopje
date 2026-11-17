# frozen_string_literal: true

# Rack 3.2.8 and Rails 8.1.3.1 (Mastodon 4.7.5) on urlencoded bodies, for objects.jsonl (params-corpus.test.ts): each
# body as Rack::Attack reads it (Rack::Request#params) and as a controller does (ActionDispatch::Request
# #request_parameters, deep munge on), and of the controller's tree the objects of `a` as `params.permit(a: FIELDS)`
# gives them, which Mastodon's nested attributes read (`media_attributes`, `keywords_attributes`, `fields_attributes`).
# The bodies are every fragment alone and seeded combinations: arrays of objects with nested fields, fields named as
# a JavaScript object's properties, malformed brackets, non-object items, indexed objects, scalars and nil. One JSON
# value a line: FIELDS, then each body and its answer (the stage of a refusal, or the tree and the objects, a Hash as
# its pairs in order). Capture with the image, without network:
#
#   docker run --rm -i --network none -w /opt/mastodon --entrypoint bundle ghcr.io/mastodon/mastodon:v4.7.5 \
#     exec ruby - < capture.rb > objects.jsonl

require 'json'
require 'rack'
require 'action_controller'

FIELDS = %w[x y z w id constructor __proto__ toString hasOwnProperty valueOf].freeze

# Objects of an Array: `a[][field]`, where a field the last object holds starts the next.
SEQUENTIAL = [
  'a[][x]=1', 'a[][x]=2', 'a[][y]=3', 'a[][id]=4', 'a[][y][z]=5', 'a[][y][]=6', 'a[][z][][w]=7', 'a[][w][x]=8',
  'a[]=s', 'a[]', 'a[]=', 'a[][x]', 'a[][x]=', 'a[][y]=',
  'a[][constructor]=c', 'a[][__proto__]=p', 'a[][toString]=t', 'a[][hasOwnProperty]=h', 'a[][valueOf]=v',
  'a[][x=m', 'a[][x]]=m', 'a[][[x]]=m', 'a[][x]y=m', 'a[][]x=m', 'a[]x=m', 'a[][x][=m', 'a[][ x]=m', 'a[][]=m',
  'a[][]][x]=m', 'a[][x][]]=m', 'a[][y]z]=m', 'a[][[]=m', 'a[]]=m', 'a[][x][y=m'
].freeze

# Objects of a Hash: `a[index][field]`.
INDEXED = [
  'a[0][x]=1', 'a[1][x]=2', 'a[0][y]=3', 'a[1][id]=4', 'a[0][y][z]=5', 'a[1][y][]=6', 'a[2][x]', 'a[2]',
  'a[-1][x]=n', 'a[01][x]=z', 'a[10][x]=t', 'a[x][y]=q', 'a[x]=q', 'a[0]=s', 'a[id]=i',
  'a[0][constructor]=c', 'a[0][__proto__]=p', 'a[1][toString]=t', 'a[1][valueOf]=v',
  'a[0][x]]=m', 'a[0][[x]]=m', 'a[0]x=m', 'a[0][x=m', 'a[1][]=m', 'a[ 0][x]=m', 'a[0 ][x]=m', 'a[+1][x]=m'
].freeze

OTHER = ['b=1', 'a=1', 'a', 'a=', 'b[][x]=1', 'a[=1', 'a[x=1', '[a][][x]=1', 'a][][x]=1'].freeze

def encode(value)
  case value
  when Hash, ActionController::Parameters
    { 'hash' => value.each_pair.map { |key, item| [key, encode(item)] } }
  when Array
    value.map { |item| encode(item) }
  else
    value
  end
end

def env(body)
  Rack::MockRequest.env_for('/x', method: 'POST', input: body, 'CONTENT_TYPE' => 'application/x-www-form-urlencoded')
end

def answer(body)
  begin
    Rack::Request.new(env(body)).params
  rescue StandardError
    return 'request'
  end
  begin
    tree = ActionDispatch::Request.new(env(body)).request_parameters
  rescue StandardError
    return 'controller'
  end
  { 'tree' => encode(tree), 'objects' => encode(ActionController::Parameters.new(tree).permit(a: FIELDS)['a']) }
end

random = Random.new(1734)
draw = lambda do |family|
  Array.new(random.rand(2..6)) { family[random.rand(family.size)] }.join('&')
end
everything = SEQUENTIAL + INDEXED + OTHER
bodies = everything.dup
1400.times do
  roll = random.rand(10)
  bodies << if roll < 6
              draw.call(SEQUENTIAL + OTHER.take(2))
            elsif roll < 9
              draw.call(INDEXED + OTHER.take(2))
            else
              draw.call(everything)
            end
end

ActionController::Parameters.action_on_unpermitted_parameters = false
puts JSON.generate(FIELDS)
bodies.uniq.each { |body| puts JSON.generate([body, answer(body)]) }
