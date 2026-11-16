import { readBoundedBody } from "../platform/body";
import { utf8Length } from "../platform/dump-format";
import { rubyNumberToI, rubyToI } from "../platform/ruby-to-i";

// Request parameters as Mastodon reads them: the query string merged with a JSON, urlencoded or multipart body
// (clients send all three). JSON is flattened to form names, so `{"source":{"privacy":"public"}}` reads as
// `source[privacy]` and `{"ids":["1","2"]}` as `ids[]`, the same as the form encodings.
//
// Bounds (RES-1), all in force before or while parsing:
// - the body: `limit` bytes (API_BODY_LIMIT by default); a multipart body on a route with a file rule may also carry
//   each declared file, so it may be `limit + names.length * (maxBytes + FILE_PART_SLACK)` bytes;
// - a form body's text: the UTF-8 bytes of every text entry's name and value and of the query, at most `limit`;
// - JSON paths: at most MAX_PARAM_PATHS generated keys (object members, array objects, empty lists; a list's scalar
//   items are not counted), PARAM_PATH_BUDGET UTF-16 code units of every generated key, charged before each key is
//   built, and MAX_PARAM_DEPTH levels of nesting.

export const API_BODY_LIMIT = 1024 * 1024;
// The part headers and boundary of one declared file.
export const FILE_PART_SLACK = 16 * 1024;
// Rack's param_depth_limit (ParamsTooDeepError, answered 400).
export const MAX_PARAM_DEPTH = 32;
export const MAX_PARAM_PATHS = 10_000;
export const PARAM_PATH_BUDGET = 2 * API_BODY_LIMIT;

// The file parameters a route reads, and the most bytes one of them may have.
export type FileRule = { names: readonly string[]; maxBytes: number };
// bodyOnly: the query string is not read at all, for parameters that carry secrets, which must not come from URLs
// (the platform's invocation logs record them, as VIS-26 says of tokens).
export type ReadOptions = { limit?: number; files?: FileRule; bodyOnly?: true };

// The tail of an object field key after `name[`: `index][field]` or `][field]`.
const OBJECT_FIELD = /^(\d*)\]\[([^\]]+)\]$/;

// A file part of a name the route declares no file rule for, and how many text entries the body had before it.
type FilePart = readonly [name: string, at: number];

// The value objects(name, { files }) reads for a listed field sent as a file part: presence only, never the file.
export const SENT_FILE = "(file)";

// `files`: fields of the objects whose file parts are read, as SENT_FILE, at their place in the body. `nulls:
// "absent"`: a field a JSON body sent as null is read as not sent, where other reads take it as blank.
export type ObjectOptions = { files?: readonly string[]; nulls?: "absent" };

// A parameter's name and text, and what a JSON body sent there when it was neither a string nor a boolean: a number,
// whose `text` is the number as JSON writes it and which integer parameters read (integerText), or null, whose `text`
// is blank (sentNull, objects' `nulls`). The mark stays on its entry, so a read judges the value it selected.
export type ParamEntry = readonly [name: string, text: string, json?: number | null];

// An entry's text as integer parameters read it: a JSON number as the decimal of its Ruby to_i (Float#to_i and
// Integer() of a Float both truncate), so `1e21` reads as 10^21 (capped as rubyToI caps), where the string "1e21" is
// read by the parameter's own reader.
function integerText([, text, json]: ParamEntry): string {
  return typeof json === "number" ? String(rubyNumberToI(json)) : text;
}

// The entry Rails' `params[name]` holds: the last of `name` (Rack assigns a repeated plain name, so the last wins),
// which is the query's for a top-level key the query sent, else the body's (withQuery). Read without the accessors,
// which the parameter conformance check counts as the handler's reads.
function selected(entries: readonly ParamEntry[], name: string): ParamEntry | undefined {
  return entries.findLast(([key]) => key === name);
}

// A file part's value while objects() groups the parts; no text value equals it.
const FILE_VALUE: unique symbol = Symbol("file part");
type Value = string | typeof FILE_VALUE;

export class Params {
  constructor(
    readonly entries: readonly ParamEntry[],
    readonly files: ReadonlyMap<string, File> = new Map(),
    // The JSON object prefixes the body sent, empty objects included (sentObject).
    readonly objectPrefixes: ReadonlySet<string> = new Set(),
    // The names a JSON body sent as an empty array (list).
    readonly emptyLists: ReadonlySet<string> = new Set(),
    // Undeclared file parts of a multipart body in body order; `at` indexes the body's prefix of `entries`.
    private readonly fileParts: readonly FilePart[] = [],
    // The body's entries the query replaced (withQuery), which repeated() still counts.
    private readonly replaced: readonly ParamEntry[] = [],
  ) {}

  // These body parameters with the query's merged in, as Rails' `request_parameters.merge(query_parameters)`, a
  // shallow Hash#merge: each top-level key the query sends replaces the body's whole value under it, so a query
  // `poll[expires_in]` leaves none of a body's `poll`, its options included, and a query `expires_in[]` replaces a body
  // `expires_in`. A declared name is the exception: the body wins, and the query's last value is read only when the
  // body has none (docs/mastodon-deviations.md). The query's entries follow the body's.
  withQuery(query: readonly ParamEntry[], declared: readonly string[]): Params {
    const names = new Set(declared);
    const keys = new Set(query.map(([key]) => topKey(key)).filter((key) => !names.has(key)));
    const kept = (name: string) => !keys.has(topKey(name));
    // The maps are read directly: the parameter conformance check counts accessor calls as the handler's reads.
    const sent = (name: string) => this.files.has(name) || this.entries.some(([key]) => key === name);
    const declaredQuery = [...names].flatMap((name): [string, string][] => {
      const value = sent(name) ? undefined : query.findLast(([key]) => key === name)?.[1];
      return value === undefined ? [] : [[name, value]];
    });
    // A file part's place counts the body's entries kept before it.
    const keptBefore = [0];
    for (const [key] of this.entries) {
      keptBefore.push((keptBefore.at(-1) ?? 0) + (kept(key) ? 1 : 0));
    }
    return new Params(
      [...this.entries.filter(([key]) => kept(key)), ...query.filter(([key]) => !names.has(key)), ...declaredQuery],
      this.files,
      new Set([...this.objectPrefixes].filter(kept)),
      new Set([...this.emptyLists].filter(kept)),
      this.fileParts.filter(([name]) => kept(name)).map(([name, at]) => [name, keptBefore[at] ?? 0]),
      [...this.replaced, ...this.entries.filter(([key]) => !kept(key))],
    );
  }

  // Rails' `params[name]` (selected): a JSON number as JSON writes it, a JSON null as blank (sentNull).
  get(name: string): string | undefined {
    return selected(this.entries, name)?.[1];
  }

  // Rails' `params[name]` (selected) as an integer parameter reads it (integerText).
  integer(name: string): string | undefined {
    const entry = selected(this.entries, name);
    return entry === undefined ? undefined : integerText(entry);
  }

  // A declared file parameter whose effective value is a file (readParams' typed selection): then get(name) is
  // undefined, and the other way round.
  file(name: string): File | undefined {
    return this.files.get(name);
  }

  // Whether the value get(name) reads (blank) is a JSON null: Rails assigns nil, where a blank string stays a string.
  sentNull(name: string): boolean {
    return selected(this.entries, name)?.[2] === null;
  }

  // Whether `name` or `name[]` was sent at all, even with no value: an explicitly empty list is not an absent one.
  has(name: string): boolean {
    return this.entries.some(([key]) => key === name || key === `${name}[]`);
  }

  // Whether `name` was sent as an object: some `name[field]`, as JSON `{"name":{"field":...}}` reads. An empty object
  // sends nothing, and an array (`name[]`) is not an object.
  hasObject(name: string): boolean {
    return this.entries.some(([key]) => key.startsWith(`${name}[`) && !key.startsWith(`${name}[]`));
  }

  // hasObject, and also a JSON object with no scalar inside (`{"home":{}}`, `{"fields_attributes":{"0":{}}}`), which
  // Rails reads as a sent, empty hash.
  sentObject(name: string): boolean {
    return this.objectPrefixes.has(name) || this.hasObject(name);
  }

  // The first of `names` sent more than once (query and body together, a body value the query replaced included), for
  // parameters that must be single (RFC 6749 §3.1, §3.2). Array parameters (`name[]`) are not scalars and are never
  // named here.
  repeated(names: readonly string[]): string | undefined {
    const all = [...this.entries, ...this.replaced];
    return names.find((name) => all.filter(([key]) => key === name).length > 1);
  }

  // The objects of an array parameter: JSON sends `name[0][field]` (indexed), forms send `name[][field]`, where a field
  // that repeats starts the next object (as Rack reads it). Without `files`, file parts are not read. With it, every
  // file part is grouped at its place in the body, as Rack groups it, and then read as SENT_FILE in a field of
  // `files` and as absent in any other.
  objects(name: string, options: ObjectOptions = {}): Record<string, string>[] {
    const prefix = `${name}[`;
    const files = options.files === undefined ? null : new Set(options.files);
    const absentNulls = options.nulls === "absent";
    const indexed = new Map<string, Record<string, Value>>();
    const sequential: Record<string, Value>[] = [];
    const add = (key: string, value: Value) => {
      // The name is compared as a string; only the `[index][field]` tail is a pattern.
      const match = key.startsWith(prefix) ? OBJECT_FIELD.exec(key.slice(prefix.length)) : null;
      if (match === null) {
        return;
      }
      const [, index = "", field = ""] = match;
      if (index !== "") {
        const object = indexed.get(index) ?? {};
        object[field] = value;
        indexed.set(index, object);
        return;
      }
      const last = sequential.at(-1);
      if (last === undefined || field in last) {
        sequential.push({ [field]: value });
      } else {
        last[field] = value;
      }
    };
    const parts = files === null ? [] : this.fileParts;
    let next = 0;
    const partsBefore = (at: number) => {
      for (let part = parts[next]; part !== undefined && part[1] <= at; part = parts[++next]) {
        add(part[0], FILE_VALUE);
      }
    };
    this.entries.forEach(([key, value, json], at) => {
      partsBefore(at);
      if (!(absentNulls && json === null)) {
        add(key, value);
      }
    });
    partsBefore(Infinity);
    const project = (object: Record<string, Value>): Record<string, string> =>
      Object.fromEntries(
        Object.entries(object).flatMap(([field, value]): [string, string][] =>
          value !== FILE_VALUE ? [[field, value]] : files?.has(field) === true ? [[field, SENT_FILE]] : [],
        ),
      );
    return [
      ...[...indexed].toSorted(([a], [b]) => Number(a) - Number(b)).map(([, object]) => object),
      ...sequential,
    ].map(project);
  }

  // Values of `name[]` only, or undefined when none was sent: an array parameter as Rails' strong parameters permit
  // it (`name: []`), which drop a scalar `name`. A form's `name[]=` is one blank value, as Rack reads it; a JSON
  // empty array is an empty list (its blank entry, which has() and getAll() read, is not a value).
  list(name: string): string[] | undefined {
    const values = this.entries.filter(([key]) => key === `${name}[]`).map(([, value]) => value);
    if (this.emptyLists.has(name)) {
      values.splice(values.indexOf(""), 1);
      return values;
    }
    return values.length === 0 ? undefined : values;
  }

  // Values of `name[]` and of a repeated `name`.
  getAll(name: string): string[] {
    return this.entries.filter(([key]) => key === name || key === `${name}[]`).map(([, value]) => value);
  }

  // getAll, each value as integer parameters read it (integerText).
  getAllIntegers(name: string): string[] {
    return this.entries.filter(([key]) => key === name || key === `${name}[]`).map(integerText);
  }
}

// Rack's top-level key of a parameter name: what comes before the first `[` after its first character
// (`poll[options][]` is under `poll`, `[a]` is its own key).
function topKey(name: string): string {
  const at = name.indexOf("[", 1);
  return at === -1 ? name : name.slice(0, at);
}

export type ParamsResult = { ok: true; params: Params } | { ok: false; status: 400 | 413 };

// A refusal while parsing: past a size bound (413) or nested too deep (400).
class ParamsRefused extends Error {
  constructor(readonly status: 400 | 413) {
    super(status === 413 ? "parameters past their bound" : "parameters nested too deep");
  }
}

export function mediaTypeOf(contentType: string | undefined): string | undefined {
  return contentType?.split(";")[0]?.trim().toLowerCase();
}

// The body limit of a request: a file route's multipart body may carry its files besides the text. The rule is
// chosen from Content-Type before any byte is read.
export function bodyLimit(contentType: string, options: ReadOptions = {}): number {
  const limit = options.limit ?? API_BODY_LIMIT;
  const files = options.files;
  return files !== undefined && mediaTypeOf(contentType) === "multipart/form-data"
    ? limit + files.names.length * (files.maxBytes + FILE_PART_SLACK)
    : limit;
}

export async function readParams(request: Request, options: ReadOptions = {}): Promise<ParamsResult> {
  const query = options.bodyOnly === true ? [] : [...new URL(request.url).searchParams.entries()];
  if (request.method === "GET" || request.method === "HEAD") {
    return { ok: true, params: new Params(query) };
  }
  const contentType = request.headers.get("content-type") ?? "";
  const body = await readBoundedBody(request, bodyLimit(contentType, options));
  if (body === "too-large") {
    return { ok: false, status: 413 };
  }
  const limit = options.limit ?? API_BODY_LIMIT;
  let parsed: Params;
  let formText: number | null;
  try {
    ({ params: parsed, formText } = await parseCounted(contentType, body, options.files));
  } catch (error) {
    return { ok: false, status: error instanceof ParamsRefused ? error.status : 400 };
  }
  const params = parsed.withQuery(query, options.files?.names ?? []);
  // A JSON body's names are generated, bounded by the path budget, and its values by the body; a form body's text,
  // every text part as sent (before the last-part selection) and the query, is bounded here, so the files a
  // multipart body may carry cannot make room for more text.
  if (formText !== null) {
    let text = formText;
    for (const [key, value] of query) {
      text += utf8Length(key) + utf8Length(value);
    }
    if (text > limit) {
      return { ok: false, status: 413 };
    }
  }
  return { ok: true, params };
}

// The parameters of a body (without the query). For each name of `files`, one effective value is chosen as Rails
// reads repeated parts: in body order, each part of that name, text or file, replaces the one before (the last wins).
// That value is either a text entry or a file, never both. Of every other file part only its name and place are kept
// (objects with `files`), never its bytes. A part with an empty filename is text to workerd's parser (Rack drops it
// as an empty file field): empty, it reads as absent where the route reads a blank value so; with bytes, as a text
// value (docs/mastodon-deviations.md).
export async function parseBody(contentType: string, body: Uint8Array, files?: FileRule): Promise<Params> {
  return (await parseCounted(contentType, body, files)).params;
}

// parseBody, with the UTF-8 bytes of every text part's name and value of a non-JSON body (null for JSON).
async function parseCounted(
  contentType: string,
  body: Uint8Array,
  files?: FileRule,
): Promise<{ params: Params; formText: number | null }> {
  const declared = new Set(files?.names ?? []);
  const type = mediaTypeOf(contentType);
  if (body.byteLength === 0) {
    // An empty body has no text of its own, but the query of a non-JSON request is still counted (readParams).
    return { params: new Params([]), formText: type === "application/json" ? null : 0 };
  }
  if (type === "application/json") {
    const entries: ParamEntry[] = [];
    const objects = new Set<string>();
    const empty = new Set<string>();
    // JSON.parse keeps the last of duplicate keys, so repeated() sees form and query duplicates only. RFC 6749 defines
    // form bodies alone, and Doorkeeper (Mastodon) lets the last JSON key win as well.
    flatten(JSON.parse(new TextDecoder().decode(body)), { entries, objects, empty, paths: 0, units: 0 });
    return { params: selectDeclared(entries, objects, empty, declared), formText: null };
  }
  if (type === "application/x-www-form-urlencoded" || type === "multipart/form-data") {
    const form = await new Response(body, { headers: { "content-type": contentType } }).formData();
    const entries: [string, string][] = [];
    const chosen = new Map<string, string | File>();
    const fileParts: FilePart[] = [];
    let formText = 0;
    // FormData's entries are typed as strings by the runtime types; a file part is a File.
    for (const [key, value] of form.entries() as Iterable<[string, string | File]>) {
      if (typeof value === "string") {
        formText += utf8Length(key) + utf8Length(value);
      }
      if (declared.has(key)) {
        chosen.set(key, value);
      } else if (typeof value === "string") {
        entries.push([key, value]);
      } else {
        fileParts.push([key, entries.length]);
      }
    }
    const fileValues = new Map<string, File>();
    for (const [key, value] of chosen) {
      if (typeof value === "string") {
        entries.push([key, value]);
      } else {
        fileValues.set(key, value);
      }
    }
    return { params: new Params(entries, fileValues, new Set(), new Set(), fileParts), formText };
  }
  return { params: new Params([]), formText: null };
}

// A JSON body keeps only the last entry of a declared name, whole, as the form's last-part rule does (parseCounted), so
// withQuery reads the query's value of that name only when the body has none.
function selectDeclared(
  entries: ParamEntry[],
  objects: Set<string>,
  empty: Set<string>,
  declared: ReadonlySet<string>,
): Params {
  const last = new Map<string, ParamEntry>();
  for (const entry of entries) {
    if (declared.has(entry[0])) {
      last.set(entry[0], entry);
    }
  }
  return new Params([...entries.filter(([key]) => !declared.has(key)), ...last.values()], new Map(), objects, empty);
}

type Flattening = {
  entries: ParamEntry[];
  objects: Set<string>;
  empty: Set<string>;
  paths: number;
  units: number;
};

// Charges one generated key before its string is built: past MAX_PARAM_PATHS object keys, array objects and empty
// lists, or PARAM_PATH_BUDGET code units of every generated key, the body is refused (413).
function charge(state: Flattening, prefix: string, key: string, path = true): void {
  state.paths += path ? 1 : 0;
  state.units += prefix.length + key.length + 2;
  if (state.paths > MAX_PARAM_PATHS || state.units > PARAM_PATH_BUDGET) {
    throw new ParamsRefused(413);
  }
}

function flatten(value: unknown, state: Flattening, prefix = "", depth = 0): void {
  if (depth > MAX_PARAM_DEPTH) {
    throw new ParamsRefused(400);
  }
  if (Array.isArray(value)) {
    // An empty array reads as `name[]=` with no value, as a form sends an empty list, and is marked as one (list).
    if (value.length === 0 && prefix !== "") {
      charge(state, prefix, "");
      state.entries.push([`${prefix}[]`, ""]);
      state.empty.add(prefix);
    }
    value.forEach((item, index) => {
      const scalar = item === null || typeof item !== "object";
      const key = scalar ? "" : String(index);
      // A scalar item is charged its code units only: it costs at least two body bytes of its own, and a list of
      // many values (Mastodon reads one of any length) is not a key amplification.
      charge(state, prefix, key, !scalar);
      flatten(item, state, `${prefix}[${key}]`, depth + 1);
    });
  } else if (typeof value === "object" && value !== null) {
    if (prefix !== "") {
      state.objects.add(prefix);
    }
    for (const [key, item] of Object.entries(value)) {
      charge(state, prefix, key);
      flatten(item, state, prefix === "" ? key : `${prefix}[${key}]`, depth + 1);
    }
  } else if (prefix !== "") {
    // Scalars only here: strings as they are, booleans as JSON writes them, a number as JSON writes it and null as
    // blank, each of these two marked on its entry (ParamEntry).
    if (typeof value === "number" || value === null) {
      state.entries.push([prefix, value === null ? "" : JSON.stringify(value), value]);
    } else {
      state.entries.push([prefix, typeof value === "string" ? value : JSON.stringify(value)]);
    }
  }
}

// `offset` as Mastodon's offset endpoints read it (params[:offset].to_i): a negative one is 0.
export function offsetParam(p: Params): number {
  return Math.max(rubyToI(p.integer("offset") ?? "0"), 0);
}

// `limit` as Api::BaseController#limit_param reads it: `fallback` when absent, else the absolute value of its to_i, at
// most `max`.
export function limitParam(p: Params, fallback: number, max: number): number {
  const limit = p.integer("limit");
  return limit === undefined ? fallback : Math.min(Math.abs(rubyToI(limit)), max);
}

// ActiveModel::Type::Boolean#cast's false values, each in its own case only ('False' casts to true), with blank.
export const RAILS_FALSE: readonly string[] = ["", "0", "f", "F", "false", "FALSE", "off", "OFF"];

// Rails' boolean casting: blank is absent, a value of RAILS_FALSE is false, anything else is true.
export function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  return !RAILS_FALSE.includes(value);
}
