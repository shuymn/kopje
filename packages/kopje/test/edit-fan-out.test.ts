import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { totalChanges } from "../src/domain/row-budget";
import { notifyEdited } from "../src/domain/statuses";
import { sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { LEGACY_EMPTY_KEK, seedLocalAccount } from "./federation-helpers";
import { LOCAL, mastodonActor, type TestActor } from "./inbox-helpers";
import {
  ALICE,
  ALICE_URI,
  AS,
  create,
  DAVE,
  DAVE_URI,
  followed,
  localStatus,
  mastodonNote,
  nextId,
  type Note,
  type Setup,
  setup,
  statusRow,
  token,
  update,
} from "./inbox-status-helpers";
import { quoteRequest, quoting } from "./quote-helpers";
import { observedSql, remoteAccounts, staleStatistics, watchedCursor } from "./read-helpers";

// Mastodon's update fan-out (notifyEdited in src/domain/statuses.ts; docs/visibility.md R15, docs/threat-model.md
// VIS-10 and RES-4): wherever Mastodon broadcasts an update, the local quoted account of an accepted quote and every
// active local mention without a kept notification are notified, then the local boosters and quoters. A remote edit
// broadcasts only when it is significant (ProcessStatusUpdateService#handle_explicit_update!).

const FOLLOWERS = (actor: TestActor) => `${actor.uri}/followers`;
const mention = (href: string) => ({ type: "Mention", href, name: "@x" });

async function setPolicy(t: Setup, as: "alice" | "dave", policy: Record<string, string>) {
  const response = await t.request("/api/v2/notifications/policy", {
    method: "PUT",
    headers: { authorization: `Bearer ${t.tokens[as]}`, "content-type": "application/json" },
    body: JSON.stringify(policy),
  });
  expect(response.status).toBe(200);
}

// A push subscription of each token of `accountId` wanting `types`.
async function subscribe(t: Setup, accountId: string, types: string[]) {
  await sql(
    t.store,
    `INSERT INTO push_subscriptions (token_hash, endpoint, key_p256dh, key_auth, alerts, policy)
		SELECT token_hash, 'https://push.example/' || ?2, 'p', 'a', ?3, 'all' FROM oauth_tokens WHERE account_id = ?1`,
    accountId,
    nextId(),
    JSON.stringify(Object.fromEntries(types.map((type) => [type, true]))),
  );
}

// A clear of `accountId`'s notifications as its request leaves it before its batches run: recorded, so R15 hides them,
// and the rows still there, their pushes queued.
const cleared = (t: Setup, accountId: string) =>
  sql(
    t.store,
    "INSERT INTO notification_clears (account_id, max_id) SELECT ?1, max(id) FROM notifications WHERE account_id = ?1",
    accountId,
  );

const rowsOf = (t: Setup, type: string) =>
  sql<{ id: string; account_id: string; filtered: number }>(
    t.store,
    "SELECT CAST(id AS TEXT) AS id, account_id, filtered FROM notifications WHERE type = ? ORDER BY id",
    type,
  );

const pushed = async (t: Setup) =>
  (
    await sql<{ id: string }>(
      t.store,
      "SELECT CAST(notification_id AS TEXT) AS id FROM push_deliveries ORDER BY notification_id",
    )
  ).map((row) => row.id);

let minute = 0;
// bob's newer version of `note`: its text changed (significant) unless `extra` sets it.
function edited(bob: TestActor, note: Note, extra: Record<string, unknown> = {}) {
  minute++;
  return update(
    bob,
    { ...note, content: `<p>@alice edited ${minute}</p>`, ...extra },
    `2026-10-11T${String(13 + Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00Z`,
  );
}

describe("a remote edit's update fan-out", () => {
  // bob tags alice and addresses her in cc (unless not `addressed`); dave follows bob, which relates his statuses to
  // this instance. alice does not follow bob and holds a push subscription for mentions.
  async function world(addressed = true) {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const bobId = await followed(t, bob, DAVE);
    await subscribe(t, ALICE, ["mention"]);
    const note = mastodonNote(bob, {
      content: '<p><a href="https://kopje.test/@alice" class="u-url mention">@alice</a> hi</p>',
      cc: addressed ? [FOLLOWERS(bob), ALICE_URI] : [FOLLOWERS(bob)],
      tag: [mention(ALICE_URI)],
    });
    return { t, bob, bobId, note };
  }

  const activeMention = async (t: Setup, uri: string, accountId: string) =>
    sql(
      t.store,
      `SELECT m.silent FROM status_mentions m JOIN statuses s ON s.id = m.status_id
			WHERE s.uri = ? AND m.account_id = ?`,
      uri,
      accountId,
    );

  it("a significant edit notifies a mention the policy dropped", async () => {
    const { t, bob, note } = await world();
    await setPolicy(t, "alice", { for_not_following: "drop" });
    expect(await t.post(bob, create(bob, note))).toBe(202);
    expect(await activeMention(t, note.id, ALICE)).toEqual([{ silent: 0 }]);
    expect(await rowsOf(t, "mention")).toEqual([]);
    await setPolicy(t, "alice", { for_not_following: "accept" });
    expect(await t.post(bob, edited(bob, note))).toBe(202);
    expect(await rowsOf(t, "mention")).toMatchObject([{ account_id: ALICE, filtered: 0 }]);
  });

  it("…and a mention alice cleared, written again with a new id and pushed", async () => {
    const { t, bob, note } = await world();
    await t.post(bob, create(bob, note));
    const [first] = await rowsOf(t, "mention");
    expect(await pushed(t)).toEqual([first!.id]);
    await cleared(t, ALICE);
    expect(await t.post(bob, edited(bob, note))).toBe(202);
    const again = await rowsOf(t, "mention");
    expect(again).toHaveLength(1);
    expect(again[0]!.id).not.toBe(first!.id);
    // The hidden row went with its push (cascade); the new one is pushed.
    expect(await pushed(t)).toEqual([again[0]!.id]);
  });

  it("…but not one alice holds: the same row, no new push", async () => {
    const { t, bob, note } = await world();
    await t.post(bob, create(bob, note));
    const kept = await rowsOf(t, "mention");
    expect(await t.post(bob, edited(bob, note))).toBe(202);
    expect(await sql(t.store, "SELECT count(*) AS n FROM status_edits")).not.toEqual([{ n: 0 }]);
    expect(await rowsOf(t, "mention")).toEqual(kept);
    expect(await pushed(t)).toEqual([kept[0]!.id]);
  });

  it("…and a limited mention dropped at the Create, judged without the limited condition", async () => {
    // alice is tagged and left out of to and cc: limited at the Create, dropped by her choice.
    const { t, bob, note } = await world(false);
    await setPolicy(t, "alice", { for_limited_accounts: "drop" });
    await t.post(bob, create(bob, note));
    expect(await activeMention(t, note.id, ALICE)).toEqual([{ silent: 0 }]);
    expect(await rowsOf(t, "mention")).toEqual([]);
    expect(await t.post(bob, edited(bob, note))).toBe(202);
    expect(await rowsOf(t, "mention")).toMatchObject([{ account_id: ALICE, filtered: 0 }]);
  });

  it("an edit that is not significant notifies no mention, not even one it newly tags", async () => {
    const { t, bob, note } = await world();
    await t.post(bob, create(bob, note));
    await sql(t.store, "DELETE FROM notifications");
    // The same text, now sensitive, newly tagging and addressing dave.
    const tagsDave = edited(bob, note, {
      content: note.content,
      sensitive: true,
      cc: [FOLLOWERS(bob), ALICE_URI, DAVE_URI],
      tag: [mention(ALICE_URI), mention(DAVE_URI)],
    });
    expect(await t.post(bob, tagsDave)).toBe(202);
    expect(await statusRow(t.store, note.id)).toMatchObject({ sensitive: 1, edited_at: null });
    expect(await activeMention(t, note.id, DAVE)).toEqual([{ silent: 0 }]);
    expect(await rowsOf(t, "mention")).toEqual([]);
  });
});

describe("an accepted quote's notification on an edit (notify_quoted_account!)", () => {
  // bob's status quoting alice's, delivered (dave follows bob); accepted through its QuoteRequest unless `pending`.
  async function world(pending = false) {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await followed(t, bob, DAVE);
    await subscribe(t, ALICE, ["quote"]);
    const mine = await localStatus(t, { status: "quote me", visibility: "public" });
    const note = quoting(bob, mine.uri, null);
    t.web.serve(note.id, { "@context": AS, ...note });
    expect(await t.post(bob, create(bob, note))).toBe(202);
    if (!pending) {
      expect(await t.post(bob, quoteRequest(bob, mine.uri, note.id))).toBe(202);
    }
    const state = await sql(
      t.store,
      "SELECT state FROM quotes q JOIN statuses s ON s.id = q.status_id WHERE s.uri = ?",
      note.id,
    );
    expect(state).toEqual([{ state: pending ? "pending" : "accepted" }]);
    return { t, bob, note };
  }

  it("writes again a quote notification alice dismissed, and pushes it", async () => {
    const { t, bob, note } = await world();
    const [first] = await rowsOf(t, "quote");
    const dismissed = await t.request(`/api/v1/notifications/${first!.id}/dismiss`, {
      method: "POST",
      headers: { authorization: `Bearer ${t.tokens.alice}` },
    });
    expect(dismissed.status).toBe(200);
    expect(await rowsOf(t, "quote")).toEqual([]);
    expect(await t.post(bob, edited(bob, note))).toBe(202);
    const again = await rowsOf(t, "quote");
    expect(again).toMatchObject([{ account_id: ALICE }]);
    expect(await pushed(t)).toEqual([again[0]!.id]);
  });

  it("…but not a kept one: the same row, no new push", async () => {
    const { t, bob, note } = await world();
    const kept = await rowsOf(t, "quote");
    expect(await pushed(t)).toEqual([kept[0]!.id]);
    expect(await t.post(bob, edited(bob, note))).toBe(202);
    expect(await rowsOf(t, "quote")).toEqual(kept);
    expect(await pushed(t)).toEqual([kept[0]!.id]);
  });

  it("…and none for a pending quote", async () => {
    const { t, bob, note } = await world(true);
    expect(await t.post(bob, edited(bob, note))).toBe(202);
    expect(await sql(t.store, "SELECT count(*) AS n FROM status_edits")).not.toEqual([{ n: 0 }]);
    expect(await rowsOf(t, "quote")).toEqual([]);
  });
});

describe("the bound of an edit's notifications (docs/threat-model.md RES-4)", () => {
  const CAROL = "333333333333333333";
  const ERIN = "444444444444444444";
  const LOCALS = [
    [ALICE, "alice"],
    [DAVE, "dave"],
    [CAROL, "carol"],
    [ERIN, "erin"],
  ] as const;
  const uriOf = (username: string) => `${LOCAL}/ap/users/${username}`;

  async function seedLocals(t: Setup): Promise<Record<string, string>> {
    const tokens: Record<string, string> = { [ALICE]: t.tokens.alice, [DAVE]: t.tokens.dave };
    for (const [id, username] of LOCALS.slice(2)) {
      await seedLocalAccount(t.store, "kopje.test", { id, username, key: LEGACY_EMPTY_KEK });
      tokens[id] = await token(t.store, id);
    }
    return tokens;
  }

  it("replaces each update, quoted_update and cleared mention within the formula; a kept one writes nothing", async () => {
    const t = await setup();
    const tokens = await seedLocals(t);
    // Every local account: a streaming subscription and one push subscription (P_r = 1) for each type here.
    for (const [id] of LOCALS) {
      await sql(
        t.store,
        "INSERT INTO stream_subscriptions (account_id, stream_key, sockets) VALUES (?, 'user', 1)",
        id,
      );
      await subscribe(t, id, ["mention", "quote", "update", "quoted_update"]);
    }
    const bob = await mastodonActor(t.web, "bob");
    const bobId = await followed(t, bob, DAVE);
    // bob's public status quoting alice's (accepted through its QuoteRequest), tagging and addressing the four.
    const mine = await localStatus(t, { status: "quote me", visibility: "public" });
    const uris = LOCALS.map(([, username]) => uriOf(username));
    const note = quoting(bob, mine.uri, null, { cc: [FOLLOWERS(bob), ...uris], tag: uris.map(mention) });
    t.web.serve(note.id, { "@context": AS, ...note });
    expect(await t.post(bob, create(bob, note))).toBe(202);
    expect(await t.post(bob, quoteRequest(bob, mine.uri, note.id))).toBe(202);
    const statusId = (await statusRow(t.store, note.id))!.id;
    // Each of the four boosts it; dave quotes it (an accepted local quote).
    for (const [id] of LOCALS) {
      const response = await t.request(`/api/v1/statuses/${statusId}/reblog`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokens[id]}` },
      });
      expect(response.status).toBe(200);
    }
    const daves = await localStatus(t, { status: "dave quotes bob", visibility: "public" }, "dave");
    await sql(
      t.store,
      `INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, local, updated_at)
			VALUES (?, ?, ?, ?, 'accepted', 1, ?)`,
      daves.id,
      note.id,
      statusId,
      bobId,
      new Date(NOW).toISOString(),
    );
    // bob's first significant edit: each booster's update and dave's quoted_update, each with its push queued.
    expect(await t.post(bob, edited(bob, note))).toBe(202);
    // carol clears her notifications (hidden, their pushes still queued).
    await cleared(t, CAROL);
    const notificationsNow = () =>
      sql<{ id: string; account_id: string; type: string }>(
        t.store,
        "SELECT CAST(id AS TEXT) AS id, account_id, type FROM notifications ORDER BY id",
      );
    const streamed = async () =>
      (await sql<{ n: number }>(t.store, "SELECT count(*) AS n FROM stream_events WHERE kind = 'notification'"))[0]!.n;
    const before = await notificationsNow();
    const streamedBefore = await streamed();
    expect(before.filter((n) => n.type === "update")).toHaveLength(LOCALS.length);
    expect(before.filter((n) => n.type === "quoted_update")).toMatchObject([{ account_id: DAVE }]);
    expect(before.filter((n) => n.type === "quote")).toMatchObject([{ account_id: ALICE }]);
    expect(before.filter((n) => n.type === "mention")).toHaveLength(LOCALS.length);

    const measured = await runInDurableObject(t.store, (_instance, state) => {
      let policies = 0;
      const db = new Db(
        observedSql(state.storage.sql, (_rows, query) => {
          policies += query.includes("main.notification_permissions") ? 1 : 0;
        }),
      );
      const start = totalChanges(db);
      notifyEdited(db, statusId, bobId, NOW + 60_000);
      return { policies, changes: totalChanges(db) - start };
    });
    // One policy statement for alice's quote and one per mention (N = 4); update and quoted_update read none.
    expect(measured.policies).toBe(1 + LOCALS.length);
    // Section 5's terms that happen: each replaced update and quoted_update deletes the previous row and its push
    // (cascade), inserts, journals and pushes (3 + 2·P_r); carol's cleared mention the same (the status is not direct,
    // so no conversation: 3 + 2·P_r of its 7 + 2·P_r); the kept quote and the other kept mentions write nothing.
    const P = 1;
    const replaced = LOCALS.length + 1 + 1;
    expect(measured.changes).toBe(replaced * (3 + 2 * P));
    const formula = 3 + 2 * P + LOCALS.length * (7 + 2 * P) + LOCALS.length * (3 + 2 * P) + (3 + 2 * P);
    expect(measured.changes).toBeLessThanOrEqual(formula);

    const after = await notificationsNow();
    const key = (n: { account_id: string; type: string }) => `${n.type}:${n.account_id}`;
    expect(after.map(key).toSorted()).toEqual(before.map(key).toSorted());
    const kept = before.filter((n) => after.some((m) => m.id === n.id));
    expect(kept.map(key).toSorted()).toEqual(
      ["mention:" + ALICE, "mention:" + DAVE, "mention:" + ERIN, "quote:" + ALICE].toSorted(),
    );
    const fresh = after.filter((n) => !before.some((m) => m.id === n.id));
    expect(fresh).toHaveLength(replaced);
    expect(await streamed()).toBe(streamedBefore + replaced);
    // One push per new row, and the pushes of the kept ones; the replaced rows' pushes went with them.
    expect(await pushed(t)).toEqual(
      [...kept, ...fresh].map((n) => n.id).toSorted((a, b) => Number(BigInt(a) - BigInt(b))),
    );
  }, 60_000);

  it("reads no more for 10,000 converted mention rows: one key probe per local account", async () => {
    const t = await setup();
    await seedLocals(t);
    const bob = await mastodonActor(t.web, "bob");
    const bobId = await followed(t, bob, DAVE);
    const uris = LOCALS.slice(0, 3).map(([, username]) => uriOf(username));
    const note = mastodonNote(bob, { cc: [FOLLOWERS(bob), ...uris], tag: uris.map(mention) });
    expect(await t.post(bob, create(bob, note))).toBe(202);
    const statusId = (await statusRow(t.store, note.id))!.id;
    await remoteAccounts({ store: t.store }, 10, 1010);
    // Remote mention rows as the cutover conversion writes them (cli/lib/cutover/convert.js): any number, by SQL.
    const converted = (offset: number, count: number) =>
      sql(
        t.store,
        `INSERT INTO status_mentions (status_id, account_id, silent, requires_mention, author_id)
				SELECT ?1, id, 0, 0, ?2 FROM accounts WHERE domain IS NOT NULL AND id <> ?2 ORDER BY id LIMIT ?3 OFFSET ?4`,
        statusId,
        bobId,
        count,
        offset,
      );
    await converted(0, 100);
    // The rows LOCAL_MENTIONS_SQL reads in notifyEdited.
    const reads = () =>
      runInDurableObject(t.store, (_instance, state) => {
        let rows = -1;
        const real = state.storage.sql;
        const counting = {
          exec: (query: string, ...params: SqlStorageValue[]) => {
            const cursor = real.exec(query, ...params);
            return watchedCursor(cursor, () => {
              if (query.includes("CROSS JOIN status_mentions m")) {
                rows = cursor.rowsRead;
              }
            });
          },
        } as unknown as SqlStorage;
        notifyEdited(new Db(counting), statusId, bobId, NOW);
        return rows;
      });
    const { before, after } = await staleStatistics(
      { store: t.store },
      { capture: reads, grow: () => converted(100, 10_000) },
    );
    expect(
      await sql(t.store, "SELECT count(*) AS n FROM status_mentions WHERE status_id = ? AND silent = 0", statusId),
    ).toEqual([{ n: 3 + 100 + 10_000 }]);
    expect(before).toBeGreaterThan(0);
    expect(after).toBe(before);
  }, 60_000);
});
