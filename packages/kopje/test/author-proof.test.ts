import { type DocumentLoader, preloadedContexts, signJsonLd, verifyJsonLd, verifyObject } from "@fedify/fedify";
import { Delete } from "@fedify/vocab";
import { afterEach, describe, expect, it, vi } from "vitest";

import { deleteSigning, stampDeleteActivity } from "../src/domain/activities";
import { PROFILES, verifyAuthorProof } from "../src/federation/author-proof";
import { MASTODON_CONTEXT_TERMS, MASTODON_NAMED_CONTEXTS } from "../src/federation/mastodon-context";
import { NOW } from "./app-helpers";
import {
  fepActor,
  MASTODON_45_FORWARDED_CONTEXT,
  MASTODON_46_FORWARDED_CONTEXT,
  MASTODON_47_FORWARDED_CONTEXT,
  mastodon47Actor,
  mastodon47Signed,
  mastodonDelete,
  mastodonForwarded,
  mastodonSigned,
  mastodonStampDelete,
  signTime,
} from "./author-proof-helpers";
import { mastodonActor, RemoteWeb, type TestActor } from "./inbox-helpers";
import { AS, PUBLIC } from "./inbox-status-helpers";
import { contexts } from "./quote-helpers";

// ID-1: an author proof is considered only on a body in one of the sender profiles (federation/author-proof.ts
// PROFILES): its @context one profile's, verbatim, and every key at every level one its sender writes, so its JSON-LD
// meaning is its literal JSON. Each profile passes as its sender builds it; every other form is refused with a
// signature that verifies, including each exploit found against reading the body apart from the verified graph.

type Json = Record<string, unknown>;

const SECURITY = "https://w3id.org/security/v1";
const IDENTITY = "https://w3id.org/identity/v1";
const CID = "https://www.w3.org/ns/cid/v1";
const WEBFINGER = "https://purl.archive.org/socialweb/webfinger";
const RELAY = "https://relay.example";
const DAY = 24 * 60 * 60 * 1000;

// The @context a Mastodon of each release line forwards (full_context at v4.5.21, v4.6.11 and v4.7.5).
const FORWARDED = [
  ["4.5.21", MASTODON_45_FORWARDED_CONTEXT],
  ["4.6.11", MASTODON_46_FORWARDED_CONTEXT],
  ["4.7.5", MASTODON_47_FORWARDED_CONTEXT],
] as const;
// The extension object Mastodon 4.6 and 4.7 forward under.
const EXTENSIONS_46 = MASTODON_47_FORWARDED_CONTEXT.at(-1) as Json;

async function world() {
  const web = new RemoteWeb();
  const bob = await mastodonActor(web, "bob");
  const fep = await fepActor(web, "erin");
  const status = `${bob.uri}/statuses/1`;
  return { web, bob, fep, status };
}

// Whether `body` proves the Delete of `object` by `actor`, its id the literal one, for a request received at `at`.
function proves(body: Json, actor: TestActor, object: string, at = NOW): Promise<boolean> {
  return verifyAuthorProof(body, { id: body.id as string, actor: actor.uri, object }, actor.document, at);
}

// Whether Fedify alone, given the actor's document and every context, accepts `body`'s signature or proof: so that a
// refusal of `verifyAuthorProof` comes from Kopje's clause alone.
async function fedifyAccepts(body: Json, actor: TestActor): Promise<boolean> {
  const documentLoader: DocumentLoader = (url) =>
    url.split("#")[0] === actor.uri
      ? Promise.resolve({ document: actor.document, documentUrl: actor.uri, contextUrl: null })
      : contexts(url);
  const options = { documentLoader, contextLoader: contexts };
  return "proof" in body ? (await verifyObject(Delete, body, options)) !== null : verifyJsonLd(body, options);
}

// A refusal by Kopje's clause alone: Fedify accepts `body`'s signature or proof, and verifyAuthorProof refuses it at
// `at`.
async function refused(body: Json, actor: TestActor, object: string, message?: string, at = NOW): Promise<void> {
  expect(await fedifyAccepts(body, actor), message).toBe(true);
  expect(await proves(body, actor, object, at), message).toBe(false);
}

// A signature altered after signing: Fedify alone refuses it, and so does verifyAuthorProof (its profile and time
// checks pass, so only the signature fails).
async function forged(body: Json, actor: TestActor, object: string, message?: string): Promise<void> {
  expect(await fedifyAccepts(body, actor), message).toBe(false);
  expect(await proves(body, actor, object), message).toBe(false);
}

// The network, as Fedify's default loaders and any fetch reach it: every request recorded and answered from `served`
// (404 otherwise), so a verification that fell back to it would be seen, and would find what it asked for.
function network(served: Record<string, unknown>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new Request(input, init).url;
    const body = served[url];
    return Promise.resolve(
      body === undefined
        ? new Response("Not Found", { status: 404 })
        : new Response(JSON.stringify(body), { headers: { "content-type": "application/ld+json" } }),
    );
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

// An RsaSignature2017 as Fedify's signJsonLd writes it (federation/ld-sign.ts), its own @context identity/v1.
async function fedifySigned(json: Json, signer: TestActor): Promise<Json> {
  return signJsonLd(json, signer.privateKey, new URL(signer.keyId), { contextLoader: contexts });
}

describe("each sender profile passes as its sender builds it", () => {
  it("names only preloaded context URLs, a distinct form per profile", () => {
    const urls = Object.values(PROFILES).flatMap((p) =>
      p.context === "forwarded"
        ? MASTODON_NAMED_CONTEXTS.flat()
        : p.context.filter((c): c is string => typeof c === "string"),
    );
    expect(urls.filter((url) => preloadedContexts[url] === undefined)).toEqual([]);
    const keys = Object.values(PROFILES).map((p) => JSON.stringify([p.context, p.form, p.object]));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("Mastodon 4.5's status Delete (DeleteSerializer, LinkedDataSignature#sign!)", async () => {
    const { bob, status } = await world();
    expect(await proves(await mastodonSigned(mastodonDelete(bob, status), bob), bob, status)).toBe(true);
  });

  it("Mastodon 4.7's status and stamp Deletes, sign! writing expires", async () => {
    const { bob, status } = await world();
    const body = await mastodon47Signed(mastodonDelete(bob, status), bob);
    expect((body.signature as Json).expires).toBe(signTime(NOW + 2 * DAY));
    expect(await proves(body, bob, status)).toBe(true);
    const stamp = {
      uri: `${bob.uri}/quote_authorizations/1`,
      quoting: "https://quoter.example/notes/1",
      quoted: status,
    };
    expect(await proves(await mastodon47Signed(mastodonStampDelete(bob, stamp), bob), bob, stamp.uri)).toBe(true);
  });

  it("a Mastodon 4.7 author's Delete, its document of 4.7's shape and its key #rsa-…", async () => {
    const { web } = await world();
    const ann = await mastodon47Actor(web, "ann", { key: 4 });
    const status = `${ann.uri}/statuses/1`;
    expect(ann.keyId).toMatch(/#rsa-[0-9a-f]{16}$/);
    expect(await proves(await mastodon47Signed(mastodonDelete(ann, status), ann), ann, status)).toBe(true);
    expect(await proves(await mastodonSigned(mastodonDelete(ann, status), ann), ann, status)).toBe(true);
  });

  it("Mastodon 4.5's stamp Delete (DeleteQuoteAuthorizationSerializer, its QuoteAuthorization embedded)", async () => {
    const { bob, status } = await world();
    const stamp = {
      uri: `${bob.uri}/quote_authorizations/1`,
      quoting: "https://quoter.example/notes/1",
      quoted: status,
    };
    const body = await mastodonSigned(mastodonStampDelete(bob, stamp), bob);
    expect(await proves(body, bob, stamp.uri)).toBe(true);
  });

  it("Kopje's status Delete (activities.ts deleteSigning, signed as ld-sign.ts signs)", async () => {
    const { bob, status } = await world();
    const signing = deleteSigning({ uri: status, actorUri: bob.uri, visibility: "public" });
    if (signing.kind !== "signed") {
      throw new Error("not signable");
    }
    expect(await proves(await fedifySigned(signing.activity, bob), bob, status)).toBe(true);
  });

  it("Kopje's stamp Delete (activities.ts stampDeleteActivity, signed as ld-sign.ts signs)", async () => {
    const { bob } = await world();
    const stamp = `${bob.uri}/quote_authorizations/1`;
    expect(await proves(await fedifySigned(stampDeleteActivity(bob.uri, stamp), bob), bob, stamp)).toBe(true);
  });

  it("a Delete Fedify signs with an FEP-8b32 proof (signObject, its default Delete context)", async () => {
    const { fep } = await world();
    const status = `${fep.actor.uri}/statuses/1`;
    expect(await proves(await fep.fedify(`${status}#delete`, status), fep.actor, status)).toBe(true);
  });
});

describe("a body outside every profile is refused, its signature valid (ID-1)", () => {
  // bob's Mastodon status Delete with `change` made before signing.
  async function variant(change: (body: Json) => Json) {
    const { bob, status } = await world();
    return { bob, status, body: await mastodonSigned(change(mastodonDelete(bob, status)), bob) };
  }
  const ATOM = { ostatus: "http://ostatus.org#", atomUri: "ostatus:atomUri" };

  it.each([
    ["an extra inline term", [AS, { ...ATOM, summary: "as:summary" }, SECURITY]],
    ["a reordered array", [SECURITY, ATOM, AS]],
    ["the inline object before the URLs", [ATOM, AS, SECURITY]],
    ["an inline term of the same IRI", [AS, { ...ATOM, Delete: "as:Delete" }, SECURITY]],
  ])("a context not a profile's: %s", async (_name, context) => {
    const { bob, status, body } = await variant((b) => ({ ...b, "@context": context }));
    await refused(body, bob, status);
  });

  it.each([
    ["an extra top-level key", { published: "2026-11-13T00:00:00Z" }],
    ["an @type beside type", { "@type": "https://www.w3.org/ns/activitystreams#Delete" }],
    ["a full-IRI key", { "https://www.w3.org/ns/activitystreams#summary": "x" }],
    ["a compact-IRI key", { "as:summary": "x" }],
    ["a cc the sender does not write", { cc: [PUBLIC] }],
  ])("%s", async (_name, extra) => {
    const { bob, status, body } = await variant((b) => ({ ...b, ...extra }));
    await refused(body, bob, status);
  });

  it("an addressee that is not a string", async () => {
    const { bob, status, body } = await variant((b) => ({ ...b, to: [{ id: PUBLIC }] }));
    await refused(body, bob, status);
  });

  it("an id, actor or object other than the one the Worker read", async () => {
    const { bob, status, body } = await variant((b) => b);
    const read = { id: body.id as string, actor: bob.uri, object: status };
    expect(await verifyAuthorProof(body, read, bob.document, NOW)).toBe(true);
    for (const other of [{ id: `${bob.uri}#delete-2` }, { object: `${status}0` }]) {
      expect(await verifyAuthorProof(body, { ...read, ...other }, bob.document, NOW), JSON.stringify(other)).toBe(
        false,
      );
    }
  });

  it("an extra key in the object, or a type its profile does not name", async () => {
    for (const object of [{ url: "https://mastodon.example/@bob/1" }, { type: "Note" }]) {
      const { bob, status, body } = await variant((b) => ({ ...b, object: { ...(b.object as Json), ...object } }));
      await refused(body, bob, status, JSON.stringify(object));
    }
  });

  it("a type other than Delete, or an array of types", async () => {
    for (const type of ["Update", ["Delete", "Update"]]) {
      const { bob, status, body } = await variant((b) => ({ ...b, type }));
      await refused(body, bob, status, JSON.stringify(type));
    }
  });

  it("a signature in the other sender's shape", async () => {
    const { bob, status } = await world();
    // Mastodon's context with Fedify's signature (its own @context), and Kopje's with Mastodon's (none).
    await refused(await fedifySigned(mastodonDelete(bob, status), bob), bob, status);
    const signing = deleteSigning({ uri: status, actorUri: bob.uri, visibility: "public" });
    const kopje = (signing as { activity: Json }).activity;
    await refused(await mastodonSigned(kopje, bob), bob, status);
  });

  it("a Kopje signature whose own @context is not identity/v1, which Fedify ignores", async () => {
    const { bob, status } = await world();
    const signing = deleteSigning({ uri: status, actorUri: bob.uri, visibility: "public" });
    const signed = await fedifySigned((signing as { activity: Json }).activity, bob);
    const body = { ...signed, signature: { ...(signed.signature as Json), "@context": SECURITY } };
    await refused(body, bob, status);
  });

  it("an object value that is not a string", async () => {
    const { bob, status, body } = await variant((b) => ({ ...b, object: { ...(b.object as Json), atomUri: 1 } }));
    await refused(body, bob, status);
  });

  it("an id whose literal spelling is not its URL's (an upper-case host)", async () => {
    const { bob, status } = await world();
    const id = `${status.replace("mastodon.example", "MASTODON.example")}#delete`;
    const body = await mastodonSigned(mastodonDelete(bob, status, id), bob);
    // The literal id is what the Worker read; the proven one is its URL's spelling.
    await refused(body, bob, status);
  });

  describe("FEP-8b32 proofs", () => {
    async function fedifyBody() {
      const { fep, web } = await world();
      const status = `${fep.actor.uri}/statuses/1`;
      const signed = await fep.fedify(`${status}#delete`, status);
      const { proof: _proof, ...unsigned } = signed;
      return { fep, web, status, signed, unsigned };
    }

    it("passes signed by the test signer, and without the proof's own @context", async () => {
      const { fep, status, unsigned } = await fedifyBody();
      expect(await proves(await fep.sign(unsigned), fep.actor, status)).toBe(true);
      expect(await proves(await fep.sign(unsigned, { omitContext: true }), fep.actor, status)).toBe(true);
    });

    it("refuses a proof with a key its sender does not write, which Fedify accepts", async () => {
      const { fep, status, unsigned } = await fedifyBody();
      const body = await fep.sign(unsigned, { extra: { nonce: "n1" } });
      await refused(body, fep.actor, status);
    });

    it("refuses a proof whose @context is not the body's, though it verifies against it", async () => {
      const { fep, status, unsigned } = await fedifyBody();
      // Signed under a prefix of the body's context, which Fedify accepts (contextStartsWith).
      const context = unsigned["@context"] as unknown[];
      const signed = await fep.sign({ ...unsigned, "@context": context.slice(0, -1) });
      const proof = { ...(signed.proof as Json), "@context": context.slice(0, -1) };
      await refused({ ...unsigned, proof }, fep.actor, status);
    });

    it("refuses a second proof, valid, invalid or of another context, in either order, and no proof", async () => {
      const { fep, status, signed, unsigned } = await fedifyBody();
      const valid = signed.proof as Json;
      const invalid = { ...valid, proofValue: `${valid.proofValue as string}1` };
      const other = { ...valid, "@context": [AS] };
      for (const second of [valid, invalid, other]) {
        expect(await proves({ ...unsigned, proof: [valid, second] }, fep.actor, status)).toBe(false);
        expect(await proves({ ...unsigned, proof: [second, valid] }, fep.actor, status)).toBe(false);
      }
      // A second copy of the valid proof, which Fedify accepts: refused by the single-proof clause alone.
      await refused({ ...unsigned, proof: [valid, valid] }, fep.actor, status);
      expect(await proves({ ...unsigned, proof: [valid] }, fep.actor, status)).toBe(true);
      expect(await proves({ ...unsigned, proof: [] }, fep.actor, status)).toBe(false);
    });
  });
});

describe("each exploit found against the proof is refused (ID-1)", () => {
  it("a type the context maps to nothing (round 1)", async () => {
    const { bob, status } = await world();
    const { type: _type, ...untyped } = mastodonDelete(bob, status);
    const signed = await mastodonSigned(untyped, bob);
    const relayed = { ...signed, "@context": [...(signed["@context"] as unknown[]), { type: null }], type: "Delete" };
    expect(await proves(relayed, bob, status)).toBe(false);
  });

  it("a signed Update read as a Delete through a nested signature (round 2)", async () => {
    const { bob, status } = await world();
    const edit = {
      "@context": [AS, SECURITY],
      id: `${status}#updates/1`,
      type: "Update",
      actor: bob.uri,
      to: [PUBLIC],
      object: { id: status, type: "Note", attributedTo: bob.uri, content: "<p>edited</p>", to: [PUBLIC] },
    };
    const signed = await mastodonSigned(edit, bob);
    const nest = { Delete: "as:Update", signature: "@nest", RsaSignature2017: "as:Delete" };
    const relayed = { ...signed, "@context": [...(signed["@context"] as unknown[]), nest], type: "Delete" };
    expect(await proves(relayed, bob, status)).toBe(false);
  });

  it("an FEP context appended to the body only (round 2)", async () => {
    const { fep } = await world();
    const status = `${fep.actor.uri}/statuses/1`;
    const like = await fep.sign({
      "@context": [AS, "https://w3id.org/security/data-integrity/v1", { Delete: "as:Like" }],
      id: `${fep.actor.uri}#likes/1`,
      type: "Delete",
      actor: fep.actor.uri,
      object: status,
    });
    const appended = { ...like, "@context": [...(like["@context"] as unknown[]), { Delete: "as:Delete" }] };
    expect(await proves(appended, fep.actor, status)).toBe(false);
  });

  it("a fake proof typed Emoji through a nested proof (round 3)", async () => {
    const { fep } = await world();
    const status = `${fep.actor.uri}/statuses/1`;
    const signed = await fep.fedify(`${status}#delete`, status);
    const relayed = {
      ...signed,
      "@context": [...(signed["@context"] as unknown[]), { proof: "@nest" }],
      proof: { type: "Emoji", name: ":x:" },
    };
    expect(await proves(relayed, fep.actor, status)).toBe(false);
  });

  it("a proof under an alias (round 3)", async () => {
    const { fep } = await world();
    const status = `${fep.actor.uri}/statuses/1`;
    const { proof, ...signed } = await fep.fedify(`${status}#delete`, status);
    const relayed = {
      ...signed,
      "@context": [...(signed["@context"] as unknown[]), { sig: { "@id": "https://w3id.org/security#proof" } }],
      sig: proof,
    };
    expect(await proves(relayed, fep.actor, status)).toBe(false);
  });

  it("a remote context, never fetched (round 3)", async () => {
    const { bob, status } = await world();
    const remote = `${RELAY}/context.jsonld`;
    const document = { "@context": { ostatus: "http://ostatus.org#", atomUri: "ostatus:atomUri" } };
    // Signed by a loader that serves the remote context, so the signature verifies over it.
    const loader: DocumentLoader = (url) =>
      url === remote ? Promise.resolve({ document, documentUrl: url, contextUrl: null }) : contexts(url);
    const unsigned = { ...mastodonDelete(bob, status), "@context": [AS, remote, SECURITY] };
    const body = (await signJsonLd(unsigned, bob.privateKey, new URL(bob.keyId), { contextLoader: loader })) as Json;
    const fetched = network({ [remote]: document });
    expect(await proves(body, bob, status)).toBe(false);
    expect(fetched).not.toHaveBeenCalled();
  });

  it("a typeless FEP-8b32 body (FEP-6757, plan review)", async () => {
    const { fep } = await world();
    const status = `${fep.actor.uri}/statuses/1`;
    const { type: _type, proof: _proof, ...typeless } = await fep.fedify(`${status}#delete`, status);
    expect(await proves(await fep.sign(typeless), fep.actor, status)).toBe(false);
  });
});

describe("contexts come from the preloaded set alone (ID-1)", () => {
  it("verifies a profile's body without touching the network", async () => {
    const { bob, fep, status } = await world();
    const fetched = network({});
    expect(await proves(await mastodonSigned(mastodonDelete(bob, status), bob), bob, status)).toBe(true);
    const signed = await mastodon47Signed(mastodonDelete(bob, status), bob);
    expect(await proves(mastodonForwarded(signed, MASTODON_47_FORWARDED_CONTEXT), bob, status)).toBe(true);
    const fepStatus = `${fep.actor.uri}/statuses/1`;
    expect(await proves(await fep.fedify(`${fepStatus}#delete`, fepStatus), fep.actor, fepStatus)).toBe(true);
    expect(fetched).not.toHaveBeenCalled();
  });

  it("refuses an actor document naming a context that is not preloaded, fetching nothing", async () => {
    const { bob, status } = await world();
    const remote = `${RELAY}/actor-context.jsonld`;
    const context = bob.document["@context"];
    const document = { ...bob.document, "@context": [...(Array.isArray(context) ? context : [context]), remote] };
    const fetched = network({ [remote]: { "@context": { ex: "https://example.org/ns#" } } });
    const body = await mastodonSigned(mastodonDelete(bob, status), bob);
    expect(
      await verifyAuthorProof(body, { id: body.id as string, actor: bob.uri, object: status }, document, NOW),
    ).toBe(false);
    expect(fetched).not.toHaveBeenCalled();
  });
});

// A Mastodon holding a boost or quote forwards a signed Delete compacted under its full_context
// (ActivityPub::ProcessCollectionService, ProcessActivityService from 4.7): the forwarded profiles accept one release
// line's MASTODON_NAMED_CONTEXTS and one object of MASTODON_CONTEXT_TERMS (src/federation/mastodon-context.ts), with the
// senders' keys.
describe("a Delete a Mastodon forwards (ID-1)", () => {
  const STAMP = (bob: TestActor, status: string) => ({
    uri: `${bob.uri}/quote_authorizations/1`,
    quoting: "https://quoter.example/notes/1",
    quoted: status,
  });

  it("passes for Mastodon's and Kopje's status Deletes, under the context Mastodon 4.5.21, 4.6.11 or 4.7.5 forwards", async () => {
    const { bob, status } = await world();
    const signing = deleteSigning({ uri: status, actorUri: bob.uri, visibility: "public" });
    const kopje = await fedifySigned((signing as { activity: Json }).activity, bob);
    const mastodon = await mastodonSigned(mastodonDelete(bob, status), bob);
    for (const [release, context] of FORWARDED) {
      expect(await proves(mastodonForwarded(mastodon, context), bob, status), `Mastodon's, ${release}`).toBe(true);
      expect(await proves(mastodonForwarded(kopje, context), bob, status), `Kopje's, ${release}`).toBe(true);
    }
  });

  it("passes for Mastodon 4.7's status Delete, signed with expires, under each forwarded context", async () => {
    const { bob, status } = await world();
    const signed = await mastodon47Signed(mastodonDelete(bob, status), bob);
    for (const [release, context] of FORWARDED) {
      expect(await proves(mastodonForwarded(signed, context), bob, status), release).toBe(true);
    }
  });

  it("refuses a stamp's Delete in the forwarded form under each context, which Mastodon sends without its signature", async () => {
    const { bob, status } = await world();
    const stamp = STAMP(bob, status);
    const bodies = [
      ["Mastodon's stamp", await mastodonSigned(mastodonStampDelete(bob, stamp), bob)],
      ["Mastodon 4.7's stamp, with expires", await mastodon47Signed(mastodonStampDelete(bob, stamp), bob)],
      ["Kopje's stamp", await fedifySigned(stampDeleteActivity(bob.uri, stamp.uri), bob)],
    ] as const;
    for (const [name, body] of bodies) {
      // Its own sender form passes: the forwarded @context alone refuses it.
      expect(await proves(body, bob, stamp.uri), name).toBe(true);
      for (const [release, context] of FORWARDED) {
        await refused(mastodonForwarded(body, context), bob, stamp.uri, `${name}, ${release}`);
      }
    }
  });

  it("passes with any subset of the allowed terms, the author's own alone included", async () => {
    const { bob, status } = await world();
    const signed = await mastodonSigned(mastodonDelete(bob, status), bob);
    const atom = { ostatus: "http://ostatus.org#", atomUri: "ostatus:atomUri" };
    for (const named of MASTODON_NAMED_CONTEXTS) {
      expect(await proves(mastodonForwarded(signed, [...named, atom]), bob, status), named.join(" ")).toBe(true);
    }
  });

  it("passes under each definition any release gave a term, under the 4.5 and the 4.7 sequences", async () => {
    const { bob, status } = await world();
    const signed = await mastodonSigned(mastodonDelete(bob, status), bob);
    const sequences = [
      [MASTODON_45_FORWARDED_CONTEXT.slice(0, -1), MASTODON_45_FORWARDED_CONTEXT.at(-1) as Json],
      [MASTODON_47_FORWARDED_CONTEXT.slice(0, -1), EXTENSIONS_46],
    ] as const;
    for (const [named, extensions] of sequences) {
      for (const [term, definitions] of Object.entries(MASTODON_CONTEXT_TERMS)) {
        for (const definition of definitions) {
          const forwarded = mastodonForwarded(signed, [...named, { ...extensions, [term]: definition }]);
          const message = `${named.length} ${term} ${JSON.stringify(definition)}`;
          expect(await proves(forwarded, bob, status), message).toBe(true);
        }
      }
    }
  }, 120_000);

  it("refuses a forward whose object id is tampered", async () => {
    const { bob, status } = await world();
    const forwarded = mastodonForwarded(await mastodonSigned(mastodonDelete(bob, status), bob));
    const other = `${status}0`;
    const tampered = { ...forwarded, object: { id: other, type: "Tombstone", atomUri: other } };
    expect(await proves(tampered, bob, other)).toBe(false);
  });

  const OBJECT_45 = MASTODON_45_FORWARDED_CONTEXT.at(-1) as Json;
  it.each([
    ["a term not on the allowlist", [AS, SECURITY, { ...OBJECT_45, extra: "as:extra" }]],
    ["an allowed term with another definition", [AS, SECURITY, { ...OBJECT_45, blurhash: "toot:other" }]],
    ["security/v1 before activitystreams", [SECURITY, AS, OBJECT_45]],
    ["activitystreams twice, no security/v1", [AS, AS, OBJECT_45]],
    ["the object first", [OBJECT_45, AS, SECURITY]],
    ["two inline objects", [AS, SECURITY, { ostatus: "http://ostatus.org#" }, { atomUri: "ostatus:atomUri" }]],
    ["webfinger before cid/v1", [AS, SECURITY, WEBFINGER, CID, EXTENSIONS_46]],
    ["cid/v1 without webfinger", [AS, SECURITY, CID, EXTENSIONS_46]],
    ["webfinger twice", [AS, SECURITY, WEBFINGER, WEBFINGER, EXTENSIONS_46]],
    [
      "the 4.6 sequence with another preloaded URL",
      [AS, SECURITY, WEBFINGER, "https://w3id.org/security/data-integrity/v1", EXTENSIONS_46],
    ],
    [
      "two objects after the 4.7 sequence",
      [AS, SECURITY, CID, WEBFINGER, { ostatus: "http://ostatus.org#" }, { atomUri: "ostatus:atomUri" }],
    ],
    ["the object before the 4.7 URLs", [EXTENSIONS_46, AS, SECURITY, CID, WEBFINGER]],
    [
      "a new term with another definition",
      [AS, SECURITY, CID, WEBFINGER, { ...EXTENSIONS_46, showFeatured: "toot:other" }],
    ],
    [
      "a term not on the allowlist under the 4.7 sequence",
      [AS, SECURITY, CID, WEBFINGER, { ...EXTENSIONS_46, extra: "as:extra" }],
    ],
  ])("refuses %s", async (_name, context) => {
    const { bob, status } = await world();
    const forwarded = mastodonForwarded(await mastodonSigned(mastodonDelete(bob, status), bob), context);
    await refused(forwarded, bob, status);
  });

  it("allows no term that is, or aliases, one the decision reads, in the list, webfinger or cid/v1", () => {
    // The keys and classes the decision reads, and what they expand to.
    const decision = new Set([
      "id",
      "type",
      "actor",
      "object",
      "to",
      "cc",
      "signature",
      "proof",
      "Delete",
      "Tombstone",
    ]);
    const forbidden = new Set([
      `${AS}#actor`,
      `${AS}#object`,
      `${AS}#to`,
      `${AS}#cc`,
      `${AS}#Delete`,
      `${AS}#Tombstone`,
      "https://w3id.org/security#signature",
      "https://w3id.org/security#proof",
    ]);
    // The keys and types a profile body may carry at any level (author-proof.ts PROFILES), none of which may bring a
    // scoped context into it.
    const profileNames = new Set(
      [
        ["@context", "id", "type", "actor", "object", "to", "cc", "signature", "proof", "atomUri"],
        ["attributedTo", "interactingObject", "interactionTarget", "creator", "created", "expires", "signatureValue"],
        ["cryptosuite", "verificationMethod", "proofPurpose", "proofValue"],
        ["Delete", "Tombstone", "QuoteAuthorization", "RsaSignature2017", "DataIntegrityProof"],
      ].flat(),
    );
    const defined = (url: string): Json => {
      const context = (preloadedContexts[url] as { "@context": unknown })["@context"];
      const entries: unknown[] = Array.isArray(context) ? context : [context];
      return Object.assign({}, ...entries.filter((c): c is Json => typeof c === "object" && c !== null)) as Json;
    };
    const asTerms = (url: string) =>
      Object.fromEntries(
        Object.entries(defined(url))
          .filter(([term]) => term !== "@protected")
          .map(([term, definition]) => [term, [definition]]),
      ) as Record<string, readonly unknown[]>;
    // Prefixes: those a term defines as an IRI ending in # or /, in any context checked, and activitystreams' and
    // security/v1's.
    const prefixes: Record<string, string> = { as: `${AS}#`, sec: "https://w3id.org/security#" };
    const sets = { list: MASTODON_CONTEXT_TERMS, [WEBFINGER]: asTerms(WEBFINGER), [CID]: asTerms(CID) };
    for (const terms of Object.values(sets)) {
      for (const [term, definitions] of Object.entries(terms)) {
        for (const definition of definitions) {
          if (typeof definition === "string" && /^https?:\/\/.*[#/]$/.test(definition)) {
            prefixes[term] = definition;
          }
        }
      }
    }
    const expand = (iri: string) => {
      const colon = iri.indexOf(":");
      const prefix = colon === -1 ? undefined : prefixes[iri.slice(0, colon)];
      return prefix === undefined ? iri : prefix + iri.slice(colon + 1);
    };
    const expanded = (definition: unknown): unknown =>
      typeof definition === "string"
        ? expand(definition)
        : { ...(definition as Json), "@id": expand((definition as Json)["@id"] as string) };
    // What activitystreams, security/v1, webfinger and cid/v1 define, each term compared after expansion.
    const inheritedFrom = (urls: string[]): Json => Object.assign({}, ...urls.map((url) => defined(url))) as Json;
    // Every violation of the rule among `terms`, which come after `before`; `datatypes` admits a datatype IRI as @type
    // (webfinger's xsd:string), and `scoped` the terms whose definition may carry a scoped context.
    const violations = (
      terms: Record<string, readonly unknown[]>,
      before: string[],
      options: { datatypes?: boolean; scoped?: readonly string[] } = {},
    ): string[] => {
      const inherited = inheritedFrom(before);
      const found: string[] = [];
      const check = (ok: boolean, what: string) => {
        if (!ok) {
          found.push(what);
        }
      };
      for (const [term, definitions] of Object.entries(terms)) {
        for (const definition of definitions) {
          const label = `${term} ${JSON.stringify(definition)}`;
          if (term === "id" || term === "type") {
            check(definition === `@${term}`, `${label}: id and type only as @id and @type`);
            continue;
          }
          check(!decision.has(term) && !term.startsWith("@") && !term.includes(":"), `${label}: a decision term`);
          const id = typeof definition === "string" ? definition : (definition as Json)["@id"];
          check(typeof id === "string", `${label}: no @id`);
          check(!(id as string).startsWith("@") && !forbidden.has(expand(id as string)), `${label}: aliases one`);
          if (typeof definition === "object") {
            const { "@type": type, "@container": container, "@context": scoped, ...rest } = definition as Json;
            check(
              Object.keys(rest).every((k) => k === "@id"),
              `${label}: another keyword`,
            );
            const datatype = options.datatypes === true && typeof type === "string" && !type.startsWith("@");
            check(type === undefined || type === "@id" || datatype, `${label}: @type`);
            check(container === undefined || container === "@set" || container === "@list", `${label}: @container`);
            check(scoped === undefined || options.scoped?.includes(term) === true, `${label}: a scoped context`);
          }
          if (Object.hasOwn(inherited, term)) {
            check(
              JSON.stringify(expanded(definition)) === JSON.stringify(expanded(inherited[term])),
              `${label}: not as ${JSON.stringify(inherited[term])}`,
            );
          }
        }
      }
      return found;
    };
    // cid/v1's scoped contexts sit under `service`, `Multikey` and `JsonWebKey`, none a key or type a profile allows.
    const scoped = ["service", "Multikey", "JsonWebKey"];
    expect(scoped.filter((name) => profileNames.has(name))).toEqual([]);
    expect(violations(MASTODON_CONTEXT_TERMS, [AS, SECURITY, CID, WEBFINGER])).toEqual([]);
    expect(violations(sets[CID], [AS, SECURITY], { scoped })).toEqual([]);
    expect(violations(sets[WEBFINGER], [AS, SECURITY, CID], { datatypes: true })).toEqual([]);
    expect(
      Object.keys(sets[CID]).filter((term) => (defined(CID)[term] as Json | undefined)?.["@context"] !== undefined),
    ).toEqual(scoped);
    // The check flags an alias of a decision term, and a scoped context elsewhere.
    expect(violations({ actor: ["as:object"] }, [AS, SECURITY])).not.toEqual([]);
    expect(violations({ sensitive: ["as:object"] }, [AS, SECURITY])).not.toEqual([]);
    expect(violations({ service: [{ "@id": "as:service", "@context": {} }] }, [AS, SECURITY])).not.toEqual([]);
  });
});

// LinkedDataSignature#sign! writes `expires` from 4.7.0 (two days after `created`): a Mastodon signature may carry it,
// in that form, and it is judged at the time the request reached the inbox (receivedAt), as Mastodon's verify_actor!
// refuses a past one. Fedify covers it with the signature but compares it with no clock.
describe("a Mastodon signature's expires (ID-1, OPS-1)", () => {
  it("refuses an expires one second earlier than receivedAt, and passes one equal to it", async () => {
    const { bob, status } = await world();
    const body = await mastodon47Signed(mastodonDelete(bob, status), bob, {
      created: signTime(NOW - 2 * DAY),
      expires: signTime(NOW),
    });
    await refused(body, bob, status, "a second later", NOW + 1000);
    expect(await proves(body, bob, status, NOW)).toBe(true);
    const forwarded = mastodonForwarded(body, MASTODON_47_FORWARDED_CONTEXT);
    await refused(forwarded, bob, status, "forwarded, a second later", NOW + 1000);
    expect(await proves(forwarded, bob, status, NOW)).toBe(true);
  });

  it.each([
    ["with milliseconds", "2026-10-14T00:00:00.000Z"],
    ["with an offset", "2026-10-14T00:00:00+00:00"],
    ["no valid instant", "2027-02-30T00:00:00Z"],
    ["a number", Date.parse("2026-10-14T00:00:00Z") / 1000],
  ])("refuses an expires not in sign!'s form: %s", async (_name, expires) => {
    const { bob, status } = await world();
    const body = await mastodon47Signed(mastodonDelete(bob, status), bob, { expires });
    await refused(body, bob, status);
  });

  it("refuses expires on a signature in Fedify's form", async () => {
    const { bob, status } = await world();
    const signing = deleteSigning({ uri: status, actorUri: bob.uri, visibility: "public" });
    const signed = await mastodon47Signed((signing as { activity: Json }).activity, bob);
    const body = { ...signed, signature: { "@context": IDENTITY, ...(signed.signature as Json) } };
    await refused(body, bob, status);
    // Without expires, the same body in Fedify's form passes.
    expect(await proves(await fedifySigned((signing as { activity: Json }).activity, bob), bob, status)).toBe(true);
  });

  // The actor document is served to Fedify only through the loader its key lookup calls, so its reads witness whether
  // Fedify's verification ran.
  it("runs no Fedify verification for an expired proof", async () => {
    const { bob, status } = await world();
    const counted = () => {
      let reads = 0;
      const count = () => reads++;
      const document = new Proxy(bob.document, {
        get: (target, key, receiver) => (count(), Reflect.get(target, key, receiver) as unknown),
        has: (target, key) => (count(), Reflect.has(target, key)),
        ownKeys: (target) => (count(), Reflect.ownKeys(target)),
        getOwnPropertyDescriptor: (target, key) => (count(), Reflect.getOwnPropertyDescriptor(target, key)),
      });
      return { document, reads: () => reads };
    };
    const expected = (body: Json) => ({ id: body.id as string, actor: bob.uri, object: status });
    const expired = await mastodon47Signed(mastodonDelete(bob, status), bob, { expires: signTime(NOW - 1000) });
    expect(await fedifyAccepts(expired, bob)).toBe(true);
    const refusedCount = counted();
    expect(await verifyAuthorProof(expired, expected(expired), refusedCount.document, NOW)).toBe(false);
    expect(refusedCount.reads()).toBe(0);
    const valid = await mastodon47Signed(mastodonDelete(bob, status), bob);
    const control = counted();
    expect(await verifyAuthorProof(valid, expected(valid), control.document, NOW)).toBe(true);
    expect(control.reads()).toBeGreaterThan(0);
  });
});

// A signature whose expires is changed, added or removed after signing, without signing again: Fedify hashes the
// signature's options with expires under identity/v1, so it fails, and verifyAuthorProof refuses it with it.
describe("a signature altered after signing (ID-1)", () => {
  it.each([
    ["Mastodon 4.7's own form", (signed: Json) => signed],
    ["its 4.7.5 forward", (signed: Json) => mastodonForwarded(signed, MASTODON_47_FORWARDED_CONTEXT)],
  ])("is refused by Fedify and by verifyAuthorProof: %s", async (_name, form) => {
    const { bob, status } = await world();
    const withExpires = form(await mastodon47Signed(mastodonDelete(bob, status), bob));
    const without = form(await mastodonSigned(mastodonDelete(bob, status), bob));
    for (const control of [withExpires, without]) {
      expect(await fedifyAccepts(control, bob)).toBe(true);
      expect(await proves(control, bob, status)).toBe(true);
    }
    const signature = withExpires.signature as Json;
    const { expires: _expires, ...removed } = signature;
    await forged(
      { ...withExpires, signature: { ...signature, expires: signTime(NOW + 3 * DAY) } },
      bob,
      status,
      "changed",
    );
    await forged({ ...withExpires, signature: removed }, bob, status, "removed");
    const added = { ...(without.signature as Json), expires: signTime(NOW + 2 * DAY) };
    await forged({ ...without, signature: added }, bob, status, "added");
  });
});
