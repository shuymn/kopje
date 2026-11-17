import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { ourFeatureRequest } from "../src/domain/feature-requests";
import { SWEEP_BATCH } from "../src/domain/remote-actors";
import { settleDeliveries, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { mastodon47Signed, mastodonFeatureDelete, signTime } from "./author-proof-helpers";
import { checkRound, FEATURE_CONTEXT } from "./featured-collection-helpers";
import { BUILD } from "./helpers";
import { mastodonActor, type TestActor } from "./inbox-helpers";
import { ALICE_URI, AS, followed, PUBLIC, retractionsAtCap, setup, type Setup } from "./inbox-status-helpers";
import { watchedCursor } from "./read-helpers";

// Remote members of local collections (#1589's D23, Mastodon 4.7.5's AddAccountToCollectionService, FeatureRequest,
// Accept#accept_feature_request!, Reject#reject_feature_request!, Delete#delete_feature_authorization!): a consenting
// remote member is added pending and asked with a FeatureRequest, accepted only on its own Accept with a result on its
// host (or a check of it, when a deletion of another of its authorizations came first), ended by its Reject, and
// revoked by its Delete of the item's current authorization (design §6, PR 4: 4-T2 to 4-T6).

const PENDING = 0;
const ACCEPTED = 1;
const REJECTED = 2;
const REVOKED = 3;
const CAN_FEATURE = { interactionPolicy: { canFeature: { automaticApproval: [PUBLIC] } } };

type World = { t: Setup; member: TestActor; memberId: string };
type ItemRow = {
  id: string;
  state: number;
  activity_uri: string | null;
  approval_uri: string | null;
  candidate_approval_uri: string | null;
  retracted_approval_uri: string | null;
  check_due_at: number | null;
  check_token: string | null;
};
type Sent = { activity: Record<string, unknown>; inboxes: string[] };

let worlds = 0;

// alice, and a remote member whose canFeature approves the public automatically, stored by its Follow of dave.
async function world(name = `fm${++worlds}`): Promise<World> {
  const t = await setup();
  const member = await mastodonActor(t.web, name, { extra: CAN_FEATURE });
  return { t, member, memberId: await followed(t, member) };
}

async function call(t: Setup, method: string, path: string, body?: unknown) {
  const response = await t.request(path, {
    method,
    headers: { authorization: `Bearer ${t.tokens.alice}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: (text === "" ? {} : JSON.parse(text)) as Record<string, unknown> };
}

const collectionUri = (id: string) => `${ALICE_URI}/collections/${id}`;

// The members of the collection `id` dave is shown (R45's item arm).
async function shownItems(w: World, id: string): Promise<string[]> {
  const shown = await w.t.api<{ collection: { items: { account_id?: string }[] } }>(
    `/api/v1/collections/${id}`,
    "dave",
  );
  return shown.body.collection.items.map((item) => item.account_id ?? "");
}

// A new collection of alice's holding the member: its id and uri, and the member's item.
async function featuring(w: World): Promise<{ id: string; uri: string; item: ItemRow }> {
  const made = await call(w.t, "POST", "/api/v1/collections", {
    name: "c",
    sensitive: false,
    discoverable: true,
    account_ids: [w.memberId],
  });
  expect(made.status).toBe(200);
  const id = (made.body.collection as { id: string }).id;
  return { id, uri: collectionUri(id), item: await itemOf(w, id) };
}

async function itemOf(w: World, collection: string): Promise<ItemRow> {
  const [row] = await sql<ItemRow>(
    w.t.store,
    `SELECT id, state, activity_uri, approval_uri, candidate_approval_uri, retracted_approval_uri, check_due_at,
			check_token
		FROM collection_items WHERE collection_id = ? AND account_id = ?`,
    collection,
    w.memberId,
  );
  return row!;
}

// Each recorded activity with the inboxes its deliveries were expanded to, in record order.
async function sent(t: Setup): Promise<Sent[]> {
  await settleDeliveries(t.store);
  const rows = await sql<{ id: number; body: string }>(t.store, "SELECT id, body FROM outbound_activities ORDER BY id");
  const deliveries = await sql<{ activity_id: number; inbox_url: string }>(
    t.store,
    "SELECT activity_id, inbox_url FROM deliveries ORDER BY id",
  );
  return rows.map((row) => ({
    activity: (JSON.parse(row.body) as { activity: Record<string, unknown> }).activity,
    inboxes: deliveries
      .filter((d) => d.activity_id === row.id)
      .map((d) => d.inbox_url)
      .toSorted(),
  }));
}

// The item activities about the item `item` (its Add and Remove), in record order.
async function itemActivities(t: Setup, item: string): Promise<string[]> {
  return (await sent(t)).flatMap(({ activity }) => {
    const object = activity.object;
    const id = typeof object === "string" ? object : (object as { id?: unknown } | undefined)?.id;
    return id === `${ALICE_URI}/collection_items/${item}` ? [String(activity.type)] : [];
  });
}

let answers = 0;

// The member's answer to `request` (AcceptFeatureRequestSerializer, RejectFeatureRequestSerializer).
function answer(member: TestActor, type: "Accept" | "Reject", request: string, result?: unknown) {
  return {
    "@context": AS,
    id: `${member.uri}#${type === "Accept" ? "accepts" : "rejects"}/feature_requests/${++answers}`,
    type,
    actor: member.uri,
    to: ALICE_URI,
    object: request,
    ...(result === undefined ? {} : { result }),
  };
}

const authorizationOf = (member: TestActor, n: number) => `${member.uri}/feature_authorizations/${n}`;

// The member's server serving the authorization `a` of the collection `uri` (until withdrawn).
function serve(w: World, a: string, uri: string): void {
  w.t.web.serve(a, {
    "@context": FEATURE_CONTEXT,
    id: a,
    type: "FeatureAuthorization",
    interactingObject: uri,
    interactionTarget: w.member.uri,
  });
}

// The member's Delete of `a`, embedding it as Mastodon 4.7.5 writes it (interactingObject the collection
// `uri`, interactionTarget the member).
const deleted = (w: World, a: string, uri: string) => w.t.post(w.member, mastodonFeatureDelete(w.member, a, uri));

// The member's Delete of `a` by its URI alone.
const bareDelete = (member: TestActor, a: string) => ({
  "@context": AS,
  id: `${a}#delete`,
  type: "Delete",
  actor: member.uri,
  object: a,
});

// The authorizations the member retracted (ID-7), its retraction cap's filler left out.
async function retractedBy(w: World): Promise<string[]> {
  const rows = await sql<{ target_uri: string }>(
    w.t.store,
    "SELECT target_uri FROM inbound_retractions WHERE actor_uri = ? ORDER BY target_uri",
    w.member.uri,
  );
  return rows.map((row) => row.target_uri).filter((uri) => !uri.includes("/filler/"));
}

// The member's request lookup (feature-requests.ts ourFeatureRequest) of `request`: the item it finds, and the rows
// its statements read.
async function requestLookup(w: World, request: string): Promise<{ found: string | undefined; rows: number }> {
  return runInDurableObject(w.t.store, (_instance, state) => {
    let rows = 0;
    const real = state.storage.sql;
    const counting = {
      exec: (query: string, ...params: SqlStorageValue[]) => {
        const cursor = real.exec(query, ...params);
        return watchedCursor(cursor, () => (rows += cursor.rowsRead));
      },
    } as unknown as SqlStorage;
    const found = ourFeatureRequest(new Db(counting), { id: w.memberId }, request)?.id;
    return { found, rows };
  });
}

// `count` items holding the activity_uri `request`, as an import may write them: pending items of members known by
// their uri alone, 25 to a remote collection of one remote owner.
async function itemsNaming(w: World, request: string, count: number): Promise<void> {
  const at = new Date(NOW).toISOString();
  await sql(
    w.t.store,
    `INSERT INTO accounts (id, uri, username, domain, inbox_url) VALUES ('660000000000000001',
			'https://decoy.example/users/o', 'o', 'decoy.example', 'https://decoy.example/inbox')`,
  );
  await sql(
    w.t.store,
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
		INSERT INTO collections (id, account_id, local, name, sensitive, discoverable, uri, created_at, updated_at)
		SELECT printf('67%016d', i), '660000000000000001', 0, 'c', 0, 1, 'https://decoy.example/c/' || i, ?2, ?2 FROM n`,
    Math.ceil(count / 25),
    at,
  );
  await sql(
    w.t.store,
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
		INSERT INTO collection_items (id, collection_id, state, position, object_uri, activity_uri, created_at, updated_at)
		SELECT printf('68%016d', i), printf('67%016d', i / 25 + 1), 0, i % 25 + 1, 'https://decoy.example/users/m' || i,
			?2, ?3, ?3 FROM n`,
    count,
    request,
    at,
  );
}

// Check rounds until none is due.
async function checks(w: World): Promise<void> {
  for (let round = 0; round < 4 && (await checkRound(w.t, NOW)); round++) {
    // Another check is due.
  }
}

describe("a remote member's feature request (D23)", () => {
  // 4-T2. Fails if consent is skipped for remote members (the refused account gets a row and a request), if the item is
  // accepted at once (its Add is sent), or if the request goes to the shared inbox.
  it("adds a consenting remote member pending and asks it with a FeatureRequest; refuses one with no policy", async () => {
    const w = await world();
    const { id, uri, item } = await featuring(w);
    expect(item).toMatchObject({ state: PENDING, approval_uri: null });
    expect(item.activity_uri).toMatch(new RegExp(`^${ALICE_URI}/feature_requests/[0-9a-f-]{36}$`));
    const requests = (await sent(w.t)).filter(({ activity }) => activity.type === "FeatureRequest");
    expect(requests).toEqual([
      {
        activity: {
          "@context": [AS, { FeatureRequest: "https://w3id.org/fep/7aa9#FeatureRequest" }],
          id: item.activity_uri,
          type: "FeatureRequest",
          actor: ALICE_URI,
          object: w.member.uri,
          instrument: uri,
        },
        inboxes: [`${w.member.uri}/inbox`],
      },
    ]);
    expect(await itemActivities(w.t, item.id)).toEqual([]);
    expect(await sql(w.t.store, "SELECT 1 FROM notifications")).toEqual([]);
    // A single add asks again, with a request of its own.
    const other = await call(w.t, "POST", "/api/v1/collections", { name: "d", sensitive: false, discoverable: true });
    const otherId = (other.body.collection as { id: string }).id;
    const added = await call(w.t, "POST", `/api/v1/collections/${otherId}/items`, { account_id: w.memberId });
    expect([added.status, (added.body.collection_item as { state: string }).state]).toEqual([200, "pending"]);
    const second = await itemOf(w, otherId);
    expect(second.activity_uri).not.toBe(item.activity_uri);
    expect((await sent(w.t)).filter(({ activity }) => activity.type === "FeatureRequest")).toHaveLength(2);
    // Not shown to anyone but the owner while pending.
    expect(await shownItems(w, id)).toEqual([]);

    // A remote account whose actor states no canFeature: refused, no row, no request.
    const silent = await mastodonActor(w.t.web, "silent");
    const silentId = await followed(w.t, silent);
    const before = (await sent(w.t)).length;
    expect((await call(w.t, "POST", `/api/v1/collections/${id}/items`, { account_id: silentId })).status).toBe(403);
    expect(await sql(w.t.store, "SELECT 1 FROM collection_items WHERE account_id = ?", silentId)).toEqual([]);
    expect((await sent(w.t)).length).toBe(before);
  });

  // 4-T3. Fails if the Accept is not taken as our request's answer (the item stays pending), or the Add is not sent.
  it("accepts the member's Accept with a result on its host and sends the item's Add", async () => {
    const w = await world();
    const { id, uri, item } = await featuring(w);
    const a = authorizationOf(w.member, 1);
    expect(await w.t.post(w.member, answer(w.member, "Accept", item.activity_uri!, a))).toBe(202);
    expect(await itemOf(w, id)).toMatchObject({ state: ACCEPTED, approval_uri: a, retracted_approval_uri: null });
    const add = (await sent(w.t)).find(({ activity }) => activity.type === "Add" && activity.target === uri)!;
    expect(add.activity.object).toEqual({
      id: `${ALICE_URI}/collection_items/${item.id}`,
      type: "FeaturedItem",
      featuredObject: w.member.uri,
      featureAuthorization: a,
      published: expect.any(String),
    });
    expect(add.inboxes).toEqual([`${w.member.uri}/inbox`]);
    expect(await shownItems(w, id)).toEqual([w.memberId]);
  });

  // 4-T4, refusals: each is answered 202, leaves the item pending and sends nothing. Fails if the actor test (another
  // account's Accept), the host test (a result elsewhere) or the result test (none, or one on the member's host that
  // Kopje cannot store: not printable ASCII, or past COLLECTION_URI_BYTES) is removed.
  it("ignores an Accept from another account, with a result on another host or none, or naming no request", async () => {
    const w = await world();
    const { id, item } = await featuring(w);
    const stranger = await mastodonActor(w.t.web, "stranger", { extra: CAN_FEATURE });
    await followed(w.t, stranger);
    const request = item.activity_uri!;
    for (const [sender, body] of [
      [stranger, answer(stranger, "Accept", request, `${stranger.uri}/feature_authorizations/1`)],
      [w.member, answer(w.member, "Accept", request, "https://other.example/feature_authorizations/1")],
      [w.member, answer(w.member, "Accept", request)],
      [w.member, answer(w.member, "Accept", request, `http://mastodon.example/feature_authorizations/1`)],
      [w.member, answer(w.member, "Accept", request, `${w.member.uri}/feature_authorizations/é`)],
      [w.member, answer(w.member, "Accept", request, `${w.member.uri}/feature_authorizations/${"1".repeat(2048)}`)],
      [w.member, answer(w.member, "Accept", `${ALICE_URI}/feature_requests/unknown`, authorizationOf(w.member, 1))],
    ] as const) {
      expect(await w.t.post(sender, body), JSON.stringify(body)).toBe(202);
      expect(await itemOf(w, id), JSON.stringify(body)).toMatchObject({ state: PENDING, approval_uri: null });
    }
    expect(await itemActivities(w.t, item.id)).toEqual([]);
  });

  // 4-T4, late answers: an Accept changes only a pending item. Fails if the pending test is dropped (the rejected item
  // and the revoked one would be accepted, with an Add).
  it("ignores a late Accept after a removal, a Reject or a revocation", async () => {
    const w = await world();
    const removed = await featuring(w);
    expect((await call(w.t, "DELETE", `/api/v1/collections/${removed.id}/items/${removed.item.id}`)).status).toBe(200);
    await w.t.post(w.member, answer(w.member, "Accept", removed.item.activity_uri!, authorizationOf(w.member, 1)));
    expect(await sql(w.t.store, "SELECT 1 FROM collection_items WHERE collection_id = ?", removed.id)).toEqual([]);

    const rejected = await featuring(w);
    await w.t.post(w.member, answer(w.member, "Reject", rejected.item.activity_uri!));
    await w.t.post(w.member, answer(w.member, "Accept", rejected.item.activity_uri!, authorizationOf(w.member, 2)));
    expect(await itemOf(w, rejected.id)).toMatchObject({ state: REJECTED, approval_uri: null });

    const revoked = await featuring(w);
    const b = authorizationOf(w.member, 3);
    await deleted(w, b, revoked.uri);
    await w.t.post(w.member, answer(w.member, "Accept", revoked.item.activity_uri!, b));
    expect(await itemOf(w, revoked.id)).toMatchObject({ state: REVOKED, approval_uri: null });
    await w.t.post(w.member, answer(w.member, "Accept", revoked.item.activity_uri!, authorizationOf(w.member, 4)));
    expect(await itemOf(w, revoked.id)).toMatchObject({ state: REVOKED, approval_uri: null });
    for (const { item } of [removed, rejected, revoked]) {
      expect(await itemActivities(w.t, item.id)).toEqual([]);
    }
  });

  // 4-T4, delayed deletions. A is the authorization of an earlier membership (the member accepted, was removed and
  // added again), withdrawn; B the current request's, which the member withdraws before sending its Delete, and which
  // its server keeps serving from its 30-second public cache (Mastodon 4.7.5's FeatureAuthorizationsController#show,
  // dist/nginx.conf), so a fetch cannot tell B was withdrawn. The messages arrive in each order, and the check rounds
  // run after the last. Each order's end, whether it passed through accepted, the fetches of B, and the Add and Remove
  // it sent. Fails if a Delete acts on the collection and member alone (the Delete(A), Accept(B) orders revoke B), if
  // an Accept after another authorization's deletion is accepted without a check (Delete(A), Accept(B) fetches
  // nothing), if a later deletion replaces the recorded one and the Accept is decided on it alone (Delete(B),
  // Delete(A), Accept(B) accepts B), or if the Accept does not read the member's retraction of B (Delete(A), Delete(B),
  // Accept(B) fetches B, and accepts it with its Add once the check does not read it either).
  it("decides the Accept by the deletions that came before it, in every order", async () => {
    type Step = "Delete(A)" | "Delete(B)" | "Accept(B)";
    const cases: [Step[], { state: number; activities: string[]; fetches: number }][] = [
      [["Delete(B)", "Accept(B)"], { state: REVOKED, activities: [], fetches: 0 }],
      [["Accept(B)", "Delete(B)"], { state: REVOKED, activities: ["Add", "Remove"], fetches: 0 }],
      [["Delete(A)", "Accept(B)"], { state: ACCEPTED, activities: ["Add"], fetches: 1 }],
      [["Accept(B)", "Delete(A)"], { state: ACCEPTED, activities: ["Add"], fetches: 0 }],
      [["Delete(A)", "Delete(B)", "Accept(B)"], { state: REVOKED, activities: [], fetches: 0 }],
      [["Delete(A)", "Accept(B)", "Delete(B)"], { state: REVOKED, activities: [], fetches: 0 }],
      [["Delete(B)", "Delete(A)", "Accept(B)"], { state: REVOKED, activities: [], fetches: 0 }],
      [["Delete(B)", "Accept(B)", "Delete(A)"], { state: REVOKED, activities: [], fetches: 0 }],
      [["Accept(B)", "Delete(A)", "Delete(B)"], { state: REVOKED, activities: ["Add", "Remove"], fetches: 0 }],
      [["Accept(B)", "Delete(B)", "Delete(A)"], { state: REVOKED, activities: ["Add", "Remove"], fetches: 0 }],
    ];
    for (const [order, expected] of cases) {
      const w = await world();
      // The earlier membership: accepted with A, removed, and A withdrawn; then added again.
      const first = await featuring(w);
      const a = authorizationOf(w.member, 1);
      await w.t.post(w.member, answer(w.member, "Accept", first.item.activity_uri!, a));
      expect((await call(w.t, "DELETE", `/api/v1/collections/${first.id}/items/${first.item.id}`)).status).toBe(200);
      const again = await call(w.t, "POST", `/api/v1/collections/${first.id}/items`, { account_id: w.memberId });
      expect(again.status).toBe(200);
      const item = await itemOf(w, first.id);
      const b = authorizationOf(w.member, 2);
      // Served throughout: from the member's server, then from its cache once withdrawn.
      serve(w, b, first.uri);
      const withdrawsB = order.includes("Delete(B)");
      const states: number[] = [];
      for (const step of order) {
        if (step === "Delete(A)") {
          await deleted(w, a, first.uri);
        } else if (step === "Delete(B)") {
          await deleted(w, b, first.uri);
        } else {
          await w.t.post(w.member, answer(w.member, "Accept", item.activity_uri!, b));
        }
        states.push((await itemOf(w, first.id)).state);
      }
      // The check an Accept after another deletion queued, run once every message has arrived.
      await checks(w);
      states.push((await itemOf(w, first.id)).state);
      const label = order.join(", ");
      expect((await itemOf(w, first.id)).state, label).toBe(expected.state);
      expect(await itemActivities(w.t, item.id), label).toEqual(expected.activities);
      expect(w.t.web.fetched.filter((url) => url === b).length, label).toBe(expected.fetches);
      if (withdrawsB && order.at(-1) === "Accept(B)") {
        expect(states, label).not.toContain(ACCEPTED);
      }
      expect(await shownItems(w, first.id), label).toEqual(expected.state === ACCEPTED ? [w.memberId] : []);
    }
  });

  // 4-T4: an Accept naming a result the member already holds as another row's approval_uri, and a second Accept
  // while a check is queued, are ignored, with no error. Fails if the held test is dropped (the constraint refuses the
  // write and the Accept fails) or if a queued check does not fence the Accept (the second replaces the candidate).
  it("ignores an Accept of a result held by another item, and a second Accept while a check is queued", async () => {
    const w = await world();
    const one = await featuring(w);
    const two = await featuring(w);
    const b = authorizationOf(w.member, 1);
    expect(await w.t.post(w.member, answer(w.member, "Accept", one.item.activity_uri!, b))).toBe(202);
    expect(await w.t.post(w.member, answer(w.member, "Accept", two.item.activity_uri!, b))).toBe(202);
    expect([(await itemOf(w, one.id)).state, (await itemOf(w, two.id)).state]).toEqual([ACCEPTED, PENDING]);

    const three = await featuring(w);
    await deleted(w, authorizationOf(w.member, 2), three.uri);
    const c = authorizationOf(w.member, 3);
    await w.t.post(w.member, answer(w.member, "Accept", three.item.activity_uri!, c));
    await w.t.post(w.member, answer(w.member, "Accept", three.item.activity_uri!, authorizationOf(w.member, 4)));
    expect(await itemOf(w, three.id)).toMatchObject({ state: PENDING, candidate_approval_uri: c });
  });
});

describe("a remote member's Reject (D23)", () => {
  // 4-T5. Fails if the Reject is not taken as our request's answer, or from another account.
  it("rejects a pending or accepted item, and nothing from another account", async () => {
    const w = await world();
    const pending = await featuring(w);
    const stranger = await mastodonActor(w.t.web, "stranger", { extra: CAN_FEATURE });
    await followed(w.t, stranger);
    await w.t.post(stranger, answer(stranger, "Reject", pending.item.activity_uri!));
    expect((await itemOf(w, pending.id)).state).toBe(PENDING);
    await w.t.post(w.member, answer(w.member, "Reject", pending.item.activity_uri!));
    expect((await itemOf(w, pending.id)).state).toBe(REJECTED);
    const accepted = await featuring(w);
    await w.t.post(w.member, answer(w.member, "Accept", accepted.item.activity_uri!, authorizationOf(w.member, 9)));
    await w.t.post(w.member, answer(w.member, "Reject", accepted.item.activity_uri!));
    expect((await itemOf(w, accepted.id)).state).toBe(REJECTED);
  });

  // 4-T5: a check of an earlier answer (Delete(A), then Accept(B)) fenced by a Reject before its claim and between its
  // claim and its completion: rejected, its candidate, due time and token cleared, and the completion changes
  // nothing, with no Add. Each fence alone keeps it so: the completion's pending test (with the token kept), and the
  // cleared token (with the pending test removed); with both removed the check accepts the rejected item.
  it("fences a check of the answer it ends, before its claim and between its claim and its completion", async () => {
    for (const when of ["before the claim", "after the claim"] as const) {
      const w = await world();
      const { id, uri, item } = await featuring(w);
      await deleted(w, authorizationOf(w.member, 1), uri);
      const b = authorizationOf(w.member, 2);
      serve(w, b, uri);
      await w.t.post(w.member, answer(w.member, "Accept", item.activity_uri!, b));
      expect((await itemOf(w, id)).candidate_approval_uri).toBe(b);
      const claimed = when === "after the claim" ? (await w.t.store.claimItemChecks(BUILD, { now: NOW })).checks : [];
      expect(claimed.length, when).toBe(when === "after the claim" ? 1 : 0);
      await w.t.post(w.member, answer(w.member, "Reject", item.activity_uri!));
      expect(await itemOf(w, id), when).toMatchObject({
        state: REJECTED,
        candidate_approval_uri: null,
        check_due_at: null,
        check_token: null,
      });
      if (when === "after the claim") {
        const results = claimed.map((check) => ({ item: check.item, token: check.token, outcome: "match" as const }));
        await w.t.store.completeItemChecks(BUILD, { now: NOW, results });
      } else {
        await checks(w);
      }
      expect((await itemOf(w, id)).state, when).toBe(REJECTED);
      expect(await itemActivities(w.t, item.id), when).toEqual([]);
    }
  });
});

describe("a remote member's Delete of its feature authorization (D23)", () => {
  // 4-T6. Fails if the item is not found by its approval_uri (the bare URI) or by its collection and member (the
  // embedded one), or if an accepted item's revocation sends no Remove. The revoking Delete is kept as the member's
  // retraction (ID-7), so an Accept naming the withdrawn authorization after the owner removed the member and added it
  // again revokes the new item. Fails if a revoking Delete is not kept (the new item accepted with A, its Add sent).
  it("revokes the item by its current authorization, embedded or bare, and sends its Remove", async () => {
    for (const form of ["embedded", "bare", "relayed"] as const) {
      const w = await world();
      const { id, uri, item } = await featuring(w);
      const a = authorizationOf(w.member, 1);
      await w.t.post(w.member, answer(w.member, "Accept", item.activity_uri!, a));
      if (form === "embedded") {
        await deleted(w, a, uri);
      } else if (form === "bare") {
        await w.t.post(w.member, { "@context": AS, id: `${a}#delete`, type: "Delete", actor: w.member.uri, object: a });
      } else {
        // Relayed by another server with the member's proof, applied as the member's own.
        const relay = await mastodonActor(w.t.web, "relay", { origin: "https://relay.example" });
        await followed(w.t, relay);
        const at = { created: signTime(NOW), expires: signTime(NOW + 86_400_000) };
        await w.t.post(relay, await mastodon47Signed(mastodonFeatureDelete(w.member, a, uri), w.member, at));
      }
      expect((await itemOf(w, id)).state, form).toBe(REVOKED);
      const activities = (await sent(w.t)).filter(({ activity }) => activity.target === uri);
      expect(
        activities.map(({ activity }) => activity.type),
        form,
      ).toEqual(["Add", "Remove"]);
      expect(activities.at(-1)!.activity.object, form).toBe(`${ALICE_URI}/collection_items/${item.id}`);
      expect(await retractedBy(w), form).toEqual([a]);
      expect((await call(w.t, "DELETE", `/api/v1/collections/${id}/items/${item.id}`)).status, form).toBe(200);
      expect((await call(w.t, "POST", `/api/v1/collections/${id}/items`, { account_id: w.memberId })).status).toBe(200);
      const again = await itemOf(w, id);
      expect(await w.t.post(w.member, answer(w.member, "Accept", again.activity_uri!, a))).toBe(202);
      expect(await itemOf(w, id), form).toMatchObject({ state: REVOKED, approval_uri: null });
      expect(await itemActivities(w.t, again.id), form).toEqual([]);
    }
  });

  // At MAX_RETRACTIONS_PER_ACTOR a Delete that revokes an item cannot be kept as the member's retraction: the item is
  // revoked and its Remove sent all the same (threat model, Accepted risks). Fails if the revocation waits on the
  // retraction (the Remove not sent).
  it("revokes an accepted item at the member's retraction cap, keeping no retraction", async () => {
    const w = await world();
    const { id, uri, item } = await featuring(w);
    const a = authorizationOf(w.member, 1);
    await w.t.post(w.member, answer(w.member, "Accept", item.activity_uri!, a));
    await retractionsAtCap(w.t, w.member);
    expect(await deleted(w, a, uri)).toBe(202);
    expect((await itemOf(w, id)).state).toBe(REVOKED);
    expect(await retractedBy(w)).toEqual([]);
    expect(await itemActivities(w.t, item.id)).toEqual(["Add", "Remove"]);
  });

  // 4-T6, refusals. Fails if the embedded match drops the actor test (the member's Delete naming another target would
  // be recorded against its pending item), or if a Delete revokes by collection and member alone (another URI would
  // revoke the accepted item).
  it("changes nothing for another account, another URI, another target or another host", async () => {
    const w = await world();
    const accepted = await featuring(w);
    const a = authorizationOf(w.member, 1);
    await w.t.post(w.member, answer(w.member, "Accept", accepted.item.activity_uri!, a));
    const pending = await featuring(w);
    const neighbour = await mastodonActor(w.t.web, "neighbour");
    await followed(w.t, neighbour);
    // Another account of the member's host deleting the member's authorization, embedded.
    await w.t.post(neighbour, { ...mastodonFeatureDelete(w.member, a, accepted.uri), actor: neighbour.uri });
    // Another authorization of the member, of the accepted item's collection.
    await deleted(w, authorizationOf(w.member, 2), accepted.uri);
    // An authorization naming another target, of the pending item's collection.
    const other = mastodonFeatureDelete(w.member, authorizationOf(w.member, 3), pending.uri);
    await w.t.post(w.member, { ...other, object: { ...(other.object as object), interactionTarget: neighbour.uri } });
    // An authorization on another host.
    await w.t.post(
      w.member,
      mastodonFeatureDelete(w.member, "https://other.example/feature_authorizations/4", pending.uri),
    );
    expect(await itemOf(w, accepted.id)).toMatchObject({ state: ACCEPTED, approval_uri: a });
    expect(await itemOf(w, pending.id)).toMatchObject({ state: PENDING, retracted_approval_uri: null });
    expect(await itemActivities(w.t, accepted.item.id)).toEqual(["Add"]);
  });

  // D23: the first deletion before the member's answer is recorded on the item and as the member's retraction, a later
  // one as the member's retraction (ID-7). The retraction outlives the row: after the owner removes the item and adds
  // the member again, an Accept naming the first authorization ends the new item revoked. Fails if a later deletion
  // replaces the recorded one, or if the first is kept on the row alone (the new item accepted with A, its Add sent).
  it("records the first deletion of a pending item's authorization on the item, and a later one as a retraction", async () => {
    const w = await world();
    const { id, uri, item } = await featuring(w);
    const a = authorizationOf(w.member, 1);
    await deleted(w, a, uri);
    await deleted(w, authorizationOf(w.member, 2), uri);
    expect((await itemOf(w, id)).retracted_approval_uri).toBe(a);
    expect(await retractedBy(w)).toEqual([a, authorizationOf(w.member, 2)]);
    expect((await call(w.t, "DELETE", `/api/v1/collections/${id}/items/${item.id}`)).status).toBe(200);
    expect((await call(w.t, "POST", `/api/v1/collections/${id}/items`, { account_id: w.memberId })).status).toBe(200);
    const again = await itemOf(w, id);
    serve(w, a, uri);
    expect(await w.t.post(w.member, answer(w.member, "Accept", again.activity_uri!, a))).toBe(202);
    await checks(w);
    expect(await itemOf(w, id)).toMatchObject({ state: REVOKED, approval_uri: null });
    expect(await itemActivities(w.t, again.id)).toEqual([]);
  });

  // A Delete that reaches no item (by its bare URI, which names no accepted authorization) is kept as the member's
  // retraction, which the Accept naming it and the check of it read: the Accept ends the item revoked without a fetch,
  // and a check queued before the Delete ends it revoked though the member's cache still serves the authorization.
  // Once the retraction expired, an Accept applies. Fails if the Accept does not read the retraction (R accepted, its
  // Add sent), if the check's completion does not (B accepted, its Add sent), or if the Accept reads an expired
  // retraction (S revoked).
  it("revokes at an Accept or a check of an authorization whose bare Delete came before it", async () => {
    const before = await world();
    const first = await featuring(before);
    const r = authorizationOf(before.member, 1);
    serve(before, r, first.uri);
    expect(await before.t.post(before.member, bareDelete(before.member, r))).toBe(202);
    expect(await itemOf(before, first.id)).toMatchObject({ state: PENDING, retracted_approval_uri: null });
    expect(await retractedBy(before)).toEqual([r]);
    await before.t.post(before.member, answer(before.member, "Accept", first.item.activity_uri!, r));
    await checks(before);
    expect(await itemOf(before, first.id)).toMatchObject({ state: REVOKED, approval_uri: null });
    expect(await itemActivities(before.t, first.item.id)).toEqual([]);
    expect(before.t.web.fetched.filter((url) => url === r)).toEqual([]);
    // A retraction that expired (ID-7's 30 days) no longer decides the Accept, which applies as on Mastodon; the
    // Accept's own sweep takes SWEEP_BATCH older expired retractions first, so S's is still stored when it is read.
    const lapsed = await featuring(before);
    const s = authorizationOf(before.member, 2);
    await before.t.post(before.member, bareDelete(before.member, s));
    await sql(before.t.store, "UPDATE inbound_retractions SET expires_at = ? WHERE target_uri = ?", NOW, s);
    await sql(
      before.t.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO inbound_retractions (actor_uri, target_uri, expires_at) SELECT ?2, ?2 || '/old/' || i, ?3 FROM n`,
      SWEEP_BATCH,
      "https://elsewhere.example/users/x",
      NOW - 1,
    );
    await before.t.post(before.member, answer(before.member, "Accept", lapsed.item.activity_uri!, s));
    expect(await sql(before.t.store, "SELECT 1 FROM inbound_retractions WHERE target_uri = ?", s)).toHaveLength(1);
    expect(await itemOf(before, lapsed.id)).toMatchObject({ state: ACCEPTED, approval_uri: s });

    const meanwhile = await world();
    const second = await featuring(meanwhile);
    await deleted(meanwhile, authorizationOf(meanwhile.member, 1), second.uri);
    const b = authorizationOf(meanwhile.member, 2);
    serve(meanwhile, b, second.uri);
    await meanwhile.t.post(meanwhile.member, answer(meanwhile.member, "Accept", second.item.activity_uri!, b));
    expect(await meanwhile.t.post(meanwhile.member, bareDelete(meanwhile.member, b))).toBe(202);
    // The bare Delete names no accepted authorization: the item still awaits the check of B.
    expect(await itemOf(meanwhile, second.id)).toMatchObject({ state: PENDING, candidate_approval_uri: b });
    await checks(meanwhile);
    expect(meanwhile.t.web.fetched.filter((url) => url === b)).toEqual([b]);
    expect(await itemOf(meanwhile, second.id)).toMatchObject({
      state: REVOKED,
      approval_uri: null,
      check_due_at: null,
    });
    expect(await itemActivities(meanwhile.t, second.item.id)).toEqual([]);
  });

  // At MAX_RETRACTIONS_PER_ACTOR a later deletion cannot be kept as a retraction, so the pending item ends revoked: its
  // Accept, and a check, would otherwise accept an authorization the member withdrew. Fails if the item stays pending
  // at the cap (B, served from the cache, accepted with its Add).
  it("ends a pending item revoked at a later deletion it cannot keep, at the member's retraction cap", async () => {
    const w = await world();
    const { id, uri, item } = await featuring(w);
    await retractionsAtCap(w.t, w.member);
    await deleted(w, authorizationOf(w.member, 1), uri);
    expect(await itemOf(w, id)).toMatchObject({ state: PENDING, retracted_approval_uri: authorizationOf(w.member, 1) });
    const b = authorizationOf(w.member, 2);
    serve(w, b, uri);
    await deleted(w, b, uri);
    expect(await itemOf(w, id)).toMatchObject({ state: REVOKED, retracted_approval_uri: null });
    expect(await retractedBy(w)).toEqual([]);
    await w.t.post(w.member, answer(w.member, "Accept", item.activity_uri!, b));
    await checks(w);
    expect(await itemOf(w, id)).toMatchObject({ state: REVOKED, approval_uri: null });
    expect(await itemActivities(w.t, item.id)).toEqual([]);
  });
});

describe("the request an answer names (D23)", () => {
  // collection_items_activity is not unique: an import can give items of any collection the activity_uri of Kopje's
  // request. The lookup reads at most two rows holding the id however many hold it (a witness growing under the same
  // key, which the plan audit cannot see: 2 rows read for Kopje's item alone, at most 4 beside 1,000 others), and an id
  // more than one row holds answers no request. Fails if the lookup reads every row holding the id (2,002 rows), or if
  // it takes Kopje's item among several (the Accept accepts it).
  it("reads at most two rows holding a request's id, and answers none that several rows hold", async () => {
    const w = await world();
    const { id, item } = await featuring(w);
    const request = item.activity_uri!;
    const alone = await requestLookup(w, request);
    expect(alone.found).toBe(item.id);
    // Statistics taken before the rows grow (stale at the lookup).
    await sql(w.t.store, "ANALYZE");
    await itemsNaming(w, request, 1000);
    expect(await sql(w.t.store, "SELECT 1 FROM collection_items WHERE activity_uri = ?", request)).toHaveLength(1001);
    const crowded = await requestLookup(w, request);
    expect(crowded.found).toBeUndefined();
    expect(crowded.rows).toBeLessThanOrEqual(2 * alone.rows);
    expect(await w.t.post(w.member, answer(w.member, "Accept", request, authorizationOf(w.member, 1)))).toBe(202);
    expect(await itemOf(w, id)).toMatchObject({ state: PENDING, approval_uri: null });
    expect(await itemActivities(w.t, item.id)).toEqual([]);
  });
});

describe("a pending remote member's removal (D23)", () => {
  // The owner removing a pending remote item, directly or by blocking its member, sends nothing for it: no Add ever
  // named it. Fails if the Remove is sent whatever the item's state (ANNOUNCED_SQL).
  it("sends no Remove for an item never announced, and one for an accepted item", async () => {
    const w = await world();
    const pending = await featuring(w);
    expect((await call(w.t, "DELETE", `/api/v1/collections/${pending.id}/items/${pending.item.id}`)).status).toBe(200);
    const blocked = await featuring(w);
    const accepted = await featuring(w);
    await w.t.post(w.member, answer(w.member, "Accept", accepted.item.activity_uri!, authorizationOf(w.member, 1)));
    expect((await call(w.t, "POST", `/api/v1/accounts/${w.memberId}/block`)).status).toBe(200);
    expect(await sql(w.t.store, "SELECT 1 FROM collection_items WHERE account_id = ?", w.memberId)).toEqual([]);
    expect(await itemActivities(w.t, pending.item.id)).toEqual([]);
    expect(await itemActivities(w.t, blocked.item.id)).toEqual([]);
    expect(await itemActivities(w.t, accepted.item.id)).toEqual(["Add", "Remove"]);
  });
});
