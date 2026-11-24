-------------------------- MODULE MediaUploadStore ---------------------------
(***************************************************************************)
(* The Store's operations on a video or audio upload (#1828 PR4): one      *)
(* operator per Store transaction, at the Store's time t, over the upload's *)
(* record x (its media_attachments row, its media_processing row and its    *)
(* media_av_slots row). MediaUpload.tla runs them; the PR4 plan's section 1 *)
(* cites them by their operation names (S1-S13).                            *)
(*                                                                         *)
(* PRECEDENCE. A writing operation applies, in its transaction and in this *)
(* order:                                                                  *)
(*  K1 maintenance: nothing changes and the answer is "maint"; a read      *)
(*     answers from the record.                                            *)
(*  K3 restored (Fenced: the attachment was reserved at or before the last *)
(*     restore): a staging row and its staging slot are deleted; a pending *)
(*     or running row becomes failed "restored", its slot kept.            *)
(*  K4 deadline (t >= deadline_at, pending or running): failed "deadline", *)
(*     and for v1 (reply_by set) the upload is doomed (Doom: the row is    *)
(*     deleted, the slot kept).                                            *)
(*  then the operation's own rule on the record K3 and K4 left, including  *)
(*  K2, its identity check. K3 and K4 are effects, never answers: every    *)
(*  operation goes on to its own rule after them (Codex r4 H2, Gemini r4   *)
(*  GH1), so a terminal row still reaches S6's "done", S7's "recorded", S8's *)
(*  release, S10's HTTP decision and S11's doom.                           *)
(*                                                                         *)
(* Variant selects one mutation (checks.json's variants); "base" is the    *)
(* rule set the plan adopts.                                               *)
(***************************************************************************)
EXTENDS Integers, FiniteSets, MediaUploadParams

\* Abstract durations (MediaUpload.tla, TIME).
STAGING == 1 \* STAGING_MS
V1 == 3 \* V1_TIME_MS, from the request's arrival
T_REPLY == 1 \* T_REPLY
V2P == 2 \* V2_PROCESS_MS
TEARDOWN == 3 \* TEARDOWN_MS, the alarm's wall limit, longer than V2_PROCESS_MS as in the design
WW == 4 \* AV_WRITE_WINDOW_MS from the reservation; caps deadline_at
IW == WW - STAGING - 1 \* WRITE_WINDOW_MS, the reservation's write deadline before S1 sets the AV one
MINLEFT == 1 \* T_FIXED + T_MIN_ENCODE, checked by S3
MINENC == 1 \* T_MIN_ENCODE after the remaining fixed parts, checked by S4
AV_GRANT == 1 \* AV_GRANT_MS
DISPATCH == 1 \* DISPATCH_MS
GC == WW \* gc_at of an unfinished reservation (RESERVATION_MS), after every write cut
LAND == 1 \* the longest an R2 write lands after it starts (assumed bound)
RETIRE == WW + LAND \* the tombstone is retired this long after the reservation (M3)

NoSlot == [ph |-> "none", hu |-> 0, tdn |-> FALSE]

\* An upload's Store record. att: none (no attachment row: never reserved, or its tombstone retired), res (reserved,
\* processed = 0), done (processed = 1), gone (swept: the tombstone). staged: S1 ran for this reservation (Codex r4 M1).
\* ps: the media_processing row's state.
Fresh == [att |-> "none", resAt |-> 0, doomed |-> FALSE, staged |-> FALSE, ps |-> "none", v1 |-> FALSE, sAt |-> 0,
          sUntil |-> 0, rb |-> 0, dl |-> 0, disp |-> 0, sid |-> 0, cause |-> "none", slot |-> NoSlot,
          charged |-> FALSE]

RowNone(x) ==
  [x EXCEPT !.ps = "none", !.v1 = FALSE, !.sAt = 0, !.sUntil = 0, !.rb = 0, !.dl = 0, !.disp = 0, !.sid = 0,
            !.cause = "none"]

\* The attachment's gc_at becomes DOOMED_AT and the processing row is deleted (S11, S10, K4 for v1): every later
\* operation meets the upload at its identity check.
Doom(x) == [RowNone(x) EXCEPT !.doomed = TRUE]

Fenced(x, restoredAt) == x.att # "none" /\ x.resAt <= restoredAt

K3(x, restoredAt) ==
  IF ~Fenced(x, restoredAt) THEN x
  ELSE IF x.ps = "staging" THEN [RowNone(x) EXCEPT !.slot = IF x.slot.ph = "staging" THEN NoSlot ELSE x.slot]
  ELSE IF x.ps \in {"pending", "running"} THEN [x EXCEPT !.ps = "failed", !.cause = "restored", !.disp = 0]
  ELSE x

K4(x, t) ==
  IF x.ps \in {"pending", "running"} /\ t >= x.dl
  THEN IF x.v1 THEN Doom(x) ELSE [x EXCEPT !.ps = "failed", !.cause = "deadline", !.disp = 0]
  ELSE x

Norm(x, t, restoredAt) == K4(K3(x, restoredAt), t)

Res(x, a) == [x |-> x, a |-> a]

Live(S, v, t) == S[v].slot.ph # "none" /\ S[v].slot.hu > t

\* S1 takeAvSlot(id, v1Left): the staging row and slot. left is the route's remaining v1 time as a duration (0 for v2).
\* A repeat after a lost reply finds the staging row and answers its staged_at; once S1 has run for the reservation
\* (staged) it never stages again, and a reservation made at or before the last restore never stages (Codex r4 M1).
\* It refuses past the reservation's write deadline (WRITE_WINDOW_MS), so staging, and the deadline S3 caps at the
\* reservation + AV_WRITE_WINDOW_MS, end before the sweep may take the unfinished reservation at its gc_at.
S1(S, u, t, ra, maint, active, v1, left) ==
  LET x == Norm(S[u], t, ra) IN
  IF maint THEN Res(S[u], "maint")
  ELSE IF x.ps = "staging" THEN Res(x, "taken")
  ELSE IF x.att # "res" \/ Fenced(S[u], ra) \/ (x.staged /\ Variant # "NoStagedMark") THEN Res(x, "gone")
  ELSE IF (v1 /\ left <= T_REPLY) \/ (t >= x.resAt + IW /\ Variant # "NoWriteWindow") THEN Res(x, "time")
  ELSE IF ~active THEN Res(x, "inactive")
  ELSE IF Cardinality({v \in U : v # u /\ Live(S, v, t) /\ (Variant # "SlotNoCount" \/ S[v].slot.ph = "processing")})
          >= MaxInflight THEN Res(x, "busy")
  ELSE LET rb == IF v1 THEN t + left ELSE 0
           until == IF v1 THEN (IF t + STAGING < rb - T_REPLY THEN t + STAGING ELSE rb - T_REPLY) ELSE t + STAGING
       IN Res([x EXCEPT !.staged = TRUE, !.ps = "staging", !.v1 = v1, !.sAt = t, !.sUntil = until, !.rb = rb,
                        !.slot = [ph |-> "staging", hu |-> until, tdn |-> FALSE]], "taken")
\* S2 releaseStaging(id, staged_at): cleanup authority only for the staging row of that staged_at.
S2(x0, t, ra, maint, sAt) ==
  LET x == Norm(x0, t, ra) IN
  IF maint THEN Res(x0, "maint")
  ELSE IF x.ps = "staging" /\ x.sAt = sAt THEN Res([RowNone(x) EXCEPT !.slot = NoSlot], "released")
  ELSE IF Variant = "SlotById" /\ x.slot.ph # "none" THEN Res([x EXCEPT !.slot = NoSlot], "not_staging")
  ELSE Res(x, "not_staging")

QueueDeadline(x, t) ==
  LET base == IF x.v1 THEN x.rb - T_REPLY ELSE t + V2P IN
  IF base < x.resAt + WW THEN base ELSE x.resAt + WW

\* S3 queueNormalize(id, token, staged_at). A restored staging row (K3) answers refused_cleanup_yours(restored):
\* its row and slot are deleted in this transaction, so the input is the route's to delete (Gemini r4 GH3).
S3(x0, t, ra, maint, active, sAt) ==
  LET x == Norm(x0, t, ra)
      dl == QueueDeadline(x, t)
  IN
  IF maint THEN Res(x0, "maint")
  ELSE IF x0.ps = "staging" /\ x0.sAt = sAt /\ Fenced(x0, ra) THEN Res(x, "refused_restored")
  ELSE IF x.ps = "staging" /\ x.sAt = sAt
  THEN IF t >= x.sUntil THEN Res([RowNone(x) EXCEPT !.slot = NoSlot], "refused_time")
       ELSE IF ~active THEN Res([RowNone(x) EXCEPT !.slot = NoSlot], "refused_inactive")
       ELSE IF dl - t < MINLEFT THEN Res([RowNone(x) EXCEPT !.slot = NoSlot], "refused_time")
       ELSE Res([x EXCEPT !.ps = "pending", !.dl = dl, !.disp = t, !.charged = TRUE,
                          !.slot = [ph |-> "processing",
                                    hu |-> IF Variant = "ShortHold" THEN dl ELSE dl + TEARDOWN, tdn |-> TRUE]],
                "queued")
  ELSE IF x.ps = "pending" THEN Res(x, "queued")
  ELSE IF x.ps \in {"running", "failed"} \/ (x.att = "done" /\ ~x.doomed) THEN Res(x, "settled")
  ELSE Res(x, "gone")

\* S4 startNormalize(id, invocation): the start rule. sid is the invocation that started it (start_id).
S4(x0, t, ra, maint, inv) ==
  LET x == IF Variant = "StartNoK3" THEN K4(x0, t) ELSE Norm(x0, t, ra) IN
  IF maint THEN Res(x0, "maint")
  ELSE IF x.ps = "pending"
  THEN IF x.dl - t >= MINENC THEN Res([x EXCEPT !.ps = "running", !.sid = inv, !.disp = 0], "started")
       ELSE Res([x EXCEPT !.ps = "failed", !.cause = "timeout", !.disp = 0], "settled")
  ELSE IF x.ps = "running" /\ x.sid = inv THEN Res(x, "started")
  ELSE IF x.ps \in {"running", "failed"} \/ x.att = "done" THEN Res(x, "settled")
  ELSE Res(x, "gone")

\* S5 confirmAvWrite(id, start_id, write): a grant of min(AV_GRANT_MS, cut - t) as a duration.
S5(x0, t, ra, maint, inv) ==
  LET x == Norm(x0, t, ra) IN
  IF maint THEN [x |-> x0, a |-> "maint", g |-> 0]
  ELSE IF x.ps = "running" /\ x.sid = inv /\ t < x.dl
  THEN [x |-> x, a |-> "grant", g |-> IF x.dl - t < AV_GRANT THEN x.dl - t ELSE AV_GRANT]
  ELSE [x |-> x, a |-> "refused", g |-> 0]

\* S6 completeAvUpload(id, start_id, token, facts): completed; the row deleted, the slot kept for S8.
S6(x0, t, ra, maint, inv) ==
  LET x == Norm(x0, t, ra) IN
  IF maint THEN Res(x0, "maint")
  ELSE IF x.ps = "running" /\ x.sid = inv /\ t < x.dl THEN Res([RowNone(x) EXCEPT !.att = "done"], "done")
  ELSE IF x.att = "done" /\ ~x.doomed /\ x.ps = "none" THEN Res(x, "done")
  ELSE Res(x, "refused")

\* S7 failNormalize(id, start_id, cause). After deadline_at, K4 has recorded "deadline" (or doomed a v1 upload).
S7(x0, t, ra, maint, inv, cause) ==
  LET x == Norm(x0, t, ra) IN
  IF maint THEN Res(x0, "maint")
  ELSE IF x.ps = "running" /\ x.sid = inv THEN Res([x EXCEPT !.ps = "failed", !.cause = cause], "recorded")
  ELSE IF x.ps = "failed" THEN Res(x, "recorded")
  ELSE IF x.att = "done" THEN Res(x, "settled")
  ELSE Res(x, "gone")

\* S8 releaseAvSlot(id, teardown_id): the slot of that teardown identity, unless a pending row still needs it.
S8(x0, t, ra, maint) ==
  LET x == IF Variant = "ReleaseK3Stops" THEN x0 ELSE Norm(x0, t, ra) IN
  IF maint THEN Res(x0, "maint")
  ELSE IF Variant = "ReleaseK3Stops" /\ Fenced(x0, ra) /\ x0.ps \in {"pending", "running"}
  THEN Res(Norm(x0, t, ra), "settled")
  ELSE IF x.ps = "pending" /\ x.slot.tdn THEN Res(x, "held")
  ELSE IF x.slot.tdn THEN Res([x EXCEPT !.slot = NoSlot], "released")
  ELSE Res(x, "released")

\* S9 v1Outcome: a read, at the Store's time, of what the upload's record shows.
S9(x0, t, ra) ==
  LET x == Norm(x0, t, ra) IN
  IF x.att = "done" /\ ~x.doomed THEN "done"
  ELSE IF x.ps \in {"pending", "running", "staging"} THEN "processing"
  ELSE "ended"

\* S10 v1Final: the v1 decision, made by the route at its own cut (arrival + V1_TIME_MS - T_REPLY on its clock) or
\* once S9 shows an outcome. It decides now, whatever deadline_at says (Codex r4 H1): an unfinished upload is doomed.
\* In maintenance it is a read: a completed upload answers 200, anything else the maintenance 503 with nothing doomed
\* (Codex r4 M5, Gemini r4 GM4).
S10Code(c) ==
  IF c \in {"refused", "envelope"} THEN "422"
  ELSE IF c \in {"verifier", "unavailable", "timeout"} THEN "500"
  ELSE "503"

S10(x0, t, ra, maint) ==
  LET x == Norm(x0, t, ra) IN
  IF maint THEN Res(x0, IF x.att = "done" /\ ~x.doomed THEN "200" ELSE "maint")
  ELSE IF x.att = "done" /\ ~x.doomed THEN Res(x, "200")
  ELSE IF x.ps = "failed" /\ x.cause = "restored" /\ Variant = "RestoredAnswers500" THEN Res(x, "500")
  ELSE IF x.ps = "failed" /\ S10Code(x.cause) # "503" THEN Res(x, S10Code(x.cause))
  ELSE IF x.ps \in {"pending", "running"} /\ t < x.dl /\ Variant = "WaitForStoreDeadline" THEN Res(x, "not_yet")
  ELSE IF x.att \in {"res", "done"} /\ ~x.doomed THEN Res(Doom(x), "503")
  ELSE Res(x, "503")

\* S11 DELETE of an unattached upload by its owner: doomed, its processing row deleted, its slot kept.
S11(x0, t, ra, maint) ==
  LET x == Norm(x0, t, ra) IN
  IF maint THEN Res(x0, "maint")
  ELSE IF x.att \in {"res", "done"} /\ ~x.doomed /\ x.ps # "staging"
  THEN Res(CASE Variant = "DeleteFreesSlot" -> [Doom(x) EXCEPT !.slot = NoSlot]
             [] Variant = "DeleteKeepsRow" -> [x EXCEPT !.doomed = TRUE]
             [] OTHER -> Doom(x), "200")
  ELSE Res(x, "404")

\* S12 and S13, the dispatch round's step for one upload (the restore pass is its K3): abandoned staging deleted,
\* an expired slot deleted, a pending row whose dispatch is DISPATCH_MS old dispatched again ("run").
S12(x0, t, ra) ==
  LET x1 == Norm(x0, t, ra)
      x2 == IF x1.ps = "staging" /\ t >= x1.sUntil THEN [RowNone(x1) EXCEPT !.slot = NoSlot] ELSE x1
      x3 == IF x2.slot.ph # "none" /\ x2.slot.hu <= t /\ Variant # "NoExpiry" THEN [x2 EXCEPT !.slot = NoSlot] ELSE x2
  IN IF x3.ps = "pending" /\ t - x3.disp >= DISPATCH THEN Res([x3 EXCEPT !.disp = t], "run") ELSE Res(x3, "none")

=============================================================================
