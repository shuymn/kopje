import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { partialAccountsOf } from "../src/domain/accounts";
import { statusLinks } from "../src/domain/status-presenter";
import type { StoreStub } from "../src/platform/store-client";
import { announcementHarness, seedAnnouncement } from "./announcement-helpers";
import { bearer, json, login, registerApp, seedAccount, sql } from "./api-helpers";
import { BUILD } from "./helpers";
import { ADMIN_EMAIL } from "./ops-helpers";
import { getJson, remoteAccount, seedStatus } from "./status-helpers";

// Invalidated handles (docs/mastodon-deviations.md, Accounts; accounts.ts shownHandle): a remote account whose stored
// username is '! <id>' (Mastodon's invalidate_username!) shows its id as username and `<id>@handle.invalid` as acct
// wherever an account's handle is presented. No writer stores '! <id>' yet, so the rows are written here.

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

  it("names a featured hashtag's URL by the placeholder", async () => {
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
