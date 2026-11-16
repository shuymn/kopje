// The format parameter Mastodon 4.7.5 reads at a route with Rails' `(.:format)` (parameters[:format]), and where it
// refuses the request (400) before reading it: while the request is read, before any controller, or in the controller.
// Two parsers read the query, in this order:
//   - Rack 3.2.8's QueryParser#parse_nested_query, in a middleware (Rack::Attack's throttle_authenticated_paging reads
//     every request's params), on the key's bytes: a `%` not followed by two hex digits (InvalidParameterError) or a key
//     nested as two kinds (ParameterTypeError) is 400; a nesting 32 deep, more than 4,096 fields or more than 4 MiB
//     (QueryLimitError) is an unmapped 500 there, and 400 here;
//   - Rails 8.1.3.1's ActionDispatch::QueryParser.each_pair and ParamBuilder#store_nested_param (deep munge on, the
//     depth limit 100), in the controller, after ParamsWrapper reads the Content-Type (rails-format.ts
//     railsContentTypeRefused) and before it reads the format: the same, a key that is not UTF-8, and a top-level
//     key's value that is not UTF-8, are 400.
// The route's extension (the path parameter `format`, CGI.unescapeURIComponent'd, 400 in the router when not UTF-8) is
// merged last (Request#parameters), so it wins over the query's.

// A parameter's value as Ruby holds it: a String, nil, an Array or a Hash.
export type RailsParam = string | null | RailsParam[] | ParamHash;
class ParamHash extends Map<string, RailsParam> {}

class Refused extends Error {}

const RACK = { depthLimit: 32, pushNil: true };
const RAILS = { depthLimit: 100, pushNil: false };
type Flavor = typeof RACK;

const BYTESIZE_LIMIT = 4194304;
const PARAMS_LIMIT = 4096;
const SEPARATOR = /& */;
const HEX = /^[0-9A-Fa-f]{2}$/;

const utf8 = new TextEncoder();
// A BOM is a character, as Ruby reads it.
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// The bytes of a percent-encoded `text`: URI.decode_www_form_component's (a `+` is a space; a `%` not followed by two
// hex digits refuses) when `form`, else CGI.unescapeURIComponent's (a `+` stays; such a `%` stays).
function percentBytes(text: string, form: boolean): Uint8Array {
  const input = utf8.encode(text);
  const out: number[] = [];
  for (let i = 0; i < input.length; i++) {
    const byte = input[i]!;
    const hex = String.fromCharCode(input[i + 1] ?? 0, input[i + 2] ?? 0);
    if (byte === 0x25 && HEX.test(hex)) {
      out.push(Number.parseInt(hex, 16));
      i += 2;
    } else if (byte === 0x25 && form) {
      throw new Refused();
    } else {
      out.push(form && byte === 0x2b ? 0x20 : byte);
    }
  }
  return Uint8Array.from(out);
}

// The bytes as UTF-8, or undefined where they are not.
function text(bytes: Uint8Array): string | undefined {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return undefined;
  }
}

// The bytes, each one char: Rack nests a key as bytes, whatever its encoding.
function bytewise(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += String.fromCharCode(byte);
  }
  return out;
}

// params_hash_has_key?.
function hasKey(hash: ParamHash, key: string): boolean {
  if (key.includes("[]")) {
    return false;
  }
  let h: RailsParam = hash;
  for (const part of key.split(/[[\]]+/)) {
    if (part === "") {
      continue;
    }
    if (!(h instanceof ParamHash) || !h.has(part)) {
      return false;
    }
    h = h.get(part)!;
  }
  return true;
}

function arrayAt(params: ParamHash, key: string): RailsParam[] {
  const value = params.get(key) ?? [];
  if (!Array.isArray(value)) {
    throw new Refused();
  }
  params.set(key, value);
  return value;
}

// _normalize_params (Rack) and store_nested_param (Rails), which differ only in their depth limit and in keeping a nil
// pushed onto an array (deep munge drops it).
function store(flavor: Flavor, params: ParamHash, name: string, v: string | null, depth: number): RailsParam {
  if (depth >= flavor.depthLimit) {
    throw new Refused();
  }
  let k: string;
  let after: string;
  const close = name.indexOf("]", 1);
  if (depth === 0) {
    const start = name.indexOf("[", 1);
    [k, after] = start === -1 ? [name, ""] : [name.slice(0, start), name.slice(start)];
  } else if (name.startsWith("[]")) {
    [k, after] = ["[]", name.slice(2)];
  } else if (name.startsWith("[") && close !== -1) {
    [k, after] = [name.slice(1, close), name.slice(close + 1)];
  } else {
    [k, after] = [name, ""];
  }
  if (k === "") {
    return null;
  }
  if (after === "") {
    if (k === "[]" && depth !== 0) {
      return v !== null || flavor.pushNil ? [v] : [];
    }
    params.set(k, v);
  } else if (after === "[") {
    params.set(name, v);
  } else if (after === "[]") {
    const list = arrayAt(params, k);
    if (v !== null || flavor.pushNil) {
      list.push(v);
    }
  } else if (after.startsWith("[]")) {
    const inner = after.slice(3, after.length - 1);
    const child =
      after[2] === "[" && after.endsWith("]") && inner !== "" && !inner.includes("[") && !inner.includes("]")
        ? inner
        : after.slice(2);
    const list = arrayAt(params, k);
    const last = list.at(-1);
    if (last instanceof ParamHash && !hasKey(last, child)) {
      store(flavor, last, child, v, depth + 1);
    } else {
      list.push(store(flavor, new ParamHash(), child, v, depth + 1));
    }
  } else {
    const hash = params.get(k) ?? new ParamHash();
    if (!(hash instanceof ParamHash)) {
      throw new Refused();
    }
    params.set(k, store(flavor, hash, after, v, depth + 1));
  }
  return params;
}

// The query's pairs, each key and value (null without `=`) decoded; refused past Rack's limits or at a bad `%`.
function pairs(query: string): { key: Uint8Array; value: Uint8Array | null }[] {
  if (query === "") {
    return [];
  }
  const fields = query.split(SEPARATOR);
  if (utf8.encode(query).length > BYTESIZE_LIMIT || fields.length > PARAMS_LIMIT) {
    throw new Refused();
  }
  return fields
    .filter((field) => field !== "")
    .map((field) => {
      const at = field.indexOf("=");
      return {
        key: percentBytes(at === -1 ? field : field.slice(0, at), true),
        value: at === -1 ? null : percentBytes(field.slice(at + 1), true),
      };
    });
}

// Where Mastodon refuses a request's query or extension (400, or the 500 of a Rack limit): "request" while it reads the
// request, before any controller (Rack's parser, the router); "controller" when the controller reads its parameters.
type Refusal = "request" | "controller";

function refused<By extends Refusal>(error: unknown, by: By): { refused: By } {
  if (error instanceof Refused) {
    return { refused: by };
  }
  throw error;
}

// The format parameter of a request whose route extension is `extension` (undefined without one, as the path holds
// it) and whose query is `query` (without its `?`): `format` undefined when neither sets it (or the query's is nil);
// refused where Mastodon refuses it before reading it.
export function railsFormatParam(
  extension: string | undefined,
  query: string,
): { refused: "request" } | { refused: "controller" } | { refused: false; format: RailsParam | undefined } {
  let decoded: ReturnType<typeof pairs>;
  let pathFormat: string | undefined;
  try {
    decoded = pairs(query);
    const rack = new ParamHash();
    for (const { key, value } of decoded) {
      store(RACK, rack, bytewise(key), value === null ? null : "", 0);
    }
    pathFormat = extension?.includes("%") ? text(percentBytes(extension, false)) : extension;
    if (extension !== undefined && pathFormat === undefined) {
      throw new Refused();
    }
  } catch (error) {
    return refused(error, "request");
  }
  try {
    const rails = new ParamHash();
    for (const { key, value } of decoded) {
      const name = text(key);
      if (name === undefined) {
        throw new Refused();
      }
      const start = name.indexOf("[", 1);
      const top = start === -1 ? name : name.slice(0, start);
      const v = value === null ? null : text(value);
      if (v === undefined && top !== "") {
        throw new Refused();
      }
      store(RAILS, rails, name, v === undefined ? "" : v, 0);
    }
    return { refused: false, format: pathFormat ?? rails.get("format") };
  } catch (error) {
    return refused(error, "controller");
  }
}
