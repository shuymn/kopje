import { describe, expect, it } from "vitest";

import { type ApiHarness, seedAccount, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { community } from "./status-helpers";
import { attr, one, parseHtml, query, text } from "./web-dom";
import { countedHarness } from "./web-helpers";

// A local collection's page (/collections/:id, src/domain/web-pages/collection.ts, src/web/pages/collection.tsx): its
// name, owner, description, hashtag and the accepted members R45 shows an anonymous reader (VIS-4), with a sensitive
// collection's description and members behind a disclosure (design §6, PR W).

const T = "2026-10-11T00:00:00.000Z";
const collectionId = (n: number) => String(500000000000000000n + BigInt(n));
const itemId = (n: number) => String(600000000000000000n + BigInt(n));

async function seedCollection(h: ApiHarness, owner: string, n: number, fields: Record<string, unknown> = {}) {
  const local = (await sql(h.store, "SELECT 1 FROM local_accounts WHERE account_id = ?", owner)).length;
  const row = {
    id: collectionId(n),
    account_id: owner,
    local,
    name: `c${n}`,
    sensitive: 0,
    discoverable: 1,
    uri: local === 1 ? null : `https://remote.example/c/${n}`,
    created_at: T,
    updated_at: T,
    ...fields,
  };
  const keys = Object.keys(row);
  await sql(
    h.store,
    `INSERT INTO collections (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
    ...(Object.values(row) as SqlStorageValue[]),
  );
  return row.id;
}

// An item of `member` at `position`, accepted unless `state` says otherwise.
async function seedItem(h: ApiHarness, collection: string, n: number, member: string, position: number, state = 1) {
  await sql(
    h.store,
    `INSERT INTO collection_items (id, collection_id, account_id, state, position, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
    itemId(n),
    collection,
    member,
    state,
    position,
    T,
    T,
  );
}

const suspend = (h: ApiHarness, id: string) =>
  sql(h.store, "UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?", new Date(NOW).toISOString(), id);

async function page(h: ApiHarness, id: string) {
  const response = await h.request(`/collections/${id}`);
  const html = await response.text();
  return { status: response.status, html, doc: parseHtml(html) };
}

// The page's named metas (its description and Open Graph tags), by name.
function metas(doc: ReturnType<typeof parseHtml>): Record<string, string | null> {
  const named: Record<string, string | null> = {};
  for (const meta of query(doc, "meta")) {
    const key = attr(meta, "name") ?? attr(meta, "property");
    if (key !== null && key !== "viewport" && key !== "color-scheme") {
      named[key] = attr(meta, "content");
    }
  }
  return named;
}

// The members' rows: each row's name link.
const rows = (doc: ReturnType<typeof parseHtml>) =>
  query(doc, "ul", "accounts").flatMap((list) =>
    query(list, "li").map((li) => attr(query(li, "a", "name")[0]!, "href")),
  );

async function world() {
  const h = await community(["alice", "bob", "carol", "dave"]);
  const { alice, bob, carol, dave } = h.users;
  return { h, alice: alice.id, bob: bob.id, carol: carol.id, dave: dave.id };
}

describe("a local collection's page", () => {
  // W-T1. Fails if the read adds collectionListedSql (the non-discoverable collection answers 404).
  it("serves a local collection to an anonymous reader, discoverable or not", async () => {
    const { h, alice, bob, carol } = await world();
    const id = await seedCollection(h, alice, 1, {
      name: "Walkers",
      description: "People who walk",
      tag: "Walks",
      discoverable: 0,
    });
    await seedItem(h, id, 1, carol, 2);
    await seedItem(h, id, 2, bob, 1);
    const { status, doc } = await page(h, id);
    expect(status).toBe(200);
    expect(text(one(doc, "title"))).toBe("Walkers");
    expect(text(one(doc, "h1"))).toBe("Walkers");
    // The owner's row is the first, above the members' card.
    const owner = query(one(doc, "main"), "div", "who")[0]!;
    expect([text(one(owner, "span", "handle")), attr(one(owner, "a", "name"), "href")]).toEqual([
      "@alice@kopje.test",
      "/@alice",
    ]);
    expect(query(doc, "p").some((p) => text(p) === "People who walk")).toBe(true);
    const tag = query(doc, "a").find((a) => text(a) === "#walks")!;
    expect(attr(tag, "href")).toBe("/tags/walks");
    expect(rows(doc)).toEqual(["/@bob", "/@carol"]);
    expect(text(query(doc, "h2").find((h2) => text(h2) === "Accounts")!)).toBe("Accounts");
    expect(query(doc, "details")).toEqual([]);
    expect(query(doc, "script")).toEqual([]);
  });

  // W-T2. Fails if the item arm's state test is dropped (the pending member shown), or its availability test (the
  // suspended one).
  it("leaves out what R45 hides from an anonymous reader", async () => {
    const { h, alice, bob, carol, dave } = await world();
    const id = await seedCollection(h, alice, 1);
    await seedItem(h, id, 1, bob, 1);
    await seedItem(h, id, 2, carol, 2, 0);
    await seedItem(h, id, 3, dave, 3);
    await suspend(h, dave);
    const { status, doc } = await page(h, id);
    expect(status).toBe(200);
    expect(rows(doc)).toEqual(["/@bob"]);
    // A collection with no member it shows has the empty line.
    const empty = await seedCollection(h, alice, 2);
    await seedItem(h, empty, 4, carol, 1, 0);
    const none = await page(h, empty);
    expect([rows(none.doc), query(none.doc, "p").some((p) => text(p) === "No accounts yet.")]).toEqual([[], true]);
  });

  // W-T3. Fails if the read skips `local = 1` (the remote collection's id answers 200). A local account is hidden from
  // the pages only by suspension, which answers 410 as its profile does.
  it("answers 404 for an unknown id or a remote collection, and 410 for a suspended owner's", async () => {
    const { h, alice, carol } = await world();
    const remote = await seedAccount(h.store, { username: "erin", domain: "remote.example" });
    const theirs = await seedCollection(h, remote, 1);
    const suspended = await seedCollection(h, carol, 3);
    const served = await seedCollection(h, alice, 4);
    await suspend(h, carol);
    const missing = await (await h.request("/@nobody")).text();
    const gone = await (await h.request("/@carol")).text();
    for (const path of [
      `/collections/${collectionId(99)}`,
      `/collections/${theirs}`,
      "/collections/x",
      `/collections/${served}/x`,
    ]) {
      const response = await h.request(path);
      expect([path, response.status, await response.text()]).toEqual([path, 404, missing]);
    }
    const response = await h.request(`/collections/${suspended}`);
    expect([response.status, await response.text()]).toEqual([410, gone]);
    expect((await page(h, served)).status).toBe(200);
  });

  // W-T4. Fails if the meta test ignores `sensitive` (the description in the head of a sensitive collection).
  it("keeps a sensitive collection's description and members behind a disclosure, and out of the head", async () => {
    const { h, alice, bob } = await world();
    const open = await seedCollection(h, alice, 1, { name: "Open", description: "Seen", language: "de" });
    const closed = await seedCollection(h, alice, 2, { name: "Closed", description: "Hidden", sensitive: 1 });
    await seedItem(h, open, 1, bob, 1);
    await seedItem(h, closed, 2, bob, 1);
    const shown = await page(h, open);
    expect(metas(shown.doc)).toEqual({
      description: "Seen",
      "og:site_name": "kopje.test",
      "og:type": "website",
      "og:title": "Open",
      "og:description": "Seen",
      "og:url": `https://kopje.test/collections/${open}`,
      "og:locale": "de",
    });
    expect(query(shown.doc, "details")).toEqual([]);
    const hidden = await page(h, closed);
    expect(metas(hidden.doc)).toEqual({
      "og:site_name": "kopje.test",
      "og:type": "website",
      "og:title": "Closed",
      "og:url": `https://kopje.test/collections/${closed}`,
    });
    const details = one(hidden.doc, "details", "cw");
    expect(attr(details, "open")).toBeNull();
    expect(text(one(details, "span", "spoiler"))).toBe("Sensitive content");
    expect(query(details, "p").some((p) => text(p) === "Hidden")).toBe(true);
    expect(query(details, "ul", "accounts")).toHaveLength(1);
    expect(
      query(hidden.doc, "link")
        .filter((l) => attr(l, "rel") === "canonical")
        .map((l) => attr(l, "href")),
    ).toEqual([`https://kopje.test/collections/${closed}`]);
  });

  // W-T5.
  it("marks the name and description with the collection's language, and the page with the UI's", async () => {
    const { h, alice } = await world();
    const known = await seedCollection(h, alice, 1, { description: "d", language: "ja" });
    const unknown = await seedCollection(h, alice, 2, { description: "d" });
    for (const [id, lang] of [
      [known, "ja"],
      [unknown, ""],
    ] as const) {
      const { doc } = await page(h, id);
      const description = query(doc, "p").find((p) => text(p) === "d")!;
      expect([attr(one(doc, "html"), "lang"), attr(one(doc, "h1"), "lang"), attr(description, "lang")]).toEqual([
        "en",
        lang,
        lang,
      ]);
    }
  });

  it("reads each page and the site facts in one Store call", async () => {
    const { h, calls } = await countedHarness(["alice", "bob"]);
    const served = await seedCollection(h, h.users.alice.id, 1);
    const suspended = await seedCollection(h, h.users.bob.id, 2);
    await suspend(h, h.users.bob.id);
    for (const [path, status] of [
      [`/collections/${served}`, 200],
      [`/collections/${collectionId(99)}`, 404],
      [`/collections/${suspended}`, 410],
    ] as const) {
      expect([path, await calls(path)]).toEqual([path, { status, calls: ["webCollectionPage"] }]);
    }
  });
});
