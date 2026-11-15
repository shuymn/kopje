import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { type Account, partialAccountsOf, presentAccountsWithin } from "../src/domain/accounts";
import { jsonBytes } from "../src/domain/answer-budget";
import { PROFILE_DESCRIPTION_BYTES, PROFILE_DESCRIPTION_LIMIT } from "../src/platform/stored-bounds";
import { bearer, seedAccount, sql } from "./api-helpers";
import { community, getJson } from "./status-helpers";

// Account#avatar_description and #header_description (migration 0096_profile_descriptions; Mastodon 4.6,
// REST::AccountSerializer): presented on every Account and CredentialAccount, '' while the account is unavailable and
// again after, cut at PROFILE_DESCRIPTION_LIMIT code points after decoding; PartialAccount carries the avatar's.
// Independent of the images, as in Mastodon: removing or replacing an image keeps its description.

const ORIGIN = "https://kopje.test";

type Shown = Pick<Account, "avatar_description" | "header_description"> & { suspended?: true };

async function fixture() {
  const h = await community(["alice", "bob"]);
  const remote = await seedAccount(h.store, { username: "erin", domain: "remote.example" });
  const describe = (id: string, avatar: string | ArrayBuffer, header: string | ArrayBuffer) =>
    sql(
      h.store,
      `UPDATE accounts SET avatar_description = CAST(?1 AS TEXT), header_description = CAST(?2 AS TEXT) WHERE id = ?3`,
      avatar,
      header,
      id,
    );
  const shown = async (id: string) => (await getJson<Shown>(h, `/api/v1/accounts/${id}`, h.users.bob.token)).body;
  // An account as presented by id, an unavailable one included (with_suspended).
  const presented = (id: string) =>
    runInDurableObject(
      h.store,
      (_instance, state) =>
        presentAccountsWithin(new Db(state.storage.sql), [id], { origin: ORIGIN }, Infinity, true).items[0] as Shown,
    );
  const partial = (id: string) =>
    runInDurableObject(h.store, (_instance, state) => [
      ...partialAccountsOf(new Db(state.storage.sql), [id], { origin: ORIGIN }),
    ]);
  return { h, remote, describe, shown, presented, partial };
}

const descriptions = (account: Shown) => [account.avatar_description, account.header_description];

describe("profile image descriptions", () => {
  it("are presented on the Account, the CredentialAccount and the PartialAccount, '' for none", async () => {
    const { h, remote, describe, shown, partial } = await fixture();
    const { alice } = h.users;
    expect(descriptions(await shown(alice.id))).toEqual(["", ""]);
    await describe(alice.id, "A cat", "A field");
    await describe(remote, "𠀀 avatar", "header");
    expect(descriptions(await shown(alice.id))).toEqual(["A cat", "A field"]);
    expect(descriptions(await shown(remote))).toEqual(["𠀀 avatar", "header"]);
    const credential = (await getJson<Shown>(h, "/api/v1/accounts/verify_credentials", alice.token)).body;
    expect(descriptions(credential)).toEqual(["A cat", "A field"]);
    expect(await partial(remote)).toEqual([expect.objectContaining({ id: remote, avatar_description: "𠀀 avatar" })]);
  });

  it("are '' while the account is unavailable, and shown again once it is available", async () => {
    const { h, remote, describe, shown, presented, partial } = await fixture();
    const { alice } = h.users;
    await describe(alice.id, "A cat", "A field");
    await describe(remote, "avatar", "header");
    // Local suspension and unsuspension.
    await sql(h.store, "UPDATE local_accounts SET suspended_at = '2026-01-01' WHERE account_id = ?", alice.id);
    expect(await shown(alice.id)).toMatchObject({ suspended: true, avatar_description: "", header_description: "" });
    expect(await partial(alice.id)).toEqual([expect.objectContaining({ avatar_description: "" })]);
    await sql(h.store, "UPDATE local_accounts SET suspended_at = NULL WHERE account_id = ?", alice.id);
    expect(descriptions(await shown(alice.id))).toEqual(["A cat", "A field"]);
    // A suspended remote account, and one whose deletion has started.
    expect(descriptions(await presented(remote))).toEqual(["avatar", "header"]);
    for (const { make, full, partialAccount, reset } of [
      {
        make: "UPDATE accounts SET suspended_at = '2026-01-01', suspension_source = 'account' WHERE id = ?",
        full: { suspended: true, avatar_description: "", header_description: "" },
        partialAccount: [expect.objectContaining({ avatar_description: "" })],
        reset: "UPDATE accounts SET suspended_at = NULL, suspension_source = NULL WHERE id = ?",
      },
      {
        make: "UPDATE accounts SET deleted_at = '2026-01-01' WHERE id = ?",
        full: { suspended: true, avatar_description: "", header_description: "" },
      },
    ]) {
      await sql(h.store, make, remote);
      expect(await presented(remote), make).toMatchObject(full);
      if (partialAccount !== undefined) {
        expect(await partial(remote), make).toEqual(partialAccount);
      }
      if (reset !== undefined) {
        await sql(h.store, reset, remote);
        expect(descriptions(await presented(remote)), reset).toEqual(["avatar", "header"]);
      }
    }
    // Stored all along.
    expect(
      await sql(
        h.store,
        "SELECT avatar_description AS a FROM accounts WHERE id IN (?, ?) ORDER BY id",
        alice.id,
        remote,
      ),
    ).toEqual([{ a: "A cat" }, { a: "avatar" }]);
  });

  it("are cut at PROFILE_DESCRIPTION_LIMIT code points after decoding, 902 JSON bytes at most", async () => {
    const { remote, describe, shown, partial } = await fixture();
    // 0xFF and 599 continuation bytes: within 0096's trigger (one character), 600 U+FFFD once decoded.
    const malformed = new Uint8Array(PROFILE_DESCRIPTION_BYTES).fill(0x80);
    malformed[0] = 0xff;
    const escaped = "\u0001".repeat(PROFILE_DESCRIPTION_LIMIT);
    await describe(remote, malformed.buffer, escaped);
    const account = await shown(remote);
    expect(descriptions(account)).toEqual(["�".repeat(PROFILE_DESCRIPTION_LIMIT), escaped]);
    expect([jsonBytes(account.avatar_description), jsonBytes(account.header_description)]).toEqual([452, 902]);
    expect((await partial(remote))[0]!.avatar_description).toBe("�".repeat(PROFILE_DESCRIPTION_LIMIT));
  });

  it("stay when the image is removed", async () => {
    const { h, describe, shown } = await fixture();
    const { alice } = h.users;
    await sql(
      h.store,
      "UPDATE accounts SET avatar_url = 'https://kopje.test/media/AAAA/full.webp', header_url = 'https://kopje.test/media/BBBB/full.webp' WHERE id = ?",
      alice.id,
    );
    await describe(alice.id, "A cat", "A field");
    for (const kind of ["avatar", "header"]) {
      const removed = await h.request(`/api/v1/profile/${kind}`, bearer(alice.token, { method: "DELETE" }));
      expect(removed.status).toBe(200);
      expect(await removed.json()).toMatchObject({ avatar_description: "A cat", header_description: "A field" });
    }
    expect((await shown(alice.id)).avatar_description).toBe("A cat");
    expect(await sql(h.store, "SELECT avatar_url, header_url FROM accounts WHERE id = ?", alice.id)).toEqual([
      { avatar_url: null, header_url: null },
    ]);
  });
});
