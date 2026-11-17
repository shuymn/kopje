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
  create,
  followed,
  mastodonNote,
  type Note,
  PUBLIC,
  remove,
  setup,
  type Setup,
  update,
} from "./inbox-status-helpers";

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
