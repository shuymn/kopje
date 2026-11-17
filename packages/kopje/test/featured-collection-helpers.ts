import { expect } from "vitest";

import { checkCollectionItems } from "../src/federation/collection-checks";
import { syncCollections } from "../src/federation/collections";
import { sql } from "./api-helpers";
import { inboxDeps, NOW } from "./app-helpers";
import { type RemoteWeb, mastodonActor, type TestActor } from "./inbox-helpers";
import { accountId, AS, followed, OTHER, type Setup } from "./inbox-status-helpers";

// Mastodon 4.7.5's FEP-7aa9 documents (ActivityPub::FeaturedCollectionSerializer, FeaturedItemSerializer,
// FeatureAuthorizationSerializer, FeaturedCollectionsController), served by a fake remote web.

export const FEATURE_CONTEXT = [
  AS,
  {
    gts: "https://gotosocial.org/ns#",
    FeatureAuthorization: "https://w3id.org/fep/7aa9#FeatureAuthorization",
    interactingObject: { "@id": "gts:interactingObject", "@type": "@id" },
    interactionTarget: { "@id": "gts:interactionTarget", "@type": "@id" },
  },
];

let sequence = 0;

// A remote owner whose actor names its featuredCollections collection, with only the members `extra` keeps (an
// undefined member is left out of its document).
export async function featuredOwner(
  web: RemoteWeb,
  username: string,
  extra: Record<string, unknown> = {},
  origin?: string,
): Promise<TestActor & { featuredCollections: string }> {
  const uri = `${origin ?? "https://mastodon.example"}/users/${username}`;
  const featuredCollections = `${uri}/featured_collections`;
  const actor = await mastodonActor(web, username, {
    ...(origin === undefined ? {} : { origin }),
    extra: { featuredCollections, ...extra },
  });
  return { ...actor, featuredCollections };
}

// An actor whose sync reads its featuredCollections collection alone: no featured, featuredTags or network
// collections, so no other part fetches.
export const COLLECTIONS_ONLY = {
  featured: undefined,
  featuredTags: undefined,
  followers: undefined,
  following: undefined,
  outbox: undefined,
};

export type Item = { id: string; type: "FeaturedItem"; featuredObject: string; featureAuthorization: string };

// A FeaturedItem of `owner`'s naming `member`, its authorization on the member's server.
export function item(owner: TestActor, member: { uri: string }, n = ++sequence): Item {
  return {
    id: `${owner.uri}/collection_items/${n}`,
    type: "FeaturedItem",
    featuredObject: member.uri,
    featureAuthorization: `${member.uri}/feature_authorizations/${n}`,
  };
}

// A FeaturedCollection of `owner`'s holding `items`.
export function collection(owner: TestActor, items: unknown[], extra: Record<string, unknown> = {}, n = ++sequence) {
  return {
    id: `${owner.uri}/collections/${n}`,
    type: "FeaturedCollection",
    totalItems: items.length,
    name: `collection ${n}`,
    attributedTo: owner.uri,
    url: `${owner.uri.replace("/users/", "/@")}/collections/${n}`,
    sensitive: false,
    discoverable: true,
    published: "2026-10-01T00:00:00Z",
    updated: "2026-10-01T00:00:00Z",
    summary: "a <b>description</b>",
    orderedItems: items,
    ...extra,
  };
}

// The owner's featuredCollections root and its pages, each page holding one list of `pages` (Mastodon's: a Collection
// with `first`, then CollectionPages linked by `next`). `more`: the last page links to one more, never served.
export function serveCollections(
  web: RemoteWeb,
  owner: { featuredCollections: string },
  pages: unknown[][],
  more = false,
) {
  const root = owner.featuredCollections;
  const total = pages.reduce((n, page) => n + page.length, 0);
  web.serve(root, { "@context": AS, id: root, type: "Collection", totalItems: total, first: `${root}?page=1` });
  pages.forEach((items, index) => {
    const last = index === pages.length - 1;
    web.serve(`${root}?page=${index + 1}`, {
      "@context": AS,
      id: `${root}?page=${index + 1}`,
      type: "CollectionPage",
      totalItems: total,
      partOf: root,
      items,
      ...(last && !more ? {} : { next: `${root}?page=${index + 2}` }),
    });
  });
}

// The authorization of `entry` (an item of `collection`), as the member's server serves it while the item is accepted.
export function serveAuthorization(web: RemoteWeb, entry: Item, collectionId: string) {
  web.serve(entry.featureAuthorization, {
    "@context": FEATURE_CONTEXT,
    id: entry.featureAuthorization,
    type: "FeatureAuthorization",
    interactingObject: collectionId,
    interactionTarget: entry.featuredObject,
  });
}

// A remote member stored by Kopje (its Follow of dave), on `origin`.
export async function storedMember(t: Setup, username: string, origin?: string): Promise<TestActor> {
  const member = await mastodonActor(t.web, username, origin === undefined ? {} : { origin });
  await followed(t, member);
  return member;
}

// The owner stored by Kopje (its Follow of dave), which asks for a sync of its collections; its account id.
export async function storedOwner(t: Setup, owner: TestActor): Promise<string> {
  await followed(t, owner);
  return (await accountId(t.store, owner.uri))!;
}

let seededBatch = 0;

// `n` remote accounts Kopje stores on `origin`'s host, `<origin>/users/<prefix><i>` (inserted, as an earlier activity
// of theirs leaves them): members whose documents are never served.
export async function seededMembers(t: Setup, n: number, prefix = "m", origin = OTHER): Promise<{ uri: string }[]> {
  const base = ++seededBatch * 100_000;
  await sql(
    t.store,
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
		INSERT INTO accounts (id, uri, username, domain)
		SELECT '9' || printf('%017d', ?2 + i), ?3 || '/users/' || ?4 || i, ?4 || i, ?5 FROM n`,
    n,
    base,
    origin,
    prefix,
    new URL(origin).host,
  );
  return Array.from({ length: n }, (_, i) => ({ uri: `${origin}/users/${prefix}${i + 1}` }));
}

// The web's fetch, answering 401 to a draft-cavage signature (no Signature-Input) for URLs under `prefix`, so every
// such document takes the RFC 9421 retry: two sends. `sent`: each send under the prefix, in order.
export function cavageRefused(web: RemoteWeb, prefix: string, sent: string[]): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.url.startsWith(prefix)) {
      sent.push(request.url);
      if (!request.headers.has("signature-input")) {
        return new Response("Unauthorized", { status: 401 });
      }
    }
    return web.fetch(request);
  };
}

// Asks for a sync of `accountId` (as a stored actor document does: requestCollectionSync), due at once.
export async function requestSync(t: Setup, accountId: string): Promise<void> {
  await sql(
    t.store,
    `INSERT INTO collection_syncs (account_id, due_at) VALUES (?1, 0)
		ON CONFLICT (account_id) DO UPDATE SET generation = generation + 1, parts_read = 0, collections_read = 0,
			attempts = 0, due_at = 0`,
    accountId,
  );
}

type Loader = Parameters<typeof inboxDeps>[1];

// Job rounds' syncs until none waits.
export async function syncAll(t: Setup, loader: Loader = t.web.loader, now = NOW): Promise<void> {
  const deps = { ...inboxDeps(() => t.store, loader), now: () => now };
  for (let round = 0; round < 8 && (await syncCollections(t.env, deps)); round++) {
    // Another sync waits.
  }
  expect(await sql(t.store, "SELECT account_id FROM collection_syncs")).toEqual([]);
}

// One job round's checks at `now`; whether another is due.
export function checkRound(t: Setup, now = NOW, loader: Loader = t.web.loader): Promise<boolean> {
  return checkCollectionItems(t.env, { ...inboxDeps(() => t.store, loader), now: () => now });
}

// The earliest queued check's due time, or null when none is queued.
export async function nextDue(t: Setup): Promise<number | null> {
  return (await sql<{ due: number | null }>(t.store, "SELECT min(check_due_at) AS due FROM collection_items"))[0]!.due;
}

// Check rounds from `start` until no check is queued, the clock moved to the next due check whenever none is due:
// the rounds run, and the clock at the end. `before`: run before each round, at its time.
export async function checkUntilQuiet(
  t: Setup,
  start = NOW,
  loader: Loader = t.web.loader,
  before: (now: number) => Promise<void> = async () => {},
): Promise<{ rounds: number; now: number }> {
  let now = start;
  for (let rounds = 1; rounds <= 2000; rounds++) {
    await before(now);
    if (!(await checkRound(t, now, loader))) {
      const next = await nextDue(t);
      if (next === null) {
        return { rounds, now };
      }
      now = Math.max(now, next);
    }
  }
  throw new Error("the checks did not end");
}

export type ItemRow = {
  uri: string;
  state: number;
  account_id: string | null;
  object_uri: string | null;
  candidate_approval_uri: string | null;
  approval_uri: string | null;
  check_due_at: number | null;
  check_attempts: number;
  check_token: string | null;
  position: number;
};

export function items(t: Setup, collectionUri?: string): Promise<ItemRow[]> {
  return sql<ItemRow>(
    t.store,
    `SELECT i.uri, i.state, i.account_id, i.object_uri, i.candidate_approval_uri, i.approval_uri, i.check_due_at,
			i.check_attempts, i.check_token, i.position
		FROM collection_items i JOIN collections c ON c.id = i.collection_id
		WHERE ?1 IS NULL OR c.uri = ?1 ORDER BY c.uri, i.position, i.id`,
    collectionUri ?? null,
  );
}

export function collectionRows(t: Setup) {
  return sql<{ uri: string; name: string; description: string | null; account_id: string }>(
    t.store,
    "SELECT uri, name, description, account_id FROM collections WHERE local = 0 ORDER BY uri",
  );
}

export const PENDING = 0;
export const ACCEPTED = 1;
export const REJECTED = 2;
export const REVOKED = 3;
