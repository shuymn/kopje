import { describe, expect, it } from "vitest";

import { railsTime } from "../src/federation/json-shapes";
import { createContextLoader, createSafeLoader } from "../src/federation/loader";
import { fedifyActorView, fetchActor } from "../src/federation/remote-actor";
import { sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { GOTOSOCIAL_ACTOR, MASTODON_ACTOR, MISSKEY_ACTOR } from "./fixtures/actor-documents";
import railsTimes from "./fixtures/rails-time.json";
import { MASTODON, mastodonActor, type TestActor } from "./inbox-helpers";
import { type Acct, AS, type Setup, setup } from "./inbox-status-helpers";

// #1709: Fedify parses an actor document holding only the members Kopje reads from Fedify's object, by their literal
// spelling (federation/remote-actor.ts FEDIFY_MEMBERS, fedifyActorView); every other member, in any spelling, is read
// from the JSON by spelling or not at all, as Mastodon 4.7 reads every member, so none refuses the actor (ID-1, ID-2).
// #1710: `published` among them, read as Rails casts it (federation/json-shapes.ts railsTime).

type Json = Record<string, unknown>;

// The inventory as written: a member dropped from FEDIFY_MEMBERS or added to it fails "hands Fedify only the
// inventory".
const INVENTORY = [
  "@context",
  "id",
  "type",
  "preferredUsername",
  "inbox",
  "name",
  "summary",
  "url",
  "manuallyApprovesFollowers",
  "discoverable",
  "indexable",
  "movedTo",
  "alsoKnownAs",
  "publicKey",
  "assertionMethod",
  "owner",
  "controller",
  "publicKeyPem",
  "publicKeyMultibase",
];

const PNG = `${MASTODON}/system/avatars/spelled.png`;
const DOCUMENT = { type: "Document", mediaType: "image/png", url: PNG };

type Row = { display_name: string; note: string; avatar_url: string | null; header_url: string | null };
const row = async (t: Setup, uri: string) =>
  (await sql<Row>(t.store, "SELECT display_name, note, avatar_url, header_url FROM accounts WHERE uri = ?", uri))[0];

// The accounts a search resolution of `actor`'s URI answers, its document served as `change` makes it. The document
// is fetched, so an absence is the reading's.
async function resolved(t: Setup, actor: TestActor, change: (document: Json) => Json): Promise<string[]> {
  t.web.serve(actor.uri, change(actor.document));
  t.web.fetched.length = 0;
  const answer = await t.api<{ accounts: Acct[] }>(
    `/api/v2/search?resolve=true&type=accounts&q=${encodeURIComponent(actor.uri)}`,
  );
  expect(t.web.fetched, actor.uri).toContain(actor.uri);
  return answer.body.accounts.map((a) => a.acct);
}

// The document's @context with `terms` appended.
const withTerms = (document: Json, terms: Json): unknown[] => [...(document["@context"] as unknown[]), terms];

// A member spelled other than literally: a compact IRI, the full IRI, and a term the document's own context defines.
function spellings(member: string): { key: string; context: (document: Json) => Json }[] {
  const alias = `x-${member}`;
  return [
    { key: `as:${member}`, context: () => ({}) },
    { key: `${AS}#${member}`, context: () => ({}) },
    { key: alias, context: (document) => ({ "@context": withTerms(document, { [alias]: `as:${member}` }) }) },
  ];
}

describe("members Kopje does not read from Fedify refuse no actor (#1709, ID-1)", () => {
  it("stores an actor whose icon, image, followers or following is spelled as a compact or full IRI", async () => {
    const t = await setup();
    const values: [string, unknown][] = [
      ["icon", DOCUMENT],
      ["image", DOCUMENT],
      ["followers", { type: "Document", id: `${MASTODON}/spelled/followers` }],
      ["followers", 5],
      ["following", { type: "Document", id: `${MASTODON}/spelled/following` }],
      ["following", 5],
    ];
    let n = 0;
    for (const [member, value] of values) {
      for (const spelling of spellings(member)) {
        const name = `spelled${++n}`;
        const actor = await mastodonActor(t.web, name);
        const label = `${spelling.key}: ${JSON.stringify(value)}`;
        const accounts = await resolved(t, actor, (d) => ({ ...d, ...spelling.context(d), [spelling.key]: value }));
        expect(accounts, label).toEqual([`${name}@mastodon.example`]);
        // The control: the literal icon and image, Images, are read.
        expect(await row(t, actor.uri), label).toMatchObject({
          avatar_url: (actor.document.icon as { url: string }).url,
          header_url: (actor.document.image as { url: string }).url,
        });
      }
    }
    // Spelled alone, even an Image gives no avatar or header: only the literal members are read, as Mastodon reads
    // them.
    for (const member of ["icon", "image"]) {
      for (const spelling of spellings(member)) {
        const name = `spelled${++n}`;
        const actor = await mastodonActor(t.web, name);
        const label = `${spelling.key} alone`;
        const accounts = await resolved(t, actor, (d) => {
          const { [member]: _literal, ...rest } = d;
          return { ...rest, ...spelling.context(d), [spelling.key]: { type: "Image", url: PNG } };
        });
        expect(accounts, label).toEqual([`${name}@mastodon.example`]);
        expect(await row(t, actor.uri), label).toMatchObject(
          member === "icon" ? { avatar_url: null } : { header_url: null },
        );
      }
    }
  }, 60_000);

  it("stores an actor whose other members Fedify cannot parse", async () => {
    const t = await setup();
    const loader = { ...t.web.loader, userAgent: "Kopje/test" };
    const cases: [string, Json][] = [
      ["updated", { updated: "garbage" }],
      ["endTime", { endTime: "garbage" }],
      ["duration", { duration: "garbage" }],
      ["tag", { tag: { type: "Mention", href: 5 } }],
      ["nameMap", { nameMap: { en: 5 } }],
    ];
    for (const [name, extra] of cases) {
      const actor = await mastodonActor(t.web, name.toLowerCase());
      expect(await resolved(t, actor, (d) => ({ ...d, ...extra })), name).toEqual([
        `${name.toLowerCase()}@mastodon.example`,
      ]);
      expect((await row(t, actor.uri))?.display_name, name).toBe(actor.document.name);
      const fetched = await fetchActor(actor.uri, createSafeLoader(loader), createContextLoader(loader));
      expect(fetched.kind === "ok" ? fetched.input?.displayName : fetched.kind, name).toBe(actor.document.name);
    }
  });

  it("stores an empty name and bio for a document that gives them only as language maps", async () => {
    const t = await setup();
    const actor = await mastodonActor(t.web, "maps");
    const accounts = await resolved(t, actor, (d) => {
      const { name: _name, summary: _summary, ...rest } = d;
      return { ...rest, nameMap: { en: "Erin" }, summaryMap: { en: "<p>bio</p>" } };
    });
    expect(accounts).toEqual(["maps@mastodon.example"]);
    expect(await row(t, actor.uri)).toMatchObject({ display_name: "", note: "" });
  });
});

describe("what Fedify is handed (#1709, ID-1, ID-2)", () => {
  it("hands Fedify only the inventory", () => {
    for (const [server, document] of [
      ["Mastodon", MASTODON_ACTOR],
      ["Misskey", MISSKEY_ACTOR],
      ["GoToSocial", GOTOSOCIAL_ACTOR],
    ] as [string, Json][]) {
      const view = fedifyActorView(document) as Json;
      const kept = Object.keys(document).filter((key) => INVENTORY.includes(key));
      expect(Object.keys(view), server).toEqual(kept);
      expect(Object.keys(document).length, server).toBeGreaterThan(kept.length);
      for (const key of kept) {
        expect(view[key], `${server} ${key}`).toBe(document[key]);
      }
    }
    // Every member of the inventory a document has is kept, and nothing else: a keyword spelling neither.
    const every = Object.fromEntries(INVENTORY.map((key) => [key, key]));
    expect(fedifyActorView({ ...every, "@id": "x", "@type": "Person", "as:icon": DOCUMENT })).toEqual(every);
    // The key documents Fedify loads itself keep what it reads of them.
    const key = { "@context": "https://w3id.org/security/v1", id: "k", type: "CryptographicKey", owner: "o" };
    expect(fedifyActorView({ ...key, publicKeyPem: "pem" })).toEqual({ ...key, publicKeyPem: "pem" });
    const multikey = { "@context": "https://w3id.org/security/multikey/v1", id: "k", type: "Multikey" };
    expect(fedifyActorView({ ...multikey, controller: "o", publicKeyMultibase: "z" })).toEqual({
      ...multikey,
      controller: "o",
      publicKeyMultibase: "z",
    });
    for (const value of [null, "x", [MASTODON_ACTOR], 1]) {
      expect(fedifyActorView(value)).toBe(value);
    }
  });

  // Listed in docs/mastodon-deviations.md: a kept member Fedify cannot decode refuses the actor, where Mastodon stores
  // it. (A key entry whose key material is not one string is left out before (key-entries.ts readableKeys), so it
  // refuses nothing.)
  it("still refuses an actor whose kept member Fedify cannot parse", async () => {
    const t = await setup();
    const cases: [string, (document: Json) => Json][] = [
      ["url a Link whose href is a number", () => ({ url: { type: "Link", href: 5 } })],
      ["publicKey typed Document", (d) => ({ publicKey: { ...(d.publicKey as Json), type: "Document" } })],
      ["name mapped to icon's IRI", (d) => ({ "@context": withTerms(d, { name: "as:icon" }), name: DOCUMENT })],
    ];
    for (const [label, change] of cases) {
      const actor = await mastodonActor(t.web, label.split(" ")[0]!.toLowerCase());
      expect(await resolved(t, actor, (d) => ({ ...d, ...change(d) })), label).toEqual([]);
      expect(await row(t, actor.uri), label).toBeUndefined();
    }
  });
});

// The instant an ISO 8601 time as Ruby writes it names (a year of four digits or more, signed when negative;
// microseconds), cut to milliseconds as the Store keeps it.
function railsInstant(iso: string): number {
  const parts = /^(-?\d{4,})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})\d{3}Z$/.exec(iso);
  if (parts === null) {
    throw new Error(`not a Rails time: ${iso}`);
  }
  const [year, month, day, hour, minute, second, ms] = parts.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const time = new Date(0);
  time.setUTCFullYear(year, month - 1, day);
  time.setUTCHours(hour, minute, second, ms);
  return time.getTime();
}

describe("an actor's published, as Mastodon assigns it (#1710)", () => {
  // test/fixtures/rails-time.json: what ActiveRecord 8.1.3.1 assigns for each string (rails-time.rb captures it).
  it("reads an actor's published as Rails casts it", () => {
    expect([railsTimes.activerecord, railsTimes.ruby]).toEqual(["8.1.3.1", "4.0.9"]);
    const counts = { read: 0, none: 0, listed: 0 };
    for (const row of railsTimes.rows) {
      const kopje = railsTime(row.value);
      if (row.listed) {
        // A form only Rails reads (docs/mastodon-deviations.md): Rails assigns a value, Kopje none.
        counts.listed++;
        expect(kopje, row.value).toBeNull();
        expect(row.rails === null || row.rails === "blank", row.value).toBe(false);
      } else if (row.rails === null || row.rails === "blank") {
        counts.none++;
        expect(kopje, row.value).toBeNull();
      } else {
        counts.read++;
        expect(kopje === null ? null : Date.parse(kopje), row.value).toBe(railsInstant(row.rails));
      }
    }
    expect(counts.read).toBeGreaterThan(50);
    expect(counts.none).toBeGreaterThan(15);
    expect(counts.listed).toBeGreaterThan(35);
    // Those Date.parse reads otherwise: Rails' cast is not Date.parse.
    expect(["0", "2020", "01/02/2020"].map(railsTime)).toEqual([null, null, null]);
    expect(railsTime("2021-02-29T00:00:00Z")).toBe("2021-03-01T00:00:00.000Z");
    for (const value of [5, {}, [], null, true]) {
      expect(railsTime(value)).toBeNull();
    }
  });

  it("stores an actor whose published Rails would not read, created at the Store's now", async () => {
    const t = await setup();
    const cases: [string, (document: Json) => Json, string][] = [
      ["a number", (d) => ({ ...d, published: 5 }), new Date(NOW).toISOString()],
      ["an object", (d) => ({ ...d, published: {} }), new Date(NOW).toISOString()],
      ["an array", (d) => ({ ...d, published: [] }), new Date(NOW).toISOString()],
      ["garbage", (d) => ({ ...d, published: "garbage" }), new Date(NOW).toISOString()],
      [
        "as:published",
        ({ published: _published, ...d }) => ({ ...d, "as:published": "garbage" }),
        new Date(NOW).toISOString(),
      ],
      // A date alone, which Fedify refused, and a day past the month's end, rolled over as Rails rolls it.
      ["a date", (d) => ({ ...d, published: "2020-01-05" }), "2020-01-05T00:00:00.000Z"],
      ["February 29", (d) => ({ ...d, published: "2021-02-29T00:00:00Z" }), "2021-03-01T00:00:00.000Z"],
    ];
    let n = 0;
    for (const [label, change, created] of cases) {
      const name = `published${++n}`;
      const actor = await mastodonActor(t.web, name);
      expect(await resolved(t, actor, change), label).toEqual([`${name}@mastodon.example`]);
      expect(await sql(t.store, "SELECT created_at FROM accounts WHERE uri = ?", actor.uri), label).toEqual([
        { created_at: created },
      ]);
    }
  });
});
