import type { Intent, Peer } from "./follow-model";

// NET-2's two accepted risks on R's follow of L, as predicates over a settled run: the follow lifecycle
// (test/follow-lifecycle.test.ts) and the instance moderation checks (test/instance-moderation.test.ts) read them with
// their own records. Each names R's newest generation g and the attempt R's server applied to it by the account pair.

// One delivery attempt of Kopje's: its lease token (the tag R's server gave the reception it carried), its intent, and
// the step of its confirmation.
export type ConfirmedAttempt = { token: string; intent: Intent; confirmedAt: number };

// Kopje's edge in the peer's terms (a pending request is `requested` there).
export type PeerSide = { state: string; uri: string } | null;

export type AnswerRace = {
  peer: Peer;
  attempts: readonly ConfirmedAttempt[];
  // The step each of R's Follows first reached Kopje, and the step an Undo of each of them first did.
  receivedAt: ReadonlyMap<string, number>;
  undoReceivedAt: ReadonlyMap<string, number>;
  // Kopje's R->L edge.
  mine: PeerSide;
};

// The attempts whose answer of an earlier generation R's server applied to g by the pair (accept.rb:24,
// reject.rb:25): each with its own confirmation, not that of another attempt of the same answer.
function pairApplied(race: AnswerRace, g: string): ConfirmedAttempt[] {
  const applied = race.peer.events.pairAnswer.get(g);
  return race.attempts.filter((a) => a.intent.answer && a.intent.ref !== g && applied?.has(a.token) === true);
}

// NET-2's accepted risk: an answer of an earlier generation POSTed before Kopje received g (its confirmation came
// first) and applied to g by the pair. Kopje holds g pending while R's server holds it accepted, or R's server holds
// nothing.
export function net2Answer(race: AnswerRace): boolean {
  const g = race.peer.lastRGeneration;
  if (g === null) {
    return false;
  }
  const receivedG = race.receivedAt.get(g) ?? Number.POSITIVE_INFINITY;
  const theirs = race.peer.rl;
  const { mine } = race;
  return (
    pairApplied(race, g).some((a) => a.confirmedAt < receivedG) &&
    mine?.uri === g &&
    ((mine.state === "requested" && theirs?.state === "accepted" && theirs.uri === g) || theirs === null)
  );
}

// NET-2's accepted risk of a kept Reject: g kept the Reject of an earlier generation h, and R's server ended g by the
// pair. Either R undid h and the attempt was confirmed before that Undo reached Kopje, or R's server followed again
// without undoing h (RefollowWorker, refollow_worker.rb:17-19). Kopje holds g; R's server holds nothing.
export function keptReject(race: AnswerRace): boolean {
  const g = race.peer.lastRGeneration;
  if (g === null) {
    return false;
  }
  const receivedG = race.receivedAt.get(g) ?? Number.POSITIVE_INFINITY;
  const undoSent = (h: string) =>
    race.peer.sent.some(
      (m) => m.activity.type === "Undo" && m.activity.object.type === "Follow" && m.activity.object.id === h,
    );
  const kept = pairApplied(race, g).some((a) => {
    const h = a.intent.ref!;
    const undoneAt = race.undoReceivedAt.get(h);
    return (
      a.intent.type === "Reject" &&
      a.confirmedAt >= receivedG &&
      ((undoneAt !== undefined && a.confirmedAt < undoneAt) || !undoSent(h))
    );
  });
  return kept && race.mine?.uri === g && race.peer.rl === null;
}
