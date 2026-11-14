import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { annualReportState, generateAnnualReport, markAnnualReportRead } from "../src/domain/annual-reports";
import { instanceUsage } from "../src/domain/instance";
import { idIn, insertPost } from "./annual-report-fixtures";
import { type ApiHarness, apiHarness, bearer, seedAccount, setSetting, sql } from "./api-helpers";
import { BUILD } from "./helpers";
import { scopedToken } from "./read-helpers";

// The annual report campaign through the RPC path: requests through the Worker to the Store, with the Store's
// clock (Date in the Durable Object, which the kernel reads at each call: test/store-clock.test.ts) set apart from the
// Worker's (the harness's `now`, which the credential and the input's `now` carry). The campaign is judged, and its
// times stamped, by the Store's clock only; judging it by the Worker's fails every case below.

const at = (iso: string) => Date.parse(iso);

afterEach(() => {
  vi.useRealTimers();
});

// The harness, then the two clocks: the Store's faked from here on, the Worker's as given.
async function clocks(store: string, worker: string): Promise<ApiHarness> {
  const h = await apiHarness();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at(store));
  h.now.mockReturnValue(at(worker));
  return h;
}

// alice with a read and write token, and a public post with a hashtag in 2026 (eligible in its campaign); then the
// clocks as clocks() sets them.
async function owner(store: string, worker: string) {
  const h = await apiHarness();
  const alice = await seedAccount(h.store, { username: "alice", email: "alice@example.com" });
  const token = await scopedToken(h, "read write");
  await runInDurableObject(h.store, (_instance, state) => {
    insertPost(state.storage.sql, { id: idIn(2026, 1), account: alice, tags: ["cats"] });
  });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at(store));
  h.now.mockReturnValue(at(worker));
  const call = async (method: string, path: string) => {
    const response = await h.request(path, bearer(token, { method }));
    return [response.status, await response.json()] as const;
  };
  return { h, alice, call };
}

const reports = (h: ApiHarness) => sql(h.store, "SELECT year, viewed_at, created_at FROM annual_reports");

async function wrapstodon(h: ApiHarness): Promise<unknown> {
  const response = await h.request("/api/v2/instance");
  expect(response.status).toBe(200);
  return (await response.json<{ wrapstodon: unknown }>()).wrapstodon;
}

describe("the campaign of /api/v2/instance, by the Store's clock", () => {
  it.each([
    ["2026-12-31T23:59:59.999Z", "2027-01-01T00:00:01.000Z", 2026],
    ["2026-12-10T00:00:00.000Z", "2026-12-09T23:59:59.999Z", 2026],
    ["2027-01-01T00:00:00.000Z", "2026-12-31T23:59:59.999Z", null],
    ["2027-01-02T12:00:00.000Z", "2026-12-31T23:59:59.999Z", null],
  ])("the Store at %s, the Worker at %s: %s", async (store, worker, year) => {
    const h = await clocks(store, worker);
    expect(await wrapstodon(h)).toBe(year);
  });

  it("is null with the switch off, and on again once the row is removed", async () => {
    const h = await clocks("2026-12-20T00:00:00.000Z", "2026-11-01T00:00:00.000Z");
    await setSetting(h.store, "wrapstodon", "false");
    expect(await wrapstodon(h)).toBeNull();
    await setSetting(h.store, "wrapstodon", "true");
    expect(await wrapstodon(h)).toBe(2026);
    await sql(h.store, "DELETE FROM instance_settings WHERE name = 'wrapstodon'");
    expect(await wrapstodon(h)).toBe(2026);
  });

  it("is declared on the Store's clock, which replaces a storeNow the caller sends", async () => {
    expect(instanceUsage.clock).toBe("storeNow");
    const h = await clocks("2026-12-20T00:00:00.000Z", "2026-11-01T00:00:00.000Z");
    const input = { now: at("2026-11-01T00:00:00.000Z"), present: { origin: "https://kopje.test" } };
    // An RPC caller is not held to the type: it may send the field anyway.
    const sent = { ...input, storeNow: at("2026-11-01T00:00:00.000Z") } as typeof input;
    expect(await h.store.instanceUsage(BUILD, sent)).toMatchObject({ wrapstodon: 2026 });
  });
});

describe("state, generate and read, by the Store's clock", () => {
  it.each([
    ["2026-12-31T23:59:59.999Z", "2027-01-01T00:00:01.000Z"],
    ["2026-12-10T00:00:00.000Z", "2026-12-09T23:59:59.999Z"],
  ])("the Store at %s, in the campaign, the Worker at %s outside it: eligible, then made", async (store, worker) => {
    const { h, call } = await owner(store, worker);
    expect(await call("GET", "/api/v1/annual_reports/2026/state")).toEqual([200, { state: "eligible" }]);
    expect(await call("POST", "/api/v1/annual_reports/2026/generate")).toEqual([200, {}]);
    expect(await reports(h)).toEqual([{ year: 2026, viewed_at: null, created_at: store }]);
    expect(await call("GET", "/api/v1/annual_reports/2026/state")).toEqual([200, { state: "available" }]);
    vi.setSystemTime(at("2027-01-05T06:07:08.009Z"));
    expect(await call("POST", "/api/v1/annual_reports/2026/read")).toEqual([200, {}]);
    expect(await reports(h)).toEqual([{ year: 2026, viewed_at: "2027-01-05T06:07:08.009Z", created_at: store }]);
  });

  it.each([
    ["2027-01-01T00:00:00.000Z", "2026-12-31T23:59:59.999Z"],
    ["2027-01-02T12:00:00.000Z", "2026-12-31T23:59:59.999Z"],
    ["2026-12-09T23:59:59.999Z", "2026-12-10T00:00:00.000Z"],
  ])(
    "the Store at %s, outside the campaign, the Worker at %s in it: ineligible, and nothing made",
    async (store, worker) => {
      const { h, call } = await owner(store, worker);
      expect(await call("GET", "/api/v1/annual_reports/2026/state")).toEqual([200, { state: "ineligible" }]);
      expect(await call("POST", "/api/v1/annual_reports/2026/generate")).toEqual([200, {}]);
      expect(await reports(h)).toEqual([]);
    },
  );

  it("is declared on the Store's clock, which replaces a storeNow the caller sends", async () => {
    expect([annualReportState.clock, generateAnnualReport.clock, markAnnualReportRead.clock]).toEqual([
      "storeNow",
      "storeNow",
      "storeNow",
    ]);
    const { h } = await owner("2026-12-20T00:00:00.000Z", "2026-11-01T00:00:00.000Z");
    const [row] = await sql<{ token_hash: string }>(
      h.store,
      "SELECT token_hash FROM oauth_tokens WHERE kind = 'access'",
    );
    const credential = { tokenHash: row!.token_hash, scope: "write:accounts", now: at("2026-11-01T00:00:00.000Z") };
    const input = { credential, year: "2026" } as Parameters<typeof h.store.generateAnnualReport>[1];
    // An RPC caller is not held to the type: it may send the field anyway.
    await h.store.generateAnnualReport(BUILD, { ...input, storeNow: at("2026-11-01T00:00:00.000Z") } as typeof input);
    expect(await reports(h)).toEqual([{ year: 2026, viewed_at: null, created_at: "2026-12-20T00:00:00.000Z" }]);
  });
});
