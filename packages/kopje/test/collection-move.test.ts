import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { requestCollectionSync } from "../src/domain/collection-requests";
import { ALL_PARTS, completeCollectionRead, MAX_SYNC_ATTEMPTS } from "../src/domain/remote-collections";
import { sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { BUILD } from "./helpers";
import { LOCAL, mastodonActor, type TestActor } from "./inbox-helpers";
import { AS, followed, OTHER, type Setup, setup } from "./inbox-status-helpers";
import { moveActivity, updated } from "./move-helpers";

// A remote account whose stored document names, as its movedTo, an account Kopje does not know (accounts.move_pending,
// migration 0125_account_move_pending): the store marks the move pending and asks for the collection sync, whose move
// part fetches the destination one hop (domain/remote-collections.ts, federation/collections.ts).

const DEST = `${OTHER}/users/dest`;

type MoveState = { moved: string | null; pending: number; syncs: number };

function moveState(t: Setup, uri: string): Promise<MoveState | undefined> {
  return sql<MoveState>(
    t.store,
    `SELECT (SELECT m.uri FROM accounts m WHERE m.id = a.moved_to_account_id) AS moved, a.move_pending AS pending,
			(SELECT count(*) FROM collection_syncs c WHERE c.account_id = a.id) AS syncs
		FROM accounts a WHERE a.uri = ?`,
    uri,
  ).then((rows) => rows[0]);
}

// The actor's document without any collection: a store of it asks for a sync only for a pending move.
function bare(actor: TestActor, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const { following: _a, followers: _b, outbox: _c, featured: _d, featuredTags: _e, ...rest } = actor.document;
  return { ...rest, ...extra };
}

describe("a pending move at the store", () => {
  it("is set with a sync for a document that names no collection, and cleared by one naming none", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    t.web.serve(bob.uri, bare(bob, { movedTo: DEST }));
    await followed(t, bob);
    expect(await moveState(t, bob.uri)).toEqual({ moved: null, pending: 1, syncs: 1 });
    await sql(t.store, "DELETE FROM collection_syncs");
    await updated(t, bob, bare(bob), 1);
    // Neither a move nor a collection: no sync is asked for, and the bit is cleared.
    expect(await moveState(t, bob.uri)).toEqual({ moved: null, pending: 0, syncs: 0 });
  });

  // ID-3, NET-1: only a destination the loader would request, that a fetched document can answer by its own id, and
  // that is not on this instance, is ever pending. The control is DEST, which each fixture differs from by one gate.
  it.each([
    ["an http: id", "http://other.example/users/dest"],
    ["an id with a fragment", `${DEST}#main`],
    ["an id on this instance's origin", `${LOCAL}/users/nobody`],
  ])("is not set for %s", async (_name, movedTo) => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    t.web.serve(bob.uri, bare(bob, { movedTo: DEST }));
    await followed(t, bob);
    expect(await moveState(t, bob.uri)).toMatchObject({ pending: 1 });
    await sql(t.store, "DELETE FROM collection_syncs");
    await updated(t, bob, bare(bob, { movedTo }), 1);
    expect(await moveState(t, bob.uri)).toEqual({ moved: null, pending: 0, syncs: 0 });
  });

  it("is not set when the named account is stored: the move is", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const carol = await mastodonActor(t.web, "carol", { key: 2 });
    await followed(t, carol);
    t.web.serve(bob.uri, bare(bob, { movedTo: carol.uri }));
    await followed(t, bob);
    expect(await moveState(t, bob.uri)).toEqual({ moved: carol.uri, pending: 0, syncs: 0 });
  });
});

describe("a pending move ended by a verified Move", () => {
  // The Move sets the source's move in the statement that ends its pending one, as the bound requires: the older
  // declaration is never resolved after it.
  it("clears the bit in the statement that sets the move", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const bob2 = await mastodonActor(t.web, "bob2", { key: 2 });
    t.web.serve(bob2.uri, { ...bob2.document, alsoKnownAs: [bob.uri] });
    t.web.serve(bob.uri, bare(bob, { movedTo: DEST }));
    await followed(t, bob);
    expect(await moveState(t, bob.uri)).toMatchObject({ moved: null, pending: 1 });
    const move = moveActivity(bob, bob2.uri);
    expect(await t.post(bob, move)).toBe(202);
    expect(await moveState(t, bob.uri)).toMatchObject({ moved: bob2.uri, pending: 0 });
  });
});

describe("a pending move ended without a result", () => {
  async function pendingBob(t: Setup): Promise<string> {
    const bob = await mastodonActor(t.web, "bob");
    t.web.serve(bob.uri, bare(bob, { movedTo: DEST }));
    const bobId = await followed(t, bob);
    expect(await moveState(t, bob.uri)).toEqual({ moved: null, pending: 1, syncs: 1 });
    return bobId;
  }

  it("ends when the claim gives the read up to the pins it left", async () => {
    const t = await setup();
    const bobId = await pendingBob(t);
    // The streak the pending move opens has one claim more than MAX_SYNC_ATTEMPTS (moveOpened).
    await sql(t.store, "UPDATE collection_syncs SET attempts = ?, due_at = ?", MAX_SYNC_ATTEMPTS + 1, NOW);
    await sql(
      t.store,
      "INSERT INTO collection_pins_pending (account_id, uri, pinned_at) VALUES (?, ?, ?)",
      bobId,
      "https://mastodon.example/users/bob/statuses/1",
      new Date(NOW).toISOString(),
    );
    const claimed = await t.store.claimCollectionSync(BUILD, { now: NOW });
    expect(claimed).toMatchObject({ phase: "pins" });
    expect(await sql(t.store, "SELECT move_pending FROM accounts WHERE id = ?", bobId)).toEqual([{ move_pending: 0 }]);
  });

  it("ends when the claim drops the sync", async () => {
    const t = await setup();
    const bobId = await pendingBob(t);
    // The streak the pending move opens has one claim more than MAX_SYNC_ATTEMPTS (moveOpened).
    await sql(t.store, "UPDATE collection_syncs SET attempts = ?, due_at = ?", MAX_SYNC_ATTEMPTS + 1, NOW);
    expect(await t.store.claimCollectionSync(BUILD, { now: NOW })).toBeNull();
    expect(await sql(t.store, "SELECT move_pending FROM accounts WHERE id = ?", bobId)).toEqual([{ move_pending: 0 }]);
    expect(await sql(t.store, "SELECT account_id FROM collection_syncs")).toEqual([]);
  });

  // The purge's first batch deletes the account's sync, while the row stays until its last batch: the deletion's start
  // ends the move first, so an account parked mid-purge is never pending without a sync (and a dump of it passes the
  // import's check). 1200 statuses keep the purge past its first batch.
  it("ends when the account's deletion starts, before the purge deletes its sync", async () => {
    const t = await setup();
    const bobId = await pendingBob(t);
    const bobUri = "https://mastodon.example/users/bob";
    await sql(
      t.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1200)
			INSERT INTO statuses (id, uri, account_id, visibility, published_at)
			SELECT CAST(970000000000000000 + i AS TEXT), ?1 || '/statuses/p' || i, ?2, 'public', '2026-10-01T00:00:00.000Z'
			FROM n`,
      bobUri,
      bobId,
    );
    const bob = await mastodonActor(t.web, "bob");
    expect(
      await t.post(bob, { "@context": AS, id: `${bobUri}#delete`, type: "Delete", actor: bobUri, object: bobUri }),
    ).toBe(202);
    expect(
      await sql(
        t.store,
        `SELECT deleted_at IS NOT NULL AS deleting, move_pending,
					(SELECT count(*) FROM collection_syncs WHERE account_id = ?1) AS syncs
				FROM accounts WHERE id = ?1`,
        bobId,
      ),
    ).toEqual([{ deleting: 1, move_pending: 0, syncs: 0 }]);
  });
});

// A request inside the completion's own transaction (as the destination's store can make, invalidating the source's
// handle) starts a new generation between the read of the claimed one's parts and their record: the record names the
// claimed generation, so the new one keeps its fresh parts and stays unread.
describe("a read's record and a request in its transaction", () => {
  it("records the parts for the claimed generation only", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const bobId = await followed(t, bob);
    const claimed = await t.store.claimCollectionSync(BUILD, { now: NOW });
    if (claimed === null || claimed === "more") {
      throw new Error("no sync claimed");
    }
    await runInDurableObject(t.store, (_instance, state) => {
      const real = state.storage.sql;
      // The bump, right before the completion records the claimed generation's parts, after it read them.
      const bumping = {
        exec: (query: string, ...params: SqlStorageValue[]) => {
          if (query.trim().startsWith("UPDATE collection_syncs SET parts_read")) {
            requestCollectionSync(new Db(real), bobId, NOW);
          }
          return real.exec(query, ...params);
        },
      } as unknown as SqlStorage;
      completeCollectionRead.run(
        bumping,
        {
          now: NOW,
          origin: LOCAL,
          accountUri: claimed.accountUri,
          generation: claimed.generation,
          token: claimed.token,
          parts: ALL_PARTS,
          pins: null,
          tags: null,
          hideCollections: null,
          counts: { statuses: null, following: null, followers: null },
          collections: null,
        },
        (fn) => state.storage.transactionSync(fn),
      );
    });
    expect(
      await sql(t.store, "SELECT generation, read_through, parts_read, collections_read FROM collection_syncs"),
    ).toEqual([{ generation: Number(claimed.generation) + 1, read_through: 0, parts_read: 0, collections_read: 0 }]);
  });
});
