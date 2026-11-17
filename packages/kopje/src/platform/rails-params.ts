// Parameter names as Mastodon 4.7.5's Rack and Rails nest them into a typed tree of Strings, nils, Arrays and Hashes
// (and files, of a multipart body), one source at a time, in its order:
//   - Rack 3.2.8's QueryParser (each_query_pair and _normalize_params): a query, or a form body's pairs, in a
//     middleware (Rack::Attack reads every request's params): a `%` not followed by two hex digits
//     (InvalidParameterError), a key nested as two kinds (ParameterTypeError), a nesting 32 deep, more than 4,096 fields
//     or more than 4 MiB (QueryLimitError) refuse the request;
//   - Rails 8.1.3.1's ActionDispatch::QueryParser.each_pair and ParamBuilder#store_nested_param (deep munge on, the
//     depth limit 100), in the controller: the same nesting rules, and a key, or the value of a key with a top-level
//     name, that is not UTF-8 refuses it.
// The two differ only in their depth limit and in keeping a nil pushed onto an array (deep munge drops it), so a nested
// structure Rack accepts may still be one Rails refuses. Either assigns a plain name anew over whatever it held: a
// later `a=1` replaces an earlier `a[]=2` whole, where an earlier `a=1` makes a later `a[]=2` a refusal.

// A parameter's value as Ruby holds it: a String (or a file), nil, an Array or a Hash.
export type RailsParam<Leaf extends string | File = string> = Leaf | null | RailsParam<Leaf>[] | ParamHash<Leaf>;
export class ParamHash<Leaf extends string | File = string> extends Map<string, RailsParam<Leaf>> {}

// A refusal of either parser (400).
export class Refused extends Error {}

export const RACK = { depthLimit: 32, pushNil: true };
export const RAILS = { depthLimit: 100, pushNil: false };
type Flavor = typeof RACK;

// Called before store builds or assigns a node: `prefix` is the UTF-16 length of its parent's name in bracket form
// (0 at the top), `key` its own key ("" for an array's item), and `path` false for an array's scalar item. It throws to
// refuse.
export type Charge = (prefix: number, key: string, path: boolean) => void;

const BYTESIZE_LIMIT = 4194304;
const PARAMS_LIMIT = 4096;

const utf8 = new TextEncoder();
// A BOM is a character, as Ruby reads it.
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function hexDigit(byte: number | undefined): number {
  if (byte === undefined) {
    return -1;
  }
  if (byte >= 0x30 && byte <= 0x39) {
    return byte - 0x30;
  }
  const lower = byte | 0x20;
  return lower >= 0x61 && lower <= 0x66 ? lower - 0x57 : -1;
}

// The bytes of a percent-encoded `input`: URI.decode_www_form_component's (a `+` is a space; a `%` not followed by two
// hex digits refuses) when `form`, else CGI.unescapeURIComponent's (a `+` stays; such a `%` stays).
export function percentBytes(input: string | Uint8Array, form: boolean): Uint8Array {
  const bytes = typeof input === "string" ? utf8.encode(input) : input;
  const out = new Uint8Array(bytes.length);
  let n = 0;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]!;
    const high = byte === 0x25 ? hexDigit(bytes[i + 1]) : -1;
    const low = high === -1 ? -1 : hexDigit(bytes[i + 2]);
    if (low !== -1) {
      out[n++] = high * 16 + low;
      i += 2;
    } else if (byte === 0x25 && form) {
      throw new Refused();
    } else {
      out[n++] = form && byte === 0x2b ? 0x20 : byte;
    }
  }
  return out.subarray(0, n);
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
function hasKey<Leaf extends string | File>(hash: ParamHash<Leaf>, key: string): boolean {
  if (key.includes("[]")) {
    return false;
  }
  let h: RailsParam<Leaf> = hash;
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

// `params[key] ||= []`, charged when it builds the array.
function arrayAt<Leaf extends string | File>(
  params: ParamHash<Leaf>,
  key: string,
  charge: Charge | undefined,
  prefix: number,
): RailsParam<Leaf>[] {
  const found = params.get(key) ?? null;
  if (found === null) {
    charge?.(prefix, key, true);
  }
  const value = found ?? [];
  if (!Array.isArray(value)) {
    throw new Refused();
  }
  params.set(key, value);
  return value;
}

// _normalize_params (Rack) and store_nested_param (Rails), which differ only in their depth limit and in keeping a nil
// pushed onto an array (deep munge drops it). `prefix` is the UTF-16 length of `params`' name in bracket form, which
// `charge` is given with each node it builds or assigns, before it does.
export function store<Leaf extends string | File>(
  flavor: Flavor,
  params: ParamHash<Leaf>,
  name: string,
  v: Leaf | null,
  depth: number,
  charge?: Charge,
  prefix = 0,
): RailsParam<Leaf> {
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
  // The length of `k`'s name in bracket form.
  const named = depth === 0 ? k.length : prefix + k.length + 2;
  if (after === "") {
    if (k === "[]" && depth !== 0) {
      if (v === null && !flavor.pushNil) {
        return [];
      }
      charge?.(prefix, "", false);
      return [v];
    }
    charge?.(prefix, k, true);
    params.set(k, v);
  } else if (after === "[") {
    charge?.(prefix, name, true);
    params.set(name, v);
  } else if (after === "[]") {
    const list = arrayAt(params, k, charge, prefix);
    if (v !== null || flavor.pushNil) {
      charge?.(named, "", false);
      list.push(v);
    }
  } else if (after.startsWith("[]")) {
    const inner = after.slice(3, after.length - 1);
    const child =
      after[2] === "[" && after.endsWith("]") && inner !== "" && !inner.includes("[") && !inner.includes("]")
        ? inner
        : after.slice(2);
    const list = arrayAt(params, k, charge, prefix);
    const last = list.at(-1);
    if (last instanceof ParamHash && !hasKey(last, child)) {
      store(flavor, last, child, v, depth + 1, charge, named + 2);
    } else {
      charge?.(named, "", true);
      list.push(store(flavor, new ParamHash<Leaf>(), child, v, depth + 1, charge, named + 2));
    }
  } else {
    const found = params.get(k) ?? null;
    if (found !== null && !(found instanceof ParamHash)) {
      throw new Refused();
    }
    if (found === null) {
      charge?.(prefix, k, true);
    }
    params.set(k, store(flavor, found ?? new ParamHash<Leaf>(), after, v, depth + 1, charge, named));
  }
  return params;
}

type Pair = { key: Uint8Array; value: Uint8Array | null };

// The pairs of a query or a urlencoded body (`input` as UTF-8, or its bytes), each key and value (null without `=`)
// decoded; refused past Rack's limits or at a bad `%`. Fields part at an `&` and the spaces after it.
export function pairs(input: string | Uint8Array): Pair[] {
  const bytes = typeof input === "string" ? utf8.encode(input) : input;
  if (bytes.length === 0) {
    return [];
  }
  if (bytes.length > BYTESIZE_LIMIT) {
    throw new Refused();
  }
  const fields: Uint8Array[] = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x26) {
      fields.push(bytes.subarray(start, i));
      start = i + 1;
      while (bytes[start] === 0x20) {
        start++;
      }
      i = start - 1;
      if (fields.length >= PARAMS_LIMIT) {
        throw new Refused();
      }
    }
  }
  fields.push(bytes.subarray(start));
  return fields
    .filter((field) => field.length > 0)
    .map((field) => {
      const at = field.indexOf(0x3d);
      return {
        key: percentBytes(at === -1 ? field : field.subarray(0, at), true),
        value: at === -1 ? null : percentBytes(field.subarray(at + 1), true),
      };
    });
}
