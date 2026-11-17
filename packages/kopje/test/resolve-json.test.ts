import { describe, expect, it } from "vitest";

import { AP, MASTODON, mastodonActor } from "./inbox-helpers";
import { type Setup, setup } from "./inbox-status-helpers";

// #1718: a WebFinger answer whose text holds a string token, a key or a value, with an unpaired surrogate is a JRD that
// does not parse (loader.ts readDocument, json-bounds.ts jsonTextMalformed), one a later duplicate key replaces
// included: search resolution finds no account by it. Mastodon's Webfinger raises on a lone high one (webfinger.rb:15,
// `Invalid JSON`) and reads a lone low one, so it resolves the address whose answer holds one in `aliases`, which it
// does not read (docs/mastodon-deviations.md, "Reading inbound activities").

type Found = { accounts: { acct: string }[] };

const resolve = (t: Setup, address: string) =>
  t.api<Found>(`/api/v2/search?resolve=true&type=accounts&q=${encodeURIComponent(address)}`);

describe("a WebFinger answer with an unpaired surrogate (#1718)", () => {
  it.each([
    ["a lone high surrogate", { aliases: ["\ud800"] }, []],
    ["a lone low surrogate", { aliases: ["\udc00"] }, []],
    ["a key holding a high surrogate", { "\ud800": [] }, []],
    ["a surrogate pair", { aliases: ["😀"] }, ["bob@mastodon.example"]],
  ])("resolves an address whose answer holds %s", async (_, extra, found) => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const resource = "acct:bob@mastodon.example";
    const webfinger = `${MASTODON}/.well-known/webfinger?resource=${encodeURIComponent(resource)}`;
    t.web.serve(
      webfinger,
      { subject: resource, links: [{ rel: "self", type: AP, href: bob.uri }], ...extra },
      "application/jrd+json",
    );
    expect((await resolve(t, "bob@mastodon.example")).body.accounts.map((a) => a.acct)).toEqual(found);
    expect(t.web.fetched).toContain(webfinger);
  });

  it.each([
    ["a lone high surrogate", String.raw`\ud800`, []],
    ["a surrogate pair", String.raw`\ud83d\ude00`, ["bob@mastodon.example"]],
  ])(
    "resolves an address whose answer holds %s a later duplicate key replaces as Mastodon does",
    async (_, escape, found) => {
      const t = await setup();
      const bob = await mastodonActor(t.web, "bob");
      const resource = "acct:bob@mastodon.example";
      const webfinger = `${MASTODON}/.well-known/webfinger?resource=${encodeURIComponent(resource)}`;
      const jrd = JSON.stringify({ subject: resource, links: [{ rel: "self", type: AP, href: bob.uri }], aliases: [] });
      t.web.serveRaw(
        webfinger,
        jrd.replace(`"aliases":[]`, `"aliases":["${escape}"],"aliases":[]`),
        "application/jrd+json",
      );
      expect((await resolve(t, "bob@mastodon.example")).body.accounts.map((a) => a.acct)).toEqual(found);
      expect(t.web.fetched).toContain(webfinger);
    },
  );
});
