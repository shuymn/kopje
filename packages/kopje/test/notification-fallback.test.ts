import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { jsonBytes } from "../src/domain/answer-budget";
import {
  FALLBACK_JSON_MAX,
  FALLBACK_TYPES,
  fallbackSet,
  fallbackSummary,
  fallbackTypes,
  linkToMention,
  notificationFallback,
  reportTitle,
  WARNING_TITLE,
} from "../src/domain/notification-fallback";
import { USERNAME_LIMIT } from "../src/domain/profile-bounds";
import { DOMAIN_BYTES } from "../src/platform/identity-bounds";
import { PROFILE_URL_LIMIT } from "../src/platform/stored-bounds";
import { type ApiHarness, bearer, json, setSetting, sql, userToken } from "./api-helpers";
import { NOW } from "./app-helpers";
import { community, getJson, post, remoteAccount, type User } from "./status-helpers";

// Notification fallbacks (Mastodon 4.6's NotificationFallbackConcern, read with supported_types by
// Api::V1::NotificationsController and Api::V2::NotificationsController): which reads and types carry one, how the
// parameter is read, the texts and links (docs/mastodon-deviations.md, "Notification fallbacks"), and the most JSON
// one takes (RES-3).

type Fallback = { title: string; summary: string; description: null };
type Item = Record<string, unknown> & {
  id: string;
  type: string;
  group_key: string;
  fallback?: Fallback;
  report?: { id: string };
};
type Group = Record<string, unknown> & { type: string; fallback?: Fallback; report?: { id: string } };
type Grouped = { notification_groups: Group[] };

const ISO = new Date(NOW).toISOString();
const SUMMARY =
  "You're on an app that does not support the most recent version of Mastodon. " +
  '<a href="https://kopje.test/">Visit kopje.test</a>.';

// link_to_mention as Mastodon writes it, spelled out.
const mention = (href: string, username: string) =>
  `<span class="h-card" translate="no"><a href="${href}" class="u-url mention">@<span>${username}</span></a></span>`;

// The owner (the OAuth admin), alice and bob, local; carol and dave on remote.example. `admin` is the owner's token
// with the admin scopes.
async function world() {
  const h = await community(["owner", "alice", "bob"], "read write follow push");
  await setSetting(h.store, "admin_email", "owner@example.com");
  const admin = await userToken(h, "owner@example.com", "read write admin:read admin:write");
  const carol = await remoteAccount(h.store, "carol");
  const dave = await remoteAccount(h.store, "dave");
  return { h, admin, carol, dave, ...h.users };
}

// `user`'s report of `account`, which notifies the owner.
async function report(h: ApiHarness, user: User, account: string): Promise<string> {
  const response = await h.request("/api/v1/reports", bearer(user.token, json({ account_id: account })));
  expect(response.status).toBe(200);
  return (await response.json<{ id: string }>()).id;
}

// A remote account's report of `target` (an inbound Flag's, as migration 0054_remote_reports stores it) and its
// admin.report notification of `admin`.
async function remoteReport(h: ApiHarness, reporter: string, target: string, admin: string): Promise<string> {
  const [row] = await sql<{ id: string }>(
    h.store,
    `INSERT INTO reports (account_id, target_account_id, uri, created_at) VALUES (?, ?, ?, ?)
		RETURNING CAST(id AS TEXT) AS id`,
    reporter,
    target,
    `https://remote.example/flags/${reporter}/${target}`,
    ISO,
  );
  await sql(
    h.store,
    "INSERT INTO notifications (account_id, type, from_account_id, report_id, created_at) VALUES (?, 'admin.report', ?, ?, ?)",
    admin,
    reporter,
    row!.id,
    ISO,
  );
  return row!.id;
}

async function warn(h: ApiHarness, admin: string, target: string): Promise<void> {
  const response = await h.request(
    `/api/v1/admin/accounts/${target}/action`,
    bearer(admin, json({ type: "none", text: "please stop" })),
  );
  expect(response.status).toBe(200);
}

const READS = ["v1", "v1 show", "v2 full", "v2 partial_avatars", "v2 show"] as const;
type Read = (typeof READS)[number];

// What each of the four reads shows `token` with `query` (each item's type and fallback, newest first): the v1 list,
// each notification by its id, the v2 list in both modes and each group by its key.
async function reads(h: ApiHarness, token: string, query: string): Promise<Record<Read, [string, Fallback | null][]>> {
  const list = (await getJson<Item[]>(h, `/api/v1/notifications?${query}`, token)).body;
  const shown = (item: { type: string; fallback?: Fallback }): [string, Fallback | null] => [
    item.type,
    item.fallback ?? null,
  ];
  const groups = async (expand: string) =>
    (await getJson<Grouped>(h, `/api/v2/notifications?expand_accounts=${expand}&${query}`, token)).body
      .notification_groups;
  const each = async <T>(path: (item: Item) => string) => {
    const bodies: T[] = [];
    for (const item of list) {
      const { status, body } = await getJson<T>(h, `${path(item)}?${query}`, token);
      expect(status).toBe(200);
      bodies.push(body);
    }
    return bodies;
  };
  return {
    v1: list.map(shown),
    "v1 show": (await each<Item>((item) => `/api/v1/notifications/${item.id}`)).map(shown),
    "v2 full": (await groups("full")).map(shown),
    "v2 partial_avatars": (await groups("partial_avatars")).map(shown),
    "v2 show": (await each<Grouped>((item) => `/api/v2/notifications/${item.group_key}`)).map((body) =>
      shown(body.notification_groups[0]!),
    ),
  };
}

// The same answer from every read.
const everyRead = (expected: [string, Fallback | null][]) =>
  Object.fromEntries(READS.map((read) => [read, expected])) as Record<Read, [string, Fallback | null][]>;

// The fallbacks of the owner's admin.report notifications by report, in v1 and in v2 in both modes (each a map from
// the report's id to its fallback's title).
async function titles(h: ApiHarness, token: string): Promise<Record<string, Record<string, string | undefined>>> {
  const query = "supported_types[]=mention&limit=40";
  const v1 = (await getJson<Item[]>(h, `/api/v1/notifications?${query}`, token)).body;
  const v2 = async (expand: string) =>
    (await getJson<Grouped>(h, `/api/v2/notifications?expand_accounts=${expand}&${query}`, token)).body
      .notification_groups;
  const byReport = (items: { report?: { id: string }; fallback?: Fallback }[]) =>
    Object.fromEntries(
      items.flatMap((item) => (item.report === undefined ? [] : [[item.report.id, item.fallback?.title]])),
    );
  return { v1: byReport(v1), full: byReport(await v2("full")), partial: byReport(await v2("partial_avatars")) };
}

describe("notification fallbacks: which reads and types (NotificationFallbackConcern#needs_fallback?)", () => {
  it("gives no fallback without supported_types, and gives one with it on every read", async () => {
    const { h, owner, alice, carol } = await world();
    await report(h, alice, carol);
    await post(h, h.users.bob, { status: "@owner hello", visibility: "public" });
    expect(await reads(h, owner.token, "")).toEqual(
      everyRead([
        ["mention", null],
        ["admin.report", null],
      ]),
    );
    // Control: supported_types[] naming another type.
    const shown = await reads(h, owner.token, "supported_types[]=mention");
    expect(shown).toEqual(
      everyRead([
        ["mention", null],
        ["admin.report", { title: expect.any(String), summary: SUMMARY, description: null }],
      ]),
    );
  });

  it("gives none to a type the client lists", async () => {
    const { h, admin, owner, alice, bob, carol } = await world();
    await report(h, alice, carol);
    await warn(h, admin, bob.id);
    const query = "supported_types[]=admin.report&supported_types[]=moderation_warning";
    expect(await reads(h, owner.token, query)).toEqual(everyRead([["admin.report", null]]));
    expect(await reads(h, bob.token, query)).toEqual(everyRead([["moderation_warning", null]]));
    // Control: each listed alone leaves the other one its fallback.
    expect(await reads(h, owner.token, "supported_types[]=moderation_warning")).toEqual(
      everyRead([["admin.report", { title: expect.any(String), summary: SUMMARY, description: null }]]),
    );
    expect(await reads(h, bob.token, "supported_types[]=admin.report")).toEqual(
      everyRead([["moderation_warning", { title: WARNING_TITLE, summary: SUMMARY, description: null }]]),
    );
  });

  it("gives none to a baseline type, with one blank supported_types[] as Rack reads it", async () => {
    const { h, owner, alice, carol } = await world();
    await report(h, alice, carol);
    await post(h, h.users.bob, { status: "@owner hello", visibility: "public" });
    expect(await reads(h, owner.token, "supported_types[]=")).toEqual(
      everyRead([
        ["mention", null],
        ["admin.report", { title: expect.any(String), summary: SUMMARY, description: null }],
      ]),
    );
  });

  it("reads a scalar as Mastodon does: the type as a substring of it; an array by whole elements", async () => {
    const { h, admin, owner, alice, bob, carol } = await world();
    await report(h, alice, carol);
    await warn(h, admin, bob.id);
    const has = async (user: User, query: string) =>
      (await reads(h, user.token, query))["v1"].map(([type, fallback]) => [type, fallback !== null]);
    expect(await has(owner, "supported_types=admin.report")).toEqual([["admin.report", false]]);
    expect(await has(bob, "supported_types=admin.report")).toEqual([["moderation_warning", true]]);
    // "report" does not hold "admin.report"; "xadmin.reportx" does; an array element must equal it.
    expect(await has(owner, "supported_types=report")).toEqual([["admin.report", true]]);
    expect(await has(owner, "supported_types=xadmin.reportx")).toEqual([["admin.report", false]]);
    expect(await has(owner, "supported_types[]=xadmin.reportx")).toEqual([["admin.report", true]]);
    // Every read takes the scalar.
    expect(await reads(h, owner.token, "supported_types=xadmin.reportx")).toEqual(everyRead([["admin.report", null]]));
  });

  it("carries supported_types[] in the Link header of both lists", async () => {
    const { h, owner, alice, carol, dave } = await world();
    await report(h, alice, carol);
    await report(h, alice, dave);
    for (const path of ["/api/v1/notifications", "/api/v2/notifications"]) {
      const response = await h.request(`${path}?limit=1&supported_types[]=mention`, bearer(owner.token));
      const next = /<([^>]+)>; rel="next"/.exec(response.headers.get("link") ?? "")?.[1];
      expect(new URL(next!).searchParams.getAll("supported_types[]"), path).toEqual(["mention"]);
    }
  });

  it("places fallback after filtered, and in v2 after the page fields", async () => {
    const { h, owner, alice, carol } = await world();
    await report(h, alice, carol);
    // A restored row may hold filtered = 1 on any type; include_filtered lists it.
    await sql(h.store, "UPDATE notifications SET filtered = 1 WHERE type = 'admin.report'");
    const [filtered] = (
      await getJson<Item[]>(h, "/api/v1/notifications?include_filtered=true&supported_types[]=mention", owner.token)
    ).body;
    expect(Object.keys(filtered!)).toEqual([
      "id",
      "type",
      "created_at",
      "group_key",
      "filtered",
      "fallback",
      "account",
      "report",
    ]);
    await sql(h.store, "UPDATE notifications SET filtered = 0 WHERE type = 'admin.report'");
    const [notification] = (await getJson<Item[]>(h, "/api/v1/notifications?supported_types[]=mention", owner.token))
      .body;
    expect(Object.keys(notification!)).toEqual([
      "id",
      "type",
      "created_at",
      "group_key",
      "fallback",
      "account",
      "report",
    ]);
    const [group] = (await getJson<Grouped>(h, "/api/v2/notifications?supported_types[]=mention", owner.token)).body
      .notification_groups;
    expect(Object.keys(group!)).toEqual([
      "group_key",
      "notifications_count",
      "type",
      "most_recent_notification_id",
      "page_min_id",
      "page_max_id",
      "latest_page_notification_at",
      "fallback",
      "sample_account_ids",
      "report",
    ]);
    const [shown] = (
      await getJson<Grouped>(
        h,
        `/api/v2/notifications/${notification!.group_key}?supported_types[]=mention`,
        owner.token,
      )
    ).body.notification_groups;
    expect(Object.keys(shown!)).toEqual([
      "group_key",
      "notifications_count",
      "type",
      "most_recent_notification_id",
      "fallback",
      "sample_account_ids",
      "report",
    ]);
  });
});

describe("notification fallbacks: the texts (config/locales/en.yml, notification_fallbacks)", () => {
  it("writes Mastodon's titles and the instance link", async () => {
    const { h, admin, owner, alice, bob, carol, dave } = await world();
    const local = await report(h, alice, carol);
    const remote = await remoteReport(h, dave, alice.id, owner.id);
    // A remote target whose stored username and url hold the characters escapeHtml escapes, a quote in the url's host.
    const erin = await remoteAccount(h.store, "erin");
    await sql(
      h.store,
      "UPDATE accounts SET username = ?, url = ? WHERE id = ?",
      `a&b'c"d<e>`,
      `https://re"mote.example/@a&b'c`,
      erin,
    );
    const escaped = await report(h, alice, erin);
    expect(await titles(h, owner.token)).toEqual(
      Object.fromEntries(
        ["v1", "full", "partial"].map((read) => [
          read,
          {
            [local]: `${mention("https://kopje.test/@alice", "alice")} reported ${mention("https://remote.example/@carol", "carol")}`,
            // fallback_title names a remote reporter by its domain, plain.
            [remote]: `remote.example reported ${mention("https://kopje.test/@alice", "alice")}`,
            [escaped]: `${mention("https://kopje.test/@alice", "alice")} reported ${mention(
              "https://re&quot;mote.example/@a&amp;b&#39;c",
              "a&amp;b&#39;c&quot;d&lt;e&gt;",
            )}`,
          },
        ]),
      ),
    );
    await warn(h, admin, bob.id);
    const [warning] = (await getJson<Item[]>(h, "/api/v1/notifications?supported_types[]=mention", bob.token)).body;
    expect(warning!.fallback).toEqual({
      title: "You have received a moderation warning.",
      summary: SUMMARY,
      description: null,
    });
    const [report1] = (await getJson<Item[]>(h, "/api/v1/notifications?supported_types[]=mention", owner.token)).body;
    expect(report1!.fallback!.summary).toBe(SUMMARY);
  });

  it("links an account as Mastodon's url_for does: a remote one's stored http(s) url, a local one's short URL", async () => {
    const { h, owner, alice, bob } = await world();
    const reported: Record<string, string> = {};
    // A local target, then remote targets by their stored url.
    reported[await report(h, alice, bob.id)] = "https://kopje.test/@bob";
    const urls: [string | null, string][] = [
      ["https://remote.example/users/alice", "https://remote.example/users/alice"],
      [null, ""],
      ["", ""],
      ["ftp://remote.example/alice", ""],
      ["javascript:alert(1)", ""],
      // Within the stored bound, past PROFILE_URL_LIMIT once serialized (each quote as %22).
      [`https://remote.example/${'"'.repeat(1_000)}`, ""],
    ];
    for (const [i, [url, href]] of urls.entries()) {
      const target = await remoteAccount(h.store, `target${i}`);
      await sql(h.store, "UPDATE accounts SET url = ? WHERE id = ?", url, target);
      reported[await report(h, alice, target)] = href;
    }
    // The target's link, the last of its title; no url derived from the actor (https://remote.example/@target<i>).
    const hrefs = (shown: Record<string, string | undefined>) =>
      Object.fromEntries(
        Object.entries(shown).map(([id, title]) => [id, [...title!.matchAll(/href="([^"]*)"/g)].at(-1)![1]]),
      );
    const reporters = (shown: Record<string, string | undefined>) =>
      new Set(Object.values(shown).map((title) => /href="([^"]*)"/.exec(title!)![1]));
    for (const [read, shown] of Object.entries(await titles(h, owner.token))) {
      expect(hrefs(shown), read).toEqual(reported);
      expect(reporters(shown), read).toEqual(new Set(["https://kopje.test/@alice"]));
    }
  });

  it("names invalidated accounts by their stored fields", async () => {
    const { h, owner, alice, carol, dave } = await world();
    const erin = await remoteAccount(h.store, "erin");
    // As #1587's invalidation writes them: `! <id>`, the stored domain and url kept.
    await sql(h.store, "UPDATE accounts SET username = '! ' || id WHERE id IN (?, ?, ?)", carol, dave, erin);
    const remote = await remoteReport(h, dave, erin, owner.id);
    const local = await report(h, alice, carol);
    expect(await titles(h, owner.token)).toEqual(
      Object.fromEntries(
        ["v1", "full", "partial"].map((read) => [
          read,
          {
            [remote]: `remote.example reported ${mention("https://remote.example/@erin", `! ${erin}`)}`,
            [local]: `${mention("https://kopje.test/@alice", "alice")} reported ${mention("https://remote.example/@carol", `! ${carol}`)}`,
          },
        ]),
      ),
    );
  });

  it("squishes a username's whitespace as link_to_mention does: each run of Unicode White_Space to one space", async () => {
    const { h, owner, alice } = await world();
    // [[:space:]] as Onigmo reads it: U+0085 and U+3000 are White_Space, U+FEFF (which JavaScript's \s matches) is not.
    const [nel, ideographic, bom] = [0x85, 0x3000, 0xfeff].map((c) => String.fromCodePoint(c));
    const shown: Record<string, string> = {};
    const usernames: [stored: string, squished: string][] = [
      ["a\t  b\n c", "a b c"],
      [`\n d${nel}${ideographic}e${bom} `, ` d e${bom} `],
    ];
    for (const [i, [stored, squished]] of usernames.entries()) {
      const target = await remoteAccount(h.store, `spaced${i}`);
      await sql(h.store, "UPDATE accounts SET username = ? WHERE id = ?", stored, target);
      shown[await report(h, alice, target)] =
        `${mention("https://kopje.test/@alice", "alice")} reported ${mention(`https://remote.example/@spaced${i}`, squished)}`;
    }
    expect(await titles(h, owner.token)).toEqual(
      Object.fromEntries(["v1", "full", "partial"].map((read) => [read, shown])),
    );
  });
});

describe("notification fallbacks: the parameter and the bound (RES-3)", () => {
  it("reduces supported_types to the types needing a fallback, at most FALLBACK_TYPES", () => {
    expect(fallbackTypes(undefined)).toEqual([]);
    expect(fallbackTypes([])).toEqual(["admin.report", "moderation_warning"]);
    expect(fallbackTypes([""])).toEqual(["admin.report", "moderation_warning"]);
    expect(fallbackTypes("")).toEqual(["admin.report", "moderation_warning"]);
    expect(fallbackTypes(["admin.report"])).toEqual(["moderation_warning"]);
    expect(fallbackTypes("admin.report,moderation_warning")).toEqual([]);
    const many = Array.from({ length: 10_000 }, (_, i) => `type${i}`);
    expect(fallbackTypes(many)).toEqual(["admin.report", "moderation_warning"]);
    expect(fallbackTypes([...many, ...FALLBACK_TYPES])).toEqual([]);
    // The Store takes FALLBACK_TYPES alone from whatever it is given.
    expect([...fallbackSet(["mention", "admin.report", "admin.report", "x"])]).toEqual(["admin.report"]);
    expect([...fallbackSet("admin.report" as never)]).toEqual([]);
    expect([...fallbackSet(undefined)]).toEqual([]);
    expect([...fallbackSet(many)]).toEqual([]);
  });

  // The instance origin at its longest: https, a DNS name of DOMAIN_BYTES and a port. The API answers only on the
  // stored domain (WEB-6), which /setup and the configuration refuse past 253 octets (test/setup.test.ts "/setup step
  // 1: the domain", test/ops-authority.test.ts "stores the domain as setup does").
  const LONG_ORIGIN = `https://${["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(61)].join(".")}:65535`;

  it("derives FALLBACK_JSON_MAX, at or above every fill", async () => {
    expect(new URL(LONG_ORIGIN).hostname).toHaveLength(DOMAIN_BYTES);
    // The fixed text: the title's two links and the summary over the longest origin, which no escaping touches.
    const fixed = jsonBytes({
      title: reportTitle(linkToMention("", ""), linkToMention("", "")),
      summary: fallbackSummary(LONG_ORIGIN),
      description: null,
    });
    // Two hrefs of PROFILE_URL_LIMIT characters and two usernames of USERNAME_LIMIT bytes (byteCut), each at six bytes:
    // escapeHtml writes a quote as `&quot;`, which a URL's host may hold, and JSON a control character as `\u0001`.
    const max = fixed + 2 * 6 * PROFILE_URL_LIMIT + 2 * 6 * USERNAME_LIMIT;
    const warning = jsonBytes({ title: WARNING_TITLE, summary: fallbackSummary(LONG_ORIGIN), description: null });
    expect({ fixed, max, warning }).toEqual({ fixed: 885, max: FALLBACK_JSON_MAX, warning: 710 });
    // Fills: a remote target with a username at its bound of quotes, control characters, ASCII or malformed bytes, and
    // a url at PROFILE_URL_LIMIT of quotes in its host or of letters; reported by a local account with the same
    // username, or by a remote one on a domain of quotes at DOMAIN_BYTES.
    const h = await community(["alice"]);
    const quotes = `https://${'"'.repeat(PROFILE_URL_LIMIT - "https:///".length)}/`;
    const letters = `https://remote.example/${"a".repeat(PROFILE_URL_LIMIT - "https://remote.example/".length)}`;
    const malformed = new Uint8Array([0xc0, ...Array.from({ length: USERNAME_LIMIT - 1 }, () => 0x80)]).buffer;
    const fills: [string, SqlStorageValue, string, string | null][] = [
      ["quotes", '"'.repeat(USERNAME_LIMIT), quotes, null],
      ["control", "\u0001".repeat(USERNAME_LIMIT), quotes, null],
      ["ascii", "a".repeat(USERNAME_LIMIT), letters, null],
      ["malformed", malformed, quotes, null],
      ["remote", '"'.repeat(USERNAME_LIMIT), quotes, '"'.repeat(DOMAIN_BYTES)],
    ];
    const measured: Record<string, number> = {};
    for (const [name, username, url, domain] of fills) {
      const target = await remoteAccount(h.store, `${name}-target`);
      const reporter = domain === null ? h.users.alice.id : await remoteAccount(h.store, `${name}-reporter`);
      // One remote account holds an address (accounts_domain_username): a remote reporter moves to its domain before
      // it takes the target's username.
      await sql(h.store, "UPDATE accounts SET domain = ? WHERE id = ? AND domain IS NOT NULL", domain, reporter);
      await sql(
        h.store,
        "UPDATE accounts SET username = CAST(? AS TEXT) WHERE id IN (?, ?)",
        username,
        target,
        reporter,
      );
      await sql(h.store, "UPDATE accounts SET url = ? WHERE id = ?", url, target);
      const fallback = await runInDurableObject(h.store, (_instance, state) =>
        notificationFallback(new Db(state.storage.sql), "admin.report", {
          accountId: reporter,
          targetId: target,
          origin: LONG_ORIGIN,
        }),
      );
      measured[name] = jsonBytes(fallback);
      if (url === quotes) {
        // The host keeps its quotes, each escaped.
        expect(fallback!.title).toContain(`href="https://${"&quot;".repeat(PROFILE_URL_LIMIT - "https:///".length)}/"`);
      }
      // A later fill's target takes the same address, so this fill's remote accounts give theirs up, as invalidated.
      await sql(
        h.store,
        "UPDATE accounts SET username = '! ' || id WHERE id IN (?, ?) AND domain IS NOT NULL",
        target,
        reporter,
      );
    }
    console.info(`Fallback JSON of each fill: ${JSON.stringify(measured)}`);
    for (const bytes of Object.values(measured)) {
      expect(bytes).toBeLessThanOrEqual(FALLBACK_JSON_MAX);
    }
    // A host of quotes takes more than one byte per URL character: six for each quote.
    expect(measured.quotes).toBeGreaterThan(fixed + 2 * PROFILE_URL_LIMIT + 2 * 6 * USERNAME_LIMIT);
  });
});
