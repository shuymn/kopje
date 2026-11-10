import { runInDurableObject } from "cloudflare:test";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { QUOTE_POLICY_FLAGS } from "../src/domain/audience";
import type { DeliveryOutcome } from "../src/domain/deliveries";
import type { InboundActivity } from "../src/domain/inbox";
import type { RemoteStatusInput } from "../src/domain/remote-status-reads";
import { sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { BUILD, runStoreJobs } from "./helpers";
import { LOCAL, mastodonActor } from "./inbox-helpers";
import { ALICE_URI, AS, setup as appSetup } from "./inbox-status-helpers";
import { runs } from "./policy-world";
import {
  type AnswerRef,
  type Body,
  type Event,
  type Intent,
  knownDefect1447,
  type LocalPolicy,
  localStored,
  type Logged,
  mastodonCanQuote,
  type Msg,
  parsedStored,
  type PeerNote,
  PUBLIC,
  QuotePeer,
  QuotePolicy,
  replayedRequest,
  revokedPendingReaccepted,
  type Side,
  type StoredPolicy,
} from "./quote-model";
import { remoteAccount } from "./status-helpers";

// Model-based checks of quote requests, approvals and revocation between the local account L and the Mastodon account
// R (VIS-28, R35 and R36 in docs/visibility.md, ID-6, ID-7 and NET-2 in docs/threat-model.md). Generated sequences of
// R's server's actions (posting, revoking, policy changes, deletes), L's API actions, Kopje's delivery steps and job
// rounds run through the Store and the API; after every step the Store's projection, the API's reads and each answer
// must equal the policy's (test/quote-model.ts), and once everything has settled Kopje and the peer, a Mastodon v4.5.11
// model fed the bytes Kopje confirmed, must agree on which quotes are live and accepted, and on their stamps, except
// where an accepted risk (X1, X2) or the known defect #1447 names the events that differ. A second property sends what
// Mastodon would not, from R and two other actors, checked against the policy alone.

const R_ORIGIN = "https://remote.example";
const R = `${R_ORIGIN}/users/r`;
const F = `${R_ORIGIN}/users/f`;
const X = "https://other.example/users/x";
const L = ALICE_URI;
const SR = [`${R}/statuses/sr1`, `${R}/statuses/sr2`] as const;
const OK: DeliveryOutcome = { kind: "delivered", status: 202 };
const FAIL: DeliveryOutcome = { kind: "failed", status: 503, error: "HTTP 503", permanent: false };
const SETTLE_STEPS = 300;
const POSTS = 3;
const POLICIES: readonly LocalPolicy[] = ["public", "followers", "nobody"];

export type Stats = Record<string, number>;
const tally = (stats: Stats, key: string, n = 1) => {
  stats[key] = (stats[key] ?? 0) + n;
};

const iso = (ms: number) => new Date(ms).toISOString();

// A Note as the Worker would parse it for the Store (as test/status-delete.test.ts writes its inputs).
function input(note: PeerNote, at: number): RemoteStatusInput {
  const followers = `${note.author}/followers`;
  return {
    uri: note.uri,
    url: null,
    attributedTo: note.author,
    content: "<p>q</p>",
    text: "q",
    spoilerText: "",
    sensitive: false,
    language: "en",
    published: iso(at),
    updated: null,
    inReplyTo: null,
    to: note.visibility === "public" ? [PUBLIC] : [followers],
    cc: note.visibility === "public" ? [followers] : [],
    mentions: [],
    tags: [],
    emojiTags: [],
    media: [],
    quote:
      note.quote === null
        ? null
        : { uri: note.quote.uri, legacy: false, tombstone: false, approvalUri: note.quote.approvalUri },
    quotePolicy: note.policy,
    raw: "{}",
  };
}

const refOf = (ref: AnswerRef) => ({
  id: ref.id,
  type: ref.type,
  actor: ref.type === null ? null : L,
  object: ref.object,
  instrument: ref.instrument,
});

// The peer's message as the Worker hands it to the Store.
function activityOf(actor: string, msg: Msg, at: number): InboundActivity {
  switch (msg.type) {
    case "Create":
      return { type: "Create", id: msg.id, object: input(msg.note, at) };
    case "Update":
      return { type: "UpdateStatus", id: msg.id, object: input(msg.note, at) };
    case "Delete":
      return { type: "Delete", id: msg.id, object: msg.object };
    case "StampDelete":
      return msg.proven
        ? {
            type: "Delete",
            id: msg.id,
            object: msg.object,
            proven: { "@context": AS, id: msg.id, type: "Delete", actor, to: [PUBLIC], object: msg.object },
          }
        : { type: "Delete", id: msg.id, object: msg.object };
    case "QuoteRequest":
      return {
        type: "QuoteRequest",
        id: msg.id,
        object: msg.object,
        instrument: msg.instrument,
        embedded: msg.embedded === null ? null : input(msg.embedded, at),
      };
    case "Accept":
      return { type: "Accept", id: msg.id, object: refOf(msg.ref), result: msg.result };
    case "Reject":
      return { type: "Reject", id: msg.id, object: refOf(msg.ref) };
  }
}

type Phase = "claimed" | "confirmed" | "transmitted" | "done";
type Attempt = {
  token: string;
  delivery: string;
  inbox: string;
  intent: Intent;
  phase: Phase;
  reached: boolean;
  body: string | null;
};

export type Case = { lr: boolean; rl: boolean; p: [LocalPolicy, LocalPolicy]; q: [LocalPolicy, LocalPolicy] };

let leaseSequence = 0;
let worldSequence = 0;

async function setup(c: Case) {
  const clock = { now: NOW };
  const t = await appSetup(clock);
  const r = await mastodonActor(t.web, "r", { origin: R_ORIGIN });
  const log: Logged[] = [];
  const emit = (e: Event) => log.push({ ...e, n: log.length + 1 });
  const world = {
    t,
    store: t.store,
    r,
    clock,
    case: c,
    step: 0,
    policy: new QuotePolicy(
      L,
      R,
      { lr: c.lr, rl: c.rl },
      new Map([
        [F, { who: "F" as const, lr: false, rl: false }],
        [X, { who: "X" as const, lr: false, rl: false }],
      ]),
    ),
    peer: new QuotePeer(R_ORIGIN, R, L, { lr: c.lr, rl: c.rl }, emit),
    log,
    emit,
    attempts: [] as Attempt[],
    // Kopje's status ids by the policy's labels, and the labels of Kopje's authorizations by their ids.
    ids: new Map<string, string>(),
    authLabel: new Map<string, string>(),
    authId: new Map<string, string>(),
    // Every authorization id ever observed (AC-3).
    seenAuth: new Set<string>(),
    // The peer's messages delivered at least once (kept for redelivery while their result was lost).
    trace: [] as string[],
    stats: {} as Stats,
    rId: "",
    tag: ++worldSequence,
  };
  // R's statuses as Mastodon serves them, fetched by Kopje through search (storing R too).
  for (const [i, uri] of SR.entries()) {
    world.peer.srs.set(uri, { uri, policy: c.q[i]!, deleted: false });
    serveNote(world, world.peer.noteOf(uri));
    const found = await t.request(`/api/v2/search?q=${encodeURIComponent(uri)}&resolve=true&type=statuses`, {
      headers: { authorization: `Bearer ${t.tokens.alice}` },
    });
    const id = (await found.json<{ statuses: { id: string }[] }>()).statuses[0]?.id;
    expect(id, `SR${i + 1} was not resolved`).toBeDefined();
    world.ids.set(`SR${i + 1}`, id!);
    world.policy.labelOf.set(uri, `SR${i + 1}`);
    world.policy.addStatus({
      label: `SR${i + 1}`,
      uri,
      author: "R",
      visibility: "public",
      policy: parsedStored(R, mastodonCanQuote(R, c.q[i]!)),
      withdrawn: false,
      boost: false,
    });
  }
  world.rId = (await sql<{ id: string }>(t.store, "SELECT id FROM accounts WHERE uri = ?", R))[0]!.id;
  // F (on R's origin) and X (on another), who act in the policy-only property.
  await remoteAccount(t.store, "f");
  await remoteAccount(t.store, "x", "other.example");
  // Setup asserts both are stored with the policy Mastodon wrote.
  expect(
    (
      await sql<{ uri: string; quote_policy: number }>(t.store, "SELECT uri, quote_policy FROM statuses ORDER BY uri")
    ).map((s) => toPolicy(s.quote_policy)),
  ).toEqual(SR.map((_, i) => world.policy.statuses.get(`SR${i + 1}`)!.policy));
  const alice = (await sql<{ id: string }>(t.store, "SELECT id FROM accounts WHERE uri = ?", L))[0]!.id;
  if (c.lr) {
    await sql(
      t.store,
      "INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
      alice,
      world.rId,
    );
  }
  if (c.rl) {
    await sql(
      t.store,
      "INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
      world.rId,
      alice,
    );
  }
  // SL1 (public) and SL2 (unlisted), posted through the API.
  for (const [i, visibility] of (["public", "unlisted"] as const).entries()) {
    const label = `SL${i + 1}`;
    const response = await api(world, "POST", "/api/v1/statuses", {
      status: label,
      visibility,
      quote_approval_policy: c.p[i],
    });
    expect(response.status).toBe(200);
    const posted = response.body as { id: string; uri: string };
    world.ids.set(label, posted.id);
    world.policy.addStatus({
      label,
      uri: posted.uri,
      author: "L",
      visibility,
      policy: localStored(c.p[i]!),
      withdrawn: false,
      boost: false,
    });
    world.policy.labelOf.set(posted.uri, label);
    if (c.rl) {
      world.policy.recordCreate(world.clock.now, label);
    } else {
      // R's server holds the Note it fetched from Kopje's object endpoint.
      const note = await t.request(new URL(posted.uri).pathname, { headers: { accept: "application/activity+json" } });
      world.peer.ingest(await note.json<Record<string, unknown>>(), true);
    }
  }
  await check(world);
  if (c.rl) {
    // R's server holds the Notes their Creates delivered.
    await settle(world);
  }
  world.trace.push("-- setup done");
  return world;
}

type World = Awaited<ReturnType<typeof setup>>;

function serveNote(w: { t: { web: { serve: (uri: string, doc: unknown) => void } } }, note: PeerNote): void {
  w.t.web.serve(note.uri, {
    "@context": [AS, { gts: "https://gotosocial.org/ns#", interactionPolicy: "gts:interactionPolicy" }],
    id: note.uri,
    type: "Note",
    attributedTo: note.author,
    content: "<p>sr</p>",
    published: iso(NOW),
    to: [PUBLIC],
    cc: [`${note.author}/followers`],
    ...(note.policy === null
      ? {}
      : {
          interactionPolicy: {
            canQuote: { automaticApproval: note.policy.automatic, manualApproval: note.policy.manual },
          },
        }),
  });
}

// A stored quote_policy as the policy's halves (audience.ts QUOTE_POLICY_FLAGS: the automatic half in the high bits).
function toPolicy(stored: number): StoredPolicy {
  const half = (h: number) => ({
    public: (h & QUOTE_POLICY_FLAGS.public) !== 0,
    followers: (h & QUOTE_POLICY_FLAGS.followers) !== 0,
    following: (h & QUOTE_POLICY_FLAGS.following) !== 0,
    unsupported: (h & QUOTE_POLICY_FLAGS.unsupported_policy) !== 0,
  });
  return { automatic: half(stored >> 16), manual: half(stored & 0xffff) };
}

async function api(w: { t: World["t"] }, method: string, path: string, body?: unknown) {
  const response = await w.t.request(path, {
    method,
    headers: { authorization: `Bearer ${w.t.tokens.alice}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json<unknown>() };
}

const log = (w: World, line: string) => {
  w.step++;
  w.trace.push(`${w.step} ${line}`);
};

// ---------------------------------------------------------------------------------------------------------------
// The Store's projection, and the policy's
// ---------------------------------------------------------------------------------------------------------------

const AUTH_PATH = "/quote_authorizations/";
const DEBUG = false;
const ACTIVE = "('queued', 'pending', 'leased')";

async function project(w: World) {
  const raw = await runInDurableObject(w.store, (_instance, state) => {
    const q = <T extends Record<string, SqlStorageValue>>(query: string, ...params: SqlStorageValue[]) =>
      state.storage.sql.exec<T>(query, ...params).toArray();
    return {
      statuses: q<{ uri: string; withdrawn: number; visibility: string; quote_policy: number; quotes_count: number }>(
        "SELECT uri, withdrawn, visibility, quote_policy, quotes_count FROM statuses WHERE reblog_of_id IS NULL ORDER BY uri",
      ),
      quotes: q<{
        uri: string;
        quoted: string | null;
        state: string;
        local: number;
        authorization_id: string | null;
        approval_uri: string | null;
        activity_uri: string | null;
      }>(
        `SELECT s.uri, t.uri AS quoted, q.state, q.local, q.authorization_id, q.approval_uri, q.activity_uri
				FROM quotes q JOIN statuses s ON s.id = q.status_id LEFT JOIN statuses t ON t.id = q.quoted_status_id ORDER BY s.uri`,
      ),
      revocations: q<{ authorization: string; actor: string }>(
        "SELECT authorization, actor_uri AS actor FROM quote_revocations ORDER BY authorization",
      ),
      requests: q<{ id: string }>("SELECT activity_uri AS id FROM quote_requests ORDER BY activity_uri"),
      retracted: q<{ actor: string; uri: string }>(
        "SELECT actor_uri AS actor, target_uri AS uri FROM inbound_retractions WHERE actor_uri <> '*'",
      ),
      mentions: q<{ uri: string; account: string }>(
        `SELECT s.uri, a.uri AS account FROM status_mentions m JOIN statuses s ON s.id = m.status_id
				JOIN accounts a ON a.id = m.account_id WHERE m.silent = 1 ORDER BY s.uri, a.uri`,
      ),
      notifications: q<{ uri: string }>(
        `SELECT s.uri FROM notifications n JOIN statuses s ON s.id = n.status_id WHERE n.type = 'quote' ORDER BY s.uri`,
      ),
      intents: q<{
        type: string;
        object: string | null;
        superseded: number;
        staged: string | null;
        rows: number;
        first: number | null;
      }>(
        `SELECT json_extract(o.body, '$.activity.type') AS type, o.object_uri AS object, o.superseded, o.staged,
					(SELECT count(*) FROM deliveries d WHERE d.activity_id = o.id AND d.state IN ${ACTIVE}) AS rows,
					(SELECT min(d.id) FROM deliveries d WHERE d.activity_id = o.id AND d.state IN ${ACTIVE}) AS first
				FROM outbound_activities o ORDER BY o.id`,
      ),
      gaveUp: q<{ n: number }>("SELECT count(*) AS n FROM deliveries WHERE state = 'gave_up'")[0]!.n,
      unexpanded: q<{ n: number }>("SELECT count(*) AS n FROM outbound_targets")[0]!.n,
      jobs: q<{ n: number }>("SELECT count(*) AS n FROM inbound_jobs WHERE done_at IS NULL")[0]!.n,
    };
  });
  const p = w.policy;
  const label = (uri: string | null) => (uri === null ? null : (p.labelOf.get(uri) ?? `unbound ${uri}`));
  // Kopje's authorizations are bound to the policy's labels the first time the Store shows them (AC-3: each is fresh).
  for (const row of raw.quotes) {
    const quote = p.quotes.get(label(row.uri)!);
    if (row.authorization_id !== null && quote?.authorization != null && !w.authId.has(quote.authorization)) {
      if (w.seenAuth.has(row.authorization_id)) {
        throw new Error(`AC-3: authorization ${row.authorization_id} drawn again\n${w.trace.join("\n")}`);
      }
      w.seenAuth.add(row.authorization_id);
      w.authId.set(quote.authorization, row.authorization_id);
      w.authLabel.set(row.authorization_id, quote.authorization);
    }
  }
  const subject = (object: string | null) => {
    if (object === null) {
      return null;
    }
    const at = object.indexOf(AUTH_PATH);
    if (object.startsWith(LOCAL) && at >= 0) {
      const id = object.slice(at + AUTH_PATH.length);
      return `stamp:${w.authLabel.get(id) ?? `unbound ${id}`}`;
    }
    return object;
  };
  if (DEBUG) {
    w.trace.push(
      `  [store] ${JSON.stringify(raw.intents.map((i) => [i.type, i.object?.slice(-8), i.superseded, i.staged, i.rows]))}`,
    );
    w.trace.push(
      `  [policy] ${JSON.stringify(p.lane.map((i) => [i.type, i.subject.slice(-8), i.superseded, i.staged, i.rows]))}`,
    );
  }
  const intents = raw.intents.map((i) => ({
    type: i.type,
    subject: subject(i.object),
    superseded: i.superseded === 1,
    staged: i.staged !== null && i.rows === 0,
  }));
  p.bind(raw.intents, w.clock.now);
  return {
    statuses: raw.statuses
      .map((s) => ({
        label: label(s.uri),
        withdrawn: s.withdrawn === 1,
        visibility: s.visibility,
        policy: toPolicy(s.quote_policy),
        quotes: s.quotes_count,
      }))
      .toSorted((a, b) => String(a.label).localeCompare(String(b.label))),
    quotes: raw.quotes
      .map((q) => ({
        label: label(q.uri),
        quoted: label(q.quoted),
        state: q.state,
        local: q.local === 1,
        authorization: q.authorization_id === null ? null : (w.authLabel.get(q.authorization_id) ?? "unbound"),
        approvalUri: q.approval_uri,
        activityUri: q.activity_uri,
      }))
      .toSorted((a, b) => String(a.label).localeCompare(String(b.label))),
    revocations: raw.revocations
      .map((r) => w.authLabel.get(r.authorization) ?? `${r.actor} ${r.authorization}`)
      .toSorted(),
    requests: raw.requests.map((r) => r.id),
    retracted: raw.retracted.map((r) => `${r.actor} ${r.uri}`).toSorted(),
    mentions: raw.mentions.map((m) => `${label(m.uri)}>${p.who(m.account)}`).toSorted(),
    notifications: raw.notifications.map((n) => String(label(n.uri))).toSorted(),
    intents,
    gaveUp: raw.gaveUp,
    unexpanded: raw.unexpanded,
    jobs: raw.jobs,
  };
}

function expected(w: World) {
  const p = w.policy;
  return {
    statuses: [...p.statuses.values()]
      .filter((s) => !s.boost)
      .map((s) => ({
        label: s.label,
        withdrawn: s.withdrawn,
        visibility: s.visibility,
        policy: s.policy,
        quotes: p.quotesCount(s.label),
      }))
      .toSorted((a, b) => a.label.localeCompare(b.label)),
    quotes: [...p.quotes.entries()]
      .map(([label, q]) => ({
        label,
        quoted: q.quoted,
        state: q.state,
        local: q.local,
        authorization: q.authorization,
        approvalUri: q.approvalUri,
        activityUri: q.activityUri,
      }))
      .toSorted((a, b) => a.label.localeCompare(b.label)),
    revocations: [...p.revocations].toSorted(),
    requests: [...p.answered.keys()].toSorted(),
    retracted: [...p.retracted].toSorted(),
    mentions: [...p.mentions].toSorted(),
    notifications: [...p.notifications].toSorted(),
    intents: p.lane.map((i) => ({ type: i.type, subject: i.subject, superseded: i.superseded, staged: i.staged })),
    gaveUp: 0,
    jobs: p.removals.length,
  };
}

// The API reads every step makes (C6, C19): each authorization observed so far served iff the policy serves it, the
// quote state L sees on each quoting status there, and what R36 answers L for R's statuses.
async function reads(w: World) {
  const p = w.policy;
  const stamps: Record<string, number> = {};
  for (const [label, id] of w.authId) {
    const response = await w.t.request(`/ap/users/alice${AUTH_PATH}${id}`, {
      headers: { accept: "application/activity+json" },
    });
    await response.body?.cancel();
    stamps[label] = response.status;
  }
  const states: Record<string, string | null> = {};
  for (const label of p.quotes.keys()) {
    const id = await statusId(w, label);
    if (id === undefined || p.statuses.get(label)?.withdrawn !== false) {
      continue;
    }
    const answer = await api(w, "GET", `/api/v1/statuses/${id}`);
    states[label] = (answer.body as { quote: { state: string } | null }).quote?.state ?? null;
  }
  const approvals: Record<string, string> = {};
  for (const label of ["SR1", "SR2", "SR3"]) {
    if (p.statuses.has(label)) {
      const answer = await api(w, "GET", `/api/v1/statuses/${await statusId(w, label)}`);
      approvals[label] = (answer.body as { quote_approval: { current_user: string } }).quote_approval.current_user;
    }
  }
  return { stamps, states, approvals };
}

function expectedReads(w: World) {
  const p = w.policy;
  const stamps: Record<string, number> = {};
  for (const label of w.authId.keys()) {
    stamps[label] = p.stampServed(label) ? 200 : 404;
  }
  const states: Record<string, string | null> = {};
  for (const [label, q] of p.quotes) {
    if (p.statuses.get(label)?.withdrawn === false && (w.ids.has(label) || p.statuses.get(label)?.author !== "L")) {
      // R35: an accepted quote whose quoted status is gone or withdrawn reads as deleted, as Mastodon's serializer
      // reads a discarded one (docs/visibility.md).
      const gone = q.quoted === null || p.statuses.get(q.quoted)?.withdrawn !== false;
      states[label] = q.state === "accepted" && gone ? "deleted" : q.state;
    }
  }
  const approvals: Record<string, string> = {};
  for (const label of ["SR1", "SR2", "SR3"]) {
    if (p.statuses.has(label)) {
      approvals[label] = p.approvalFor(label);
    }
  }
  return { stamps, states, approvals };
}

async function statusId(w: World, label: string): Promise<string | undefined> {
  const known = w.ids.get(label);
  if (known !== undefined) {
    return known;
  }
  const uri = w.policy.statuses.get(label)?.uri;
  if (uri === undefined) {
    return undefined;
  }
  const id = (await sql<{ id: string }>(w.store, "SELECT id FROM statuses WHERE uri = ?", uri))[0]?.id;
  if (id !== undefined) {
    w.ids.set(label, id);
  }
  return id;
}

async function check(w: World, answer: { actual: unknown; predicted: unknown } | null = null): Promise<void> {
  const context = w.trace.join("\n");
  if (answer !== null) {
    expect(answer.actual, context).toEqual(answer.predicted);
  }
  // Targets a job staged are expanded by the next claim: only quiescence requires none left (settle).
  const { unexpanded: _, ...state } = await project(w);
  expect(state, context).toEqual(expected(w));
  expect(await reads(w), context).toEqual(expectedReads(w));
}

// ---------------------------------------------------------------------------------------------------------------
// R's messages to Kopje
// ---------------------------------------------------------------------------------------------------------------

async function receive(w: World, actor: string, msg: Msg, personal: boolean, seq: number, label: string) {
  log(w, `${label} ${actor.split("/").at(-1)} ${msg.type} ${describeMsg(msg)}${personal ? " (personal)" : ""}`);
  const result = await w.store.receiveActivity(BUILD, {
    now: w.clock.now,
    origin: LOCAL,
    actorUri: actor,
    actor: null,
    actorRevision: null,
    activity: activityOf(actor, msg, w.clock.now),
    recipient: personal ? "alice" : null,
  });
  const predicted = w.policy.receive(actor, msg, w.clock.now, personal);
  w.trace.push(`  -> ${result.reason}`);
  w.emit({ k: "kopje", msg: seq, type: msg.type, reason: result.reason });
  tally(w.stats, `${msg.type} ${result.reason}`);
  await check(w, {
    actual: { applied: result.applied, reason: result.reason },
    predicted: { applied: predicted.applied, reason: predicted.reason },
  });
}

function describeMsg(msg: Msg): string {
  switch (msg.type) {
    case "Create":
    case "Update":
      return `${msg.note.uri}${msg.note.quote === null ? "" : ` quoting ${msg.note.quote.uri} ${msg.note.quote.approvalUri}`}`;
    case "Delete":
    case "StampDelete":
      return msg.object;
    case "QuoteRequest":
      return `${msg.id} of ${msg.object} by ${msg.instrument}`;
    case "Accept":
      return `${msg.ref.id} ${msg.result}`;
    case "Reject":
      return `${msg.ref.id}`;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// L's API actions
// ---------------------------------------------------------------------------------------------------------------

async function lPost(w: World, target: number): Promise<void> {
  const p = w.policy;
  const label = `LQ${[...p.statuses.keys()].filter((k) => k.startsWith("LQ")).length + 1}`;
  const quoted = `SR${target + 1}`;
  log(w, `L posts ${label} quoting ${quoted}`);
  const id = w.ids.get(quoted) ?? "1";
  const answer = await api(w, "POST", "/api/v1/statuses", { status: label, quoted_status_id: id });
  const posted = answer.body as { id: string; uri: string };
  const predicted = p.postQuote(w.clock.now, label, quoted, () => posted.uri);
  if (answer.status === 200) {
    w.ids.set(label, posted.id);
    p.labelOf.set(posted.uri, label);
  }
  w.trace.push(`  -> ${answer.status}`);
  tally(
    w.stats,
    `${w.trace
      .at(-2)
      ?.replace(/^\d+ /, "")
      .replace(/LQ\d|RQ\d|SL\d|SR\d/g, "_")} ${answer.status}`,
  );
  await check(w, { actual: answer.status, predicted });
}

async function lRevoke(w: World, quoting: string): Promise<void> {
  const p = w.policy;
  const q = p.quotes.get(quoting);
  const quoted = q?.quoted ?? w.peer.rqs.get(quoting)?.quote.quoted;
  const quotedLabel = (quoted === undefined || quoted === null ? null : (p.labelOf.get(quoted) ?? quoted)) ?? "SL1";
  log(w, `L revokes ${quoting} of ${quotedLabel}`);
  const quotingId = (await statusId(w, quoting)) ?? "1";
  const answer = await api(w, "POST", `/api/v1/statuses/${w.ids.get(quotedLabel) ?? "1"}/quotes/${quotingId}/revoke`);
  const predicted = p.revoke(w.clock.now, quotedLabel, quoting);
  w.trace.push(`  -> ${answer.status}`);
  tally(
    w.stats,
    `${w.trace
      .at(-2)
      ?.replace(/^\d+ /, "")
      .replace(/LQ\d|RQ\d|SL\d|SR\d/g, "_")} ${answer.status}`,
  );
  await check(w, { actual: answer.status, predicted });
}

async function lPolicy(w: World, label: string, name: LocalPolicy): Promise<void> {
  log(w, `L sets ${label} to ${name}`);
  const answer = await api(w, "PUT", `/api/v1/statuses/${w.ids.get(label)}/interaction_policy`, {
    quote_approval_policy: name,
  });
  const predicted = w.policy.setPolicy(w.clock.now, label, name);
  w.trace.push(`  -> ${answer.status}`);
  tally(
    w.stats,
    `${w.trace
      .at(-2)
      ?.replace(/^\d+ /, "")
      .replace(/LQ\d|RQ\d|SL\d|SR\d/g, "_")} ${answer.status}`,
  );
  await check(w, { actual: answer.status, predicted });
}

async function lDelete(w: World, label: string): Promise<void> {
  log(w, `L deletes ${label}`);
  const answer = await api(w, "DELETE", `/api/v1/statuses/${w.ids.get(label) ?? "1"}`);
  const predicted = w.policy.deleteStatus(w.clock.now, label);
  w.trace.push(`  -> ${answer.status}`);
  tally(
    w.stats,
    `${w.trace
      .at(-2)
      ?.replace(/^\d+ /, "")
      .replace(/LQ\d|RQ\d|SL\d|SR\d/g, "_")} ${answer.status}`,
  );
  await check(w, { actual: answer.status, predicted });
}

async function jobs(w: World): Promise<void> {
  log(w, "jobs");
  const result = await runStoreJobs(w.store, BUILD, { now: w.clock.now });
  w.policy.jobs(w.clock.now);
  await check(w);
  expect(result.pending, w.trace.join("\n")).toBe(false);
}

// ---------------------------------------------------------------------------------------------------------------
// Kopje's deliveries to R (machine 1's steps, test/follow-lifecycle.test.ts)
// ---------------------------------------------------------------------------------------------------------------

async function claim(w: World): Promise<Attempt | null> {
  const token = `lease-${w.tag}-${++leaseSequence}`;
  log(w, `claim ${token} at +${w.clock.now - NOW}`);
  const previous = w.policy.head;
  const result = await w.store.claimDeliveries(BUILD, { now: w.clock.now, leaseToken: token });
  // A claim expands the targets a job staged first: their rows are bound before the policy predicts the claim.
  await project(w);
  const predicted = w.policy.claim(w.clock.now, token);
  if (predicted.gaveUp) {
    throw new Error(`a delivery gave up, failing the eventual-delivery assumption\n${w.trace.join("\n")}`);
  }
  // AC-4: the row claimed is the lane's first, of the earliest intent that still has one.
  const claimed = await Promise.all(
    result.deliveries.map(async (d) => {
      const row = (
        await sql<{ type: string; object: string | null; first: number }>(
          w.store,
          `SELECT json_extract(o.body, '$.activity.type') AS type, o.object_uri AS object,
						NOT EXISTS (SELECT 1 FROM deliveries e WHERE e.lane = d.lane AND e.id < d.id
							AND e.state IN ('queued', 'pending', 'leased')) AS first
					FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id WHERE d.id = ?`,
          d.id,
        )
      )[0]!;
      return { type: row.type, first: row.first === 1, actor: result.signers[d.signer]?.actorUri };
    }),
  );
  const leased = predicted.leased;
  if (leased !== null && previous?.kind === "leased") {
    w.emit({ k: "expired", token: previous.token });
  }
  w.trace.push(`  -> ${JSON.stringify(claimed)}`);
  await check(w, {
    actual: claimed,
    predicted: leased === null ? [] : [{ type: leased.type, first: true, actor: L }],
  });
  if (leased === null) {
    return null;
  }
  w.emit({ k: "claim", token, seq: leased.seq, type: leased.type, subject: leased.subject });
  const attempt: Attempt = {
    token,
    delivery: result.deliveries[0]!.id,
    inbox: result.deliveries[0]!.inbox,
    intent: leased,
    phase: "claimed",
    reached: false,
    body: null,
  };
  w.attempts.push(attempt);
  return attempt;
}

let inboxOf = new Map<string, string>();

async function confirm(w: World, attempt: Attempt): Promise<void> {
  log(w, `confirm ${attempt.token} (${attempt.intent.type} ${attempt.intent.subject})`);
  const result = await w.store.confirmDelivery(BUILD, {
    id: attempt.delivery,
    leaseToken: attempt.token,
    now: w.clock.now,
  });
  const predicted = w.policy.confirm(attempt.token);
  w.trace.push(`  -> ${result.status}`);
  if (result.status === "send") {
    attempt.body = result.body;
    attempt.phase = "confirmed";
    inboxOf.set(attempt.token, attempt.inbox);
    w.emit({ k: "confirm", token: attempt.token });
    const body = JSON.parse(result.body) as Body;
    await check(w, {
      actual: { status: "send", type: body.type, actor: body.actor },
      predicted:
        predicted.status === "send"
          ? { status: "send", type: predicted.intent.type, actor: senderOf(predicted.intent) }
          : { status: predicted.status },
    });
    return;
  }
  attempt.phase = "done";
  await check(w, { actual: result.status, predicted: predicted.status });
}

// The actor of the body Kopje sends: L's own, but a forward of R's stamp Delete goes as R signed it (VIS-28).
const senderOf = (intent: Intent) => (intent.type === "Delete" && intent.subject.startsWith(`${R_ORIGIN}/`) ? R : L);

// AC-7: the peer applies only bodies Kopje confirmed, parsed from their bytes, each with the inbox it was sent to.
function transmit(w: World, attempt: Attempt, reached: boolean): void {
  log(w, `transmit ${attempt.token} ${reached ? "reached" : "lost"}`);
  attempt.phase = "transmitted";
  attempt.reached = reached;
  w.emit({ k: "transmit", token: attempt.token, reached });
  if (reached) {
    w.peer.receive(JSON.parse(attempt.body!) as Body, inboxOf.get(attempt.token)!, attempt.token);
  }
}

async function complete(w: World, attempt: Attempt, ok: boolean): Promise<void> {
  log(w, `complete ${attempt.token} ${ok ? "delivered" : "failed"}`);
  const result = await w.store.completeDelivery(BUILD, {
    id: attempt.delivery,
    leaseToken: attempt.token,
    now: w.clock.now,
    outcome: ok ? OK : FAIL,
  });
  attempt.phase = "done";
  w.emit({ k: "complete", token: attempt.token, ok });
  const retryAt = result.status === "retry" ? result.retryAt : null;
  const predicted = w.policy.complete(attempt.token, ok, w.clock.now, retryAt);
  w.trace.push(`  -> ${result.status}`);
  await check(w, { actual: result.status, predicted });
}

const open = (w: World, phases: Phase[]) => w.attempts.filter((a) => phases.includes(a.phase));

function peerProcess(w: World, index: number): void {
  const body = w.peer.process(index);
  log(w, `peer processes ${body?.type} ${body?.id}`);
}

// ---------------------------------------------------------------------------------------------------------------
// The federation property's actions
// ---------------------------------------------------------------------------------------------------------------

export type Action =
  | { k: "lPost"; s: number }
  | { k: "lRevoke" | "lDeleteQuote" | "rRevoke" | "rDeleteQuote"; i: number }
  | { k: "lPolicy"; s: number; policy: LocalPolicy }
  | { k: "lDeleteSl" | "rPost" | "rDeleteSr"; s: number }
  | { k: "rPolicy"; s: number; policy: LocalPolicy }
  | { k: "deliver" | "deliverLost" | "process" | "confirm"; i: number }
  | { k: "transmit"; i: number; reached: boolean }
  | { k: "complete"; i: number; ok: boolean }
  | { k: "claim" | "jobs" | "tick" };

const two = fc.constantFrom(0, 1);
const pick = fc.nat(5);
const policyArb = fc.constantFrom(...POLICIES);

export const actionArb: fc.Arbitrary<Action> = fc.oneof(
  { arbitrary: fc.record({ k: fc.constant("lPost" as const), s: two }), weight: 4 },
  { arbitrary: fc.record({ k: fc.constant("lRevoke" as const), i: pick }), weight: 4 },
  { arbitrary: fc.record({ k: fc.constant("lPolicy" as const), s: two, policy: policyArb }), weight: 3 },
  { arbitrary: fc.record({ k: fc.constant("lDeleteQuote" as const), i: pick }), weight: 2 },
  { arbitrary: fc.record({ k: fc.constant("lDeleteSl" as const), s: two }), weight: 1 },
  { arbitrary: fc.record({ k: fc.constant("rPost" as const), s: two }), weight: 4 },
  { arbitrary: fc.record({ k: fc.constant("rRevoke" as const), i: pick }), weight: 3 },
  { arbitrary: fc.record({ k: fc.constant("rPolicy" as const), s: two, policy: policyArb }), weight: 2 },
  { arbitrary: fc.record({ k: fc.constant("rDeleteQuote" as const), i: pick }), weight: 1 },
  { arbitrary: fc.record({ k: fc.constant("rDeleteSr" as const), s: two }), weight: 1 },
  { arbitrary: fc.record({ k: fc.constant("deliver" as const), i: pick }), weight: 8 },
  { arbitrary: fc.record({ k: fc.constant("deliverLost" as const), i: pick }), weight: 2 },
  { arbitrary: fc.constant({ k: "claim" as const }), weight: 5 },
  { arbitrary: fc.record({ k: fc.constant("confirm" as const), i: pick }), weight: 5 },
  {
    arbitrary: fc.record({
      k: fc.constant("transmit" as const),
      i: pick,
      reached: fc.constantFrom(true, true, true, true, false),
    }),
    weight: 5,
  },
  {
    arbitrary: fc.record({
      k: fc.constant("complete" as const),
      i: pick,
      ok: fc.constantFrom(true, true, true, true, false),
    }),
    weight: 5,
  },
  { arbitrary: fc.constant({ k: "tick" as const }), weight: 1 },
  // i = 0 (in order) with p = 0.6.
  {
    arbitrary: fc.record({
      k: fc.constant("process" as const),
      i: fc.oneof({ arbitrary: fc.constant(0), weight: 3 }, { arbitrary: fc.nat(5), weight: 2 }),
    }),
    weight: 8,
  },
  { arbitrary: fc.constant({ k: "jobs" as const }), weight: 2 },
);

const labels = (prefix: string, w: World) =>
  [...new Set([...w.policy.statuses.keys(), ...w.peer.rqs.keys()])].filter((k) => k.startsWith(prefix)).toSorted();

async function deliverToKopje(w: World, index: number, lost: boolean): Promise<void> {
  const outbox = w.peer.outbox;
  if (outbox.length === 0) {
    return;
  }
  const i = index % outbox.length;
  if (i > 0) {
    tally(w.stats, "reordered delivery to Kopje");
  }
  const message = outbox[i]!;
  if (!lost) {
    outbox.splice(i, 1);
  } else {
    tally(w.stats, "peer redelivery");
  }
  await receive(
    w,
    message.from,
    message.msg,
    message.personal,
    message.seq,
    lost ? "deliver (result lost)" : "deliver",
  );
}

async function act(w: World, a: Action): Promise<void> {
  const peer = w.peer;
  switch (a.k) {
    case "lPost":
      if (labels("LQ", w).length < POSTS) {
        await lPost(w, a.s);
      }
      return;
    case "lRevoke": {
      const rqs = labels("RQ", w);
      if (rqs.length > 0) {
        await lRevoke(w, rqs[a.i % rqs.length]!);
      }
      return;
    }
    case "lPolicy":
      await lPolicy(w, `SL${a.s + 1}`, a.policy);
      return;
    case "lDeleteQuote": {
      const lqs = labels("LQ", w);
      if (lqs.length > 0) {
        await lDelete(w, lqs[a.i % lqs.length]!);
      }
      return;
    }
    case "lDeleteSl":
      await lDelete(w, `SL${a.s + 1}`);
      return;
    case "rPost": {
      const label = `RQ${peer.rqs.size + 1}`;
      const sl =
        w.policy.statuses.get(`SL${a.s + 1}`)?.uri ?? [...w.policy.labelOf].find(([, l]) => l === `SL${a.s + 1}`)?.[0];
      if (peer.rqs.size < POSTS && sl !== undefined && peer.postQuote(label, sl)) {
        w.policy.labelOf.set(peer.rqs.get(label)!.uri, label);
        serveNote(w, peer.noteOf(peer.rqs.get(label)!.uri));
        log(w, `R posts ${label} quoting SL${a.s + 1}`);
      } else if (sl !== undefined && peer.rqs.size < POSTS) {
        tally(w.stats, "R refused to quote (its view)");
      }
      return;
    }
    case "rRevoke": {
      const quoted = [...peer.copies.entries()].filter(([, c]) => c.quote !== null).map(([uri]) => uri);
      if (quoted.length > 0) {
        const uri = quoted[a.i % quoted.length]!;
        const state = peer.copies.get(uri)!.quote!.state;
        if (peer.revoke(uri)) {
          log(w, `R revokes ${w.policy.labelOf.get(uri) ?? uri} (${state} there)`);
          tally(w.stats, `R revokes a ${state} quote`);
        }
      }
      return;
    }
    case "rPolicy":
      if (peer.setPolicy(SR[a.s]!, a.policy)) {
        log(w, `R sets SR${a.s + 1} to ${a.policy}`);
      }
      return;
    case "rDeleteQuote": {
      const rqs = [...peer.rqs.keys()];
      if (rqs.length > 0 && peer.deleteRq(rqs[a.i % rqs.length]!)) {
        log(w, `R deletes ${rqs[a.i % rqs.length]}`);
      }
      return;
    }
    case "rDeleteSr":
      if (peer.deleteSr(SR[a.s]!)) {
        log(w, `R deletes SR${a.s + 1}`);
      }
      return;
    case "deliver":
    case "deliverLost":
      await deliverToKopje(w, a.i, a.k === "deliverLost");
      return;
    case "process":
      if (peer.inbox.length > 0) {
        const i = a.i % peer.inbox.length;
        if (i > 0) {
          tally(w.stats, "reordered processing at the peer");
        }
        peerProcess(w, i);
      }
      return;
    case "claim":
      await claim(w);
      return;
    case "confirm": {
      const attempts = open(w, ["claimed"]);
      if (attempts.length > 0) {
        await confirm(w, attempts[a.i % attempts.length]!);
      }
      return;
    }
    case "transmit": {
      const attempts = open(w, ["confirmed"]);
      if (attempts.length > 0) {
        transmit(w, attempts[a.i % attempts.length]!, a.reached);
      }
      return;
    }
    case "complete": {
      const attempts = open(w, ["claimed", "confirmed", "transmitted"]);
      if (attempts.length > 0) {
        const attempt = attempts[a.i % attempts.length]!;
        await complete(w, attempt, a.ok && attempt.phase === "transmitted" && attempt.reached);
      }
      return;
    }
    case "tick":
      w.clock.now += 61_000;
      log(w, "tick 61000");
      return;
    case "jobs":
      await jobs(w);
      return;
  }
}

// Finishes every open attempt, delivers and processes everything on both sides and runs Kopje's job rounds, advancing
// the clock to the next retry or lease expiry when nothing is due, until all is quiet.
async function settle(w: World): Promise<void> {
  for (let round = 0; round < SETTLE_STEPS; round++) {
    for (const attempt of open(w, ["claimed", "confirmed", "transmitted"])) {
      if (attempt.phase === "claimed") {
        await confirm(w, attempt);
      }
      if (attempt.phase === "confirmed") {
        transmit(w, attempt, true);
      }
      if (attempt.phase === "transmitted") {
        await complete(w, attempt, attempt.reached);
      }
    }
    if (w.policy.removals.length > 0) {
      await jobs(w);
    }
    if ((await claim(w)) !== null) {
      continue;
    }
    while (w.peer.inbox.length > 0) {
      peerProcess(w, 0);
    }
    while (w.peer.outbox.length > 0) {
      await deliverToKopje(w, 0, false);
    }
    const head = w.policy.head;
    if (head === null) {
      if (w.policy.headIntent() === undefined && w.peer.inbox.length === 0 && w.peer.outbox.length === 0) {
        const state = await project(w);
        const context = w.trace.join("\n");
        // AC-6: nothing gave up, nothing is pending, and R's server has nothing left to process or send.
        expect({ gaveUp: state.gaveUp, jobs: state.jobs, unexpanded: state.unexpanded }, context).toEqual({
          gaveUp: 0,
          jobs: 0,
          unexpanded: 0,
        });
        expect((await runStoreJobs(w.store, BUILD, { now: w.clock.now })).pending, context).toBe(false);
        return;
      }
      continue;
    }
    const due = head.kind === "pending" ? head.dueAt : head.until;
    if (due > w.clock.now) {
      w.clock.now = due;
      log(w, `clock to +${w.clock.now - NOW}`);
    }
  }
  throw new Error(`settlement did not finish in ${SETTLE_STEPS} rounds\n${w.trace.join("\n")}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Quiescence: Kopje against the peer
// ---------------------------------------------------------------------------------------------------------------

type Excepted = "replayed-request" | "revoked-pending-reaccepted" | "known-defect-1447" | null;

// Live-accepted at Kopje: accepted, with the quoting and the quoted statuses both there and not withdrawn.
function kopjeSide(w: World, label: string): Side & { state: string | null } {
  const p = w.policy;
  const q = p.quotes.get(label);
  if (q === undefined) {
    return { live: false, stamp: null, state: null };
  }
  const quoting = p.statuses.get(label);
  const quoted = q.quoted === null ? undefined : p.statuses.get(q.quoted);
  const live = q.state === "accepted" && quoting?.withdrawn === false && quoted?.withdrawn === false;
  const stamp = q.local
    ? q.approvalUri
    : q.authorization === null
      ? null
      : `${L}${AUTH_PATH}${w.authId.get(q.authorization)}`;
  return { live, stamp: live ? stamp : null, state: q.state };
}

function peerSide(w: World, label: string): Side {
  const peer = w.peer;
  const rq = peer.rqs.get(label);
  if (rq !== undefined) {
    const live =
      !rq.deleted && rq.quote.state === "accepted" && rq.quote.quoted !== null && peer.copies.has(rq.quote.quoted);
    return { live, stamp: live ? rq.quote.approvalUri : null };
  }
  const uri = w.policy.statuses.get(label)?.uri ?? [...w.policy.labelOf].find(([, l]) => l === label)?.[0];
  const copy = uri === undefined ? undefined : peer.copies.get(uri);
  const quote = copy?.quote ?? null;
  const live =
    quote !== null &&
    quote.state === "accepted" &&
    quote.quoted !== null &&
    peer.srs.get(quote.quoted)?.deleted === false;
  return { live, stamp: live ? peer.stamp(quote.id) : null };
}

export function exceptionOf(
  logged: readonly Logged[],
  q: { uri: string; request: string; status: string },
  kopje: Side & { state: string | null },
  peer: Side,
): Excepted {
  if (replayedRequest(logged, q, kopje, peer)) {
    return "replayed-request";
  }
  const state = { state: kopje.state as never };
  if (revokedPendingReaccepted(logged, q, state, peer)) {
    return "revoked-pending-reaccepted";
  }
  // Known defect #1447: an Accept after R's server revoked our pending quote leaves Kopje pending while R's server
  // holds it accepted (witness W17). Removed when #1447 is decided.
  if (knownDefect1447(logged, q, state, peer)) {
    return "known-defect-1447";
  }
  return null;
}

function quiescence(w: World): void {
  const context = w.trace.join("\n");
  const kopje: Record<string, unknown> = {};
  const theirs: Record<string, unknown> = {};
  for (const label of labels("", w).filter((l) => l.startsWith("LQ") || l.startsWith("RQ"))) {
    const mine = kopjeSide(w, label);
    const peer = peerSide(w, label);
    let exception: Excepted = null;
    if (label.startsWith("LQ")) {
      const uri = [...w.policy.labelOf].find(([, l]) => l === label)![0];
      const q = w.policy.quotes.get(label);
      const quoted =
        w.peer.copies.get(uri)?.quote?.quoted ??
        (q?.quoted == null ? "" : (w.policy.statuses.get(q.quoted)?.uri ?? ""));
      exception = exceptionOf(w.log, { uri, request: `${uri}#quote-request`, status: quoted }, mine, peer);
    }
    if (exception !== null) {
      tally(w.stats, `exception ${exception}`);
    }
    kopje[label] = exception ?? { live: mine.live, stamp: mine.stamp };
    theirs[label] = exception ?? peer;
  }
  expect(kopje, context).toEqual(theirs);
}

async function run(c: Case, actions: readonly Action[]): Promise<World> {
  inboxOf = new Map();
  const w = await setup(c);
  for (const a of actions) {
    await act(w, a);
  }
  w.trace.push("-- settle");
  await settle(w);
  quiescence(w);
  return w;
}

const STATS: Stats = {};
const merge = (stats: Stats) => {
  for (const [key, n] of Object.entries(stats)) {
    tally(STATS, key, n);
  }
};

const CASES = 30;
const SEED = 1411;

const caseArb: fc.Arbitrary<Case> = fc.record({
  lr: fc.boolean(),
  rl: fc.boolean(),
  p: fc.tuple(policyArb, policyArb),
  q: fc.tuple(policyArb, policyArb),
});

describe("quote lifecycle: Kopje against its policy and a Mastodon peer", () => {
  it("agrees with the policy after every step and with the peer once settled", async () => {
    await fc.assert(
      fc.asyncProperty(caseArb, fc.array(actionArb, { minLength: 14, maxLength: 20 }), async (c, actions) => {
        merge((await run(c, actions)).stats);
      }),
      runs(CASES, SEED),
    );
    console.log("quote lifecycle coverage", JSON.stringify(STATS, null, 1));
  }, 600_000);
});

// ---------------------------------------------------------------------------------------------------------------
// The policy-only property: what Mastodon would not send, from R, F (R's origin) and X (another origin)
// ---------------------------------------------------------------------------------------------------------------

const ACTORS = [R, F, X] as const;
const SR3 = `${R}/statuses/sr3`;
// SR3's policies as servers other than Mastodon may write them: manual for everyone, automatic or manual for R's
// following (audience.ts's following branches), and a URI Kopje does not know (unknown).
const SR3_POLICIES = [
  { automatic: [R], manual: [PUBLIC] },
  { automatic: [`${R}/following`], manual: [] },
  { automatic: [], manual: [`${R}/following`] },
  { automatic: ["https://other.example/lists/1"], manual: [] },
];

type P2Action =
  | { k: "lPost"; s: number }
  | { k: "lPolicy"; s: number; policy: LocalPolicy }
  | { k: "lRevoke" | "lDeleteQuote"; i: number }
  | { k: "lDeleteSl"; s: number }
  | { k: "qr"; actor: number; object: number; owner: number; existing: boolean; reuse: boolean }
  | { k: "answer"; accept: boolean; embedded: boolean; actor: number; stamp: number; i: number }
  | { k: "stampDelete"; actor: number; stamp: number; proven: boolean }
  | { k: "note"; variant: number; update: boolean }
  | { k: "jobs" };

const p2Arb: fc.Arbitrary<P2Action> = fc.oneof(
  { arbitrary: fc.record({ k: fc.constant("lPost" as const), s: fc.nat(2) }), weight: 3 },
  { arbitrary: fc.record({ k: fc.constant("lPolicy" as const), s: two, policy: policyArb }), weight: 1 },
  { arbitrary: fc.record({ k: fc.constant("lRevoke" as const), i: pick }), weight: 2 },
  { arbitrary: fc.record({ k: fc.constant("lDeleteQuote" as const), i: pick }), weight: 1 },
  { arbitrary: fc.record({ k: fc.constant("lDeleteSl" as const), s: two }), weight: 1 },
  {
    arbitrary: fc.record({
      k: fc.constant("qr" as const),
      actor: fc.constantFrom(0, 0, 1, 2),
      object: fc.constantFrom(0, 0, 1, 2, 3, 4),
      owner: fc.constantFrom(0, 0, 0, 1, 2),
      existing: fc.boolean(),
      reuse: fc.constantFrom(false, false, true),
    }),
    weight: 5,
  },
  {
    arbitrary: fc.record({
      k: fc.constant("answer" as const),
      accept: fc.boolean(),
      embedded: fc.boolean(),
      actor: fc.constantFrom(0, 0, 0, 1),
      stamp: fc.nat(3),
      i: pick,
    }),
    weight: 5,
  },
  {
    arbitrary: fc.record({
      k: fc.constant("stampDelete" as const),
      actor: fc.constantFrom(0, 0, 1),
      stamp: fc.constantFrom(0, 2, 2),
      proven: fc.boolean(),
    }),
    weight: 2,
  },
  {
    arbitrary: fc.record({ k: fc.constant("note" as const), variant: fc.nat(3), update: fc.boolean() }),
    weight: 2,
  },
  { arbitrary: fc.constant({ k: "jobs" as const }), weight: 1 },
);

let p2Sequence = 0;

const uriOf = (w: World, label: string) =>
  w.policy.statuses.get(label)?.uri ?? [...w.policy.labelOf].find(([, l]) => l === label)?.[0];

// SL3 (private) and L's boost of SL1, which no request may name.
async function policyWorld(c: Case) {
  const w = await setup(c);
  const p = w.policy;
  const posted = await api(w, "POST", "/api/v1/statuses", { status: "SL3", visibility: "private" });
  const sl3 = posted.body as { id: string; uri: string };
  w.ids.set("SL3", sl3.id);
  p.labelOf.set(sl3.uri, "SL3");
  p.addStatus({
    label: "SL3",
    uri: sl3.uri,
    author: "L",
    visibility: "private",
    policy: localStored("nobody"),
    withdrawn: false,
    boost: false,
  });
  if (c.rl) {
    p.recordCreate(w.clock.now, "SL3");
  }
  const boosted = await api(w, "POST", `/api/v1/statuses/${w.ids.get("SL1")}/reblog`);
  expect(boosted.status).toBe(200);
  const boost = boosted.body as { id: string; uri: string };
  p.labelOf.set(boost.uri, "BOOST");
  p.addStatus({
    label: "BOOST",
    uri: boost.uri,
    author: "L",
    visibility: "public",
    policy: localStored("nobody"),
    withdrawn: false,
    boost: true,
    of: "SL1",
  });
  if (c.rl) {
    p.recordAnnounce(w.clock.now, boost.uri);
  }
  p.labelOf.set(SR3, "SR3");
  await check(w);
  return Object.assign(w, { requests: new Map<string, string[]>(), stamps: [] as string[] });
}

type PolicyWorld = Awaited<ReturnType<typeof policyWorld>>;

function stampFor(w: PolicyWorld, actor: string, choice: number): string {
  if (choice >= 2 && w.stamps.length > 0) {
    return w.stamps[(choice - 2) % w.stamps.length]!;
  }
  const origin = choice === 1 ? "https://other.example" : new URL(actor).origin;
  const stamp = `${origin}/users/${actor.split("/").at(-1)}/quote_authorizations/p2-${++p2Sequence}`;
  w.stamps.push(stamp);
  return stamp;
}

async function p2Act(w: PolicyWorld, a: P2Action): Promise<void> {
  const p = w.policy;
  switch (a.k) {
    case "lPost":
      if (labels("LQ", w).length < POSTS && p.statuses.has(`SR${a.s + 1}`)) {
        await lPost(w, a.s);
      }
      return;
    case "lPolicy":
      await lPolicy(w, `SL${a.s + 1}`, a.policy);
      return;
    case "lRevoke": {
      const quoters = [...p.quotes].filter(([, q]) => !q.local && q.quoted?.startsWith("SL")).map(([l]) => l);
      if (quoters.length > 0) {
        await lRevoke(w, quoters[a.i % quoters.length]!);
      }
      return;
    }
    case "lDeleteQuote": {
      const lqs = labels("LQ", w);
      if (lqs.length > 0) {
        await lDelete(w, lqs[a.i % lqs.length]!);
      }
      return;
    }
    case "lDeleteSl":
      await lDelete(w, `SL${a.s + 1}`);
      return;
    case "qr": {
      const actor = ACTORS[a.actor]!;
      const owner = ACTORS[a.owner]!;
      const object = [uriOf(w, "SL1"), uriOf(w, "SL2"), uriOf(w, "SL3"), uriOf(w, "BOOST"), `${LOCAL}/ap/o/unknown`][
        a.object
      ]!;
      const mine = [...p.statuses.values()].filter(
        (s) => s.author === p.who(owner) && p.quotes.get(s.label)?.quoted === p.labelOf.get(object),
      );
      const instrument = a.existing && mine.length > 0 ? mine[0]!.uri : `${owner}/statuses/p2-${++p2Sequence}`;
      const used = w.requests.get(actor) ?? [];
      const id =
        a.reuse && used.length > 0 ? used.at(-1)! : `${new URL(actor).origin}/quote_requests/p2-${++p2Sequence}`;
      w.requests.set(actor, [...used, id]);
      const note: PeerNote = {
        uri: instrument,
        author: owner,
        visibility: "public",
        quote: { uri: object, approvalUri: null },
        policy: null,
      };
      await receive(w, actor, { type: "QuoteRequest", id, object, instrument, embedded: note }, true, -1, "receive");
      return;
    }
    case "answer": {
      const lqs = labels("LQ", w).filter((l) => p.statuses.has(l));
      if (lqs.length === 0) {
        return;
      }
      const label = lqs[a.i % lqs.length]!;
      const actor = ACTORS[a.actor]!;
      const uri = uriOf(w, label)!;
      const quoted = p.quotes.get(label)?.quoted;
      const ref: AnswerRef = a.embedded
        ? {
            id: `${new URL(actor).origin}/requests/p2-${++p2Sequence}`,
            type: "QuoteRequest",
            object: quoted == null ? null : (uriOf(w, quoted) ?? null),
            instrument: uri,
          }
        : { id: `${uri}#quote-request`, type: null, object: null, instrument: null };
      const id = `${actor}#answers/p2-${++p2Sequence}`;
      await receive(
        w,
        actor,
        a.accept ? { type: "Accept", id, ref, result: stampFor(w, actor, a.stamp) } : { type: "Reject", id, ref },
        false,
        -1,
        "receive",
      );
      return;
    }
    case "stampDelete": {
      const actor = ACTORS[a.actor]!;
      const stamp = stampFor(w, actor, a.stamp === 1 ? 0 : a.stamp);
      await receive(
        w,
        actor,
        { type: "StampDelete", id: `${stamp}#delete-${++p2Sequence}`, object: stamp, proven: a.proven },
        false,
        -1,
        "receive",
      );
      return;
    }
    case "note": {
      const note: PeerNote = {
        uri: SR3,
        author: R,
        visibility: "public",
        quote: null,
        policy: SR3_POLICIES[a.variant]!,
      };
      serveNote(w, note);
      const id = `${SR3}#${a.update ? "updates" : "creates"}/${++p2Sequence}`;
      await receive(w, R, a.update ? { type: "Update", id, note } : { type: "Create", id, note }, true, -1, "receive");
      return;
    }
    case "jobs":
      await jobs(w);
      return;
  }
}

describe("quote lifecycle: inbound activities Mastodon would not send, against the policy", () => {
  it("agrees with the policy after every activity", async () => {
    await fc.assert(
      fc.asyncProperty(caseArb, fc.array(p2Arb, { minLength: 10, maxLength: 16 }), async (c, actions) => {
        const w = await policyWorld(c);
        for (const a of actions) {
          await p2Act(w, a);
        }
        merge(w.stats);
      }),
      runs(20, SEED),
    );
    console.log("quote policy-only coverage", JSON.stringify(STATS, null, 1));
  }, 300_000);
});

// ---------------------------------------------------------------------------------------------------------------
// Witnesses: each path the properties count, and each exception, by a fixed sequence through the same harness
// (every step checked against the policy, the settled pair against the peer). Each asserts the events of its path
// before its final assertions (AC-8).
// ---------------------------------------------------------------------------------------------------------------

const BASE: Case = { lr: true, rl: true, p: ["public", "public"], q: ["public", "public"] };

async function send(w: World): Promise<Attempt | null> {
  const attempt = await claim(w);
  if (attempt !== null) {
    await confirm(w, attempt);
    transmit(w, attempt, true);
    await complete(w, attempt, true);
  }
  return attempt;
}

async function sendAll(w: World): Promise<void> {
  while ((await send(w)) !== null) {
    // Each row in lane order.
  }
}

// Sends the lane's rows up to (not including) the first of an intent of `type`.
async function sendUntil(w: World, type: string): Promise<void> {
  while (w.policy.headIntent() !== undefined && w.policy.headIntent()!.type !== type) {
    await send(w);
  }
}

function processAll(w: World): void {
  while (w.peer.inbox.length > 0) {
    peerProcess(w, 0);
  }
}

async function deliverAll(w: World): Promise<void> {
  while (w.peer.outbox.length > 0) {
    await deliverToKopje(w, 0, false);
  }
}

// Delivers R's first queued message of `type`.
async function deliverFirst(w: World, type: Msg["type"]): Promise<void> {
  const index = w.peer.outbox.findIndex((m) => m.msg.type === type);
  expect(index, `no ${type} queued at R's server`).toBeGreaterThanOrEqual(0);
  await deliverToKopje(w, index, false);
}

const stateOf = async (w: World, label: string) =>
  (await project(w)).quotes.find((q) => q.label === label)?.state ?? null;

// A failed attempt of the head row (confirmed, reaching R's server, its completion failed), then the clock at its retry.
async function failedAttempt(w: World): Promise<Attempt> {
  const attempt = (await claim(w))!;
  await confirm(w, attempt);
  transmit(w, attempt, true);
  await complete(w, attempt, false);
  return attempt;
}

async function retry(w: World): Promise<Attempt> {
  const head = w.policy.head!;
  w.clock.now = head.kind === "pending" ? head.dueAt : head.until;
  const attempt = (await claim(w))!;
  await confirm(w, attempt);
  transmit(w, attempt, true);
  await complete(w, attempt, true);
  return attempt;
}

async function finish(w: World): Promise<void> {
  w.trace.push("-- settle");
  await settle(w);
  quiescence(w);
}

const rUri = (w: World, label: string) => w.peer.rqs.get(label)!.uri;

describe("quote lifecycle witnesses", () => {
  it("W1: R's Create first, then its request accepted; R applies Kopje's Accept from L", async () => {
    const w = await setup(BASE);
    expect(w.peer.postQuote("RQ1", uriOf(w, "SL1")!)).toBe(true);
    w.policy.labelOf.set(rUri(w, "RQ1"), "RQ1");
    await deliverFirst(w, "Create");
    expect(await stateOf(w, "RQ1")).toBe("pending");
    await deliverFirst(w, "QuoteRequest");
    expect(await stateOf(w, "RQ1")).toBe("accepted");
    await sendAll(w);
    processAll(w);
    const stamp = `${L}${AUTH_PATH}${w.authId.get("a1")}`;
    expect(w.peer.rqs.get("RQ1")!.quote).toMatchObject({ state: "accepted", approvalUri: stamp });
    await finish(w);
    expect((await reads(w)).stamps).toEqual({ a1: 200 });
  });

  it("W2: a request arriving alone is accepted; the later Create and R's Update with the stamp change nothing", async () => {
    const w = await setup(BASE);
    w.peer.postQuote("RQ1", uriOf(w, "SL1")!);
    w.policy.labelOf.set(rUri(w, "RQ1"), "RQ1");
    await deliverFirst(w, "QuoteRequest");
    expect(await stateOf(w, "RQ1")).toBe("accepted");
    await deliverFirst(w, "Create");
    await sendAll(w);
    processAll(w);
    expect(w.peer.outbox.map((m) => m.msg.type)).toEqual(["Update"]);
    await deliverAll(w);
    expect(w.stats["Update stale"]).toBe(1);
    expect(await stateOf(w, "RQ1")).toBe("accepted");
    await finish(w);
  });

  it("W3: a policy change refuses a request still in R's outbox, keeps an accepted quote, and once is enough", async () => {
    const w = await setup(BASE);
    w.peer.postQuote("RQ1", uriOf(w, "SL1")!);
    w.policy.labelOf.set(rUri(w, "RQ1"), "RQ1");
    expect(w.peer.outbox.some((m) => m.msg.type === "QuoteRequest")).toBe(true);
    await lPolicy(w, "SL1", "nobody");
    await deliverAll(w);
    expect(w.stats["QuoteRequest quote-rejected"]).toBe(1);
    await sendAll(w);
    processAll(w);
    expect(w.peer.rqs.get("RQ1")!.quote.state).toBe("rejected");
    // After an acceptance, a change to nobody keeps the quote accepted and its stamp served.
    w.peer.postQuote("RQ2", uriOf(w, "SL2")!);
    w.policy.labelOf.set(rUri(w, "RQ2"), "RQ2");
    await deliverAll(w);
    expect(await stateOf(w, "RQ2")).toBe("accepted");
    await lPolicy(w, "SL2", "nobody");
    expect(await stateOf(w, "RQ2")).toBe("accepted");
    expect((await reads(w)).stamps).toEqual({ a1: 200 });
    // The same policy again records nothing.
    const intents = (await project(w)).intents.length;
    await lPolicy(w, "SL2", "nobody");
    expect((await project(w)).intents).toHaveLength(intents);
    await finish(w);
  });

  it("W4: R's stale view is refused; once R's quote is accepted, a policy change reaches it as a Create and an Update", async () => {
    const w = await setup({ lr: false, rl: false, p: ["public", "public"], q: ["public", "public"] });
    await lPolicy(w, "SL1", "nobody");
    // Neither a follower nor a quoter: R's server keeps the policy it fetched.
    expect(w.policy.lane).toEqual([]);
    expect(w.peer.postQuote("RQ1", uriOf(w, "SL1")!)).toBe(true);
    w.policy.labelOf.set(rUri(w, "RQ1"), "RQ1");
    await deliverAll(w);
    expect(w.stats["QuoteRequest quote-rejected"]).toBe(1);
    w.peer.postQuote("RQ2", uriOf(w, "SL2")!);
    w.policy.labelOf.set(rUri(w, "RQ2"), "RQ2");
    await deliverAll(w);
    expect(await stateOf(w, "RQ2")).toBe("accepted");
    await sendAll(w);
    processAll(w);
    await lPolicy(w, "SL2", "followers");
    expect(w.policy.lane.map((i) => i.type)).toEqual(["Create", "Update"]);
    await sendAll(w);
    processAll(w);
    expect(w.peer.copies.get(uriOf(w, "SL2")!)!.flags).toMatchObject({ public: false, followers: true });
    await finish(w);
  });

  for (const variant of ["after the Accept is confirmed", "before the Accept's first claim"] as const) {
    it(`W5: a revoke ${variant} sends Accept, Delete and Reject, and every processing order ends not accepted`, async () => {
      const w = await setup(BASE);
      w.peer.postQuote("RQ1", uriOf(w, "SL1")!);
      w.policy.labelOf.set(rUri(w, "RQ1"), "RQ1");
      await deliverAll(w);
      expect(await stateOf(w, "RQ1")).toBe("accepted");
      const from = w.log.length;
      if (variant === "after the Accept is confirmed") {
        await sendAll(w);
      } else {
        expect(w.log.some((e) => e.k === "claim" && e.type === "Accept")).toBe(false);
      }
      await lRevoke(w, "RQ1");
      if (variant === "before the Accept's first claim") {
        // C18: the stamp's Delete marks the waiting Accept superseded; its row is still sent.
        expect((await project(w)).intents.find((i) => i.type === "Accept")).toMatchObject({ superseded: true });
      }
      await sendAll(w);
      const claimed = w.log
        .slice(from)
        .filter((e) => e.k === "claim" && e.type !== "Create")
        .map((e) => (e as { type: string }).type)
        // An intent's rows (one per inbox) are claimed one after another.
        .filter((type, i, all) => all[i - 1] !== type);
      expect(claimed).toEqual(["Accept", "Delete", "Reject"]);
      const bodies = w.peer.inbox.length;
      expect(bodies).toBeGreaterThanOrEqual(variant === "after the Accept is confirmed" ? 2 : 3);
      for (const order of permutations(bodies)) {
        const peer = w.peer.clone();
        let pending = [...order];
        while (pending.length > 0) {
          const [next] = pending;
          peer.process(peer.inbox.findIndex((b) => b.seq === w.peer.inbox[next!]!.seq));
          pending = pending.slice(1);
        }
        expect(peer.rqs.get("RQ1")!.quote.state, JSON.stringify(order)).not.toBe("accepted");
      }
      await finish(w);
    });
  }

  it("W6: a second revoke records nothing; after SL's delete, before its job, a revoke and the stamp answer 404", async () => {
    const w = await setup(BASE);
    w.peer.postQuote("RQ1", uriOf(w, "SL1")!);
    w.policy.labelOf.set(rUri(w, "RQ1"), "RQ1");
    await deliverAll(w);
    await lRevoke(w, "RQ1");
    const intents = (await project(w)).intents.length;
    await lRevoke(w, "RQ1");
    expect(w.stats["L revokes _ of _ 200"]).toBe(2);
    expect((await project(w)).intents).toHaveLength(intents);
    w.peer.postQuote("RQ2", uriOf(w, "SL2")!);
    w.policy.labelOf.set(rUri(w, "RQ2"), "RQ2");
    await deliverAll(w);
    expect(await stateOf(w, "RQ2")).toBe("accepted");
    // R's server applies the Accept, and its Update with the stamp reaches Kopje, before L deletes SL2.
    await sendAll(w);
    processAll(w);
    await deliverAll(w);
    await lDelete(w, "SL2");
    expect(await stateOf(w, "RQ2")).toBe("accepted");
    await lRevoke(w, "RQ2");
    expect(w.stats["L revokes _ of _ 404"]).toBe(1);
    expect((await reads(w)).stamps).toMatchObject({ a2: 404 });
    await finish(w);
  });

  it("W7: a revoke of a pending quote rejects it and records nothing; the request then draws a new authorization", async () => {
    const w = await setup(BASE);
    w.peer.postQuote("RQ1", uriOf(w, "SL1")!);
    w.policy.labelOf.set(rUri(w, "RQ1"), "RQ1");
    await deliverFirst(w, "Create");
    expect(await stateOf(w, "RQ1")).toBe("pending");
    const intents = (await project(w)).intents.length;
    await lRevoke(w, "RQ1");
    expect(await stateOf(w, "RQ1")).toBe("rejected");
    expect((await project(w)).intents).toHaveLength(intents);
    await deliverFirst(w, "QuoteRequest");
    expect(await stateOf(w, "RQ1")).toBe("accepted");
    expect(w.authId.size).toBe(1);
    await finish(w);
  });

  it("W8: R's proven Delete of an accepted stamp revokes our quote, forwards once, and a replay changes nothing", async () => {
    const w = await setup(BASE);
    await lPost(w, 0);
    await sendAll(w);
    processAll(w);
    await deliverAll(w);
    expect(await stateOf(w, "LQ1")).toBe("accepted");
    expect(w.policy.lane.map((i) => i.type)).toEqual(["Update"]);
    await sendAll(w);
    const lq1 = uriOf(w, "LQ1")!;
    expect(w.peer.revoke(lq1)).toBe(true);
    const message = w.peer.outbox[0]!;
    await deliverToKopje(w, 0, true);
    expect(await stateOf(w, "LQ1")).toBe("revoked");
    expect(w.policy.lane.map((i) => i.type)).toEqual(["Update", "Delete"]);
    await deliverToKopje(w, 0, false);
    expect(w.peer.outbox).toEqual([]);
    expect(
      w.log.filter((e) => e.k === "kopje" && e.msg === message.seq).map((e) => (e as { reason: string }).reason),
    ).toEqual(["stamp-revoked", "retraction-recorded"]);
    expect(w.policy.lane.map((i) => i.type)).toEqual(["Update", "Delete"]);
    await finish(w);
  });

  it("W9: R accepts, then revokes before its Accept reaches Kopje: Delete first, Accept refused, neither accepted", async () => {
    const w = await setup(BASE);
    await lPost(w, 0);
    await sendAll(w);
    processAll(w);
    expect(w.peer.revoke(uriOf(w, "LQ1")!)).toBe(true);
    await deliverFirst(w, "StampDelete");
    await deliverFirst(w, "Accept");
    expect(w.stats["StampDelete retraction-recorded"]).toBe(1);
    expect(w.stats["Accept quote-unchanged"]).toBe(1);
    expect(await stateOf(w, "LQ1")).toBe("pending");
    await finish(w);
  });

  // X1: copy 1 from a failed attempt, copy 2 from its retry.
  async function twoCopies(w: World, before: () => void, between: () => void) {
    await lPost(w, 0);
    await sendUntil(w, "QuoteRequest");
    const a1 = await failedAttempt(w);
    before();
    processAll(w);
    between();
    const a2 = await retry(w);
    processAll(w);
    const copies = w.log.filter((e) => e.k === "peerCopy");
    expect(copies.map((e) => (e as { token: string }).token)).toEqual([a1.token, a2.token]);
    return { a1, a2 };
  }

  const lq = (w: World) => {
    const uri = uriOf(w, "LQ1")!;
    return { uri, request: `${uri}#quote-request`, status: SR[0] };
  };

  // AC-9: deleting any one causal event makes the predicate false.
  function negatives(w: World, holds: (log: readonly Logged[]) => boolean, causes: ((e: Logged) => boolean)[]) {
    expect(holds(w.log)).toBe(true);
    for (const cause of causes) {
      expect(w.log.some(cause)).toBe(true);
      expect(holds(w.log.filter((e) => !cause(e)))).toBe(false);
    }
  }

  function x1Holds(w: World) {
    const k = kopjeSide(w, "LQ1");
    const theirs = peerSide(w, "LQ1");
    return (log: readonly Logged[]) => replayedRequest(log, lq(w), k, theirs);
  }

  it("W10a (X1): R revokes between two copies of our request; its second Accept leaves R accepted, Kopje revoked", async () => {
    const w = await setup(BASE);
    const { a1, a2 } = await twoCopies(
      w,
      () => {},
      () => {
        expect(w.peer.revoke(uriOf(w, "LQ1")!)).toBe(true);
      },
    );
    await deliverAll(w);
    await finish(w);
    expect(w.stats["exception replayed-request"]).toBe(1);
    negatives(w, x1Holds(w), [
      (e) => e.k === "complete" && e.token === a1.token && !e.ok,
      (e) => e.k === "confirm" && e.token === a2.token,
      (e) => e.k === "peerRevoke",
      (e) => e.k === "kopje" && e.msg === Math.max(...peerAnswers(w).map((x) => x.msg)),
    ]);
  });

  it("W10b (X1): R refuses copy 1, relaxes its policy and accepts copy 2; Kopje keeps the Reject", async () => {
    const w = await setup(BASE);
    const { a1, a2 } = await twoCopies(
      w,
      () => {
        expect(w.peer.setPolicy(SR[0], "nobody")).toBe(true);
      },
      () => {
        expect(w.peer.setPolicy(SR[0], "public")).toBe(true);
      },
    );
    expect(peerAnswers(w).map((x) => x.answer)).toEqual(["Reject", "Accept"]);
    await finish(w);
    expect(w.stats["exception replayed-request"]).toBe(1);
    // The refusal and the relaxed policy that turns it into an Accept are one intervention.
    negatives(w, x1Holds(w), [
      (e) => e.k === "complete" && e.token === a1.token && !e.ok,
      (e) => e.k === "confirm" && e.token === a2.token,
      (e) => e.k === "peerPolicy" || (e.k === "peerAnswer" && e.answer === "Reject"),
      (e) => e.k === "kopje" && e.msg === peerAnswers(w).at(-1)!.msg,
    ]);
  });

  it("W10c (X1): R accepts copy 1, tightens its policy and refuses copy 2; Kopje revokes on the Reject", async () => {
    const w = await setup(BASE);
    const { a1, a2 } = await twoCopies(
      w,
      () => {},
      () => {
        expect(w.peer.setPolicy(SR[0], "nobody")).toBe(true);
      },
    );
    expect(peerAnswers(w).map((x) => x.answer)).toEqual(["Accept", "Reject"]);
    await finish(w);
    expect(w.stats["exception replayed-request"]).toBe(1);
    negatives(w, x1Holds(w), [
      (e) => e.k === "complete" && e.token === a1.token && !e.ok,
      (e) => e.k === "confirm" && e.token === a2.token,
      (e) => e.k === "peerPolicy",
      (e) => e.k === "kopje" && e.msg === peerAnswers(w).at(-1)!.msg,
    ]);
  });

  it("W11: L deletes its quoting status while its request is queued; in either order at R, nothing ends accepted", async () => {
    for (const deleteFirst of [false, true]) {
      const w = await setup(BASE);
      await lPost(w, 0);
      await lDelete(w, "LQ1");
      const intents = (await project(w)).intents.filter((i) => i.subject?.includes(uriOf(w, "LQ1")!));
      expect(intents.map((i) => [i.type, i.superseded])).toEqual([
        ["Create", true],
        ["QuoteRequest", false],
        ["Delete", false],
      ]);
      await jobs(w);
      await sendAll(w);
      if (deleteFirst) {
        peerProcess(
          w,
          w.peer.inbox.findIndex((b) => b.body.type === "Delete"),
        );
      }
      processAll(w);
      expect(w.peer.outbox.some((m) => m.msg.type === "Accept")).toBe(!deleteFirst);
      await finish(w);
    }
  });

  it("W12: R deletes SR: an accepted quote is deleted within the Delete; a pending one keeps no target and no Accept", async () => {
    const w = await setup(BASE);
    await lPost(w, 0);
    await sendAll(w);
    processAll(w);
    await deliverAll(w);
    expect(await stateOf(w, "LQ1")).toBe("accepted");
    await lPost(w, 1);
    await sendAll(w);
    processAll(w);
    expect(w.peer.outbox.map((m) => m.msg.type)).toEqual(["Accept"]);
    expect(w.peer.deleteSr(SR[0])).toBe(true);
    await deliverFirst(w, "Delete");
    expect(await stateOf(w, "LQ1")).toBe("deleted");
    expect((await project(w)).jobs).toBe(0);
    expect(w.peer.deleteSr(SR[1])).toBe(true);
    await deliverFirst(w, "Delete");
    expect((await project(w)).quotes.find((q) => q.label === "LQ2")).toMatchObject({ state: "pending", quoted: null });
    await deliverFirst(w, "Accept");
    expect(w.stats["Accept quote-unchanged"]).toBe(1);
    await finish(w);
  });

  it("W13: L deletes SL while R's quote is accepted: the stamp is gone at once, the quote is deleted by the job", async () => {
    const w = await setup(BASE);
    w.peer.postQuote("RQ1", uriOf(w, "SL1")!);
    w.policy.labelOf.set(rUri(w, "RQ1"), "RQ1");
    await deliverAll(w);
    await sendAll(w);
    processAll(w);
    expect(w.peer.rqs.get("RQ1")!.quote.state).toBe("accepted");
    await deliverAll(w);
    const sl1 = uriOf(w, "SL1")!;
    await lDelete(w, "SL1");
    expect(await stateOf(w, "RQ1")).toBe("accepted");
    expect((await reads(w)).stamps).toEqual({ a1: 404 });
    await jobs(w);
    expect(await stateOf(w, "RQ1")).toBe("deleted");
    expect((await project(w)).revocations).toEqual(["a1"]);
    await sendAll(w);
    processAll(w);
    expect(w.peer.copies.has(sl1)).toBe(false);
    await finish(w);
  });

  it("W14 (fixture): a Delete whose removal cannot finish retires the quote at once, and no request answers it", async () => {
    const w = await setup(BASE);
    w.peer.postQuote("RQ1", uriOf(w, "SL1")!);
    w.policy.labelOf.set(rUri(w, "RQ1"), "RQ1");
    await deliverAll(w);
    expect(await stateOf(w, "RQ1")).toBe("accepted");
    const quoting = (await statusId(w, "RQ1"))!;
    const authorization = w.authId.get("a1")!;
    // 600 silent mentions, so the first batch of the removal (PURGE_BATCH) cannot finish (as quote-requests.test.ts).
    await sql(
      w.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 600)
			INSERT INTO accounts (id, uri, username, domain) SELECT CAST(900000000000000000 + i AS TEXT),
				'https://filler.example/u/' || i, 'u' || i, 'filler.example' FROM n`,
    );
    await sql(
      w.store,
      "INSERT INTO status_mentions (status_id, account_id, silent) SELECT ?, id, 1 FROM accounts WHERE domain = 'filler.example'",
      quoting,
    );
    const receiveAs = (activity: InboundActivity) =>
      w.store.receiveActivity(BUILD, {
        now: w.clock.now,
        origin: LOCAL,
        actorUri: R,
        actor: null,
        actorRevision: null,
        activity,
        recipient: "alice",
      });
    const rq1 = rUri(w, "RQ1");
    expect((await receiveAs({ type: "Delete", id: `${rq1}#delete`, object: rq1 })).reason).toBe("status-deleted");
    expect(await sql(w.store, "SELECT count(*) AS n FROM statuses WHERE id = ?", quoting)).toEqual([{ n: 1 }]);
    expect(
      await sql(
        w.store,
        "SELECT count(*) AS n FROM inbound_jobs WHERE kind = 'delete' AND key = ? AND done_at IS NULL",
        quoting,
      ),
    ).toEqual([{ n: 1 }]);
    expect(await sql(w.store, "SELECT authorization FROM quote_revocations")).toEqual([{ authorization }]);
    expect(await sql(w.store, "SELECT quotes_count FROM statuses WHERE id = ?", w.ids.get("SL1")!)).toEqual([
      { quotes_count: 0 },
    ]);
    expect((await reads(w)).stamps).toEqual({ a1: 404 });
    // While the removal runs, a fresh request naming the quoting status is not a quote (the pending-delete check).
    const answered = await receiveAs({
      type: "QuoteRequest",
      id: `${R_ORIGIN}/quote_requests/fresh`,
      object: uriOf(w, "SL1")!,
      instrument: rq1,
      embedded: null,
    });
    expect(answered.reason).toBe("not-a-quote");
    expect(
      await sql(w.store, "SELECT q.state, q.authorization_id FROM quotes q WHERE q.status_id = ?", quoting),
    ).toEqual([{ state: "revoked", authorization_id: null }]);
  });

  it("W15: a redelivered request gets no second answer or notification; a request for a private status none", async () => {
    const w = await setup(BASE);
    w.peer.postQuote("RQ1", uriOf(w, "SL1")!);
    w.policy.labelOf.set(rUri(w, "RQ1"), "RQ1");
    await deliverFirst(w, "Create");
    await deliverToKopje(w, 0, true);
    await deliverToKopje(w, 0, false);
    expect(w.stats["QuoteRequest quote-accepted"]).toBe(1);
    expect(w.stats["QuoteRequest duplicate"]).toBe(1);
    expect(w.policy.notifications).toEqual(new Set(["RQ1"]));
    const posted = (await api(w, "POST", "/api/v1/statuses", { status: "SL3", visibility: "private" })).body as {
      id: string;
      uri: string;
    };
    w.policy.labelOf.set(posted.uri, "SL3");
    w.policy.addStatus({
      label: "SL3",
      uri: posted.uri,
      author: "L",
      visibility: "private",
      policy: localStored("nobody"),
      withdrawn: false,
      boost: false,
    });
    w.policy.recordCreate(w.clock.now, "SL3");
    await receive(
      w,
      R,
      {
        type: "QuoteRequest",
        id: `${R_ORIGIN}/quote_requests/sl3`,
        object: posted.uri,
        instrument: rUri(w, "RQ1"),
        embedded: null,
      },
      true,
      -1,
      "receive",
    );
    expect(w.stats["QuoteRequest unknown-object"]).toBe(1);
  });

  it("W16: one stamp for two of our quotes: the second is refused while the first holds it, after its Reject and its Delete", async () => {
    const w = await setup(BASE);
    await lPost(w, 0);
    await lPost(w, 0);
    const [q1, q2] = [uriOf(w, "LQ1")!, uriOf(w, "LQ2")!];
    const s = `${R}/quote_authorizations/shared`;
    const answer = (uri: string, type: "Accept" | "Reject"): Msg => {
      const ref = { id: `${uri}#quote-request`, type: null, object: null, instrument: null };
      return type === "Accept"
        ? { type, id: `${R}#accepts/${uri}`, ref, result: s }
        : { type, id: `${R}#rejects/${uri}`, ref };
    };
    await receive(w, R, answer(q1, "Accept"), true, -1, "receive");
    expect((await project(w)).quotes.find((q) => q.label === "LQ1")).toMatchObject({ approvalUri: s });
    expect(await stateOf(w, "LQ2")).toBe("pending");
    await receive(w, R, answer(q2, "Accept"), true, -1, "receive");
    await receive(w, R, answer(q1, "Reject"), true, -1, "receive");
    expect((await project(w)).quotes.find((q) => q.label === "LQ1")).toMatchObject({
      state: "revoked",
      approvalUri: s,
    });
    await receive(w, R, answer(q2, "Accept"), true, -1, "receive");
    await receive(w, R, { type: "StampDelete", id: `${s}#delete`, object: s, proven: true }, false, -1, "receive");
    expect((await project(w)).quotes.find((q) => q.label === "LQ1")).toMatchObject({ approvalUri: null });
    await receive(w, R, answer(q2, "Accept"), true, -1, "receive");
    expect(w.stats["Accept quote-unchanged"]).toBe(3);
    expect(await stateOf(w, "LQ2")).toBe("pending");
  });

  // #1447 and X2: R revokes our pending quote, then accepts its only request under the same stamp.
  async function revokedPending(w: World) {
    await lPost(w, 0);
    await sendUntil(w, "QuoteRequest");
    processAll(w);
    expect(w.peer.copies.get(uriOf(w, "LQ1")!)!.quote!.state).toBe("pending");
    expect(w.peer.revoke(uriOf(w, "LQ1")!)).toBe(true);
  }

  it("W17 (known defect #1447): R's Delete of the stamp first, then its Accept: Kopje pending, R accepted", async () => {
    const w = await setup(BASE);
    await revokedPending(w);
    await deliverAll(w);
    expect(w.stats["StampDelete retraction-recorded"]).toBe(1);
    await sendAll(w);
    processAll(w);
    await deliverAll(w);
    expect(w.stats["Accept quote-unchanged"]).toBe(1);
    await finish(w);
    expect(w.stats["exception known-defect-1447"]).toBe(1);
    const k = { state: w.policy.quotes.get("LQ1")!.state };
    const theirs = peerSide(w, "LQ1");
    negatives(w, (log) => knownDefect1447(log, lq(w), k, theirs), [
      (e) => e.k === "peerRevoke",
      (e) => e.k === "kopje" && e.type === "StampDelete",
      (e) => e.k === "peerAnswer" && e.answer === "Accept",
      (e) => e.k === "kopje" && e.type === "Accept",
    ]);
  });

  it("W18 (X2): R's Accept first, then the Delete of its stamp: Kopje revoked, R accepted", async () => {
    const w = await setup(BASE);
    await revokedPending(w);
    await sendAll(w);
    processAll(w);
    await deliverFirst(w, "Accept");
    expect(await stateOf(w, "LQ1")).toBe("accepted");
    await deliverFirst(w, "StampDelete");
    expect(await stateOf(w, "LQ1")).toBe("revoked");
    await finish(w);
    expect(w.stats["exception revoked-pending-reaccepted"]).toBe(1);
    const k = { state: w.policy.quotes.get("LQ1")!.state };
    const theirs = peerSide(w, "LQ1");
    const holds = (log: readonly Logged[]) => revokedPendingReaccepted(log, lq(w), k, theirs);
    expect(holds(w.log)).toBe(true);
    // Without the pending revoke; with two copies (X1's case); with the Delete applied first (#1447's order).
    expect(holds(w.log.filter((e) => e.k !== "peerRevoke"))).toBe(false);
    const copy = w.log.find((e) => e.k === "peerCopy")!;
    expect(holds([...w.log, { ...copy, n: copy.n + 0.5 }].toSorted((a, b) => a.n - b.n))).toBe(false);
    const kopje = w.log.filter((e) => e.k === "kopje" && (e.type === "Accept" || e.type === "StampDelete"));
    const swapped = w.log.map((e) =>
      e === kopje[0] ? { ...e, n: kopje[1]!.n } : e === kopje[1] ? { ...e, n: kopje[0]!.n } : e,
    );
    expect(holds(swapped)).toBe(false);
  });
});

function peerAnswers(w: World) {
  return w.log.filter((e): e is Logged & { k: "peerAnswer" } => e.k === "peerAnswer");
}

function permutations(n: number): number[][] {
  if (n <= 1) {
    return [[...Array(n).keys()]];
  }
  return permutations(n - 1).flatMap((rest) =>
    Array.from({ length: n }, (_, i) => [...rest.slice(0, i), n - 1, ...rest.slice(i)]),
  );
}
