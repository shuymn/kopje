import fc from "fast-check";
import { describe, expect, inject, it } from "vitest";

import type { ItemCheckOutcome } from "../src/domain/collection-checks";
import { syncCollections } from "../src/federation/collections";
import { settleDeliveries, sql } from "./api-helpers";
import { inboxDeps, NOW } from "./app-helpers";
import { mastodon47Signed, mastodonFeatureDelete, signTime } from "./author-proof-helpers";
import {
  ANSWER_MARGIN_MS,
  CHECK_LEASE_MS,
  checkGaveUp,
  DAY_MS,
  type FromMember,
  type FromOwner,
  type FromOwnerServer,
  FeaturePolicy,
  type ItemState,
  MemberPeer,
  MemberPolicy,
  memberQuiescence,
  type MemberLogged,
  type MemberRow,
  type Owner,
  OwnerPeer,
  OwnerServer,
  type Path,
  type Row,
  type ToMember,
  type ToOwner,
  type ToOwnerServer,
} from "./feature-model";
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
  type LocalRow,
  nextDue,
  outbound,
  requestSync,
  seededMembers,
  serveCollections,
  serveListing,
  storedMember,
  storedOwner,
  syncAll,
} from "./featured-collection-helpers";
import { BUILD } from "./helpers";
import { mastodonActor, type TestActor } from "./inbox-helpers";
import {
  accountId,
  ALICE,
  ALICE_URI,
  AS,
  DAVE_URI,
  nextId,
  OTHER,
  PUBLIC,
  setup,
  type Setup,
} from "./inbox-status-helpers";
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
  "K.complete:retracted",
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

  // The Delete that revoked O's item is kept as M's retraction of A, which the check of O's later revision listing A
  // again reads.
  it("revokes at the check of A listed again after A's Delete revoked O's item", async () => {
    const checked: Action[] = [{ k: "claim" }, { k: "fetch", i: 0, transient: false }, { k: "complete", i: 0 }];
    const w = await run([
      { k: "list", owner: "O", b: false, path: "read" },
      ...checked,
      { k: "withdraw", b: false },
      { k: "deliver", i: 0, relayed: false },
      { k: "list", owner: "O", b: true, path: "update" },
      { k: "list", owner: "O", b: false, path: "update" },
      ...checked,
    ]);
    expect([w.stats["K.Delete:revoked"], w.stats["K.complete:retracted"]]).toEqual([1, 1]);
    expect(w.policy.rows.get("O")).toMatchObject({ state: "revoked", candidate: w.a, approval: null });
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
          ? w.peer.remove(job!.item, now)
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

// A claimed check's fetch: R's server serves an authorization while its item is accepted, and its cache for a while
// after (MemberPeer.fetched), so a fetch at the clock's moment of a withdrawal still matches.
function memberFetch(w: MemberWorld, flight: MemberFlight, transient: boolean): void {
  flight.outcome = transient ? "transient" : w.peer.fetched(flight.authorization, w.clock.now) ? "match" : "gone";
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
  "K.Delete:retracted",
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

  // R withdrew B, which its cache still serves; Kopje receives the delayed Delete(A), then Delete(B), then Accept(B). B's Delete is kept as R's retraction (A holds the item's first deletion), and the Accept
  // ends the item revoked without a check, so the cached B never accepts it. Fails if the Accept does not read the
  // retraction (Kopje queues a check the policy does not).
  it("never accepts B, served from R's cache, at Delete(A), Delete(B) and then Accept(B)", async () => {
    const w = await memberRun([...REASKED, { k: "revoke" }, DELETE_A, DELETE_B, ACCEPT_B, { k: "claim" }]);
    expect(w.stats["K.Delete:recorded"]).toBe(1);
    expect(w.stats["K.Delete:retracted"]).toBe(1);
    expect(w.stats["K.Accept:revoked"]).toBe(1);
    expect(w.stats["K.claim"]).toBeUndefined();
    // A check of B would have matched: R's cache still serves it.
    expect(w.peer.served(`${w.r.uri}/feature_authorizations/2`)).toBe(false);
    expect(w.peer.fetched(`${w.r.uri}/feature_authorizations/2`, w.clock.now)).toBe(true);
    expect(accepted(w, 2)).toBe(false);
    expect(w.policy.row).toMatchObject({ state: "revoked", approval: null });
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

// ---- 6-T5: a Mastodon v4.7.5 owner featuring a local member (#1589's D24), the owner peer of test/feature-model.ts.

type OwnerWorld = {
  t: Setup;
  owner: TestActor & { featuredCollections: string };
  listed: ReturnType<typeof collection>;
  ownerId: string;
  peer: OwnerPeer;
  // Kopje's answers handed to R (their intents), and the clock.
  handed: Set<string>;
  now: number;
  // Remote members R lists before L (the 26th-item witness).
  before: { uri: string }[];
};

let ownerWorlds = 0;

async function ownerWorld(before = 0): Promise<OwnerWorld> {
  const t = await setup();
  await sql(t.store, "UPDATE accounts SET discoverable = 1 WHERE id = ?", ALICE);
  const owner = await featuredOwner(t.web, `peer${++ownerWorlds}`, COLLECTIONS_ONLY);
  const listed = collection(owner, []);
  const w: OwnerWorld = {
    t,
    owner,
    listed,
    ownerId: "",
    peer: new OwnerPeer(new URL(owner.uri).origin),
    handed: new Set(),
    now: NOW,
    before: before === 0 ? [] : await seededMembers(t, before, `p${ownerWorlds}m`),
  };
  serveOwnerListing(w);
  w.ownerId = await storedOwner(t, owner);
  await syncAll(t);
  return w;
}

// R's featuredCollections as R serves it now: the remote members it lists first, then its accepted item of L.
function serveOwnerListing(w: OwnerWorld): void {
  w.listed.orderedItems = [
    ...w.before.map((member, n) => remoteItem(w.owner, member, 100_000 + n)),
    ...w.peer.listing().map(({ item, authorization }) => localItem(w.owner, ALICE_URI, authorization, item)),
  ];
  serveListing(w.t.web, w.owner, w.listed);
}

const itemBody = (w: OwnerWorld, type: "Add" | "Remove", item: number, authorization: string) => ({
  "@context": [...FEATURE_CONTEXT, { FeaturedItem: "https://w3id.org/fep/7aa9#FeaturedItem" }],
  type,
  actor: w.owner.uri,
  target: w.listed.id,
  object: localItem(w.owner, ALICE_URI, authorization, item),
});

// R's activities, delivered to Kopje in order.
async function toKopje(w: OwnerWorld, activities: FromOwner[]): Promise<void> {
  for (const activity of activities) {
    const body =
      activity.type === "FeatureRequest"
        ? featureRequest(w.owner, ALICE_URI, w.listed.id, activity.request)
        : itemBody(w, activity.type, activity.item, activity.type === "Add" ? activity.authorization : "");
    expect(await w.t.post(w.owner, body)).toBe(202);
  }
}

// Kopje's answers to R not handed over yet, in its lane's order; each is then delivered (its rows gone).
async function fromKopje(w: OwnerWorld): Promise<ToOwner[]> {
  const inbox = `${w.owner.uri}/inbox`;
  const fresh = (await outbound(w.t, ALICE)).filter(
    ({ id, superseded, deliveries }) =>
      !w.handed.has(id) && superseded === 0 && deliveries.some((d) => d.inbox === inbox && d.state !== "gave_up"),
  );
  for (const { id } of fresh) {
    w.handed.add(id);
    await sql(w.t.store, "DELETE FROM deliveries WHERE activity_id = CAST(? AS INTEGER)", id);
  }
  return fresh.map(({ activity }): ToOwner => {
    const object = activity.object;
    switch (activity.type) {
      case "Accept":
        return { type: "Accept", request: String(object), result: String(activity.result) };
      case "Reject":
        return { type: "Reject", request: String(object) };
      default:
        return { type: "Delete", authorization: (object as { id: string }).id };
    }
  });
}

// R processes each answer, its own activities that follow delivered to Kopje.
async function process(w: OwnerWorld, answers: ToOwner[], following = false): Promise<void> {
  for (const answer of answers) {
    await toKopje(w, w.peer.receive(answer, following));
  }
}

// alice revokes her item in R's collection.
async function revoke(w: OwnerWorld): Promise<void> {
  const [row] = await localRows(w.t, ALICE);
  const collectionId = (
    await sql<{ id: string }>(w.t.store, "SELECT id FROM collections WHERE uri = ?", w.listed.id)
  )[0]!.id;
  const response = await w.t.request(`/api/v1/collections/${collectionId}/items/${row!.id}/revoke`, {
    method: "POST",
    headers: { authorization: `Bearer ${w.t.tokens.alice}` },
  });
  expect(response.status).toBe(200);
}

// Quiescence: every wait ended and every read Kopje requested run, each read of R's listing as R serves it then, and
// the answers of those reads processed by R.
async function quiesce(w: OwnerWorld): Promise<void> {
  for (let step = 0; step < 16; step++) {
    await process(w, await fromKopje(w));
    const due = await nextDue(w.t);
    const syncs = await sql(w.t.store, "SELECT 1 FROM collection_syncs");
    if (due === null && syncs.length === 0) {
      return;
    }
    if (due !== null) {
      w.now = Math.max(w.now, due);
      await checkRound(w.t, w.now);
    }
    if ((await sql(w.t.store, "SELECT 1 FROM collection_syncs")).length > 0) {
      w.now += 60_000;
      serveOwnerListing(w);
      await syncAll(w.t, w.t.web.loader, w.now);
    }
  }
  throw new Error("no quiescence");
}

// One more read of R's collections (a refresh), its answers processed.
async function refresh(w: OwnerWorld): Promise<void> {
  w.now += 60_000;
  serveOwnerListing(w);
  await requestSync(w.t, w.ownerId);
  await syncAll(w.t, w.t.web.loader, w.now);
  await process(w, await fromKopje(w));
}

// Whether Kopje shows alice in R's collection: her row accepted (its authorization served).
const kopjeShows = async (w: OwnerWorld) => (await localRows(w.t, ALICE)).some((row) => row.state === 1);

describe("a Mastodon owner featuring a local member (6-T5)", () => {
  it("converges through the answer to R's Add when R processes Delete(A) before Accept(A)", async () => {
    const w = await ownerWorld();
    await toKopje(w, w.peer.add());
    const accept = await fromKopje(w);
    await revoke(w);
    const deleted = await fromKopje(w);
    expect(deleted.map((a) => a.type)).toEqual(["Delete"]);
    // R processes the Delete first (no item holds A yet), then the Accept: it accepts and distributes its Add.
    await process(w, [...deleted, ...accept]);
    // Before any read: the answer to R's Add alone ends R's acceptance.
    await process(w, await fromKopje(w));
    expect([w.peer.shows(), await kopjeShows(w)]).toEqual([false, false]);
    await quiesce(w);
    expect([w.peer.shows(), await kopjeShows(w)]).toEqual([false, false]);
    expect(w.peer.item?.state).toBe("revoked");
  });

  it("deletes the row at the wait's read when R removed L before processing the Accept, L not following", async () => {
    const w = await ownerWorld();
    await toKopje(w, w.peer.add());
    const accept = await fromKopje(w);
    await toKopje(w, w.peer.remove(false));
    await process(w, accept);
    await quiesce(w);
    expect([w.peer.shows(), await kopjeShows(w)]).toEqual([false, false]);
    expect(await localRows(w.t, ALICE)).toEqual([]);
  });

  it("converges through the answer to R's Add when R processes the Accept after the wait's read deleted the row (F6)", async () => {
    const w = await ownerWorld();
    await toKopje(w, w.peer.add());
    // The Accept is delivered, but R's backlog holds it past the wait.
    const accept = await fromKopje(w);
    await quiesce(w);
    expect(await localRows(w.t, ALICE)).toEqual([]);
    await process(w, accept);
    expect(w.peer.shows()).toBe(true);
    await quiesce(w);
    expect([w.peer.shows(), await kopjeShows(w)]).toEqual([false, false]);
  });

  it("converges through a read's answer when R's Add after a late Accept never reaches Kopje (F6)", async () => {
    const w = await ownerWorld();
    await toKopje(w, w.peer.add());
    const accept = await fromKopje(w);
    await quiesce(w);
    expect(await localRows(w.t, ALICE)).toEqual([]);
    // R accepts late and its delivery of the Add gives up: the next read of its collections lists the item.
    w.peer.receive(accept[0]!, false);
    await refresh(w);
    await quiesce(w);
    expect([w.peer.shows(), await kopjeShows(w)]).toEqual([false, false]);
  });

  it("converges when a duplicated Accept re-accepts after R revoked", async () => {
    const w = await ownerWorld();
    await toKopje(w, w.peer.add());
    const accept = await fromKopje(w);
    await process(w, accept);
    await revoke(w);
    await process(w, await fromKopje(w));
    expect(w.peer.item?.state).toBe("revoked");
    // Kopje's lane delivers the Accept a second time: R accepts again and distributes its Add.
    await process(w, accept);
    await quiesce(w);
    expect([w.peer.shows(), await kopjeShows(w)]).toEqual([false, false]);
  });

  it("keeps the row through R's Remove processed before its Add, until the wait's read", async () => {
    const w = await ownerWorld();
    await toKopje(w, w.peer.add());
    const accept = await fromKopje(w);
    const add = w.peer.receive(accept[0]!, true);
    // R removes L (L follows R, so its Remove reaches Kopje), and Kopje processes the Remove before the Add.
    await toKopje(w, w.peer.remove(true));
    expect(await localRows(w.t, ALICE)).toMatchObject([{ state: 1 }]);
    await toKopje(w, add);
    await quiesce(w);
    expect([w.peer.shows(), await kopjeShows(w)]).toEqual([false, false]);
  });

  it("leaves R alone showing an item it lists past its first 25 that no answer reached (F7)", async () => {
    const w = await ownerWorld(25);
    await toKopje(w, w.peer.add());
    const accept = await fromKopje(w);
    await quiesce(w);
    expect(await localRows(w.t, ALICE)).toEqual([]);
    // R accepts late; its Add is never delivered; L's item is R's 26th.
    w.peer.receive(accept[0]!, false);
    for (let n = 0; n < 2; n++) {
      await refresh(w);
    }
    expect([w.peer.shows(), await kopjeShows(w)]).toEqual([true, false]);
    expect(w.listed.orderedItems).toHaveLength(26);
  });
});

// ---- 6-T5 in generated orders: Kopje against a Mastodon v4.7.5 owner's server (OwnerServer, test/feature-model.ts).
// R adds, removes, re-adds and blocks L, runs its jobs when it chooses (its FeatureRequest retried, each distribution
// reaching L as computed when it runs, L following R or not), processes its inbox in any order and delivers to Kopje in
// any order, a delivery repeated or given up; L consents or refuses, revokes, blocks and unblocks; Kopje's lane delivers
// in order, a body once or twice; Kopje's waits come due whether or not R processed the answer, its reads run (one with
// an owner's activity between its claim and its completion), and the clock passes R's and Kopje's cleanups. L's item is
// R's first, or its 26th after 25 remote members. After every step the safety rules hold (serverCheck); after quiescence
// (every wait ended, every read Kopje requested run, R's and Kopje's queues empty) Kopje equals R, outside F7 and the
// freshness limit's two directions (equal after one more refresh read); progress holds when L consented throughout and
// no one ended the membership, outside F6 (R processed an Accept past the margin after its delivery) and F7.

type ServerWorld = {
  t: Setup;
  clock: { now: number };
  owner: TestActor & { featuredCollections: string };
  r: OwnerServer;
  listed: ReturnType<typeof collection>;
  ownerId: string;
  before: { uri: string }[];
  // alice's activities before the run, the ones handed to R (when), and R's inbox jobs with their delivery times.
  since: number;
  handed: Map<string, number>;
  // The answer the row's wait watched last (its answer after a step).
  watched: string | null;
  inbox: { message: ToOwnerServer; delivered: number }[];
  // R's blocks of L so far (each Block's id), and whether alice blocks R.
  blocks: number;
  lBlocks: boolean;
  // The safety rules' view: alice's activities checked, and Kopje's rows after the last step.
  seen: number;
  rows: LocalRow[];
  // When Kopje last delivered an answer to each of R's requests (the margin's start for R's processing of it).
  answered: Map<string, number>;
  // What ended or prevented a membership: L's revoke, refusal or block, or R's block, anywhere in the run (Kopje keeps
  // a retired row or a block's refusal past R's next request), and R's removal or a delivery R gave up, since R's latest
  // add. Progress is owed only without any.
  sticky: Set<string>;
  ended: Set<string>;
  stats: Stats;
  trace: string[];
};

let serverWorlds = 0;

async function serverWorld(before: number, following: boolean): Promise<ServerWorld> {
  const clock = { now: NOW };
  const t = await setup(clock);
  await sql(t.store, "UPDATE accounts SET discoverable = 1 WHERE id = ?", ALICE);
  const n = ++serverWorlds;
  const owner = await featuredOwner(t.web, `srv${n}`, COLLECTIONS_ONLY);
  const r = new OwnerServer(new URL(owner.uri).origin);
  r.follow(following);
  const w: ServerWorld = {
    t,
    clock,
    owner,
    r,
    listed: collection(owner, []),
    ownerId: "",
    before: before === 0 ? [] : await seededMembers(t, before, `s${n}m`),
    since: 0,
    handed: new Map(),
    watched: null,
    inbox: [],
    blocks: 0,
    lBlocks: false,
    seen: 0,
    rows: [],
    answered: new Map(),
    sticky: new Set(),
    ended: new Set(),
    stats: {},
    trace: [],
  };
  serveServer(w);
  w.ownerId = await storedOwner(t, owner);
  await syncAll(t, t.web.loader, clock.now);
  await settleDeliveries(t.store, clock.now);
  w.since = (await sql<{ n: number }>(t.store, "SELECT coalesce(max(id), 0) AS n FROM outbound_activities"))[0]!.n;
  w.seen = w.since;
  w.trace.push(`-- R ${owner.uri}, ${before} members before L, L ${following ? "follows" : "does not follow"} R`);
  return w;
}

// R's featuredCollections as R serves it now: the remote members it lists first, then its accepted item of L.
function serveServer(w: ServerWorld): void {
  w.listed.orderedItems = [
    ...w.before.map((member, n) => remoteItem(w.owner, member, 200_000 + n)),
    ...w.r.listing().map(({ item, authorization }) => localItem(w.owner, ALICE_URI, authorization, item)),
  ];
  serveListing(w.t.web, w.owner, w.listed);
}

function serverStep(w: ServerWorld, line: string, ...labels: string[]): void {
  w.trace.push(`${w.trace.length} @${w.clock.now - NOW} ${line}${labels.length > 0 ? ` -> ${labels.join(", ")}` : ""}`);
  labels.forEach((label) => tally(w.stats, label));
}

const serverInboxes = (w: ServerWorld) => [`${w.owner.uri}/inbox`, `${new URL(w.owner.uri).origin}/inbox`];

function toOwnerServer(activity: Record<string, unknown>): ToOwnerServer {
  switch (activity.type) {
    case "Accept":
      return { type: "Accept", request: String(activity.object), result: String(activity.result) };
    case "Reject":
      return { type: "Reject", request: String(activity.object) };
    case "Delete":
      return { type: "Delete", authorization: (activity.object as { id: string }).id };
    case "Block":
      return { type: "Block" };
    case "Undo":
      return { type: "Undo" };
  }
  throw new Error(`unexpected ${String(activity.type)} for R`);
}

// The next body of Kopje's lane to R not handed over: alice's activities with a delivery to R's inbox or its server's
// shared inbox, in record order, a superseded one never sent.
async function serverLaneHead(w: ServerWorld): Promise<{ id: string; message: ToOwnerServer } | undefined> {
  await settleDeliveries(w.t.store, w.clock.now);
  const rows = await sql<{ id: string; body: string }>(
    w.t.store,
    `SELECT CAST(a.id AS TEXT) AS id, a.body FROM outbound_activities a
		WHERE a.account_id = ?1 AND a.id > ?2 AND a.superseded = 0
			AND EXISTS (SELECT 1 FROM deliveries d WHERE d.activity_id = a.id AND d.inbox_url IN (?3, ?4))
		ORDER BY a.id`,
    ALICE,
    w.since,
    ...serverInboxes(w),
  );
  const head = rows.find((row) => !w.handed.has(row.id));
  return head === undefined
    ? undefined
    : {
        id: head.id,
        message: toOwnerServer((JSON.parse(head.body) as { activity: Record<string, unknown> }).activity),
      };
}

// Kopje's lane delivers its head to R, once or twice (its deliveries to R then gone).
async function deliverToServer(w: ServerWorld, dup: boolean): Promise<void> {
  const head = await serverLaneHead(w);
  if (head === undefined) {
    return;
  }
  w.handed.set(head.id, w.clock.now);
  await sql(
    w.t.store,
    "DELETE FROM deliveries WHERE activity_id = CAST(?1 AS INTEGER) AND inbox_url IN (?2, ?3)",
    head.id,
    ...serverInboxes(w),
  );
  for (let copy = 0; copy < (dup ? 2 : 1); copy++) {
    w.inbox.push({ message: head.message, delivered: w.clock.now });
  }
  if (head.message.type === "Accept" || head.message.type === "Reject") {
    w.answered.set(head.message.request, w.clock.now);
  }
  serverStep(w, `${dup ? "two copies of " : ""}${head.message.type} to R`, dup ? "K.dup" : "K.deliver");
}

function serverBody(w: ServerWorld, message: FromOwnerServer): Record<string, unknown> {
  const actor = w.owner.uri;
  const block = `${actor}#blocks/${w.blocks}`;
  switch (message.type) {
    case "FeatureRequest":
      return featureRequest(w.owner, ALICE_URI, w.listed.id, message.request);
    case "Add":
    case "Remove":
      return {
        "@context": [...FEATURE_CONTEXT, { FeaturedItem: "https://w3id.org/fep/7aa9#FeaturedItem" }],
        type: message.type,
        actor,
        target: w.listed.id,
        object: localItem(w.owner, ALICE_URI, message.type === "Add" ? message.authorization : "", message.item),
      };
    case "Block":
      return { "@context": AS, id: block, type: "Block", actor, object: ALICE_URI };
    case "Undo":
      return {
        "@context": AS,
        id: `${block}/undo`,
        type: "Undo",
        actor,
        object: { id: block, type: "Block", actor, object: ALICE_URI },
      };
  }
}

const freshTypes = async (w: ServerWorld) =>
  (
    await sql<{ body: string }>(
      w.t.store,
      "SELECT body FROM outbound_activities WHERE account_id = ? AND id > ? ORDER BY id",
      ALICE,
      w.seen,
    )
  ).map(({ body }) => (JSON.parse(body) as { activity: { type: string } }).activity.type);

// What Kopje did with R's delivery, by alice's new activities and her row before and after.
async function kopjeEffect(w: ServerWorld, message: FromOwnerServer, before: LocalRow | undefined): Promise<string> {
  const fresh = await freshTypes(w);
  const [after] = await localRows(w.t, ALICE);
  switch (message.type) {
    case "FeatureRequest":
      if (fresh.includes("Accept")) {
        return before === undefined
          ? "K.FR:accepted"
          : before.activity_uri === message.request
            ? "K.FR:repeated"
            : "K.FR:reaccepted";
      }
      if (fresh.includes("Reject")) {
        return before === undefined ? "K.FR:refused" : before.state === 1 ? "K.FR:refused-held" : "K.FR:retired";
      }
      return "K.FR:none";
    case "Add":
      return fresh.includes("Delete")
        ? "K.Add:answered"
        : after?.uri !== null && after?.uri !== before?.uri
          ? "K.Add:listed"
          : "K.Add:none";
    case "Remove":
      return (await sql(w.t.store, "SELECT 1 FROM collection_syncs")).length > 0 ? "K.Remove:read" : "K.Remove:none";
    default:
      return `K.${message.type}`;
  }
}

// One of R's deliveries reaching Kopje; a repeated one stays in R's outbox.
async function sendFromServer(w: ServerWorld, index: number, dup: boolean): Promise<void> {
  const outbox = w.r.outbox;
  const at = index % Math.max(outbox.length, 1);
  const message = outbox[at];
  if (message === undefined) {
    return;
  }
  if (!dup) {
    outbox.splice(at, 1);
  }
  const [before] = await localRows(w.t, ALICE);
  expect(await w.t.post(w.owner, serverBody(w, message)), w.trace.join("\n")).toBe(202);
  serverStep(w, `${dup ? "a repeat of " : ""}R's ${message.type} to Kopje`, await kopjeEffect(w, message, before));
}

// A read of R's collections that Kopje requested, R's listing served as it is at the claim. `between`: R's steps between
// the claim that fetches R's featured collections and its completion (a split read). Each of the Store's claims while
// the read runs reads at its own time, the rows as they are then (a read a step requests is claimed again in the same
// run, after the change).
async function readAtKopje(
  w: ServerWorld,
  kind: "read" | "refresh" | "split",
  between: readonly ServerAction[] = [],
): Promise<void> {
  if (kind === "refresh") {
    await requestSync(w.t, w.ownerId);
  }
  if ((await sql(w.t.store, "SELECT 1 FROM collection_syncs")).length === 0) {
    return;
  }
  w.clock.now += 60_000;
  const claim = w.clock.now;
  serveServer(w);
  const rounds: { claim: number; before: LocalRow[] }[] = [];
  let hooked: number | undefined;
  const page = `${w.owner.featuredCollections}?page=1`;
  let split = kind !== "split";
  const loader = {
    ...w.t.web.loader,
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      // After R's steps, R serves its listing as it is then (the round the Store reads again: an inbound change marks
      // the read under way outdated).
      if (split && kind === "split") {
        serveServer(w);
      }
      const response = await w.t.web.fetch(request);
      if (!split && request.url === page) {
        split = true;
        hooked = rounds.length - 1;
        w.clock.now = claim + 30_000;
        for (const a of between) {
          await serverAct(w, a);
        }
        rounds[hooked]!.before = await localRows(w.t, ALICE);
        w.clock.now = claim + 60_000;
      }
      return response;
    },
  };
  const store = new Proxy(w.t.store, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== "function") {
        return value;
      }
      // An RPC method has no bind or apply of its own (each would be another RPC call).
      return async (...args: unknown[]) => {
        if (key === "claimCollectionSync") {
          rounds.push({ claim: w.clock.now, before: await localRows(w.t, ALICE) });
        }
        return Reflect.apply(value, target, args) as unknown;
      };
    },
  });
  const deps = { ...inboxDeps(() => store, loader), now: () => w.clock.now };
  for (let round = 0; round < 8 && (await syncCollections(w.t.env, deps)); round++) {
    // Another sync waits.
  }
  const after = await localRows(w.t, ALICE);
  const reads = rounds.map((round, k) => ({ ...round, after: rounds[k + 1]?.before ?? after }));
  const labels: string[] = (reads[hooked ?? 0]?.before ?? []).map((row) => {
    const now = after.find((other) => other.id === row.id);
    return now === undefined
      ? "K.read:deleted"
      : now.uri !== null && now.uri !== row.uri
        ? "K.read:listed"
        : row.check_due_at !== null
          ? "K.read:kept-waiting"
          : row.state !== 1
            ? "K.read:kept-retired"
            : "K.read:kept-listed";
  });
  // The claim that read R's listing kept a row changed after it (the next claim may delete it).
  const read = hooked === undefined ? undefined : reads[hooked];
  if (
    read?.before.some(
      (row) =>
        row.state === 1 &&
        row.check_due_at === null &&
        Date.parse(row.updated_at) >= read.claim &&
        read.after.some((one) => one.id === row.id),
    )
  ) {
    labels.push("K.read:kept-changed");
  }
  if ((await freshTypes(w)).includes("Delete")) {
    labels.push("K.read:answered");
  }
  serverStep(w, `Kopje's ${kind}`, ...labels);
  await serverCheck(w, reads);
}

// Kopje's next check round, the clock moved to its due check unless `now` (a round only if one is due already). A wait
// ends no sooner than ANSWER_MARGIN_MS after R was handed the answer it watched (D21: it polls the answer's delivery,
// then gives R the margin).
async function waitAtKopje(w: ServerWorld, now = false): Promise<void> {
  const due = await nextDue(w.t);
  if (due === null || (now && due > w.clock.now)) {
    return;
  }
  w.clock.now = Math.max(w.clock.now, due);
  const [before] = await localRows(w.t, ALICE);
  await checkRound(w.t, w.clock.now);
  const [after] = await localRows(w.t, ALICE);
  const label =
    before?.check_due_at === null || before === undefined || before.check_due_at > w.clock.now
      ? "K.checks"
      : after?.check_due_at === null
        ? "K.wait:ended"
        : before.answer !== null && after?.answer === null
          ? "K.wait:delivered"
          : "K.wait:polled";
  serverStep(w, "Kopje's checks come due", label);
  const handed = w.watched === null ? undefined : w.handed.get(w.watched);
  if (label === "K.wait:ended" && handed !== undefined) {
    expect(w.clock.now - handed, w.trace.join("\n")).toBeGreaterThanOrEqual(ANSWER_MARGIN_MS);
  }
}

async function serverCollectionId(w: ServerWorld): Promise<string> {
  return (await sql<{ id: string }>(w.t.store, "SELECT id FROM collections WHERE uri = ?", w.listed.id))[0]!.id;
}

type ServerAction =
  | { k: "radd" }
  | { k: "rremove" }
  | { k: "rblock" }
  | { k: "runblock" }
  | { k: "run"; i: number; again: boolean }
  | { k: "process"; i: number }
  | { k: "send"; i: number; dup: boolean }
  | { k: "drop"; i: number }
  | { k: "deliver"; dup: boolean }
  | { k: "revoke" }
  | { k: "consent"; on: boolean }
  | { k: "lblock" }
  | { k: "lunblock" }
  | { k: "follow"; on: boolean }
  | { k: "wait" }
  | { k: "checks" }
  | { k: "hour" }
  | { k: "day" }
  | { k: "read" }
  | { k: "split"; i: number; by: "process" | "send" | "checks" }
  | { k: "refresh" };

async function serverAct(w: ServerWorld, a: ServerAction): Promise<void> {
  switch (a.k) {
    case "radd": {
      const label = w.r.add();
      if (label === "R.add") {
        w.ended.clear();
      }
      serverStep(w, "R adds L", label);
      break;
    }
    case "rremove": {
      const label = w.r.remove();
      if (label === "R.remove") {
        w.ended.add(label);
      }
      serverStep(w, "R removes L", label);
      break;
    }
    case "rblock":
      if (!w.r.blocks) {
        w.blocks++;
        w.sticky.add("R.block");
      }
      serverStep(w, "R blocks L", w.r.block());
      break;
    case "runblock":
      serverStep(w, "R unblocks L", w.r.unblock());
      break;
    case "run":
      if (w.r.jobs.length > 0) {
        serverStep(w, `R runs a job${a.again ? " (retried later)" : ""}`, w.r.run(a.i % w.r.jobs.length, a.again));
      }
      break;
    case "process": {
      const [job] = w.inbox.splice(a.i % Math.max(w.inbox.length, 1), 1);
      if (job !== undefined) {
        const { message } = job;
        const latest = message.type === "Accept" ? (w.answered.get(message.request) ?? job.delivered) : job.delivered;
        serverStep(w, `R processes ${message.type}`, w.r.receive(message, latest, w.clock.now));
      }
      break;
    }
    case "send":
      await sendFromServer(w, a.i, a.dup);
      break;
    case "drop":
      if (w.r.outbox.length > 0) {
        w.ended.add("R.drop");
        serverStep(w, "R's delivery gives up", w.r.drop(a.i % w.r.outbox.length));
      }
      break;
    case "deliver":
      await deliverToServer(w, a.dup);
      break;
    case "revoke": {
      const row = w.rows.find((one) => one.state === 1);
      if (row !== undefined) {
        const revoked = await alice(
          w.t,
          "POST",
          `/api/v1/collections/${await serverCollectionId(w)}/items/${row.id}/revoke`,
        );
        expect(revoked.status, w.trace.join("\n")).toBe(200);
        w.sticky.add("L.revoke");
        serverStep(w, "L revokes", "L.revoke");
      }
      break;
    }
    case "consent":
      await sql(w.t.store, "UPDATE accounts SET discoverable = ? WHERE id = ?", a.on ? 1 : 0, ALICE);
      if (!a.on) {
        w.sticky.add("L.refuses");
      }
      serverStep(w, `L ${a.on ? "consents" : "refuses"}`, a.on ? "L.consents" : "L.refuses");
      break;
    case "lblock":
      if (!w.lBlocks) {
        expect((await alice(w.t, "POST", `/api/v1/accounts/${w.ownerId}/block`)).status).toBe(200);
        for (let round = 0; round < 8 && (await sql(w.t.store, "SELECT 1 FROM collection_jobs")).length > 0; round++) {
          await w.t.store.runCollectionJobs(BUILD, { now: w.clock.now });
        }
        w.lBlocks = true;
        w.sticky.add("L.block");
        serverStep(w, "L blocks R", "L.block");
      }
      break;
    case "lunblock":
      if (w.lBlocks) {
        expect((await alice(w.t, "POST", `/api/v1/accounts/${w.ownerId}/unblock`)).status).toBe(200);
        w.lBlocks = false;
        serverStep(w, "L unblocks R", "L.unblock");
      }
      break;
    case "follow":
      serverStep(w, `L ${a.on ? "follows" : "unfollows"} R`, w.r.follow(a.on));
      break;
    case "wait":
      await waitAtKopje(w);
      break;
    case "checks":
      await waitAtKopje(w, true);
      break;
    case "hour":
      w.clock.now += 3_600_000;
      serverStep(w, "an hour");
      break;
    case "day": {
      w.clock.now += DAY_MS + 1;
      await w.t.store.pruneCollectionItems(BUILD, { now: w.clock.now });
      const cleaned = w.r.cleanup();
      serverStep(w, "a day: the cleanups", "K.cleanup", ...(cleaned === null ? [] : [cleaned]));
      break;
    }
    case "read":
    case "refresh":
      await readAtKopje(w, a.k);
      return;
    case "split":
      if (a.by === "checks") {
        // A read claimed just before the next check comes due, which runs between its claim and its completion.
        const due = await nextDue(w.t);
        if (due !== null) {
          w.clock.now = Math.max(w.clock.now, due - 90_000);
          await requestSync(w.t, w.ownerId);
          await readAtKopje(w, "split", [{ k: "checks" }]);
        }
      } else if (w.r.outbox.length > 0 || w.inbox.length > 0) {
        await readAtKopje(w, "split", a.by === "process" ? [PROCESS, RUN, SEND] : [{ k: "send", i: a.i, dup: false }]);
      }
      return;
  }
  await serverCheck(w);
}

// The safety rules after a step, from alice's new activities, her rows and her consent:
//   - an answer names a request R made;
//   - an Accept grants the authorization of a row that is accepted with its wait queued, and, while L does not consent
//     (not discoverable, or a block either way), only repeats the row's own request;
//   - no Delete names an authorization Kopje serves;
//   - while L blocks R, no row is accepted;
//   - a read deletes only a row that is accepted, not waiting, and unchanged since its claim;
//   - a wait ends no sooner than ANSWER_MARGIN_MS after R was handed its answer (waitAtKopje).
async function serverCheck(
  w: ServerWorld,
  reads: readonly { claim: number; before: LocalRow[]; after: LocalRow[] }[] = [],
): Promise<void> {
  const context = w.trace.join("\n");
  const rows = await localRows(w.t, ALICE);
  const fresh = await sql<{ id: number; body: string }>(
    w.t.store,
    "SELECT id, body FROM outbound_activities WHERE account_id = ? AND id > ? ORDER BY id",
    ALICE,
    w.seen,
  );
  const consents =
    (
      await sql<{ consents: number }>(
        w.t.store,
        `SELECT (SELECT discoverable FROM accounts WHERE id = ?1) = 1 AND NOT EXISTS (SELECT 1 FROM blocks
				WHERE (account_id = ?1 AND target_account_id = ?2) OR (account_id = ?2 AND target_account_id = ?1)) AS consents`,
        ALICE,
        w.ownerId,
      )
    )[0]!.consents === 1;
  const named = (authorization: string) =>
    rows.find((row) => authorization === `${ALICE_URI}/feature_authorizations/${row.id}`);
  for (const { id, body } of fresh) {
    w.seen = id;
    const activity = (JSON.parse(body) as { activity: Record<string, unknown> }).activity;
    if (activity.type === "Accept" || activity.type === "Reject") {
      expect(w.r.requests.has(String(activity.object)), context).toBe(true);
    }
    if (activity.type === "Accept") {
      const row = named(String(activity.result));
      expect([row?.state, row?.check_due_at === null], context).toEqual([1, false]);
      if (!consents) {
        expect(
          w.rows.some((one) => one.state === 1 && one.activity_uri === activity.object),
          context,
        ).toBe(true);
      }
    }
    if (activity.type === "Delete") {
      expect(named((activity.object as { id: string }).id)?.state, context).not.toBe(1);
    }
  }
  if (w.lBlocks) {
    expect(
      rows.filter((row) => row.state === 1),
      context,
    ).toEqual([]);
  }
  for (const read of reads) {
    for (const row of read.before) {
      if (!read.after.some((one) => one.id === row.id)) {
        expect([row.state, row.check_due_at, Date.parse(row.updated_at) < read.claim], context).toEqual([
          1,
          null,
          true,
        ]);
      }
    }
  }
  w.rows = rows;
  w.watched = rows.find((row) => row.answer !== null)?.answer ?? w.watched;
}

// Quiescence: until nothing moves, Kopje's lane delivered, R's inbox processed, its jobs run and its deliveries sent,
// every read Kopje requested run and every due wait or check advanced.
async function serverSettle(w: ServerWorld): Promise<void> {
  w.trace.push("-- settle");
  for (let round = 0; round < SETTLE_ROUNDS * 2; round++) {
    let moved = false;
    while ((await serverLaneHead(w)) !== undefined) {
      await serverAct(w, { k: "deliver", dup: false });
      moved = true;
    }
    while (w.inbox.length > 0) {
      await serverAct(w, { k: "process", i: 0 });
      moved = true;
    }
    while (w.r.jobs.length > 0) {
      await serverAct(w, { k: "run", i: 0, again: false });
      moved = true;
    }
    while (w.r.outbox.length > 0) {
      await serverAct(w, { k: "send", i: 0, dup: false });
      moved = true;
    }
    if ((await sql(w.t.store, "SELECT 1 FROM collection_syncs")).length > 0) {
      await serverAct(w, { k: "read" });
    } else if ((await nextDue(w.t)) !== null) {
      await serverAct(w, { k: "wait" });
    } else if (!moved) {
      return;
    }
  }
  throw new Error(`no quiescence\n${w.trace.join("\n")}`);
}

// After quiescence: Kopje shows L in R's collection exactly when R does, except F7 (L's item past R's first 25,
// accepted by R, no answer of Kopje's reaching R after) and the freshness limit's two directions, which one more refresh
// read closes: R ended its item without L hearing of it (no Remove reached L), or R accepted it and its Add never
// reached Kopje. Progress: when L consented throughout, R asked, and no one ended the membership, both show it, unless R
// processed an Accept past the margin after its delivery (F6) or L's item is past R's first 25 (F7).
async function serverQuiescence(w: ServerWorld): Promise<string> {
  await serverSettle(w);
  const context = w.trace.join("\n");
  const kopjeShowsIt = async () => (await localRows(w.t, ALICE)).some((row) => row.state === 1);
  const f7 = async () => w.before.length > 0 && w.r.shows() && !(await kopjeShowsIt());
  let outcome: string;
  if ((await kopjeShowsIt()) === w.r.shows()) {
    outcome = w.r.shows() ? "both" : "neither";
  } else if (await f7()) {
    outcome = "F7";
  } else {
    const direction = w.r.shows() ? "acceptance" : "removal";
    expect(direction === "acceptance" ? w.r.lostAdd : w.r.unheardEnd, context).toBe(true);
    await serverAct(w, { k: "refresh" });
    await serverSettle(w);
    expect((await kopjeShowsIt()) === w.r.shows() || (await f7()), w.trace.join("\n")).toBe(true);
    outcome = `freshness: ${direction}`;
  }
  const owed = w.sticky.size === 0 && w.ended.size === 0 && w.r.requests.size > 0 && !w.r.late && w.before.length === 0;
  if (owed) {
    expect(outcome, context).toBe("both");
    tally(w.stats, "progress owed");
  }
  if (w.r.late) {
    tally(w.stats, "F6");
  }
  tally(w.stats, `quiescent: ${outcome}`);
  return outcome;
}

const serverActionArb: fc.Arbitrary<ServerAction> = fc.oneof(
  { arbitrary: fc.constant({ k: "radd" as const }), weight: 2 },
  { arbitrary: fc.constant({ k: "rremove" as const }), weight: 1 },
  { arbitrary: fc.constant({ k: "rblock" as const }), weight: 1 },
  { arbitrary: fc.constant({ k: "runblock" as const }), weight: 2 },
  {
    arbitrary: fc.record({ k: fc.constant("run" as const), i: fc.nat(3), again: fc.constantFrom(false, false, true) }),
    weight: 5,
  },
  { arbitrary: fc.record({ k: fc.constant("process" as const), i: fc.nat(3) }), weight: 5 },
  {
    arbitrary: fc.record({ k: fc.constant("send" as const), i: fc.nat(3), dup: fc.constantFrom(false, false, true) }),
    weight: 5,
  },
  { arbitrary: fc.record({ k: fc.constant("drop" as const), i: fc.nat(3) }), weight: 1 },
  { arbitrary: fc.record({ k: fc.constant("deliver" as const), dup: fc.constantFrom(false, false, true) }), weight: 5 },
  { arbitrary: fc.constant({ k: "revoke" as const }), weight: 1 },
  { arbitrary: fc.record({ k: fc.constant("consent" as const), on: fc.boolean() }), weight: 1 },
  { arbitrary: fc.constant({ k: "lblock" as const }), weight: 1 },
  { arbitrary: fc.constant({ k: "lunblock" as const }), weight: 2 },
  { arbitrary: fc.record({ k: fc.constant("follow" as const), on: fc.boolean() }), weight: 1 },
  { arbitrary: fc.constant({ k: "wait" as const }), weight: 4 },
  { arbitrary: fc.constant({ k: "hour" as const }), weight: 1 },
  { arbitrary: fc.constant({ k: "day" as const }), weight: 2 },
  { arbitrary: fc.constant({ k: "read" as const }), weight: 2 },
  {
    arbitrary: fc.record({
      k: fc.constant("split" as const),
      i: fc.nat(3),
      by: fc.constantFrom("process" as const, "send" as const, "checks" as const),
    }),
    weight: 3,
  },
  { arbitrary: fc.constant({ k: "refresh" as const }), weight: 1 },
);

// The steps the prefixes below are made of.
const RUN: ServerAction = { k: "run", i: 0, again: false };
const SEND: ServerAction = { k: "send", i: 0, dup: false };
const DELIVER: ServerAction = { k: "deliver", dup: false };
const PROCESS: ServerAction = { k: "process", i: 0 };
const WAIT: ServerAction = { k: "wait" };
const READ: ServerAction = { k: "read" };
const DAY: ServerAction = { k: "day" };
const REQUESTED: ServerAction[] = [{ k: "radd" }, RUN, SEND];

// A membership carried through from R's add, R's Add listed, and its wait run out.
const CARRIED: ServerAction[] = [...REQUESTED, DELIVER, PROCESS, RUN, SEND, WAIT, WAIT, WAIT, READ];

// Orders a run may start from, each one the design's 6-T5 names a mutation for, and which single actions reach rarely:
//   - L follows R; the membership carried through with Kopje's Accept delivered twice; L revokes; R processes the Delete
//     and its Remove reaches Kopje, whose read sees the item revoked; then R processes the second Accept and re-accepts,
//     and its Add after its Remove reaches Kopje with no read to follow (D24's answer to the Add, whatever the Remove's
//     retraction);
//   - R's request retried after Kopje's Accept was delivered and its margin began, the second Accept delivered three
//     days later, and R processing the first a day past the first margin (the wait queued again by the repeat);
//   - Kopje's Accept delivered two days after it was recorded, a wait polling before (its delivery queued, its one
//     target expanded as it was recorded), and R processing it two days after the delivery (the margin counted from
//     the delivery);
//   - the wait run out before R processes the Accept, which it does between a read's claim and its completion, its Add
//     reaching Kopje then (the read outdated, and the next one deciding);
//   - Kopje's Accept delivered and its margin begun, then a read claimed just before the margin ends, the wait ending
//     between its claim and its completion (a read keeping a row changed after its claim);
//   - the membership carried through and its Add's copy left in R's outbox; R removes and re-adds L; Kopje accepts the
//     new request with the row's authorization; the stale copy of the first Add then reaches Kopje, and a refresh read
//     runs before R processes the new Accept, the first item's Remove reaching Kopje after (the answer naming this
//     request, an Add that ends no wait, a Remove that deletes no row).
const PREFIXES: ServerAction[][] = [
  [],
  [],
  [],
  CARRIED,
  [...CARRIED, { k: "rremove" }, RUN],
  [
    { k: "follow", on: true },
    ...REQUESTED,
    { k: "deliver", dup: true },
    PROCESS,
    RUN,
    SEND,
    WAIT,
    WAIT,
    WAIT,
    READ,
    { k: "revoke" },
    DELIVER,
    { k: "process", i: 1 },
    RUN,
    SEND,
    READ,
    PROCESS,
    RUN,
    SEND,
  ],
  [
    { k: "radd" },
    { k: "run", i: 0, again: true },
    SEND,
    DELIVER,
    WAIT,
    DAY,
    DAY,
    DAY,
    RUN,
    SEND,
    DELIVER,
    DAY,
    WAIT,
    READ,
    PROCESS,
  ],
  [...REQUESTED, WAIT, DAY, DAY, DELIVER, DAY, DAY, WAIT, READ, PROCESS],
  [...REQUESTED, DELIVER, WAIT, WAIT, { k: "split", i: 0, by: "process" }],
  [...REQUESTED, DELIVER, WAIT, { k: "split", i: 0, by: "checks" }],
  [
    ...REQUESTED,
    DELIVER,
    PROCESS,
    RUN,
    { k: "send", i: 0, dup: true },
    { k: "rremove" },
    { k: "radd" },
    { k: "run", i: 1, again: false },
    { k: "send", i: 1, dup: false },
    SEND,
    { k: "refresh" },
  ],
];

// What ends or refuses a membership; a calm run has none of it, so progress is owed there unless F6 or F7.
const ENDING = new Set<ServerAction["k"]>(["rremove", "rblock", "drop", "revoke", "lblock"]);
const calmed = (a: ServerAction) => !ENDING.has(a.k) && !(a.k === "consent" && !a.on);

// Runs of single actions, with short steps the single ones reach rarely in order: R's request carried to Kopje;
// Kopje's answer carried through R and its distribution back to Kopje; R's request retried, alone or after L revoked;
// a read of R's listing before R's Add reaches Kopje; Kopje's head processed by R past the margin after its delivery;
// (its Add then given up, or not), and the waits run out before R removes L. A run may start from a membership carried through (and removed by R), and
// a calm run leaves out every action that ends or refuses a membership.
const serverRunArb = fc
  .record({
    before: fc.constantFrom(0, 0, 0, 25),
    following: fc.boolean(),
    calm: fc.constantFrom(false, false, true),
    prefix: fc.constantFrom(...PREFIXES),
    short: fc.constantFrom(false, false, false, true),
    groups: fc.array(
      fc.oneof(
        { arbitrary: serverActionArb.map((a) => [a]), weight: 8 },
        {
          arbitrary: fc.constant<ServerAction[]>([
            { k: "radd" },
            { k: "run", i: 0, again: false },
            { k: "send", i: 0, dup: false },
          ]),
          weight: 2,
        },
        {
          arbitrary: fc.constant<ServerAction[]>([
            { k: "deliver", dup: false },
            { k: "process", i: 0 },
            { k: "run", i: 0, again: false },
            { k: "send", i: 0, dup: false },
          ]),
          weight: 3,
        },
        ...[[], [{ k: "revoke" as const }]].map((between) => ({
          arbitrary: fc.constant<ServerAction[]>([
            { k: "radd" },
            { k: "run", i: 0, again: true },
            { k: "send", i: 0, dup: false },
            ...between,
            { k: "run", i: 0, again: false },
            { k: "send", i: 0, dup: false },
          ]),
          weight: 1,
        })),
        {
          arbitrary: fc.constant<ServerAction[]>([
            { k: "deliver", dup: false },
            { k: "process", i: 0 },
            { k: "refresh" },
          ]),
          weight: 1,
        },
        ...[[], [{ k: "run", i: 0, again: false } as const, { k: "drop", i: 0 } as const]].map((after) => ({
          arbitrary: fc.constant<ServerAction[]>([
            { k: "deliver", dup: false },
            ...Array.from({ length: 5 }, (): ServerAction => ({ k: "day" })),
            { k: "wait" },
            { k: "wait" },
            { k: "read" },
            { k: "process", i: 0 },
            ...after,
          ]),
          weight: 1,
        })),
        {
          arbitrary: fc.constant<ServerAction[]>([
            { k: "wait" },
            { k: "wait" },
            { k: "wait" },
            { k: "read" },
            { k: "rremove" },
            { k: "run", i: 0, again: false },
          ]),
          weight: 1,
        },
      ),
      { minLength: 14, maxLength: 28 },
    ),
  })
  .map(({ before, following, calm, prefix, short, groups }) => {
    const suffix = short ? [] : groups.flat();
    return { before, following, actions: [...prefix, ...(calm ? suffix.filter(calmed) : suffix)] };
  });

async function serverRun(before: number, following: boolean, actions: readonly ServerAction[]): Promise<ServerWorld> {
  const w = await serverWorld(before, following);
  await serverCheck(w);
  for (const a of actions) {
    await serverAct(w, a);
  }
  await serverQuiescence(w);
  return w;
}

// Each transition kind the seed's runs reach, and the quiescent outcomes.
const SERVER_REQUIRED = [
  "R.add",
  "R.remove",
  "R.block",
  "R.unblock",
  "R.run:FeatureRequest",
  "R.run:Add",
  "R.run:Remove",
  "R.run:Remove-unreached",
  "R.Accept:accepted",
  "R.Accept:ignored",
  "R.Reject:rejected",
  "R.Delete:revoked",
  "R.Block",
  "R.cleanup",
  "K.deliver",
  "K.dup",
  "K.FR:accepted",
  "K.FR:repeated",
  "K.FR:reaccepted",
  "K.FR:refused",
  "K.FR:retired",
  "K.Add:listed",
  "K.Add:answered",
  "K.Remove:read",
  "K.Block",
  "K.wait:polled",
  "K.wait:delivered",
  "K.wait:ended",
  "K.read:deleted",
  "K.read:listed",
  "K.read:kept-waiting",
  "K.read:kept-retired",
  "K.read:kept-changed",
  "K.read:answered",
  "L.revoke",
  "L.refuses",
  "L.block",
  "quiescent: both",
  "quiescent: neither",
  "quiescent: F7",
  "quiescent: freshness: removal",
  "quiescent: freshness: acceptance",
  "progress owed",
  "F6",
];

const SERVER_CASES = 100;

describe("a Mastodon owner featuring a local member, in generated orders (6-T5)", () => {
  it("keeps the safety rules after every step, and agrees with the owner after quiescence outside F6 and F7", async () => {
    const stats: Stats = {};
    let steps = 0;
    await fc.assert(
      fc.asyncProperty(serverRunArb, async ({ before, following, actions }) => {
        const w = await serverRun(before, following, actions);
        steps += w.trace.length;
        for (const [key, n] of Object.entries(w.stats)) {
          stats[key] = (stats[key] ?? 0) + n;
        }
      }),
      runs(SERVER_CASES, SEED),
    );
    console.log("owner lifecycle coverage", steps, JSON.stringify(stats, null, 1));
    if (inject("fcSeed") === "") {
      expect(SERVER_REQUIRED.filter((key) => stats[key] === undefined)).toEqual([]);
    }
  }, 600_000);
});
