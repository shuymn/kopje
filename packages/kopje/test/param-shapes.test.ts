import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import {
  API_BODY_LIMIT,
  MAX_PARAM_DEPTH,
  MAX_PARAM_PATHS,
  PARAM_PATH_BUDGET,
  readParams,
} from "../src/mastodon/params";
import { originalKey } from "../src/platform/media-files";
import { bearer, sql } from "./api-helpers";
import { PNG_PLAIN } from "./fixtures/images";
import { bytes, TestCodec } from "./media-helpers";
import { community, getJson } from "./status-helpers";

// Rack's limits on a query and a urlencoded body (platform/rails-params.ts): 4 MiB and 4,096 fields.
const RACK_BYTES = 4194304;
const RACK_FIELDS = 4096;
// A pair's deepest name: a top-level key and MAX_PARAM_DEPTH - 1 nested keys, the most Rack reads.
const BRACKETS = MAX_PARAM_DEPTH - 1;

// Pairs whose tree, as Rack and as Rails build it (each on its own budget), is charged exactly `paths` paths and
// `units` code units, as params.ts charges them: each key the tree builds or assigns is a path, charged its parent's
// name length in bracket form, its own length and 2. A pair of a fresh top-level key of length L and BRACKETS nested
// one-character keys builds BRACKETS + 1 keys, charged (L + 2) + Σ_{d=1..BRACKETS} (L + 3d) units; the remainder of
// `paths` is one shallower pair, and the remainder of `units` lengthens the last deepest key, which adds as many
// units and no path.
function capped(paths: number, units: number): string[] {
  const per = BRACKETS + 1;
  const deep = Math.floor(paths / per);
  const rest = paths % per;
  const cost = (length: number, brackets: number) =>
    length + 2 + brackets * length + (3 * brackets * (brackets + 1)) / 2;
  const shallow = rest === 0 ? 0 : cost(2, rest - 1);
  const fixed = deep * cost(0, BRACKETS) + shallow;
  const length = Math.floor((units - fixed) / (deep * per));
  const spare = units - fixed - deep * per * length;
  const pairs = Array.from({ length: deep }, (_, i) => {
    const leaf = i === deep - 1 ? `x${"y".repeat(spare)}` : "x";
    return `t${String(i).padStart(length - 1, "0")}${"[x]".repeat(BRACKETS - 1)}[${leaf}]=1`;
  });
  return rest === 0 ? pairs : [...pairs, `u0${"[x]".repeat(rest - 1)}=1`];
}

// `count` fields with an empty name, which neither parser nests or charges, `bytes` long once joined by `&`: their
// values `%41` escapes where they fit, the most decoding work a byte asks.
function filler(count: number, bytes: number): string[] {
  const total = bytes - 2 * count + 1;
  const each = Math.floor(total / count);
  return Array.from({ length: count }, (_, i) => {
    const size = each + (i === count - 1 ? total - each * count : 0);
    return `=${"%41".repeat(Math.floor(size / 3))}${"A".repeat(size % 3)}`;
  });
}

// `count` pairs `length` long, each through an array's last Hash at every level but the last of the deepest nesting
// Rack reads (`a[][b][][b]…[k]`: store takes a key and the `[]` after it in one level, so the bottom key `[k]` is
// level BRACKETS), which Rack and Rails reuse, so each pair is walked through every level and adds one new key at the
// bottom, charged alone: the most nesting work per path and code unit charged.
function reused(count: number, length: number): string[] {
  const stem = `a${"[][b]".repeat(BRACKETS - 1)}`;
  return Array.from({ length: count }, (_, i) => `${stem}[${String(i).padStart(length - stem.length - 4, "k")}]=1`);
}

const query = (pairs: string[]) => new Request(`https://kopje.test/x?${pairs.join("&")}`);

function urlencoded(body: string, init: RequestInit = {}): RequestInit {
  return { ...init, method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } };
}

// RES-1: the query's and a form body's trees are charged before each key is built or assigned, at most
// MAX_PARAM_PATHS paths and PARAM_PATH_BUDGET code units each, at the deepest nesting Rack reads.
describe("the parameter trees at their bounds", () => {
  it("reads a tree at both caps and the deepest nesting, and refuses one path or one unit more", async () => {
    const at = capped(MAX_PARAM_PATHS, PARAM_PATH_BUDGET);
    expect([at.length, at[0]!.split("[").length - 1]).toEqual([313, BRACKETS]);
    const unit = capped(MAX_PARAM_PATHS, PARAM_PATH_BUDGET + 1);
    const slack = capped(MAX_PARAM_PATHS, PARAM_PATH_BUDGET - 3);
    // `z=1` is one path of 3 units.
    const path = [...slack, "z=1"];
    const answers = [];
    for (const pairs of [at, unit, slack, path]) {
      const asQuery = await readParams(query(pairs));
      const asBody = await readParams(new Request("https://kopje.test/x", urlencoded(pairs.join("&"))));
      answers.push([asQuery.ok || asQuery.status, asBody.ok || asBody.status]);
    }
    expect(answers).toEqual([
      [true, true],
      [413, 413],
      [true, true],
      [413, 413],
    ]);
    const read = await readParams(query(at));
    expect(read.ok && read.params.get(at[0]!.slice(0, -2))).toBe("1");
  });

  // The reuse shape of the time witness is at the deepest nesting too: one more `[][b]` refuses it.
  it("refuses a nesting past the deepest Rack reads, and Rack's field and byte limits", async () => {
    const [deepest = ""] = reused(1, 160);
    const forms = [
      [`a${"[x]".repeat(BRACKETS + 1)}=1`],
      [deepest],
      [`a[][b]${deepest.slice(1)}`],
      filler(RACK_FIELDS, RACK_BYTES),
      filler(RACK_FIELDS + 1, RACK_BYTES),
      filler(RACK_FIELDS, RACK_BYTES + 1),
    ];
    const answers = [];
    for (const pairs of forms) {
      const result = await readParams(query(pairs));
      answers.push([pairs.length, pairs.join("&").length, result.ok || result.status]);
    }
    expect(answers).toEqual([
      [1, forms[0]![0]!.length, 400],
      [1, 160, true],
      [1, 165, 400],
      [RACK_FIELDS, RACK_BYTES, true],
      [RACK_FIELDS + 1, RACK_BYTES, 400],
      [RACK_FIELDS, RACK_BYTES + 1, 400],
    ]);
  });
});

// Through the route gates: a malformed shape is the route's 400 before its handler runs, the last plain name is what
// it reads, and the work of reading every source at its caps stays within a generous time, for a request without a
// token (the public timeline reads its parameters before any token) and a body route.
describe("parameter shapes at the API's routes", () => {
  const GENEROUS_MS = 2_000;

  it("answers a shape Rack refuses with 400, and reads the last plain name", async () => {
    const h = await community(["alice"]);
    const alice = h.users.alice;
    const refused = await h.request("/api/v1/lists", bearer(alice.token, urlencoded("title=a&title[]=b")));
    expect([refused.status, await getJson(h, "/api/v1/lists", alice.token)]).toEqual([400, { status: 200, body: [] }]);
    const read = await h.request("/api/v1/lists", bearer(alice.token, urlencoded("title[]=b&title=a")));
    expect([read.status, (await read.json<{ title: string }>()).title]).toEqual([200, "a"]);
    const timeline = await h.request("/api/v1/timelines/public?limit=1&limit[]=2");
    const kept = await h.request("/api/v1/timelines/public?limit[]=2&limit=1");
    expect([timeline.status, kept.status]).toEqual([400, 200]);
  });

  // Two shapes each: a tree at both caps, the rest of the fields and bytes filled with `%41` escapes; and the most
  // nesting work per charged unit, every pair walked through the deepest nesting and charged its one new key.
  it("reads a query at Rack's limits and both caps within a generous time, before any token", async () => {
    const h = await community(["alice"]);
    const tree = capped(MAX_PARAM_PATHS, PARAM_PATH_BUDGET);
    const head = tree.join("&").length + 1;
    const filled = [...tree, ...filler(RACK_FIELDS - tree.length, RACK_BYTES - head)];
    const shapes = [filled, reused(RACK_FIELDS, 512)];
    expect(shapes.map((pairs) => [pairs.length, pairs.join("&").length])).toEqual([
      [RACK_FIELDS, RACK_BYTES],
      [RACK_FIELDS, RACK_FIELDS * 513 - 1],
    ]);
    for (const pairs of shapes) {
      const start = performance.now();
      const answer = await h.request(`/api/v1/timelines/public?${pairs.join("&")}`);
      const elapsed = performance.now() - start;
      expect([answer.status, elapsed < GENEROUS_MS]).toEqual([200, true]);
    }
    // One field more, or one code unit more a key, refuses each.
    const over = [
      await h.request(`/api/v1/timelines/public?${filled.join("&")}&z`),
      await h.request(`/api/v1/timelines/public?${reused(RACK_FIELDS, 513).join("&")}`),
    ];
    expect(over.map((answer) => answer.status)).toEqual([400, 413]);
  });

  it("reads a form body at its limit and both caps within a generous time", async () => {
    const h = await community(["alice"]);
    const alice = h.users.alice;
    const tree = capped(MAX_PARAM_PATHS, PARAM_PATH_BUDGET);
    const head = tree.join("&").length + 1;
    const filled = [...tree, ...filler(RACK_FIELDS - tree.length, API_BODY_LIMIT - head)];
    const shapes = [filled, reused(RACK_FIELDS, Math.floor((API_BODY_LIMIT + 1) / RACK_FIELDS) - 1)];
    expect(shapes.map((pairs) => [pairs.length, pairs.join("&").length])).toEqual([
      [RACK_FIELDS, API_BODY_LIMIT],
      [RACK_FIELDS, API_BODY_LIMIT - 1],
    ]);
    for (const pairs of shapes) {
      const start = performance.now();
      const answer = await h.request("/api/v1/lists?title=witness", bearer(alice.token, urlencoded(pairs.join("&"))));
      const elapsed = performance.now() - start;
      expect([answer.status, (await answer.json<{ title: string }>()).title, elapsed < GENEROUS_MS]).toEqual([
        200,
        "witness",
        true,
      ]);
    }
  });

  // A profile image's data URI at the body bound (mastodon/accounts.ts profileFiles, platform/data-uri.ts): a prefix
  // that fails after a run of type characters, one that fails after the subtype's, a payload decoded whole, which is
  // no image, and a PNG without padding spread over the bound by the spaces the decoder skips, whose last group of
  // three sextets (the end of IEND's CRC) is decoded only at the end of the value.
  it("recognizes and decodes a data URI at the text bound within its time bound", async () => {
    const h = await community(["alice"], undefined, { images: () => new TestCodec() });
    const prefix = "data:image/png;base64,";
    // `{"avatar":""}` is 13 bytes.
    const room = API_BODY_LIMIT - 13 - prefix.length;
    const fill = (start: string, unit: string) => `${start}${unit.repeat(API_BODY_LIMIT - 13 - start.length)}`;
    const unpadded = PNG_PLAIN.replace(/=+$/, "");
    expect(unpadded.length % 4).toBe(3);
    const gap = Math.floor((room - unpadded.length) / unpadded.length);
    const spread = [...unpadded].map((c) => `${" ".repeat(gap)}${c}`).join("");
    const png = `${prefix}${" ".repeat(room - spread.length)}${spread}`;
    const values = [fill("data:", "a"), fill("data:a/", "a"), fill(prefix, "A"), png];
    const answers = [];
    for (const avatar of values) {
      const body = JSON.stringify({ avatar });
      const start = performance.now();
      const answer = await h.request(
        "/api/v1/accounts/update_credentials",
        bearer(h.users.alice.token, {
          method: "PATCH",
          body,
          headers: { "content-type": "application/json" },
        }),
      );
      const elapsed = performance.now() - start;
      answers.push([body.length, answer.status, elapsed < GENEROUS_MS]);
    }
    expect(answers).toEqual([
      [API_BODY_LIMIT, 400, true],
      [API_BODY_LIMIT, 400, true],
      [API_BODY_LIMIT, 422, true],
      [API_BODY_LIMIT, 200, true],
    ]);
    // The PNG's bytes to the last, as uploaded (`originals/<id>` keeps them).
    const [set] = await sql<{ id: string }>(
      h.store,
      "SELECT m.id FROM media_attachments m JOIN accounts a ON m.url = a.avatar_url WHERE a.username = 'alice'",
    );
    const original = await env.MEDIA.get(originalKey(set!.id));
    expect(new Uint8Array(await original!.arrayBuffer())).toEqual(bytes(PNG_PLAIN));
  });
});
