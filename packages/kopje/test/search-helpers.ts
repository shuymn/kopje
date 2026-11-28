import { type ApiHarness, bearer, sql } from "./api-helpers";
import { community } from "./status-helpers";

// The search suites' fixtures (test/search.test.ts, test/search-edge.test.ts).

export type SearchResults = {
  accounts: { id: string; acct: string }[];
  statuses: { id: string; content: string }[];
  hashtags: {
    name: string;
    url: string;
    history: { day: string; uses: string; accounts: string }[];
    following?: boolean;
    featuring?: boolean;
  }[];
  collections: { id: string; uri: string; url: string }[];
};

// alice, bob and carol; `search` asks GET /api/v2/search as alice unless a token is given, and `statusIds` the ids of
// its statuses.
export async function searchFixture() {
  const h = await community(["alice", "bob", "carol"]);
  const search = async (q: string, extra = "", token = h.users.alice.token) => {
    const response = await h.request(`/api/v2/search?q=${encodeURIComponent(q)}${extra}`, bearer(token));
    if (response.status !== 200) {
      throw new Error(`search: ${response.status} ${await response.text()}`);
    }
    return response.json<SearchResults>();
  };
  const statusIds = async (q: string, extra = "", token?: string) =>
    (await search(q, `&type=statuses${extra}`, token)).statuses.map((s) => s.id);
  return { h, search, statusIds };
}

// `count` public statuses by `author` with ids from `base` up, each with `content` (and no search hit for "deep").
export async function fillerStatuses(
  h: Pick<ApiHarness, "store">,
  author: string,
  count: number,
  base: bigint,
  { visibility = "public", tag }: { visibility?: string; tag?: string } = {},
) {
  await sql(
    h.store,
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ? - 1)
		INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, search_text)
		SELECT CAST(? + i AS TEXT), 'https://kopje.test/ap/o/f' || ? || '-' || i, ?, ?, '<p>filler</p>',
			'2026-10-12T00:00:00.000Z', 'filler'
		FROM n`,
    count,
    String(base),
    String(base),
    author,
    visibility,
  );
  if (tag !== undefined) {
    await sql(
      h.store,
      `INSERT INTO status_tags (status_id, name) SELECT id, ? FROM statuses WHERE CAST(id AS INTEGER) BETWEEN ? AND ?`,
      tag,
      String(base),
      String(base + BigInt(count) - 1n),
    );
  }
}

export type SearchHarness = Awaited<ReturnType<typeof searchFixture>>["h"];
