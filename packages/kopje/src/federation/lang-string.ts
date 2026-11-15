import { railsBlank } from "../platform/rails-blank";
import { isObject } from "./json-shapes";

// A natural-language property that may come as an xsd:string or an rdf:langString, in any compacted form, read as
// Mastodon reads a remote attachment's description (MediaAttachmentParser#description,
// app/lib/activitypub/parser/media_attachment_parser.rb:31-35, v4.7.5, `mastodon#39590`): selection, then presence,
// then strip. A status's content, content warning and a converted title are read otherwise (StatusParser: `present?`,
// then the map; remote-status.ts languageString).

type Json = Record<string, unknown>;

// Ruby's String#strip: NUL, tab, LF, VT, FF, CR and space at either end. Scanned from both ends in linear time: the
// regex `[…]+$` backtracks quadratically over a long run of them followed by another character, which a remote
// summary of up to INBOX_BODY_LIMIT bytes can hold (test/lang-string.test.ts, "strips a run at the cap").
const isRubySpace = (code: number): boolean => code === 0x00 || code === 0x20 || (code >= 0x09 && code <= 0x0d);

function stripText(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isRubySpace(text.charCodeAt(start))) {
    start++;
  }
  while (end > start && isRubySpace(text.charCodeAt(end - 1))) {
    end--;
  }
  return text.slice(start, end);
}

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
      return stripText(value);
    }
  }
  return "";
}
