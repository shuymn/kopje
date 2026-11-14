import { preloadedContexts } from "@fedify/fedify";
import { describe, expect, it } from "vitest";

import {
  KEY_TERM_CONTEXTS,
  type KeyImporters,
  keyTermsOf,
  MAX_PUBLIC_KEYS,
  readableKeys,
} from "../src/federation/key-entries";
import { mastodonActor, RemoteWeb } from "./inbox-helpers";
import {
  base64urlMultibase,
  ecPem,
  ed25519Pair,
  ML_DSA_44_MULTIBASE,
  multikeyActor,
  UNKNOWN_MULTIBASE,
  UNPARSEABLE_PEM,
} from "./key-forms-helpers";

// key-entries.ts (ID-1, RES-6): which entries of a fetched document's publicKey and assertionMethod Kopje reads, and
// which contexts establish what the two properties mean.

type Json = Record<string, unknown>;

const AS = "https://www.w3.org/ns/activitystreams";
const SECURITY = "https://w3id.org/security/v1";
const ORIGIN = "https://mastodon.example";

async function contextsOf() {
  const web = new RemoteWeb();
  const mastodon = (await mastodonActor(web, "bob")).document["@context"];
  const fedify = (await multikeyActor(web, "carol")).document["@context"];
  return { mastodon, fedify };
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
    const legacy = (id: string, publicKeyPem: unknown) => ({
      id: `${ORIGIN}/u#${id}`,
      owner: `${ORIGIN}/u`,
      publicKeyPem,
    });
    const multikey = (id: string, publicKeyMultibase: unknown) => ({
      id: `${ORIGIN}/u#${id}`,
      type: "Multikey",
      controller: `${ORIGIN}/u`,
      publicKeyMultibase,
    });
    const good = legacy("main", pem);
    const ec = legacy("ec", await ecPem());
    const ed25519 = multikey("ed", await base64urlMultibase(ed.publicKey));
    const reference = `${ORIGIN}/keys/1`;
    const publicKeys = [reference, ec, null, good, legacy("bad", UNPARSEABLE_PEM), legacy("number", 42), { id: "x" }];
    const methods = [
      multikey("mldsa", ML_DSA_44_MULTIBASE),
      null,
      ed25519,
      reference,
      multikey("k1", UNKNOWN_MULTIBASE),
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
