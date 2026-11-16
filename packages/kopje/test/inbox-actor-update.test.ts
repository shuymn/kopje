import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { KEY_REFRESH_MS } from "../src/domain/inbox";
import { ACCOUNT_STALE_MS } from "../src/domain/remote-actors";
import { webfingerUrl } from "../src/domain/remote-statuses";
import { suspendRemote } from "../src/domain/remote-suspension";
import { fetchesFirst, parseActivity } from "../src/federation/inbound";
import { processInbox } from "../src/federation/inbox";
import { REQUEST_MAX_FETCHES } from "../src/federation/loader";
import { INBOX_URL_LIMIT } from "../src/federation/remote-actor";
import { INBOX_BODY_LIMIT } from "../src/federation/spool";
import { runScheduledJobs } from "../src/jobs/queue";
import { MAX_JSON_DEPTH, MAX_JSON_NODES } from "../src/platform/json-bounds";
import { sql } from "./api-helpers";
import { inboxDeps, NOW } from "./app-helpers";
import { LOCAL, MASTODON, mastodonActor, serveWebFinger, signedInit, type TestActor } from "./inbox-helpers";
import {
  accountId,
  announce,
  AS,
  followed,
  mastodonNote,
  nextId,
  OTHER,
  type Setup,
  setup,
} from "./inbox-status-helpers";
import { ecPem } from "./key-forms-helpers";
import { staleAuthorWorld } from "./stale-author-helpers";

// The actor an Update(Person) embeds (docs/threat-model.md ID-1, federation/inbound.ts receiveInbound,
// domain/remote-actors.ts upsertEmbeddedActor): its profile, handle claim (confirmed by WebFinger when it changes),
// movedTo and document are stored, read as a fetched document is; its keys and inboxes never are, and its actor's
// document is fetched only when the signing key needs it. Each race holds one request at a fetch (RemoteWeb.hold)
// while the other commits through the real inbox and Store.

const holds: { release: () => void }[] = [];
const outstanding: Promise<unknown>[] = [];
afterEach(async () => {
  for (const held of holds.splice(0)) {
    held.release();
  }
  await Promise.allSettled(outstanding.splice(0));
});
function hold(t: Setup, url: string, options: { snapshot?: boolean } = {}) {
  const held = t.web.hold(url, options);
  holds.push(held);
  return held;
}
function track<T>(request: Promise<T>): Promise<T> {
  outstanding.push(request);
  return request;
}

const iso = (at: number) => new Date(at).toISOString();
const avatar = (name: string) => `${MASTODON}/system/avatars/${name}.png`;

// An Update(Person) of `actor` embedding `object` (its document as served, unless another is given).
const updateOf = (actor: TestActor, object: unknown = actor.document, context: unknown = AS) => ({
  "@context": context,
  id: `${actor.uri}#updates/${nextId()}`,
  type: "Update",
  actor: actor.uri,
  object,
});
// The actor's document as served, changed by `change`: what its Update embeds.
const embedded = (actor: TestActor, change: Record<string, unknown>) => ({ ...actor.document, ...change });

// The outcome of processInbox (status and reason) for `activity` signed by `actor` at NOW.
async function receive(t: Setup, actor: TestActor, activity: unknown, mode: "live" | "replay" = "live") {
  const init = await signedInit(actor, "/inbox", activity);
  const request = {
    url: `${LOCAL}/inbox`,
    method: "POST",
    headers: [...new Headers(init.headers)],
    body: new TextEncoder().encode(init.body as string),
    receivedAt: NOW,
  };
  return processInbox(
    t.env,
    inboxDeps(() => t.store, t.web.loader),
    request,
    mode,
  );
}

type Row = {
  username: string;
  display_name: string;
  note: string;
  avatar_url: string | null;
  inbox_url: string | null;
  shared_inbox_url: string | null;
  moved_to_account_id: string | null;
  fetched_at: string | null;
  document_revision: number;
  raw: string;
};
const row = async (t: Setup, uri: string) =>
  (
    await sql<Row>(
      t.store,
      `SELECT username, display_name, note, avatar_url, inbox_url, shared_inbox_url, moved_to_account_id, fetched_at,
				document_revision, raw FROM accounts WHERE uri = ?`,
      uri,
    )
  )[0]!;
const keys = (t: Setup, uri: string) =>
  sql<{ key_id: string; pem: string; fetched_at: number }>(
    t.store,
    `SELECT k.key_id, k.pem, k.fetched_at FROM remote_keys k JOIN accounts a ON a.id = k.account_id
		WHERE a.uri = ? ORDER BY k.key_id`,
    uri,
  );
// The actor's stored keys listed a day ago: its next activity fetches its document for its key.
const expire = (t: Setup, uri: string) =>
  sql(
    t.store,
    "UPDATE remote_keys SET fetched_at = ? WHERE account_id = (SELECT id FROM accounts WHERE uri = ?)",
    NOW - KEY_REFRESH_MS,
    uri,
  );
const fetchedActor = (t: Setup, actor: TestActor) => t.web.fetched.filter((url) => url === actor.uri);

// bob, stored from his fetched document and followed by alice; nothing fetched yet.
async function bobWorld(clock = { now: NOW }) {
  const t = await setup(clock);
  const bob = await mastodonActor(t.web, "bob");
  await followed(t, bob);
  t.web.fetched.length = 0;
  return { t, bob };
}

describe("an Update(Person) embedding its actor, signed with a fresh key (ID-1)", () => {
  it("stores the embedded profile, fields and movedTo without fetching the actor", async () => {
    const { t, bob } = await bobWorld();
    const carol = await mastodonActor(t.web, "carol", { origin: OTHER, key: 2 });
    await followed(t, carol);
    t.web.fetched.length = 0;
    const update = updateOf(
      bob,
      embedded(bob, {
        name: "embedded name",
        summary: "<p>embedded bio</p>",
        attachment: [{ type: "PropertyValue", name: "Embedded", value: "field" }],
        icon: { type: "Image", mediaType: "image/png", url: avatar("embedded") },
        movedTo: carol.uri,
      }),
    );
    expect(await receive(t, bob, update)).toMatchObject({ status: 202, reason: "actor-updated" });
    expect(t.web.fetched).toEqual([]);
    const stored = await row(t, bob.uri);
    expect(stored).toMatchObject({
      username: "bob",
      display_name: "embedded name",
      note: "<p>embedded bio</p>",
      avatar_url: avatar("embedded"),
      moved_to_account_id: await accountId(t.store, carol.uri),
      fetched_at: iso(NOW),
    });
    expect((JSON.parse(stored.raw) as { attachment: unknown }).attachment).toEqual([
      { type: "PropertyValue", name: "Embedded", value: "field" },
    ]);
  });

  it("keeps the stored keys and inboxes whatever the embedded actor lists", async () => {
    const { t, bob } = await bobWorld();
    const before = { row: await row(t, bob.uri), keys: await keys(t, bob.uri) };
    const other = await mastodonActor(t.web, "other", { key: 4 });
    const update = updateOf(
      bob,
      embedded(bob, {
        name: "renamed",
        publicKey: [
          { id: bob.keyId, owner: bob.uri, publicKeyPem: other.pem },
          { id: `${bob.uri}#second-key`, owner: bob.uri, publicKeyPem: other.pem },
        ],
        inbox: `${bob.uri}/inbox-alt`,
        endpoints: { sharedInbox: `${MASTODON}/inbox-alt` },
      }),
    );
    expect(await t.post(bob, update)).toBe(202);
    expect(await keys(t, bob.uri)).toEqual(before.keys);
    expect(await row(t, bob.uri)).toMatchObject({
      display_name: "renamed",
      inbox_url: before.row.inbox_url,
      shared_inbox_url: before.row.shared_inbox_url,
    });
    // The embedded key was not trusted: a request signed by it under bob's key id fetches his document, which lists
    // his own key, and is refused.
    const follow = { "@context": AS, id: `${bob.uri}#follows/${nextId()}`, type: "Follow", actor: bob.uri };
    expect(
      await t.post({ ...bob, privateKey: other.privateKey }, { ...follow, object: `${LOCAL}/ap/users/dave` }),
    ).toBe(401);
    expect(await t.post(bob, { ...follow, object: `${LOCAL}/ap/users/dave` })).toBe(202);
  });

  it("is applied at a spooled request's replay as live", async () => {
    const { t, bob } = await bobWorld();
    const update = updateOf(bob, embedded(bob, { name: "replayed" }));
    expect(await receive(t, bob, update, "replay")).toMatchObject({ status: 202, reason: "actor-updated" });
    expect(t.web.fetched).toEqual([]);
    expect((await row(t, bob.uri)).display_name).toBe("replayed");
  });
});

describe("an Update(Person) embedding its actor, signed with a key that needs a fetch (ID-1)", () => {
  it("stores the fetched document's keys and inboxes with the embedded profile, in one store", async () => {
    const { t, bob } = await bobWorld();
    await expire(t, bob.uri);
    const before = await row(t, bob.uri);
    const second = await mastodonActor(t.web, "second", { key: 5 });
    const served = {
      ...bob.document,
      name: "served",
      publicKey: [
        { id: bob.keyId, owner: bob.uri, publicKeyPem: bob.pem },
        { id: `${bob.uri}#second-key`, owner: bob.uri, publicKeyPem: second.pem },
      ],
      inbox: `${bob.uri}/inbox-2`,
      endpoints: { sharedInbox: `${MASTODON}/inbox-2` },
    };
    t.web.serve(bob.uri, served);
    const update = updateOf(bob, embedded(bob, { name: "embedded", inbox: `${bob.uri}/inbox-alt` }));
    expect(await receive(t, bob, update)).toMatchObject({ status: 202, reason: "actor-updated" });
    expect(fetchedActor(t, bob)).toHaveLength(1);
    const stored = await row(t, bob.uri);
    expect(stored).toMatchObject({
      display_name: "embedded",
      inbox_url: `${bob.uri}/inbox-2`,
      shared_inbox_url: `${MASTODON}/inbox-2`,
      fetched_at: iso(NOW),
    });
    expect(stored.document_revision).not.toBe(before.document_revision);
    expect(await keys(t, bob.uri)).toEqual([
      { key_id: bob.keyId, pem: bob.pem, fetched_at: NOW },
      { key_id: `${bob.uri}#second-key`, pem: second.pem, fetched_at: NOW },
    ]);
  });
});

describe("the embedded actor's handle claim (NET-4)", () => {
  it("renames when WebFinger confirms it, and keeps the handle while the profile is stored otherwise", async () => {
    const { t, bob } = await bobWorld();
    const robert = webfingerUrl("robert", "mastodon.example");
    for (const status of [404, 503]) {
      t.web.fail(robert, status);
      const update = updateOf(bob, embedded(bob, { preferredUsername: "robert", name: `renamed ${status}` }));
      expect(await t.post(bob, update)).toBe(202);
      expect(t.web.fetched.at(-1)).toBe(robert);
      expect(await row(t, bob.uri)).toMatchObject({ username: "bob", display_name: `renamed ${status}` });
    }
    serveWebFinger(t.web, "acct:robert@mastodon.example", "acct:robert@mastodon.example", bob.uri);
    expect(await t.post(bob, updateOf(bob, embedded(bob, { preferredUsername: "robert" })))).toBe(202);
    expect((await row(t, bob.uri)).username).toBe("robert");
    expect(fetchedActor(t, bob)).toEqual([]);
  });

  it("confirms the embedded claim, not that of the document fetched for the key", async () => {
    const { t, bob } = await bobWorld();
    await expire(t, bob.uri);
    serveWebFinger(t.web, "acct:robert@mastodon.example", "acct:robert@mastodon.example", bob.uri);
    // The served document still claims bob (its cache), the embedded one robert.
    expect(await t.post(bob, updateOf(bob, embedded(bob, { preferredUsername: "robert" })))).toBe(202);
    expect(fetchedActor(t, bob)).toHaveLength(1);
    expect((await row(t, bob.uri)).username).toBe("robert");
  });
});

describe("the revision fence (ID-1)", () => {
  // A is held at its claim's WebFinger, after the inbox gate read bob's revision; B's Update commits a store of bob
  // meanwhile. A stores nothing and answers 503; its retry applies.
  it("answers 503 for an embedded actor whose store raced another, storing nothing of it", async () => {
    const { t, bob } = await bobWorld();
    serveWebFinger(t.web, "acct:robert@mastodon.example", "acct:robert@mastodon.example", bob.uri);
    const webfinger = hold(t, webfingerUrl("robert", "mastodon.example"));
    const a = updateOf(bob, embedded(bob, { preferredUsername: "robert", name: "A" }));
    const first = track(receive(t, bob, a));
    await webfinger.reached;
    expect(await t.post(bob, updateOf(bob, embedded(bob, { name: "B" })))).toBe(202);
    const committed = await row(t, bob.uri);
    webfinger.release();
    expect(await first).toMatchObject({ status: 503, reason: "actor-changed" });
    expect(await row(t, bob.uri)).toEqual(committed);
    expect(committed).toMatchObject({ username: "bob", display_name: "B" });
    expect(await receive(t, bob, a)).toMatchObject({ status: 202, reason: "actor-updated" });
    expect(await row(t, bob.uri)).toMatchObject({ username: "robert", display_name: "A" });
  });

  // A boost of erin's status asks for her stale document, whose fetch is held (as served before her Update); her
  // Update, embedding her new profile, commits meanwhile. The clock then moves past ACCOUNT_STALE_MS, so the row is
  // stale again when A's refresh completes: only the revision it was decided under keeps it from being stored.
  it("stores none of a stale-author refresh decided before an embedded store", async () => {
    const { t, bob, erin, clock } = await staleAuthorWorld();
    const refresh = hold(t, erin.uri, { snapshot: true });
    const note = mastodonNote(erin);
    t.web.serve(note.id, { "@context": AS, ...note });
    const boost = track(t.post(bob, announce(bob, note.id)));
    await refresh.reached;
    clock.now = NOW + 1;
    expect(await t.post(erin, updateOf(erin, embedded(erin, { name: "embedded" })))).toBe(202);
    const updated = await row(t, erin.uri);
    expect(updated).toMatchObject({ display_name: "embedded", fetched_at: iso(NOW + 1) });
    clock.now = NOW + 1 + ACCOUNT_STALE_MS;
    refresh.release();
    expect(await boost).toBe(202);
    expect(await row(t, erin.uri)).toEqual(updated);
  });
});

describe("the freshness an embedded store sets (ID-1)", () => {
  it("moves accounts.fetched_at, not remote_keys.fetched_at: a day after the last fetch the actor is fetched", async () => {
    const clock = { now: NOW };
    const { t, bob } = await bobWorld(clock);
    await sql(t.store, "UPDATE accounts SET fetched_at = ? WHERE uri = ?", iso(NOW - ACCOUNT_STALE_MS), bob.uri);
    clock.now = NOW + 60_000;
    expect(await t.post(bob, updateOf(bob, embedded(bob, { name: "embedded" })))).toBe(202);
    expect((await row(t, bob.uri)).fetched_at).toBe(iso(NOW + 60_000));
    expect((await keys(t, bob.uri)).map((k) => k.fetched_at)).toEqual([NOW]);
    expect(fetchedActor(t, bob)).toEqual([]);
    // A day after the document was fetched, his next activity fetches it for its key.
    clock.now = NOW + KEY_REFRESH_MS;
    const follow = {
      "@context": AS,
      id: `${bob.uri}#follows/${nextId()}`,
      type: "Follow",
      actor: bob.uri,
      object: `${LOCAL}/ap/users/dave`,
    };
    expect(await t.post(bob, follow)).toBe(202);
    expect(fetchedActor(t, bob)).toHaveLength(1);
  });
});

// docs/mastodon-deviations.md, Accounts: an inbox move sent only by Update(Person) waits for Kopje's next fetch of the
// actor's document, which nothing schedules: the 24 hours are the key's trust, not a refetch deadline.
describe("an inbox move sent only by an embedded actor", () => {
  it("is not fetched by a scheduled round a day later, and applies at the actor's next activity that needs its key", async () => {
    const clock = { now: NOW };
    const { t, bob } = await bobWorld(clock);
    const moved = { ...bob.document, inbox: `${bob.uri}/inbox-2` };
    t.web.serve(bob.uri, moved);
    expect(await t.post(bob, updateOf(bob, moved))).toBe(202);
    expect((await row(t, bob.uri)).inbox_url).toBe(`${bob.uri}/inbox`);
    clock.now = NOW + KEY_REFRESH_MS + 60_000;
    await runScheduledJobs(t.env, { ...inboxDeps(() => t.store, t.web.loader), now: () => clock.now });
    // The round ran, and read bob's collections (the sync his stored document asked for), never his document.
    expect(t.web.fetched.some((url) => url.startsWith(`${bob.uri}/`))).toBe(true);
    expect(fetchedActor(t, bob)).toEqual([]);
    expect((await row(t, bob.uri)).inbox_url).toBe(`${bob.uri}/inbox`);
    const follow = {
      "@context": AS,
      id: `${bob.uri}#follows/${nextId()}`,
      type: "Follow",
      actor: bob.uri,
      object: `${LOCAL}/ap/users/dave`,
    };
    expect(await t.post(bob, follow)).toBe(202);
    expect(fetchedActor(t, bob)).toHaveLength(1);
    expect((await row(t, bob.uri)).inbox_url).toBe(`${bob.uri}/inbox-2`);
  });
});

describe("an Update(Person) that embeds no actor", () => {
  it.each([
    ["names its actor by URI", (bob: TestActor) => bob.uri],
    ["embeds an object of another type with the actor's id", (bob: TestActor) => ({ id: bob.uri, type: "Note" })],
  ])("fetches the actor's document when it %s", async (_name, object) => {
    const { t, bob } = await bobWorld();
    t.web.serve(bob.uri, { ...bob.document, name: "served" });
    const update = updateOf(bob, object(bob));
    const parsed = parseActivity(new TextEncoder().encode(JSON.stringify(update)));
    expect(fetchesFirst(parsed)).toBe(bob.uri);
    expect(await receive(t, bob, update)).toMatchObject({ status: 202, reason: "actor-updated" });
    expect(fetchedActor(t, bob)).toHaveLength(1);
    expect((await row(t, bob.uri)).display_name).toBe("served");
    // One that embeds its actor is hinted no fetch.
    expect(fetchesFirst(parseActivity(new TextEncoder().encode(JSON.stringify(updateOf(bob)))))).toBeNull();
  });
});

describe("an embedded actor Kopje cannot read", () => {
  it.each([
    ["no handle claim", { preferredUsername: undefined }],
    ["an inbox past INBOX_URL_LIMIT", { inbox: `${MASTODON}/${"i".repeat(INBOX_URL_LIMIT)}` }],
  ])("applies nothing when it has %s (202 invalid-actor)", async (_name, change) => {
    const { t, bob } = await bobWorld();
    const before = await row(t, bob.uri);
    const update = updateOf(bob, embedded(bob, { ...change, name: "unread" }));
    expect(await receive(t, bob, update)).toMatchObject({ status: 202, reason: "invalid-actor" });
    expect(await row(t, bob.uri)).toEqual(before);
    expect(t.web.fetched).toEqual([]);
    // The same document readable is stored (the branch ran).
    expect(await t.post(bob, updateOf(bob, embedded(bob, { name: "read" })))).toBe(202);
    expect((await row(t, bob.uri)).display_name).toBe("read");
  });

  it("stores the document fetched for the key as for any activity, and nothing of the embedded one", async () => {
    const { t, bob } = await bobWorld();
    await expire(t, bob.uri);
    t.web.serve(bob.uri, { ...bob.document, name: "served" });
    const update = updateOf(bob, embedded(bob, { preferredUsername: undefined, name: "unread" }));
    expect(await receive(t, bob, update)).toMatchObject({ status: 202, reason: "invalid-actor" });
    expect((await row(t, bob.uri)).display_name).toBe("served");
    expect((await keys(t, bob.uri)).map((k) => k.fetched_at)).toEqual([NOW]);
  });
});

// Mastodon's ProcessAccountService#call raises for a document whose own `inbox` is blank (Ruby's blank?,
// process_account_service.rb:24) before it touches the account, fetched or embedded alike; Kopje's reader refuses it the
// same way (remote-actor.ts remoteActorInput), so nothing of it is stored, a new actor's row nor a stored one's.
describe("an actor document whose inbox is blank", () => {
  it.each([
    ["missing", undefined],
    ["null", null],
    ["empty", ""],
    ["whitespace alone", " \u3000\n"],
    // U+0085 is White_Space, which Ruby's [[:space:]] matches and String#trim does not.
    ["a next line (U+0085) alone", "\u0085"],
    ["false", false],
    ["an empty array", []],
    ["an empty object", {}],
  ])("is refused fetched or embedded, for a new actor and a stored one (inbox %s)", async (_name, inbox) => {
    const { t, bob } = await bobWorld();
    // Fetched, a new actor: its Follow stores nothing.
    const fresh = await mastodonActor(t.web, "fresh", { key: 1 });
    t.web.serve(fresh.uri, { ...fresh.document, inbox });
    const follow = (actor: TestActor) => ({
      "@context": AS,
      id: `${actor.uri}#follows/${nextId()}`,
      type: "Follow",
      actor: actor.uri,
      object: `${LOCAL}/ap/users/dave`,
    });
    expect(await receive(t, fresh, follow(fresh))).toMatchObject({ status: 202, reason: "invalid-actor" });
    expect(await accountId(t.store, fresh.uri)).toBeUndefined();
    // Fetched, a stored actor: an Update naming bob by URI fetches his document, which changes nothing.
    const before = { row: await row(t, bob.uri), keys: await keys(t, bob.uri) };
    t.web.serve(bob.uri, { ...bob.document, inbox, name: "refetched" });
    const byUri = updateOf(bob, bob.uri);
    expect(await receive(t, bob, byUri)).toMatchObject({ status: 202, reason: "invalid-actor" });
    expect(await row(t, bob.uri)).toEqual(before.row);
    // Embedded, a stored actor: nothing of it is applied.
    t.web.serve(bob.uri, bob.document);
    const embedding = updateOf(bob, embedded(bob, { inbox, name: "embedded" }));
    expect(await receive(t, bob, embedding)).toMatchObject({ status: 202, reason: "invalid-actor" });
    expect(await row(t, bob.uri)).toEqual(before.row);
    expect(await keys(t, bob.uri)).toEqual(before.keys);
    // Embedded, a new actor: the document fetched for its key is stored as for any activity, nothing of the embedded.
    const carol = await mastodonActor(t.web, "carol", { origin: OTHER, key: 2 });
    const carolUpdate = updateOf(carol, embedded(carol, { inbox, name: "embedded" }));
    expect(await receive(t, carol, carolUpdate)).toMatchObject({ status: 202, reason: "invalid-actor" });
    expect(await row(t, carol.uri)).toMatchObject({
      display_name: "carol <b>display</b>",
      inbox_url: `${carol.uri}/inbox`,
    });
    // The same documents with an inbox are stored (the branch ran).
    t.web.serve(fresh.uri, fresh.document);
    expect(await receive(t, fresh, follow(fresh))).toMatchObject({ status: 202 });
    expect(await accountId(t.store, fresh.uri)).toBeDefined();
    expect(await t.post(bob, updateOf(bob, embedded(bob, { name: "embedded" })))).toBe(202);
    expect((await row(t, bob.uri)).display_name).toBe("embedded");
  });

  // U+FEFF is not White_Space, though String#trim removes it.
  it("takes an inbox of a zero width no-break space (U+FEFF) alone, fetched or embedded", async () => {
    const { t, bob } = await bobWorld();
    t.web.serve(bob.uri, { ...bob.document, inbox: "\uFEFF", name: "refetched" });
    expect(await receive(t, bob, updateOf(bob, bob.uri))).toMatchObject({ status: 202, reason: "actor-updated" });
    expect((await row(t, bob.uri)).display_name).toBe("refetched");
    const embedding = updateOf(bob, embedded(bob, { inbox: "\uFEFF", name: "embedded" }));
    expect(await receive(t, bob, embedding)).toMatchObject({ status: 202, reason: "actor-updated" });
    expect((await row(t, bob.uri)).display_name).toBe("embedded");
  });
});

// Mastodon's blank test reads the `inbox` member of the document as Mastodon reads it: a fetched one as served
// (json_ld_helper.rb body_to_json), an embedded one in its activity as received, or compacted under full_context when
// the activity carries an LD signature (process_activity_service.rb:23-38; ld-compaction.ts mastodonReading).
describe("the inbox member the blank test reads, by path", () => {
  // Each form, and whether Mastodon takes it as received and compacted (compacted with jsonld.js, not Ruby's JSON::LD).
  const forms: [string, (bob: TestActor) => Record<string, unknown>, boolean, boolean][] = [
    ["a URL", (bob) => ({ inbox: `${bob.uri}/inbox` }), true, true],
    ["an object with an id", (bob) => ({ inbox: { id: `${bob.uri}/inbox` } }), true, true],
    ["an empty array", () => ({ inbox: [] }), false, false],
    // [nil] is not blank; compaction drops the null.
    ["an array of null", () => ({ inbox: [null] }), true, false],
    ["an empty object", () => ({ inbox: {} }), false, false],
    ["a next line (U+0085)", () => ({ inbox: "\u0085" }), false, false],
    ["a zero width no-break space (U+FEFF)", () => ({ inbox: "\uFEFF" }), true, true],
    // No `inbox` member as received; compaction names ldp:inbox `inbox`.
    [
      "only its full IRI",
      (bob) => ({ inbox: undefined, "http://www.w3.org/ns/ldp#inbox": { "@id": `${bob.uri}/inbox` } }),
      false,
      true,
    ],
  ];
  const outcome = (taken: boolean) => ({ status: 202, reason: taken ? "actor-updated" : "invalid-actor" });
  // An LD signature as Mastodon writes one (LinkedDataSignature#sign!); nothing verifies it.
  const signed = (bob: TestActor, activity: Record<string, unknown>) => ({
    ...activity,
    signature: { type: "RsaSignature2017", creator: `${bob.uri}#main-key`, created: iso(NOW), signatureValue: "AA==" },
  });

  it.each(forms)(
    "reads %s as served fetched, as received embedded, and compacted embedded in an LD-signed activity",
    async (_name, form, received, compacted) => {
      const { t, bob } = await bobWorld();
      t.web.serve(bob.uri, { ...bob.document, ...form(bob) });
      expect(await receive(t, bob, updateOf(bob, bob.uri))).toMatchObject(outcome(received));
      expect(await receive(t, bob, updateOf(bob, embedded(bob, form(bob))))).toMatchObject(outcome(received));
      const ldSigned = signed(bob, updateOf(bob, embedded(bob, { ...form(bob), name: "compacted" })));
      expect(await receive(t, bob, ldSigned)).toMatchObject(outcome(compacted));
      expect((await row(t, bob.uri)).display_name === "compacted").toBe(compacted);
    },
  );

  // check_jsonld_limits! refuses the activity (its @context counted), or its compaction, and Mastodon reads the
  // activity as received.
  const terms = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`t${i}`, `${MASTODON}/ns#t${i}`]));
  it.each([
    ["a context of over 1,000 values, which compaction replaces", {}, [AS, terms]],
    [
      "an alias of @included, which compaction spells out",
      { also: [{ id: `${MASTODON}/x` }] },
      [AS, { also: "@included" }],
    ],
  ])("reads an LD-signed activity with %s as received", async (_name, extra, context) => {
    const { t, bob } = await bobWorld();
    const activity = updateOf(bob, embedded(bob, { inbox: [null], name: "as received" }), context);
    expect(await receive(t, bob, signed(bob, { ...activity, ...extra }))).toMatchObject(outcome(true));
    expect((await row(t, bob.uri)).display_name).toBe("as received");
  });
});

describe("how the embedded actor is read (D3)", () => {
  const CONTEXTS = "https://contexts.example";
  // A context at `path` reached through `hops` same-origin redirects: hops + 1 requests.
  function servedContext(t: Setup, path: string, hops: number): string {
    for (let hop = 0; hop < hops; hop++) {
      t.web.redirect(`${CONTEXTS}/${path}${hop === 0 ? "" : `-${hop}`}`, `${CONTEXTS}/${path}-${hop + 1}`);
    }
    t.web.serve(
      `${CONTEXTS}/${path}${hops === 0 ? "" : `-${hops}`}`,
      { "@context": { [path]: `${CONTEXTS}/ns#${path}` } },
      "application/ld+json",
    );
    return `${CONTEXTS}/${path}`;
  }

  // The contexts take 6 and 2 requests: with both, the request's REQUEST_MAX_FETCHES are spent before the claim's
  // WebFinger, which is then unanswered (the handle kept, the profile stored); with the first alone it is confirmed.
  it.each([
    ["one context", ["a"], "robert"],
    ["contexts spending the request's budget", ["a", "b"], "bob"],
  ])(
    "loads the activity's non-preloaded contexts once each within the request's budget (%s)",
    async (_name, names, username) => {
      const { t, bob } = await bobWorld();
      serveWebFinger(t.web, "acct:robert@mastodon.example", "acct:robert@mastodon.example", bob.uri);
      const hops: Record<string, number> = { a: 5, b: 1 };
      const contexts = names.map((name) => servedContext(t, name, hops[name]!));
      expect(names.reduce((sum, name) => sum + hops[name]! + 1, 0)).toBeLessThanOrEqual(REQUEST_MAX_FETCHES);
      const update = updateOf(bob, embedded(bob, { preferredUsername: "robert", name: "contexts" }), [AS, ...contexts]);
      expect(await t.post(bob, update)).toBe(202);
      for (const context of contexts) {
        expect(t.web.fetched.filter((url) => url === context)).toHaveLength(1);
      }
      expect(t.web.fetched.includes(webfingerUrl("robert", "mastodon.example"))).toBe(username === "robert");
      expect(await row(t, bob.uri)).toMatchObject({ username, display_name: "contexts" });
    },
  );

  it("leaves out a key entry Fedify cannot import, as for a fetched document, so the actor stays readable", async () => {
    const { t, bob } = await bobWorld();
    const ec = { id: `${bob.uri}#ec-key`, owner: bob.uri, publicKeyPem: await ecPem() };
    const update = updateOf(bob, embedded(bob, { name: "with an EC key", publicKey: [bob.document.publicKey, ec] }));
    expect(await receive(t, bob, update)).toMatchObject({ status: 202, reason: "actor-updated" });
    expect((await row(t, bob.uri)).display_name).toBe("with an EC key");
  });

  // Mastodon's Update(Person) carries the context on the activity, the object none of its own.
  it("stores the object under the activity's context, and asks for a sync of the collections it names", async () => {
    const { t, bob } = await bobWorld();
    await sql(t.store, "DELETE FROM collection_syncs");
    const { "@context": context, ...object } = embedded(bob, {
      featured: `${bob.uri}/collections/featured-2`,
      name: "contextless",
    });
    const outcome = await receive(t, bob, updateOf(bob, object, context));
    expect(outcome).toMatchObject({ status: 202, reason: "actor-updated", jobsPending: true });
    const stored = await row(t, bob.uri);
    expect(stored.display_name).toBe("contextless");
    expect(JSON.parse(stored.raw)).toMatchObject({
      "@context": context,
      featured: `${bob.uri}/collections/featured-2`,
    });
    expect(
      await sql(
        t.store,
        "SELECT count(*) AS n FROM collection_syncs WHERE account_id = ?",
        (await accountId(t.store, bob.uri))!,
      ),
    ).toEqual([{ n: 1 }]);
  });
});

describe("the bounds of an embedded actor (RES-2, RES-1)", () => {
  // Values counted as withinJsonBounds counts them.
  function nodes(value: unknown): number {
    return typeof value === "object" && value !== null
      ? 1 + Object.values(value).reduce<number>((sum, inner) => sum + nodes(inner), 0)
      : 1;
  }
  // An Update whose activity has exactly `count` values: a filler array of the embedded actor grown to it.
  function withNodes(bob: TestActor, count: number) {
    const update = updateOf(bob, embedded(bob, { name: "bounded", filler: [] as number[] }));
    const filler = (update.object as { filler: number[] }).filler;
    filler.push(...Array.from({ length: count - nodes(update) }, () => 0));
    expect(nodes(update)).toBe(count);
    return update;
  }
  // An Update whose activity nests `depth` levels: a chain of arrays in the embedded actor.
  function withDepth(bob: TestActor, depth: number) {
    const update = updateOf(bob, embedded(bob, { name: "bounded", filler: 0 }));
    let chain: unknown = 0;
    for (let level = 0; level < depth - 3; level++) {
      chain = [chain];
    }
    (update.object as { filler: unknown }).filler = chain;
    return update;
  }
  // An Update whose body is exactly `bytes` long: the embedded actor's own summary padded to it (cut when stored).
  function withBytes(bob: TestActor, bytes: number) {
    const update = updateOf(bob, embedded(bob, { name: "bounded", summary: "" }));
    const base = new TextEncoder().encode(JSON.stringify(update)).byteLength;
    (update.object as { summary: string }).summary = "s".repeat(bytes - base);
    expect(new TextEncoder().encode(JSON.stringify(update)).byteLength).toBe(bytes);
    return update;
  }

  it.each([
    ["values", (bob: TestActor, past: boolean) => withNodes(bob, MAX_JSON_NODES + (past ? 1 : 0)), 202],
    ["nesting", (bob: TestActor, past: boolean) => withDepth(bob, MAX_JSON_DEPTH + (past ? 1 : 0)), 202],
    ["bytes", (bob: TestActor, past: boolean) => withBytes(bob, INBOX_BODY_LIMIT + (past ? 1 : 0)), 413],
  ] as const)("stores one at the activity's bound of %s and nothing of one past it", async (_name, build, refused) => {
    const { t, bob } = await bobWorld();
    const before = await row(t, bob.uri);
    expect(await t.post(bob, build(bob, true))).toBe(refused);
    expect(await row(t, bob.uri)).toEqual(before);
    expect(await t.post(bob, build(bob, false))).toBe(202);
    expect((await row(t, bob.uri)).display_name).toBe("bounded");
  });

  // The columns past their stored bounds (remoteActorInput's storedDisplayName, storedText, storedProfileUrl and the
  // emoji snapshot), with NUL and astral characters: the embedded store keeps what a fetched store keeps.
  it("stores an embedded profile past every column's bound as a fetched one", async () => {
    const { t, bob } = await bobWorld();
    const emoji = (n: number) => ({
      id: `${MASTODON}/emojis/${n}`,
      type: "Emoji",
      name: `:e${n}:`,
      icon: { type: "Image", mediaType: "image/png", url: `${MASTODON}/emojis/${n}.png` },
    });
    const oversized = {
      name: `\u0000${"😀".repeat(2_000)}${Array.from({ length: 300 }, (_, n) => `:e${n}:`).join("")}`,
      summary: `<p>${"x\u0000😀".repeat(30_000)}</p>`,
      url: `${MASTODON}/@bob?${"q".repeat(5_000)}`,
      icon: { type: "Image", mediaType: "image/png", url: `${MASTODON}/a?${"a".repeat(5_000)}` },
      tag: Array.from({ length: 300 }, (_, n) => emoji(n)),
    };
    const columns = async () =>
      (
        await sql(
          t.store,
          `SELECT display_name, note, url, avatar_url, header_url, emojis, locked, discoverable, indexable, actor_type
					FROM accounts WHERE uri = ?`,
          bob.uri,
        )
      )[0];
    t.web.serve(bob.uri, embedded(bob, oversized));
    expect(await t.post(bob, updateOf(bob, bob.uri))).toBe(202);
    const fetched = await columns();
    t.web.serve(bob.uri, bob.document);
    expect(await t.post(bob, updateOf(bob, bob.uri))).toBe(202);
    expect(await columns()).not.toEqual(fetched);
    expect(await t.post(bob, updateOf(bob, embedded(bob, oversized)))).toBe(202);
    expect(await columns()).toEqual(fetched);
  });
});

describe("a suspended actor's Update(Person) (R38, VIS-30)", () => {
  it("changes nothing with a fresh key, and refreshes only the routing of a document fetched for its key", async () => {
    const { t, bob } = await bobWorld();
    const id = (await accountId(t.store, bob.uri))!;
    await runInDurableObject(t.store, (_instance, state) =>
      state.storage.transactionSync(() => suspendRemote(new Db(state.storage.sql), id, null, NOW)),
    );
    const before = await row(t, bob.uri);
    const update = updateOf(bob, embedded(bob, { name: "suspended", inbox: `${bob.uri}/inbox-alt` }));
    expect(await receive(t, bob, update)).toMatchObject({ status: 202, reason: "actor-suspended" });
    expect(await row(t, bob.uri)).toEqual(before);
    // With its key a day old, the document it fetches moves the routing (R38), and the profile stays.
    await expire(t, bob.uri);
    t.web.serve(bob.uri, { ...bob.document, inbox: `${bob.uri}/inbox-2` });
    expect(await receive(t, bob, update)).toMatchObject({ status: 202, reason: "actor-suspended" });
    expect(await row(t, bob.uri)).toMatchObject({
      display_name: before.display_name,
      inbox_url: `${bob.uri}/inbox-2`,
    });
  });
});
