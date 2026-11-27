import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import { DOOMED_AT, profileReleaseSql } from "../src/domain/media";
import { API_BODY_LIMIT, FILE_PART_SLACK } from "../src/mastodon/params";
import * as dataUri from "../src/platform/data-uri";
import { PROFILE_IMAGE_LIMIT } from "../src/platform/images";
import { restoreMarkerKey } from "../src/platform/media-files";
import type { StoreStub } from "../src/platform/store-client";
import { bearer, json, sql } from "./api-helpers";
import { ANIMATED_GIF, AVIF as AVIF_FIXTURE, GIF, PNG_PLAIN } from "./fixtures/images";
import { bytes, mediaForm, multipartForm, pathOf, r2Keys, TestCodec } from "./media-helpers";
import { singletonStatistics } from "./plan-audit-store";
import { aliceWithFollower } from "./profile-fixtures";
import { scopedToken } from "./read-helpers";
import { storeWith } from "./setup-helpers";
import { outbound } from "./status-helpers";
import { csrfOf, ORIGIN, signIn } from "./web-helpers";

// PATCH /api/v1/accounts/update_credentials with avatar and header files (multipart): the body and file bounds, the
// token checked before the body is read, Paperclip's validations, one transaction with one Update(Person), and the
// ownership of the uploads until it commits (mastodon/accounts.ts, mastodon/media.ts storeProfileImage).

const AVIF = new Uint8Array([0, 0, 0, 0x1c, ...new TextEncoder().encode("ftypavif"), 0, 0, 0, 0]);

async function setup(wrapStore?: (store: StoreStub) => StoreStub) {
  const codec = new TestCodec();
  const h = await aliceWithFollower({ images: () => codec, wrapStore });
  return { ...h, codec };
}

type H = Awaited<ReturnType<typeof setup>>;

const png = (name = "a.png") => new File([bytes(PNG_PLAIN)], name, { type: "image/png" });

const formOf = multipartForm;

function patch(h: H, token: string, body: BodyInit, headers: Record<string, string> = {}, query = "") {
  return h.request(`/api/v1/accounts/update_credentials${query}`, {
    method: "PATCH",
    body,
    headers: { authorization: `Bearer ${token}`, ...headers },
  });
}

async function answer(response: Response) {
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}

async function profile(store: StoreStub) {
  const [row] = await sql<{ avatar_url: string | null; header_url: string | null; display_name: string }>(
    store,
    "SELECT avatar_url, header_url, display_name FROM accounts WHERE username = 'alice'",
  );
  return row;
}

async function media(store: StoreStub) {
  return sql<{ id: string; url: string; gc_at: string | null; processed: number; file_token: string }>(
    store,
    "SELECT id, url, gc_at, processed, file_token FROM media_attachments ORDER BY id",
  );
}

// The R2 keys a request left behind (the bucket is shared by the file's tests).
async function keysAfter(request: () => Promise<Response>): Promise<{ response: Response; added: string[] }> {
  const before = new Set(await r2Keys());
  const response = await request();
  return { response, added: (await r2Keys()).filter((key) => !before.has(key)) };
}

async function updates(store: StoreStub) {
  return (await outbound(store)).filter((o) => o.activity.type === "Update");
}

// A raw multipart body of exactly `size` bytes whose only part is an undeclared file (ignored), so its size is all the
// body bound sees.
function paddedMultipart(size: number): { body: Uint8Array; type: string } {
  const boundary = "b";
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="thumbnail"; filename="t.bin"\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  const body = new Uint8Array(size);
  const encoder = new TextEncoder();
  body.set(encoder.encode(head));
  body.set(encoder.encode(tail), size - tail.length);
  return { body, type: `multipart/form-data; boundary=${boundary}` };
}

// A stream that fails the test if the handler pulls it.
function untouchable(): ReadableStream<Uint8Array> {
  // highWaterMark 0: pull runs only when a reader asks for bytes, not when the stream is made.
  return new ReadableStream(
    {
      pull() {
        throw new Error("the body was read");
      },
    },
    { highWaterMark: 0 },
  );
}

describe("update_credentials: bounds", () => {
  it("takes a multipart body up to the text limit plus two files and refuses one byte more", async () => {
    const h = await setup();
    const limit = API_BODY_LIMIT + 2 * (PROFILE_IMAGE_LIMIT + FILE_PART_SLACK);
    expect(limit).toBe(17_858_560);
    const fits = paddedMultipart(limit);
    expect((await patch(h, h.users.alice.token, fits.body, { "content-type": fits.type })).status).toBe(200);
    const over = paddedMultipart(limit + 1);
    expect(await answer(await patch(h, h.users.alice.token, over.body, { "content-type": over.type }))).toEqual({
      status: 413,
      body: { error: "Request body is too large" },
    });
  }, 60_000);

  it("keeps 1 MiB for JSON, and for the text of a multipart body", async () => {
    const h = await setup();
    const note = "x".repeat(API_BODY_LIMIT);
    const json = JSON.stringify({ note });
    expect((await patch(h, h.users.alice.token, json, { "content-type": "application/json" })).status).toBe(413);
    // The name's 4 bytes and the value's count: within the bound, the note's own validation answers.
    const text = await patch(h, h.users.alice.token, formOf([["note", note.slice(0, API_BODY_LIMIT - 4)]]));
    expect(text.status).toBe(422);
    const over = await patch(
      h,
      h.users.alice.token,
      formOf([["note", `${note.slice(0, API_BODY_LIMIT - 4)}\u{1F600}`]]),
    );
    expect(over.status).toBe(413);
    // A 2 MiB text avatar replaced by an empty one still counts.
    const replaced = await patch(
      h,
      h.users.alice.token,
      formOf([
        ["avatar", "x".repeat(2 * API_BODY_LIMIT)],
        ["avatar", ""],
      ]),
    );
    expect(replaced.status).toBe(413);
  }, 60_000);
});

describe("update_credentials: the token before the body", () => {
  it("answers an invalid or under-scoped token without reading a multipart body", async () => {
    const h = await setup();
    const send = (token: string) =>
      h.request("/api/v1/accounts/update_credentials", {
        method: "PATCH",
        body: untouchable(),
        headers: { authorization: `Bearer ${token}`, "content-type": "multipart/form-data; boundary=b" },
        duplex: "half",
      } as RequestInit);
    expect((await send("not-a-token")).status).toBe(401);
    expect((await send(await scopedToken(h, "read:accounts"))).status).toBe(403);
  });

  it("uploads both images with a token of write:accounts only", async () => {
    const h = await setup();
    const token = await scopedToken(h, "write:accounts");
    const response = await patch(
      h,
      token,
      formOf([
        ["avatar", png()],
        ["header", png("h.png")],
      ]),
    );
    expect(response.status).toBe(200);
    const account = await response.json<{ avatar: string; header: string; avatar_static: string }>();
    const row = await profile(h.store);
    expect([account.avatar, account.header, account.avatar_static]).toEqual([
      row?.avatar_url,
      row?.header_url,
      row?.avatar_url,
    ]);
    expect(row?.avatar_url).toMatch(/^https:\/\/kopje\.test\/media\/[A-Za-z0-9_-]+\/full\.png$/);
    expect((await media(h.store)).map((m) => m.gc_at)).toEqual([null, null]);
  });
});

describe("update_credentials: avatar and header", () => {
  it("applies images and text in one transaction with one Update(Person)", async () => {
    const h = await setup();
    const before = (await updates(h.store)).length;
    const response = await patch(
      h,
      h.users.alice.token,
      formOf([
        ["display_name", "Alice"],
        ["avatar", png()],
        ["header", png("h.png")],
      ]),
    );
    expect(response.status).toBe(200);
    const sent = await updates(h.store);
    expect(sent.length - before).toBe(1);
    const row = await profile(h.store);
    expect(sent.at(-1)?.activity.object).toMatchObject({
      name: "Alice",
      icon: { type: "Image", url: row?.avatar_url },
      image: { type: "Image", url: row?.header_url },
    });
    // Three outputs each (the full image, the preview and its RGBA), each image with its blurhash.
    expect(h.codec.encodeCalls.map((call) => call.format)).toEqual([
      "image/png",
      "image/png",
      "rgba",
      "image/png",
      "image/png",
      "rgba",
    ]);
    expect(
      await sql<{ blurhash: string | null }>(
        h.store,
        "SELECT m.blurhash FROM media_attachments m JOIN accounts a ON m.url IN (a.avatar_url, a.header_url) ORDER BY m.id",
      ),
    ).toEqual([{ blurhash: expect.stringMatching(/^U.{35}$/) }, { blurhash: expect.stringMatching(/^U.{35}$/) }]);
  });

  it("takes 8,388,607 bytes and refuses 8,388,608, AVIF and a string, applying nothing", async () => {
    const h = await setup();
    const padded = (size: number) => {
      const file = new Uint8Array(size);
      file.set(bytes(PNG_PLAIN));
      return new File([file], "big.png", { type: "image/png" });
    };
    // The bytes past IEND are not read by the decoder.
    expect((await patch(h, h.users.alice.token, formOf([["avatar", padded(PROFILE_IMAGE_LIMIT - 1)]]))).status).toBe(
      200,
    );
    const avatar = (await profile(h.store))?.avatar_url;
    expect(
      await answer(await patch(h, h.users.alice.token, formOf([["avatar", padded(PROFILE_IMAGE_LIMIT)]]))),
    ).toEqual({
      status: 422,
      body: {
        error: "Validation failed: Avatar must be less than 8 MB, Avatar file size must be less than 8 MB",
        details: {
          avatar: [{ error: "ERR_LESS_THAN", description: "must be less than 8 MB" }],
          avatar_file_size: [{ error: "ERR_LESS_THAN", description: "must be less than 8 MB" }],
        },
      },
    });
    const avif = new File([AVIF], "a.avif", { type: "image/avif" });
    expect(
      await answer(
        await patch(
          h,
          h.users.alice.token,
          formOf([
            ["display_name", "Changed"],
            ["header", avif],
          ]),
        ),
      ),
    ).toEqual({
      status: 422,
      body: {
        error: "Validation failed: Header content type is invalid, Header is invalid",
        details: {
          header_content_type: [{ error: "ERR_INVALID", description: "is invalid" }],
          header: [{ error: "ERR_IS INVALID", description: "is invalid" }],
        },
      },
    });
    // Text that is not a data URI by Paperclip's case-sensitive pattern, which takes no parameter before `;base64,`.
    for (const parts of [
      [["avatar", "x"]],
      [
        ["avatar", png()],
        ["avatar", "x"],
      ],
      [["avatar", `DATA:image/png;base64,${PNG_PLAIN}`]],
      [["avatar", `data:image/png;BASE64,${PNG_PLAIN}`]],
      [["header", `data:image/png;charset=utf-8;base64,${PNG_PLAIN}`]],
    ] as [string, string | File][][]) {
      expect(await answer(await patch(h, h.users.alice.token, formOf(parts)))).toEqual({
        status: 400,
        body: { error: "Bad Request" },
      });
    }
    // A query value with no body part is the effective value too; JSON's as well.
    expect((await patch(h, h.users.alice.token, formOf([["note", "n"]]), {}, "?header=x")).status).toBe(400);
    expect(
      (
        await h.request(
          "/api/v1/accounts/update_credentials",
          bearer(h.users.alice.token, { ...json({ avatar: "x" }), method: "PATCH" }),
        )
      ).status,
    ).toBe(400);
    // A string then a file is the file; an empty value is absent.
    const last = await patch(
      h,
      h.users.alice.token,
      formOf([
        ["header", "x"],
        ["header", png()],
        ["avatar", ""],
      ]),
    );
    expect(last.status).toBe(200);
    const row = await profile(h.store);
    expect([row?.display_name, row?.avatar_url]).toEqual(["", avatar]);
    expect(row?.header_url).not.toBeNull();
  }, 60_000);

  // Miniflare's local binding decodes one frame of a GIF, so its served file is still and the static is the image;
  // an animated served file's still static: test/account-static.test.ts, and on a real account: docs/setup.md.
  it("keeps the image as the static of a GIF the local binding serves still", async () => {
    const h = await setup();
    const gif = new File([bytes(ANIMATED_GIF)], "a.gif", { type: "image/gif" });
    const account = await (
      await patch(h, h.users.alice.token, formOf([["avatar", gif]]))
    ).json<{
      avatar: string;
      avatar_static: string;
    }>();
    expect(account.avatar_static).toBe(account.avatar);
    expect(await sql(h.store, "SELECT avatar_static_url FROM accounts WHERE username = 'alice'")).toEqual([
      { avatar_static_url: null },
    ]);
  });
});

// `avatar` and `header` as base64 data URIs (mastodon/accounts.ts profileFiles, platform/data-uri.ts): read in every
// body type and the query, decoded as Paperclip decodes them, judged by their bytes' signature before anything is
// reserved, and bounded by the request's text (RES-1). The decoder's own cases: test/data-uri.test.ts.
describe("update_credentials: data URIs", () => {
  const uri = (payload: string, type = "image/png") => `data:${type};base64,${payload}`;
  // As Ruby's Base64.encode64 writes it, which Mastodon's own specs send: lines of 60 characters, each ending in LF.
  const encode64 = (payload: string) => `${payload.match(/.{1,60}/g)!.join("\n")}\n`;
  const sendJson = (h: H, body: Record<string, unknown>, query = "") =>
    h.request(
      `/api/v1/accounts/update_credentials${query}`,
      bearer(h.users.alice.token, { ...json(body), method: "PATCH" }),
    );
  const sendForm = (h: H, body: string) =>
    h.request(
      "/api/v1/accounts/update_credentials",
      bearer(h.users.alice.token, {
        method: "PATCH",
        body,
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
    );
  // The served type of a set image: PNG for a PNG, WebP for the GIF fixture.
  const served = async (h: H, url: string | null | undefined) =>
    (await h.request(pathOf(url ?? null))).headers.get("content-type");
  const charges = (store: StoreStub) =>
    sql(store, "SELECT name, value FROM kopje_state WHERE name LIKE 'images_%transforms:%' ORDER BY name");
  // A harness that counts the Store's reservations: one consumes an upload attempt even when it is discarded later.
  const counting = async () => {
    let reservations = 0;
    const h = await setup((store) =>
      storeWith(store, {
        reserveMedia: (...args: unknown[]) => {
          reservations++;
          return (store.reserveMedia as (...a: unknown[]) => Promise<unknown>)(...args);
        },
      }),
    );
    return { h, reservations: () => reservations };
  };

  it("sets an avatar and a header from data URIs in JSON, urlencoded, multipart and the query", async () => {
    const h = await setup();
    // JSON: Base64.encode64's lines, and a URI that declares no type.
    const fromJson = await sendJson(h, { avatar: uri(encode64(PNG_PLAIN)), header: `data:;base64,${GIF}` });
    expect(fromJson.status).toBe(200);
    const first = await profile(h.store);
    expect([await served(h, first?.avatar_url), await served(h, first?.header_url)]).toEqual([
      "image/png",
      "image/webp",
    ]);
    // urlencoded, with spaces inside the payload.
    const spaced = `${PNG_PLAIN.slice(0, 20)} ${PNG_PLAIN.slice(20, 40)}  ${PNG_PLAIN.slice(40)}`;
    expect((await sendForm(h, `avatar=${encodeURIComponent(uri(spaced))}`)).status).toBe(200);
    const second = await profile(h.store);
    expect(second?.avatar_url).not.toBe(first?.avatar_url);
    expect(await served(h, second?.avatar_url)).toBe("image/png");
    // A multipart text part.
    expect((await patch(h, h.users.alice.token, formOf([["header", uri(PNG_PLAIN)]]))).status).toBe(200);
    const third = await profile(h.store);
    expect(third?.header_url).not.toBe(first?.header_url);
    expect(await served(h, third?.header_url)).toBe("image/png");
    // The query, when the body has no value of the name.
    const query = `?avatar=${encodeURIComponent(uri(GIF, "image/gif"))}`;
    expect((await patch(h, h.users.alice.token, formOf([["note", "n"]]), {}, query)).status).toBe(200);
    const fourth = await profile(h.store);
    expect(fourth?.avatar_url).not.toBe(second?.avatar_url);
    expect(await served(h, fourth?.avatar_url)).toBe("image/webp");
    // The body's value when both carry one: its PNG, not the query's GIF.
    expect((await sendJson(h, { avatar: uri(PNG_PLAIN) }, query)).status).toBe(200);
    const fifth = await profile(h.store);
    expect(fifth?.avatar_url).not.toBe(fourth?.avatar_url);
    expect(await served(h, fifth?.avatar_url)).toBe("image/png");
  }, 60_000);

  it("takes a PNG data URI with `!` inside and without padding, and one declared as image/gif", async () => {
    const h = await setup();
    const unpadded = PNG_PLAIN.replace(/=+$/, "");
    expect(unpadded).not.toBe(PNG_PLAIN);
    const marked = `${unpadded.slice(0, 30)}!${unpadded.slice(30)}`;
    expect((await sendJson(h, { avatar: uri(marked), header: uri(PNG_PLAIN, "image/gif") })).status).toBe(200);
    const row = await profile(h.store);
    expect([await served(h, row?.avatar_url), await served(h, row?.header_url)]).toEqual(["image/png", "image/png"]);
  });

  it("refuses a data URI whose bytes are not an image, whatever it declares, charging nothing", async () => {
    const { h, reservations } = await counting();
    const before = await charges(h.store);
    const refusal = (kind: string) => ({
      status: 422,
      body: {
        error: `Validation failed: ${kind} content type is invalid, ${kind} is invalid`,
        details: {
          [`${kind.toLowerCase()}_content_type`]: [{ error: "ERR_INVALID", description: "is invalid" }],
          [kind.toLowerCase()]: [{ error: "ERR_IS INVALID", description: "is invalid" }],
        },
      },
    });
    const sent = [
      await answer(await sendJson(h, { avatar: uri(AVIF_FIXTURE) })),
      await answer(await sendJson(h, { avatar: uri("@@@@") })),
      await answer(await sendJson(h, { header: uri("") })),
      await answer(await patch(h, h.users.alice.token, formOf([["header", uri(AVIF_FIXTURE, "image/avif")]]))),
    ];
    expect(sent).toEqual([refusal("Avatar"), refusal("Avatar"), refusal("Header"), refusal("Header")]);
    expect(reservations()).toBe(0);
    expect(h.codec.calls).toBe(0);
    expect(await media(h.store)).toEqual([]);
    expect(await charges(h.store)).toEqual(before);
    expect(await profile(h.store)).toEqual({ avatar_url: null, header_url: null, display_name: "" });
  });

  it("decides by the last part when a data URI and a file are sent for the same name", async () => {
    const h = await setup();
    const gif = uri(GIF, "image/gif");
    expect(
      (
        await patch(
          h,
          h.users.alice.token,
          formOf([
            ["avatar", gif],
            ["avatar", png()],
          ]),
        )
      ).status,
    ).toBe(200);
    const fileLast = await profile(h.store);
    expect(await served(h, fileLast?.avatar_url)).toBe("image/png");
    expect(
      (
        await patch(
          h,
          h.users.alice.token,
          formOf([
            ["avatar", png()],
            ["avatar", gif],
          ]),
        )
      ).status,
    ).toBe(200);
    const textLast = await profile(h.store);
    expect(textLast?.avatar_url).not.toBe(fileLast?.avatar_url);
    expect(await served(h, textLast?.avatar_url)).toBe("image/webp");
  });

  // Of an otherwise parseable form: a form whose parameter shapes conflict answers 400 Malformed request body first.
  it("answers 413 for a data URI past the text bound, decoding nothing", async () => {
    const { h, reservations } = await counting();
    const decoded = vi.spyOn(dataUri, "decodeRubyBase64");
    try {
      // A PNG's data URI of `bytes` UTF-8 bytes, padded with spaces the decoder skips.
      const padded = (bytes: number) => {
        const value = uri(PNG_PLAIN);
        return `${value}${" ".repeat(bytes - value.length)}`;
      };
      // `{"avatar":""}` is 13 bytes, and the name `avatar` 6.
      const half = Math.floor(API_BODY_LIMIT / 2);
      const over = [
        await answer(await sendJson(h, { avatar: padded(API_BODY_LIMIT - 13 + 1) })),
        await answer(await patch(h, h.users.alice.token, formOf([["avatar", padded(API_BODY_LIMIT - 6 + 1)]]))),
        // Two parts, each within the bound and together past it: the replaced one counts.
        await answer(
          await patch(
            h,
            h.users.alice.token,
            formOf([
              ["avatar", padded(half)],
              ["avatar", padded(half)],
            ]),
          ),
        ),
      ];
      expect(over).toEqual(
        Array.from({ length: 3 }, () => ({ status: 413, body: { error: "Request body is too large" } })),
      );
      expect(decoded).not.toHaveBeenCalled();
      expect(reservations()).toBe(0);
      expect(h.codec.calls).toBe(0);
      expect(await media(h.store)).toEqual([]);
      expect(await profile(h.store)).toEqual({ avatar_url: null, header_url: null, display_name: "" });
      // At the bound, one part is decoded once and set.
      expect((await sendJson(h, { avatar: padded(API_BODY_LIMIT - 13) })).status).toBe(200);
      expect(decoded).toHaveBeenCalledTimes(1);
      expect(reservations()).toBe(1);
      expect((await profile(h.store))?.avatar_url).toMatch(/\/full\.png$/);
    } finally {
      decoded.mockRestore();
    }
  }, 60_000);
});

describe("update_credentials: upload ownership", () => {
  it("discards the avatar when the header fails after it, and applies nothing", async () => {
    const h = await setup();
    let encodes = 0;
    const encode = h.codec.encode.bind(h.codec);
    h.codec.encode = (input, options) => (++encodes > 2 ? Promise.reject(new Error("down")) : encode(input, options));
    const { response, added } = await keysAfter(() =>
      patch(
        h,
        h.users.alice.token,
        formOf([
          ["display_name", "Never"],
          ["avatar", png()],
          ["header", png("h.png")],
        ]),
      ),
    );
    expect(response.status).toBe(500);
    expect(await profile(h.store)).toEqual({ avatar_url: null, header_url: null, display_name: "" });
    // Both uploads were discarded and swept with their objects, the completed avatar's included.
    expect(await media(h.store)).toEqual([]);
    expect(added).toEqual([]);
  });

  it("discards the uploads when the Store answers upload_gone", async () => {
    const h = await setup((store) =>
      storeWith(store, {
        updateCredentials: async (...args: unknown[]) => {
          await sql(store, "UPDATE media_attachments SET gc_at = ?", DOOMED_AT);
          return (store.updateCredentials as (...a: unknown[]) => Promise<unknown>)(...args);
        },
      }),
    );
    const { response, added } = await keysAfter(() => patch(h, h.users.alice.token, formOf([["avatar", png()]])));
    // As Rails answers a base error (M1: an unsaved Account's errors.add(:base, :invalid, message: ...)).
    expect(await response.clone().text()).toBe(
      '{"error":"Validation failed: The upload expired","details":{"base":[{"error":"ERR_INVALID","description":"The upload expired"}]}}',
    );
    expect(response.status).toBe(422);
    expect(await profile(h.store)).toEqual({ avatar_url: null, header_url: null, display_name: "" });
    expect(await media(h.store)).toEqual([]);
    expect(added).toEqual([]);
  });

  it("discards an upload whose completion committed but whose answers were lost", async () => {
    let completions = 0;
    const h = await setup((store) =>
      storeWith(store, {
        completeMedia: async (...args: unknown[]) => {
          await (store.completeMedia as (...a: unknown[]) => Promise<unknown>)(...args);
          completions++;
          throw new Error("lost answer");
        },
      }),
    );
    const { response, added } = await keysAfter(() => patch(h, h.users.alice.token, formOf([["avatar", png()]])));
    expect(response.status).toBe(500);
    // The completion and its retry both committed (completion is idempotent); the upload was then doomed and swept.
    expect(completions).toBe(2);
    expect(await profile(h.store)).toEqual({ avatar_url: null, header_url: null, display_name: "" });
    expect(await media(h.store)).toEqual([]);
    expect(added).toEqual([]);
  });
});

describe("profile image release", () => {
  it("dooms an imported avatar whose URL is malformed UTF-8, reading the account index at 10,000 uploads", async () => {
    const h = await setup();
    const alice = h.users.alice.id;
    const raw = "CAST(X'68747470733a2f2f6b6f706a652e746573742f6d656469612f78ff2f66756c6c2e706e67' AS TEXT)";
    await runInDurableObject(h.store, (_instance, state) => {
      // The account's other uploads: kept, unattached rows of their own URLs, as many as the plan must not scan.
      state.storage.sql.exec(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000)
				INSERT INTO media_attachments (id, account_id, type, url)
				SELECT CAST(910000000000000000 + i AS TEXT), ?1, 'image', 'https://kopje.test/media/k' || i || '/full.png' FROM n`,
        alice,
      );
      state.storage.sql.exec(
        `INSERT INTO media_attachments (id, account_id, type, url) VALUES ('900000000000000001', ?1, 'image', ${raw})`,
        alice,
      );
      state.storage.sql.exec(`UPDATE accounts SET avatar_url = ${raw} WHERE id = ?`, alice);
    });
    // Planned under the plan audit's singleton statistics (a Store analyzed while small), where only the pin keeps the
    // account index (RES-7).
    const plan = await runInDurableObject(h.store, (_instance, state) => {
      singletonStatistics(state.storage.sql);
      return state.storage.sql
        .exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${profileReleaseSql("avatar")}`, alice, "x")
        .toArray()
        .map((row) => row.detail)
        .join("\n");
    });
    expect(plan).toMatch(/SEARCH media_attachments USING INDEX media_attachments_account \(account_id=\?\)/);
    expect(plan).not.toMatch(/SCAN/);
    expect((await patch(h, h.users.alice.token, formOf([["avatar", png()]]))).status).toBe(200);
    expect(await sql(h.store, "SELECT count(*) AS n FROM media_attachments WHERE id = '900000000000000001'")).toEqual([
      { n: 0 },
    ]);
    expect(
      await sql(h.store, "SELECT count(*) AS n FROM media_attachments WHERE id LIKE '91%' AND gc_at IS NULL"),
    ).toEqual([{ n: 10_000 }]);
  }, 60_000);

  it("keeps an upload both images name until the last of them is replaced", async () => {
    const h = await setup();
    expect((await patch(h, h.users.alice.token, formOf([["avatar", png()]]))).status).toBe(200);
    await sql(h.store, "UPDATE accounts SET header_url = avatar_url WHERE username = 'alice'");
    const [shared] = await media(h.store);
    const keys = [`files/${shared!.file_token}/full`, `files/${shared!.file_token}/small`, `originals/${shared!.id}`];
    const present = async () => (await r2Keys()).filter((key) => keys.includes(key)).toSorted();
    expect(await present()).toEqual([...keys].toSorted());
    // Replacing the header leaves the avatar naming it: the row and its objects stay, after the sweep too.
    expect((await patch(h, h.users.alice.token, formOf([["header", png("h.png")]]))).status).toBe(200);
    expect((await media(h.store)).find((row) => row.id === shared!.id)?.gc_at).toBeNull();
    expect(await present()).toEqual([...keys].toSorted());
    // Replacing the avatar, its last reference, releases it.
    expect((await patch(h, h.users.alice.token, formOf([["avatar", png("a2.png")]]))).status).toBe(200);
    expect((await media(h.store)).find((row) => row.id === shared!.id)).toBeUndefined();
    expect(await present()).toEqual([]);
  });
});

// What the upload pipeline refuses after Paperclip's checks pass, as an unsaved Account's errors: an image the service
// does not read as its signature's type as the content type's problems, one past IMAGE_MATRIX_LIMIT pixels as the
// image's invalid with Kopje's message (docs/mastodon-deviations.md, Profile credentials).
describe("update_credentials: the pipeline's refusals", () => {
  it("answers them as the image's problems", async () => {
    const h = await setup();
    h.codec.infoResult = { format: "image/svg+xml" };
    expect(await (await patch(h, h.users.alice.token, formOf([["avatar", png()]]))).text()).toBe(
      '{"error":"Validation failed: Avatar content type is invalid, Avatar is invalid","details":{"avatar_content_type":[{"error":"ERR_INVALID","description":"is invalid"}],"avatar":[{"error":"ERR_IS INVALID","description":"is invalid"}]}}',
    );
    const big = await setup();
    big.codec.infoResult = { format: "image/png", width: 5000, height: 4000 };
    const response = await patch(big, big.users.alice.token, formOf([["header", png()]]));
    expect(response.status).toBe(422);
    expect(await response.text()).toBe(
      '{"error":"Validation failed: Header dimensions exceed 16777216 pixels","details":{"header":[{"error":"ERR_INVALID","description":"dimensions exceed 16777216 pixels"}]}}',
    );
    expect(await profile(big.store)).toEqual({ avatar_url: null, header_url: null, display_name: "" });
  });
});

describe("the settings page", () => {
  // The page shows RecordInvalid's message of the API's problems: Paperclip's, and the pipeline's.
  it("shows an image's problems as the API words them", async () => {
    const h = await setup();
    const browser = await signIn(h);
    const upload = async (kind: string, file: Uint8Array, type: string) => {
      const response = await h.request(`/settings/${kind}`, {
        method: "POST",
        headers: { cookie: browser.cookie, origin: ORIGIN },
        body: mediaForm(file, { csrf: await csrfOf(h, browser) }, "f", type),
      });
      expect(response.status).toBe(422);
      return response.text();
    };
    expect(await upload("avatar", new TextEncoder().encode("not an image"), "text/plain")).toContain(
      "Validation failed: Avatar content type is invalid, Avatar is invalid",
    );
    h.codec.infoResult = { format: "image/png", width: 5000, height: 4000 };
    expect(await upload("header", bytes(PNG_PLAIN), "image/png")).toContain(
      "Validation failed: Header dimensions exceed 16777216 pixels",
    );
    expect(await profile(h.store)).toEqual({ avatar_url: null, header_url: null, display_name: "" });
  });

  it("refuses an expired session without reading the body", async () => {
    const h = await setup();
    const response = await h.request("/settings/avatar", {
      method: "POST",
      body: untouchable(),
      headers: {
        origin: ORIGIN,
        cookie: "__Host-kopje_session=expired",
        "content-type": "multipart/form-data; boundary=b",
      },
      duplex: "half",
    } as RequestInit);
    expect(response.status).toBe(302);
  });
});

describe("update_credentials with an unreadable restore marker", () => {
  it("applies an avatar: an ordinary image's start does not read the marker", async () => {
    const h = await setup();
    const key = restoreMarkerKey(h.store.id.toString());
    await env.MEDIA.put(key, "{");
    try {
      const response = await patch(h, h.users.alice.token, formOf([["avatar", png()]]));
      expect(response.status).toBe(200);
      expect((await profile(h.store))?.avatar_url).toMatch(/\/full\.png$/);
    } finally {
      await env.MEDIA.delete(key);
    }
  });
});
