import { describe, expect, it } from "vitest";

import { bearer, sql } from "./api-helpers";
import { act, block, community, follow, mute, post, remoteAccount, seedStatus } from "./status-helpers";

// Search with resolve=true of a URL of this instance on Kopje's own routes (remote-statuses.ts localSearchTarget), as
// Mastodon 4.7.5's ResolveURLService#process_local_url finds what its routes name (resolve_url_service.rb:93-123),
// nothing fetched, and answered under the viewer's visibility as any resolution is (VIS-1: R3 with the author's domain
// blocked by the viewer, R14).

const ORIGIN = "https://kopje.test";
const CAROL_URI = "https://remote.example/users/carol/statuses/1";

type Found = { accounts: { id: string }[]; statuses: { id: string }[] };

async function fixture() {
  const requests: string[] = [];
  const loader = {
    fetch: ((input: RequestInfo | URL) => {
      requests.push(input instanceof Request ? input.url : String(input));
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as typeof fetch,
    checkHost: (url: URL) => {
      requests.push(`dns:${url.hostname}`);
      return Promise.resolve();
    },
  };
  const h = await community(["alice", "bob", "dave", "erin"], "read write follow", { federation: { loader } });
  const { bob, dave } = h.users;
  const carol = await remoteAccount(h.store, "carol");
  const carolSub = await remoteAccount(h.store, "carol", "sub.remote.example");
  const carolPost = await seedStatus(h.store, {
    accountId: carol,
    visibility: "public",
    content: "<p>carol</p>",
    uri: CAROL_URI,
  });
  const posted = async (body: Record<string, unknown>) => {
    const { id, uri } = await post(h, bob, body);
    return { id, uri: String(uri) };
  };
  const open = await posted({ status: "open" });
  const followers = await posted({ status: "followers", visibility: "private" });
  const direct = await posted({ status: "@dave direct", visibility: "direct" });
  await follow(h, dave, bob.id);
  // What search answers for `url`, as ids, for the viewer `token`.
  const search = async (url: string, token: string) => {
    const response = await h.request(`/api/v2/search?resolve=true&q=${encodeURIComponent(url)}`, bearer(token));
    expect([url, response.status]).toEqual([url, 200]);
    const body = await response.json<Found>();
    return { accounts: body.accounts.map((a) => a.id), statuses: body.statuses.map((s) => s.id) };
  };
  const status = (id: string) => ({ accounts: [], statuses: [id] });
  const account = (id: string) => ({ accounts: [id], statuses: [] });
  const nothing = { accounts: [], statuses: [] };
  return { h, carol, carolSub, carolPost, open, followers, direct, search, status, account, nothing, requests };
}

// `value` with its first character percent-encoded, then the `%` of that escape encoded `times` more: Rails decodes a
// path parameter twice (journey/router.rb, routing/route_set.rb).
function escapedFirst(value: string, times: number): string {
  const hex = value.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");
  return `%${"25".repeat(times)}${hex}${value.slice(1)}`;
}

// The URL forms that name a local post: its status page and its object URI (as written, the stored lookup by uri), each
// with Rails' optional format and with its id escaped once and twice (localSearchTarget).
function statusForms(s: { id: string; uri: string }): string[] {
  const uuid = s.uri.slice(`${ORIGIN}/ap/o/`.length);
  return [
    ...[`${ORIGIN}/@bob/${s.id}`, s.uri].flatMap((url) => [url, `${url}.json`]),
    ...[0, 1].flatMap((times) => [
      `${ORIGIN}/@bob/${escapedFirst(s.id, times)}`,
      `${ORIGIN}/ap/o/${escapedFirst(uuid, times)}`,
      `${ORIGIN}/ap/o/${escapedFirst(uuid, times)}.json`,
    ]),
  ];
}

// The URL forms that name carol@remote.example (home#index with no rest): Mastodon removes one leading `@` and takes
// the first two fields of Ruby's split('@') (resolve_url_service.rb:113).
const CAROL_FORMS = [
  `${ORIGIN}/@carol@remote.example`,
  `${ORIGIN}/@carol@REMOTE.example`,
  `${ORIGIN}/@@carol@remote.example`,
  `${ORIGIN}/@%40carol@remote.example`,
  `${ORIGIN}/@carol@remote.example@x`,
  `${ORIGIN}/@carol@remote.example@`,
  `${ORIGIN}/@@carol@remote.example@x@y`,
  `${ORIGIN}/@carol@remote.example?x=1#top`,
];

// The URL forms that name bob: every path Mastodon's router sends to accounts#show (his profile and its tabs, with
// Rails' optional format, his username escaped once and twice), his actor URI as written (the stored lookup by uri) and
// as that route reads it, and his address on this domain (listed in docs/mastodon-deviations.md, Search).
const BOB_FORMS = [
  `${ORIGIN}/@bob`,
  `${ORIGIN}/@Bob.rss`,
  `${ORIGIN}/@bob?x=1#top`,
  `${ORIGIN}/@%62ob`,
  `${ORIGIN}/@%2562ob`,
  ...["featured", "collections", "with_replies", "media", "tagged/kopje"].flatMap((tab) => [
    `${ORIGIN}/@bob/${tab}`,
    `${ORIGIN}/@bob/${tab}.json`,
  ]),
  `${ORIGIN}/ap/users/bob`,
  `${ORIGIN}/ap/users/Bob.json`,
  `${ORIGIN}/ap/users/%2562ob`,
  `${ORIGIN}/@bob@kopje.test`,
  `${ORIGIN}/@BOB@Kopje.Test`,
];

describe("search with resolve=true of a URL of this instance", () => {
  it("finds each route's post or account for a viewer who may see it, and fetches nothing", async () => {
    const t = await fixture();
    const { alice, bob } = t.h.users;
    expect(t.open.uri).toMatch(/^https:\/\/kopje\.test\/ap\/o\/[^/]+$/);
    for (const url of statusForms(t.open)) {
      expect([url, await t.search(url, alice.token)]).toEqual([url, t.status(t.open.id)]);
    }
    for (const url of BOB_FORMS) {
      expect([url, await t.search(url, alice.token)]).toEqual([url, t.account(bob.id)]);
    }
    // A stored remote account by its address, and its post by its id under any handle.
    for (const url of CAROL_FORMS) {
      expect([url, await t.search(url, alice.token)]).toEqual([url, t.account(t.carol)]);
    }
    // home#index takes the handle accounts#show does not: `.` in two places, the `@` escaped.
    const sub = `${ORIGIN}/@carol%40sub.remote.example`;
    expect(await t.search(sub, alice.token)).toEqual(t.account(t.carolSub));
    for (const url of [`${ORIGIN}/@carol@remote.example/${t.carolPost}`, `${ORIGIN}/@bob/${t.carolPost}`]) {
      expect([url, await t.search(url, alice.token)]).toEqual([url, t.status(t.carolPost)]);
    }
    // A legacy id names the post too, as on its status page.
    const legacy = "3f1c2b9e-0000-4000-8000-000000000001";
    await sql(t.h.store, "UPDATE statuses SET legacy_id = ? WHERE id = ?", legacy, t.open.id);
    expect(await t.search(`${ORIGIN}/@bob/${legacy}`, alice.token)).toEqual(t.status(t.open.id));
    expect(t.requests).toEqual([]);
  });

  it("finds nothing for another path, an unknown id or account, or another host's URL", async () => {
    const t = await fixture();
    const { alice } = t.h.users;
    for (const url of [
      `${ORIGIN}/@bob/${t.open.id}/embed`,
      `${ORIGIN}/@bob/followers`,
      `${ORIGIN}/@bob/tagged`,
      `${ORIGIN}/@bob/tagged/a/b`,
      `${ORIGIN}/@bob.`,
      `${ORIGIN}/@bob@kopje.test/media`,
      `${ORIGIN}/@carol@remote.example/media`,
      `${ORIGIN}/ap/users/bob/followers`,
      // home#index takes no format; a status page's id takes no `.`; a user and a domain are both needed.
      `${ORIGIN}/@carol@remote.example/${t.carolPost}.json`,
      `${ORIGIN}/@bob/${t.open.id}.a.b`,
      `${ORIGIN}/@@bob`,
      `${ORIGIN}/@@@carol@remote.example`,
      `${ORIGIN}/@carol@@remote.example`,
      // An id is matched as written (docs/mastodon-deviations.md, Search: Mastodon casts it as Rails casts an integer).
      `${ORIGIN}/@bob/0${t.open.id}`,
      `${ORIGIN}/@bob/${t.open.id}-x`,
      `${ORIGIN}/@bob/999999999999999999`,
      `${ORIGIN}/@nobody`,
      `${ORIGIN}/@nobody@remote.example`,
      `${ORIGIN}/@carol@elsewhere.example`,
      `${ORIGIN}/@bob@`,
      `${ORIGIN}/@%E0%A4%A`,
      `${ORIGIN}/ap/o/missing`,
      `${ORIGIN}/ap/users/nobody`,
      `${ORIGIN}/users/bob`,
      // recognize_path reads the path as written against routes anchored at both ends: no trailing `/`, no dot segment.
      `${ORIGIN}/@bob/`,
      `${ORIGIN}/@bob/media/`,
      `${ORIGIN}/@bob/${t.open.id}/`,
      `${ORIGIN}/@bob/${t.open.id}.json/`,
      `${t.open.uri}/`,
      `${ORIGIN}/ap/users/bob/`,
      `${ORIGIN}/@carol@remote.example/`,
      `${ORIGIN}/x/../@bob`,
      `${ORIGIN}/@bob/./media`,
      // A URL RFC 3986 does not admit (Mastodon's search answers 404, docs/mastodon-deviations.md, Search).
      `${ORIGIN}/@bob|`,
      `${ORIGIN}/@bob\\`,
      `${ORIGIN}/@b\u00f3b`,
      `${ORIGIN}/@bob?a b`,
      `${ORIGIN}/@bob%`,
      // Decoded twice, as Rails decodes a path parameter: a `/` or `@` that was escaped, an escape left as it is, bytes
      // that are not UTF-8.
      `${ORIGIN}/@bob%2Fmedia`,
      `${ORIGIN}/@carol%2540remote.example`,
      `${ORIGIN}/@%2525bob`,
      `${ORIGIN}/@%2580ob`,
    ]) {
      expect([url, await t.search(url, alice.token)]).toEqual([url, t.nothing]);
    }
    expect(t.requests).toEqual([]);
  });

  // A parameter whose bytes are not UTF-8 names nothing, though U+FFFD's would: a legacy id holding U+FFFD is found by
  // its own escape, not by an invalid byte that a lenient decoding would turn into it.
  it("finds nothing by bytes that are not UTF-8", async () => {
    const t = await fixture();
    const { alice } = t.h.users;
    await sql(t.h.store, "UPDATE statuses SET legacy_id = ? WHERE id = ?", "\uFFFD", t.open.id);
    expect(await t.search(`${ORIGIN}/@bob/%EF%BF%BD`, alice.token)).toEqual(t.status(t.open.id));
    expect(await t.search(`${ORIGIN}/@bob/%FF`, alice.token)).toEqual(t.nothing);
    expect(await t.search(`${ORIGIN}/@bob/%25FF`, alice.token)).toEqual(t.nothing);
  });

  // Mastodon reads the id alone (resolve_url_service.rb:100, :110).
  it("finds a post by its id whatever the handle", async () => {
    const t = await fixture();
    const { alice } = t.h.users;
    for (const handle of ["alice", "nobody", "carol@remote.example"]) {
      const url = `${ORIGIN}/@${handle}/${t.open.id}`;
      expect([url, await t.search(url, alice.token)]).toEqual([url, t.status(t.open.id)]);
    }
  });

  // Each refusal with its control: the same URL forms found by a viewer the rule lets see the target.
  describe("answers only what the viewer may see", () => {
    it("a followers-only post: not to a non-follower, to an accepted follower (R3)", async () => {
      const t = await fixture();
      const { alice, dave } = t.h.users;
      for (const url of statusForms(t.followers)) {
        expect([url, await t.search(url, alice.token)]).toEqual([url, t.nothing]);
        expect([url, await t.search(url, dave.token)]).toEqual([url, t.status(t.followers.id)]);
      }
    });

    it("a direct post: not to another viewer, to its addressee (R3)", async () => {
      const t = await fixture();
      const { alice, dave } = t.h.users;
      for (const url of statusForms(t.direct)) {
        expect([url, await t.search(url, alice.token)]).toEqual([url, t.nothing]);
        expect([url, await t.search(url, dave.token)]).toEqual([url, t.status(t.direct.id)]);
      }
    });

    it("a post of an author who blocks the viewer: not to that viewer, to another (R3)", async () => {
      const t = await fixture();
      const { alice, bob, erin } = t.h.users;
      await block(t.h.store, bob.id, alice.id);
      for (const url of statusForms(t.open)) {
        expect([url, await t.search(url, alice.token)]).toEqual([url, t.nothing]);
        expect([url, await t.search(url, erin.token)]).toEqual([url, t.status(t.open.id)]);
      }
    });

    it("a remote account and its post: not to a viewer who blocks its domain, to another (R14, the author's domain)", async () => {
      const t = await fixture();
      const { alice, erin } = t.h.users;
      expect((await act(t.h, alice, "/api/v1/domain_blocks", { domain: "remote.example" })).status).toBe(200);
      for (const url of [`${ORIGIN}/@carol@remote.example/${t.carolPost}`, `${ORIGIN}/@bob/${t.carolPost}`]) {
        expect([url, await t.search(url, alice.token)]).toEqual([url, t.nothing]);
        expect([url, await t.search(url, erin.token)]).toEqual([url, t.status(t.carolPost)]);
      }
      for (const url of CAROL_FORMS) {
        expect([url, await t.search(url, alice.token)]).toEqual([url, t.nothing]);
        expect([url, await t.search(url, erin.token)]).toEqual([url, t.account(t.carol)]);
      }
    });

    it("a boost: by its id to nobody, its original by its own id (a boost is never answered)", async () => {
      const t = await fixture();
      const { alice, bob, dave, erin } = t.h.users;
      const boosted = await act(t.h, dave, `/api/v1/statuses/${t.open.id}/reblog`);
      const boost = (await boosted.json<{ id: string }>()).id;
      expect(boost).not.toBe(t.open.id);
      for (const viewer of [alice, bob, dave, erin]) {
        for (const handle of ["dave", "bob"]) {
          const url = `${ORIGIN}/@${handle}/${boost}`;
          expect([url, await t.search(url, viewer.token)]).toEqual([url, t.nothing]);
        }
        expect(await t.search(`${ORIGIN}/@bob/${t.open.id}`, viewer.token)).toEqual(t.status(t.open.id));
      }
    });

    it("a suspended account: to nobody, found before the suspension (R14)", async () => {
      const t = await fixture();
      const { alice, bob, erin } = t.h.users;
      for (const url of BOB_FORMS) {
        expect([url, await t.search(url, erin.token)]).toEqual([url, t.account(bob.id)]);
      }
      await sql(
        t.h.store,
        "UPDATE local_accounts SET suspended_at = '2026-01-01T00:00:00.000Z' WHERE account_id = ?",
        bob.id,
      );
      for (const viewer of [alice, erin]) {
        for (const url of BOB_FORMS) {
          expect([url, await t.search(url, viewer.token)]).toEqual([url, t.nothing]);
        }
      }
    });

    it("an author the viewer blocks or mutes: still found, as R3 and R14 do not hide them", async () => {
      const t = await fixture();
      const { alice, bob } = t.h.users;
      await block(t.h.store, alice.id, bob.id);
      await mute(t.h.store, alice.id, bob.id);
      for (const url of statusForms(t.open)) {
        expect([url, await t.search(url, alice.token)]).toEqual([url, t.status(t.open.id)]);
      }
      for (const url of BOB_FORMS) {
        expect([url, await t.search(url, alice.token)]).toEqual([url, t.account(bob.id)]);
      }
    });
  });
});
