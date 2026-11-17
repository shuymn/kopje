import { describe, expect, it } from "vitest";

import { bearer } from "./api-helpers";
import { community, post } from "./status-helpers";

// The paging parameters of Mastodon API lists as Kopje reads them (#1759): `limit` sent without a value.

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
