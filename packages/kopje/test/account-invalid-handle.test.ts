import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { ACCOUNT_PREFIX_LIMIT, ACCOUNT_RECENT_LIMIT, partialAccountsOf } from "../src/domain/accounts";
import { statusLinks } from "../src/domain/status-presenter";
import type { StoreStub } from "../src/platform/store-client";
import { announcementHarness, seedAnnouncement } from "./announcement-helpers";
import { bearer, json, login, registerApp, seedAccount, sql } from "./api-helpers";
import { offline } from "./app-helpers";
import { BUILD } from "./helpers";
import { ADMIN_EMAIL } from "./ops-helpers";
import { community, getJson, post, remoteAccount, seedStatus } from "./status-helpers";

// Invalidated handles (docs/mastodon-deviations.md, Accounts; accounts.ts shownHandle): a remote account whose stored
// username is '! <id>' (Mastodon's invalidate_username!) shows its id as username and `<id>@handle.invalid` as acct
// wherever an account's handle is presented, and no address names it (addressRow, findAccountIds); lookup finds it
// by that placeholder. No writer stores '! <id>' yet, so the rows are written here.

const ORIGIN = "https://kopje.test";
const DAVE_ACTOR = "https://remote.example/users/dave";

// Invalidates the account's handle as Mastodon does: '! <id>', its search text rewritten for it, and its stored
// profile URL dropped, so the URL shown is the one derived without the username.
async function invalidate(store: StoreStub, id: string): Promise<void> {
  await sql(
    store,
    "UPDATE accounts SET username = '! ' || id, search_text = '! ' || id || '@' || domain, url = NULL WHERE id = ?",
    id,
  );
}

const placeholder = (id: string, url = DAVE_ACTOR) => ({
  username: id,
  acct: `${id}@handle.invalid`,
  url,
  invalid_handle: true,
});

// alice (local), carol (remote, valid) and dave (remote, invalidated), on a Store whose Access admin is the harness's.
async function world() {
  const h = await announcementHarness(["alice"]);
  const carol = await remoteAccount(h.store, "carol");
  const dave = await remoteAccount(h.store, "dave");
  await invalidate(h.store, dave);
  return { h, carol, dave, token: h.users.alice.token };
}

type Body = Record<string, unknown>;

describe("an invalidated handle, presented", () => {
  it("shows the placeholder and invalid_handle in the Account, and a valid or local account without the key", async () => {
    const { h, carol, dave, token } = await world();
    expect(await getJson(h, `/api/v1/accounts/${dave}`, token)).toMatchObject({
      status: 200,
      body: { id: dave, ...placeholder(dave), uri: DAVE_ACTOR },
    });
    const valid = (await getJson<Body>(h, `/api/v1/accounts/${carol}`, token)).body;
    expect(valid).toMatchObject({ username: "carol", acct: "carol@remote.example" });
    expect("invalid_handle" in valid).toBe(false);
    // A stored profile URL is shown as it is.
    await sql(h.store, "UPDATE accounts SET url = 'https://remote.example/@dave' WHERE id = ?", dave);
    expect((await getJson<Body>(h, `/api/v1/accounts/${dave}`, token)).body).toMatchObject(
      placeholder(dave, "https://remote.example/@dave"),
    );
    // A local account is never invalidated, whatever an import stored as its username.
    await sql(h.store, "UPDATE accounts SET username = '! alice' WHERE id = ?", h.users.alice.id);
    const local = (await getJson<Body>(h, `/api/v1/accounts/${h.users.alice.id}`, token)).body;
    expect(local).toMatchObject({ username: "! alice", acct: "! alice" });
    expect("invalid_handle" in local).toBe(false);
  });

  it("shows it in a moved-to account, partial accounts, status mentions and a status link", async () => {
    const { h, carol, dave, token } = await world();
    const mover = await remoteAccount(h.store, "mover");
    await sql(h.store, "UPDATE accounts SET moved_to_account_id = ? WHERE id = ?", dave, mover);
    expect((await getJson<Body>(h, `/api/v1/accounts/${mover}`, token)).body).toMatchObject({
      moved: { id: dave, ...placeholder(dave) },
    });
    const partial = await runInDurableObject(h.store, (_instance, state) => [
      ...partialAccountsOf(new Db(state.storage.sql), [dave, carol], { origin: ORIGIN }),
    ]);
    expect(partial.map((p) => p && { id: p.id, acct: p.acct, url: p.url })).toEqual([
      { id: dave, acct: `${dave}@handle.invalid`, url: DAVE_ACTOR },
      { id: carol, acct: "carol@remote.example", url: "https://remote.example/@carol" },
    ]);
    const mentioning = await seedStatus(h.store, {
      accountId: carol,
      visibility: "public",
      mentions: [{ accountId: dave }],
    });
    expect((await getJson<{ mentions: unknown }>(h, `/api/v1/statuses/${mentioning}`, token)).body.mentions).toEqual([
      { id: dave, username: dave, url: DAVE_ACTOR, acct: `${dave}@handle.invalid` },
    ]);
    const own = await seedStatus(h.store, { accountId: dave, visibility: "public" });
    const links = await runInDurableObject(h.store, (_instance, state) =>
      statusLinks(new Db(state.storage.sql), [own] as never),
    );
    expect(links.get(own)?.acct).toBe(`${dave}@handle.invalid`);
  });

  it("shows it to the admin: trends' authors, a report's target page and the admin account, raw at its top", async () => {
    const { h, dave, token } = await world();
    const own = await seedStatus(h.store, { accountId: dave, visibility: "public" });
    await sql(h.store, "INSERT INTO trend_statuses (status_id, account_id, score) VALUES (?, ?, 1)", own, dave);
    expect(await h.store.adminTrendStatuses(BUILD, { authority: h.authority, offset: 0, limit: 20 })).toMatchObject({
      ok: true,
      statuses: [{ id: own, account: { id: dave, acct: `${dave}@handle.invalid` } }],
    });
    const report = await h.request("/api/v1/reports", bearer(token, json({ account_id: dave })));
    expect(report.status).toBe(200);
    const { id } = await report.json<{ id: string }>();
    expect(await h.store.reportTargetPage(BUILD, { authority: h.authority, id, origin: ORIGIN })).toEqual({
      ok: true,
      page: DAVE_ACTOR,
    });
    // The OAuth admin's Admin::Account: username as stored, as Mastodon's serializer reads it; the nested Account
    // presents the placeholder.
    const scope = "read admin:read";
    await seedAccount(h.store, { username: "owner", email: ADMIN_EMAIL });
    const admin = await login(h, { app: await registerApp(h, { scopes: scope }), email: ADMIN_EMAIL, scope });
    expect(await getJson(h, `/api/v1/admin/accounts/${dave}`, admin.token)).toMatchObject({
      status: 200,
      body: { id: dave, username: `! ${dave}`, domain: "remote.example", account: { id: dave, ...placeholder(dave) } },
    });
  });

  it("names a featured hashtag's URL by the placeholder, which the web sends on to the profile", async () => {
    const { h, carol, dave, token } = await world();
    await sql(
      h.store,
      `INSERT INTO featured_tags (id, account_id, name, display_name) VALUES
				('900000000000000001', ?1, 'kopje', 'Kopje'), ('900000000000000002', ?2, 'kopje', 'Kopje')`,
      dave,
      carol,
    );
    const invalid = `${ORIGIN}/@${dave}@handle.invalid/tagged/kopje`;
    const valid = `${ORIGIN}/@carol@remote.example/tagged/kopje`;
    expect((await getJson<Body[]>(h, `/api/v1/accounts/${dave}/featured_tags`, token)).body).toMatchObject([
      { url: invalid },
    ]);
    expect((await getJson<Body[]>(h, `/api/v1/accounts/${carol}/featured_tags`, token)).body).toMatchObject([
      { url: valid },
    ]);
    for (const [url, location] of [
      [invalid, DAVE_ACTOR],
      [valid, "https://remote.example/@carol"],
    ] as const) {
      const response = await h.send(new Request(url));
      expect(response.status, url).toBe(302);
      expect(response.headers.get("location"), url).toBe(location);
    }
  });

  it("links an announcement's mention of the old handle to its current holder, or to none", async () => {
    const { h, token } = await world();
    await seedAnnouncement(h.store, { id: "200000000000000001", text: "@dave@remote.example" });
    const list = async () =>
      (
        await getJson<{ mentions: { id: string; acct: string }[]; content: string }[]>(
          h,
          "/api/v1/announcements",
          token,
        )
      ).body[0]!;
    expect(await list()).toMatchObject({ mentions: [], content: "<p>@dave@remote.example</p>" });
    // A new actor of the same server now holds the handle.
    const holder = await remoteAccount(h.store, "dave2");
    await sql(
      h.store,
      "UPDATE accounts SET username = 'dave', url = 'https://remote.example/@dave' WHERE id = ?",
      holder,
    );
    expect((await list()).mentions).toEqual([
      { id: holder, username: "dave", url: "https://remote.example/@dave", acct: "dave@remote.example" },
    ]);
  });
});

describe("an invalidated handle, addressed", () => {
  it("looks up <id>@handle.invalid while the handle is invalidated, and 404 for a valid row's id", async () => {
    const { h, carol, dave } = await world();
    const lookup = (acct: string) => getJson<Body>(h, `/api/v1/accounts/lookup?acct=${encodeURIComponent(acct)}`);
    expect(await lookup(`${dave}@handle.invalid`)).toMatchObject({
      status: 200,
      body: { id: dave, ...placeholder(dave) },
    });
    expect(await lookup(`@${dave}@HANDLE.INVALID`)).toMatchObject({ status: 200, body: { id: dave } });
    expect((await lookup(`${carol}@handle.invalid`)).status).toBe(404);
    expect((await lookup(`${dave}0@handle.invalid`)).status).toBe(404);
    // Nor once its deletion has started, as lookup finds no deleting account (R1, foundSql).
    await sql(h.store, "UPDATE accounts SET deleted_at = '2026-11-01T00:00:00.000Z' WHERE id = ?", dave);
    expect((await lookup(`${dave}@handle.invalid`)).status).toBe(404);
  });

  it("matches no address naming the stored '! <id>': lookup, the web's tagged page and a new post's mention", async () => {
    const { h, dave } = await world();
    const stored = `! ${dave}@remote.example`;
    const lookup = (acct: string) => h.request(`/api/v1/accounts/lookup?acct=${encodeURIComponent(acct)}`);
    // The same lookup reaches the address: a valid handle is found.
    expect((await lookup("carol@remote.example")).status).toBe(200);
    expect((await lookup(stored)).status).toBe(404);
    expect((await h.request(`/@${encodeURIComponent(stored)}/tagged/kopje`)).status).toBe(404);
    expect((await h.request("/@carol@remote.example/tagged/kopje")).status).toBe(302);
    // The parser reads no mention of '! <id>', and the old handle names no account.
    const status = await post(h, h.users.alice, { status: `@${stored} @dave@remote.example @carol@remote.example` });
    expect(status.mentions.map((m) => m.acct)).toEqual(["carol@remote.example"]);
  });

  it("finds no invalidated handle by an exact search, where a valid one past the other windows is found", async () => {
    const h = await community(["alice"], undefined, { federation: offline });
    const search = async (q: string, resolve = false) =>
      (
        await getJson<{ accounts: { id: string }[] }>(
          h,
          `/api/v2/search?type=accounts&resolve=${resolve}&q=${encodeURIComponent(q)}`,
          h.users.alice.token,
        )
      ).body.accounts.map((a) => a.id);
    // ACCOUNT_PREFIX_LIMIT older accounts named vv fill the prefix window of "vv" before the one searched for.
    await sql(
      h.store,
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO accounts (id, uri, username, domain, search_text)
				SELECT CAST(500000000000000000 + i AS TEXT), 'https://d' || i || '.example/users/vv', 'vv', 'd' || i || '.example',
					'other'
				FROM n`,
      ACCOUNT_PREFIX_LIMIT,
    );
    const valid = await remoteAccount(h.store, "vv");
    const dave = await remoteAccount(h.store, "dave");
    await invalidate(h.store, dave);
    // Then ACCOUNT_RECENT_LIMIT newer accounts fill the newest window, the first ACCOUNT_PREFIX_LIMIT of them in the
    // reserved form sorting before dave's, so they fill the prefix window of "!" too; none matches the terms.
    await sql(
      h.store,
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO accounts (id, uri, username, domain, search_text)
				SELECT CAST(600000000000000000 + i AS TEXT), 'https://e' || i || '.example/users/x',
					CASE WHEN i < ?2 THEN '! !' || i ELSE 'other' END, 'e' || i || '.example', 'other'
				FROM n`,
      ACCOUNT_RECENT_LIMIT,
      ACCOUNT_PREFIX_LIMIT,
    );
    expect(await search("vv@remote.example")).toEqual([valid]);
    expect(await search(`! ${dave}@remote.example`)).toEqual([]);
    // Resolving the placeholder looks it up by WebFinger, which cannot answer: as without resolve.
    expect(await search(`${dave}@handle.invalid`, true)).toEqual([]);
  }, 60_000);
});
