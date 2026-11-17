import { describe, expect, it } from "vitest";

import { parseActivity } from "../src/federation/inbound";
import { INBOX_BODY_LIMIT } from "../src/federation/spool";
import { handleQueue } from "../src/jobs/queue";
import { jsonRefusal, jsonTextMalformed, MAX_JSON_NODES } from "../src/platform/json-bounds";
import { sql } from "./api-helpers";
import { harness, inboxDeps, NOW } from "./app-helpers";
import { fixtureKeyGen } from "./federation-helpers";
import { BUILD } from "./helpers";
import { AP, LOCAL, mastodonActor, signedInit } from "./inbox-helpers";
import { AS, like, localStatus, type Setup, setup, undo } from "./inbox-status-helpers";

// #1718: an inbound activity whose JSON text holds a string token, a key or a value, with an unpaired surrogate is JSON
// that does not parse (src/platform/json-bounds.ts; docs/mastodon-deviations.md, "Reading inbound activities"; RES-2),
// one a later duplicate key replaces included. Mastodon 4.7.5's JSON.parse (json 2.21.2) raises on a high surrogate
// escape not followed by a low one; Kopje also refuses a lone low one, which that parser keeps as invalid UTF-8.
// JSON.stringify writes a lone surrogate as its \u escape, so every body here carries the escape on the wire.

type Json = Record<string, unknown>;

// A body given as text is sent as it is.
const bytes = (json: unknown) => new TextEncoder().encode(typeof json === "string" ? json : JSON.stringify(json));

// The body's text with a member "junk" holding `escape`, which a later "junk":"ok" replaces: JSON.parse keeps "ok", so
// the parsed value holds no unpaired surrogate, where Mastodon's parser refuses the text
// (test-node/json-bounds.test.ts).
const hidden = (body: Json, escape: string) =>
  JSON.stringify({ ...body, junk: "ok" }).replace(`"junk":"ok"`, `"junk":"${escape}","junk":"ok"`);

// What parseActivity decides, as text: an assertion that printed the parsed body would hand its lone surrogate to the
// test runner, whose WebSocket refuses it as invalid UTF-8 and loses the failure.
async function outcome(json: unknown): Promise<string> {
  const parsed = await parseActivity(bytes(json));
  return parsed.ok ? `ok ${parsed.activity.type}` : parsed.reason;
}

// An unsigned Like from a remote actor, read by parseActivity alone.
const REMOTE_ACTOR = "https://remote.example/users/bob";
const remoteLike = (extra: Json = {}): Json => ({
  "@context": AS,
  id: "https://remote.example/likes/1",
  type: "Like",
  actor: REMOTE_ACTOR,
  object: `${LOCAL}/ap/o/1`,
  ...extra,
});

const favourites = async (t: Setup) =>
  (await sql<{ n: number }>(t.store, "SELECT count(*) AS n FROM favourites"))[0]!.n;

// The values that make a body malformed (each written as an escape by JSON.stringify), and well-formed controls.
const MALFORMED: [string, (value: Json) => Json][] = [
  ["a lone high surrogate", (body) => ({ ...body, junk: "\ud800" })],
  ["a lone low surrogate", (body) => ({ ...body, junk: "\udc00" })],
  ["a high surrogate before another character", (body) => ({ ...body, junk: "\ud800A" })],
  ["two high surrogates", (body) => ({ ...body, junk: "\ud800\ud800" })],
  ["a key holding a high surrogate", (body) => ({ ...body, "\ud800": 1 })],
  ["an array element holding a high surrogate", (body) => ({ ...body, junk: ["ok", "\ud800"] })],
  ["a nested member holding a lone low surrogate", (body) => ({ ...body, junk: { deep: [{ x: "a\udc00" }] } })],
];
const WELL_FORMED: [string, (value: Json) => Json][] = [
  ["a surrogate pair", (body) => ({ ...body, junk: "\ud800\udc00" })],
  ["an astral character", (body) => ({ ...body, junk: "😀" })],
  ["a key holding an astral character", (body) => ({ ...body, "😀": 1 })],
];

describe("an inbound activity with an unpaired surrogate (#1718)", () => {
  it("refuses an Undo of a Like with one in a member no reader reads, and applies it with a valid pair", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const status = await localStatus(t, { status: "liked", visibility: "public" });
    const liked = like(bob, status.uri);
    expect(await t.post(bob, liked)).toBe(202);
    expect(await favourites(t)).toBe(1);

    // Signed with bob's stored key: answered 202 as a body JSON.parse refuses is, and nothing reaches the Store.
    const broken = { ...undo(bob, liked.id), junk: "\ud800" };
    expect(JSON.stringify(broken)).toContain(String.raw`"junk":"\ud800"`);
    expect(await outcome(broken)).toBe("invalid-json");
    expect(await t.post(bob, broken)).toBe(202);
    expect(await favourites(t)).toBe(1);

    const control = { ...undo(bob, liked.id), junk: "😀" };
    expect(await outcome(control)).toBe("ok Undo");
    expect(await t.post(bob, control)).toBe(202);
    expect(await favourites(t)).toBe(0);
  });

  it("refuses an Undo whose unpaired surrogate a duplicate key hides, and applies one hiding a pair", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const status = await localStatus(t, { status: "liked", visibility: "public" });
    const liked = like(bob, status.uri);
    expect(await t.post(bob, liked)).toBe(202);

    const broken = hidden(undo(bob, liked.id), String.raw`\ud800`);
    expect(jsonRefusal(JSON.parse(broken))).toBeNull();
    expect(await outcome(broken)).toBe("invalid-json");
    expect(await t.post(bob, broken)).toBe(202);
    expect(await favourites(t)).toBe(1);

    const control = hidden(undo(bob, liked.id), String.raw`\ud83d\ude00`);
    expect(await outcome(control)).toBe("ok Undo");
    expect(await t.post(bob, control)).toBe(202);
    expect(await favourites(t)).toBe(0);
  });

  it.each([
    ["a lone high surrogate", String.raw`\ud800`],
    ["a lone low surrogate", String.raw`\udc00`],
    ["a high surrogate before another escape", String.raw`\ud800\u0041`],
  ])("refuses %s in a member a later duplicate key replaces as invalid JSON", async (_, escape) => {
    expect(await outcome(hidden(remoteLike(), String.raw`\ud83d\ude00`))).toBe("ok Like");
    expect(await outcome(hidden(remoteLike(), escape))).toBe("invalid-json");
    const nested = JSON.stringify(remoteLike({ junk: "ok" })).replace(`"junk":"ok"`, `"junk":["${escape}"],"junk":[]`);
    expect(await outcome(nested)).toBe("invalid-json");
  });

  it.each(MALFORMED)("refuses %s as invalid JSON", async (_, shape) => {
    const base = remoteLike();
    expect(await outcome(base)).toBe("ok Like");
    expect(await outcome(shape(base))).toBe("invalid-json");
  });

  it.each(WELL_FORMED)("reads %s", async (_, shape) => {
    expect(await outcome(shape(remoteLike()))).toBe("ok Like");
  });

  it("refuses a malformed body that is not an object as invalid JSON, before the object check", async () => {
    expect(await outcome(["\ud800"])).toBe("invalid-json");
    expect(await outcome(["😀"])).toBe("not-an-object");
  });

  // The refusal runs before the reading of an LD-signed body (ld-signed-body.ts, ldSignedReading), whose rules would
  // otherwise ignore this body for its compact-IRI key (rule 3).
  it("refuses an LD-signed body as invalid JSON before its vocabulary rules read it", async () => {
    const signature = { type: "RsaSignature2017", creator: `${REMOTE_ACTOR}#main-key`, signatureValue: "placeholder" };
    const signed = remoteLike({ signature });
    expect(await outcome(signed)).toBe("ok Like");
    expect(await outcome({ ...signed, "x:a": 1 })).toBe("ld-context");
    expect(await outcome({ ...signed, "x:\ud800": 1 })).toBe("invalid-json");
    expect(await outcome({ ...signed, signature: { ...signature, signatureValue: "\udc00" } })).toBe("invalid-json");
    expect(await outcome(hidden(signed, String.raw`\ud800`))).toBe("invalid-json");
  });

  it("refuses a spooled activity holding one on replay, and applies its well-formed copy", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const status = await localStatus(t, { status: "liked", visibility: "public" });
    const maintenance = harness(t.store, { MAINTENANCE: "readonly" }, BUILD, {
      keygen: fixtureKeyGen,
      loader: t.web.loader,
    });
    const spool = async (body: Json | string) =>
      (await maintenance.request("/inbox", await signedInit(bob, "/inbox", body, { at: NOW }))).status;
    const broken = like(bob, status.uri, { junk: "\ud800" });
    const control = like(bob, status.uri, { junk: "😀" });
    expect(await spool(broken)).toBe(202);
    expect(await spool(hidden(like(bob, status.uri), String.raw`\ud800`))).toBe(202);
    expect(await spool(control)).toBe(202);
    const deps = { ...inboxDeps(() => t.store, t.web.loader), now: () => NOW };
    await maintenance.queue.deliver((batch) =>
      handleQueue(batch, { ...maintenance.env, MAINTENANCE: "off" } as Env, deps),
    );
    expect(await sql(t.store, "SELECT uri FROM favourite_likes")).toEqual([{ uri: control.id }]);
  });
});

// C5, RES-2: the inbox reads the body before any signature is verified, so the check's added work (one pass over the
// text, then one over each string and key of the parsed value) is timed through the real gate, unsigned, on a body at
// INBOX_BODY_LIMIT bytes and MAX_JSON_NODES values. Each string is a run of surrogate pair escapes after ASCII fill:
// the text pass reads every code unit and decodes each escape, the most work per byte it has, and the parsed strings
// are held as UTF-16 and checked to their end. The broken body ends its last string, the last token the text pass
// reads, with a lone high surrogate escape in place of the pair's last 6 bytes.
describe("the unpaired surrogate check at the body bounds", () => {
  const GENEROUS_MS = 1_000;
  const PAIR = String.raw`\ud83d\ude00`;
  const envelope = remoteLike();
  // The root and its members are values too.
  const count = MAX_JSON_NODES - 1 - Object.keys(envelope).length - 1;
  const head = `${JSON.stringify(envelope).slice(0, -1)},"x":[`;
  // The quotes of each string and the commas between them.
  const room = INBOX_BODY_LIMIT - head.length - "]}".length - count * 3 + 1;
  const contents = (n: number) => "a".repeat(n % PAIR.length) + PAIR.repeat(Math.floor(n / PAIR.length));
  const strings = Array.from({ length: count }, (_, i) =>
    contents(Math.floor(room / count) + (i === count - 1 ? room % count : 0)),
  );
  const text = (all: string[]) => `${head}${all.map((c) => `"${c}"`).join(",")}]}`;
  const filled = text(strings);
  const broken = text([...strings.slice(0, -1), `${strings.at(-1)!.slice(0, -PAIR.length)}aaaaaa\\ud83d`]);

  it("holds both bodies at the bounds, and refuses only the broken one", async () => {
    for (const body of [filled, broken]) {
      expect(bytes(body).byteLength).toBe(INBOX_BODY_LIMIT);
    }
    expect(jsonTextMalformed(filled)).toBe(false);
    expect(jsonRefusal(JSON.parse(filled))).toBeNull();
    expect(jsonRefusal({ ...(JSON.parse(filled) as Json), y: 0 })).toBe("too-complex");
    expect(jsonTextMalformed(broken)).toBe(true);
    expect(jsonTextMalformed(`${broken.slice(0, -9)}"]}`)).toBe(false);
    expect(await outcome(filled)).toBe("ok Like");
    expect(await outcome(broken)).toBe("invalid-json");
  });

  it.each([
    ["a well-formed body", filled],
    ["a body broken in the last string token", broken],
  ])("answers %s within a generous time", async (_, body) => {
    const t = await setup();
    const started = performance.now();
    const response = await t.request("/inbox", { method: "POST", headers: { "content-type": AP }, body: bytes(body) });
    const elapsed = performance.now() - started;
    expect(response.status).toBe(401);
    expect(elapsed).toBeLessThan(GENEROUS_MS);
  });
});

// #1718's check on a parsed value relies on String.prototype.isWellFormed (ES2024), which the Workers runtime provides;
// the Node side is test-node/json-bounds.test.ts.
describe("the Workers runtime", () => {
  it("has String.prototype.isWellFormed, which tells an unpaired surrogate from a pair", () => {
    expect(typeof String.prototype.isWellFormed).toBe("function");
    expect(["\ud800", "\udc00", "\ud800A", "\ud800\ud800"].map((s) => s.isWellFormed())).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(["\ud800\udc00", "😀", "", "a"].map((s) => s.isWellFormed())).toEqual([true, true, true, true]);
    expect(jsonRefusal(JSON.parse(String.raw`{"a":["\ud83d\ude00"]}`))).toBeNull();
    expect(jsonRefusal(JSON.parse(String.raw`{"a":["\ud83d"]}`))).toBe("malformed");
  });
});
