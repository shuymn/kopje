----------------------------- MODULE MediaUpload -----------------------------
(***************************************************************************)
(* The lifecycle of a video or audio upload (#1828 PR4): the upload route  *)
(* (v1 and v2), the Store, the upload's processor Durable Object           *)
(* u:<id>:<token>, its container, R2, the cron rounds, PITR restore,       *)
(* maintenance and the owner, under lost replies, kills and late writes.   *)
(* It decides the PR4 plan's section 1 (design-1828-pr4-plan.md): each of  *)
(* its tables cites the operator or property here that decides a cell.    *)
(* test-node/media-upload-spec/ checks it with tla-ts.                     *)
(*                                                                         *)
(* ACTORS AND ATOMICITY. Each action is one indivisible step.              *)
(*  - The Store: one operator of MediaUploadStore.tla per transaction, at  *)
(*    its time `now`. Its state (st, sg) is what a restore rewinds.        *)
(*  - The route: a request's own memory (rt). Each of its Store calls is   *)
(*    three steps, send, the Store's transaction and the reaction to its   *)
(*    reply, so a call may commit late and its reply may be lost; a call   *)
(*    that fails before its commit is the same reaction without the        *)
(*    transaction. Writing incoming/<id> (its multipart completion) is one *)
(*    step; the route keeps no other key. S9 is read in the step that acts *)
(*    on it: it only sends the route to S10, which decides at its own      *)
(*    commit, so a lost or late S9 reply is a poll not taken, or taken     *)
(*    earlier, which RoutePoll and RouteCut already allow.                 *)
(*  - The processor: its durable storage (dd: the record with teardown_id, *)
(*    the alarm, and its container's state) and one alarm() invocation at  *)
(*    a time (iv), whose memory a kill drops at any step. A `run` request  *)
(*    (D0) is one storage transaction and may overlap an invocation. Its   *)
(*    Store calls are one step each (the call and its transaction; the     *)
(*    reply may be lost, and the invocation repeats the call). The         *)
(*    platform clears the alarm when alarm() begins and runs it again if   *)
(*    the handler dies before D1 replaces it [docs for a throw, assumed    *)
(*    for an eviction], so D1 is part of the alarm's entry (Fire), and D8  *)
(*    part of D9 (DOS8). An invocation ends by its wall limit              *)
(*    TEARDOWN (WallKill), and the container answers by the job's          *)
(*    deadline. The encode and the stop's outcome are one step (DOWork): a *)
(*    kill between them is a kill before the step, with the container on.  *)
(*    A processor that stops for good (DOGone) runs no alarm or request    *)
(*    again; its container runs on (W10).                                  *)
(*  - R2: an incoming key per upload, the objects of the final writes, and *)
(*    the writes in flight, each landing (or never landing) at most LAND   *)
(*    after it started, whatever its writer does meanwhile.                *)
(*  - The cron: S12/S13 per row, the sweep, reconciliation, the tombstone  *)
(*    retirement, and the incomingOrphans pass (claim, classify, delete).  *)
(*  - The operator: maintenance, bookmarks and restores (st and sg back to *)
(*    any bookmark taken, the restore marker ra = now, which the Store     *)
(*    reads as restoredAt; DO storage, R2, containers and requests are not *)
(*    rewound) and revoking the probe verdict.                             *)
(*  - The owner: DELETE and GET of an upload whose id it was answered.     *)
(*                                                                         *)
(* TIME. One clock `now`, in abstract units (MediaUploadStore.tla's        *)
(* constants). The route (skr) and the processor (skd) read it with fixed  *)
(* offsets; only durations cross a clock boundary (S1's v1Left, S1's       *)
(* staging time, S4's remaining time, S5's grant), each measured from a    *)
(* reading taken before the call, so an offset cancels and a late reply    *)
(* only shortens what it grants (variants AbsGrant and AbsStart compare an *)
(* absolute Store time on the processor's clock instead). A v1 request     *)
(* answers no later than arrival + V1 on its own clock, and an R2 write    *)
(* resolves within LAND: the clock does not move past either. A live       *)
(* processor runs a due alarm before the clock moves while its container  *)
(* runs, the margin RENEW - CLEANUP_RETRY_MS leaves (S14).                 *)
(*                                                                         *)
(* SAFETY (each a named invariant; checks.json gives its mutation):        *)
(*  SlotBound          live slots (held_until in the future) never exceed  *)
(*                     MAX_AV_INFLIGHT (design 4.5 "Capacity").             *)
(*  ContainerCovered   a running container has its upload's live slot,     *)
(*                     except W3 (a restore since its start that left no    *)
(*                     live processing slot) and W10 (its processor gone).  *)
(*  MaxContainers      at most MAX_AV_INFLIGHT containers run outside       *)
(*                     those two windows (D3).                              *)
(*  StartNeedsSlot     a container starts only before the job's deadline   *)
(*                     on the Store's clock, with a live processing slot    *)
(*                     (W3 excepted).                                       *)
(*  SlotRelease        a processing slot is removed only by S8 after the   *)
(*                     stop is confirmed and while no pending row needs it, *)
(*                     or at held_until (C2-H2, GM3, GH1, Gemini r1 GH1).   *)
(*  RouteDeleteAuthority  the route deletes incoming/<id> only on S2's      *)
(*                     released or S3's refused_cleanup_yours, never after  *)
(*                     a queue commit a restore has not fenced (C1, C2-H3,  *)
(*                     Gemini r4 GH3).                                      *)
(*  InputKept          no one but its owner deletes the input of a live    *)
(*                     unfenced row (W4 is the fenced case).                *)
(*  NoPublishAfterDelete  no completion after DELETE, and a write lands     *)
(*                     after it only on a grant issued before it (W1).      *)
(*  NoPublishAfterNon200  after a v1 answer other than 200 that the Store  *)
(*                     decided, or that the route gave before its queue,    *)
(*                     no completion, and a write lands only on a grant     *)
(*                     issued before the answer (W1); a 503 the Store did   *)
(*                     not decide is W5 (Codex r4 H1, M5; Gemini r1 GH2).   *)
(*  GrantBound         a write starts before its grant's Store time plus    *)
(*                     the grant (W1's bound, C7, M3).                      *)
(*  GrantGround        a write lands after DELETE only while the upload's   *)
(*                     URL was never issued (W1's ground, M3).              *)
(*  V1Answer           S10 decides 200, and the route sends it, only for a *)
(*                     completed, undoomed upload whose writes have all     *)
(*                     landed; a restore since the reservation, or between  *)
(*                     the two, is W11 (D1).                                *)
(*  ChargeOnce         the Store charges one unit per upload (RES-6, H3,    *)
(*                     GH1, Codex r1 CM5).                                  *)
(*  RestoredInert      a reservation made before the last restore never    *)
(*                     stages, queues, starts, is granted a write or        *)
(*                     completes (C3, G5, model 5, Gemini r1 GH3).          *)
(*  Q4                 a decided v1 answer for an upload a restore fenced   *)
(*                     is 503 and dooms it, whichever of S10 and the round  *)
(*                     meets the restore first.                             *)
(*  RecordDropSafe     the processor deletes its storage only with its      *)
(*                     container stopped and no live slot of its teardown   *)
(*                     left behind a row that is not pending (Codex r4 H4;  *)
(*                     the record-age stop, W9, only past held_until).      *)
(*  SingleStaging      a reservation stages at most once (Codex r4 M1).     *)
(*  NoLateObject       once the tombstone is retired, no object of the      *)
(*                     upload exists or lands (Codex r4 M3).                *)
(*                                                                         *)
(* LIVENESS (scenarios L1-L4, under LSpec's fairness: weak fairness on     *)
(* every step but a fault, so alarms fire, rounds run, replies arrive and  *)
(* maintenance ends; every fault is budgeted, so none recurs for ever; the *)
(* clock moves only when no step can be taken now, which PendingStarts     *)
(* needs: the cron's round, the run and the alarm's entry take less than   *)
(* ROOM - MINENC, in production DISPATCH_MS + the cron period + the        *)
(* processor's startup < deadline_at - now - T_MIN_ENCODE):                *)
(*  SlotsReleased, RecordsCleared, InputsDeleted, ContainersStopped;       *)
(*  CompletedSwept: a completed upload whose v1 client got a 503 is swept  *)
(*  at its gc_at (W5's bound, D2); and PendingStarts: a pending row with   *)
(*  at least DISPATCH + MINENC left starts its container, after a kill     *)
(*  before its start or a lost run (Codex r4 H3, W7), unless the start's  *)
(*  reply died with its invocation (the start rule).                       *)
(***************************************************************************)
EXTENDS Integers, FiniteSets, MediaUploadStore

RETRY == 1 \* CLEANUP_RETRY_MS: D1's alarm, before S4
RECMAX == V2P + TEARDOWN \* D1's record-age stop (W9), on the processor's clock
NINV == P.ninv \* invocations per upload in one behaviour (a bound of the model)
ROOM == DISPATCH + MINENC

\* ev: the windows and orders a behaviour has gone through (MediaUploadGoals.tla), a ghost no step reads.
VARIABLES now, st, sg, bm, ra, rt, dd, iv, nInv, runReq, r2, orp, bud, gh, err, ev

vars == <<now, st, sg, bm, ra, rt, dd, iv, nInv, runReq, r2, orp, bud, gh, err, ev>>

\* A route call's reply: its answer ("lost": no reply; for S10, "lost" after its commit and "failed" before it), and,
\* for S10, the restore marker at its commit (V1Answer's W11).
NoRep == [a |-> "none", sAt |-> 0, dur |-> 0, ra |-> -1]
\* An invocation's memory; sdl is a ghost, the Store's deadline at its start (StartNeedsSlot).
NoInv == [pc |-> "none", id |-> 0, fired |-> 0, dl |-> 0, sdl |-> 0, k |-> 0, gexp |-> 0, gat |-> 0, gg |-> 0,
          pre |-> TRUE, pa |-> TRUE, out |-> "ok"]
NoBm == [has |-> FALSE, st |-> [v \in U |-> Fresh], sg |-> [active |-> TRUE, maint |-> FALSE, oc |-> -1]]

Init ==
  /\ now = 0
  /\ st = [u \in U |-> Fresh]
  /\ sg = [active |-> TRUE, maint |-> FALSE, oc |-> -1]
  /\ bm = [i \in 1..P.bm |-> NoBm]
  /\ ra = -1
  /\ rt = [u \in U |-> [pc |-> "idle", v1 |-> u \in P.v1, arr |-> 0, call |-> "none", sent |-> 0, left |-> 0, sAt |-> 0,
                        sx |-> 0, rep |-> NoRep, tries |-> 0, ans |-> 0, kind |-> "none", want |-> 0]]
  /\ dd = [u \in U |-> [rec |-> FALSE, at |-> 0, alarm |-> -1, cont |-> "off", td |-> 0, gone |-> FALSE]]
  /\ iv = [u \in U |-> NoInv]
  /\ nInv = [u \in U |-> 0]
  /\ runReq = [u \in U |-> FALSE]
  /\ r2 = [u \in U |-> [inc |-> FALSE, obj |-> {}, fly |-> {}]]
  /\ orp = [pc |-> "none", c |-> 0, keys |-> {}]
  /\ bud = [loss |-> P.loss, kill |-> P.kill, dfail |-> P.dfail, gone |-> P.gone, perr |-> P.perr, rdie |-> P.rdie,
            del |-> P.del, mOn |-> P.mOn, bm |-> P.bm, rs |-> P.rs, rev |-> P.rev, bad |-> IF P.bad THEN 1 ELSE 0]
  \* s4At: the first start's time; w3: a restore since it left no live processing slot.
  /\ gh = [u \in U |-> [doomAt |-> -1, tok |-> FALSE, q |-> FALSE, s4At |-> -1, w3 |-> FALSE, take |-> -1,
                        ret |-> FALSE, k3 |-> ""]]
  /\ err = {}
  /\ ev = {}

Maint == sg.maint
IsFenced(u) == Fenced(st[u], ra)
\* The route's clock.
RNow == now + P.skr
\* W3: a restore since the job's start left no live processing slot (forgotten, staging, or expired at the bookmark).
W3(u) == gh[u].w3
\* W10: the processor stopped for good with its container running, so no replay renews its slot or stops it.
W10(u) == dd[u].gone
\* The 503s of a v1 request the Store did not decide (W5): S10's reply lost after its commit, S10 failed before it,
\* the route's give-up at V1_TIME_MS, maintenance, and S3 lost twice.
W5Kinds == {"lost", "fail", "giveup", "maint", "s3lost"}
\* A v1 answer other than 200 the Store decided, or the route gave before a queue.
Non200(u) == rt[u].v1 /\ rt[u].ans \notin {0, 200} /\ rt[u].kind \notin W5Kinds
\* A completed upload whose v1 request answered 503 (W5).
W5Row(u) == rt[u].v1 /\ rt[u].ans = 503 /\ st[u].att = "done" /\ ~st[u].doomed
\* A row whose input someone still needs: staging before its staged_until, pending or running.
LiveRow(x, t) == ((x.ps = "staging" /\ t < x.sUntil) \/ x.ps \in {"pending", "running"}) /\ ~x.doomed
\* Completed and every write landed: what a 200 may stand for.
Published(u, x) == x.att = "done" /\ ~x.doomed /\ r2[u].obj = Writes

Ev(name, cond) == ev' = IF cond THEN ev \cup {name} ELSE ev

Flag(name) == err' = err \cup {name}
\* SlotRelease: a transaction that removes a processing slot, unless ok says it may.
FreedEarly(x0, x1, ok) == IF x0.slot.ph = "processing" /\ x1.slot.ph = "none" /\ ~ok THEN {"SlotFreedEarly"} ELSE {}
\* The ghost of which step first met a restored pending or running row (Q4's two orders).
K3By(u, by) ==
  IF gh[u].k3 = "" /\ IsFenced(u) /\ st[u].ps \in {"pending", "running"} THEN by ELSE gh[u].k3

\* Deleting incoming/<id> by someone other than the owner of the phase (InputKept).
TakesInput(u) == r2[u].inc /\ LiveRow(Norm(st[u], now, ra), now) /\ ~IsFenced(u)

---------------------------------------------------------------------------
(* The route.                                                              *)

Answer(u, code, kind) ==
  /\ rt' = [rt EXCEPT ![u].pc = "done", ![u].ans = code, ![u].kind = kind, ![u].rep = NoRep, ![u].sent = 0,
                       ![u].left = 0]
  /\ gh' = [gh EXCEPT ![u].tok = gh[u].tok \/ code = 200]

\* The route deletes incoming/<id>: only with the Store's cleanup answer, and never once a queue it cannot see as
\* forgotten has committed (RouteDeleteAuthority). A queue a restore rewound is fenced: the job it may have started
\* reserved before the restore, so it never publishes (Gemini r4 GH3).
RouteDel(u, ok) ==
  /\ r2' = [r2 EXCEPT ![u].inc = FALSE]
  /\ IF (gh[u].q /\ ~IsFenced(u)) \/ ~ok THEN Flag("RouteDeleteNoAuthority") ELSE UNCHANGED err

RouteArrive(u) ==
  /\ rt[u].pc = "idle" /\ now <= P.arr /\ (u \in P.late => now >= P.lateAt)
  /\ IF Maint
     THEN /\ rt' = [rt EXCEPT ![u].pc = "done", ![u].arr = RNow, ![u].ans = 503, ![u].kind = "maint"]
          /\ UNCHANGED st
     ELSE /\ st' = [st EXCEPT ![u] = [Fresh EXCEPT !.att = "res", !.resAt = now]]
          /\ rt' = [rt EXCEPT ![u].pc = "s1", ![u].arr = RNow]
  /\ UNCHANGED <<ev, now, sg, bm, ra, dd, iv, nInv, runReq, r2, orp, bud, gh, err>>

RouteSend(u) ==
  /\ rt[u].pc \in {"s1", "s2", "s3", "s10"} /\ rt[u].call = "none" /\ rt[u].rep.a = "none"
  /\ rt' = [rt EXCEPT ![u].call = rt[u].pc, ![u].sent = RNow, ![u].left = V1 - (RNow - rt[u].arr)]
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, dd, iv, nInv, runReq, r2, orp, bud, gh, err>>

\* The Store's transaction for the route's call, at the Store's time.
RouteResult(u) ==
  LET c == rt[u].call IN
  CASE c = "s1" -> S1(st, u, now, ra, Maint, sg.active, rt[u].v1, rt[u].left)
    [] c = "s2" -> S2(st[u], now, ra, Maint, rt[u].sAt)
    [] c = "s3" -> S3(st[u], now, ra, Maint, sg.active, rt[u].sAt)
    [] c = "s10" -> S10(st[u], now, ra, Maint)

RouteGhost(u, res) ==
  LET c == rt[u].call
      x0 == st[u]
  IN [gh[u] EXCEPT
        !.take = IF c = "s1" /\ res.a = "taken" /\ x0.ps # "staging" THEN now ELSE gh[u].take,
        !.q = gh[u].q \/ (c = "s3" /\ res.a = "queued"),
        !.k3 = IF c = "s10" THEN K3By(u, "s10") ELSE gh[u].k3]

RouteFlags(u, res) ==
  LET c == rt[u].call
      x0 == st[u]
  IN {f \in {"Restaged", "Q4", "V1Answer", "RestoredActs"} :
        \/ f = "Restaged" /\ c = "s1" /\ res.a = "taken" /\ x0.ps # "staging" /\ gh[u].take >= 0
        \/ f = "Q4" /\ c = "s10" /\ ~Maint /\ Fenced(x0, ra)
                    /\ (x0.ps \in {"staging", "pending", "running"} \/ x0.cause = "restored")
                    /\ ~(res.a = "503" /\ res.x.doomed)
        \* A restore since the reservation may bring back a completed row whose objects are gone (W11).
        \/ f = "V1Answer" /\ c = "s10" /\ res.a = "200" /\ ~Published(u, res.x) /\ ~Fenced(x0, ra)
        \/ f = "RestoredActs" /\ Fenced(x0, ra)
                              /\ \/ c = "s1" /\ res.a = "taken" /\ x0.ps # "staging"
                                 \/ c = "s3" /\ res.a = "queued" /\ x0.ps = "staging"}
     \cup FreedEarly(x0, res.x, FALSE)

RouteExec(u) ==
  /\ rt[u].call # "none"
  /\ LET res == RouteResult(u)
         listening == rt[u].pc \notin {"done", "dead"}
     IN \/ /\ st' = [st EXCEPT ![u] = res.x]
           /\ gh' = [gh EXCEPT ![u] = RouteGhost(u, res)]
           /\ err' = err \cup RouteFlags(u, res)
           \* H1: S10 decides at the route's cut before the Store's deadline.
           /\ Ev("H1", rt[u].call = "s10" /\ res.a = "503" /\ Norm(st[u], now, ra).ps = "running")
           /\ \/ /\ rt' = [rt EXCEPT ![u].call = "none",
                                     ![u].rep = IF ~listening THEN NoRep
                                                ELSE IF res.a = "taken"
                                                THEN [a |-> res.a, sAt |-> res.x.sAt, dur |-> res.x.sUntil - now,
                                                      ra |-> -1]
                                                ELSE [NoRep EXCEPT !.a = res.a, !.ra = IF rt[u].call = "s10" THEN ra ELSE -1]]
                 /\ UNCHANGED bud
              \/ /\ bud.loss > 0 /\ listening
                 /\ rt' = [rt EXCEPT ![u].call = "none", ![u].rep = [NoRep EXCEPT !.a = "lost"]]
                 /\ bud' = [bud EXCEPT !.loss = bud.loss - 1]
        \* The call fails before its transaction.
        \/ /\ bud.loss > 0 /\ listening
           /\ rt' = [rt EXCEPT ![u].call = "none",
                               ![u].rep = [NoRep EXCEPT !.a = IF rt[u].call = "s10" THEN "failed" ELSE "lost"]]
           /\ bud' = [bud EXCEPT !.loss = bud.loss - 1]
           /\ UNCHANGED <<st, gh, err, ev>>
  /\ UNCHANGED <<now, sg, bm, ra, dd, iv, nInv, runReq, r2, orp>>

ToPc(u, pc) == rt' = [rt EXCEPT ![u].pc = pc, ![u].rep = NoRep, ![u].tries = 0, ![u].sent = 0, ![u].left = 0]

Retry(u) == rt' = [rt EXCEPT ![u].rep = NoRep, ![u].tries = 1, ![u].sent = 0, ![u].left = 0]

RouteReact(u) ==
  /\ rt[u].rep.a # "none"
  /\ LET a == rt[u].rep.a
         pc == rt[u].pc
         v1 == rt[u].v1
         noReply == a \in {"lost", "failed"}
         keep == UNCHANGED <<r2, err>>
     IN CASE pc = "s1" ->
             IF a = "taken"
             THEN /\ rt' = [rt EXCEPT ![u].pc = "stream", ![u].rep = NoRep, ![u].sAt = rt[u].rep.sAt,
                                      ![u].sx = rt[u].sent + rt[u].rep.dur, ![u].tries = 0, ![u].sent = 0,
                                      ![u].left = 0]
                  /\ UNCHANGED gh /\ keep /\ UNCHANGED <<runReq, ev>>
             ELSE IF noReply /\ rt[u].tries = 0
             THEN Retry(u) /\ UNCHANGED gh /\ keep /\ UNCHANGED <<runReq, ev>>
             ELSE /\ Answer(u, CASE a = "inactive" -> 422 [] OTHER -> 503, IF a = "maint" THEN "maint" ELSE "route")
                  /\ keep /\ UNCHANGED <<runReq, ev>>
          [] pc = "s2" ->
             \* An S2 reply not received leaves the input to the sweep (W6).
             /\ Answer(u, rt[u].want, IF noReply THEN "s2lost" ELSE "route")
             /\ IF a = "released" THEN RouteDel(u, TRUE) ELSE keep
             /\ UNCHANGED <<runReq, ev>>
          [] pc = "s3" ->
             IF a = "queued" \/ a = "settled"
             THEN /\ runReq' = [runReq EXCEPT ![u] = runReq[u] \/ a = "queued"]
                  /\ IF v1 THEN ToPc(u, "wait") /\ UNCHANGED gh ELSE Answer(u, 202, "route")
                  /\ keep /\ UNCHANGED ev
             ELSE IF a \in {"refused_restored", "refused_time", "refused_inactive"}
             THEN /\ Answer(u, IF a = "refused_inactive" THEN 422 ELSE 503, "route")
                  /\ RouteDel(u, TRUE) /\ UNCHANGED runReq
                  /\ Ev("GH3", a = "refused_restored")
             ELSE IF noReply /\ rt[u].tries = 0
             THEN Retry(u) /\ UNCHANGED gh /\ keep /\ UNCHANGED <<runReq, ev>>
             ELSE IF noReply /\ Variant = "RouteCleansOnLost"
             THEN /\ Answer(u, 503, "s3lost") /\ RouteDel(u, FALSE) /\ UNCHANGED <<runReq, ev>>
             \* SlotById: the design's single release by id, called from the request's finally.
             ELSE IF noReply /\ Variant = "SlotById"
             THEN /\ rt' = [rt EXCEPT ![u].pc = "s2", ![u].want = 503, ![u].rep = NoRep, ![u].tries = 0, ![u].sent = 0,
                                  ![u].left = 0]
                  /\ UNCHANGED gh /\ keep /\ UNCHANGED <<runReq, ev>>
             ELSE /\ Answer(u, 503, CASE a = "maint" -> "maint" [] noReply -> "s3lost" [] OTHER -> "route")
                  /\ keep /\ UNCHANGED <<runReq, ev>>
          [] pc = "s10" ->
             /\ CASE a = "lost" -> Answer(u, 503, "lost")
                  [] a = "failed" -> Answer(u, 503, "fail")
                  [] a = "maint" -> Answer(u, 503, "maint")
                  [] a = "not_yet" -> Answer(u, 503, "decided")
                  [] a = "200" -> Answer(u, 200, "decided")
                  [] a = "422" -> Answer(u, 422, "decided")
                  [] a = "500" -> Answer(u, 500, "decided")
                  [] OTHER -> Answer(u, 503, "decided")
             \* The 200 the route sends stands for a published upload, unless a restore since S10's commit rewound it.
             /\ IF a = "200" /\ ~Published(u, st[u]) /\ rt[u].rep.ra = ra THEN Flag("V1Answer") ELSE UNCHANGED err
             /\ ev' = ev \cup (IF a = "200" /\ rt[u].rep.ra # ra THEN {"W11"} ELSE {})
                         \cup (IF a # "200" /\ st[u].att = "done" /\ ~st[u].doomed THEN {"W5"} ELSE {})
             /\ UNCHANGED <<r2, runReq>>
          [] OTHER -> FALSE
  /\ UNCHANGED <<now, st, sg, bm, ra, dd, iv, nInv, orp, bud>>

\* The body's file part is stored in incoming/<id> (its multipart completion) before the staging time S1 gave, then
\* the text fields pass.
RouteWrite(u) ==
  /\ rt[u].pc = "stream" /\ RNow < rt[u].sx
  /\ r2' = [r2 EXCEPT ![u].inc = TRUE]
  /\ ToPc(u, "s3")
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, dd, iv, nInv, runReq, orp, bud, gh, err>>

\* The staging time runs out: the reader is cancelled and the route releases its staging (503).
RouteStageCut(u) ==
  /\ rt[u].pc = "stream" /\ RNow >= rt[u].sx
  /\ rt' = [rt EXCEPT ![u].pc = "s2", ![u].want = 503, ![u].tries = 0]
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, dd, iv, nInv, runReq, r2, orp, bud, gh, err>>

\* A body or a text field the route refuses (422): before the queue, the route releases its staging.
RouteBad(u) ==
  /\ bud.bad > 0
  /\ \/ rt[u].pc = "stream"
     \/ rt[u].pc = "s3" /\ rt[u].call = "none" /\ rt[u].rep.a = "none" /\ rt[u].tries = 0
  /\ rt' = [rt EXCEPT ![u].pc = "s2", ![u].want = 422, ![u].tries = 0]
  /\ bud' = [bud EXCEPT !.bad = 0]
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, dd, iv, nInv, runReq, r2, orp, gh, err>>

\* The v1 wait: S9 reads an outcome, or the route's cut (arrival + V1 - T_REPLY on its clock) arrives; either way the
\* route asks S10 for the decision.
RoutePoll(u) ==
  /\ rt[u].pc = "wait" /\ S9(st[u], now, ra) # "processing"
  /\ ToPc(u, "s10")
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, dd, iv, nInv, runReq, r2, orp, bud, gh, err>>

RouteCut(u) ==
  /\ rt[u].pc = "wait" /\ RNow >= rt[u].arr + V1 - T_REPLY
  /\ ToPc(u, "s10")
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, dd, iv, nInv, runReq, r2, orp, bud, gh, err>>

\* A v1 request answers by arrival + V1: a call still out is left to commit or not (W5).
RouteGiveUp(u) ==
  /\ rt[u].v1 /\ rt[u].pc \notin {"idle", "done", "dead"} /\ RNow >= rt[u].arr + V1
  /\ Answer(u, 503, "giveup")
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, dd, iv, nInv, runReq, r2, orp, bud, err>>

RouteDie(u) ==
  /\ bud.rdie > 0 /\ rt[u].pc \notin {"idle", "done", "dead"}
  /\ rt' = [rt EXCEPT ![u].pc = "dead", ![u].rep = NoRep]
  /\ bud' = [bud EXCEPT !.rdie = bud.rdie - 1]
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, dd, iv, nInv, runReq, r2, orp, gh, err>>

---------------------------------------------------------------------------
(* The owner of an upload whose id it was answered (v2's 202, v1's 200).   *)

OwnerDelete(u) ==
  /\ bud.del > 0 /\ rt[u].ans \in {200, 202}
  /\ LET res == S11(st[u], now, ra, Maint) IN
     /\ st' = [st EXCEPT ![u] = res.x]
     /\ gh' = [gh EXCEPT ![u].doomAt = IF res.a = "200" /\ gh[u].doomAt < 0 THEN now ELSE gh[u].doomAt]
     /\ err' = err \cup FreedEarly(st[u], res.x, FALSE)
  /\ bud' = [bud EXCEPT !.del = bud.del - 1]
  /\ UNCHANGED <<ev, now, sg, bm, ra, rt, dd, iv, nInv, runReq, r2, orp>>

\* GET of a completed upload shows its URL.
OwnerGet(u) ==
  /\ rt[u].ans \in {200, 202} /\ st[u].att = "done" /\ ~st[u].doomed /\ ~gh[u].tok
  /\ gh' = [gh EXCEPT ![u].tok = TRUE]
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, rt, dd, iv, nInv, runReq, r2, orp, bud, err>>

---------------------------------------------------------------------------
(* The processor u:<id>:<token>.                                           *)

\* D0 run(id, token, teardown_id): the record with the queue's teardown_id and an alarm for now in one storage
\* transaction; a record without an alarm (an alarm() before its D1) gets one; otherwise nothing.
DeliverRun(u) ==
  /\ runReq[u] /\ ~dd[u].gone
  /\ dd' = [dd EXCEPT ![u] = IF ~dd[u].rec THEN [dd[u] EXCEPT !.rec = TRUE, !.at = now, !.alarm = now, !.td = 1]
                             ELSE IF dd[u].alarm < 0 THEN [dd[u] EXCEPT !.alarm = now]
                             ELSE dd[u]]
  /\ runReq' = [runReq EXCEPT ![u] = FALSE]
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, rt, iv, nInv, r2, orp, bud, gh, err>>

LoseRun(u) ==
  /\ runReq[u] /\ P.loseRun /\ bud.loss > 0
  /\ runReq' = [runReq EXCEPT ![u] = FALSE]
  /\ bud' = [bud EXCEPT !.loss = bud.loss - 1]
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, rt, dd, iv, nInv, r2, orp, gh, err>>

Go(u, pc) == iv' = [iv EXCEPT ![u].pc = pc]
EndInv(u) == iv' = [iv EXCEPT ![u] = NoInv]

\* deleteAll(): the record, teardown_id and alarm. RecordDropSafe: only with the container stopped, and no live slot
\* of this teardown left behind a row that is not pending (slot is the slot after this step).
DeleteAll(u) ==
  /\ dd' = [dd EXCEPT ![u] = [dd[u] EXCEPT !.rec = FALSE, !.at = 0, !.alarm = -1, !.td = 0]]
  /\ EndInv(u)
DropFlags(u, slot, ps) ==
  IF dd[u].cont = "on" \/ (slot.td # 0 /\ slot.hu > now /\ ps # "pending") THEN {"RecordDropped"} ELSE {}

\* An alarm() begins (one at a time) and takes D1 at once: the record-age stop (W9), else the alarm for
\* CLEANUP_RETRY_MS set and confirmed before S4 (Codex r4 H3: one for TEARDOWN_MS would leave a job interrupted
\* before its start waiting past its deadline). The platform clears the alarm it runs and runs it again if the handler
\* dies before D1 (ATOMICITY), so a death there is this step not taken yet, and a run between the two finds no alarm
\* and sets one for now, which D1 replaces: the same states as taking the two as one step (Codex r1 CM6).
Fire(u) ==
  /\ dd[u].rec /\ ~dd[u].gone /\ dd[u].alarm >= 0 /\ dd[u].alarm <= now /\ iv[u].pc = "none" /\ nInv[u] < NINV
  /\ nInv' = [nInv EXCEPT ![u] = nInv[u] + 1]
  /\ IF now - dd[u].at >= (IF Variant = "ShortRecord" THEN 1 ELSE RECMAX) /\ dd[u].cont = "off"
     \* The record-age stop deletes the input too (D8): no later step of this object would (a completed upload's
     \* input is held by its row from the orphan pass and is no sweep's).
     THEN /\ DeleteAll(u)
          /\ err' = err \cup DropFlags(u, st[u].slot, st[u].ps)
          /\ r2' = [r2 EXCEPT ![u].inc = r2[u].inc /\ Variant = "AgedKeepsInput"]
          /\ ev' = ev \cup {"W9"}
     ELSE /\ dd' = [dd EXCEPT ![u].alarm = now + (IF Variant = "LongAlarm" THEN TEARDOWN ELSE RETRY)]
          /\ iv' = [iv EXCEPT ![u] = [NoInv EXCEPT !.pc = "s4", !.id = nInv[u] + 1, !.fired = now]]
          /\ UNCHANGED <<err, r2, ev>>
  /\ UNCHANGED <<now, st, sg, bm, ra, rt, runReq, orp, bud, gh>>

\* A processor Store call: the transaction with the flags it raises, then its reply or a lost reply (the invocation
\* repeats the call). replyFlags are those of what the reply leads to.
DOCall(u, res, flags, replyFlags(_), onReply(_)) ==
  /\ st' = [st EXCEPT ![u] = res.x]
  /\ \/ /\ onReply(res.a)
        /\ err' = err \cup flags \cup replyFlags(res.a)
        /\ UNCHANGED bud
     \/ /\ bud.loss > 0
        /\ bud' = [bud EXCEPT !.loss = bud.loss - 1]
        /\ err' = err \cup flags
        /\ UNCHANGED <<dd, iv, r2>>

\* DOCall for a call whose step sets r2 itself (DOS8).
DOCallR(u, res, flags, replyFlags(_), onReply(_)) ==
  /\ st' = [st EXCEPT ![u] = res.x]
  /\ \/ /\ onReply(res.a)
        /\ err' = err \cup flags \cup replyFlags(res.a)
        /\ UNCHANGED bud
     \/ /\ bud.loss > 0
        /\ bud' = [bud EXCEPT !.loss = bud.loss - 1]
        /\ err' = err \cup flags
        /\ UNCHANGED <<dd, iv>>

NoFlags(a) == {}

\* S4. started: the job is this invocation's, with its deadline from the remaining time S4 answers, counted on the
\* processor's clock (M2). settled or gone: cleanup only. maint: the invocation ends and D1's alarm repeats it; the
\* record stays, since a start or a teardown may have committed (Codex r4 H4); a container left running is stopped
\* first, or its slot renewed (DOClean), since the stop needs no Store write.
DOS4(u) ==
  /\ iv[u].pc = "s4"
  /\ LET res == S4(st[u], now, ra, Maint, iv[u].id)
         fresh == st[u].ps # "running" /\ res.x.ps = "running"
         drops(a) == IF a = "maint" /\ Variant = "MaintDropsRecord" /\ dd[u].cont = "off"
                     THEN DropFlags(u, st[u].slot, st[u].ps) ELSE {}
         reply(a) ==
           CASE a = "started" ->
                /\ iv' = [iv EXCEPT ![u].pc = "start",
                                    ![u].dl = IF Variant = "AbsStart" THEN res.x.dl ELSE now + P.skd + (res.x.dl - now),
                                    ![u].sdl = res.x.dl]
                /\ UNCHANGED <<dd, r2>>
             [] a = "maint" ->
                /\ IF dd[u].cont = "on" THEN iv' = [iv EXCEPT ![u].pc = "clean", ![u].out = "maint"] /\ UNCHANGED dd
                   ELSE IF Variant = "MaintDropsRecord" THEN DeleteAll(u)
                   ELSE /\ EndInv(u)
                        /\ IF Variant = "MaintNoRetry" THEN dd' = [dd EXCEPT ![u].alarm = -1] ELSE UNCHANGED dd
                /\ UNCHANGED r2
             [] OTHER -> Go(u, "clean") /\ UNCHANGED <<dd, r2>>
     IN /\ DOCall(u, res, IF fresh /\ IsFenced(u) THEN {"RestoredActs"} ELSE {}, drops, reply)
        /\ Ev("H3", fresh /\ iv[u].id > 1)
        \* The first start, in the transaction whatever becomes of its reply.
        /\ gh' = [gh EXCEPT ![u].s4At = IF gh[u].s4At < 0 /\ fresh THEN now ELSE gh[u].s4At]
  /\ UNCHANGED <<now, sg, bm, ra, rt, nInv, runReq, orp>>

\* D3's container start, which StartNeedsSlot guards: only before the job's deadline on the processor's clock (a stage
\* cut, else S7 timeout).
DOStart(u) ==
  /\ iv[u].pc = "start"
  /\ IF now + P.skd < iv[u].dl
     THEN /\ dd' = [dd EXCEPT ![u].cont = "on"]
          /\ Go(u, "work")
          /\ IF (Live(st, u, now) /\ st[u].slot.ph = "processing" /\ now < iv[u].sdl) \/ W3(u)
             THEN UNCHANGED err ELSE Flag("StartWithoutSlot")
     ELSE /\ iv' = [iv EXCEPT ![u].pc = "s7", ![u].out = "timeout"] /\ UNCHANGED <<dd, err>>
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, rt, nInv, runReq, r2, orp, bud, gh>>

\* D3 and D4: the input read once, the outcome, then the stop. A confirmed stop goes on to the writes (or S7); one
\* that is not confirmed fails the job unavailable and ends the invocation after S7, the container left for the
\* alarm's cleanup replay.
DOWork(u) ==
  /\ iv[u].pc = "work"
  /\ \E out \in (IF r2[u].inc THEN (IF P.fails THEN {"ok", "refused"} ELSE {"ok"}) ELSE {"unavailable"}) :
       \/ /\ dd' = [dd EXCEPT ![u].cont = "off"]
          /\ iv' = [iv EXCEPT ![u].pc = IF out = "ok" THEN "g" ELSE "s7", ![u].out = out, ![u].k = 1]
          /\ UNCHANGED bud
       \/ /\ bud.dfail > 0
          /\ iv' = [iv EXCEPT ![u].pc = "s7f", ![u].out = "unavailable"]
          /\ bud' = [bud EXCEPT !.dfail = bud.dfail - 1]
          /\ UNCHANGED dd
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, rt, nInv, runReq, r2, orp, gh, err>>

\* D6: S5 before each final write; the grant is a duration counted from the processor's reading before the call.
DOGrant(u) ==
  /\ iv[u].pc = "g"
  /\ LET res == S5(st[u], now, ra, Maint, iv[u].id)
         reply(a) ==
           /\ IF a = "grant"
              THEN iv' = [iv EXCEPT ![u].pc = "p", ![u].gat = now, ![u].gg = res.g,
                                    ![u].gexp = IF Variant = "AbsGrant" THEN now + res.g ELSE now + P.skd + res.g,
                                    ![u].pre = gh[u].doomAt < 0, ![u].pa = rt[u].ans = 0]
              ELSE iv' = [iv EXCEPT ![u].pc = "s7", ![u].out = IF a = "maint" THEN "unavailable" ELSE "timeout"]
           /\ UNCHANGED <<dd, r2>>
     IN DOCall(u, res, IF res.a = "grant" /\ IsFenced(u) THEN {"RestoredActs"} ELSE {}, NoFlags, reply)
  /\ UNCHANGED <<ev, now, sg, bm, ra, rt, nInv, runReq, orp, gh>>

\* The write starts while the grant lasts on the processor's clock, else S5 is asked again. ga: the grant's Store time.
DOPut(u) ==
  /\ iv[u].pc = "p"
  /\ IF now + P.skd < iv[u].gexp
     THEN /\ r2' = [r2 EXCEPT ![u].fly = r2[u].fly \cup {[k |-> iv[u].k, st |-> now, pre |-> iv[u].pre, pa |-> iv[u].pa,
                                                          ga |-> iv[u].gat]}]
          /\ iv' = [iv EXCEPT ![u].pc = "a", ![u].gexp = 0, ![u].gat = 0, ![u].gg = 0, ![u].pre = TRUE, ![u].pa = TRUE]
          /\ IF now < iv[u].gat + iv[u].gg THEN UNCHANGED err ELSE Flag("GrantOverrun")
     ELSE Go(u, "g") /\ UNCHANGED <<r2, err>>
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, rt, dd, nInv, runReq, orp, bud, gh>>

\* The write's success. CompleteBeforeLanding completes the upload as soon as the last write starts.
DOAck(u) ==
  /\ \/ iv[u].pc = "a" /\ iv[u].k \in r2[u].obj
     \/ iv[u].pc = "a" /\ Variant = "CompleteBeforeLanding" /\ iv[u].k = P.nw
  /\ iv' = [iv EXCEPT ![u].pc = IF iv[u].k < P.nw THEN "g" ELSE "s6", ![u].k = iv[u].k + 1]
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, rt, dd, nInv, runReq, r2, orp, bud, gh, err>>

\* The write answers an error; it may still land (R2Land).
DOPutErr(u) ==
  /\ iv[u].pc = "a" /\ bud.perr > 0
  /\ iv' = [iv EXCEPT ![u].pc = "s7", ![u].out = "unavailable"]
  /\ bud' = [bud EXCEPT !.perr = bud.perr - 1]
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, rt, dd, nInv, runReq, r2, orp, gh, err>>

\* D7: S6. Its flags are the transaction's, whatever becomes of its reply (Gemini r1 GH3).
DOS6(u) ==
  /\ iv[u].pc = "s6"
  /\ LET res == S6(st[u], now, ra, Maint, iv[u].id)
         fresh == res.a = "done" /\ st[u].att # "done"
         flags == {f \in {"PublishAfterDelete", "PublishAfterNon200", "RestoredActs"} :
                     \/ f = "PublishAfterDelete" /\ fresh /\ gh[u].doomAt >= 0
                     \/ f = "PublishAfterNon200" /\ fresh /\ Non200(u)
                     \/ f = "RestoredActs" /\ fresh /\ IsFenced(u)}
         reply(a) ==
           /\ IF a = "maint" THEN EndInv(u) ELSE Go(u, "s8")
           /\ UNCHANGED <<dd, r2>>
     IN /\ DOCall(u, res, flags, NoFlags, reply)
        /\ Ev("W5", fresh /\ rt[u].v1 /\ rt[u].ans = 503)
  /\ UNCHANGED <<now, sg, bm, ra, rt, nInv, runReq, orp, gh>>

\* D7: S7 with the job's cause. After a stop that was not confirmed the invocation ends there (s7f).
DOS7(u) ==
  /\ iv[u].pc \in {"s7", "s7f"}
  /\ LET res == S7(st[u], now, ra, Maint, iv[u].id, iv[u].out)
         reply(a) ==
           /\ IF a = "maint" \/ iv[u].pc = "s7f" THEN EndInv(u) ELSE Go(u, "s8")
           /\ UNCHANGED <<dd, r2>>
     IN DOCall(u, res, {}, NoFlags, reply)
  /\ UNCHANGED <<ev, now, sg, bm, ra, rt, nInv, runReq, orp, gh>>

\* D8 and D9: incoming/<id> deleted (the processor's own from the queue's commit), then S8 with the record's
\* teardown_id; released (or, with ReleaseK3Stops, settled) ends in deleteAll; held and maint end the invocation, whose
\* alarm repeats it. S8 may remove the slot only with the container stopped and no pending row left (SlotRelease).
\* D8 is done whatever becomes of S8's reply; a death between the two is a death before both, since deleting the key
\* again is idempotent and nothing else waits on it (Codex r1 CM6).
DOS8(u) ==
  /\ iv[u].pc = "s8"
  /\ LET res == S8(st[u], now, ra, Maint, dd[u].td)
         drops(a) == IF a \in {"released", "settled"} THEN DropFlags(u, res.x.slot, res.x.ps) ELSE {}
         reply(a) == IF a \in {"released", "settled"} THEN DeleteAll(u) ELSE EndInv(u) /\ UNCHANGED dd
     IN /\ DOCallR(u, res, FreedEarly(st[u], res.x, dd[u].cont = "off" /\ res.x.ps # "pending"), drops, reply)
        /\ r2' = [r2 EXCEPT ![u].inc = FALSE]
  /\ UNCHANGED <<ev, now, sg, bm, ra, rt, nInv, runReq, orp, gh>>

\* The cleanup replay of an invocation whose S4 was not started: the container stopped (D4's rule), then D8 and D9 (in
\* maintenance, the invocation ends there). A stop that is not confirmed renews the slot (S14, D3) and ends the
\* invocation, whose alarm repeats it.
DOClean(u) ==
  /\ iv[u].pc = "clean"
  /\ IF dd[u].cont = "on"
     THEN \/ /\ dd' = [dd EXCEPT ![u].cont = "off"]
             /\ IF iv[u].out = "maint" THEN EndInv(u) ELSE Go(u, "s8")
             /\ UNCHANGED bud
          \/ /\ bud.dfail > 0
             /\ bud' = [bud EXCEPT !.dfail = bud.dfail - 1]
             /\ IF Variant = "StopNoRetry"
                THEN dd' = [dd EXCEPT ![u].alarm = -1] /\ EndInv(u)
                ELSE Go(u, "renew") /\ UNCHANGED dd
     ELSE Go(u, "s8") /\ UNCHANGED <<dd, bud>>
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, rt, nInv, runReq, r2, orp, gh, err>>

DORenew(u) ==
  /\ iv[u].pc = "renew"
  /\ LET reply(a) == EndInv(u) /\ UNCHANGED <<dd, r2>> IN DOCall(u, S14(st[u], now, dd[u].td), {}, NoFlags, reply)
  /\ UNCHANGED <<ev, now, sg, bm, ra, rt, nInv, runReq, orp, gh>>

\* An invocation dies; its D1 alarm runs it again.
EndByDeath(u) ==
  /\ EndInv(u)
  /\ UNCHANGED dd

DOKill(u) ==
  /\ iv[u].pc # "none" /\ bud.kill > 0
  /\ EndByDeath(u)
  /\ bud' = [bud EXCEPT !.kill = bud.kill - 1]
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, rt, nInv, runReq, r2, orp, gh, err>>

\* The platform ends an alarm() at its wall limit, TEARDOWN_MS after it began.
WallKill(u) ==
  /\ iv[u].pc # "none" /\ now + 1 >= iv[u].fired + TEARDOWN
  /\ EndByDeath(u)
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, rt, nInv, runReq, r2, orp, bud, gh, err>>

\* The processor stops for good with its container running (W10): no alarm or request runs again.
DOGone(u) ==
  /\ bud.gone > 0 /\ dd[u].cont = "on" /\ ~dd[u].gone
  /\ dd' = [dd EXCEPT ![u].gone = TRUE]
  /\ EndInv(u)
  /\ bud' = [bud EXCEPT !.gone = bud.gone - 1]
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, rt, nInv, runReq, r2, orp, gh, err>>

---------------------------------------------------------------------------
(* R2: a write in flight lands, or never does once no one waits for it.    *)

R2Land(u) ==
  /\ \E w \in r2[u].fly :
       /\ r2' = [r2 EXCEPT ![u].obj = r2[u].obj \cup {w.k}, ![u].fly = r2[u].fly \ {w}]
       /\ err' = err \cup {f \in {"PublishAfterDelete", "GrantGround", "PublishAfterNon200", "LateObject"} :
                             \/ f = "PublishAfterDelete" /\ gh[u].doomAt >= 0 /\ ~w.pre
                             \/ f = "GrantGround" /\ gh[u].doomAt >= 0 /\ gh[u].tok
                             \/ f = "PublishAfterNon200" /\ Non200(u) /\ ~w.pa
                             \/ f = "LateObject" /\ gh[u].ret}
       \* W1 after DELETE, and after a restore on a grant issued before it (D4).
       /\ ev' = ev \cup (IF gh[u].doomAt >= 0 THEN {"W1"} ELSE {}) \cup (IF ra >= w.ga THEN {"W1R"} ELSE {})
  /\ UNCHANGED <<now, st, sg, bm, ra, rt, dd, iv, nInv, runReq, orp, bud, gh>>

R2Drop(u) ==
  /\ \E w \in r2[u].fly :
       /\ ~(iv[u].pc = "a" /\ iv[u].k = w.k)
       /\ r2' = [r2 EXCEPT ![u].fly = r2[u].fly \ {w}]
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, rt, dd, iv, nInv, runReq, orp, bud, gh, err>>

---------------------------------------------------------------------------
(* The cron.                                                               *)

\* S12 and S13 for one upload, when they change something; "run" is the redispatch. It removes a processing slot only
\* at its held_until (SlotRelease).
Dispatch(u) ==
  /\ ~Maint
  /\ LET res == S12(st[u], now, ra) IN
     /\ res.x # st[u] \/ res.a = "run"
     /\ st' = [st EXCEPT ![u] = res.x]
     /\ runReq' = [runReq EXCEPT ![u] = runReq[u] \/ res.a = "run"]
     /\ gh' = [gh EXCEPT ![u].k3 = K3By(u, "round")]
     /\ err' = err \cup FreedEarly(st[u], res.x, st[u].slot.hu <= now)
  /\ UNCHANGED <<ev, now, sg, bm, ra, rt, dd, iv, nInv, r2, orp, bud>>

\* What the sweep takes: a doomed upload, an unfinished one at its gc_at, and a completed unattached one at the gc_at
\* completion gave it (W5's bound, D2), unless its owner attached it (kept).
Sweepable(u, x, t) ==
  \/ x.att \in {"res", "done"} /\ x.doomed
  \/ x.att = "res" /\ t >= x.resAt + GC
  \/ /\ x.att = "done" /\ t >= x.gcAt /\ Variant # "DoneNeverSwept"
     /\ ~(P.kept /\ rt[u].ans \in {200, 202})

\* The sweep, with the upload's keys (mediaKeys includes incoming/<id>); its processing row cascades, its slot does
\* not.
Sweep(u) ==
  /\ P.gc /\ ~Maint /\ Sweepable(u, st[u], now)
  /\ st' = [st EXCEPT ![u] = [RowNone(st[u]) EXCEPT !.att = "gone"]]
  /\ r2' = [r2 EXCEPT ![u].inc = r2[u].inc /\ Variant = "SweepNoIncoming", ![u].obj = {}]
  /\ IF TakesInput(u) /\ Variant # "SweepNoIncoming" THEN Flag("InputTaken") ELSE UNCHANGED err
  /\ UNCHANGED <<ev, now, sg, bm, ra, rt, dd, iv, nInv, runReq, orp, bud, gh>>

\* Reconciliation deletes the keys of a tombstone again.
Reconcile(u) ==
  /\ P.gc /\ ~Maint /\ st[u].att = "gone"
  /\ r2[u].obj # {} \/ (r2[u].inc /\ Variant # "SweepNoIncoming")
  /\ r2' = [r2 EXCEPT ![u].inc = r2[u].inc /\ Variant = "SweepNoIncoming", ![u].obj = {}]
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, rt, dd, iv, nInv, runReq, orp, bud, gh, err>>

\* The tombstone is retired, with a last deletion of the keys, RETIRE after the reservation: past every write cut
\* (deadline_at <= the reservation + AV_WRITE_WINDOW_MS) plus the time a started write takes to land (M3).
Retire(u) ==
  /\ P.gc /\ ~Maint /\ st[u].att = "gone"
  /\ now >= st[u].resAt + (IF Variant = "EarlyRetire" THEN WW ELSE RETIRE)
  /\ st' = [st EXCEPT ![u] = [Fresh EXCEPT !.slot = st[u].slot]]
  /\ r2' = [r2 EXCEPT ![u].inc = r2[u].inc /\ Variant = "SweepNoIncoming", ![u].obj = {}]
  /\ gh' = [gh EXCEPT ![u].ret = TRUE]
  /\ UNCHANGED <<ev, now, sg, bm, ra, rt, dd, iv, nInv, runReq, orp, bud, err>>

\* incomingOrphans: the claim records its time in the Store; the classify reads, under an exact and post-restore
\* claim, the incoming keys no attachment row holds; the delete follows. The cursor, the checkpoint and overlapping
\* claims are abstracted: a page is every key and one pass runs at a time (README, "What the model abstracts").
Held(v) == st[v].att # "none" /\ (Variant # "OrphanStagingUnheld" \/ st[v].ps # "staging")

\* At most one claim a time unit (the pass's hour, ORPHAN_SWEEP_MS).
OClaim ==
  /\ P.orphan /\ ~Maint /\ orp.pc = "none" /\ sg.oc < now
  /\ sg' = [sg EXCEPT !.oc = now]
  /\ orp' = [pc |-> "claimed", c |-> now, keys |-> {}]
  /\ UNCHANGED <<ev, now, st, bm, ra, rt, dd, iv, nInv, runReq, r2, bud, gh, err>>

OClassify ==
  /\ orp.pc = "claimed" /\ ~Maint
  /\ orp' = IF sg.oc # orp.c \/ orp.c <= ra THEN [pc |-> "none", c |-> 0, keys |-> {}]
            ELSE [orp EXCEPT !.pc = "classified", !.keys = {v \in U : r2[v].inc /\ ~Held(v)}]
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, rt, dd, iv, nInv, runReq, r2, bud, gh, err>>

\* W4: a key classified unheld is held again, by a row a restore brought back, when it is deleted.
ODelete ==
  /\ orp.pc = "classified"
  /\ r2' = [v \in U |-> IF v \in orp.keys THEN [r2[v] EXCEPT !.inc = FALSE] ELSE r2[v]]
  /\ orp' = [pc |-> "none", c |-> 0, keys |-> {}]
  /\ IF \E v \in orp.keys : TakesInput(v) THEN Flag("InputTaken") ELSE UNCHANGED err
  /\ Ev("W4", \E v \in orp.keys : r2[v].inc /\ Held(v))
  /\ UNCHANGED <<now, st, sg, bm, ra, rt, dd, iv, nInv, runReq, bud, gh>>

---------------------------------------------------------------------------
(* The operator.                                                           *)

MaintOn ==
  /\ bud.mOn > 0 /\ ~Maint
  /\ sg' = [sg EXCEPT !.maint = TRUE]
  /\ bud' = [bud EXCEPT !.mOn = bud.mOn - 1]
  /\ UNCHANGED <<ev, now, st, bm, ra, rt, dd, iv, nInv, runReq, r2, orp, gh, err>>

MaintOff ==
  /\ Maint
  /\ sg' = [sg EXCEPT !.maint = FALSE]
  /\ UNCHANGED <<ev, now, st, bm, ra, rt, dd, iv, nInv, runReq, r2, orp, bud, gh, err>>

Bookmark ==
  /\ bud.bm > 0
  /\ bm' = [bm EXCEPT ![P.bm - bud.bm + 1] = [has |-> TRUE, st |-> st, sg |-> sg]]
  /\ bud' = [bud EXCEPT !.bm = bud.bm - 1]
  /\ UNCHANGED <<ev, now, st, sg, ra, rt, dd, iv, nInv, runReq, r2, orp, gh, err>>

\* A restore to any bookmark taken. It sets W3 for a job started before it whose processing slot the bookmark lacks
\* or holds past its held_until.
Restore ==
  /\ bud.rs > 0
  /\ \E i \in DOMAIN bm :
       /\ bm[i].has
       /\ st' = bm[i].st /\ sg' = bm[i].sg /\ ra' = now
       /\ gh' = [u \in U |-> [gh[u] EXCEPT !.w3 = gh[u].w3 \/ (gh[u].s4At >= 0
                                                  /\ ~(bm[i].st[u].slot.ph = "processing" /\ bm[i].st[u].slot.hu > now))]]
  /\ bud' = [bud EXCEPT !.rs = bud.rs - 1]
  \* Bookmarks no later restore can use are forgotten (a bound of the model).
  /\ bm' = IF bud.rs = 1 /\ bud.bm = 0 THEN [i \in DOMAIN bm |-> NoBm] ELSE bm
  /\ UNCHANGED <<ev, now, rt, dd, iv, nInv, runReq, r2, orp, err>>

Revoke ==
  /\ bud.rev > 0 /\ sg.active
  /\ sg' = [sg EXCEPT !.active = FALSE]
  /\ bud' = [bud EXCEPT !.rev = bud.rev - 1]
  /\ UNCHANGED <<ev, now, st, bm, ra, rt, dd, iv, nInv, runReq, r2, orp, gh, err>>

---------------------------------------------------------------------------
(* The clock.                                                              *)

FireDue(u) == dd[u].rec /\ ~dd[u].gone /\ dd[u].alarm >= 0 /\ dd[u].alarm <= now /\ nInv[u] < NINV
\* A step that can be taken now, by kind of actor (LIVENESS, and the prompt actors of a scenario: the clock waits for
\* them).
DueDO(u) ==
  \/ iv[u].pc # "none"
  \/ FireDue(u)
  \/ runReq[u] /\ ~dd[u].gone
DueRoute(u) ==
  \/ rt[u].call # "none" \/ rt[u].rep.a # "none"
  \/ rt[u].pc \in {"s1", "stream", "s2", "s3", "s10"}
  \/ rt[u].pc = "wait" /\ (S9(st[u], now, ra) # "processing" \/ RNow >= rt[u].arr + V1 - T_REPLY)
  \/ rt[u].pc = "idle" /\ now <= P.arr /\ (u \in P.late => now >= P.lateAt)
DueCron(u) ==
  \/ ~Maint /\ (S12(st[u], now, ra).x # st[u] \/ S12(st[u], now, ra).a = "run")
  \/ P.gc /\ ~Maint /\ Sweepable(u, st[u], now)
  \/ P.gc /\ ~Maint /\ st[u].att = "gone" /\ (r2[u].obj # {} \/ r2[u].inc)
\* A live processor whose container runs takes its due alarm, and its replay's stop or renewal, before the clock
\* moves (TIME).
DueRenew(u) ==
  dd[u].cont = "on" /\ ~dd[u].gone /\ (FireDue(u) \/ iv[u].pc \in {"s4", "clean", "renew"})
Due(u) ==
  \/ "do" \in P.prompt /\ DueDO(u)
  \/ "route" \in P.prompt /\ DueRoute(u)
  \/ "cron" \in P.prompt /\ DueCron(u)
  \/ DueRenew(u)

Tick ==
  /\ now < P.tmax
  /\ \A u \in U : rt[u].v1 /\ rt[u].pc \notin {"idle", "done", "dead"} => RNow < rt[u].arr + V1
  /\ \A u \in U : \A w \in r2[u].fly : now < w.st + LAND
  \* An alarm() ends by its wall limit, and the container answers by the job's deadline (its work deadline).
  /\ \A u \in U : iv[u].pc # "none" => now + 1 < iv[u].fired + TEARDOWN
  /\ \A u \in U : iv[u].pc = "work" => now + P.skd + 1 < iv[u].dl
  /\ ~(\E u \in U : Due(u))
  /\ "cron" \in P.prompt => orp.pc = "none"
  /\ now' = now + 1
  /\ UNCHANGED <<st, sg, bm, ra, rt, dd, iv, nInv, runReq, r2, orp, bud, gh, err, ev>>

---------------------------------------------------------------------------

RouteStep(u) ==
  \/ RouteArrive(u) \/ RouteSend(u) \/ RouteExec(u) \/ RouteReact(u) \/ RouteWrite(u) \/ RouteStageCut(u)
  \/ RoutePoll(u) \/ RouteCut(u) \/ RouteGiveUp(u)

DOStep(u) ==
  \/ DeliverRun(u) \/ Fire(u) \/ DOS4(u) \/ DOStart(u) \/ DOWork(u) \/ DOGrant(u) \/ DOPut(u) \/ DOAck(u)
  \/ DOS6(u) \/ DOS7(u) \/ DOS8(u) \/ DOClean(u) \/ DORenew(u)

CronStep(u) == Dispatch(u) \/ Sweep(u) \/ Reconcile(u) \/ Retire(u)

Faults(u) ==
  \/ RouteBad(u) \/ RouteDie(u) \/ OwnerDelete(u) \/ OwnerGet(u) \/ LoseRun(u) \/ DOPutErr(u) \/ DOKill(u)
  \/ WallKill(u) \/ DOGone(u) \/ R2Drop(u)

Next ==
  \/ \E u \in U : RouteStep(u) \/ DOStep(u) \/ CronStep(u) \/ R2Land(u) \/ Faults(u)
  \/ OClaim \/ OClassify \/ ODelete
  \/ MaintOn \/ MaintOff \/ Bookmark \/ Restore \/ Revoke
  \/ Tick

Spec == Init /\ [][Next]_vars

LSpec ==
  /\ Spec
  /\ \A u \in U : WF_vars(RouteStep(u)) /\ WF_vars(DOStep(u)) /\ WF_vars(CronStep(u)) /\ WF_vars(R2Land(u))
  /\ WF_vars(OClaim \/ OClassify \/ ODelete)
  /\ WF_vars(MaintOff)
  /\ WF_vars(Tick)

---------------------------------------------------------------------------
(* Safety.                                                                 *)

Running == {u \in U : dd[u].cont = "on"}
Excused == {u \in Running : W3(u) \/ W10(u)}

SlotBound == Cardinality({u \in U : Live(st, u, now)}) <= MaxInflight
ContainerCovered == \A u \in Running : Live(st, u, now) \/ W3(u) \/ W10(u)
MaxContainers == Cardinality(Running) <= MaxInflight + Cardinality(Excused)
StartNeedsSlot == "StartWithoutSlot" \notin err
SlotRelease == "SlotFreedEarly" \notin err
RouteDeleteAuthority == "RouteDeleteNoAuthority" \notin err
InputKept == "InputTaken" \notin err
NoPublishAfterDelete == "PublishAfterDelete" \notin err
NoPublishAfterNon200 == "PublishAfterNon200" \notin err
GrantBound == "GrantOverrun" \notin err
GrantGround == "GrantGround" \notin err
V1Answer == "V1Answer" \notin err
ChargeOnce == \A u \in U : st[u].chg <= 1
RestoredInert == "RestoredActs" \notin err
Q4 == "Q4" \notin err
RecordDropSafe == "RecordDropped" \notin err
SingleStaging == "Restaged" \notin err
NoLateObject == "LateObject" \notin err /\ \A u \in U : gh[u].ret => r2[u].obj = {} /\ r2[u].fly = {}

---------------------------------------------------------------------------
(* Liveness (LSpec).                                                       *)

SlotsReleased == <>[](\A u \in U : st[u].slot.ph = "none")
RecordsCleared == <>[](\A u \in U : ~dd[u].rec)
InputsDeleted == <>[](\A u \in U : ~r2[u].inc)
ContainersStopped == <>[](\A u \in U : dd[u].cont = "off")
CompletedSwept == \A u \in U : W5Row(u) ~> ~W5Row(u)
PendingRoom(u) ==
  st[u].ps = "pending" /\ st[u].dl - now >= ROOM /\ ~IsFenced(u) /\ ~Maint /\ gh[u].doomAt < 0
\* The start's invocation died, its reply or its container start not taken (the start rule: no other invocation
\* starts it).
StartLost(u) == st[u].ps = "running" /\ iv[u].pc = "none" /\ dd[u].cont = "off"
PendingStarts ==
  \A u \in U :
    PendingRoom(u) ~> (dd[u].cont = "on" \/ StartLost(u) \/ ra >= rt[u].arr - P.skr \/ gh[u].doomAt >= 0 \/ Maint)

=============================================================================
