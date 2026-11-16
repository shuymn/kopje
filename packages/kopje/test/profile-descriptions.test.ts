import { Person } from "@fedify/vocab";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { type Account, MAX_DISPLAY_NAME, partialAccountsOf, presentAccountsWithin } from "../src/domain/accounts";
import { jsonBytes } from "../src/domain/answer-budget";
import { ACCOUNT_STALE_MS } from "../src/domain/remote-actors";
import { DOCUMENT_BODY_LIMIT } from "../src/federation/loader";
import { remoteActorInput } from "../src/federation/remote-actor";
import { PROFILE_DESCRIPTION_BYTES, PROFILE_DESCRIPTION_LIMIT } from "../src/platform/stored-bounds";
import { bearer, json, seedAccount, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { PNG_PLAIN } from "./fixtures/images";
import { MASTODON, mastodonActor, type TestActor } from "./inbox-helpers";
import {
  accountId,
  announce,
  AS,
  followed,
  mastodonNote,
  nextId,
  OTHER,
  type Setup,
  setup,
} from "./inbox-status-helpers";
import { bytes, multipartForm, TestCodec } from "./media-helpers";
import { aliceWithFollower } from "./profile-fixtures";
import { ageAccount } from "./stale-author-helpers";
import { community, getJson, outbound } from "./status-helpers";

// Account#avatar_description and #header_description (migration 0097_profile_descriptions; Mastodon 4.6,
// REST::AccountSerializer): presented on every Account and CredentialAccount, '' while the account is unavailable and
// again after, cut at PROFILE_DESCRIPTION_LIMIT code points after decoding; PartialAccount carries the avatar's.
// Written through update_credentials (Mastodon 4.6.1), at most PROFILE_DESCRIPTION_LIMIT code points as sent, and read
// from a remote actor's icon and image as Mastodon 4.7 reads them, cut at PROFILE_DESCRIPTION_LIMIT.
// Independent of the images, as in Mastodon: removing or replacing an image keeps its description.

const ORIGIN = "https://kopje.test";

type Shown = Pick<Account, "avatar_description" | "header_description"> & { suspended?: true };

async function fixture() {
  const h = await community(["alice", "bob"]);
  const remote = await seedAccount(h.store, { username: "erin", domain: "remote.example" });
  const describe = (id: string, avatar: string | ArrayBuffer, header: string | ArrayBuffer) =>
    sql(
      h.store,
      `UPDATE accounts SET avatar_description = CAST(?1 AS TEXT), header_description = CAST(?2 AS TEXT) WHERE id = ?3`,
      avatar,
      header,
      id,
    );
  const shown = async (id: string) => (await getJson<Shown>(h, `/api/v1/accounts/${id}`, h.users.bob.token)).body;
  // An account as presented by id, an unavailable one included (with_suspended).
  const presented = (id: string) =>
    runInDurableObject(
      h.store,
      (_instance, state) =>
        presentAccountsWithin(new Db(state.storage.sql), [id], { origin: ORIGIN }, Infinity, true).items[0] as Shown,
    );
  const partial = (id: string) =>
    runInDurableObject(h.store, (_instance, state) => [
      ...partialAccountsOf(new Db(state.storage.sql), [id], { origin: ORIGIN }),
    ]);
  return { h, remote, describe, shown, presented, partial };
}

const descriptions = (account: Shown) => [account.avatar_description, account.header_description];

describe("profile image descriptions", () => {
  it("are presented on the Account, the CredentialAccount and the PartialAccount, '' for none", async () => {
    const { h, remote, describe, shown, partial } = await fixture();
    const { alice } = h.users;
    expect(descriptions(await shown(alice.id))).toEqual(["", ""]);
    await describe(alice.id, "A cat", "A field");
    await describe(remote, "𠀀 avatar", "header");
    expect(descriptions(await shown(alice.id))).toEqual(["A cat", "A field"]);
    expect(descriptions(await shown(remote))).toEqual(["𠀀 avatar", "header"]);
    const credential = (await getJson<Shown>(h, "/api/v1/accounts/verify_credentials", alice.token)).body;
    expect(descriptions(credential)).toEqual(["A cat", "A field"]);
    expect(await partial(remote)).toEqual([expect.objectContaining({ id: remote, avatar_description: "𠀀 avatar" })]);
  });

  it("are '' while the account is unavailable, and shown again once it is available", async () => {
    const { h, remote, describe, shown, presented, partial } = await fixture();
    const { alice } = h.users;
    await describe(alice.id, "A cat", "A field");
    await describe(remote, "avatar", "header");
    // Local suspension and unsuspension.
    await sql(h.store, "UPDATE local_accounts SET suspended_at = '2026-01-01' WHERE account_id = ?", alice.id);
    expect(await shown(alice.id)).toMatchObject({ suspended: true, avatar_description: "", header_description: "" });
    expect(await partial(alice.id)).toEqual([expect.objectContaining({ avatar_description: "" })]);
    await sql(h.store, "UPDATE local_accounts SET suspended_at = NULL WHERE account_id = ?", alice.id);
    expect(descriptions(await shown(alice.id))).toEqual(["A cat", "A field"]);
    // A suspended remote account, and one whose deletion has started.
    expect(descriptions(await presented(remote))).toEqual(["avatar", "header"]);
    for (const { make, full, partialAccount, reset } of [
      {
        make: "UPDATE accounts SET suspended_at = '2026-01-01', suspension_source = 'account' WHERE id = ?",
        full: { suspended: true, avatar_description: "", header_description: "" },
        partialAccount: [expect.objectContaining({ avatar_description: "" })],
        reset: "UPDATE accounts SET suspended_at = NULL, suspension_source = NULL WHERE id = ?",
      },
      {
        make: "UPDATE accounts SET deleted_at = '2026-01-01' WHERE id = ?",
        full: { suspended: true, avatar_description: "", header_description: "" },
      },
    ]) {
      await sql(h.store, make, remote);
      expect(await presented(remote), make).toMatchObject(full);
      if (partialAccount !== undefined) {
        expect(await partial(remote), make).toEqual(partialAccount);
      }
      if (reset !== undefined) {
        await sql(h.store, reset, remote);
        expect(descriptions(await presented(remote)), reset).toEqual(["avatar", "header"]);
      }
    }
    // Stored all along.
    expect(
      await sql(
        h.store,
        "SELECT avatar_description AS a FROM accounts WHERE id IN (?, ?) ORDER BY id",
        alice.id,
        remote,
      ),
    ).toEqual([{ a: "A cat" }, { a: "avatar" }]);
  });

  it("are cut at PROFILE_DESCRIPTION_LIMIT code points after decoding, 902 JSON bytes at most", async () => {
    const { remote, describe, shown, partial } = await fixture();
    // 0xFF and 599 continuation bytes: within 0097's trigger (one character), 600 U+FFFD once decoded.
    const malformed = new Uint8Array(PROFILE_DESCRIPTION_BYTES).fill(0x80);
    malformed[0] = 0xff;
    const escaped = "\u0001".repeat(PROFILE_DESCRIPTION_LIMIT);
    await describe(remote, malformed.buffer, escaped);
    const account = await shown(remote);
    expect(descriptions(account)).toEqual(["�".repeat(PROFILE_DESCRIPTION_LIMIT), escaped]);
    expect([jsonBytes(account.avatar_description), jsonBytes(account.header_description)]).toEqual([452, 902]);
    expect((await partial(remote))[0]!.avatar_description).toBe("�".repeat(PROFILE_DESCRIPTION_LIMIT));
  });

  it("stay when the image is removed", async () => {
    const { h, describe, shown } = await fixture();
    const { alice } = h.users;
    await sql(
      h.store,
      "UPDATE accounts SET avatar_url = 'https://kopje.test/media/AAAA/full.webp', header_url = 'https://kopje.test/media/BBBB/full.webp' WHERE id = ?",
      alice.id,
    );
    await describe(alice.id, "A cat", "A field");
    for (const kind of ["avatar", "header"]) {
      const removed = await h.request(`/api/v1/profile/${kind}`, bearer(alice.token, { method: "DELETE" }));
      expect(removed.status).toBe(200);
      expect(await removed.json()).toMatchObject({ avatar_description: "A cat", header_description: "A field" });
    }
    expect((await shown(alice.id)).avatar_description).toBe("A cat");
    expect(await sql(h.store, "SELECT avatar_url, header_url FROM accounts WHERE id = ?", alice.id)).toEqual([
      { avatar_url: null, header_url: null },
    ]);
  });
});

describe("profile image descriptions through update_credentials", () => {
  type Answer = Shown & { error?: string; avatar?: string };

  async function writer(deps: Parameters<typeof aliceWithFollower>[0] = {}) {
    const h = await aliceWithFollower(deps);
    const { alice } = h.users;
    const patch = async (body: BodyInit | Record<string, unknown>) => {
      const init = body instanceof FormData ? { method: "PATCH", body } : json(body, { method: "PATCH" });
      const response = await h.request("/api/v1/accounts/update_credentials", bearer(alice.token, init));
      return { status: response.status, body: await response.json<Answer>() };
    };
    const stored = async () =>
      (
        await sql<{ a: string; h: string }>(
          h.store,
          "SELECT avatar_description AS a, header_description AS h FROM accounts WHERE id = ?",
          alice.id,
        )
      ).map((row) => [row.a, row.h])[0];
    return { h, alice, patch, stored };
  }

  it("are stored as sent and shown on the CredentialAccount and the Account; '' clears one, an absent one is kept", async () => {
    const { h, alice, patch, stored } = await writer();
    const written = await patch({ avatar_description: " A cat\r\n", header_description: "A field" });
    expect(written.status).toBe(200);
    expect(descriptions(written.body)).toEqual([" A cat\r\n", "A field"]);
    expect(descriptions((await getJson<Shown>(h, `/api/v1/accounts/${alice.id}`, alice.token)).body)).toEqual([
      " A cat\r\n",
      "A field",
    ]);
    expect(descriptions((await patch({ avatar_description: "" })).body)).toEqual(["", "A field"]);
    expect(descriptions((await patch({ display_name: "Alice" })).body)).toEqual(["", "A field"]);
    expect(await stored()).toEqual(["", "A field"]);
  });

  // A JSON scalar reads as JSON writes it, as every text parameter does: a number as Mastodon stores it too, a boolean
  // where Mastodon casts it to `t` or `f` (docs/mastodon-deviations.md).
  it("store a JSON boolean or number as JSON writes it", async () => {
    const { patch, stored } = await writer();
    const written = await patch({ avatar_description: true, header_description: 42 });
    expect(written.status).toBe(200);
    expect(descriptions(written.body)).toEqual(["true", "42"]);
    expect(await stored()).toEqual(["true", "42"]);
    expect(descriptions((await patch({ avatar_description: false })).body)).toEqual(["false", "42"]);
  });

  it("refuse past PROFILE_DESCRIPTION_LIMIT code points with Mastodon's messages, before the display name's", async () => {
    const { patch, stored } = await writer();
    const refused = await patch({
      display_name: "x".repeat(MAX_DISPLAY_NAME + 1),
      avatar_description: "𠀀".repeat(PROFILE_DESCRIPTION_LIMIT + 1),
      header_description: `${"\u0001".repeat(PROFILE_DESCRIPTION_LIMIT)}\u0000`,
    });
    expect(refused).toEqual({
      status: 422,
      body: {
        error:
          "Validation failed: Avatar description is too long (maximum is 150 characters), " +
          "Header description is too long (maximum is 150 characters), " +
          "Display name is too long (maximum is 40 characters)",
        details: {
          avatar_description: [{ error: "ERR_TOO_LONG", description: "is too long (maximum is 150 characters)" }],
          header_description: [{ error: "ERR_TOO_LONG", description: "is too long (maximum is 150 characters)" }],
          display_name: [{ error: "ERR_TOO_LONG", description: "is too long (maximum is 40 characters)" }],
        },
      },
    });
    expect(await stored()).toEqual(["", ""]);
    // At the limit: four-byte characters at the stored bytes' bound, and a NUL counted, then dropped when stored.
    const taken = await patch({
      avatar_description: "𠀀".repeat(PROFILE_DESCRIPTION_LIMIT),
      header_description: `${"\u0001".repeat(PROFILE_DESCRIPTION_LIMIT - 1)}\u0000`,
    });
    expect(taken.status).toBe(200);
    expect(descriptions(taken.body)).toEqual([
      "𠀀".repeat(PROFILE_DESCRIPTION_LIMIT),
      "\u0001".repeat(PROFILE_DESCRIPTION_LIMIT - 1),
    ]);
    expect(await stored()).toEqual(descriptions(taken.body));
  });

  it("stay when a new image replaces the old one", async () => {
    const codec = new TestCodec();
    const { patch, stored } = await writer({ images: () => codec });
    await patch({ avatar_description: "A cat", header_description: "A field" });
    const png = (name: string) => new File([bytes(PNG_PLAIN)], name, { type: "image/png" });
    for (let i = 0; i < 2; i++) {
      const replaced = await patch(
        multipartForm([
          ["avatar", png(`a${i}.png`)],
          ["header", png(`h${i}.png`)],
        ]),
      );
      expect(replaced.status).toBe(200);
      expect(replaced.body.avatar).toContain("/media/");
      expect(descriptions(replaced.body)).toEqual(["A cat", "A field"]);
    }
    expect(await stored()).toEqual(["A cat", "A field"]);
  });

  // The actor publishes a description as its image's `summary` (federation.ts image): a change of a description alone
  // records an Update(Person) while the image exists, and none without it, as the document changes only then.
  it("send an Update carrying the summary when only a description changes, while the image exists", async () => {
    const { h, alice, patch } = await writer();
    const sent = async () => (await outbound(h.store)).filter((o) => o.activity.type === "Update");
    expect((await patch({ avatar_description: "A cat", header_description: "A field" })).status).toBe(200);
    expect(await sent()).toEqual([]);
    for (const [kind, key] of [
      ["avatar", "icon"],
      ["header", "image"],
    ] as const) {
      await sql(
        h.store,
        `UPDATE accounts SET ${kind}_url = 'https://kopje.test/media/${kind}.webp' WHERE id = ?`,
        alice.id,
      );
      expect((await patch({ [`${kind}_description`]: `${kind} described` })).status).toBe(200);
      const object = (await sent()).at(-1)?.activity.object as Record<string, unknown> | undefined;
      expect(object?.[key], kind).toEqual({
        type: "Image",
        url: `https://kopje.test/media/${kind}.webp`,
        summary: `${kind} described`,
      });
    }
  });
});

describe("remote profile image descriptions", () => {
  type Remote = Shown & Pick<Account, "show_featured" | "show_media" | "show_media_replies">;
  // An actor's icon and image as Mastodon 4.7 renders them (ActivityPub::ImageSerializer), the description as summary
  // when one is set; the avatar's description is given, the header's as its name, which Mastodon reads when the summary
  // gives none.
  const images = (origin: string, name: string, avatar?: string, header?: string) => ({
    icon: { type: "Image", mediaType: "image/png", url: `${origin}/avatars/${name}.png`, summary: avatar },
    image: { type: "Image", mediaType: "image/png", url: `${origin}/headers/${name}.png`, name: header },
  });
  const updateOf = (actor: TestActor) => ({
    "@context": AS,
    id: `${actor.uri}#updates/${nextId()}`,
    type: "Update",
    actor: actor.uri,
    object: actor.document,
  });
  const shown = async (t: Setup, uri: string) => {
    const { status, body } = await t.api<Remote>(`/api/v1/accounts/${await accountId(t.store, uri)}`);
    expect(status).toBe(200);
    const { avatar_description, header_description, show_featured, show_media, show_media_replies } = body;
    return [avatar_description, header_description, show_featured, show_media, show_media_replies];
  };

  // Every path that stores a remote actor's document goes through upsertRemoteActor with remoteActorInput's input: here
  // an activity's actor (a Follow, then an Update(Person)), the unknown author of a boosted status, and that author
  // refetched once stale (applyRefresh).
  it("reads a remote actor's descriptions from every document the inbox stores; one without them clears them", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob", {
      extra: { ...images(MASTODON, "bob", "A cat", "A field"), showFeatured: false, showMedia: false },
    });
    await followed(t, bob);
    expect(await shown(t, bob.uri)).toEqual(["A cat", "A field", false, false, true]);
    const plain = await mastodonActor(t.web, "bob", { extra: images(MASTODON, "bob") });
    expect(await t.post(plain, updateOf(plain))).toBe(202);
    expect(await shown(t, bob.uri)).toEqual(["", "", false, false, true]);

    const erin = await mastodonActor(t.web, "erin", {
      origin: OTHER,
      key: 3,
      extra: { ...images(OTHER, "erin", "Erin's cat"), showRepliesInMedia: false },
    });
    const first = mastodonNote(erin);
    t.web.serve(first.id, { "@context": AS, ...first });
    expect(await t.post(bob, announce(bob, first.id))).toBe(202);
    expect(await shown(t, erin.uri)).toEqual(["Erin's cat", "", true, true, false]);
    await ageAccount(t, erin.uri, new Date(NOW - ACCOUNT_STALE_MS).toISOString());
    await mastodonActor(t.web, "erin", { origin: OTHER, key: 3, extra: images(OTHER, "erin", undefined, "A hill") });
    const second = mastodonNote(erin);
    t.web.serve(second.id, { "@context": AS, ...second });
    t.web.fetched.length = 0;
    expect(await t.post(bob, announce(bob, second.id))).toBe(202);
    expect(t.web.fetched).toContain(erin.uri);
    expect(await shown(t, erin.uri)).toEqual(["", "A hill", true, true, false]);
  });

  // ProcessAccountService#image_url_and_description (process_account_service.rb:354-379) over the forms an icon arrives
  // in, through remoteActorInput: the property's first value, an object whose type is the string "Image", its summary
  // else its name by first_lang_string (federation/lang-string.ts), present as Rails judges it, stripped as Ruby does,
  // then cut at PROFILE_DESCRIPTION_LIMIT code points (Mastodon cuts at 10,000). Fedify's parse refuses a whole
  // document whose icon has a numeric language-map value (as Mastodon fails it) or a type other than Image, so those
  // forms never reach the read (test/lang-string.test.ts reads the first).
  const image = (extra: Record<string, unknown>) => ({ type: "Image", url: "https://remote.example/a.png", ...extra });
  const MAP = { summaryMap: { en: "b" } };
  const name = { name: "n" };
  it.each<[string, unknown, string]>([
    ["a summary", image({ summary: "A cat", ...name }), "A cat"],
    ["the name when the summary's first element is blank", image({ summary: ["", "x"], ...name }), "n"],
    ["an array of an @value", image({ summary: [{ "@value": "a" }] }), "a"],
    ["a language-tagged value", image({ summary: { "@value": "a", "@language": "en" } }), "a"],
    ["an empty summary, the map not read", image({ summary: "", ...MAP, ...name }), "n"],
    ["a null summary, the map read", image({ summary: null, ...MAP, ...name }), "b"],
    ["a false summary, the map read", image({ summary: false, ...MAP, ...name }), "b"],
    ["a summary of 0, the map not read", image({ summary: 0, ...MAP, ...name }), "n"],
    ["a numeric @value", image({ summary: { "@value": 5 }, ...name }), "n"],
    ["U+3000, blank", image({ summary: "　", ...name }), "n"],
    ["U+0085, blank", image({ summary: "\u0085", ...name }), "n"],
    ["U+FEFF, not blank", image({ summary: "﻿", ...name }), "﻿"],
    ["Ruby's strip", image({ summary: " \t a \n" }), "a"],
    ["NBSP, which Ruby's strip keeps", image({ summary: " a " }), " a "],
    ["the name as an array of an @value", image({ name: [{ "@value": "a" }] }), "a"],
    ["the name's map", image({ name: null, nameMap: { en: "b" } }), "b"],
    ["a NUL inside, dropped as stored text", image({ summary: "a\u0000b" }), "ab"],
    ["10,000 code points, cut", image({ summary: "𠀀".repeat(10_000) }), "𠀀".repeat(PROFILE_DESCRIPTION_LIMIT)],
    ["the first of an array", [image({ summary: "first" }), image({ summary: "second" })], "first"],
    ["an array whose first is a reference", ["https://remote.example/a", image({ summary: "x" })], ""],
    ["a reference, not fetched", "https://remote.example/icon", ""],
    ["an object without a type", { url: "https://remote.example/a.png", summary: "x" }, ""],
    ["a type given as an array", { type: ["Image"], url: "https://remote.example/a.png", summary: "x" }, ""],
    ["none", undefined, ""],
  ])("reads a remote actor's icon description: %s", async (_case, icon, expected) => {
    const uri = "https://remote.example/users/erin";
    const document = {
      "@context": AS,
      id: uri,
      type: "Person",
      preferredUsername: "erin",
      inbox: `${uri}/inbox`,
      ...(icon === undefined ? {} : { icon, image: icon }),
    };
    const input = await remoteActorInput(await Person.fromJsonLd(document), document);
    expect([input?.avatarDescription, input?.headerDescription]).toEqual([expected, expected]);
  });

  // RES-1: the descriptions are read from a fetched actor document of at most DOCUMENT_BODY_LIMIT bytes, which anyone can
  // serve. Presence, strip and the cut are linear (test/lang-string.test.ts); here runs of whitespace fill the document
  // between the icon and the image, each run inside a value followed by another character (a regex strip's quadratic
  // case), a blank summary, and runs at both ends, read through remoteActorInput.
  it("reads descriptions that fill the document's cap within a generous time", async () => {
    const uri = "https://remote.example/users/erin";
    const run = " ".repeat(DOCUMENT_BODY_LIMIT / 5 - 256);
    const document = {
      "@context": AS,
      id: uri,
      type: "Person",
      preferredUsername: "erin",
      inbox: `${uri}/inbox`,
      icon: image({ summary: `x${run}x` }),
      image: image({ summary: run, name: `${run}y${run}y${run}` }),
    };
    expect(JSON.stringify(document).length).toBeLessThanOrEqual(DOCUMENT_BODY_LIMIT);
    expect(JSON.stringify(document).length).toBeGreaterThan(DOCUMENT_BODY_LIMIT - 4096);
    const actor = await Person.fromJsonLd(document);
    const started = performance.now();
    const input = await remoteActorInput(actor, document);
    expect(performance.now() - started).toBeLessThan(1000);
    const cut = " ".repeat(PROFILE_DESCRIPTION_LIMIT - 1);
    expect([input?.avatarDescription, input?.headerDescription]).toEqual([`x${cut}`, `y${cut}`]);
  });
});
