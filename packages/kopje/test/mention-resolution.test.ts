import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ResolvedAddress } from "../src/domain/mention-addresses";
import { postStatus } from "../src/domain/scheduled-statuses";
import { mentionBudget } from "../src/federation/loader";
import { publishScheduled } from "../src/jobs/scheduled";
import { sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { blockDomain } from "./domain-block-helpers";
import { BUILD } from "./helpers";
import { mastodonActor, serveWebFinger } from "./inbox-helpers";
import { ALICE, AS, DAVE, mastodonNote, PUBLIC } from "./inbox-status-helpers";
import { storeClock } from "./media-helpers";
import {
  accountAt,
  accountCount,
  inboxes,
  mentionLink,
  mentionWorld,
  type MentionWorld,
  type StoreWrap,
  plainActor,
  posted,
  splitDomain,
  webfinger,
} from "./mention-helpers";

// Posting, scheduling and editing resolve the unknown `@user@host` addresses of their text before the write (#1558,
// domain/mention-addresses.ts, federation/resolve.ts createAddressResolver), as Mastodon 4.7.5's ProcessMentionsService
// resolves them, but for the departures docs/mastodon-deviations.md lists under Posting: only the typed address's own
// account is mentioned, at most MENTION_ADDRESSES_PER_POST a request, a domain the author blocks is not fetched, a
// scheduled post resolves when it is scheduled, and a 410 deletes nothing. A failed resolution never fails the post.

const MINUTE = 60_000;
const at = (ms: number) => new Date(ms).toISOString();

const holds: { release: () => void }[] = [];
afterEach(() => {
  for (const held of holds.splice(0)) {
    held.release();
  }
  vi.useRealTimers();
});
function hold(w: MentionWorld, url: string) {
  const held = w.t.web.hold(url);
  holds.push(held);
  return held;
}

// The world with the named Store call failing once, as `error` makes it fail, before the call reaches the Store.
function failingOnce(name: string, error: () => Error): StoreWrap {
  let failed = false;
  return (store) =>
    new Proxy(store, {
      get: (target, property) => {
        const value = Reflect.get(target, property) as unknown;
        if (property === name && !failed) {
          return () => {
            failed = true;
            return Promise.reject(error());
          };
        }
        return value;
      },
    });
}

// The accounts a status mentions, by address (the API orders them by id).
const accts = (status: { mentions: { acct: string }[] }) => status.mentions.map((m) => m.acct).toSorted();

const mentionRows = (w: MentionWorld, statusId: string) =>
  sql<{ account_id: string; silent: number }>(
    w.t.store,
    "SELECT account_id, silent FROM status_mentions WHERE status_id = ? ORDER BY account_id",
    statusId,
  );

describe("an unknown address of a post", () => {
  it("is resolved, stored, mentioned, linked and delivered to (T1, P1)", async () => {
    const w = await mentionWorld();
    const bob = await plainActor(w.t.web, "bob");
    expect(await accountCount(w.t.store, bob.uri)).toBe(0);
    const status = await posted(w.post({ status: "hi @bob@mastodon.example" }));
    const stored = await accountAt(w.t.store, "bob", "mastodon.example");
    expect(stored?.uri).toBe(bob.uri);
    expect(status.mentions.map((m) => [m.id, m.acct])).toEqual([[stored!.id, "bob@mastodon.example"]]);
    expect(status.content).toBe(`<p>hi ${mentionLink("https://mastodon.example/@bob", "bob")}</p>`);
    expect(await mentionRows(w, status.id)).toEqual([{ account_id: stored!.id, silent: 0 }]);
    expect(await inboxes(w.t.store)).toContain("https://mastodon.example/inbox");
  });

  it("addresses a direct post's Create to the resolved account (T2, P2)", async () => {
    const w = await mentionWorld();
    const bob = await plainActor(w.t.web, "bob");
    await posted(w.post({ status: "@bob@mastodon.example psst", visibility: "direct" }));
    const [create] = await sql<{ body: string }>(w.t.store, "SELECT body FROM outbound_activities");
    expect((JSON.parse(create!.body) as { activity: { to: string[] } }).activity.to).toEqual([bob.uri]);
    expect(await inboxes(w.t.store)).toEqual(["https://mastodon.example/inbox"]);
  });

  it("finds a split domain's account by its canonical address, as search does (T3, P1)", async () => {
    const w = await mentionWorld();
    const ali = await splitDomain(w.t.web);
    const status = await posted(w.post({ status: "@ali@nice.example hi" }));
    expect(w.t.web.fetched).toHaveLength(4);
    expect(status.mentions.map((m) => m.acct)).toEqual(["ali@nice.example"]);
    expect(await accountAt(w.t.store, "ali", "nice.example")).toMatchObject({ uri: ali.uri });
    expect(await inboxes(w.t.store)).toEqual(["https://social.example/inbox"]);
    // Search on a Store of its own answers the same account.
    const s = await mentionWorld();
    await splitDomain(s.t.web);
    const found = await s.t.api<{ accounts: { acct: string }[] }>(
      `/api/v2/search?resolve=true&type=accounts&q=${encodeURIComponent("ali@nice.example")}`,
    );
    expect(found.body.accounts.map((a) => a.acct)).toEqual(["ali@nice.example"]);
    expect((await accountAt(s.t.store, "ali", "nice.example"))?.uri).toBe(ali.uri);
  });

  it("finds an account stored under its old handle by the new address it moved to (T3, plan 12b)", async () => {
    const w = await mentionWorld();
    const bob = await mastodonActor(w.t.web, "bob", { origin: "https://old.example" });
    await w.t.api(`/api/v2/search?resolve=true&type=accounts&q=${encodeURIComponent("bob@old.example")}`);
    expect(await accountAt(w.t.store, "bob", "old.example")).toMatchObject({ uri: bob.uri });
    serveWebFinger(w.t.web, "acct:bob@old.example", "acct:bob@new.example", bob.uri);
    serveWebFinger(w.t.web, "acct:bob@new.example", "acct:bob@new.example", bob.uri);
    const status = await posted(w.post({ status: "@bob@new.example" }));
    expect(status.mentions.map((m) => m.acct)).toEqual(["bob@new.example"]);
    expect(await sql(w.t.store, "SELECT username, domain FROM accounts WHERE uri = ?", bob.uri)).toEqual([
      { username: "bob", domain: "new.example" },
    ]);
  });

  it("stays text for an alias or a split domain's server host, storing nothing (T4, P3, plan 12)", async () => {
    const w = await mentionWorld();
    const ali = await splitDomain(w.t.web);
    // alias.example's WebFinger names bob of peer.example, whose own WebFinger confirms bob@peer.example.
    const bob = await plainActor(w.t.web, "bob", "peer.example");
    serveWebFinger(w.t.web, "acct:bob@alias.example", "acct:bob@peer.example", bob.uri);
    for (const text of ["@ali@social.example", "@bob@alias.example"]) {
      w.reset();
      const status = await posted(w.post({ status: text }));
      expect(status.mentions, text).toEqual([]);
      expect(status.content, text).toBe(`<p>${text}</p>`);
      // The requests were made, and nothing was handed to the write.
      expect(w.t.web.fetched.length, text).toBeGreaterThanOrEqual(3);
      expect(w.resolvedSent(), text).toEqual([[]]);
    }
    expect(await accountCount(w.t.store, ali.uri)).toBe(0);
    expect(await accountCount(w.t.store, bob.uri)).toBe(0);
    // Control: the canonical address typed is mentioned.
    w.reset();
    const status = await posted(w.post({ status: "@ali@nice.example" }));
    expect(status.mentions.map((m) => m.acct)).toEqual(["ali@nice.example"]);
    expect(w.resolvedSent()).toEqual([["ali@nice.example"]]);
  });
});

describe("an address that does not resolve (P4)", () => {
  // A text naming `first` then bob@mastodon.example, which resolves: the first stays text, bob is mentioned.
  async function thenBob(w: MentionWorld, first: string) {
    await plainActor(w.t.web, "bob");
    const status = await posted(w.post({ status: `${first} @bob@mastodon.example` }));
    expect(status.mentions.map((m) => m.acct)).toEqual(["bob@mastodon.example"]);
    expect(status.content).toContain(first);
    return status;
  }

  it("leaves a WebFinger 404 and a DNS refusal as text, and resolves the next (T5)", async () => {
    const w = await mentionWorld();
    await thenBob(w, "@nobody@gone.example");
    expect(w.t.web.fetched[0]).toBe(webfinger("nobody", "gone.example"));
    const d = await mentionWorld();
    await plainActor(d.t.web, "eve", "private.example");
    d.refusedHosts.add("private.example");
    await thenBob(d, "@eve@private.example");
    expect(d.dns).toContain("private.example");
    expect(d.t.web.fetched).not.toContain(webfinger("eve", "private.example"));
  });

  it("requests nothing on a domain the instance blocks, and gives it no slot (T5)", async () => {
    const w = await mentionWorld();
    await blockDomain(w.t.store, "blocked.example");
    await plainActor(w.t.web, "eve", "blocked.example");
    const names = ["b1", "b2", "b3", "b4"];
    for (const name of names) {
      await plainActor(w.t.web, name);
    }
    const status = await posted(
      w.post({ status: `@eve@blocked.example ${names.map((n) => `@${n}@mastodon.example`).join(" ")}` }),
    );
    expect(accts(status)).toEqual(names.map((n) => `${n}@mastodon.example`));
    expect(w.dns).not.toContain("blocked.example");
  });

  it("requests nothing on a domain the author blocks, and gives it no slot (T5)", async () => {
    const w = await mentionWorld();
    await plainActor(w.t.web, "eve", "blocked.example");
    const names = ["b1", "b2", "b3", "b4"];
    for (const name of names) {
      await plainActor(w.t.web, name);
    }
    const text = `@eve@blocked.example ${names.map((n) => `@${n}@mastodon.example`).join(" ")}`;
    await sql(w.t.store, "INSERT INTO domain_blocks (account_id, domain) VALUES (?, 'blocked.example')", ALICE);
    const status = await posted(w.post({ status: text }));
    expect(accts(status)).toEqual(names.map((n) => `${n}@mastodon.example`));
    expect(w.dns).not.toContain("blocked.example");
    // Control: unblocked, it is requested (and takes the first slot).
    await sql(w.t.store, "DELETE FROM domain_blocks");
    w.reset();
    const again = await posted(w.post({ status: text }));
    expect(w.t.web.fetched[0]).toBe(webfinger("eve", "blocked.example"));
    expect(again.mentions.map((m) => m.acct)).toContain("eve@blocked.example");
  });

  it("leaves an address past the spent budget as text, which the default budget resolves (T5, plan 7)", async () => {
    const budget = async (fetches?: number) => {
      const w = await mentionWorld();
      await plainActor(w.t.web, "bob");
      await plainActor(w.t.web, "carol", "other.example");
      const start = await w.start("@bob@mastodon.example @carol@other.example");
      const resolve = w.resolver(fetches === undefined ? mentionBudget : (now) => ({ ...mentionBudget(now), fetches }));
      return (await resolve(w.h.env, start)).map((e) => e.key);
    };
    expect(await budget(4)).toEqual(["bob@mastodon.example"]);
    expect(await budget()).toEqual(["bob@mastodon.example", "carol@other.example"]);
  });

  it("leaves an actor that answers 410 as text, deleting nothing (T5, plan 13)", async () => {
    const w = await mentionWorld();
    const old = await plainActor(w.t.web, "old");
    await w.t.api(`/api/v2/search?resolve=true&type=accounts&q=${encodeURIComponent("old@mastodon.example")}`);
    const row = await accountAt(w.t.store, "old", "mastodon.example");
    expect(row?.uri).toBe(old.uri);
    serveWebFinger(w.t.web, "acct:old@moved.example", "acct:old@moved.example", old.uri);
    w.t.web.fail(old.uri, 410);
    w.reset();
    await thenBob(w, "@old@moved.example");
    expect(w.t.web.fetched).toContain(old.uri);
    expect(w.calls()).not.toContain("actorGone");
    expect(await accountAt(w.t.store, "old", "mastodon.example")).toEqual(row);
  });

  it("drops an address whose actorState fails, and resolves the next (T6, plan 10)", async () => {
    const w = await mentionWorld({ wrap: failingOnce("actorState", () => new Error("boom")) });
    await plainActor(w.t.web, "eve", "first.example");
    await thenBob(w, "@eve@first.example");
  });

  it("stops at a Store refusal: both text, the second not requested, the post written (T7, plan 10)", async () => {
    const transient = () => Object.assign(new Error("overloaded"), { retryable: true });
    const w = await mentionWorld({ wrap: failingOnce("actorState", transient) });
    await plainActor(w.t.web, "eve", "first.example");
    await plainActor(w.t.web, "bob");
    const status = await posted(w.post({ status: "@eve@first.example @bob@mastodon.example" }));
    expect(status.mentions).toEqual([]);
    expect(w.t.web.fetched).toEqual([webfinger("eve", "first.example")]);
  });

  it("posts with text when the gate itself fails (T7, plan 11)", async () => {
    const w = await mentionWorld({ wrap: failingOnce("postMentionGate", () => new Error("gate down")) });
    await plainActor(w.t.web, "bob");
    const status = await posted(w.post({ status: "@bob@mastodon.example" }));
    expect(status.mentions).toEqual([]);
    expect(w.t.web.fetched).toEqual([]);
  });

  it("answers 503 and writes nothing when the Store turns readonly while the WebFinger is awaited (T7)", async () => {
    const w = await mentionWorld();
    await plainActor(w.t.web, "bob");
    const held = hold(w, webfinger("bob", "mastodon.example"));
    const response = w.post({ status: "@bob@mastodon.example" });
    await held.reached;
    await w.t.store.setMaintenance(BUILD, true);
    held.release();
    expect((await response).status).toBe(503);
    expect(await sql(w.t.store, "SELECT count(*) AS n FROM statuses")).toEqual([{ n: 0 }]);
  });
});

describe("what the write judges of the resolved accounts", () => {
  it("answers 422 for allowed_mentions without the resolved account, keeping it stored (T8, P5)", async () => {
    const w = await mentionWorld();
    const bob = await plainActor(w.t.web, "bob");
    const response = await w.post({ status: "@bob@mastodon.example", allowed_mentions: [] });
    expect(response.status).toBe(422);
    const body = await response.json<{ error: string; unexpected_accounts: { acct: string }[] }>();
    expect(body.unexpected_accounts.map((a) => a.acct)).toEqual(["bob@mastodon.example"]);
    expect(await sql(w.t.store, "SELECT count(*) AS n FROM statuses")).toEqual([{ n: 0 }]);
    expect(await accountCount(w.t.store, bob.uri)).toBe(1);
  });

  it("resolves at most four addresses, the first in text order, the fifth staying text with no request (T11, P9)", async () => {
    const w = await mentionWorld();
    const hosts = ["h1", "h2", "h3", "h4", "h5"];
    for (const host of hosts) {
      await plainActor(w.t.web, "u", `${host}.example`);
    }
    const status = await posted(w.post({ status: hosts.map((h) => `@u@${h}.example`).join(" ") }));
    expect(accts(status)).toEqual(hosts.slice(0, 4).map((h) => `u@${h}.example`));
    expect(w.dns).not.toContain("h5.example");
  });

  it("resolves an address once, by its first spelling the strict parser reads (T12, plan 14)", async () => {
    const w = await mentionWorld();
    await plainActor(w.t.web, "ken");
    // U+212A KELVIN SIGN: the mention pattern reads it as K (case-insensitive), the address parser refuses it.
    const status = await posted(w.post({ status: "@ken@mastodon.example @Ken@mastodon.example" }));
    expect(status.mentions.map((m) => m.acct)).toEqual(["ken@mastodon.example"]);
    expect(w.t.web.fetched.filter((url) => url === webfinger("ken", "mastodon.example"))).toHaveLength(2);
  });

  it("resolves the warning a blank text takes, not when a quote keeps it, nor in a text's warning (T13, plan 22)", async () => {
    const w = await mentionWorld();
    await plainActor(w.t.web, "bob");
    const quoted = await posted(w.post({ status: "quote me" }));
    w.reset();
    const quoting = await posted(
      w.post({ status: "", spoiler_text: "@bob@mastodon.example", quoted_status_id: quoted.id }),
    );
    expect(quoting.mentions).toEqual([]);
    expect(w.calls()).not.toContain("postMentionGate");
    const warned = await posted(w.post({ status: "plain", spoiler_text: "@bob@mastodon.example" }));
    expect(warned.mentions).toEqual([]);
    expect(w.calls()).not.toContain("postMentionGate");
    expect(w.t.web.fetched).toEqual([]);
    // The guarded branch: a blank text without a quote takes the warning, which is resolved.
    const blank = await posted(w.post({ status: "", spoiler_text: "@bob@mastodon.example" }));
    expect(blank.mentions.map((m) => m.acct)).toEqual(["bob@mastodon.example"]);
  });
});

describe("a request the write would refuse fetches nothing (T14, plan 16)", () => {
  async function refused(w: MentionWorld, request: () => Promise<Response>, status: number) {
    w.reset();
    expect((await request()).status).toBe(status);
    expect(w.gates()).toEqual([{ status: "ok", value: { kind: "none" } }]);
    expect(w.t.web.fetched).toEqual([]);
  }

  it("for a post: unknown media, a missing reply or quote, a schedule too soon or over the day's limit, a long warning", async () => {
    const w = await mentionWorld();
    await plainActor(w.t.web, "bob");
    const text = "@bob@mastodon.example";
    await refused(w, () => w.post({ status: text, media_ids: ["100000000000000098"] }), 422);
    await refused(w, () => w.post({ status: text, in_reply_to_id: "123" }), 404);
    await refused(w, () => w.post({ status: text, quoted_status_id: "123" }), 404);
    await refused(w, () => w.post({ status: text, scheduled_at: at(NOW + MINUTE) }), 422);
    const day = NOW + 2 * 24 * 60 * MINUTE;
    for (let n = 0; n < 25; n++) {
      await sql(
        w.t.store,
        "INSERT INTO scheduled_statuses (id, account_id, scheduled_at, params, created_at) VALUES (?, ?, ?, ?, ?)",
        `7600000000000000${String(n).padStart(2, "0")}`,
        ALICE,
        at(day + n * MINUTE),
        JSON.stringify({ text: "x", spoiler_text: "" }),
        at(NOW),
      );
    }
    await refused(w, () => w.post({ status: text, scheduled_at: at(day + 30 * MINUTE) }), 422);
    await refused(w, () => w.post({ status: "", spoiler_text: `${text} ${"x".repeat(500)}` }), 422);
    // Control: a valid request fetches.
    w.reset();
    await posted(w.post({ status: text }));
    expect(w.t.web.fetched).not.toEqual([]);
  });

  it("for an edit: another user's status, a boost, a status at its edit limit", async () => {
    const w = await mentionWorld();
    await plainActor(w.t.web, "bob");
    const text = "@bob@mastodon.example";
    const daves = await posted(w.post({ status: "dave's" }, {}, w.t.tokens.dave));
    await refused(w, () => w.edit(daves.id, { status: text }), 404);
    const own = await posted(w.post({ status: "own" }));
    const boost = await w.h.request(`/api/v1/statuses/${own.id}/reblog`, {
      method: "POST",
      headers: { authorization: `Bearer ${w.t.tokens.alice}` },
    });
    const boosted = await boost.json<{ id: string }>();
    await refused(w, () => w.edit(boosted.id, { status: text }), 404);
    const limited = await posted(w.post({ status: "edited often" }));
    await sql(
      w.t.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100)
			INSERT INTO status_edits (status_id, created_at) SELECT ?, ? FROM n`,
      limited.id,
      at(NOW),
    );
    await refused(w, () => w.edit(limited.id, { status: text }), 422);
    // Control: an edit of an own status fetches.
    w.reset();
    expect((await w.edit(own.id, { status: text })).status).toBe(200);
    expect(w.t.web.fetched).not.toEqual([]);
  });
});

describe("a quote of an account that moved to the address typed", () => {
  // bob of old.example, stored as bob@old.example with his public status, which anyone may quote; then old.example names
  // bob@new.example, which names him.
  async function movedQuote(w: MentionWorld) {
    const bob = await mastodonActor(w.t.web, "bob", { origin: "https://old.example" });
    const note = mastodonNote(bob, { interactionPolicy: { canQuote: { automaticApproval: [PUBLIC] } } });
    w.t.web.serve(note.id, { "@context": AS, ...note });
    const found = await w.t.api<{ statuses: { id: string }[] }>(
      `/api/v2/search?resolve=true&q=${encodeURIComponent(note.id)}`,
    );
    const quoted = found.body.statuses[0]!.id;
    expect(await accountAt(w.t.store, "bob", "old.example")).toMatchObject({ uri: bob.uri });
    serveWebFinger(w.t.web, "acct:bob@old.example", "acct:bob@new.example", bob.uri);
    serveWebFinger(w.t.web, "acct:bob@new.example", "acct:bob@new.example", bob.uri);
    w.reset();
    return { bob, quoted };
  }
  const quoteRequests = async (w: MentionWorld) =>
    (await sql<{ body: string }>(w.t.store, "SELECT body FROM outbound_activities"))
      .map((row) => JSON.parse(row.body) as { activity: { type: string }; audience?: { accounts: string[] } })
      .filter((row) => row.activity.type === "QuoteRequest");

  it("lets a direct quote name the quoted author by the address it moved to", async () => {
    const w = await mentionWorld();
    const { bob, quoted } = await movedQuote(w);
    const status = await posted(
      w.post({ status: "@bob@new.example look", visibility: "direct", quoted_status_id: quoted }),
    );
    expect(status.mentions.map((m) => m.acct)).toEqual(["bob@new.example"]);
    const [create] = (await sql<{ body: string }>(w.t.store, "SELECT body FROM outbound_activities ORDER BY id")).map(
      (row) => JSON.parse(row.body) as { activity: { type: string; to: string[] } },
    );
    expect(create?.activity).toMatchObject({ type: "Create", to: [bob.uri] });
    const stored = await accountAt(w.t.store, "bob", "new.example");
    expect((await quoteRequests(w)).map((r) => r.audience?.accounts)).toEqual([[stored!.id]]);
  });

  it("refuses the quote as R36 does when the account's new domain is blocked while it resolves (R36)", async () => {
    const w = await mentionWorld();
    const { bob, quoted } = await movedQuote(w);
    const held = hold(w, bob.uri);
    const response = w.post({ status: "@bob@new.example look", visibility: "private", quoted_status_id: quoted });
    await held.reached;
    await sql(w.t.store, "INSERT INTO domain_blocks (account_id, domain) VALUES (?, 'new.example')", ALICE);
    held.release();
    expect((await response).status).toBe(404);
    // The guarded branch ran: the account was resolved and stored under its new address.
    expect(w.resolvedSent()).toEqual([["bob@new.example"]]);
    expect(await accountAt(w.t.store, "bob", "new.example")).toMatchObject({ uri: bob.uri });
    expect(await quoteRequests(w)).toEqual([]);
    expect(await sql(w.t.store, "SELECT count(*) AS n FROM statuses WHERE account_id = ?", ALICE)).toEqual([{ n: 0 }]);
  });
});

describe("editing", () => {
  it("adds the resolved mention of a public status and delivers the Update to it (T9, P6)", async () => {
    const w = await mentionWorld();
    await plainActor(w.t.web, "bob");
    const own = await posted(w.post({ status: "first" }));
    await sql(w.t.store, "DELETE FROM deliveries");
    await sql(w.t.store, "DELETE FROM outbound_targets");
    const edited = await w.edit(own.id, { status: "now @bob@mastodon.example" });
    expect(edited.status).toBe(200);
    const bob = await accountAt(w.t.store, "bob", "mastodon.example");
    expect(await mentionRows(w, own.id)).toEqual([{ account_id: bob!.id, silent: 0 }]);
    const updates = await sql<{ body: string }>(w.t.store, "SELECT body FROM outbound_activities ORDER BY id");
    expect(JSON.parse(updates.at(-1)!.body)).toMatchObject({ activity: { type: "Update" } });
    expect(await inboxes(w.t.store)).toContain("https://mastodon.example/inbox");
  });

  for (const visibility of ["private", "direct"] as const) {
    it(`links the resolved mention of a ${visibility} status without adding a recipient (T10, P7)`, async () => {
      const w = await mentionWorld();
      await plainActor(w.t.web, "bob");
      const own = await posted(w.post({ status: "@dave first", visibility }));
      await sql(w.t.store, "DELETE FROM deliveries");
      await sql(w.t.store, "DELETE FROM outbound_targets");
      const edited = await w.edit(own.id, { status: "@dave now @bob@mastodon.example" });
      expect(edited.status).toBe(200);
      const body = await edited.json<{ content: string }>();
      expect(body.content).toContain(mentionLink("https://mastodon.example/@bob", "bob"));
      expect(await mentionRows(w, own.id)).toEqual([{ account_id: DAVE, silent: 0 }]);
      expect(await inboxes(w.t.store)).not.toContain("https://mastodon.example/inbox");
      expect(await inboxes(w.t.store)).not.toContain("https://mastodon.example/users/bob/inbox");
    });
  }

  it("stores nothing for an unchanged edit or one that changes only the quote policy, though it fetched (T15, plan 17)", async () => {
    const w = await mentionWorld();
    const text = "hi @bob@mastodon.example";
    const own = await posted(w.post({ status: text }));
    expect(own.mentions).toEqual([]);
    const bob = await plainActor(w.t.web, "bob");
    for (const extra of [{}, { quote_approval_policy: "nobody" }]) {
      w.reset();
      const edited = await w.edit(own.id, { status: text, ...extra });
      expect(edited.status).toBe(200);
      expect((await edited.json<{ content: string }>()).content).toBe(own.content);
      expect(w.t.web.fetched).not.toEqual([]);
      expect(await accountCount(w.t.store, bob.uri)).toBe(0);
    }
  });
});

describe("an Idempotency-Key repeat (T16, plan 16)", () => {
  it("fetches nothing for a repeat of an immediate or a scheduled post, whatever its text names", async () => {
    const w = await mentionWorld();
    await plainActor(w.t.web, "carol", "other.example");
    const first = await posted(w.post({ status: "first" }, { "idempotency-key": "k1" }));
    w.reset();
    const again = await posted(w.post({ status: "@carol@other.example" }, { "idempotency-key": "k1" }));
    expect(again.id).toBe(first.id);
    expect(w.t.web.fetched).toEqual([]);
    const scheduled = await w.post(
      { status: "later", scheduled_at: at(NOW + 10 * MINUTE) },
      { "idempotency-key": "k2" },
    );
    const made = await scheduled.json<{ id: string }>();
    w.reset();
    const repeat = await w.post(
      { status: "@carol@other.example", scheduled_at: at(NOW + 10 * MINUTE) },
      { "idempotency-key": "k2" },
    );
    expect((await repeat.json<{ id: string }>()).id).toBe(made.id);
    expect(w.t.web.fetched).toEqual([]);
    expect(w.gates()).toEqual([{ status: "ok", value: { kind: "none" } }]);
  });

  it("posts anew and resolves when the key's status is withdrawn, or its scheduled status unreadable", async () => {
    const w = await mentionWorld();
    await plainActor(w.t.web, "carol", "other.example");
    const first = await posted(w.post({ status: "first" }, { "idempotency-key": "k1" }));
    await sql(w.t.store, "UPDATE statuses SET withdrawn = 1 WHERE id = ?", first.id);
    const anew = await posted(w.post({ status: "@carol@other.example" }, { "idempotency-key": "k1" }));
    expect(anew.id).not.toBe(first.id);
    expect(anew.mentions.map((m) => m.acct)).toEqual(["carol@other.example"]);

    const v = await mentionWorld();
    await plainActor(v.t.web, "carol", "other.example");
    await v.post({ status: "later", scheduled_at: at(NOW + 10 * MINUTE) }, { "idempotency-key": "k2" });
    await sql(v.t.store, "DROP TRIGGER scheduled_statuses_params_update");
    await sql(v.t.store, "UPDATE scheduled_statuses SET params = params || char(0)");
    const posted2 = await posted(v.post({ status: "@carol@other.example" }, { "idempotency-key": "k2" }));
    expect(posted2.mentions.map((m) => m.acct)).toEqual(["carol@other.example"]);
  });
});

describe("a scheduled post (T17, P8, P14, plan 23)", () => {
  // The cron's publication at `now`, its requests counted.
  async function publish(w: MentionWorld, now: number) {
    const before = w.t.web.fetched.length;
    storeClock(now);
    await publishScheduled(w.h.env, {
      build: () => BUILD,
      now: () => now,
      store: () => w.t.store,
      doorbell: () => Promise.resolve(),
    });
    return w.t.web.fetched.length - before;
  }
  const published = (w: MentionWorld) =>
    sql<{ id: string; content: string }>(w.t.store, "SELECT id, content FROM statuses ORDER BY id");

  it("stores the account when scheduled, and publishes the mention with no request", async () => {
    const w = await mentionWorld();
    const bob = await plainActor(w.t.web, "bob");
    await plainActor(w.t.web, "carol", "other.example");
    const due = NOW + 10 * MINUTE;
    const response = await w.post(
      { status: "later @bob@mastodon.example", scheduled_at: at(due) },
      { "idempotency-key": "k" },
    );
    expect(response.status).toBe(200);
    const scheduled = await response.json<{ id: string; params: { text: string } }>();
    expect(scheduled.params.text).toBe("later @bob@mastodon.example");
    expect(await accountCount(w.t.store, bob.uri)).toBe(1);
    // A repeat naming another unstored address answers the scheduled status and fetches nothing.
    w.reset();
    const repeat = await w.post({ status: "@carol@other.example", scheduled_at: at(due) }, { "idempotency-key": "k" });
    expect((await repeat.json<{ id: string }>()).id).toBe(scheduled.id);
    expect(w.t.web.fetched).toEqual([]);
    const moved = await w.h.request(`/api/v1/scheduled_statuses/${scheduled.id}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${w.t.tokens.alice}`, "content-type": "application/json" },
      body: JSON.stringify({ scheduled_at: at(due + MINUTE) }),
    });
    expect(moved.status).toBe(200);
    expect(await publish(w, due + 2 * MINUTE)).toBe(0);
    const [status] = await published(w);
    expect(status?.content).toContain(mentionLink("https://mastodon.example/@bob", "bob"));
    expect(await inboxes(w.t.store)).toContain("https://mastodon.example/inbox");
  });

  it("publishes as text an address that did not resolve, and rows an earlier release scheduled", async () => {
    const w = await mentionWorld();
    const due = NOW + 10 * MINUTE;
    expect((await w.post({ status: "@nobody@gone.example", scheduled_at: at(due) })).status).toBe(200);
    // Rows as an earlier release wrote them: one naming an unstored address, and one counting 501 characters within
    // the raw bound.
    const params = (text: string) =>
      JSON.stringify({
        text,
        poll: null,
        media_ids: null,
        sensitive: null,
        spoiler_text: "",
        visibility: null,
        language: null,
        scheduled_at: null,
        in_reply_to_id: null,
        application_id: null,
        idempotency: null,
        with_rate_limit: false,
        allowed_mentions: null,
        quoted_status_id: null,
        quote_approval_policy: "public",
      });
    await plainActor(w.t.web, "carol", "other.example");
    for (const [id, text] of [
      ["770000000000000001", "@carol@other.example earlier"],
      ["770000000000000002", "x".repeat(501)],
    ] as const) {
      await sql(
        w.t.store,
        "INSERT INTO scheduled_statuses (id, account_id, scheduled_at, params, created_at) VALUES (?, ?, ?, ?, ?)",
        id,
        ALICE,
        at(due),
        params(text),
        at(NOW),
      );
    }
    expect(await publish(w, due + MINUTE)).toBe(0);
    const contents = (await published(w)).map((s) => s.content);
    expect(contents).toHaveLength(3);
    expect(contents).toContain("<p>@nobody@gone.example</p>");
    expect(contents).toContain("<p>@carol@other.example earlier</p>");
    expect(contents).toContain(`<p>${"x".repeat(501)}</p>`);
  });
});

describe("the times a post is judged at (T18, plan 4)", () => {
  it("keeps a post valid as scheduled when it arrived scheduled, however long the resolution took", async () => {
    for (const delay of [2 * MINUTE, 10 * MINUTE]) {
      const w = await mentionWorld();
      await plainActor(w.t.web, "bob");
      const held = hold(w, webfinger("bob", "mastodon.example"));
      const response = w.post({ status: "@bob@mastodon.example", scheduled_at: at(NOW + 6 * MINUTE) });
      await held.reached;
      w.clock.now = NOW + delay;
      held.release();
      const answer = await response;
      expect(answer.status, `${delay}`).toBe(200);
      expect(await answer.json(), `${delay}`).toMatchObject({ scheduled_at: at(NOW + 6 * MINUTE) });
      expect(await sql(w.t.store, "SELECT count(*) AS n FROM statuses")).toEqual([{ n: 0 }]);
    }
  });

  it("posts at once a request whose time had passed when it arrived", async () => {
    const w = await mentionWorld();
    await plainActor(w.t.web, "bob");
    const status = await posted(w.post({ status: "@bob@mastodon.example", scheduled_at: at(NOW - MINUTE) }));
    expect(status.mentions.map((m) => m.acct)).toEqual(["bob@mastodon.example"]);
  });
});

describe("the Store's write of the resolved accounts (6.4)", () => {
  // The accounts the resolver answers for `text`.
  async function resolvedFor(w: MentionWorld, text: string) {
    return w.resolver()(w.h.env, await w.start(text));
  }
  const write = async (
    w: MentionWorld,
    text: string,
    resolved: ResolvedAddress[],
    extra: Record<string, unknown> = {},
  ) =>
    w.t.store.postStatus(BUILD, {
      credential: await w.credential(),
      text,
      spoilerText: "",
      mediaIds: [],
      objectId: crypto.randomUUID(),
      now: NOW,
      present: { origin: "https://kopje.test" },
      resolved,
      ...extra,
    });

  it("stores nothing for a post its media refuse (plan 15)", async () => {
    const w = await mentionWorld();
    const bob = await plainActor(w.t.web, "bob");
    const resolved = await resolvedFor(w, "@bob@mastodon.example");
    expect(resolved.map((r) => r.key)).toEqual(["bob@mastodon.example"]);
    const answer = await write(w, "@bob@mastodon.example", resolved, { mediaIds: ["100000000000000098"] });
    expect(answer).toMatchObject({ status: "ok", value: { status: "invalid" } });
    expect(await accountCount(w.t.store, bob.uri)).toBe(0);
    // Control: without the media, it is stored.
    expect(await write(w, "@bob@mastodon.example", resolved)).toMatchObject({ value: { status: "ok" } });
    expect(await accountCount(w.t.store, bob.uri)).toBe(1);
  });

  it("stores nothing for an entry whose confirmed handle is not its typed address (plan 12)", async () => {
    const w = await mentionWorld();
    const ali = await splitDomain(w.t.web);
    const [entry] = await resolvedFor(w, "@ali@nice.example");
    expect(entry?.actor.confirmed).toEqual({ username: "ali", domain: "nice.example" });
    const answer = await write(w, "@ali@social.example", [{ ...entry!, key: "ali@social.example" }]);
    expect(answer).toMatchObject({ value: { status: "ok", value: { mentions: [] } } });
    expect(await accountCount(w.t.store, ali.uri)).toBe(0);
  });

  it("rolls back a store that throws alone: the first stored, the post written (plan 20)", async () => {
    const w = await mentionWorld();
    const bob = await plainActor(w.t.web, "bob");
    const carol = await plainActor(w.t.web, "carol", "other.example");
    const text = "@bob@mastodon.example @carol@other.example";
    const resolved = await resolvedFor(w, text);
    expect(resolved).toHaveLength(2);
    const input = {
      credential: await w.credential(),
      text,
      spoilerText: "",
      mediaIds: [],
      objectId: crypto.randomUUID(),
      now: NOW,
      storeNow: NOW,
      present: { origin: "https://kopje.test" },
      resolved,
    };
    const answer = await runInDurableObject(w.t.store, (_instance, state) => {
      // carol's account row is refused as it is inserted.
      const failing = new Proxy(state.storage.sql, {
        get: (target, property) =>
          property === "exec"
            ? (query: string, ...params: SqlStorageValue[]) => {
                if (query.includes("INSERT INTO accounts") && params.includes(carol.uri)) {
                  throw new Error("refused insert");
                }
                return target.exec(query, ...params);
              }
            : (Reflect.get(target, property) as unknown),
      });
      return state.storage.transactionSync(() =>
        postStatus.run(failing, input, (fn) => state.storage.transactionSync(fn)),
      );
    });
    expect(answer).toMatchObject({ status: "ok", value: { status: "ok" } });
    expect(await accountCount(w.t.store, bob.uri)).toBe(1);
    expect(await accountCount(w.t.store, carol.uri)).toBe(0);
    expect(await sql(w.t.store, "SELECT count(*) AS n FROM statuses")).toEqual([{ n: 1 }]);
  });
});
