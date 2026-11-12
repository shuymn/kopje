import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { bookmarks, favourites, homeTimeline, publicTimeline } from "../src/domain/timelines";
import type { StoreStub } from "../src/platform/store-client";
import type { StoreOperation } from "../src/platform/store-kernel";
import { NOW } from "./app-helpers";
import { migratedStore } from "./helpers";
import { singletonStatistics } from "./plan-audit-store";
import { rowsRead } from "./read-helpers";

// RES-7 witnesses of the timeline reads (timelines.ts), under the plan audit's singleton statistics and under ANALYZE
// of the Store as read: home (its exclusive lists and mention streams included), bookmarks, favourites and the public
// timelines read the same rows however much of what they never show grows: older statuses of accounts the viewer does
// not follow, other owners' lists and members, other accounts' bookmarks and favourites.

const VIEWER = "600000000000000001";
const OTHER = "600000000000000002";
const FOLLOWED = 610000000000000000n;
const PRESENT = { origin: "https://kopje.test" };
const credential = { tokenHash: "viewer", scope: "read", now: NOW } as const;
const STATISTICS = ["singleton", "analyzed"] as const;
const READS: [string, StoreOperation<never, unknown>, Record<string, unknown>][] = [
  ["home", homeTimeline, {}],
  ["bookmarks", bookmarks, {}],
  ["favourites", favourites, {}],
  ["public", publicTimeline, { local: false, remote: false, onlyMedia: false }],
  ["public local", publicTimeline, { local: true, remote: false, onlyMedia: false }],
  ["public remote", publicTimeline, { local: false, remote: true, onlyMedia: false }],
];

// The viewer's world: 100 public statuses of its own, 50 followed remote accounts of 20 public statuses
// each, five of them members of the
// viewer's exclusive list, a direct status of each mentioning the viewer, 30 bookmarks and favourites; then `grown`
// older public statuses of accounts nobody follows, as many bookmarks and favourites of another account, as many
// lists of that account with members, as many newer public statuses of other accounts nobody follows, and as many
// members of the viewer's exclusive list it does not follow (as an import may hold them).
async function world(grown: number): Promise<StoreStub> {
  const store = await migratedStore();
  await runInDurableObject(store, (_instance, state) => {
    const sql = state.storage.sql;
    for (const [id, name] of [
      [VIEWER, "viewer"],
      [OTHER, "other"],
    ]) {
      sql.exec(
        "INSERT INTO accounts (id, uri, username) VALUES (?, ?, ?)",
        id,
        `https://kopje.test/ap/users/${name}`,
        name,
      );
      sql.exec(
        `INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, ?, X'00', X'00', 'k')`,
        id,
        `${name}@example.com`,
      );
    }
    sql.exec(
      "INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('app', 's', 'app', 'urn:ietf:wg:oauth:2.0:oob', 'read')",
    );
    sql.exec(
      "INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES ('viewer', 'access', 'app', ?, 'read')",
      VIEWER,
    );
    const at = new Date(NOW).toISOString();
    // Followed accounts and their statuses, the newest of the Store (ids from 9…).
    sql.exec(
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 49)
			INSERT INTO accounts (id, uri, username, domain) SELECT CAST(?1 + i AS TEXT), 'https://f.example/u' || i, 'f' || i,
				'f.example' FROM n`,
      String(FOLLOWED),
    );
    sql.exec(
      "INSERT INTO follows (account_id, target_account_id, state) SELECT ?, id, 'accepted' FROM accounts WHERE id GLOB '61*'",
      VIEWER,
    );
    sql.exec(
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 999)
			INSERT INTO statuses (id, uri, account_id, visibility, published_at)
			SELECT CAST(900000000000000000 + i AS TEXT), 'https://f.example/s' || i, CAST(?1 + i % 50 AS TEXT), 'public', ?2 FROM n`,
      String(FOLLOWED),
      at,
    );
    // The viewer's own public statuses, the newest: the local timeline's.
    sql.exec(
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 99)
			INSERT INTO statuses (id, uri, account_id, visibility, published_at)
			SELECT CAST(920000000000000000 + i AS TEXT), 'https://kopje.test/ap/o/v' || i, ?1, 'public', ?2 FROM n`,
      VIEWER,
      at,
    );
    sql.exec(
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 49)
			INSERT INTO statuses (id, uri, account_id, visibility, published_at)
			SELECT CAST(910000000000000000 + i AS TEXT), 'https://f.example/d' || i, CAST(?1 + i AS TEXT), 'direct', ?2 FROM n`,
      String(FOLLOWED),
      at,
    );
    sql.exec(
      `INSERT INTO status_mentions (status_id, account_id, author_id, requires_mention)
			SELECT id, ?, account_id, 1 FROM statuses WHERE visibility = 'direct'`,
      VIEWER,
    );
    sql.exec(
      "INSERT INTO lists (id, account_id, title, exclusive) VALUES ('620000000000000000', ?, 'close', 1)",
      VIEWER,
    );
    sql.exec(
      `INSERT INTO list_accounts (list_id, account_id)
			SELECT '620000000000000000', id FROM accounts WHERE id GLOB '61*' ORDER BY id LIMIT 5`,
    );
    for (const table of ["bookmarks", "favourites"]) {
      sql.exec(
        `INSERT INTO ${table} (account_id, status_id) SELECT ?, id FROM statuses WHERE id GLOB '90*' ORDER BY id DESC LIMIT 30`,
        VIEWER,
      );
    }
    // What the reads never show: older statuses of accounts nobody follows, another account's edges and lists.
    if (grown > 0) {
      sql.exec(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 99)
				INSERT INTO accounts (id, uri, username, domain) SELECT CAST(630000000000000000 + i AS TEXT),
					'https://g.example/u' || i, 'g' || i, 'g.example' FROM n`,
      );
      sql.exec(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO statuses (id, uri, account_id, visibility, published_at)
				SELECT CAST(800000000000000000 + i AS TEXT), 'https://g.example/s' || i, CAST(630000000000000000 + i % 100 AS TEXT),
					'public', ?2 FROM n`,
        grown,
        at,
      );
      for (const table of ["bookmarks", "favourites"]) {
        sql.exec(`INSERT INTO ${table} (account_id, status_id) SELECT ?, id FROM statuses WHERE id GLOB '8*'`, OTHER);
      }
      sql.exec(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 / 100 - 1)
				INSERT INTO lists (id, account_id, title, exclusive) SELECT CAST(640000000000000000 + i AS TEXT), ?2, 'l' || i, 1 FROM n`,
        grown,
        OTHER,
      );
      sql.exec(
        `INSERT INTO list_accounts (list_id, account_id) SELECT l.id, a.id FROM lists l, accounts a
				WHERE l.account_id = ? AND a.id GLOB '63*'`,
        OTHER,
      );
      // Newer public statuses of `grown` / 10 accounts nobody follows, above everything the viewer's world holds.
      sql.exec(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 / 10 - 1)
				INSERT INTO accounts (id, uri, username, domain) SELECT CAST(650000000000000000 + i AS TEXT),
					'https://n.example/u' || i, 'n' || i, 'n.example' FROM n`,
        grown,
      );
      sql.exec(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO statuses (id, uri, account_id, visibility, published_at)
				SELECT CAST(950000000000000000 + i AS TEXT), 'https://n.example/s' || i,
					CAST(650000000000000000 + i % CAST(?1 / 10 AS INTEGER) AS TEXT), 'public', ?2 FROM n`,
        grown,
        at,
      );
      // The viewer's exclusive list as an import may hold it: `grown` members the viewer does not follow.
      sql.exec(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO accounts (id, uri, username, domain) SELECT CAST(660000000000000000 + i AS TEXT),
					'https://m.example/u' || i, 'm' || i, 'm.example' FROM n`,
        grown,
      );
      sql.exec(
        "INSERT INTO list_accounts (list_id, account_id) SELECT '620000000000000000', id FROM accounts WHERE id GLOB '66*'",
      );
    }
  });
  return store;
}

async function rowsOf(statistics: (typeof STATISTICS)[number], grown: number) {
  const store = await world(grown);
  await runInDurableObject(store, (_instance, state) =>
    statistics === "singleton" ? singletonStatistics(state.storage.sql) : state.storage.sql.exec("ANALYZE"),
  );
  const rows: Record<string, number> = {};
  for (const [name, operation, extra] of READS) {
    rows[name] = await rowsRead({ store }, operation, {
      credential,
      now: NOW,
      present: PRESENT,
      page: { limit: 20 },
      ...extra,
    } as never);
  }
  return rows;
}

describe("timeline reads with grown neighbours (RES-7)", () => {
  it.each(STATISTICS)(
    "read the same rows as what they never show grows to 20,000 (%s statistics)",
    async (statistics) => {
      const few = await rowsOf(statistics, 2_000);
      const many = await rowsOf(statistics, 20_000);
      // The local timeline keeps its join to the author (timelines.ts publicTimeline): real statistics enter it from the
      // local accounts, but singleton ones walk the public statuses, the listed gap of #1481 (no index holds the local
      // public statuses).
      if (statistics === "singleton") {
        expect(many["public local"]).toBeGreaterThan(few["public local"]!);
        delete many["public local"];
        delete few["public local"];
      }
      expect(many).toEqual(few);
    },
    180_000,
  );
});
