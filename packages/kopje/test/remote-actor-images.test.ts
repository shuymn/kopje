import { Person } from "@fedify/vocab";
import { describe, expect, it } from "vitest";

import {
  actorCollections,
  collectionRead,
  collectionSql,
  collectionUri,
  UNREADABLE,
} from "../src/domain/collection-requests";
import { followersOf } from "../src/domain/inbox";
import { MAX_URL_LENGTH } from "../src/domain/status-text";
import { syncCollections } from "../src/federation/collections";
import { verifySpooledRequest } from "../src/federation/inbound";
import { processInbox } from "../src/federation/inbox";
import { fedifyActorView, INBOX_URL_LIMIT, profileImage, remoteActorInput } from "../src/federation/remote-actor";
import { httpUrl } from "../src/platform/http-url";
import { PROFILE_URL_LIMIT } from "../src/platform/stored-bounds";
import { sql } from "./api-helpers";
import { inboxDeps, NOW } from "./app-helpers";
import spellings from "./fixtures/shared-inbox/spellings.json";
import { LOCAL, MASTODON, mastodonActor, signedInit, type TestActor } from "./inbox-helpers";
import {
  type Acct,
  ALICE,
  ALICE_URI,
  announce,
  AS,
  create,
  followed,
  mastodonNote,
  PUBLIC,
  type Setup,
  setup,
} from "./inbox-status-helpers";

// #1672: an actor document's icon, image, followers and following are read by spelling, as Mastodon 4.7 reads them
// (ProcessAccountService#image_url_and_description and #valid_collection_uri), and Fedify parses a view of the document
// without them (federation/remote-actor.ts fedifyActorView), so none of them can refuse the actor.

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

  // The key forms Fedify fetches itself (inbound.ts verifyHttpSignature): the actor's document at the key's own URL
  // (GoToSocial's), and a key document of its own, whose owner's document Fedify then loads. Each verifies, live,
  // replayed from the spool and through the rollback drain's check, whether the icon is an Image or a Document.
  it("verifies a key Fedify fetches itself, by an actor whose icon is not an Image (ID-1)", async () => {
    const mention = { cc: [ALICE_URI], tag: [{ type: "Mention", href: ALICE_URI, name: "@alice@kopje.test" }] };
    for (const icon of [{ type: "Image", url: PNG }, DOCUMENT]) {
      for (const form of ["the actor at the key's URL", "a key document"]) {
        const name = `${icon.type}${form === "a key document" ? "key" : "gts"}`.toLowerCase();
        const keyed = async (t: Setup) => {
          const actor = await mastodonActor(t.web, name);
          const keyId = form === "a key document" ? `${MASTODON}/keys/${name}` : `${actor.uri}/main-key`;
          const key = { id: keyId, owner: actor.uri, publicKeyPem: actor.pem };
          const document = { ...actor.document, icon, publicKey: key };
          t.web.serve(actor.uri, document);
          t.web.serve(
            keyId,
            form === "a key document"
              ? { "@context": "https://w3id.org/security/v1", type: "CryptographicKey", ...key }
              : document,
          );
          return { actor, keyId };
        };
        const label = `${icon.type}, ${form}`;
        const live = await setup();
        const { actor, keyId } = await keyed(live);
        const init = await signedInit(actor, "/inbox", create(actor, mastodonNote(actor, mention)), { keyId });
        const spooled = {
          url: `${LOCAL}/inbox`,
          method: "POST",
          headers: [...new Headers(init.headers)],
          body: new TextEncoder().encode(init.body as string),
          receivedAt: NOW,
        };
        expect(await live.post(actor, create(actor, mastodonNote(actor, mention)), { keyId }), label).toBe(202);
        expect(live.web.fetched, label).toContain(keyId);
        expect(
          await verifySpooledRequest({ ...live.web.loader, userAgent: "Kopje/test" }, "kopje.test", spooled),
          label,
        ).toMatchObject({ ok: true, actor: actor.uri });
        const replay = await setup();
        await keyed(replay);
        expect(
          await processInbox(
            replay.env,
            inboxDeps(() => replay.store, replay.web.loader),
            spooled,
            "replay",
          ),
          label,
        ).toMatchObject({ status: 202 });
        expect(replay.web.fetched, label).toContain(keyId);
        for (const t of [live, replay]) {
          expect(await account(t, actor.uri), label).toMatchObject({
            avatar_url: icon.type === "Image" ? PNG : null,
          });
        }
      }
    }
  });

  // #1709: the paths that hand Fedify an actor document a key is read from, each given a document whose member
  // outside the view's inventory Fedify cannot parse (remote-actor.ts FEDIFY_MEMBERS).
  const mention = { cc: [ALICE_URI], tag: [{ type: "Mention", href: ALICE_URI, name: "@alice@kopje.test" }] };
  const mentioned = async (t: Setup) =>
    sql(t.store, "SELECT account_id FROM notifications WHERE type = 'mention'").then((rows) => rows.length);

  it("verifies a signature by an actor whose published is unreadable, its key at the actor's URL", async () => {
    // GoToSocial's key form: no key under the document at the key's URL (D4 answers none), so Fedify fetches the key
    // itself through actorViewLoader, live, on replay and in the rollback drain's check.
    const keyed = async (t: Setup) => {
      const actor = await mastodonActor(t.web, "gts");
      const keyId = `${actor.uri}/main-key`;
      const document = {
        ...actor.document,
        published: "garbage",
        publicKey: { id: keyId, owner: actor.uri, publicKeyPem: actor.pem },
      };
      t.web.serve(actor.uri, document);
      t.web.serve(keyId, document);
      return { actor, keyId };
    };
    const live = await setup();
    const { actor, keyId } = await keyed(live);
    const init = await signedInit(actor, "/inbox", create(actor, mastodonNote(actor, mention)), { keyId });
    const spooled = {
      url: `${LOCAL}/inbox`,
      method: "POST",
      headers: [...new Headers(init.headers)],
      body: new TextEncoder().encode(init.body as string),
      receivedAt: NOW,
    };
    expect(await live.post(actor, create(actor, mastodonNote(actor, mention)), { keyId })).toBe(202);
    expect(live.web.fetched).toContain(keyId);
    expect(await mentioned(live)).toBe(1);
    expect(
      await verifySpooledRequest({ ...live.web.loader, userAgent: "Kopje/test" }, "kopje.test", spooled),
    ).toMatchObject({ ok: true, actor: actor.uri });
    const replay = await setup();
    await keyed(replay);
    expect(
      await processInbox(
        replay.env,
        inboxDeps(() => replay.store, replay.web.loader),
        spooled,
        "replay",
      ),
    ).toMatchObject({ status: 202 });
    expect(replay.web.fetched).toContain(keyId);
    expect(await mentioned(replay)).toBe(1);
  });

  it("verifies a signature by a key under its owner's document whose updated is unreadable (D4)", async () => {
    const t = await setup();
    const actor = await mastodonActor(t.web, "updated");
    t.web.serve(actor.uri, { ...actor.document, updated: "garbage" });
    expect(await t.post(actor, create(actor, mastodonNote(actor, mention)))).toBe(202);
    expect(await mentioned(t)).toBe(1);
    expect(await keys(t, actor.uri)).toEqual([{ key_id: actor.keyId }]);
  });

  it("verifies a key document served at the key's URL", async () => {
    // The key's own document keeps what Fedify reads of it (its id, type, owner and key); its owner's document holds
    // an icon spelled as a compact IRI.
    const t = await setup();
    const actor = await mastodonActor(t.web, "keydoc");
    const keyId = `${MASTODON}/keys/keydoc`;
    const key = { id: keyId, owner: actor.uri, publicKeyPem: actor.pem };
    t.web.serve(actor.uri, { ...actor.document, "as:icon": DOCUMENT, publicKey: key });
    t.web.serve(keyId, { "@context": "https://w3id.org/security/v1", type: "CryptographicKey", ...key });
    expect(await t.post(actor, create(actor, mastodonNote(actor, mention)), { keyId })).toBe(202);
    expect(t.web.fetched).toContain(keyId);
    expect(await mentioned(t)).toBe(1);
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

describe("an actor's followers and following are read as Mastodon reads them (#1672, VIS-1)", () => {
  const F = `${MASTODON}/users/coll/followers`;
  const G = `${MASTODON}/users/coll/other`;
  const H = `${MASTODON}/users/coll/following`;
  const QUOTE_FLAGS = { public: 2, followers: 4, following: 8, unsupportedPolicy: 1 };

  // What collectionSql selects of `member` in a stored document (`raw`, by default one holding it alone), as selected
  // (the string), and read by collectionUri.
  async function selection(
    t: Setup,
    member: unknown,
    raw = JSON.stringify(member === undefined ? {} : { followers: member }),
  ) {
    const [row] = await sql<{ m: string | null }>(
      t.store,
      `SELECT ${collectionSql("raw", "followers")} AS m FROM (SELECT ?1 AS raw)`,
      raw,
    );
    return row!.m;
  }
  const selected = async (t: Setup, member: unknown, raw?: string) => collectionUri(await selection(t, member, raw));

  // An actor whose followers and following are `followers` and `following`, followed by alice, and the outbox,
  // followers and following collections its sync fetches, served.
  async function author(t: Setup, name: string, followers: unknown, following: unknown) {
    const actor = await mastodonActor(t.web, name, { extra: { followers, following } });
    for (const url of [`${actor.uri}/outbox`, F, H]) {
      t.web.serve(url, { "@context": AS, id: url, type: "OrderedCollection", totalItems: 1 });
    }
    await followed(t, actor);
    return actor;
  }

  // The visibility of `actor`'s Note addressed to F and mentioning alice (so that it is stored as direct too), and of
  // its boost of its own public Note addressed to F only.
  async function visibilities(t: Setup, actor: TestActor): Promise<[unknown, unknown]> {
    const note = mastodonNote(actor, {
      to: [F],
      cc: [ALICE_URI],
      tag: [{ type: "Mention", href: ALICE_URI, name: "@alice@kopje.test" }],
    });
    expect(await t.post(actor, create(actor, note))).toBe(202);
    const original = mastodonNote(actor);
    expect(await t.post(actor, create(actor, original))).toBe(202);
    const boost = announce(actor, original.id, { to: [F], cc: [] });
    expect(await t.post(actor, boost)).toBe(202);
    const rows = await sql<{ uri: string; visibility: string }>(
      t.store,
      "SELECT uri, visibility FROM statuses WHERE uri IN (?, ?)",
      note.id,
      boost.id,
    );
    return [rows.find((r) => r.uri === note.id)?.visibility, rows.find((r) => r.uri === boost.id)?.visibility];
  }

  // The quote policy stored for `actor`'s public Note whose automatic approval lists F and manual approval H.
  async function quotePolicy(t: Setup, actor: TestActor): Promise<number | undefined> {
    const note = mastodonNote(actor, {
      interactionPolicy: { canQuote: { automaticApproval: [F], manualApproval: [H] } },
    });
    expect(await t.post(actor, create(actor, note))).toBe(202);
    const [row] = await sql<{ quote_policy: number }>(
      t.store,
      "SELECT quote_policy FROM statuses WHERE uri = ?",
      note.id,
    );
    return row?.quote_policy;
  }

  // The URLs a collection sync of the stored actors fetches.
  async function synced(t: Setup): Promise<string[]> {
    const before = t.web.fetched.length;
    const deps = { ...inboxDeps(() => t.store, t.web.loader), now: () => NOW };
    for (let round = 0; round < 5 && (await syncCollections(t.env, deps)); round++) {
      // Another sync waits.
    }
    expect(await sql(t.store, "SELECT count(*) AS n FROM collection_syncs")).toEqual([{ n: 0 }]);
    return t.web.fetched.slice(before);
  }

  it("reads followers and following as Mastodon", async () => {
    const t = await setup();
    const cases: [string, unknown, string][] = [
      ["a string", F, F],
      [
        "a string as spelled",
        "https://Mastodon.example/users/coll/followers",
        "https://Mastodon.example/users/coll/followers",
      ],
      ["an object typed Document", { type: "Document", id: F }, F],
      ["an OrderedCollection", { type: "OrderedCollection", id: F, totalItems: 3 }, F],
      ["an array", [F], F],
      ["an array of an object", [{ id: F }], F],
      ["the first of an array", [G, F], G],
      ["an array whose first is an array", [[F]], ""],
      ["an empty array", [], ""],
      ["an array whose first is null", [null, F], ""],
      ["an object's href", { href: F }, ""],
      ["an object whose id is an object", { id: { id: F } }, ""],
      ["a number", 1, ""],
      ["null", null, ""],
      ["no member", undefined, ""],
      ["a relative URL", "/users/coll/followers", ""],
      ["an ftp: URL", "ftp://mastodon.example/followers", ""],
    ];
    for (const [name, member, expected] of cases) {
      expect(collectionUri(member), name).toBe(expected);
      expect(await selected(t, member), name).toBe(expected);
      expect(followersOf(JSON.stringify(member === undefined ? {} : { followers: member })), name).toBe(expected);
    }
    expect(followersOf(null)).toBeNull();
    // Text JSON.stringify does not write, as an imported document may hold it: escapes, and a duplicate key inside the
    // member, of which JSON.parse (as Ruby's, Mastodon's) takes the last.
    const escaped = '{"followers":{"type":"Document","id":"https:\\/\\/mastodon.example\\/users\\/coll\\/followers"}}';
    expect(await selected(t, null, escaped)).toBe(F);
    expect(followersOf(escaped)).toBe(F);
    const duplicate = `{"followers":{"id":"${G}","i\\u0064":"${F}"}}`;
    expect(await selected(t, null, duplicate)).toBe(F);
    expect(followersOf(duplicate)).toBe(F);
    // The SQL selects the string alone, never the object or array holding it (RES-2).
    const unused = "x".repeat(100_000);
    for (const member of [{ unused, id: F }, [{ id: F, unused }, unused]]) {
      expect(await selection(t, null, JSON.stringify({ unused, followers: member }))).toBe(F);
    }
    expect(await selection(t, { id: { id: F, unused } })).toBeNull();

    // Through each reader: followersUri (a Note's and a boost's visibility), remoteQuotePolicy and actorCollections.
    const objects = await author(t, "objects", { type: "Document", id: F }, [H]);
    expect(await visibilities(t, objects)).toEqual(["private", "private"]);
    expect(await quotePolicy(t, objects)).toBe((QUOTE_FLAGS.followers << 16) | QUOTE_FLAGS.following);
    const arrays = await author(t, "arrays", [F], [{ type: "Document", id: H }]);
    expect(await synced(t)).toEqual(expect.arrayContaining([`${arrays.uri}/outbox`, F, H]));
  });

  // A stored document may name a member twice, alike or escaped (an imported one: a fetched one is stored as
  // JSON.stringify writes it). JSON.parse, as Ruby's parser (Mastodon's), keeps the last, and so does every reader.
  it("reads the last of a member named twice, on every path", async () => {
    const t = await setup();
    const actor = await author(t, "twice", G, G);
    const { followers: _followers, following: _following, ...rest } = actor.document;
    const raw =
      `${JSON.stringify(rest).slice(0, -1)},"followers":{"id":"${G}"},"following":"${G}",` +
      `"follow\\u0065rs":[{"id":"${F}"}],"following":{"id":"${G}","id":"${H}"}}`;
    await sql(t.store, "UPDATE accounts SET raw = ? WHERE uri = ?", raw, actor.uri);
    expect(followersOf(raw)).toBe(F);
    expect(await selected(t, null, raw)).toBe(F);
    expect(actorCollections(raw)).toMatchObject({ followers: F, following: H });
    expect(await visibilities(t, actor)).toEqual(["private", "private"]);
    expect(await quotePolicy(t, actor)).toBe((QUOTE_FLAGS.followers << 16) | QUOTE_FLAGS.following);
    const fetched = await synced(t);
    expect(fetched).toEqual(expect.arrayContaining([F, H]));
    expect(fetched).not.toContain(G);
  });

  // Mastodon 4.7.5's valid_collection_uri over Addressable 2.9.2 (each row run there): '' (none), or the URI it stores,
  // which addressing is compared with. Kopje reads it so, but for what it cannot tell (UNREADABLE), which addressing
  // never names (null).
  it("reads a collection as the URI Mastodon stores for it", async () => {
    const t = await setup();
    const D = "mastodon.example/users/coll/followers";
    const P = "/users/coll/followers";
    const rows: [string, string, string | typeof UNREADABLE][] = [
      // None (''): Mastodon's parse refuses what the URL Standard's parser would repair, and a port not digits.
      ["an upper-case scheme", `HTTPS://${D}`, ""],
      ["a mixed-case scheme", `Https://${D}`, ""],
      ["no slash after the scheme", `https:${D}`, ""],
      ["one slash after the scheme", `https:/${D}`, ""],
      ["an empty authority", `https:///${D}`, ""],
      ["backslashes for slashes", "https:\\\\mastodon.example\\users\\coll\\followers", ""],
      ["a slash and a backslash", `https:/\\${D}`, ""],
      ["a backslash ending the host", "https://mastodon.example\\users/coll/followers", ""],
      ["a leading space", ` ${F}`, ""],
      ["a leading tab", `\t${F}`, ""],
      ["a leading line feed", `\n${F}`, ""],
      ["a port that is not digits", `https://mastodon.example:4a${P}`, ""],
      ["a port decoded to what is not digits", `https://mastodon.example:%41${P}`, ""],
      // Written back otherwise.
      ["an empty port", `https://mastodon.example:${P}`, F],
      ["a zero port", `https://mastodon.example:0${P}`, F],
      ["a port with a leading zero", `https://mastodon.example:0443${P}`, `https://mastodon.example:443${P}`],
      ["a percent-encoded port", `https://mastodon.example:%34%34%33${P}`, `https://mastodon.example:443${P}`],
      ["a userinfo with spaces around it", `https:// u:p @${D}`, `https://u:p@${D}`],
      ["a line feed in the fragment", `${F}#a\nb`, `${F}#a`],
      // Kept as spelled, the first two though the URL Standard's parser refuses them.
      ["a port past 65535", `https://mastodon.example:65536${P}`, `https://mastodon.example:65536${P}`],
      ["a `|` in the host", `https://mastodon|example${P}`, `https://mastodon|example${P}`],
      ["a trailing space", `${F} `, `${F} `],
      ["a default port", `https://mastodon.example:443${P}`, `https://mastodon.example:443${P}`],
      ["a space inside the userinfo", `https://u v@${D}`, `https://u v@${D}`],
      ["a line feed in the query", `${F}?a\nb`, `${F}?a\nb`],
      ["a carriage return in the fragment", `${F}#a\rb`, `${F}#a\rb`],
      ["an IPv6 literal", `https://[::1]${P}`, `https://[::1]${P}`],
      // Unreadable.
      ["a NUL", `${F}\u0000x`, UNREADABLE],
      ["a lone surrogate", `${F}\ud800`, UNREADABLE],
      ["U+FFFD", `${F}\ufffd`, UNREADABLE],
      ["a line feed in the userinfo", `https://u\nv@${D}`, UNREADABLE],
      ["a line feed in the host", `https://mastodon\n.example${P}`, UNREADABLE],
      ["a port decoded to a line feed", `https://mastodon.example:4%0A${P}`, UNREADABLE],
    ];
    expect(httpUrl(`https://mastodon.example:65536${P}`)).toBeNull();
    expect(httpUrl(`https://mastodon|example${P}`)).toBeNull();
    for (const [name, member, expected] of rows) {
      const uri = expected === UNREADABLE ? null : expected;
      expect(collectionRead(member), name).toBe(expected);
      expect(collectionRead([{ type: "Document", id: member }]), name).toBe(expected);
      expect(collectionUri(member), name).toBe(uri);
      expect(await selected(t, member), name).toBe(uri);
      expect(followersOf(JSON.stringify({ followers: member })), name).toBe(uri);
    }
  });

  // The quote policy stored for `actor`'s public Note listing `automatic` and `manual`, and the current_user of its
  // quote_approval for alice, who follows the author (followed), and for dave, whom the author follows.
  async function quoted(t: Setup, actor: TestActor, automatic: unknown[], manual: unknown[] = []) {
    const note = mastodonNote(actor, {
      interactionPolicy: { canQuote: { automaticApproval: automatic, manualApproval: manual } },
    });
    expect(await t.post(actor, create(actor, note))).toBe(202);
    const [row] = await sql<{ id: string; quote_policy: number }>(
      t.store,
      "SELECT id, quote_policy FROM statuses WHERE uri = ?",
      note.id,
    );
    const answer = async (user: "alice" | "dave") =>
      (await t.api<{ quote_approval: { current_user: string } }>(`/api/v1/statuses/${row?.id}`, user)).body
        .quote_approval.current_user;
    return { policy: row?.quote_policy, alice: await answer("alice"), dave: await answer("dave") };
  }

  // Addressing is compared with the URI Mastodon stores; an unreadable collection is named by no addressing, so a Note
  // or a boost addressed to it is direct, never more visible than Mastodon makes it.
  it("compares addressing with the stored URI, and reads an unreadable collection as named by none", async () => {
    const t = await setup();
    const respelled = await author(
      t,
      "respelled",
      "https://mastodon.example:/users/coll/followers",
      "https://mastodon.example:0/users/coll/following",
    );
    expect(await visibilities(t, respelled)).toEqual(["private", "private"]);
    expect(await quotePolicy(t, respelled)).toBe((QUOTE_FLAGS.followers << 16) | QUOTE_FLAGS.following);
    expect(await synced(t)).toEqual(expect.arrayContaining([F, H]));

    const unreadable = await author(t, "unreadable", "https://u\nv@mastodon.example/users/coll/followers", H);
    expect(await visibilities(t, unreadable)).toEqual(["direct", "direct"]);
  });

  // Mastodon reads a policy's entries in order (status_parser.rb:179-196: the public collection, then the followers
  // collection, then the following one, each match deleted before the next), so past an unreadable collection, which
  // Mastodon may store as the very string a later entry matches, an entry adds nothing but the public collection, and
  // a value that is not a string, which matches no collection, unsupported_policy. Neither half grants anyone more than
  // Mastodon does.
  it("adds nothing past an unreadable collection, in Mastodon's order (R36)", async () => {
    const t = await setup();
    // Mastodon stores both as `…:4/…` and reads the entry as followers (4 << 16 | 4): alice may quote, dave not.
    const stored = `${MASTODON}:4/users/collision/followers`;
    const collision = await author(t, "collision", `${MASTODON}:4%0A/users/collision/followers`, stored);
    expect(await quoted(t, collision, [stored], [stored])).toEqual({ policy: 0, alice: "denied", dave: "denied" });
    expect(await quoted(t, collision, [stored, collision.uri, G, PUBLIC])).toMatchObject({
      policy: QUOTE_FLAGS.public << 16,
    });
    // The second public spelling is a string left at the unreadable collection: Mastodon reads it as followers if it
    // stores that collection as the IRI, else as unsupported_policy (#1772), so it adds nothing.
    expect(await quoted(t, collision, ["as:Public", PUBLIC])).toMatchObject({ policy: QUOTE_FLAGS.public << 16 });
    expect(await quoted(t, collision, [7], [{ id: stored }])).toMatchObject({
      policy: (QUOTE_FLAGS.unsupportedPolicy << 16) | QUOTE_FLAGS.unsupportedPolicy,
    });
    // An unreadable following collection: the followers collection is read before it, anything after adds nothing.
    const following = await author(t, "unreadablefollowing", F, "https://u\nv@mastodon.example/users/coll/following");
    expect(await quoted(t, following, [F], [G, following.uri])).toEqual({
      policy: QUOTE_FLAGS.followers << 16,
      alice: "automatic",
      dave: "denied",
    });
  });

  // Mastodon takes one public spelling before the followers collection (status_parser.rb:184-186), so a collection
  // named as the full IRI takes a second spelling: Mastodon 4.7.5 gives public | followers for this list (#1772). Fails
  // if every public spelling is taken as public (followers would be lost).
  it("takes one public spelling, then a collection named as another (R36)", async () => {
    const t = await setup();
    const named = await author(t, "publicfollowers", PUBLIC, H);
    expect((await quoted(t, named, ["as:Public", PUBLIC])).policy).toBe(
      (QUOTE_FLAGS.public | QUOTE_FLAGS.followers) << 16,
    );
    expect((await quoted(t, named, [PUBLIC])).policy).toBe(QUOTE_FLAGS.public << 16);
  });

  // A string entry is compared whatever its length, as Mastodon compares it, so one past MAX_URL_LENGTH is read in the
  // same order, past an unreadable collection too, as any other.
  it("compares a long entry as any other (R36)", async () => {
    const t = await setup();
    for (const length of [MAX_URL_LENGTH, MAX_URL_LENGTH + 1]) {
      const long = (uri: string) => uri + "x".repeat(length - uri.length);
      // The followers collection as spelled is `stored` with its port `4%0A`, under the same suffix: Mastodon stores it
      // as `stored` (the port percent-decodes to `4\n`, written back as 4) and reads the entry as followers in both
      // halves, (4 << 16) | 4, so alice may quote and dave not.
      const stored = long(`${MASTODON}:4/users/long/followers`);
      const spelled = stored.replace(":4/", ":4%0A/");
      expect([stored.length, collectionRead(spelled)]).toEqual([length, UNREADABLE]);
      const unreadable = await author(t, `longunreadable${length}`, spelled, G);
      expect(await quoted(t, unreadable, [stored], [stored]), `${length}`).toEqual({
        policy: 0,
        alice: "denied",
        dave: "denied",
      });
      const followers = await author(t, `longfollowers${length}`, long(F), G);
      expect(await quoted(t, followers, [long(F)], [long(F)]), `${length}`).toEqual({
        policy: (QUOTE_FLAGS.followers << 16) | QUOTE_FLAGS.followers,
        alice: "automatic",
        dave: "denied",
      });
      const following = await author(t, `longfollowing${length}`, F, long(H));
      expect(await quoted(t, following, [long(H)], [long(G)]), `${length}`).toEqual({
        policy: (QUOTE_FLAGS.following << 16) | QUOTE_FLAGS.unsupportedPolicy,
        alice: "unknown",
        dave: "automatic",
      });
    }
  });

  // Mastodon stores a collection an actor names none of (a missing member, an empty string, a value it refuses) as ''
  // and compares a policy's entries with it, so a listed "" is that collection, as main read an explicit
  // `followers: ""`; a value that is not a string stays unsupported_policy, as Mastodon's Array#delete matches no
  // string with it.
  it("reads a collection named by none as Mastodon's '', which a listed \"\" matches (R36)", async () => {
    const t = await setup();
    for (const [name, followers] of [
      ["explicit", ""],
      ["absent", undefined],
      ["refused", "HTTPS://mastodon.example/users/coll/followers"],
    ] as const) {
      const actor = await author(t, `none${name}`, followers, null);
      expect(await quoted(t, actor, [""]), name).toEqual({
        policy: QUOTE_FLAGS.followers << 16,
        alice: "automatic",
        dave: "denied",
      });
      for (const entry of [null, 7, false, { id: "" }]) {
        expect((await quoted(t, actor, [entry])).policy, `${name} ${JSON.stringify(entry)}`).toBe(
          QUOTE_FLAGS.unsupportedPolicy << 16,
        );
      }
    }
    // The followers collection read first takes "", so with one named, "" is the following collection.
    const named = await author(t, "named", F, undefined);
    expect((await quoted(t, named, [""])).policy).toBe(QUOTE_FLAGS.following << 16);
    // Addressing names it too: a Note to "" is private by an author naming no followers collection, as Mastodon reads
    // it, and direct by one naming F.
    const none = await author(t, "noneaddressed", undefined, undefined);
    const visibility = async (actor: TestActor) => {
      const note = mastodonNote(actor, {
        to: [""],
        cc: [ALICE_URI],
        tag: [{ type: "Mention", href: ALICE_URI, name: "@alice@kopje.test" }],
      });
      expect(await t.post(actor, create(actor, note))).toBe(202);
      return (await sql<{ v: string }>(t.store, "SELECT visibility AS v FROM statuses WHERE uri = ?", note.id))[0]?.v;
    };
    expect(await visibility(none)).toBe("private");
    expect(await visibility(named)).toBe("direct");
  });

  it("reads `[[F]]` as no collection on every path", async () => {
    const t = await setup();
    const nested = await author(t, "nested", [[F]], [[H]]);
    expect(
      await sql(
        t.store,
        "SELECT raw ->> '$.followers[0][0]' AS f, raw ->> '$.following[0][0]' AS g FROM accounts WHERE uri = ?",
        nested.uri,
      ),
    ).toEqual([{ f: F, g: H }]);
    expect(await visibilities(t, nested)).toEqual(["direct", "direct"]);
    expect(await quotePolicy(t, nested)).toBe((QUOTE_FLAGS.unsupportedPolicy << 16) | QUOTE_FLAGS.unsupportedPolicy);
    const fetched = await synced(t);
    expect(fetched).toContain(`${nested.uri}/outbox`);
    expect(fetched).not.toContain(F);
    expect(fetched).not.toContain(H);
    expect(followersOf(JSON.stringify({ followers: [[F]] }))).toBe("");
  });
});

describe("reads the shared inbox as Mastodon (#1686, NET-2, HTML-3)", () => {
  const SI = `${MASTODON}/inbox`;
  const SI2 = `${MASTODON}/inbox2`;

  // The shared inbox stored for `uri`, and whether the actor is stored at all.
  const sharedInbox = async (t: Setup, uri: string) =>
    (await sql<{ s: string | null }>(t.store, "SELECT shared_inbox_url AS s FROM accounts WHERE uri = ?", uri))[0]?.s;

  // The shared inbox remoteActorInput reads from `document` (an actor holding it), parsed as readActor parses it.
  async function read(extra: Json): Promise<string | null | undefined> {
    const uri = `${MASTODON}/users/si`;
    const document = {
      "@context": AS,
      id: uri,
      type: "Person",
      preferredUsername: "si",
      inbox: `${uri}/inbox`,
      ...extra,
    };
    return (await remoteActorInput(await Person.fromJsonLd(fedifyActorView(document)), document))?.sharedInboxUrl;
  }

  // §1.2's forms: each actor is stored, with the shared inbox Mastodon 4.7.5 reads (process_account_service.rb:225).
  // Fedify 2.4.5 refused the actor whole for a Document- or Service-typed `endpoints`, a non-URL `sharedInbox` and a
  // non-URL `proxyUrl`; it read an array `endpoints`, ignored a top-level `sharedInbox` and resolved a relative one.
  const FORMS: [string, Json, string | null][] = [
    ["plain", { endpoints: { sharedInbox: SI } }, SI],
    ["endpoints", { endpoints: { type: "Endpoints", sharedInbox: SI } }, SI],
    ["withid", { endpoints: { id: `${MASTODON}/endpoints`, sharedInbox: SI } }, SI],
    ["oauth", { endpoints: { oauthAuthorizationEndpoint: `${MASTODON}/oauth/authorize`, sharedInbox: SI } }, SI],
    ["document", { endpoints: { type: "Document", sharedInbox: SI } }, SI],
    ["service", { endpoints: { type: "Service", sharedInbox: SI } }, SI],
    ["number", { endpoints: { sharedInbox: 5 } }, null],
    ["proxy", { endpoints: { proxyUrl: 5, sharedInbox: SI } }, SI],
    ["object", { endpoints: { sharedInbox: { id: SI } } }, SI],
    ["list", { endpoints: { sharedInbox: [SI, SI2] } }, SI],
    ["string", { endpoints: "x" }, null],
    ["null", { endpoints: null }, null],
    ["five", { endpoints: 5 }, null],
    ["empty", { endpoints: {} }, null],
  ];
  // EP-T2: the forms Fedify read otherwise. An array or any other non-object `endpoints` gives the top-level
  // `sharedInbox`; an object gives its own member alone.
  const OTHER_FORMS: [string, Json, string | null][] = [
    ["array", { endpoints: [{ sharedInbox: SI }] }, null],
    ["arraytop", { endpoints: [{ sharedInbox: SI }], sharedInbox: SI2 }, SI2],
    ["top", { endpoints: undefined, sharedInbox: SI }, SI],
    ["stringtop", { endpoints: "x", sharedInbox: { id: SI } }, SI],
    ["emptytop", { endpoints: {}, sharedInbox: SI2 }, null],
    ["relative", { endpoints: { sharedInbox: "/inbox" } }, null],
  ];

  it.each([
    ["each form of endpoints (EP-T1)", FORMS],
    ["an array, a top-level sharedInbox and a relative one (EP-T2)", OTHER_FORMS],
  ])("stores the actor with Mastodon's shared inbox: %s", async (_name, forms) => {
    const t = await setup();
    for (const [name, extra, shared] of forms) {
      const actor = await mastodonActor(t.web, `ep${name}`, { extra });
      const found = await searchAccounts(t, actor.uri);
      expect(
        found.body.accounts.map((a) => a.acct),
        name,
      ).toEqual([`ep${name}@mastodon.example`]);
      expect(await sharedInbox(t, actor.uri), name).toBe(shared);
      expect(await keys(t, actor.uri), name).toEqual([{ key_id: actor.keyId }]);
    }
  });

  // EP-T3: Mastodon's destination for each spelling (spellings.json, captured by its capture.rb from Addressable 2.9.2
  // under Mastodon 4.7.5): Kopje keeps exactly that URL or none, and none for each row marked refused (Q4).
  it("keeps a spelling only where Kopje POSTs to Mastodon's URL (EP-T3)", async () => {
    expect(spellings.addressable).toBe("2.9.2");
    const differences: unknown[] = [];
    for (const row of spellings.rows) {
      const mastodon = (row.mastodon as { destination?: string }).destination ?? null;
      const kopje = await read({ endpoints: { sharedInbox: row.value } });
      if (kopje !== (row.refused ? null : mastodon) || (kopje !== null && kopje !== mastodon)) {
        differences.push({ value: row.value, refused: row.refused, kopje, mastodon });
      }
    }
    expect(differences).toEqual([]);
    // Every row Kopje keeps has a Mastodon destination, and the refused rows cover spellings Mastodon keeps.
    expect(spellings.rows.filter((row) => !row.refused && row.mastodon.destination === undefined)).toEqual([]);
    expect(
      spellings.rows.filter((row) => row.refused && row.mastodon.destination !== undefined).length,
    ).toBeGreaterThan(40);
  });

  // EP-T4: a scheme other than lower-case http(s), no host, and a URL past INBOX_URL_LIMIT (UTF-16 code units of an
  // ASCII href, so bytes) are none; NUL and astral characters are refused by spelling, a NUL's escape kept as spelled.
  it("keeps none for another scheme, no host, or past INBOX_URL_LIMIT (EP-T4)", async () => {
    const at = (length: number) => `${MASTODON}/${"x".repeat(length - MASTODON.length - 1)}`;
    expect(at(INBOX_URL_LIMIT)).toHaveLength(INBOX_URL_LIMIT);
    for (const [value, shared] of [
      ["ftp://mastodon.example/inbox", null],
      ["HTTPS://mastodon.example/inbox", null],
      ["https:///inbox", null],
      ["https:/inbox", null],
      [at(INBOX_URL_LIMIT), at(INBOX_URL_LIMIT)],
      [at(INBOX_URL_LIMIT + 1), null],
      [`${MASTODON}:0443/${"x".repeat(INBOX_URL_LIMIT - MASTODON.length - 1)}`, at(INBOX_URL_LIMIT)],
      [`${MASTODON}/in\0box`, null],
      [`${MASTODON}/in\u{1F600}box`, null],
      [`${MASTODON}/in%00box`, `${MASTODON}/in%00box`],
    ] as const) {
      expect(await read({ endpoints: { sharedInbox: value } }), value).toBe(shared);
      expect(await read({ endpoints: undefined, sharedInbox: value }), value).toBe(shared);
    }
  });

  // EP-T5: an actor whose endpoints is a Document signs a Create Kopje accepts (ID-1), and its Update(Person) applies.
  it("verifies a signature by, and applies an Update of, an actor whose endpoints is a Document (EP-T5)", async () => {
    const t = await setup();
    const endpoints = { type: "Document", sharedInbox: SI };
    const erin = await mastodonActor(t.web, "erin", { extra: { endpoints } });
    const note = mastodonNote(erin, {
      cc: [ALICE_URI],
      tag: [{ type: "Mention", href: ALICE_URI, name: "@alice@kopje.test" }],
    });
    expect(await t.post(erin, create(erin, note))).toBe(202);
    expect(await sql(t.store, "SELECT account_id FROM notifications WHERE type = 'mention'")).toEqual([
      { account_id: ALICE },
    ]);
    expect(await sharedInbox(t, erin.uri)).toBe(SI);
    const renamed = { ...erin.document, name: "erin renamed", endpoints: { type: "Service", proxyUrl: 5 } };
    const updateOf = { "@context": AS, id: `${erin.uri}#updates/1`, type: "Update", actor: erin.uri, object: renamed };
    expect(await t.post(erin, updateOf)).toBe(202);
    expect(await account(t, erin.uri)).toMatchObject({ display_name: "erin renamed" });
  });
});
