import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { ACCOUNT_STALE_MS, upsertRemoteActor } from "../src/domain/remote-actors";
import { webfingerUrl } from "../src/domain/remote-statuses";
import { accountSearchText } from "../src/domain/search-text";
import { syncCollections } from "../src/federation/collections";
import { REQUEST_MAX_FETCHES } from "../src/federation/loader";
import { claimedHandle } from "../src/federation/remote-actor";
import { DOMAIN_BYTES, REMOTE_USERNAME_LIMIT } from "../src/platform/identity-bounds";
import type { StoreStub } from "../src/platform/store-client";
import { sql } from "./api-helpers";
import { harness, inboxDeps, NOW } from "./app-helpers";
import { fixtureKeyGen } from "./federation-helpers";
import {
  actorDefaults,
  confirmedAs,
  LOCAL,
  MASTODON,
  mastodonActor,
  serveWebFinger,
  signedInit,
  type TestActor,
} from "./inbox-helpers";
import {
  accountId,
  ALICE,
  AS,
  create,
  DAVE,
  DAVE_URI,
  followed,
  mastodonNote,
  type Setup,
  setup,
} from "./inbox-status-helpers";

// Verified handles (NET-4; Mastodon 4.7's ProcessAccountService#check_webfinger!): an actor document claims a handle
// (its FEP-2c59 webfinger, else its preferredUsername at its host, claimedHandle), WebFinger confirms it for the actor
// id before the Store takes it (confirmHandle, acceptedHandle), a stored account keeps its handle while a new claim is
// not confirmed, and one remote account holds an address: a confirmed handle another row holds invalidates that row,
// whose refresh is asked for at most once a day (D7, D9).

const holds: { release: () => void }[] = [];
const outstanding: Promise<unknown>[] = [];
afterEach(async () => {
  for (const held of holds.splice(0)) {
    held.release();
  }
  await Promise.allSettled(outstanding.splice(0));
});

const follow = (actor: TestActor) => ({
  "@context": AS,
  id: `${actor.uri}#follow-${Math.random().toString(36).slice(2)}`,
  type: "Follow",
  actor: actor.uri,
  object: DAVE_URI,
});

const updatePerson = (actor: TestActor) => ({
  "@context": AS,
  id: `${actor.uri}#update-${Math.random().toString(36).slice(2)}`,
  type: "Update",
  actor: actor.uri,
  object: actor.document,
});

type Stored = { username: string; domain: string; display_name: string; handle_refreshed_at: number | null };

const stored = (t: Setup, uri: string) =>
  sql<Stored>(t.store, "SELECT username, domain, display_name, handle_refreshed_at FROM accounts WHERE uri = ?", uri);

// The account's refresh request (a collection sync with its document part), if any.
const refreshes = (t: Setup, uri: string) =>
  sql<{ refresh: number }>(
    t.store,
    "SELECT c.refresh FROM collection_syncs c JOIN accounts a ON a.id = c.account_id WHERE a.uri = ? AND c.refresh = 1",
    uri,
  );

const webfingers = (t: Setup) => t.web.fetched.filter((url) => url.includes("/.well-known/webfinger"));

// The actor's document changed and served again (its own WebFinger answer left as it was).
function reserve(t: Setup, actor: TestActor, change: Record<string, unknown>): void {
  Object.assign(actor.document, change);
  t.web.serve(actor.uri, actor.document);
}

describe("the handle an actor document claims (D2)", () => {
  const uri = "https://social.example/users/ali";
  const domain = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;

  it("is its webfinger when well formed, normalized, with or without acct:", () => {
    expect(claimedHandle({ webfinger: "Ali@Nice.Example" }, uri, "ali")).toEqual({
      username: "Ali",
      domain: "nice.example",
    });
    expect(claimedHandle({ webfinger: "acct:ali@bücher.example" }, uri, "ali")).toEqual({
      username: "ali",
      domain: "xn--bcher-kva.example",
    });
    // At the bounds of both parts, behind acct:.
    expect(domain.length).toBe(DOMAIN_BYTES);
    const longest = `acct:${"u".repeat(REMOTE_USERNAME_LIMIT)}@${domain}`;
    expect(claimedHandle({ webfinger: longest }, uri, "ali")).toEqual({
      username: "u".repeat(REMOTE_USERNAME_LIMIT),
      domain,
    });
  });

  it("falls back to preferredUsername at the host for a malformed webfinger, and is none without either", () => {
    const host = { username: "ali", domain: "social.example" };
    for (const webfinger of [
      "ali@nice@example",
      "ali",
      "@nice.example",
      "ali@",
      "bad name@nice.example",
      "ali@127.0.0.1",
      "ali@nice.example:443",
      `${"u".repeat(REMOTE_USERNAME_LIMIT + 1)}@nice.example`,
      `ali@${"x".repeat(1_000_000)}.example`,
      7,
      null,
      { id: "ali@nice.example" },
    ]) {
      expect([webfinger, claimedHandle({ webfinger }, uri, "ali")]).toEqual([webfinger, host]);
    }
    expect(claimedHandle({}, uri, null)).toBeNull();
    expect(claimedHandle({}, uri, "bad name")).toBeNull();
    expect(claimedHandle({}, "https://127.0.0.1/users/ali", "ali")).toBeNull();
    expect(claimedHandle({ webfinger: "ali@nice.example" }, uri, null)).toEqual({
      username: "ali",
      domain: "nice.example",
    });
  });
});

describe("a new actor's handle (C2, C3, C5)", () => {
  it("is stored once WebFinger confirms it, unsigned; refused or unanswered, nothing is stored", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    expect(await t.post(bob, follow(bob))).toBe(202);
    expect(await stored(t, bob.uri)).toMatchObject([{ username: "bob", domain: "mastodon.example" }]);
    const resource = webfingerUrl("bob", "mastodon.example");
    expect(webfingers(t)).toEqual([resource]);
    expect(t.web.signers[t.web.fetched.indexOf(resource)]).toBe("unsigned");

    // Refused (fails if acceptedHandle takes the claim without a confirmation: carol is stored).
    const carol = await mastodonActor(t.web, "carol", { key: 1 });
    t.web.fail(webfingerUrl("carol", "mastodon.example"), 404);
    expect(await t.post(carol, follow(carol))).toBe(202);
    expect(webfingers(t)).toContain(webfingerUrl("carol", "mastodon.example"));
    expect(await stored(t, carol.uri)).toEqual([]);

    // Not answered: 503, and the sender retries.
    const erin = await mastodonActor(t.web, "erin", { key: 2 });
    t.web.fail(webfingerUrl("erin", "mastodon.example"), 503);
    expect(await t.post(erin, follow(erin))).toBe(503);
    expect(await stored(t, erin.uri)).toEqual([]);
    expect(await sql(t.store, "SELECT 1 FROM follows WHERE target_account_id = ?", DAVE)).toHaveLength(1);
  });

  it("takes a webfinger on another domain confirmed there, falls back from a malformed one, and needs one of them", async () => {
    const t = await setup();
    const ali = await mastodonActor(t.web, "ali", {
      origin: "https://social.example",
      extra: { webfinger: "ali@nice.example" },
    });
    serveWebFinger(t.web, "acct:ali@nice.example", "acct:ali@nice.example", ali.uri);
    expect(await t.post(ali, follow(ali))).toBe(202);
    expect(await stored(t, ali.uri)).toMatchObject([{ username: "ali", domain: "nice.example" }]);
    expect(webfingers(t)).toEqual([webfingerUrl("ali", "nice.example")]);

    const ann = await mastodonActor(t.web, "ann", {
      origin: "https://social.example",
      key: 1,
      extra: { webfinger: "ann@nice@example" },
    });
    expect(await t.post(ann, follow(ann))).toBe(202);
    expect(await stored(t, ann.uri)).toMatchObject([{ username: "ann", domain: "social.example" }]);

    const none = await mastodonActor(t.web, "none", { key: 2 });
    reserve(t, none, { preferredUsername: undefined });
    expect(await t.post(none, follow(none))).toBe(202);
    expect(await stored(t, none.uri)).toEqual([]);
  });
});

describe("a stored actor's new handle (C3, C4)", () => {
  it("is taken when confirmed; refused or unanswered, the old one stays and the rest is stored", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await t.post(bob, follow(bob));
    const before = webfingers(t).length;

    // The claim is the stored handle: no WebFinger.
    expect(await t.post(bob, updatePerson(bob))).toBe(202);
    expect(webfingers(t)).toHaveLength(before);

    // Refused and unanswered: the old handle kept, the display name and the key stored.
    for (const status of [404, 503]) {
      reserve(t, bob, { preferredUsername: "robert", name: `renamed ${status}` });
      t.web.fail(webfingerUrl("robert", "mastodon.example"), status);
      expect(await t.post(bob, updatePerson(bob))).toBe(202);
      expect(webfingers(t).at(-1)).toBe(webfingerUrl("robert", "mastodon.example"));
      expect(await stored(t, bob.uri)).toMatchObject([
        { username: "bob", domain: "mastodon.example", display_name: `renamed ${status}` },
      ]);
    }
    // Confirmed: renamed.
    serveWebFinger(t.web, "acct:robert@mastodon.example", "acct:robert@mastodon.example", bob.uri);
    expect(await t.post(bob, updatePerson(bob))).toBe(202);
    expect(await stored(t, bob.uri)).toMatchObject([{ username: "robert", domain: "mastodon.example" }]);
  });

  // D5: a kept handle stays as stored, byte for byte. An imported username and domain need not be valid UTF-8; the
  // Worker's copy of them decodes such bytes to U+FFFD, which the UPSERT must not write back (fails if it sets
  // username or domain from the document's row instead of keeping the stored column).
  it("keeps the stored bytes of a handle that is not valid UTF-8 when the claim is refused", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await t.post(bob, follow(bob));
    await sql(
      t.store,
      "UPDATE accounts SET username = CAST(X'62FF' AS TEXT), domain = CAST(X'6D2E6578FF' AS TEXT) WHERE uri = ?",
      bob.uri,
    );
    reserve(t, bob, { name: "renamed" });
    t.web.fail(webfingerUrl("bob", "mastodon.example"), 404);
    expect(await t.post(bob, updatePerson(bob))).toBe(202);
    expect(webfingers(t).at(-1)).toBe(webfingerUrl("bob", "mastodon.example"));
    expect(
      await sql(
        t.store,
        "SELECT hex(username) AS u, hex(domain) AS d, display_name FROM accounts WHERE uri = ?",
        bob.uri,
      ),
    ).toEqual([{ u: "62FF", d: "6D2E6578FF", display_name: "renamed" }]);
  });

  // D5 and the UNIQUE address: another account holding the decoded form of a kept handle is no conflict, so the
  // update answers as any refused claim does (fails with a 500, UNIQUE constraint failed, if the decoded copy is
  // written back).
  it("answers a refused claim as usual when another account holds the decoded form of the stored handle", async () => {
    const t = await setup();
    const carol = await mastodonActor(t.web, "carol");
    await t.post(carol, follow(carol));
    await sql(t.store, "UPDATE accounts SET username = CAST(X'63FF' AS TEXT) WHERE uri = ?", carol.uri);
    await sql(
      t.store,
      `INSERT INTO accounts (id, uri, username, domain)
				VALUES ('100000000000000901', 'https://mastodon.example/users/other', CAST(X'63EFBFBD' AS TEXT), 'mastodon.example')`,
    );
    reserve(t, carol, { name: "renamed" });
    t.web.fail(webfingerUrl("carol", "mastodon.example"), 404);
    expect(await t.post(carol, updatePerson(carol))).toBe(202);
    expect(
      await sql(t.store, "SELECT hex(username) AS u, display_name FROM accounts WHERE uri = ?", carol.uri),
    ).toEqual([{ u: "63FF", display_name: "renamed" }]);
  });

  // A kept handle stays searchable as before. The search text of a kept row is built from the handle as presenters show
  // it (usernameSql keeps a long imported username's prefix), not from actorState's projection, which reads a username
  // past REMOTE_USERNAME_LIMIT bytes as '' (fails if the search text is built from that projection: nothing is found).
  it("keeps an imported username past the claim bound searchable when the claim is refused", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await t.post(bob, follow(bob));
    const legacy = `legacy${"x".repeat(250)}`;
    await sql(
      t.store,
      "UPDATE accounts SET username = ?, search_text = ? WHERE uri = ?",
      legacy,
      accountSearchText(legacy, "mastodon.example", "Bob"),
      bob.uri,
    );
    const found = async () =>
      (await t.api<{ accounts: { id: string }[] }>("/api/v2/search?type=accounts&q=legacy")).body.accounts;
    expect(await found()).toHaveLength(1);
    reserve(t, bob, { name: "renamed" });
    t.web.fail(webfingerUrl("bob", "mastodon.example"), 404);
    expect(await t.post(bob, updatePerson(bob))).toBe(202);
    expect(await stored(t, bob.uri)).toMatchObject([{ username: legacy, display_name: "renamed" }]);
    expect(await found()).toHaveLength(1);
  });
});

describe("the WebFinger confirmation (C3)", () => {
  it("follows one other subject, refuses a second, and fetches nothing on this instance's domain", async () => {
    const t = await setup();
    const a = await mastodonActor(t.web, "a", { origin: "https://first.example" });
    serveWebFinger(t.web, "acct:a@first.example", "acct:a@second.example", a.uri);
    serveWebFinger(t.web, "acct:a@second.example", "acct:a@second.example", a.uri);
    expect(await t.post(a, follow(a))).toBe(202);
    expect(await stored(t, a.uri)).toMatchObject([{ username: "a", domain: "second.example" }]);

    // A second redirect: the second subject names a third.
    const b = await mastodonActor(t.web, "b", { origin: "https://first.example", key: 1 });
    serveWebFinger(t.web, "acct:b@first.example", "acct:b@second.example", b.uri);
    serveWebFinger(t.web, "acct:b@second.example", "acct:b@third.example", b.uri);
    serveWebFinger(t.web, "acct:b@third.example", "acct:b@third.example", b.uri);
    expect(await t.post(b, follow(b))).toBe(202);
    expect(await stored(t, b.uri)).toEqual([]);
    expect(webfingers(t)).not.toContain(webfingerUrl("b", "third.example"));

    // A subject, or a claim, on this instance's domain: refused, and never fetched there.
    const c = await mastodonActor(t.web, "c", { origin: "https://first.example", key: 2 });
    serveWebFinger(t.web, "acct:c@first.example", "acct:alice@kopje.test", c.uri);
    expect(await t.post(c, follow(c))).toBe(202);
    const d = await mastodonActor(t.web, "d", { key: 3, extra: { webfinger: "alice@kopje.test" } });
    expect(await t.post(d, follow(d))).toBe(202);
    expect(await sql(t.store, "SELECT uri FROM accounts WHERE uri IN (?, ?)", c.uri, d.uri)).toEqual([]);
    expect(webfingers(t).filter((url) => url.startsWith(LOCAL))).toEqual([]);
    expect(webfingers(t)).toContain(webfingerUrl("c", "first.example"));
  });

  // Each refused for a new actor (nothing stored) and for a stored one (its handle kept).
  const wrongSelf: [string, (t: Setup, actor: TestActor, name: string) => void][] = [
    // Fails if the first self equality is removed.
    [
      "the claim's answer names another actor",
      (t, _actor, name) =>
        serveWebFinger(t.web, `acct:${name}@mastodon.example`, `acct:${name}@mastodon.example`, `${MASTODON}/users/x`),
    ],
    // Fails if the second self equality is removed.
    [
      "the other subject's answer names another actor",
      (t, actor, name) => {
        serveWebFinger(t.web, `acct:${name}@mastodon.example`, `acct:${name}@other.example`, actor.uri);
        serveWebFinger(t.web, `acct:${name}@other.example`, `acct:${name}@other.example`, "https://other.example/x");
      },
    ],
    // Fails if the second subject equality is removed.
    [
      "the other subject's answer names a third subject",
      (t, actor, name) => {
        serveWebFinger(t.web, `acct:${name}@mastodon.example`, `acct:${name}@other.example`, actor.uri);
        serveWebFinger(t.web, `acct:${name}@other.example`, `acct:${name}@third.example`, actor.uri);
      },
    ],
  ];
  for (const [name, serve] of wrongSelf) {
    it(`refuses when ${name}`, async () => {
      const t = await setup();
      const fresh = await mastodonActor(t.web, "fresh");
      serve(t, fresh, "fresh");
      expect(await t.post(fresh, follow(fresh))).toBe(202);
      expect(webfingers(t)).toContain(webfingerUrl("fresh", "mastodon.example"));
      expect(await stored(t, fresh.uri)).toEqual([]);

      const kept = await mastodonActor(t.web, "kept", { key: 1 });
      await t.post(kept, follow(kept));
      reserve(t, kept, { preferredUsername: "renamed" });
      serve(t, kept, "renamed");
      expect(await t.post(kept, updatePerson(kept))).toBe(202);
      expect(webfingers(t)).toContain(webfingerUrl("renamed", "mastodon.example"));
      expect(await stored(t, kept.uri)).toMatchObject([{ username: "kept", domain: "mastodon.example" }]);
    });
  }

  it("keeps a handle on another domain from an actor that does not hold it (takeover refused)", async () => {
    const t = await setup();
    const x = await mastodonActor(t.web, "alice", { origin: "https://victim.example" });
    await t.post(x, follow(x));
    const holder = { username: "alice", domain: "victim.example", handle_refreshed_at: null };
    expect(await stored(t, x.uri)).toMatchObject([holder]);
    // Directly in its webfinger, and through its own domain's WebFinger naming the victim's address; victim.example
    // answers with its own actor. Fails if either self equality is removed: X is invalidated and E takes the handle.
    const direct = await mastodonActor(t.web, "e1", {
      origin: "https://evil.example",
      key: 1,
      extra: { webfinger: "alice@victim.example" },
    });
    const redirected = await mastodonActor(t.web, "alice", { origin: "https://evil.example", key: 2 });
    serveWebFinger(t.web, "acct:alice@evil.example", "acct:alice@victim.example", redirected.uri);
    for (const evil of [direct, redirected]) {
      expect(await t.post(evil, follow(evil))).toBe(202);
      expect(await stored(t, evil.uri)).toEqual([]);
      expect(await stored(t, x.uri)).toMatchObject([holder]);
      expect(await refreshes(t, x.uri)).toEqual([]);
    }
    expect(webfingers(t).filter((url) => url === webfingerUrl("alice", "victim.example"))).toHaveLength(3);
  });
});

describe("a confirmed handle another account holds (C6, C7)", () => {
  it("invalidates the holder, which keeps its follows, statuses and keys, and asks for its refresh once a day", async () => {
    const clock = { now: NOW };
    const t = await setup(clock);
    const y = await mastodonActor(t.web, "bob");
    const yId = await followed(t, y);
    const note = mastodonNote(y);
    await t.post(y, create(y, note));
    const keys = await sql(t.store, "SELECT key_id FROM remote_keys WHERE account_id = ?", yId);
    expect(keys).toHaveLength(1);

    // carol renames into bob's handle, which WebFinger now confirms for her.
    const carol = await mastodonActor(t.web, "carol", { key: 1 });
    await t.post(carol, follow(carol));
    const takeOver = async (taker: TestActor, name: string) => {
      reserve(t, taker, { preferredUsername: name });
      serveWebFinger(t.web, `acct:${name}@mastodon.example`, `acct:${name}@mastodon.example`, taker.uri);
      expect(await t.post(taker, updatePerson(taker))).toBe(202);
    };
    await takeOver(carol, "bob");
    expect(await stored(t, carol.uri)).toMatchObject([{ username: "bob" }]);
    expect(await stored(t, y.uri)).toEqual([
      expect.objectContaining({ username: `! ${yId}`, domain: "mastodon.example", handle_refreshed_at: NOW }),
    ]);
    expect(await refreshes(t, y.uri)).toEqual([{ refresh: 1 }]);
    const shown = await t.api<{ acct: string; invalid_handle?: boolean }>(`/api/v1/accounts/${yId}`);
    expect(shown).toMatchObject({ status: 200, body: { acct: `${yId}@handle.invalid`, invalid_handle: true } });
    expect(
      await sql(t.store, "SELECT 1 FROM follows WHERE account_id = ? AND target_account_id = ?", ALICE, yId),
    ).toHaveLength(1);
    expect(await sql(t.store, "SELECT 1 FROM statuses WHERE uri = ? AND account_id = ?", note.id, yId)).toHaveLength(1);
    expect(await sql(t.store, "SELECT key_id FROM remote_keys WHERE account_id = ?", yId)).toEqual(keys);

    // bob's actor takes a handle of its own back; within the day another takes it again: no new request (fails if the
    // UPDATE ignores handle_refreshed_at).
    await sql(t.store, "DELETE FROM collection_syncs");
    await takeOver(y, "bobby");
    expect(await stored(t, y.uri)).toMatchObject([{ username: "bobby", handle_refreshed_at: NOW }]);
    clock.now = NOW + ACCOUNT_STALE_MS - 1;
    const erin = await mastodonActor(t.web, "erin", { key: 2 });
    await t.post(erin, follow(erin));
    await takeOver(erin, "bobby");
    expect(await stored(t, y.uri)).toMatchObject([{ username: `! ${yId}`, handle_refreshed_at: NOW }]);
    expect(await refreshes(t, y.uri)).toEqual([]);

    // After the day: asked again.
    await takeOver(y, "bob3");
    clock.now = NOW + ACCOUNT_STALE_MS;
    await takeOver(erin, "bob3");
    expect(await stored(t, y.uri)).toMatchObject([
      { username: `! ${yId}`, handle_refreshed_at: NOW + ACCOUNT_STALE_MS },
    ]);
    expect(await refreshes(t, y.uri)).toEqual([{ refresh: 1 }]);
  });

  it("gives a new actor id confirming a held handle its own row and invalidates the holder (owner's decision)", async () => {
    const t = await setup();
    const old = await mastodonActor(t.web, "alice");
    const oldId = await followed(t, old, DAVE);
    const fresh = await mastodonActor(t.web, "alice", { uri: `${MASTODON}/actors/9`, key: 1 });
    expect(await t.post(fresh, follow(fresh))).toBe(202);
    expect(await stored(t, fresh.uri)).toMatchObject([{ username: "alice", domain: "mastodon.example" }]);
    expect(await stored(t, old.uri)).toMatchObject([{ username: `! ${oldId}` }]);
    expect(
      await sql(t.store, "SELECT 1 FROM follows WHERE account_id = ? AND target_account_id = ?", DAVE, oldId),
    ).toHaveLength(1);
  });

  it("writes the holder's row and its refresh request, and only the row within the day", async () => {
    const store = await setup();
    const rows = await runInDurableObject(store.store, (_instance, state) => {
      const db = new Db(state.storage.sql);
      const origin = "https://kopje.test";
      const actor = (n: number, name: string) => ({
        ...actorDefaults(),
        uri: `https://remote.example/users/${n}`,
        ...confirmedAs(name, "remote.example"),
        displayName: name,
        inboxUrl: null,
        movedTo: null,
      });
      const changes = () => db.first<{ n: number }>("SELECT total_changes() AS n")!.n;
      const written = (input: ReturnType<typeof actor>, at: number) =>
        state.storage.transactionSync(() => {
          const before = changes();
          upsertRemoteActor(db, input, origin, at);
          return changes() - before;
        });
      written(actor(1, "held"), NOW);
      const free = written(actor(2, "free"), NOW);
      const taking = written(actor(3, "held"), NOW);
      // 1 takes a handle of its own back, and 4 takes it from 1 within the day of 1's last request.
      written(actor(1, "again"), NOW);
      const inside = written(actor(4, "again"), NOW + 1);
      return { free, taking, inside };
    });
    expect(rows.taking - rows.free).toBe(2);
    expect(rows.inside - rows.free).toBe(1);
  });
});

describe("two actors whose WebFinger answers take one handle from each other (C10, D9 (c))", () => {
  it("refreshes each once and then stops, the last invalidated left so", async () => {
    const t = await setup();
    const a = await mastodonActor(t.web, "a", { origin: "https://alt.example" });
    const b = await mastodonActor(t.web, "shared", {
      origin: "https://alt.example",
      uri: "https://alt.example/users/b",
      key: 1,
    });
    const shared = webfingerUrl("shared", "alt.example");
    await t.post(b, follow(b));
    await t.post(a, follow(a));
    // a's Update claims the shared handle, which WebFinger confirms for a: b is invalidated, its refresh asked for.
    reserve(t, a, { preferredUsername: "shared" });
    serveWebFinger(t.web, "acct:shared@alt.example", "acct:shared@alt.example", a.uri);
    expect(await t.post(a, updatePerson(a))).toBe(202);
    const bId = (await accountId(t.store, b.uri))!;
    expect(await stored(t, b.uri)).toMatchObject([{ username: `! ${bId}` }]);
    // The rounds: the shared handle's WebFinger answers b, then a, then b, and so on.
    const order = [b, a];
    let turn = 0;
    const counted: string[] = [];
    const loader = {
      checkHost: () => Promise.resolve(),
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input)).href;
        if (url === shared) {
          const self = order[turn++ % 2]!.uri;
          serveWebFinger(t.web, "acct:shared@alt.example", "acct:shared@alt.example", self);
        }
        if (url === shared || url === a.uri || url === b.uri) {
          counted.push(url);
        }
        return t.web.fetch(input, init);
      }) as typeof fetch,
    };
    let rounds = 0;
    for (
      ;
      rounds < 10 &&
      (await syncCollections(
        t.env,
        inboxDeps(() => t.store, loader),
      ));
      rounds++
    ) {
      // Another sync is due.
    }
    // None is due after at most ten rounds (fails if the invalidation ignores handle_refreshed_at).
    expect(rounds).toBeLessThan(10);
    const aId = (await accountId(t.store, a.uri))!;
    expect(await stored(t, a.uri)).toMatchObject([{ username: "shared" }]);
    expect(await stored(t, b.uri)).toMatchObject([{ username: `! ${bId}` }]);
    expect(await refreshes(t, b.uri)).toEqual([]);
    expect(aId).not.toBe(bId);
    // b's document part ran once (taking the handle back), a's once (taking it again).
    expect(counted.filter((url) => url === b.uri)).toHaveLength(1);
    expect(counted.filter((url) => url === a.uri)).toHaveLength(1);
    expect(counted.length).toBeLessThanOrEqual(2 * 3);
  });
});

describe("two actors confirming one handle at once (C7)", () => {
  it("leaves one owner, the other invalidated", async () => {
    const t = await setup();
    const p = await mastodonActor(t.web, "shared", { uri: `${MASTODON}/actors/p` });
    const q = await mastodonActor(t.web, "shared", { uri: `${MASTODON}/actors/q`, key: 1 });
    // p's Store call waits until q's request has committed.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    holds.push({ release });
    let reached!: () => void;
    const atStore = new Promise<void>((resolve) => (reached = resolve));
    const raw = t.store as unknown as Record<string | symbol, (...args: unknown[]) => Promise<unknown>>;
    const heldStore = new Proxy(raw, {
      get: (target, prop) =>
        prop === "receiveActivity"
          ? async (...args: unknown[]) => {
              reached();
              await gate;
              return target[prop]!(...args);
            }
          : (...args: unknown[]) => target[prop]!(...args),
    }) as unknown as StoreStub;
    const h = harness(heldStore, {}, undefined, { keygen: fixtureKeyGen, loader: t.web.loader });
    serveWebFinger(t.web, "acct:shared@mastodon.example", "acct:shared@mastodon.example", p.uri);
    const first = h.request("/inbox", await signedInit(p, "/inbox", follow(p)));
    outstanding.push(first);
    await atStore;
    serveWebFinger(t.web, "acct:shared@mastodon.example", "acct:shared@mastodon.example", q.uri);
    expect(await t.post(q, follow(q))).toBe(202);
    expect(await stored(t, q.uri)).toMatchObject([{ username: "shared" }]);
    release();
    expect((await first).status).toBe(202);
    const owners = await sql<{ uri: string }>(
      t.store,
      "SELECT uri FROM accounts WHERE domain = 'mastodon.example' AND lower(username) = 'shared'",
    );
    expect(owners).toEqual([{ uri: p.uri }]);
    expect(await stored(t, q.uri)).toMatchObject([{ username: `! ${(await accountId(t.store, q.uri))!}` }]);
  });
});

describe("the fetch budget (RES-6, section 4)", () => {
  it("bounds a Move from a new actor to a new target, both confirming through a redirect, with uncached contexts", async () => {
    const t = await setup();
    const context = "https://contexts.example/ns";
    t.web.serve(context, { "@context": { extra: "https://contexts.example/ns#extra" } });
    const mover = await mastodonActor(t.web, "mover", { origin: "https://one.example" });
    reserve(t, mover, { "@context": [...(mover.document["@context"] as unknown[]), context] });
    const target = await mastodonActor(t.web, "target", {
      origin: "https://two.example",
      key: 1,
      extra: { alsoKnownAs: [mover.uri] },
    });
    for (const [actor, host] of [
      [mover, "one.example"],
      [target, "two.example"],
    ] as const) {
      const name = actor.uri.split("/").at(-1)!;
      // The claim and the other subject both redirect once, to the same answer naming the other subject.
      const jrd = {
        subject: `acct:${name}@else.${host}`,
        links: [{ rel: "self", type: "application/activity+json", href: actor.uri }],
      };
      for (const url of [webfingerUrl(name, host), webfingerUrl(name, `else.${host}`)]) {
        t.web.redirect(url, `${url}&hop=1`);
        t.web.serve(`${url}&hop=1`, jrd, "application/jrd+json");
      }
    }
    const move = {
      "@context": AS,
      id: `${mover.uri}#move`,
      type: "Move",
      actor: mover.uri,
      object: mover.uri,
      target: target.uri,
    };
    const status = await t.post(mover, move);
    expect(t.web.fetched.length).toBeLessThanOrEqual(REQUEST_MAX_FETCHES);
    expect(status).toBe(503);
    expect(await stored(t, target.uri)).toEqual([]);
  });
});
