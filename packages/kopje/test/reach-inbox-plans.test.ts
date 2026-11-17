import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import {
  type OutboundKind,
  REACH_INBOX_BYTES,
  recipientsFor,
  stagedFollowers,
  stagedVoters,
} from "../src/domain/audience";
import { TARGET_CHUNK_BYTES } from "../src/domain/deliveries";
import { NOW } from "./app-helpers";
import { migratedStore } from "./helpers";
import {
  type Baseline,
  expectBeside,
  expectGrowth,
  PlanWitness,
  type Run,
  STATISTICS,
  type Statistics,
} from "./plan-witness";
import { explainPlan, type SqlRow } from "./read-helpers";
import { normalized } from "./sql-text";

// RES-7 witness of the followers' and voters' readers beside main's statements (#1733, test/plan-witness.ts): their
// inbox is now judged in SQL (audience.ts reachInboxSql), and nothing else in them changed. main's statements are their
// literal baselines, each by its audited identity: recipientsFor's followers and voters for a content, an other and a
// retraction activity, and the staged readers (stagedFollowers from the start and from a cursor, stagedVoters) for the
// same three, which bound their inbox by TARGET_CHUNK_BYTES on main (its ?5). Each rewrite is main's statement with its
// inbox projection replaced, and returns main's rows once each side's rows are read as their callers read them: an
// inbox outside the rule is no target (main's value, which targetsOf later dropped only past its chunk bound; the
// rewrite's NULL, dropped by targetsOf as before). Each reads as many rows as main's under the plan audit's singleton
// statistics and after ANALYZE, by main's plan. The populations grow apart, each counted by its own predicate: alice's
// followers and her poll's voters (the readers' own keys, read once per row by the whole readers, so linear, and flat
// for the staged pages, which read a LIMIT), and the followers of the accounts on either side of her id and the voters
// of the polls on either side of her poll's (flat for every reader). The world holds 35 followers at one inbox of
// REACH_INBOX_BYTES bytes on 18 hosts (both provenance overflows at the largest inbox the rule admits) and an import's
// inboxes outside the rule (past it, a NUL inside, a BLOB, empty, none), among her followers and voters. The addressed
// reader recipientsFor also runs is allowed literally, by its count; any further statement fails the witness.

const ALICE = "600000000000000001";
const LOW = "500000000000000001";
const HIGH = "700000000000000001";
const POLL = "600000000000000100";
const LOW_POLL = "500000000000000100";
const HIGH_POLL = "700000000000000100";
const PAGE = 10;

// main's statements, as test text: the host of an actor URI, the policy a content activity's followers and addressed
// accounts pass (domain/audience.ts leavesOutSql), and each reader around an inbox projection.
const host = (t: string) =>
  `rtrim(lower(substr(substr(substr(${t}.uri, instr(${t}.uri, '://') + 3), 1, instr(substr(${t}.uri, instr(${t}.uri, '://') + 3) || '/', '/') - 1), 1, instr(substr(substr(${t}.uri, instr(${t}.uri, '://') + 3), 1, instr(substr(${t}.uri, instr(${t}.uri, '://') + 3) || '/', '/') - 1) || ':', ':') - 1)), '.')`;
const UNAVAILABLE = `NOT (NOT EXISTS (SELECT 1 FROM main.local_accounts pl WHERE pl.account_id = a.id AND pl.suspended_at IS NOT NULL UNION ALL SELECT 1 FROM main.accounts pa INDEXED BY accounts_deleted WHERE pa.id = a.id AND pa.deleted_at IS NOT NULL UNION ALL SELECT 1 FROM main.accounts ps INDEXED BY accounts_suspended WHERE ps.id = a.id AND (ps.suspended_at IS NOT NULL AND ps.suspension_source = 'account')) AND NOT (CASE WHEN EXISTS (SELECT 1 FROM main.instance_domain_blocks INDEXED BY instance_domain_blocks_suspend WHERE severity = 'suspend') THEN EXISTS (WITH RECURSIVE pk(d) AS (SELECT DISTINCT CASE pv.n WHEN 1 THEN rtrim(pc.domain, '.') ELSE ${host("pc")} END FROM main.accounts pc INDEXED BY sqlite_autoindex_accounts_1 CROSS JOIN (SELECT 1 AS n UNION ALL SELECT 2) pv WHERE pc.domain IS NOT NULL AND pc.id = a.id), ps(d, dots) AS (SELECT CASE WHEN length(CAST(d AS BLOB)) <= 1012 THEN d END, CASE WHEN length(CAST(d AS BLOB)) <= 1012 THEN length(d) - length(replace(d, '.', '')) ELSE -1 END FROM pk UNION ALL SELECT substr(d, instr(d, '.') + 1), dots - 1 FROM ps WHERE dots > 1 AND NOT EXISTS (SELECT 1 FROM main.instance_domain_blocks pn INDEXED BY sqlite_autoindex_instance_domain_blocks_1 WHERE ps.dots BETWEEN 1 AND 7 AND pn.domain = ps.d)) SELECT 1 FROM ps LEFT JOIN main.instance_domain_blocks pr INDEXED BY sqlite_autoindex_instance_domain_blocks_1 ON ps.dots BETWEEN 1 AND 7 AND pr.domain = ps.d WHERE ps.dots < 0 OR (pr.domain IS NOT NULL AND pr.severity = 'suspend')) ELSE 0 END))`;
const domainBlocked = (p: string) =>
  `EXISTS (SELECT 1 FROM main.accounts pda INDEXED BY sqlite_autoindex_accounts_1 CROSS JOIN main.domain_blocks pdb ON pdb.account_id = ${p} AND (pda.domain IS NOT NULL AND pdb.domain IN (rtrim(pda.domain, '.'), ${host("pda")})) WHERE pda.id = a.id)`;
const FOLLOWER = `(${UNAVAILABLE} OR ${domainBlocked("?1")})`;
const ADDRESSED = `(${UNAVAILABLE} OR (EXISTS (SELECT 1 FROM main.blocks pb WHERE pb.account_id = ?2 AND pb.target_account_id = a.id) OR ${domainBlocked("?2")}))`;
const V = "COALESCE(NULLIF(a.shared_inbox_url, ''), a.inbox_url)";
const RULE = `CASE WHEN a.domain IS NOT NULL AND typeof(${V}) = 'text' AND length(CAST(${V} AS BLOB)) BETWEEN 1 AND ${REACH_INBOX_BYTES} AND instr(CAST(${V} AS BLOB), x'00') = 0 THEN ${V} END`;
const INBOX = { main: `${V} AS inbox`, mine: `${RULE} AS inbox` };
const STAGED = {
  main: `CASE WHEN typeof(${V}) = 'text' AND length(CAST(${V} AS BLOB)) <= ?5 THEN ${V} END AS inbox, CASE WHEN typeof(${V}) = 'text' THEN length(CAST(${V} AS BLOB)) END AS inbox_bytes`,
  mine: `${RULE} AS inbox, length(CAST(${RULE} AS BLOB)) AS inbox_bytes`,
};
const VISIBLE = "vs.visibility IN ('public', 'unlisted')";
const STAGED_VISIBLE = "ps.visibility IN ('public', 'unlisted')";
const byInbox = (inner: string) =>
  `SELECT id, host, inbox FROM ( SELECT id, host, inbox, row_number() OVER (PARTITION BY inbox ORDER BY id) AS pn, row_number() OVER (PARTITION BY inbox, host ORDER BY id) AS hn, dense_rank() OVER (PARTITION BY inbox ORDER BY host) AS hr FROM (${inner})) WHERE pn <= 17 OR (hn = 1 AND hr <= 17)`;
const followersSql = (policy: string, inbox: string) =>
  byInbox(
    `SELECT a.id, ${host("a")} AS host, ${inbox} FROM main.follows f INDEXED BY follows_target CROSS JOIN main.accounts a INDEXED BY sqlite_autoindex_accounts_1 ON a.id = f.account_id WHERE f.target_account_id = ?1 AND f.state = 'accepted' AND a.domain IS NOT NULL AND NOT ${policy}`,
  );
const votersSql = (visible: string, policy: string, inbox: string) =>
  byInbox(
    `SELECT DISTINCT a.id, ${host("a")} AS host, ${inbox} FROM main.statuses vs INDEXED BY sqlite_autoindex_statuses_1 CROSS JOIN main.polls pp INDEXED BY sqlite_autoindex_polls_1 ON pp.status_id = vs.id AND pp.removed = 0 CROSS JOIN main.poll_votes pv INDEXED BY sqlite_autoindex_poll_votes_1 ON pv.poll_id = pp.status_id AND pv.generation = pp.generation CROSS JOIN main.accounts a INDEXED BY sqlite_autoindex_accounts_1 ON a.id = pv.account_id WHERE vs.id = ?1 AND vs.account_id = ?2 AND ${visible} AND a.domain IS NOT NULL AND NOT ${policy}`,
  );
const addressedSql = (policy: string) =>
  `SELECT a.id, ${host("a")} AS host, a.uri, NULLIF(a.inbox_url, '') AS inbox_url, NULLIF(a.shared_inbox_url, '') AS shared_inbox_url FROM main.accounts a WHERE a.id IN (SELECT value FROM json_each(?1)) AND a.domain IS NOT NULL AND NOT ${policy} ORDER BY a.id`;
const stagedVotersSql = (visible: string, policy: string, inbox: string) =>
  `SELECT w.account_id AS key, CASE WHEN a.domain IS NOT NULL AND NOT ${policy} THEN a.id END AS id, ${inbox} FROM (SELECT v.account_id FROM main.statuses ps INDEXED BY sqlite_autoindex_statuses_1 CROSS JOIN main.polls pp INDEXED BY sqlite_autoindex_polls_1 ON pp.status_id = ps.id CROSS JOIN main.poll_votes v INDEXED BY sqlite_autoindex_poll_votes_1 ON v.poll_id = pp.status_id AND v.generation = pp.generation WHERE ps.id = ?1 AND ps.account_id = ?2 AND pp.removed = 0 AND ${visible} AND v.account_id > ?3 ORDER BY v.account_id LIMIT ?4) w LEFT JOIN main.accounts a INDEXED BY sqlite_autoindex_accounts_1 ON a.id = w.account_id ORDER BY w.account_id`;
const stagedFollowersSql = (from: ">=" | ">", policy: string, inbox: string) =>
  `SELECT CAST(w.id AS TEXT) AS key, CASE WHEN a.domain IS NOT NULL AND NOT ${policy} THEN a.id END AS id, ${inbox} FROM (SELECT f.id, f.account_id FROM main.follows f INDEXED BY follows_target WHERE f.target_account_id = ?1 AND f.state = 'accepted' AND f.id ${from} CAST(?2 AS INTEGER) AND f.id <= CAST(?3 AS INTEGER) ORDER BY f.id LIMIT ?4) w LEFT JOIN main.accounts a INDEXED BY sqlite_autoindex_accounts_1 ON a.id = w.account_id ORDER BY w.id`;

// An inbox main's caller would send to and the rule admits: TEXT of 1 to REACH_INBOX_BYTES UTF-8 bytes without NUL.
// The world holds no malformed UTF-8 within the bound (whose decoded length is not its raw length; RA1 covers it).
const admitted = (inbox: SqlStorageValue) =>
  typeof inbox === "string" &&
  inbox.length > 0 &&
  !inbox.includes("\0") &&
  new TextEncoder().encode(inbox).length <= REACH_INBOX_BYTES;
const set = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).toSorted();

// A whole reader's rows as targetsOf reads them: main's within the rule, the rewrite's with an inbox.
const whole = {
  main: (rows: SqlRow[]) => set(rows.filter((row) => admitted(row.inbox!))),
  mine: (rows: SqlRow[]) => set(rows.filter((row) => row.inbox !== null)),
};
// A staged page's rows as gather reads them: every row (its key is the cursor), an inbox outside the rule none.
const staged = {
  main: (rows: SqlRow[]) =>
    rows.map((row) => (admitted(row.inbox!) ? row : { ...row, inbox: null, inbox_bytes: null })),
  mine: (rows: SqlRow[]) => rows,
};
const wholeOf = (main: string, mine: string): Baseline => ({ sql: main, text: mine, result: whole });
const stagedOf = (main: string, mine: string): Baseline => ({
  sql: main,
  text: mine,
  result: staged,
  params: (params) => [...params, TARGET_CHUNK_BYTES],
});

const ID = {
  followersContent: "f51569b711149874",
  followersOther: "e9a28896ae9fc306",
  votersContent: "5b649a02c2ddf9a6",
  votersOther: "6f94fcb19360f667",
  votersRetraction: "7266d4c488291999",
  stagedVotersContent: "48af031dc6a8aaf7",
  stagedVotersOther: "789d75a33beca975",
  stagedVotersRetraction: "5e19eace6ac0b55d",
  stagedFollowersContent: "aaac84da8cf75ac5",
  stagedFollowersContentAfter: "847a7fff8cbf2c8d",
  stagedFollowersOther: "94636244834f3fb4",
  stagedFollowersOtherAfter: "88aec372a63b8a2b",
} as const;

const WITNESS = new PlanWitness(
  {
    [ID.followersContent]: wholeOf(followersSql(FOLLOWER, INBOX.main), followersSql(FOLLOWER, INBOX.mine)),
    [ID.followersOther]: wholeOf(followersSql("0", INBOX.main), followersSql("0", INBOX.mine)),
    [ID.votersContent]: wholeOf(votersSql(VISIBLE, ADDRESSED, INBOX.main), votersSql(VISIBLE, ADDRESSED, INBOX.mine)),
    [ID.votersOther]: wholeOf(votersSql(VISIBLE, "0", INBOX.main), votersSql(VISIBLE, "0", INBOX.mine)),
    [ID.votersRetraction]: wholeOf(votersSql("1", "0", INBOX.main), votersSql("1", "0", INBOX.mine)),
    [ID.stagedVotersContent]: stagedOf(
      stagedVotersSql(STAGED_VISIBLE, ADDRESSED, STAGED.main),
      stagedVotersSql(STAGED_VISIBLE, ADDRESSED, STAGED.mine),
    ),
    [ID.stagedVotersOther]: stagedOf(
      stagedVotersSql(STAGED_VISIBLE, "0", STAGED.main),
      stagedVotersSql(STAGED_VISIBLE, "0", STAGED.mine),
    ),
    [ID.stagedVotersRetraction]: stagedOf(
      stagedVotersSql("1", "0", STAGED.main),
      stagedVotersSql("1", "0", STAGED.mine),
    ),
    [ID.stagedFollowersContent]: stagedOf(
      stagedFollowersSql(">=", FOLLOWER, STAGED.main),
      stagedFollowersSql(">=", FOLLOWER, STAGED.mine),
    ),
    [ID.stagedFollowersContentAfter]: stagedOf(
      stagedFollowersSql(">", FOLLOWER, STAGED.main),
      stagedFollowersSql(">", FOLLOWER, STAGED.mine),
    ),
    [ID.stagedFollowersOther]: stagedOf(
      stagedFollowersSql(">=", "0", STAGED.main),
      stagedFollowersSql(">=", "0", STAGED.mine),
    ),
    [ID.stagedFollowersOtherAfter]: stagedOf(
      stagedFollowersSql(">", "0", STAGED.main),
      stagedFollowersSql(">", "0", STAGED.mine),
    ),
  },
  /PARTITION BY inbox|AS inbox_bytes/,
  { [addressedSql(ADDRESSED)]: 1, [addressedSql("0")]: 2 },
);

// The flow: recipientsFor and the staged readers for each kind, in the order expected.
const ACTIVITIES: Record<OutboundKind, Record<string, unknown>> = {
  content: { type: "Update", object: { type: "Question" } },
  other: { type: "Update", object: { type: "Person", id: "https://kopje.test/ap/users/alice" } },
  retraction: { type: "Delete", object: "https://kopje.test/ap/o/1" },
};
const EXPECTED = [
  ID.followersContent,
  ID.votersContent,
  ID.followersOther,
  ID.votersOther,
  ID.followersOther,
  ID.votersRetraction,
  ID.stagedVotersContent,
  ID.stagedFollowersContent,
  ID.stagedFollowersContentAfter,
  ID.stagedVotersOther,
  ID.stagedFollowersOther,
  ID.stagedFollowersOtherAfter,
  ID.stagedVotersRetraction,
  ID.stagedFollowersOther,
  ID.stagedFollowersOtherAfter,
];

type Cursors = { bound: string; after: string };

function flow(sql: SqlStorage, cursors: Cursors): unknown {
  const db = new Db(sql);
  const out: unknown[] = [];
  for (const activity of Object.values(ACTIVITIES)) {
    out.push(recipientsFor(db, ALICE, activity, { followers: true, accounts: [], pollVoters: POLL }));
  }
  for (const kind of Object.keys(ACTIVITIES) as OutboundKind[]) {
    out.push([...stagedVoters(db, kind, ALICE, POLL, "", PAGE)]);
    out.push([...stagedFollowers(db, kind, ALICE, null, cursors.bound, PAGE)]);
    out.push([...stagedFollowers(db, kind, ALICE, cursors.after, cursors.bound, PAGE)]);
  }
  return out;
}

type Shape = { own: number; others: number; voters: number; otherVoters: number };
const BASE: Shape = { own: 40, others: 40, voters: 40, otherVoters: 40 };

function local(sql: SqlStorage, id: string, name: string) {
  sql.exec(
    "INSERT INTO accounts (id, uri, username) VALUES (?, ?, ?)",
    id,
    `https://kopje.test/ap/users/${name}`,
    name,
  );
  sql.exec(
    "INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, ?, X'00', X'00', 'k')",
    id,
    `${name}@example.com`,
  );
}

function remote(sql: SqlStorage, id: bigint, host: string, shared: string | null) {
  sql.exec(
    `INSERT INTO accounts (id, uri, username, domain, inbox_url, shared_inbox_url)
		VALUES (?1, 'https://' || ?2 || '/users/u' || ?1, 'u' || ?1, ?2, 'https://' || ?2 || '/users/u' || ?1 || '/inbox', ?3)`,
    String(id),
    host,
    shared,
  );
  return String(id);
}

function poll(sql: SqlStorage, id: string, account: string) {
  sql.exec(
    "INSERT INTO statuses (id, uri, account_id, visibility, published_at) VALUES (?, ?, ?, 'public', ?)",
    id,
    `https://kopje.test/ap/o/${id}`,
    account,
    new Date(NOW).toISOString(),
  );
  sql.exec("INSERT INTO polls (status_id, options, tallies) VALUES (?, '[\"x\",\"y\"]', '[0,0]')", id);
}

const follow = (sql: SqlStorage, account: string, target: string) =>
  sql.exec(
    "INSERT INTO follows (account_id, target_account_id, state, created_at) VALUES (?, ?, 'accepted', ?)",
    account,
    target,
    new Date(NOW).toISOString(),
  );
const vote = (sql: SqlStorage, pollId: string, account: string, choice: number) =>
  sql.exec("INSERT INTO poll_votes (poll_id, account_id, choice) VALUES (?, ?, ?)", pollId, account, choice);

// A deliverable https inbox of exactly `bytes` UTF-8 bytes on `host`.
const sized = (host: string, bytes: number) => `https://${host}/` + "a".repeat(bytes - `https://${host}/`.length);

// The world of `shape` (the header's), returning the staged followers' cursors: alice's highest follow id and her
// fifth.
function shaped(sql: SqlStorage, shape: Shape): Cursors {
  local(sql, LOW, "low");
  local(sql, ALICE, "alice");
  local(sql, HIGH, "high");
  poll(sql, LOW_POLL, LOW);
  poll(sql, POLL, ALICE);
  poll(sql, HIGH_POLL, HIGH);
  // A suspended instance and a domain alice blocks, neither of any follower's, so the policy walks each host.
  sql.exec(
    "INSERT INTO instance_domain_blocks (domain, severity, created_at, updated_at) VALUES ('suspended.example', 'suspend', ?1, ?1)",
    new Date(NOW).toISOString(),
  );
  sql.exec("INSERT INTO domain_blocks (account_id, domain) VALUES (?, 'blocked.example')", ALICE);
  const max = sized("max.example", REACH_INBOX_BYTES);
  for (let i = 0; i < 35; i++) {
    const id = remote(sql, 610000000000000000n + BigInt(i), `h${Math.min(Math.floor(i / 2), 17)}.example`, max);
    follow(sql, id, ALICE);
    if (i < 20) {
      vote(sql, POLL, id, i % 2);
    }
  }
  const outside: [string, SqlStorageValue[]][] = [
    ["shared_inbox_url = ?", [sized("over.example", REACH_INBOX_BYTES + 1)]],
    ["shared_inbox_url = ? || char(0) || 'box'", ["https://nul.example/in"]],
    ["shared_inbox_url = CAST(? AS BLOB)", ["https://blob.example/inbox"]],
    ["shared_inbox_url = '', inbox_url = ''", []],
    ["shared_inbox_url = NULL, inbox_url = NULL", []],
  ];
  for (const [i, [assign, params]] of outside.entries()) {
    const id = remote(sql, 611000000000000000n + BigInt(i), `x${i}.example`, null);
    sql.exec(`UPDATE accounts SET ${assign} WHERE id = ?`, ...params, id);
    follow(sql, id, ALICE);
    vote(sql, POLL, id, 0);
  }
  for (let i = 0; i < shape.own; i++) {
    follow(
      sql,
      remote(sql, 620000000000000000n + BigInt(i), `f${i % 7}.example`, `https://f${i % 7}.example/inbox`),
      ALICE,
    );
  }
  for (let i = 0; i < shape.others; i++) {
    const id = remote(sql, 630000000000000000n + BigInt(i), `o${i % 7}.example`, `https://o${i % 7}.example/inbox`);
    follow(sql, id, i % 2 === 0 ? LOW : HIGH);
  }
  for (let i = 0; i < shape.voters; i++) {
    vote(sql, POLL, remote(sql, 640000000000000000n + BigInt(i), `v${i % 7}.example`, null), i % 2);
  }
  for (let i = 0; i < shape.otherVoters; i++) {
    const id = remote(sql, 650000000000000000n + BigInt(i), `w${i % 7}.example`, null);
    vote(sql, i % 2 === 0 ? LOW_POLL : HIGH_POLL, id, 0);
  }
  const ids = sql
    .exec<{ key: string }>(
      "SELECT CAST(id AS TEXT) AS key FROM follows WHERE target_account_id = ? ORDER BY follows.id",
      ALICE,
    )
    .toArray()
    .map((row) => row.key);
  return { bound: ids.at(-1)!, after: ids[4]! };
}

const POPULATIONS = {
  own: `SELECT count(*) AS n FROM follows WHERE target_account_id = '${ALICE}'`,
  others: `SELECT count(*) AS n FROM follows WHERE target_account_id IN ('${LOW}', '${HIGH}')`,
  voters: `SELECT count(*) AS n FROM poll_votes WHERE poll_id = '${POLL}'`,
  otherVoters: `SELECT count(*) AS n FROM poll_votes WHERE poll_id IN ('${LOW_POLL}', '${HIGH_POLL}')`,
};

// Each rewrite's plan beside main's statement's, both explained with the parameters the flow gave them.
type Plans = { id: string; mine: string; main: string }[];

async function measured(statistics: Statistics, shape: Shape): Promise<{ run: Run; plans: Plans }> {
  const store = await migratedStore();
  return runInDurableObject(store, (_instance, state) => {
    const cursors = shaped(state.storage.sql, shape);
    const run = WITNESS.measure(state, {
      statistics,
      expected: EXPECTED,
      populations: POPULATIONS,
      run: (sql) => flow(sql, cursors),
    });
    const real = state.storage.sql;
    const seen: { query: string; params: SqlStorageValue[] }[] = [];
    flow(
      {
        exec: (query: string, ...params: SqlStorageValue[]) => {
          seen.push({ query, params });
          return real.exec(query, ...params);
        },
      } as unknown as SqlStorage,
      cursors,
    );
    const plans = seen.flatMap(({ query, params }) => {
      const kind = WITNESS.kindOf(normalized(query));
      if (kind === undefined || kind.main) {
        return [];
      }
      const baseline = WITNESS.baselines[kind.id]!;
      return [
        {
          id: kind.id,
          mine: explainPlan(real, query, ...params),
          main: explainPlan(real, baseline.sql, ...(baseline.params?.(params) ?? params)),
        },
      ];
    });
    return { run, plans };
  });
}

// The rows each whole reader reads per row its own population gains, main's statement's and the rewrite's alike (main's
// plan): a follower's follows_target entry and account, the window's sort, and for a content activity the policy's
// lookups of its account (local_accounts, the deleted and suspended indexes, its host's walk through the suspended
// instances, alice's domain blocks; a voter's alice's blocks too); a voter's poll_votes entry and account, and the
// DISTINCT.
const WALKS: Readonly<Record<string, number>> = {
  [ID.followersContent]: 18,
  [ID.followersOther]: 11,
  [ID.votersContent]: 21,
  [ID.votersOther]: 14,
  [ID.votersRetraction]: 14,
};
// The staged readers read a page (LIMIT), as many rows as main's.
const STAGED_IDS: ReadonlySet<string> = new Set(
  Object.values(ID).filter((id) => WITNESS.baselines[id]!.result === staged),
);

const GROWTHS: Record<string, { shape: Shape; population: keyof typeof POPULATIONS; walks: readonly string[] }> = {
  "alice's followers": {
    shape: { ...BASE, own: 400 },
    population: "own",
    walks: [ID.followersContent, ID.followersOther],
  },
  "the followers of the accounts on either side": { shape: { ...BASE, others: 400 }, population: "others", walks: [] },
  "her poll's voters": {
    shape: { ...BASE, voters: 400 },
    population: "voters",
    walks: [ID.votersContent, ID.votersOther, ID.votersRetraction],
  },
  "the voters of the polls on either side": {
    shape: { ...BASE, otherVoters: 400 },
    population: "otherVoters",
    walks: [],
  },
};

describe("followers' and voters' readers beside main's (#1733, RES-7)", () => {
  it("is main's audited statements", async () => {
    await WITNESS.expectAudited();
  });

  it.each(STATISTICS)("%s statistics: main's rows, as many rows read, by main's plan", async (statistics) => {
    const { run, plans } = await measured(statistics, BASE);
    expectBeside(statistics, run, { singletonRows: true });
    expect(STAGED_IDS.size).toBe(7);
    for (const side of run.sides.filter((side) => STAGED_IDS.has(side.id))) {
      expect(side.mine.rows, side.id).toBe(side.main.rows);
    }
    expect(plans.map((plan) => plan.id)).toEqual(EXPECTED);
    for (const plan of plans) {
      expect(plan.mine, plan.id).toBe(plan.main);
    }
  });

  it.each(STATISTICS.flatMap((statistics) => Object.keys(GROWTHS).map((name) => [statistics, name] as const)))(
    "%s statistics: %s grow",
    async (statistics, name) => {
      const growth = GROWTHS[name]!;
      const base = (await measured(statistics, BASE)).run;
      const grown = (await measured(statistics, growth.shape)).run;
      expectBeside(statistics, grown, { singletonRows: true });
      expectGrowth(base, grown, {
        populations: [growth.population],
        perSide: Object.fromEntries(
          growth.walks.map((id) => [id, { population: growth.population, perRun: WALKS[id]! }]),
        ),
      });
      // Each rewrite grows as main's statement does beside it, and the whole readers by at least a row per row gained.
      for (const [i, side] of grown.sides.entries()) {
        const before = base.sides[i]!;
        expect(side.mine.rows - before.mine.rows, side.id).toBe(side.main.rows - before.main.rows);
      }
      const gained = growth.shape[growth.population] - BASE[growth.population];
      for (const id of growth.walks) {
        for (const [i, side] of grown.sides.entries()) {
          if (side.id === id) {
            expect(side.mine.rows - base.sides[i]!.mine.rows, `${id} reads its own key`).toBeGreaterThanOrEqual(gained);
          }
        }
      }
    },
  );
});

// What one inbox the rule admits may carry into the Worker (RES-2): at most REACH_INBOX_BYTES raw bytes, read as at
// most as many UTF-16 code units; re-encoded as UTF-8 at most three bytes each (a malformed byte decodes to U+FFFD),
// and as JSON at most six (a control character escapes as \u00XX), plus its quotes. Each ceiling is reached by an
// inbox of the bound's own size, so none is claimed below it: 0xFF bytes (malformed, admitted: TEXT without NUL),
// control characters, four-byte characters (two code units per four bytes) and ASCII. An inbox one byte past the
// bound, of each, is not read.
describe("an admitted inbox's size in the Worker (#1733, RES-2)", () => {
  it("is at most the bound's raw bytes, its UTF-16 units, three times as UTF-8 and six times as JSON", async () => {
    const store = await migratedStore();
    const read = await runInDurableObject(store, (_instance, state) => {
      const sql = state.storage.sql;
      local(sql, ALICE, "alice");
      const head = "https://big.example/";
      const room = REACH_INBOX_BYTES - head.length;
      // Each value of the bound's own size (extra 0) and one byte past it (extra 1), set as an import leaves it.
      const fill = (byte: number) => (extra: number) => new Uint8Array(room + extra).fill(byte).buffer;
      const tails: ((extra: number) => SqlStorageValue)[] = [
        fill(0xff),
        fill(0x01),
        (extra) => "\u{1F600}".repeat(room / 4) + "a".repeat(extra),
        (extra) => "a".repeat(room + extra),
      ];
      let n = 0;
      for (const extra of [0, 1]) {
        for (const tail of tails) {
          const id = remote(sql, 690000000000000000n + BigInt(n++), `b${n}.example`, null);
          sql.exec("UPDATE accounts SET shared_inbox_url = ? || CAST(? AS TEXT) WHERE id = ?", head, tail(extra), id);
          follow(sql, id, ALICE);
        }
      }
      const db = new Db(sql);
      const { followers } = recipientsFor(db, ALICE, ACTIVITIES.content, { followers: true, accounts: [] });
      return followers
        .filter((row) => row.inbox !== null)
        .map((row) => ({
          raw: db.first<{ n: number }>(
            "SELECT length(CAST(COALESCE(NULLIF(shared_inbox_url, ''), inbox_url) AS BLOB)) AS n FROM accounts WHERE id = ?",
            row.id,
          )!.n,
          units: row.inbox!.length,
          utf8: new TextEncoder().encode(row.inbox!).length,
          json: new TextEncoder().encode(JSON.stringify(row.inbox)).length,
        }));
    });
    expect(read).toHaveLength(4);
    const most = (key: keyof (typeof read)[number]) => Math.max(...read.map((row) => row[key]));
    expect(most("raw")).toBe(REACH_INBOX_BYTES);
    expect(most("units")).toBe(REACH_INBOX_BYTES);
    const head = "https://big.example/".length;
    expect(most("utf8")).toBe(head + 3 * (REACH_INBOX_BYTES - head));
    expect(most("json")).toBe(2 + head + 6 * (REACH_INBOX_BYTES - head));
    expect(most("utf8")).toBeLessThanOrEqual(3 * REACH_INBOX_BYTES);
    expect(most("json")).toBeLessThanOrEqual(2 + 6 * REACH_INBOX_BYTES);
  });
});
