import { describe, expect, it } from "vitest";

import {
  followAnswerActivity,
  followActivity,
  followUri,
  statusReach,
  undoFollowActivity,
} from "../src/domain/activities";
import { availableSql, reachQuoters, recipientsFor } from "../src/domain/audience";
import {
  completeDelivery,
  type DeliveryOutcome,
  FALLBACK_AUDIENCE_MAX,
  GAVE_UP_RETENTION_MS,
  LEASE_MS,
  MAX_ATTEMPTS,
  PROVENANCE_BYTES,
  PROVENANCE_MAX,
  retryDelay,
  rowProvenanceSql,
  TARGET_CHUNK_SIZE,
} from "../src/domain/deliveries";
import { readOperation } from "../src/domain/operation";
import { noteQuote } from "../src/domain/quotes";
import { hasLocalFollowers } from "../src/domain/remote-statuses";
import { MAX_REPORT_STATUSES } from "../src/domain/reports";
import { DNS_NAME_UTF8_BYTES } from "../src/platform/domain-name";
import { sha256Hex } from "../src/platform/sha256";
import type { StoreStub } from "../src/platform/store-client";
import { bearer, json, settleDeliveries, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { acceptQuote } from "./budget-helpers";
import { blockDomain } from "./domain-block-helpers";
import { BUILD, claimSent, migratedStore, type SentClaim } from "./helpers";
import { ACCESS, copyConfig, dumpViaRpc, importViaRpc } from "./ops-helpers";
import { plannedRun, remoteAccounts, scansOf, staleStatistics } from "./read-helpers";
import { act, community, post, remoteAccount, remoteFollows, seedStatus } from "./status-helpers";

// Outbound delivery in the Store (domain/deliveries.ts): expansion of outbound intents into inboxes (NET-2, VIS-3),
// lanes, claims and leases (NET-2, OPS-3), retries and giving up (RES-5), and the operator's view.

type Row = {
  id: string;
  activity_id: string;
  inbox_url: string;
  state: string;
  attempts: number;
  next_attempt_at: number;
  lease_token: string | null;
  last_status: number | null;
  type: string;
  body: string;
};

function rows(store: StoreStub): Promise<Row[]> {
  return sql<Row>(
    store,
    `SELECT CAST(d.id AS TEXT) AS id, CAST(d.activity_id AS TEXT) AS activity_id, d.inbox_url, d.state, d.attempts,
			d.next_attempt_at, d.lease_token, d.last_status, json_extract(o.body, '$.activity.type') AS type,
			json_extract(o.body, '$.activity') AS body
		FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id ORDER BY d.id`,
  );
}

function claim(store: StoreStub, now: number, leaseToken: string): Promise<SentClaim> {
  return claimSent(store, { now, leaseToken });
}

function complete(store: StoreStub, id: string, leaseToken: string, now: number, outcome: DeliveryOutcome) {
  return store.completeDelivery(BUILD, { id, leaseToken, now, outcome });
}

const OK: DeliveryOutcome = { kind: "delivered", status: 202 };
const FAIL: DeliveryOutcome = { kind: "failed", status: 503, error: "HTTP 503", permanent: false };
const GONE: DeliveryOutcome = { kind: "failed", status: 410, error: "HTTP 410", permanent: true };
const MISSING: DeliveryOutcome = { kind: "failed", status: 404, error: "HTTP 404", permanent: true };

// Followers on two servers (two sharing fans.example's shared inbox), plus accounts that must not receive anything.
async function audience() {
  const h = await community(["alice", "bob"]);
  const { alice, bob } = h.users;
  const fan1 = await remoteAccount(h.store, "fan1", "fans.example");
  const fan2 = await remoteAccount(h.store, "fan2", "fans.example");
  const other = await remoteAccount(h.store, "other", "other.example");
  const pending = await remoteAccount(h.store, "pending", "pending.example");
  const followed = await remoteAccount(h.store, "followed", "followed.example");
  for (const follower of [fan1, fan2, other]) {
    await remoteFollows(h.store, follower, alice.id);
  }
  // A local follower reads the Store; a pending one is not a follower; one alice follows is not her audience.
  await act(h, bob, `/api/v1/accounts/${alice.id}/follow`);
  await sql(
    h.store,
    "INSERT INTO follows (account_id, target_account_id, state, created_at) VALUES (?, ?, 'pending', '2026-10-12T00:00:00Z')",
    pending,
    alice.id,
  );
  await sql(
    h.store,
    "INSERT INTO follows (account_id, target_account_id, state, created_at) VALUES (?, ?, 'accepted', '2026-10-12T00:00:00Z')",
    alice.id,
    followed,
  );
  await sql(h.store, "DELETE FROM outbound_activities");
  return { h, alice, bob, fan1, other, pending, followed };
}

describe("expansion (NET-2, VIS-3)", () => {
  it("NET-2: delivers a public status once per shared inbox of the accepted remote followers", async () => {
    const { h, alice } = await audience();
    await post(h, alice, { status: "hello" });
    const delivered = await rows(h.store);
    // Duplicate inboxes: fan1 and fan2 share https://fans.example/inbox, so it gets one row.
    expect(delivered.map((r) => [r.type, r.inbox_url, r.state])).toEqual([
      ["Create", "https://fans.example/inbox", "pending"],
      ["Create", "https://other.example/inbox", "pending"],
    ]);
  });

  it("NET-2: a recipient outside the audience gets nothing", async () => {
    const { h, alice } = await audience();
    const carol = await remoteAccount(h.store, "carol", "carol.example");
    await post(h, alice, { status: "followers only", visibility: "private" });
    await post(h, alice, { status: "@carol@carol.example just you", visibility: "direct" });
    const delivered = await rows(h.store);
    expect(delivered.map((r) => [r.type, r.inbox_url])).toEqual([
      ["Create", "https://fans.example/inbox"],
      ["Create", "https://other.example/inbox"],
      // The direct status goes to carol only: no follower, pending follower or followed account.
      ["Create", "https://carol.example/inbox"],
    ]);
    const inboxes = delivered.map((r) => r.inbox_url).join(" ");
    expect(inboxes).not.toContain("pending.example");
    expect(inboxes).not.toContain("followed.example");
    expect(carol).toBeDefined();
  });

  it("VIS-3, VIS-7: a silent recipient receives the activity at its personal inbox and is never named", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    await remoteAccount(h.store, "carol", "carol.example");
    const direct = await post(h, alice, { status: "@carol@carol.example psst", visibility: "direct" });
    // The Create is in flight when the edit comes: it may give up, so the server gets the current Create and the
    // Update after it (the edit fan-out pair), each a copy of its own at the personal inbox.
    await h.store.claimDeliveries(BUILD, { now: NOW, leaseToken: "in-flight" });
    // The edit removes the mention; carol stays addressed as a silent recipient (VIS-11).
    await h.request(
      `/api/v1/statuses/${direct.id}`,
      bearer(alice.token, json({ status: "edited" }, { method: "PUT" })),
    );
    const [create, current, update] = await rows(h.store);
    expect(create?.inbox_url).toBe("https://carol.example/inbox");
    expect(current?.type).toBe("Create");
    expect(current?.inbox_url).toBe("https://carol.example/users/carol/inbox");
    expect(update?.type).toBe("Update");
    expect(update?.inbox_url).toBe("https://carol.example/users/carol/inbox");
    const activity = JSON.parse(update?.body ?? "{}") as { to: string[]; cc: string[]; object: { tag: unknown[] } };
    expect(activity.to).toEqual([]);
    expect(activity.cc).toEqual([]);
    expect(JSON.stringify(activity)).not.toContain("https://carol.example/users/carol");
  });

  it("NET-2: delivers once to a follower who is also mentioned, and falls back to a personal inbox", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const fan = await remoteAccount(h.store, "fan", "fans.example");
    await remoteFollows(h.store, fan, alice.id);
    const lone = await remoteAccount(h.store, "lone", "lone.example");
    await sql(h.store, "UPDATE accounts SET shared_inbox_url = NULL WHERE id = ?", lone);
    await remoteFollows(h.store, lone, alice.id);
    await post(h, alice, { status: "@fan@fans.example hello" });
    expect((await rows(h.store)).map((r) => r.inbox_url)).toEqual([
      "https://fans.example/inbox",
      "https://lone.example/users/lone/inbox",
    ]);
  });

  it("records no intent when no remote inbox needs it, and refuses inboxes that are not https", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const plain = await remoteAccount(h.store, "plain", "plain.example");
    await sql(
      h.store,
      "UPDATE accounts SET inbox_url = 'http://plain.example/inbox', shared_inbox_url = 'https://user:pw@plain.example/inbox' WHERE id = ?",
      plain,
    );
    await remoteFollows(h.store, plain, alice.id);
    await post(h, alice, { status: "nobody remote" });
    expect(await rows(h.store)).toEqual([]);
    expect(await sql(h.store, "SELECT id FROM outbound_activities")).toEqual([]);
  });

  it("VIS-3: a Delete reaches the inboxes that received the status, even after they stopped following", async () => {
    const { h, alice, other } = await audience();
    const status = await post(h, alice, { status: "soon gone", visibility: "private" });
    const leased = await claim(h.store, NOW, "lease-1");
    for (const delivery of leased.deliveries) {
      expect(await complete(h.store, delivery.id, "lease-1", NOW, OK)).toMatchObject({ status: "delivered" });
    }
    expect(await rows(h.store)).toEqual([]);
    expect(await sql(h.store, "SELECT id FROM outbound_activities")).toEqual([]);
    expect(await sql(h.store, "SELECT status_id, inbox_url FROM outbound_receipts ORDER BY inbox_url")).toEqual([
      { status_id: status.id, inbox_url: "https://fans.example/inbox" },
      { status_id: status.id, inbox_url: "https://other.example/inbox" },
    ]);
    await sql(h.store, "DELETE FROM follows WHERE account_id = ?", other);
    await h.request(`/api/v1/statuses/${status.id}`, bearer(alice.token, { method: "DELETE" }));
    await settleDeliveries(h.store);
    const deleted = await rows(h.store);
    expect(deleted.map((r) => [r.type, r.inbox_url])).toEqual([
      ["Delete", "https://fans.example/inbox"],
      ["Delete", "https://other.example/inbox"],
    ]);
    expect(JSON.parse(deleted[0]?.body ?? "{}")).toMatchObject({ object: { type: "Tombstone", id: status.uri } });
    // The evidence now lives in the Delete's own rows.
    expect(await sql(h.store, "SELECT status_id FROM outbound_receipts")).toEqual([]);
  });
});

describe("lanes, claims and leases (NET-2, OPS-3)", () => {
  it("delivers a lane in order: the second activity waits until the first settles", async () => {
    const { h, alice } = await audience();
    await post(h, alice, { status: "first" });
    await post(h, alice, { status: "second" });
    const before = await rows(h.store);
    expect(before.map((r) => [r.inbox_url, r.state])).toEqual([
      ["https://fans.example/inbox", "pending"],
      ["https://other.example/inbox", "pending"],
      ["https://fans.example/inbox", "queued"],
      ["https://other.example/inbox", "queued"],
    ]);
    const first = await claim(h.store, NOW, "a");
    expect(first.deliveries.map((d) => d.id)).toEqual([before[0]?.id, before[1]?.id]);
    // Nothing else is due while the heads are leased.
    expect((await claim(h.store, NOW, "b")).deliveries).toEqual([]);
    await complete(h.store, before[0]?.id ?? "", "a", NOW + 1, OK);
    const next = await claim(h.store, NOW + 1, "c");
    expect(next.deliveries.map((d) => [d.id, d.inbox])).toEqual([[before[2]?.id, "https://fans.example/inbox"]]);
    expect(JSON.parse(next.deliveries[0]?.body ?? "{}")).toMatchObject({ type: "Create" });
    expect(Object.keys(next.signers)).toEqual([alice.id]);
  });

  it("NET-2: an expired lease is claimed again with a fresh token, and the stale completion settles nothing", async () => {
    const { h, alice } = await audience();
    await post(h, alice, { status: "hello" });
    const first = await claim(h.store, NOW, "old");
    const id = first.deliveries[0]?.id ?? "";
    expect(first.leaseUntil).toBe(NOW + LEASE_MS);
    // Before the lease ends, nobody else gets the row.
    expect((await claim(h.store, NOW + LEASE_MS - 1, "early")).deliveries).toEqual([]);
    const second = await claim(h.store, NOW + LEASE_MS, "new");
    expect(second.deliveries.map((d) => d.id)).toContain(id);
    // The completion of the first claim arrives late: it may not acknowledge the second claim.
    expect(await complete(h.store, id, "old", NOW + LEASE_MS + 1, OK)).toMatchObject({ status: "stale" });
    expect(await complete(h.store, id, "old", NOW + LEASE_MS + 1, GONE)).toMatchObject({ status: "stale" });
    const row = (await rows(h.store)).find((r) => r.id === id);
    expect(row).toMatchObject({ state: "leased", lease_token: "new", attempts: 2 });
    expect(await complete(h.store, id, "new", NOW + LEASE_MS + 2, OK)).toMatchObject({ status: "delivered" });
  });

  it("OPS-3: a claim or completion whose response is lost is reconciled, not repeated", async () => {
    const { h, alice } = await audience();
    await post(h, alice, { status: "hello" });
    // The claim committed but its response never reached the Worker: the rows stay leased until the lease ends.
    await claim(h.store, NOW, "lost");
    expect((await claim(h.store, NOW + 1, "other")).deliveries).toEqual([]);
    const again = await claim(h.store, NOW + LEASE_MS, "again");
    expect(again.deliveries).toHaveLength(2);
    // The completion committed, its response was lost, and the Worker sends it again: the second is stale and
    // records nothing twice.
    const id = again.deliveries[0]?.id ?? "";
    expect(await complete(h.store, id, "again", NOW + LEASE_MS, OK)).toMatchObject({ status: "delivered" });
    expect(await complete(h.store, id, "again", NOW + LEASE_MS, OK)).toMatchObject({ status: "stale" });
    expect(await sql(h.store, "SELECT count(*) AS n FROM outbound_receipts")).toEqual([{ n: 1 }]);
    expect((await rows(h.store)).map((r) => r.id)).not.toContain(id);
  });

  it("bounds a claim to its limit", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    for (let i = 0; i < 20; i++) {
      const follower = await remoteAccount(h.store, `f${i}`, `server${i}.example`);
      await remoteFollows(h.store, follower, alice.id);
    }
    await post(h, alice, { status: "to twenty servers" });
    expect((await claim(h.store, NOW, "x")).deliveries).toHaveLength(16);
    expect((await h.store.claimDeliveries(BUILD, { now: NOW, leaseToken: "y", limit: 3 })).deliveries).toHaveLength(3);
  });
});

describe("retries and giving up (RES-5)", () => {
  it("retries after min(30 s·2^n, 12 h) and gives up after 15 attempts", async () => {
    expect([1, 2, 3, 10, 11, 14].map(retryDelay)).toEqual([
      60_000, 120_000, 240_000, 30_720_000, 43_200_000, 43_200_000,
    ]);
    const h = await community(["alice"]);
    const { alice } = h.users;
    const fan = await remoteAccount(h.store, "fan", "fans.example");
    await remoteFollows(h.store, fan, alice.id);
    await post(h, alice, { status: "unlucky" });
    let now = NOW;
    let total = 0;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const claimed = await claim(h.store, now, `t${attempt}`);
      expect(claimed.deliveries).toHaveLength(1);
      const result = await complete(h.store, claimed.deliveries[0]?.id ?? "", `t${attempt}`, now, FAIL);
      if (attempt < MAX_ATTEMPTS) {
        expect(result).toMatchObject({ status: "retry", retryAt: now + retryDelay(attempt) });
        expect((await claim(h.store, now + retryDelay(attempt) - 1, "early")).deliveries).toEqual([]);
        total += retryDelay(attempt);
        now += retryDelay(attempt);
      } else {
        expect(result).toMatchObject({ status: "gave_up" });
      }
    }
    // About 2.7 days in all (15 attempts).
    expect(total / 86_400_000).toBeCloseTo(2.71, 1);
    expect(await rows(h.store)).toMatchObject([{ state: "gave_up", attempts: MAX_ATTEMPTS, last_status: 503 }]);
  });

  it("gives up at once on a permanent failure and moves the lane on", async () => {
    const { h, alice } = await audience();
    await post(h, alice, { status: "first" });
    await post(h, alice, { status: "second" });
    const leased = await claim(h.store, NOW, "a");
    const fans = leased.deliveries.find((d) => d.inbox === "https://fans.example/inbox");
    expect(await complete(h.store, fans?.id ?? "", "a", NOW, GONE)).toMatchObject({ status: "gave_up" });
    const after = await rows(h.store);
    expect(after.filter((r) => r.inbox_url === "https://fans.example/inbox").map((r) => r.state)).toEqual([
      "gave_up",
      "pending",
    ]);
  });

  it("gives up an expired lease that has used its attempts", async () => {
    const { h, alice } = await audience();
    await post(h, alice, { status: "hello" });
    await sql(h.store, `UPDATE deliveries SET attempts = ${MAX_ATTEMPTS}, state = 'leased', lease_token = 'x'`);
    expect((await claim(h.store, NOW, "y")).deliveries).toEqual([]);
    expect((await rows(h.store)).map((r) => r.state)).toEqual(["gave_up", "gave_up"]);
  });

  it("lists given-up deliveries for the operator, retries them, and sweeps them after 30 days", async () => {
    const { h, alice } = await audience();
    await post(h, alice, { status: "first" });
    await post(h, alice, { status: "second" });
    const leased = await claim(h.store, NOW, "a");
    for (const delivery of leased.deliveries) {
      await complete(h.store, delivery.id, "a", NOW, GONE);
    }
    const report = await h.store.deliveriesReport(BUILD, {});
    expect(report.backlog).toMatchObject({ queued: 0, pending: 2, leased: 0, gaveUp: 2 });
    expect(report.gaveUp.map((d) => [d.account, d.inbox, d.activityType, d.lastStatus])).toEqual([
      ["alice", "https://other.example/inbox", "Create", 410],
      ["alice", "https://fans.example/inbox", "Create", 410],
    ]);
    const fans = report.gaveUp[1]?.id ?? "";
    // The lane already has a pending row, so the retried one queues behind it... and goes first, being older.
    expect(await h.store.retryDeliveries(BUILD, { ids: [fans], now: NOW + 1 })).toEqual({
      ok: true,
      retried: 1,
      skipped: 0,
      refused: 0,
      more: false,
      next: null,
    });
    const fansRows = (await rows(h.store)).filter((r) => r.inbox_url === "https://fans.example/inbox");
    expect(fansRows.map((r) => [r.id, r.state, r.attempts])).toEqual([
      [fans, "queued", 0],
      [expect.any(String), "pending", 0],
    ]);
    const pending = await claim(h.store, NOW + 2, "b");
    for (const delivery of pending.deliveries) {
      await complete(h.store, delivery.id, "b", NOW + 2, OK);
    }
    expect((await rows(h.store)).find((r) => r.id === fans)?.state).toBe("pending");

    const swept = await h.store.sweepDeliveries(BUILD, { now: NOW + GAVE_UP_RETENTION_MS + 1 });
    expect(swept).toEqual({ swept: 1 });
    expect((await rows(h.store)).map((r) => r.state)).toEqual(["pending"]);
    expect(await h.store.retryDeliveries(BUILD, { ids: "all", now: NOW })).toEqual({
      ok: true,
      retried: 0,
      skipped: 0,
      refused: 0,
      more: false,
      next: null,
    });
  });
});

describe("follows toward remote accounts", () => {
  it("sends a Follow, keeps the follow pending, and undoes it with the same id (VIS-8)", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const dave = await remoteAccount(h.store, "dave", "remote.example");
    const followed = await act(h, alice, `/api/v1/accounts/${dave}/follow`);
    expect(await followed.json()).toMatchObject({ following: false, requested: true });
    const [edge] = await sql<{ id: string; state: string; uri: string }>(
      h.store,
      "SELECT CAST(id AS TEXT) AS id, state, uri FROM follows WHERE account_id = ?",
      alice.id,
    );
    const actor = "https://kopje.test/ap/users/alice";
    expect(edge).toEqual({ id: expect.any(String), state: "pending", uri: followUri(actor, edge?.id ?? "") });
    // Following again changes options only: no second Follow.
    await act(h, alice, `/api/v1/accounts/${dave}/follow`, { reblogs: false });
    await act(h, alice, `/api/v1/accounts/${dave}/unfollow`);
    const sent = await rows(h.store);
    // Neither has to: both go to dave's shared inbox, in one lane, in order.
    expect(sent.map((r) => [r.type, r.inbox_url, r.state])).toEqual([
      ["Follow", "https://remote.example/inbox", "pending"],
      ["Undo", "https://remote.example/inbox", "queued"],
    ]);
    expect(JSON.parse(sent[0]?.body ?? "{}")).toEqual({
      "@context": "https://www.w3.org/ns/activitystreams",
      id: edge?.uri,
      type: "Follow",
      actor,
      object: "https://remote.example/users/dave",
    });
    expect(JSON.parse(sent[1]?.body ?? "{}")).toMatchObject({
      id: `${edge?.uri}/undo`,
      type: "Undo",
      actor,
      object: { id: edge?.uri, type: "Follow", actor, object: "https://remote.example/users/dave" },
    });
    expect(h.doorbell).toHaveBeenCalled();
  });

  it("sends an activity without to to the personal inbox of a recipient without a shared inbox", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const dave = await remoteAccount(h.store, "dave", "remote.example");
    await sql(h.store, "UPDATE accounts SET shared_inbox_url = NULL WHERE id = ?", dave);
    const theirs = await seedStatus(h.store, {
      accountId: dave,
      visibility: "public",
      uri: "https://remote.example/n/1",
    });
    await act(h, alice, `/api/v1/accounts/${dave}/follow`);
    await act(h, alice, `/api/v1/statuses/${theirs}/favourite`);
    expect(
      await sql(
        h.store,
        `SELECT json_extract(o.body, '$.activity.type') AS type, d.inbox_url, d.addressee
				FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id ORDER BY d.id`,
      ),
    ).toEqual([
      { type: "Follow", inbox_url: "https://remote.example/users/dave/inbox", addressee: null },
      { type: "Like", inbox_url: "https://remote.example/users/dave/inbox", addressee: null },
    ]);
  });

  it("sends a Like to the shared inbox, and a silent recipient its copy at its personal inbox (VIS-3)", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const dave = await remoteAccount(h.store, "dave", "remote.example");
    await remoteAccount(h.store, "carol", "carol.example");
    const theirs = await seedStatus(h.store, {
      accountId: dave,
      visibility: "public",
      uri: "https://remote.example/n/1",
    });
    await act(h, alice, `/api/v1/statuses/${theirs}/favourite`);
    const direct = await post(h, alice, { status: "@carol@carol.example psst", visibility: "direct" });
    await h.store.claimDeliveries(BUILD, { now: NOW, leaseToken: "in-flight" });
    await h.request(
      `/api/v1/statuses/${direct.id}`,
      bearer(alice.token, json({ status: "edited" }, { method: "PUT" })),
    );
    expect(
      await sql(
        h.store,
        `SELECT json_extract(o.body, '$.activity.type') AS type, d.inbox_url, d.addressee
				FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id ORDER BY d.id`,
      ),
    ).toEqual([
      { type: "Like", inbox_url: "https://remote.example/inbox", addressee: null },
      { type: "Create", inbox_url: "https://carol.example/inbox", addressee: null },
      {
        type: "Create",
        inbox_url: "https://carol.example/users/carol/inbox",
        addressee: "https://carol.example/users/carol",
      },
      {
        type: "Update",
        inbox_url: "https://carol.example/users/carol/inbox",
        addressee: "https://carol.example/users/carol",
      },
    ]);
  });

  it("moves a Follow and its Undo to the personal inbox once when the shared inbox answers 404", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const dave = await remoteAccount(h.store, "dave", "remote.example");
    const shared = "https://remote.example/inbox";
    const personal = "https://remote.example/users/dave/inbox";
    await act(h, alice, `/api/v1/accounts/${dave}/follow`);
    const follow = await claim(h.store, NOW, "a");
    expect(follow.deliveries.map((d) => d.inbox)).toEqual([shared]);
    await act(h, alice, `/api/v1/accounts/${dave}/unfollow`);
    expect(await complete(h.store, follow.deliveries[0]?.id ?? "", "a", NOW, MISSING)).toMatchObject({
      status: "retry",
      retryAt: NOW,
    });
    // The same row, still first in the lane, its failed attempt counted, with the shared inbox's answer recorded.
    expect((await rows(h.store)).map((r) => [r.id, r.type, r.inbox_url, r.state, r.attempts, r.last_status])).toEqual([
      [follow.deliveries[0]?.id, "Follow", personal, "pending", 1, 404],
      [expect.any(String), "Undo", shared, "queued", 0, null],
    ]);
    const sent: [string, string][] = [];
    for (const [token, outcome] of [
      ["b", OK],
      ["c", MISSING],
      ["d", OK],
    ] as const) {
      const round = await claim(h.store, NOW, token);
      expect(round.deliveries).toHaveLength(1);
      const [delivery] = round.deliveries;
      sent.push([(JSON.parse(delivery?.body ?? "{}") as { type: string }).type, delivery?.inbox ?? ""]);
      await complete(h.store, delivery?.id ?? "", token, NOW, outcome);
    }
    expect(sent).toEqual([
      ["Follow", personal],
      ["Undo", shared],
      ["Undo", personal],
    ]);
    expect(await rows(h.store)).toEqual([]);
  });

  it("gives up without a fallback when no distinct personal inbox exists, or the personal inbox answers 404", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const same = await remoteAccount(h.store, "same", "same.example");
    await sql(h.store, "UPDATE accounts SET inbox_url = shared_inbox_url WHERE id = ?", same);
    const lone = await remoteAccount(h.store, "lone", "lone.example");
    await sql(h.store, "UPDATE accounts SET shared_inbox_url = NULL WHERE id = ?", lone);
    await act(h, alice, `/api/v1/accounts/${same}/follow`);
    await act(h, alice, `/api/v1/accounts/${lone}/follow`);
    const round = await claim(h.store, NOW, "a");
    for (const delivery of round.deliveries) {
      expect(await complete(h.store, delivery.id, "a", NOW, MISSING)).toMatchObject({ status: "gave_up" });
    }
    expect((await rows(h.store)).map((r) => [r.type, r.inbox_url, r.state])).toEqual([
      ["Follow", "https://same.example/inbox", "gave_up"],
      ["Follow", "https://lone.example/users/lone/inbox", "gave_up"],
    ]);
  });

  it("gives up without a fallback when the personal inbox is on another origin", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const dave = await remoteAccount(h.store, "dave", "remote.example");
    await sql(
      h.store,
      "UPDATE accounts SET inbox_url = 'https://elsewhere.example/users/dave/inbox' WHERE id = ?",
      dave,
    );
    await act(h, alice, `/api/v1/accounts/${dave}/follow`);
    const round = await claim(h.store, NOW, "a");
    expect(round.deliveries.map((d) => d.inbox)).toEqual(["https://remote.example/inbox"]);
    expect(await complete(h.store, round.deliveries[0]?.id ?? "", "a", NOW, MISSING)).toMatchObject({
      status: "gave_up",
    });
    expect((await rows(h.store)).map((r) => [r.inbox_url, r.state])).toEqual([
      ["https://remote.example/inbox", "gave_up"],
    ]);
  });

  it("bounds a recipient that swaps its inboxes between attempts by the attempt budget", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const dave = await remoteAccount(h.store, "dave", "remote.example");
    await act(h, alice, `/api/v1/accounts/${dave}/follow`);
    let completion: { status: string } = { status: "retry" };
    let posts = 0;
    while (completion.status === "retry") {
      const round = await claim(h.store, NOW, `t${posts}`);
      expect(round.deliveries).toHaveLength(1);
      posts++;
      completion = await complete(h.store, round.deliveries[0]?.id ?? "", `t${posts - 1}`, NOW, MISSING);
      // An actor Update makes the inbox just tried its shared inbox again.
      await sql(
        h.store,
        "UPDATE accounts SET inbox_url = shared_inbox_url, shared_inbox_url = inbox_url WHERE id = ?",
        dave,
      );
    }
    expect(completion.status).toBe("gave_up");
    expect(posts).toBe(MAX_ATTEMPTS);
    expect((await rows(h.store)).map((r) => [r.state, r.attempts])).toEqual([["gave_up", MAX_ATTEMPTS]]);
  });

  it("never moves an addressed activity to a personal inbox when the shared inbox answers 404", async () => {
    const { h, alice } = await audience();
    await post(h, alice, { status: "hello @other@other.example" });
    const round = await claim(h.store, NOW, "a");
    expect(round.deliveries.map((d) => d.inbox)).toEqual(["https://fans.example/inbox", "https://other.example/inbox"]);
    for (const delivery of round.deliveries) {
      expect(await complete(h.store, delivery.id, "a", NOW, MISSING)).toMatchObject({ status: "gave_up" });
    }
    expect((await rows(h.store)).map((r) => [r.inbox_url, r.state])).toEqual([
      ["https://fans.example/inbox", "gave_up"],
      ["https://other.example/inbox", "gave_up"],
    ]);
  });

  it("builds Follow, Undo, Accept and Reject in the intent format", () => {
    const input = {
      followUri: "https://kopje.test/ap/users/alice#follows/7",
      actorUri: "https://kopje.test/ap/users/alice",
      targetUri: "https://remote.example/users/dave",
      targetId: "100000000000000002",
    };
    expect(followActivity(input).audience).toEqual({ followers: false, accounts: [input.targetId] });
    expect(undoFollowActivity(input).activity.object).toMatchObject({ id: input.followUri, type: "Follow" });
    const answer = {
      localActorUri: "https://kopje.test/ap/users/alice",
      followerUri: "https://remote.example/users/dave",
      followerId: "100000000000000002",
      followUri: "https://remote.example/follows/1",
      edgeId: "9",
    };
    expect(followAnswerActivity("Accept", answer)).toEqual({
      activity: {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: `https://kopje.test/ap/users/alice#accepts/follows/${sha256Hex(answer.followUri)}`,
        type: "Accept",
        actor: answer.localActorUri,
        object: {
          id: answer.followUri,
          type: "Follow",
          actor: answer.followerUri,
          object: answer.localActorUri,
        },
      },
      audience: { followers: false, accounts: [answer.followerId] },
      followPair: answer.followerId,
    });
    expect(followAnswerActivity("Reject", { ...answer, followUri: null }).activity).toMatchObject({
      id: "https://kopje.test/ap/users/alice#rejects/follows/9",
      type: "Reject",
      object: { type: "Follow", actor: answer.followerUri },
    });
  });
});

describe("lane promotion with stale statistics (RES-7)", () => {
  it("seeks the lane's next row through deliveries_lane, with other lanes and given-up rows grown after ANALYZE", async () => {
    const { h, alice } = await audience();
    for (const status of ["first", "second", "third"]) {
      await post(h, alice, { status });
    }
    let leased: SentClaim | undefined;
    const settle = (id: string) =>
      plannedRun(h, /^UPDATE deliveries SET state = 'pending'/, completeDelivery, {
        id,
        leaseToken: "a",
        now: NOW + 1,
        storeNow: NOW + 1,
        outcome: OK,
      });
    const { before, after } = await staleStatistics(h, {
      settle: async () => {
        leased = await claim(h.store, NOW, "a");
      },
      capture: (phase) => settle(leased!.deliveries[phase === "before" ? 0 : 1]!.id),
      grow: async () => {
        // The pending heads of many other lanes of alice's, and given-up rows of the lane itself.
        await sql(
          h.store,
          `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 10000 - 1)
					INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, state, next_attempt_at, updated_at)
					SELECT d.activity_id, d.account_id, 'https://s' || n.i || '.example/inbox',
						CASE WHEN n.i % 2 = 0 THEN 'https://s' || n.i || '.example' ELSE d.lane END,
						CASE WHEN n.i % 2 = 0 THEN 'pending' ELSE 'gave_up' END, ?2, ?2
					FROM n CROSS JOIN deliveries d WHERE d.id = CAST(?1 AS INTEGER)`,
          leased!.deliveries[1]!.id,
          NOW,
        );
      },
    });
    const [fans, other] = leased!.deliveries;
    expect([fans?.inbox, other?.inbox]).toEqual(["https://fans.example/inbox", "https://other.example/inbox"]);
    for (const [name, run] of Object.entries({ before, after })) {
      expect(run.result, name).toMatchObject({ status: "delivered" });
      expect(run.plans, name).toHaveLength(1);
    }
    const { plan, rows } = after.plans[0]!;
    expect(plan.filter((detail) => detail.includes("deliveries_lane (account_id=? AND lane=?)"))).toHaveLength(2);
    expect(scansOf(plan, ["deliveries"])).toEqual([]);
    expect(rows).toBe(before.plans[0]!.rows);
    // Each lane's next row is pending, the others still queued.
    expect(
      (
        await sql<{ state: string; inbox_url: string }>(
          h.store,
          "SELECT state, inbox_url FROM deliveries WHERE inbox_url IN ('https://fans.example/inbox', 'https://other.example/inbox') ORDER BY id",
        )
      )
        .filter((r) => r.state === "pending")
        .map((r) => r.inbox_url),
    ).toEqual(["https://fans.example/inbox", "https://other.example/inbox"]);
  });
});

describe("outbound reach with stale statistics (RES-7)", () => {
  // A status's reach as its activity is recorded, its followers' and quoters' inboxes, and whether a remote account
  // has local followers (inbound).
  const reach = readOperation<{ statusId: string; signer: string; remote: string }, unknown>(
    (db, { statusId, signer, remote }) => {
      const of = statusReach(db, statusId, noteQuote);
      return {
        reach: of,
        recipients: of === null ? null : recipientsFor(db, signer, { type: "Create" }, of.audience),
        quoters: reachQuoters(db, statusId),
        localFollowers: hasLocalFollowers(db, remote),
      };
    },
  );

  it("seeks the status, its parent, its quoters and the signer's followers by key, the Store grown after ANALYZE", async () => {
    const { h, alice, other, followed } = await audience();
    const parent = await seedStatus(h.store, {
      accountId: other,
      visibility: "public",
      uri: "https://other.example/o/1",
    });
    const status = await post(h, alice, { status: "reply", in_reply_to_id: parent });
    const quoter = await remoteAccount(h.store, "quoter", "quoter.example");
    const quote = await seedStatus(h.store, {
      accountId: quoter,
      visibility: "public",
      uri: "https://quoter.example/o/1",
    });
    await acceptQuote(h, quote, status.id);
    const run = () =>
      plannedRun(h, /./, reach, {
        statusId: status.id,
        signer: alice.id,
        remote: followed,
      });
    const { before, after } = await staleStatistics(h, {
      capture: () => run(),
      grow: async () => {
        // Other accounts following each other, their statuses and accepted quotes of them.
        await remoteAccounts(h, 100, 200);
        await sql(
          h.store,
          `INSERT INTO follows (account_id, target_account_id, state, created_at)
					SELECT a.id, b.id, 'accepted', ?1 FROM accounts a CROSS JOIN accounts b ON b.id = CAST(a.id + 1 AS TEXT)
					WHERE a.domain LIKE 'd%'`,
          new Date(NOW).toISOString(),
        );
        await sql(
          h.store,
          `INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
					SELECT CAST(a.id - 100000000000000000 AS TEXT), a.uri || '/s', a.id, 'public', '', ?1 FROM accounts a
					WHERE a.domain LIKE 'd%'`,
          new Date(NOW).toISOString(),
        );
        await sql(
          h.store,
          `INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, updated_at)
					SELECT s.id, t.uri, t.id, t.account_id, 'accepted', ?1 FROM statuses s
					CROSS JOIN statuses t ON t.id = CAST(s.id + 1 AS TEXT) WHERE s.uri LIKE 'https://d%'`,
          new Date(NOW).toISOString(),
        );
      },
    });
    expect(after.result).toEqual(before.result);
    expect(after.result).toMatchObject({
      reach: { owner: alice.id, audience: { followers: true } },
      quoters: [quoter],
      localFollowers: true,
    });
    const plans = after.plans.map(({ query, plan, rows }, i) => ({ query, plan, rows, was: before.plans[i]!.rows }));
    const seeks = (detail: string) => plans.filter(({ plan }) => plan.includes(detail)).length;
    // The status's owner and its parent; its quoters, read for the facts and for the reach; its followers; the remote
    // account's local followers.
    expect(seeks("SEARCH s USING INDEX sqlite_autoindex_statuses_1 (id=?)")).toBeGreaterThanOrEqual(4);
    expect(seeks("SEARCH p USING INDEX sqlite_autoindex_statuses_1 (id=?)")).toBe(1);
    expect(seeks("SEARCH f USING INDEX follows_target (target_account_id=? AND state=?)")).toBe(2);
    expect(seeks("SEARCH q USING INDEX sqlite_autoindex_quotes_1 (status_id=?)")).toBe(1);
    for (const { query, plan, rows, was } of plans) {
      const name = query.replace(/\s+/g, " ").slice(0, 80);
      expect(
        scansOf(plan, ["s", "p", "r", "f", "q", "a", "l", "m", "statuses", "media_attachments", "polls"]),
        name,
      ).toEqual([]);
      // One index entry past a range at most.
      expect(rows - was, name).toBeLessThanOrEqual(1);
    }
  }, 60_000);
});

// A row's provenance as stored (recipient_accounts), read by every reader within its written bound (rowProvenanceSql):
// a value an import leaves (the column has no CHECK) that is not TEXT of at most PROVENANCE_BYTES bytes holding a JSON
// array of at most PROVENANCE_MAX values reads as a row without provenance (NET-2, VIS-30, RES-7).
// EP-T8's stored values (below).
// The rows availableSql (audience.ts) reads of one remote candidate with every branch at its cap: the
// accounts_suspended entry and row of an account a domain block's job marked, which availability passes (2; one it
// makes unavailable ends the rule there, with fewer); and, while a suspend block exists, its coverage: its row by key
// and the selectors of its two keys (3), then the walk of both keys, one row to start and one per dot. A key is walked
// only within DNS_NAME_UTF8_BYTES bytes and ends in a non-dot, so it has at most DNS_NAME_UTF8_BYTES - 1 dots.
const EP_AVAILABLE_CEILING = 2 + 3 + 1 + 2 * (DNS_NAME_UTF8_BYTES - 1);
// The values the audience check reads for one entry of the provenance: it walks the activity's audience accounts, at
// most FALLBACK_AUDIENCE_MAX of them however many are stored, up to the entry's, reading the one at each place before
// it: at most FALLBACK_AUDIENCE_MAX - 1, for the account at the last place. The provenance may name an id more than
// once (rowProvenanceSql admits it), so every entry may be that one. An id not among those places reads all
// FALLBACK_AUDIENCE_MAX and no account.
const EP_AUDIENCE_READS = FALLBACK_AUDIENCE_MAX - 1;
// The rows personalFallback's provenance candidates read with every input at its cap (RES-7; the witness below): for
// each of the provenance's PROVENANCE_MAX entries, its account, the activity's rows (one per audience inbox of a Flag,
// at most 1 + MAX_REPORT_STATUSES) and one index entry past them, its chunk and one past it, the chunk's
// TARGET_CHUNK_SIZE targets, its availability and the audience check's values; and 4 for the row, its activity and the
// ends of their reads. The statement's check that a suspend block exists adds no row it counts: the witness reads
// exactly this with and without the block.
const EP_CANDIDATES_CEILING =
  PROVENANCE_MAX *
    (1 + (1 + MAX_REPORT_STATUSES + 1) + 2 + TARGET_CHUNK_SIZE + EP_AVAILABLE_CEILING + EP_AUDIENCE_READS) +
  4;
// Ids no account holds, of an account id's 18 digits.
const absent = (n: number) => Array.from({ length: n }, (_, i) => String(900_000_000_000_000_001n + BigInt(i)));
// A JSON array of `id` and an astral string, `bytes` UTF-8 bytes long (`["id","…"]`, each astral 4 bytes).
const astral = (id: string, bytes: number) => {
  const pad = bytes - (2 + 18 + 3 + 2);
  return JSON.stringify([id, "\u{1F600}".repeat(Math.floor(pad / 4)) + "x".repeat(pad % 4)]);
};
// Each stored value, as an SQL expression over its parameter, naming `id` among absent ones; `admitted`: whether the
// readers take it. The sharp ones pass every test but one, and name `id` as a string, as an account id is stored
// (an unquoted integer matches no TEXT id): 338 bytes of 16 values (bytes), 17 values in 54 bytes (count), an object
// (array), unterminated JSON (JSON), a BLOB of an array's text (TEXT).
function epT8Cases(id: string): { name: string; sql: string; value: string | null; admitted: boolean }[] {
  const sixteen = [id, ...absent(15)];
  return [
    { name: "16 ids, 337 bytes", sql: "?", value: JSON.stringify(sixteen), admitted: true },
    { name: "astral, 337 bytes", sql: "?", value: astral(id, PROVENANCE_BYTES), admitted: true },
    { name: "16 ids, 338 bytes", sql: "?", value: ` ${JSON.stringify(sixteen)}`, admitted: false },
    { name: "astral, 338 bytes", sql: "?", value: astral(id, PROVENANCE_BYTES + 1), admitted: false },
    { name: "17 ids", sql: "?", value: JSON.stringify([...sixteen, ...absent(17).slice(16)]), admitted: false },
    {
      name: "17 values, 54 bytes",
      sql: "?",
      value: JSON.stringify([id, ...Array<number>(16).fill(0)]),
      admitted: false,
    },
    { name: "an object", sql: "?", value: JSON.stringify({ a: id }), admitted: false },
    { name: "invalid JSON", sql: "?", value: `["${id}"`, admitted: false },
    // SQLite's JSON functions read TEXT up to a NUL, every reader alike: the array before it.
    { name: "a NUL", sql: "?", value: `["${id}"]\0x`, admitted: true },
    { name: "a BLOB", sql: "CAST(? AS BLOB)", value: JSON.stringify([id]), admitted: false },
    { name: "an integer", sql: "CAST(? AS INTEGER)", value: id, admitted: false },
  ];
}
const EP_T8_NAMES = epT8Cases("").map((c) => c.name);

describe("a row's stored provenance is read within its written bound (EP-T8)", () => {
  const SHARED = "https://remote.example/inbox";
  const PERSONAL = "https://remote.example/users/dave/inbox";
  it("measures the sharp cases in bytes and values", () => {
    const id = "100000000000000002";
    const byName = Object.fromEntries(epT8Cases(id).map((c) => [c.name, c.value ?? ""]));
    const bytes = (name: string) => new TextEncoder().encode(byName[name]).length;
    expect(PROVENANCE_BYTES).toBe(337);
    expect([bytes("16 ids, 337 bytes"), bytes("astral, 337 bytes")]).toEqual([337, 337]);
    expect([bytes("16 ids, 338 bytes"), bytes("astral, 338 bytes")]).toEqual([338, 338]);
    expect(byName["astral, 338 bytes"]!.length).toBeLessThan(PROVENANCE_BYTES);
    expect(bytes("17 values, 54 bytes")).toBe(54);
    expect((JSON.parse(byName["17 values, 54 bytes"]!) as unknown[]).length).toBe(PROVENANCE_MAX + 1);
    expect((JSON.parse(byName["16 ids, 338 bytes"]!) as unknown[]).length).toBe(PROVENANCE_MAX);
  });

  // The send-time check (VIS-30) reads the row's provenance from the due-row read: a row naming only an unavailable
  // recipient is dropped when admitted, and checked by its inbox host only (sent) otherwise.
  it("is the send-time check's provenance only when admitted", async () => {
    for (const c of epT8Cases("")) {
      const h = await community(["alice"]);
      const { alice } = h.users;
      const dave = await remoteAccount(h.store, "dave", "remote.example");
      await act(h, alice, `/api/v1/accounts/${dave}/follow`);
      await claim(h.store, NOW, "settle");
      await sql(h.store, "UPDATE deliveries SET state = 'pending', lease_token = NULL, next_attempt_at = ?", NOW);
      await sql(h.store, "UPDATE accounts SET deleted_at = ? WHERE id = ?", new Date(NOW).toISOString(), dave);
      const value = epT8Cases(dave).find((d) => d.name === c.name)!;
      await sql(h.store, `UPDATE deliveries SET recipient_accounts = ${value.sql}`, value.value);
      const round = await claim(h.store, NOW, "a");
      expect(
        round.deliveries.map((d) => d.inbox),
        c.name,
      ).toEqual(c.admitted ? [] : [SHARED]);
    }
  });

  // A forward's row (Audience.shares) moves only by an admitted provenance naming one account behind its inbox.
  it("is a forward's fallback provenance only when admitted", async () => {
    for (const c of epT8Cases("")) {
      const h = await community(["alice"]);
      const { alice } = h.users;
      const dave = await remoteAccount(h.store, "dave", "remote.example");
      const value = epT8Cases(dave).find((d) => d.name === c.name)!;
      await queuedRow(h.store, alice.id, value);
      const round = await claim(h.store, NOW, "a");
      expect(round.deliveries.map((d) => d.inbox)).toEqual([SHARED]);
      expect(await complete(h.store, round.deliveries[0]!.id, "a", NOW, MISSING), c.name).toMatchObject({
        status: c.admitted ? "retry" : "gave_up",
      });
      expect((await rows(h.store)).map((r) => r.inbox_url)).toEqual([c.admitted ? PERSONAL : SHARED]);
    }
  });

  // The bound is the writers': expansion over PROVENANCE_MAX accounts behind one shared inbox writes PROVENANCE_BYTES
  // bytes, which the readers admit; one more account writes recipients_many instead.
  it("holds what expansion writes", async () => {
    for (const [count, many] of [
      [PROVENANCE_MAX, false],
      [PROVENANCE_MAX + 1, true],
    ] as const) {
      const h = await community(["alice"]);
      const { alice } = h.users;
      await sql(
        h.store,
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
				INSERT INTO accounts (id, uri, username, domain, inbox_url, shared_inbox_url)
				SELECT printf('%018d', 800000000000000000 + i), 'https://many.example/users/u' || i, 'u' || i,
					'many.example', 'https://many.example/users/u' || i || '/inbox', 'https://many.example/inbox' FROM n`,
        count,
      );
      await sql(
        h.store,
        "INSERT INTO follows (account_id, target_account_id, state) SELECT id, ?, 'accepted' FROM accounts WHERE domain = 'many.example'",
        alice.id,
      );
      await post(h, alice, { status: "to many" });
      await claim(h.store, NOW, "a");
      expect(
        await sql(
          h.store,
          `SELECT length(CAST(recipient_accounts AS BLOB)) AS bytes, ${rowProvenanceSql("recipient_accounts")} IS NOT NULL
						AS admitted, recipients_many AS many FROM deliveries WHERE inbox_url = 'https://many.example/inbox'`,
        ),
      ).toEqual([many ? { bytes: null, admitted: 0, many: 1 } : { bytes: PROVENANCE_BYTES, admitted: 1, many: null }]);
    }
  });
});

// NET-2's shared-inbox fallback by the row's provenance: a row that recorded its recipients moves to the personal inbox
// of one it names, whatever shared inbox that recipient names since (an actor document read again under #1686 may name
// none: here its stored shared inbox is cleared, as upsertRemoteActor stores what remoteActorInput reads); a row
// without provenance moves by today's rule alone.
describe("the shared-inbox fallback by the row's provenance (#1686, NET-2)", () => {
  const SHARED = "https://remote.example/inbox";
  const personal = (name: string) => `https://remote.example/users/${name}/inbox`;
  const unshare = (h: { store: StoreStub }, id: string) =>
    sql(h.store, "UPDATE accounts SET shared_inbox_url = NULL WHERE id = ?", id);
  const provenance = (ids: readonly string[]) => ({ sql: "?", value: JSON.stringify(ids) });
  // A Follow of `target` by alice, leased at the shared inbox under token "a", its provenance as expansion wrote it.
  async function leasedFollow(h: Awaited<ReturnType<typeof community>>, target: string) {
    await act(h, h.users.alice!, `/api/v1/accounts/${target}/follow`);
    const round = await claim(h.store, NOW, "a");
    expect(round.deliveries.map((d) => d.inbox)).toEqual([SHARED]);
    return round.deliveries[0]!.id;
  }
  const failed = (h: { store: StoreStub }, id: string) => complete(h.store, id, "a", NOW, MISSING);
  const state = async (h: { store: StoreStub }) => (await rows(h.store)).map((r) => [r.type, r.inbox_url, r.state]);

  // EP-T6: rows queued before the actor's shared inbox changed.
  it("moves a Follow whose provenance names the recipient, though it names no shared inbox since (EP-T6)", async () => {
    const h = await community(["alice"]);
    const dave = await remoteAccount(h.store, "dave", "remote.example");
    const id = await leasedFollow(h, dave);
    expect(await sql(h.store, "SELECT recipient_accounts AS r FROM deliveries")).toEqual([
      { r: JSON.stringify([dave]) },
    ]);
    await unshare(h, dave);
    expect(await failed(h, id)).toMatchObject({ status: "retry", retryAt: NOW });
    expect(await state(h)).toEqual([["Follow", personal("dave"), "pending"]]);
    const again = await claim(h.store, NOW, "b");
    expect(again.deliveries.map((d) => d.inbox)).toEqual([personal("dave")]);
    expect(await complete(h.store, again.deliveries[0]!.id, "b", NOW, OK)).toMatchObject({ status: "delivered" });
    expect(await rows(h.store)).toEqual([]);
  });

  it("moves a Flag's row without provenance by today's rule alone (EP-T6)", async () => {
    for (const shared of [true, false]) {
      const h = await community(["alice"]);
      // `other`, of a lower id, has its personal inbox on the shared inbox's origin and another shared inbox.
      const other = await remoteAccount(h.store, "other", "remote.example");
      const dave = await remoteAccount(h.store, "dave", "remote.example");
      expect(BigInt(other)).toBeLessThan(BigInt(dave));
      await sql(h.store, "UPDATE accounts SET shared_inbox_url = 'https://remote.example/other' WHERE id = ?", other);
      if (!shared) {
        await unshare(h, dave);
      }
      // As a dump from before migration 0044 restores it: no recipients recorded.
      await queuedRow(
        h.store,
        h.users.alice.id,
        { sql: "NULL", value: null },
        { kind: "flag", accounts: [other, dave] },
      );
      const round = await claim(h.store, NOW, "a");
      expect(await failed(h, round.deliveries[0]!.id), String(shared)).toMatchObject({
        status: shared ? "retry" : "gave_up",
      });
      expect(await state(h), String(shared)).toEqual([
        ["Flag", shared ? personal("dave") : SHARED, shared ? "pending" : "gave_up"],
      ]);
    }
  });

  it("moves a forward's row whose provenance names one recipient, though it names no shared inbox since (EP-T6)", async () => {
    const h = await community(["alice"]);
    const dave = await remoteAccount(h.store, "dave", "remote.example");
    await unshare(h, dave);
    await queuedRow(h.store, h.users.alice.id, provenance([dave]));
    const round = await claim(h.store, NOW, "a");
    expect(await failed(h, round.deliveries[0]!.id)).toMatchObject({ status: "retry" });
    expect(await state(h)).toEqual([["Delete", personal("dave"), "pending"]]);
  });

  // A row with provenance moves by its recipient whatever inbox it was written to: one sent to the personal inbox the
  // recipient has since moved on the same origin follows it there; one the recipient moved to another origin gives up.
  it("moves a row sent to a personal inbox its recipient moved on the same origin, and not to another (EP-T6)", async () => {
    for (const [moved, status] of [
      ["https://remote.example/users/dave/inbox2", "retry"],
      ["https://elsewhere.example/users/dave/inbox", "gave_up"],
    ] as const) {
      const h = await community(["alice"]);
      const dave = await remoteAccount(h.store, "dave", "remote.example");
      await unshare(h, dave);
      await act(h, h.users.alice, `/api/v1/accounts/${dave}/follow`);
      const round = await claim(h.store, NOW, "a");
      expect(round.deliveries.map((d) => d.inbox)).toEqual([personal("dave")]);
      await sql(h.store, "UPDATE accounts SET inbox_url = ? WHERE id = ?", moved, dave);
      expect(await failed(h, round.deliveries[0]!.id), moved).toMatchObject({ status });
      expect(await state(h), moved).toEqual([
        ["Follow", status === "retry" ? moved : personal("dave"), status === "retry" ? "pending" : "gave_up"],
      ]);
    }
  });

  // Only an account the activity's audience names is a candidate, as without provenance: a row of an activity without
  // to that reaches followers (a pin's Add: audience followers, no accounts) never moves, though its provenance names
  // the followers behind the inbox. Moved to one of them, it would serve that follower alone, and the pin's later
  // Remove would wait behind it in the lane.
  it("moves no row of a pin's Add, whose provenance names followers its audience does not (NET-2)", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const fans = [await remoteAccount(h.store, "fan", "remote.example"), await remoteAccount(h.store, "fan2")];
    for (const fan of fans) {
      await remoteFollows(h.store, fan, alice.id);
    }
    const status = await post(h, alice, { status: "pin me" });
    // The actor's featured collection is known already, so the pin sends its Add alone.
    await sql(h.store, "UPDATE local_accounts SET featured_announced = 1 WHERE account_id = ?", alice.id);
    const create = await claim(h.store, NOW, "c");
    expect(await complete(h.store, create.deliveries[0]!.id, "c", NOW, OK)).toMatchObject({ status: "delivered" });
    await act(h, alice, `/api/v1/statuses/${status.id}/pin`);
    const round = await claim(h.store, NOW, "a");
    expect(round.deliveries.map((d) => d.inbox)).toEqual([SHARED]);
    expect(await sql(h.store, "SELECT recipient_accounts AS r FROM deliveries")).toEqual([
      { r: JSON.stringify(fans.toSorted()) },
    ]);
    expect(await failed(h, round.deliveries[0]!.id)).toMatchObject({ status: "gave_up" });
    expect(await state(h)).toEqual([["Add", SHARED, "gave_up"]]);
  });

  // A retraction moves to its first candidate whether or not that one is available, as the send-time check never
  // refuses one (VIS-30): an Undo still reaches a recipient suspended since it was queued.
  it("moves an Undo to the personal inbox of a recipient unavailable since", async () => {
    const h = await community(["alice"]);
    const dave = await remoteAccount(h.store, "dave", "remote.example");
    await act(h, h.users.alice, `/api/v1/accounts/${dave}/follow`);
    const follow = await claim(h.store, NOW, "f");
    expect(await complete(h.store, follow.deliveries[0]!.id, "f", NOW, OK)).toMatchObject({ status: "delivered" });
    await act(h, h.users.alice, `/api/v1/accounts/${dave}/unfollow`);
    const round = await claim(h.store, NOW, "a");
    expect(round.deliveries.map((d) => d.inbox)).toEqual([SHARED]);
    await sql(
      h.store,
      "UPDATE accounts SET suspended_at = ?, suspension_source = 'account' WHERE id = ?",
      new Date(NOW).toISOString(),
      dave,
    );
    expect(await sql(h.store, `SELECT ${availableSql("?1")} AS available`, dave)).toEqual([{ available: 0 }]);
    expect(await failed(h, round.deliveries[0]!.id)).toMatchObject({ status: "retry" });
    expect(await state(h)).toEqual([["Undo", personal("dave"), "pending"]]);
    const again = await claim(h.store, NOW, "b");
    expect(again.deliveries.map((d) => d.inbox)).toEqual([personal("dave")]);
  });

  // The candidate's host check (inboxCovered of its actor id): availability judges an account's stored domain and its
  // actor id's host as stored, the check that host as the URL parser reads it. They differ for an actor the cutover's
  // conversion keeps with a non-ASCII host and a port: its domain is the URL's host with the port, its id stays as
  // written (cli/lib/cutover/convert.js), and the Store's import takes both, so a block of the host's punycode form
  // covers neither key and only the check keeps the row from that server's account.
  it("moves no row to an imported account of a server blocked under its punycode form", async () => {
    const source = await community(["alice"]);
    const uri = "https://bücher.example:8443/users/dave";
    const dave = "600000000000000001";
    await sql(
      source.store,
      `INSERT INTO accounts (id, uri, username, domain, inbox_url, shared_inbox_url) VALUES (?1, ?2, 'dave', ?3, ?4, ?5)`,
      dave,
      uri,
      "xn--bcher-kva.example:8443",
      personal("dave"),
      SHARED,
    );
    const store = await migratedStore();
    await copyConfig(source.store, store);
    expect((await importViaRpc(store, (await dumpViaRpc(source.store)).text)).report).toMatchObject({ ok: true });
    expect(await store.publish(BUILD, ACCESS)).toMatchObject({ ok: true });
    expect(await sql(store, "SELECT uri, domain FROM accounts WHERE id = ?", dave)).toEqual([
      { uri, domain: "xn--bcher-kva.example:8443" },
    ]);
    await blockDomain(store, "xn--bcher-kva.example");
    expect(await sql(store, `SELECT ${availableSql("?1")} AS available`, dave)).toEqual([{ available: 1 }]);
    await queuedRow(store, source.users.alice.id, provenance([dave]), { kind: "flag", accounts: [dave] });
    const round = await claim(store, NOW, "a");
    expect(round.deliveries.map((d) => d.inbox)).toEqual([SHARED]);
    expect(await failed({ store }, round.deliveries[0]!.id)).toMatchObject({ status: "gave_up" });
    expect(await state({ store })).toEqual([["Flag", SHARED, "gave_up"]]);
  });

  // EP-T7: what still keeps a row from moving.
  it("moves no row to another origin, an inbox the activity has, two recipients, or one its provenance does not name (EP-T7)", async () => {
    const cases: [string, (h: Awaited<ReturnType<typeof community>>) => Promise<string>][] = [
      [
        "a personal inbox on another origin",
        async (h) => {
          const dave = await remoteAccount(h.store, "dave", "remote.example");
          await sql(
            h.store,
            "UPDATE accounts SET inbox_url = 'https://elsewhere.example/users/dave/inbox' WHERE id = ?",
            dave,
          );
          const id = await leasedFollow(h, dave);
          await unshare(h, dave);
          return id;
        },
      ],
      [
        "a row of the activity at the personal inbox",
        async (h) => {
          const dave = await remoteAccount(h.store, "dave", "remote.example");
          const id = await leasedFollow(h, dave);
          await unshare(h, dave);
          await sql(
            h.store,
            `INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, state, next_attempt_at, updated_at)
							SELECT activity_id, account_id, ?, lane, 'gave_up', next_attempt_at, updated_at FROM deliveries`,
            personal("dave"),
          );
          return id;
        },
      ],
      [
        "an unexpanded target of the activity at the personal inbox",
        async (h) => {
          const dave = await remoteAccount(h.store, "dave", "remote.example");
          const id = await leasedFollow(h, dave);
          await unshare(h, dave);
          await sql(
            h.store,
            "INSERT INTO outbound_targets (activity_id, targets) SELECT activity_id, json_array(json_object('inbox', ?)) FROM deliveries",
            personal("dave"),
          );
          return id;
        },
      ],
      [
        "a forward's row naming two movable recipients",
        async (h) => {
          const dave = await remoteAccount(h.store, "dave", "remote.example");
          const erin = await remoteAccount(h.store, "erin", "remote.example");
          await queuedRow(h.store, h.users.alice!.id, provenance([dave, erin]));
          return (await claim(h.store, NOW, "a")).deliveries[0]!.id;
        },
      ],
      [
        "a forward's row without provenance, its audience naming one at the shared inbox",
        async (h) => {
          const dave = await remoteAccount(h.store, "dave", "remote.example");
          await queuedRow(h.store, h.users.alice!.id, { sql: "NULL", value: null }, { accounts: [dave] });
          return (await claim(h.store, NOW, "a")).deliveries[0]!.id;
        },
      ],
      [
        "a recipient at the shared inbox the provenance does not name",
        async (h) => {
          const dave = await remoteAccount(h.store, "dave", "remote.example");
          const id = await leasedFollow(h, dave);
          await sql(h.store, "UPDATE deliveries SET recipient_accounts = json_array('900000000000000001')");
          return id;
        },
      ],
    ];
    for (const [name, arrange] of cases) {
      const h = await community(["alice"]);
      const id = await arrange(h);
      expect(await failed(h, id), name).toMatchObject({ status: "gave_up" });
      expect(
        (await rows(h.store)).filter((r) => r.state !== "gave_up" || r.inbox_url !== SHARED),
        name,
      ).toEqual(
        name.startsWith("a row of the activity") ? [expect.objectContaining({ inbox_url: personal("dave") })] : [],
      );
    }
  });

  // EP-T8, the personal fallback: a stored value it does not admit, or recipients_many, reads as no provenance (today's
  // rule: dave, re-read to no shared inbox, is no candidate), and an admitted one moves the row to dave.
  it("reads the row's provenance within its written bound (EP-T8)", async () => {
    const values = [...EP_T8_NAMES.map((name) => ({ name, many: false })), { name: "16 ids, 337 bytes", many: true }];
    for (const { name, many } of values) {
      const h = await community(["alice"]);
      const dave = await remoteAccount(h.store, "dave", "remote.example");
      const id = await leasedFollow(h, dave);
      await unshare(h, dave);
      const value = epT8Cases(dave).find((c) => c.name === name)!;
      await sql(
        h.store,
        `UPDATE deliveries SET recipient_accounts = ${value.sql}, recipients_many = ${many ? 1 : "NULL"}`,
        value.value,
      );
      const label = `${name}${many ? ", recipients_many" : ""}`;
      expect(await failed(h, id), label).toMatchObject({ status: value.admitted && !many ? "retry" : "gave_up" });
    }
  });

  // RES-7: the provenance's candidates, every input at its cap at once: the provenance at PROVENANCE_MAX ids in
  // PROVENANCE_BYTES bytes, each a candidate that reaches both checks; the activity (a Flag) at its audience's cap (1 +
  // MAX_REPORT_STATUSES accounts), with a row at each audience inbox and an unexpanded chunk of TARGET_CHUNK_SIZE
  // targets, none at a candidate's inbox, so each check walks them all. The provenance is the audience's last
  // PROVENANCE_MAX accounts, or its last one PROVENANCE_MAX times (the ceiling: the audience check reads the most for
  // each); behind 1,000 other ids, as only an import stores, they are past the accounts the check reads, so none is a
  // candidate and the row gives up. After ANALYZE, other activities' rows and chunks and other accounts grow; the
  // statement reads the same rows, by key.
  it.each([
    ["distinct, at the audience's end", "distinct", "retry"],
    ["one repeated, the audience's last", "repeated", "retry"],
    ["distinct, behind 1,000 other ids of a longer audience", "long", "gave_up"],
  ] as const)(
    "reads the provenance's candidates by key, flat as other rows grow: %s (RES-7)",
    async (_name, kind, status) => {
      expect(FALLBACK_AUDIENCE_MAX).toBe(1 + MAX_REPORT_STATUSES);
      const h = await community(["alice"]);
      const audience = 1 + MAX_REPORT_STATUSES;
      await sql(
        h.store,
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO accounts (id, uri, username, domain, inbox_url, shared_inbox_url)
			SELECT printf('%018d', 700000000000000000 + i), 'https://remote.example/users/u' || i, 'u' || i, 'remote.example',
				'https://remote.example/users/u' || i || '/inbox', NULL FROM n`,
        audience,
      );
      const ids = (
        await sql<{ id: string }>(h.store, "SELECT id FROM accounts WHERE domain = 'remote.example' ORDER BY id")
      ).map((r) => r.id);
      const named = kind === "repeated" ? Array<string>(PROVENANCE_MAX).fill(ids.at(-1)!) : ids.slice(-PROVENANCE_MAX);
      expect(JSON.stringify(named)).toHaveLength(PROVENANCE_BYTES);
      // The audience as stored: a Flag's (distinct, in id order), or one only an import holds, past
      // FALLBACK_AUDIENCE_MAX.
      const stored = kind === "long" ? [...absent(1000), ...ids] : ids;
      // Every branch of each candidate's availability (availableSql) at its cap: a suspend block of none of their keys,
      // so each coverage walk runs to its end; two distinct keys of each candidate (its stored domain and its actor
      // id's host), each of DNS_NAME_UTF8_BYTES bytes with a dot at every byte but its last, the longest walk; each
      // candidate marked by a domain block's job, an accounts_suspended entry availability reads and passes; and the
      // deleting and the instance-suspended accounts' indexes holding other accounts.
      await blockDomain(h.store, "unrelated.example");
      const key = (last: string) => `${".".repeat(DNS_NAME_UTF8_BYTES - 1)}${last}`;
      await sql(
        h.store,
        `UPDATE accounts SET domain = ?1, uri = 'https://' || ?2 || '/users/' || username, suspended_at = ?3,
				suspension_source = 'domain' WHERE id IN (SELECT value FROM json_each(?4))`,
        key("y"),
        key("z"),
        new Date(NOW).toISOString(),
        JSON.stringify(named),
      );
      await sql(
        h.store,
        `INSERT INTO accounts (id, uri, username, domain, deleted_at, suspended_at, suspension_source)
			VALUES ('799999999999999998', 'https://d.example/users/d', 'd', 'd.example', ?1, NULL, NULL),
				('799999999999999999', 'https://s.example/users/s', 's', 's.example', NULL, ?1, 'account')`,
        new Date(NOW).toISOString(),
      );
      const activity = await queuedRow(h.store, h.users.alice.id, provenance(named), {
        kind: "flag",
        accounts: stored,
      });
      await sql(
        h.store,
        `INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, state, next_attempt_at, updated_at)
			SELECT CAST(?1 AS INTEGER), ?2, 'https://x' || value || '.example/inbox', 'https://x' || value || '.example',
				'gave_up', ?3, ?3 FROM json_each(?4)`,
        activity,
        h.users.alice.id,
        NOW,
        JSON.stringify(ids.slice(1)),
      );
      await sql(
        h.store,
        `INSERT INTO outbound_targets (activity_id, targets) SELECT CAST(?1 AS INTEGER), json_group_array(json_object('inbox',
				'https://t' || value || '.example/inbox')) FROM json_each(?2)`,
        activity,
        JSON.stringify(Array.from({ length: TARGET_CHUNK_SIZE }, (_, i) => i)),
      );
      expect(
        await sql(h.store, "SELECT count(*) AS rows FROM deliveries WHERE activity_id = CAST(? AS INTEGER)", activity),
      ).toEqual([{ rows: audience }]);
      // A newer activity with a row and a chunk, so each range the candidates walk ends at an entry of another activity
      // from the start (one index entry past each range), as it would among the neighbours grown below.
      const newer = await queuedRow(h.store, h.users.alice.id, { sql: "NULL", value: null }, { kind: "flag" });
      await sql(h.store, "UPDATE deliveries SET state = 'gave_up' WHERE activity_id = CAST(? AS INTEGER)", newer);
      await sql(
        h.store,
        "INSERT INTO outbound_targets (activity_id, targets) VALUES (CAST(? AS INTEGER), json_array(json_object('inbox', ?)))",
        newer,
        "https://n.example/inbox",
      );
      const subject = (await claim(h.store, NOW, "a")).deliveries[0]!;
      expect(subject.inbox).toBe(SHARED);
      const { before, after } = await staleStatistics(h, {
        capture: async () => {
          const run = await plannedRun(h, /json_each\(d\.provenance\)/, completeDelivery, {
            id: subject.id,
            leaseToken: "a",
            now: NOW,
            storeNow: NOW,
            outcome: MISSING,
          });
          // Put the row back as it was, leased at the shared inbox.
          await sql(
            h.store,
            `UPDATE deliveries SET state = 'leased', lease_token = 'a', inbox_url = ?2, recipient_accounts = ?3
						WHERE id = CAST(?1 AS INTEGER)`,
            subject.id,
            SHARED,
            JSON.stringify(named),
          );
          return run;
        },
        grow: async () => {
          await sql(
            h.store,
            `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000)
					INSERT INTO accounts (id, uri, username, domain, inbox_url, shared_inbox_url)
					SELECT printf('%018d', 800000000000000000 + i), 'https://g.example/users/g' || i, 'g' || i, 'g.example',
						'https://g.example/users/g' || i || '/inbox', 'https://g.example/inbox' FROM n`,
          );
          await sql(
            h.store,
            `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200)
					INSERT INTO outbound_activities (account_id, body, object_uri, created_at)
					SELECT ?1, json_object('activity', json_object('type', 'Flag')), 'https://g.example/' || i, ?2 FROM n`,
            h.users.alice.id,
            NOW,
          );
          await sql(
            h.store,
            `INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, state, next_attempt_at, updated_at)
					SELECT o.id, o.account_id, 'https://g.example/users/' || n.i || '/inbox', 'https://g.example', 'gave_up', ?1, ?1
					FROM outbound_activities o CROSS JOIN (SELECT value AS i FROM json_each(?2)) n
					WHERE o.object_uri GLOB 'https://g.example/*'`,
            NOW,
            JSON.stringify(Array.from({ length: 20 }, (_, i) => i)),
          );
          await sql(
            h.store,
            `INSERT INTO outbound_targets (activity_id, targets) SELECT id, json_array(json_object('inbox', 'https://g.example/inbox'))
					FROM outbound_activities WHERE object_uri GLOB 'https://g.example/*'`,
          );
        },
      });
      for (const [phase, run] of Object.entries({ before, after })) {
        expect(run.result, phase).toMatchObject({ status });
        expect(run.plans, phase).toHaveLength(1);
        // d and o are the row and its activity, one each, read by key.
        expect(
          scansOf(run.plans[0]!.plan, ["a", "e", "c", "deliveries", "outbound_activities", "accounts"]),
          phase,
        ).toEqual([]);
        expect(
          run.plans[0]!.plan.filter((detail) =>
            /^SEARCH (deliveries|outbound_activities) USING INTEGER PRIMARY KEY/.test(detail),
          ),
        ).toHaveLength(2);
      }
      expect(after.plans[0]!.rows).toBe(before.plans[0]!.rows);
      const rows = before.plans[0]!.rows;
      expect(EP_CANDIDATES_CEILING).toBe(37_332); // The figure docs/threat-model.md (NET-2) states.
      expect(rows).toBeLessThanOrEqual(EP_CANDIDATES_CEILING);
      if (kind === "long") {
        // Each entry reads the first FALLBACK_AUDIENCE_MAX values, none of them a candidate, and no account.
        expect(rows).toBe(PROVENANCE_MAX * FALLBACK_AUDIENCE_MAX + 4);
      } else {
        // The ceiling: every entry the audience's last account, read at the last place the walk reads; distinct ones
        // read 15, 14, ... 0 values fewer. Each candidate walks the activity's rows, its chunk's targets and both its
        // keys.
        expect(rows).toBe(
          EP_CANDIDATES_CEILING - (kind === "distinct" ? (PROVENANCE_MAX * (PROVENANCE_MAX - 1)) / 2 : 0),
        );
        expect(rows).toBeGreaterThan(PROVENANCE_MAX * (audience + TARGET_CHUNK_SIZE + 2 * (DNS_NAME_UTF8_BYTES - 1)));
      }
    },
    120_000,
  );
});

// A pending row of `account` to remote.example's shared inbox, its provenance stored as `value` is: a forward's (a
// forwarded Delete: Audience.shares, a retraction, so the send-time check passes it), or a Flag's (no `to`, as
// reports.ts writes it, its audience `accounts`). Returns the activity's id.
async function queuedRow(
  store: StoreStub,
  account: string,
  value: { sql: string; value: string | null },
  options: { kind?: "forward" | "flag"; accounts?: readonly string[] } = {},
): Promise<string> {
  const flag = options.kind === "flag";
  const [activity] = await sql<{ id: string }>(
    store,
    `INSERT INTO outbound_activities (account_id, body, object_uri, retracts, created_at)
			VALUES (?1, json_object('activity', json_object('type', ?3, 'id', 'https://other.example/notes/1#' || ?3,
				'actor', 'https://other.example/users/o', 'object', 'https://other.example/notes/1'),
				'audience', CASE WHEN ?4 THEN json_object('followers', json('false'), 'accounts', json(?5))
					ELSE json_object('shares', json_array('https://kopje.test/ap/o/1'), 'accounts', json(?5)) END),
				'https://other.example/notes/1', ?6, ?2)
			RETURNING CAST(id AS TEXT) AS id`,
    account,
    NOW,
    flag ? "Flag" : "Delete",
    flag ? 1 : 0,
    JSON.stringify(options.accounts ?? []),
    flag ? 0 : 1,
  );
  await sql(
    store,
    `INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, state, next_attempt_at, updated_at,
			recipient_accounts)
			VALUES (CAST(?1 AS INTEGER), ?2, 'https://remote.example/inbox', 'https://remote.example', 'pending', ?3, ?3,
				${value.sql})`,
    activity!.id,
    account,
    NOW,
    ...(value.sql.includes("?") ? [value.value] : []),
  );
  return activity!.id;
}
