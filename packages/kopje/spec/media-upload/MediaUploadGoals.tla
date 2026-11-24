-------------------------- MODULE MediaUploadGoals ---------------------------
(***************************************************************************)
(* Reachability goals over MediaUpload: a check with INVARIANT NotReached  *)
(* fails exactly when Goal is reached, and its trace is the shortest way   *)
(* there. Each goal is an accepted window or an order the PR4 plan names,  *)
(* so its check shows the safety checks are not vacuous for it.            *)
(***************************************************************************)
EXTENDS MediaUpload

CONSTANT Goal

Goals ==
  [\* W1: a write started on a grant issued before DELETE lands after it.
   W1 |-> "W1" \in ev,
   \* W3: a container runs without a live slot after a restore since its start.
   W3 |-> \E u \in Running : ~Live(st, u, now) /\ W3(u) /\ ~W10(u),
   \* W5: an upload completes after its v1 request answered a 503 the Store did not decide.
   W5 |-> "W5" \in ev,
   \* W6: S2 released the staging, its reply was lost, and the input waits for the sweep.
   W6 |-> \E u \in U : rt[u].pc = "done" /\ rt[u].want # 0 /\ r2[u].inc /\ st[u].ps = "none" /\ ~gh[u].q
                       /\ st[u].att = "res",
   \* W9: the processor's record-age stop.
   W9 |-> "W9" \in ev,
   \* W10: a container runs past its slot's held_until.
   W10 |-> \E u \in Running : ~Live(st, u, now) /\ W10(u) /\ ~W3(u),
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
   \* A two-write v2 upload completes and its URL is issued.
   Published |-> \E u \in U : st[u].att = "done" /\ gh[u].tok /\ r2[u].obj = Writes]

NotReached == ~Goals[Goal]

=============================================================================
