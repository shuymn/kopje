import { runInDurableObject } from "cloudflare:test";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { hostCoveredSql, MAX_BLOCK_LABELS } from "../src/domain/audience";
import { actorDomainBlocked } from "../src/domain/instance-domain-blocks";
import { DNS_NAME_OCTETS } from "../src/platform/domain-name";
import { migratedStore } from "./helpers";

// The suffix walk of a domain block's rule (audience.ts ruledSql), through hostCoveredSql. No stored bound limits an
// account's domain or its actor id's host: a key past DNS_NAME_OCTETS bytes is never walked and is covered, and a key
// within them has at most 127 labels, so its walk is at most 126 rows.

// The walk without the bound, as it stood: the reference the bounded one agrees with on every key within it.
const WALKED = `EXISTS (WITH RECURSIVE pk(d) AS (SELECT ?1),
	ps(d, dots) AS (SELECT d, length(d) - length(replace(d, '.', '')) FROM pk
		UNION ALL SELECT substr(d, instr(d, '.') + 1), dots - 1 FROM ps WHERE dots > 1
			AND NOT EXISTS (SELECT 1 FROM main.instance_domain_blocks pn WHERE ps.dots BETWEEN 1 AND ${MAX_BLOCK_LABELS - 1}
				AND pn.domain = ps.d))
	SELECT 1 FROM ps CROSS JOIN main.instance_domain_blocks pr ON pr.domain = ps.d
	WHERE ps.dots BETWEEN 1 AND ${MAX_BLOCK_LABELS - 1} AND pr.severity = 'suspend')`;

const BOUNDED = hostCoveredSql("?1");

// A fixed MAX_BLOCK_LABELS-label tail, blocked, and one under no block.
const BLOCKED_TAIL = "a.b.c.d.e.f.blocked.example";
const FREE_TAIL = "a.b.c.d.e.f.free.example";

// A key of `labels` labels: single-letter labels in front of `tail`.
const keyOf = (labels: number, tail: string) =>
  [...Array.from({ length: labels - tail.split(".").length }, () => "z"), tail].join(".");

async function blockedStore() {
  const store = await migratedStore();
  await runInDurableObject(store, (_instance, state) => {
    for (const domain of [BLOCKED_TAIL, "other.example"]) {
      state.storage.sql.exec(
        `INSERT INTO instance_domain_blocks (domain, severity, created_at, updated_at) VALUES (?, 'suspend', '', '')`,
        domain,
      );
    }
  });
  return store;
}

describe("a domain block's suffix walk", () => {
  // The rows a key's walk reads grow by the same count per label up to 127 labels (the most within DNS_NAME_OCTETS:
  // 126 one-letter labels and their dots, then a last label), so a key's walk reads at most `base + 126 * perLabel`;
  // a key past DNS_NAME_OCTETS reads no walk row and is covered. Inputs at their worst: suspend blocks present (the
  // walk runs), a key under none (the walk goes to its end), at the most labels within the bound.
  it("reads rows linear in a key's labels within the bound, and none past it", async () => {
    const store = await blockedStore();
    const read = (key: string) =>
      runInDurableObject(store, (_instance, state) => {
        const cursor = state.storage.sql.exec<{ covered: number }>(`SELECT ${BOUNDED} AS covered`, key);
        return { covered: cursor.one().covered, rows: cursor.rowsRead };
      });
    const widest = `${"z.".repeat(125)}fff`;
    expect(new TextEncoder().encode(widest).byteLength).toBe(DNS_NAME_OCTETS);
    expect(widest.split(".")).toHaveLength(126);
    const [at20, at21, at126] = [
      await read(keyOf(20, FREE_TAIL)),
      await read(keyOf(21, FREE_TAIL)),
      await read(widest),
    ];
    const perLabel = at21.rows - at20.rows;
    expect(perLabel).toBeGreaterThan(0);
    expect(at126.rows).toBe(at20.rows + (126 - 20) * perLabel);
    expect([at20.covered, at21.covered, at126.covered]).toEqual([0, 0, 0]);
    // Under the blocked tail, the walk stops at it however long the prefix.
    const blocked = [await read(keyOf(20, BLOCKED_TAIL)), await read(keyOf(120, BLOCKED_TAIL))];
    expect(blocked.map((r) => r.covered)).toEqual([1, 1]);
    expect(blocked[1]!.rows).toBe(blocked[0]!.rows + 100 * perLabel);
    // Past the bound: covered, and no more rows than a one-label key's walk.
    const past = await read(`${"z.".repeat(126)}fe`);
    const single = await read("localhost");
    expect(past.covered).toBe(1);
    expect(past.rows).toBeLessThanOrEqual(single.rows);
  }, 60_000);

  // The gate (inbox.ts receive's actorDomainBlocked) on adversarial actors, by their host and as stored accounts:
  // each answer within PATH_MS, and covered. The walk as it stood read a row per label of each.
  const PATH_MS = 250;
  it.each([
    [
      "64 KiB of two long labels around fifteen short ones",
      `${"a".repeat(32_768)}${".x".repeat(15)}.${"b".repeat(32_768)}`,
    ],
    ["1 MiB of one-letter labels", `${"z.".repeat(524_287)}fe`],
  ])(
    "answers the gate on a host of %s quickly",
    async (_name, host) => {
      const store = await migratedStore();
      const uri = `https://${host}/users/u`;
      const answers = await runInDurableObject(store, (_instance, state) => {
        state.storage.sql.exec(
          `INSERT INTO accounts (id, uri, username, domain) VALUES ('800000000000000001', ?, 'u', ?)`,
          uri,
          host,
        );
        const db = new Db(state.storage.sql);
        const started = performance.now();
        const blocked = actorDomainBlocked(db, uri);
        return { blocked, ms: performance.now() - started };
      });
      expect(answers.blocked).toBe(true);
      expect(answers.ms).toBeLessThan(PATH_MS);
    },
    60_000,
  );

  // The bounded walk finds the rule the walk as it stood finds for every key within DNS_NAME_OCTETS: keys of any depth,
  // empty labels, non-ASCII ones, NUL and other control characters included, under blocks on any of their suffixes of
  // 2 to MAX_BLOCK_LABELS labels, suspend or noop; and a key past the bound is covered.
  it("finds the rule the walk as it stood finds", async () => {
    const store = await migratedStore();
    const label = fc.constantFrom("a", "b", "xn--d", "é", "", "a-b", "0", "\0", "a\0b", "\x01", "\t", "\x7f");
    await fc.assert(
      fc.asyncProperty(
        fc.array(label, { minLength: 1, maxLength: 40 }),
        fc.array(fc.tuple(fc.integer({ min: 2, max: MAX_BLOCK_LABELS }), fc.boolean()), { maxLength: 4 }),
        async (labels, blocks) => {
          const key = labels.join(".");
          const result = await runInDurableObject(store, (_instance, state) => {
            const sql = state.storage.sql;
            sql.exec("DELETE FROM instance_domain_blocks");
            for (const [depth, suspend] of blocks) {
              const domain = labels.slice(-depth).join(".");
              const valid = sql
                .exec<{ ok: number }>(
                  `SELECT ?1 = lower(?1) AND ?1 GLOB '?*.?*' AND length(?1) - length(replace(?1, '.', '')) < 8 AS ok`,
                  domain,
                )
                .one().ok;
              if (valid === 1) {
                sql.exec(
                  `INSERT OR IGNORE INTO instance_domain_blocks (domain, severity, created_at, updated_at)
									VALUES (?, ?, '', '')`,
                  domain,
                  suspend ? "suspend" : "noop",
                );
              }
            }
            const one = (query: string) => sql.exec<{ c: number }>(`SELECT ${query} AS c`, key).one().c;
            return { bounded: one(BOUNDED), walked: one(WALKED) };
          });
          const within = new TextEncoder().encode(key).byteLength <= DNS_NAME_OCTETS;
          expect(result.bounded, JSON.stringify(key)).toBe(within ? result.walked : 1);
        },
      ),
      { numRuns: 400 },
    );
  }, 120_000);
});
