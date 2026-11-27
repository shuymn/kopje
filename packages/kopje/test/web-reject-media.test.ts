import { describe, expect, it } from "vitest";

import type { MediaAttachment } from "../src/domain/status-presenter";
import { mediaView, shownImage } from "../src/web/view/media";
import { sql } from "./api-helpers";
import { acceptQuote } from "./budget-helpers";
import { blockDomain } from "./domain-block-helpers";
import { pathOf } from "./media-helpers";
import { community, post, remoteAccount, seedStatus } from "./status-helpers";
import { attr, byId, elements, parseHtml } from "./web-dom";

// #1560, VIS-30, HTML-3: while a domain block's reject_media rules a remote account's stored domain, a page or the embed
// that shows the account or its status makes the browser fetch none of its files and nothing under /media_proxy/: the
// presenters give the pages the default images, no emoji and each attachment marked withheld, which mediaView links by
// its http(s) remote_url (web/view/media.ts).

const REJECTED = "rejected.example";
const CONTROL = "control.example";
const FETCHING = ["src", "srcset", "poster", "data"];

// Every URL the page makes the browser fetch by itself: an element's src, srcset, poster or data, and a preload or icon
// link's href.
function fetched(html: string): string[] {
  return elements(parseHtml(html)).flatMap((element) => [
    ...FETCHING.flatMap((name) => attr(element, name) ?? []),
    ...(element.tagName === "link" && attr(element, "rel") !== "canonical" ? [attr(element, "href") ?? ""] : []),
  ]);
}

const links = (html: string) =>
  elements(parseHtml(html)).flatMap((element) => (element.tagName === "a" ? [attr(element, "href") ?? ""] : []));

// A remote account of `domain` with images and an emoji, and its public status with an image attachment `media`.
async function remoteWithStatus(h: Awaited<ReturnType<typeof community>>, domain: string, media: string) {
  const id = await remoteAccount(h.store, domain.split(".")[0]!, domain);
  const emoji = JSON.stringify([["blob", `https://${domain}/e.png`]]);
  await sql(
    h.store,
    "UPDATE accounts SET display_name = ':blob: Name', avatar_url = ?2, header_url = ?3, emojis = ?4 WHERE id = ?1",
    id,
    `https://${domain}/a.png`,
    `https://${domain}/h.png`,
    emoji,
  );
  const status = await seedStatus(h.store, { accountId: id, visibility: "public", content: "<p>:blob: hi</p>" });
  await sql(h.store, "UPDATE statuses SET emojis = ? WHERE id = ?", emoji, status);
  const file = `https://${domain}/m/1.png`;
  await sql(
    h.store,
    "INSERT INTO media_attachments (id, account_id, status_id, type, url, preview_url) VALUES (?, ?, ?, 'image', ?, ?)",
    media,
    id,
    status,
    file,
    `${file}s`,
  );
  return { status, file };
}

async function world() {
  const h = await community(["alice"]);
  const { alice } = h.users;
  const { status: original, file } = await remoteWithStatus(h, REJECTED, "500000000000000001");
  // The profile also boosts a control account's status on an unruled domain, shown with its media in the same page.
  const control = await remoteWithStatus(h, CONTROL, "500000000000000004");
  await seedStatus(h.store, { accountId: alice.id, visibility: "public", reblogOfId: control.status });
  await seedStatus(h.store, { accountId: alice.id, visibility: "public", reblogOfId: original });
  const quote = await post(h, alice, { status: "look" });
  await acceptQuote(h, quote.id, original);
  const pages = [`/@alice`, pathOf(String(quote.url)), `${pathOf(String(quote.url))}/embed`];
  const render = async () =>
    Promise.all(
      pages.map(async (path) => {
        const response = await h.request(path);
        expect(response.status, path).toBe(200);
        return [path, await response.text()] as const;
      }),
    );
  return { h, file, control: control.file, render };
}

describe("reject_media on the pages (#1560)", () => {
  it("renders no media of a rejected domain, and links the attachment's remote_url", async () => {
    const { h, file, control, render } = await world();
    // The pages render the account, its boosted status and the quote: each fetches its files before the block.
    for (const [path, html] of await render()) {
      expect(fetched(html).filter((url) => url.includes(REJECTED)).length, path).toBeGreaterThan(0);
    }
    await blockDomain(h.store, REJECTED, "noop", { rejectMedia: true });
    for (const [path, html] of await render()) {
      expect(
        fetched(html).filter((url) => url.includes(REJECTED) || url.includes("/media_proxy/")),
        path,
      ).toEqual([]);
      expect(links(html), path).toContain(file);
      expect(html, path).not.toContain("/media_proxy/");
    }
    const profile = (await render()).find(([path]) => path === "/@alice")![1];
    // Its image shown by its icon, its avatar and its emoji.
    expect(fetched(profile)).toEqual(
      expect.arrayContaining([`${control}s`, `https://${CONTROL}/a.png`, `https://${CONTROL}/e.png`]),
    );
  });
});

// A local post's history whose version names an imported attachment of the rejected account (its current row on the
// post), beside one of a converted version that names a proxy-shaped instance URL and is withheld by nothing.
describe("reject_media in a page's edit history (#1560)", () => {
  it("links a withheld entry by its remote_url and leaves an unwithheld proxy-shaped link as it was", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const erin = await remoteAccount(h.store, "erin", REJECTED);
    const status = await post(h, alice, { status: "now" });
    await sql(h.store, "UPDATE statuses SET edited_at = ? WHERE id = ?", new Date().toISOString(), status.id);
    const file = `https://${REJECTED}/m/2.png`;
    const imported = "500000000000000002";
    await sql(
      h.store,
      "INSERT INTO media_attachments (id, account_id, status_id, type, url) VALUES (?, ?, ?, 'image', ?)",
      imported,
      erin,
      status.id,
      file,
    );
    const proxyShaped = "https://kopje.test/media_proxy/3/original";
    await sql(
      h.store,
      `INSERT INTO status_edits (status_id, content, spoiler_text, sensitive, media_json, created_at, emojis)
			VALUES (?1, '<p>old</p>', '', 0, ?2, '2026-01-01T00:00:00.000Z', NULL),
				(?1, '<p>now</p>', '', 0, '[]', '2026-01-02T00:00:00.000Z', NULL)`,
      status.id,
      JSON.stringify([
        { id: imported, type: "image", url: file, preview_url: file, remote_url: file },
        { id: "3", type: "unknown", url: proxyShaped, preview_url: null, remote_url: null },
      ]),
    );
    const render = async () => {
      const response = await h.request(pathOf(String(status.url)));
      expect(response.status).toBe(200);
      return response.text();
    };
    expect(fetched(await render())).toContain(file);
    await blockDomain(h.store, REJECTED, "noop", { rejectMedia: true });
    const html = await render();
    expect(fetched(html).filter((url) => url.includes(REJECTED) || url.includes("/media_proxy/"))).toEqual([]);
    // In the history's dialog (the post shows the current attachment too); the instance's own URL is linked by its path
    // (web/view/link.ts linkTo).
    const dialog = byId(parseHtml(html), "history")!;
    const inHistory = elements(dialog).flatMap((element) => (element.tagName === "a" ? [attr(element, "href")] : []));
    expect(inHistory).toEqual(expect.arrayContaining([file, new URL(proxyShaped).pathname]));
  });
});

describe("mediaView of a withheld attachment (#1560)", () => {
  const withheld = (fields: Partial<MediaAttachment>): MediaAttachment => ({
    id: "1",
    type: "unknown",
    url: "https://kopje.test/media_proxy/1/original",
    preview_url: "https://kopje.test/media_proxy/1/small",
    remote_url: "https://files.example/v.mp4",
    preview_remote_url: "https://files.example/v.png",
    text_url: null,
    meta: { original: { width: 640, height: 480 } },
    description: "A cat",
    blurhash: null,
    withheld: true,
    ...fields,
  });

  it("links the remote file, shows no image, and leaves one without an http(s) remote_url out", () => {
    const view = mediaView(withheld({}), "kopje.test");
    expect(view).toMatchObject({ kind: "unknown", full: "https://files.example/v.mp4", preview: null, alt: "A cat" });
    expect(shownImage(view!)).toBeNull();
    expect(mediaView(withheld({ remote_url: null }), "kopje.test")).toBeNull();
    expect(mediaView(withheld({ remote_url: "javascript:alert(1)" }), "kopje.test")).toBeNull();
  });

  // A converted history entry presented withheld names its stored file as its remote_url (statuses.ts snapshotMedia).
  it("links a withheld converted file", () => {
    const view = mediaView(withheld({ url: null, preview_url: null, remote_url: "https://old.example/m.png" }), "a");
    expect(view?.full).toBe("https://old.example/m.png");
  });

  // Without the page's flag, an attachment whose url is shaped as a proxy URL is linked as before.
  it("leaves an unwithheld proxy-shaped link as it was", () => {
    const { withheld: _flag, ...plain } = withheld({});
    expect(mediaView(plain, "kopje.test")).toMatchObject({
      kind: "unknown",
      full: "https://kopje.test/media_proxy/1/original",
      preview: "https://kopje.test/media_proxy/1/small",
    });
  });
});
