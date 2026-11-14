import { preloadedContexts } from "@fedify/fedify";
import { Person } from "@fedify/vocab";
import { describe, expect, it, vi } from "vitest";

import {
  KEY_TERM_CONTEXTS,
  type KeyImporters,
  keyTermsOf,
  MAX_PUBLIC_KEYS,
  readableKeys,
} from "../src/federation/key-entries";
import { createContextLoader, createSafeLoader } from "../src/federation/loader";
import { loadActor, ownKeys } from "../src/federation/remote-actor";
import { mastodonActor, RemoteWeb } from "./inbox-helpers";
import {
  base64urlMultibase,
  ecPem,
  ed25519Pair,
  ML_DSA_44_MULTIBASE,
  multikeyActor,
  servedLoader,
  UNKNOWN_MULTIBASE,
  UNPARSEABLE_PEM,
} from "./key-forms-helpers";

// key-entries.ts (ID-1, RES-6): which entries of a fetched document's publicKey and assertionMethod Kopje reads, and
// which contexts establish what the two properties mean.

type Json = Record<string, unknown>;

const AS = "https://www.w3.org/ns/activitystreams";
const SECURITY = "https://w3id.org/security/v1";
const ORIGIN = "https://mastodon.example";
const ACTOR = `${ORIGIN}/users/zed`;

async function contextsOf() {
  const web = new RemoteWeb();
  const mastodon = (await mastodonActor(web, "bob")).document["@context"];
  const fedify = (await multikeyActor(web, "carol")).document["@context"];
  return { mastodon, fedify };
}

// A legacy key and a Multikey entry of `owner`, with the key material as given.
const legacy = (owner: string, id: string, publicKeyPem: unknown) => ({ id: `${owner}#${id}`, owner, publicKeyPem });
const multikey = (owner: string, id: string, publicKeyMultibase: unknown) => ({
  id: `${owner}#${id}`,
  type: "Multikey",
  controller: owner,
  publicKeyMultibase,
});

// An RSA key's PEM and an Ed25519 key's multibase.
async function materials() {
  const pem = (await mastodonActor(new RemoteWeb(), "dave")).pem;
  return { pem, multibase: await base64urlMultibase((await ed25519Pair()).publicKey) };
}

// The actor ACTOR serves with these entries, under Fedify's actor context (which gives both properties their meaning).
async function actorDocument(publicKey: unknown, assertionMethod: unknown): Promise<Json> {
  const { fedify } = await contextsOf();
  return { "@context": fedify, id: ACTOR, type: "Person", inbox: `${ACTOR}/inbox`, publicKey, assertionMethod };
}

// `document` served at ACTOR and loaded as Kopje loads an actor (the safe loader, loadActor, ownKeys), with every key
// import made on the way counted (crypto.subtle.importKey, which Fedify's and readableKeys' importers both call).
async function loaded(document: Json) {
  const fetch = ((input: RequestInfo | URL) =>
    Promise.resolve(
      new Request(input).url === ACTOR
        ? Response.json(document, { headers: { "content-type": "application/activity+json" } })
        : new Response(null, { status: 404 }),
    )) as typeof globalThis.fetch;
  const deps = { fetch, checkHost: () => Promise.resolve(), userAgent: "Kopje/test" };
  const importKey = vi.spyOn(crypto.subtle, "importKey");
  try {
    const actor = await loadActor(ACTOR, createSafeLoader(deps), createContextLoader(deps));
    const keys = actor.kind === "ok" ? await ownKeys(actor.actor, new URL(ACTOR)) : [];
    return { kind: actor.kind, ids: keys.map((key) => key.id).toSorted(), imports: importKey.mock.calls.length };
  } finally {
    importKey.mockRestore();
  }
}

// The keys Fedify 2.4.5 alone imports parsing `json` as served, with no entry left out.
async function fedifyImports(json: Json) {
  const served = servedLoader(new RemoteWeb());
  const importKey = vi.spyOn(crypto.subtle, "importKey");
  try {
    await Person.fromJsonLd(json, { documentLoader: served, contextLoader: served });
    return importKey.mock.calls.length;
  } finally {
    importKey.mockRestore();
  }
}

// The contexts a document may have whose meaning of the key properties Kopje does not establish from them alone.
const UNRECOGNIZED: [string, unknown][] = [
  ["an instance-hosted context", [AS, `${ORIGIN}/schemas/litepub-0.1.jsonld`, { "@language": "und" }]],
  ["an inline redefinition", [AS, SECURITY, { publicKey: { "@id": "as:alsoKnownAs", "@type": "@id" } }]],
  [
    "a type-scoped redefinition",
    [AS, SECURITY, { Person: { "@id": "as:Person", "@context": { publicKey: { "@id": "as:alsoKnownAs" } } } }],
  ],
  ["an inline @import", [AS, SECURITY, { "@import": `${ORIGIN}/context.jsonld` }]],
  ["an inline scoped @context", [AS, SECURITY, { attachment: { "@id": "as:attachment", "@context": {} } }]],
  ["a null member", [SECURITY, null, AS, { "@vocab": "https://example.org/" }]],
  ["no context that defines publicKey", [AS, { toot: "http://joinmastodon.org/ns#" }]],
];

// Importers that count their calls and accept everything.
function counting(): { importers: KeyImporters; calls: () => number } {
  let calls = 0;
  const accept = () => {
    calls++;
    return Promise.resolve(null);
  };
  return { importers: { publicKey: accept, assertionMethod: accept }, calls: () => calls };
}

describe("readableKeys: the entries of each property", () => {
  it("keeps references, nulls and readable entries in order, and drops each entry whose key cannot be imported", async () => {
    const { mastodon, fedify } = await contextsOf();
    const ed = await ed25519Pair();
    const pem = (await mastodonActor(new RemoteWeb(), "dave")).pem;
    const owner = `${ORIGIN}/u`;
    const good = legacy(owner, "main", pem);
    const ec = legacy(owner, "ec", await ecPem());
    const ed25519 = multikey(owner, "ed", await base64urlMultibase(ed.publicKey));
    const reference = `${ORIGIN}/keys/1`;
    const publicKeys = [
      reference,
      ec,
      null,
      good,
      legacy(owner, "bad", UNPARSEABLE_PEM),
      legacy(owner, "number", 42),
      { id: "x" },
    ];
    const methods = [
      multikey(owner, "mldsa", ML_DSA_44_MULTIBASE),
      null,
      ed25519,
      reference,
      multikey(owner, "k1", UNKNOWN_MULTIBASE),
    ];

    expect(await readableKeys({ "@context": mastodon, id: `${ORIGIN}/u`, publicKey: publicKeys })).toEqual({
      "@context": mastodon,
      id: `${ORIGIN}/u`,
      publicKey: [reference, null, good, { id: "x" }],
    });
    expect(await readableKeys({ "@context": fedify, assertionMethod: methods, publicKey: publicKeys })).toEqual({
      "@context": fedify,
      assertionMethod: [null, ed25519, reference],
      publicKey: [reference, null, good, { id: "x" }],
    });
  });

  it("drops an entry that wraps others (a nested array, @list, @set, an object of keywords), as Mastodon skips it", async () => {
    const { mastodon, fedify } = await contextsOf();
    const { pem, multibase } = await materials();
    const { importers, calls } = counting();
    const owner = `${ORIGIN}/u`;
    const key = legacy(owner, "main", pem);
    const method = multikey(owner, "ed", multibase);
    const wrapping = (entry: Json): unknown[] => [
      [entry],
      { "@list": [entry] },
      { "@set": [entry] },
      { "@graph": [entry] },
      { "@index": "x", "@set": [entry] },
      { "@value": "x" },
    ];
    const reference = { "@id": `${ORIGIN}/keys/1` };
    const typed = { "@id": `${ORIGIN}/keys/2`, "@type": "Multikey" };
    const document = {
      "@context": fedify,
      publicKey: [...wrapping(key), reference, key],
      assertionMethod: [...wrapping(method), typed, method],
    };

    expect(await readableKeys(document, importers)).toEqual({
      "@context": fedify,
      publicKey: [reference, key],
      assertionMethod: [typed, method],
    });
    expect(calls()).toBe(2);
    const single = { "@context": mastodon, id: owner, publicKey: { "@list": [key] } };
    expect(await readableKeys(single)).toEqual({ "@context": mastodon, id: owner });
  });

  it("reads key material as one string: alone, in a one-element array or as a value object, nothing else", async () => {
    const { fedify } = await contextsOf();
    const { pem, multibase } = await materials();
    const owner = `${ORIGIN}/u`;
    const shapes = (material: string) => [material, [material], { "@value": material }];
    const otherShapes = (material: string) => [
      [material, material],
      [],
      { "@list": [material] },
      [{ "@value": material }],
      { "@value": material, "@language": "en" },
    ];
    const document = {
      "@context": fedify,
      publicKey: [
        ...shapes(pem).map((material, i) => legacy(owner, `pem${i}`, material)),
        ...otherShapes(pem).map((material, i) => legacy(owner, `other${i}`, material)),
        legacy(owner, "ec", [await ecPem()]),
      ],
      assertionMethod: [
        ...shapes(multibase).map((material, i) => multikey(owner, `mb${i}`, material)),
        ...otherShapes(multibase).map((material, i) => multikey(owner, `other${i}`, material)),
        multikey(owner, "mldsa", { "@value": ML_DSA_44_MULTIBASE }),
      ],
    };

    const read = (await readableKeys(document)) as Json;
    expect((read.publicKey as Json[]).map((entry) => entry.id)).toEqual([0, 1, 2].map((i) => `${owner}#pem${i}`));
    expect((read.assertionMethod as Json[]).map((entry) => entry.id)).toEqual([0, 1, 2].map((i) => `${owner}#mb${i}`));
  });

  it("keeps a readable single value, and removes an unreadable one", async () => {
    const { mastodon } = await contextsOf();
    const pem = (await mastodonActor(new RemoteWeb(), "dave")).pem;
    const single = { "@context": mastodon, id: `${ORIGIN}/u`, publicKey: { id: `${ORIGIN}/u#k`, publicKeyPem: pem } };
    expect(await readableKeys(single)).toBe(single);
    const unreadable = { ...single, publicKey: { id: `${ORIGIN}/u#k`, publicKeyPem: await ecPem() } };
    expect(await readableKeys(unreadable)).toEqual({ "@context": mastodon, id: `${ORIGIN}/u` });
  });

  it("keeps the first MAX_PUBLIC_KEYS entries of each form, references and nulls counted", async () => {
    const { fedify } = await contextsOf();
    const entries = (form: string) => [null, ...Array.from({ length: 11 }, (_, i) => `${ORIGIN}/${form}/${i}`)];
    const read = (await readableKeys({
      "@context": fedify,
      publicKey: entries("pk"),
      assertionMethod: entries("am"),
    })) as Json;
    expect(read.publicKey).toEqual(entries("pk").slice(0, MAX_PUBLIC_KEYS));
    expect(read.assertionMethod).toEqual(entries("am").slice(0, MAX_PUBLIC_KEYS));
  });

  it("imports at most MAX_PUBLIC_KEYS keys of each form, whatever the document lists (RES-6)", async () => {
    const { fedify } = await contextsOf();
    const { importers, calls } = counting();
    const many = (member: string) =>
      Array.from({ length: 1000 }, (_, i) => ({ id: `${ORIGIN}/u#${i}`, [member]: `material ${i}` }));
    const read = (await readableKeys(
      { "@context": fedify, publicKey: many("publicKeyPem"), assertionMethod: many("publicKeyMultibase") },
      importers,
    )) as Json;
    expect(calls()).toBe(2 * MAX_PUBLIC_KEYS);
    expect(read.publicKey).toHaveLength(MAX_PUBLIC_KEYS);
    expect(read.assertionMethod).toHaveLength(MAX_PUBLIC_KEYS);
  });
});

describe("the keys Fedify imports as Kopje loads an actor (ID-1, RES-6)", () => {
  it("imports each kept key at most twice, at most MAX_PUBLIC_KEYS of each form, whatever wrappers and arrays hold", async () => {
    const { pem, multibase } = await materials();
    const keys = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, i) => legacy(ACTOR, `${prefix}${i}`, pem));
    const methods = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, i) => multikey(ACTOR, `${prefix}${i}`, multibase));
    // More keys than the cap behind each form Fedify would import every one of: a @set, a nested array, and an entry
    // whose material is an array (a @list counts only as the property's single value, below).
    const hidden = 100;

    const atCap = await loaded(await actorDocument(keys("k", MAX_PUBLIC_KEYS), methods("m", MAX_PUBLIC_KEYS)));
    expect(atCap.ids).toHaveLength(2 * MAX_PUBLIC_KEYS);
    expect(atCap.imports).toBe(2 * 2 * MAX_PUBLIC_KEYS);

    const wrappedDocument = await actorDocument(
      [
        { "@set": keys("s", hidden) },
        keys("n", hidden),
        legacy(
          ACTOR,
          "a",
          Array.from({ length: hidden }, () => pem),
        ),
        ...keys("k", MAX_PUBLIC_KEYS),
      ],
      [
        { "@set": methods("s", hidden) },
        methods("n", hidden),
        multikey(
          ACTOR,
          "a",
          Array.from({ length: hidden }, () => multibase),
        ),
        ...methods("m", MAX_PUBLIC_KEYS),
      ],
    );
    expect(await fedifyImports(wrappedDocument)).toBe(2 * (3 * hidden + MAX_PUBLIC_KEYS));
    const wrapped = await loaded(wrappedDocument);
    const kept = MAX_PUBLIC_KEYS - 3;
    expect(wrapped.ids).toEqual([...keys("k", kept), ...methods("m", kept)].map((entry) => entry.id).toSorted());
    expect(wrapped.imports).toBe(2 * 2 * kept);

    const listedDocument = await actorDocument({ "@list": keys("l", hidden) }, { "@list": methods("l", hidden) });
    expect(await fedifyImports(listedDocument)).toBe(2 * hidden);
    expect(await loaded(listedDocument)).toEqual({ kind: "ok", ids: [], imports: 0 });
  });

  it("keeps an actor usable whose @list holds a key Fedify cannot import", async () => {
    const { pem } = await materials();
    const document = await actorDocument(legacy(ACTOR, "main", pem), {
      "@list": [multikey(ACTOR, "ed", ML_DSA_44_MULTIBASE)],
    });
    await expect(fedifyImports(document)).rejects.toThrow(/./);
    expect(await loaded(document)).toEqual({ kind: "ok", ids: [`${ACTOR}#main`], imports: 2 });
  });

  it("keeps the key whose material is a one-element array or a value object, as Fedify alone reads it", async () => {
    const { pem, multibase } = await materials();
    const served = servedLoader(new RemoteWeb());
    // The algorithms of the keys Fedify 2.4.5 reads from `json`, given every document it asks for as served.
    const fedifyReads = async (json: unknown) => {
      const person = await Person.fromJsonLd(json, { documentLoader: served, contextLoader: served });
      const options = { documentLoader: served, contextLoader: served };
      const algorithms: string[] = [];
      for await (const key of person.getPublicKeys(options)) {
        algorithms.push(key.publicKey?.algorithm.name ?? "none");
      }
      for await (const method of person.getAssertionMethods(options)) {
        algorithms.push(method.publicKey?.algorithm.name ?? "none");
      }
      return algorithms;
    };

    for (const wrap of [(material: string) => [material], (material: string) => ({ "@value": material })]) {
      const document = await actorDocument(legacy(ACTOR, "main", wrap(pem)), multikey(ACTOR, "ed", wrap(multibase)));
      expect(await fedifyReads(document)).toEqual(["RSASSA-PKCS1-v1_5", "Ed25519"]);
      expect(await fedifyReads(await readableKeys(document))).toEqual(["RSASSA-PKCS1-v1_5", "Ed25519"]);
      expect((await loaded(document)).ids).toEqual([`${ACTOR}#ed`, `${ACTOR}#main`]);
    }
  });
});

describe("keyTermsOf: which contexts give the key properties their meaning (ID-1)", () => {
  it("establishes the terms Mastodon's, Fedify's and a GoToSocial-style context define", async () => {
    const { mastodon, fedify } = await contextsOf();
    expect(keyTermsOf(mastodon)).toEqual(["publicKey"]);
    expect(keyTermsOf(fedify)).toEqual(["publicKey", "assertionMethod"]);
    expect(keyTermsOf(["https://gotosocial.org/ns", AS, SECURITY])).toEqual(["publicKey"]);
    expect(keyTermsOf(SECURITY)).toEqual(["publicKey"]);
  });

  it.each(UNRECOGNIZED)("establishes nothing from %s, and leaves the document as fetched", async (_, context) => {
    expect(keyTermsOf(context)).toEqual([]);
    const keys = Array.from({ length: 11 }, (_, i) => ({ id: `${ORIGIN}/u#${i}`, publicKeyPem: UNPARSEABLE_PEM }));
    const document = { "@context": context, id: `${ORIGIN}/u`, publicKey: keys, assertionMethod: keys };
    const copy = structuredClone(document);
    expect(await readableKeys(document)).toBe(document);
    expect(document).toEqual(copy);
  });

  it("establishes nothing from a context past the JSON bounds, or one that is not a JSON-LD context", () => {
    let deep: unknown = {};
    for (let depth = 0; depth < 40; depth++) {
      deep = { nested: deep };
    }
    expect(keyTermsOf([SECURITY, deep])).toEqual([]);
    expect(keyTermsOf([SECURITY, 1])).toEqual([]);
    expect(keyTermsOf([SECURITY, [AS]])).toEqual([]);
    expect(keyTermsOf(undefined)).toEqual([]);
  });

  it("matches the preloaded contexts that define publicKey or assertionMethod, each as the security property", () => {
    // Every definition of either term in every preloaded context, at any depth, with the path to it.
    const found: { url: string; term: string; path: string[]; iri: string | null }[] = [];
    const walk = (url: string, value: unknown, path: string[], prefixes: Json) => {
      if (Array.isArray(value)) {
        value.forEach((v, i) => walk(url, v, [...path, String(i)], prefixes));
        return;
      }
      if (typeof value !== "object" || value === null) {
        return;
      }
      const scope: Json = { ...prefixes, ...(value as Json) };
      for (const [key, inner] of Object.entries(value as Json)) {
        if (key === "publicKey" || key === "assertionMethod") {
          const id = typeof inner === "string" ? inner : ((inner as Json | null)?.["@id"] as string | undefined);
          found.push({ url, term: key, path, iri: id === undefined ? null : expand(id, scope) });
        }
        walk(url, inner, [...path, key], scope);
      }
    };
    for (const [url, document] of Object.entries(preloadedContexts)) {
      walk(url, (document as Json)["@context"], [], {});
    }
    const top = found.filter((f) => !f.path.includes("DataIntegrityProof"));
    for (const term of ["publicKey", "assertionMethod"] as const) {
      const defining = top.filter((f) => f.term === term);
      expect(defining.map((f) => f.url).toSorted()).toEqual([...KEY_TERM_CONTEXTS[term]].toSorted());
      expect(defining.every((f) => f.path.length <= 1)).toBe(true);
      expect(new Set(defining.map((f) => f.iri))).toEqual(new Set([`https://w3id.org/security#${term}`]));
    }
  });
});

// A compact IRI (prefix:suffix) expanded with the prefixes in scope; an absolute IRI as is.
function expand(id: string, scope: Json): string {
  const colon = id.indexOf(":");
  const prefix = colon === -1 ? undefined : scope[id.slice(0, colon)];
  const base = typeof prefix === "string" ? prefix : (prefix as Json | undefined)?.["@id"];
  return typeof base === "string" && !id.slice(colon + 1).startsWith("//") ? `${base}${id.slice(colon + 1)}` : id;
}
