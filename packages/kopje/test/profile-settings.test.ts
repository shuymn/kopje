import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { type Account, presentAccountsWithin } from "../src/domain/accounts";
import { seedAccount, sql } from "./api-helpers";
import { community, getJson } from "./status-helpers";

// Account#show_featured, #show_media and #show_media_replies (migration 0096_profile_descriptions; Mastodon 4.6,
// REST::AccountSerializer): presented as stored on every Account and CredentialAccount, true by default, and also
// while the account is unavailable, as Mastodon does. No local writer yet: the profile API sets them.

const ORIGIN = "https://kopje.test";

type Settings = Pick<Account, "show_featured" | "show_media" | "show_media_replies"> & { suspended?: true };

const settings = ({ show_featured, show_media, show_media_replies }: Settings) => ({
  show_featured,
  show_media,
  show_media_replies,
});

describe("profile display settings", () => {
  it("are presented as stored, true by default, on the Account and the CredentialAccount", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    const shown = async (id: string) =>
      settings((await getJson<Settings>(h, `/api/v1/accounts/${id}`, bob.token)).body);
    expect(await shown(alice.id)).toEqual({ show_featured: true, show_media: true, show_media_replies: true });
    await sql(h.store, "UPDATE accounts SET show_media = 0, show_featured = 0 WHERE id = ?", alice.id);
    expect(await shown(alice.id)).toEqual({ show_featured: false, show_media: false, show_media_replies: true });
    const credential = (await getJson<Settings>(h, "/api/v1/accounts/verify_credentials", alice.token)).body;
    expect(settings(credential)).toEqual({ show_featured: false, show_media: false, show_media_replies: true });
  });

  it("are presented as stored while the account is unavailable", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    const remote = await seedAccount(h.store, { username: "erin", domain: "remote.example" });
    await sql(
      h.store,
      "UPDATE accounts SET show_featured = 0, show_media = 1, show_media_replies = 0 WHERE id IN (?, ?)",
      alice.id,
      remote,
    );
    await sql(h.store, "UPDATE local_accounts SET suspended_at = '2026-01-01' WHERE account_id = ?", alice.id);
    const local = (await getJson<Settings>(h, `/api/v1/accounts/${alice.id}`, bob.token)).body;
    expect(local.suspended).toBe(true);
    expect(settings(local)).toEqual({ show_featured: false, show_media: true, show_media_replies: false });
    const presented = () =>
      runInDurableObject(
        h.store,
        (_instance, state) =>
          presentAccountsWithin(new Db(state.storage.sql), [remote], { origin: ORIGIN }, Infinity, true)
            .items[0] as Settings,
      );
    for (const set of ["suspended_at = '2026-01-01', suspension_source = 'account'", "deleted_at = '2026-01-01'"]) {
      await sql(h.store, `UPDATE accounts SET ${set} WHERE id = ?`, remote);
      const account = await presented();
      expect(account.suspended).toBe(true);
      expect(settings(account)).toEqual({ show_featured: false, show_media: true, show_media_replies: false });
      await sql(
        h.store,
        "UPDATE accounts SET suspended_at = NULL, suspension_source = NULL, deleted_at = NULL WHERE id = ?",
        remote,
      );
    }
  });
});
