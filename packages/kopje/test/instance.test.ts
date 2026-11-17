import { describe, expect, it } from "vitest";

import { MAX_DISPLAY_NAME, MAX_FIELD_NAME, MAX_FIELD_VALUE, MAX_FIELDS, MAX_NOTE } from "../src/domain/accounts";
import { PIN_LIMIT } from "../src/domain/activities";
import { MAX_FEATURED_TAGS } from "../src/domain/featured-tags";
import { type ApiHarness, apiHarness, bearer, json, seedAccount, setSetting, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { BUILD } from "./helpers";
import { DAY_MS } from "./read-helpers";
import { act, community, post } from "./status-helpers";

// A fixed P-256 key; only its public half appears in responses.
const VAPID_JWK = JSON.stringify({
  kty: "EC",
  crv: "P-256",
  x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
  y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0",
  d: "jpsQnnGQmL-YBIffH1136cspYG6-0iY7X1fCE9-E9LI",
});
const VAPID_PUBLIC_KEY = "BH_Nzidw9sRdQYPL7m_bS3tYBzM1e-nvE7rPbjx70VRFx_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0";

const CONFIGURATION = {
  accounts: { max_featured_tags: MAX_FEATURED_TAGS },
  statuses: { max_characters: 500, max_media_attachments: 4, characters_reserved_per_url: 23 },
  media_attachments: {
    supported_mime_types: ["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"],
    image_size_limit: 16777216,
    image_matrix_limit: 16777216,
    video_size_limit: 41943040,
    video_frame_rate_limit: 60,
    video_matrix_limit: 2304000,
  },
  polls: { max_options: 4, max_characters_per_option: 50, min_expiration: 300, max_expiration: 2629746 },
};

async function configured() {
  const h = await apiHarness({ VAPID_JWK });
  await setSetting(h.store, "title", "Kopje Test");
  await setSetting(h.store, "description", "A test instance");
  await setSetting(h.store, "contact_email", "admin@kopje.test");
  await setSetting(h.store, "rules", JSON.stringify(["Be kind", { id: "r2", text: "No spam" }, { text: "" }]));
  await seedAccount(h.store, { username: "alice" });
  await seedAccount(h.store, { username: "bob", domain: "remote.test" });
  return h;
}

const RULES = [
  { id: "1", text: "Be kind", hint: "", translations: {} },
  { id: "r2", text: "No spam", hint: "", translations: {} },
];

// v2's configuration.accounts: the constants that enforce each limit, in REST::InstanceSerializer's order (the image
// descriptions' at Mastodon's MAX_DESCRIPTION_LENGTH, PROFILE_DESCRIPTION_LIMIT). v1's has none of them.
const ACCOUNT_LIMITS = {
  max_display_name_length: MAX_DISPLAY_NAME,
  max_note_length: MAX_NOTE,
  max_avatar_description_length: 150,
  max_header_description_length: 150,
  max_featured_tags: MAX_FEATURED_TAGS,
  max_pinned_statuses: PIN_LIMIT,
  max_profile_fields: MAX_FIELDS,
  profile_field_name_limit: MAX_FIELD_NAME,
  profile_field_value_limit: MAX_FIELD_VALUE,
};

// Contract: the declared version is 4.5.0 and api_versions.mastodon is 9 (the reasoning is above MASTODON_VERSION in
// src/mastodon/instance.ts). Changing these payloads changes what clients do; update this test only together with that
// decision.
describe("instance contract", () => {
  it("freezes /api/v1/instance", async () => {
    const h = await configured();
    const response = await h.request("/api/v1/instance");
    expect(response.status).toBe(200);
    const body = await response.json<Record<string, unknown>>();
    expect(body).toEqual({
      uri: "kopje.test",
      title: "Kopje Test",
      short_description: "A test instance",
      description: "A test instance",
      email: "admin@kopje.test",
      version: "4.5.0",
      urls: { streaming_api: "wss://kopje.test" },
      stats: { user_count: 1, status_count: 0, domain_count: 1 },
      thumbnail: "https://kopje.test/assets/thumbnail.jpg",
      languages: ["en"],
      registrations: false,
      approval_required: false,
      invites_enabled: false,
      configuration: CONFIGURATION,
      contact_account: null,
      rules: RULES,
    });
    expect(body).not.toHaveProperty("api_versions");
    // REST::V1::InstanceSerializer has no wrapstodon.
    expect(body).not.toHaveProperty("wrapstodon");
  });

  it("freezes /api/v2/instance with the VAPID public key", async () => {
    const h = await configured();
    // The campaign off, so the answer holds on any date (test/annual-reports.test.ts judges the dates).
    await setSetting(h.store, "wrapstodon", "false");
    const response = await h.request("/api/v2/instance");
    expect(response.status).toBe(200);
    const body = await response.json<Record<string, unknown>>();
    expect(body).toEqual({
      domain: "kopje.test",
      title: "Kopje Test",
      version: "4.5.0",
      source_url: "https://github.com/shuymn/kopje",
      description: "A test instance",
      usage: { users: { active_month: 0 } },
      thumbnail: {
        url: "https://kopje.test/assets/thumbnail.jpg",
        description:
          "A klipspringer, a small antelope, stands on the top boulder of a granite kopje against a large amber sun, " +
          "with the dry savanna, a distant acacia and blue hills around it.",
      },
      icon: [
        { src: "https://kopje.test/assets/favicon-48.png", size: "48x48" },
        { src: "https://kopje.test/assets/favicon-192.png", size: "192x192" },
        { src: "https://kopje.test/assets/favicon-512.png", size: "512x512" },
      ],
      languages: ["en"],
      configuration: {
        urls: {
          streaming: "wss://kopje.test",
          status: null,
          about: "https://kopje.test/about",
          privacy_policy: null,
          terms_of_service: null,
        },
        vapid: { public_key: VAPID_PUBLIC_KEY },
        ...CONFIGURATION,
        accounts: ACCOUNT_LIMITS,
        media_attachments: { ...CONFIGURATION.media_attachments, description_limit: 10000 },
        translation: { enabled: false },
        timelines_access: {
          live_feeds: { local: "public", remote: "public" },
          hashtag_feeds: { local: "public", remote: "public" },
          trending_link_feeds: { local: "public", remote: "public" },
        },
        limited_federation: false,
      },
      registrations: {
        enabled: false,
        approval_required: false,
        reason_required: false,
        message: null,
        min_age: null,
        url: null,
      },
      api_versions: { mastodon: 9 },
      wrapstodon: null,
      contact: { email: "admin@kopje.test", account: null },
      rules: RULES,
    });
    // The account limits in REST::InstanceSerializer's order, which toEqual does not compare.
    const { accounts } = body.configuration as { accounts: Record<string, number> };
    expect(Object.keys(accounts)).toEqual(Object.keys(ACCOUNT_LIMITS));
  });

  it("names the privacy policy and terms of service pages on v2 only while they are available", async () => {
    const h = await configured();
    const urls = async () =>
      (await (await h.request("/api/v2/instance")).json<{ configuration: { urls: Record<string, unknown> } }>())
        .configuration.urls;
    await setSetting(h.store, "privacy_policy", "<p>Policy</p>");
    await setSetting(h.store, "terms_of_service", "<p>Terms</p>");
    expect(await urls()).toMatchObject({ privacy_policy: "https://kopje.test/privacy-policy", terms_of_service: null });
    await setSetting(h.store, "terms_of_service_effective_date", "2026-11-01");
    expect(await urls()).toMatchObject({
      privacy_policy: "https://kopje.test/privacy-policy",
      terms_of_service: "https://kopje.test/terms-of-service",
    });
    await sql(h.store, "DELETE FROM instance_settings WHERE name IN ('privacy_policy', 'terms_of_service')");
    expect(await urls()).toMatchObject({ privacy_policy: null, terms_of_service: null });
  });

  it("declares the same version on both endpoints, and api_versions on v2 only as Mastodon does", async () => {
    const h = await configured();
    const v1 = await (await h.request("/api/v1/instance")).json<Record<string, unknown>>();
    const v2 = await (await h.request("/api/v2/instance")).json<Record<string, unknown>>();
    expect(v1.version).toBe("4.5.0");
    expect(v2.version).toBe(v1.version);
    expect(v2.api_versions).toEqual({ mastodon: 9 });
    expect(v1).not.toHaveProperty("api_versions");
  });

  it("falls back to the request host before setup and to no rules", async () => {
    const h = await apiHarness();
    // rules that are no JSON array cannot be stored (0049_instance_bounds); none of these elements is a rule.
    await setSetting(h.store, "rules", JSON.stringify([1, null, { text: "" }, { text: 3 }]));
    const body = await (await h.request("/api/v2/instance")).json<Record<string, unknown>>();
    expect(body).toMatchObject({ domain: "kopje.test", title: "kopje.test", rules: [] });
    expect(body.configuration).toMatchObject({ vapid: { public_key: "" } });
  });

  it("refuses an invalid VAPID_JWK as misconfiguration", async () => {
    const h = await apiHarness({ VAPID_JWK: '{"kty":"RSA"}' });
    expect((await h.request("/api/v1/instance")).status).toBe(503);
  });

  it("has custom emojis (none yet) and a JSON 404 for unknown API routes", async () => {
    const h = await apiHarness();
    const emojis = await h.request("/api/v1/custom_emojis");
    expect(emojis.status).toBe(200);
    expect(await emojis.json()).toEqual([]);
    const unknown = await h.request("/api/v1/accounts/1/statuses/nope");
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "Record not found" });
  });
});

describe("instance account limits", () => {
  type Accounts = { configuration: { accounts: Record<string, number> } };
  const accounts = async (h: ApiHarness) =>
    (await (await h.request("/api/v2/instance")).json<Accounts>()).configuration.accounts;

  // A field's name and value past their limits are cut to them, as Account::Field#sanitize reads them, not refused.
  it("accepts each advertised limit and refuses one past it, the profile's in code points", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const limits = await accounts(h);
    const patch = async (body: Record<string, unknown>) => {
      const response = await h.request(
        "/api/v1/accounts/update_credentials",
        bearer(alice.token, json(body, { method: "PATCH" })),
      );
      return [response.status, (await response.json<{ error?: string }>()).error];
    };
    // n code points: astral characters (two UTF-16 code units each) and a NUL inside, which the strip keeps.
    const text = (n: number) => `\u{1F600}\u0000${"\u{1F600}".repeat(n - 2)}`;
    const fields = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `n${i}`, value: "v" }));
    const cases: [string, (n: number) => Record<string, unknown>, (n: number) => string][] = [
      [
        "max_display_name_length",
        (n) => ({ display_name: text(n) }),
        (n) => `Display name is too long (maximum is ${n} characters)`,
      ],
      ["max_note_length", (n) => ({ note: text(n) }), (n) => `Note is too long (maximum is ${n} characters)`],
      [
        "max_profile_fields",
        (n) => ({ fields_attributes: fields(n) }),
        (n) => `Fields is too long (maximum is ${n} characters)`,
      ],
    ];
    for (const [key, body, message] of cases) {
      const limit = limits[key]!;
      expect(await patch(body(limit)), key).toEqual([200, undefined]);
      expect(await patch(body(limit + 1)), key).toEqual([422, `Validation failed: ${message(limit)}`]);
    }
    const nameLimit = limits.profile_field_name_limit!;
    const valueLimit = limits.profile_field_value_limit!;
    expect(await patch({ fields_attributes: [{ name: text(nameLimit + 1), value: text(valueLimit + 1) }] })).toEqual([
      200,
      undefined,
    ]);
    const [row] = await sql<{ fields: string }>(h.store, "SELECT fields FROM local_accounts");
    expect(JSON.parse(row!.fields)).toEqual([{ name: text(nameLimit), value: text(valueLimit) }]);
    const tags = limits.max_featured_tags!;
    for (let i = 0; i < tags; i++) {
      expect((await act(h, alice, "/api/v1/featured_tags", { name: `t${i}` })).status).toBe(200);
    }
    const tag = await act(h, alice, "/api/v1/featured_tags", { name: "over" });
    expect([tag.status, await tag.json()]).toEqual([
      422,
      { error: "Validation failed: You have already featured the maximum number of hashtags" },
    ]);
    const pins = limits.max_pinned_statuses!;
    for (let i = 0; i <= pins; i++) {
      const status = await post(h, alice, { status: `pin ${i}` });
      const pinned = await act(h, alice, `/api/v1/statuses/${status.id}/pin`);
      expect([pinned.status, i]).toEqual([i < pins ? 200 : 422, i]);
    }
  });
});

describe("instance contact account (contact_username)", () => {
  const v1 = async (h: ApiHarness) => (await h.request("/api/v1/instance")).json<{ contact_account: unknown }>();
  const v2 = async (h: ApiHarness) => (await h.request("/api/v2/instance")).json<{ contact: unknown }>();
  const shown = async (h: ApiHarness, id: string) => (await h.request(`/api/v1/accounts/${id}`)).json();
  const idOf = async (h: ApiHarness, username: string) =>
    (await sql<{ id: string }>(h.store, "SELECT id FROM accounts WHERE username = ?", username))[0]!.id;

  it("presents the account it names on v1 and v2, and null without one", async () => {
    const h = await configured();
    expect((await v1(h)).contact_account).toBeNull();
    await setSetting(h.store, "contact_username", "alice");
    const alice = await shown(h, await idOf(h, "alice"));
    expect(alice).toMatchObject({ username: "alice", acct: "alice" });
    expect((await v1(h)).contact_account).toEqual(alice);
    expect((await v2(h)).contact).toEqual({ email: "admin@kopje.test", account: alice });
    await setSetting(h.store, "contact_username", "bob@remote.test");
    const bob = await shown(h, await idOf(h, "bob"));
    expect(bob).toMatchObject({ acct: "bob@remote.test" });
    expect((await v1(h)).contact_account).toEqual(bob);
    expect((await v2(h)).contact).toEqual({ email: "admin@kopje.test", account: bob });
  });

  it("shows a suspended contact redacted (VIS-30), and a deleted one as null", async () => {
    const h = await configured();
    const aliceId = await idOf(h, "alice");
    await setSetting(h.store, "contact_username", "alice");
    await h.store.suspendAccount(BUILD, { accountId: aliceId, now: NOW });
    expect((await v1(h)).contact_account).toMatchObject({ id: aliceId, suspended: true, display_name: "" });
    expect((await v1(h)).contact_account).toEqual(await shown(h, aliceId));
    await setSetting(h.store, "contact_username", "bob@remote.test");
    await sql(h.store, "DELETE FROM accounts WHERE id = ?", await idOf(h, "bob"));
    expect((await v1(h)).contact_account).toBeNull();
    expect((await v2(h)).contact).toEqual({ email: "admin@kopje.test", account: null });
  });
});

describe("instance usage.users.active_month", () => {
  const activeMonth = async (h: ApiHarness) =>
    (await (await h.request("/api/v2/instance")).json<{ usage: { users: { active_month: number } } }>()).usage.users
      .active_month;
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

  it("counts the available local accounts active today or on the 28 UTC days before", async () => {
    const h = await community(["alice", "bob"]);
    expect(await activeMonth(h)).toBe(0);
    // The harness waits for the work the response leaves running (waitUntil), so the day is recorded on return.
    expect((await h.request("/api/v1/preferences", bearer(h.users.alice.token))).status).toBe(200);
    expect(await activeMonth(h)).toBe(1);
    const setBob = (ms: number) =>
      sql(h.store, "UPDATE local_accounts SET active_on = ? WHERE account_id = ?", day(ms), h.users.bob.id);
    // Mastodon 4.5.21's active_user_count(4) sums the days from 28 days ago through today.
    await setBob(NOW - 28 * DAY_MS);
    expect(await activeMonth(h)).toBe(2);
    await setBob(NOW - 29 * DAY_MS);
    expect(await activeMonth(h)).toBe(1);
    await h.store.suspendAccount(BUILD, { accountId: h.users.alice.id, now: NOW });
    expect(await activeMonth(h)).toBe(0);
  });

  it("counts no later day, an imported one included, and moves the window at UTC midnight", async () => {
    const h = await community(["bob"]);
    const setBob = (value: string) =>
      sql(h.store, "UPDATE local_accounts SET active_on = ? WHERE account_id = ?", value, h.users.bob.id);
    for (const [value, counted] of [
      [day(NOW), 1],
      [day(NOW - 28 * DAY_MS), 1],
      [day(NOW - 29 * DAY_MS), 0],
      [day(NOW + DAY_MS), 0],
      ["9999-12-31", 0],
    ] as const) {
      await setBob(value);
      expect(await activeMonth(h), value).toBe(counted);
    }
    // The last instant of a day still counts its 28th day before; the next midnight drops it and counts the new day.
    await setBob(day(NOW - 28 * DAY_MS));
    h.now.mockReturnValue(NOW + DAY_MS - 1);
    expect(await activeMonth(h)).toBe(1);
    h.now.mockReturnValue(NOW + DAY_MS);
    expect(await activeMonth(h)).toBe(0);
    await setBob(day(NOW + DAY_MS));
    expect(await activeMonth(h)).toBe(1);
    h.now.mockReturnValue(NOW + DAY_MS - 1);
    expect(await activeMonth(h)).toBe(0);
  });
});

describe("instance contact read from a value past its bound", () => {
  it("answers 200 with no contact for a value that bypassed the triggers", async () => {
    const h = await configured();
    await sql(h.store, "DROP TRIGGER instance_settings_contact_insert");
    for (const value of [new Uint8Array([97, 108, 105, 99, 101]).buffer, "a".repeat(600), "a@b@c", "al ice"]) {
      await sql(
        h.store,
        "INSERT OR REPLACE INTO instance_settings (name, value) VALUES ('contact_username', ?)",
        value,
      );
      const v1 = await h.request("/api/v1/instance");
      expect(v1.status).toBe(200);
      expect(await v1.json()).toMatchObject({ contact_account: null });
      const v2 = await h.request("/api/v2/instance");
      expect(v2.status).toBe(200);
      expect(await v2.json()).toMatchObject({ contact: { email: "admin@kopje.test", account: null } });
    }
  });
});
