import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ARCHETYPE_SQL,
  annualReport,
  annualReports,
  annualReportState,
  archetypeOf,
  campaignYear,
  FOLLOWERS_SQL,
  generateAnnualReport,
  markAnnualReportRead,
  REPORT_EXISTS_SQL,
  REPORT_FOLLOWERS,
  REPORT_HASHTAG_BYTES,
  REPORT_HASHTAG_USES,
  REPORT_TAG_CANDIDATES,
  REPORT_YEAR_STATUSES,
  REPORTS_LISTED,
  TAG_USES_SQL,
  YEAR_STATUSES_SQL,
} from "../src/domain/annual-reports";
import { instanceUsage } from "../src/domain/instance";
import type { StoreStub } from "../src/platform/store-client";
import { sha256Hex } from "../src/security/tokens";
import {
  IN_CAMPAIGN,
  idIn,
  insertAccounts,
  insertFollows,
  insertPost,
  type Post,
  YEAR,
  yearEnd,
} from "./annual-report-fixtures";
import { type ApiHarness, apiHarness, bearer, seedAccount, setSetting, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { appTokenWith, measuredStatements, scopedToken } from "./read-helpers";

// Annual reports (docs/mastodon-deviations.md, "Annual reports"; R44): the campaign, state, generate, the four sources,
// the caps, index, show, read and the presentation. The dated cases fake nothing but run the operations with an
// explicit storeNow (the Store's clock, which the operations take: test/annual-report-clock.test.ts holds that through
// the RPC path), or use 2025, a year that is never again a campaign.

const PRESENT = { origin: "https://kopje.test" };
const recordNotFound = { error: "Record not found" };

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

type World = Awaited<ReturnType<typeof world>>;

// alice (the owner, with a read and write token), bob (another local account) and carol (remote).
async function world(h?: ApiHarness) {
  const harness = h ?? (await apiHarness());
  const alice = await seedAccount(harness.store, { username: "alice", email: "alice@example.com" });
  const bob = await seedAccount(harness.store, { username: "bob", email: "bob@example.com" });
  const carol = await seedAccount(harness.store, { username: "carol", domain: "remote.example" });
  const token = await scopedToken(harness, "read write");
  const tokenHash = await sha256Hex(token);
  return {
    h: harness,
    alice,
    bob,
    carol,
    token,
    read: { tokenHash, scope: "read:accounts", now: NOW } as never,
    write: { tokenHash, scope: "write:accounts", now: NOW } as never,
  };
}

function inStore(store: StoreStub, fn: (sql: SqlStorage) => void): Promise<void> {
  return runInDurableObject(store, (_instance, state) => fn(state.storage.sql));
}

const posts = (w: World, list: readonly Post[]) =>
  inStore(w.h.store, (s) => {
    for (const post of list) {
      insertPost(s, post);
    }
  });

// The ops, each with the Store's clock given.
async function stateOf(w: World, year: number | string, storeNow = IN_CAMPAIGN) {
  const { output, statements } = await measuredStatements(w.h, annualReportState, {
    credential: w.read,
    year: String(year),
    storeNow,
  });
  if (output.status !== "ok") throw new Error(output.status);
  return { state: output.value, statements };
}

async function generated(w: World, year: number | string = YEAR, storeNow = IN_CAMPAIGN) {
  const { output, statements } = await measuredStatements(
    w.h,
    generateAnnualReport,
    { credential: w.write, year: String(year), storeNow },
    true,
  );
  if (output.status !== "ok") throw new Error(output.status);
  return statements;
}

const reportRows = (w: World) => sql(w.h.store, "SELECT * FROM annual_reports ORDER BY account_id, year");

async function shown(w: World, year: number | string) {
  const output = (
    await measuredStatements(w.h, annualReport, { credential: w.read, year: String(year), present: PRESENT })
  ).output;
  if (output.status !== "ok") throw new Error(output.status);
  return output.value;
}

async function listed(w: World) {
  const output = (await measuredStatements(w.h, annualReports, { credential: w.read, present: PRESENT })).output;
  if (output.status !== "ok") throw new Error(output.status);
  return output.value;
}

// A report row of `account`'s `year`, as an import would bring it.
function insertReport(
  w: World,
  account: string,
  year: number,
  row: Partial<{ top_status_id: string | null; viewed_at: string | null; created_at: string }> = {},
) {
  return sql(
    w.h.store,
    `INSERT INTO annual_reports (account_id, year, archetype, statuses, followers, top_status_id, top_hashtag,
			top_hashtag_uses, viewed_at, created_at) VALUES (?, ?, 'oracle', 3, 1, ?, 'kopje', 2, ?, ?)`,
    account,
    year,
    row.top_status_id ?? null,
    row.viewed_at ?? null,
    row.created_at ?? "2026-12-11T00:00:00.000Z",
  );
}

const warnings = () => vi.spyOn(console, "warn").mockImplementation(() => {});
const capped = (spy: ReturnType<typeof warnings>) =>
  spy.mock.calls
    .map(([event]) => event as Record<string, unknown>)
    .filter((e) => e.event === "kopje.annual_reports.capped");

// The statements of the year's reads among those an operation ran.
const yearReads = (statements: readonly { query: string }[]) =>
  statements.filter((s) => /\b(?:statuses|follows|status_tags)\b/.test(s.query));

describe("the campaign", () => {
  it.each([
    ["2026-11-30T12:00:00.000Z", null],
    ["2026-11-10T00:00:00.000Z", null],
    ["2026-12-09T23:59:59.999Z", null],
    ["2026-12-10T00:00:00.000Z", 2026],
    ["2026-12-31T23:59:59.999Z", 2026],
    ["2027-01-01T00:00:00.000Z", null],
    ["2027-06-01T00:00:00.000Z", null],
  ])("at %s is %s", (time, year) => {
    expect(campaignYear(Date.parse(time), true)).toBe(year);
  });

  it("is off with the switch off", () => {
    expect(campaignYear(Date.parse("2026-12-20T00:00:00.000Z"), false)).toBeNull();
  });

  it("is /api/v2/instance's wrapstodon at the Store's time, off only with the setting 'false'", async () => {
    const w = await world();
    const at = async (time: string) =>
      (await measuredStatements(w.h, instanceUsage, { now: NOW, storeNow: Date.parse(time), present: PRESENT })).output
        .wrapstodon;
    expect(await at("2026-12-09T23:59:59.999Z")).toBeNull();
    expect(await at("2026-12-10T00:00:00.000Z")).toBe(2026);
    expect(await at("2026-12-31T23:59:59.999Z")).toBe(2026);
    expect(await at("2027-01-01T00:00:00.000Z")).toBeNull();
    await setSetting(w.h.store, "wrapstodon", "false");
    expect(await at("2026-12-20T00:00:00.000Z")).toBeNull();
    await setSetting(w.h.store, "wrapstodon", "true");
    expect(await at("2026-12-20T00:00:00.000Z")).toBe(2026);
    await sql(w.h.store, "DELETE FROM instance_settings WHERE name = 'wrapstodon'");
    expect(await at("2026-12-20T00:00:00.000Z")).toBe(2026);
  });
});

describe("state", () => {
  it("is ineligible for a year that is not the campaign's, reading no status", async () => {
    const w = await world();
    await posts(w, [{ id: idIn(2025, 1), account: w.alice, tags: ["cats"] }]);
    const { state, statements } = await stateOf(w, 2025);
    expect(state).toBe("ineligible");
    // A1 and S1 ran (the guarded branch), and nothing of the year.
    expect(statements.map((s) => s.query)).toContain(REPORT_EXISTS_SQL);
    expect(statements.some((s) => s.query.includes("name = 'wrapstodon'"))).toBe(true);
    expect(yearReads(statements)).toEqual([]);
  });

  it("is eligible in the campaign with a counted public post and a counted post with a hashtag", async () => {
    const w = await world();
    await posts(w, [
      { id: idIn(YEAR, 1), account: w.alice, visibility: "unlisted" },
      { id: idIn(YEAR, 2), account: w.alice, visibility: "direct", tags: ["cats"] },
    ]);
    expect((await stateOf(w, YEAR)).state).toBe("eligible");
    // A boost counts as public.
    const b = await world();
    await posts(b, [
      { id: idIn(YEAR, 1), account: b.bob },
      { id: idIn(YEAR, 2), account: b.alice, reblogOf: idIn(YEAR, 1) },
      { id: idIn(YEAR, 3), account: b.alice, visibility: "private", tags: ["cats"] },
    ]);
    expect((await stateOf(b, YEAR)).state).toBe("eligible");
  });

  it.each<[string, (w: World) => Post[]]>([
    [
      "only private, direct and limited posts with hashtags",
      (w) => [
        { id: idIn(YEAR, 1), account: w.alice, visibility: "private", tags: ["cats"] },
        { id: idIn(YEAR, 2), account: w.alice, visibility: "direct", tags: ["cats"] },
        { id: idIn(YEAR, 3), account: w.alice, visibility: "limited", tags: ["cats"] },
      ],
    ],
    ["public posts without a hashtag", (w) => [{ id: idIn(YEAR, 1), account: w.alice }]],
    [
      "the only public post withdrawn",
      (w) => [
        { id: idIn(YEAR, 1), account: w.alice, withdrawn: true },
        { id: idIn(YEAR, 2), account: w.alice, visibility: "private", tags: ["cats"] },
      ],
    ],
    [
      "the only tagged post withdrawn",
      (w) => [
        { id: idIn(YEAR, 1), account: w.alice },
        { id: idIn(YEAR, 2), account: w.alice, withdrawn: true, tags: ["cats"] },
      ],
    ],
    [
      "public tagged posts only just outside the year",
      (w) => [
        // The last id of 2025-12-31T23:59:59.999Z, and the first of 2027-01-01T00:00:00.000Z (the range's end).
        { id: idIn(YEAR, -1), account: w.alice, tags: ["cats"] },
        { id: yearEnd(YEAR), account: w.alice, tags: ["cats"] },
      ],
    ],
    ["another account's posts", (w) => [{ id: idIn(YEAR, 1), account: w.bob, tags: ["cats"] }]],
  ])("is ineligible in the campaign with %s", async (_name, list) => {
    const w = await world();
    await posts(w, list(w));
    const { state, statements } = await stateOf(w, YEAR);
    expect(state).toBe("ineligible");
    // The year was read: the refusal is the sources', not the campaign's.
    expect(statements.map((s) => s.query)).toEqual(
      expect.arrayContaining([YEAR_STATUSES_SQL, FOLLOWERS_SQL, TAG_USES_SQL]),
    );
  });

  it("is available while the report exists, after the campaign and with the switch off", async () => {
    const w = await world();
    await insertReport(w, w.alice, 2025);
    expect((await stateOf(w, 2025)).state).toBe("available");
    await setSetting(w.h.store, "wrapstodon", "false");
    expect((await stateOf(w, 2025)).state).toBe("available");
    // Another account's year is not this owner's report.
    await insertReport(w, w.bob, 2024);
    expect((await stateOf(w, 2024)).state).toBe("ineligible");
  });
});

describe("generate", () => {
  it("writes nothing outside the campaign or with the switch off", async () => {
    const w = await world();
    await posts(w, [{ id: idIn(2025, 1), account: w.alice, tags: ["cats"] }]);
    const statements = await generated(w, 2025);
    expect(yearReads(statements)).toEqual([]);
    expect(await reportRows(w)).toEqual([]);
    await setSetting(w.h.store, "wrapstodon", "false");
    await generated(w, YEAR);
    expect(await reportRows(w)).toEqual([]);
    for (const year of ["abc", "0", "-5", "12345678901234567890"]) {
      await generated(w, year);
    }
    expect(await reportRows(w)).toEqual([]);
  });

  it("writes the report of an ineligible account in the campaign, stamped with the Store's time", async () => {
    const w = await world();
    await generated(w, YEAR);
    expect(await reportRows(w)).toEqual([
      {
        account_id: w.alice,
        year: YEAR,
        archetype: "lurker",
        statuses: 0,
        followers: 0,
        top_status_id: null,
        top_hashtag: null,
        top_hashtag_uses: null,
        viewed_at: null,
        created_at: new Date(IN_CAMPAIGN).toISOString(),
      },
    ]);
  });

  it("writes once: a second generate keeps the first report", async () => {
    const w = await world();
    await generated(w, YEAR);
    const first = await reportRows(w);
    await posts(w, [{ id: idIn(YEAR, 1), account: w.alice, tags: ["cats"] }]);
    const statements = await generated(w, YEAR, IN_CAMPAIGN + 60_000);
    expect(yearReads(statements)).toEqual([]);
    expect(await reportRows(w)).toEqual(first);
  });

  it("answers 200 {} to two concurrent requests and writes one report", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const arrived = new Promise<void>((resolve) => (reached = resolve));
    let held = false;
    const h = await apiHarness(
      {},
      {
        wrapStore: (store) =>
          new Proxy(store, {
            get: (target, name, receiver) => {
              const value = Reflect.get(target, name, receiver) as unknown;
              if (name !== "generateAnnualReport" || held) return value;
              held = true;
              return async (...args: unknown[]) => {
                reached();
                await gate;
                return Reflect.apply(value as (...a: unknown[]) => unknown, target, args);
              };
            },
          }),
      },
    );
    const w = await world(h);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(IN_CAMPAIGN);
    const first = h.request(`/api/v1/annual_reports/${YEAR}/generate`, bearer(w.token, { method: "POST" }));
    await arrived;
    const second = await h.request(`/api/v1/annual_reports/${YEAR}/generate`, bearer(w.token, { method: "POST" }));
    expect([second.status, await second.json()]).toEqual([200, {}]);
    expect(await reportRows(w)).toHaveLength(1);
    release();
    const answer = await first;
    expect([answer.status, await answer.json()]).toEqual([200, {}]);
    expect(await reportRows(w)).toHaveLength(1);
    expect(answer.headers.get("mastodon-async-refresh")).toBeNull();
  });
});

describe("the sources", () => {
  it("decides the archetype as Mastodon's, at each boundary", () => {
    const c = (standalone: number, replies: number, reblogs: number, polls: number) =>
      archetypeOf({ standalone, replies, reblogs, polls });
    expect([c(112, 0, 0, 0), c(113, 0, 0, 0), c(100, 6, 6, 0), c(100, 7, 6, 0)]).toEqual([
      "lurker",
      "oracle",
      "lurker",
      "oracle",
    ]);
    expect([c(50, 0, 100, 0), c(50, 0, 101, 0)]).toEqual(["oracle", "booster"]);
    expect([c(120, 0, 0, 12), c(120, 0, 0, 13)]).toEqual(["oracle", "pollster"]);
    expect([c(50, 100, 0, 0), c(50, 101, 0, 0)]).toEqual(["oracle", "replier"]);
    // The order: a booster before a pollster, a pollster before a replier.
    expect([c(50, 101, 101, 6), c(50, 101, 0, 6)]).toEqual(["booster", "pollster"]);
  });

  it("counts self-replies as standalone, a reply to an unknown author in neither, and polls of counted posts", async () => {
    const w = await world();
    const parent = idIn(YEAR, 1);
    await posts(w, [
      { id: parent, account: w.bob },
      { id: idIn(YEAR, 2), account: w.alice, reply: { id: parent, account: w.bob } },
      { id: idIn(YEAR, 3), account: w.alice, reply: { id: null, account: w.alice } },
      { id: idIn(YEAR, 4), account: w.alice, reply: { id: parent, account: null } },
      { id: idIn(YEAR, 5), account: w.alice, reply: { id: null, account: w.bob } },
      { id: idIn(YEAR, 6), account: w.alice, poll: true },
      { id: idIn(YEAR, 7), account: w.alice, poll: true, withdrawn: true },
      { id: idIn(YEAR, 8), account: w.alice, reblogOf: parent },
    ]);
    const [counts] = await sql(w.h.store, ARCHETYPE_SQL, w.alice, idIn(YEAR, 0), yearEnd(YEAR));
    expect(counts).toEqual({ statuses: 6, standalone: 2, replies: 1, reblogs: 1, polls: 1 });
  });

  it("counts the year's statuses of every visibility, boosts included, and the followers whose request is in it", async () => {
    const w = await world();
    const parent = idIn(YEAR, 1);
    await posts(w, [
      { id: parent, account: w.bob },
      { id: idIn(YEAR, 2), account: w.alice, reblogOf: parent },
      { id: idIn(YEAR, 3), account: w.alice, visibility: "direct" },
      { id: idIn(YEAR, 4), account: w.alice, visibility: "limited" },
      { id: idIn(YEAR, 5), account: w.alice, visibility: "private" },
      { id: idIn(YEAR, 6), account: w.alice, withdrawn: true },
    ]);
    await inStore(w.h.store, (s) => {
      insertAccounts(s, 6, 800000000000000000n);
      insertFollows(s, w.alice, 2, 800000000000000000n, "accepted", "2026-03-01T00:00:00.000Z");
      insertFollows(s, w.alice, 1, 800000000000000002n, "pending", "2026-03-01T00:00:00.000Z");
      insertFollows(s, w.alice, 1, 800000000000000003n, "accepted", "2025-12-31T23:59:59.999Z");
      insertFollows(s, w.alice, 1, 800000000000000004n, "accepted", "2026-03-01 00:00:00");
      insertFollows(s, w.alice, 1, 800000000000000005n, "accepted", "2027-01-01T00:00:00.000Z");
    });
    await generated(w);
    expect(await reportRows(w)).toMatchObject([{ statuses: 4, followers: 2 }]);
  });

  it("picks the top status among counted public or unlisted originals with a count, by boosts, ties to the lowest id", async () => {
    const pick = async (list: (w: World) => Post[]) => {
      const w = await world();
      await posts(w, list(w));
      await generated(w);
      return (await reportRows(w))[0]?.top_status_id;
    };
    const original = idIn(YEAR, 100);
    expect(
      await pick((w) => [
        { id: idIn(YEAR, 1), account: w.alice, visibility: "private", reblogs: 9 },
        { id: original, account: w.bob, reblogs: 9 },
        { id: idIn(YEAR, 2), account: w.alice, reblogOf: original, reblogs: 9 },
        { id: idIn(YEAR, 3), account: w.alice, withdrawn: true, reblogs: 9 },
        { id: idIn(YEAR, 4), account: w.alice },
        { id: idIn(YEAR, 5), account: w.alice, visibility: "unlisted", favourites: 1 },
      ]),
    ).toBe(idIn(YEAR, 5));
    expect(
      await pick((w) => [
        { id: idIn(YEAR, 1), account: w.alice, replies: 1 },
        { id: idIn(YEAR, 2), account: w.alice, reblogs: 2 },
        { id: idIn(YEAR, 3), account: w.alice, reblogs: 2 },
      ]),
    ).toBe(idIn(YEAR, 2));
    expect(await pick((w) => [{ id: idIn(YEAR, 1), account: w.alice }])).toBeNull();
  });

  // TopStatuses ranks by the status's own boosts (status_stats.reblogs_count), never by the untrusted count an import
  // may have stored on the owner's status (migration 0114_untrusted_counts).
  it("picks the top status by its own boosts, whatever untrusted count it stores", async () => {
    const w = await world();
    await posts(w, [
      { id: idIn(YEAR, 1), account: w.alice, reblogs: 2 },
      { id: idIn(YEAR, 2), account: w.alice, reblogs: 3 },
    ]);
    await sql(w.h.store, "UPDATE statuses SET untrusted_reblogs_count = 100000000 WHERE id = ?", idIn(YEAR, 1));
    await generated(w);
    expect((await reportRows(w))[0]?.top_status_id).toBe(idIn(YEAR, 2));
  });

  it("picks the most used hashtag of counted posts, more than one use, ties by name, passing over a refused name", async () => {
    const pick = async (list: (w: World) => Post[]) => {
      const w = await world();
      await posts(w, list(w));
      await generated(w);
      const [row] = await reportRows(w);
      return [row?.top_hashtag, row?.top_hashtag_uses];
    };
    const at = (n: number) => idIn(YEAR, n);
    // One use is not listed.
    expect(await pick((w) => [{ id: at(1), account: w.alice, tags: ["cats"] }])).toEqual([null, null]);
    // A tie is ordered by name.
    expect(
      await pick((w) => [
        { id: at(1), account: w.alice, tags: ["dogs", "cats"] },
        { id: at(2), account: w.alice, tags: ["dogs", "cats"] },
      ]),
    ).toEqual(["cats", 2]);
    // Uses on withdrawn posts and other accounts' posts do not count.
    expect(
      await pick((w) => [
        { id: at(1), account: w.alice, tags: ["dogs", "cats"] },
        { id: at(2), account: w.alice, tags: ["dogs"] },
        { id: at(3), account: w.alice, withdrawn: true, tags: ["cats", "dogs"] },
        { id: at(4), account: w.alice, withdrawn: true, tags: ["cats"] },
        { id: at(5), account: w.bob, tags: ["cats"] },
        { id: at(6), account: w.alice, tags: ["birds"] },
      ]),
    ).toEqual(["dogs", 2]);
    // A name past tagNameSql's bound, and an imported name with a NUL or malformed UTF-8 ranked first, are passed over.
    const long = "a".repeat(257);
    const nul = "a\u0000b";
    const malformed = new Uint8Array([0x61, 0xff]);
    expect(
      await pick((w) => [
        { id: at(1), account: w.alice, tags: [long, nul, malformed, "cats"] },
        { id: at(2), account: w.alice, tags: [long, nul, malformed, "cats"] },
        { id: at(3), account: w.alice, tags: [long, nul, malformed] },
      ]),
    ).toEqual(["cats", 2]);
  });

  it(`takes the first admissible name among the ${REPORT_TAG_CANDIDATES} most used, and none past them`, async () => {
    // `refused` names (each with a NUL) used three times, ranked above "cats" used twice.
    const pick = async (refused: number, admissible: boolean) => {
      const w = await world();
      const names = Array.from({ length: refused }, (_, i) => `r${String(i).padStart(2, "0")}\u0000`);
      await posts(w, [
        { id: idIn(YEAR, 1), account: w.alice, tags: [...names, ...(admissible ? ["cats"] : [])] },
        { id: idIn(YEAR, 2), account: w.alice, tags: [...names, ...(admissible ? ["cats"] : [])] },
        { id: idIn(YEAR, 3), account: w.alice, tags: names },
      ]);
      await generated(w);
      return (await reportRows(w))[0]?.top_hashtag;
    };
    expect(await pick(REPORT_TAG_CANDIDATES - 1, true)).toBe("cats");
    expect(await pick(REPORT_TAG_CANDIDATES, true)).toBeNull();
    expect(await pick(REPORT_TAG_CANDIDATES + 1, false)).toBeNull();
  });
});

// Each cap at its value (the report is made) and one past it alone (it is not, and the reason is logged).
describe("the caps", () => {
  type Fill = (w: World, s: SqlStorage, past: boolean) => void;
  // A counted public post with a hashtag used twice, so that the account is eligible within the caps.
  const eligible = (w: World, s: SqlStorage) => {
    insertPost(s, { id: idIn(YEAR, 1_000_000), account: w.alice, tags: ["cats"] });
    insertPost(s, { id: idIn(YEAR, 1_000_001), account: w.alice, tags: ["cats"] });
  };
  // `count` private posts of the owner from offset 0, by twos.
  const statuses = (w: World, s: SqlStorage, count: number) =>
    s.exec(
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
			INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
			SELECT CAST(?2 + 2 * i AS TEXT), 'https://kopje.test/ap/o/' || (?2 + 2 * i), ?3, 'private', '<p>x</p>',
				'2026-06-01T00:00:00.000Z' FROM n`,
      count,
      idIn(YEAR, 0),
      w.alice,
    );
  // `uses` tag rows of `bytes` each (the last `last` bytes), 100 a status, on the posts statuses() wrote.
  const tags = (s: SqlStorage, uses: number, bytes: number, last = bytes) =>
    s.exec(
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
			INSERT INTO status_tags (status_id, name)
			SELECT CAST(?2 + 2 * (i / 100) AS TEXT),
				substr(printf('%08d', i) || replace(hex(zeroblob(?3)), '0', 'a'), 1, CASE WHEN i = ?1 - 1 THEN ?4 ELSE ?3 END)
			FROM n`,
      uses,
      idIn(YEAR, 0),
      bytes,
      last,
    );
  const cases: [cap: string, fill: Fill][] = [
    ["statuses", (w, s, past) => statuses(w, s, REPORT_YEAR_STATUSES - 2 + (past ? 1 : 0))],
    [
      "hashtag_uses",
      (w, s, past) => {
        statuses(w, s, Math.ceil((REPORT_HASHTAG_USES + 1) / 100));
        tags(s, REPORT_HASHTAG_USES - 2 + (past ? 1 : 0), 8);
      },
    ],
    [
      "hashtag_bytes",
      (w, s, past) => {
        // 1,024-byte names to REPORT_HASHTAG_BYTES with the two eligible uses ("cats", four bytes each), or one byte past.
        const uses = REPORT_HASHTAG_BYTES / 1024;
        statuses(w, s, Math.ceil(uses / 100));
        tags(s, uses, 1024, 1024 - 8 + (past ? 1 : 0));
      },
    ],
    [
      "followers",
      (w, s, past) => {
        insertAccounts(s, REPORT_FOLLOWERS + 1, 800000000000000000n);
        insertFollows(
          s,
          w.alice,
          REPORT_FOLLOWERS + (past ? 1 : 0),
          800000000000000000n,
          "accepted",
          "2026-03-01T00:00:00.000Z",
        );
      },
    ],
  ];

  it.each(cases)(
    "%s: at the cap the report is made, one past it it is not, and the reason is logged",
    async (cap, fill) => {
      for (const past of [false, true]) {
        const w = await world();
        await inStore(w.h.store, (s) => {
          eligible(w, s);
          fill(w, s, past);
        });
        // The fixture sits where it should: at the cap, or one past it.
        const [counted] = await sql<{ statuses: number; uses: number; bytes: number; followers: number }>(
          w.h.store,
          `SELECT (SELECT count(*) FROM statuses WHERE account_id = ?1) AS statuses,
					(SELECT count(*) FROM status_tags t JOIN statuses s ON s.id = t.status_id WHERE s.account_id = ?1) AS uses,
					(SELECT sum(octet_length(t.name)) FROM status_tags t JOIN statuses s ON s.id = t.status_id
						WHERE s.account_id = ?1) AS bytes,
					(SELECT count(*) FROM follows WHERE target_account_id = ?1 AND state = 'accepted') AS followers`,
          w.alice,
        );
        const value = {
          statuses: counted!.statuses,
          hashtag_uses: counted!.uses,
          hashtag_bytes: counted!.bytes,
          followers: counted!.followers,
        }[cap];
        const limit = {
          statuses: REPORT_YEAR_STATUSES,
          hashtag_uses: REPORT_HASHTAG_USES,
          hashtag_bytes: REPORT_HASHTAG_BYTES,
          followers: REPORT_FOLLOWERS,
        }[cap];
        expect(value, cap).toBe(past ? limit! + 1 : limit);
        const spy = warnings();
        expect((await stateOf(w, YEAR)).state, `${cap} past: ${past}`).toBe(past ? "ineligible" : "eligible");
        await generated(w);
        expect(await reportRows(w), `${cap} past: ${past}`).toHaveLength(past ? 0 : 1);
        expect(capped(spy)).toEqual(
          past
            ? [
                { event: "kopje.annual_reports.capped", cap, call: "state" },
                { event: "kopje.annual_reports.capped", cap, call: "generate" },
              ]
            : [],
        );
        spy.mockRestore();
      }
    },
    300_000,
  );

  it("leaves an existing report available past every cap, reading none of the year", async () => {
    const w = await world();
    await insertReport(w, w.alice, YEAR);
    await inStore(w.h.store, (s) => {
      statuses(w, s, REPORT_YEAR_STATUSES + 1);
      tags(s, REPORT_HASHTAG_USES + 1, 8);
      insertAccounts(s, REPORT_FOLLOWERS + 1, 800000000000000000n);
      insertFollows(s, w.alice, REPORT_FOLLOWERS + 1, 800000000000000000n, "accepted", "2026-03-01T00:00:00.000Z");
    });
    const spy = warnings();
    const { state, statements } = await stateOf(w, YEAR);
    expect(state).toBe("available");
    expect(statements.map((s) => s.query)).toContain(REPORT_EXISTS_SQL);
    expect(yearReads(statements)).toEqual([]);
    const before = await reportRows(w);
    expect(yearReads(await generated(w))).toEqual([]);
    expect(await reportRows(w)).toEqual(before);
    expect(capped(spy)).toEqual([]);
  }, 120_000);
});

describe("index, show and read", () => {
  it("lists the owner's pending reports, newest first, at most REPORTS_LISTED, with the owner's account", async () => {
    const w = await world();
    expect(await listed(w)).toEqual({ annual_reports: [], accounts: [], statuses: [] });
    await sql(
      w.h.store,
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?2 - 1)
			INSERT INTO annual_reports (account_id, year, archetype, statuses, followers, created_at)
			SELECT ?1, 2026 - i, 'oracle', 0, 0, '2026-12-11T00:00:00.000Z' FROM n`,
      w.alice,
      REPORTS_LISTED + 1,
    );
    await insertReport(w, w.alice, 1900, { viewed_at: "2026-12-12T00:00:00.000Z" });
    await insertReport(w, w.bob, 2027);
    const answer = await listed(w);
    expect(answer.annual_reports.map((r) => r.year)).toEqual(
      Array.from({ length: REPORTS_LISTED }, (_, i) => 2026 - i),
    );
    expect(answer.accounts.map((a) => a.id)).toEqual([w.alice]);
    expect(answer.statuses).toEqual([]);
  });

  it("shows the owner's report of a year, read or not, and no one else's", async () => {
    const w = await world();
    await insertReport(w, w.alice, 2026, { viewed_at: "2026-12-12T00:00:00.000Z" });
    await insertReport(w, w.bob, 2025);
    expect((await shown(w, 2026))?.annual_reports.map((r) => r.year)).toEqual([2026]);
    expect((await shown(w, "2026"))?.accounts.map((a) => a.id)).toEqual([w.alice]);
    expect(await shown(w, 2025)).toBeNull();
    const route = async (id: string) => {
      const response = await w.h.request(`/api/v1/annual_reports/${id}`, bearer(w.token));
      return [response.status, await response.json<{ annual_reports?: { year: number }[] }>()] as const;
    };
    expect((await route("2026abc"))[1].annual_reports?.map((r) => r.year)).toEqual([2026]);
    for (const id of ["abc", "0", "-5", "12345678901234567890", "2025"]) {
      expect(await route(id), id).toEqual([404, recordNotFound]);
    }
  });

  it("marks the owner's report read at the Store's time, which the list then leaves out", async () => {
    const w = await world();
    await insertReport(w, w.alice, 2026);
    await insertReport(w, w.bob, 2025);
    const read = (year: number) =>
      measuredStatements(
        w.h,
        markAnnualReportRead,
        { credential: w.write, year: String(year), storeNow: Date.parse("2027-01-02T03:04:05.006Z") },
        true,
      );
    expect((await read(2026)).output).toEqual({ status: "ok", value: true });
    expect((await read(2025)).output).toEqual({ status: "ok", value: false });
    expect(await sql(w.h.store, "SELECT account_id, viewed_at FROM annual_reports ORDER BY year")).toEqual([
      { account_id: w.bob, viewed_at: null },
      { account_id: w.alice, viewed_at: "2027-01-02T03:04:05.006Z" },
    ]);
    expect((await listed(w)).annual_reports).toEqual([]);
    expect((await shown(w, 2026))?.annual_reports).toHaveLength(1);
    const response = await w.h.request("/api/v1/annual_reports/2025/read", bearer(w.token, { method: "POST" }));
    expect([response.status, await response.json()]).toEqual([404, recordNotFound]);
  });

  it("presents the report as REST::AnnualReportSerializer, its top status only while the owner may view it", async () => {
    const w = await world();
    const top = idIn(YEAR, 1);
    const hidden = idIn(YEAR, 2);
    await posts(w, [
      { id: top, account: w.alice, reblogs: 3 },
      { id: hidden, account: w.bob, visibility: "private" },
    ]);
    await insertReport(w, w.alice, 2026, { top_status_id: top });
    // A restored row naming a status the owner may not see, created in the future.
    await insertReport(w, w.alice, 2025, { top_status_id: hidden, created_at: "2099-01-01T00:00:00.000Z" });
    const answer = await listed(w);
    expect(answer.annual_reports).toEqual([
      {
        year: 2026,
        data: {
          archetype: "oracle",
          top_statuses: { by_reblogs: top, by_favourites: null, by_replies: null },
          time_series: [{ month: 12, statuses: 3, followers: 1 }],
          top_hashtags: [{ name: "kopje", count: 2 }],
        },
        schema_version: 2,
        share_url: null,
        account_id: w.alice,
      },
      expect.objectContaining({
        year: 2025,
        data: expect.objectContaining({ top_statuses: { by_reblogs: null, by_favourites: null, by_replies: null } }),
      }),
    ]);
    expect(answer.statuses.map((s) => s.id)).toEqual([top]);
    // Withdrawn, then deleted: no top status.
    await sql(w.h.store, "UPDATE statuses SET withdrawn = 1 WHERE id = ?", top);
    expect((await shown(w, 2026))?.annual_reports[0]?.data.top_statuses.by_reblogs).toBeNull();
    await sql(w.h.store, "DELETE FROM statuses WHERE id = ?", top);
    const gone = await shown(w, 2026);
    expect([gone?.annual_reports[0]?.data.top_statuses.by_reblogs, gone?.statuses]).toEqual([null, []]);
  });
});

describe("the routes", () => {
  const send = async (h: ApiHarness, method: string, route: string, token?: string) => {
    const response = await h.request(route, token === undefined ? { method } : bearer(token, { method }));
    return { status: response.status, body: await response.json<unknown>() };
  };
  // Answers that hold on any date: 2025 is never again a campaign.
  const answers: [string, string, string, number, unknown][] = [
    ["GET", "/api/v1/annual_reports", "read:accounts", 200, { annual_reports: [], accounts: [], statuses: [] }],
    ["GET", "/api/v1/annual_reports/2025", "read:accounts", 404, recordNotFound],
    ["GET", "/api/v1/annual_reports/2025/state", "read:accounts", 200, { state: "ineligible" }],
    ["POST", "/api/v1/annual_reports/2025/read", "write:accounts", 404, recordNotFound],
    ["POST", "/api/v1/annual_reports/2025/generate", "write:accounts", 200, {}],
  ];

  it.each(answers)("%s %s answers the user under %s (AUTH-2)", async (method, route, scope, status, body) => {
    const h = await apiHarness();
    const alice = await seedAccount(h.store, { username: "alice", email: "alice@example.com" });
    expect(await send(h, method, route, await scopedToken(h, scope))).toEqual({ status, body });
    expect((await send(h, method, route)).status).toBe(401);
    const other = scope.startsWith("read") ? "write" : "read";
    expect(await send(h, method, route, await scopedToken(h, other))).toEqual({
      status: 403,
      body: { error: "This action is outside the authorized scopes" },
    });
    expect(await send(h, method, route, await appTokenWith(h, scope))).toEqual({
      status: 422,
      body: { error: "This method requires an authenticated user" },
    });
    const token = await scopedToken(h, scope);
    await sql(h.store, "UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?", "2026-01-01", alice);
    expect((await send(h, method, route, token)).status).toBe(403);
  });
});
