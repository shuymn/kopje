import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { instanceInfo, instanceUsage, refreshDomainCount } from "../src/domain/instance";
import { handleScheduled } from "../src/jobs/scheduled";
import { apiHarness, type ApiHarness, seedAccount, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { BUILD } from "./helpers";
import { observedSql, remoteAccounts, rowsRead } from "./read-helpers";

// The instance's peer domain count (#1502): /api/v1/instance reads the count the cron keeps in one kopje_state row, and
// counts it itself, without keeping it, only while none is kept; /api/v2/instance presents no domain count and reads
// none. The statements' plans against main's are in test/other-request-rewrites.test.ts.

const present = { origin: "https://kopje.test" };

const MAIN_COUNT = "SELECT COUNT(DISTINCT domain) AS n FROM accounts WHERE domain IS NOT NULL";
const kept = (h: Pick<ApiHarness, "store">) =>
  sql<{ value: string }>(h.store, "SELECT value FROM kopje_state WHERE name = 'domain_count'");
const mainCount = async (h: Pick<ApiHarness, "store">) => (await sql<{ n: number }>(h.store, MAIN_COUNT))[0]!.n;
const domainCount = async (h: ApiHarness) =>
  (await (await h.request("/api/v1/instance")).json<{ stats: { domain_count: number } }>()).stats.domain_count;

const cron = (h: ApiHarness) =>
  handleScheduled({ ...h.env, MAINTENANCE: "off" } as unknown as Env, {
    build: () => BUILD,
    now: () => NOW,
    store: () => h.store,
  });

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
    expect(await kept(h)).toEqual([]);
    expect(await domainCount(h)).toBe(3);
    // A read writes nothing: the request did not keep what it counted.
    expect(await kept(h)).toEqual([]);
    await cron(h);
    expect(await kept(h)).toEqual([{ value: "3" }]);
    expect(await domainCount(h)).toBe(await mainCount(h));
  });

  it("lags the accounts by up to one cron round", async () => {
    const h = await world();
    await cron(h);
    await sql(
      h.store,
      `INSERT INTO accounts (id, uri, username, domain) VALUES
			('700000000000000001', 'https://n1.example/u', 'u', 'n1.example'),
			('700000000000000002', 'https://n2.example/u', 'u', 'n2.example')`,
    );
    expect(await mainCount(h)).toBe(5);
    expect(await domainCount(h)).toBe(3);
    await cron(h);
    expect(await domainCount(h)).toBe(5);
  });

  it("is refreshed while the Store is readonly, and writes nothing when it has not changed", async () => {
    const h = await world();
    expect(await h.store.setMaintenance(BUILD, true)).toMatchObject({ maintenance: true });
    await cron(h);
    expect(await kept(h)).toEqual([{ value: "3" }]);
    const written = (): Promise<number> =>
      runInDurableObject(h.store, (_instance, state) => {
        let rows = 0;
        const real = state.storage.sql;
        refreshDomainCount.run({
          exec: (query: string, ...params: SqlStorageValue[]) => {
            const cursor = real.exec(query, ...params);
            return { rowsWritten: (rows += cursor.rowsWritten) };
          },
        } as unknown as SqlStorage);
        return rows;
      });
    // Unchanged: nothing written. Changed: the one row.
    expect(await written()).toBe(0);
    await sql(
      h.store,
      "INSERT INTO accounts (id, uri, username, domain) VALUES ('700000000000000001', 'https://n.example/u', 'u', 'n.example')",
    );
    expect(await written()).toBeGreaterThan(0);
    expect(await kept(h)).toEqual([{ value: "4" }]);
  });

  it("is not dumped", async () => {
    const h = await world();
    await cron(h);
    const dumped = await h.store.dumpStart(BUILD);
    if (!dumped.ok) throw new Error(dumped.message);
    expect(JSON.stringify(dumped)).not.toContain("domain_count");
  });

  it.each([
    ["a number", 7],
    ["a negative one", "-1"],
    ["a decimal", "2.5"],
    ["hex", "0x10"],
    ["padded", " 4 "],
    ["empty", ""],
    ["with a NUL", "4\u0000"],
    ["too long", "1".repeat(16)],
    ["a blob", new Uint8Array([0x34]).buffer],
  ] as [string, SqlStorageValue][])("is ignored when the stored value is %s", async (_name, value) => {
    const h = await world();
    await sql(h.store, "INSERT INTO kopje_state (name, value) VALUES ('domain_count', ?)", value);
    expect(await domainCount(h)).toBe(3);
    await cron(h);
    expect(await kept(h)).toEqual([{ value: "3" }]);
  });

  it("reads one row of kopje_state and no remote account once kept, however many accounts and domains", async () => {
    const h = await world();
    await cron(h);
    const small = await rowsRead(h, instanceInfo, { now: NOW, present });
    await more(h, 300, 30);
    await cron(h);
    expect(await rowsRead(h, instanceInfo, { now: NOW, present })).toBe(small);
  }, 60_000);
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
