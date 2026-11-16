import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { jsonBytes } from "../src/domain/answer-budget";
import {
  addCollectionItem,
  COLLECTION_JSON_MAX,
  deleteCollection,
  pruneCollectionItems,
  RETIRED_ROWS_PER_ROUND,
  removeCollectionItem,
  severCollections,
} from "../src/domain/collections";
import { PURGE_BATCH, purgeBatch } from "../src/domain/inbox";
import { FALLBACK_JSON_MAX } from "../src/domain/notification-fallback";
import { MAX_PUSH_BACKLOG } from "../src/domain/notifications";
import { completePush, confirmPush } from "../src/domain/push";
import {
  COLLECTION_DESCRIPTION_LENGTH,
  COLLECTION_NAME_LENGTH,
  COLLECTION_URI_BYTES,
  MAX_STORED_COLLECTIONS,
  MAX_STORED_ITEMS,
} from "../src/platform/stored-bounds";
import { sha256Hex } from "../src/security/tokens";
import { type ApiHarness, bearer, seedAccount, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { migratedStore } from "./helpers";
import { accessAdminStore, copyConfig, dumpViaRpc, importViaRpc } from "./ops-helpers";
import { CONSERVATIVE_JSON } from "./presented-maxima";
import { community, remoteAccount, type User } from "./status-helpers";

// The collection notifications (#1589 PR 2, design §6 2-T4 to 2-T6 and 2-T9): added_to_collection and
// collection_update as collections.ts writes them through notify (notifications.ts), keyed by their item or collection
// (migration 0107_collection_notifications), and the bounded deletions of what holds them.

const T = "2026-10-11T00:00:00.000Z";

type Answer = { status: number; body: Record<string, unknown> & { id?: string }; text: string };

async function call(h: ApiHarness, method: string, path: string, user: User, body?: unknown): Promise<Answer> {
  const response = await h.request(
    path,
    bearer(user.token, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  return { status: response.status, body: (text === "" ? {} : JSON.parse(text)) as Answer["body"], text };
}

async function world() {
  const h = await community(["alice", "bob", "carol", "dave"]);
  await sql(h.store, "UPDATE accounts SET discoverable = 1");
  return { h, ...h.users };
}

// alice's collection of `members`, created through the API: its id.
async function created(h: ApiHarness, owner: User, members: User[], fields: Record<string, unknown> = {}) {
  const answer = await call(h, "POST", "/api/v1/collections", owner, {
    name: "c",
    sensitive: false,
    discoverable: true,
    account_ids: members.map((member) => member.id),
    ...fields,
  });
  expect(answer.status, answer.text).toBe(200);
  return (answer.body.collection as { id: string }).id;
}

type Row = {
  id: number;
  account_id: string;
  type: string;
  from_account_id: string;
  collection_item_id: string | null;
  collection_id: string | null;
  filtered: number;
};

const rows = (h: ApiHarness, type: string) =>
  sql<Row>(
    h.store,
    `SELECT id, account_id, type, from_account_id, collection_item_id, collection_id, filtered FROM notifications
		WHERE type = ? ORDER BY account_id, id`,
    type,
  );

const itemOf = async (h: ApiHarness, collection: string, member: string) =>
  (
    await sql<{ id: string }>(
      h.store,
      "SELECT id FROM collection_items WHERE collection_id = ? AND account_id = ?",
      collection,
      member,
    )
  )[0]?.id;

describe("added_to_collection (2-T4)", () => {
  // Fails if R15's own-sender arm admits the type (shownSql's first term: `... IN ('poll', 'moderation_warning',
  // 'added_to_collection')`): alice is notified of her own item.
  it("notifies each local member added, on create and on add, never the owner featuring itself", async () => {
    const { h, alice, bob, carol } = await world();
    const collection = await created(h, alice, [alice, bob]);
    expect(await sql(h.store, "SELECT count(*) AS n FROM collection_items")).toEqual([{ n: 2 }]);
    const added = await call(h, "POST", `/api/v1/collections/${collection}/items`, alice, { account_id: carol.id });
    expect(added.status, added.text).toBe(200);
    expect(await rows(h, "added_to_collection")).toEqual(
      [
        { member: bob, item: await itemOf(h, collection, bob.id) },
        { member: carol, item: await itemOf(h, collection, carol.id) },
      ]
        .map(({ member, item }) => ({
          id: expect.any(Number),
          account_id: member.id,
          type: "added_to_collection",
          from_account_id: alice.id,
          collection_item_id: item,
          collection_id: null,
          filtered: 0,
        }))
        .toSorted((a, b) => a.account_id.localeCompare(b.account_id)),
    );
  });

  // Fails if added_to_collection leaves FILTERABLE_TYPES (audience.ts): bob's is not filtered.
  it("is filtered by the recipient's policy, as the other filterable types", async () => {
    const { h, alice, bob, carol } = await world();
    await sql(
      h.store,
      "INSERT INTO notification_policies (account_id, for_not_following) VALUES (?, 'filter')",
      bob.id,
    );
    await created(h, alice, [bob, carol]);
    expect(
      (await rows(h, "added_to_collection")).map((row) => [row.account_id === bob.id ? "bob" : "carol", row.filtered]),
    ).toEqual(
      expect.arrayContaining([
        ["bob", 1],
        ["carol", 0],
      ]),
    );
  });

  // Fails if notifications.collection_item_id loses ON DELETE CASCADE (the removal answers 500, the row stays).
  it("goes with its item", async () => {
    const { h, alice, bob, carol } = await world();
    const collection = await created(h, alice, [bob, carol]);
    const item = await itemOf(h, collection, bob.id);
    const removed = await call(h, "DELETE", `/api/v1/collections/${collection}/items/${item}`, alice);
    expect(removed.status, removed.text).toBe(200);
    expect((await rows(h, "added_to_collection")).map((row) => row.account_id)).toEqual([carol.id]);
  });
});

describe("collection_update (2-T5)", () => {
  // Fails if the changed-field set (collections.ts NOTIFIED_CHANGES) includes discoverable or language: those
  // updates replace the notifications with newer ids.
  it("notifies each accepted local member once per change of a listed field, replacing the earlier", async () => {
    const { h, alice, bob, carol, dave } = await world();
    const collection = await created(h, alice, [alice, bob, carol]);
    // dave's item waits (an imported pending row of a local account): Mastodon notifies accepted members only.
    await sql(
      h.store,
      `INSERT INTO collection_items (id, collection_id, account_id, state, position, created_at, updated_at)
			VALUES ('600000000000000001', ?, ?, 0, 2, ?, ?)`,
      collection,
      dave.id,
      T,
      T,
    );
    const patch = async (body: Record<string, unknown>) => {
      const answer = await call(h, "PATCH", `/api/v1/collections/${collection}`, alice, body);
      expect(answer.status, answer.text).toBe(200);
      return answer.body.collection as Record<string, unknown>;
    };
    const updates = async () =>
      (await rows(h, "collection_update")).map((row) => ({
        account: row.account_id,
        id: row.id,
        collection: row.collection_id,
      }));
    await patch({ name: "renamed" });
    const first = await updates();
    expect(first.map((row) => [row.account, row.collection])).toEqual(
      [bob.id, carol.id].toSorted().map((account) => [account, collection]),
    );
    for (const change of [{ name: "again" }, { description: "d" }, { sensitive: true }, { tag_name: "cats" }]) {
      const before = await updates();
      await patch(change);
      const after = await updates();
      expect(after.map((row) => row.account)).toEqual(before.map((row) => row.account));
      after.forEach((row, n) => expect(row.id, JSON.stringify(change)).toBeGreaterThan(before[n]!.id));
    }
    const settled = await updates();
    expect(await patch({ discoverable: false })).toMatchObject({ discoverable: false });
    expect(await patch({ language: "fr" })).toMatchObject({ language: "fr" });
    expect(await updates()).toEqual(settled);
  });

  // As an edit's update (notify's replacement): a collection_update a mute drops leaves the earlier one, where Mastodon
  // deletes it first (docs/mastodon-deviations.md, "Collections"). Fails if notify deletes the earlier before knowing
  // the new one is written.
  it("keeps the collection_update written before the mute when a later update is not notified", async () => {
    const { h, alice, bob } = await world();
    const collection = await created(h, alice, [bob]);
    const patch = async (name: string) =>
      expect((await call(h, "PATCH", `/api/v1/collections/${collection}`, alice, { name })).status).toBe(200);
    const ids = async () => (await rows(h, "collection_update")).map((row) => row.id);
    await patch("first");
    const before = await ids();
    expect(before).toHaveLength(1);
    expect((await call(h, "POST", `/api/v1/accounts/${alice.id}/mute`, bob, { notifications: true })).status).toBe(200);
    await patch("muted");
    expect(await ids()).toEqual(before);
    // Unmuted, the next update replaces it.
    expect((await call(h, "POST", `/api/v1/accounts/${alice.id}/unmute`, bob)).status).toBe(200);
    await patch("again");
    const after = await ids();
    expect(after).toHaveLength(1);
    expect(after[0]).toBeGreaterThan(before[0]!);
  });

  it("goes with its collection", async () => {
    const { h, alice, bob } = await world();
    const collection = await created(h, alice, [bob]);
    await call(h, "PATCH", `/api/v1/collections/${collection}`, alice, { name: "renamed" });
    expect((await rows(h, "collection_update")).length).toBe(1);
    expect((await call(h, "DELETE", `/api/v1/collections/${collection}`, alice)).status).toBe(200);
    expect(await sql(h.store, "SELECT type, count(*) AS n FROM notifications GROUP BY type")).toEqual([]);
  });
});

type Presented = { type: string; account: { id: string }; collection?: { id: string; items: { id: string }[] } };
type Fallback = { title: string; summary: string; description: null };

// carol's collection notifications as v1 and v2 present them, the v2 groups' collections beside their types.
async function presented(h: ApiHarness, carol: User, query = "") {
  const v1 = await call(h, "GET", `/api/v1/notifications${query}`, carol);
  const v2 = await call(h, "GET", `/api/v2/notifications${query}`, carol);
  expect(v1.status, v1.text).toBe(200);
  expect(v2.status, v2.text).toBe(200);
  const groups = (v2.body as unknown as { notification_groups: (Presented & { fallback?: Fallback })[] })
    .notification_groups;
  return { v1: v1.body as unknown as (Presented & { fallback?: Fallback })[], v2: groups };
}

describe("presentation, fallback and push titles (2-T7)", () => {
  // Fails if a notification leaves out its collection, or presents it for no viewer (dave's item, which carol blocks,
  // would show).
  it("presents the collection to its recipient, with the items R45 shows the recipient, on v1 and v2", async () => {
    const { h, alice, bob, carol, dave } = await world();
    expect((await call(h, "POST", `/api/v1/accounts/${dave.id}/block`, carol)).status).toBe(200);
    const collection = await created(h, alice, [bob, carol, dave]);
    expect((await call(h, "PATCH", `/api/v1/collections/${collection}`, alice, { name: "renamed" })).status).toBe(200);
    const shown = [await itemOf(h, collection, bob.id), await itemOf(h, collection, carol.id)];
    const { v1, v2 } = await presented(h, carol);
    const entry = (type: string) => ({
      type,
      account: expect.objectContaining({ id: alice.id }),
      collection: expect.objectContaining({
        id: collection,
        items: shown.map((id): unknown => expect.objectContaining({ id })),
      }),
    });
    expect(v1).toEqual([
      expect.objectContaining(entry("collection_update")),
      expect.objectContaining(entry("added_to_collection")),
    ]);
    expect(v2.map(({ type, collection: c }) => ({ type, collection: c }))).toEqual(
      ["collection_update", "added_to_collection"].map((type) => {
        const { account: _, ...rest } = entry(type);
        return rest;
      }),
    );
  });

  // RES-3: a collection notification adds no shape to "Maxima of presented units" (docs/threat-model.md): its account,
  // its collection (a remote one's longer name and description and its uri and url, each character at six bytes, over
  // the local bound) and its fallback at their bounds, with its own keys, stay under a warning notification's
  // conservative JSON, and as a group under a warning group's.
  it("presents within a warning notification's maximum, so it adds no shape", () => {
    const id = "9".repeat(20);
    const collection =
      COLLECTION_JSON_MAX +
      6 * (COLLECTION_NAME_LENGTH.remote - COLLECTION_NAME_LENGTH.local) +
      6 * (COLLECTION_DESCRIPTION_LENGTH.remote - COLLECTION_DESCRIPTION_LENGTH.local) +
      2 * 6 * COLLECTION_URI_BYTES;
    const parts = CONSERVATIVE_JSON.account + collection + FALLBACK_JSON_MAX;
    const keys = { type: "collection_update", fallback: 0, collection: 0 };
    const notification =
      jsonBytes({ id, ...keys, created_at: T, group_key: `ungrouped-${id}`, filtered: true, account: 0 }) + parts;
    const group =
      jsonBytes({
        group_key: `ungrouped-${id}`,
        notifications_count: 1,
        most_recent_notification_id: Number.MAX_SAFE_INTEGER,
        page_min_id: id,
        page_max_id: id,
        latest_page_notification_at: T,
        sample_account_ids: [id],
        ...keys,
      }) + parts;
    expect({ notification, group }).toEqual({ notification: 225_871, group: 226_023 });
    expect(notification).toBeLessThan(CONSERVATIVE_JSON.warningNotification);
    expect(group).toBeLessThan(CONSERVATIVE_JSON.warningGroup);
  });

  // Fails if either type leaves FALLBACK_TYPES, or its title names the owner otherwise than by its mention link.
  it("gives each type its fallback, the owner by its mention link, to a client that does not support it", async () => {
    const { h, alice, bob } = await world();
    const collection = await created(h, alice, [bob]);
    expect((await call(h, "PATCH", `/api/v1/collections/${collection}`, alice, { name: "renamed" })).status).toBe(200);
    const name =
      '<span class="h-card" translate="no"><a href="https://kopje.test/@alice" class="u-url mention">@<span>alice</span></a></span>';
    const summary =
      "You're on an app that does not support the most recent version of Mastodon. " +
      '<a href="https://kopje.test/">Visit kopje.test</a>.';
    const fallbacks = [
      { title: `${name} updated a collection you are in`, summary, description: null },
      { title: `${name} added you to a collection`, summary, description: null },
    ];
    const { v1, v2 } = await presented(h, bob, "?supported_types[]=mention");
    expect(v1.map((n) => n.fallback)).toEqual(fallbacks);
    expect(v2.map((g) => g.fallback)).toEqual(fallbacks);
    const supported = await presented(
      h,
      bob,
      "?supported_types[]=added_to_collection&supported_types[]=collection_update",
    );
    expect([...supported.v1, ...supported.v2].map((n) => n.fallback)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });
});

// Fails if notifications_natural leaves out collection_item_id (migration 0107): bob's second notification conflicts
// with the first and is not written.
it("keys a member's notifications by item and by collection (2-T6)", async () => {
  const { h, alice, bob } = await world();
  const first = await created(h, alice, [bob]);
  const second = await created(h, alice, [bob]);
  expect((await rows(h, "added_to_collection")).map((row) => row.collection_item_id)).toEqual([
    await itemOf(h, first, bob.id),
    await itemOf(h, second, bob.id),
  ]);
  for (const collection of [first, second]) {
    await call(h, "PATCH", `/api/v1/collections/${collection}`, alice, { name: "renamed" });
  }
  expect((await rows(h, "collection_update")).map((row) => row.collection_id)).toEqual([first, second]);
});

// ---- 2-T9: deletions with pushes waiting (D14).

const collectionId = (n: number) => String(500000000000000000n + BigInt(n));
const itemId = (n: number) => String(600000000000000000n + BigInt(n));

// `count` subscriptions of `owner`'s tokens (one token each), so one notification may hold that many pushes.
async function subscriptions(h: ApiHarness, owner: string, count: number): Promise<void> {
  await sql(
    h.store,
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
		INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes)
		SELECT 'push-' || ?2 || '-' || i, 'access', (SELECT client_id FROM oauth_tokens LIMIT 1), ?2, 'push' FROM n`,
    count,
    owner,
  );
  await sql(
    h.store,
    `INSERT INTO push_subscriptions (token_hash, endpoint, key_p256dh, key_auth)
		SELECT token_hash, 'https://push.example/' || token_hash, 'k', 'a' FROM oauth_tokens WHERE token_hash GLOB 'push-*'
			AND account_id = ?`,
    owner,
  );
}

// `count` pushes of the notification `notification`, one per subscription of its recipient; every third leased.
async function pushes(h: ApiHarness, notification: number, count: number): Promise<void> {
  await sql(
    h.store,
    `INSERT INTO push_deliveries (subscription_id, notification_id, state, lease_token, next_attempt_at, updated_at)
		SELECT p.id, n.id, CASE WHEN p.id % 3 = 0 THEN 'leased' ELSE 'pending' END,
			CASE WHEN p.id % 3 = 0 THEN 'lease' END, ?3, ?3
		FROM notifications n CROSS JOIN oauth_tokens t ON t.account_id = n.account_id
			CROSS JOIN push_subscriptions p ON p.token_hash = t.token_hash
		WHERE n.id = ?1 AND NOT EXISTS (SELECT 1 FROM push_deliveries d WHERE d.subscription_id = p.id
			AND d.notification_id = n.id)
		ORDER BY p.id LIMIT ?2`,
    notification,
    count,
    NOW,
  );
}

async function seedCollection(h: ApiHarness, owner: string, n: number): Promise<string> {
  await sql(
    h.store,
    `INSERT INTO collections (id, account_id, local, name, sensitive, discoverable, created_at, updated_at)
		VALUES (?, ?, 1, 'c', 0, 1, ?, ?)`,
    collectionId(n),
    owner,
    T,
    T,
  );
  return collectionId(n);
}

// An item of the collection, of `member` (or unresolved, an imported pending or retired row), with `state`.
async function seedItem(
  h: ApiHarness,
  collection: string,
  n: number,
  member: string | null,
  state: number,
  updatedAt = T,
): Promise<string> {
  await sql(
    h.store,
    `INSERT INTO collection_items (id, collection_id, account_id, object_uri, state, position, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    itemId(n),
    collection,
    member,
    member === null ? `https://remote.example/users/m${n}` : null,
    state,
    n + 1,
    T,
    updatedAt,
  );
  return itemId(n);
}

// A notification of `recipient` from `from` about the item or the collection: its id.
async function seedNotification(
  h: ApiHarness,
  recipient: string,
  from: string,
  key: { item: string } | { collection: string },
): Promise<number> {
  const [row] = await sql<{ id: number }>(
    h.store,
    `INSERT INTO notifications (account_id, type, from_account_id, collection_item_id, collection_id, created_at)
		VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
    recipient,
    "item" in key ? "added_to_collection" : "collection_update",
    from,
    "item" in key ? key.item : null,
    "collection" in key ? key.collection : null,
    T,
  );
  return row!.id;
}

// `op` run as a Store write in its own transaction: its answer and the rows it wrote (total_changes()).
function measured<T>(h: ApiHarness, op: (sql: SqlStorage) => T): Promise<{ answer: T; wrote: number }> {
  return runInDurableObject(h.store, (_instance, state) => {
    const db = new Db(state.storage.sql);
    const changes = () => db.first<{ n: number }>("SELECT total_changes() AS n")!.n;
    const before = changes();
    const answer = state.storage.transactionSync(() => op(state.storage.sql));
    return { answer, wrote: changes() - before };
  });
}

async function credential(user: User) {
  return { tokenHash: await sha256Hex(user.token), scope: "write:collections" as const, now: NOW };
}

const backlog = async (h: ApiHarness) =>
  (await sql<{ n: number }>(h.store, "SELECT count(*) AS n FROM push_deliveries"))[0]!.n;

describe("deletions with pushes waiting (2-T9)", () => {
  // §5.1, a collection's deletion: 1 + its MAX_STORED_ITEMS items + their notifications (one each) + its
  // collection_update notifications (one per local recipient) + MAX_PUSH_BACKLOG pushes, all by the foreign keys.
  it("deletes a collection with its items, notifications and pushes in one bounded request", async () => {
    const { h, alice, bob, carol } = await world();
    await subscriptions(h, bob.id, MAX_PUSH_BACKLOG);
    const collection = await seedCollection(h, alice.id, 1);
    const items = [];
    for (let n = 0; n < MAX_STORED_ITEMS; n++) {
      // 25 pending unresolved rows, then 25 retired ones: the stored maximum.
      items.push(await seedItem(h, collection, n, null, n < 25 ? 0 : 3));
    }
    const notifications = [];
    for (const item of items) {
      notifications.push(await seedNotification(h, bob.id, alice.id, { item }));
    }
    const updates = [
      await seedNotification(h, bob.id, alice.id, { collection }),
      await seedNotification(h, carol.id, alice.id, { collection }),
    ];
    await pushes(h, notifications[0]!, MAX_PUSH_BACKLOG / 2);
    await pushes(h, updates[0]!, MAX_PUSH_BACKLOG / 2);
    expect(await backlog(h)).toBe(MAX_PUSH_BACKLOG);
    const input = { credential: await credential(alice), id: collection };
    const { answer, wrote } = await measured(h, (s) => deleteCollection.run(s, input));
    expect(answer).toEqual({ status: "ok", value: "ok" });
    const locals = (await sql<{ n: number }>(h.store, "SELECT count(*) AS n FROM local_accounts"))[0]!.n;
    expect(wrote).toBeLessThanOrEqual(1 + 2 * MAX_STORED_ITEMS + locals + MAX_PUSH_BACKLOG);
    expect(wrote).toBe(1 + 2 * MAX_STORED_ITEMS + updates.length + MAX_PUSH_BACKLOG);
    expect(await backlog(h)).toBe(0);
    expect(await sql(h.store, "SELECT count(*) AS n FROM notifications")).toEqual([{ n: 0 }]);
  });

  // §5.1, an item's removal: 1 + its notification + MAX_PUSH_BACKLOG pushes.
  it("removes an item with its notification and pushes", async () => {
    const { h, alice, bob } = await world();
    await subscriptions(h, bob.id, MAX_PUSH_BACKLOG);
    const collection = await seedCollection(h, alice.id, 1);
    const item = await seedItem(h, collection, 0, bob.id, 1);
    await pushes(h, await seedNotification(h, bob.id, alice.id, { item }), MAX_PUSH_BACKLOG);
    const input = { credential: await credential(alice), collection, item };
    const { answer, wrote } = await measured(h, (s) => removeCollectionItem.run(s, input));
    expect(answer).toEqual({ status: "ok", value: "ok" });
    expect(wrote).toBe(1 + 1 + MAX_PUSH_BACKLOG);
    expect(await backlog(h)).toBe(0);
  });

  // §5.1, an eviction at the stored cap: the oldest retired row, its notification and its MAX_PUSH_BACKLOG pushes;
  // then the add's own rows: its id (allocateLocalId's kopje_state row), its item and its notification (dave has no
  // subscription, so no push).
  it("evicts the oldest retired item with its notification and pushes", async () => {
    const { h, alice, bob, dave } = await world();
    await subscriptions(h, bob.id, MAX_PUSH_BACKLOG);
    const collection = await seedCollection(h, alice.id, 1);
    for (let n = 0; n < MAX_STORED_ITEMS; n++) {
      const retiredAt = new Date(Date.parse(T) + n).toISOString();
      await seedItem(h, collection, n, null, n < 24 ? 0 : 2, retiredAt);
    }
    const oldest = itemId(24);
    await pushes(h, await seedNotification(h, bob.id, alice.id, { item: oldest }), MAX_PUSH_BACKLOG);
    const input = { credential: await credential(alice), collection, account: dave.id, now: NOW };
    const { answer, wrote } = await measured(h, (s) => addCollectionItem.run(s, input));
    expect(answer).toMatchObject({ status: "ok", value: { status: "ok" } });
    expect(wrote).toBe(1 + 1 + MAX_PUSH_BACKLOG + 3);
    expect(await sql(h.store, "SELECT id FROM collection_items WHERE id = ?", oldest)).toEqual([]);
    expect(await backlog(h)).toBe(0);
  });

  // §5.1, the block step: per side at most MAX_STORED_COLLECTIONS items (one per collection), the deleted ones'
  // notifications and their pushes.
  it("severs at most one item a collection each way, with the deleted items' notifications and pushes", async () => {
    const { h, alice, bob } = await world();
    await subscriptions(h, bob.id, MAX_PUSH_BACKLOG / MAX_STORED_COLLECTIONS);
    for (let n = 0; n < MAX_STORED_COLLECTIONS; n++) {
      const own = await seedCollection(h, alice.id, n);
      const item = await seedItem(h, own, n, bob.id, 1);
      await pushes(h, await seedNotification(h, bob.id, alice.id, { item }), MAX_PUSH_BACKLOG);
      await seedItem(h, await seedCollection(h, bob.id, 100 + n), 100 + n, alice.id, 1);
    }
    expect(await backlog(h)).toBe(MAX_PUSH_BACKLOG);
    const { wrote } = await measured(h, (s) => severCollections(new Db(s), alice.id, bob.id, NOW));
    expect(wrote).toBe(3 * MAX_STORED_COLLECTIONS + MAX_PUSH_BACKLOG);
    expect(await sql(h.store, "SELECT state, count(*) AS n FROM collection_items GROUP BY state")).toEqual([
      { state: 3, n: MAX_STORED_COLLECTIONS },
    ]);
    expect(await backlog(h)).toBe(0);
  });

  // Fails if the cleanup deletes the items and lets their rows cascade (prune's first two writes removed): its first
  // round passes RETIRED_ROWS_PER_ROUND.
  it(
    "cleans up retired items child-first, RETIRED_ROWS_PER_ROUND rows a round, continuing where it stopped",
    { timeout: 120_000 },
    async () => {
      const { h, alice, bob } = await world();
      await subscriptions(h, bob.id, 1);
      const old = new Date(NOW - 25 * 60 * 60 * 1000).toISOString();
      const ITEMS = 600;
      for (let c = 0; c < ITEMS / MAX_STORED_ITEMS; c++) {
        const collection = await seedCollection(h, alice.id, c);
        await sql(
          h.store,
          `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?2 - 1)
					INSERT INTO collection_items (id, collection_id, object_uri, state, position, created_at, updated_at)
					SELECT CAST(CAST(?3 AS INTEGER) + CAST(?4 * ?2 + i AS INTEGER) AS TEXT), ?1, 'https://remote.example/m/' || i, 2, i + 1, ?5, ?5
					FROM n`,
          collection,
          MAX_STORED_ITEMS,
          "600000000000000000",
          c,
          old,
        );
      }
      await sql(
        h.store,
        `INSERT INTO notifications (account_id, type, from_account_id, collection_item_id, created_at)
				SELECT ?, 'added_to_collection', ?, id, ? FROM collection_items`,
        bob.id,
        alice.id,
        T,
      );
      await sql(
        h.store,
        `INSERT INTO push_deliveries (subscription_id, notification_id, next_attempt_at, updated_at)
				SELECT (SELECT id FROM push_subscriptions), id, ?1, ?1 FROM notifications`,
        NOW,
      );
      const counts = async (): Promise<Record<string, number>> =>
        Object.fromEntries(
          await Promise.all(
            ["push_deliveries", "notifications", "collection_items"].map(async (table): Promise<[string, number]> => [
              table,
              (await sql<{ n: number }>(h.store, `SELECT count(*) AS n FROM ${table}`))[0]!.n,
            ]),
          ),
        );
      const round = () => measured(h, (s) => pruneCollectionItems.run(s, { now: NOW }));
      const seen = [];
      for (let n = 0; n < 4; n++) {
        const { answer, wrote } = await round();
        expect(answer).toEqual({ deleted: wrote });
        expect(wrote).toBeLessThanOrEqual(RETIRED_ROWS_PER_ROUND);
        seen.push(await counts());
      }
      // The window of the 500 oldest: their pushes, then their notifications, then them; then the 100 left.
      expect(seen).toEqual([
        { push_deliveries: 100, notifications: 600, collection_items: 600 },
        { push_deliveries: 100, notifications: 100, collection_items: 600 },
        { push_deliveries: 100, notifications: 100, collection_items: 100 },
        { push_deliveries: 0, notifications: 0, collection_items: 0 },
      ]);
      expect((await round()).wrote).toBe(0);
    },
  );

  // A push leased before its notification went: its confirmation and completion find no row and change nothing.
  it("completes a leased push whose row was deleted as nothing", async () => {
    const { h, alice, bob } = await world();
    await subscriptions(h, bob.id, 1);
    const collection = await seedCollection(h, alice.id, 1);
    const item = await seedItem(h, collection, 0, bob.id, 1);
    await pushes(h, await seedNotification(h, bob.id, alice.id, { item }), 3);
    const [push] = await sql<{ id: string; lease_token: string | null }>(
      h.store,
      "UPDATE push_deliveries SET state = 'leased', lease_token = 'held' RETURNING CAST(id AS TEXT) AS id, lease_token",
    );
    const input = { credential: await credential(alice), collection, item };
    expect((await measured(h, (s) => removeCollectionItem.run(s, input))).answer).toEqual({
      status: "ok",
      value: "ok",
    });
    const lease = { id: push!.id, leaseToken: "held", now: NOW };
    const settled = await runInDurableObject(h.store, (_instance, state) => ({
      confirmed: confirmPush.run(state.storage.sql, lease),
      completed: completePush.run(state.storage.sql, { ...lease, outcome: { kind: "delivered", status: 201 } }),
    }));
    expect(settled).toEqual({ confirmed: null, completed: { status: "stale", nextDueAt: null } });
    expect(await backlog(h)).toBe(0);
  });
});

// D25 with D14: a remote account's purge deletes its collection rows child-first within PURGE_BATCH, the pushes of the
// notifications naming them first. The notifications here are not from the purged account (an imported Store's), so
// the purge's sender window does not take them first. Fails if the purge's item step takes items that still hold a
// notification (purgeCollectionRows' `NOT ${notified}` dropped, with its first two writes): the item's delete
// cascades to a notification of 600 pushes, and its batch passes PURGE_BATCH.
it(
  "purges a remote account's collection rows child-first, within PURGE_BATCH a batch",
  { timeout: 60_000 },
  async () => {
    const { h, alice, bob } = await world();
    const carol = await remoteAccount(h.store, "carol");
    const [{ uri }] = (await sql<{ uri: string }>(h.store, "SELECT uri FROM accounts WHERE id = ?", carol)) as [
      { uri: string },
    ];
    await subscriptions(h, bob.id, 600);
    // carol's membership of alice's collection, and carol's own collection with an unresolved item.
    const own = await seedCollection(h, alice.id, 1);
    const membership = await seedItem(h, own, 0, carol, 1);
    await sql(
      h.store,
      `INSERT INTO collections (id, account_id, local, name, sensitive, discoverable, uri, created_at, updated_at)
		VALUES (?, ?, 0, 'c', 0, 1, 'https://remote.example/c/2', ?, ?)`,
      collectionId(2),
      carol,
      T,
      T,
    );
    const theirs = await seedItem(h, collectionId(2), 1, null, 0);
    await pushes(h, await seedNotification(h, bob.id, alice.id, { item: membership }), 600);
    await pushes(h, await seedNotification(h, bob.id, alice.id, { item: theirs }), 200);
    await pushes(h, await seedNotification(h, bob.id, alice.id, { collection: collectionId(2) }), 200);
    const batches: number[] = [];
    for (let n = 0; n < 10; n++) {
      const { answer: more, wrote } = await measured(h, (s) => purgeBatch(new Db(s), uri, NOW));
      batches.push(wrote);
      if (!more) {
        break;
      }
    }
    expect(batches.length).toBeGreaterThan(2);
    expect(batches.every((wrote) => wrote <= PURGE_BATCH)).toBe(true);
    expect(await sql(h.store, "SELECT count(*) AS n FROM accounts WHERE id = ?", carol)).toEqual([{ n: 0 }]);
    expect(await sql(h.store, "SELECT type, count(*) AS n FROM notifications GROUP BY type")).toEqual([]);
    expect(await backlog(h)).toBe(0);
    // alice's collection stays, without carol.
    expect(await sql(h.store, "SELECT id FROM collections")).toEqual([{ id: own }]);
  },
);

// RES-4/RES-7: what a deletion of an item or a collection finds by key is bounded where it is stored, imports included:
// one notification an item and one collection_update a collection and recipient (0107's unique partial indexes). A
// dump past either, from a Store whose index was dropped, is refused, so no restore holds the 600 or 6,000
// notifications a later cleanup, removal or purge would read and rewrite. Fails if either index is not UNIQUE.
describe("the stored bound of collection notifications (2-T9)", () => {
  const [COLLECTION, ITEM] = ["200000000000000001", "300000000000000001"];
  const CASES = [
    ["notifications_collection_item", "added_to_collection", ITEM, null, /notifications\.collection_item_id\b/],
    [
      "notifications_collection",
      "collection_update",
      null,
      COLLECTION,
      /notifications\.collection_id, notifications\.account_id\b/,
    ],
  ] as const;

  it.each([600, 6_000])(
    "refuses a restore of %i notifications of one item, or of one collection and recipient",
    async (n) => {
      for (const [index, type, item, collection, key] of CASES) {
        const store = await accessAdminStore();
        const owner = await seedAccount(store, { username: "owner", email: "owner@example.com" });
        const member = await seedAccount(store, { username: "member", email: "member@example.com" });
        await sql(
          store,
          `INSERT INTO collections (id, account_id, local, name, sensitive, discoverable, created_at, updated_at)
				VALUES (?1, ?2, 1, 'c', 0, 1, ?3, ?3)`,
          COLLECTION,
          owner,
          T,
        );
        await sql(
          store,
          `INSERT INTO collection_items (id, collection_id, account_id, state, position, created_at, updated_at)
				VALUES (?1, ?2, ?3, 1, 1, ?4, ?4)`,
          ITEM,
          COLLECTION,
          member,
          T,
        );
        const notified = (from: string) =>
          sql(
            store,
            `INSERT INTO notifications (account_id, type, from_account_id, collection_item_id, collection_id, created_at)
					VALUES (?, ?, ?, ?, ?, ?)`,
            member,
            type,
            from,
            item,
            collection,
            T,
          );
        // Within the bound: the owner's one notification restores.
        await notified(owner);
        const within = await migratedStore();
        await copyConfig(store, within);
        expect((await importViaRpc(within, (await dumpViaRpc(store)).text)).report).toMatchObject({ ok: true });
        // Past it: n senders of the same item's, or the same collection and recipient's, notification.
        await sql(store, `DROP INDEX ${index}`);
        await sql(
          store,
          `WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < ?1)
				INSERT INTO accounts (id, uri, username, domain)
				SELECT printf('9%017d', i), 'https://remote.test/users/r' || i, 'r' || i, 'remote.test' FROM k`,
          n - 1,
        );
        await sql(
          store,
          `INSERT INTO notifications (account_id, type, from_account_id, collection_item_id, collection_id, created_at)
				SELECT ?1, ?2, id, ?3, ?4, ?5 FROM accounts WHERE domain = 'remote.test'`,
          member,
          type,
          item,
          collection,
          T,
        );
        expect(await sql(store, "SELECT count(*) AS n FROM notifications WHERE type = ?", type)).toEqual([{ n }]);
        const target = await migratedStore();
        await copyConfig(store, target);
        await expect(importViaRpc(target, (await dumpViaRpc(store)).text), `${type} ${n}`).rejects.toThrow(
          new RegExp(`UNIQUE constraint failed: ${key.source}`),
        );
      }
    },
    600_000,
  );
});
