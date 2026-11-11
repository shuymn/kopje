import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Page, PageQuery } from "../src/domain/accounts";
import {
  accountStatuses,
  type AccountStatusesInput,
  tagTimeline,
  type TagTimelineInput,
} from "../src/domain/timelines";
import { CONDITION_WALK, readWindow, streamWindow } from "../src/domain/windows";
import type { StoreStub } from "../src/platform/store-client";
import type { StoreOperation } from "../src/platform/store-kernel";
import { NOW } from "./app-helpers";
import {
  ACCOUNT_NEWER,
  ACCOUNT_OLDER,
  ACCOUNT_REJECTED,
  type AccountKind,
  accountMatches,
  CONDITION_WALK_ROUNDS,
  REMOTE,
  seedConditionWorld,
  staleWalk,
  statusIds,
  TAG_ALL,
  TAG_ANY,
  TAG_NEWER,
  TAG_OLDER,
  TAG_REJECTED,
  type TagKind,
  tagMatches,
} from "./condition-walk-helpers";
import { migratedStore } from "./helpers";
import { rowsRead, watchedCursor } from "./read-helpers";

// Reads with request conditions (docs/visibility.md "Read bounds", RES-7): the conditions are tested by key on the
// candidates a walk examined (walkedWindow, passingIds), outside the LIMITs of its rounds, so a page charges at most
// CONDITION_WALK entries that pass the audience rule, and a walk cut by the budget continues from the last one. Every
// witness world holds only rows that pass the audience rule (its walk-past cost is the RES-7 gap), but for the hidden
// rows the disclosure cases place.

const PRESENT = { origin: "https://kopje.test" };
const PAGE = { limit: 20 };
// The largest page the API asks for (src/mastodon/timelines.ts, src/mastodon/accounts.ts).
const PAGE_MAX = { limit: 40 };
const TOKEN = "condition-walk-token";
const credential = { tokenHash: TOKEN, scope: "read", now: NOW } as const;

const ALICE = "700000000000000001";
const BEA = "700000000000000002";
const VIEWER = "700000000000000005";
// A remote author of private originals, for the disclosure cases.
const PRIVATE_AUTHOR = "700000000000000006";
// A suspended local account: its statuses are candidates the list rule hides by availability.
const GONE = "700000000000000007";

const OLDER = 30;
const NEWER = 5;

async function store(): Promise<StoreStub> {
  const s = await migratedStore();
  await runInDurableObject(s, (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec("INSERT INTO instance_settings (name, value) VALUES ('domain', 'kopje.test')");
    for (const [account, name] of [
      [ALICE, "alice"],
      [BEA, "bea"],
      [VIEWER, "viewer"],
    ] as const) {
      sql.exec(
        "INSERT INTO accounts (id, uri, username) VALUES (?, ?, ?)",
        account,
        `https://kopje.test/ap/users/${name}`,
        name,
      );
      sql.exec(
        "INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, ?, X'00', X'00', 'test')",
        account,
        `${name}@example.com`,
      );
    }
    sql.exec(
      "INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('walks', 'secret', 'walks', 'urn:ietf:wg:oauth:2.0:oob', 'read')",
    );
    sql.exec(
      "INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'walks', ?, 'read')",
      TOKEN,
      VIEWER,
    );
  });
  return s;
}

async function world(
  rejected: number,
  kinds: { accountKind?: AccountKind; tagKind?: TagKind } = {},
  matches = { older: OLDER, newer: NEWER },
): Promise<StoreStub> {
  const s = await store();
  await seedConditionWorld(s, { account: ALICE, local: BEA, rejected, ...matches, ...kinds });
  return s;
}

type Conditions = Partial<Pick<AccountStatusesInput, "onlyMedia" | "excludeReplies" | "excludeReblogs" | "tagged">>;
type TagConditions = Partial<Pick<TagTimelineInput, "any" | "all" | "none" | "local" | "remote" | "onlyMedia">>;

const accountInput =
  (c: Conditions, viewer: typeof credential | null = credential) =>
  (page: PageQuery) => ({
    credential: viewer,
    now: NOW,
    account: ALICE,
    page,
    onlyMedia: false,
    excludeReplies: false,
    excludeReblogs: false,
    pinned: false,
    tagged: null,
    present: PRESENT,
    ...c,
  });

const tagInput =
  (c: TagConditions, viewer: typeof credential | null = credential) =>
  (page: PageQuery) => ({
    credential: viewer,
    now: NOW,
    page,
    tag: "cats",
    any: [],
    all: [],
    none: [],
    local: false,
    remote: false,
    onlyMedia: false,
    present: PRESENT,
    ...c,
  });

type Reader = {
  name: string;
  operation: StoreOperation<never, unknown>;
  input: (page: PageQuery) => unknown;
  // The rejected rows the reader's world holds, and the matches it lists, newest first.
  tagKind: TagKind;
  expected: string[];
  // The section's bases: the cursor just below its newer matches, and its newest older match.
  newer: bigint;
  topOlder: string;
};

const accountReader = (name: string, c: Conditions): Reader => ({
  name,
  operation: accountStatuses,
  input: accountInput(c),
  tagKind: "remote",
  expected: accountMatches(OLDER, NEWER),
  newer: ACCOUNT_NEWER,
  topOlder: String(ACCOUNT_OLDER + BigInt(OLDER - 1)),
});

const tagReader = (name: string, c: TagConditions, tagKind: TagKind, by: "all" | "local" | "remote"): Reader => ({
  name,
  operation: tagTimeline,
  input: tagInput(c),
  tagKind,
  expected: tagMatches(OLDER, NEWER, by),
  newer: TAG_NEWER,
  topOlder: String(TAG_OLDER + BigInt(OLDER - 1)),
});

const READERS: Reader[] = [
  ...[false, true].flatMap((excludeReblogs) => [
    accountReader(`only_media${excludeReblogs ? " exclude_reblogs" : ""}`, { onlyMedia: true, excludeReblogs }),
    accountReader(`tagged${excludeReblogs ? " exclude_reblogs" : ""}`, { tagged: "rare", excludeReblogs }),
    accountReader(`exclude_replies${excludeReblogs ? " exclude_reblogs" : ""}`, {
      excludeReplies: true,
      excludeReblogs,
    }),
  ]),
  tagReader("hashtag local", { local: true }, "remote", "local"),
  tagReader("hashtag remote", { remote: true }, "local", "remote"),
  tagReader("hashtag only_media", { onlyMedia: true }, "remote", "all"),
  tagReader("hashtag all", { all: ["x"] }, "remote", "all"),
  tagReader("hashtag none", { none: ["y"] }, "remote", "all"),
];

function answerOf(output: unknown): Page<{ id: string }> {
  let value = output as Record<string, unknown>;
  while (value.status === "ok" && "value" in value) {
    value = value.value as Record<string, unknown>;
  }
  return value as unknown as Page<{ id: string }>;
}

async function read(s: StoreStub, operation: StoreOperation<never, unknown>, input: unknown) {
  return answerOf(await runInDurableObject(s, (_instance, state) => operation.run(state.storage.sql, input as never)));
}

// Every page by max_id from `start` (or by min_id), following the cursors the read answers while a page is full or
// cut: the ids in walk order, and how many pages were empty.
async function walk(s: StoreStub, r: Pick<Reader, "operation" | "input">, start: PageQuery) {
  const ascending = start.minId !== undefined;
  const seen: string[] = [];
  let empty = 0;
  let page = start;
  for (let requests = 0; ; requests++) {
    expect(requests).toBeLessThan(200);
    const answer = await read(s, r.operation, r.input(page));
    const items = answer.items.map((item) => item.id);
    seen.push(...(ascending ? items.toReversed() : items));
    empty += items.length === 0 ? 1 : 0;
    const cursor = ascending ? answer.newest : answer.oldest;
    if ((answer.cut !== true && items.length < page.limit) || cursor === null) {
      return { seen, empty };
    }
    page = ascending ? { limit: page.limit, minId: cursor } : { limit: page.limit, maxId: cursor };
  }
}

describe("reads with request conditions charge at most CONDITION_WALK entries (AC1, AC2, C1)", () => {
  // Each reader's pages with the rejected range in front: below max_id (with since_id too), and above min_id. With 100
  // rejected rows the walk reaches matches; with 5,000 and 20,000 the budget cuts it first, and it reads the same rows.
  it("reads the same rows with 5,000 or 20,000 rejected rows in front, and finds the matches behind 100", async () => {
    const worlds = new Map<string, StoreStub>();
    for (const tagKind of ["remote", "local"] as const) {
      for (const rejected of [100, 5_000, 20_000]) {
        worlds.set(`${tagKind} ${rejected}`, await world(rejected, { tagKind }));
      }
    }
    const differ: string[] = [];
    for (const r of READERS) {
      const pages: [string, PageQuery][] = [
        ["max_id", { ...PAGE, maxId: String(r.newer) }],
        ["since_id", { ...PAGE, maxId: String(r.newer), sinceId: "1" }],
        ["min_id", { ...PAGE, minId: r.topOlder }],
      ];
      for (const [label, page] of pages) {
        const name = `${r.name} ${label}`;
        const few = await read(worlds.get(`${r.tagKind} 100`)!, r.operation, r.input(page));
        expect([name, few.items.length > 0]).toEqual([name, true]);
        const rows: number[] = [];
        for (const rejected of [5_000, 20_000]) {
          const s = worlds.get(`${r.tagKind} ${rejected}`)!;
          const answer = await read(s, r.operation, r.input(page));
          expect([name, answer.items.length, answer.cut]).toEqual([name, 0, true]);
          rows.push(await rowsRead({ store: s }, r.operation, r.input(page) as never));
        }
        if (rows[0] !== rows[1]) {
          differ.push(`${name}: ${rows.join(" -> ")}`);
        }
      }
    }
    expect(differ).toEqual([]);
  }, 600_000);
});

type Recorded = { query: string; params: SqlStorageValue[]; rows: number };

// Runs `operation` over a SqlStorage that records every statement with its parameters and the rows it read.
async function recorded(s: StoreStub, operation: StoreOperation<never, unknown>, input: unknown) {
  return runInDurableObject(s, (_instance, state) => {
    const statements: Recorded[] = [];
    const real = state.storage.sql;
    const sql = {
      exec: (query: string, ...params: SqlStorageValue[]) => {
        const cursor = real.exec(query, ...params);
        const entry = { query, params, rows: 0 };
        statements.push(entry);
        return watchedCursor(cursor, () => (entry.rows += cursor.rowsRead));
      },
    } as unknown as SqlStorage;
    const output = operation.run(sql, input as never);
    return { output, statements };
  });
}

// The rows one statement reads with `params`.
async function rowsOf(s: StoreStub, query: string, params: SqlStorageValue[]): Promise<number> {
  return runInDurableObject(s, (_instance, state) => {
    const cursor = state.storage.sql.exec(query, ...params);
    cursor.toArray();
    return cursor.rowsRead;
  });
}

const ROUND = /INDEXED BY (?:statuses_account(?:_originals)?|status_tags_public)\b/;
const PASSING = /^SELECT s\.id FROM json_each\(\?1\) c/;
const RULE = /json_each\(\?3\) c CROSS JOIN/;

const walkRows = (statements: Recorded[]) =>
  statements.filter((st) => ROUND.test(st.query) || PASSING.test(st.query)).reduce((sum, st) => sum + st.rows, 0);

// A statement's cost as entry × n + overhead, from its rows at n = 1 and n = K, each run once.
const K = 100;
function slope(at1: number, atK: number) {
  const entry = (atK - at1) / (K - 1);
  return { entry, overhead: at1 - entry };
}

describe("a page's walk and rule read within a ceiling derived from its statements (C9)", () => {
  // Inputs at their caps: the API's largest page (40, so round 1 reads readWindow(40) = 120 or streamWindow(40) = 80 a
  // name), the budget filled (2,500 and 20,000 rejected rows behind the cursor, every one passing the audience rule),
  // CONDITION_WALK_ROUNDS rounds charged their overhead, and each rejected entry on its most expensive path. Account
  // statuses: a boost (audienceSql reads its original) for the round, and for the conditions a rejection by each of
  // only_media, tagged and exclude_replies alone, the costliest kept (the plan tests the reply column first, so a reply
  // skips both probes and one of the others runs them both, which the test asserts). The hashtag: five overlapping
  // names (the tag and any's four), so each status is charged five times; all four all names present, so every all
  // probe succeeds; none of four names, the last of which the row holds; media; and rejection by none or by the
  // author's domain. The rule is read once at readWindow(40) = 120 such candidates.
  it("charges a page at most entry cost × CONDITION_WALK + overhead × rounds + the rule read, at limit 40 with every name capped", async () => {
    type Fixture = {
      kinds: { accountKind?: AccountKind; tagKind?: TagKind };
      reader: Pick<Reader, "operation" | "input">;
    };
    const endpoints: {
      name: string;
      streams: number;
      fixtures: Fixture[];
      bare: Pick<Reader, "operation" | "input">;
    }[] = [
      {
        name: "account statuses",
        streams: 1,
        fixtures: (["boost", "reply", "untagged", "bare"] as const).map((accountKind) => ({
          kinds: { accountKind },
          reader: {
            operation: accountStatuses,
            input: accountInput({ onlyMedia: true, tagged: "rare", excludeReplies: true }),
          },
        })),
        bare: { operation: accountStatuses, input: accountInput({}) },
      },
      {
        name: "hashtag",
        streams: 1 + TAG_ANY.length,
        fixtures: (["none", "author"] as const).map((tagKind) => ({
          kinds: { tagKind },
          reader: {
            operation: tagTimeline,
            input: tagInput({
              any: TAG_ANY,
              all: TAG_ALL,
              none: ["z1", "z2", "z3", "y"],
              local: true,
              onlyMedia: true,
            }),
          },
        })),
        bare: { operation: tagTimeline, input: tagInput({ any: TAG_ANY }) },
      },
    ];
    for (const endpoint of endpoints) {
      let roundEntry = 0;
      let roundOverhead = 0;
      let conditionEntry = 0;
      let conditionOverhead = 0;
      let rule = 0;
      const conditionEntries: Record<string, number> = {};
      const pages: { name: string; rows: number[]; totals: number[] }[] = [];
      for (const fixture of endpoint.fixtures) {
        const rows: number[] = [];
        const totals: number[] = [];
        for (const rejected of [2_500, 20_000]) {
          const s = await world(rejected, fixture.kinds, { older: OLDER, newer: 0 });
          const page = { ...PAGE_MAX, maxId: String(endpoint.streams === 1 ? ACCOUNT_NEWER : TAG_NEWER) };
          const run = await recorded(s, fixture.reader.operation, fixture.reader.input(page));
          expect(answerOf(run.output)).toMatchObject({ items: [], cut: true });
          const rounds = run.statements.filter((st) => ROUND.test(st.query));
          expect(rounds.length).toBeLessThanOrEqual(CONDITION_WALK_ROUNDS);
          rows.push(walkRows(run.statements));
          totals.push(run.statements.reduce((sum, st) => sum + st.rows, 0));
          if (rejected === 20_000) {
            // One round statement at LIMIT 1 and K (?4), and one condition statement at 1 and K candidates (?1).
            const round = rounds[0]!;
            const at = (limit: number) => rowsOf(s, round.query, round.params.with(3, limit));
            const r = slope(await at(1), await at(K));
            roundEntry = Math.max(roundEntry, r.entry / endpoint.streams);
            roundOverhead = Math.max(roundOverhead, r.overhead);
            const candidatesOf = (st: Recorded) => JSON.parse(st.params[0] as string) as unknown[];
            const passing = run.statements
              .filter((st) => PASSING.test(st.query))
              .reduce((most, st) => (candidatesOf(st).length > candidatesOf(most).length ? st : most));
            const candidates = candidatesOf(passing);
            expect(candidates.length).toBeGreaterThanOrEqual(K);
            const of = (n: number) =>
              rowsOf(s, passing.query, passing.params.with(0, JSON.stringify(candidates.slice(0, n))));
            const c = slope(await of(1), await of(K));
            conditionEntry = Math.max(conditionEntry, c.entry);
            conditionOverhead = Math.max(conditionOverhead, c.overhead);
            conditionEntries[JSON.stringify(fixture.kinds)] = c.entry;
            // The rule statement of a read without conditions, run at readWindow(limit) of the rejected rows.
            const bare = await recorded(s, endpoint.bare.operation, endpoint.bare.input(page));
            const ruled = bare.statements.find((st) => RULE.test(st.query))!;
            const window = statusIds(endpoint.streams === 1 ? ACCOUNT_REJECTED : TAG_REJECTED, rejected)
              .slice(0, readWindow(PAGE_MAX.limit))
              .map((id) => ({ id, o: 0 }));
            rule = Math.max(rule, await rowsOf(s, ruled.query, ruled.params.with(2, JSON.stringify(window))));
          }
        }
        pages.push({ name: JSON.stringify(fixture.kinds), rows, totals });
      }
      const ceiling = Math.ceil(
        (roundEntry + conditionEntry) * CONDITION_WALK +
          (roundOverhead + conditionOverhead) * CONDITION_WALK_ROUNDS +
          rule,
      );
      if (endpoint.streams === 1) {
        // The reply check runs first: a reply costs less than a rejection that ran the probes.
        const probed = Math.max(
          conditionEntries['{"accountKind":"untagged"}']!,
          conditionEntries['{"accountKind":"bare"}']!,
        );
        expect(probed).toBeGreaterThan(conditionEntries['{"accountKind":"reply"}']!);
        expect(conditionEntry).toBe(probed);
      }
      for (const page of pages) {
        expect([endpoint.name, page.name, page.rows[1]]).toEqual([endpoint.name, page.name, page.rows[0]]);
        // Presentation and the rest: the same at both sizes.
        expect([endpoint.name, page.name, page.totals[1]]).toEqual([endpoint.name, page.name, page.totals[0]]);
        expect(page.rows[0]! + rule).toBeLessThanOrEqual(ceiling);
      }
    }
  }, 600_000);
});

// A world of statuses written row by row: at BASE + offset, by BEA (local) or `author`, public unless `hidden` says
// otherwise, with public rows of `names` and media when `media`.
type Row = {
  offset: number;
  author?: string;
  names?: string[];
  media?: boolean;
  hidden?: "private" | "boost" | "withdrawn";
};
const BASE = 200000000000000000n;
const ORIGINALS = 300000000000000000n;
const rowId = (offset: number) => String(BASE + BigInt(offset));

async function rowsWorld(rows: readonly Row[]): Promise<StoreStub> {
  const s = await store();
  await seedConditionWorld(s, { account: ALICE, local: BEA, rejected: 0, older: 0 });
  await runInDurableObject(s, (_instance, state) => {
    const sql = state.storage.sql;
    const at = new Date(NOW).toISOString();
    sql.exec(
      "INSERT INTO accounts (id, uri, username, domain) VALUES (?, 'https://far.example/users/p', 'p', 'far.example')",
      PRIVATE_AUTHOR,
    );
    sql.exec("INSERT INTO accounts (id, uri, username) VALUES (?, 'https://kopje.test/ap/users/gone', 'gone')", GONE);
    sql.exec(
      `INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey, suspended_at)
			VALUES (?, 'gone@example.com', X'00', X'00', 'test', ?)`,
      GONE,
      at,
    );
    for (const row of rows) {
      const id = rowId(row.offset);
      const author = row.author ?? BEA;
      if (row.hidden === "boost") {
        const original = String(ORIGINALS + BigInt(row.offset));
        sql.exec(
          `INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
					VALUES (?, ?, ?, 'private', '<p>p</p>', ?)`,
          original,
          `https://far.example/objects/${original}`,
          PRIVATE_AUTHOR,
          at,
        );
        sql.exec(
          `INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, reblog_of_id)
					VALUES (?, ?, ?, 'public', '', ?, ?)`,
          id,
          `https://kopje.test/objects/${id}`,
          author,
          at,
          original,
        );
      } else {
        sql.exec(
          `INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, withdrawn)
					VALUES (?, ?, ?, ?, '<p>s</p>', ?, ?)`,
          id,
          `https://kopje.test/objects/${id}`,
          author,
          row.hidden === "private" ? "private" : "public",
          at,
          row.hidden === "withdrawn" ? 1 : 0,
        );
      }
      for (const name of row.names ?? []) {
        sql.exec("INSERT INTO status_tags (status_id, name, public) VALUES (?, ?, 1)", id, name);
      }
      if (row.media === true) {
        sql.exec(
          "INSERT INTO media_attachments (id, account_id, status_id, type, url) VALUES (?, ?, ?, 'image', 'u')",
          String(950000000000000000n + BigInt(row.offset)),
          author,
          id,
        );
      }
    }
  });
  return s;
}

// A deterministic generator (mulberry32).
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const namesOf = (n: number) => Array.from({ length: n }, (_, k) => `m${k}`);
const mergedReader = (n: number): Pick<Reader, "operation" | "input"> => ({
  operation: tagTimeline,
  input: (page) => ({ ...tagInput({ local: true, any: namesOf(n).slice(1) }, null)(page), tag: namesOf(n)[0]! }),
});
const matchesOf = (rows: readonly Row[], ascending: boolean) =>
  rows
    .filter((row) => row.author === undefined && row.hidden === undefined)
    .map((row) => row.offset)
    .toSorted((a, b) => (ascending ? a - b : b - a))
    .map(rowId);

describe("a walk that rejects nothing answers as the read without conditions (AC5, C4)", () => {
  // Two names, limit 20 (a window of 60, 40 a name), every status local (local=true rejects none) and by a suspended
  // account, so the rule hides them all and the page is empty: only the window's cut decides its links.
  //   - exhausted, exactly 60: 30 a name, no stream fills, the union is the window;
  //   - exhausted, 62: 31 a name, the union passes the window;
  //   - truncated, exactly 60: walking down, the first name fills its 40 below the second's 20, with more of it below.
  //     Only downward: walking up, the first name fills at 40 below the second's rows, so round 1's window holds 40
  //     and the walk goes on to collect 60, where the read without conditions stops at its 40.
  const both = [PAGE, { ...PAGE, minId: "1" }];
  const cases: [string, Row[], PageQuery[]][] = [
    [
      "exhausted, exactly the window",
      Array.from({ length: 60 }, (_, i) => ({ offset: 100 + i, author: GONE, names: [i % 2 === 0 ? "m0" : "m1"] })),
      both,
    ],
    [
      "exhausted, past the window",
      Array.from({ length: 62 }, (_, i) => ({ offset: 100 + i, author: GONE, names: [i % 2 === 0 ? "m0" : "m1"] })),
      both,
    ],
    [
      "truncated, exactly the window",
      [
        ...Array.from({ length: 40 }, (_, i) => ({ offset: 1_000 + i, author: GONE, names: ["m0"] })),
        ...Array.from({ length: 20 }, (_, i) => ({ offset: 1_100 + i, author: GONE, names: ["m1"] })),
        ...Array.from({ length: 5 }, (_, i) => ({ offset: 100 + i, author: GONE, names: ["m0"] })),
      ],
      [PAGE],
    ],
  ];

  it.each(cases)(
    "%s: the same page, cut and cursors",
    async (_name, rows, pages) => {
      const s = await rowsWorld(rows);
      for (const page of pages) {
        const answer = async (local: boolean) =>
          read(s, tagTimeline, {
            ...tagInput({ local, any: ["m1"] }, null)(page),
            tag: "m0",
          });
        const bare = await answer(false);
        expect(bare.items).toEqual([]);
        expect(await answer(true)).toEqual(bare);
      }
    },
    120_000,
  );

  it("leaves the exhausted exact window uncut, with no cursor", async () => {
    const s = await rowsWorld(cases[0]![1]);
    const page = await read(s, tagTimeline, {
      ...tagInput({ local: true, any: ["m1"] }, null)(PAGE),
      tag: "m0",
    });
    expect(page).toMatchObject({ items: [], newest: null, oldest: null });
    expect(page.cut ?? false).toBe(false);
  }, 120_000);
});

describe("a merged walk loses no match at a round's merge frontier (AC10, C6)", () => {
  // Round 1's LIMIT is 40 a name (limit 20). The first name's stream fills at its 40th row, the frontier; the match
  // just past it in that stream is read only by the next round, and each other name's match just past the frontier
  // was read by round 1 and dropped from it. Their other rows are sparse, so their streams end farther, staggered.
  const frontier = (n: number, ascending: boolean): Row[] => {
    const at = (offset: number) => (ascending ? 20_000 - offset : offset);
    const names = namesOf(n);
    const rows: Row[] = [];
    for (let i = 0; i < 40; i++) {
      rows.push({ offset: at(10_000 - i), author: REMOTE, names: [names[0]!] });
    }
    rows.push({ offset: at(10_000 - 40), names: [names[0]!] });
    names.slice(1).forEach((name, k) => {
      rows.push({ offset: at(10_000 - 41 - k), names: [name] });
      for (let i = 0; i < 39; i++) {
        rows.push({ offset: at(10_000 - 100 - 50 * i - k), author: REMOTE, names: [name] });
      }
    });
    // Matches at the far end, behind every stream's rows.
    rows.push({ offset: at(10), names: [...names] }, { offset: at(5), names: [names[n - 1]!] });
    return rows;
  };

  it.each([2, 3, 4, 5])(
    "finds every match past the frontier with %i names, in both directions",
    async (n) => {
      for (const ascending of [false, true]) {
        const rows = frontier(n, ascending);
        const s = await rowsWorld(rows);
        const walked = await walk(s, mergedReader(n), ascending ? { ...PAGE, minId: "1" } : PAGE);
        expect([n, ascending, walked.seen]).toEqual([n, ascending, matchesOf(rows, ascending)]);
      }
    },
    120_000,
  );

  // Names whose streams overlap and end staggered: each status has a random nonempty set of names, a match one time
  // in eight, and gaps of 1 to 3 ids; 1,500 statuses, enough for the budget to cut walks on five names.
  it.each([2, 3, 4, 5])(
    "finds every match once, in order, over %i overlapping names",
    async (n) => {
      const next = random(20261111 + n);
      const rows: Row[] = [];
      let offset = 100;
      for (let i = 0; i < 1_500; i++) {
        offset += 1 + Math.floor(next() * 3);
        const names = namesOf(n).filter(() => next() < 0.5);
        rows.push({
          offset,
          names: names.length === 0 ? [namesOf(n)[Math.floor(next() * n)]!] : names,
          ...(next() < 0.125 ? {} : { author: REMOTE }),
        });
      }
      const s = await rowsWorld(rows);
      for (const ascending of [false, true]) {
        const walked = await walk(s, mergedReader(n), ascending ? { ...PAGE, minId: "1" } : PAGE);
        expect([n, ascending, walked.seen]).toEqual([n, ascending, matchesOf(rows, ascending)]);
      }
    },
    120_000,
  );
});

describe("a walk cut by the budget continues from an entry the viewer may see (AC3, AC4, C3)", () => {
  // Raw rows from offset 1 to TOTAL, each a rejected public row but for hidden ones (the account's private statuses
  // and its public boosts of others' private originals; for the hashtag, withdrawn public rows) placed at positions
  // counted from either end: next to the cursor (1), where each round of a walk counting raw rows would end at limit
  // 20 (the round LIMITs' running sums), and at 2,000 and 2,001. Matches lie in the middle. The continuation must be
  // the CONDITION_WALK-th row the audience rule passes from the cursor, never a hidden row.
  const TOTAL = 4_500;
  const MIDDLE = [2_240, 2_250, 2_260];
  const ends = (first: number) => {
    const positions = [1, 2_000, 2_001];
    let spent = 0;
    let per = first;
    while (spent < CONDITION_WALK) {
      spent += per;
      positions.push(spent);
      per = Math.min(Math.max(first, spent), CONDITION_WALK - spent);
    }
    return [...new Set(positions)];
  };
  const cases = [
    {
      name: "account statuses only_media",
      first: readWindow(PAGE.limit),
      row: (offset: number): Row => ({ offset, author: ALICE, ...(MIDDLE.includes(offset) ? { media: true } : {}) }),
      hide: (row: Row, k: number): Row => ({ ...row, hidden: k % 2 === 0 ? "private" : "boost" }),
      reader: (viewer: typeof credential | null) => ({
        operation: accountStatuses as StoreOperation<never, unknown>,
        input: accountInput({ onlyMedia: true }, viewer),
      }),
      matches: (rows: Row[]) => rows.filter((row) => row.media === true),
    },
    {
      name: "hashtag local",
      first: streamWindow(PAGE.limit),
      row: (offset: number): Row => ({
        offset,
        names: ["cats"],
        ...(MIDDLE.includes(offset) ? {} : { author: REMOTE }),
      }),
      hide: (row: Row): Row => ({ ...row, author: BEA, hidden: "withdrawn" }),
      reader: (viewer: typeof credential | null) => ({
        operation: tagTimeline as StoreOperation<never, unknown>,
        input: tagInput({ local: true }, viewer),
      }),
      matches: (rows: Row[]) => rows.filter((row) => MIDDLE.includes(row.offset)),
    },
  ];

  it.each(cases)(
    "$name: places no hidden id in the page or its cursors, in either direction",
    async (c) => {
      const positions = ends(c.first);
      const hiddenOffsets = new Set(positions.flatMap((p) => [TOTAL + 1 - p, p]));
      let k = 0;
      const rows = Array.from({ length: TOTAL }, (_, i) => {
        const row = c.row(i + 1);
        return hiddenOffsets.has(row.offset) ? c.hide(row, k++) : row;
      });
      const hidden = new Set(rows.filter((row) => row.hidden !== undefined).map((row) => rowId(row.offset)));
      expect(hidden.size).toBe(2 * positions.length);
      const s = await rowsWorld(rows);
      for (const viewer of [null, credential]) {
        for (const ascending of [false, true]) {
          const label = `${viewer === null ? "anonymous" : "viewer"} ${ascending ? "min_id" : "max_id"}`;
          // The CONDITION_WALK-th row from the cursor that is not hidden.
          const order = ascending ? rows : rows.toReversed();
          const end = rowId(order.filter((row) => row.hidden === undefined)[CONDITION_WALK - 1]!.offset);
          const r = c.reader(viewer);
          const start = ascending ? { ...PAGE, minId: "1" } : PAGE;
          const first = await read(s, r.operation, r.input(start));
          expect([label, first.items, first.cut, ascending ? first.newest : first.oldest]).toEqual([
            label,
            [],
            true,
            end,
          ]);
          const leaked: string[] = [];
          const seen: string[] = [];
          let page: PageQuery = start;
          for (let requests = 0; requests < 10; requests++) {
            const answer = await read(s, r.operation, r.input(page));
            leaked.push(...(JSON.stringify(answer).match(/\d{18}/g) ?? []).filter((id) => hidden.has(id)));
            seen.push(...answer.items.map((item) => item.id));
            const cursor = ascending ? answer.newest : answer.oldest;
            if ((answer.cut !== true && answer.items.length < PAGE.limit) || cursor === null) {
              break;
            }
            page = ascending ? { ...PAGE, minId: cursor } : { ...PAGE, maxId: cursor };
          }
          expect([label, leaked]).toEqual([label, []]);
          expect([label, seen.toSorted()]).toEqual([label, c.matches(rows).map((row) => rowId(row.offset))]);
        }
      }
    },
    120_000,
  );
});

describe("a read without request conditions runs one round (AC6, C7)", () => {
  it("reads one window statement and no condition statement", async () => {
    const s = await world(5_000);
    for (const r of [
      { operation: accountStatuses as StoreOperation<never, unknown>, input: accountInput({}) },
      { operation: accountStatuses as StoreOperation<never, unknown>, input: accountInput({ excludeReblogs: true }) },
      { operation: tagTimeline as StoreOperation<never, unknown>, input: tagInput({ any: TAG_ANY }) },
    ]) {
      const run = await recorded(s, r.operation, r.input(PAGE));
      expect(run.statements.filter((st) => ROUND.test(st.query)).length).toBe(1);
      expect(run.statements.filter((st) => PASSING.test(st.query)).length).toBe(0);
      expect(answerOf(run.output).items.length).toBe(PAGE.limit);
    }
  }, 120_000);
});

describe("account statuses with conditions seek their pinned indexes with stale statistics (AC7, C8)", () => {
  it.each([false, true])(
    "exclude_reblogs %s: scans no table and reads the same rows after growth",
    async (off) => {
      const s = await world(3, {}, { older: OLDER, newer: 0 });
      const page = { ...PAGE, maxId: String(ACCOUNT_NEWER) };
      const witness = await staleWalk(
        { store: s },
        { account: ALICE, tag: "cats" },
        off ? /USING INDEX statuses_account_originals / : /USING INDEX statuses_account /,
        accountStatuses,
        accountInput({ onlyMedia: true, tagged: "rare", excludeReplies: true, excludeReblogs: off })(page),
      );
      expect(witness.scans).toEqual([]);
      expect(witness.indexed).toEqual([true, true]);
      expect(witness.after).toBe(witness.before);
    },
    120_000,
  );
});
