import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { pruneCollectionItems } from "../src/domain/collections";
import { expandPending, MAX_BACKLOG, MAX_LANE_BACKLOG, retryDeliveries } from "../src/domain/deliveries";
import { purgeBatch } from "../src/domain/inbox";
import { SYNC_LEASE_MS } from "../src/domain/remote-collections";
import { MAX_REMOTE_ITEMS } from "../src/domain/remote-featured-collections";
import { syncCollections } from "../src/federation/collections";
import { deliveryRound, type RoundResult } from "../src/jobs/deliver";
import { sha256Hex } from "../src/security/tokens";
import { bearer, form, setSetting, sql } from "./api-helpers";
import { inboxDeps, NOW } from "./app-helpers";
import {
  type Activity,
  type Actual,
  type AuthorizationGet,
  compareObservation,
  type Envelope,
  type Environment,
  type Fixture,
  type Recorded,
  type Row,
  type Step,
} from "./collection-consent-observe";
import {
  collection,
  COLLECTIONS_ONLY,
  FEATURE_CONTEXT,
  featuredOwner,
  featureRequest,
  item,
  localItem,
  serveCollections,
  storedOwner,
  syncAll,
} from "./featured-collection-helpers";
import { LOCAL, MASTODON, type TestActor } from "./inbox-helpers";
import { ALICE, ALICE_URI, AS, DAVE, OTHER, retractionsAtCap, type Setup, setup } from "./inbox-status-helpers";
import { deliveryDeps } from "./quote-helpers";

// The replay of spec/collection-consent/'s fixtures (test/fixtures/collection-consent/, written from the TLA+
// specification by `pnpm --filter kopje spec:fixtures`) against the real Store: each fixture's steps are taken
// through the paths Kopje takes them (the inbox, the collections part of a sync, the delivery rounds, the API, the
// cron's and the operator's operations), the interleavings the specification orders made explicit by gates on the
// fetches and the Store calls of a read and of a request's instrument, and after each step the Store's observation
// is compared with the fixture's (test/collection-consent-observe.ts compareObservation). R is the remote owner
// (Mastodon), C its collection, L alice, X another owner on R's server; dave is the third account that views C.
// Steps of R's own (its requests, jobs and services) and the network's (Drop) change nothing in the Store: what
// reaches Kopje is the envelope of a later step, which carries what R sends.

const FIXTURES = import.meta.glob<Fixture>("./fixtures/collection-consent/*.json", { eager: true, import: "default" });

// Each fixture, by name (spec test: each must appear here as a string literal).
const NAMES = [
  "S1-Accepted",
  "S1-AcceptedPolicyOff",
  "S1-F3",
  "S1-KDup",
  "S1-Shown",
  "S10-SlotsRecovered",
  "S10-SlotsReject",
  "S11-EvictedF8",
  "S11-RCleanLateAccept",
  "S12-DroppedDelivery",
  "S12-SuspendedListing",
  "S12-SuspendedOmission",
  "S12-SuspendedRequest",
  "S12-Unsuspended",
  "S13-HeldRecovered",
  "S14-Order7",
  "S14-Order7Restored",
  "S15-IgnoredThenStale",
  "S2-AnswerCoalesced",
  "S2-Answered",
  "S2-CleanupThenDelete",
  "S2-Corrected",
  "S2-F7",
  "S2-F8",
  "S2-F8ThenF7",
  "S2-LeaseFailed",
  "S2-LeaseFailedOrdinary",
  "S2-LeaseSuperseded",
  "S2-ReadOverRetraction",
  "S2-ReclaimSuperseded",
  "S2-RetractionAdmitted",
  "S3-OV2Shown",
  "S4-AnsweredX",
  "S4-AnsweredXRefused",
  "S4-EmbeddedUnserved",
  "S4-LeaseFailedBesideX",
  "S4-RecvXAdd",
  "S4-RetiredRemoved",
  "S5-FencedByPush",
  "S5-FencedByRow",
  "S5-Hidden",
  "S5-KStale",
  "S5-LeaseApplies",
  "S5-OV2Hidden",
  "S5-OV2Shown",
  "S5-ReadHid",
  "S5-StaleOmits",
  "S6-BlockRow",
  "S7-KRetry",
  "S8-FetchExisting",
  "S8-FetchOutdates",
  "S8-GoneFetch",
  "S8-GonePurged",
  "S8-GoneRead",
  "S8-KExpire",
  "S8-KPurge",
  "S8-Kept",
  "S8-OwnerGoneRow",
  "S8-Refused503",
  "S8-RemovalGuard",
  "S8-Retried503",
  "S9-HeldReject",
  "S9-RecvUpd",
  "S9-TruncatedKeeps",
  "S9-TruncatedShows",
] as const;

const fixtureNamed = (name: string): Fixture => {
  const found = FIXTURES[`./fixtures/collection-consent/${name}.json`];
  if (found === undefined) {
    throw new Error(`no fixture ${name}`);
  }
  return found;
};

type Deferred = { promise: Promise<void>; resolve: () => void };
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

// A read of R's collections under way: its claim made, its fetches let through at its KFetch (or its two pages at
// KFetch1 and KFetch2), its completion held until its KApply or KStale.
type Round = {
  done: Promise<boolean>;
  claimed: Deferred;
  fetches: Deferred;
  split: boolean;
  secondPageReached: Deferred;
  secondPage: Deferred;
  completionReached: Deferred;
  completion: Deferred;
};

type World = {
  t: Setup;
  clock: { now: number };
  owner: TestActor & { featuredCollections: string };
  ownerId: string;
  x: TestActor & { featuredCollections: string };
  xId: string;
  xCollection: ReturnType<typeof collection>;
  c: ReturnType<typeof collection>;
  requests: Record<string, string>;
  rows: string[];
  aliceToken: string;
  adminToken: string;
  rounds: Round[];
  // A request's instrument fetch: held for the next one, or reached and awaiting its KApplyFetch.
  instrument: { reached: Promise<void>; release: () => void } | null;
  fetching: { posting: Promise<number>; release: () => void } | null;
  // The delivery round KLeaseHead holds at its POST to R's server.
  flight: Flight | null;
  // Every delivery round a step started: each is answered and awaited when the replay ends, so a POST an assertion
  // left held never outlives the test.
  flights: Flight[];
  environment: Environment;
  // The outbound rows seen by the last observation (an id is reused once its row is deleted, so a row is keyed by
  // its id, its time and its body).
  seen: Set<string>;
  notified: number;
  fillers: number;
  // The inboxes of L's followers, which her revocation reaches besides the owner's: none, as in the specification
  // (init checks that no remote account follows her).
  followers: string[];
};

const AP = { accept: "application/activity+json" };
let worlds = 0;

// A credential of alice's, issued in her current credential epoch (suspension.ts: a suspension's epoch fences the
// tokens issued before it).
async function aliceCredential(t: Setup, n: number): Promise<string> {
  const value = `token-alice-replay-${n}`;
  await sql(
    t.store,
    `INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes, epoch)
		SELECT ?1, 'access', 'test', ?2, 'read write follow', credential_epoch FROM local_accounts WHERE account_id = ?2`,
    await sha256Hex(value),
    ALICE,
  );
  return value;
}

async function init(environment: Environment, stored: boolean): Promise<World> {
  const n = ++worlds;
  const clock = { now: NOW };
  const t = await setup(clock);
  await sql(t.store, "UPDATE accounts SET discoverable = 1 WHERE id = ?", ALICE);
  const owner = await featuredOwner(t.web, `owner${n}`, COLLECTIONS_ONLY);
  const x = await featuredOwner(t.web, `xowner${n}`, COLLECTIONS_ONLY);
  const c = collection(owner, []);
  const xCollection = collection(x, []);
  serveDocument(t, c);
  serveDocument(t, xCollection);
  serveCollections(t.web, owner, [stored ? [c] : []]);
  serveCollections(t.web, x, [[xCollection]]);
  const ownerId = await storedOwner(t, owner);
  const xId = await storedOwner(t, x);
  await syncAll(t);
  await sql(t.store, "DELETE FROM collection_syncs");
  // L follows neither owner in the specification (storedOwner stores them through alice's follow).
  await sql(t.store, "DELETE FROM follows WHERE account_id = ? AND target_account_id IN (?, ?)", ALICE, ownerId, xId);
  // dave's Accepts of the owners' Follows, delivered, so that a step's delivery round sends L's activities alone.
  const accepted = (() => Promise.resolve(new Response(null, { status: 202 }))) as unknown as typeof fetch;
  for (let round = 0; round < 8; round++) {
    if (
      (
        await deliveryRound(
          t.env,
          deliveryDeps(
            () => t.store,
            accepted,
            () => clock.now,
            `init-${n}-${round}`,
          ),
        )
      ).claimed === 0
    ) {
      break;
    }
  }
  // dave administers the instance: the suspension and its lifting go through the admin API.
  await setSetting(t.store, "admin_email", "dave@mail.example");
  const admin = `token-dave-admin-${n}`;
  await sql(
    t.store,
    `INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes)
		VALUES (?, 'access', 'test', ?, 'read write follow admin:read admin:write')`,
    await sha256Hex(admin),
    DAVE,
  );
  const w: World = {
    t,
    clock,
    owner,
    ownerId,
    x,
    xId,
    xCollection,
    c,
    requests: {},
    rows: [],
    aliceToken: await aliceCredential(t, 0),
    adminToken: admin,
    rounds: [],
    instrument: null,
    fetching: null,
    flight: null,
    flights: [],
    environment: { consent: true, slotsFull: false, held: "lt10", backlogFull: false, retractionCapFull: false },
    seen: new Set(await outboundKeys(t)),
    notified: 0,
    fillers: 0,
    followers: [],
  };
  expect(
    await sql(
      t.store,
      `SELECT 1 FROM follows f JOIN accounts a ON a.id = f.account_id
			WHERE f.target_account_id = ? AND a.domain IS NOT NULL`,
      ALICE,
    ),
    "L's remote followers",
  ).toEqual([]);
  await applyEnvironment(w, environment);
  return w;
}

function serveDocument(t: Setup, document: { id: string }): void {
  t.web.serve(document.id, {
    "@context": [
      AS,
      {
        FeaturedCollection: "https://w3id.org/fep/7aa9#FeaturedCollection",
        FeaturedItem: "https://w3id.org/fep/7aa9#FeaturedItem",
      },
    ],
    ...document,
  });
}

type Outbound = { id: number; account_id: string; created_at: number; body: string; retracts: number };

const outbound = (t: Setup) =>
  sql<Outbound>(t.store, "SELECT id, account_id, created_at, body, retracts FROM outbound_activities ORDER BY id");

const keyOf = (row: Outbound) => `${row.id} ${row.created_at} ${row.body}`;

const outboundKeys = async (t: Setup) => (await outbound(t)).map(keyOf);

const collectionId = async (w: World): Promise<string | undefined> =>
  (await sql<{ id: string }>(w.t.store, "SELECT id FROM collections WHERE uri = ?", w.c.id))[0]?.id;

// L's authorization `a` (a1, a2: the rows Kopje issued, in order).
function authorization(w: World, name: string): string {
  const row = w.rows[Number(name.slice(1)) - 1];
  return `${ALICE_URI}/feature_authorizations/${row ?? "0"}`;
}

const itemId = (w: World, name: string) =>
  name === "IX" ? `${w.x.uri}/collection_items/X` : `${w.owner.uri}/collection_items/${name}`;

const requestId = (w: World, name: string) =>
  (w.requests[name] ??= `${MASTODON}/requests/${worlds}-${name}-${crypto.randomUUID()}`);

// C's orderedItems as a listing names them: L's item first, and past MAX_REMOTE_ITEMS entries when truncated (the
// others remote members Kopje does not know).
function entries(w: World, listing: Envelope["listing"]): unknown[] {
  const out: unknown[] = [];
  if (listing?.item != null && listing.authorization != null) {
    out.push({
      ...localItem(w.owner, ALICE_URI, authorization(w, listing.authorization), 0),
      id: itemId(w, listing.item),
    });
  }
  if (listing?.truncated === true) {
    for (let k = out.length; k <= MAX_REMOTE_ITEMS; k++) {
      out.push(item(w.owner, { uri: `${OTHER}/users/crowd${k}` }, 1000 + k));
    }
  }
  return out;
}

function listedDocument(w: World, listing: Envelope["listing"]) {
  const orderedItems = entries(w, listing);
  return { ...w.c, orderedItems, totalItems: orderedItems.length };
}

// R's pages as a fetch reads them: C on page 1 or 2, past the 2 pages a read takes, or absent.
function servePages(w: World, listing: Envelope["listing"], place: string): void {
  const document = listedDocument(w, listing);
  serveDocument(w.t, document);
  const pages: unknown[][] =
    place === "p1" ? [[document]] : place === "p2" ? [[], [document]] : place === "past" ? [[], [], [document]] : [[]];
  serveCollections(w.t.web, w.owner, pages);
}

const post = (w: World, actor: TestActor, body: unknown) => w.t.post(actor, body);

const ownerActivity = (w: World, body: Record<string, unknown>) => ({ "@context": AS, actor: w.owner.uri, ...body });

function itemEnvelope(w: World, type: "Add" | "Remove", object: unknown, target = w.c.id) {
  return {
    "@context": [...FEATURE_CONTEXT, { FeaturedItem: "https://w3id.org/fep/7aa9#FeaturedItem" }],
    type,
    actor: w.owner.uri,
    target,
    object,
  };
}

// ---- The environment.

async function applyEnvironment(w: World, next: Environment): Promise<void> {
  const was = w.environment;
  if (next.consent !== was.consent) {
    await sql(w.t.store, "UPDATE accounts SET discoverable = ? WHERE id = ?", next.consent ? 1 : 0, ALICE);
  }
  if (next.slotsFull !== was.slotsFull) {
    await slots(w, next.slotsFull);
  }
  if (next.held !== was.held) {
    await held(w, next.held);
  }
  if (next.backlogFull !== was.backlogFull) {
    await backlog(w, next.backlogFull);
  }
  if (next.retractionCapFull !== was.retractionCapFull) {
    if (next.retractionCapFull) {
      await retractionsAtCap(w.t, w.owner);
    } else {
      const fillers = `${w.owner.uri}/filler/`;
      await sql(
        w.t.store,
        "DELETE FROM inbound_retractions WHERE actor_uri = ? AND substr(target_uri, 1, ?) = ?",
        w.owner.uri,
        fillers.length,
        fillers,
      );
    }
  }
  w.environment = next;
}

// C's 25 live slots held by other local members' accepted rows, or freed (retired first: ID-9's guard).
async function slots(w: World, full: boolean): Promise<void> {
  const id = await collectionId(w);
  if (id === undefined) {
    throw new Error("the slots of a collection Kopje does not store");
  }
  if (!full) {
    await sql(w.t.store, "UPDATE collection_items SET state = 3 WHERE id LIKE '85%' AND collection_id = ?", id);
    await sql(w.t.store, "DELETE FROM collection_items WHERE id LIKE '85%' AND collection_id = ?", id);
    return;
  }
  const at = new Date(w.clock.now).toISOString();
  await sql(
    w.t.store,
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
		INSERT OR IGNORE INTO accounts (id, uri, username, domain) SELECT '75' || printf('%016d', i), ?2 || '/ap/users/s' || i,
			's' || i, NULL FROM n`,
    MAX_REMOTE_ITEMS,
    LOCAL,
  );
  await sql(
    w.t.store,
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
		INSERT INTO collection_items (id, collection_id, account_id, state, position, created_at, updated_at)
		SELECT '85' || printf('%016d', i + 100 * ?4), ?2, '75' || printf('%016d', i), 1, 100 + i, ?3, ?3 FROM n`,
    MAX_REMOTE_ITEMS,
    id,
    at,
    ++w.fillers,
  );
}

// How many of R's collections Kopje holds besides C: none, 10, or 50 in all.
async function held(w: World, level: Environment["held"]): Promise<void> {
  const prefix = `${w.owner.uri}/collections/held`;
  await sql(w.t.store, "DELETE FROM collections WHERE substr(uri, 1, ?) = ?", prefix.length, prefix);
  const stored = (await collectionId(w)) === undefined ? 0 : 1;
  const others = level === "lt10" ? 0 : level === "lt50" ? 10 : 50 - stored;
  if (others === 0) {
    return;
  }
  await sql(
    w.t.store,
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
		INSERT INTO collections (id, account_id, local, name, sensitive, discoverable, uri, created_at, updated_at)
		SELECT '65' || printf('%016d', i), ?2, 0, 'held ' || i, 0, 1, ?3 || '/collections/held' || i, ?4, ?4 FROM n`,
    others,
    w.ownerId,
    w.owner.uri,
    new Date(w.clock.now).toISOString(),
  );
}

// The Store's whole backlog of active deliveries at MAX_BACKLOG, in lanes of other hosts and none of them due, or
// emptied.
async function backlog(w: World, full: boolean): Promise<void> {
  if (!full) {
    await sql(w.t.store, "DELETE FROM deliveries WHERE lane LIKE 'https://filler%'");
    await sql(w.t.store, "DELETE FROM outbound_activities WHERE object_uri = 'replay filler'");
    return;
  }
  await sql(
    w.t.store,
    `INSERT INTO outbound_activities (account_id, body, object_uri, retracts, created_at)
		VALUES (?, '{"activity":{"type":"Like"},"audience":{"followers":false,"accounts":[]}}', 'replay filler', 0, ?)`,
    DAVE,
    w.clock.now,
  );
  await sql(
    w.t.store,
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
		INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, state, next_attempt_at, updated_at)
		SELECT (SELECT id FROM outbound_activities WHERE object_uri = 'replay filler'), ?2,
			'https://filler' || (i / ?3) || '.example/inbox', 'https://filler' || (i / ?3) || '.example', 'queued', ?4, ?5
		FROM n`,
    MAX_BACKLOG,
    DAVE,
    MAX_LANE_BACKLOG,
    w.clock.now + 365 * 86_400_000,
    w.clock.now,
  );
}

// ---- The steps.

const expect202 = (status: number, what: string) => {
  if (status !== 200 && status !== 202) {
    throw new Error(`${what} answered ${status}`);
  }
};

// A FeatureRequest: answered at once for a collection Kopje stores, else held at its instrument's fetch ("fetch").
async function receiveRequest(w: World, name: string): Promise<202 | 503 | "fetch"> {
  const body = featureRequest(w.owner, ALICE_URI, w.c.id, requestId(w, name));
  if ((await collectionId(w)) !== undefined) {
    return (await post(w, w.owner, body)) as 202 | 503;
  }
  w.instrument ??= w.t.web.hold(w.c.id);
  const instrument = w.instrument;
  const posting = post(w, w.owner, body);
  const first = await Promise.race([instrument.reached.then(() => "fetch" as const), posting]);
  if (first === "fetch") {
    w.fetching = { posting, release: instrument.release };
    w.instrument = null;
    return "fetch";
  }
  return first as 202 | 503;
}

// The held instrument fetch answered with C as the envelope lists it (the hold answers with what is served then).
async function applyFetch(w: World, envelope: Envelope): Promise<number> {
  const fetching = w.fetching;
  if (fetching === null) {
    throw new Error("no instrument fetch under way");
  }
  serveDocument(w.t, listedDocument(w, envelope.listing));
  w.fetching = null;
  fetching.release();
  return fetching.posting;
}

async function receive(w: World, envelope: Envelope, value: string | undefined): Promise<202 | 503 | "fetch"> {
  switch (envelope.type) {
    case "FR":
      return receiveRequest(w, envelope.request!);
    case "Add":
      return (await post(
        w,
        w.owner,
        itemEnvelope(w, "Add", {
          ...localItem(w.owner, ALICE_URI, authorization(w, envelope.authorization!), 0),
          id: itemId(w, envelope.item!),
        }),
      )) as 202 | 503;
    case "XAdd":
      return (await post(w, w.x, {
        ...itemEnvelope(
          w,
          "Add",
          { ...localItem(w.x, ALICE_URI, authorization(w, envelope.authorization!), 0), id: itemId(w, "IX") },
          w.xCollection.id,
        ),
        actor: w.x.uri,
      })) as 202 | 503;
    case "Rem":
      return (await post(w, w.owner, itemEnvelope(w, "Remove", itemId(w, envelope.item!)))) as 202 | 503;
    case "Upd":
      return (await post(
        w,
        w.owner,
        ownerActivity(w, {
          id: `${w.owner.uri}#updates/${crypto.randomUUID()}`,
          type: "Update",
          object: listedDocument(w, envelope.listing),
        }),
      )) as 202 | 503;
    case "RemC":
      return (await post(
        w,
        w.owner,
        ownerActivity(w, { type: "Remove", target: w.owner.featuredCollections, object: w.c.id }),
      )) as 202 | 503;
    case "DelR":
      if (value === "deferred") {
        await otherContent(w);
      }
      return (await post(
        w,
        w.owner,
        ownerActivity(w, { id: `${w.owner.uri}#delete`, type: "Delete", object: w.owner.uri, to: [`${AS}#Public`] }),
      )) as 202 | 503;
    default:
      throw new Error(`no envelope ${envelope.type} reaches Kopje`);
  }
}

// R's other content, which its purge's first batch takes before its sync and its collections: more of its
// notifications than a batch writes, one row each (inbox.ts purgeBatch, PURGE_BATCH), so the batch ends with none of
// its budget left.
async function otherContent(w: World): Promise<void> {
  // Its follow notifications of 600 local accounts (notifications_natural holds one a recipient).
  await sql(
    w.t.store,
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 600)
		INSERT INTO accounts (id, uri, username, domain) SELECT '97' || printf('%016d', i), ?1 || '/ap/users/n' || i, 'n' || i,
			NULL FROM n`,
    LOCAL,
  );
  await sql(
    w.t.store,
    `INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey)
		SELECT id, username || '@mail.example', 'x', 'x', 'x' FROM accounts WHERE id LIKE '97%'`,
  );
  await sql(
    w.t.store,
    `INSERT INTO notifications (account_id, type, from_account_id, created_at)
		SELECT id, 'follow', ?1, ?2 FROM accounts WHERE id LIKE '97%'`,
    w.ownerId,
    new Date(w.clock.now).toISOString(),
  );
}

function startRound(w: World): Round {
  const round: Round = {
    done: Promise.resolve(false),
    claimed: deferred(),
    fetches: deferred(),
    split: false,
    secondPageReached: deferred(),
    secondPage: deferred(),
    completionReached: deferred(),
    completion: deferred(),
  };
  const secondPage = `${w.owner.featuredCollections}?page=2`;
  const loader = {
    checkHost: () => Promise.resolve(),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      round.claimed.resolve();
      await round.fetches.promise;
      if (round.split && request.url === secondPage) {
        round.secondPageReached.resolve();
        await round.secondPage.promise;
      }
      return w.t.web.fetch(request);
    }) as typeof fetch,
  };
  // The Store's stub with its completion of the read held (an RPC stub's methods are called by name, never bound).
  const stub = w.t.store as unknown as Record<string, (...args: unknown[]) => unknown>;
  let claims = 0;
  const store = new Proxy(w.t.store, {
    get(_target, property) {
      if (typeof property !== "string") {
        return undefined;
      }
      if (property === "completeCollectionRead") {
        return async (...args: unknown[]) => {
          round.completionReached.resolve();
          await round.completion.promise;
          return stub.completeCollectionRead!(...args);
        };
      }
      if (property === "claimCollectionSync") {
        // One claim a round: an outdated completion leaves the sync due at once, which the next claim of the same call
        // would read again through gates already open; the specification's later KClaim is a round of its own.
        return (...args: unknown[]) => (claims++ === 0 ? stub.claimCollectionSync!(...args) : null);
      }
      return (...args: unknown[]) => stub[property]!(...args);
    },
  });
  const deps = { ...inboxDeps(() => store, loader), now: () => w.clock.now };
  round.done = syncCollections(w.t.env, deps);
  return round;
}

async function claim(w: World, sameTime: boolean): Promise<void> {
  if (sameTime) {
    const [row] = await sql<{ updated_at: string }>(
      w.t.store,
      `SELECT i.updated_at FROM collection_items i JOIN collections c ON c.id = i.collection_id
			WHERE c.uri = ? AND i.account_id = ?`,
      w.c.id,
      ALICE,
    );
    w.clock.now = Date.parse(row!.updated_at);
  }
  const live = await sql(w.t.store, "SELECT 1 FROM collection_syncs WHERE account_id = ?", w.ownerId);
  if (live.length === 0) {
    await sql(w.t.store, "INSERT INTO collection_syncs (account_id, due_at) VALUES (?, ?)", w.ownerId, w.clock.now);
  }
  const round = startRound(w);
  const ended = round.done.then((more) => {
    throw new Error(`the read claimed nothing (${more})`);
  });
  await Promise.race([round.claimed.promise, ended]);
  w.rounds.push(round);
}

const current = (w: World): Round => {
  const round = w.rounds.at(-1);
  if (round === undefined) {
    throw new Error("no read under way");
  }
  return round;
};

async function reachCompletion(round: Round): Promise<void> {
  await Promise.race([
    round.completionReached.promise,
    round.done.then(() => {
      throw new Error("the read ended without completing");
    }),
  ]);
}

async function fetchPages(w: World, envelope: Envelope, place: string, part: "both" | "first" | "second") {
  const round = current(w);
  servePages(w, envelope.listing, place);
  if (part === "first") {
    round.split = true;
    round.fetches.resolve();
    await round.secondPageReached.promise;
    return;
  }
  if (part === "second") {
    round.secondPage.resolve();
  } else {
    round.fetches.resolve();
  }
  await reachCompletion(round);
}

// KApply completes the latest read, KStale the oldest one still held (a claim since replaced its token).
async function complete(w: World, stale: boolean): Promise<void> {
  const round = stale ? w.rounds[0] : w.rounds.at(-1);
  if (round === undefined) {
    throw new Error("no read under way");
  }
  round.completion.resolve();
  await round.done;
  w.rounds.splice(w.rounds.indexOf(round), 1);
}

// A delivery round's answer to the head of Kopje's lane to R's server: 202, a lost response (the POST reached R), a
// refusal for good (403: delivery.ts classifyStatus, which resends a 400 at once), or a transient failure (503, KFail's
// failed POST; a lease that runs out is KReclaim).
type Outcome = "delivered" | "lost" | "refused" | "failed";
const STATUS = { delivered: 202, refused: 403, failed: 503 } as const;

type Head = { id: number; state: string; due: number; inbox: string; retracts: number; body: string };

// A delivery round under way, its POSTs recorded and each held until the step that answers it; token: its lease.
type Flight = {
  head: Head;
  token: string;
  sent: { url: string; body: Record<string, unknown> }[];
  posted: Deferred;
  answer: (outcome: Outcome) => void;
  done: Promise<RoundResult>;
};

const laneOf = (w: World): string => new URL(w.owner.uri).origin;

// The lane's rows waiting or in flight (a promoted row is pending or leased, the rows behind it queued).
const laneRows = (w: World, states: string) =>
  sql<Head>(
    w.t.store,
    `SELECT d.id, d.state, d.next_attempt_at AS due, d.inbox_url AS inbox, o.retracts, o.body FROM deliveries d
			JOIN outbound_activities o ON o.id = d.activity_id
			WHERE d.account_id = ? AND d.lane = ? AND d.state IN (SELECT value FROM json_each(?)) ORDER BY d.id`,
    ALICE,
    laneOf(w),
    states,
  );

const recordedAs = (w: World, row: Head) =>
  asRecorded(w, JSON.parse(row.body) as Parameters<typeof asRecorded>[1], [row.inbox], row.retracts);

// The lane's head, checked to be the activity the step names, at the inbox it names.
async function laneHead(w: World, expected: Activity): Promise<Head> {
  const heads = await laneRows(w, '["pending", "leased"]');
  expect(heads.length, "the lane's one head").toBe(1);
  const [head] = heads as [Head];
  const { reason: _reason, ...want } = expected;
  expect(recordedAs(w, head), "the lane's head before the step").toEqual(want);
  return head;
}

// A delivery round at the head's due time.
function fly(w: World, head: Head): Flight {
  if (head.due > w.clock.now) {
    w.clock.now = head.due;
  }
  let answer!: (outcome: Outcome) => void;
  const outcome = new Promise<Outcome>((resolve) => (answer = resolve));
  const prefix = `replay-${++leases}`;
  const sent: Flight["sent"] = [];
  const posted = deferred();
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    sent.push({ url: request.url, body: await request.json() });
    if (new URL(request.url).origin === laneOf(w)) {
      posted.resolve();
    }
    const answered = await outcome;
    if (answered === "lost") {
      throw new TypeError("network connection lost");
    }
    return new Response(null, { status: STATUS[answered] });
  }) as typeof globalThis.fetch;
  const done = deliveryRound(
    w.t.env,
    deliveryDeps(
      () => w.t.store,
      fetch,
      () => w.clock.now,
      prefix,
    ),
  );
  const flight: Flight = { head, token: `${prefix}-1`, sent, posted, answer, done };
  w.flights.push(flight);
  return flight;
}
let leases = 0;

// The round's POST to R's server, reached and held.
async function posted(flight: Flight): Promise<void> {
  await Promise.race([
    flight.posted.promise,
    flight.done.then(() => {
      throw new Error("the round sent nothing to R's server");
    }),
  ]);
}

// The round's POSTs: to R's server exactly the head, as the step names it (an Accept with its result), at its inbox,
// and off R's server only L's revocations to her followers (offR).
function expectSent(w: World, flight: Flight, head: Head, expected: Activity): void {
  const lane = laneOf(w);
  expect(
    flight.sent.filter((s) => new URL(s.url).origin !== lane && !offR(w, s.body).includes(s.url)).map((s) => s.url),
    "the round's POSTs off R's server",
  ).toEqual([]);
  const { reason: _reason, ...want } = expected;
  const envelope = JSON.parse(head.body) as Parameters<typeof asRecorded>[1];
  expect(
    flight.sent
      .filter((s) => new URL(s.url).origin === lane)
      .map((s) => asRecorded(w, { ...envelope, activity: s.body }, [s.url], head.retracts)),
    "the lane's head, as sent",
  ).toEqual([want]);
}

// KLeaseHead: a round claims the head and holds its POST in flight until the step that answers it.
async function lease(w: World, expected: Activity): Promise<void> {
  const head = await laneHead(w, expected);
  const flight = fly(w, head);
  await posted(flight);
  expectSent(w, flight, head, expected);
  w.flight = flight;
}

// The head's delivery in any state: one deleted is in none (a given-up one is not gone).
const deliveryOf = (w: World, head: Head) =>
  sql<{ state: string; lease_token: string | null }>(
    w.t.store,
    "SELECT state, lease_token FROM deliveries WHERE id = ?",
    head.id,
  );

// After a superseded head is dropped: it is gone, and exactly one later answer of its recorded form waits in the lane,
// in the state its place there gives it (the drop takes the head out: the lane's first row is pending, any other
// queued).
async function supersededBy(w: World, head: Head, want: Omit<Activity, "reason">): Promise<void> {
  expect(await deliveryOf(w, head), "a superseded answer's delivery is gone").toEqual([]);
  const rows = await laneRows(w, '["queued", "pending", "leased"]');
  const form = (recorded: object) =>
    JSON.stringify(Object.entries(recorded).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const later = rows.flatMap((row, at) =>
    form(recordedAs(w, row)) === form(want) ? [{ state: row.state, place: at === 0 ? "pending" : "queued" }] : [],
  );
  expect(later.length, "one later answer waits").toBe(1);
  expect(later[0]!.state, "the later answer, in the state of its place in the lane").toBe(later[0]!.place);
}

// KReclaim: the held POST's lease runs out, and a delivery round at its expiry (claimDeliveries, after LEASE_MS)
// reclaims the head: under a new lease, its POST to R's server in flight again (the head leased, never waiting), or,
// "superseded", dropped, the round sending R's server nothing (its POSTs answered before it is awaited, so one it makes
// fails the step at once). The old POST is then answered 503, too late: its completion is stale and changes nothing.
async function reclaim(w: World, expected: Activity, value: string | undefined): Promise<void> {
  const head = await laneHead(w, expected);
  const held = w.flight;
  expect(held?.head.id, "the head's POST held in flight").toBe(head.id);
  expect(await deliveryOf(w, head), "the head is leased").toEqual([{ state: "leased", lease_token: held!.token }]);
  w.flight = null;
  const flight = fly(w, head);
  const { reason: _reason, ...want } = expected;
  if (value === "superseded") {
    flight.answer("failed");
    await flight.done;
    expect(
      flight.sent.map((s) => s.url),
      "a reclaimed superseded answer is not sent",
    ).toEqual([]);
    await supersededBy(w, head, want);
  } else {
    await posted(flight);
    expectSent(w, flight, head, expected);
    expect(await deliveryOf(w, head), "the head leased again, under the new lease").toEqual([
      { state: "leased", lease_token: flight.token },
    ]);
    w.flight = flight;
  }
  held!.answer("failed");
  expect((await held!.done).settled, "the expired lease's completion").toEqual(["stale"]);
}

// A step that answers the head's POST: the one KLeaseHead or KReclaim holds, or that of a round claiming the waiting
// head. Checks that the head before the step is the activity the step names and that the round POSTs exactly it there,
// an Accept with its result (expectSent). Then, by the step's input: "dropped", that nothing is sent and the head's
// delivery is gone (deleted, not given up); "superseded", supersededBy; else, after a 202, that the round delivered it
// and its delivery is gone, and after a failed or lost POST, that the head waits again.
async function deliver(w: World, outcome: Outcome, expected: Activity, value: string | undefined) {
  const head = await laneHead(w, expected);
  const flight = w.flight ?? fly(w, head);
  expect(flight.head.id, "the head in flight").toBe(head.id);
  w.flight = null;
  flight.answer(outcome);
  const { settled } = await flight.done;
  if (value === "dropped") {
    expect(
      flight.sent.filter((s) => !offR(w, s.body).includes(s.url)).map((s) => s.url),
      "a dropped activity is not sent",
    ).toEqual([]);
    expect(await deliveryOf(w, head), "a dropped activity's delivery is gone").toEqual([]);
    return;
  }
  expectSent(w, flight, head, expected);
  const { reason: _reason, ...want } = expected;
  if (value === "superseded") {
    await supersededBy(w, head, want);
  } else if (outcome === "delivered") {
    expect(settled, "the round's completions").toContain("delivered");
    expect(await deliveryOf(w, head), "a delivered activity's delivery is gone").toEqual([]);
  } else if (outcome === "failed" || outcome === "lost") {
    expect(
      (await deliveryOf(w, head)).map((d) => d.state),
      "the head waits again",
    ).toEqual(["pending"]);
  }
}

async function admin(w: World, path: string, init: RequestInit): Promise<void> {
  const response = await w.t.request(path, bearer(w.adminToken, init));
  expect202(response.status, path);
  await response.arrayBuffer();
}

async function asAlice(w: World, method: string, path: string): Promise<number> {
  const response = await w.t.request(path, bearer(w.aliceToken, { method }));
  await response.arrayBuffer();
  return response.status;
}

const inDurableObject = <T>(w: World, fn: (db: Db, sqlStorage: SqlStorage) => T) =>
  runInDurableObject(w.t.store, (_instance, state) =>
    state.storage.transactionSync(() => fn(new Db(state.storage.sql), state.storage.sql)),
  );

async function evict(w: World): Promise<void> {
  // C at its stored bound with L's retired row the oldest: retired rows of other members since it, then an owner's
  // Add of a new member's item, whose insertion deletes the oldest retired row (applyFeaturedItem).
  const id = (await collectionId(w))!;
  const [{ n }] = (await sql<{ n: number }>(
    w.t.store,
    "SELECT count(*) AS n FROM collection_items WHERE collection_id = ?",
    id,
  )) as [{ n: number }];
  const at = new Date(w.clock.now).toISOString();
  await sql(
    w.t.store,
    `WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < ?1)
		INSERT INTO accounts (id, uri, username, domain) SELECT '96' || printf('%016d', i), ?2 || '/users/e' || i, 'e' || i,
			?3 FROM k`,
    50 - n,
    OTHER,
    new URL(OTHER).host,
  );
  await sql(
    w.t.store,
    `INSERT INTO collection_items (id, collection_id, account_id, state, position, created_at, updated_at)
		SELECT '86' || substr(id, 3), ?1, id, 3, 200 + CAST(substr(id, 3) AS INTEGER), ?2, ?2 FROM accounts
		WHERE id LIKE '96%'`,
    id,
    at,
  );
  w.clock.now += 1000;
  const added = item(w.owner, { uri: `${OTHER}/users/evictor` }, 4242);
  expect202(await post(w, w.owner, itemEnvelope(w, "Add", added)), "the evicting Add");
}

async function step(w: World, s: Step): Promise<202 | 503 | "fetch" | null> {
  const envelope = s.input.envelope;
  const value = s.input.value;
  switch (s.action) {
    case "Init":
    case "RAdd":
    case "RJob":
    case "RRemove":
    case "RDeleteC":
    case "RDeleteSelf":
    case "RCleanup":
    case "RCrowd":
    case "RUpdate":
    case "XAdd":
    case "Drop":
      if (s.action === "RAdd") {
        requestId(w, value!);
      }
      return null;
    case "Env":
      await applyEnvironment(w, s.environment);
      return null;
    case "KRecv":
      return receive(w, envelope!, value);
    case "KApplyFetch":
      return (await applyFetch(w, envelope!)) as 202 | 503;
    case "KClaim":
      await claim(w, value === "sameTime");
      return null;
    case "KFetch":
      await fetchPages(w, envelope!, value!, "both");
      return null;
    case "KFetch1":
      await fetchPages(w, envelope!, value!, "first");
      return null;
    case "KFetch2":
      await fetchPages(w, envelope!, value!, "second");
      return null;
    case "KApply":
      await complete(w, false);
      return null;
    case "KStale":
      await complete(w, true);
      return null;
    case "KLease":
      w.clock.now += SYNC_LEASE_MS + 1000;
      return null;
    case "KLeaseHead":
      await lease(w, s.input.activity!);
      return null;
    case "KDeliver":
      await deliver(w, "delivered", s.input.activity!, value);
      return null;
    case "KDup":
      await deliver(w, "lost", s.input.activity!, value);
      return null;
    case "KGiveUp":
      await deliver(w, "refused", s.input.activity!, value);
      return null;
    case "KFail":
      await deliver(w, "failed", s.input.activity!, value);
      return null;
    case "KReclaim":
      await reclaim(w, s.input.activity!, value);
      return null;
    case "KRetry":
      await inDurableObject(w, (_db, storage) =>
        retryDeliveries.run(storage, { ids: "all", now: w.clock.now }, (fn) => fn()),
      );
      return null;
    case "KRevoke": {
      const id = (await collectionId(w))!;
      expect202(await asAlice(w, "POST", `/api/v1/collections/${id}/items/${w.rows.at(-1)}/revoke`), "the revoke");
      return null;
    }
    case "KBlock":
      expect202(await asAlice(w, "POST", `/api/v1/accounts/${w.ownerId}/block`), "the block");
      return null;
    case "KSuspend":
      await admin(w, `/api/v1/admin/accounts/${ALICE}/action`, form({ type: "suspend" }));
      return null;
    case "KUnsuspend":
      await admin(w, `/api/v1/admin/accounts/${ALICE}/unsuspend`, { method: "POST" });
      if (value === "newCredential") {
        w.aliceToken = await aliceCredential(w.t, worlds * 10 + 1);
      }
      return null;
    case "KCleanup":
      w.clock.now += 86_400_000 + 1000;
      await inDurableObject(w, (_db, storage) => pruneCollectionItems.run(storage, { now: w.clock.now }, (fn) => fn()));
      // The day leaves the owners' keys stale, and their next activity would fetch their documents again, which
      // requests a read (inbox.ts KEY_REFRESH_MS, remote-actors.ts storeActor): a refresh the specification does not
      // take, so the keys are kept fresh.
      await sql(
        w.t.store,
        "UPDATE remote_keys SET fetched_at = ? WHERE account_id IN (?, ?)",
        w.clock.now,
        w.ownerId,
        w.xId,
      );
      return null;
    case "KEvict":
      await evict(w);
      return null;
    case "KPurge":
      await inDurableObject(w, (db) => purgeBatch(db, w.owner.uri, w.clock.now));
      return null;
    case "KExpire":
      await sql(
        w.t.store,
        "UPDATE inbound_retractions SET expires_at = ? WHERE actor_uri = ? AND target_uri = ?",
        w.clock.now,
        w.owner.uri,
        w.c.id,
      );
      w.clock.now += 1000;
      return null;
    default:
      throw new Error(`no replay of ${s.action}`);
  }
}

// ---- The observation.

// An activity's object in the specification's names.
function named(w: World, type: string, activity: Record<string, unknown>): string {
  const object = activity.object;
  const id = typeof object === "string" ? object : ((object as { id?: string } | undefined)?.id ?? "");
  if (type === "Accept" || type === "Reject") {
    return Object.entries(w.requests).find(([, uri]) => uri === id)?.[0] ?? id;
  }
  if (type === "Block") {
    return id === w.owner.uri ? "R" : id;
  }
  if (type === "Delete") {
    if (id === ALICE_URI) {
      return "L";
    }
    const at = w.rows.findIndex((row) => id === `${ALICE_URI}/feature_authorizations/${row}`);
    return at < 0 ? id : `a${at + 1}`;
  }
  return id;
}

const authorizationName = (w: World, uri: unknown): Recorded["result"] => {
  const at = w.rows.findIndex((row) => uri === `${ALICE_URI}/feature_authorizations/${row}`);
  return at < 0 ? null : (`a${at + 1}` as Recorded["result"]);
};

// The inboxes off R's server an activity of L's is to reach as well: her followers' for her revocation (her LD-signed
// Delete of an authorization, to the owner and her followers: "revokes with the member's LD-signed Delete to the owner
// and the member's followers" in test/federation-feature-requests.test.ts), none for any other.
function offR(w: World, activity: Record<string, unknown>): string[] {
  const revocation = activity.type === "Delete" && "signature" in activity && named(w, "Delete", activity) !== "L";
  return revocation ? w.followers : [];
}

// An activity as the specification records it, from its envelope, the inboxes its delivery rows (or POSTs) name, and
// its class. Its destination is the one inbox it has on R's server: R's or X's own, or for a Block (which takes the
// shared inbox, as any activity not placed at a personal one) the server's shared inbox for the one of them its
// audience names. No row, several, or any other inbox there is named as it is, which no fixture expects.
function asRecorded(
  w: World,
  envelope: { activity: Record<string, unknown>; audience?: { accounts?: string[] } },
  inboxes: string[],
  retracts: number,
): Omit<Recorded, "outcome"> {
  const { activity } = envelope;
  const type = activity.type as string;
  const object = named(w, type, activity);
  const lane = new URL(w.owner.uri).origin;
  const there = inboxes.filter((inbox) => new URL(inbox).origin === lane);
  const shared = type === "Block" && there[0] === `${lane}/inbox`;
  const addressed = (envelope.audience?.accounts ?? []).filter((id) => id === w.ownerId || id === w.xId);
  const to =
    there.length !== 1
      ? `inboxes on R's server: ${JSON.stringify(there)}`
      : there[0] === `${w.owner.uri}/inbox` || (shared && addressed.join() === w.ownerId)
        ? "R"
        : there[0] === `${w.x.uri}/inbox` || (shared && addressed.join() === w.xId)
          ? "X"
          : `${there[0]} for ${JSON.stringify(addressed)}`;
  return {
    type: (type === "Delete" && object === "L" ? "DeleteActor" : type) as Recorded["type"],
    object: object as Recorded["object"],
    result: type === "Accept" ? authorizationName(w, activity.result) : null,
    to: to as Recorded["to"],
    class: retracts === 1 ? "retraction" : "ordinary",
  };
}

async function recorded(w: World): Promise<Recorded[]> {
  await inDurableObject(w, (db) => expandPending(db, w.clock.now, Number.MAX_SAFE_INTEGER));
  const all = await outbound(w.t);
  const fresh = all.filter((row) => row.account_id === ALICE && !w.seen.has(keyOf(row)));
  w.seen = new Set(all.map(keyOf));
  const out: Recorded[] = [];
  for (const row of fresh) {
    const envelope = JSON.parse(row.body) as Parameters<typeof asRecorded>[1];
    const type = envelope.activity.type as string;
    if (type === "Update") {
      continue;
    }
    const deliveries = await sql<{ inbox: string; state: string; error: string | null }>(
      w.t.store,
      "SELECT inbox_url AS inbox, state, last_error AS error FROM deliveries WHERE activity_id = ?",
      row.id,
    );
    const refused =
      deliveries.length > 0 && deliveries.every((d) => d.state === "gave_up" && d.error === "backlog full");
    const inboxes = deliveries.map((d) => d.inbox);
    const entry = asRecorded(w, envelope, inboxes, row.retracts);
    // Its full destination set: off R's server, exactly the inboxes offR names, else they are named as they are.
    const lane = new URL(w.owner.uri).origin;
    const off = inboxes.filter((inbox) => new URL(inbox).origin !== lane).toSorted();
    const to =
      JSON.stringify(off) === JSON.stringify(offR(w, envelope.activity).toSorted())
        ? entry.to
        : `${entry.to} and off R's server ${JSON.stringify(off)}`;
    out.push({ ...entry, to: to as Recorded["to"], outcome: refused ? "refused" : "queued" });
  }
  return out;
}

type Shown = { status: number; items: string[] };

async function shown(w: World, id: string, credential: string | null): Promise<Shown> {
  const response = await w.t.request(`/api/v1/collections/${id}`, credential === null ? {} : bearer(credential));
  if (response.status !== 200) {
    await response.arrayBuffer();
    return { status: response.status, items: [] };
  }
  const body = await response.json<{ collection: { item_count: number; items: { account_id?: string }[] } }>();
  // The count shows what the items do: L counted exactly when shown.
  expect(body.collection.item_count, "item_count").toBe(body.collection.items.length);
  const items = body.collection.items.flatMap((i) => (i.account_id === undefined ? [] : [i.account_id]));
  return { status: 200, items };
}

const refusedStatus = (status: number) => status === 401 || status === 403;

async function observe(w: World, response: Actual["response"]): Promise<Actual> {
  const id = await collectionId(w);
  const [stored] =
    id === undefined
      ? []
      : await sql<{ id: string; state: number; activity_uri: string | null; uri: string | null }>(
          w.t.store,
          "SELECT id, state, activity_uri, uri FROM collection_items WHERE collection_id = ? AND account_id = ?",
          id,
          ALICE,
        );
  if (stored !== undefined && !w.rows.includes(stored.id)) {
    w.rows.push(stored.id);
  }
  const row: Row | null =
    stored === undefined
      ? null
      : {
          name: `row${w.rows.indexOf(stored.id) + 1}` as Row["name"],
          state: stored.state === 1 ? "accepted" : "retired",
          authorization: `a${w.rows.indexOf(stored.id) + 1}` as Row["authorization"],
          request: (Object.entries(w.requests).find(([, uri]) => uri === stored.activity_uri)?.[0] ??
            stored.activity_uri) as Row["request"],
          listedAs:
            stored.uri === null
              ? null
              : stored.uri === itemId(w, "I1")
                ? "I1"
                : stored.uri === itemId(w, "I2")
                  ? "I2"
                  : (stored.uri as Row["listedAs"]),
        };
  const authorizationGet: Record<string, AuthorizationGet> = {};
  for (const [k, rowId] of w.rows.entries()) {
    const answer = await w.t.request(new URL(`${ALICE_URI}/feature_authorizations/${rowId}`).pathname, {
      headers: AP,
    });
    if (answer.status === 200) {
      const body = await answer.json<{ interactingObject?: string; interactionTarget?: string }>();
      authorizationGet[`a${k + 1}`] =
        body.interactingObject === w.c.id && body.interactionTarget === ALICE_URI
          ? { status: 200, collection: "C", member: "L" }
          : ({ status: 200, collection: body.interactingObject, member: body.interactionTarget } as never);
    } else {
      await answer.arrayBuffer();
      authorizationGet[`a${k + 1}`] = answer.status === 404 ? { status: 404 } : ({ status: answer.status } as never);
    }
  }
  let publicShows = false;
  let memberDetail: Actual["memberDetail"] = false;
  if (id !== undefined) {
    const anonymous = await shown(w, id, null);
    const third = await shown(w, id, w.t.tokens.dave);
    const a = anonymous.items.includes(ALICE);
    const d = third.items.includes(ALICE);
    publicShows = a && d ? true : !a && !d ? false : (`anonymous ${a}, dave ${d}` as never);
    const own = await shown(w, id, w.aliceToken);
    memberDetail = refusedStatus(own.status) ? "refused" : own.items.includes(ALICE);
  } else {
    const status = await asAlice(w, "GET", "/api/v1/collections/0");
    memberDetail = refusedStatus(status) ? "refused" : false;
  }
  const memberships = await w.t.request(`/api/v1/accounts/${ALICE}/in_collections`, bearer(w.aliceToken));
  let inCollections: Actual["inCollections"];
  if (refusedStatus(memberships.status)) {
    await memberships.arrayBuffer();
    inCollections = "refused";
  } else {
    const body = await memberships.json<{ collections: { id: string }[] }>();
    inCollections = id !== undefined && body.collections.some((c) => c.id === id);
  }
  const [{ n: notifications }] = (await sql<{ n: number }>(
    w.t.store,
    "SELECT count(*) AS n FROM notifications WHERE account_id = ? AND type = 'added_to_collection'",
    ALICE,
  )) as [{ n: number }];
  const notified = notifications > w.notified;
  w.notified = notifications;
  const readRequested =
    (await sql(w.t.store, "SELECT 1 FROM collection_syncs WHERE account_id = ?", w.ownerId)).length > 0;
  return {
    row,
    collection: id === undefined ? "absent" : "stored",
    authorizationGet,
    publicShows,
    memberDetail,
    inCollections,
    notified,
    response,
    recorded: await recorded(w),
    readRequested,
  };
}

// ---- The replay.

async function replay(name: string): Promise<void> {
  const fixture = fixtureNamed(name);
  const [first, ...rest] = fixture.steps;
  const w = await init(first!.environment, first!.observation.collection === "stored");
  const disagreements: string[] = [];
  const check = async (index: number, s: Step, response: Actual["response"]) => {
    const differences = compareObservation(s.observation, await observe(w, response));
    if (differences.length > 0) {
      disagreements.push(`step ${index} ${s.action} ${JSON.stringify(s.input)}: ${differences.join("; ")}`);
    }
  };
  try {
    await check(0, first!, null);
    for (const [k, s] of rest.entries()) {
      w.clock.now += 1000;
      let response: Actual["response"];
      try {
        response = await step(w, s);
      } catch (error) {
        disagreements.push(`step ${k + 1} ${s.action}: ${error instanceof Error ? error.message : String(error)}`);
        break;
      }
      await check(k + 1, s, response);
      if (disagreements.length > 0) {
        break;
      }
    }
  } finally {
    w.fetching?.release();
    for (const round of w.rounds) {
      round.fetches.resolve();
      round.secondPage.resolve();
      round.completion.resolve();
    }
    for (const flight of w.flights) {
      flight.answer("failed");
    }
    await Promise.allSettled([...w.rounds.map((round) => round.done), ...w.flights.map((flight) => flight.done)]);
  }
  expect(disagreements).toEqual([]);
}

describe("spec/collection-consent's fixtures replayed against the Store", () => {
  it("names every fixture, and no other", () => {
    expect(Object.keys(FIXTURES).map((path) => path.replace(/^.*\//, "").replace(/\.json$/, ""))).toEqual(
      [...NAMES].toSorted(),
    );
    for (const name of NAMES) {
      expect(fixtureNamed(name).replayedBy).toBe(`test/collection-consent-replay.test.ts::${name}`);
    }
  });

  it.each(NAMES)("%s", (name) => replay(name), 120_000);
});
