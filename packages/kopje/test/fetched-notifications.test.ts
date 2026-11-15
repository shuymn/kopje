import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { type StoreContext, storeRemoteStatus } from "../src/domain/remote-statuses";
import { totalChanges } from "../src/domain/row-budget";
import { syncCollections } from "../src/federation/collections";
import { verifyQuotes } from "../src/federation/quotes";
import { parseRemoteStatus } from "../src/federation/remote-status";
import { apiHarness, seedAccount, sql } from "./api-helpers";
import { inboxDeps, NOW } from "./app-helpers";
import { fixtureKeyGen, LEGACY_EMPTY_KEK, seedLocalAccount } from "./federation-helpers";
import { LOCAL, mastodonActor, RemoteWeb, type TestActor } from "./inbox-helpers";
import {
  ALICE,
  ALICE_URI,
  announce,
  AS,
  create,
  DAVE,
  DAVE_URI,
  followed,
  localStatus,
  mastodonNote,
  nextId,
  type Note,
  OTHER,
  type Setup,
  setup,
  statusRow,
  token,
} from "./inbox-status-helpers";
import { quoteRequest, quoting, serveFeatured, serveStamp } from "./quote-helpers";
import { observedSql } from "./read-helpers";
import { attr, parseHtml, query } from "./web-dom";
import { postForm, signIn } from "./web-helpers";

// A status Kopje fetches rather than receives notifies as a delivered Create does when it was published within the
// real-time window (Mastodon 4.7.5's Create#distribute, create.rb:92; real-time-window.ts), on every path that stores
// one (docs/visibility.md R15), with the limited condition counted over its to and cc alone.

const HOUR = 60 * 60 * 1000;
const at = (ms: number) => new Date(ms).toISOString();
// Published a minute before it arrives (the clock is NOW), and just outside the window.
const FRESH = at(NOW - 60_000);
const STALE = at(NOW - 7 * HOUR);
const FETCHED: StoreContext = { now: NOW, origin: LOCAL, deliveredTo: null, fetched: true };

// `actor`'s public Note tagging alice and addressing her in cc, published a minute ago.
function tagging(actor: TestActor, extra: Record<string, unknown> = {}): Note {
  return mastodonNote(actor, aliceTagged(actor, extra));
}

function aliceTagged(actor: TestActor, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    published: FRESH,
    content: '<p><a href="https://kopje.test/@alice" class="u-url mention">@alice</a> hi</p>',
    cc: [`${actor.uri}/followers`, ALICE_URI],
    tag: [{ type: "Mention", href: ALICE_URI, name: "@alice" }],
    ...extra,
  };
}

function served(web: RemoteWeb, note: Note): Note {
  web.serve(note.id, { "@context": AS, ...note });
  return note;
}

// The mention notifications of the status `uri`.
const mentionsOf = (t: { store: Setup["store"] }, uri: string) =>
  sql<{ account_id: string; filtered: number }>(
    t.store,
    `SELECT n.account_id, n.filtered FROM notifications n JOIN statuses s ON s.id = n.status_id
		WHERE n.type = 'mention' AND s.uri = ? ORDER BY n.account_id`,
    uri,
  );

// dave follows bob; alice does not.
async function world() {
  const t = await setup();
  const bob = await mastodonActor(t.web, "bob");
  const bobId = await followed(t, bob, DAVE);
  return { t, bob, bobId, author: { id: bobId, uri: bob.uri } };
}

function storeFetched(t: Setup, author: { id: string; uri: string }, note: Note) {
  return runInDurableObject(t.store, (_instance, state) =>
    storeRemoteStatus(new Db(state.storage.sql), author, parseRemoteStatus(note)!, FETCHED),
  );
}

// The job rounds of quote verification and collection syncs, as the Queue and cron run them, until none is due.
async function rounds(t: Setup): Promise<void> {
  const deps = { ...inboxDeps(() => t.store, t.web.loader), now: () => NOW };
  for (let round = 0; ; round++) {
    expect(round).toBeLessThan(20);
    const syncing = await syncCollections(t.env, deps);
    const verifying = await verifyQuotes(t.env, deps);
    if (!syncing && !verifying) {
      return;
    }
  }
}

// Every path of a fetched status (remote-statuses.ts StoreContext.fetched), each storing a Note published a minute
// ago that tags alice; the result is the Note's id.
const PATHS: [string, (t: Setup, bob: TestActor) => Promise<string>][] = [
  [
    "search resolution",
    async (t, bob) => {
      const note = served(t.web, tagging(bob));
      expect((await t.api(`/api/v2/search?resolve=true&q=${encodeURIComponent(note.id)}`, "dave")).status).toBe(200);
      return note.id;
    },
  ],
  [
    "an Announce's embedded self-boost",
    async (t, bob) => {
      const own = tagging(bob);
      expect(await t.post(bob, announce(bob, own.id, { object: own }))).toBe(202);
      return own.id;
    },
  ],
  [
    "an Announce's fetched original",
    async (t, bob) => {
      const erin = await mastodonActor(t.web, "erin", { origin: OTHER, key: 3 });
      const note = served(t.web, tagging(erin));
      expect(await t.post(bob, announce(bob, note.id))).toBe(202);
      return note.id;
    },
  ],
  [
    "an Add to the featured collection",
    async (t, bob) => {
      const note = served(t.web, tagging(bob));
      const add = {
        "@context": AS,
        id: `${bob.uri}#add-${nextId()}`,
        type: "Add",
        actor: bob.uri,
        target: `${bob.uri}/collections/featured`,
        object: note.id,
      };
      expect(await t.post(bob, add)).toBe(202);
      return note.id;
    },
  ],
  [
    "a featured collection sync",
    async (t, bob) => {
      // Storing bob's document (world's Follow) asked for the sync; a round reads the collection.
      const note = served(t.web, tagging(bob));
      serveFeatured(t.web, bob, [note.id]);
      await rounds(t);
      expect(t.web.fetched).toContain(`${bob.uri}/collections/featured`);
      return note.id;
    },
  ],
  [
    "a quote's embedded quoted Note",
    async (t, bob) => {
      const own = tagging(bob);
      expect(await t.post(bob, create(bob, quoting(bob, own.id, null, { quote: own })))).toBe(202);
      return own.id;
    },
  ],
  [
    "a quote's fetched quoted status",
    async (t, bob) => {
      const erin = await mastodonActor(t.web, "erin", { origin: OTHER, key: 3 });
      const target = served(t.web, tagging(erin));
      const stamp = `${erin.uri}/quote_authorizations/${nextId()}`;
      const quote = quoting(bob, target.id, stamp);
      serveStamp(t.web, stamp, erin, quote.id, target.id);
      expect(await t.post(bob, create(bob, quote))).toBe(202);
      await rounds(t);
      return target.id;
    },
  ],
  [
    "a QuoteRequest's instrument",
    async (t, bob) => {
      const mine = await localStatus(t, { status: "quote me", visibility: "public" }, "dave");
      const note = served(t.web, quoting(bob, mine.uri, null, aliceTagged(bob)));
      expect(await t.post(bob, quoteRequest(bob, mine.uri, note.id))).toBe(202);
      return note.id;
    },
  ],
];

describe("a fetched status's notifications (the real-time window, R15)", () => {
  it.each(PATHS)("%s notifies a status published within the window", async (_name, run) => {
    const { t, bob } = await world();
    const uri = await run(t, bob);
    expect(await statusRow(t.store, uri)).toBeDefined();
    expect(await mentionsOf(t, uri)).toEqual([{ account_id: ALICE, filtered: 0 }]);
  });

  it("/authorize_interaction notifies a status published within the window", async () => {
    const web = new RemoteWeb();
    const h = await apiHarness({}, { federation: { keygen: fixtureKeyGen, loader: web.loader } });
    const aliceId = await seedAccount(h.store, { username: "alice", email: "alice@example.com", displayName: "Alice" });
    const aliceUri = (await sql<{ uri: string }>(h.store, "SELECT uri FROM accounts WHERE id = ?", aliceId))[0]!.uri;
    const bob = await mastodonActor(web, "bob");
    const note = served(
      web,
      mastodonNote(bob, {
        published: FRESH,
        content: "<p>@alice hi</p>",
        cc: [`${bob.uri}/followers`, aliceUri],
        tag: [{ type: "Mention", href: aliceUri, name: "@alice" }],
      }),
    );
    const browser = await signIn(h);
    const page = await h.request(`/authorize_interaction?uri=${encodeURIComponent(note.id)}`, {
      headers: { cookie: browser.cookie },
    });
    expect(page.status).toBe(200);
    const form = query(parseHtml(await page.text()), "form").find(
      (f) => attr(f, "action") === "/authorize_interaction",
    )!;
    const fields = new URLSearchParams();
    for (const input of query(form, "input")) {
      fields.append(attr(input, "name") ?? "", attr(input, "value") ?? "");
    }
    expect((await postForm(h, browser, "/authorize_interaction", fields)).status).toBe(200);
    expect(web.fetched).toContain(note.id);
    expect(await mentionsOf(h, note.id)).toEqual([{ account_id: aliceId, filtered: 0 }]);
  });

  it("notifies nobody for a status published more than six hours before it arrived", async () => {
    const { t, bob, author } = await world();
    const late = tagging(bob, { published: at(NOW - 6 * HOUR - 1000) });
    expect(await storeFetched(t, author, late)).toMatchObject({ applied: true, reason: "created" });
    expect(await mentionsOf(t, late.id)).toEqual([]);
    // Control: a minute inside the window.
    const inside = tagging(bob, { published: at(NOW - 6 * HOUR + 60_000) });
    await storeFetched(t, author, inside);
    expect(await mentionsOf(t, inside.id)).toEqual([{ account_id: ALICE, filtered: 0 }]);
  });

  it("takes the window's edge as Mastodon does: published exactly six hours before it arrived is within it", async () => {
    const { t, bob, author } = await world();
    const edge = tagging(bob, { published: at(NOW - 6 * HOUR) });
    await storeFetched(t, author, edge);
    expect(await statusRow(t.store, edge.id)).toMatchObject({ published_at: at(NOW - 6 * HOUR) });
    expect(await mentionsOf(t, edge.id)).toEqual([{ account_id: ALICE, filtered: 0 }]);
  });

  it.each([
    ["missing", null],
    ["unreadable", "not a time"],
    ["before year 0", "-000100-01-01T00:00:00Z"],
    ["in the future", at(NOW + HOUR)],
  ])("counts a published time that is %s as the arrival", async (_name, published) => {
    const { t, bob, author } = await world();
    const note = tagging(bob, { published });
    await storeFetched(t, author, note);
    expect(await statusRow(t.store, note.id)).toMatchObject({ published_at: at(NOW) });
    expect(await mentionsOf(t, note.id)).toEqual([{ account_id: ALICE, filtered: 0 }]);
  });

  it("limits a fetched mention the status does not address", async () => {
    // alice is tagged and left out of to and cc; dave is tagged and addressed. Neither inbox is involved.
    const { t, bob, author, bobId } = await world();
    const note = mastodonNote(bob, {
      published: FRESH,
      cc: [`${bob.uri}/followers`, DAVE_URI],
      tag: [
        { type: "Mention", href: ALICE_URI, name: "@alice" },
        { type: "Mention", href: DAVE_URI, name: "@dave" },
      ],
    });
    await storeFetched(t, author, note);
    expect(await mentionsOf(t, note.id)).toEqual([
      { account_id: ALICE, filtered: 1 },
      { account_id: DAVE, filtered: 0 },
    ]);
    expect(await sql(t.store, "SELECT account_id, from_account_id FROM notification_requests")).toEqual([
      { account_id: ALICE, from_account_id: bobId },
    ]);
  });

  it("limits a fetched mention without the inbox it was delivered to: a QuoteRequest's instrument", async () => {
    // The QuoteRequest comes to alice's own inbox; its instrument tags her without addressing her.
    const { t, bob } = await world();
    const mine = await localStatus(t, { status: "quote me", visibility: "public" }, "dave");
    const note = served(t.web, quoting(bob, mine.uri, null, { ...aliceTagged(bob), cc: [`${bob.uri}/followers`] }));
    expect(await t.post(bob, quoteRequest(bob, mine.uri, note.id), { path: "/ap/users/alice/inbox" })).toBe(202);
    expect(await mentionsOf(t, note.id)).toEqual([{ account_id: ALICE, filtered: 1 }]);
  });

  it("notifies the author's subscribers of a status published within the window, not of one outside it", async () => {
    const { t, bob, author } = await world();
    await sql(t.store, "UPDATE follows SET notify = 1 WHERE account_id = ?", DAVE);
    const posts = (uri: string) =>
      sql(
        t.store,
        `SELECT n.account_id FROM notifications n JOIN statuses s ON s.id = n.status_id
				WHERE n.type = 'status' AND s.uri = ?`,
        uri,
      );
    const fresh = mastodonNote(bob, { published: FRESH });
    const stale = mastodonNote(bob, { published: STALE });
    await storeFetched(t, author, fresh);
    await storeFetched(t, author, stale);
    expect(await posts(fresh.id)).toEqual([{ account_id: DAVE }]);
    expect(await statusRow(t.store, stale.id)).toBeDefined();
    expect(await posts(stale.id)).toEqual([]);
  });

  it("a later delivery notifies nobody again, whether the fetch notified or not", async () => {
    const { t, bob, author } = await world();
    await sql(
      t.store,
      `INSERT INTO push_subscriptions (token_hash, endpoint, key_p256dh, key_auth, alerts, policy)
			SELECT token_hash, 'https://push.example/1', 'p', 'a', '{"mention":true}', 'all' FROM oauth_tokens WHERE account_id = ?`,
      ALICE,
    );
    const ids = (uri: string) =>
      sql<{ id: string }>(
        t.store,
        `SELECT CAST(n.id AS TEXT) AS id FROM notifications n JOIN statuses s ON s.id = n.status_id WHERE s.uri = ?`,
        uri,
      );
    const pushes = async () => (await sql<{ n: number }>(t.store, "SELECT count(*) AS n FROM push_deliveries"))[0]!.n;
    const fresh = tagging(bob);
    await storeFetched(t, author, fresh);
    const first = await ids(fresh.id);
    expect([first.length, await pushes()]).toEqual([1, 1]);
    expect(await t.post(bob, create(bob, fresh), { path: "/ap/users/alice/inbox" })).toBe(202);
    expect([await ids(fresh.id), await pushes()]).toEqual([first, 1]);
    // Fetched outside the window, then delivered: never notified.
    const stale = tagging(bob, { published: STALE });
    await storeFetched(t, author, stale);
    expect(await t.post(bob, create(bob, stale), { path: "/ap/users/alice/inbox" })).toBe(202);
    expect(await statusRow(t.store, stale.id)).toBeDefined();
    expect([await ids(stale.id), await pushes()]).toEqual([[], 1]);
  });

  it("notifies no remote account of a fetched status", async () => {
    const { t, bob, author } = await world();
    const remote = `${OTHER}/users/x`;
    await sql(
      t.store,
      "INSERT INTO accounts (id, uri, username, domain) VALUES ('900000000000000001', ?, 'x', 'other.example')",
      remote,
    );
    const note = tagging(bob, {
      cc: [`${bob.uri}/followers`, ALICE_URI, remote],
      tag: [
        { type: "Mention", href: ALICE_URI, name: "@alice" },
        { type: "Mention", href: remote, name: "@x@other.example" },
      ],
    });
    const runs = await runInDurableObject(t.store, (_instance, state) => {
      let n = 0;
      const counting = observedSql(state.storage.sql, (_rows, query) => {
        n += query.includes("main.notification_permissions") ? 1 : 0;
      });
      storeRemoteStatus(new Db(counting), author, parseRemoteStatus(note)!, FETCHED);
      return n;
    });
    const row = (await statusRow(t.store, note.id))!;
    expect(
      await sql(t.store, "SELECT count(*) AS n FROM status_mentions WHERE status_id = ? AND silent = 0", row.id),
    ).toEqual([{ n: 2 }]);
    // alice's notification alone, its policy read once.
    expect([runs, await mentionsOf(t, note.id)]).toEqual([1, [{ account_id: ALICE, filtered: 0 }]]);
  });
});

describe("the bound of a fetched status's notifications (docs/threat-model.md RES-4)", () => {
  const CAROL = "333333333333333333";
  const ERIN = "444444444444444444";
  const ERIN_URI = `${LOCAL}/ap/users/erin`;

  // alice and dave follow bob, carol follows him with notify, erin does not follow him. alice and carol hold a
  // streaming subscription (user), alice a push subscription for mentions and a mark of the `direct` stream.
  async function boundWorld() {
    const t = await setup();
    for (const [id, username] of [
      [CAROL, "carol"],
      [ERIN, "erin"],
    ] as const) {
      await seedLocalAccount(t.store, "kopje.test", { id, username, key: LEGACY_EMPTY_KEK });
      await token(t.store, id);
    }
    const bob = await mastodonActor(t.web, "bob");
    const bobId = await followed(t, bob, ALICE);
    await sql(
      t.store,
      `INSERT INTO follows (account_id, target_account_id, state, notify)
			VALUES (?1, ?3, 'accepted', 0), (?2, ?3, 'accepted', 1)`,
      DAVE,
      CAROL,
      bobId,
    );
    await sql(
      t.store,
      "INSERT INTO stream_subscriptions (account_id, stream_key, sockets) VALUES (?, 'user', 1), (?, 'user', 1)",
      ALICE,
      CAROL,
    );
    await sql(t.store, "INSERT INTO stream_conversation_marks (account_id, seq) VALUES (?, 0)", ALICE);
    await sql(
      t.store,
      `INSERT INTO push_subscriptions (token_hash, endpoint, key_p256dh, key_auth, alerts, policy)
			SELECT token_hash, 'https://push.example/1', 'p', 'a', '{"mention":true,"status":true}', 'all'
			FROM oauth_tokens WHERE account_id = ?`,
      ALICE,
    );
    return { t, bob, author: { id: bobId, uri: bob.uri } };
  }

  // Stores `note` as fetched, counting the policy statements and the notification inserts (one per notify call that
  // the policy does not drop) and the rows changed (total_changes(): triggers and cascades included).
  function measured(t: Setup, author: { id: string; uri: string }, note: Note) {
    return runInDurableObject(t.store, (_instance, state) => {
      let policies = 0;
      let inserts = 0;
      const db = new Db(
        observedSql(state.storage.sql, (_rows, query) => {
          policies += query.includes("main.notification_permissions") ? 1 : 0;
          inserts += query.includes("INSERT INTO notifications") ? 1 : 0;
        }),
      );
      const before = totalChanges(db);
      expect(storeRemoteStatus(db, author, parseRemoteStatus(note)!, FETCHED)).toMatchObject({ applied: true });
      return { policies, inserts, changes: totalChanges(db) - before };
    });
  }

  // The rows of the tables the notification work writes.
  const COUNTED: Record<string, string> = {
    notification: "SELECT count(*) AS n FROM stream_events WHERE kind = 'notification'",
    conversation: "SELECT count(*) AS n FROM stream_events WHERE kind = 'conversation'",
    conversations: "SELECT count(*) AS n FROM conversations",
    conversation_statuses: "SELECT count(*) AS n FROM conversation_statuses",
    push_deliveries: "SELECT count(*) AS n FROM push_deliveries",
    notification_requests: "SELECT count(*) AS n FROM notification_requests",
    notifications: "SELECT count(*) AS n FROM notifications",
  };
  async function counts(t: Setup): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const [name, query] of Object.entries(COUNTED)) {
      out[name] = (await sql<{ n: number }>(t.store, query))[0]!.n;
    }
    return out;
  }

  it("calls notify once per active local mention and subscriber, reads the policy per mention, writes within the formula", async () => {
    const { t, bob, author } = await boundWorld();
    // Section 5's per-status formula, from the world: P_r is each recipient's push subscriptions.
    const pushesOf = async (id: string) =>
      (
        await sql<{ n: number }>(
          t.store,
          "SELECT count(*) AS n FROM push_subscriptions p JOIN oauth_tokens o ON o.token_hash = p.token_hash WHERE o.account_id = ?",
          id,
        )
      )[0]!.n;
    const formula = async (mentioned: string[], subscribers: string[]) => {
      let n = 0;
      for (const id of mentioned) {
        n += 7 + 2 * (await pushesOf(id));
      }
      for (const id of subscribers) {
        n += 3 + 2 * (await pushesOf(id));
      }
      return n;
    };
    // A direct status tagging and addressing alice, dave and erin; its twin published outside the window is stored
    // first and writes the same rows less the notification work.
    const recipients = [ALICE_URI, DAVE_URI, ERIN_URI];
    const direct = (published: string) =>
      mastodonNote(bob, {
        published,
        to: recipients,
        cc: [],
        tag: recipients.map((href) => ({ type: "Mention", href, name: "@x" })),
      });
    const twin = await measured(t, author, direct(STALE));
    const before = await counts(t);
    const fresh = await measured(t, author, direct(FRESH));
    const after = await counts(t);
    // M = 3 mentions and S = 1 subscriber (carol, who may not see a direct status: notify writes nothing for her):
    // M + S notify calls, M policy statements; the twin makes none.
    expect([twin.policies, twin.inserts]).toEqual([0, 0]);
    expect([fresh.policies, fresh.inserts]).toEqual([3, 4]);
    // Each row the notification work changed: alice's notification, its stream event, her push and her conversation
    // (the mark, its stream event, the conversation and its status); dave's notification and conversation (no mark:
    // he never subscribed to `direct`); erin's notification, filtered (a private mention from an account she does not
    // follow), and her request. No earlier notification of the status, so no hidden row is deleted.
    expect(Object.fromEntries(Object.entries(after).map(([k, v]) => [k, v - before[k]!]))).toEqual({
      notification: 1,
      conversation: 1,
      conversations: 2,
      conversation_statuses: 2,
      push_deliveries: 1,
      notification_requests: 1,
      notifications: 3,
    });
    const work = fresh.changes - twin.changes;
    expect(work).toBe(7 + 3 + 2);
    expect(work).toBeLessThanOrEqual(await formula([ALICE, DAVE, ERIN], [CAROL]));

    // A public status: carol's `status` notification and its stream event; no policy statement for it.
    const open = (published: string) => mastodonNote(bob, { published });
    const openTwin = await measured(t, author, open(STALE));
    const openFresh = await measured(t, author, open(FRESH));
    expect([openFresh.policies, openFresh.inserts]).toEqual([0, 1]);
    expect(openFresh.changes - openTwin.changes).toBe(2);
    expect(openFresh.changes - openTwin.changes).toBeLessThanOrEqual(await formula([], [CAROL]));
  });
});
