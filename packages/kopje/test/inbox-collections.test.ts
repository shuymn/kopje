import { describe, expect, it } from "vitest";

import { sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { mastodon47Signed, mastodonFeatureDelete } from "./author-proof-helpers";
import {
  ACCEPTED,
  checkRound,
  collection,
  collectionRows,
  COLLECTIONS_ONLY,
  featuredOwner,
  item,
  type Item,
  items,
  PENDING,
  REVOKED,
  requestSync,
  serveAuthorization,
  serveCollections,
  storedMember,
  storedOwner,
  syncAll,
} from "./featured-collection-helpers";
import type { TestActor } from "./inbox-helpers";
import { AS, nextId, OTHER, type Setup, setup } from "./inbox-status-helpers";

// Inbound activities of remote collections (#1589's D20, Mastodon 4.7.5's ActivityPub::Activity::Add, Remove, Update
// and Delete#delete_feature_authorization!; domain/inbox.ts, domain/remote-featured-collections.ts): an owner's Add,
// Remove and Update of its collections and their items, id-less as Mastodon sends them, and a member's Delete of its
// feature authorization, sent by the member or relayed by the collection's owner with the member's proof.

type Owner = TestActor & { featuredCollections: string };
type Listed = ReturnType<typeof collection>;

// Mastodon's Add and Remove of a collection or an item: no id (AddFeaturedCollectionSerializer and the others).
function addOrRemove(type: "Add" | "Remove", owner: Owner, target: string, object: unknown, id: string | null = null) {
  return { "@context": AS, ...(id === null ? {} : { id }), type, actor: owner.uri, target, object };
}

function update(owner: Owner, object: Listed) {
  return { "@context": AS, id: `${owner.uri}#updates/${nextId()}`, type: "Update", actor: owner.uri, object };
}

// An owner with one collection of `entries` stored through a read, the member's authorizations served.
async function synced(t: Setup, owner: Owner, entries: Item[]): Promise<{ ownerId: string; listed: Listed }> {
  const listed = collection(owner, entries);
  entries.forEach((entry) => serveAuthorization(t.web, entry, listed.id));
  serveCollections(t.web, owner, [[listed]]);
  const ownerId = await storedOwner(t, owner);
  await syncAll(t);
  return { ownerId, listed };
}

const syncs = (t: Setup) => sql(t.store, "SELECT account_id FROM collection_syncs");

describe("an owner's Add and Remove without an id (D20)", () => {
  it("applies a collection's and an item's once each, and refuses one to the featured collections", async () => {
    const t = await setup();
    const owner = await featuredOwner(t.web, "owner", COLLECTIONS_ONLY);
    const member = await storedMember(t, "member", OTHER);
    const { listed } = await synced(t, owner, []);
    const added = collection(owner, []);
    for (let n = 0; n < 2; n++) {
      expect(await t.post(owner, addOrRemove("Add", owner, owner.featuredCollections, added))).toBe(202);
    }
    expect((await collectionRows(t)).map((row) => row.uri)).toEqual([listed.id, added.id].toSorted());
    const entry = item(owner, member);
    for (let n = 0; n < 2; n++) {
      expect(await t.post(owner, addOrRemove("Add", owner, added.id, entry))).toBe(202);
    }
    expect(await items(t, added.id)).toMatchObject([{ uri: entry.id, state: PENDING, check_due_at: NOW }]);
    for (let n = 0; n < 2; n++) {
      expect(await t.post(owner, addOrRemove("Remove", owner, added.id, entry.id))).toBe(202);
    }
    expect(await items(t, added.id)).toEqual([]);
    expect(await t.post(owner, addOrRemove("Remove", owner, owner.featuredCollections, added.id))).toBe(202);
    expect((await collectionRows(t)).map((row) => row.uri)).toEqual([listed.id]);

    // An id-less Add of a Hashtag to an owner's featured or featuredTags collection is incomplete; with an id, featured.
    const tagger = await featuredOwner(t.web, "tagger", {
      followers: undefined,
      following: undefined,
      outbox: undefined,
    });
    const empty = (id: string) => ({ "@context": AS, id, type: "OrderedCollection", totalItems: 0, orderedItems: [] });
    const targets = [`${tagger.uri}/collections/featured`, `${tagger.uri}/collections/tags`];
    targets.forEach((target) => t.web.serve(target, empty(target)));
    serveCollections(t.web, tagger, [[]]);
    await storedOwner(t, tagger);
    await syncAll(t);
    const hashtag = (name: string) => ({
      type: "Hashtag",
      href: `https://mastodon.example/tags/${name}`,
      name: `#${name}`,
    });
    for (const target of targets) {
      expect(await t.post(tagger, addOrRemove("Add", tagger, target, hashtag("idless")))).toBe(202);
    }
    expect(await sql(t.store, "SELECT name FROM featured_tags")).toEqual([]);
    const id = `${tagger.uri}#adds/${nextId()}`;
    expect(await t.post(tagger, addOrRemove("Add", tagger, targets[1]!, hashtag("named"), id))).toBe(202);
    expect(await sql(t.store, "SELECT name FROM featured_tags")).toEqual([{ name: "named" }]);
    expect(await syncs(t)).toEqual([]);
  });

  it("records the Remove of an item it does not hold, refusing the Add processed after it", async () => {
    const t = await setup();
    const owner = await featuredOwner(t.web, "owner", COLLECTIONS_ONLY);
    const member = await storedMember(t, "member", OTHER);
    const { listed } = await synced(t, owner, []);
    const late = item(owner, member);
    expect(await t.post(owner, addOrRemove("Remove", owner, listed.id, late.id))).toBe(202);
    expect(await t.post(owner, addOrRemove("Add", owner, listed.id, late))).toBe(202);
    expect(await items(t)).toEqual([]);
    expect(await sql(t.store, "SELECT actor_uri FROM inbound_retractions WHERE target_uri = ?", late.id)).toEqual([
      { actor_uri: owner.uri },
    ]);

    // In order: stored, then deleted.
    const timely = item(owner, member);
    expect(await t.post(owner, addOrRemove("Add", owner, listed.id, timely))).toBe(202);
    expect(await items(t)).toMatchObject([{ uri: timely.id }]);
    expect(await t.post(owner, addOrRemove("Remove", owner, listed.id, timely.id))).toBe(202);
    expect(await items(t)).toEqual([]);
  });
});

describe("an owner's Update of a collection", () => {
  it("updates its own stored collection and queues only the items whose revision changed, asking no sync", async () => {
    const t = await setup();
    const owner = await featuredOwner(t.web, "owner", COLLECTIONS_ONLY);
    const other = await featuredOwner(t.web, "other", COLLECTIONS_ONLY);
    await storedOwner(t, other);
    const [kept, changed] = [await storedMember(t, "kept", OTHER), await storedMember(t, "changed", OTHER)];
    const entries = [item(owner, kept), item(owner, changed)];
    const { listed } = await synced(t, owner, entries);
    expect(await checkRound(t)).toBe(false);
    expect(await items(t)).toMatchObject([{ state: ACCEPTED }, { state: ACCEPTED }]);

    const moved = { ...entries[1]!, featureAuthorization: `${entries[1]!.featureAuthorization}/again` };
    const renamed = { ...listed, name: "renamed", orderedItems: [entries[0], moved] };
    expect(await t.post(other, update(other, renamed))).toBe(202);
    expect((await collectionRows(t))[0]!.name).toBe(listed.name);
    expect(await t.post(owner, update(owner, renamed))).toBe(202);
    expect((await collectionRows(t))[0]!.name).toBe("renamed");
    expect(await items(t)).toMatchObject([
      { uri: entries[0]!.id, state: ACCEPTED, check_due_at: null },
      {
        uri: moved.id,
        state: PENDING,
        approval_uri: null,
        candidate_approval_uri: moved.featureAuthorization,
        check_due_at: NOW,
      },
    ]);
    // A collection it does not hold is not stored by an Update.
    expect(await t.post(owner, update(owner, collection(owner, [])))).toBe(202);
    expect(await collectionRows(t)).toHaveLength(1);
    expect(await syncs(t)).toEqual([]);
  });

  it("fetches nothing again for settled items an Update lists unchanged ten times", async () => {
    const t = await setup();
    const owner = await featuredOwner(t.web, "owner", COLLECTIONS_ONLY);
    const [gone, kept] = [await storedMember(t, "gone", OTHER), await storedMember(t, "kept", OTHER)];
    const entries = [item(owner, gone), item(owner, kept)];
    const listed = collection(owner, entries);
    t.web.fail(entries[0]!.featureAuthorization, 404);
    serveAuthorization(t.web, entries[1]!, `${owner.uri}/collections/another`);
    serveCollections(t.web, owner, [[listed]]);
    await storedOwner(t, owner);
    await syncAll(t);
    expect(await checkRound(t)).toBe(false);
    const from = t.web.fetched.length;
    for (let n = 0; n < 10; n++) {
      expect(await t.post(owner, update(owner, listed))).toBe(202);
    }
    expect(await checkRound(t, NOW + 2 * 86_400_000)).toBe(false);
    const fetched = t.web.fetched.slice(from);
    expect(entries.filter((entry) => fetched.includes(entry.featureAuthorization))).toEqual([]);
  });
});

describe("a member's Delete of its feature authorization", () => {
  async function accepted(t: Setup) {
    const owner = await featuredOwner(t.web, "owner", COLLECTIONS_ONLY);
    const member = await storedMember(t, "member", OTHER);
    const entry = item(owner, member);
    const { listed } = await synced(t, owner, [entry]);
    expect(await checkRound(t)).toBe(false);
    expect(await items(t)).toMatchObject([{ state: ACCEPTED, approval_uri: entry.featureAuthorization }]);
    return { owner, member, entry, listed };
  }
  const deleteOf = (member: TestActor, authorization: string, collectionId: string) => {
    const { "@context": _context, ...body } = mastodonFeatureDelete(member, authorization, collectionId);
    return { "@context": AS, ...body };
  };

  it("keeps an accepted item the owner lists while its authorization answers 404, and revokes it at the Delete", async () => {
    const t = await setup();
    const { owner, member, entry, listed } = await accepted(t);
    t.web.fail(entry.featureAuthorization, 404);
    expect(await t.post(owner, update(owner, listed))).toBe(202);
    expect(await checkRound(t)).toBe(false);
    expect(await items(t)).toMatchObject([{ state: ACCEPTED }]);
    expect(await t.post(member, deleteOf(member, entry.featureAuthorization, listed.id))).toBe(202);
    expect(await items(t)).toMatchObject([{ state: REVOKED, check_due_at: null, check_token: null }]);
    // The owner's later listings leave it revoked.
    expect(await t.post(owner, update(owner, listed))).toBe(202);
    const ownerId = (await sql<{ id: string }>(t.store, "SELECT id FROM accounts WHERE uri = ?", owner.uri))[0]!.id;
    await requestSync(t, ownerId);
    await syncAll(t);
    expect(await items(t)).toMatchObject([{ state: REVOKED }]);
  });

  it("revokes only the current authorization: a delayed Delete of a replaced one changes nothing", async () => {
    const t = await setup();
    const { owner, member, entry, listed } = await accepted(t);
    const b = { ...entry, featureAuthorization: `${entry.featureAuthorization}/b` };
    serveAuthorization(t.web, b, listed.id);
    expect(await t.post(owner, update(owner, { ...listed, orderedItems: [b] }))).toBe(202);
    expect(await items(t)).toMatchObject([{ state: PENDING, approval_uri: null, check_due_at: NOW }]);
    const deleteA = deleteOf(member, entry.featureAuthorization, listed.id);
    expect(await t.post(member, deleteA)).toBe(202);
    expect(await items(t)).toMatchObject([{ state: PENDING, check_due_at: NOW }]);
    expect(await checkRound(t)).toBe(false);
    expect(await items(t)).toMatchObject([{ state: ACCEPTED, approval_uri: b.featureAuthorization }]);
    expect(await t.post(member, { ...deleteA, id: `${entry.featureAuthorization}#delete-again` })).toBe(202);
    expect(await items(t)).toMatchObject([{ state: ACCEPTED }]);
    expect(await t.post(member, deleteOf(member, b.featureAuthorization, listed.id))).toBe(202);
    expect(await items(t)).toMatchObject([{ state: REVOKED }]);
  });

  it("revokes an unchecked item by its candidate, before its check", async () => {
    const t = await setup();
    const owner = await featuredOwner(t.web, "owner", COLLECTIONS_ONLY);
    const member = await storedMember(t, "member", OTHER);
    const entry = item(owner, member);
    const { listed } = await synced(t, owner, [entry]);
    expect(await t.post(member, deleteOf(member, entry.featureAuthorization, listed.id))).toBe(202);
    expect(await items(t)).toMatchObject([{ state: REVOKED, check_due_at: null }]);
    expect(await checkRound(t)).toBe(false);
    expect(await items(t)).toMatchObject([{ state: REVOKED }]);
  });

  for (const change of ["unchanged", "changed"] as const) {
    it(`fences a check's completion by its claim: the Delete during the fetch, the owner's Update ${change}`, async () => {
      const t = await setup();
      const owner = await featuredOwner(t.web, "owner", COLLECTIONS_ONLY);
      const member = await storedMember(t, "member", OTHER);
      const entry = item(owner, member);
      const { listed } = await synced(t, owner, [entry]);
      const held = t.web.hold(entry.featureAuthorization);
      const round = checkRound(t);
      await held.reached;
      expect(await t.post(member, deleteOf(member, entry.featureAuthorization, listed.id))).toBe(202);
      expect(await items(t)).toMatchObject([{ state: REVOKED }]);
      const listedNow =
        change === "unchanged" ? entry : { ...entry, featureAuthorization: `${entry.featureAuthorization}/b` };
      expect(await t.post(owner, update(owner, { ...listed, orderedItems: [listedNow] }))).toBe(202);
      held.release();
      await round;
      expect(await items(t)).toMatchObject([
        change === "unchanged"
          ? { state: REVOKED, approval_uri: null }
          : { state: PENDING, approval_uri: null, check_due_at: NOW, check_token: null },
      ]);
    });
  }

  describe("relayed by the collection's owner (mastodonFeature)", () => {
    // Member and owner on one Mastodon server: the member's revocation reaches Kopje only as the owner relays it.
    async function relayWorld() {
      const t = await setup();
      const owner = await featuredOwner(t.web, "owner", COLLECTIONS_ONLY);
      const member = await storedMember(t, "member");
      const entry = item(owner, member);
      const { listed } = await synced(t, owner, [entry]);
      expect(await checkRound(t)).toBe(false);
      return { t, owner, member, entry, listed };
    }

    it("revokes with the member's proof, as Mastodon 4.7.5 signs it", async () => {
      const { t, owner, member, entry, listed } = await relayWorld();
      const body = await mastodon47Signed(mastodonFeatureDelete(member, entry.featureAuthorization, listed.id), member);
      expect(await t.post(owner, body)).toBe(202);
      expect(await items(t)).toMatchObject([{ state: REVOKED }]);
    });

    for (const [name, alter] of [
      ["an altered signature", (body: Record<string, unknown>) => ({ ...body, to: [] })],
      ["no signature", ({ signature: _signature, ...body }: Record<string, unknown>) => body],
      [
        "an extra key in the embedded object",
        (body: Record<string, unknown>) => ({
          ...body,
          object: { ...(body.object as object), attributedTo: "https://other.example/users/member" },
        }),
      ],
    ] as const) {
      it(`changes nothing with ${name}`, async () => {
        const { t, owner, member, entry, listed } = await relayWorld();
        const unsigned = mastodonFeatureDelete(member, entry.featureAuthorization, listed.id);
        const body =
          name === "an extra key in the embedded object"
            ? await mastodon47Signed(alter(unsigned), member)
            : alter(await mastodon47Signed(unsigned, member));
        expect(await t.post(owner, body)).toBe(202);
        expect(await items(t)).toMatchObject([{ state: ACCEPTED }]);
      });
    }
  });
});
