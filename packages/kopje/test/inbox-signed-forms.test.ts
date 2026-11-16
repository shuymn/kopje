import { describe, expect, it } from "vitest";

import { isPublicCollection } from "../src/domain/audience";
import { parseActivity } from "../src/federation/inbound";
import { sql } from "./api-helpers";
import corpusFixture from "./fixtures/ld-signed/corpus.json";
import formsFixture from "./fixtures/ld-signed/forms.json";
import { mastodonActor, type TestActor } from "./inbox-helpers";
import { ALICE, followed, localStatus, PUBLIC, type Setup, setup, statusRow } from "./inbox-status-helpers";

// Activities that carry a Linked Data signature, read as received where Mastodon 4.7.5 reads them as their compaction
// under its full_context (docs/mastodon-deviations.md, "Reading inbound activities"; ID-1, VIS-1, RES-2). The
// fixtures (fixtures/ld-signed/, with the scripts that wrote them) hold each body as its sender wrote it and Mastodon's
// own reading of it: the corpus is what Mastodon 4.6.11 and 4.7.5 and Fedify 2.4.5 send; the forms are the bodies
// whose readings differ. Mastodon's side of each case is its captured reading, parsed by Kopje's reader: what Kopje
// would apply had it read the compaction.

type Json = Record<string, unknown>;
type Entry = { name: string; sender?: string; received: Json; reference: string; mastodon?: Json; fallback?: string };

const corpus = corpusFixture as unknown as Entry[];
const forms = new Map((formsFixture as unknown as Entry[]).map((entry) => [entry.name, entry]));

function form(name: string): Entry {
  const entry = forms.get(name);
  if (entry === undefined) {
    throw new Error(`no form ${name}`);
  }
  return entry;
}

const bytes = (json: unknown) => new TextEncoder().encode(JSON.stringify(json));

function without(json: Json, key: string): Json {
  const { [key]: _, ...rest } = json;
  return rest;
}

// Mastodon's reading of a body (ActivityPub::ProcessActivityService#call): its compaction, the signature put back, or,
// where the JSON-LD limits or the compaction refused it, the body as received without its signature.
function mastodonReading(entry: Entry): Json {
  if (entry.fallback !== undefined) {
    return without(entry.received, "signature");
  }
  expect(entry.mastodon).toBeDefined();
  return entry.mastodon!;
}

type Reading = { ok: false; reason: string } | { ok: true; actor: string; activity: Json; target: string | null };

// What Kopje's reader applies from a body: the parsed activity without the body and raw text it keeps, every string of
// a to or cc read through isPublicCollection, so the public collection's spellings read as one. A Delete's `signed`
// is left out: it marks an author proof, which is checked on the received bytes whatever the reading (author-proof.ts).
function read(body: Json): Reading {
  const parsed = parseActivity(bytes(body));
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason };
  }
  const normalize = (value: unknown, key?: string): unknown => {
    if (typeof value === "string") {
      return (key === "to" || key === "cc") && isPublicCollection(value) ? PUBLIC : value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => normalize(item, key));
    }
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([k]) => k !== "raw" && k !== "body" && k !== "signed")
          .map(([k, v]) => [k, normalize(v, k)]),
      );
    }
    return value;
  };
  return {
    ok: true,
    actor: parsed.actor,
    activity: normalize(parsed.activity) as Json,
    target: parsed.target,
  };
}

const kopje = (entry: Entry) => read(entry.received);
// Mastodon's reading as Kopje's reader applies it. Its signature is not read: it is only verified, and only for a
// relayed activity.
const mastodon = (entry: Entry) => read(without(mastodonReading(entry), "signature"));

function accepted(reading: Reading): Json {
  expect(reading.ok).toBe(true);
  return (reading as Extract<Reading, { ok: true }>).activity;
}

function statusOf(reading: Reading): Json {
  return accepted(reading).object as Json;
}

describe("D2: real LD-signed payloads read as Mastodon reads them", () => {
  it("captures every type Mastodon 4.6.11 and 4.7.5 LD-sign and Fedify's activities with and without a proof", () => {
    const names = (sender: string) => corpus.filter((entry) => entry.sender === sender).map((entry) => entry.name);
    const mastodonTypes = [
      "Update(Person)",
      "Create(Note) plain",
      "Create(Note) rich",
      "Update(Note)",
      "Delete(Note)",
      "Announce",
      "Undo(Announce)",
      "Create(Question)",
      "Update(Question)",
      "Delete(Person)",
      "Add(Hashtag)",
      "Remove(Hashtag)",
      "Move",
      "QuoteRequest",
      "Delete(QuoteAuthorization)",
      "FeatureRequest",
      "Delete(FeatureAuthorization)",
    ];
    expect(names("mastodon-4.7.5")).toEqual(mastodonTypes);
    expect(names("mastodon-4.6.11")).toEqual(mastodonTypes);
    expect(names("fedify-2.4.5")).toHaveLength(22);
    for (const entry of corpus) {
      expect(entry.reference).toBe("mastodon-4.7.5");
      expect(entry.received.signature).toMatchObject({ type: "RsaSignature2017" });
    }
  });

  // Fedify's two RSA-only bodies that read otherwise, each pinned below.
  const DIFFERING = new Set(["Create(Question), RSA", "EmojiReact, RSA"]);

  it.each(
    corpus
      .filter((entry) => !DIFFERING.has(entry.name))
      .map((entry) => [`${entry.sender} ${entry.name}`, entry] as const),
  )("%s", (_, entry) => {
    expect(kopje(entry)).toEqual(mastodon(entry));
  });

  it("reads more content than Mastodon: Fedify's votersCount, typed otherwise than full_context", () => {
    // Fedify types it xsd:nonNegativeInteger; full_context leaves it untyped, so the compaction keeps a value object.
    const entry = corpus.find((e) => e.name === "Create(Question), RSA")!;
    expect(statusOf(kopje(entry)).poll).toMatchObject({ votersCount: 0 });
    expect((mastodonReading(entry).object as Json).votersCount).toEqual({
      type: "xsd:nonNegativeInteger",
      "@value": 0,
    });
    expect(statusOf(mastodon(entry)).poll).toMatchObject({ votersCount: null });
    const rest = (reading: Reading) => ({ ...statusOf(reading), poll: null });
    expect(rest(kopje(entry))).toEqual(rest(mastodon(entry)));
  });

  it("reads more content than Mastodon: an EmojiReact, a type Mastodon reads in neither form", () => {
    // Kopje reads it as a favourite (LIKE_TYPES); the compaction writes its type as the full IRI.
    const entry = corpus.find((e) => e.name === "EmojiReact, RSA")!;
    expect(accepted(kopje(entry))).toMatchObject({ type: "Like", object: "https://kopje.test/ap/o/remote-1" });
    expect(mastodonReading(entry).type).toBe("http://litepub.social/ns#EmojiReact");
    expect(mastodon(entry)).toEqual({ ok: false, reason: "unsupported" });
  });

  it("reads Mastodon's payloads alike once the public collection's spellings are taken as one", () => {
    // The only difference in the corpus: the compaction writes the public collection as as:Public.
    const differing = corpus.filter(
      (entry) => JSON.stringify(entry.received.to) !== JSON.stringify(mastodonReading(entry).to),
    );
    for (const entry of differing) {
      expect(mastodonReading(entry).to, entry.name).toEqual(expect.stringMatching(/^as:Public$|^https:/));
    }
    expect(differing.filter((entry) => mastodonReading(entry).to === "as:Public").length).toBeGreaterThan(0);
  });

  it("refuses Mastodon's Add, Remove and FeatureRequest in both forms, as they carry no id or no actor", () => {
    for (const entry of corpus.filter((e) => /^(Add|Remove)\(Hashtag\)$|^FeatureRequest$/.test(e.name))) {
      expect(kopje(entry), `${entry.sender} ${entry.name}`).toEqual({ ok: false, reason: "incomplete" });
      expect(mastodon(entry)).toEqual({ ok: false, reason: "incomplete" });
    }
  });

  it("a Fedify activity with a proof is one Mastodon reads as received", () => {
    const proven = corpus.filter((entry) => entry.received.proof !== undefined);
    expect(proven).toHaveLength(11);
    for (const entry of proven) {
      expect(entry.fallback, entry.name).toBe("Mastodon::InvalidJsonLdError: contains unsupported JSON-LD features");
      expect(kopje(entry)).toEqual(mastodon(entry));
    }
    for (const entry of corpus.filter((e) => e.received.proof === undefined)) {
      expect(entry.fallback, entry.name).toBeUndefined();
    }
  });
});

describe("D1: forms whose readings differ, each named by its class", () => {
  describe("refused where Mastodon applies it", () => {
    it.each([
      ["type as a one-element array", "incomplete"],
      ["type as a compact IRI", "unsupported"],
      ["type as an absolute IRI", "unsupported"],
      ["actor as a one-element array", "incomplete"],
    ])("an envelope: %s", (name, reason) => {
      const entry = form(name);
      expect(kopje(entry)).toEqual({ ok: false, reason });
      expect(accepted(mastodon(entry))).toMatchObject({ type: "Like", object: "https://kopje.test/ap/o/local-1" });
    });

    it.each([
      ["Follow", { type: "Follow", object: "https://kopje.test/ap/users/alice" }],
      ["Block", { type: "Block", object: "https://kopje.test/ap/users/alice" }],
      ["Like", { type: "Like", object: "https://kopje.test/ap/o/local-1" }],
      ["EmojiReact", { type: "Like", object: "https://kopje.test/ap/o/local-1" }],
      ["Announce", { type: "Announce", object: "https://kopje.test/ap/o/local-1" }],
      ["Delete", { type: "Delete", object: "https://mastodon.example/users/bob/statuses/deleted" }],
      ["Add", { type: "Add", object: { status: "https://mastodon.example/users/bob/statuses/pinned" } }],
      ["Remove", { type: "Remove", object: { status: "https://mastodon.example/users/bob/statuses/pinned" } }],
      ["QuoteRequest", { type: "QuoteRequest", object: "https://kopje.test/ap/o/local-1" }],
    ])("an object as a one-element array: %s", (type, applied) => {
      const entry = form(`${type} object as a one-element array`);
      expect(kopje(entry)).toEqual({ ok: false, reason: "unsupported" });
      expect(accepted(mastodon(entry))).toMatchObject(applied);
    });

    it.each([
      [
        "Add target as a one-element array",
        { type: "Add", target: "https://mastodon.example/users/bob/collections/featured" },
      ],
      [
        "Remove target as a one-element array",
        { type: "Remove", target: "https://mastodon.example/users/bob/collections/featured" },
      ],
      [
        "QuoteRequest instrument as a one-element array",
        { type: "QuoteRequest", instrument: "https://mastodon.example/users/bob/statuses/quoting" },
      ],
    ])("%s", (name, applied) => {
      const entry = form(name);
      expect(kopje(entry)).toEqual({ ok: false, reason: "unsupported" });
      expect(accepted(mastodon(entry))).toMatchObject(applied);
    });

    it("a Move's target as a one-element array: read without a target (refused later as no-target)", () => {
      const entry = form("Move target as a one-element array");
      expect(kopje(entry)).toMatchObject({ ok: true, target: null });
      expect(mastodon(entry)).toMatchObject({ ok: true, target: "https://mastodon.example/users/bob2" });
    });

    it("a Note type as an IRI", () => {
      const entry = form("Note type as an IRI");
      expect(kopje(entry)).toEqual({ ok: false, reason: "unsupported" });
      expect(statusOf(mastodon(entry))).toMatchObject({ uri: expect.stringContaining("/statuses/") });
    });
  });

  describe("reads less than Mastodon", () => {
    it("an Undo or Reject reference as a one-element array, or an embedded type as an IRI", () => {
      const undo = form("Undo object as a one-element array");
      expect(accepted(kopje(undo)).object).toMatchObject({ id: null, type: null });
      expect(accepted(mastodon(undo)).object).toMatchObject({
        id: expect.stringContaining("/follows/"),
        type: "Follow",
      });
      const reject = form("Reject object as a one-element array");
      expect(accepted(kopje(reject)).object).toMatchObject({ id: null });
      expect(accepted(mastodon(reject)).object).toMatchObject({
        id: "https://kopje.test/ap/follows/1",
        type: "Follow",
      });
      for (const name of ["Undo object type as an IRI", "Accept object type as an IRI"]) {
        expect(accepted(kopje(form(name))).object, name).toMatchObject({ type: "as:Follow" });
        expect(accepted(mastodon(form(name))).object, name).toMatchObject({ type: "Follow" });
      }
    });

    it.each([
      ["content as a one-element array", "content", "<p>text</p>"],
      ["summary as a one-element array", "spoilerText", "warning"],
    ])("a text as a one-element array: %s", (name, member, text) => {
      expect(statusOf(kopje(form(name)))[member]).toBe("");
      expect(statusOf(mastodon(form(name)))[member]).toBe(text);
    });

    it("a converted object's name as a one-element array", () => {
      const entry = form("name as a one-element array");
      expect(statusOf(kopje(entry)).content).not.toContain("Title");
      expect(statusOf(mastodon(entry)).content).toContain("Title");
    });

    it("inReplyTo as a one-element array", () => {
      const entry = form("inReplyTo as a one-element array");
      expect(statusOf(kopje(entry)).inReplyTo).toBeNull();
      expect(statusOf(mastodon(entry)).inReplyTo).toBe("https://kopje.test/ap/o/local-1");
    });

    it("sensitive as a one-element array", () => {
      const entry = form("sensitive as a one-element array");
      expect(statusOf(kopje(entry)).sensitive).toBe(false);
      expect(statusOf(mastodon(entry)).sensitive).toBe(true);
    });

    it("a mention's type as an IRI", () => {
      const entry = form("Mention type as an IRI");
      expect(statusOf(kopje(entry)).mentions).toEqual([]);
      expect(statusOf(mastodon(entry)).mentions).toEqual(["https://kopje.test/ap/users/alice"]);
    });
  });

  describe("reads more content than Mastodon", () => {
    it("a poll with one option", () => {
      const entry = form("Question with one option");
      expect(statusOf(kopje(entry)).poll).toMatchObject({ options: ["Only"] });
      // PollParser#valid? wants an array of options; the compaction makes a single one an object.
      const object = mastodonReading(entry).object as Json;
      expect(object.oneOf).toMatchObject({ type: "Note", name: "Only" });
      expect(Array.isArray(object.oneOf)).toBe(false);
    });

    it.each([
      ["sensitive left undefined", (status: Json) => status.sensitive === true, "_:sensitive"],
      ["interactionPolicy left undefined", (status: Json) => status.quotePolicy !== null, "_:interactionPolicy"],
      ["quote untyped", (status: Json) => status.quote !== null, "https://w3id.org/fep/044f#quote"],
      ["quoteUrl defined", (status: Json) => status.quote !== null, "as:quoteUrl"],
    ])("an extension property the context leaves undefined or types otherwise: %s", (name, kept, key) => {
      const entry = form(name);
      expect(kept(statusOf(kopje(entry)))).toBe(true);
      expect(kept(statusOf(mastodon(entry)))).toBe(false);
      // Mastodon's reading keeps the value only under a key it does not read.
      expect(Object.keys(mastodonReading(entry).object as Json)).toContain(key);
    });
  });

  describe("the same effect as Mastodon", () => {
    it("a Flag's object as a one-element array", () => {
      const entry = form("Flag object as a one-element array");
      expect(accepted(kopje(entry))).toMatchObject({ type: "Flag", objects: ["https://kopje.test/ap/users/alice"] });
      expect(kopje(entry)).toEqual(mastodon(entry));
    });

    it("more than 1,000 values, and a proof in the data-integrity context: Mastodon reads them as received", () => {
      expect(form("more than 1,000 values").fallback).toBe("Mastodon::InvalidJsonLdError: has too many nodes");
      expect(form("a proof in the data-integrity context").fallback).toBe(
        "Mastodon::InvalidJsonLdError: contains unsupported JSON-LD features",
      );
      for (const name of ["more than 1,000 values", "a proof in the data-integrity context"]) {
        expect(kopje(form(name)).ok, name).toBe(true);
        expect(kopje(form(name))).toEqual(mastodon(form(name)));
      }
    });
  });
});

// One case per activity type through the inbox (D2): the stored outcome of the body as received, beside the same
// activity written plainly, which is applied.
describe("D1 through the inbox: what the received form stores", () => {
  const LOCAL_STATUS = "https://kopje.test/ap/o/local-1";

  async function world(): Promise<{ t: Setup; bob: TestActor; status: { id: string; uri: string } }> {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await followed(t, bob);
    const status = await localStatus(t, { status: "local", visibility: "public" });
    return { t, bob, status };
  }

  // A body with the world's local status in place of LOCAL_STATUS, its activity ids and, unless `statuses` is false,
  // its own status ids made distinct with `tag`.
  function placed(json: Json, status: { uri: string }, tag: string, statuses = true): Json {
    let text = JSON.stringify(json)
      .replaceAll(LOCAL_STATUS, status.uri)
      .replaceAll("/activities/", `/activities/${tag}`);
    if (statuses) {
      text = text.replaceAll("/users/bob/statuses/", `/users/bob/statuses/${tag}`);
    }
    return JSON.parse(text) as Json;
  }

  // The form's received body.
  const body = (name: string, status: { uri: string }) => placed(form(name).received, status, "");

  // The body Mastodon reads, written as Kopje reads it (its compaction, without the signature): Kopje applies it.
  const plain = (name: string, status: { uri: string }, statuses = true) =>
    placed(mastodonReading(form(name)), status, "plain-", statuses);

  // bob's follows of alice (followed() has bob follow dave).
  const follows = (t: Setup) =>
    sql<{ state: string }>(
      t.store,
      "SELECT f.state FROM follows f JOIN accounts a ON a.id = f.account_id WHERE a.uri = ? AND f.target_account_id = ?",
      "https://mastodon.example/users/bob",
      ALICE,
    );
  const favourites = (t: Setup) => sql(t.store, "SELECT * FROM favourites");
  const mentionNotifications = (t: Setup) =>
    sql(t.store, "SELECT type FROM notifications WHERE account_id = ? AND type = 'mention'", ALICE);

  it("a Follow whose object is a one-element array makes no follow", async () => {
    const { t, bob, status } = await world();
    expect(await t.post(bob, body("Follow object as a one-element array", status))).toBe(202);
    expect(await follows(t)).toEqual([]);
    expect(await t.post(bob, plain("Follow object as a one-element array", status))).toBe(202);
    expect((await follows(t)).length).toBe(1);
  });

  it("a Like typed as:Like favourites nothing", async () => {
    const { t, bob, status } = await world();
    expect(await t.post(bob, body("type as a compact IRI", status))).toBe(202);
    expect(await favourites(t)).toEqual([]);
    expect(await t.post(bob, plain("type as a compact IRI", status))).toBe(202);
    expect((await favourites(t)).length).toBe(1);
  });

  it("a Create whose content is a one-element array is stored with empty content", async () => {
    const { t, bob, status } = await world();
    const received = body("content as a one-element array", status);
    expect(await t.post(bob, received)).toBe(202);
    expect(await statusRow(t.store, (received.object as Json).id as string)).toMatchObject({ content: "" });
    const compacted = plain("content as a one-element array", status);
    expect(await t.post(bob, compacted)).toBe(202);
    expect(await statusRow(t.store, (compacted.object as Json).id as string)).toMatchObject({ content: "<p>text</p>" });
  });

  it("a reply whose inReplyTo is a one-element array is stored without in_reply_to_id", async () => {
    const { t, bob, status } = await world();
    const received = body("inReplyTo as a one-element array", status);
    expect(await t.post(bob, received)).toBe(202);
    expect(await statusRow(t.store, (received.object as Json).id as string)).toMatchObject({ in_reply_to_id: null });
    const compacted = plain("inReplyTo as a one-element array", status);
    expect(await t.post(bob, compacted)).toBe(202);
    expect(await statusRow(t.store, (compacted.object as Json).id as string)).toMatchObject({
      in_reply_to_id: status.id,
    });
  });

  it("a mention typed as:Mention notifies no one", async () => {
    const { t, bob, status } = await world();
    const received = body("Mention type as an IRI", status);
    expect(await t.post(bob, received)).toBe(202);
    expect(await statusRow(t.store, (received.object as Json).id as string)).toBeDefined();
    expect(await mentionNotifications(t)).toEqual([]);
    expect(await t.post(bob, plain("Mention type as an IRI", status))).toBe(202);
    expect(await mentionNotifications(t)).toEqual([{ type: "mention" }]);
  });

  it("a one-option poll is stored with its poll", async () => {
    const { t, bob, status } = await world();
    const received = body("Question with one option", status);
    expect(await t.post(bob, received)).toBe(202);
    const row = await statusRow(t.store, (received.object as Json).id as string);
    expect(await sql(t.store, "SELECT options FROM polls WHERE status_id = ?", row!.id)).toEqual([
      { options: JSON.stringify(["Only"]) },
    ]);
  });

  it("a Delete whose object is a one-element array leaves its status", async () => {
    const { t, bob, status } = await world();
    const deleted = "https://mastodon.example/users/bob/statuses/deleted";
    const note = (form("Mention type as an IRI").received.object as Json) ?? {};
    expect(
      await t.post(bob, {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: `${deleted}/activity`,
        type: "Create",
        actor: bob.uri,
        to: [PUBLIC],
        object: { ...note, id: deleted, atomUri: deleted, tag: [], cc: [] },
      }),
    ).toBe(202);
    expect(await statusRow(t.store, deleted)).toBeDefined();
    expect(await t.post(bob, body("Delete object as a one-element array", status))).toBe(202);
    expect(await statusRow(t.store, deleted)).toBeDefined();
    expect(await t.post(bob, plain("Delete object as a one-element array", status, false))).toBe(202);
    expect(await statusRow(t.store, deleted)).toBeUndefined();
  });
});
