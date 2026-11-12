import { runInDurableObject } from "cloudflare:test";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { hostCoveredSql, hostMediaRejectedSql, MAX_BLOCK_LABELS } from "../src/domain/audience";
import { actorDomainBlocked } from "../src/domain/instance-domain-blocks";
import { DNS_NAME_UTF8_BYTES } from "../src/platform/domain-name";
import { migratedStore } from "./helpers";

// The suffix walk of a domain block's rule (audience.ts ruledSql), through hostCoveredSql. No stored bound limits an
// account's domain or its actor id's host: a key past DNS_NAME_UTF8_BYTES bytes is never walked and is covered, and a
// key within them has at most a dot per byte, so its walk is at most DNS_NAME_UTF8_BYTES rows.

// The walk without the bound, as it stood: the reference the bounded one agrees with on every key within it.
const walkedSql = (rule: string) => `EXISTS (WITH RECURSIVE pk(d) AS (SELECT ?1),
	ps(d, dots) AS (SELECT d, length(d) - length(replace(d, '.', '')) FROM pk
		UNION ALL SELECT substr(d, instr(d, '.') + 1), dots - 1 FROM ps WHERE dots > 1
			AND NOT EXISTS (SELECT 1 FROM main.instance_domain_blocks pn WHERE ps.dots BETWEEN 1 AND ${MAX_BLOCK_LABELS - 1}
				AND pn.domain = ps.d))
	SELECT 1 FROM ps CROSS JOIN main.instance_domain_blocks pr ON pr.domain = ps.d
	WHERE ps.dots BETWEEN 1 AND ${MAX_BLOCK_LABELS - 1} AND ${rule})`;
const WALKED = walkedSql("pr.severity = 'suspend'");
const WALKED_MEDIA = walkedSql("pr.reject_media = 1");

const BOUNDED = hostCoveredSql("?1");
const BOUNDED_MEDIA = hostMediaRejectedSql("?1");

const bytes = (key: string) => new TextEncoder().encode(key).byteLength;

// A fixed MAX_BLOCK_LABELS-label tail, blocked, and one under no block.
const BLOCKED_TAIL = "a.b.c.d.e.f.blocked.example";
const FREE_TAIL = "a.b.c.d.e.f.free.example";

// A key of `labels` labels: single-letter labels in front of `tail`.
const keyOf = (labels: number, tail: string) =>
  [...Array.from({ length: labels - tail.split(".").length }, () => "z"), tail].join(".");

// Non-ASCII keys at the bound and one byte past it (é is two bytes in UTF-8).
const AT_BOUND = `${"é".repeat((DNS_NAME_UTF8_BYTES - ".example".length) / 2)}.example`;
const PAST_BOUND = `a${AT_BOUND}`;
// A valid IDN in U-label form past 253 bytes: 314 bytes, 182 octets as A-labels.
const IDN = [...Array.from({ length: 3 }, () => "é".repeat(50)), "example", "org"].join(".");

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
  // The rows a key's walk reads grow by the same count per dot, up to a dot per byte within DNS_NAME_UTF8_BYTES, so a
  // key's walk reads at most `base + DNS_NAME_UTF8_BYTES * perDot`; a key past the bound reads no walk row and is
  // covered. Inputs at their worst: suspend blocks present (the walk runs), a key under none (the walk goes to its
  // end), and the most dots within the bound (a key of empty labels).
  it("reads rows linear in a key's dots within the bound, and none past it", async () => {
    const store = await blockedStore();
    const read = (key: string) =>
      runInDurableObject(store, (_instance, state) => {
        const cursor = state.storage.sql.exec<{ covered: number }>(`SELECT ${BOUNDED} AS covered`, key);
        return { covered: cursor.one().covered, rows: cursor.rowsRead };
      });
    const [at20, at21, at126] = [
      await read(keyOf(20, FREE_TAIL)),
      await read(keyOf(21, FREE_TAIL)),
      await read(keyOf(126, FREE_TAIL)),
    ];
    const perDot = at21.rows - at20.rows;
    expect(perDot).toBeGreaterThan(0);
    expect(at126.rows).toBe(at20.rows + (126 - 20) * perDot);
    expect([at20.covered, at21.covered, at126.covered]).toEqual([0, 0, 0]);
    // The most dots within the bound: a key of DNS_NAME_UTF8_BYTES dots, a row of the walk each.
    const dots = (n: number) => read(".".repeat(n));
    const [half, full] = [await dots(DNS_NAME_UTF8_BYTES / 2), await dots(DNS_NAME_UTF8_BYTES)];
    expect(full.rows).toBe(half.rows + (DNS_NAME_UTF8_BYTES / 2) * perDot);
    expect(full.covered).toBe(0);
    // Under the blocked tail, the walk stops at it however long the prefix.
    const blocked = [await read(keyOf(20, BLOCKED_TAIL)), await read(keyOf(120, BLOCKED_TAIL))];
    expect(blocked.map((r) => r.covered)).toEqual([1, 1]);
    expect(blocked[1]!.rows).toBe(blocked[0]!.rows + 100 * perDot);
    // Past the bound: covered, and no more rows than a one-label key's walk.
    const past = await dots(DNS_NAME_UTF8_BYTES + 1);
    const single = await read("localhost");
    expect(past.covered).toBe(1);
    expect(past.rows).toBeLessThanOrEqual(single.rows);
  }, 60_000);

  // The gate (inbox.ts receive's actorDomainBlocked) on adversarial actors, by their host and as stored accounts:
  // each answer within PATH_MS. Past the bound it is covered unwalked; at it, the walk of 506 labels.
  const PATH_MS = 250;
  it.each([
    ["at the bound, of one-letter labels", `${"z.".repeat(505)}fe`, false],
    [
      "of 64 KiB, two long labels around fifteen short ones",
      `${"a".repeat(32_768)}${".x".repeat(15)}.${"b".repeat(32_768)}`,
      true,
    ],
    ["of 1 MiB of one-letter labels", `${"z.".repeat(524_287)}fe`, true],
  ])(
    "answers the gate on a host %s quickly",
    async (_name, host, covered) => {
      const store = await migratedStore();
      const uri = `https://${host}/users/u`;
      const answers = await runInDurableObject(store, (_instance, state) => {
        state.storage.sql.exec(`INSERT INTO instance_domain_blocks (domain, severity, created_at, updated_at)
				VALUES ('other.example', 'suspend', '', '')`);
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
      expect(bytes(host) > DNS_NAME_UTF8_BYTES).toBe(covered);
      expect(answers.blocked).toBe(covered);
      expect(answers.ms).toBeLessThan(PATH_MS);
    },
    60_000,
  );

  // Keys at the bound by octets: one at it walks as it stood, one byte past it is covered, both non-ASCII; and a valid
  // IDN in U-label form past 253 bytes is walked, so a block on its A-label form neither covers it nor rejects its
  // media, as before the bound.
  it("walks a key at the bound and covers one past it", async () => {
    const store = await migratedStore();
    const result = await runInDurableObject(store, (_instance, state) => {
      const sql = state.storage.sql;
      const aLabels = new URL(`https://${IDN}/`).hostname;
      sql.exec(
        `INSERT INTO instance_domain_blocks (domain, severity, reject_media, created_at, updated_at)
				VALUES (?, 'noop', 1, '', ''), ('blocked.test', 'suspend', 0, '', '')`,
        aLabels,
      );
      const one = (query: string, key: string) => sql.exec<{ c: number }>(`SELECT ${query} AS c`, key).one().c;
      const octets = (key: string) => sql.exec<{ n: number }>("SELECT length(CAST(? AS BLOB)) AS n", key).one().n;
      return {
        octets: [octets(AT_BOUND), octets(PAST_BOUND), octets(IDN), aLabels.length],
        at: [one(BOUNDED, AT_BOUND), one(WALKED, AT_BOUND)],
        past: one(BOUNDED, PAST_BOUND),
        idn: [one(BOUNDED, IDN), one(WALKED, IDN), one(BOUNDED_MEDIA, IDN), one(WALKED_MEDIA, IDN)],
      };
    });
    expect(result.octets).toEqual([DNS_NAME_UTF8_BYTES, DNS_NAME_UTF8_BYTES + 1, 314, 182]);
    expect(result.at).toEqual([0, 0]);
    expect(result.past).toBe(1);
    expect(result.idn).toEqual([0, 0, 0, 0]);
  });

  // The bounded walk finds the rule the walk as it stood finds for every key within the bound: keys of any depth,
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
          expect(result.bounded, JSON.stringify(key)).toBe(bytes(key) <= DNS_NAME_UTF8_BYTES ? result.walked : 1);
        },
      ),
      { numRuns: 400 },
    );
  }, 120_000);
});
