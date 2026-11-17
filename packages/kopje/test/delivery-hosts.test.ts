import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import {
  claimDeliveries,
  completeDelivery,
  type DeliveryOutcome,
  expandPending,
  retryDeliveries,
  stopDeliveryHost,
  sweepDeliveries,
} from "../src/domain/deliveries";
import {
  dayOf,
  deliveryHost,
  FAILURE_DAYS,
  HOST_UNAVAILABLE,
  hostCaused,
  markStopped,
  recordHostFailure,
  restartDeliveryHost,
} from "../src/domain/delivery-hosts";
import { type PostDeps, type PostTarget, postActivity } from "../src/federation/delivery";
import type { HostResolution, RequestSigner } from "../src/federation/loader";
import { handleQueue } from "../src/jobs/queue";
import type { StoreStub } from "../src/platform/store-client";
import {
  deliveryHostSql,
  laneHostOf,
  laneHostSql,
  MAX_DELIVERY_HOSTS,
  withinDeliveryHostBound,
} from "../src/platform/stored-bounds";
import { adminClaims, adminHarness, adminTeam, type AccessTeam, setTeamAccess } from "./access-helpers";
import { seedAccount, sql } from "./api-helpers";
import { harness, inboxDeps, NOW } from "./app-helpers";
import {
  DAY,
  HOST,
  hostRows,
  INBOX,
  inDb,
  LANE,
  lane,
  markUnavailable,
  outbound,
  rows,
  run,
  sender,
  states,
  tally,
} from "./delivery-host-helpers";
import { fixtureKeyGen, LEGACY_EMPTY_KEK, seedLocalAccount } from "./federation-helpers";
import { BUILD, completeSetup, deferred, migratedStore, testKernel } from "./helpers";
import { mastodonActor, RemoteWeb, signedInit } from "./inbox-helpers";
import { copyConfig, dumpViaRpc, importViaRpc, setAccess } from "./ops-helpers";

// Hosts that keep failing deliveries become unavailable (domain/delivery-hosts.ts; docs/mastodon-deviations.md,
// "Unavailable delivery hosts"; RES-4, RES-5): the stored host set, the marks and what counts toward them, the paths by
// which a row to an unavailable host could be sent, the clears, the cap, the listing and the operator's routes, the
// sweep, dumps and maintenance. The drain's bounds are test/delivery-host-drain.test.ts.

const DAY0 = Date.UTC(2026, 9, 1);
// deliveries.ts SWEEP_BATCH: the rows a sweep deletes at most.
const SWEEP_BATCH = 500;
const OK: DeliveryOutcome = { kind: "delivered", status: 202 };
const FAIL: DeliveryOutcome = {
  kind: "failed",
  status: 503,
  error: "HTTP 503",
  permanent: false,
  failure: { stage: "post" },
};

function failAt(store: StoreStub, host: string, now: number): Promise<void> {
  return inDb(store, (db) => recordHostFailure(db, host, now));
}

function claim(store: StoreStub, now = NOW, leaseToken = `lease-${now}`) {
  return run(store, claimDeliveries, { now, leaseToken });
}

function complete(store: StoreStub, id: string, leaseToken: string, outcome: DeliveryOutcome, now = NOW) {
  return run(store, completeDelivery, { id, leaseToken, now, outcome, storeNow: now });
}

let warn: MockInstance<typeof console.warn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn");
});

afterEach(() => {
  vi.restoreAllMocks();
});

function events(): unknown[] {
  return warn.mock.calls
    .map(([entry]) => (entry as { event?: unknown } | undefined)?.event)
    .filter((event) => typeof event === "string" && event.startsWith("kopje.delivery.host"));
}

describe("the stored host set (C15)", () => {
  const long = (last: number) => `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(last)}`;
  const VALUES: unknown[] = [
    "a.b",
    "ab",
    "a.",
    ".a",
    "a.example",
    "A.example",
    "a.example.",
    ".a.example",
    "a..b",
    "-a.example",
    "a-.example",
    "a.-b",
    "a-.b",
    "a-b.example",
    "a_b.example",
    "a b.example",
    "xn--bcher-kva.example",
    "bücher.example",
    "127.0.0.1",
    "[::1]",
    "a.example:443",
    `${"a".repeat(64)}.example`,
    long(61),
    long(62),
    "a.example\u0000",
    "",
    42,
    4.5,
    null,
    new TextEncoder().encode("a.example").buffer,
  ];

  it("deliveryHostSql and withinDeliveryHostBound agree, and every deliveryHost key is in the set", async () => {
    const { store } = await sender();
    const answers = await inDb(store, (db) =>
      VALUES.map(
        (value) =>
          db.first<{ ok: number }>(`SELECT ${deliveryHostSql("v")} AS ok FROM (SELECT ? AS v)`, value as never)?.ok,
      ),
    );
    expect(answers.map((ok) => ok === 1)).toEqual(VALUES.map((value) => withinDeliveryHostBound(value)));
    expect(VALUES.filter((value) => withinDeliveryHostBound(value))).toEqual([
      "a.b",
      "a.example",
      "a-b.example",
      "xn--bcher-kva.example",
      "127.0.0.1",
      `${"a".repeat(64)}.example`,
      long(61),
    ]);
    for (const inbox of [
      INBOX,
      "https://H.Example./users/a/inbox",
      "https://h.example...:8443/inbox",
      "https://bücher.example/inbox",
      "https://fans.example/inbox",
      "https://remote.example/users/o/inbox",
    ]) {
      const host = deliveryHost(inbox);
      expect(host !== null && withinDeliveryHostBound(host), inbox).toBe(true);
    }
  });

  it("refuses an import of a host outside the set", async () => {
    const { store } = await sender();
    const insert = (value: string) =>
      sql(store, `INSERT INTO delivery_hosts (host, failure_days, last_failure_day) VALUES (${value}, 1, 0)`);
    for (const value of [
      "CAST(x'80' AS TEXT)",
      "'A.example'",
      "'a.example.'",
      "'a..b'",
      "'-a.example'",
      `'${long(62)}'`,
      "'a.example' || char(0)",
      "x'612e6578616d706c65'",
    ]) {
      await expect(insert(value), value).rejects.toThrow(/CHECK constraint failed: delivery_hosts_host/);
    }
    await insert("'a.example'");
    expect(await hostRows(store)).toMatchObject([{ host: "a.example" }]);
  });
});

describe("lane hosts", () => {
  const blob = (text: string) => new TextEncoder().encode(text).buffer;
  const LANES: [unknown, string | null][] = [
    [LANE, HOST],
    ["https://h.example.", HOST],
    ["https://h.example...", HOST],
    ["https://h.example:8443", HOST],
    ["https://h.example..:8443", HOST],
    ["https://h.example:1", HOST],
    ["https://h.example:65535", HOST],
    [`https://h.example${".".repeat(251)}`, HOST],
    ["https://xn--bcher-kva.example", "xn--bcher-kva.example"],
    ["https://127.0.0.1:8443", "127.0.0.1"],
    ["https://.", ""],
    [`https://h.example${".".repeat(252)}`, null],
    ["http://h.example", null],
    ["https://H.example", null],
    ["https://h.example:08", null],
    ["https://h.example:", null],
    ["https://h.example:123456", null],
    ["https://h.example:8443:1", null],
    ["https://[::1]:8443", null],
    ["https://h_x.example", null],
    ["https://h.example/", null],
    ["https://bücher.example", null],
    ["https://h.example\u0000", null],
    ["", null],
    [42, null],
    [null, null],
    [blob(LANE), null],
  ];

  it("laneHostSql reads each lane as laneHostOf, and deliveryHost's key from every lane laneOf writes", async () => {
    const { store } = await sender();
    const answers = await inDb(store, (db) =>
      LANES.map(
        ([value]) =>
          db.first<{ host: string | null }>(`SELECT ${laneHostSql("v")} AS host FROM (SELECT ? AS v)`, value as never)
            ?.host,
      ),
    );
    expect(answers).toEqual(LANES.map(([, host]) => host));
    expect(LANES.map(([value]) => laneHostOf(value))).toEqual(LANES.map(([, host]) => host));
    // The lane is the inbox's origin (deliveries.ts laneOf), and its host is the key the inbox's failures count toward.
    for (const inbox of [
      INBOX,
      "https://H.Example/users/a/inbox",
      "https://h.example./inbox",
      "https://h.example.../inbox",
      "https://h.example:8443/inbox",
      "https://h.example..:8443/inbox",
      "https://h.example:443/inbox",
      "https://u:p@h.example/inbox?q=1#f",
      "https://bücher.example/inbox",
      "https://xn--bcher-kva.example./inbox",
    ]) {
      const host = deliveryHost(inbox);
      expect(host, inbox).not.toBeNull();
      expect(laneHostOf(new URL(inbox).origin), inbox).toBe(host);
    }
  });
});

describe("marks (C11)", () => {
  it("marks a host on the 7th distinct UTC day of failures, not the 6th, each day counted once", async () => {
    const { store } = await sender();
    for (const t of [DAY0, DAY0 + 1000, DAY0 + DAY - 1]) {
      await failAt(store, HOST, t);
    }
    expect(await hostRows(store)).toEqual([
      {
        host: HOST,
        failure_days: 1,
        last_failure_day: dayOf(DAY0),
        unavailable_since: null,
        drain_lane: null,
        drain_id: null,
      },
    ]);
    for (let d = 1; d <= 5; d++) {
      await failAt(store, HOST, DAY0 + d * DAY);
    }
    expect(await hostRows(store)).toMatchObject([{ failure_days: 6, unavailable_since: null, drain_lane: null }]);
    expect(events()).toEqual([]);
    await failAt(store, HOST, DAY0 + 6 * DAY + 5);
    expect(await hostRows(store)).toEqual([
      {
        host: HOST,
        failure_days: FAILURE_DAYS,
        last_failure_day: dayOf(DAY0) + 6,
        unavailable_since: DAY0 + 6 * DAY + 5,
        drain_lane: "",
        drain_id: "0",
      },
    ]);
    expect(events()).toEqual(["kopje.delivery.host_unavailable"]);
  });

  it("counts the failures of a lane's deliveries day by day, a success clearing them, and gives the 7th day's row up", async () => {
    const { store, alice } = await sender();
    const create = await outbound(store, alice);
    const [head, ...rest] = await lane(store, { activity: create, account: alice, count: 3, due: DAY0 });
    // Three failing days, then a success: the host is cleared.
    for (let d = 0; d < 3; d++) {
      const now = DAY0 + d * DAY;
      expect((await claim(store, now)).deliveries.map((c) => c.id)).toEqual([head]);
      expect(await complete(store, head!, `lease-${now}`, FAIL, now)).toMatchObject({ status: "retry" });
    }
    expect(await hostRows(store)).toMatchObject([{ failure_days: 3 }]);
    const cleared = DAY0 + 3 * DAY;
    await claim(store, cleared);
    expect(await complete(store, head!, `lease-${cleared}`, OK, cleared)).toMatchObject({ status: "delivered" });
    expect(await hostRows(store)).toEqual([]);
    // Seven more days of failures of the next row: the 7th marks the host, and that row is given up.
    const next = rest[0]!;
    for (let d = 4; d <= 10; d++) {
      const now = DAY0 + d * DAY;
      expect((await claim(store, now)).deliveries.map((c) => c.id)).toEqual([next]);
      expect(await complete(store, next, `lease-${now}`, FAIL, now)).toMatchObject({
        status: d < 10 ? "retry" : "gave_up",
      });
    }
    expect(await hostRows(store)).toMatchObject([{ failure_days: 7, unavailable_since: DAY0 + 10 * DAY }]);
    expect(await states(store)).toEqual([
      { id: next, state: "gave_up", last_error: HOST_UNAVAILABLE, attempts: 7 },
      // The drain the mark started gives up the lane's last row at the next claim.
      { id: rest[1]!, state: "pending", last_error: null, attempts: 0 },
    ]);
    await claim(store, DAY0 + 10 * DAY + 1);
    expect(await states(store, [rest[1]!])).toMatchObject([{ state: "gave_up", last_error: HOST_UNAVAILABLE }]);
    expect(await hostRows(store)).toMatchObject([{ drain_lane: null }]);
  });

  it("keeps an unavailable host's cursor on a later day's failure; a stop starts its drain again", async () => {
    const { store, alice } = await sender();
    const create = await outbound(store, alice);
    const [, , id] = await rows(store, { activity: create, account: alice, lane: "https://h.example:8443", count: 3 });
    await sql(
      store,
      `INSERT INTO delivery_hosts (host, failure_days, last_failure_day, unavailable_since, drain_lane, drain_id)
			VALUES (?1, 7, ?2, ?3, 'https://h.example:8443', CAST(?4 AS INTEGER))`,
      HOST,
      dayOf(DAY0),
      DAY0,
      id!,
    );
    await failAt(store, HOST, DAY0 + DAY);
    expect(await hostRows(store)).toEqual([
      {
        host: HOST,
        failure_days: 7,
        last_failure_day: dayOf(DAY0) + 1,
        unavailable_since: DAY0,
        drain_lane: "https://h.example:8443",
        drain_id: id,
      },
    ]);
    expect(await inDb(store, (db) => markStopped(db, HOST, DAY0 + 2 * DAY))).toBe("stopped");
    expect(await hostRows(store)).toMatchObject([{ unavailable_since: DAY0, drain_lane: "", drain_id: "0" }]);
  });
});

describe("attribution (C12)", () => {
  const signer = (): Promise<RequestSigner> => Promise.resolve((request) => Promise.resolve(request));
  const hanging = () => new Promise<never>(() => {});
  const resolving = (resolution: HostResolution) => () => Promise.resolve(resolution);
  const deps = (over: Partial<PostDeps> = {}): PostDeps => ({
    fetch: () => Promise.resolve(new Response(null, { status: 202 })),
    resolveHost: resolving({ kind: "public" }),
    userAgent: "kopje-test",
    timeoutMs: 50,
    now: () => Date.now(),
    ...over,
  });
  const target = (over: Partial<PostTarget> = {}): PostTarget => ({
    inbox: INBOX,
    body: "{}",
    signer,
    deadline: Date.now() + 60_000,
    ...over,
  });
  const answering = (status: number) => (() => Promise.resolve(new Response(null, { status }))) as typeof fetch;
  const CASES: [string, () => [PostDeps, PostTarget], string, boolean][] = [
    ["an empty answer", () => [deps({ resolveHost: resolving({ kind: "none" }) }), target()], "resolve", true],
    ["a private address", () => [deps({ resolveHost: resolving({ kind: "private" }) }), target()], "resolve", true],
    [
      "ENOTFOUND",
      () => [deps({ resolveHost: resolving({ kind: "error", code: "ENOTFOUND" }) }), target()],
      "resolve",
      true,
    ],
    [
      "ENODATA",
      () => [deps({ resolveHost: resolving({ kind: "error", code: "ENODATA" }) }), target()],
      "resolve",
      true,
    ],
    [
      "EAI_AGAIN",
      () => [deps({ resolveHost: resolving({ kind: "error", code: "EAI_AGAIN" }) }), target()],
      "resolve",
      false,
    ],
    [
      "ESERVFAIL",
      () => [deps({ resolveHost: resolving({ kind: "error", code: "ESERVFAIL" }) }), target()],
      "resolve",
      false,
    ],
    [
      "a lookup error without a code",
      () => [deps({ resolveHost: resolving({ kind: "error", code: null }) }), target()],
      "resolve",
      false,
    ],
    ["a lookup that outlasts the timeout", () => [deps({ resolveHost: hanging }), target()], "resolve", false],
    ["a null signer", () => [deps(), target({ signer: () => Promise.resolve(null) })], "key", false],
    ["a signer that throws", () => [deps(), target({ signer: () => Promise.reject(new Error("key")) })], "key", false],
    [
      "a signature that throws",
      () => [deps(), target({ signer: () => Promise.resolve(() => Promise.reject(new Error("sign"))) })],
      "sign",
      false,
    ],
    ["an exhausted budget", () => [deps(), target({ deadline: Date.now() - 1 })], "budget", false],
    ["a 503", () => [deps({ fetch: answering(503) }), target()], "post", true],
    ["a 401", () => [deps({ fetch: answering(401) }), target()], "post", true],
    ["a 429", () => [deps({ fetch: answering(429) }), target()], "post", true],
    [
      "a network error",
      () => [deps({ fetch: () => Promise.reject(new TypeError("network")) }), target()],
      "post",
      true,
    ],
    ["a POST that runs the whole timeout", () => [deps({ fetch: hanging }), target()], "post", true],
    ["a POST the deadline cut", () => [deps({ fetch: hanging }), target({ deadline: Date.now() + 25 })], "post", false],
    ["a 404", () => [deps({ fetch: answering(404) }), target()], "post", false],
    ["a 410", () => [deps({ fetch: answering(410) }), target()], "post", false],
    ["a 501", () => [deps({ fetch: answering(501) }), target()], "post", false],
  ];

  it.each(CASES)(
    "%s fails at its stage, counting toward the host only when the host caused it",
    async (_, make, stage, counts) => {
      const [d, t] = make();
      const outcome = await postActivity(d, t);
      expect(outcome.kind).toBe("failed");
      if (outcome.kind !== "failed") {
        return;
      }
      expect(outcome.failure?.stage).toBe(stage);
      expect(hostCaused(outcome.failure, outcome.permanent)).toBe(counts);
    },
  );

  it("a completion counts only a failure its host caused; a permanent answer neither counts nor clears", async () => {
    const { store, alice } = await sender();
    const create = await outbound(store, alice);
    const [id] = await lane(store, { activity: create, account: alice, count: 1, due: DAY0 });
    const attempt = async (d: number, outcome: DeliveryOutcome) => {
      const now = DAY0 + d * DAY;
      await claim(store, now);
      return complete(store, id!, `lease-${now}`, outcome, now);
    };
    await attempt(0, {
      kind: "failed",
      status: null,
      error: "signing key unavailable",
      permanent: false,
      failure: { stage: "key" },
    });
    await attempt(1, { kind: "failed", status: null, error: "x", permanent: false });
    expect(await hostRows(store)).toEqual([]);
    await attempt(2, FAIL);
    expect(await hostRows(store)).toMatchObject([{ failure_days: 1, last_failure_day: dayOf(DAY0) + 2 }]);
    expect(
      await attempt(3, { kind: "failed", status: 404, error: "HTTP 404", permanent: true, failure: { stage: "post" } }),
    ).toMatchObject({ status: "gave_up" });
    expect(await hostRows(store)).toMatchObject([{ failure_days: 1, last_failure_day: dayOf(DAY0) + 2 }]);
  });
});

describe("paths to a send (C13)", () => {
  it("writes targets of an unavailable host given up, a Follow pending", async () => {
    const { store, alice } = await sender();
    await markUnavailable(store, HOST, false);
    const create = await outbound(store, alice);
    const follow = await outbound(store, alice, "Follow");
    for (const [activity, inboxes] of [
      [create, ["https://h.example/users/a/inbox", "https://other.example/inbox", "https://h.example.:8443/inbox"]],
      [follow, ["https://h.example/users/b/inbox"]],
    ] as const) {
      await sql(
        store,
        "INSERT INTO outbound_targets (activity_id, targets) SELECT CAST(?1 AS INTEGER), json_group_array(json_object('inbox', value)) FROM json_each(?2)",
        activity,
        JSON.stringify(inboxes),
      );
    }
    await inDb(store, (db) => expandPending(db, NOW, 100));
    expect(
      await sql(
        store,
        "SELECT CAST(activity_id AS TEXT) AS activity, inbox_url, state, last_error, attempts FROM deliveries ORDER BY id",
      ),
    ).toEqual([
      {
        activity: create,
        inbox_url: "https://h.example/users/a/inbox",
        state: "gave_up",
        last_error: HOST_UNAVAILABLE,
        attempts: 0,
      },
      { activity: create, inbox_url: "https://other.example/inbox", state: "pending", last_error: null, attempts: 0 },
      {
        activity: create,
        inbox_url: "https://h.example.:8443/inbox",
        state: "gave_up",
        last_error: HOST_UNAVAILABLE,
        attempts: 0,
      },
      {
        activity: follow,
        inbox_url: "https://h.example/users/b/inbox",
        state: "pending",
        last_error: null,
        attempts: 0,
      },
    ]);
  });

  it("does not count the given-up targets toward the backlog", async () => {
    const { store, alice } = await sender();
    await markUnavailable(store, HOST, false);
    const filler = await outbound(store, alice);
    // MAX_BACKLOG - 1 active rows elsewhere: one more fits.
    for (let i = 0; i < 20; i++) {
      await rows(store, {
        activity: filler,
        account: alice,
        lane: `https://f${i}.example`,
        count: i === 19 ? 499 : 500,
      });
    }
    const create = await outbound(store, alice);
    await sql(
      store,
      "INSERT INTO outbound_targets (activity_id, targets) VALUES (CAST(?1 AS INTEGER), json_array(json_object('inbox', ?2), json_object('inbox', ?3)))",
      create,
      INBOX,
      "https://other.example/inbox",
    );
    await inDb(store, (db) => expandPending(db, NOW, 100));
    expect(
      await sql(
        store,
        "SELECT inbox_url, state, last_error FROM deliveries WHERE activity_id = CAST(? AS INTEGER) ORDER BY id",
        create,
      ),
    ).toEqual([
      { inbox_url: INBOX, state: "gave_up", last_error: HOST_UNAVAILABLE },
      { inbox_url: "https://other.example/inbox", state: "pending", last_error: null },
    ]);
  }, 60_000);

  it("a retried row of an unavailable host is given up at its claim; after restart it is sent", async () => {
    const { store, alice } = await sender();
    await markUnavailable(store, HOST, false);
    const create = await outbound(store, alice);
    const [id] = await lane(store, { activity: create, account: alice, count: 1 });
    await sql(store, "UPDATE deliveries SET state = 'gave_up', last_error = ?", HOST_UNAVAILABLE);
    expect(await run(store, retryDeliveries, { ids: [id!], now: NOW })).toMatchObject({ retried: 1 });
    expect((await claim(store)).deliveries).toEqual([]);
    expect(await states(store)).toEqual([{ id, state: "gave_up", last_error: HOST_UNAVAILABLE, attempts: 0 }]);
    expect(await run(store, restartDeliveryHost, { host: HOST })).toEqual({ restarted: true });
    await run(store, retryDeliveries, { ids: [id!], now: NOW });
    expect((await claim(store, NOW, "after")).deliveries.map((c) => c.id)).toEqual([id]);
  });

  it("gives up a re-claimed lease of an unavailable host", async () => {
    const { store, alice } = await sender();
    await markUnavailable(store, HOST, true);
    const create = await outbound(store, alice);
    const [id] = await rows(store, {
      activity: create,
      account: alice,
      state: "leased",
      leaseToken: "old",
      attempts: 1,
      due: NOW - 1,
    });
    expect((await claim(store)).deliveries).toEqual([]);
    expect(await states(store)).toEqual([{ id, state: "gave_up", last_error: HOST_UNAVAILABLE, attempts: 1 }]);
  });

  it("a lease in flight when the host is marked is sent once; its failure is given up", async () => {
    const { store, alice } = await sender();
    const create = await outbound(store, alice);
    const [id, next] = await lane(store, { activity: create, account: alice, count: 2 });
    expect((await claim(store, NOW, "flight")).deliveries.map((c) => c.id)).toEqual([id]);
    expect(await run(store, stopDeliveryHost, { host: HOST, now: NOW })).toEqual({
      ok: true,
      drained: 1,
      draining: false,
    });
    expect(await complete(store, id!, "flight", FAIL)).toMatchObject({ status: "gave_up" });
    expect(await states(store)).toEqual([
      { id, state: "gave_up", last_error: HOST_UNAVAILABLE, attempts: 1 },
      { id: next, state: "gave_up", last_error: HOST_UNAVAILABLE, attempts: 0 },
    ]);
    expect((await claim(store, NOW + 3_600_000)).deliveries).toEqual([]);
  });

  it("a moved row of an unavailable host is given up", async () => {
    const { store, alice } = await sender();
    const bob = await seedAccount(store, { username: "bob", domain: HOST });
    // A Flag (no to) for bob, sent to his shared inbox: a 404 there moves the row in place to his personal inbox.
    const [flag] = await sql<{ id: string }>(
      store,
      `INSERT INTO outbound_activities (account_id, body, object_uri, created_at)
			VALUES (?1, json_object('activity', json_object('type', 'Flag', 'id', 'https://kopje.test/ap/flag/1',
				'actor', 'https://kopje.test/ap/users/alice', 'object', json_array('https://h.example/users/bob')),
				'audience', json_object('followers', json('false'), 'accounts', json_array(?2))), NULL, ?3)
			RETURNING CAST(id AS TEXT) AS id`,
      alice,
      bob,
      NOW,
    );
    const [id] = await lane(store, { activity: flag!.id, account: alice, count: 1 });
    await claim(store, NOW, "shared");
    expect(
      await complete(store, id!, "shared", {
        kind: "failed",
        status: 404,
        error: "HTTP 404",
        permanent: true,
        failure: { stage: "post" },
      }),
    ).toMatchObject({ status: "retry" });
    expect(await sql(store, "SELECT inbox_url, lane, state FROM deliveries")).toEqual([
      { inbox_url: "https://h.example/users/bob/inbox", lane: LANE, state: "pending" },
    ]);
    await markUnavailable(store, HOST, false);
    expect((await claim(store, NOW + 1)).deliveries).toEqual([]);
    expect(await states(store)).toMatchObject([{ id, state: "gave_up", last_error: HOST_UNAVAILABLE }]);
  });

  it("a Follow to an unavailable host is sent; the lane's other rows are given up", async () => {
    const { store, alice } = await sender();
    const create = await outbound(store, alice);
    const follow = await outbound(store, alice, "Follow");
    const [head] = await lane(store, { activity: create, account: alice, count: 1 });
    const [f] = await rows(store, { activity: follow, account: alice });
    const [last] = await rows(store, { activity: create, account: alice });
    expect(await run(store, stopDeliveryHost, { host: HOST, now: NOW })).toEqual({
      ok: true,
      drained: 2,
      draining: false,
    });
    expect((await claim(store)).deliveries.map((c) => c.id)).toEqual([f]);
    expect(await states(store)).toEqual([
      { id: head, state: "gave_up", last_error: HOST_UNAVAILABLE, attempts: 0 },
      { id: f, state: "leased", last_error: null, attempts: 1 },
      { id: last, state: "gave_up", last_error: HOST_UNAVAILABLE, attempts: 0 },
    ]);
    // Its failure is retried, not given up.
    expect(await complete(store, f!, "lease-" + NOW, FAIL)).toMatchObject({ status: "retry" });
  });
});

describe("clears (C14)", () => {
  it("an activity the Store receives clears its sender's stored inbox host only", async () => {
    const { store } = await sender();
    const bob = await seedAccount(store, { username: "bob", domain: HOST });
    const carol = await seedAccount(store, { username: "carol", domain: "c.example" });
    // carol's inbox is on another host than her id.
    await sql(store, "UPDATE accounts SET inbox_url = 'https://d.example/inbox/carol' WHERE id = ?", carol);
    for (const host of [HOST, "c.example", "d.example", "other.example"]) {
      await markUnavailable(store, host, false);
    }
    const receive = (actorUri: string) =>
      store.receiveActivity(BUILD, {
        now: NOW,
        origin: "https://kopje.test",
        actorUri,
        actor: null,
        actorRevision: null,
        activity: { type: "Delete", id: `${actorUri}#d`, object: `${actorUri}/statuses/1` },
      });
    await receive("https://h.example/users/bob");
    expect((await hostRows(store)).map((r) => r.host)).toEqual(["c.example", "d.example", "other.example"]);
    await receive("https://c.example/users/carol");
    expect((await hostRows(store)).map((r) => r.host)).toEqual(["c.example", "other.example"]);
    // An actor the Store does not know clears nothing.
    await receive("https://other.example/users/nobody");
    expect((await hostRows(store)).map((r) => r.host)).toEqual(["c.example", "other.example"]);
    expect(bob).toBeTruthy();
    expect(events()).toEqual(["kopje.delivery.host_restored", "kopje.delivery.host_restored"]);
  });

  // Mastodon 4.7.5 does the same: its InboxesController resets the verified signer's inbox host
  // (DeliveryFailureTracker.reset!, which destroys an UnavailableDomain, an operator's stop included), and it stores an
  // actor's inbox on any host (ProcessAccountService#valid_collection_uri). The accepted gap of docs/threat-model.md
  // RES-5: a signer can clear a host it does not control, which Kopje then tries again.
  it.each(["live", "replayed"] as const)(
    "a %s signed activity of an actor whose inbox is on another host clears that host, its stop and drain included",
    async (path) => {
      const store = await migratedStore();
      await completeSetup(store);
      const alice = "100000000000000001";
      // Locked, so the Follow sends nothing back.
      await seedLocalAccount(store, "kopje.test", {
        id: alice,
        username: "alice",
        key: LEGACY_EMPTY_KEK,
        locked: true,
      });
      const victim = "victim.example";
      const create = await outbound(store, alice);
      const ids = await lane(store, {
        activity: create,
        account: alice,
        lane: `https://${victim}`,
        inbox: `https://${victim}/inbox`,
        count: 150,
      });
      expect(await run(store, stopDeliveryHost, { host: victim, now: NOW })).toEqual({
        ok: true,
        drained: 100,
        draining: true,
      });
      const web = new RemoteWeb();
      const mallory = await mastodonActor(web, "mallory", {
        origin: "https://attacker.example",
        extra: { inbox: `https://${victim}/arbitrary-inbox` },
      });
      const follow = {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: "https://attacker.example/follows/1",
        type: "Follow",
        actor: mallory.uri,
        object: "https://kopje.test/ap/users/alice",
      };
      const init = await signedInit(mallory, "/inbox", follow);
      const federation = { keygen: fixtureKeyGen, loader: web.loader };
      if (path === "live") {
        expect((await harness(store, {}, BUILD, federation).request("/inbox", init)).status).toBe(202);
      } else {
        const spool = harness(store, { MAINTENANCE: "readonly" }, BUILD, federation);
        expect((await spool.request("/inbox", init)).status).toBe(202);
        expect(await hostRows(store)).toMatchObject([{ host: victim, drain_lane: `https://${victim}` }]);
        const env = { ...spool.env, MAINTENANCE: "off" } as Env;
        await spool.queue.deliver((batch) =>
          handleQueue(
            batch,
            env,
            inboxDeps(() => store, web.loader),
          ),
        );
      }
      expect(await sql(store, "SELECT inbox_url FROM accounts WHERE uri = ?", mallory.uri)).toEqual([
        { inbox_url: `https://${victim}/arbitrary-inbox` },
      ]);
      expect(await hostRows(store)).toEqual([]);
      expect(warn.mock.calls.map((call): unknown => call[0])).toContainEqual({
        event: "kopje.delivery.host_restored",
        cause: "received",
      });
      // Nothing reached the victim; the rows the stop gave up stay so, and the rest are sent again.
      expect(web.fetched.filter((url) => new URL(url).hostname === victim)).toEqual([]);
      expect(await tally(store, ids)).toEqual({ "gave_up: host unavailable": 100, pending: 1, queued: 49 });
      expect((await claim(store, NOW + 1)).deliveries.map((c) => c.id)).toEqual([ids[100]]);
    },
    60_000,
  );
});

describe("cap and sweep (C15)", () => {
  async function fill(store: StoreStub, count: number, row: (i: string) => string) {
    await sql(
      store,
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
			INSERT INTO delivery_hosts (host, failure_days, last_failure_day, unavailable_since)
			SELECT 'h' || i || '.example', ${row("i")} FROM n`,
      count,
    );
  }

  it("records no new host past MAX_DELIVERY_HOSTS, still counts an existing one, and aborts a 10,001st import", async () => {
    const { store } = await sender();
    await fill(store, MAX_DELIVERY_HOSTS, () => `1, ${dayOf(DAY0)}, NULL`);
    await failAt(store, "new.example", DAY0 + DAY);
    await failAt(store, "h1.example", DAY0 + DAY);
    expect(await sql(store, "SELECT count(*) AS n FROM delivery_hosts")).toEqual([{ n: MAX_DELIVERY_HOSTS }]);
    expect(await sql(store, "SELECT failure_days FROM delivery_hosts WHERE host = 'h1.example'")).toEqual([
      { failure_days: 2 },
    ]);
    expect(warn.mock.calls.map((call): unknown => call[0])).toContainEqual({ event: "kopje.delivery.hosts_full" });
    await expect(
      sql(store, "INSERT INTO delivery_hosts (host, failure_days, last_failure_day) VALUES ('new.example', 1, 0)"),
    ).rejects.toThrow(/delivery_hosts: more than 10000/);
  }, 60_000);

  it("forgets idle failing hosts SWEEP_BATCH a sweep, keeping a younger one and an unavailable one", async () => {
    const { store } = await sender();
    const today = dayOf(DAY0);
    await fill(store, SWEEP_BATCH + 1, () => `1, ${today - 30}, NULL`);
    await sql(
      store,
      `INSERT INTO delivery_hosts (host, failure_days, last_failure_day, unavailable_since)
			VALUES ('young.example', 3, ?1, NULL), ('down.example', 7, ?2, ?3)`,
      today - 29,
      today - 40,
      DAY0 - 40 * DAY,
    );
    const sweep = () => run(store, sweepDeliveries, { now: DAY0, storeNow: DAY0 });
    expect(await sweep()).toEqual({ swept: SWEEP_BATCH });
    expect(await sweep()).toEqual({ swept: 1 });
    expect(await sweep()).toEqual({ swept: 0 });
    expect((await hostRows(store)).map((r) => r.host)).toEqual(["down.example", "young.example"]);
  });
});

describe("the operator's routes", () => {
  let team: AccessTeam;

  beforeEach(async () => {
    team = await adminTeam();
  });

  async function admin(store?: StoreStub) {
    const s = store ?? (await sender()).store;
    await setTeamAccess(s, team);
    return { store: s, ...adminHarness(s, team, { IMPORT_TOKEN: "import-token-0123456789abcdef0123456789" }) };
  }

  it("pages the hosts by their stored spelling, a 64-byte label and an IP address too, and restarts one", async () => {
    const { store, as, post } = await admin();
    const label = `${"a".repeat(64)}.example`;
    await sql(
      store,
      `INSERT INTO delivery_hosts (host, failure_days, last_failure_day, unavailable_since, drain_lane, drain_id)
			VALUES ('a.example', 2, ?1, NULL, NULL, NULL), (?2, 7, ?1, ?3, '', 0), ('127.0.0.1', 1, ?1, NULL, NULL, NULL),
				('b.example', 0, NULL, ?3, NULL, NULL)`,
      dayOf(DAY0),
      label,
      DAY0,
    );
    const pages: unknown[] = [];
    let after: string | null = null;
    for (let call = 0; call < 6; call++) {
      const response = await as(
        adminClaims(),
        `/admin/hosts?limit=1${after === null ? "" : `&after=${encodeURIComponent(after)}`}`,
      );
      expect(response.status).toBe(200);
      const page = await response.json<{ hosts: unknown[]; next: string | null }>();
      pages.push(...page.hosts);
      after = page.next;
      if (after === null) {
        break;
      }
    }
    expect(pages).toEqual([
      { host: "127.0.0.1", failureDays: 1, lastFailureDay: "2026-10-01", unavailableSince: null, draining: false },
      { host: "a.example", failureDays: 2, lastFailureDay: "2026-10-01", unavailableSince: null, draining: false },
      {
        host: label,
        failureDays: 7,
        lastFailureDay: "2026-10-01",
        unavailableSince: "2026-10-01T00:00:00.000Z",
        draining: true,
      },
      {
        host: "b.example",
        failureDays: 0,
        lastFailureDay: null,
        unavailableSince: "2026-10-01T00:00:00.000Z",
        draining: false,
      },
    ]);
    const restart = (host: unknown) => post(adminClaims(), "/admin/hosts/restart", { host });
    expect(await (await restart("127.0.0.1")).json()).toEqual({ host: "127.0.0.1", restarted: true });
    expect(await (await restart("127.0.0.1")).json()).toEqual({ host: "127.0.0.1", restarted: false });
    expect(await (await restart(label)).json()).toEqual({ host: label, restarted: true });
    expect((await hostRows(store)).map((r) => r.host)).toEqual(["a.example", "b.example"]);
  });

  it("stops a host, its drain's first step run, and rings the doorbell while it goes on", async () => {
    const { store, alice } = await sender();
    const create = await outbound(store, alice);
    await lane(store, { activity: create, account: alice, count: 150 });
    const { post, doorbell } = await admin(store);
    const response = await post(adminClaims(), "/admin/hosts/stop", { host: "H.Example" });
    expect(await response.json()).toEqual({ host: HOST, drained: 100, draining: true });
    expect(doorbell).toHaveBeenCalledTimes(1);
    expect(await hostRows(store)).toMatchObject([{ host: HOST, failure_days: 0, drain_lane: LANE }]);
    const other = await post(adminClaims(), "/admin/hosts/stop", { host: "quiet.example" });
    expect(await other.json()).toEqual({ host: "quiet.example", drained: 0, draining: false });
    expect(doorbell).toHaveBeenCalledTimes(1);
  });

  it("refuses a malformed host or limit 400 and anyone but the admin 403", async () => {
    const { as, post, request } = await admin();
    for (const path of [
      "/admin/hosts?after=A.example",
      "/admin/hosts?after=a.example.",
      "/admin/hosts?limit=0",
      "/admin/hosts?limit=101",
      "/admin/hosts?limit=x",
    ]) {
      expect((await as(adminClaims(), path)).status, path).toBe(400);
    }
    for (const host of ["not a host", "a..b", 42, null]) {
      expect((await post(adminClaims(), "/admin/hosts/stop", { host })).status, String(host)).toBe(400);
    }
    for (const host of ["A.example", "a.example.", 42, null]) {
      expect((await post(adminClaims(), "/admin/hosts/restart", { host })).status, String(host)).toBe(400);
    }
    const outsider = { email: "someone@kopje.test", sub: "user-2" };
    expect((await as(outsider, "/admin/hosts")).status).toBe(403);
    expect((await post(outsider, "/admin/hosts/stop", { host: HOST })).status).toBe(403);
    expect((await post(outsider, "/admin/hosts/restart", { host: HOST })).status).toBe(403);
    const token = { headers: { "Kopje-Import-Token": "import-token-0123456789abcdef0123456789" } };
    expect((await request("/admin/hosts", token)).status).toBe(403);
  });

  it("evicts the available host of the oldest day for a stop of a new host; with none, answers 409 and writes nothing", async () => {
    const { store } = await sender();
    await sql(
      store,
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
			INSERT INTO delivery_hosts (host, failure_days, last_failure_day, unavailable_since)
			SELECT 'h' || i || '.example', CASE WHEN i IN (5, 7) THEN 1 ELSE 0 END,
				CASE i WHEN 5 THEN 50 WHEN 7 THEN 40 END, CASE WHEN i NOT IN (5, 7) THEN ?2 END FROM n`,
      MAX_DELIVERY_HOSTS,
      DAY0,
    );
    const { post } = await admin(store);
    const stop = async (host: string) => {
      const response = await post(adminClaims(), "/admin/hosts/stop", { host });
      return { status: response.status, body: await response.json() };
    };
    const present = async (host: string) =>
      (await sql(store, "SELECT 1 AS yes FROM delivery_hosts WHERE host = ?", host)).length === 1;
    expect(await stop("new.example")).toMatchObject({ status: 200 });
    expect([await present("h7.example"), await present("h5.example"), await present("new.example")]).toEqual([
      false,
      true,
      true,
    ]);
    expect(await stop("newer.example")).toMatchObject({ status: 200 });
    expect(await present("h5.example")).toBe(false);
    expect(await stop("newest.example")).toEqual({
      status: 409,
      body: { error: expect.any(String), code: "hosts-full" },
    });
    expect(await present("newest.example")).toBe(false);
    // A stored host is stopped again in place.
    expect(await stop("h1.example")).toMatchObject({ status: 200 });
    expect(await sql(store, "SELECT count(*) AS n FROM delivery_hosts")).toEqual([{ n: MAX_DELIVERY_HOSTS }]);
    expect(warn.mock.calls.map((call): unknown => call[0])).toContainEqual({ event: "kopje.delivery.host_evicted" });
  }, 60_000);
});

describe("dumps and maintenance", () => {
  it("round-trips the hosts through a dump, a stopped host's drain resuming after its cursor", async () => {
    const { store, alice } = await sender();
    await setAccess(store);
    await completeSetup(store);
    const create = await outbound(store, alice);
    const ids = await lane(store, {
      activity: create,
      account: alice,
      lane: "https://h.example:8443",
      count: 80,
      due: NOW + DAY,
    });
    const cursor = ids[56]!;
    await sql(
      store,
      `INSERT INTO delivery_hosts (host, failure_days, last_failure_day, unavailable_since, drain_lane, drain_id)
			VALUES (?1, 0, NULL, ?2, 'https://h.example:8443', CAST(?3 AS INTEGER)), ('f.example', 3, ?4, NULL, NULL, NULL)`,
      HOST,
      NOW,
      cursor,
      dayOf(DAY0),
    );
    const { text } = await dumpViaRpc(store);
    const target = await migratedStore();
    await copyConfig(store, target);
    expect((await importViaRpc(target, text)).report).toMatchObject({ ok: true, problems: [] });
    expect(await hostRows(target)).toEqual(await hostRows(store));
    await claim(target, NOW + 1);
    // The rows up to the cursor were read before the dump; the step gives up the 23 after it.
    expect((await states(target, ids.slice(0, 57))).every((r) => r.state !== "gave_up")).toBe(true);
    expect((await states(target, ids.slice(57))).map((r) => r.last_error)).toEqual(Array(23).fill(HOST_UNAVAILABLE));
    expect(await hostRows(target)).toMatchObject([{ host: "f.example" }, { host: HOST, drain_lane: null }]);
  }, 60_000);

  it("claims, drains, marks and stops nothing in maintenance", async () => {
    const { store, alice } = await sender();
    const create = await outbound(store, alice);
    await lane(store, { activity: create, account: alice, count: 3 });
    await markUnavailable(store, "down.example", true);
    const before = [await hostRows(store), await states(store)];
    expect(await store.setMaintenance(BUILD, true)).toMatchObject({ maintenance: true });
    await runInDurableObject(store, async (_instance, state) => {
      const kernel = testKernel(state);
      await expect(kernel.execute(BUILD, claimDeliveries, { now: NOW, leaseToken: "m" })).rejects.toThrow(
        "kopje-maintenance: maintenance",
      );
      await expect(kernel.execute(BUILD, stopDeliveryHost, { host: HOST, now: NOW })).rejects.toThrow(
        "kopje-maintenance: maintenance",
      );
      await expect(kernel.execute(BUILD, restartDeliveryHost, { host: "down.example" })).rejects.toThrow(
        "kopje-maintenance: maintenance",
      );
    });
    expect([await hostRows(store), await states(store)]).toEqual(before);
  });
});

describe("concurrency", () => {
  it("a completion marks the host while a claim waits at its Store call; the claim gives that row up, the drain the rest", async () => {
    const { store, alice } = await sender();
    const today = dayOf(Date.now());
    await sql(
      store,
      "INSERT INTO delivery_hosts (host, failure_days, last_failure_day) VALUES (?, 6, ?)",
      HOST,
      today - 1,
    );
    const create = await outbound(store, alice);
    const [a] = await lane(store, { activity: create, account: alice, count: 1 });
    // Another lane to the host: its head's lease has run out, with queued rows behind it.
    const [b] = await rows(store, {
      activity: create,
      account: alice,
      lane: "https://h.example:8443",
      inbox: "https://h.example:8443/inbox",
      state: "leased",
      leaseToken: "gone",
      attempts: 1,
      due: NOW + 500,
    });
    const behind = await rows(store, {
      activity: create,
      account: alice,
      lane: "https://h.example:8443",
      inbox: "https://h.example:8443/inbox",
      count: 3,
    });
    expect((await store.claimDeliveries(BUILD, { now: NOW, leaseToken: "first" })).deliveries.map((c) => c.id)).toEqual(
      [a],
    );
    const gate = deferred();
    const waiting = (async () => {
      await gate.promise;
      return store.claimDeliveries(BUILD, { now: NOW + 1000, leaseToken: "second" });
    })();
    expect(await store.completeDelivery(BUILD, { id: a!, leaseToken: "first", now: NOW, outcome: FAIL })).toMatchObject(
      {
        status: "gave_up",
      },
    );
    gate.resolve();
    expect((await waiting).deliveries).toEqual([]);
    expect(await states(store)).toEqual([
      { id: a, state: "gave_up", last_error: HOST_UNAVAILABLE, attempts: 1 },
      { id: b, state: "gave_up", last_error: HOST_UNAVAILABLE, attempts: 1 },
      ...behind.map((id) => ({ id, state: "gave_up", last_error: HOST_UNAVAILABLE, attempts: 0 })),
    ]);
    expect(await hostRows(store)).toMatchObject([{ host: HOST, failure_days: 7, drain_lane: null }]);
  });
});
