import { preloadedContexts } from "@fedify/fedify";
import jsonld from "jsonld/dist/jsonld.esm.js";
import { describe, expect, it } from "vitest";

import { isPublicCollection } from "../src/domain/audience";
import { FEDIFY_CONTEXT_TERMS } from "../src/federation/fedify-context";
import { LIKE_TYPES, parseActivity } from "../src/federation/inbound";
import {
  ACTIVITY_VOCABULARY,
  ldSignedBodyReadable,
  ldSignedReading,
  type Rules,
  SIGNED_CONTEXT_URLS,
} from "../src/federation/ld-signed-body";
import { MASTODON_CONTEXT_TERMS, MASTODON_OLM_TERMS } from "../src/federation/mastodon-context";
import { ACTOR_TYPES, CONVERTED_TYPES, STATUS_TYPES } from "../src/federation/remote-status";
import { handleQueue } from "../src/jobs/queue";
import { MAX_JSON_DEPTH, MAX_JSON_NODES, withinJsonBounds } from "../src/platform/json-bounds";
import { settle, settleDeliveries, sql } from "./api-helpers";
import { harness, inboxDeps, NOW } from "./app-helpers";
import { fixtureKeyGen } from "./federation-helpers";
import contextMaps from "./fixtures/ld-signed/context-maps.json";
import corpusFixture from "./fixtures/ld-signed/corpus.json";
import edgeShapesFixture from "./fixtures/ld-signed/edge-shapes.json";
import { edgeShapes, KEYWORD_PROOFS } from "./fixtures/ld-signed/edge-shapes.mjs";
import effectsFixture from "./fixtures/ld-signed/effects.json";
import formsFixture from "./fixtures/ld-signed/forms.json";
import proofShapesFixture from "./fixtures/ld-signed/proof-shapes.json";
import { LANGUAGE_PROOFS, proofShapeBody, proofShapes } from "./fixtures/ld-signed/proof-shapes.mjs";
import retractionsFixture from "./fixtures/ld-signed/retractions.json";
import {
  BOB_BLOCK,
  BOB_BOOST,
  BOB_FOLLOW,
  BOB_LIKE,
  BOB_STATUS,
  FORMS,
  type Form,
  LANGUAGE_MAPS,
  OUR_FOLLOW,
  referencesDelete,
  type Retraction,
  RETRACTIONS,
  retraction,
  retractionEntries,
} from "./fixtures/ld-signed/retractions.mjs";
import sensitiveShapesFixture from "./fixtures/ld-signed/sensitive-shapes.json";
import { sensitiveShapeBody, sensitiveShapes, sensitiveShapeText } from "./fixtures/ld-signed/sensitive-shapes.mjs";
import { BUILD } from "./helpers";
import { AP, mastodonActor, signedInit, type TestActor } from "./inbox-helpers";
import {
  accountId,
  ALICE,
  announce,
  create,
  DAVE,
  followed,
  like,
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

const AS = "https://www.w3.org/ns/activitystreams";

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

// #1717, form 4 (ld-signed-body.ts mastodonCompacts): bob's Undo of his block typed as absolute IRIs, in a body of each
// shape beyond the closed one, and beside it one Mastodon reads as received; and of those Mastodon compacts, the ones
// Kopje does not show it compacts, whose types it reads as given, so that it applies nothing (less than Mastodon, where
// Mastodon lifts the block).
const FORM_4 = [...forms.keys()].filter((name) => name.startsWith("Undo of a block, both typed as absolute IRIs, "));
const FORM_4_AS_GIVEN = [
  // A list of lists, which Kopje does not show the compaction writes as JSON-LD 1.1 does.
  "Undo of a block, both typed as absolute IRIs, with an array in an array under a list",
  // An actor Mastodon's compaction writes under its IRI, so that it applies the activity for the request's signer, and
  // a block's object, so that it seeks no account to unblock.
  "Undo of a block, both typed as absolute IRIs, with a number as its actor",
  "Undo of a block, both typed as absolute IRIs, with a number as its block's object",
  // An id the compaction drops, or writes under another label; and the ones jsonld.js writes otherwise (FORM_4_PARTED).
  "Undo of a block, both typed as absolute IRIs, with a keyword-like id",
  "Undo of a block, both typed as absolute IRIs, with a blank node of no label",
  "Undo of a block, both typed as absolute IRIs, with a blank node whose label holds _:",
  "Undo of a block, both typed as absolute IRIs, with an empty id",
  "Undo of a block, both typed as absolute IRIs, with a network-path reference",
  "Undo of a block, both typed as absolute IRIs, with an IRI holding whitespace",
  "Undo of a block, both typed as absolute IRIs, with a relative reference of a dot segment",
  "Undo of a block, both typed as absolute IRIs, with a relative reference of a double-dot segment",
];
// Of those Kopje shows Mastodon compacts, the ones whose id ID-6 refuses where Mastodon's undo.rb reads none: the
// activity's, which is on no origin, and the undone Block's, by which Kopje's Undo finds it, a relative reference.
const FORM_4_ID_6 = [
  "Undo of a block, both typed as absolute IRIs, with an id of another scheme",
  "Undo of a block, both typed as absolute IRIs, with a relative reference as its block's id",
];
// Of the first, the ones jsonld.js reads otherwise than Mastodon's JSON-LD library: a datatype given as a compact IRI over a
// prefix of the ActivityStreams context, which Mastodon's refuses and jsonld.js takes; a blank node Ruby's json-ld labels
// anew; and an id jsonld.js resolves against an empty base.
const FORM_4_PARTED = [
  "Undo of a block, both typed as absolute IRIs, under an inline definition no sender writes",
  "Undo of a block, both typed as absolute IRIs, with a blank node of no label",
  "Undo of a block, both typed as absolute IRIs, with a blank node whose label holds _:",
  "Undo of a block, both typed as absolute IRIs, with an empty id",
  "Undo of a block, both typed as absolute IRIs, with a network-path reference",
  "Undo of a block, both typed as absolute IRIs, with an IRI holding whitespace",
  "Undo of a block, both typed as absolute IRIs, with a relative reference of a dot segment",
  "Undo of a block, both typed as absolute IRIs, with a relative reference of a double-dot segment",
];

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
async function read(body: Json, rules: Rules = {}): Promise<Reading> {
  const parsed = await parseActivity(bytes(body), rules);
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
// Kopje's reading under the rules but (5), the layer under it (ldSignedReading): the forms of D1 hold that layer, and
// "rule (5)" below which of them rule (5) refuses before it.
const SECOND_LAYER: Rules = { senderShapes: false };
const layered = (entry: Entry) => read(entry.received, SECOND_LAYER);
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

  it.each(corpus.map((entry) => [`${entry.sender} ${entry.name}`, entry] as const))("%s", async (_, entry) => {
    expect(await kopje(entry)).toEqual(await mastodon(entry));
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
  it("Fedify's votersCount and EmojiReact, defined otherwise than full_context: read as Mastodon reads them", async () => {
    const question = corpus.find((e) => e.name === "Create(Question), RSA")!;
    expect((mastodonReading(question).object as Json).votersCount).toEqual({
      type: "xsd:nonNegativeInteger",
      "@value": 0,
    });
    expect(statusOf(await kopje(question)).poll).toMatchObject({ votersCount: null });
    const react = corpus.find((e) => e.name === "EmojiReact, RSA")!;
    expect(mastodonReading(react).type).toBe("http://litepub.social/ns#EmojiReact");
    expect(await kopje(react)).toEqual({ ok: false, reason: "unsupported" });
  });

  // With a proof in the data-integrity context, Mastodon reads the same bodies as received (its JSON-LD limits refuse
  // the compaction's @graph), and so does Kopje: the count, and the reaction as a favourite (LIKE_TYPES), where
  // Mastodon has no reader for an EmojiReact.
  it("Fedify's votersCount and EmojiReact with a proof: read as received, as Mastodon reads them", async () => {
    const question = corpus.find((e) => e.name === "Create(Question), RSA and Ed25519")!;
    expect(question.fallback).toMatch(/^Mastodon::InvalidJsonLdError: contains unsupported/);
    expect(statusOf(await kopje(question)).poll).toMatchObject({ votersCount: 0 });
    const react = corpus.find((e) => e.name === "EmojiReact, RSA and Ed25519")!;
    expect(accepted(await kopje(react))).toMatchObject({ type: "Like", object: "https://kopje.test/ap/o/remote-1" });
  });

  // #1589's D20: Mastodon's Add and Remove carry no id, and are read without one (the Store applies them to a
  // collection target only); a FeatureRequest carries no actor.
  it("reads Mastodon's Add and Remove, and refuses FeatureRequest (no actor), in both forms", async () => {
    const entries = corpus.filter((e) => /^(Add|Remove)\(Hashtag\)$|^FeatureRequest$/.test(e.name));
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const name = `${entry.sender} ${entry.name}`;
      if (entry.name === "FeatureRequest") {
        expect(await kopje(entry), name).toEqual({ ok: false, reason: "incomplete" });
        expect(await mastodon(entry)).toEqual({ ok: false, reason: "incomplete" });
        continue;
      }
      expect(accepted(await kopje(entry)), name).toMatchObject({
        type: entry.name.slice(0, -"(Hashtag)".length),
        id: null,
      });
      expect(await kopje(entry), name).toEqual(await mastodon(entry));
    }
  });

  it("a Fedify activity with a proof is one Mastodon reads as received", async () => {
    const proven = corpus.filter((entry) => entry.received.proof !== undefined);
    expect(proven).toHaveLength(11);
    for (const entry of proven) {
      expect(entry.fallback, entry.name).toBe("Mastodon::InvalidJsonLdError: contains unsupported JSON-LD features");
      expect(await kopje(entry)).toEqual(await mastodon(entry));
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
    it("actor as a one-element array: Mastodon applies it for the request's signer", async () => {
      const name = "actor as a one-element array";
      expect(asReceived(form(name))).toBe(true);
      expect(await layered(form(name))).toEqual({ ok: false, reason: "incomplete" });
      expect(applied(name)).toEqual({ name, effect: LIKED });
    });

    it("an object as a one-element array after a member the compaction shortened: the patch stops before it", async () => {
      const name = "a null in an array before a one-element array";
      expect(await layered(form(name))).toEqual({ ok: false, reason: "unsupported" });
      expect(mastodonReading(form(name))).toMatchObject({ to: [], object: "https://kopje.test/ap/users/alice" });
      expect(applied(name)).toEqual({ name, effect: { follows: ["alice"] } });
    });

    it("a Note type as an IRI", async () => {
      const entry = form("Note type as an IRI");
      expect(await layered(entry)).toEqual({ ok: false, reason: "unsupported" });
      expect(statusOf(await mastodon(entry))).toMatchObject({ uri: expect.stringContaining("/statuses/") });
      expect(applied(entry.name).effect.statuses).toMatchObject([{ text: "<p>note 24</p>", visibility: "public" }]);
    });
  });

  describe("reads less than Mastodon", () => {
    it.each(["under an inline context", "with a type naming id", "with a type naming type"])(
      "an Undo of a block typed as IRIs %s: Mastodon compacts it and lifts the block; Kopje cannot tell it does",
      async (variant) => {
        const name = `Undo of a block, both typed as IRIs, ${variant}`;
        expect(form(name).fallback).toBeUndefined();
        expect(await layered(form(name))).toEqual({ ok: false, reason: "unsupported" });
        expect(applied(name)).toEqual({ name, effect: {} });
      },
    );

    it.each([
      ["content as a one-element array", "content", { text: '["<p>text</p>"]' }],
      ["summary as a one-element array", "spoilerText", { spoiler: '["warning"]' }],
    ])("a text as a one-element array: %s, which Mastodon stores as the array's JSON", async (name, member, stored) => {
      expect(asReceived(form(name))).toBe(true);
      expect(statusOf(await layered(form(name)))[member]).toBe("");
      expect(applied(name).effect.statuses).toMatchObject([stored]);
    });

    it("a converted object's name as a one-element array", async () => {
      const name = "name as a one-element array";
      expect(asReceived(form(name))).toBe(true);
      expect(statusOf(await layered(form(name))).content).not.toContain("Title");
      expect(applied(name).effect.statuses).toMatchObject([{ text: expect.stringContaining('<h2>["Title"]</h2>') }]);
    });

    it("a mention's type as an IRI", async () => {
      const entry = form("Mention type as an IRI");
      expect(statusOf(await layered(entry)).mentions).toEqual([]);
      expect(statusOf(await mastodon(entry)).mentions).toEqual(["https://kopje.test/ap/users/alice"]);
      expect(applied(entry.name).effect.statuses).toMatchObject([{ mentions: ["alice"] }]);
    });
  });

  describe("reads more content than Mastodon", () => {
    it("inReplyTo as a one-element array: stored without its parent, where Mastodon's job raises", async () => {
      const name = "inReplyTo as a one-element array";
      expect(asReceived(form(name))).toBe(true);
      expect(statusOf(await layered(form(name)))).toMatchObject({ content: "<p>note 32</p>", inReplyTo: null });
      expect(applied(name)).toEqual({ name, ...RAISED });
    });

    it("an embedded actor whose inbox is [null] (#1673): not blank as received, blank in Mastodon's reading", async () => {
      const name = "Update(Person) whose embedded inbox is [null]";
      expect(accepted(await layered(form(name)))).toMatchObject({ type: "UpdateActor", embedded: { inbox: [null] } });
      expect((mastodonReading(form(name)).object as Json).inbox).toEqual([]);
      expect(applied(name)).toEqual({ name, effect: {} });
    });
  });

  describe("the same effect as Mastodon", () => {
    // Read as received, its value as each reads it unsigned: Mastodon's boolean column takes an array as true, and so
    // does Kopje (railsBoolean).
    it("sensitive as a one-element array: marked", async () => {
      const name = "sensitive as a one-element array";
      expect(asReceived(form(name))).toBe(true);
      expect(statusOf(await layered(form(name))).sensitive).toBe(true);
      expect(applied(name).effect.statuses).toMatchObject([{ sensitive: true, media: 1 }]);
    });

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
    ])("an activity %s: read as the compaction names its type", async (name, effect) => {
      const reading = accepted(await layered(form(name)));
      expect(reading.type).not.toContain(":");
      expect(reading).toEqual(accepted(await mastodon(form(name))));
      expect(applied(name)).toEqual({ name, effect });
    });

    it.each([
      ["Undo object type as an IRI", { removed_follows: 1 }],
      ["Undo object type as the absolute IRI", { removed_follows: 1 }],
      ["Accept object type as an IRI", { local_requests_removed: 1, local_follows: ["alice"] }],
      ["Accept object type as the absolute IRI", { local_requests_removed: 1, local_follows: ["alice"] }],
      ["Reject of an accepted follow, its object's type as:Follow", { local_follows_removed: 1 }],
      ["Reject of an accepted follow, its object's type the absolute IRI", { local_follows_removed: 1 }],
    ])("an embedded object's type as an IRI, %s: read as Follow", async (name, effect) => {
      const reading = accepted(await layered(form(name)));
      expect(reading.object).toMatchObject({ type: "Follow" });
      expect(reading).toEqual(accepted(await mastodon(form(name))));
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
    ])("an answer naming our follow's id under a QuoteRequest's type, %s", async (name, effect) => {
      expect(accepted(await layered(form(name))).object).toMatchObject({
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
    ])("%s left undefined, and defined: read as Mastodon reads it", async (base) => {
      for (const name of [`${base} left undefined`, `${base} defined`]) {
        expect(form(name).fallback, name).toBeUndefined();
        expect(await layered(form(name)), name).toEqual(await mastodon(form(name)));
      }
    });

    it.each(["sensitive left undefined", "interactionPolicy left undefined"])(
      "%s: read as Mastodon reads it",
      async (name) => {
        expect(await layered(form(name))).toEqual(await mastodon(form(name)));
        expect(statusOf(await layered(form(name)))).toMatchObject({ sensitive: false, quotePolicy: null });
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
      async (name, key) => {
        const entry = form(name);
        expect(Object.keys(mastodonReading(entry).object as Json)).toContain(key);
        expect(statusOf(await layered(entry)).quote).toBeNull();
        expect(await layered(entry)).toEqual(await mastodon(entry));
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
    ] as [string, (r: Reading) => unknown, unknown][])("%s: read as Mastodon reads it", async (name, member, value) => {
      expect(form(name).fallback).toBeUndefined();
      expect(member(await layered(form(name)))).toEqual(value);
      expect(await layered(form(name))).toEqual(await mastodon(form(name)));
    });

    // sensitive typed otherwise than full_context, which leaves it untyped, is written under the name all the same: an
    // IRI as a node, a value of a datatype as a typed value, either an object Mastodon takes as true; false as false.
    // Kopje reads it as Mastodon marks the status (ldSignedReading).
    it.each([
      ["typed @id, given an IRI", true],
      ["typed @id, given false", false],
      ["typed as a boolean, given false", true],
    ])("sensitive %s: marked %s, as Mastodon marks it", async (variant, marked) => {
      const name = `Note, its sensitive ${variant}`;
      expect(form(name).fallback).toBeUndefined();
      expect(statusOf(await layered(form(name))).sensitive).toBe(marked);
      expect(applied(name).effect.statuses).toMatchObject([{ sensitive: marked, media: 1 }]);
    });

    // The same for each definition of `sensitive` the rules admit, given each shape of value (sensitive-shapes.json,
    // Mastodon's reading and the status it creates): a list is written as a @list object, an array, an empty one too,
    // as an array, each true, and so is a float 0 (0.0), which JSON parses as 0. Kopje marks the status wherever
    // Mastodon does, and also where the value is an integer 0 typed @id, where Mastodon's json-ld refuses a datatype
    // given as xsd: (it reads `false`, `0` or `"false"` as received) or keeps one of two equal values typed @id (the
    // patch then stops at the array of one, and the compaction's false stands).
    it("sensitive defined otherwise, given each shape: marked wherever Mastodon marks it", async () => {
      const shapes = sensitiveShapes();
      expect(sensitiveShapesFixture.reference).toBe("mastodon-4.7.5");
      expect(sensitiveShapesFixture.sensitive).toHaveLength(shapes.length);
      const more: string[] = [];
      for (const [index, shape] of shapes.entries()) {
        const marked = statusOf(await read(sensitiveShapeBody(shape), SECOND_LAYER)).sensitive === true;
        const mastodon = sensitiveShapesFixture.sensitive[index] === "t";
        expect(marked || !mastodon, shape.name).toBe(true);
        if (marked && !mastodon) {
          more.push(shape.name);
        }
      }
      expect(more).toEqual([
        "typed @id, given 0",
        "typed @id, given [false, false]",
        "typed @id, a set, given 0",
        "typed @id, a set, given [false, false]",
        "typed as xsd:boolean, given false",
        "typed as xsd:boolean, given 0",
        'typed as xsd:boolean, given "false"',
      ]);
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
    ])(
      "a QuoteRequest left undefined with a proof of %s: read as received %s, as by Mastodon",
      async (variant, received) => {
        const name = `QuoteRequest, its type left undefined, with a proof of ${variant}`;
        expect(form(name).fallback !== undefined).toBe(received);
        expect(await layered(form(name))).toEqual(await mastodon(form(name)));
        expect((await layered(form(name))).ok).toBe(received);
      },
    );

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
    ])("a Note with names its context leaves undefined, %s: read as received", async (_, change) => {
      const received = form("Note, its extension members and tag types left undefined").received;
      expect(statusOf(await read(received)).sensitive).toBe(false);
      const changed = change(received);
      expect(statusOf(await read(changed))).toMatchObject({ sensitive: true, tags: ["kopje"] });
      expect(statusOf(await read(changed))).toEqual(statusOf(await read(without(changed, "signature"))));
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
      async (base, kopjeRead, mastodonApplied) => {
        const [undefinedName, definedName] = [`${base} left undefined`, `${base} defined`];
        expect(kopjeRead(await layered(form(undefinedName)))).toEqual(mastodonApplied(applied(undefinedName).effect));
        expect(kopjeRead(await layered(form(definedName)))).toEqual(mastodonApplied(applied(definedName).effect));
        expect(kopjeRead(await layered(form(undefinedName)))).not.toEqual(kopjeRead(await layered(form(definedName))));
      },
    );

    // Tags that are also the keyword aliases `id` and `type` are tags in a language map, for both.
    it.each([
      "Undo of a block, both typed as IRIs",
      "Undo of a block, both typed as IRIs, with a language map tagged id and type",
      "Undo of a block, both typed as IRIs, with an array in an array",
      "Undo of a block, both typed as IRIs, with a proof of plain names",
      "Undo of a block, both typed as IRIs, with a number where an IRI is expected",
    ])("%s, in a body Mastodon compacts: both lift the block", async (name) => {
      expect(form(name).fallback).toBeUndefined();
      expect(accepted(await layered(form(name)))).toMatchObject({ type: "Undo", object: { type: "Block" } });
      expect(applied(name)).toEqual({ name, effect: {} });
    });

    // #1717, form 4: jsonld.js, with the preloaded contexts, compacts each body under full_context as Mastodon's JSON-LD
    // library does, patched as patch_for_forwarding! patches it and within check_jsonld_limits! (a JavaScript copy of
    // each below), and refuses each Mastodon reads as received; where the two part, Kopje reads the body as received.
    it("jsonld.js compacts each retraction body of form 4 as Mastodon does", async () => {
      const PUBLIC_IRI = `${AS}#Public`;
      const fullContext = form("type as an absolute IRI").mastodon!["@context"];
      const documentLoader = (url: string) =>
        Object.hasOwn(preloadedContexts, url)
          ? Promise.resolve({ contextUrl: null, document: preloadedContexts[url], documentUrl: url })
          : Promise.reject(new Error(`not preloaded: ${url}`));
      const isMap = (value: unknown): value is Json =>
        typeof value === "object" && value !== null && !Array.isArray(value);
      const limited = (value: unknown): boolean => {
        let values = 0;
        const pending = [value];
        while (pending.length > 0) {
          const next = pending.pop();
          values++;
          if (Array.isArray(next)) {
            pending.push(...(next as unknown[]));
          } else if (isMap(next)) {
            if (["@graph", "@included", "@reverse"].some((key) => Object.hasOwn(next, key))) {
              return false;
            }
            pending.push(...Object.values(next));
          }
        }
        return values <= 1_000;
      };
      const patch = (received: Json, compacted: Json): void => {
        for (const [key, value] of Object.entries(received)) {
          if (key === "@context" || key === "signature" || value === null || !Object.hasOwn(compacted, key)) {
            continue;
          }
          const written = compacted[key];
          if (isMap(value) && isMap(written)) {
            patch(value, written);
          } else if (Array.isArray(value)) {
            const items: unknown[] = Array.isArray(written) ? (written as unknown[]) : [written];
            if (items.length !== value.length) {
              return;
            }
            compacted[key] = (value as unknown[]).map((item, at) => {
              const given = items[at];
              if (isMap(item) && isMap(given)) {
                patch(item, given);
                return given;
              }
              return item === PUBLIC_IRI && given === "as:Public" ? item : given;
            });
          } else if (value === PUBLIC_IRI && written === "as:Public") {
            compacted[key] = value;
          }
        }
      };
      const sorted = (value: unknown): unknown =>
        Array.isArray(value)
          ? value.map(sorted)
          : isMap(value)
            ? Object.fromEntries(
                Object.keys(value)
                  .toSorted()
                  .map((key) => [key, sorted(value[key])]),
              )
            : value;
      const parted: string[] = [];
      for (const name of FORM_4) {
        const { received, mastodon, fallback } = form(name);
        let reading: Json | undefined;
        if (limited(received)) {
          const compacted = await jsonld
            .compact(without(received, "signature"), fullContext as never, { documentLoader })
            .catch(() => undefined);
          if (compacted !== undefined && limited({ ...compacted, signature: received.signature })) {
            reading = { ...(compacted as Json), signature: received.signature };
            patch(received, reading);
          }
        }
        const agrees =
          fallback === undefined ? JSON.stringify(sorted(reading)) === JSON.stringify(sorted(mastodon)) : !reading;
        if (!agrees) {
          parted.push(name);
        }
      }
      expect(FORM_4.length).toBeGreaterThanOrEqual(5);
      expect(parted).toEqual(FORM_4_PARTED);
      for (const name of FORM_4_PARTED) {
        expect(form(name).fallback !== undefined || FORM_4_AS_GIVEN.includes(name), name).toBe(true);
        expect((await ldSignedReading(form(name).received, SECOND_LAYER))?.readType(`${AS}#Undo`), name).not.toBe(
          "Undo",
        );
      }
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
    ])(
      "an Undo of a block typed as IRIs %s: Mastodon reads it as received, so neither lifts it",
      async (variant, cause) => {
        const name = `Undo of a block, both typed as IRIs, ${variant}`;
        expect(form(name).fallback).toMatch(cause);
        expect(await layered(form(name))).toEqual({ ok: false, reason: "unsupported" });
        expect(applied(name)).toEqual({ name, effect: { blocks: ["alice"] } });
      },
    );

    it("an unsigned body's types are read as given, as Mastodon reads it uncompacted", async () => {
      expect(await read(without(form("type as a compact IRI").received, "signature"))).toEqual({
        ok: false,
        reason: "unsupported",
      });
      const undo = accepted(await read(without(form("Undo object type as an IRI").received, "signature")));
      expect(undo.object).toMatchObject({ type: "as:Follow" });
    });

    // Mastodon renames a type given as an IRI only in a body it compacts; where it gives the compaction up it reads the
    // body as received. Kopje renames one only where it can tell Mastodon compacts the body: never in a body Mastodon
    // read as received, and in each it can tell of, as the compaction names it.
    it("renames a type given as an IRI only in a body Mastodon compacts, as the compaction names it", async () => {
      const renamed: string[] = [];
      const kept = new Set<string>();
      let names = 0;
      for (const entry of [...corpus, ...forms.values()]) {
        const ours =
          typeof entry.received.signature === "object" ? await ldSignedReading(entry.received, SECOND_LAYER) : null;
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
      expect(renamed.length).toBe(53);
      // Bodies Mastodon compacts outside the shape Kopje shows it compacts (an inline context, an array in an array,
      // a proof, a number where an IRI is expected, an id it writes otherwise or jsonld.js does, a type naming a
      // keyword alias): their types are read as given, so such an activity applies less than Mastodon's.
      expect([...kept]).toEqual([
        "Note type as an IRI",
        "Undo of a block, both typed as IRIs, under an inline context",
        "Undo of a block, both typed as IRIs, with a type naming id",
        "Undo of a block, both typed as IRIs, with a type naming type",
        "Undo of a block, both typed as absolute IRIs, with an array in an array under a list",
        "Undo of a block, both typed as absolute IRIs, with a number as its actor",
        "Undo of a block, both typed as absolute IRIs, with a number as its block's object",
        "Undo of a block, both typed as absolute IRIs, with a keyword-like id",
        "Undo of a block, both typed as absolute IRIs, with a blank node of no label",
        "Undo of a block, both typed as absolute IRIs, with a blank node whose label holds _:",
        "Undo of a block, both typed as absolute IRIs, with an empty id",
        "Undo of a block, both typed as absolute IRIs, with a network-path reference",
        "Undo of a block, both typed as absolute IRIs, with an IRI holding whitespace",
        "Undo of a block, both typed as absolute IRIs, with a relative reference of a dot segment",
        "Undo of a block, both typed as absolute IRIs, with a relative reference of a double-dot segment",
      ]);
    });

    // The shape's bounds on the same body, where no capture varies them: an object with no id or type is a node like
    // any other, and a null among IRIs is dropped (as in the captured `to: [null]` forms); an id over a prefix only
    // full_context defines (as the captured `cc` and type ones), and a language map value other than a map of tags to
    // strings are outside it; a blank node, an http(s) IRI whose scheme is upper-case or not followed by `//`, and a
    // boolean where an IRI is expected are inside the retraction's (form 4).
    it.each([
      { added: { instrument: { name: "client" } }, read: "Undo" },
      { added: { cc: [null] }, read: "Undo" },
      { added: { instrument: { id: "toot:client" } }, read: "as:Undo" },
      { added: { instrument: { id: "_:client" } }, read: "Undo" },
      { added: { instrument: { id: "HTTPS://mastodon.example/client" } }, read: "Undo" },
      { added: { instrument: { id: "https:mastodon.example/client" } }, read: "Undo" },
      { added: { cc: true }, read: "Undo" },
      { added: { summaryMap: 5 }, read: "as:Undo" },
      { added: { summaryMap: { en: ["blocked"] } }, read: "as:Undo" },
      { added: { summaryMap: { "not a tag": "blocked" } }, read: "as:Undo" },
    ])("reads the compacted Undo of a block, given $added, as $read", async ({ added, read }) => {
      const body = { ...form("Undo of a block, both typed as IRIs").received, ...added };
      expect((await ldSignedReading(body, SECOND_LAYER))?.readType("as:Undo")).toBe(read);
    });

    // Form 4 widens the shape for a retraction only: another activity's body of each of its shapes has its types read
    // as given.
    it.each([
      { shape: "nothing beyond the closed shape", added: {}, read: "Like" },
      {
        shape: "an inline context",
        added: {
          "@context": form("Undo of a block, both typed as absolute IRIs, under Mastodon's inline context").received[
            "@context"
          ],
        },
        read: "as:Like",
      },
      { shape: "an array in an array", added: { cc: [[`${AS}#Public`]] }, read: "as:Like" },
      {
        shape: "a proof of plain names",
        added: { proof: { type: "DataIntegrityProof", proofValue: "z3" } },
        read: "as:Like",
      },
      { shape: "a boolean where an IRI is expected", added: { cc: true }, read: "as:Like" },
      { shape: "a blank node as an id", added: { instrument: { id: "_:client" } }, read: "as:Like" },
    ])("reads the compacted Like with $shape as $read", async ({ added, read }) => {
      const body = { ...form("type as a compact IRI").received, ...added };
      expect((await ldSignedReading(body, SECOND_LAYER))?.readType("as:Like")).toBe(read);
    });

    it("type as a one-element array: neither applies it", async () => {
      const name = "type as a one-element array";
      expect(asReceived(form(name))).toBe(true);
      expect(await layered(form(name))).toEqual({ ok: false, reason: "incomplete" });
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
    ])("refused, where Mastodon's job raises: %s", async (name) => {
      expect(asReceived(form(name))).toBe(true);
      expect(await layered(form(name))).toEqual({ ok: false, reason: "unsupported" });
      expect(applied(name)).toEqual({ name, ...RAISED });
    });

    it.each(["Remove object as a one-element array", "Remove target as a one-element array"])(
      "refused, where Mastodon's job raises and the pin stays: %s",
      async (name) => {
        expect(asReceived(form(name))).toBe(true);
        expect(await layered(form(name))).toEqual({ ok: false, reason: "unsupported" });
        expect(applied(name)).toEqual({
          name,
          error: expect.stringMatching(/^TypeError/),
          effect: { pins: ["https://mastodon.example/users/bob/statuses/pinned"] },
        });
      },
    );

    it("an EmojiReact whose object is a one-element array: refused, where Mastodon reads no EmojiReact", async () => {
      const name = "EmojiReact object as a one-element array";
      expect(await layered(form(name))).toEqual({ ok: false, reason: "unsupported" });
      expect(applied(name)).toEqual({ name, effect: {} });
    });

    it("an Undo or Reject reference as a one-element array: nothing undone or rejected", async () => {
      for (const name of ["Undo object as a one-element array", "Reject object as a one-element array"]) {
        expect(asReceived(form(name)), name).toBe(true);
        expect(accepted(await layered(form(name))).object, name).toMatchObject({ id: null, type: null });
        expect(applied(name), name).toEqual({ name, ...RAISED });
      }
    });

    it("a Move's target as a one-element array: read without a target (refused later as no-target)", async () => {
      const name = "Move target as a one-element array";
      expect(await layered(form(name))).toMatchObject({ ok: true, target: null });
      expect(applied(name)).toEqual({ name, ...RAISED });
    });

    it("a poll with one option: both store it", async () => {
      const name = "Question with one option";
      expect(asReceived(form(name))).toBe(true);
      expect(statusOf(await layered(form(name))).poll).toMatchObject({ options: ["Only"] });
      expect(applied(name).effect.statuses).toMatchObject([{ poll: ["Only"] }]);
    });

    it("a Flag's object as a one-element array", async () => {
      const entry = form("Flag object as a one-element array");
      expect(accepted(await layered(entry))).toMatchObject({
        type: "Flag",
        objects: ["https://kopje.test/ap/users/alice"],
      });
      expect(await layered(entry)).toEqual(await mastodon(entry));
      expect(applied(entry.name).effect).toEqual({ reports: [{ target: "alice", statuses: 0 }] });
    });

    it("more than 1,000 values, and a proof in the data-integrity context: Mastodon reads them as received", async () => {
      expect(form("more than 1,000 values").fallback).toBe("Mastodon::InvalidJsonLdError: has too many nodes");
      expect(form("a proof in the data-integrity context").fallback).toBe(
        "Mastodon::InvalidJsonLdError: contains unsupported JSON-LD features",
      );
      for (const name of ["more than 1,000 values", "a proof in the data-integrity context"]) {
        expect((await layered(form(name))).ok, name).toBe(true);
        expect(await layered(form(name))).toEqual(await mastodon(form(name)));
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

  it("a Like typed as:Like is ignored (rule 5), where Mastodon's reading favourites", async () => {
    const { t, bob, status } = await world();
    expect(await t.post(bob, body("type as a compact IRI", status))).toBe(202);
    expect(await favourites(t)).toEqual([]);
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
    "Reject of an accepted follow, its object's type the absolute IRI",
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

  // A type given as a compact IRI, which rule (5) refuses: Kopje applies nothing (reads less).
  it.each([
    "Reject of an accepted follow, its object's type as:Follow",
    "Reject typed as:Reject, of an accepted follow",
    "Block typed as:Block, by an accepted follow's target",
  ])("%s is ignored (rule 5): alice's follow and her reading stay, where Mastodon ends them", async (name) => {
    const { t, bob, status } = await world();
    const id = await followersOnly(t, bob);
    expect(await t.post(bob, body(name, status))).toBe(202);
    expect(await aliceFollows(t, bob)).toEqual([{ state: "accepted" }]);
    expect((await t.api(`/api/v1/statuses/${id}`, "alice")).status).toBe(200);
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
  ])("%s, which Mastodon compacts and lifts, is ignored (rule 5): the block stays", async (name) => {
    const { t, bob, status } = await world();
    const id = await blockedStatus(t, bob);
    expect(await t.post(bob, body(name, status))).toBe(202);
    expect((await t.api(`/api/v1/statuses/${id}`, "alice")).status).toBe(404);
    expect(applied(name)).toEqual({ name, effect: {} });
  });

  // The same Undo with both types given as absolute IRIs, which JSON-LD expands to the same IRIs as the compact ones, so
  // that Mastodon's compaction names them alike: Kopje reads its types as the compaction names them (D5), and lifts it.
  const absolute = (json: Json) =>
    JSON.parse(
      JSON.stringify(json).replaceAll('"as:Undo"', `"${AS}#Undo"`).replaceAll('"as:Block"', `"${AS}#Block"`),
    ) as Json;

  it("an Undo of a block, both typed as absolute IRIs, in a body Mastodon compacts, lifts it", async () => {
    const { t, bob, status } = await world();
    const id = await blockedStatus(t, bob);
    expect(await t.post(bob, absolute(body("Undo of a block, both typed as IRIs", status)))).toBe(202);
    expect((await t.api(`/api/v1/statuses/${id}`, "alice")).status).toBe(200);
  });

  // #1717, form 4: the same Undo in a body of each shape beyond the closed one lifts the block where Mastodon's reading
  // of it does (forms.json): an Undo of a Block whose object names alice, whatever its actor, as undo.rb undo_block
  // seeks the account by the Block's object and lifts the request's signer's block of it. It leaves the block where
  // Mastodon reads the body as received, so that its types stay IRIs no handler reads, and where Kopje does not show it
  // compacts (reads less), or where ID-6 refuses an id Mastodon does not read.
  it.each(FORM_4)("%s: lifts the block where Mastodon's reading lifts it", async (name) => {
    const reading = form(name).fallback === undefined ? form(name).mastodon! : undefined;
    const block = reading?.object as Json | undefined;
    const lifted =
      reading?.type === "Undo" && block?.type === "Block" && block.object === "https://kopje.test/ap/users/alice";
    const { t, bob, status } = await world();
    const id = await blockedStatus(t, bob);
    expect(await t.post(bob, body(name, status))).toBe(202);
    expect((await t.api(`/api/v1/statuses/${id}`, "alice")).status).toBe(
      lifted && !FORM_4_AS_GIVEN.includes(name) && !FORM_4_ID_6.includes(name) ? 200 : 404,
    );
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
  it("on replay too, an Undo of a block typed as IRIs lifts it only where Kopje reads it so", async () => {
    const { t, bob, status } = await world();
    const id = await blockedStatus(t, bob);
    const maintenance = harness(t.store, { MAINTENANCE: "readonly" }, BUILD, {
      keygen: fixtureKeyGen,
      loader: t.web.loader,
    });
    const deps = { ...inboxDeps(() => t.store, t.web.loader), now: () => NOW };
    const replay = async (json: Json) => {
      const init = await signedInit(bob, "/inbox", json, { at: NOW });
      expect((await maintenance.request("/inbox", init)).status).toBe(202);
      await maintenance.queue.deliver((batch) =>
        handleQueue(batch, { ...maintenance.env, MAINTENANCE: "off" } as Env, deps),
      );
    };
    const undo = (name: string) => absolute(body(name, status));
    await replay(undo("Undo of a block, both typed as IRIs, with a proof typed by a number"));
    expect((await t.api(`/api/v1/statuses/${id}`, "alice")).status).toBe(404);
    await replay(undo("Undo of a block, both typed as IRIs, with a null type in a language map array"));
    expect((await t.api(`/api/v1/statuses/${id}`, "alice")).status).toBe(404);
    // As compact IRIs, which rule (5) refuses; then as absolute ones.
    await replay(body("Undo of a block, both typed as IRIs", status));
    expect((await t.api(`/api/v1/statuses/${id}`, "alice")).status).toBe(404);
    await replay(undo("Undo of a block, both typed as IRIs"));
    expect((await t.api(`/api/v1/statuses/${id}`, "alice")).status).toBe(200);
  });

  it.each([
    ["Undo object type as the absolute IRI", []],
    // A type given as a compact IRI, which rule (5) refuses (reads less).
    ["Undo typed as:Undo", [{ state: "accepted" }]],
  ])("%s: bob's follow of alice is then %j, where Mastodon ends it", async (name, left) => {
    const { t, bob, status } = await world();
    const follow = { "@context": AS, type: "Follow", actor: bob.uri };
    const id = "https://mastodon.example/users/bob/follows/14";
    expect(await t.post(bob, { ...follow, id, object: "https://kopje.test/ap/users/alice" })).toBe(202);
    expect(await follows(t)).toEqual([{ state: "accepted" }]);
    expect(await t.post(bob, body(name, status))).toBe(202);
    expect(await follows(t)).toEqual(left);
    expect(applied(name).effect).toEqual({ removed_follows: 1 });
  });

  it("a Delete typed as:Delete is ignored (rule 5): its status stays, where Mastodon removes it", async () => {
    const { t, bob, status } = await world();
    const deleted = "https://mastodon.example/users/bob/statuses/deleted";
    const note = mastodonNote(bob, { id: deleted, atomUri: deleted });
    expect(await t.post(bob, create(bob, note))).toBe(202);
    expect(await statusRow(t.store, deleted)).toBeDefined();
    expect(await t.post(bob, body("Delete typed as:Delete", status))).toBe(202);
    expect(await statusRow(t.store, deleted)).toBeDefined();
    expect(applied("Delete typed as:Delete").effect).toEqual({ removed_statuses: [deleted] });
  });

  // A name full_context defines that the body's context leaves undefined, as a type or as a member, is read as
  // Mastodon's compaction names it, a blank node's: what Mastodon's readers do not read applies nothing here either,
  // and the same body with the name defined applies it in both (ldSignedReading).
  // bob's status quoting alice's, its quote pending, and the state of that quote.
  async function bobsQuote(t: Setup, bob: TestActor, status: { uri: string }): Promise<() => Promise<unknown>> {
    const uri = "https://mastodon.example/users/bob/statuses/quoting";
    expect(await t.post(bob, create(bob, quoting(bob, status.uri, null, { id: uri, atomUri: uri })))).toBe(202);
    const id = (await statusRow(t.store, uri))!.id;
    const quote = async () =>
      (await sql<{ state: string }>(t.store, "SELECT state FROM quotes WHERE status_id = ?", id))[0]?.state;
    expect(await quote()).toBe("pending");
    return quote;
  }

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
    const quote = await bobsQuote(t, bob, status);
    expect(await t.post(bob, body(name, status))).toBe(202);
    expect(await quote()).toBe(state);
    const uri = "https://mastodon.example/users/bob/statuses/quoting";
    expect(applied(name).effect).toEqual(state === "pending" ? {} : { quote_changes: [{ status: uri, state }] });
  });

  // A proof of a @language beside members that expand to nothing leaves nothing, as one of @language alone does, so
  // Mastodon reads the compaction, whose `_:QuoteRequest` approves nothing (proof-shapes.json is its reading of each
  // proof here); one that keeps something has the body read as received. Rule (5) refuses each but the proof as Fedify
  // writes one, which Mastodon keeps, so that Kopje approves the quote only there.
  let shapes: ReturnType<typeof proofShapes> | undefined;
  it.each(LANGUAGE_PROOFS.map((shape) => [`${shape.context} ${JSON.stringify(shape.proof)}`, shape] as const))(
    "a QuoteRequest left undefined, its proof %s, approves bob's quote only where rule (5) reads it and Mastodon keeps the proof",
    async (_, shape) => {
      shapes ??= proofShapes();
      const index = shapes.findIndex(
        (other) => other.context === shape.context && JSON.stringify(other.proof) === JSON.stringify(shape.proof),
      );
      expect(proofShapesFixture.readings[index]).toBe(shape.kept ? "k" : "c");
      const { t, bob, status } = await world();
      const quote = await bobsQuote(t, bob, status);
      expect(await t.post(bob, placed(proofShapeBody(shape), status, ""))).toBe(202);
      const read = ldSignedBodyReadable(proofShapeBody(shape));
      expect(await quote()).toBe(read && shape.kept ? "accepted" : "pending");
    },
  );

  // An edge shape's body and Mastodon's reading of it (edge-shapes.json).
  let edges: ReturnType<typeof edgeShapes> | undefined;
  function edge(name: string): { body: Json; reading: string | undefined } {
    edges ??= edgeShapes();
    const index = edges.findIndex((shape) => shape.name === name);
    expect(index).toBeGreaterThanOrEqual(0);
    return { body: edges[index]!.body, reading: edgeShapesFixture.readings[index] };
  }

  // A proof of a @language beside a key that starts with @ but is no keyword of a node (one of contexts or frames):
  // Mastodon's json-ld drops the key, so that the proof keeps nothing and Mastodon reads the compaction, where jsonld.js
  // keeps it as a member. Kopje does not compare such a proof, and reads the body as named.
  it.each(KEYWORD_PROOFS.map((shape) => `${shape.context} ${JSON.stringify(shape.proof)}`))(
    "a QuoteRequest left undefined, its proof %s, leaves bob's quote pending, as in Mastodon",
    async (name) => {
      const { body: received, reading } = edge(name);
      expect(reading).toBe("c");
      const { t, bob, status } = await world();
      const quote = await bobsQuote(t, bob, status);
      expect(await t.post(bob, placed(received, status, ""))).toBe(202);
      expect(await quote()).toBe("pending");
    },
  );

  // A name with a line shaped like a keyword, defined in the body's context, beside a @language in a proof: Ruby's
  // json-ld drops the name before it reads its definition, so that the proof keeps nothing and Mastodon reads the
  // compaction, where jsonld.js expands it to its IRI. Rule (5) refuses such a key, and the layer under it does not
  // compare the proof (comparableProof).
  it.each([
    '"x\\n@abc" defined, beside a @language',
    '"x\\n@version" defined, nested',
    '"x\\r\\n@abc" defined, beside a @language',
  ])(
    "a QuoteRequest left undefined, its proof of a name %s, leaves bob's quote pending, as in Mastodon",
    async (name) => {
      const { body: received, reading } = edge(name);
      expect(reading).toBe("c");
      const { t, bob, status } = await world();
      const quote = await bobsQuote(t, bob, status);
      expect(await t.post(bob, placed(received, status, ""))).toBe(202);
      expect(await quote()).toBe("pending");
    },
  );

  // A @set beside a type in a proof: Ruby's json-ld keeps the node and raises a NoMethodError, and Mastodon's job applies
  // nothing. Rule (5) refuses the proof, and the layer under it the body (typesSortable).
  it.each(["type beside @set null", "nested: type beside @set null", '@type beside @set {"@value":null}'])(
    "a QuoteRequest left undefined, its proof's %s, leaves bob's quote pending, as in Mastodon",
    async (name) => {
      const { body: received, reading } = edge(name);
      expect(reading).toBe("e");
      const { t, bob, status } = await world();
      const quote = await bobsQuote(t, bob, status);
      expect(await t.post(bob, placed(received, status, ""))).toBe(202);
      expect(await quote()).toBe("pending");
    },
  );

  // A type array of two values or more one of which is not a string or has a line shaped like a keyword (`type` and
  // `@type` of a node taken together): Mastodon's json-ld sorts it and raises, and its job applies nothing, so Kopje
  // refuses the body (rule 5, and typesSortable under it). Given one type, the QuoteRequest (its type defined) approves
  // bob's quote in both.
  it.each([
    ["the instrument's type: [null, type]", "pending"],
    ["a node's type under an undefined name: [type, null]", "pending"],
    ["the proof's type: [5, type]", "pending"],
    ["the proof's @type: [{}, type]", "pending"],
    ["a node's type in the proof: [true, type]", "pending"],
    ['the instrument\'s type: [type, "@foo"]', "pending"],
    ['the instrument\'s type: [type, "x\\n@abc"]', "pending"],
    ['the proof\'s type: [type, "@foo"]', "pending"],
    ['the proof\'s @type beside its type: ["@foo"]', "pending"],
    ["the instrument's type: type", "accepted"],
    ["the proof's type: type", "accepted"],
  ])("a QuoteRequest, its type defined, with %s, leaves bob's quote %s, as in Mastodon", async (name, state) => {
    const { body: received, reading } = edge(name);
    expect(reading === "e").toBe(state === "pending");
    const { t, bob, status } = await world();
    const quote = await bobsQuote(t, bob, status);
    expect(await t.post(bob, placed(received, status, ""))).toBe(202);
    expect(await quote()).toBe(state);
  });

  it.each([
    ["a Delete's object's type: [null, type]", true],
    ["a Delete's object's type: [[type], type]", true],
    ["a Delete's object's type: [type, \"@foo\"]", true],
    ["a Delete's object's tag's type: [type, \"@foo\"]", true],
    ["a Delete's object's type: type", false],
  ])("an LD-signed Delete of bob's status, %s: the status stays %s, as in Mastodon", async (name, stays) => {
    const { body: received, reading } = edge(name);
    expect(reading === "e").toBe(stays);
    const { t, bob } = await world();
    const deleted = "https://mastodon.example/users/bob/statuses/deleted";
    expect(await t.post(bob, create(bob, mastodonNote(bob, { id: deleted })))).toBe(202);
    expect(await t.post(bob, received)).toBe(202);
    expect((await statusRow(t.store, deleted)) !== undefined).toBe(stays);
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
  ])(
    "a Note, its sensitive %s, is ignored (rule 5), where Mastodon shows it sensitive %s",
    async (variant, sensitive) => {
      const { t, bob, status } = await world();
      const name = `Note, its sensitive ${variant}`;
      const received = body(name, status);
      expect(await t.post(bob, received)).toBe(202);
      expect(await statusRow(t.store, (received.object as Json).id as string)).toBeUndefined();
      expect(applied(name).effect.statuses).toMatchObject([{ sensitive }]);
    },
  );

  // A list, an empty array typed @id and a float 0 typed @id: Mastodon's compaction writes a @list object, an empty
  // array and 0.0 under the name, each of which its boolean column takes as true (sensitive-shapes.json). The body is
  // posted as its text, which keeps the float. Its definition of sensitive is no sender's, so rule (5) refuses it; the
  // layer under it marks each (the sweep above).
  it.each(["a list, given false", "typed @id, given []", "typed @id, given 0.0"])(
    "a Note, its sensitive %s, is ignored (rule 5), where Mastodon shows it sensitive",
    async (name) => {
      const index = sensitiveShapes().findIndex((shape) => shape.name === name);
      expect(sensitiveShapesFixture.sensitive[index]).toBe("t");
      const { t, bob } = await world();
      const shape = sensitiveShapes()[index]!;
      const received = sensitiveShapeBody(shape);
      expect(await t.post(bob, sensitiveShapeText(shape))).toBe(202);
      expect(await statusRow(t.store, (received.object as Json).id as string)).toBeUndefined();
    },
  );

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

  // Under the data-integrity context, with a proof that keeps nothing (a @language beside a null member, beside a
  // keyword of contexts, or beside a name with a line shaped like a keyword the body's context defines, each of which
  // Mastodon compacts: LANGUAGE_PROOFS, KEYWORD_PROOFS, edge-shapes.json), the atomUri is still read as the compaction
  // names it, or the body refused (rule 5).
  it.each([
    ["a null member", () => proofShapeBody(LANGUAGE_PROOFS[0]!)],
    ["@version", () => proofShapeBody(KEYWORD_PROOFS[0]!)],
    ['"x\\n@abc", defined in the body\'s context', () => edge('"x\\n@abc" defined, beside a @language').body],
  ] as [string, () => Json][])(
    "a Delete by an atomUri left undefined, with a proof of a @language beside %s: the status stays, as in Mastodon",
    async (_, source) => {
      const { t, bob, status } = await world();
      const deleted = "https://mastodon.example/users/bob/statuses/deleted";
      expect(await t.post(bob, create(bob, mastodonNote(bob, { id: deleted, atomUri: deleted })))).toBe(202);
      const { "@context": context, proof } = source();
      const received = { ...body("Delete by an atomUri left undefined", status), "@context": context, proof };
      expect(await t.post(bob, received)).toBe(202);
      expect(await statusRow(t.store, deleted)).toBeDefined();
    },
  );

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

  it("a status whose mention is typed as:Mention is ignored (rule 5), where Mastodon's reading mentions", async () => {
    const { t, bob, status } = await world();
    const received = body("Mention type as an IRI", status);
    expect(await t.post(bob, received)).toBe(202);
    expect(await statusRow(t.store, (received.object as Json).id as string)).toBeUndefined();
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

// Rule (5): an LD-signed body outside what real senders write is refused (ldSignedBodyReadable), before the second
// layer reads it: a key with a control character or a line break, a key that starts with @ but a keyword of JSON-LD
// 1.1, an inline definition neither Mastodon nor Fedify writes, a type that is neither a plain term nor an absolute IRI,
// or a proof other than Fedify's (a @context and names given strings). Such a body applies nothing, where Mastodon may
// apply it (docs/mastodon-deviations.md lists the forms).
describe("rule (5): an LD-signed activity outside what real senders write is ignored", () => {
  const LD_CONTEXT = { ok: false, reason: "ld-context" };

  it("reads every LD-signed body of the corpus: Mastodon 4.6.11's and 4.7.5's, and Fedify 2.4.5's", () => {
    for (const entry of corpus) {
      expect(ldSignedBodyReadable(entry.received), `${entry.sender} ${entry.name}`).toBe(true);
    }
  });

  // The forms rules (1-4) read that rule (5) refuses, by what it refuses, and whether Mastodon's reading applies
  // anything (Kopje's reader accepts it): every other form it reads as they do.
  const REFUSED: Record<string, string[]> = {
    "a type given as a compact IRI": [
      "type as a compact IRI",
      "Undo object type as an IRI",
      "Accept object type as an IRI",
      "Note type as an IRI",
      "Mention type as an IRI",
      "Reject of an accepted follow, its object's type as:Follow",
      "Reject typed as:Reject, of an accepted follow",
      "Undo typed as:Undo",
      "Block typed as:Block, by an accepted follow's target",
      "Delete typed as:Delete",
      ...[
        "",
        ", past the value limit as received",
        ", past the value limit once compacted",
        ", with a proof in the data-integrity context",
        ", with a type that is not a string",
        ", with a language map member that is not a string",
        ", with an IRI over a prefix only full_context defines",
        ", with an array in an array",
        ", under an inline context",
        ", with @graph in its signature",
        ", with a null id",
        ", with a null type",
        ", with a null in a type array",
        ", with a type over the toot prefix",
        ", with a type over the schema prefix",
        ", with a proof typed by a number",
        ", with a proof of a number tagged with a language",
        ", with a proof whose id is null",
        ", under the ActivityStreams context repeated past the value limit",
        ", with numbers as list members past the value limit once compacted",
        ", with IRIs as lists past the value limit once compacted",
        ", with a proof of plain names",
        ", with a number where an IRI is expected",
        ", with a null type in a language map array",
        ", with a null id in a language map array",
        ", with a type naming id",
        ", with a type naming type",
        ", with a language map tagged id and type",
      ].map((variant) => `Undo of a block, both typed as IRIs${variant}`),
    ],
    "an inline definition neither Mastodon nor Fedify writes": [
      "quoteUrl defined",
      "Misskey's context",
      "a name outside the vocabulary with a key of its own",
      "an inline prefix named https",
      "Note, its sensitive typed @id, given an IRI",
      "Note, its sensitive typed @id, given false",
      "Note, its sensitive typed as a boolean, given false",
      "Undo of a block, both typed as absolute IRIs, under an inline definition no sender writes",
    ],
    "a proof other than Fedify's": [
      "a proof in the data-integrity context",
      "QuoteRequest, its type left undefined, with a proof of a null value",
      "QuoteRequest, its type left undefined, with a proof of a language alone",
      "QuoteRequest, its type left undefined, with a proof of an empty set",
      "QuoteRequest, its type left undefined, with a proof of an array of a null value",
      "Undo of a block, both typed as absolute IRIs, with a proof whose @id is over a prefix only full_context defines",
    ],
  };

  it("refuses these forms, which the rules under it read, and reads every other as they do", async () => {
    const refused: string[] = [];
    const applies: string[] = [];
    for (const entry of forms.values()) {
      if (typeof entry.received.signature !== "object") {
        continue;
      }
      const all = await kopje(entry);
      if (
        JSON.stringify(all) === JSON.stringify(LD_CONTEXT) &&
        JSON.stringify(await layered(entry)) !== JSON.stringify(LD_CONTEXT)
      ) {
        refused.push(entry.name);
        if ((await mastodon(entry)).ok) {
          applies.push(entry.name);
        }
      } else {
        expect(all, entry.name).toEqual(await layered(entry));
      }
    }
    expect(refused.toSorted()).toEqual(Object.values(REFUSED).flat().toSorted());
    // Of those, the ones Mastodon's reading applies anything of, where Kopje now applies nothing (reads less).
    expect(applies).toEqual([
      "type as a compact IRI",
      "Undo object type as an IRI",
      "Accept object type as an IRI",
      "Note type as an IRI",
      "Mention type as an IRI",
      "a proof in the data-integrity context",
      "quoteUrl defined",
      "Misskey's context",
      "a name outside the vocabulary with a key of its own",
      "an inline prefix named https",
      "Reject of an accepted follow, its object's type as:Follow",
      "Reject typed as:Reject, of an accepted follow",
      "Undo typed as:Undo",
      "Block typed as:Block, by an accepted follow's target",
      "Delete typed as:Delete",
      "Undo of a block, both typed as IRIs",
      "Undo of a block, both typed as IRIs, with an array in an array",
      "Undo of a block, both typed as IRIs, under an inline context",
      "Undo of a block, both typed as IRIs, with a proof of plain names",
      "Undo of a block, both typed as IRIs, with a number where an IRI is expected",
      "Undo of a block, both typed as IRIs, with a type naming id",
      "Undo of a block, both typed as IRIs, with a type naming type",
      "Undo of a block, both typed as IRIs, with a language map tagged id and type",
      "Note, its sensitive typed @id, given an IRI",
      "Note, its sensitive typed @id, given false",
      "Note, its sensitive typed as a boolean, given false",
    ]);
  });

  // A body Mastodon 4.7.5 itself wrote (corpus.json), changed by one form of each: each refused by rule (5) alone.
  const note = () =>
    structuredClone(corpus.find((e) => e.sender === "mastodon-4.7.5" && e.name === "Create(Note) plain")!.received);
  const object = (body: Json) => body.object as Json;
  it.each([
    ["a key with a control character", (body: Json) => void (object(body)["tab\tname"] = "x")],
    ["a key with a line break", (body: Json) => void (object(body)["x y"] = "x")],
    [
      "a key in the signature that starts with @ but is no keyword",
      (body: Json) => void ((body.signature as Json)["@foo"] = "x"),
    ],
    [
      "an inline definition Misskey writes (featured untyped)",
      (body: Json) => void (body["@context"] as unknown[]).push({ featured: "toot:featured" }),
    ],
    ["a type given as a compact IRI", (body: Json) => void (object(body).type = "as:Note")],
    ["a type shaped like a keyword", (body: Json) => void (object(body).type = "@foo")],
    ["a type with a space", (body: Json) => void (object(body).type = "Note ")],
    [
      "a proof with a member that is not a string",
      (body: Json) => {
        (body["@context"] as unknown[]).push("https://w3id.org/security/data-integrity/v1");
        body.proof = { type: "DataIntegrityProof", cryptosuite: "eddsa-jcs-2022", proofValue: "z", foo: { bar: "x" } };
      },
    ],
  ] as [string, (body: Json) => void][])("refuses %s, which the rules under it read", (_, change) => {
    const body = note();
    expect(ldSignedBodyReadable(body)).toBe(true);
    change(body);
    expect(ldSignedBodyReadable(body)).toBe(false);
    expect(ldSignedBodyReadable(body, SECOND_LAYER)).toBe(true);
  });

  // The names Mastodon's actor serializer defines inline (actor_serializer.rb's context_extensions, and those of the
  // tag, emoji and image it nests), as each release's map defines them (context-maps.json): 3.5.0 to 4.2.29 name the
  // olm extension, so that each of their LD-signed Update(Person) defines its names (MASTODON_OLM_TERMS).
  const ACTOR_EXTENSIONS = [
    "manuallyApprovesFollowers",
    "toot",
    "featured",
    "featuredTags",
    "alsoKnownAs",
    "movedTo",
    "schema",
    "PropertyValue",
    "value",
    "discoverable",
    ...Object.keys(MASTODON_OLM_TERMS),
    "suspended",
    "memorial",
    "indexable",
    "Hashtag",
    "Emoji",
    "focalPoint",
  ];
  it.each(
    contextMaps.map(({ releases, definitions }) => [releases.join(" to "), definitions as Record<string, unknown[]>]),
  )("applies Mastodon %s's LD-signed Update(Person) through the inbox", async (_, definitions) => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await followed(t, bob);
    const extension = Object.fromEntries(
      ACTOR_EXTENSIONS.filter((name) => Object.hasOwn(definitions, name)).map((name) => [name, definitions[name]![0]]),
    );
    const { "@context": _context, ...document } = bob.document as Json;
    const update = {
      "@context": [AS, "https://w3id.org/security/v1", extension],
      id: `${bob.uri}#updates/1`,
      type: "Update",
      actor: bob.uri,
      to: [PUBLIC],
      object: { ...document, name: "Bob renamed", devices: `${bob.uri}/collections/devices` },
      signature: { type: "RsaSignature2017", creator: `${bob.uri}#main-key`, signatureValue: "placeholder" },
    };
    expect(ldSignedBodyReadable(update)).toBe(true);
    expect(await t.post(bob, update)).toBe(202);
    expect(await sql(t.store, "SELECT display_name FROM accounts WHERE uri = ?", bob.uri)).toEqual([
      { display_name: "Bob renamed" },
    ]);
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
      async (name) => {
        const entry = form(name);
        expect(await kopje(entry)).toEqual(LD_CONTEXT);
        // Literally public; Mastodon reads it addressed to https://other.example/Public, a direct status.
        expect(statusOf(await literal(entry))).toMatchObject({ to: [PUBLIC] });
        expect(statusOf(await mastodon(entry))).toMatchObject({ to: ["https://other.example/Public"] });
        expect(applied(name).effect.statuses).toMatchObject([{ visibility: "direct" }]);
      },
    );

    it("ignores an LD-signed activity that aliases a keyword or a member beside the literal one", async () => {
      const twoTypes = ["a keyword alias beside the literal type", "@type beside type"];
      for (const name of twoTypes) {
        expect(await kopje(form(name)), name).toEqual(LD_CONTEXT);
        expect(accepted(await literal(form(name))), name).toMatchObject({ type: "Like" });
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
        expect(await kopje(form(name)), name).toEqual(LD_CONTEXT);
        expect(accepted(await literal(form(name))).object, name).toEqual(expect.any(String));
        expect(mastodonReading(form(name)).object, name).toHaveLength(2);
        expect(await mastodon(form(name)), name).toEqual({ ok: false, reason: "unsupported" });
      }
      const aliasedTo = form("an alias of to with to redefined");
      expect(await kopje(aliasedTo)).toEqual(LD_CONTEXT);
      expect(statusOf(await literal(aliasedTo))).toMatchObject({ to: [PUBLIC] });
      expect(statusOf(await mastodon(aliasedTo))).toMatchObject({
        to: ["https://mastodon.example/users/bob/followers"],
      });
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
    ])("ignores an LD-signed activity whose context changes a name's meaning: %s", async (name, renamed) => {
      expect(await kopje(form(name))).toEqual(LD_CONTEXT);
      expect((await literal(form(name))).ok).toBe(true);
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
      "@id in an Accept's result",
      "a redefined as",
      "a prefix naming the ActivityStreams namespace",
      "a prefix chain",
      "@vocab set",
      "@language set",
      "@propagate before ActivityStreams",
      "identity/v1 after ActivityStreams",
      "a context in a proof of the object",
    ])("ignores %s", async (name) => {
      expect(await kopje(form(name))).toEqual(LD_CONTEXT);
      expect((await mastodon(form(name))).ok).toBe(true);
    });

    // #1717: a retraction's object given as {"@id": …} is read as its IRI, as Mastodon reads it, where Kopje shows the
    // compaction succeeds; a Follow's still is not (above).
    it("reads @id in an Undo's object as Mastodon does", async () => {
      expect(await kopje(form("@id in an Undo's object"))).toMatchObject({ ok: true, activity: { type: "Undo" } });
      expect(await kopje(form("@id in an Undo's object"))).toEqual(await mastodon(form("@id in an Undo's object")));
    });

    it.each([
      "@graph in the body",
      "@included in the body",
      "@reverse in the body",
      "an unknown context URL",
      "a nested context array",
    ])("ignores %s, which Mastodon reads as received", async (name) => {
      expect(await kopje(form(name))).toEqual(LD_CONTEXT);
      expect(form(name).fallback).toEqual(
        expect.stringMatching(/^(Mastodon::InvalidJsonLdError|JSON::LD::JsonLdError)/),
      );
    });
  });

  describe("reads an LD-signed activity in a real sender's vocabulary", () => {
    it.each([
      "Mastodon 4.4 and 4.5's forwarded context",
      "Mastodon 4.6's forwarded context",
      "Mastodon 4.7's forwarded context",
    ])("%s", async (name) => {
      expect(ldSignedBodyReadable(form(name).received)).toBe(true);
      expect(await kopje(form(name))).toEqual(await mastodon(form(name)));
    });

    // Inline definitions neither Mastodon nor Fedify writes (Misskey's: Key, featured untyped, its _misskey_ names,
    // freeText and vcard), which rule (5) refuses; the rules under it read each as Mastodon does.
    it.each([
      "Misskey's context",
      "a name outside the vocabulary with a key of its own",
      "an inline prefix named https",
    ])("refuses %s, which the rules under rule (5) read as Mastodon does", async (name) => {
      expect(ldSignedBodyReadable(form(name).received)).toBe(false);
      expect(await kopje(form(name))).toEqual(LD_CONTEXT);
      expect(await layered(form(name))).toEqual(await mastodon(form(name)));
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
  ])("reads an unsigned activity with any context, as Mastodon: %s", async (name) => {
    const entry = form(name);
    expect(entry.received.signature).toBeUndefined();
    expect((await kopje(entry)).ok).toBe(true);
    expect(await kopje(entry)).toEqual(await mastodon(entry));
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

    // Every context URL a body may name and, in one inline object, every definition Mastodon and Fedify write, then
    // plain keys to the node bound: the most of a context rule (5) reads in one object.
    const urls = (position: string) => [...SIGNED_CONTEXT_URLS].filter(([, at]) => at === position).map(([url]) => url);
    const ANYWHERE = urls("anywhere");
    const SENDER_CONTEXT = [
      ...urls("before-activitystreams"),
      AS,
      ...ANYWHERE,
      Object.fromEntries(
        Object.entries({ ...FEDIFY_CONTEXT_TERMS, ...MASTODON_OLM_TERMS, ...MASTODON_CONTEXT_TERMS }).map(
          ([name, written]) => [name, written.at(-1)],
        ),
      ),
    ];
    const names = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${i}`, `v${i}`]));
    const senderDefinitions = (count: number) => activity(SENDER_CONTEXT, { wide: names(count) });
    // Rule (5) reads no context URL twice, but an inline object as often as the node bound leaves: every definition
    // real senders write, again and again after every URL once, in the body's context, and in each of four proofs
    // (MAX_PROOFS), whose contexts are read before any is counted against PROOF_CONTEXT_LIMIT.
    const repeated = (count: number) => Array.from({ length: count }, () => SENDER_CONTEXT.at(-1));
    const repeatedDefinitions = (count: number) => activity([AS, ...ANYWHERE, ...repeated(count)], {});
    const fourProofs = (count: number) =>
      activity([AS, "https://w3id.org/security/v1", "https://w3id.org/security/data-integrity/v2"], {
        proof: Array.from({ length: 4 }, () => ({
          "@context": [...urls("before-activitystreams"), AS, ...ANYWHERE, ...repeated(count)],
          type: "DataIntegrityProof",
          proofValue: "z",
        })),
      });
    // What rule (5) refuses before any context is read: a context URL repeated, in the body's context or a proof's, and
    // more proofs than MAX_PROOFS.
    const repeatedUrl = (count: number) =>
      activity(
        Array.from({ length: count + 1 }, () => AS),
        {},
      );
    const proofRepeatingUrl = (count: number) =>
      activity([AS], {
        proof: { "@context": Array.from({ length: count + 1 }, () => AS), type: "DataIntegrityProof" },
      });
    const proofsRepeatingUrl = (count: number) =>
      activity([AS], {
        proof: Array.from({ length: count }, () => ({ "@context": Array.from({ length: 20 }, () => AS) })),
      });
    const manyProofs = (count: number) =>
      activity([AS], { proof: Array.from({ length: count }, () => ({ "@context": AS, type: "DataIntegrityProof" })) });

    it("the depth witness nests exactly MAX_JSON_DEPTH levels", () => {
      expect(depthOf(filled(deep))).toBe(MAX_JSON_DEPTH);
    });

    it.each([
      ["plain keys at the depth bound", deep, {}],
      ["every definition real senders write", senderDefinitions, {}],
      ["every definition real senders write, in inline objects to the node bound", repeatedDefinitions, {}],
      ["four proofs, each under every context URL and every definition real senders write", fourProofs, {}],
      // Rules (1, 2) read these, and rule (5) refuses their definitions.
      ["inline definitions", definitions, SECOND_LAYER],
      ["ActivityStreams' own definitions", terms, SECOND_LAYER],
    ] as [string, (count: number) => Json, Rules][])("%s", async (_, build, rules) => {
      const body = filled(build);
      // The body passes the check (the slow path: every value visited), so only the signature refuses it.
      expect(ldSignedBodyReadable(body, rules)).toBe(true);
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

    it.each([
      ["the ActivityStreams URL repeated in the body's context", repeatedUrl],
      ["the ActivityStreams URL repeated in a proof's context", proofRepeatingUrl],
      ["proofs each repeating the ActivityStreams URL in its context", proofsRepeatingUrl],
      ["more proofs than MAX_PROOFS", manyProofs],
    ])("refuses %s, to the node bound, before reading a context", async (_, build) => {
      const body = filled(build);
      expect(ldSignedBodyReadable(body)).toBe(false);
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

    // Values as Mastodon's JSON-LD limits count them (each object, array and scalar): past 1,000 it reads a body as
    // received, and Kopje expands no proof, so a proof is expanded only within them.
    const values = (value: unknown): number =>
      1 +
      (typeof value === "object" && value !== null
        ? Object.values(value).reduce<number>((sum, member) => sum + values(member), 0)
        : 0);
    // The largest `count` for which build(count) has at most 1,000 values, and that body.
    function filledToValues(build: (count: number) => Json): Json {
      let low = 0;
      let high = 1_000;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (values(build(middle)) <= 1_000) {
          low = middle;
        } else {
          high = middle - 1;
        }
      }
      return build(low);
    }
    const dataIntegrity = (proof: Json, context: unknown[] = []) =>
      activity(
        [
          "https://www.w3.org/ns/activitystreams",
          "https://w3id.org/security/v1",
          "https://w3id.org/security/data-integrity/v2",
          ...context,
        ],
        { proof },
      );
    // Nodes nested `depth` deep, each with a type whose context applies in it, the innermost holding plain names: 28
    // are as many as a body and its proof may give (the body's three contexts and its type take four of 32,
    // PROOF_CONTEXT_LIMIT).
    const typedNodes = (depth: number, count: number) => {
      let proof: Json = { type: "DataIntegrityProof", ...names(count) };
      for (let level = 1; level < depth; level++) {
        proof = { type: "DataIntegrityProof", next: proof };
      }
      return dataIntegrity(proof);
    };
    // The other paths by which a context applies in a proof: a key whose definition has a context (property-scoped:
    // `service` under cid/v1, which the proof names and which takes one more of 32, and the data-integrity contexts'
    // DataIntegrityProof), `depth` deep around plain names, and nodes with a context in an array under a language
    // map's name (its items are values and nodes, not a language map), the last holding plain names.
    const wrapped = (depth: number, count: number, wrap: (inner: Json) => Json, outer: Json = {}) => {
      let proof: Json = names(count);
      for (let level = 0; level < depth; level++) {
        proof = wrap(proof);
      }
      return dataIntegrity({ ...outer, ...proof });
    };
    const serviceKeys = (depth: number, count: number) =>
      wrapped(depth, count, (inner) => ({ service: inner }), { "@context": "https://www.w3.org/ns/cid/v1" });
    const dataIntegrityKeys = (depth: number, count: number) =>
      wrapped(depth, count, (inner) => ({ DataIntegrityProof: inner }));
    // proofPurpose, defined with a context of its own in DataIntegrityProof's: two of 32 for each typed node.
    const proofPurposes = (depth: number, count: number) =>
      wrapped(depth, count, (inner) => ({ type: "DataIntegrityProof", proofPurpose: inner }));
    const languageMapNodes = (nodes: number, count: number) =>
      dataIntegrity({
        contentMap: Array.from({ length: nodes }, (_, i) => ({
          "@context": "https://w3id.org/security/data-integrity/v2",
          ...(i === nodes - 1 ? names(count) : {}),
        })),
      });
    // Objects in an array under a key in a typed node: under a key whose definition has a context, which applies to
    // each value, each reverting the type's context first, each takes one of 32; under a plain name none does, and
    // jsonld.js still processes the type's context again in each.
    const objectsUnder = (key: string, objects: number, outer: Json = {}) =>
      dataIntegrity({ ...outer, type: "DataIntegrityProof", [key]: Array.from({ length: objects }, () => ({})) });
    const CID = { "@context": "https://www.w3.org/ns/cid/v1" };

    // The layer under rule (5), which reads a proof only as Fedify writes one and so refuses each of these: a proof
    // within PROOF_CONTEXT_LIMIT is expanded, one past it not, and the body is read as named.
    it.each([
      ["typed nodes", typedNodes(29, 1)],
      ["`service` keys", serviceKeys(28, 1)],
      ["DataIntegrityProof keys", dataIntegrityKeys(29, 1)],
      ["typed nodes with proofPurpose keys", proofPurposes(15, 1)],
      ["nodes with a context under a language map's name", languageMapNodes(29, 1)],
      ["objects in an array under a DataIntegrityProof key", objectsUnder("DataIntegrityProof", 28)],
      ["objects in an array under a proofPurpose key", objectsUnder("proofPurpose", 28)],
      ["objects in an array under a `service` key", objectsUnder("service", 27, CID)],
    ] as [string, Json][])(
      "a proof of %s past PROOF_CONTEXT_LIMIT is not expanded, and the body is read as named",
      async (_, body) => {
        expect(withinJsonBounds(body)).toBe(true);
        expect(ldSignedBodyReadable(body)).toBe(false);
        const reading = await ldSignedReading(body, SECOND_LAYER);
        expect(reading?.body).not.toBe(body);
        expect(reading?.body.proof).toBe(body.proof);
      },
    );

    it.each([
      ["typed nodes", (count: number) => typedNodes(28, count)],
      ["`service` keys", (count: number) => serviceKeys(27, count)],
      ["DataIntegrityProof keys", (count: number) => dataIntegrityKeys(28, count)],
      ["typed nodes with proofPurpose keys", (count: number) => proofPurposes(14, count)],
      ["nodes under a language map's name", (count: number) => languageMapNodes(28, count)],
      ["objects in an array under a DataIntegrityProof key", () => objectsUnder("DataIntegrityProof", 27)],
      ["objects in an array under a `service` key", () => objectsUnder("service", 26, CID)],
      ["objects in a typed node's array under a plain name", (count: number) => objectsUnder("k", count)],
    ])("a proof of %s, as many as its contexts and Mastodon's values allow, is expanded in time", async (_, build) => {
      const body = filledToValues(build);
      expect(withinJsonBounds(body)).toBe(true);
      expect(ldSignedBodyReadable(body)).toBe(false);
      const started = performance.now();
      const reading = await ldSignedReading(body, SECOND_LAYER);
      const elapsed = performance.now() - started;
      // The proof is expanded and keeps something, so the body is read as received.
      expect(reading?.body).toBe(body);
      expect(elapsed).toBeLessThan(GENEROUS_MS);
    });

    // Proofs as Fedify writes them, which rule (5) reads, filled to Mastodon's values: of plain names given strings,
    // and under every context URL a body may name and every definition real senders write, with as many contexts as
    // PROOF_CONTEXT_LIMIT leaves. jsonld.js fetches at most 11 context URLs for one @context (each once an expansion),
    // and data-integrity/v1 redefines terms v2 protects: past either the expansion raises, and the body is read as
    // named. So the body names ten URLs after ActivityStreams, and the proof every one but data-integrity/v1 and then
    // every definition real senders write, again, to the limit (no URL twice). Each is expanded.
    const proofOfNames = (count: number) => dataIntegrity({ type: "DataIntegrityProof", ...names(count) });
    const EXPANDABLE = ANYWHERE.filter((url) => url !== "https://w3id.org/security/data-integrity/v1");
    const proofUnderEveryContext = (count: number) => {
      const context = [AS, ...EXPANDABLE.slice(0, 10), SENDER_CONTEXT.at(-1)];
      const proofContext = [...urls("before-activitystreams"), AS, ...EXPANDABLE];
      // 32, less the body's contexts and type and the proof's type.
      const left = 32 - context.length - 2;
      return activity(context, {
        proof: {
          "@context": [...proofContext, ...repeated(left - proofContext.length)],
          type: "DataIntegrityProof",
          ...names(count),
        },
      });
    };

    it.each([
      ["a proof of plain names", proofOfNames],
      ["a proof under every context its body and it may name", proofUnderEveryContext],
    ])("a data-integrity proof expanded within Mastodon's values: %s", async (_, build) => {
      const body = filledToValues(build);
      expect(withinJsonBounds(body)).toBe(true);
      expect(ldSignedBodyReadable(body)).toBe(true);
      // The proof is expanded and keeps something, so the body is read as received.
      expect((await ldSignedReading(body))?.body).toBe(body);
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

// #1717: an LD-signed retraction in a form Mastodon 4.7.5 applies, read as its compaction writes it where Kopje shows
// the compaction succeeds (ld-signed-body.ts RETRACTIONS), beside what Mastodon's ProcessActivityService handed on
// (retractions.json), and through the inbox: the relationship Mastodon's handler ends, the reading that ends with it,
// and every other relationship left.
describe("#1717: LD-signed retractions in the forms Mastodon compacts", () => {
  const BOB = "https://mastodon.example/users/bob";
  type Handled = Json | null;
  type Captured = { name: string; reading?: Record<string, string | null>; error?: string; relayed?: boolean };
  const captured = new Map((retractionsFixture.readings as Captured[]).map((entry) => [entry.name, entry]));

  // What Mastodon's handler reads of an entry (delete.rb, block.rb, undo.rb, reject.rb), or null where it applies
  // nothing: its inbox answered 500 before the service ran, its job raised, it took the body as relayed (a placeholder
  // signature verifies nothing), it handed nothing on, the object it handed on has no IRI (value_or_id of {"@id": …} as
  // received), which each handler seeks nothing by, or it undoes a Follow, a Block or a Like that names no object, which
  // undo.rb seeks what to end by (target_uri) and returns without. retractions.rb runs the service alone, so the
  // inbox's check is the one here: inboxes_controller.rb unknown_affected_account? reads a Delete's or an Update's
  // object with value_or_id when it has an actor, which raises on an array and answers 500, each time it is sent again.
  const UNDONE_BY_TARGET = new Set(["Follow", "Block", "Like"]);
  function mastodonHandles(name: string, body: Json): Handled {
    const entry = captured.get(name);
    expect(entry, name).toBeDefined();
    const reading = entry!.reading;
    const actor = body.actor;
    const present = Array.isArray(actor) ? actor.length > 0 : typeof actor === "string" && actor.trim() !== "";
    if ((body.type === "Delete" || body.type === "Update") && present && Array.isArray(body.object)) {
      return null;
    }
    if (reading === undefined || reading.object === null) {
      return null;
    }
    if (reading.type === "Undo" && UNDONE_BY_TARGET.has(reading.object_type ?? "") && reading.object_object === null) {
      return null;
    }
    const { type, object } = reading;
    return type === "Undo" || type === "Reject"
      ? {
          type,
          object,
          objectType: reading.object_type ?? null,
          objectActor: reading.object_actor ?? null,
          objectObject: reading.object_object ?? null,
        }
      : { type, object };
  }

  // The same of Kopje's reading of a body bob sends: null where it ignores the body, reads another actor (a relay,
  // which applies none of these forms; LR-g), or reads an Undo or a Reject that names no object, which its handlers
  // ignore (domain/inbox.ts undo, reject).
  async function kopjeHandles(body: Json): Promise<Handled> {
    const parsed = await parseActivity(bytes(body));
    if (!parsed.ok || parsed.actor !== BOB) {
      return null;
    }
    const activity = parsed.activity as Json;
    if (activity.type === "Undo" || activity.type === "Reject") {
      const ref = activity.object as Json;
      if (ref.id === null) {
        return null;
      }
      return {
        type: activity.type,
        object: ref.id,
        objectType: ref.type,
        objectActor: ref.actor,
        objectObject: ref.object,
      };
    }
    return activity.type === "DeleteActor"
      ? { type: "Delete", object: parsed.actor }
      : { type: activity.type, object: typeof activity.object === "string" ? activity.object : null };
  }

  // The controls Mastodon applies and Kopje does not (it reads less, docs/mastodon-deviations.md): an actor of [null],
  // which Mastodon's compaction writes as [] (no actor, so not a relay) and applies as the signer's; a Delete's object
  // of {"@id": …} beside its type, and one under a name not typed @id, which rule (3) refuses; one of an IRI the
  // compaction writes as a compact IRI (as:Public); one in a body of more values than Kopje shows the compaction keeps
  // within Mastodon's 1,000 (its estimate of three for each); an object after the patch's stop in an object holding a
  // key shaped like an array index, whose order Kopje cannot tell from Ruby's; a Create, which keeps the reading as
  // received; and the bodies rules (3) and (5) refuse whatever the forms read.
  // What the forms change of the readings of the fixtures' bodies (LR-f): the retractions in them, and the one of
  // forms.json, each a retraction (carol's actor is a relay's, which applies none; an object array reads nothing).
  const CHANGED = [
    "@id in an Undo's object",
    ...FORM_4.filter((name) => !FORM_4_AS_GIVEN.includes(name) && form(name).fallback === undefined),
    ...Object.keys(FORMS).flatMap((form) => Object.keys(RETRACTIONS).map((name) => `${name}, ${form}`)),
    "Delete(status), actor as an array of carol",
    "Delete(status), actor as an array of bob's node",
    'Delete(status), object as an array of {"@id": its id}',
    'Delete(status), object and 10 IRIs in cc as {"@id": …}',
    "Undo(Follow) typed as absolute IRIs, actor as a one-element array",
    "Delete(status), object as a one-element array after to of carol twice and null",
    "Undo(Follow), its Follow's actor and object as one-element arrays after to: [null]",
    'Undo(Follow), its Follow\'s object as {"@id": its id}',
    'Delete(status), object as {"@id": its id}, source holding url as {"@id": …}',
  ];

  const READS_LESS = [
    "Delete(status), actor as an array of null",
    'Delete(status), object as {"@id": its id}, content as {"@id": an IRI}',
    'Delete(status), object as {"@id": its id}, to as [{"@id": the public collection}]',
    'Delete(status), object as {"@id": its id}, under a context that leaves object untyped',
    'Delete(status), object and 493 IRIs in cc as {"@id": …}',
    "Create, actor as a one-element array",
    'Undo(Follow), object as a one-element array after to: [null], beside a key "0"',
    'Create, object as {"@id": its id}',
    "Undo(Follow), its Follow typed by @type",
    "Undo(Follow) typed as a compact IRI",
    "Undo(Follow) under a definition no sender writes",
    'Delete(status), object as {"@id": its id} with its type',
  ];
  // What Kopje applies and Mastodon does not (docs/mastodon-deviations.md): the signer's own Delete whose object is an
  // array after a certain stop of the patch, which Mastodon's inbox answers 500 before reading.
  const READS_MORE = [
    "Delete(status), object as a one-element array after to: [null]",
    "Delete(actor), object as a one-element array after to: [null]",
    "Delete(status), object as a one-element array after to of carol twice and null",
  ];

  it("reads each retraction as Mastodon reads it, but where it reads less or Mastodon's inbox refuses it", async () => {
    const entries = retractionEntries();
    expect(retractionsFixture.reference).toBe("mastodon-4.7.5");
    expect([...captured.keys()]).toEqual(entries.map((entry) => entry.name));
    for (const entry of entries) {
      if (
        Object.keys(RETRACTIONS).some((name) => Object.keys(FORMS).some((form) => entry.name === `${name}, ${form}`))
      ) {
        expect(mastodonHandles(entry.name, entry.body) !== null || READS_MORE.includes(entry.name), entry.name).toBe(
          true,
        );
      }
    }
    const less: string[] = [];
    const more: string[] = [];
    for (const entry of entries) {
      const ours = await kopjeHandles(entry.body);
      const theirs = mastodonHandles(entry.name, entry.body);
      if (ours === null && theirs !== null) {
        less.push(entry.name);
      } else if (ours !== null && theirs === null) {
        more.push(entry.name);
      } else {
        expect(ours, entry.name).toEqual(theirs);
      }
    }
    expect(less).toEqual(READS_LESS);
    expect(more).toEqual(READS_MORE);
  });

  // LR-f (1): the forms change the reading of no other body (D4). Over every LD-signed body of the fixtures, the
  // reading with them and without them (the reading before #1717) differ only for the retractions below, the bodies
  // they were added for; and every other activity's object is the received body's, so that parseActivity, which takes
  // the object from the body read, takes every other activity's as it took it before.
  it("change the reading of no other body of the fixtures", async () => {
    const signed = (body: unknown) => typeof (body as Json).signature === "object" && (body as Json).signature !== null;
    const bodies = [
      ...corpus.map((entry) => [entry.name, entry.received] as const),
      ...[...forms.values()].map((entry) => [entry.name, entry.received] as const),
      ...edgeShapes().map((shape) => [shape.name, shape.body as Json] as const),
      ...proofShapes().map((shape) => [JSON.stringify(shape), proofShapeBody(shape) as Json] as const),
      ...sensitiveShapes().map((shape) => [JSON.stringify(shape), sensitiveShapeBody(shape) as Json] as const),
      ...retractionEntries().map((entry) => [entry.name, entry.body] as const),
    ].filter(([, body]) => signed(body));
    const idOf = (value: unknown) =>
      typeof value === "string" ? value : typeof value === "object" && value !== null ? (value as Json).id : undefined;
    const readingOf = async (body: Json, rules: Rules) => {
      const reading = await ldSignedReading(body, rules);
      const typeOf = (value: unknown) => (typeof value === "string" ? reading!.readType(value) : value);
      const object = body.object as Json | undefined;
      return reading === null
        ? null
        : { body: reading.body, type: typeOf(body.type), objectType: typeOf(object?.type) };
    };
    const retractions = new Set(["Reject", "Undo", "Block", "Delete"]);
    const changed: string[] = [];
    for (const [name, body] of bodies) {
      const before = await readingOf(body, { retractions: false });
      const after = await readingOf(body, {});
      if (JSON.stringify(after) !== JSON.stringify(before)) {
        changed.push(name);
      }
      if (after !== null && !retractions.has(after.type as string)) {
        expect(idOf(after.body.object), name).toEqual(idOf(body.object));
      }
    }
    expect(bodies.length).toBeGreaterThan(500);
    expect(changed).toEqual(CHANGED);
  });

  describe("through the inbox", () => {
    type World = {
      t: Setup;
      bob: TestActor;
      carol: TestActor;
      bobId: string;
      carolId: string;
      status: { id: string; uri: string };
    };
    const CAROL_ORIGIN = "https://fans.example";

    // alice follows bob (mastodon.example) and carol (fans.example), each stored by a Follow of dave, and has a public
    // status.
    async function world(): Promise<World> {
      const t = await setup();
      const bob = await mastodonActor(t.web, "bob");
      const carol = await mastodonActor(t.web, "carol", { origin: CAROL_ORIGIN, key: 3 });
      const bobId = await followed(t, bob);
      const carolId = await followed(t, carol);
      const status = await localStatus(t, { status: "local", visibility: "public" });
      return { t, bob, carol, bobId, carolId, status };
    }

    const placed = (json: Json, w: World) =>
      JSON.parse(JSON.stringify(json).replaceAll("https://kopje.test/ap/o/local-1", w.status.uri)) as Json;

    const edges = async (t: Setup, from: string, to: string) =>
      sql(t.store, "SELECT state FROM follows WHERE account_id = ? AND target_account_id = ?", from, to);
    const blocksOf = async (t: Setup, from: string) =>
      sql(t.store, "SELECT target_account_id AS target FROM blocks WHERE account_id = ? ORDER BY id", from);
    const read = async (t: Setup, id: string, as: "alice" | "dave" = "alice") =>
      (await t.api(`/api/v1/statuses/${id}`, as)).status;

    // The inboxes a new followers-only status of alice's is delivered to.
    async function deliveredTo(t: Setup): Promise<string[]> {
      const posted = await localStatus(t, { status: "followers", visibility: "private" });
      await settleDeliveries(t.store);
      const rows = await sql<{ inbox_url: string }>(
        t.store,
        `SELECT DISTINCT d.inbox_url FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id
          WHERE json_extract(o.body, '$.activity.object.id') = ? ORDER BY d.inbox_url`,
        posted.uri,
      );
      return rows.map((row) => row.inbox_url);
    }

    // bob's Note, stored: public unless `extra` says otherwise.
    async function bobsNote(w: World, extra: Json = {}, actor = w.bob): Promise<string> {
      const note = mastodonNote(actor, extra);
      expect(await w.t.post(actor, create(actor, note))).toBe(202);
      return (await statusRow(w.t.store, note.id))!.id;
    }
    const FOLLOWERS = (actor: TestActor) => ({ to: [`${actor.uri}/followers`], cc: [] });
    const follow = (actor: TestActor, id: string) => ({
      "@context": AS,
      id,
      type: "Follow",
      actor: actor.uri,
      object: "https://kopje.test/ap/users/alice",
    });
    const block = (actor: TestActor, id: string) => ({ ...follow(actor, id), type: "Block" });

    // For each retraction (the effects of Mastodon's handlers, delete.rb, block.rb, undo.rb and reject.rb): the world
    // it ends something in, what is observed of it, and what the retraction leaves of that (the rest unchanged).
    type Scenario = (w: World) => Promise<{ observe: () => Promise<Json>; ended: Json }>;
    const SCENARIOS: Record<Retraction, Scenario> = {
      // bob's follow of alice: the delivery of her followers-only statuses to him ends (Kopje serves none to a remote
      // fetch, visibility.md R4); carol's follow of her, and alice's of bob, stay.
      "Undo(Follow)": async ({ t, bob, carol, bobId, carolId }) => {
        expect(await t.post(bob, follow(bob, BOB_FOLLOW))).toBe(202);
        expect(await t.post(carol, follow(carol, `${carol.uri}/follows/1`))).toBe(202);
        return {
          observe: async () => ({
            bobFollows: await edges(t, bobId, ALICE),
            carolFollows: await edges(t, carolId, ALICE),
            aliceFollowsBob: await edges(t, ALICE, bobId),
            deliveredTo: await deliveredTo(t),
          }),
          ended: { bobFollows: [], deliveredTo: [`${CAROL_ORIGIN}/inbox`] },
        };
      },
      // alice's follow of bob (OUR_FOLLOW): her reading of his followers-only status ends; dave's follow of him stays.
      "Reject(Follow)": async (w) => {
        const { t, bobId } = w;
        await sql(
          t.store,
          "UPDATE follows SET uri = ? WHERE account_id = ? AND target_account_id = ?",
          OUR_FOLLOW,
          ALICE,
          bobId,
        );
        await sql(
          t.store,
          "INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
          DAVE,
          bobId,
        );
        const id = await bobsNote(w, FOLLOWERS(w.bob));
        return {
          observe: async () => ({
            aliceFollows: await edges(t, ALICE, bobId),
            daveFollows: await edges(t, DAVE, bobId),
            aliceReads: await read(t, id),
            daveReads: await read(t, id, "dave"),
          }),
          ended: { aliceFollows: [], aliceReads: 404 },
        };
      },
      // bob's favourite of alice's status, its count and its notification; carol's stay.
      "Undo(Like)": async ({ t, bob, carol, status }) => {
        expect(await t.post(bob, like(bob, status.uri, { id: BOB_LIKE }))).toBe(202);
        expect(await t.post(carol, like(carol, status.uri))).toBe(202);
        return {
          observe: async () => ({
            count: (await t.api<Json>(`/api/v1/statuses/${status.id}`)).body.favourites_count,
            likers: await sql(t.store, "SELECT account_id FROM favourites ORDER BY account_id"),
            notified: await sql(
              t.store,
              "SELECT from_account_id FROM notifications WHERE type = 'favourite' ORDER BY from_account_id",
            ),
          }),
          ended: {
            count: 1,
            likers: [{ account_id: await accountId(t.store, carol.uri) }],
            notified: [{ from_account_id: await accountId(t.store, carol.uri) }],
          },
        };
      },
      // bob's boost of alice's status and its count; carol's stays.
      "Undo(Announce)": async ({ t, bob, carol, status }) => {
        expect(await t.post(bob, announce(bob, status.uri, { id: BOB_BOOST }))).toBe(202);
        expect(await t.post(carol, announce(carol, status.uri))).toBe(202);
        return {
          observe: async () => ({
            count: (await t.api<Json>(`/api/v1/statuses/${status.id}`)).body.reblogs_count,
            boosters: await sql(
              t.store,
              "SELECT account_id FROM statuses WHERE reblog_of_id = ? ORDER BY account_id",
              status.id,
            ),
          }),
          ended: { count: 1, boosters: [{ account_id: await accountId(t.store, carol.uri) }] },
        };
      },
      // bob blocks alice: both follows between them end, and her reading of his followers-only status; carol's
      // follows of and by alice stay.
      Block: async (w) => {
        const { t, bob, carol, bobId, carolId } = w;
        expect(await t.post(bob, follow(bob, BOB_FOLLOW))).toBe(202);
        expect(await t.post(carol, follow(carol, `${carol.uri}/follows/1`))).toBe(202);
        const id = await bobsNote(w, FOLLOWERS(bob));
        return {
          observe: async () => ({
            bobFollows: await edges(t, bobId, ALICE),
            aliceFollowsBob: await edges(t, ALICE, bobId),
            bobBlocks: await blocksOf(t, bobId),
            aliceReads: await read(t, id),
            carolFollows: await edges(t, carolId, ALICE),
            aliceFollowsCarol: await edges(t, ALICE, carolId),
          }),
          ended: { bobFollows: [], aliceFollowsBob: [], bobBlocks: [{ target: ALICE }], aliceReads: 404 },
        };
      },
      // bob's block of alice, which hides his status from her; carol's block of her stays.
      "Undo(Block)": async (w) => {
        const { t, bob, carol, bobId, carolId } = w;
        const bobs = await bobsNote(w);
        const carols = await bobsNote(w, {}, carol);
        expect(await t.post(bob, block(bob, BOB_BLOCK))).toBe(202);
        expect(await t.post(carol, block(carol, `${carol.uri}/blocks/1`))).toBe(202);
        return {
          observe: async () => ({
            bobBlocks: await blocksOf(t, bobId),
            carolBlocks: await blocksOf(t, carolId),
            aliceReadsBob: await read(t, bobs),
            aliceReadsCarol: await read(t, carols),
          }),
          ended: { bobBlocks: [], aliceReadsBob: 200 },
        };
      },
      // One of bob's statuses; his other stays.
      "Delete(status)": async (w) => {
        const deleted = await bobsNote(w, { id: BOB_STATUS, atomUri: BOB_STATUS });
        const kept = await bobsNote(w);
        return {
          observe: async () => ({ deleted: await read(w.t, deleted), kept: await read(w.t, kept) }),
          ended: { deleted: 404 },
        };
      },
      // bob's account and both his statuses, then their rows once the purge has run; carol's status and her follow of
      // alice stay.
      "Delete(actor)": async (w) => {
        const { t, carol, bobId, carolId } = w;
        const [first, second] = [await bobsNote(w), await bobsNote(w)];
        const carols = await bobsNote(w, {}, carol);
        expect(await t.post(carol, follow(carol, `${carol.uri}/follows/1`))).toBe(202);
        return {
          observe: async () => ({
            first: await read(t, first),
            second: await read(t, second),
            account: (await t.api(`/api/v1/accounts/${bobId}`)).status,
            rows: await sql(
              t.store,
              "SELECT (SELECT count(*) FROM statuses WHERE account_id = ?1) AS statuses, (SELECT count(*) FROM accounts WHERE id = ?1) AS accounts",
              bobId,
            ),
            carols: await read(t, carols),
            carolFollows: await edges(t, carolId, ALICE),
          }),
          ended: { first: 404, second: 404, account: 404, rows: [{ statuses: 0, accounts: 0 }] },
        };
      },
    };

    // `body` (bob's, the world's status in place of the fixture's), delivered by bob: what it ends.
    async function delivered(
      name: Retraction,
      body: (w: World) => Json,
    ): Promise<{ before: Json; after: Json; ended: Json }> {
      const w = await world();
      const { observe, ended } = await SCENARIOS[name](w);
      const before = await observe();
      for (const [key, value] of Object.entries(ended)) {
        expect(before[key], key).not.toEqual(value);
      }
      expect(await w.t.post(w.bob, placed(body(w), w))).toBe(202);
      await settle(w.t.store);
      return { before, after: await observe(), ended };
    }

    const AS_SENT = "as Mastodon sends it";
    it.each(
      Object.keys(RETRACTIONS).flatMap((name) =>
        [AS_SENT, ...Object.keys(FORMS)].map((form) => [name as Retraction, form] as const),
      ),
    )(
      "%s, %s: ends what Mastodon's handler ends, and only that",
      async (name, form) => {
        const { before, after, ended } = await delivered(name, () =>
          form === AS_SENT ? retraction(name) : FORMS[form as Form](retraction(name)),
        );
        expect(after).toEqual({ ...before, ...ended });
      },
      30_000,
    );

    // The spool's replay reads each body through the same envelope as the inbox (OPS-1).
    it.each(Object.keys(FORMS) as Form[])("on replay too: Delete(status), %s, ends it", async (form) => {
      const w = await world();
      const { observe, ended } = await SCENARIOS["Delete(status)"](w);
      const before = await observe();
      const maintenance = harness(w.t.store, { MAINTENANCE: "readonly" }, BUILD, {
        keygen: fixtureKeyGen,
        loader: w.t.web.loader,
      });
      const body = placed(FORMS[form](retraction("Delete(status)")), w);
      const init = await signedInit(w.bob, "/inbox", body, { at: NOW });
      expect((await maintenance.request("/inbox", init)).status).toBe(202);
      expect(await observe()).toEqual(before);
      const deps = { ...inboxDeps(() => w.t.store, w.t.web.loader), now: () => NOW };
      await maintenance.queue.deliver((batch) =>
        handleQueue(batch, { ...maintenance.env, MAINTENANCE: "off" } as Env, deps),
      );
      await settle(w.t.store);
      expect(await observe()).toEqual({ ...before, ...ended });
    });

    // Mastodon gives up the compaction of the same body with another node whose id is null (JSON::LD's
    // InvalidIdValue) and reads it as received, where its handler raises on the array (retractions.json): Kopje, which
    // cannot show that compaction succeeds, reads it as received too, and ends nothing.
    it.each(Object.keys(FORMS) as Form[])(
      "Delete(status), %s, with a target whose id is null: ends nothing",
      async (form) => {
        const { before, after } = await delivered("Delete(status)", () => ({
          ...FORMS[form](retraction("Delete(status)")),
          target: { id: null },
        }));
        expect(after).toEqual(before);
      },
    );

    // Mastodon's JSON-LD limits count the values of the body as received (check_jsonld_limits!), its references given
    // as {"@id": …} too: past 1,000 it reads the body as received, its object as no IRI, and ends nothing; Kopje, which
    // shows the compaction only within them, ends nothing either (retractions.json).
    it.each([
      [10, "ends it"],
      [494, "ends nothing"],
    ] as const)('Delete(status), its object and %i IRIs in cc as {"@id": …}: %s', async (n, outcome) => {
      const { before, after, ended } = await delivered("Delete(status)", () => referencesDelete(n));
      expect(after).toEqual(outcome === "ends it" ? { ...before, ...ended } : before);
    });

    // A reference in an embedded node, under a name typed @id or not, is read as its IRI, as the compaction writes it;
    // one in a language map is not, as JSON-LD refuses the map and Mastodon reads the body as received, its object as no
    // IRI; and a two-element array after the patch's stop stays an array, which Mastodon's handler raises on
    // (retractions.json).
    const entry = (name: string) => retractionEntries().find((other) => other.name === name)!.body;
    it.each([
      ["Undo(Follow)", 'Undo(Follow), its Follow\'s object as {"@id": its id}'],
      ["Delete(status)", 'Delete(status), object as {"@id": its id}, source holding url as {"@id": …}'],
    ] as const)("%s: %s ends what Mastodon's handler ends", async (scenario, name) => {
      const { before, after, ended } = await delivered(scenario, () => entry(name));
      expect(after).toEqual({ ...before, ...ended });
    });
    it.each([
      ...LANGUAGE_MAPS.map((map) => `Delete(status), object as {"@id": its id}, ${map} holding to as {"@id": …}`),
      "Delete(status), object as a two-element array after to: [null]",
    ])("%s: ends nothing", async (name) => {
      const { before, after } = await delivered("Delete(status)", () => entry(name));
      expect(after).toEqual(before);
    });

    // D4 under the forms (LR-f): rule (3) refuses a keyword as a key, and rule (5) a type as a compact IRI and an inline
    // definition no sender writes, where Mastodon ends the follow (retractions.json); the same Undo as Mastodon sends it
    // ends it (above).
    it.each([
      "Undo(Follow), its Follow typed by @type",
      "Undo(Follow) typed as a compact IRI",
      "Undo(Follow) under a definition no sender writes",
    ])("%s: ends nothing", async (name) => {
      const entry = retractionEntries().find((other) => other.name === name)!;
      const { before, after } = await delivered("Undo(Follow)", () => entry.body);
      expect(after).toEqual(before);
    });
  });
});
