----------------------------- MODULE MediaUpload -----------------------------
(***************************************************************************)
(* The lifecycle of a video or audio upload (#1828 PR4): the upload route  *)
(* (v1 and v2), the Store, the upload's processor Durable Object           *)
(* u:<id>:<token>, its container, R2, the cron rounds, PITR restore,       *)
(* maintenance and the owner, under lost replies, kills and late writes.   *)
(* It decides the PR4 plan's section 1 (design-1828-pr4-plan.md): each of  *)
(* its tables cites the operator or property here that decides a cell.     *)
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
(*    again; its container runs on (W10 once HARD_HOLD has passed since    *)
(*    the grant).                                                          *)
(*  - R2: an incoming key per upload, the objects of the final writes, and *)
(*    the writes in flight, each landing at any time, or never, whatever   *)
(*    its writer does meanwhile. The tombstone's authority lasts until     *)
(*    max(purge, write deadline) + LAND, as main's; a landing after it     *)
(*    stays, as an image's does (LateLanding).                             *)
(*  - The cron: S12/S13 per row, the sweep, reconciliation, the tombstone  *)
(*    retirement, and the incomingOrphans pass (claim, classify, delete).  *)
(*  - The operator: maintenance, bookmarks and restores (st and sg back to *)
(*    any bookmark taken, the restore marker ra = now, which the Store     *)
(*    reads as restoredAt, and the restores' sequence number rn, which     *)
(*    orders a reply against a restore in the same time unit; DO storage,  *)
(*    R2, containers and requests are not rewound) and revoking the probe  *)
(*    verdict.                                                             *)
(*  - The owner: DELETE and GET of an upload whose id it was answered.     *)
(*                                                                         *)
(* TIME. One clock `now`, in abstract units (MediaUploadStore.tla's        *)
(* constants). The route (skr) and the processor (skd) read it with fixed  *)
(* offsets; only durations cross a clock boundary (S1's v1Left, S1's       *)
(* staging time, S4's remaining time, S5's grant), each measured from a    *)
(* reading taken before the call, so an offset cancels and a late reply    *)
(* only shortens what it grants (variants AbsGrant and AbsStart compare an *)
(* absolute Store time on the processor's clock instead). A v1 request     *)
(* answers no later than arrival + V1 on its own clock: the clock does not *)
(* move past it. Where the processor is a prompt actor, the cleanup of a   *)
(* container that still runs may wait lag units (the scenario's budget:    *)
(* Cloudflare bounds an alarm's delay nowhere).                            *)
(* Capacity needs no bound on that delay: a granted slot counts until its  *)
(* stop is confirmed, or HARD_HOLD after its grant (D16).                  *)
(*                                                                         *)
(* SAFETY (each a named invariant; Mutations names the mutations that      *)
(* break it, checks.json their outcomes). Each compares the step it checks *)
(* against ghost state recorded at the event that grounds it (the          *)
(* reservation, the grant, the queue's deadline, the Store's cleanup       *)
(* answer, S10's decision and commit, the answer sent, each restore's      *)
(* bookmark and what it rewrote, the purge, the start of maintenance),     *)
(* never against a value that step computes (D31):                         *)
(*  SlotBound        counting slots (Counts: a slot never granted until    *)
(*                   its held_until, a granted one until its stop is       *)
(*                   confirmed or HARD_HOLD after its grant) never exceed  *)
(*                   MAX_AV_INFLIGHT (design 4.5 "Capacity", D16).         *)
(*  ContainerCovered a running container has its upload's counting slot,   *)
(*                   except W3 (the latest restore's bookmark holds no     *)
(*                   grant of it and the Store none since, D18, D24, and   *)
(*                   the bookmark's ungranted slot, if any, has passed its *)
(*                   held_until, Gemini r5 GM2) and W10 (HARD_HOLD has     *)
(*                   passed since its grant with no confirmed stop, D17).  *)
(*  MaxContainers    at most MAX_AV_INFLIGHT containers run, plus one for  *)
(*                   each container no counting slot covers that W3 or W10 *)
(*                   excuses (D35), the capacity claim's two exceptions:   *)
(*                   W3 at most one container more for each grant the      *)
(*                   latest restore forgot, whether its container ran at   *)
(*                   the restore or starts after it, before the job's      *)
(*                   deadline (D24); W10 from HARD_HOLD after the grant    *)
(*                   on, unbounded by Kopje (D17).                         *)
(*  StartNeedsSlot   a container starts only before the deadline_at S3     *)
(*                   stored, on the Store's clock, W3 included, with a     *)
(*                   counting processing slot (W3 excepted, D25), and S4   *)
(*                   keeps that deadline (Codex r6 CB1).                   *)
(*  SlotRelease      a processing slot is removed only by S8 after the     *)
(*                   stop is confirmed and while no pending row needs it,  *)
(*                   or once it no longer counts: every Store step is      *)
(*                   checked, K3 included (C2-H2, GM3, GH1, Gemini r1 GH1, *)
(*                   Codex r2 CM4).                                        *)
(*  RouteDeleteAuthority                                                   *)
(*                   the route deletes incoming/<id> only after the Store  *)
(*                   answered it released (S2) or refused_cleanup_yours    *)
(*                   (S3) in a transaction, and never after a queue commit *)
(*                   the latest restore has not fenced (C1, C2-H3, Gemini  *)
(*                   r4 GH3).                                              *)
(*  InputKept        no one but its owner deletes the input of a live      *)
(*                   unfenced row (W4 is the fenced case).                 *)
(*  NoPublishAfterDelete                                                   *)
(*                   no completion after DELETE, and a write lands after   *)
(*                   it only on a grant issued before it (W1).             *)
(*  NoPublishAfterNon200                                                   *)
(*                   after a v1 answer other than 200 that is not a 503    *)
(*                   the Store did not decide (W5, by the reply the route  *)
(*                   received, or its clock at its give-up alone, D42), no *)
(*                   completion, a write lands only on a grant issued      *)
(*                   before the answer (W1), and the upload is published   *)
(*                   only once a restore since the decision rewrote its    *)
(*                   record (W11 for a 503, D32) (Codex r4 H1, M5; Gemini  *)
(*                   r1 GH2).                                              *)
(*  GrantBound       a write starts before its grant's Store time plus     *)
(*                   AV_GRANT_MS and before the deadline_at its queue      *)
(*                   stored (W1's bound, C7, M3).                          *)
(*  GrantGround      a write lands after DELETE only while the upload's    *)
(*                   URL was never issued (W1's ground, M3).               *)
(*  V1Answer         S10 decides 200, at its commit, exactly for an upload *)
(*                   the record it met shows published (completed,         *)
(*                   undoomed, before its gc_at, every write landed),      *)
(*                   except a call committing after the route answered or  *)
(*                   died that meets a completed, undoomed row the latest  *)
(*                   restore brought back without its files (W12, D19,     *)
(*                   D33); the route sends S10's decision, and every v1    *)
(*                   answer sent, the give-up's included, is 200 exactly   *)
(*                   for an upload published when it is sent, except a 503 *)
(*                   W5 excuses, and either way once a restore since the   *)
(*                   decision rewrote its record (W11: a 200 for an upload *)
(*                   it took back, a 503 for one it brought back completed,*)
(*                   whether S10 doomed the row it met or met none, D32,   *)
(*                   D36, D39, D42; D1, D11, D12).                         *)
(*  ChargeOnce       an upload the Store accepted (pending, running,       *)
(*                   failed or completed) is charged exactly one unit, in  *)
(*                   the transaction that accepted it, and a repeat        *)
(*                   charges nothing (RES-6, H3, GH1, Codex r1 CM5, D10).  *)
(*  RestoredInert    a reservation made at or before the latest restore    *)
(*                   never stages, queues, starts, is granted a write or   *)
(*                   completes (C3, G5, model 5, Gemini r1 GH3).           *)
(*  Q4               a decided v1 answer for an upload a restore fenced is *)
(*                   503 and dooms it, whichever of S10 and the round      *)
(*                   meets the restore first.                              *)
(*  RecordDropSafe   the processor deletes its storage only with its       *)
(*                   container stopped and no counting slot of its         *)
(*                   teardown left behind a row that is not pending (Codex *)
(*                   r4 H4; the record-age stop, W9, only once a grant's   *)
(*                   HARD_HOLD has passed).                                *)
(*  SingleStaging    a reservation stages at most once (Codex r4 M1).      *)
(*  NoLateObject     the tombstone is retired only once its authority has  *)
(*                   ended: no object lands, and no write is in flight,    *)
(*                   after the retirement and before max(purge,            *)
(*                   reservation + AV_WRITE_WINDOW_MS) + LAND, from the    *)
(*                   purge's and the reservation's times, or within LAND   *)
(*                   of the write's start; and the retirement leaves no    *)
(*                   key that landed before it (Codex r4 M3, D13, D27,     *)
(*                   D34). Without purge a late purge's authority outlasts *)
(*                   the scenario, and its tombstone is never retired      *)
(*                   (D41).                                                *)
(*  ConfirmFenced    a stop confirmation (S8) carrying another teardown's  *)
(*                   id leaves the slot as it is (D16, D20).               *)
(*  MaintInert       in maintenance (K1) the Store's records and its       *)
(*                   orphan claim stay as maintenance found them, or as a  *)
(*                   restore made them, whatever step runs: route,         *)
(*                   processor, owner or cron (D26, D31).                  *)
(*  RestoreExact     a restore leaves the Store equal to the bookmark it   *)
(*                   chose, slot by slot (D31).                            *)
(*  OwnerGetHasFiles the owner's GET shows a completed upload's URL only   *)
(*                   with its files there, except W13: the latest restore  *)
(*                   brought the completed row back after its files were   *)
(*                   deleted (D40).                                        *)
(*                                                                         *)
(* LIVENESS (scenarios L1-L5, under LSpec's fairness: weak fairness on     *)
(* every step but a fault, so alarms fire, rounds run, replies arrive and  *)
(* maintenance ends; every fault is budgeted, so none recurs for ever; the *)
(* clock moves only when no step can be taken now, which PendingStarts     *)
(* needs: the cron's round, the run and the alarm's entry take less than   *)
(* ROOM - MINENC, in production DISPATCH_MS + the cron period + the        *)
(* processor's startup < deadline_at - now - T_MIN_ENCODE):                *)
(*  SlotsReleased, RecordsCleared, InputsDeleted, ContainersStopped;       *)
(*  CompletedSwept: a completed upload whose v1 client got a 503 is swept  *)
(*  by the round that runs at its gc_at, before the clock moves past it    *)
(*  (W5's bound, D2, D11); and PendingStarts: a pending row with at least  *)
(*  DISPATCH + MINENC left starts its container, after a kill before its   *)
(*  start or a lost run (Codex r4 H3, W7), unless the start's reply died   *)
(*  with its invocation (the start rule).                                  *)
(***************************************************************************)
EXTENDS Integers, FiniteSets, MediaUploadStore

RETRY == 1 \* CLEANUP_RETRY_MS: D1's alarm, before S4
\* D1's record-age stop (W9), on the processor's clock from the record's D0. The grant (S4) falls before deadline_at,
\* which S3 sets at most V2_PROCESS_MS after the queue, and D0 follows the queue, so by V2_PROCESS_MS + HARD_HOLD_MS
\* after D0 no grant of this teardown counts. AgeBeforeHardHold keeps the earlier V2_PROCESS_MS + TEARDOWN_MS.
RECMAX ==
  CASE Variant = "ShortRecord" -> 1
    [] Variant = "AgeBeforeHardHold" -> V2P + TEARDOWN
    [] OTHER -> V2P + HARD_HOLD
ROOM == DISPATCH + MINENC

\* ev: the windows and orders a behaviour has gone through (MediaUploadGoals.tla), a ghost no step reads.
\* rn: the restores' sequence number, which orders replies against restores (a restore's time, ra, may repeat within a
\* time unit; D28); neither is rewound.
\* sw: the sweep's batch, the uploads whose keys it deleted and whose rows purgeMedia has yet to delete (the cron's
\* memory, not rewound).
VARIABLES now, st, sg, bm, ra, rn, rt, dd, iv, nInv, runReq, r2, orp, bud, gh, err, ev, sw

vars == <<now, st, sg, bm, ra, rn, rt, dd, iv, nInv, runReq, r2, orp, bud, gh, err, ev, sw>>

\* A route call's reply: its answer ("lost": no reply; for S10, "lost" after its commit and "failed" before it), and,
\* for S10, the restores' sequence number at its commit (V1Answer's W11) and, a ghost, the restore marker then.
NoRep == [a |-> "none", sAt |-> 0, dur |-> 0, rn |-> -1, ra |-> -1]
\* An invocation's memory; sdl is the Store's deadline_at in S4's reply (only W3AbsStart reads it), and grn a ghost, the
\* restores' sequence number at the grant it writes on.
NoInv == [pc |-> "none", id |-> 0, fired |-> 0, dl |-> 0, sdl |-> 0, k |-> 0, gexp |-> 0, gat |-> 0, gg |-> 0,
          grn |-> 0, pre |-> TRUE, pa |-> TRUE, out |-> "ok"]
\* ae: the ghost aEnd of each upload when the bookmark was taken, which a restore to it brings back with its tombstone.
NoBm == [has |-> FALSE, st |-> [v \in U |-> Fresh], sg |-> [active |-> TRUE, maint |-> FALSE, oc |-> -1],
         ae |-> [v \in U |-> 0]]
\* The K1 snapshot outside maintenance (MaintInert).
NoMx == <<Fresh, -1>>

Init ==
  /\ now = 0
  /\ st = [u \in U |-> Fresh]
  /\ sg = [active |-> TRUE, maint |-> FALSE, oc |-> -1]
  /\ bm = [i \in 1..P.bm |-> NoBm]
  /\ ra = -1
  /\ rn = 0
  /\ rt = [u \in U |-> [pc |-> "idle", v1 |-> u \in P.v1, arr |-> 0, call |-> "none", sent |-> 0, left |-> 0, sAt |-> 0,
                        sx |-> 0, rep |-> NoRep, tries |-> 0, ans |-> 0, kind |-> "none", want |-> 0]]
  /\ dd = [u \in U |-> [rec |-> FALSE, at |-> 0, alarm |-> -1, cont |-> "off", td |-> 0, gone |-> FALSE]]
  /\ iv = [u \in U |-> NoInv]
  /\ nInv = [u \in U |-> 0]
  /\ runReq = [u \in U |-> FALSE]
  /\ r2 = [u \in U |-> [inc |-> FALSE, obj |-> {}, fly |-> {}]]
  /\ orp = [pc |-> "none", c |-> 0, keys |-> {}]
  /\ bud = [loss |-> P.loss, kill |-> P.kill, dfail |-> P.dfail, gone |-> P.gone, lag |-> P.lag, stale |-> P.stale,
            perr |-> P.perr, rdie |-> P.rdie, del |-> P.del, mOn |-> P.mOn, bm |-> P.bm, rs |-> P.rs, rev |-> P.rev,
            bad |-> IF P.bad THEN 1 ELSE 0]
  \* The ghosts, each recorded at the event that grounds a property or an exception (D31); no step reads one.
  \* rsv: the reservation's time. q, qdl: a queue committed, and the deadline_at it stored. auth: the Store answered the
  \* route a cleanup (S2 released, S3 refused_cleanup_yours) in its transaction. s4At: the first start's time, the
  \* grant's. w3: the latest restore's bookmark holds no grant of the upload, which was granted before it (W3); w3hu:
  \* the held_until of the ungranted processing slot that bookmark held (-1: none). rw: the restores' sequence number of
  \* the latest restore that rewrote the upload's record (W11). fb: the latest restore brought back a completed,
  \* undoomed row whose files were missing (W12). w5, aRn: the v1 answer is a 503 the Store did not decide (W5), and
  \* the restores' sequence number at the decision it answers. aEnd: when the tombstone's authority ends, max(purge,
  \* reservation + AV_WRITE_WINDOW_MS) + LAND, from the purge's time; ret: it was retired since; lk: the keys that
  \* landed after that (NoLateObject). mx: the Store's record and orphan claim at the start of maintenance (MaintInert).
  \* kl, lg: a kill ended one of the upload's invocations, a step of its processor waited past a tick (HoldSpansFaults).
  /\ gh = [u \in U |-> [doomAt |-> -1, tok |-> FALSE, q |-> FALSE, s4At |-> -1, w3 |-> FALSE, take |-> -1,
                        ret |-> FALSE, aEnd |-> 0, k3 |-> "", kl |-> FALSE, lg |-> FALSE, rsv |-> -1, qdl |-> 0,
                        auth |-> FALSE, w3hu |-> -1, rw |-> 0, fb |-> FALSE, w5 |-> FALSE, aRn |-> 0, lk |-> {},
                        mx |-> NoMx]]
  /\ err = {}
  /\ ev = {}
  /\ sw = {}

Maint == sg.maint
\* A late upload's request arrives no earlier than its scenario's time for it.
Arrives(u) == (u \in P.late => now >= P.lateAt) /\ (u \in P.later => now >= P.laterAt)
IsFenced(u) == Fenced(st[u], ra)
\* The fence's ground: the upload was reserved at or before the latest restore (C3, G5), from the reservation's time.
FencedG(u) == gh[u].rsv >= 0 /\ gh[u].rsv <= ra
\* The route's clock.
RNow == now + P.skr
\* A slot that records a grant.
Granted(x) == x.slot.ph = "processing" /\ x.slot.ga >= 0
\* W3, derived from the Store's state, not sticky (D24): the upload was granted, the latest restore's bookmark holds no
\* grant of it, and the Store holds none since, so it has no record of a container that may run (D18). A later restore
\* to a bookmark that holds the grant ends it: the slot is back with its granted_at.
W3(u) == gh[u].w3 /\ ~Granted(st[u])
\* What W3 excuses: a container whose slot the restore did not bring back counting, so the bookmark's ungranted
\* processing slot, if it held one, has passed its held_until (Gemini r5 GM2: a Store step that drops that slot
\* earlier is no restore's doing).
W3Ex(u) == W3(u) /\ now >= gh[u].w3hu
\* W10: HARD_HOLD has passed since the grant, and the slot no longer counts the container if its stop is still not
\* confirmed: its processor stopped for good, or its stops failed that long (D17).
W10(u) == gh[u].s4At >= 0 /\ now >= gh[u].s4At + HARD_HOLD
\* The 503s of a v1 request the Store did not decide (W5): S10's reply lost after its commit, S10 failed before it,
\* the route's give-up at V1_TIME_MS, maintenance, and S3 lost twice (the route's labels, which the goals name).
W5Kinds == {"lost", "fail", "giveup", "maint", "s3lost"}
\* A v1 answer other than 200 the Store decided, or the route gave before a queue: not W5 by its ground (D31).
Non200(u) == rt[u].v1 /\ rt[u].ans \notin {0, 200} /\ ~gh[u].w5
\* A completed upload whose v1 request answered 503 (W5).
W5Row(u) == rt[u].v1 /\ rt[u].ans = 503 /\ st[u].att = "done" /\ ~st[u].doomed
\* A row whose input someone still needs: staging before its staged_until, pending or running.
LiveRow(x, t) == ((x.ps = "staging" /\ t < x.sUntil) \/ x.ps \in {"pending", "running"}) /\ ~x.doomed
\* Completed, before its gc_at (from then on main reads the row as gone, and the sweep may have deleted its files), and
\* every write landed: what a 200 may stand for.
Published(u, x) == x.att = "done" /\ ~x.doomed /\ now < x.gcAt /\ r2[u].obj = Writes
\* The answer a v1 decision of S10 stands for (D11, D36).
DecisionCode(a) == CASE a = "200" -> 200 [] a = "422" -> 422 [] a = "500" -> 500 [] OTHER -> 503

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

\* The route answers code, with extra the flags of the rest of its step. rcv is the reply it received for its last call
\* ("none": none, at its give-up). The ghost w5 records the answer as a 503 the Store did not decide: by that reply
\* (lost, failed, maintenance) or, at the give-up alone, by the route's clock; a reply the route received is the Store's
\* decision however late the route acts on it (D31, D42; Gemini r6 GM2, Codex r6 CB2). aRn: the restores' sequence
\* number at the decision answered (S10's commit, else now). V1Answer checks every v1 answer sent, whichever step sends
\* it (D36, D42; GiveUp200): 200 exactly for an upload published when it is sent, except a 503 W5 excuses and either
\* way once a restore since the decision rewrote the record (W11); and S10's decision as decided.
Answer(u, code, kind, rcv, extra) ==
  LET \* ClockOnlyW5 lets the clock excuse any reply (Codex r7).
      w5 == code = 503 /\ (rcv \in {"lost", "failed", "maint"}
                           \/ ((rcv = "none" \/ Variant = "ClockOnlyW5") /\ RNow >= rt[u].arr + V1))
      decided == rt[u].pc = "s10" /\ rcv \notin {"none", "lost", "failed", "maint"}
      aRn == IF decided THEN rt[u].rep.rn ELSE rn
      pub == Published(u, st[u])
      wrong == rt[u].v1 /\ gh[u].rw <= aRn /\ IF code = 200 THEN ~pub ELSE pub /\ ~w5
  IN
  /\ rt' = [rt EXCEPT ![u].pc = "done", ![u].ans = code, ![u].kind = kind, ![u].rep = NoRep, ![u].sent = 0,
                       ![u].left = 0]
  /\ gh' = [gh EXCEPT ![u].tok = gh[u].tok \/ code = 200, ![u].w5 = w5, ![u].aRn = aRn]
  /\ err' = err \cup extra \cup (IF wrong \/ (decided /\ code # DecisionCode(rcv)) THEN {"V1Answer"} ELSE {})
             \* W5's ground: never a 503 the route answers holding S10's decision (D45).
             \cup (IF w5 /\ decided THEN {"W5Decided"} ELSE {})

\* The route deletes incoming/<id>: only with the Store's cleanup answer, recorded in the Store's transaction, and never
\* once a queue the latest restore has not fenced has committed (RouteDeleteAuthority, DelFlags). A queue a restore
\* rewound is fenced: the job it may have started reserved before the restore, so it never publishes (Gemini r4 GH3).
RouteDel(u) == r2' = [r2 EXCEPT ![u].inc = FALSE]
DelFlags(u) == IF (gh[u].q /\ ~FencedG(u)) \/ ~gh[u].auth THEN {"RouteDeleteNoAuthority"} ELSE {}

RouteArrive(u) ==
  /\ rt[u].pc = "idle" /\ now <= P.arr /\ Arrives(u)
  /\ IF Maint
     THEN /\ rt' = [rt EXCEPT ![u].pc = "done", ![u].arr = RNow, ![u].ans = 503, ![u].kind = "maint"]
          /\ gh' = [gh EXCEPT ![u].w5 = TRUE, ![u].aRn = rn]
          /\ UNCHANGED st
     ELSE /\ st' = [st EXCEPT ![u] = [Fresh EXCEPT !.att = "res", !.resAt = now]]
          /\ rt' = [rt EXCEPT ![u].pc = "s1", ![u].arr = RNow]
          /\ gh' = [gh EXCEPT ![u].rsv = now]
  /\ UNCHANGED <<ev, now, sg, bm, ra, rn, dd, iv, nInv, runReq, r2, orp, bud, err, sw>>

RouteSend(u) ==
  /\ rt[u].pc \in {"s1", "s2", "s3", "s10"} /\ rt[u].call = "none" /\ rt[u].rep.a = "none"
  /\ rt' = [rt EXCEPT ![u].call = rt[u].pc, ![u].sent = RNow, ![u].left = V1 - (RNow - rt[u].arr)]
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, rn, dd, iv, nInv, runReq, r2, orp, bud, gh, err, sw>>

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
        !.qdl = IF c = "s3" /\ res.a = "queued" /\ x0.ps = "staging" THEN res.x.dl ELSE gh[u].qdl,
        !.auth = gh[u].auth \/ (c = "s2" /\ res.a = "released")
                            \/ (c = "s3" /\ res.a \in {"refused_restored", "refused_time", "refused_inactive"}),
        !.k3 = IF c = "s10" THEN K3By(u, "s10") ELSE gh[u].k3]

\* W12: S10's call commits after the route answered (its give-up, W5) or died, and decides 200 for a completed,
\* undoomed row the latest restore brought back after its files were deleted (D19, D28, D33: the ghost fb, recorded
\* at that restore). Such a row's files go only with a sweep: at its gc_at, after which S10 no longer answers 200, or
\* of a doomed or restored reservation a second restore replaced by the completed row, before its gc_at. That gc_at
\* lies DGRACE after completion, past the v1 wait, so only a call nobody waits for meets such a row, and no client
\* receives its 200. Any other 200 for an unpublished upload, a late one included, is a V1Answer violation
\* (LateRestored200).
W12(u, res) ==
  /\ rt[u].call = "s10" /\ rt[u].pc \in {"done", "dead"} /\ res.a = "200" /\ gh[u].fb
  /\ st[u].att = "done" /\ ~st[u].doomed /\ r2[u].obj # Writes

RouteFlags(u, res) ==
  LET c == rt[u].call
      x0 == st[u]
  IN {f \in {"Restaged", "Q4", "V1Answer", "RestoredActs"} :
        \/ f = "Restaged" /\ c = "s1" /\ res.a = "taken" /\ x0.ps # "staging" /\ gh[u].take >= 0
        \/ f = "Q4" /\ c = "s10" /\ ~Maint /\ FencedG(u) /\ x0.att # "none"
                    /\ (x0.ps \in {"staging", "pending", "running"} \/ x0.cause = "restored")
                    /\ ~(res.a = "503" /\ res.x.doomed)
        \* S10's decision against the record it met: 200 for a published upload only, and a decided answer other than
        \* 200 only for one that is not.
        \/ f = "V1Answer" /\ c = "s10" /\ (res.a = "200") # Published(u, x0) /\ res.a # "maint" /\ ~W12(u, res)
        \/ f = "RestoredActs" /\ FencedG(u)
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
           /\ ev' = ev \cup (IF rt[u].call = "s10" /\ res.a = "503" /\ Norm(st[u], now, ra).ps = "running" THEN {"H1"} ELSE {})
                       \cup (IF W12(u, res) THEN {"W12"} ELSE {})
                       \cup (IF W12(u, res) /\ rt[u].pc = "dead" THEN {"W12Dead"} ELSE {})
                       \* What S10 met, for the goals of W11 for a 503 (D39), recorded only where two restores may
                       \* follow: a row it doomed, or none (no row or a tombstone).
                       \cup (IF P.rs > 1 /\ rt[u].call = "s10" /\ res.x.doomed /\ ~st[u].doomed THEN {"S10Doom"}
                             ELSE {})
                       \cup (IF P.rs > 1 /\ rt[u].call = "s10" /\ st[u].att \in {"none", "gone"} THEN {"S10Absent"}
                             ELSE {})
                       \* S10 between the sweep's two steps meets a completed row whose files are gone (Codex r6 CB3).
                       \cup (IF rt[u].call = "s10" /\ u \in sw /\ st[u].att = "done" /\ ~st[u].doomed
                             THEN {"S10Swept"} ELSE {})
           /\ \/ /\ rt' = [rt EXCEPT ![u].call = "none",
                                     ![u].rep = IF ~listening THEN NoRep
                                                ELSE IF res.a = "taken"
                                                THEN [NoRep EXCEPT !.a = res.a, !.sAt = res.x.sAt,
                                                                   !.dur = res.x.sUntil - now]
                                                ELSE IF rt[u].call = "s10"
                                                THEN [NoRep EXCEPT !.a = res.a, !.rn = rn, !.ra = ra]
                                                ELSE [NoRep EXCEPT !.a = res.a]]
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
  /\ UNCHANGED <<now, sg, bm, ra, rn, dd, iv, nInv, runReq, r2, orp, sw>>

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
             ELSE /\ Answer(u, CASE a = "inactive" -> 422 [] OTHER -> 503, IF a = "maint" THEN "maint" ELSE "route", a,
                            {})
                  /\ UNCHANGED <<r2, runReq, ev>>
          [] pc = "s2" ->
             \* An S2 reply not received leaves the input to the sweep (W6).
             /\ Answer(u, rt[u].want, IF noReply THEN "s2lost" ELSE "route", a,
                       IF a = "released" THEN DelFlags(u) ELSE {})
             /\ IF a = "released" THEN RouteDel(u) ELSE UNCHANGED r2
             /\ UNCHANGED <<runReq, ev>>
          [] pc = "s3" ->
             IF a = "queued" \/ a = "settled"
             THEN /\ runReq' = [runReq EXCEPT ![u] = runReq[u] \/ a = "queued"]
                  /\ IF v1 THEN ToPc(u, "wait") /\ UNCHANGED <<gh, err>> ELSE Answer(u, 202, "route", a, {})
                  /\ UNCHANGED <<r2, ev>>
             ELSE IF a \in {"refused_restored", "refused_time", "refused_inactive"}
             THEN /\ Answer(u, IF a = "refused_inactive" THEN 422 ELSE 503, "route", a, DelFlags(u))
                  /\ RouteDel(u) /\ UNCHANGED runReq
                  /\ Ev("GH3", a = "refused_restored")
             ELSE IF noReply /\ rt[u].tries = 0
             THEN Retry(u) /\ UNCHANGED gh /\ keep /\ UNCHANGED <<runReq, ev>>
             ELSE IF noReply /\ Variant = "RouteCleansOnLost"
             THEN /\ Answer(u, 503, "s3lost", a, DelFlags(u)) /\ RouteDel(u) /\ UNCHANGED <<runReq, ev>>
             \* SlotById: the design's single release by id, called from the request's finally.
             ELSE IF noReply /\ Variant = "SlotById"
             THEN /\ rt' = [rt EXCEPT ![u].pc = "s2", ![u].want = 503, ![u].rep = NoRep, ![u].tries = 0, ![u].sent = 0,
                                  ![u].left = 0]
                  /\ UNCHANGED gh /\ keep /\ UNCHANGED <<runReq, ev>>
             ELSE /\ Answer(u, 503, CASE a = "maint" -> "maint" [] noReply -> "s3lost" [] OTHER -> "route", a, {})
                  /\ UNCHANGED <<r2, runReq, ev>>
          [] pc = "s10" ->
             \* The route sends S10's decision (D32); Route503 sends 503 for a 200 (Codex r5 CM3).
             LET code == CASE a = "200" -> IF Variant = "Route503" THEN 503 ELSE 200
                           [] a = "422" -> 422
                           [] a = "500" -> 500
                           [] OTHER -> 503
                 decided == a \notin {"lost", "failed", "maint"}
                 \* A restore since S10's commit rewrote the upload's record (W11), by the restores' sequence number, so
                 \* two restores in one time unit are two (D28).
                 rewound == gh[u].rw > rt[u].rep.rn
                 pub == Published(u, st[u])
                 \* W11 for a 503: a decision for an upload a restore since then brought back completed, whether S10
                 \* doomed the row it met or met none (D39).
                 back == decided /\ code # 200 /\ pub /\ rewound
             IN
             /\ Answer(u, code, CASE a = "lost" -> "lost" [] a = "failed" -> "fail" [] a = "maint" -> "maint"
                                     [] OTHER -> "decided", a, {})
             /\ ev' = ev \cup (IF decided /\ code = 200 /\ ~pub /\ rewound THEN {"W11"} ELSE {})
                         \cup (IF decided /\ code = 200 /\ ~pub /\ rewound /\ rt[u].rep.ra = ra
                                THEN {"W11Tick"} ELSE {})
                         \cup (IF back /\ "S10Doom" \in ev THEN {"W11Doom"} ELSE {})
                         \cup (IF back /\ "S10Absent" \in ev THEN {"W11Absent"} ELSE {})
                         \cup (IF ~decided /\ st[u].att = "done" /\ ~st[u].doomed THEN {"W5"} ELSE {})
             /\ UNCHANGED <<r2, runReq>>
          [] OTHER -> FALSE
  /\ UNCHANGED <<now, st, sg, bm, ra, rn, dd, iv, nInv, orp, bud, sw>>

\* The body's file part is stored in incoming/<id> (its multipart completion) before the staging time S1 gave, then
\* the text fields pass.
RouteWrite(u) ==
  /\ rt[u].pc = "stream" /\ RNow < rt[u].sx
  /\ r2' = [r2 EXCEPT ![u].inc = TRUE]
  /\ ToPc(u, "s3")
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, rn, dd, iv, nInv, runReq, orp, bud, gh, err, sw>>

\* The staging time runs out: the reader is cancelled and the route releases its staging (503).
RouteStageCut(u) ==
  /\ rt[u].pc = "stream" /\ RNow >= rt[u].sx
  /\ rt' = [rt EXCEPT ![u].pc = "s2", ![u].want = 503, ![u].tries = 0]
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, rn, dd, iv, nInv, runReq, r2, orp, bud, gh, err, sw>>

\* A body or a text field the route refuses (422): before the queue, the route releases its staging.
RouteBad(u) ==
  /\ bud.bad > 0
  /\ \/ rt[u].pc = "stream"
     \/ rt[u].pc = "s3" /\ rt[u].call = "none" /\ rt[u].rep.a = "none" /\ rt[u].tries = 0
  /\ rt' = [rt EXCEPT ![u].pc = "s2", ![u].want = 422, ![u].tries = 0]
  /\ bud' = [bud EXCEPT !.bad = 0]
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, rn, dd, iv, nInv, runReq, r2, orp, gh, err, sw>>

\* The v1 wait: S9 reads an outcome, or the route's cut (arrival + V1 - T_REPLY on its clock) arrives; either way the
\* route asks S10 for the decision.
RoutePoll(u) ==
  /\ rt[u].pc = "wait" /\ S9(st[u], now, ra) # "processing"
  /\ ToPc(u, "s10")
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, rn, dd, iv, nInv, runReq, r2, orp, bud, gh, err, sw>>

RouteCut(u) ==
  /\ rt[u].pc = "wait" /\ RNow >= rt[u].arr + V1 - T_REPLY
  /\ ToPc(u, "s10")
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, rn, dd, iv, nInv, runReq, r2, orp, bud, gh, err, sw>>

\* A v1 request answers by arrival + V1: a call still out is left to commit or not (W5).
\* An S10 reply the route received before its timeout fires is answered, not the timeout (D45, Codex r7):
\* GiveUpOverReply gives up over it. The give-up passes S10's buffered reply on, so W5 is told from it; a reply to an
\* earlier call is the Store's answer to that call, not to the upload's outcome, and leaves the give-up W5.
RouteGiveUp(u) ==
  /\ rt[u].v1 /\ rt[u].pc \notin {"idle", "done", "dead"} /\ RNow >= rt[u].arr + V1
  /\ ~(rt[u].pc = "s10" /\ rt[u].rep.a \notin {"none", "lost", "failed", "maint"}) \/ Variant = "GiveUpOverReply"
  \* GiveUp200: the give-up answers 200 (Codex r6 CB2).
  /\ Answer(u, IF Variant = "GiveUp200" THEN 200 ELSE 503, "giveup", IF rt[u].pc = "s10" THEN rt[u].rep.a ELSE "none",
            {})
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, rn, dd, iv, nInv, runReq, r2, orp, bud, sw>>

RouteDie(u) ==
  /\ bud.rdie > 0 /\ rt[u].pc \notin {"idle", "done", "dead"}
  /\ rt' = [rt EXCEPT ![u].pc = "dead", ![u].rep = NoRep]
  /\ bud' = [bud EXCEPT !.rdie = bud.rdie - 1]
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, rn, dd, iv, nInv, runReq, r2, orp, gh, err, sw>>

---------------------------------------------------------------------------
(* The owner of an upload whose id it was answered (v2's 202, v1's 200).   *)

OwnerDelete(u) ==
  /\ bud.del > 0 /\ rt[u].ans \in {200, 202}
  /\ LET res == S11(st[u], now, ra, Maint) IN
     /\ st' = [st EXCEPT ![u] = res.x]
     /\ gh' = [gh EXCEPT ![u].doomAt = IF res.a = "200" /\ gh[u].doomAt < 0 THEN now ELSE gh[u].doomAt]
     /\ err' = err \cup FreedEarly(st[u], res.x, FALSE)
  /\ bud' = [bud EXCEPT !.del = bud.del - 1]
  /\ UNCHANGED <<ev, now, sg, bm, ra, rn, rt, dd, iv, nInv, runReq, r2, orp, sw>>

\* GET of a completed upload shows its URL.
OwnerGet(u) ==
  /\ rt[u].ans \in {200, 202} /\ st[u].att = "done" /\ ~st[u].doomed /\ now < st[u].gcAt /\ ~gh[u].tok
  /\ gh' = [gh EXCEPT ![u].tok = TRUE]
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, rn, rt, dd, iv, nInv, runReq, r2, orp, bud, err, sw>>

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
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, rn, rt, iv, nInv, r2, orp, bud, gh, err, sw>>

LoseRun(u) ==
  /\ runReq[u] /\ P.loseRun /\ bud.loss > 0
  /\ runReq' = [runReq EXCEPT ![u] = FALSE]
  /\ bud' = [bud EXCEPT !.loss = bud.loss - 1]
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, rn, rt, dd, iv, nInv, r2, orp, gh, err, sw>>

Go(u, pc) == iv' = [iv EXCEPT ![u].pc = pc]
EndInv(u) == iv' = [iv EXCEPT ![u] = NoInv]

\* deleteAll(): the record, teardown_id and alarm. RecordDropSafe: only with the container stopped, and no counting
\* slot of this teardown left behind a row that is not pending (slot is the slot after this step).
DeleteAll(u) ==
  /\ dd' = [dd EXCEPT ![u] = [dd[u] EXCEPT !.rec = FALSE, !.at = 0, !.alarm = -1, !.td = 0]]
  /\ EndInv(u)
DropFlags(u, slot, ps) ==
  IF dd[u].cont = "on" \/ (slot.td # 0 /\ Counts(slot, now) /\ ps # "pending") THEN {"RecordDropped"} ELSE {}

\* An alarm() begins (one at a time) and takes D1 at once: the record-age stop (W9), else the alarm for
\* CLEANUP_RETRY_MS set and confirmed before S4 (Codex r4 H3: one for TEARDOWN_MS would leave a job interrupted
\* before its start waiting past its deadline). The platform clears the alarm it runs and runs it again if the handler
\* dies before D1 (ATOMICITY), so a death there is this step not taken yet, and a run between the two finds no alarm
\* and sets one for now, which D1 replaces: the same states as taking the two as one step (Codex r1 CM6).
Fire(u) ==
  /\ dd[u].rec /\ ~dd[u].gone /\ dd[u].alarm >= 0 /\ dd[u].alarm <= now /\ iv[u].pc = "none"
  /\ nInv' = [nInv EXCEPT ![u] = nInv[u] + 1]
  /\ IF now - dd[u].at >= RECMAX /\ dd[u].cont = "off"
     \* The record-age stop deletes the input too (D8): no later step of this object would (a completed upload's
     \* input is held by its row from the orphan pass and is no sweep's).
     THEN /\ DeleteAll(u)
          /\ err' = err \cup DropFlags(u, st[u].slot, st[u].ps)
          /\ r2' = [r2 EXCEPT ![u].inc = r2[u].inc /\ Variant = "AgedKeepsInput"]
          /\ ev' = ev \cup {"W9"} \cup (IF "ConfirmMaint" \in ev THEN {"W9Refused"} ELSE {})
     ELSE /\ dd' = [dd EXCEPT ![u].alarm = now + (IF Variant = "LongAlarm" THEN TEARDOWN ELSE RETRY)]
          /\ iv' = [iv EXCEPT ![u] = [NoInv EXCEPT !.pc = "s4", !.id = nInv[u] + 1, !.fired = now]]
          /\ UNCHANGED <<err, r2, ev>>
  /\ UNCHANGED <<now, st, sg, bm, ra, rn, rt, runReq, orp, bud, gh, sw>>

\* A processor Store call: the transaction with the flags it raises, then its reply or a lost reply (the invocation
\* repeats the call). replyFlags are those of what the reply leads to. No call but S8 may remove a processing slot
\* (SlotRelease), whichever of K3, K4 and its own rule would (Codex r2 CM4).
DOCall(u, res, flags, replyFlags(_), onReply(_)) ==
  /\ st' = [st EXCEPT ![u] = res.x]
  /\ \/ /\ onReply(res.a)
        /\ err' = err \cup flags \cup FreedEarly(st[u], res.x, FALSE) \cup replyFlags(res.a)
        /\ UNCHANGED bud
     \/ /\ bud.loss > 0
        /\ bud' = [bud EXCEPT !.loss = bud.loss - 1]
        /\ err' = err \cup flags \cup FreedEarly(st[u], res.x, FALSE)
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
\* first (DOClean), since the stop needs no Store write, while its confirmation (S8) waits for maintenance to end.
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
         \* S4 keeps the deadline_at S3 stored (the ghost qdl; MoveStartDeadline, Codex r6 CB1).
         flags == (IF fresh /\ FencedG(u) THEN {"RestoredActs"} ELSE {})
                  \cup (IF res.x.ps = "running" /\ res.x.dl # gh[u].qdl THEN {"DeadlineMoved"} ELSE {})
     IN /\ DOCall(u, res, flags, drops, reply)
        \* S4Timeout: S4 itself fails a pending job with less than T_MIN_ENCODE left (Codex r5 CM7).
        /\ ev' = ev \cup (IF fresh /\ iv[u].id > 1 THEN {"H3"} ELSE {})
                    \cup (IF st[u].ps = "pending" /\ res.x.cause = "timeout" THEN {"S4Timeout"} ELSE {})
        \* The first start, in the transaction whatever becomes of its reply.
        /\ gh' = [gh EXCEPT ![u].s4At = IF gh[u].s4At < 0 /\ fresh THEN now ELSE gh[u].s4At]
  /\ UNCHANGED <<now, sg, bm, ra, rn, rt, nInv, runReq, orp, sw>>

\* D3's container start, which StartNeedsSlot guards: only before the job's deadline on the processor's clock (a stage
\* cut, else S7 timeout). The check reads the deadline_at S3 stored (the ghost qdl), not the one S4 answered (Codex r6
\* CB1), and W3 as it excuses a container (W3Ex). The deadline binds a start W3 excuses too: W3 excuses only the slot
\* (D25; W3AbsStart lets such a start compare the Store's deadline in S4's reply with the processor's clock, as
\* AbsStart does, Codex r4 CM2).
DOStart(u) ==
  /\ iv[u].pc = "start"
  /\ IF now + P.skd < (IF Variant = "W3AbsStart" /\ W3(u) THEN iv[u].sdl ELSE iv[u].dl)
     THEN /\ dd' = [dd EXCEPT ![u].cont = "on"]
          /\ Go(u, "work")
          /\ IF now < gh[u].qdl /\ ((Live(st, u, now) /\ st[u].slot.ph = "processing") \/ W3Ex(u))
             THEN UNCHANGED err ELSE Flag("StartWithoutSlot")
          \* A grant the latest restore forgot whose container starts only now (D24: W3 counts grants, not containers).
          /\ Ev("W3Start", W3(u))
     ELSE /\ iv' = [iv EXCEPT ![u].pc = "s7", ![u].out = "timeout"] /\ UNCHANGED <<dd, err, ev>>
  /\ UNCHANGED <<now, st, sg, bm, ra, rn, rt, nInv, runReq, r2, orp, bud, gh, sw>>

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
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, rn, rt, nInv, runReq, r2, orp, gh, err, sw>>

\* D6: S5 before each final write; the grant is a duration counted from the processor's reading before the call.
DOGrant(u) ==
  /\ iv[u].pc = "g"
  /\ LET res == S5(st[u], now, ra, Maint, iv[u].id)
         reply(a) ==
           /\ IF a = "grant"
              THEN iv' = [iv EXCEPT ![u].pc = "p", ![u].gat = now, ![u].gg = res.g, ![u].grn = rn,
                                    ![u].gexp = IF Variant = "AbsGrant" THEN now + res.g ELSE now + P.skd + res.g,
                                    ![u].pre = gh[u].doomAt < 0, ![u].pa = rt[u].ans = 0]
              ELSE iv' = [iv EXCEPT ![u].pc = "s7", ![u].out = IF a = "maint" THEN "unavailable" ELSE "timeout"]
           /\ UNCHANGED <<dd, r2>>
     IN DOCall(u, res, IF res.a = "grant" /\ FencedG(u) THEN {"RestoredActs"} ELSE {}, NoFlags, reply)
  /\ UNCHANGED <<ev, now, sg, bm, ra, rn, rt, nInv, runReq, orp, gh, sw>>

\* The write starts while the grant lasts on the processor's clock, else S5 is asked again. GrantBound: before the
\* grant's Store time + AV_GRANT_MS and before the deadline_at the queue stored (the ghost qdl), whatever S5 answered.
DOPut(u) ==
  /\ iv[u].pc = "p"
  /\ IF now + P.skd < iv[u].gexp
     \* rr: a restore since the grant, by the restores' sequence number, so the write starts on a grant the restore
     \* rewound.
     THEN /\ r2' = [r2 EXCEPT ![u].fly = r2[u].fly \cup {[k |-> iv[u].k, st |-> now, pre |-> iv[u].pre, pa |-> iv[u].pa,
                                                          rr |-> rn # iv[u].grn]}]
          /\ iv' = [iv EXCEPT ![u].pc = "a", ![u].gexp = 0, ![u].gat = 0, ![u].gg = 0, ![u].grn = 0, ![u].pre = TRUE,
                              ![u].pa = TRUE]
          /\ IF now < iv[u].gat + AV_GRANT /\ now < gh[u].qdl THEN UNCHANGED err ELSE Flag("GrantOverrun")
     ELSE Go(u, "g") /\ UNCHANGED <<r2, err>>
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, rn, rt, dd, nInv, runReq, orp, bud, gh, sw>>

\* The write's success. CompleteBeforeLanding completes the upload as soon as the last write starts.
DOAck(u) ==
  /\ \/ iv[u].pc = "a" /\ iv[u].k \in r2[u].obj
     \/ iv[u].pc = "a" /\ Variant = "CompleteBeforeLanding" /\ iv[u].k = P.nw
  /\ iv' = [iv EXCEPT ![u].pc = IF iv[u].k < P.nw THEN "g" ELSE "s6", ![u].k = iv[u].k + 1]
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, rn, rt, dd, nInv, runReq, r2, orp, bud, gh, err, sw>>

\* The write answers an error; it may still land (R2Land).
DOPutErr(u) ==
  /\ iv[u].pc = "a" /\ bud.perr > 0
  /\ iv' = [iv EXCEPT ![u].pc = "s7", ![u].out = "unavailable"]
  /\ bud' = [bud EXCEPT !.perr = bud.perr - 1]
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, rn, rt, dd, nInv, runReq, r2, orp, gh, err, sw>>

\* D7: S6. Its flags are the transaction's, whatever becomes of its reply (Gemini r1 GH3).
DOS6(u) ==
  /\ iv[u].pc = "s6"
  /\ LET res == S6(st[u], now, ra, Maint, iv[u].id)
         fresh == res.a = "done" /\ st[u].att # "done"
         flags == {f \in {"PublishAfterDelete", "PublishAfterNon200", "RestoredActs"} :
                     \/ f = "PublishAfterDelete" /\ fresh /\ gh[u].doomAt >= 0
                     \/ f = "PublishAfterNon200" /\ fresh /\ Non200(u)
                     \/ f = "RestoredActs" /\ fresh /\ FencedG(u)}
         reply(a) ==
           /\ IF a = "maint" THEN EndInv(u) ELSE Go(u, "s8")
           /\ UNCHANGED <<dd, r2>>
     IN /\ DOCall(u, res, flags, NoFlags, reply)
        /\ Ev("W5", fresh /\ rt[u].v1 /\ rt[u].ans = 503)
  /\ UNCHANGED <<now, sg, bm, ra, rn, rt, nInv, runReq, orp, gh, sw>>

\* D7: S7 with the job's cause. After a stop that was not confirmed the invocation ends there (s7f).
DOS7(u) ==
  /\ iv[u].pc \in {"s7", "s7f"}
  /\ LET res == S7(st[u], now, ra, Maint, iv[u].id, iv[u].out)
         reply(a) ==
           /\ IF a = "maint" \/ iv[u].pc = "s7f" THEN EndInv(u) ELSE Go(u, "s8")
           /\ UNCHANGED <<dd, r2>>
     IN DOCall(u, res, {}, NoFlags, reply)
  /\ UNCHANGED <<ev, now, sg, bm, ra, rn, rt, nInv, runReq, orp, gh, sw>>

\* D8 and D9: incoming/<id> deleted (the processor's own from the queue's commit), then S8, the stop confirmation, with
\* the record's teardown_id; released (or, with ReleaseK3Stops, settled) ends in deleteAll; held and maint end the
\* invocation, whose alarm repeats it. S8 may remove the slot only with the container stopped and no pending row left
\* (SlotRelease).
\* D8 is done whatever becomes of S8's reply; a death between the two is a death before both, since deleting the key
\* again is idempotent and nothing else waits on it (Codex r1 CM6).
DOS8(u) ==
  /\ iv[u].pc = "s8"
  /\ LET res == S8(st[u], now, ra, Maint, dd[u].td)
         drops(a) == IF a \in {"released", "settled"} THEN DropFlags(u, res.x.slot, res.x.ps) ELSE {}
         reply(a) == IF a \in {"released", "settled"} THEN DeleteAll(u) ELSE EndInv(u) /\ UNCHANGED dd
     IN /\ DOCallR(u, res, FreedEarly(st[u], res.x, dd[u].cont = "off" /\ res.x.ps # "pending"), drops, reply)
        /\ r2' = [r2 EXCEPT ![u].inc = FALSE]
        /\ Ev("ConfirmMaint", res.a = "maint")
  /\ UNCHANGED <<now, sg, bm, ra, rn, rt, nInv, runReq, orp, gh, sw>>

\* The cleanup replay of an invocation whose S4 was not started: the container stopped (D4's rule), then D8 and D9 (in
\* maintenance, the invocation ends there). A stop that is not confirmed ends the invocation, whose alarm repeats it;
\* the slot counts meanwhile, granted (D16), with no Store write.
DOClean(u) ==
  /\ iv[u].pc = "clean"
  /\ IF dd[u].cont = "on"
     THEN \/ /\ dd' = [dd EXCEPT ![u].cont = "off"]
             /\ IF iv[u].out = "maint" THEN EndInv(u) ELSE Go(u, "s8")
             /\ UNCHANGED bud
          \/ /\ bud.dfail > 0
             /\ bud' = [bud EXCEPT !.dfail = bud.dfail - 1]
             /\ EndInv(u)
             /\ IF Variant = "StopNoRetry" THEN dd' = [dd EXCEPT ![u].alarm = -1] ELSE UNCHANGED dd
     ELSE Go(u, "s8") /\ UNCHANGED <<dd, bud>>
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, rn, rt, nInv, runReq, r2, orp, gh, err, sw>>

\* An invocation dies; its D1 alarm runs it again.
EndByDeath(u) ==
  /\ EndInv(u)
  /\ UNCHANGED dd

DOKill(u) ==
  /\ iv[u].pc # "none" /\ bud.kill > 0
  /\ EndByDeath(u)
  /\ bud' = [bud EXCEPT !.kill = bud.kill - 1]
  /\ gh' = [gh EXCEPT ![u].kl = TRUE]
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, rn, rt, nInv, runReq, r2, orp, err, sw>>

\* The platform ends an alarm() at its wall limit, TEARDOWN_MS after it began.
WallKill(u) ==
  /\ iv[u].pc # "none" /\ now + 1 >= iv[u].fired + TEARDOWN
  /\ EndByDeath(u)
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, rn, rt, nInv, runReq, r2, orp, bud, gh, err, sw>>

\* A stop confirmation (S8) that carries a teardown_id other than the processing slot's (a call of another teardown,
\* delayed): the slot after it must be the slot before it, whatever it answers (ConfirmFenced; GM3, Codex r2 CM3, r3
\* CM2, D20).
StaleConfirm(u) ==
  /\ bud.stale > 0 /\ st[u].slot.ph = "processing"
  /\ LET res == S8(st[u], now, ra, Maint, 2) IN
     /\ st' = [st EXCEPT ![u] = res.x]
     /\ err' = err \cup FreedEarly(st[u], res.x, FALSE)
                    \cup (IF res.x.slot # st[u].slot THEN {"ConfirmUnfenced"} ELSE {})
  /\ bud' = [bud EXCEPT !.stale = bud.stale - 1]
  /\ UNCHANGED <<ev, now, sg, bm, ra, rn, rt, dd, iv, nInv, runReq, r2, orp, gh, sw>>

\* The processor stops for good with its container running (W10): no alarm or request runs again.
DOGone(u) ==
  /\ bud.gone > 0 /\ dd[u].cont = "on" /\ ~dd[u].gone
  /\ dd' = [dd EXCEPT ![u].gone = TRUE]
  /\ EndInv(u)
  /\ bud' = [bud EXCEPT !.gone = bud.gone - 1]
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, rn, rt, nInv, runReq, r2, orp, gh, err, sw>>

---------------------------------------------------------------------------
(* R2: a write in flight lands, at any time, or never does once no one     *)
(* waits for it. One landing after the tombstone's authority ended         *)
(* (max(purge, write deadline) + LAND) and its retirement stays, as an     *)
(* image's does (LateLanding).                                             *)

\* The retired tombstone's authority still held when a write that started at ws lands at t: before the authority's
\* end from the purge's time (aEnd), or within LAND (ORPHAN_GRACE_MS) of the write's start, the bound of r3 (Gemini r5
\* GH1: a deadline past the write window starts a write the tombstone must still cover).
Covered(u, ws, t) == t < gh[u].aEnd \/ t <= ws + LAND

R2Land(u) ==
  /\ \E w \in r2[u].fly :
       /\ r2' = [r2 EXCEPT ![u].obj = r2[u].obj \cup {w.k}, ![u].fly = r2[u].fly \ {w}]
       /\ err' = err \cup {f \in {"PublishAfterDelete", "GrantGround", "PublishAfterNon200", "LateObject"} :
                             \/ f = "PublishAfterDelete" /\ gh[u].doomAt >= 0 /\ ~w.pre
                             \/ f = "GrantGround" /\ gh[u].doomAt >= 0 /\ gh[u].tok
                             \/ f = "PublishAfterNon200" /\ Non200(u) /\ ~w.pa
                             \/ f = "LateObject" /\ gh[u].ret /\ Covered(u, w.st, now)}
       /\ gh' = [gh EXCEPT ![u].lk = IF gh[u].ret THEN gh[u].lk \cup {w.k} ELSE gh[u].lk]
       \* W1 after DELETE, and after a restore between the grant and the write's start (D4, D13); a landing after the
       \* retired tombstone's authority (W1's residual).
       /\ ev' = ev \cup (IF gh[u].doomAt >= 0 THEN {"W1"} ELSE {}) \cup (IF w.rr THEN {"W1R"} ELSE {})
                   \cup (IF gh[u].ret /\ ~Covered(u, w.st, now) THEN {"LateLanding"} ELSE {})
  /\ UNCHANGED <<now, st, sg, bm, ra, rn, rt, dd, iv, nInv, runReq, orp, bud, sw>>

R2Drop(u) ==
  /\ \E w \in r2[u].fly :
       /\ ~(iv[u].pc = "a" /\ iv[u].k = w.k)
       /\ r2' = [r2 EXCEPT ![u].fly = r2[u].fly \ {w}]
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, rn, rt, dd, iv, nInv, runReq, orp, bud, gh, err, sw>>

---------------------------------------------------------------------------
(* The cron.                                                               *)

\* S12 and S13 for one upload, when they change something; "run" is the redispatch. It removes a processing slot only
\* once it no longer counts (SlotRelease).
\* DispatchInMaint runs it in maintenance (Codex r5 CM6).
Dispatch(u) ==
  /\ ~Maint \/ Variant = "DispatchInMaint"
  /\ LET res == S12(st[u], now, ra) IN
     /\ res.x # st[u] \/ res.a = "run"
     /\ st' = [st EXCEPT ![u] = res.x]
     /\ runReq' = [runReq EXCEPT ![u] = runReq[u] \/ res.a = "run"]
     /\ gh' = [gh EXCEPT ![u].k3 = K3By(u, "round")]
     /\ err' = err \cup FreedEarly(st[u], res.x, ~Counts(st[u].slot, now))
  /\ UNCHANGED <<ev, now, sg, bm, ra, rn, rt, dd, iv, nInv, r2, orp, bud, sw>>

\* What the sweep takes: a doomed upload, an unfinished one at its gc_at, and a completed unattached one at the gc_at
\* completion gave it (W5's bound, D2), unless its owner attached it (kept).
Sweepable(u, x, t) ==
  \/ x.att \in {"res", "done"} /\ x.doomed
  \/ x.att = "res" /\ t >= x.resAt + GC
  \/ /\ x.att = "done" /\ t >= x.gcAt + (IF Variant = "LateSweep" THEN 1 ELSE 0) /\ Variant # "DoneNeverSwept"
     /\ ~(P.kept /\ rt[u].ans \in {200, 202})

\* The sweep in main's two steps (src/mastodon/media.ts, sweepMedia; D33): expiredMedia's read and the deletion of the
\* upload's keys (mediaKeys includes incoming/<id>), then purgeMedia, which deletes the row only if it is still
\* sweepable. A restore commutes with the deletion (one writes only R2, the other only the Store), so the read and the
\* deletion are one step. Between the two steps S10 meets a completed row whose files are gone: past its gc_at, so it
\* answers 503 (S10IgnoresGc answers 200).
\* Only scenarios with split take the two steps apart (+24% states in V1K): the v1 ones whose S10 may commit late
\* (V1L, RSW, RS12). Elsewhere nothing that reads both the row and R2 can run between them, so they are one step.
TakesKeys(u) == err \cup (IF TakesInput(u) /\ Variant # "SweepNoIncoming" THEN {"InputTaken"} ELSE {})
\* purgeMedia's effect: the row deleted, its processing row cascading, its slot not; the tombstone keeps its
\* delete_after. The ghost aEnd records the end of its authority, max(purge, reservation + AV_WRITE_WINDOW_MS) + LAND,
\* from the purge's time and the ghost reservation time, apart from the Store's DeleteAfter (D34, Codex r6 CB1). In a
\* scenario without purge a late purge's authority outlasts the scenario (NEVER): its tombstone is never retired there
\* (D41), and recording the purge's time would add a state per purge time.
Purge(u, errs) ==
  /\ st' = [st EXCEPT ![u] = [RowNone(st[u]) EXCEPT !.att = "gone", !.dA = DeleteAfter(st[u], now)]]
  /\ gh' = [gh EXCEPT ![u].ret = FALSE,
                      ![u].aEnd = IF now <= gh[u].rsv + WW THEN gh[u].rsv + WW + LAND
                                  ELSE IF P.purge THEN now + LAND ELSE NEVER]
  /\ err' = errs \cup FreedEarly(st[u], st'[u], FALSE)

SweepDel(u) ==
  /\ P.gc /\ ~Maint /\ u \notin sw /\ Sweepable(u, st[u], now)
  /\ r2' = [r2 EXCEPT ![u].inc = r2[u].inc /\ Variant = "SweepNoIncoming", ![u].obj = {}]
  /\ IF P.split
     THEN /\ sw' = sw \cup {u}
          /\ err' = TakesKeys(u)
          /\ UNCHANGED <<st, gh>>
     ELSE Purge(u, TakesKeys(u)) /\ UNCHANGED sw
  /\ UNCHANGED <<ev, now, sg, bm, ra, rn, rt, dd, iv, nInv, runReq, orp, bud>>

\* purgeMedia, which deletes the row only if it is still sweepable.
SweepPurge(u) ==
  /\ P.gc /\ ~Maint /\ u \in sw
  /\ sw' = sw \ {u}
  /\ IF Sweepable(u, st[u], now) THEN Purge(u, err) ELSE UNCHANGED <<st, gh, err>>
  /\ UNCHANGED <<ev, now, sg, bm, ra, rn, rt, dd, iv, nInv, runReq, r2, orp, bud>>

\* Reconciliation deletes the keys of a tombstone again.
Reconcile(u) ==
  /\ P.gc /\ ~Maint /\ st[u].att = "gone"
  /\ r2[u].obj # {} \/ (r2[u].inc /\ Variant # "SweepNoIncoming")
  /\ r2' = [r2 EXCEPT ![u].inc = r2[u].inc /\ Variant = "SweepNoIncoming", ![u].obj = {}]
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, rn, rt, dd, iv, nInv, runReq, orp, bud, gh, err, sw>>

\* The tombstone is retired, with a last deletion of the keys (reconcileMedia: dueOrphans, the deletion, then
\* forgetOrphans), once its authority has ended, at its delete_after. A put that lands between that deletion and
\* forgetOrphans stays: the deletion commutes with the Store's steps, so the model takes the three as one, and such a
\* landing is one after it (LateLanding), as an image's is. EarlyRetire retires it at the write cut,
\* RetireIgnoresPurge at the write cut + LAND whenever the purge was, RetireNoDelete skips the last deletion (Codex
\* r5 CM4).
Retire(u) ==
  /\ P.gc /\ ~Maint /\ st[u].att = "gone"
  /\ now >= CASE Variant = "EarlyRetire" -> st[u].resAt + WW
             [] Variant = "RetireIgnoresPurge" -> st[u].resAt + RETIRE
             [] OTHER -> st[u].dA
  /\ st' = [st EXCEPT ![u] = [Fresh EXCEPT !.slot = st[u].slot]]
  /\ IF Variant = "RetireNoDelete" THEN UNCHANGED r2
     ELSE r2' = [r2 EXCEPT ![u].inc = r2[u].inc /\ Variant = "SweepNoIncoming", ![u].obj = {}]
  /\ gh' = [gh EXCEPT ![u].ret = TRUE, ![u].lk = {}]
  /\ err' = err \cup FreedEarly(st[u], st'[u], FALSE)
  /\ UNCHANGED <<ev, now, sg, bm, ra, rn, rt, dd, iv, nInv, runReq, orp, bud, sw>>

\* incomingOrphans: the claim records its time in the Store; the classify reads, under an exact and post-restore
\* claim, the incoming keys no attachment row holds; the delete follows. The cursor, the checkpoint and overlapping
\* claims are abstracted: a page is every key and one pass runs at a time (README, "What the model abstracts").
Held(v) == st[v].att # "none" /\ (Variant # "OrphanStagingUnheld" \/ st[v].ps # "staging")

\* At most one claim a time unit (the pass's hour, ORPHAN_SWEEP_MS).
OClaim ==
  /\ P.orphan /\ ~Maint /\ orp.pc = "none" /\ sg.oc < now
  /\ sg' = [sg EXCEPT !.oc = now]
  /\ orp' = [pc |-> "claimed", c |-> now, keys |-> {}]
  /\ UNCHANGED <<ev, now, st, bm, ra, rn, rt, dd, iv, nInv, runReq, r2, bud, gh, err, sw>>

OClassify ==
  /\ orp.pc = "claimed" /\ ~Maint
  /\ orp' = IF sg.oc # orp.c \/ orp.c <= ra THEN [pc |-> "none", c |-> 0, keys |-> {}]
            ELSE [orp EXCEPT !.pc = "classified", !.keys = {v \in U : r2[v].inc /\ ~Held(v)}]
  /\ UNCHANGED <<ev, now, st, sg, bm, ra, rn, rt, dd, iv, nInv, runReq, r2, bud, gh, err, sw>>

\* W4: a key classified unheld is held again, by a row a restore brought back, when it is deleted.
ODelete ==
  /\ orp.pc = "classified"
  /\ r2' = [v \in U |-> IF v \in orp.keys THEN [r2[v] EXCEPT !.inc = FALSE] ELSE r2[v]]
  /\ orp' = [pc |-> "none", c |-> 0, keys |-> {}]
  /\ IF \E v \in orp.keys : TakesInput(v) THEN Flag("InputTaken") ELSE UNCHANGED err
  /\ Ev("W4", \E v \in orp.keys : r2[v].inc /\ Held(v))
  /\ UNCHANGED <<now, st, sg, bm, ra, rn, rt, dd, iv, nInv, runReq, bud, gh, sw>>

---------------------------------------------------------------------------
(* The operator.                                                           *)

\* Maintenance records the Store's state it begins with (the ghost mx), which K1 keeps (MaintInert).
MaintOn ==
  /\ bud.mOn > 0 /\ ~Maint /\ now >= P.mAt
  /\ sg' = [sg EXCEPT !.maint = TRUE]
  /\ bud' = [bud EXCEPT !.mOn = bud.mOn - 1]
  /\ gh' = [u \in U |-> [gh[u] EXCEPT !.mx = <<st[u], sg.oc>>]]
  /\ UNCHANGED <<ev, now, st, bm, ra, rn, rt, dd, iv, nInv, runReq, r2, orp, err, sw>>

MaintOff ==
  /\ Maint
  /\ sg' = [sg EXCEPT !.maint = FALSE]
  /\ gh' = [u \in U |-> [gh[u] EXCEPT !.mx = NoMx]]
  /\ UNCHANGED <<ev, now, st, bm, ra, rn, rt, dd, iv, nInv, runReq, r2, orp, bud, err, sw>>

Bookmark ==
  /\ bud.bm > 0
  /\ bm' = [bm EXCEPT ![P.bm - bud.bm + 1] = [has |-> TRUE, st |-> st, sg |-> sg, ae |-> [u \in U |-> gh[u].aEnd]]]
  /\ bud' = [bud EXCEPT !.bm = bud.bm - 1]
  /\ UNCHANGED <<ev, now, st, sg, ra, rn, rt, dd, iv, nInv, runReq, r2, orp, gh, err, sw>>

\* A restore to any bookmark taken. W3 follows the latest restore (D24): it holds for a job granted before it whose
\* grant the bookmark does not hold (D18), and ends for one whose grant it holds, which comes back with its granted_at,
\* so the slot counts as it did. RestoreExact checks that the Store is the bookmark's, slot by slot (D31); the
\* mutations RestoreDropsGrant (Codex r4 CH1) and RestoreMovesGrant (granted_at moved to now, Codex r5 CM5) break it.
\* The ghosts record what each upload's record was before and after (rw, fb, w3hu) and maintenance's snapshot. A
\* restore that brings a record back undoes a retirement, and the tombstone it brings back has the authority it had at
\* the bookmark (aEnd; Gemini r6 GM3); one to a bookmark without the upload's record changes neither.
Restore ==
  /\ bud.rs > 0 /\ now >= P.rsAt
  /\ \E i \in DOMAIN bm :
       LET b == bm[i].st IN
       /\ bm[i].has
       /\ st' = [u \in U |-> CASE Variant = "RestoreDropsGrant" /\ gh[u].w3 /\ Granted(b[u]) ->
                                   [b[u] EXCEPT !.slot = NoSlot]
                              [] Variant = "RestoreMovesGrant" /\ Granted(b[u]) -> [b[u] EXCEPT !.slot.ga = now]
                              [] OTHER -> b[u]]
       /\ sg' = bm[i].sg /\ ra' = now /\ rn' = rn + 1
       /\ gh' = [u \in U |->
                  [gh[u] EXCEPT !.w3 = gh[u].s4At >= 0 /\ ~Granted(b[u]),
                                !.w3hu = IF b[u].slot.ph = "processing" /\ ~Granted(b[u]) THEN b[u].slot.hu ELSE -1,
                                !.rw = IF b[u] # st[u] THEN rn + 1 ELSE gh[u].rw,
                                !.fb = b[u].att = "done" /\ ~b[u].doomed /\ r2[u].obj # Writes,
                                !.ret = gh[u].ret /\ b[u].att = "none",
                                !.aEnd = IF b[u].att = "none" THEN gh[u].aEnd ELSE bm[i].ae[u],
                                !.mx = IF bm[i].sg.maint THEN <<st'[u], bm[i].sg.oc>> ELSE NoMx]]
       /\ err' = err \cup (IF st' # b \/ sg' # bm[i].sg THEN {"RestoreDiffers"} ELSE {})
       /\ Ev("W3Forgot", \E u \in U : gh[u].s4At >= 0 /\ ~Granted(b[u]))
  /\ bud' = [bud EXCEPT !.rs = bud.rs - 1]
  \* Bookmarks no later restore can use are forgotten (a bound of the model).
  /\ bm' = IF bud.rs = 1 /\ bud.bm = 0 THEN [i \in DOMAIN bm |-> NoBm] ELSE bm
  /\ UNCHANGED <<now, rt, dd, iv, nInv, runReq, r2, orp, sw>>

Revoke ==
  /\ bud.rev > 0 /\ sg.active
  /\ sg' = [sg EXCEPT !.active = FALSE]
  /\ bud' = [bud EXCEPT !.rev = bud.rev - 1]
  /\ UNCHANGED <<ev, now, st, bm, ra, rn, rt, dd, iv, nInv, runReq, r2, orp, gh, err, sw>>

---------------------------------------------------------------------------
(* The clock.                                                              *)

FireDue(u) == dd[u].rec /\ ~dd[u].gone /\ dd[u].alarm >= 0 /\ dd[u].alarm <= now
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
  \/ rt[u].pc = "idle" /\ now <= P.arr /\ Arrives(u)
DueCron(u) ==
  \/ ~Maint /\ (S12(st[u], now, ra).x # st[u] \/ S12(st[u], now, ra).a = "run")
  \/ P.gc /\ ~Maint /\ (Sweepable(u, st[u], now) \/ u \in sw)
  \/ P.gc /\ ~Maint /\ st[u].att = "gone" /\ (r2[u].obj # {} \/ r2[u].inc)
Due(u) ==
  \/ "route" \in P.prompt /\ DueRoute(u)
  \/ "cron" \in P.prompt /\ DueCron(u)
\* The processor steps the clock waits for; lag lets it move past them only while they are the cleanup of a container
\* that still runs (its due alarm, the replay's S4 or its stop), the delay that could matter to capacity (TIME).
DOWaits(u) == "do" \in P.prompt /\ DueDO(u)
LateCleanup(u) == dd[u].cont = "on" /\ (FireDue(u) \/ iv[u].pc \in {"s4", "clean"})

Tick ==
  /\ now < P.tmax
  /\ \A u \in U : rt[u].v1 /\ rt[u].pc \notin {"idle", "done", "dead"} => RNow < rt[u].arr + V1
  \* An alarm() ends by its wall limit, and the container answers by the job's deadline (its work deadline).
  /\ \A u \in U : iv[u].pc # "none" => now + 1 < iv[u].fired + TEARDOWN
  /\ \A u \in U : iv[u].pc = "work" => now + P.skd + 1 < iv[u].dl
  /\ ~(\E u \in U : Due(u))
  /\ "cron" \in P.prompt => orp.pc = "none"
  /\ IF \E u \in U : DOWaits(u)
     THEN /\ bud.lag > 0 /\ \A u \in U : DOWaits(u) => LateCleanup(u)
          /\ bud' = [bud EXCEPT !.lag = bud.lag - 1]
          /\ gh' = [u \in U |-> [gh[u] EXCEPT !.lg = gh[u].lg \/ DOWaits(u)]]
     ELSE UNCHANGED <<bud, gh>>
  /\ now' = now + 1
  /\ UNCHANGED <<st, sg, bm, ra, rn, rt, dd, iv, nInv, runReq, r2, orp, err, ev, sw>>

---------------------------------------------------------------------------

RouteStep(u) ==
  \/ RouteArrive(u) \/ RouteSend(u) \/ RouteExec(u) \/ RouteReact(u) \/ RouteWrite(u) \/ RouteStageCut(u)
  \/ RoutePoll(u) \/ RouteCut(u) \/ RouteGiveUp(u)

DOStep(u) ==
  \/ DeliverRun(u) \/ Fire(u) \/ DOS4(u) \/ DOStart(u) \/ DOWork(u) \/ DOGrant(u) \/ DOPut(u) \/ DOAck(u)
  \/ DOS6(u) \/ DOS7(u) \/ DOS8(u) \/ DOClean(u)

CronStep(u) == Dispatch(u) \/ SweepDel(u) \/ SweepPurge(u) \/ Reconcile(u) \/ Retire(u)

Faults(u) ==
  \/ RouteBad(u) \/ RouteDie(u) \/ OwnerDelete(u) \/ OwnerGet(u) \/ LoseRun(u) \/ DOPutErr(u) \/ DOKill(u)
  \/ WallKill(u) \/ DOGone(u) \/ StaleConfirm(u) \/ R2Drop(u)

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
\* The containers a counting slot does not cover, excused by W3 or W10: each adds one to the bound (D35, Gemini r5 GM2:
\* one a slot covers is counted by it already).
Excused == {u \in Running : ~Live(st, u, now) /\ (W3Ex(u) \/ W10(u))}

SlotBound == Cardinality({u \in U : Live(st, u, now)}) <= MaxInflight
ContainerCovered == \A u \in Running : Live(st, u, now) \/ W3Ex(u) \/ W10(u)
MaxContainers == Cardinality(Running) <= MaxInflight + Cardinality(Excused)
StartNeedsSlot == "StartWithoutSlot" \notin err /\ "DeadlineMoved" \notin err
SlotRelease == "SlotFreedEarly" \notin err
RouteDeleteAuthority == "RouteDeleteNoAuthority" \notin err
InputKept == "InputTaken" \notin err
NoPublishAfterDelete == "PublishAfterDelete" \notin err
\* Also: W5 never excuses a 503 answered with S10's decision in hand (D45), and no upload is published after such an
\* answer unless a restore since its decision rewrote the record (W11 for a 503, D32: a restore to a bookmark that holds
\* the upload completed).
NoPublishAfterNon200 ==
  /\ "PublishAfterNon200" \notin err
  /\ "W5Decided" \notin err
  /\ \A u \in U : Non200(u) /\ Published(u, st[u]) => gh[u].rw > gh[u].aRn
GrantBound == "GrantOverrun" \notin err
GrantGround == "GrantGround" \notin err
V1Answer == "V1Answer" \notin err
ChargeOnce ==
  \A u \in U : /\ st[u].ps \in {"pending", "running", "failed"} \/ st[u].att = "done" => st[u].chg = 1
               /\ st[u].chg <= 1
RestoredInert == "RestoredActs" \notin err
Q4 == "Q4" \notin err
RecordDropSafe == "RecordDropped" \notin err
SingleStaging == "Restaged" \notin err
\* Also: no write the retired tombstone's authority still covers is in flight, and every key left after the
\* retirement landed after it (RetireNoDelete).
NoLateObject ==
  /\ "LateObject" \notin err
  /\ \A u \in U : gh[u].ret => /\ \A w \in r2[u].fly : ~Covered(u, w.st, now)
                               /\ r2[u].obj \subseteq gh[u].lk
ConfirmFenced == "ConfirmUnfenced" \notin err
\* K1, for every step (D31): in maintenance the Store's records and its orphan claim stay as maintenance found them or
\* a restore made them.
MaintInert == Maint => \A u \in U : gh[u].mx = <<st[u], sg.oc>>
RestoreExact == "RestoreDiffers" \notin err
\* What the owner's GET of a completed upload shows (its URL, before its gc_at) has its files, except W13: the latest
\* restore brought the completed row back after its files were deleted (the ghost fb, D40).
OwnerGetHasFiles ==
  \A u \in U :
    rt[u].ans \in {200, 202} /\ st[u].att = "done" /\ ~st[u].doomed /\ now < st[u].gcAt /\ ~gh[u].fb
      => r2[u].obj = Writes

---------------------------------------------------------------------------
(* Liveness (LSpec).                                                       *)

SlotsReleased == <>[](\A u \in U : st[u].slot.ph = "none")
RecordsCleared == <>[](\A u \in U : ~dd[u].rec)
InputsDeleted == <>[](\A u \in U : ~r2[u].inc)
ContainersStopped == <>[](\A u \in U : dd[u].cont = "off")
\* Swept when the round runs at its gc_at, before the clock moves past it (LateSweep sweeps one unit later).
CompletedSwept ==
  /\ \A u \in U : W5Row(u) ~> ~W5Row(u)
  /\ \A u \in U : \A t \in 0..P.tmax :
       (W5Row(u) /\ ~Maint /\ now = t /\ t >= st[u].gcAt) ~> ((~W5Row(u) \/ Maint) /\ now = t)
PendingRoom(u) ==
  st[u].ps = "pending" /\ st[u].dl - now >= ROOM /\ ~IsFenced(u) /\ ~Maint /\ gh[u].doomAt < 0
\* The start's invocation died, its reply or its container start not taken (the start rule: no other invocation
\* starts it).
StartLost(u) == st[u].ps = "running" /\ iv[u].pc = "none" /\ dd[u].cont = "off"
PendingStarts ==
  \A u \in U :
    PendingRoom(u) ~> (dd[u].cont = "on" \/ StartLost(u) \/ ra >= rt[u].arr - P.skr \/ gh[u].doomAt >= 0 \/ Maint)


---------------------------------------------------------------------------
(* Mutations.                                                              *)

\* Each mutation as <<property it breaks, Variant, scenario it breaks it in>>: the record checks.json's variants must
\* match (test-node/media-upload-spec-plan.test.ts), so a mutation dropped from either fails the plan's test.
Mutations ==
  {<<"SlotBound", "SlotNoCount", "CAP">>, <<"ContainerCovered", "DeleteFreesSlot", "CAP">>,
   <<"MaxContainers", "DeleteFreesSlot", "CAP">>,
   <<"StartNeedsSlot", "SlotById", "V1L">>, <<"SlotRelease", "SlotById", "V1L">>,
   <<"RouteDeleteAuthority", "RouteCleansOnLost", "V1L">>, <<"InputKept", "OrphanStagingUnheld", "OR">>,
   <<"InputKept", "NoWriteWindow", "V2L">>, <<"NoPublishAfterDelete", "DeleteKeepsRow", "V2D">>,
   <<"NoPublishAfterNon200", "WaitForStoreDeadline", "V1L">>, <<"GrantBound", "AbsGrant", "SK">>,
   <<"GrantGround", "CompleteBeforeLanding", "V2D">>, <<"V1Answer", "CompleteBeforeLanding", "V1L">>,
   <<"ChargeOnce", "ChargeTwice", "V1L">>, <<"RestoredInert", "StartNoK3", "RS2">>,
   <<"Q4", "RestoredAnswers500", "RS">>, <<"RecordDropSafe", "MaintDropsRecord", "MT">>,
   <<"RecordDropSafe", "ReleaseK3Stops", "RS2">>, <<"RecordDropSafe", "ShortRecord", "V2K">>,
   <<"SingleStaging", "NoStagedMark", "V1L">>, <<"PendingStarts", "LongAlarm", "L1">>,
   <<"RecordsCleared", "MaintNoRetry", "L2">>, <<"ContainersStopped", "StopNoRetry", "L1">>,
   <<"InputsDeleted", "AgedKeepsInput", "L2">>, <<"SlotsReleased", "NoExpiry", "L3">>,
   <<"ContainerCovered", "K3FreesSlot", "RS2">>, <<"SlotRelease", "K3FreesSlot", "RS2">>,
   <<"RestoredInert", "QueueNoFence", "RS3">>, <<"StartNeedsSlot", "AbsStart", "SK">>,
   <<"V1Answer", "ShortGrace", "V1L">>, <<"NoLateObject", "EarlyRetire", "DLW">>,
   <<"InputsDeleted", "SweepNoIncoming", "L2">>, <<"CompletedSwept", "DoneNeverSwept", "L2">>,
   <<"ChargeOnce", "NoCharge", "V1L">>, <<"SlotRelease", "K3FreesSlotAtGrant", "RS2">>,
   <<"V1Answer", "Done503", "V1L">>, <<"V1Answer", "RestoredAnswers200", "RS">>,
   <<"CompletedSwept", "LateSweep", "L2">>, <<"ContainerCovered", "GrantedLapses", "CAP4">>,
   <<"MaxContainers", "GrantedLapses", "CAP4">>, <<"ConfirmFenced", "ConfirmNoFence", "CAP4">>,
   <<"RecordDropSafe", "AgeBeforeHardHold", "MT">>, <<"V1Answer", "LateRestored200", "RS">>,
   <<"ContainerCovered", "RestoreDropsGrant", "RSB">>, <<"StartNeedsSlot", "W3AbsStart", "RS2">>,
   <<"MaintInert", "MaintConfirmsDone", "MT2">>, <<"NoLateObject", "RetireIgnoresPurge", "DLW">>,
   <<"NoLateObject", "DeleteAfterNoPurge", "DLW">>, <<"NoLateObject", "DeleteAfterNoLand", "DLW">>,
   <<"NoLateObject", "QueueNoCap", "DLW">>, <<"NoLateObject", "RetireNoDelete", "DLW">>,
   <<"MaintInert", "DispatchInMaint", "MT2">>, <<"RestoreExact", "RestoreMovesGrant", "RSB">>,
   <<"RestoreExact", "RestoreDropsGrant", "RSB">>, <<"V1Answer", "Route503", "V1L">>,
   <<"V1Answer", "S10IgnoresGc", "V1L">>, <<"ContainerCovered", "K3FreesSlot", "RSB">>,
   <<"NoLateObject", "SharedEarlyPurge", "V2D">>, <<"StartNeedsSlot", "MoveStartDeadline", "V2K">>,
   <<"V1Answer", "GiveUp200", "V1L">>, <<"NoPublishAfterNon200", "NoDoomAtCut", "H1W">>,
   <<"OwnerGetHasFiles", "CompleteBeforeLanding", "V2D">>, <<"V1Answer", "GiveUpOverReply", "V1L">>,
   <<"NoPublishAfterNon200", "ClockOnlyW5", "V1L">>}

=============================================================================
