import { runInDurableObject } from "cloudflare:test";
import { describe, it } from "vitest";

import { Db } from "../src/db/sql";
import { recountStatus } from "../src/domain/statuses";
import { migratedStore } from "./helpers";
import { expectBeside, expectGrowth, PlanWitness, type Run, STATISTICS, type Statistics } from "./plan-witness";

// The RES-7 witness of recountStatus (src/domain/statuses.ts), which migration 0114_untrusted_counts made one row-value
// assignment, so that it moves a remote status's untrusted counts with its own in the same write: run beside main's
// statement by test/plan-witness.ts, under the plan audit's singleton statistics and after ANALYZE, it writes the same
// own counts to the same row and reads no more than main but for the one row its triggers read again (ROW_ALLOWANCES).
// Its reads grow only with what it counts, the status's own replies, boosts and favourites, and stay the same as other
// statuses' grow, below and above its id. The rows main's writers do not produce are in the world as an import writes
// them: an own count stored as text, withdrawn boosts, and private, direct and limited replies. The untrusted counts it
// writes besides are the rewrite's addition (test/untrusted-counts.test.ts, "move a remote status's untrusted counts").

const TARGET = "800000000000000500";
const BELOW = "800000000000000100";
const ABOVE = "800000000000000900";

const WITNESS = new PlanWitness(
  {
    // recountStatus, origin/main before migration 0114_untrusted_counts.
    c5c0b8e647a58f86: {
      sql: `UPDATE statuses SET replies_count = (SELECT COUNT(*) FROM statuses r WHERE r.in_reply_to_id = ?1 AND r.visibility IN ('public', 'unlisted')), reblogs_count = (SELECT COUNT(*) FROM statuses r INDEXED BY statuses_reblog WHERE r.reblog_of_id = ?1 AND r.reblog_of_id IS NOT NULL AND r.withdrawn = 0), favourites_count = (SELECT COUNT(*) FROM favourites f WHERE f.status_id = ?1) WHERE id = ?1`,
      text: `UPDATE statuses SET (replies_count, reblogs_count, favourites_count, untrusted_reblogs_count, untrusted_favourites_count) = (SELECT c.replies, c.reblogs, c.favourites, CASE WHEN typeof(statuses.reblogs_count) <> 'integer' THEN statuses.untrusted_reblogs_count ELSE min(max(statuses.untrusted_reblogs_count + c.reblogs - statuses.reblogs_count, 0), 100000000) END, CASE WHEN typeof(statuses.favourites_count) <> 'integer' THEN statuses.untrusted_favourites_count ELSE min(max(statuses.untrusted_favourites_count + c.favourites - statuses.favourites_count, 0), 100000000) END FROM (SELECT (SELECT COUNT(*) FROM statuses r WHERE r.in_reply_to_id = ?1 AND r.visibility IN ('public', 'unlisted')) AS replies, (SELECT COUNT(*) FROM statuses r INDEXED BY statuses_reblog WHERE r.reblog_of_id = ?1 AND r.reblog_of_id IS NOT NULL AND r.withdrawn = 0) AS reblogs, (SELECT COUNT(*) FROM favourites f WHERE f.status_id = ?1) AS favourites) c) WHERE id = ?1`,
      // Every status's own counts: the rewrite writes main's to the same row, and no other.
      writes: "SELECT id, replies_count, reblogs_count, favourites_count FROM statuses ORDER BY id",
    },
  },
  /^UPDATE statuses SET/,
  [],
);

// Assigning the untrusted counts fires their stored bound's BEFORE UPDATE OF triggers (migration 0114_untrusted_counts),
// with which SQLite writes the row in two passes: it reads the one row it writes once more than main's statement, which
// assigns no guarded column (with the triggers dropped, the rewrite reads no more than main). Splitting the statement
// in two would write those columns all the same and read more.
const ROW_ALLOWANCES = {
  c5c0b8e647a58f86: {
    rows: 1,
    reason: "#1749: the untrusted counts' BEFORE UPDATE OF triggers make the write two-pass over its one row",
  },
};

const VISIBILITIES = ["public", "unlisted", "private", "direct", "limited"];

// The statuses TARGET, BELOW and ABOVE, remote ones with untrusted counts, and `own` replies, boosts and favourites of
// TARGET and `others` of each of BELOW and ABOVE: replies of every visibility, every other boost withdrawn.
function build(sql: SqlStorage, own: number, others: number): void {
  const accounts = Math.max(own, others, 1);
  sql.exec(
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
		INSERT INTO accounts (id, uri, username, domain)
		SELECT CAST(700000000000000000 + i AS TEXT), 'https://remote.example/users/u' || i, 'u' || i, 'remote.example' FROM n`,
    accounts,
  );
  for (const [p, [id, n]] of (
    [
      [BELOW, others],
      [TARGET, own],
      [ABOVE, others],
    ] as const
  ).entries()) {
    sql.exec(
      `INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, favourites_count,
				untrusted_favourites_count, untrusted_reblogs_count)
			VALUES (?1, 'https://remote.example/objects/' || ?1, '700000000000000000', 'public', '<p>hi</p>',
				'2026-10-11T12:00:00.000Z', 'many', 42, 7)`,
      id,
    );
    // Its replies and boosts, after the three statuses' ids.
    let next = 810000000000000000n + BigInt(p) * 1_000_000_000n;
    for (let i = 0; i < n; i++) {
      const account = String(700000000000000000n + BigInt(i));
      sql.exec(
        `INSERT INTO statuses (id, uri, account_id, in_reply_to_id, in_reply_to_uri, visibility, content, published_at)
				VALUES (?1, 'https://remote.example/objects/' || ?1, ?2, ?3, 'https://remote.example/objects/' || ?3, ?4,
					'<p>re</p>', '2026-10-11T12:00:00.000Z')`,
        String(next++),
        account,
        id,
        VISIBILITIES[i % VISIBILITIES.length]!,
      );
      sql.exec(
        `INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, content, published_at, withdrawn)
				VALUES (?1, 'https://remote.example/objects/' || ?1, ?2, ?3, 'public', '', '2026-10-11T12:00:00.000Z', ?4)`,
        String(next++),
        account,
        id,
        i % 2,
      );
      sql.exec("INSERT INTO favourites (account_id, status_id) VALUES (?, ?)", account, id);
    }
  }
}

const counted = (ids: readonly string[]) =>
  `SELECT ${ids
    .map(
      (id) => `(SELECT count(*) FROM statuses WHERE in_reply_to_id = '${id}')
			+ (SELECT count(*) FROM statuses WHERE reblog_of_id = '${id}')
			+ (SELECT count(*) FROM favourites WHERE status_id = '${id}')`,
    )
    .join(" + ")} AS n`;

type Case = { world: (n: number) => [own: number, others: number]; count: string; walks: number };

const FEW = 5;
const MANY = 60;

const CASES: Record<string, Case> = {
  // Its own replies, boosts and favourites, each read once by its index (a reply's row too, for its visibility).
  "its own replies, boosts and favourites": { world: (n) => [n, 3], count: counted([TARGET]), walks: 2 },
  // Other statuses' on both sides of its id: read by none.
  "other statuses' replies, boosts and favourites": {
    world: (n) => [3, n],
    count: counted([BELOW, ABOVE]),
    walks: 0,
  },
};

async function sides(statistics: Statistics, n: number, c: Case): Promise<Run> {
  const store = await migratedStore();
  return runInDurableObject(store, (_instance, state) => {
    build(state.storage.sql, ...c.world(n));
    return WITNESS.measure(state, {
      statistics,
      expected: ["c5c0b8e647a58f86"],
      populations: { grown: c.count },
      run: (sql) => recountStatus(new Db(sql), TARGET),
    });
  });
}

describe("main's recountStatus", () => {
  it("is main's audited statement", async () => {
    await WITNESS.expectAudited();
  });
});

describe("recountStatus beside main's (RES-7)", () => {
  it.each(STATISTICS.flatMap((statistics) => Object.keys(CASES).map((name) => [statistics, name] as const)))(
    "%s statistics: %s",
    async (statistics, name) => {
      const c = CASES[name]!;
      const few = await sides(statistics, FEW, c);
      const many = await sides(statistics, MANY, c);
      for (const run of [few, many]) {
        expectBeside(statistics, run, { singletonRows: true, rowAllowances: ROW_ALLOWANCES });
      }
      expectGrowth(few, many, {
        populations: ["grown"],
        perSide: { "*": { population: "grown", perRun: c.walks } },
      });
    },
    120_000,
  );
});
