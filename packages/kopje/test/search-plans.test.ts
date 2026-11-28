import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { search, type SearchRequest, type SearchType } from "../src/domain/search";
import { NOW } from "./app-helpers";
import { migratedStore } from "./helpers";
import { HIGH, LOW, seedViewerBetween, VIEWER } from "./plan-accounts";
import { statementId } from "./plan-audit";
import { singletonStatistics } from "./plan-audit-store";
import { observedSql, type PlannedStatement, plannedSql } from "./read-helpers";
import { normalized } from "./sql-text";

// RES-7 witness of the library windows pinned to the index each walks (#1564, D7: LIBRARY in src/domain/search.ts):
// the status search of the viewer's library, the status search of the viewer's own account_id (the author window
// alone), and the hashtag search's library windows. Each production statement names every pin its windows take; with
// the pins taken out it is main's audited statement (by its identity, origin/main 2ab78dd60), and run beside it with
// the same parameters it returns the same rows and reads no more, under the plan audit's singleton statistics and
// after ANALYZE, taken once every population exists. The viewer's own key (its statuses, boosts, favourites, bookmarks
// and mentions) grows in a world small enough that it dominates the statistics, and so do the same rows of the
// accounts on either side of it; each is counted by its own predicate and asserted to grow. Import-shaped rows: one
// status in several sources at once, a silent mention (a recipient the API does not show), and search text with NUL;
// ids are unique, so the order has no ties.

const PINNED = {
  own: " INDEXED BY statuses_account_originals",
  favourites: " INDEXED BY favourites_account_status",
  bookmarks: " INDEXED BY bookmarks_account_status",
  mentions: " INDEXED BY status_mentions_account",
};

// Each flow: main's statement identity, the pins its windows take, and its request.
const FLOWS = {
  library: {
    main: "dd53b3f60380a2ba",
    pins: [PINNED.own, PINNED.favourites, PINNED.bookmarks, PINNED.mentions],
    request: { query: "needle", types: ["statuses"] as SearchType[] },
  },
  self: {
    main: "d8cad5513e49a3e5",
    pins: [PINNED.own],
    request: { query: "needle", types: ["statuses"] as SearchType[], accountId: VIEWER },
  },
  hashtags: {
    main: "29d9fa4322758555",
    pins: [PINNED.own, PINNED.favourites, PINNED.bookmarks],
    request: { query: "nee", types: ["hashtags"] as SearchType[] },
  },
} satisfies Record<
  string,
  { main: string; pins: string[]; request: Pick<SearchRequest, "query" | "types" | "accountId"> }
>;
type Flow = keyof typeof FLOWS;

// The production statement without `pins`, each taken out once: main's statement (whose hashtag statement also kept
// the space its empty mention term left).
const unpinned = (text: string, pins: readonly string[]) =>
  normalized(pins.reduce((sql, pin) => sql.replace(pin, ""), normalized(text))).replace(
    "LIMIT ?4)), public(id)",
    "LIMIT ?4) ), public(id)",
  );

type Shape = { own: number; library: number; others: number };
const BASE: Shape = { own: 40, library: 40, others: 40 };

let next = 100000000000000000n;
function status(sql: SqlStorage, account: string, text: string, extra: { reblogOf?: string; tag?: string } = {}) {
  const id = String(next++);
  sql.exec(
    `INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, content, published_at, search_text)
		VALUES (?, ?, ?, ?, 'public', ?, '2026-10-12T00:00:00.000Z', ?)`,
    id,
    `https://kopje.test/ap/o/${id}`,
    account,
    extra.reblogOf ?? null,
    extra.reblogOf === undefined ? `<p>${text}</p>` : "",
    extra.reblogOf === undefined ? text : null,
  );
  if (extra.tag !== undefined) {
    sql.exec("INSERT INTO status_tags (status_id, name, public) VALUES (?, ?, 1)", id, extra.tag);
  }
  return id;
}

function shaped(sql: SqlStorage, shape: Shape) {
  next = 100000000000000000n;
  seedViewerBetween(sql);
  for (let i = 0; i < shape.own; i++) {
    status(sql, VIEWER, i % 5 === 0 ? `needle own ${i}` : `own ${i}`, { tag: `nee${i % 3}` });
  }
  for (let i = 0; i < shape.library; i++) {
    const target = status(sql, HIGH, i % 4 === 0 ? `needle\u0000nul ${i}` : `needle ${i}`, { tag: `nee${i % 4}` });
    // One status in several sources at once.
    if (i % 5 !== 1) {
      sql.exec("INSERT INTO favourites (account_id, status_id) VALUES (?, ?)", VIEWER, target);
    }
    if (i % 5 !== 2) {
      sql.exec("INSERT INTO bookmarks (account_id, status_id) VALUES (?, ?)", VIEWER, target);
    }
    if (i % 5 === 3) {
      status(sql, VIEWER, "", { reblogOf: target });
    }
    if (i % 5 === 4) {
      sql.exec("INSERT INTO status_mentions (status_id, account_id, silent) VALUES (?, ?, ?)", target, VIEWER, i % 2);
    }
  }
  for (let i = 0; i < shape.others; i++) {
    for (const [author, saver] of [
      [LOW, HIGH],
      [HIGH, LOW],
    ] as const) {
      const target = status(sql, author, `needle other ${i}`, { tag: `nee${i % 5}` });
      sql.exec("INSERT INTO favourites (account_id, status_id) VALUES (?, ?)", saver, target);
      sql.exec("INSERT INTO bookmarks (account_id, status_id) VALUES (?, ?)", saver, target);
      sql.exec("INSERT INTO status_mentions (status_id, account_id) VALUES (?, ?)", target, saver);
      status(sql, saver, "", { reblogOf: target });
    }
  }
}

const POPULATIONS = Object.fromEntries(
  (
    [
      ["own", `= '${VIEWER}'`],
      ["sides", `IN ('${LOW}', '${HIGH}')`],
    ] as const
  ).map(([name, accounts]) => [
    name,
    `SELECT ${["statuses", "favourites", "bookmarks", "status_mentions"]
      .map((table) => `(SELECT count(*) FROM ${table} WHERE account_id ${accounts})`)
      .join(" + ")} AS n`,
  ]),
);

type Side = { rows: unknown[]; read: number };
type Measured = { main: string; pins: string[]; mine: Side; base: Side; populations: Record<string, number> };

// The statement each flow witnesses.
const STATEMENT = /^WITH (?:candidates|library)\(id\)/;

// The flow's production statement and main's beside it, on a world of `shape` under `statistics`.
async function measured(statistics: "singleton" | "analyzed", flow: Flow, shape: Shape): Promise<Measured> {
  const store = await migratedStore();
  return runInDurableObject(store, (_instance, state) => {
    const sql = state.storage.sql;
    shaped(sql, shape);
    const populations = Object.fromEntries(
      Object.entries(POPULATIONS).map(([name, count]) => [name, sql.exec<{ n: number }>(count).one().n]),
    );
    if (statistics === "singleton") {
      singletonStatistics(sql);
    } else {
      sql.exec("ANALYZE");
    }
    const plans: PlannedStatement[] = [];
    let rows: unknown[] = [];
    const observed = observedSql(sql, (seen, query) => {
      if (STATEMENT.test(query)) {
        rows = [...seen];
      }
    });
    const result = search.run(
      plannedSql(observed, STATEMENT, plans),
      {
        credential: { tokenHash: "viewer", scope: "read:search", now: NOW },
        ...FLOWS[flow].request,
        limit: 40,
        offset: 0,
        following: false,
        localDomain: "kopje.test",
        present: { origin: "https://kopje.test" },
      },
      (fn) => state.storage.transactionSync(fn),
    );
    expect(result.status).toBe("ok");
    expect(plans).toHaveLength(1);
    const { query, params, rows: read } = plans[0]!;
    const main = unpinned(query, FLOWS[flow].pins);
    const cursor = sql.exec(main, ...params);
    const mainRows = cursor.toArray();
    const pins = FLOWS[flow].pins.filter((pin) => query.includes(pin));
    return { main, pins, mine: { rows, read }, base: { rows: mainRows, read: cursor.rowsRead }, populations };
  });
}

// Each growth, and the rows a flow's statement may read more per row its population gains (main's as well): each
// window row of the viewer's, its status by key with listableSql's seeks, and for hashtags each status's tags; the
// accounts on either side reach only the hashtag search's public window (the newest HASHTAG_PUBLIC_WINDOW public
// statuses, theirs included), so the status searches read no more as they grow.
const GROWTHS: Record<string, { shape: Shape; population: string; walks: Record<Flow, number> }> = {
  "the viewer's library": {
    shape: { ...BASE, own: 400, library: 400 },
    population: "own",
    walks: { library: 4, self: 1, hashtags: 7 },
  },
  "the accounts on either side": {
    shape: { ...BASE, others: 400 },
    population: "sides",
    walks: { library: 0, self: 0, hashtags: 2 },
  },
};

describe("the library windows beside main's (RES-7)", () => {
  it.each(
    (["singleton", "analyzed"] as const).flatMap((statistics) =>
      (Object.keys(FLOWS) as Flow[]).flatMap((flow) =>
        Object.keys(GROWTHS).map((name) => [statistics, flow, name] as const),
      ),
    ),
  )(
    "%s statistics, %s: %s",
    async (statistics, flow, name) => {
      const growth = GROWTHS[name]!;
      const runs = [await measured(statistics, flow, BASE), await measured(statistics, flow, growth.shape)];
      const [before, after] = runs as [Measured, Measured];
      const gained = after.populations[growth.population]! - before.populations[growth.population]!;
      expect(gained).toBeGreaterThan(0);
      for (const run of runs) {
        expect(run.pins).toEqual(FLOWS[flow].pins);
        expect(await statementId(run.main)).toBe(FLOWS[flow].main);
        expect(run.mine.rows.length).toBeGreaterThan(0);
        expect(run.mine.rows).toEqual(run.base.rows);
        expect(run.mine.read).toBeLessThanOrEqual(run.base.read);
      }
      // The rewrite's reads grow by at most its walks per row gained, and not at all with the other keys.
      const grew = after.mine.read - before.mine.read;
      expect(grew).toBeGreaterThanOrEqual(0);
      expect(grew).toBeLessThanOrEqual(growth.walks[flow] * gained);
    },
    300_000,
  );
});
