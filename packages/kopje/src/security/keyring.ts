import { signRequest } from "@fedify/fedify";

import { importPrivateKey, importPublicKeyPem, RSA_ALGORITHM, unwrapPkcs8, type WrappedKey } from "./key-wrap";

// An actor whose private key this instance holds: a local user or the instance actor. The wrapped key and the
// authoritative public key come from the Store as stored.
export type KeyOwner = WrappedKey & { keyId: URL; pubkey: string };

// How an outgoing request is signed as one actor, as Mastodon 4.7's Request#perform signs it: `sign` with draft-cavage
// HTTP Signatures (RSA-SHA256), and `retry`, for the one more send of a request answered 400 or 401, with an RFC 9421
// signature by the same key over @method, @target-uri and, with a body, content-digest. Each signs an unsigned request.
export type RequestSigning = {
  readonly sign: (request: Request) => Promise<Request>;
  readonly retry: (request: Request) => Promise<Request>;
};

// One actor's signing. keyPair is there only because Fedify's key pairs dispatcher and authenticated document loader
// take a CryptoKeyPair; nothing else reads it.
export type Signer = RequestSigning & {
  readonly keyId: URL;
  readonly keyPair: CryptoKeyPair;
};

// The keyring: given an actor, a signer for it. Private keys are unwrapped per call and never cached (a
// memoized extractable key would stay in memory for the isolate's lifetime, for no measured gain).
export type Keyring = { signerFor(actor: KeyOwner): Promise<Signer> };

// The KEK is the USER_KEK secret. An empty string is a legal KEK (legacy instances used it); healthReport warns.
export function createKeyring(kek: string): Keyring {
  return {
    async signerFor(actor) {
      const privateKey = await importPrivateKey(await unwrapPkcs8(kek, actor));
      const publicKey = await importPublicKeyPem(actor.pubkey);
      return {
        keyId: actor.keyId,
        keyPair: { privateKey, publicKey },
        ...requestSigner(actor.keyId, privateKey),
      };
    },
  };
}

// Mastodon 4.7's RFC 9421 components (request.rb perform_rfc9421_signed_request); Fedify adds content-digest to them
// for a request with a body.
const RFC9421_COMPONENTS = [
  { value: "@method", params: {} },
  { value: "@target-uri", params: {} },
];

// Signing as a key, also one Fedify hands back (its authenticated document loader receives the pair from signerFor).
export function requestSigner(keyId: URL, privateKey: CryptoKey): RequestSigning {
  return {
    sign: (request) => signRequest(request, privateKey, keyId, { spec: "draft-cavage-http-signatures-12" }),
    retry: (request) =>
      signRequest(request, privateKey, keyId, { spec: "rfc9421", rfc9421: { components: RFC9421_COMPONENTS } }),
  };
}

export type KeyCheck = "ok" | "unwrap-failed" | "pubkey-mismatch";

const PROBE = new TextEncoder().encode("kopje key check");

// Whether the actor's key unwraps with this KEK and a signature made with it verifies against the stored public key.
export async function checkKey(kek: string, actor: WrappedKey & { pubkey: string }): Promise<KeyCheck> {
  let signature: ArrayBuffer;
  try {
    const privateKey = await importPrivateKey(await unwrapPkcs8(kek, actor));
    signature = await crypto.subtle.sign(RSA_ALGORITHM, privateKey, PROBE);
  } catch {
    return "unwrap-failed";
  }
  try {
    const publicKey = await importPublicKeyPem(actor.pubkey);
    return (await crypto.subtle.verify(RSA_ALGORITHM, publicKey, signature, PROBE)) ? "ok" : "pubkey-mismatch";
  } catch {
    return "pubkey-mismatch";
  }
}
