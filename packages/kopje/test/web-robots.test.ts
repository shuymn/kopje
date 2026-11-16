import { describe, expect, it } from "vitest";

import { setSetting, sql } from "./api-helpers";
import { community, seedStatus } from "./status-helpers";
import { attr, parseHtml, query } from "./web-dom";

// The robots meta of every public page and of its 404 and 410, as Mastodon 4.7.5 answers the same URL
// (docs/web-pages.md, "Robots"; app/public-pages.tsx mastodonShell; web/components/layout.tsx Robots): `noindex` where
// Mastodon serves its web app's shell (home#index, config/routes.rb:179) or its own page marks it so; where Mastodon
// renders its own page or error page without it, none on the first page and `noindex, follow` with a cursor
// (docs/mastodon-deviations.md, "Public pages").

const CURSORS = ["?max_id=900000000000000000", "?min_id=1"];

type Harness = Awaited<ReturnType<typeof community>>;

async function answerOf(h: Harness, path: string): Promise<{ status: number; robots: string[] }> {
  const response = await h.request(path);
  const doc = parseHtml(await response.text());
  return {
    status: response.status,
    robots: query(doc, "meta")
      .filter((m) => attr(m, "name") === "robots")
      .map((m) => attr(m, "content") ?? ""),
  };
}

// [path, Mastodon's route, status, robots on the first page, robots with a cursor (null: none tried)]
type Row = [string, string, number, string[], string[] | null];

async function expectRows(h: Harness, rows: Row[]) {
  for (const [path, route, status, first, paged] of rows) {
    expect([path, route, await answerOf(h, path)]).toEqual([path, route, { status, robots: first }]);
    for (const cursor of paged === null ? [] : CURSORS) {
      const [base, search] = path.split("?");
      const url = search === undefined ? base + cursor : `${base}${cursor}&${search}`;
      expect([url, route, await answerOf(h, url)]).toEqual([url, route, { status, robots: paged }]);
    }
  }
}

const SHELL = ["noindex"];
const PAGED = ["noindex, follow"];

describe("robots on the public pages", () => {
  it("follows the route Mastodon 4.7.5 has for the same URL", async () => {
    const h = await community(["alice"]);
    const id = await seedStatus(h.store, { accountId: h.users.alice.id, visibility: "public", tags: ["walks"] });
    await setSetting(h.store, "privacy_policy", "<p>Policy</p>");
    await setSetting(h.store, "terms_of_service", "<p>Terms</p>");
    await setSetting(h.store, "terms_of_service_effective_date", "2026-11-01");
    await expectRows(h, [
      ["/@alice", "accounts#show", 200, [], PAGED],
      ["/@alice/with_replies", "accounts#show", 200, [], PAGED],
      ["/@alice/media", "accounts#show", 200, [], PAGED],
      ["/@alice/tagged/walks", "accounts#show", 200, [], PAGED],
      ["/@alice/featured", "accounts#show", 200, [], PAGED],
      [`/@alice/${id}`, "statuses#show", 200, [], PAGED],
      [`/@alice/${id}/reblogs`, "home#index", 200, SHELL, SHELL],
      [`/@alice/${id}/favourites`, "home#index", 200, SHELL, SHELL],
      [`/@alice/${id}/quotes`, "home#index", 200, SHELL, SHELL],
      [`/@alice/${id}/embed`, "statuses#embed", 200, SHELL, null],
      ["/@alice/followers", "follower_accounts#index", 200, SHELL, SHELL],
      ["/@alice/following", "following_accounts#index", 200, SHELL, SHELL],
      ["/tags/walks", "tags#show", 200, SHELL, SHELL],
      // The handoff pages, which Mastodon does not serve: `interact` is a status id to its statuses#show (a 404).
      ["/@alice/interact", "statuses#show", 200, SHELL, null],
      ["/@alice/interact?server=remote.example", "statuses#show", 200, SHELL, null],
      [`/@alice/${id}/interact`, "home#index", 200, SHELL, null],
      ["/about", "about#show", 200, [], null],
      ["/privacy-policy", "privacy#show", 200, [], null],
      ["/terms-of-service", "terms_of_service#show", 200, [], null],
      ["/terms-of-service/2026-11-01", "terms_of_service#show", 200, [], null],
      // Mastodon asks an anonymous viewer to sign in; Kopje shows its form (mastodon-deviations.md, "Remote
      // interaction").
      ["/authorize_interaction", "authorize_interactions#show", 200, [], null],
      ["/", "home#index", 302, [], null],
      // The spelling with the domain: Mastodon's account routes take no `@` in the username.
      ["/@alice@kopje.test", "home#index", 200, SHELL, SHELL],
      ["/@alice@kopje.test/with_replies", "home#index", 200, SHELL, SHELL],
      ["/@alice@kopje.test/media", "home#index", 200, SHELL, SHELL],
      ["/@alice@kopje.test/tagged/walks", "home#index", 200, SHELL, SHELL],
      ["/@alice@kopje.test/featured", "home#index", 200, SHELL, SHELL],
      [`/@alice@kopje.test/${id}`, "home#index", 200, SHELL, SHELL],
      [`/@alice@kopje.test/${id}/reblogs`, "home#index", 200, SHELL, SHELL],
      ["/@alice@kopje.test/followers", "home#index", 200, SHELL, SHELL],
      // A remote account: Kopje serves no page of it (a known one's tagged URL moves to its own server).
      ["/@bob@remote.example", "home#index", 404, SHELL, null],
      ["/@bob@remote.example/tagged/walks", "home#index", 404, SHELL, null],
    ]);
  });

  // cutover keeps a local actor's last path segment as its username (cli/lib/cutover/convert.js), so a stored local
  // username may hold a dot, which Mastodon's account routes refuse in the middle of a name: every page under it is
  // home#index's but the profile itself, which its accounts#show takes as the name and a format.
  it("reads a stored local username with a dot as Mastodon's routes read it", async () => {
    const h = await community(["carol"]);
    const id = await seedStatus(h.store, { accountId: h.users.carol.id, visibility: "public", tags: ["walks"] });
    await sql(
      h.store,
      "UPDATE accounts SET username = 'carol.dot', uri = 'https://kopje.test/ap/users/carol.dot' WHERE id = ?",
      h.users.carol.id,
    );
    await expectRows(h, [
      ["/@carol.dot", "accounts#show (carol, format dot)", 200, [], PAGED],
      ["/@carol.dot/with_replies", "home#index", 200, SHELL, SHELL],
      ["/@carol.dot/media", "home#index", 200, SHELL, SHELL],
      ["/@carol.dot/tagged/walks", "home#index", 200, SHELL, SHELL],
      ["/@carol.dot/featured", "home#index", 200, SHELL, SHELL],
      [`/@carol.dot/${id}`, "home#index", 200, SHELL, SHELL],
      [`/@carol.dot/${id}/reblogs`, "home#index", 200, SHELL, SHELL],
      [`/@carol.dot/${id}/embed`, "home#index", 200, SHELL, null],
      ["/@carol.dot/followers", "home#index", 200, SHELL, SHELL],
      ["/@carol.dot/following", "home#index", 200, SHELL, SHELL],
      ["/@carol.dot/interact", "home#index", 200, SHELL, null],
    ]);
  });

  // A 404 or 410 under a URL Mastodon answers with its shell is `noindex`; under one its own route takes, it is
  // Mastodon's error page, which sends no robots meta.
  it("marks a 404 or 410 noindex only where Mastodon answers with its shell", async () => {
    const h = await community(["alice", "dave"]);
    await sql(
      h.store,
      "UPDATE accounts SET suspended_at = '2026-01-01', suspension_source = 'account' WHERE id = ?",
      h.users.dave.id,
    );
    await expectRows(h, [
      ["/@alice/999999999999999999/reblogs", "home#index", 404, SHELL, null],
      ["/@alice/999999999999999999/interact", "home#index", 404, SHELL, null],
      ["/@alice@kopje.test/no-such-page", "home#index", 404, SHELL, null],
      ["/@alice/no-such/page", "home#index", 404, SHELL, null],
      ["/@nobody@kopje.test", "home#index", 404, SHELL, null],
      ["/@dave@kopje.test", "home#index", 410, SHELL, null],
      ["/@dave@kopje.test/media", "home#index", 410, SHELL, null],
      ["/@alice/999999999999999999", "statuses#show", 404, [], null],
      ["/@alice/no-such-page", "statuses#show", 404, [], null],
      ["/@nobody", "accounts#show", 404, [], null],
      ["/@nobody/media", "accounts#show", 404, [], null],
      ["/@nobody/tagged/walks", "accounts#show", 404, [], null],
      ["/@nobody/followers", "follower_accounts#index", 404, [], null],
      ["/@nobody/1/embed", "statuses#embed", 404, [], null],
      ["/@nobody/wrapstodon/2025/key", "wrapstodon#show", 404, [], null],
      ["/@nobody.json", "accounts#show (format json)", 404, [], null],
      ["/@dave", "accounts#show", 410, [], null],
      ["/@dave/media", "accounts#show", 410, [], null],
      // Rails squeezes `//` and drops a trailing `/` before it matches a route.
      ["/@nobody//media", "accounts#show", 404, [], null],
      ["/@nobody/media/", "accounts#show", 404, [], null],
      // No route takes an empty name, nor any path outside `/@`: Mastodon's 404.
      ["/@/media", "none", 404, [], null],
      ["/tags/walks/more", "none", 404, [], null],
    ]);
  });
});
