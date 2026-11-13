import { type DocumentLoader, preloadedContexts, signJsonLd, verifyJsonLd, verifyObject } from "@fedify/fedify";
import { Delete } from "@fedify/vocab";
import { afterEach, describe, expect, it, vi } from "vitest";

import { deleteSigning, stampDeleteActivity } from "../src/domain/activities";
import { PROFILES, verifyAuthorProof } from "../src/federation/author-proof";
import { MASTODON_CONTEXT_TERMS } from "../src/federation/mastodon-context";
import {
  fepActor,
  MASTODON_FORWARDED_CONTEXT,
  mastodonDelete,
  mastodonForwarded,
  mastodonSigned,
  mastodonStampDelete,
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
const RELAY = "https://relay.example";

async function world() {
  const web = new RemoteWeb();
  const bob = await mastodonActor(web, "bob");
  const fep = await fepActor(web, "erin");
  const status = `${bob.uri}/statuses/1`;
  return { web, bob, fep, status };
}

// Whether `body` proves the Delete of `object` by `actor`, its id the literal one.
function proves(body: Json, actor: TestActor, object: string): Promise<boolean> {
  return verifyAuthorProof(body, { id: body.id as string, actor: actor.uri, object }, actor.document);
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

// A refusal by Kopje's clause alone: Fedify accepts `body`'s signature or proof, and verifyAuthorProof refuses it.
async function refused(body: Json, actor: TestActor, object: string, message?: string): Promise<void> {
  expect(await fedifyAccepts(body, actor), message).toBe(true);
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
      p.context === "forwarded" ? [AS, SECURITY] : p.context.filter((c): c is string => typeof c === "string"),
    );
    expect(urls.filter((url) => preloadedContexts[url] === undefined)).toEqual([]);
    const keys = Object.values(PROFILES).map((p) => JSON.stringify([p.context, p.form, p.object]));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("Mastodon 4.5's status Delete (DeleteSerializer, LinkedDataSignature#sign!)", async () => {
    const { bob, status } = await world();
    expect(await proves(await mastodonSigned(mastodonDelete(bob, status), bob), bob, status)).toBe(true);
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
    expect(await verifyAuthorProof(body, read, bob.document)).toBe(true);
    for (const other of [{ id: `${bob.uri}#delete-2` }, { object: `${status}0` }]) {
      expect(await verifyAuthorProof(body, { ...read, ...other }, bob.document), JSON.stringify(other)).toBe(false);
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
    expect(await verifyAuthorProof(body, { id: body.id as string, actor: bob.uri, object: status }, document)).toBe(
      false,
    );
    expect(fetched).not.toHaveBeenCalled();
  });
});

// A Mastodon holding a boost or quote forwards a signed Delete compacted under its full_context
// (ActivityPub::ProcessCollectionService): the forwarded profiles accept activitystreams, security/v1 and one object of
// MASTODON_CONTEXT_TERMS (src/federation/mastodon-context.ts), with the senders' keys.
describe("a Delete a Mastodon forwards (ID-1)", () => {
  const STAMP = (bob: TestActor, status: string) => ({
    uri: `${bob.uri}/quote_authorizations/1`,
    quoting: "https://quoter.example/notes/1",
    quoted: status,
  });

  it("passes for Mastodon's and Kopje's status Deletes, under the context Mastodon 4.5.21 forwarded", async () => {
    const { bob, status } = await world();
    const signing = deleteSigning({ uri: status, actorUri: bob.uri, visibility: "public" });
    const kopje = (signing as { activity: Json }).activity;
    expect(await proves(mastodonForwarded(await mastodonSigned(mastodonDelete(bob, status), bob)), bob, status)).toBe(
      true,
    );
    expect(await proves(mastodonForwarded(await fedifySigned(kopje, bob)), bob, status)).toBe(true);
  });

  it("refuses a stamp's Delete in the forwarded form, which Mastodon sends without its signature", async () => {
    const { bob, status } = await world();
    const stamp = STAMP(bob, status);
    const mastodon = await mastodonSigned(mastodonStampDelete(bob, stamp), bob);
    await refused(mastodonForwarded(mastodon), bob, stamp.uri, "Mastodon's stamp");
    const kopje = await fedifySigned(stampDeleteActivity(bob.uri, stamp.uri), bob);
    await refused(mastodonForwarded(kopje), bob, stamp.uri, "Kopje's stamp");
  });

  it("passes with any subset of the allowed terms, the author's own alone included", async () => {
    const { bob, status } = await world();
    const signed = await mastodonSigned(mastodonDelete(bob, status), bob);
    const atom = { ostatus: "http://ostatus.org#", atomUri: "ostatus:atomUri" };
    expect(await proves(mastodonForwarded(signed, [AS, SECURITY, atom]), bob, status)).toBe(true);
  });

  it("passes under each definition any 4.4 or 4.5 release gave a term", async () => {
    const { bob, status } = await world();
    const signed = await mastodonSigned(mastodonDelete(bob, status), bob);
    for (const [term, definitions] of Object.entries(MASTODON_CONTEXT_TERMS)) {
      for (const definition of definitions) {
        const object = { ...(MASTODON_FORWARDED_CONTEXT[2] as Json), [term]: definition };
        const forwarded = mastodonForwarded(signed, [AS, SECURITY, object]);
        expect(await proves(forwarded, bob, status), `${term} ${JSON.stringify(definition)}`).toBe(true);
      }
    }
  });

  it("refuses a forward whose object id is tampered", async () => {
    const { bob, status } = await world();
    const forwarded = mastodonForwarded(await mastodonSigned(mastodonDelete(bob, status), bob));
    const other = `${status}0`;
    const tampered = { ...forwarded, object: { id: other, type: "Tombstone", atomUri: other } };
    expect(await proves(tampered, bob, other)).toBe(false);
  });

  it.each([
    ["a term not on the allowlist", [AS, SECURITY, { ...(MASTODON_FORWARDED_CONTEXT[2] as Json), extra: "as:extra" }]],
    [
      "an allowed term with another definition",
      [AS, SECURITY, { ...(MASTODON_FORWARDED_CONTEXT[2] as Json), blurhash: "toot:other" }],
    ],
    ["security/v1 before activitystreams", [SECURITY, AS, MASTODON_FORWARDED_CONTEXT[2]]],
    ["activitystreams twice, no security/v1", [AS, AS, MASTODON_FORWARDED_CONTEXT[2]]],
    ["the object first", [MASTODON_FORWARDED_CONTEXT[2], AS, SECURITY]],
    ["two inline objects", [AS, SECURITY, { ostatus: "http://ostatus.org#" }, { atomUri: "ostatus:atomUri" }]],
  ])("refuses %s", async (_name, context) => {
    const { bob, status } = await world();
    const forwarded = mastodonForwarded(await mastodonSigned(mastodonDelete(bob, status), bob), context);
    await refused(forwarded, bob, status);
  });

  it("allows no term that is, or aliases, one the decision reads", () => {
    // The keys and classes the decision reads, and what they expand to; every keyword.
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
    // Prefixes: the allowlist's own (a term defined as an IRI) and the activitystreams context's.
    const prefixes: Record<string, string> = { as: `${AS}#`, sec: "https://w3id.org/security#" };
    for (const [term, definitions] of Object.entries(MASTODON_CONTEXT_TERMS)) {
      for (const definition of definitions) {
        if (typeof definition === "string" && /^https?:\/\/.*[#/]$/.test(definition)) {
          prefixes[term] = definition;
        }
      }
    }
    const expand = (iri: string) => {
      const colon = iri.indexOf(":");
      const prefix = colon === -1 ? undefined : prefixes[iri.slice(0, colon)];
      return prefix === undefined ? iri : prefix + iri.slice(colon + 1);
    };
    const defined = (url: string): Json => {
      const context = (preloadedContexts[url] as { "@context": unknown })["@context"];
      const entries: unknown[] = Array.isArray(context) ? context : [context];
      return Object.assign({}, ...entries.filter((c): c is Json => typeof c === "object" && c !== null)) as Json;
    };
    const inherited: Record<string, unknown> = { ...defined(SECURITY), ...defined(AS) };
    for (const [term, definitions] of Object.entries(MASTODON_CONTEXT_TERMS)) {
      expect(decision.has(term) || term.startsWith("@") || term.includes(":"), term).toBe(false);
      for (const definition of definitions) {
        const id = typeof definition === "string" ? definition : (definition as Json)["@id"];
        expect(typeof id, term).toBe("string");
        expect((id as string).startsWith("@") || forbidden.has(expand(id as string)), term).toBe(false);
        const keywords = typeof definition === "string" ? [] : Object.keys(definition as Json);
        expect(
          keywords.every((k) => ["@id", "@type", "@container"].includes(k)),
          term,
        ).toBe(true);
        if (typeof definition === "object") {
          const { "@type": type, "@container": container } = definition as Json;
          expect(type === undefined || type === "@id", term).toBe(true);
          expect(container === undefined || container === "@set" || container === "@list", term).toBe(true);
        }
        if (Object.hasOwn(inherited, term)) {
          expect(definition, `${term}, as activitystreams or security/v1 defines it`).toEqual(inherited[term]);
        }
      }
    }
  });
});
