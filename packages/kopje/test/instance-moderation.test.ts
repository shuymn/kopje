import { runInDurableObject } from "cloudflare:test";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { DeliveryOutcome } from "../src/domain/deliveries";
import type { InboundActivity } from "../src/domain/inbox";
import { MODERATION_ROUND_ROWS, REPORT_ROUND } from "../src/domain/moderation-bounds";
import type { RemoteActorInput } from "../src/domain/remote-actors";
import { CLEAR_ROUND, MARK_ACCOUNTS, remoteModerationRound, SEVER_ROUND } from "../src/domain/remote-suspension";
import { MODERATION_ROUNDS } from "../src/domain/suspension";
import type { StoreStub } from "../src/platform/store-client";
import { bearer, form, json, recountFollows, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { keptReject, net2Answer } from "./follow-exceptions";
import { type Body, type Inbound, type Intent, Peer } from "./follow-model";
import { BUILD } from "./helpers";
import { storeReceive, writtenBy } from "./inbox-store-helpers";
import {
  type Block,
  type Caps,
  type Document,
  inboxOf,
  type JobRow,
  ledgerCheck,
  type Local,
  LOCALS,
  pendingAt,
  ruleOf,
  type Remote,
  REMOTES,
  type RemoteState,
  settlementFailures,
  type Snapshot,
  type Source,
  WorldPolicy,
} from "./instance-moderation-model";
import { runs } from "./policy-world";
import { world as adminWorld } from "./remote-suspension-helpers";

// Model-based checks of instance domain blocks and remote suspension (R38, VIS-30; #1411, machine 3). Generated
// sequences of admin decisions, the moderation rounds that apply them, local actions, remote activity and delivery
// steps run through the production admin API, Store receive, moderation rounds and delivery operations. After every
// step the Store's projection and every answer must equal the world policy's (test/instance-moderation-model.ts), and
// each round is checked against the work ledger and the job's durable frontier. P1 compares a run with its twin whose
// rounds all run at settlement; P2 compares R1's follows of L1 both ways with machine 1's Mastodon v4.5.11 peer once
// settled, except where an accepted risk or a known defect names the difference.

const D = "d.example";
const SUB = "sub.d.example";
const OTHER = "other.example";
const DOMAINS = [D, SUB, OTHER] as const;
type Domain = (typeof DOMAINS)[number];

const OK: DeliveryOutcome = { kind: "delivered", status: 202 };
const CAPS: Caps = {
  rows: MODERATION_ROUND_ROWS,
  sever: SEVER_ROUND,
  mark: MARK_ACCOUNTS,
  clear: CLEAR_ROUND,
  reports: REPORT_ROUND,
  rounds: MODERATION_ROUNDS,
};
const SETTLE_ROUNDS = 400;

// The remote accounts (visibility.md: "covered by either key"): R1 and R2 under d.example by both keys, R3 on a host
// under d.example with the stored domain other.example (a confirmed address), R4 the control, R5 absent at the start.
const SPEC: Record<Remote, { id: string | null; uri: string; domain: string; shared: string | null }> = {
  R1: { id: "300000000000000001", uri: "https://d.example/users/r1", domain: D, shared: "https://d.example/inbox" },
  R2: { id: "300000000000000002", uri: "https://sub.d.example/users/r2", domain: SUB, shared: null },
  R3: { id: "300000000000000003", uri: "https://x.d.example/users/r3", domain: OTHER, shared: null },
  R4: { id: "300000000000000004", uri: "https://other.example/users/r4", domain: OTHER, shared: null },
  R5: { id: null, uri: "https://new.d.example/users/r5", domain: "new.d.example", shared: null },
};

// The seeded follows, each named `follower>target`: L1 follows R1, R3 and R4; R1, R2 and R4 follow L1; R1 and R2
// ask to follow locked L2.
const SEEDS = ["L1>R1", "L1>R3", "L1>R4", "R1>L1", "R2>L1", "R4>L1", "R1>L2", "R2>L2"] as const;
type Seed = { follows: boolean[]; list: boolean; pin: boolean; reports: [boolean, boolean] };

const seedArb: fc.Arbitrary<Seed> = fc.record({
  follows: fc.array(fc.constantFrom(true, true, false), { minLength: SEEDS.length, maxLength: SEEDS.length }),
  list: fc.boolean(),
  pin: fc.boolean(),
  reports: fc.tuple(fc.boolean(), fc.boolean()),
});

const ALL: Seed = { follows: SEEDS.map(() => true), list: true, pin: true, reports: [true, true] };

export type Stats = Record<string, number>;
const tally = (stats: Stats, key: string, n = 1) => {
  stats[key] = (stats[key] ?? 0) + n;
};

// ---------------------------------------------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------------------------------------------

type Attempt = {
  token: string;
  delivery: string;
  local: Local;
  remote: Remote;
  intent: Intent;
  phase: "claimed" | "confirmed" | "done";
  body: string | null;
  confirmedAt: number;
};

let sequence = 0;

async function setup(seed: Seed) {
  const base = await adminWorld();
  const store = base.h.store;
  const ids: Record<Local, string> = { L1: base.alice.id, L2: base.bob.id };
  const tokens: Record<Local, string> = { L1: base.alice.token, L2: base.bob.token };
  await sql(store, "UPDATE accounts SET locked = 1 WHERE id = ?", ids.L2);
  const localUris = Object.fromEntries(
    await Promise.all(
      LOCALS.map(async (l) => [
        l,
        (await sql<{ uri: string }>(store, "SELECT uri FROM accounts WHERE id = ?", ids[l]))[0]!.uri,
      ]),
    ),
  ) as Record<Local, string>;
  const remotes = {} as Record<Remote, RemoteState>;
  for (const r of REMOTES) {
    const spec = SPEC[r];
    remotes[r] = {
      stored: spec.id !== null,
      uri: spec.uri,
      domain: spec.domain,
      name: r,
      keys: [`${r}-key-0`],
      inbox: `${spec.uri}/inbox`,
      sharedInbox: spec.shared,
      source: null,
    };
    if (spec.id === null) {
      continue;
    }
    const username = r.toLowerCase();
    await sql(
      store,
      `INSERT INTO accounts (id, uri, username, domain, display_name, url, search_text, created_at, inbox_url,
				shared_inbox_url, document_revision, confirmed_username)
			VALUES (?1, ?2, ?3, ?4, ?5, ?2, ?3, ?6, ?7, ?8, 1, ?9)`,
      spec.id,
      spec.uri,
      username,
      spec.domain,
      r,
      new Date(NOW).toISOString(),
      `${spec.uri}/inbox`,
      spec.shared,
      new URL(spec.uri).hostname === spec.domain ? null : username,
    );
    await sql(
      store,
      "INSERT INTO remote_keys (key_id, account_id, pem, fetched_at) VALUES (?, ?, ?, ?)",
      `${spec.uri}#main-key`,
      spec.id,
      `${r}-key-0`,
      NOW,
    );
  }
  const policy = new WorldPolicy(remotes, localUris, ["L2"]);
  const w = {
    h: base.h,
    admin: base.admin,
    store,
    ids,
    tokens,
    localUris,
    remoteIds: Object.fromEntries(REMOTES.map((r) => [r, SPEC[r].id])) as Record<Remote, string | null>,
    policy,
    clock: NOW,
    step: 0,
    trace: [] as string[],
    stats: {} as Stats,
    blockIds: new Map<string, string>(),
    reportIds: new Map<string, string>(),
    listId: "",
    attempts: [] as Attempt[],
    // The inbox each intent was recorded for (by pair and seq), and the severing Rejects among them (G3F).
    inboxes: new Map<string, string>(),
    severingRejects: new Map<string, string | null>(),
    // Generations a round severed (P1), and the bodies confirmed (by pair).
    severedByRound: new Set<string>(),
    sent: [] as { local: Local; remote: Remote; type: string; ref: string | null }[],
    fences: new Map<string, JobRow>(),
    last: null as State | null,
    peer: null as Peer | null,
    // P2's records for the quiescence exceptions.
    receivedAt: new Map<string, number>(),
    undoReceivedAt: new Map<string, number>(),
    ignoredFollows: new Map<string, number>(),
    ignoredAccepts: new Set<string>(),
    droppedUnavailable: new Map<string, string>(),
    severedGens: new Set<string>(),
    lastFollow: null as string | null,
  };
  for (const [i, label] of SEEDS.entries()) {
    if (!seed.follows[i]) {
      continue;
    }
    const [follower, target] = label.split(">") as [string, string];
    const local = follower.startsWith("L");
    const l = (local ? follower : target) as Local;
    const r = (local ? target : follower) as Remote;
    const pending = l === "L2";
    const uri = local ? `${localUris[l]}#follows/seed-${r}` : `${SPEC[r].uri}#follows/seed-${l}`;
    await sql(
      store,
      "INSERT INTO follows (account_id, target_account_id, state, uri, created_at) VALUES (?, ?, ?, ?, ?)",
      local ? ids[l] : SPEC[r].id,
      local ? SPEC[r].id : ids[l],
      pending ? "pending" : "accepted",
      uri,
      new Date(NOW).toISOString(),
    );
    const pair = policy.pair(l, r);
    if (local) {
      pair.lr = { state: "accepted", uri };
    } else {
      pair.rl = { state: pending ? "pending" : "accepted", uri };
      const type = pending ? "follow_request" : "follow";
      pair.notifications.add(type);
      await sql(
        store,
        "INSERT INTO notifications (account_id, type, from_account_id, created_at) VALUES (?, ?, ?, ?)",
        ids[l],
        type,
        SPEC[r].id,
        new Date(NOW).toISOString(),
      );
    }
  }
  await recountFollows(store, ids.L1);
  await recountFollows(store, ids.L2);
  const list = await w.h.request("/api/v1/lists", bearer(tokens.L1, json({ title: "watched" })));
  w.listId = (await list.json<{ id: string }>()).id;
  if (seed.list && policy.pair("L1", "R1").lr !== null) {
    expect(await listAdd(w, "R1")).toBe(policy.listAdd("R1"));
  }
  if (seed.pin && policy.pair("L1", "R1").lr !== null) {
    expect(await pin(w, "R1")).toBe(policy.pin("R1"));
  }
  for (const [i, r] of (["R1", "R2"] as const).entries()) {
    if (seed.reports[i]) {
      expect(await report(w, r)).toBe(200);
    }
  }
  w.last = await read(w);
  return w;
}

type World = Awaited<ReturnType<typeof setup>>;

const log = (w: World, line: string) => {
  w.step++;
  w.trace.push(`${w.step} ${line}`);
};

const context = (w: World) => w.trace.join("\n");

const labelOf = (w: World, id: string): string | null => {
  for (const l of LOCALS) {
    if (w.ids[l] === id) {
      return l;
    }
  }
  for (const r of REMOTES) {
    if (w.remoteIds[r] === id) {
      return r;
    }
  }
  return null;
};

async function call(w: World, path: string, init: RequestInit, token: string) {
  const response = await w.h.request(path, bearer(token, init));
  const text = await response.text();
  return {
    status: response.status,
    body: text === "" ? null : (JSON.parse(text) as unknown),
    link: response.headers.get("Link"),
  };
}

async function listAdd(w: World, r: Remote): Promise<number> {
  return (await call(w, `/api/v1/lists/${w.listId}/accounts`, json({ account_ids: [w.remoteIds[r]] }), w.tokens.L1))
    .status;
}

async function pin(w: World, r: Remote): Promise<number> {
  return (await call(w, `/api/v1/accounts/${w.remoteIds[r]}/pin`, json({}), w.tokens.L1)).status;
}

async function report(w: World, r: Remote): Promise<number> {
  const label = `report ${++sequence}`;
  const answer = await call(w, "/api/v1/reports", json({ account_id: w.remoteIds[r] }), w.tokens.L1);
  const predicted = w.policy.report(r, label);
  expect(answer.status, context(w)).toBe(predicted);
  if (answer.status === 200) {
    w.reportIds.set((answer.body as { id: string }).id, label);
  }
  return answer.status;
}

// ---------------------------------------------------------------------------------------------------------------
// Reading the Store
// ---------------------------------------------------------------------------------------------------------------

type LaneRow = {
  type: string;
  ref: string | null;
  superseded: boolean;
  inbox: string;
  state: string;
  token: string | null;
};

async function read(w: { store: StoreStub; remoteIds: Record<Remote, string | null> }) {
  const remoteIds = new Set(Object.values(w.remoteIds).filter((id) => id !== null));
  return runInDurableObject(w.store, (_instance, state) => {
    const q = <T extends Record<string, SqlStorageValue>>(query: string, ...params: SqlStorageValue[]) =>
      state.storage.sql.exec<T>(query, ...params).toArray();
    const blocks = q<{
      domain: string;
      severity: string;
      reject_media: number;
      reject_reports: number;
      obfuscate: number;
    }>(
      "SELECT domain, severity, reject_media, reject_reports, obfuscate FROM instance_domain_blocks ORDER BY domain",
    ).map((b): Block => ({
      domain: b.domain,
      severity: b.severity as Block["severity"],
      rejectMedia: b.reject_media === 1,
      rejectReports: b.reject_reports === 1,
      obfuscate: b.obfuscate === 1,
    }));
    const remotes = q<{
      id: string;
      uri: string;
      domain: string;
      source: string | null;
      suspended: number;
      name: string;
      inbox: string;
      shared: string | null;
      revision: number | null;
    }>(
      `SELECT id, uri, domain, suspension_source AS source, suspended_at IS NOT NULL AS suspended, display_name AS name,
				inbox_url AS inbox, shared_inbox_url AS shared, document_revision AS revision
			FROM accounts WHERE domain IS NOT NULL ORDER BY id`,
    );
    const keys = q<{ account: string; pem: string }>("SELECT account_id AS account, pem FROM remote_keys ORDER BY pem");
    const jobs = q<{
      id: string;
      kind: "account" | "domain";
      subject: string;
      mode: "account" | "domain";
      phase: string;
      cursor: string;
      attempts: number;
      due: number | null;
      follow_bound: string;
      report_bound: string | null;
      action_bound: number | null;
    }>(
      `SELECT CAST(id AS TEXT) AS id, kind, subject, mode, phase, cursor, attempts, due_at AS due,
				CAST(follow_bound AS TEXT) AS follow_bound, CAST(report_bound AS TEXT) AS report_bound, action_bound
			FROM remote_moderation_jobs ORDER BY id`,
    ).map((j): JobRow => ({
      id: j.id,
      kind: j.kind,
      subject: j.subject,
      mode: j.mode,
      phase: j.phase,
      cursor: j.cursor,
      attempts: j.attempts,
      dueAt: j.due,
      followBound: j.follow_bound,
      reportBound: j.report_bound,
      actionBound: j.action_bound,
    }));
    const follows = q<{ id: string; follower: string; target: string; state: string; uri: string | null }>(
      `SELECT CAST(id AS TEXT) AS id, account_id AS follower, target_account_id AS target, state, uri FROM follows
			ORDER BY id`,
    );
    const members = q<{ follower: string; target: string }>(
      `SELECT l.account_id AS follower, m.account_id AS target FROM list_accounts m JOIN lists l ON l.id = m.list_id
			ORDER BY 1, 2`,
    );
    const pins = q<{ owner: string; target: string }>(
      "SELECT account_id AS owner, target_account_id AS target FROM account_pins ORDER BY 1, 2",
    );
    const reports = q<{ id: string; target: string; resolved: number; last: number }>(
      `SELECT CAST(id AS TEXT) AS id, target_account_id AS target, action_taken_at IS NOT NULL AS resolved,
				coalesce(last_action_id, 0) AS last FROM reports ORDER BY id`,
    );
    const counts = q<{ id: string; followers: number; following: number }>(
      `SELECT a.id, followers_count AS followers, following_count AS following FROM accounts a
			JOIN local_accounts l ON l.account_id = a.id`,
    );
    const notifications = q<{ account: string; from: string; type: string }>(
      `SELECT account_id AS account, from_account_id AS "from", type FROM notifications ORDER BY 1, 2, 3`,
    );
    const retracted = q<{ actor: string; target: string }>(
      "SELECT actor_uri AS actor, target_uri AS target FROM inbound_retractions ORDER BY 1, 2",
    );
    const statuses = q<{ account: string; n: number }>(
      "SELECT account_id AS account, count(*) AS n FROM statuses GROUP BY account_id ORDER BY 1",
    );
    const lanes = q<{
      account: string;
      type: string;
      id: string;
      object: string | null;
      superseded: number;
      inbox: string;
      state: string;
      token: string | null;
    }>(
      `SELECT d.account_id AS account, json_extract(o.body, '$.activity.type') AS type,
				json_extract(o.body, '$.activity.id') AS id,
				CASE json_type(o.body, '$.activity.object') WHEN 'object' THEN json_extract(o.body, '$.activity.object.id')
					ELSE json_extract(o.body, '$.activity.object') END AS object,
				o.superseded, d.inbox_url AS inbox, d.state, d.lease_token AS token
			FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id ORDER BY d.id`,
    );
    const unexpanded = q<{ n: number }>("SELECT count(*) AS n FROM outbound_targets")[0]!.n;
    const unrowed = q<{ type: string }>(
      `SELECT json_extract(body, '$.activity.type') AS type FROM outbound_activities o
			WHERE NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.activity_id = o.id)`,
    ).map((row) => row.type);
    const blockMap = new Map(blocks.map((b) => [b.domain, b]));
    const snap: Snapshot = {
      blocks: blockMap,
      remotes: remotes.map((r) => ({ id: r.id, uri: r.uri, domain: r.domain, source: r.source as Source })),
      follows: follows.map(({ id, follower, target, state }) => ({ id, follower, target, state })),
      members,
      reports: reports.map((r) => ({ id: r.id, target: r.target, resolved: r.resolved === 1, lastAction: r.last })),
    };
    return {
      blocks,
      remotes,
      keys,
      jobs,
      follows,
      members,
      pins,
      reports,
      counts,
      notifications,
      retracted,
      statuses,
      lanes,
      unexpanded,
      unrowed,
      snap,
      remoteIds,
    };
  });
}

type State = Awaited<ReturnType<typeof read>>;

// The projection compared with the policy, by label.
function projection(w: World, s: State) {
  const name = (id: string) => labelOf(w, id) ?? id;
  const rowRef = (row: State["lanes"][number]) =>
    row.type === "Update" ? null : row.type === "Follow" || row.type === "Block" ? row.id : row.object;
  const lanes: Record<string, LaneRow[]> = {};
  for (const row of s.lanes) {
    const local = name(row.account);
    const origin = new URL(row.inbox).origin;
    const remote = REMOTES.find((r) => new URL(w.policy.remotes[r].uri).origin === origin) ?? origin;
    (lanes[`${local} ${remote}`] ??= []).push({
      type: row.type,
      ref: rowRef(row),
      superseded: row.superseded === 1,
      inbox: row.inbox,
      state: row.state,
      token: row.token,
    });
  }
  return {
    blocks: s.blocks,
    remotes: Object.fromEntries(
      s.remotes.map((r) => [
        name(r.id),
        {
          source: r.source,
          suspended: r.suspended === 1,
          name: r.name,
          domain: r.domain,
          inbox: r.inbox,
          sharedInbox: r.shared,
          keys: s.keys.filter((k) => k.account === r.id).map((k) => k.pem),
        },
      ]),
    ),
    jobs: s.jobs.map((j) => ({
      kind: j.kind,
      subject: j.subject === "" ? "" : name(j.subject),
      mode: j.mode,
      failing: j.attempts > 0,
    })),
    follows: s.follows.map((f) => ({ gen: `${name(f.follower)}>${name(f.target)}`, state: f.state, uri: f.uri })),
    listed: s.members.filter((m) => m.follower === w.ids.L1).map((m) => name(m.target)),
    pins: s.pins.filter((p) => p.owner === w.ids.L1).map((p) => name(p.target)),
    reports: s.reports.map((r) => ({ label: w.reportIds.get(r.id) ?? r.id, resolved: r.resolved === 1 })),
    counts: Object.fromEntries(
      s.counts
        .filter((c) => LOCALS.includes(name(c.id) as Local))
        .map((c) => [name(c.id), { followers: c.followers, following: c.following }]),
    ),
    notifications: s.notifications
      .filter((n) => LOCALS.includes(name(n.account) as Local))
      .map((n) => `${name(n.account)} ${name(n.from)} ${n.type}`),
    retracted: s.retracted.map((r) => `${r.actor} ${r.target}`),
    statuses: Object.fromEntries(s.statuses.map((row) => [name(row.account), row.n])),
    lanes,
    unexpanded: s.unexpanded,
    unrowed: s.unrowed.filter((type) => type !== "Update"),
  };
}

const sameOrigin = (a: string, b: string) => new URL(a).origin === new URL(b).origin;

function expected(w: World) {
  const p = w.policy;
  const follows: { gen: string; state: string; uri: string | null }[] = [];
  const notifications: string[] = [];
  const retracted: string[] = [];
  const lanes: Record<string, LaneRow[]> = {};
  const counts: Record<string, { followers: number; following: number }> = {};
  for (const l of LOCALS) {
    counts[l] = { followers: 0, following: 0 };
  }
  for (const l of LOCALS) {
    for (const r of REMOTES) {
      const pair = p.pair(l, r);
      counts[l]!.followers += pair.followers;
      counts[l]!.following += pair.following;
      if (pair.rl !== null) {
        follows.push({ gen: `${r}>${l}`, state: pair.rl.state, uri: pair.rl.uri });
      }
      if (pair.lr !== null) {
        follows.push({ gen: `${l}>${r}`, state: pair.lr.state, uri: pair.lr.uri });
      }
      for (const type of pair.notifications) {
        notifications.push(`${l} ${r} ${type}`);
      }
      if (pair.lane.length > 0) {
        lanes[`${l} ${r}`] = pair.lane.map((i) => ({
          type: i.type,
          ref: i.ref,
          superseded: i.superseded,
          inbox: w.inboxes.get(`${l} ${r} ${i.seq}`) ?? "unassigned",
          state: i.head === null ? "queued" : i.head.kind,
          token: i.head?.kind === "leased" ? i.head.token : null,
        }));
      }
    }
  }
  for (const r of REMOTES) {
    const uris = new Set(LOCALS.flatMap((l) => [...p.pair(l, r).retracted]));
    for (const uri of uris) {
      retracted.push(`${p.remotes[r].uri} ${uri}`);
    }
  }
  return {
    blocks: [...p.blocks.values()].toSorted((a, b) => (a.domain < b.domain ? -1 : 1)),
    remotes: Object.fromEntries(
      REMOTES.filter((r) => p.remotes[r].stored).map((r) => {
        const a = p.remotes[r];
        return [
          r,
          {
            source: a.source,
            suspended: a.source !== null,
            name: a.name,
            domain: a.domain,
            inbox: a.inbox,
            sharedInbox: a.sharedInbox,
            keys: a.keys,
          },
        ];
      }),
    ),
    jobs: [...p.jobs.values()].map((j) => ({ ...j, failing: false })),
    follows,
    listed: [...p.listed].toSorted(),
    pins: [...p.pins].toSorted(),
    reports: p.reports.map((r) => ({ label: r.label, resolved: r.resolved })),
    counts,
    notifications: [...notifications, ...[...p.mentions].map((r) => `L1 ${r} mention`)].toSorted(),
    retracted: retracted.toSorted(),
    statuses: Object.fromEntries(p.statuses),
    lanes,
    unexpanded: 0,
    unrowed: [] as string[],
  };
}

// Records the inbox of every intent recorded since the last step: the remote's current inbox (shared, else
// personal), but the personal one for a severing Reject (Mastodon's reject_remote_follows!, which visibility.md claims
// parity with; G3F below).
function assignInboxes(w: World) {
  for (const l of LOCALS) {
    for (const r of REMOTES) {
      for (const intent of w.policy.pair(l, r).lane) {
        const key = `${l} ${r} ${intent.seq}`;
        if (!w.inboxes.has(key)) {
          const a = w.policy.remotes[r];
          const severing = w.severingRejects.has(key);
          w.inboxes.set(key, severing ? a.inbox : inboxOf(a));
          if (severing) {
            w.severingRejects.set(key, a.sharedInbox);
          }
        }
      }
    }
  }
}

// G3F (#1425, a known defect): visibility.md says the severing Reject goes to the follower's current shared inbox
// when known, "as Mastodon's ... send it"; Mastodon v4.5.11 sends it to the personal inbox
// (suspend_account_service.rb:37; delete_account_service.rb:116-129). The policy predicts Mastodon's; a severing
// Reject's row alone may stand at the shared inbox it had when recorded.
function knownDefectG3F(w: World, want: ReturnType<typeof expected>, got: ReturnType<typeof projection>) {
  for (const [lane, rows] of Object.entries(want.lanes)) {
    const [l, r] = lane.split(" ") as [Local, Remote];
    const intents = w.policy.pair(l, r).lane;
    for (const [i, row] of rows.entries()) {
      const shared = w.severingRejects.get(`${l} ${r} ${intents[i]!.seq}`);
      const actual = got.lanes[lane]?.[i];
      if (shared != null && actual?.inbox === shared && actual.type === "Reject") {
        row.inbox = shared;
        tally(w.stats, "known defect G3F");
      }
    }
  }
}

async function check(w: World, answer: { actual: unknown; predicted: unknown } | null = null): Promise<State> {
  if (answer !== null) {
    expect(answer.actual, context(w)).toEqual(answer.predicted);
  }
  assignInboxes(w);
  const s = await read(w);
  const got = projection(w, s);
  const want = expected(w);
  knownDefectG3F(w, want, got);
  got.follows.sort((a, b) => (a.gen < b.gen ? -1 : 1));
  want.follows.sort((a, b) => (a.gen < b.gen ? -1 : 1));
  got.listed.sort();
  got.pins.sort();
  expect(got, context(w)).toEqual(want);
  w.last = s;
  return s;
}

// The per-step API reads: availability as L1 sees it (`suspended`), and the admin's paged list of suspended accounts.
async function apiReads(w: World): Promise<void> {
  for (const r of REMOTES) {
    const id = w.remoteIds[r];
    if (id === null) {
      continue;
    }
    const answer = await call(w, `/api/v1/accounts/${id}`, {}, w.tokens.L1);
    expect({ r, suspended: (answer.body as { suspended?: boolean }).suspended === true }, context(w)).toEqual({
      r,
      suspended: !w.policy.available(r),
    });
  }
  expect(await adminSuspended(w), context(w)).toEqual(w.policy.adminList());
}

async function adminSuspended(w: World): Promise<Remote[] | 503> {
  const found: Remote[] = [];
  let path: string | null = "/api/v2/admin/accounts?status=suspended";
  while (path !== null) {
    const answer = await call(w, path, {}, w.admin);
    if (answer.status === 503) {
      return 503;
    }
    expect(answer.status).toBe(200);
    for (const account of answer.body as { id: string }[]) {
      const label = labelOf(w, account.id);
      if (label !== null && !label.startsWith("L")) {
        found.push(label as Remote);
      }
    }
    const next = answer.link?.match(/<([^>]+)>; rel="next"/)?.[1] ?? null;
    path = next === null ? null : new URL(next).pathname + new URL(next).search;
  }
  return REMOTES.filter((r) => found.includes(r));
}

// ---------------------------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------------------------

type Admin =
  | { k: "create"; domain: Domain; severity: "suspend" | "noop" | "silence"; rejectReports: boolean }
  | { k: "update"; i: number; severity: "suspend" | "noop" | "silence" | null; flag: Flag | null; value: boolean }
  | { k: "delete"; i: number }
  | { k: "suspend"; r: Remote }
  | { k: "unsuspend"; i: number };
type Flag = "reject_media" | "reject_reports" | "obfuscate";
type Rounds = { k: "round" } | { k: "moderation" };
type LocalAction =
  | { k: "unfollow"; r: Remote }
  | { k: "remove"; r: Remote }
  | { k: "report"; r: Remote }
  | { k: "listPin"; pin: boolean };
type Action = Admin | Rounds | LocalAction;

const flagKey = { reject_media: "rejectMedia", reject_reports: "rejectReports", obfuscate: "obfuscate" } as const;

async function admin(w: World, a: Admin): Promise<void> {
  const p = w.policy;
  switch (a.k) {
    case "create": {
      log(w, `create ${a.domain} ${a.severity}${a.rejectReports ? " reject_reports" : ""}`);
      const answer = await call(
        w,
        "/api/v1/admin/domain_blocks",
        json({ domain: a.domain, severity: a.severity, reject_reports: a.rejectReports }),
        w.admin,
      );
      if (answer.status === 200) {
        w.blockIds.set(a.domain, (answer.body as { id: string }).id);
      }
      // C2: a refused create names the ruling block (ExistingDomainBlockErrorSerializer); silence has no such body.
      const ruling = ruleOf(p.blocks, a.domain);
      if (answer.status === 422 && a.severity !== "silence" && ruling !== undefined) {
        expect(answer.body, context(w)).toMatchObject({
          error: `You have already imposed stricter limits on ${ruling.domain}.`,
          existing_domain_block: { domain: ruling.domain, severity: ruling.severity },
        });
      }
      const predicted = p.createBlock(a.domain, a.severity, {
        rejectMedia: false,
        rejectReports: a.rejectReports,
        obfuscate: false,
      });
      return void (await after(w, { actual: answer.status, predicted }));
    }
    case "update": {
      // An existing block, when there is one.
      const domains = [...p.blocks.keys()];
      const domain = domains.length > 0 ? domains[a.i % domains.length]! : DOMAINS[a.i % DOMAINS.length]!;
      const id = w.blockIds.get(domain) ?? "999999";
      const body: Record<string, unknown> = {};
      const change: Parameters<WorldPolicy["updateBlock"]>[1] = {};
      if (a.severity !== null) {
        body.severity = a.severity;
        change.severity = a.severity;
      }
      if (a.flag !== null) {
        body[a.flag] = a.value;
        change[flagKey[a.flag]] = a.value;
      }
      log(w, `update ${domain} ${JSON.stringify(body)}`);
      const answer = await call(w, `/api/v1/admin/domain_blocks/${id}`, json(body, { method: "PUT" }), w.admin);
      return void (await after(w, { actual: answer.status, predicted: p.updateBlock(domain, change) }));
    }
    case "delete": {
      const domains = [...p.blocks.keys()];
      const domain = domains.length > 0 ? domains[a.i % domains.length]! : DOMAINS[a.i % DOMAINS.length]!;
      log(w, `delete ${domain}`);
      const id = w.blockIds.get(domain) ?? "999999";
      const answer = await call(w, `/api/v1/admin/domain_blocks/${id}`, { method: "DELETE" }, w.admin);
      const predicted = p.deleteBlock(domain);
      if (predicted === 200) {
        w.blockIds.delete(domain);
      }
      return void (await after(w, { actual: answer.status, predicted }));
    }
    case "suspend":
      return suspend(w, a.r);
    case "unsuspend": {
      // An individually suspended account, when there is one.
      const held = REMOTES.filter((r) => p.remotes[r].stored && p.remotes[r].source === "account");
      const stored = REMOTES.filter((r) => p.remotes[r].stored);
      const r = held.length > 0 ? held[a.i % held.length]! : stored[a.i % stored.length]!;
      return unsuspend(w, r);
    }
  }
}

async function suspend(w: World, r: Remote): Promise<void> {
  log(w, `suspend ${r}`);
  const answer = await call(w, `/api/v1/admin/accounts/${w.remoteIds[r]}/action`, form({ type: "suspend" }), w.admin);
  const s = await after(w, { actual: answer.status, predicted: w.policy.suspend(r) });
  // VIS-29's fence: the newest report at the suspension.
  const job = s.jobs.find((j) => j.kind === "account" && j.subject === w.remoteIds[r])!;
  const newest = s.reports.reduce((m, rep) => (BigInt(rep.id) > m ? BigInt(rep.id) : m), 0n);
  expect(job.reportBound, context(w)).toBe(String(newest));
  w.fences.set(job.subject, job);
}

async function unsuspend(w: World, r: Remote): Promise<void> {
  log(w, `unsuspend ${r}`);
  const answer = await call(w, `/api/v1/admin/accounts/${w.remoteIds[r]}/unsuspend`, { method: "POST" }, w.admin);
  const predicted = w.policy.unsuspend(r);
  w.trace.push(`  -> ${answer.status} ${predicted.outcome ?? ""}`);
  if (predicted.outcome !== null) {
    tally(w.stats, `unsuspension ${predicted.outcome}`);
  }
  await after(w, { actual: answer.status, predicted: predicted.status });
}

// After a step that is not a round: the answer, the projection, the API reads.
async function after(w: World, answer: { actual: unknown; predicted: unknown }): Promise<State> {
  w.trace.push(`  -> ${JSON.stringify(answer.actual)}`);
  const s = await check(w, answer);
  await apiReads(w);
  return s;
}

// The completed set of a round or a call, applied to the policy: each severed follow by its pair and side (out before
// in, as the walks sever), list memberships, marks and clears, resolved reports, and the jobs that ended.
function adopt(w: World, before: State, now: State): void {
  const p = w.policy;
  const gone = new Set(now.follows.map((f) => f.id));
  const severed = before.follows
    .filter((f) => !gone.has(f.id))
    .toSorted(
      (a, b) => Number(labelOf(w, a.follower)!.startsWith("L")) - Number(labelOf(w, b.follower)!.startsWith("L")),
    );
  for (const f of severed) {
    const follower = labelOf(w, f.follower)!;
    const target = labelOf(w, f.target)!;
    const out = follower.startsWith("R");
    const l = (out ? target : follower) as Local;
    const r = (out ? follower : target) as Remote;
    const intent = p.sever(l, r, out ? "out" : "in", w.clock);
    if (intent?.type === "Reject") {
      w.severingRejects.set(`${l} ${r} ${intent.seq}`, null);
    }
    w.severedByRound.add(`${follower}>${target}`);
    w.severedGens.add(f.uri ?? f.id);
    tally(w.stats, `severed ${out ? "out" : "in"} ${f.state}`);
  }
  const members = new Set(now.members.map((m) => `${m.follower} ${m.target}`));
  for (const m of before.members) {
    if (!members.has(`${m.follower} ${m.target}`)) {
      p.listed.delete(labelOf(w, m.target) as Remote);
    }
  }
  const sources = new Map(now.remotes.map((r) => [r.id, r.source]));
  for (const r of before.remotes) {
    const label = labelOf(w, r.id) as Remote;
    const source = sources.get(r.id) as Source;
    if (r.source === null && source === "domain") {
      p.remotes[label].source = "domain";
      tally(w.stats, "marked");
    } else if (r.source === "domain" && source === null) {
      p.remotes[label].source = null;
      tally(w.stats, "mark cleared");
    }
  }
  const resolved = new Set(now.reports.filter((r) => r.resolved === 1).map((r) => r.id));
  for (const rep of p.reports) {
    const id = [...w.reportIds].find(([, label]) => label === rep.label)?.[0];
    if (id !== undefined && resolved.has(id) && !rep.resolved) {
      rep.resolved = true;
      tally(w.stats, "report resolved");
    }
  }
  const jobs = new Set(now.jobs.map((j) => `${j.kind} ${j.subject === "" ? "" : labelOf(w, j.subject)}`));
  for (const key of p.jobs.keys()) {
    if (!jobs.has(key)) {
      p.jobs.delete(key);
      tally(w.stats, `job ended ${key.split(" ")[0]}`);
    }
  }
}

function ledger(w: World, before: State, now: State, ran: string | null, rows: number | null): void {
  const failures = ledgerCheck({
    before: { jobs: before.jobs, snap: before.snap },
    after: { jobs: now.jobs, snap: now.snap },
    ran,
    rows,
    caps: CAPS,
    now: w.clock,
  });
  expect(failures, context(w)).toEqual([]);
}

// One round of the remote jobs (remoteModerationRound in its own transaction, as runModerationJobs runs each), with
// the rows it wrote; null when no job may run.
async function round(w: World): Promise<{ id: string } | null> {
  const before = w.last!;
  const { result, rows } = await writtenBy(w.store, (db) => remoteModerationRound(db, w.clock));
  log(w, `round ${result === null ? "(none)" : before.jobs.find((j) => j.id === result.id)?.kind}`);
  const s = await read(w);
  ledger(w, before, s, result?.id ?? null, rows);
  if (result === null) {
    expect(
      before.jobs.filter((j) => pendingAt([j], w.clock)),
      context(w),
    ).toEqual([]);
  }
  adopt(w, before, s);
  await check(w);
  await apiReads(w);
  return result;
}

async function moderation(w: World): Promise<boolean> {
  const before = w.last!;
  log(w, "moderation");
  const { pending } = await w.store.runModerationJobs(BUILD, { now: w.clock });
  const s = await read(w);
  ledger(w, before, s, null, null);
  // Rule 6: pending is "some job is fresh, or backing off and due".
  expect(pending, context(w)).toBe(pendingAt(s.jobs, w.clock));
  adopt(w, before, s);
  await check(w);
  await apiReads(w);
  return pending;
}

async function local(w: World, a: LocalAction): Promise<void> {
  const p = w.policy;
  const now = w.clock;
  switch (a.k) {
    case "unfollow": {
      log(w, `L1 unfollows ${a.r}`);
      const answer = await call(w, `/api/v1/accounts/${w.remoteIds[a.r]}/unfollow`, json({}), w.tokens.L1);
      return void (await after(w, { actual: answer.status, predicted: p.unfollow("L1", a.r, now) }));
    }
    case "remove": {
      log(w, `L1 removes ${a.r}`);
      const path = `/api/v1/accounts/${w.remoteIds[a.r]}/remove_from_followers`;
      const answer = await call(w, path, json({}), w.tokens.L1);
      return void (await after(w, { actual: answer.status, predicted: p.removeFollower("L1", a.r, now) }));
    }
    case "report": {
      log(w, `L1 reports ${a.r}`);
      await report(w, a.r);
      return void (await after(w, { actual: null, predicted: null }));
    }
    case "listPin": {
      log(w, a.pin ? "L1 pins R1" : "L1 lists R1");
      const status = a.pin ? await pin(w, "R1") : await listAdd(w, "R1");
      return void (await after(w, { actual: status, predicted: a.pin ? p.pin("R1") : p.listAdd("R1") }));
    }
  }
}

// ---- Deliveries (NET-2's lanes, one per pair here: each remote has an inbox origin of its own) ----

let leaseSequence = 0;

// The lane head the next claim takes (the first due row), as its pair.
async function nextDue(w: World): Promise<{ local: Local; remote: Remote } | null> {
  const row = (
    await sql<{ account: string; inbox: string }>(
      w.store,
      `SELECT account_id AS account, inbox_url AS inbox FROM deliveries
			WHERE state IN ('pending', 'leased') AND next_attempt_at <= ? ORDER BY next_attempt_at, id LIMIT 1`,
      w.clock,
    )
  )[0];
  if (row === undefined) {
    return null;
  }
  const remote = REMOTES.find((r) => sameOrigin(w.policy.remotes[r].uri, row.inbox))!;
  return { local: labelOf(w, row.account) as Local, remote };
}

async function claim(w: World): Promise<Attempt | null> {
  const due = await nextDue(w);
  if (due === null) {
    return null;
  }
  const token = `lease-${++leaseSequence}`;
  log(w, `claim ${due.local} -> ${due.remote}`);
  const result = await w.store.claimDeliveries(BUILD, { now: w.clock, leaseToken: token, limit: 1 });
  const pair = w.policy.pair(due.local, due.remote);
  // The head's inbox, as the last projection (checked against the policy) holds it.
  const inbox = projection(w, w.last!).lanes[`${due.local} ${due.remote}`]?.[0]?.inbox;
  const predicted = pair.claim(w.clock, token);
  if (predicted.dropped !== null && !predicted.dropped.superseded) {
    tally(w.stats, `dropped at claim: ${predicted.dropped.type}`);
    w.droppedUnavailable.set(`${predicted.dropped.type} ${predicted.dropped.ref}`, due.remote);
  }
  await check(w, {
    actual: result.deliveries.map((d) => d.inbox),
    predicted: predicted.leased === null ? [] : [inbox],
  });
  if (predicted.leased === null) {
    return null;
  }
  const attempt: Attempt = {
    token,
    delivery: result.deliveries[0]!.id,
    local: due.local,
    remote: due.remote,
    intent: predicted.leased,
    phase: "claimed",
    body: null,
    confirmedAt: 0,
  };
  w.attempts.push(attempt);
  return attempt;
}

async function confirm(w: World, attempt: Attempt): Promise<void> {
  log(w, `confirm ${attempt.token} (${attempt.intent.type} ${attempt.intent.ref})`);
  const result = await w.store.confirmDelivery(BUILD, {
    id: attempt.delivery,
    leaseToken: attempt.token,
    now: w.clock,
  });
  const predicted = w.policy.pair(attempt.local, attempt.remote).confirm(attempt.token, w.clock);
  if (predicted.status === "dropped" && !attempt.intent.superseded) {
    tally(w.stats, `dropped at confirm: ${attempt.intent.type}`);
    w.droppedUnavailable.set(`${attempt.intent.type} ${attempt.intent.ref}`, attempt.remote);
  }
  attempt.phase = result.status === "send" ? "confirmed" : "done";
  if (result.status === "send") {
    attempt.body = result.body;
    attempt.confirmedAt = w.step;
    const body = JSON.parse(result.body) as Body;
    const ref =
      body.type === "Follow" ? body.id : typeof body.object === "string" ? body.object : (body.object.id ?? null);
    w.sent.push({ local: attempt.local, remote: attempt.remote, type: body.type, ref });
    await check(w, {
      actual: { status: "send", type: body.type, ref },
      predicted:
        predicted.status === "send"
          ? { status: "send", type: predicted.intent.type, ref: predicted.intent.ref }
          : { status: predicted.status },
    });
    return;
  }
  await check(w, { actual: result.status, predicted: predicted.status });
}

async function complete(w: World, attempt: Attempt): Promise<void> {
  log(w, `complete ${attempt.token}`);
  const result = await w.store.completeDelivery(BUILD, {
    id: attempt.delivery,
    leaseToken: attempt.token,
    now: w.clock,
    outcome: OK,
  });
  attempt.phase = "done";
  const predicted = w.policy.pair(attempt.local, attempt.remote).complete(attempt.token, true, w.clock, null);
  await check(w, { actual: result.status, predicted });
}

// The usual path in one step: a claim whose row is confirmed and completed, its body handed to R1's server when it is
// L1's to R1 and a peer runs.
async function send(w: World): Promise<boolean> {
  const attempt = await claim(w);
  if (attempt === null) {
    return (await nextDue(w)) !== null;
  }
  await confirm(w, attempt);
  if (attempt.phase === "confirmed") {
    if (w.peer !== null && attempt.local === "L1" && attempt.remote === "R1") {
      w.peer.receive(JSON.parse(attempt.body!) as Body, attempt.token);
    }
    await complete(w, attempt);
  }
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------------------------------------------

// Rounds until no job is left, then deliveries until no row is left; then rule 4's settlement and rule 6.
async function settle(w: World): Promise<void> {
  w.trace.push("-- settle");
  for (let i = 0; ; i++) {
    expect(i, `settlement passed ${SETTLE_ROUNDS} rounds\n${context(w)}`).toBeLessThan(SETTLE_ROUNDS);
    if ((await round(w)) === null) {
      break;
    }
  }
  expect(await moderation(w), context(w)).toBe(false);
  const s = w.last!;
  expect(s.jobs, context(w)).toEqual([]);
  expect(settlementFailures(s.snap, w.fences), context(w)).toEqual([]);
  await drainDeliveries(w);
}

async function drainDeliveries(w: World): Promise<void> {
  for (let i = 0; i < SETTLE_ROUNDS; i++) {
    for (const attempt of w.attempts.filter((a) => a.phase !== "done")) {
      if (attempt.phase === "claimed") {
        await confirm(w, attempt);
      }
      if (attempt.phase === "confirmed") {
        if (w.peer !== null && attempt.local === "L1" && attempt.remote === "R1") {
          w.peer.receive(JSON.parse(attempt.body!) as Body, attempt.token);
        }
        await complete(w, attempt);
      }
    }
    if (!(await send(w))) {
      for (const l of LOCALS) {
        for (const r of REMOTES) {
          expect(w.policy.pair(l, r).lane, context(w)).toEqual([]);
        }
      }
      return;
    }
  }
  throw new Error(`deliveries did not settle\n${context(w)}`);
}

// ---------------------------------------------------------------------------------------------------------------
// P1: decisions and rounds, with a twin whose rounds all run at settlement
// ---------------------------------------------------------------------------------------------------------------

const remoteArb = (...rs: Remote[]) => fc.constantFrom(...rs);

const adminArbs = [
  {
    arbitrary: fc.record({
      k: fc.constant("create" as const),
      domain: fc.constantFrom(...DOMAINS),
      severity: fc.constantFrom(
        ...(["suspend", "suspend", "suspend", "suspend", "suspend", "noop", "noop", "noop", "silence"] as const),
      ),
      rejectReports: fc.boolean(),
    }),
    weight: 6,
  },
  {
    arbitrary: fc.record({
      k: fc.constant("update" as const),
      i: fc.nat(5),
      severity: fc.constantFrom("suspend" as const, "noop" as const, "silence" as const, null),
      flag: fc.constantFrom("reject_media" as const, "reject_reports" as const, "obfuscate" as const, null),
      value: fc.boolean(),
    }),
    weight: 5,
  },
  { arbitrary: fc.record({ k: fc.constant("delete" as const), i: fc.nat(5) }), weight: 4 },
  { arbitrary: fc.record({ k: fc.constant("suspend" as const), r: remoteArb("R1", "R2", "R3", "R4") }), weight: 4 },
  { arbitrary: fc.record({ k: fc.constant("unsuspend" as const), i: fc.nat(5) }), weight: 4 },
];

const p1Arb: fc.Arbitrary<Action> = fc.oneof(
  ...adminArbs,
  { arbitrary: fc.constant({ k: "round" as const }), weight: 6 },
  { arbitrary: fc.constant({ k: "moderation" as const }), weight: 3 },
  { arbitrary: fc.record({ k: fc.constant("unfollow" as const), r: remoteArb("R1", "R3", "R4") }), weight: 2 },
  { arbitrary: fc.record({ k: fc.constant("remove" as const), r: remoteArb("R1", "R2", "R4") }), weight: 2 },
  { arbitrary: fc.record({ k: fc.constant("report" as const), r: remoteArb("R1", "R2", "R3", "R4") }), weight: 1 },
  { arbitrary: fc.record({ k: fc.constant("listPin" as const), pin: fc.boolean() }), weight: 1 },
);

async function act(w: World, a: Action): Promise<void> {
  switch (a.k) {
    case "round":
      return void (await round(w));
    case "moderation":
      return void (await moderation(w));
    case "unfollow":
    case "remove":
    case "report":
    case "listPin":
      return local(w, a);
    default:
      return admin(w, a);
  }
}

async function runP1(seed: Seed, actions: readonly Action[], deferred: boolean): Promise<World> {
  const w = await setup(seed);
  await check(w);
  await apiReads(w);
  for (const a of actions) {
    if (deferred && (a.k === "round" || a.k === "moderation")) {
      continue;
    }
    await act(w, a);
  }
  await settle(w);
  return w;
}

const SEED_LABELS = SEEDS as readonly string[];

// The P1 relation ("P1" in the design): what is a function of the final decisions is equal; severing is monotone, so
// the twin severed a subset, and every generation only the run severed was severed by a round in which it was
// eligible (each round's ledger check); reports alike; each ended generation had at most one ending intent of its
// type.
function p1Relation(a: World, b: World): void {
  const trace = `${context(a)}\n-- twin\n${context(b)}`;
  const decided = (w: World) => ({
    blocks: [...w.policy.blocks.values()].toSorted((x, y) => (x.domain < y.domain ? -1 : 1)),
    sources: REMOTES.map((r) => w.policy.remotes[r].source),
    available: REMOTES.map((r) => w.policy.available(r)),
    jobs: [...w.policy.jobs.keys()],
    admin: w.policy.adminList(),
    pins: [...w.policy.pins].filter((r) => w.policy.pair("L1", r).lr?.state !== "accepted"),
    listed: [...w.policy.listed].filter((r) => w.policy.pair("L1", r).lr?.state !== "accepted"),
  });
  expect(decided(a), trace).toEqual(decided(b));
  expect(decided(a).pins, trace).toEqual([]);
  expect(decided(a).listed, trace).toEqual([]);
  const present = (w: World) =>
    new Set(
      projection(w, w.last!)
        .follows.map((f) => f.gen)
        .filter((g) => SEED_LABELS.includes(g)),
    );
  const [inA, inB] = [present(a), present(b)];
  const seeded = SEED_LABELS.filter(
    (g) => inA.has(g) || inB.has(g) || a.severedByRound.has(g) || b.severedByRound.has(g),
  );
  for (const g of SEED_LABELS) {
    if (!inA.has(g) && inB.has(g) && !a.severedByRound.has(g)) {
      throw new Error(`generation ${g} absent only in the run, but no round severed it\n${trace}`);
    }
    expect(!inB.has(g) && inA.has(g), `${g} absent only in the twin\n${trace}`).toBe(false);
  }
  for (const w of [a, b]) {
    for (const r of REMOTES) {
      if (w.policy.covered(r) && w.policy.remotes[r].source !== "account") {
        expect(
          [...present(w)].filter((g) => g.includes(r)),
          trace,
        ).toEqual([]);
      }
      if (w.policy.remotes[r].source === "account") {
        expect(
          [...present(w)].filter((g) => g.startsWith(`${r}>`)),
          trace,
        ).toEqual([]);
      }
    }
    // Ending intents: a withdrawing Reject for an accepted remote follower, none for a request, an Undo for a local
    // follower; at most one each.
    for (const g of seeded) {
      const [follower, target] = g.split(">") as [string, string];
      const uri = follower.startsWith("L")
        ? `${w.localUris[follower as Local]}#follows/seed-${target}`
        : `${SPEC[follower as Remote].uri}#follows/seed-${target}`;
      const types = w.sent.filter((s) => s.ref === uri && s.type !== "Accept").map((s) => s.type);
      const want = follower.startsWith("L") ? "Undo" : target === "L2" ? null : "Reject";
      expect(types.length <= 1 && types.every((t) => t === want), `${g}: ${types.join(", ")}\n${trace}`).toBe(true);
    }
  }
  const resolved = (w: World) => new Set(w.policy.reports.filter((r) => r.resolved).map((r) => r.label));
  const [ra, rb] = [resolved(a), resolved(b)];
  expect(
    [...rb].filter((label) => !ra.has(label)),
    trace,
  ).toEqual([]);
}

const STATS: Record<string, Stats> = {};
const merge = (name: string, stats: Stats) => {
  const into = (STATS[name] ??= {});
  for (const [key, n] of Object.entries(stats)) {
    tally(into, key, n);
  }
};

const P1_CASES = 30;
const SEED = 1411_3;

describe("instance moderation P1: decisions and rounds against the policy, the ledger and a twin", () => {
  it("agrees with the policy after every step, and with its twin once settled", async () => {
    await fc.assert(
      fc.asyncProperty(seedArb, fc.array(p1Arb, { minLength: 12, maxLength: 20 }), async (seed, actions) => {
        // Report labels are positional, so each run counts its own from the same start.
        const start = sequence;
        const a = await runP1(seed, actions, false);
        sequence = start;
        const b = await runP1(seed, actions, true);
        p1Relation(a, b);
        merge("P1", a.stats);
      }),
      runs(P1_CASES, SEED),
    );
    console.log("instance moderation P1 coverage", JSON.stringify(STATS.P1, null, 1));
  }, 600_000);
});

describe("instance moderation P1 witnesses", () => {
  it("severs a covered account both ways and keeps an individually suspended account's local followers", async () => {
    const w = await runP1(
      ALL,
      [
        { k: "create", domain: D, severity: "suspend", rejectReports: false },
        { k: "suspend", r: "R3" },
        { k: "moderation" },
        { k: "moderation" },
      ],
      false,
    );
    expect(
      projection(w, w.last!)
        .follows.map((f) => f.gen)
        .toSorted(),
    ).toEqual(["L1>R3", "L1>R4", "R4>L1"]);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------------------
// P2: federation while decisions are in force (R1's server is machine 1's Mastodon v4.5.11 peer for R1 and L1)
// ---------------------------------------------------------------------------------------------------------------

type Variant = "name" | "key" | "routing";
type P2Action =
  | Action
  | { k: "peerFollow" | "peerUnfollow" | "peerRemoveFollower" | "deliver" | "process" }
  | { k: "document"; r: Remote; variant: Variant; stale: boolean }
  | { k: "flag"; r: Remote }
  | { k: "follow"; r: Remote }
  | { k: "answer"; r: Remote; accept: boolean }
  | { k: "claim" | "send" }
  | { k: "confirm" | "complete"; i: number };

let flagSequence = 0;
let documentSequence = 0;

// A verified actor document of `r`, as remote-actor.ts reads one, with the routing given.
function documentOf(w: World, r: Remote, doc: Document): RemoteActorInput {
  const a = w.policy.remotes[r];
  return {
    uri: a.uri,
    username: r.toLowerCase(),
    domain: a.domain,
    actorType: "Person",
    displayName: doc.name,
    note: "",
    url: a.uri,
    avatarUrl: null,
    headerUrl: null,
    locked: false,
    discoverable: null,
    indexable: false,
    inboxUrl: doc.inbox,
    sharedInboxUrl: doc.sharedInbox,
    published: null,
    keys: doc.keys.map((pem) => ({ id: `${a.uri}#main-key`, pem })),
    emojiTags: [],
    raw: "{}",
    movedTo: null,
  };
}

const outstanding = (w: World, r: Remote) => LOCALS.some((l) => w.policy.pair(l, r).lane.length > 0);

// A document carried by an Update of the actor: its name, its key or its routing changed (a routing change only while
// nothing is outstanding to the remote, so each intent keeps one row at its current inbox; witness 13 covers the
// rest), under the stored revision or a superseded one.
async function document(w: World, r: Remote, variant: Variant, stale: boolean): Promise<void> {
  const a = w.policy.remotes[r];
  const n = ++documentSequence;
  const flip = (url: string) => (url.endsWith("2") ? url.slice(0, -1) : `${url}2`);
  const doc: Document = { name: a.name, keys: [...a.keys], inbox: a.inbox, sharedInbox: a.sharedInbox };
  if (variant === "name") {
    doc.name = `${r} ${n}`;
  } else if (variant === "key") {
    doc.keys = [`${r}-key-${n}`];
  } else if (!outstanding(w, r)) {
    // A routing change renames the account too, which only a full refresh stores.
    doc.name = `${r} ${n}`;
    doc.inbox = flip(doc.inbox);
    doc.sharedInbox = doc.sharedInbox === null ? null : flip(doc.sharedInbox);
  }
  const revision = (
    await sql<{ revision: number | null }>(
      w.store,
      "SELECT document_revision AS revision FROM accounts WHERE uri = ?",
      a.uri,
    )
  )[0];
  const expected = revision === undefined ? null : stale ? (revision.revision ?? 0) + 1 : revision.revision;
  log(w, `${r} document (${variant}${stale ? ", superseded" : ""})`);
  const result = await w.store.receiveActivity(BUILD, {
    now: w.clock,
    origin: "https://kopje.test",
    actorUri: a.uri,
    actor: documentOf(w, r, doc),
    actorRevision: expected,
    activity: { type: "UpdateActor", id: `${new URL(a.uri).origin}/updates/${n}` },
  });
  const gate = w.policy.gate(r, "UpdateActor");
  const current = !stale || revision === undefined;
  const changed = gate === null || (a.stored && a.source === "account") ? w.policy.document(r, doc, current) : false;
  if (changed && w.remoteIds[r] === null) {
    w.remoteIds[r] = (await sql<{ id: string }>(w.store, "SELECT id FROM accounts WHERE uri = ?", a.uri))[0]!.id;
    tally(w.stats, "R5 stored");
  }
  const predicted = gate ?? (current ? "actor-updated" : "actor-changed");
  tally(w.stats, `document ${predicted}`);
  await after(w, { actual: result.reason, predicted });
}

async function flag(w: World, r: Remote): Promise<void> {
  const a = w.policy.remotes[r];
  log(w, `${r} flags L1`);
  const activity: InboundActivity = {
    type: "Flag",
    id: `${new URL(a.uri).origin}/flags/${++flagSequence}`,
    objects: [w.localUris.L1],
    content: "",
  };
  const before = new Set(w.last!.reports.map((rep) => rep.id));
  const result = await storeReceive(w.store, a.uri, activity, w.clock);
  const label = `flag ${flagSequence}`;
  const predicted = w.policy.gate(r, "Flag") ?? w.policy.flag(r, label);
  const filed = (await sql<{ id: string }>(w.store, "SELECT CAST(id AS TEXT) AS id FROM reports")).filter(
    (rep) => !before.has(rep.id),
  );
  for (const rep of filed) {
    w.reportIds.set(rep.id, label);
  }
  tally(w.stats, `flag ${predicted ?? "filed"}`);
  await after(w, { actual: result.applied ? null : result.reason, predicted });
}

// R1's message to Kopje, through the inbox's gate.
async function deliverToKopje(w: World, activity: Inbound): Promise<void> {
  const ref = activity.type === "Follow" || activity.type === "Block" ? activity.id : activity.object.id;
  log(w, `deliver ${activity.type} ${ref}`);
  const result = await storeReceive(w.store, w.policy.remotes.R1.uri, activity, w.clock);
  if (activity.type === "Follow" && !w.receivedAt.has(activity.id)) {
    w.receivedAt.set(activity.id, w.step);
  }
  if (activity.type === "Undo" && activity.object.id !== null && !w.undoReceivedAt.has(activity.object.id)) {
    w.undoReceivedAt.set(activity.object.id, w.step);
  }
  const gate = w.policy.gate("R1", activity.type);
  if (gate !== null) {
    if (activity.type === "Follow") {
      w.ignoredFollows.set(activity.id, w.step);
    }
    if (activity.type === "Accept" && activity.object.id !== null) {
      w.ignoredAccepts.add(activity.object.id);
    }
    tally(w.stats, `ignored ${activity.type} while unavailable`);
    return void (await after(w, { actual: [result.applied, result.reason], predicted: [false, gate] }));
  }
  const predicted = w.policy.pair("L1", "R1").receive(activity, w.clock);
  w.policy.followEnded("L1", "R1");
  await after(w, { actual: [result.applied, result.reason], predicted: [predicted.applied, predicted.reason] });
}

async function p2Local(w: World, a: P2Action & { k: "follow" | "answer" }): Promise<void> {
  const p = w.policy;
  if (a.k === "follow") {
    log(w, `L1 follows ${a.r}`);
    const answer = await call(w, `/api/v1/accounts/${w.remoteIds[a.r]}/follow`, json({}), w.tokens.L1);
    const uri = (
      await sql<{ uri: string }>(
        w.store,
        "SELECT uri FROM follows WHERE account_id = ? AND target_account_id = ?",
        w.ids.L1,
        w.remoteIds[a.r],
      )
    )[0]?.uri;
    const predicted = p.follow("L1", a.r, w.clock, () => uri ?? "no follow stored");
    if (a.r === "R1" && p.pair("L1", "R1").lr !== null) {
      w.lastFollow = p.pair("L1", "R1").lr!.uri;
    }
    return void (await after(w, { actual: answer.status, predicted }));
  }
  log(w, `L2 ${a.accept ? "authorizes" : "rejects"} ${a.r}`);
  const path = `/api/v1/follow_requests/${w.remoteIds[a.r]}/${a.accept ? "authorize" : "reject"}`;
  const answer = await call(w, path, json({}), w.tokens.L2);
  await after(w, { actual: answer.status, predicted: p.answer("L2", a.r, a.accept, w.clock) });
}

async function p2Act(w: World, a: P2Action): Promise<void> {
  const peer = w.peer!;
  switch (a.k) {
    case "peerFollow":
      if (peer.follow()) {
        log(w, "peer follows");
      }
      return;
    case "peerUnfollow":
      if (peer.unfollow()) {
        log(w, "peer unfollows");
      }
      return;
    case "peerRemoveFollower":
      if (peer.removeFollower()) {
        log(w, "peer removes L1");
      }
      return;
    case "deliver": {
      const message = peer.outbox.shift();
      if (message !== undefined) {
        await deliverToKopje(w, message.activity);
      }
      return;
    }
    case "process": {
      const body = peer.process(0, w.clock);
      if (body !== null) {
        log(w, `peer processes ${body.type}`);
      }
      return;
    }
    case "document":
      if (w.policy.remotes[a.r].stored || a.r === "R5") {
        await document(w, a.r, a.variant, a.stale);
      }
      return;
    case "flag":
      return flag(w, a.r);
    case "follow":
    case "answer":
      return p2Local(w, a);
    case "claim":
      return void (await claim(w));
    case "send":
      return void (await send(w));
    case "confirm": {
      const open = w.attempts.filter((t) => t.phase === "claimed");
      if (open.length > 0) {
        await confirm(w, open[a.i % open.length]!);
      }
      return;
    }
    case "complete": {
      const open = w.attempts.filter((t) => t.phase === "confirmed");
      if (open.length > 0) {
        const attempt = open[a.i % open.length]!;
        if (attempt.local === "L1" && attempt.remote === "R1") {
          peer.receive(JSON.parse(attempt.body!) as Body, attempt.token);
        }
        await complete(w, attempt);
      }
      return;
    }
    default:
      return act(w, a);
  }
}

const p2Arb: fc.Arbitrary<P2Action> = fc.oneof(
  ...adminArbs,
  { arbitrary: fc.constant({ k: "round" as const }), weight: 8 },
  { arbitrary: fc.constant({ k: "moderation" as const }), weight: 4 },
  { arbitrary: fc.constant({ k: "peerFollow" as const }), weight: 4 },
  { arbitrary: fc.constant({ k: "peerUnfollow" as const }), weight: 2 },
  { arbitrary: fc.constant({ k: "peerRemoveFollower" as const }), weight: 1 },
  { arbitrary: fc.constant({ k: "deliver" as const }), weight: 6 },
  { arbitrary: fc.constant({ k: "process" as const }), weight: 5 },
  {
    arbitrary: fc.record({
      k: fc.constant("document" as const),
      r: remoteArb("R1", "R2", "R3", "R4", "R5"),
      variant: fc.constantFrom<Variant>("name", "key", "routing"),
      stale: fc.boolean(),
    }),
    weight: 10,
  },
  { arbitrary: fc.record({ k: fc.constant("flag" as const), r: remoteArb("R1", "R2", "R3", "R4") }), weight: 5 },
  {
    arbitrary: fc.record({ k: fc.constant("follow" as const), r: remoteArb("R1", "R1", "R2", "R3", "R4") }),
    weight: 5,
  },
  { arbitrary: fc.record({ k: fc.constant("unfollow" as const), r: remoteArb("R1", "R3", "R4") }), weight: 3 },
  {
    arbitrary: fc.record({ k: fc.constant("answer" as const), r: remoteArb("R1", "R2"), accept: fc.boolean() }),
    weight: 3,
  },
  { arbitrary: fc.record({ k: fc.constant("remove" as const), r: remoteArb("R1", "R2", "R4") }), weight: 2 },
  { arbitrary: fc.record({ k: fc.constant("report" as const), r: remoteArb("R1", "R2", "R3", "R4") }), weight: 2 },
  { arbitrary: fc.constant({ k: "claim" as const }), weight: 5 },
  { arbitrary: fc.record({ k: fc.constant("confirm" as const), i: fc.nat(3) }), weight: 4 },
  { arbitrary: fc.record({ k: fc.constant("complete" as const), i: fc.nat(3) }), weight: 4 },
  { arbitrary: fc.constant({ k: "send" as const }), weight: 7 },
);

// Settles both sides: rounds until no job is left, deliveries, and R1's server's processing and messages, each in
// order, until nothing moves.
async function settleP2(w: World): Promise<void> {
  const peer = w.peer!;
  w.trace.push("-- settle");
  for (let i = 0; i < SETTLE_ROUNDS; i++) {
    let moved = false;
    for (let j = 0; (await round(w)) !== null; j++) {
      expect(j, `settlement passed ${SETTLE_ROUNDS} rounds\n${context(w)}`).toBeLessThan(SETTLE_ROUNDS);
      moved = true;
    }
    for (const attempt of w.attempts.filter((t) => t.phase !== "done")) {
      if (attempt.phase === "claimed") {
        await confirm(w, attempt);
      }
      if (attempt.phase === "confirmed") {
        await p2Act(w, { k: "complete", i: w.attempts.filter((t) => t.phase === "confirmed").indexOf(attempt) });
      }
      moved = true;
    }
    if ((await nextDue(w)) !== null) {
      await send(w);
      continue;
    }
    while (peer.inbox.length > 0) {
      await p2Act(w, { k: "process" });
      moved = true;
    }
    while (peer.outbox.length > 0) {
      await p2Act(w, { k: "deliver" });
      moved = true;
    }
    if (!moved) {
      expect(await moderation(w), context(w)).toBe(false);
      expect(settlementFailures(w.last!.snap, w.fences), context(w)).toEqual([]);
      return;
    }
  }
  throw new Error(`P2 did not settle\n${context(w)}`);
}

const peerState = (edge: { state: string; uri: string | null } | null) =>
  edge === null ? null : { state: edge.state === "pending" ? "requested" : edge.state, uri: edge.uri ?? "" };

// The differences allowed on R1's follow of L1 at quiescence, each naming R1's newest generation g and the events that
// produced it.
function rlException(w: World, mine: { state: string; uri: string } | null): string | null {
  const peer = w.peer!;
  const g = peer.lastRGeneration;
  if (g === null) {
    return null;
  }
  const attempts = w.attempts.filter((a) => a.local === "L1" && a.remote === "R1");
  const race = { peer, attempts, receivedAt: w.receivedAt, undoReceivedAt: w.undoReceivedAt, mine };
  if (net2Answer(race)) {
    return "net2-answer";
  }
  if (keptReject(race)) {
    return "kept-reject";
  }
  const theirs = peer.rl;
  const ignoredAt = w.ignoredFollows.get(g);
  // X1 (accepted risk): g arrived while R1 was unavailable and was ignored, with no answer, as in Mastodon
  // (process_collection_service.rb:55-60); R1's server keeps it requested.
  if (ignoredAt !== undefined && mine === null && theirs?.state === "requested" && theirs.uri === g) {
    return "X1";
  }
  // X1, the late answer: an Accept of an earlier generation h, confirmed before Kopje received g, reached R1's server
  // after g and was applied to it by the pair (accept.rb:4-35).
  const applied = peer.events.pairAnswer.get(g);
  if (
    ignoredAt !== undefined &&
    mine === null &&
    theirs?.state === "accepted" &&
    theirs.uri === g &&
    attempts.some(
      (a) =>
        a.intent.type === "Accept" &&
        a.intent.ref !== g &&
        a.body !== null &&
        a.confirmedAt < (w.receivedAt.get(g) ?? 0) &&
        applied?.has(a.token) === true,
    )
  ) {
    return "X1-late-answer";
  }
  // X5 (#1423, a known defect): g's Accept was dropped for R1's unavailability, g was never severed (R1 was
  // unsuspended before its job's round), so Kopje holds g accepted while R1's server holds it requested.
  if (
    w.droppedUnavailable.has(`Accept ${g}`) &&
    !w.severedGens.has(g) &&
    mine?.uri === g &&
    mine.state === "accepted" &&
    theirs?.uri === g &&
    theirs.state === "requested"
  ) {
    return "X5";
  }
  return null;
}

// The differences allowed on L1's follow of R1, named by L1's newest follow id u.
function lrException(w: World, mine: { state: string; uri: string } | null): string | null {
  const u = w.lastFollow;
  const theirs = w.peer!.lr;
  if (u === null) {
    return null;
  }
  // X2 (accepted risk): R1's Accept of u arrived while R1 was unavailable and was ignored, as in Mastodon.
  if (w.ignoredAccepts.has(u) && mine?.uri === u && mine.state === "requested" && theirs?.uri === u) {
    return "X2";
  }
  // X3 (#1422, a known defect): u's Follow was dropped at send time for R1's unavailability; the local follow stays
  // pending, and R1's server never heard of it.
  if (w.droppedUnavailable.has(`Follow ${u}`) && mine?.uri === u && mine.state === "requested" && theirs === null) {
    return "X3";
  }
  return null;
}

function quiescence(w: World): void {
  const s = projection(w, w.last!);
  const edge = (gen: string) => peerState(s.follows.find((f) => f.gen === gen) ?? null);
  const rl = edge("R1>L1");
  const lr = edge("L1>R1");
  const rlx = rlException(w, rl);
  const lrx = lrException(w, lr);
  for (const e of [rlx, lrx]) {
    if (e !== null) {
      tally(w.stats, `exception ${e}`);
    }
  }
  const peer = w.peer!;
  expect({ rl: rlx ?? rl, lr: lrx ?? lr }, context(w)).toEqual({ rl: rlx ?? peer.rl, lr: lrx ?? peer.lr });
}

async function runP2(seed: Seed, actions: readonly P2Action[]): Promise<World> {
  const w = await setup(seed);
  w.peer = new Peer("https://d.example", w.policy.remotes.R1.uri, w.localUris.L1);
  // R1's server holds what the seed holds for R1 and L1.
  const pair = w.policy.pair("L1", "R1");
  w.peer.rl = pair.rl === null ? null : { state: "accepted", uri: pair.rl.uri! };
  w.peer.lr = pair.lr === null ? null : { state: "accepted", uri: pair.lr.uri };
  if (pair.rl !== null) {
    w.peer.lastRGeneration = pair.rl.uri;
    w.peer.generations.push(pair.rl.uri!);
  }
  w.lastFollow = pair.lr?.uri ?? null;
  await check(w);
  await apiReads(w);
  for (const a of actions) {
    await p2Act(w, a);
  }
  await settleP2(w);
  quiescence(w);
  return w;
}

const P2_CASES = 30;

describe("instance moderation P2: federation while decisions are in force, against the policy and a peer", () => {
  it("agrees with the policy after every step and with R1's Mastodon server once settled", async () => {
    await fc.assert(
      fc.asyncProperty(seedArb, fc.array(p2Arb, { minLength: 12, maxLength: 20 }), async (seed, actions) => {
        merge("P2", (await runP2(seed, actions)).stats);
      }),
      runs(P2_CASES, SEED),
    );
    console.log("instance moderation P2 coverage", JSON.stringify(STATS.P2, null, 1));
  }, 600_000);
});

// ---------------------------------------------------------------------------------------------------------------
// Deterministic witnesses through the same harness (every step checked against the policy, rounds by the ledger)
// ---------------------------------------------------------------------------------------------------------------

const without = (...gens: string[]): Seed => ({ ...ALL, follows: SEEDS.map((g) => !gens.includes(g)) });
const block = (domain: Domain, severity: "suspend" | "noop" | "silence" = "suspend", rejectReports = false): Admin => ({
  k: "create",
  domain,
  severity,
  rejectReports,
});
const ROUND: Rounds = { k: "round" };

async function steps(w: World, actions: readonly P2Action[]): Promise<void> {
  for (const a of actions) {
    await p2Act(w, a);
  }
}

async function p1World(seed: Seed = ALL): Promise<World> {
  const w = await setup(seed);
  await check(w);
  return w;
}

const source = (w: World, r: Remote) => w.last!.remotes.find((a) => a.id === w.remoteIds[r])?.source ?? null;
const domainJob = (w: World) => w.last!.jobs.find((j) => j.kind === "domain");

describe("instance moderation witnesses: decisions", () => {
  // Witness 1 (visibility.md, "Precedence"): a child noop created before the parent's suspend exempts R2; the
  // reverse order answers 422 exists; moving a child from suspend to noop resets the job, which clears R2's mark.
  it("a child noop exempts its subdomain only when created first; a child moved to noop clears its mark", async () => {
    const w = await p1World();
    await steps(w, [block(SUB, "noop"), block(D)]);
    await settle(w);
    expect(w.policy.available("R2")).toBe(true);
    expect(source(w, "R2")).toBeNull();
    const v = await p1World();
    await steps(v, [block(D), block(SUB, "noop")]);
    expect(v.trace.at(-1)).toBe("  -> 422");
    await steps(v, [block(SUB), ...Array.from({ length: 4 }, () => ROUND)]);
    expect(source(v, "R2")).toBe("domain");
    await steps(v, [{ k: "update", i: 1, severity: "noop", flag: null, value: false }]);
    expect(domainJob(v)?.phase).toBe("clear");
    await settle(v);
    expect(source(v, "R2")).toBeNull();
    expect(v.stats["mark cleared"]).toBe(1);
    // A stricter child under a suspend parent covers no new host: no reset.
    await steps(v, [{ k: "delete", i: 1 }]);
    await settle(v);
    await steps(v, [block(SUB)]);
    expect(v.trace.at(-1)).toBe("  -> 200");
    expect(v.last!.jobs).toEqual([]);
  }, 60_000);

  // Witness 2 (visibility.md, the remote suspension paragraphs): a domain mark alone cannot be unsuspended; an
  // individual suspension under the block converts; an unblock clears the mark and ends the account job.
  it("a domain mark answers 403; a covered unsuspension converts; an unblock clears the mark", async () => {
    const w = await p1World();
    await steps(w, [block(D)]);
    await settle(w);
    await unsuspend(w, "R1");
    expect(w.trace.at(-1)).toBe("  -> 403");
    await steps(w, [
      { k: "suspend", r: "R1" },
      { k: "unsuspend", i: 0 },
    ]);
    expect(w.stats["unsuspension converted"]).toBe(1);
    expect(source(w, "R1")).toBe("domain");
    expect(w.last!.jobs.map((j) => [j.kind, j.mode])).toEqual([["account", "domain"]]);
    await steps(w, [{ k: "delete", i: 0 }]);
    await settle(w);
    expect(source(w, "R1")).toBeNull();
    expect(w.stats["job ended account"]).toBeGreaterThanOrEqual(1);
  }, 60_000);

  // Witness 9 (visibility.md: "flags and obfuscate reset nothing"; "silence answers 422").
  it("flag and obfuscate toggles reset nothing, and silence changes nothing", async () => {
    const w = await p1World();
    await steps(w, [block(D)]);
    await settle(w);
    for (const flag of ["reject_media", "reject_reports", "obfuscate"] as const) {
      await steps(w, [{ k: "update", i: 0, severity: null, flag, value: true }]);
      expect(w.last!.jobs).toEqual([]);
    }
    await steps(w, [{ k: "update", i: 0, severity: "silence", flag: null, value: false }, block(OTHER, "silence")]);
    expect(w.trace.filter((line) => line === "  -> 422")).toHaveLength(2);
    expect(w.last!.jobs).toEqual([]);
  }, 60_000);

  // Witness 10 (VIS-29's fence; reports.ts:92-98): a report of a suspended account is not found; a report filed after
  // the unsuspension is resolved by the next suspension's fence, and so is one of an account suspended already.
  it("report fences: refused while suspended, resolved by a later suspension, also of a suspended account", async () => {
    const w = await p1World({ ...ALL, reports: [false, false] });
    await steps(w, [
      { k: "suspend", r: "R1" },
      { k: "report", r: "R1" },
    ]);
    expect(w.trace.at(-1)).toBe("  -> null");
    expect(w.policy.reports).toEqual([]);
    await steps(w, [
      { k: "unsuspend", i: 0 },
      { k: "report", r: "R1" },
      { k: "suspend", r: "R1" },
    ]);
    await settle(w);
    expect(w.policy.reports.map((r) => r.resolved)).toEqual([true]);
    // Re-fencing: a report of the still suspended account, then a suspension again.
    const [reporter] = await sql<{ id: string }>(w.store, "SELECT account_id AS id FROM reports");
    await sql(
      w.store,
      "INSERT INTO reports (id, account_id, target_account_id, uri, created_at) VALUES (900, ?, ?, ?, ?)",
      reporter!.id,
      w.remoteIds.R1,
      "https://kopje.test/reports/900",
      new Date(NOW).toISOString(),
    );
    w.reportIds.set("900", "seeded");
    w.policy.reports.push({ label: "seeded", target: "R1", resolved: false });
    await check(w);
    await steps(w, [{ k: "suspend", r: "R1" }]);
    await settle(w);
    expect(w.policy.reports.map((r) => r.resolved)).toEqual([true, true]);
  }, 60_000);

  // Witness 4 (visibility.md, "clear"): after an unblock, R1's document under the stored revision clears its stale
  // mark before the clear round; a superseded one clears nothing.
  it("an unblock, then R1's document: a superseded one clears nothing, a current one clears the mark", async () => {
    const w = await p1World();
    await steps(w, [block(D)]);
    await settle(w);
    await steps(w, [{ k: "delete", i: 0 }]);
    await document(w, "R1", "name", true);
    expect(source(w, "R1")).toBe("domain");
    await document(w, "R1", "name", false);
    expect(source(w, "R1")).toBeNull();
    await settle(w);
  }, 60_000);

  // Witness 7 (visibility.md, "Writes"): no account is stored into a covered domain or host; one stored first is
  // marked by the next block.
  it("R5 on a covered host is not stored; stored first, it is marked by the next block", async () => {
    const w = await p1World();
    await steps(w, [block(D)]);
    await document(w, "R5", "name", false);
    expect(w.remoteIds.R5).toBeNull();
    expect(w.trace.at(-1)).toBe('  -> "actor-suspended"');
    const v = await p1World();
    await document(v, "R5", "name", false);
    expect(v.remoteIds.R5).not.toBeNull();
    await steps(v, [block(D)]);
    await settle(v);
    expect(source(v, "R5")).toBe("domain");
  }, 60_000);

  // Witness 8 (visibility.md, "The admin API": reject_reports reads the reporter's stored domain only).
  it("reject_reports refuses by the stored domain; a suspend refuses as actor-suspended", async () => {
    const w = await p1World();
    await steps(w, [block(D, "noop", true), { k: "flag", r: "R1" }, { k: "flag", r: "R3" }]);
    expect(w.stats["flag reports-rejected"]).toBe(1);
    expect(w.stats["flag filed"]).toBe(1);
    await steps(w, [
      { k: "update", i: 0, severity: "suspend", flag: null, value: false },
      { k: "flag", r: "R3" },
    ]);
    expect(w.stats["flag actor-suspended"]).toBe(1);
  }, 60_000);

  // Witness 6 (visibility.md: a routing refresh; ID-1): only the individually suspended, uncovered account under the
  // stored revision takes it, its routing only; the severing Reject then uses the new inbox.
  it("a routing refresh applies to an individually suspended, uncovered account only", async () => {
    const w = await p1World(without("R2>L1", "R4>L1"));
    await steps(w, [{ k: "suspend", r: "R1" }]);
    const route = async (stale: boolean) => {
      const before = w.policy.remotes.R1.sharedInbox;
      await document(w, "R1", "routing", stale);
      return w.policy.remotes.R1.sharedInbox !== before;
    };
    expect(await route(true)).toBe(false);
    expect(await route(false)).toBe(true);
    await document(w, "R1", "name", false);
    await document(w, "R1", "key", false);
    expect(w.policy.remotes.R1).toMatchObject({ name: "R1", keys: ["R1-key-0"] });
    await settle(w);
    expect(w.sent.filter((s) => s.type === "Reject").map((s) => s.remote)).toEqual(["R1"]);
    expect(w.stats["known defect G3F"]).toBeGreaterThan(0);
    // Covered: nothing changes.
    await steps(w, [block(D)]);
    expect(await route(false)).toBe(false);
  }, 60_000);

  // Witness 5 (threat-model.md VIS-30: "confirmation is the send boundary").
  it("a block between claim and confirmation drops a Follow; one after confirmation sends it", async () => {
    const w = await p1World(without("L1>R1"));
    await steps(w, [{ k: "follow", r: "R1" }, { k: "claim" }, block(D), { k: "confirm", i: 0 }]);
    expect(w.stats["dropped at confirm: Follow"]).toBe(1);
    const v = await p1World();
    await steps(v, [{ k: "answer", r: "R1", accept: true }, { k: "claim" }, { k: "confirm", i: 0 }, block(D)]);
    await steps(v, [{ k: "complete", i: 0 }]);
    expect(v.sent.map((s) => s.type)).toEqual(["Accept"]);
  }, 60_000);
});

describe("instance moderation witnesses: federation with R1's server", () => {
  const peerSeed = without("R1>L1", "L1>R1");

  // Witness 11 (NET-2): R1's Undo of the severed generation cancels the severing Reject not yet confirmed.
  it("an Undo cancels a severing Reject not yet sent", async () => {
    const w = await runP2(without("L1>R1"), [
      { k: "suspend", r: "R1" },
      ROUND,
      ROUND,
      { k: "peerUnfollow" },
      { k: "deliver" },
    ]);
    expect(w.sent.filter((s) => s.type === "Reject" && s.local === "L1")).toEqual([]);
  }, 60_000);

  it("an Undo while the severing Reject is leased drops it at confirmation", async () => {
    const w = await runP2(without("L1>R1"), [
      { k: "suspend", r: "R1" },
      ROUND,
      ROUND,
      { k: "claim" },
      { k: "peerUnfollow" },
      { k: "deliver" },
      { k: "confirm", i: 0 },
    ]);
    expect(w.sent.filter((s) => s.type === "Reject" && s.local === "L1")).toEqual([]);
  }, 60_000);

  it("a severing Reject confirmed before the Undo is sent (the NET-2 risk)", async () => {
    const w = await runP2(without("L1>R1"), [
      { k: "suspend", r: "R1" },
      ROUND,
      ROUND,
      { k: "claim" },
      { k: "confirm", i: 0 },
      { k: "peerUnfollow" },
      { k: "deliver" },
    ]);
    expect(w.sent.filter((s) => s.type === "Reject" && s.local === "L1")).toHaveLength(1);
  }, 60_000);

  // X1 (accepted risk): R1's Follow arriving while it is suspended is ignored with no answer.
  it("X1: a Follow received while suspended stays requested at R1's server", async () => {
    const w = await runP2(peerSeed, [
      { k: "suspend", r: "R1" },
      { k: "peerFollow" },
      { k: "deliver" },
      { k: "unsuspend", i: 0 },
    ]);
    expect(w.stats["exception X1"]).toBe(1);
  }, 60_000);

  // X1, the late answer: an Accept of h, confirmed before Kopje received g, applied to g by the pair at R1's server.
  it("X1: an earlier Accept processed late accepts the ignored generation at R1's server", async () => {
    const w = await runP2(peerSeed, [
      { k: "peerFollow" },
      { k: "deliver" },
      { k: "send" },
      { k: "peerUnfollow" },
      { k: "peerFollow" },
      { k: "deliver" },
      { k: "suspend", r: "R1" },
      { k: "deliver" },
      { k: "process" },
      { k: "unsuspend", i: 0 },
    ]);
    expect(w.stats["exception X1-late-answer"]).toBe(1);
  }, 60_000);

  // X2 (accepted risk): R1's Accept of L1's follow, received while R1 is suspended, is ignored.
  it("X2: an Accept received while suspended leaves L1's follow pending", async () => {
    const w = await runP2(peerSeed, [
      { k: "follow", r: "R1" },
      { k: "send" },
      { k: "suspend", r: "R1" },
      { k: "process" },
      { k: "deliver" },
      { k: "unsuspend", i: 0 },
    ]);
    expect(w.stats["exception X2"]).toBe(1);
  }, 60_000);

  // X3 (#1422, a known defect): L1's Follow queued at the suspension is dropped at send time and never sent again.
  it("X3 (#1422): a Follow dropped at send time leaves L1's follow pending forever", async () => {
    const w = await runP2(peerSeed, [
      { k: "follow", r: "R1" },
      { k: "suspend", r: "R1" },
      { k: "claim" },
      { k: "unsuspend", i: 0 },
    ]);
    expect(w.stats["dropped at claim: Follow"]).toBe(1);
    expect(w.stats["exception X3"]).toBe(1);
  }, 60_000);

  // X5 (#1423, a known defect): R1's Accept dropped during a short suspension, ended before its severing round.
  it("X5 (#1423): an Accept dropped during a short suspension leaves R1's server with a request", async () => {
    const w = await runP2(peerSeed, [
      { k: "peerFollow" },
      { k: "deliver" },
      { k: "suspend", r: "R1" },
      { k: "claim" },
      { k: "unsuspend", i: 0 },
    ]);
    expect(w.stats["dropped at claim: Accept"]).toBe(1);
    expect(w.stats["exception X5"]).toBe(1);
  }, 60_000);

  // X4 (#1424, a known defect): an individual suspension deletes R1's pending request to locked L2 without a Reject
  // and retracts its id, so R1's server keeps the request, and a redelivery of it is refused.
  it("X4 (#1424): a suspension deletes a pending request with no Reject, and retracts its id", async () => {
    const w = await p1World();
    await steps(w, [{ k: "suspend", r: "R1" }, ROUND, ROUND, { k: "unsuspend", i: 0 }]);
    await settle(w);
    const uri = `${SPEC.R1.uri}#follows/seed-L2`;
    expect(projection(w, w.last!).follows.some((f) => f.gen === "R1>L2")).toBe(false);
    expect(w.sent.some((s) => s.local === "L2")).toBe(false);
    const again = await storeReceive(
      w.store,
      SPEC.R1.uri,
      { type: "Follow", id: uri, object: w.localUris.L2 },
      w.clock,
    );
    expect(again.reason).toBe("retracted");
  }, 60_000);

  // G3F (#1425, a known defect): the severing Reject goes to R1's shared inbox.
  it("G3F (#1425): the severing Reject's row is at the shared inbox", async () => {
    const w = await p1World(without("R2>L1", "R4>L1"));
    await steps(w, [{ k: "suspend", r: "R1" }, ROUND, ROUND]);
    expect(w.last!.lanes.filter((row) => row.type === "Reject").map((row) => row.inbox)).toEqual([SPEC.R1.shared]);
    expect(w.stats["known defect G3F"]).toBeGreaterThan(0);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------------------
// Read-cap fixtures (F1-F7) and witnesses on stores seeded by SQL, as test/domain-job.test.ts seeds them: single
// rounds through remoteModerationRound, each checked by the ledger and the frontier. Each expected count comes from
// the fixture's own seed, never from the constant it binds.
// ---------------------------------------------------------------------------------------------------------------

async function bare() {
  const base = await adminWorld();
  const none = Object.fromEntries(REMOTES.map((r) => [r, null])) as Record<Remote, string | null>;
  return {
    ...base,
    store: base.h.store,
    clock: NOW,
    remoteIds: none,
    last: null as State | null,
    fences: new Map<string, JobRow>(),
  };
}

type Bare = Awaited<ReturnType<typeof bare>>;

// `n` remote accounts on `domain` with ids from `base` + 1, each with its personal inbox; marked when asked.
async function remotesOn(f: Bare, n: number, domain: string, base: bigint, marked = false): Promise<void> {
  await sql(
    f.store,
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
		INSERT INTO accounts (id, uri, username, domain, created_at, inbox_url, suspended_at, suspension_source)
		SELECT printf('%018d', CAST(?2 AS INTEGER) + i), 'https://' || ?3 || '/users/u' || (CAST(?2 AS INTEGER) + i),
			'u' || i, ?3, ?4, 'https://' || ?3 || '/users/u' || (CAST(?2 AS INTEGER) + i) || '/inbox',
			CASE WHEN ?5 THEN ?4 END, CASE WHEN ?5 THEN 'domain' END FROM n`,
    n,
    String(base),
    domain,
    new Date(NOW).toISOString(),
    marked ? 1 : 0,
  );
}

// `n` local accounts with ids from 500000000000000000, each with its local_accounts row.
async function localsOf(f: Bare, n: number): Promise<string[]> {
  await sql(
    f.store,
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
		INSERT INTO accounts (id, uri, username, created_at) SELECT printf('%018d', 500000000000000000 + i),
			'https://kopje.test/ap/users/l' || i, 'l' || i, ?2 FROM n`,
    n,
    new Date(NOW).toISOString(),
  );
  await sql(
    f.store,
    `INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey)
		SELECT id, username || '@example.com', X'00', X'00', 'test' FROM accounts WHERE id LIKE '5000%'`,
  );
  return (await sql<{ id: string }>(f.store, "SELECT id FROM accounts WHERE id LIKE '5000%' ORDER BY id")).map(
    (row) => row.id,
  );
}

// Every local account in `locals` follows `target` (accepted), or `follower` asks to follow each (pending).
async function followsOf(f: Bare, edges: { follower: string; target: string; state: string }[]): Promise<void> {
  await sql(
    f.store,
    `INSERT INTO follows (account_id, target_account_id, state, created_at)
		SELECT json_extract(value, '$.follower'), json_extract(value, '$.target'), json_extract(value, '$.state'), ?2
		FROM json_each(?1)`,
    JSON.stringify(edges),
    new Date(NOW).toISOString(),
  );
}

const count = async (f: Bare, query: string, ...params: SqlStorageValue[]) =>
  (await sql<{ n: number }>(f.store, `SELECT count(*) AS n FROM (${query})`, ...params))[0]!.n;

const markedOn = (f: Bare, domain: string) =>
  count(f, "SELECT 1 FROM accounts WHERE domain = ? AND suspension_source = 'domain'", domain);

async function fixtureRead(f: Bare): Promise<State> {
  f.last ??= await read(f);
  return f.last;
}

// One round through the ledger, with the rows it wrote.
async function fixtureRound(f: Bare): Promise<{ id: string } | null> {
  const before = await fixtureRead(f);
  const { result, rows } = await writtenBy(f.store, (db) => remoteModerationRound(db, f.clock));
  const now = await read(f);
  const failures = ledgerCheck({
    before: { jobs: before.jobs, snap: before.snap },
    after: { jobs: now.jobs, snap: now.snap },
    ran: result?.id ?? null,
    rows,
    caps: CAPS,
    now: f.clock,
  });
  expect(failures).toEqual([]);
  f.last = now;
  return result;
}

async function fixtureDrain(f: Bare): Promise<void> {
  for (let i = 0; (await fixtureRound(f)) !== null; i++) {
    expect(i).toBeLessThan(SETTLE_ROUNDS);
  }
  expect(settlementFailures(f.last!.snap, f.fences)).toEqual([]);
}

// A decision through the admin API; the store's state is read again after it.
async function decide(f: Bare, path: string, init: RequestInit): Promise<number> {
  const response = await f.h.request(path, bearer(f.admin, init));
  f.last = await read(f);
  if (path.endsWith("/action")) {
    for (const job of f.last.jobs.filter((j) => j.kind === "account")) {
      f.fences.set(job.subject, job);
    }
  }
  return response.status;
}

const blockOf = (f: Bare, domain: string) =>
  decide(f, "/api/v1/admin/domain_blocks", json({ domain, severity: "suspend" }));

async function unblock(f: Bare, domain: string): Promise<number> {
  const [row] = await sql<{ id: number }>(f.store, "SELECT id FROM instance_domain_blocks WHERE domain = ?", domain);
  return decide(f, `/api/v1/admin/domain_blocks/${row!.id}`, { method: "DELETE" });
}

const suspendOf = (f: Bare, id: string) => decide(f, `/api/v1/admin/accounts/${id}/action`, form({ type: "suspend" }));
const unsuspendOf = (f: Bare, id: string) => decide(f, `/api/v1/admin/accounts/${id}/unsuspend`, { method: "POST" });

async function adminIds(f: Bare): Promise<string[] | 503> {
  const ids: string[] = [];
  let path: string | null = "/api/v2/admin/accounts?status=suspended";
  while (path !== null) {
    const response = await f.h.request(path, bearer(f.admin));
    if (response.status === 503) {
      return 503;
    }
    ids.push(...(await response.json<{ id: string }[]>()).map((a) => a.id));
    const next = response.headers.get("Link")?.match(/<([^>]+)>; rel="next"/)?.[1] ?? null;
    path = next === null ? null : new URL(next).pathname + new URL(next).search;
  }
  return ids.toSorted();
}

const COVERED = 700_000_000_000_000_000n;

describe("instance moderation read caps (F1-F7)", () => {
  // F1, MARK_ACCOUNTS: 101 covered accounts and no follows (no other cap binds first).
  it("F1: the first mark round marks exactly 100 of 101 covered accounts; the admin list answers 503 meanwhile", async () => {
    const f = await bare();
    await remotesOn(f, 101, D, COVERED);
    await blockOf(f, D);
    await fixtureRound(f);
    await fixtureRound(f);
    expect(await markedOn(f, D)).toBe(101 - 1);
    expect(await adminIds(f)).toBe(503);
    await fixtureDrain(f);
    expect(await adminIds(f)).toHaveLength(101);
  }, 120_000);

  // F2, SEVER_ROUND: one covered account's 101 pending requests to 101 local accounts, with no uri and no
  // notification, about one row each, so the row cap does not bind first.
  it("F2: a round severs exactly 100 of 101 follows", async () => {
    const f = await bare();
    await remotesOn(f, 1, D, COVERED);
    const locals = await localsOf(f, 101);
    const r = (COVERED + 1n).toString();
    await followsOf(
      f,
      locals.map((target) => ({ follower: r, target, state: "pending" })),
    );
    await blockOf(f, D);
    await fixtureRound(f);
    await fixtureRound(f);
    expect(await count(f, "SELECT 1 FROM follows WHERE account_id = ?", r)).toBe(1);
    await fixtureDrain(f);
  }, 120_000);

  // F3, CLEAR_ROUND: 501 stale domain marks (no block covers their domain); a transition elsewhere resets the job.
  it("F3: the first clear round clears exactly 500 of 501 stale marks", async () => {
    const f = await bare();
    await remotesOn(f, 501, "stale.example", COVERED, true);
    await blockOf(f, OTHER);
    await fixtureRound(f);
    expect(await markedOn(f, "stale.example")).toBe(1);
    await fixtureDrain(f);
  }, 120_000);

  // F4, MARK_WINDOW: 2,000 accounts in all (the local and instance rows included) before one covered account.
  it("F4: the first mark round walks exactly 2,000 accounts and stops before the 2,001st", async () => {
    const f = await bare();
    const existing = await count(f, "SELECT 1 FROM accounts");
    await remotesOn(f, 2_000 - existing, "filler.example", 200_000_000_000_000_000n);
    await remotesOn(f, 1, D, COVERED);
    const [last] = await sql<{ id: string }>(f.store, "SELECT id FROM accounts ORDER BY id LIMIT 1 OFFSET 1999");
    await blockOf(f, D);
    await fixtureRound(f);
    await fixtureRound(f);
    expect(await markedOn(f, D)).toBe(0);
    expect(JSON.parse(f.last!.jobs[0]!.cursor)).toEqual({ after: last!.id });
    await fixtureRound(f);
    expect(await markedOn(f, D)).toBe(1);
    await fixtureDrain(f);
  }, 120_000);

  // F5, REPORT_ROUND: 101 reports of one account, all inside its suspension's fence.
  it("F5: the first reports round resolves exactly 100 of 101 reports", async () => {
    const f = await bare();
    await remotesOn(f, 1, OTHER, COVERED);
    const r = (COVERED + 1n).toString();
    await sql(
      f.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i <= 100)
			INSERT INTO reports (account_id, target_account_id, uri, created_at)
			SELECT ?1, ?2, 'https://kopje.test/reports/' || i, ?3 FROM n`,
      f.alice.id,
      r,
      new Date(NOW).toISOString(),
    );
    await suspendOf(f, r);
    await fixtureRound(f);
    expect(await count(f, "SELECT 1 FROM reports WHERE action_taken_at IS NULL")).toBe(1);
    await fixtureDrain(f);
  }, 120_000);

  // F6, MODERATION_ROUNDS: five suspended accounts with a report each; one call of the opaque rounds.
  it("F6: one runModerationJobs call resolves the reports of exactly four of five accounts", async () => {
    const f = await bare();
    await remotesOn(f, 5, OTHER, COVERED);
    for (let i = 1n; i <= 5n; i++) {
      const r = (COVERED + i).toString();
      await sql(
        f.store,
        "INSERT INTO reports (account_id, target_account_id, uri, created_at) VALUES (?, ?, ?, ?)",
        f.alice.id,
        r,
        `https://kopje.test/reports/${i}`,
        new Date(NOW).toISOString(),
      );
      await suspendOf(f, r);
    }
    const before = await fixtureRead(f);
    await f.h.store.runModerationJobs(BUILD, { now: NOW });
    const now = await read(f);
    expect(
      ledgerCheck({
        before: { jobs: before.jobs, snap: before.snap },
        after: { jobs: now.jobs, snap: now.snap },
        ran: null,
        rows: null,
        caps: CAPS,
        now: NOW,
      }),
    ).toEqual([]);
    f.last = now;
    expect(await count(f, "SELECT 1 FROM reports WHERE action_taken_at IS NULL")).toBe(5 - 4);
    await fixtureDrain(f);
  }, 120_000);

  // F7, progress without change (threat-model.md: every batch moves a cursor, a phase or a row on): 201 covered
  // accounts marked already and without follows, then one unmarked.
  it("F7: two mark rounds change nothing but their cut; the third marks the last account", async () => {
    const f = await bare();
    await remotesOn(f, 201, D, COVERED, true);
    await remotesOn(f, 1, D, COVERED + 1_000n);
    await blockOf(f, D);
    await fixtureRound(f);
    const unchanged = async () => {
      const before = f.last!;
      await fixtureRound(f);
      const { jobs: _jobs, snap: _snap, ...rest } = f.last!;
      const { jobs: _was, snap: _wasSnap, ...was } = before;
      expect(rest).toEqual(was);
      expect(f.last!.jobs[0]!.cursor).not.toBe(before.jobs[0]!.cursor);
    };
    await unchanged();
    await unchanged();
    expect(await markedOn(f, D)).toBe(201);
    await fixtureRound(f);
    expect(await markedOn(f, D)).toBe(202);
  }, 120_000);
});

describe("instance moderation witnesses: walks", () => {
  // Witness 3 (visibility.md: "An individually suspended account is skipped"): a suspension while the domain job is
  // inside R1's in side resumes nothing; R1's own job severs out only.
  it("a suspension during the domain job's severing of an account resumes nothing", async () => {
    const f = await bare();
    await remotesOn(f, 1, D, COVERED);
    const r = (COVERED + 1n).toString();
    const locals = await localsOf(f, 150);
    await followsOf(
      f,
      locals.map((follower) => ({ follower, target: r, state: "accepted" })),
    );
    await blockOf(f, D);
    await fixtureRound(f);
    await fixtureRound(f);
    const left = await count(f, "SELECT 1 FROM follows WHERE target_account_id = ?", r);
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThan(150);
    expect(JSON.parse(f.last!.jobs[0]!.cursor)).toMatchObject({ severing: r, side: { dir: "in" } });
    await suspendOf(f, r);
    await fixtureDrain(f);
    expect(await count(f, "SELECT 1 FROM follows WHERE target_account_id = ?", r)).toBe(left);
  }, 120_000);

  // Witness 14(a): a mark round crosses R1 only once it has marked and severed it, so a later unblock cannot hide
  // a skip.
  it("a skipped account cannot hide behind a later unblock", async () => {
    const w = await p1World();
    await steps(w, [block(D), ROUND, ROUND, { k: "delete", i: 0 }]);
    expect(w.severedByRound.has("R1>L1")).toBe(true);
    await settle(w);
  }, 60_000);

  // Witness 14(b): a round that reconciles R1 and stops inside R2 (150 local followers) has crossed R1.
  it("a cut inside a later account has crossed every account before it", async () => {
    const f = await bare();
    await remotesOn(f, 2, D, COVERED);
    const [r1, r2] = [(COVERED + 1n).toString(), (COVERED + 2n).toString()];
    const locals = await localsOf(f, 150);
    await followsOf(f, [
      { follower: locals[0]!, target: r1, state: "accepted" },
      ...locals.map((follower) => ({ follower, target: r2, state: "accepted" })),
    ]);
    await blockOf(f, D);
    await fixtureRound(f);
    await fixtureRound(f);
    expect(JSON.parse(f.last!.jobs[0]!.cursor)).toMatchObject({ after: r1, severing: r2 });
    await unblock(f, D);
    expect(await count(f, "SELECT 1 FROM follows WHERE target_account_id = ?", r1)).toBe(0);
    await fixtureDrain(f);
  }, 120_000);

  // Witness 14(c): the domain walk passes an individually suspended account; once converted, its own job severs it,
  // and that is no failure of the walk.
  it("a passed individually suspended account is severed by its converted job", async () => {
    const f = await bare();
    await remotesOn(f, 1, D, COVERED);
    await remotesOn(f, 100, D, COVERED + 10n);
    const r = (COVERED + 1n).toString();
    await followsOf(f, [{ follower: f.alice.id, target: r, state: "accepted" }]);
    await suspendOf(f, r);
    await fixtureDrain(f);
    await blockOf(f, D);
    await fixtureRound(f);
    await fixtureRound(f);
    expect(f.last!.jobs.map((j) => j.kind)).toEqual(["domain"]);
    expect(await unsuspendOf(f, r)).toBe(200);
    expect(f.last!.jobs.map((j) => [j.kind, j.mode])).toEqual([
      ["domain", "domain"],
      ["account", "domain"],
    ]);
    await fixtureDrain(f);
    expect(await count(f, "SELECT 1 FROM follows WHERE target_account_id = ?", r)).toBe(0);
  }, 120_000);

  // The account job's walk over more follows than a round reads (SEVER_ROUND): it ends only once all are severed.
  it("an account job severs its follows across rounds, and a suspension again restarts its walk", async () => {
    const f = await bare();
    await remotesOn(f, 1, OTHER, COVERED);
    const r = (COVERED + 1n).toString();
    const locals = await localsOf(f, 150);
    await followsOf(
      f,
      locals.map((target) => ({ follower: r, target, state: "pending" })),
    );
    await suspendOf(f, r);
    await fixtureRound(f);
    await fixtureRound(f);
    const left = await count(f, "SELECT 1 FROM follows WHERE account_id = ?", r);
    expect(left).toBeGreaterThan(0);
    expect(f.last!.jobs[0]).toMatchObject({ phase: "follows" });
    expect(f.last!.jobs[0]!.cursor).not.toBe("");
    // A report of the still suspended account, then a suspension again: its walk starts over, reports first.
    await sql(
      f.store,
      "INSERT INTO reports (account_id, target_account_id, uri, created_at) VALUES (?, ?, ?, ?)",
      f.alice.id,
      r,
      "https://kopje.test/reports/again",
      new Date(NOW).toISOString(),
    );
    await suspendOf(f, r);
    expect(f.last!.jobs[0]).toMatchObject({ phase: "reports", cursor: "" });
    await fixtureDrain(f);
    expect(await count(f, "SELECT 1 FROM follows WHERE account_id = ?", r)).toBe(0);
    expect(await count(f, "SELECT 1 FROM reports WHERE action_taken_at IS NULL")).toBe(0);
  }, 120_000);

  // Witness 12 (threat-model.md RES-5): a round that fails after its writes is rolled back and backs off; an unchanged
  // decision leaves its retry state, a new one makes it fresh.
  it("a failed round is rolled back, backs off, and is made fresh by a new decision", async () => {
    const f = await bare();
    await remotesOn(f, 1, D, COVERED);
    const r = (COVERED + 1n).toString();
    await followsOf(f, [{ follower: f.alice.id, target: r, state: "accepted" }]);
    await blockOf(f, D);
    await fixtureRound(f);
    await sql(
      f.store,
      `CREATE TRIGGER test_round_fails BEFORE UPDATE ON remote_moderation_jobs WHEN NEW.attempts = OLD.attempts
			AND NEW.phase = 'mark' BEGIN SELECT RAISE(ABORT, 'test: the round fails'); END`,
    );
    await sql(
      f.store,
      "CREATE TRIGGER test_round_ends BEFORE DELETE ON remote_moderation_jobs BEGIN SELECT RAISE(ABORT, 'test: the round fails'); END",
    );
    const error = console.error;
    console.error = () => {};
    try {
      await fixtureRound(f);
    } finally {
      console.error = error;
    }
    const [job] = f.last!.jobs;
    expect(job).toMatchObject({ phase: "mark", attempts: 1 });
    // The batch is rolled back whole: the mark too.
    expect(await markedOn(f, D)).toBe(0);
    expect(await count(f, "SELECT 1 FROM follows WHERE target_account_id = ?", r)).toBe(1);
    const entity = await f.h.request(`/api/v1/accounts/${r}`, bearer(f.alice.token));
    expect((await entity.json<{ suspended?: boolean }>()).suspended).toBe(true);
    expect((await f.h.store.runModerationJobs(BUILD, { now: NOW })).pending).toBe(false);
    const [row] = await sql<{ id: number }>(f.store, "SELECT id FROM instance_domain_blocks");
    await decide(f, `/api/v1/admin/domain_blocks/${row!.id}`, json({ severity: "suspend" }, { method: "PUT" }));
    expect(f.last!.jobs[0]).toMatchObject({ attempts: 1 });
    await blockOf(f, OTHER);
    expect(f.last!.jobs[0]).toMatchObject({ attempts: 0, phase: "clear" });
    await sql(f.store, "DROP TRIGGER test_round_fails");
    await sql(f.store, "DROP TRIGGER test_round_ends");
    await fixtureDrain(f);
    expect(await count(f, "SELECT 1 FROM follows WHERE target_account_id = ?", r)).toBe(0);
  }, 120_000);
});

// Witness 13: routing changes with activities outstanding, on R1's one origin (one lane). Outside the generated runs,
// whose one-row lane model they leave (each intent's rows are asserted here).
describe("instance moderation witnesses: routing with activities outstanding", () => {
  const rows = (w: World) =>
    w.last!.lanes.filter((row) => row.account === w.ids.L1).map((row) => [row.type, row.inbox, row.state]);
  const moveShared = async (w: World) => {
    const a = w.policy.remotes.R1;
    const doc = { name: a.name, keys: a.keys, inbox: a.inbox, sharedInbox: "https://d.example/inbox-b" };
    const [row] = await sql<{ revision: number }>(
      w.store,
      "SELECT document_revision AS revision FROM accounts WHERE id = ?",
      w.remoteIds.R1,
    );
    const result = await w.store.receiveActivity(BUILD, {
      now: w.clock,
      origin: "https://kopje.test",
      actorUri: a.uri,
      actor: documentOf(w, "R1", doc),
      actorRevision: row!.revision,
      activity: { type: "UpdateActor", id: "https://d.example/updates/b" },
    });
    w.last = await read(w);
    return result.reason;
  };
  // Rounds of the remote jobs, each within the row budget.
  const boundedRounds = async (w: World, n: number) => {
    for (let i = 0; i < n; i++) {
      const { rows } = await writtenBy(w.store, (db) => remoteModerationRound(db, w.clock));
      expect(rows).toBeLessThanOrEqual(MODERATION_ROUND_ROWS);
    }
  };
  const accepted = async () => {
    const w = await setup(without("R1>L1", "L1>R1"));
    await storeReceive(
      w.store,
      SPEC.R1.uri,
      { type: "Follow", id: `${SPEC.R1.uri}#follows/g`, object: w.localUris.L1 },
      w.clock,
    );
    w.last = await read(w);
    expect(rows(w)).toEqual([["Accept", SPEC.R1.shared, "pending"]]);
    return w;
  };

  it("(a) a removal's withdrawing Reject reaches the new shared inbox and the Accept's", async () => {
    const w = await accepted();
    expect(await moveShared(w)).toBe("actor-updated");
    await call(w, `/api/v1/accounts/${w.remoteIds.R1}/remove_from_followers`, json({}), w.tokens.L1);
    w.last = await read(w);
    expect(rows(w)).toEqual([
      ["Accept", SPEC.R1.shared, "pending"],
      ["Reject", SPEC.R1.shared, "queued"],
      ["Reject", "https://d.example/inbox-b", "queued"],
    ]);
    // Both Reject rows are delivered, in lane order (the superseded Accept is dropped at its claim): the first one
    // settling leaves the activity to the second.
    const sent: [string, string][] = [];
    for (let i = 0; i < 5 && (await sql(w.store, "SELECT 1 FROM deliveries")).length > 0; i++) {
      const token = `lease-a${i}`;
      const [delivery] = (await w.store.claimDeliveries(BUILD, { now: w.clock, leaseToken: token, limit: 1 }))
        .deliveries;
      if (delivery === undefined) {
        continue;
      }
      const confirmed = await w.store.confirmDelivery(BUILD, { id: delivery.id, leaseToken: token, now: w.clock });
      if (confirmed.status === "send") {
        sent.push([(JSON.parse(confirmed.body) as Body).type, delivery.inbox]);
      }
      await w.store.completeDelivery(BUILD, { id: delivery.id, leaseToken: token, now: w.clock, outcome: OK });
    }
    expect(sent).toEqual([
      ["Reject", SPEC.R1.shared],
      ["Reject", "https://d.example/inbox-b"],
    ]);
    expect(await sql(w.store, "SELECT 1 FROM deliveries")).toEqual([]);
  }, 60_000);

  it("(b) a suspension's severing Reject, audienceOnly, has one row at the refreshed inbox", async () => {
    const w = await accepted();
    await call(w, `/api/v1/admin/accounts/${w.remoteIds.R1}/action`, form({ type: "suspend" }), w.admin);
    expect(await moveShared(w)).toBe("actor-suspended");
    await boundedRounds(w, 3);
    w.last = await read(w);
    expect(
      w.last.lanes.filter((row) => row.account === w.ids.L1).map((row) => [row.type, row.inbox, row.superseded]),
    ).toEqual([
      ["Accept", SPEC.R1.shared, 1],
      ["Reject", "https://d.example/inbox-b", 0],
    ]);
  }, 60_000);

  it("(c) an Accept leased at A when the severing Reject is recorded is dropped at confirmation", async () => {
    const w = await accepted();
    const claimed = await w.store.claimDeliveries(BUILD, { now: w.clock, leaseToken: "lease-c", limit: 1 });
    await call(w, `/api/v1/admin/accounts/${w.remoteIds.R1}/action`, form({ type: "suspend" }), w.admin);
    await moveShared(w);
    await boundedRounds(w, 3);
    const confirmed = await w.store.confirmDelivery(BUILD, {
      id: claimed.deliveries[0]!.id,
      leaseToken: "lease-c",
      now: w.clock,
    });
    expect(confirmed.status).toBe("dropped");
    w.last = await read(w);
    expect(rows(w)).toEqual([["Reject", "https://d.example/inbox-b", "pending"]]);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------------------
// Opaque calls, retries, revisions, domains, Create and the inbox rule
// ---------------------------------------------------------------------------------------------------------------

// One runModerationJobs call through the ledger (rule 3 for a call; rule 6 for its `pending`); its `pending`.
async function fixtureModeration(f: Bare): Promise<boolean> {
  const before = await fixtureRead(f);
  const { pending } = await f.h.store.runModerationJobs(BUILD, { now: f.clock });
  const now = await read(f);
  const failures = ledgerCheck({
    before: { jobs: before.jobs, snap: before.snap },
    after: { jobs: now.jobs, snap: now.snap },
    ran: null,
    rows: null,
    caps: CAPS,
    now: f.clock,
  });
  expect(failures).toEqual([]);
  expect(pending).toBe(pendingAt(now.jobs, f.clock));
  f.last = now;
  return pending;
}

// Runs `fn` while every update of a job row that leaves its attempts alone (its batch's save), or every delete of one
// (its end), fails, as test/remote-suspension.test.ts fails a round after its writes.
async function failing(f: Bare, writes: readonly ("update" | "delete")[], fn: () => Promise<void>): Promise<void> {
  const triggers = {
    update: `CREATE TRIGGER test_fails_update BEFORE UPDATE ON remote_moderation_jobs WHEN NEW.attempts = OLD.attempts
			BEGIN SELECT RAISE(ABORT, 'test: the round fails'); END`,
    delete: `CREATE TRIGGER test_fails_delete BEFORE DELETE ON remote_moderation_jobs
			BEGIN SELECT RAISE(ABORT, 'test: the round fails'); END`,
  };
  for (const write of writes) {
    await sql(f.store, triggers[write]);
  }
  const error = console.error;
  console.error = () => {};
  try {
    await fn();
  } finally {
    console.error = error;
    for (const write of writes) {
      await sql(f.store, `DROP TRIGGER test_fails_${write}`);
    }
  }
}

async function sendDocument(
  w: World,
  r: Remote,
  doc: Document,
  revision: number | null,
  confirmedDomain?: string,
): Promise<string> {
  const actor = { ...documentOf(w, r, doc), ...(confirmedDomain === undefined ? {} : { confirmedDomain }) };
  const uri = w.policy.remotes[r].uri;
  const result = await w.store.receiveActivity(BUILD, {
    now: w.clock,
    origin: "https://kopje.test",
    actorUri: uri,
    actor,
    actorRevision: revision,
    activity: { type: "UpdateActor", id: `${new URL(uri).origin}/updates/${++documentSequence}` },
  });
  return result.reason;
}

const revisionOf = async (w: World, r: Remote) =>
  (
    await sql<{ revision: number }>(
      w.store,
      "SELECT document_revision AS revision FROM accounts WHERE id = ?",
      w.remoteIds[r],
    )
  )[0]!.revision;

const rowOf = async (w: World, r: Remote) =>
  (
    await sql(
      w.store,
      "SELECT domain, display_name AS name, inbox_url AS inbox, shared_inbox_url AS shared FROM accounts WHERE id = ?",
      w.remoteIds[r],
    )
  )[0];

let statusSequence = 0;

// A public Create by `r` mentioning L1, through the inbox's gate: stored and notified for an available author only.
async function create(w: World, r: Remote): Promise<void> {
  const uri = w.policy.remotes[r].uri;
  const id = `${uri}/statuses/${++statusSequence}`;
  log(w, `${r} posts a mention of L1`);
  const result = await storeReceive(
    w.store,
    uri,
    {
      type: "Create",
      id: `${id}/activity`,
      object: {
        uri: id,
        url: null,
        attributedTo: uri,
        content: "<p>hello</p>",
        text: "hello",
        spoilerText: "",
        sensitive: false,
        language: "en",
        published: new Date(w.clock).toISOString(),
        updated: null,
        inReplyTo: null,
        to: ["https://www.w3.org/ns/activitystreams#Public"],
        cc: [w.localUris.L1],
        mentions: [w.localUris.L1],
        tags: [],
        emojiTags: [],
        media: [],
        raw: "{}",
      },
    },
    w.clock,
  );
  const predicted = w.policy.create(r);
  tally(w.stats, `create ${predicted ?? "stored"}`);
  await after(w, { actual: result.applied ? null : result.reason, predicted });
}

describe("instance moderation witnesses: calls, retries and revisions", () => {
  // Rule 3 for a call (threat-model.md RES-5): a runModerationJobs call runs the runnable, due domain job.
  it("a call of the moderation rounds runs the runnable domain job", async () => {
    const f = await bare();
    await remotesOn(f, 3, D, COVERED);
    await blockOf(f, D);
    await fixtureModeration(f);
    expect(await markedOn(f, D)).toBe(3);
    expect(f.last!.jobs).toEqual([]);
  }, 60_000);

  // RES-5: an account job's failed round backs off; a suspension again resets its retry state with its generation.
  it("an account job's failed round backs off, and a suspension again makes it fresh", async () => {
    const f = await bare();
    await remotesOn(f, 1, OTHER, COVERED);
    const r = (COVERED + 1n).toString();
    await suspendOf(f, r);
    await failing(f, ["update", "delete"], async () => {
      await fixtureRound(f);
    });
    expect(f.last!.jobs[0]).toMatchObject({ kind: "account", phase: "reports", attempts: 1 });
    expect(f.last!.jobs[0]!.dueAt).not.toBeNull();
    await suspendOf(f, r);
    expect(f.last!.jobs[0]).toMatchObject({ phase: "reports", attempts: 0, dueAt: null });
    await fixtureDrain(f);
  }, 60_000);

  // Rule 6 (threat-model.md: a family's selection takes a due retry first, and its pending answer comes from the same
  // seeks): five due retries, each finished by its next round; a call runs four, and the fifth keeps `pending` true.
  it("five due retries: one call finishes four, and pending answers true for the fifth", async () => {
    const f = await bare();
    await remotesOn(f, 5, OTHER, COVERED);
    for (let i = 1n; i <= 5n; i++) {
      await suspendOf(f, (COVERED + i).toString());
    }
    await failing(f, ["delete"], async () => {
      for (let i = 0; i < 10; i++) {
        await fixtureRound(f);
      }
    });
    expect(f.last!.jobs.map((j) => [j.phase, j.attempts])).toEqual(Array.from({ length: 5 }, () => ["follows", 1]));
    f.clock = Math.max(...f.last!.jobs.map((j) => j.dueAt!));
    expect(await fixtureModeration(f)).toBe(true);
    expect(f.last!.jobs).toHaveLength(1);
    await fixtureDrain(f);
  }, 60_000);

  // ID-1 (DocumentRevision): a store issues a new revision, so a document fetched under the one before stores
  // nothing; a routing refresh issues one too.
  it("a document under a superseded revision stores nothing, routing refreshes included", async () => {
    const w = await p1World();
    const r4 = { name: "R4", keys: ["R4-key-0"], inbox: `${SPEC.R4.uri}/inbox`, sharedInbox: null };
    const g = await revisionOf(w, "R4");
    expect(await sendDocument(w, "R4", { ...r4, name: "R4 a" }, g)).toBe("actor-updated");
    expect(await revisionOf(w, "R4")).not.toBe(g);
    expect(await sendDocument(w, "R4", { ...r4, name: "R4 b" }, g)).toBe("actor-changed");
    expect(await rowOf(w, "R4")).toMatchObject({ name: "R4 a" });
    await call(w, `/api/v1/admin/accounts/${w.remoteIds.R1}/action`, form({ type: "suspend" }), w.admin);
    const r1 = { name: "R1", keys: ["R1-key-0"], inbox: `${SPEC.R1.uri}/inbox`, sharedInbox: SPEC.R1.shared };
    const h = await revisionOf(w, "R1");
    expect(await sendDocument(w, "R1", { ...r1, sharedInbox: "https://d.example/inbox-a" }, h)).toBe("actor-suspended");
    expect(await revisionOf(w, "R1")).not.toBe(h);
    expect(await sendDocument(w, "R1", { ...r1, sharedInbox: "https://d.example/inbox-c" }, h)).toBe("actor-suspended");
    expect(await rowOf(w, "R1")).toMatchObject({ name: "R1", shared: "https://d.example/inbox-a" });
  }, 60_000);

  // C17 (visibility.md, "Writes"): no account moves into a covered domain. The domain an address confirms (the search
  // resolver's confirmedDomain) is taken when no block covers it; into a covered domain the row stays as it was.
  it("a document never moves an account into a covered domain", async () => {
    const w = await p1World();
    await steps(w, [block(D)]);
    const before = await rowOf(w, "R4");
    const doc = { name: "R4 moved", keys: ["R4-key-0"], inbox: `${SPEC.R4.uri}/inbox`, sharedInbox: null };
    await sendDocument(w, "R4", doc, await revisionOf(w, "R4"), D);
    expect(await rowOf(w, "R4")).toEqual(before);
    await sendDocument(w, "R4", doc, await revisionOf(w, "R4"), "moved.example");
    expect(await rowOf(w, "R4")).toMatchObject({ domain: "moved.example", name: "R4 moved" });
  }, 60_000);

  // visibility.md (the remote suspension paragraphs): storeRemoteStatus stores nothing of an unavailable author.
  it("a Create mentioning L1 is stored and notified for an available author only", async () => {
    const w = await p1World();
    await create(w, "R4");
    await steps(w, [{ k: "suspend", r: "R1" }]);
    await create(w, "R1");
    expect(w.stats["create stored"]).toBe(1);
    expect(w.stats["create actor-suspended"]).toBe(1);
    expect(projection(w, w.last!).statuses).toEqual({ R4: 1 });
  }, 60_000);

  // visibility.md, "The send-time check": the inbox rule refuses a row whose inbox host a block covers, though its
  // recipient stays available.
  it("a row to an available account whose inbox host alone is covered is dropped", async () => {
    const f = await bare();
    await remotesOn(f, 1, OTHER, COVERED);
    const r = (COVERED + 1n).toString();
    await sql(f.store, "UPDATE accounts SET inbox_url = 'https://inbox.blocked.example/inbox' WHERE id = ?", r);
    const followed = await f.h.request(`/api/v1/accounts/${r}/follow`, bearer(f.alice.token, json({})));
    expect(followed.status).toBe(200);
    expect(await count(f, "SELECT 1 FROM deliveries")).toBe(1);
    expect(await blockOf(f, "blocked.example")).toBe(200);
    const entity = await f.h.request(`/api/v1/accounts/${r}`, bearer(f.alice.token));
    expect((await entity.json<{ suspended?: boolean }>()).suspended).not.toBe(true);
    const claimed = await f.h.store.claimDeliveries(BUILD, { now: NOW, leaseToken: "lease-inbox", limit: 1 });
    expect(claimed.deliveries).toEqual([]);
    expect(await count(f, "SELECT 1 FROM deliveries")).toBe(0);
  }, 60_000);
});
