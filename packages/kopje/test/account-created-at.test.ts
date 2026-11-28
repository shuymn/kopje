import { describe, expect, it } from "vitest";

import type { Account } from "../src/domain/accounts";
import { sql } from "./api-helpers";
import { community, follow, getJson, remoteAccount, seedStatus } from "./status-helpers";

// Account#created_at as REST::AccountSerializer shows it (Mastodon v4.7.5: `object.created_at.midnight.as_json`): the
// creation day's midnight UTC, the nested `moved` account's included (account-columns.ts createdDaySql). A stored value
// that is not a stored time as a whole is shown as it is read: as stored for an account, cut at
// MOVED_CREATED_AT_LIMIT for a moved-to account.

const EXACT = "2026-10-12T13:14:15.678Z";
const MIDNIGHT = "2026-10-12T00:00:00.000Z";

type Notification = { type: string; account: Account };
type Status = { id: string; account: Account };

async function fixture() {
  const h = await community(["alice", "bob"]);
  const { alice, bob } = h.users;
  const carol = await remoteAccount(h.store, "carol");
  const created = (id: string, value: string) =>
    sql(h.store, "UPDATE accounts SET created_at = ? WHERE id = ?", value, id);
  const move = (source: string, target: string) =>
    sql(h.store, "UPDATE accounts SET moved_to_account_id = ? WHERE id = ?", target, source);
  const shown = async (id: string) => {
    const { status, body } = await getJson<Account>(h, `/api/v1/accounts/${id}`, bob.token);
    expect(status).toBe(200);
    return body;
  };
  return { h, alice, bob, carol, created, move, shown };
}

describe("an account's created_at", () => {
  it("is the creation day's midnight wherever an Account is presented, local and remote", async () => {
    const { h, alice, bob, carol, created, move, shown } = await fixture();
    for (const id of [alice.id, bob.id, carol]) {
      await created(id, EXACT);
    }
    // bob follows alice (a follow notification from bob); carol mentions alice (a mention notification from carol).
    await follow(h, bob, alice.id);
    const mention = await seedStatus(h.store, {
      accountId: carol,
      visibility: "public",
      mentions: [{ accountId: alice.id }],
    });
    await sql(
      h.store,
      "INSERT INTO notifications (account_id, type, from_account_id, status_id) VALUES (?, 'mention', ?, ?)",
      alice.id,
      carol,
      mention,
    );
    const own = await seedStatus(h.store, { accountId: alice.id, visibility: "public" });
    // Two accounts that moved: to the local alice and to the remote carol.
    const [toAlice, toCarol] = [await remoteAccount(h.store, "dave"), await remoteAccount(h.store, "erin")];
    await move(toAlice, alice.id);
    await move(toCarol, carol);

    expect([(await shown(alice.id)).created_at, (await shown(carol)).created_at]).toEqual([MIDNIGHT, MIDNIGHT]);
    const credential = await getJson<Account>(h, "/api/v1/accounts/verify_credentials", alice.token);
    expect(credential.body.created_at).toBe(MIDNIGHT);
    for (const id of [own, mention]) {
      const status = await getJson<Status>(h, `/api/v1/statuses/${id}`, bob.token);
      expect(status.body.account.created_at, id).toBe(MIDNIGHT);
    }
    const notifications = await getJson<Notification[]>(h, "/api/v1/notifications", alice.token);
    expect(
      notifications.body
        .map((n) => [n.type, n.account.id, n.account.created_at])
        .toSorted(([a], [b]) => a!.localeCompare(b!)),
    ).toEqual([
      ["follow", bob.id, MIDNIGHT],
      ["mention", carol, MIDNIGHT],
    ]);
    expect([(await shown(toAlice)).moved?.created_at, (await shown(toCarol)).moved?.created_at]).toEqual([
      MIDNIGHT,
      MIDNIGHT,
    ]);
  });

  it("is midnight for the earliest and latest moment of a day", async () => {
    const { carol, created, shown } = await fixture();
    for (const [stored, day] of [
      ["0099-01-01T23:59:59.999Z", "0099-01-01T00:00:00.000Z"],
      ["2026-10-12T00:00:00.000Z", MIDNIGHT],
    ] as const) {
      await created(carol, stored);
      expect((await shown(carol)).created_at, stored).toBe(day);
    }
  });

  // engineering.md, "Stored values": the value is judged as stored, before the moved-to account's cut.
  it.each([
    ["a time in another form", "2026-10-12 13:14:15", "2026-10-12 13:14:15"],
    ["a stored time with a suffix", `${EXACT}junk`, EXACT],
  ])("shows %s as it does today, as stored and as cut for a moved-to account", async (_name, stored, cut) => {
    const { h, carol, created, move, shown } = await fixture();
    await created(carol, stored);
    const source = await remoteAccount(h.store, "dave");
    await move(source, carol);
    expect((await shown(carol)).created_at).toBe(stored);
    expect((await shown(source)).moved?.created_at).toBe(cut);
  });
});
