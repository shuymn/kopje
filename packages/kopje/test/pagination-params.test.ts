import { describe, expect, it } from "vitest";

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
