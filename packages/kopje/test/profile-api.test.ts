import { runInDurableObject } from "cloudflare:test";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { profile } from "../src/domain/account-actions";
import {
  DISPLAY_NAME_LIMIT,
  MAX_FIELD_NAME,
  MAX_FIELD_VALUE,
  MAX_FIELDS,
  type Profile,
  USERNAME_LIMIT,
  VERIFIED_AT_JSON_BYTES,
} from "../src/domain/accounts";
import { ANSWER_BYTES, jsonBytes } from "../src/domain/answer-budget";
import { MAX_FEATURED_TAGS } from "../src/domain/featured-tags";
import { htmlToPlainText } from "../src/domain/plain-text";
import { TAG_NAME_BYTES } from "../src/domain/status-bounds";
import { TAG_NAME_JSON_BYTES } from "../src/domain/tag-bounds";
import { utf8Length } from "../src/platform/dump-format";
import {
  ATTRIBUTION_DOMAIN_BYTES,
  ATTRIBUTION_DOMAINS_JSON_MAX,
  BIO_JSON_BYTES,
  MAX_ACCOUNT_COUNT,
  MAX_ATTRIBUTION_DOMAINS,
  PROFILE_DESCRIPTION_BYTES,
  PROFILE_DESCRIPTION_LIMIT,
  PROFILE_URL_LIMIT,
  VERIFIED_LINKS_BYTES,
} from "../src/platform/stored-bounds";
import { sha256Hex } from "../src/security/tokens";
import { bearer, json, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { PNG_PLAIN } from "./fixtures/images";
import mastodon from "./fixtures/mastodon-4.7.5-api-access.json";
import { BUILD, runStoreJobs } from "./helpers";
import { LOCAL_FIELDS_JSON_MAX, localLinkValue } from "./local-field-maxima";
import { bytes, multipartForm, TestCodec } from "./media-helpers";
import { PROFILE_MAXIMA } from "./presented-maxima";
import { aliceWithFollower } from "./profile-fixtures";
import { appToken, measuredStatements, observedSql, scopedToken } from "./read-helpers";
import { community, follow, outbound } from "./status-helpers";

// GET, PATCH and PUT /api/v1/profile (Api::V1::ProfilesController and REST::ProfileSerializer, Mastodon 4.6): the
// token's own account as its owner edits it, read with profile, read or read:accounts and written with write or
// write:accounts. The update takes the names update_credentials takes but source[...], and the display settings,
// through the same path (mastodon/accounts.ts credentialsUpdate, domain/account-actions.ts applyAccountChanges).

const ORIGIN = "https://kopje.test";
const C = "\u0001";
const W = "𠀀";

type Answer = Profile & { error?: string };

async function setup(deps: Parameters<typeof aliceWithFollower>[0] = {}) {
  const h = await aliceWithFollower(deps);
  const { alice } = h.users;
  const get = async (token = alice.token) => {
    const response = await h.request("/api/v1/profile", bearer(token));
    return { status: response.status, body: await response.json<Answer>() };
  };
  const send = async (
    method: "PATCH" | "PUT",
    body: BodyInit | Record<string, unknown>,
    token = alice.token,
    path = "/api/v1/profile",
  ) => {
    const init = body instanceof FormData ? { method, body } : json(body, { method });
    const response = await h.request(path, bearer(token, init));
    return { status: response.status, body: await response.json<Answer>() };
  };
  const updates = async () => (await outbound(h.store)).filter((o) => o.activity.type === "Update");
  // The profile operation run directly, as the Store runs it for alice's token.
  const credential = async () => ({ tokenHash: await sha256Hex(alice.token), scope: "read" as const, now: NOW });
  return { h, alice, get, send, updates, credential };
}

type H = Awaited<ReturnType<typeof setup>>["h"];

// 0xFF (a lead byte, unless `lead` is false) and `continuation` bytes of 0x80: one character to SQLite's length and
// substr with the lead, and a U+FFFD for each byte once decoded.
function malformed(continuation: number, lead = true): ArrayBuffer {
  const value = new Uint8Array(continuation + (lead ? 1 : 0)).fill(0x80);
  if (lead) {
    value[0] = 0xff;
  }
  return value.buffer;
}

// `count` featured hashtags of `account` from the `from`th, as an import holds them: ids in creation order.
async function featureTags(
  h: H,
  account: string,
  count: number,
  {
    from = 0,
    name = (i: number) => `tag${i}`,
    display = name,
    statuses = (i: number) => i,
    last = "2026-10-01T00:00:00.000Z",
  }: {
    from?: number;
    name?: (i: number) => string;
    display?: (i: number) => string;
    statuses?: (i: number) => number;
    last?: string;
  } = {},
) {
  for (let i = from; i < from + count; i++) {
    await sql(
      h.store,
      `INSERT INTO featured_tags (id, account_id, name, display_name, statuses_count, last_status_at)
				VALUES (?, ?, ?, ?, ?, ?)`,
      String(700_000_000_000_000_001n + BigInt(i)),
      account,
      name(i),
      display(i),
      statuses(i),
      last,
    );
  }
}

describe("GET /api/v1/profile", () => {
  it("answers the Profile to a token of profile, read or read:accounts, with REST::ProfileSerializer's keys", async () => {
    const { h, get } = await setup();
    const keys = mastodon.entities["REST::ProfileSerializer"].fields.map((field) => field.name).toSorted();
    for (const scope of ["profile", "read", "read:accounts"]) {
      const answer = await get(await scopedToken(h, scope));
      expect(answer.status, scope).toBe(200);
      expect(Object.keys(answer.body).toSorted(), scope).toEqual(keys);
      expect(answer.body.id).toBe(h.users.alice.id);
    }
    // write alone is refused, and an app token as verify_credentials refuses it.
    expect((await get(await scopedToken(h, "write"))).status).toBe(403);
    const app = await appToken(h);
    const credentials = await h.request("/api/v1/accounts/verify_credentials", bearer(app));
    expect(await get(app)).toEqual({ status: credentials.status, body: await credentials.json() });
    expect(credentials.status).toBe(422);
  });

  it("shows the texts as written and as formatted, and a verified field in both", async () => {
    const { h, alice, get } = await setup();
    await sql(
      h.store,
      "UPDATE accounts SET display_name = ?, note = ?, locked = 1, discoverable = NULL, indexable = 1 WHERE id = ?",
      `Alice ${W}`,
      "<p>A &amp; B &lt;3</p><p>line<br>two</p>",
      alice.id,
    );
    await sql(
      h.store,
      "UPDATE local_accounts SET fields = ?, verified_links = ?, hide_collections = 1 WHERE account_id = ?",
      JSON.stringify([
        { name: "Site", value: "https://alice.example/" },
        { name: "Plain", value: "a < b" },
      ]),
      JSON.stringify([["https://alice.example/", "2026-10-22T12:34:56.789Z"]]),
      alice.id,
    );
    const { status, body } = await get();
    expect(status).toBe(200);
    const verified = "2026-10-22T12:34:56.789+00:00";
    expect(body).toMatchObject({
      display_name: `Alice ${W}`,
      note: "A & B <3\n\nline\ntwo",
      formatted_note: "<p>A &amp; B &lt;3</p><p>line<br>two</p>",
      fields: [
        { name: "Site", value: "https://alice.example/", verified_at: verified },
        { name: "Plain", value: "a < b", verified_at: null },
      ],
      formatted_fields: [
        { name: "Site", value: expect.stringContaining('<a href="https://alice.example/"'), verified_at: verified },
        { name: "Plain", value: "a &lt; b", verified_at: null },
      ],
      locked: true,
      bot: false,
      hide_collections: true,
      discoverable: null,
      indexable: true,
      show_media: true,
      show_media_replies: true,
      show_featured: true,
      avatar_description: "",
      header_description: "",
      attribution_domains: [],
      featured_tags: [],
    });
  });

  it("shows null images when unset, never the default image, and an image with its still when set", async () => {
    const { h, alice, get } = await setup();
    expect(await get()).toMatchObject({
      status: 200,
      body: { avatar: null, avatar_static: null, header: null, header_static: null },
    });
    // An animated upload's still (0061_account_static_images), and an image without one.
    await sql(
      h.store,
      "UPDATE accounts SET avatar_url = ?, avatar_static_url = ?, header_url = ? WHERE id = ?",
      `${ORIGIN}/media/a/full.gif`,
      `${ORIGIN}/media/a/still.png`,
      `${ORIGIN}/media/h/full.png`,
      alice.id,
    );
    expect((await get()).body).toMatchObject({
      avatar: `${ORIGIN}/media/a/full.gif`,
      avatar_static: `${ORIGIN}/media/a/still.png`,
      header: `${ORIGIN}/media/h/full.png`,
      header_static: `${ORIGIN}/media/h/full.png`,
    });
  });

  it("shows the first MAX_FEATURED_TAGS featured hashtags in id order, reading no more of them", async () => {
    const { h, alice, get, credential } = await setup();
    await featureTags(h, alice.id, 12);
    const { body } = await get();
    expect(body.featured_tags.map((tag) => tag.name)).toEqual(
      Array.from({ length: MAX_FEATURED_TAGS }, (_, i) => `tag${i}`),
    );
    expect(body.featured_tags[1]).toEqual({
      id: "700000000000000002",
      name: "tag1",
      url: `${ORIGIN}/@alice/tagged/tag1`,
      statuses_count: "1",
      last_status_at: "2026-10-01",
    });
    // The featured read returns MAX_FEATURED_TAGS rows, and reads as many rows with 12 featured as with 40.
    const featuredRead = async () => {
      const { output, statements } = await measuredStatements(h, profile, {
        credential: await credential(),
        present: { origin: ORIGIN },
      });
      const featured = statements.filter((s) => s.query.includes("featured_tags"));
      expect(featured).toHaveLength(1);
      return { shown: (output as { value: Profile }).value.featured_tags.length, ...featured[0]! };
    };
    const twelve = await featuredRead();
    expect(twelve).toMatchObject({ shown: MAX_FEATURED_TAGS, returned: MAX_FEATURED_TAGS });
    await featureTags(h, alice.id, 28, { from: 12 });
    expect(await featuredRead()).toEqual(twelve);
  });

  it("presents an oversized attribution import as [], reading only its projection", async () => {
    const { h, alice, get, credential } = await setup();
    // One element of 1 MiB, which 0024's CHECK passes.
    await sql(
      h.store,
      "UPDATE local_accounts SET attribution_domains = json_array(hex(zeroblob(524288))) WHERE account_id = ?",
      alice.id,
    );
    expect((await get()).body.attribution_domains).toEqual([]);
    const input = { credential: await credential(), present: { origin: ORIGIN } };
    const read = await runInDurableObject(h.store, (_instance, state) => {
      const values: unknown[] = [];
      const db = observedSql(state.storage.sql, (rows) => {
        for (const row of rows) {
          if ("attribution_domains" in row) {
            values.push(row.attribution_domains);
          }
        }
      });
      profile.run(db, input);
      return values;
    });
    expect(read).toEqual(["[]"]);
  });

  it("presents an imported display name, note and descriptions of malformed bytes within their bounds", async () => {
    const { h, alice, get } = await setup();
    // As a dump holds them: 0048's and 0097's triggers pass each value.
    await sql(
      h.store,
      `UPDATE accounts SET display_name = CAST(?1 AS TEXT), note = CAST(?2 AS TEXT), avatar_description = CAST(?3 AS TEXT),
				header_description = CAST(?3 AS TEXT) WHERE id = ?4`,
      malformed(1_048_575),
      malformed(65_534, false),
      malformed(PROFILE_DESCRIPTION_BYTES - 1),
      alice.id,
    );
    const { body } = await get();
    expect({
      display_name: body.display_name,
      note: body.note,
      formatted_note: body.formatted_note,
      descriptions: [body.avatar_description, body.header_description],
    }).toEqual({
      display_name: "\uFFFD".repeat(DISPLAY_NAME_LIMIT),
      note: "",
      formatted_note: "",
      descriptions: ["\uFFFD".repeat(PROFILE_DESCRIPTION_LIMIT), "\uFFFD".repeat(PROFILE_DESCRIPTION_LIMIT)],
    });
  });
});

describe("PATCH and PUT /api/v1/profile", () => {
  it("apply every permitted name, the display settings included, and answer the Profile", async () => {
    const { h, alice, get, send } = await setup();
    const patched = await send("PATCH", {
      display_name: "Alice",
      note: "Hello\nworld",
      avatar_description: "A cat",
      header_description: "A field",
      locked: true,
      bot: true,
      discoverable: true,
      hide_collections: true,
      indexable: true,
      show_media: false,
      show_media_replies: false,
      show_featured: false,
      attribution_domains: ["alice.example"],
      fields_attributes: [{ name: "Site", value: "https://alice.example/" }],
    });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({
      display_name: "Alice",
      note: "Hello\nworld",
      formatted_note: "<p>Hello<br>world</p>",
      avatar_description: "A cat",
      header_description: "A field",
      locked: true,
      bot: true,
      discoverable: true,
      hide_collections: true,
      indexable: true,
      show_media: false,
      show_media_replies: false,
      show_featured: false,
      attribution_domains: ["alice.example"],
      fields: [{ name: "Site", value: "https://alice.example/", verified_at: null }],
    });
    expect((await get()).body).toEqual(patched.body);
    // The Account shows the same settings.
    const account = await h.request(`/api/v1/accounts/${alice.id}`, bearer(alice.token));
    expect(await account.json()).toMatchObject({ show_media: false, show_media_replies: false, show_featured: false });
    const put = await send("PUT", {
      display_name: "",
      note: "",
      avatar_description: "",
      header_description: "",
      locked: false,
      bot: false,
      discoverable: false,
      hide_collections: false,
      indexable: false,
      show_media: true,
      show_media_replies: true,
      show_featured: true,
      attribution_domains: [],
      fields_attributes: {},
    });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({
      display_name: "",
      note: "",
      avatar_description: "",
      header_description: "",
      locked: false,
      bot: false,
      discoverable: false,
      hide_collections: false,
      indexable: false,
      show_media: true,
      show_media_replies: true,
      show_featured: true,
      attribution_domains: [],
      fields: [],
    });
    expect((await get()).body).toEqual(put.body);
    // Absent names are kept, with a token of write alone.
    const kept = await send("PUT", { show_media: "0" }, await scopedToken(h, "write"));
    expect(kept.body).toMatchObject({ show_media: false, show_featured: true, locked: false });
  });

  it("takes an avatar file and its description in one multipart request", async () => {
    const codec = new TestCodec();
    const { send } = await setup({ images: () => codec });
    const png = new File([bytes(PNG_PLAIN)], "a.png", { type: "image/png" });
    const sent = await send(
      "PATCH",
      multipartForm([
        ["avatar", png],
        ["avatar_description", "A cat"],
      ]),
    );
    expect(sent.status).toBe(200);
    expect(sent.body.avatar).toMatch(/^https:\/\/kopje\.test\/media\/[A-Za-z0-9_-]+\/full\.png$/);
    expect(sent.body).toMatchObject({ avatar_static: sent.body.avatar, avatar_description: "A cat", header: null });
  });

  it("answers an invalid or under-scoped token without reading a multipart body", async () => {
    const { h } = await setup();
    // A stream that fails the test if the handler pulls it.
    const untouchable = () =>
      new ReadableStream<Uint8Array>(
        {
          pull() {
            throw new Error("the body was read");
          },
        },
        { highWaterMark: 0 },
      );
    const sent = (method: string, token: string) =>
      h.request("/api/v1/profile", {
        method,
        body: untouchable(),
        headers: { authorization: `Bearer ${token}`, "content-type": "multipart/form-data; boundary=b" },
        duplex: "half",
      } as RequestInit);
    for (const method of ["PATCH", "PUT"]) {
      expect((await sent(method, "not-a-token")).status, method).toBe(401);
      expect((await sent(method, await scopedToken(h, "read"))).status, method).toBe(403);
    }
  });

  it("refuses what update_credentials refuses, with the same messages, changing nothing", async () => {
    const { alice, get, send } = await setup();
    const before = (await get()).body;
    // Compliant hosts padded with U+00AD (two bytes, which IDNA ignores) in labels of 63 characters as written: one byte
    // past ATTRIBUTION_DOMAIN_BYTES, and at it.
    const labels = `${Array.from({ length: 8 }, () => `a${"\u00ad".repeat(62)}`).join(".")}.example`;
    const padded = `bcdef.${labels}`;
    const within = `bcde.${labels}`;
    expect([utf8Length(padded), utf8Length(within)]).toEqual([ATTRIBUTION_DOMAIN_BYTES + 1, ATTRIBUTION_DOMAIN_BYTES]);
    for (const body of [
      { avatar_description: W.repeat(PROFILE_DESCRIPTION_LIMIT + 1), show_media: false },
      { header_description: "x".repeat(PROFILE_DESCRIPTION_LIMIT + 1), show_featured: false },
      { attribution_domains: [padded], show_media_replies: false },
    ]) {
      const refused = await send("PATCH", body);
      expect(refused.status).toBe(422);
      expect(refused.body).toEqual(
        (await send("PATCH", body, alice.token, "/api/v1/accounts/update_credentials")).body,
      );
    }
    expect((await get()).body).toEqual(before);
    // One step inside each bound is taken.
    const taken = await send("PATCH", {
      avatar_description: W.repeat(PROFILE_DESCRIPTION_LIMIT),
      attribution_domains: [within],
    });
    expect(taken.status).toBe(200);
    expect(taken.body).toMatchObject({
      avatar_description: W.repeat(PROFILE_DESCRIPTION_LIMIT),
      attribution_domains: [within],
    });
  });

  it("neither applies nor validates source[...], which update_credentials refuses", async () => {
    const { h, alice, send } = await setup();
    const source = async () =>
      (
        await (
          await h.request("/api/v1/accounts/verify_credentials", bearer(alice.token))
        ).json<{
          source: { privacy: string; language: string | null };
        }>()
      ).source;
    const sent = { "source[privacy]": "invalid", "source[language]": "!!", display_name: "Alice" };
    expect(await send("PATCH", sent, alice.token, "/api/v1/accounts/update_credentials")).toEqual({
      status: 422,
      body: {
        error: "Validation failed: Privacy is not included in the list, Language is not a valid language code",
        details: {
          privacy: [{ error: "ERR_INCLUSION", description: "is not included in the list" }],
          language: [{ error: "ERR_INVALID", description: "is not a valid language code" }],
        },
      },
    });
    const answered = await send("PATCH", sent);
    expect(answered.status).toBe(200);
    expect(answered.body.display_name).toBe("Alice");
    expect((await send("PUT", { "source[privacy]": "private", "source[language]": "ja" })).status).toBe(200);
    expect(await source()).toMatchObject({ privacy: "public", language: null });
  });

  it("accepts the pending follow requests when it unlocks the account, as update_credentials does", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    await sql(h.store, "UPDATE accounts SET locked = 1 WHERE id = ?", alice.id);
    await follow(h, bob, alice.id);
    const state = async () =>
      (await sql<{ state: string }>(h.store, "SELECT state FROM follows WHERE target_account_id = ?", alice.id))[0]
        ?.state;
    expect(await state()).toBe("pending");
    const response = await h.request(
      "/api/v1/profile",
      bearer(alice.token, { ...json({ locked: false }), method: "PATCH" }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ locked: false });
    await runStoreJobs(h.store, BUILD, { now: NOW });
    expect(await state()).toBe("accepted");
  });

  it("sends an Update(Person) when the published document changes", async () => {
    const { h, alice, send, updates } = await setup();
    // The settings alone change the document.
    expect((await send("PATCH", { show_media: false, show_featured: false })).status).toBe(200);
    expect((await updates()).at(-1)?.activity.object).toMatchObject({
      showMedia: false,
      showRepliesInMedia: true,
      showFeatured: false,
    });
    // A description alone changes it only while its image exists (an Update supersedes the pending one: the last
    // recorded is compared).
    const last = async () => (await updates()).at(-1)?.activity;
    const settings = await last();
    expect((await send("PUT", { avatar_description: "A cat" })).status).toBe(200);
    expect(await last()).toEqual(settings);
    await sql(h.store, "UPDATE accounts SET avatar_url = ? WHERE id = ?", `${ORIGIN}/media/a.png`, alice.id);
    expect((await send("PUT", { avatar_description: "A dog" })).status).toBe(200);
    const described = await last();
    expect(described?.id).not.toBe(settings?.id);
    expect(described?.object).toMatchObject({
      icon: { type: "Image", url: `${ORIGIN}/media/a.png`, summary: "A dog" },
    });
  });
});

// docs/threat-model.md "Maxima of presented units", "Profile, derived from its caps" (RES-3). The request's origin: an
// https host of at most 253 octets with a port.
const ORIGIN_MAX = `https://${"a".repeat(253)}:65535`;

// The most one featured hashtag presents (featured-tags.ts presentFeatured): an 18-digit id (the CHECK of
// 0016_tags); a name within the list's bound (TAG_NAME_JSON_BYTES as JSON); its tagged URL on the origin, a username
// of USERNAME_LIMIT escaping characters and the name percent-encoded (TAG_NAME_BYTES, three bytes each); a count of
// MAX_ACCOUNT_COUNT; a date cut to 10 UTF-16 code units, each escaped to six bytes.
const FEATURED_TAG_JSON_MAX =
  jsonBytes({
    id: "9".repeat(18),
    name: "",
    url: `${ORIGIN_MAX}/@${C.repeat(USERNAME_LIMIT)}/tagged/${"%FF".repeat(TAG_NAME_BYTES)}`,
    statuses_count: String(MAX_ACCOUNT_COUNT),
    last_status_at: C.repeat(10),
  }) + TAG_NAME_JSON_BYTES;

// The most a Profile presents, each part at its bound after decoding: the display name at DISPLAY_NAME_LIMIT code
// points of six bytes (presentedDisplayName); formatted_note at BIO_JSON_BYTES (presentedNote) and note at no more
// (htmlToPlainText never grows its JSON, below); MAX_FIELDS fields as written (code points of six bytes, verified) and
// as formatted (LOCAL_FIELDS_JSON_MAX); four image URLs at PROFILE_URL_LIMIT as JSON (jsonHref); both descriptions at
// PROFILE_DESCRIPTION_LIMIT code points of six bytes; every boolean false; the attribution domains at
// ATTRIBUTION_DOMAINS_JSON_MAX; MAX_FEATURED_TAGS featured hashtags at FEATURED_TAG_JSON_MAX.
const PROFILE_JSON_MAX =
  jsonBytes({
    id: "9".repeat(18),
    display_name: C.repeat(DISPLAY_NAME_LIMIT),
    note: "",
    fields: Array.from({ length: MAX_FIELDS }, () => ({
      name: C.repeat(MAX_FIELD_NAME),
      value: C.repeat(MAX_FIELD_VALUE),
      verified_at: "x".repeat(VERIFIED_AT_JSON_BYTES - 2),
    })),
    formatted_note: "",
    formatted_fields: [],
    avatar: "",
    avatar_static: "",
    avatar_description: C.repeat(PROFILE_DESCRIPTION_LIMIT),
    header: "",
    header_static: "",
    header_description: C.repeat(PROFILE_DESCRIPTION_LIMIT),
    locked: false,
    bot: false,
    hide_collections: false,
    discoverable: false,
    indexable: false,
    show_media: false,
    show_media_replies: false,
    show_featured: false,
    attribution_domains: [],
    featured_tags: [],
  }) +
  2 * (BIO_JSON_BYTES - 2) +
  (LOCAL_FIELDS_JSON_MAX - 2) +
  4 * PROFILE_URL_LIMIT +
  (ATTRIBUTION_DOMAINS_JSON_MAX - 2) +
  MAX_FEATURED_TAGS * FEATURED_TAG_JSON_MAX +
  (MAX_FEATURED_TAGS - 1);

// An image URL whose JSON is exactly PROFILE_URL_LIMIT bytes: backslashes in its query, which JSON doubles.
const imageUrlAtBound = (path: string) => {
  const prefix = `${ORIGIN}/${path}?`;
  return prefix + "\\".repeat((PROFILE_URL_LIMIT - prefix.length) / 2);
};

describe("the Profile at its caps (RES-3)", () => {
  it("never grows a note's JSON when it turns its HTML into plain text", () => {
    const token = fc.constantFrom("<p>", "</p>", "</p><p>", "<br>", "&amp;", "&lt;", "&gt;", "&quot;", "&#39;", C);
    const html = fc.array(fc.oneof(token, fc.string({ unit: "binary" })), { maxLength: 40 }).map((p) => p.join(""));
    fc.assert(fc.property(html, (value) => jsonBytes(htmlToPlainText(value)) <= jsonBytes(value)));
  });

  it("derives the Profile's maximum from its caps, above a witness at them and one of malformed bytes", async () => {
    const { h, alice, get } = await setup();
    // Every part at its cap at once.
    const note = `<p>${C.repeat(10_000)}${"x".repeat(5_527)}</p>`;
    expect(jsonBytes(note)).toBe(BIO_JSON_BYTES);
    await sql(
      h.store,
      `UPDATE accounts SET display_name = ?1, note = ?2, avatar_description = ?3, header_description = ?3,
				avatar_url = ?4, avatar_static_url = ?5, header_url = ?6, header_static_url = ?7 WHERE id = ?8`,
      C.repeat(DISPLAY_NAME_LIMIT),
      note,
      C.repeat(PROFILE_DESCRIPTION_LIMIT),
      imageUrlAtBound("avatar"),
      `${ORIGIN}/s?`.padEnd(512, "\\"),
      imageUrlAtBound("header"),
      `${ORIGIN}/t?`.padEnd(512, "\\"),
      alice.id,
    );
    await sql(
      h.store,
      "UPDATE local_accounts SET fields = ?, verified_links = ?, attribution_domains = ? WHERE account_id = ?",
      JSON.stringify(
        Array.from({ length: MAX_FIELDS }, (_, i) => ({ name: C.repeat(MAX_FIELD_NAME), value: localLinkValue(i) })),
      ),
      JSON.stringify(
        Array.from({ length: MAX_FIELDS }, (_, i) => [localLinkValue(i), new Date(NOW).toISOString()]),
      ).padEnd(VERIFIED_LINKS_BYTES, " "),
      JSON.stringify(
        Array.from({ length: MAX_ATTRIBUTION_DOMAINS }, (_, i) => `d${i}.`.padEnd(ATTRIBUTION_DOMAIN_BYTES, "a")),
      ),
      alice.id,
    );
    // Names of TAG_NAME_BYTES four-byte characters and shown names of six-byte escapes, at the list's bound.
    await featureTags(h, alice.id, MAX_FEATURED_TAGS + 2, {
      name: (i) => W.repeat(255) + String.fromCodePoint(0x20001 + i),
      display: () => C.repeat(TAG_NAME_JSON_BYTES / 6),
      statuses: () => MAX_ACCOUNT_COUNT,
      last: C.repeat(10),
    });
    const atCaps = await get();
    expect(atCaps.status).toBe(200);
    const shown = atCaps.body;
    expect({
      displayName: jsonBytes(shown.display_name),
      formattedNote: jsonBytes(shown.formatted_note),
      verified: shown.formatted_fields.map((field) => field.verified_at !== null),
      images: [shown.avatar, shown.header].map((url) => jsonBytes(url) - 2),
      descriptions: [jsonBytes(shown.avatar_description), jsonBytes(shown.header_description)],
      domains: jsonBytes(shown.attribution_domains),
      featured: shown.featured_tags.length,
      featuredName: jsonBytes(shown.featured_tags[0]?.name) - 2,
    }).toEqual({
      displayName: 6 * DISPLAY_NAME_LIMIT + 2,
      formattedNote: BIO_JSON_BYTES,
      verified: [true, true, true, true],
      images: [PROFILE_URL_LIMIT, PROFILE_URL_LIMIT],
      descriptions: [902, 902],
      domains: ATTRIBUTION_DOMAINS_JSON_MAX,
      featured: MAX_FEATURED_TAGS,
      featuredName: TAG_NAME_JSON_BYTES,
    });
    // The same with the display name, note and descriptions imported as malformed bytes past their decoded bounds.
    await sql(
      h.store,
      `UPDATE accounts SET display_name = CAST(?1 AS TEXT), note = CAST(?2 AS TEXT), avatar_description = CAST(?3 AS TEXT),
				header_description = CAST(?3 AS TEXT) WHERE id = ?4`,
      malformed(1_048_575),
      malformed(65_534, false),
      malformed(PROFILE_DESCRIPTION_BYTES - 1),
      alice.id,
    );
    const imported = await get();
    expect(imported.status).toBe(200);
    expect({ derived: PROFILE_JSON_MAX, atCaps: jsonBytes(shown), imported: jsonBytes(imported.body) }).toEqual({
      derived: PROFILE_MAXIMA.conservative,
      atCaps: PROFILE_MAXIMA.json,
      imported: 188_080,
    });
    expect(PROFILE_MAXIMA.json).toBeLessThanOrEqual(PROFILE_MAXIMA.conservative);
    expect(PROFILE_MAXIMA.conservative).toBeLessThanOrEqual(ANSWER_BYTES);
  }, 60_000);
});
