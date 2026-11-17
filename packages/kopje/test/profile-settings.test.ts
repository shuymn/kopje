import { Person } from "@fedify/vocab";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { type Account, presentAccountsWithin } from "../src/domain/accounts";
import { upsertRemoteActor } from "../src/domain/remote-actors";
import { remoteActorInput } from "../src/federation/remote-actor";
import { bearer, json, seedAccount, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { community, getJson } from "./status-helpers";

// Account#show_featured, #show_media and #show_media_replies (migration 0097_profile_descriptions; Mastodon 4.6,
// REST::AccountSerializer): presented as stored on every Account and CredentialAccount, true by default, and also
// while the account is unavailable, as Mastodon does. update_credentials does not set them (Mastodon's account_params
// has none of them); the profile API does. A remote account's are read from its actor's showFeatured, showMedia and
// showRepliesInMedia.

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
          presentAccountsWithin(new Db(state.storage.sql), [remote], { origin: ORIGIN, viewerId: null }, Infinity, true)
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

  it("are not set by update_credentials", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const patch = async (body: Record<string, unknown>) => {
      const response = await h.request(
        "/api/v1/accounts/update_credentials",
        bearer(alice.token, json(body, { method: "PATCH" })),
      );
      return { status: response.status, body: settings(await response.json<Settings>()) };
    };
    const off = { show_featured: false, show_media: false, show_media_replies: false };
    expect(await patch(off)).toEqual({
      status: 200,
      body: { show_featured: true, show_media: true, show_media_replies: true },
    });
    // The same answer shows a stored 0 as false, so the request above set nothing.
    await sql(h.store, "UPDATE accounts SET show_media = 0 WHERE id = ?", alice.id);
    expect(await patch({ show_media: true })).toEqual({
      status: 200,
      body: { show_featured: true, show_media: false, show_media_replies: true },
    });
  });
});

describe("remote display settings", () => {
  // A remote actor's document as Mastodon 4.7 renders it (the profile_settings context terms), stored as the inbox
  // stores one (remoteActorInput, then upsertRemoteActor), and its stored settings and descriptions.
  async function remoteWorld() {
    const h = await community(["alice"]);
    const uri = (name: string) => `https://remote.example/users/${name}`;
    const store = async (name: string, extra: Record<string, unknown>) => {
      const document = {
        "@context": [
          "https://www.w3.org/ns/activitystreams",
          {
            toot: "http://joinmastodon.org/ns#",
            showFeatured: "toot:showFeatured",
            showMedia: "toot:showMedia",
            showRepliesInMedia: "toot:showRepliesInMedia",
          },
        ],
        id: uri(name),
        type: "Person",
        preferredUsername: name,
        inbox: `${uri(name)}/inbox`,
        ...extra,
      };
      const input = await remoteActorInput(await Person.fromJsonLd(document), document);
      // Its claim confirmed, as WebFinger would confirm it (federation/resolve.ts confirmedInput).
      const confirmed = { ...input!, confirmed: input!.claim };
      await runInDurableObject(h.store, (_instance, state) =>
        state.storage.transactionSync(() => upsertRemoteActor(new Db(state.storage.sql), confirmed, ORIGIN, NOW)),
      );
      return stored(name);
    };
    const stored = async (name: string) =>
      (
        await sql<Record<string, SqlStorageValue>>(
          h.store,
          `SELECT show_featured AS f, show_media AS m, show_media_replies AS r, avatar_description AS d, inbox_url
					FROM accounts WHERE uri = ?`,
          uri(name),
        )
      )[0];
    return { h, uri, store };
  }
  const settingsOf = (f: unknown, m: unknown, r: unknown) => ({ showFeatured: f, showMedia: m, showRepliesInMedia: r });

  // process_account_service.rb:258-260: a key the document holds is assigned, an absent one keeps the stored value.
  // Kopje takes JSON booleans only (docs/mastodon-deviations.md).
  it("reads a remote actor's settings when they are JSON booleans, and keeps the stored ones otherwise", async () => {
    const { store } = await remoteWorld();
    const settings = async (extra: Record<string, unknown>) => {
      const { f, m, r } = (await store("bob", extra))!;
      return [f, m, r];
    };
    // A new account without the keys takes the defaults.
    expect(await settings({})).toEqual([1, 1, 1]);
    expect(await settings(settingsOf(false, false, false))).toEqual([0, 0, 0]);
    // A later document without them keeps them.
    expect(await settings({})).toEqual([0, 0, 0]);
    // Not booleans: kept.
    expect(await settings(settingsOf("true", 1, null))).toEqual([0, 0, 0]);
    expect(await settings(settingsOf(true, false, true))).toEqual([1, 0, 1]);
    expect(await settings(settingsOf("false", 0, null))).toEqual([1, 0, 1]);
    // A new account whose document holds no boolean takes the defaults.
    const { f, m, r } = (await store("carol", settingsOf("false", 0, null)))!;
    expect([f, m, r]).toEqual([1, 1, 1]);
  });

  // R38: an individually suspended remote account takes only a routing refresh (refreshRouting).
  it("keeps a suspended remote account's settings and descriptions", async () => {
    const { h, uri, store } = await remoteWorld();
    const icon = (summary: string) => ({ icon: { type: "Image", url: "https://remote.example/a.png", summary } });
    expect(await store("bob", { ...settingsOf(true, false, true), ...icon("A cat") })).toMatchObject({
      f: 1,
      m: 0,
      r: 1,
      d: "A cat",
    });
    await sql(
      h.store,
      "UPDATE accounts SET suspended_at = '2026-01-01', suspension_source = 'account' WHERE uri = ?",
      uri("bob"),
    );
    const moved = `${uri("bob")}/moved-inbox`;
    expect(await store("bob", { ...settingsOf(false, true, false), ...icon("A dog"), inbox: moved })).toEqual({
      f: 1,
      m: 0,
      r: 1,
      d: "A cat",
      inbox_url: moved,
    });
  });
});
