import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { featuredOfStatus, MAX_FEATURED_TAGS } from "../src/domain/featured-tags";
import { sql } from "./api-helpers";
import { type PlannedStatement, plannedSql, scansOf, staleStatistics } from "./read-helpers";
import { community, post } from "./status-helpers";

// featuredOfStatus (featured-tags.ts), which a post or an edit of a status reads twice: the featured hashtags of the
// status's author among its hashtags, from the author's featured hashtags, each sought among the status's by key.

describe("a status's featured hashtags", () => {
  // RES-7, with stale statistics: taken while each status has one or two hashtags, then one status grows to 10,000.
  // The read stays at the author's featured hashtags (MAX_FEATURED_TAGS, the most Kopje's writers keep) whatever the
  // status holds; unpinned, those statistics walked the status's hashtags.
  it("reads the author's featured hashtags, not the status's, with stale statistics", async () => {
    const h = await community(["alice"]);
    const alice = h.users.alice;
    const { id } = await post(h, alice, { status: "#cats #dogs" });
    // At the statistics: the author features MAX_FEATURED_TAGS hashtags, and each of 200 statuses has one or two.
    await sql(
      h.store,
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?2 - 1)
			INSERT INTO featured_tags (id, account_id, name, display_name)
			SELECT CAST(410000000000000000 + i AS TEXT), ?1, CASE i WHEN 0 THEN 'cats' ELSE 'tag' || (20000 + i) END, 'x'
			FROM n`,
      alice.id,
      MAX_FEATURED_TAGS,
    );
    await sql(
      h.store,
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 199)
			INSERT INTO statuses (id, uri, account_id, visibility, published_at)
			SELECT CAST(420000000000000000 + i AS TEXT), 'https://kopje.test/ap/o/t' || i, ?1, 'public', '2026-01-01T00:00:00.000Z'
			FROM n`,
      alice.id,
    );
    await sql(
      h.store,
      `INSERT INTO status_tags (status_id, name)
			SELECT id, 'a' || substr(id, -3) FROM statuses WHERE id GLOB '42*'
			UNION ALL SELECT id, 'b' || substr(id, -3) FROM statuses WHERE id GLOB '42*' AND CAST(substr(id, -1) AS INTEGER) < 5`,
    );
    const capture = () =>
      runInDurableObject(h.store, (_instance, state) => {
        const plans: PlannedStatement[] = [];
        const result = featuredOfStatus(new Db(plannedSql(state.storage.sql, /status_tags t/, plans)), id);
        return { names: result?.names, plans };
      });
    const { before, after } = await staleStatistics(h, {
      capture,
      grow: () =>
        sql(
          h.store,
          `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 9999)
					INSERT INTO status_tags (status_id, name) SELECT ?1, 'tag' || i FROM n`,
          id,
        ),
    });
    expect(before.names).toEqual(["cats"]);
    expect(after.names).toEqual(["cats"]);
    expect(after.plans).toHaveLength(1);
    const { plan, rows } = after.plans[0]!;
    expect(scansOf(plan, ["f", "t"])).toEqual([]);
    expect(rows).toBe(before.plans[0]!.rows);
    expect(rows).toBeLessThanOrEqual(2 * MAX_FEATURED_TAGS + 1);
  });
});
