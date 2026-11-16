import { preloadedContexts } from "@fedify/fedify";
import { describe, expect, it } from "vitest";

import { isPublicCollection } from "../src/domain/audience";
import { LIKE_TYPES, parseActivity } from "../src/federation/inbound";
import { ACTIVITY_VOCABULARY, ldSignedBodyReadable, ldSignedReading } from "../src/federation/ld-signed-body";
import { ACTOR_TYPES, CONVERTED_TYPES, STATUS_TYPES } from "../src/federation/remote-status";
import { handleQueue } from "../src/jobs/queue";
import { MAX_JSON_DEPTH, MAX_JSON_NODES, withinJsonBounds } from "../src/platform/json-bounds";
import { sql } from "./api-helpers";
import { harness, inboxDeps, NOW } from "./app-helpers";
import { fixtureKeyGen } from "./federation-helpers";
import corpusFixture from "./fixtures/ld-signed/corpus.json";
import effectsFixture from "./fixtures/ld-signed/effects.json";
import formsFixture from "./fixtures/ld-signed/forms.json";
import { BUILD } from "./helpers";
import { AP, mastodonActor, signedInit, type TestActor } from "./inbox-helpers";
import {
  accountId,
  ALICE,
  create,
  followed,
  localStatus,
  mastodonNote,
  notifications,
  PUBLIC,
  type Setup,
  setup,
  statusRow,
} from "./inbox-status-helpers";
import { quoteAccept, quoteRequest, quoting } from "./quote-helpers";

// Activities that carry a Linked Data signature, read as received where Mastodon 4.7.5 reads them as their compaction
// under its full_context, patched back toward the body as received (docs/mastodon-deviations.md, "Reading inbound
// activities"; ID-1, VIS-1, RES-2). The fixtures (fixtures/ld-signed/, with the scripts that wrote them) hold each body
// as its sender wrote it and Mastodon's own reading of it: the corpus is what Mastodon 4.6.11 and 4.7.5 and Fedify
// 2.4.5 send; the forms are the bodies whose readings could differ, with what Mastodon's readers applied from each
// (effects.json). Mastodon's reading is also parsed by Kopje's reader: what Kopje would apply had it read that form.

type Json = Record<string, unknown>;
type Entry = { name: string; sender?: string; received: Json; reference: string; mastodon?: Json; fallback?: string };
type Effect = { name: string; error?: string; effect: Json & { statuses?: Json[] } };

const corpus = corpusFixture as unknown as Entry[];
const forms = new Map((formsFixture as unknown as Entry[]).map((entry) => [entry.name, entry]));
const effects = new Map((effectsFixture as unknown as Effect[]).map((effect) => [effect.name, effect]));

function form(name: string): Entry {
  const entry = forms.get(name);
  if (entry === undefined) {
    throw new Error(`no form ${name}`);
  }
  return entry;
}

// What Mastodon 4.7.5 applied from a form with its own readers (effects.rb): what bob's activity left, and the error
// its job raised, if any.
function applied(name: string): Effect {
  const effect = effects.get(name);
  if (effect === undefined) {
    throw new Error(`no effect ${name}`);
  }
  return effect;
}

const bytes = (json: unknown) => new TextEncoder().encode(JSON.stringify(json));

function without(json: Json, key: string): Json {
  const { [key]: _, ...rest } = json;
  return rest;
}

// Mastodon's reading of a body (ActivityPub::ProcessActivityService#call): its compaction, the signature put back and
// patched toward the body as received (patch_for_forwarding!: under each key both have, a one-element array is an array
// again and as:Public the public collection's IRI), or, where the JSON-LD limits or the compaction refused it, the body
// as received without its signature.
function mastodonReading(entry: Entry): Json {
  if (entry.fallback !== undefined) {
    return without(entry.received, "signature");
  }
  expect(entry.mastodon).toBeDefined();
  return entry.mastodon!;
}

// A body without its @context and its null members, which Mastodon reads as absent and the compaction leaves out.
function members(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(members);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key, member]) => key !== "@context" && member !== null)
        .map(([key, member]) => [key, members(member)]),
    );
  }
  return value;
}

// Whether Mastodon's reading of the entry is the body as received.
const asReceived = (entry: Entry) =>
  JSON.stringify(members(mastodonReading(entry))) === JSON.stringify(members(entry.received));

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

  it.each(corpus.map((entry) => [`${entry.sender} ${entry.name}`, entry] as const))("%s", (_, entry) => {
    expect(kopje(entry)).toEqual(mastodon(entry));
  });

  // Fedify's two RSA-only bodies name what their contexts define otherwise than full_context, each pinned below.
  const DEFINED_OTHERWISE = new Set(["Create(Question), RSA", "EmojiReact, RSA"]);

  it("Mastodon's reading of every other payload is the body as received", () => {
    // The patch puts back the public collection's IRI and every one-element array the compaction made a single value.
    for (const entry of corpus.filter((e) => e.fallback === undefined && !DEFINED_OTHERWISE.has(e.name))) {
      expect(asReceived(entry), `${entry.sender} ${entry.name}`).toBe(true);
    }
  });

  // A name the body's context defines otherwise than full_context is read where the compaction writes it so
  // (ldSignedReading): Fedify types votersCount xsd:nonNegativeInteger, which full_context leaves untyped, so the
  // compaction keeps a value object (which the patch leaves, and neither reads as a count); and it defines EmojiReact
  // as litepub's, which full_context leaves undefined, so the compaction writes it as its IRI (a type neither reads).
  it("Fedify's votersCount and EmojiReact, defined otherwise than full_context: read as Mastodon reads them", () => {
    const question = corpus.find((e) => e.name === "Create(Question), RSA")!;
    expect((mastodonReading(question).object as Json).votersCount).toEqual({
      type: "xsd:nonNegativeInteger",
      "@value": 0,
    });
    expect(statusOf(kopje(question)).poll).toMatchObject({ votersCount: null });
    const react = corpus.find((e) => e.name === "EmojiReact, RSA")!;
    expect(mastodonReading(react).type).toBe("http://litepub.social/ns#EmojiReact");
    expect(kopje(react)).toEqual({ ok: false, reason: "unsupported" });
  });

  // With a proof in the data-integrity context, Mastodon reads the same bodies as received (its JSON-LD limits refuse
  // the compaction's @graph), and so does Kopje: the count, and the reaction as a favourite (LIKE_TYPES), where
  // Mastodon has no reader for an EmojiReact.
  it("Fedify's votersCount and EmojiReact with a proof: read as received, as Mastodon reads them", () => {
    const question = corpus.find((e) => e.name === "Create(Question), RSA and Ed25519")!;
    expect(question.fallback).toMatch(/^Mastodon::InvalidJsonLdError: contains unsupported/);
    expect(statusOf(kopje(question)).poll).toMatchObject({ votersCount: 0 });
    const react = corpus.find((e) => e.name === "EmojiReact, RSA and Ed25519")!;
    expect(accepted(kopje(react))).toMatchObject({ type: "Like", object: "https://kopje.test/ap/o/remote-1" });
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

// Each form beside what Mastodon 4.7.5 applied from it with its own readers (effects.json). Mastodon reads a form as
// received when the patch puts back what the compaction changed (asReceived): the difference is then each reader's,
// as it is for the same body unsigned.
describe("D1: forms whose readings differ, each named by its class", () => {
  const LIKED = { favourites: ["https://kopje.test/ap/o/local-1"] };
  // Mastodon's job raises on an array where its reader wants a string or an object, and applies nothing.
  const RAISED = { error: expect.stringMatching(/^TypeError/), effect: {} };

  describe("refused where Mastodon applies it", () => {
    it("actor as a one-element array: Mastodon applies it for the request's signer", () => {
      const name = "actor as a one-element array";
      expect(asReceived(form(name))).toBe(true);
      expect(kopje(form(name))).toEqual({ ok: false, reason: "incomplete" });
      expect(applied(name)).toEqual({ name, effect: LIKED });
    });

    it("an object as a one-element array after a member the compaction shortened: the patch stops before it", () => {
      const name = "a null in an array before a one-element array";
      expect(kopje(form(name))).toEqual({ ok: false, reason: "unsupported" });
      expect(mastodonReading(form(name))).toMatchObject({ to: [], object: "https://kopje.test/ap/users/alice" });
      expect(applied(name)).toEqual({ name, effect: { follows: ["alice"] } });
    });

    it("a Note type as an IRI", () => {
      const entry = form("Note type as an IRI");
      expect(kopje(entry)).toEqual({ ok: false, reason: "unsupported" });
      expect(statusOf(mastodon(entry))).toMatchObject({ uri: expect.stringContaining("/statuses/") });
      expect(applied(entry.name).effect.statuses).toMatchObject([{ text: "<p>note 24</p>", visibility: "public" }]);
    });
  });

  describe("reads less than Mastodon", () => {
    it.each([
      "with an array in an array",
      "under an inline context",
      "with a proof of plain names",
      "with a number where an IRI is expected",
      "with a type naming id",
      "with a type naming type",
    ])(
      "an Undo of a block typed as IRIs %s: Mastodon compacts it and lifts the block; Kopje cannot tell it does",
      (variant) => {
        const name = `Undo of a block, both typed as IRIs, ${variant}`;
        expect(form(name).fallback).toBeUndefined();
        expect(kopje(form(name))).toEqual({ ok: false, reason: "unsupported" });
        expect(applied(name)).toEqual({ name, effect: {} });
      },
    );

    it.each([
      ["content as a one-element array", "content", { text: '["<p>text</p>"]' }],
      ["summary as a one-element array", "spoilerText", { spoiler: '["warning"]' }],
    ])("a text as a one-element array: %s, which Mastodon stores as the array's JSON", (name, member, stored) => {
      expect(asReceived(form(name))).toBe(true);
      expect(statusOf(kopje(form(name)))[member]).toBe("");
      expect(applied(name).effect.statuses).toMatchObject([stored]);
    });

    it("a converted object's name as a one-element array", () => {
      const name = "name as a one-element array";
      expect(asReceived(form(name))).toBe(true);
      expect(statusOf(kopje(form(name))).content).not.toContain("Title");
      expect(applied(name).effect.statuses).toMatchObject([{ text: expect.stringContaining('<h2>["Title"]</h2>') }]);
    });

    it("sensitive as a one-element array, which Mastodon takes as true", () => {
      const name = "sensitive as a one-element array";
      expect(asReceived(form(name))).toBe(true);
      expect(statusOf(kopje(form(name))).sensitive).toBe(false);
      expect(applied(name).effect.statuses).toMatchObject([{ sensitive: true, media: 1 }]);
    });

    it("a mention's type as an IRI", () => {
      const entry = form("Mention type as an IRI");
      expect(statusOf(kopje(entry)).mentions).toEqual([]);
      expect(statusOf(mastodon(entry)).mentions).toEqual(["https://kopje.test/ap/users/alice"]);
      expect(applied(entry.name).effect.statuses).toMatchObject([{ mentions: ["alice"] }]);
    });
  });

  describe("reads more content than Mastodon", () => {
    it("inReplyTo as a one-element array: stored without its parent, where Mastodon's job raises", () => {
      const name = "inReplyTo as a one-element array";
      expect(asReceived(form(name))).toBe(true);
      expect(statusOf(kopje(form(name)))).toMatchObject({ content: "<p>note 32</p>", inReplyTo: null });
      expect(applied(name)).toEqual({ name, ...RAISED });
    });

    it("an embedded actor whose inbox is [null] (#1673): not blank as received, blank in Mastodon's reading", () => {
      const name = "Update(Person) whose embedded inbox is [null]";
      expect(accepted(kopje(form(name)))).toMatchObject({ type: "UpdateActor", embedded: { inbox: [null] } });
      expect((mastodonReading(form(name)).object as Json).inbox).toEqual([]);
      expect(applied(name)).toEqual({ name, effect: {} });
    });
  });

  describe("the same effect as Mastodon", () => {
    // The compaction writes a type given as an IRI as the vocabulary's name, and the patch leaves it so: Kopje reads
    // the activity's type and its embedded object's so (ldSignedReading), and a retraction ends what Mastodon's
    // ends.
    it.each([
      ["type as a compact IRI", LIKED],
      ["type as an absolute IRI", LIKED],
      ["Reject typed as:Reject, of an accepted follow", { local_follows_removed: 1 }],
      ["Undo typed as:Undo", { removed_follows: 1 }],
      ["Block typed as:Block, by an accepted follow's target", { local_follows_removed: 1, blocks: ["alice"] }],
      ["Delete typed as:Delete", { removed_statuses: ["https://mastodon.example/users/bob/statuses/deleted"] }],
    ])("an activity %s: read as the compaction names its type", (name, effect) => {
      const reading = accepted(kopje(form(name)));
      expect(reading.type).not.toContain(":");
      expect(reading).toEqual(accepted(mastodon(form(name))));
      expect(applied(name)).toEqual({ name, effect });
    });

    it.each([
      ["Undo object type as an IRI", { removed_follows: 1 }],
      ["Undo object type as the absolute IRI", { removed_follows: 1 }],
      ["Accept object type as an IRI", { local_requests_removed: 1, local_follows: ["alice"] }],
      ["Accept object type as the absolute IRI", { local_requests_removed: 1, local_follows: ["alice"] }],
      ["Reject of an accepted follow, its object's type as:Follow", { local_follows_removed: 1 }],
      ["Reject of an accepted follow, its object's type the absolute IRI", { local_follows_removed: 1 }],
    ])("an embedded object's type as an IRI, %s: read as Follow", (name, effect) => {
      const reading = accepted(kopje(form(name)));
      expect(reading.object).toMatchObject({ type: "Follow" });
      expect(reading).toEqual(accepted(mastodon(form(name))));
      expect(applied(name)).toEqual({ name, effect });
    });

    // Mastodon's Accept and Reject seek alice's follow by the object's id before reading it as anything else.
    it.each([
      ["Reject of an accepted follow, its object typed as the QuoteRequest IRI", { local_follows_removed: 1 }],
      ["Reject of an accepted follow, its object typed QuoteRequest", { local_follows_removed: 1 }],
      ["Reject of an accepted follow, its object typed QuoteRequest, unsigned", { local_follows_removed: 1 }],
      [
        "Accept of a follow request, its object typed QuoteRequest",
        { local_requests_removed: 1, local_follows: ["alice"] },
      ],
      [
        "Accept of a follow request, its object typed QuoteRequest, unsigned",
        { local_requests_removed: 1, local_follows: ["alice"] },
      ],
    ])("an answer naming our follow's id under a QuoteRequest's type, %s", (name, effect) => {
      expect(accepted(kopje(form(name))).object).toMatchObject({
        id: "https://kopje.test/ap/follows/1",
        type: "QuoteRequest",
      });
      expect(applied(name)).toEqual({ name, effect });
    });

    // A name full_context defines that the body's context leaves undefined, as a type or as a member, is a blank
    // node's name in Mastodon's reading (`_:QuoteRequest`), which neither reader reads (ldSignedReading); each beside
    // the same body with the name defined, which both read.
    it.each([
      "QuoteRequest, its type",
      "Accept of our quote request, its object's type",
      "Note, its extension members and tag types",
      "Question, its votersCount",
      "Delete by an atomUri",
      "Add of a Hashtag, its type",
      "Update(Person), its extension members and types",
    ])("%s left undefined, and defined: read as Mastodon reads it", (base) => {
      for (const name of [`${base} left undefined`, `${base} defined`]) {
        expect(form(name).fallback, name).toBeUndefined();
        expect(kopje(form(name)), name).toEqual(mastodon(form(name)));
      }
    });

    it.each(["sensitive left undefined", "interactionPolicy left undefined"])(
      "%s: read as Mastodon reads it",
      (name) => {
        expect(kopje(form(name))).toEqual(mastodon(form(name)));
        expect(statusOf(kopje(form(name)))).toMatchObject({ sensitive: false, quotePolicy: null });
        expect(applied(name).effect.statuses).toMatchObject([{ sensitive: false }]);
      },
    );

    // The context defines the name, but otherwise than full_context does: untyped where full_context types it @id, or
    // a name full_context leaves to ActivityStreams' @vocab given an IRI of its own. Mastodon's reading keeps the value
    // only under a key it does not read, which the patch leaves; Kopje reads no quote either (ldSignedReading).
    it.each([
      ["quote untyped", "https://w3id.org/fep/044f#quote"],
      ["quoteUrl defined", "as:quoteUrl"],
    ])(
      "an extension property the context defines otherwise than full_context, %s: read as Mastodon reads it",
      (name, key) => {
        const entry = form(name);
        expect(Object.keys(mastodonReading(entry).object as Json)).toContain(key);
        expect(statusOf(kopje(entry)).quote).toBeNull();
        expect(kopje(entry)).toEqual(mastodon(entry));
      },
    );

    // A value of a shape the name's type does not take, the compaction writes under the name's IRI, which neither reads
    // (ldSignedReading): a boolean where a quote is an IRI, so the quote is a legacy one (Mastodon's
    // StatusParser#legacy_quote? asks for a quote key); true in an approval list, so no policy; an object where a
    // poll's closing is a time, so the poll stays open (Mastodon's PollParser closes it for any object).
    it.each([
      ["Note, its quote given as true", (r: Reading) => (statusOf(r).quote as Json).legacy, true],
      [
        "Note, its automaticApproval given as an array of true",
        (r: Reading) => statusOf(r).quotePolicy,
        { automatic: [], manual: [] },
      ],
      ["Question, its closed given as an object", (r: Reading) => (statusOf(r).poll as Json).closedNow, false],
    ] as [string, (r: Reading) => unknown, unknown][])("%s: read as Mastodon reads it", (name, member, value) => {
      expect(form(name).fallback).toBeUndefined();
      expect(member(kopje(form(name)))).toEqual(value);
      expect(kopje(form(name))).toEqual(mastodon(form(name)));
    });

    // sensitive typed otherwise than full_context, which leaves it untyped, is written under the name all the same: an
    // IRI as a node, a value of a datatype as a typed value, either an object Mastodon takes as true; false as false.
    // Kopje reads it as Mastodon marks the status (ldSignedReading).
    it.each([
      ["typed @id, given an IRI", true],
      ["typed @id, given false", false],
      ["typed as a boolean, given false", true],
    ])("sensitive %s: marked %s, as Mastodon marks it", (variant, marked) => {
      const name = `Note, its sensitive ${variant}`;
      expect(form(name).fallback).toBeUndefined();
      expect(statusOf(kopje(form(name))).sensitive).toBe(marked);
      expect(applied(name).effect.statuses).toMatchObject([{ sensitive: marked, media: 1 }]);
    });

    // A proof in the data-integrity context, a @graph container: Mastodon reads the body as received only where
    // JSON-LD's expansion leaves something of the proof (its compaction's @graph key the limits refuse); of one that
    // expands to nothing it reads the compaction, the QuoteRequest left undefined a blank node's type, and so does
    // Kopje (ldSignedReading).
    it.each([
      ["a null value", false],
      ["a language alone", false],
      ["an empty set", false],
      ["an array of a null value", false],
      ["plain names", true],
    ])("a QuoteRequest left undefined with a proof of %s: read as received %s, as by Mastodon", (variant, received) => {
      const name = `QuoteRequest, its type left undefined, with a proof of ${variant}`;
      expect(form(name).fallback !== undefined).toBe(received);
      expect(kopje(form(name))).toEqual(mastodon(form(name)));
      expect(kopje(form(name)).ok).toBe(received);
    });

    // A body Kopje can show Mastodon reads as received, by the refusals captured above (too many values as received, a
    // @graph key, a proof the data-integrity context makes a @graph), it reads as received too: the names its context
    // leaves undefined as written (ldSignedReading).
    it.each([
      [
        "past the value limit as received",
        (body: Json) => ({ ...body, padding: Array.from({ length: 1_000 }, () => "x") }),
      ],
      [
        "with @graph in its signature",
        (body: Json) => ({ ...body, signature: { ...(body.signature as Json), "@graph": [] } }),
      ],
      [
        "with a proof in the data-integrity context",
        (body: Json) => ({
          ...body,
          "@context": [...(body["@context"] as unknown[]), "https://w3id.org/security/data-integrity/v1"],
          proof: { type: "DataIntegrityProof", cryptosuite: "eddsa-jcs-2022", proofValue: "z3placeholder" },
        }),
      ],
    ])("a Note with names its context leaves undefined, %s: read as received", (_, change) => {
      const received = form("Note, its extension members and tag types left undefined").received;
      expect(statusOf(read(received)).sensitive).toBe(false);
      const changed = change(received);
      expect(statusOf(read(changed))).toMatchObject({ sensitive: true, tags: ["kopje"] });
      expect(statusOf(read(changed))).toEqual(statusOf(read(without(changed, "signature"))));
    });

    // What Kopje reads from each, beside what Mastodon applied from it: the same, left undefined or defined.
    const status = (reading: Reading) => {
      const object = statusOf(reading);
      const media = object.media as Json[];
      return {
        sensitive: object.sensitive,
        tags: object.tags,
        emojis: (object.emojiTags as Json[]).map((tag) => tag.shortcode),
        conversation: object.conversation,
        quote: (object.quote as Json | null)?.uri ?? null,
        quotePolicy: object.quotePolicy !== null,
        media: media.flatMap(({ blurhash, focus }) =>
          blurhash === null && focus === null ? [] : [{ blurhash, focus }],
        ),
      };
    };
    const created = (effect: Json & { statuses?: Json[] }) => {
      const object = effect.statuses![0]!;
      return {
        sensitive: object.sensitive,
        tags: object.tags ?? [],
        emojis: effect.emojis ?? [],
        conversation: object.conversation ?? null,
        quote: (object.quote as Json | undefined)?.uri ?? null,
        quotePolicy: object.quote_policy !== undefined,
        media: object.media_meta ?? [],
      };
    };
    it.each([
      ["QuoteRequest, its type", (r: Reading) => r.ok, (e: Json) => e.quote_changes !== undefined],
      ["Note, its extension members and tag types", status, created],
      [
        "Question, its votersCount",
        (r: Reading) => (statusOf(r).poll as Json).votersCount,
        (e: Effect["effect"]) => e.statuses![0]!.voters ?? null,
      ],
      [
        "Delete by an atomUri",
        (r: Reading) => accepted(r).atomUri,
        (e: Json) => (e.removed_statuses as string[] | undefined)?.[0] ?? null,
      ],
      [
        "Add of a Hashtag, its type",
        (r: Reading) => (r.ok ? ((r.activity.object as Json).hashtag as string).slice(1) : null),
        (e: Json) => (e.featured_tags as string[] | undefined)?.[0] ?? null,
      ],
    ] as [string, (r: Reading) => unknown, (e: Effect["effect"]) => unknown][])(
      "%s: Kopje reads what Mastodon applies, left undefined or defined",
      (base, kopjeRead, mastodonApplied) => {
        const [undefinedName, definedName] = [`${base} left undefined`, `${base} defined`];
        expect(kopjeRead(kopje(form(undefinedName)))).toEqual(mastodonApplied(applied(undefinedName).effect));
        expect(kopjeRead(kopje(form(definedName)))).toEqual(mastodonApplied(applied(definedName).effect));
        expect(kopjeRead(kopje(form(undefinedName)))).not.toEqual(kopjeRead(kopje(form(definedName))));
      },
    );

    // Tags that are also the keyword aliases `id` and `type` are tags in a language map, for both.
    it.each([
      "Undo of a block, both typed as IRIs",
      "Undo of a block, both typed as IRIs, with a language map tagged id and type",
    ])("%s, in a body Mastodon compacts: both lift the block", (name) => {
      expect(form(name).fallback).toBeUndefined();
      expect(accepted(kopje(form(name)))).toMatchObject({ type: "Undo", object: { type: "Block" } });
      expect(applied(name)).toEqual({ name, effect: {} });
    });

    it.each([
      ["past the value limit as received", /^Mastodon::InvalidJsonLdError: has too many nodes/],
      ["past the value limit once compacted", /^Mastodon::InvalidJsonLdError: has too many nodes/],
      ["with a proof in the data-integrity context", /^Mastodon::InvalidJsonLdError: contains unsupported/],
      ["with @graph in its signature", /^Mastodon::InvalidJsonLdError: contains unsupported/],
      ["with a type that is not a string", /^JSON::LD::JsonLdError::InvalidTypeValue/],
      ["with a language map member that is not a string", /^JSON::LD::JsonLdError::InvalidLanguageMapValue/],
      ["with an IRI over a prefix only full_context defines", /^JSON::LD::JsonLdError::IRIConfusedWithPrefix/],
      ["with a null id", /^JSON::LD::JsonLdError::InvalidIdValue/],
      ["with a null type", /^JSON::LD::JsonLdError::InvalidTypeValue/],
      ["with a null in a type array", /^JSON::LD::JsonLdError::InvalidTypeValue/],
      ["with a type over the toot prefix", /^JSON::LD::JsonLdError::IRIConfusedWithPrefix/],
      ["with a type over the schema prefix", /^JSON::LD::JsonLdError::IRIConfusedWithPrefix/],
      ["with a proof typed by a number", /^JSON::LD::JsonLdError::InvalidTypeValue/],
      ["with a proof of a number tagged with a language", /^JSON::LD::JsonLdError::InvalidLanguageTaggedValue/],
      ["with a proof whose id is null", /^JSON::LD::JsonLdError::InvalidIdValue/],
      [
        "under the ActivityStreams context repeated past the value limit",
        /^Mastodon::InvalidJsonLdError: has too many/,
      ],
      [
        "with numbers as list members past the value limit once compacted",
        /^Mastodon::InvalidJsonLdError: has too many/,
      ],
      ["with IRIs as lists past the value limit once compacted", /^Mastodon::InvalidJsonLdError: has too many/],
      ["with a null type in a language map array", /^JSON::LD::JsonLdError::InvalidTypeValue/],
      ["with a null id in a language map array", /^JSON::LD::JsonLdError::InvalidIdValue/],
    ])("an Undo of a block typed as IRIs %s: Mastodon reads it as received, so neither lifts it", (variant, cause) => {
      const name = `Undo of a block, both typed as IRIs, ${variant}`;
      expect(form(name).fallback).toMatch(cause);
      expect(kopje(form(name))).toEqual({ ok: false, reason: "unsupported" });
      expect(applied(name)).toEqual({ name, effect: { blocks: ["alice"] } });
    });

    it("an unsigned body's types are read as given, as Mastodon reads it uncompacted", () => {
      expect(read(without(form("type as a compact IRI").received, "signature"))).toEqual({
        ok: false,
        reason: "unsupported",
      });
      const undo = accepted(read(without(form("Undo object type as an IRI").received, "signature")));
      expect(undo.object).toMatchObject({ type: "as:Follow" });
    });

    // Mastodon renames a type given as an IRI only in a body it compacts; where it gives the compaction up it reads the
    // body as received. Kopje renames one only where it can tell Mastodon compacts the body: never in a body Mastodon
    // read as received, and in each it can tell of, as the compaction names it.
    it("renames a type given as an IRI only in a body Mastodon compacts, as the compaction names it", () => {
      const renamed: string[] = [];
      const kept = new Set<string>();
      let names = 0;
      for (const entry of [...corpus, ...forms.values()]) {
        const ours = typeof entry.received.signature === "object" ? ldSignedReading(entry.received) : null;
        if (ours === null) {
          continue;
        }
        // The body as Kopje reads it: a name its context leaves undefined named as the compaction names it.
        const { readType, body: named } = ours;
        const label = entry.name ?? entry.reference;
        const compacts = readType("as:Like") === "Like";
        if (compacts) {
          expect(entry.fallback, label).toBeUndefined();
        }
        const reading = mastodonReading(entry);
        const object = (body: Json) => (typeof body.object === "object" && body.object !== null ? body.object : {});
        for (const [given, name, read] of [
          [entry.received.type, named.type, reading.type],
          [(object(entry.received) as Json).type, (object(named) as Json).type, (object(reading) as Json).type],
        ]) {
          if (typeof given !== "string" || typeof read !== "string") {
            continue;
          }
          if (!given.includes(":")) {
            // A name keeps its meaning (D4), or is a blank node's where the context leaves it undefined, but one
            // outside the vocabulary (EmojiReact, read as a favourite).
            if (ACTIVITY_VOCABULARY.has(given)) {
              expect(readType(name as string), label).toBe(read);
              names++;
            }
          } else if (compacts) {
            expect(readType(given), label).toBe(read);
            renamed.push(given);
          } else {
            expect(readType(given), label).toBe(given);
            if (entry.fallback === undefined) {
              kept.add(label);
            }
          }
        }
      }
      expect(names).toBeGreaterThanOrEqual(150);
      expect(renamed.length).toBe(17);
      // Bodies Mastodon compacts outside the shape Kopje shows it compacts (an inline context, an array in an array,
      // a proof, a number where an IRI is expected, a type naming a keyword alias): their types are read as given, so
      // such an activity applies less than Mastodon's.
      expect([...kept]).toEqual([
        "Note type as an IRI",
        "Undo of a block, both typed as IRIs, with an array in an array",
        "Undo of a block, both typed as IRIs, under an inline context",
        "Undo of a block, both typed as IRIs, with a proof of plain names",
        "Undo of a block, both typed as IRIs, with a number where an IRI is expected",
        "Undo of a block, both typed as IRIs, with a type naming id",
        "Undo of a block, both typed as IRIs, with a type naming type",
      ]);
    });

    // The shape's bounds on the same body, where no capture varies them: an object with no id or type is a node like
    // any other, and a null among IRIs is dropped (as in the captured `to: [null]` forms); an id over a prefix only
    // full_context defines (as the captured `cc` and type ones), a blank node, an http(s) IRI whose scheme is upper-case
    // or not followed by `//`, a boolean where an IRI is expected, and a language map value other than a map of tags to
    // strings are outside it.
    it.each([
      { added: { instrument: { name: "client" } }, read: "Undo" },
      { added: { cc: [null] }, read: "Undo" },
      { added: { instrument: { id: "toot:client" } }, read: "as:Undo" },
      { added: { instrument: { id: "_:client" } }, read: "as:Undo" },
      { added: { instrument: { id: "HTTPS://mastodon.example/client" } }, read: "as:Undo" },
      { added: { instrument: { id: "https:mastodon.example/client" } }, read: "as:Undo" },
      { added: { cc: true }, read: "as:Undo" },
      { added: { summaryMap: 5 }, read: "as:Undo" },
      { added: { summaryMap: { en: ["blocked"] } }, read: "as:Undo" },
      { added: { summaryMap: { "not a tag": "blocked" } }, read: "as:Undo" },
    ])("reads the compacted Undo of a block, given $added, as $read", ({ added, read }) => {
      const body = { ...form("Undo of a block, both typed as IRIs").received, ...added };
      expect(ldSignedReading(body)?.readType("as:Undo")).toBe(read);
    });

    it("type as a one-element array: neither applies it", () => {
      const name = "type as a one-element array";
      expect(asReceived(form(name))).toBe(true);
      expect(kopje(form(name))).toEqual({ ok: false, reason: "incomplete" });
      expect(applied(name)).toEqual({ name, effect: {} });
    });

    it.each([
      "Follow object as a one-element array",
      "Block object as a one-element array",
      "Like object as a one-element array",
      "Announce object as a one-element array",
      "Delete object as a one-element array",
      "Add object as a one-element array",
      "QuoteRequest object as a one-element array",
      "Add target as a one-element array",
      "QuoteRequest instrument as a one-element array",
    ])("refused, where Mastodon's job raises: %s", (name) => {
      expect(asReceived(form(name))).toBe(true);
      expect(kopje(form(name))).toEqual({ ok: false, reason: "unsupported" });
      expect(applied(name)).toEqual({ name, ...RAISED });
    });

    it.each(["Remove object as a one-element array", "Remove target as a one-element array"])(
      "refused, where Mastodon's job raises and the pin stays: %s",
      (name) => {
        expect(asReceived(form(name))).toBe(true);
        expect(kopje(form(name))).toEqual({ ok: false, reason: "unsupported" });
        expect(applied(name)).toEqual({
          name,
          error: expect.stringMatching(/^TypeError/),
          effect: { pins: ["https://mastodon.example/users/bob/statuses/pinned"] },
        });
      },
    );

    it("an EmojiReact whose object is a one-element array: refused, where Mastodon reads no EmojiReact", () => {
      const name = "EmojiReact object as a one-element array";
      expect(kopje(form(name))).toEqual({ ok: false, reason: "unsupported" });
      expect(applied(name)).toEqual({ name, effect: {} });
    });

    it("an Undo or Reject reference as a one-element array: nothing undone or rejected", () => {
      for (const name of ["Undo object as a one-element array", "Reject object as a one-element array"]) {
        expect(asReceived(form(name)), name).toBe(true);
        expect(accepted(kopje(form(name))).object, name).toMatchObject({ id: null, type: null });
        expect(applied(name), name).toEqual({ name, ...RAISED });
      }
    });

    it("a Move's target as a one-element array: read without a target (refused later as no-target)", () => {
      const name = "Move target as a one-element array";
      expect(kopje(form(name))).toMatchObject({ ok: true, target: null });
      expect(applied(name)).toEqual({ name, ...RAISED });
    });

    it("a poll with one option: both store it", () => {
      const name = "Question with one option";
      expect(asReceived(form(name))).toBe(true);
      expect(statusOf(kopje(form(name))).poll).toMatchObject({ options: ["Only"] });
      expect(applied(name).effect.statuses).toMatchObject([{ poll: ["Only"] }]);
    });

    it("a Flag's object as a one-element array", () => {
      const entry = form("Flag object as a one-element array");
      expect(accepted(kopje(entry))).toMatchObject({ type: "Flag", objects: ["https://kopje.test/ap/users/alice"] });
      expect(kopje(entry)).toEqual(mastodon(entry));
      expect(applied(entry.name).effect).toEqual({ reports: [{ target: "alice", statuses: 0 }] });
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

// One case per activity type through the inbox (D2): the stored outcome of the body as received, beside what Mastodon
// applied from it, and, where Mastodon's reading is not the body as received, that reading written plainly, which
// Kopje applies.
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

  // The body Mastodon reads, written as Kopje reads it (without the signature): Kopje applies it.
  const plain = (name: string, status: { uri: string }) =>
    placed(without(mastodonReading(form(name)), "signature"), status, "plain-");

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

  it("a Follow whose object is a one-element array makes no follow, as in Mastodon", async () => {
    const { t, bob, status } = await world();
    expect(await t.post(bob, body("Follow object as a one-element array", status))).toBe(202);
    expect(await follows(t)).toEqual([]);
    expect(applied("Follow object as a one-element array").effect).toEqual({});
  });

  it("a Like typed as:Like favourites, as Mastodon's reading does", async () => {
    const { t, bob, status } = await world();
    expect(await t.post(bob, body("type as a compact IRI", status))).toBe(202);
    expect((await favourites(t)).length).toBe(1);
    expect(applied("type as a compact IRI").effect).toEqual({ favourites: [LOCAL_STATUS] });
  });

  // alice's accepted follow of bob, under the id the forms name, and bob's followers-only status, which mentions no
  // one: alice reads it while she follows him.
  async function followersOnly(t: Setup, bob: TestActor): Promise<string> {
    await sql(
      t.store,
      "UPDATE follows SET uri = ? WHERE account_id = ? AND target_account_id = (SELECT id FROM accounts WHERE uri = ?)",
      "https://kopje.test/ap/follows/1",
      ALICE,
      bob.uri,
    );
    const note = mastodonNote(bob, { to: [`${bob.uri}/followers`], cc: [] });
    expect(await t.post(bob, create(bob, note))).toBe(202);
    const row = (await statusRow(t.store, note.id))!;
    expect((await t.api(`/api/v1/statuses/${row.id}`, "alice")).status).toBe(200);
    return row.id;
  }
  const aliceFollows = (t: Setup, bob: TestActor) =>
    sql(
      t.store,
      `SELECT f.state FROM follows f JOIN accounts a ON a.id = f.target_account_id
        WHERE f.account_id = ? AND a.uri = ?`,
      ALICE,
      bob.uri,
    );

  it.each([
    "Reject of an accepted follow, its object's type as:Follow",
    "Reject of an accepted follow, its object's type the absolute IRI",
    "Reject typed as:Reject, of an accepted follow",
    "Block typed as:Block, by an accepted follow's target",
    // Our follow by its id, whatever its type (D6), unsigned or under a QuoteRequest's type.
    "Reject of an accepted follow, its object's type as:Follow, unsigned",
    "Reject of an accepted follow, its object typed as the QuoteRequest IRI",
    "Reject of an accepted follow, its object typed QuoteRequest",
    "Reject of an accepted follow, its object typed QuoteRequest, unsigned",
  ])("%s ends alice's follow and her reading of his followers-only status, as in Mastodon", async (name) => {
    const { t, bob, status } = await world();
    const id = await followersOnly(t, bob);
    expect(await t.post(bob, body(name, status))).toBe(202);
    expect(await aliceFollows(t, bob)).toEqual([]);
    expect((await t.api(`/api/v1/statuses/${id}`, "alice")).status).toBe(404);
    expect(applied(name).effect).toMatchObject({ local_follows_removed: 1 });
  });

  it.each([
    "Accept object type as an IRI, unsigned",
    "Accept of a follow request, its object typed QuoteRequest",
    "Accept of a follow request, its object typed QuoteRequest, unsigned",
  ])("%s accepts alice's request by its id, as in Mastodon", async (name) => {
    const { t, bob, status } = await world();
    await sql(
      t.store,
      `UPDATE follows SET uri = ?, state = 'pending'
        WHERE account_id = ? AND target_account_id = (SELECT id FROM accounts WHERE uri = ?)`,
      "https://kopje.test/ap/follows/1",
      ALICE,
      bob.uri,
    );
    expect(await t.post(bob, body(name, status))).toBe(202);
    expect(await aliceFollows(t, bob)).toEqual([{ state: "accepted" }]);
    expect(applied(name).effect).toEqual({ local_requests_removed: 1, local_follows: ["alice"] });
  });

  // bob's block of alice (blocks/1, as the forms name it), which hides his public status from her.
  async function blockedStatus(t: Setup, bob: TestActor): Promise<string> {
    const note = mastodonNote(bob);
    expect(await t.post(bob, create(bob, note))).toBe(202);
    const id = (await statusRow(t.store, note.id))!.id;
    const block = { "@context": "https://www.w3.org/ns/activitystreams", type: "Block", actor: bob.uri };
    const blocks = `${bob.uri}/blocks/1`;
    expect(await t.post(bob, { ...block, id: blocks, object: "https://kopje.test/ap/users/alice" })).toBe(202);
    expect((await t.api(`/api/v1/statuses/${id}`, "alice")).status).toBe(404);
    return id;
  }

  it.each([
    "Undo of a block, both typed as IRIs",
    "Undo of a block, both typed as IRIs, with a language map tagged id and type",
  ])("%s, in a body Mastodon compacts, lifts it, as in Mastodon", async (name) => {
    const { t, bob, status } = await world();
    const id = await blockedStatus(t, bob);
    expect(await t.post(bob, body(name, status))).toBe(202);
    expect((await t.api(`/api/v1/statuses/${id}`, "alice")).status).toBe(200);
  });

  it.each([
    "past the value limit as received",
    "past the value limit once compacted",
    "with a proof in the data-integrity context",
    "with @graph in its signature",
    "with a type that is not a string",
    "with a language map member that is not a string",
    "with an IRI over a prefix only full_context defines",
    "with a null id",
    "with a null type",
    "with a null in a type array",
    "with a type over the toot prefix",
    "with a type over the schema prefix",
    "with a proof typed by a number",
    "with a proof of a number tagged with a language",
    "with a proof whose id is null",
    "under the ActivityStreams context repeated past the value limit",
    "with numbers as list members past the value limit once compacted",
    "with IRIs as lists past the value limit once compacted",
    "with an array in an array",
    "under an inline context",
    "with a null type in a language map array",
    "with a null id in a language map array",
    "with a proof of plain names",
    "with a number where an IRI is expected",
    "with a type naming id",
    "with a type naming type",
  ])("an Undo of a block typed as IRIs %s leaves the block", async (variant) => {
    const { t, bob, status } = await world();
    const id = await blockedStatus(t, bob);
    expect(await t.post(bob, body(`Undo of a block, both typed as IRIs, ${variant}`, status))).toBe(202);
    expect((await t.api(`/api/v1/statuses/${id}`, "alice")).status).toBe(404);
  });

  // The spool's replay reads each body through the same envelope as the inbox.
  it("on replay too, an Undo of a block typed as IRIs lifts it only where Mastodon compacts the body", async () => {
    const { t, bob, status } = await world();
    const id = await blockedStatus(t, bob);
    const maintenance = harness(t.store, { MAINTENANCE: "readonly" }, BUILD, {
      keygen: fixtureKeyGen,
      loader: t.web.loader,
    });
    const deps = { ...inboxDeps(() => t.store, t.web.loader), now: () => NOW };
    const replay = async (name: string) => {
      const init = await signedInit(bob, "/inbox", body(name, status), { at: NOW });
      expect((await maintenance.request("/inbox", init)).status).toBe(202);
      await maintenance.queue.deliver((batch) =>
        handleQueue(batch, { ...maintenance.env, MAINTENANCE: "off" } as Env, deps),
      );
    };
    await replay("Undo of a block, both typed as IRIs, with a proof typed by a number");
    expect((await t.api(`/api/v1/statuses/${id}`, "alice")).status).toBe(404);
    await replay("Undo of a block, both typed as IRIs, with a null type in a language map array");
    expect((await t.api(`/api/v1/statuses/${id}`, "alice")).status).toBe(404);
    await replay("Undo of a block, both typed as IRIs");
    expect((await t.api(`/api/v1/statuses/${id}`, "alice")).status).toBe(200);
  });

  it.each(["Undo object type as the absolute IRI", "Undo typed as:Undo"])(
    "%s ends bob's follow of alice, as in Mastodon",
    async (name) => {
      const { t, bob, status } = await world();
      const follow = { "@context": "https://www.w3.org/ns/activitystreams", type: "Follow", actor: bob.uri };
      const id = "https://mastodon.example/users/bob/follows/14";
      expect(await t.post(bob, { ...follow, id, object: "https://kopje.test/ap/users/alice" })).toBe(202);
      expect(await follows(t)).toEqual([{ state: "accepted" }]);
      expect(await t.post(bob, body(name, status))).toBe(202);
      expect(await follows(t)).toEqual([]);
      expect(applied(name).effect).toEqual({ removed_follows: 1 });
    },
  );

  it("a Delete typed as:Delete removes its status, as in Mastodon", async () => {
    const { t, bob, status } = await world();
    const deleted = "https://mastodon.example/users/bob/statuses/deleted";
    const note = mastodonNote(bob, { id: deleted, atomUri: deleted });
    expect(await t.post(bob, create(bob, note))).toBe(202);
    expect(await statusRow(t.store, deleted)).toBeDefined();
    expect(await t.post(bob, body("Delete typed as:Delete", status))).toBe(202);
    expect(await statusRow(t.store, deleted)).toBeUndefined();
    expect(applied("Delete typed as:Delete").effect).toEqual({ removed_statuses: [deleted] });
  });

  // A name full_context defines that the body's context leaves undefined, as a type or as a member, is read as
  // Mastodon's compaction names it, a blank node's: what Mastodon's readers do not read applies nothing here either,
  // and the same body with the name defined applies it in both (ldSignedReading).
  it.each([
    ["QuoteRequest, its type left undefined", "pending"],
    ["QuoteRequest, its type defined", "accepted"],
    // Under the data-integrity context, with a proof that expands to nothing: read as the compaction names it.
    ["QuoteRequest, its type left undefined, with a proof of a null value", "pending"],
    ["QuoteRequest, its type left undefined, with a proof of a language alone", "pending"],
    ["QuoteRequest, its type left undefined, with a proof of an empty set", "pending"],
    ["QuoteRequest, its type left undefined, with a proof of an array of a null value", "pending"],
    // With one that leaves a node: read as received, as Mastodon's limits refuse the compaction's @graph.
    ["QuoteRequest, its type left undefined, with a proof of plain names", "accepted"],
  ])("a %s leaves bob's quote of alice's status %s, as in Mastodon", async (name, state) => {
    const { t, bob, status } = await world();
    const uri = "https://mastodon.example/users/bob/statuses/quoting";
    expect(await t.post(bob, create(bob, quoting(bob, status.uri, null, { id: uri, atomUri: uri })))).toBe(202);
    const id = (await statusRow(t.store, uri))!.id;
    const quote = async () =>
      (await sql<{ state: string }>(t.store, "SELECT state FROM quotes WHERE status_id = ?", id))[0]?.state;
    expect(await quote()).toBe("pending");
    expect(await t.post(bob, body(name, status))).toBe(202);
    expect(await quote()).toBe(state);
    expect(applied(name).effect).toEqual(state === "pending" ? {} : { quote_changes: [{ status: uri, state }] });
  });

  // Mastodon's Accept seeks our quote by the object's id whatever its type (Accept#quote_request_from_object).
  it.each(["left undefined", "defined"])(
    "an Accept of our quote request, its object's type %s, accepts it, as in Mastodon",
    async (variant) => {
      const { t, bob } = await world();
      const note = mastodonNote(bob, { interactionPolicy: { canQuote: { automaticApproval: [PUBLIC] } } });
      expect(await t.post(bob, create(bob, note))).toBe(202);
      const mine = await localStatus(t, { status: "quote", quoted_status_id: (await statusRow(t.store, note.id))!.id });
      const state = async () =>
        (await sql<{ state: string }>(t.store, "SELECT state FROM quotes WHERE status_id = ?", mine.id))[0]?.state;
      expect(await state()).toBe("pending");
      const name = `Accept of our quote request, its object's type ${variant}`;
      const local = "https://kopje.test/ap/o/local-2";
      expect(await t.post(bob, JSON.parse(JSON.stringify(form(name).received).replaceAll(local, mine.uri)))).toBe(202);
      expect(await state()).toBe("accepted");
      expect(applied(name).effect).toEqual({ quote_changes: [{ status: local, state: "accepted" }] });
    },
  );

  // A quote under a context that types it otherwise than full_context is no quote in Mastodon's reading, so no
  // QuoteRequest can approve it there (Mastodon's raises on the instrument's missing quote); unsigned, both read it.
  it.each([
    ["signed", "no quote", undefined],
    ["unsigned", "an accepted quote", "accepted"],
  ])("a Note quoting alice's status under an untyped quote, %s, then a QuoteRequest: %s", async (variant, _, state) => {
    const { t, bob, status } = await world();
    const received = JSON.parse(
      JSON.stringify(form("quote untyped").received).replaceAll("https://other.example/statuses/1", status.uri),
    ) as Json;
    const create = variant === "signed" ? received : without(received, "signature");
    expect(await t.post(bob, create)).toBe(202);
    const note = (create.object as Json).id as string;
    expect(await t.post(bob, quoteRequest(bob, status.uri, note))).toBe(202);
    const id = (await statusRow(t.store, note))!.id;
    const quote = await sql<{ state: string }>(t.store, "SELECT state FROM quotes WHERE status_id = ?", id);
    expect(quote[0]?.state).toBe(state);
    expect(Object.keys(mastodonReading(form("quote untyped")).object as Json)).not.toContain("quote");
  });

  it.each([
    ["left undefined", { sensitive: false, tags: [], quote: undefined }],
    ["defined", { sensitive: true, tags: ["kopje"], quote: "pending" }],
  ])("a Note, its extension members and tag types %s, is stored as Mastodon stores it", async (variant, expected) => {
    const { t, bob, status } = await world();
    const name = `Note, its extension members and tag types ${variant}`;
    const received = body(name, status);
    expect(await t.post(bob, received)).toBe(202);
    const id = (await statusRow(t.store, (received.object as Json).id as string))!.id;
    const shown = (await t.api<{ sensitive: boolean; tags: { name: string }[] }>(`/api/v1/statuses/${id}`, "alice"))
      .body;
    const quote = (await sql<{ state: string }>(t.store, "SELECT state FROM quotes WHERE status_id = ?", id))[0];
    expect({ sensitive: shown.sensitive, tags: shown.tags.map((tag) => tag.name), quote: quote?.state }).toEqual(
      expected,
    );
    const stored = applied(name).effect.statuses![0]!;
    expect({ sensitive: stored.sensitive, tags: stored.tags ?? [], quote: (stored.quote as Json)?.state }).toEqual(
      expected,
    );
  });

  // A quote given as true is written under the quote's IRI, so the Note's other quote is a legacy one in both.
  it("a Note whose quote is true and whose _misskey_quote names alice's status quotes it, legacy", async () => {
    const { t, bob, status } = await world();
    const name = "Note, its quote given as true";
    const received = body(name, status);
    expect(await t.post(bob, received)).toBe(202);
    const id = (await statusRow(t.store, (received.object as Json).id as string))!.id;
    const stored = await sql<{ legacy: number }>(t.store, "SELECT legacy FROM quotes WHERE status_id = ?", id);
    expect(stored).toEqual([{ legacy: 1 }]);
    expect(applied(name).effect.statuses).toMatchObject([{ quote: { state: "pending", legacy: true } }]);
  });

  it.each([
    ["typed @id, given an IRI", true],
    ["typed @id, given false", false],
    ["typed as a boolean, given false", true],
  ])("a Note, its sensitive %s, is shown sensitive %s, as in Mastodon", async (variant, sensitive) => {
    const { t, bob, status } = await world();
    const name = `Note, its sensitive ${variant}`;
    const received = body(name, status);
    expect(await t.post(bob, received)).toBe(202);
    const id = (await statusRow(t.store, (received.object as Json).id as string))!.id;
    const shown = (await t.api<{ sensitive: boolean }>(`/api/v1/statuses/${id}`, "alice")).body;
    expect(shown.sensitive).toBe(sensitive);
    expect(applied(name).effect.statuses).toMatchObject([{ sensitive }]);
  });

  it.each([
    ["left undefined", true],
    ["defined", false],
  ])("a Delete by an atomUri %s: the status stays %s, as in Mastodon", async (variant, stays) => {
    const { t, bob, status } = await world();
    const deleted = "https://mastodon.example/users/bob/statuses/deleted";
    expect(await t.post(bob, create(bob, mastodonNote(bob, { id: deleted, atomUri: deleted })))).toBe(202);
    const name = `Delete by an atomUri ${variant}`;
    expect(await t.post(bob, body(name, status))).toBe(202);
    expect((await statusRow(t.store, deleted)) !== undefined).toBe(stays);
    expect(applied(name).effect).toEqual(stays ? {} : { removed_statuses: [deleted] });
  });

  it.each([
    ["left undefined", []],
    ["defined", ["kopje"]],
  ])("an Add of a Hashtag, its type %s, features %j, as in Mastodon", async (variant, featured) => {
    const { t, bob, status } = await world();
    const name = `Add of a Hashtag, its type ${variant}`;
    expect(await t.post(bob, body(name, status))).toBe(202);
    const id = (await accountId(t.store, bob.uri))!;
    const tags = await t.api<{ name: string }[]>(`/api/v1/accounts/${id}/featured_tags`, null);
    expect(tags.body.map((tag) => tag.name)).toEqual(featured);
    expect(applied(name).effect.featured_tags ?? []).toEqual(featured);
  });

  it.each([
    ["left undefined", { fields: [], locked: false }],
    ["defined", { fields: ["Site"], locked: true }],
  ])("an Update(Person), its extension members and types %s, is applied as in Mastodon", async (variant, expected) => {
    const { t, bob, status } = await world();
    const name = `Update(Person), its extension members and types ${variant}`;
    expect(await t.post(bob, body(name, status))).toBe(202);
    const id = (await accountId(t.store, bob.uri))!;
    const account = (
      await t.api<{ display_name: string; fields: { name: string }[]; locked: boolean }>(
        `/api/v1/accounts/${id}`,
        "alice",
      )
    ).body;
    expect(account.display_name).toBe("Bob renamed");
    expect({ fields: account.fields.map((field) => field.name), locked: account.locked }).toEqual(expected);
    const { effect } = applied(name);
    expect(effect.display_name).toBe("Bob renamed");
    expect({ fields: effect.fields ?? [], locked: effect.locked ?? false }).toEqual(expected);
  });

  it("a Create whose content is a one-element array is stored with empty content", async () => {
    const { t, bob, status } = await world();
    const received = body("content as a one-element array", status);
    expect(await t.post(bob, received)).toBe(202);
    expect(await statusRow(t.store, (received.object as Json).id as string)).toMatchObject({ content: "" });
    expect(applied("content as a one-element array").effect.statuses).toMatchObject([{ text: '["<p>text</p>"]' }]);
  });

  it("a reply whose inReplyTo is a one-element array is stored without in_reply_to_id", async () => {
    const { t, bob, status } = await world();
    const received = body("inReplyTo as a one-element array", status);
    expect(await t.post(bob, received)).toBe(202);
    expect(await statusRow(t.store, (received.object as Json).id as string)).toMatchObject({ in_reply_to_id: null });
    expect(applied("inReplyTo as a one-element array").effect).toEqual({});
  });

  it("a mention typed as:Mention notifies no one, where Mastodon's reading mentions", async () => {
    const { t, bob, status } = await world();
    const received = body("Mention type as an IRI", status);
    expect(await t.post(bob, received)).toBe(202);
    expect(await statusRow(t.store, (received.object as Json).id as string)).toBeDefined();
    expect(await mentionNotifications(t)).toEqual([]);
    expect(await t.post(bob, plain("Mention type as an IRI", status))).toBe(202);
    expect(await mentionNotifications(t)).toEqual([{ type: "mention" }]);
  });

  it("a one-option poll is stored with its poll, as in Mastodon", async () => {
    const { t, bob, status } = await world();
    const received = body("Question with one option", status);
    expect(await t.post(bob, received)).toBe(202);
    const row = await statusRow(t.store, (received.object as Json).id as string);
    expect(await sql(t.store, "SELECT options FROM polls WHERE status_id = ?", row!.id)).toEqual([
      { options: JSON.stringify(["Only"]) },
    ]);
    expect(applied("Question with one option").effect.statuses).toMatchObject([{ poll: ["Only"] }]);
  });

  it("an Update(Person) whose embedded inbox is [null] applies its profile, where Mastodon drops it", async () => {
    const { t, bob } = await world();
    const { "@context": context, ...document } = bob.document as Json;
    const name = "Update(Person) whose embedded inbox is [null]";
    const update = {
      "@context": context,
      id: `${bob.uri}#updates/inbox-null`,
      type: "Update",
      actor: bob.uri,
      to: [PUBLIC],
      object: { ...document, name: "Bob renamed", inbox: [null] },
      signature: form(name).received.signature,
    };
    expect(await t.post(bob, update)).toBe(202);
    expect(await sql(t.store, "SELECT display_name FROM accounts WHERE uri = ?", bob.uri)).toEqual([
      { display_name: "Bob renamed" },
    ]);
    expect(applied(name).effect).toEqual({});
  });

  it("a Delete whose object is a one-element array leaves its status, as in Mastodon", async () => {
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
    expect(applied("Delete object as a one-element array").effect).toEqual({});
  });
});

// D4: an LD-signed body is read only in the vocabulary Mastodon reads it in (ldSignedBodyReadable); any other is
// ignored before the gate (202, ld-context), on the inbox, its spool replay and the cutover rollback's drain alike.
describe("D4: an LD-signed activity outside Mastodon's vocabulary is ignored", () => {
  const LD_CONTEXT = { ok: false, reason: "ld-context" };
  // Kopje's reading of the body had it no signature: the literal reading D4 keeps from an LD-signed body.
  const literal = (entry: Entry) => read(without(entry.received, "signature"));

  describe("forms whose literal reading would grant what Mastodon's does not", () => {
    it.each(["@base after ActivityStreams", "@base before ActivityStreams"])(
      "ignores an LD-signed activity whose context rebases its IRIs: %s",
      (name) => {
        const entry = form(name);
        expect(kopje(entry)).toEqual(LD_CONTEXT);
        // Literally public; Mastodon reads it addressed to https://other.example/Public, a direct status.
        expect(statusOf(literal(entry))).toMatchObject({ to: [PUBLIC] });
        expect(statusOf(mastodon(entry))).toMatchObject({ to: ["https://other.example/Public"] });
        expect(applied(name).effect.statuses).toMatchObject([{ visibility: "direct" }]);
      },
    );

    it("ignores an LD-signed activity that aliases a keyword or a member beside the literal one", () => {
      const twoTypes = ["a keyword alias beside the literal type", "@type beside type"];
      for (const name of twoTypes) {
        expect(kopje(form(name)), name).toEqual(LD_CONTEXT);
        expect(accepted(literal(form(name))), name).toMatchObject({ type: "Like" });
        // Two types: Mastodon's factory applies nothing.
        expect(mastodonReading(form(name)).type, name).toEqual(["Like", "Create"]);
        expect(applied(name), name).toEqual({ name, effect: {} });
      }
      const twoObjects = [
        "an alias of object beside the literal one",
        "an as:object key holding an object",
        "an absolute IRI key holding an object",
      ];
      for (const name of twoObjects) {
        expect(kopje(form(name)), name).toEqual(LD_CONTEXT);
        expect(accepted(literal(form(name))).object, name).toEqual(expect.any(String));
        expect(mastodonReading(form(name)).object, name).toHaveLength(2);
        expect(mastodon(form(name)), name).toEqual({ ok: false, reason: "unsupported" });
      }
      const aliasedTo = form("an alias of to with to redefined");
      expect(kopje(aliasedTo)).toEqual(LD_CONTEXT);
      expect(statusOf(literal(aliasedTo))).toMatchObject({ to: [PUBLIC] });
      expect(statusOf(mastodon(aliasedTo))).toMatchObject({ to: ["https://mastodon.example/users/bob/followers"] });
      expect(applied(aliasedTo.name).effect.statuses).toMatchObject([{ visibility: "private" }]);
    });

    it.each([
      ["an inline to", (reading: Json) => !Object.hasOwn(reading.object as Json, "to")],
      ["a null tag", (reading: Json) => !Object.hasOwn(reading.object as Json, "tag")],
      ["a redefined Like", (reading: Json) => reading.type === "Dislike"],
      ["a redefined QuoteRequest", (reading: Json) => reading.type === "https://other.example/QuoteRequest"],
      [
        "schema.org after ActivityStreams",
        (reading: Json) => reading.actor === undefined && reading.object === undefined,
      ],
      ["a null context entry", (reading: Json) => reading.type === undefined],
      ["a scoped definition", (reading: Json) => Object.hasOwn(reading.object as Json, "https://other.example/extra")],
      ["a context in the object", (reading: Json) => Object.hasOwn(reading.object as Json, "https://other.example/to")],
      [
        "a context in a tag entry",
        (reading: Json) =>
          Object.hasOwn(([] as Json[]).concat((reading.object as Json).tag as Json)[0]!, "https://other.example/href"),
      ],
    ])("ignores an LD-signed activity whose context changes a name's meaning: %s", (name, renamed) => {
      expect(kopje(form(name))).toEqual(LD_CONTEXT);
      expect(literal(form(name)).ok).toBe(true);
      // Mastodon reads the member renamed, dropped or under another type.
      expect(renamed(mastodonReading(form(name)))).toBe(true);
    });
  });

  describe("forms Mastodon reads, refused where it applies them", () => {
    it.each([
      "@id and @type in place of id and type",
      "@id beside id",
      "@value in content",
      "@nest in a status",
      "@id in inReplyTo",
      "@id in a Mention's href",
      "@id in a Follow's object",
      "@id in an Undo's object",
      "@id in an Accept's result",
      "a redefined as",
      "a prefix naming the ActivityStreams namespace",
      "a prefix chain",
      "@vocab set",
      "@language set",
      "@propagate before ActivityStreams",
      "identity/v1 after ActivityStreams",
      "a context in a proof of the object",
    ])("ignores %s", (name) => {
      expect(kopje(form(name))).toEqual(LD_CONTEXT);
      expect(mastodon(form(name)).ok).toBe(true);
    });

    it.each([
      "@graph in the body",
      "@included in the body",
      "@reverse in the body",
      "an unknown context URL",
      "a nested context array",
    ])("ignores %s, which Mastodon reads as received", (name) => {
      expect(kopje(form(name))).toEqual(LD_CONTEXT);
      expect(form(name).fallback).toEqual(
        expect.stringMatching(/^(Mastodon::InvalidJsonLdError|JSON::LD::JsonLdError)/),
      );
    });
  });

  describe("reads an LD-signed activity in a real sender's vocabulary", () => {
    it.each([
      "Misskey's context",
      "Mastodon 4.4 and 4.5's forwarded context",
      "Mastodon 4.6's forwarded context",
      "Mastodon 4.7's forwarded context",
      "a name outside the vocabulary with a key of its own",
      "an inline prefix named https",
    ])("%s", (name) => {
      expect(ldSignedBodyReadable(form(name).received)).toBe(true);
      expect(kopje(form(name))).toEqual(mastodon(form(name)));
    });

    it("Fedify's contexts, identity/v1 before ActivityStreams, with and without a proof", () => {
      const fedify = corpus.filter((entry) => entry.sender === "fedify-2.4.5");
      expect(
        fedify.every((entry) => (entry.received["@context"] as unknown[])[0] === "https://w3id.org/identity/v1"),
      ).toBe(true);
      for (const entry of fedify) {
        expect(ldSignedBodyReadable(entry.received), entry.name).toBe(true);
      }
    });
  });

  it.each([
    "@base after ActivityStreams, unsigned",
    "a keyword alias beside the literal type, unsigned",
    "an alias of to with to redefined, unsigned",
  ])("reads an unsigned activity with any context, as Mastodon: %s", (name) => {
    const entry = form(name);
    expect(entry.received.signature).toBeUndefined();
    expect(kopje(entry).ok).toBe(true);
    expect(kopje(entry)).toEqual(mastodon(entry));
  });

  it("Kopje's activity types are names of the vocabulary or ones Mastodon does not read", () => {
    // The types activityOf dispatches on, the status, converted and actor types, and the tag types tagsOf and
    // emojiCandidates read.
    const dispatched = ["Follow", "Block", "Accept", "Reject", "Undo", "Move", "QuoteRequest", "Create", "Update"];
    const more = ["Delete", "Add", "Remove", "Flag", "Announce", "Mention", "Hashtag", "Emoji", "Tombstone"];
    const read = [...LIKE_TYPES, ...dispatched, ...more, ...STATUS_TYPES, ...CONVERTED_TYPES, ...ACTOR_TYPES];
    expect(read.filter((type) => !ACTIVITY_VOCABULARY.has(type))).toEqual(["EmojiReact", "EmojiReaction"]);
  });

  describe("through the inbox", () => {
    async function world(): Promise<{ t: Setup; bob: TestActor; status: { id: string; uri: string } }> {
      const t = await setup();
      const bob = await mastodonActor(t.web, "bob");
      await followed(t, bob);
      const status = await localStatus(t, { status: "local", visibility: "public" });
      return { t, bob, status };
    }

    const placed = (json: Json, status: { uri: string }) =>
      JSON.parse(JSON.stringify(json).replaceAll("https://kopje.test/ap/o/local-1", status.uri)) as Json;

    it.each(["@base after ActivityStreams", "@base before ActivityStreams"])(
      "stores nothing an anonymous viewer can see from a rebased Create: %s",
      async (name) => {
        const { t, bob, status } = await world();
        const received = placed(form(name).received, status);
        const id = (received.object as Json).id as string;
        expect(await t.post(bob, received)).toBe(202);
        expect(await statusRow(t.store, id)).toBeUndefined();
        const timeline = await t.api<{ uri: string }[]>("/api/v1/timelines/public", null);
        expect(timeline.body.map((s) => s.uri)).not.toContain(id);
        // The same body without its signature is read as received: public, as Mastodon reads it.
        expect(await t.post(bob, without(received, "signature"))).toBe(202);
        expect(await statusRow(t.store, id)).toMatchObject({ visibility: "public" });
        const after = await t.api<{ uri: string }[]>("/api/v1/timelines/public", null);
        expect(after.body.map((s) => s.uri)).toContain(id);
      },
    );

    it("applies no favourite and no notification from a Like with a keyword alias beside its type", async () => {
      const { t, bob, status } = await world();
      const received = placed(form("a keyword alias beside the literal type").received, status);
      expect(await t.post(bob, received)).toBe(202);
      expect(await sql(t.store, "SELECT * FROM favourites")).toEqual([]);
      expect(await notifications(t.store)).toEqual([]);
      expect(await t.post(bob, without(received, "signature"))).toBe(202);
      expect(await sql(t.store, "SELECT count(*) AS n FROM favourites")).toEqual([{ n: 1 }]);
      expect(await notifications(t.store)).toEqual([{ account_id: ALICE, type: "favourite" }]);
    });

    it("an Accept whose result is given as {@id} grants no stamp", async () => {
      const { t, bob } = await world();
      const note = mastodonNote(bob, { interactionPolicy: { canQuote: { automaticApproval: [PUBLIC] } } });
      expect(
        await t.post(bob, {
          "@context": "https://www.w3.org/ns/activitystreams",
          id: `${note.id}/activity`,
          type: "Create",
          actor: bob.uri,
          to: note.to,
          cc: note.cc,
          object: note,
        }),
      ).toBe(202);
      const theirs = (await statusRow(t.store, note.id))!.id;
      const mine = await localStatus(t, { status: "quote", quoted_status_id: theirs });
      const state = async () =>
        (await sql<{ state: string }>(t.store, "SELECT state FROM quotes WHERE status_id = ?", mine.id))[0]?.state;
      expect(await state()).toBe("pending");
      const stamp = `${bob.uri}/quote_authorizations/1`;
      const signature = form("@id in an Accept's result").received.signature;
      const accept = { ...quoteAccept(bob, mine.uri, null), result: { "@id": stamp }, signature };
      expect(await t.post(bob, accept)).toBe(202);
      expect(await state()).toBe("pending");
      expect(await t.post(bob, { ...quoteAccept(bob, mine.uri, stamp), signature })).toBe(202);
      expect(await state()).toBe("accepted");
    });

    it("a spooled LD-signed activity outside the vocabulary is ignored on replay", async () => {
      const { t, bob, status } = await world();
      const received = placed(form("a keyword alias beside the literal type").received, status);
      const maintenance = harness(t.store, { MAINTENANCE: "readonly" }, BUILD, {
        keygen: fixtureKeyGen,
        loader: t.web.loader,
      });
      const spool = async (body: Json) =>
        (await maintenance.request("/inbox", await signedInit(bob, "/inbox", body, { at: NOW }))).status;
      expect(await spool(received)).toBe(202);
      expect(await spool({ ...without(received, "signature"), id: `${received.id as string}/unsigned` })).toBe(202);
      const deps = { ...inboxDeps(() => t.store, t.web.loader), now: () => NOW };
      await maintenance.queue.deliver((batch) =>
        handleQueue(batch, { ...maintenance.env, MAINTENANCE: "off" } as Env, deps),
      );
      // Only the unsigned copy, read as received, favourites.
      expect(await sql(t.store, "SELECT l.uri FROM favourite_likes l")).toEqual([
        { uri: `${received.id as string}/unsigned` },
      ]);
    });
  });

  // RES-2: the check runs before verification, for any sender, so its witnesses go through the real gate unsigned.
  describe("checks an LD-signed body at the JSON bounds within a generous time", () => {
    const GENEROUS_MS = 1_000;
    const SIGNATURE = { type: "RsaSignature2017", creator: "https://mastodon.example/users/bob#main-key" };

    // The largest `count` for which build(count) stays within the JSON bounds, and that body.
    function filled(build: (count: number) => Json): Json {
      let low = 0;
      let high = MAX_JSON_NODES;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (withinJsonBounds(build(middle))) {
          low = middle;
        } else {
          high = middle - 1;
        }
      }
      const body = build(low);
      expect(withinJsonBounds(body)).toBe(true);
      expect(withinJsonBounds(build(low + 1))).toBe(false);
      return body;
    }

    const activity = (context: unknown, extra: Json) => ({
      "@context": context,
      id: "https://mastodon.example/users/bob/activities/bounds",
      type: "Like",
      actor: "https://mastodon.example/users/bob",
      object: "https://kopje.test/ap/o/1",
      signature: SIGNATURE,
      ...extra,
    });

    // A chain whose innermost object is at MAX_JSON_DEPTH (the body at 1, `chain` at 2), then plain keys up to
    // MAX_JSON_NODES in one object.
    const deep = (count: number) => {
      let chain: Json = {};
      for (let depth = 0; depth < MAX_JSON_DEPTH - 2; depth++) {
        chain = { next: chain };
      }
      const wide = Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${i}`, i]));
      return activity("https://www.w3.org/ns/activitystreams", { chain, wide });
    };
    // The deepest value's depth as withinJsonBounds counts it: the document at 1, each member one deeper.
    const depthOf = (value: unknown): number =>
      typeof value === "object" && value !== null ? 1 + Math.max(0, ...Object.values(value).map(depthOf)) : 1;
    // An inline context of as many definitions as fit, each a compact IRI over one inline prefix.
    const definitions = (count: number) =>
      activity(
        [
          "https://www.w3.org/ns/activitystreams",
          {
            p: "https://other.example/ns#",
            ...Object.fromEntries(Array.from({ length: count }, (_, i) => [`t${i}`, `p:t${i}`])),
          },
        ],
        {},
      );
    // Every ActivityStreams term rule (2) admits defined again as ActivityStreams defines it, then filled as
    // `definitions` is.
    const ASDefinitions = (preloadedContexts["https://www.w3.org/ns/activitystreams"] as { "@context": Json })[
      "@context"
    ];
    const admitted = (definition: unknown) =>
      typeof definition === "string" ||
      ["@set", "@list", undefined].includes((definition as Json)["@container"] as string | undefined);
    const terms = (count: number) =>
      activity(
        [
          "https://www.w3.org/ns/activitystreams",
          Object.fromEntries(
            [...ACTIVITY_VOCABULARY.keys()]
              .filter((name) => Object.hasOwn(ASDefinitions, name) && admitted(ASDefinitions[name]))
              .map((name) => [name, ASDefinitions[name]]),
          ),
          {
            p: "https://other.example/ns#",
            ...Object.fromEntries(Array.from({ length: count }, (_, i) => [`t${i}`, `p:t${i}`])),
          },
        ],
        {},
      );

    it("the depth witness nests exactly MAX_JSON_DEPTH levels", () => {
      expect(depthOf(filled(deep))).toBe(MAX_JSON_DEPTH);
    });

    it.each([
      ["plain keys at the depth bound", deep],
      ["inline definitions", definitions],
      ["ActivityStreams' own definitions", terms],
    ])("%s", async (_, build) => {
      const body = filled(build);
      // The body passes the check (the slow path: every value visited), so only the signature refuses it.
      expect(ldSignedBodyReadable(body)).toBe(true);
      const t = await setup();
      const started = performance.now();
      const response = await t.request("/inbox", {
        method: "POST",
        headers: { "content-type": AP },
        body: JSON.stringify(body),
      });
      const elapsed = performance.now() - started;
      expect(response.status).toBe(401);
      expect(elapsed).toBeLessThan(GENEROUS_MS);
    });
  });
});
