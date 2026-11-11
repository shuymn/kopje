import { runInDurableObject } from "cloudflare:test";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { hostCoveredSql, MAX_BLOCK_LABELS } from "../src/domain/audience";
import { migratedStore } from "./helpers";

// The suffix walk of a domain block's rule (audience.ts ruledSql), through hostCoveredSql. No stored bound limits an
// account's domain or its actor id's host, so a key of 2 * MAX_BLOCK_LABELS dots or more steps to its last
// MAX_BLOCK_LABELS labels, the deepest a block names (migration 0046_instance_domain_blocks's CHECK).

// The walk as it stood, every suffix of the key from the longest: the reference the bounded one must agree with.
const WALKED = `EXISTS (WITH RECURSIVE pk(d) AS (SELECT ?1),
	ps(d, dots) AS (SELECT d, length(d) - length(replace(d, '.', '')) FROM pk
		UNION ALL SELECT substr(d, instr(d, '.') + 1), dots - 1 FROM ps WHERE dots > 1
			AND NOT EXISTS (SELECT 1 FROM main.instance_domain_blocks pn WHERE ps.dots BETWEEN 1 AND ${MAX_BLOCK_LABELS - 1}
				AND pn.domain = ps.d))
	SELECT 1 FROM ps CROSS JOIN main.instance_domain_blocks pr ON pr.domain = ps.d
	WHERE ps.dots BETWEEN 1 AND ${MAX_BLOCK_LABELS - 1} AND pr.severity = 'suspend')`;

const BOUNDED = hostCoveredSql("?1");

// A domain of `labels` labels under `parent`.
const deep = (labels: number, parent: string) =>
  [...Array.from({ length: labels - parent.split(".").length }, (_, i) => `l${i}`), parent].join(".");

describe("a domain block's suffix walk", () => {
  // The witness: with a suspend block present (so the walk runs), a key at 2,000 labels reads what one at 20 reads
  // (both past the step), and the walk as it stood grows with it. Inputs at their worst: the key's labels (no stored
  // bound), a block on its MAX_BLOCK_LABELS-label suffix and one on its 2-label suffix, both read; a key under none.
  it("reads the same rows however many labels the key has", async () => {
    const store = await migratedStore();
    const read = (query: string, key: string) =>
      runInDurableObject(store, (_instance, state) => {
        const cursor = state.storage.sql.exec<{ covered: number }>(`SELECT ${query} AS covered`, key);
        return { covered: cursor.one().covered, rows: cursor.rowsRead };
      });
    await runInDurableObject(store, (_instance, state) => {
      for (const domain of ["blocked.example", deep(MAX_BLOCK_LABELS, "nested.example"), "other.test"]) {
        state.storage.sql.exec(
          `INSERT INTO instance_domain_blocks (domain, severity, created_at, updated_at) VALUES (?, 'suspend', '', '')`,
          domain,
        );
      }
    });
    for (const parent of ["blocked.example", "nested.example", "free.example"]) {
      const [shallow, deeper] = [deep(20, parent), deep(2_000, parent)];
      const bounded = [await read(BOUNDED, shallow), await read(BOUNDED, deeper)];
      const walked = [await read(WALKED, shallow), await read(WALKED, deeper)];
      expect(
        bounded.map((r) => r.covered),
        parent,
      ).toEqual(walked.map((r) => r.covered));
      expect(bounded[1]!.rows, parent).toBe(bounded[0]!.rows);
      expect(walked[1]!.rows, parent).toBeGreaterThan(walked[0]!.rows + 1_000);
    }
  }, 60_000);

  // The bounded walk finds the rule the full one finds: keys of any depth, empty labels and non-ASCII ones included,
  // under blocks on any of their suffixes of 2 to MAX_BLOCK_LABELS labels, suspend or noop.
  it("finds the rule the full walk finds", async () => {
    const store = await migratedStore();
    const label = fc.constantFrom("a", "b", "xn--d", "é", "", "a-b", "0");
    await fc.assert(
      fc.asyncProperty(
        fc.array(label, { minLength: 1, maxLength: 24 }),
        fc.array(fc.tuple(fc.integer({ min: 2, max: MAX_BLOCK_LABELS }), fc.boolean()), { maxLength: 4 }),
        async (labels, blocks) => {
          const key = labels.join(".");
          const agree = await runInDurableObject(store, (_instance, state) => {
            const sql = state.storage.sql;
            sql.exec("DELETE FROM instance_domain_blocks");
            for (const [depth, suspend] of blocks) {
              const domain = labels.slice(-depth).join(".");
              const valid = sql
                .exec<{ ok: number }>(
                  `SELECT ? = lower(?) AND ? GLOB '?*.?*' AND length(?) - length(replace(?, '.', '')) < 8 AS ok`,
                  domain,
                  domain,
                  domain,
                  domain,
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
          expect(agree.bounded, key).toBe(agree.walked);
        },
      ),
      { numRuns: 300 },
    );
  }, 120_000);
});
