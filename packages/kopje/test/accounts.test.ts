import { describe, expect, it } from "vitest";

import { MAX_RAW_LENGTH, noteLength } from "../src/domain/status-text";
import { credentialChanges, profileFiles } from "../src/mastodon/accounts";
import { validationBody, type ValidationBody } from "../src/mastodon/errors";
import { API_BODY_LIMIT, Params } from "../src/mastodon/params";
import { utf8Length } from "../src/platform/dump-format";
import { PROFILE_IMAGE_LIMIT } from "../src/platform/images";
import { ATTRIBUTION_DOMAIN_BYTES, MAX_ATTRIBUTION_DOMAINS } from "../src/platform/stored-bounds";
import {
  type ApiHarness,
  apiHarness,
  bearer,
  form,
  json,
  login,
  seedAccount,
  sql,
  STORED_ACTOR_TYPES,
} from "./api-helpers";
import { NOW } from "./app-helpers";
import { blockDomain } from "./domain-block-helpers";
import { appToken, scopedToken } from "./read-helpers";
import { block, community, domainBlock, follow, getJson, ids as listIds, mute, remoteFollows } from "./status-helpers";

type Account = Record<string, unknown> & { id: string };

async function aliceSession(): Promise<ApiHarness & { aliceId: string; token: string }> {
  const h = await apiHarness();
  const aliceId = await seedAccount(h.store, { username: "alice", email: "alice@example.com", displayName: "Alice" });
  const { token } = await login(h, { scope: "read write follow" });
  return { ...h, aliceId, token };
}

describe("credentials", () => {
  it("returns the viewer with source and the default role", async () => {
    const h = await aliceSession();
    const response = await h.request("/api/v1/accounts/verify_credentials", bearer(h.token));
    expect(await response.json()).toEqual({
      id: h.aliceId,
      username: "alice",
      acct: "alice",
      display_name: "Alice",
      locked: false,
      bot: false,
      discoverable: null,
      indexable: false,
      group: false,
      created_at: new Date(NOW).toISOString(),
      note: "",
      url: "https://kopje.test/@alice",
      uri: "https://kopje.test/ap/users/alice",
      avatar: "https://kopje.test/assets/avatar.jpg",
      avatar_static: "https://kopje.test/assets/avatar.jpg",
      avatar_description: "",
      header: "https://kopje.test/assets/header.jpg",
      header_static: "https://kopje.test/assets/header.jpg",
      header_description: "",
      followers_count: 0,
      following_count: 0,
      statuses_count: 0,
      last_status_at: null,
      hide_collections: false,
      show_media: true,
      show_media_replies: true,
      show_featured: true,
      emojis: [],
      fields: [],
      noindex: false,
      roles: [],
      feature_approval: { automatic: [], manual: [], current_user: "denied" },
      source: {
        privacy: "public",
        sensitive: false,
        language: null,
        note: "",
        fields: [],
        follow_requests_count: 0,
        hide_collections: false,
        discoverable: null,
        indexable: false,
        attribution_domains: [],
        quote_policy: "public",
      },
      role: { id: "-99", name: "", permissions: "0", color: "", highlighted: false, collection_limit: 10 },
    });
  });

  it("counts follow requests of available accounts, at most 40, among the newest 120", async () => {
    let next = 0;
    // `n` new remote accounts on `domain`, each with a pending request to the viewer, in id order (newest last).
    const requests = async (h: ApiHarness & { aliceId: string }, n: number, domain: string, suspended = false) => {
      const base = 300000000000000000n + BigInt(next);
      next += n;
      await sql(
        h.store,
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO accounts (id, uri, username, domain, suspended_at, suspension_source)
				SELECT CAST(?2 + i AS TEXT), 'https://' || ?3 || '/users/r' || (?2 + i), 'r' || (?2 + i), ?3, ?4, ?5 FROM n`,
        n,
        String(base),
        domain,
        suspended ? new Date(NOW).toISOString() : null,
        suspended ? "account" : null,
      );
      await sql(
        h.store,
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO follows (account_id, target_account_id, state) SELECT CAST(?2 + i AS TEXT), ?3, 'pending' FROM n`,
        n,
        String(base),
        h.aliceId,
      );
    };
    const count = async (h: ApiHarness & { token: string }) => {
      const response = await h.request("/api/v1/accounts/verify_credentials", bearer(h.token));
      return (await response.json<{ source: { follow_requests_count: number } }>()).source.follow_requests_count;
    };
    // Mastodon 4.5.21 caps the count at 40 (credential_account_serializer.rb:17).
    const many = await aliceSession();
    await requests(many, 39, "a.example");
    expect(await count(many)).toBe(39);
    await requests(many, 6, "a.example");
    expect(await count(many)).toBe(40);
    // Requests of unavailable accounts (R1) are left out: individually suspended, then covered by a suspend block.
    const some = await aliceSession();
    await requests(some, 10, "suspended.example", true);
    await requests(some, 5, "blocked.example");
    await requests(some, 15, "ok.example");
    expect(await count(some)).toBe(20);
    await blockDomain(some.store, "blocked.example");
    expect(await count(some)).toBe(15);
    // Only the newest 120 requests are read: 3 older available requesters count while they are among them, and none
    // once 121 newer requests of unavailable accounts precede them (the accepted departure).
    const hidden = await aliceSession();
    await requests(hidden, 3, "ok.example");
    await requests(hidden, 117, "suspended.example", true);
    expect(await count(hidden)).toBe(3);
    await requests(hidden, 1, "suspended.example", true);
    expect(await count(hidden)).toBe(2);
    await requests(hidden, 3, "suspended.example", true);
    expect(await count(hidden)).toBe(0);
  });

  it("stores plain-text profile fields safely and gives the note back as source", async () => {
    const h = await aliceSession();
    const note = 'Hello <b>world</b> & "friends"\nsecond line\n\nnew paragraph';
    const response = await h.request(
      "/api/v1/accounts/update_credentials",
      bearer(
        h.token,
        json(
          {
            display_name: "<script>x</script>",
            note,
            locked: true,
            bot: "true",
            source: { privacy: "unlisted", sensitive: true, language: "ja" },
          },
          { method: "PATCH" },
        ),
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      display_name: "<script>x</script>",
      note: "<p>Hello &lt;b&gt;world&lt;/b&gt; &amp; &quot;friends&quot;<br>second line</p><p>new paragraph</p>",
      locked: true,
      bot: true,
      source: { privacy: "unlisted", sensitive: true, language: "ja", note },
    });
    // display_name is searchable right away.
    const [row] = await sql<{ search_text: string }>(
      h.store,
      "SELECT search_text FROM accounts WHERE id = ?",
      h.aliceId,
    );
    expect(row?.search_text).toBe("<script>x</script> alice");
  });

  it("accepts multipart forms, as most clients send them", async () => {
    const h = await aliceSession();
    const body = new FormData();
    body.set("display_name", "Alice A.");
    body.set("source[privacy]", "private");
    const response = await h.request("/api/v1/accounts/update_credentials", bearer(h.token, { method: "PATCH", body }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ display_name: "Alice A.", source: { privacy: "private" } });
  });

  it("hides the network with hide_collections, shown on the account and in source", async () => {
    const h = await aliceSession();
    const hide = await h.request(
      "/api/v1/accounts/update_credentials",
      bearer(h.token, json({ hide_collections: true }, { method: "PATCH" })),
    );
    expect(await hide.json()).toMatchObject({ hide_collections: true, source: { hide_collections: true } });
    const [row] = await sql<{ hide_collections: number }>(
      h.store,
      "SELECT hide_collections FROM local_accounts WHERE account_id = ?",
      h.aliceId,
    );
    expect(row?.hide_collections).toBe(1);
    expect(await (await h.request(`/api/v1/accounts/${h.aliceId}`)).json()).toMatchObject({ hide_collections: true });
    // Left out, it stays as it is; false shows the network again.
    const other = await h.request(
      "/api/v1/accounts/update_credentials",
      bearer(h.token, json({ display_name: "Alice A." }, { method: "PATCH" })),
    );
    expect(await other.json()).toMatchObject({ hide_collections: true });
    const show = new FormData();
    show.set("hide_collections", "false");
    const shown = await h.request(
      "/api/v1/accounts/update_credentials",
      bearer(h.token, { method: "PATCH", body: show }),
    );
    expect(await shown.json()).toMatchObject({ hide_collections: false, source: { hide_collections: false } });
  });

  it("stores attribution domains as Mastodon normalizes them and gives them back in source", async () => {
    const h = await aliceSession();
    const patch = (body: Record<string, unknown>) =>
      h.request("/api/v1/accounts/update_credentials", bearer(h.token, json(body, { method: "PATCH" })));
    const response = await patch({
      attribution_domains: [" https://writer.example ", "*.news.example", "writer.example", "", "Bücher.example"],
    });
    expect(response.status).toBe(200);
    const domains = ["writer.example", "news.example", "Bücher.example"];
    expect(await response.json()).toMatchObject({ source: { attribution_domains: domains } });
    const verified = await h.request("/api/v1/accounts/verify_credentials", bearer(h.token));
    expect(await verified.json()).toMatchObject({ source: { attribution_domains: domains } });
    // Left out or sent as a scalar (which Mastodon's strong parameters drop), they stay as they are.
    expect(await (await patch({ display_name: "Alice A." })).json()).toMatchObject({
      source: { attribution_domains: domains },
    });
    expect(await (await patch({ attribution_domains: "other.example" })).json()).toMatchObject({
      source: { attribution_domains: domains },
    });
    // An empty list clears them, from a form as from JSON.
    const clear = new FormData();
    clear.set("attribution_domains[]", "");
    const cleared = await h.request(
      "/api/v1/accounts/update_credentials",
      bearer(h.token, { method: "PATCH", body: clear }),
    );
    expect(await cleared.json()).toMatchObject({ source: { attribution_domains: [] } });
    expect(await (await patch({ attribution_domains: ["a.example"] })).json()).toMatchObject({
      source: { attribution_domains: ["a.example"] },
    });
    expect(await (await patch({ attribution_domains: [] })).json()).toMatchObject({
      source: { attribution_domains: [] },
    });
  });

  it("refuses attribution domains that are not domain names, or more than 100, with Mastodon messages", async () => {
    const h = await aliceSession();
    const patch = (body: Record<string, unknown>) =>
      h.request("/api/v1/accounts/update_credentials", bearer(h.token, json(body, { method: "PATCH" })));
    const invalid = await patch({
      attribution_domains: ["ok.example", "under_score.example", "writer.example/path", ".lead.example", "a b"],
    });
    expect(invalid.status).toBe(422);
    const line = (domain: string) => ({
      error: "ERR_INVALID_DOMAIN_ON_LINE",
      description: `${domain} is not a valid domain name`,
    });
    expect(await invalid.json()).toEqual({
      error:
        "Validation failed: Attribution domains under_score.example is not a valid domain name, Attribution domains writer.example/path is not a valid domain name, Attribution domains .lead.example is not a valid domain name, Attribution domains a b is not a valid domain name",
      details: {
        attribution_domains: ["under_score.example", "writer.example/path", ".lead.example", "a b"].map(line),
      },
    });
    const many = await patch({ attribution_domains: Array.from({ length: 101 }, (_, i) => `d${i}.example`) });
    expect(many.status).toBe(422);
    expect(await many.json()).toEqual({
      error: "Validation failed: Attribution domains is too long (maximum is 100 characters)",
      details: {
        attribution_domains: [{ error: "ERR_TOO_LONG", description: "is too long (maximum is 100 characters)" }],
      },
    });
    const hundred = await patch({ attribution_domains: Array.from({ length: 100 }, (_, i) => `d${i}.example`) });
    expect(hundred.status).toBe(200);
    // A trailing dot passes, as Ruby's split drops the empty label after it; a label of 64 characters does not.
    expect((await patch({ attribution_domains: ["dot.example."] })).status).toBe(200);
    expect((await patch({ attribution_domains: [`${"a".repeat(64)}.example`] })).status).toBe(422);
    const [row] = await sql<{ attribution_domains: string }>(
      h.store,
      "SELECT attribution_domains FROM local_accounts WHERE account_id = ?",
      h.aliceId,
    );
    expect(JSON.parse(row?.attribution_domains ?? "")).toEqual(["dot.example."]);
  });

  // Measured on Mastodon 4.7.5 (M1): Addressable converts a label of fewer than 64 characters as written, so padding
  // IDNA drops (U+00AD) passes up to 63 characters in a label and is refused at 64, in the first label as in the last.
  it("refuses a label of 64 characters as written", async () => {
    const h = await aliceSession();
    const patch = (domain: string) =>
      h.request(
        "/api/v1/accounts/update_credentials",
        bearer(h.token, json({ attribution_domains: [domain] }, { method: "PATCH" })),
      );
    const pad = (n: number) => "\u00ad".repeat(n);
    for (const [domain, status] of [
      [`a${pad(62)}.example.com`, 200],
      [`a${pad(63)}.example.com`, 422],
      [`example.com${pad(60)}`, 200],
      [`example.com${pad(61)}`, 422],
    ] as const) {
      const response = await patch(domain);
      expect(response.status, domain).toBe(status);
      if (status === 422) {
        expect(await response.json()).toMatchObject({
          error: `Validation failed: Attribution domains ${domain} is not a valid domain name`,
        });
      }
    }
    const [row] = await sql<{ attribution_domains: string }>(
      h.store,
      "SELECT attribution_domains FROM local_accounts WHERE account_id = ?",
      h.aliceId,
    );
    expect(JSON.parse(row?.attribution_domains ?? "")).toEqual([`example.com${pad(60)}`]);
  });

  it("refuses an attribution domain past ATTRIBUTION_DOMAIN_BYTES", async () => {
    const h = await aliceSession();
    const patch = (body: Record<string, unknown>) =>
      h.request("/api/v1/accounts/update_credentials", bearer(h.token, json(body, { method: "PATCH" })));
    // Compliant hosts padded with U+00AD (two UTF-8 bytes), which IDNA drops, in labels of 63 characters as written
    // (a and 62 U+00AD): bcde.a.a.a.a.a.a.a.a.example and bcdef.a.a.a.a.a.a.a.a.example.
    const padded = `${Array.from({ length: 8 }, () => `a${"\u00ad".repeat(62)}`).join(".")}.example`;
    const over = `bcdef.${padded}`;
    const at = `bcde.${padded}`;
    expect([over, at].map((domain) => new TextEncoder().encode(domain).length)).toEqual([
      ATTRIBUTION_DOMAIN_BYTES + 1,
      ATTRIBUTION_DOMAIN_BYTES,
    ]);
    const refused = await patch({ attribution_domains: ["ok.example", over] });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({
      error: `Validation failed: Attribution domains ${over} is not a valid domain name`,
    });
    const accepted = await patch({ attribution_domains: ["ok.example", at] });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ source: { attribution_domains: ["ok.example", at] } });
    const verified = await h.request("/api/v1/accounts/verify_credentials", bearer(h.token));
    expect(await verified.json()).toMatchObject({ source: { attribution_domains: ["ok.example", at] } });
  });

  // Account::DISPLAY_NAME_LENGTH_LIMIT (Mastodon 4.6, `mastodon#39458`): 40 code points, whatever plane they are in.
  it("accepts a display name of 40 code points and refuses 41", async () => {
    const h = await aliceSession();
    const patch = (display_name: string) =>
      h.request("/api/v1/accounts/update_credentials", bearer(h.token, json({ display_name }, { method: "PATCH" })));
    const forty = "😀".repeat(40);
    const accepted = await patch(forty);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ display_name: forty });
    const stored = () => sql(h.store, "SELECT display_name FROM accounts WHERE id = ?", h.aliceId);
    expect(await stored()).toEqual([{ display_name: forty }]);
    for (const value of ["😀".repeat(41), "x".repeat(41), `${"😀".repeat(20)}${"x".repeat(21)}`]) {
      const refused = await patch(value);
      expect(refused.status, value).toBe(422);
      expect(await refused.json()).toMatchObject({
        error: "Validation failed: Display name is too long (maximum is 40 characters)",
      });
    }
    expect(await stored()).toEqual([{ display_name: forty }]);
  });

  // Account#prepare_contents strips the display name and the note before validating and storing them, as Ruby's
  // String#strip strips: NUL, tab, LF, VT, FF, CR and space at either end, and no other whitespace. A NUL inside is
  // one of the code points counted and is dropped when stored.
  it("strips the display name and the note as Mastodon does before counting and storing them", async () => {
    const h = await aliceSession();
    const patch = (body: Record<string, string>) =>
      h.request("/api/v1/accounts/update_credentials", bearer(h.token, json(body, { method: "PATCH" })));
    const stored = () => sql(h.store, "SELECT display_name, note FROM accounts WHERE id = ?", h.aliceId);
    const ends = "\u0000\t\n\v\f\r ";
    for (const [i, [before, after]] of [
      ["", "\u0000"],
      ["", " "],
      [ends, ends],
    ].entries()) {
      const name = `${"😀".repeat(39)}${i}`;
      const note = `${"x".repeat(499)}${i}`;
      const response = await patch({ display_name: `${before}${name}${after}`, note: `${before}${note}${after}` });
      expect(response.status, JSON.stringify([before, after])).toBe(200);
      expect(await response.json()).toMatchObject({ display_name: name, source: { note } });
      expect(await stored()).toEqual([{ display_name: name, note: `<p>${note}</p>` }]);
    }
    const kept = await stored();
    // Other whitespace is kept and counted (it is not Ruby's to strip), and so is a NUL inside.
    for (const value of [
      `${"😀".repeat(40)}\u3000`,
      `\u00a0${"😀".repeat(40)}`,
      `${"😀".repeat(20)}\u0000${"😀".repeat(20)}`,
    ]) {
      const refused = await patch({ display_name: value });
      expect(refused.status, JSON.stringify(value)).toBe(422);
      expect(await refused.json()).toMatchObject({
        error: "Validation failed: Display name is too long (maximum is 40 characters)",
      });
    }
    const note = await patch({ note: `${"x".repeat(500)}\u3000` });
    expect(note.status).toBe(422);
    expect(await note.json()).toMatchObject({
      error: "Validation failed: Note is too long (maximum is 500 characters)",
    });
    expect(await stored()).toEqual(kept);
    expect((await patch({ display_name: `${"😀".repeat(20)}\u0000${"😀".repeat(19)}` })).status).toBe(200);
    expect(await stored()).toMatchObject([{ display_name: "😀".repeat(39) }]);
  });

  // The strip is linear (platform/strip.ts): a run inside one value filling the body (API_BODY_LIMIT) is read within a
  // generous time, with an invalid token (checked after the values are read) and with alice's, whose 422 shows the
  // value reached its check.
  it.each([
    ["display_name", (value: string) => ({ display_name: value }), "Display name is too long"],
    ["note", (value: string) => ({ note: value }), "Note is too long"],
    ["attribution_domains", (value: string) => ({ attribution_domains: [value] }), "is not a valid domain name"],
  ])("reads %s filling the body within a generous time", async (_name, body, problem) => {
    const h = await aliceSession();
    const value = `x${" ".repeat(API_BODY_LIMIT - JSON.stringify(body("xx")).length)}x`;
    expect(JSON.stringify(body(value))).toHaveLength(API_BODY_LIMIT);
    for (const [token, status] of [
      ["nope", 401],
      [h.token, 422],
    ] as const) {
      const started = performance.now();
      const init = bearer(token, json(body(value), { method: "PATCH" }));
      const response = await h.request("/api/v1/accounts/update_credentials", init);
      expect(performance.now() - started).toBeLessThan(2000);
      expect(response.status).toBe(status);
      if (status === 422) {
        expect((await response.json<{ error: string }>()).error).toContain(problem);
      }
    }
  });

  // Mastodon's TextFormatter for a local note (app/lib/text_formatter.rb:34, :48): '' for a blank note, else Rails'
  // simple_format (split_paragraphs), which trims no paragraph or line: what Ruby's strip leaves is kept, Unicode spaces
  // included, and source.note gives it back. A blank note is stored empty (docs/mastodon-deviations.md).
  it("keeps a note's whitespace as Mastodon formats it, and stores a blank one empty", async () => {
    const h = await aliceSession();
    for (const [sent, source, html] of [
      [" bio\u3000", "bio\u3000", "<p>bio\u3000</p>"],
      ["a\n\n\u3000\n\nb", "a\n\n\u3000\n\nb", "<p>a</p><p>\u3000</p><p>b</p>"],
      ["a \n b \n\n\u00a0c", "a \n b \n\n\u00a0c", "<p>a <br> b </p><p>\u00a0c</p>"],
      ["x", "x", "<p>x</p>"],
      ["\u3000\u0085\n\n\u00a0", "", ""],
    ]) {
      const response = await h.request(
        "/api/v1/accounts/update_credentials",
        bearer(h.token, json({ note: sent }, { method: "PATCH" })),
      );
      expect(response.status, JSON.stringify(sent)).toBe(200);
      expect(await response.json(), JSON.stringify(sent)).toMatchObject({ note: html, source: { note: source } });
      expect(await sql(h.store, "SELECT note FROM accounts WHERE id = ?", h.aliceId)).toEqual([{ note: html }]);
      const me = await h.request("/api/v1/accounts/verify_credentials", bearer(h.token));
      expect(await me.json()).toMatchObject({ note: html, source: { note: source } });
    }
  });

  it("refuses invalid values without changing anything", async () => {
    const h = await aliceSession();
    for (const body of [{ note: "x".repeat(501) }, { source: { privacy: "secret" } }]) {
      const response = await h.request(
        "/api/v1/accounts/update_credentials",
        bearer(h.token, json(body, { method: "PATCH" })),
      );
      expect(response.status, JSON.stringify(body)).toBe(422);
    }
    const me = await h.request("/api/v1/accounts/verify_credentials", bearer(h.token));
    expect(await me.json()).toMatchObject({ display_name: "Alice", source: { privacy: "public" } });
  });
});

// update_credentials' 422 as Mastodon 4.7.5 answers it (ValidationErrorFormatter, app/lib/validation_error_formatter.rb):
// the bodies below are M1's, byte for byte, each a request that changed nothing there.
describe("update_credentials validation errors", () => {
  const M1 = {
    note: '{"error":"Validation failed: Note is too long (maximum is 500 characters)","details":{"note":[{"error":"ERR_TOO_LONG","description":"is too long (maximum is 500 characters)"}]}}',
    domain:
      '{"error":"Validation failed: Attribution domains exa mple.com is not a valid domain name","details":{"attribution_domains":[{"error":"ERR_INVALID_DOMAIN_ON_LINE","description":"exa mple.com is not a valid domain name"}]}}',
    avatar:
      '{"error":"Validation failed: Avatar content type is invalid, Avatar is invalid","details":{"avatar_content_type":[{"error":"ERR_INVALID","description":"is invalid"}],"avatar":[{"error":"ERR_IS INVALID","description":"is invalid"}]}}',
    fields:
      '{"error":"Validation failed: Fields is too long (maximum is 4 characters)","details":{"fields":[{"error":"ERR_TOO_LONG","description":"is too long (maximum is 4 characters)"}]}}',
    label:
      '{"error":"Validation failed: Fields contains values with missing labels","details":{"fields":[{"error":"ERR_FIELDS_WITH_VALUES_MISSING_LABELS","description":"contains values with missing labels"}]}}',
    text: '{"error":"Validation failed: Avatar description is too long (maximum is 150 characters), Note is too long (maximum is 500 characters), Fields is too long (maximum is 4 characters), Fields contains values with missing labels","details":{"avatar_description":[{"error":"ERR_TOO_LONG","description":"is too long (maximum is 150 characters)"}],"note":[{"error":"ERR_TOO_LONG","description":"is too long (maximum is 500 characters)"}],"fields":[{"error":"ERR_TOO_LONG","description":"is too long (maximum is 4 characters)"},{"error":"ERR_FIELDS_WITH_VALUES_MISSING_LABELS","description":"contains values with missing labels"}]}}',
  };

  async function refused(h: ApiHarness & { token: string }, init: RequestInit): Promise<string> {
    const before = await (await h.request("/api/v1/accounts/verify_credentials", bearer(h.token))).text();
    const response = await h.request("/api/v1/accounts/update_credentials", bearer(h.token, init));
    expect(response.status).toBe(422);
    const body = await response.text();
    expect(await (await h.request("/api/v1/accounts/verify_credentials", bearer(h.token))).text()).toBe(before);
    return body;
  }

  it("answers validation errors with Mastodon's details", async () => {
    const h = await aliceSession();
    const patch = (body: Record<string, unknown>) => json(body, { method: "PATCH" });
    const thirtyOne = "a".repeat(31);
    expect(await refused(h, patch({ note: "b".repeat(501) }))).toBe(M1.note);
    const five = ["a", "b", "c", "d", "e"].map((name, i) => ({ name, value: String(i + 1) }));
    expect(await refused(h, patch({ fields_attributes: five }))).toBe(M1.fields);
    expect(await refused(h, patch({ fields_attributes: [{ name: " ", value: "x" }] }))).toBe(M1.label);
    const text = {
      note: "b".repeat(501),
      display_name: thirtyOne,
      fields_attributes: [{ name: "", value: "x" }, ...five.slice(1)],
      avatar_description: "d".repeat(1600),
    };
    expect(await refused(h, patch(text))).toBe(M1.text);
    expect(
      await refused(h, patch({ display_name: thirtyOne, attribution_domains: ["exa mple.com", "ok.example"] })),
    ).toBe(M1.domain);
    const avatar = new FormData();
    avatar.set("avatar", new File(["not an image"], "x.txt", { type: "text/plain" }));
    avatar.set("display_name", thirtyOne);
    expect(await refused(h, { method: "PATCH", body: avatar })).toBe(M1.avatar);
  });

  // Account::Avatar's validations (the file's content type and size, as Paperclip adds them, then its description's),
  // Account::Header's, Account::AttributionDomains', then the display name, the note and the fields (account.rb:33-50,
  // 131-134), then Kopje's own refusals of the user's settings.
  it("orders problems as Mastodon validates", async () => {
    const h = await aliceSession();
    const body = new FormData();
    body.set("source[language]", "english");
    body.set("source[quote_policy]", "everyone");
    body.set("source[privacy]", "secret");
    for (let i = 0; i < 5; i++) {
      body.set(`fields_attributes[${i}][name]`, i === 0 ? "" : `n${i}`);
      body.set(`fields_attributes[${i}][value]`, "v");
    }
    body.set("note", "b".repeat(501));
    body.set("display_name", "a".repeat(41));
    body.append("attribution_domains[]", "a b");
    body.set("header_description", "d".repeat(151));
    body.set("avatar_description", "d".repeat(151));
    body.set("header", new File(["not an image"], "h.txt"));
    body.set("avatar", new File([new Uint8Array(PROFILE_IMAGE_LIMIT)], "a.bin"));
    const answer = JSON.parse(await refused(h, { method: "PATCH", body })) as ValidationBody;
    expect(answer.error.slice("Validation failed: ".length).split(", ")).toEqual([
      "Avatar content type is invalid",
      "Avatar is invalid",
      "Avatar must be less than 8 MB",
      "Avatar file size must be less than 8 MB",
      "Avatar description is too long (maximum is 150 characters)",
      "Header content type is invalid",
      "Header is invalid",
      "Header description is too long (maximum is 150 characters)",
      "Attribution domains a b is not a valid domain name",
      "Display name is too long (maximum is 40 characters)",
      "Note is too long (maximum is 500 characters)",
      "Fields is too long (maximum is 4 characters)",
      "Fields contains values with missing labels",
      "Privacy is not included in the list",
      "Quote policy is not included in the list",
      "Language is not a valid language code",
    ]);
    expect(Object.keys(answer.details)).toEqual([
      "avatar_content_type",
      "avatar",
      "avatar_file_size",
      "avatar_description",
      "header_content_type",
      "header",
      "header_description",
      "attribution_domains",
      "display_name",
      "note",
      "fields",
      "privacy",
      "quote_policy",
      "language",
    ]);
    expect(answer.details.avatar).toEqual([
      { error: "ERR_IS INVALID", description: "is invalid" },
      { error: "ERR_LESS_THAN", description: "must be less than 8 MB" },
    ]);
  }, 60_000);

  // NoteLengthValidator through update_credentials: each pair is the last count Mastodon 4.7.5 accepts and the first it
  // refuses (M1; test/status-text.test.ts pins the counts), the refusal with M1's body.
  it("counts a note as NoteLengthValidator", async () => {
    const h = await aliceSession();
    const a = (n: number) => "a".repeat(n);
    const patch = (note: string) =>
      h.request("/api/v1/accounts/update_credentials", bearer(h.token, json({ note }, { method: "PATCH" })));
    for (const [accepted, refusedNote] of [
      ["é".repeat(500), "é".repeat(501)],
      [`x https://example.com/path ${a(475)}`, `x https://example.com/path ${a(476)}`],
      [`@verifier@example.com ${a(490)}`, `@verifier@example.com ${a(491)}`],
      [`@verifier@x ${a(490)}`, `@verifier@x ${a(491)}`],
      [`@verifier@Ⅳ ${a(490)}`, `@verifier@Ⅳ ${a(491)}`],
      [`Ⅳ@verifier@x ${a(487)}`, `Ⅳ@verifier@x ${a(488)}`],
      [`@verifier@Ⓐ ${a(490)}`, `@verifier@Ⓐ ${a(491)}`],
      [`Ⓐ@verifier@x ${a(487)}`, `Ⓐ@verifier@x ${a(488)}`],
      [`‌@verifier@x ${a(487)}`, `‌@verifier@x ${a(488)}`],
      [`@verifier@x‌y ${a(490)}`, `@verifier@x‌y ${a(491)}`],
    ]) {
      const saved = await patch(accepted!);
      expect(saved.status, accepted).toBe(200);
      expect(await saved.json(), accepted).toMatchObject({ source: { note: accepted } });
      const refusal = await patch(refusedNote!);
      expect(refusal.status, refusedNote).toBe(422);
      expect(await refusal.text(), refusedNote).toBe(
        '{"error":"Validation failed: Note is too long (maximum is 500 characters)","details":{"note":[{"error":"ERR_TOO_LONG","description":"is too long (maximum is 500 characters)"}]}}',
      );
    }
  });

  // The note as sent is refused past MAX_RAW_LENGTH UTF-16 code units, the bound of a status's text, before it is
  // parsed: three links of '&' count 69 characters whatever their length.
  it("refuses a note past the raw bound before parsing it", async () => {
    const h = await aliceSession();
    const link = (length: number) => "https://example.com/".padEnd(length, "&");
    const patch = (note: string) =>
      h.request("/api/v1/accounts/update_credentials", bearer(h.token, json({ note }, { method: "PATCH" })));
    const at = [link(3332), link(3333), link(3333)].join(" ");
    const over = [link(3333), link(3333), link(3333)].join(" ");
    expect([at.length, over.length]).toEqual([MAX_RAW_LENGTH, MAX_RAW_LENGTH + 1]);
    expect(noteLength(at)).toBe(69);
    expect((await patch(at)).status).toBe(200);
    const refusal = await patch(over);
    expect(refusal.status).toBe(422);
    expect(await refusal.json()).toMatchObject({
      error: "Validation failed: Note is too long (maximum is 500 characters)",
    });
    const me = await h.request("/api/v1/accounts/verify_credentials", bearer(h.token));
    expect(await me.json()).toMatchObject({ source: { note: at } });
  });

  // The 422 echoes each invalid attribution domain twice (its message and its details), at most MAX_ATTRIBUTION_DOMAINS
  // of them. Its maximum: every other problem credentialChanges and profileFiles can report, once each, the reported
  // domains' entries without their text (both read from the formatter's own output), and the text itself, at most the
  // form text readParams admits (API_BODY_LIMIT), each byte at most 6 in JSON (a control character as \u00XX), twice.
  const DOMAIN = "attribution_domains[]";
  const domainLine = / is not a valid domain name$/;

  async function invalidDomainMaximum(): Promise<number> {
    const many = (n: number) => Array.from({ length: n }, (_, i): [string, string] => [DOMAIN, `z${i}\u0001`]);
    const entries: [string, string][] = [
      ["avatar_description", "d".repeat(151)],
      ["header_description", "d".repeat(151)],
      ...many(MAX_ATTRIBUTION_DOMAINS + 1),
      ["display_name", "a".repeat(41)],
      ["note", "b".repeat(501)],
      ...Array.from({ length: 5 }, (_, i): [string, string][] => [
        [`fields_attributes[${i}][name]`, i === 0 ? "" : `n${i}`],
        [`fields_attributes[${i}][value]`, "v"],
      ]).flat(),
      ["source[privacy]", "secret"],
      ["source[quote_policy]", "everyone"],
      ["source[language]", "english"],
    ];
    const big = (name: string) => new File([new Uint8Array(PROFILE_IMAGE_LIMIT)], name);
    const p = new Params(
      entries,
      new Map([
        ["avatar", big("a")],
        ["header", big("h")],
      ]),
    );
    const files = await profileFiles(p);
    if (files === "string") {
      throw new Error("files read as text");
    }
    const { problems } = credentialChanges(p, files.problems);
    // Every problem the two can report together: none left out.
    const kinds = problems.map(({ attribute, type }) => `${attribute} ${type}`);
    expect([...new Set(kinds)]).toEqual([
      "avatar_content_type invalid",
      "avatar is invalid",
      "avatar less_than",
      "avatar_file_size less_than",
      "avatar_description too_long",
      "header_content_type invalid",
      "header is invalid",
      "header less_than",
      "header_file_size less_than",
      "header_description too_long",
      "attribution_domains invalid_domain_on_line",
      "attribution_domains too_long",
      "display_name too_long",
      "note too_long",
      "fields too_long",
      "fields fields_with_values_missing_labels",
      "privacy inclusion",
      "quote_policy inclusion",
      "language invalid",
    ]);
    const reported = problems.filter((problem) => problem.type === "invalid_domain_on_line");
    expect(reported).toHaveLength(MAX_ATTRIBUTION_DOMAINS);
    const textless = problems.map((problem) =>
      problem.type === "invalid_domain_on_line"
        ? { ...problem, description: domainLine.exec(problem.description)![0].trimStart() }
        : problem,
    );
    return utf8Length(JSON.stringify(validationBody(textless))) + 12 * API_BODY_LIMIT;
  }

  // The witness: 101 domains through a multipart body whose form text is exactly API_BODY_LIMIT, 100 of them x<i> and
  // U+0001 filling the text, the 101st y and one U+0001; one more byte of text is refused before any check.
  function witness(extra: number): FormData {
    const prefixes = Array.from({ length: MAX_ATTRIBUTION_DOMAINS }, (_, i) => `x${i}`);
    const last = "y\u0001";
    const fixed = (MAX_ATTRIBUTION_DOMAINS + 1) * utf8Length(DOMAIN) + utf8Length(prefixes.join("")) + utf8Length(last);
    const fill = API_BODY_LIMIT - fixed + extra;
    const body = new FormData();
    prefixes.forEach((prefix, i) => {
      const share = Math.floor(fill / MAX_ATTRIBUTION_DOMAINS) + (i < fill % MAX_ATTRIBUTION_DOMAINS ? 1 : 0);
      body.append(DOMAIN, prefix + "\u0001".repeat(share));
    });
    body.append(DOMAIN, last);
    return body;
  }

  it("reports at most 100 invalid domains, within the derived maximum", async () => {
    const h = await aliceSession();
    const over = await h.request(
      "/api/v1/accounts/update_credentials",
      bearer(h.token, { method: "PATCH", body: witness(1) }),
    );
    expect(over.status).toBe(413);
    const text = await refused(h, { method: "PATCH", body: witness(0) });
    const answer = JSON.parse(text) as ValidationBody;
    const lines = answer.details.attribution_domains!;
    expect(lines).toHaveLength(MAX_ATTRIBUTION_DOMAINS + 1);
    const prefixes = lines.slice(0, -1).map((line) => {
      const [domain] = line.description.split(" ");
      return domain?.replaceAll("\u0001", "");
    });
    expect(prefixes).toEqual(Array.from({ length: MAX_ATTRIBUTION_DOMAINS }, (_, i) => `x${i}`));
    expect(lines.at(-1)).toEqual({ error: "ERR_TOO_LONG", description: "is too long (maximum is 100 characters)" });
    expect(text).not.toContain("y\\u0001");
    const maximum = await invalidDomainMaximum();
    const bytes = utf8Length(text);
    expect(bytes).toBeLessThanOrEqual(maximum);
    expect(bytes).toBeGreaterThanOrEqual(0.99 * maximum);
  }, 60_000);
});

describe("account lookup", () => {
  it("finds accounts by id and by legacy id, answering with the API id", async () => {
    const h = await apiHarness();
    const id = await seedAccount(h.store, { username: "old", legacyId: "0d3a7e4c-1b2f-4c5d-9e8f-0123456789ab" });
    expect(id).toMatch(/^\d{18}$/);

    const byId = await h.request(`/api/v1/accounts/${id}`);
    expect(await byId.json()).toMatchObject({ id, username: "old" });
    const byLegacy = await h.request("/api/v1/accounts/0d3a7e4c-1b2f-4c5d-9e8f-0123456789ab");
    expect(byLegacy.status).toBe(200);
    expect(await byLegacy.json()).toMatchObject({ id, username: "old" });

    const missing = await h.request("/api/v1/accounts/999999999999999999");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Record not found" });
  });

  it("keeps 18-digit ids exact (no number rounding)", async () => {
    const h = await apiHarness();
    const id = "109999999999999999";
    await sql(
      h.store,
      "INSERT INTO accounts (id, uri, username, domain) VALUES (?, 'https://remote.test/users/big', 'big', 'remote.test')",
      id,
    );
    const response = await h.request(`/api/v1/accounts/${id}`);
    expect(await response.text()).toContain(`"id":"${id}"`);
  });

  it("redacts a suspended account's profile as Mastodon does", async () => {
    const h = await apiHarness();
    const id = await seedAccount(h.store, { username: "gone", displayName: "Gone", locked: true });
    await sql(
      h.store,
      `UPDATE accounts SET note = '<p>bio</p>', actor_type = 'Service', discoverable = 1,
				avatar_url = 'https://cdn.test/a.png', header_url = 'https://cdn.test/h.png' WHERE id = ?`,
      id,
    );
    await sql(
      h.store,
      "UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?",
      new Date(NOW).toISOString(),
      id,
    );
    const response = await h.request(`/api/v1/accounts/${id}`);
    expect(await response.json()).toMatchObject({
      id,
      username: "gone",
      display_name: "",
      note: "",
      locked: false,
      bot: false,
      discoverable: false,
      avatar: "https://kopje.test/assets/avatar.jpg",
      avatar_static: "https://kopje.test/assets/avatar.jpg",
      header: "https://kopje.test/assets/header.jpg",
      header_static: "https://kopje.test/assets/header.jpg",
      emojis: [],
      fields: [],
      suspended: true,
    });
  });

  // Account#bot?, by the list the notification policy's bot condition reads (audience.ts).
  it("presents bot by the exact stored actor type", async () => {
    const h = await apiHarness();
    const id = await seedAccount(h.store, { username: "maybe" });
    for (const [value, label, bot] of STORED_ACTOR_TYPES) {
      await sql(h.store, `UPDATE accounts SET actor_type = ${value} WHERE id = ?`, id);
      expect(await (await h.request(`/api/v1/accounts/${id}`)).json<{ bot: boolean }>(), label).toMatchObject({
        bot,
      });
    }
  });

  // HTML-3: whatever is stored (imported or federated), only http(s) URLs leave the presenter. A remote account's
  // profile URL is then its actor id, as Mastodon stores `url || @uri`.
  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    " javascript:alert(1)",
    "data:image/png;base64,AAAA",
    "/a.png",
  ])("shows the defaults for a stored avatar and header, and the actor id for a profile URL, of %j", async (bad) => {
    const h = await apiHarness();
    const id = "444444444444444444";
    await sql(
      h.store,
      `INSERT INTO accounts (id, uri, username, domain, url, avatar_url, header_url)
				VALUES (?, 'https://remote.test/users/x', 'x', 'remote.test', ?, ?, ?)`,
      id,
      bad,
      bad,
      bad,
    );
    const response = await h.request(`/api/v1/accounts/${id}`);
    expect(await response.json()).toMatchObject({
      url: "https://remote.test/users/x",
      avatar: "https://kopje.test/assets/avatar.jpg",
      avatar_static: "https://kopje.test/assets/avatar.jpg",
      header: "https://kopje.test/assets/header.jpg",
      header_static: "https://kopje.test/assets/header.jpg",
    });
  });

  it("shows stored http(s) URLs of any scheme case, normalized", async () => {
    const h = await apiHarness();
    const id = "444444444444444444";
    await sql(
      h.store,
      `INSERT INTO accounts (id, uri, username, domain, url, avatar_url, header_url)
			VALUES (?, 'https://remote.test/users/x', 'x', 'remote.test', 'HTTPS://Remote.test/@x', 'Http://cdn.test/a.png',
				'https://cdn.test/h.png')`,
      id,
    );
    const response = await h.request(`/api/v1/accounts/${id}`);
    expect(await response.json()).toMatchObject({
      url: "https://remote.test/@x",
      avatar: "http://cdn.test/a.png",
      header: "https://cdn.test/h.png",
    });
  });

  it("looks up local and remote accounts by acct", async () => {
    const h = await apiHarness();
    const local = await seedAccount(h.store, { username: "Alice" });
    const remote = await seedAccount(h.store, { username: "bob", domain: "remote.test" });
    for (const [acct, id] of [
      ["alice", local],
      ["@alice", local],
      ["alice@kopje.test", local],
      ["bob@remote.test", remote],
      ["bob@REMOTE.test", remote],
    ] as const) {
      const response = await h.request(`/api/v1/accounts/lookup?acct=${encodeURIComponent(acct)}`);
      expect(response.status, acct).toBe(200);
      expect(await response.json(), acct).toMatchObject({ id });
    }
    expect((await h.request("/api/v1/accounts/lookup?acct=bob")).status).toBe(404);
    // Rails' params[:acct]: the last value the query gives.
    const repeated = await h.request("/api/v1/accounts/lookup?acct=nobody&acct=alice");
    expect([repeated.status, (await repeated.json<{ id?: string }>()).id]).toEqual([200, local]);
    expect((await h.request("/api/v1/accounts/lookup?acct=alice&acct=nobody")).status).toBe(404);
    const remoteAccount = await (await h.request(`/api/v1/accounts/${remote}`)).json();
    expect(remoteAccount).toMatchObject({ acct: "bob@remote.test", url: "https://remote.test/@bob" });
  });
});

describe("account search", () => {
  async function searchFixture() {
    const h = await aliceSession();
    const ids = {
      taro: await seedAccount(h.store, { username: "taro", displayName: "山田太郎" }),
      server: await seedAccount(h.store, { username: "srv", domain: "remote.test", displayName: "サーバ管理人" }),
      neko: await seedAccount(h.store, { username: "cat", domain: "remote.test", displayName: "ネコ好き" }),
      fullwidth: await seedAccount(h.store, { username: "ap", displayName: "ＡｃｔｉｖｉｔｙＰｕｂ fan" }),
    };
    const search = async (q: string, extra = "") => {
      const response = await h.request(`/api/v1/accounts/search?q=${encodeURIComponent(q)}${extra}`, bearer(h.token));
      expect(response.status).toBe(200);
      return (await response.json<Account[]>()).map((account) => account.id);
    };
    return { h, ids, search };
  }

  it("matches substrings of names and accts, including Japanese", async () => {
    const { ids, search } = await searchFixture();
    expect(await search("太郎")).toEqual([ids.taro]);
    expect(await search("サーバー")).toEqual([ids.server]);
    expect(await search("ねこ")).toEqual([ids.neko]);
    expect(await search("activitypub")).toEqual([ids.fullwidth]);
    expect(await search("srv@remote.test")).toEqual([ids.server]);
    expect(await search("nothing-here")).toEqual([]);
  });

  it("filters to followed accounts, pages with offset, and needs a token", async () => {
    const { h, ids, search } = await searchFixture();
    await h.request(`/api/v1/accounts/${ids.neko}/follow`, bearer(h.token, { method: "POST" }));
    expect(await search("remote.test")).toHaveLength(2);
    expect(await search("remote.test", "&limit=1&offset=1")).toHaveLength(1);
    // A remote follow is pending until the remote Accept arrives, so it is not "following" yet.
    expect(await search("remote.test", "&following=true")).toEqual([]);
    await sql(h.store, "UPDATE follows SET state = 'accepted'");
    expect(await search("remote.test", "&following=true")).toEqual([ids.neko]);
    expect((await h.request("/api/v1/accounts/search?q=taro")).status).toBe(401);
  });
});

describe("follow and relationships", () => {
  it("follows a local account at once and unfollows it, keeping counts", async () => {
    const h = await aliceSession();
    const bob = await seedAccount(h.store, { username: "bob" });

    const followed = await h.request(`/api/v1/accounts/${bob}/follow`, bearer(h.token, json({ notify: true })));
    expect(followed.status).toBe(200);
    expect(await followed.json()).toEqual({
      id: bob,
      following: true,
      showing_reblogs: true,
      notifying: true,
      languages: null,
      followed_by: false,
      requested_by: false,
      blocking: false,
      blocked_by: false,
      muting: false,
      muting_notifications: false,
      muting_expires_at: null,
      requested: false,
      domain_blocking: false,
      endorsed: false,
      note: "",
    });
    expect(await (await h.request(`/api/v1/accounts/${bob}`)).json()).toMatchObject({ followers_count: 1 });
    expect(await (await h.request(`/api/v1/accounts/${h.aliceId}`)).json()).toMatchObject({ following_count: 1 });

    const unfollowed = await h.request(`/api/v1/accounts/${bob}/unfollow`, bearer(h.token, { method: "POST" }));
    expect(await unfollowed.json()).toMatchObject({ following: false, requested: false });
    expect(await (await h.request(`/api/v1/accounts/${bob}`)).json()).toMatchObject({ followers_count: 0 });
  });

  it("requests a locked or remote account and leaves remote counters alone", async () => {
    const h = await aliceSession();
    const locked = await seedAccount(h.store, { username: "carol", locked: true });
    const remote = await seedAccount(h.store, { username: "dave", domain: "remote.test", followersCount: 42 });
    for (const id of [locked, remote]) {
      const response = await h.request(`/api/v1/accounts/${id}/follow`, bearer(h.token, { method: "POST" }));
      expect(await response.json()).toMatchObject({ following: false, requested: true });
    }
    expect(await (await h.request(`/api/v1/accounts/${remote}`)).json()).toMatchObject({ followers_count: 42 });
    const carol = await (await h.request(`/api/v1/accounts/${locked}`)).json();
    expect(carol).toMatchObject({ followers_count: 0 });
  });

  it("refuses following yourself, blocked accounts, and unknown ids", async () => {
    const h = await aliceSession();
    const blocker = await seedAccount(h.store, { username: "eve" });
    await sql(h.store, "INSERT INTO blocks (account_id, target_account_id) VALUES (?, ?)", blocker, h.aliceId);
    const follow = (id: string) => h.request(`/api/v1/accounts/${id}/follow`, bearer(h.token, { method: "POST" }));
    expect((await follow(h.aliceId)).status).toBe(403);
    expect((await follow(blocker)).status).toBe(403);
    expect((await follow("999999999999999999")).status).toBe(404);
  });

  it("refuses following a suspended account", async () => {
    const h = await aliceSession();
    const bob = await seedAccount(h.store, { username: "bob" });
    await sql(
      h.store,
      "UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?",
      new Date(NOW).toISOString(),
      bob,
    );
    const response = await h.request(`/api/v1/accounts/${bob}/follow`, bearer(h.token, { method: "POST" }));
    expect(response.status).toBe(404);
    expect(await sql(h.store, "SELECT 1 FROM follows")).toEqual([]);
  });

  it("refuses following an account on a domain the viewer blocks, as Mastodon's FollowService does", async () => {
    const h = await aliceSession();
    const remote = await seedAccount(h.store, { username: "dave", domain: "blocked.test" });
    await sql(h.store, "INSERT INTO domain_blocks (account_id, domain) VALUES (?, 'blocked.test')", h.aliceId);
    const response = await h.request(`/api/v1/accounts/${remote}/follow`, bearer(h.token, { method: "POST" }));
    expect(response.status).toBe(403);
    expect(await sql(h.store, "SELECT 1 FROM follows")).toEqual([]);
  });

  it("clears the languages filter with an explicitly empty list, and keeps it when absent", async () => {
    const h = await aliceSession();
    const bob = await seedAccount(h.store, { username: "bob" });
    const follow = async (init: RequestInit) =>
      (await h.request(`/api/v1/accounts/${bob}/follow`, bearer(h.token, init))).json<{ languages: unknown }>();

    expect((await follow(json({ languages: ["ja", "en"] }))).languages).toEqual(["ja", "en"]);
    expect((await follow(json({ notify: true }))).languages).toEqual(["ja", "en"]);
    expect((await follow(json({ languages: [] }))).languages).toBeNull();

    expect((await follow(json({ languages: ["ja"] }))).languages).toEqual(["ja"]);
    expect((await follow(form({ "languages[]": "" }))).languages).toBeNull();
  });
  it("recounts only when a follow call adds or removes a follow", async () => {
    const h = await aliceSession();
    const bob = await seedAccount(h.store, { username: "bob" });
    const carol = await seedAccount(h.store, { username: "carol", locked: true });
    const dave = await seedAccount(h.store, { username: "dave", domain: "remote.test", followersCount: 42 });
    // Every write of an account row, counted by a trigger of this test.
    await sql(h.store, "CREATE TABLE account_writes (id TEXT NOT NULL)");
    await sql(
      h.store,
      "CREATE TRIGGER account_writes_counted AFTER UPDATE ON accounts BEGIN INSERT INTO account_writes VALUES (NEW.id); END",
    );
    const call = async (id: string, action: "follow" | "unfollow", body: Record<string, unknown> = {}) => {
      await sql(h.store, "DELETE FROM account_writes");
      const response = await h.request(`/api/v1/accounts/${id}/${action}`, bearer(h.token, json(body)));
      expect(response.status).toBe(200);
      const writes = await sql<{ id: string }>(h.store, "SELECT id FROM account_writes ORDER BY id");
      return writes.map((row) => row.id);
    };
    const options = (id: string) =>
      sql(h.store, "SELECT show_reblogs, notify, languages FROM follows WHERE target_account_id = ?", id);
    const counts = async () => {
      const rows = await sql<{ id: string; followers_count: number; following_count: number }>(
        h.store,
        "SELECT id, followers_count, following_count FROM accounts ORDER BY id",
      );
      return Object.fromEntries(rows.map(({ id, ...row }) => [id, row]));
    };

    for (const [target, recounted] of [
      [bob, [h.aliceId, bob].toSorted()],
      [carol, [h.aliceId, carol].toSorted()],
      [dave, [h.aliceId]],
    ] as const) {
      expect(await call(target, "follow")).toEqual(recounted);
      // A repeated follow and one that only changes the options write no account row.
      expect(await call(target, "follow")).toEqual([]);
      expect(await call(target, "follow", { reblogs: false, notify: true, languages: ["ja"] })).toEqual([]);
      expect(await options(target)).toEqual([{ show_reblogs: 0, notify: 1, languages: '["ja"]' }]);
    }
    expect(await counts()).toEqual({
      [h.aliceId]: { followers_count: 0, following_count: 1 },
      [bob]: { followers_count: 1, following_count: 0 },
      [carol]: { followers_count: 0, following_count: 0 },
      [dave]: { followers_count: 42, following_count: 0 },
    });

    for (const [target, recounted] of [
      [bob, [h.aliceId, bob].toSorted()],
      [carol, [h.aliceId, carol].toSorted()],
      [dave, [h.aliceId]],
    ] as const) {
      expect(await call(target, "unfollow")).toEqual(recounted);
      // An unfollow of an account not followed writes no account row, and still ends a stray follow notification.
      if (target !== dave) {
        await sql(
          h.store,
          "INSERT INTO notifications (account_id, type, from_account_id) VALUES (?, 'follow', ?)",
          target,
          h.aliceId,
        );
      }
      expect(await call(target, "unfollow")).toEqual([]);
    }
    expect(await sql(h.store, "SELECT 1 FROM follows")).toEqual([]);
    expect(await sql(h.store, "SELECT 1 FROM notifications")).toEqual([]);
    expect(await counts()).toEqual({
      [h.aliceId]: { followers_count: 0, following_count: 0 },
      [bob]: { followers_count: 0, following_count: 0 },
      [carol]: { followers_count: 0, following_count: 0 },
      [dave]: { followers_count: 42, following_count: 0 },
    });
  });

  it("answers relationships for several ids, legacy ids included", async () => {
    const h = await aliceSession();
    const bob = await seedAccount(h.store, { username: "bob", legacyId: "legacy-bob" });
    const carol = await seedAccount(h.store, { username: "carol" });
    await sql(
      h.store,
      "INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
      carol,
      h.aliceId,
    );
    await h.request(`/api/v1/accounts/${bob}/follow`, bearer(h.token, json({ reblogs: false, languages: ["ja"] })));

    const response = await h.request(
      `/api/v1/accounts/relationships?id[]=legacy-bob&id[]=${carol}&id[]=999999999999999999`,
      bearer(h.token),
    );
    expect(await response.json()).toEqual([
      expect.objectContaining({
        id: bob,
        following: true,
        showing_reblogs: false,
        languages: ["ja"],
        followed_by: false,
      }),
      expect.objectContaining({ id: carol, following: false, followed_by: true }),
    ]);
  });
});

describe("relationships of unavailable accounts (R1, with_suspended)", () => {
  // A suspended local account, an account the instance suspended, one being deleted and one on a suspended domain,
  // each followed and noted by alice: Mastodon's Account.without_suspended leaves them out unless with_suspended.
  async function unavailableWorld() {
    const h = await aliceSession();
    const available = await seedAccount(h.store, { username: "bob" });
    const local = await seedAccount(h.store, { username: "carol" });
    const suspended = await seedAccount(h.store, { username: "dave", domain: "remote.test" });
    const deleting = await seedAccount(h.store, { username: "erin", domain: "remote.test" });
    const covered = await seedAccount(h.store, { username: "frank", domain: "covered.test" });
    const unavailable = [local, suspended, deleting, covered];
    for (const id of [available, ...unavailable]) {
      await sql(
        h.store,
        "INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
        h.aliceId,
        id,
      );
      await sql(
        h.store,
        "INSERT INTO account_notes (account_id, target_account_id, comment) VALUES (?, ?, 'n')",
        h.aliceId,
        id,
      );
    }
    await sql(
      h.store,
      "UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?",
      new Date(NOW).toISOString(),
      local,
    );
    await sql(
      h.store,
      "UPDATE accounts SET suspended_at = ?, suspension_source = 'account' WHERE id = ?",
      new Date(NOW).toISOString(),
      suspended,
    );
    await sql(h.store, "UPDATE accounts SET deleted_at = ? WHERE id = ?", new Date(NOW).toISOString(), deleting);
    await blockDomain(h.store, "covered.test");
    return { ...h, available, unavailable };
  }

  const relationshipsOf = async (h: ApiHarness & { token: string }, ids: string[], suffix = "") => {
    const query = ids.map((id) => `id[]=${id}`).join("&");
    const response = await h.request(`/api/v1/accounts/relationships?${query}${suffix}`, bearer(h.token));
    expect(response.status).toBe(200);
    return response.json<{ id: string; following: boolean; note: string }[]>();
  };

  it("leaves unavailable accounts out by default and with a false with_suspended", async () => {
    const h = await unavailableWorld();
    for (const suffix of ["", "&with_suspended=false", "&with_suspended=0"]) {
      const entries = await relationshipsOf(h, [...h.unavailable, h.available], suffix);
      expect(entries.map((entry) => entry.id)).toEqual([h.available]);
    }
    expect(await relationshipsOf(h, h.unavailable)).toEqual([]);
  });

  // But one whose deletion has started, which the account reads do not find (foundSql; Mastodon 4.7's
  // without_requested_deletion, whatever with_suspended).
  it("includes them, in request order and once each, with a true with_suspended, but a deleting one", async () => {
    const h = await unavailableWorld();
    const deleting = h.unavailable[2]!;
    const requested = [h.unavailable[3]!, h.available, ...h.unavailable, h.unavailable[0]!];
    for (const suffix of ["&with_suspended=true", "&with_suspended=1"]) {
      const entries = await relationshipsOf(h, requested, suffix);
      expect(entries.map((entry) => entry.id)).toEqual([...new Set(requested)].filter((id) => id !== deleting));
      for (const entry of entries) {
        expect(entry).toMatchObject({ following: true, note: "n" });
      }
    }
  });

  it("includes an account on a domain the viewer blocks, which only marks it (Mastodon's domain_blocking)", async () => {
    const h = await aliceSession();
    const remote = await seedAccount(h.store, { username: "dave", domain: "blocked.test" });
    await domainBlock(h.store, h.aliceId, "blocked.test");
    expect(await relationshipsOf(h, [remote])).toEqual([
      expect.objectContaining({ id: remote, domain_blocking: true }),
    ]);
  });
});

describe("follower lists", () => {
  async function popular(count: number) {
    const h = await apiHarness();
    const star = await seedAccount(h.store, { username: "star" });
    const fans: string[] = [];
    for (let i = 0; i < count; i++) {
      const fan = await seedAccount(h.store, { username: `fan${i}` });
      await sql(
        h.store,
        "INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
        fan,
        star,
      );
      fans.push(fan);
    }
    await sql(
      h.store,
      "INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'pending')",
      star,
      fans[0]!,
    );
    return { h, star, fans };
  }

  function links(response: Response): Record<string, string> {
    const header = response.headers.get("link") ?? "";
    return Object.fromEntries(
      [...header.matchAll(/<([^>]+)>; rel="(\w+)"/g)].map((match) => [
        match[2]!,
        match[1]!.replace("https://kopje.test", ""),
      ]),
    );
  }

  it("pages followers newest first with max_id and min_id links", async () => {
    const { h, star, fans } = await popular(5);
    const newestFirst = [...fans].toReversed();

    const first = await h.request(`/api/v1/accounts/${star}/followers?limit=2`);
    expect((await first.json<Account[]>()).map((a) => a.id)).toEqual(newestFirst.slice(0, 2));
    const firstLinks = links(first);
    expect(firstLinks).toEqual({
      next: `/api/v1/accounts/${star}/followers?limit=2&max_id=4`,
      prev: `/api/v1/accounts/${star}/followers?limit=2&min_id=5`,
    });

    const second = await h.request(firstLinks.next!);
    expect((await second.json<Account[]>()).map((a) => a.id)).toEqual(newestFirst.slice(2, 4));
    const back = await h.request(links(second).prev!);
    expect((await back.json<Account[]>()).map((a) => a.id)).toEqual(newestFirst.slice(0, 2));

    const last = await h.request(`/api/v1/accounts/${star}/followers?limit=2&max_id=2`);
    expect((await last.json<Account[]>()).map((a) => a.id)).toEqual(newestFirst.slice(4));
    expect(Object.keys(links(last))).toEqual(["prev"]);

    const since = await h.request(`/api/v1/accounts/${star}/followers?since_id=3`);
    expect((await since.json<Account[]>()).map((a) => a.id)).toEqual(newestFirst.slice(0, 2));

    const empty = await h.request(`/api/v1/accounts/${star}/followers?min_id=5`);
    expect(await empty.json()).toEqual([]);
    expect(empty.headers.get("link")).toBeNull();
  });

  it("lists following without pending requests and 404s unknown accounts", async () => {
    const { h, star, fans } = await popular(2);
    const following = await h.request(`/api/v1/accounts/${fans[1]}/following`);
    expect((await following.json<Account[]>()).map((a) => a.id)).toEqual([star]);
    const pending = await h.request(`/api/v1/accounts/${star}/following`);
    expect(await pending.json()).toEqual([]);
    expect((await h.request("/api/v1/accounts/999999999999999999/followers")).status).toBe(404);
  });
});

describe("follower lists for the viewer (R13)", () => {
  // carol is followed by alice, bob, dave and the remote erin, and follows them all.
  async function network() {
    const h = await community(["alice", "bob", "carol", "dave"]);
    const { alice, bob, carol, dave } = h.users;
    const erin = await seedAccount(h.store, { username: "erin", domain: "remote.example" });
    for (const user of [alice, bob, dave]) {
      await follow(h, user, carol.id);
      await follow(h, carol, user.id);
    }
    await remoteFollows(h.store, erin, carol.id);
    await sql(
      h.store,
      "INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
      carol.id,
      erin,
    );
    const ids = async (direction: "followers" | "following", token?: string) =>
      (await listIds(h, `/api/v1/accounts/${carol.id}/${direction}`, token)).toSorted();
    return { h, erin, ids };
  }

  it("leaves out, for a signed-in viewer, the accounts they block, mute or are blocked by", async () => {
    const { h, erin, ids } = await network();
    const { alice, bob, carol, dave } = h.users;
    await block(h.store, alice.id, bob.id);
    await mute(h.store, alice.id, dave.id);
    await block(h.store, erin, alice.id);
    // A domain block is not a reason (Mastodon leaves out accounts only).
    await domainBlock(h.store, alice.id, "remote.example");
    for (const direction of ["followers", "following"] as const) {
      expect(await ids(direction, alice.token)).toEqual([alice.id].toSorted());
      expect(await ids(direction)).toEqual([alice.id, bob.id, dave.id, erin].toSorted());
      // The owner sees every entry, whatever it blocks or mutes.
      expect(await ids(direction, carol.token)).toEqual([alice.id, bob.id, dave.id, erin].toSorted());
    }
    // A mute that has expired no longer applies.
    await sql(
      h.store,
      "UPDATE mutes SET expires_at = ? WHERE account_id = ?",
      new Date(NOW - 1000).toISOString(),
      alice.id,
    );
    expect(await ids("followers", alice.token)).toEqual([alice.id, dave.id].toSorted());
  });

  it("lists a suspended account, redacted", async () => {
    const { h, ids } = await network();
    const { bob, carol } = h.users;
    await sql(h.store, "UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?", "2026-01-01", bob.id);
    const { body } = await getJson<{ id: string; suspended?: boolean }[]>(h, `/api/v1/accounts/${carol.id}/followers`);
    expect(body.find((account) => account.id === bob.id)).toMatchObject({ suspended: true, display_name: "" });
    expect(await ids("following")).toContain(bob.id);
  });

  it("lists nothing of a suspended account, of one that blocks the viewer, or that hides its network", async () => {
    const { h, ids } = await network();
    const { alice, bob, carol } = h.users;
    await block(h.store, carol.id, alice.id);
    for (const direction of ["followers", "following"] as const) {
      expect(await ids(direction, alice.token)).toEqual([]);
      expect(await ids(direction, bob.token)).not.toEqual([]);
    }

    const hide = await h.request(
      "/api/v1/accounts/update_credentials",
      bearer(carol.token, json({ hide_collections: true }, { method: "PATCH" })),
    );
    expect(hide.status).toBe(200);
    for (const direction of ["followers", "following"] as const) {
      expect(await ids(direction, bob.token)).toEqual([]);
      expect(await ids(direction)).toEqual([]);
      // The owner still sees its own.
      expect(await ids(direction, carol.token)).not.toEqual([]);
    }

    await sql(
      h.store,
      "UPDATE local_accounts SET hide_collections = 0, suspended_at = ? WHERE account_id = ?",
      "2026-01-01",
      carol.id,
    );
    for (const direction of ["followers", "following"] as const) {
      expect(await ids(direction)).toEqual([]);
    }
  });

  it("reads an optional token: an invalid one or one without read:accounts is refused, an app token is anonymous", async () => {
    const { h } = await network();
    const { carol } = h.users;
    expect((await h.request(`/api/v1/accounts/${carol.id}/followers`, bearer("nope"))).status).toBe(401);
    const statusesOnly = await scopedToken(h, "read:statuses");
    expect((await h.request(`/api/v1/accounts/${carol.id}/following`, bearer(statusesOnly))).status).toBe(403);
    const app = await appToken(h);
    expect((await h.request(`/api/v1/accounts/${carol.id}/following`, bearer(app))).status).toBe(200);
  });
});

describe("edge ids beyond 2^53", () => {
  // Ids are kept as strings: as JS numbers, 2^53 + 1 and 2^53 + 3 would round to their neighbours.
  const BIG = ["9007199254740993", "9007199254740995"];

  it("pages with exact cursors", async () => {
    const h = await apiHarness();
    const star = await seedAccount(h.store, { username: "star" });
    const fans = [await seedAccount(h.store, { username: "fan0" }), await seedAccount(h.store, { username: "fan1" })];
    for (const [i, fan] of fans.entries()) {
      await sql(
        h.store,
        "INSERT INTO follows (id, account_id, target_account_id, state) VALUES (?, ?, ?, 'accepted')",
        BIG[i]!,
        fan,
        star,
      );
    }
    const first = await h.request(`/api/v1/accounts/${star}/followers?limit=1`);
    expect((await first.json<Account[]>()).map((a) => a.id)).toEqual([fans[1]]);
    const link = first.headers.get("link") ?? "";
    expect(link).toContain(`max_id=${BIG[1]}>`);
    expect(link).toContain(`min_id=${BIG[1]}>`);
    const next = await h.request(`/api/v1/accounts/${star}/followers?limit=1&max_id=${BIG[1]}`);
    expect((await next.json<Account[]>()).map((a) => a.id)).toEqual([fans[0]]);
    const newer = await h.request(`/api/v1/accounts/${star}/followers?min_id=${BIG[0]}`);
    expect((await newer.json<Account[]>()).map((a) => a.id)).toEqual([fans[1]]);
  });

  it("updates the options of an existing follow", async () => {
    const h = await aliceSession();
    const bob = await seedAccount(h.store, { username: "bob" });
    await sql(
      h.store,
      "INSERT INTO follows (id, account_id, target_account_id, state) VALUES (?, ?, ?, 'accepted')",
      BIG[0]!,
      h.aliceId,
      bob,
    );
    const response = await h.request(`/api/v1/accounts/${bob}/follow`, bearer(h.token, json({ reblogs: false })));
    expect(await response.json()).toMatchObject({ following: true, showing_reblogs: false });
  });
});
