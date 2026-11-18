--------------------------- MODULE CollectionConsent ---------------------------
(***************************************************************************)
(* A local account L's consent to membership in a remote owner R's         *)
(* collection C (#1589), with R running Mastodon v4.7.5: the oracle        *)
(* Kopje's implementation is held to                                       *)
(* (test-node/collection-consent-spec.test.ts checks it with tla-ts;       *)
(* scripts/tlc-check.mjs with TLC).                                        *)
(*                                                                         *)
(* Kopje's rules are CollectionConsentKopje.tla's operators, each with its *)
(* reason; R's follow Mastodon v4.7.5, cited per action below. Mastodon    *)
(* paths are at tag v4.7.5 and Kopje's are under packages/kopje/; a bare   *)
(* ":n" cites another line of the file cited just before it. R1, R38 and   *)
(* R45 are docs/visibility.md's rules, and F3, ID-7 and RES-4              *)
(* docs/threat-model.md's. F7 and F8 are the two ways R may keep an        *)
(* authorization Kopje no longer serves, which CorrectiveRevocation        *)
(* excuses: F7, every Delete of it was refused at a full backlog or given  *)
(* up after its last attempt; F8, once Kopje holds no row of it, the       *)
(* Delete that answers a listing of it is ordinary, so a full backlog      *)
(* refuses it.                                                             *)
(*                                                                         *)
(* ATOMICITY. Each action is one indivisible step:                         *)
(*  - KRecv: one inbound activity, one Store transaction                   *)
(*    (Store.receiveActivity, src/store.ts:357); a 503 rolls it back and   *)
(*    the envelope stays for R's retry. An actor Delete writes R's         *)
(*    tombstone and runs the first batch of R's purge in that transaction  *)
(*    (inbox.ts startActorDeletion). A FeatureRequest for a collection     *)
(*    Kopje does not store is answered with the Store's need to fetch      *)
(*    (src/federation/inbound.ts, the `need` loop) and writes nothing; the *)
(*    fetch, a GET of R's state at that moment, is merged into that step.  *)
(*    KApplyFetch is the resumed activity's own Store transaction, which   *)
(*    gives the final status.                                              *)
(*  - KClaim / KFetch / KApply: a read's claim (claimCollectionSync,       *)
(*    src/domain/remote-collections.ts:309), its page GETs                 *)
(*    (src/federation/collections.ts:303-343, one per page; one step for   *)
(*    both pages where C cannot move between them), and its completion     *)
(*    (completeCollectionRead, remote-collections.ts:452): three or four   *)
(*    steps, as Kopje splits them (syncCollections,                        *)
(*    src/federation/collections.ts:459-518). KLease ends a read's lease,  *)
(*    which alone fences nothing: a new claim then replaces the read's     *)
(*    token (roundAccount, remote-collections.ts:402), and KStale is the   *)
(*    stale read's late completion.                                        *)
(*  - KRevoke, KBlock, KMemberGone, KSuspend, KUnsuspend, KCleanup,        *)
(*    KEvict, KPurge: one Store call each (the member's revoke and         *)
(*    severCollections, src/domain/collections.ts:812; the account's       *)
(*    changes; pruneCollectionItems, src/store-rpc.ts:463; the eviction in *)
(*    the insert that needs the place; one later batch of R's purge).      *)
(*  - KDeliver / KDup / KGiveUp / KRetry: the POST of the head of Kopje's  *)
(*    lane to R's server (claimDeliveries and confirmDelivery,             *)
(*    src/store-rpc.ts:654-655; a lane is the sender and the inbox's       *)
(*    origin, delivered in id order, deliveries.ts:71), the same POST with *)
(*    its response lost, its give-up after the last attempt, and an        *)
(*    operator's retry (retryDeliveries, src/store-rpc.ts:658), admitted   *)
(*    again only if it fits (deliveries.ts:3525). R's inbox answers 202    *)
(*    and queues a job; RJob is one Sidekiq job, and jobs run in any       *)
(*    order.                                                               *)
(*  - RAdd, RRemove, RDeleteC, RCleanup, RDeleteSelf, RPurge, RUpdate: one *)
(*    request or service call of R. A distribution job's delay is a        *)
(*    delivery delay, and a job that reaches no one or finds its item gone *)
(*    is a dropped envelope (Drop), so R's sends go straight into toK.     *)
(*                                                                         *)
(* BOUNDS. One owner R (plus X on R's server, scenario S4), one member L,  *)
(* one focal collection C (filler collections abstracted to C's page), two *)
(* requests r1, r2 (items I1, I2), two authorizations a1, a2; every other  *)
(* count is a per-scenario budget (Bud). R's envelopes in flight are a     *)
(* set, so equal envelopes merge; duplicates come from KRecv's lost        *)
(* response. Kopje's lane is a sequence and R's jobs a bag. Steps that     *)
(* would need a third authorization or a second instrument fetch are       *)
(* disabled. R's purge batches reach C at once or later, never part of it. *)
(* No fairness: any message may wait for ever or be dropped.               *)
(*                                                                         *)
(* INVARIANTS:                                                             *)
(*  - GrantPreservation GP1 /\ GP2: while L's committed Accept of a has no *)
(*    evidence event since (R's Remove of C processed, R's tombstone, L's  *)
(*    revoke, block or deletion), Kopje holds C and L's accepted row with  *)
(*    a, and every Accept it records carries a; no Delete of a is recorded *)
(*    while a's row is accepted. The obligation is a ghost: set by the     *)
(*    first Accept a step records, kept until one of the evidence steps    *)
(*    listed clears it, whatever the step does to the row.                 *)
(*  - CorrectiveRevocation CR1 /\ CR2 /\ CR3: an item Add, or an applied   *)
(*    read listing, of an unserved a is answered with L's Delete of a to   *)
(*    the sender's inbox while L is available; only an ordinary Delete is  *)
(*    refused at a full backlog (F8); at quiescence (no read of R still    *)
(*    requested either) R holds an unserved a only if every Delete of a in *)
(*    flight when R applied its acceptance, or recorded since, was refused *)
(*    at a full backlog or given up (F7): a processed Delete that left R   *)
(*    holding a counts against it.                                         *)
(*  - ObservedVisibility OV1 /\ OV2 /\ OV3: only an eligible untruncated   *)
(*    read, an exact item Remove, a re-accept by another request, the      *)
(*    row's end or a loss of availability hides it; at quiescence after    *)
(*    the latest read that covered the row (applied with L available) and  *)
(*    with R unchanged since, a row it listed is shown unless an allowed   *)
(*    hide followed, and a shown row was listed unless something showed it *)
(*    since (a push, an instrument, L's unsuspension), the listing was     *)
(*    truncated or the read was fenced; that latest covering read changes  *)
(*    only at a read that covers the row.                                  *)
(*  - MemberAvailability: while L is unavailable, Kopje records no answer  *)
(*    for it, neither creates nor lists its row, and changes nothing of    *)
(*    the row at a read, and R receives no activity of L's but a Delete.   *)
(*  - RemovalFinality: after R's Remove of C is processed, while its       *)
(*    retraction lives, Kopje holds neither C nor a row of it and records  *)
(*    no Accept.                                                           *)
(*  - GoneFinality: from R's tombstone on, Kopje stores no C anew, creates *)
(*    no row and records no Accept.                                        *)
(*  - NoUnilateralEnd: no Reject of a request Kopje accepted with a is     *)
(*    recorded while a is owed.                                            *)
(*                                                                         *)
(* GRANT PRESERVATION IS INDUCTIVE (CollectionConsentInd.tla checks it).   *)
(* Per action: Decide and ApplyFetch create a row only with its Accept,    *)
(* which sets the obligation, and answer an accepted row with its own      *)
(* authorization; every other K1-K4 branch and K14's listing part change   *)
(* uri, retractions or sync only, and record a Delete only when no         *)
(* accepted row has its authorization (GP2); deleteUnlisted deletes C only *)
(* with no row; K5 and K9 delete the row with the evidence that clears the *)
(* obligation; K6 tombstones R with it, and the purge (its first batch     *)
(* included) deletes only under the tombstone; K7 and K8 retire the row    *)
(* and clear it in one step; K10 and the eviction delete only a retired    *)
(* row; every R, network and environment action leaves Kopje's core        *)
(* unchanged.                                                              *)
(***************************************************************************)
EXTENDS CollectionConsentKopje, TLC, Sequences

CONSTANT Scenario

VARIABLES
  k,      \* Kopje's core (CollectionConsentKopje.tla, CoreType)
  env,    \* the environment Kopje decides in (EnvType)
  kq,     \* Kopje's lane to R's server: recorded activities in id order, the head posted next
  kg,     \* given up: refused at a full backlog, or after the last attempt
  toK,    \* R's envelopes in flight to Kopje (R retries until delivered or dropped)
  rs,     \* R's server (Mastodon v4.7.5)
  rin,    \* R's queued jobs: a bag of Kopje's delivered activities
  rd,     \* the current read of R's collections
  sr,     \* a stale read: its lease ran out and a new claim replaced its token before it completed
  fe,     \* the pending instrument fetch
  spent,  \* budget counters
  g,      \* history the invariants and goals read
  last    \* the step: action, input, recorded activities, response, events (fixtures and traps only)

vars == <<k, env, kq, kg, toK, rs, rin, rd, sr, fe, spent, g, last>>

(***************************************************************************)
(* Scenarios: each enables a focused set of actions through its budgets.   *)
(* S1 answers and re-adds; S2 revoke and correction (C on page 1 or past   *)
(* the window); S3 pages that shift between a read's GETs; S4 the          *)
(* cross-owner Delete, and R's Remove and Update after a revoke; S5 stale  *)
(* and outdated reads against pushes; S6 block and member deletion; S7     *)
(* late and retried answers; S8 the instrument, R's Remove of C, the       *)
(* retraction cap and expiry, R gone; S9 admission at 10 and 50 and        *)
(* truncated listings; S10 the 25 slots; S11 the early eviction and        *)
(* Mastodon's 24-hour cleanup against a late Accept; S12 L's suspension;   *)
(* S13 recovery from the 50; S14 a stale request copy and the read that    *)
(* restores what it hid; S15 an ignored round, then a stale completion.    *)
(***************************************************************************)
Budgets == {"adds", "reads", "dup", "retry", "consent", "backlog", "cap", "held", "slots", "remove", "rclean",
            "upd", "x", "revoke", "block", "ldel", "susp", "rdelc", "gone", "shift", "crowd", "lease", "expire"}
Zero == [f \in Budgets |-> 0]
Bud(f) ==
  CASE Scenario = "S1" -> [Zero EXCEPT !.adds = 2, !.remove = 1, !.consent = 1, !.dup = 1][f]
    [] Scenario = "S2" -> [Zero EXCEPT !.adds = 1, !.reads = 1, !.dup = 1, !.backlog = 1, !.revoke = 1][f]
    [] Scenario = "S3" -> [Zero EXCEPT !.adds = 1, !.reads = 2, !.shift = 1][f]
    [] Scenario = "S4" -> [Zero EXCEPT !.adds = 1, !.x = 1, !.revoke = 1, !.remove = 1, !.upd = 1][f]
    [] Scenario = "S5" -> [Zero EXCEPT !.adds = 1, !.reads = 2, !.remove = 1, !.upd = 1, !.lease = 1][f]
    [] Scenario = "S6" -> [Zero EXCEPT !.adds = 1, !.reads = 1, !.block = 1, !.ldel = 1][f]
    [] Scenario = "S7" -> [Zero EXCEPT !.adds = 1, !.reads = 1, !.retry = 1][f]
    [] Scenario = "S8" -> [Zero EXCEPT !.adds = 1, !.reads = 1, !.rdelc = 1, !.cap = 2, !.expire = 1, !.gone = 1][f]
    [] Scenario = "S9" -> [Zero EXCEPT !.adds = 1, !.reads = 1, !.crowd = 2, !.held = 1, !.upd = 1][f]
    [] Scenario = "S10" -> [Zero EXCEPT !.adds = 1, !.dup = 1, !.slots = 2][f]
    [] Scenario = "S11" -> [Zero EXCEPT !.adds = 1, !.revoke = 1, !.rclean = 1, !.backlog = 1, !.dup = 1][f]
    [] Scenario = "S12" -> [Zero EXCEPT !.adds = 1, !.reads = 1, !.susp = 2, !.dup = 1, !.remove = 1][f]
    [] Scenario = "S13" -> [Zero EXCEPT !.adds = 1, !.dup = 1, !.held = 2][f]
    [] Scenario = "S14" -> [Zero EXCEPT !.adds = 2, !.remove = 1, !.reads = 1][f]
    [] Scenario = "S15" -> [Zero EXCEPT !.adds = 1, !.reads = 3, !.lease = 1, !.upd = 1][f]
\* Kopje starts without C where the instrument, admission and R's Remove of C are checked.
StartsWithC == Scenario \notin {"S8", "S9", "S13"}
\* C's place in R's featured collections at the start: on page 1, page 2 (S3, where it moves), or past the window.
StartPages == CASE Scenario \in {"S2", "S6"} -> {"p1", "past"} [] Scenario = "S3" -> {"p2"} [] OTHER -> {"p1"}
\* S3 splits a read into its page GETs, so C can move across the page boundary between them.
SplitPages == Scenario = "S3"
\* S11 lets C reach its 50 stored rows, where a new row evicts L's retired one.
Evicts == Scenario = "S11"
Can(f) == spent[f] < Bud(f)
Spend(f) == spent' = [spent EXCEPT ![f] = @ + 1]

\* The scenario checks fingerprint states without `last`, which records how a state was reached, not what it is, and
\* without the given-up deliveries once no operator retry is left to send them again. No action reads either.
View == <<k, env, kq, IF Can("retry") THEN kg ELSE {}, toK, rs, rin, rd, sr, fe, spent, g>>

(***************************************************************************)
(* Messages and records.                                                   *)
(***************************************************************************)
Envelope(ty, r, i, a, l) == [ty |-> ty, r |-> r, i |-> i, a |-> a, l |-> l]
EFR(r) == Envelope("FR", r, NONE, NONE, NoListing)
EAdd(i, a) == Envelope("Add", NONE, i, a, NoListing)
ERem(i) == Envelope("Rem", NONE, i, NONE, NoListing)
EUpd(l) == Envelope("Upd", NONE, NONE, NONE, l)
ERemC == Envelope("RemC", NONE, NONE, NONE, NoListing)
EDelR == Envelope("DelR", NONE, NONE, NONE, NoListing)
EXAdd(a) == Envelope("XAdd", NONE, "IX", a, NoListing)
NoEnvelope == Envelope(NONE, NONE, NONE, NONE, NoListing)
NoIntent == [ty |-> NONE, obj |-> NONE, res |-> NONE, to |-> NONE, cls |-> NONE, why |-> NONE]
Arg(e, m, v) == [env |-> e, msg |-> m, val |-> v]
NoArg == Arg(NoEnvelope, NoIntent, NONE)

NoItem == [req |-> NONE, st |-> NONE, ap |-> NONE]
NoView == [seen |-> FALSE, i |-> NONE, a |-> NONE, tr |-> FALSE, cpl |-> FALSE]
\* exp: the read's lease ran out (a new claim may replace its token); rq: a read was requested since its claim.
NoRead == [ph |-> "none", v |-> NoView, chg |-> FALSE, outd |-> FALSE, rch |-> FALSE, hadRow |-> FALSE, exp |-> FALSE,
           rq |-> FALSE]
NoFetch == [on |-> FALSE, r |-> NONE, ex |-> FALSE, l |-> NoListing]
\* OV2's latest applied read: what it listed, whether it was truncated or fenced, and what changed since: R (rch), a
\* show OV2 allows (kshow: a push, an instrument, L's unsuspension), or a hide OV1 allows other than a read's (khide).
NoLastRead == [valid |-> FALSE, i |-> NONE, a |-> NONE, tr |-> FALSE, fenced |-> FALSE, rch |-> FALSE,
               kshow |-> FALSE, khide |-> FALSE]

\* R's job queue, a bag: each activity with its number of queued copies.
EmptyBag == [x \in {} |-> 0]
BagCount(b, m) == IF m \in DOMAIN b THEN b[m] ELSE 0
BagAdd(b, m) == [x \in DOMAIN b \cup {m} |-> IF x = m THEN BagCount(b, m) + 1 ELSE b[x]]
BagRemove(b, m) == [x \in {y \in DOMAIN b : y # m \/ b[y] > 1} |-> IF x = m THEN b[x] - 1 ELSE b[x]]

\* R's FeaturedCollection lists L's accepted item with its approval (featured_collection_serializer.rb:14, :56-58;
\* featured_item_serializer.rb:22-28). rs.crowd: more than 25 entries, with L's within the first 25 or past them, which
\* single adds allow (add_account_to_collection_service.rb:23-26; collection.rb:57, :112-114 check only the
\* collection's own save).
RListing ==
  IF rs.item.st = "acc" /\ rs.crowd # "past"
  THEN [i |-> ItemOf(rs.item.req), a |-> rs.item.ap, tr |-> rs.crowd = "within"]
  ELSE [i |-> NONE, a |-> NONE, tr |-> rs.crowd # "none"]
\* R serves C (its pages, its instrument) while C exists and R's account is not being deleted (a suspended account's
\* documents answer 410).
RServes == rs.c /\ ~rs.gone

\* RES-4: an ordinary intent is refused at a full backlog (recorded as given up). VARIANT V9: a retraction too.
Refused(m) == env.bl /\ (m.cls = "ord" \/ (Variant = "V9" /\ m.ty = "Delete"))
\* A Delete of a: R's server revokes L's item approved by a, whichever of its inboxes it reaches (delete.rb:5-6,
\* :68-81: the item is found by approval_uri and its member alone).
Corrects(m, a) == m.ty = "Delete" /\ m.obj = a
\* The corrections of a in Kopje's lane or R's job queue.
InFlight(a) ==
  Cardinality({i \in 1..Len(kq) : Corrects(kq[i], a)})
    + Cardinality(UNION {{<<m, j>> : j \in 1..rin[m]} : m \in {x \in DOMAIN rin : Corrects(x, a)}})

\* Nothing in flight, and no read of R still requested.
Quiescent == toK = {} /\ rin = EmptyBag /\ kq = <<>> /\ rd.ph = "none" /\ sr.ph = "none" /\ ~fe.on /\ ~k.sync

(***************************************************************************)
(* Init.                                                                   *)
(***************************************************************************)
Init ==
  /\ k = [c |-> StartsWithC, row |-> NoRow, issued |-> 0, lx |-> TRUE, ls |-> FALSE, rk |-> TRUE, lblk |-> FALSE,
          ret |-> {}, sync |-> FALSE]
  \* S1 starts with either policy, so a request can be refused before L consents (F3).
  /\ env \in {[consent |-> c, slots |-> FALSE, held |-> "lt10", bl |-> FALSE, cap |-> FALSE] :
               c \in IF Scenario = "S1" THEN BOOLEAN ELSE {TRUE}}
  /\ kq = <<>> /\ kg = {} /\ toK = {} /\ rin = EmptyBag
  /\ rs \in {[c |-> TRUE, item |-> NoItem, adds |-> 0, kb |-> FALSE, la |-> TRUE, pos |-> p, crowd |-> "none",
              gone |-> FALSE] : p \in StartPages}
  /\ rd = NoRead /\ sr = NoRead /\ fe = NoFetch
  /\ spent = Zero
  /\ g = [obl |-> NONE, accReq |-> {}, delServed |-> FALSE, refusedHeld |-> FALSE, missed |-> FALSE, ov1 |-> FALSE,
          nue |-> FALSE, nueLive |-> FALSE, rot |-> FALSE, avail |-> FALSE, rejected |-> {}, accAfterRem |-> FALSE,
          remLive |-> FALSE, afterGone |-> FALSE, unexcused |-> [a \in Auths |-> 0], tick |-> FALSE, held503 |-> FALSE,
          o7 |-> FALSE, lastRd |-> NoLastRead, ign |-> FALSE, lrMoved |-> FALSE, fo |-> FALSE]
  /\ last = [act |-> "Init", arg |-> NoArg, rec |-> {}, resp |-> 0, ev |-> {}]

(***************************************************************************)
(* One Kopje step. res: a CollectionConsentKopje operator's result. evid:  *)
(* the step is an evidence event that ends L's grant (GrantPreservation).  *)
(* opp: the correction the step owes, [a, to] for an item Add or an        *)
(* applied read listing that names an unserved a while L exists, or NONE   *)
(* (CR1). mayHide: the step is of a kind that may hide the row (OV1).      *)
(* allowedHide: it is a hide OV1 allows other than a read's (OV2's khide). *)
(* mayShow: a show by this step is one OV2 allows (its kshow): every step  *)
(* but a stale read's completion. outdNow: a valid push of R's             *)
(* collections, which outdates a read under way. remC: R's Remove of C     *)
(* succeeded. ev: the step's events.                                       *)
(***************************************************************************)
NoOpp == [a |-> NONE, to |-> NONE]
Accepted(rec) == {m \in rec : m.ty = "Accept"}
\* The ghost obligation after a step: the first Accept's authorization, kept until an evidence event, which clears it.
\* No step is both.
OblAfter(rec, evid) ==
  IF evid THEN NONE ELSE IF g.obl # NONE \/ Accepted(rec) = {} THEN g.obl ELSE (CHOOSE m \in Accepted(rec) : TRUE).res
\* The requests Kopje accepted with the owed authorization.
AccReqAfter(rec, evid) ==
  IF evid THEN {}
  ELSE IF Accepted(rec) = {} THEN g.accReq
  ELSE LET m == CHOOSE x \in Accepted(rec) : TRUE IN IF g.obl = NONE THEN {m.obj} ELSE g.accReq \cup {m.obj}
\* An Accept that carries an authorization other than the one owed (GP1).
Rotated(rec, evid) == ~evid /\ g.obl # NONE /\ \E m \in Accepted(rec) : m.res # g.obl
\* A step that, while L is unavailable, records an answer for L, or creates or lists its row (MemberAvailability).
AvailBroken(res) ==
  /\ ~LAvail(k)
  /\ \/ \E m \in res.rec : m.ty \in {"Accept", "Reject", "Delete"}
     \/ k.row = NoRow /\ res.k.row # NoRow
     \/ res.k.row # NoRow /\ res.k.row.uri \notin {NONE, k.row.uri}
\* R's live item of request r accepted: what a Reject of r would end there.
RLive(r) == rs.item # NoItem /\ rs.item.req = r /\ rs.item.st = "acc" /\ ~rs.gone /\ rs.la

\* How many corrections of a the step queues: refused ones count only under VARIANT V8 (F7 without its F8 excuse).
Queued(rec, a) == Cardinality({m \in rec : Corrects(m, a) /\ (~Refused(m) \/ Variant = "V8")})

GhostK(res, evid, opp, mayHide, allowedHide, mayShow, lr, remC, ev) ==
  LET k2 == res.k
      dels == {m \in res.rec : m.ty = "Delete"}
  IN [g EXCEPT
        !.obl = OblAfter(res.rec, evid),
        !.accReq = AccReqAfter(res.rec, evid),
        !.delServed = @ \/ (\E m \in dels : Served(k2, m.obj)),
        !.refusedHeld = @ \/ (\E m \in dels : Refused(m) /\ HeldRow(k2, m.obj)),
        !.missed = @ \/ (opp.a # NONE /\ ~(\E m \in dels : m.obj = opp.a /\ m.to = opp.to)),
        !.ov1 = @ \/ (Shown(k) /\ ~Shown(k2) /\ ~mayHide),
        !.nue = @ \/ (g.obl # NONE /\ \E m \in res.rec : m.ty = "Reject" /\ m.obj \in g.accReq),
        !.nueLive = @ \/ (g.obl # NONE /\ \E m \in res.rec : m.ty = "Reject" /\ m.obj \in g.accReq /\ RLive(m.obj)),
        !.rot = @ \/ Rotated(res.rec, evid),
        !.avail = @ \/ AvailBroken(res),
        !.rejected = @ \cup {m.obj : m \in {x \in res.rec : x.ty = "Reject"}},
        !.accAfterRem = @ \/ (g.remLive /\ Accepted(res.rec) # {}),
        !.remLive = @ \/ remC,
        !.afterGone = @ \/ (~k.rk /\ ((k2.c /\ ~k.c) \/ (k2.row # NoRow /\ k.row = NoRow) \/ Accepted(res.rec) # {})),
        !.unexcused = [a \in Auths |-> @[a] + Queued(res.rec, a)],
        !.tick = k2.row # k.row,
        !.held503 = @ \/ "held503" \in ev,
        !.o7 = @ \/ "o7" \in ev,
        !.fo = @ \/ "outdRead" \in ev,
        !.lastRd = [lr EXCEPT !.kshow = @ \/ (mayShow /\ Shown(k2) /\ ~Shown(k)),
                             !.khide = @ \/ (allowedHide /\ ~Shown(k2))]]

\* A read under way sees Kopje's changes of the row (its fence), valid pushes (outdated) and requests of a read, apart.
Touch(read, res, outdNow) ==
  IF read.ph = "none" THEN read
  ELSE [read EXCEPT !.chg = @ \/ (res.k.row # k.row), !.outd = @ \/ outdNow, !.rq = @ \/ res.req]
\* The step makes a read under way outdated (a trap's event).
Outdates(res, outdNow) == \E x \in {rd, sr} : x.ph # "none" /\ ~x.outd /\ Touch(x, res, outdNow).outd

Events(res, extra) ==
  extra \cup (IF Shown(k) /\ ~Shown(res.k) /\ res.k.row.st = "acc" THEN {"hid"} ELSE {})
        \cup (IF ~Shown(k) /\ Shown(res.k) THEN {"showed"} ELSE {})
        \cup (IF k.row = NoRow /\ res.k.row # NoRow THEN {"newRow"} ELSE {})
        \cup (IF \E m \in res.rec : m.ty = "Delete" /\ Refused(m) /\ ~HeldRow(res.k, m.obj) THEN {"f8"} ELSE {})

\* The step's activities in the order it records them: a Delete before the Block it goes with.
RecSeq(rec) ==
  LET dels == {m \in rec : m.ty = "Delete"}
      one(s) == IF s = {} THEN <<>> ELSE <<CHOOSE m \in s : TRUE>>
  IN one(dels) \o one(rec \ dels)

Record(res) ==
  /\ k' = res.k
  /\ kq' = kq \o RecSeq({m \in res.rec : ~Refused(m)})
  /\ kg' = kg \cup {m \in res.rec : Refused(m)}

Commit(res, evid, opp, mayHide, allowedHide, outdNow, remC, act, arg, extra) ==
  LET ev == Events(res, extra) IN
  /\ Record(res)
  /\ g' = GhostK(res, evid, opp, mayHide, allowedHide, TRUE, g.lastRd, remC, ev)
  /\ rd' = Touch(rd, res, outdNow)
  /\ sr' = Touch(sr, res, outdNow)
  /\ last' = [act |-> act, arg |-> arg, rec |-> res.rec, resp |-> res.resp, ev |-> ev]

\* A step that would create a row with a third authorization lies past the bound.
PastBound == NeedsAuth(k, env)

\* A re-accept by another request (the row takes the request, its uri cleared): the one decision that hides.
ReAccept(res) == Accepted(res.rec) # {} /\ k.row.st = "acc" /\ res.k.row.req # k.row.req

(***************************************************************************)
(* KRecv: Kopje processes an envelope from toK. dup: its response is lost, *)
(* so it stays in toK and R sends it again (a duplicate delivery).         *)
(***************************************************************************)
Pushes == {"Add", "Rem", "Upd", "RemC"}

\* Activities of an owner gone at Kopje are ignored; a request for an unavailable member is (Decide's gate). first:
\* an actor Delete's first purge batch reaches C (OwnerGone).
RecvRes(e, first) ==
  IF ~k.rk /\ e.ty # "XAdd" THEN Res(k, {}, 202)
  ELSE CASE e.ty = "FR" -> Decide(k, env, e.r)
         [] e.ty = "Add" -> AddItem(k, env, e.i, e.a, "R")
         [] e.ty = "XAdd" -> AddItem(k, env, e.i, e.a, "X")
         [] e.ty = "Rem" -> RemoveItem(k, env, e.i)
         [] e.ty = "Upd" -> UpdateCollection(k, env, e.l)
         [] e.ty = "RemC" -> RemoveCollection(k, env)
         [] e.ty = "DelR" -> OwnerGone(k, first)

\* A FeatureRequest for a collection Kopje does not store: the Store asks for the instrument, fetched now.
NeedsFetch(e) == e.ty = "FR" /\ ~k.c /\ Decides(k) /\ k.rk

Consume(e, dup, resp) == toK' = IF dup \/ resp = 503 THEN toK ELSE toK \ {e}

KRecv(e, dup) ==
  /\ e \in toK
  /\ IF dup THEN Can("dup") /\ Spend("dup") ELSE UNCHANGED spent
  /\ IF NeedsFetch(e)
     THEN /\ Consume(e, dup, 202)
          /\ UNCHANGED <<k, env, kq, kg, rs, rin, rd, sr, g>>
          /\ IF "C" \in k.ret
             THEN \* R retracted C: the request is ignored.
                  /\ UNCHANGED fe
                  /\ last' = [act |-> "KRecv", arg |-> Arg(e, NoIntent, NONE), rec |-> {}, resp |-> 202,
                              ev |-> IF g.remLive THEN {"rfGuard"} ELSE {}]
             ELSE /\ ~fe.on
                  /\ fe' = [on |-> TRUE, r |-> e.r, ex |-> RServes, l |-> RListing]
                  /\ last' = [act |-> "KRecv", arg |-> Arg(e, NoIntent, NONE), rec |-> {}, resp |-> FETCH,
                              ev |-> {"fetch"}]
     ELSE \E first \in (IF e.ty = "DelR" /\ k.rk THEN BOOLEAN ELSE {FALSE}) :
          LET res == RecvRes(e, first)
              valid == k.rk /\ res.resp = 202
              opp == IF e.ty = "XAdd" /\ Lists(k) /\ ~Served(k, e.a) THEN [a |-> e.a, to |-> "X"]
                     ELSE IF e.ty = "Add" /\ k.rk /\ Lists(k) /\ ~Served(k, e.a) THEN [a |-> e.a, to |-> "R"]
                     ELSE NoOpp
              \* For an actor Delete, whether its first purge batch reached C: the replay seeds R with other content
              \* to purge before C for "deferred".
              val == IF e.ty = "DelR" /\ k.rk THEN IF first THEN "purged" ELSE "deferred" ELSE NONE
              allowed == (e.ty = "FR" /\ ReAccept(res)) \/ (e.ty = "Rem" /\ k.row # NoRow /\ k.row.uri = e.i)
              \* Order 7: a copy of an earlier request, accepted again, takes the row and clears its uri, hiding a row R
              \* still lists.
              o7 == e.ty = "FR" /\ Shown(k) /\ ~Shown(res.k) /\ rs.item.st = "acc" /\ rs.item.ap = k.row.auth
              extra == (IF res.resp = 503 THEN {"503"} ELSE {})
                         \cup (IF res.resp = 503 /\ e.ty = "RemC" /\ k.c THEN {"held503"} ELSE {})
                         \cup (IF o7 THEN {"o7"} ELSE {})
          IN /\ ~(e.ty = "FR" /\ PastBound)
             /\ Commit(res, valid /\ e.ty \in {"RemC", "DelR"}, opp, allowed \/ e.ty \in {"RemC", "DelR"}, allowed,
                       valid /\ e.ty \in Pushes, valid /\ e.ty = "RemC", "KRecv", Arg(e, NoIntent, val), extra)
             /\ Consume(e, dup, res.resp)
             /\ UNCHANGED <<env, rs, rin, fe>>

\* K1b: the instrument fetched by KRecv applied, in the resumed activity's own transaction.
KApplyFetch ==
  /\ fe.on
  /\ ~PastBound
  /\ LET res == ApplyFetch(k, env, fe)
         \* The instrument stored C: a change of R's collections a read under way does not hold.
         stored == ~k.c /\ res.k.c
     IN Commit(res, FALSE, NoOpp, ReAccept(res), ReAccept(res), stored, FALSE, "KApplyFetch",
               Arg(Envelope("Instrument", fe.r, fe.l.i, fe.l.a, fe.l), NoIntent, IF fe.ex THEN "served" ELSE "gone"),
               (IF "C" \in k.ret /\ g.remLive THEN {"rfGuard"} ELSE {})
                 \cup (IF k.c /\ k.rk /\ LAvail(k) THEN {"existing"} ELSE {})
                 \cup (IF Outdates(res, stored) THEN {"outdRead"} ELSE {}))
  /\ fe' = NoFetch
  /\ UNCHANGED <<env, toK, rs, rin, spent>>

KMemberArg(res, evid, f, act, arg) ==
  /\ Can(f) /\ Spend(f)
  /\ Commit(res, evid, NoOpp, TRUE, FALSE, FALSE, FALSE, act, arg, {})
  /\ UNCHANGED <<env, toK, rs, rin, fe>>
KMember(res, evid, f, act) == KMemberArg(res, evid, f, act, NoArg)

\* L's own acts, while it can sign in (not suspended).
KRevoke == k.row.st = "acc" /\ ~k.ls /\ KMember(Revoke(k), TRUE, "revoke", "KRevoke")
KBlock == ~k.lblk /\ k.lx /\ ~k.ls /\ KMember(Block(k), TRUE, "block", "KBlock")
\* Model-only: Kopje deletes no local account (src/federation/delivery-hosts.ts:63), so no fixture takes this step.
KMemberGone == k.lx /\ KMember(MemberGone(k), TRUE, "ldel", "KMemberGone")
KSuspend == k.lx /\ ~k.ls /\ KMember(Suspend(k), FALSE, "susp", "KSuspend")
\* The suspension moves L's credential epoch and its lifting keeps it, so L reads with a credential issued after the
\* lifting (suspension.ts suspendLocal, unsuspendLocal): the step's input "newCredential".
KUnsuspend == k.ls /\ KMemberArg(Unsuspend(k), FALSE, "susp", "KUnsuspend", Arg(NoEnvelope, NoIntent, "newCredential"))

\* The retired row's cleanup (pruneCollectionItems). VARIANT V16: it also deletes the row's Delete whenever that is
\* still the head of the lane.
HeadDelete == kq # <<>> /\ Head(kq).ty = "Delete" /\ Head(kq).obj = k.row.auth
KCleanup ==
  /\ k.row.st = "ret"
  /\ Commit(Cleanup(k), FALSE, NoOpp, TRUE, FALSE, FALSE, FALSE, "KCleanup", NoArg, {})
  /\ UNCHANGED <<env, toK, rs, rin, fe, spent>>
KCleanupV16 ==
  /\ k.row.st = "ret" /\ HeadDelete
  /\ k' = Cleanup(k).k /\ kq' = Tail(kq) /\ kg' = kg
  /\ g' = GhostK(Cleanup(k), FALSE, NoOpp, TRUE, FALSE, TRUE, g.lastRd, FALSE, {})
  /\ rd' = Touch(rd, Cleanup(k), FALSE) /\ sr' = Touch(sr, Cleanup(k), FALSE)
  /\ last' = [act |-> "KCleanup", arg |-> NoArg, rec |-> {}, resp |-> 0, ev |-> {}]
  /\ UNCHANGED <<env, toK, rs, rin, fe, spent>>

\* The early eviction of L's retired row, when a new row comes into C at its 50 stored rows: one transaction with that
\* insertion, which the replay makes real (C holding 50 rows, L's retired one the oldest, then another member's row
\* inserted; the step's input "insertAt50").
KEvict ==
  /\ Evicts /\ k.row.st = "ret"
  /\ Commit(Evict(k), FALSE, NoOpp, TRUE, FALSE, FALSE, FALSE, "KEvict", Arg(NoEnvelope, NoIntent, "insertAt50"), {})
  /\ UNCHANGED <<env, toK, rs, rin, fe, spent>>

\* One batch of R's purge after its tombstone that reaches C: its read request, C and its rows.
KPurge ==
  /\ ~k.rk /\ (k.c \/ k.row # NoRow \/ k.sync)
  /\ Commit(OwnerPurge(k), FALSE, NoOpp, TRUE, FALSE, FALSE, FALSE, "KPurge", NoArg, {})
  /\ UNCHANGED <<env, toK, rs, rin, fe, spent>>

\* The environment: L's policy, RES-4's backlog, the retraction cap, C's 25 slots all held by local rows (while C is
\* stored), how many of R's collections Kopje holds.
EnvSet(f, field, value) ==
  /\ Can(f) /\ Spend(f)
  /\ env' = [env EXCEPT ![field] = value]
  /\ last' = [act |-> "Env", arg |-> Arg(NoEnvelope, NoIntent, field), rec |-> {}, resp |-> 0, ev |-> {}]
  /\ UNCHANGED <<k, kq, kg, toK, rs, rin, rd, sr, fe, g>>

EnvStep ==
  \/ EnvSet("consent", "consent", ~env.consent)
  \/ EnvSet("backlog", "bl", ~env.bl)
  \/ EnvSet("cap", "cap", ~env.cap)
  \/ (k.c /\ EnvSet("slots", "slots", ~env.slots))
  \/ \E h \in {"lt10", "lt50", "at50"} \ {env.held} : EnvSet("held", "held", h)

(***************************************************************************)
(* Reads of R's collections: claim, page GETs, completion.                 *)
(***************************************************************************)
\* The claim of a requested read; with none requested (sync false), the request (storing R's actor document) made
\* just before it. The request stays until a completion reads it through (sync true from here). The claim
\* revalidates R (claimCollectionSync claims only an available owner) and writes a new token
\* (remote-collections.ts:345-349). Once a read's lease ran out, a new claim may take the sync: its token replaces the
\* read's, which turns stale (sr; roundAccount, :402). The row fence includes equality: a row changed in the same
\* millisecond as the claim counts as changed at it, so a change by the last Store step before the claim may (g.tick);
\* the step's input is then "sameTime".
KClaim ==
  /\ k.rk /\ Can("reads") /\ Spend("reads")
  /\ \/ rd.ph = "none" /\ UNCHANGED sr
     \/ rd.exp /\ sr.ph = "none" /\ sr' = rd
  /\ \E chg \in {FALSE} \cup (IF g.tick THEN {TRUE} ELSE {}) :
       /\ rd' = [NoRead EXCEPT !.ph = "cl", !.chg = chg, !.hadRow = (Variant = "V3" /\ k.row # NoRow)]
       /\ last' = [act |-> "KClaim", arg |-> Arg(NoEnvelope, NoIntent, IF chg THEN "sameTime" ELSE NONE), rec |-> {},
                   resp |-> 0, ev |-> {}]
  /\ k' = [k EXCEPT !.sync = TRUE]
  /\ g' = [g EXCEPT !.tick = FALSE, !.fo = FALSE]
  /\ UNCHANGED <<env, kq, kg, toK, rs, rin, fe>>

Page(p) == RServes /\ rs.pos = p
Seen(v) == [v EXCEPT !.seen = TRUE, !.i = RListing.i, !.a = RListing.a, !.tr = RListing.tr]
Complete == ~Page("past")

\* A fetch step's input, what R serves: C's listing and its place (p1, p2, past the 2 pages Kopje reads, or absent).
PagesArg ==
  Arg(Envelope("Pages", NONE, NONE, NONE, IF RServes THEN RListing ELSE NoListing), NoIntent,
      IF RServes THEN rs.pos ELSE "absent")

\* Both pages in one step, where C cannot move between them.
KFetch ==
  /\ ~SplitPages /\ rd.ph = "cl"
  /\ LET v == IF RServes /\ rs.pos # "past" THEN Seen(NoView) ELSE NoView IN
     rd' = [rd EXCEPT !.ph = "done", !.rch = FALSE, !.v = [v EXCEPT !.cpl = Complete]]
  /\ last' = [act |-> "KFetch", arg |-> PagesArg, rec |-> {}, resp |-> 0, ev |-> {}]
  /\ UNCHANGED <<k, env, kq, kg, toK, rs, rin, sr, fe, spent, g>>

KFetch1 ==
  /\ SplitPages /\ rd.ph = "cl"
  /\ rd' = [rd EXCEPT !.ph = "p1", !.v = IF Page("p1") THEN Seen(NoView) ELSE NoView, !.rch = FALSE]
  /\ last' = [act |-> "KFetch1", arg |-> PagesArg, rec |-> {}, resp |-> 0, ev |-> {}]
  /\ UNCHANGED <<k, env, kq, kg, toK, rs, rin, sr, fe, spent, g>>

KFetch2 ==
  /\ SplitPages /\ rd.ph = "p1"
  /\ LET now == ~rd.v.seen /\ Page("p2")
         v == IF now THEN Seen(rd.v) ELSE rd.v
     IN rd' = [rd EXCEPT !.ph = "done", !.v = [v EXCEPT !.cpl = Complete], !.rch = IF now THEN FALSE ELSE @]
  /\ last' = [act |-> "KFetch2", arg |-> PagesArg, rec |-> {}, resp |-> 0, ev |-> {}]
  /\ UNCHANGED <<k, env, kq, kg, toK, rs, rin, sr, fe, spent, g>>

\* V2's wait ended: no answer of the row is still in the lane.
Settled == ~(\E i \in 1..Len(kq) : kq[i].ty = "Accept" /\ kq[i].res = k.row.auth)
\* A completion whose listing Kopje applies: R still there, no valid push since the claim, C seen.
Applies(read) == k.rk /\ ~read.outd /\ read.v.seen
\* A completion that covers L's row: it applies, with L available (a read leaves an unavailable member's row as it is).
Covers(read) == Applies(read) /\ LAvail(k)
\* A read's snapshot, as OV2 compares it.
Snap(l) == <<l.valid, l.i, l.a, l.tr, l.fenced>>
\* An untruncated view that omits the accepted row, which an unfenced read would hide.
WouldHide(read) ==
  /\ k.rk /\ k.row.st = "acc" /\ read.v.seen /\ ~read.v.tr
  /\ ~(read.v.i # NONE /\ read.v.a = k.row.auth)

KApply ==
  /\ rd.ph = "done"
  /\ LET res == ApplyRead(k, env, rd.v, rd.chg, rd.outd, rd.hadRow, Settled)
         named == rd.v.i # NONE
         opp == IF Applies(rd) /\ named /\ Lists(k) /\ ~Served(k, rd.v.a) THEN [a |-> rd.v.a, to |-> "R"] ELSE NoOpp
         mayHide == Covers(rd) /\ ~rd.v.tr /\ ~rd.chg /\ ~(named /\ rd.v.a = k.row.auth)
         \* OV2's latest covering read: this one when it covers L's row, else the one before, kept (an outdated read,
         \* one that never saw C, or one made while L was unavailable says nothing of the row).
         \* VARIANT V23: an ignored read (one that does not cover the row, after one that did) records its own
         \* snapshot as the covering read.
         lr == IF Covers(rd) \/ (Variant = "V23" /\ g.lastRd.valid)
               THEN [valid |-> TRUE, i |-> rd.v.i, a |-> rd.v.a, tr |-> rd.v.tr, fenced |-> rd.chg, rch |-> rd.rch,
                     kshow |-> FALSE, khide |-> FALSE]
               ELSE g.lastRd
         \* The request this round read through: none if outdated (its listing is read again); the sync is dropped once
         \* R is gone (roundAccount); a request since the claim stays (endRound).
         sync == IF ~k.rk THEN FALSE ELSE IF rd.outd THEN TRUE ELSE rd.rq
         fence == IF Shown(k) /\ WouldHide(rd)
                  THEN (IF rd.outd /\ ~rd.chg THEN {"fencedPush"} ELSE {})
                         \cup (IF rd.chg /\ ~rd.outd THEN {"fencedRow"} ELSE {})
                  ELSE {}
         \* R gone is the only fence: the read saw C and named L's unlisted row, nothing outdated it, and its token
         \* still holds, so a completion past the fence would list the row.
         gone == IF ~k.rk /\ ~rd.outd /\ rd.v.seen /\ named /\ rd.v.a = k.row.auth /\ k.row.uri = NONE
                 THEN {"goneOnly"} ELSE {}
         \* The round an instrument outdated (g.fo since the claim), R available: it applies nothing and leaves the
         \* request.
         outd == IF k.rk /\ rd.outd /\ g.fo THEN {"outdIgnored"} ELSE {}
         \* An untruncated, unfenced read that omits L's listed row while L is suspended: the row stays as it is.
         susp == IF /\ k.lx /\ k.ls /\ k.rk /\ ~rd.outd /\ rd.v.seen /\ ~rd.v.tr /\ ~rd.chg
                    /\ k.row.st = "acc" /\ k.row.uri # NONE /\ ~(named /\ rd.v.a = k.row.auth) /\ res.k.row = k.row
                 THEN {"suspOmits"} ELSE {}
         \* A read whose lease ran out, applied: no new claim took its token.
         expired == IF rd.exp /\ Covers(rd) THEN {"expiredApplied"} ELSE {}
         ev == Events(res, fence \cup gone \cup outd \cup susp \cup expired
                             \cup IF KeptByRow(k, rd.v, rd.outd) THEN {"kept"} ELSE {})
         \* OV3, apart from how lr is chosen: a read that does not cover the row leaves the covering read before it.
         moved == ~Covers(rd) /\ Snap(lr) # Snap(g.lastRd)
         \* MemberAvailability's read part: a read while L is unavailable changes nothing of its row.
         rowChanged == k.lx /\ ~LAvail(k) /\ res.k.row # k.row
     IN /\ Record([res EXCEPT !.k.sync = sync])
        /\ g' = [GhostK(res, FALSE, opp, mayHide, FALSE, TRUE, lr, FALSE, ev) EXCEPT
                   !.lastRd = lr, !.ign = IF Covers(rd) THEN FALSE ELSE g.lastRd.valid,
                   !.lrMoved = @ \/ moved, !.avail = @ \/ rowChanged, !.fo = FALSE]
        /\ sr' = Touch(sr, res, FALSE)
        /\ last' = [act |-> "KApply", arg |-> NoArg, rec |-> res.rec, resp |-> 0, ev |-> ev]
  /\ rd' = NoRead
  /\ UNCHANGED <<env, toK, rs, rin, fe, spent>>

\* The read's lease runs out after its GETs: the sync is due again, and a new claim may replace the read's token.
\* Until one does, the read still completes as KApply (its token still matches).
KLease ==
  /\ rd.ph = "done" /\ ~rd.exp /\ Can("lease") /\ Spend("lease")
  /\ rd' = [rd EXCEPT !.exp = TRUE]
  /\ last' = [act |-> "KLease", arg |-> NoArg, rec |-> {}, resp |-> 0, ev |-> {}]
  /\ UNCHANGED <<k, env, kq, kg, toK, rs, rin, sr, fe, g>>

\* The stale read's completion: its claim token no longer matches, so it applies nothing. VARIANT V4: it applies.
\* staleOmits: it would hide a shown row, and only the token fences it (no push or row change since its claim).
KStale ==
  /\ sr.ph = "done"
  /\ LET res == IF Variant = "V4" THEN ApplyRead(k, env, sr.v, sr.chg, sr.outd, sr.hadRow, Settled)
                ELSE Res(k, {}, 0)
         ev == Events(res, IF Shown(k) /\ WouldHide(sr) /\ ~sr.outd /\ ~sr.chg THEN {"staleOmits"} ELSE {})
     IN /\ Record(res)
        /\ g' = GhostK(res, FALSE, NoOpp, FALSE, FALSE, FALSE, g.lastRd, FALSE, ev)
        /\ rd' = Touch(rd, res, FALSE)
        /\ last' = [act |-> "KStale", arg |-> NoArg, rec |-> res.rec, resp |-> 0, ev |-> ev]
  /\ sr' = NoRead
  /\ UNCHANGED <<env, toK, rs, rin, fe, spent>>

\* ID-7: a retraction expires after 30 days, when none of R's deliveries (about 3 days of retries) or reads remain.
KExpire ==
  /\ Can("expire") /\ toK = {} /\ rd.ph = "none" /\ sr.ph = "none" /\ ~fe.on
  /\ \E x \in k.ret :
       /\ k' = [k EXCEPT !.ret = @ \ {x}]
       /\ g' = [g EXCEPT !.remLive = IF x = "C" THEN FALSE ELSE @, !.tick = FALSE]
       /\ last' = [act |-> "KExpire", arg |-> Arg(NoEnvelope, NoIntent, x), rec |-> {}, resp |-> 0, ev |-> {}]
  /\ Spend("expire")
  /\ UNCHANGED <<env, kq, kg, toK, rs, rin, rd, sr, fe>>

(***************************************************************************)
(* R, Mastodon v4.7.5.                                                     *)
(* A change of R's item or collection after a read fetched C's page makes  *)
(* that read's view older than R (OV2's rch).                              *)
(***************************************************************************)
RChanged(rs2) == rs2.item # rs.item \/ rs2.c # rs.c \/ rs2.crowd # rs.crowd \/ rs2.gone # rs.gone
RTouch(read, rs2) == IF read.v.seen /\ RChanged(rs2) THEN [read EXCEPT !.rch = TRUE] ELSE read
RGhost(gg, rs2) == [gg EXCEPT !.lastRd = [@ EXCEPT !.rch = @ \/ RChanged(rs2)]]

RStep(rs2, sent, act, arg, extra) ==
  /\ rs' = rs2
  /\ toK' = toK \cup sent
  /\ rd' = RTouch(rd, rs2) /\ sr' = RTouch(sr, rs2)
  /\ last' = [act |-> act, arg |-> arg, rec |-> {}, resp |-> 0, ev |-> extra]

RStepG(rs2, sent, act, arg, extra) ==
  /\ RStep(rs2, sent, act, arg, extra)
  /\ g' = RGhost(g, rs2)

\* AddAccountToCollectionService: refused while L blocks R (account_policy.rb:68-70, the service's :10); one item of L
\* per collection (collection_item.rb:33); a pending item with a new request (the service's :23-26,
\* collection_item.rb:79-81); its FeatureRequestWorker sends the request to L's inbox (feature_request_worker.rb:4-17).
RAdd ==
  /\ rs.c /\ ~rs.gone /\ rs.item = NoItem /\ ~rs.kb /\ rs.adds < Bud("adds")
  /\ LET r == IF rs.adds = 0 THEN "r1" ELSE "r2" IN
     RStepG([rs EXCEPT !.item = [req |-> r, st |-> "pend", ap |-> NONE], !.adds = @ + 1], {EFR(r)}, "RAdd",
            Arg(NoEnvelope, NoIntent, r), {})
  /\ UNCHANGED <<k, env, kq, kg, rin, fe, spent>>

\* DeleteCollectionItemService: the item destroyed, its Remove distributed (delete_collection_item_service.rb:8-10,
\* :18-24); L hears it only through R's reach, so it may be dropped.
RRemove ==
  /\ rs.item # NoItem /\ ~rs.gone /\ Can("remove") /\ Spend("remove")
  /\ RStepG([rs EXCEPT !.item = NoItem], {ERem(ItemOf(rs.item.req))}, "RRemove", NoArg, {})
  /\ UNCHANGED <<k, env, kq, kg, rin, fe>>

\* DeleteCollectionService: C and its items deleted (collection.rb:32), its Remove sent to R's reach only
\* (delete_collection_service.rb:4-7, :14-19).
RDeleteC ==
  /\ rs.c /\ ~rs.gone /\ Can("rdelc") /\ Spend("rdelc")
  /\ RStepG([rs EXCEPT !.c = FALSE, !.item = NoItem], {ERemC}, "RDeleteC", NoArg, {})
  /\ UNCHANGED <<k, env, kq, kg, rin, fe>>

\* CollectionItemCleanupScheduler: rejected and revoked items destroyed 24 hours on, with no activity
\* (collection_item_cleanup_scheduler.rb:6-15). A later Accept of that request finds no item (accept.rb:8).
RCleanup ==
  /\ rs.item.st \in {"rej", "rev"} /\ Can("rclean") /\ Spend("rclean")
  /\ RStepG([rs EXCEPT !.item = NoItem], {}, "RCleanup", NoArg, {})
  /\ UNCHANGED <<k, env, kq, kg, rin, fe>>

\* R deletes its account: DeleteAccountService distributes its actor Delete before it purges its content
\* (delete_account_service.rb:94-95, :102-107), and the account answers 410 from the start (RServes). RPurge is the
\* purge after: R's collections and their items (:6-14).
RDeleteSelf ==
  /\ ~rs.gone /\ Can("gone") /\ Spend("gone")
  /\ RStepG([rs EXCEPT !.gone = TRUE], {EDelR}, "RDeleteSelf", NoArg, {})
  /\ UNCHANGED <<k, env, kq, kg, rin, fe>>

RPurge ==
  /\ rs.gone /\ (rs.c \/ rs.item # NoItem)
  /\ RStepG([rs EXCEPT !.c = FALSE, !.item = NoItem], {}, "RPurge", NoArg, {})
  /\ UNCHANGED <<k, env, kq, kg, rin, fe, spent>>

\* UpdateCollectionService: the Update carries C's listing as it is when enqueued (update_collection_service.rb:19,
\* :26-27; update_featured_collection_serializer.rb:6).
RUpdate ==
  /\ rs.c /\ ~rs.gone /\ Can("upd") /\ Spend("upd")
  /\ RStepG(rs, {EUpd(RListing)}, "RUpdate", NoArg, {})
  /\ UNCHANGED <<k, env, kq, kg, rin, fe>>

\* R's featured collections are paged by 5 with no explicit order (featured_collections_controller.rb:8, :33-37): a
\* filler collection before C deleted or created moves C across the boundary Kopje's 2 pages draw.
RShift ==
  /\ SplitPages /\ Can("shift") /\ Spend("shift")
  /\ \E p \in (CASE rs.pos = "p1" -> {"p2"} [] rs.pos = "p2" -> {"p1", "past"} [] OTHER -> {"p2"}) :
       RStepG([rs EXCEPT !.pos = p], {}, "RShift", Arg(NoEnvelope, NoIntent, p), {})
  /\ UNCHANGED <<k, env, kq, kg, rin, fe>>

\* Other members join or leave C, so its listing is or stops being truncated, with L within the 25 or past them.
RCrowd ==
  /\ Can("crowd") /\ Spend("crowd")
  /\ \E cr \in {"none", "within", "past"} \ {rs.crowd} :
       RStepG([rs EXCEPT !.crowd = cr], {}, "RCrowd", Arg(NoEnvelope, NoIntent, cr), {})
  /\ UNCHANGED <<k, env, kq, kg, rin, fe>>

\* X, another owner on R's server, lists an authorization of L's in its own collection (adversarial: S4).
XAdd ==
  /\ Can("x") /\ Spend("x")
  /\ \E a \in {AuthOf(j) : j \in {i \in 0..1 : i < k.issued}} :
       RStep(rs, {EXAdd(a)}, "XAdd", Arg(NoEnvelope, NoIntent, a), {})
  /\ UNCHANGED <<k, env, kq, kg, rin, fe, g>>

\* One job of R's processing an activity Kopje delivered.
\*  Accept: the item of that request, in any state (activity.rb:160-164), accepted with the result as its approval
\*    and its Add distributed (accept.rb:36-45); with no such item, ignored (accept.rb:8). The corrections of that
\*    authorization CR3 counts from here are those still in flight.
\*  Reject: the item of that request rejected, in any state (reject.rb:41-46).
\*  Delete: the item of L's with that approval, in any state, revoked and kept, its Remove distributed (delete.rb:6,
\*    :68-81; delete_collection_item_service.rb:8-10).
\*  Block: recorded; no collection changes (activity/block.rb:3-22, after_block_service.rb:4-13).
\*  DeleteActor: L's items purged with its account (delete.rb:5, :13-17; delete_account_service.rb:14, :214-218).
\* A processed correction leaves CR3's count unless R still holds that authorization accepted after it: a Delete
\* job that leaves R accepted is no correction.
RHolds(rs2, a) == rs2.item.st = "acc" /\ rs2.item.ap = a /\ ~rs2.gone /\ rs2.la
RProcess(m) ==
  LET it == rs.item
      mine(r) == it # NoItem /\ it.req = r
      live == ~rs.gone /\ rs.la
      arg == Arg(NoEnvelope, m, NONE)
      done(gg, rs2) ==
        [gg EXCEPT !.unexcused = [a \in Auths |-> IF Corrects(m, a) /\ ~RHolds(rs2, a) THEN @[a] - 1 ELSE @[a]]]
      acc == m.ty = "Accept" /\ live /\ mine(m.obj)
      rev == m.ty = "Delete" /\ live /\ it # NoItem /\ it.ap = m.obj
      rs2 == CASE acc -> [rs EXCEPT !.item = [it EXCEPT !.st = "acc", !.ap = m.res]]
               [] m.ty = "Reject" /\ live /\ mine(m.obj) -> [rs EXCEPT !.item = [it EXCEPT !.st = "rej"]]
               [] rev -> [rs EXCEPT !.item = [it EXCEPT !.st = "rev"]]
               [] m.ty = "Block" -> [rs EXCEPT !.kb = TRUE]
               [] m.ty = "DeleteActor" -> [rs EXCEPT !.item = NoItem, !.la = FALSE]
               [] OTHER -> rs
  IN CASE acc ->
            /\ RStep(rs2, {EAdd(ItemOf(m.obj), m.res)}, "RJob", arg, {"accepted"})
            /\ g' = [RGhost(g, rs2) EXCEPT !.unexcused = [a \in Auths |-> IF a = m.res THEN InFlight(a) ELSE @[a]]]
       [] rev ->
            /\ RStep(rs2, {ERem(ItemOf(it.req))}, "RJob", arg, IF m.why = "answer" THEN {"corrected"} ELSE {})
            /\ g' = done(RGhost(g, rs2), rs2)
       [] rs2 # rs ->
            /\ RStep(rs2, {}, "RJob", arg, {})
            /\ g' = RGhost(g, rs2)
       [] OTHER ->
            /\ RStep(rs, {}, "RJob", arg, {"ignored"})
            /\ g' = done(g, rs)

RJob ==
  /\ \E m \in DOMAIN rin : rin' = BagRemove(rin, m) /\ RProcess(m)
  /\ UNCHANGED <<k, env, kq, kg, fe, spent>>

(***************************************************************************)
(* Kopje's deliveries: the lane's head is POSTed to R's server, whose      *)
(* inbox answers 202 and queues a job.                                     *)
(***************************************************************************)
DeliveryStep(act, m) == last' = [act |-> act, arg |-> Arg(NoEnvelope, m, NONE), rec |-> {}, resp |-> 0, ev |-> {}]
\* CR3's count of a's corrections after m leaves the lane (up FALSE) or gains a copy in flight (up TRUE).
CountHead(m, up) ==
  [g EXCEPT !.unexcused = [a \in Auths |-> IF ~Corrects(m, a) THEN @[a] ELSE IF up THEN @[a] + 1 ELSE @[a] - 1]]

\* R1 for a suspended L (deliveries.ts REFUSED_SENDER): its lane's content other than a retraction (every Delete,
\* audience.ts outboundKind) is dropped when claimed or confirmed while it is suspended, and what no claim took is sent
\* after the lifting. So the head is then dropped by the delivery step (its input "dropped"), and is neither
\* duplicated nor given up. VARIANT V25: it is delivered as for an available L.
SenderDrops(m) == k.lx /\ k.ls /\ m.ty \notin {"Delete", "DeleteActor"}
Drops(m) == SenderDrops(m) /\ Variant # "V25"
\* MemberAvailability's delivery part: an activity R receives from L while L is suspended is a retraction.
SentSuspended(m) == [g EXCEPT !.avail = @ \/ SenderDrops(m)]

KDeliver ==
  /\ kq # <<>> /\ kq' = Tail(kq)
  /\ IF Drops(Head(kq))
     THEN /\ rin' = rin /\ g' = g
          /\ last' = [act |-> "KDeliver", arg |-> Arg(NoEnvelope, Head(kq), "dropped"), rec |-> {}, resp |-> 0,
                      ev |-> {"dropped"}]
     ELSE /\ rin' = BagAdd(rin, Head(kq)) /\ g' = SentSuspended(Head(kq))
          /\ DeliveryStep("KDeliver", Head(kq))
  /\ UNCHANGED <<k, env, kg, toK, rs, rd, sr, fe, spent>>

\* A POST whose response is lost: R queues the job, and the activity stays the lane's head.
KDup ==
  /\ kq # <<>> /\ ~Drops(Head(kq)) /\ Can("dup") /\ Spend("dup")
  /\ rin' = BagAdd(rin, Head(kq))
  /\ g' = [CountHead(Head(kq), TRUE) EXCEPT !.avail = @ \/ SenderDrops(Head(kq))]
  /\ DeliveryStep("KDup", Head(kq))
  /\ UNCHANGED <<k, env, kq, kg, toK, rs, rd, sr, fe>>

KGiveUp ==
  /\ kq # <<>> /\ ~Drops(Head(kq))
  /\ kq' = Tail(kq) /\ kg' = kg \cup {Head(kq)}
  /\ g' = CountHead(Head(kq), FALSE)
  /\ DeliveryStep("KGiveUp", Head(kq))
  /\ UNCHANGED <<k, env, toK, rs, rin, rd, sr, fe, spent>>

\* An operator retries a given-up delivery (retryDeliveries): admitted again only if it fits (a retraction always
\* does), it goes behind the lane's current head, older than the rest by its id.
KRetry ==
  \E m \in kg :
    /\ Can("retry") /\ Spend("retry") /\ ~Refused(m)
    /\ kg' = kg \ {m}
    /\ kq' = IF kq = <<>> THEN <<m>> ELSE <<Head(kq), m>> \o Tail(kq)
    /\ g' = CountHead(m, TRUE)
    /\ DeliveryStep("KRetry", m)
    /\ UNCHANGED <<k, env, toK, rs, rin, rd, sr, fe>>

\* R's delivery to Kopje given up after its retries (delivery_worker.rb:11-21), or never sent: L outside its reach.
Drop ==
  \E e \in toK :
    /\ toK' = toK \ {e}
    /\ last' = [act |-> "Drop", arg |-> Arg(e, NoIntent, NONE), rec |-> {}, resp |-> 0, ev |-> {}]
    /\ UNCHANGED <<k, env, kq, kg, rs, rin, rd, sr, fe, spent, g>>

Next ==
  \/ \E e \in toK : KRecv(e, FALSE) \/ KRecv(e, TRUE)
  \/ KApplyFetch \/ KRevoke \/ KBlock \/ KMemberGone \/ KSuspend \/ KUnsuspend \/ KEvict \/ KPurge
  \/ IF Variant = "V16" /\ HeadDelete THEN KCleanupV16 ELSE KCleanup
  \/ EnvStep
  \/ KClaim \/ KFetch \/ KFetch1 \/ KFetch2 \/ KApply \/ KLease \/ KStale \/ KExpire
  \/ KDeliver \/ KGiveUp \/ KDup \/ KRetry
  \/ RAdd \/ RRemove \/ RDeleteC \/ RCleanup \/ RDeleteSelf \/ RPurge \/ RUpdate \/ RShift \/ RCrowd \/ XAdd \/ RJob
  \/ Drop

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* Invariants.                                                             *)
(***************************************************************************)
GP1 == (g.obl # NONE => (k.c /\ k.row.st = "acc" /\ k.row.auth = g.obl)) /\ ~g.rot
GP2 == ~g.delServed
GrantPreservation == GP1 /\ GP2

\* R holds L's item accepted with a, which Kopje does not serve, and R and L are both still there for each other.
RHoldsUnserved(a) == rs.item.st = "acc" /\ rs.item.ap = a /\ ~Served(k, a) /\ k.rk /\ rs.la /\ ~rs.gone

CR1 == ~g.missed
CR2 == ~g.refusedHeld
CR3 == Quiescent => \A a \in Auths : RHoldsUnserved(a) => g.unexcused[a] = 0
CorrectiveRevocation == CR1 /\ CR2 /\ CR3

OV1 == ~g.ov1
OV2Holds == Quiescent /\ g.lastRd.valid /\ ~g.lastRd.rch
\* The latest applied read named the row's authorization, which is accepted and available.
Listed == g.lastRd.i # NONE /\ g.lastRd.a = k.row.auth /\ k.row.st = "acc" /\ LAvail(k) /\ k.rk /\ k.c
OV2 ==
  OV2Holds =>
    /\ (Listed /\ ~g.lastRd.khide) => Shown(k)
    /\ (Shown(k) /\ ~g.lastRd.tr /\ ~g.lastRd.fenced /\ ~g.lastRd.kshow) => Listed
\* The covering read OV2 compares changes only at a read that covers the row.
OV3 == ~g.lrMoved
ObservedVisibility == OV1 /\ OV2 /\ OV3

RemovalFinality == g.remLive => (~k.c /\ k.row = NoRow /\ ~g.accAfterRem)

GoneFinality == ~g.afterGone

NoUnilateralEnd == ~g.nue
\* The part of it that ends R's live accepted item (implied by NoUnilateralEnd; V19's calibration names it).
NoLiveReject == ~g.nueLive

\* While L is unavailable: no answer for L, and no row created or listed (AvailBroken); no change of its row by a read
\* (KApply); no activity of L's other than a Delete received by R (KDeliver, KDup).
MemberAvailability == ~g.avail

(***************************************************************************)
(* Reachability goals (each checked as INVARIANT ~Goal, which must fail).  *)
(***************************************************************************)
Acted(a) == last.act = a
Recorded1(ty) == \E m \in last.rec : m.ty = ty
GoalAccepted == k.row.st = "acc" /\ rs.item.st = "acc" /\ rs.item.ap = k.row.auth
GoalShown == Shown(k)
GoalHidden == "hid" \in last.ev
GoalReadHid == Acted("KApply") /\ "hid" \in last.ev
GoalCorrected == "corrected" \in last.ev
GoalF8 == "f8" \in last.ev
GoalF7 == Quiescent /\ \E a \in Auths : RHoldsUnserved(a)
GoalF8ThenF7 == GoalF7 /\ "f8" \in last.ev
GoalF3 == k.row.st = "acc" /\ rs.item.st = "rej" /\ rs.item.req = k.row.req
GoalKept == "kept" \in last.ev
GoalRemovalGuard == "rfGuard" \in last.ev
Goal503 == "503" \in last.ev
\* A held C's Remove refused at the cap, then retried with room, then the instrument fetched before it applied.
GoalRetried503 == Acted("KApplyFetch") /\ g.held503 /\ "rfGuard" \in last.ev
GoalOV2Shown == OV2Holds /\ Shown(k)
GoalOV2Hidden == OV2Holds /\ k.row.st = "acc" /\ ~Shown(k)
GoalObligation == g.obl # NONE
GoalCR1 == \E m \in last.rec : m.ty = "Delete" /\ m.why = "answer"
\* A read that would hide a shown row, stopped by one fence alone, or a stale completion that would.
GoalFencedByPush == Acted("KApply") /\ Shown(k) /\ "fencedPush" \in last.ev
GoalFencedByRow == Acted("KApply") /\ Shown(k) /\ "fencedRow" \in last.ev
GoalStaleOmits == Acted("KStale") /\ Shown(k) /\ "staleOmits" \in last.ev /\ ~\E e \in toK : e.ty = "Rem"
\* Order 7: a stale request copy hides a row R lists, and a covering read shows it again.
GoalOrder7 == "o7" \in last.ev
GoalOrder7Restored == Acted("KApply") /\ "showed" \in last.ev /\ g.o7
\* Granted and listed before L's suspension, kept through it, shown again at its end.
GoalUnsuspended == Acted("KUnsuspend") /\ Shown(k) /\ spent.susp = 2
\* A request for a suspended L, ignored; a listing of a suspended L's row, left as it was.
GoalSuspendedRequest == Acted("KRecv") /\ last.arg.env.ty = "FR" /\ k.ls /\ k.row.st = "acc" /\ last.rec = {}
\* A read while L is suspended omits L's listed row, R's Remove still in flight: the row stays listed.
GoalSuspendedOmission == Acted("KApply") /\ "suspOmits" \in last.ev /\ \E e \in toK : e.ty = "Rem"
GoalSuspendedListing ==
  /\ Acted("KRecv") /\ last.arg.env.ty = "Add" /\ k.ls /\ Served(k, last.arg.env.a) /\ k.row.uri = NONE
GoalEvictedF8 == "f8" \in last.ev /\ k.issued > 0 /\ k.row = NoRow /\ Recorded1("Delete")
GoalRCleanLateAccept == Acted("RJob") /\ last.arg.msg.ty = "Accept" /\ "ignored" \in last.ev /\ spent.rclean = 1
GoalSlotsReject == Acted("KRecv") /\ env.slots /\ Recorded1("Reject")
\* A copy of a request rejected at the 25, accepted once a slot came free.
GoalSlotsRecovered ==
  /\ Acted("KRecv") /\ ~env.slots /\ spent.slots = 2 /\ \E m \in last.rec : m.ty = "Accept" /\ m.obj \in g.rejected
GoalHeldReject == Acted("KApplyFetch") /\ env.held = "at50" /\ Recorded1("Reject")
GoalHeldRecovered ==
  /\ Acted("KApplyFetch") /\ env.held = "lt50" /\ spent.held = 2 /\ Recorded1("Accept")
  /\ \E i \in 1..Len(kq) : kq[i].ty = "Reject"
GoalGoneFetch == Acted("KApplyFetch") /\ ~k.rk /\ last.arg.val = "served"
\* A read claimed before R's actor Delete, completing after it while the purge has not reached C or the read's sync:
\* R's availability is what fences it.
GoalGoneRead == Acted("KApply") /\ "goneOnly" \in last.ev /\ k.c /\ \E e \in toK : e.ty = "Add"
\* R's actor Delete whose first purge batch reaches C and L's row in the receive transaction.
GoalGonePurged == Acted("KRecv") /\ last.arg.val = "purged" /\ k.issued > 0 /\ ~k.c /\ k.row = NoRow
\* A read whose lease ran out completes and applies: the lease alone fences nothing.
GoalLeaseApplies == Acted("KApply") /\ "expiredApplied" \in last.ev
\* A truncated listing admits C and applies what its first 25 name, and hides nothing it omits.
GoalTruncatedShows == Acted("KApply") /\ "showed" \in last.ev /\ g.lastRd.tr
GoalTruncatedKeeps == Acted("KApply") /\ Shown(k) /\ g.lastRd.valid /\ g.lastRd.tr /\ g.lastRd.i = NONE
\* An instrument for a C stored since its fetch, decided on the existing collection.
GoalFetchExisting == Acted("KApplyFetch") /\ "existing" \in last.ev /\ Recorded1("Accept")
\* An instrument that stores C outdates a read under way, which then applies nothing and leaves the request.
GoalFetchOutdates == Acted("KApply") /\ "outdIgnored" \in last.ev /\ k.sync
\* A round that applied nothing (outdated, or C unseen), then a stale completion: OV2 still reads the covering read
\* before them, which listed L's accepted row.
GoalIgnoredThenStale == Acted("KStale") /\ g.ign /\ g.lastRd.valid /\ Listed

(***************************************************************************)
(* The abstract observation the real Store gives after each step           *)
(* (test/collection-consent-observe.ts; CollectionConsentFixtures.tla      *)
(* exports it).                                                            *)
(***************************************************************************)
Issued == {AuthOf(j) : j \in {i \in 0..1 : i < k.issued}}
\* An embedded listing (an Update of C, an instrument) that names an unserved authorization: the specification requires
\* no answer to it, and permits only L's Delete of it to R as one.
EmbeddedUnserved ==
  /\ last.act \in {"KRecv", "KApplyFetch"}
  /\ last.arg.env.ty \in {"Upd", "Instrument"}
  /\ last.arg.env.l.i # NONE
  /\ LAvail(k) /\ k.rk
  /\ ~Served(k, last.arg.env.l.a)
MayAlsoRecord ==
  IF EmbeddedUnserved THEN {Del(last.arg.env.l.a, "R", AnswerClass(k, last.arg.env.l.a), "answer")} ELSE {}
\* What the specification leaves open at a step, which a replay does not compare: a retired row's listedAs (the fixture
\* writer compares it where a later step of the trace depends on it).
Unspecified == IF k.row.st = "ret" THEN {"row.listedAs"} ELSE {}
Recorded(ms) ==
  {[type |-> m.ty, object |-> m.obj, result |-> m.res, to |-> m.to, class |-> m.cls,
    outcome |-> IF Refused(m) THEN "refused" ELSE "queued"] : m \in ms}
Observation ==
  [row |-> IF k.row = NoRow THEN [name |-> NONE, state |-> NONE, authorization |-> NONE, request |-> NONE,
                                  listedAs |-> NONE]
           ELSE [name |-> IF k.row.auth = "a1" THEN "row1" ELSE "row2",
                 state |-> IF k.row.st = "acc" THEN "accepted" ELSE "retired",
                 authorization |-> k.row.auth, request |-> k.row.req, listedAs |-> k.row.uri],
   collection |-> IF k.c THEN "stored" ELSE "absent",
   authorizationGet |-> [a \in Issued |-> IF AuthorizationServed(k, a)
                                          THEN [status |-> 200, collection |-> "C", member |-> "L"]
                                          ELSE [status |-> 404, collection |-> NONE, member |-> NONE]],
   publicShows |-> Shown(k),
   \* L's own views, read with L's credential, which a suspension refuses (auth.ts authorize).
   memberDetail |-> IF k.lx /\ k.ls THEN "refused" ELSE MemberDetail(k),
   inCollections |-> IF k.lx /\ k.ls THEN "refused" ELSE InCollections(k),
   notified |-> "newRow" \in last.ev,
   response |-> last.resp,
   recorded |-> Recorded(last.rec),
   mayAlsoRecord |-> Recorded(MayAlsoRecord),
   readRequested |-> k.sync,
   unspecified |-> Unspecified]
=============================================================================
