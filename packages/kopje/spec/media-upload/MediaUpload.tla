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
(*    step; the route keeps no other key.                                  *)
(*  - The processor: its durable storage (dd: the record with teardown_id, *)
(*    the alarm, and its container's state) and one alarm() invocation at  *)
(*    a time (iv), whose memory a kill drops at any step. A `run` request  *)
(*    (D0) is one storage transaction and may overlap an invocation. Its   *)
(*    Store calls are one step each (the call and its transaction; the     *)
(*    reply may be lost, and the invocation repeats the call). A due alarm *)
(*    stays due until the invocation replaces it (D1): Cloudflare retries  *)
(*    an alarm whose handler did not return [docs for a throw, assumed for *)
(*    an eviction], so D1 is part of the alarm's entry (Fire). An          *)
(*    invocation ends by its wall limit TEARDOWN (WallKill), and the       *)
(*    container answers by the job's deadline.                             *)
(*  - R2: an incoming key per upload, the objects of the final writes, and *)
(*    the writes in flight, each landing (or never landing) at most LAND   *)
(*    after it started, whatever its writer does meanwhile.                *)
(*  - The cron: S12/S13 per row, the sweep, reconciliation, the tombstone  *)
(*    retirement, and the incomingOrphans pass (claim, classify, delete    *)
(*    and checkpoint).                                                     *)
(*  - The operator: maintenance, bookmarks and restores (st and sg back to *)
(*    the bookmark, the restore marker ra = now, which the Store reads as  *)
(*    restoredAt; DO storage, R2, containers and requests are not rewound) *)
(*    and revoking the probe verdict.                                      *)
(*  - The owner: DELETE and GET of an upload whose id it was answered.     *)
(*                                                                         *)
(* TIME. One clock `now`, in abstract units (MediaUploadStore.tla's        *)
(* constants). The route and the processor read it with fixed offsets;     *)
(* only durations cross a clock boundary (S1's v1Left, S1's staging time,  *)
(* S4's remaining time, S5's grant), each measured from a reading taken    *)
(* before the call, so an offset cancels and a late reply only shortens   *)
(* what it grants (skd is the processor's offset; variant AbsGrant         *)
(* compares an absolute Store time on the processor's clock instead). A v1 *)
(* request answers no later than arrival + V1 on its own clock, and an R2 *)
(* write resolves within LAND: the clock does not move past either.        *)
(*                                                                         *)
(* SAFETY (each a named invariant; checks.json gives its mutation):        *)
(*  SlotBound          live slots (held_until in the future) never exceed  *)
(*                     MAX_AV_INFLIGHT (design 4.5 "Capacity").             *)
(*  ContainerCovered   a running container has its upload's live slot,     *)
(*                     except W3 (a restore since its start) and W10        *)
(*                     (TEARDOWN past its deadline, the held_until the      *)
(*                     queue gave its slot, with its stop not confirmed).   *)
(*  MaxContainers      at most MAX_AV_INFLIGHT containers run outside       *)
(*                     those two windows.                                   *)
(*  StartNeedsSlot     a container starts only with a live processing slot *)
(*                     (W3 excepted).                                       *)
(*  SlotRelease        a slot is removed only by staging cleanup before    *)
(*                     the queue, by S8 after the stop is confirmed, or at  *)
(*                     held_until; never while a pending row needs it       *)
(*                     (C2-H2, GM3, GH1).                                   *)
(*  RouteDeleteAuthority  the route deletes incoming/<id> only on S2's      *)
(*                     released or S3's refused_cleanup_yours, never after  *)
(*                     a queue commit a restore has not fenced (C1, C2-H3,  *)
(*                     Gemini r4 GH3).                                      *)
(*  InputKept          no one but its owner deletes the input of a live    *)
(*                     unfenced row (W4 is the fenced case).                *)
(*  NoPublishAfterDelete  no completion after DELETE, and a write lands     *)
(*                     after it only on a grant issued before it (W1).      *)
(*  NoPublishAfterNon200  after a decided v1 answer other than 200, no      *)
(*                     completion, and a write lands only on a grant issued *)
(*                     before the answer (W1); a 503 the Store did not      *)
(*                     decide (a lost or failed S10, the route's give-up,   *)
(*                     maintenance) is W5 (Codex r4 H1, M5).                *)
(*  GrantBound         a write starts before its grant's Store time plus    *)
(*                     the grant (W1's bound, C7, M3).                      *)
(*  GrantGround        a write lands after DELETE only while the upload's   *)
(*                     URL was never issued (W1's ground, M3).              *)
(*  V1Answer           a 200 is answered only for a completed, undoomed     *)
(*                     upload whose writes have all landed.                 *)
(*  ChargeOnce         one charge per upload (RES-6, H3, GH1).              *)
(*  RestoredInert      a row reserved before the last restore never starts, *)
(*                     is granted a write or completes (C3, G5, model 5).   *)
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
(* clock moves only when no step can be taken now):                        *)
(*  SlotsReleased, RecordsCleared, InputsDeleted, ContainersStopped, and   *)
(*  PendingStarts: a pending row with at least DISPATCH + MINENC left      *)
(*  starts, after a kill before its start or a lost run (Codex r4 H3, W7). *)
(***************************************************************************)
EXTENDS Integers, FiniteSets, MediaUploadStore

RETRY == 1 \* CLEANUP_RETRY_MS: D1's alarm, before S4
RECMAX == V2P + TEARDOWN \* D1's record-age stop (W9), on the processor's clock
NINV == 6 \* invocations per upload in one behaviour (a bound of the model)
ROOM == DISPATCH + MINENC

\* ev: the windows and orders a behaviour has gone through (MediaUploadGoals.tla), a ghost no step reads.
VARIABLES now, st, sg, bm, ra, rt, dd, iv, nInv, runReq, r2, orp, bud, gh, err, ev

vars == <<now, st, sg, bm, ra, rt, dd, iv, nInv, runReq, r2, orp, bud, gh, err, ev>>

NoRep == [a |-> "none", sAt |-> 0, dur |-> 0]
NoInv == [pc |-> "none", id |-> 0, fired |-> 0, dl |-> 0, k |-> 0, gexp |-> 0, gat |-> 0, gg |-> 0, pre |-> TRUE,
          pa |-> TRUE, out |-> "ok"]

Init ==
  /\ now = 0
  /\ st = [u \in U |-> Fresh]
  /\ sg = [active |-> TRUE, maint |-> FALSE, oc |-> -1]
  /\ bm = [has |-> FALSE, st |-> st, sg |-> sg]
  /\ ra = -1
  /\ rt = [u \in U |-> [pc |-> "idle", v1 |-> u \in P.v1, arr |-> 0, call |-> "none", sent |-> 0, left |-> 0, sAt |-> 0,
                        sx |-> 0, rep |-> NoRep, tries |-> 0, ans |-> 0, kind |-> "none", want |-> 0]]
  /\ dd = [u \in U |-> [rec |-> FALSE, at |-> 0, alarm |-> -1, cont |-> "off"]]
  /\ iv = [u \in U |-> NoInv]
  /\ nInv = [u \in U |-> 0]
  /\ runReq = [u \in U |-> FALSE]
  /\ r2 = [u \in U |-> [inc |-> FALSE, obj |-> {}, fly |-> {}]]
  /\ orp = [pc |-> "none", c |-> 0, keys |-> {}]
  /\ bud = [loss |-> P.loss, kill |-> P.kill, dfail |-> P.dfail, perr |-> P.perr, rdie |-> P.rdie, del |-> P.del,
            mOn |-> P.mOn, bm |-> P.bm, rs |-> P.rs, rev |-> P.rev, bad |-> IF P.bad THEN 1 ELSE 0]
  /\ gh = [u \in U |-> [chg |-> 0, doomAt |-> -1, tok |-> FALSE, q |-> FALSE, s4At |-> -1, hu |-> 0, take |-> -1,
                        ret |-> FALSE, k3 |-> ""]]
  /\ err = {}
  /\ ev = {}

Maint == sg.maint
IsFenced(u) == Fenced(st[u], ra)
\* W3: a restore at or after the job's start (its slot may be gone with the rewound Store).
W3(u) == gh[u].s4At >= 0 /\ ra >= gh[u].s4At
\* W10: TEARDOWN_MS has passed since the job's deadline, the held_until the queue gives its slot.
W10(u) == gh[u].hu > 0 /\ now >= gh[u].hu
\* A v1 answer the Store decided, other than 200.
Non200(u) == rt[u].v1 /\ rt[u].ans \notin {0, 200} /\ rt[u].kind = "decided"
\* A row whose input someone still needs: staging before its staged_until, pending or running.
LiveRow(x, t) == ((x.ps = "staging" /\ t < x.sUntil) \/ x.ps \in {"pending", "running"}) /\ ~x.doomed

Ev(name, cond) == ev' = IF cond THEN ev \cup {name} ELSE ev

Flag(name) == err' = err \cup {name}
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
  /\ rt[u].pc = "idle" /\ now <= P.arr
  /\ IF Maint
     THEN /\ rt' = [rt EXCEPT ![u].pc = "done", ![u].arr = now, ![u].ans = 503, ![u].kind = "maint"]
          /\ UNCHANGED st
     ELSE /\ st' = [st EXCEPT ![u] = [Fresh EXCEPT !.att = "res", !.resAt = now]]
          /\ rt' = [rt EXCEPT ![u].pc = "s1", ![u].arr = now]
  /\ UNCHANGED <<ev, now, sg, bm, ra, dd, iv, nInv, runReq, r2, orp, bud, gh, err>>

RouteSend(u) ==
  /\ rt[u].pc \in {"s1", "s2", "s3", "s10"} /\ rt[u].call = "none" /\ rt[u].rep.a = "none"
  /\ rt' = [rt EXCEPT ![u].call = rt[u].pc, ![u].sent = now, ![u].left = V1 - (now - rt[u].arr)]
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
        !.chg = gh[u].chg + (IF c = "s3" /\ res.a = "queued" /\ (x0.ps = "staging" \/ Variant = "ChargeTwice")
                             THEN 1 ELSE 0),
        !.hu = IF c = "s3" /\ res.a = "queued" THEN res.x.dl + TEARDOWN ELSE gh[u].hu,
        !.k3 = IF c = "s10" THEN K3By(u, "s10") ELSE gh[u].k3]

RouteFlags(u, res) ==
  LET c == rt[u].call
      x0 == st[u]
  IN {f \in {"Restaged", "SlotFreedEarly", "Q4", "V1Answer"} :
        \/ f = "Restaged" /\ c = "s1" /\ res.a = "taken" /\ x0.ps # "staging" /\ gh[u].take >= 0
        \/ f = "SlotFreedEarly" /\ x0.slot.ph = "processing" /\ res.x.slot.ph = "none"
        \/ f = "Q4" /\ c = "s10" /\ ~Maint /\ Fenced(x0, ra)
                    /\ (x0.ps \in {"staging", "pending", "running"} \/ x0.cause = "restored")
                    /\ ~(res.a = "503" /\ res.x.doomed)
        \/ f = "V1Answer" /\ c = "s10" /\ res.a = "200" /\ r2[u].obj # Writes}

RouteExec(u) ==
  /\ rt[u].call # "none"
  /\ LET res == RouteResult(u)
         listening == rt[u].pc \notin {"done", "dead"}
     IN \/ /\ st' = [st EXCEPT ![u] = res.x]
           /\ gh' = [gh EXCEPT ![u] = RouteGhost(u, res)]
           /\ err' = err \cup RouteFlags(u, res)
           /\ \/ /\ rt' = [rt EXCEPT ![u].call = "none",
                                     ![u].rep = IF ~listening THEN NoRep
                                                ELSE IF res.a = "taken"
                                                THEN [a |-> res.a, sAt |-> res.x.sAt, dur |-> res.x.sUntil - now]
                                                ELSE [NoRep EXCEPT !.a = res.a]]
                 /\ UNCHANGED bud
              \/ /\ bud.loss > 0 /\ listening
                 /\ rt' = [rt EXCEPT ![u].call = "none", ![u].rep = [NoRep EXCEPT !.a = "lost"]]
                 /\ bud' = [bud EXCEPT !.loss = bud.loss - 1]
        \* The call fails before its transaction.
        \/ /\ bud.loss > 0 /\ listening
           /\ rt' = [rt EXCEPT ![u].call = "none", ![u].rep = [NoRep EXCEPT !.a = "lost"]]
           /\ bud' = [bud EXCEPT !.loss = bud.loss - 1]
           /\ UNCHANGED <<st, gh, err>>
  /\ UNCHANGED <<ev, now, sg, bm, ra, dd, iv, nInv, runReq, r2, orp>>

ToPc(u, pc) == rt' = [rt EXCEPT ![u].pc = pc, ![u].rep = NoRep, ![u].tries = 0, ![u].sent = 0, ![u].left = 0]

RouteReact(u) ==
  /\ rt[u].rep.a # "none"
  /\ LET a == rt[u].rep.a
         pc == rt[u].pc
         v1 == rt[u].v1
         keep == UNCHANGED <<r2, err>>
     IN CASE pc = "s1" ->
             IF a = "taken"
             THEN /\ rt' = [rt EXCEPT ![u].pc = "stream", ![u].rep = NoRep, ![u].sAt = rt[u].rep.sAt,
                                      ![u].sx = rt[u].sent + rt[u].rep.dur, ![u].tries = 0, ![u].sent = 0,
                                      ![u].left = 0]
                  /\ UNCHANGED gh /\ keep /\ UNCHANGED runReq
             ELSE IF a = "lost" /\ rt[u].tries = 0
             THEN /\ rt' = [rt EXCEPT ![u].rep = NoRep, ![u].tries = 1, ![u].sent = 0, ![u].left = 0] /\ UNCHANGED gh /\ keep /\ UNCHANGED runReq
             ELSE /\ Answer(u, CASE a = "inactive" -> 422 [] OTHER -> 503, IF a = "maint" THEN "maint" ELSE "route")
                  /\ keep /\ UNCHANGED runReq
          [] pc = "s2" ->
             /\ Answer(u, rt[u].want, "route")
             /\ IF a = "released" THEN RouteDel(u, TRUE) ELSE keep
             /\ UNCHANGED runReq
          [] pc = "s3" ->
             IF a = "queued" \/ a = "settled"
             THEN /\ runReq' = [runReq EXCEPT ![u] = runReq[u] \/ a = "queued"]
                  /\ IF v1 THEN ToPc(u, "wait") /\ UNCHANGED gh ELSE Answer(u, 202, "route")
                  /\ keep
             ELSE IF a \in {"refused_restored", "refused_time", "refused_inactive"}
             THEN /\ Answer(u, IF a = "refused_inactive" THEN 422 ELSE 503, "route")
                  /\ RouteDel(u, TRUE) /\ UNCHANGED runReq
             ELSE IF a = "lost" /\ rt[u].tries = 0
             THEN /\ rt' = [rt EXCEPT ![u].rep = NoRep, ![u].tries = 1, ![u].sent = 0, ![u].left = 0] /\ UNCHANGED gh /\ keep /\ UNCHANGED runReq
             ELSE IF a = "lost" /\ Variant = "RouteCleansOnLost"
             THEN /\ Answer(u, 503, "route") /\ RouteDel(u, FALSE) /\ UNCHANGED runReq
             \* SlotById: the design's single release by id, called from the request's finally.
             ELSE IF a = "lost" /\ Variant = "SlotById"
             THEN /\ rt' = [rt EXCEPT ![u].pc = "s2", ![u].want = 503, ![u].rep = NoRep, ![u].tries = 0, ![u].sent = 0,
                                  ![u].left = 0]
                  /\ UNCHANGED gh /\ keep /\ UNCHANGED runReq
             ELSE /\ Answer(u, 503, IF a = "maint" THEN "maint" ELSE "route") /\ keep /\ UNCHANGED runReq
          [] pc = "s10" ->
             /\ CASE a = "lost" -> Answer(u, 503, "nocall")
                  [] a = "maint" -> Answer(u, 503, "maint")
                  [] a = "not_yet" -> Answer(u, 503, "decided")
                  [] a = "200" -> Answer(u, 200, "decided")
                  [] a = "422" -> Answer(u, 422, "decided")
                  [] a = "500" -> Answer(u, 500, "decided")
                  [] OTHER -> Answer(u, 503, "decided")
             /\ keep /\ UNCHANGED runReq
          [] OTHER -> FALSE
  /\ Ev("GH3", rt[u].rep.a = "refused_restored")
  /\ UNCHANGED <<now, st, sg, bm, ra, dd, iv, nInv, orp, bud>>

\* The body's file part is stored in incoming/<id> (its multipart completion) before the staging time S1 gave, then
\* the text fields pass.
RouteWrite(u) ==
  /\ rt[u].pc = "stream" /\ now < rt[u].sx
  /\ r2' = [r2 EXCEPT ![u].inc = TRUE]
  /\ ToPc(u, "s3")
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, dd, iv, nInv, runReq, orp, bud, gh, err>>

\* The staging time runs out: the reader is cancelled and the route releases its staging (503).
RouteStageCut(u) ==
  /\ rt[u].pc = "stream" /\ now >= rt[u].sx
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
  /\ rt[u].pc = "wait" /\ now >= rt[u].arr + V1 - T_REPLY
  /\ ToPc(u, "s10")
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, dd, iv, nInv, runReq, r2, orp, bud, gh, err>>

\* A v1 request answers by arrival + V1: a call still out is left to commit or not (W5).
RouteGiveUp(u) ==
  /\ rt[u].v1 /\ rt[u].pc \notin {"idle", "done", "dead"} /\ now >= rt[u].arr + V1
  /\ Answer(u, 503, "nocall")
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
     /\ IF st[u].slot.ph = "processing" /\ res.x.slot.ph = "none" THEN Flag("SlotFreedEarly") ELSE UNCHANGED err
  /\ bud' = [bud EXCEPT !.del = bud.del - 1]
  /\ UNCHANGED <<ev, now, sg, bm, ra, rt, dd, iv, nInv, runReq, r2, orp>>

\* GET of a completed upload shows its URL.
OwnerGet(u) ==
  /\ rt[u].ans \in {200, 202} /\ st[u].att = "done" /\ ~st[u].doomed /\ ~gh[u].tok
  /\ gh' = [gh EXCEPT ![u].tok = TRUE]
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, rt, dd, iv, nInv, runReq, r2, orp, bud, err>>

---------------------------------------------------------------------------
(* The processor u:<id>:<token>.                                           *)

\* D0 run(id, token, teardown_id): the record and an alarm for now in one storage transaction; a record without an
\* alarm gets one; otherwise nothing.
DeliverRun(u) ==
  /\ runReq[u]
  /\ dd' = [dd EXCEPT ![u] = IF ~dd[u].rec THEN [dd[u] EXCEPT !.rec = TRUE, !.at = now, !.alarm = now]
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
DeleteAll(u, slot, ps) ==
  /\ dd' = [dd EXCEPT ![u] = [rec |-> FALSE, at |-> 0, alarm |-> -1, cont |-> dd[u].cont]]
  /\ EndInv(u)
  /\ IF dd[u].cont = "on" \/ (slot.tdn /\ slot.hu > now /\ ps # "pending") THEN Flag("RecordDropped") ELSE UNCHANGED err

\* An alarm() begins (one at a time) and takes D1 at once: the record-age stop (W9), else the alarm for
\* CLEANUP_RETRY_MS set and confirmed before S4 (Codex r4 H3: one for TEARDOWN_MS would leave a job interrupted
\* before its start waiting past its deadline). Until D1 replaces it the fired alarm stays due (ATOMICITY), so the
\* two are one step.
Fire(u) ==
  /\ dd[u].rec /\ dd[u].alarm >= 0 /\ dd[u].alarm <= now /\ iv[u].pc = "none" /\ nInv[u] < NINV
  /\ nInv' = [nInv EXCEPT ![u] = nInv[u] + 1]
  /\ IF now - dd[u].at >= (IF Variant = "ShortRecord" THEN 1 ELSE RECMAX) /\ dd[u].cont = "off"
     \* The record-age stop deletes the input too (D8): no later step of this object would (a completed upload's
     \* input is held by its row from the orphan pass and is no sweep's).
     THEN /\ DeleteAll(u, st[u].slot, st[u].ps)
          /\ r2' = [r2 EXCEPT ![u].inc = r2[u].inc /\ Variant = "AgedKeepsInput"]
          /\ ev' = ev \cup {"W9"}
     ELSE /\ dd' = [dd EXCEPT ![u].alarm = now + (IF Variant = "LongAlarm" THEN TEARDOWN ELSE RETRY)]
          /\ iv' = [iv EXCEPT ![u] = [NoInv EXCEPT !.pc = "s4", !.id = nInv[u] + 1, !.fired = now]]
          /\ UNCHANGED <<err, r2, ev>>
  /\ UNCHANGED <<now, st, sg, bm, ra, rt, runReq, orp, bud, gh>>

\* A processor Store call: the transaction, then its reply or a lost reply (the invocation repeats the call).
DOCall(u, res, onReply(_)) ==
  \/ /\ st' = [st EXCEPT ![u] = res.x]
     /\ onReply(res.a)
     /\ UNCHANGED bud
  \/ /\ bud.loss > 0
     /\ st' = [st EXCEPT ![u] = res.x]
     /\ bud' = [bud EXCEPT !.loss = bud.loss - 1]
     /\ UNCHANGED <<dd, iv, r2, gh, err>>

DOCallEv(u, res, onReply(_)) ==
  \/ /\ st' = [st EXCEPT ![u] = res.x]
     /\ onReply(res.a)
     /\ UNCHANGED bud
  \/ /\ bud.loss > 0
     /\ st' = [st EXCEPT ![u] = res.x]
     /\ bud' = [bud EXCEPT !.loss = bud.loss - 1]
     /\ UNCHANGED <<dd, iv, r2, gh, err, ev>>

\* S4. started: the job is this invocation's, with its deadline from the remaining time S4 answers, counted on the
\* processor's clock (M2). settled or gone: cleanup only. maint: the invocation ends and D1's alarm repeats it; the
\* record stays, since a start or a teardown may have committed (Codex r4 H4).
DOS4(u) ==
  /\ iv[u].pc = "s4"
  /\ LET res == S4(st[u], now, ra, Maint, iv[u].id)
         reply(a) ==
           CASE a = "started" ->
                /\ iv' = [iv EXCEPT ![u].pc = "start", ![u].dl = res.x.dl]
                /\ Ev("H3", iv[u].id > 1)
                /\ IF IsFenced(u) THEN Flag("RestoredActs") ELSE UNCHANGED err
                /\ UNCHANGED <<dd, r2>>
             [] a = "maint" ->
                /\ UNCHANGED ev
                /\ IF Variant = "MaintDropsRecord" /\ dd[u].cont = "off"
                   THEN DeleteAll(u, st[u].slot, st[u].ps)
                   ELSE /\ EndInv(u) /\ UNCHANGED err
                        /\ IF Variant = "MaintNoRetry" THEN dd' = [dd EXCEPT ![u].alarm = -1] ELSE UNCHANGED dd
                /\ UNCHANGED r2
             [] OTHER -> Go(u, "clean") /\ UNCHANGED <<dd, err, r2, ev>>
     IN \/ /\ st' = [st EXCEPT ![u] = res.x]
           /\ reply(res.a)
           /\ UNCHANGED bud
        \/ /\ bud.loss > 0
           /\ st' = [st EXCEPT ![u] = res.x]
           /\ bud' = [bud EXCEPT !.loss = bud.loss - 1]
           /\ UNCHANGED <<dd, iv, r2, err, ev>>
  \* The time of the job's first start, in the transaction whatever becomes of its reply.
  /\ gh' = [gh EXCEPT ![u].s4At = IF gh[u].s4At < 0 /\ st[u].ps # "running" /\ st'[u].ps = "running" THEN now
                                  ELSE gh[u].s4At]
  /\ UNCHANGED <<now, sg, bm, ra, rt, nInv, runReq, orp>>

\* D3's container start, which StartNeedsSlot guards: only before the job's deadline (a stage cut, else S7 timeout).
DOStart(u) ==
  /\ iv[u].pc = "start"
  /\ IF now < iv[u].dl
     THEN /\ dd' = [dd EXCEPT ![u].cont = "on"]
          /\ Go(u, "work")
          /\ IF (Live(st, u, now) /\ st[u].slot.ph = "processing") \/ W3(u)
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
              THEN /\ iv' = [iv EXCEPT ![u].pc = "p", ![u].gat = now, ![u].gg = res.g,
                                       ![u].gexp = IF Variant = "AbsGrant" THEN now + res.g ELSE now + P.skd + res.g,
                                       ![u].pre = gh[u].doomAt < 0, ![u].pa = rt[u].ans = 0]
                   /\ IF IsFenced(u) THEN Flag("RestoredActs") ELSE UNCHANGED err
              ELSE /\ iv' = [iv EXCEPT ![u].pc = "s7", ![u].out = IF a = "maint" THEN "unavailable" ELSE "timeout"]
                   /\ UNCHANGED err
           /\ UNCHANGED <<dd, r2, gh>>
     IN DOCall(u, res, reply)
  /\ UNCHANGED <<ev, now, sg, bm, ra, rt, nInv, runReq, orp>>

\* The write starts while the grant lasts on the processor's clock, else S5 is asked again.
DOPut(u) ==
  /\ iv[u].pc = "p"
  /\ IF now + P.skd < iv[u].gexp
     THEN /\ r2' = [r2 EXCEPT ![u].fly = r2[u].fly \cup {[k |-> iv[u].k, st |-> now, pre |-> iv[u].pre, pa |-> iv[u].pa]}]
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

\* D7: S6.
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
           /\ err' = err \cup flags
           /\ Ev("W5", fresh /\ rt[u].v1 /\ rt[u].ans = 503 /\ rt[u].kind \in {"nocall", "maint"})
           /\ UNCHANGED <<dd, r2, gh>>
     IN DOCallEv(u, res, reply)
  /\ UNCHANGED <<now, sg, bm, ra, rt, nInv, runReq, orp>>

\* D7: S7 with the job's cause. After a stop that was not confirmed the invocation ends there (s7f).
DOS7(u) ==
  /\ iv[u].pc \in {"s7", "s7f"}
  /\ LET res == S7(st[u], now, ra, Maint, iv[u].id, iv[u].out)
         reply(a) ==
           /\ IF a = "maint" \/ iv[u].pc = "s7f" THEN EndInv(u) ELSE Go(u, "s8")
           /\ UNCHANGED <<dd, r2, gh, err>>
     IN DOCall(u, res, reply)
  /\ UNCHANGED <<ev, now, sg, bm, ra, rt, nInv, runReq, orp>>

\* D8 and D9: incoming/<id> deleted (the processor's own from the queue's commit), then S8; released (or, with
\* ReleaseK3Stops, settled) ends in deleteAll; held and maint end the invocation, whose alarm repeats it.
DOS8(u) ==
  /\ iv[u].pc = "s8"
  /\ LET res == S8(st[u], now, ra, Maint)
         reply(a) ==
           /\ IF a \in {"released", "settled"} THEN DeleteAll(u, res.x.slot, res.x.ps) ELSE EndInv(u) /\ UNCHANGED <<dd, err>>
           /\ r2' = [r2 EXCEPT ![u].inc = FALSE]
           /\ UNCHANGED gh
     IN DOCall(u, res, reply)
  /\ UNCHANGED <<ev, now, sg, bm, ra, rt, nInv, runReq, orp>>

\* The cleanup replay of an invocation whose S4 was not started: the container stopped (D4's rule), then D8 and D9.
DOClean(u) ==
  /\ iv[u].pc = "clean"
  /\ IF dd[u].cont = "on"
     THEN \/ dd' = [dd EXCEPT ![u].cont = "off"] /\ Go(u, "s8") /\ UNCHANGED bud
          \/ /\ bud.dfail > 0
             /\ EndInv(u)
             /\ bud' = [bud EXCEPT !.dfail = bud.dfail - 1]
             /\ IF Variant = "StopNoRetry" THEN dd' = [dd EXCEPT ![u].alarm = -1] ELSE UNCHANGED dd
     ELSE Go(u, "s8") /\ UNCHANGED <<dd, bud>>
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, rt, nInv, runReq, r2, orp, gh, err>>

DOKill(u) ==
  /\ iv[u].pc # "none" /\ bud.kill > 0
  /\ EndInv(u)
  /\ bud' = [bud EXCEPT !.kill = bud.kill - 1]
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, rt, dd, nInv, runReq, r2, orp, gh, err>>

\* The platform ends an alarm() at its wall limit, TEARDOWN_MS after it began.
WallKill(u) ==
  /\ iv[u].pc # "none" /\ now + 1 >= iv[u].fired + TEARDOWN
  /\ EndInv(u)
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, rt, dd, nInv, runReq, r2, orp, bud, gh, err>>

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
       /\ Ev("W1", gh[u].doomAt >= 0)
  /\ UNCHANGED <<now, st, sg, bm, ra, rt, dd, iv, nInv, runReq, orp, bud, gh>>

R2Drop(u) ==
  /\ \E w \in r2[u].fly :
       /\ ~(iv[u].pc = "a" /\ iv[u].k = w.k)
       /\ r2' = [r2 EXCEPT ![u].fly = r2[u].fly \ {w}]
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, rt, dd, iv, nInv, runReq, orp, bud, gh, err>>

---------------------------------------------------------------------------
(* The cron.                                                               *)

\* S12 and S13 for one upload, when they change something; "run" is the redispatch.
Dispatch(u) ==
  /\ ~Maint
  /\ LET res == S12(st[u], now, ra) IN
     /\ res.x # st[u] \/ res.a = "run"
     /\ st' = [st EXCEPT ![u] = res.x]
     /\ runReq' = [runReq EXCEPT ![u] = runReq[u] \/ res.a = "run"]
     /\ gh' = [gh EXCEPT ![u].k3 = K3By(u, "round")]
  /\ UNCHANGED <<ev, now, sg, bm, ra, rt, dd, iv, nInv, r2, orp, bud, err>>

\* The sweep: a doomed upload, or an unfinished one at its gc_at, with its keys (mediaKeys includes incoming/<id>);
\* its processing row cascades, its slot does not.
Sweep(u) ==
  /\ P.gc /\ ~Maint
  /\ st[u].att \in {"res", "done"}
  /\ st[u].doomed \/ (st[u].att = "res" /\ now >= st[u].resAt + GC)
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
  /\ now >= st[u].resAt + (IF Variant = "EarlyRetire" THEN WW - 1 ELSE RETIRE)
  /\ st' = [st EXCEPT ![u] = [Fresh EXCEPT !.slot = st[u].slot]]
  /\ r2' = [r2 EXCEPT ![u].inc = r2[u].inc /\ Variant = "SweepNoIncoming", ![u].obj = {}]
  /\ gh' = [gh EXCEPT ![u].ret = TRUE]
  /\ UNCHANGED <<ev, now, sg, bm, ra, rt, dd, iv, nInv, runReq, orp, bud, err>>

\* incomingOrphans: the claim records its time in the Store; the classify reads, under an exact and post-restore
\* claim, the incoming keys no attachment row holds; the delete and the checkpoint follow. The cursor is abstracted:
\* a page is every key, so the checkpoint's fence decides no key here (README, "Abstracted").
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

ODelete ==
  /\ orp.pc = "classified"
  /\ r2' = [v \in U |-> IF v \in orp.keys THEN [r2[v] EXCEPT !.inc = FALSE] ELSE r2[v]]
  /\ orp' = [pc |-> "none", c |-> 0, keys |-> {}]
  /\ IF \E v \in orp.keys : TakesInput(v) THEN Flag("InputTaken") ELSE UNCHANGED err
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, rt, dd, iv, nInv, runReq, bud, gh>>

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
  /\ bm' = [has |-> TRUE, st |-> st, sg |-> sg]
  /\ bud' = [bud EXCEPT !.bm = bud.bm - 1]
  /\ UNCHANGED <<ev, now, st, sg, ra, rt, dd, iv, nInv, runReq, r2, orp, gh, err>>

Restore ==
  /\ bm.has /\ bud.rs > 0
  /\ st' = bm.st /\ sg' = bm.sg /\ ra' = now
  /\ bud' = [bud EXCEPT !.rs = bud.rs - 1]
  \* A bookmark no later restore can use is forgotten (a bound of the model).
  /\ bm' = IF bud.rs = 1 /\ bud.bm = 0 THEN [has |-> FALSE, st |-> [v \in U |-> Fresh], sg |-> sg] ELSE bm
  /\ UNCHANGED <<ev, now, rt, dd, iv, nInv, runReq, r2, orp, gh, err>>

Revoke ==
  /\ bud.rev > 0 /\ sg.active
  /\ sg' = [sg EXCEPT !.active = FALSE]
  /\ bud' = [bud EXCEPT !.rev = bud.rev - 1]
  /\ UNCHANGED <<ev, now, st, bm, ra, rt, dd, iv, nInv, runReq, r2, orp, gh, err>>

---------------------------------------------------------------------------
(* The clock.                                                              *)

\* A step that can be taken now, by kind of actor (LIVENESS, and the prompt actors of a scenario: the clock waits for
\* them).
DueDO(u) ==
  \/ iv[u].pc # "none"
  \/ dd[u].rec /\ dd[u].alarm >= 0 /\ dd[u].alarm <= now /\ nInv[u] < NINV
  \/ runReq[u]
DueRoute(u) ==
  \/ rt[u].call # "none" \/ rt[u].rep.a # "none"
  \/ rt[u].pc \in {"s1", "stream", "s2", "s3", "s10"}
  \/ rt[u].pc = "wait" /\ (S9(st[u], now, ra) # "processing" \/ now >= rt[u].arr + V1 - T_REPLY)
  \/ rt[u].pc = "idle" /\ now <= P.arr
DueCron(u) ==
  \/ ~Maint /\ (S12(st[u], now, ra).x # st[u] \/ S12(st[u], now, ra).a = "run")
  \/ P.gc /\ ~Maint /\ st[u].att \in {"res", "done"} /\ (st[u].doomed \/ (st[u].att = "res" /\ now >= st[u].resAt + GC))
  \/ P.gc /\ ~Maint /\ st[u].att = "gone" /\ (r2[u].obj # {} \/ r2[u].inc)
Due(u) ==
  \/ "do" \in P.prompt /\ DueDO(u)
  \/ "route" \in P.prompt /\ DueRoute(u)
  \/ "cron" \in P.prompt /\ DueCron(u)

Tick ==
  /\ now < P.tmax
  /\ \A u \in U : rt[u].v1 /\ rt[u].pc \notin {"idle", "done", "dead"} => now < rt[u].arr + V1
  /\ \A u \in U : \A w \in r2[u].fly : now < w.st + LAND
  \* An alarm() ends by its wall limit, and the container answers by the job's deadline (its work deadline).
  /\ \A u \in U : iv[u].pc # "none" => now + 1 < iv[u].fired + TEARDOWN
  /\ \A u \in U : iv[u].pc = "work" => now + 1 < iv[u].dl
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
  \/ DOS6(u) \/ DOS7(u) \/ DOS8(u) \/ DOClean(u)

CronStep(u) == Dispatch(u) \/ Sweep(u) \/ Reconcile(u) \/ Retire(u)

Faults(u) ==
  \/ RouteBad(u) \/ RouteDie(u) \/ OwnerDelete(u) \/ OwnerGet(u) \/ LoseRun(u) \/ DOPutErr(u) \/ DOKill(u)
  \/ WallKill(u) \/ R2Drop(u)

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
ChargeOnce == \A u \in U : gh[u].chg <= 1
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
PendingRoom(u) ==
  st[u].ps = "pending" /\ st[u].dl - now >= ROOM /\ ~IsFenced(u) /\ ~Maint /\ gh[u].doomAt < 0
PendingStarts == \A u \in U : PendingRoom(u) ~> (gh[u].s4At >= 0 \/ ra >= 0 \/ gh[u].doomAt >= 0 \/ Maint)

=============================================================================
