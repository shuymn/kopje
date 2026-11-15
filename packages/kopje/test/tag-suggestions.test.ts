import { describe, expect, it } from "vitest";

import { suggestionsSince, yearBefore } from "../src/domain/tags";
import { type ApiHarness, bearer, settle, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { community, getJson, post, type User } from "./status-helpers";

// GET /api/v1/featured_tags/suggestions as Mastodon 4.7.5's Tag.suggestions_for_account (mastodon#39567): the viewer's
// newest 1,000 statuses of the last calendar year, the hashtags of the kept originals, those counted more than once.
// The read beside main's: test/tag-suggestions-plans.test.ts.

const DAY = 24 * 60 * 60 * 1000;

type Tag = { name: string };

async function suggested(h: ApiHarness, user: User): Promise<string[]> {
  const { status, body } = await getJson<Tag[]>(h, "/api/v1/featured_tags/suggestions", user.token);
  expect(status).toBe(200);
  return body.map((tag) => tag.name);
}

// An imported public status of `author` under `id` carrying `names`; `reblogOf` makes it a boost row.
async function tagged(
  h: ApiHarness,
  author: string,
  id: bigint,
  names: readonly string[],
  reblogOf: string | null = null,
): Promise<string> {
  const text = id.toString();
  await sql(
    h.store,
    `INSERT INTO statuses (id, uri, account_id, visibility, published_at, reblog_of_id)
		VALUES (?1, 'https://kopje.test/ap/o/' || ?1, ?2, 'public', '2026-01-01T00:00:00.000Z', ?3)`,
    text,
    author,
    reblogOf,
  );
  await sql(
    h.store,
    "INSERT INTO status_tags (status_id, name, public) SELECT ?1, value, 1 FROM json_each(?2)",
    text,
    JSON.stringify(names),
  );
  return text;
}

const at = (ms: number, offset = 0n) => (BigInt(ms) << 16n) + offset;

describe("featured tag suggestions", () => {
  it("counts only the statuses of the last calendar year, the one exactly a year old included", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const since = BigInt(suggestionsSince(NOW));
    expect(since).toBe(at(yearBefore(NOW)));
    // Each hashtag once in the last day; `old` again before the year, `edge` at its first id, `outside` just before it.
    await tagged(h, alice.id, at(NOW - DAY), ["recent", "old", "edge", "outside"]);
    await tagged(h, alice.id, at(NOW - 2 * DAY), ["recent"]);
    await tagged(h, alice.id, at(NOW - 400 * DAY), ["old"]);
    await tagged(h, alice.id, since, ["edge"]);
    await tagged(h, alice.id, since - 1n, ["outside"]);
    expect(await suggested(h, alice)).toEqual(["edge", "recent"]);
  });

  it("takes a calendar year from Feb 29 to Feb 28, the time of day kept", async () => {
    const leap = Date.parse("2028-02-29T12:34:56.789Z");
    expect(yearBefore(leap)).toBe(Date.parse("2027-02-28T12:34:56.789Z"));
    expect(yearBefore(Date.parse("2027-03-01T00:00:00.000Z"))).toBe(Date.parse("2026-03-01T00:00:00.000Z"));
    expect(yearBefore(Date.parse("2026-12-31T23:59:59.999Z"))).toBe(Date.parse("2025-12-31T23:59:59.999Z"));
    const h = await community(["alice"]);
    const { alice } = h.users;
    h.now.mockReturnValue(leap);
    // At the first id of 2027-02-28T12:34:56.789Z: counted, where a bound of Mar 1 would leave it out.
    await tagged(h, alice.id, at(Date.parse("2027-02-28T12:34:56.789Z")), ["edge"]);
    await tagged(h, alice.id, at(leap - DAY), ["edge"]);
    await tagged(h, alice.id, at(Date.parse("2027-02-28T12:34:56.788Z")), ["before"]);
    await tagged(h, alice.id, at(leap - 2 * DAY), ["before"]);
    expect(await suggested(h, alice)).toEqual(["edge"]);
  });

  it("counts no hashtag of a status deleted and not yet removed, which still takes its place among the 1,000", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    await tagged(h, alice.id, at(NOW - DAY), ["kept"]);
    const gone = await post(h, alice, { status: "#kept #gone" });
    await tagged(h, alice.id, at(NOW - 2 * DAY), ["gone", "kept"]);
    expect(await suggested(h, alice)).toEqual(["kept", "gone"]);
    const deleted = await h.request(`/api/v1/statuses/${gone.id}`, bearer(alice.token, { method: "DELETE" }));
    expect(deleted.status).toBe(200);
    // Withdrawn, its hashtag rows kept until its job removes it.
    expect(
      await sql(
        h.store,
        "SELECT s.withdrawn, count(t.name) AS n FROM statuses s JOIN status_tags t ON t.status_id = s.id WHERE s.id = ?",
        gone.id,
      ),
    ).toEqual([{ withdrawn: 1, n: 2 }]);
    expect(await suggested(h, alice)).toEqual(["kept"]);
  });

  it("reads the 1,000 newest statuses of the year, a pending deletion among them, and not the one after", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    // 1,000 imported statuses of the last days, `late` on the oldest and the newest of them; then a post.
    await sql(
      h.store,
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 999)
			INSERT INTO statuses (id, uri, account_id, visibility, published_at)
			SELECT CAST(CAST(?1 AS INTEGER) + i * 65536 AS TEXT), 'https://kopje.test/ap/o/w' || i, ?2, 'public',
				'2026-01-01T00:00:00.000Z' FROM n`,
      at(NOW - 10 * DAY).toString(),
      alice.id,
    );
    await sql(
      h.store,
      `INSERT INTO status_tags (status_id, name, public) SELECT id, 'late', 1 FROM statuses
			WHERE uri IN ('https://kopje.test/ap/o/w0', 'https://kopje.test/ap/o/w999')`,
    );
    const newest = await post(h, alice, { status: "newest" });
    // The oldest is the 1,001st.
    expect(await suggested(h, alice)).toEqual([]);
    expect((await h.request(`/api/v1/statuses/${newest.id}`, bearer(alice.token, { method: "DELETE" }))).status).toBe(
      200,
    );
    // Its place is kept while the deletion is pending (Mastodon's `recent.kept` would read the oldest now).
    expect(await suggested(h, alice)).toEqual([]);
    await settle(h.store);
    expect(await sql(h.store, "SELECT id FROM statuses WHERE id = ?", newest.id)).toEqual([]);
    expect(await suggested(h, alice)).toEqual(["late"]);
  });

  it("counts no hashtag of a legacy boost row, Mastodon's boosts carrying none", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    const original = await tagged(h, alice.id, at(NOW - 3 * DAY), []);
    const other = await tagged(h, alice.id, at(NOW - 3 * DAY, 1n), []);
    await tagged(h, bob.id, at(NOW - 2 * DAY), ["boosted", "kept"], original);
    await tagged(h, bob.id, at(NOW - 2 * DAY, 1n), ["boosted"], other);
    await tagged(h, bob.id, at(NOW - 2 * DAY, 2n), ["kept"]);
    expect(await suggested(h, bob)).toEqual([]);
    await tagged(h, bob.id, at(NOW - 2 * DAY, 3n), ["kept"]);
    expect(await suggested(h, bob)).toEqual(["kept"]);
  });
});
