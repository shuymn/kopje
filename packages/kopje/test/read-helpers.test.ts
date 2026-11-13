import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { StoreStub } from "../src/platform/store-client";
import type { StoreOperation } from "../src/platform/store-kernel";
import { migratedStore } from "./helpers";
import { type GrownRead, grownReads, scansOf } from "./read-helpers";

describe("scansOf", () => {
  // A materialized CTE and a table share one name in two scopes: both scans count, so the table's is never hidden
  // behind the CTE's.
  it("counts a table's scan that shares its name with a materialized subquery", async () => {
    const store = await migratedStore();
    const plan = await runInDurableObject(store, (_instance, state) =>
      state.storage.sql
        .exec<{ detail: string }>(
          "EXPLAIN QUERY PLAN WITH a AS MATERIALIZED (SELECT 1 AS id) SELECT id FROM a UNION ALL SELECT id FROM deliveries a",
        )
        .toArray()
        .map((row) => row.detail),
    );
    expect(plan).toContain("MATERIALIZE a");
    expect(scansOf(plan, ["a"])).toHaveLength(2);
  });
});

describe("grownReads", () => {
  // A Store with `count` settings besides the migrated ones.
  async function settings(count: number): Promise<StoreStub> {
    const store = await migratedStore();
    await runInDurableObject(store, (_instance, state) => {
      state.storage.sql.exec(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO instance_settings (name, value) SELECT 'grown-' || i, 'v' FROM n WHERE ?1 > 0`,
        count,
      );
    });
    return store;
  }

  // A walk of every setting, and a lookup of one by key: the walk grows with the settings, the lookup does not.
  const walk: StoreOperation<null, number> = {
    kind: "read",
    run: (sql) => sql.exec<{ n: number }>("SELECT count(*) AS n FROM instance_settings").one().n,
  };
  const lookup: StoreOperation<{ name: string }, string | null> = {
    kind: "read",
    run: (sql, { name }) =>
      sql.exec<{ value: string }>("SELECT value FROM instance_settings WHERE name = ?", name).toArray()[0]?.value ??
      null,
  };
  const found = (output: unknown) => output === "v";

  it("lists the reads whose rows grew past the allowance and their extra, and no other", async () => {
    const [few, many] = [await settings(1), await settings(200)];
    const reads: GrownRead[] = [
      { name: "walk", operation: walk, input: null, shows: (n) => typeof n === "number" && n > 0 },
      { name: "walk with extra", operation: walk, input: null, shows: (n) => (n as number) > 0, extra: 1_000 },
      { name: "lookup", operation: lookup, input: { name: "grown-0" }, shows: found },
    ];
    const grown = await grownReads(few, many, reads, { allowance: 10 });
    expect(grown).toHaveLength(1);
    expect(grown[0]).toMatch(/^walk: \d+ -> \d+$/);
  });

  // A read that answers nothing in either Store fails, so a refused or empty read cannot pass as flat.
  it.each(["few", "many"] as const)(
    "fails a read whose output in the %s Store does not show what it must",
    async (at) => {
      const [few, many] = [await settings(1), await settings(200)];
      const [missing, present] = [{ name: "missing" }, { name: "grown-0" }];
      const read: GrownRead = {
        name: "lookup",
        operation: lookup,
        input: at === "few" ? missing : present,
        manyInput: at === "many" ? missing : present,
        shows: found,
      };
      await expect(grownReads(few, many, [read], { allowance: 10 })).rejects.toThrow(/lookup/);
      // The guarded branch: the same read finding the setting in both Stores passes.
      expect(await grownReads(few, many, [{ ...read, input: present, manyInput: present }], { allowance: 10 })).toEqual(
        [],
      );
    },
  );

  it("fails reads whose outputs differ by `same`", async () => {
    const [few, many] = [await settings(1), await settings(200)];
    const read: GrownRead = { name: "walk", operation: walk, input: null, shows: (n) => (n as number) > 0 };
    const same = (output: unknown) => output;
    await expect(grownReads(few, many, [read], { allowance: 1_000, same })).rejects.toThrow(/walk/);
    expect(await grownReads(few, few, [read], { allowance: 0, same })).toEqual([]);
  });
});
