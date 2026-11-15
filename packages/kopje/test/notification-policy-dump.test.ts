import { describe, expect, it } from "vitest";

import type { StoreStub } from "../src/platform/store-client";
import { seedAccount, sql } from "./api-helpers";
import { migratedStore } from "./helpers";
import { accessAdminStore, copyConfig, dumpViaRpc, importViaRpc } from "./ops-helpers";

// Notification policies in dumps (docs/dump-format.md "Stored bounds"): the bot condition of
// 0094_notification_policy_bots round-trips with the policy's other choices, and an import is held to its CHECK
// (refused with the constraint's text).

// Each account's for_bots, and another condition's choice beside it.
const POLICIES = [
  ["accept", "filter"],
  ["filter", "drop"],
  ["drop", "accept"],
] as const;

async function source() {
  const store = await accessAdminStore();
  for (const [i, [bots, notFollowing]] of POLICIES.entries()) {
    const id = await seedAccount(store, { username: `u${i}`, email: `u${i}@example.com` });
    await sql(
      store,
      "INSERT INTO notification_policies (account_id, for_not_following, for_bots) VALUES (?, ?, ?)",
      id,
      notFollowing,
      bots,
    );
  }
  return store;
}

const rows = (store: StoreStub) =>
  sql(store, "SELECT account_id, for_not_following, for_bots FROM notification_policies ORDER BY for_bots");

describe("notification policies in dumps", () => {
  it("round-trip with for_bots", async () => {
    const store = await source();
    const { text } = await dumpViaRpc(store);
    const target = await migratedStore();
    await copyConfig(store, target);
    expect((await importViaRpc(target, text)).report).toMatchObject({ ok: true, problems: [] });
    const restored = await rows(target);
    expect(restored).toEqual(await rows(store));
    expect(restored.map((row) => row.for_bots)).toEqual(["accept", "drop", "filter"]);
  }, 60_000);

  it("are refused on import past the CHECK, with the constraint's text", async () => {
    const store = await source();
    const { text } = await dumpViaRpc(store);
    // for_bots is the table's last column (0094 adds it), so the one policy that drops bots ends its row with it.
    const line = text
      .split("\n")
      .find((l) => l.startsWith('INSERT INTO "notification_policies"') && l.endsWith("'drop');"));
    expect(line).toMatch(/"for_bots"\) VALUES/);
    const changed = text.replace(line!, line!.replace(/'drop'\);$/, "'block');"));
    expect(changed).not.toBe(text);
    const target = await migratedStore();
    await copyConfig(store, target);
    await expect(importViaRpc(target, changed)).rejects.toThrow(
      /CHECK constraint failed: for_bots IN \('accept', 'filter', 'drop'\)/,
    );
    // The same dump unchanged imports: the refusal is the value's.
    const control = await migratedStore();
    await copyConfig(store, control);
    expect((await importViaRpc(control, text)).report).toMatchObject({ ok: true });
  }, 120_000);
});
