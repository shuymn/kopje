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
  // verified authorization, or its candidate while none is verified. Any other Delete changes nothing.
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
  // owner's removal and a later claim each replace or clear it). A match accepts with the candidate as the verified
  // authorization, unless another row of M holds it, which ends the check as a mismatch; gone rejects; a mismatch
  // ends the check; a transient failure backs off. Each clears the token.
  complete(token: string, outcome: ItemCheckOutcome, now: number): string {
    const entry = [...this.rows].find(([, r]) => r.token === token);
    let result: string;
    if (entry === undefined || entry[1].state !== "pending") {
      result = "fenced";
    } else {
      const [owner, row] = entry;
      if (outcome === "transient") {
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
