import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { selectSql } from "../src/db/columns";
import { Db } from "../src/db/sql";
import { jsonBytes } from "../src/domain/answer-budget";
import { deleteStatusBatch, PURGE_BATCH } from "../src/domain/inbox";
import {
  CARD_CANDIDATES,
  CARD_CREATOR_CHARS,
  CARD_RAW_HREF_LIMIT,
  type CardFields,
  creatorUsername,
  domainVariants,
  localCardLink,
} from "../src/domain/link-cards";
import type { RemoteStatusInput } from "../src/domain/remote-status-reads";
import { MAX_STATUS_MEDIA } from "../src/domain/remote-statuses";
import { CARD_JSON_MAX, cardIframe, type CardRow, presentCard } from "../src/domain/status-presenter";
import { CARD_COLUMN_MAP } from "../src/domain/status-rows";
import { storedFields } from "../src/federation/link-cards";
import { parseRemoteStatus } from "../src/federation/remote-status";
import { WEB_PAGE_URL_LIMIT } from "../src/federation/web-page";
import { SCAN_LIMITS } from "../src/platform/html-scan";
import { MAX_JSON_NODES, withinJsonBounds } from "../src/platform/json-bounds";
import type { StoreStub } from "../src/platform/store-client";
import {
  BLURHASH_BYTES,
  CARD_DIMENSION_MAX,
  CARD_EMBED_SRC_BYTES,
  CARD_EMBED_SRC_ESCAPED_BYTES,
  CARD_IMAGE_DESCRIPTION_JSON_BYTES,
  CARD_IMAGE_TOKEN_BYTES,
  CARD_IMAGE_URL_BYTES,
  CARD_LANGUAGE_BYTES,
  CARD_OPTIONAL_URL_LIMIT,
  CARD_TEXTS,
  CARD_URL_LIMIT,
  presentedCardText,
  presentedCardUrl,
  OEMBED_TEMPLATE_BYTES,
} from "../src/platform/stored-bounds";
import { bearer, json, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { BUILD } from "./helpers";
import { appToken } from "./read-helpers";
import { community, outbound, post, remoteAccount, remoteFollows } from "./status-helpers";

// A link of 0 by 0 without an embed, as 0069_card_embeds defaults a row.
const LINK_ROW = {
  card_type: 0,
  width: 0,
  height: 0,
  embed_src: "",
  iframe_width: null,
  iframe_height: null,
  image_description: "",
  image_token: null,
  image_width: null,
  image_height: null,
  blurhash: null,
};
const presentFor = (
  card: Partial<Omit<CardRow, "status_id">> & Pick<CardRow, "url" | "title">,
  origin = ORIGIN,
  viewerId: string | null = null,
) =>
  presentCard(
    { visibility: "public" },
    { status_id: "1", ...boundCard("ascii"), ...LINK_ROW, unverified_author_account_id: null, ...card },
    origin,
    viewerId,
  );

// Status cards (domain/link-cards.ts, federation/link-cards.ts): Mastodon's FetchLinkCardService (v4.5.11) as one
// copy per status, fetched by the cron's round through the web-page sink (NET-3).

const ORIGIN = "https://kopje.test";
const AS = "https://www.w3.org/ns/activitystreams";
const PUBLIC = `${AS}#Public`;
const CAROL = "https://remote.example/users/carol";

let sequence = 0;

function note(
  content: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> & { id: string; content: string } {
  const id = `${CAROL}/statuses/${++sequence}`;
  return {
    id,
    type: "Note",
    attributedTo: CAROL,
    published: "2026-10-11T12:00:00Z",
    to: [PUBLIC],
    cc: [`${CAROL}/followers`],
    content,
    ...extra,
  };
}

async function world() {
  const h = await community(["alice"]);
  const carol = await remoteAccount(h.store, "carol");
  // An input as the Worker hands it over, received as `type` at `at`.
  const send = (status: RemoteStatusInput, type: "Create" | "UpdateStatus" = "Create", at = NOW) =>
    h.store.receiveActivity(BUILD, {
      now: at,
      origin: ORIGIN,
      actorUri: CAROL,
      actor: null,
      actorRevision: null,
      recipient: "alice",
      activity: { type, id: `${status.uri}/activity/${at}`, object: status },
    });
  const receive = async (
    object: Record<string, unknown> & { id: string },
    type: "Create" | "UpdateStatus" = "Create",
    at = NOW,
  ) => {
    const status = parseRemoteStatus(object);
    expect(status).not.toBeNull();
    return send(status!, type, at);
  };
  const statusOf = async (uri: string) =>
    (await sql<{ id: string }>(h.store, "SELECT id FROM statuses WHERE uri = ?", uri))[0]?.id;
  const card = async (statusId: string | undefined) =>
    (
      await sql<{
        url: string;
        due_at: number | null;
        attempts: number;
        generation: number;
        fetched_at: number | null;
      }>(
        h.store,
        "SELECT url, due_at, attempts, generation, fetched_at FROM status_cards WHERE status_id = ?",
        statusId ?? "",
      )
    )[0];
  return { h, carol, send, receive, statusOf, card };
}

describe("link choice", () => {
  it("takes a remote status's first anchor that is not a hashtag's, and refuses an http one without advancing", async () => {
    const { receive, statusOf, card } = await world();
    // fetch_link_card_service_spec.rb, "with a remote status": the anchor without href and the rel=tag one are
    // skipped, and the first left is http://, which Mastodon fetches; the sink fetches https only, so no card.
    const spec = note(`Habt ihr ein paar gute Links zu <a>foo</a>
#<span class="tag"><a href="https://quitter.se/tag/wannacry" rel="tag noopener noreferrer">Wannacry</a></span> herumfliegen?
Ich will mal unter <br> <a href="http://example.com/not-found" rel="noopener noreferrer">http://example.com/not-found</a> was sammeln. !
<a href="https://sn.jonkman.ca/group/416/id" rel="noopener noreferrer">security</a>&nbsp;`);
    await receive(spec);
    expect(await card(await statusOf(spec.id))).toBeUndefined();
    const https = note(spec.content.replace("http://example.com/not-found", "https://example.com/not-found"));
    await receive(https);
    expect(await card(await statusOf(https.id))).toMatchObject({
      url: "https://example.com/not-found",
      due_at: NOW,
      attempts: 0,
      fetched_at: null,
    });
  });

  it("skips a microformats class, a non-http(s) anchor and the instance authority, but not another port of it", async () => {
    const { receive, statusOf, card } = await world();
    const skipped = [
      '<a class="u-url mention" href="https://a.example/x">a</a>',
      '<a class="xh-cardx" href="https://b.example/x">b</a>',
      '<a href="mailto:x@example.com">m</a>',
      '<a href="/relative">r</a>',
      '<a href="//other.example/x">no scheme</a>',
      `<a href="${ORIGIN}/@alice">local</a>`,
      `<a href="${ORIGIN}:443/x">default port</a>`,
    ].join(" ");
    const first = note(`${skipped} <a href="https://kopje.test:8443/a">port</a> <a href="https://c.example/">c</a>`);
    await receive(first);
    // Mastodon's local_url? compares the host with a non-default port: kopje.test:8443 is not the instance.
    expect(await card(await statusOf(first.id))).toMatchObject({ url: "https://kopje.test:8443/a" });
    const second = note(`${skipped} <a href="https://c.example/">c</a>`);
    await receive(second);
    expect(await card(await statusOf(second.id))).toMatchObject({ url: "https://c.example/" });
  });

  it("skips an anchor whose raw href is, by bytes, a mentioned account's URL", async () => {
    const { h, receive, statusOf, card } = await world();
    const dan = await remoteAccount(h.store, "dan", "other.example");
    await sql(h.store, "UPDATE accounts SET url = 'https://other.example/@Dan' WHERE id = ?", dan);
    const mention = { type: "Mention", href: "https://other.example/users/dan", name: "@dan@other.example" };
    const object = note(
      '<a href="https://other.example/@dan">@dan</a> <a href="https://other.example/@Dan">@Dan</a> <a href="https://d.example/">d</a>',
      { tag: [mention] },
    );
    await receive(object);
    // Only the exact spelling is the mention's: the lowercased one is a link.
    expect(await card(await statusOf(object.id))).toMatchObject({ url: "https://other.example/@dan" });
    const exact = note('<a href="https://other.example/@Dan">@Dan</a> <a href="https://d.example/">d</a>', {
      tag: [mention],
    });
    await receive(exact);
    expect(await card(await statusOf(exact.id))).toMatchObject({ url: "https://d.example/" });
  });

  // #1734: a mentioned account that stores no url is linked by its actor id, as Mastodon stores `url || @uri`.
  it("skips an anchor whose raw href is the actor id of a mentioned account without a url", async () => {
    const { h, receive, statusOf, card } = await world();
    const erin = await remoteAccount(h.store, "erin", "other.example");
    await sql(h.store, "UPDATE accounts SET url = NULL WHERE id = ?", erin);
    const { uri } = (await sql<{ uri: string }>(h.store, "SELECT uri FROM accounts WHERE id = ?", erin))[0]!;
    const content = `<a href="${uri}">@erin</a> <a href="https://d.example/">d</a>`;
    const mention = { type: "Mention", href: uri, name: "@erin@other.example" };
    const unset = note(content, { tag: [mention] });
    await receive(unset);
    expect(await card(await statusOf(unset.id))).toMatchObject({ url: "https://d.example/" });
    // With a url stored, the actor id is a link like any other.
    await sql(h.store, "UPDATE accounts SET url = 'https://other.example/@erin' WHERE id = ?", erin);
    const stored = note(content, { tag: [mention] });
    await receive(stored);
    expect(await card(await statusOf(stored.id))).toMatchObject({ url: uri });
  });

  it("refuses an unparsable or over-long first link, and keeps at most CARD_CANDIDATES anchors", async () => {
    const { receive, statusOf, card } = await world();
    const invalid = note('<a href="https://exa mple.com/">x</a> <a href="https://e.example/">e</a>');
    await receive(invalid);
    expect(await card(await statusOf(invalid.id))).toBeUndefined();
    const long = `https://e.example/${"a".repeat(CARD_URL_LIMIT)}`;
    const over = note(`<a href="${long}">x</a> <a href="https://e.example/">e</a>`);
    await receive(over);
    expect(await card(await statusOf(over.id))).toBeUndefined();
    const tags = Array.from({ length: CARD_CANDIDATES }, (_, i) => `<a href="mailto:${i}@x.example">${i}</a>`).join(
      " ",
    );
    const late = note(`${tags} <a href="https://e.example/">e</a>`);
    await receive(late);
    expect(await card(await statusOf(late.id))).toBeUndefined();
    const inTime = note(`${tags.split(" ").slice(1).join(" ")} <a href="https://e.example/">e</a>`);
    await receive(inTime);
    expect(await card(await statusOf(inTime.id))).toMatchObject({ url: "https://e.example/" });
  });

  it("takes a local post's first link that is not the instance's", async () => {
    expect(CARD_URL_LIMIT).toBe(WEB_PAGE_URL_LIMIT);
    const domain = "kopje.test";
    expect(localCardLink("see https://kopje.test/@bob then https://e.example/a?b#c", domain)).toBe(
      "https://e.example/a?b#c",
    );
    expect(localCardLink("http://e.example/ and https://f.example/", domain)).toBe("http://e.example/");
    expect(localCardLink("https://kopje.test:8443/", domain)).toBe("https://kopje.test:8443/");
    expect(localCardLink("no link, @bob@e.example #tag", domain)).toBeNull();
    const h = await community(["alice"]);
    const status = await post(h, h.users.alice, { status: "https://kopje.test/@bob https://e.example/x" });
    expect(await sql(h.store, "SELECT url, due_at FROM status_cards WHERE status_id = ?", status.id)).toEqual([
      { url: "https://e.example/x", due_at: NOW },
    ]);
  });
});

// FEP-8967 Link attachments as Mastodon 4.7 reads them (Create#process_attachments, PreviewCardParser#url over
// Addressable 2.9.2): federation/remote-status.ts cardLinkOf in the Worker, remoteCardLink in the Store.
describe("FEP-8967 Link", () => {
  const link = (href: unknown) => ({ type: "Link", href });
  const png = (i: number) => ({ type: "Document", mediaType: "image/png", url: `https://remote.example/m/${i}.png` });
  const ANCHOR = '<a href="https://a.example/">a</a>';

  it("takes a Link over the content's anchors", async () => {
    const { receive, statusOf, card } = await world();
    const object = note(ANCHOR, { attachment: [link("https://b.example/")] });
    await receive(object);
    expect(await card(await statusOf(object.id))).toMatchObject({ url: "https://b.example/", due_at: NOW });
    // One attachment, not in an array; the scheme in any case, normalized.
    const upper = note(ANCHOR, { attachment: link("HTTPS://B.example/x") });
    expect(parseRemoteStatus(upper)!.cardLink).toEqual({ href: "https://b.example/x" });
    await receive(upper);
    expect(await card(await statusOf(upper.id))).toMatchObject({ url: "https://b.example/x" });
    // At CARD_RAW_HREF_LIMIT code units, taken.
    const longest = `https://b.example/${"a".repeat(CARD_RAW_HREF_LIMIT - "https://b.example/".length)}`;
    expect(longest).toHaveLength(CARD_RAW_HREF_LIMIT);
    const atLimit = note(ANCHOR, { attachment: [link(longest)] });
    await receive(atLimit);
    expect(await card(await statusOf(atLimit.id))).toMatchObject({ url: longest });
  });

  it("gives no card for a Link the rules refuse, reading no anchor or later Link", async () => {
    const { receive, statusOf, card } = await world();
    const over = `https://b.example/${"a".repeat(CARD_RAW_HREF_LIMIT + 1 - "https://b.example/".length)}`;
    expect(over).toHaveLength(CARD_RAW_HREF_LIMIT + 1);
    // Within the raw bound, past CARD_URL_LIMIT once WHATWG percent-encodes it.
    const expanding = `https://b.example/${"é".repeat(400)}`;
    expect(new URL(expanding).href.length).toBeGreaterThan(CARD_URL_LIMIT);
    const refused: [string, string | null][] = [
      ["http://b.example/", "http://b.example/"],
      [over, null],
      ["https:///b", null],
      [expanding, null],
    ];
    for (const [href, read] of refused) {
      const object = note(ANCHOR, { attachment: [link(href), link("https://c.example/")] });
      expect(parseRemoteStatus(object)!.cardLink, href).toEqual({ href: read });
      await receive(object);
      expect(await card(await statusOf(object.id)), href).toBeUndefined();
    }
    // Without one of them, the next Link is the card's.
    const control = note(ANCHOR, { attachment: [link("https://c.example/")] });
    await receive(control);
    expect(await card(await statusOf(control.id))).toMatchObject({ url: "https://c.example/" });
  });

  it("skips a Link of another scheme, without an authority, with leading whitespace, unparsable or without a host", async () => {
    const { receive, statusOf, card } = await world();
    const skipped = [
      "ftp:x",
      "ftp://b.example/",
      "https:b.example",
      "https:/b.example",
      "https://",
      "https://?x",
      "https://#x",
      " https://b.example/",
      "https://[",
      // Skipped whatever their length: the length is judged after the scheme and the empty authority.
      `ftp:${"x".repeat(CARD_RAW_HREF_LIMIT + 1 - "ftp:".length)}`,
      `https://?${"x".repeat(CARD_RAW_HREF_LIMIT + 1 - "https://?".length)}`,
    ];
    for (const href of skipped) {
      const object = note(ANCHOR, { attachment: [link(href), link("https://c.example/2")] });
      expect(parseRemoteStatus(object)!.cardLink, href).toEqual({ href: "https://c.example/2" });
      await receive(object);
      expect(await card(await statusOf(object.id)), href).toMatchObject({ url: "https://c.example/2" });
    }
    const only = note(ANCHOR, { attachment: skipped.map(link) });
    expect(parseRemoteStatus(only)!.cardLink).toBeNull();
    await receive(only);
    expect(await card(await statusOf(only.id))).toMatchObject({ url: "https://a.example/" });
  });

  it("takes a Link naming the instance itself, or a mentioned account's URL", async () => {
    const { h, receive, statusOf, card } = await world();
    const own = `${ORIGIN}/@alice/1`;
    // As an anchor the instance's own URL is skipped; as a Link it is taken.
    const anchored = note(`<a href="${own}">own</a> ${ANCHOR}`);
    await receive(anchored);
    expect(await card(await statusOf(anchored.id))).toMatchObject({ url: "https://a.example/" });
    const linked = note(ANCHOR, { attachment: [link(own)] });
    await receive(linked);
    expect(await card(await statusOf(linked.id))).toMatchObject({ url: own });
    // As an anchor a mentioned account's URL is skipped; as a Link it is taken.
    const dan = await remoteAccount(h.store, "dan", "other.example");
    await sql(h.store, "UPDATE accounts SET url = 'https://other.example/@Dan' WHERE id = ?", dan);
    const tag = [{ type: "Mention", href: "https://other.example/users/dan", name: "@dan@other.example" }];
    const mentioned = note(`<a href="https://other.example/@Dan">@Dan</a> ${ANCHOR}`, { tag });
    await receive(mentioned);
    expect(await card(await statusOf(mentioned.id))).toMatchObject({ url: "https://a.example/" });
    const mentionLinked = note(ANCHOR, { tag, attachment: [link("https://other.example/@Dan")] });
    await receive(mentionLinked);
    expect(await card(await statusOf(mentionLinked.id))).toMatchObject({ url: "https://other.example/@Dan" });
  });

  it("finds the Link after the media and the anchors' cap, as many attachments as the JSON bounds admit", async () => {
    const { receive, statusOf, card } = await world();
    const tags = Array.from({ length: CARD_CANDIDATES + 1 }, (_, i) => `<a href="mailto:${i}@x.example">${i}</a>`);
    // Five media, then one-key attachments up to the largest count withinJsonBounds admits, then the Link.
    const rest = (fill: number) => [...Array.from({ length: fill }, () => ({ a: 1 })), link("https://b.example/last")];
    const build = (fill: number) => note(tags.join(" "), { attachment: [...[0, 1, 2, 3, 4].map(png), ...rest(fill)] });
    let fill = Math.floor(MAX_JSON_NODES / 2);
    while (!withinJsonBounds(build(fill))) {
      fill -= 1;
    }
    expect(withinJsonBounds(build(fill + 1))).toBe(false);
    expect(fill).toBeGreaterThan(MAX_JSON_NODES / 2 - 100);
    const object = build(fill);
    const parsed = parseRemoteStatus(object)!;
    expect(parsed.media).toHaveLength(MAX_STATUS_MEDIA);
    expect(parsed.cardCandidates).toHaveLength(CARD_CANDIDATES);
    expect(parsed.cardLink).toEqual({ href: "https://b.example/last" });
    // The media make the status ineligible; without them, the Link is its card.
    const withoutMedia = { ...object, id: `${object.id}/b`, attachment: rest(fill) };
    expect(withinJsonBounds(withoutMedia)).toBe(true);
    await receive(withoutMedia);
    expect(await card(await statusOf(withoutMedia.id))).toMatchObject({ url: "https://b.example/last" });
  }, 30_000);

  it("resets on a significant Update only, to the Update's Link", async () => {
    const { h, receive, statusOf, card } = await world();
    const object = note("<p>one</p>", { attachment: [link("https://b.example/1")] });
    await receive(object);
    const id = (await statusOf(object.id))!;
    expect(await card(id)).toMatchObject({ url: "https://b.example/1", due_at: NOW });
    await sql(
      h.store,
      "UPDATE status_cards SET due_at = NULL, fetched_at = 1, title = 't', attempts = 0 WHERE status_id = ?",
      id,
    );
    const linkOnly = await receive(
      { ...object, updated: "2026-10-11T13:00:00Z", attachment: [link("https://b.example/2")] },
      "UpdateStatus",
      NOW + 1,
    );
    expect(linkOnly).toMatchObject({ applied: true, reason: "updated" });
    expect(await card(id)).toMatchObject({ url: "https://b.example/1", due_at: null, fetched_at: 1 });
    const edited = await receive(
      { ...object, updated: "2026-10-11T14:00:00Z", content: "<p>two</p>", attachment: [link("https://c.example/")] },
      "UpdateStatus",
      NOW + 2,
    );
    expect(edited).toMatchObject({ applied: true, reason: "edited" });
    expect(await card(id)).toMatchObject({ url: "https://c.example/", due_at: NOW + 2, fetched_at: null });
  });

  it("decides an input without cardLink by its anchors, and creates an unknown status from its Update with its Link", async () => {
    const { send, receive, statusOf, card } = await world();
    for (const cardLink of [undefined, null]) {
      const object = note(ANCHOR, { attachment: [link("https://b.example/")] });
      const { cardLink: _, ...earlier } = parseRemoteStatus(object)!;
      await send(cardLink === undefined ? earlier : { ...earlier, cardLink });
      expect(await card(await statusOf(object.id)), String(cardLink)).toMatchObject({ url: "https://a.example/" });
    }
    const unknown = note(ANCHOR, { updated: "2026-10-11T13:00:00Z", attachment: [link("https://b.example/u")] });
    expect(await receive(unknown, "UpdateStatus")).toMatchObject({ applied: true });
    expect(await card(await statusOf(unknown.id))).toMatchObject({ url: "https://b.example/u" });
  });

  it("takes a converted Article's and an embedded quote's Link, and none for a status with a shown attachment", async () => {
    const { receive, statusOf, card } = await world();
    const article = {
      ...note(""),
      type: "Article",
      name: "Title",
      url: "https://remote.example/articles/1",
      attachment: [link("https://b.example/article")],
    };
    await receive(article);
    expect(await card(await statusOf(article.id))).toMatchObject({ url: "https://b.example/article" });
    const quoted = note("<p>quoted</p>", { attachment: [link("https://b.example/quoted")] });
    const quoting = note("<p>quoting</p>", { quote: quoted });
    expect(parseRemoteStatus(quoting)!.quote?.embedded?.cardLink).toEqual({ href: "https://b.example/quoted" });
    await receive(quoting);
    const quotedId = await statusOf(quoted.id);
    expect(quotedId).toBeDefined();
    expect(await card(quotedId)).toMatchObject({ url: "https://b.example/quoted" });
    expect(await card(await statusOf(quoting.id))).toBeUndefined();
    const withMedia = note(ANCHOR, { attachment: [png(0), link("https://b.example/media")] });
    const parsed = parseRemoteStatus(withMedia)!;
    expect(parsed.media).toHaveLength(1);
    expect(parsed.cardLink).toEqual({ href: "https://b.example/media" });
    await receive(withMedia);
    expect(await statusOf(withMedia.id)).toBeDefined();
    expect(await card(await statusOf(withMedia.id))).toBeUndefined();
  });
});

describe("enqueue and reset", () => {
  it("enqueues public and unlisted posts only, and resets on a text edit", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const cardOf = async (id: string) =>
      (
        await sql<{ url: string; generation: number }>(
          h.store,
          "SELECT url, generation FROM status_cards WHERE status_id = ?",
          id,
        )
      )[0];
    for (const visibility of ["private", "direct"]) {
      const status = await post(h, alice, { status: "https://e.example/", visibility });
      expect(await cardOf(status.id), visibility).toBeUndefined();
    }
    const unlisted = await post(h, alice, { status: "https://e.example/u", visibility: "unlisted" });
    expect(await cardOf(unlisted.id)).toMatchObject({ url: "https://e.example/u" });
    const status = await post(h, alice, { status: "one https://e.example/1" });
    const queued = await cardOf(status.id);
    expect(queued).toMatchObject({ url: "https://e.example/1" });
    await sql(
      h.store,
      "UPDATE status_cards SET due_at = NULL, fetched_at = 1, title = 't', attempts = 0 WHERE status_id = ?",
      status.id,
    );
    const edit = (body: Record<string, unknown>) =>
      h.request(`/api/v1/statuses/${status.id}`, bearer(alice.token, json(body, { method: "PUT" })));
    // No text change: the card stays.
    expect((await edit({ status: "one https://e.example/1", sensitive: true })).status).toBe(200);
    expect(await sql(h.store, "SELECT fetched_at FROM status_cards WHERE status_id = ?", status.id)).toEqual([
      { fetched_at: 1 },
    ]);
    // A text change keeping the URL fetches again (a declared deviation: no shared cache entry to reuse here).
    expect((await edit({ status: "two https://e.example/1" })).status).toBe(200);
    const reset = await sql<{ url: string; due_at: number; fetched_at: null; title: string; generation: number }>(
      h.store,
      "SELECT url, due_at, fetched_at, title, generation FROM status_cards WHERE status_id = ?",
      status.id,
    );
    expect(reset).toEqual([
      { url: "https://e.example/1", due_at: NOW, fetched_at: null, title: "", generation: expect.any(Number) },
    ]);
    // A text change to no link deletes the row.
    expect((await edit({ status: "three, no link" })).status).toBe(200);
    expect(await cardOf(status.id)).toBeUndefined();
  });

  it("enqueues no status with a shown attachment or a quote, and one whose media an edit removed", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const media = await sql<{ id: string }>(
      h.store,
      `INSERT INTO media_attachments (id, account_id, type, url, created_at)
			VALUES ('100000000000000777', ?, 'image', 'https://kopje.test/files/m', '2026-10-12T00:00:00.000Z') RETURNING id`,
      alice.id,
    );
    const withMedia = await post(h, alice, { status: "https://e.example/", media_ids: [media[0]!.id] });
    expect(await sql(h.store, "SELECT * FROM status_cards WHERE status_id = ?", withMedia.id)).toEqual([]);
    // The media removed, then the text edited: enqueued (Mastodon's with_media? reads the current attachments).
    const edit = (body: Record<string, unknown>) =>
      h.request(`/api/v1/statuses/${withMedia.id}`, bearer(alice.token, json(body, { method: "PUT" })));
    expect((await edit({ status: "https://e.example/", media_ids: [] })).status).toBe(200);
    expect(await sql(h.store, "SELECT count(*) AS n FROM status_cards")).toEqual([{ n: 0 }]);
    expect((await edit({ status: "now https://e.example/", media_ids: [] })).status).toBe(200);
    expect(await sql(h.store, "SELECT url FROM status_cards WHERE status_id = ?", withMedia.id)).toEqual([
      { url: "https://e.example/" },
    ]);
    // A quote: no card.
    const quoted = await post(h, alice, { status: "quoted" });
    const quoting = await post(h, alice, { status: "q https://e.example/q", quoted_status_id: quoted.id });
    expect(await sql(h.store, "SELECT * FROM status_cards WHERE status_id = ?", quoting.id)).toEqual([]);
  });

  it("enqueues a remote status on creation, resets it on a significant update only, never a private one", async () => {
    const { receive, statusOf, card } = await world();
    const object = note('<p><a href="https://e.example/1">1</a></p>');
    await receive(object);
    const id = await statusOf(object.id);
    const first = await card(id);
    expect(first).toMatchObject({ url: "https://e.example/1", due_at: NOW });
    await receive(
      { ...object, updated: "2026-10-11T13:00:00Z", content: '<p><a href="https://e.example/2">2</a></p>' },
      "UpdateStatus",
      NOW + 1,
    );
    expect(await card(id)).toMatchObject({ url: "https://e.example/2", due_at: NOW + 1 });
    // Not significant (the content unchanged): nothing reset.
    await receive(
      {
        ...object,
        updated: "2026-10-11T14:00:00Z",
        content: '<p><a href="https://e.example/2">2</a></p>',
        sensitive: true,
      },
      "UpdateStatus",
      NOW + 2,
    );
    expect(await card(id)).toMatchObject({ url: "https://e.example/2", due_at: NOW + 1 });
    for (const [to, cc] of [
      [[`${CAROL}/followers`], []],
      [["https://kopje.test/ap/users/alice"], []],
    ]) {
      const hidden = note('<a href="https://e.example/p">p</a>', {
        to,
        cc,
        tag: [{ type: "Mention", href: "https://kopje.test/ap/users/alice" }],
      });
      await receive(hidden);
      const stored = await statusOf(hidden.id);
      expect(stored).toBeDefined();
      expect(await card(stored)).toBeUndefined();
    }
  });
});

// A local status's Note lists its shown card as a FEP-8967 Link after its media, as Mastodon 4.7's
// ActivityPub::NoteSerializer#virtual_attachments does (activities.ts statusFacts, status-presenter.ts shownCardUrl).
describe("a local status's Note", () => {
  const AP = { headers: { accept: "application/activity+json" } };
  type Note = { id: string; attachment: Record<string, unknown>[] };
  const LINK = { type: "Link", href: "https://e.example/x" };
  const attach = (h: Awaited<ReturnType<typeof community>>, id: string, title = "t") =>
    sql(
      h.store,
      "UPDATE status_cards SET due_at = NULL, fetched_at = 1, title = ?2, attempts = 0 WHERE status_id = ?1",
      id,
      title,
    );
  const served = async (h: Awaited<ReturnType<typeof community>>, uri: unknown) => {
    const response = await h.request(new URL(String(uri)).pathname, AP);
    expect(response.status).toBe(200);
    return (await response.json<Note>()).attachment;
  };
  // A remote follower of alice, so that her activities are recorded for delivery.
  const followed = async (h: Awaited<ReturnType<typeof community>>) =>
    remoteFollows(h.store, await remoteAccount(h.store, "far", "far.example"), h.users.alice!.id);
  // The Note of each recorded activity of `type`, in order.
  const recorded = async (h: Awaited<ReturnType<typeof community>>, type: string) =>
    (await outbound(h.store))
      .filter((o) => o.activity.type === type)
      .map((o) => (o.activity.object as Note).attachment);
  const media = async (h: Awaited<ReturnType<typeof community>>, accountId: string, n: number) =>
    (
      await sql<{ id: string }>(
        h.store,
        `INSERT INTO media_attachments (id, account_id, type, url, created_at)
				VALUES (?1, ?2, 'image', 'https://kopje.test/files/m' || ?1, '2026-10-12T00:00:00.000Z') RETURNING id`,
        `10000000000000${String(n).padStart(4, "0")}`,
        accountId,
      )
    )[0]!.id;

  it("lists the attached card as a Link after the media, at the object endpoint, the outbox and the featured collection", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const status = await post(h, alice, { status: "see https://e.example/x" });
    await attach(h, status.id);
    expect(await served(h, status.uri)).toEqual([LINK]);
    const outbox = await h.request("/ap/users/alice/outbox?cursor=first", AP);
    const page = await outbox.json<{ orderedItems: { type: string; object: Note }[] }>();
    expect(page.orderedItems.map((item) => [item.type, item.object.attachment])).toEqual([["Create", [LINK]]]);
    expect((await h.request(`/api/v1/statuses/${status.id}/pin`, bearer(alice.token, { method: "POST" }))).status).toBe(
      200,
    );
    const featured = await (
      await h.request("/ap/users/alice/collections/featured", AP)
    ).json<{ orderedItems: Note[] }>();
    expect(featured.orderedItems.map((note) => note.attachment)).toEqual([[LINK]]);
    // A status with media and an attached card (an imported row): the Documents, then the Link.
    const withMedia = await post(h, alice, { status: "no link", media_ids: [await media(h, alice.id, 1)] });
    await sql(
      h.store,
      `INSERT INTO status_cards (status_id, url, enqueued_at, generation, title, fetched_at)
			VALUES (?, 'https://e.example/x', 0, 0, 't', 1)`,
      withMedia.id,
    );
    const attachments = await served(h, withMedia.uri);
    expect(attachments.map((attachment) => attachment.type)).toEqual(["Document", "Link"]);
    expect(attachments.at(-1)).toEqual(LINK);
  });

  it("lists none while the card is pending: the Create at posting, a text edit's Update and an imported row", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    await followed(h);
    const status = await post(h, alice, { status: "see https://e.example/x" });
    expect(await recorded(h, "Create")).toEqual([[]]);
    // A pending row with a title, as an import may hold it (0067's attached-title rule judges attached rows only).
    await sql(h.store, "UPDATE status_cards SET title = 't' WHERE status_id = ?", status.id);
    expect(await sql(h.store, "SELECT fetched_at, title FROM status_cards WHERE status_id = ?", status.id)).toEqual([
      { fetched_at: null, title: "t" },
    ]);
    expect(await served(h, status.uri)).toEqual([]);
    await attach(h, status.id);
    expect(await served(h, status.uri)).toEqual([LINK]);
    // A text edit resets the card in its own transaction: its Update lists none.
    const edit = await h.request(
      `/api/v1/statuses/${status.id}`,
      bearer(alice.token, json({ status: "now see https://e.example/x" }, { method: "PUT" })),
    );
    expect(edit.status).toBe(200);
    expect(await recorded(h, "Update")).toEqual([[]]);
    expect(await served(h, status.uri)).toEqual([]);
  });

  it("lists none where the API shows none: a private status's imported card, a blank title", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    await followed(h);
    const hidden = await post(h, alice, { status: "see https://e.example/x", visibility: "private" });
    await sql(
      h.store,
      `INSERT INTO status_cards (status_id, url, enqueued_at, generation, title, fetched_at)
			VALUES (?, 'https://e.example/x', 0, 0, 't', 1)`,
      hidden.id,
    );
    // An edit that keeps the text records its Note in an Update and leaves the card attached.
    const edit = await h.request(
      `/api/v1/statuses/${hidden.id}`,
      bearer(alice.token, json({ status: "see https://e.example/x", sensitive: true }, { method: "PUT" })),
    );
    expect(edit.status).toBe(200);
    expect(await sql(h.store, "SELECT fetched_at FROM status_cards WHERE status_id = ?", hidden.id)).toEqual([
      { fetched_at: 1 },
    ]);
    expect(await recorded(h, "Update")).toEqual([[]]);
    const shown = await h.request(`/api/v1/statuses/${hidden.id}`, bearer(alice.token));
    expect((await shown.json<{ card: unknown }>()).card).toBeNull();
    // A title of spaces is blank; the same status with a title lists the Link.
    const blank = await post(h, alice, { status: "see https://e.example/x" });
    await attach(h, blank.id, "   ");
    expect(await served(h, blank.uri)).toEqual([]);
    await attach(h, blank.id);
    expect(await served(h, blank.uri)).toEqual([LINK]);
  });

  it("lists it in the Update of an edit that keeps the text and in a quote-policy Update", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    await followed(h);
    const status = await post(h, alice, { status: "see https://e.example/x" });
    await attach(h, status.id);
    const edit = await h.request(
      `/api/v1/statuses/${status.id}`,
      bearer(
        alice.token,
        json({ status: "see https://e.example/x", media_ids: [await media(h, alice.id, 2)] }, { method: "PUT" }),
      ),
    );
    expect(edit.status).toBe(200);
    const edited = await recorded(h, "Update");
    expect(edited.map((note) => note.map((attachment) => attachment.type))).toEqual([["Document", "Link"]]);
    expect(edited[0]!.at(-1)).toEqual(LINK);
    // The policy's Update supersedes the waiting one.
    const policy = await h.request(
      `/api/v1/statuses/${status.id}/interaction_policy`,
      bearer(alice.token, json({ quote_approval_policy: "nobody" }, { method: "PUT" })),
    );
    expect(policy.status).toBe(200);
    const updates = await recorded(h, "Update");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.at(-1)).toEqual(LINK);
  });
});

describe("the hide step of a remote delete", () => {
  // deleteStatusBatch hides a status with four rows left (HIDE_ROWS): the status, the account's last status
  // (0021_directory), its card row and the copy of withdrawn on its own quote row when an import marked that row local
  // (0091_live_local_quotes); with three left it waits for the next batch. Each with and without that quote row.
  it.each([
    [4, true],
    [4, false],
    [3, true],
    [3, false],
  ] as const)("deletes the card with the hide when %i rows are left (a local quote row: %s)", async (left, quoted) => {
    const { h, carol } = await world();
    const status = await runInDurableObject(h.store, (_instance, state) => {
      const db = new Db(state.storage.sql);
      const id = "100000000000000500";
      db.run(
        `INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
				VALUES (?, 'https://remote.example/s/500', ?, 'public', 'x', '2026-10-12T00:00:00.000Z')`,
        id,
        carol,
      );
      db.run(
        "INSERT INTO status_cards (status_id, url, due_at, enqueued_at, generation) VALUES (?, 'https://e.example/', 1, 1, 1)",
        id,
      );
      if (quoted) {
        db.run(
          `INSERT INTO quotes (status_id, quoted_uri, state, local, updated_at)
						VALUES (?, 'https://elsewhere.example/s/1', 'pending', 1, '2026-10-12T00:00:00.000Z')`,
          id,
        );
      }
      return id;
    });
    await sql(
      h.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO accounts (id, uri, username, domain)
			SELECT printf('6%017d', i), 'https://many.example/users/m' || i, 'm' || i, 'many.example' FROM n`,
      PURGE_BATCH - left,
    );
    await sql(
      h.store,
      "INSERT INTO status_mentions (status_id, account_id) SELECT ?, id FROM accounts WHERE id GLOB '6*'",
      status,
    );
    const wrote = await runInDurableObject(h.store, (_instance, state) => {
      const db = new Db(state.storage.sql);
      const changes = () => db.first<{ n: number }>("SELECT total_changes() AS n")!.n;
      const before = changes();
      state.storage.transactionSync(() => deleteStatusBatch(db, status, NOW));
      return changes() - before;
    });
    const hidden = await sql<{ visibility: string }>(h.store, "SELECT visibility FROM statuses WHERE id = ?", status);
    expect(hidden).toEqual([{ visibility: left === 4 ? "direct" : "public" }]);
    expect(await sql(h.store, "SELECT count(*) AS n FROM status_cards")).toEqual([{ n: left === 4 ? 0 : 1 }]);
    if (quoted && left === 4) {
      expect(await sql(h.store, "SELECT withdrawn FROM quotes WHERE status_id = ?", status)).toEqual([
        { withdrawn: 1 },
      ]);
    }
    // Waiting, the batch's room goes to the status's children instead: its quote row is one.
    expect(wrote).toBe(left === 4 ? PURGE_BATCH - (quoted ? 0 : 1) : PURGE_BATCH - 3 + (quoted ? 1 : 0));
  });
});

// A card at its stored bounds, each text filled with `fill` to its JSON bound (escaped: six JSON bytes a character, the
// rest of the bound in ASCII; astral: four UTF-8 bytes; ascii: one), its URLs printable ASCII at their bounds.
function boundCard(fill: "escaped" | "astral" | "ascii") {
  const text = (bytes: number) =>
    fill === "escaped"
      ? "\u0001".repeat(Math.floor((bytes - 2) / 6)) + "a".repeat((bytes - 2) % 6)
      : fill === "astral"
        ? "\u{1f600}".repeat(Math.floor((bytes - 2) / 4))
        : "a".repeat(bytes - 2);
  const url = (prefix: string, limit = CARD_OPTIONAL_URL_LIMIT) => prefix.padEnd(limit, "u");
  // The src at its escaped bound: in the escaped fill, as many & as fit (each five bytes escaped).
  const ampersands = Math.floor((CARD_EMBED_SRC_ESCAPED_BYTES - "https://v.example/?".length) / 5);
  const src =
    fill === "escaped"
      ? `https://v.example/?${"&".repeat(ampersands)}`.padEnd(CARD_EMBED_SRC_ESCAPED_BYTES - 4 * ampersands, "u")
      : url("https://v.example/", CARD_EMBED_SRC_BYTES);
  return {
    card_type: 2,
    width: CARD_DIMENSION_MAX,
    height: CARD_DIMENSION_MAX,
    embed_src: src,
    iframe_width: CARD_DIMENSION_MAX,
    iframe_height: CARD_DIMENSION_MAX,
    url: url("https://card.example/", CARD_URL_LIMIT),
    title: text(CARD_TEXTS.title),
    description: text(CARD_TEXTS.description),
    author_name: text(CARD_TEXTS.author_name),
    author_url: url("https://author.example/"),
    provider_name: text(CARD_TEXTS.provider_name),
    provider_url: url("http://provider.example/"),
    language: "mn-Mong",
    published_at: "2026-10-12T00:00:00.000Z",
    // 0070_card_images: a stored image of a 64-byte token, a 5 × 5 blurhash, the alt text at its bound.
    image_description: text(CARD_IMAGE_DESCRIPTION_JSON_BYTES),
    image_token: "t".repeat(CARD_IMAGE_TOKEN_BYTES),
    image_width: CARD_DIMENSION_MAX,
    image_height: CARD_DIMENSION_MAX,
    blurhash: `e${"0".repeat(BLURHASH_BYTES - 1)}`,
  };
}

// An origin of a 253-byte host (four labels of 63 bytes and one of 1), so a card image's URL is at its bound.
// A signed-in viewer that is not the card's unverified author.
const VIEWER = "100000000000000009";
const LONG_ORIGIN = `https://${["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(59), "e"].join(".")}`;

async function attach(store: StoreStub, statusId: string, card: Record<string, string | null>): Promise<void> {
  await sql(
    store,
    `INSERT INTO status_cards (status_id, url, enqueued_at, generation, title, description, author_name, author_url,
			provider_name, provider_url, language, published_at, fetched_at, unverified_author_account_id)
		VALUES (?1, ?2, 0, 0, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1, ?11)
		ON CONFLICT (status_id) DO UPDATE SET url = ?2, due_at = NULL, title = ?3, description = ?4, author_name = ?5,
			author_url = ?6, provider_name = ?7, provider_url = ?8, language = ?9, published_at = ?10, fetched_at = 1,
			unverified_author_account_id = ?11`,
    statusId,
    card.url ?? null,
    card.title ?? null,
    card.description ?? "",
    card.author_name ?? "",
    card.author_url ?? "",
    card.provider_name ?? "",
    card.provider_url ?? "",
    card.language ?? null,
    card.published_at ?? null,
    card.unverified_author_account_id ?? null,
  );
}

describe("the unverified author's creator and host (creatorUsername, domainVariants)", () => {
  it("reads a creator as ResolveAccountService does up to its direct-local resolution, and fetches nothing", () => {
    for (const [creator, username] of [
      ["alice", "alice"],
      ["@alice", "alice"],
      ["alice@kopje.test", "alice"],
      ["@alice@KOPJE.TEST", "alice"],
      ["alice@kopje.test/", "alice"],
      [" alice@kopje.test\n", "alice"],
      ["\u0000\talice\v\f\r", "alice"],
      ["alice@", "alice"],
      ["alice@kopje.test@x", "alice"],
      ["alice@other.example", null],
      ["a@@kopje.test", null],
      // One leading @ removed: the next is an empty username.
      ["@@alice", null],
      // One trailing / removed.
      ["alice@kopje.test//", null],
      ["", null],
      ["@", null],
      ["\u3000", null],
      // U+3000 is blank (Rails) but not stripped (Ruby).
      ["\u3000alice", "\u3000alice"],
      // Names Mastodon may reach through WebFinger: an alias and an explicit port.
      ["alice@www.kopje.test", null],
      ["alice@kopje.test:443", null],
    ] as const) {
      expect(creatorUsername(creator, "kopje.test"), JSON.stringify(creator)).toBe(username);
    }
    // The Unicode spelling of a punycode domain, which only IDNA (Mastodon's WebFinger lookup) would equate.
    expect(creatorUsername("alice@bücher.example", "xn--bcher-kva.example")).toBeNull();
    expect(creatorUsername("alice@XN--BCHER-KVA.example", "xn--bcher-kva.example")).toBe("alice");
  });

  it("gives a host and each suffix after a dot, a trailing dot's empty label dropped", () => {
    expect(domainVariants("a.b.example")).toEqual(["a.b.example", "b.example", "example"]);
    expect(domainVariants("example.com.")).toEqual(["example.com", "com"]);
    expect(domainVariants("example")).toEqual(["example"]);
    expect(domainVariants("")).toEqual([]);
  });

  it("keeps a creator within the scan's bound in the round's fields, and none past it", () => {
    expect(CARD_CREATOR_CHARS).toBe(SCAN_LIMITS.valueChars);
    const fields: CardFields = {
      title: "t",
      description: "",
      authorName: "",
      authorUrl: "",
      providerName: "",
      providerUrl: "",
      language: null,
      publishedAt: null,
      type: "link",
      width: 0,
      height: 0,
      embedSrc: "",
      iframeWidth: null,
      iframeHeight: null,
      imageUrl: "",
      imageDescription: "",
      linkType: "unknown",
      finalUrl: "",
      creator: null,
    };
    // Astral characters count two code units each.
    const kept = `alice${"\u{1f600}".repeat(1021)}x`;
    expect(kept).toHaveLength(CARD_CREATOR_CHARS);
    expect(storedFields({ ...fields, creator: kept }).creator).toBe(kept);
    expect(storedFields({ ...fields, creator: `${kept}a` }).creator).toBeNull();
    expect(storedFields(fields).creator).toBeNull();
  });
});

describe("presentation", () => {
  const SHAPE = {
    url: "https://e.example/a",
    title: "T",
    description: "D",
    language: "ja",
    type: "link",
    author_name: "Ann",
    author_url: "https://e.example/ann",
    provider_name: "P",
    provider_url: "https://e.example/",
    html: "",
    width: 0,
    height: 0,
    image: null,
    image_description: "",
    embed_url: "",
    blurhash: null,
    published_at: "2026-10-11T00:00:00.000Z",
    // Every request below is signed in.
    missing_attribution: false,
    authors: [{ name: "Ann", url: "https://e.example/ann", account: null }],
  };
  const stored = {
    url: SHAPE.url,
    title: "T",
    description: "D",
    author_name: "Ann",
    author_url: SHAPE.author_url,
    provider_name: "P",
    provider_url: SHAPE.provider_url,
    language: "ja",
    published_at: SHAPE.published_at,
  };

  it("shows a card as Mastodon's PreviewCardSerializer, on the status and its boost's original, not as a quoted status", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    const status = await post(h, alice, { status: "card https://e.example/a" });
    await attach(h.store, status.id, stored);
    const get = async (id: string, token = alice.token) =>
      (await h.request(`/api/v1/statuses/${id}`, bearer(token))).json<Record<string, unknown>>();
    expect((await get(status.id)).card).toEqual(SHAPE);
    const boost = await (
      await h.request(`/api/v1/statuses/${status.id}/reblog`, bearer(bob.token, { method: "POST" }))
    ).json<{ id: string }>();
    const boosted = await get(boost.id, bob.token);
    expect(boosted.card).toBeNull();
    expect((boosted.reblog as { card: unknown }).card).toEqual(SHAPE);
    const quoting = await post(h, bob, { status: "quoting", quoted_status_id: status.id });
    const shown = await get(quoting.id, bob.token);
    expect(shown.card).toBeNull();
    // A quoted status shows no card (a declared deviation: Mastodon's ShallowStatusSerializer shows one).
    expect((shown.quote as { quoted_status: { card: unknown } }).quoted_status.card).toBeNull();
    // The timeline shows the same.
    const home = await (
      await h.request("/api/v1/timelines/home", bearer(alice.token))
    ).json<{ id: string; card: unknown }[]>();
    expect(home.find((s) => s.id === status.id)?.card).toEqual(SHAPE);
  });

  it("shows missing_attribution to a signed-in viewer only, true for the card's unverified author", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    const status = await post(h, alice, { status: "card https://e.example/a" });
    await attach(h.store, status.id, { ...stored, unverified_author_account_id: bob.id });
    const boost = await (
      await h.request(`/api/v1/statuses/${status.id}/reblog`, bearer(alice.token, { method: "POST" }))
    ).json<{ id: string }>();
    const app = await appToken(h);
    const cards = async (token: string | null) =>
      Promise.all(
        [status.id, boost.id].map(async (id) => {
          const shown = await (
            await h.request(`/api/v1/statuses/${id}`, token === null ? {} : bearer(token))
          ).json<{ card: unknown; reblog: { card: unknown } | null }>();
          return (shown.reblog?.card ?? shown.card) as Record<string, unknown>;
        }),
      );
    for (const card of await cards(bob.token)) {
      expect(card).toEqual({ ...SHAPE, missing_attribution: true });
      // After published_at and before authors, as REST::PreviewCardSerializer writes its attributes, then authors.
      expect(Object.keys(card).slice(-2)).toEqual(["missing_attribution", "authors"]);
    }
    for (const card of await cards(alice.token)) {
      expect(card).toEqual(SHAPE);
    }
    // An anonymous request and an app token: no key, the card otherwise the same.
    for (const token of [null, app]) {
      for (const card of await cards(token)) {
        const { missing_attribution: _, ...anonymous } = SHAPE;
        expect(card, String(token)).toEqual(anonymous);
      }
    }
    // No unverified author: false for everyone signed in.
    await sql(h.store, "UPDATE status_cards SET unverified_author_account_id = NULL WHERE status_id = ?", status.id);
    for (const card of await cards(bob.token)) {
      expect(card.missing_attribution).toBe(false);
    }
  });

  it("shows no card on a status that is not public or unlisted, even from an imported row", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    for (const visibility of ["private", "direct"]) {
      const status = await post(h, alice, { status: `x https://e.example/${visibility}`, visibility });
      await attach(h.store, status.id, stored);
      const shown = await (
        await h.request(`/api/v1/statuses/${status.id}`, bearer(alice.token))
      ).json<{ card: unknown }>();
      expect(shown.card, visibility).toBeNull();
    }
    const unlisted = await post(h, alice, { status: "x", visibility: "unlisted" });
    await attach(h.store, unlisted.id, stored);
    const shown = await (
      await h.request(`/api/v1/statuses/${unlisted.id}`, bearer(alice.token))
    ).json<{ card: unknown }>();
    expect(shown.card).toEqual(SHAPE);
  });

  it("builds authors from the presented values: a name alone, or a URL alone", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const status = await post(h, alice, { status: "x" });
    const card = async () =>
      (
        await (
          await h.request(`/api/v1/statuses/${status.id}`, bearer(alice.token))
        ).json<{ card: Record<string, unknown> | null }>()
      ).card;
    await attach(h.store, status.id, { ...stored, author_url: "", provider_url: "" });
    expect(await card()).toMatchObject({
      author_url: "",
      provider_url: "",
      authors: [{ name: "Ann", url: "", account: null }],
    });
    await attach(h.store, status.id, { ...stored, author_name: " 　", author_url: "" });
    expect(await card()).toMatchObject({ author_name: " 　", authors: [] });
    await attach(h.store, status.id, { ...stored, author_name: "" });
    expect(await card()).toMatchObject({ authors: [{ name: "", url: SHAPE.author_url, account: null }] });
    // A blank title is no card.
    await attach(h.store, status.id, { ...stored, title: "　" });
    expect(await card()).toBeNull();
  });

  it("judges every presented text and URL as decoded, then as normalized", () => {
    const bytes = (b: number[]) => new TextDecoder().decode(new Uint8Array(b));
    const title = CARD_TEXTS.title;
    expect(presentedCardText("a".repeat(title - 2), title)).toBe("a".repeat(title - 2));
    expect(presentedCardText("a".repeat(title - 1), title)).toBe("");
    const escaped = Math.floor((title - 2) / 6);
    const astral = Math.floor((title - 2) / 4);
    expect(presentedCardText("\u0001".repeat(escaped), title)).toHaveLength(escaped);
    expect(presentedCardText("\u0001".repeat(escaped + 1), title)).toBe("");
    expect(presentedCardText("\u{1f600}".repeat(astral), title)).toHaveLength(2 * astral);
    expect(presentedCardText("\u{1f600}".repeat(astral + 1), title)).toBe("");
    // Malformed UTF-8 within the raw bytes decodes to U+FFFD, three bytes each: past the bound once decoded.
    expect(presentedCardText(bytes(Array.from({ length: title - 2 }, () => 0x80)), title)).toBe("");
    expect(presentedCardText("a\u0000", title)).toBe("");
    expect(presentedCardText("\ud800", title)).toBe("");
    expect(presentedCardText(7, title)).toBe("");
    const url = "https://e.example/".padEnd(CARD_URL_LIMIT, "u");
    expect(presentedCardUrl(url)).toBe(url);
    const optional = "https://e.example/".padEnd(CARD_OPTIONAL_URL_LIMIT, "u");
    expect(presentedCardUrl(optional, CARD_OPTIONAL_URL_LIMIT)).toBe(optional);
    expect(presentedCardUrl(`${optional}u`, CARD_OPTIONAL_URL_LIMIT)).toBeNull();
    expect(presentedCardUrl(`${url}u`)).toBeNull();
    for (const refused of ["\u0000", "\u0085", " ", " ", "�", " ", '"', "<", "\\", "^", "`", "{", "|", "}"]) {
      expect(presentedCardUrl(`https://e.example/${refused}`), JSON.stringify(refused)).toBeNull();
    }
    expect(presentedCardUrl("ftp://e.example/")).toBeNull();
    expect(presentedCardUrl(`https://e.example/${bytes([0xe2, 0x82])}`)).toBeNull();
    // Normalization may shorten a URL (dot segments, the default port) or lengthen it (percent-encoding).
    expect(presentedCardUrl("HTTPS://E.EXAMPLE:443/a/./b")).toBe("https://e.example/a/b");
    expect(
      presentedCardUrl(`https://e.example/${"'".repeat(CARD_URL_LIMIT - "https://e.example/".length)}`),
    ).toHaveLength(CARD_URL_LIMIT);
    // Non-ASCII is not refused as decoded (the triggers refuse it as stored); the normalized form is ASCII.
    expect(presentedCardUrl("https://e.example/?\u00e9")).toBe("https://e.example/?%C3%A9");
  });

  it("reads only text within its raw bounds out of SQLite, whatever the row stores", async () => {
    const AUTHOR_BLOB = new TextEncoder().encode("123456789012345678").buffer as ArrayBuffer;
    const h = await community(["alice"]);
    const rows = await runInDurableObject(h.store, (_instance, state) =>
      [
        [new TextEncoder().encode("https://e.example/").buffer as ArrayBuffer, 7, AUTHOR_BLOB],
        ["x".repeat(CARD_URL_LIMIT + 1), "y".repeat(CARD_TEXTS.title - 1), "12345678\u0000123456789"],
        ["https://e.example/", "t", "123456789012345678"],
      ].map(([url, title, author]) =>
        state.storage.sql
          .exec(
            `SELECT ${selectSql(CARD_COLUMN_MAP)} FROM (SELECT '1' AS value) j,
							(SELECT ?1 AS url, ?2 AS title, ?2 AS description, ?2 AS author_name, ?1 AS author_url,
								?2 AS provider_name, ?1 AS provider_url, ?2 AS language, ?2 AS published_at, ?1 AS card_type,
								?2 AS width, ?3 AS height, ?1 AS embed_src, ?3 AS iframe_width, -1 AS iframe_height,
								?1 AS image_description, ?4 AS unverified_author_account_id) c,
							(SELECT ?2 AS token, ?3 AS width, ?1 AS height, ?1 AS blurhash) i`,
            url!,
            title!,
            CARD_DIMENSION_MAX + 1,
            author!,
          )
          .one(),
      ),
    );
    expect(rows[0]).toMatchObject({ url: null, title: null, author_url: null, language: null, published_at: null });
    // Each new column as read (0069_card_embeds): a blob, a text, a real (workerd binds every number as one) or an
    // integer out of range is NULL.
    const embed = {
      card_type: null,
      width: null,
      height: null,
      embed_src: null,
      iframe_width: null,
      iframe_height: null,
    };
    expect(rows[0]).toMatchObject(embed);
    expect(rows[1]).toMatchObject(embed);
    // 0070_card_images: the alt text and the stored image's columns, each NULL past its stored bound.
    const image = { image_description: null, image_token: null, image_width: null, image_height: null, blurhash: null };
    expect(rows[0]).toMatchObject(image);
    expect(rows[1]).toMatchObject({ image_description: null, image_token: null, image_width: null, blurhash: null });
    expect(rows[1]).toMatchObject({
      url: null,
      title: null,
      description: "y".repeat(CARD_TEXTS.title - 1),
      language: null,
    });
    // 0098_card_attribution: an author past the stored rule (a BLOB of digits, a NUL inside) is NULL; 18 digits are
    // read as stored.
    expect(rows.map((row) => row.unverified_author_account_id)).toEqual([null, null, "123456789012345678"]);
  });

  it("presents a video from its fixed template, a photo without an image, and judges each stored value again", () => {
    const card = { url: "https://e.example/a", title: "T" };
    const src = "https://v.example/e?a=1&b=2";
    expect(
      presentFor({ ...card, card_type: 2, width: 640, height: 360, embed_src: src, iframe_width: 560 }),
    ).toMatchObject({
      type: "video",
      width: 640,
      height: 360,
      embed_url: "",
      image: null,
      html: `<iframe src="https://v.example/e?a=1&amp;b=2" width="560" allowfullscreen="true" scrolling="no" frameborder="0" sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms"></iframe>`,
    });
    expect(presentFor({ ...card, card_type: 1, width: 10, height: 20 })).toMatchObject({
      type: "photo",
      width: 10,
      height: 20,
      html: "",
      image: null,
    });
    // A video whose src the presenter refuses as decoded is a link without html; a type or dimension that is not
    // read (NULL) is a link and 0.
    for (const embed of [
      null,
      "",
      "javascript:alert(1)",
      "/relative",
      'https://v.example/"',
      `${src}\u0000`,
      "https://v.example/\ufffd",
    ]) {
      expect(presentFor({ ...card, card_type: 2, embed_src: embed }), String(embed)).toMatchObject({
        type: "link",
        html: "",
      });
    }
    expect(presentFor({ ...card, card_type: null, width: null, height: null })).toMatchObject({
      type: "link",
      width: 0,
      height: 0,
    });
    // The escaped bound: one & more than fits is refused once escaped.
    const most = Math.floor((CARD_EMBED_SRC_ESCAPED_BYTES - 19) / 5);
    expect(presentFor({ ...card, card_type: 2, embed_src: `https://v.example/?${"&".repeat(most)}` })!.type).toBe(
      "video",
    );
    expect(presentFor({ ...card, card_type: 2, embed_src: `https://v.example/?${"&".repeat(most + 1)}` })!.type).toBe(
      "link",
    );
  });

  it("presents a stored image on the instance origin with its blurhash, and a link card at its size (0070)", () => {
    const card = { url: "https://e.example/a", title: "T" };
    const token = "k".repeat(43);
    const stored = {
      image_token: token,
      image_width: 743,
      image_height: 309,
      blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
    };
    expect(presentFor({ ...card, ...stored, width: 1, height: 2, image_description: "Alt" })).toMatchObject({
      type: "link",
      image: `https://kopje.test/media/${token}/full.webp`,
      blurhash: stored.blurhash,
      image_description: "Alt",
      width: 743,
      height: 309,
    });
    // A photo or a video keeps its own size.
    expect(presentFor({ ...card, ...stored, card_type: 1, width: 10, height: 20 })).toMatchObject({
      type: "photo",
      width: 10,
      height: 20,
      image: `https://kopje.test/media/${token}/full.webp`,
    });
    // No image (pending, gone, or a token or size past its rule): null image and blurhash, the alt text all the same,
    // and the card's own size.
    for (const missing of [
      { image_token: null },
      { image_token: "short" },
      { image_token: `${"k".repeat(42)}/` },
      { image_width: null },
      { image_height: 0 },
    ]) {
      expect(
        presentFor({ ...card, ...stored, ...missing, width: 1, height: 2, image_description: "Alt" }),
        JSON.stringify(missing),
      ).toMatchObject({ image: null, blurhash: null, image_description: "Alt", width: 1, height: 2 });
    }
    // A blurhash the stored rule refuses is null; an origin that makes the URL too long gives no image.
    expect(presentFor({ ...card, ...stored, blurhash: "x" })).toMatchObject({ blurhash: null });
    expect(presentFor({ ...card, ...stored }, `https://${"a".repeat(300)}`)).toMatchObject({
      image: null,
      blurhash: null,
    });
    // The alt text is judged as decoded (presentedCardText).
    for (const refused of ["a\u0000", "\ud800", '"'.repeat(128)]) {
      expect(presentFor({ ...card, image_description: refused })?.image_description).toBe("");
    }
  });

  it("derives CARD_JSON_MAX from the bounds, at or above every fill", () => {
    expect(new URL(LONG_ORIGIN).hostname).toHaveLength(253);
    // A signed-in viewer's card holds missing_attribution, false at its longest.
    const full = presentFor(boundCard("ascii"), LONG_ORIGIN, VIEWER)!;
    expect(full.missing_attribution).toBe(false);
    expect(full.image).toHaveLength(CARD_IMAGE_URL_BYTES);
    expect(full.blurhash).toHaveLength(BLURHASH_BYTES);
    expect(full.type).toBe("video");
    const skeleton = jsonBytes(
      JSON.parse(
        JSON.stringify(full, (key, value: unknown) => (typeof value === "string" && key !== "type" ? "" : value)),
      ),
    );
    // The iframe html at its most: the template's constant bytes, the src at its escaped bound and both dimensions,
    // as a JSON string (each of its quotes escaped).
    const html = jsonBytes(
      cardIframe("s".repeat(CARD_EMBED_SRC_ESCAPED_BYTES), CARD_DIMENSION_MAX, CARD_DIMENSION_MAX),
    );
    const max =
      skeleton +
      CARD_URL_LIMIT +
      3 * CARD_OPTIONAL_URL_LIMIT +
      (CARD_TEXTS.title - 2) +
      (CARD_TEXTS.description - 2) +
      2 * (CARD_TEXTS.author_name - 2) +
      (CARD_TEXTS.provider_name - 2) +
      CARD_LANGUAGE_BYTES +
      24 +
      (html - 2) +
      CARD_IMAGE_URL_BYTES +
      BLURHASH_BYTES +
      (CARD_IMAGE_DESCRIPTION_JSON_BYTES - 2);
    // An embed's growth over a link card's 8,513: the html, "video" for "link" and two dimensions of five digits for 0.
    const growth = html - 2 + 1 + 2 * (String(CARD_DIMENSION_MAX).length - 1);
    // The fields of 0070_card_images: the image for null, the blurhash for null and the alt text for ''.
    const images =
      CARD_IMAGE_URL_BYTES +
      2 -
      jsonBytes(null) +
      (BLURHASH_BYTES + 2 - jsonBytes(null)) +
      CARD_IMAGE_DESCRIPTION_JSON_BYTES -
      2;
    expect({ skeleton, html, growth, images, max, perStatus: max - jsonBytes(null) }).toEqual({
      skeleton: 333,
      html: 733,
      growth: 740,
      images: 646,
      max: CARD_JSON_MAX,
      perStatus: 9_923,
    });
    // A link card's 8,513, an embed's growth, 0070's fields and `,"missing_attribution":false`.
    expect(jsonBytes({ a: 1, missing_attribution: false }) - jsonBytes({ a: 1 })).toBe(28);
    expect(CARD_JSON_MAX).toBe(8_513 + 740 + 646 + 28);
    const measured = (["escaped", "astral", "ascii"] as const).map((fill) =>
      jsonBytes(presentFor(boundCard(fill), LONG_ORIGIN, VIEWER)),
    );
    expect(measured[0]).toBe(CARD_JSON_MAX);
    for (const bytes of measured) {
      expect(bytes).toBeLessThanOrEqual(CARD_JSON_MAX);
    }
    // The template bound equals the sink's URL bound (stored-bounds.ts repeats it).
    expect(OEMBED_TEMPLATE_BYTES).toBe(WEB_PAGE_URL_LIMIT);
  });
});
