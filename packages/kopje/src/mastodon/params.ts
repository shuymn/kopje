import { readBoundedBody } from "../platform/body";
import { utf8Length } from "../platform/dump-format";
import { railsBoolean } from "../platform/rails-boolean";
import {
  bytewise,
  type Charge,
  pairs,
  ParamHash,
  RACK,
  RAILS,
  type RailsParam,
  Refused,
  store,
  text as utf8Text,
} from "../platform/rails-params";
import { rubyNumberToI, rubyToI } from "../platform/ruby-to-i";

// Request parameters as Mastodon reads them: the query string merged with a JSON, urlencoded or multipart body
// (clients send all three). The query and a form body are each nested as Rack and Rails nest them, in the order sent
// (platform/rails-params.ts): a key nested as two kinds refuses the request (400), and a later plain name replaces
// what an earlier one built under it whole. Each such tree is read back as form names (formParams), and JSON is
// flattened to the same names, so `{"source":{"privacy":"public"}}` reads as `source[privacy]` and `{"ids":["1","2"]}`
// as `ids[]`, the same as the form encodings.
//
// Bounds (RES-1), all in force before or while parsing:
// - the body: `limit` bytes (API_BODY_LIMIT by default); a multipart body on a route with a file rule may also carry
//   each declared file, so it may be `limit + names.length * (maxBytes + FILE_PART_SLACK)` bytes;
// - a form body's text: the UTF-8 bytes of every text entry's name and value and of the query, each as sent (also
//   one a later one replaces), at most `limit`;
// - the query and a urlencoded body: Rack's limits (4 MiB, 4,096 fields, a nesting 32 deep: 400); a multipart body:
//   Rack's part limits (MULTIPART_PARTS parts, MULTIPART_FILES file parts: 400);
// - paths: for a JSON body, and for each of the query's and a form body's trees as Rack and as Rails build them, at
//   most MAX_PARAM_PATHS keys (object members, array objects, empty lists, and for a tree each assignment, a
//   replacing one included; a list's scalar items are not counted), PARAM_PATH_BUDGET UTF-16 code units of every
//   key's name in bracket form, scalar items included, charged before each key is built or assigned, and
//   MAX_PARAM_DEPTH levels of nesting.

export const API_BODY_LIMIT = 1024 * 1024;
// The part headers and boundary of one declared file.
export const FILE_PART_SLACK = 16 * 1024;
// Rack's param_depth_limit (ParamsTooDeepError, answered 400).
export const MAX_PARAM_DEPTH = 32;
export const MAX_PARAM_PATHS = 10_000;
// Rack's multipart_total_part_limit and multipart_file_limit.
export const MULTIPART_PARTS = 4096;
export const MULTIPART_FILES = 128;
export const PARAM_PATH_BUDGET = 2 * API_BODY_LIMIT;

// The file parameters a route reads, and the most bytes one of them may have.
export type FileRule = { names: readonly string[]; maxBytes: number };
// bodyOnly: the query string is not read at all, for parameters that carry secrets, which must not come from URLs
// (the platform's invocation logs record them, as VIS-26 says of tokens).
export type ReadOptions = { limit?: number; files?: FileRule; bodyOnly?: true };

// The tail of an object field key after `name[`: `index][field]` or `][field]`.
const OBJECT_FIELD = /^(-?\d+|)\]\[([^\]]+)\]$/;
// The tail of an indexed object's prefix after `name[`: `index]`.
const OBJECT_INDEX = /^-?\d+\]$/;
// A key Rails' strong parameters read as an index of nested attributes (Parameters.nested_attribute?).
const INDEX = /^-?\d+$/;

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

type Leaf = string | File;

export class Params {
  constructor(
    readonly entries: readonly ParamEntry[],
    readonly files: ReadonlyMap<string, File> = new Map(),
    // The object prefixes the parameters hold, empty JSON objects included (sentObject).
    readonly objectPrefixes: ReadonlySet<string> = new Set(),
    // The names sent as an empty array (list): JSON `[]`, or a form's `name[]` without `=`, which deep munge empties.
    readonly emptyLists: ReadonlySet<string> = new Set(),
    // The top-level values of the query and a form body as Rack and Rails nest them, files included (objects reads
    // its objects from them); a JSON body has none.
    readonly trees: ReadonlyMap<string, RailsParam<Leaf>> = new Map(),
    // Every text pair of each source as sent, in order, also one a later pair or the query replaced: what repeated()
    // and the upload form's field bounds count. A JSON body's are its entries.
    readonly sent: readonly ParamEntry[] = entries,
  ) {}

  // These body parameters with the query's merged in, as Rails' `request_parameters.merge(query_parameters)`, a
  // shallow Hash#merge: each top-level key the query sends replaces the body's whole value under it, so a query
  // `poll[expires_in]` leaves none of a body's `poll`, its options included, and a query `expires_in[]` replaces a body
  // `expires_in`. A declared name is the exception: the body wins, and the query's value is read only when the body
  // has none (docs/mastodon-deviations.md). The query's entries follow the body's.
  withQuery(query: Params, declared: readonly string[]): Params {
    const names = new Set(declared);
    const keys = new Set(query.entries.map(([key]) => topKey(key)).filter((key) => !names.has(key)));
    const kept = (name: string) => !keys.has(topKey(name));
    // The maps are read directly: the parameter conformance check counts accessor calls as the handler's reads.
    const inBody = (name: string) => this.files.has(name) || this.entries.some(([key]) => key === name);
    const declaredQuery = [...names].flatMap((name) => {
      const entry = inBody(name) ? undefined : selected(query.entries, name);
      return entry === undefined ? [] : [entry];
    });
    return new Params(
      [
        ...this.entries.filter(([key]) => kept(key)),
        ...query.entries.filter(([key]) => !names.has(key)),
        ...declaredQuery,
      ],
      this.files,
      new Set([...[...this.objectPrefixes].filter(kept), ...query.objectPrefixes]),
      new Set([...[...this.emptyLists].filter(kept), ...query.emptyLists]),
      new Map([
        ...[...this.trees].filter(([key]) => kept(key)),
        ...[...query.trees].filter(([key]) => !names.has(key)),
      ]),
      [...this.sent, ...query.sent],
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

  // The first of `names` sent more than once as a plain name (query and body together, as sent: also where a later
  // pair or the query replaced it, or a pair between nested under it), for parameters that must be single (RFC 6749
  // §3.1, §3.2). Array parameters (`name[]`) are not scalars and are never named here.
  repeated(names: readonly string[]): string | undefined {
    return names.find((name) => this.sent.filter(([key]) => key === name).length > 1);
  }

  // The objects of an array parameter, as Rails' strong parameters permit `name: [fields]` of it: each Hash item of an
  // Array (a form's `name[][field]`, where a field the last object holds starts the next, as Rack nests it) and each
  // Hash under an index of a Hash (`name[0][field]`, JSON's arrays), in the order sent (a JSON body's in index order),
  // with its String fields, nil as blank. A field holding an Array or a Hash is not read; a file, only in a field of
  // `files`, as SENT_FILE. `nulls: "absent"` reads a nil (or JSON null) field as not sent.
  objects(name: string, options: ObjectOptions = {}): Record<string, string>[] {
    const tree = this.trees.get(name);
    return tree === undefined ? this.flatObjects(name, options) : treeObjects(tree, options);
  }

  // objects() of entries alone (a JSON body, or parameters built by hand): `name[index][field]` grouped by index (an
  // object prefix of an index with no field is an empty object), and `name[][field]` as a form nests it.
  private flatObjects(name: string, { nulls }: ObjectOptions): Record<string, string>[] {
    const prefix = `${name}[`;
    const indexed = new Map<string, Map<string, string>>();
    const sequential: Map<string, string>[] = [];
    for (const object of this.objectPrefixes) {
      if (object.startsWith(prefix) && OBJECT_INDEX.test(object.slice(prefix.length))) {
        indexed.set(object.slice(prefix.length, -1), new Map());
      }
    }
    for (const [key, value, json] of this.entries) {
      // The name is compared as a string; only the `[index][field]` tail is a pattern.
      const match = key.startsWith(prefix) ? OBJECT_FIELD.exec(key.slice(prefix.length)) : null;
      if (match === null || (nulls === "absent" && json === null)) {
        continue;
      }
      const [, index = "", field = ""] = match;
      const last = sequential.at(-1);
      if (index !== "") {
        indexed.set(index, (indexed.get(index) ?? new Map<string, string>()).set(field, value));
      } else if (last === undefined || last.has(field)) {
        sequential.push(new Map([[field, value]]));
      } else {
        last.set(field, value);
      }
    }
    const ordered = [...indexed].toSorted(([a], [b]) => Number(a) - Number(b)).map(([, fields]) => fields);
    return [...ordered, ...sequential].map((fields) => record(fields));
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

// An object as objects() returns it: without a prototype, so a field may be named as any property of one
// (`constructor`, `__proto__`).
function record(fields: Iterable<readonly [string, string]>): Record<string, string> {
  const object = Object.create(null) as Record<string, string>;
  for (const [field, value] of fields) {
    object[field] = value;
  }
  return object;
}

// objects() of a tree: the Hash items of an Array, or the Hashes under an index of a Hash.
function treeObjects(tree: RailsParam<Leaf>, { files, nulls }: ObjectOptions): Record<string, string>[] {
  const items = Array.isArray(tree)
    ? tree
    : tree instanceof ParamHash
      ? [...tree].filter(([key]) => INDEX.test(key)).map(([, item]) => item)
      : [];
  return items.flatMap((item) => {
    if (!(item instanceof ParamHash)) {
      return [];
    }
    const fields: [string, string][] = [];
    for (const [field, value] of item) {
      if (typeof value === "string") {
        fields.push([field, value]);
      } else if (value === null) {
        if (nulls !== "absent") {
          fields.push([field, ""]);
        }
      } else if (value instanceof File && files?.includes(field) === true) {
        fields.push([field, SENT_FILE]);
      }
    }
    return [record(fields)];
  });
}

export type ParamsResult = { ok: true; params: Params } | { ok: false; status: 400 | 413 };

// A refusal while parsing: past a size bound (413), or a parameter Rack or Rails refuses (400).
class ParamsRefused extends Error {
  constructor(readonly status: 400 | 413) {
    super(status === 413 ? "parameters past their bound" : "parameters refused");
  }
}

// The status of a refusal thrown while reading parameters (parseBody), or undefined for any other error.
export function refusedStatus(error: unknown): 400 | 413 | undefined {
  return error instanceof ParamsRefused ? error.status : undefined;
}

// A fresh budget of MAX_PARAM_PATHS paths and PARAM_PATH_BUDGET code units (RES-1): it refuses (413) before the key
// that would pass either is built.
function budget(): Charge {
  let paths = 0;
  let units = 0;
  return (prefix, key, path) => {
    paths += path ? 1 : 0;
    units += prefix + key.length + 2;
    if (paths > MAX_PARAM_PATHS || units > PARAM_PATH_BUDGET) {
      throw new ParamsRefused(413);
    }
  };
}

// A pair of a query or form body: its key as Rack nests it, and its name and value as Rails reads them (undefined
// where the bytes are not UTF-8).
type FormPair = { rackKey: string; name: string | undefined; value: Leaf | null | undefined };

// Rack's and Rails' refusals (platform/rails-params.ts) as this module's (400).
function refusing<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    throw error instanceof Refused ? new ParamsRefused(400) : error;
  }
}

// The pairs of a query or a urlencoded body (`pairs` refuses at a bad `%` or past Rack's limits), and the UTF-8 bytes
// of their keys and values.
function textPairs(input: string | Uint8Array): { pairs: FormPair[]; text: number } {
  let text = 0;
  const decoded = refusing(() => pairs(input)).map(({ key, value }): FormPair => {
    text += key.length + (value?.length ?? 0);
    return { rackKey: bytewise(key), name: utf8Text(key), value: value === null ? null : utf8Text(value) };
  });
  return { pairs: decoded, text };
}

// One source's parameters and the UTF-8 bytes of its text as sent.
type Source = { params: Params; formText: number };

// The parameters of one source's pairs, in order, as Rack and then Rails nest them, each on a budget of its own:
// refused (400) where either refuses (Rails: a key, or the value of a key with a top-level name, that is not UTF-8),
// and read back as form names (formParams). Each text pair is also kept as sent (Params#sent).
function formSource(input: { pairs: FormPair[]; text: number }, declared: ReadonlySet<string>): Source {
  return refusing(() => {
    const rack = new ParamHash();
    const rackCharge = budget();
    for (const { rackKey, value } of input.pairs) {
      store(RACK, rack, rackKey, value === null ? null : "", 0, rackCharge);
    }
    const rails = new ParamHash<Leaf>();
    const railsCharge = budget();
    const sent: ParamEntry[] = [];
    for (const { name, value } of input.pairs) {
      if (name === undefined || (value === undefined && name !== "")) {
        throw new Refused();
      }
      if (value === null) {
        sent.push([name, "", null]);
      } else if (typeof value !== "object") {
        sent.push([name, value ?? ""]);
      }
      store(RAILS, rails, name, value === undefined ? "" : value, 0, railsCharge);
    }
    return { params: formParams(rails, declared, sent), formText: input.text };
  });
}

// A source's tree as form names, in its order: a String as its entry, nil as a blank entry marked as JSON null is, an
// empty Array as `name[]` marked as an empty list, each item of a non-empty one under `name[]` (a Hash's fields as
// `name[][field]`), and each Hash as an object prefix. A file is the value of a declared top-level name; any other is
// read only by objects(), from the tree.
function formParams(tree: ParamHash<Leaf>, declared: ReadonlySet<string>, sent: readonly ParamEntry[]): Params {
  const entries: ParamEntry[] = [];
  const files = new Map<string, File>();
  const objects = new Set<string>();
  const empty = new Set<string>();
  const add = (name: string, value: RailsParam<Leaf>, top: boolean): void => {
    if (value === null) {
      entries.push([name, "", null]);
    } else if (typeof value === "string") {
      entries.push([name, value]);
    } else if (value instanceof ParamHash) {
      objects.add(name);
      for (const [key, item] of value) {
        add(`${name}[${key}]`, item, false);
      }
    } else if (Array.isArray(value)) {
      if (value.length === 0) {
        entries.push([`${name}[]`, ""]);
        empty.add(name);
      }
      for (const item of value) {
        add(`${name}[]`, item, false);
      }
    } else if (top && declared.has(name)) {
      files.set(name, value);
    }
  };
  for (const [key, value] of tree) {
    add(key, value, true);
  }
  return new Params(entries, files, objects, empty, tree, sent);
}

// The query of `request` as Rack and Rails read it (formSource), with the UTF-8 bytes of its pairs, or the status of
// its refusal.
function querySource(request: Request): Source | { status: 400 | 413 } {
  try {
    return formSource(textPairs(new URL(request.url).search.slice(1)), new Set());
  } catch (error) {
    const status = refusedStatus(error);
    if (status === undefined) {
      throw error;
    }
    return { status };
  }
}

// The query's parameters (querySource), or the status of its refusal.
export function readQuery(request: Request): ParamsResult {
  const query = querySource(request);
  return "params" in query ? { ok: true, params: query.params } : { ok: false, status: query.status };
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

// The query is read first, as Rack reads it before the body; with bodyOnly its shape is still checked, but none of its
// values is read.
export async function readParams(request: Request, options: ReadOptions = {}): Promise<ParamsResult> {
  const read = querySource(request);
  if (!("params" in read)) {
    return { ok: false, status: read.status };
  }
  const query = options.bodyOnly === true ? { params: new Params([]), formText: 0 } : read;
  if (request.method === "GET" || request.method === "HEAD") {
    return { ok: true, params: query.params };
  }
  const sentType = request.headers.get("content-type") ?? "";
  // Rack reads a POST body without a media type as a urlencoded form (Request#form_data?).
  const contentType = sentType === "" && request.method === "POST" ? "application/x-www-form-urlencoded" : sentType;
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
    return { ok: false, status: refusedStatus(error) ?? 400 };
  }
  const params = parsed.withQuery(query.params, options.files?.names ?? []);
  // A JSON body's names are generated, bounded by the path budget, and its values by the body; a form body's text,
  // every text part as sent (before a later one replaces it) and the query, is bounded here, so the files a multipart
  // body may carry cannot make room for more text.
  if (formText !== null && formText + query.formText > limit) {
    return { ok: false, status: 413 };
  }
  return { ok: true, params };
}

// The parameters of a body (without the query), nested as Rack and Rails nest them (formSource; a refusal throws). Of
// a declared name of `files`, the last part, text or file, is the value, as Rails assigns it, never both; of every
// other file part only its name and place are kept (objects with `files`), never its bytes. A part with an empty
// filename is text to workerd's parser (Rack drops it as an empty file field): empty, it reads as absent where the
// route reads a blank value so; with bytes, as a text value (docs/mastodon-deviations.md).
export async function parseBody(contentType: string, body: Uint8Array, files?: FileRule): Promise<Params> {
  return (await parseCounted(contentType, body, files)).params;
}

// parseBody, with the UTF-8 bytes of every text pair's name and value of a non-JSON body (null for JSON).
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
    flatten(JSON.parse(new TextDecoder().decode(body)), { entries, objects, empty, charge: budget() });
    return { params: selectDeclared(entries, objects, empty, declared), formText: null };
  }
  if (type === "application/x-www-form-urlencoded") {
    // Rack drops one NUL that ends the body (Request#form_pairs).
    return formSource(textPairs(body.at(-1) === 0 ? body.subarray(0, -1) : body), declared);
  }
  if (type === "multipart/form-data") {
    const form = await new Response(body, { headers: { "content-type": contentType } }).formData();
    let text = 0;
    let files = 0;
    const parts: FormPair[] = [];
    // FormData's entries are typed as strings by the runtime types; a file part is a File.
    for (const [key, value] of form.entries() as Iterable<[string, Leaf]>) {
      text += typeof value === "string" ? utf8Length(key) + utf8Length(value) : 0;
      files += typeof value === "string" ? 0 : 1;
      parts.push({ rackKey: key, name: key, value });
    }
    // Rack refuses the MULTIPART_PARTS-th part and the MULTIPART_FILES-th file part (MultipartTotalPartLimitError,
    // MultipartPartLimitError), which Mastodon answers 500: 400, as Rack's other limits.
    if (parts.length >= MULTIPART_PARTS || files >= MULTIPART_FILES) {
      throw new ParamsRefused(400);
    }
    return formSource({ pairs: parts, text }, declared);
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
  // Charges one generated key before its string is built (budget).
  charge: Charge;
};

function flatten(value: unknown, state: Flattening, prefix = "", depth = 0): void {
  if (depth > MAX_PARAM_DEPTH) {
    throw new ParamsRefused(400);
  }
  if (Array.isArray(value)) {
    // An empty array reads as `name[]=` with no value, as a form sends an empty list, and is marked as one (list).
    if (value.length === 0 && prefix !== "") {
      state.charge(prefix.length, "", true);
      state.entries.push([`${prefix}[]`, ""]);
      state.empty.add(prefix);
    }
    value.forEach((item, index) => {
      const scalar = item === null || typeof item !== "object";
      const key = scalar ? "" : String(index);
      // A scalar item is charged its code units only: it costs at least two body bytes of its own, and a list of
      // many values (Mastodon reads one of any length) is not a key amplification.
      state.charge(prefix.length, key, !scalar);
      flatten(item, state, `${prefix}[${key}]`, depth + 1);
    });
  } else if (typeof value === "object" && value !== null) {
    if (prefix !== "") {
      state.objects.add(prefix);
    }
    for (const [key, item] of Object.entries(value)) {
      state.charge(prefix.length, key, true);
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

// A sent parameter as Rails casts it to a boolean (railsBoolean): blank is absent.
export function parseBoolean(value: string | undefined): boolean | undefined {
  return railsBoolean(value) ?? undefined;
}
