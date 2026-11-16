import { describe, expect, it } from "vitest";

import { seedAccount, sql } from "./api-helpers";
import { AP, LOCAL, serveWebFinger } from "./inbox-helpers";
import { ACCOUNT_SEARCHES, type Acct, type Setup, setup } from "./inbox-status-helpers";

// The instance actor answers WebFinger for its handle (test/federation.test.ts) and is a user nowhere else (ID-5): it
// has no `accounts` row, which account lookup, account search, mentions and the public pages read; search resolution
// fetches nothing on the instance's own domain, and an actor document on its origin is never stored as a remote
// account (ID-3).

const ACTOR = `${LOCAL}/actor`;
const HANDLE = "kopje.test@kopje.test";
const JRD = "application/jrd+json";

// The remote web answers the instance's own URLs as Kopje does, so a resolution that reached them would find the
// instance actor there.
async function servedAsKopje(t: Setup): Promise<void> {
  const actor = await t.request("/actor", { headers: { accept: AP } });
  expect(actor.status).toBe(200);
  t.web.serve(ACTOR, await actor.json());
  for (const resource of [`acct:${HANDLE}`, ACTOR]) {
    const path = `/.well-known/webfinger?resource=${encodeURIComponent(resource)}`;
    const answer = await t.request(path);
    expect(answer.status, resource).toBe(200);
    t.web.serve(`${LOCAL}${path}`, await answer.json(), JRD);
  }
}

const instanceRows = (t: Setup) =>
  sql(t.store, "SELECT count(*) AS n FROM accounts WHERE uri = ? OR lower(username) = 'kopje.test'", ACTOR);

describe("the instance actor's handle", () => {
  it("is resolved by no search on the instance's own domain, which fetches nothing", async () => {
    const t = await setup();
    const carol = await seedAccount(t.store, { username: "carol" });
    await servedAsKopje(t);
    for (const search of ACCOUNT_SEARCHES) {
      for (const q of [HANDLE, `@${HANDLE}`, `acct:${HANDLE}`]) {
        const path = search.path(`resolve=true&q=${encodeURIComponent(q)}`);
        const { status, body } = await t.api(path);
        expect([path, status]).toEqual([path, 200]);
        expect(search.accounts(body), path).toEqual([]);
      }
      // The same form of a local account is answered from stored data: the address reached the local branch.
      const local = await t.api(search.path(`resolve=true&q=${encodeURIComponent("carol@kopje.test")}`));
      expect(search.accounts(local.body).map((a: Acct) => a.id)).toEqual([carol]);
    }
    const byUrl = await t.api(`/api/v2/search?resolve=true&q=${encodeURIComponent(ACTOR)}`);
    expect(byUrl).toEqual({ status: 200, body: { accounts: [], statuses: [], hashtags: [], collections: [] } });
    expect(t.web.fetched).toEqual([]);
    expect(await instanceRows(t)).toEqual([{ n: 0 }]);
  });

  it("is not stored as a remote account when another server's WebFinger names it", async () => {
    const t = await setup();
    await servedAsKopje(t);
    serveWebFinger(t.web, "acct:mallory@evil.example", `acct:${HANDLE}`, ACTOR);
    const { status, body } = await t.api<{ accounts: Acct[] }>(
      `/api/v2/search?type=accounts&resolve=true&q=${encodeURIComponent("mallory@evil.example")}`,
    );
    expect(status).toBe(200);
    expect(body.accounts).toEqual([]);
    // The resolution fetched the instance actor's document; the handle it claims is on the instance's own domain, which
    // the confirmation refuses without a fetch (ID-3), so no account is stored.
    expect(t.web.fetched).toEqual([
      `https://evil.example/.well-known/webfinger?resource=${encodeURIComponent("acct:mallory@evil.example")}`,
      ACTOR,
    ]);
    expect(await instanceRows(t)).toEqual([{ n: 0 }]);
    // Nor does a search without resolution find it afterwards.
    for (const search of ACCOUNT_SEARCHES) {
      for (const q of ["kopje.test", HANDLE]) {
        const searched = await t.api(search.path(`q=${encodeURIComponent(q)}`));
        expect(search.accounts(searched.body), q).toEqual([]);
      }
    }
  });

  it("names no account in lookup, mentions or the public pages", async () => {
    const t = await setup();
    const carol = await seedAccount(t.store, { username: "carol" });
    for (const acct of [HANDLE, `@${HANDLE}`, "kopje.test"]) {
      expect((await t.api(`/api/v1/accounts/lookup?acct=${encodeURIComponent(acct)}`)).status, acct).toBe(404);
    }
    const found = await t.api<Acct>(`/api/v1/accounts/lookup?acct=${encodeURIComponent("carol@kopje.test")}`);
    expect(found).toMatchObject({ status: 200, body: { id: carol } });

    const posted = await t.request("/api/v1/statuses", {
      method: "POST",
      headers: { authorization: `Bearer ${t.tokens.alice}`, "content-type": "application/json" },
      body: JSON.stringify({ status: `@${HANDLE} @kopje.test @carol@kopje.test hi` }),
    });
    expect(posted.status).toBe(200);
    const status = await posted.json<{ mentions: Acct[]; content: string }>();
    expect(status.mentions.map((m) => m.id)).toEqual([carol]);
    expect(status.content.match(/class="u-url mention"/g)).toHaveLength(1);

    for (const path of ["/@kopje.test", `/@${HANDLE}`]) {
      expect((await t.request(path, { headers: { accept: "text/html" } })).status, path).toBe(404);
    }
    expect((await t.request("/@carol", { headers: { accept: "text/html" } })).status).toBe(200);
    expect(await instanceRows(t)).toEqual([{ n: 0 }]);
  });
});
