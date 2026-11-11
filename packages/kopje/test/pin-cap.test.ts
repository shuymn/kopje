import { describe, expect, it } from "vitest";

import { PIN_LIMIT } from "../src/domain/activities";
import { MAX_REMOTE_PINS } from "../src/domain/remote-collections";
import { accountStatuses } from "../src/domain/timelines";
import { webProfilePage } from "../src/domain/web-pages/profile";
import { sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { withoutTriggers } from "./pin-cap-helpers";
import { plannedRun } from "./read-helpers";
import { community, remoteAccount, seedStatus } from "./status-helpers";
import { postsTab } from "./web-helpers";

// RES-2, RES-4: status_pins holds at most an account's pin limit (migration 0089_pin_cap), so the pinned read of an
// account (GET /api/v1/accounts/:id/statuses?pinned=true, and the profile's first page, both accountStatusesWithin)
// reads at most that many pins through the primary key, whatever was imported, with no index in pin order.

const PINS = /status_pins p CROSS JOIN/;

// The pinned reads of an account holding `pins` pins, half of them of statuses the anonymous read hides (direct): the
// read examines those too. Past the account's limit the triggers are dropped, as a Store held such pins before 0089.
async function pinnedReads(owner: "local" | "remote", pins: number, limit: number) {
  const h = await community(["alice"]);
  const account = owner === "local" ? h.users.alice.id : await remoteAccount(h.store, "bob");
  const ids: string[] = [];
  for (let i = 0; i < pins; i++) {
    ids.push(await seedStatus(h.store, { accountId: account, visibility: i % 2 === 0 ? "public" : "direct" }));
  }
  if (pins > limit) {
    await withoutTriggers(h.store);
  }
  for (const [i, id] of ids.entries()) {
    await sql(
      h.store,
      "INSERT INTO status_pins (account_id, status_id, created_at) VALUES (?, ?, ?)",
      account,
      id,
      new Date(NOW - i * 1000).toISOString(),
    );
  }
  const api = await plannedRun(h, PINS, accountStatuses, {
    credential: null,
    now: NOW,
    account,
    page: { limit: 40 },
    onlyMedia: false,
    excludeReplies: false,
    excludeReblogs: false,
    pinned: true,
    tagged: null,
    present: { origin: "https://kopje.test" },
  });
  const profile =
    owner === "local" ? (await plannedRun(h, PINS, webProfilePage, postsTab("alice", null, NOW))).plans : [];
  return [...api.plans, ...profile];
}

// The rows one pinned read examines: three for the read, and four for each pin (its row, its status by key, and the
// status's audience checks), measured at each limit below with every pin filled.
const readCeiling = (pins: number) => 3 + 4 * pins;

describe("the pinned read (RES-4)", () => {
  it("reads at most the account's limit of pins, by primary key, at each limit filled", async () => {
    for (const [owner, limit, reads] of [
      ["local", PIN_LIMIT, 2],
      ["remote", MAX_REMOTE_PINS, 1],
    ] as const) {
      const plans = await pinnedReads(owner, limit, limit);
      expect(plans, owner).toHaveLength(reads);
      for (const { plan, rows } of plans) {
        expect(plan.join(" | "), owner).toMatch(/SEARCH p USING PRIMARY KEY \(account_id=/);
        expect(rows, owner).toBeLessThanOrEqual(readCeiling(limit));
      }
    }
  }, 120_000);

  it("examines every pin an account holds past its limit, so the bound comes from storage", async () => {
    const plans = await pinnedReads("local", 200, PIN_LIMIT);
    for (const { rows } of plans) {
      expect(rows).toBeGreaterThan(readCeiling(PIN_LIMIT) * 10);
    }
  }, 120_000);
});
