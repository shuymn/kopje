-------------------------- MODULE MediaUploadGoals ---------------------------
(***************************************************************************)
(* Reachability goals over MediaUpload: a check with INVARIANT NotReached  *)
(* fails exactly when Goal is reached, and its trace is the shortest way   *)
(* there. Each goal is an accepted window or an order the PR4 plan names,  *)
(* so its check shows the safety checks are not vacuous for it.            *)
(***************************************************************************)
EXTENDS MediaUpload

CONSTANT Goal

\* A completed upload whose v1 request answered the 503 of kind k (W5).
W5By(k) == \E u \in U : W5Row(u) /\ rt[u].kind = k

Goals ==
  [\* W1: a write started on a grant issued before DELETE lands after it.
   W1 |-> "W1" \in ev,
   \* W1 across a restore (D4): a write started on a grant issued before the restore lands after it, and the restored
   \* reservation's sweep deletes it.
   W1R |-> "W1R" \in ev /\ \E u \in U : st[u].att = "gone" /\ r2[u].obj = {},
   \* W3: a container runs without a live slot after a restore since its start that left none.
   W3 |-> \E u \in Running : ~Live(st, u, now) /\ W3(u) /\ ~W10(u),
   \* W4: incomingOrphans deletes a key a restored row holds again.
   W4 |-> "W4" \in ev,
   \* W5, one goal for each cause of a 503 the Store did not decide, and the completed upload swept at its gc_at.
   W5Lost |-> W5By("lost"),
   W5Fail |-> W5By("fail"),
   W5GiveUp |-> W5By("giveup"),
   W5Maint |-> W5By("maint"),
   W5S3Lost |-> W5By("s3lost"),
   W5Swept |-> \E u \in U : rt[u].v1 /\ rt[u].ans = 503 /\ rt[u].kind \in W5Kinds /\ "W5" \in ev /\ st[u].att = "gone",
   \* W6: S2 released the staging, its reply was lost, and the input waits for the sweep.
   W6 |-> \E u \in U : rt[u].kind = "s2lost" /\ r2[u].inc /\ st[u].ps = "none" /\ ~gh[u].q /\ st[u].att = "res",
   \* W9: the processor's record-age stop.
   W9 |-> "W9" \in ev,
   \* W10: a container runs past its slot's held_until because its processor is gone.
   W10 |-> \E u \in Running : ~Live(st, u, now) /\ W10(u) /\ ~W3(u),
   \* W11: the route sends a 200 for an upload a restore since S10's commit rewound; its keys are then deleted with
   \* the restored reservation, or forgotten (no row, no tombstone) when the bookmark predates the reservation.
   W11 |-> "W11" \in ev,
   W11Swept |-> "W11" \in ev /\ \E u \in U : rt[u].ans = 200 /\ st[u].att = "gone" /\ r2[u].obj = {},
   W11Forgotten |-> "W11" \in ev /\ \E u \in U : rt[u].ans = 200 /\ st[u].att = "none" /\ r2[u].obj # {},
   \* Codex r4 H1: S10 decides at the route's cut, before the Store's deadline of a job whose container started.
   H1 |-> "H1" \in ev,
   \* Codex r4 H3: a later invocation starts a job an earlier one did not.
   H3 |-> "H3" \in ev,
   \* Gemini r4 GH3: S3 meets a restored staging row and hands the route its input.
   GH3 |-> "GH3" \in ev,
   \* Q4, the round first: S13 fails the restored row, then S10 answers 503 and dooms it.
   Q4Round |-> \E u \in U : rt[u].kind = "decided" /\ rt[u].ans = 503 /\ gh[u].k3 = "round",
   \* Q4, the route first: S10 itself meets the restore.
   Q4Route |-> \E u \in U : rt[u].kind = "decided" /\ rt[u].ans = 503 /\ gh[u].k3 = "s10",
   \* Codex r4 M5: a v1 request answers the maintenance 503.
   M5 |-> \E u \in U : rt[u].v1 /\ rt[u].kind = "maint" /\ rt[u].ans = 503,
   \* A v2 upload with every write completes and its URL is issued.
   Published |-> \E u \in U : st[u].att = "done" /\ gh[u].tok /\ r2[u].obj = Writes]

NotReached == ~Goals[Goal]

=============================================================================
