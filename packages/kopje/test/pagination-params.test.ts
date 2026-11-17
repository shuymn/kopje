import { describe, expect, it } from "vitest";

import { pageQuery } from "../src/mastodon/pagination";
import { limitParam, readParams } from "../src/mastodon/params";
import { bearer, setSetting, userToken } from "./api-helpers";
import { community, post, remoteAccount } from "./status-helpers";

// The paging parameters of Mastodon API lists as Kopje reads them (#1734, #1759): `limit` sent without a value, and
// the cursors (docs/mastodon-deviations.md, "Request parameters").

async function page(
  h: { request: (path: string, init?: RequestInit) => Promise<Response> },
  token: string,
  path: string,
) {
  const response = await h.request(path, bearer(token));
  expect(response.status, path).toBe(200);
  return { ids: (await response.json<{ id: string }[]>()).map((item) => item.id), link: response.headers.get("Link") };
}

describe("limit", () => {
  // Api::BaseController#limit_param: Rack reads `?limit` (no `=`) as nil, which is the default; `?limit=` is "", whose
  // to_i is 0 (pageQuery reads it as 1, feedPageQuery answers nothing).
  it("takes the default for a limit sent without a value, and keeps an empty one's answer", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    for (const text of ["a", "b", "c"]) {
      await post(h, alice, { status: text });
    }
    const count = async (path: string) => (await page(h, alice.token, path)).ids.length;
    const statuses = `/api/v1/accounts/${alice.id}/statuses`;
    expect(await count(`${statuses}?limit`)).toBe(3);
    expect(await count(`${statuses}?limit=`)).toBe(1);
    expect(await count(`${statuses}?limit=2`)).toBe(2);
    expect(await count("/api/v1/timelines/public?limit")).toBe(3);
    expect(await count("/api/v1/timelines/public?limit=")).toBe(0);
    expect(await count("/api/v1/timelines/public?limit=2")).toBe(2);
  });

  // A JSON null is nil as well (sentNull), as a JSON body's reader takes it; the lists are GETs, whose body is not read.
  it("takes the default for a JSON null limit, and keeps an empty one's answer", async () => {
    const read = async (body: string) => {
      const request = new Request("https://kopje.test/x", {
        method: "POST",
        body,
        headers: { "content-type": "application/json" },
      });
      const result = await readParams(request);
      if (!result.ok) {
        throw new Error(`refused ${result.status}`);
      }
      return result.params;
    };
    const nil = await read('{"limit":null}');
    expect([limitParam(nil, 20, 40), pageQuery(nil, 20, 40).limit]).toEqual([20, 20]);
    const empty = await read('{"limit":""}');
    expect([limitParam(empty, 20, 40), pageQuery(empty, 20, 40).limit]).toEqual([0, 1]);
  });
});

describe("Link after a limit sent without a value", () => {
  // Rails' url_for drops a nil parameter (ActionDispatch::Http::URL.add_params), so the links of a `?limit` page carry
  // no `limit` and the next page reads the default again; `limit=` and `limit=2` are carried as sent.
  const next = (link: string | null) => /<https:\/\/kopje\.test([^>]*)>; rel="next"/.exec(link ?? "")?.[1] ?? "";

  it("follows next at the default on a feed", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    for (let i = 0; i < 22; i++) {
      await post(h, alice, { status: `s${i}` });
    }
    // The last `limit` is the one read: nil after `limit=5`, so none is carried.
    for (const query of ["?limit", "?limit=5&limit"]) {
      const first = await page(h, alice.token, `/api/v1/timelines/public${query}`);
      expect([query, first.ids.length, next(first.link)]).toEqual([
        query,
        20,
        `/api/v1/timelines/public?max_id=${first.ids[19]}`,
      ]);
      expect(first.link).not.toContain("limit");
      expect((await page(h, alice.token, next(first.link))).ids).toHaveLength(2);
    }
    const two = await page(h, alice.token, "/api/v1/timelines/public?limit=2");
    expect(next(two.link)).toBe(`/api/v1/timelines/public?limit=2&max_id=${two.ids[1]}`);
    const empty = await page(h, alice.token, `/api/v1/accounts/${alice.id}/statuses?limit=`);
    expect(next(empty.link)).toBe(`/api/v1/accounts/${alice.id}/statuses?limit=&max_id=${empty.ids[0]}`);
  });

  it("follows next at the default on an admin list", async () => {
    const h = await community(["owner"]);
    await setSetting(h.store, "admin_email", "owner@example.com");
    const token = await userToken(h, "owner@example.com", "admin:read");
    for (let i = 0; i < 102; i++) {
      await remoteAccount(h.store, `r${i}`);
    }
    const first = await page(h, token, "/api/v2/admin/accounts?origin=remote&limit");
    expect([first.ids.length, next(first.link)]).toEqual([
      100,
      `/api/v2/admin/accounts?max_id=${first.ids[99]}&origin=remote`,
    ]);
    expect(first.link).not.toContain("limit");
    expect((await page(h, token, next(first.link))).ids).toHaveLength(2);
    const two = await page(h, token, "/api/v2/admin/accounts?origin=remote&limit=2");
    expect(next(two.link)).toBe(`/api/v2/admin/accounts?limit=2&max_id=${two.ids[1]}&origin=remote`);
  });
});

describe("cursors", () => {
  // pagination.ts's CURSOR: `max_id`, `since_id` and `min_id` are each the last value sent, read only as 1 to 19
  // decimal digits; anything else is absent, and a 19-digit value past a signed 64-bit integer is a cursor like any.
  it("reads 1 to 19 decimal digits as a cursor and anything else as absent", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const [a, b, c] = [
      (await post(h, alice, { status: "a" })).id,
      (await post(h, alice, { status: "b" })).id,
      (await post(h, alice, { status: "c" })).id,
    ];
    const statuses = async (query: string) => page(h, alice.token, `/api/v1/accounts/${alice.id}/statuses?${query}`);
    const all = [c, b, a];
    expect((await statuses("")).ids).toEqual(all);
    expect((await statuses(`max_id=${c}`)).ids).toEqual([b, a]);
    expect((await statuses(`since_id=${a}`)).ids).toEqual([c, b]);
    expect((await statuses(`min_id=${a}&limit=1`)).ids).toEqual([b]);
    expect((await statuses(`max_id=${c}&max_id=${b}`)).ids).toEqual([a]);
    // Mastodon casts `5abc` as 5 on a list it reads from its database; here it is no cursor.
    for (const value of [`${c}abc`, `+${c}`, ` ${c}`, `${c}.0`, "-1", "0x10", "abc", "", "1".repeat(20)]) {
      for (const name of ["max_id", "since_id", "min_id"]) {
        const query = `${name}=${encodeURIComponent(value)}`;
        expect((await statuses(query)).ids, query).toEqual(all);
      }
    }
    // Past 2^63 - 1 and still 19 digits: a cursor, with no range refusal of its own.
    expect((await statuses("max_id=9999999999999999999")).ids).toEqual(all);
    expect((await statuses("since_id=9999999999999999999")).ids).toEqual([]);
    // The Link continues from the page, replacing a cursor that was not read.
    const { link } = await statuses(`max_id=${c}abc&limit=2`);
    expect(link).toContain(`max_id=${b}>; rel="next"`);
    expect(link).not.toContain("abc");
  });

  // The admin lists read their cursors by the same rule.
  it("reads an admin list's cursors by the same rule", async () => {
    const h = await community(["owner"]);
    await setSetting(h.store, "admin_email", "owner@example.com");
    const token = await userToken(h, "owner@example.com", "admin:read");
    const ids = [
      await remoteAccount(h.store, "carol", "remote.example"),
      await remoteAccount(h.store, "dave", "remote.example"),
    ].toSorted();
    const accounts = async (query: string) =>
      (await page(h, token, `/api/v2/admin/accounts?origin=remote&${query}`)).ids;
    const all = await accounts("");
    expect(all.toSorted()).toEqual(ids);
    expect(await accounts(`max_id=${all[0]}`)).toEqual(all.slice(1));
    expect(await accounts(`max_id=${all[0]}abc`)).toEqual(all);
    expect(await accounts(`since_id=${"9".repeat(20)}`)).toEqual(all);
  });
});
