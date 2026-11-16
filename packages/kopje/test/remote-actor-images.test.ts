import { Person } from "@fedify/vocab";
import { describe, expect, it } from "vitest";

import { fedifyActorView, profileImage, remoteActorInput } from "../src/federation/remote-actor";
import { PROFILE_URL_LIMIT } from "../src/platform/stored-bounds";
import { sql } from "./api-helpers";
import { MASTODON, mastodonActor, type TestActor } from "./inbox-helpers";
import { type Acct, ALICE, ALICE_URI, AS, create, mastodonNote, type Setup, setup } from "./inbox-status-helpers";

// #1672: an actor document's icon, image, followers and following are read by spelling, as Mastodon 4.7 reads them
// (ProcessAccountService#image_url_and_description and #valid_collection_uri), and Fedify parses the document without
// them (federation/remote-actor.ts fedifyActorView), so none of them can refuse the actor.

type Json = Record<string, unknown>;

const PNG = `${MASTODON}/system/avatars/x.png`;
const HEADER = `${MASTODON}/system/headers/x.png`;
const DOCUMENT = { type: "Document", mediaType: "image/png", url: PNG };

type AccountRow = {
  display_name: string;
  note: string;
  inbox_url: string | null;
  avatar_url: string | null;
  avatar_description: string;
  header_url: string | null;
  header_description: string;
};
const account = async (t: Setup, uri: string) =>
  (
    await sql<AccountRow>(
      t.store,
      `SELECT display_name, note, inbox_url, avatar_url, avatar_description, header_url, header_description
			FROM accounts WHERE uri = ?`,
      uri,
    )
  )[0];
const keys = (t: Setup, uri: string) =>
  sql<{ key_id: string }>(
    t.store,
    "SELECT k.key_id FROM remote_keys k JOIN accounts a ON a.id = k.account_id WHERE a.uri = ?",
    uri,
  );

const searchAccounts = (t: Setup, q: string) =>
  t.api<{ accounts: Acct[] }>(`/api/v2/search?resolve=true&type=accounts&q=${encodeURIComponent(q)}`);

// The columns a Mastodon actor's document gives (mastodonActor), but the images `images` names.
const expected = (actor: TestActor, images: Partial<AccountRow> = {}): AccountRow => ({
  display_name: actor.document.name as string,
  note:
    '<p>Bio with <a href="https://mastodon.example/tags/x" class="mention hashtag" rel="nofollow noopener" ' +
    'target="_blank">#<span>x</span></a></p>',
  inbox_url: `${actor.uri}/inbox`,
  avatar_url: (actor.document.icon as { url: string }).url,
  avatar_description: "",
  header_url: (actor.document.image as { url: string }).url,
  header_description: "",
  ...images,
});

describe("an actor whose icon or image is not an Image is stored (#1672)", () => {
  it("stores an actor whose icon is a Document", async () => {
    const t = await setup();
    const cases: [string, Json, Partial<AccountRow>][] = [
      ["icon", { icon: { ...DOCUMENT, name: "a cat" } }, { avatar_url: null }],
      ["image", { image: DOCUMENT }, { header_url: null }],
      [
        "collections",
        {
          followers: { type: "Document", id: `${MASTODON}/users/collections/followers` },
          following: { type: "Document", id: `${MASTODON}/users/collections/following` },
        },
        {},
      ],
    ];
    for (const [name, extra, images] of cases) {
      const actor = await mastodonActor(t.web, name, { extra });
      const found = await searchAccounts(t, actor.uri);
      expect(
        found.body.accounts.map((a) => a.acct),
        name,
      ).toEqual([`${name}@mastodon.example`]);
      expect(await account(t, actor.uri), name).toEqual(expected(actor, images));
      expect(await keys(t, actor.uri), name).toEqual([{ key_id: actor.keyId }]);
    }
  });

  it("verifies a signature by an actor whose icon is not an Image", async () => {
    const t = await setup();
    const erin = await mastodonActor(t.web, "erin", { extra: { icon: DOCUMENT, image: [DOCUMENT] } });
    const note = mastodonNote(erin, {
      cc: [ALICE_URI],
      tag: [{ type: "Mention", href: ALICE_URI, name: "@alice@kopje.test" }],
    });
    expect(await t.post(erin, create(erin, note))).toBe(202);
    expect(await sql(t.store, "SELECT account_id FROM notifications WHERE type = 'mention'")).toEqual([
      { account_id: ALICE },
    ]);
    expect(await account(t, erin.uri)).toEqual(expected(erin, { avatar_url: null, header_url: null }));
    expect(t.web.fetched.filter((url) => url === erin.uri)).toEqual([erin.uri]);
  });

  it("a reference is not fetched", async () => {
    const t = await setup();
    const icon = `${MASTODON}/system/avatars/reference.json`;
    t.web.serve(icon, { "@context": AS, type: "Image", url: PNG });
    const actor = await mastodonActor(t.web, "ref", { extra: { icon, image: [HEADER] } });
    expect((await searchAccounts(t, actor.uri)).body.accounts).toHaveLength(1);
    expect(await account(t, actor.uri)).toMatchObject({ avatar_url: null, header_url: null });
    expect(t.web.fetched).not.toContain(icon);
    expect(t.web.fetched).toContain(actor.uri);
  });
});

describe("avatars and headers are read as Mastodon reads them (#1672, HTML-3, RES-2)", () => {
  const image = (url: unknown, extra: Json = {}) => ({ type: "Image", mediaType: "image/png", url, ...extra });

  it("takes the first value, as Mastodon", () => {
    expect(profileImage([image(PNG, { summary: "first" }), DOCUMENT])).toEqual({ url: PNG, description: "first" });
    expect(profileImage([DOCUMENT, image(HEADER, { summary: "second" })])).toEqual({ url: null, description: "" });
    expect(profileImage([])).toEqual({ url: null, description: "" });
  });

  it.each([
    ["an Image's url", image(PNG), PNG],
    ["an Image's url given as a Link", image({ type: "Link", href: PNG }), PNG],
    ["an Image's url given as an array", image([PNG, HEADER]), PNG],
    ["an Image's url given as an array of Links", image([{ type: "Link", href: PNG }, HEADER]), PNG],
    ["an Image's url as a Link whose href is a Link, unwrapped twice as Mastodon", image({ href: { href: PNG } }), PNG],
    ["a Link's href", { type: "Link", href: PNG }, PNG],
    ["any other object's href", { type: "Document", href: PNG, url: HEADER }, PNG],
    ["an Image whose type is an array", { type: ["Image"], url: PNG }, null],
    ["a Video's url", { type: "Video", url: PNG }, null],
    ["an untyped object's url", { url: PNG }, null],
    ["an Image without a url", { type: "Image", href: PNG }, null],
    ["an Image whose url is a number", image(1), null],
    ["a reference", PNG, null],
    ["null", null, null],
  ])("reads an Image's url and any other object's href: %s", (_case, value, url) => {
    expect(profileImage(value).url).toBe(url);
  });

  it("reads a description from an Image alone", () => {
    expect(profileImage(image(PNG, { name: "a cat" })).description).toBe("a cat");
    expect(profileImage({ type: "Document", href: PNG, name: "a cat" })).toEqual({ url: PNG, description: "" });
    expect(profileImage(image(undefined, { summary: "no url" }))).toEqual({ url: null, description: "no url" });
  });

  it("keeps only an absolute http(s) URL within its bound", () => {
    const long = (length: number) => `${MASTODON}/${"x".repeat(length - MASTODON.length - 1)}`;
    expect(long(PROFILE_URL_LIMIT)).toHaveLength(PROFILE_URL_LIMIT);
    expect(profileImage(image(long(PROFILE_URL_LIMIT))).url).toBe(long(PROFILE_URL_LIMIT));
    for (const url of [
      "/system/avatars/x.png",
      "x.png",
      "data:image/png;base64,iVBORw0KGgo=",
      "javascript:alert(1)",
      "ftp://mastodon.example/x.png",
      long(PROFILE_URL_LIMIT + 1),
    ]) {
      expect(profileImage(image(url)).url, url).toBeNull();
      expect(profileImage({ type: "Link", href: url }).url, url).toBeNull();
    }
    // Normalized as a URL serializes, and judged within the bound after it.
    expect(profileImage(image("HTTPS://MASTODON.example/a b.png")).url).toBe("https://mastodon.example/a%20b.png");
    expect(profileImage(image(`${long(PROFILE_URL_LIMIT - 2)} y`)).url).toBeNull();
  });

  it("reads them from the document as served, through remoteActorInput", async () => {
    const uri = `${MASTODON}/users/erin`;
    const document = {
      "@context": AS,
      id: uri,
      type: "Person",
      preferredUsername: "erin",
      inbox: `${uri}/inbox`,
      icon: [{ ...DOCUMENT, href: PNG }, image(HEADER)],
      image: image({ type: "Link", href: HEADER }, { summary: "header" }),
    };
    const input = await remoteActorInput(await Person.fromJsonLd(fedifyActorView(document)), document);
    expect(input).toMatchObject({
      avatarUrl: PNG,
      avatarDescription: "",
      headerUrl: HEADER,
      headerDescription: "header",
      raw: JSON.stringify(document),
    });
  });
});

describe("fedifyActorView", () => {
  it("leaves out icon, image, followers and following alone, and leaves anything else as it is", () => {
    const document = {
      "@context": AS,
      id: `${MASTODON}/users/erin`,
      type: "Person",
      icon: DOCUMENT,
      image: DOCUMENT,
      followers: { type: "Document" },
      following: { type: "Document" },
      endpoints: { sharedInbox: `${MASTODON}/inbox` },
      publicKey: { id: `${MASTODON}/users/erin#main-key` },
    };
    const { icon: _i, image: _m, followers: _f, following: _g, ...rest } = document;
    expect(fedifyActorView(document)).toEqual(rest);
    expect(document.icon).toBe(DOCUMENT);
    for (const value of [null, "x", [document], 1]) {
      expect(fedifyActorView(value)).toBe(value);
    }
  });
});
