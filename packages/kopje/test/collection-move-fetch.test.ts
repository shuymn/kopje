import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { requestCollectionSync } from "../src/domain/collection-requests";
import type { RemoteActorInput } from "../src/domain/remote-actors";
import {
  ALL_PARTS,
  type CollectionSync,
  MAX_SYNC_ATTEMPTS,
  type MoveOutcome,
  SYNC_LEASE_MS,
  SYNC_RETRY_MS,
} from "../src/domain/remote-collections";
import { syncCollections } from "../src/federation/collections";
import { REQUEST_MAX_FETCHES } from "../src/federation/loader";
import { sql } from "./api-helpers";
import { inboxDeps, NOW } from "./app-helpers";
import { blockDomain } from "./domain-block-helpers";
import { BUILD, runStoreJobs } from "./helpers";
import { actorDefaults, confirmedAs, LOCAL, MASTODON, mastodonActor, type TestActor } from "./inbox-helpers";
import { AS, DAVE, DAVE_URI, followed, mastodonNote, OTHER, type Setup, setup } from "./inbox-status-helpers";

// The move part of a remote account's collection sync (domain/remote-collections.ts PART_MOVED,
// federation/collections.ts readMoved): a stored document's movedTo naming an account Kopje does not hold is fetched one
// hop, as the instance actor, without a redirect, and becomes the account's move once its handle is confirmed and its
// own document names no move (Mastodon's ProcessAccountService#moved_account, FetchRemoteAccountService with
// break_on_redirect).

const DEST = `${OTHER}/users/dest`;
const INSTANCE_KEY = `${LOCAL}/actor#main-key`;

type MoveState = { moved: string | null; pending: number; revision: number };

function moveState(t: Setup, uri: string): Promise<MoveState | undefined> {
  return sql<MoveState>(
    t.store,
    `SELECT (SELECT m.uri FROM accounts m WHERE m.id = a.moved_to_account_id) AS moved, a.move_pending AS pending,
			a.document_revision AS revision
		FROM accounts a WHERE a.uri = ?`,
    uri,
  ).then((rows) => rows[0]);
}

const storedUri = (t: Setup, uri: string) =>
  sql<{ id: string }>(t.store, "SELECT id FROM accounts WHERE uri = ?", uri).then((rows) => rows[0]?.id);

const fetchesOf = (t: Setup, url: string, from = 0) => t.web.fetched.slice(from).filter((u) => u === url).length;

const at = (t: Setup, now = NOW) => ({ ...inboxDeps(() => t.store, t.web.loader), now: () => now });

// Bob, stored (followed by alice, who signs his collections) with a document whose movedTo names DEST; and the
// destination served, unless `served` is false. Bob's collections answer 404, so his other parts read through at once.
async function pendingBob(
  t: Setup,
  options: { served?: boolean; movedTo?: string; extra?: Record<string, unknown> } = {},
): Promise<{ bob: TestActor; bobId: string; dest: TestActor }> {
  const dest = await mastodonActor(t.web, "dest", { origin: OTHER, key: 3 });
  if (options.served === false) {
    t.web.served.delete(DEST);
  }
  const bob = await mastodonActor(t.web, "bob");
  t.web.serve(bob.uri, { ...bob.document, movedTo: options.movedTo ?? DEST, ...options.extra });
  const bobId = await followed(t, bob);
  expect(await moveState(t, bob.uri)).toMatchObject({ moved: null, pending: 1 });
  expect(await storedUri(t, DEST)).toBeUndefined();
  return { bob, bobId, dest };
}

// Every sync due run, the clock moved past each backoff, until none is left (at most `calls` calls).
async function syncUntilDone(t: Setup, calls = 10): Promise<void> {
  let now = NOW;
  for (let call = 0; call < calls; call++) {
    await syncCollections(t.env, at(t, now));
    if ((await sql(t.store, "SELECT 1 FROM collection_syncs")).length === 0) {
      return;
    }
    now += SYNC_RETRY_MS;
  }
}

function follow(actor: TestActor, n: number) {
  return { "@context": AS, id: `${actor.uri}#follows/${n}`, type: "Follow", actor: actor.uri, object: DAVE_URI };
}

async function updated(t: Setup, actor: TestActor, document: Record<string, unknown>, n: number): Promise<void> {
  t.web.serve(actor.uri, document);
  const update = {
    "@context": AS,
    id: `${actor.uri}#updates/${n}`,
    type: "Update",
    actor: actor.uri,
    object: document,
  };
  expect(await t.post(actor, update)).toBe(202);
}

// The destination as the Worker hands it over: its document with its claim confirmed.
function destination(uri = DEST): RemoteActorInput {
  return {
    ...actorDefaults(),
    uri,
    ...confirmedAs("dest", "other.example"),
    displayName: "dest",
    inboxUrl: `${uri}/inbox`,
    raw: JSON.stringify({ id: uri, type: "Person", preferredUsername: "dest" }),
  };
}

async function claim(t: Setup, now = NOW): Promise<CollectionSync> {
  const sync = await t.store.claimCollectionSync(BUILD, { now });
  if (sync === null || sync === "more") {
    throw new Error("no sync claimed");
  }
  return sync;
}

// The read's end of `sync` with every other part read and `move` as the move part's outcome.
function complete(t: Setup, sync: CollectionSync, move: MoveOutcome | null, now = NOW) {
  return t.store.completeCollectionRead(BUILD, {
    now,
    origin: LOCAL,
    accountUri: sync.accountUri,
    generation: sync.generation,
    token: sync.token,
    parts: 15,
    pins: null,
    tags: null,
    hideCollections: null,
    counts: { statuses: null, following: null, followers: null },
    collections: null,
    movedTo: sync.movedTo,
    sourceRevision: sync.sourceRevision,
    move,
  });
}

describe("the move part", () => {
  it("stores an unknown destination as the instance actor and makes it the source's move", async () => {
    const t = await setup();
    const { bob, bobId } = await pendingBob(t);
    const { revision } = (await moveState(t, bob.uri))!;
    const from = t.web.fetched.length;
    await syncUntilDone(t);
    expect(await moveState(t, bob.uri)).toEqual({ moved: DEST, pending: 0, revision });
    const shown = await t.api<{ moved?: { url: string } }>(`/api/v1/accounts/${bobId}`, null);
    expect(shown.body.moved).toMatchObject({ acct: "dest@other.example" });
    // DATA-7: the destination as the instance actor, its WebFinger unsigned; bob's collections by alice, his follower.
    const signed = (url: string) => t.web.keyIds.slice(from).filter((_, i) => t.web.fetched[from + i] === url);
    expect(signed(DEST)).toEqual([INSTANCE_KEY]);
    const webfinger = t.web.fetched.slice(from).findIndex((url) => url.includes("webfinger?resource=acct%3Adest"));
    expect(t.web.keyIds[from + webfinger]).toBe("unsigned");
    expect(signed(`${bob.uri}/collections/featured`)).toEqual([`${LOCAL}/ap/users/alice#main-key`]);
  });

  // fetch_remote_actor_service.rb:33: a destination that has moved too is not stored, and its own destination is not
  // fetched. A blank movedTo is no move (present?), the control.
  it.each([
    ["5", 5, false],
    ['"x"', "x", false],
    ["a two-node cycle", `${MASTODON}/users/bob`, false],
    ["blank", " ", true],
    ["an empty array", [], true],
  ])("refuses a destination whose own movedTo is %s, unless it is blank", async (_name, movedTo, stored) => {
    const t = await setup();
    const { bob, dest } = await pendingBob(t);
    t.web.serve(DEST, { ...dest.document, movedTo });
    const from = t.web.fetched.length;
    await syncUntilDone(t);
    expect(await moveState(t, bob.uri)).toMatchObject({ moved: stored ? DEST : null, pending: 0 });
    expect(await storedUri(t, DEST)).toEqual(stored ? expect.any(String) : undefined);
    expect(fetchesOf(t, DEST, from)).toBe(1);
    expect(fetchesOf(t, bob.uri, from)).toBe(0);
  });

  it("loads a transient destination once a claim, and gives it up with the read after MAX_SYNC_ATTEMPTS", async () => {
    const t = await setup();
    const { bob } = await pendingBob(t);
    t.web.fail(DEST, 503);
    const from = t.web.fetched.length;
    await syncUntilDone(t);
    // The other parts read through in the first claim, which progressed; MAX_SYNC_ATTEMPTS claims without progress
    // follow.
    expect(fetchesOf(t, DEST, from)).toBe(1 + MAX_SYNC_ATTEMPTS);
    expect(await moveState(t, bob.uri)).toMatchObject({ moved: null, pending: 0 });
    expect(await sql(t.store, "SELECT 1 FROM collection_syncs")).toEqual([]);
  });

  it("counts an attempt and backs off for each transient round when every other part is read", async () => {
    const t = await setup();
    const { bob } = await pendingBob(t);
    t.web.fail(DEST, 503);
    await sql(t.store, "UPDATE collection_syncs SET parts_read = 7, collections_read = 1");
    const from = t.web.fetched.length;
    let now = NOW;
    for (let round = 1; round <= MAX_SYNC_ATTEMPTS; round++) {
      await syncCollections(t.env, at(t, now));
      expect(fetchesOf(t, DEST, from), String(round)).toBe(round);
      expect(await sql(t.store, "SELECT attempts, due_at FROM collection_syncs"), String(round)).toEqual([
        { attempts: round, due_at: now + SYNC_RETRY_MS },
      ]);
      expect(await moveState(t, bob.uri)).toMatchObject({ pending: 1 });
      now += SYNC_RETRY_MS;
    }
    await syncCollections(t.env, at(t, now));
    expect(fetchesOf(t, DEST, from)).toBe(MAX_SYNC_ATTEMPTS);
    expect(await moveState(t, bob.uri)).toMatchObject({ moved: null, pending: 0 });
  });

  // The part's bit is the Store's: a round that claims it read the part, with the destination still failing, leaves
  // the move pending and the request unread.
  it("keeps the move pending whatever parts the round claims to have read", async () => {
    const t = await setup();
    const { bob } = await pendingBob(t);
    const sync = await claim(t);
    await t.store.completeCollectionRead(BUILD, {
      now: NOW,
      origin: LOCAL,
      accountUri: sync.accountUri,
      generation: sync.generation,
      token: sync.token,
      parts: ALL_PARTS,
      pins: null,
      tags: null,
      hideCollections: null,
      counts: { statuses: null, following: null, followers: null },
      collections: null,
      movedTo: sync.movedTo,
      sourceRevision: sync.sourceRevision,
      move: { kind: "failed", final: false },
    });
    expect(await moveState(t, bob.uri)).toMatchObject({ moved: null, pending: 1 });
    expect(await sql(t.store, "SELECT generation > read_through AS unread FROM collection_syncs")).toEqual([
      { unread: 1 },
    ]);
  });

  it("goes first in a generation's first claim, while the other parts all answer 503", async () => {
    const t = await setup();
    const { bob } = await pendingBob(t);
    for (const path of ["collections/featured", "collections/tags", "following", "followers", "outbox"]) {
      t.web.fail(`${bob.uri}/${path}`, 503);
    }
    const from = t.web.fetched.length;
    await syncCollections(t.env, at(t));
    expect(t.web.fetched[from]).toBe(DEST);
    expect(await moveState(t, bob.uri)).toMatchObject({ moved: DEST, pending: 0 });
  });

  // A collection of `items` that needs a whole round's budget: it and its first page each behind three redirects.
  function wholeRound(t: Setup, url: string, items: unknown[]): void {
    const behind = (at: string, body: Record<string, unknown>) => {
      const hop = (n: number) => (n === 0 ? at : `${at}${at.includes("?") ? "&" : "?"}hop=${n}`);
      for (let n = 0; n < 3; n++) {
        t.web.redirect(hop(n), hop(n + 1));
      }
      t.web.serve(hop(3), body);
    };
    expect(2 * 4).toBe(REQUEST_MAX_FETCHES);
    behind(url, { "@context": AS, id: url, type: "OrderedCollection", first: `${url}?page=1` });
    behind(`${url}?page=1`, {
      "@context": AS,
      id: `${url}?page=1`,
      type: "OrderedCollectionPage",
      orderedItems: items,
    });
  }

  // Bob's every part answering 503 (a featuredCollections collection included, so the first claim makes no progress).
  async function failingBob(t: Setup) {
    const collections = `${MASTODON}/users/bob/collections/collections`;
    const pending = await pendingBob(t, { extra: { featuredCollections: collections } });
    t.web.fail(DEST, 503);
    for (const path of ["collections/featured", "collections/tags", "following", "followers", "outbox"]) {
      t.web.fail(`${pending.bob.uri}/${path}`, 503);
    }
    t.web.fail(collections, 503);
    return pending;
  }

  // The move part opens the generation with a claim of its own: the MAX_SYNC_ATTEMPTS claims after it rotate over the
  // other parts as a read without a move does (featured, network, featuredTags), with the move last, and the read is
  // given up after them.
  it("opens the generation with one more claim, after which the other parts rotate as without a move", async () => {
    const t = await setup();
    const { bob } = await failingBob(t);
    const firsts: string[] = [];
    let now = NOW;
    for (let round = 0; round <= MAX_SYNC_ATTEMPTS; round++) {
      const from = t.web.fetched.length;
      await syncCollections(t.env, at(t, now));
      firsts.push(t.web.fetched[from]!);
      expect(fetchesOf(t, DEST, from), String(round)).toBe(1);
      expect(await moveState(t, bob.uri), String(round)).toMatchObject({ pending: 1 });
      now += SYNC_RETRY_MS;
    }
    expect(firsts).toEqual([
      DEST,
      `${bob.uri}/collections/featured`,
      `${bob.uri}/following`,
      `${bob.uri}/collections/tags`,
    ]);
    await syncCollections(t.env, at(t, now));
    expect(await moveState(t, bob.uri)).toMatchObject({ moved: null, pending: 0 });
    expect(await sql(t.store, "SELECT 1 FROM collection_syncs")).toEqual([]);
  });

  // A featured collection that needs a whole round's budget (its collection and first page each behind three
  // redirects) keeps the full-budget first turn a read without a move gives it, through the real loaders: the move's
  // destination answers 503 first, and the other parts spend what is left of each round.
  it("keeps a full-budget first turn for a featured collection that needs a whole round", async () => {
    const t = await setup();
    const { bob, bobId } = await failingBob(t);
    const note = mastodonNote(bob);
    t.web.serve(note.id, { "@context": AS, ...note });
    wholeRound(t, `${bob.uri}/collections/featured`, [note.id]);
    await syncUntilDone(t);
    const pinned = await t.api<{ uri: string }[]>(`/api/v1/accounts/${bobId}/statuses?pinned=true`, null);
    expect(pinned.body.map((status) => status.uri)).toEqual([note.id]);
  });

  // The bit cleared mid-read, by the claim's reconciliation of a destination stored since or by a verified Move, counts
  // off the claim the move opened, so the claims left are exactly a read's without a move: a part that needs a whole
  // round keeps its full-budget first turn, the featured collection's right after the opening claim and the
  // featuredTags collection's, the last, after MAX_SYNC_ATTEMPTS claims.
  it.each([
    ["after the opening claim, by the claim's reconciliation", 1, "reconcile"],
    ["after the opening claim, by a verified Move", 1, "move"],
    ["before the last turn, by the claim's reconciliation", MAX_SYNC_ATTEMPTS, "reconcile"],
    ["before the last turn, by a verified Move", MAX_SYNC_ATTEMPTS, "move"],
  ] as const)("keeps the turns of a read without a move when the bit clears %s", async (_name, claims, clear) => {
    const t = await setup();
    const { bob, bobId, dest } = await failingBob(t);
    const note = mastodonNote(bob);
    t.web.serve(note.id, { "@context": AS, ...note });
    if (claims === 1) {
      wholeRound(t, `${bob.uri}/collections/featured`, [note.id]);
    } else {
      wholeRound(t, `${bob.uri}/collections/tags`, [{ type: "Hashtag", href: `${MASTODON}/tags/kept`, name: "#kept" }]);
    }
    let now = NOW;
    for (let round = 0; round < claims; round++) {
      await syncCollections(t.env, at(t, now));
      now += SYNC_RETRY_MS;
    }
    expect(await sql(t.store, "SELECT attempts FROM collection_syncs WHERE account_id = ?", bobId)).toEqual([
      { attempts: claims },
    ]);
    if (clear === "reconcile") {
      t.web.serve(DEST, dest.document);
      expect(await t.post(dest, follow(dest, 1))).toBe(202);
    } else {
      const d = await mastodonActor(t.web, "d", { key: 4 });
      t.web.serve(d.uri, { ...d.document, alsoKnownAs: [bob.uri] });
      const move = {
        "@context": AS,
        id: `${bob.uri}#moves/1`,
        type: "Move",
        actor: bob.uri,
        object: bob.uri,
        target: d.uri,
      };
      expect(await t.post(bob, move)).toBe(202);
      expect(await moveState(t, bob.uri)).toMatchObject({ moved: d.uri, pending: 0 });
    }
    for (let round = 0; round < 6; round++) {
      await syncCollections(t.env, at(t, now));
      now += SYNC_RETRY_MS;
    }
    expect(await moveState(t, bob.uri)).toMatchObject({ pending: 0 });
    if (claims === 1) {
      expect(await sql(t.store, "SELECT s.uri FROM statuses s JOIN status_pins p ON p.status_id = s.id")).toEqual([
        { uri: note.id },
      ]);
    } else {
      expect(await sql(t.store, "SELECT name FROM featured_tags WHERE account_id = ?", bobId)).toEqual([
        { name: "kept" },
      ]);
    }
  });

  // A streak the move did not open (a part read through, or the document part's) counts nothing off.
  it.each([
    ["a part is read through", "parts_read = 1"],
    ["the claims are the document part's", "refresh = 1"],
  ])("counts no claim off when the bit clears after %s", async (_name, set) => {
    const t = await setup();
    const { bob, bobId } = await pendingBob(t);
    await sql(t.store, `UPDATE collection_syncs SET attempts = 2, ${set} WHERE account_id = ?`, bobId);
    const d = await mastodonActor(t.web, "d", { key: 4 });
    t.web.serve(d.uri, { ...d.document, alsoKnownAs: [bob.uri] });
    const move = {
      "@context": AS,
      id: `${bob.uri}#moves/1`,
      type: "Move",
      actor: bob.uri,
      object: bob.uri,
      target: d.uri,
    };
    expect(await t.post(bob, move)).toBe(202);
    expect(await moveState(t, bob.uri)).toMatchObject({ moved: d.uri, pending: 0 });
    expect(await sql(t.store, "SELECT attempts FROM collection_syncs WHERE account_id = ?", bobId)).toEqual([
      { attempts: 2 },
    ]);
  });

  // Mastodon takes the destination only when the document's literal id is the URL it fetched (json_ld_helper.rb
  // fetch_resource: json['id'] == uri), so one naming the same URL in another spelling is refused.
  it("refuses a destination whose document spells its id otherwise than the URL fetched", async () => {
    const t = await setup();
    const { bob, dest } = await pendingBob(t);
    t.web.serve(DEST, { ...dest.document, id: "https://OTHER.example:443/users/dest" });
    await syncUntilDone(t);
    expect(await storedUri(t, DEST)).toBeUndefined();
    expect(await moveState(t, bob.uri)).toMatchObject({ moved: null, pending: 0 });
  });

  it("follows no redirect: a destination that redirects settles with nothing", async () => {
    const t = await setup();
    const { bob, dest } = await pendingBob(t);
    const moved = `${OTHER}/users/dest-new`;
    t.web.redirect(DEST, moved);
    t.web.serve(moved, { ...dest.document, id: DEST });
    const from = t.web.fetched.length;
    await syncUntilDone(t);
    expect(t.web.fetched.slice(from)).not.toContain(moved);
    expect(await moveState(t, bob.uri)).toMatchObject({ moved: null, pending: 0 });
    expect(await storedUri(t, DEST)).toBeUndefined();
  });

  // NET-4: the sync's loaders never read the signed-document cache, the instance actor's included.
  it("fetches the destination fresh, past a document cached for the instance actor", async () => {
    const t = await setup();
    const { bob } = await pendingBob(t);
    await sql(
      t.store,
      "INSERT INTO fedify_kv (key, value, expires_at) VALUES (?, ?, NULL)",
      JSON.stringify(["_fedify", "signedRemoteDocument", "v3", INSTANCE_KEY, DEST]),
      JSON.stringify({
        contextUrl: null,
        documentUrl: DEST,
        document: { id: DEST, type: "Person", preferredUsername: "dest", name: "cached" },
      }),
    );
    const from = t.web.fetched.length;
    await syncUntilDone(t);
    expect(fetchesOf(t, DEST, from)).toBe(1);
    expect(await moveState(t, bob.uri)).toMatchObject({ moved: DEST });
    expect(await sql(t.store, "SELECT display_name FROM accounts WHERE uri = ?", DEST)).toEqual([
      { display_name: "dest <b>display</b>" },
    ]);
  });

  // P6, ID-4: a resolution moves no follower and carries no block or mute; a verified Move does (the control).
  it("creates no follow, block or mute of the destination", async () => {
    const t = await setup();
    const { bob, bobId, dest } = await pendingBob(t);
    await sql(t.store, "INSERT INTO blocks (account_id, target_account_id) VALUES (?, ?)", DAVE, bobId);
    await sql(t.store, "INSERT INTO mutes (account_id, target_account_id) VALUES (?, ?)", DAVE, bobId);
    await syncUntilDone(t);
    expect(await moveState(t, bob.uri)).toMatchObject({ moved: DEST });
    const destId = (await storedUri(t, DEST))!;
    const of = () =>
      sql(
        t.store,
        `SELECT (SELECT count(*) FROM follows WHERE target_account_id = ?1) AS follows,
					(SELECT count(*) FROM blocks WHERE target_account_id = ?1) AS blocks,
					(SELECT count(*) FROM mutes WHERE target_account_id = ?1) AS mutes`,
        destId,
      );
    expect(await of()).toEqual([{ follows: 0, blocks: 0, mutes: 0 }]);
    t.web.serve(DEST, { ...dest.document, alsoKnownAs: [bob.uri] });
    const move = {
      "@context": AS,
      id: `${bob.uri}#moves/1`,
      type: "Move",
      actor: bob.uri,
      object: bob.uri,
      target: DEST,
    };
    expect(await t.post(bob, move)).toBe(202);
    expect(await of()).toEqual([{ follows: 1, blocks: 1, mutes: 1 }]);
  });
});

describe("the move part and the destination's host blocked", () => {
  it("requests nothing of a host a suspend block covers before the fetch, and reads the other parts", async () => {
    const t = await setup();
    const { bob } = await pendingBob(t);
    await blockDomain(t.store, "other.example");
    const from = t.web.fetched.length;
    await syncUntilDone(t);
    expect(t.web.fetched.slice(from).some((url) => url.startsWith(OTHER))).toBe(false);
    expect(fetchesOf(t, `${bob.uri}/collections/featured`, from)).toBe(1);
    expect(await moveState(t, bob.uri)).toMatchObject({ moved: null, pending: 0 });
  });

  it("stores nothing when the block commits during the fetch", async () => {
    const t = await setup();
    const { bob } = await pendingBob(t);
    const held = t.web.hold(DEST);
    const round = syncCollections(t.env, at(t));
    await held.reached;
    await blockDomain(t.store, "other.example");
    held.release();
    await round;
    expect(await storedUri(t, DEST)).toBeUndefined();
    expect(await moveState(t, bob.uri)).toMatchObject({ moved: null, pending: 0 });
  });

  // The Store's own check, in the transaction that would store it: a block committed after the last request the round
  // made (its WebFinger confirmation included).
  it("stores nothing when the block commits after the round's last request", async () => {
    const t = await setup();
    const { bob } = await pendingBob(t);
    const sync = await claim(t);
    await blockDomain(t.store, "other.example");
    await complete(t, sync, { kind: "moved", document: destination() });
    expect(await storedUri(t, DEST)).toBeUndefined();
    expect(await moveState(t, bob.uri)).toMatchObject({ moved: null, pending: 0 });
  });

  // A destination stored by another path and then blocked is the source's move, as a store of the source would resolve
  // it: presented redacted.
  it("takes a destination stored during the fetch and then blocked", async () => {
    const t = await setup();
    const { bob, dest } = await pendingBob(t);
    const held = t.web.hold(DEST, { snapshot: true });
    const round = syncCollections(t.env, at(t));
    await held.reached;
    expect(await t.post(dest, follow(dest, 1))).toBe(202);
    await blockDomain(t.store, "other.example");
    held.release();
    await round;
    expect(await moveState(t, bob.uri)).toMatchObject({ moved: DEST, pending: 0 });
  });
});

describe("the move part and a destination stored by another path", () => {
  it("reconciles at the claim, with no fetch, a destination stored before it", async () => {
    const t = await setup();
    const { bob, dest } = await pendingBob(t);
    expect(await t.post(dest, follow(dest, 1))).toBe(202);
    const from = t.web.fetched.length;
    const sync = await claim(t);
    expect(sync).toMatchObject({ phase: "read", movedTo: null });
    expect(await moveState(t, bob.uri)).toMatchObject({ moved: DEST, pending: 0 });
    expect(fetchesOf(t, DEST, from)).toBe(0);
  });

  // The read out of attempts (the streak the move opened, all its claims charged) is given up (the sync dropped, or
  // given way to the pins it left), but a destination stored since the last attempt still becomes the move, with no
  // further fetch.
  it.each([
    ["drops the sync", false],
    ["gives the read up to the pins it left", true],
  ])("reconciles, with no fetch, a destination stored before a claim that %s", async (_name, pins) => {
    const t = await setup();
    const { bob, bobId, dest } = await pendingBob(t);
    expect(await t.post(dest, follow(dest, 1))).toBe(202);
    await sql(
      t.store,
      "UPDATE collection_syncs SET attempts = ?, due_at = ? WHERE account_id = ?",
      MAX_SYNC_ATTEMPTS + 1,
      NOW - 1,
      bobId,
    );
    if (pins) {
      await sql(
        t.store,
        "INSERT INTO collection_pins_pending (account_id, uri, pinned_at) VALUES (?, ?, ?)",
        bobId,
        `${bob.uri}/statuses/1`,
        new Date(NOW).toISOString(),
      );
    }
    const from = t.web.fetched.length;
    const claimed = await t.store.claimCollectionSync(BUILD, { now: NOW });
    if (pins) {
      expect(claimed).toMatchObject({ phase: "pins", accountUri: bob.uri, movedTo: null });
    } else {
      expect(claimed === null || claimed === "more" ? claimed : claimed.accountUri).not.toBe(bob.uri);
    }
    expect(await moveState(t, bob.uri)).toMatchObject({ moved: DEST, pending: 0 });
    expect(fetchesOf(t, DEST, from)).toBe(0);
  });

  // D3: the move is reconciled by a read; a claim of the document part (a refresh of the source's invalidated handle)
  // leaves it to the read after it.
  it("leaves a destination stored before it to the read after a claim of the document part", async () => {
    const t = await setup();
    const { bob, bobId, dest } = await pendingBob(t);
    expect(await t.post(dest, follow(dest, 1))).toBe(202);
    await sql(t.store, "UPDATE accounts SET username = '! ' || username WHERE id = ?", bobId);
    await sql(t.store, "UPDATE collection_syncs SET refresh = 1, due_at = ? WHERE account_id = ?", NOW - 1, bobId);
    expect(await claim(t)).toMatchObject({ phase: "document", accountUri: bob.uri });
    expect(await moveState(t, bob.uri)).toMatchObject({ moved: null, pending: 1 });
  });

  it.each([
    ["a successful fetch", 200],
    ["a fetch answering 503", 503],
    ["a fetch answering 404", 404],
  ] as const)("takes a destination stored during %s", async (_name, status) => {
    const t = await setup();
    const { bob, dest } = await pendingBob(t);
    if (status !== 200) {
      t.web.fail(DEST, status);
    }
    const held = t.web.hold(DEST, { snapshot: true });
    const round = syncCollections(t.env, at(t));
    await held.reached;
    t.web.serve(DEST, dest.document);
    expect(await t.post(dest, follow(dest, 1))).toBe(202);
    held.release();
    await round;
    expect(await moveState(t, bob.uri)).toMatchObject({ moved: DEST, pending: 0 });
  });
});

describe("the move part's fences", () => {
  // P4: what commits between the claim and the read's end leaves the outcome unused.
  it.each([
    ["the source's document stored naming another", (bob: TestActor) => ({ ...bob.document, movedTo: `${OTHER}/c` })],
    ["the source's document stored naming the same", (bob: TestActor) => ({ ...bob.document, movedTo: DEST })],
    ["the source's document stored naming none", (bob: TestActor) => bob.document],
  ])("writes no move and stores nothing after %s", async (_name, document) => {
    const t = await setup();
    const { bob } = await pendingBob(t);
    const sync = await claim(t);
    expect(sync.movedTo).toBe(DEST);
    await updated(t, bob, document(bob), 1);
    await complete(t, sync, { kind: "moved", document: destination() });
    expect(await storedUri(t, DEST)).toBeUndefined();
    expect(await moveState(t, bob.uri)).toMatchObject({ moved: null });
  });

  it("writes no move and stores nothing after a verified Move, and none after its target is purged", async () => {
    const t = await setup();
    const { bob } = await pendingBob(t);
    const d = await mastodonActor(t.web, "d", { key: 4 });
    t.web.serve(d.uri, { ...d.document, alsoKnownAs: [bob.uri] });
    const sync = await claim(t);
    const move = {
      "@context": AS,
      id: `${bob.uri}#moves/1`,
      type: "Move",
      actor: bob.uri,
      object: bob.uri,
      target: d.uri,
    };
    expect(await t.post(bob, move)).toBe(202);
    expect(await moveState(t, bob.uri)).toMatchObject({ moved: d.uri, pending: 0 });
    await complete(t, sync, { kind: "moved", document: destination() });
    expect(await storedUri(t, DEST)).toBeUndefined();
    expect(await moveState(t, bob.uri)).toMatchObject({ moved: d.uri, pending: 0 });
    // D deletes itself: the purge clears bob's move, and nothing pending is left to resolve the older declaration.
    expect(
      await t.post(d, { "@context": AS, id: `${d.uri}#delete`, type: "Delete", actor: d.uri, object: d.uri }),
    ).toBe(202);
    for (let round = 0; round < 3; round++) {
      await runStoreJobs(t.store, BUILD, { now: NOW });
    }
    expect(await moveState(t, bob.uri)).toMatchObject({ moved: null, pending: 0 });
    const from = t.web.fetched.length;
    await syncUntilDone(t);
    expect(fetchesOf(t, DEST, from)).toBe(0);
  });

  it("refuses a document whose id is not the destination fetched", async () => {
    const t = await setup();
    const { bob } = await pendingBob(t);
    const other = `${OTHER}/users/impostor`;
    await complete(t, await claim(t), { kind: "moved", document: destination(other) });
    expect(await storedUri(t, other)).toBeUndefined();
    expect(await storedUri(t, DEST)).toBeUndefined();
    expect(await moveState(t, bob.uri)).toMatchObject({ moved: null, pending: 0 });
  });

  // A request that does not store the source's document (an inbound collection-item removal, the sweep, a handle
  // invalidation: each calls requestCollectionSync) leaves the bit and the revision, so the fetch is still used.
  it.each([
    ["a plain request", false],
    ["a refresh request", true],
  ])("still writes the move after %s made during the fetch", async (_name, refresh) => {
    const t = await setup();
    const { bob, bobId } = await pendingBob(t);
    const sync = await claim(t);
    await runInDurableObject(t.store, (_instance, state) =>
      state.storage.transactionSync(() => requestCollectionSync(new Db(state.storage.sql), bobId, NOW, refresh)),
    );
    expect(await moveState(t, bob.uri)).toMatchObject({ pending: 1 });
    await complete(t, sync, { kind: "moved", document: destination() });
    expect(await moveState(t, bob.uri)).toMatchObject({ moved: DEST, pending: 0 });
  });

  it("changes nothing from a round whose lease ended and which another round took over", async () => {
    const t = await setup();
    const { bob } = await pendingBob(t);
    const first = await claim(t);
    const second = await claim(t, NOW + SYNC_LEASE_MS);
    expect(second.movedTo).toBe(DEST);
    await complete(t, first, { kind: "moved", document: destination() }, NOW + SYNC_LEASE_MS);
    expect(await storedUri(t, DEST)).toBeUndefined();
    expect(await moveState(t, bob.uri)).toMatchObject({ moved: null, pending: 1 });
    await complete(t, second, { kind: "moved", document: destination() }, NOW + SYNC_LEASE_MS);
    expect(await moveState(t, bob.uri)).toMatchObject({ moved: DEST, pending: 0 });
  });

  // A restored lease of the last attempt (dump-format.md): pending until the claim after it gives the read up. The
  // streak the pending move opens has one claim more than MAX_SYNC_ATTEMPTS (moveOpened).
  it("keeps a pending move under the last attempt's lease until the next claim gives the read up", async () => {
    const t = await setup();
    const { bob } = await pendingBob(t);
    await sql(
      t.store,
      "UPDATE collection_syncs SET attempts = ?, token = 'restored', due_at = ?",
      MAX_SYNC_ATTEMPTS + 1,
      NOW + SYNC_LEASE_MS,
    );
    expect(await t.store.claimCollectionSync(BUILD, { now: NOW })).toBeNull();
    expect(await moveState(t, bob.uri)).toMatchObject({ pending: 1 });
    expect(await t.store.claimCollectionSync(BUILD, { now: NOW + SYNC_LEASE_MS })).toBeNull();
    expect(await moveState(t, bob.uri)).toMatchObject({ moved: null, pending: 0 });
  });
});

// The destination confirms the handle the source holds (one domain, one username, as after a change of server
// software): the source is invalidated and asked a refresh, inside the read's end. The read's record comes first, so
// the claimed generation is read through and the new one starts with fresh parts.
describe("the move part and the source's handle", () => {
  it("reads the claimed generation through and leaves the refresh's generation unread", async () => {
    const t = await setup();
    const { bob } = await pendingBob(t, { movedTo: `${MASTODON}/users/bob2` });
    const sync = await claim(t);
    expect(sync.movedTo).toBe(`${MASTODON}/users/bob2`);
    const bob2: RemoteActorInput = {
      ...destination(`${MASTODON}/users/bob2`),
      ...confirmedAs("bob", "mastodon.example"),
    };
    await complete(t, sync, { kind: "moved", document: bob2 });
    expect(await moveState(t, bob.uri)).toMatchObject({ moved: `${MASTODON}/users/bob2`, pending: 0 });
    expect(
      await sql(
        t.store,
        `SELECT c.generation, c.read_through, c.parts_read, c.collections_read, c.refresh FROM collection_syncs c
				JOIN accounts a ON a.id = c.account_id WHERE a.uri = ?`,
        bob.uri,
      ),
    ).toEqual([
      {
        generation: Number(sync.generation) + 1,
        read_through: Number(sync.generation),
        parts_read: 0,
        collections_read: 0,
        refresh: 1,
      },
    ]);
    expect(await claim(t)).toMatchObject({ phase: "document", accountUri: bob.uri });
  });
});
