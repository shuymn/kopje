# Writes context-maps.json: the inline definitions each Mastodon release from 3.5.0 to 4.3.x can write, from its own
# app/helpers/context_helper.rb (CONTEXT_EXTENSION_MAP, which every serializer's context_extensions names a part of),
# releases with the same definitions grouped. Usage, from a Mastodon checkout with its tags:
#   ruby context-maps.rb > context-maps.json
require 'json'

tags = `git tag -l 'v3.5.*' 'v4.0.*' 'v4.1.*' 'v4.2.*' 'v4.3.*'`.split.grep_v(/rc|beta|alpha/)
tags = tags.sort_by { |tag| Gem::Version.new(tag.delete_prefix('v')) }
groups = []
tags.each do |tag|
  source = `git show #{tag}:app/helpers/context_helper.rb`
  holder = Module.new
  holder.module_eval(source[/^\s*CONTEXT_EXTENSION_MAP = \{.*?^\s*\}\.freeze/m])
  definitions = {}
  holder.const_get(:CONTEXT_EXTENSION_MAP).each_value do |extension|
    extension.each { |name, definition| (definitions[name] ||= []) << definition unless definitions[name]&.include?(definition) }
  end
  if groups.last && groups.last[:definitions] == definitions
    groups.last[:releases][1] = tag
  else
    groups << { releases: [tag, tag], definitions: definitions }
  end
end
puts JSON.pretty_generate(groups)
