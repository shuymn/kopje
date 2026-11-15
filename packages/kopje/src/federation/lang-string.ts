import { railsBlank } from "../platform/rails-blank";
import { rubyStrip } from "../platform/strip";
import { isObject } from "./json-shapes";

// A natural-language property that may come as an xsd:string or an rdf:langString, in any compacted form, read as
// Mastodon reads a remote attachment's description (MediaAttachmentParser#description,
// app/lib/activitypub/parser/media_attachment_parser.rb:31-35, v4.7.5, `mastodon#39590`): selection, then presence,
// then strip. A status's content, content warning and a converted title are read otherwise (StatusParser: `present?`,
// then the map; remote-status.ts languageString).

type Json = Record<string, unknown>;

// JsonLdHelper#first_lang_string (app/helpers/json_ld_helper.rb:25-34): when object[key] is truthy in Ruby (anything
// but absent, null and false, so "", 0 and [] included), its first element if it is an array, returned if a string,
// its @value if an object, without reading the map; otherwise the first value of `${key}Map`. A value that is not a
// string where Mastodon would go on to raise (a numeric @value or map value) reads as null.
export function firstLangString(object: Json, key: string): string | null {
  const value = object[key];
  if (value !== undefined && value !== null && value !== false) {
    const first: unknown = Array.isArray(value) ? value[0] : value;
    if (typeof first === "string") {
      return first;
    }
    return isObject(first) && typeof first["@value"] === "string" ? first["@value"] : null;
  }
  const map = object[`${key}Map`];
  const entry: unknown = isObject(map) ? Object.values(map)[0] : undefined;
  return typeof entry === "string" ? entry : null;
}

// The summary's first_lang_string when present (Rails' presence: railsBlank), else the name's, stripped as Ruby
// strips, else ''. The caller cuts it to its stored bound.
export function remoteDescription(object: Json): string {
  for (const key of ["summary", "name"]) {
    const value = firstLangString(object, key);
    if (value !== null && !railsBlank(value)) {
      return rubyStrip(value);
    }
  }
  return "";
}
