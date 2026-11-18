---------------------------- MODULE FeatureDGoals ----------------------------
(***************************************************************************)
(* Reachability goals over FeatureD: a check with INVARIANT NotReached     *)
(* fails exactly when Goal is reached, and its trace is the shortest way   *)
(* there. Goal names a state goal of FeatureD.tla (Accepted, Hidden, F7,   *)
(* ...), an action (KRevoke), or an envelope Kopje processes               *)
(* ("KRecv.RemC"): the vacuity checks and the replay fixtures              *)
(* (FeatureDFixtures.tla) use them.                                        *)
(***************************************************************************)
EXTENDS FeatureD, Sequences

CONSTANT Goal

StateGoals ==
  [Accepted |-> GoalAccepted, Shown |-> GoalShown, Hidden |-> GoalHidden, Corrected |-> GoalCorrected,
   F8 |-> GoalF8, F7 |-> GoalF7, F8ThenF7 |-> GoalF8ThenF7, F3 |-> GoalF3, Kept |-> GoalKept,
   RemovalGuard |-> GoalRemovalGuard, Refused503 |-> Goal503, OV2Shown |-> GoalOV2Shown,
   OV2Hidden |-> GoalOV2Hidden, Obligation |-> GoalObligation, Answered |-> GoalCR1,
   BlockRow |-> Acted("KBlock") /\ \E m \in last.rec : m.ty = "Delete",
   MemberGoneRow |-> Acted("KMemberGone") /\ k.issued > 0,
   OwnerGoneRow |-> Acted("KRecv") /\ last.arg.env.ty = "DelR" /\ k.issued > 0]

Reached ==
  IF Goal \in DOMAIN StateGoals THEN StateGoals[Goal]
  ELSE last.act = Goal \/ (last.act = "KRecv" /\ Goal = "KRecv." \o last.arg.env.ty)

NotReached == ~Reached
=============================================================================
