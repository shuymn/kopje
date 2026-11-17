// The activities Fedify LD-signs, as its own sendActivity writes them, for corpus.json (inbox-signed-forms.test.ts):
// each with an RSA key only (a Linked Data signature) and with an Ed25519 key as well (an FEP-8b32 proof too). Run from
// packages/kopje, with the Fedify the lockfile installs:
//
//   node test/fixtures/ld-signed/fedify.mjs > fedify.json
//
// Nothing is sent: fetch is replaced and the bodies POSTed to the inbox are printed as a JSON array of
// { name, sender, received }, the signature value and the proof value replaced by a placeholder. compact.rb then adds
// Mastodon's reading of each.

import { createFederation, generateCryptoKeyPair, MemoryKvStore } from "@fedify/fedify";
import {
  Accept,
  Announce,
  Block,
  Create,
  CryptographicKey,
  Delete,
  Document,
  EmojiReact,
  Follow,
  Hashtag,
  Like,
  Mention,
  Multikey,
  Note,
  Person,
  PUBLIC_COLLECTION,
  Question,
  Tombstone,
  Undo,
  Update,
} from "@fedify/vocab";
import { Temporal } from "temporal-polyfill";

const ORIGIN = "https://fedify.example";
const LOCAL = "https://kopje.test";
const PLACEHOLDER = "placeholder-signature-value";
const actor = new URL(`${ORIGIN}/users/alice`);
const target = new URL(`${LOCAL}/ap/users/alice`);
const status = new URL(`${LOCAL}/ap/o/remote-1`);

const federation = createFederation({
  kv: new MemoryKvStore(),
  allowPrivateAddress: true,
});
const ctx = federation.createContext(new URL(ORIGIN), undefined);

const rsa = await generateCryptoKeyPair("RSASSA-PKCS1-v1_5");
const ed25519 = await generateCryptoKeyPair("Ed25519");
const rsaKey = { keyId: new URL(`${actor.href}#main-key`), privateKey: rsa.privateKey };
const edKey = { keyId: new URL(`${actor.href}#ed25519-key`), privateKey: ed25519.privateKey };

/** @type {{ signature: { signatureValue: string }; proof?: { proofValue: string } }[]} */
const sent = [];
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  if (request.method !== "POST") {
    throw new Error(`unexpected fetch: ${request.url}`);
  }
  sent.push(/** @type {(typeof sent)[number]} */ (await request.json()));
  return new Response(null, { status: 202 });
};

const note = (n, extra = {}) =>
  new Note({
    id: new URL(`${ORIGIN}/notes/${n}`),
    attribution: actor,
    to: PUBLIC_COLLECTION,
    ccs: [new URL(`${actor.href}/followers`)],
    published: Temporal.Instant.from("2026-11-16T12:00:00Z"),
    ...extra,
  });

const activities = {
  "Create(Note)": new Create({
    id: new URL(`${ORIGIN}/notes/1/create`),
    actor,
    to: PUBLIC_COLLECTION,
    ccs: [new URL(`${actor.href}/followers`), target],
    object: note(1, {
      ccs: [new URL(`${actor.href}/followers`), target],
      content: '<p>Hello <a href="https://kopje.test/@alice" class="mention">@alice</a> #kopje</p>',
      tags: [
        new Mention({ href: target, name: "@alice@kopje.test" }),
        new Hashtag({ href: new URL(`${ORIGIN}/tags/kopje`), name: "#kopje" }),
      ],
      attachments: [
        new Document({
          mediaType: "image/png",
          url: new URL(`${ORIGIN}/media/1.png`),
          name: "An image",
          width: 640,
          height: 480,
        }),
      ],
      sensitive: false,
    }),
  }),
  "Update(Person)": new Update({
    id: new URL(`${actor.href}#update`),
    actor,
    to: PUBLIC_COLLECTION,
    object: new Person({
      id: actor,
      preferredUsername: "alice",
      name: "Alice",
      summary: "<p>Bio</p>",
      inbox: new URL(`${actor.href}/inbox`),
      outbox: new URL(`${actor.href}/outbox`),
      followers: new URL(`${actor.href}/followers`),
      following: new URL(`${actor.href}/following`),
      manuallyApprovesFollowers: false,
      discoverable: true,
      publicKey: new CryptographicKey({ id: rsaKey.keyId, owner: actor, publicKey: rsa.publicKey }),
      assertionMethod: new Multikey({ id: edKey.keyId, controller: actor, publicKey: ed25519.publicKey }),
    }),
  }),
  Follow: new Follow({ id: new URL(`${ORIGIN}/follows/1`), actor, object: target }),
  Like: new Like({ id: new URL(`${ORIGIN}/likes/1`), actor, object: status }),
  Announce: new Announce({
    id: new URL(`${ORIGIN}/announces/1`),
    actor,
    object: status,
    to: PUBLIC_COLLECTION,
    cc: new URL(`${actor.href}/followers`),
  }),
  "Undo(Follow)": new Undo({
    id: new URL(`${ORIGIN}/follows/1/undo`),
    actor,
    object: new Follow({ id: new URL(`${ORIGIN}/follows/1`), actor, object: target }),
  }),
  "Delete(Note)": new Delete({
    id: new URL(`${ORIGIN}/notes/2/delete`),
    actor,
    to: PUBLIC_COLLECTION,
    object: new Tombstone({ id: new URL(`${ORIGIN}/notes/2`) }),
  }),
  "Accept(Follow)": new Accept({
    id: new URL(`${ORIGIN}/accepts/1`),
    actor,
    object: new Follow({ id: new URL(`${LOCAL}/ap/follows/1`), actor: target, object: actor }),
  }),
  Block: new Block({ id: new URL(`${ORIGIN}/blocks/1`), actor, object: target }),
  "Create(Question)": new Create({
    id: new URL(`${ORIGIN}/notes/3/create`),
    actor,
    to: PUBLIC_COLLECTION,
    object: new Question({
      id: new URL(`${ORIGIN}/notes/3`),
      attribution: actor,
      to: PUBLIC_COLLECTION,
      content: "<p>A poll</p>",
      exclusiveOptions: [new Note({ name: "Yes" }), new Note({ name: "No" })],
      endTime: Temporal.Instant.from("2026-11-17T12:00:00Z"),
      voters: 0,
    }),
  }),
  EmojiReact: new EmojiReact({ id: new URL(`${ORIGIN}/reacts/1`), actor, object: status, content: "👍" }),
};

const out = [];
for (const [name, activity] of Object.entries(activities)) {
  for (const [variant, keys] of Object.entries({ RSA: [rsaKey], "RSA and Ed25519": [rsaKey, edKey] })) {
    sent.length = 0;
    await ctx.sendActivity(keys, { id: target, inboxId: new URL(`${LOCAL}/inbox`) }, activity, { immediate: true });
    const [received] = sent;
    received.signature.signatureValue = PLACEHOLDER;
    if (received.proof !== undefined) {
      received.proof.proofValue = PLACEHOLDER;
    }
    out.push({ name: `${name}, ${variant}`, sender: "fedify-2.4.5", received });
  }
}
console.log(JSON.stringify(out, null, 2));
