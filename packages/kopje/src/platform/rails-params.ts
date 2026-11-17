// Parameter names as Mastodon 4.7.5's Rack and Rails nest them into a typed tree of Strings, nils, Arrays and Hashes,
// one source at a time:
//   - Rack 3.2.8's QueryParser (each_query_pair and _normalize_params): a query, or a form body's pairs, in a
//     middleware (Rack::Attack reads every request's params): a `%` not followed by two hex digits
//     (InvalidParameterError), a key nested as two kinds (ParameterTypeError), a nesting 32 deep, more than 4,096 fields
//     or more than 4 MiB (QueryLimitError) refuse the request;
//   - Rails 8.1.3.1's ActionDispatch::QueryParser.each_pair and ParamBuilder#store_nested_param (deep munge on, the
//     depth limit 100), in the controller: the same nesting rules, and a key, or a top-level key's value, that is not
//     UTF-8 refuses it.
// The two differ only in their depth limit and in keeping a nil pushed onto an array (deep munge drops it), so a nested
// structure Rack accepts may still be one Rails refuses.

// A parameter's value as Ruby holds it: a String, nil, an Array or a Hash.
export type RailsParam = string | null | RailsParam[] | ParamHash;
export class ParamHash extends Map<string, RailsParam> {}

// A refusal of either parser (400).
export class Refused extends Error {}

export const RACK = { depthLimit: 32, pushNil: true };
export const RAILS = { depthLimit: 100, pushNil: false };
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
export function percentBytes(text: string, form: boolean): Uint8Array {
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
export function text(bytes: Uint8Array): string | undefined {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return undefined;
  }
}

// The bytes, each one char: Rack nests a key as bytes, whatever its encoding.
export function bytewise(bytes: Uint8Array): string {
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
export function store(flavor: Flavor, params: ParamHash, name: string, v: string | null, depth: number): RailsParam {
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
export function pairs(query: string): { key: Uint8Array; value: Uint8Array | null }[] {
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
