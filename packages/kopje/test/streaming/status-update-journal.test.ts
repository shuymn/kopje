import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Db } from "../../src/db/sql";
import { JOURNAL_SPAN, journalHead, journalStatusUpdate, quietJournaledEdit } from "../../src/domain/stream-journal";
import { iso } from "../../src/platform/iso-time";
import { type ApiHarness, bearer, json, sql } from "../api-helpers";
import { NOW } from "../app-helpers";
import { mastodonActor } from "../inbox-helpers";
import { create, followed, mastodonNote, PUBLIC, setup, update } from "../inbox-status-helpers";
import { act, community, follow, getJson, post, remoteAccount, seedStatus, type Status } from "../status-helpers";
import { drained, type Inbox, settled, type StreamMessage, subscribed, takeAll } from "./stream-helpers";

// `status.update` for a write that leaves `edited_at` (journalStatusUpdate in src/domain/stream-journal.ts): a local
// status's quote policy changed through `PUT /api/v1/statuses/:id` (Mastodon's UpdateStatusService broadcasts it as an
// edit) or `/interaction_policy` (Statuses::InteractionPoliciesController broadcasts it with skip_notifications, so
// FanOutOnWriteService sends the mentioned accounts nothing: a quiet edit), under the listener condition and span of
// the `edit` trigger (stream_status_edited). A remote same-version `Update` that
// changes only the policy sends nothing, as ProcessStatusUpdateService#handle_implicit_update! broadcasts only a moved
// quote state. Absence is proved with the drain barrier.

type PolicyStatus = Status & { quote_approval: { automatic: string[] }; edited_at: string | null };

// The messages left on a socket, as [stream, event, the status id of a status event, or the type of a notification].
function events(inbox: Inbox): [string | undefined, string | undefined, string][] {
  return inbox.rest().map((m) => [m.stream?.[0], m.event, subjectOf(m)]);
}

function subjectOf(m: StreamMessage): string {
  const payload = JSON.parse(m.payload ?? "null") as { id?: string; type?: string } | null;
  return m.event === "notification" ? (payload?.type ?? "") : (payload?.id ?? "");
}

function send(h: ApiHarness, token: string, method: string, path: string, body: Record<string, unknown>) {
  return h.request(path, bearer(token, json(body, { method })));
}

const storedPolicy = async (h: Pick<ApiHarness, "store">, id: string) =>
  (await sql<{ quote_policy: number }>(h.store, "SELECT quote_policy FROM statuses WHERE id = ?", id))[0]?.quote_policy;

// The notifications an edit's fan-out writes (bob's mention again, carol's update).
const notifiedOf = (h: ApiHarness) =>
  sql<{ type: string; account_id: string }>(
    h.store,
    "SELECT type, account_id FROM notifications WHERE type IN ('mention', 'update') ORDER BY id",
  );

// alice's public status mentioning bob, quotable by anyone; carol follows alice and boosts it; bob has dismissed his
// mention. carol listens on `user`, bob on `user` and `user:notification`.
async function world() {
  const h = await community(["alice", "bob", "carol"]);
  const { alice, bob, carol } = h.users;
  await follow(h, carol, alice.id);
  const status = await post(h, alice, { status: "@bob same", visibility: "public", quote_approval_policy: "public" });
  expect((await act(h, carol, `/api/v1/statuses/${status.id}/reblog`)).status).toBe(200);
  const [mention] = await sql<{ id: string }>(
    h.store,
    "SELECT CAST(id AS TEXT) AS id FROM notifications WHERE type = 'mention' AND account_id = ?",
    bob.id,
  );
  expect((await act(h, bob, `/api/v1/notifications/${mention!.id}/dismiss`)).status).toBe(200);
  expect(await notifiedOf(h)).toEqual([]);
  const follower = await subscribed(h, carol.token, "user");
  const mentioned = await subscribed(h, bob.token, "user", "user:notification");
  return { h, alice, carol, status, follower, mentioned };
}

describe("a local status's quote policy", () => {
  describe.for(["PUT", "PATCH"])("%s /interaction_policy", (method) => {
    it("sends status.update on user to a follower, as REST shows it, and notifies no one", async () => {
      const { h, alice, carol, status, follower, mentioned } = await world();
      const path = `/api/v1/statuses/${status.id}/interaction_policy`;
      expect((await send(h, alice.token, method, path, { quote_approval_policy: "nobody" })).status).toBe(200);
      expect(await storedPolicy(h, status.id)).toBe(0);
      await drained(h, follower, mentioned);
      expect(events(follower)).toEqual([["user", "status.update", status.id]]);
      expect(events(mentioned)).toEqual([]);
      const streamed = JSON.parse((await follower.next()).payload!) as PolicyStatus;
      expect(streamed.quote_approval.automatic).toEqual([]);
      expect(streamed.edited_at).toBeNull();
      expect(streamed).toEqual((await getJson<PolicyStatus>(h, `/api/v1/statuses/${status.id}`, carol.token)).body);
      expect(await notifiedOf(h)).toEqual([]);
    });

    it("sends nothing when the policy is unchanged, and the next change is sent", async () => {
      const { h, alice, status, follower, mentioned } = await world();
      const path = `/api/v1/statuses/${status.id}/interaction_policy`;
      const response = await send(h, alice.token, method, path, { quote_approval_policy: "public" });
      expect(response.status).toBe(200);
      expect((await response.json<PolicyStatus>()).quote_approval.automatic).toEqual(["public"]);
      expect(await storedPolicy(h, status.id)).toBe(2 << 16);
      await drained(h, follower, mentioned);
      expect([events(follower), events(mentioned)]).toEqual([[], []]);
      // The same socket is sent the next change.
      expect((await send(h, alice.token, method, path, { quote_approval_policy: "followers" })).status).toBe(200);
      await drained(h, follower);
      expect(events(follower)).toEqual([["user", "status.update", status.id]]);
    });
  });

  it("PUT /statuses/:id with only a new policy sends status.update and notifies as an edit", async () => {
    const { h, alice, carol, status, follower, mentioned } = await world();
    const response = await send(h, alice.token, "PUT", `/api/v1/statuses/${status.id}`, {
      status: "@bob same",
      quote_approval_policy: "nobody",
    });
    expect(response.status).toBe(200);
    expect((await response.json<PolicyStatus>()).edited_at).toBeNull();
    expect(await storedPolicy(h, status.id)).toBe(0);
    expect(await notifiedOf(h)).toEqual([
      { type: "mention", account_id: h.users.bob.id },
      { type: "update", account_id: carol.id },
    ]);
    await drained(h, follower, mentioned);
    // The notifications first (notifyEdited), then the status: on bob's streams through his mention again.
    expect(events(follower)).toEqual([
      ["user", "notification", "update"],
      ["user", "status.update", status.id],
    ]);
    expect(events(mentioned)).toEqual([
      ["user", "notification", "mention"],
      ["user:notification", "notification", "mention"],
      ["user", "status.update", status.id],
      ["user:notification", "status.update", status.id],
    ]);
    await follower.next();
    const streamed = JSON.parse((await follower.next()).payload!) as PolicyStatus;
    expect(streamed.quote_approval.automatic).toEqual([]);
    expect(streamed).toEqual((await getJson<PolicyStatus>(h, `/api/v1/statuses/${status.id}`, carol.token)).body);
  });

  it("an edit that changes nothing, the policy sent as it is included, sends nothing", async () => {
    const { h, alice, status, follower, mentioned } = await world();
    for (const body of [{ status: "@bob same" }, { status: "@bob same", quote_approval_policy: "public" }]) {
      expect((await send(h, alice.token, "PUT", `/api/v1/statuses/${status.id}`, body)).status).toBe(200);
    }
    expect(await storedPolicy(h, status.id)).toBe(2 << 16);
    await drained(h, follower, mentioned);
    expect([events(follower), events(mentioned)]).toEqual([[], []]);
  });
});

// alice's public status with #cats mentioning bob, who follows no one and keeps his mention (not dismissed); carol
// follows alice and lists her, and dave follows no one. carol listens on `user` and her list, dave on `public` and
// `hashtag` #cats, bob on `user` and `user:notification`.
async function heldMention() {
  const h = await community(["alice", "bob", "carol", "dave"]);
  const { alice, bob, carol, dave } = h.users;
  await follow(h, carol, alice.id);
  const created = await act(h, carol, "/api/v1/lists", { title: "list" });
  const { id: list } = await created.json<{ id: string }>();
  expect((await act(h, carol, `/api/v1/lists/${list}/accounts`, { account_ids: [alice.id] })).status).toBe(200);
  const status = await post(h, alice, {
    status: "@bob same #cats",
    visibility: "public",
    quote_approval_policy: "public",
  });
  const listing = await subscribed(h, carol.token, "user");
  listing.send({ type: "subscribe", stream: "list", list });
  await settled(h, listing);
  const fed = await subscribed(h, dave.token, "public");
  fed.send({ type: "subscribe", stream: "hashtag", tag: "cats" });
  await settled(h, fed);
  const mentioned = await subscribed(h, bob.token, "user", "user:notification");
  expect(
    await sql(h.store, "SELECT 1 FROM notifications WHERE type = 'mention' AND account_id = ?", bob.id),
  ).toHaveLength(1);
  return { h, alice, status, listing, fed, mentioned };
}

describe("a quote policy change and a held mention", () => {
  it.for(["PUT", "PATCH"])(
    "%s /interaction_policy sends nothing through a held mention, and home, the list and the feeds are sent it",
    async (method) => {
      const { h, alice, status, listing, fed, mentioned } = await heldMention();
      const path = `/api/v1/statuses/${status.id}/interaction_policy`;
      expect((await send(h, alice.token, method, path, { quote_approval_policy: "nobody" })).status).toBe(200);
      await drained(h, listing, fed, mentioned);
      expect(events(listing)).toEqual([
        ["user", "status.update", status.id],
        ["list", "status.update", status.id],
      ]);
      expect(events(fed)).toEqual([
        ["public", "status.update", status.id],
        ["hashtag", "status.update", status.id],
      ]);
      expect(events(mentioned)).toEqual([]);
      // An edit of the policy alone is sent to it through the mention (UpdateStatusService broadcasts in full).
      const edit = { status: "@bob same #cats", quote_approval_policy: "followers" };
      expect((await send(h, alice.token, "PUT", `/api/v1/statuses/${status.id}`, edit)).status).toBe(200);
      await drained(h, listing, fed, mentioned);
      expect(events(mentioned).filter(([, event]) => event === "status.update")).toEqual([
        ["user", "status.update", status.id],
        ["user:notification", "status.update", status.id],
      ]);
    },
  );
});

describe("a remote status's quote policy", () => {
  it("a same-version Update that changes only the policy stores it and sends nothing; a newer one is sent", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await followed(t, bob);
    const listener = await subscribed(t, t.tokens.alice, "user");
    // Published within the real-time window of its arrival at NOW, so the Create is sent too.
    const note = mastodonNote(bob, { published: "2026-10-11T23:00:00Z" });
    expect(await t.post(bob, create(bob, note))).toBe(202);
    const [row] = await sql<{ id: string; quote_policy: number }>(
      t.store,
      "SELECT id, quote_policy FROM statuses WHERE uri = ?",
      note.id,
    );
    await drained(t, listener);
    expect(events(listener)).toEqual([["user", "update", row!.id]]);
    await takeAll(listener);
    const policy = { interactionPolicy: { canQuote: { automaticApproval: [PUBLIC] } } };
    expect(await t.post(bob, update(bob, { ...note, ...policy }, note.published as string))).toBe(202);
    expect(await storedPolicy(t, row!.id)).not.toBe(row!.quote_policy);
    await drained(t, listener);
    expect(events(listener)).toEqual([]);
    // A newer version is an edit, sent on the same socket.
    const edited = { ...note, ...policy, content: "<p>edited</p>" };
    expect(await t.post(bob, update(bob, edited, "2026-10-11T23:30:00Z"))).toBe(202);
    await drained(t, listener);
    expect(events(listener)).toEqual([["user", "status.update", row!.id]]);
  });
});

describe("journalStatusUpdate", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Each listener set (the subscriptions of one local account) against each status, without a socket: the rows
  // journalStatusUpdate writes, with and without mentions, those stream_status_edited writes for an edited_at change
  // of the same status, and those stream_quote_state writes for a state change of the status's quote (migration
  // 0100_quote_state_stream).
  it("journals exactly when the edit triggers do, for every listener set and status", async () => {
    const h = await community(["alice"]);
    const listener = h.users.alice.id;
    const author = await remoteAccount(h.store, "author");
    const statuses: Record<string, string> = {};
    for (const visibility of ["public", "unlisted", "private", "direct", "limited"] as const) {
      statuses[visibility] = await seedStatus(h.store, { accountId: author, visibility });
    }
    statuses["boost"] = await seedStatus(h.store, {
      accountId: author,
      visibility: "public",
      reblogOfId: statuses["public"]!,
    });
    // Each status quotes another, pending.
    await sql(
      h.store,
      `INSERT INTO quotes (status_id, quoted_uri, state, updated_at)
			SELECT value, 'https://remote.example/quoted', 'pending', '2026-10-12T00:00:00.000Z' FROM json_each(?)`,
      JSON.stringify(Object.values(statuses)),
    );
    const sets: Record<string, string[]> = {
      none: [],
      user: ["user"],
      "user:notification": ["user:notification"],
      list: ["list:1"],
      public: ["public"],
      "public:local:media": ["public:local:media"],
      hashtag: ["hashtag:x"],
      direct: ["direct"],
      "public:remote": ["public:remote"],
      "hashtag:local": ["hashtag:local:x"],
      "direct and public:local": ["direct", "public:local"],
    };
    const outcome = await runInDurableObject(h.store, (_instance, state) => {
      const db = new Db(state.storage.sql);
      const count = () => db.first<{ n: number }>("SELECT COUNT(*) AS n FROM stream_events")!.n;
      const rows: Record<string, Record<string, [number, number, number, number]>> = {};
      let at = 0;
      for (const [set, keys] of Object.entries(sets)) {
        rows[set] = {};
        for (const [name, id] of Object.entries(statuses)) {
          db.run("DELETE FROM stream_subscriptions");
          for (const key of keys) {
            db.run(
              "INSERT INTO stream_subscriptions (account_id, stream_key, sockets) VALUES (?, ?, 1)",
              listener,
              key,
            );
          }
          const journaled = [true, false].map((mentions) => {
            db.run("DELETE FROM stream_events");
            journalStatusUpdate(db, id, NOW, { mentions });
            return count();
          });
          db.run("DELETE FROM stream_events");
          db.run("UPDATE statuses SET edited_at = ? WHERE id = ?", iso(NOW + ++at), id);
          const edited = count();
          db.run("DELETE FROM stream_events");
          db.run(
            "UPDATE quotes SET state = CASE state WHEN 'pending' THEN 'rejected' ELSE 'pending' END WHERE status_id = ?",
            id,
          );
          rows[set][name] = [journaled[0]!, journaled[1]!, edited, count()];
        }
      }
      db.run("DELETE FROM stream_subscriptions");
      db.run("DELETE FROM stream_events");
      return rows;
    });
    const everywhere = { public: 1, unlisted: 1, private: 1, direct: 1, limited: 1, boost: 1 };
    const publicOnly = { public: 1, unlisted: 0, private: 0, direct: 0, limited: 0, boost: 0 };
    const nowhere = { public: 0, unlisted: 0, private: 0, direct: 0, limited: 0, boost: 0 };
    const expected = {
      none: nowhere,
      user: everywhere,
      "user:notification": everywhere,
      list: everywhere,
      public: publicOnly,
      "public:local:media": publicOnly,
      hashtag: publicOnly,
      direct: nowhere,
      "public:remote": publicOnly,
      "hashtag:local": publicOnly,
      "direct and public:local": publicOnly,
    };
    const all = (map: Record<string, number>) =>
      Object.fromEntries(Object.entries(map).map(([name, n]) => [name, [n, n, n, n]]));
    expect(outcome).toEqual(Object.fromEntries(Object.entries(expected).map(([set, map]) => [set, all(map)])));
  });

  it("takes nothing once the journal spans JOURNAL_SPAN ids, and logs it", async () => {
    const h = await community(["alice"]);
    const status = await post(h, h.users.alice, { status: "mine", visibility: "public" });
    await sql(
      h.store,
      "INSERT INTO stream_subscriptions (account_id, stream_key, sockets) VALUES (?, 'user', 1)",
      h.users.alice.id,
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const journal = async (low: number) => {
      await sql(h.store, "DELETE FROM stream_events");
      for (const id of [low, 1 + JOURNAL_SPAN]) {
        await sql(
          h.store,
          "INSERT INTO stream_events (id, kind, subject, created_at) VALUES (?, 'status', '1', '2026-10-12T00:00:00.000Z')",
          id,
        );
      }
      await runInDurableObject(h.store, (_instance, state) =>
        journalStatusUpdate(new Db(state.storage.sql), status.id, NOW, { mentions: true }),
      );
      return sql<{ id: number; kind: string; subject: string }>(
        h.store,
        "SELECT id, kind, subject FROM stream_events ORDER BY id",
      );
    };
    // Spanning JOURNAL_SPAN - 1 ids, it takes the event.
    expect(await journal(2)).toEqual([
      { id: 2, kind: "status", subject: "1" },
      { id: 1 + JOURNAL_SPAN, kind: "status", subject: "1" },
      { id: 2 + JOURNAL_SPAN, kind: "edit", subject: status.id },
    ]);
    expect(warn).not.toHaveBeenCalled();
    expect(await journal(1)).toEqual([
      { id: 1, kind: "status", subject: "1" },
      { id: 1 + JOURNAL_SPAN, kind: "status", subject: "1" },
    ]);
    expect(warn.mock.calls).toEqual([[{ event: "kopje.stream.journal-full", kind: "edit" }]]);
  });
});

// The rewrite answerQuoteRequest makes of the row its move journaled (test/streaming/quote-updates.test.ts "an accepted
// QuoteRequest and a held mention"): only a row past the head read before the write, the journal's newest, an `edit`
// of that status; one row at most.
describe("quietJournaledEdit", () => {
  it("rewrites only the newest row past the head, an edit of the status, and never an older one", async () => {
    const h = await community(["alice"]);
    const outcome = await runInDurableObject(h.store, (_instance, state) => {
      const db = new Db(state.storage.sql);
      const at = "2026-10-12T00:00:00.000Z";
      const journal = (kind: string, subject: string) =>
        db.run("INSERT INTO stream_events (kind, subject, created_at) VALUES (?, ?, ?)", kind, subject, at);
      const rewrite = (head: string, status: string) => {
        quietJournaledEdit(db, head, status);
        return db.first<{ n: number }>("SELECT changes() AS n")!.n;
      };
      const rows = () =>
        db.all<{ kind: string; subject: string }>("SELECT kind, subject FROM stream_events ORDER BY id");
      db.run("DELETE FROM stream_events");
      const empty = journalHead(db);
      // An older edit of the status, and nothing journaled since the head: untouched.
      journal("edit", "1");
      const head = journalHead(db);
      const none = rewrite(head, "1");
      // Past the head: another status's edit, then a notification, then neither rewritten.
      journal("edit", "2");
      const other = rewrite(head, "1");
      journal("notification", "1");
      const notification = rewrite(head, "1");
      // The status's edit, newest and past the head: rewritten, once.
      const before = journalHead(db);
      journal("edit", "1");
      const once = rewrite(before, "1");
      const again = rewrite(before, "1");
      const after = rows();
      db.run("DELETE FROM stream_events");
      return { empty, none, other, notification, once, again, after };
    });
    expect(outcome).toEqual({
      empty: "0",
      none: 0,
      other: 0,
      notification: 0,
      once: 1,
      again: 0,
      after: [
        { kind: "edit", subject: "1" },
        { kind: "edit", subject: "2" },
        { kind: "notification", subject: "1" },
        { kind: "edit", subject: "quiet:1" },
      ],
    });
  });
});
