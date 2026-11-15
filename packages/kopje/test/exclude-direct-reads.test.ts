import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Page, PageQuery } from "../src/domain/accounts";
import { accountStatuses, type AccountStatusesInput } from "../src/domain/timelines";
import { CONDITION_WALK } from "../src/domain/windows";
import type { StoreStub } from "../src/platform/store-client";
import { NOW } from "./app-helpers";
import { migratedStore } from "./helpers";
import { measuredRead, plannedRun } from "./read-helpers";

// exclude_direct on an account's statuses (RES-7, docs/visibility.md "Read bounds"). Alone, the window walks
// statuses_feed, whose predicate is listEligibleSql, so the author's direct and limited statuses are not in the index
// and add no read; with exclude_reblogs it walks statuses_account_originals and tests the fragment as a request
// condition, so they cost at most CONDITION_WALK entries a page. Private statuses the audience refuses a non-follower
// are in both indexes and are walked past as without exclude_direct (the RES-7 gap).

const AUTHOR = "720000000000000001";
const STRANGER = "720000000000000002";
const TOKENS = { [AUTHOR]: "exclude-direct-author", [STRANGER]: "exclude-direct-stranger" } as const;
const PRESENT = { origin: "https://kopje.test" };
const PAGE = { limit: 20 };
// The author's public originals, older than every row of `hidden`.
const SHOWN = 30;
const PUBLIC = 721000000000000000n;
const HIDDEN = 722000000000000000n;

type Hidden = "direct and limited" | "private";

// SHOWN public originals of the author, then `count` newer ones: direct and limited in turn, or private.
async function world(hidden: Hidden, count: number): Promise<StoreStub> {
  const store = await migratedStore();
  await runInDurableObject(store, (_instance, state) => {
    const sql = state.storage.sql;
    for (const [id, name] of [
      [AUTHOR, "author"],
      [STRANGER, "stranger"],
    ] as const) {
      sql.exec(
        "INSERT INTO accounts (id, uri, username) VALUES (?, ?, ?)",
        id,
        `https://kopje.test/ap/users/${name}`,
        name,
      );
      sql.exec(
        "INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, ?, X'00', X'00', 'test')",
        id,
        `${name}@example.com`,
      );
    }
    sql.exec(
      "INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('reads', 'secret', 'reads', 'urn:ietf:wg:oauth:2.0:oob', 'read')",
    );
    for (const [account, token] of Object.entries(TOKENS)) {
      sql.exec(
        "INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'reads', ?, 'read')",
        token,
        account,
      );
    }
    const insert = (base: bigint, n: number, visibility: string) =>
      sql.exec(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
				SELECT CAST(?2 + i AS TEXT), 'https://kopje.test/objects/' || (?2 + i), ?3,
					CASE WHEN ?4 = 'direct' AND i % 2 = 1 THEN 'limited' ELSE ?4 END, '<p>s</p>', ?5
				FROM n WHERE ?1 > 0`,
        n,
        String(base),
        AUTHOR,
        visibility,
        new Date(NOW).toISOString(),
      );
    insert(PUBLIC, SHOWN, "public");
    insert(HIDDEN, count, hidden === "private" ? "private" : "direct");
  });
  return store;
}

const input = (viewer: keyof typeof TOKENS, flags: Partial<AccountStatusesInput>, page: PageQuery = PAGE) => ({
  credential: { tokenHash: TOKENS[viewer], scope: "read", now: NOW } as const,
  now: NOW,
  account: AUTHOR,
  page,
  onlyMedia: false,
  excludeReplies: false,
  excludeReblogs: false,
  excludeDirect: false,
  pinned: false,
  tagged: null,
  present: PRESENT,
  ...flags,
});

function pageOf(output: unknown): Page<{ id: string }> {
  let value = output as Record<string, unknown>;
  while (value.status === "ok" && "value" in value) {
    value = value.value as Record<string, unknown>;
  }
  return value as unknown as Page<{ id: string }>;
}

async function measured(store: StoreStub, request: ReturnType<typeof input>) {
  const { output, rows } = await measuredRead({ store }, accountStatuses, request as never);
  return { page: pageOf(output), rows };
}

// The newest `n` of the public originals.
const newestPublic = (n: number) => Array.from({ length: n }, (_, i) => String(PUBLIC + BigInt(SHOWN - 1 - i)));

describe("exclude_direct reads statuses_feed, and with exclude_reblogs a request condition (RES-7)", () => {
  it("adds no read for the author's direct and limited statuses, at most what the same page reads without it", async () => {
    const few = await world("direct and limited", 20);
    const many = await world("direct and limited", 2_000);
    const pages: [string, PageQuery][] = [
      ["newest", PAGE],
      ["max_id", { ...PAGE, maxId: String(HIDDEN + 5_000n) }],
      ["min_id", { ...PAGE, minId: String(PUBLIC + 2n) }],
    ];
    for (const [label, page] of pages) {
      const request = input(AUTHOR, { excludeDirect: true }, page);
      const a = await measured(few, request);
      const b = await measured(many, request);
      const expected = label === "min_id" ? newestPublic(SHOWN - 3).slice(-PAGE.limit) : newestPublic(PAGE.limit);
      expect([label, a.page.items.map((item) => item.id)]).toEqual([label, expected]);
      expect([label, b.rows]).toEqual([label, a.rows]);
      // Main's statement, the same page without exclude_direct: it lists the author's direct and limited statuses.
      const main = await measured(few, input(AUTHOR, {}, page));
      expect([label, a.rows <= main.rows]).toEqual([label, true]);
      const run = await plannedRun({ store: many }, /INDEXED BY statuses_feed/, accountStatuses, request as never);
      expect([label, run.plans.map((plan) => plan.plan.join(" | "))]).toEqual([
        label,
        [expect.stringMatching(/^SEARCH s USING INDEX statuses_feed \(account_id=\? AND id>\? AND id<\?\) /)],
      ]);
    }
  });

  it("walks past the private statuses the audience refuses a non-follower as it does without it", async () => {
    for (const count of [20, 2_000]) {
      const store = await world("private", count);
      const withIt = await measured(store, input(STRANGER, { excludeDirect: true }));
      const without = await measured(store, input(STRANGER, {}));
      expect(withIt.page.items.map((item) => item.id)).toEqual(newestPublic(PAGE.limit));
      expect([count, withIt.rows]).toEqual([count, without.rows]);
    }
  });

  it("with exclude_reblogs, cuts the walk at CONDITION_WALK of the author's direct statuses and continues", async () => {
    const reached = await measured(
      await world("direct and limited", 100),
      input(AUTHOR, { excludeDirect: true, excludeReblogs: true }),
    );
    expect(reached.page.items.map((item) => item.id)).toEqual(newestPublic(PAGE.limit));
    const rows: number[] = [];
    for (const count of [CONDITION_WALK + 500, 4 * CONDITION_WALK]) {
      const store = await world("direct and limited", count);
      const request = input(AUTHOR, { excludeDirect: true, excludeReblogs: true });
      const cut = await measured(store, request);
      expect([count, cut.page.items, cut.page.cut]).toEqual([count, [], true]);
      // The next page starts at the last entry the walk examined, CONDITION_WALK below the newest.
      expect([count, cut.page.oldest]).toEqual([count, String(HIDDEN + BigInt(count - CONDITION_WALK))]);
      rows.push(cut.rows);
    }
    expect(rows[1]).toBe(rows[0]);
  });
});
