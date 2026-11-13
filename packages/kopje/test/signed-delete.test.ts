import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { deleteActivity, signableDeleteActivity } from "../src/domain/activities";
import { forwardSubject } from "../src/domain/deliveries";
import { deleteStatus, prepareDelete } from "../src/domain/statuses";
import { verifyAuthorProof } from "../src/federation/author-proof";
import { signAsAuthor } from "../src/federation/ld-sign";
import type { StoreStub } from "../src/platform/store-client";
import { sha256Hex } from "../src/security/tokens";
import { bearer, settle, sql } from "./api-helpers";
import { harness, NOW, offline } from "./app-helpers";
import { deleteSignature, remoteAccountsAt, retractionInboxes } from "./delete-job-helpers";
import { fixtureKeyGen, LEGACY_EMPTY_KEK, seedLocalAccount, setDomain } from "./federation-helpers";
import { BUILD, claimAndSettle, migratedStore } from "./helpers";
import { mastodonActor } from "./inbox-helpers";
import {
  ALICE,
  ALICE_URI,
  announce,
  AS,
  followed,
  localStatus,
  PUBLIC,
  setup,
  type Setup,
  token,
} from "./inbox-status-helpers";
import { ACCESS, copyConfig, dumpViaRpc, importViaRpc, setAccess } from "./ops-helpers";
import { contexts } from "./quote-helpers";

// VIS-3, ID-1, RES-6: the Delete of a local public or unlisted original carries its author's RsaSignature2017
// signature (statuses.ts prepareDelete and deleteStatus, mastodon/statuses.ts deleteStatus, federation/ld-sign.ts),
// addressed to Public alone and recorded immutable, so every delivery sends the bytes signed; a Delete of any other
// visibility is unsigned and as it was. The record checks the signed body against its own snapshot before it writes
// anything, and a DELETE whose Delete cannot be signed writes nothing.

const PRESENT = { origin: "https://kopje.test" };
const FANS = "https://fans.example";
const SECURITY = "https://w3id.org/security/v1";
const AP = { headers: { accept: "application/activity+json" } };

type Json = Record<string, unknown>;

// alice, followed by carol (fans.example), and dave, each with the fixture key under the tests' empty USER_KEK.
async function world() {
  const t = await setup();
  const carol = await mastodonActor(t.web, "carol", { origin: FANS, key: 3 });
  const follow = { "@context": AS, id: `${carol.uri}#follows/1`, type: "Follow", actor: carol.uri, object: ALICE_URI };
  expect(await t.post(carol, follow)).toBe(202);
  return { t, carol };
}

async function credential(t: Setup, as: "alice" | "dave" = "alice") {
  return { tokenHash: await sha256Hex(t.tokens[as]), scope: "write:statuses" as const, now: NOW };
}

function deleteRequest(t: Setup, id: string, as: "alice" | "dave" = "alice") {
  return t.request(`/api/v1/statuses/${id}`, bearer(t.tokens[as], { method: "DELETE" }));
}

// alice's record of the DELETE of `id` with `signed`, as a Store operation in its own transaction: its answer and the
// rows it wrote (total_changes()).
async function recorded(t: Setup, id: string, signed: Json | null, as: "alice" | "dave" = "alice") {
  const input = { credential: await credential(t, as), id, deleteMedia: false, signed, now: NOW, present: PRESENT };
  return runInDurableObject(t.store, (_instance, state) => {
    const db = new Db(state.storage.sql);
    const changes = () => db.first<{ n: number }>("SELECT total_changes() AS n")!.n;
    const before = changes();
    const result = state.storage.transactionSync(() => deleteStatus.run(state.storage.sql, input));
    return { answer: result.status === "ok" ? result.value.status : result.status, wrote: changes() - before };
  });
}

// alice listens on `user`, so a DELETE that goes ahead captures a streaming delete (R32).
async function listen(t: Setup): Promise<void> {
  await sql(t.store, "INSERT INTO stream_subscriptions (account_id, stream_key, sockets) VALUES (?, 'user', 1)", ALICE);
}

async function counts(store: StoreStub, statusId: string) {
  const [row] = await sql<{ intents: number; events: number; jobs: number; withdrawn: number }>(
    store,
    `SELECT (SELECT count(*) FROM outbound_activities WHERE json_extract(body, '$.activity.type') = 'Delete') AS intents,
			(SELECT count(*) FROM stream_events WHERE kind = 'delete') AS events,
			(SELECT count(*) FROM inbound_jobs WHERE kind = 'delete') AS jobs,
			(SELECT withdrawn FROM statuses WHERE id = ?) AS withdrawn`,
    statusId,
  );
  return row!;
}

// Every body the delivery rounds send, by inbox, as confirmDelivery gives it, each row completed with 202.
async function sent(store: StoreStub): Promise<{ inbox: string; body: string }[]> {
  const all: { inbox: string; body: string }[] = [];
  for (let round = 0; round < 20; round++) {
    const { claim, sent: bodies } = await claimAndSettle(store, {
      now: NOW,
      leaseToken: `lease-${round}`,
      outcome: { kind: "delivered", status: 202 },
    });
    all.push(...bodies);
    if (claim.deliveries.length === 0) {
      return all;
    }
  }
  throw new Error("the deliveries did not settle");
}

async function sentDeletes(store: StoreStub) {
  return (await sent(store)).filter((s) => (JSON.parse(s.body) as Json).type === "Delete");
}

async function actorDocument(t: Setup): Promise<unknown> {
  const response = await t.request("/ap/users/alice", AP);
  expect(response.status).toBe(200);
  return response.json();
}

function proof(json: Json, uri: string, actorDocument: unknown, object = uri) {
  return verifyAuthorProof(json, { id: `${uri}#delete`, actor: ALICE_URI, object }, actorDocument, contexts);
}

describe("the Delete of a local status carries its author's proof when it is public or unlisted (VIS-3)", () => {
  it("is signed on the real path and verifies against the author's actor document, a changed uri failing", async () => {
    for (const visibility of ["public", "unlisted"] as const) {
      const { t } = await world();
      const status = await localStatus(t, { status: visibility, visibility });
      expect((await deleteRequest(t, status.id)).status).toBe(200);
      await settle(t.store);
      const [delivered, ...more] = await sentDeletes(t.store);
      expect(more).toEqual([]);
      expect(delivered!.inbox).toBe(`${FANS}/inbox`);
      const json = JSON.parse(delivered!.body) as Json;
      // Addressed to Public alone, every term it uses defined (atomUri), security/v1 for the signature's terms.
      expect(json).toMatchObject({
        "@context": [AS, { ostatus: "http://ostatus.org#", atomUri: "ostatus:atomUri" }, SECURITY],
        id: `${status.uri}#delete`,
        type: "Delete",
        actor: ALICE_URI,
        to: [PUBLIC],
        object: { id: status.uri, type: "Tombstone", atomUri: status.uri },
        signature: { type: "RsaSignature2017", creator: `${ALICE_URI}#main-key` },
      });
      expect(json).not.toHaveProperty("cc");
      const document = await actorDocument(t);
      expect(await proof(json, status.uri, document)).toBe(true);
      // The proof covers the object's uri, its atomUri and the addressing.
      const other = `${status.uri}0`;
      const moved = { ...json, id: `${other}#delete`, object: { id: other, type: "Tombstone", atomUri: other } };
      expect(await proof(moved, other, document)).toBe(false);
      const atom = { ...json, object: { id: status.uri, type: "Tombstone", atomUri: other } };
      expect(await proof(atom, status.uri, document)).toBe(false);
      const readdressed = { ...json, to: ["https://fans.example/users/carol"] };
      expect(await proof(readdressed, status.uri, document)).toBe(false);
    }
  });

  it("defines every term it signs: the unsigned form's undefined atomUri is refused by canonicalization", async () => {
    const { t } = await world();
    const status = await localStatus(t, { status: "terms" });
    const input = { credential: await credential(t), id: status.id };
    const prepared = await runInDurableObject(t.store, (_instance, state) =>
      prepareDelete.run(state.storage.sql, input),
    );
    const sign = prepared.status === "ok" && prepared.value.status === "ok" ? prepared.value.value.sign : null;
    expect(sign).not.toBeNull();
    expect(await signAsAuthor(LEGACY_EMPTY_KEK.kek, sign!)).toHaveProperty("signature");
    const unsigned = deleteActivity({
      id: status.id,
      uri: status.uri,
      actorUri: ALICE_URI,
      visibility: "public",
      named: [],
      poll: false,
    }).activity;
    await expect(signAsAuthor(LEGACY_EMPTY_KEK.kek, { ...sign!, activity: unsigned })).rejects.toThrow(
      "Safe mode validation error",
    );
  });

  it("leaves the Delete of a private, direct or limited status unsigned and as deleteActivity makes it", async () => {
    for (const visibility of ["private", "direct", "limited"] as const) {
      const { t, carol } = await world();
      const [carolId] = await sql<{ id: string }>(t.store, "SELECT id FROM accounts WHERE uri = ?", carol.uri);
      const status = await localStatus(t, {
        status: visibility,
        visibility: visibility === "limited" ? "private" : visibility,
      });
      // carol is mentioned, so a direct or limited Delete reaches her.
      await sql(
        t.store,
        "INSERT INTO status_mentions (status_id, account_id, silent) VALUES (?, ?, 0)",
        status.id,
        carolId!.id,
      );
      await sql(t.store, "UPDATE statuses SET visibility = ? WHERE id = ?", visibility, status.id);
      expect((await deleteRequest(t, status.id)).status).toBe(200);
      await settle(t.store);
      const [delivered] = await sentDeletes(t.store);
      const expected = deleteActivity({
        id: status.id,
        uri: status.uri,
        actorUri: ALICE_URI,
        visibility,
        named: [carol.uri],
        poll: false,
      }).activity;
      expect(delivered!.body).toBe(JSON.stringify(expected));
      expect(delivered!.body).not.toContain('"signature"');
      expect(delivered!.body).not.toContain('"proof"');
    }
  });

  it("prepares a signature only for an own public or unlisted original, not found where the DELETE is not", async () => {
    const { t } = await world();
    const prepared = async (id: string, as: "alice" | "dave" = "alice") => {
      const input = { credential: await credential(t, as), id };
      return runInDurableObject(t.store, (_instance, state) => prepareDelete.run(state.storage.sql, input));
    };
    const sign = async (id: string) => {
      const result = await prepared(id);
      expect(result).toMatchObject({ status: "ok", value: { status: "ok" } });
      return result.status === "ok" && result.value.status === "ok" ? result.value.value : null;
    };
    for (const visibility of ["public", "unlisted"] as const) {
      const status = await localStatus(t, { status: visibility, visibility });
      expect(await sign(status.id)).toMatchObject({
        sign: {
          keyId: `${ALICE_URI}#main-key`,
          activity: signableDeleteActivity({
            id: status.id,
            uri: status.uri,
            actorUri: ALICE_URI,
            visibility,
            named: [],
            poll: false,
          }),
        },
      });
    }
    for (const visibility of ["private", "direct", "limited"] as const) {
      const status = await localStatus(t, { status: visibility, visibility: "private" });
      await sql(t.store, "UPDATE statuses SET visibility = ? WHERE id = ?", visibility, status.id);
      expect(await sign(status.id)).toEqual({ sign: null });
    }
    // A boost of dave's public status: its Undo is never signed.
    const daves = await localStatus(t, { status: "dave's" }, "dave");
    const boosted = await t.request(`/api/v1/statuses/${daves.id}/reblog`, bearer(t.tokens.alice, { method: "POST" }));
    const boost = await boosted.json<{ id: string }>();
    expect(await sign(boost.id)).toEqual({ sign: null });
    // Not alice's, no such status, and one already deleted: not found, as the DELETE answers.
    expect(await prepared(daves.id)).toMatchObject({ value: { status: "not_found" } });
    expect(await prepared("999999999999999999")).toMatchObject({ value: { status: "not_found" } });
    const gone = await localStatus(t, { status: "gone" });
    expect((await deleteRequest(t, gone.id)).status).toBe(200);
    expect(await prepared(gone.id)).toMatchObject({ value: { status: "not_found" } });
    expect((await deleteRequest(t, gone.id)).status).toBe(404);
  });
});

describe("the record of a signed Delete checks it before anything is written (A4)", () => {
  it("answers stale, writing nothing and capturing no streaming delete, for any body but its own snapshot's", async () => {
    const { t } = await world();
    await listen(t);
    const status = await localStatus(t, { status: "public" });
    const good = (await deleteSignature(t.store, await credential(t), status.id))!;
    const signature = good.signature as Json;
    const tampered: [string, Json | null][] = [
      ["no signature", null],
      ["cc added", { ...good, cc: ["https://fans.example/users/carol"] }],
      ["to changed", { ...good, to: [`${ALICE_URI}/followers`] }],
      ["context without atomUri", { ...good, "@context": [AS, SECURITY] }],
      [
        "another creator",
        { ...good, signature: { ...signature, creator: `${ALICE_URI.replace("alice", "dave")}#main-key` } },
      ],
      ["another type", { ...good, signature: { ...signature, type: "Ed25519Signature2018" } }],
      ["a key more", { ...good, signature: { ...signature, nonce: "x" } }],
      ["value past its bound", { ...good, signature: { ...signature, signatureValue: "A".repeat(2733) } }],
      ["proof added", { ...good, proof: { type: "DataIntegrityProof" } }],
    ];
    for (const [name, signed] of tampered) {
      expect(await recorded(t, status.id, signed), name).toEqual({ answer: "stale", wrote: 0 });
    }
    expect(await counts(t.store, status.id)).toEqual({ intents: 0, events: 0, jobs: 0, withdrawn: 0 });
    // The same record with its own signed body goes ahead.
    const accepted = await recorded(t, status.id, good);
    expect(accepted.answer).toBe("ok");
    expect(accepted.wrote).toBeGreaterThan(0);
    expect(await counts(t.store, status.id)).toEqual({ intents: 1, events: 1, jobs: 1, withdrawn: 1 });
    const [stored] = await sql<{ activity: string; immutable: number }>(
      t.store,
      `SELECT json_extract(body, '$.activity') AS activity, json_extract(body, '$.immutable') AS immutable
			FROM outbound_activities WHERE object_uri = ? AND retracts = 1`,
      status.uri,
    );
    expect(stored).toEqual({ activity: JSON.stringify(good), immutable: 1 });
  });

  it("answers stale for a signed body offered for a private status, or a boost", async () => {
    const { t } = await world();
    await listen(t);
    const status = await localStatus(t, { status: "public" });
    const good = (await deleteSignature(t.store, await credential(t), status.id))!;
    const priv = await localStatus(t, { status: "private", visibility: "private" });
    expect(await deleteSignature(t.store, await credential(t), priv.id)).toBeNull();
    expect(await recorded(t, priv.id, good)).toEqual({ answer: "stale", wrote: 0 });
    const daves = await localStatus(t, { status: "dave's" }, "dave");
    const boosted = await t.request(`/api/v1/statuses/${daves.id}/reblog`, bearer(t.tokens.alice, { method: "POST" }));
    const boost = await boosted.json<{ id: string }>();
    expect(await recorded(t, boost.id, good)).toEqual({ answer: "stale", wrote: 0 });
    expect(await counts(t.store, priv.id)).toMatchObject({ intents: 0, events: 0, jobs: 0, withdrawn: 0 });
    // Without one, each goes ahead.
    expect((await recorded(t, priv.id, null)).answer).toBe("ok");
    expect((await recorded(t, boost.id, null)).answer).toBe("ok");
  });

  it("records a body signed before an edit of the mentions or the content, or a boost, which it does not name", async () => {
    const { t } = await world();
    const bob = await mastodonActor(t.web, "bob");
    const [m] = await remoteAccountsAt(t.store, "6", "m", 1);
    const status = await localStatus(t, { status: "before" });
    await sql(t.store, "INSERT INTO status_mentions (status_id, account_id, silent) VALUES (?, ?, 0)", status.id, m!);
    const signed = (await deleteSignature(t.store, await credential(t), status.id))!;
    // While it is signed: an edit drops the mention (it stays silent) and changes the text, and bob boosts it.
    const edited = await t.request(`/api/v1/statuses/${status.id}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${t.tokens.alice}`, "content-type": "application/json" },
      body: JSON.stringify({ status: "after" }),
    });
    expect(edited.status).toBe(200);
    expect(await sql(t.store, "SELECT silent FROM status_mentions WHERE status_id = ?", status.id)).toEqual([
      { silent: 1 },
    ]);
    expect(await t.post(bob, announce(bob, status.uri))).toBe(202);
    expect(await sql(t.store, "SELECT 1 AS x FROM statuses WHERE reblog_of_id = ?", status.id)).toHaveLength(1);
    expect((await recorded(t, status.id, signed)).answer).toBe("ok");
    await settle(t.store);
    // The mention dropped by the edit and the booster bob, neither named, get a copy of their own (as the unsigned
    // Delete's addressing placed them); carol's server gets the neutral one.
    expect(await retractionInboxes(t.store, status.uri, "Delete")).toEqual(
      new Set(["https://m1.example/users/u/inbox", "https://mastodon.example/users/bob/inbox", `${FANS}/inbox`]),
    );
  });

  it("answers the second of two DELETEs prepared together not found, recording one Delete", async () => {
    const { t } = await world();
    const status = await localStatus(t, { status: "twice" });
    const first = await deleteSignature(t.store, await credential(t), status.id);
    const second = await deleteSignature(t.store, await credential(t), status.id);
    expect((await recorded(t, status.id, first)).answer).toBe("ok");
    expect(await recorded(t, status.id, second)).toEqual({ answer: "not_found", wrote: 0 });
    expect(await counts(t.store, status.id)).toMatchObject({ intents: 1, withdrawn: 1 });
  });
});

describe("a DELETE whose Delete cannot be signed writes nothing (A1)", () => {
  it("answers 503 when the author's key cannot be unwrapped, and a later DELETE records one signed Delete", async () => {
    const { t } = await world();
    await listen(t);
    const status = await localStatus(t, { status: "kept" });
    const loader = { keygen: fixtureKeyGen, loader: t.web.loader };
    const wrongKek = harness(t.store, { USER_KEK: "not-the-kek" }, BUILD, loader);
    const refused = await wrongKek.request(
      `/api/v1/statuses/${status.id}`,
      bearer(t.tokens.alice, { method: "DELETE" }),
    );
    expect(refused.status).toBe(503);
    expect(await counts(t.store, status.id)).toEqual({ intents: 0, events: 0, jobs: 0, withdrawn: 0 });
    expect((await t.request(`/api/v1/statuses/${status.id}`, bearer(t.tokens.alice))).status).toBe(200);
    // A signer that throws: the same.
    const throwing = harness(t.store, {}, BUILD, loader, () => NOW, "kopje.test", {
      signAsAuthor: () => Promise.reject(new Error("canonicalization failed")),
    });
    expect(
      (await throwing.request(`/api/v1/statuses/${status.id}`, bearer(t.tokens.alice, { method: "DELETE" }))).status,
    ).toBe(503);
    expect(await counts(t.store, status.id)).toEqual({ intents: 0, events: 0, jobs: 0, withdrawn: 0 });
    expect((await deleteRequest(t, status.id)).status).toBe(200);
    expect(await counts(t.store, status.id)).toEqual({ intents: 1, events: 1, jobs: 1, withdrawn: 1 });
    const [stored] = await sql<{ type: string }>(
      t.store,
      "SELECT json_extract(body, '$.activity.signature.type') AS type FROM outbound_activities WHERE object_uri = ? AND retracts = 1",
      status.uri,
    );
    expect(stored).toEqual({ type: "RsaSignature2017" });
  });

  it("answers 503 after three rounds whose signed body is stale, the status still available", async () => {
    const { t } = await world();
    await listen(t);
    const status = await localStatus(t, { status: "kept" });
    let rounds = 0;
    const altering = harness(
      t.store,
      {},
      BUILD,
      { keygen: fixtureKeyGen, loader: t.web.loader },
      () => NOW,
      "kopje.test",
      {
        signAsAuthor: async (_env, sign) => {
          rounds++;
          return { ...(await signAsAuthor(LEGACY_EMPTY_KEK.kek, sign)), cc: [`${ALICE_URI}/followers`] };
        },
      },
    );
    const response = await altering.request(
      `/api/v1/statuses/${status.id}`,
      bearer(t.tokens.alice, { method: "DELETE" }),
    );
    expect(response.status).toBe(503);
    expect(rounds).toBe(3);
    expect(await counts(t.store, status.id)).toEqual({ intents: 0, events: 0, jobs: 0, withdrawn: 0 });
    expect((await t.request(`/api/v1/statuses/${status.id}`, bearer(t.tokens.alice))).status).toBe(200);
  });
});

describe("the signed Delete is sent as recorded (VIS-2's exception)", () => {
  it("sends the stored bytes to every target, a silent recipient's own copy included, which does not name it", async () => {
    const { t } = await world();
    const [silent] = await remoteAccountsAt(t.store, "6", "s", 1);
    const status = await localStatus(t, { status: "with a silent recipient" });
    await sql(
      t.store,
      "INSERT INTO status_mentions (status_id, account_id, silent) VALUES (?, ?, 1)",
      status.id,
      silent!,
    );
    expect((await deleteRequest(t, status.id)).status).toBe(200);
    await settle(t.store);
    const [stored] = await sql<{ activity: string }>(
      t.store,
      "SELECT json_extract(body, '$.activity') AS activity FROM outbound_activities WHERE object_uri = ? AND retracts = 1",
      status.uri,
    );
    // The silent recipient's target is a copy of its own (addressee), as the unsigned Delete's was.
    const personal = await sql<{ inbox: string; addressee: string }>(
      t.store,
      `SELECT inbox_url AS inbox, addressee FROM deliveries WHERE addressee IS NOT NULL
			UNION SELECT json_extract(t.value, '$.inbox'), json_extract(t.value, '$.addressee')
			FROM outbound_targets c, json_each(c.targets) t WHERE json_extract(t.value, '$.addressee') IS NOT NULL`,
    );
    expect(personal).toEqual([{ inbox: "https://s1.example/users/u/inbox", addressee: "https://s1.example/users/u" }]);
    const deletes = await sentDeletes(t.store);
    expect(deletes.map((d) => d.inbox).toSorted()).toEqual([`${FANS}/inbox`, "https://s1.example/users/u/inbox"]);
    for (const d of deletes) {
      expect(d.body).toBe(stored!.activity);
      expect(d.body).not.toContain("s1.example");
    }
  });

  it("is sent from a restored Store as it was recorded, and its proof still verifies", async () => {
    const { t } = await world();
    await setAccess(t.store);
    const status = await localStatus(t, { status: "dumped" });
    expect((await deleteRequest(t, status.id)).status).toBe(200);
    const [stored] = await sql<{ activity: string }>(
      t.store,
      "SELECT json_extract(body, '$.activity') AS activity FROM outbound_activities WHERE object_uri = ? AND retracts = 1",
      status.uri,
    );
    const { text } = await dumpViaRpc(t.store);
    const target = await migratedStore();
    await copyConfig(t.store, target);
    expect((await importViaRpc(target, text)).report).toMatchObject({ ok: true, problems: [] });
    expect(await target.publish(BUILD, ACCESS)).toMatchObject({ ok: true });
    await settle(target);
    const deletes = await sentDeletes(target);
    expect(deletes).toEqual([{ inbox: `${FANS}/inbox`, body: stored!.activity }]);
    const restored = harness(target, {}, BUILD, { keygen: fixtureKeyGen, loader: t.web.loader });
    const document = await (await restored.request("/ap/users/alice", AP)).json();
    expect(await proof(JSON.parse(deletes[0]!.body) as Json, status.uri, document)).toBe(true);
  }, 120_000);

  it("sends a Delete the previous release recorded unsigned as it was, placed by its own to and cc", async () => {
    const { t, carol } = await world();
    const [silent] = await remoteAccountsAt(t.store, "6", "s", 1);
    const [carolId] = await sql<{ id: string }>(t.store, "SELECT id FROM accounts WHERE uri = ?", carol.uri);
    const status = await localStatus(t, { status: "recorded before" });
    await sql(
      t.store,
      "INSERT INTO status_mentions (status_id, account_id, silent) VALUES (?1, ?2, 0), (?1, ?3, 1)",
      status.id,
      carolId!.id,
      silent!,
    );
    expect((await deleteRequest(t, status.id)).status).toBe(200);
    // The envelope as the previous release recorded it: unsigned, with no addressing of its own.
    const old = deleteActivity({
      id: status.id,
      uri: status.uri,
      actorUri: ALICE_URI,
      visibility: "public",
      named: [carol.uri],
      poll: false,
    });
    await sql(
      t.store,
      "UPDATE outbound_activities SET body = ? WHERE object_uri = ? AND retracts = 1",
      JSON.stringify(old),
      status.uri,
    );
    await settle(t.store);
    const deletes = await sentDeletes(t.store);
    const shared = deletes.find((d) => d.inbox === `${FANS}/inbox`)!;
    expect(shared.body).toBe(JSON.stringify(old.activity));
    const own = deletes.find((d) => d.inbox === "https://s1.example/users/u/inbox")!;
    expect(JSON.parse(own.body)).toMatchObject({ to: [PUBLIC, "https://s1.example/users/u"] });
    expect(own.body).not.toContain('"signature"');
  });
});

describe("an identity a verifier would not match is not signed (A7)", () => {
  it("records the Delete unsigned for an imported actor id or status uri not in its canonical spelling", async () => {
    for (const [column, spelling] of [
      ["accounts", "https://KOPJE.test/ap/users/alice"],
      ["accounts", "https://kopje.test:443/ap/users/alice"],
      ["statuses", "https://kopje.test/ap/o/\u0000x"],
      ["statuses", "https://kopje.test/ap/o/\u{1F600}"],
    ] as const) {
      const { t } = await world();
      const status = await localStatus(t, { status: "imported" });
      if (column === "accounts") {
        await sql(t.store, "UPDATE accounts SET uri = ? WHERE id = ?", spelling, ALICE);
      } else {
        await sql(t.store, "UPDATE statuses SET uri = ? WHERE id = ?", spelling, status.id);
      }
      expect(await deleteSignature(t.store, await credential(t), status.id), spelling).toBeNull();
      expect((await deleteRequest(t, status.id)).status, spelling).toBe(200);
      const [stored] = await sql<{ signature: string | null; cc: string | null }>(
        t.store,
        `SELECT json_extract(body, '$.activity.signature') AS signature, json_extract(body, '$.activity.cc') AS cc
				FROM outbound_activities WHERE json_extract(body, '$.activity.type') = 'Delete'`,
      );
      // The unsigned form, which names the followers in cc.
      expect(stored!.signature, spelling).toBeNull();
      expect(JSON.parse(stored!.cc!), spelling).toHaveLength(1);
    }
  });
});

describe("a Kopje holder of a boost forwards a Kopje author's signed Delete (VIS-3)", () => {
  it("verifies the author's proof and forwards the body as the author's Kopje sent it", async () => {
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
    // The holder: kopje.test, where alice follows ann and carol follows alice.
    const { t } = await world();
    const document = (await (await author.request("/ap/users/ann", AP)).json()) as Json;
    t.web.serve(ANN_URI, document);
    const ann = {
      uri: ANN_URI,
      keyId: `${ANN_URI}#main-key`,
      privateKey: (await fixtureKeyGen()).privateKey,
      pem: LEGACY_EMPTY_KEK.pubkey,
      document,
    };
    await followed(t, ann);
    // Each activity ann's Kopje sends alice's server, POSTed there as sent.
    const relay = async () => {
      await settle(authorStore);
      for (const { inbox, body } of await sent(authorStore)) {
        expect(inbox).toBe("https://kopje.test/inbox");
        expect(await t.post(ann, body)).toBe(202);
      }
    };
    const posted = await author.request("/api/v1/statuses", {
      method: "POST",
      headers: { authorization: `Bearer ${annToken}`, "content-type": "application/json" },
      body: JSON.stringify({ status: "boost me" }),
    });
    const status = await posted.json<{ id: string; uri: string }>();
    await relay();
    const [held] = await sql<{ id: string }>(t.store, "SELECT id FROM statuses WHERE uri = ?", status.uri);
    const boosted = await t.request(`/api/v1/statuses/${held!.id}/reblog`, bearer(t.tokens.alice, { method: "POST" }));
    expect(boosted.status).toBe(200);
    await settle(t.store);
    await sent(t.store);
    // ann deletes it: alice's server verifies her proof and forwards the Delete to carol's.
    const deleting = await author.request(`/api/v1/statuses/${status.id}`, bearer(annToken, { method: "DELETE" }));
    expect(deleting.status).toBe(200);
    await settle(authorStore);
    const [delivered, ...more] = await sentDeletes(authorStore);
    expect(more).toEqual([]);
    expect(
      await verifyAuthorProof(
        JSON.parse(delivered!.body) as Json,
        { id: `${status.uri}#delete`, actor: ANN_URI, object: status.uri },
        document,
        contexts,
      ),
    ).toBe(true);
    expect(await t.post(ann, delivered!.body)).toBe(202);
    const forwards = await sql<{ account_id: string; immutable: number }>(
      t.store,
      "SELECT account_id, json_extract(body, '$.immutable') AS immutable FROM outbound_activities WHERE object_uri = ?",
      forwardSubject(status.uri),
    );
    expect(forwards).toEqual([{ account_id: ALICE, immutable: 1 }]);
    await settle(t.store);
    const forwarded = await sentDeletes(t.store);
    expect(forwarded.map((f) => f.inbox)).toContain(`${FANS}/inbox`);
    for (const f of forwarded) {
      expect(JSON.parse(f.body)).toEqual(JSON.parse(delivered!.body));
    }
  }, 60_000);
});
