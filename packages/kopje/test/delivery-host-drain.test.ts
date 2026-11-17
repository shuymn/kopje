import { describe, expect, it } from "vitest";

import { claimDeliveries, completeDelivery, stopDeliveryHost } from "../src/domain/deliveries";
import { EXPANSION_STEP } from "../src/domain/delivery-bounds";
import { HOST_UNAVAILABLE, restartDeliveryHost } from "../src/domain/delivery-hosts";
import type { StoreStub } from "../src/platform/store-client";
import { sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import {
  DAY,
  HOST,
  hostRows,
  lane,
  LANE,
  markUnavailable,
  outbound,
  rows,
  run,
  sender,
  states,
  tally,
} from "./delivery-host-helpers";
import { measuredStatements, plannedRun, scansOf, staleStatistics } from "./read-helpers";

// The drain of an unavailable host (domain/deliveries.ts drainStep; RES-5, RES-6; C16 and G5): each step gives up up to
// EXPANSION_STEP of the host's queued and pending rows but Follows, through deliveries_host_drain, sharing the claim's
// budget with expansion; it reads only rows of the host's own lanes, visits no entry it does not count, and reads each
// row's activity once by its rowid.

const DRAIN = /deliveries_host_drain/;

type Step = { read: number; returned: number };

// One claim at `now`: what it leased, and its drain's reads (rows read and returned by the statements that walk
// deliveries_host_drain, the activity's lookup included).
async function step(store: StoreStub, now = NOW, leaseToken = `step-${now}`) {
  const { output, statements } = await measuredStatements({ store }, claimDeliveries, { now, leaseToken }, true);
  const drain = statements.filter((s) => DRAIN.test(s.query));
  return {
    claimed: output.deliveries.map((c) => c.id),
    drain: {
      read: drain.reduce((sum, s) => sum + s.rows, 0),
      returned: drain.reduce((sum, s) => sum + s.returned, 0),
    } satisfies Step,
  };
}

async function draining(store: StoreStub): Promise<boolean> {
  return (await sql(store, "SELECT 1 AS yes FROM delivery_hosts WHERE drain_lane IS NOT NULL")).length > 0;
}

// Each step reads at most the budget's index entries, each with one read of its activity (and the cursor's reads).
function withinBudget({ read, returned }: Step): boolean {
  return returned <= EXPANSION_STEP && read <= 2 * returned + 8;
}

describe("the drain (C16, G5)", () => {
  it("drains a lane of 500 to a stopped host within ⌈500 / EXPANSION_STEP⌉ steps, its head due 12 hours ahead", async () => {
    const { store, alice } = await sender();
    const create = await outbound(store, alice);
    const head = await rows(store, {
      activity: create,
      account: alice,
      state: "pending",
      attempts: 1,
      due: NOW + 12 * 60 * 60 * 1000,
    });
    const rest = await rows(store, { activity: create, account: alice, count: 499 });
    const ids = [...head, ...rest];
    expect(await run(store, stopDeliveryHost, { host: HOST, now: NOW })).toEqual({
      ok: true,
      drained: EXPANSION_STEP,
      draining: true,
    });
    // The stop ran the first step; each claim runs one more (its check also gives up the head each step promotes).
    const steps: Step[] = [];
    while ((await tally(store, ids))[`gave_up: ${HOST_UNAVAILABLE}`] !== 500) {
      expect(steps.length + 1, "steps").toBeLessThan(Math.ceil(500 / EXPANSION_STEP));
      const s = await step(store);
      expect(s.claimed).toEqual([]);
      steps.push(s.drain);
    }
    expect(steps.every(withinBudget)).toBe(true);
    // A drain whose last step read a whole budget ends at the next, which reads nothing.
    if (await draining(store)) {
      expect((await step(store)).drain).toMatchObject({ returned: 0 });
    }
    expect(await draining(store)).toBe(false);
    expect(await tally(store, ids)).toEqual({ [`gave_up: ${HOST_UNAVAILABLE}`]: 500 });
  });

  it("drains MAX_BACKLOG rows in 20 lanes within 100 steps", async () => {
    const { store, alice } = await sender();
    const create = await outbound(store, alice);
    for (let port = 8001; port <= 8020; port++) {
      await lane(store, { activity: create, account: alice, lane: `https://h.example:${port}`, count: 500 });
    }
    await markUnavailable(store, HOST, true);
    let n = 0;
    while ((await tally(store))[`gave_up: ${HOST_UNAVAILABLE}`] !== 10_000) {
      expect(++n, "steps").toBeLessThanOrEqual(10_000 / EXPANSION_STEP);
      await run(store, claimDeliveries, { now: NOW + DAY, leaseToken: `t${n}` });
    }
    expect(n).toBeLessThanOrEqual(10_000 / EXPANSION_STEP);
  }, 120_000);

  it("keeps a Follow in the middle of a lane and sends it once the rows before it are given up", async () => {
    const { store, alice } = await sender();
    const create = await outbound(store, alice);
    const follow = await outbound(store, alice, "Follow");
    const before = await lane(store, { activity: create, account: alice, count: 50 });
    const [f] = await rows(store, { activity: follow, account: alice });
    const after = await rows(store, { activity: create, account: alice, count: 50 });
    expect(await run(store, stopDeliveryHost, { host: HOST, now: NOW })).toEqual({
      ok: true,
      drained: 99,
      draining: true,
    });
    expect((await step(store)).claimed).toEqual([f]);
    expect(await tally(store, [...before, ...after])).toEqual({ [`gave_up: ${HOST_UNAVAILABLE}`]: 100 });
    expect(await draining(store)).toBe(false);
  });

  it("leaves a leased head to its completion, which is given up", async () => {
    const { store, alice } = await sender();
    const create = await outbound(store, alice);
    const [leased] = await rows(store, {
      activity: create,
      account: alice,
      state: "leased",
      leaseToken: "flight",
      attempts: 1,
      due: NOW + 60_000,
    });
    const queued = await rows(store, { activity: create, account: alice, count: 10 });
    expect(await run(store, stopDeliveryHost, { host: HOST, now: NOW })).toEqual({
      ok: true,
      drained: 10,
      draining: false,
    });
    expect(await states(store, [leased!])).toMatchObject([{ state: "leased" }]);
    expect(
      await run(store, completeDelivery, {
        id: leased!,
        leaseToken: "flight",
        now: NOW,
        storeNow: NOW,
        outcome: { kind: "failed", status: 503, error: "HTTP 503", permanent: false, failure: { stage: "post" } },
      }),
    ).toMatchObject({ status: "gave_up" });
    expect(await tally(store, [leased!, ...queued])).toEqual({ [`gave_up: ${HOST_UNAVAILABLE}`]: 11 });
  });

  it("ends at a restart mid-drain, and the rest are sent", async () => {
    const { store, alice } = await sender();
    const create = await outbound(store, alice);
    const ids = await lane(store, { activity: create, account: alice, count: 250 });
    await run(store, stopDeliveryHost, { host: HOST, now: NOW });
    expect(await run(store, restartDeliveryHost, { host: HOST })).toEqual({ restarted: true });
    expect((await step(store)).claimed).toEqual([ids[100]]);
    expect(await tally(store, ids)).toEqual({ [`gave_up: ${HOST_UNAVAILABLE}`]: 100, leased: 1, queued: 149 });
  });

  it("shares EXPANSION_STEP with expansion: 100 Follows and one row take 2 steps, expansion writing what they leave", async () => {
    const { store, alice } = await sender();
    const follow = await outbound(store, alice, "Follow");
    const create = await outbound(store, alice);
    await rows(store, { activity: follow, account: alice, count: 100, due: NOW + DAY });
    const [last] = await rows(store, { activity: create, account: alice });
    const content = await outbound(store, alice);
    await sql(
      store,
      `INSERT INTO outbound_targets (activity_id, targets) SELECT CAST(?1 AS INTEGER),
				json_group_array(json_object('inbox', 'https://t' || value || '.example/inbox')) FROM json_each(?2)`,
      content,
      JSON.stringify(Array.from({ length: 150 }, (_, i) => i)),
    );
    await markUnavailable(store, HOST, true);
    const written = async () =>
      (await sql(store, "SELECT count(*) AS n FROM deliveries WHERE activity_id = CAST(? AS INTEGER)", content))[0]!.n;
    const first = await step(store);
    expect(first.drain.returned).toBe(EXPANSION_STEP);
    expect(await written()).toBe(0);
    const second = await step(store);
    expect(second.drain.returned).toBe(1);
    expect(await states(store, [last!])).toMatchObject([{ state: "gave_up", last_error: HOST_UNAVAILABLE }]);
    expect(await written()).toBe(EXPANSION_STEP - 1);
    expect(await draining(store)).toBe(false);
    await step(store);
    expect(await written()).toBe(150);
  });
});

describe("what a step reads (C16)", () => {
  it("reads only the host's own lanes, each step's reads flat as other hosts' rows grow", async () => {
    const measure = async (others: number) => {
      const { store, alice } = await sender();
      const create = await outbound(store, alice);
      const own: string[] = [];
      for (const l of [LANE, "https://h.example...", "https://h.example.:8443"]) {
        own.push(...(await lane(store, { activity: create, account: alice, lane: l, count: 20 })));
      }
      const neighbours: string[] = [];
      for (const l of [
        "https://xh.example",
        "https://h.example.evil.test",
        "https://g.example",
        "https://i.example:1",
      ]) {
        neighbours.push(
          ...(await lane(store, { activity: create, account: alice, lane: l, count: others, due: NOW + DAY })),
        );
      }
      await markUnavailable(store, HOST, true);
      const s = await step(store);
      return { store, own, neighbours, s };
    };
    const few = await measure(5);
    const many = await measure(400);
    for (const { store, own, neighbours, s } of [few, many]) {
      expect(await tally(store, own)).toEqual({ [`gave_up: ${HOST_UNAVAILABLE}`]: 60 });
      expect(Object.keys(await tally(store, neighbours)).toSorted()).toEqual(["pending", "queued"]);
      expect(withinBudget(s.drain)).toBe(true);
    }
    expect(many.s.drain).toEqual(few.s.drain);
  });

  it("visits none of 500 Follows kept behind its cursor", async () => {
    const { store, alice } = await sender();
    const follow = await outbound(store, alice, "Follow");
    const create = await outbound(store, alice);
    await rows(store, { activity: follow, account: alice, count: 500, due: NOW + DAY });
    const later = await rows(store, { activity: create, account: alice, lane: "https://h.example:8443", count: 50 });
    await markUnavailable(store, HOST, true);
    for (let n = 0; n < 500 / EXPANSION_STEP; n++) {
      expect((await step(store)).drain.returned).toBe(EXPANSION_STEP);
    }
    // The cursor is past the Follows: the next step reads the later lane only.
    const s = await step(store);
    expect(s.drain.returned).toBe(50);
    expect(withinBudget(s.drain)).toBe(true);
    expect(await tally(store, later)).toEqual({ [`gave_up: ${HOST_UNAVAILABLE}`]: 50 });
    expect(await draining(store)).toBe(false);
  });

  it("reads each drained row's activity once by its rowid, under statistics older than the Store's growth", async () => {
    const { store, alice } = await sender();
    const create = await outbound(store, alice);
    const follow = await outbound(store, alice, "Follow");
    await rows(store, { activity: create, account: alice, count: 30, due: NOW + DAY });
    await rows(store, { activity: follow, account: alice, count: 30, due: NOW + DAY });
    const capture = async () => {
      await sql(store, "DELETE FROM delivery_hosts");
      await markUnavailable(store, HOST, true);
      await sql(
        store,
        "UPDATE deliveries SET state = 'queued', last_error = NULL, lease_token = NULL WHERE lane = ?",
        LANE,
      );
      return plannedRun({ store }, DRAIN, claimDeliveries, { now: NOW, leaseToken: "plan" }, true);
    };
    const { before, after } = await staleStatistics(
      { store },
      {
        capture,
        grow: async () => {
          await sql(
            store,
            `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000)
						INSERT INTO outbound_activities (account_id, body, object_uri, created_at)
						SELECT ?1, json_object('activity', json_object('type', 'Create')), 'https://kopje.test/ap/o/g' || i, ?2 FROM n`,
            alice,
            NOW,
          );
        },
      },
    );
    for (const [phase, run] of Object.entries({ before, after })) {
      expect(run.plans.length, phase).toBeGreaterThan(0);
      for (const { plan } of run.plans) {
        expect(scansOf(plan, ["d", "o", "deliveries", "outbound_activities"]), phase).toEqual([]);
        expect(
          plan.some((detail) => detail.startsWith("SEARCH d USING INDEX deliveries_host_drain (<expr>=? AND lane")),
          phase,
        ).toBe(true);
        expect(
          plan.some((detail) => detail.startsWith("SEARCH o USING INTEGER PRIMARY KEY (rowid=?)")),
          phase,
        ).toBe(true);
        expect(
          plan.some((detail) => /TEMP B-TREE/.test(detail)),
          phase,
        ).toBe(false);
      }
      expect(
        run.plans.reduce((sum, p) => sum + p.rows, 0),
        phase,
      ).toBeLessThanOrEqual(2 * 60 + 8);
    }
    expect(after.plans.map((p) => p.rows)).toEqual(before.plans.map((p) => p.rows));
  });
});

describe("cursors a dump may bring (C16)", () => {
  it("refuses a cursor on another host's lane and keeps one on the host's own", async () => {
    const { store } = await sender();
    const insert = (lane: string, id: number) =>
      sql(
        store,
        `INSERT INTO delivery_hosts (host, failure_days, last_failure_day, unavailable_since, drain_lane, drain_id)
				VALUES (?1, 0, NULL, ?2, ?3, ?4)`,
        HOST,
        NOW,
        lane,
        id,
      );
    for (const victim of [
      "https://victim.example",
      "https://h.example.victim.example",
      "http://h.example",
      "https://H.example",
    ]) {
      await expect(insert(victim, 0), victim).rejects.toThrow(/CHECK constraint failed: delivery_hosts_drain_cursor/);
    }
    await insert("https://h.example...:8443", 57);
    expect(await hostRows(store)).toMatchObject([{ drain_lane: "https://h.example...:8443", drain_id: "57" }]);
  });

  it("with the CHECK dropped, a cursor on another host restarts the drain on the host's own lanes", async () => {
    const { store, alice } = await sender();
    const create = await outbound(store, alice);
    const own = await lane(store, { activity: create, account: alice, count: 20 });
    const victim = await lane(store, {
      activity: create,
      account: alice,
      lane: "https://victim.example",
      inbox: "https://victim.example/inbox",
      count: 20,
    });
    // The table as 0112 makes it, without delivery_hosts_drain_cursor.
    await sql(
      store,
      `DROP TABLE delivery_hosts;
			CREATE TABLE delivery_hosts (host TEXT NOT NULL PRIMARY KEY, failure_days INTEGER NOT NULL,
				last_failure_day INTEGER, unavailable_since INTEGER, drain_lane TEXT, drain_id INTEGER) WITHOUT ROWID;
			CREATE INDEX delivery_hosts_idle ON delivery_hosts (last_failure_day) WHERE unavailable_since IS NULL;
			CREATE INDEX delivery_hosts_draining ON delivery_hosts (host) WHERE drain_lane IS NOT NULL;`,
    );
    await sql(
      store,
      `INSERT INTO delivery_hosts (host, failure_days, unavailable_since, drain_lane, drain_id)
			VALUES (?1, 0, ?2, 'https://victim.example', 0)`,
      HOST,
      NOW,
    );
    await step(store, NOW + DAY);
    expect(await tally(store, own)).toEqual({ [`gave_up: ${HOST_UNAVAILABLE}`]: 20 });
    expect(await tally(store, victim)).toEqual({ leased: 1, queued: 19 });
    expect(await draining(store)).toBe(false);
  });
});

describe("lanes outside the index (C16)", () => {
  it("leaves them to the claim's check, which gives up each head when due", async () => {
    const { store, alice } = await sender();
    const create = await outbound(store, alice);
    const blob = new TextEncoder().encode(LANE).buffer as ArrayBuffer;
    const outside: string[] = [];
    for (const l of [blob, "https://H.example", "https://h.example:08", `${LANE}${".".repeat(260)}`, `${LANE}\u0000`]) {
      outside.push(
        ...(await rows(store, { activity: create, account: alice, lane: l, state: "pending", due: NOW + DAY })),
      );
    }
    expect(await run(store, stopDeliveryHost, { host: HOST, now: NOW })).toEqual({
      ok: true,
      drained: 0,
      draining: false,
    });
    expect(await tally(store, outside)).toEqual({ pending: 5 });
    expect((await step(store, NOW + DAY)).claimed).toEqual([]);
    expect(await tally(store, outside)).toEqual({ [`gave_up: ${HOST_UNAVAILABLE}`]: 5 });
  });
});
