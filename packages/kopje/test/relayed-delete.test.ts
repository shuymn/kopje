import { signJsonLd } from "@fedify/fedify";
import { describe, expect, it } from "vitest";

import type { StoreStub } from "../src/platform/store-client";
import { bearer, settle, sql } from "./api-helpers";
import { harness, NOW, offline } from "./app-helpers";
import { fixtureKeyGen, LEGACY_EMPTY_KEK, seedLocalAccount, setDomain } from "./federation-helpers";
import { BUILD, claimAndSettle, migratedStore } from "./helpers";
import { mastodonActor, type TestActor } from "./inbox-helpers";
import {
  ALICE,
  ALICE_URI,
  announce,
  AS,
  create,
  followed,
  mastodonNote,
  nextId,
  PUBLIC,
  setup,
  type Setup,
  token,
} from "./inbox-status-helpers";
import { contexts } from "./quote-helpers";

// ID-1, VIS-3: a status's Delete that another server relays (its HTTP signer is not its actor), carrying the author's
// own proof, is applied as the author's Delete of a public or unlisted original whose stored author is the proof's
// author and whose uri has the author's origin (federation/inbound.ts relayed, domain/inbox.ts relayedDelete); any
// other relayed status Delete changes nothing.

const RELAY = "https://relay.example";
const FANS = "https://fans.example";
const SECURITY = "https://w3id.org/security/v1";
const AP = { headers: { accept: "application/activity+json" } };

type Json = Record<string, unknown>;

// alice follows bob and erin (mastodon.example), so their statuses are stored; carol (fans.example) follows alice;
// dan (relay.example) relays.
async function world() {
  const t = await setup();
  const bob = await mastodonActor(t.web, "bob");
  const erin = await mastodonActor(t.web, "erin", { key: 2 });
  await followed(t, bob);
  await followed(t, erin);
  const carol = await mastodonActor(t.web, "carol", { origin: FANS, key: 3 });
  const follow = { "@context": AS, id: `${carol.uri}#follows/${nextId()}`, type: "Follow", actor: carol.uri };
  expect(await t.post(carol, { ...follow, object: ALICE_URI })).toBe(202);
  const dan = await mastodonActor(t.web, "dan", { origin: RELAY, key: 6 });
  return { t, bob, erin, carol, dan };
}

const FOLLOWERS_ONLY = (actor: TestActor) => ({ to: [`${actor.uri}/followers`], cc: [] });
const UNLISTED = (actor: TestActor) => ({ to: [`${actor.uri}/followers`], cc: [PUBLIC] });

// `actor`'s Note (public unless `extra` says otherwise), delivered and stored.
async function note(t: Setup, actor: TestActor, extra: Json = {}): Promise<{ uri: string; id: string }> {
  const n = mastodonNote(actor, extra);
  expect(await t.post(actor, create(actor, n))).toBe(202);
  return { uri: n.id, id: await statusId(t.store, n.id) };
}

async function statusId(store: StoreStub, uri: string): Promise<string> {
  return (await sql<{ id: string }>(store, "SELECT id FROM statuses WHERE uri = ?", uri))[0]!.id;
}

// The stored status of `uri` as a reader sees it: absent, or its visibility and whether its removal has begun.
async function stored(store: StoreStub, uri: string) {
  const [row] = await sql<{ visibility: string; withdrawn: number }>(
    store,
    "SELECT visibility, withdrawn FROM statuses WHERE uri = ?",
    uri,
  );
  return row ?? null;
}

// The Delete of `uri` as Mastodon's ActivityPub::DeleteSerializer writes it (to Public, a Tombstone with atomUri, the
// term defined), unsigned; `object` 'bare' names the status by its uri alone.
function deletion(actor: TestActor, uri: string, object: "tombstone" | "bare" = "tombstone"): Json {
  return {
    "@context": [AS, { ostatus: "http://ostatus.org#", atomUri: "ostatus:atomUri" }, SECURITY],
    id: `${uri}#delete-${nextId()}`,
    type: "Delete",
    actor: actor.uri,
    to: [PUBLIC],
    object: object === "bare" ? uri : { id: uri, type: "Tombstone", atomUri: uri },
  };
}

// An RsaSignature2017 as Mastodon's always_sign writes it (LinkedDataSignature#sign!), by `signer`'s key.
function ldSigned(json: Json, signer: TestActor): Promise<Json> {
  return signJsonLd(json, signer.privateKey, new URL(signer.keyId), { contextLoader: contexts });
}

// What a status Delete leaves once its jobs settle: the status, the streaming deletes, the retractions of it (its
// author's and recordDeletedObject's), the Deletes and Undos recorded (each by its owner, immutable or not), and alice's
// boosts.
async function effects(t: Setup, uri: string) {
  await settle(t.store);
  const [counts] = await sql<{ statuses: number; streamed: number; retractions: number; boosts: number }>(
    t.store,
    `SELECT (SELECT count(*) FROM statuses WHERE uri = ?1) AS statuses,
			(SELECT count(*) FROM stream_events WHERE kind = 'delete') AS streamed,
			(SELECT count(*) FROM inbound_retractions WHERE target_uri = ?1) AS retractions,
			(SELECT count(*) FROM statuses WHERE account_id = ?2 AND reblog_of_id IS NOT NULL) AS boosts`,
    uri,
    ALICE,
  );
  const outbound = await sql<{ account_id: string; type: string; immutable: number | null }>(
    t.store,
    `SELECT account_id, json_extract(body, '$.activity.type') AS type, json_extract(body, '$.immutable') AS immutable
		FROM outbound_activities WHERE json_extract(body, '$.activity.type') IN ('Delete', 'Undo') ORDER BY id`,
  );
  return { ...counts, outbound };
}

// alice's boost of `id` through the API, and a listener on her user stream (so a status's removal streams, R32).
async function boostAndListen(t: Setup, id: string): Promise<void> {
  const boosted = await t.request(`/api/v1/statuses/${id}/reblog`, bearer(t.tokens.alice, { method: "POST" }));
  expect(boosted.status).toBe(200);
  await sql(t.store, "INSERT INTO stream_subscriptions (account_id, stream_key, sockets) VALUES (?, 'user', 1)", ALICE);
}

describe("a relayed status Delete with the author's proof (ID-1)", () => {
  it("applies a Mastodon-signed Delete of a public or unlisted status as the author's own, with its effects", async () => {
    for (const visibility of ["public", "unlisted"] as const) {
      // The same status, deleted by its author directly, and relayed by dan: the same effects.
      const results = [];
      for (const route of ["author", "relayed"] as const) {
        const { t, bob, dan } = await world();
        const status = await note(t, bob, visibility === "unlisted" ? UNLISTED(bob) : {});
        await boostAndListen(t, status.id);
        const signed = await ldSigned(deletion(bob, status.uri), bob);
        expect(await t.post(route === "author" ? bob : dan, signed)).toBe(202);
        results.push(await effects(t, status.uri));
      }
      const [own, relayed] = results;
      expect(relayed, visibility).toEqual(own);
      // Gone, streamed once, retracted, alice's boost withdrawn with its Undo, and the Delete forwarded through it.
      expect(own).toMatchObject({ statuses: 0, streamed: 1, retractions: 2, boosts: 0 });
      expect(own!.outbound).toEqual([
        { account_id: ALICE, type: "Delete", immutable: 1 },
        { account_id: ALICE, type: "Undo", immutable: null },
      ]);
    }
  }, 60_000);

  it("applies a relayed Delete that names the status by its uri alone", async () => {
    const { t, bob, dan } = await world();
    const status = await note(t, bob);
    expect(await t.post(dan, await ldSigned(deletion(bob, status.uri, "bare"), bob))).toBe(202);
    await settle(t.store);
    expect(await stored(t.store, status.uri)).toBeNull();
  });

  it("applies a Kopje author's signed Delete, made on the real path, relayed by another server", async () => {
    // The author's Kopje: ann on author.example, followed by alice of kopje.test.
    const ANN = "300000000000000001";
    const ANN_URI = "https://author.example/ap/users/ann";
    const authorStore = await migratedStore();
    await setDomain(authorStore, "author.example");
    await seedLocalAccount(authorStore, "author.example", { id: ANN, username: "ann", key: LEGACY_EMPTY_KEK });
    const author = harness(authorStore, {}, BUILD, offline, () => NOW, "author.example");
    const annToken = await token(authorStore, ANN);
    await sql(
      authorStore,
      `INSERT INTO accounts (id, uri, username, domain, inbox_url, shared_inbox_url)
			VALUES ('400000000000000001', ?, 'alice', 'kopje.test', ?, 'https://kopje.test/inbox')`,
      ALICE_URI,
      `${ALICE_URI}/inbox`,
    );
    await sql(
      authorStore,
      "INSERT INTO follows (account_id, target_account_id, state) VALUES ('400000000000000001', ?, 'accepted')",
      ANN,
    );
    const { t, dan } = await world();
    const document = (await (await author.request("/ap/users/ann", AP)).json()) as Json;
    t.web.serve(ANN_URI, document);
    const ann: TestActor = {
      uri: ANN_URI,
      keyId: `${ANN_URI}#main-key`,
      privateKey: (await fixtureKeyGen()).privateKey,
      pem: LEGACY_EMPTY_KEK.pubkey,
      document,
    };
    await followed(t, ann);
    // Every activity ann's Kopje sends kopje.test, as sent: what its deliveries POST.
    const sent = async () => {
      await settle(authorStore);
      const bodies: { inbox: string; body: string }[] = [];
      for (let round = 0; round < 20; round++) {
        const { claim, sent: posted } = await claimAndSettle(authorStore, {
          now: NOW,
          leaseToken: `lease-${round}`,
          outcome: { kind: "delivered", status: 202 },
        });
        bodies.push(...posted);
        if (claim.deliveries.length === 0) {
          return bodies;
        }
      }
      throw new Error("the deliveries did not settle");
    };
    const posted = await author.request("/api/v1/statuses", {
      method: "POST",
      headers: { authorization: `Bearer ${annToken}`, "content-type": "application/json" },
      body: JSON.stringify({ status: "relay me", visibility: "unlisted" }),
    });
    const status = await posted.json<{ id: string; uri: string }>();
    for (const { body } of await sent()) {
      expect(await t.post(ann, body)).toBe(202);
    }
    expect(await stored(t.store, status.uri)).toMatchObject({ visibility: "unlisted", withdrawn: 0 });
    const deleting = await author.request(`/api/v1/statuses/${status.id}`, bearer(annToken, { method: "DELETE" }));
    expect(deleting.status).toBe(200);
    const [delivered, ...more] = (await sent()).filter((s) => (JSON.parse(s.body) as Json).type === "Delete");
    expect(more).toEqual([]);
    // dan relays it, as received: kopje.test applies it as ann's.
    expect(await t.post(dan, delivered!.body)).toBe(202);
    await settle(t.store);
    expect(await stored(t.store, status.uri)).toBeNull();
  }, 60_000);
});

describe("a relayed status Delete that does not meet every condition changes nothing (ID-1)", () => {
  it("refuses a relayed Delete of a status without the author's proof", async () => {
    const { t, bob, dan } = await world();
    const status = await note(t, bob);
    expect(await t.post(dan, deletion(bob, status.uri))).toBe(202);
    expect(await stored(t.store, status.uri)).toEqual({ visibility: "public", withdrawn: 0 });
  });

  it.each([
    ["a forged signature (another key under the author's key id)", "forged"],
    ["a proof by the relaying server's key", "relayer"],
    ["a proof covering another status", "tampered"],
  ])("refuses %s", async (_name, kind) => {
    const { t, bob, dan } = await world();
    const status = await note(t, bob);
    const other = await note(t, bob);
    let body: Json;
    if (kind === "forged") {
      body = await ldSigned(deletion(bob, status.uri), { ...bob, privateKey: dan.privateKey });
    } else if (kind === "relayer") {
      body = await ldSigned(deletion(bob, status.uri), dan);
    } else {
      const signed = await ldSigned(deletion(bob, other.uri), bob);
      body = { ...signed, object: { id: status.uri, type: "Tombstone", atomUri: status.uri } };
    }
    expect(await t.post(dan, body)).toBe(401);
    expect(await stored(t.store, status.uri)).toEqual({ visibility: "public", withdrawn: 0 });
  });

  it("refuses a relay whose HTTP signer does not own its key", async () => {
    const { t, bob, dan } = await world();
    const status = await note(t, bob);
    // A key that names dan as its owner, served with mallory's material, while dan's document lists that key id with
    // dan's own material: the id matches (as Fedify's ownership check reads it), the key material does not (ID-1).
    const keyUrl = `${RELAY}/keys/dan`;
    const mallory = await mastodonActor(t.web, "mallory", { origin: RELAY, key: 7 });
    t.web.serve(dan.uri, { ...dan.document, publicKey: { id: keyUrl, owner: dan.uri, publicKeyPem: dan.pem } });
    t.web.serve(keyUrl, {
      "@context": [AS, SECURITY, { Key: "sec:Key" }],
      id: keyUrl,
      type: "Key",
      owner: dan.uri,
      publicKeyPem: mallory.pem,
    });
    const signed = await ldSigned(deletion(bob, status.uri), bob);
    expect(await t.post(mallory, signed, { keyId: keyUrl })).toBe(401);
    expect(await stored(t.store, status.uri)).toEqual({ visibility: "public", withdrawn: 0 });
  });

  it("refuses a proven Delete of a status stored as another author's", async () => {
    const { t, bob, erin, dan } = await world();
    // erin's status, of bob's origin: bob's proof of its Delete does not make him its author.
    const status = await note(t, erin);
    expect(await t.post(dan, await ldSigned(deletion(bob, status.uri), bob))).toBe(202);
    expect(await stored(t.store, status.uri)).toEqual({ visibility: "public", withdrawn: 0 });
  });

  it("refuses a proven Delete of a status whose uri is not of the author's origin", async () => {
    const { t, bob, dan } = await world();
    const status = await note(t, bob);
    // bob's status stored under a uri of another origin (as an import may hold one).
    const foreign = `https://elsewhere.example/statuses/${nextId()}`;
    await sql(t.store, "UPDATE statuses SET uri = ? WHERE id = ?", foreign, status.id);
    // The Delete's own id is of bob's origin (ID-1), its object not.
    const body = { ...deletion(bob, foreign), id: `${bob.uri}#delete-${nextId()}` };
    expect(await t.post(dan, await ldSigned(body, bob))).toBe(202);
    expect(await stored(t.store, foreign)).toEqual({ visibility: "public", withdrawn: 0 });
  });

  it("refuses a proven Delete of a private or direct status", async () => {
    const { t, bob, dan } = await world();
    const priv = await note(t, bob, FOLLOWERS_ONLY(bob));
    const direct = await note(t, bob, { to: [ALICE_URI], cc: [] });
    for (const status of [priv, direct]) {
      const before = await stored(t.store, status.uri);
      expect(before).toMatchObject({ withdrawn: 0 });
      expect(await t.post(dan, await ldSigned(deletion(bob, status.uri), bob))).toBe(202);
      expect(await stored(t.store, status.uri)).toEqual(before);
    }
  });

  it("refuses a proven Delete of a boost", async () => {
    const { t, bob, erin, dan } = await world();
    const original = await note(t, erin);
    const boost = announce(bob, original.uri);
    expect(await t.post(bob, boost)).toBe(202);
    expect(await stored(t.store, boost.id)).toMatchObject({ withdrawn: 0 });
    expect(await t.post(dan, await ldSigned(deletion(bob, boost.id), bob))).toBe(202);
    expect(await stored(t.store, boost.id)).toMatchObject({ withdrawn: 0 });
  });

  it("refuses a relayed Delete of an actor, proven or not", async () => {
    const { t, bob, erin, dan } = await world();
    // Of the actor itself (a DeleteActor), and of another actor of its origin.
    expect(await t.post(dan, await ldSigned(deletion(bob, bob.uri, "bare"), bob))).toBe(401);
    expect(await t.post(dan, await ldSigned(deletion(bob, erin.uri, "bare"), bob))).toBe(202);
    const accounts = await sql<{ uri: string }>(
      t.store,
      "SELECT uri FROM accounts WHERE uri IN (?, ?) ORDER BY uri",
      bob.uri,
      erin.uri,
    );
    expect(accounts).toEqual([{ uri: bob.uri }, { uri: erin.uri }]);
    expect(await sql(t.store, "SELECT count(*) AS n FROM inbound_retractions WHERE target_uri = ?", erin.uri)).toEqual([
      { n: 0 },
    ]);
  });
});

describe("a relayed status Delete is decided again by the Store (ID-1)", () => {
  // While the Worker fetches bob's document to verify his proof, `change` alters the status: the Store, which reads it
  // again in its own transaction, applies nothing.
  async function raced(change: (t: Setup, status: { uri: string; id: string }, bob: TestActor) => Promise<void>) {
    const { t, bob, dan } = await world();
    const status = await note(t, bob);
    const signed = await ldSigned(deletion(bob, status.uri), bob);
    const held = t.web.hold(bob.uri);
    const relayed = t.post(dan, signed);
    await held.reached;
    await change(t, status, bob);
    held.release();
    expect(await relayed).toBe(202);
    return { t, status };
  }

  it("applies nothing to a status that turned private meanwhile", async () => {
    const { t, status } = await raced(async (t, status) => {
      await sql(t.store, "UPDATE statuses SET visibility = 'private' WHERE id = ?", status.id);
    });
    expect(await stored(t.store, status.uri)).toEqual({ visibility: "private", withdrawn: 0 });
  });

  it("applies nothing more to a status its author deleted meanwhile", async () => {
    const { t, status } = await raced(async (t, status, bob) => {
      await boostAndListen(t, status.id);
      expect(await t.post(bob, await ldSigned(deletion(bob, status.uri), bob))).toBe(202);
    });
    const after = await effects(t, status.uri);
    expect(after).toMatchObject({ statuses: 0, streamed: 1, retractions: 2, boosts: 0 });
    expect(after.outbound.filter((o) => o.type === "Delete")).toHaveLength(1);
  });
});

describe("a relayed status Delete replayed (ID-1, ID-7)", () => {
  it("applies once: the same relayed Delete twice, or after the author's own", async () => {
    for (const first of ["relayed", "author"] as const) {
      const { t, bob, dan } = await world();
      const status = await note(t, bob);
      await boostAndListen(t, status.id);
      const signed = await ldSigned(deletion(bob, status.uri), bob);
      expect(await t.post(first === "relayed" ? dan : bob, signed)).toBe(202);
      // Again while the removal runs, and again once it is done.
      expect(await t.post(dan, signed)).toBe(202);
      const after = await effects(t, status.uri);
      expect(await t.post(dan, signed)).toBe(202);
      expect(await effects(t, status.uri), first).toEqual(after);
      expect(after).toMatchObject({ statuses: 0, streamed: 1, retractions: 2, boosts: 0 });
      expect(
        after.outbound.filter((o) => o.type === "Delete"),
        first,
      ).toHaveLength(1);
    }
  }, 60_000);

  it("records a proven relayed Delete of a status Kopje does not hold as a retraction, so it never appears", async () => {
    const { t, bob, dan } = await world();
    const unseen = mastodonNote(bob);
    expect(await t.post(dan, await ldSigned(deletion(bob, unseen.id), bob))).toBe(202);
    expect(await sql(t.store, "SELECT count(*) AS n FROM inbound_retractions WHERE target_uri = ?", unseen.id)).toEqual(
      [{ n: 1 }],
    );
    expect(await t.post(bob, create(bob, unseen))).toBe(202);
    expect(await stored(t.store, unseen.id)).toBeNull();
  });
});
