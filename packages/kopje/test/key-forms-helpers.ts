import {
  type DocumentLoader,
  encodeMultibase,
  exportSpki,
  type KeyCache,
  preloadedContexts,
  verifyRequestDetailed,
} from "@fedify/fedify";
import { CryptographicKey, Multikey, Person } from "@fedify/vocab";
import { Temporal } from "temporal-polyfill";

import { bytesToBase64, RSA_ALGORITHM } from "../src/security/key-wrap";
import { NOW } from "./app-helpers";
import { AP, LOCAL, MASTODON, type RemoteWeb, serveOwnHandle, type TestActor } from "./inbox-helpers";
import { contexts } from "./quote-helpers";

// The key and signature forms an actor of Mastodon 4.7's reading may use (docs/threat-model.md ID-1), each built from
// its sender's source: Ed25519 keys, a draft-cavage signature naming a key that is not RSA, and an Ed25519 RFC 9421
// signer of the form Mastodon 4.7's verifier requires. Nothing is fetched from a real server.

const edPairs = new Map<number, Promise<CryptoKeyPair>>();

// Ed25519 key pairs, generated once per test file and shared by index.
export function ed25519Pair(index = 0): Promise<CryptoKeyPair> {
  let pair = edPairs.get(index);
  if (pair === undefined) {
    pair = crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as Promise<CryptoKeyPair>;
    edPairs.set(index, pair);
  }
  return pair;
}

// An Ed25519 key as an actor document lists it: its id, its private half and its PEM-SPKI.
export type Ed25519Key = { keyId: string; privateKey: CryptoKey; publicKey: CryptoKey; pem: string };

export async function ed25519Key(keyId: string, index = 0): Promise<Ed25519Key> {
  const pair = await ed25519Pair(index);
  return { keyId, privateKey: pair.privateKey, publicKey: pair.publicKey, pem: await exportSpki(pair.publicKey) };
}

const rsaPairs = new Map<number, Promise<CryptoKeyPair>>();

// RSA key pairs (RSASSA-PKCS1-v1_5, SHA-256, as Mastodon's and Fedify's), generated once per test file by index.
export function rsaPair(index = 0): Promise<CryptoKeyPair> {
  let pair = rsaPairs.get(index);
  if (pair === undefined) {
    pair = crypto.subtle.generateKey(
      { ...RSA_ALGORITHM, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
      true,
      ["sign", "verify"],
    ) as Promise<CryptoKeyPair>;
    rsaPairs.set(index, pair);
  }
  return pair;
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

// Keys Mastodon 4.7 reads (Multibase.decode_key_to_pem, multibase.rb:51-72) but Fedify 2.4.5 cannot import, or reads
// otherwise, as a Multikey's publicKeyMultibase or a legacy key's publicKeyPem:
//   - an ML-DSA-44 key: base58btc of the multicodec mldsa-44-pub (0x1210, varint 0x90 0x24) and 1312 fixed bytes;
//   - an unknown multicodec: secp256k1-pub (0xe7, varint 0xe7 0x01) and 33 fixed bytes;
//   - an EC P-256 PEM-SPKI, and a PEM that does not parse.
export const ML_DSA_44_MULTIBASE = text(
  encodeMultibase("base58btc", new Uint8Array([0x90, 0x24, ...new Uint8Array(1312).fill(0x2a)])),
);
export const UNKNOWN_MULTIBASE = text(
  encodeMultibase("base58btc", new Uint8Array([0xe7, 0x01, ...new Uint8Array(33).fill(0x02)])),
);
export const UNPARSEABLE_PEM = "-----BEGIN PUBLIC KEY-----\nnot base64 at all!\n-----END PUBLIC KEY-----\n";

export async function ecPem(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const spki = new Uint8Array((await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer);
  const lines = bytesToBase64(spki)
    .match(/.{1,64}/g)!
    .join("\n");
  return `-----BEGIN PUBLIC KEY-----\n${lines}\n-----END PUBLIC KEY-----\n`;
}

// An Ed25519 key as a `u`-prefixed (base64url) Multikey, which Mastodon 4.7 and Fedify both read.
export async function base64urlMultibase(publicKey: CryptoKey): Promise<string> {
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", publicKey)) as ArrayBuffer);
  return text(encodeMultibase("base64url", new Uint8Array([0xed, 0x01, ...raw])));
}

type Json = Record<string, unknown>;

// An actor as a Fedify-based sender writes it (Person#toJsonLd, its @context as Fedify writes it): an RSA legacy key
// #main-key (its draft-cavage signatures), and FEP-521a Multikeys in assertionMethod, an Ed25519 one #ed25519-key and an
// RSA one #rsa-key. Served on `web` as application/activity+json. `actor` signs with the legacy key (signedInit).
export async function multikeyActor(web: RemoteWeb, username: string, options: { origin?: string; key?: number } = {}) {
  const index = options.key ?? 0;
  const uri = `${options.origin ?? MASTODON}/users/${username}`;
  const main = await rsaPair(2 * index);
  const rsa = await rsaPair(2 * index + 1);
  const ed = await ed25519Key(`${uri}#ed25519-key`, index);
  const person = new Person({
    id: new URL(uri),
    preferredUsername: username,
    inbox: new URL(`${uri}/inbox`),
    publicKey: new CryptographicKey({ id: new URL(`${uri}#main-key`), owner: new URL(uri), publicKey: main.publicKey }),
    assertionMethods: [
      new Multikey({ id: new URL(ed.keyId), controller: new URL(uri), publicKey: ed.publicKey }),
      new Multikey({ id: new URL(`${uri}#rsa-key`), controller: new URL(uri), publicKey: rsa.publicKey }),
    ],
  });
  const document = (await person.toJsonLd({ format: "compact", contextLoader: contexts })) as Json;
  web.serve(uri, document);
  serveOwnHandle(web, document);
  const actor: TestActor = {
    uri,
    keyId: `${uri}#main-key`,
    privateKey: main.privateKey,
    pem: await exportSpki(main.publicKey),
    document,
  };
  const rsaKey = {
    keyId: `${uri}#rsa-key`,
    privateKey: rsa.privateKey,
    publicKey: rsa.publicKey,
    pem: await exportSpki(rsa.publicKey),
  };
  return { actor, ed, rsa: rsaKey, document };
}

// The init of a POST of `activity` with a draft-cavage signature (hs2019, the algorithm Mastodon names) by
// `keyId` over (request-target), host, date and digest, as Mastodon signs; its signature bytes are not a signature by
// any key, since a key that is not RSA makes Fedify 2.4.5 throw before it compares them.
export async function cavageByKeyId(keyId: string, activity: unknown): Promise<RequestInit> {
  const body = JSON.stringify(activity);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)));
  const headers = new Headers({
    "content-type": AP,
    host: new URL(LOCAL).host,
    date: new Date(NOW).toUTCString(),
    digest: `SHA-256=${bytesToBase64(digest)}`,
  });
  const signature = bytesToBase64(new Uint8Array(64).fill(7));
  headers.set(
    "signature",
    `keyId="${keyId}",algorithm="hs2019",headers="(request-target) host date digest",signature="${signature}"`,
  );
  return { method: "POST", headers, body };
}

export type Rfc9421Options = {
  // The alg parameter, absent by default (Linzer's signer, which Mastodon 4.7 uses, writes none).
  alg?: string;
  // The covered components, by default Mastodon 4.7's for a POST.
  components?: string[];
  at?: number;
  // The signing algorithm, by default Ed25519.
  algorithm?: Parameters<typeof crypto.subtle.sign>[0];
};

// The init of a POST of `activity` to `path` with an RFC 9421 signature `sig1` by `keyId` (RFC 9421 §2.5's signature
// base over `@method`, `@target-uri` and `content-digest`, with created and keyid, as Mastodon 4.7's verifier requires,
// SignedRequest::HttpMessageSignature), signed with WebCrypto, and the Content-Digest of the body (RFC 9530, sha-256).
// Fedify signs with RSA only, so the helper writes the signature itself.
export async function rfc9421Init(
  keyId: string,
  privateKey: CryptoKey,
  path: string,
  activity: unknown,
  options: Rfc9421Options = {},
): Promise<RequestInit> {
  const body = JSON.stringify(activity);
  const url = `${LOCAL}${path}`;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)));
  const headers = new Headers({ "content-type": AP, "content-digest": `sha-256=:${bytesToBase64(digest)}:` });
  const components = options.components ?? ["@method", "@target-uri", "content-digest"];
  const created = Math.floor((options.at ?? NOW) / 1000);
  const params = `created=${created};keyid="${keyId}"${options.alg === undefined ? "" : `;alg="${options.alg}"`}`;
  const list = `(${components.map((c) => `"${c}"`).join(" ")})`;
  const values: Record<string, string> = {
    "@method": "POST",
    "@target-uri": url,
    "content-digest": headers.get("content-digest")!,
  };
  const base = [...components.map((c) => `"${c}": ${values[c]}`), `"@signature-params": ${list};${params}`].join("\n");
  const signature = new Uint8Array(
    await crypto.subtle.sign(options.algorithm ?? "Ed25519", privateKey, new TextEncoder().encode(base)),
  );
  headers.set("signature-input", `sig1=${list};${params}`);
  headers.set("signature", `sig1=:${bytesToBase64(signature)}:`);
  return { method: "POST", headers, body };
}

// The documents `web` serves, and Fedify's preloaded contexts, as a document loader Fedify alone can use (no fetch, no
// policy): what a receiver that trusts every document as served would see.
export function servedLoader(web: RemoteWeb): DocumentLoader {
  return (url: string) => {
    if (url in preloadedContexts) {
      return Promise.resolve({ contextUrl: null, documentUrl: url, document: preloadedContexts[url] });
    }
    const bare = url.split("#")[0]!;
    const served = web.served.get(bare);
    return served?.status === 200
      ? Promise.resolve({ contextUrl: null, documentUrl: bare, document: served.body })
      : Promise.reject(new Error(`not served: ${bare}`));
  };
}

// Fedify 2.4.5 alone verifying a POST to /inbox at NOW: the documents `web` serves and, when given, `key` served from a
// KeyCache under its id (as a key Fedify cannot find by its own fetch would be).
export function fedifyAlone(
  web: RemoteWeb,
  init: RequestInit,
  key?: { keyId: string; owner: string; publicKey: CryptoKey },
) {
  const keyCache: KeyCache | undefined =
    key === undefined
      ? undefined
      : {
          get: (id) =>
            Promise.resolve(
              id.href === key.keyId
                ? new CryptographicKey({ id, owner: new URL(key.owner), publicKey: key.publicKey })
                : undefined,
            ),
          set: () => Promise.resolve(),
        };
  return verifyRequestDetailed(new Request(`${LOCAL}/inbox`, init), {
    documentLoader: servedLoader(web),
    contextLoader: servedLoader(web),
    ...(keyCache === undefined ? {} : { keyCache }),
    currentTime: Temporal.Instant.fromEpochMilliseconds(NOW),
  });
}
