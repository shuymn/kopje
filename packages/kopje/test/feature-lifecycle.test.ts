import fc from "fast-check";
import { describe, expect, inject, it } from "vitest";

import type { ItemCheckOutcome } from "../src/domain/collection-checks";
import { sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { mastodon47Signed, mastodonFeatureDelete, signTime } from "./author-proof-helpers";
import {
  CHECK_LEASE_MS,
  checkGaveUp,
  DAY_MS,
  FeaturePolicy,
  type ItemState,
  type Owner,
  type Path,
  type Row,
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
import type { TestActor } from "./inbox-helpers";
import { AS, nextId, OTHER, setup } from "./inbox-status-helpers";
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
