import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { suggestionCandidateSql, trendableStatusSql } from "../src/domain/audience";
import { readOperation } from "../src/domain/operation";
import { ACCOUNT_STALE_MS } from "../src/domain/remote-actors";
import { TREND_LANGUAGES_JSON } from "../src/domain/trend-languages";
import { ldSignedBodyReadable } from "../src/federation/ld-signed-body";
import { sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import booleans from "./fixtures/actor-booleans.json";
import { mastodonActor, type TestActor } from "./inbox-helpers";
import {
  accountId,
  ALICE,
  announce,
  AS,
  followed,
  mastodonNote,
  nextId,
  type Setup,
  setup,
} from "./inbox-status-helpers";
import { ageAccount, staleAuthorWorld } from "./stale-author-helpers";
import { HOUR, linkPosts, reviewLink, storedLink, trendStatuses } from "./trend-helpers";

// #1747: a remote actor's manuallyApprovesFollowers, discoverable and indexable, read from the document by spelling as
// Mastodon 4.7.5 casts them (federation/remote-actor.ts remoteActorInput, process_account_service.rb:252-256) and
// stored as domain/remote-actors.ts upsertRemoteActor keeps them, on each path that stores an actor document:
// a fetch, an unsigned Update(Person)'s embedded actor and a stale author's refresh, an LD-signed Update(Person) as
// its compaction names its members. test/fixtures/actor-booleans.json holds Mastodon's cast of each value
// (actor-booleans.rb captures it).

type Json = Record<string, unknown>;
type Column = "locked" | "discoverable" | "indexable";
type Flags = Record<Column, number | null>;
type Row = (typeof booleans.rows)[number];

const COLUMNS = booleans.columns as { column: Column; member: string; null: boolean }[];
const MEMBERS = COLUMNS.map((c) => c.member);
const ALL: Flags = { locked: 1, discoverable: 1, indexable: 1 };

// `document` as JSON text without the three members, and with each given `text`, its JSON text as captured (none when
// null): sent as written, so that a float keeps its spelling.
function withFlags(document: Json, text: string | null): string {
  const rest = JSON.stringify(Object.fromEntries(Object.entries(document).filter(([key]) => !MEMBERS.includes(key))));
  const members = text === null ? "" : MEMBERS.map((member) => `,${JSON.stringify(member)}:${text}`).join("");
  return `${rest.slice(0, -1)}${members}}`;
}

// `document` as JSON text with locked's and indexable's members sent as an empty string and discoverable as "true":
// each NOT NULL column then keeps its own stored value (MIXED: the two differ, so a column that kept the other's value
// would show).
function withEmptyLockedAndIndexable(document: Json): string {
  const rest = JSON.stringify(Object.fromEntries(Object.entries(document).filter(([key]) => !MEMBERS.includes(key))));
  return `${rest.slice(0, -1)},"manuallyApprovesFollowers":"","discoverable":"true","indexable":""}`;
}
const MIXED: Flags[] = [
  { locked: 1, discoverable: 0, indexable: 0 },
  { locked: 0, discoverable: 0, indexable: 1 },
];

// What Kopje stores for `row` over `stored` (null: a new account): Rails' cast (Kopje's own where it is listed: a float
// zero), as 0 or 1; where the cast is nil (""), NULL in a column Mastodon's schema leaves nullable (discoverable), and
// in a NOT NULL one (locked, indexable), whose save Mastodon refuses, the stored value, or 0 for a new account
// (docs/mastodon-deviations.md).
function expected(row: Row, stored: Flags | null): Flags {
  const value = row.listed ?? row.rails;
  const flags = {} as Flags;
  for (const { column, null: nullable } of COLUMNS) {
    flags[column] = value !== null ? (value ? 1 : 0) : nullable ? null : (stored?.[column] ?? 0);
  }
  return flags;
}

const flagsOf = async (t: Setup, uri: string) =>
  (
    await sql<Flags & { id: string; display_name: string }>(
      t.store,
      "SELECT id, display_name, locked, discoverable, indexable FROM accounts WHERE uri = ?",
      uri,
    )
  )[0]!;
const setFlags = (t: Setup, uri: string, flags: Flags) =>
  sql(
    t.store,
    "UPDATE accounts SET locked = ?, discoverable = ?, indexable = ? WHERE uri = ?",
    flags.locked,
    flags.discoverable,
    flags.indexable,
    uri,
  );

// The account as stored and as the API shows it, each matched against `flags`, and named `name` (the store ran).
async function expectFlags(t: Setup, uri: string, name: string, flags: Flags, label: string) {
  const { id, display_name, ...stored } = await flagsOf(t, uri);
  expect([label, display_name, stored]).toEqual([label, name, flags]);
  const shown = await t.api<{ locked: boolean; discoverable: boolean | null; indexable: boolean }>(
    `/api/v1/accounts/${id}`,
  );
  expect([label, shown.body.locked, shown.body.discoverable, shown.body.indexable]).toEqual([
    label,
    flags.locked === 1,
    flags.discoverable === null ? null : flags.discoverable === 1,
    flags.indexable === 1,
  ]);
}

// An unsigned Update(Person) of `actor` embedding `object`, its JSON text.
function updateText(actor: TestActor, object: string): string {
  const activity = { "@context": AS, id: `${actor.uri}#updates/${nextId()}`, type: "Update", actor: actor.uri };
  return `${JSON.stringify(activity).slice(0, -1)},"object":${object}}`;
}

describe("a remote actor's flags, as Mastodon 4.7.5 casts them (#1747)", () => {
  it("holds Mastodon's cast of each value, its columns and the forms Kopje lists", () => {
    expect([booleans.activemodel, booleans.ruby]).toEqual(["8.1.3.1", "4.0.9"]);
    expect(COLUMNS).toEqual([
      { column: "locked", member: "manuallyApprovesFollowers", null: false },
      { column: "discoverable", member: "discoverable", null: true },
      { column: "indexable", member: "indexable", null: false },
    ]);
    const kinds = { true: 0, false: 0, nil: 0, listed: 0 };
    for (const row of booleans.rows) {
      if (row.listed !== null) {
        // A float zero: Rails casts a Float, which JSON.parse does not tell from the integer 0.
        expect([row.json, row.rails, row.listed, JSON.parse(row.json) === 0]).toEqual([row.json, true, false, true]);
        kinds.listed++;
      } else {
        kinds[row.rails === null ? "nil" : row.rails ? "true" : "false"]++;
      }
    }
    expect(kinds).toEqual({ true: 42, false: 12, nil: 1, listed: 5 });
  });

  it("reads each value on a fetch of a new account", { timeout: 120_000 }, async () => {
    const t = await setup();
    for (const [n, row] of booleans.rows.entries()) {
      const actor = await mastodonActor(t.web, `fetched${n}`);
      t.web.serveRaw(actor.uri, withFlags(actor.document, row.json));
      const found = await t.api<{ accounts: { acct: string }[] }>(
        `/api/v2/search?resolve=true&type=accounts&q=${encodeURIComponent(actor.uri)}`,
      );
      expect([row.json, found.body.accounts.map((a) => a.acct)]).toEqual([row.json, [`fetched${n}@mastodon.example`]]);
      await expectFlags(t, actor.uri, `fetched${n} <b>display</b>`, expected(row, null), row.json ?? "absent");
    }
  });

  it(
    "reads each value from an Update(Person)'s embedded actor, keeping a stored locked and indexable for an empty string",
    { timeout: 120_000 },
    async () => {
      const t = await setup();
      const bob = await mastodonActor(t.web, "bob");
      await followed(t, bob);
      for (const [n, row] of booleans.rows.entries()) {
        await setFlags(t, bob.uri, ALL);
        const object = withFlags({ ...bob.document, name: `embedded ${n}` }, row.json);
        expect([row.json, await t.post(bob, updateText(bob, object))]).toEqual([row.json, 202]);
        await expectFlags(t, bob.uri, `embedded ${n}`, expected(row, ALL), row.json ?? "absent");
      }
      // A stored false is kept as well, and an explicit false stores false.
      const none = { locked: 0, discoverable: 0, indexable: 0 };
      await setFlags(t, bob.uri, none);
      expect(await t.post(bob, updateText(bob, withFlags({ ...bob.document, name: "kept" }, '""')))).toBe(202);
      await expectFlags(t, bob.uri, "kept", { ...none, discoverable: null }, "a stored false");
      await setFlags(t, bob.uri, ALL);
      expect(await t.post(bob, updateText(bob, withFlags({ ...bob.document, name: "false" }, "false")))).toBe(202);
      await expectFlags(t, bob.uri, "false", none, "an explicit false");
      // Each column keeps its own stored value, not another's.
      for (const [n, stored] of MIXED.entries()) {
        await setFlags(t, bob.uri, stored);
        const object = withEmptyLockedAndIndexable({ ...bob.document, name: `mixed ${n}` });
        expect(await t.post(bob, updateText(bob, object))).toBe(202);
        await expectFlags(t, bob.uri, `mixed ${n}`, { ...stored, discoverable: 1 }, `mixed ${n}`);
      }
    },
  );

  it("reads each value on a stale author's refresh", { timeout: 120_000 }, async () => {
    const { t, bob, erin } = await staleAuthorWorld();
    for (const [n, row] of booleans.rows.entries()) {
      await setFlags(t, erin.uri, ALL);
      await ageAccount(t, erin.uri, new Date(NOW - ACCOUNT_STALE_MS).toISOString());
      t.web.serveRaw(erin.uri, withFlags({ ...erin.document, name: `refreshed ${n}` }, row.json));
      const note = mastodonNote(erin);
      t.web.serve(note.id, { "@context": AS, ...note });
      t.web.fetched.length = 0;
      expect([row.json, await t.post(bob, announce(bob, note.id))]).toEqual([row.json, 202]);
      expect(t.web.fetched).toContain(erin.uri);
      await expectFlags(t, erin.uri, `refreshed ${n}`, expected(row, ALL), row.json ?? "absent");
    }
    // Each column keeps its own stored value, not another's.
    for (const [n, stored] of MIXED.entries()) {
      await setFlags(t, erin.uri, stored);
      await ageAccount(t, erin.uri, new Date(NOW - ACCOUNT_STALE_MS).toISOString());
      t.web.serveRaw(erin.uri, withEmptyLockedAndIndexable({ ...erin.document, name: `mixed ${n}` }));
      const note = mastodonNote(erin);
      t.web.serve(note.id, { "@context": AS, ...note });
      t.web.fetched.length = 0;
      expect(await t.post(bob, announce(bob, note.id))).toBe(202);
      expect(t.web.fetched).toContain(erin.uri);
      await expectFlags(t, erin.uri, `mixed ${n}`, { ...stored, discoverable: 1 }, `refreshed mixed ${n}`);
    }
  });

  // Fedify reads a member by the IRI the document's context gives it, and read none of the three under the
  // ActivityStreams context alone; Mastodon reads the literal member.
  it("reads them from a document whose context does not define them", async () => {
    const t = await setup();
    const actor = await mastodonActor(t.web, "plain", {
      extra: { "@context": [AS, "https://w3id.org/security/v1"], manuallyApprovesFollowers: true, indexable: true },
    });
    const found = await t.api<{ accounts: { acct: string }[] }>(
      `/api/v2/search?resolve=true&type=accounts&q=${encodeURIComponent(actor.uri)}`,
    );
    expect(found.body.accounts.map((a) => a.acct)).toEqual(["plain@mastodon.example"]);
    await expectFlags(t, actor.uri, "plain <b>display</b>", ALL, "the ActivityStreams context alone");
  });
});

// R12 (the directory), R39 (suggestions), R41 (trends) and the link timeline (R8, LinkFeed) list an account only
// when it is discoverable (accounts.discoverable = 1): an actor that writes "false" is listed nowhere, one that writes
// "true" is (docs/visibility.md).
describe("an actor's discoverable as the lists read it (#1747)", () => {
  const LINK = "https://news.example/a";
  const listed = readOperation<{ now: number; viewer: string }, { suggested: string[]; trendable: string[] }>(
    (db, { now, viewer }) => ({
      suggested: db
        .all<{ id: string }>(
          `SELECT a.id FROM accounts a WHERE a.domain IS NOT NULL AND ${suggestionCandidateSql("a.id", "a", "?1")}
						ORDER BY a.id`,
          viewer,
        )
        .map((r) => r.id),
      trendable: db
        .all<{ id: string }>(
          `SELECT s.account_id AS id FROM statuses s WHERE ${trendableStatusSql("s", "?1", "?2")} ORDER BY s.id`,
          new Date(now).toISOString(),
          TREND_LANGUAGES_JSON,
        )
        .map((r) => r.id),
    }),
  );

  it("lists an actor that writes discoverable as the string true, and none that writes the string false", async () => {
    const t = await setup();
    const ids: Record<string, string> = {};
    for (const [name, value] of [
      ["hidden", "false"],
      ["shown", "true"],
    ] as const) {
      const actor = await mastodonActor(t.web, name, { extra: { discoverable: value } });
      await t.api(`/api/v2/search?resolve=true&type=accounts&q=${encodeURIComponent(actor.uri)}`);
      ids[name] = (await accountId(t.store, actor.uri))!;
    }
    const { hidden = "", shown = "" } = ids;
    expect(
      await sql(t.store, "SELECT discoverable FROM accounts WHERE id IN (?, ?) ORDER BY id = ?", hidden, shown, shown),
    ).toEqual([{ discoverable: 0 }, { discoverable: 1 }]);
    const directory = await t.api<{ id: string }[]>("/api/v1/directory?local=false");
    expect(directory.body.map((a) => a.id).filter((id) => id === hidden || id === shown)).toEqual([shown]);
    // A public post by each, linking LINK, which trends.
    await trendStatuses(t.store, [
      { author: hidden, published: NOW - HOUR, seq: 1 },
      { author: shown, published: NOW - HOUR, seq: 2 },
    ]);
    await linkPosts(t.store, [hidden, shown], LINK, NOW - HOUR, { seq: 3 });
    await storedLink(t.store, LINK, 5, 5, NOW);
    await reviewLink(t.store, "link", LINK, true);
    const read = await runInDurableObject(t.store, (_instance, state) =>
      listed.run(state.storage.sql, { now: NOW, viewer: ALICE }),
    );
    expect(read.suggested).toEqual([shown]);
    expect([...new Set(read.trendable)]).toEqual([shown]);
    const timeline = await t.api<{ account: { id: string } }[]>(
      `/api/v1/timelines/link?url=${encodeURIComponent(LINK)}`,
    );
    expect(timeline.status).toBe(200);
    expect(timeline.body.map((s) => s.account.id)).toEqual([shown]);
  });
});

// The embedded actor of an LD-signed Update(Person) is read as Mastodon's compaction under its full context names its
// members (federation/ld-signed-body.ts namedAsCompacted): a flag the body's context leaves undefined is written as a
// blank node's name, and read as absent (false), as Mastodon reads it; one defined as full_context defines it is cast.
// A context that defines it otherwise is no sender's, and rule (5) ignores the whole body.
describe("an LD-signed Update(Person)'s flags (#1747)", () => {
  const TOOT = { toot: "http://joinmastodon.org/ns#", discoverable: "toot:discoverable" };
  const updateOf = (bob: TestActor, context: unknown[]) => {
    const { "@context": _context, ...document } = bob.document as Json;
    return {
      "@context": [AS, "https://w3id.org/security/v1", ...context],
      id: `${bob.uri}#updates/${nextId()}`,
      type: "Update",
      actor: bob.uri,
      to: [`${AS}#Public`],
      object: { ...document, name: "Bob renamed", discoverable: "true" },
      signature: { type: "RsaSignature2017", creator: `${bob.uri}#main-key`, signatureValue: "placeholder" },
    };
  };

  it.each([
    ["defined as full_context defines it", [TOOT], 1],
    ["left undefined", [], 0],
  ] as const)("reads discoverable %s", async (_, context, stored) => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await followed(t, bob);
    await setFlags(t, bob.uri, { locked: 0, discoverable: 1 - stored, indexable: 0 });
    const update = updateOf(bob, [...context]);
    expect(ldSignedBodyReadable(update)).toBe(true);
    expect(await t.post(bob, update)).toBe(202);
    const row = await flagsOf(t, bob.uri);
    expect([row.display_name, row.discoverable]).toEqual(["Bob renamed", stored]);
  });

  it("ignores a body whose context defines discoverable as another IRI", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await followed(t, bob);
    const update = updateOf(bob, [{ ...TOOT, discoverable: "https://other.example/ns#discoverable" }]);
    expect(ldSignedBodyReadable(update)).toBe(false);
    expect(await t.post(bob, update)).toBe(202);
    expect((await flagsOf(t, bob.uri)).display_name).toBe("bob <b>display</b>");
    // The same body defining it as full_context does is applied (the branch ran).
    expect(await t.post(bob, updateOf(bob, [TOOT]))).toBe(202);
    expect((await flagsOf(t, bob.uri)).display_name).toBe("Bob renamed");
  });
});
