import { describe, expect, it } from "vitest";

import {
  API_BODY_LIMIT,
  bodyLimit,
  MAX_PARAM_DEPTH,
  MAX_PARAM_PATHS,
  MULTIPART_FILES,
  MULTIPART_PARTS,
  PARAM_PATH_BUDGET,
  limitParam,
  Params,
  parseBoolean,
  type ReadOptions,
  readParams,
  SENT_FILE,
} from "../src/mastodon/params";
import { rubyInteger } from "../src/platform/ruby-integer";
import { rubyNumberToI, rubyToI } from "../src/platform/ruby-to-i";
import integer from "./fixtures/ruby-integer/integer.json";
import toI from "./fixtures/ruby-to-i/to-i.json";
import { multipartForm } from "./media-helpers";

// Ruby 4.0.9's String#to_i of each value (to-i.json, captured by its capture.rb); a magnitude past
// Number.MAX_SAFE_INTEGER is read as that.
describe("rubyToI", () => {
  it("is checked against Mastodon 4.7.5's Ruby", () => {
    expect(toI.ruby).toBe("4.0.9");
  });

  const max = BigInt(Number.MAX_SAFE_INTEGER);
  it.each(toI.rows.map((row) => [row.value, row.to_i] as const))(
    "reads %j as Ruby's to_i reads it, %s",
    (value, ruby) => {
      const exact = BigInt(ruby);
      const capped = exact > max ? max : exact < -max ? -max : exact;
      expect(rubyToI(value)).toBe(Number(capped));
    },
  );

  // A JSON number's to_i, null where Ruby raises (a Float past its range), which Kopje reads as the cap.
  it.each(toI.numbers.map((row) => [row.json, row.to_i] as const))(
    "reads the JSON number %s as Ruby's to_i of it, %s",
    (json, ruby) => {
      const number = JSON.parse(json) as number;
      const exact = ruby === null ? (number < 0 ? -max : max) : BigInt(ruby);
      const capped = exact > max ? max : exact < -max ? -max : exact;
      expect(rubyNumberToI(number)).toBe(Number(capped));
    },
  );
});

// Ruby 4.0.9's Kernel#Integer of each value (integer.json, captured by its capture.rb), null where it raises; a
// magnitude past Number.MAX_SAFE_INTEGER is read as that.
describe("rubyInteger", () => {
  it("is checked against Mastodon 4.7.5's Ruby", () => {
    expect(integer.ruby).toBe("4.0.9");
  });

  const max = BigInt(Number.MAX_SAFE_INTEGER);
  const capped = (ruby: string) => {
    const exact = BigInt(ruby);
    return Number(exact > max ? max : exact < -max ? -max : exact);
  };
  it.each(integer.strings.map((row) => [row.value, row.integer] as const))(
    "reads %j as Ruby's Integer() reads it, %s",
    (value, ruby) => {
      expect(rubyInteger(value)).toBe(ruby === null ? null : capped(ruby));
    },
  );

  // Integer() of a JSON number truncates it as to_i does, so integer parameters read both by rubyNumberToI; null where
  // Ruby raises (a Float past its range), which Kopje reads as the cap.
  it.each(integer.numbers.map((row) => [row.json, row.integer] as const))(
    "reads the JSON number %s as Ruby's Integer() of it, %s",
    (json, ruby) => {
      const number = JSON.parse(json) as number;
      expect(rubyNumberToI(number)).toBe(ruby === null ? Math.sign(number) * Number(max) : capped(ruby));
    },
  );
});

describe("Params#objects", () => {
  it("reads indexed (JSON) and sequential (form) objects", () => {
    const p = new Params([
      ["media_attributes[1][id]", "b"],
      ["media_attributes[0][id]", "a"],
      ["media_attributes[0][description]", "A"],
      ["media_attributes[][id]", "c"],
      ["media_attributes[][description]", "C"],
      ["media_attributes[][id]", "d"],
    ]);
    expect(p.objects("media_attributes")).toEqual([
      { id: "a", description: "A" },
      { id: "b" },
      { id: "c", description: "C" },
      { id: "d" },
    ]);
  });

  it("matches the name literally, regex metacharacters included", () => {
    const p = new Params([
      ["a.b[0][id]", "literal"],
      ["axb[0][id]", "wildcard"],
      ["a\\b[0][id]", "backslash"],
      ["(x)[0][id]", "group"],
    ]);
    expect(p.objects("a.b")).toEqual([{ id: "literal" }]);
    expect(p.objects("a\\b")).toEqual([{ id: "backslash" }]);
    expect(p.objects("(x)")).toEqual([{ id: "group" }]);
    expect(p.objects(".*")).toEqual([]);
  });
});

const FILES = { names: ["avatar"], maxBytes: 64 };

function multipart(parts: [string, string | File][], query = ""): Request {
  return new Request(`https://kopje.test/x${query}`, { method: "POST", body: multipartForm(parts) });
}

function post(body: BodyInit, type: string, query = ""): Request {
  return new Request(`https://kopje.test/x${query}`, { method: "POST", body, headers: { "content-type": type } });
}

async function read(request: Request, options?: ReadOptions): Promise<Params> {
  const result = await readParams(request, options);
  if (!result.ok) {
    throw new Error(`refused ${result.status}`);
  }
  return result.params;
}

const png = (name = "a.png") => new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });

// Rails' params[name]: the query's last value, else the body's last; integer() reads it as an integer parameter does.
describe("Params#get and Params#integer", () => {
  it("reads the last of repeated values, in the query or a form body", async () => {
    const query = await read(new Request("https://kopje.test/x?a=1&a=2"));
    expect([query.get("a"), query.integer("a")]).toEqual(["2", "2"]);
    const form = await read(post("a=1&a=2", "application/x-www-form-urlencoded"));
    expect([form.get("a"), form.integer("a")]).toEqual(["2", "2"]);
    const parts = await read(
      multipart([
        ["a", "1"],
        ["a", "2"],
      ]),
    );
    expect([parts.get("a"), parts.integer("a")]).toEqual(["2", "2"]);
  });

  it("reads the query's value over the body's, form or JSON", async () => {
    const form = await read(post("a=1", "application/x-www-form-urlencoded", "?a=3"));
    expect([form.get("a"), form.integer("a")]).toEqual(["3", "3"]);
    const json = await read(post(JSON.stringify({ a: 1, b: 2 }), "application/json", "?a=4&a=5"));
    expect([json.get("a"), json.integer("a"), json.get("b")]).toEqual(["5", "5", "2"]);
    const absent = await read(post("b=1", "application/x-www-form-urlencoded"));
    expect([absent.get("a"), absent.integer("a")]).toEqual([undefined, undefined]);
  });

  it("reads a JSON number by Ruby's to_i of the number, and a string by String#to_i", async () => {
    const p = await read(post('{"a":1e21,"b":"1e21","c":1e-7,"d":-0.5,"e":3.9}', "application/json"));
    expect(["a", "b", "c", "d", "e"].map((name) => p.integer(name))).toEqual([
      "9007199254740991",
      "1e21",
      "0",
      "0",
      "3",
    ]);
    // Other reads keep the number as JSON writes it.
    expect([p.get("a"), p.get("c")]).toEqual(["1e+21", "1e-7"]);
  });

  it("reads each value of a list as integer parameters read it", async () => {
    const p = await read(post('{"c":[1.9,"0x1",1e21,"1e21"]}', "application/json", "?d[]=1.9&d[]=2"));
    expect([p.getAllIntegers("c"), p.getAll("c"), p.getAllIntegers("d")]).toEqual([
      ["1", "0x1", "9007199254740991", "1e21"],
      ["1.9", "0x1", "1e+21", "1e21"],
      ["1.9", "2"],
    ]);
  });

  it("reads a declared file in the body over a query text, as Rails' last-part rule", async () => {
    const p = await read(multipart([["avatar", png()]], "?avatar=q"), { files: FILES });
    expect([p.get("avatar"), p.integer("avatar"), p.file("avatar")?.name]).toEqual([undefined, undefined, "a.png"]);
  });
});

// A JSON null is marked on its entry, so sentNull and objects' `nulls` judge the entry get and objects select.
describe("Params: a JSON null's mark", () => {
  it("is read on the selected entry, through the query merge", async () => {
    const alone = await read(post('{"note":null}', "application/json"));
    expect([alone.get("note"), alone.sentNull("note")]).toEqual(["", true]);
    const blank = await read(post('{"note":null}', "application/json", "?note="));
    expect([blank.get("note"), blank.sentNull("note")]).toEqual(["", false]);
    const text = await read(post('{"note":null}', "application/json", "?note=x"));
    expect([text.get("note"), text.sentNull("note")]).toEqual(["x", false]);
    const string = await read(post('{"note":""}', "application/json"));
    expect([string.get("note"), string.sentNull("note")]).toEqual(["", false]);
  });

  it("stays with its entry when a name is flattened twice, as a key spelled with brackets makes it", async () => {
    const nullLast = await read(post('{"a[b]":"","a":{"b":null}}', "application/json"));
    const stringLast = await read(post('{"a":{"b":null},"a[b]":""}', "application/json"));
    expect([nullLast.sentNull("a[b]"), stringLast.sentNull("a[b]")]).toEqual([true, false]);
    const objects = await read(post('{"o":[{"a":null}],"o[0][a]":"x"}', "application/json"));
    expect(objects.objects("o", { nulls: "absent" })).toEqual([{ a: "x" }]);
  });

  it("is kept on the last entry of a declared name", async () => {
    const p = await read(post('{"avatar":null}', "application/json"), { files: FILES });
    expect([p.get("avatar"), p.sentNull("avatar")]).toEqual(["", true]);
  });
});

// sentUnder: a name sent in any shape, which get() reads only as a string (the account search tells an absent q from
// one sent as an array or a hash with it).
describe("Params: sentUnder", () => {
  it("is true of a value or anything nested under the name, and of nothing else", async () => {
    for (const query of ["q=a", "q=", "q", "q[]", "q[]=a", "q[a]=b", "q[][a]=b", "q[][]=a", "q[a][b]=c"]) {
      const p = await read(post("", "application/x-www-form-urlencoded", `?${query}`));
      expect([query, p.sentUnder("q")]).toEqual([query, true]);
    }
    for (const body of ['{"q":{}}', '{"q":[]}', '{"q":null}', '{"q":{"a":{}}}']) {
      expect([body, (await read(post(body, "application/json"))).sentUnder("q")]).toEqual([body, true]);
    }
    for (const query of ["", "qq=a", "x[q]=a", "a=q"]) {
      const p = await read(post('{"r":{}}', "application/json", `?${query}`));
      expect([query, p.sentUnder("q")]).toEqual([query, false]);
    }
  });
});

// Rails' request.parameters is request_parameters.merge(query_parameters): a shallow Hash#merge, so a top-level key the
// query sends replaces the body's whole value under it.
describe("readParams: the query over the body, by top-level key", () => {
  const poll = { options: ["a", "b"], expires_in: "600" };
  const bodies: [string, Request][] = [
    ["JSON", post(JSON.stringify({ status: "s", poll }), "application/json", "?poll[expires_in]=900")],
    [
      "a form",
      post(
        new URLSearchParams([
          ["status", "s"],
          ["poll[options][]", "a"],
          ["poll[options][]", "b"],
          ["poll[expires_in]", "600"],
        ]),
        "application/x-www-form-urlencoded",
        "?poll[expires_in]=900",
      ),
    ],
    [
      "multipart",
      multipart(
        [
          ["status", "s"],
          ["poll[options][]", "a"],
          ["poll[options][]", "b"],
          ["poll[expires_in]", "600"],
        ],
        "?poll[expires_in]=900",
      ),
    ],
  ];
  it.each(bodies)("leaves none of %s body's poll beside a query poll[expires_in]", async (_, request) => {
    const p = await read(request);
    expect([p.integer("poll[expires_in]"), p.getAll("poll[options]"), p.get("status")]).toEqual(["900", [], "s"]);
  });

  it("drops a scalar under a query array or hash of its name", async () => {
    for (const query of ["?expires_in[]=7200", "?expires_in[a]=7200"]) {
      const form = await read(post("expires_in=3600&title=t", "application/x-www-form-urlencoded", query));
      expect([query, form.integer("expires_in"), form.get("title")]).toEqual([query, undefined, "t"]);
      const json = await read(post(JSON.stringify({ expires_in: 3600 }), "application/json", query));
      expect([query, json.integer("expires_in")]).toEqual([query, undefined]);
    }
  });

  it("drops what a JSON body noted of a replaced key: an object, an empty list, a null", async () => {
    const p = await read(
      post(JSON.stringify({ home: {}, ids: [], note: null }), "application/json", "?home=x&ids[]=1&note="),
    );
    expect([p.sentObject("home"), p.list("ids"), p.sentNull("note")]).toEqual([false, ["1"], false]);
  });

  it("places a file part among the body's entries the query left", async () => {
    const parts: [string, string | File][] = [
      ["focus", "1"],
      ["media_attributes[][id]", "a"],
      ["media_attributes[][thumbnail]", png()],
      ["media_attributes[][id]", "b"],
    ];
    const left = await read(multipart(parts, "?focus=2"));
    expect(left.objects("media_attributes", { files: ["thumbnail"] })).toEqual([
      { id: "a", thumbnail: SENT_FILE },
      { id: "b" },
    ]);
    const replaced = await read(multipart(parts, "?media_attributes[][id]=q"));
    expect(replaced.objects("media_attributes", { files: ["thumbnail"] })).toEqual([{ id: "q" }]);
  });

  it("still counts a body value the query replaced as a repeat", async () => {
    const p = await read(post("code=a", "application/x-www-form-urlencoded", "?code=b"));
    expect([p.get("code"), p.repeated(["code"])]).toEqual(["b", "code"]);
  });
});

describe("readParams: declared files (Rails last-part rule)", () => {
  it("chooses the last part of a declared name, text or file, and never both", async () => {
    const textLast = await read(
      multipart([
        ["avatar", png()],
        ["avatar", "x"],
      ]),
      { files: FILES },
    );
    expect([textLast.get("avatar"), textLast.file("avatar")]).toEqual(["x", undefined]);
    const fileLast = await read(
      multipart([
        ["avatar", "x"],
        ["avatar", png("b.png")],
      ]),
      { files: FILES },
    );
    expect([fileLast.get("avatar"), fileLast.file("avatar")?.name]).toEqual([undefined, "b.png"]);
    const twoFiles = await read(
      multipart([
        ["avatar", png("1.png")],
        ["avatar", png("2.png")],
      ]),
      { files: FILES },
    );
    expect(twoFiles.file("avatar")?.name).toBe("2.png");
  });

  it("reads a part with an empty filename as text, as workerd parses it (Rack drops it)", async () => {
    const raw = (payload: string) =>
      post(
        `--b\r\nContent-Disposition: form-data; name="avatar"; filename=""\r\nContent-Type: image/png\r\n\r\n${payload}\r\n--b--\r\n`,
        "multipart/form-data; boundary=b",
      );
    const empty = await read(raw(""), { files: FILES });
    expect([empty.get("avatar"), empty.file("avatar")]).toEqual(["", undefined]);
    const filled = await read(raw("abc"), { files: FILES });
    expect([filled.get("avatar"), filled.file("avatar")]).toEqual(["abc", undefined]);
  });

  it("reads a query value of a declared name only when the body has none", async () => {
    const bodyWins = await read(multipart([["avatar", png()]], "?avatar=q"), { files: FILES });
    expect([bodyWins.get("avatar"), bodyWins.file("avatar")?.name]).toEqual([undefined, "a.png"]);
    const queryOnly = await read(multipart([["note", "n"]], "?avatar=q&avatar=r"), { files: FILES });
    expect([queryOnly.get("avatar"), queryOnly.file("avatar")]).toEqual(["r", undefined]);
  });

  it("ignores undeclared file parts and keeps last-wins text elsewhere", async () => {
    const p = await read(
      multipart([
        ["thumbnail", png()],
        ["note", "a"],
        ["note", "b"],
      ]),
      { files: FILES },
    );
    expect([p.file("thumbnail"), p.get("thumbnail"), p.get("note")]).toEqual([undefined, undefined, "b"]);
  });
});

describe("Params#objects with file fields", () => {
  const THUMBNAIL = { files: ["thumbnail"] };

  it("places a listed file part among the text as Rack groups it, sequential or indexed in the order sent", async () => {
    const sequential = await read(
      multipart([
        ["media_attributes[][thumbnail]", png()],
        ["media_attributes[][id]", "a"],
        ["media_attributes[][id]", "b"],
        ["media_attributes[][thumbnail]", png()],
        ["media_attributes[][thumbnail]", ""],
      ]),
    );
    expect(sequential.objects("media_attributes", THUMBNAIL)).toEqual([
      { thumbnail: SENT_FILE, id: "a" },
      { id: "b", thumbnail: SENT_FILE },
      { thumbnail: "" },
    ]);
    const indexed = await read(
      multipart([
        ["media_attributes[1][thumbnail]", png()],
        ["media_attributes[1][id]", "d"],
        ["media_attributes[0][id]", "c"],
      ]),
    );
    expect(indexed.objects("media_attributes", THUMBNAIL)).toEqual([{ thumbnail: SENT_FILE, id: "d" }, { id: "c" }]);
  });

  it("lets the last of repeated indexed parts win, file or text", async () => {
    const p = await read(
      multipart([
        ["media_attributes[0][id]", "a"],
        ["media_attributes[0][thumbnail]", png()],
        ["media_attributes[0][thumbnail]", ""],
        ["media_attributes[1][id]", "b"],
        ["media_attributes[1][thumbnail]", ""],
        ["media_attributes[1][thumbnail]", png()],
      ]),
    );
    expect(p.objects("media_attributes", THUMBNAIL)).toEqual([
      { id: "a", thumbnail: "" },
      { id: "b", thumbnail: SENT_FILE },
    ]);
  });

  it("reads no file part by default and an unlisted one as absent, keeping the objects Rack groups", async () => {
    const p = await read(
      multipart([
        ["media_attributes[][id]", png()],
        ["media_attributes[][description]", png()],
        ["media_attributes[][thumbnail]", png()],
        ["media_attributes[][id]", "a"],
      ]),
    );
    expect(p.objects("media_attributes")).toEqual([{}, { id: "a" }]);
    expect(p.objects("media_attributes", THUMBNAIL)).toEqual([{ thumbnail: SENT_FILE }, { id: "a" }]);
    // A repeated file-valued `id` starts the next object as a text one does.
    const repeated = await read(
      multipart([
        ["media_attributes[][id]", png()],
        ["media_attributes[][thumbnail]", png()],
        ["media_attributes[][id]", "A"],
      ]),
    );
    expect(repeated.objects("media_attributes", THUMBNAIL)).toEqual([{ thumbnail: SENT_FILE }, { id: "A" }]);
  });

  it("lets a later file part replace an indexed text value, which then reads as absent", async () => {
    const p = await read(
      multipart([
        ["media_attributes[0][id]", "a"],
        ["media_attributes[0][thumbnail]", png()],
        ["media_attributes[0][id]", png()],
      ]),
    );
    expect(p.objects("media_attributes", THUMBNAIL)).toEqual([{ thumbnail: SENT_FILE }]);
    // The replaced text is gone: without file fields, the object holds nothing to read.
    expect(p.objects("media_attributes")).toEqual([{}]);
  });

  it("keeps the parts through the query merge of other keys, and a JSON or urlencoded body has none", async () => {
    const merged = await read(multipart([["media_attributes[][thumbnail]", png()]], "?status=q"), { files: FILES });
    expect([merged.objects("media_attributes", THUMBNAIL), merged.get("status")]).toEqual([
      [{ thumbnail: SENT_FILE }],
      "q",
    ]);
    const body = {
      media_attributes: [
        { id: "a", thumbnail: null },
        { id: "b", thumbnail: { nested: null } },
      ],
    };
    const fromJson = await read(post(JSON.stringify(body), "application/json"));
    expect(fromJson.objects("media_attributes", THUMBNAIL)).toEqual([{ id: "a", thumbnail: "" }, { id: "b" }]);
    const form = await read(post("media_attributes[][thumbnail]=x", "application/x-www-form-urlencoded"));
    expect(form.objects("media_attributes", THUMBNAIL)).toEqual([{ thumbnail: "x" }]);
  });

  it("reads a JSON null as blank, and as not sent with nulls: absent", async () => {
    const body = {
      o: [
        { a: null, b: "1" },
        { a: "", b: null },
      ],
      s: null,
    };
    const p = await read(post(JSON.stringify(body), "application/json"));
    expect(p.get("s")).toBe("");
    expect(p.objects("o")).toEqual([
      { a: "", b: "1" },
      { a: "", b: "" },
    ]);
    expect(p.objects("o", { nulls: "absent" })).toEqual([{ b: "1" }, { a: "" }]);
    const form = await read(post("o[][a]=&o[][b]=1", "application/x-www-form-urlencoded"));
    expect(form.objects("o", { nulls: "absent" })).toEqual([{ a: "", b: "1" }]);
  });
});

describe("readParams: body and text bounds", () => {
  it("bounds a body without a file rule at its limit, declared or streamed", async () => {
    const ok = "a=".padEnd(API_BODY_LIMIT, "x");
    expect((await readParams(post(ok, "application/x-www-form-urlencoded"))).ok).toBe(true);
    expect(await readParams(post(`${ok}x`, "application/x-www-form-urlencoded"))).toEqual({ ok: false, status: 413 });
    const streamed = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`${ok}x`));
        controller.close();
      },
    });
    const request = new Request("https://kopje.test/x", {
      method: "POST",
      body: streamed,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      duplex: "half",
    } as RequestInit);
    expect(await readParams(request)).toEqual({ ok: false, status: 413 });
  });

  it("lets a file route carry its files in multipart only", () => {
    const files = { names: ["avatar", "header"], maxBytes: 8 * 1024 * 1024 };
    expect(bodyLimit("multipart/form-data; boundary=x", { files })).toBe(17_858_560);
    expect(bodyLimit("application/json", { files })).toBe(API_BODY_LIMIT);
    expect(bodyLimit("multipart/form-data; boundary=x")).toBe(API_BODY_LIMIT);
  });

  it("refuses multipart text past the limit in UTF-8 bytes, astral characters included", async () => {
    const limit = 64;
    // The name 'a' contributes 1 byte; the value contributes 63 bytes.
    const fits = await readParams(multipart([["a", "\u{1F600}".repeat(15) + "xyz"]]), { limit: 1024, files: FILES });
    expect(fits.ok).toBe(true);
    const value = "\u{1F600}".repeat(15) + "xyz"; // 63 bytes
    expect((await readParams(multipart([["a", value]]), { limit, files: FILES })).ok).toBe(true);
    expect(await readParams(multipart([["a", `${value}b`]]), { limit, files: FILES })).toEqual({
      ok: false,
      status: 413,
    });
    // Every text part counts as sent, also one a later part of its declared name replaces.
    const big = "x".repeat(2 * limit);
    expect(
      await readParams(
        multipart([
          ["avatar", big],
          ["avatar", ""],
        ]),
        { limit, files: FILES },
      ),
    ).toEqual({
      ok: false,
      status: 413,
    });
    // An empty form body still counts its query.
    const query = `?q=${"x".repeat(64)}`; // 1 + 64 bytes: one past the limit
    expect(await readParams(post("", "application/x-www-form-urlencoded", query), { limit })).toEqual({
      ok: false,
      status: 413,
    });
    expect((await readParams(post("", "application/x-www-form-urlencoded", query.slice(0, -1)), { limit })).ok).toBe(
      true,
    );
    // The query counts too.
    expect(await readParams(multipart([["a", value]], "?q=1"), { limit, files: FILES })).toEqual({
      ok: false,
      status: 413,
    });
  });
});

describe("readParams: JSON path expansion", () => {
  const json = (value: string) => post(value, "application/json");

  it("refuses an empty-object amplification before building its keys", async () => {
    const parent = "p".repeat(32 * 1024);
    const children = Array.from({ length: 50_000 }, (_, i) => `"${i}":{}`).join(",");
    const body = `{"${parent}":{${children}}}`;
    expect(body.length).toBeLessThan(API_BODY_LIMIT);
    expect(await readParams(json(body))).toEqual({ ok: false, status: 413 });
  });

  it("accepts MAX_PARAM_PATHS generated keys and refuses one more", async () => {
    // One key per member: the object `o` itself is a key, and each of its members.
    const members = (n: number) => Array.from({ length: n }, (_, i) => `"${i}":1`).join(",");
    expect((await readParams(json(`{"o":{${members(MAX_PARAM_PATHS - 1)}}}`))).ok).toBe(true);
    expect(await readParams(json(`{"o":{${members(MAX_PARAM_PATHS)}}}`))).toEqual({ ok: false, status: 413 });
  });

  it("counts a long list of scalars in code units only, so it is not refused for its length", async () => {
    const list = `{"context":[${Array.from({ length: 100_000 }, () => '"home"').join(",")}]}`;
    expect((await readParams(json(list))).ok).toBe(true);
    // 3,000 scalar items under a 1,000-character name exceed the code-unit budget.
    const name = "n".repeat(1000);
    const amplified = `{"${name}":[${Array.from({ length: 3_000 }, () => "1").join(",")}]}`;
    expect(await readParams(json(amplified))).toEqual({ ok: false, status: 413 });
  });

  it("refuses past PARAM_PATH_BUDGET code units", async () => {
    // Each member costs prefix (1) + key + 2 units; the top-level key `o` costs 0 + 1 + 2 = 3.
    const key = "k".repeat(1000);
    const per = 1 + 1000 + 2 + 4; // the key plus a 4-unit distinct suffix
    const n = Math.floor((PARAM_PATH_BUDGET - 3) / per);
    const members = (count: number) =>
      Array.from({ length: count }, (_, i) => `"${key}${String(i).padStart(4, "0")}":1`).join(",");
    const fits = await readParams(json(`{"o":{${members(n)}}}`), { limit: 4 * API_BODY_LIMIT });
    expect(fits.ok || fits.status).toBe(true);
    const over = await readParams(json(`{"o":{${members(n + 1)}}}`), { limit: 4 * API_BODY_LIMIT });
    expect(over).toEqual({ ok: false, status: 413 });
  });

  it(`accepts ${MAX_PARAM_DEPTH} levels of nesting and refuses ${MAX_PARAM_DEPTH + 1}`, async () => {
    const nested = (depth: number) => `${'{"a":'.repeat(depth)}1${"}".repeat(depth)}`;
    expect((await readParams(json(nested(MAX_PARAM_DEPTH)))).ok).toBe(true);
    expect(await readParams(json(nested(MAX_PARAM_DEPTH + 1)))).toEqual({ ok: false, status: 400 });
  });

  it("counts an empty object as sent (sentObject), not as hasObject", async () => {
    const p = await read(json('{"home":{},"fields_attributes":{"0":{}},"poll":{}}'));
    expect(p.sentObject("home")).toBe(true);
    expect(p.sentObject("fields_attributes")).toBe(true);
    expect(p.hasObject("poll")).toBe(false);
    expect(p.sentObject("notifications")).toBe(false);
  });
});

describe("Params#list", () => {
  const json = (value: unknown, query = "") => read(post(JSON.stringify(value), "application/json", query));
  const urlencoded = (value: string, query = "") => read(post(value, "application/x-www-form-urlencoded", query));

  it("reads JSON [] as an empty list and a form name[]= as one blank value, as Rails permits them", async () => {
    expect((await json({ a: [] })).list("a")).toEqual([]);
    expect((await urlencoded("a[]=")).list("a")).toEqual([""]);
    expect((await json({ a: ["1", ""] })).list("a")).toEqual(["1", ""]);
    expect((await json({})).list("a")).toBeUndefined();
    expect((await json({ a: null })).list("a")).toBeUndefined();
    // A scalar is not a list (strong parameters drop it).
    expect((await json({ a: "1" })).list("a")).toBeUndefined();
    expect((await urlencoded("a=1")).list("a")).toBeUndefined();
    // Nested names, and the query's list, which replaces the body's.
    expect((await json({ o: { a: [] } })).list("o[a]")).toEqual([]);
    expect((await json({ a: [] }, "?a[]=2")).list("a")).toEqual(["2"]);
    expect((await urlencoded("a[]=1", "?a[]=")).list("a")).toEqual([""]);
  });

  it("keeps has() and getAll() of a JSON [] as they were", async () => {
    const p = await json({ a: [] });
    expect(p.has("a")).toBe(true);
    expect(p.getAll("a")).toEqual([""]);
  });
});

describe("parseBoolean", () => {
  // ActiveModel::Type::Boolean: only these spellings are false; another case of them is true, as Rails casts it.
  it.each([
    ["0", false],
    ["f", false],
    ["F", false],
    ["false", false],
    ["FALSE", false],
    ["off", false],
    ["OFF", false],
    ["False", true],
    ["Off", true],
    ["fAlSe", true],
    ["true", true],
    ["1", true],
    [" ", true],
  ] as const)("casts %j to %s", (value, cast) => {
    expect(parseBoolean(value)).toBe(cast);
  });

  it("reads blank as absent", () => {
    expect(parseBoolean("")).toBeUndefined();
    expect(parseBoolean(undefined)).toBeUndefined();
  });
});

// One request per source for the same raw pairs: a GET's query, the query of a JSON request, a urlencoded body, and a
// multipart body when every pair has a value and no `%`.
function sources(raw: string): [string, Request][] {
  const list: [string, Request][] = [
    ["a GET's query", new Request(`https://kopje.test/x?${raw}`)],
    ["a JSON request's query", post("{}", "application/json", `?${raw}`)],
    ["a urlencoded body", post(raw, "application/x-www-form-urlencoded")],
  ];
  const parts = raw.split("&");
  if (!raw.includes("%") && parts.every((part) => part.includes("="))) {
    const pairs = parts.map((part): [string, string] => [
      part.slice(0, part.indexOf("=")),
      part.slice(part.indexOf("=") + 1),
    ]);
    list.push(["a multipart body", multipart(pairs)]);
  }
  return list;
}

// PT1. Rack (in a middleware) and then Rails (in the controller) nest each source's pairs in order
// (platform/rails-params.ts): a name nested as two kinds, by any key the route reads or not, refuses the request; a
// later plain name replaces what an earlier one built under it, and no accessor reads what it replaced.
describe("readParams: the shapes of one source, in Rack's order", () => {
  const refused = [
    "limit=1&limit[]=2",
    "a=1&a[b]=2",
    "a[]=1&a[b]=2",
    "a[b]=1&a[]=2",
    "unread=1&unread[x]=2",
    "a[b]=1&a[b][c]=2",
    "a[b][]=1&a[b][c]=2",
    "a[][b]=1&a[][b][c]=2",
    `a${"[b]".repeat(32)}=1`,
  ];
  it.each(refused)("refuses %j from every source", async (raw) => {
    for (const [source, request] of sources(raw)) {
      expect([source, await readParams(request)]).toEqual([source, { ok: false, status: 400 }]);
    }
  });

  // Rack keeps the nil `a[]` pushes, so its last item is no Hash and `[b][c]` starts a new one; Rails drops it and
  // refuses `[b][c]` under the kept `b`. A bad `%`, and a key or a value that is not UTF-8 (nested values too: Rails
  // checks each pair's value), refuse as well.
  it.each(["a[][b]=1&a[]&a[][b][c]=2", "a=%ZZ", "a[%2]=1", "a=%FF", "%FF=1", "a[b]=%FF", "a[%FF]=1"])(
    "refuses %j from a query or a urlencoded body",
    async (raw) => {
      for (const [source, request] of sources(raw)) {
        expect([source, await readParams(request)]).toEqual([source, { ok: false, status: 400 }]);
      }
    },
  );

  it("reads what the last plain name assigned, and nothing it replaced", async () => {
    for (const [source, request] of sources("limit[]=2&limit[]=3&limit=1")) {
      const p = await read(request);
      expect([source, p.get("limit"), p.integer("limit"), p.list("limit"), p.getAll("limit")]).toEqual([
        source,
        "1",
        "1",
        undefined,
        ["1"],
      ]);
      expect([p.getAllIntegers("limit"), p.has("limit"), p.entries]).toEqual([["1"], true, [["limit", "1"]]]);
    }
    for (const [source, request] of sources("a[b]=1&a[c][]=2&a=3&p[o][]=1&p[o]=x")) {
      const p = await read(request);
      expect([source, p.get("a"), p.get("a[b]"), p.list("a[c]"), p.hasObject("a"), p.sentObject("a")]).toEqual([
        source,
        "3",
        undefined,
        undefined,
        false,
        false,
      ]);
      expect([p.get("p[o]"), p.list("p[o]"), p.hasObject("p"), p.objects("a")]).toEqual(["x", undefined, true, []]);
    }
  });

  it("reuses an array's last Hash for a field it lacks, as Rack does", async () => {
    for (const [source, request] of sources("o[][a]=1&o[][b]=2&o[][a]=3&o[][c]=4")) {
      const p = await read(request);
      expect([source, p.objects("o")]).toEqual([
        source,
        [
          { a: "1", b: "2" },
          { a: "3", c: "4" },
        ],
      ]);
    }
  });

  // As Rails' strong parameters permit them: an object's field holding a Hash or an Array is not read, but it still
  // took its place in the object, so a later `y` starts the next one; a field may be named as any property of a
  // JavaScript object.
  it("reads an array's objects with the boundaries of its tree", async () => {
    const raw =
      "a[][x]=1&a[][x]=2&a[][y][z]=3&a[][y]=4&a[][constructor]=c&a[][constructor]=d&a[][__proto__]=p&a[][x]]=m";
    for (const [source, request] of sources(raw)) {
      const p = await read(request);
      expect([source, p.objects("a").map((object) => Object.entries(object))]).toEqual([
        source,
        [
          [["x", "1"]],
          [["x", "2"]],
          [
            ["y", "4"],
            ["constructor", "c"],
          ],
          [
            ["constructor", "d"],
            ["__proto__", "p"],
          ],
        ],
      ]);
    }
  });

  it("reads each source's last value of a repeated name, and counts the repeat", async () => {
    for (const [source, request] of sources("a=1&a=2&n[x]=1&n[x]=2")) {
      const p = await read(request);
      expect([source, p.get("a"), p.get("n[x]"), p.repeated(["a"]), p.entries]).toEqual([
        source,
        "2",
        "2",
        "a",
        [
          ["a", "2"],
          ["n[x]", "2"],
        ],
      ]);
    }
  });

  it(`reads a nesting ${MAX_PARAM_DEPTH - 1} deep`, async () => {
    const name = `a${"[b]".repeat(MAX_PARAM_DEPTH - 1)}`;
    for (const [source, request] of sources(`${name}=1`)) {
      expect([source, (await read(request)).get(name)]).toEqual([source, "1"]);
    }
  });

  // Without `=`, a value is nil: read as blank and marked as a JSON null is; `name[]` alone is an empty list, as deep
  // munge drops the nil it pushes.
  it("reads nil and empty values as Rails holds them", async () => {
    for (const [source, request] of sources("a&b=&c[]&d[]=&e[x]&f[]&f[]=1&g[][b]=1&g[]&g[][c]=2")) {
      const p = await read(request);
      expect([source, p.get("a"), p.sentNull("a"), p.get("b"), p.sentNull("b")]).toEqual([source, "", true, "", false]);
      expect([p.list("c"), p.list("d"), p.get("e[x]"), p.sentNull("e[x]"), p.sentObject("e")]).toEqual([
        [],
        [""],
        "",
        true,
        true,
      ]);
      expect([p.list("f"), p.objects("g")]).toEqual([["1"], [{ b: "1", c: "2" }]]);
    }
  });

  // Rack parts a form body's fields at an `&` and the spaces after it, and drops one NUL that ends it.
  it("reads a urlencoded body's fields as Rack parts them", async () => {
    const p = await read(post("a=1&  b=2&c=3\0", "application/x-www-form-urlencoded"));
    expect([p.get("b"), p.get(" b"), p.get("c")]).toEqual(["2", undefined, "3"]);
  });
});

// Rack's limits on a multipart body's parts, and the form it reads a POST body without a media type as.
describe("readParams: Rack's multipart limits and untyped forms", () => {
  it("reads 4,095 parts and 127 file parts, and refuses one more of either", async () => {
    const parts = (count: number, files: number) =>
      Array.from({ length: count }, (_, i): [string, string | File] => [`p${i}`, i < files ? png() : "x"]);
    const answers = [];
    for (const [count, files] of [
      [MULTIPART_PARTS - 1, 0],
      [MULTIPART_PARTS, 0],
      [MULTIPART_FILES - 1, MULTIPART_FILES - 1],
      [MULTIPART_FILES, MULTIPART_FILES],
    ] as const) {
      const result = await readParams(multipart(parts(count, files)));
      answers.push(result.ok || result.status);
    }
    expect(answers).toEqual([true, 400, true, 400]);
  });

  // Request#form_data?: a POST whose media type is missing or empty; a body sent as bytes has no Content-Type.
  it("reads a POST body without a media type as a urlencoded form, and no other method's", async () => {
    const untyped = (method: string, body: string) =>
      new Request("https://kopje.test/x", { method, body: new TextEncoder().encode(body) });
    const p = await read(untyped("POST", "a=1&b[]=2"));
    expect([p.get("a"), p.list("b")]).toEqual(["1", ["2"]]);
    expect(await readParams(untyped("POST", "a=1&a[]=2"))).toEqual({ ok: false, status: 400 });
    expect((await read(untyped("PUT", "a=1"))).get("a")).toBeUndefined();
  });
});

// PT2. Rails merges the query over the body by top-level key (Params#withQuery): of a name both send, every encoding
// keeps the query's whole value, whatever kind each source's is, and none of what the body noted under it.
describe("readParams: one source's value of a top-level key, after the merge", () => {
  const bodies = (fields: [string, string][], json: unknown, query: string): [string, Request][] => [
    ["urlencoded", post(new URLSearchParams(fields).toString(), "application/x-www-form-urlencoded", query)],
    ["multipart", multipart(fields, query)],
    ["JSON", post(JSON.stringify(json), "application/json", query)],
  ];

  it("keeps the query's array over the body's, of any encoding", async () => {
    const body = bodies(
      [
        ["ids[]", "b1"],
        ["ids[]", "b2"],
      ],
      { ids: ["b1", "b2"] },
      "?ids[]=q",
    );
    for (const [encoding, request] of body) {
      const p = await read(request);
      expect([encoding, p.list("ids"), p.getAll("ids")]).toEqual([encoding, ["q"], ["q"]]);
    }
  });

  it("keeps a query value of another kind than the body's", async () => {
    for (const [encoding, request] of bodies([["ids[]", "1"]], { ids: ["1"] }, "?ids=x")) {
      const p = await read(request);
      expect([encoding, p.get("ids"), p.list("ids")]).toEqual([encoding, "x", undefined]);
    }
    for (const [encoding, request] of bodies([["ids", "x"]], { ids: "x" }, "?ids[]=1")) {
      const p = await read(request);
      expect([encoding, p.get("ids"), p.list("ids")]).toEqual([encoding, undefined, ["1"]]);
    }
    for (const [encoding, request] of bodies([["note", "x"]], { note: "x" }, "?note")) {
      const p = await read(request);
      expect([encoding, p.get("note"), p.sentNull("note")]).toEqual([encoding, "", true]);
    }
  });

  it("reads a JSON number by its to_i beside a query, and a query's text over it", async () => {
    const positive = await read(post('{"limit":1.9}', "application/json", "?x=1"));
    const negative = await read(post('{"limit":-1.9}', "application/json", "?x=1"));
    const replaced = await read(post('{"limit":5}', "application/json", "?limit=1.9"));
    expect([positive.integer("limit"), negative.integer("limit"), replaced.integer("limit")]).toEqual([
      "1",
      "-1",
      "1.9",
    ]);
    expect([limitParam(positive, 20, 40), limitParam(negative, 20, 40), limitParam(replaced, 20, 40)]).toEqual([
      1, 1, 1,
    ]);
  });
});

// PT3. The OAuth reads: a value a later one of the same source replaced still counts as a repeat (RFC 6749 §3.1,
// §3.2), and a bodyOnly read takes no value from the query, whose shape is still checked.
describe("readParams: repeats and bodyOnly", () => {
  it("counts a repeat within a form body or the query", async () => {
    const requests: [string, Request][] = [
      ["urlencoded", post("code=a&code=b", "application/x-www-form-urlencoded")],
      [
        "multipart",
        multipart([
          ["code", "a"],
          ["code", "b"],
        ]),
      ],
      ["query", post("grant_type=x", "application/x-www-form-urlencoded", "?code=a&code=b")],
    ];
    for (const [source, request] of requests) {
      const p = await read(request);
      expect([source, p.get("code"), p.repeated(["grant_type", "code"])]).toEqual([source, "b", "code"]);
    }
    const single = await read(post("code=a&grant_type=x", "application/x-www-form-urlencoded"));
    expect(single.repeated(["grant_type", "code"])).toBeUndefined();
    // Each time a plain name is sent counts, also where a pair nested under it came between and the later one replaced
    // what it built.
    for (const [source, request] of sources("code&code[x]=v&code=last&grant_type&grant_type[x]=v&grant_type=g")) {
      const p = await read(request);
      expect([source, p.get("code"), p.repeated(["code"]), p.repeated(["grant_type"])]).toEqual([
        source,
        "last",
        "code",
        "grant_type",
      ]);
    }
  });

  it("reads no query value with bodyOnly, and refuses a query Rack refuses", async () => {
    const p = await read(post("client_id=c", "application/x-www-form-urlencoded", "?token=t&client_id=q"), {
      bodyOnly: true,
    });
    expect([p.get("token"), p.get("client_id"), p.repeated(["client_id"])]).toEqual([undefined, "c", undefined]);
    const malformed = post("client_id=c", "application/x-www-form-urlencoded", "?token=t&token[]=u");
    expect(await readParams(malformed, { bodyOnly: true })).toEqual({ ok: false, status: 400 });
  });
});
