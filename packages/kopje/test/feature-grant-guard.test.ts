import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { MIGRATIONS } from "../src/db/migrations";
import { RETRACTION_TTL_MS } from "../src/domain/retractions";
import { seedAccount, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { migratedStore } from "./helpers";

// Migration 0118_feature_grant_guard (#1589's D21 and D24, threat-model.md ID-9): no delete of a local
// member's accepted row in a remote collection, by any path, unless the Store holds evidence that the grant ended:
// the row retired (the member's revoke or block), the owner being deleted (its purge), the owner's Remove deleting the
// collection (its mark), the reset of an unpublished import (its mark), or the member's or the owner's account row
// gone (a cascade). The real paths that delete such rows run in the replay of the oracle's fixtures and in the tests
// of each path; this file holds the trigger's own rule, row by row, and its cost.

const NAMES = MIGRATIONS.map((m) => m.name);
const OWNER = "https://mastodon.example/users/owner";
const COLLECTION = `${OWNER}/collections/1`;
const CREATED = new Date(NOW).toISOString();
const REFUSED_ITEM = "collection_items: a local member's grant ends only with evidence";
const REFUSED_COLLECTION = "collections: a local member's grant ends only with evidence";

type World = { store: Awaited<ReturnType<typeof migratedStore>>; member: string; owner: string; other: string };

// A remote owner's collection (created at NOW) holding the local member's row in `state` (1 accepted, 3 revoked), and
// a remote member's accepted item.
async function world(state = 1, local = 0): Promise<World> {
  const store = await migratedStore();
  const member = await seedAccount(store, { username: "alice" });
  const owner = await seedAccount(store, { username: "owner", domain: "mastodon.example" });
  const other = await seedAccount(store, { username: "bob", domain: "other.example" });
  await sql(
    store,
    `INSERT INTO collections (id, account_id, local, name, sensitive, discoverable, uri, created_at, updated_at)
		VALUES ('100000000000000001', ?1, ?2, 'c', 0, 1, CASE WHEN ?2 = 0 THEN ?3 END, ?4, ?4)`,
    owner,
    local,
    COLLECTION,
    CREATED,
  );
  await sql(
    store,
    `INSERT INTO collection_items (id, collection_id, account_id, state, position, created_at, updated_at)
		VALUES ('200000000000000001', '100000000000000001', ?1, ?2, 1, ?3, ?3),
			('200000000000000002', '100000000000000001', ?4, 1, 2, ?3, ?3)`,
    member,
    state,
    CREATED,
    other,
  );
  return { store, member, owner, other };
}

// The error a statement fails with, or null when it commits.
async function refusal(store: World["store"], statement: string, ...params: (string | number)[]) {
  try {
    await sql(store, statement, ...params);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const rows = (w: World) => sql<{ id: string }>(w.store, "SELECT id FROM collection_items ORDER BY id");
const deleteMemberRow = "DELETE FROM collection_items WHERE id = '200000000000000001'";
const deleteCollection = "DELETE FROM collections WHERE id = '100000000000000001'";

describe("0118_feature_grant_guard", () => {
  it("follows 0117_retraction_counts and is declared foreignKeys: 'unchanged'", () => {
    const at = NAMES.indexOf("0118_feature_grant_guard");
    expect(NAMES[at - 1]).toBe("0117_retraction_counts");
    expect(MIGRATIONS[at]?.foreignKeys).toBe("unchanged");
  });

  // Fails with the migration's item trigger dropped: the accepted row is deleted.
  it("refuses a delete of a local member's accepted row in a remote collection with no evidence", async () => {
    const w = await world();
    expect(await refusal(w.store, deleteMemberRow)).toContain(REFUSED_ITEM);
    // A delete of the collection's every row, as a listing's replacement would write it, is refused whole.
    expect(await refusal(w.store, "DELETE FROM collection_items WHERE collection_id = '100000000000000001'")).toContain(
      REFUSED_ITEM,
    );
    expect(await rows(w)).toEqual([{ id: "200000000000000001" }, { id: "200000000000000002" }]);
    // The remote member's item is not guarded.
    expect(await refusal(w.store, "DELETE FROM collection_items WHERE id = '200000000000000002'")).toBeNull();
  });

  // Fails with the collection trigger dropped: the collection and the row go by the cascade, which the item trigger
  // passes (its parent is gone when it runs).
  it("refuses a delete of the collection holding it, whose cascade the item trigger cannot see", async () => {
    const w = await world();
    expect(await refusal(w.store, deleteCollection)).toContain(REFUSED_COLLECTION);
    expect(await rows(w)).toHaveLength(2);
  });

  // The retired row: the member's revoke or block is the evidence, written before the cleanup deletes it.
  it("lets a retired row go, and the collection that holds only retired local rows", async () => {
    const w = await world(3);
    expect(await refusal(w.store, deleteMemberRow)).toBeNull();
    const v = await world(3);
    expect(await refusal(v.store, deleteCollection)).toBeNull();
  });

  // Fails if the item trigger does not read the owner's deletion: the purge's batches delete the owned collections'
  // rows before the collections (inbox.ts purgeBatch).
  it("lets the rows and the collection go once the owner's deletion has begun", async () => {
    const w = await world();
    await sql(w.store, "UPDATE accounts SET deleted_at = ? WHERE id = ?", CREATED, w.owner);
    expect(await refusal(w.store, deleteMemberRow)).toBeNull();
    const v = await world();
    await sql(v.store, "UPDATE accounts SET deleted_at = ? WHERE id = ?", CREATED, v.owner);
    expect(await refusal(v.store, deleteCollection)).toBeNull();
    expect(await rows(v)).toEqual([]);
  });

  // Fails if the collection trigger admits a delete on a retraction rather than on its Remove's mark: a Delete of any
  // object records one (inbox.ts), with no Remove processed, and a Remove is refused when the stored creation time does
  // not precede the retraction's expiry.
  it("lets the collection go under its Remove's mark for its uri, and no retraction or other mark", async () => {
    const w = await world();
    const mark = (value: string) =>
      sql(w.store, "INSERT OR REPLACE INTO kopje_state (name, value) VALUES ('collection_removal', ?)", value);
    // The owner's retraction of the collection's uri, live, is no evidence.
    await sql(
      w.store,
      "INSERT INTO inbound_retractions (actor_uri, target_uri, expires_at) VALUES (?, ?, ?)",
      OWNER,
      COLLECTION,
      NOW + RETRACTION_TTL_MS,
    );
    expect(await refusal(w.store, deleteCollection)).toContain(REFUSED_COLLECTION);
    // Another collection's mark is not either.
    await mark(`${OWNER}/collections/2`);
    expect(await refusal(w.store, deleteCollection)).toContain(REFUSED_COLLECTION);
    // The mark admits the collection's delete, never a row of it alone: a Remove of a row's item hides it.
    await mark(COLLECTION);
    expect(await refusal(w.store, deleteMemberRow)).toContain(REFUSED_ITEM);
    expect(await refusal(w.store, deleteCollection)).toBeNull();
    expect(await rows(w)).toEqual([]);
  });

  // Fails if either trigger ignores the reset's mark: an interrupted import's accepted row would wedge its reset
  // (store-admin.ts #resetStep, test/ops-reset-bound.test.ts).
  it("lets the rows and the collection go under an import reset's mark", async () => {
    const w = await world();
    await sql(w.store, "INSERT INTO kopje_state (name, value) VALUES ('import_reset_step', 'i')");
    expect(await refusal(w.store, deleteMemberRow)).toBeNull();
    const v = await world();
    await sql(v.store, "INSERT INTO kopje_state (name, value) VALUES ('import_reset_step', 'i')");
    expect(await refusal(v.store, deleteCollection)).toBeNull();
  });

  // An account's row deleted cascades: the member's (Kopje deletes none today), or the owner's at its purge's end.
  it("lets the cascade of the member's or the owner's account row through", async () => {
    const w = await world();
    expect(await refusal(w.store, "DELETE FROM local_accounts WHERE account_id = ?", w.member)).toBeNull();
    expect(await refusal(w.store, "DELETE FROM accounts WHERE id = ?", w.member)).toBeNull();
    expect(await rows(w)).toEqual([{ id: "200000000000000002" }]);
    const v = await world();
    expect(await refusal(v.store, "DELETE FROM accounts WHERE id = ?", v.owner)).toBeNull();
    expect(await sql(v.store, "SELECT id FROM collections")).toEqual([]);
  });

  // A local collection is its local owner's to change (Mastodon's own rules): the guard is about a remote owner's.
  it("leaves a local collection's rows to its owner", async () => {
    const w = await world(1, 1);
    expect(await refusal(w.store, deleteMemberRow)).toBeNull();
  });

  // Each subquery of the triggers, as the migration writes it, searches by the index it names: a scan, or a range of
  // the local accounts, would read rows that have nothing to do with the deleted one.
  it("plans each of the triggers' subqueries as a search by the index it names", async () => {
    const text = MIGRATIONS.find((m) => m.name === "0118_feature_grant_guard")!.sql;
    const subqueries = [...text.matchAll(/EXISTS \((SELECT [^;]*?)\)\n *(?:AND|BEGIN)/g)].map((m) =>
      m[1]!.replaceAll(/OLD\.\w+/g, "'x'"),
    );
    expect(subqueries).toHaveLength(6);
    const w = await world();
    await runInDurableObject(w.store, (_instance, state) => {
      for (const query of subqueries) {
        const details = state.storage.sql
          .exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`)
          .toArray()
          .map((row) => row.detail);
        expect([query, details.every((d) => /^SEARCH \w+ USING (INDEX \w+|PRIMARY KEY) \(/.test(d))]).toEqual([
          query,
          true,
        ]);
      }
    });
  });

  // RES-7 under stale statistics: taken with the world's three accounts, then `members` local accounts are added, each
  // an accepted member of one of another owner's collections (25 each). Fails if a probe or the walk follows the
  // statistics into a range of local accounts or a scan of the rows: a delete would read more with 1,000 of them than
  // with 25.
  it("reads as many rows at each delete with 1,000 unrelated local members joined after the statistics as with 25", async () => {
    const grow = (store: World["store"], members: number) =>
      runInDurableObject(store, (_instance, state) => {
        const run = (query: string, ...params: SqlStorageValue[]) => void state.storage.sql.exec(query, ...params);
        run(
          `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
					INSERT INTO accounts (id, uri, username, domain)
					SELECT CAST(300000000000000000 + i AS TEXT), 'https://kopje.example/users/m' || i, 'm' || i, NULL FROM n`,
          members,
        );
        run(
          `INSERT INTO accounts (id, uri, username, domain)
					VALUES ('300000000000001000', 'https://other.example/users/carol', 'carol', 'other.example')`,
        );
        run(
          `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 / 25 - 1)
					INSERT INTO collections (id, account_id, local, name, sensitive, discoverable, uri, created_at, updated_at)
					SELECT CAST(110000000000000000 + i AS TEXT), '300000000000001000', 0, 'd', 0, 1,
						'https://other.example/users/carol/collections/' || i, ?2, ?2 FROM n`,
          members,
          CREATED,
        );
        run(
          `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
					INSERT INTO collection_items (id, collection_id, account_id, state, position, created_at, updated_at)
					SELECT CAST(400000000000000000 + i AS TEXT), CAST(110000000000000000 + i / 25 AS TEXT),
						CAST(300000000000000000 + i AS TEXT), 1, i % 25 + 1, ?2, ?2 FROM n`,
          members,
          CREATED,
        );
      });
    // The rows read by `statement` in a world prepared by `prepare` and grown after ANALYZE, with the triggers or
    // without them: the guard's share is the difference (the cascades' own plans are not the migration's).
    const reads = async (
      members: number,
      guarded: boolean,
      prepare: (w: World) => Promise<unknown>,
      statement: string,
    ) => {
      const w = await world();
      await prepare(w);
      if (!guarded) {
        await sql(w.store, "DROP TRIGGER collection_items_grant_guard");
        await sql(w.store, "DROP TRIGGER collections_grant_guard");
      }
      await sql(w.store, "ANALYZE");
      await grow(w.store, members);
      return runInDurableObject(w.store, (_instance, state) => {
        const cursor = state.storage.sql.exec(statement);
        cursor.toArray();
        return cursor.rowsRead;
      });
    };
    const share = async (members: number, prepare: (w: World) => Promise<unknown>, statement: string) =>
      (await reads(members, true, prepare, statement)) - (await reads(members, false, prepare, statement));
    const tombstone = (w: World) => sql(w.store, "UPDATE accounts SET deleted_at = ? WHERE id = ?", CREATED, w.owner);
    const marked = (w: World) =>
      sql(w.store, "INSERT INTO kopje_state (name, value) VALUES ('collection_removal', ?)", COLLECTION);
    const retired = (w: World) => sql(w.store, "UPDATE collection_items SET state = 3 WHERE account_id = ?", w.member);
    const none = async () => {};
    const cases: [string, (w: World) => Promise<unknown>, string][] = [
      ["the member's row under the owner's deletion", tombstone, deleteMemberRow],
      ["the collection under the owner's deletion", tombstone, deleteCollection],
      ["the collection under its Remove's mark", marked, deleteCollection],
      ["the collection whose every row it walks", retired, deleteCollection],
      ["a remote member's row", none, "DELETE FROM collection_items WHERE id = '200000000000000002'"],
    ];
    for (const [name, prepare, statement] of cases) {
      const few = await share(25, prepare, statement);
      expect([name, await share(1_000, prepare, statement)]).toEqual([name, few]);
    }
  }, 120_000);
});
