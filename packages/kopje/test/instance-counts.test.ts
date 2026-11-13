import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { DOMAIN_COUNT_FRESH_MS, instanceInfo, instanceUsage, refreshDomainCount } from "../src/domain/instance";
import { handleScheduled } from "../src/jobs/scheduled";
import type { StoreStub } from "../src/platform/store-client";
import { apiHarness, type ApiHarness, seedAccount, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { BUILD, migratedStore } from "./helpers";
import { ACCESS, beginImport, dumpViaRpc, importViaRpc, resetImport, setAccess } from "./ops-helpers";
import { observedSql, remoteAccounts, rowsRead } from "./read-helpers";

// The instance's peer domain count (#1502): /api/v1/instance reads the count the cron keeps in one kopje_state row
// while it is fresh (DOMAIN_COUNT_FRESH_MS), and counts it itself, without keeping it, otherwise; /api/v2/instance
// presents no domain count and reads none. The statements' plans against main's are in
// test/other-request-rewrites.test.ts.

const present = { origin: "https://kopje.test" };
const MINUTE_MS = 60_000;

const MAIN_COUNT = "SELECT COUNT(DISTINCT domain) AS n FROM accounts WHERE domain IS NOT NULL";
const kept = (store: StoreStub) =>
  sql<{ value: string }>(store, "SELECT value FROM kopje_state WHERE name = 'domain_count'");
// The kept count, its refresh time checked to be the Store's own clock (Date.now in the test pool), not the caller's.
const keptCount = async (store: StoreStub, before: number): Promise<number | null> => {
  const [row] = await kept(store);
  if (row === undefined) return null;
  const { n, at } = JSON.parse(row.value) as { n: number; at: number };
  expect(at).toBeGreaterThanOrEqual(before);
  expect(at).toBeLessThanOrEqual(Date.now());
  return n;
};
// Sets the kept count's refresh time to `ago` ms before the Store's clock: the time passed since the refresh.
const age = (store: StoreStub, ago: number) =>
  sql(
    store,
    "UPDATE kopje_state SET value = json_set(value, '$.at', CAST(? AS INTEGER)) WHERE name = 'domain_count'",
    Date.now() - ago,
  );
const mainCount = async (h: Pick<ApiHarness, "store">) => (await sql<{ n: number }>(h.store, MAIN_COUNT))[0]!.n;
const domainCount = async (h: ApiHarness) =>
  (await (await h.request("/api/v1/instance")).json<{ stats: { domain_count: number } }>()).stats.domain_count;

// The cron, its callers' clock NOW, which the refresh does not use.
const cron = (h: ApiHarness, maintenance = "off") =>
  handleScheduled({ ...h.env, MAINTENANCE: maintenance } as unknown as Env, {
    build: () => BUILD,
    now: () => NOW,
    store: () => h.store,
  });

const newDomain = (h: Pick<ApiHarness, "store">, i: number) =>
  sql(
    h.store,
    "INSERT INTO accounts (id, uri, username, domain) VALUES (?, ?, 'u', ?)",
    String(700000000000000000n + BigInt(i)),
    `https://n${i}.example/u`,
    `n${i}.example`,
  );

// `count` more remote accounts on `domains` domains of their own.
const more = (h: Pick<ApiHarness, "store">, count: number, domains: number) =>
  sql(
    h.store,
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
		INSERT INTO accounts (id, uri, username, domain)
		SELECT CAST(710000000000000000 + i AS TEXT), 'https://m' || (i % ?2) || '.example/users/u' || i, 'u' || i,
			'm' || (i % ?2) || '.example' FROM n`,
    count,
    domains,
  );

async function world() {
  const h = await apiHarness();
  await seedAccount(h.store, { username: "alice" });
  await remoteAccounts(h, 3, 4);
  return h;
}

describe("the kept peer domain count", () => {
  it("is counted by the request until a cron round keeps it, and then equals the count over the accounts", async () => {
    const h = await world();
    expect(await kept(h.store)).toEqual([]);
    expect(await domainCount(h)).toBe(3);
    // A read writes nothing: the request did not keep what it counted.
    expect(await kept(h.store)).toEqual([]);
    const before = Date.now();
    await cron(h);
    expect(await keptCount(h.store, before)).toBe(3);
    expect(await domainCount(h)).toBe(await mainCount(h));
  });

  it("lags the accounts until the next round", async () => {
    const h = await world();
    await cron(h);
    await newDomain(h, 1);
    await newDomain(h, 2);
    expect(await mainCount(h)).toBe(5);
    expect(await domainCount(h)).toBe(3);
    await cron(h);
    expect(await domainCount(h)).toBe(5);
  });

  it("serves a count refreshed at most DOMAIN_COUNT_FRESH_MS before the request, and counts on request otherwise", async () => {
    const h = await world();
    await cron(h);
    await newDomain(h, 1);
    // Within the window (a margin for the time the request takes): the kept count.
    await age(h.store, DOMAIN_COUNT_FRESH_MS - 30_000);
    expect(await domainCount(h)).toBe(3);
    await age(h.store, DOMAIN_COUNT_FRESH_MS + 1);
    expect(await domainCount(h)).toBe(4);
  });

  it("ignores a refresh time after the request", async () => {
    const h = await world();
    await cron(h);
    await newDomain(h, 1);
    for (const ahead of [60_000, 9 * MINUTE_MS, 60 * MINUTE_MS]) {
      await age(h.store, -ahead);
      expect(await domainCount(h)).toBe(4);
    }
  });

  it("answers the count after a dump's lease made the cron skip its refresh", async () => {
    const h = await world();
    await cron(h);
    await newDomain(h, 1);
    await age(h.store, 4 * MINUTE_MS);
    const started = await h.store.dumpStart(BUILD);
    if (!started.ok) throw new Error(started.message);
    const [before] = await kept(h.store);
    await cron(h);
    // The refresh was refused: the row is as it was; past the window, the request counts.
    expect(await kept(h.store)).toEqual([before]);
    await age(h.store, 11 * MINUTE_MS);
    expect(await domainCount(h)).toBe(4);
  });

  it("counts on request while the env's MAINTENANCE stops the cron", async () => {
    const h = await world();
    await cron(h);
    await newDomain(h, 1);
    await age(h.store, 5 * MINUTE_MS);
    const [before] = await kept(h.store);
    await cron(h, "readonly");
    expect(await kept(h.store)).toEqual([before]);
    await age(h.store, 11 * MINUTE_MS);
    expect(await domainCount(h)).toBe(4);
  });

  it("is refreshed while the Store is readonly", async () => {
    const h = await world();
    expect(await h.store.setMaintenance(BUILD, true)).toMatchObject({ maintenance: true });
    const before = Date.now();
    await cron(h);
    expect(await keptCount(h.store, before)).toBe(3);
  });

  it("is not dumped, and is cleared when an import begins and when a reset ends", async () => {
    const source = await migratedStore();
    await setAccess(source);
    await remoteAccounts({ store: source }, 1, 1);
    await source.refreshDomainCount(BUILD);
    const { text } = await dumpViaRpc(source);
    expect(text).not.toContain("domain_count");
    const target = await migratedStore();
    await setAccess(target);
    // A count kept before the import (another Store's accounts' or an empty Store's).
    await sql(
      target,
      "INSERT INTO kopje_state (name, value) VALUES ('domain_count', ?)",
      JSON.stringify({ n: 9, at: NOW }),
    );
    const { id } = await importViaRpc(target, text);
    expect(await kept(target)).toEqual([]);
    // Kept again while the import is unpublished, then the reset ends: cleared.
    await target.refreshDomainCount(BUILD);
    expect(await keptCount(target, 0)).toBe(1);
    for (;;) {
      const step = await target.cutoverReset(BUILD, ACCESS);
      expect(step, JSON.stringify(step)).toMatchObject({ ok: true });
      if (step.ok && step.done) {
        break;
      }
    }
    expect(id).not.toBe("");
    expect(await kept(target)).toEqual([]);
  }, 60_000);

  it("is cleared by the cutover reset of a Store the import left empty", async () => {
    const source = await migratedStore();
    await setAccess(source);
    const { text } = await dumpViaRpc(source);
    const target = await migratedStore();
    await setAccess(target);
    await importViaRpc(target, text);
    await target.refreshDomainCount(BUILD);
    expect(await keptCount(target, 0)).toBe(0);
    // The empty Store's branch: done at once, with no reset record.
    expect(await target.cutoverReset(BUILD, ACCESS)).toMatchObject({ ok: true, id: null, done: true });
    expect(await kept(target)).toEqual([]);
  }, 60_000);

  it("is cleared when an import in progress is reset", async () => {
    const source = await migratedStore();
    await setAccess(source);
    const { text } = await dumpViaRpc(source);
    const target = await migratedStore();
    await setAccess(target);
    const id = await beginImport(target, text);
    // No refresh runs while an import is in progress; a row there (one written around the gate) still goes.
    expect(await target.refreshDomainCount(BUILD).catch((error: unknown) => String(error))).toMatch(/import/);
    await sql(
      target,
      "INSERT INTO kopje_state (name, value) VALUES ('domain_count', ?)",
      JSON.stringify({ n: 9, at: NOW }),
    );
    expect(await resetImport(target, id)).toMatchObject({ ok: true });
    expect(await kept(target)).toEqual([]);
  }, 60_000);

  // Each value made at the Store's current time, so only its shape can make it ignored; the well-formed one is served.
  it.each([
    ["a number", () => 7],
    ["a decimal text", () => "7"],
    ["without its time", () => JSON.stringify({ n: 7 })],
    ["with a text time", (at: number) => JSON.stringify({ n: 7, at: String(at) })],
    ["a negative count", (at: number) => JSON.stringify({ n: -1, at })],
    ["a fractional count", (at: number) => JSON.stringify({ n: 2.5, at })],
    ["a text count", (at: number) => JSON.stringify({ n: "7", at })],
    ["not JSON", (at: number) => `{"n": 7, "at": ${at}`],
    ["with a NUL", (at: number) => `${JSON.stringify({ n: 7, at })}\u0000`],
    ["over 64 bytes", (at: number) => JSON.stringify({ n: 7, at, pad: "x".repeat(40) })],
    ["a blob", (at: number) => new TextEncoder().encode(JSON.stringify({ n: 7, at })).buffer],
    ["well formed", (at: number) => JSON.stringify({ n: 7, at })],
  ] as [string, (at: number) => SqlStorageValue][])("is ignored when the stored value is %s", async (name, value) => {
    const h = await world();
    await sql(h.store, "INSERT INTO kopje_state (name, value) VALUES ('domain_count', ?)", value(Date.now() - 1000));
    expect(await domainCount(h)).toBe(name === "well formed" ? 7 : 3);
    await cron(h);
    expect(await keptCount(h.store, 0)).toBe(3);
  });

  it("reads one row of kopje_state and no remote account once kept, however many accounts and domains", async () => {
    const h = await world();
    await cron(h);
    const small = await rowsRead(h, instanceInfo, { now: NOW, storeNow: Date.now(), present });
    await more(h, 300, 30);
    await cron(h);
    expect(await rowsRead(h, instanceInfo, { now: NOW, storeNow: Date.now(), present })).toBe(small);
  }, 60_000);

  it("counts in the refresh as main does, with one row written", async () => {
    const h = await world();
    await more(h, 50, 7);
    const written = await runInDurableObject(h.store, (_instance, state) => {
      let rows = 0;
      const real = state.storage.sql;
      refreshDomainCount.run(
        {
          exec: (query: string, ...params: SqlStorageValue[]) => {
            const cursor = real.exec(query, ...params);
            return { rowsWritten: (rows += cursor.rowsWritten) };
          },
        } as unknown as SqlStorage,
        { storeNow: NOW },
      );
      return rows;
    });
    expect(written).toBe(1);
    expect(await kept(h.store)).toEqual([{ value: JSON.stringify({ n: await mainCount(h), at: NOW }) }]);
  });
});

describe("/api/v2/instance", () => {
  it("runs no count of the remote accounts, status sums or users, and presents the active users", async () => {
    const h = await world();
    const statements: string[] = [];
    await runInDurableObject(h.store, (_instance, state) => {
      const info = instanceUsage.run(
        observedSql(state.storage.sql, (_rows, query) => statements.push(query)),
        { now: NOW, present },
      );
      expect(info.activeMonth).toBe(0);
    });
    expect(statements.some((query) => /FROM local_accounts l/.test(query))).toBe(true);
    expect(statements.filter((query) => /DISTINCT|statuses_count|kopje_state|FROM accounts\b/.test(query))).toEqual([]);
    const response = await h.request("/api/v2/instance");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ usage: { users: { active_month: 0 } } });
  });

  it("is answered by the usage operation, and /api/v1/instance by the one with the counts", async () => {
    const called: string[] = [];
    const h = await apiHarness(
      {},
      {
        wrapStore: (store) =>
          new Proxy(store, {
            get: (target, name, receiver) => {
              if (typeof name === "string") called.push(name);
              return Reflect.get(target, name, receiver) as unknown;
            },
          }),
      },
    );
    await h.request("/api/v2/instance");
    expect(called).toContain("instanceUsage");
    expect(called).not.toContain("instanceInfo");
    called.length = 0;
    await h.request("/api/v1/instance");
    expect(called).toContain("instanceInfo");
    expect(called).not.toContain("instanceUsage");
  });

  it("reads no more rows as the remote accounts grow", async () => {
    const h = await world();
    const small = await rowsRead(h, instanceUsage, { now: NOW, present });
    await more(h, 300, 30);
    expect(await rowsRead(h, instanceUsage, { now: NOW, present })).toBe(small);
  }, 60_000);
});
