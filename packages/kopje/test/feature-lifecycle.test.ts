import fc from "fast-check";
import { describe, expect, inject, it } from "vitest";

import type { ItemCheckOutcome } from "../src/domain/collection-checks";
import { settleDeliveries, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { mastodon47Signed, mastodonFeatureDelete, signTime } from "./author-proof-helpers";
import {
  CHECK_LEASE_MS,
  checkGaveUp,
  DAY_MS,
  type FromMember,
  FeaturePolicy,
  type ItemState,
  MemberPeer,
  MemberPolicy,
  memberQuiescence,
  type MemberLogged,
  type MemberRow,
  type Owner,
  type Path,
  type Row,
  type ToMember,
} from "./feature-model";
import {
  collection,
  COLLECTIONS_ONLY,
  featuredOwner,
  requestSync,
  serveCollections,
  storedMember,
  storedOwner,
  syncAll,
} from "./featured-collection-helpers";
import { BUILD } from "./helpers";
import { mastodonActor, type TestActor } from "./inbox-helpers";
import { accountId, ALICE_URI, AS, DAVE_URI, nextId, OTHER, PUBLIC, setup, type Setup } from "./inbox-status-helpers";
import { runs } from "./policy-world";

// 5-T20: model-based checks of remote collections' items (#1589's D21 and D22; ID-6, ID-7 and RES-6 in
// docs/threat-model.md). The owner O lists the member M with M's authorization A or B, changes it, removes M and lists
// it again; the owner X lists M with O's authorization A; each listing reaches Kopje by a read of the owner's
// collections or by the owner's Add, Remove or Update. M's server withdraws A or B and sends its Delete, directly or
// relayed by O with M's proof. Kopje's check rounds claim, fetch (each fetch observing M's server at that moment),
// complete in any order or not at all, and let leases run out; the 24-hour cleanup runs as the clock moves. After every
// step the Store's items must equal FeaturePolicy's (test/feature-model.ts), and once everything has settled O's item
// whose candidate M serves must be accepted unless its revision's check gave up.

type Stats = Record<string, number>;
const tally = (stats: Stats, key: string) => {
  stats[key] = (stats[key] ?? 0) + 1;
};

type Owned = TestActor & { featuredCollections: string };
type Listing = { uri: string; authorization: string } | null;
type Flight = { item: string; token: string; authorization: string; owner: Owner; outcome: ItemCheckOutcome | null };

const STATES: readonly ItemState[] = ["pending", "accepted", "rejected", "revoked"];
const SETTLE_ROUNDS = 40;

async function world() {
  const clock = { now: NOW };
  const t = await setup(clock);
  const o = await featuredOwner(t.web, "o", COLLECTIONS_ONLY);
  const x = await featuredOwner(t.web, "x", COLLECTIONS_ONLY, OTHER);
  // On O's server, so that O relays M's Deletes.
  const m = await storedMember(t, "m");
  const owners: Record<Owner, Owned> = { O: o, X: x };
  const w = {
    t,
    clock,
    owners,
    m,
    a: `${m.uri}/feature_authorizations/a`,
    b: `${m.uri}/feature_authorizations/b`,
    ids: { O: "", X: "" } as Record<Owner, string>,
    listings: { O: null, X: null } as Record<Owner, Listing>,
    items: 0,
    withdrawn: new Set<string>(),
    outbox: [] as string[],
    flights: [] as Flight[],
    policy: new FeaturePolicy(),
    stats: {} as Stats,
    trace: [] as string[],
  };
  for (const owner of ["O", "X"] as const) {
    serve(w, owner);
    w.ids[owner] = await storedOwner(t, owners[owner]);
  }
  await syncAll(t, t.web.loader, clock.now);
  w.trace.push("-- setup done");
  return w;
}

type World = Awaited<ReturnType<typeof world>>;

const collectionId = (w: World, owner: Owner) => `${w.owners[owner].uri}/collections/1`;

function listed(w: World, owner: Owner) {
  const listing = w.listings[owner];
  const items =
    listing === null
      ? []
      : [
          {
            id: listing.uri,
            type: "FeaturedItem",
            featuredObject: w.m.uri,
            featureAuthorization: listing.authorization,
          },
        ];
  return collection(w.owners[owner], items, {}, 1);
}

// The owner's collections as its server serves them: its one collection with its current listing.
function serve(w: World, owner: Owner): void {
  serveCollections(w.t.web, w.owners[owner], [[listed(w, owner)]]);
}

// ---------------------------------------------------------------------------------------------------------------
// The Store's items against the policy's
// ---------------------------------------------------------------------------------------------------------------

async function project(w: World): Promise<Partial<Record<Owner, Row>>> {
  const rows = await sql<{
    collection: string;
    uri: string;
    state: number;
    candidate: string;
    approval: string | null;
    due: number | null;
    attempts: number;
    token: string | null;
    changed: string;
  }>(
    w.t.store,
    `SELECT c.uri AS collection, i.uri, i.state, i.candidate_approval_uri AS candidate, i.approval_uri AS approval,
			i.check_due_at AS due, i.check_attempts AS attempts, i.check_token AS token, i.updated_at AS changed
		FROM collection_items i JOIN collections c ON c.id = i.collection_id ORDER BY c.uri`,
  );
  const out: Partial<Record<Owner, Row>> = {};
  for (const { collection: uri, state, changed, ...row } of rows) {
    const owner = uri === collectionId(w, "O") ? "O" : "X";
    expect(out[owner], `two items of ${owner}`).toBeUndefined();
    out[owner] = { ...row, state: STATES[state]!, changed: Date.parse(changed) };
  }
  return out;
}

async function check(w: World): Promise<void> {
  const context = w.trace.join("\n");
  expect(w.policy.problems, context).toEqual([]);
  expect(await project(w), context).toEqual(Object.fromEntries(w.policy.rows));
}

function step(w: World, line: string, ...labels: string[]): void {
  w.trace.push(`${w.trace.length} @${w.clock.now - NOW} ${line}${labels.length > 0 ? ` -> ${labels.join(", ")}` : ""}`);
  labels.forEach((label) => tally(w.stats, label));
}

// ---------------------------------------------------------------------------------------------------------------
// The owners: listings by a read, an Add, a Remove or an Update
// ---------------------------------------------------------------------------------------------------------------

// A read of every account whose sync is requested (the owner's own request among them), each applying the owner's
// current listing.
async function read(w: World): Promise<string[]> {
  const requested = new Set(
    (await sql<{ account_id: string }>(w.t.store, "SELECT account_id FROM collection_syncs")).map((r) => r.account_id),
  );
  const labels: string[] = [];
  for (const owner of ["O", "X"] as const) {
    if (requested.has(w.ids[owner])) {
      const listing = w.listings[owner];
      labels.push(
        listing === null
          ? w.policy.unlist(owner, null, "read", w.clock.now)
          : w.policy.list(owner, listing.uri, listing.authorization, "read", w.clock.now),
      );
    }
  }
  await syncAll(w.t, w.t.web.loader, w.clock.now);
  return labels;
}

async function post(w: World, actor: TestActor, activity: unknown): Promise<void> {
  expect(await w.t.post(actor, activity), w.trace.join("\n")).toBe(202);
}

async function convey(w: World, owner: Owner, path: Path, removed: string | null): Promise<string[]> {
  serve(w, owner);
  const actor = w.owners[owner];
  const listing = w.listings[owner];
  if (path === "read") {
    await requestSync(w.t, w.ids[owner]);
    return read(w);
  }
  if (path === "update") {
    const id = `${actor.uri}#updates/${nextId()}`;
    await post(w, actor, { "@context": AS, id, type: "Update", actor: actor.uri, object: listed(w, owner) });
  } else {
    // Mastodon's Add and Remove of an item: no id.
    const object = path === "add" ? listed(w, owner).orderedItems[0] : removed;
    const type = path === "add" ? "Add" : "Remove";
    await post(w, actor, { "@context": AS, type, actor: actor.uri, target: collectionId(w, owner), object });
  }
  return [
    listing === null
      ? w.policy.unlist(owner, removed, path, w.clock.now)
      : w.policy.list(owner, listing.uri, listing.authorization, path, w.clock.now),
  ];
}

// The owner lists M: O with `authorization` (its item kept, or a new one when it lists none), X with O's A.
async function list(w: World, owner: Owner, authorization: string, path: "read" | "add" | "update"): Promise<void> {
  const uri = w.listings[owner]?.uri ?? `${w.owners[owner].uri}/collection_items/${++w.items}`;
  w.listings[owner] = { uri, authorization: owner === "X" ? w.a : authorization };
  const auth = w.listings[owner].authorization === w.a ? "A" : "B";
  step(w, `${owner} lists M with ${auth} by ${path}`, ...(await convey(w, owner, path, null)), `via ${path}`);
}

async function unlist(w: World, owner: Owner, path: "read" | "remove" | "update"): Promise<void> {
  const removed = w.listings[owner]?.uri ?? null;
  if (removed === null) {
    return;
  }
  w.listings[owner] = null;
  step(w, `${owner} removes M by ${path}`, ...(await convey(w, owner, path, removed)), `via ${path}`);
}

// ---------------------------------------------------------------------------------------------------------------
// M's server
// ---------------------------------------------------------------------------------------------------------------

function withdraw(w: World, authorization: string): void {
  if (w.withdrawn.has(authorization)) {
    return;
  }
  w.withdrawn.add(authorization);
  w.outbox.push(authorization);
  step(w, `M withdraws ${authorization === w.a ? "A" : "B"}`, w.policy.withdraw(authorization));
}

// M's Delete of `authorization` (its authorizations name O's collection), sent by M or relayed by O with M's proof.
async function deliver(w: World, index: number, relayed: boolean): Promise<void> {
  if (w.outbox.length === 0) {
    return;
  }
  const [authorization] = w.outbox.splice(index % w.outbox.length, 1);
  const body = mastodonFeatureDelete(w.m, authorization!, collectionId(w, "O"));
  if (relayed) {
    const at = { created: signTime(w.clock.now), expires: signTime(w.clock.now + 2 * DAY_MS) };
    await post(w, w.owners.O, await mastodon47Signed(body, w.m, at));
  } else {
    const { "@context": _context, ...rest } = body;
    await post(w, w.m, { "@context": AS, ...rest });
  }
  const label = w.policy.deleteReceived(authorization!, "O", relayed, w.clock.now);
  step(w, `Delete(${authorization === w.a ? "A" : "B"}) ${relayed ? "relayed by O" : "from M"}`, label);
}

// ---------------------------------------------------------------------------------------------------------------
// Kopje's check rounds, split into their claim, fetches and completion, and the clock
// ---------------------------------------------------------------------------------------------------------------

async function claim(w: World): Promise<void> {
  const { checks } = await w.t.store.claimItemChecks(BUILD, { now: w.clock.now });
  const claimed = new Map<Owner, string>();
  for (const c of checks) {
    const owner = c.collection === collectionId(w, "O") ? "O" : "X";
    claimed.set(owner, c.token);
    w.flights.push({ item: c.item, token: c.token, authorization: c.authorization, owner, outcome: null });
  }
  step(w, `claim (${[...claimed.keys()].join(" ") || "none"})`, ...w.policy.claim(w.clock.now, claimed));
}

// A claimed check's fetch: M serves A and B for O's collection until it withdraws them.
function fetchOf(w: World, flight: Flight, transient: boolean): void {
  flight.outcome = transient
    ? "transient"
    : w.withdrawn.has(flight.authorization)
      ? "gone"
      : flight.owner === "O"
        ? "match"
        : "mismatch";
  step(w, `fetch ${flight.owner} ${flight.token.slice(0, 8)}`, w.policy.fetched(flight.token, flight.outcome));
}

async function complete(w: World, flight: Flight): Promise<void> {
  w.flights.splice(w.flights.indexOf(flight), 1);
  const { item, token, outcome } = flight;
  await w.t.store.completeItemChecks(BUILD, { now: w.clock.now, results: [{ item, token, outcome: outcome! }] });
  const label = w.policy.complete(token, outcome!, w.clock.now);
  step(w, `complete ${flight.owner} ${token.slice(0, 8)} ${outcome}`, label);
}

// The clock moves to the next due check (a lease running out or a backoff ending), or by a day (and the cron's cleanup
// runs).
function advance(w: World, day: boolean): void {
  const due = w.policy.nextDue();
  w.clock.now = day ? w.clock.now + DAY_MS + 1 : due !== null && due > w.clock.now ? due : w.clock.now + CHECK_LEASE_MS;
  step(w, `clock ${day ? "a day" : "to the next due"}`);
}

async function cleanup(w: World): Promise<void> {
  await w.t.store.pruneCollectionItems(BUILD, { now: w.clock.now });
  step(w, "cleanup", ...w.policy.cleanup(w.clock.now));
}

// ---------------------------------------------------------------------------------------------------------------
// Actions and runs
// ---------------------------------------------------------------------------------------------------------------

type Action =
  | { k: "list"; owner: Owner; b: boolean; path: "read" | "add" | "update" }
  | { k: "unlist"; owner: Owner; path: "read" | "remove" | "update" }
  | { k: "withdraw"; b: boolean }
  | { k: "deliver"; i: number; relayed: boolean }
  | { k: "claim" }
  | { k: "fetch"; i: number; transient: boolean }
  | { k: "complete"; i: number }
  | { k: "advance"; day: boolean }
  | { k: "cleanup" };

const ownerArb = fc.constantFrom<Owner>("O", "O", "O", "X");
const actionArb: fc.Arbitrary<Action> = fc.oneof(
  {
    arbitrary: fc.record({
      k: fc.constant("list" as const),
      owner: ownerArb,
      b: fc.constantFrom(false, false, true),
      path: fc.constantFrom("read" as const, "add" as const, "update" as const),
    }),
    weight: 4,
  },
  {
    arbitrary: fc.record({
      k: fc.constant("unlist" as const),
      owner: ownerArb,
      path: fc.constantFrom("read" as const, "remove" as const, "update" as const),
    }),
    weight: 2,
  },
  { arbitrary: fc.record({ k: fc.constant("withdraw" as const), b: fc.boolean() }), weight: 1 },
  { arbitrary: fc.record({ k: fc.constant("deliver" as const), i: fc.nat(3), relayed: fc.boolean() }), weight: 2 },
  { arbitrary: fc.constant({ k: "claim" as const }), weight: 4 },
  {
    arbitrary: fc.record({
      k: fc.constant("fetch" as const),
      i: fc.nat(3),
      transient: fc.constantFrom(false, false, false, true),
    }),
    weight: 3,
  },
  { arbitrary: fc.record({ k: fc.constant("complete" as const), i: fc.nat(3) }), weight: 3 },
  { arbitrary: fc.record({ k: fc.constant("advance" as const), day: fc.boolean() }), weight: 3 },
  { arbitrary: fc.constant({ k: "cleanup" as const }), weight: 1 },
);

async function act(w: World, a: Action): Promise<void> {
  switch (a.k) {
    case "list":
      await list(w, a.owner, a.b ? w.b : w.a, a.path);
      break;
    case "unlist":
      await unlist(w, a.owner, a.path);
      break;
    case "withdraw":
      withdraw(w, a.b ? w.b : w.a);
      break;
    case "deliver":
      await deliver(w, a.i, a.relayed);
      break;
    case "claim":
      await claim(w);
      break;
    case "fetch": {
      const unfetched = w.flights.filter((f) => f.outcome === null);
      if (unfetched.length > 0) {
        fetchOf(w, unfetched[a.i % unfetched.length]!, a.transient);
      }
      break;
    }
    case "complete": {
      const fetched = w.flights.filter((f) => f.outcome !== null);
      if (fetched.length > 0) {
        await complete(w, fetched[a.i % fetched.length]!);
      }
      break;
    }
    case "advance":
      advance(w, a.day);
      if (a.day) {
        await cleanup(w);
      }
      break;
    case "cleanup":
      await cleanup(w);
      break;
  }
  await check(w);
}

// Quiescence: every Delete delivered, every requested read run, the checks in flight abandoned (their leases run out),
// then check rounds whose fetches all complete until no item is queued; then the policy's quiescence relation.
async function settle(w: World): Promise<string> {
  w.trace.push("-- settle");
  while (w.outbox.length > 0) {
    await deliver(w, 0, false);
  }
  w.flights = [];
  if ((await sql(w.t.store, "SELECT 1 FROM collection_syncs")).length > 0) {
    step(w, "requested reads", ...(await read(w)));
  }
  await check(w);
  for (let round = 0; round < SETTLE_ROUNDS && w.policy.nextDue() !== null; round++) {
    w.clock.now = Math.max(w.clock.now, w.policy.nextDue()!);
    await claim(w);
    while (w.flights.length > 0) {
      fetchOf(w, w.flights[0]!, false);
      await complete(w, w.flights[0]!);
    }
    await check(w);
  }
  const context = w.trace.join("\n");
  expect(w.policy.nextDue(), context).toBeNull();
  const served = (authorization: string) => !w.withdrawn.has(authorization);
  const { problems, outcome } = w.policy.quiescence(served);
  expect(problems, context).toEqual([]);
  tally(w.stats, `quiescent: ${outcome}`);
  return outcome;
}

async function run(actions: readonly Action[]): Promise<World> {
  const w = await world();
  await check(w);
  for (const a of actions) {
    await act(w, a);
  }
  await settle(w);
  return w;
}

// Each transition kind the seed's runs reach (FeaturePolicy's labels), and each path.
const REQUIRED = [
  "O.lists:unchanged",
  "O.lists:new revision",
  "X.lists:new revision",
  "O.removes:removed",
  "K.cleanup",
  "M.withdraws",
  "K.Delete:revoked",
  "K.Delete:candidate-revoked",
  "K.Delete:nothing",
  "K.claim",
  "K.lease-expiry",
  "K.fetch:match",
  "K.fetch:404",
  "K.fetch:mismatch",
  "K.fetch:transient",
  "K.complete:accepted",
  "K.complete:rejected",
  "K.complete:mismatch",
  "K.complete:transient",
  "K.complete:fenced",
  "via read",
  "via add",
  "via remove",
  "via update",
  "quiescent: O: accepted (served)",
];

const CASES = 100;
const SEED = 1589;

describe("remote collections' items: Kopje against its policy (5-T20)", () => {
  it("agrees with the policy after every step, and accepts a served candidate once settled", async () => {
    const stats: Stats = {};
    await fc.assert(
      fc.asyncProperty(fc.array(actionArb, { minLength: 20, maxLength: 36 }), async (actions) => {
        for (const [key, n] of Object.entries((await run(actions)).stats)) {
          stats[key] = (stats[key] ?? 0) + n;
        }
      }),
      runs(CASES, SEED),
    );
    console.log("feature lifecycle coverage", JSON.stringify(stats, null, 1));
    // The seed's runs reach every kind (a replayed FC_SEED need not).
    if (inject("fcSeed") === "") {
      expect(REQUIRED.filter((key) => stats[key] === undefined)).toEqual([]);
    }
  }, 600_000);

  it("accepts O's item whose authorization X's item lists first", async () => {
    const w = await run([
      { k: "list", owner: "X", b: false, path: "read" },
      { k: "list", owner: "O", b: false, path: "add" },
      { k: "claim" },
      { k: "fetch", i: 0, transient: false },
      { k: "fetch", i: 0, transient: false },
      { k: "complete", i: 0 },
      { k: "complete", i: 0 },
    ]);
    expect(w.stats["quiescent: O: accepted (served)"]).toBe(1);
    expect(w.policy.rows.get("X")).toMatchObject({ state: "pending", approval: null, due: null });
  });

  it("changes nothing at a delayed Delete of A after O's change to B", async () => {
    const w = await run([
      { k: "list", owner: "O", b: false, path: "update" },
      { k: "claim" },
      { k: "fetch", i: 0, transient: false },
      { k: "complete", i: 0 },
      { k: "list", owner: "O", b: true, path: "update" },
      { k: "withdraw", b: false },
      { k: "deliver", i: 0, relayed: true },
    ]);
    expect(w.stats["K.Delete:nothing"]).toBe(1);
    expect(w.policy.rows.get("O")).toMatchObject({ state: "accepted", approval: w.b });
  });

  it("ends a revision's check after five expired leases (check-gave-up)", async () => {
    const lapse: Action[] = [{ k: "claim" }, { k: "advance", day: false }];
    const w = await run([
      { k: "list", owner: "O", b: false, path: "read" },
      ...Array.from({ length: 5 }, () => lapse).flat(),
    ]);
    expect(w.stats["quiescent: exception check-gave-up"]).toBe(1);
    expect(w.policy.rows.get("O")).toMatchObject({ state: "pending", attempts: 5, due: null, token: null });
    // The predicate needs every one of the five claims.
    const first = w.policy.log.findIndex((e) => e.k === "claim" && e.result === "claimed");
    expect(checkGaveUp(w.policy.log.toSpliced(first, 1), "O")).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 4-T9: a remote member R of alice's collection C (#1589's D17, D23 and D25; ID-6 and F1-F5 in
// docs/threat-model.md). alice (L) adds R, removes its item, adds it again, blocks and unblocks it; Kopje's lane
// delivers its bodies to R's inbox in order, sending its head twice when a lease ran out; R's server (MemberPeer,
// Mastodon v4.7.5) processes each delivered copy in a job of its own, in any order, consents or refuses, revokes,
// changes its policy, blocks and unblocks alice and runs its cleanup, and its deliveries reach Kopje in any order and
// again; Kopje's check rounds verify an Accept that followed a deletion, at 5 attempts. After every step the Store
// equals MemberPolicy (test/feature-model.ts), its lane included, and the policy's safety rules hold; at quiescence
// Kopje equals R outside F1-F5, and a request R accepted that no one ended is accepted on both sides unless its check
// gave up (F4).
// ---------------------------------------------------------------------------------------------------------------

const CAN_FEATURE = { interactionPolicy: { canFeature: { automaticApproval: [PUBLIC] } } };

type MemberFlight = { token: string; authorization: string; outcome: ItemCheckOutcome | null };

async function memberWorld() {
  const clock = { now: NOW };
  const t = await setup(clock);
  const r = await mastodonActor(t.web, "r", { extra: CAN_FEATURE });
  // Stored by its Follow of dave; alice and R follow neither, so alice's block sends R its Block alone.
  await t.post(r, { "@context": AS, id: `${r.uri}#follows/1`, type: "Follow", actor: r.uri, object: DAVE_URI });
  const rId = (await accountId(t.store, r.uri))!;
  const made = await alice(t, "POST", "/api/v1/collections", { name: "c", sensitive: false, discoverable: true });
  const cId = (made.body.collection as { id: string }).id;
  const log: MemberLogged[] = [];
  const peer = new MemberPeer(r.uri, log);
  // The lane starts after the setup's own deliveries (dave's Accept of R's Follow).
  await settleDeliveries(t.store, clock.now);
  const { since } = (
    await sql<{ since: number }>(t.store, "SELECT coalesce(max(id), 0) AS since FROM outbound_activities")
  )[0]!;
  return {
    since,
    t,
    clock,
    r,
    rId,
    cId,
    cUri: `${ALICE_URI}/collections/${cId}`,
    peer,
    policy: new MemberPolicy(log, peer.issued),
    log,
    // Kopje's lane to R: the bodies the Store recorded for R's inboxes, in order, and how many were delivered.
    lane: [] as ToMember[],
    delivered: 0,
    // The copies delivered to R's inbox that its server has not processed.
    jobs: [] as ToMember[],
    flights: [] as MemberFlight[],
    stats: {} as Stats,
    trace: [] as string[],
  };
}

type MemberWorld = Awaited<ReturnType<typeof memberWorld>>;

async function alice(t: Setup, method: string, path: string, body?: unknown) {
  const response = await t.request(path, {
    method,
    headers: { authorization: `Bearer ${t.tokens.alice}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: (text === "" ? {} : JSON.parse(text)) as Record<string, unknown> };
}

async function memberRow(w: MemberWorld): Promise<MemberRow | undefined> {
  const [row] = await sql<{
    id: string;
    request: string;
    state: number;
    approval: string | null;
    candidate: string | null;
    retracted: string | null;
    due: number | null;
    attempts: number;
    token: string | null;
    changed: string;
  }>(
    w.t.store,
    `SELECT id, activity_uri AS request, state, approval_uri AS approval, candidate_approval_uri AS candidate,
			retracted_approval_uri AS retracted, check_due_at AS due, check_attempts AS attempts, check_token AS token,
			updated_at AS changed
		FROM collection_items WHERE collection_id = ? AND account_id = ?`,
    w.cId,
    w.rId,
  );
  if (row === undefined) {
    return undefined;
  }
  const { id, state, changed, ...rest } = row;
  return { item: `${ALICE_URI}/collection_items/${id}`, ...rest, state: STATES[state]!, changed: Date.parse(changed) };
}

function toMember(activity: Record<string, unknown>): ToMember {
  const object = activity.object as string | Record<string, string>;
  const id = typeof object === "string" ? object : object.id!;
  switch (activity.type) {
    case "FeatureRequest":
      return { type: "FeatureRequest", request: String(activity.id) };
    case "Add":
      return { type: "Add", item: id, authorization: (object as Record<string, string>).featureAuthorization! };
    case "Remove":
      return { type: "Remove", item: id };
    case "Block":
      return { type: "Block", id: String(activity.id) };
    case "Undo":
      return { type: "Undo", id };
  }
  throw new Error(`unexpected ${String(activity.type)} for R`);
}

// The bodies the Store recorded with a delivery to R's inbox or its server's shared inbox, in record order.
async function laneOf(w: MemberWorld): Promise<ToMember[]> {
  await settleDeliveries(w.t.store, w.clock.now);
  const rows = await sql<{ body: string }>(
    w.t.store,
    `SELECT a.body FROM outbound_activities a
		WHERE a.id > ? AND EXISTS (SELECT 1 FROM deliveries d WHERE d.activity_id = a.id AND d.inbox_url IN (?, ?))
		ORDER BY a.id`,
    w.since,
    `${w.r.uri}/inbox`,
    `${new URL(w.r.uri).origin}/inbox`,
  );
  return rows.map((row) => toMember((JSON.parse(row.body) as { activity: Record<string, unknown> }).activity));
}

async function memberCheck(w: MemberWorld): Promise<void> {
  const context = w.trace.join("\n");
  expect(w.policy.problems, context).toEqual([]);
  expect(await memberRow(w), context).toEqual(w.policy.row);
  w.lane = await laneOf(w);
  expect(w.lane, context).toEqual(w.policy.queued);
}

function memberStep(w: MemberWorld, line: string, ...labels: string[]): void {
  w.trace.push(`${w.trace.length} @${w.clock.now - NOW} ${line}${labels.length > 0 ? ` -> ${labels.join(", ")}` : ""}`);
  labels.forEach((label) => tally(w.stats, label));
}

// ---- alice through the API

async function addMember(w: MemberWorld): Promise<void> {
  const added = await alice(w.t, "POST", `/api/v1/collections/${w.cId}/items`, { account_id: w.rId });
  const row = added.status === 200 ? await memberRow(w) : undefined;
  const label = w.policy.add(row?.item ?? null, row?.request ?? null, w.clock.now);
  const expected = ({ "L.add:pending": 200, "L.add:refused": 403, "L.add:taken": 422 } as Record<string, number>)[
    label
  ];
  expect(added.status, w.trace.join("\n")).toBe(expected);
  memberStep(w, "L adds R", label);
}

async function removeMember(w: MemberWorld): Promise<void> {
  const row = w.policy.row;
  if (row === undefined) {
    return;
  }
  const id = row.item.slice(row.item.lastIndexOf("/") + 1);
  const removed = await alice(w.t, "DELETE", `/api/v1/collections/${w.cId}/items/${id}`);
  expect(removed.status, w.trace.join("\n")).toBe(200);
  memberStep(w, "L removes R's item", w.policy.remove());
}

async function blockUri(w: MemberWorld): Promise<string> {
  const [block] = await sql<{ uri: string }>(
    w.t.store,
    "SELECT uri FROM blocks WHERE account_id = (SELECT id FROM accounts WHERE uri = ?) AND target_account_id = ?",
    ALICE_URI,
    w.rId,
  );
  return block!.uri;
}

async function blockMember(w: MemberWorld): Promise<void> {
  if (w.policy.lBlocks) {
    return;
  }
  expect((await alice(w.t, "POST", `/api/v1/accounts/${w.rId}/block`)).status).toBe(200);
  // The block's Remove is released once its collection job has reached the owner's followers.
  for (let round = 0; round < 8 && (await sql(w.t.store, "SELECT 1 FROM collection_jobs")).length > 0; round++) {
    await w.t.store.runCollectionJobs(BUILD, { now: w.clock.now });
  }
  memberStep(w, "L blocks R", ...w.policy.block(await blockUri(w)));
}

async function unblockMember(w: MemberWorld): Promise<void> {
  if (!w.policy.lBlocks) {
    return;
  }
  const uri = await blockUri(w);
  expect((await alice(w.t, "POST", `/api/v1/accounts/${w.rId}/unblock`)).status).toBe(200);
  memberStep(w, "L unblocks R", w.policy.unblock(uri));
}

// ---- Kopje's lane and R's server

function deliverToMember(w: MemberWorld, dup: boolean): void {
  const head = w.lane[w.delivered];
  if (head === undefined) {
    return;
  }
  w.jobs.push(head);
  if (!dup) {
    w.delivered++;
  }
  memberStep(w, `${dup ? "a copy of " : ""}${head.type} to R`, dup ? "K.dup" : "K.deliver");
}

function processAtMember(w: MemberWorld, pick: number | ((m: ToMember) => boolean)): void {
  const index = typeof pick === "number" ? pick % Math.max(w.jobs.length, 1) : w.jobs.findIndex(pick);
  if (w.jobs[index] === undefined) {
    return;
  }
  const [job] = w.jobs.splice(index, 1);
  const now = w.clock.now;
  const label =
    job!.type === "FeatureRequest"
      ? w.peer.featureRequest(job!.request, now)
      : job!.type === "Add"
        ? w.peer.add(job!.item, job!.authorization, now)
        : job!.type === "Remove"
          ? w.peer.remove(job!.item)
          : job!.type === "Block"
            ? w.peer.receivedBlock(job!.id)
            : w.peer.receivedUndo(job!.id);
  memberStep(w, `R processes ${job!.type}`, label);
}

function bodyOf(w: MemberWorld, message: FromMember): Record<string, unknown> {
  const actor = w.r.uri;
  switch (message.type) {
    case "Accept":
      return {
        "@context": AS,
        id: message.id,
        type: "Accept",
        actor,
        to: ALICE_URI,
        object: message.request,
        result: message.result,
      };
    case "Reject":
      // RejectFeatureRequestSerializer#id of the unsaved item it builds: no id after the path.
      return {
        "@context": AS,
        id: `${actor}#rejects/feature_requests/`,
        type: "Reject",
        actor,
        to: ALICE_URI,
        object: message.request,
      };
    case "Delete":
      return mastodonFeatureDelete(w.r, message.authorization, w.cUri);
    case "Block":
      return { "@context": AS, id: message.id, type: "Block", actor, object: ALICE_URI };
    case "Undo":
      return {
        "@context": AS,
        id: `${message.id}/undo`,
        type: "Undo",
        actor,
        object: { id: message.id, type: "Block", actor, object: ALICE_URI },
      };
  }
}

// One of R's deliveries reaching Kopje; a retry leaves it in R's outbox.
async function sendFromMember(w: MemberWorld, pick: number | ((m: FromMember) => boolean), dup: boolean) {
  const outbox = w.peer.outbox;
  const index = typeof pick === "number" ? pick % Math.max(outbox.length, 1) : outbox.findIndex(pick);
  const message = outbox[index];
  if (message === undefined) {
    return;
  }
  if (!dup) {
    outbox.splice(index, 1);
  }
  expect(await w.t.post(w.r, bodyOf(w, message)), w.trace.join("\n")).toBe(202);
  const now = w.clock.now;
  const label =
    message.type === "Accept"
      ? w.policy.accept(message.request, message.result, now)
      : message.type === "Reject"
        ? w.policy.reject(message.request, now)
        : message.type === "Delete"
          ? w.policy.deleted(message.authorization, now)
          : message.type === "Block"
            ? w.policy.blocked(message.id)
            : w.policy.unblocked(message.id);
  memberStep(w, `${dup ? "a retry of " : ""}R's ${message.type} to Kopje`, label);
}

// ---- Kopje's check rounds and the clock

async function memberClaim(w: MemberWorld): Promise<void> {
  const { checks } = await w.t.store.claimItemChecks(BUILD, { now: w.clock.now });
  for (const c of checks) {
    w.flights.push({ token: c.token, authorization: c.authorization, outcome: null });
  }
  memberStep(w, `claim (${checks.length})`, ...w.policy.claim(w.clock.now, checks[0]?.token ?? null));
}

// A claimed check's fetch: R's server serves an authorization while its item is accepted.
function memberFetch(w: MemberWorld, flight: MemberFlight, transient: boolean): void {
  flight.outcome = transient ? "transient" : w.peer.served(flight.authorization) ? "match" : "gone";
  memberStep(w, `fetch ${flight.token.slice(0, 8)}`, w.policy.fetched(flight.token, flight.outcome));
}

async function memberComplete(w: MemberWorld, flight: MemberFlight): Promise<void> {
  w.flights.splice(w.flights.indexOf(flight), 1);
  const row = await memberRow(w);
  const item = row?.item.slice(row.item.lastIndexOf("/") + 1) ?? "0";
  const results = [{ item, token: flight.token, outcome: flight.outcome! }];
  await w.t.store.completeItemChecks(BUILD, { now: w.clock.now, results });
  memberStep(
    w,
    `complete ${flight.token.slice(0, 8)} ${flight.outcome}`,
    w.policy.complete(flight.token, flight.outcome!, w.clock.now),
  );
}

async function memberAdvance(w: MemberWorld, day: boolean): Promise<void> {
  const due = w.policy.nextDue();
  w.clock.now = day ? w.clock.now + DAY_MS + 1 : due !== null && due > w.clock.now ? due : w.clock.now + CHECK_LEASE_MS;
  memberStep(w, `clock ${day ? "a day" : "to the next due"}`);
  if (day) {
    await w.t.store.pruneCollectionItems(BUILD, { now: w.clock.now });
    memberStep(w, "cleanups", ...w.policy.cleanup(w.clock.now), ...w.peer.cleanup(w.clock.now));
  }
}

// ---- Actions and runs

type MemberAction =
  | { k: "add" }
  | { k: "remove" }
  | { k: "block" }
  | { k: "unblock" }
  | { k: "deliver"; dup: boolean }
  | { k: "process"; i: number | ((m: ToMember) => boolean) }
  | { k: "send"; i: number | ((m: FromMember) => boolean); dup: boolean }
  | { k: "revoke" }
  | { k: "rblock" }
  | { k: "runblock" }
  | { k: "policy"; consent: boolean }
  | { k: "claim" }
  | { k: "fetch"; transient: boolean }
  | { k: "complete" }
  | { k: "advance"; day: boolean };

const memberActionArb: fc.Arbitrary<MemberAction> = fc.oneof(
  { arbitrary: fc.constant({ k: "add" as const }), weight: 4 },
  { arbitrary: fc.constant({ k: "remove" as const }), weight: 1 },
  { arbitrary: fc.constant({ k: "block" as const }), weight: 1 },
  { arbitrary: fc.constant({ k: "unblock" as const }), weight: 3 },
  {
    arbitrary: fc.record({ k: fc.constant("deliver" as const), dup: fc.constantFrom(false, false, false, true) }),
    weight: 6,
  },
  { arbitrary: fc.record({ k: fc.constant("process" as const), i: fc.nat(3) }), weight: 6 },
  {
    arbitrary: fc.record({
      k: fc.constant("send" as const),
      i: fc.nat(3),
      dup: fc.constantFrom(false, false, false, true),
    }),
    weight: 6,
  },
  { arbitrary: fc.constant({ k: "revoke" as const }), weight: 3 },
  { arbitrary: fc.constant({ k: "rblock" as const }), weight: 1 },
  { arbitrary: fc.constant({ k: "runblock" as const }), weight: 3 },
  {
    arbitrary: fc.record({ k: fc.constant("policy" as const), consent: fc.constantFrom(true, true, false) }),
    weight: 1,
  },
  { arbitrary: fc.constant({ k: "claim" as const }), weight: 3 },
  {
    arbitrary: fc.record({ k: fc.constant("fetch" as const), transient: fc.constantFrom(false, false, true) }),
    weight: 2,
  },
  { arbitrary: fc.constant({ k: "complete" as const }), weight: 2 },
  { arbitrary: fc.record({ k: fc.constant("advance" as const), day: fc.boolean() }), weight: 3 },
);

// Runs of single actions, with short steps the single ones reach rarely in order: Kopje's head carried through R's
// server and R's answer back to Kopje; alice's removal and add again; and the same after R revoked, then a day (R's
// cleanup frees it to accept), so that R's Delete of an earlier membership's authorization meets the new request.
const memberRunArb: fc.Arbitrary<MemberAction[]> = fc
  .array(
    fc.oneof(
      { arbitrary: memberActionArb.map((a) => [a]), weight: 8 },
      {
        arbitrary: fc.constant<MemberAction[]>([
          { k: "deliver", dup: false },
          { k: "process", i: 0 },
          { k: "send", i: 0, dup: false },
        ]),
        weight: 2,
      },
      { arbitrary: fc.constant<MemberAction[]>([{ k: "remove" }, { k: "add" }]), weight: 1 },
      {
        arbitrary: fc.constant<MemberAction[]>([
          { k: "revoke" },
          { k: "remove" },
          { k: "add" },
          { k: "advance", day: true },
        ]),
        weight: 1,
      },
    ),
    { minLength: 20, maxLength: 40 },
  )
  .map((groups) => groups.flat());

async function memberAct(w: MemberWorld, a: MemberAction): Promise<void> {
  const now = w.clock.now;
  switch (a.k) {
    case "add":
      await addMember(w);
      break;
    case "remove":
      await removeMember(w);
      break;
    case "block":
      await blockMember(w);
      break;
    case "unblock":
      await unblockMember(w);
      break;
    case "deliver":
      deliverToMember(w, a.dup);
      break;
    case "process":
      processAtMember(w, a.i);
      break;
    case "send":
      await sendFromMember(w, a.i, a.dup);
      break;
    case "revoke": {
      const label = w.peer.revoke("revoke", now);
      if (label !== null) {
        memberStep(w, "R revokes", label);
      }
      break;
    }
    case "rblock":
      memberStep(w, "R blocks L", ...w.peer.block(now));
      break;
    case "runblock":
      memberStep(w, "R unblocks L", ...w.peer.unblock());
      break;
    case "policy":
      memberStep(w, "R's policy", w.peer.setPolicy(a.consent));
      break;
    case "claim":
      await memberClaim(w);
      break;
    case "fetch": {
      const flight = w.flights.find((f) => f.outcome === null);
      if (flight !== undefined) {
        memberFetch(w, flight, a.transient);
      }
      break;
    }
    case "complete": {
      const flight = w.flights.find((f) => f.outcome !== null);
      if (flight !== undefined) {
        await memberComplete(w, flight);
      }
      break;
    }
    case "advance":
      await memberAdvance(w, a.day);
      break;
  }
  await memberCheck(w);
}

// Quiescence: the checks in flight abandoned (their leases run out); then, until nothing moves, Kopje's lane delivered,
// R's jobs processed, R's deliveries sent, and the due checks claimed, fetched and completed; then the relation.
async function memberSettle(w: MemberWorld): Promise<string> {
  w.trace.push("-- settle");
  w.flights = [];
  for (let round = 0; round < SETTLE_ROUNDS; round++) {
    const moving =
      w.delivered < w.lane.length || w.jobs.length > 0 || w.peer.outbox.length > 0 || w.policy.nextDue() !== null;
    if (!moving) {
      break;
    }
    while (w.delivered < w.lane.length) {
      await memberAct(w, { k: "deliver", dup: false });
    }
    while (w.jobs.length > 0) {
      await memberAct(w, { k: "process", i: 0 });
    }
    while (w.peer.outbox.length > 0) {
      await memberAct(w, { k: "send", i: 0, dup: false });
    }
    if (w.policy.nextDue() !== null) {
      w.clock.now = Math.max(w.clock.now, w.policy.nextDue()!);
      await memberAct(w, { k: "claim" });
      while (w.flights.length > 0) {
        await memberAct(w, { k: "fetch", transient: false });
        await memberAct(w, { k: "complete" });
      }
    }
  }
  const context = w.trace.join("\n");
  expect([w.lane.length - w.delivered, w.jobs.length, w.peer.outbox.length, w.policy.nextDue()], context).toEqual([
    0,
    0,
    0,
    null,
  ]);
  const { problems, outcome } = memberQuiescence(w.log, w.policy.row, w.peer.item);
  expect(problems, context).toEqual([]);
  tally(w.stats, `quiescent: ${outcome}`);
  return outcome;
}

async function memberRun(actions: readonly MemberAction[]): Promise<MemberWorld> {
  const w = await memberWorld();
  await memberCheck(w);
  for (const a of actions) {
    await memberAct(w, a);
  }
  await memberSettle(w);
  return w;
}

// Steps of the witnesses: Kopje's head to R (head), R's processing of a delivered body of a type, and R's delivery of a
// message of a type (an authorization of R's n-th item: A is 1, B is 2).
const head = (dup = false): MemberAction => ({ k: "deliver", dup });
const processes = (type: ToMember["type"]): MemberAction => ({ k: "process", i: (m) => m.type === type });
const auth = (n: number) => (a: string) => a.endsWith(`/feature_authorizations/${n}`);
const sends = (type: FromMember["type"], n?: number): MemberAction => ({
  k: "send",
  i: (m) =>
    m.type === type &&
    (n === undefined ||
      (m.type === "Accept" && auth(n)(m.result)) ||
      (m.type === "Delete" && auth(n)(m.authorization))),
  dup: false,
});
// A first membership accepted with A and named by its Add, then revoked by R and removed by alice, and R's item gone
// with its Remove; alice adds R again and R accepts with B: R's Delete(A) and Accept(B) wait in its outbox.
const REASKED: MemberAction[] = [
  { k: "add" },
  head(),
  processes("FeatureRequest"),
  sends("Accept", 1),
  head(),
  processes("Add"),
  { k: "revoke" },
  { k: "remove" },
  head(),
  processes("Remove"),
  { k: "add" },
  head(),
  processes("FeatureRequest"),
];
const DELETE_A = sends("Delete", 1);
const ACCEPT_B = sends("Accept", 2);
const DELETE_B = sends("Delete", 2);
const accepted = (w: MemberWorld, n: number) =>
  w.log.some(
    (e) =>
      (e.k === "K.Accept" && e.outcome === "accepted" && auth(n)(e.result)) ||
      (e.k === "K.complete" && e.result === "accepted"),
  );

// Each transition kind the seed's runs reach (MemberPolicy's and MemberPeer's labels), and the quiescent outcomes; the
// orders they reach rarely are the witnesses below.
const MEMBER_REQUIRED = [
  "L.add:pending",
  "L.add:taken",
  "L.add:refused",
  "L.remove:silent",
  "L.remove:Remove",
  "L.block",
  "L.unblock",
  "K.deliver",
  "K.dup",
  "K.Accept:accepted",
  "K.Accept:check",
  "K.Accept:ignored",
  "K.Reject:rejected",
  "K.Reject:ignored",
  "K.Delete:revoked",
  "K.Delete:candidate-revoked",
  "K.Delete:recorded",
  "K.Delete:nothing",
  "K.Block:blocked",
  "K.Undo:undone",
  "K.claim",
  "K.fetch:match",
  "K.complete:accepted",
  "K.cleanup",
  "R.FR:accepted",
  "R.FR:refused",
  "R.FR:invalid",
  "R.Add:named",
  "R.Add:unowned",
  "R.Remove:destroyed",
  "R.Remove:nothing",
  "R.revoke:revoke",
  "R.revoke:block",
  "R.block",
  "R.unblock",
  "R.policy:refuses",
  "R.Block:blocked",
  "R.Undo:unblocked",
  "R.cleanup",
  "quiescent: accepted",
  "quiescent: exception F2",
];

describe("a remote member of a local collection: Kopje against its policy and a Mastodon member (4-T9)", () => {
  it("agrees with the policy after every step, and with the member once settled outside F1-F5", async () => {
    const stats: Stats = {};
    await fc.assert(
      fc.asyncProperty(memberRunArb, async (actions) => {
        for (const [key, n] of Object.entries((await memberRun(actions)).stats)) {
          stats[key] = (stats[key] ?? 0) + n;
        }
      }),
      runs(CASES, SEED),
    );
    console.log("member lifecycle coverage", JSON.stringify(stats, null, 1));
    if (inject("fcSeed") === "") {
      expect(MEMBER_REQUIRED.filter((key) => stats[key] === undefined)).toEqual([]);
    }
  }, 600_000);

  it("changes nothing at a delayed Delete of A after a re-add accepted with B", async () => {
    const w = await memberRun([...REASKED, ACCEPT_B, DELETE_A]);
    expect(w.stats["K.Delete:nothing"]).toBe(1);
    expect(w.policy.row).toMatchObject({ state: "accepted" });
    expect(auth(2)(w.policy.row!.approval!)).toBe(true);
    expect(w.stats["quiescent: accepted"]).toBe(1);
  });

  // The six orders of Delete(A), Delete(B) and Accept(B), R having withdrawn B before its Delete: each ends revoked
  // with no membership; the two where both Deletes come first never accept B, and send no Add of it.
  const ORDERS: [string, MemberAction[], boolean][] = [
    ["Accept(B), Delete(A), Delete(B)", [ACCEPT_B, DELETE_A, DELETE_B], true],
    ["Accept(B), Delete(B), Delete(A)", [ACCEPT_B, DELETE_B, DELETE_A], true],
    ["Delete(A), Accept(B), Delete(B)", [DELETE_A, ACCEPT_B, DELETE_B], false],
    ["Delete(B), Accept(B), Delete(A)", [DELETE_B, ACCEPT_B, DELETE_A], false],
    ["Delete(A), Delete(B), Accept(B)", [DELETE_A, DELETE_B, ACCEPT_B], false],
    ["Delete(B), Delete(A), Accept(B)", [DELETE_B, DELETE_A, ACCEPT_B], false],
  ];
  it.each(ORDERS)("ends a membership revoked in the order %s", async (_name, order, passes) => {
    const w = await memberRun([...REASKED, { k: "revoke" }, ...order]);
    expect(w.policy.row?.state).toBe("revoked");
    expect(w.peer.item?.state).toBe("revoked");
    expect(accepted(w, 2)).toBe(passes);
    expect(w.policy.queued.some((m) => m.type === "Add" && auth(2)(m.authorization))).toBe(passes);
  });

  it("revokes at R's Delete of B after its Accept of B", async () => {
    const w = await memberRun([...REASKED, { k: "revoke" }, ACCEPT_B, DELETE_A, DELETE_B]);
    expect(w.stats["K.Accept:accepted"]).toBe(2);
    expect(w.stats["K.Delete:revoked"]).toBe(1);
    expect(w.policy.queued.at(-1)).toMatchObject({ type: "Remove" });
  });

  // A Reject between a check's claim (B fetched and served) and its completion: rejected, and the completion fenced. R
  // refused a second copy of the request it had accepted (F3).
  it("rejects at a Reject between a check's claim and its completion, and excuses R's copy refused (F3)", async () => {
    const w = await memberRun([
      ...REASKED.slice(0, -2),
      head(true),
      head(),
      processes("FeatureRequest"),
      DELETE_A,
      ACCEPT_B,
      { k: "claim" },
      { k: "fetch", transient: false },
      { k: "policy", consent: false },
      processes("FeatureRequest"),
      sends("Reject"),
      { k: "complete" },
    ]);
    expect(w.stats["K.Accept:check"]).toBe(1);
    expect(w.stats["K.fetch:match"]).toBe(1);
    expect(w.stats["K.complete:fenced"]).toBe(1);
    expect(w.policy.row).toMatchObject({ state: "rejected", candidate: null, due: null, token: null });
    expect(w.stats["quiescent: exception F3"]).toBe(1);
  });

  // A late Accept: R's retry of its Accept after its Delete, received first, revoked the item changes nothing (an Accept
  // changes only a pending item).
  it("ignores a retried Accept after the Delete received before it revoked the item", async () => {
    const w = await memberRun([
      { k: "add" },
      head(),
      processes("FeatureRequest"),
      { k: "revoke" },
      sends("Delete", 1),
      { k: "send", i: (m) => m.type === "Accept", dup: true },
      sends("Accept", 1),
    ]);
    expect(w.stats["K.Delete:recorded"]).toBe(1);
    expect(w.stats["K.Accept:revoked"]).toBe(1);
    expect(w.stats["K.Accept:ignored"]).toBe(1);
    expect(w.policy.row).toMatchObject({ state: "revoked", approval: null });
  });

  // F1: R's server processes the item's Remove before its Add, which then names R's item.
  it("excuses R's item named by an Add that its Remove overtook (F1)", async () => {
    const w = await memberRun([
      { k: "add" },
      head(),
      processes("FeatureRequest"),
      sends("Accept", 1),
      { k: "remove" },
      head(),
      head(),
      processes("Remove"),
      processes("Add"),
    ]);
    expect(w.policy.row).toBeUndefined();
    expect(w.peer.item).toMatchObject({ state: "accepted" });
    expect(w.stats["quiescent: exception F1"]).toBe(1);
  });

  // F5: a late copy of the first membership's Add names R's item of the second, whose Remove of the first then
  // destroys it.
  it("excuses R's item named by a late copy of an earlier membership's Add (F5)", async () => {
    const w = await memberRun([
      { k: "add" },
      head(),
      processes("FeatureRequest"),
      sends("Accept", 1),
      head(true),
      head(),
      processes("Add"),
      { k: "revoke" },
      sends("Delete", 1),
      { k: "remove" },
      { k: "add" },
      head(),
      head(),
      head(),
      processes("Remove"),
      processes("FeatureRequest"),
      ACCEPT_B,
      processes("Add"),
    ]);
    expect(w.stats["R.Add:named"]).toBe(2);
    expect(w.stats["quiescent: exception F5"]).toBe(1);
  });

  // F4: each of the check's five claims ran out, and the sixth ended it while R serves the candidate.
  it("excuses a check whose five claims ran out (F4)", async () => {
    const lapse: MemberAction[] = [{ k: "claim" }, { k: "advance", day: false }];
    const w = await memberRun([...REASKED, DELETE_A, ACCEPT_B, ...Array.from({ length: 5 }, () => lapse).flat()]);
    expect(w.stats["K.lease-expiry"]).toBe(5);
    expect(w.stats["K.claim:gave-up"]).toBe(1);
    expect(w.policy.row).toMatchObject({ state: "pending", attempts: 5, due: null });
    expect(w.stats["quiescent: exception F4"]).toBe(1);
  });
});
