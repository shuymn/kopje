import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { ourFeatureRequest } from "../src/domain/feature-requests";
import { settleDeliveries, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { mastodon47Signed, mastodonFeatureDelete, signTime } from "./author-proof-helpers";
import { checkRound, FEATURE_CONTEXT } from "./featured-collection-helpers";
import { BUILD } from "./helpers";
import { mastodonActor, type TestActor } from "./inbox-helpers";
import { ALICE_URI, AS, followed, PUBLIC, setup, type Setup } from "./inbox-status-helpers";
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

const withdraw = (w: World, a: string) => w.t.web.served.delete(a);

// The member's Delete of `a`, embedding it as Mastodon 4.7.5 writes it (interactingObject the collection
// `uri`, interactionTarget the member).
const deleted = (w: World, a: string, uri: string) => w.t.post(w.member, mastodonFeatureDelete(w.member, a, uri));

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
  // added again), withdrawn; B the current request's, served until the member withdraws it, which it does before
  // sending its Delete. The messages arrive in each order, and the check rounds run after the last. Each order's end,
  // whether it passed through accepted, the fetches of B, and the Add and Remove it sent. Fails if
  // a Delete acts on the collection and member alone (the Delete(A), Accept(B) orders revoke B), if an Accept after
  // another authorization's deletion is accepted without a check (Delete(A), Delete(B), Accept(B) accepts B), or if a
  // later deletion replaces the recorded one and the Accept is decided on it alone (Delete(B), Delete(A), Accept(B)
  // accepts B).
  it("decides the Accept by the deletions that came before it, in every order", async () => {
    type Step = "Delete(A)" | "Delete(B)" | "Accept(B)";
    const cases: [Step[], { state: number; activities: string[]; fetches: number }][] = [
      [["Delete(B)", "Accept(B)"], { state: REVOKED, activities: [], fetches: 0 }],
      [["Accept(B)", "Delete(B)"], { state: REVOKED, activities: ["Add", "Remove"], fetches: 0 }],
      [["Delete(A)", "Accept(B)"], { state: ACCEPTED, activities: ["Add"], fetches: 1 }],
      [["Accept(B)", "Delete(A)"], { state: ACCEPTED, activities: ["Add"], fetches: 0 }],
      [["Delete(A)", "Delete(B)", "Accept(B)"], { state: REVOKED, activities: [], fetches: 1 }],
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
      serve(w, b, first.uri);
      const withdrawsB = order.includes("Delete(B)");
      const states: number[] = [];
      for (const step of order) {
        if (step === "Delete(A)") {
          await deleted(w, a, first.uri);
        } else if (step === "Delete(B)") {
          withdraw(w, b);
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
  // embedded one), or if an accepted item's revocation sends no Remove.
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
    }
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

  // D23: the first deletion before the member's answer is recorded; a later one changes nothing. Fails if a later
  // deletion replaces the recorded one.
  it("records the first deletion of a pending item's authorization, and only the first", async () => {
    const w = await world();
    const { id, uri } = await featuring(w);
    await deleted(w, authorizationOf(w.member, 1), uri);
    await deleted(w, authorizationOf(w.member, 2), uri);
    expect((await itemOf(w, id)).retracted_approval_uri).toBe(authorizationOf(w.member, 1));
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
