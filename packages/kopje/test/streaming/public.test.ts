import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { Db } from "../../src/db/sql";
import { MAX_MEDIA_DESCRIPTION_LENGTH, MAX_STATUS_MEDIA } from "../../src/domain/status-bounds";
import { statusLength } from "../../src/domain/status-text";
import { streamDelete } from "../../src/domain/streaming";
import { ACCOUNT_EMOJIS_BYTES, STATUS_EMOJIS_BYTES } from "../../src/platform/stored-bounds";
import { sha256Hex } from "../../src/security/tokens";
import { STREAM_LIMITS } from "../../src/stream-hub";
import { type ApiHarness, bearer, json, sql } from "../api-helpers";
import { NOW } from "../app-helpers";
import { accountAtCap, statusAtCap } from "../emoji-fixtures";
import { BUILD } from "../helpers";
import {
  act,
  block,
  community,
  domainBlock,
  follow,
  getJson,
  interactWith,
  mute,
  post,
  remoteAccount,
  seedStatus,
  type Status,
} from "../status-helpers";
import {
  described,
  describedMedia,
  encodedTwice,
  type Fill,
  FILLS,
  fillProfile,
  payloadBytes,
  writeFilled,
} from "./payload-fills";
import {
  connect,
  drained,
  echo,
  type Inbox,
  liftInstanceCap,
  settled,
  type StreamMessage,
  subscribed,
  takeAll,
} from "./stream-helpers";

// The `public*` and `hashtag*` streams: `update` and `status.update` when the public
// or the hashtag's timeline positioned at the status returns it (R33), less a status that mentions an account the
// viewer blocks or mutes (Mastodon's per-connection filter), and `delete` of the status, never a boost, on the feeds
// its tombstone matches (R32). Absence is proved with the drain barrier.

const HOUR = 3_600_000;
const PUBLIC = ["public", "public:local", "public:remote", "public:media", "public:local:media", "public:remote:media"];

// The messages left on a socket, as [the stream joined, event, the payload's status id (or the deleted id)].
function events(inbox: Inbox): [string, string | undefined, string][] {
  return inbox.rest().map((m) => [(m.stream ?? []).join(" "), m.event, idOf(m)]);
}

function idOf(m: StreamMessage): string {
  if (m.event === "delete") {
    return m.payload ?? "";
  }
  const payload: unknown = JSON.parse(m.payload ?? "null");
  return typeof payload === "string" ? payload : ((payload as { id?: string } | null)?.id ?? "");
}

// A socket subscribed to every `public*` stream and to the hashtags `tags` on `hashtag` and `hashtag:local`.
async function feeds(h: ApiHarness, token: string, tags: string[] = ["#Cats"]): Promise<Inbox> {
  const inbox = await subscribed(h, token, ...PUBLIC);
  for (const tag of tags) {
    inbox.send({ type: "subscribe", stream: "hashtag", tag });
    inbox.send({ type: "subscribe", stream: "hashtag:local", tag });
  }
  await settled(h, inbox);
  return inbox;
}

// A remote public status written straight to the Store (no turn), arrived `arrivedAgo` before NOW and published
// `publishedAgo` before it arrived, with #cats, and with a shown media attachment when `media`.
let nextRemote = 900000000000000000n;
async function remoteStatus(
  h: ApiHarness,
  author: string,
  options: { media?: boolean; publishedAgo?: number; visibility?: "public" | "unlisted" } = {},
): Promise<string> {
  const id = String(nextRemote++);
  const arrived = new Date(NOW).toISOString();
  await sql(
    h.store,
    `INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, created_at)
		VALUES (?, ?, ?, ?, '<p>#cats</p>', ?, ?)`,
    id,
    `https://remote.example/objects/${id}`,
    author,
    options.visibility ?? "public",
    new Date(NOW - (options.publishedAgo ?? 0)).toISOString(),
    arrived,
  );
  await sql(
    h.store,
    "INSERT INTO status_tags (status_id, name, public) SELECT id, 'cats', visibility = 'public' FROM statuses WHERE id = ?",
    id,
  );
  if (options.media === true) {
    await sql(
      h.store,
      `INSERT INTO media_attachments (id, account_id, status_id, type, url) VALUES (?, ?, ?, 'image', 'https://remote.example/m.png')`,
      String(BigInt(id) + 50000000000000000n),
      author,
      id,
    );
  }
  return id;
}

async function remove(h: ApiHarness, token: string, id: string): Promise<void> {
  const response = await h.request(`/api/v1/statuses/${id}`, bearer(token, { method: "DELETE" }));
  expect(response.status).toBe(200);
}

describe("subscribing to public and hashtag streams", () => {
  it("needs a tag within bounds, echoes it as sent, and keys it normalized", async () => {
    const h = await community(["alice"]);
    const inbox = await connect(h, h.users.alice.token);
    inbox.send({ type: "subscribe", stream: "hashtag" });
    expect(await inbox.next()).toEqual({ error: "Missing tag name parameter", status: 400 });
    inbox.send({ type: "subscribe", stream: "hashtag:local", tag: 7 });
    expect(await inbox.next()).toEqual({ error: "Invalid parameter", status: 400 });
    inbox.send({ type: "subscribe", stream: "hashtag", tag: "x".repeat(257) });
    expect(await inbox.next()).toEqual({ error: "Invalid parameter", status: 400 });
    // Two spellings of one hashtag are one subscription, echoed as first sent.
    inbox.send({ type: "subscribe", stream: "hashtag", tag: "#Cats" });
    inbox.send({ type: "subscribe", stream: "hashtag", tag: "cats" });
    inbox.send({ type: "subscribe", stream: "hashtag:local", tag: "x".repeat(256) });
    inbox.send({ type: "subscribe", stream: "public:remote:media" });
    await settled(h, inbox);
    expect(
      await sql(
        h.store,
        "SELECT stream_key FROM stream_subscriptions WHERE account_id = ? ORDER BY stream_key",
        h.users.alice.id,
      ),
    ).toEqual([
      { stream_key: "hashtag:cats" },
      { stream_key: `hashtag:local:${"x".repeat(256)}` },
      { stream_key: "public:remote:media" },
    ]);
    await post(h, h.users.alice, { status: "hello #CATS", visibility: "public" });
    await drained(h, inbox);
    expect(inbox.rest().map((m) => m.stream)).toEqual([["hashtag", "#Cats"]]);
    await inbox.next();
    // Unsubscribing by another spelling ends it.
    inbox.send({ type: "unsubscribe", stream: "hashtag", tag: "CATS" });
    await settled(h, inbox);
    await post(h, h.users.alice, { status: "again #cats", visibility: "public" });
    await drained(h, inbox);
    expect(inbox.rest()).toEqual([]);
  });
});

describe("update on public and hashtag streams", () => {
  it("sends a public status on the feeds it belongs to, as REST presents it to the viewer", async () => {
    const h = await community(["alice", "bob"]);
    const erin = await remoteAccount(h.store, "erin");
    const inbox = await feeds(h, h.users.alice.token);
    const local = await post(h, h.users.bob, { status: "local #cats", visibility: "public" });
    await drained(h, inbox);
    expect(events(inbox)).toEqual([
      ["public", "update", local.id],
      ["public:local", "update", local.id],
      ["hashtag #Cats", "update", local.id],
      ["hashtag:local #Cats", "update", local.id],
    ]);
    const rest = await getJson<Status>(h, `/api/v1/statuses/${local.id}`, h.users.alice.token);
    expect(JSON.parse((await inbox.next()).payload!)).toEqual(rest.body);
    for (let i = 0; i < 3; i++) {
      await inbox.next();
    }

    const remote = await remoteStatus(h, erin, { media: true });
    await h.store.streamTick(BUILD);
    await drained(h, inbox);
    expect(events(inbox)).toEqual([
      ["public", "update", remote],
      ["public:remote", "update", remote],
      ["public:media", "update", remote],
      ["public:remote:media", "update", remote],
      ["hashtag #Cats", "update", remote],
    ]);
  });

  it("leaves out what the timelines leave out: unlisted, private, boosts, and on public replies to others", async () => {
    const h = await community(["alice", "bob", "carol"]);
    const inbox = await feeds(h, h.users.alice.token);
    const parent = await post(h, h.users.carol, { status: "parent", visibility: "unlisted" });
    await post(h, h.users.bob, { status: "unlisted #cats", visibility: "unlisted" });
    await post(h, h.users.bob, { status: "private #cats", visibility: "private" });
    const boosted = await post(h, h.users.carol, { status: "boosted #cats", visibility: "public" });
    await drained(h, inbox);
    await takeAll(inbox);
    expect((await act(h, h.users.bob, `/api/v1/statuses/${boosted.id}/reblog`)).status).toBe(200);
    // A reply to someone else: not on public, but on its hashtags (Mastodon's TagFeed and hashtag streams keep
    // replies).
    const reply = await post(h, h.users.bob, {
      status: "reply #cats",
      visibility: "public",
      in_reply_to_id: parent.id,
    });
    await drained(h, inbox);
    expect(events(inbox)).toEqual([
      ["hashtag #Cats", "update", reply.id],
      ["hashtag:local #Cats", "update", reply.id],
    ]);
    await takeAll(inbox);
    // A reply in the author's own thread is in the public timeline.
    const own = await post(h, h.users.bob, { status: "own", visibility: "public" });
    const thread = await post(h, h.users.bob, { status: "thread", visibility: "public", in_reply_to_id: own.id });
    await drained(h, inbox);
    expect(events(inbox)).toEqual([
      ["public", "update", own.id],
      ["public:local", "update", own.id],
      ["public", "update", thread.id],
      ["public:local", "update", thread.id],
    ]);
  });

  it("needs read:statuses", async () => {
    const h = await community(["alice", "bob"], "read:notifications write");
    const inbox = await connect(h, h.users.alice.token);
    inbox.send({ type: "subscribe", stream: "public" });
    expect(await inbox.next()).toEqual({ error: "Access token does not have the required scopes", status: 401 });
    inbox.send({ type: "subscribe", stream: "hashtag", tag: "cats" });
    expect(await inbox.next()).toEqual({ error: "Access token does not have the required scopes", status: 401 });
    await settled(h, inbox);
    expect(await sql(h.store, "SELECT count(*) AS n FROM stream_subscriptions")).toEqual([{ n: 0 }]);
  });

  it("filters per viewer: blocks and mutes of the author and the mentioned, the author's block, domain blocks", async () => {
    const h = await community(["alice", "bob", "carol", "dave", "erin", "frank"]);
    const far = await remoteAccount(h.store, "far", "far.example");
    const inbox = await feeds(h, h.users.alice.token);
    await block(h.store, h.users.alice.id, h.users.bob.id);
    await mute(h.store, h.users.alice.id, h.users.carol.id);
    await block(h.store, h.users.dave.id, h.users.alice.id);
    await domainBlock(h.store, h.users.alice.id, "far.example");
    await block(h.store, h.users.alice.id, h.users.erin.id);
    await post(h, h.users.bob, { status: "blocked #cats", visibility: "public" });
    await post(h, h.users.carol, { status: "muted #cats", visibility: "public" });
    await post(h, h.users.dave, { status: "blocks alice #cats", visibility: "public" });
    await remoteStatus(h, far);
    // Mentions of an account alice blocks, and of one she mutes.
    await post(h, h.users.frank, { status: "hi @erin #cats", visibility: "public" });
    await post(h, h.users.frank, { status: "hi @carol #cats", visibility: "public" });
    await h.store.streamTick(BUILD);
    await drained(h, inbox);
    expect(events(inbox)).toEqual([]);
    // The same in REST: neither the public timeline nor the hashtag's shows them but the mentions (a stream-only
    // filter, as Mastodon's).
    const control = await post(h, h.users.frank, { status: "shown #cats", visibility: "public" });
    await drained(h, inbox);
    expect(events(inbox).map(([stream]) => stream)).toEqual([
      "public",
      "public:local",
      "hashtag #Cats",
      "hashtag:local #Cats",
    ]);
    expect(events(inbox).every(([, , id]) => id === control.id)).toBe(true);
  });

  it("reports a matching keyword filter in `filtered`, as REST does", async () => {
    const h = await community(["alice", "bob"]);
    const created = await h.request(
      "/api/v2/filters",
      bearer(
        h.users.alice.token,
        json({
          title: "Spoilers",
          context: ["public"],
          filter_action: "hide",
          keywords_attributes: [{ keyword: "finale" }],
        }),
      ),
    );
    expect(created.status).toBe(200);
    const inbox = await subscribed(h, h.users.alice.token, "public");
    const status = await post(h, h.users.bob, { status: "the finale", visibility: "public" });
    await drained(h, inbox);
    const sent = JSON.parse((await inbox.next()).payload!) as Status & { filtered: { filter: { title: string } }[] };
    expect(sent.filtered.map((result) => result.filter.title)).toEqual(["Spoilers"]);
    const rest = await getJson<Status>(h, `/api/v1/statuses/${status.id}`, h.users.alice.token);
    expect(sent).toEqual(rest.body);
  });

  it("leaves out a status published more than 6 hours before it arrived (the real-time window)", async () => {
    const h = await community(["alice"]);
    const erin = await remoteAccount(h.store, "erin");
    const inbox = await feeds(h, h.users.alice.token);
    await remoteStatus(h, erin, { publishedAgo: 6 * HOUR + 1000 });
    const fresh = await remoteStatus(h, erin, { publishedAgo: 6 * HOUR - 1000 });
    await h.store.streamTick(BUILD);
    await drained(h, inbox);
    expect(events(inbox)).toEqual([
      ["public", "update", fresh],
      ["public:remote", "update", fresh],
      ["hashtag #Cats", "update", fresh],
    ]);
  });

  it("sends an edit as status.update on the feeds that show it", async () => {
    const h = await community(["alice", "bob"]);
    const status = await post(h, h.users.bob, { status: "before #cats", visibility: "public" });
    const inbox = await feeds(h, h.users.alice.token);
    const response = await h.request(
      `/api/v1/statuses/${status.id}`,
      bearer(h.users.bob.token, json({ status: "after #cats" }, { method: "PUT" })),
    );
    expect(response.status).toBe(200);
    await drained(h, inbox);
    expect(events(inbox)).toEqual([
      ["public", "status.update", status.id],
      ["public:local", "status.update", status.id],
      ["hashtag #Cats", "status.update", status.id],
      ["hashtag:local #Cats", "status.update", status.id],
    ]);
  });

  // A departure (mastodon-deviations.md, feed streams): Mastodon renders these streams once with no viewer.
  it("a feed carries the subscriber's own fields, as REST shows them", async () => {
    const h = await community(["alice", "bob"]);
    const status = await post(h, h.users.bob, {
      status: "before #cats",
      visibility: "public",
      quote_approval_policy: "public",
      poll: { options: ["yes", "no"], expires_in: 3600 },
    });
    const poll = (status as Status & { poll: { id: string } }).poll.id;
    await interactWith(h, h.users.alice, status.id);
    expect((await act(h, h.users.alice, `/api/v1/polls/${poll}/votes`, { choices: [1] })).status).toBe(200);
    const filter = await h.request(
      "/api/v2/filters",
      bearer(
        h.users.alice.token,
        json({
          title: "Later",
          context: ["public"],
          filter_action: "warn",
          keywords_attributes: [{ keyword: "after" }],
        }),
      ),
    );
    expect(filter.status).toBe(200);
    const inbox = await subscribed(h, h.users.alice.token, "public:local");
    inbox.send({ type: "subscribe", stream: "hashtag", tag: "cats" });
    await settled(h, inbox);
    // The fan-out presents at the Store's clock, the API at NOW: the same instant, so the poll reads the same.
    const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
    try {
      const edited = await h.request(
        `/api/v1/statuses/${status.id}`,
        bearer(
          h.users.bob.token,
          json(
            { status: "after #cats", poll: { options: ["yes", "no"], expires_in: 3600, multiple: false } },
            { method: "PUT" },
          ),
        ),
      );
      expect(edited.status).toBe(200);
      await drained(h, inbox);
    } finally {
      clock.mockRestore();
    }
    expect(events(inbox)).toEqual([
      ["public:local", "status.update", status.id],
      ["hashtag cats", "status.update", status.id],
    ]);
    const rest = await getJson<Status>(h, `/api/v1/statuses/${status.id}`, h.users.alice.token);
    expect(rest.body).toMatchObject({
      favourited: true,
      reblogged: true,
      bookmarked: true,
      poll: { voted: true, own_votes: [1] },
      quote_approval: { current_user: "automatic" },
      filtered: [{ filter: { title: "Later" }, keyword_matches: ["after"] }],
    });
    for (let i = 0; i < 2; i++) {
      expect(JSON.parse((await inbox.next()).payload!)).toEqual(rest.body);
    }
  });
});

// missing_attribution follows the subscriber's relationship fields here (favourited, reblogged, bookmarked), which
// Kopje presents for the subscriber where Mastodon's anonymous payload leaves them out (#1625).
describe("missing_attribution on public and hashtag streams", () => {
  it("is present exactly when the payload's favourited is, true for the card's unverified author only", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    const erin = await remoteAccount(h.store, "erin");
    const inboxes: [string, Inbox][] = [
      [alice.id, await feeds(h, alice.token)],
      [bob.id, await feeds(h, bob.token)],
    ];
    const id = await remoteStatus(h, erin);
    await sql(
      h.store,
      `INSERT INTO status_cards (status_id, url, enqueued_at, generation, title, fetched_at, unverified_author_account_id)
			VALUES (?, 'https://e.example/a', 0, 0, 'T', 1, ?)`,
      id,
      alice.id,
    );
    await h.store.streamTick(BUILD);
    await drained(h, ...inboxes.map(([, inbox]) => inbox));
    for (const [viewer, inbox] of inboxes) {
      const sent = inbox.rest();
      expect(sent.map((m) => m.stream?.[0])).toEqual(["public", "public:remote", "hashtag"]);
      for (const message of sent) {
        const payload = JSON.parse(message.payload!) as { favourited?: boolean; card: Record<string, unknown> };
        expect(payload.card, viewer).toMatchObject({ title: "T", missing_attribution: viewer === alice.id });
        expect("missing_attribution" in payload.card).toBe("favourited" in payload);
      }
    }
  });
});

describe("custom emoji on public streams (RES-2)", () => {
  // RES-3: a status and author at their presented emoji bounds are streamed whole within the payload bound.
  it("sends a status and its author with their emojis at the bound", async () => {
    const h = await community(["alice"]);
    const erin = await remoteAccount(h.store, "erin");
    const inbox = await feeds(h, h.users.alice.token);
    const status = await remoteStatus(h, erin);
    await sql(h.store, "UPDATE statuses SET emojis = ? WHERE id = ?", JSON.stringify(statusAtCap()), status);
    await sql(h.store, "UPDATE accounts SET emojis = ? WHERE id = ?", JSON.stringify(accountAtCap()), erin);
    await h.store.streamTick(BUILD);
    await drained(h, inbox);
    expect(events(inbox)[0]).toEqual(["public", "update", status]);
    const sent = (await inbox.next()).payload!;
    const payload = JSON.parse(sent) as { emojis: unknown[]; account: { emojis: unknown[] } };
    expect([payload.emojis.length, payload.account.emojis.length]).toEqual([11, 6]);
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
    expect([bytes(payload.emojis), bytes(payload.account.emojis)]).toEqual([STATUS_EMOJIS_BYTES, ACCOUNT_EMOJIS_BYTES]);
    expect(new TextEncoder().encode(sent).length).toBeLessThan(STREAM_LIMITS.payloadBytes);
  });
});

describe("delete on public and hashtag streams", () => {
  it("sends the delete of a public status on the feeds its tombstone matches, and of no boost or non-public status", async () => {
    const h = await community(["alice", "bob", "carol"]);
    const status = await post(h, h.users.bob, { status: "gone #cats", visibility: "public" });
    const unlisted = await post(h, h.users.bob, { status: "unlisted #cats", visibility: "unlisted" });
    const boosted = await post(h, h.users.carol, { status: "boosted", visibility: "public" });
    expect((await act(h, h.users.bob, `/api/v1/statuses/${boosted.id}/reblog`)).status).toBe(200);
    const inbox = await feeds(h, h.users.alice.token, ["#Cats", "dogs"]);
    await remove(h, h.users.bob.token, unlisted.id);
    expect((await act(h, h.users.bob, `/api/v1/statuses/${boosted.id}/unreblog`)).status).toBe(200);
    await drained(h, inbox);
    expect(events(inbox)).toEqual([]);
    expect(await sql(h.store, "SELECT count(*) AS n FROM stream_events WHERE kind = 'delete'")).toEqual([{ n: 0 }]);

    await remove(h, h.users.bob.token, status.id);
    await drained(h, inbox);
    expect(inbox.rest()).toEqual([
      { stream: ["public"], event: "delete", payload: status.id },
      { stream: ["public:local"], event: "delete", payload: status.id },
      { stream: ["hashtag", "#Cats"], event: "delete", payload: status.id },
      { stream: ["hashtag:local", "#Cats"], event: "delete", payload: status.id },
    ]);
  });

  it("matches remote, media and hashtag facts, and sends a boost delete on user only", async () => {
    const h = await community(["alice", "bob"]);
    const erin = await remoteAccount(h.store, "erin");
    const status = await remoteStatus(h, erin, { media: true });
    const plain = await remoteStatus(h, erin);
    await sql(h.store, "DELETE FROM status_tags WHERE status_id = ?", plain);
    const boost = await seedStatus(h.store, { accountId: h.users.bob.id, visibility: "public", reblogOfId: plain });
    await sql(
      h.store,
      "INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
      h.users.alice.id,
      h.users.bob.id,
    );
    const inbox = await feeds(h, h.users.alice.token, ["cats", "dogs"]);
    inbox.send({ type: "subscribe", stream: "user" });
    await settled(h, inbox);
    for (const id of [status, plain]) {
      await runInDurableObject(h.store, (_instance, state) => {
        state.storage.transactionSync(() => streamDelete(new Db(state.storage.sql), id, NOW));
      });
    }
    await h.store.streamTick(BUILD);
    await drained(h, inbox);
    // Each unit's messages go in the socket's subscription order (`user` last).
    expect(inbox.rest()).toEqual([
      { stream: ["public"], event: "delete", payload: status },
      { stream: ["public:remote"], event: "delete", payload: status },
      { stream: ["public:media"], event: "delete", payload: status },
      { stream: ["public:remote:media"], event: "delete", payload: status },
      { stream: ["hashtag", "cats"], event: "delete", payload: status },
      { stream: ["user"], event: "delete", payload: status },
      // Without media or hashtags; its boost goes on user alone.
      { stream: ["public"], event: "delete", payload: plain },
      { stream: ["public:remote"], event: "delete", payload: plain },
      { stream: ["user"], event: "delete", payload: plain },
      { stream: ["user"], event: "delete", payload: boost },
    ]);
  });

  it("sends a delete to a viewer the status could be viewed by, not to one its author blocks", async () => {
    const h = await community(["alice", "bob", "carol"]);
    const status = await post(h, h.users.bob, { status: "gone", visibility: "public" });
    const alice = await subscribed(h, h.users.alice.token, "public");
    const carol = await subscribed(h, h.users.carol.token, "public");
    await block(h.store, h.users.bob.id, h.users.carol.id);
    await remove(h, h.users.bob.token, status.id);
    await drained(h, alice, carol);
    expect(events(alice)).toEqual([["public", "delete", status.id]]);
    expect(events(carol)).toEqual([]);
  });
});

// `count` local accounts (ids 5 then 17 digits), each with a token of its own `feed-<id>` (read).
async function viewers(h: ApiHarness, count: number): Promise<string[]> {
  await sql(
    h.store,
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
		INSERT INTO accounts (id, uri, username) SELECT printf('5%017d', i), 'https://kopje.test/ap/users/v' || i, 'v' || i FROM n`,
    count,
  );
  await sql(
    h.store,
    `INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey)
		SELECT id, username || '@mail.example', x'00', x'00', 'k' FROM accounts WHERE id GLOB '5*'`,
  );
  const ids = Array.from({ length: count }, (_, i) => `5${String(i + 1).padStart(17, "0")}`);
  for (const id of ids) {
    await sql(
      h.store,
      "INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) SELECT ?, 'access', client_id, ?, 'read' FROM oauth_tokens LIMIT 1",
      await sha256Hex(`feed-${id}`),
      id,
    );
  }
  return ids;
}

describe("feeds at the caps", () => {
  // 256 sockets (the instance's cap), each of its own account and token, on `public` and `hashtag` #cats: a turn's
  // token sweep takes 256 checks of its 512 and each unit at most 64 presentations, so one status takes several turns,
  // each within its budget, each socket sent each message once.
  it("sends a status and its delete to 256 sockets on distinct tokens, once each, over several turns", async () => {
    onTestFinished(liftInstanceCap()); // rounds at 256 sockets, not the output cap (RES-6)
    const h = await community(["author"]);
    const ids = await viewers(h, 256);
    const inboxes: Inbox[] = [];
    for (const id of ids) {
      const inbox = await connect(h, `feed-${id}`);
      inbox.send({ type: "subscribe", stream: "public" });
      inbox.send({ type: "subscribe", stream: "hashtag", tag: "cats" });
      inboxes.push(inbox);
    }
    for (const inbox of inboxes) {
      await echo(inbox);
    }
    const before = (await drained(h)).turns;
    const status = await post(h, h.users.author, { status: "for everyone #cats", visibility: "public" });
    const sent = await drained(h, ...inboxes);
    for (const inbox of inboxes) {
      expect(events(inbox)).toEqual([
        ["public", "update", status.id],
        ["hashtag cats", "update", status.id],
      ]);
      await inbox.next();
      await inbox.next();
    }
    // 256 presentations, at most 64 a turn.
    expect(sent.turns - before).toBeGreaterThanOrEqual(4);
    await remove(h, h.users.author.token, status.id);
    await drained(h, ...inboxes);
    for (const inbox of inboxes) {
      expect(events(inbox)).toEqual([
        ["public", "delete", status.id],
        ["hashtag cats", "delete", status.id],
      ]);
    }
  }, 120_000);
});

// docs/mastodon-deviations.md, "Streaming." (D8 of #1584): local statuses with descriptions at
// MAX_MEDIA_DESCRIPTION_LENGTH (payload-fills.ts) beside text, a poll and profiles at their limits. An event is sent
// while its payload (the presented subject encoded twice) is within STREAM_LIMITS.payloadBytes, and skipped and logged
// past it; REST shows the status whole either way. R is a payload less its descriptions' bytes. A description of
// MAX_MEDIA_DESCRIPTION_LENGTH code points takes 10,000 bytes of ASCII, 40,000 of emoji and 70,000 of U+0001.
describe("payloads with descriptions at their length (D8)", () => {
  // R of the plain fill's S2 update and of carol's boost of S2 (pinned by "sends ... beside plain text").
  const PLAIN_R = { quote: 141_013, boost: 179_143 };

  // A world: alice and carol with the fill's profile, bob following carol, on public:local and user; console.warn
  // spied for the hub's skips.
  async function world(fill: Fill) {
    const h = await community(["alice", "bob", "carol"]);
    const { alice, bob, carol } = h.users;
    await fillProfile(h, alice, fill);
    await fillProfile(h, carol, fill);
    await follow(h, bob, carol.id);
    const inbox = await subscribed(h, bob.token, "public:local", "user");
    await takeAll(inbox);
    return { h, alice, bob, carol, inbox };
  }
  type World = Awaited<ReturnType<typeof world>>;

  const skips = (warn: { mock: { calls: unknown[][] } }) =>
    warn.mock.calls.filter(([entry]) => (entry as { event?: string })?.event === "kopje.stream.payload-skipped");

  // The status `id` as REST presents it to bob, as sent.
  async function shownJson(w: World, id: string): Promise<string> {
    const response = await w.h.request(`/api/v1/statuses/${id}`, bearer(w.bob.token));
    expect(response.status).toBe(200);
    return response.text();
  }

  // alice's S1 with the first four descriptions and S2 quoting it with the last four, both of the fill, written
  // straight to the Store; then carol's boost of S2 through the API. Each is streamed by its own turn, and read through
  // REST once streamed (S2 before it is boosted, as its frame shows it).
  async function scene(w: World, fill: Fill, descriptions: readonly string[]) {
    const media = await describedMedia(w.h, w.alice, descriptions);
    await drained(w.h, w.inbox);
    const quoted = await writeFilled(w.h, w.alice, fill, media.slice(0, MAX_STATUS_MEDIA));
    const quote = await writeFilled(w.h, w.alice, fill, media.slice(MAX_STATUS_MEDIA), quoted);
    await w.h.store.streamTick(BUILD);
    await drained(w.h, w.inbox);
    const quoteJson = await shownJson(w, quote);
    const response = await act(w.h, w.carol, `/api/v1/statuses/${quote}/reblog`);
    expect(response.status).toBe(200);
    const boost = (await response.json<Status>()).id;
    await drained(w.h, w.inbox);
    return { quoted, quote, boost, json: { quote: quoteJson, boost: await shownJson(w, boost) } };
  }

  // A status's JSON as REST presents it to bob: the payload the hub makes of it, R, and its descriptions.
  function measured(json: string, descriptions: readonly string[]) {
    const payload = payloadBytes(json);
    const parsed = JSON.parse(json) as Status & { reblog: Status | null };
    const shown = parsed.reblog ?? parsed;
    const quotedShown = (shown as { quote?: { quoted_status?: Status } | null }).quote?.quoted_status;
    const attached = (s: Status | undefined) =>
      ((s?.media_attachments ?? []) as { description: string }[]).map((m) => m.description);
    return {
      json,
      payload,
      rest: payload - descriptions.reduce((sum, d) => sum + encodedTwice(d), 0),
      descriptions: [...attached(quotedShown), ...attached(shown)],
    };
  }

  // The update frames bob received, by status id.
  const frames = (inbox: Inbox) =>
    new Map(
      inbox
        .rest()
        .filter((m) => m.event === "update")
        .map((m) => [idOf(m), m]),
    );

  it("sends a status and its quote, and its boost, with ASCII descriptions beside plain text, a poll and profiles", async () => {
    const w = await world(FILLS.plain);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const descriptions = [...described("a"), ...described("a")];
      const { quote, boost, json } = await scene(w, FILLS.plain, descriptions);
      const sent = frames(w.inbox);
      const rests: Record<string, number> = {};
      for (const [name, id, stream] of [
        ["quote", quote, "public:local"],
        ["boost", boost, "user"],
      ] as const) {
        const shown = measured(json[name], descriptions);
        expect(sent.get(id)?.stream).toEqual([stream]);
        expect(sent.get(id)?.payload).toBe(shown.json);
        expect(shown.descriptions).toEqual(descriptions);
        expect(shown.payload).toBeLessThanOrEqual(STREAM_LIMITS.payloadBytes);
        rests[name] = shown.rest;
      }
      expect(rests).toEqual(PLAIN_R);
      expect(skips(warn)).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  }, 120_000);

  // Past the limit, the frame is missing and the skip logged; S1 alone still fits. Expanding text: three long links in
  // each status (links), then also each profile field and poll choice (every). R past 260,096 less the descriptions'
  // 80,000 bytes.
  it.each([
    ["links", FILLS.links, { quote: 281_183, boost: 319_313 }],
    ["every", FILLS.every, { quote: 327_221, boost: 388_174 }],
  ] as const)(
    "skips a status and its quote, and its boost, whose %s fill takes the rest past it",
    async (_name, fill, rests) => {
      expect(statusLength(fill.text, fill.spoiler)).toBe(71);
      const w = await world(fill);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const descriptions = [...described("a"), ...described("a")];
        const { quoted, json } = await scene(w, fill, descriptions);
        expect([...frames(w.inbox).keys()]).toEqual([quoted]);
        expect(skips(warn)).toHaveLength(2);
        const shown = { quote: measured(json.quote, descriptions), boost: measured(json.boost, descriptions) };
        expect(shown.quote.descriptions).toEqual(descriptions);
        expect(shown.boost.descriptions).toEqual(descriptions);
        expect({ quote: shown.quote.rest, boost: shown.boost.rest }).toEqual(rests);
      } finally {
        warn.mockRestore();
      }
    },
    120_000,
  );

  // Beside plain text, a poll and profiles, S1 with four emoji descriptions (160,000 bytes) fits, and S2 with eight
  // (320,000) and its boost do not.
  it("skips a status and its quote, and its boost, whose descriptions are emoji", async () => {
    const w = await world(FILLS.plain);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const descriptions = [...described("\u{1F600}"), ...described("\u{1F600}")];
      const { quoted, json } = await scene(w, FILLS.plain, descriptions);
      expect([...frames(w.inbox).keys()]).toEqual([quoted]);
      expect(skips(warn)).toHaveLength(2);
      const shown = measured(json.quote, descriptions);
      expect(shown.descriptions).toEqual(descriptions);
      expect({ quote: shown.rest, boost: measured(json.boost, descriptions).rest }).toEqual(PLAIN_R);
    } finally {
      warn.mockRestore();
    }
  }, 120_000);

  // RES-6: a unit past the limit is measured from its presented object and skipped with no string made. JSON.stringify
  // is spied while the turn runs (the Store shares the test's isolate): the hub encodes the presented status it sends
  // (S1, within the limit) and never the one it skips (S2, its descriptions emoji).
  it("skips a unit past the limit without encoding its payload", async () => {
    const w = await world(FILLS.plain);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const descriptions = [...described("\u{1F600}"), ...described("\u{1F600}")];
      const media = await describedMedia(w.h, w.alice, descriptions);
      await drained(w.h, w.inbox);
      const quoted = await writeFilled(w.h, w.alice, FILLS.plain, media.slice(0, MAX_STATUS_MEDIA));
      const quote = await writeFilled(w.h, w.alice, FILLS.plain, media.slice(MAX_STATUS_MEDIA), quoted);
      const stringify = vi.spyOn(JSON, "stringify");
      let encoded: unknown[];
      try {
        await w.h.store.streamTick(BUILD);
        await drained(w.h, w.inbox);
        encoded = stringify.mock.calls.flatMap(([value]) =>
          typeof value === "object" && value !== null && "media_attachments" in value ? [(value as Status).id] : [],
        );
      } finally {
        stringify.mockRestore();
      }
      expect(encoded).toEqual([quoted]);
      expect([...frames(w.inbox).keys()]).toEqual([quoted]);
      expect(skips(warn)).toHaveLength(1);
      // The quote is the unit skipped: its payload, as REST shows it, passes the limit.
      expect(payloadBytes(await shownJson(w, quote))).toBeGreaterThan(STREAM_LIMITS.payloadBytes);
    } finally {
      warn.mockRestore();
    }
  }, 120_000);

  // From the plain fill's payload P with ASCII descriptions, ⌈(t - P) / 3⌉ of their characters are raised (+3 bytes
  // each): 3a - (t - P) of those become U+3042 (+2) and the rest U+1F600 (+3), description by description, each keeping
  // its MAX_MEDIA_DESCRIPTION_LENGTH code points: the payload is t, sent at the limit and skipped one byte past it.
  it.each([
    ["at", 0],
    ["one byte past", 1],
  ] as const)(
    "sends an event %s the limit, measured in UTF-8 bytes, and skips one past it",
    async (_name, past) => {
      const plain = PLAIN_R.quote + 2 * MAX_STATUS_MEDIA * encodedTwice("a".repeat(MAX_MEDIA_DESCRIPTION_LENGTH));
      const target = STREAM_LIMITS.payloadBytes + past;
      const gap = target - plain;
      const raised = Math.ceil(gap / 3);
      const kana = 3 * raised - gap;
      expect(gap).toBeGreaterThan(0);
      expect(raised).toBeLessThanOrEqual(2 * MAX_STATUS_MEDIA * MAX_MEDIA_DESCRIPTION_LENGTH);
      let left = { emoji: raised - kana, kana };
      const descriptions = Array.from({ length: 2 * MAX_STATUS_MEDIA }, () => {
        const e = Math.min(left.emoji, MAX_MEDIA_DESCRIPTION_LENGTH);
        const k = Math.min(left.kana, MAX_MEDIA_DESCRIPTION_LENGTH - e);
        left = { emoji: left.emoji - e, kana: left.kana - k };
        return "\u{1F600}".repeat(e) + "あ".repeat(k) + "a".repeat(MAX_MEDIA_DESCRIPTION_LENGTH - e - k);
      });
      const w = await world(FILLS.plain);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const { quoted, quote, json } = await scene(w, FILLS.plain, descriptions);
        const shown = measured(json.quote, descriptions);
        expect([shown.payload, shown.rest]).toEqual([target, PLAIN_R.quote]);
        expect(shown.descriptions).toEqual(descriptions);
        // Within the limit in UTF-16 code units either way: admission measures UTF-8 bytes.
        expect(JSON.stringify(shown.json).length).toBeLessThanOrEqual(STREAM_LIMITS.payloadBytes);
        const sent = frames(w.inbox);
        expect(sent.has(quote)).toBe(past === 0);
        expect(sent.has(quoted)).toBe(true);
        if (past === 0) {
          expect(sent.get(quote)?.payload).toBe(shown.json);
        } else {
          expect(skips(warn).length).toBeGreaterThanOrEqual(1);
        }
      } finally {
        warn.mockRestore();
      }
    },
    120_000,
  );

  // A notification is skipped the same way: one whose status has four descriptions of control characters passes the
  // limit, is logged with its kind, and the notifications list shows it.
  it("skips a notification past the limit, which the notifications list shows", async () => {
    const w = await world(FILLS.plain);
    const notified = await subscribed(w.h, w.alice.token, "user:notification");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const media = await describedMedia(w.h, w.alice, described("\u0001"));
      const status = await writeFilled(w.h, w.alice, FILLS.plain, media);
      await w.h.store.streamTick(BUILD);
      await drained(w.h, w.inbox, notified);
      warn.mockClear();
      expect((await act(w.h, w.bob, `/api/v1/statuses/${status}/favourite`)).status).toBe(200);
      await drained(w.h, w.inbox, notified);
      expect(notified.rest().filter((m) => m.event === "notification")).toEqual([]);
      expect(skips(warn).map(([entry]) => (entry as { kind?: string }).kind)).toEqual(["notification"]);
      const listed = await getJson<{ type: string; status: { id: string } | null }[]>(
        w.h,
        "/api/v1/notifications",
        w.alice.token,
      );
      expect(listed.body.map((n) => [n.type, n.status?.id])).toEqual([["favourite", status]]);
    } finally {
      warn.mockRestore();
    }
  }, 120_000);

  // A status that quotes nothing has four descriptions: emoji at their length (160,000 bytes) fit while R is at most
  // 100,096, as the plain fill's status's is and its boost's is not; control characters (280,000) never fit.
  it("sends a status without a quote with emoji descriptions, and skips its boost and one with control characters", async () => {
    const w = await world(FILLS.plain);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const descriptions = described("\u{1F600}");
      const controls = described("\u0001");
      const media = await describedMedia(w.h, w.alice, [...descriptions, ...controls]);
      await drained(w.h, w.inbox);
      const status = await writeFilled(w.h, w.alice, FILLS.plain, media.slice(0, MAX_STATUS_MEDIA));
      const controlled = await writeFilled(w.h, w.alice, FILLS.plain, media.slice(MAX_STATUS_MEDIA));
      await w.h.store.streamTick(BUILD);
      await drained(w.h, w.inbox);
      const statusJson = await shownJson(w, status);
      const response = await act(w.h, w.carol, `/api/v1/statuses/${status}/reblog`);
      const boost = (await response.json<Status>()).id;
      await drained(w.h, w.inbox);
      const shown = {
        status: measured(statusJson, descriptions),
        boost: measured(await shownJson(w, boost), descriptions),
        controlled: measured(await shownJson(w, controlled), controls),
      };
      expect([...frames(w.inbox).keys()]).toEqual([status]);
      expect(frames(w.inbox).get(status)?.payload).toBe(shown.status.json);
      expect(skips(warn)).toHaveLength(2);
      expect(shown.status.descriptions).toEqual(descriptions);
      expect(shown.controlled.descriptions).toEqual(controls);
      expect({
        status: [shown.status.rest, shown.status.payload],
        boost: [shown.boost.rest, shown.boost.payload],
        controlled: [shown.controlled.rest, shown.controlled.payload],
      }).toEqual({ status: [70_328, 230_328], boost: [108_458, 268_458], controlled: [70_328, 350_328] });
    } finally {
      warn.mockRestore();
    }
  }, 120_000);
});
