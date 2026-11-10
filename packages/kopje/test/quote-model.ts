// Quote requests, approvals and revocation between one local account L and one Mastodon account R, as two reference
// models in plain TypeScript (test/quote-lifecycle.test.ts drives the Store and the API against them):
//
// - QuotePolicy: Kopje's documented rules (docs/visibility.md R35 and R36, docs/threat-model.md VIS-28, ID-6, ID-7,
//   NET-2), written from the docs and never from src/ (only types are imported): the statuses and their quote
//   policies, the quotes with their states, authorizations and stamps, the requests answered, the revocations and
//   retractions, the quote notifications and silent mentions, and Kopje's outstanding intents for R in their lane.
//   A rule the code follows that the docs do not state yet cites the doc-gap issue as G1-G8; a suspected defect is
//   never policy, only a narrow known-defect exception (knownDefect1447).
// - QuotePeer: R's server, Mastodon v4.5.11, written from its source (each rule cites the file and line it models),
//   applying the bytes Kopje confirmed, each with the inbox it reached, and sending back what Mastodon would.
// - The quiescence relation (live-accepted, stamps) and the exception predicates of the accepted risks X1 and X2 and of
//   #1447, each a pure function of the run's event log, so that a trace with one causal event deleted can be checked.
//
// A change to a quote rule in docs/visibility.md or docs/threat-model.md changes this file with it.

import type { QuoteState } from "../src/domain/quotes";

// ---------------------------------------------------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------------------------------------------------

export const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

// NET-2: "the POST timeout (30 s) is shorter than the lease (60 s)".
export const LEASE_MS = 60_000;
// The most attempts a delivery gets: a run that reaches it has failed its eventual-delivery assumption (AC-6).
export const ATTEMPTS_BOUND = 15;

export type LocalPolicy = "public" | "followers" | "nobody";
export type Half = { public: boolean; followers: boolean; following: boolean; unsupported: boolean };
export type StoredPolicy = { automatic: Half; manual: Half };
export type Answer = { applied: boolean; reason: string };
export type QuoteApproval = "automatic" | "manual" | "unknown" | "denied";

const NONE: Half = { public: false, followers: false, following: false, unsupported: false };

// A Note as the peer writes it (and Kopje's Worker would parse it): its quote and its interactionPolicy.canQuote.
export type PeerNote = {
  uri: string;
  author: string;
  visibility: "public" | "private";
  quote: { uri: string; approvalUri: string | null } | null;
  policy: { automatic: string[]; manual: string[] } | null;
};

export type AnswerRef = { id: string | null; type: string | null; object: string | null; instrument: string | null };

// What R's server (or, in the policy-only property, another remote actor) sends Kopje, as the Worker hands it to the
// Store. personal: delivered to L's personal inbox (the Store's recipient).
export type Msg =
  | { type: "Create"; id: string; note: PeerNote }
  | { type: "Update"; id: string; note: PeerNote }
  | { type: "Delete"; id: string; object: string }
  | { type: "StampDelete"; id: string; object: string; proven: boolean }
  | { type: "QuoteRequest"; id: string; object: string; instrument: string; embedded: PeerNote | null }
  | { type: "Accept"; id: string; ref: AnswerRef; result: string | null }
  | { type: "Reject"; id: string; ref: AnswerRef };

export type Sent = { seq: number; from: string; personal: boolean; msg: Msg };

// docs/visibility.md R36, the policy part: `automatic` when the automatic half allows public, or followers and the
// quoter follows the author, or following and the author follows the quoter; `manual` from the manual half likewise;
// `unknown` when either half is unsupported; `denied` otherwise.
export function policyAnswer(policy: StoredPolicy, quoterFollows: boolean, authorFollows: boolean): QuoteApproval {
  const allows = (h: Half) => h.public || (h.followers && quoterFollows) || (h.following && authorFollows);
  if (allows(policy.automatic)) {
    return "automatic";
  }
  if (allows(policy.manual)) {
    return "manual";
  }
  return policy.automatic.unsupported || policy.manual.unsupported ? "unknown" : "denied";
}

// Api::InteractionPoliciesConcern: a local author's choice as stored (the automatic half only).
export function localStored(name: LocalPolicy): StoredPolicy {
  return {
    automatic: { ...NONE, public: name === "public", followers: name === "followers" },
    manual: NONE,
  };
}

// StatusParser#quote_policy as docs/visibility.md R36 describes Kopje storing it: each listed URI sets the public,
// followers or following flag (the collections the author's stored actor document names), the author itself adds
// nothing, and anything else is unsupported.
export function parsedStored(author: string, policy: { automatic: string[]; manual: string[] } | null): StoredPolicy {
  if (policy === null) {
    return { automatic: NONE, manual: NONE };
  }
  const half = (uris: string[]): Half => {
    const h = { ...NONE };
    for (const uri of uris) {
      if (uri === PUBLIC) {
        h.public = true;
      } else if (uri === `${author}/followers`) {
        h.followers = true;
      } else if (uri === `${author}/following`) {
        h.following = true;
      } else if (uri !== author) {
        h.unsupported = true;
      }
    }
    return h;
  };
  return { automatic: half(policy.automatic), manual: half(policy.manual) };
}

// NoteSerializer#interaction_policy (note_serializer.rb:234-248): the author always, then the collections its
// automatic choice names; Mastodon 4.5 sends no manual half.
export function mastodonCanQuote(author: string, name: LocalPolicy): { automatic: string[]; manual: string[] } {
  return {
    automatic: [
      author,
      ...(name === "public" ? [PUBLIC] : []),
      ...(name === "followers" ? [`${author}/followers`] : []),
    ],
    manual: [],
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The event log the exception predicates read
// ---------------------------------------------------------------------------------------------------------------

export type Event =
  // Kopje's delivery steps, by lease token (the attempt), for the intent `seq`.
  | { k: "claim"; token: string; seq: number; type: string; subject: string }
  | { k: "confirm"; token: string }
  | { k: "transmit"; token: string; reached: boolean }
  | { k: "complete"; token: string; ok: boolean }
  | { k: "expired"; token: string }
  // The peer: a copy of Kopje's QuoteRequest `request` processed, from attempt `token`; its answer; a revoke of L's
  // quote (by its quoting uri) and the state it held then; a policy change of R's status.
  | { k: "peerCopy"; request: string; token: string }
  | { k: "peerAnswer"; request: string; answer: "Accept" | "Reject"; stamp: string | null; msg: number }
  | { k: "peerRevoke"; quoting: string; state: QuoteState; stamp: string; msg: number }
  | { k: "peerPolicy"; status: string }
  // Kopje received the peer's message `msg` and answered `reason`.
  | { k: "kopje"; msg: number; type: Msg["type"]; reason: string };

export type Logged = Event & { n: number };

// ---------------------------------------------------------------------------------------------------------------
// QuotePolicy
// ---------------------------------------------------------------------------------------------------------------

export type Who = "L" | "R" | "F" | "X";

export type KStatus = {
  label: string;
  uri: string;
  author: Who;
  visibility: "public" | "unlisted" | "private" | "direct";
  policy: StoredPolicy;
  // A local status's DELETE withdraws it at once and its job removes it; a remote status's Delete removes it within
  // the Delete in this world (docs/threat-model.md RES-6: the first batch runs in the Delete).
  withdrawn: boolean;
  boost: boolean;
};

export type KQuote = {
  quoted: string | null;
  state: QuoteState;
  local: boolean;
  authorization: string | null;
  approvalUri: string | null;
  activityUri: string | null;
};

export type IntentType = "Create" | "QuoteRequest" | "Update" | "Delete" | "Accept" | "Reject";

export type Intent = {
  seq: number;
  type: IntentType;
  // What the activity is about (NET-2, G1): a status's uri for its Create, Update and Delete; a QuoteRequest's own id;
  // an Accept's stamp; a Reject's request id; a stamp's Delete (L's revoke, or R's forwarded) the stamp. Kopje's own
  // stamps are named by the authorization's label (`stamp:a1`).
  subject: string;
  retracts: boolean;
  superseded: boolean;
  // Rows to R's lane still to deliver, bound to the Store's count when the intent is first seen (row counts belong to
  // VIS-2 and VIS-3); null before. A local status's Delete has none until its job stages it.
  rows: number | null;
  staged: boolean;
  // The order of its rows in the lane (a staged Delete's rows come when its job writes them).
  rowOrder: number;
};

export type Head = { kind: "pending"; dueAt: number } | { kind: "leased"; token: string; until: number };

type Removal = { label: string };

// The place of an intent whose rows are not written yet: after every row written.
const UNWRITTEN = 1e12;

export class QuotePolicy {
  readonly statuses = new Map<string, KStatus>();
  readonly quotes = new Map<string, KQuote>();
  // quote_revocations: Kopje's retired authorizations (by label) and R's revoked stamps (by uri).
  readonly revocations = new Set<string>();
  // R's uris recorded as retracted (ID-7): its deleted statuses and its stamps' Deletes.
  readonly retracted = new Set<string>();
  // quote_requests: each answered request id, with its instrument's uri, its quoted status and when.
  readonly answered = new Map<string, { actor: string; instrument: string; quoted: string; at: number; n: number }>();
  // L's quote notifications, by the quoting status's label; silent mentions as `quoting>account`.
  readonly notifications = new Set<string>();
  readonly mentions = new Set<string>();
  readonly lane: Intent[] = [];
  head: Head | null = null;
  // The attempts of the head row so far.
  attempts = 0;
  // Statuses (by label) whose Create was delivered to R's server (outbound_receipts, by lane origin).
  readonly receipts = new Set<string>();
  readonly removals: Removal[] = [];
  private seq = 0;
  private order = 0;
  private auth = 0;
  private answerN = 0;

  constructor(
    readonly lUri: string,
    readonly rUri: string,
    readonly follows: { lr: boolean; rl: boolean },
    // Other remote actors of the policy-only property, by uri, and whom each follows (`lr`: L follows it).
    readonly others: Map<string, { who: Who; lr: boolean; rl: boolean }> = new Map(),
  ) {}

  who(uri: string): Who {
    return uri === this.lUri ? "L" : uri === this.rUri ? "R" : (this.others.get(uri)?.who ?? "X");
  }

  private uriOf(who: Who): string {
    if (who === "L") {
      return this.lUri;
    }
    if (who === "R") {
      return this.rUri;
    }
    return [...this.others].find(([, o]) => o.who === who)?.[0] ?? `unknown ${who}`;
  }

  // L follows `who`, and `who` follows L.
  private lFollows(who: Who): boolean {
    return who === "R" ? this.follows.lr : [...this.others.values()].some((o) => o.who === who && o.lr);
  }

  private followsL(who: Who): boolean {
    return who === "R" ? this.follows.rl : [...this.others.values()].some((o) => o.who === who && o.rl);
  }

  byUri(uri: string): KStatus | undefined {
    return [...this.statuses.values()].find((s) => s.uri === uri);
  }

  stampOf(authorization: string): string {
    return `stamp:${authorization}`;
  }

  addStatus(status: KStatus): void {
    this.statuses.set(status.label, status);
  }

  quotesCount(label: string): number {
    return [...this.quotes.values()].filter((q) => q.quoted === label && q.state === "accepted").length;
  }

  // ---- The lane (NET-2) ----

  // NET-2: a lane is (actor, inbox origin); everything L sends R's server is one lane, delivered in order of its rows.
  private promote(now: number): void {
    if (this.head === null && this.headIntent() !== undefined) {
      this.head = { kind: "pending", dueAt: now };
      this.attempts = 0;
    }
  }

  // The intent whose row is the lane's first: rows are ordered as they were written (a job writes a staged Delete's
  // rows, VIS-3), which the Store shows when they are (bind).
  headIntent(): Intent | undefined {
    return this.lane
      .filter((i) => (i.rows === null ? !i.staged : i.rows > 0))
      .toSorted((a, b) => a.rowOrder - b.rowOrder)[0];
  }

  // NET-2 and G1: a retraction marks every earlier activity about its subject superseded (an operator's retry of it
  // is refused, its queued rows are still sent); an Update marks earlier Updates of its status only.
  private record(
    now: number,
    input: { type: IntentType; subject: string; retracts?: boolean; staged?: boolean },
  ): Intent {
    const retracts = input.retracts === true;
    for (const earlier of this.lane) {
      if (earlier.subject === input.subject && (retracts || (input.type === "Update" && earlier.type === "Update"))) {
        earlier.superseded = true;
      }
    }
    const intent: Intent = {
      seq: ++this.seq,
      type: input.type,
      subject: input.subject,
      retracts,
      superseded: false,
      rows: null,
      staged: input.staged === true,
      rowOrder: UNWRITTEN + ++this.order,
    };
    this.lane.push(intent);
    this.promote(now);
    return intent;
  }

  // docs/threat-model.md NET-2 (an Update of a status goes alone to a server known to have it, by a delivered
  // Create's receipt; any other server gets a Create of the current version and then the Update, which replace the
  // Creates and Updates of the status still waiting for it there).
  private recordUpdate(now: number, label: string): void {
    const subject = this.statuses.get(label)!.uri;
    for (const earlier of this.lane) {
      if (earlier.type === "Update" && earlier.subject === subject) {
        earlier.superseded = true;
      }
    }
    if (!this.receipts.has(label)) {
      const head = this.headIntent();
      for (const earlier of this.lane.slice()) {
        if (
          (earlier.type === "Create" || earlier.type === "Update") &&
          earlier.subject === subject &&
          !earlier.retracts
        ) {
          const leased = this.head?.kind === "leased" && earlier === head;
          earlier.rows = leased ? 1 : 0;
          if (earlier.rows === 0) {
            if (earlier === head && this.head?.kind === "pending") {
              this.head = null;
            }
            this.lane.splice(this.lane.indexOf(earlier), 1);
          }
        }
      }
      this.record(now, { type: "Create", subject });
    }
    this.record(now, { type: "Update", subject });
    this.promote(now);
  }

  // A local status's Create to its followers (R, when R follows L).
  recordCreate(now: number, label: string): void {
    this.record(now, { type: "Create", subject: this.statuses.get(label)!.uri });
  }

  // The intents the Store shows, bound in order: an intent whose rows are seen for the first time takes the Store's
  // row count and the place of its first row (row counts belong to VIS-2 and VIS-3, not to this policy).
  bind(rows: readonly { rows: number; first: number | null }[], now: number): void {
    this.lane.forEach((intent, i) => {
      const seen = rows[i];
      if (intent.rows === null && !intent.staged && seen !== undefined && seen.rows > 0 && seen.first !== null) {
        intent.rows = seen.rows;
        intent.rowOrder = seen.first;
      }
    });
    this.promote(now);
  }

  // A claim leases the lane's head row once it is due (an expired lease is due again).
  claim(now: number, token: string): { leased: Intent | null; gaveUp: boolean } {
    const head = this.headIntent();
    if (this.head === null || head === undefined) {
      return { leased: null, gaveUp: false };
    }
    const due = this.head.kind === "pending" ? this.head.dueAt <= now : this.head.until <= now;
    if (!due) {
      return { leased: null, gaveUp: false };
    }
    if (this.attempts >= ATTEMPTS_BOUND) {
      return { leased: null, gaveUp: true };
    }
    this.head = { kind: "leased", token, until: now + LEASE_MS };
    this.attempts++;
    return { leased: head, gaveUp: false };
  }

  private leased(token: string): Intent | undefined {
    return this.head?.kind === "leased" && this.head.token === token ? this.headIntent() : undefined;
  }

  // Confirmation and completion require the current lease token (NET-2). A superseded intent is still sent (G1): only
  // follow answers are dropped, and this world has none.
  confirm(token: string): { status: "send"; intent: Intent } | { status: "stale" } {
    const intent = this.leased(token);
    return intent === undefined ? { status: "stale" } : { status: "send", intent };
  }

  complete(token: string, delivered: boolean, now: number, retryAt: number | null): "delivered" | "retry" | "stale" {
    const intent = this.leased(token);
    if (intent === undefined) {
      return "stale";
    }
    if (delivered) {
      if (intent.type === "Create") {
        const status = this.byUri(intent.subject);
        if (status !== undefined) {
          this.receipts.add(status.label);
        }
      }
      intent.rows = (intent.rows ?? 1) - 1;
      this.head = null;
      if (intent.rows <= 0) {
        this.lane.splice(this.lane.indexOf(intent), 1);
      }
      this.promote(now);
      return "delivered";
    }
    if (retryAt === null || retryAt <= now) {
      throw new Error("policy: a retry must be due later");
    }
    this.head = { kind: "pending", dueAt: retryAt };
    return "retry";
  }

  // ---- L's actions through the API ----

  // R36 for L on Kopje's stored view (docs/visibility.md R36): the status is there, not a boost, public or unlisted,
  // and its policy does not deny L.
  approvalFor(label: string): QuoteApproval {
    const s = this.statuses.get(label);
    if (s === undefined || s.withdrawn || s.boost || (s.visibility !== "public" && s.visibility !== "unlisted")) {
      return "denied";
    }
    if (s.author === "L") {
      return "automatic";
    }
    return policyAnswer(s.policy, this.lFollows(s.author), this.followsL(s.author));
  }

  // POST /api/v1/statuses {quoted_status_id} (docs/visibility.md R36, VIS-28, G1): 404 when R36 refuses; else a
  // pending quote with a silent mention of the quoted author, and its Create then its QuoteRequest.
  postQuote(now: number, label: string, quotedLabel: string, uri: () => string): number {
    if (this.approvalFor(quotedLabel) === "denied") {
      return 404;
    }
    const quoted = this.statuses.get(quotedLabel)!;
    const statusUri = uri();
    this.addStatus({
      label,
      uri: statusUri,
      author: "L",
      visibility: "public",
      policy: localStored("public"),
      withdrawn: false,
      boost: false,
    });
    this.quotes.set(label, {
      quoted: quotedLabel,
      state: "pending",
      local: true,
      authorization: null,
      approvalUri: null,
      activityUri: `${statusUri}#quote-request`,
    });
    this.mentions.add(`${label}>${quoted.author}`);
    this.record(now, { type: "Create", subject: statusUri });
    this.record(now, { type: "QuoteRequest", subject: `${statusUri}#quote-request` });
    return 200;
  }

  // Whether an activity about L's status `label` reaches R (docs/visibility.md audience: followers, mentions, and the
  // remote authors of its accepted quotes, VIS-28).
  private reachesR(label: string): boolean {
    return (
      this.follows.rl ||
      this.mentions.has(`${label}>R`) ||
      [...this.quotes].some(
        ([quoting, q]) => q.quoted === label && q.state === "accepted" && this.statuses.get(quoting)?.author === "R",
      )
    );
  }

  // PUT /api/v1/statuses/:id/interaction_policy (docs/visibility.md R36; G6): 404 when L may not see the status (it
  // is withdrawn); an unchanged policy records nothing; a change records the status's Update and leaves its accepted
  // quotes as they are.
  setPolicy(now: number, label: string, name: LocalPolicy): number {
    const s = this.statuses.get(label);
    if (s === undefined || s.withdrawn) {
      return 404;
    }
    const stored = s.visibility === "public" || s.visibility === "unlisted" ? localStored(name) : localStored("nobody");
    if (JSON.stringify(stored) === JSON.stringify(s.policy)) {
      return 200;
    }
    s.policy = stored;
    if (this.reachesR(label)) {
      this.recordUpdate(now, label);
    }
    return 200;
  }

  // The requests answered for R's quote `quoting` of `quoted`, oldest first (VIS-28: a revoke sends a Reject of each).
  private answeredFor(quoting: string, quoted: string): string[] {
    const instrument = this.statuses.get(quoting)?.uri;
    return [...this.answered]
      .filter(([, a]) => a.instrument === instrument && a.quoted === quoted && a.actor === this.rUri)
      .toSorted(([ia, a], [ib, b]) => a.at - b.at || (ia < ib ? -1 : ia > ib ? 1 : 0))
      .map(([id]) => id);
  }

  // POST /api/v1/statuses/:id/quotes/:quoting_id/revoke (VIS-28; G5): 404 unless L may see the quoted status and the
  // quote is there; an accepted quote becomes revoked (its authorization retired) with the signed Delete of its stamp,
  // a pending one rejected; then a Reject of each request answered for it, after the Delete; anything else records
  // nothing.
  revoke(now: number, quotedLabel: string, quoting: string): number {
    const s = this.statuses.get(quotedLabel);
    const q = this.quotes.get(quoting);
    if (s === undefined || s.withdrawn || q === undefined || q.quoted !== quotedLabel) {
      return 404;
    }
    if (q.state !== "accepted" && q.state !== "pending") {
      return 200;
    }
    if (q.state === "accepted") {
      const authorization = q.authorization!;
      this.retire(q);
      q.state = "revoked";
      this.record(now, { type: "Delete", subject: this.stampOf(authorization), retracts: true });
    } else {
      q.state = "rejected";
    }
    for (const request of this.answeredFor(quoting, quotedLabel)) {
      this.record(now, { type: "Reject", subject: request, retracts: true });
    }
    return 200;
  }

  // docs/threat-model.md VIS-28: every way out of accepted retires the authorization (quote_revocations).
  private retire(q: KQuote): void {
    if (q.authorization !== null) {
      this.revocations.add(q.authorization);
      q.authorization = null;
    }
  }

  // DELETE /api/v1/statuses/:id: the status is withdrawn at once (direct, no stamp served, no revoke) and its job
  // removes it (docs/threat-model.md RES-6). A quoting status's quote ends, pending included, and no answer applies
  // after that (G4). Its Delete supersedes the status's earlier Create and Updates, not its QuoteRequest (G1), and is
  // staged by the job.
  deleteStatus(now: number, label: string): number {
    const s = this.statuses.get(label);
    if (s === undefined || s.withdrawn || s.author !== "L") {
      return 404;
    }
    s.withdrawn = true;
    s.visibility = "direct";
    const q = this.quotes.get(label);
    if (q !== undefined && (q.state === "accepted" || q.state === "pending")) {
      this.retire(q);
      q.state = "revoked";
    }
    this.record(now, { type: "Delete", subject: s.uri, retracts: true, staged: true });
    this.removals.push({ label });
    return 200;
  }

  // A job round: each withdrawn local status's Delete is staged to the inboxes that received the status or would
  // receive it now (docs/threat-model.md VIS-3), then the status is removed; the quoted status's removal detaches its
  // quotes (docs/visibility.md R35: accepted becomes deleted, its authorization retired; a pending quote stays pending
  // without a target, G4).
  jobs(now: number): boolean {
    const removals = this.removals.splice(0);
    for (const { label } of removals) {
      const s = this.statuses.get(label)!;
      const intent = this.lane.find((i) => i.type === "Delete" && i.subject === s.uri && i.staged);
      if (intent !== undefined) {
        intent.staged = false;
        const earlier = this.lane.some((i) => i !== intent && i.subject === s.uri && (i.rows ?? 1) > 0);
        if (this.receipts.has(label) || earlier || this.reachesR(label)) {
          this.promote(now);
        } else {
          this.lane.splice(this.lane.indexOf(intent), 1);
        }
      }
      for (const [quoting, q] of this.quotes) {
        if (q.quoted === label && quoting !== label) {
          this.detach(q);
        }
      }
      this.removeStatus(label);
    }
    return removals.length > 0;
  }

  private detach(q: KQuote): void {
    if (q.state === "accepted") {
      this.retire(q);
      q.state = "deleted";
    }
    q.quoted = null;
  }

  private removeStatus(label: string): void {
    this.statuses.delete(label);
    this.quotes.delete(label);
    this.notifications.delete(label);
    for (const m of Array.from(this.mentions)) {
      if (m.startsWith(`${label}>`)) {
        this.mentions.delete(m);
      }
    }
    this.receipts.delete(label);
  }

  // ---- Stamps and reads ----

  // docs/threat-model.md VIS-28: a stamp is served only for the current authorization of an accepted quote of a local
  // public or unlisted status not withdrawn, while the quoting status is there; a retired id never again.
  stampServed(authorization: string): boolean {
    if (this.revocations.has(authorization)) {
      return false;
    }
    for (const [quoting, q] of this.quotes) {
      if (q.authorization === authorization && q.state === "accepted" && q.quoted !== null) {
        const target = this.statuses.get(q.quoted);
        return (
          target !== undefined &&
          target.author === "L" &&
          !target.withdrawn &&
          (target.visibility === "public" || target.visibility === "unlisted") &&
          this.statuses.has(quoting)
        );
      }
    }
    return false;
  }

  // ---- Inbound activities (VIS-28, ID-6, ID-7; the reasons are G7) ----

  receive(actor: string, msg: Msg, now: number, personal: boolean): Answer {
    switch (msg.type) {
      case "QuoteRequest":
        return this.quoteRequest(actor, msg, now);
      case "Accept":
        return this.accept(actor, msg, now);
      case "Reject":
        return this.reject(actor, msg, now);
      case "StampDelete":
        return this.stampDelete(actor, msg, now);
      case "Delete":
        return this.deleteRemote(actor, msg.object, now);
      case "Create":
        return this.store(actor, msg.note, personal, false, now);
      case "Update":
        return this.update(actor, msg.note, now);
    }
  }

  private nextLabel(prefix: string): string {
    let n = 1;
    while (this.statuses.has(`${prefix}${n}`) || this.quotes.has(`${prefix}${n}`)) {
      n++;
    }
    return `${prefix}${n}`;
  }

  // Labels the test gives remote statuses it names (R's quoting statuses are labelled by the peer).
  readonly labelOf = new Map<string, string>();

  // A remote Note stored (docs/visibility.md: a status concerns this instance when it addresses a local account, its
  // author has local followers, or it was fetched; ID-7: never a retracted one; C17: its quote policy is taken at its
  // first store). A Note quoting a status stores a pending quote of it (no verification work in this world).
  private store(actor: string, note: PeerNote, personal: boolean, fetched: boolean, now: number): Answer {
    if (new URL(note.uri).origin !== new URL(actor).origin) {
      return { applied: false, reason: "foreign-object" };
    }
    if (note.author !== actor) {
      return { applied: false, reason: "not-author" };
    }
    if (this.retracted.has(note.uri)) {
      return { applied: false, reason: "retracted" };
    }
    if (this.byUri(note.uri) !== undefined) {
      return personal ? { applied: true, reason: "audience-extended" } : { applied: false, reason: "duplicate" };
    }
    const who = this.who(actor);
    if (!fetched && !personal && !this.followsLocal(who)) {
      return { applied: false, reason: "unrelated" };
    }
    const label = this.labelOf.get(note.uri) ?? this.nextLabel(`${who}S`);
    this.labelOf.set(note.uri, label);
    this.addStatus({
      label,
      uri: note.uri,
      author: who,
      visibility: note.visibility,
      policy: parsedStored(actor, note.policy),
      withdrawn: false,
      boost: false,
    });
    if (note.quote !== null) {
      // A withdrawn target (its removal under way) is none (docs/visibility.md R35).
      const target = this.byUri(note.quote.uri);
      this.quotes.set(label, {
        quoted: target === undefined || target.withdrawn || target.boost ? null : target.label,
        state: "pending",
        local: false,
        authorization: null,
        approvalUri: note.quote.approvalUri,
        activityUri: null,
      });
    }
    void now;
    return { applied: true, reason: "created" };
  }

  // A remote author with a local follower (L follows it).
  private followsLocal(who: Who): boolean {
    return this.lFollows(who);
  }

  // An Update: ID-7 refuses a retracted status; an implicit Update (no newer version) of a stored status changes only
  // its quote policy (C17) and never the state of a quote of a local status (C20).
  private update(actor: string, note: PeerNote, now: number): Answer {
    if (this.retracted.has(note.uri)) {
      return { applied: false, reason: "retracted" };
    }
    const s = this.byUri(note.uri);
    if (s === undefined) {
      return this.store(actor, note, false, false, now);
    }
    const policy = parsedStored(actor, note.policy);
    if (JSON.stringify(policy) !== JSON.stringify(s.policy)) {
      s.policy = policy;
      return { applied: true, reason: "policy-updated" };
    }
    return { applied: false, reason: "stale" };
  }

  // A remote author's Delete of its status (ID-7: recorded as retracted): its accepted quote is retired at once
  // (VIS-28), and its removal finishes within the Delete here; the quotes of it are detached (R35).
  private deleteRemote(actor: string, uri: string, now: number): Answer {
    void now;
    const s = this.byUri(uri);
    this.retracted.add(uri);
    if (s === undefined) {
      return { applied: true, reason: "retraction-recorded" };
    }
    const own = this.quotes.get(s.label);
    if (own !== undefined && own.state === "accepted") {
      this.retire(own);
      own.state = "revoked";
    }
    for (const [quoting, q] of this.quotes) {
      if (q.quoted === s.label && quoting !== s.label) {
        this.detach(q);
      }
    }
    this.removeStatus(s.label);
    return { applied: true, reason: "status-deleted" };
  }

  // docs/visibility.md R36 and docs/threat-model.md VIS-28: a QuoteRequest is answered only for a local, available
  // author's public or unlisted original (else no answer); R36 decides, in the final Store round (a Reject when it
  // refuses); the instrument is the actor's own status, stored from the request's inlined Note when it is not stored
  // yet (ID-7: never one whose Delete was recorded), and its stored quote must name the object; one answer per request
  // id. An acceptance draws a fresh authorization and records an Accept carrying its stamp, a silent mention of the
  // quoted author and, with the count, a quote notification (G2); a new id for an accepted quote is answered with the
  // same stamp (G3).
  private quoteRequest(actor: string, msg: Msg & { type: "QuoteRequest" }, now: number): Answer {
    if (this.answered.has(msg.id)) {
      return { applied: false, reason: "duplicate" };
    }
    const quoted = this.byUri(msg.object);
    if (
      quoted === undefined ||
      quoted.author !== "L" ||
      quoted.withdrawn ||
      quoted.boost ||
      (quoted.visibility !== "public" && quoted.visibility !== "unlisted")
    ) {
      return { applied: false, reason: "unknown-object" };
    }
    const who = this.who(actor);
    const answer = policyAnswer(quoted.policy, this.followsL(who), this.lFollows(who));
    const record = () =>
      this.answered.set(msg.id, {
        actor,
        instrument: msg.instrument,
        quoted: quoted.label,
        at: now,
        n: ++this.answerN,
      });
    if (answer === "denied") {
      record();
      this.record(now, { type: "Reject", subject: msg.id });
      return { applied: true, reason: "quote-rejected" };
    }
    let quoting = this.byUri(msg.instrument);
    if (quoting === undefined) {
      const note = msg.embedded;
      if (
        note === null ||
        note.uri !== msg.instrument ||
        note.author !== actor ||
        new URL(note.uri).origin !== new URL(actor).origin
      ) {
        return { applied: false, reason: "need-instrument" };
      }
      const stored = this.store(actor, note, false, true, now);
      quoting = this.byUri(msg.instrument);
      if (quoting === undefined) {
        return { applied: false, reason: stored.reason };
      }
    }
    const q = this.quotes.get(quoting.label);
    if (q === undefined || q.quoted !== quoted.label || quoting.author !== who || quoting.boost) {
      return { applied: false, reason: "not-a-quote" };
    }
    record();
    if (q.state === "accepted" && q.authorization !== null) {
      this.record(now, { type: "Accept", subject: this.stampOf(q.authorization) });
      return { applied: true, reason: "quote-accepted-again" };
    }
    const authorization = `a${++this.auth}`;
    q.state = "accepted";
    q.authorization = authorization;
    q.activityUri = msg.id;
    this.mentions.add(`${quoting.label}>L`);
    this.record(now, { type: "Accept", subject: this.stampOf(authorization) });
    this.notifications.add(quoting.label);
    return { applied: true, reason: "quote-accepted" };
  }

  // The answer an Accept or Reject names: our request by its id, or an inlined QuoteRequest whose instrument is our
  // quoting status and whose object is the actor's status; only of a quoting status not withdrawn (G4), and only from
  // the quoted author (ID-6), whose quote a detach has not cleared (G4).
  private answeredQuote(actor: string, ref: AnswerRef): string | undefined {
    const who = this.who(actor);
    for (const [label, q] of this.quotes) {
      const s = this.statuses.get(label);
      if (s === undefined || s.withdrawn || !q.local || q.quoted === null) {
        continue;
      }
      if (this.statuses.get(q.quoted)?.author !== who) {
        continue;
      }
      if (ref.id !== null && ref.id === q.activityUri) {
        return label;
      }
      if (ref.type === "QuoteRequest" && ref.instrument === s.uri && ref.object === this.statuses.get(q.quoted)?.uri) {
        return label;
      }
    }
    return undefined;
  }

  private originOf(uri: string | null): string | null {
    return uri === null ? null : (URL.parse(uri)?.origin ?? null);
  }

  // docs/threat-model.md VIS-28 (our Accept): a compare-and-set on a pending quote, from the quoted author, with a
  // stamp on the author's origin that is neither revoked nor retracted and held by no other local quote; it records
  // the quoting status's Update carrying the stamp (G2).
  private accept(actor: string, msg: Msg & { type: "Accept" }, now: number): Answer {
    const label = this.answeredQuote(actor, msg.ref);
    const result = msg.result;
    if (
      label === undefined ||
      result === null ||
      this.originOf(result) !== this.originOf(actor) ||
      this.revocations.has(result) ||
      this.retracted.has(result)
    ) {
      return { applied: false, reason: "quote-unchanged" };
    }
    const q = this.quotes.get(label)!;
    const held = [...this.quotes].some(([other, o]) => other !== label && o.local && o.approvalUri === result);
    if (q.state !== "pending" || held) {
      return { applied: false, reason: "quote-unchanged" };
    }
    q.state = "accepted";
    q.approvalUri = result;
    this.recordUpdate(now, label);
    return { applied: true, reason: "quote-accepted" };
  }

  // A Reject of our request: pending becomes rejected, accepted revoked with the Update without the stamp; the stamp
  // is kept until its Delete (VIS-28).
  private reject(actor: string, msg: Msg & { type: "Reject" }, now: number): Answer {
    const label = this.answeredQuote(actor, msg.ref);
    const q = label === undefined ? undefined : this.quotes.get(label);
    if (q === undefined || (q.state !== "pending" && q.state !== "accepted")) {
      return { applied: false, reason: "quote-unchanged" };
    }
    if (q.state === "accepted") {
      q.state = "revoked";
      this.recordUpdate(now, label!);
    } else {
      q.state = "rejected";
    }
    return { applied: true, reason: "quote-rejected" };
  }

  // A stamp's Delete (ID-6, ID-7, VIS-28): recorded as retracted; when a local quote of the actor's status holds the
  // stamp, an accepted one becomes revoked with the Update without the stamp, a proven Delete is forwarded once (the
  // quote lets go of the stamp) and the stamp is revoked for good; another actor's Delete revokes nothing of this
  // one's.
  private stampDelete(actor: string, msg: Msg & { type: "StampDelete" }, now: number): Answer {
    this.retracted.add(msg.object);
    const who = this.who(actor);
    const held = [...this.quotes].find(
      ([, q]) =>
        q.local && q.approvalUri === msg.object && q.quoted !== null && this.statuses.get(q.quoted)?.author === who,
    );
    if (held === undefined) {
      return { applied: true, reason: "retraction-recorded" };
    }
    const [label, q] = held;
    if (q.state === "accepted") {
      q.state = "revoked";
      this.recordUpdate(now, label);
    }
    if (msg.proven) {
      const s = this.statuses.get(label)!;
      if (!s.withdrawn) {
        this.record(now, { type: "Delete", subject: msg.object, retracts: true });
      }
      q.approvalUri = null;
    }
    this.revocations.add(msg.object);
    return { applied: true, reason: "stamp-revoked" };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// QuotePeer: R's server, Mastodon v4.5.11
// ---------------------------------------------------------------------------------------------------------------

// A body Kopje confirmed, as the peer parses it.
export type Body = {
  id: string;
  type: string;
  actor: string;
  object: unknown;
  result?: string;
  instrument?: unknown;
};

type MQuote = { quoted: string | null; state: QuoteState; activityUri: string | null; id: number };
type OwnQuote = { quoted: string | null; state: QuoteState; approvalUri: string | null; activityUri: string };

export type PeerStatus = { uri: string; policy: LocalPolicy; deleted: boolean };

export class QuotePeer {
  // R's own statuses that L may quote (SR*), with their policies.
  readonly srs = new Map<string, PeerStatus>();
  // R's quoting statuses (by label) and their quotes of L's statuses.
  readonly rqs = new Map<string, { uri: string; deleted: boolean; quote: OwnQuote }>();
  // Copies of L's statuses: an SL's parsed policy flags, an L quoting status's quote of R's status (Quote rows whose
  // quoted account is R).
  readonly copies = new Map<string, { flags: Half; quote: MQuote | null }>();
  // Tombstones (delete.rb:30-32) and the uris of Kopje's statuses whose Delete came first.
  readonly tombstones = new Set<string>();
  inbox: { seq: number; body: Body; inbox: string; token: string }[] = [];
  outbox: Sent[] = [];
  readonly sent: Sent[] = [];
  private quoteId = 0;
  private n = 0;
  private seq = 0;
  private inSeq = 0;

  constructor(
    readonly origin: string,
    readonly rUri: string,
    readonly lUri: string,
    readonly follows: { lr: boolean; rl: boolean },
    readonly emit: (e: Event) => void,
  ) {}

  stamp(id: number): string {
    // tag_manager.rb:68-73: the stamp of a quote is named by the quote's id.
    return `${this.rUri}/quote_authorizations/${id}`;
  }

  private send(msg: Msg, personal: boolean): number {
    const message = { seq: ++this.seq, from: this.rUri, personal, msg };
    this.outbox.push(message);
    this.sent.push(message);
    return message.seq;
  }

  receive(body: Body, inbox: string, token: string): void {
    this.inbox.push({ seq: ++this.inSeq, body, inbox, token });
  }

  // ---- R's actions ----

  // R's status as Mastodon's NoteSerializer writes it (note_serializer.rb:234-248 for its policy).
  noteOf(uri: string): PeerNote {
    const sr = this.srs.get(uri);
    if (sr !== undefined) {
      return {
        uri,
        author: this.rUri,
        visibility: "public",
        quote: null,
        policy: mastodonCanQuote(this.rUri, sr.policy),
      };
    }
    const rq = [...this.rqs.values()].find((q) => q.uri === uri)!;
    return {
      uri,
      author: this.rUri,
      visibility: "public",
      quote: rq.quote.quoted === null ? null : { uri: rq.quote.quoted, approvalUri: rq.quote.approvalUri },
      policy: mastodonCanQuote(this.rUri, "public"),
    };
  }

  // StatusPolicy#quote? on R's own view of L's status (status_policy.rb:22-24; interaction_policy_concern.rb:29-69).
  private mayQuote(sl: string): boolean {
    const copy = this.copies.get(sl);
    if (copy === undefined || this.tombstones.has(sl)) {
      return false;
    }
    const f = copy.flags;
    return f.public || (f.followers && this.follows.rl) || (f.following && this.follows.lr);
  }

  // PostStatusService#attach_quote! (post_status_service.rb:106-113, :159): a pending quote with its activity_uri
  // (quote.rb:108-110); the Create to its reach, which includes L (status_reach_finder.rb:51-53), and the QuoteRequest
  // with the Note inlined to L's inbox (quote_request_worker.rb:15-21; quote_request_serializer.rb:20-38).
  postQuote(label: string, sl: string): boolean {
    if (this.rqs.has(label) || !this.mayQuote(sl)) {
      return false;
    }
    const id = ++this.quoteId;
    const uri = `${this.rUri}/statuses/${label.toLowerCase()}`;
    const quote: OwnQuote = {
      quoted: sl,
      state: "pending",
      approvalUri: null,
      activityUri: `${this.origin}/quote_requests/${id}`,
    };
    this.rqs.set(label, { uri, deleted: false, quote });
    this.send({ type: "Create", id: `${uri}/activity`, note: this.noteOf(uri) }, false);
    this.send(
      { type: "QuoteRequest", id: quote.activityUri, object: sl, instrument: uri, embedded: this.noteOf(uri) },
      true,
    );
    return true;
  }

  // QuotesController#revoke (quotes_controller.rb:17-23; quote_policy.rb:4-6): any state; reject! (quote.rb:58-64),
  // then RevokeQuoteService's Delete of the stamp, its id forced, signed (revoke_quote_service.rb:6-13, :23-42), to
  // the reach of both statuses, which includes L through quotes_account_ids in any state. No Reject is sent.
  revoke(quoting: string): boolean {
    const copy = this.copies.get(quoting);
    if (copy?.quote == null) {
      return false;
    }
    const before = copy.quote.state;
    reject(copy.quote);
    const stamp = this.stamp(copy.quote.id);
    const msg = this.send({ type: "StampDelete", id: `${stamp}#delete`, object: stamp, proven: true }, false);
    this.emit({ k: "peerRevoke", quoting, state: before, stamp, msg });
    return true;
  }

  // Whether R's status reaches L: L follows R, or L has a quote of it here in any state (status_reach_finder.rb:63-66,
  // :83-86).
  private reachesL(sr: string): boolean {
    return this.follows.lr || [...this.copies.values()].some((c) => c.quote?.quoted === sr);
  }

  // InteractionPoliciesController#update (interaction_policies_controller.rb:8-27): an implicit Update to followers
  // and quoters (status_update_distribution_worker.rb:18-28).
  setPolicy(sr: string, policy: LocalPolicy): boolean {
    const s = this.srs.get(sr);
    if (s === undefined || s.deleted || s.policy === policy) {
      return false;
    }
    s.policy = policy;
    this.emit({ k: "peerPolicy", status: sr });
    if (this.reachesL(sr)) {
      this.send({ type: "Update", id: `${sr}#updates/${++this.n}`, note: this.noteOf(sr) }, false);
    }
    return true;
  }

  // RemoveStatusService (remove_status_service.rb:16-53): R's quoting status is not revoked by R (:51 requires a local
  // quoted account); R's status SR leaves its quotes without a target (status.rb:83).
  deleteRq(label: string): boolean {
    const rq = this.rqs.get(label);
    if (rq === undefined || rq.deleted) {
      return false;
    }
    rq.deleted = true;
    this.send({ type: "Delete", id: `${rq.uri}#delete`, object: rq.uri }, false);
    return true;
  }

  deleteSr(sr: string): boolean {
    const s = this.srs.get(sr);
    if (s === undefined || s.deleted) {
      return false;
    }
    const reaches = this.reachesL(sr);
    s.deleted = true;
    for (const copy of this.copies.values()) {
      if (copy.quote?.quoted === sr) {
        copy.quote.quoted = null;
      }
    }
    if (reaches) {
      this.send({ type: "Delete", id: `${sr}#delete`, object: sr }, false);
    }
    return true;
  }

  // ---- Bodies from Kopje (each an independent job: processing_worker.rb:3-16) ----

  process(index: number): Body | null {
    const [item] = this.inbox.splice(index, 1);
    if (item === undefined) {
      return null;
    }
    this.handle(item.body, item.inbox, item.token);
    return item.body;
  }

  private personal(inbox: string): boolean {
    return inbox === `${this.rUri}/inbox`;
  }

  private handle(body: Body, inbox: string, token: string): void {
    // process_collection_service.rb:25: R's own activity forwarded back is ignored.
    if (body.actor !== this.lUri) {
      return;
    }
    switch (body.type) {
      case "Create":
        this.create(body.object as Record<string, unknown>, this.personal(inbox));
        return;
      case "Update":
        this.update(body.object as Record<string, unknown>);
        return;
      case "Delete":
        this.delete(typeof body.object === "string" ? body.object : (body.object as { id: string }).id);
        return;
      case "QuoteRequest":
        this.quoteRequest(body, token);
        return;
      case "Accept":
        this.accept(body);
        return;
      case "Reject":
        this.reject(body);
        return;
    }
  }

  // StatusParser on L's Note: the flags of its automatic half (status_parser.rb:126-136, :171-188).
  parseFlags(note: Record<string, unknown>): Half {
    const policy = note.interactionPolicy as { canQuote?: { automaticApproval?: unknown } } | undefined;
    const list = policy?.canQuote?.automaticApproval;
    const uris = Array.isArray(list) ? (list as string[]) : typeof list === "string" ? [list] : [];
    return {
      public: uris.includes(PUBLIC),
      followers: uris.includes(`${this.lUri}/followers`),
      following: uris.includes(`${this.lUri}/following`),
      unsupported: false,
    };
  }

  // ActivityPub::Activity::Create (create.rb:15, :19, :21-28, :422-435): stored only when related (R follows L, or the
  // body came to R's personal inbox), never over a Tombstone; a status R holds is left as it is. A quote of R's status
  // stays pending (verify_quote_service.rb:17).
  ingest(note: Record<string, unknown>, related: boolean): void {
    const uri = note.id as string;
    if (this.copies.has(uri) || this.tombstones.has(uri) || !related) {
      return;
    }
    const quoted = typeof note.quote === "string" ? note.quote : null;
    this.copies.set(uri, {
      flags: this.parseFlags(note),
      quote:
        quoted === null
          ? null
          : {
              quoted: this.srs.has(quoted) && !this.srs.get(quoted)!.deleted ? quoted : null,
              state: "pending",
              activityUri: null,
              id: ++this.quoteId,
            },
    });
  }

  private create(note: Record<string, unknown>, personal: boolean): void {
    this.ingest(note, this.follows.rl || personal);
  }

  // ProcessStatusUpdateService: an implicit Update of L's status applies its policy (:68-75); an Update of L's quoting
  // status changes no quote (:288-301, the return at :293).
  private update(note: Record<string, unknown>): void {
    const copy = this.copies.get(note.id as string);
    if (copy !== undefined) {
      copy.flags = this.parseFlags(note);
    }
  }

  // ActivityPub::Activity::Delete (delete.rb:20-44, :58-67): a stamp's Delete matches R's own quote by approval_uri,
  // its quoted account the sender, pending or accepted, and rejects it; a Note's, after the Tombstone (:30-32), deletes
  // the status.
  private delete(object: string): void {
    const own = [...this.rqs.values()].find(
      (rq) =>
        !rq.deleted &&
        rq.quote.approvalUri === object &&
        (rq.quote.state === "pending" || rq.quote.state === "accepted"),
    );
    if (own !== undefined) {
      reject(own.quote);
      return;
    }
    if (object.includes("/quote_authorizations/")) {
      return;
    }
    this.tombstones.add(object);
    this.copies.delete(object);
    for (const rq of this.rqs.values()) {
      if (rq.quote.quoted === object) {
        rq.quote.quoted = null;
      }
    }
  }

  // ActivityPub::Activity::QuoteRequest (quote_request.rb), from sender L.
  private quoteRequest(body: Body, token: string): void {
    const request = body.id;
    this.emit({ k: "peerCopy", request, token });
    const object = typeof body.object === "string" ? body.object : (body.object as { id: string }).id;
    // :7 the id on the sender's host; :9-10 R's local, distributable original.
    const sr = this.srs.get(object);
    if (new URL(request).origin !== new URL(this.lUri).origin || sr === undefined || sr.deleted) {
      return;
    }
    // :12-16 R's policy decides for the sender (Mastodon 4.5.11 accepts manual approval automatically, :12).
    const allowed = sr.policy === "public" || (sr.policy === "followers" && this.follows.lr);
    const inline = body.instrument as Record<string, unknown> | string;
    const instrument = typeof inline === "string" ? inline : (inline.id as string);
    const ref: AnswerRef = { id: request, type: "QuoteRequest", object, instrument };
    if (!allowed) {
      // :55-65 an unsaved Quote; reject_quote_request_serializer.rb:8-10 names it by an empty quote id.
      const msg = this.send({ type: "Reject", id: `${this.rUri}#rejects/quote_requests/`, ref }, true);
      this.emit({ k: "peerAnswer", request, answer: "Reject", stamp: null, msg });
      return;
    }
    // :21-24 the instrument stored, else imported (refused over a Tombstone, create.rb:15, :19); :28 nil raises.
    if (!this.copies.has(instrument) && typeof inline !== "string") {
      this.ingest(inline, true);
    }
    const copy = this.copies.get(instrument);
    // :28 the quote must quote that object and belong to the sender.
    if (copy?.quote == null || copy.quote.quoted !== object) {
      return;
    }
    // :31-32 activity_uri set and accept! from any state (quote.rb:48-56); :34-35 the Accept to the sender's inbox
    // (accept_quote_request_serializer.rb:8-22).
    copy.quote.activityUri = request;
    copy.quote.state = "accepted";
    const stamp = this.stamp(copy.quote.id);
    const msg = this.send(
      { type: "Accept", id: `${this.rUri}#accepts/quote_requests/${copy.quote.id}`, ref, result: stamp },
      true,
    );
    this.emit({ k: "peerAnswer", request, answer: "Accept", stamp, msg });
  }

  // ActivityPub::Activity::Accept#accept_quote! (accept.rb:4-15, :47-58): the quote found by quoted account and
  // activity_uri (activity.rb:160-162) applies only when the result is on the sender's host, its quoted account is the
  // sender, the quoting status is R's and the quote pending (:49); then an Update of R's status carries the stamp
  // (:54-57).
  private accept(body: Body): void {
    const object = typeof body.object === "string" ? body.object : (body.object as { id: string }).id;
    const rq = [...this.rqs.entries()].find(([, q]) => q.quote.activityUri === object);
    const result = body.result ?? null;
    if (rq === undefined || result === null) {
      return;
    }
    const [, own] = rq;
    if (
      new URL(result).origin !== new URL(body.actor).origin ||
      own.quote.quoted === null ||
      body.actor !== this.lUri ||
      own.deleted ||
      own.quote.state !== "pending"
    ) {
      return;
    }
    own.quote.state = "accepted";
    own.quote.approvalUri = result;
    this.send({ type: "Update", id: `${own.uri}#updates/${++this.n}`, note: this.noteOf(own.uri) }, false);
  }

  // ActivityPub::Activity::Reject (reject.rb:4-16, :42-47): the quoted account is the sender and the quoting status
  // R's; reject! from any state.
  private reject(body: Body): void {
    const object = typeof body.object === "string" ? body.object : (body.object as { id: string }).id;
    const rq = [...this.rqs.values()].find((q) => q.quote.activityUri === object && !q.deleted);
    if (rq !== undefined && body.actor === this.lUri) {
      reject(rq.quote);
    }
  }
}

// Quote#reject! (quote.rb:58-64): accepted becomes revoked; anything else but revoked becomes rejected.
function reject(quote: { state: QuoteState }): void {
  if (quote.state === "accepted") {
    quote.state = "revoked";
  } else if (quote.state !== "revoked") {
    quote.state = "rejected";
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Quiescence and the exceptions
// ---------------------------------------------------------------------------------------------------------------

// Live-accepted: accepted with the quoting and the quoted statuses both present; the stamp is compared only then.
export type Side = { live: boolean; stamp: string | null };

const byToken = (log: readonly Logged[], token: string) => log.filter((e) => "token" in e && e.token === token);

// The attempts that confirmed and transmitted a copy of the QuoteRequest that reached R's server, by token.
function reachedAttempts(log: readonly Logged[], request: string): Logged[] {
  return log.filter(
    (e): e is Logged & { k: "claim" } =>
      e.k === "claim" &&
      e.type === "QuoteRequest" &&
      e.subject === request &&
      byToken(log, e.token).some((x) => x.k === "confirm") &&
      byToken(log, e.token).some((x) => x.k === "transmit" && x.reached),
  );
}

// X1, accepted risk (docs/threat-model.md): `replayed-request(q, ρ)`. Two copies of L's QuoteRequest ρ were processed
// at R's server, copy 1 from attempt a1 and copy 2 from a later attempt a2 that exists because a1's completion failed
// or its lease expired; between them R's server revoked q, changed its status's policy, or answered copy 1 with a
// Reject and copy 2 with an Accept; copy 2's answer reached Kopje and applied, or was refused only because an answer of
// q R's server sent before it (its revoke's stamp Delete, copy 1's Reject) applied first; at quiescence R's server is
// live-accepted on q and Kopje is not.
export function replayedRequest(
  log: readonly Logged[],
  q: { uri: string; request: string; status: string },
  kopje: Side,
  peer: Side,
): boolean {
  if (!peer.live || kopje.live) {
    return false;
  }
  const copies = log.filter((e): e is Logged & { k: "peerCopy" } => e.k === "peerCopy" && e.request === q.request);
  const reached = reachedAttempts(log, q.request);
  for (const [i, c1] of copies.entries()) {
    for (const c2 of copies.slice(i + 1)) {
      const a1 = reached.find((a) => a.k === "claim" && a.token === c1.token);
      const a2 = reached.find((a) => a.k === "claim" && a.token === c2.token);
      if (a1 === undefined || a2 === undefined || a2.n < a1.n) {
        continue;
      }
      // a2 exists because a1 failed or its lease expired, before a2's claim.
      const cause = byToken(log, c1.token).some(
        (e) => ((e.k === "complete" && !e.ok) || e.k === "expired") && e.n < a2.n,
      );
      if (!cause) {
        continue;
      }
      const between = (e: Logged) => e.n > c1.n && e.n < c2.n;
      const answer = (c: Logged) =>
        log.find(
          (e): e is Logged & { k: "peerAnswer" } => e.k === "peerAnswer" && e.request === q.request && e.n > c.n,
        );
      const first = answer(c1);
      const second = answer(c2);
      const revokes = log.filter(
        (e): e is Logged & { k: "peerRevoke" } => e.k === "peerRevoke" && e.quoting === q.uri && between(e),
      );
      const intervened =
        revokes.length > 0 ||
        log.some((e) => e.k === "peerPolicy" && e.status === q.status && between(e)) ||
        (first?.answer === "Reject" && second?.answer === "Accept");
      if (!intervened || second === undefined || second.n < c2.n) {
        continue;
      }
      const got = log.find((e): e is Logged & { k: "kopje" } => e.k === "kopje" && e.msg === second.msg);
      if (got === undefined) {
        continue;
      }
      const applied = got.reason === "quote-accepted" || got.reason === "quote-rejected";
      // An earlier answer of q that applied at Kopje before it: a linked revoke's stamp Delete, or copy 1's Reject.
      const earlier = [...revokes.map((r) => r.msg), ...(first?.answer === "Reject" ? [first.msg] : [])].some((msg) =>
        log.some(
          (e) =>
            e.k === "kopje" &&
            e.msg === msg &&
            e.n < got.n &&
            (e.reason === "stamp-revoked" || e.reason === "quote-rejected"),
        ),
      );
      if (applied || (got.reason === "quote-unchanged" && earlier)) {
        return true;
      }
    }
  }
  return false;
}

// The chain X2 and #1447 share: R's server revoked q while it was pending there, its Delete(s) linked to that revoke,
// then processed exactly one copy of ρ, after the revoke, and answered Accept(s).
function revokedPendingThenAccepted(log: readonly Logged[], q: { uri: string; request: string }) {
  const revoke = log.find(
    (e): e is Logged & { k: "peerRevoke" } => e.k === "peerRevoke" && e.quoting === q.uri && e.state === "pending",
  );
  if (revoke === undefined) {
    return null;
  }
  const copies = log.filter((e) => e.k === "peerCopy" && e.request === q.request);
  if (copies.length !== 1 || copies[0]!.n < revoke.n) {
    return null;
  }
  const accept = log.find(
    (e): e is Logged & { k: "peerAnswer" } =>
      e.k === "peerAnswer" && e.request === q.request && e.answer === "Accept" && e.stamp === revoke.stamp,
  );
  if (accept === undefined) {
    return null;
  }
  const got = (msg: number) => log.find((e): e is Logged & { k: "kopje" } => e.k === "kopje" && e.msg === msg);
  return { revoke, accept, deleted: got(revoke.msg), accepted: got(accept.msg) };
}

// X2, accepted risk (docs/threat-model.md): `revoked-pending-reaccepted(q, s)`. Kopje applied Accept(s) before it
// received Delete(s), which then revoked it; at quiescence R's server is live-accepted with s and Kopje is revoked.
export function revokedPendingReaccepted(
  log: readonly Logged[],
  q: { uri: string; request: string },
  kopje: { state: QuoteState | null },
  peer: Side,
): boolean {
  const chain = revokedPendingThenAccepted(log, q);
  return (
    chain !== null &&
    chain.accepted?.reason === "quote-accepted" &&
    chain.deleted?.reason === "stamp-revoked" &&
    chain.accepted.n < chain.deleted.n &&
    peer.live &&
    peer.stamp === chain.revoke.stamp &&
    kopje.state === "revoked"
  );
}

// Known defect #1447: the chain of X2 with the opposite arrival order. Kopje received Delete(s) first (recorded as a
// retraction), then refused Accept(s); at quiescence R's server is live-accepted with s while Kopje holds q pending.
// Removed with its witness W17 when #1447 is decided.
export function knownDefect1447(
  log: readonly Logged[],
  q: { uri: string; request: string },
  kopje: { state: QuoteState | null },
  peer: Side,
): boolean {
  const chain = revokedPendingThenAccepted(log, q);
  return (
    chain !== null &&
    chain.deleted?.reason === "retraction-recorded" &&
    chain.accepted?.reason === "quote-unchanged" &&
    chain.deleted.n < chain.accepted.n &&
    peer.live &&
    peer.stamp === chain.revoke.stamp &&
    kopje.state === "pending"
  );
}
