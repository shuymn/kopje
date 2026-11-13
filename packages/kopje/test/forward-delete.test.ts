import { type DocumentLoader, exportSpki, signObject, verifyJsonLd } from "@fedify/fedify";
import { CryptographicKey, Delete, Multikey, Person } from "@fedify/vocab";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { Db } from "../src/db/sql";
import {
  audienceTargets,
  BACKLOG_FULL,
  claimDeliveries,
  completeDelivery,
  type DeliveryEnvelope,
  expandPending,
  forwardSubject,
  stageRetraction,
  STAGING_READ,
  stagingRetraction,
} from "../src/domain/deliveries";
import {
  deleteStatusBatch,
  FORWARD_BODY_MAX,
  JOB_BATCHES_PER_RUN,
  MAX_FORWARD_OWNERS,
  MAX_FORWARD_QUOTES,
  PURGE_BATCH,
  purgeBatch,
  receiveActivity,
  type ReceiveResult,
} from "../src/domain/inbox";
import { SWEEP_BATCH } from "../src/domain/remote-actors";
import { verifyAuthorProof } from "../src/federation/author-proof";
import { deliveryRound } from "../src/jobs/deliver";
import { MAX_JSON_DEPTH, withinJsonBounds } from "../src/platform/json-bounds";
import type { StoreStub } from "../src/platform/store-client";
import { RSA_ALGORITHM } from "../src/security/key-wrap";
import { bearer, json, sql } from "./api-helpers";
import { countingStore, harness, NOW } from "./app-helpers";
import { mastodonDelete, mastodonSigned, mastodonStampDelete } from "./author-proof-helpers";
import { batch, batches, remoteAccountsAt, retractionInboxes } from "./delete-job-helpers";
import { fixtureKeyGen, LEGACY_EMPTY_KEK, seedLocalAccount } from "./federation-helpers";
import { BUILD, runStoreJobs } from "./helpers";
import { LOCAL, MASTODON, mastodonActor, signedInit, type TestActor } from "./inbox-helpers";
import {
  ALICE,
  ALICE_URI,
  announce,
  AS,
  create,
  DAVE,
  DAVE_URI,
  followed,
  mastodonNote,
  nextId,
  OTHER,
  PUBLIC,
  setup,
  token,
} from "./inbox-status-helpers";
import { storeReceive, writtenBy } from "./inbox-store-helpers";
import { contexts, deferred, deliveryDeps, quoteAccept } from "./quote-helpers";
import { type PlannedStatement, plannedRun, scansOf, staleStatistics } from "./read-helpers";
import { seedReceipts } from "./status-helpers";

// VIS-3, ID-1, NET-2 (#1206): a remote author's proven Delete of its public or unlisted original is forwarded, as
// received, through each local account holding a kept boost of it (inbox.ts recordForwards), to that account's
// followers and the earlier receivers of its boost, signed by it; staged by the delete job, or by the author's purge,
// before any boost is withdrawn (stageForwards).

const FANS = "https://fans.example";
const RECEIPTS = "https://receipts.example/inbox";

type World = Awaited<ReturnType<typeof world>>;

// alice follows bob (so his statuses are stored), carol (fans.example) follows alice; the inbox requests go through
// a counting Store, whose answers show the proof rounds.
async function world() {
  const clock = { now: NOW };
  const t = await setup(clock);
  const counting = countingStore(t.store);
  const h = harness(counting.stub, {}, undefined, { keygen: fixtureKeyGen, loader: t.web.loader }, () => clock.now);
  const post = async (actor: TestActor, activity: unknown) =>
    (await h.request("/inbox", await signedInit(actor, "/inbox", activity, { at: clock.now }))).status;
  const bob = await mastodonActor(t.web, "bob");
  await followed(t, bob);
  const carol = await mastodonActor(t.web, "carol", { origin: FANS, key: 3 });
  expect(
    await post(carol, {
      "@context": AS,
      id: `${carol.uri}#follows/${nextId()}`,
      type: "Follow",
      actor: carol.uri,
      object: ALICE_URI,
    }),
  ).toBe(202);
  return { t, bob, carol, post, counting, clock };
}

async function statusId(store: StoreStub, uri: string): Promise<string> {
  return (await sql<{ id: string }>(store, "SELECT id FROM statuses WHERE uri = ?", uri))[0]!.id;
}

// `as`'s boost of the status `id` through the API.
async function boost(w: World, id: string, as: "alice" | "dave" = "alice"): Promise<{ id: string; uri: string }> {
  const response = await w.t.request(`/api/v1/statuses/${id}/reblog`, bearer(w.t.tokens[as], { method: "POST" }));
  expect(response.status).toBe(200);
  const body = await response.json<{ id: string; uri: string }>();
  return { id: body.id, uri: body.uri };
}

// bob's Note (public unless `extra` says otherwise), delivered and stored.
async function original(w: World, extra: Record<string, unknown> = {}): Promise<{ uri: string; id: string }> {
  const note = mastodonNote(w.bob, extra);
  expect(await w.post(w.bob, create(w.bob, note))).toBe(202);
  return { uri: note.id, id: await statusId(w.t.store, note.id) };
}

// bob's Delete of `uri` as Mastodon writes it (ActivityPub::DeleteSerializer), unsigned, its id made distinct.
function deletion(actor: TestActor, uri: string): Record<string, unknown> {
  return mastodonDelete(actor, uri, `${uri}#delete-${nextId()}`);
}

// The Delete as Mastodon's always_sign writes it: RsaSignature2017 by `signer`'s key.
const ldSigned = mastodonSigned;

// The answers the Store gave receiveActivity, as the counting Store saw them.
function answers(w: World): ReceiveResult[] {
  return w.counting.records.filter((r) => r.name === "receiveActivity").map((r) => r.answer as ReceiveResult);
}

const proofRounds = (w: World) => answers(w).filter((a) => a.need?.kind === "proof").length;
const actorFetches = (w: World) => w.t.web.fetched.filter((url) => url === w.bob.uri).length;

type Forward = { id: string; account_id: string; body: string; staged: string | null; superseded: number };

// The forwards of `uri` recorded (FORWARD_SUBJECT), in id order.
function forwards(store: StoreStub, uri: string): Promise<Forward[]> {
  return sql<Forward>(
    store,
    `SELECT CAST(id AS TEXT) AS id, account_id, body, staged, superseded FROM outbound_activities
		WHERE object_uri = ? ORDER BY id`,
    forwardSubject(uri),
  );
}

const jobBound = async (store: StoreStub, id: string) =>
  (
    await sql<{ bound: string | null }>(store, "SELECT bound FROM inbound_jobs WHERE kind = 'delete' AND key = ?", id)
  )[0]?.bound;

async function jobs(store: StoreStub): Promise<void> {
  for (let round = 0; round < 200; round++) {
    if (!(await runStoreJobs(store, BUILD, { now: NOW })).pending) {
      return;
    }
  }
  throw new Error("jobs did not finish");
}

type Sent = { inbox: string; body: string; json: Record<string, unknown>; signer: string | null };

// Delivery rounds until nothing is due, each POST answered by `answer` (202 unless it says otherwise); the POSTs
// answered 2xx, in order.
async function deliver(w: World, answer: (url: string, json: Record<string, unknown>) => number = () => 202) {
  const sent: Sent[] = [];
  const record = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = await request.text();
    const json = JSON.parse(body) as Record<string, unknown>;
    const status = answer(request.url, json);
    if (status < 300) {
      const signer = /keyId="([^"#]+)/.exec(request.headers.get("signature") ?? "")?.[1] ?? null;
      sent.push({ inbox: request.url, body, json, signer });
    }
    return new Response(null, { status });
  }) as typeof fetch;
  const deps = deliveryDeps(
    () => w.t.store,
    record,
    () => NOW,
  );
  for (let round = 0; round < 200; round++) {
    const result = await deliveryRound(w.t.env, deps);
    if (result.claimed === 0 && (result.nextDueAt === null || result.nextDueAt > NOW)) {
      return sent;
    }
  }
  throw new Error("delivery did not settle");
}

const objectOf = (json: Record<string, unknown>) =>
  typeof json.object === "string" ? json.object : (json.object as { id?: string } | undefined)?.id;

// bob's public O, boosted by alice; her Announce delivered (carol's server and bob's), and one inbox only a receipt
// of her boost names.
async function boosted(w: World) {
  const o = await original(w);
  const b = await boost(w, o.id);
  await deliver(w);
  await sql(
    w.t.store,
    "INSERT INTO outbound_receipts (status_id, inbox_url, account_id, delivered_at) VALUES (?, ?, ?, 0)",
    b.id,
    RECEIPTS,
    ALICE,
  );
  return { o, b };
}

const bobLoader =
  (bob: TestActor): DocumentLoader =>
  (url) =>
    Promise.resolve({ document: bob.document, documentUrl: url, contextUrl: null });

describe("the forward of a proven Delete through a local boost", () => {
  it("one intent by the booster, staged by the job, POSTed as received to her followers and receivers", async () => {
    const w = await world();
    const { o, b } = await boosted(w);
    // Neither reaches anyone: an activity of alice's keyed by O's own uri, retained with a row at an inbox the boost
    // never reached, and an account no one names.
    await sql(
      w.t.store,
      `INSERT INTO accounts (id, uri, username, domain, inbox_url, shared_inbox_url) VALUES ('860000000000000001',
				'https://named.example/users/n', 'n', 'named.example', 'https://named.example/users/n/inbox',
				'https://named.example/inbox')`,
    );
    const [retained] = await sql<{ id: string }>(
      w.t.store,
      `INSERT INTO outbound_activities (account_id, body, object_uri, created_at)
			VALUES (?, '{"activity":{"type":"Accept"},"audience":{"followers":false,"accounts":[]}}', ?, 0)
			RETURNING CAST(id AS TEXT) AS id`,
      ALICE,
      o.uri,
    );
    await sql(
      w.t.store,
      `INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, state, next_attempt_at, updated_at, last_error)
			VALUES (CAST(? AS INTEGER), ?, 'https://unrelated.example/inbox', 'https://unrelated.example', 'gave_up', 0, 0, 'x')`,
      retained!.id,
      ALICE,
    );
    const body = await ldSigned(deletion(w.bob, o.uri), w.bob);
    expect(await w.post(w.bob, body)).toBe(202);
    expect(proofRounds(w)).toBe(1);
    // The first transaction: hidden, one intent with no targets yet, its id in the job's bound.
    expect(await sql(w.t.store, "SELECT withdrawn, visibility FROM statuses WHERE id = ?", o.id)).toEqual([
      { withdrawn: 1, visibility: "direct" },
    ]);
    const [forward, ...others] = await forwards(w.t.store, o.uri);
    expect(others).toEqual([]);
    expect(forward).toMatchObject({ account_id: ALICE, staged: "", superseded: 0 });
    expect(JSON.parse(forward!.body)).toEqual({
      activity: body,
      audience: { followers: false, accounts: [], shares: [b.id] },
      immutable: true,
    });
    expect(JSON.parse((await jobBound(w.t.store, o.id))!)).toEqual({ forwards: [forward!.id] });
    expect(
      await sql(w.t.store, "SELECT count(*) AS n FROM outbound_targets WHERE activity_id = ?", forward!.id),
    ).toEqual([{ n: 0 }]);
    // The job stages it, then withdraws the boost; every POST of it is the body bob signed, byte for byte.
    await jobs(w.t.store);
    const sent = await deliver(w);
    const forwarded = sent.filter((s) => s.json.type === "Delete");
    expect(forwarded.map((s) => s.inbox).toSorted()).toEqual([`${FANS}/inbox`, `${MASTODON}/inbox`, RECEIPTS]);
    for (const s of forwarded) {
      expect(s.body).toBe(JSON.stringify(body));
      expect(s.signer).toBe(ALICE_URI);
      expect(await verifyJsonLd(s.json, { documentLoader: bobLoader(w.bob), contextLoader: contexts })).toBe(true);
    }
    // In each lane the Delete comes before the boost's Undo.
    for (const inbox of [`${FANS}/inbox`, RECEIPTS]) {
      expect(sent.filter((s) => s.inbox === inbox).map((s) => s.json.type)).toEqual(["Delete", "Undo"]);
    }
    expect(await forwards(w.t.store, o.uri)).toEqual([]);
    expect(await sql(w.t.store, "SELECT id FROM statuses WHERE id IN (?, ?)", o.id, b.id)).toEqual([]);
  });
});

// erin (another server), whose document also carries an Ed25519 assertion method (Multikey) for FEP-8b32 proofs,
// followed by alice.
async function fepActor(w: World): Promise<{ erin: TestActor; ed: CryptoKeyPair }> {
  const rsa = (await crypto.subtle.generateKey(
    { ...RSA_ALGORITHM, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const ed = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const uri = `${OTHER}/users/erin`;
  const person = new Person({
    id: new URL(uri),
    preferredUsername: "erin",
    inbox: new URL(`${uri}/inbox`),
    publicKey: new CryptographicKey({ id: new URL(`${uri}#main-key`), owner: new URL(uri), publicKey: rsa.publicKey }),
    assertionMethods: [
      new Multikey({ id: new URL(`${uri}#ed25519-key`), controller: new URL(uri), publicKey: ed.publicKey }),
    ],
  });
  const document = (await person.toJsonLd({ format: "compact", contextLoader: contexts })) as Record<string, unknown>;
  w.t.web.serve(uri, document);
  const erin: TestActor = {
    uri,
    keyId: `${uri}#main-key`,
    privateKey: rsa.privateKey,
    pem: await exportSpki(rsa.publicKey),
    document,
  };
  await followed(w.t, erin);
  return { erin, ed };
}

describe("the proof round (need proof)", () => {
  it("an FEP-8b32 proof forwards too, and the POSTed body verifies", async () => {
    const w = await world();
    const { erin, ed } = await fepActor(w);
    const note = mastodonNote(erin);
    expect(await w.post(erin, create(erin, note))).toBe(202);
    const id = await statusId(w.t.store, note.id);
    await boost(w, id);
    await deliver(w);
    const unsigned = new Delete({
      id: new URL(`${note.id}#delete`),
      actor: new URL(erin.uri),
      object: new URL(note.id),
    });
    const signed = await signObject(unsigned, ed.privateKey, new URL(`${erin.uri}#ed25519-key`), {
      contextLoader: contexts,
      documentLoader: contexts,
    });
    const json = (await signed.toJsonLd({ format: "compact", contextLoader: contexts })) as Record<string, unknown>;
    expect(await w.post(erin, json)).toBe(202);
    expect(proofRounds(w)).toBe(1);
    expect(await forwards(w.t.store, note.id)).toHaveLength(1);
    await jobs(w.t.store);
    const sent = (await deliver(w)).filter((s) => s.json.type === "Delete");
    expect(sent.map((s) => s.inbox)).toContain(`${FANS}/inbox`);
    for (const s of sent) {
      expect(s.body).toBe(JSON.stringify(json));
      expect(
        await verifyAuthorProof(s.json, { id: `${note.id}#delete`, actor: erin.uri, object: note.id }, erin.document),
      ).toBe(true);
    }
  });

  it("an invalid proof deletes and forwards nothing", async () => {
    const w = await world();
    const { o } = await boosted(w);
    // bob's key id, carol's key: Fedify refuses it, and the Delete applies as bob's, unproven.
    const forged = await ldSigned(deletion(w.bob, o.uri), { ...w.bob, privateKey: w.carol.privateKey });
    const fetched = actorFetches(w);
    expect(await w.post(w.bob, forged)).toBe(202);
    expect(proofRounds(w)).toBe(1);
    expect(actorFetches(w) - fetched).toBe(1);
    expect(await forwards(w.t.store, o.uri)).toEqual([]);
    expect(await jobBound(w.t.store, o.id)).toBeNull();
    await jobs(w.t.store);
    expect(await sql(w.t.store, "SELECT id FROM statuses WHERE id = ?", o.id)).toEqual([]);
    expect((await deliver(w)).filter((s) => s.json.type === "Delete")).toEqual([]);
  });

  it("a proof that cannot be verified now answers 503 with no deletion state; delivered again, it forwards once", async () => {
    const w = await world();
    const { o } = await boosted(w);
    const body = await ldSigned(deletion(w.bob, o.uri), w.bob);
    w.t.web.fail(w.bob.uri, 503);
    expect(await w.post(w.bob, body)).toBe(503);
    expect(proofRounds(w)).toBe(1);
    expect(await sql(w.t.store, "SELECT withdrawn, visibility FROM statuses WHERE id = ?", o.id)).toEqual([
      { withdrawn: 0, visibility: "public" },
    ]);
    expect(await sql(w.t.store, "SELECT key FROM inbound_jobs WHERE kind = 'delete'")).toEqual([]);
    expect(await sql(w.t.store, "SELECT target_uri FROM inbound_retractions WHERE target_uri = ?", o.uri)).toEqual([]);
    expect(await forwards(w.t.store, o.uri)).toEqual([]);
    w.t.web.serve(w.bob.uri, w.bob.document);
    expect(await w.post(w.bob, body)).toBe(202);
    expect(proofRounds(w)).toBe(2);
    expect(await forwards(w.t.store, o.uri)).toHaveLength(1);
  });
});

// An imported local boost by alice of bob's boost `uri` (Kopje writes none: #1247), kept and public.
async function importedBoostOf(w: World, uri: string): Promise<void> {
  await sql(
    w.t.store,
    `INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, content, published_at)
		SELECT '450000000000000001', 'https://kopje.test/imported/boost', ?, id, 'public', '', '2026-10-11T12:00:00.000Z'
		FROM statuses WHERE uri = ?`,
    ALICE,
    uri,
  );
}

describe("no proof round where nothing could be forwarded", () => {
  // Each case has a kept local boost of the status at the Delete, and shows the Delete applied as before; a public
  // original boosted the same way is the control, which asks for the proof.
  it.each([
    ["a private original", "private"],
    ["a direct original", "direct"],
    ["a boost’s Delete", "boost"],
    ["an original whose only local boost is withdrawn", "withdrawn"],
  ] as const)("%s", async (_name, kind) => {
    const w = await world();
    const o = await original(w);
    const b = await boost(w, o.id);
    let target = o.uri;
    if (kind === "private" || kind === "direct") {
      await sql(w.t.store, "UPDATE statuses SET visibility = ? WHERE id = ?", kind, o.id);
    } else if (kind === "boost") {
      const theirs = announce(w.bob, o.uri);
      expect(await w.post(w.bob, theirs)).toBe(202);
      target = theirs.id;
      await importedBoostOf(w, theirs.id);
    } else {
      const response = await w.t.request(
        `/api/v1/statuses/${o.id}/unreblog`,
        bearer(w.t.tokens.alice, { method: "POST" }),
      );
      expect(response.status).toBe(200);
      expect(await sql(w.t.store, "SELECT withdrawn FROM statuses WHERE id = ?", b.id)).toEqual([{ withdrawn: 1 }]);
    }
    const fetched = actorFetches(w);
    expect(await w.post(w.bob, await ldSigned(deletion(w.bob, target), w.bob))).toBe(202);
    expect(proofRounds(w)).toBe(0);
    expect(actorFetches(w) - fetched).toBe(0);
    expect(answers(w).at(-1)).toMatchObject({
      applied: true,
      reason: kind === "boost" ? "boost-deleted" : "status-deleted",
    });
    expect(await sql(w.t.store, "SELECT 1 FROM outbound_activities WHERE object_uri GLOB 'forward *'")).toEqual([]);
    // The control: a public original with a kept local boost asks for the proof.
    const control = await original(w);
    await boost(w, control.id);
    expect(await w.post(w.bob, await ldSigned(deletion(w.bob, control.uri), w.bob))).toBe(202);
    expect(proofRounds(w)).toBe(1);
  });

  it("a proven Delete that reaches the Store records nothing without the job it creates, nor for a boost", async () => {
    const w = await world();
    const o = await original(w);
    await boost(w, o.id);
    const body = await ldSigned(deletion(w.bob, o.uri), w.bob);
    // A job an older build left, the status not hidden: the hide does not mask the job's key check.
    await sql(
      w.t.store,
      "INSERT INTO inbound_jobs (kind, key, actor_uri, created_at) VALUES ('delete', ?, ?, 0)",
      o.id,
      w.bob.uri,
    );
    const proven = { type: "Delete", id: body.id as string, object: o.uri, signed: true, proven: body } as const;
    expect(await storeReceive(w.t.store, w.bob.uri, proven)).toMatchObject({ applied: true, reason: "status-deleted" });
    expect(await forwards(w.t.store, o.uri)).toEqual([]);
    // A boost's Delete, proven, takes the boost's branch.
    const other = await original(w);
    await boost(w, other.id);
    const theirs = announce(w.bob, other.uri);
    expect(await w.post(w.bob, theirs)).toBe(202);
    await importedBoostOf(w, theirs.id);
    expect(
      await storeReceive(w.t.store, w.bob.uri, { ...proven, id: `${theirs.id}#delete`, object: theirs.id }),
    ).toMatchObject({ applied: true, reason: "boost-deleted" });
    expect(await sql(w.t.store, "SELECT 1 FROM outbound_activities WHERE object_uri GLOB 'forward *'")).toEqual([]);
  });
});

// The inboxes the forward of `uri` goes to: its rows and its targets not expanded yet.
const forwardInboxes = (store: StoreStub, uri: string) => retractionInboxes(store, forwardSubject(uri), "Delete");

describe("replays", () => {
  // The inputs at their cap: one owner whose boost has 50,000 receipt-only inboxes, so its forward's staging takes
  // many batches at the real PURGE_BATCH (a batch gathers at most STAGING_READ of them).
  it("mid-job ask for no proof and record nothing more, nor once the job is done", async () => {
    const w = await world();
    const { o, b } = await boosted(w);
    await seedReceipts(w.t.store, b.id, ALICE, 50_000);
    const body = await ldSigned(deletion(w.bob, o.uri), w.bob);
    expect(await w.post(w.bob, body)).toBe(202);
    expect(proofRounds(w)).toBe(1);
    const first = await batch(w.t.store, o.id);
    expect(first.more).toBe(true);
    const [staging] = await forwards(w.t.store, o.uri);
    expect(staging!.staged).not.toBeNull();
    expect(
      await sql(
        w.t.store,
        "SELECT count(*) AS n FROM retraction_reach WHERE staging_id = CAST(? AS INTEGER)",
        staging!.staged,
      ),
    ).toEqual([{ n: expect.toSatisfy((n: number) => n > 0 && n <= STAGING_READ) }]);
    // Mid-job: the job's key, no proof, nothing recorded.
    expect(await w.post(w.bob, body)).toBe(202);
    expect(proofRounds(w)).toBe(1);
    expect(await forwards(w.t.store, o.uri)).toHaveLength(1);
    await batches(w.t.store, o.id);
    const inboxes = await forwardInboxes(w.t.store, o.uri);
    expect(inboxes.size).toBe(50_000 + 3);
    expect(inboxes).toContain(RECEIPTS);
    expect(await forwards(w.t.store, o.uri)).toMatchObject([{ id: staging!.id, staged: null }]);
    // Done: the status is gone, nothing asks for a proof or is recorded.
    expect(await w.post(w.bob, body)).toBe(202);
    expect(proofRounds(w)).toBe(1);
    expect(await forwards(w.t.store, o.uri)).toHaveLength(1);
  }, 300_000);

  it("an unsigned Delete, then the signed one: no forward", async () => {
    const w = await world();
    const { o } = await boosted(w);
    const body = await ldSigned(deletion(w.bob, o.uri), w.bob);
    const unsigned: Record<string, unknown> = { ...body };
    delete unsigned.signature;
    expect(await w.post(w.bob, unsigned)).toBe(202);
    expect(await w.post(w.bob, body)).toBe(202);
    expect(proofRounds(w)).toBe(0);
    expect(await forwards(w.t.store, o.uri)).toEqual([]);
  });

  it("an older build’s job, its status not hidden: the job’s key alone refuses the proof round", async () => {
    const w = await world();
    const { o } = await boosted(w);
    await sql(
      w.t.store,
      "INSERT INTO inbound_jobs (kind, key, actor_uri, created_at) VALUES ('delete', ?, ?, 0)",
      o.id,
      w.bob.uri,
    );
    expect(await sql(w.t.store, "SELECT withdrawn, visibility FROM statuses WHERE id = ?", o.id)).toEqual([
      { withdrawn: 0, visibility: "public" },
    ]);
    expect(await w.post(w.bob, await ldSigned(deletion(w.bob, o.uri), w.bob))).toBe(202);
    expect(proofRounds(w)).toBe(0);
    expect(answers(w).at(-1)).toMatchObject({ applied: true, reason: "status-deleted" });
    expect(await forwards(w.t.store, o.uri)).toEqual([]);
    // The request's batch removed it as before.
    expect(await sql(w.t.store, "SELECT id FROM statuses WHERE id = ?", o.id)).toEqual([]);
  });
});

describe("the first transaction fixes the forwards", () => {
  it("hides an imported status with 500 mentions at once, and refuses a reblog and an unboost until the job", async () => {
    const w = await world();
    const { o, b } = await boosted(w);
    const mentioned = await remoteAccountsAt(w.t.store, "6", "m", 500);
    await sql(
      w.t.store,
      "INSERT INTO status_mentions (status_id, account_id) SELECT ?, value FROM json_each(?)",
      o.id,
      JSON.stringify(mentioned),
    );
    expect(await w.post(w.bob, await ldSigned(deletion(w.bob, o.uri), w.bob))).toBe(202);
    expect(await sql(w.t.store, "SELECT withdrawn, visibility, content FROM statuses WHERE id = ?", o.id)).toEqual([
      { withdrawn: 1, visibility: "direct", content: "" },
    ]);
    expect(await sql(w.t.store, "SELECT count(*) AS n FROM status_mentions WHERE status_id = ?", o.id)).toEqual([
      { n: 500 },
    ]);
    const reblog = await w.t.request(`/api/v1/statuses/${o.id}/reblog`, bearer(w.t.tokens.dave, { method: "POST" }));
    expect(reblog.status).toBe(404);
    const unreblog = await w.t.request(
      `/api/v1/statuses/${o.id}/unreblog`,
      bearer(w.t.tokens.alice, { method: "POST" }),
    );
    expect(unreblog.status).toBe(404);
    expect(await sql(w.t.store, "SELECT withdrawn FROM statuses WHERE id = ?", b.id)).toEqual([{ withdrawn: 0 }]);
    expect(
      await sql(
        w.t.store,
        "SELECT 1 FROM outbound_activities WHERE object_uri = ? AND json_extract(body, '$.activity.type') = 'Undo'",
        b.uri,
      ),
    ).toEqual([]);
    expect((await forwards(w.t.store, o.uri)).map((f) => f.account_id)).toEqual([ALICE]);
    await jobs(w.t.store);
    expect(await sql(w.t.store, "SELECT id FROM statuses WHERE id IN (?, ?)", o.id, b.id)).toEqual([]);
  });

  it("two proven requests held at their proof record one set, with the boost committed during the await", async () => {
    const w = await world();
    const { o } = await boosted(w);
    const body = await ldSigned(deletion(w.bob, o.uri), w.bob);
    const first = w.t.web.hold(w.bob.uri);
    const second = w.t.web.hold(w.bob.uri);
    const requests = [w.post(w.bob, body), w.post(w.bob, body)];
    await Promise.all([first.reached, second.reached]);
    // dave boosts while both wait at their proof.
    const daves = await boost(w, o.id, "dave");
    first.release();
    second.release();
    expect(await Promise.all(requests)).toEqual([202, 202]);
    expect(proofRounds(w)).toBe(2);
    const recorded = await forwards(w.t.store, o.uri);
    expect(recorded.map((f) => f.account_id)).toEqual([ALICE, DAVE]);
    expect(JSON.parse(recorded[1]!.body)).toMatchObject({ audience: { shares: [daves.id] } });
    expect(JSON.parse((await jobBound(w.t.store, o.id))!)).toEqual({ forwards: recorded.map((f) => f.id) });
  });
});

// alice's quote of bob's quotable status, accepted with the stamp `stamp`: the quoting status's uri.
async function quotedWithStamp(w: World, stamp: string): Promise<string> {
  const theirs = mastodonNote(w.bob, { interactionPolicy: { canQuote: { automaticApproval: [PUBLIC] } } });
  expect(await w.post(w.bob, create(w.bob, theirs))).toBe(202);
  w.t.web.serve(theirs.id, { "@context": AS, ...theirs });
  const response = await w.t.request(
    "/api/v1/statuses",
    json({ status: "look", quoted_status_id: await statusId(w.t.store, theirs.id) }, bearer(w.t.tokens.alice)),
  );
  expect(response.status).toBe(200);
  const mine = (await response.json<{ uri: string }>()).uri;
  expect(await w.post(w.bob, quoteAccept(w.bob, mine, stamp))).toBe(202);
  expect(
    await sql(
      w.t.store,
      "SELECT q.state, q.approval_uri FROM quotes q JOIN statuses s ON s.id = q.status_id WHERE s.uri = ?",
      mine,
    ),
  ).toEqual([{ state: "accepted", approval_uri: stamp }]);
  return mine;
}

// The rows of the activity `id` by state.
const rowStates = async (store: StoreStub, id: string) =>
  (
    await sql<{ state: string }>(
      store,
      "SELECT state FROM deliveries WHERE activity_id = CAST(? AS INTEGER) ORDER BY inbox_url",
      id,
    )
  ).map((r) => r.state);

describe("a forward has a subject of its own", () => {
  it("a stamp whose id is the status’s uri: both forwards deliver in full, neither superseded, and retry", async () => {
    const w = await world();
    const { o } = await boosted(w);
    await quotedWithStamp(w, o.uri);
    const first = await ldSigned(deletion(w.bob, o.uri), w.bob);
    expect(await w.post(w.bob, first)).toBe(202);
    const [forward] = await forwards(w.t.store, o.uri);
    expect(forward).toMatchObject({ account_id: ALICE, staged: "" });
    // The job stages it and removes the status; every POST of it is refused and gives up.
    await jobs(w.t.store);
    await deliver(w, (_url, sent) => (sent.type === "Delete" ? 403 : 202));
    const given = await rowStates(w.t.store, forward!.id);
    expect(given.length).toBe(3);
    expect(new Set(given)).toEqual(new Set(["gave_up"]));
    // A later proven Delete of the same uri, now only a stamp: it revokes the quote and records the stamp's forward,
    // which supersedes nothing of the status's.
    const second = await ldSigned(deletion(w.bob, o.uri), w.bob);
    expect(await w.post(w.bob, second)).toBe(202);
    expect(answers(w).at(-1)).toMatchObject({ reason: "stamp-revoked" });
    expect(await forwards(w.t.store, o.uri)).toMatchObject([{ id: forward!.id, superseded: 0 }]);
    const stamp = await sql<{ id: string; superseded: number }>(
      w.t.store,
      "SELECT CAST(id AS TEXT) AS id, superseded FROM outbound_activities WHERE object_uri = ? AND json_extract(body, '$.activity.id') = ?",
      o.uri,
      second.id as string,
    );
    expect(stamp).toMatchObject([{ superseded: 0 }]);
    // The operator's retry sends the given-up rows; both deliver in full.
    const gaveUp = await sql<{ id: string }>(
      w.t.store,
      "SELECT CAST(id AS TEXT) AS id FROM deliveries WHERE activity_id = CAST(? AS INTEGER) AND state = 'gave_up'",
      forward!.id,
    );
    expect(await w.t.store.retryDeliveries(BUILD, { ids: gaveUp.map((r) => r.id), now: NOW })).toMatchObject({
      ok: true,
      retried: 3,
    });
    const sent = (await deliver(w)).filter((s) => s.json.type === "Delete");
    expect(
      sent
        .filter((s) => s.json.id === first.id)
        .map((s) => s.inbox)
        .toSorted(),
    ).toEqual([`${FANS}/inbox`, `${MASTODON}/inbox`, RECEIPTS]);
    expect(sent.filter((s) => s.json.id === second.id).map((s) => s.inbox)).toContain(`${FANS}/inbox`);
    expect(await sql(w.t.store, "SELECT count(*) AS n FROM deliveries")).toEqual([{ n: 0 }]);
  });

  it("a withdrawing Reject of a Follow whose id is the status’s uri leaves the staging forward intact", async () => {
    const w = await world();
    const { o } = await boosted(w);
    // bob follows alice with a Follow whose id is O's uri.
    expect(
      await w.post(w.bob, { "@context": AS, id: o.uri, type: "Follow", actor: w.bob.uri, object: ALICE_URI }),
    ).toBe(202);
    const bobId = (await sql<{ id: string }>(w.t.store, "SELECT id FROM accounts WHERE uri = ?", w.bob.uri))[0]!.id;
    expect(
      await sql(w.t.store, "SELECT state FROM follows WHERE account_id = ? AND target_account_id = ?", bobId, ALICE),
    ).toEqual([{ state: "accepted" }]);
    const body = await ldSigned(deletion(w.bob, o.uri), w.bob);
    expect(await w.post(w.bob, body)).toBe(202);
    const response = await w.t.request(
      `/api/v1/accounts/${bobId}/remove_from_followers`,
      bearer(w.t.tokens.alice, { method: "POST" }),
    );
    expect(response.status).toBe(200);
    const rejects = await sql<{ superseded: number }>(
      w.t.store,
      "SELECT superseded FROM outbound_activities WHERE object_uri = ? AND json_extract(body, '$.activity.type') = 'Reject'",
      o.uri,
    );
    expect(rejects).toEqual([{ superseded: 0 }]);
    expect(await forwards(w.t.store, o.uri)).toMatchObject([{ staged: "", superseded: 0 }]);
    await jobs(w.t.store);
    const sent = (await deliver(w)).filter((s) => s.json.type === "Delete");
    expect(sent.map((s) => s.inbox).toSorted()).toEqual([`${FANS}/inbox`, `${MASTODON}/inbox`, RECEIPTS]);
  });
});

// `n` remote accounts on `host` (ids `<digits>`, two, and 16 digits) behind its one shared inbox, each with its own personal
// inbox there, following alice.
async function followersOn(store: StoreStub, host: string, digit: string, n: number): Promise<void> {
  await sql(
    store,
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
		INSERT INTO accounts (id, uri, username, domain, inbox_url, shared_inbox_url)
		SELECT ?2 || printf('%016d', i), 'https://' || ?3 || '/users/u' || i, 'u' || i, ?3,
			'https://' || ?3 || '/users/u' || i || '/inbox', 'https://' || ?3 || '/inbox' FROM n`,
    n,
    digit,
    host,
  );
  await sql(
    store,
    `INSERT INTO follows (account_id, target_account_id, state)
		SELECT id, ?, 'accepted' FROM accounts WHERE domain = ?`,
    ALICE,
    host,
  );
}

describe("the shared-inbox fallback of a forward", () => {
  it("moves a row in place only for one recipient behind the inbox, its Undo kept behind; others give up", async () => {
    const w = await world();
    await followersOn(w.t.store, "solo.example", "81", 1);
    await followersOn(w.t.store, "duo.example", "82", 2);
    await followersOn(w.t.store, "many.example", "83", 17);
    // One follower whose personal inbox the forward reaches already (a receipt of the boost): no second row there.
    await followersOn(w.t.store, "dup.example", "84", 1);
    const missing = new Set([
      "https://solo.example/inbox",
      "https://duo.example/inbox",
      "https://many.example/inbox",
      "https://dup.example/inbox",
      RECEIPTS,
    ]);
    const o = await original(w);
    const b = await boost(w, o.id);
    // The Announce, addressed, never moves: it gives up at the missing shared inboxes, which so hold no receipt.
    await deliver(w, (url) => (missing.has(url) ? 404 : 202));
    for (const inbox of [RECEIPTS, "https://dup.example/users/u1/inbox"]) {
      await sql(
        w.t.store,
        "INSERT INTO outbound_receipts (status_id, inbox_url, account_id, delivered_at) VALUES (?, ?, ?, 0)",
        b.id,
        inbox,
        ALICE,
      );
    }
    // Its given-up rows swept (GAVE_UP_RETENTION_MS): kept, each would make its inbox an earlier receiver of the
    // boost, whose recipients are unknown, and that inbox's forward row would not move (the documented gap).
    await sql(w.t.store, "DELETE FROM deliveries WHERE state = 'gave_up'");
    const body = await ldSigned(deletion(w.bob, o.uri), w.bob);
    expect(Array.isArray(body.to)).toBe(true);
    expect(await w.post(w.bob, body)).toBe(202);
    const [forward] = await forwards(w.t.store, o.uri);
    await jobs(w.t.store);
    const attempts: string[] = [];
    const sent = await deliver(w, (url, json) => {
      attempts.push(`${String(json.type)} ${url}`);
      return missing.has(url) ? 404 : 202;
    });
    const solo = attempts.filter((a) => a.includes("solo.example"));
    expect(solo).toEqual([
      "Delete https://solo.example/inbox",
      "Delete https://solo.example/users/u1/inbox",
      "Undo https://solo.example/inbox",
    ]);
    expect(sent.filter((s) => s.json.type === "Delete" && s.inbox.includes("solo.example"))).toMatchObject([
      { body: JSON.stringify(body), signer: ALICE_URI },
    ]);
    expect(
      sent.filter((s) => s.json.type === "Delete" && s.inbox === "https://dup.example/users/u1/inbox"),
    ).toHaveLength(1);
    // Two recipients, more than PROVENANCE_MAX (many), unknown ones, or one whose personal inbox has its row: no
    // move, given up visibly.
    const left = await sql<{ inbox_url: string; state: string; last_status: number }>(
      w.t.store,
      "SELECT inbox_url, state, last_status FROM deliveries WHERE activity_id = CAST(? AS INTEGER) ORDER BY inbox_url",
      forward!.id,
    );
    expect(left).toEqual(
      ["https://duo.example/inbox", "https://dup.example/inbox", "https://many.example/inbox", RECEIPTS].map(
        (inbox_url) => ({
          inbox_url,
          state: "gave_up",
          last_status: 404,
        }),
      ),
    );
    expect(attempts.filter((a) => a.startsWith("Delete https://duo.example/users"))).toEqual([]);
  });
});

// `n` more local accounts (ids `4…`), each with a token, each boosting the status `id` through the API.
async function localBoosters(w: World, id: string, n: number): Promise<string[]> {
  const owners: string[] = [];
  for (let i = 1; i <= n; i++) {
    const owner = `4${String(i).padStart(17, "0")}`;
    await seedLocalAccount(w.t.store, "kopje.test", { id: owner, username: `b${i}`, key: LEGACY_EMPTY_KEK });
    const value = await token(w.t.store, owner);
    const response = await w.t.request(`/api/v1/statuses/${id}/reblog`, bearer(value, { method: "POST" }));
    expect(response.status).toBe(200);
    owners.push(owner);
  }
  return owners;
}

// `json` with an unknown property padded so that it serializes to exactly `bytes` UTF-8 bytes.
function paddedTo(json: Record<string, unknown>, bytes: number): Record<string, unknown> {
  const base = utf8(JSON.stringify({ ...json, _pad: "" }));
  return { ...json, _pad: "x".repeat(bytes - base) };
}

const utf8 = (text: string) => new TextEncoder().encode(text).byteLength;

// The Store's receive of a Delete the Worker proved, in one transaction: its answer and the rows it wrote.
async function provenReceive(w: World, body: Record<string, unknown>, object: string) {
  const input = {
    now: NOW,
    storeNow: NOW,
    origin: LOCAL,
    actorUri: w.bob.uri,
    actor: null,
    actorRevision: null,
    activity: { type: "Delete", id: body.id as string, object, signed: true, proven: body },
  } as const;
  return runInDurableObject(w.t.store, (_instance, state) => {
    const db = new Db(state.storage.sql);
    const changes = () => db.first<{ n: number }>("SELECT total_changes() AS n")!.n;
    const before = changes();
    const result = state.storage.transactionSync(() =>
      receiveActivity.run(state.storage.sql, input, (fn) => state.storage.transactionSync(fn)),
    );
    return { result, rows: changes() - before };
  });
}

// The most a forward's envelope adds to its body (recordForwards): one share of a 19-digit id (more than a status id,
// 18 digits, spells), and the job's bound with MAX_FORWARD_OWNERS intent ids of 20 characters each (a signed INTEGER
// key: a sign and 19 digits).
const ENVELOPE_OVERHEAD =
  utf8(
    JSON.stringify({
      activity: {},
      audience: { followers: false, accounts: [], shares: ["9".repeat(19)] },
      immutable: true,
    }),
  ) - 2;
const BOUND_MAX = utf8(
  JSON.stringify({ forwards: Array.from({ length: MAX_FORWARD_OWNERS }, () => `-${"9".repeat(19)}`) }),
);
// The rows a receive writes before any handler (inbox.ts sweep): SWEEP_BATCH of each of its four sources (expired
// retractions, finished jobs, expired mutes, answered quote requests).
const RECEIVE_SWEEP_ROWS = 4 * SWEEP_BATCH;
// The Delete handler's own rows, apart from the batch's budget: the retraction, the deleted object and the job (3); the
// streaming capture, an event, a tombstone and 256 viewers (258, R32); the hide, the status, the last status, the
// card and the copy of withdrawn on the status's own quote row when an import marked it local (4, migration
// 0091_live_local_quotes); retireQuoteOf, the quote, its target's count and the authorization's revocation (3); the
// forwards and the job's bound.
const DELETE_HANDLER_ROWS = 3 + 258 + 4 + 3 + MAX_FORWARD_OWNERS + 1;

// Every other input of the first transaction at its most for the original `o`: it quotes alice's status holding
// Kopje's authorization, its quote row marked local (as an import may: the hide writes its copy of withdrawn), has a
// card, 256 accounts listen (one on the public stream too, so a tombstone is written),
// and the sweep finds SWEEP_BATCH due rows in each source.
async function saturated(w: World, o: { id: string; uri: string }): Promise<void> {
  const quoted = await w.t.request("/api/v1/statuses", json({ status: "quoted" }, bearer(w.t.tokens.alice)));
  const q = await quoted.json<{ id: string; uri: string }>();
  await sql(
    w.t.store,
    `INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, authorization_id, local,
			updated_at)
		VALUES (?, ?, ?, ?, 'accepted', 'authorization-1', 1, '2026-10-11T12:00:00.000Z')`,
    o.id,
    q.uri,
    q.id,
    ALICE,
  );
  await sql(
    w.t.store,
    "INSERT INTO status_cards (status_id, url, due_at, enqueued_at, generation) VALUES (?, 'https://site.example/card', 0, 0, 1)",
    o.id,
  );
  await sql(
    w.t.store,
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 256)
		INSERT INTO stream_subscriptions (account_id, stream_key, sockets) SELECT printf('9%017d', i), 'user', 1 FROM n`,
  );
  await sql(
    w.t.store,
    "INSERT INTO stream_subscriptions (account_id, stream_key, sockets) VALUES (printf('9%017d', 1), 'public', 1)",
  );
  await sql(
    w.t.store,
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
		INSERT INTO inbound_retractions (actor_uri, target_uri, expires_at) SELECT 'https://gone.example/a', 'https://gone.example/t/' || i, 0 FROM n`,
    SWEEP_BATCH,
  );
  await sql(
    w.t.store,
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
		INSERT INTO inbound_jobs (kind, key, actor_uri, done_at, expires_at, created_at)
		SELECT 'purge', 'https://gone.example/u/' || i, 'https://gone.example/u/' || i, 0, 0, 0 FROM n`,
    SWEEP_BATCH,
  );
  const muted = await remoteAccountsAt(w.t.store, "7", "muted", SWEEP_BATCH);
  await sql(
    w.t.store,
    `INSERT INTO mutes (account_id, target_account_id, expires_at)
		SELECT ?, value, '1970-01-01T00:00:00.000Z' FROM json_each(?)`,
    ALICE,
    JSON.stringify(muted),
  );
  await sql(
    w.t.store,
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
		INSERT INTO quote_requests (activity_uri, actor_uri, instrument_uri, quoted_status_id, answered_at)
		SELECT 'https://gone.example/r/' || i, 'https://gone.example/a', 'https://gone.example/i/' || i, ?2, 0 FROM n`,
    SWEEP_BATCH,
    q.id,
  );
}

describe("the first transaction at its bounds (T9b)", () => {
  // The inputs at their cap together: 17 local boosters (16 forwarded), a body of exactly FORWARD_BODY_MAX bytes, a
  // quote holding Kopje's authorization, a card, the largest streaming capture and a full sweep (saturated).
  it("records MAX_FORWARD_OWNERS intents within the derived bytes and rows, logs the cap once, then batches within PURGE_BATCH", async () => {
    const w = await world();
    const o = await original(w);
    const owners = await localBoosters(w, o.id, 17);
    await saturated(w, o);
    const body = paddedTo(await ldSigned(deletion(w.bob, o.uri), w.bob), FORWARD_BODY_MAX);
    expect(utf8(JSON.stringify(body))).toBe(FORWARD_BODY_MAX);
    const warn = vi.spyOn(console, "warn");
    try {
      const { result, rows } = await provenReceive(w, body, o.uri);
      expect(result).toMatchObject({ applied: true, reason: "status-deleted", jobsPending: true });
      expect(warn.mock.calls.filter(([e]) => (e as { event?: string }).event === "kopje.inbox.forward_capped")).toEqual(
        [[{ event: "kopje.inbox.forward_capped", owners: MAX_FORWARD_OWNERS }]],
      );
      const recorded = await forwards(w.t.store, o.uri);
      expect(recorded.map((f) => f.account_id)).toEqual(owners.slice(0, MAX_FORWARD_OWNERS));
      const bound = (await jobBound(w.t.store, o.id))!;
      const bytes = recorded.reduce((n, f) => n + utf8(f.body), 0) + utf8(bound);
      // The forward envelopes and the bound (not every column, nor every row, of the transaction).
      expect(bytes).toBeLessThanOrEqual(MAX_FORWARD_OWNERS * (FORWARD_BODY_MAX + ENVELOPE_OVERHEAD) + BOUND_MAX);
      expect(rows).toBe(RECEIVE_SWEEP_ROWS + DELETE_HANDLER_ROWS);
      console.info({ event: "forward.first-transaction", rows, bytes });
      // Each input reached its most.
      expect(
        await sql(
          w.t.store,
          "SELECT count(*) AS n FROM stream_delete_viewers v JOIN stream_events e ON e.id = v.event_id WHERE e.subject = ?",
          o.id,
        ),
      ).toEqual([{ n: 256 }]);
      expect(await sql(w.t.store, "SELECT count(*) AS n FROM stream_delete_tombstones")).toEqual([{ n: 1 }]);
      expect(await sql(w.t.store, "SELECT state FROM quotes WHERE status_id = ?", o.id)).toEqual([
        { state: "revoked" },
      ]);
      expect(
        await sql(w.t.store, "SELECT count(*) AS n FROM quote_revocations WHERE authorization = 'authorization-1'"),
      ).toEqual([{ n: 1 }]);
      expect(await sql(w.t.store, "SELECT count(*) AS n FROM status_cards WHERE status_id = ?", o.id)).toEqual([
        { n: 0 },
      ]);
      for (const table of ["inbound_retractions", "mutes", "quote_requests"]) {
        expect(
          await sql(
            w.t.store,
            `SELECT count(*) AS n FROM ${table} WHERE ${table === "mutes" ? "expires_at <= '1970-01-02'" : table === "inbound_retractions" ? "expires_at = 0" : "answered_at = 0"}`,
          ),
          table,
        ).toEqual([{ n: 0 }]);
      }
      expect(await sql(w.t.store, "SELECT count(*) AS n FROM inbound_jobs WHERE kind = 'purge'")).toEqual([{ n: 0 }]);
    } finally {
      warn.mockRestore();
    }
    expect(await batches(w.t.store, o.id)).toBeGreaterThan(0);
    expect((await forwards(w.t.store, o.uri)).every((f) => f.staged === null)).toBe(true);
  }, 120_000);

  it.each([
    ["a body one byte over FORWARD_BODY_MAX", "size"],
    ["a body holding a number JSON cannot carry", "number"],
  ] as const)("skips %s, logged without the body", async (_name, reason) => {
    const w = await world();
    const o = await original(w);
    await boost(w, o.id);
    const signed = await ldSigned(deletion(w.bob, o.uri), w.bob);
    const body =
      reason === "size" ? paddedTo(signed, FORWARD_BODY_MAX + 1) : { ...signed, _n: Number.POSITIVE_INFINITY };
    const warn = vi.spyOn(console, "warn");
    try {
      const { result } = await provenReceive(w, body, o.uri);
      expect(result).toMatchObject({ applied: true, reason: "status-deleted" });
      expect(
        warn.mock.calls.filter(([e]) => (e as { event?: string }).event === "kopje.inbox.forward_skipped"),
      ).toEqual([
        [
          {
            event: "kopje.inbox.forward_skipped",
            reason,
            bytes: reason === "size" ? FORWARD_BODY_MAX + 1 : utf8(JSON.stringify(body)),
          },
        ],
      ]);
    } finally {
      warn.mockRestore();
    }
    expect(await forwards(w.t.store, o.uri)).toEqual([]);
    expect(await jobBound(w.t.store, o.id)).toBeOneOf([null, undefined]);
  });
});

// A follower of alice with a personal inbox only.
async function loner(w: World): Promise<string> {
  await sql(
    w.t.store,
    `INSERT INTO accounts (id, uri, username, domain, inbox_url) VALUES ('840000000000000001',
			'https://loner.example/users/l', 'l', 'loner.example', 'https://loner.example/users/l/inbox')`,
  );
  await sql(
    w.t.store,
    "INSERT INTO follows (account_id, target_account_id, state) VALUES ('840000000000000001', ?, 'accepted')",
    ALICE,
  );
  return "https://loner.example/users/l/inbox";
}

// Strings JSON escapes or may not: an astral character, NUL, a lone surrogate, U+2028 escaped and raw.
const ADVERSARIAL = '"\\ud83d\\ude00 \\u0000 \\ud800 \\u2028  "';

describe("the body from the request to the POST", () => {
  it("POSTs the Store’s serialization of a signed body to shared and personal inboxes, and its proof verifies", async () => {
    const w = await world();
    const personal = await loner(w);
    const { o } = await boosted(w);
    // Inside the signed graph, in the one string a Mastodon Delete leaves free (its Tombstone's atomUri): the strings,
    // sent with their escapes as written and serialized by the Store as JSON.stringify does. (A number cannot be in a
    // proven body: author-proof.ts PROFILES; the RPC test below carries 1e20.)
    const unsigned = deletion(w.bob, o.uri);
    const tombstone = unsigned.object as Record<string, unknown>;
    const adversarial = JSON.parse(ADVERSARIAL) as string;
    const signed = await ldSigned({ ...unsigned, object: { ...tombstone, atomUri: adversarial } }, w.bob);
    const raw = JSON.stringify(signed).replace(JSON.stringify(adversarial), ADVERSARIAL);
    expect(raw).toContain(ADVERSARIAL);
    const s = JSON.stringify(JSON.parse(raw));
    expect(await w.post(w.bob, raw)).toBe(202);
    expect(proofRounds(w)).toBe(1);
    expect(await forwards(w.t.store, o.uri)).toHaveLength(1);
    await jobs(w.t.store);
    const sent = (await deliver(w)).filter((d) => d.json.type === "Delete");
    expect(sent.map((d) => d.inbox).toSorted()).toEqual(
      [`${FANS}/inbox`, `${MASTODON}/inbox`, personal, RECEIPTS].toSorted(),
    );
    for (const d of sent) {
      expect(d.body).toBe(s);
      const expected = { id: signed.id as string, actor: w.bob.uri, object: o.uri };
      expect(await verifyAuthorProof(d.json, expected, w.bob.document)).toBe(true);
    }
  });

  it("POSTs, byte for byte, what the RPC clone carried: __proto__, 1e20 and the deepest nesting the inbox takes", async () => {
    const w = await world();
    const personal = await loner(w);
    const { o } = await boosted(w);
    // MAX_JSON_DEPTH: the root, `_x` and 29 arrays around a scalar.
    const deep = `${"[".repeat(MAX_JSON_DEPTH - 3)}0${"]".repeat(MAX_JSON_DEPTH - 3)}`;
    const proven = JSON.parse(
      `${JSON.stringify(deletion(w.bob, o.uri)).slice(0, -1)},"_x":{"__proto__":{"a":1},"s":${ADVERSARIAL},` +
        `"n":1e20,"d":${deep}}}`,
    ) as Record<string, unknown>;
    expect(withinJsonBounds(proven)).toBe(true);
    const s = JSON.stringify(proven);
    expect(s).toContain('"__proto__":{"a":1}');
    const activity = { type: "Delete", id: proven.id as string, object: o.uri, signed: true, proven } as const;
    expect(await storeReceive(w.t.store, w.bob.uri, activity)).toMatchObject({ applied: true, jobsPending: true });
    expect(JSON.parse((await forwards(w.t.store, o.uri))[0]!.body)).toMatchObject({ immutable: true });
    await jobs(w.t.store);
    const sent = (await deliver(w)).filter((d) => d.json.type === "Delete");
    expect(sent.map((d) => d.inbox).toSorted()).toEqual(
      [`${FANS}/inbox`, `${MASTODON}/inbox`, personal, RECEIPTS].toSorted(),
    );
    for (const d of sent) {
      expect(d.body).toBe(s);
    }
  });

  it("sends an immutable stamp forward’s personal copy unedited", async () => {
    const w = await world();
    const theirs = mastodonNote(w.bob, { interactionPolicy: { canQuote: { automaticApproval: [PUBLIC] } } });
    expect(await w.post(w.bob, create(w.bob, theirs))).toBe(202);
    w.t.web.serve(theirs.id, { "@context": AS, ...theirs });
    // alice's direct quote naming bob: the stamp's forward reaches bob silently, a personal copy.
    const response = await w.t.request(
      "/api/v1/statuses",
      json(
        {
          status: "@bob@mastodon.example look",
          visibility: "direct",
          quoted_status_id: await statusId(w.t.store, theirs.id),
        },
        bearer(w.t.tokens.alice),
      ),
    );
    expect(response.status).toBe(200);
    const mine = (await response.json<{ uri: string }>()).uri;
    const stamp = `${w.bob.uri}/quote_authorizations/${nextId()}`;
    expect(await w.post(w.bob, quoteAccept(w.bob, mine, stamp))).toBe(202);
    await deliver(w);
    const body = await ldSigned(mastodonStampDelete(w.bob, { uri: stamp, quoting: mine, quoted: theirs.id }), w.bob);
    expect(await w.post(w.bob, body)).toBe(202);
    const sent = (await deliver(w)).filter((d) => d.json.type === "Delete");
    expect(sent.map((d) => d.inbox)).toContain(`${MASTODON}/users/bob/inbox`);
    for (const d of sent) {
      expect(d.body).toBe(JSON.stringify(body));
    }
  });
});

describe("the purge, the job and the claims interleaved", () => {
  // Two owners whose boosts each have 3,000 receipt-only inboxes (so staging spans batches: STAGING_READ a batch), the
  // author's DeleteActor purge and the status's job run batch by batch with delivery claims between them, and an
  // unrelated local status's Delete staged by its own job meanwhile.
  it("stages every forward before its boost is withdrawn, once per inbox, Delete before Undo in each lane", async () => {
    const w = await world();
    const o = await original(w);
    const alices = await boost(w, o.id);
    const daves = await boost(w, o.id, "dave");
    await deliver(w);
    await seedReceipts(w.t.store, alices.id, ALICE, 3_000);
    // dave's receipts on other servers than alice's: each owner's targets are its own.
    await sql(
      w.t.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000)
			INSERT INTO outbound_receipts (status_id, inbox_url, account_id, delivered_at)
			SELECT ?, 'https://d' || i || '.example/inbox', ?, 0 FROM n`,
      daves.id,
      DAVE,
    );
    // alice's own status, boosted by dave, deleted by her: its job's bound is its media deadline.
    const posted = await w.t.request("/api/v1/statuses", json({ status: "mine" }, bearer(w.t.tokens.alice)));
    const mine = await posted.json<{ id: string; uri: string }>();
    await boost(w, mine.id, "dave");
    await deliver(w);
    const deleted = await w.t.request(`/api/v1/statuses/${mine.id}`, bearer(w.t.tokens.alice, { method: "DELETE" }));
    expect(deleted.status).toBe(200);
    expect(await jobBound(w.t.store, mine.id)).toMatch(/^\d{4}-/);
    const body = await ldSigned(deletion(w.bob, o.uri), w.bob);
    expect(await w.post(w.bob, body)).toBe(202);
    const recorded = await forwards(w.t.store, o.uri);
    expect(recorded.map((f) => f.account_id)).toEqual([ALICE, DAVE]);
    expect(await storeReceive(w.t.store, w.bob.uri, { type: "DeleteActor", id: `${w.bob.uri}#delete` })).toMatchObject({
      applied: true,
      jobsPending: true,
    });
    // The purge's first batch, in that request, reached the barrier: it staged forward targets before any boost.
    expect(
      await sql(
        w.t.store,
        `SELECT count(*) AS n FROM outbound_activities o
					JOIN retraction_reach r ON r.staging_id = CAST(o.staged AS INTEGER)
				WHERE o.id IN (CAST(? AS INTEGER), CAST(? AS INTEGER))`,
        recorded[0]!.id,
        recorded[1]!.id,
      ),
    ).not.toEqual([{ n: 0 }]);
    expect(await sql(w.t.store, "SELECT withdrawn FROM statuses WHERE id IN (?, ?)", alices.id, daves.id)).toEqual([
      { withdrawn: 0 },
      { withdrawn: 0 },
    ]);
    const staged = async () =>
      new Map((await forwards(w.t.store, o.uri)).map((f) => [f.account_id, f.staged] as const));
    // Every boost of O withdrawn (its Undo recorded) or gone has its owner's forward staged (or settled) already.
    const check = async (step: string) => {
      const kept = await sql<{ account_id: string }>(
        w.t.store,
        "SELECT account_id FROM statuses WHERE id IN (?, ?) AND withdrawn = 0",
        alices.id,
        daves.id,
      );
      const now = await staged();
      for (const owner of [ALICE, DAVE]) {
        if (!kept.some((k) => k.account_id === owner)) {
          expect(now.get(owner) ?? null, `${step}: ${owner}`).toBeNull();
        }
      }
    };
    const sent: Sent[] = [];
    const record = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const text = await request.text();
      const signer = /keyId="([^"#]+)/.exec(request.headers.get("signature") ?? "")?.[1] ?? null;
      sent.push({ inbox: request.url, body: text, json: JSON.parse(text) as Record<string, unknown>, signer });
      return new Response(null, { status: 202 });
    }) as typeof fetch;
    const deps = deliveryDeps(
      () => w.t.store,
      record,
      () => NOW,
    );
    const pending = async (key: string, kind: string) =>
      (await sql(w.t.store, "SELECT 1 FROM inbound_jobs WHERE kind = ? AND key = ? AND done_at IS NULL", kind, key))
        .length > 0;
    for (let step = 0; step < 400; step++) {
      const remote = await pending(o.id, "delete");
      const purge = await pending(w.bob.uri, "purge");
      const local = await pending(mine.id, "delete");
      if (!remote && !purge && !local) {
        break;
      }
      const kind = step % 4;
      if (kind === 0 && remote) {
        expect((await writtenBy(w.t.store, (db) => deleteStatusBatch(db, o.id, NOW))).rows).toBeLessThanOrEqual(
          PURGE_BATCH,
        );
      } else if (kind === 1 && purge) {
        expect((await writtenBy(w.t.store, (db) => purgeBatch(db, w.bob.uri, NOW))).rows).toBeLessThanOrEqual(
          PURGE_BATCH,
        );
      } else if (kind === 2 && local) {
        const before = await staged();
        await writtenBy(w.t.store, (db) => deleteStatusBatch(db, mine.id, NOW));
        // The local job stages its own Delete; no forward of O moves with it.
        expect(await staged()).toEqual(before);
      } else if (kind === 3) {
        await deliveryRound(w.t.env, deps);
      }
      await check(`step ${step}`);
    }
    expect(
      await sql(w.t.store, "SELECT 1 FROM inbound_jobs WHERE done_at IS NULL AND kind IN ('delete', 'purge')"),
    ).toEqual([]);
    expect((await staged()).size === 0 || [...(await staged()).values()].every((s) => s === null)).toBe(true);
    // Every target once per (owner, inbox): the rows, the targets not expanded, and what was POSTed.
    await runInDurableObject(w.t.store, (_instance, state) => {
      state.storage.transactionSync(() => expandPending(new Db(state.storage.sql), NOW, Number.MAX_SAFE_INTEGER));
    });
    for (const f of recorded) {
      const rows = await sql<{ inbox: string }>(
        w.t.store,
        "SELECT inbox_url AS inbox FROM deliveries WHERE activity_id = CAST(? AS INTEGER)",
        f.id,
      );
      const signer = f.account_id === ALICE ? ALICE_URI : DAVE_URI;
      const posted = sent
        .filter((s) => s.json.type === "Delete" && objectOf(s.json) === o.uri && s.signer === signer)
        .map((s) => s.inbox);
      const all = [...rows.map((r) => r.inbox), ...posted];
      expect(new Set(all).size, f.account_id).toBe(all.length);
      // Exactly the owner's own: its boost's receivers (its Announce's servers, then the seeded receipts) and its
      // followers (alice's carol on fans.example; dave's bob, purged, had a receipt).
      const expected =
        f.account_id === ALICE
          ? [
              `${FANS}/inbox`,
              `${MASTODON}/inbox`,
              ...Array.from({ length: 3_000 }, (_, i) => `https://r${i + 1}.example/inbox`),
            ]
          : [`${MASTODON}/inbox`, ...Array.from({ length: 3_000 }, (_, i) => `https://d${i + 1}.example/inbox`)];
      expect(new Set(all), f.account_id).toEqual(new Set(expected));
    }
    // Delete before Undo in each lane: what was POSTed, and the rows still due.
    const lanes = await sql<{ account_id: string; lane: string; deletes: number; undos: number }>(
      w.t.store,
      `SELECT d.account_id, d.lane, max(CASE WHEN o.object_uri GLOB 'forward *' THEN d.id END) AS deletes,
				min(CASE WHEN json_extract(o.body, '$.activity.type') = 'Undo' THEN d.id END) AS undos
			FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id GROUP BY d.account_id, d.lane`,
    );
    for (const lane of lanes.filter((l) => l.deletes !== null && l.undos !== null)) {
      expect(BigInt(lane.deletes) < BigInt(lane.undos), lane.lane).toBe(true);
    }
    for (const signer of [ALICE_URI, DAVE_URI]) {
      const order = sent.filter((s) => s.signer === signer);
      for (const inbox of new Set(order.map((s) => s.inbox))) {
        const types = order.filter((s) => s.inbox === inbox).map((s) => `${String(s.json.type)} ${objectOf(s.json)}`);
        const undo = types.findIndex((t) => t.startsWith("Undo"));
        const forward = types.indexOf(`Delete ${o.uri}`);
        if (undo !== -1 && forward !== -1) {
          expect(forward, inbox).toBeLessThan(undo);
        }
      }
    }
    expect(await sql(w.t.store, "SELECT count(*) AS n FROM deliveries WHERE last_error = ?", BACKLOG_FULL)).toEqual([
      { n: 0 },
    ]);
  }, 300_000);
});

describe("the barrier runs at an original’s first boost", () => {
  it("stages the forward before an older withdrawn generation of the boost is removed", async () => {
    const w = await world();
    const o = await original(w);
    const old = await boost(w, o.id);
    const undone = await w.t.request(`/api/v1/statuses/${o.id}/unreblog`, bearer(w.t.tokens.alice, { method: "POST" }));
    expect(undone.status).toBe(200);
    const kept = await boost(w, o.id);
    expect(BigInt(old.id) < BigInt(kept.id)).toBe(true);
    expect(
      await sql(w.t.store, "SELECT id, withdrawn FROM statuses WHERE id IN (?, ?) ORDER BY id", old.id, kept.id),
    ).toEqual([
      { id: old.id, withdrawn: 1 },
      { id: kept.id, withdrawn: 0 },
    ]);
    // The kept boost's forward takes more than one batch to stage.
    await seedReceipts(w.t.store, kept.id, ALICE, 60_000);
    expect(await w.post(w.bob, await ldSigned(deletion(w.bob, o.uri), w.bob))).toBe(202);
    const [forward] = await forwards(w.t.store, o.uri);
    expect(JSON.parse(forward!.body)).toMatchObject({ audience: { shares: [kept.id] } });
    await batches(w.t.store, o.id, async (n) => {
      const oldLeft = await sql(w.t.store, "SELECT 1 FROM statuses WHERE id = ?", old.id);
      const [now] = await forwards(w.t.store, o.uri);
      if (oldLeft.length === 0) {
        expect(now?.staged ?? null, `batch ${n}`).toBeNull();
      } else if (n === 1) {
        // The first batch met the withdrawn generation first, and staged the forward instead of removing it.
        expect(now!.staged).not.toBeNull();
      }
    });
    expect(await sql(w.t.store, "SELECT 1 FROM statuses WHERE id IN (?, ?, ?)", o.id, old.id, kept.id)).toEqual([]);
    expect((await forwardInboxes(w.t.store, o.uri)).size).toBe(60_000 + 2);
  }, 300_000);
});

// The statements this change adds or changes, by a fragment of each, and the names their plans give the large tables
// they read: none may be scanned. The local accounts are walked by design (KEPT_LOCAL_BOOSTS: one seek each).
const CHANGED =
  /INDEXED BY outbound_activities_object|statuses_account_reblogs_kept|length\(CAST\(bound AS BLOB\)\)|json_each\(\?1\) f CROSS JOIN outbound_activities|id = CAST\(\?3 AS INTEGER\) AND account_id = \?1|WHERE s\.id = \?1 AND s\.account_id = \?2 AND \(s\.reblog_of_id IS NOT NULL|INDEXED BY quotes_local_live|'\$\.audience\.shares'\) = 'array' AS forward|recipients_many IS NULL|e\.inbox_url = \?2|FROM inbound_jobs WHERE kind = 'delete' AND key = \?|o\.id AS original|SET bound = \?|reblog_of_id, visibility, withdrawn FROM statuses/;
const LARGE = [
  "quotes",
  "q",
  "statuses",
  "r",
  "o",
  "s",
  "accounts",
  "a",
  "outbound_activities",
  "deliveries",
  "d",
  "e",
  "inbound_jobs",
  "j",
  "c",
];
// Of them, the statements the job runs whose reads the change bounds, each run on its own (the boosts' walk, which
// reads every boost of the original each round, is #1253's and only gains two columns here).
const OWN =
  /length\(CAST\(bound AS BLOB\)\)|json_each\(\?1\) f CROSS JOIN outbound_activities|id = CAST\(\?3 AS INTEGER\) AND account_id = \?1|WHERE s\.id = \?1 AND s\.account_id = \?2 AND \(s\.reblog_of_id IS NOT NULL|SET bound = \?|INDEXED BY outbound_activities_object/;

// O's history past any floor: 3,000 remote boosts of it, 1,000 withdrawn generations of alice's boost, 10,000 received
// quotes of it and 10,000 withdrawn local ones (none of which quotes_local_live holds), 10,000 retained intents of
// alice about its uri and its forward subject each, and an intent of dave's with the largest id there is.
async function grow(w: World, o: { id: string; uri: string }, digit: string): Promise<void> {
  const boosters = await remoteAccountsAt(w.t.store, digit, `g${digit}x`, 3000);
  await sql(
    w.t.store,
    `INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, content, published_at)
		SELECT '7' || ?3 || substr(value, 3), 'https://boost.example/' || value, value, ?1, 'public', '',
			'2026-10-11T12:00:00.000Z'
		FROM json_each(?2)`,
    o.id,
    JSON.stringify(boosters),
    digit,
  );
  await sql(
    w.t.store,
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000)
		INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, content, published_at, withdrawn)
		SELECT ?1 || printf('%016d', i), 'https://kopje.test/withdrawn/' || ?1 || i, ?2, ?3, 'public', '',
			'2026-10-11T12:00:00.000Z', 1 FROM n`,
    `3${digit}`,
    ALICE,
    o.id,
  );
  for (const [prefix, author, withdrawn, local] of [
    ["8", boosters[0]!, 0, 0],
    ["2", ALICE, 1, 1],
  ] as const) {
    await sql(
      w.t.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000)
			INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, withdrawn)
			SELECT ?1 || ?2 || printf('%016d', i), 'https://kopje.test/quoting/' || ?1 || ?2 || i, ?3, 'public', '',
				'2026-10-11T12:00:00.000Z', ?4 FROM n`,
      prefix,
      digit,
      author,
      withdrawn,
    );
    await sql(
      w.t.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000)
			INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, local, updated_at)
			SELECT ?1 || ?2 || printf('%016d', i), s.uri, s.id, s.account_id, 'pending', ?4, '2026-10-11T12:00:00.000Z'
			FROM n CROSS JOIN statuses s WHERE s.id = ?3`,
      prefix,
      digit,
      o.id,
      local,
    );
  }
  for (const subject of [o.uri, forwardSubject(o.uri)]) {
    await sql(
      w.t.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000)
			INSERT INTO outbound_activities (account_id, body, object_uri, retracts, staged, created_at)
			SELECT ?, json_object('activity', json_object('type', 'Delete', 'id', 'old' || i), 'audience',
				json_object('followers', json('false'), 'accounts', json('[]'))), ?, 1, NULL, 0 FROM n`,
      ALICE,
      subject,
    );
  }
  await sql(
    w.t.store,
    `INSERT OR IGNORE INTO outbound_activities (id, account_id, body, object_uri, created_at)
		VALUES (9223372036854775807, ?, '{"activity":{},"audience":{"followers":false,"accounts":[]}}', 'unrelated', 0)`,
    DAVE,
  );
}

// Runs `operation` in one transaction over plannedSql (`pattern`), as the Store runs a write.
const planned = <I, O>(
  store: StoreStub,
  pattern: RegExp,
  operation: { run: (sql: SqlStorage, input: I) => O },
  input: I,
) => plannedRun({ store }, pattern, operation, input, true);

const job = { run: (sql: SqlStorage, id: string) => deleteStatusBatch(new Db(sql), id, NOW) };

describe("the forward’s reads under stale statistics (T12, RES-7)", () => {
  it("reads no more in the request and the job’s first batch past O’s history, and plans no scan of a large table", async () => {
    const w = await world();
    const request = async (o: { id: string; uri: string }, pattern: RegExp) => {
      const body = await ldSigned(deletion(w.bob, o.uri), w.bob);
      return planned(w.t.store, pattern, receiveActivity, {
        now: NOW,
        storeNow: NOW,
        origin: LOCAL,
        actorUri: w.bob.uri,
        actor: null,
        actorRevision: null,
        activity: { type: "Delete", id: body.id as string, object: o.uri, signed: true, proven: body },
      });
    };
    const rowsOf = (plans: PlannedStatement[]) => plans.reduce((n, p) => n + p.rows, 0);
    const scans: string[] = [];
    const seen = new Map<string, string[]>();
    const scanned = (name: string, plans: PlannedStatement[]) => {
      for (const { query, plan } of plans.filter((p) => CHANGED.test(p.query))) {
        const flat = query.replace(/\s+/g, " ");
        seen.set(flat, plan);
        for (const detail of scansOf(plan, LARGE)) {
          scans.push(`${name}: ${detail} :: ${flat.slice(0, 120)}`);
        }
      }
    };
    const measure = async (phase: "before" | "after") => {
      const o = await original(w);
      await boost(w, o.id);
      await localQuote(w, o, { receipts: [QP] });
      if (phase === "after") {
        await grow(w, o, "5");
      }
      const asked = await request(o, /./);
      const first = await planned(w.t.store, /./, job, o.id);
      scanned(`request ${phase}`, asked.plans);
      scanned(`job ${phase}`, first.plans);
      // The job's own statements run once per boost it meets (at most PURGE_BATCH a batch): each run's reads.
      const own = first.plans.filter((p) => OWN.test(p.query)).map((p) => p.rows);
      return { o, request: rowsOf(asked.plans), job: Math.max(...own) };
    };
    const { before, after } = await staleStatistics(w.t, {
      capture: measure,
      grow: () => Promise.resolve(),
    });
    console.info({
      event: "forward.stale-statistics",
      before: [before.request, before.job],
      after: [after.request, after.job],
    });
    expect(after.request).toBeLessThanOrEqual(before.request + 20);
    expect(after.job).toBeLessThanOrEqual(before.job + 20);
    // The ids are TEXT, beside an existing intent with the largest id there is.
    const { forwards: ids } = JSON.parse((await jobBound(w.t.store, after.o.id))!) as { forwards: string[] };
    expect(ids).toHaveLength(1);
    const recorded = (await forwards(w.t.store, after.o.uri)).filter((f) => ids.includes(f.id));
    expect(recorded).toMatchObject([{ account_id: ALICE, staged: null }]);
    expect(typeof recorded[0]!.id).toBe("string");
    expect(await sql(w.t.store, "SELECT CAST(max(id) AS TEXT) AS id FROM outbound_activities")).toEqual([
      { id: "9223372036854775807" },
    ]);
    // The proof round's reads (forwardable), past the same history of another original.
    const ask = await original(w);
    await boost(w, ask.id);
    await grow(w, ask, "6");
    const signedOnly = await ldSigned(deletion(w.bob, ask.uri), w.bob);
    const asked = await planned(w.t.store, CHANGED, receiveActivity, {
      now: NOW,
      storeNow: NOW,
      origin: LOCAL,
      actorUri: w.bob.uri,
      actor: null,
      actorRevision: null,
      activity: { type: "Delete", id: signedOnly.id as string, object: ask.uri, signed: true },
    });
    expect(asked.result).toMatchObject({ need: { kind: "proof", uri: w.bob.uri } });
    expect(rowsOf(asked.plans)).toBeLessThanOrEqual(before.request);
    scanned("ask", asked.plans);
    // The proof round of a quote-only original (no boost to stop at): its quotes' seek reads no more past 10,000
    // received and 10,000 withdrawn local quotes of it (grow).
    const quoteOnlyAsk = async (o: { id: string; uri: string }) => {
      const body = await ldSigned(deletion(w.bob, o.uri), w.bob);
      const run = await planned(w.t.store, /./, receiveActivity, {
        now: NOW,
        storeNow: NOW,
        origin: LOCAL,
        actorUri: w.bob.uri,
        actor: null,
        actorRevision: null,
        activity: { type: "Delete", id: body.id as string, object: o.uri, signed: true },
      });
      expect(run.result).toMatchObject({ need: { kind: "proof", uri: w.bob.uri } });
      scanned("ask quote-only", run.plans);
      return rowsOf(run.plans);
    };
    const lean = await original(w);
    await localQuote(w, lean);
    const grown = await original(w);
    await localQuote(w, grown);
    await grow(w, grown, "7");
    const [leanRows, grownRows] = [await quoteOnlyAsk(lean), await quoteOnlyAsk(grown)];
    console.info({ event: "forward.quote-only-ask", lean: leanRows, grown: grownRows });
    expect(grownRows).toBeLessThanOrEqual(leanRows + 20);
    // The fallback's reads: a forward row at a shared inbox answering 404, its one recipient behind it.
    await jobs(w.t.store);
    await sql(w.t.store, "DELETE FROM deliveries");
    await sql(w.t.store, "DELETE FROM outbound_targets");
    await followersOn(w.t.store, "plan.example", "85", 1);
    const third = await original(w);
    await boost(w, third.id);
    // Its Announce gives up there and its row is swept, so neither a receipt nor that row makes the forward row's
    // recipients unknown.
    await deliver(w, (url) => (url === "https://plan.example/inbox" ? 404 : 202));
    await sql(w.t.store, "DELETE FROM deliveries WHERE state = 'gave_up'");
    await request(third, /^$/);
    await jobs(w.t.store);
    const claim = await planned(w.t.store, CHANGED, claimDeliveries, { now: NOW, leaseToken: "plan", limit: 16 });
    const row = (
      await sql<{ id: string }>(
        w.t.store,
        "SELECT CAST(id AS TEXT) AS id FROM deliveries WHERE inbox_url = 'https://plan.example/inbox' AND lease_token = 'plan'",
      )
    )[0];
    expect(row).toBeDefined();
    const failed = await planned(w.t.store, CHANGED, completeDelivery, {
      id: row!.id,
      leaseToken: "plan",
      now: NOW,
      outcome: { kind: "failed", status: 404, error: "HTTP 404", permanent: true },
    });
    expect(failed.result).toMatchObject({ status: "retry" });
    scanned("claim", claim.plans);
    scanned("fallback", failed.plans);
    expect(scans).toEqual([]);
    // Every changed statement was planned.
    const fragments = CHANGED.source.split("|");
    for (const fragment of fragments) {
      const pattern = new RegExp(fragment);
      expect(
        [...seen.keys()].some((q) => pattern.test(q)),
        fragment,
      ).toBe(true);
    }
    // The candidate seek is one search of the kept boosts' unique index per local account.
    const kept = [...seen]
      .filter(([q]) => q.includes("statuses_account_reblogs_kept"))
      .map(([, plan]) => plan.join(" | "));
    expect(kept.length).toBeGreaterThan(0);
    for (const plan of kept) {
      expect(plan).toMatch(/SEARCH r USING INDEX statuses_account_reblogs_kept \(account_id=\? AND reblog_of_id=\?\)/);
    }
  }, 300_000);
});

describe("the forwarding members and their bound", () => {
  it("forwards nothing through a converted limited boost, whose booster’s followers may not see it", async () => {
    const w = await world();
    const o = await original(w);
    const alices = await boost(w, o.id);
    // A converted boost addressed to dave alone; carol, alice's follower, may not see it.
    await sql(w.t.store, "UPDATE statuses SET visibility = 'limited' WHERE id = ?", alices.id);
    await sql(
      w.t.store,
      "INSERT INTO status_mentions (status_id, account_id, silent) VALUES (?, ?, 1)",
      alices.id,
      DAVE,
    );
    const body = await ldSigned(deletion(w.bob, o.uri), w.bob);
    expect(await w.post(w.bob, body)).toBe(202);
    expect(proofRounds(w)).toBe(0);
    expect(answers(w).at(-1)).toMatchObject({ applied: true, reason: "status-deleted" });
    expect(await forwards(w.t.store, o.uri)).toEqual([]);
    // The control: dave's public boost of another original forwards, alice's limited one beside it does not.
    const other = await original(w);
    const limited = await boost(w, other.id);
    await sql(w.t.store, "UPDATE statuses SET visibility = 'limited' WHERE id = ?", limited.id);
    const daves = await boost(w, other.id, "dave");
    expect(await w.post(w.bob, await ldSigned(deletion(w.bob, other.uri), w.bob))).toBe(202);
    expect(proofRounds(w)).toBe(1);
    const recorded = await forwards(w.t.store, other.uri);
    expect(
      recorded.map((f) => [f.account_id, (JSON.parse(f.body) as { audience: { shares: string[] } }).audience.shares]),
    ).toEqual([[DAVE, [daves.id]]]);
    await jobs(w.t.store);
    const sent = (await deliver(w)).filter((d) => d.json.type === "Delete");
    expect(sent.filter((d) => d.signer === ALICE_URI)).toEqual([]);
    expect(sent.map((d) => d.inbox)).not.toContain(`${FANS}/inbox`);
  });

  it.each([
    ["one valid id padded past its bytes", "oversized"],
    ["17 distinct ids within its bytes", "seventeen"],
    ["a duplicated id", "duplicate"],
    ["an id that is not a TEXT integer", "number"],
  ] as const)(
    "stages nothing from an imported bound with %s, logged, and the boosts are still withdrawn",
    async (_n, kind) => {
      const w = await world();
      const { o, b } = await boosted(w);
      expect(await w.post(w.bob, await ldSigned(deletion(w.bob, o.uri), w.bob))).toBe(202);
      const [forward] = await forwards(w.t.store, o.uri);
      const bound = JSON.stringify(
        kind === "oversized"
          ? { forwards: [forward!.id], _pad: "x".repeat(512) }
          : kind === "seventeen"
            ? {
                forwards: [
                  forward!.id,
                  ...Array.from({ length: 16 }, (_, i) => String(9_000_000_000_000_000_000n + BigInt(i))),
                ],
              }
            : kind === "duplicate"
              ? { forwards: [forward!.id, forward!.id] }
              : { forwards: [Number(forward!.id)] },
      );
      expect(new TextEncoder().encode(bound).byteLength <= 512).toBe(kind !== "oversized");
      await sql(w.t.store, "UPDATE inbound_jobs SET bound = ? WHERE kind = 'delete' AND key = ?", bound, o.id);
      const warn = vi.spyOn(console, "warn");
      try {
        await batches(w.t.store, o.id);
        const logged = warn.mock.calls.filter(
          ([e]) => (e as { event?: string }).event === "kopje.inbox.forward_bound_invalid",
        );
        expect(logged.length).toBeGreaterThan(0);
        expect(logged[0]).toEqual([
          {
            event: "kopje.inbox.forward_bound_invalid",
            bytes: new TextEncoder().encode(bound).byteLength,
          },
        ]);
      } finally {
        warn.mockRestore();
      }
      expect(
        await sql(
          w.t.store,
          "SELECT count(*) AS n FROM outbound_targets WHERE activity_id = CAST(? AS INTEGER)",
          forward!.id,
        ),
      ).toEqual([{ n: 0 }]);
      expect(await forwards(w.t.store, o.uri)).toMatchObject([{ id: forward!.id, staged: "" }]);
      // The boost's Undo was recorded and staged, and the job ended.
      expect(await sql(w.t.store, "SELECT id FROM statuses WHERE id IN (?, ?)", o.id, b.id)).toEqual([]);
      expect((await retractionInboxes(w.t.store, b.uri, "Undo")).size).toBeGreaterThan(0);
    },
    120_000,
  );
});

describe("the oldest retraction still staging (RES-7)", () => {
  it("is the lowest INTEGER id of the pair, not the lowest TEXT spelling", async () => {
    const t = await setup();
    await sql(
      t.store,
      `INSERT INTO outbound_activities (id, account_id, body, object_uri, retracts, staged, created_at)
			VALUES (10, ?1, '{"activity":{"type":"Delete"},"audience":{"followers":false,"accounts":[]}}', 'https://x.example/o', 1, '', 0),
				(9, ?1, '{"activity":{"type":"Delete"},"audience":{"followers":false,"accounts":[]}}', 'https://x.example/o', 1, '', 0)`,
      ALICE,
    );
    const oldest = await runInDurableObject(t.store, (_instance, state) =>
      stagingRetraction(new Db(state.storage.sql), ALICE, "https://x.example/o"),
    );
    expect(oldest).toBe("9");
    // stageRetraction takes the same one: it stages 9 (no targets, so it is released and dropped) and leaves 10.
    await writtenBy(t.store, (db) => stageRetraction(db, ALICE, "https://x.example/o", PURGE_BATCH));
    expect(
      await sql(
        t.store,
        "SELECT CAST(id AS TEXT) AS id FROM outbound_activities WHERE object_uri = 'https://x.example/o'",
      ),
    ).toEqual([{ id: "10" }]);
  });
});

describe("forwards in a restored store whose intent keys are not positive", () => {
  // A restore whose outbound_activities' largest key is -10 or -1: SQLite gives the forward -9 or 0, which its job's
  // bound names and its staging takes.
  it.each([
    ["-10", "-9"],
    ["-1", "0"],
  ] as const)("the largest key %s: the forward is %s, staged and POSTed", async (largest, expected) => {
    const w = await world();
    const { o } = await boosted(w);
    await sql(w.t.store, "DELETE FROM outbound_activities");
    await sql(
      w.t.store,
      `INSERT INTO outbound_activities (id, account_id, body, object_uri, created_at)
			VALUES (CAST(? AS INTEGER), ?, '{"activity":{},"audience":{"followers":false,"accounts":[]}}', 'restored', 0)`,
      largest,
      DAVE,
    );
    expect(await w.post(w.bob, await ldSigned(deletion(w.bob, o.uri), w.bob))).toBe(202);
    const [forward] = await forwards(w.t.store, o.uri);
    expect(forward).toMatchObject({ id: expected, account_id: ALICE });
    expect(JSON.parse((await jobBound(w.t.store, o.id))!)).toEqual({ forwards: [expected] });
    await jobs(w.t.store);
    const sent = (await deliver(w)).filter((d) => d.json.type === "Delete" && objectOf(d.json) === o.uri);
    expect(sent.map((d) => d.inbox).toSorted()).toEqual([`${FANS}/inbox`, `${MASTODON}/inbox`, RECEIPTS]);
  });
});

describe("the forwards’ staging is the job’s progress", () => {
  // An imported forward whose shares name the same boost STAGING_READ times: each share is resolved as the staging
  // reaches it, so no batch spends its reads on shares alone, and every round advances the job.
  it("advances a forward whose every share resolves, round by round, to its end", async () => {
    const w = await world();
    const { o, b } = await boosted(w);
    expect(await w.post(w.bob, await ldSigned(deletion(w.bob, o.uri), w.bob))).toBe(202);
    const [forward] = await forwards(w.t.store, o.uri);
    await sql(
      w.t.store,
      "UPDATE outbound_activities SET body = json_set(body, '$.audience.shares', json(?)) WHERE id = CAST(? AS INTEGER)",
      JSON.stringify(Array.from({ length: STAGING_READ }, () => b.id)),
      forward!.id,
    );
    for (let round = 0; ; round++) {
      expect(round).toBeLessThan(60);
      await w.t.store.runInboundJobs(BUILD, { now: NOW + round * 60 * 60_000 });
      expect(
        await sql(w.t.store, "SELECT attempts FROM inbound_jobs WHERE kind = 'delete' AND key = ?", o.id),
        `round ${round}`,
      ).toEqual([{ attempts: 0 }]);
      const [row] = await sql<{ staged: string | null }>(
        w.t.store,
        "SELECT staged FROM outbound_activities WHERE id = CAST(? AS INTEGER)",
        forward!.id,
      );
      if (row === undefined || row.staged === null) {
        break;
      }
    }
    const inboxes = new Set(await forwardInboxes(w.t.store, o.uri));
    expect([`${FANS}/inbox`, `${MASTODON}/inbox`, RECEIPTS].filter((inbox) => !inboxes.has(inbox))).toEqual([]);
  }, 300_000);

  // alice's boost has more receipt-only inboxes than a round's batches stage (STAGING_READ each at most), so the delete
  // job's batches can do nothing but stage the forward: they advance the job, which keeps no attempt.
  it("keeps a job whose only progress is the forwards’ staging fresh and pending", async () => {
    const w = await world();
    const { o, b } = await boosted(w);
    await seedReceipts(w.t.store, b.id, ALICE, (JOB_BATCHES_PER_RUN + 1) * STAGING_READ);
    expect(await w.post(w.bob, await ldSigned(deletion(w.bob, o.uri), w.bob))).toBe(202);
    const [forward] = await forwards(w.t.store, o.uri);
    const staged = async () =>
      (
        await sql<{ n: number }>(
          w.t.store,
          `SELECT (SELECT count(*) FROM outbound_targets WHERE activity_id = CAST(?1 AS INTEGER))
						+ (SELECT count(*) FROM outbound_activities o JOIN retraction_reach r ON r.staging_id = CAST(o.staged AS INTEGER)
							WHERE o.id = CAST(?1 AS INTEGER)) AS n`,
          forward!.id,
        )
      )[0]!.n;
    expect(await staged()).toBe(0);
    const round = await w.t.store.runInboundJobs(BUILD, { now: NOW });
    expect(round).toMatchObject({ pending: true });
    // Its batches staged the forward past a batch's worth, and the boost is still there (not yet withdrawn).
    expect(await staged()).toBeGreaterThan(STAGING_READ);
    expect(await sql(w.t.store, "SELECT withdrawn FROM statuses WHERE id = ?", b.id)).toEqual([{ withdrawn: 0 }]);
    expect(
      await sql(
        w.t.store,
        "SELECT attempts, due_at, done_at FROM inbound_jobs WHERE kind = 'delete' AND key = ?",
        o.id,
      ),
    ).toEqual([{ attempts: 0, due_at: null, done_at: null }]);
  }, 120_000);
});

// ---- Forwards through local quotes (#1255): a quoting status in shares when its visibility reaches its author's
// followers, in receiptShares (its receivers alone) when it is direct or limited.

let quoteSeq = 0;

// A local status of `owner` (alice unless named) quoting `o`, as a Store holds one (local = 1), in `state`, with a
// receipt at each of `receipts`; withdrawn when `withdrawn` is 1. Its id is `id`, else the next of 47….
async function localQuote(
  w: World,
  o: { id: string; uri: string },
  options: {
    owner?: string;
    visibility?: "public" | "unlisted" | "private" | "direct" | "limited";
    state?: "pending" | "accepted" | "rejected" | "revoked" | "deleted";
    receipts?: string[];
    withdrawn?: 0 | 1;
    id?: string;
  } = {},
): Promise<{ id: string; uri: string }> {
  const id = options.id ?? `47${String(++quoteSeq).padStart(16, "0")}`;
  const owner = options.owner ?? ALICE;
  const uri = `https://kopje.test/ap/o/${id}`;
  await sql(
    w.t.store,
    `INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, withdrawn)
			VALUES (?, ?, ?, ?, '<p>q</p>', '2026-10-11T12:00:00.000Z', ?)`,
    id,
    uri,
    owner,
    options.visibility ?? "public",
    options.withdrawn ?? 0,
  );
  await sql(
    w.t.store,
    `INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, local, updated_at)
			SELECT ?1, s.uri, s.id, s.account_id, ?2, 1, '2026-10-11T12:00:00.000Z' FROM statuses s WHERE s.id = ?3`,
    id,
    options.state ?? "pending",
    o.id,
  );
  for (const inbox of options.receipts ?? []) {
    await sql(
      w.t.store,
      "INSERT INTO outbound_receipts (status_id, inbox_url, account_id, delivered_at) VALUES (?, ?, ?, 0)",
      id,
      inbox,
      owner,
    );
  }
  return { id, uri };
}

// The targets the unstaged reader (audienceTargets) gives the forward `f` as recorded, by inbox.
async function unstagedInboxes(store: StoreStub, f: Forward): Promise<string[]> {
  const envelope = JSON.parse(f.body) as DeliveryEnvelope;
  return runInDurableObject(store, (_instance, state) =>
    audienceTargets(new Db(state.storage.sql), f.account_id, envelope.activity, envelope.audience)
      .map((t) => t.inbox)
      .toSorted(),
  );
}

const QP = "https://quote-public.example/inbox";
const QD = "https://quote-direct.example/inbox";
const SHARED = "https://shared.example/inbox";

describe("the forward through local quotes (P1–P4)", () => {
  it("forwards through a local quote in every state, POSTed as received", async () => {
    const w = await world();
    const o = await original(w);
    const states = ["pending", "accepted", "rejected", "revoked", "deleted"] as const;
    const quotes = [];
    for (const [i, state] of states.entries()) {
      quotes.push(await localQuote(w, o, { state, receipts: [`https://state${i}.example/inbox`] }));
    }
    const body = await ldSigned(deletion(w.bob, o.uri), w.bob);
    expect(await w.post(w.bob, body)).toBe(202);
    expect(proofRounds(w)).toBe(1);
    const [forward, ...others] = await forwards(w.t.store, o.uri);
    expect(others).toEqual([]);
    expect(forward).toMatchObject({ account_id: ALICE, staged: "" });
    expect(JSON.parse(forward!.body)).toEqual({
      activity: body,
      audience: { followers: false, accounts: [], shares: quotes.map((q) => q.id) },
      immutable: true,
    });
    await jobs(w.t.store);
    const sent = (await deliver(w)).filter((s) => s.json.type === "Delete" && objectOf(s.json) === o.uri);
    expect(sent.map((s) => s.inbox).toSorted()).toEqual(
      [`${FANS}/inbox`, ...states.map((_s, i) => `https://state${i}.example/inbox`)].toSorted(),
    );
    for (const s of sent) {
      expect(s.body).toBe(JSON.stringify(body));
      expect(s.signer).toBe(ALICE_URI);
    }
  });

  it("stages each reference's receivers and the followers of a follower-reaching one, as the unstaged reader does", async () => {
    const w = await world();
    const { o, b } = await boosted(w);
    const qp = await localQuote(w, o, { visibility: "private", receipts: [QP, SHARED] });
    const qd = await localQuote(w, o, { visibility: "direct", receipts: [QD, SHARED] });
    expect(await w.post(w.bob, await ldSigned(deletion(w.bob, o.uri), w.bob))).toBe(202);
    const [forward] = await forwards(w.t.store, o.uri);
    expect(JSON.parse(forward!.body)).toMatchObject({
      audience: { shares: [b.id, qp.id], receiptShares: [qd.id] },
    });
    const expected = [`${FANS}/inbox`, `${MASTODON}/inbox`, RECEIPTS, QP, QD, SHARED].toSorted();
    expect(await unstagedInboxes(w.t.store, forward!)).toEqual(expected);
    await jobs(w.t.store);
    expect([...(await forwardInboxes(w.t.store, o.uri))].toSorted()).toEqual(expected);
  });

  // The guarded branch runs: the direct quote resolves (its receipt is reached), and still no follower inbox is.
  it("a direct quote's forward reaches its receipts and no follower inbox", async () => {
    const w = await world();
    const o = await original(w);
    const qd = await localQuote(w, o, { visibility: "direct", receipts: [QD] });
    const limited = await localQuote(w, o, { visibility: "limited", receipts: [SHARED] });
    expect(await w.post(w.bob, await ldSigned(deletion(w.bob, o.uri), w.bob))).toBe(202);
    const [forward] = await forwards(w.t.store, o.uri);
    expect(JSON.parse(forward!.body)).toMatchObject({ audience: { shares: [], receiptShares: [qd.id, limited.id] } });
    expect(await unstagedInboxes(w.t.store, forward!)).toEqual([QD, SHARED].toSorted());
    await jobs(w.t.store);
    const sent = (await deliver(w)).filter((s) => s.json.type === "Delete" && objectOf(s.json) === o.uri);
    expect(sent.map((s) => s.inbox).toSorted()).toEqual([QD, SHARED].toSorted());
    expect(sent.map((s) => s.inbox)).not.toContain(`${FANS}/inbox`);
  });

  it("skips a withdrawn quoting status without counting it, before and after the proof round", async () => {
    const w = await world();
    const o = await original(w);
    // 65 withdrawn quotes first by status id (MAX_FORWARD_QUOTES + 1), then the live one.
    for (let i = 0; i <= MAX_FORWARD_QUOTES; i++) {
      await localQuote(w, o, { withdrawn: 1, receipts: [`https://gone${i}.example/inbox`] });
    }
    const live = await localQuote(w, o, { receipts: [QP] });
    const rows = () =>
      sql(w.t.store, "SELECT count(*) AS n FROM quotes WHERE quoted_status_id = ? AND local = 1", o.id);
    expect(await rows()).toEqual([{ n: MAX_FORWARD_QUOTES + 2 }]);
    const warn = vi.spyOn(console, "warn");
    try {
      expect(await w.post(w.bob, await ldSigned(deletion(w.bob, o.uri), w.bob))).toBe(202);
      // The proof round ran (forwardable found the live one), and the record took it alone, logging no cap.
      expect(proofRounds(w)).toBe(1);
      expect(await rows()).toEqual([{ n: MAX_FORWARD_QUOTES + 2 }]);
      expect(warn.mock.calls.filter(([e]) => (e as { event?: string }).event === "kopje.inbox.forward_capped")).toEqual(
        [],
      );
    } finally {
      warn.mockRestore();
    }
    const [forward] = await forwards(w.t.store, o.uri);
    expect(JSON.parse(forward!.body)).toMatchObject({ audience: { shares: [live.id] } });
    await jobs(w.t.store);
    const inboxes = await forwardInboxes(w.t.store, o.uri);
    expect([...inboxes].toSorted()).toEqual([`${FANS}/inbox`, QP].toSorted());
  });

  it("records one intent for an owner's boost and three quotes, one row per inbox", async () => {
    const w = await world();
    const { o, b } = await boosted(w);
    const q1 = await localQuote(w, o, { visibility: "public", receipts: [SHARED, QP] });
    const q2 = await localQuote(w, o, { visibility: "unlisted", receipts: [SHARED, RECEIPTS] });
    const q3 = await localQuote(w, o, { visibility: "direct", receipts: [SHARED, `${FANS}/inbox`] });
    expect(await w.post(w.bob, await ldSigned(deletion(w.bob, o.uri), w.bob))).toBe(202);
    const recorded = await forwards(w.t.store, o.uri);
    expect(recorded).toHaveLength(1);
    expect(JSON.parse(recorded[0]!.body)).toMatchObject({
      audience: { shares: [b.id, q1.id, q2.id], receiptShares: [q3.id] },
    });
    await jobs(w.t.store);
    const rows = await sql<{ inbox: string }>(
      w.t.store,
      "SELECT inbox_url AS inbox FROM deliveries WHERE activity_id = CAST(? AS INTEGER)",
      recorded[0]!.id,
    );
    await runInDurableObject(w.t.store, (_instance, state) => {
      state.storage.transactionSync(() => expandPending(new Db(state.storage.sql), NOW, Number.MAX_SAFE_INTEGER));
    });
    const all = (
      await sql<{ inbox: string }>(
        w.t.store,
        "SELECT inbox_url AS inbox FROM deliveries WHERE activity_id = CAST(? AS INTEGER)",
        recorded[0]!.id,
      )
    ).map((r) => r.inbox);
    expect(rows.length).toBeLessThanOrEqual(all.length);
    expect(all.toSorted()).toEqual([`${FANS}/inbox`, `${MASTODON}/inbox`, RECEIPTS, QP, SHARED].toSorted());
  });

  it("keeps the ids as TEXT from the envelope through both readers (DATA-6)", async () => {
    const w = await world();
    const o = await original(w);
    const low = await localQuote(w, o, { id: "100000000000000000", receipts: [QP] });
    const high = await localQuote(w, o, { id: "999999999999999999", visibility: "direct", receipts: [QD] });
    expect(await w.post(w.bob, await ldSigned(deletion(w.bob, o.uri), w.bob))).toBe(202);
    const [forward] = await forwards(w.t.store, o.uri);
    const audience = (JSON.parse(forward!.body) as DeliveryEnvelope).audience;
    expect(audience).toMatchObject({ shares: [low.id], receiptShares: [high.id] });
    expect([typeof audience.shares![0], typeof audience.receiptShares![0]]).toEqual(["string", "string"]);
    expect(await unstagedInboxes(w.t.store, forward!)).toEqual([`${FANS}/inbox`, QD, QP].toSorted());
    await jobs(w.t.store);
    expect([...(await forwardInboxes(w.t.store, o.uri))].toSorted()).toEqual([`${FANS}/inbox`, QD, QP].toSorted());
  });

  it("sends a forward through a quote to an instance-suspended follower as a retraction (VIS-30)", async () => {
    const w = await world();
    await followersOn(w.t.store, "suspended.example", "86", 1);
    await sql(
      w.t.store,
      `INSERT INTO instance_domain_blocks (domain, severity, created_at, updated_at)
				VALUES ('suspended.example', 'suspend', '2026-10-11T12:00:00.000Z', '2026-10-11T12:00:00.000Z')`,
    );
    const o = await original(w);
    await localQuote(w, o, { receipts: [QP] });
    expect(await w.post(w.bob, await ldSigned(deletion(w.bob, o.uri), w.bob))).toBe(202);
    await jobs(w.t.store);
    const sent = (await deliver(w)).filter((s) => s.json.type === "Delete" && objectOf(s.json) === o.uri);
    expect(sent.map((s) => s.inbox)).toContain("https://suspended.example/inbox");
  });
});

describe("a direct quote's forward reaches only the inboxes that received the quote", () => {
  // Its Create's rows and targets, in any state, are no receipt: one gave up before any POST (a DNS failure), one is
  // in flight (leased), one is not expanded yet. Only the receipt's inbox is reached, by both readers.
  it("sends nothing to an inbox of a Create that gave up, is in flight or is unexpanded", async () => {
    const w = await world();
    const o = await original(w);
    const qd = await localQuote(w, o, { visibility: "direct", receipts: [QD] });
    const [create] = await sql<{ id: string }>(
      w.t.store,
      `INSERT INTO outbound_activities (account_id, body, object_uri, retracts, created_at)
				VALUES (?, '{"activity":{"type":"Create"},"audience":{"followers":false,"accounts":[]}}', ?, 0, 0)
				RETURNING CAST(id AS TEXT) AS id`,
      ALICE,
      qd.uri,
    );
    for (const [inbox, state] of [
      ["https://never.example/inbox", "gave_up"],
      ["https://inflight.example/inbox", "leased"],
    ] as const) {
      await sql(
        w.t.store,
        `INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, state, next_attempt_at, updated_at, lease_token,
					exposed, last_error)
				VALUES (CAST(? AS INTEGER), ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        create!.id,
        ALICE,
        inbox,
        new URL(inbox).origin,
        state,
        state === "leased" ? NOW + 3_600_000 : 0,
        state === "leased" ? "held" : null,
        state === "leased" ? 1 : 0,
        state === "gave_up" ? "DNS lookup failed" : null,
      );
    }
    await sql(
      w.t.store,
      `INSERT INTO outbound_targets (activity_id, targets, next)
				VALUES (CAST(? AS INTEGER), '[{"inbox":"https://unexpanded.example/inbox","addressee":null}]', 0)`,
      create!.id,
    );
    expect(await w.post(w.bob, await ldSigned(deletion(w.bob, o.uri), w.bob))).toBe(202);
    const [forward] = await forwards(w.t.store, o.uri);
    expect(JSON.parse(forward!.body)).toMatchObject({ audience: { shares: [], receiptShares: [qd.id] } });
    expect(await unstagedInboxes(w.t.store, forward!)).toEqual([QD]);
    await jobs(w.t.store);
    expect([...(await forwardInboxes(w.t.store, o.uri))]).toEqual([QD]);
    const sent = (await deliver(w)).filter((s) => s.json.type === "Delete" && objectOf(s.json) === o.uri);
    expect(sent.map((s) => s.inbox)).toEqual([QD]);
  });
});

describe("the owners' places (P7)", () => {
  // 16 local boosters (MAX_FORWARD_OWNERS) and a quote-only owner whose account id is lower than every booster's.
  it("gives every booster its forward before any quote-only owner, and logs the owners' cap", async () => {
    const w = await world();
    const o = await original(w);
    const boosters = await localBoosters(w, o.id, MAX_FORWARD_OWNERS);
    const quoter = "300000000000000001";
    await seedLocalAccount(w.t.store, "kopje.test", { id: quoter, username: "lowquoter", key: LEGACY_EMPTY_KEK });
    await localQuote(w, o, { owner: quoter, visibility: "direct" });
    const warn = vi.spyOn(console, "warn");
    try {
      expect(await w.post(w.bob, await ldSigned(deletion(w.bob, o.uri), w.bob))).toBe(202);
      expect(warn.mock.calls.filter(([e]) => (e as { event?: string }).event === "kopje.inbox.forward_capped")).toEqual(
        [[{ event: "kopje.inbox.forward_capped", owners: MAX_FORWARD_OWNERS }]],
      );
    } finally {
      warn.mockRestore();
    }
    expect((await forwards(w.t.store, o.uri)).map((f) => f.account_id).toSorted()).toEqual(boosters);
  }, 120_000);
});

describe("the hide of an older build's job within its batch (RES-6)", () => {
  // The batch's mentions leave three rows of PURGE_BATCH; the hide needs four, the status's own quote row being marked
  // local (an import's), which its trigger copies withdrawn onto, with a card and the account's last status.
  it("waits for the next batch rather than writing past PURGE_BATCH", async () => {
    const w = await world();
    const o = await original(w);
    const mentioned = await remoteAccountsAt(w.t.store, "6", "m", PURGE_BATCH - 3);
    await sql(
      w.t.store,
      "INSERT INTO status_mentions (status_id, account_id) SELECT ?, value FROM json_each(?)",
      o.id,
      JSON.stringify(mentioned),
    );
    await sql(
      w.t.store,
      "INSERT INTO status_cards (status_id, url, due_at, enqueued_at, generation) VALUES (?, 'https://site.example/card', 0, 0, 1)",
      o.id,
    );
    await sql(
      w.t.store,
      `INSERT INTO quotes (status_id, quoted_uri, state, local, updated_at)
				VALUES (?, 'https://elsewhere.example/s/1', 'pending', 1, '2026-10-11T12:00:00.000Z')`,
      o.id,
    );
    await sql(
      w.t.store,
      "INSERT INTO inbound_jobs (kind, key, actor_uri, created_at) VALUES ('delete', ?, ?, 0)",
      o.id,
      w.bob.uri,
    );
    const first = await batch(w.t.store, o.id);
    expect(first).toMatchObject({ more: true });
    expect(first.wrote).toBeLessThanOrEqual(PURGE_BATCH);
    // Every batch within PURGE_BATCH (batches checks each); the status hidden and then gone.
    await batches(w.t.store, o.id);
    expect(await sql(w.t.store, "SELECT id FROM statuses WHERE id = ?", o.id)).toEqual([]);
  });
});

describe("a boost's withdrawal within its batch (RES-6)", () => {
  // alice's boost holds a quote row an import marked local, so its marker's write copies withdrawn onto it: the marker,
  // the copy and the cursor follow the Undo's rows. The original's mentions leave the withdrawal exactly the Undo's
  // rows (its superseded intents, two each, and itself) and two more, one too few for those three.
  it("records the Undo only with room for the marker, its quote row's copy and the cursor", async () => {
    const w = await world();
    const o = await original(w);
    const b = await boost(w, o.id);
    // Its Announce delivered and settled, so each intent the Undo supersedes is one without rows: updated and dropped,
    // the two rows beginRetraction counts for it.
    await deliver(w);
    await sql(
      w.t.store,
      `INSERT INTO quotes (status_id, quoted_uri, state, local, updated_at)
				VALUES (?, 'https://elsewhere.example/s/1', 'pending', 1, '2026-10-11T12:00:00.000Z')`,
      b.id,
    );
    await sql(
      w.t.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10)
				INSERT INTO outbound_activities (account_id, body, object_uri, created_at)
				SELECT ?, json_object('activity', json_object('type', 'Update', 'id', 'u' || i), 'audience',
					json_object('followers', json('true'), 'accounts', json('[]'))), ?, 0 FROM n`,
      ALICE,
      b.uri,
    );
    const [{ n }] = (await sql<{ n: number }>(
      w.t.store,
      "SELECT count(*) AS n FROM outbound_activities WHERE account_id = ? AND object_uri = ? AND superseded = 0",
      ALICE,
      b.uri,
    )) as [{ n: number }];
    const undoRows = 2 * n + 1;
    // An older build's job, its status hidden already (so the batch's hide writes nothing), and its mentions.
    await sql(
      w.t.store,
      "UPDATE statuses SET withdrawn = 1, visibility = 'direct', content = '', spoiler_text = '', search_text = NULL WHERE id = ?",
      o.id,
    );
    await sql(
      w.t.store,
      "INSERT INTO inbound_jobs (kind, key, actor_uri, created_at) VALUES ('delete', ?, ?, 0)",
      o.id,
      w.bob.uri,
    );
    const mentioned = await remoteAccountsAt(w.t.store, "6", "m", PURGE_BATCH - (undoRows + 2));
    await sql(
      w.t.store,
      "INSERT INTO status_mentions (status_id, account_id) SELECT ?, value FROM json_each(?)",
      o.id,
      JSON.stringify(mentioned),
    );
    const first = await batch(w.t.store, o.id);
    expect(first.wrote).toBeLessThanOrEqual(PURGE_BATCH);
    console.info({ event: "forward.boost-withdrawal", wrote: first.wrote, n });
    // The withdrawal waited: no Undo yet; the next batch records it, the copy written with its marker.
    expect(await sql(w.t.store, "SELECT withdrawn FROM statuses WHERE id = ?", b.id)).toEqual([{ withdrawn: 0 }]);
    const second = await batch(w.t.store, o.id);
    expect(second.wrote).toBeLessThanOrEqual(PURGE_BATCH);
    expect(
      await sql(
        w.t.store,
        "SELECT 1 AS x FROM outbound_activities WHERE object_uri = ? AND json_extract(body, '$.activity.type') = 'Undo'",
        b.uri,
      ),
    ).toEqual([{ x: 1 }]);
    await batches(w.t.store, o.id);
  });
});

describe("the quotes' forward and the proof (P5)", () => {
  it("asks for the proof once for a quote-only original, records once, and nothing more when delivered again", async () => {
    const w = await world();
    const o = await original(w);
    await localQuote(w, o, { receipts: [QP] });
    const body = await ldSigned(deletion(w.bob, o.uri), w.bob);
    expect(await w.post(w.bob, body)).toBe(202);
    expect(proofRounds(w)).toBe(1);
    expect(await forwards(w.t.store, o.uri)).toHaveLength(1);
    expect(await w.post(w.bob, body)).toBe(202);
    expect(proofRounds(w)).toBe(1);
    expect(await forwards(w.t.store, o.uri)).toHaveLength(1);
    await jobs(w.t.store);
    expect(await w.post(w.bob, body)).toBe(202);
    expect(await forwards(w.t.store, o.uri)).toHaveLength(1);
  });

  it("forwards nothing through a quote when the proof is invalid, or when the Delete is unsigned", async () => {
    const w = await world();
    const o = await original(w);
    await localQuote(w, o, { receipts: [QP] });
    const body = await ldSigned(deletion(w.bob, o.uri), w.bob);
    const unsigned: Record<string, unknown> = { ...body };
    delete unsigned.signature;
    expect(await w.post(w.bob, unsigned)).toBe(202);
    expect(proofRounds(w)).toBe(0);
    expect(await forwards(w.t.store, o.uri)).toEqual([]);
    const other = await original(w);
    await localQuote(w, other, { receipts: [QP] });
    // bob's key id, carol's key: the proof round runs and refuses it.
    const forged = await ldSigned(deletion(w.bob, other.uri), { ...w.bob, privateKey: w.carol.privateKey });
    expect(await w.post(w.bob, forged)).toBe(202);
    expect(proofRounds(w)).toBe(1);
    expect(await forwards(w.t.store, other.uri)).toEqual([]);
  });

  it("reads both windows again at the record: a quote committed and one withdrawn during the proof await", async () => {
    const w = await world();
    const o = await original(w);
    const gone = await localQuote(w, o, { receipts: [QD] });
    const body = await ldSigned(deletion(w.bob, o.uri), w.bob);
    const held = w.t.web.hold(w.bob.uri);
    const request = w.post(w.bob, body);
    await held.reached;
    // While the request waits at its proof: alice deletes one quote and posts another (as a Store holds it).
    expect(
      (await w.t.request(`/api/v1/statuses/${gone.id}`, bearer(w.t.tokens.alice, { method: "DELETE" }))).status,
    ).toBe(200);
    const added = await localQuote(w, o, { receipts: [QP] });
    held.release();
    expect(await request).toBe(202);
    const [forward] = await forwards(w.t.store, o.uri);
    // The withdrawn one is in neither list.
    expect((JSON.parse(forward!.body) as DeliveryEnvelope).audience).toEqual({
      followers: false,
      accounts: [],
      shares: [added.id],
    });
  });
});

describe("the barriers before a quote's evidence goes (P6)", () => {
  // Barrier 1. The quote's receipts span more than a batch's staging (STAGING_READ a batch).
  it("a quote-only forward is staged by the job, which stops at it while it stages", async () => {
    const w = await world();
    const o = await original(w);
    const q = await localQuote(w, o);
    await seedReceipts(w.t.store, q.id, ALICE, 2 * STAGING_READ);
    expect(await w.post(w.bob, await ldSigned(deletion(w.bob, o.uri), w.bob))).toBe(202);
    let stopped = 0;
    await batches(w.t.store, o.id, async (n) => {
      const [now] = await forwards(w.t.store, o.uri);
      if (now !== undefined && now.staged !== null) {
        // The barrier stopped the batch: the original and its quote's link stay.
        expect(await sql(w.t.store, "SELECT id FROM statuses WHERE id = ?", o.id), `batch ${n}`).toHaveLength(1);
        expect(await sql(w.t.store, "SELECT quoted_status_id AS id FROM quotes WHERE status_id = ?", q.id)).toEqual([
          { id: o.id },
        ]);
        stopped++;
      }
    });
    expect(stopped).toBeGreaterThan(0);
    expect(await forwards(w.t.store, o.uri)).toMatchObject([{ staged: null }]);
    expect((await forwardInboxes(w.t.store, o.uri)).size).toBe(2 * STAGING_READ + 1);
  }, 120_000);

  // Barrier 2: the author's purge, its batches alone (the original's own job never runs here).
  it("the purge stages quote-only forwards before deleting the status", async () => {
    const w = await world();
    const o = await original(w);
    const q = await localQuote(w, o);
    await seedReceipts(w.t.store, q.id, ALICE, 2 * STAGING_READ);
    expect(await w.post(w.bob, await ldSigned(deletion(w.bob, o.uri), w.bob))).toBe(202);
    expect(await storeReceive(w.t.store, w.bob.uri, { type: "DeleteActor", id: `${w.bob.uri}#delete` })).toMatchObject({
      applied: true,
    });
    let stopped = 0;
    for (let n = 1; ; n++) {
      expect(n).toBeLessThan(100);
      const [now] = await forwards(w.t.store, o.uri);
      const left = await sql(w.t.store, "SELECT id FROM statuses WHERE id = ?", o.id);
      if (left.length === 0) {
        expect(now?.staged ?? null, `batch ${n}`).toBeNull();
      } else if (now !== undefined && now.staged !== null) {
        stopped++;
      }
      const { result, rows } = await writtenBy(w.t.store, (db) => purgeBatch(db, w.bob.uri, NOW));
      expect(rows).toBeLessThanOrEqual(PURGE_BATCH);
      if (!result) {
        break;
      }
    }
    expect(stopped).toBeGreaterThan(0);
    expect(await sql(w.t.store, "SELECT id FROM statuses WHERE id = ?", o.id)).toEqual([]);
    expect(await forwards(w.t.store, o.uri)).toMatchObject([{ staged: null }]);
    expect((await forwardInboxes(w.t.store, o.uri)).size).toBe(2 * STAGING_READ + 1);
  }, 120_000);

  // Barrier 3. alice's boost of O comes first among the forward's shares, with receipts past a batch's staging, so
  // the forward cannot finish staging before the quoting status's Create completes; that Create's row to bob's
  // personal inbox (a personal copy, the quoted author's) is the inbox's only evidence.
  it("stages the forward before the quoting status's own Delete stages, so a Create completed later is reached", async () => {
    const w = await world();
    const theirs = mastodonNote(w.bob, { interactionPolicy: { canQuote: { automaticApproval: [PUBLIC] } } });
    expect(await w.post(w.bob, create(w.bob, theirs))).toBe(202);
    w.t.web.serve(theirs.id, { "@context": AS, ...theirs });
    const o = { uri: theirs.id, id: await statusId(w.t.store, theirs.id) };
    const b = await boost(w, o.id);
    await deliver(w);
    await seedReceipts(w.t.store, b.id, ALICE, 3 * STAGING_READ);
    const posted = await w.t.request(
      "/api/v1/statuses",
      json({ status: "look", quoted_status_id: o.id }, bearer(w.t.tokens.alice)),
    );
    expect(posted.status).toBe(200);
    const quoting = await posted.json<{ id: string; uri: string }>();
    const personal = `${MASTODON}/users/bob/inbox`;
    // The Create's POST to the personal inbox held at its fetch.
    const reached = deferred();
    const release = deferred();
    const gated = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const sent = JSON.parse(await request.text()) as Record<string, unknown>;
      if (request.url === personal && sent.type === "Create") {
        reached.resolve();
        await release.promise;
      }
      return new Response(null, { status: 202 });
    }) as typeof fetch;
    const round = deliveryRound(
      w.t.env,
      deliveryDeps(
        () => w.t.store,
        gated,
        () => NOW,
      ),
    );
    await reached.promise;
    try {
      // The forward is recorded, its staging not begun; then the quoting status is deleted: its Delete stages.
      expect(await w.post(w.bob, await ldSigned(deletion(w.bob, o.uri), w.bob))).toBe(202);
      const [forward] = await forwards(w.t.store, o.uri);
      expect(JSON.parse(forward!.body)).toMatchObject({ audience: { shares: [b.id, quoting.id] } });
      const gone = await w.t.request(`/api/v1/statuses/${quoting.id}`, bearer(w.t.tokens.alice, { method: "DELETE" }));
      expect(gone.status).toBe(200);
      const ownDelete = () =>
        sql<{ staged: string | null }>(
          w.t.store,
          "SELECT staged FROM outbound_activities WHERE object_uri = ? AND retracts = 1",
          quoting.uri,
        );
      expect(await ownDelete()).toEqual([{ staged: expect.any(String) }]);
      // A batch of its job: the forward stages first and stops it, so its own Delete still stages.
      expect((await batch(w.t.store, quoting.id)).more).toBe(true);
      expect(await ownDelete()).toEqual([{ staged: expect.any(String) }]);
      expect(personal).not.toBe(`${MASTODON}/inbox`);
    } finally {
      // The Create's completion, before the next round of the forward's staging.
      release.resolve();
      await round;
    }
    await jobs(w.t.store);
    expect(await forwards(w.t.store, o.uri)).toMatchObject([{ staged: null }]);
    expect(await forwardInboxes(w.t.store, o.uri)).toContain(personal);
  }, 120_000);
});

// The most a forward's envelope adds to its body with quotes (recordForwards): an owner's boost and an empty
// receiptShares, and each of the MAX_FORWARD_QUOTES references, across all intents, as a 19-digit id with its quotes
// and comma.
const QUOTE_ENVELOPE_OVERHEAD =
  utf8(
    JSON.stringify({
      activity: {},
      audience: { followers: false, accounts: [], shares: ["9".repeat(19)], receiptShares: [] },
      immutable: true,
    }),
  ) - 2;
const REFERENCE_BYTES = utf8(`"${"9".repeat(19)}",`);

describe("the first transaction at its bounds with quotes (P7, T9b)", () => {
  // The inputs at their cap together: 17 local boosters (MAX_FORWARD_OWNERS + 1 candidates), each also quoting: 65 live
  // quotes (MAX_FORWARD_QUOTES + 1 raw candidates), the first 64 by the first 16 owners, four each, public and direct
  // in turn (both lists), the 65th by the 17th; a body of exactly FORWARD_BODY_MAX bytes; intent keys of 20 characters
  // (a restored store's, sign and 19 digits), so the job's bound holds MAX_FORWARD_OWNERS ids at their longest
  // (FORWARDS_BOUND_BYTES); and the rest of the first transaction at its most (saturated: the 4 x SWEEP_BATCH sweep,
  // the largest streaming capture, the original's own quote row marked local).
  it("records 16 intents of 64 references within the derived bytes and rows, logging both caps once", async () => {
    const w = await world();
    const o = await original(w);
    const owners = await localBoosters(w, o.id, MAX_FORWARD_OWNERS + 1);
    for (let i = 0; i <= MAX_FORWARD_QUOTES; i++) {
      await localQuote(w, o, {
        owner: owners[Math.floor(i / 4)]!,
        visibility: i % 2 === 0 ? "public" : "direct",
      });
    }
    await saturated(w, o);
    await sql(w.t.store, "DELETE FROM outbound_activities");
    await sql(
      w.t.store,
      `INSERT INTO outbound_activities (id, account_id, body, object_uri, created_at)
				VALUES (-9223372036854775000, ?, '{"activity":{},"audience":{"followers":false,"accounts":[]}}', 'restored', 0)`,
      DAVE,
    );
    const body = paddedTo(await ldSigned(deletion(w.bob, o.uri), w.bob), FORWARD_BODY_MAX);
    const warn = vi.spyOn(console, "warn");
    try {
      const { result, rows } = await provenReceive(w, body, o.uri);
      expect(result).toMatchObject({ applied: true, reason: "status-deleted" });
      expect(warn.mock.calls.filter(([e]) => (e as { event?: string }).event === "kopje.inbox.forward_capped")).toEqual(
        [[{ event: "kopje.inbox.forward_capped", owners: MAX_FORWARD_OWNERS, quotes: MAX_FORWARD_QUOTES }]],
      );
      const recorded = await forwards(w.t.store, o.uri);
      // forwards() orders by the TEXT spelling of the ids, which crosses a power of ten here.
      expect(recorded.map((f) => f.account_id).toSorted()).toEqual(owners.slice(0, MAX_FORWARD_OWNERS));
      const references = recorded.flatMap((f) => {
        const { shares, receiptShares } = (JSON.parse(f.body) as DeliveryEnvelope).audience;
        return [...shares!, ...(receiptShares ?? [])];
      });
      // Each owner's boost and the first 64 quotes.
      expect(references).toHaveLength(MAX_FORWARD_OWNERS + MAX_FORWARD_QUOTES);
      const bound = (await jobBound(w.t.store, o.id))!;
      expect((JSON.parse(bound) as { forwards: string[] }).forwards.every((id) => id.length === 20)).toBe(true);
      const bytes = recorded.reduce((n, f) => n + utf8(f.body), 0) + utf8(bound);
      expect(bytes).toBeLessThanOrEqual(
        MAX_FORWARD_OWNERS * (FORWARD_BODY_MAX + QUOTE_ENVELOPE_OVERHEAD) +
          MAX_FORWARD_QUOTES * REFERENCE_BYTES +
          BOUND_MAX,
      );
      expect(rows).toBe(RECEIVE_SWEEP_ROWS + DELETE_HANDLER_ROWS);
      console.info({ event: "forward.first-transaction.quotes", rows, bytes });
    } finally {
      warn.mockRestore();
    }
  }, 120_000);
});

describe("the quote cap on the raw candidates (P7)", () => {
  // A local quote row of a status no local account holds (an import's) first by id, then MAX_FORWARD_QUOTES live ones:
  // the window's raw candidates pass the cap though only 64 of them resolve to an owner.
  it("logs the cap when the raw candidates pass it, and forwards the resolved ones within it", async () => {
    const w = await world();
    const o = await original(w);
    const stranger = (await remoteAccountsAt(w.t.store, "6", "imported", 1))[0]!;
    await localQuote(w, o, { owner: stranger });
    const live = [];
    for (let i = 0; i < MAX_FORWARD_QUOTES; i++) {
      live.push(await localQuote(w, o));
    }
    const warn = vi.spyOn(console, "warn");
    try {
      expect(await w.post(w.bob, await ldSigned(deletion(w.bob, o.uri), w.bob))).toBe(202);
      expect(warn.mock.calls.filter(([e]) => (e as { event?: string }).event === "kopje.inbox.forward_capped")).toEqual(
        [[{ event: "kopje.inbox.forward_capped", quotes: MAX_FORWARD_QUOTES }]],
      );
    } finally {
      warn.mockRestore();
    }
    const [forward, ...others] = await forwards(w.t.store, o.uri);
    expect(others).toEqual([]);
    expect(JSON.parse(forward!.body)).toMatchObject({
      audience: { shares: live.slice(0, MAX_FORWARD_QUOTES - 1).map((q) => q.id) },
    });
  });
});

describe("the shared-inbox fallback of a quote's forward (P8)", () => {
  it("gives up a receipt-only row, whose recipients are unknown, visibly", async () => {
    const w = await world();
    const o = await original(w);
    const missing = "https://missing.example/inbox";
    await localQuote(w, o, { visibility: "direct", receipts: [missing] });
    expect(await w.post(w.bob, await ldSigned(deletion(w.bob, o.uri), w.bob))).toBe(202);
    const [forward] = await forwards(w.t.store, o.uri);
    await jobs(w.t.store);
    const attempts: string[] = [];
    await deliver(w, (url, sent) => {
      if (sent.type === "Delete") {
        attempts.push(url);
      }
      return url === missing ? 404 : 202;
    });
    // The fallback ran for the row (its answer is one it moves on) and moved nothing.
    expect(attempts).toEqual([missing]);
    expect(
      await sql(
        w.t.store,
        "SELECT inbox_url, state, last_status FROM deliveries WHERE activity_id = CAST(? AS INTEGER)",
        forward!.id,
      ),
    ).toEqual([{ inbox_url: missing, state: "gave_up", last_status: 404 }]);
  });
});

describe("a quote's forward staged anew (RES-6)", () => {
  // 0085_retraction_staging's contract: a staging another value of staged names is begun again, and may emit targets
  // already emitted; receivers deduplicate by activity id.
  it("regenerates its targets when restarted after a partial emit, missing none", async () => {
    const w = await world();
    const o = await original(w);
    const q = await localQuote(w, o, { visibility: "direct" });
    await seedReceipts(w.t.store, q.id, ALICE, 3 * STAGING_READ);
    expect(await w.post(w.bob, await ldSigned(deletion(w.bob, o.uri), w.bob))).toBe(202);
    const [forward] = await forwards(w.t.store, o.uri);
    const subject = forwardSubject(o.uri);
    const chunks = () =>
      sql<{ n: number }>(
        w.t.store,
        "SELECT count(*) AS n FROM outbound_targets WHERE activity_id = CAST(? AS INTEGER)",
        forward!.id,
      );
    // Calls until some targets are written out and more remain.
    for (let call = 0; ; call++) {
      expect(call).toBeLessThan(50);
      const done = await runInDurableObject(w.t.store, (_instance, state) =>
        state.storage.transactionSync(() =>
          stageRetraction(new Db(state.storage.sql), ALICE, subject, PURGE_BATCH, forward!.id),
        ),
      );
      expect(done).toBe(false);
      if ((await chunks())[0]!.n > 0) {
        break;
      }
    }
    await sql(w.t.store, "UPDATE outbound_activities SET staged = 'other' WHERE id = CAST(? AS INTEGER)", forward!.id);
    await jobs(w.t.store);
    const inboxes = await forwardInboxes(w.t.store, o.uri);
    expect(inboxes.size).toBe(3 * STAGING_READ);
    expect(await forwards(w.t.store, o.uri)).toMatchObject([{ staged: null }]);
  }, 120_000);
});
