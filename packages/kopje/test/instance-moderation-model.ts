// Instance domain blocks and remote suspension (R38, VIS-30) as a reference model in plain TypeScript, written from
// docs/visibility.md ("Instance domain blocks", the remote suspension paragraphs, "The send-time check") and
// docs/threat-model.md (VIS-30, RES-5), never from src/; test/instance-moderation.test.ts drives the Store and the API
// against it. Three parts:
//
// - Coverage: a host's rule is its longest matching block, and an account is covered when the rule of its stored
//   domain or of its actor host is a `suspend`.
// - The work ledger: what each moderation job generation must do (its obligations, from documented eligibility), the
//   job's durable frontier as a cut through its walk, and the checks a round or a call of rounds must pass.
// - The P1 relation between a run and its twin whose rounds all ran at settlement.
//
// A change to an R38 rule in docs/visibility.md or docs/threat-model.md changes this file with it.

import { type Intent, Policy } from "./follow-model";

// ---------------------------------------------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------------------------------------------

export type Severity = "suspend" | "noop";
export type Block = {
  domain: string;
  severity: Severity;
  rejectMedia: boolean;
  rejectReports: boolean;
  obfuscate: boolean;
};
export type Source = "account" | "domain" | null;

// The suffixes of a host that a block may name (2 labels or more), longest first.
function suffixes(host: string): string[] {
  const labels = host.split(".");
  return labels.map((_, i) => labels.slice(i).join(".")).filter((suffix) => suffix.split(".").length >= 2);
}

// "Precedence": the block on the host itself or on its nearest parent, the longest match (Mastodon's rule_for).
export function ruleOf(blocks: ReadonlyMap<string, Block>, host: string): Block | undefined {
  for (const suffix of suffixes(host)) {
    const block = blocks.get(suffix);
    if (block !== undefined) {
      return block;
    }
  }
  return undefined;
}

export const hostCovered = (blocks: ReadonlyMap<string, Block>, host: string): boolean =>
  ruleOf(blocks, host)?.severity === "suspend";

// "Availability": covered by either key, the stored domain or the actor id's host.
export const accountCovered = (blocks: ReadonlyMap<string, Block>, a: { domain: string; uri: string }): boolean =>
  hostCovered(blocks, a.domain) || hostCovered(blocks, new URL(a.uri).hostname);

// Mastodon v4.5.11 DomainBlock#stricter_than? (app/models/domain_block.rb:81-87), which a create applies against the
// block ruling its domain (visibility.md, "Precedence": "one whose ruling block is at least as strict").
export function stricterThan(block: { severity: string; rejectMedia: boolean; rejectReports: boolean }, other: Block) {
  if (block.severity === "suspend") {
    return true;
  }
  if (other.severity === "suspend" && (block.severity === "silence" || block.severity === "noop")) {
    return false;
  }
  return (block.rejectMedia || !other.rejectMedia) && (block.rejectReports || !other.rejectReports);
}

export const hasSuspendBlock = (blocks: ReadonlyMap<string, Block>) =>
  [...blocks.values()].some((block) => block.severity === "suspend");

// ---------------------------------------------------------------------------------------------------------------
// The work ledger
// ---------------------------------------------------------------------------------------------------------------

// What the ledger reads of the Store, all ids as decimal TEXT (DATA-6).
export type Snapshot = {
  blocks: ReadonlyMap<string, Block>;
  // Every remote account.
  remotes: readonly { id: string; uri: string; domain: string; source: Source }[];
  // Every follow between a local and a remote account, either way.
  follows: readonly { id: string; follower: string; target: string; state: string }[];
  // Each local follower's list memberships of a remote account it follows.
  members: readonly { follower: string; target: string }[];
  reports: readonly { id: string; target: string; resolved: boolean; lastAction: number }[];
};

export type JobRow = {
  id: string;
  kind: "account" | "domain";
  subject: string;
  mode: "account" | "domain";
  phase: string;
  cursor: string;
  attempts: number;
  dueAt: number | null;
  followBound: string;
  reportBound: string | null;
  actionBound: number | null;
};

const big = (id: string) => BigInt(id);
const DECIMAL = /^[1-9][0-9]*$/;

// A key in a job's walk (the comparator's rules 1, 2 and 5): domain job: stage 0 is the clear walk by account id,
// stage 1 the mark walk by account, then within it the mark (part 0), the out follows by target (part 1) and the in
// follows by (state, id) (part 2). Account job: stage 0 the reports by id, stage 1 out by target, stage 2 in by
// (state, id).
export type Key =
  | { job: "domain"; stage: 0; account: bigint }
  | { job: "domain"; stage: 1; account: bigint; part: 0 }
  | { job: "domain"; stage: 1; account: bigint; part: 1; target: bigint }
  | { job: "domain"; stage: 1; account: bigint; part: 2; state: string; id: bigint }
  | { job: "account"; stage: 0; report: bigint }
  | { job: "account"; stage: 1; target: bigint }
  | { job: "account"; stage: 2; state: string; id: bigint };

export type Obligation = {
  kind: "clear" | "mark" | "sever" | "prepare" | "resolve";
  // The account, the follow's id, the list membership (follower, target) or the report it concerns.
  subject: string;
  key: Key;
};

type Side = { dir: "out" | "in"; target?: bigint; state?: string; id?: bigint };

// The durable frontier, normalized (the table of "The durable frontier").
export type Position =
  | { job: "domain"; stage: 0; after: bigint }
  | { job: "domain"; stage: 1; after: bigint }
  | { job: "domain"; stage: 1; inside: bigint; side: Side }
  | { job: "account"; stage: 0; after: bigint }
  | { job: "account"; stage: 1; after: bigint }
  | { job: "account"; stage: 2; state: string; id: bigint }
  | { job: "domain" | "account"; ended: true };

function fail(job: JobRow, why: string): never {
  throw new Error(`frontier of ${job.kind} job ${job.subject || "''"}: ${why} (${job.phase} ${job.cursor})`);
}

// An id cursor: '' is the start of its stage, which precedes every key of it.
function idCursor(job: JobRow, cursor: string): bigint {
  if (cursor === "") {
    return 0n;
  }
  return DECIMAL.test(cursor) ? big(cursor) : fail(job, "an unparseable cursor");
}

function inCursor(job: JobRow, cursor: string): { state: string; id: bigint } {
  if (cursor === "") {
    return { state: "", id: 0n };
  }
  const [state = "", id = "", ...rest] = cursor.split(" ");
  if (rest.length > 0 || (state !== "accepted" && state !== "pending") || !DECIMAL.test(id)) {
    fail(job, "an in cursor that is not 'state id'");
  }
  return { state, id: big(id) };
}

export function position(job: JobRow): Position {
  if (job.kind === "domain") {
    if (job.phase === "clear") {
      return { job: "domain", stage: 0, after: idCursor(job, job.cursor) };
    }
    if (job.phase !== "mark") {
      fail(job, "an unknown phase");
    }
    let at: { after?: unknown; severing?: unknown; side?: { dir?: unknown; cursor?: unknown } };
    try {
      at = JSON.parse(job.cursor) as typeof at;
    } catch {
      fail(job, "an unparseable cursor");
    }
    if (typeof at.after !== "string") {
      fail(job, "an unparseable cursor");
    }
    const after = idCursor(job, at.after);
    if (at.severing === undefined) {
      return { job: "domain", stage: 1, after };
    }
    if (typeof at.severing !== "string" || !DECIMAL.test(at.severing) || typeof at.side?.cursor !== "string") {
      fail(job, "an unparseable cursor");
    }
    const severing = big(at.severing);
    if (after >= severing) {
      fail(job, "a severing cursor whose after is not below it");
    }
    if (at.side.dir === "out") {
      return { job: "domain", stage: 1, inside: severing, side: { dir: "out", target: idCursor(job, at.side.cursor) } };
    }
    if (at.side.dir !== "in") {
      fail(job, "a side that is neither out nor in");
    }
    return { job: "domain", stage: 1, inside: severing, side: { dir: "in", ...inCursor(job, at.side.cursor) } };
  }
  switch (job.phase) {
    case "reports":
      return { job: "account", stage: 0, after: idCursor(job, job.cursor) };
    case "follows":
    case "out":
      return { job: "account", stage: 1, after: idCursor(job, job.cursor) };
    case "in":
      return { job: "account", stage: 2, ...inCursor(job, job.cursor) };
    default:
      return fail(job, "an unknown phase");
  }
}

// (state, id) as remote-suspension's in walk orders it: state as text, then the numeric id.
function pairBefore(a: { state: string; id: bigint }, b: { state: string; id: bigint }): boolean {
  return a.state < b.state || (a.state === b.state && a.id <= b.id);
}

// Whether `key` lies behind the cut at `pos` (the comparator's rules 1 to 6; an ended position is a finished walk).
export function behind(pos: Position, key: Key): boolean {
  if ("ended" in pos) {
    return true;
  }
  if (pos.job === "domain" && key.job === "domain") {
    if (key.stage === 0) {
      return pos.stage === 1 || key.account <= pos.after;
    }
    if (pos.stage === 0) {
      return false;
    }
    if (!("inside" in pos)) {
      return key.account <= pos.after;
    }
    if (key.account !== pos.inside) {
      return key.account < pos.inside;
    }
    switch (key.part) {
      case 0:
        return true;
      case 1:
        return pos.side.dir === "in" || key.target <= pos.side.target!;
      case 2:
        return pos.side.dir === "in" && pairBefore(key, { state: pos.side.state!, id: pos.side.id! });
    }
  }
  if (pos.job === "account" && key.job === "account") {
    if (key.stage < pos.stage) {
      return true;
    }
    if (key.stage > pos.stage) {
      return false;
    }
    if (key.stage === 0 && pos.stage === 0) {
      return key.report <= pos.after;
    }
    if (key.stage === 1 && pos.stage === 1) {
      return key.target <= pos.after;
    }
    if (key.stage === 2 && pos.stage === 2) {
      return pairBefore(key, pos);
    }
  }
  throw new Error("a key of another job's walk");
}

// The order of positions within one generation (rule 3: the cut never moves back), as a tuple.
function rank(pos: Position): (bigint | string)[] {
  const END = 1n << 80n;
  if ("ended" in pos) {
    return [END];
  }
  if (pos.job === "domain") {
    if (pos.stage === 0) {
      return [0n, pos.after];
    }
    if ("inside" in pos) {
      // Inside s precedes s's completion, and every position after s.
      const side = pos.side.dir === "out" ? [0n, pos.side.target!, "", 0n] : [1n, 0n, pos.side.state!, pos.side.id!];
      return [1n, pos.inside, 0n, ...side];
    }
    return [1n, pos.after, 1n];
  }
  if (pos.stage === 2) {
    return [2n, pos.state, pos.id];
  }
  return [BigInt(pos.stage), pos.after];
}

export function compare(a: Position, b: Position): number {
  const x = rank(a);
  const y = rank(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i];
    const q = y[i];
    if (p === undefined || q === undefined) {
      return p === undefined ? (q === undefined ? 0 : -1) : 1;
    }
    if (p !== q) {
      return p < q ? -1 : 1;
    }
  }
  return 0;
}

const remoteById = (snap: Snapshot) => new Map(snap.remotes.map((r) => [r.id, r]));

// The job's condition, read live before each of its rounds (visibility.md: mode `account` requires the individual
// suspension, mode `domain` the domain mark and live coverage; the domain job always holds).
export function holds(job: JobRow, snap: Snapshot): boolean {
  if (job.kind === "domain") {
    return true;
  }
  const a = remoteById(snap).get(job.subject);
  if (a === undefined) {
    return false;
  }
  return job.mode === "account" ? a.source === "account" : a.source === "domain" && accountCovered(snap.blocks, a);
}

// The obligations of `job` that are eligible in `snap` (documented eligibility, "The work ledger").
export function obligations(job: JobRow, snap: Snapshot): Obligation[] {
  const out: Obligation[] = [];
  const bound = big(job.followBound);
  const remotes = remoteById(snap);
  const member = new Set(snap.members.map((m) => `${m.follower} ${m.target}`));
  // Both ways of `a`, up to the bound: its follows of local accounts (out, by target), local accounts' follows of it
  // (in, by state and id), each with its list membership's removal first.
  const severing = (a: string, both: boolean, at: (part: 1 | 2, f: Snapshot["follows"][number]) => Key) => {
    for (const f of snap.follows) {
      if (big(f.id) > bound) {
        continue;
      }
      if (f.follower === a) {
        out.push({ kind: "sever", subject: f.id, key: at(1, f) });
      } else if (both && f.target === a) {
        out.push({ kind: "sever", subject: f.id, key: at(2, f) });
        if (member.has(`${f.follower} ${a}`)) {
          out.push({ kind: "prepare", subject: `${f.follower} ${a}`, key: at(2, f) });
        }
      }
    }
  };
  if (job.kind === "domain") {
    for (const a of snap.remotes) {
      if (a.source === "domain" && !accountCovered(snap.blocks, a)) {
        out.push({ kind: "clear", subject: a.id, key: { job: "domain", stage: 0, account: big(a.id) } });
      }
    }
    if (!hasSuspendBlock(snap.blocks)) {
      return out;
    }
    for (const a of snap.remotes) {
      if (a.source === "account" || !accountCovered(snap.blocks, a)) {
        continue;
      }
      const account = big(a.id);
      if (a.source === null) {
        out.push({ kind: "mark", subject: a.id, key: { job: "domain", stage: 1, account, part: 0 } });
      }
      severing(a.id, true, (part, f) =>
        part === 1
          ? { job: "domain", stage: 1, account, part, target: big(f.target) }
          : { job: "domain", stage: 1, account, part, state: f.state, id: big(f.id) },
      );
    }
    return out;
  }
  if (!holds(job, snap) || remotes.get(job.subject) === undefined) {
    return out;
  }
  if (job.mode === "account" && job.actionBound !== null && job.reportBound !== null) {
    for (const r of snap.reports) {
      if (
        r.target === job.subject &&
        !r.resolved &&
        big(r.id) <= big(job.reportBound) &&
        r.lastAction <= job.actionBound
      ) {
        out.push({ kind: "resolve", subject: r.id, key: { job: "account", stage: 0, report: big(r.id) } });
      }
    }
  }
  severing(job.subject, job.mode === "domain", (part, f) =>
    part === 1
      ? { job: "account", stage: 1, target: big(f.target) }
      : { job: "account", stage: 2, state: f.state, id: big(f.id) },
  );
  return out;
}

export function complete(ob: Obligation, after: Snapshot): boolean {
  switch (ob.kind) {
    case "clear":
      return remoteById(after).get(ob.subject)?.source !== "domain";
    case "mark":
      return remoteById(after).get(ob.subject)?.source === "domain";
    case "sever":
      return !after.follows.some((f) => f.id === ob.subject);
    case "prepare":
      return !after.members.some((m) => `${m.follower} ${m.target}` === ob.subject);
    case "resolve":
      return after.reports.find((r) => r.id === ob.subject)?.resolved !== false;
  }
}

// What an action completed, from the difference of two snapshots.
export type Completed = {
  severed: string[];
  unlisted: string[];
  marked: string[];
  cleared: string[];
  resolved: string[];
};

export function completed(before: Snapshot, after: Snapshot): Completed {
  const afterFollows = new Set(after.follows.map((f) => f.id));
  const afterMembers = new Set(after.members.map((m) => `${m.follower} ${m.target}`));
  const sources = new Map(after.remotes.map((r) => [r.id, r.source]));
  const resolved = new Set(after.reports.filter((r) => r.resolved).map((r) => r.id));
  return {
    severed: before.follows.filter((f) => !afterFollows.has(f.id)).map((f) => f.id),
    unlisted: before.members.map((m) => `${m.follower} ${m.target}`).filter((m) => !afterMembers.has(m)),
    marked: before.remotes.filter((r) => r.source === null && sources.get(r.id) === "domain").map((r) => r.id),
    cleared: before.remotes.filter((r) => r.source === "domain" && sources.get(r.id) === null).map((r) => r.id),
    resolved: before.reports.filter((r) => !r.resolved && resolved.has(r.id)).map((r) => r.id),
  };
}

export type Caps = { rows: number; sever: number; mark: number; clear: number; reports: number; rounds: number };

// The checks of one `round` (the job `ran` ran) or one `moderation` call (`ran` null: any job may have run), given
// the jobs and snapshots before and after it, and the rows it wrote (a round only). Returns the failures, empty when
// it passes (rules 1, 2, 3 and 5).
export function ledgerCheck(input: {
  before: { jobs: readonly JobRow[]; snap: Snapshot };
  after: { jobs: readonly JobRow[]; snap: Snapshot };
  ran: string | null;
  rows: number | null;
  caps: Caps;
}): string[] {
  const { before, after, ran, caps } = input;
  const failures: string[] = [];
  const done = completed(before.snap, after.snap);
  const ranJobs = before.jobs.filter((job) => ran === null || job.id === ran);
  const eligible = new Map(ranJobs.map((job) => [job.id, obligations(job, before.snap)]));
  const anyEligible = (kind: Obligation["kind"], subject: string) =>
    [...eligible.values()].some((obs) => obs.some((ob) => ob.kind === kind && ob.subject === subject));
  // Rule 1: the envelope.
  const envelope: [Obligation["kind"], string[]][] = [
    ["sever", done.severed],
    ["prepare", done.unlisted],
    ["mark", done.marked],
    ["clear", done.cleared],
    ["resolve", done.resolved],
  ];
  for (const [kind, subjects] of envelope) {
    for (const subject of subjects) {
      if (!anyEligible(kind, subject)) {
        failures.push(`rule 1: ${kind} ${subject} was not eligible for a job that ran`);
      }
    }
  }
  // Rule 5: upper bounds.
  const times = ran === null ? caps.rounds : 1;
  const bounds: [string, number, number][] = [
    ["follows severed", done.severed.length, caps.sever],
    ["accounts marked", done.marked.length, caps.mark],
    ["marks cleared", done.cleared.length, caps.clear],
    ["reports resolved", done.resolved.length, caps.reports],
  ];
  for (const [what, n, cap] of bounds) {
    if (n > cap * times) {
      failures.push(`rule 5: ${n} ${what}, past ${cap * times}`);
    }
  }
  if (input.rows !== null && input.rows > caps.rows) {
    failures.push(`rule 5: ${input.rows} rows written, past ${caps.rows}`);
  }
  if (ran === null) {
    const changed = before.jobs.filter((job) => {
      const now = after.jobs.find((j) => j.id === job.id);
      return now === undefined || now.phase !== job.phase || now.cursor !== job.cursor || now.attempts !== job.attempts;
    });
    if (changed.length > caps.rounds) {
      failures.push(`rule 5: ${changed.length} job rows changed in one call, past ${caps.rounds}`);
    }
  }
  for (const job of ranJobs) {
    const now = after.jobs.find((j) => j.id === job.id);
    const failed = now !== undefined && now.attempts > job.attempts;
    const from = position(job);
    // An ended job finished its walk when its condition held at the action's start, else it was cancelled.
    const to: Position =
      now === undefined ? (holds(job, before.snap) ? { job: job.kind, ended: true } : from) : position(now);
    if (failed) {
      if (now.phase !== job.phase || now.cursor !== job.cursor) {
        failures.push(`rule 3: a failed round of ${job.kind} job ${job.subject} moved its cut`);
      }
      continue;
    }
    if (compare(to, from) < 0) {
      failures.push(`rule 3: the cut of ${job.kind} job ${job.subject} moved back`);
    }
    // Rule 2: crossing soundness.
    const obs = eligible.get(job.id) ?? [];
    for (const ob of obs) {
      if (behind(to, ob.key) && !behind(from, ob.key) && !complete(ob, after.snap)) {
        failures.push(`rule 2: ${job.kind} job ${job.subject} crossed ${ob.kind} ${ob.subject} without doing it`);
      }
    }
    // Rule 3: progress of a round.
    if (ran !== null) {
      const progressed = obs.some((ob) => complete(ob, after.snap)) || compare(to, from) > 0 || now === undefined;
      if (!progressed) {
        failures.push(`rule 3: a round of ${job.kind} job ${job.subject} made no progress`);
      }
    }
  }
  return failures;
}

// Rule 4's settlement: under the final decisions no obligation is eligible for any job kind.
export function settlementFailures(snap: Snapshot, fences: ReadonlyMap<string, JobRow>): string[] {
  const failures: string[] = [];
  for (const a of snap.remotes) {
    const covered = accountCovered(snap.blocks, a);
    if (a.source === "domain" && !covered) {
      failures.push(`a stale domain mark on ${a.id}`);
    }
    if (covered && a.source !== "account") {
      if (a.source !== "domain") {
        failures.push(`covered account ${a.id} unmarked`);
      }
      if (snap.follows.some((f) => f.follower === a.id || f.target === a.id)) {
        failures.push(`covered account ${a.id} keeps a follow`);
      }
    }
    if (a.source === "account") {
      if (snap.follows.some((f) => f.follower === a.id)) {
        failures.push(`individually suspended account ${a.id} keeps a follow of a local account`);
      }
      const fence = fences.get(a.id);
      if (fence !== undefined) {
        const open = obligations(fence, snap).filter((ob) => ob.kind === "resolve");
        if (open.length > 0) {
          failures.push(`individually suspended account ${a.id} keeps reports open inside its last fence`);
        }
      }
    }
  }
  return failures;
}

// Rule 6: `pending` from runModerationJobs: some job is fresh, or backing off and due.
export const pendingAt = (jobs: readonly JobRow[], now: number): boolean =>
  jobs.some((job) => job.attempts === 0 || (job.dueAt !== null && job.dueAt <= now));

// ---------------------------------------------------------------------------------------------------------------
// The world policy: blocks, remote accounts, and one machine-1 Policy per (local, remote) pair
// ---------------------------------------------------------------------------------------------------------------

export type Local = "L1" | "L2";
export type Remote = "R1" | "R2" | "R3" | "R4" | "R5";
export const LOCALS: readonly Local[] = ["L1", "L2"];
export const REMOTES: readonly Remote[] = ["R1", "R2", "R3", "R4", "R5"];

export type RemoteState = {
  stored: boolean;
  uri: string;
  domain: string;
  name: string;
  keys: string[];
  inbox: string;
  sharedInbox: string | null;
  source: Source;
};

export type PolicyReport = { label: string; target: string; resolved: boolean };

export type JobState = { kind: "account" | "domain"; subject: Remote | ""; mode: "account" | "domain" };

export type Document = { name: string; keys: string[]; inbox: string; sharedInbox: string | null };

// docs/visibility.md: "an activity without `to` goes to its recipient's shared inbox, else its personal inbox".
export const inboxOf = (r: { inbox: string; sharedInbox: string | null }) => r.sharedInbox ?? r.inbox;

export class WorldPolicy {
  readonly blocks = new Map<string, Block>();
  readonly pairs = new Map<string, Policy>();
  // L1's pins and list members (both go with the follow: visibility.md R28; the lists' trigger).
  readonly pins = new Set<Remote>();
  readonly listed = new Set<Remote>();
  readonly reports: PolicyReport[] = [];
  readonly jobs = new Map<string, JobState>();

  constructor(
    readonly remotes: Record<Remote, RemoteState>,
    readonly locals: Record<Local, string>,
    locked: readonly Local[],
  ) {
    for (const l of LOCALS) {
      for (const r of REMOTES) {
        const pair = new Policy(locals[l], remotes[r].uri, () => this.refused(r));
        pair.locked = locked.includes(l);
        this.pairs.set(`${l} ${r}`, pair);
      }
    }
  }

  pair(l: Local, r: Remote): Policy {
    return this.pairs.get(`${l} ${r}`)!;
  }

  covered(r: Remote): boolean {
    return accountCovered(this.blocks, this.remotes[r]);
  }

  // R1: a remote account is unavailable while the instance suspended it or a `suspend` block covers it; a domain mark
  // is never read (visibility.md, "Availability"; threat-model.md VIS-30).
  available(r: Remote): boolean {
    const a = this.remotes[r];
    return a.stored && a.source !== "account" && !this.covered(r);
  }

  // The send-time check for a row to `r` (visibility.md, "The send-time check"): it lists `r` alone, so the accounts
  // rule refuses it while `r` is unavailable, and the inbox rule while a block covers its inbox host.
  refused(r: Remote): boolean {
    return !this.available(r) || hostCovered(this.blocks, new URL(inboxOf(this.remotes[r])).hostname);
  }

  private transition(was: boolean, is: boolean): void {
    if (was !== is) {
      this.jobs.set("domain ", { kind: "domain", subject: "", mode: "domain" });
    }
  }

  // ---- Admin decisions (visibility.md, "Instance domain blocks" and the remote suspension paragraphs) ----

  createBlock(domain: string, severity: string, flags: Omit<Block, "domain" | "severity">): number {
    if (severity !== "suspend" && severity !== "noop") {
      return 422;
    }
    const ruling = ruleOf(this.blocks, domain);
    if (ruling !== undefined && (ruling.domain === domain || !stricterThan({ severity, ...flags }, ruling))) {
      return 422;
    }
    this.transition(ruling?.severity === "suspend", severity === "suspend");
    this.blocks.set(domain, { domain, severity, ...flags });
    return 200;
  }

  // "An update checks no conflict"; only a move into or out of `suspend` resets the domain job.
  updateBlock(domain: string, change: Partial<Omit<Block, "domain" | "severity">> & { severity?: string }): number {
    const before = this.blocks.get(domain);
    if (before === undefined) {
      return 404;
    }
    const severity = change.severity ?? before.severity;
    if (severity !== "suspend" && severity !== "noop") {
      return 422;
    }
    this.transition(before.severity === "suspend", severity === "suspend");
    this.blocks.set(domain, { ...before, ...change, severity });
    return 200;
  }

  deleteBlock(domain: string): number {
    const before = this.blocks.get(domain);
    if (before === undefined) {
      return 404;
    }
    this.blocks.delete(domain);
    this.transition(before.severity === "suspend", ruleOf(this.blocks, domain)?.severity === "suspend");
    return 200;
  }

  // A suspension resets the account's job to mode `account`, also of an account already suspended or held by a
  // domain mark (visibility.md: "a suspension again, also of an account already suspended ... restarts it").
  suspend(r: Remote): number {
    this.remotes[r].source = "account";
    this.jobs.set(`account ${r}`, { kind: "account", subject: r, mode: "account" });
    return 200;
  }

  // 403 unless individually suspended (a domain mark alone included); `lifted` when uncovered; `converted` (a domain
  // mark, its job reset to mode `domain`) while a block still covers it.
  unsuspend(r: Remote): { status: number; outcome: "lifted" | "converted" | null } {
    const a = this.remotes[r];
    if (a.source !== "account") {
      return { status: 403, outcome: null };
    }
    if (!this.covered(r)) {
      a.source = null;
      return { status: 200, outcome: "lifted" };
    }
    a.source = "domain";
    this.jobs.set(`account ${r}`, { kind: "account", subject: r, mode: "domain" });
    return { status: 200, outcome: "converted" };
  }

  // The admin's list of suspended accounts: 503 while the domain job exists, else the accounts with a source.
  adminList(): Remote[] | 503 {
    if (this.jobs.has("domain ")) {
      return 503;
    }
    return REMOTES.filter((r) => this.remotes[r].stored && this.remotes[r].source !== null);
  }

  // ---- Local accounts' actions ----

  // Following an unavailable account answers 404 (R21; visibility.md, the remote suspension paragraphs).
  follow(l: Local, r: Remote, now: number, uri: () => string): number {
    return this.available(r) ? this.pair(l, r).localFollow(now, uri) : 404;
  }

  unfollow(l: Local, r: Remote, now: number): number {
    const status = this.pair(l, r).localUnfollow(now);
    this.followEnded(l, r);
    return status;
  }

  followEnded(l: Local, r: Remote): void {
    if (l === "L1" && this.pair(l, r).lr === null) {
      this.pins.delete(r);
      this.listed.delete(r);
    }
  }

  removeFollower(l: Local, r: Remote, now: number): number {
    return this.pair(l, r).removeFromFollowers(now);
  }

  // Answering an unavailable requester's request answers 404 (`answerFollowRequest`).
  answer(l: Local, r: Remote, accept: boolean, now: number): number {
    if (!this.available(r)) {
      return 404;
    }
    return accept ? this.pair(l, r).authorize(now) : this.pair(l, r).rejectRequest(now);
  }

  // A report names an available account; any other is not found (visibility.md, R34).
  report(r: Remote, label: string): number {
    if (!this.available(r)) {
      return 404;
    }
    this.reports.push({ label, target: r, resolved: false });
    return 200;
  }

  // A list membership and an endorsement need an accepted follow (Mastodon's validations).
  listAdd(r: Remote): number {
    if (this.pair("L1", r).lr?.state !== "accepted" || this.listed.has(r)) {
      return 422;
    }
    this.listed.add(r);
    return 200;
  }

  pin(r: Remote): number {
    if (this.pair("L1", r).lr?.state !== "accepted") {
      return 422;
    }
    this.pins.add(r);
    return 200;
  }

  // ---- Inbound (visibility.md: the remote suspension paragraphs, "Writes" and "Inbound") ----

  // The gate: an unavailable actor's activity applies only for Delete, DeleteActor, Undo and Reject; an actor with no
  // stored row on a covered host is ignored.
  gate(r: Remote, type: string): "actor-suspended" | null {
    const a = this.remotes[r];
    if (!a.stored) {
      return hostCovered(this.blocks, new URL(a.uri).hostname) ? "actor-suspended" : null;
    }
    if (this.available(r)) {
      return null;
    }
    return ["Delete", "DeleteActor", "Undo", "Reject"].includes(type) ? null : "actor-suspended";
  }

  // A verified document under the revision its writer read (`current`): an individually suspended, uncovered account
  // takes its routing only; an available one is stored whole, which clears a stale domain mark; a covered one, and
  // any under a superseded revision, stores nothing (ID-1). Returns whether the stored row changed.
  document(r: Remote, doc: Document, current: boolean): boolean {
    const a = this.remotes[r];
    if (!current) {
      return false;
    }
    if (!a.stored) {
      if (hostCovered(this.blocks, new URL(a.uri).hostname) || hostCovered(this.blocks, a.domain)) {
        return false;
      }
      Object.assign(a, { stored: true, ...doc });
      return true;
    }
    if (a.source === "account") {
      if (this.covered(r) || (a.inbox === doc.inbox && a.sharedInbox === doc.sharedInbox)) {
        return false;
      }
      a.inbox = doc.inbox;
      a.sharedInbox = doc.sharedInbox;
      return true;
    }
    if (this.covered(r)) {
      return false;
    }
    Object.assign(a, { ...doc, source: null });
    return true;
  }

  // reject_reports refuses a Flag by the rule of the reporter's stored domain (visibility.md, "The admin API").
  flag(r: Remote, label: string): "reports-rejected" | null {
    if (ruleOf(this.blocks, this.remotes[r].domain)?.rejectReports === true) {
      return "reports-rejected";
    }
    this.reports.push({ label, target: "L1", resolved: false });
    return null;
  }

  // ---- What a round completed ----

  sever(l: Local, r: Remote, side: "out" | "in", now: number): Intent | null {
    const intent = this.pair(l, r).sever(side, now);
    this.followEnded(l, r);
    return intent;
  }
}
