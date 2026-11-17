import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import { sweepDeliveries } from "../src/domain/deliveries";
import { dayOf, deliveryHost, FAILURE_DAYS, markStopped, recordHostFailure } from "../src/domain/delivery-hosts";
import type { StoreStub } from "../src/platform/store-client";
import {
  deliveryHostSql,
  laneHostOf,
  laneHostSql,
  MAX_DELIVERY_HOSTS,
  withinDeliveryHostBound,
} from "../src/platform/stored-bounds";
import { sql } from "./api-helpers";
import { DAY, HOST, hostRows, INBOX, inDb, LANE, outbound, rows, run, sender } from "./delivery-host-helpers";

// Hosts that keep failing deliveries become unavailable (domain/delivery-hosts.ts; docs/mastodon-deviations.md,
// "Unavailable delivery hosts"; RES-4, RES-5): the stored host set, the marks, the cap and the sweep.

const DAY0 = Date.UTC(2026, 9, 1);
// deliveries.ts SWEEP_BATCH: the rows a sweep deletes at most.
const SWEEP_BATCH = 500;

function failAt(store: StoreStub, host: string, now: number): Promise<void> {
  return inDb(store, (db) => recordHostFailure(db, host, now));
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
