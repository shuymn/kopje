import { describe, expect, it } from "vitest";

import { AP, MASTODON, mastodonActor } from "./inbox-helpers";
import { type Setup, setup } from "./inbox-status-helpers";

// #1718: a WebFinger answer holding a string or a key with an unpaired surrogate is a JRD that does not parse
// (resolve.ts webfingerAt, json-bounds.ts), as Mastodon's Webfinger raises on it (webfinger.rb:15, `Invalid JSON`):
// search resolution finds no account by it.

type Found = { accounts: { acct: string }[] };

const resolve = (t: Setup, address: string) =>
  t.api<Found>(`/api/v2/search?resolve=true&type=accounts&q=${encodeURIComponent(address)}`);

describe("a WebFinger answer with an unpaired surrogate (#1718)", () => {
  it.each([
    ["a lone high surrogate", { aliases: ["\ud800"] }, []],
    ["a lone low surrogate", { aliases: ["\udc00"] }, []],
    ["a key holding a high surrogate", { "\ud800": [] }, []],
    ["a surrogate pair", { aliases: ["😀"] }, ["bob@mastodon.example"]],
  ])("resolves an address whose answer holds %s as Mastodon does", async (_, extra, found) => {
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
});
