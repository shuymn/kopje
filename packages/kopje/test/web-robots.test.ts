import { describe, expect, it } from "vitest";

import { setSetting } from "./api-helpers";
import { community, seedStatus } from "./status-helpers";
import { attr, parseHtml, query } from "./web-dom";

// The robots meta of every public page, as Mastodon 4.7.5 answers the same URL (docs/web-pages.md, "Robots";
// web/components/layout.tsx Robots): `noindex` on every page where Mastodon serves its web app's shell
// (home#index, config/routes.rb:179) or its own page marks it so; where Mastodon renders its own page without it, none
// on the first page and `noindex, follow` with a cursor (docs/mastodon-deviations.md, "Public pages").

const FIRST = "";
const CURSORS = ["?max_id=900000000000000000", "?min_id=1"];

async function robotsOf(h: Awaited<ReturnType<typeof community>>, path: string): Promise<string[]> {
  const response = await h.request(path);
  const doc = parseHtml(await response.text());
  expect([path, response.status]).toEqual([path, 200]);
  return query(doc, "meta")
    .filter((m) => attr(m, "name") === "robots")
    .map((m) => attr(m, "content") ?? "");
}

describe("robots on the public pages", () => {
  it("follows the route Mastodon 4.7.5 has for the same URL", async () => {
    const h = await community(["alice"]);
    const id = await seedStatus(h.store, { accountId: h.users.alice.id, visibility: "public", tags: ["walks"] });
    await setSetting(h.store, "privacy_policy", "<p>Policy</p>");
    await setSetting(h.store, "terms_of_service", "<p>Terms</p>");
    await setSetting(h.store, "terms_of_service_effective_date", "2026-11-01");
    // [path, Mastodon's route, robots on the first page, robots with a cursor (null: the page takes none)]
    const pages: [string, string, string[], string[] | null][] = [
      ["/@alice", "accounts#show", [], ["noindex, follow"]],
      ["/@alice/with_replies", "accounts#show", [], ["noindex, follow"]],
      ["/@alice/media", "accounts#show", [], ["noindex, follow"]],
      ["/@alice/tagged/walks", "accounts#show", [], ["noindex, follow"]],
      ["/@alice/featured", "accounts#show", [], ["noindex, follow"]],
      [`/@alice/${id}`, "statuses#show", [], ["noindex, follow"]],
      [`/@alice/${id}/reblogs`, "home#index", ["noindex"], ["noindex"]],
      [`/@alice/${id}/favourites`, "home#index", ["noindex"], ["noindex"]],
      [`/@alice/${id}/quotes`, "home#index", ["noindex"], ["noindex"]],
      [`/@alice/${id}/embed`, "statuses#embed", ["noindex"], null],
      ["/@alice/followers", "follower_accounts#index", ["noindex"], ["noindex"]],
      ["/@alice/following", "following_accounts#index", ["noindex"], ["noindex"]],
      ["/tags/walks", "tags#show", ["noindex"], ["noindex"]],
      ["/@alice/interact", "home#index", ["noindex"], null],
      [`/@alice/${id}/interact`, "home#index", ["noindex"], null],
      ["/@alice/interact?server=remote.example", "home#index", ["noindex"], null],
      ["/about", "about#show", [], null],
      ["/privacy-policy", "privacy#show", [], null],
      ["/terms-of-service", "terms_of_service#show", [], null],
      ["/terms-of-service/2026-11-01", "terms_of_service#show", [], null],
      // The spelling with the domain: Mastodon's account routes take no `@` in the username, so every page under it is
      // home#index's.
      ["/@alice@kopje.test", "home#index", ["noindex"], ["noindex"]],
      ["/@alice@kopje.test/with_replies", "home#index", ["noindex"], ["noindex"]],
      ["/@alice@kopje.test/media", "home#index", ["noindex"], ["noindex"]],
      ["/@alice@kopje.test/tagged/walks", "home#index", ["noindex"], ["noindex"]],
      ["/@alice@kopje.test/featured", "home#index", ["noindex"], ["noindex"]],
      [`/@alice@kopje.test/${id}`, "home#index", ["noindex"], ["noindex"]],
      [`/@alice@kopje.test/${id}/reblogs`, "home#index", ["noindex"], ["noindex"]],
      ["/@alice@kopje.test/followers", "home#index", ["noindex"], ["noindex"]],
    ];
    for (const [path, route, first, paged] of pages) {
      expect([path, route, await robotsOf(h, path + FIRST)]).toEqual([path, route, first]);
      for (const cursor of paged === null ? [] : CURSORS) {
        const [base, search] = path.split("?");
        const url = search === undefined ? base + cursor : `${base}${cursor}&${search}`;
        expect([url, route, await robotsOf(h, url)]).toEqual([url, route, paged]);
      }
    }
  });
});
