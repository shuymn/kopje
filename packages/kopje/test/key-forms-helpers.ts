import {
  type DocumentLoader,
  exportSpki,
  type KeyCache,
  preloadedContexts,
  verifyRequestDetailed,
} from "@fedify/fedify";
import { CryptographicKey } from "@fedify/vocab";
import { Temporal } from "temporal-polyfill";

import { bytesToBase64 } from "../src/security/key-wrap";
import { NOW } from "./app-helpers";
import { AP, LOCAL, type RemoteWeb } from "./inbox-helpers";

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

// The init of a POST of `activity` to `path` with a draft-cavage signature (hs2019, the algorithm Mastodon names) by
// `keyId` over (request-target), host, date and digest, as Mastodon signs; its signature bytes are not a signature by
// any key, since a key that is not RSA makes Fedify 2.4.5 throw before it compares them.
export async function cavageByKeyId(keyId: string, path: string, activity: unknown): Promise<RequestInit> {
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
