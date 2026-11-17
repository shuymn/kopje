import { describe, expect, it } from "vitest";

import { parseActivity } from "../src/federation/inbound";
import { INBOX_BODY_LIMIT } from "../src/federation/spool";
import { handleQueue } from "../src/jobs/queue";
import { jsonRefusal, MAX_JSON_NODES, wellFormedJson } from "../src/platform/json-bounds";
import { sql } from "./api-helpers";
import { harness, inboxDeps, NOW } from "./app-helpers";
import { fixtureKeyGen } from "./federation-helpers";
import { BUILD } from "./helpers";
import { AP, LOCAL, mastodonActor, signedInit } from "./inbox-helpers";
import { AS, like, localStatus, type Setup, setup, undo } from "./inbox-status-helpers";

// #1718: an inbound activity whose JSON holds a string or a key with an unpaired surrogate is JSON that does not
// parse (src/platform/json-bounds.ts; docs/mastodon-deviations.md, "Reading inbound activities"; RES-2). Mastodon
// 4.7.5's JSON.parse (json 2.21.2) raises on a high surrogate escape not followed by a low one; Kopje also refuses a
// lone low one, which that parser keeps as invalid UTF-8. JSON.stringify writes a lone surrogate as its \u escape, so
// every body here carries the escape on the wire.

type Json = Record<string, unknown>;

const bytes = (json: unknown) => new TextEncoder().encode(JSON.stringify(json));

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
  });

  it("refuses a spooled activity holding one on replay, and applies its well-formed copy", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const status = await localStatus(t, { status: "liked", visibility: "public" });
    const maintenance = harness(t.store, { MAINTENANCE: "readonly" }, BUILD, {
      keygen: fixtureKeyGen,
      loader: t.web.loader,
    });
    const spool = async (body: Json) =>
      (await maintenance.request("/inbox", await signedInit(bob, "/inbox", body, { at: NOW }))).status;
    const broken = like(bob, status.uri, { junk: "\ud800" });
    const control = like(bob, status.uri, { junk: "😀" });
    expect(await spool(broken)).toBe(202);
    expect(await spool(control)).toBe(202);
    const deps = { ...inboxDeps(() => t.store, t.web.loader), now: () => NOW };
    await maintenance.queue.deliver((batch) =>
      handleQueue(batch, { ...maintenance.env, MAINTENANCE: "off" } as Env, deps),
    );
    expect(await sql(t.store, "SELECT uri FROM favourite_likes")).toEqual([{ uri: control.id }]);
  });
});

// C5, RES-2: the inbox reads the body before any signature is verified, so the walk's added work (one pass over each
// string and key) is timed through the real gate, unsigned, on a body at INBOX_BODY_LIMIT bytes and MAX_JSON_NODES
// values. Each string starts with a surrogate pair, so it is held as UTF-16 and checked to its end, then ASCII, which
// gives the most code units per byte such a string can have. The broken body ends the array's first string with a lone
// high surrogate: the walk visits an array from its end, so it reads that string last and every other check runs first.
describe("the unpaired surrogate check at the body bounds", () => {
  const GENEROUS_MS = 1_000;
  const envelope = remoteLike();
  // The root and its members are values too.
  const count = MAX_JSON_NODES - 1 - Object.keys(envelope).length - 1;
  const skeleton = new TextEncoder().encode(
    JSON.stringify({ ...envelope, x: Array.from({ length: count }, () => "") }),
  );
  const room = INBOX_BODY_LIMIT - skeleton.byteLength;
  const units = (n: number) => "😀" + "a".repeat(n - 4);
  const strings = Array.from({ length: count }, (_, i) =>
    units(Math.floor(room / count) + (i === 0 ? room % count : 0)),
  );
  const filled = { ...envelope, x: strings };
  // A lone high surrogate is written as a 6-byte escape where the 6 ASCII bytes it replaces were.
  const broken = { ...envelope, x: [`${strings[0]!.slice(0, -6)}\ud83d`, ...strings.slice(1)] };

  it("holds both bodies at the bounds, and refuses only the broken one", async () => {
    for (const body of [filled, broken]) {
      expect(bytes(body).byteLength).toBe(INBOX_BODY_LIMIT);
    }
    expect(jsonRefusal(filled)).toBeNull();
    expect(jsonRefusal({ ...filled, y: 0 })).toBe("too-complex");
    expect(jsonRefusal(broken)).toBe("malformed");
    expect(await outcome(filled)).toBe("ok Like");
    expect(await outcome(broken)).toBe("invalid-json");
  });

  it.each([
    ["a well-formed body", filled],
    ["a body broken in the last string the walk reads", broken],
  ])("answers %s within a generous time", async (_, body) => {
    const t = await setup();
    const started = performance.now();
    const response = await t.request("/inbox", { method: "POST", headers: { "content-type": AP }, body: bytes(body) });
    const elapsed = performance.now() - started;
    expect(response.status).toBe(401);
    expect(elapsed).toBeLessThan(GENEROUS_MS);
  });
});

// #1718's check relies on String.prototype.isWellFormed (ES2024), which the Workers runtime provides; the Node side is
// test-node/json-bounds.test.ts.
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
    expect(wellFormedJson(JSON.parse(String.raw`{"a":["\ud83d\ude00"]}`))).toBe(true);
    expect(wellFormedJson(JSON.parse(String.raw`{"a":["\ud83d"]}`))).toBe(false);
  });
});
