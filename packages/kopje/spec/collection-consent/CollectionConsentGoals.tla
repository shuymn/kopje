------------------------ MODULE CollectionConsentGoals -------------------------
(***************************************************************************)
(* Reachability goals over CollectionConsent: a check with INVARIANT       *)
(* NotReached fails exactly when Goal is reached, and its trace is the     *)
(* shortest way there. Goal names a state goal of CollectionConsent.tla    *)
(* (Accepted, Hidden, F7, ...), an action (KRevoke), or an envelope Kopje  *)
(* processes ("KRecv.RemC"): the vacuity checks and the replay fixtures    *)
(* (CollectionConsentFixtures.tla) use them.                               *)
(***************************************************************************)
EXTENDS CollectionConsent, Sequences

CONSTANT Goal

StateGoals ==
  [Accepted |-> GoalAccepted, Shown |-> GoalShown, Hidden |-> GoalHidden, ReadHid |-> GoalReadHid,
   Corrected |-> GoalCorrected, F8 |-> GoalF8, F7 |-> GoalF7, F8ThenF7 |-> GoalF8ThenF7, F3 |-> GoalF3,
   Kept |-> GoalKept, RemovalGuard |-> GoalRemovalGuard, Refused503 |-> Goal503, Retried503 |-> GoalRetried503,
   OV2Shown |-> GoalOV2Shown, OV2Hidden |-> GoalOV2Hidden, Obligation |-> GoalObligation, Answered |-> GoalCR1,
   FencedByPush |-> GoalFencedByPush, FencedByRow |-> GoalFencedByRow, StaleOmits |-> GoalStaleOmits,
   Order7 |-> GoalOrder7, Order7Restored |-> GoalOrder7Restored, Unsuspended |-> GoalUnsuspended,
   EvictedF8 |-> GoalEvictedF8, RCleanLateAccept |-> GoalRCleanLateAccept, SlotsReject |-> GoalSlotsReject,
   SlotsRecovered |-> GoalSlotsRecovered, HeldReject |-> GoalHeldReject, HeldRecovered |-> GoalHeldRecovered,
   GoneFetch |-> GoalGoneFetch, GoneRead |-> GoalGoneRead, TruncatedShows |-> GoalTruncatedShows,
   TruncatedKeeps |-> GoalTruncatedKeeps, EmbeddedUnserved |-> EmbeddedUnserved,
   SuspendedRequest |-> GoalSuspendedRequest, SuspendedListing |-> GoalSuspendedListing,
   SuspendedOmission |-> GoalSuspendedOmission,
   GonePurged |-> GoalGonePurged, LeaseApplies |-> GoalLeaseApplies, FetchExisting |-> GoalFetchExisting,
   FetchOutdates |-> GoalFetchOutdates, IgnoredThenStale |-> GoalIgnoredThenStale,
   RetiredRemoved |-> Acted("KRecv") /\ last.arg.env.ty = "Rem" /\ k.row.st = "ret" /\ k.sync,
   BlockRow |-> Acted("KBlock") /\ Recorded1("Delete"),
   MemberGoneRow |-> Acted("KMemberGone") /\ k.issued > 0,
   OwnerGoneRow |-> Acted("KRecv") /\ last.arg.env.ty = "DelR" /\ k.issued > 0,
   \* Another request for an accepted row is accepted with the row's authorization while L's policy refuses (K1).
   AcceptedPolicyOff |->
     /\ Acted("KRecv") /\ last.arg.env.ty = "FR" /\ ~env.consent
     /\ \E m \in last.rec : m.ty = "Accept" /\ m.obj = last.arg.env.r
     /\ \E q \in g.accReq : q # last.arg.env.r,
   \* L's revoke at a full backlog: its Delete, a retraction, is queued (RES-4).
   RetractionAdmitted |-> Acted("KRevoke") /\ env.bl,
   \* X's Add naming an authorization Kopje does not serve is answered to X's inbox (K2).
   AnsweredX |-> Acted("KRecv") /\ last.arg.env.ty = "XAdd" /\ \E m \in last.rec : m.ty = "Delete" /\ m.to = "X",
   \* X's answer for a row Kopje holds, at a full backlog: ordinary, so refused (AnswerClass, F8).
   AnsweredXRefused |-> Acted("KRecv") /\ last.arg.env.ty = "XAdd" /\ "f8" \in last.ev /\ HeldRow(k, last.arg.env.a),
   \* A read names an authorization whose retraction answer to R still waits: it records no other (Coalesced).
   AnswerCoalesced |->
     /\ Acted("KApply") /\ last.rec = {} /\ k.rk /\ LAvail(k)
     /\ \E a \in Auths : AnswerWaits(a, "R") /\ ~Served(k, a) /\ g.lastRd.a = a /\ g.lastRd.i # NONE,
   \* A read records a retraction answer while one of the same authorization is leased (Coalesced does not count it),
   \* then the leased one's POST fails: it is dropped as superseded (KFail).
   LeaseSuperseded |-> Acted("KFail") /\ last.arg.val = "superseded" /\ g.overLease,
   \* A read lists the accepted row under an item R's Remove retracted: the row takes it (K14).
   ReadOverRetraction |-> Acted("KApply") /\ k.row.st = "acc" /\ k.row.uri # NONE /\ k.row.uri \in k.ret,
   \* The revoke's Delete is delivered after the retired row's cleanup (K10 leaves the lane as it is).
   CleanupThenDelete |->
     Acted("KDeliver") /\ last.arg.msg.ty = "Delete" /\ last.arg.msg.why = "revoke" /\ k.row = NoRow,
   \* A suspended L's ordinary activity is dropped at its delivery.
   DroppedDelivery |-> Acted("KDeliver") /\ "dropped" \in last.ev]

Reached ==
  IF Goal \in DOMAIN StateGoals THEN StateGoals[Goal]
  ELSE last.act = Goal \/ (last.act = "KRecv" /\ Goal = "KRecv." \o last.arg.env.ty)

NotReached == ~Reached
=============================================================================
