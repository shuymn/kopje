import { describe, expect, it } from "vitest";

import {
  CHECK_BACKOFF_MS,
  CHECK_LEASE_MS,
  claimItemChecks,
  DAY_MS,
  dayOf,
  ITEM_CHECK_CANDIDATES,
  ITEM_CHECKS_PER_ROUND,
  OWNER_CHECKS_PER_DAY,
} from "../src/domain/collection-checks";
import { checkCollectionItems } from "../src/federation/collection-checks";
import { REQUEST_MAX_BYTES, REQUEST_MAX_FETCHES } from "../src/federation/loader";
import { sql } from "./api-helpers";
import { inboxDeps, NOW } from "./app-helpers";
import {
  ACCEPTED,
  cavageRefused,
  checkRound,
  checkUntilQuiet,
  collection,
  COLLECTIONS_ONLY,
  featuredOwner,
  item,
  type Item,
  type ItemRow,
  items,
  nextDue,
  PENDING,
  REJECTED,
  REVOKED,
  requestSync,
  seededMembers,
  serveAuthorization,
  serveCollections,
  storedOwner,
  syncAll,
} from "./featured-collection-helpers";
import { BUILD } from "./helpers";
import type { RemoteWeb } from "./inbox-helpers";
import { OTHER, setup, type Setup } from "./inbox-status-helpers";
import { measuredRead } from "./read-helpers";

// The checks of remote members' feature authorizations (#1589's D22: domain/collection-checks.ts,
// federation/collection-checks.ts): each item of a remote collection checked once per revision, in job rounds apart
// from the syncs, each claim fenced by its token, at most five attempts a revision and OWNER_CHECKS_PER_DAY claims an
// owner a UTC day.

type Loader = Parameters<typeof inboxDeps>[1];

const byUri = (rows: ItemRow[]) => new Map(rows.map((row) => [row.uri, row]));

// The web's loader with `fetch` in place of its own.
const withFetch = (web: RemoteWeb, fetch: typeof globalThis.fetch): Loader => ({ ...web.loader, fetch });

// The web's fetch, answering 503 to the first fetch of each of `urls`.
function failingOnce(web: RemoteWeb, urls: Set<string>): typeof fetch {
  const failed = new Set<string>();
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (urls.has(request.url) && !failed.has(request.url)) {
      failed.add(request.url);
      return new Response("Service Unavailable", { status: 503 });
    }
    return web.fetch(request);
  };
}

const quota = async (t: Setup, owner: string) =>
  (
    await sql<{ day: number; used: number }>(
      t.store,
      "SELECT day, used FROM collection_check_quotas WHERE account_id = ?",
      owner,
    )
  )[0];

const fetchesOf = (web: RemoteWeb, url: string, from = 0) => web.fetched.slice(from).filter((u) => u === url).length;

describe("the check of an item", () => {
  it("settles each outcome within two sends, and clears the claim", async () => {
    const t = await setup();
    const owner = await featuredOwner(t.web, "owner", COLLECTIONS_ONLY);
    const entries = (await seededMembers(t, 7)).map((member) => item(owner, member));
    const listed = collection(owner, entries);
    serveCollections(t.web, owner, [[listed]]);
    const [accepted, gone404, gone410, wrongObject, redirected, large, failing] = entries;
    serveAuthorization(t.web, accepted!, listed.id);
    t.web.fail(gone404!.featureAuthorization, 404);
    t.web.fail(gone410!.featureAuthorization, 410);
    serveAuthorization(t.web, wrongObject!, `${owner.uri}/collections/another`);
    const moved = `${redirected!.featureAuthorization}/moved`;
    t.web.redirect(redirected!.featureAuthorization, moved);
    serveAuthorization(t.web, { ...redirected!, featureAuthorization: moved }, listed.id);
    serveAuthorization(t.web, large!, listed.id);
    const served = t.web.served.get(large!.featureAuthorization)!.body as object;
    t.web.serve(large!.featureAuthorization, { ...served, padding: "x".repeat(65 * 1024) });
    t.web.fail(failing!.featureAuthorization, 500);
    await storedOwner(t, owner);
    await syncAll(t);

    const sent: string[] = [];
    const loader = withFetch(t.web, cavageRefused(t.web, OTHER, sent));
    expect(await checkRound(t, NOW, loader)).toBe(true);
    expect(await checkRound(t, NOW, loader)).toBe(false);
    const rows = byUri(await items(t));
    const settled = { check_due_at: null, check_token: null, check_attempts: 1 };
    expect(rows.get(accepted!.id)).toMatchObject({
      ...settled,
      state: ACCEPTED,
      approval_uri: accepted!.featureAuthorization,
    });
    for (const gone of [gone404!, gone410!]) {
      expect(rows.get(gone.id)).toMatchObject({ ...settled, state: REJECTED, approval_uri: null });
    }
    for (const kept of [wrongObject!, redirected!, large!]) {
      expect(rows.get(kept.id)).toMatchObject({ ...settled, state: PENDING, approval_uri: null });
    }
    expect(rows.get(failing!.id)).toMatchObject({
      state: PENDING,
      check_due_at: NOW + CHECK_BACKOFF_MS,
      check_token: null,
      check_attempts: 1,
    });
    for (const entry of entries) {
      expect(sent.filter((url) => url === entry.featureAuthorization).length).toBeLessThanOrEqual(2);
    }
    // The redirect is not followed.
    expect(sent).not.toContain(moved);
  });

  it("rejects on a 4xx other than 401, 408 and 429, and retries those and a 5xx", async () => {
    const t = await setup();
    const owner = await featuredOwner(t.web, "owner", COLLECTIONS_ONLY);
    const final = [400, 403, 422];
    const passing = [401, 408, 429, 501];
    const statuses = [...final, ...passing];
    const entries = (await seededMembers(t, statuses.length)).map((member) => item(owner, member));
    const listed = collection(owner, entries);
    serveCollections(t.web, owner, [[listed]]);
    entries.forEach((entry, n) => t.web.fail(entry.featureAuthorization, statuses[n]!));
    await storedOwner(t, owner);
    await syncAll(t);
    await checkRound(t, NOW);
    await checkRound(t, NOW);
    const rows = byUri(await items(t));
    entries.forEach((entry, n) => {
      expect(rows.get(entry.id), String(statuses[n])).toMatchObject(
        final.includes(statuses[n]!)
          ? { state: REJECTED, check_due_at: null, check_token: null, check_attempts: 1 }
          : { state: PENDING, check_due_at: NOW + CHECK_BACKOFF_MS, check_token: null, check_attempts: 1 },
      );
    });
  });

  it("accepts only an authorization naming the item's member as its target, on that member's server", async () => {
    const t = await setup();
    const owner = await featuredOwner(t.web, "owner", COLLECTIONS_ONLY);
    const [member, neighbour, restored] = await seededMembers(t, 3);
    const named = item(owner, member!);
    const moved = item(owner, restored!);
    const listed = collection(owner, [named, moved]);
    serveCollections(t.web, owner, [[listed]]);
    // The member's server serves an authorization of the collection for another of its accounts.
    serveAuthorization(t.web, { ...named, featuredObject: neighbour!.uri }, listed.id);
    await storedOwner(t, owner);
    await syncAll(t);
    // A restored row whose candidate is on another server than its member (no writer stores one), that server serving
    // an authorization naming the member.
    const elsewhere = "https://elsewhere.example/feature_authorizations/1";
    await sql(t.store, "UPDATE collection_items SET candidate_approval_uri = ? WHERE uri = ?", elsewhere, moved.id);
    serveAuthorization(t.web, { ...moved, featureAuthorization: elsewhere }, listed.id);

    expect(await checkRound(t)).toBe(false);
    for (const [entry, fetched] of [
      [named, named.featureAuthorization],
      [moved, elsewhere],
    ] as const) {
      expect(t.web.fetched).toContain(fetched);
      expect(byUri(await items(t)).get(entry.id)).toMatchObject({
        state: PENDING,
        approval_uri: null,
        check_due_at: null,
        check_token: null,
      });
    }
  });

  it("claims no restored revoked row back to accepted while its member's server serves the authorization", async () => {
    const t = await setup();
    const owner = await featuredOwner(t.web, "owner", COLLECTIONS_ONLY);
    const [member] = await seededMembers(t, 1);
    const entry = item(owner, member!);
    const listed = collection(owner, [entry]);
    serveAuthorization(t.web, entry, listed.id);
    serveCollections(t.web, owner, [[listed]]);
    await storedOwner(t, owner);
    await syncAll(t);
    // A row the schema admits and a restore may hold: revoked, its candidate kept, queued now.
    await sql(t.store, "UPDATE collection_items SET state = ? WHERE uri = ?", REVOKED, entry.id);
    expect(await items(t)).toMatchObject([{ state: REVOKED, check_due_at: NOW }]);
    await checkRound(t);
    expect(t.web.fetched).toContain(entry.featureAuthorization);
    expect(await items(t)).toMatchObject([{ state: REVOKED, approval_uri: null }]);
  });

  it("leaves pending, without an error, a match whose authorization the member holds in another row", async () => {
    const t = await setup();
    const owner = await featuredOwner(t.web, "owner", COLLECTIONS_ONLY);
    const [member] = await seededMembers(t, 1);
    const first = item(owner, member!);
    const firstListed = collection(owner, [first]);
    serveCollections(t.web, owner, [[firstListed]]);
    serveAuthorization(t.web, first, firstListed.id);
    const ownerId = await storedOwner(t, owner);
    await syncAll(t);
    expect(await checkRound(t)).toBe(false);
    expect(await items(t)).toMatchObject([{ state: ACCEPTED, approval_uri: first.featureAuthorization }]);

    // A second collection naming the same authorization, which the member's server now serves for it.
    const second = { ...item(owner, member!), featureAuthorization: first.featureAuthorization };
    const secondListed = collection(owner, [second]);
    serveCollections(t.web, owner, [[firstListed, secondListed]]);
    serveAuthorization(t.web, second, secondListed.id);
    await requestSync(t, ownerId);
    await syncAll(t);
    expect(await checkRound(t)).toBe(false);
    expect(byUri(await items(t)).get(second.id)).toMatchObject({
      state: PENDING,
      approval_uri: null,
      candidate_approval_uri: first.featureAuthorization,
      check_due_at: null,
      check_token: null,
    });
  });
});

describe("the check rounds", () => {
  it(
    "check 250 items in 63 rounds of at most 8 sends, the owner renaming a collection before every round",
    { timeout: 120_000 },
    async () => {
      const t = await setup();
      const owner = await featuredOwner(t.web, "owner", COLLECTIONS_ONLY);
      const members = await seededMembers(t, 250);
      const lists = Array.from({ length: 10 }, (_, n) => members.slice(n * 25, n * 25 + 25).map((m) => item(owner, m)));
      const listed = lists.map((entries) => collection(owner, entries));
      listed.forEach((entry, n) => lists[n]!.forEach((member) => serveAuthorization(t.web, member, entry.id)));
      serveCollections(t.web, owner, [listed.slice(0, 5), listed.slice(5)]);
      const ownerId = await storedOwner(t, owner);
      await syncAll(t);
      expect((await items(t)).filter((row) => row.check_due_at === NOW)).toHaveLength(250);

      const sent: string[] = [];
      const loader = withFetch(t.web, cavageRefused(t.web, OTHER, sent));
      let renamed = 0;
      let before = 0;
      const perRound: { sends: number; bytes: number }[] = [];
      const bytesOf = (urls: string[]) =>
        urls.reduce((n, url) => n + JSON.stringify(t.web.served.get(url)?.body ?? null).length, 0);
      const { rounds } = await checkUntilQuiet(t, NOW, loader, async (now) => {
        perRound.push({ sends: sent.length - before, bytes: bytesOf(sent.slice(before)) });
        before = sent.length;
        // An owner's change before every round: a sync reads it (no sync phase holds the checks).
        renamed++;
        const pages = [listed.slice(0, 5), listed.slice(5)].map((page) =>
          page.map((entry) => ({ ...entry, name: `${entry.name} (${renamed})` })),
        );
        serveCollections(t.web, owner, pages);
        await requestSync(t, ownerId);
        await syncAll(t, t.web.loader, now);
      });
      expect(rounds).toBe(Math.ceil(250 / ITEM_CHECKS_PER_ROUND));
      expect(await items(t)).toSatisfy((rows: ItemRow[]) =>
        rows.every((row) => row.state === ACCEPTED && row.check_due_at === null),
      );
      expect(perRound.every((round) => round.sends <= REQUEST_MAX_FETCHES)).toBe(true);
      expect(perRound.every((round) => round.bytes <= REQUEST_MAX_BYTES)).toBe(true);
      expect(await quota(t, ownerId)).toEqual({ day: dayOf(NOW), used: 250 });
    },
  );

  it("accept every item through transient failures and a round abandoned after its claims", async () => {
    const t = await setup();
    const owner = await featuredOwner(t.web, "owner", COLLECTIONS_ONLY);
    const entries = (await seededMembers(t, 25)).map((member) => item(owner, member));
    const listed = collection(owner, entries);
    entries.forEach((entry) => serveAuthorization(t.web, entry, listed.id));
    serveCollections(t.web, owner, [[listed]]);
    await storedOwner(t, owner);
    await syncAll(t);

    // A Worker that claimed and died: its leases run out.
    const abandoned = await t.store.claimItemChecks(BUILD, { now: NOW });
    expect(abandoned.checks).toHaveLength(ITEM_CHECKS_PER_ROUND);
    const third = new Set(entries.filter((_, n) => n % 3 === 0).map((entry) => entry.featureAuthorization));
    await checkUntilQuiet(t, NOW, withFetch(t.web, failingOnce(t.web, third)));
    const rows = await items(t);
    expect(rows).toHaveLength(25);
    for (const row of rows) {
      expect(row).toMatchObject({ state: ACCEPTED, check_due_at: null, check_token: null });
    }
    // One attempt each, one more for a transient failure and one for the abandoned claim.
    const abandonedClaims = new Set(abandoned.checks.map((check) => check.authorization));
    for (const entry of entries) {
      const extra = [third, abandonedClaims].filter((set) => set.has(entry.featureAuthorization)).length;
      expect(byUri(rows).get(entry.id)!.check_attempts).toBe(1 + extra);
    }
  });

  it("apply a completion only under its claim's token", async () => {
    const t = await setup();
    const owner = await featuredOwner(t.web, "owner", COLLECTIONS_ONLY);
    const [member] = await seededMembers(t, 1);
    const entry = item(owner, member!);
    serveCollections(t.web, owner, [[collection(owner, [entry])]]);
    await storedOwner(t, owner);
    await syncAll(t);

    const a = (await t.store.claimItemChecks(BUILD, { now: NOW })).checks[0]!;
    // A's lease runs out; B claims the item again.
    const later = NOW + CHECK_LEASE_MS;
    const b = (await t.store.claimItemChecks(BUILD, { now: later })).checks[0]!;
    expect(b.item).toBe(a.item);
    expect(b.token).not.toBe(a.token);
    const complete = (check: typeof a, outcome: "match" | "gone") =>
      t.store.completeItemChecks(BUILD, { now: later, results: [{ item: check.item, token: check.token, outcome }] });
    await complete(a, "match");
    expect(await items(t)).toMatchObject([{ state: PENDING, check_token: b.token }]);
    await complete(b, "gone");
    expect(await items(t)).toMatchObject([{ state: REJECTED, check_token: null }]);
    await complete(a, "match");
    expect(await items(t)).toMatchObject([{ state: REJECTED, approval_uri: null }]);
  });

  it("claim by due time: four always failing do not hold the claim from a fifth, and end after five attempts", async () => {
    const t = await setup();
    const owner = await featuredOwner(t.web, "owner", COLLECTIONS_ONLY);
    const entries = (await seededMembers(t, 5)).map((member) => item(owner, member));
    const failing = entries.slice(0, 4);
    const gone = entries[4]!;
    failing.forEach((entry) => t.web.fail(entry.featureAuthorization, 503));
    t.web.fail(gone.featureAuthorization, 404);
    serveCollections(t.web, owner, [[collection(owner, entries)]]);
    await storedOwner(t, owner);
    await syncAll(t);

    expect(await checkRound(t, NOW)).toBe(true);
    // The four are due again after the backoff, the fifth since the first round.
    expect(await checkRound(t, NOW + CHECK_BACKOFF_MS)).toBe(true);
    expect(byUri(await items(t)).get(gone.id)).toMatchObject({ state: REJECTED });
    await checkUntilQuiet(t, NOW + CHECK_BACKOFF_MS);
    const rows = byUri(await items(t));
    for (const entry of failing) {
      expect(rows.get(entry.id)).toMatchObject({
        state: PENDING,
        check_due_at: null,
        check_token: null,
        check_attempts: 5,
      });
      expect(fetchesOf(t.web, entry.featureAuthorization)).toBe(5);
    }
    expect(await nextDue(t)).toBe(null);
  });

  it("defer a spent owner's items to the next UTC day, claiming another owner's behind them", async () => {
    const t = await setup();
    const spent = await featuredOwner(t.web, "spent", COLLECTIONS_ONLY);
    const other = await featuredOwner(t.web, "other", COLLECTIONS_ONLY);
    const members = await seededMembers(t, 6);
    const spentEntries = members.slice(0, 5).map((member) => item(spent, member));
    const spentListed = collection(spent, spentEntries);
    const otherEntry = item(other, members[5]!);
    const otherListed = collection(other, [otherEntry]);
    spentEntries.forEach((entry) => serveAuthorization(t.web, entry, spentListed.id));
    serveAuthorization(t.web, otherEntry, otherListed.id);
    serveCollections(t.web, spent, [[spentListed]]);
    serveCollections(t.web, other, [[otherListed]]);
    const spentId = await storedOwner(t, spent);
    await syncAll(t);
    await storedOwner(t, other);
    await syncAll(t);
    await sql(
      t.store,
      "INSERT INTO collection_check_quotas (account_id, day, used) VALUES (?, ?, ?)",
      spentId,
      dayOf(NOW),
      OWNER_CHECKS_PER_DAY,
    );

    expect(await checkRound(t, NOW)).toBe(false);
    const rows = byUri(await items(t));
    expect(rows.get(otherEntry.id)).toMatchObject({ state: ACCEPTED });
    for (const entry of spentEntries) {
      expect(rows.get(entry.id)).toMatchObject({
        state: PENDING,
        check_due_at: (dayOf(NOW) + 1) * DAY_MS,
        check_token: null,
        check_attempts: 0,
      });
      expect(fetchesOf(t.web, entry.featureAuthorization)).toBe(0);
    }
    await checkUntilQuiet(t, NOW);
    expect(await items(t)).toSatisfy((all: ItemRow[]) => all.every((row) => row.state === ACCEPTED));
    expect(await quota(t, spentId)).toEqual({ day: dayOf(NOW) + 1, used: 5 });
  });

  it("defer a spent owner's items from the last day a quota row holds to a due time the queue holds", async () => {
    const t = await setup();
    const owner = await featuredOwner(t.web, "owner", COLLECTIONS_ONLY);
    const [member] = await seededMembers(t, 1);
    const entry = item(owner, member!);
    serveCollections(t.web, owner, [[collection(owner, [entry])]]);
    const ownerId = await storedOwner(t, owner);
    await syncAll(t);
    // The latest day collection_check_quotas_day admits (as an import may restore it): a day after it would defer past
    // what collection_items.check_due_at holds, and is refused as stored.
    const last = Math.floor(Number.MAX_SAFE_INTEGER / DAY_MS) - 1;
    expect((last + 2) * DAY_MS).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    await sql(
      t.store,
      "INSERT INTO collection_check_quotas (account_id, day, used) VALUES (?, ?, ?)",
      ownerId,
      last,
      OWNER_CHECKS_PER_DAY,
    );
    await expect(sql(t.store, "UPDATE collection_check_quotas SET day = ?", last + 1)).rejects.toThrow(
      /collection_check_quotas_day/,
    );
    expect(await checkRound(t)).toBe(false);
    expect(await items(t)).toMatchObject([
      { state: PENDING, check_due_at: (last + 1) * DAY_MS, check_token: null, check_attempts: 0 },
    ]);
    expect(fetchesOf(t.web, entry.featureAuthorization)).toBe(0);
  });
});

describe("amplification", () => {
  it("fetches nothing again for settled items listed unchanged", async () => {
    const t = await setup();
    const owner = await featuredOwner(t.web, "owner", COLLECTIONS_ONLY);
    const [rejected, kept] = (await seededMembers(t, 2)).map((member) => item(owner, member)) as [Item, Item];
    const listed = collection(owner, [rejected, kept]);
    t.web.fail(rejected.featureAuthorization, 404);
    serveAuthorization(t.web, kept, `${owner.uri}/collections/another`);
    serveCollections(t.web, owner, [[listed]]);
    const ownerId = await storedOwner(t, owner);
    await syncAll(t);
    expect(await checkRound(t)).toBe(false);
    expect(await items(t)).toMatchObject([
      { state: REJECTED, check_due_at: null },
      { state: PENDING, check_due_at: null },
    ]);
    const from = t.web.fetched.length;
    for (let n = 0; n < 10; n++) {
      await requestSync(t, ownerId);
      await syncAll(t);
    }
    for (const now of [NOW, NOW + 2 * DAY_MS]) {
      expect(await checkRound(t, now)).toBe(false);
    }
    expect(await nextDue(t)).toBe(null);
    expect(
      fetchesOf(t.web, rejected.featureAuthorization, from) + fetchesOf(t.web, kept.featureAuthorization, from),
    ).toBe(0);
  });

  it(
    "holds an owner's churn to 250 claims a UTC day, re-adding an item or changing its authorization after each check",
    { timeout: 120_000 },
    async () => {
      const t = await setup();
      const readding = await featuredOwner(t.web, "readding", COLLECTIONS_ONLY);
      const changing = await featuredOwner(t.web, "changing", COLLECTIONS_ONLY);
      const [first, second] = await seededMembers(t, 2);
      const readded = item(readding, first!);
      const readdedListed = collection(readding, [readded]);
      serveAuthorization(t.web, readded, readdedListed.id);
      const changed = item(changing, second!);
      const changedListed = collection(changing, [changed]);
      const version = (k: number) => ({ ...changed, featureAuthorization: `${changed.featureAuthorization}/v${k}` });
      const relist = (k: number) => {
        t.web.fail(version(k).featureAuthorization, 503);
        serveCollections(t.web, changing, [[{ ...changedListed, orderedItems: [version(k)] }]]);
      };
      serveCollections(t.web, readding, [[readdedListed]]);
      relist(1);
      const readdingId = await storedOwner(t, readding);
      const changingId = await storedOwner(t, changing);
      await syncAll(t);

      const sent: string[] = [];
      const loader = withFetch(t.web, cavageRefused(t.web, OTHER, sent));
      const claimed = { readding: 0, changing: 0 };
      for (let k = 1; k <= OWNER_CHECKS_PER_DAY + 1; k++) {
        const before = sent.length;
        await checkRound(t, NOW, loader);
        const round = sent.slice(before);
        claimed.readding += round.some((url) => url === readded.featureAuthorization) ? 1 : 0;
        claimed.changing += round.some((url) => url === version(k).featureAuthorization) ? 1 : 0;
        // The item removed and listed again; the other's authorization changed.
        serveCollections(t.web, readding, [[{ ...readdedListed, orderedItems: [] }]]);
        relist(k + 1);
        await requestSync(t, readdingId);
        await requestSync(t, changingId);
        await syncAll(t);
        serveCollections(t.web, readding, [[readdedListed]]);
        await requestSync(t, readdingId);
        await syncAll(t);
      }
      expect(claimed).toEqual({ readding: OWNER_CHECKS_PER_DAY, changing: OWNER_CHECKS_PER_DAY });
      expect(await quota(t, readdingId)).toEqual({ day: dayOf(NOW), used: OWNER_CHECKS_PER_DAY });
      expect(await quota(t, changingId)).toEqual({ day: dayOf(NOW), used: OWNER_CHECKS_PER_DAY });
      // At most two sends a claim: the draft-cavage signature, refused, and its RFC 9421 retry.
      expect(sent.length).toBeLessThanOrEqual(2 * 2 * OWNER_CHECKS_PER_DAY);
      // The last listings' items are deferred as the claim reads them, with no send: the next claims are the next day's.
      const quiet = sent.length;
      expect(await checkRound(t, NOW, loader)).toBe(false);
      expect(sent.length).toBe(quiet);
      expect(await nextDue(t)).toBe((dayOf(NOW) + 1) * DAY_MS);
      await checkRound(t, (dayOf(NOW) + 1) * DAY_MS, loader);
      expect(await quota(t, readdingId)).toEqual({ day: dayOf(NOW) + 1, used: 1 });
      expect(await quota(t, changingId)).toEqual({ day: dayOf(NOW) + 1, used: 1 });
    },
  );

  it("charges a claim made at 23:59:59.900 UTC to its day, though its fetch completes after midnight", async () => {
    const t = await setup();
    const owner = await featuredOwner(t.web, "owner", COLLECTIONS_ONLY);
    const [member] = await seededMembers(t, 1);
    const entry = item(owner, member!);
    const listed = collection(owner, [entry]);
    serveAuthorization(t.web, entry, listed.id);
    serveCollections(t.web, owner, [[listed]]);
    const ownerId = await storedOwner(t, owner);
    await syncAll(t);
    const day = dayOf(NOW);
    await sql(
      t.store,
      "INSERT INTO collection_check_quotas (account_id, day, used) VALUES (?, ?, ?)",
      ownerId,
      day,
      OWNER_CHECKS_PER_DAY - 1,
    );
    const clock = { now: (day + 1) * DAY_MS - 100 };
    const held = t.web.hold(entry.featureAuthorization);
    const round = checkCollectionItems(t.env, { ...inboxDeps(() => t.store, t.web.loader), now: () => clock.now });
    await held.reached;
    clock.now = (day + 1) * DAY_MS + 100;
    held.release();
    expect(await round).toBe(false);
    expect(await quota(t, ownerId)).toEqual({ day, used: OWNER_CHECKS_PER_DAY });
    expect(await items(t)).toMatchObject([{ state: ACCEPTED }]);

    // A new revision the next day: that day's count starts at 0.
    const next = { ...item(owner, member!), id: entry.id };
    serveAuthorization(t.web, next, listed.id);
    serveCollections(t.web, owner, [[{ ...listed, orderedItems: [next] }]]);
    await requestSync(t, ownerId);
    await syncAll(t, t.web.loader, clock.now);
    expect(await checkRound(t, clock.now)).toBe(false);
    expect(await quota(t, ownerId)).toEqual({ day: day + 1, used: 1 });
  });
});

describe("an attacker's listing first", () => {
  for (const order of ["in separate rounds", "in one round, the attacker's first", "in one round, the owner's first"]) {
    it(`does not keep the member's real authorization from the owner's item (${order})`, async () => {
      const t = await setup();
      const owner = await featuredOwner(t.web, "owner", COLLECTIONS_ONLY);
      const attacker = await featuredOwner(t.web, "attacker", COLLECTIONS_ONLY, "https://attacker.example");
      const [member] = await seededMembers(t, 1);
      const real = item(owner, member!);
      const listed = collection(owner, [real]);
      serveAuthorization(t.web, real, listed.id);
      const copied = { ...item(attacker, member!), featureAuthorization: real.featureAuthorization };
      serveCollections(t.web, attacker, [[collection(attacker, [copied])]]);
      serveCollections(t.web, owner, [[listed]]);

      const stored = [attacker, owner];
      if (order.endsWith("owner's first")) {
        stored.reverse();
      }
      await storedOwner(t, stored[0]!);
      await syncAll(t);
      if (order === "in separate rounds") {
        expect(await checkRound(t)).toBe(false);
        expect(byUri(await items(t)).get(copied.id)).toMatchObject({
          state: PENDING,
          candidate_approval_uri: real.featureAuthorization,
          approval_uri: null,
          check_due_at: null,
        });
      }
      await storedOwner(t, stored[1]!);
      await syncAll(t);
      expect(await checkRound(t)).toBe(false);
      const rows = byUri(await items(t));
      expect(rows.get(copied.id)).toMatchObject({ state: PENDING, approval_uri: null, check_due_at: null });
      expect(rows.get(real.id)).toMatchObject({ state: ACCEPTED, approval_uri: real.featureAuthorization });
    });
  }
});

describe("a claim's reads", () => {
  // A claim over `collections` full collections of known members, every item due; with `spent`, the owner's quota is
  // spent and the claim defers what it reads. The rows the claim read.
  async function claimRows(collections: number, spent: boolean): Promise<number> {
    const t = await setup();
    const owner = await featuredOwner(t.web, "owner", COLLECTIONS_ONLY);
    const members = await seededMembers(t, collections * 25);
    const listed = Array.from({ length: collections }, (_, n) =>
      collection(
        owner,
        members.slice(n * 25, n * 25 + 25).map((member) => item(owner, member)),
      ),
    );
    serveCollections(
      t.web,
      owner,
      [listed.slice(0, 5), listed.slice(5)].filter((page) => page.length > 0),
    );
    const ownerId = await storedOwner(t, owner);
    await syncAll(t);
    if (spent) {
      await sql(
        t.store,
        "INSERT INTO collection_check_quotas (account_id, day, used) VALUES (?, ?, ?)",
        ownerId,
        dayOf(NOW),
        OWNER_CHECKS_PER_DAY,
      );
    }
    const { output, rows } = await measuredRead(t, claimItemChecks, { now: NOW });
    expect(output.checks).toHaveLength(spent ? 0 : ITEM_CHECKS_PER_ROUND);
    // A spent owner's candidates are all deferred: ITEM_CHECK_CANDIDATES of them, whatever the queue.
    const deferred = await sql(t.store, "SELECT 1 FROM collection_items WHERE check_due_at > ?", NOW + CHECK_LEASE_MS);
    expect(deferred).toHaveLength(spent ? ITEM_CHECK_CANDIDATES : 0);
    return rows;
  }

  for (const spent of [false, true]) {
    it(`reads as many rows with 250 items due as with 25 (${spent ? "deferring" : "claiming"})`, async () => {
      const few = await claimRows(1, spent);
      const many = await claimRows(10, spent);
      expect(many).toBe(few);
    });
  }
});
