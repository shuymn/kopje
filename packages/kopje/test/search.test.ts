import { Person } from "@fedify/vocab";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { upsertRemoteActor } from "../src/domain/remote-actors";
import { HASHTAG_PUBLIC_WINDOW, LIBRARY_SOURCE_LIMIT } from "../src/domain/search";
import { remoteActorInput } from "../src/federation/remote-actor";
import { bearer, login, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { tagHistoryOf } from "./read-helpers";
import { act, block, community, follow, mute, post, remoteAccount, seedStatus } from "./status-helpers";
import { ORIGIN } from "./web-helpers";

type Results = {
  accounts: { id: string; acct: string }[];
  statuses: { id: string; content: string }[];
  hashtags: {
    name: string;
    url: string;
    history: { day: string; uses: string; accounts: string }[];
    following?: boolean;
    featuring?: boolean;
  }[];
  collections: { id: string; uri: string; url: string }[];
};

async function fixture() {
  const h = await community(["alice", "bob", "carol"]);
  const search = async (q: string, extra = "", token = h.users.alice.token) => {
    const response = await h.request(`/api/v2/search?q=${encodeURIComponent(q)}${extra}`, bearer(token));
    if (response.status !== 200) {
      throw new Error(`search: ${response.status} ${await response.text()}`);
    }
    return response.json<Results>();
  };
  const statusIds = async (q: string, extra = "", token?: string) =>
    (await search(q, `&type=statuses${extra}`, token)).statuses.map((s) => s.id);
  return { h, search, statusIds };
}

describe("GET /api/v2/search", () => {
  it("refuses unauthenticated search and tokens without read:search", async () => {
    const { h } = await fixture();
    expect((await h.request("/api/v2/search?q=alice")).status).toBe(401);
    const { token } = await login(h, { scope: "read:accounts", email: "alice@example.com" });
    expect((await h.request("/api/v2/search?q=alice", bearer(token))).status).toBe(403);
    const { token: searcher } = await login(h, { scope: "read:search", email: "alice@example.com" });
    expect((await h.request("/api/v2/search?q=alice", bearer(searcher))).status).toBe(200);
  });

  it("finds statuses in the viewer’s library: own, boosted, favourited, bookmarked and mentioned", async () => {
    const { h, statusIds } = await fixture();
    const { alice, bob, carol } = h.users;
    const own = await post(h, alice, { status: "library own" });
    const boosted = await post(h, bob, { status: "library boosted" });
    const favourited = await post(h, bob, { status: "library favourited" });
    const bookmarked = await post(h, carol, { status: "library bookmarked" });
    const mentioned = await post(h, carol, { status: "@alice library mentioned" });
    const elsewhere = await post(h, bob, { status: "library unrelated" });
    await act(h, alice, `/api/v1/statuses/${boosted.id}/reblog`);
    await act(h, alice, `/api/v1/statuses/${favourited.id}/favourite`);
    await act(h, alice, `/api/v1/statuses/${bookmarked.id}/bookmark`);
    expect(await statusIds("library")).toEqual(
      [own, boosted, favourited, bookmarked, mentioned]
        .map((s) => s.id)
        .toSorted()
        .toReversed(),
    );
    expect(await statusIds("library")).not.toContain(elsewhere.id);
    // AND terms, exclusion, and NFKC and kana variants.
    expect(await statusIds("library -boosted -favourited -bookmarked -mentioned")).toEqual([own.id]);
    const kana = await post(h, alice, { status: "ＡＢＣ　ねこのサーバー" });
    expect(await statusIds("abc ネコ")).toEqual([kana.id]);
    expect(await statusIds("サーバ")).toEqual([kana.id]);
  });

  it("never returns a status the viewer may not see, even from the library (VIS-1, private status in search)", async () => {
    const { h, statusIds } = await fixture();
    const { alice, bob, carol } = h.users;
    // A direct status between bob and carol, and a private one of bob's, that alice has rows for anyway.
    const direct = await seedStatus(h.store, {
      accountId: bob.id,
      visibility: "direct",
      content: "<p>secret direct</p>",
      mentions: [{ accountId: carol.id }],
    });
    const priv = await seedStatus(h.store, {
      accountId: bob.id,
      visibility: "private",
      content: "<p>secret private</p>",
    });
    for (const id of [direct, priv]) {
      await sql(h.store, "INSERT INTO favourites (account_id, status_id) VALUES (?, ?)", alice.id, id);
      await sql(h.store, "INSERT INTO bookmarks (account_id, status_id) VALUES (?, ?)", alice.id, id);
    }
    expect(await statusIds("secret")).toEqual([]);
    // carol, mentioned, finds the direct status.
    expect(await statusIds("secret", "", carol.token)).toEqual([direct]);
    // A follower sees the private one once it is in their library.
    await follow(h, alice, bob.id);
    expect(await statusIds("secret")).toEqual([priv]);
    // account_id searches that account's statuses carol may search, still under the rule: the direct one she is
    // mentioned in, and its public ones once it is indexable.
    const open = await post(h, bob, { status: "secret public" });
    expect(await statusIds("secret", `&account_id=${bob.id}`, carol.token)).toEqual([direct]);
    await sql(h.store, "UPDATE accounts SET indexable = 1 WHERE id = ?", bob.id);
    expect(await statusIds("secret", `&account_id=${bob.id}`, carol.token)).toEqual([open.id, direct]);
  });

  it("drops a boosted status that became inaccessible, and authors the viewer filters (VIS-1, VIS-5)", async () => {
    const { h, statusIds } = await fixture();
    const { alice, bob, carol } = h.users;
    const boosted = await post(h, bob, { status: "boosted once" });
    await act(h, alice, `/api/v1/statuses/${boosted.id}/reblog`);
    expect(await statusIds("boosted")).toEqual([boosted.id]);
    await block(h.store, bob.id, alice.id);
    expect(await statusIds("boosted")).toEqual([]);
    const muted = await post(h, carol, { status: "@alice boosted muted" });
    expect(await statusIds("boosted")).toEqual([muted.id]);
    await mute(h.store, alice.id, carol.id);
    expect(await statusIds("boosted")).toEqual([]);
  });

  it("filters before LIMIT and pages by max_id, min_id and offset (RES-7)", async () => {
    const { h, statusIds } = await fixture();
    const { alice, bob } = h.users;
    const visible = await post(h, bob, { status: "@alice page visible" });
    for (let i = 0; i < 3; i++) {
      const hidden = await seedStatus(h.store, {
        accountId: bob.id,
        visibility: "private",
        content: "<p>page hidden</p>",
      });
      await sql(h.store, "INSERT INTO bookmarks (account_id, status_id) VALUES (?, ?)", alice.id, hidden);
    }
    expect(await statusIds("page", "&limit=1")).toEqual([visible.id]);
    const newer = await post(h, alice, { status: "page newer" });
    expect(await statusIds("page", "&limit=1")).toEqual([newer.id]);
    expect(await statusIds("page", "&limit=1&offset=1")).toEqual([visible.id]);
    expect(await statusIds("page", `&max_id=${newer.id}`)).toEqual([visible.id]);
    expect(await statusIds("page", `&min_id=${visible.id}`)).toEqual([newer.id]);
  });

  it("finds hashtags by prefix, exact first, only where the viewer can see a status with them", async () => {
    const { h, search } = await fixture();
    const { alice, bob, carol } = h.users;
    await post(h, bob, { status: "#cats #catsofkopje #cat" });
    const secret = await seedStatus(h.store, {
      accountId: bob.id,
      visibility: "direct",
      content: "<p>x</p>",
      mentions: [{ accountId: carol.id }],
      tags: ["catsecret"],
    });
    const tags = (await search("#cat", "&type=hashtags")).hashtags;
    expect(tags.map((t) => t.name)).toEqual(["cat", "cats", "catsofkopje"]);
    expect(tags[0]).toEqual({
      id: "8494641126322774823",
      name: "cat",
      url: "https://kopje.test/tags/cat",
      history: tagHistoryOf(NOW, { 0: [1, 1] }),
      following: false,
      featuring: false,
    });
    // carol may see it; it enters her windows once she saves it (mentions are not a hashtag window source).
    await sql(h.store, "INSERT INTO bookmarks (account_id, status_id) VALUES (?, ?)", carol.id, secret);
    expect((await search("cat", "&type=hashtags", carol.token)).hashtags.map((t) => t.name)).toContain("catsecret");
    expect((await search("ＣＡＴ", "&type=hashtags&limit=1&offset=1")).hashtags.map((t) => t.name)).toEqual(["cats"]);
    void alice;
  });

  it("lists only reviewed hashtags and the exact match with exclude_unreviewed (Tag.search_for)", async () => {
    const { h, search } = await fixture();
    await post(h, h.users.bob, { status: "#catnip #catalog #cats" });
    // Either decision is a review (Reviewable#reviewed?: reviewed_at is set by an approve and a reject).
    await sql(
      h.store,
      `INSERT INTO tag_trend_reviews (name, trendable, reviewed_at)
			VALUES ('catnip', 1, '2026-10-01T00:00:00.000Z'), ('catalog', 0, '2026-10-01T00:00:00.000Z')`,
    );
    const names = async (q: string, extra = "") =>
      (await search(q, `&type=hashtags${extra}`)).hashtags.map((t) => t.name);
    expect(await names("cat")).toEqual(["cats", "catnip", "catalog"]);
    expect(await names("cat", "&exclude_unreviewed=true")).toEqual(["catnip", "catalog"]);
    expect(await names("cats", "&exclude_unreviewed=true")).toEqual(["cats"]);
    expect(await names("cat", "&exclude_unreviewed=false")).toEqual(["cats", "catnip", "catalog"]);
    // The filter comes before the page: the offset skips over reviewed tags only.
    expect(await names("cat", "&exclude_unreviewed=true&offset=1")).toEqual(["catalog"]);
    expect(await names("cat", "&exclude_unreviewed=true&limit=1")).toEqual(["catnip"]);
  });

  it("answers every type by default, accounts included, and an unknown type with nothing", async () => {
    const { h, search } = await fixture();
    await remoteAccount(h.store, "alicia", "remote.example");
    await post(h, h.users.alice, { status: "about alic #alicetag" });
    const all = await search("alic");
    expect(all.accounts.map((a) => a.acct).toSorted()).toEqual(["alice", "alicia@remote.example"]);
    expect(all.statuses).toHaveLength(1);
    expect(all.hashtags.map((t) => t.name)).toEqual(["alicetag"]);
    expect(await search("alic", "&type=lists")).toEqual({ accounts: [], statuses: [], hashtags: [], collections: [] });
    expect((await search("alic", "&type=accounts&following=true")).accounts).toEqual([]);
  });

  // SearchService#url_resource with ResolveURLService#process_local_url (Mastodon 4.7.5): a local collection's uri or
  // url, when CollectionPolicy#show? lets the viewer see it.
  it("resolves a local collection's uri and url when R45 shows it, and lists collections no other way", async () => {
    const { h, search } = await fixture();
    const { alice, bob } = h.users;
    const made = await act(h, bob, "/api/v1/collections", { name: "picks", sensitive: false, discoverable: false });
    const collection = (await made.json<{ collection: { id: string; uri: string; url: string } }>()).collection;
    expect(collection.uri).toBe(`https://kopje.test/ap/users/bob/collections/${collection.id}`);
    expect(collection.url).toBe(`https://kopje.test/collections/${collection.id}`);
    const nothing = { accounts: [], statuses: [], hashtags: [], collections: [] };
    for (const url of [collection.uri, collection.url]) {
      expect(await search(url, "&resolve=true")).toMatchObject({ ...nothing, collections: [{ id: collection.id }] });
      expect((await search(url, "&resolve=true&type=collections")).collections.map((c) => c.id)).toEqual([
        collection.id,
      ]);
      expect(await search(url, "&resolve=true&type=accounts")).toEqual(nothing);
      expect((await search(url)).collections).toEqual([]);
      expect((await search(url, "&resolve=true&offset=1&type=collections")).collections).toEqual([]);
    }
    expect(await search("https://kopje.test/collections/999999999999999999", "&resolve=true")).toEqual(nothing);
    expect(await search("collections", "&type=collections")).toEqual(nothing);
    // An owner who blocks the viewer: not shown, so not found.
    await block(h.store, bob.id, alice.id);
    expect(await search(collection.url, "&resolve=true")).toEqual(nothing);
  });

  // SearchService#call (Mastodon 4.7.5, search_service.rb:11, :17): nothing for a limit of 0; an offset counts only with
  // a type, so without one a URL resolves at any offset, and with one past 0 it finds nothing.
  it("answers a local collection's URL under SearchService's limit and offset", async () => {
    const { h, search } = await fixture();
    const made = await act(h, h.users.bob, "/api/v1/collections", {
      name: "picks",
      sensitive: false,
      discoverable: true,
    });
    const { id, url } = (await made.json<{ collection: { id: string; url: string } }>()).collection;
    const ids = async (extra: string) => (await search(url, `&resolve=true${extra}`)).collections.map((c) => c.id);
    expect(await ids("&limit=0")).toEqual([]);
    expect(await ids("&limit=0&type=collections")).toEqual([]);
    expect(await ids("&limit=")).toEqual([]);
    expect(await ids("&offset=1")).toEqual([id]);
    expect(await ids("&offset=1&type=")).toEqual([id]);
    expect(await ids("&offset=1&type=collections")).toEqual([]);
    // A negative limit is refused (Api::V2::SearchController#require_valid_pagination_options!).
    const refused = await h.request(
      `/api/v2/search?q=${encodeURIComponent(url)}&resolve=true&limit=-1&type=collections`,
      bearer(h.users.alice.token),
    );
    expect(refused.status).toBe(400);
  });

  // SearchService#call (search_service.rb:11, :17) with limit_param (api/base_controller.rb:33-37): a limit of 0
  // answers nothing, and the offset counts only with a type. The answer with a URL and resolve=true:
  // test/search-resolution-store-calls.test.ts.
  it("reads the limit and the offset as SearchService#call does", async () => {
    const { h, search, statusIds } = await fixture();
    const older = await post(h, h.users.alice, { status: "paged older #pagedtag" });
    const newer = await post(h, h.users.alice, { status: "paged newer" });
    const both = [newer.id, older.id];
    const statuses = async (extra: string) => (await search("paged", extra)).statuses.map((s) => s.id);
    // The guarded branches: the same queries find both statuses without the parameter.
    expect(await statuses("")).toEqual(both);
    expect(await search("paged", "&limit=0")).toEqual({ accounts: [], statuses: [], hashtags: [], collections: [] });
    expect(await statusIds("paged", "&limit=0")).toEqual([]);
    for (const offset of ["1", "20000"]) {
      expect(await statuses(`&offset=${offset}`)).toEqual(both);
      expect(await statuses(`&offset=${offset}&type=`)).toEqual(both);
    }
    expect(await statusIds("paged", "&offset=1")).toEqual([older.id]);
    expect(await statusIds("paged", "&offset=20000")).toEqual([]);
    // A plain query's type=hashtags searches hashtags, with resolve=true too: only a URL lookup is answered by nothing.
    expect((await search("#pagedtag", "&type=hashtags&resolve=true")).hashtags.map((t) => t.name)).toEqual([
      "pagedtag",
    ]);
  });

  // Api::V2::SearchController (Mastodon 4.7.5): params.require(:q) first, then require_valid_pagination_options!
  // (api/pagination.rb: a limit or offset whose to_i is negative), after the token is judged. The account search has no
  // such check: its limit_param reads a negative limit as its absolute value.
  it("refuses a negative limit or offset with 400, after a missing q and an invalid token", async () => {
    const { h } = await fixture();
    const token = h.users.alice.token;
    await post(h, h.users.alice, { status: "refused" });
    const answer = async (query: string, sent = token) => {
      const response = await h.request(`/api/v2/search?${query}`, bearer(sent));
      return [query, response.status, await response.json()];
    };
    const PAGINATION = { error: "Pagination values for `offset` and `limit` must be positive" };
    for (const query of [
      "q=refused&limit=-2",
      "q=refused&offset=-1",
      "q=refused&limit=-2abc",
      "q=refused&limit=%20-1",
      "q=refused&offset=-0d5&type=statuses",
      "q=refused&limit=5&offset=-1",
      "q=refused&limit=-1&resolve=true",
      // Rails' last value of each.
      "q=refused&limit=5&limit=-1",
      "q=refused&offset=0&offset=-1&type=statuses",
    ]) {
      expect(await answer(query)).toEqual([query, 400, PAGINATION]);
    }
    // Not negative as Ruby reads them: searched.
    for (const query of [
      "q=refused&limit=-0",
      "q=refused&limit=-_1",
      "q=refused&limit=--1",
      "q=refused&offset=-0&type=statuses",
      "q=refused&limit=-1&limit=5",
      "q=refused&offset=-1&offset=0&type=statuses",
    ]) {
      expect((await answer(query))[1]).toBe(200);
    }
    expect(await answer("limit=-2")).toEqual(["limit=-2", 400, { error: "Missing parameter q" }]);
    expect(await answer("q=%20&offset=-1")).toEqual(["q=%20&offset=-1", 400, { error: "Missing parameter q" }]);
    expect((await answer("q=refused&limit=-2", "not-a-token"))[1]).toBe(401);
    // Before the query's own bound (RES-1), which Mastodon does not have.
    const long = `q=${"a".repeat(501)}&limit=-1`;
    expect(await answer(long)).toEqual([long, 400, PAGINATION]);
    const accounts = await h.request("/api/v1/accounts/search?q=alice&limit=-1", bearer(token));
    expect([accounts.status, (await accounts.json<unknown[]>()).length]).toEqual([200, 1]);
  });

  it("answers resolve=true from local data when the query is neither a URL nor an address", async () => {
    // Remote resolution of URLs and addresses: test/inbox-statuses.test.ts ("search with resolve=true").
    const { h, search } = await fixture();
    await post(h, h.users.alice, { status: "resolve me" });
    expect((await search("resolve", "&resolve=true")).statuses).toHaveLength(1);
  });

  it("bounds the query, the limit and the offset (RES-1, RES-3)", async () => {
    const { h, search } = await fixture();
    const token = h.users.alice.token;
    expect((await h.request(`/api/v2/search?q=${"a".repeat(501)}`, bearer(token))).status).toBe(400);
    expect((await h.request(`/api/v1/accounts/search?q=${"a".repeat(501)}`, bearer(token))).status).toBe(400);
    expect((await h.request("/api/v2/search?q=%20", bearer(token))).status).toBe(400);
    expect((await h.request("/api/v2/search", bearer(token))).status).toBe(400);
    for (let i = 0; i < 45; i++) {
      await sql(
        h.store,
        `INSERT INTO accounts (id, uri, username, domain, search_text) VALUES (?, ?, ?, 'many.example', ?)`,
        String(200000000000000000n + BigInt(i)),
        `https://many.example/users/m${i}`,
        `m${i}`,
        `many m${i}@many.example`,
      );
    }
    expect((await search("many", "&type=accounts&limit=100")).accounts).toHaveLength(40);
    expect((await search("many", "&type=accounts")).accounts).toHaveLength(20);
    expect((await search("many", "&type=accounts&offset=10001")).accounts).toEqual([]);
    const accounts = await h.request("/api/v1/accounts/search?q=many&offset=10001", bearer(token));
    expect(await accounts.json()).toEqual([]);
  });

  it("matches a bounded window of the library", async () => {
    expect(LIBRARY_SOURCE_LIMIT).toBeLessThanOrEqual(2500);
    expect(HASHTAG_PUBLIC_WINDOW).toBeLessThanOrEqual(2000);
    const { h, statusIds } = await fixture();
    const { alice } = h.users;
    const old = await post(h, alice, { status: "window oldest" });
    // Newer library rows than the window holds push the oldest out of a search without max_id.
    await sql(
      h.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
			INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, search_text)
			SELECT CAST(900000000000000000 + i AS TEXT), 'https://kopje.test/ap/o/w' || i, ?, 'public', '', '2026-10-12T00:00:00.000Z', 'filler'
			FROM n`,
      LIBRARY_SOURCE_LIMIT,
      alice.id,
    );
    expect(await statusIds("window")).toEqual([]);
    expect(await statusIds("window", "&max_id=900000000000000000")).toEqual([old.id]);
  });
});

// A status text search with account_id of another account (#1564): what Mastodon's search finds of it, its public
// statuses when it is indexable (PublicStatusesIndex) and the statuses whose searchable_by holds the viewer
// (search_concern.rb: kept boosts, favourites, bookmarks, active mentions, votes), each still under listableSql.
describe("GET /api/v2/search with account_id", () => {
  const descending = (ids: string[]) => ids.toSorted().toReversed();

  it("returns only the account's statuses the viewer interacted with while it is not indexable (P6.1)", async () => {
    const { h, statusIds } = await fixture();
    const { bob, carol } = h.users;
    const scoped = () => statusIds("scoped", `&account_id=${bob.id}`, carol.token);
    const boosted = await post(h, bob, { status: "scoped boosted" });
    await act(h, carol, `/api/v1/statuses/${boosted.id}/reblog`);
    // A boost withdrawn and awaiting its job (Mastodon's boost is gone).
    const withdrawn = await post(h, bob, { status: "scoped withdrawn" });
    await act(h, carol, `/api/v1/statuses/${withdrawn.id}/reblog`);
    await sql(
      h.store,
      "UPDATE statuses SET withdrawn = 1 WHERE account_id = ? AND reblog_of_id = ?",
      carol.id,
      withdrawn.id,
    );
    const favourited = await post(h, bob, { status: "scoped favourited" });
    await act(h, carol, `/api/v1/statuses/${favourited.id}/favourite`);
    const bookmarked = await post(h, bob, { status: "scoped bookmarked" });
    await act(h, carol, `/api/v1/statuses/${bookmarked.id}/bookmark`);
    const tagged = await post(h, bob, { status: "@carol scoped tagged" });
    const addressed = await seedStatus(h.store, {
      accountId: bob.id,
      visibility: "public",
      content: "<p>scoped addressed</p>",
      mentions: [{ accountId: carol.id, silent: true }],
    });
    const poll = { options: ["a", "b"], expires_in: 3600 };
    const voted = await post(h, bob, { status: "scoped voted", poll });
    const reset = await post(h, bob, { status: "scoped reset", poll });
    for (const id of [voted.id, reset.id]) {
      expect((await act(h, carol, `/api/v1/polls/${id}/votes`, { choices: [0] })).status).toBe(200);
    }
    // The poll reset after carol's vote: her vote is of a past generation.
    await sql(h.store, "UPDATE polls SET generation = generation + 1 WHERE status_id = ?", reset.id);
    const control = await post(h, bob, { status: "scoped control" });
    // Another author's status carol favourited: an interaction, but not bob's.
    const elsewhere = await post(h, h.users.alice, { status: "scoped elsewhere" });
    await act(h, carol, `/api/v1/statuses/${elsewhere.id}/favourite`);
    // Private statuses carol may see while she follows bob: one she favourited, one she did not.
    await follow(h, carol, bob.id);
    const kept = await post(h, bob, { status: "scoped private kept", visibility: "private" });
    await act(h, carol, `/api/v1/statuses/${kept.id}/favourite`);
    const unsaved = await post(h, bob, { status: "scoped private unsaved", visibility: "private" });
    const found = descending([boosted.id, favourited.id, bookmarked.id, tagged.id, voted.id, kept.id]);
    // indexable NULL (never set), then 0.
    expect(await sql(h.store, "SELECT indexable FROM accounts WHERE id = ?", bob.id)).toEqual([{ indexable: null }]);
    expect(await scoped()).toEqual(found);
    await sql(h.store, "UPDATE accounts SET indexable = 0 WHERE id = ?", bob.id);
    expect(await scoped()).toEqual(found);
    // The guarded branches ran: every status left out matches and is one carol may see, and bob finds them all.
    expect(await statusIds("scoped", "", carol.token)).toContain(elsewhere.id);
    for (const id of [withdrawn.id, addressed, reset.id, control.id, unsaved.id]) {
      expect(await statusIds("scoped", `&account_id=${bob.id}`, bob.token)).toContain(id);
      expect((await h.request(`/api/v1/statuses/${id}`, bearer(carol.token))).status).toBe(200);
    }
    // After she unfollows, the private status she favourited is no longer one she may see (VIS-1).
    await act(h, carol, `/api/v1/accounts/${bob.id}/unfollow`);
    expect(await scoped()).toEqual(found.filter((id) => id !== kept.id));
  });

  it("finds a status through its probe when the viewer's own source window has passed it", async () => {
    const { h, statusIds } = await fixture();
    const { alice, bob, carol } = h.users;
    const old = await post(h, bob, { status: "probed favourite" });
    await act(h, carol, `/api/v1/statuses/${old.id}/favourite`);
    // LIBRARY_SOURCE_LIMIT newer favourites of carol's, of alice's statuses: bob's status is outside her favourites'
    // window, and within bob's newest originals.
    await sql(
      h.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
			INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, search_text)
			SELECT CAST(900000000000000000 + i AS TEXT), 'https://kopje.test/ap/o/p' || i, ?, 'public', '', '2026-10-12T00:00:00.000Z', 'filler'
			FROM n`,
      LIBRARY_SOURCE_LIMIT,
      alice.id,
    );
    await sql(
      h.store,
      "INSERT INTO favourites (account_id, status_id) SELECT ?, id FROM statuses WHERE account_id = ? AND id >= '900000000000000000'",
      carol.id,
      alice.id,
    );
    expect(await statusIds("probed", `&account_id=${bob.id}`, carol.token)).toEqual([old.id]);
  });

  it("adds the account's public statuses while it is indexable, and no other status the viewer may see (P6.2)", async () => {
    const { h, statusIds } = await fixture();
    const { bob, carol } = h.users;
    await follow(h, carol, bob.id);
    const open = await post(h, bob, { status: "listed public" });
    const quiet = await post(h, bob, { status: "listed unlisted", visibility: "unlisted" });
    const closed = await post(h, bob, { status: "listed private", visibility: "private" });
    // A direct status carol is only addressed in: she may see it, and it is not one she may search.
    const addressed = await seedStatus(h.store, {
      accountId: bob.id,
      visibility: "direct",
      content: "<p>listed direct</p>",
      mentions: [{ accountId: carol.id, silent: true }],
    });
    const scoped = () => statusIds("listed", `&account_id=${bob.id}`, carol.token);
    expect(await scoped()).toEqual([]);
    await sql(h.store, "UPDATE accounts SET indexable = 1 WHERE id = ?", bob.id);
    expect(await scoped()).toEqual([open.id]);
    // carol, a follower, may see the unlisted and the private one: both are in her timeline's reach.
    expect(await statusIds("listed", `&account_id=${bob.id}`, bob.token)).toEqual([
      addressed,
      closed.id,
      quiet.id,
      open.id,
    ]);
    for (const id of [quiet.id, closed.id, addressed]) {
      expect((await h.request(`/api/v1/statuses/${id}`, bearer(carol.token))).status).toBe(200);
    }
  });

  it("returns every status of the viewer's own account whatever its indexable (P6.3)", async () => {
    const { h, statusIds } = await fixture();
    const { bob, carol } = h.users;
    const own = [
      await post(h, carol, { status: "mine public" }),
      await post(h, carol, { status: "mine unlisted", visibility: "unlisted" }),
      await post(h, carol, { status: "mine private", visibility: "private" }),
      await post(h, carol, { status: `@bob mine direct`, visibility: "direct" }),
    ].map((s) => s.id);
    for (const indexable of [null, 0, 1]) {
      await sql(h.store, "UPDATE accounts SET indexable = ? WHERE id = ?", indexable, carol.id);
      expect(await statusIds("mine", `&account_id=${carol.id}`, carol.token)).toEqual(descending(own));
    }
    void bob;
  });

  it("stops returning a remote account's public statuses once it is stored without indexable (P6.4)", async () => {
    const { h, statusIds } = await fixture();
    const { carol } = h.users;
    const store = async (extra: Record<string, unknown>) => {
      const document = {
        "@context": [
          "https://www.w3.org/ns/activitystreams",
          { toot: "http://joinmastodon.org/ns#", indexable: "toot:indexable" },
        ],
        id: "https://remote.example/users/dana",
        type: "Person",
        preferredUsername: "dana",
        inbox: "https://remote.example/users/dana/inbox",
        ...extra,
      };
      const input = await remoteActorInput(await Person.fromJsonLd(document), document);
      const confirmed = { ...input!, confirmed: input!.claim };
      await runInDurableObject(h.store, (_instance, state) =>
        state.storage.transactionSync(() => upsertRemoteActor(new Db(state.storage.sql), confirmed, ORIGIN, NOW)),
      );
    };
    await store({ indexable: true });
    const [dana] = await sql<{ id: string }>(h.store, "SELECT id FROM accounts WHERE username = 'dana'");
    const status = await seedStatus(h.store, {
      accountId: dana!.id,
      visibility: "public",
      content: "<p>remote open</p>",
    });
    const scoped = () => statusIds("remote", `&account_id=${dana!.id}`, carol.token);
    expect(await scoped()).toEqual([status]);
    await store({});
    expect(await sql(h.store, "SELECT indexable FROM accounts WHERE id = ?", dana!.id)).toEqual([{ indexable: 0 }]);
    expect(await scoped()).toEqual([]);
  });

  it("counts a status the viewer is only addressed in for a search without account_id only (P6.7)", async () => {
    const { h, statusIds } = await fixture();
    const { bob, carol } = h.users;
    const addressed = await seedStatus(h.store, {
      accountId: bob.id,
      visibility: "public",
      content: "<p>addressed only</p>",
      mentions: [{ accountId: carol.id, silent: true }],
    });
    expect(await statusIds("addressed", "", carol.token)).toEqual([addressed]);
    expect(await statusIds("addressed", `&account_id=${bob.id}`, carol.token)).toEqual([]);
  });

  it("drops an indexable account's public status once the viewer mutes it (VIS-5)", async () => {
    const { h, statusIds } = await fixture();
    const { bob, carol } = h.users;
    await sql(h.store, "UPDATE accounts SET indexable = 1 WHERE id = ?", bob.id);
    const open = await post(h, bob, { status: "muted public" });
    const scoped = () => statusIds("muted", `&account_id=${bob.id}`, carol.token);
    expect(await scoped()).toEqual([open.id]);
    await mute(h.store, carol.id, bob.id);
    expect(await scoped()).toEqual([]);
  });

  // Candidacy is not eligibility (A10): a status a window nominates is returned when it is eligible by any rule.
  it("returns an indexable account's public status past its window that an old vote or a silent mention names", async () => {
    const { h, statusIds } = await fixture();
    const { bob, carol } = h.users;
    const target = await post(h, bob, { status: "nominated public", poll: { options: ["a", "b"], expires_in: 3600 } });
    // LIBRARY_SOURCE_LIMIT newer originals of bob's, none matching: the status is past bob's window.
    await sql(
      h.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
			INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, search_text)
			SELECT CAST(900000000000000000 + i AS TEXT), 'https://kopje.test/ap/o/n' || i, ?, 'public', '', '2026-10-12T00:00:00.000Z', 'filler'
			FROM n`,
      LIBRARY_SOURCE_LIMIT,
      bob.id,
    );
    await sql(h.store, "UPDATE accounts SET indexable = 1 WHERE id = ?", bob.id);
    const scoped = () => statusIds("nominated", `&account_id=${bob.id}`, carol.token);
    // Nothing names it: not a candidate.
    expect(await scoped()).toEqual([]);
    // A vote of a past generation names it; it is eligible as public and indexable.
    expect((await act(h, carol, `/api/v1/polls/${target.id}/votes`, { choices: [0] })).status).toBe(200);
    await sql(h.store, "UPDATE polls SET generation = generation + 1 WHERE status_id = ?", target.id);
    expect(await scoped()).toEqual([target.id]);
    await sql(h.store, "UPDATE accounts SET indexable = 0 WHERE id = ?", bob.id);
    expect(await scoped()).toEqual([]);
    // A silent mention names it in place of the vote.
    await sql(h.store, "DELETE FROM poll_votes WHERE poll_id = ?", target.id);
    await sql(
      h.store,
      "INSERT INTO status_mentions (status_id, account_id, silent) VALUES (?, ?, 1)",
      target.id,
      carol.id,
    );
    expect(await scoped()).toEqual([]);
    await sql(h.store, "UPDATE accounts SET indexable = 1 WHERE id = ?", bob.id);
    expect(await scoped()).toEqual([target.id]);
  }, 60_000);
});
