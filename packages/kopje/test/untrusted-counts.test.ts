import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import type { RemoteStatusInput } from "../src/domain/remote-status-reads";
import { storeRemoteStatus, updateRemoteStatus } from "../src/domain/remote-statuses";
import { parseRemoteStatus } from "../src/federation/remote-status";
import { MAX_UNTRUSTED_COUNT } from "../src/platform/stored-bounds";
import { untrustedCount } from "../src/platform/untrusted-count";
import { sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import captured from "./fixtures/untrusted-counts.json";
import { mastodonActor } from "./inbox-helpers";
import {
  accountId,
  announce,
  AS,
  create,
  followed,
  mastodonNote,
  type Note,
  notifications,
  PUBLIC,
  remove,
  setup,
  type Setup,
  statusRow,
  undo,
  update,
} from "./inbox-status-helpers";
import { viaRoute } from "./profile-page-helpers";
import { act, community, getJson, remoteAccount, seedStatus } from "./status-helpers";
import { authors, round, trendRows, trendStatuses } from "./trend-helpers";
import { one, parseHtml, query, text } from "./web-dom";

// A remote status's untrusted counts (#1749, migration 0113_untrusted_counts): its likes and shares totalItems as
// Mastodon 4.7.5 stores them (platform/untrusted-count.ts) on a Create (create.rb:206-216) and on every Update, explicit
// or implicit (process_status_update_service.rb:44-83, 393-405): a count is assigned only when given, a blank one
// clears it, and an explicit Update that its sensitive of "" rolls back assigns none. docs/mastodon-deviations.md,
// "Retractions and edits of remote statuses".

type Counts = { f: number | null; r: number | null };

const counts = async (t: Setup, uri: string) =>
  (
    await sql<Counts>(
      t.store,
      "SELECT untrusted_favourites_count AS f, untrusted_reblogs_count AS r FROM statuses WHERE uri = ?",
      uri,
    )
  )[0];

const collection = (totalItems: unknown) => ({ type: "Collection", totalItems });

// bob's status, created with `extra`, which alice follows him for.
async function created(extra: Record<string, unknown> = {}) {
  const t = await setup();
  const bob = await mastodonActor(t.web, "bob");
  await followed(t, bob);
  const note = mastodonNote(bob, extra);
  expect(await t.post(bob, create(bob, note))).toBe(202);
  return { t, bob, note };
}

// UC1: untrustedCount against what Mastodon 4.7.5 stores for each `likes` value, captured from its image by
// fixtures/untrusted-counts.rb (its StatusParser and StatusStat methods, ActiveModel's BigInteger, Ruby's JSON.parse).
// A row not assigned keeps the stored count (`kept`), which untrustedCount answers as undefined.
describe("untrustedCount", () => {
  it("was captured from Mastodon 4.7.5's runtime, whose clamp is MAX_UNTRUSTED_COUNT", () => {
    expect([captured.ruby, captured.activemodel, captured.max]).toEqual(["4.0.9", "8.1.3.1", MAX_UNTRUSTED_COUNT]);
    expect(captured.rows.length).toBeGreaterThan(60);
  });

  it.each(captured.rows.map((row) => [row.likes ?? "absent", row] as const))("reads likes %s", (_, row) => {
    const object = JSON.parse(row.likes === null ? "{}" : `{"likes":${row.likes}}`) as { likes?: unknown };
    const read = untrustedCount(object.likes);
    expect(read === undefined ? captured.kept : read).toBe(row.stored);
    expect(read !== undefined).toBe(row.assigned);
  });
});

// A JSON integer too large for a double parses to an infinity, which untrustedCount reads as no count, where Mastodon
// reads an exact Integer and clamps it to MAX_UNTRUSTED_COUNT or 0 (docs/mastodon-deviations.md, "Retractions and
// edits of remote statuses"); 1e400, a Float in both, is no count in both (the captured row).
describe("a totalItems past a double's range", () => {
  const huge = `1${"0".repeat(400)}`;
  const read = (literal: string) =>
    untrustedCount((JSON.parse(`{"likes":{"totalItems":${literal}}}`) as { likes: unknown }).likes);

  it("is no count, as a 401-digit integer of either sign and as 1e400", () => {
    expect([huge, `-${huge}`, "1e400"].map(read)).toEqual([null, null, null]);
    expect(captured.rows.find((row) => row.likes === '{"totalItems":1e400}')).toMatchObject({
      assigned: true,
      stored: null,
    });
  });
});

describe("a remote status's untrusted counts", () => {
  it("are read from likes and shares when each is an object with totalItems", () => {
    const note = (extra: Record<string, unknown>) =>
      parseRemoteStatus({
        id: "https://mastodon.example/users/bob/statuses/1",
        type: "Note",
        attributedTo: "https://mastodon.example/users/bob",
        content: "<p>hi</p>",
        to: [PUBLIC],
        ...extra,
      });
    expect(note({ likes: collection(42), shares: collection("7abc") })).toMatchObject({
      untrustedFavourites: 42,
      untrustedReblogs: 7,
    });
    // Not given: no collection, one by IRI, one without totalItems or with a null one; "" gives none.
    expect(note({})).toMatchObject({ untrustedFavourites: undefined, untrustedReblogs: undefined });
    expect(note({ likes: "https://mastodon.example/likes", shares: { type: "Collection" } })).toMatchObject({
      untrustedFavourites: undefined,
      untrustedReblogs: undefined,
    });
    expect(note({ likes: collection(null), shares: collection("") })).toMatchObject({
      untrustedFavourites: undefined,
      untrustedReblogs: null,
    });
  });

  it("are stored by a Create, clamped, and none when not given", async () => {
    const { t, bob, note } = await created({ likes: collection(42), shares: collection("7abc") });
    expect(await counts(t, note.id)).toEqual({ f: 42, r: 7 });
    const huge = mastodonNote(bob, { likes: collection(1e30), shares: collection(-3) });
    expect(await t.post(bob, create(bob, huge))).toBe(202);
    expect(await counts(t, huge.id)).toEqual({ f: MAX_UNTRUSTED_COUNT, r: 0 });
    const { likes: _likes, shares: _shares, ...bare } = mastodonNote(bob);
    expect(await t.post(bob, create(bob, bare as Note))).toBe(202);
    expect(await counts(t, bare.id)).toEqual({ f: null, r: null });
  });

  // From a stored 42, each form of likes on an explicit Update (a newer `updated`) and an implicit one (the stored
  // version): only a non-null totalItems is assigned, "" as none. Each Update also gives shares a new count, so it
  // shows the Update applied where likes kept its count.
  const FORMS: [string, unknown, number | null][] = [
    ["no likes", undefined, 42],
    ["likes by IRI", "https://mastodon.example/likes", 42],
    ["likes without totalItems", { type: "Collection" }, 42],
    ["a null totalItems", collection(null), 42],
    ['a totalItems of ""', collection(""), null],
    ["a totalItems of 7", collection(7), 7],
  ];

  it.each(["explicit", "implicit"] as const)("%s Updates assign a count only when given", async (kind) => {
    const { t, bob, note } = await created({ likes: collection(42), shares: collection(1) });
    let minute = 0;
    for (const [name, likes, expected] of FORMS) {
      await sql(t.store, "UPDATE statuses SET untrusted_favourites_count = 42 WHERE uri = ?", note.id);
      const shares = 100 + ++minute;
      const { likes: _likes, ...rest } = note;
      const object = { ...rest, ...(likes === undefined ? {} : { likes }), shares: collection(shares) } as Note;
      const updated = kind === "explicit" ? `2026-10-11T13:${String(minute).padStart(2, "0")}:00Z` : note.published;
      expect(await t.post(bob, update(bob, object, updated as string)), name).toBe(202);
      expect(await counts(t, note.id), name).toEqual({ f: expected, r: shares });
    }
  });

  // handle_implicit_update! assigns no sensitive, so its counts apply whatever the Update's sensitive; the explicit
  // update's transaction rolls back on a sensitive of "" (NOT NULL), its counts with it.
  it('are assigned by an implicit Update whose sensitive is "", and not by an explicit one', async () => {
    const { t, bob, note } = await created({ likes: collection(42), shares: collection(1) });
    const blank = { ...note, sensitive: "", likes: collection(5), shares: collection(6) };
    expect(await t.post(bob, update(bob, blank, note.published as string))).toBe(202);
    expect(await counts(t, note.id)).toEqual({ f: 5, r: 6 });
    const edit = { ...blank, likes: collection(9), shares: collection(10) };
    expect(await t.post(bob, update(bob, edit, "2026-10-11T13:00:00Z"))).toBe(202);
    expect(await counts(t, note.id)).toEqual({ f: 5, r: 6 });
    // The same explicit Update with a sensitive of its own applies.
    expect(await t.post(bob, update(bob, { ...edit, sensitive: false }, "2026-10-11T13:00:00Z"))).toBe(202);
    expect(await counts(t, note.id)).toEqual({ f: 9, r: 10 });
  });

  // handle_implicit_update! broadcasts only when the quote's state moved (:82): counts alone notify no booster of an
  // edit and keep the outcome an implicit Update without them has.
  it("alone make an implicit Update notify nothing and keep its outcome", async () => {
    const { t, bob, note } = await created({ likes: collection(42), shares: collection(1) });
    const id = (await statusRow(t.store, note.id))!.id;
    const boosted = await t.request(`/api/v1/statuses/${id}/reblog`, {
      method: "POST",
      headers: { authorization: `Bearer ${t.tokens.alice}` },
    });
    expect(boosted.status).toBe(200);
    const counted = { ...note, likes: collection(43), shares: collection(2) };
    expect(await t.post(bob, update(bob, counted, note.published as string))).toBe(202);
    expect(await counts(t, note.id)).toEqual({ f: 43, r: 2 });
    expect((await notifications(t.store)).filter((n) => n.type === "update")).toEqual([]);
    const author = { id: (await accountId(t.store, bob.uri))!, uri: bob.uri };
    const ctx = { now: NOW, storeNow: NOW, origin: "https://kopje.test", deliveredTo: null, fetched: true };
    const outcome = await runInDurableObject(t.store, (_instance, state) =>
      updateRemoteStatus(
        new Db(state.storage.sql),
        author,
        { ...parseRemoteStatus({ ...note, likes: collection(44) })!, updated: note.published as string },
        ctx,
      ),
    );
    expect(outcome).toMatchObject({ applied: false, reason: "stale" });
    expect(await counts(t, note.id)).toEqual({ f: 44, r: 1 });
  });

  // A status Kopje fetches again (a search with resolve, /authorize_interaction, a pin sync, a replies walk) is applied
  // as its author's Update (storeFetchedStatus, fetch_remote_status_service.rb:48), its counts with it.
  it("are assigned by a refetch of a stored status", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const note = mastodonNote(bob, { likes: collection(42), shares: collection(7) });
    const search = async () => {
      t.web.serve(note.id, { "@context": AS, ...note });
      const found = await t.api<{ statuses: { favourites_count: number; reblogs_count: number }[] }>(
        `/api/v2/search?resolve=true&type=statuses&q=${encodeURIComponent(note.id)}`,
      );
      return found.body.statuses.map((s) => [s.favourites_count, s.reblogs_count]);
    };
    expect(await search()).toEqual([[42, 7]]);
    note.likes = collection(9);
    note.shares = collection("");
    expect(await search()).toEqual([[9, 0]]);
    expect(await counts(t, note.id)).toEqual({ f: 9, r: null });
  });

  it("are left by an older, a future, a retracted or another author's Update", async () => {
    const { t, bob, note } = await created({ likes: collection(42), shares: collection(1) });
    const given = { ...note, likes: collection(7), shares: collection(8) };
    // An edit moves the stored version, so an Update before it is older.
    expect(await t.post(bob, update(bob, given, "2026-10-11T14:00:00Z"))).toBe(202);
    expect(await counts(t, note.id)).toEqual({ f: 7, r: 8 });
    const changed = { ...note, likes: collection(70), shares: collection(80) };
    expect(await t.post(bob, update(bob, changed, "2026-10-11T13:00:00Z"))).toBe(202);
    const future = new Date(NOW + 6 * 60_000).toISOString();
    expect(await t.post(bob, update(bob, changed, future))).toBe(202);
    const eve = await mastodonActor(t.web, "eve");
    expect(await t.post(eve, update(eve, { ...changed, attributedTo: eve.uri }, "2026-10-11T15:00:00Z"))).toBe(202);
    expect(await t.post(eve, update(eve, changed, "2026-10-11T15:00:00Z"))).toBe(202);
    expect(await counts(t, note.id)).toEqual({ f: 7, r: 8 });
    // The same Update by its author, newer than the stored version, applies; after a Delete it stores nothing, the
    // status removed included (ID-7).
    expect(await t.post(bob, update(bob, changed, "2026-10-11T15:00:00Z"))).toBe(202);
    expect(await counts(t, note.id)).toEqual({ f: 70, r: 80 });
    expect(await t.post(bob, remove(bob, note.id))).toBe(202);
    expect(await counts(t, note.id)).toBeUndefined();
    expect(await t.post(bob, update(bob, given, "2026-10-11T16:00:00Z"))).toBe(202);
    expect(await counts(t, note.id)).toBeUndefined();
  });

  // The Store writes only what the columns' triggers accept (withinUntrustedCount), whatever the Worker handed it: an
  // input of an earlier build gives no count (undefined) and leaves the stored one, and a value of another shape is not
  // given rather than refused, so the Create or Update still applies.
  it("are written only within their bound, an input without them or past it leaving the stored count", async () => {
    const { t, bob, note } = await created({ likes: collection(42), shares: collection(1) });
    const author = {
      id: (await sql<{ id: string }>(t.store, "SELECT id FROM accounts WHERE uri = ?", bob.uri))[0]!.id,
      uri: bob.uri,
    };
    const ctx = { now: NOW, storeNow: NOW, origin: "https://kopje.test", deliveredTo: null, fetched: true };
    const base = parseRemoteStatus({ ...note, likes: collection(5), shares: collection(6) })!;
    const shaped = (favourites: unknown, reblogs: unknown): RemoteStatusInput => ({
      ...base,
      untrustedFavourites: favourites as number,
      untrustedReblogs: reblogs as number,
    });
    const earlier = (({ untrustedFavourites: _f, untrustedReblogs: _r, ...rest }) => rest)(base);
    await runInDurableObject(t.store, (_instance, state) => {
      const db = new Db(state.storage.sql);
      const stored = () =>
        state.storage.sql
          .exec(
            "SELECT untrusted_favourites_count AS f, untrusted_reblogs_count AS r FROM statuses WHERE uri = ?",
            note.id,
          )
          .one();
      // Implicit (the stored version) and explicit (a newer one): each applies, its counts left.
      for (const [input, updated] of [
        [earlier, note.published],
        [shaped(1.5, -1), note.published],
        [shaped(MAX_UNTRUSTED_COUNT + 1, "7"), "2026-10-11T13:00:00Z"],
        [shaped(Number.NaN, 2 ** 53), "2026-10-11T13:01:00Z"],
      ] as const) {
        const outcome = updateRemoteStatus(db, author, { ...input, updated: updated as string }, ctx);
        expect(outcome.statusId).toBeDefined();
        expect(stored()).toEqual({ f: 42, r: 1 });
      }
      // At the bound's ends it writes them.
      updateRemoteStatus(db, author, { ...shaped(0, MAX_UNTRUSTED_COUNT), updated: "2026-10-11T13:02:00Z" }, ctx);
      expect(stored()).toEqual({ f: 0, r: MAX_UNTRUSTED_COUNT });
      // A Create of an input past the bound stores the status, without counts.
      const other = parseRemoteStatus({ ...mastodonNote(bob), likes: collection(1) })!;
      const outcome = storeRemoteStatus(db, author, { ...other, untrustedFavourites: -1 }, ctx);
      expect(outcome).toMatchObject({ applied: true });
      expect(
        state.storage.sql.exec("SELECT untrusted_favourites_count AS f FROM statuses WHERE uri = ?", other.uri).one(),
      ).toEqual({ f: null });
    });
  });
});

// What a status shows of its favourites and boosts (UC3), how a favourite or a boost moves a remote status's untrusted
// counts (UC4, Mastodon's increment_count! and decrement_count!, status.rb:324-341), and what the trends rank by (UC7).
describe("a status's shown favourites and boosts counts", () => {
  type Shown = { favourites_count: number; reblogs_count: number };
  type Stored = { f: SqlStorageValue; uf: SqlStorageValue; r: SqlStorageValue; ur: SqlStorageValue };

  // alice's status and carol's public reply to it, whose server gave 42 likes and 7 shares.
  async function world() {
    const h = await community(["alice", "bob"]);
    const carol = await remoteAccount(h.store, "carol", "carol.example");
    const focal = await seedStatus(h.store, { accountId: h.users.alice.id, visibility: "public" });
    const reply = await seedStatus(h.store, { accountId: carol, visibility: "public", inReplyToId: focal });
    await sql(
      h.store,
      `UPDATE statuses SET in_reply_to_account_id = ?, untrusted_favourites_count = 42, untrusted_reblogs_count = 7
			WHERE id = ?`,
      h.users.alice.id,
      reply,
    );
    const shown = async (id: string) => {
      const { status, body } = await getJson<Shown>(h, `/api/v1/statuses/${id}`, h.users.bob.token);
      expect(status).toBe(200);
      return [body.favourites_count, body.reblogs_count];
    };
    const stored = async (id: string) =>
      (
        await sql<Stored>(
          h.store,
          `SELECT favourites_count AS f, untrusted_favourites_count AS uf, reblogs_count AS r,
					untrusted_reblogs_count AS ur FROM statuses WHERE id = ?`,
          id,
        )
      )[0];
    return { h, carol, focal, reply, shown, stored };
  }

  it("are a remote status's untrusted ones in the API and on a public page, else its own", async () => {
    const { h, focal, reply, shown } = await world();
    await sql(h.store, "UPDATE statuses SET favourites_count = 1, reblogs_count = 2 WHERE id = ?", reply);
    // alice's status holds untrusted counts an import gave: a local status shows its own.
    await sql(
      h.store,
      "UPDATE statuses SET untrusted_favourites_count = 500, untrusted_reblogs_count = 600 WHERE id = ?",
      focal,
    );
    expect(await shown(reply)).toEqual([42, 7]);
    expect(await shown(focal)).toEqual([0, 0]);
    const main = one(parseHtml(await viaRoute(h)(`/@alice/${focal}`)), "main");
    const tabs = query(one(main, "nav", "tabs"), "a").map(text);
    expect(tabs.filter((t) => /boost|favourite/.test(t))).toEqual(["0 boosts", "0 favourites"]);
    const card = one(one(main, "ul", "feed"), "article");
    expect(query(one(card, "div", "counts"), "span", "vh").map(text)).toEqual([
      "0 replies",
      "7 boosts",
      "42 favourites",
    ]);
    // None stored, its own.
    await sql(
      h.store,
      "UPDATE statuses SET untrusted_favourites_count = NULL, untrusted_reblogs_count = NULL WHERE id = ?",
      reply,
    );
    expect(await shown(reply)).toEqual([1, 2]);
  });

  // The triggers keep any other value out (UC5); the presentation reads one past them as none all the same.
  it("read an untrusted count past its bound as none", async () => {
    const { h, reply, shown } = await world();
    await sql(h.store, "UPDATE statuses SET favourites_count = 1, reblogs_count = 2 WHERE id = ?", reply);
    await runInDurableObject(h.store, (_instance, state) => {
      state.storage.sql.exec("DROP TRIGGER statuses_untrusted_favourites_update");
      state.storage.sql.exec("DROP TRIGGER statuses_untrusted_reblogs_update");
    });
    for (const [favourites, reblogs] of [
      ["many", 1.5],
      [MAX_UNTRUSTED_COUNT + 1, -1],
    ] as const) {
      await sql(
        h.store,
        "UPDATE statuses SET untrusted_favourites_count = ?, untrusted_reblogs_count = ? WHERE id = ?",
        favourites,
        reblogs,
        reply,
      );
      expect(await shown(reply)).toEqual([1, 2]);
    }
  });

  it("move a remote status's untrusted counts with a local favourite or boost, within their bound", async () => {
    const { h, reply, stored } = await world();
    const acted = async (action: string) => {
      const response = await act(h, h.users.bob, `/api/v1/statuses/${reply}/${action}`);
      expect([action, response.status]).toEqual([action, 200]);
      // A boost answers with the boost, which shows its original's counts in reblog.
      const body = await response.json<Shown & { reblog: Shown | null }>();
      return (body.reblog ?? body).favourites_count;
    };
    const set = (columns: string) => sql(h.store, `UPDATE statuses SET ${columns} WHERE id = ?`, reply);
    // One more and one fewer, shown at once.
    expect(await acted("favourite")).toBe(43);
    expect(await acted("reblog")).toBe(43);
    expect(await stored(reply)).toEqual({ f: 1, uf: 43, r: 1, ur: 8 });
    expect(await acted("unfavourite")).toBe(42);
    await acted("unreblog");
    expect(await stored(reply)).toEqual({ f: 0, uf: 42, r: 0, ur: 7 });
    // Floored at 0.
    await acted("favourite");
    await acted("reblog");
    await set("untrusted_favourites_count = 0, untrusted_reblogs_count = 0");
    await acted("unfavourite");
    await acted("unreblog");
    expect(await stored(reply)).toEqual({ f: 0, uf: 0, r: 0, ur: 0 });
    // Capped at MAX_UNTRUSTED_COUNT.
    await set(`untrusted_favourites_count = ${MAX_UNTRUSTED_COUNT}, untrusted_reblogs_count = ${MAX_UNTRUSTED_COUNT}`);
    await acted("favourite");
    await acted("reblog");
    expect(await stored(reply)).toEqual({ f: 1, uf: MAX_UNTRUSTED_COUNT, r: 1, ur: MAX_UNTRUSTED_COUNT });
    // An own count an import stored as text moves it by nothing, as how far it moved is unknown.
    await acted("unfavourite");
    await set("favourites_count = 'many', untrusted_favourites_count = 42");
    await acted("favourite");
    expect(await stored(reply)).toMatchObject({ f: 1, uf: 42 });
    // An own count at either end of SQLite's integers moves it within its bound: past the largest integer the sum is a
    // REAL the cap brings back.
    await set("favourites_count = -9223372036854775808");
    await acted("unfavourite");
    expect(await stored(reply)).toMatchObject({ f: 0, uf: MAX_UNTRUSTED_COUNT });
    await set("favourites_count = 9223372036854775807");
    await acted("favourite");
    expect(await stored(reply)).toMatchObject({ f: 1, uf: 0 });
    // A stale own count moves it by how far counting corrects it, where Mastodon adds or takes one each time.
    await set("favourites_count = 5, untrusted_favourites_count = 42");
    await acted("unfavourite");
    expect(await stored(reply)).toMatchObject({ f: 0, uf: 37 });
    // None stays none.
    await set("untrusted_favourites_count = NULL, untrusted_reblogs_count = NULL");
    await acted("favourite");
    await acted("unreblog");
    expect(await stored(reply)).toEqual({ f: 1, uf: null, r: 0, ur: null });
  });

  it("move a remote status's untrusted boosts with another server's boost and its Undo", async () => {
    const { t, note } = await created({ likes: collection(42), shares: collection(7) });
    const eve = await mastodonActor(t.web, "eve");
    await followed(t, eve);
    const boost = announce(eve, note.id);
    expect(await t.post(eve, boost)).toBe(202);
    expect(await counts(t, note.id)).toEqual({ f: 42, r: 8 });
    expect(await t.post(eve, undo(eve, boost))).toBe(202);
    expect(await counts(t, note.id)).toEqual({ f: 42, r: 7 });
  });

  // Mastodon's trends rank by the status's own counts (trends/statuses.rb:120), not what its server claims.
  it("leave the trends ranked by a status's own counts", async () => {
    const h = await community(["viewer"]);
    const a = await authors(h.store, 2);
    const [claimed = "", counted] = await trendStatuses(h.store, [
      { author: a[0]!, published: NOW - 3_600_000, seq: 0, favourites: 5 },
      { author: a[1]!, published: NOW - 3_600_000, seq: 1, favourites: 50 },
    ]);
    await sql(
      h.store,
      "UPDATE statuses SET untrusted_favourites_count = ?1, untrusted_reblogs_count = ?1 WHERE id = ?2",
      MAX_UNTRUSTED_COUNT,
      claimed,
    );
    await round(h.store, NOW);
    expect((await trendRows(h.store)).map((row) => row.status_id)).toEqual([counted, claimed]);
  });
});
