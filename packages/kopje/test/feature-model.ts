// Feature authorizations of remote collections' items (#1589's D21 and D22) as a reference model in plain TypeScript
// (test/feature-lifecycle.test.ts drives the Store against it): one remote member M, an owner O whose collection lists M
// with M's authorizations, and another owner X whose collection lists M with O's authorization.
//
// - FeaturePolicy: Kopje's documented rules (docs/threat-model.md ID-6's remote collection rows and their item checks,
//   ID-7's item retraction, RES-6's check rounds and the accepted risk `check-gave-up`), written from the docs and never
//   from src/ (only types are imported): each owner's item of M with its revision, state, verified authorization and
//   check (queue, claim token, attempts), the Deletes received, the retractions and the retired rows' cleanup.
// - The event log, and the exception predicate `checkGaveUp` as a pure function of it, so that a trace with one causal
//   event deleted can be checked.
//
// A change to these rules in docs/threat-model.md changes this file with it.

import type { ItemCheckOutcome } from "../src/domain/collection-checks";

// ---------------------------------------------------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------------------------------------------------

export const DAY_MS = 86_400_000;
// RES-6: a revision of an item has at most 5 attempts (claims); a claim holds its item for 10 minutes; a transient
// failure retries after 15 minutes × 4^(attempts − 1).
export const CHECK_ATTEMPTS = 5;
export const CHECK_LEASE_MS = 10 * 60_000;
export const CHECK_BACKOFF_MS = 15 * 60_000;
// ID-7: a retraction holds for 30 days.
const RETRACTION_MS = 30 * DAY_MS;
// Mastodon v4.7.5 serves a feature authorization publicly cacheable for 30 seconds
// (app/controllers/activitypub/feature_authorizations_controller.rb:12).
const AUTHORIZATION_CACHE_MS = 30_000;

export type Owner = "O" | "X";
export type ItemState = "pending" | "accepted" | "rejected" | "revoked";
// How a listing reached Kopje: a read of the owner's collections, or the owner's Add, Remove or Update.
export type Path = "read" | "add" | "remove" | "update";

// An owner's item of M as Kopje holds it (migration 0103's columns): its uri, state, candidate (the authorization the
// owner lists), verified authorization, queue (the time it is due), attempts, claim token, and last change.
export type Row = {
  uri: string;
  state: ItemState;
  candidate: string;
  approval: string | null;
  due: number | null;
  attempts: number;
  token: string | null;
  changed: number;
};

// ---------------------------------------------------------------------------------------------------------------
// The event log the exception predicate reads
// ---------------------------------------------------------------------------------------------------------------

export type FeatureEvent =
  | { k: "list"; owner: Owner; uri: string; authorization: string; path: Path; result: string }
  | { k: "unlist"; owner: Owner; uri: string | null; path: Path; result: string }
  | { k: "withdraw"; authorization: string }
  | { k: "delete"; authorization: string; relayed: boolean; result: string }
  | { k: "claim"; owner: Owner; token: string | null; result: "claimed" | "gave-up" }
  | { k: "lease-expiry"; owner: Owner; token: string }
  | { k: "fetch"; token: string; outcome: ItemCheckOutcome }
  | { k: "complete"; token: string; outcome: ItemCheckOutcome; result: string }
  | { k: "cleanup"; owner: Owner };

export type Logged = FeatureEvent & { n: number };

const ENDED = new Set(["accepted", "rejected", "mismatch", "held by another row"]);

// The accepted risk `check-gave-up` (docs/threat-model.md, Accepted risks): the owner's current revision (its last new
// revision in the log) had CHECK_ATTEMPTS claims, none of which a completion ended (each expired or failed
// transiently), and the claim after them ended the revision's check.
export function checkGaveUp(log: readonly Logged[], owner: Owner): boolean {
  const start = log.findLastIndex((e) => e.k === "list" && e.owner === owner && e.result === "new revision");
  if (start < 0) {
    return false;
  }
  const since = log.slice(start + 1);
  const tokens = new Set(
    since.flatMap((e) => (e.k === "claim" && e.owner === owner && e.result === "claimed" ? [e.token] : [])),
  );
  return (
    tokens.size === CHECK_ATTEMPTS &&
    since.some((e) => e.k === "claim" && e.owner === owner && e.result === "gave-up") &&
    !since.some((e) => e.k === "complete" && tokens.has(e.token) && ENDED.has(e.result))
  );
}

// ---------------------------------------------------------------------------------------------------------------
// FeaturePolicy
// ---------------------------------------------------------------------------------------------------------------

export class FeaturePolicy {
  // Each owner's item of M (one a collection, one member).
  readonly rows = new Map<Owner, Row>();
  // The authorizations whose Delete Kopje processed.
  readonly deletes = new Set<string>();
  // ID-7: the item uris an owner's Remove named while Kopje held no such item, with the time it was recorded.
  readonly retracted = new Map<string, number>();
  // ID-7: the authorizations whose Delete Kopje processed, kept as M's retraction, with the time it was recorded.
  readonly withdrawals = new Map<string, number>();
  readonly log: Logged[] = [];
  // Violations of the rules' own guarantees (Evidence, Revocations received, Fences), checked as each rule applies.
  readonly problems: string[] = [];

  private record(event: FeatureEvent): void {
    this.log.push({ ...event, n: this.log.length });
  }

  // ID-6 and D22's revision rule: a listing of M under `uri` with `authorization`. A read or an Update replaces the
  // collection's items with the listing (a row under another uri is deleted); an Add is refused while ID-7 retracts the
  // uri or another item of the collection holds M. An unchanged revision changes nothing, whatever the row's state and
  // queue; a new item or a changed revision is pending with the new candidate, no verified authorization, attempts 0,
  // no claim, and due now.
  list(owner: Owner, uri: string, authorization: string, path: Path, now: number): string {
    const row = this.rows.get(owner);
    let result: string;
    if (path === "add" && ((this.retracted.get(uri) ?? -Infinity) + RETRACTION_MS > now || (row && row.uri !== uri))) {
      result = "refused";
    } else if (row?.uri === uri && row.candidate === authorization) {
      result = "unchanged";
    } else {
      this.rows.set(owner, {
        uri,
        state: "pending",
        candidate: authorization,
        approval: null,
        due: now,
        attempts: 0,
        token: null,
        changed: now,
      });
      result = "new revision";
    }
    this.record({ k: "list", owner, uri, authorization, path, result });
    return `${owner}.lists:${result}`;
  }

  // D21: the owner no longer lists M (a read or an Update listing nothing), or its Remove of `uri`: the row is deleted,
  // whatever its state; a Remove of an item Kopje does not hold is recorded as its retraction (ID-7).
  unlist(owner: Owner, uri: string | null, path: Path, now: number): string {
    const row = this.rows.get(owner);
    let result: string;
    if (row !== undefined && (path !== "remove" || row.uri === uri)) {
      this.rows.delete(owner);
      result = "removed";
    } else {
      if (path === "remove" && uri !== null) {
        this.retracted.set(uri, now);
      }
      result = "nothing";
    }
    this.record({ k: "unlist", owner, uri, path, result });
    return `${owner}.removes:${result}`;
  }

  withdraw(authorization: string): string {
    this.record({ k: "withdraw", authorization });
    return "M.withdraws";
  }

  // ID-6: the member's Delete of its authorization `authorization`, direct or relayed with its proof, which names the
  // collection of `named`. Its row is the member's row whose verified authorization it is, else the member's row in
  // that collection; that row is revoked (unqueued, unclaimed) only while the authorization is its current one, its
  // verified authorization, or its candidate while none is verified. Any other Delete changes no row. Each is kept as
  // M's retraction of the authorization (ID-7), which a check's completion reads.
  deleteReceived(authorization: string, named: Owner, relayed: boolean, now: number): string {
    this.deletes.add(authorization);
    const row = [...this.rows.values()].find((r) => r.approval === authorization) ?? this.rows.get(named);
    let result = "nothing";
    if (row !== undefined && row.state !== "revoked") {
      if (row.approval === authorization) {
        result = "revoked";
      } else if (row.approval === null && row.candidate === authorization) {
        result = "candidate-revoked";
      }
      if (result !== "nothing") {
        Object.assign(row, { state: "revoked", due: null, token: null, changed: now });
      }
    }
    this.withdrawals.set(authorization, now);
    this.record({ k: "delete", authorization, relayed, result });
    return `K.Delete:${result}`;
  }

  // The items a check round claims at `now`: each due one (pending and queued, its lease run out if claimed). A claim
  // that would be the revision's sixth attempt ends its check (pending, unqueued); any other takes the claim's token,
  // an attempt, and its lease. `claimed`: the token the Store gave each owner's item. Returns the transitions.
  claim(now: number, claimed: ReadonlyMap<Owner, string>): string[] {
    const labels: string[] = [];
    for (const [owner, row] of this.rows) {
      if (row.due === null || row.due > now) {
        if (claimed.has(owner)) {
          this.problems.push(`${owner}'s item claimed while not due`);
        }
        continue;
      }
      if (row.token !== null) {
        this.record({ k: "lease-expiry", owner, token: row.token });
        labels.push("K.lease-expiry");
      }
      if (row.attempts >= CHECK_ATTEMPTS) {
        Object.assign(row, { due: null, token: null });
        this.record({ k: "claim", owner, token: null, result: "gave-up" });
        labels.push("K.claim:gave-up");
        if (claimed.has(owner)) {
          this.problems.push(`${owner}'s item claimed past its attempts`);
        }
        continue;
      }
      const token = claimed.get(owner) ?? null;
      if (token === null) {
        this.problems.push(`${owner}'s due item not claimed`);
        continue;
      }
      Object.assign(row, { token, due: now + CHECK_LEASE_MS, attempts: row.attempts + 1 });
      this.record({ k: "claim", owner, token, result: "claimed" });
      labels.push("K.claim");
    }
    return labels;
  }

  // A claimed check's fetch: what the member's server served at that moment.
  fetched(token: string, outcome: ItemCheckOutcome): string {
    this.record({ k: "fetch", token, outcome });
    return `K.fetch:${outcome === "gone" ? "404" : outcome}`;
  }

  // A check's completion, applied only to a pending item under its claim's token (a revision change, a revocation, an
  // owner's removal and a later claim each replace or clear it). A candidate M retracted is revoked, whatever the
  // fetch found. A match accepts with the candidate as the verified authorization, unless another row of M holds it,
  // which ends the check as a mismatch; gone rejects; a mismatch ends the check; a transient failure backs off. Each
  // clears the token.
  complete(token: string, outcome: ItemCheckOutcome, now: number): string {
    const entry = [...this.rows].find(([, r]) => r.token === token);
    let result: string;
    if (entry === undefined || entry[1].state !== "pending") {
      result = "fenced";
    } else {
      const [owner, row] = entry;
      if ((this.withdrawals.get(row.candidate) ?? -Infinity) + RETRACTION_MS > now) {
        Object.assign(row, { state: "revoked", token: null, due: null, changed: now });
        result = "retracted";
      } else if (outcome === "transient") {
        Object.assign(row, { token: null, due: now + CHECK_BACKOFF_MS * 4 ** Math.max(row.attempts - 1, 0) });
        result = "transient";
      } else if (outcome === "gone") {
        Object.assign(row, { state: "rejected", token: null, due: null, changed: now });
        result = "rejected";
      } else if (
        outcome === "match" &&
        [...this.rows.values()].some((r) => r !== row && r.approval === row.candidate)
      ) {
        Object.assign(row, { token: null, due: null });
        result = "held by another row";
      } else if (outcome === "match") {
        // Evidence and Revocations received: the fetch under this claim found the candidate served, and Kopje has not
        // processed its Delete.
        if (!this.log.some((e) => e.k === "fetch" && e.token === token && e.outcome === "match")) {
          this.problems.push(`${owner}'s item accepted without a matching fetch under its claim`);
        }
        if (this.deletes.has(row.candidate)) {
          this.problems.push(`${owner}'s item accepted after its authorization's Delete was received`);
        }
        Object.assign(row, { state: "accepted", approval: row.candidate, token: null, due: null, changed: now });
        result = "accepted";
      } else {
        Object.assign(row, { token: null, due: null });
        result = "mismatch";
      }
    }
    this.record({ k: "complete", token, outcome, result });
    return `K.complete:${result}`;
  }

  // D9's cleanup: a rejected or revoked item unchanged for 24 hours is deleted.
  cleanup(now: number): string[] {
    const labels: string[] = [];
    for (const [owner, row] of this.rows) {
      if ((row.state === "rejected" || row.state === "revoked") && row.changed < now - DAY_MS) {
        this.rows.delete(owner);
        this.record({ k: "cleanup", owner });
        labels.push("K.cleanup");
      }
    }
    return labels;
  }

  // The earliest time an item is due, or null when none is queued.
  nextDue(): number | null {
    const due = [...this.rows.values()].flatMap((r) => (r.due === null ? [] : [r.due]));
    return due.length === 0 ? null : Math.min(...due);
  }

  // Quiescence (every Delete processed, every check run, every lease run out): X's item is never accepted (it lists
  // O's authorization), and O's item whose candidate M serves for O's collection is accepted (Progress), unless its
  // revision's check gave up (`check-gave-up`). Returns the problems and the outcome to tally.
  quiescence(served: (authorization: string) => boolean): { problems: string[]; outcome: string } {
    const problems: string[] = [];
    if (this.rows.get("X")?.state === "accepted") {
      problems.push("X's item accepted with O's authorization");
    }
    const row = this.rows.get("O");
    if (row === undefined) {
      return { problems, outcome: "O: no item" };
    }
    if (row.state === "accepted" && this.deletes.has(row.approval!)) {
      problems.push("O's item accepted although its authorization's Delete was received");
    }
    if (!served(row.candidate)) {
      return { problems, outcome: `O: ${row.state} (withdrawn)` };
    }
    if (row.state === "accepted") {
      return { problems, outcome: "O: accepted (served)" };
    }
    if (checkGaveUp(this.log, "O")) {
      return { problems, outcome: "exception check-gave-up" };
    }
    problems.push(`progress: O's served candidate not accepted (${JSON.stringify(row)})`);
    return { problems, outcome: "divergence" };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// PR 4: a remote member R of the local account L's collection C
// ---------------------------------------------------------------------------------------------------------------
//
// - MemberPolicy: Kopje's documented rules for R's item in C (docs/threat-model.md ID-6's local collection rows,
//   docs/visibility.md R45's consent arm): L's add, removal and block, R's Accept, Reject and Delete, the check of an
//   Accept that followed a deletion, and the 24-hour cleanup, with what Kopje's lane carries to R.
// - MemberPeer: R's server as Mastodon v4.7.5 runs it, each rule citing its source.
// - The shared event log, and the quiescence relation with the exceptions F1-F5 (docs/threat-model.md) as pure
//   functions of it.

// What Kopje's lane carries to R's inbox, in order (D17).
export type ToMember =
  | { type: "FeatureRequest"; request: string }
  | { type: "Add"; item: string; authorization: string }
  | { type: "Remove"; item: string }
  | { type: "Block"; id: string }
  | { type: "Undo"; id: string };

// What R's server sends Kopje, each in a delivery job of its own (so in any order, and retried).
export type FromMember =
  | { type: "Accept"; request: string; result: string; id: string }
  | { type: "Reject"; request: string }
  | { type: "Delete"; authorization: string }
  | { type: "Block"; id: string }
  | { type: "Undo"; id: string };

// R's item in C as Kopje holds it: its uri, request (activity_uri) and migration 0103's check columns.
export type MemberRow = {
  item: string;
  request: string;
  state: ItemState;
  approval: string | null;
  candidate: string | null;
  retracted: string | null;
  due: number | null;
  attempts: number;
  token: string | null;
  changed: number;
};

// R's item in C as R's server holds it (collection_items with R as its account): its authorization's id, the request
// it answered, its state and the uri an Add named it with.
export type PeerItem = {
  authorization: string;
  request: string;
  state: "accepted" | "revoked";
  uri: string | null;
  changed: number;
};

export type MemberEvent =
  | { k: "L.add"; item: string | null; request: string | null; result: string }
  | { k: "L.remove"; item: string; result: string }
  | { k: "L.block" }
  | { k: "L.unblock" }
  | { k: "K.Accept"; request: string; result: string; outcome: string; pending: boolean }
  | { k: "K.Reject"; request: string; outcome: string }
  | { k: "K.Delete"; authorization: string; outcome: string }
  | { k: "K.Block"; id: string; outcome: string }
  | { k: "K.claim"; token: string | null; result: "claimed" | "gave-up" }
  | { k: "K.lease-expiry"; token: string }
  | { k: "K.fetch"; token: string; outcome: ItemCheckOutcome }
  | { k: "K.complete"; token: string; outcome: ItemCheckOutcome; result: string }
  | { k: "K.cleanup"; item: string }
  | { k: "R.FR"; request: string; result: "accepted" | "refused" | "invalid"; authorization: string | null }
  | { k: "R.Add"; item: string; result: "named" | "existing" | "unowned"; named: string | null }
  | { k: "R.Remove"; item: string; result: "destroyed" | "nothing"; destroyed: string | null }
  | { k: "R.revoke"; authorization: string; cause: "revoke" | "block" }
  | { k: "R.block" }
  | { k: "R.unblock" }
  | { k: "R.policy"; consent: boolean }
  | { k: "R.Block"; id: string; result: string }
  | { k: "R.cleanup"; authorization: string | null };

export type MemberLogged = MemberEvent & { n: number };

// Kopje's rules for R's item in C.
export class MemberPolicy {
  row: MemberRow | undefined;
  // L blocks R; R's block of L as Kopje's inbox recorded it (its id), and the block ids an Undo retracted (ID-7).
  lBlocks = false;
  rBlock: string | null = null;
  readonly blockRetracted = new Set<string>();
  // The authorizations whose Delete Kopje processed.
  readonly deletes = new Set<string>();
  // ID-7: the authorizations whose Delete was not recorded as R's item's first deletion, kept as R's retraction, with
  // the time it was recorded.
  readonly withdrawals = new Map<string, number>();
  // What Kopje queued for R's inbox, in order.
  readonly queued: ToMember[] = [];
  readonly problems: string[] = [];

  // `issued`: each `request result` pair R's server answered Accept (the Evidence rule reads it).
  constructor(
    readonly log: MemberLogged[],
    private readonly issued: ReadonlySet<string>,
  ) {}

  private record(event: MemberEvent): void {
    this.log.push({ ...event, n: this.log.length });
  }

  // Messages: an item's Add is queued once per acceptance, and its Remove only once its Add was.
  private queue(message: ToMember): void {
    if (message.type === "Remove" && !this.queued.some((m) => m.type === "Add" && m.item === message.item)) {
      this.problems.push(`Remove of ${message.item} queued without its Add`);
    }
    this.queued.push(message);
  }

  // Evidence, Revocations received and Fences for an acceptance with `authorization`.
  private accepting(row: MemberRow, authorization: string, evidence: boolean): void {
    if (row.state !== "pending") {
      this.problems.push(`a ${row.state} item accepted`);
    }
    if (!evidence) {
      this.problems.push(`item accepted with ${authorization} without the member's evidence`);
    }
    if (this.deletes.has(authorization)) {
      this.problems.push(`item accepted with ${authorization} after its Delete was received`);
    }
  }

  // An item announced to the collection's reach: accepted, or once accepted (its approval_uri kept).
  private static announced(row: MemberRow): boolean {
    return row.state === "accepted" || row.approval !== null;
  }

  // R45's consent arm and the unique member index: refused while either blocks the other (Kopje's stored policy for R
  // consents); taken while any row of R is in C; else pending with a new request, and its FeatureRequest queued.
  add(item: string | null, request: string | null, now: number): string {
    let result: string;
    if (this.lBlocks || this.rBlock !== null) {
      result = "refused";
    } else if (this.row !== undefined) {
      result = "taken";
    } else if (item === null || request === null) {
      result = "missing";
      this.problems.push("a consented add wrote no row");
    } else {
      this.row = {
        item,
        request,
        state: "pending",
        approval: null,
        candidate: null,
        retracted: null,
        due: null,
        attempts: 0,
        token: null,
        changed: now,
      };
      this.queue({ type: "FeatureRequest", request });
      result = "pending";
    }
    this.record({ k: "L.add", item, request, result });
    return `L.add:${result}`;
  }

  // L's removal of R's item, or the block step's: deleted whatever its state, its Remove queued once announced (a
  // pending item goes silently).
  remove(): string {
    const row = this.row!;
    this.row = undefined;
    const result = MemberPolicy.announced(row) ? "Remove" : "silent";
    if (result === "Remove") {
      this.queue({ type: "Remove", item: row.item });
    }
    this.record({ k: "L.remove", item: row.item, result });
    return `L.remove:${result}`;
  }

  // D25: L's block takes R's item out (as a removal) and sends the Block.
  block(id: string): string[] {
    const labels = this.row === undefined ? [] : [this.remove()];
    this.lBlocks = true;
    this.queue({ type: "Block", id });
    this.record({ k: "L.block" });
    return [...labels, "L.block"];
  }

  unblock(id: string): string {
    this.lBlocks = false;
    this.queue({ type: "Undo", id });
    this.record({ k: "L.unblock" });
    return "L.unblock";
  }

  // D23: R's Accept of `request` with `result`. Only a pending item awaiting no check changes. A `result` whose Delete
  // Kopje kept before it (the item's first deletion, or R's retraction) revokes; otherwise the first deletion decides
  // it: none accepts (the Add queued), another queues a check of `result` (attempts 0, due now) and clears the
  // deletion.
  accept(request: string, result: string, now: number): string {
    const row = this.row?.request === request ? this.row : undefined;
    const pending = row?.state === "pending";
    let outcome: string;
    if (row === undefined || row.state !== "pending" || row.candidate !== null) {
      outcome = "ignored";
    } else if (row.retracted === result || this.withdrawn(result, now)) {
      Object.assign(row, { state: "revoked", retracted: null, changed: now });
      outcome = "revoked";
    } else if (row.retracted === null) {
      this.accepting(row, result, this.issued.has(`${request} ${result}`));
      Object.assign(row, { state: "accepted", approval: result, changed: now });
      this.queue({ type: "Add", item: row.item, authorization: result });
      outcome = "accepted";
    } else {
      Object.assign(row, { retracted: null, candidate: result, due: now, attempts: 0, token: null, changed: now });
      outcome = "check";
    }
    this.record({ k: "K.Accept", request, result, outcome, pending });
    return `K.Accept:${outcome}`;
  }

  // D23: R's Reject ends a pending or accepted item and fences its check (candidate, due time and token cleared).
  reject(request: string, now: number): string {
    const row = this.row?.request === request ? this.row : undefined;
    let outcome = "ignored";
    if (row !== undefined && (row.state === "pending" || row.state === "accepted")) {
      Object.assign(row, { state: "rejected", retracted: null, candidate: null, due: null, token: null, changed: now });
      outcome = "rejected";
    }
    this.record({ k: "K.Reject", request, outcome });
    return `K.Reject:${outcome}`;
  }

  // ID-7: whether R's retraction of `authorization` holds at `now`.
  private withdrawn(authorization: string, now: number): boolean {
    return (this.withdrawals.get(authorization) ?? -Infinity) + RETRACTION_MS > now;
  }

  // ID-6: R's Delete of `authorization`, which names C and R. The item is revoked (unqueued, unclaimed; its Remove
  // queued if it was accepted) only while `authorization` is its current one (its approval_uri, else its candidate),
  // and `authorization` is kept as R's retraction; else a pending item with no authorization or candidate records it
  // as its first deletion, or, holding another, keeps it as R's retraction (`retracted`); any other Delete changes no
  // row and is kept as R's retraction too.
  deleted(authorization: string, now: number): string {
    this.deletes.add(authorization);
    const row = this.row;
    let outcome = "nothing";
    if (row !== undefined && row.state !== "revoked") {
      if (row.approval === authorization) {
        outcome = "revoked";
      } else if (row.approval === null && row.candidate === authorization) {
        outcome = "candidate-revoked";
      }
      if (outcome !== "nothing") {
        const was = row.state;
        Object.assign(row, { state: "revoked", due: null, token: null, changed: now });
        if (was === "accepted") {
          this.queue({ type: "Remove", item: row.item });
        }
      }
    }
    if (outcome === "nothing" && row?.state === "pending" && row.approval === null && row.candidate === null) {
      if (row.retracted === null) {
        row.retracted = authorization;
        outcome = "recorded";
      } else if (row.retracted !== authorization) {
        outcome = "retracted";
      }
    }
    if (outcome !== "recorded") {
      this.withdrawals.set(authorization, now);
    }
    this.record({ k: "K.Delete", authorization, outcome });
    return `K.Delete:${outcome}`;
  }

  // R's Block of L as Kopje's inbox records it (ID-7: an id an Undo retracted stays undone; a new id replaces the
  // recorded one, which is retracted), and its Undo. Neither changes a collection (D25).
  blocked(id: string): string {
    let outcome: string;
    if (this.blockRetracted.has(id)) {
      outcome = "retracted";
    } else if (this.rBlock === id) {
      outcome = "duplicate";
    } else {
      if (this.rBlock !== null) {
        this.blockRetracted.add(this.rBlock);
      }
      this.rBlock = id;
      outcome = "blocked";
    }
    this.record({ k: "K.Block", id, outcome });
    return `K.Block:${outcome}`;
  }

  unblocked(id: string): string {
    const outcome = this.rBlock === id ? "undone" : "recorded";
    if (this.rBlock === id) {
      this.rBlock = null;
    }
    this.blockRetracted.add(id);
    this.record({ k: "K.Block", id: `${id}/undo`, outcome });
    return `K.Undo:${outcome}`;
  }

  // A check round's claim at `now` (as FeaturePolicy.claim): the item when due; its sixth claim ends its check.
  claim(now: number, token: string | null): string[] {
    const row = this.row;
    if (row === undefined || row.due === null || row.due > now) {
      if (token !== null) {
        this.problems.push("item claimed while not due");
      }
      return [];
    }
    const labels: string[] = [];
    if (row.token !== null) {
      this.record({ k: "K.lease-expiry", token: row.token });
      labels.push("K.lease-expiry");
    }
    if (row.attempts >= CHECK_ATTEMPTS) {
      Object.assign(row, { due: null, token: null });
      this.record({ k: "K.claim", token: null, result: "gave-up" });
      if (token !== null) {
        this.problems.push("item claimed past its attempts");
      }
      return [...labels, "K.claim:gave-up"];
    }
    if (token === null) {
      this.problems.push("due item not claimed");
      return labels;
    }
    Object.assign(row, { token, due: now + CHECK_LEASE_MS, attempts: row.attempts + 1 });
    this.record({ k: "K.claim", token, result: "claimed" });
    return [...labels, "K.claim"];
  }

  fetched(token: string, outcome: ItemCheckOutcome): string {
    this.record({ k: "K.fetch", token, outcome });
    return `K.fetch:${outcome === "gone" ? "404" : outcome}`;
  }

  // A completion, only for a pending item under its claim's token: a candidate R retracted revokes whatever the fetch
  // found; else a match accepts with the candidate (the Add queued), gone revokes, a transient failure backs off.
  complete(token: string, outcome: ItemCheckOutcome, now: number): string {
    const row = this.row;
    let result: string;
    if (row === undefined || row.token !== token || row.state !== "pending") {
      result = "fenced";
    } else if (this.withdrawn(row.candidate!, now)) {
      Object.assign(row, { state: "revoked", token: null, due: null, changed: now });
      result = "retracted";
    } else if (outcome === "transient") {
      Object.assign(row, { token: null, due: now + CHECK_BACKOFF_MS * 4 ** Math.max(row.attempts - 1, 0) });
      result = "transient";
    } else if (outcome === "gone") {
      Object.assign(row, { state: "revoked", token: null, due: null, changed: now });
      result = "revoked";
    } else if (outcome === "match") {
      const matched = this.log.some((e) => e.k === "K.fetch" && e.token === token && e.outcome === "match");
      this.accepting(row, row.candidate!, matched);
      Object.assign(row, { state: "accepted", approval: row.candidate, token: null, due: null, changed: now });
      this.queue({ type: "Add", item: row.item, authorization: row.approval! });
      result = "accepted";
    } else {
      Object.assign(row, { token: null, due: null });
      result = "mismatch";
    }
    this.record({ k: "K.complete", token, outcome, result });
    return `K.complete:${result}`;
  }

  // D9: a rejected or revoked item unchanged for 24 hours is deleted, silently.
  cleanup(now: number): string[] {
    const row = this.row;
    if (row !== undefined && (row.state === "rejected" || row.state === "revoked") && row.changed < now - DAY_MS) {
      this.row = undefined;
      this.record({ k: "K.cleanup", item: row.item });
      return ["K.cleanup"];
    }
    return [];
  }

  nextDue(): number | null {
    return this.row?.due ?? null;
  }
}

// R's server, Mastodon v4.7.5 (app/ paths below).
export class MemberPeer {
  // R's item in C: one at most, whatever its state (models/collection_item.rb:33).
  item: PeerItem | undefined;
  // The items an Add made with no account (services/activitypub/process_featured_item_service.rb:48-54), by uri,
  // which their own check rejects or leaves (verify_featured_item_service.rb:8-13, :25): never R's.
  readonly unowned = new Map<string, { state: "pending" | "rejected"; changed: number }>();
  consent = true;
  blocksL = false;
  // L's block of R as R's server holds it (lib/activitypub/activity/block.rb), and the ids of the Undos processed
  // before their Block (undo.rb:121-125, delete_later!).
  lBlocks = false;
  private readonly laterDeletes = new Set<string>();
  // When R's server stopped serving each authorization it served.
  private readonly withdrawnAt = new Map<string, number>();
  readonly outbox: FromMember[] = [];
  readonly issued = new Set<string>();
  private ids = 0;
  private blocks = 0;

  constructor(
    readonly uri: string,
    readonly log: MemberLogged[],
  ) {}

  private record(event: MemberEvent): void {
    this.log.push({ ...event, n: this.log.length });
  }

  // feature_authorizations_controller.rb:22-28: served while its item is accepted.
  served(authorization: string): boolean {
    return this.item?.authorization === authorization && this.item.state === "accepted";
  }

  // A fetch from outside R's server at `now`: what it serves, or, for AUTHORIZATION_CACHE_MS after it stopped serving
  // an authorization (revoked, or its item destroyed), the copy a cache in front of it kept (the controller's
  // `expires_in 30.seconds, public: true`, :12, which dist/nginx.conf's proxy cache honours), as if fetched just
  // before.
  fetched(authorization: string, now: number): boolean {
    return (
      this.served(authorization) || (this.withdrawnAt.get(authorization) ?? -Infinity) + AUTHORIZATION_CACHE_MS > now
    );
  }

  // R's item stops being served at `now`.
  private withdraw(now: number): void {
    if (this.item?.state === "accepted") {
      this.withdrawnAt.set(this.item.authorization, now);
    }
  }

  // lib/activitypub/activity/feature_request.rb:6-62. AccountPolicy#feature? (policies/account_policy.rb:68-70):
  // R's policy and a block either way. A consented request creates an accepted item and answers Accept, unless R holds
  // an item of C, which fails uniqueness (collection_item.rb:33) and is swallowed with no answer
  // (workers/activitypub/processing_worker.rb:17-18); a refusal stores nothing and answers Reject whatever R holds.
  featureRequest(request: string, now: number): string {
    let result: "accepted" | "refused" | "invalid";
    let authorization: string | null = null;
    if (!this.consent || this.lBlocks || this.blocksL) {
      this.outbox.push({ type: "Reject", request });
      result = "refused";
    } else if (this.item !== undefined) {
      result = "invalid";
    } else {
      const id = ++this.ids;
      authorization = `${this.uri}/feature_authorizations/${id}`;
      this.item = { authorization, request, state: "accepted", uri: null, changed: now };
      this.issued.add(`${request} ${authorization}`);
      this.outbox.push({
        type: "Accept",
        request,
        result: authorization,
        id: `${this.uri}#accepts/feature_requests/${id}`,
      });
      result = "accepted";
    }
    this.record({ k: "R.FR", request, result, authorization });
    return `R.FR:${result}`;
  }

  // lib/activitypub/activity/add.rb:18-19, process_featured_item_service.rb:20-30, :38-54: an item with the uri
  // (unchanged: R's own item is not verified again); else R's accepted item with no uri, whatever authorization the
  // Add carries (pre_approved_item); else an item with no account, which its check rejects unless the authorization
  // is served, when making it R's fails uniqueness.
  add(item: string, authorization: string, now: number): string {
    let result: "named" | "existing" | "unowned";
    let named: string | null = null;
    const unowned = this.unowned.get(item);
    if (this.item?.uri === item) {
      result = "existing";
    } else if (unowned !== undefined) {
      if (!this.served(authorization)) {
        Object.assign(unowned, { state: "rejected", changed: now });
      }
      result = "existing";
    } else if (this.item?.state === "accepted" && this.item.uri === null) {
      this.item.uri = item;
      named = this.item.authorization;
      result = "named";
    } else {
      this.unowned.set(item, { state: this.served(authorization) ? "pending" : "rejected", changed: now });
      result = "unowned";
    }
    this.record({ k: "R.Add", item, result, named });
    return `R.Add:${result}`;
  }

  // remove.rb:18-20, :50-54: the item with the uri is destroyed, whatever its state.
  remove(item: string, now: number): string {
    let destroyed: string | null = null;
    let result: "destroyed" | "nothing" = "nothing";
    if (this.item?.uri === item) {
      destroyed = this.item.authorization;
      this.withdraw(now);
      this.item = undefined;
      result = "destroyed";
    } else if (this.unowned.delete(item)) {
      result = "destroyed";
    }
    this.record({ k: "R.Remove", item, result, destroyed });
    return `R.Remove:${result}`;
  }

  // services/revoke_collection_item_service.rb:6-25: revoked (so no longer served), then its Delete sent. R revokes an
  // accepted item; its block revokes its item in any state (block_service.rb:32-36).
  revoke(cause: "revoke" | "block", now: number): string | null {
    const item = this.item;
    if (item === undefined || (cause === "revoke" && item.state !== "accepted")) {
      return null;
    }
    this.withdraw(now);
    Object.assign(item, { state: "revoked", changed: now });
    this.outbox.push({ type: "Delete", authorization: item.authorization });
    this.record({ k: "R.revoke", authorization: item.authorization, cause });
    return `R.revoke:${cause}`;
  }

  // block_service.rb:6-42: R's item in L's collection revoked, then the Block sent; its Undo.
  block(now: number): string[] {
    if (this.blocksL) {
      return [];
    }
    const revoked = this.revoke("block", now);
    this.blocksL = true;
    this.outbox.push({ type: "Block", id: `${this.uri}#blocks/${++this.blocks}` });
    this.record({ k: "R.block" });
    return [...(revoked === null ? [] : [revoked]), "R.block"];
  }

  unblock(): string[] {
    if (!this.blocksL) {
      return [];
    }
    this.blocksL = false;
    this.outbox.push({ type: "Undo", id: `${this.uri}#blocks/${this.blocks}` });
    this.record({ k: "R.unblock" });
    return ["R.unblock"];
  }

  // models/concerns/account/interaction_policy_concern.rb:65-69: whether R's policy consents to L.
  setPolicy(consent: boolean): string {
    this.consent = consent;
    this.record({ k: "R.policy", consent });
    return `R.policy:${consent ? "consents" : "refuses"}`;
  }

  // L's Block (block.rb: no collection changes) and its Undo (undo.rb:116-126).
  receivedBlock(id: string): string {
    let result = "blocked";
    if (this.lBlocks) {
      result = "updated";
    } else if (this.laterDeletes.has(id)) {
      result = "undone first";
    } else {
      this.lBlocks = true;
    }
    this.record({ k: "R.Block", id, result });
    return `R.Block:${result}`;
  }

  receivedUndo(id: string): string {
    const result = this.lBlocks ? "unblocked" : "recorded";
    if (this.lBlocks) {
      this.lBlocks = false;
    } else {
      this.laterDeletes.add(id);
    }
    this.record({ k: "R.Block", id: `${id}/undo`, result });
    return `R.Undo:${result}`;
  }

  // workers/scheduler/collection_item_cleanup_scheduler.rb:10-15: rejected and revoked items unchanged for 24 hours.
  cleanup(now: number): string[] {
    const labels: string[] = [];
    if (this.item?.state === "revoked" && this.item.changed < now - DAY_MS) {
      this.record({ k: "R.cleanup", authorization: this.item.authorization });
      this.item = undefined;
      labels.push("R.cleanup");
    }
    for (const [uri, unowned] of this.unowned) {
      if (unowned.state === "rejected" && unowned.changed < now - DAY_MS) {
        this.unowned.delete(uri);
        this.record({ k: "R.cleanup", authorization: null });
      }
    }
    return labels;
  }
}

// F4 for R's item: since the Accept that queued its current check, CHECK_ATTEMPTS claims, none ended by a completion,
// and the claim after them ended the check.
export function memberCheckGaveUp(log: readonly MemberLogged[]): boolean {
  const start = log.findLastIndex((e) => e.k === "K.Accept" && e.outcome === "check");
  if (start < 0) {
    return false;
  }
  const since = log.slice(start + 1);
  const tokens = new Set(since.flatMap((e) => (e.k === "K.claim" && e.result === "claimed" ? [e.token] : [])));
  return (
    tokens.size === CHECK_ATTEMPTS &&
    since.some((e) => e.k === "K.claim" && e.result === "gave-up") &&
    !since.some((e) => e.k === "K.complete" && tokens.has(e.token) && ENDED.has(e.result))
  );
}

// The exceptions F1-F5 (docs/threat-model.md) that excuse a difference between Kopje's row and R's item at quiescence,
// each a predicate over the log.
export function memberExceptions(
  log: readonly MemberLogged[],
  row: MemberRow | undefined,
  item: PeerItem | undefined,
): string[] {
  const kopje = row?.state === "accepted" ? row.approval : null;
  const peer = item?.state === "accepted" ? item.authorization : null;
  const found: string[] = [];
  // F1 remove-overtook-add(k): R holds its item accepted under k, Kopje no item k, and R processed k's Remove (finding
  // nothing) before the Add that named its item.
  if (item !== undefined && peer !== null && item.uri !== null && row?.item !== item.uri) {
    const named = log.findIndex((e) => e.k === "R.Add" && e.item === item.uri && e.named === item.authorization);
    if (log.some((e) => e.k === "R.Remove" && e.item === item.uri && e.result === "nothing" && e.n < named)) {
      found.push("F1");
    }
  }
  // F2 unnamed-orphan(ρ): R holds an accepted item no Add named for request ρ, which Kopje no longer held as pending:
  // L removed ρ's pending item after R's server accepted it, or Kopje ignored R's Accept because ρ was not pending.
  const requestOf = new Map(log.flatMap((e) => (e.k === "L.add" && e.item !== null ? [[e.item, e.request]] : [])));
  if (item !== undefined && peer !== null && item.uri === null) {
    const accepted = log.findIndex((e) => e.k === "R.FR" && e.authorization === peer);
    const removed = (e: MemberLogged) =>
      e.k === "L.remove" && e.result === "silent" && requestOf.get(e.item) === item.request && e.n > accepted;
    const ignored = (e: MemberLogged) =>
      e.k === "K.Accept" && e.request === item.request && e.result === peer && e.outcome === "ignored" && !e.pending;
    if (log.some((e) => removed(e) || ignored(e))) {
      found.push("F2");
    }
  }
  // F3 replayed-request(ρ): R answered copies of the request of its accepted item both Accept and Reject.
  if (item !== undefined && peer !== null) {
    if (log.some((e) => e.k === "R.FR" && e.request === item.request && e.result === "refused")) {
      found.push("F3");
    }
  }
  // F4 check-gave-up: Kopje's item pending with the candidate R serves, its check ended by its attempts.
  if (row?.state === "pending" && row.candidate !== null && row.candidate === peer && memberCheckGaveUp(log)) {
    found.push("F4");
  }
  // F5 stale-add(k): an Add of an earlier membership's item named R's item of a newer request, which that Add's
  // Remove can then destroy and the newer item's Remove misses.
  const answered = new Map(
    log.flatMap((e) => (e.k === "R.FR" && e.authorization !== null ? [[e.authorization, e.request]] : [])),
  );
  const stale = new Set(
    log.flatMap((e) =>
      e.k === "R.Add" && e.named !== null && requestOf.get(e.item) !== answered.get(e.named) ? [e.named] : [],
    ),
  );
  if ((peer !== null && stale.has(peer)) || (kopje !== null && stale.has(kopje))) {
    found.push("F5");
  }
  return found;
}

// Quiescence: Agreement (Kopje accepted with A exactly when R is) and Progress (a request R accepted that neither L nor
// R ended since is accepted on both sides), each except where an exception holds. Returns the problems and the outcome
// to tally.
export function memberQuiescence(
  log: readonly MemberLogged[],
  row: MemberRow | undefined,
  item: PeerItem | undefined,
): { problems: string[]; outcome: string } {
  const kopje = row?.state === "accepted" ? row.approval : null;
  const peer = item?.state === "accepted" ? item.authorization : null;
  const exceptions = memberExceptions(log, row, item);
  const problems: string[] = [];
  if (kopje !== peer && exceptions.length === 0) {
    problems.push(`agreement: Kopje ${JSON.stringify(row)}, R ${JSON.stringify(item)}`);
  }
  if (row !== undefined && kopje === null) {
    const first = log.findIndex((e) => e.k === "R.FR" && e.request === row.request && e.result === "accepted");
    const ended = log.some(
      (e) =>
        e.n > first &&
        (e.k === "R.revoke" ||
          e.k === "R.block" ||
          (e.k === "R.FR" && e.request === row.request && e.result === "refused")),
    );
    if (first >= 0 && !ended && !exceptions.includes("F4") && !exceptions.includes("F5")) {
      problems.push(`progress: R accepted ${row.request}, Kopje ${row.state}`);
    }
  }
  const outcome =
    exceptions.length > 0 && kopje !== peer
      ? `exception ${exceptions.join("+")}`
      : kopje !== null
        ? "accepted"
        : row === undefined && item === undefined
          ? "no item"
          : `not accepted (Kopje ${row?.state ?? "none"}, R ${item?.state ?? "none"})`;
  return { problems, outcome };
}
