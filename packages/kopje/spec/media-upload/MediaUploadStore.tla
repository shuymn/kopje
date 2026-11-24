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
(*     answers from the record. S8, the stop confirmation, is a write like *)
(*     any other (D8, D16); MaintInert checks every write (D26).           *)
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

\* Abstract durations (MediaUpload.tla, TIME); the scenario's c gives the first five and HARD_HOLD.
STAGING == P.c.staging \* STAGING_MS
V1 == P.c.v1 \* V1_TIME_MS, from the request's arrival
T_REPLY == 1 \* T_REPLY
V2P == P.c.v2p \* V2_PROCESS_MS
TEARDOWN == P.c.teardown \* TEARDOWN_MS, the alarm's wall limit, at least V2_PROCESS_MS as in the design
WW == P.c.ww \* AV_WRITE_WINDOW_MS from the reservation; caps deadline_at
IW == WW - STAGING - 1 \* WRITE_WINDOW_MS, the reservation's write deadline before S1 sets the AV one
MINLEFT == 1 \* T_FIXED + T_MIN_ENCODE, checked by S3
MINENC == 1 \* T_MIN_ENCODE after the remaining fixed parts, checked by S4
AV_GRANT == 1 \* AV_GRANT_MS
DISPATCH == 1 \* DISPATCH_MS
GC == WW \* gc_at of an unfinished reservation (RESERVATION_MS), after every write cut
\* ORPHAN_GRACE_MS: how long after the write cut the tombstone keeps the authority to delete an upload's keys, as an
\* image's does (src/domain/media.ts). The model lets a write land at most this long after it starts; one landing
\* later stays, as an image's does (docs/threat-model.md, "stays for good").
LAND == 1
RETIRE == WW + LAND \* the tombstone's authority after the reservation, for a purge before the write deadline (M3)
\* The tombstone's delete_after, as purgeMedia stores it: max(purge, write deadline) + ORPHAN_GRACE_MS (D27), the write
\* deadline the AV one, the reservation + AV_WRITE_WINDOW_MS, past every write cut (deadline_at). Only scenarios with
\* purge keep a purge's time past the write deadline (it adds a state per purge time); the others take every purge as
\* before it, so their tombstone retires no later than main's.
DeleteAfter(x, t) == (IF P.purge /\ t > x.resAt + WW THEN t ELSE x.resAt + WW) + LAND
\* DETACHED_GRACE_MS: the gc_at completion gives an unattached upload (completeMedia), longer than the v1 wait.
DGRACE == IF Variant = "ShortGrace" THEN V1 ELSE V1 + 1
\* HARD_HOLD_MS: how long a granted slot counts at most, from the grant's stored time (D16, D17).
HARD_HOLD == P.c.hh

\* A slot: its phase, held_until, teardown_id (0 for none; the queue issues 1, one queue per reservation) and ga, the
\* Store's time of the grant: S4's start, stored in its transaction whatever becomes of its reply (-1: not granted).
NoSlot == [ph |-> "none", hu |-> 0, td |-> 0, ga |-> -1]

\* Capacity by confirmation (D16). A slot never granted counts until its held_until: a staging slot until
\* staged_until, a processing slot until deadline_at, the admission deadline, after which no container starts
\* (StartNeedsSlot). A granted slot counts until the stop confirmation (S8) deletes it, and time frees it only at
\* HARD_HOLD past its grant, a stored time no later write moves, so a restore cannot shorten it below what the restored
\* row says (D18). GrantedLapses lets time free a granted slot at its held_until.
Counts(slot, t) ==
  /\ slot.ph # "none"
  /\ IF slot.ga >= 0 /\ Variant # "GrantedLapses" THEN t < slot.ga + HARD_HOLD ELSE slot.hu > t

\* An upload's Store record. att: none (no attachment row: never reserved, or its tombstone retired), res (reserved,
\* processed = 0), done (processed = 1), gone (swept: the tombstone). staged: S1 ran for this reservation (Codex r4 M1).
\* ps: the media_processing row's state. gcAt: the gc_at completion sets. chg: the units S3 charged for the upload, in
\* the Store's own counter (Codex r1 CM5). dA: the tombstone's delete_after, max(purge, write deadline) +
\* ORPHAN_GRACE_MS, as purgeMedia stores it (D27).
Fresh == [att |-> "none", resAt |-> 0, doomed |-> FALSE, staged |-> FALSE, ps |-> "none", v1 |-> FALSE, sAt |-> 0,
          sUntil |-> 0, rb |-> 0, dl |-> 0, disp |-> 0, sid |-> 0, cause |-> "none", slot |-> NoSlot, gcAt |-> 0,
          chg |-> 0, dA |-> 0]

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
  ELSE IF x.ps \in {"pending", "running"}
  THEN [x EXCEPT !.ps = "failed", !.cause = "restored", !.disp = 0,
                 !.slot = IF Variant = "K3FreesSlot" THEN NoSlot ELSE x.slot]
  ELSE x

K4(x, t) ==
  IF x.ps \in {"pending", "running"} /\ t >= x.dl
  THEN IF x.v1 THEN Doom(x) ELSE [x EXCEPT !.ps = "failed", !.cause = "deadline", !.disp = 0]
  ELSE x

Norm(x, t, restoredAt) == K4(K3(x, restoredAt), t)

Res(x, a) == [x |-> x, a |-> a]

Live(S, v, t) == Counts(S[v].slot, t)

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
                        !.slot = [ph |-> "staging", hu |-> until, td |-> 0, ga |-> -1]], "taken")
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
  LET x == IF Variant = "QueueNoFence" THEN K4(x0, t) ELSE Norm(x0, t, ra)
      dl == QueueDeadline(x, t)
  IN
  IF maint THEN Res(x0, "maint")
  ELSE IF x0.ps = "staging" /\ x0.sAt = sAt /\ Fenced(x0, ra) /\ Variant # "QueueNoFence" THEN Res(x, "refused_restored")
  ELSE IF x.ps = "staging" /\ x.sAt = sAt
  THEN IF t >= x.sUntil THEN Res([RowNone(x) EXCEPT !.slot = NoSlot], "refused_time")
       ELSE IF ~active THEN Res([RowNone(x) EXCEPT !.slot = NoSlot], "refused_inactive")
       ELSE IF dl - t < MINLEFT THEN Res([RowNone(x) EXCEPT !.slot = NoSlot], "refused_time")
       ELSE Res([x EXCEPT !.ps = "pending", !.dl = dl, !.disp = t, !.chg = IF Variant = "NoCharge" THEN x.chg ELSE x.chg + 1,
                          !.slot = [ph |-> "processing", hu |-> dl, td |-> 1, ga |-> -1]],
                "queued")
  ELSE IF x.ps = "pending" THEN Res(IF Variant = "ChargeTwice" THEN [x EXCEPT !.chg = x.chg + 1] ELSE x, "queued")
  ELSE IF x.ps \in {"running", "failed"} \/ (x.att = "done" /\ ~x.doomed) THEN Res(x, "settled")
  ELSE Res(x, "gone")

\* S4 startNormalize(id, invocation): the start rule. sid is the invocation that started it (start_id). The start is
\* the slot's grant: its time is stored on the slot in this transaction (D16).
S4(x0, t, ra, maint, inv) ==
  LET x == IF Variant = "StartNoK3" THEN K4(x0, t) ELSE Norm(x0, t, ra) IN
  IF maint THEN Res(x0, "maint")
  ELSE IF x.ps = "pending"
  THEN IF x.dl - t >= MINENC
       THEN Res([x EXCEPT !.ps = "running", !.sid = inv, !.disp = 0,
                          !.slot = IF x.slot.ph = "processing" /\ x.slot.ga < 0 THEN [x.slot EXCEPT !.ga = t] ELSE x.slot],
                "started")
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
  \* K3FreesSlotAtGrant: K3 deletes a restored row's slot in S5 alone (Codex r2 CM4).
  ELSE IF Variant = "K3FreesSlotAtGrant" /\ Fenced(x0, ra) /\ x0.ps \in {"pending", "running"}
  THEN [x |-> [x EXCEPT !.slot = NoSlot], a |-> "refused", g |-> 0]
  ELSE [x |-> x, a |-> "refused", g |-> 0]

\* S6 completeAvUpload(id, start_id, token, facts): completed, with the gc_at of a completed unattached upload; the row
\* deleted, the slot kept for S8.
S6(x0, t, ra, maint, inv) ==
  LET x == Norm(x0, t, ra) IN
  IF maint THEN Res(x0, "maint")
  ELSE IF x.ps = "running" /\ x.sid = inv /\ t < x.dl THEN Res([RowNone(x) EXCEPT !.att = "done", !.gcAt = t + DGRACE], "done")
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

\* S8 releaseAvSlot(id, teardown_id): the stop confirmation (D16). The processor calls it only once its container is
\* confirmed stopped (destroy() answered and running is false), with the teardown_id its record holds; it deletes the
\* slot of that teardown identity, unless a pending row still needs it. A wrong teardown_id leaves the slot as it is
\* (ConfirmFenced; ConfirmNoFence drops the identity check). Under K1 it changes nothing (MaintInert;
\* MaintConfirmsDone exempts a completed upload's row from K1, Codex r4 CM3).
S8(x0, t, ra, maint, td) ==
  LET x == IF Variant = "ReleaseK3Stops" THEN x0 ELSE Norm(x0, t, ra) IN
  IF maint /\ ~(Variant = "MaintConfirmsDone" /\ x0.att = "done") THEN Res(x0, "maint")
  ELSE IF Variant = "ReleaseK3Stops" /\ Fenced(x0, ra) /\ x0.ps \in {"pending", "running"}
  THEN Res(Norm(x0, t, ra), "settled")
  ELSE IF td = 0 \/ (x.slot.td # td /\ Variant # "ConfirmNoFence") THEN Res(x, "released")
  \* No pending row meets S8 in the model (S8 follows its invocation's own S4, which leaves pending): a defence the
  \* PR4-1 test carries.
  ELSE IF x.ps = "pending" THEN Res(x, "held")
  ELSE Res([x EXCEPT !.slot = NoSlot], "released")

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
  \* Done503: S10 answers 503 for a completed upload and leaves it completed (Codex r2 CM5).
  ELSE IF x.att = "done" /\ ~x.doomed THEN Res(x, IF Variant = "Done503" THEN "503" ELSE "200")
  ELSE IF x.ps = "failed" /\ x.cause = "restored" /\ Variant = "RestoredAnswers500" THEN Res(x, "500")
  \* RestoredAnswers200: S10 answers 200 for a restored reservation that never completed (Codex r2 CM6).
  ELSE IF Fenced(x0, ra) /\ x.att = "res" /\ Variant = "RestoredAnswers200" THEN Res(x, "200")
  \* LateRestored200: the same, only once the v1 wait is over on the Store's clock, so for a call that commits after the
  \* route answered (Codex r3 CM1, Gemini r3 GM1, D19).
  ELSE IF Fenced(x0, ra) /\ x.att = "res" /\ Variant = "LateRestored200" /\ t > x0.resAt + V1 THEN Res(x, "200")
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
\* a slot that no longer counts deleted, a pending row whose dispatch is DISPATCH_MS old dispatched again ("run").
S12(x0, t, ra) ==
  LET x1 == Norm(x0, t, ra)
      x2 == IF x1.ps = "staging" /\ t >= x1.sUntil THEN [RowNone(x1) EXCEPT !.slot = NoSlot] ELSE x1
      x3 == IF x2.slot.ph # "none" /\ ~Counts(x2.slot, t) /\ Variant # "NoExpiry" THEN [x2 EXCEPT !.slot = NoSlot] ELSE x2
  IN IF x3.ps = "pending" /\ t - x3.disp >= DISPATCH THEN Res([x3 EXCEPT !.disp = t], "run") ELSE Res(x3, "none")

=============================================================================
