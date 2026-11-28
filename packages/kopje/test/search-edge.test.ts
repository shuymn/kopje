import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { ACCOUNT_PREFIX_LIMIT, ACCOUNT_RECENT_LIMIT, searchAccounts } from "../src/domain/accounts";
import type { Authorized } from "../src/domain/auth";
import {
  HASHTAG_LIBRARY_LIMIT,
  HASHTAG_PUBLIC_WINDOW,
  LIBRARY_SOURCE_LIMIT,
  search,
  type SearchRequest,
  type SearchType,
} from "../src/domain/search";
import type { StoreOperation } from "../src/platform/store-kernel";
import { MAX_TREND_REVIEWS } from "../src/platform/stored-bounds";
import { sha256Hex } from "../src/security/tokens";
import { sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { type PlannedStatement, plannedSql, scansOf, staleStatistics, watchedCursor } from "./read-helpers";
import {
  fillerStatuses,
  type SearchHarness,
  searchFixture as fixture,
  type SearchResults as Results,
} from "./search-helpers";
import { act, post, seedStatus } from "./status-helpers";

// Search bounds: cursors that reach past each library source's window, work that stays bounded as the
// collections grow (RES-7), and hashtags whose visibility hidden statuses cannot change (VIS-1).

describe("library cursors reach past each source window", () => {
  for (const source of ["favourites", "bookmarks", "boosts"] as const) {
    it(`pages to an old ${source} entry with max_id`, async () => {
      const { h, search } = await fixture();
      const { alice, bob } = h.users;
      const old = await post(h, bob, { status: "deep treasure" });
      const action = { favourites: "favourite", bookmarks: "bookmark", boosts: "reblog" }[source];
      await act(h, alice, `/api/v1/statuses/${old.id}/${action}`);
      // Newer entries of the same kind than the window holds, all of newer statuses.
      const count = LIBRARY_SOURCE_LIMIT + 100;
      await fillerStatuses(h, bob.id, count, 300000000000000000n);
      if (source === "boosts") {
        await sql(
          h.store,
          `INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, published_at)
					SELECT CAST(CAST(id AS INTEGER) + 100000000000000000 AS TEXT), uri || '/boost', ?, id, 'public', published_at
					FROM statuses WHERE account_id = ? AND id >= '300000000000000000'`,
          alice.id,
          bob.id,
        );
      } else {
        await sql(
          h.store,
          `INSERT INTO ${source} (account_id, status_id) SELECT ?, id FROM statuses WHERE id >= '300000000000000000' ORDER BY id`,
          alice.id,
        );
      }
      const page = await search("deep", `&type=statuses&max_id=${BigInt(old.id) + 1n}`);
      expect(page.statuses.map((s) => s.id)).toEqual([old.id]);
    });
  }
});

// A status search with account_id of another account (#1564, D7): a status the viewer's own interactions nominate is a
// candidate though it is past the account's newest originals, and the vote window's cursors apply outside its LIMIT.
describe("account_id candidates reach past the account's window", () => {
  // `count` public statuses by bob matching "filler", the oldest first; carol is the viewer.
  async function scoped(count: number) {
    const { h, search } = await fixture();
    const { bob, carol } = h.users;
    await fillerStatuses(h, bob.id, count, 300000000000000000n);
    const id = (i: number) => String(300000000000000000n + BigInt(i));
    const poll = async (i: number) => {
      await sql(h.store, `INSERT INTO polls (status_id, options, tallies) VALUES (?, '["a","b"]', '[0,0]')`, id(i));
      await sql(h.store, "INSERT INTO poll_votes (poll_id, account_id, choice) VALUES (?, ?, 0)", id(i), carol.id);
    };
    const ids = async (extra = "") =>
      (await search("filler", `&type=statuses&account_id=${bob.id}${extra}`, carol.token)).statuses.map((s) => s.id);
    return { h, id, poll, ids };
  }

  it("returns the one status the viewer favourited or voted in, past the account's newest 2,500 (P6.5)", async () => {
    const { h, id, poll, ids } = await scoped(LIBRARY_SOURCE_LIMIT + 1);
    const { carol } = h.users;
    expect(await ids()).toEqual([]);
    await sql(h.store, "INSERT INTO favourites (account_id, status_id) VALUES (?, ?)", carol.id, id(0));
    expect(await ids()).toEqual([id(0)]);
    await sql(h.store, "DELETE FROM favourites WHERE account_id = ?", carol.id);
    expect(await ids()).toEqual([]);
    await poll(0);
    expect(await ids()).toEqual([id(0)]);
  }, 60_000);

  it("applies max_id and min_id to the polls of the viewer's votes", async () => {
    const { id, poll, ids } = await scoped(LIBRARY_SOURCE_LIMIT + 1);
    // Votes in three polls of bob's, V1 < V2 < V3, V1 past his newest 2,500.
    for (const i of [0, 1, 2]) {
      await poll(i);
    }
    expect(await ids(`&max_id=${id(1)}`)).toEqual([id(0)]);
    expect(await ids(`&min_id=${id(1)}`)).toEqual([id(2)]);
    expect(await ids(`&max_id=${BigInt(id(0)) - 1n}`)).toEqual([]);
    // The control: without a cursor, all three.
    expect(await ids()).toEqual([id(2), id(1), id(0)]);
  }, 60_000);

  // The vote window is the viewer's newest LIBRARY_SOURCE_LIMIT vote rows, and the id bounds apply after it (A7): a
  // vote older than that many newer votes is not a candidate of a request whose bounds leave the newer ones out.
  it("takes the viewer's newest votes before max_id applies", async () => {
    const { h, id, poll, ids } = await scoped(LIBRARY_SOURCE_LIMIT + 1);
    const { alice, carol } = h.users;
    // carol votes in bob's oldest status (past his newest 2,500), then in LIBRARY_SOURCE_LIMIT polls of alice's
    // statuses, all above bob's.
    await poll(0);
    await fillerStatuses(h, alice.id, LIBRARY_SOURCE_LIMIT, 400000000000000000n);
    await sql(
      h.store,
      `INSERT INTO polls (status_id, options, tallies) SELECT id, '["a","b"]', '[0,0]' FROM statuses WHERE account_id = ?`,
      alice.id,
    );
    await sql(
      h.store,
      "INSERT INTO poll_votes (poll_id, account_id, choice) SELECT id, ?, 0 FROM statuses WHERE account_id = ? ORDER BY id",
      carol.id,
      alice.id,
    );
    const below = "&max_id=400000000000000000";
    expect(await ids(below)).toEqual([]);
    // The control: with one of the newer votes gone, the oldest is within the window and found.
    await sql(h.store, "DELETE FROM poll_votes WHERE poll_id = '400000000000000000' AND account_id = ?", carol.id);
    expect(await ids(below)).toEqual([id(0)]);
  }, 60_000);
});

// Runs the search operation over a SqlStorage that counts the rows each statement reads.
async function rowsRead(
  h: SearchHarness,
  token: string,
  {
    followingOnly = false,
    ...input
  }: Omit<SearchRequest, "present" | "localDomain" | "limit" | "offset" | "following"> & {
    followingOnly?: boolean;
  },
): Promise<number> {
  const tokenHash = await sha256Hex(token);
  return runInDurableObject(h.store, (_instance, state) => {
    let read = 0;
    const real = state.storage.sql;
    const counting = {
      exec: (query: string, ...params: SqlStorageValue[]) => {
        const cursor = real.exec(query, ...params);
        return watchedCursor(cursor, () => (read += cursor.rowsRead));
      },
    } as unknown as SqlStorage;
    const result = search.run(counting, {
      credential: { tokenHash, scope: "read:search", now: NOW },
      limit: 20,
      offset: 0,
      following: followingOnly,
      localDomain: "kopje.test",
      present: { origin: "https://kopje.test" },
      ...input,
    });
    if (result.status !== "ok") {
      throw new Error(`search failed: ${result.status}`);
    }
    return read;
  });
}

describe("search work is bounded (RES-7)", () => {
  async function library(kind: "favourites" | "bookmarks", size: number) {
    const { h } = await fixture();
    const { alice, bob } = h.users;
    await fillerStatuses(h, bob.id, size, 300000000000000000n);
    await sql(
      h.store,
      `INSERT INTO ${kind} (account_id, status_id) SELECT ?, id FROM statuses WHERE id >= '300000000000000000' ORDER BY random()`,
      alice.id,
    );
    return rowsRead(h, alice.token, { query: "nothing", types: ["statuses"] });
  }

  for (const kind of ["favourites", "bookmarks"] as const) {
    it(`reads about as many rows for ${kind} four times as large`, async () => {
      const small = await library(kind, 3000);
      const large = await library(kind, 12000);
      expect(large).toBeLessThan(small * 1.5);
    }, 60_000);
  }

  async function accounts(size: number) {
    const { h } = await fixture();
    await sql(
      h.store,
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ? - 1)
			INSERT INTO accounts (id, uri, username, domain, search_text)
			SELECT CAST(500000000000000000 + i AS TEXT), 'https://many.example/users/u' || i, 'u' || i, 'many.example',
				'someone u' || i || '@many.example'
			FROM n`,
      size,
    );
    return rowsRead(h, h.users.alice.token, { query: "nobody", types: ["accounts"] });
  }

  it("reads about as many rows for four times as many known accounts", async () => {
    const small = await accounts(6000);
    const large = await accounts(24000);
    expect(large).toBeLessThan(small * 1.5);
  }, 60_000);

  it("reads about as many rows for hashtags with four times as many statuses", async () => {
    const measure = async (size: number) => {
      const { h } = await fixture();
      await fillerStatuses(h, h.users.bob.id, size, 300000000000000000n, { tag: "common" });
      return rowsRead(h, h.users.alice.token, { query: "comm", types: ["hashtags"] });
    };
    const small = await measure(3000);
    const large = await measure(12000);
    expect(large).toBeLessThan(small * 1.5);
  }, 60_000);
});

describe("hashtag results do not depend on hidden statuses (VIS-1)", () => {
  it("keeps a public hashtag when many newer hidden statuses use it", async () => {
    const { h, search } = await fixture();
    const { bob } = h.users;
    await post(h, bob, { status: "#apple pie" });
    await fillerStatuses(h, bob.id, 80, 300000000000000000n, { visibility: "private", tag: "apple" });
    expect((await search("apple", "&type=hashtags")).hashtags.map((t) => t.name)).toEqual(["apple"]);
  });

  it("is not crowded out by names that only hidden statuses use", async () => {
    const { h, search } = await fixture();
    const { bob, carol } = h.users;
    for (let i = 0; i < 120; i++) {
      await seedStatus(h.store, {
        accountId: bob.id,
        visibility: "direct",
        content: "<p>x</p>",
        mentions: [{ accountId: carol.id }],
        tags: [`a${String(i).padStart(3, "0")}`],
      });
    }
    await post(h, bob, { status: "#azz visible" });
    expect((await search("a", "&type=hashtags")).hashtags.map((t) => t.name)).toEqual(["azz"]);
  });
});

describe("verification review", () => {
  // `count` remote accounts named `username` (or u<i>) on their own domains, ids from `base` up.
  async function remoteAccounts(h: SearchHarness, count: number, base: bigint, username?: string) {
    await sql(
      h.store,
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ? - 1)
			INSERT INTO accounts (id, uri, username, domain, search_text)
			SELECT CAST(? + i AS TEXT), 'https://d' || ? || '-' || i || '.example/users/x', IFNULL(?, 'u' || i),
				'd' || ? || '-' || i || '.example', IFNULL(?, 'u' || i) || '@d' || ? || '-' || i || '.example'
			FROM n`,
      count,
      String(base),
      String(base),
      username ?? null,
      String(base),
      username ?? null,
      String(base),
    );
  }

  it("finds an exact known address outside both discovery windows", async () => {
    const { h, search } = await fixture();
    await remoteAccounts(h, 1100, 500000000000000000n, "alice");
    const target = await sql<{ id: string }>(
      h.store,
      `INSERT INTO accounts (id, uri, username, domain, search_text)
			VALUES ('600000000000000000', 'https://target.example/users/alice', 'alice', 'target.example', 'alice@target.example')
			RETURNING id`,
    );
    await remoteAccounts(h, 5100, 700000000000000000n);
    const found = await search("alice@target.example", "&type=accounts");
    expect(found.accounts.map((a) => a.id)).toEqual([target[0]?.id]);
  }, 60_000);

  it("finds an exact followed address beyond the following window", async () => {
    const { h, search } = await fixture();
    const { alice } = h.users;
    await remoteAccounts(h, 5100, 500000000000000000n);
    await sql(
      h.store,
      `INSERT INTO accounts (id, uri, username, domain, search_text)
			VALUES ('900000000000000000', 'https://far.example/users/zed', 'zed', 'far.example', 'zed@far.example')`,
    );
    await sql(
      h.store,
      `INSERT INTO follows (account_id, target_account_id, state) SELECT ?, id, 'accepted' FROM accounts WHERE domain IS NOT NULL`,
      alice.id,
    );
    const found = await search("zed@far.example", "&type=accounts&following=true");
    expect(found.accounts.map((a) => a.id)).toEqual(["900000000000000000"]);
  }, 60_000);

  it("reads about as many rows for a matching username prefix four times as common", async () => {
    const measure = async (size: number) => {
      const { h } = await fixture();
      await remoteAccounts(h, size, 500000000000000000n);
      return rowsRead(h, h.users.alice.token, { query: "u", types: ["accounts"] });
    };
    const small = await measure(6000);
    const large = await measure(24000);
    expect(large).toBeLessThan(small * 1.5);
  }, 60_000);

  it("reads about as many rows for following=true with four times as many pending follows", async () => {
    const measure = async (size: number) => {
      const { h } = await fixture();
      await remoteAccounts(h, size, 500000000000000000n);
      await sql(
        h.store,
        `INSERT INTO follows (account_id, target_account_id, state) SELECT ?, id, 'pending' FROM accounts WHERE domain IS NOT NULL`,
        h.users.alice.id,
      );
      return runFollowing(h);
    };
    const runFollowing = (h: SearchHarness) =>
      rowsRead(h, h.users.alice.token, { query: "nobody", types: ["accounts"], followingOnly: true });
    const small = await measure(4000);
    const large = await measure(16000);
    expect(large).toBeLessThan(small * 1.5);
  }, 60_000);

  it("compares search cursors as numbers", async () => {
    const { h, search } = await fixture();
    const status = await post(h, h.users.alice, { status: "cursor probe" });
    expect((await search("cursor", "&type=statuses&min_id=9")).statuses.map((s) => s.id)).toEqual([status.id]);
    expect((await search("cursor", `&type=statuses&max_id=${"9".repeat(19)}`)).statuses.map((s) => s.id)).toEqual([
      status.id,
    ]);
  });

  it("keeps hashtag results the same when hidden mentions crowd the library (VIS-1)", async () => {
    const { h, search } = await fixture();
    const { alice, bob, carol } = h.users;
    await post(h, carol, { status: "@alice #needle unlisted", visibility: "unlisted" });
    const before = (await search("needle", "&type=hashtags")).hashtags.map((t) => t.name);
    await sql(h.store, "INSERT INTO blocks (account_id, target_account_id) VALUES (?, ?)", bob.id, alice.id);
    for (let i = 0; i < 520; i++) {
      await seedStatus(h.store, {
        accountId: bob.id,
        visibility: "private",
        content: "<p>x</p>",
        mentions: [{ accountId: alice.id }],
      });
    }
    expect((await search("needle", "&type=hashtags")).hashtags.map((t) => t.name)).toEqual(before);
  }, 60_000);
});

// `operation` over `h`'s Store with `input` and alice's credential of `scope`, its results, and the plan and rows read
// of each statement whose SQL matches `pattern` (EXPLAIN QUERY PLAN of the production statement with its parameters).
async function plannedOperation<I, O>(
  h: SearchHarness,
  pattern: RegExp,
  operation: StoreOperation<I, Authorized<O>>,
  scope: string,
  input: Omit<I, "credential" | "present" | "localDomain" | "limit" | "offset"> & { limit?: number; offset?: number },
) {
  const tokenHash = await sha256Hex(h.users.alice.token);
  return runInDurableObject(h.store, (_instance, state) => {
    const plans: PlannedStatement[] = [];
    const capturing = plannedSql(state.storage.sql, pattern, plans, false);
    const result = operation.run(capturing, {
      credential: { tokenHash, scope, now: NOW },
      limit: 20,
      offset: 0,
      localDomain: "kopje.test",
      present: { origin: "https://kopje.test" },
      ...input,
    } as I);
    if (result.status !== "ok") {
      throw new Error(`search failed: ${result.status}`);
    }
    return { value: result.value, plans };
  });
}

// The search operation (GET /api/v2/search).
async function planned(
  h: SearchHarness,
  pattern: RegExp,
  input: Omit<SearchRequest, "credential" | "present" | "localDomain" | "limit" | "offset"> & {
    limit?: number;
    offset?: number;
  },
) {
  const { value, plans } = await plannedOperation(h, pattern, search, "read:search", input);
  return { value: value as Results, plans };
}

describe("exclude_unreviewed and following at saturation (RES-7)", () => {
  it("probes the reviews by name for each candidate, before the page, with stale statistics", async () => {
    const { h } = await fixture();
    const { alice, bob } = h.users;
    await post(h, bob, { status: "#catseed" });
    // Statistics of a small Store, not taken again after it grows.
    await sql(h.store, "ANALYZE");
    // Every window full: bob's public statuses past the public window, alice's own statuses, favourites, bookmarks
    // and boosts past the library window, each status with a hashtag of its own.
    const count = HASHTAG_PUBLIC_WINDOW + 100;
    await fillerStatuses(h, bob.id, count, 300000000000000000n);
    await fillerStatuses(h, alice.id, HASHTAG_LIBRARY_LIMIT + 50, 400000000000000000n);
    for (const table of ["favourites", "bookmarks"]) {
      await sql(
        h.store,
        `INSERT INTO ${table} (account_id, status_id)
				SELECT ?, id FROM statuses WHERE account_id = ? AND id >= '300000000000000000' ORDER BY id LIMIT ?`,
        alice.id,
        bob.id,
        HASHTAG_LIBRARY_LIMIT + 50,
      );
    }
    await sql(
      h.store,
      `INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, published_at)
			SELECT CAST(CAST(id AS INTEGER) + 200000000000000000 AS TEXT), uri || '/boost', ?, id, 'public', published_at
			FROM statuses WHERE account_id = ? AND id >= '300000000000000000' ORDER BY id DESC LIMIT ?`,
      alice.id,
      bob.id,
      HASHTAG_LIBRARY_LIMIT + 50,
    );
    await sql(
      h.store,
      `INSERT INTO status_tags (status_id, name)
			SELECT id, 'cat' || (CAST(id AS INTEGER) % 100000) FROM statuses WHERE id >= '300000000000000000'
				AND reblog_of_id IS NULL`,
    );
    // Two names that differ only in bytes that are not UTF-8 (both read into JS as "cat" and U+FFFD); only the first
    // is reviewed, compared in SQL.
    await sql(
      h.store,
      `INSERT INTO status_tags (status_id, name)
			SELECT (SELECT max(id) FROM statuses WHERE account_id = ?1), CAST(b AS TEXT)
			FROM (SELECT x'63617480' AS b UNION ALL SELECT x'63617481')`,
      bob.id,
    );
    // The reviews at their cap (MAX_TREND_REVIEWS): the names of bob's ten newest statuses, the first malformed one,
    // and the rest names no candidate has.
    await sql(
      h.store,
      `INSERT INTO tag_trend_reviews (name, trendable, reviewed_at)
			SELECT t.name, 1, '2026-10-01T00:00:00.000Z' FROM status_tags t
			WHERE t.status_id IN (SELECT id FROM statuses WHERE account_id = ?1 ORDER BY id DESC LIMIT 10)
				AND t.name GLOB 'cat[0-9]*'
			UNION ALL SELECT CAST(x'63617480' AS TEXT), 0, '2026-10-01T00:00:00.000Z'`,
      bob.id,
    );
    await sql(
      h.store,
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < CAST(?1 AS INTEGER) - 1)
			INSERT INTO tag_trend_reviews (name, trendable, reviewed_at)
			SELECT 'other' || i, i % 2, '2026-10-01T00:00:00.000Z' FROM n`,
      MAX_TREND_REVIEWS - 11,
    );
    expect(await sql(h.store, "SELECT count(*) AS n FROM tag_trend_reviews")).toEqual([{ n: MAX_TREND_REVIEWS }]);
    const input = { query: "cat", types: ["hashtags"] as SearchType[], following: false };
    const all = await planned(h, /tag_trend_reviews/, { ...input, excludeUnreviewed: false, limit: 40 });
    const reviewed = await planned(h, /tag_trend_reviews/, { ...input, excludeUnreviewed: true, limit: 40 });
    expect(all.value.hashtags).toHaveLength(40);
    // The reviewed candidates only: ten names and one of the two malformed ones.
    expect(reviewed.value.hashtags).toHaveLength(11);
    expect(reviewed.value.hashtags.filter((t) => t.name === "cat\uFFFD")).toHaveLength(1);
    expect(all.value.hashtags.filter((t) => t.name === "cat\uFFFD")).toHaveLength(2);
    const paged = await planned(h, /tag_trend_reviews/, { ...input, excludeUnreviewed: true, limit: 5, offset: 8 });
    expect(paged.value.hashtags.map((t) => t.name)).toEqual(reviewed.value.hashtags.slice(8).map((t) => t.name));
    for (const run of [all, reviewed]) {
      expect(run.plans).toHaveLength(1);
      const plan = run.plans[0]?.plan ?? [];
      expect(plan).toContain("SEARCH r USING PRIMARY KEY (name=?)");
      // Each candidate's status is looked up by id, inside the candidates: with these statistics SQLite otherwise
      // scans statuses once per candidate (about 30 million rows here).
      expect(plan).toContain("SEARCH s USING INDEX sqlite_autoindex_statuses_1 (id=?)");
      expect(plan.filter((detail) => /\bSCAN (r|s|t)\b/.test(detail))).toEqual([]);
    }
    // One probe per candidate hashtag row at most: the windows' statuses, one name each, and the two malformed ones.
    const candidates = HASHTAG_PUBLIC_WINDOW + 4 * HASHTAG_LIBRARY_LIMIT + 2;
    expect((reviewed.plans[0]?.rows ?? 0) - (all.plans[0]?.rows ?? 0)).toBeLessThanOrEqual(candidates);
    expect(reviewed.plans[0]?.rows ?? Infinity).toBeLessThan(10 * candidates);
  }, 120_000);

  // The statement is searchAccountIds', which both account searches run.
  for (const operation of ["search", "searchAccounts"] as const) {
    it(`${operation}: probes the follow of a resolved account through its index, accepted and pending follows present`, async () => {
      const { h } = await fixture();
      const { alice } = h.users;
      await sql(h.store, "ANALYZE");
      await sql(
        h.store,
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 4000 - 1)
				INSERT INTO accounts (id, uri, username, domain, search_text)
				SELECT CAST(500000000000000000 + i AS TEXT), 'https://d' || i || '.example/users/u', 'u', 'd' || i || '.example',
					'u@d' || i || '.example'
				FROM n`,
      );
      await sql(
        h.store,
        `INSERT INTO follows (account_id, target_account_id, state)
				SELECT ?, id, CASE WHEN CAST(id AS INTEGER) % 2 = 0 THEN 'accepted' ELSE 'pending' END FROM accounts
				WHERE domain IS NOT NULL`,
        alice.id,
      );
      const run = async (resolvedAccountId: string, following: boolean) => {
        const input = { query: "zzz-nobody", following, resolvedAccountId };
        if (operation === "search") {
          const { value, plans } = await planned(h, /FROM follows f/, { ...input, types: ["accounts"] });
          return { ids: value.accounts.map((a) => a.id), plans };
        }
        const { value, plans } = await plannedOperation(h, /FROM follows f/, searchAccounts, "read:accounts", input);
        return { ids: value.map((a) => a.id), plans };
      };
      const accepted = await run("500000000000000000", true);
      const pending = await run("500000000000000001", true);
      const unfollowed = await run("500000000000000001", false);
      expect(accepted.ids).toEqual(["500000000000000000"]);
      expect(pending.ids).toEqual([]);
      expect(unfollowed.ids).toEqual(["500000000000000001"]);
      for (const { plans } of [accepted, pending]) {
        expect(plans).toHaveLength(1);
        const plan = plans[0]?.plan ?? [];
        expect(
          plan.some((detail) =>
            /^SEARCH f USING (COVERING )?INDEX follows_\w+ \(account_id=\? AND target_account_id=\?\)$/.test(detail),
          ),
        ).toBe(true);
        expect(plan.filter((detail) => /\bSCAN f\b/.test(detail))).toEqual([]);
        expect(plans[0]?.rows ?? 0).toBeLessThan(20);
      }
    }, 60_000);
  }
});

describe("ranking queries with stale statistics (RES-7)", () => {
  it("seeks the library's candidates by id, with other accounts' statuses grown after ANALYZE", async () => {
    const { h } = await fixture();
    const { alice, bob } = h.users;
    await post(h, alice, { status: "needle mine" });
    const boosted = await post(h, bob, { status: "needle boosted" });
    await act(h, alice, `/api/v1/statuses/${boosted.id}/reblog`);
    const run = () => planned(h, /^WITH candidates/, { query: "needle", types: ["statuses"], following: false });
    const { before, after } = await staleStatistics(h, {
      settle: () => fillerStatuses(h, bob.id, 2000, 300000000000000000n),
      capture: () => run(),
      grow: async () => {
        await fillerStatuses(h, bob.id, 20_000, 400000000000000000n);
      },
    });
    expect(after.value.statuses.map((s) => s.id)).toEqual(before.value.statuses.map((s) => s.id));
    expect(after.value.statuses).toHaveLength(2);
    expect(after.plans).toHaveLength(1);
    const { plan, rows } = after.plans[0]!;
    expect(plan).toContain("SEARCH s USING INDEX sqlite_autoindex_statuses_1 (id=?)");
    expect(scansOf(plan, ["s", "statuses"])).toEqual([]);
    expect(rows).toBe(before.plans[0]!.rows);
  }, 60_000);

  // The account_id statement (#1564, D7): every window starts at its cap, and older rows grow under each window's own
  // key after ANALYZE (bob's originals; alice's boosts, favourites, bookmarks, mentions and votes). Each window still
  // walks its index newest first and stops at its LIMIT, so the candidates and the rows read stay the same; each
  // candidate's interactions are probed by key.
  it("walks an account's originals and the viewer's newest votes by their indexes, and probes by key", async () => {
    const { h } = await fixture();
    const { alice, bob, carol } = h.users;
    const full = LIBRARY_SOURCE_LIMIT + 100;
    const older = 5000;
    // alice's library rows of carol's statuses from `base` up, and alice's boosts of them.
    const library = async (base: bigint, count: number) => {
      const range = `SELECT id, uri, published_at FROM statuses WHERE account_id = '${carol.id}'
				AND CAST(id AS INTEGER) BETWEEN ${base} AND ${base + BigInt(count) - 1n}`;
      await sql(h.store, `INSERT INTO favourites (account_id, status_id) SELECT ?, id FROM (${range})`, alice.id);
      await sql(h.store, `INSERT INTO bookmarks (account_id, status_id) SELECT ?, id FROM (${range})`, alice.id);
      await sql(h.store, `INSERT INTO status_mentions (status_id, account_id) SELECT id, ? FROM (${range})`, alice.id);
      await sql(
        h.store,
        `INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, published_at)
					SELECT CAST(CAST(id AS INTEGER) + 150000000000000000 AS TEXT), uri || '/boost', ?, id, 'public', published_at
					FROM (${range})`,
        alice.id,
      );
    };
    await fillerStatuses(h, bob.id, full, 600000000000000000n);
    await fillerStatuses(h, carol.id, full, 700000000000000000n);
    await library(700000000000000000n, full);
    // A poll on each of bob's statuses and alice's vote in each, with rowids above every vote grown later.
    await sql(
      h.store,
      `INSERT INTO polls (status_id, options, tallies) SELECT id, '["a","b"]', '[0,0]' FROM statuses WHERE account_id = ?`,
      bob.id,
    );
    await sql(
      h.store,
      `INSERT INTO poll_votes (id, poll_id, account_id, choice)
				SELECT 1000000 + row_number() OVER (ORDER BY id), id, ?, 0 FROM statuses WHERE account_id = ?`,
      alice.id,
      bob.id,
    );
    const maxId = "900000000000000000";
    const run = async (extra: { maxId?: string }) => {
      const { value, plans } = await planned(h, /^WITH library\(id\)/, {
        query: "filler",
        types: ["statuses"],
        following: false,
        accountId: bob.id,
        limit: 40,
        ...extra,
      });
      expect(plans).toHaveLength(1);
      const { query, params, plan, rows } = plans[0]!;
      // The candidates the statement takes, counted by the statement's own CTEs and parameters.
      const counted = await sql<{ n: number }>(
        h.store,
        `${query.slice(0, query.indexOf("SELECT s.id AS id FROM candidates"))}
					SELECT count(*) AS n FROM candidates WHERE 1 ${params.map((_, i) => `OR ?${i + 1} IS NULL`).join(" ")}`,
        ...params,
      );
      return { ids: value.statuses.map((s) => s.id), plan, rows, candidates: counted[0]!.n };
    };
    const both = async () => [await run({}), await run({ maxId })];
    const { before, after } = await staleStatistics(h, {
      capture: both,
      grow: async () => {
        await fillerStatuses(h, bob.id, older, 200000000000000000n);
        await fillerStatuses(h, carol.id, older, 300000000000000000n);
        await library(300000000000000000n, older);
        await sql(
          h.store,
          `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?3)
						INSERT INTO poll_votes (id, poll_id, account_id, choice, generation) SELECT i, ?1, ?2, 0, i FROM n`,
          "600000000000000000",
          alice.id,
          older,
        );
      },
    });
    // Every window's own key grew by `older` rows below its window.
    const grown = await sql(
      h.store,
      `SELECT (SELECT count(*) FROM statuses WHERE account_id = ?1 AND reblog_of_id IS NULL) AS originals,
				(SELECT count(*) FROM statuses WHERE account_id = ?2 AND reblog_of_id IS NOT NULL) AS boosts,
				(SELECT count(*) FROM favourites WHERE account_id = ?2) AS favourites,
				(SELECT count(*) FROM bookmarks WHERE account_id = ?2) AS bookmarks,
				(SELECT count(*) FROM status_mentions WHERE account_id = ?2) AS mentions,
				(SELECT count(*) FROM poll_votes WHERE account_id = ?2) AS votes`,
      bob.id,
      alice.id,
    );
    const total = full + older;
    expect(grown).toEqual([
      { originals: total, boosts: total, favourites: total, bookmarks: total, mentions: total, votes: total },
    ]);
    for (const [i, { ids, plan, rows, candidates }] of after.entries()) {
      // bob's statuses alice voted in, the newest 40.
      expect(ids).toHaveLength(40);
      expect(ids).toEqual(before[i]!.ids);
      // bob's newest 2,500 (the polls of alice's newest votes among them) and carol's newest 2,500 alice saved.
      expect([before[i]!.candidates, candidates]).toEqual([2 * LIBRARY_SOURCE_LIMIT, 2 * LIBRARY_SOURCE_LIMIT]);
      const author = i === 0 ? "(account_id=?)" : "(account_id=? AND id<?)";
      expect(
        plan.filter((detail) => /^SEARCH statuses USING (COVERING )?INDEX statuses_account_originals /.test(detail)),
      ).toEqual([expect.stringMatching(new RegExp(` ${author.replace(/[()?]/g, "\\$&")}$`))]);
      const votes = plan.findIndex((detail) =>
        /^SEARCH poll_votes USING (COVERING )?INDEX poll_votes_account \(account_id=\?\)$/.test(detail),
      );
      expect(votes).toBeGreaterThan(-1);
      expect(plan[votes + 1]).not.toMatch(/TEMP B-TREE FOR .*ORDER BY/);
      // Each library window by its index and its own range, newest first: below max_id when one is given (the kept
      // boosts' range also holds reblog_of_id IS NOT NULL, a range above NULL).
      const below = (column: string) => (i === 0 ? "" : ` AND ${column}<?`);
      for (const [table, index, range] of [
        ["statuses", "statuses_account_reblogs_kept", `(account_id=? AND reblog_of_id>?${below("reblog_of_id")})`],
        ["favourites", "favourites_account_status", `(account_id=?${below("status_id")})`],
        ["bookmarks", "bookmarks_account_status", `(account_id=?${below("status_id")})`],
        ["status_mentions", "status_mentions_account", `(account_id=?${below("status_id")})`],
      ]) {
        expect(plan).toContain(`SEARCH ${table} USING COVERING INDEX ${index} ${range}`);
      }
      for (const probe of [
        "SEARCH favourites USING COVERING INDEX favourites_pair (status_id=? AND account_id=?)",
        "SEARCH bookmarks USING COVERING INDEX bookmarks_pair (status_id=? AND account_id=?)",
        "SEARCH statuses USING COVERING INDEX statuses_account_reblogs_kept (account_id=? AND reblog_of_id=?)",
        "SEARCH status_mentions USING PRIMARY KEY (status_id=? AND account_id=?)",
        "SEARCH p USING INDEX sqlite_autoindex_polls_1 (status_id=?)",
        "SEARCH v USING COVERING INDEX sqlite_autoindex_poll_votes_1 (poll_id=? AND generation=? AND account_id=?)",
      ]) {
        expect(plan).toContain(probe);
      }
      expect(
        scansOf(plan, ["s", "statuses", "favourites", "bookmarks", "status_mentions", "poll_votes", "p", "v"]),
      ).toEqual([]);
      // The same rows read as before the growth: no window walks the older rows.
      expect(rows).toBe(before[i]!.rows);
    }
  }, 180_000);

  it("seeks the candidate accounts by id and the username prefix by its index, past the newest window", async () => {
    const { h } = await fixture();
    // Accounts u<from> to u<from + count - 1>, each on a host of its own.
    const grow = (from: number, count: number) =>
      sql(
        h.store,
        `WITH RECURSIVE n(i) AS (SELECT CAST(?1 AS INTEGER) UNION ALL SELECT i + 1 FROM n WHERE i < ?1 + ?2 - 1)
				INSERT INTO accounts (id, uri, username, domain, search_text)
				SELECT CAST(500000000000000000 + i AS TEXT), 'https://d' || i || '.example/users/u', 'u' || i, 'd' || i || '.example',
					'u' || i || '@d' || i || '.example'
				FROM n`,
        from,
        count,
      );
    const run = (query: string) => planned(h, /^WITH candidates/, { query, types: ["accounts"], following: false });
    // Past the newest-accounts window (ACCOUNT_RECENT_LIMIT) and, for u1 (with u10 to u19 and so on), the prefix
    // window (ACCOUNT_PREFIX_LIMIT), before the Store grows further; nobody's prefix matches no account.
    const first = ACCOUNT_RECENT_LIMIT + ACCOUNT_PREFIX_LIMIT * 2;
    const both = async () => [await run("u1"), await run("nobody")];
    const { before, after } = await staleStatistics(h, {
      settle: () => grow(0, first),
      capture: both,
      grow: () => grow(first, 40_000),
    });
    expect(after.map((a) => a.value.accounts.length)).toEqual([20, 0]);
    for (const [i, { plans }] of after.entries()) {
      expect(plans).toHaveLength(1);
      const { plan, rows } = plans[0]!;
      expect(plan).toContain("SEARCH a USING INDEX sqlite_autoindex_accounts_1 (id=?)");
      expect(plan).toContain("SEARCH accounts USING INDEX accounts_username (<expr>>? AND <expr><?)");
      // The newest window alone reads accounts in rowid order, up to its LIMIT.
      expect(scansOf(plan, ["a", "accounts"])).toEqual(["SCAN accounts"]);
      expect(rows).toBe(before[i]!.plans[0]!.rows);
    }
  }, 60_000);

  it("takes the username-prefix window in username, then rowid order, read from the index without a sort", async () => {
    const { h } = await fixture();
    // ACCOUNT_PREFIX_LIMIT + 1 accounts of one username (equal lowered keys): the last stored, the most followed, is
    // past the window; then accounts that match nothing, so the newest window holds none of them.
    await sql(
      h.store,
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 + 5000 - 1)
			INSERT INTO accounts (id, uri, username, domain, search_text, followers_count)
			SELECT CAST(500000000000000000 + i AS TEXT), 'https://d' || i || '.example/users/u',
				CASE WHEN i < ?1 THEN 'Tie' ELSE 'other' END, 'd' || i || '.example',
				CASE WHEN i < ?1 THEN 'tie@d' || i || '.example' ELSE 'other' END,
				CASE WHEN i = ?1 - 1 THEN 100 WHEN i = 0 THEN 50 ELSE 0 END
			FROM n`,
      ACCOUNT_PREFIX_LIMIT + 1,
    );
    const { value, plans } = await planned(h, /^WITH candidates/, {
      query: "ti",
      types: ["accounts"],
      following: false,
      limit: 40,
    });
    const ids = value.accounts.map((a) => a.id);
    expect(ids[0]).toBe("500000000000000000");
    expect(ids).not.toContain(String(500000000000000000n + BigInt(ACCOUNT_PREFIX_LIMIT)));
    expect(ids).toHaveLength(40);
    // The window is read in the index's order, with no sort of its own.
    const plan = plans[0]!.plan;
    const prefix = plan.indexOf("SEARCH accounts USING INDEX accounts_username (<expr>>? AND <expr><?)");
    expect(prefix).toBeGreaterThan(-1);
    expect(plan[prefix + 1]).not.toMatch(/TEMP B-TREE FOR .*ORDER BY/);
  }, 60_000);
});
