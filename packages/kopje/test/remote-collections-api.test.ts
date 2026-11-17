import { describe, expect, it } from "vitest";

import { sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import {
  checkRound,
  collection,
  collectionRows,
  COLLECTIONS_ONLY,
  featuredOwner,
  item,
  items,
  PENDING,
  serveAuthorization,
  serveCollections,
  storedMember,
  storedOwner,
  syncAll,
} from "./featured-collection-helpers";
import { mastodonActor } from "./inbox-helpers";
import { ALICE, ALICE_URI, AS, OTHER, type Setup, setup } from "./inbox-status-helpers";

// 5-T8: remote accounts' collections (#1589's PR 5) through the Mastodon API: presented as stored, R45 showing only
// their accepted members; a local account listed in one is left out of its in_collections (its membership is #1589's
// PR 6); and search with resolve=true finds one by a fetch of a FeaturedCollection whose owner Kopje stores, a stored
// one as stored (ResolveURLService#process_url, FetchRemoteFeaturedCollectionService).

type Presented = {
  id: string;
  uri: string;
  url: string;
  name: string;
  description: string | null;
  local: boolean;
  account_id: string;
  items: { state: string; account_id?: string }[];
};
type Found = { accounts: unknown[]; statuses: unknown[]; hashtags: unknown[]; collections: Presented[] };

const search = async (t: Setup, q: string, extra = "") =>
  (await t.api<Found>(`/api/v2/search?resolve=true&q=${encodeURIComponent(q)}${extra}`)).body;

// An owner stored with one collection of two members: one whose authorization its server serves (accepted by the
// check round), one whose it does not (rejected), and alice, a local account (not stored).
async function world() {
  const t = await setup();
  const owner = await featuredOwner(t.web, "owner", COLLECTIONS_ONLY);
  const kept = await storedMember(t, "kept", OTHER);
  const gone = await storedMember(t, "gone", OTHER);
  const entries = [item(owner, kept), item(owner, gone), item(owner, { uri: ALICE_URI })];
  const listed = collection(owner, entries);
  serveAuthorization(t.web, entries[0]!, listed.id);
  serveCollections(t.web, owner, [[listed]]);
  const ownerId = await storedOwner(t, owner);
  await syncAll(t);
  expect(await checkRound(t)).toBe(false);
  const keptId = (await sql<{ id: string }>(t.store, "SELECT id FROM accounts WHERE uri = ?", kept.uri))[0]!.id;
  return { t, owner, ownerId, listed, keptId };
}

describe("remote collections through the API (5-T8)", () => {
  it("presents one as stored, its description the sanitized HTML, showing only its accepted members", async () => {
    const { t, ownerId, listed, keptId } = await world();
    const [stored] = await collectionRows(t);
    const expected = {
      uri: listed.id,
      url: listed.url,
      name: listed.name,
      description: stored!.description,
      local: false,
      account_id: ownerId,
      items: [expect.objectContaining({ state: "accepted", account_id: keptId })],
    };
    const list = await t.api<{ collections: Presented[] }>(`/api/v1/accounts/${ownerId}/collections`);
    expect(list.body.collections).toEqual([expect.objectContaining(expected)]);
    const id = list.body.collections[0]!.id;
    const shown = await t.api<{ collection: Presented; accounts: { id: string }[] }>(`/api/v1/collections/${id}`);
    expect(shown.body.collection).toEqual(expect.objectContaining(expected));
    expect(shown.body.accounts.map((a) => a.id).toSorted()).toEqual([ownerId, keptId].toSorted());
    expect(stored!.description).toContain("<b>description</b>");
  });

  it("leaves a remote collection listing a local account out of its in_collections", async () => {
    const { t } = await world();
    expect((await items(t)).map((row) => row.object_uri)).not.toContain(ALICE_URI);
    const memberships = await t.api<{ collections: unknown[] }>(`/api/v1/accounts/${ALICE}/in_collections`);
    expect(memberships).toEqual({ status: 200, body: { collections: [] } });
  });
});

describe("search with resolve=true of a remote collection (5-T8)", () => {
  it("answers a stored collection's uri as stored, after its fetch, and only where collections are searched", async () => {
    const { t, listed } = await world();
    t.web.serve(listed.id, { "@context": AS, ...listed, name: "renamed" });
    const found = await search(t, listed.id);
    expect(found).toMatchObject({ accounts: [], statuses: [], hashtags: [] });
    expect(found.collections.map((c) => [c.uri, c.name])).toEqual([[listed.id, listed.name]]);
    expect(t.web.fetched).toContain(listed.id);
    expect((await search(t, listed.id, "&type=collections")).collections.map((c) => c.uri)).toEqual([listed.id]);
    expect((await search(t, listed.id, "&type=accounts")).collections).toEqual([]);
    // As Mastodon's: a fetch that fails finds nothing, stored or not (process_url_from_db finds no collection).
    t.web.fail(listed.id, 503);
    expect((await search(t, listed.id)).collections).toEqual([]);
  });

  it("stores and answers a fetched collection of a stored owner, through its page's alternate too", async () => {
    const { t, owner, ownerId } = await world();
    const member = await storedMember(t, "fresh", OTHER);
    await syncAll(t);
    const entry = item(owner, member);
    const fetched = collection(owner, [entry]);
    t.web.serve(fetched.id, { "@context": AS, ...fetched });
    const found = await search(t, fetched.id);
    expect(found.collections.map((c) => [c.uri, c.account_id, c.items])).toEqual([[fetched.id, ownerId, []]]);
    // Applied as its owner's: its item queued for its check, no sync requested.
    expect(await items(t, fetched.id)).toMatchObject([{ uri: entry.id, state: PENDING, check_due_at: NOW }]);
    expect(await sql(t.store, "SELECT account_id FROM collection_syncs")).toEqual([]);

    // Its page, whose alternate names it.
    const other = collection(owner, []);
    const page = `${owner.uri.replace("/users/", "/@")}/collections/page`;
    t.web.serve(other.id, { "@context": AS, ...other });
    t.web.serveRaw(
      page,
      `<html><head><link rel="alternate" type="application/activity+json" href="${other.id}"></head></html>`,
      "text/html",
    );
    expect((await search(t, page, "&type=collections")).collections.map((c) => c.uri)).toEqual([other.id]);

    // A stored collection reached through a page is answered as stored, its fetched document not applied.
    const renamed = `${page}-renamed`;
    t.web.serve(fetched.id, { "@context": AS, ...fetched, name: "renamed", orderedItems: [] });
    t.web.serveRaw(
      renamed,
      `<html><head><link rel="alternate" type="application/activity+json" href="${fetched.id}"></head></html>`,
      "text/html",
    );
    expect((await search(t, renamed)).collections.map((c) => [c.uri, c.name])).toEqual([[fetched.id, fetched.name]]);
    expect(await items(t, fetched.id)).toMatchObject([{ uri: entry.id }]);
  });

  it("stores nothing for a collection whose owner Kopje does not store, or that its owner does not attribute", async () => {
    const { t, owner } = await world();
    const stranger = await mastodonActor(t.web, "stranger", { origin: OTHER });
    const unknown = collection(stranger, []);
    t.web.serve(unknown.id, { "@context": AS, ...unknown });
    const forged = collection(owner, [], { attributedTo: stranger.uri });
    t.web.serve(forged.id, { "@context": AS, ...forged });
    for (const uri of [unknown.id, forged.id]) {
      expect((await search(t, uri)).collections).toEqual([]);
    }
    expect((await collectionRows(t)).map((row) => row.uri)).not.toContain(unknown.id);
    expect((await collectionRows(t)).map((row) => row.uri)).not.toContain(forged.id);
  });
});
