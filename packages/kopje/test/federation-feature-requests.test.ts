import { type DocumentLoader, verifyJsonLd } from "@fedify/fedify";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { type DeliveryOutcome, LEASE_MS, MAX_BACKLOG, MAX_LANE_BACKLOG } from "../src/domain/deliveries";
import { ourFeatureRequest } from "../src/domain/feature-requests";
import { SWEEP_BATCH } from "../src/domain/remote-actors";
import { parseActivity } from "../src/federation/inbound";
import { handleQueue, jobsRound } from "../src/jobs/queue";
import { MAX_STORED_COLLECTIONS } from "../src/platform/stored-bounds";
import { settleDeliveries, sql } from "./api-helpers";
import { harness, inboxDeps, NOW } from "./app-helpers";
import { mastodon47Signed, mastodonFeatureDelete, signTime } from "./author-proof-helpers";
import {
  checkRound,
  collection,
  COLLECTIONS_ONLY,
  FEATURE_CONTEXT,
  featuredOwner,
  featureRequest,
  item as remoteItem,
  localItem,
  localRows,
  outbound,
  requestSync,
  serveListing,
  storedMember,
  storedOwner,
  syncAll,
} from "./featured-collection-helpers";
import { fixtureKeyGen } from "./federation-helpers";
import { BUILD } from "./helpers";
import { MASTODON, mastodonActor, signedInit, type TestActor } from "./inbox-helpers";
import {
  ALICE,
  ALICE_URI,
  AS,
  DAVE,
  followed,
  OTHER,
  PUBLIC,
  retractionsAtCap,
  setup,
  type Setup,
} from "./inbox-status-helpers";
import { storeReceive } from "./inbox-store-helpers";
import { contexts } from "./quote-helpers";
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

    // One whose policy answers unknown (Mastodon's featureable_by? takes only automatic and manual): values that are
    // not strings past a followers collection Kopje cannot read add unsupported_policy alone (#1772). Refused the same
    // way. Fails if unknown is taken as consent (a pending row and a request).
    const unknown = await mastodonActor(w.t.web, "unknownpolicy", {
      extra: {
        followers: "https://mastodon.example/users/unknownpolicy/followers�",
        interactionPolicy: { canFeature: { automaticApproval: [7], manualApproval: [{ id: PUBLIC }] } },
      },
    });
    const unknownId = await followed(w.t, unknown);
    expect(await sql(w.t.store, "SELECT feature_policy AS p FROM accounts WHERE id = ?", unknownId)).toEqual([
      { p: (1 << 16) | 1 },
    ]);
    const shown = await call(w.t, "GET", `/api/v1/accounts/${unknownId}`);
    expect((shown.body.feature_approval as { current_user: string }).current_user).toBe("unknown");
    const beforeUnknown = (await sent(w.t)).length;
    expect((await call(w.t, "POST", `/api/v1/collections/${id}/items`, { account_id: unknownId })).status).toBe(403);
    expect(await sql(w.t.store, "SELECT 1 FROM collection_items WHERE account_id = ?", unknownId)).toEqual([]);
    expect((await sent(w.t)).length).toBe(beforeUnknown);
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

// ---- Local accounts in remote collections (#1589's D24, PR 6: 6-T1 to 6-T4, 6-T6, 6-T9).

type Owned = { t: Setup; owner: TestActor & { featuredCollections: string }; listed: ReturnType<typeof collection> };

let owners = 0;

// A remote Mastodon owner and one collection of its holding `items` (served at its id and listed), alice discoverable
// so the owner may feature her (R45).
async function owned(items: unknown[] = []): Promise<Owned> {
  const t = await setup();
  await sql(t.store, "UPDATE accounts SET discoverable = 1 WHERE id = ?", ALICE);
  const owner = await featuredOwner(t.web, `owner${++owners}`, COLLECTIONS_ONLY);
  const listed = collection(owner, items);
  serveListing(t.web, owner, listed);
  return { t, owner, listed };
}

const requestFor = (w: Owned, id?: string) => featureRequest(w.owner, ALICE_URI, w.listed.id, id);
const authorization = (row: string) => `${ALICE_URI}/feature_authorizations/${row}`;

// alice's answers (her Accepts, Rejects and Deletes), in record order.
async function aliceAnswers(t: Setup) {
  return (await outbound(t, ALICE)).filter(({ activity }) =>
    ["Accept", "Reject", "Delete"].includes(String(activity.type)),
  );
}

// The status of a fetch of alice's authorization document for the row `row`.
async function authorizationStatus(t: Setup, row: string): Promise<number> {
  const response = await t.request(`/ap/users/alice/feature_authorizations/${row}`, {
    headers: { accept: "application/activity+json" },
  });
  await response.arrayBuffer();
  return response.status;
}

async function revokeAs(t: Setup, collectionId: string, row: string): Promise<number> {
  return (await call(t, "POST", `/api/v1/collections/${collectionId}/items/${row}/revoke`)).status;
}

async function collectionIdOf(t: Setup, uri: string): Promise<string> {
  return (await sql<{ id: string }>(t.store, "SELECT id FROM collections WHERE uri = ?", uri))[0]!.id;
}

// The owner's Add (or Remove) of an item naming alice with the authorization `a`, as Mastodon 4.7.5 sends it (no id).
function itemActivity(w: Owned, type: "Add" | "Remove", entry: unknown) {
  return {
    "@context": [...FEATURE_CONTEXT, { FeaturedItem: "https://w3id.org/fep/7aa9#FeaturedItem" }],
    type,
    actor: w.owner.uri,
    target: w.listed.id,
    object: entry,
  };
}

const notifications = (t: Setup) =>
  sql<{ type: string }>(t.store, "SELECT type FROM notifications WHERE account_id = ? ORDER BY id", ALICE);

describe("a remote owner's feature request for a local account (D24)", () => {
  // 6-T1. Fails if an answer names the row's stored request instead of the one answered (the owner ignores it), if a
  // request for an accepted row is decided by the member's policy (a Reject would end the owner's live item,
  // reject.rb:41-46; Mastodon re-checks its policy, feature_request.rb:14-18), if the row is queued for a check, or if
  // a replay after the revoke is accepted.
  it("answers each request by the row's state, naming the request it answers, an accepted row with no policy check", async () => {
    const w = await owned();
    const r1 = requestFor(w);
    expect(await w.t.post(w.owner, r1)).toBe(202);
    const [row] = await localRows(w.t, ALICE);
    const a = authorization(row!.id);
    // Answers are ordinary deliveries: no check, no wait.
    expect(row).toMatchObject({
      state: ACCEPTED,
      activity_uri: r1.id,
      uri: null,
      candidate_approval_uri: null,
      answer: null,
      check_due_at: null,
      check_token: null,
    });
    const accept = (request: string) => ({
      "@context": AS,
      id: `${ALICE_URI}#accepts/feature_requests/${row!.id}`,
      type: "Accept",
      actor: ALICE_URI,
      to: w.owner.uri,
      object: request,
      result: a,
    });
    let sentAnswers = await aliceAnswers(w.t);
    expect(sentAnswers.map(({ activity, deliveries }) => [activity, deliveries.map((d) => d.inbox)])).toEqual([
      [accept(r1.id), [`${w.owner.uri}/inbox`]],
    ]);
    expect(await notifications(w.t)).toEqual([{ type: "added_to_collection" }]);
    expect(await authorizationStatus(w.t, row!.id)).toBe(200);

    // A repeat of the same request: the same Accept, one row, one notification.
    expect(await w.t.post(w.owner, r1)).toBe(202);
    sentAnswers = await aliceAnswers(w.t);
    expect(sentAnswers.map(({ activity }) => activity)).toEqual([accept(r1.id), accept(r1.id)]);
    expect(await localRows(w.t, ALICE)).toMatchObject([{ id: row!.id, activity_uri: r1.id }]);
    expect(await notifications(w.t)).toHaveLength(1);

    // Another request while accepted: an Accept naming it with the same authorization, the row's request replaced and
    // its uri cleared.
    await sql(
      w.t.store,
      "UPDATE collection_items SET uri = ? WHERE id = ?",
      `${w.owner.uri}/collection_items/1`,
      row!.id,
    );
    const r2 = requestFor(w);
    expect(await w.t.post(w.owner, r2)).toBe(202);
    sentAnswers = await aliceAnswers(w.t);
    expect(sentAnswers.at(-1)!.activity).toEqual(accept(r2.id));
    expect(await localRows(w.t, ALICE)).toMatchObject([
      { id: row!.id, state: ACCEPTED, activity_uri: r2.id, uri: null },
    ]);
    expect(await notifications(w.t)).toHaveLength(1);

    // Consent withdrawn: the accepted row is the consent, so another request is accepted all the same.
    await sql(w.t.store, "UPDATE accounts SET discoverable = 0 WHERE id = ?", ALICE);
    const r3 = requestFor(w);
    expect(await w.t.post(w.owner, r3)).toBe(202);
    sentAnswers = await aliceAnswers(w.t);
    expect(sentAnswers.at(-1)!.activity).toEqual(accept(r3.id));
    expect(await localRows(w.t, ALICE)).toMatchObject([{ id: row!.id, state: ACCEPTED, activity_uri: r3.id }]);
    expect(await authorizationStatus(w.t, row!.id)).toBe(200);

    // After the member revoked (the row kept 24 hours), a delayed request is refused and the authorization stays gone.
    await sql(w.t.store, "UPDATE accounts SET discoverable = 1 WHERE id = ?", ALICE);
    expect(await revokeAs(w.t, await collectionIdOf(w.t, w.listed.id), row!.id)).toBe(200);
    expect(await authorizationStatus(w.t, row!.id)).toBe(404);
    const r4 = requestFor(w);
    expect(await w.t.post(w.owner, r4)).toBe(202);
    expect((await aliceAnswers(w.t)).at(-1)!.activity).toMatchObject({ type: "Reject", object: r4.id });
    expect(await localRows(w.t, ALICE)).toMatchObject([{ id: row!.id, state: REVOKED, activity_uri: r3.id }]);
    expect(await authorizationStatus(w.t, row!.id)).toBe(404);

    // Once the cleanup deleted the retired row, a request is decided again.
    await sql(w.t.store, "DELETE FROM collection_items WHERE id = ?", row!.id);
    const r5 = requestFor(w);
    expect(await w.t.post(w.owner, r5)).toBe(202);
    expect(await localRows(w.t, ALICE)).toMatchObject([{ state: ACCEPTED, activity_uri: r5.id }]);
  });

  // R45 for a remote collection (#1589's D24): a local member's accepted row is shown to its member at once, and to
  // anyone else only once the owner lists it. Fails without audience.ts collectionItemShownSql's listing arm (dave and
  // an anonymous viewer see alice unlisted) or its member arm (alice cannot find the row she revokes).
  it("shows an unlisted row to its member alone, and to everyone once the owner lists it", async () => {
    const w = await owned();
    expect(await w.t.post(w.owner, requestFor(w))).toBe(202);
    const [row] = await localRows(w.t, ALICE);
    const id = await collectionIdOf(w.t, w.listed.id);
    type Shown = { collection: { item_count: number; items: { account_id?: string }[] } };
    const seen = async (as: "alice" | "dave" | null) => {
      const shown = await w.t.api<Shown>(`/api/v1/collections/${id}`, as);
      expect(shown.status).toBe(200);
      return [shown.body.collection.item_count, shown.body.collection.items.map((item) => item.account_id)];
    };
    expect(await seen("alice")).toEqual([1, [ALICE]]);
    expect(await seen("dave")).toEqual([0, []]);
    expect(await seen(null)).toEqual([0, []]);
    // The collection alice's added_to_collection notification presents holds her row too.
    const notified =
      await w.t.api<{ type: string; collection?: { items: { account_id?: string }[] } }[]>("/api/v1/notifications");
    expect(
      notified.body
        .filter((n) => n.type === "added_to_collection")
        .map((n) => n.collection?.items.map((i) => i.account_id)),
    ).toEqual([[ALICE]]);
    expect(
      (
        await w.t.api<{ collections: { id: string }[] }>(`/api/v1/accounts/${ALICE}/in_collections`)
      ).body.collections.map((c) => c.id),
    ).toEqual([id]);
    // Listed by the owner's Add: shown to everyone.
    const listed = localItem(w.owner, ALICE_URI, authorization(row!.id));
    expect(await w.t.post(w.owner, itemActivity(w, "Add", listed))).toBe(202);
    expect(await seen("dave")).toEqual([1, [ALICE]]);
    expect(await seen(null)).toEqual([1, [ALICE]]);
  });

  // 6-T2. Each fails if its test is removed: a refused account gets a row or an Accept; a foreign id is answered; a
  // foreign instrument is fetched; a collection attributed to another actor is applied as the actor's.
  it("refuses a request by consent, and ignores a foreign id or an instrument not the actor's", async () => {
    const w = await owned();
    await sql(w.t.store, "UPDATE accounts SET discoverable = 0 WHERE id = ?", ALICE);
    const refused = requestFor(w);
    expect(await w.t.post(w.owner, refused)).toBe(202);
    expect(await localRows(w.t, ALICE)).toEqual([]);
    expect(
      (await aliceAnswers(w.t)).map(({ activity }) => [activity.type, activity.object, "result" in activity]),
    ).toEqual([["Reject", refused.id, false]]);
    await sql(w.t.store, "UPDATE accounts SET discoverable = 1 WHERE id = ?", ALICE);
    const before = (await aliceAnswers(w.t)).length;

    // An id on another host.
    expect(await w.t.post(w.owner, requestFor(w, `${OTHER}/requests/1`))).toBe(202);
    // An instrument on another host: never fetched.
    const foreign = `${OTHER}/collections/1`;
    w.t.web.serve(foreign, { ...collection(w.owner, []), id: foreign, "@context": AS });
    expect(await w.t.post(w.owner, featureRequest(w.owner, ALICE_URI, foreign))).toBe(202);
    expect(w.t.web.fetched).not.toContain(foreign);
    // A collection on the actor's host attributed to another actor.
    const someone = await mastodonActor(w.t.web, `someone${owners}`);
    const theirs = collection(someone, []);
    w.t.web.serve(theirs.id, { "@context": AS, ...theirs });
    expect(await w.t.post(w.owner, featureRequest(w.owner, ALICE_URI, theirs.id))).toBe(202);
    expect(w.t.web.fetched).toContain(theirs.id);
    // An object that is no local account.
    expect(await w.t.post(w.owner, featureRequest(w.owner, `${ALICE_URI}x`, w.listed.id))).toBe(202);

    expect(await localRows(w.t, ALICE)).toEqual([]);
    expect(await aliceAnswers(w.t)).toHaveLength(before);
    // The owner's own collection, which its first request fetched (as Mastodon stores it before deciding), alone.
    expect(await sql(w.t.store, "SELECT uri FROM collections WHERE local = 0")).toEqual([{ uri: w.listed.id }]);
  });

  // 6-T3. Fails if the revoke's Delete is not LD-signed by the member's key, misses the owner or the member's
  // followers, or the authorization is still served.
  it("revokes with the member's LD-signed Delete to the owner and the member's followers", async () => {
    const w = await owned();
    const fan = await mastodonActor(w.t.web, "fan", { origin: OTHER });
    await followed(w.t, fan, DAVE);
    expect(await w.t.post(w.owner, requestFor(w))).toBe(202);
    const [row] = await localRows(w.t, ALICE);
    const a = authorization(row!.id);
    expect(await revokeAs(w.t, await collectionIdOf(w.t, w.listed.id), row!.id)).toBe(200);
    expect(await localRows(w.t, ALICE)).toMatchObject([{ id: row!.id, state: REVOKED }]);
    const deletes = (await aliceAnswers(w.t)).filter(({ activity }) => activity.type === "Delete");
    expect(deletes).toHaveLength(1);
    const { signature, ...unsigned } = deletes[0]!.activity;
    expect(unsigned).toEqual({
      "@context": [...FEATURE_CONTEXT, "https://w3id.org/security/v1"],
      id: `${a}#delete`,
      type: "Delete",
      actor: ALICE_URI,
      to: [PUBLIC],
      object: { id: a, type: "FeatureAuthorization", interactingObject: w.listed.id, interactionTarget: ALICE_URI },
    });
    expect(signature).toMatchObject({ type: "RsaSignature2017", creator: `${ALICE_URI}#main-key` });
    // The signature verifies against alice's key as her actor document serves it.
    const actor = await (
      await w.t.request("/ap/users/alice", { headers: { accept: "application/activity+json" } })
    ).json<Record<string, unknown>>();
    const documentLoader: DocumentLoader = (url) =>
      url.split("#")[0] === ALICE_URI
        ? Promise.resolve({ document: actor, documentUrl: ALICE_URI, contextUrl: null })
        : contexts(url);
    expect(await verifyJsonLd(deletes[0]!.activity, { documentLoader, contextLoader: contexts })).toBe(true);
    expect(deletes[0]!.deliveries.map((d) => d.inbox).toSorted()).toEqual([`${w.owner.uri}/inbox`, `${OTHER}/inbox`]);
    expect(await authorizationStatus(w.t, row!.id)).toBe(404);
  });

  // 6-T4. Fails if verification runs inline (the remote member's authorization is fetched within the request) or the
  // request asks for a sync.
  it("fetches the instrument once and applies it, its remote members' items queued for their checks", async () => {
    const w = await owned();
    const member = await storedMember(w.t, "rm", OTHER);
    const entry = remoteItem(w.owner, member);
    w.listed.orderedItems = [entry];
    serveListing(w.t.web, w.owner, w.listed);
    // The owner stored, its collections read before the request (none listed then).
    serveCollectionsEmpty(w);
    await followed(w.t, w.owner);
    await syncAll(w.t);
    serveListing(w.t.web, w.owner, w.listed);
    const from = w.t.web.fetched.length;
    expect(await w.t.post(w.owner, requestFor(w))).toBe(202);
    expect(w.t.web.fetched.slice(from).filter((url) => url === w.listed.id)).toHaveLength(1);
    expect(w.t.web.fetched).not.toContain(entry.featureAuthorization);
    expect(await sql(w.t.store, "SELECT account_id FROM collection_syncs")).toEqual([]);
    const stored = await sql<{ account_id: string | null; state: number; check_due_at: number | null }>(
      w.t.store,
      "SELECT account_id, state, check_due_at FROM collection_items ORDER BY position",
    );
    expect(stored).toEqual([
      { account_id: expect.any(String), state: PENDING, check_due_at: NOW },
      { account_id: ALICE, state: ACCEPTED, check_due_at: null },
    ]);
  });

  // Fails if a fetched instrument is applied over the collection Kopje came to store while it was fetched (the stored
  // one decides, as it is): the fetched listing's member and name would replace the stored ones.
  it("leaves a collection stored while its instrument was fetched as it is, the fetched listing unused", async () => {
    const w = await owned();
    const fetchedMember = await storedMember(w.t, "fm", OTHER);
    const storedMemberRow = await storedMember(w.t, "sm", OTHER);
    // The instrument as the owner serves it when the fetch arrives: another member and another name.
    w.listed.orderedItems = [remoteItem(w.owner, fetchedMember)];
    w.listed.totalItems = 1;
    const fetchedDocument = { ...w.listed, name: "fetched" };
    serveListing(w.t.web, w.owner, fetchedDocument);
    await followed(w.t, w.owner);
    const held = w.t.web.hold(w.listed.id, { snapshot: true });
    const request = requestFor(w);
    const posting = w.t.post(w.owner, request);
    await held.reached;
    // Meanwhile the owner's Add of the collection, as it is now, is stored.
    const pushed = { ...w.listed, name: "stored", orderedItems: [remoteItem(w.owner, storedMemberRow)] };
    expect(
      await w.t.post(w.owner, {
        "@context": AS,
        type: "Add",
        actor: w.owner.uri,
        target: w.owner.featuredCollections,
        object: pushed,
      }),
    ).toBe(202);
    held.release();
    expect(await posting).toBe(202);
    expect(await sql(w.t.store, "SELECT name FROM collections WHERE uri = ?", w.listed.id)).toEqual([
      { name: "stored" },
    ]);
    // The stored member's item and alice's accepted row; nothing of the fetched member's.
    expect(
      await sql(
        w.t.store,
        `SELECT a.uri, i.state FROM collection_items i JOIN accounts a ON a.id = i.account_id ORDER BY i.position`,
      ),
    ).toEqual([
      { uri: storedMemberRow.uri, state: PENDING },
      { uri: ALICE_URI, state: ACCEPTED },
    ]);
    expect((await aliceAnswers(w.t)).map(({ activity }) => [activity.type, activity.object])).toEqual([
      ["Accept", request.id],
    ]);
  });

  // ID-7 for a collection (#1589's D21): the owner's Remove of its collection records the owner's retraction of it,
  // whether Kopje holds it or not, so an instrument fetched before the Remove and applied after it stores nothing and
  // grants nothing. Fails if the held branch records no retraction (the fetched instrument stores the collection again
  // and accepts the request), or if the unheld one does not.
  for (const held of [true, false]) {
    it(`stores nothing from an instrument fetched before the owner's Remove of its collection${held ? ", held" : ""}`, async () => {
      const w = await owned();
      await followed(w.t, w.owner);
      const fetch = w.t.web.hold(w.listed.id, { snapshot: true });
      const posting = w.t.post(w.owner, requestFor(w));
      await fetch.reached;
      const add = { "@context": AS, type: "Add", actor: w.owner.uri, target: w.owner.featuredCollections };
      if (held) {
        expect(await w.t.post(w.owner, { ...add, object: w.listed })).toBe(202);
        expect(await sql(w.t.store, "SELECT 1 AS x FROM collections WHERE uri = ?", w.listed.id)).toEqual([{ x: 1 }]);
      }
      expect(await w.t.post(w.owner, { ...add, type: "Remove", object: w.listed.id })).toBe(202);
      expect(
        await sql(w.t.store, "SELECT actor_uri FROM inbound_retractions WHERE target_uri = ?", w.listed.id),
      ).toEqual([{ actor_uri: w.owner.uri }]);
      fetch.release();
      expect(await posting).toBe(202);
      expect(await sql(w.t.store, "SELECT uri FROM collections WHERE local = 0")).toEqual([]);
      expect(await localRows(w.t, ALICE)).toEqual([]);
      expect(await aliceAnswers(w.t)).toEqual([]);
    });
  }

  // Fails if a held collection's Remove at the owner's retraction cap deletes it (the request it grants would then
  // outlive a retraction never written), or if a retry once there is room does not delete it.
  it("answers a held collection's Remove 503 at the owner's retraction cap, leaving it stored, and deletes it on a retry", async () => {
    const w = await owned();
    expect(await w.t.post(w.owner, requestFor(w))).toBe(202);
    const [row] = await localRows(w.t, ALICE);
    await retractionsAtCap(w.t, w.owner);
    const remove = {
      "@context": AS,
      type: "Remove",
      actor: w.owner.uri,
      target: w.owner.featuredCollections,
      object: w.listed.id,
    };
    expect(await w.t.post(w.owner, remove)).toBe(503);
    expect(await localRows(w.t, ALICE)).toMatchObject([{ id: row!.id, state: ACCEPTED }]);
    expect(await sql(w.t.store, "SELECT 1 FROM inbound_retractions WHERE target_uri = ?", w.listed.id)).toEqual([]);
    await sql(w.t.store, "DELETE FROM inbound_retractions WHERE target_uri LIKE '%/filler/%'");
    expect(await w.t.post(w.owner, remove)).toBe(202);
    expect(await sql(w.t.store, "SELECT uri FROM collections WHERE local = 0")).toEqual([]);
    expect(await localRows(w.t, ALICE)).toEqual([]);
    expect(await authorizationStatus(w.t, row!.id)).toBe(404);
  });

  // Fails if the Remove's delete rests on the retraction it records rather than on its own mark: a stored creation time
  // later than that retraction's expiry (an imported Store's, written by another clock) would refuse it.
  it("deletes a held collection on its Remove whatever its stored creation time, leaving no mark", async () => {
    const w = await owned();
    expect(await w.t.post(w.owner, requestFor(w))).toBe(202);
    await sql(w.t.store, "UPDATE collections SET created_at = '2999-01-01T00:00:00.000Z' WHERE uri = ?", w.listed.id);
    const remove = {
      "@context": AS,
      type: "Remove",
      actor: w.owner.uri,
      target: w.owner.featuredCollections,
      object: w.listed.id,
    };
    expect(await w.t.post(w.owner, remove)).toBe(202);
    expect(await sql(w.t.store, "SELECT uri FROM collections WHERE local = 0")).toEqual([]);
    expect(await localRows(w.t, ALICE)).toEqual([]);
    expect(await sql(w.t.store, "SELECT name FROM kopje_state WHERE name = 'collection_removal'")).toEqual([]);
  });

  // Admission (#1589's D21): a request's instrument stores a new collection only while Kopje holds fewer than
  // MAX_STORED_COLLECTIONS of the owner's. Fails if a request past them is ignored (the owner's item stays pending for
  // good) or stores a collection or a row.
  it("refuses a request whose new instrument the owner's held collections leave no room for", async () => {
    const w = await owned();
    await followed(w.t, w.owner);
    const ownerId = (await sql<{ id: string }>(w.t.store, "SELECT id FROM accounts WHERE uri = ?", w.owner.uri))[0]!.id;
    await sql(
      w.t.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO collections (id, account_id, local, name, sensitive, discoverable, uri, created_at, updated_at)
			SELECT '6' || printf('%017d', i), ?2, 0, 'held ' || i, 0, 1, ?3 || '/collections/held' || i, ?4, ?4 FROM n`,
      MAX_STORED_COLLECTIONS,
      ownerId,
      w.owner.uri,
      new Date(NOW).toISOString(),
    );
    const request = requestFor(w);
    expect(await w.t.post(w.owner, request)).toBe(202);
    expect(w.t.web.fetched).toContain(w.listed.id);
    expect(await sql(w.t.store, "SELECT 1 FROM collections WHERE uri = ?", w.listed.id)).toEqual([]);
    expect(await localRows(w.t, ALICE)).toEqual([]);
    expect(
      (await aliceAnswers(w.t)).map(({ activity }) => [activity.type, activity.object, "result" in activity]),
    ).toEqual([["Reject", request.id, false]]);
    // One held collection fewer: the same request is accepted.
    await sql(w.t.store, "DELETE FROM collections WHERE id = ?", `6${"1".padStart(17, "0")}`);
    expect(await w.t.post(w.owner, request)).toBe(202);
    expect(await localRows(w.t, ALICE)).toMatchObject([{ state: ACCEPTED, activity_uri: request.id }]);
  });

  // 6-T9. Fails if the envelope admits another type without an actor, or if the actor comes from anything but the
  // verified signature.
  // A spooled request's replay reads it as the inbox does (processInbox's "replay" mode: parseActivity with the
  // stored request's signature key id). Fails if the replay reads it without that key id (incomplete, dropped).
  it("takes a spooled actor-less FeatureRequest as its signer's on its replay", async () => {
    const w = await owned();
    const maintenance = harness(w.t.store, { MAINTENANCE: "readonly" }, BUILD, {
      keygen: fixtureKeyGen,
      loader: w.t.web.loader,
    });
    const r = requestFor(w);
    expect((await maintenance.request("/inbox", await signedInit(w.owner, "/inbox", r))).status).toBe(202);
    expect(await localRows(w.t, ALICE)).toEqual([]);
    const deps = inboxDeps(() => w.t.store, w.t.web.loader);
    await maintenance.queue.deliver((batch) => handleQueue(batch, { ...w.t.env, MAINTENANCE: "off" } as Env, deps));
    expect(maintenance.queue.pending).toEqual([]);
    expect(await localRows(w.t, ALICE)).toMatchObject([{ state: ACCEPTED, activity_uri: r.id }]);
  });

  it("takes Mastodon's actor-less FeatureRequest as its verified signer's", async () => {
    const w = await owned();
    const r = requestFor(w);
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    expect(await parseActivity(bytes(r), {}, w.owner.keyId)).toMatchObject({
      ok: true,
      actor: w.owner.uri,
      signer: true,
    });
    expect(await parseActivity(bytes(r))).toMatchObject({ ok: false, reason: "incomplete" });
    const follow = { "@context": AS, id: `${w.owner.uri}#f`, type: "Follow", object: ALICE_URI };
    const create = { "@context": AS, id: `${w.owner.uri}#c`, type: "Create", object: `${w.owner.uri}/statuses/1` };
    for (const other of [follow, create]) {
      expect(await parseActivity(bytes(other), {}, w.owner.keyId)).toMatchObject({ ok: false, reason: "incomplete" });
    }

    // Unsigned: refused, no row.
    const unsigned = await w.t.request("/inbox", {
      method: "POST",
      headers: { "content-type": "application/activity+json" },
      body: JSON.stringify(r),
    });
    expect(unsigned.status).toBe(401);
    // Signed by another actor's key (whose key id names that actor): its own request, on another host than its id.
    const other = await mastodonActor(w.t.web, "intruder", { origin: OTHER });
    expect(await w.t.post(other, r)).toBe(202);
    // Naming the owner as its actor while signed by another: refused as today.
    expect(await w.t.post(other, { ...r, actor: w.owner.uri })).toBe(202);
    // Signed by a key whose id is a document of its own (GoToSocial's form): the actor that id names is not the key's
    // owner, so the request is refused rather than read as one relayed by the owner.
    const gts = await mastodonActor(w.t.web, "gts", { origin: new URL(w.owner.uri).origin });
    const keyId = `${gts.uri}/main-key`;
    const key = { id: keyId, type: "CryptographicKey", owner: gts.uri, publicKeyPem: gts.pem };
    w.t.web.serve(gts.uri, { ...gts.document, publicKey: key });
    w.t.web.serve(keyId, { "@context": "https://w3id.org/security/v1", ...key });
    expect(await w.t.post(gts, featureRequest(gts, ALICE_URI, w.listed.id), { keyId })).toBe(401);
    expect(await localRows(w.t, ALICE)).toEqual([]);
    expect(await aliceAnswers(w.t)).toEqual([]);

    // Signed by the owner: processed with the owner as its actor.
    expect(await w.t.post(w.owner, r)).toBe(202);
    expect(await localRows(w.t, ALICE)).toMatchObject([{ state: ACCEPTED, activity_uri: r.id }]);
    expect((await aliceAnswers(w.t)).map(({ activity }) => activity.type)).toEqual(["Accept"]);
  });
});

function serveCollectionsEmpty(w: Owned): void {
  const root = w.owner.featuredCollections;
  w.t.web.serve(root, { "@context": AS, id: root, type: "Collection", totalItems: 0, first: `${root}?page=1` });
  w.t.web.serve(`${root}?page=1`, {
    "@context": AS,
    id: `${root}?page=1`,
    type: "CollectionPage",
    partOf: root,
    items: [],
  });
}

// The lane of alice's activities to `origin` holding `count` active rows (a Like's filler), and `others` active rows
// in another lane of hers.
async function filledLanes(t: Setup, origin: string, count: number, others = 0): Promise<void> {
  await sql(
    t.store,
    `INSERT INTO outbound_activities (account_id, body, object_uri, retracts, created_at)
		VALUES (?, '{"activity":{"type":"Like"},"audience":{"followers":false,"accounts":[]}}', 'filler', 0, ?)`,
    ALICE,
    NOW,
  );
  for (const [lane, n] of [
    [origin, count],
    ["https://filler.example", others],
  ] as const) {
    await sql(
      t.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?3)
			INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, state, next_attempt_at, updated_at)
			SELECT (SELECT id FROM outbound_activities WHERE object_uri = 'filler'), ?1, ?2 || '/inbox', ?2, 'queued', ?4, ?4
			FROM n WHERE ?3 > 0`,
      ALICE,
      lane,
      n,
      NOW,
    );
  }
}

// Every due delivery delivered (202), round after round, until none is due at NOW.
async function deliverAll(t: Setup): Promise<void> {
  for (let round = 0; round < 10; round++) {
    const claim = await t.store.claimDeliveries(BUILD, { now: NOW, leaseToken: `all-${round}` });
    if (claim.deliveries.length === 0) {
      return;
    }
    for (const { id } of claim.deliveries) {
      const outcome: DeliveryOutcome = { kind: "delivered", status: 202 };
      await t.store.completeDelivery(BUILD, { id, leaseToken: claim.leaseToken, now: NOW, outcome });
    }
  }
  throw new Error("deliveries still due");
}

// Each copy of alice's answer of `a` (her unsigned Delete of it, not her signed revocation) that a delivery round
// could still send, superseded or not, with its intent.
async function answerCopies(t: Setup, a: string) {
  return (await aliceAnswers(t))
    .filter(({ activity }) => activity.type === "Delete" && activity.id === `${a}#delete` && !("signature" in activity))
    .flatMap(({ id, deliveries }) =>
      deliveries
        .filter((d) => ["queued", "pending", "leased"].includes(d.state))
        .map((d) => ({ intent: id, inbox: d.inbox, state: d.state })),
    );
}

const activeIn = async (t: Setup, lane: string) =>
  (
    await sql<{ n: number }>(
      t.store,
      "SELECT count(*) AS n FROM deliveries WHERE account_id = ? AND lane = ? AND state IN ('queued', 'pending', 'leased')",
      ALICE,
      lane,
    )
  )[0]!.n;

describe("the answers to an owner's listing of a local member (D24)", () => {
  // 6-T6. Fails if the answer is sent while the row is accepted, if a retraction suppresses it, if the Remove deletes
  // the row, or if the unsigned Delete reaches anyone but the owner's personal inbox or differs from the signed one.
  it("answers an Add of an authorization not served with the member's Delete to the owner alone", async () => {
    const w = await owned();
    // A follower of alice on the owner's server: the answer never takes its shared inbox.
    const fan = await mastodonActor(w.t.web, "fan2");
    await followed(w.t, fan, DAVE);
    expect(await w.t.post(w.owner, requestFor(w))).toBe(202);
    const [row] = await localRows(w.t, ALICE);
    const a = authorization(row!.id);
    const deletes = async () => (await aliceAnswers(w.t)).filter(({ activity }) => activity.type === "Delete");

    // An Add of the authorization Kopje serves: the row's uri set, nothing sent, nothing queued.
    const served = localItem(w.owner, ALICE_URI, a);
    expect(await w.t.post(w.owner, itemActivity(w, "Add", served))).toBe(202);
    expect(await localRows(w.t, ALICE)).toMatchObject([{ id: row!.id, uri: served.id, check_due_at: null }]);
    expect(await deletes()).toEqual([]);

    // An Add naming an authorization of no row: an ordinary Delete of it, once per Add.
    const unknown = authorization("999999999999999999");
    const stray = localItem(w.owner, ALICE_URI, unknown);
    expect(await w.t.post(w.owner, itemActivity(w, "Add", stray))).toBe(202);
    let sent = await deletes();
    expect(
      sent.map(({ activity, retracts, deliveries }) => [activity, retracts, deliveries.map((d) => d.inbox)]),
    ).toEqual([
      [
        {
          "@context": [...FEATURE_CONTEXT, "https://w3id.org/security/v1"],
          id: `${unknown}#delete`,
          type: "Delete",
          actor: ALICE_URI,
          to: [PUBLIC],
          object: {
            id: unknown,
            type: "FeatureAuthorization",
            interactingObject: w.listed.id,
            interactionTarget: ALICE_URI,
          },
        },
        0,
        [`${w.owner.uri}/inbox`],
      ],
    ]);
    expect(await sql(w.t.store, "SELECT 1 FROM collection_items WHERE uri = ?", stray.id)).toEqual([]);
    // The owner's actor has a shared inbox (`${origin}/inbox`), which alice's follower shares; the Delete's `to` names
    // only the public, so the owner is its silent recipient, whose copy takes its own inbox (deliveries.ts placement)
    // whether or not the answer asks for it (OutboundOptions.personalInbox, which keeps it there should the body name
    // the owner).

    // The member revokes; an Add naming the revoked authorization, after the owner's Remove of that item retracted it,
    // is answered all the same: a retraction, to the owner alone.
    expect(await revokeAs(w.t, await collectionIdOf(w.t, w.listed.id), row!.id)).toBe(200);
    const revokeDelete = (await deletes()).at(-1)!;
    const late = localItem(w.owner, ALICE_URI, a);
    expect(await w.t.post(w.owner, itemActivity(w, "Remove", late))).toBe(202);
    expect(await w.t.post(w.owner, itemActivity(w, "Add", late))).toBe(202);
    sent = await deletes();
    const answer = sent.at(-1)!;
    expect(answer.id).not.toBe(revokeDelete.id);
    const { signature: _signature, ...unsignedRevoke } = revokeDelete.activity;
    expect(answer.activity).toEqual(unsignedRevoke);
    expect([revokeDelete.immutable, answer.immutable]).toEqual([true, true]);
    expect([answer.retracts, answer.deliveries.map((d) => d.inbox)]).toEqual([1, [`${w.owner.uri}/inbox`]]);
    // The revoke's own Delete still goes to the owner and the follower: the answer supersedes no copy of it.
    expect((await aliceAnswers(w.t)).find(({ id }) => id === revokeDelete.id)!.superseded).toBe(0);
    expect(await localRows(w.t, ALICE)).toMatchObject([{ id: row!.id, state: REVOKED }]);

    // The owner's Remove of the item alice's row is listed as: the row hidden, not deleted, the item retracted, and one
    // sync of the owner requested.
    await sql(w.t.store, "DELETE FROM collection_syncs");
    const removed = localItem(w.owner, ALICE_URI, a);
    expect(await w.t.post(w.owner, itemActivity(w, "Remove", { ...removed, id: served.id }))).toBe(202);
    const ownerId = (await sql<{ id: string }>(w.t.store, "SELECT id FROM accounts WHERE uri = ?", w.owner.uri))[0]!.id;
    expect(await sql(w.t.store, "SELECT account_id FROM collection_syncs")).toEqual([{ account_id: ownerId }]);
    expect(await localRows(w.t, ALICE)).toMatchObject([{ id: row!.id, state: REVOKED, uri: null }]);
    expect(
      await sql(
        w.t.store,
        "SELECT 1 AS x FROM inbound_retractions WHERE actor_uri = ? AND target_uri = ?",
        w.owner.uri,
        served.id,
      ),
    ).toEqual([{ x: 1 }]);
  });

  // #1589's D21 and D24: an item's Remove hides an accepted row and never deletes it (a re-accept may have replaced the
  // item while the authorization stands), an Add of a retracted item is refused, and a read lists it whatever the
  // retractions. Fails if the Remove deletes the row (the next Add is answered with alice's Delete), or if a read
  // honours the item's retraction.
  it("keeps an accepted row through Add(I1), Remove(I1) and Add(I2), and a read lists I1 its retraction blocked", async () => {
    const w = await owned();
    expect(await w.t.post(w.owner, requestFor(w))).toBe(202);
    const [row] = await localRows(w.t, ALICE);
    const a = authorization(row!.id);
    const first = localItem(w.owner, ALICE_URI, a);
    expect(await w.t.post(w.owner, itemActivity(w, "Add", first))).toBe(202);
    expect(await localRows(w.t, ALICE)).toMatchObject([{ id: row!.id, state: ACCEPTED, uri: first.id }]);
    expect(await w.t.post(w.owner, itemActivity(w, "Remove", first.id))).toBe(202);
    expect(await localRows(w.t, ALICE)).toMatchObject([{ id: row!.id, state: ACCEPTED, uri: null }]);
    // The removed item added again: refused by its retraction (ID-7).
    expect(await w.t.post(w.owner, itemActivity(w, "Add", first))).toBe(202);
    expect(await localRows(w.t, ALICE)).toMatchObject([{ id: row!.id, uri: null }]);
    // A read of the owner's collections listing it: shown.
    w.listed.orderedItems = [first];
    w.listed.totalItems = 1;
    serveListing(w.t.web, w.owner, w.listed);
    const ownerId = (await sql<{ id: string }>(w.t.store, "SELECT id FROM accounts WHERE uri = ?", w.owner.uri))[0]!.id;
    await requestSync(w.t, ownerId);
    await syncAll(w.t, w.t.web.loader, NOW + 60_000);
    expect(await localRows(w.t, ALICE)).toMatchObject([{ id: row!.id, state: ACCEPTED, uri: first.id }]);
    // Another item of the same authorization: the row's uri moves to it.
    const second = localItem(w.owner, ALICE_URI, a);
    expect(await w.t.post(w.owner, itemActivity(w, "Add", second))).toBe(202);
    expect(await localRows(w.t, ALICE)).toMatchObject([{ id: row!.id, state: ACCEPTED, uri: second.id }]);
    expect((await aliceAnswers(w.t)).map(({ activity }) => activity.type)).toEqual(["Accept"]);
    expect(await authorizationStatus(w.t, row!.id)).toBe(200);
  });

  // Code review r2: an Add whose item cannot be one of the collection's (an item on another origin) names no one: it
  // moves no row's uri and is answered with nothing. Fails if such an Add takes the row (its uri becomes the foreign
  // item) or is answered with alice's Delete.
  it("takes no Add of an item on another origin naming the member, its authorization served or not", async () => {
    const w = await owned();
    expect(await w.t.post(w.owner, requestFor(w))).toBe(202);
    const [row] = await localRows(w.t, ALICE);
    const a = authorization(row!.id);
    const first = localItem(w.owner, ALICE_URI, a);
    expect(await w.t.post(w.owner, itemActivity(w, "Add", first))).toBe(202);
    const foreign = (n: number, auth: string) => ({
      ...localItem(w.owner, ALICE_URI, auth),
      id: `${OTHER}/collection_items/${n}`,
    });
    expect(await w.t.post(w.owner, itemActivity(w, "Add", foreign(1, a)))).toBe(202);
    expect(await localRows(w.t, ALICE)).toMatchObject([{ id: row!.id, state: ACCEPTED, uri: first.id }]);
    expect(await w.t.post(w.owner, itemActivity(w, "Add", foreign(2, authorization("999999999999999996"))))).toBe(202);
    expect((await aliceAnswers(w.t)).map(({ activity }) => activity.type)).toEqual(["Accept"]);
  });

  // Code review r3: an Add naming the served authorization under an item uri another row holds (here a remote member's
  // item of the same collection) names no row of a local member: nothing is applied and the row keeps its item. Fails if
  // the Add is taken as listing the row ('item-listed').
  it("takes no Add naming the member under an item uri another row holds", async () => {
    const w = await owned();
    expect(await w.t.post(w.owner, requestFor(w))).toBe(202);
    const [row] = await localRows(w.t, ALICE);
    const a = authorization(row!.id);
    const first = localItem(w.owner, ALICE_URI, a);
    expect(await w.t.post(w.owner, itemActivity(w, "Add", first))).toBe(202);
    const held = remoteItem(w.owner, { uri: `${OTHER}/users/held` });
    expect(await w.t.post(w.owner, itemActivity(w, "Add", held))).toBe(202);
    expect(await sql(w.t.store, "SELECT account_id FROM collection_items WHERE uri = ?", held.id)).toEqual([
      { account_id: null },
    ]);
    const add = (id: string) =>
      storeReceive(w.t.store, w.owner.uri, {
        type: "Add",
        id: null,
        target: w.listed.id,
        object: { featuredItem: { id, object: ALICE_URI, authorization: a, published: null } },
      });
    expect(await add(held.id)).toMatchObject({ applied: false, reason: "not-applied" });
    expect(await localRows(w.t, ALICE)).toMatchObject([{ id: row!.id, state: ACCEPTED, uri: first.id, position: 1 }]);
    // The guarded branch: the same Add under a uri no row holds lists the row.
    const free = localItem(w.owner, ALICE_URI, a);
    expect(await add(free.id)).toMatchObject({ applied: true, reason: "item-listed" });
    expect(await localRows(w.t, ALICE)).toMatchObject([{ id: row!.id, uri: free.id }]);
  });

  // 6-T6 with a second owner. Fails if another owner's listing of the authorization Kopje serves for this owner's
  // collection is answered with alice's Delete: a Mastodon server applies a Delete of a feature authorization to its
  // own collection's item by the authorization and the signer alone (delete.rb:80), so that Delete, sent to another
  // owner on this owner's server, would revoke alice's membership here. Fails too if the answer once she revoked it is
  // a retraction, which admission never refuses.
  for (const kind of ["Add", "Update"] as const) {
    it(`sends no Delete for another owner's ${kind} listing an authorization served in this owner's collection`, async () => {
      const w = await owned();
      expect(await w.t.post(w.owner, requestFor(w))).toBe(202);
      const [row] = await localRows(w.t, ALICE);
      const a = authorization(row!.id);
      // Another owner on the same server, with a collection of its own stored.
      const other = await featuredOwner(w.t.web, `owner${++owners}`, COLLECTIONS_ONLY);
      const theirs = collection(other, []);
      serveListing(w.t.web, other, theirs);
      await storedOwner(w.t, other);
      await syncAll(w.t);
      const deletes = async () => (await aliceAnswers(w.t)).filter(({ activity }) => activity.type === "Delete");
      const lists = async (n: number) => {
        const entry = localItem(other, ALICE_URI, a);
        const body =
          kind === "Add"
            ? itemActivity({ t: w.t, owner: other, listed: theirs }, "Add", entry)
            : {
                "@context": AS,
                id: `${other.uri}#updates/${n}`,
                type: "Update",
                actor: other.uri,
                object: { ...theirs, totalItems: 1, orderedItems: [entry] },
              };
        expect(await w.t.post(other, body)).toBe(202);
      };

      await lists(1);
      expect(await deletes()).toEqual([]);
      expect(await localRows(w.t, ALICE)).toMatchObject([{ id: row!.id, state: ACCEPTED }]);
      expect(await authorizationStatus(w.t, row!.id)).toBe(200);

      // Once alice revokes it, Kopje serves it nowhere: the other owner's listing of it is answered, to that owner
      // alone, as new work under RES-4's caps (a retraction, never refused, is the row's own owner's alone: any number
      // of accounts may list the authorization).
      expect(await revokeAs(w.t, await collectionIdOf(w.t, w.listed.id), row!.id)).toBe(200);
      const before = (await deletes()).length;
      await lists(2);
      const sent = await deletes();
      expect([
        sent.length - before,
        sent.at(-1)!.activity.id,
        sent.at(-1)!.retracts,
        sent.at(-1)!.deliveries.map((d) => d.inbox),
      ]).toEqual([1, `${a}#delete`, 0, [`${other.uri}/inbox`]]);
    });
  }

  // 6-T6's caps. Fails if an answer of no row is admitted as a retraction (the lane passes 500), if an answer for a
  // revoked row is refused at the cap (Kopje revoked, the owner accepted), if a repeated Add queues a second sendable
  // copy while the first still waits (the lane grows past every cap with the owner's Adds), or if a copy already in
  // flight stands for the next Add's answer (its POST may have preceded the owner's acceptance).
  it("admits an answer of no row under RES-4's caps, and one of a revoked row as a retraction past them", async () => {
    const w = await owned();
    expect(await w.t.post(w.owner, requestFor(w))).toBe(202);
    const [row] = await localRows(w.t, ALICE);
    expect(await revokeAs(w.t, await collectionIdOf(w.t, w.listed.id), row!.id)).toBe(200);
    await filledLanes(w.t, MASTODON, MAX_LANE_BACKLOG);
    const lane = await activeIn(w.t, MASTODON);
    const added = async (a: string) => {
      expect(await w.t.post(w.owner, itemActivity(w, "Add", localItem(w.owner, ALICE_URI, a)))).toBe(202);
      return (await aliceAnswers(w.t)).at(-1)!;
    };
    // The lane full: an answer of no row is written gave_up 'backlog full', the lane unchanged.
    const stray = await added(authorization("999999999999999998"));
    expect([stray.retracts, stray.deliveries]).toEqual([
      0,
      [{ inbox: `${w.owner.uri}/inbox`, state: "gave_up", error: "backlog full" }],
    ]);
    expect(await activeIn(w.t, MASTODON)).toBe(lane);

    // The revoked row's authorization: admitted as a retraction, one copy to send however many Adds name it.
    const first = await added(authorization(row!.id));
    expect([first.retracts, first.deliveries.map((d) => d.state)]).toEqual([1, ["queued"]]);
    // Every copy of the answer that a delivery round could still send, superseded or not.
    const sendable = async () =>
      (await aliceAnswers(w.t))
        .filter(
          ({ activity }) =>
            activity.type === "Delete" &&
            activity.id === `${authorization(row!.id)}#delete` &&
            !("signature" in activity),
        )
        .flatMap(({ deliveries }) => deliveries.filter((d) => ["queued", "pending", "leased"].includes(d.state)));
    await added(authorization(row!.id));
    await added(authorization(row!.id));
    expect(await sendable()).toEqual([{ inbox: `${w.owner.uri}/inbox`, state: "queued", error: null }]);
    // Once that copy is in flight, the next Add is answered again, behind it.
    await sql(
      w.t.store,
      `UPDATE deliveries SET state = 'leased', lease_token = 'in-flight' WHERE activity_id = ?`,
      first.id,
    );
    await added(authorization(row!.id));
    expect((await sendable()).map((d) => d.state)).toEqual(["leased", "queued"]);
  });

  // Challenge 1589-pr6-9 (code review r2): an answer leased when the next listing records another is superseded by
  // it, and is dropped instead of being POSTed again, at its failure, at its lease's expiry and at its confirmation;
  // the later answer, behind it in the lane, is promoted; a failed POST counts toward its host first (code review r3).
  // Fails if a superseded answer is retried, claimed again or sent (two copies of one answer to send), or if its
  // 503 leaves the host's day uncounted.
  for (const end of ["failure", "lease expiry", "confirmation"] as const) {
    it(`drops a leased answer the next listing's answer superseded, at its ${end}`, async () => {
      const w = await owned();
      expect(await w.t.post(w.owner, requestFor(w))).toBe(202);
      const [row] = await localRows(w.t, ALICE);
      expect(await revokeAs(w.t, await collectionIdOf(w.t, w.listed.id), row!.id)).toBe(200);
      await deliverAll(w.t);
      const a = authorization(row!.id);
      const add = async () =>
        expect(await w.t.post(w.owner, itemActivity(w, "Add", localItem(w.owner, ALICE_URI, a)))).toBe(202);
      await add();
      const [first] = await answerCopies(w.t, a);
      const claim = await w.t.store.claimDeliveries(BUILD, { now: NOW, leaseToken: "in-flight" });
      expect(claim.deliveries.map((d) => d.inbox)).toEqual([`${w.owner.uri}/inbox`]);
      await add();
      const copies = await answerCopies(w.t, a);
      expect(copies.map((c) => [c.intent === first!.intent, c.state])).toEqual([
        [true, "leased"],
        [false, "queued"],
      ]);
      const id = claim.deliveries[0]!.id;
      if (end === "failure") {
        const outcome: DeliveryOutcome = {
          kind: "failed",
          status: 503,
          error: "HTTP 503",
          permanent: false,
          failure: { stage: "post" },
        };
        expect(await sql(w.t.store, "SELECT host FROM delivery_hosts")).toEqual([]);
        const done = await w.t.store.completeDelivery(BUILD, { id, leaseToken: "in-flight", now: NOW, outcome });
        expect(done.status).toBe("dropped");
        expect(await sql(w.t.store, "SELECT host, failure_days FROM delivery_hosts")).toEqual([
          { host: new URL(w.owner.uri).host, failure_days: 1 },
        ]);
      } else if (end === "lease expiry") {
        const again = await w.t.store.claimDeliveries(BUILD, { now: NOW + LEASE_MS, leaseToken: "again" });
        expect(again.deliveries).toEqual([]);
      } else {
        const confirmed = await w.t.store.confirmDelivery(BUILD, { id, leaseToken: "in-flight", now: NOW });
        expect(confirmed.status).toBe("dropped");
      }
      expect(await answerCopies(w.t, a)).toEqual([{ ...copies[1]!, state: "pending" }]);
    });
  }

  // Code review r2: a read of the owner's collections that answers a listing with alice's Delete rings for its
  // delivery in the same jobs round (jobsRound rings for the Worker families' deliveries after them). Fails if the
  // answer waits for the delivery cron.
  it("rings for the Delete a read of the owner's collections records", async () => {
    const w = await owned();
    expect(await w.t.post(w.owner, requestFor(w))).toBe(202);
    const [row] = await localRows(w.t, ALICE);
    expect(await revokeAs(w.t, await collectionIdOf(w.t, w.listed.id), row!.id)).toBe(200);
    await deliverAll(w.t);
    const a = authorization(row!.id);
    w.listed.orderedItems = [localItem(w.owner, ALICE_URI, a)];
    w.listed.totalItems = 1;
    serveListing(w.t.web, w.owner, w.listed);
    const ownerId = (await sql<{ id: string }>(w.t.store, "SELECT id FROM accounts WHERE uri = ?", w.owner.uri))[0]!.id;
    await requestSync(w.t, ownerId);
    w.t.queue.pending.length = 0;
    const env = { ...w.t.env, MAINTENANCE: "off" } as unknown as Env;
    await jobsRound(
      env,
      inboxDeps(() => w.t.store, w.t.web.loader),
    );
    expect((await answerCopies(w.t, a)).map((c) => c.inbox)).toEqual([`${w.owner.uri}/inbox`]);
    expect(w.t.queue.pending.map((m) => m.body)).toContainEqual({ kind: "deliver" });
  });

  // Code review r3: the read's Delete commits before the family's next claim, which throws; the jobs round still rings
  // for it, and a Store refusal still ends the round (no jobs message). Fails if the family's error boundary drops what
  // its committed calls recorded (the answer waits for the delivery cron).
  for (const failure of ["an error", "a Store refusal"] as const) {
    it(`rings for the Delete a read recorded when the family's next claim fails with ${failure}`, async () => {
      const w = await owned();
      expect(await w.t.post(w.owner, requestFor(w))).toBe(202);
      const [row] = await localRows(w.t, ALICE);
      expect(await revokeAs(w.t, await collectionIdOf(w.t, w.listed.id), row!.id)).toBe(200);
      await deliverAll(w.t);
      const a = authorization(row!.id);
      w.listed.orderedItems = [localItem(w.owner, ALICE_URI, a)];
      w.listed.totalItems = 1;
      serveListing(w.t.web, w.owner, w.listed);
      const ownerId = (await sql<{ id: string }>(w.t.store, "SELECT id FROM accounts WHERE uri = ?", w.owner.uri))[0]!
        .id;
      await requestSync(w.t, ownerId);
      w.t.queue.pending.length = 0;
      let claims = 0;
      const store = new Proxy(w.t.store, {
        get(target, key) {
          if (key === "claimCollectionSync" && ++claims === 2) {
            const error =
              failure === "an error"
                ? new Error("test: the claim fails")
                : Object.assign(new Error("test"), { retryable: true });
            return () => Promise.reject(error);
          }
          return Reflect.get(target, key) as unknown;
        },
      });
      const env = { ...w.t.env, MAINTENANCE: "off" } as unknown as Env;
      await jobsRound(
        env,
        inboxDeps(() => store, w.t.web.loader),
      );
      expect(claims).toBe(2);
      expect((await answerCopies(w.t, a)).map((c) => c.inbox)).toEqual([`${w.owner.uri}/inbox`]);
      const kinds = w.t.queue.pending.map((m) => (m.body as { kind: string }).kind);
      expect(kinds).toContain("deliver");
      if (failure === "a Store refusal") {
        expect(kinds).toEqual(["deliver"]);
      }
    });
  }

  // Code review r2: an answer goes to the owner's inbox as the owner's account names it when the listing is answered.
  // Fails if an answer waiting for the inbox the owner had before a refresh of its actor stands for the answer to the
  // new one (nothing reaches the new inbox), or if both wait (two copies of one answer to send).
  it("answers at the owner's new inbox after a refresh, replacing the answer waiting for the old one", async () => {
    const w = await owned();
    expect(await w.t.post(w.owner, requestFor(w))).toBe(202);
    const [row] = await localRows(w.t, ALICE);
    expect(await revokeAs(w.t, await collectionIdOf(w.t, w.listed.id), row!.id)).toBe(200);
    await deliverAll(w.t);
    const a = authorization(row!.id);
    const add = async () =>
      expect(await w.t.post(w.owner, itemActivity(w, "Add", localItem(w.owner, ALICE_URI, a)))).toBe(202);
    await add();
    const old = await answerCopies(w.t, a);
    expect(old.map((c) => [c.inbox, c.state])).toEqual([[`${w.owner.uri}/inbox`, "pending"]]);
    // The owner's Update of its actor, whose document names a new inbox.
    const inbox = `${w.owner.uri}/inbox2`;
    w.t.web.serve(w.owner.uri, { ...w.owner.document, inbox });
    const update = {
      "@context": AS,
      id: `${w.owner.uri}#updates/1`,
      type: "Update",
      actor: w.owner.uri,
      object: w.owner.uri,
    };
    expect(await w.t.post(w.owner, update)).toBe(202);
    expect(await sql(w.t.store, "SELECT inbox_url FROM accounts WHERE uri = ?", w.owner.uri)).toEqual([
      { inbox_url: inbox },
    ]);
    await add();
    const fresh = await answerCopies(w.t, a);
    expect(fresh.map((c) => [c.inbox, c.state])).toEqual([[inbox, "pending"]]);
    // Another listing: the answer waiting for the new inbox stands for it.
    await add();
    expect(await answerCopies(w.t, a)).toEqual(fresh);
  });

  // Code review r2: an answer whose target is not expanded yet (still in its intent's chunk) waits as a queued one
  // does: it stands for the next listing's answer to the same inbox, and an answer to the owner's new inbox replaces
  // it. Fails if the gate ignores a waiting target (two answers to send), or if the replacement leaves it (a copy to
  // the old inbox).
  it("counts and replaces an answer whose target is not expanded yet", async () => {
    const w = await owned();
    expect(await w.t.post(w.owner, requestFor(w))).toBe(202);
    const [row] = await localRows(w.t, ALICE);
    expect(await revokeAs(w.t, await collectionIdOf(w.t, w.listed.id), row!.id)).toBe(200);
    await deliverAll(w.t);
    const a = authorization(row!.id);
    const add = async () =>
      expect(await w.t.post(w.owner, itemActivity(w, "Add", localItem(w.owner, ALICE_URI, a)))).toBe(202);
    // The answers recorded, read without expanding anything.
    const intents = () =>
      sql<{ id: number }>(
        w.t.store,
        `SELECT id FROM outbound_activities WHERE json_extract(body, '$.activity.id') = ?
			AND json_extract(body, '$.activity.signature') IS NULL ORDER BY id`,
        `${a}#delete`,
      );
    await add();
    // Its row taken back into its target, as an expansion step that ran out of rows leaves it.
    const [first] = await intents();
    const [taken] = await sql<{ inbox: string; addressee: string; accounts: string; domains: string }>(
      w.t.store,
      `DELETE FROM deliveries WHERE activity_id = ?
			RETURNING inbox_url AS inbox, addressee, recipient_accounts AS accounts, recipient_domains AS domains`,
      first!.id,
    );
    const target = {
      inbox: taken!.inbox,
      addressee: taken!.addressee,
      accounts: JSON.parse(taken!.accounts) as string[],
      domains: JSON.parse(taken!.domains) as string[],
    };
    await sql(
      w.t.store,
      "INSERT INTO outbound_targets (activity_id, targets) VALUES (?, ?)",
      first!.id,
      JSON.stringify([target]),
    );
    await add();
    // Nothing recorded: the target still waits, unexpanded (an answer recorded would have been expanded at once).
    expect(await intents()).toEqual([first]);
    expect(await sql(w.t.store, "SELECT activity_id FROM outbound_targets WHERE activity_id = ?", first!.id)).toEqual([
      { activity_id: first!.id },
    ]);
    // The owner's new inbox: the waiting target is replaced.
    const inbox = `${w.owner.uri}/inbox2`;
    w.t.web.serve(w.owner.uri, { ...w.owner.document, inbox });
    const update = {
      "@context": AS,
      id: `${w.owner.uri}#updates/1`,
      type: "Update",
      actor: w.owner.uri,
      object: w.owner.uri,
    };
    expect(await w.t.post(w.owner, update)).toBe(202);
    await add();
    expect(await sql(w.t.store, "SELECT 1 FROM outbound_targets WHERE activity_id = ?", first!.id)).toEqual([]);
    expect((await answerCopies(w.t, a)).map((c) => [c.inbox, c.state])).toEqual([[inbox, "pending"]]);
  });

  it("refuses an answer of no row when the Store's backlog is full, with this owner's lane empty", async () => {
    const w = await owned();
    expect(await w.t.post(w.owner, requestFor(w))).toBe(202);
    await filledLanes(w.t, MASTODON, 0, MAX_BACKLOG);
    const unknown = authorization("999999999999999997");
    expect(await w.t.post(w.owner, itemActivity(w, "Add", localItem(w.owner, ALICE_URI, unknown)))).toBe(202);
    const stray = (await aliceAnswers(w.t)).find(({ activity }) => activity.id === `${unknown}#delete`);
    expect([stray!.retracts, stray!.deliveries]).toEqual([
      0,
      [{ inbox: `${w.owner.uri}/inbox`, state: "gave_up", error: "backlog full" }],
    ]);
  });

  // D25: a local block revokes alice's item in the blocked owner's collection with her Delete, unsigned, to the owner's
  // personal inbox alone. Fails if it is sent to the member's followers or the owner's shared inbox.
  it("sends the block's Delete to the owner's personal inbox alone", async () => {
    const w = await owned();
    const fan = await mastodonActor(w.t.web, "fan3");
    await followed(w.t, fan, DAVE);
    expect(await w.t.post(w.owner, requestFor(w))).toBe(202);
    const [row] = await localRows(w.t, ALICE);
    const ownerId = (await sql<{ id: string }>(w.t.store, "SELECT id FROM accounts WHERE uri = ?", w.owner.uri))[0]!.id;
    expect((await call(w.t, "POST", `/api/v1/accounts/${ownerId}/block`)).status).toBe(200);
    expect(await localRows(w.t, ALICE)).toMatchObject([{ id: row!.id, state: REVOKED }]);
    const a = authorization(row!.id);
    const deletes = (await aliceAnswers(w.t)).filter(({ activity }) => activity.type === "Delete");
    expect(deletes.map(({ immutable }) => immutable)).toEqual([true]);
    expect(deletes.map(({ activity, deliveries }) => [activity, deliveries.map((d) => d.inbox)])).toEqual([
      [
        {
          "@context": [...FEATURE_CONTEXT, "https://w3id.org/security/v1"],
          id: `${a}#delete`,
          type: "Delete",
          actor: ALICE_URI,
          to: [PUBLIC],
          object: { id: a, type: "FeatureAuthorization", interactingObject: w.listed.id, interactionTarget: ALICE_URI },
        },
        [`${w.owner.uri}/inbox`],
      ],
    ]);
  });

  // D25 through a Move: Mastodon's MoveWorker carries a local block of the source to the target by BlockService,
  // which ends the blocker's memberships in the target's collections. Fails if the carried block leaves alice's grant
  // in the target's collection standing (its Delete not sent, the target's next request accepted).
  it("ends alice's membership of the Move target's collection when the Move carries her block to it", async () => {
    const w = await owned();
    expect(await w.t.post(w.owner, requestFor(w))).toBe(202);
    const [row] = await localRows(w.t, ALICE);
    const source = await mastodonActor(w.t.web, `source${owners}`, { origin: OTHER, key: 2, extra: {} });
    await followed(w.t, source, DAVE);
    const sourceId = (await sql<{ id: string }>(w.t.store, "SELECT id FROM accounts WHERE uri = ?", source.uri))[0]!.id;
    expect((await call(w.t, "POST", `/api/v1/accounts/${sourceId}/block`)).status).toBe(200);
    w.t.web.serve(w.owner.uri, { ...w.owner.document, alsoKnownAs: [source.uri] });
    const move = { "@context": AS, id: `${source.uri}#moves/1`, type: "Move", actor: source.uri, object: source.uri };
    expect(await w.t.post(source, { ...move, target: w.owner.uri })).toBe(202);

    expect(await localRows(w.t, ALICE)).toMatchObject([{ id: row!.id, state: REVOKED }]);
    const a = authorization(row!.id);
    const deletes = (await aliceAnswers(w.t)).filter(({ activity }) => activity.type === "Delete");
    expect(deletes.map(({ activity, deliveries }) => [activity.id, deliveries.map((d) => d.inbox)])).toEqual([
      [`${a}#delete`, [`${w.owner.uri}/inbox`]],
    ]);
    expect(await w.t.post(w.owner, requestFor(w, `${w.owner.uri}/feature_requests/after-move`))).toBe(202);
    expect((await aliceAnswers(w.t)).at(-1)!.activity).toMatchObject({
      type: "Reject",
      object: `${w.owner.uri}/feature_requests/after-move`,
    });
  });
});
