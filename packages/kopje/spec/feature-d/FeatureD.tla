------------------------------- MODULE FeatureD -------------------------------
(***************************************************************************)
(* #1589 PR 6, design (d): a local member L of a remote owner R's          *)
(* collection C, with R running Mastodon v4.7.5. The oracle the            *)
(* implementation is held to (test-node/feature-d-spec.test.ts checks it   *)
(* with tla-ts; scripts/tlc-check.mjs with TLC).                           *)
(*                                                                         *)
(* Kopje's rules are FeatureDKopje.tla's operators (design (d)); R's       *)
(* follow Mastodon v4.7.5, cited per action below. Mastodon paths are at   *)
(* tag v4.7.5; ":n" alone cites a line of #1589's design (d).              *)
(*                                                                         *)
(* ATOMICITY. Each action is one indivisible step:                         *)
(*  - KRecv: one inbound activity, one Store transaction                   *)
(*    (Store.receiveActivity, src/store.ts:357); a 503 rolls it back and   *)
(*    the envelope stays for R's retry. A FeatureRequest for a collection  *)
(*    Kopje does not store also takes the instrument's snapshot: the       *)
(*    decision to fetch writes nothing, so it is merged with the fetch     *)
(*    (a network GET of R's state at that moment); KApplyFetch is the      *)
(*    later Store transaction that applies it.                             *)
(*  - KClaim / KFetch / KApply: a read's claim (claimCollectionSync,       *)
(*    src/domain/remote-collections.ts:309), its page GETs                 *)
(*    (src/federation/collections.ts:303-343, one per page; one step for   *)
(*    both pages where C cannot move between them), and its completion     *)
(*    (completeCollectionRead, remote-collections.ts:452): three or four   *)
(*    steps, as Kopje splits them (syncCollections,                        *)
(*    src/federation/collections.ts:459-518). KLease turns a claimed read  *)
(*    stale (its lease ran out); KStale is its late completion.            *)
(*  - KRevoke, KBlock, KMemberGone, KCleanup: one Store call each (the     *)
(*    member's revoke and severCollections, src/domain/collections.ts:812; *)
(*    the account deletion; pruneCollectionItems, src/store-rpc.ts:463).   *)
(*  - KDeliver / KGiveUp / KRetry: one delivery's outcome (claimDeliveries *)
(*    and confirmDelivery, src/store-rpc.ts:654-655, a POST to R's inbox;  *)
(*    its give-up after the last attempt; retryDeliveries, :658).          *)
(*  - RJob: one Sidekiq job of R processing one activity Kopje delivered   *)
(*    (each delivery is its own job, so they run in any order).            *)
(*  - RAdd, RRemove, RDeleteC, RCleanup, RDeleteSelf, RUpdate: one request *)
(*    or service call of R. A distribution job's delay before it sends is  *)
(*    the same as a delivery delay, and a job that reaches no one or finds *)
(*    its item gone is a dropped envelope (Drop), so R's sends go straight *)
(*    into toK.                                                            *)
(*                                                                         *)
(* BOUNDS. One owner R (plus X on R's server, scenario S4), one member L,  *)
(* one focal collection C (filler collections abstracted to C's page),     *)
(* two requests r1, r2 (items I1, I2), two authorizations a1, a2; every    *)
(* other count is a per-scenario budget (Bud). Sets hold the channels, so  *)
(* equal messages merge; duplicates come from KDup and the duplicate       *)
(* delivery of a processed envelope. Steps that would need a third         *)
(* authorization or a second instrument fetch are disabled. No fairness:   *)
(* any message may wait for ever or be dropped.                            *)
(*                                                                         *)
(* INVARIANTS:                                                             *)
(*  GrantPreservation  GP1 /\ GP2: while L's committed Accept of a has no  *)
(*    evidence event since (R's Remove of C processed, R or L gone, L's    *)
(*    revoke or block), Kopje holds C and L's accepted row with a, and     *)
(*    serves a; no Delete of a is recorded while a is served.              *)
(*  CorrectiveRevocation  CR1 /\ CR2 /\ CR3: an item Add, or a read's      *)
(*    listing, of an unserved a is answered with L's Delete of a; only an  *)
(*    ordinary Delete is refused at a full backlog (F8); at quiescence R   *)
(*    holds an unserved a only under F7 (CR3, with F7 as proposed for      *)
(*    amendment; CR3Design states F7 as the design does).                  *)
(*  ObservedVisibility  OV1 /\ OV2: only an eligible read, an exact item   *)
(*    Remove, a re-accept or the row's end hides it; at quiescence after   *)
(*    the latest read, with nothing changed since, others see L exactly    *)
(*    when that read listed the row's authorization.                       *)
(*  RemovalFinality: after R's Remove of C is processed, while its         *)
(*    retraction lives, Kopje holds neither C nor a row of it and records  *)
(*    no Accept.                                                           *)
(*  NoUnilateralEnd: R never rejects L's accepted item on a Reject Kopje   *)
(*    sent while it kept the row. (d) violates it, so checks.json lists it *)
(*    as a finding to settle, not an invariant of the scenarios.           *)
(*                                                                         *)
(* GRANT PRESERVATION IS INDUCTIVE (FeatureDInd.tla checks it). IndInv =   *)
(* GP1 /\ J1 /\ J2 /\ J3 /\ J4 over the type domain, J1: an accepted row's *)
(* authorization is the obligation; J2: a retired row has none; J3: a row  *)
(* lives in a stored C; J4: its authorization was issued. Per action:      *)
(* Decide and ApplyFetch create a row only with its                        *)
(* Accept and set the obligation together; every other K1-K4 branch and    *)
(* K14's listing part change uri, retractions or sync only, and record a   *)
(* Delete only when no accepted row has its authorization (GP2);           *)
(* deleteUnlisted deletes C only with no row (so, by GP1, no obligation);  *)
(* K5, K6 and K9 delete and clear the obligation in one step; K7 and K8    *)
(* retire the row and clear it in one step, then record the Delete;        *)
(* K10 deletes only a retired row (J2); every R, network and environment   *)
(* action leaves Kopje's core unchanged.                                   *)
(***************************************************************************)
EXTENDS FeatureDKopje, TLC

CONSTANT Scenario

VARIABLES
  k,      \* Kopje's core (FeatureDKopje.tla, CoreType)
  env,    \* the environment Kopje decides in (EnvType)
  kq,     \* Kopje's recorded activities queued for delivery
  kg,     \* given up: refused at a full backlog, or after the last attempt
  toK,    \* R's envelopes in flight to Kopje (R retries until delivered or dropped)
  rs,     \* R's server (Mastodon v4.7.5)
  rin,    \* Kopje's activities delivered to R, each a Sidekiq job of R's
  rd,     \* the current read of R's collections
  sr,     \* a stale read: its lease ran out before it completed
  fe,     \* the pending instrument fetch
  spent,  \* budget counters
  g,      \* history the invariants read
  last    \* the step: action, input, recorded activities, response, events (fixtures and traps only)

vars == <<k, env, kq, kg, toK, rs, rin, rd, sr, fe, spent, g, last>>

(***************************************************************************)
(* Scenarios: each enables a focused set of actions through its budgets.   *)
(*  S1 answers and re-adds; S2 revoke and correction (C on page 1 or past  *)
(*  the window); S3 pages that shift between a read's GETs; S4 the         *)
(*  cross-owner Delete; S5 stale and outdated reads against pushes; S6     *)
(*  block and member deletion; S7 late and retried answers; S8 the         *)
(*  instrument, R's Remove of C, the retraction cap and expiry, R gone;    *)
(*  S9 admission at 10 and 50 and truncated listings.                      *)
(***************************************************************************)
Budgets == {"adds", "reads", "dup", "retry", "consent", "backlog", "cap", "held", "remove", "rclean", "upd", "x",
            "revoke", "block", "ldel", "rdelc", "gone", "shift", "crowd", "lease", "expire"}
Zero == [f \in Budgets |-> 0]
Bud(f) ==
  CASE Scenario = "S1" -> [Zero EXCEPT !.adds = 2, !.remove = 1, !.consent = 1, !.dup = 1][f]
    [] Scenario = "S2" -> [Zero EXCEPT !.adds = 1, !.reads = 1, !.dup = 1, !.backlog = 1, !.revoke = 1][f]
    [] Scenario = "S3" -> [Zero EXCEPT !.adds = 1, !.reads = 2, !.shift = 1][f]
    [] Scenario = "S4" -> [Zero EXCEPT !.adds = 1, !.x = 1, !.revoke = 1][f]
    [] Scenario = "S5" -> [Zero EXCEPT !.adds = 1, !.reads = 2, !.remove = 1, !.upd = 1, !.lease = 1][f]
    [] Scenario = "S6" -> [Zero EXCEPT !.adds = 1, !.reads = 1, !.block = 1, !.ldel = 1][f]
    [] Scenario = "S7" -> [Zero EXCEPT !.adds = 1, !.reads = 1, !.retry = 1][f]
    [] Scenario = "S8" -> [Zero EXCEPT !.adds = 1, !.reads = 1, !.rdelc = 1, !.cap = 1, !.expire = 1, !.gone = 1][f]
    [] Scenario = "S9" -> [Zero EXCEPT !.adds = 1, !.reads = 1, !.crowd = 1, !.held = 1, !.upd = 1][f]
\* Kopje starts without C where the instrument, admission and R's Remove of C are checked.
StartsWithC == Scenario \notin {"S8", "S9"}
\* C's place in R's featured collections at the start: on page 1, page 2 (S3, where it moves), or past the window.
StartPages == CASE Scenario \in {"S2", "S6"} -> {"p1", "past"} [] Scenario = "S3" -> {"p2"} [] OTHER -> {"p1"}

\* S7 keeps a delivery and R's job apart, so Kopje can see an answer delivered that R has not processed ((b)'s wait,
\* V2); elsewhere nothing Kopje decides depends on that, and R processes a delivery in the same step.
Staged == Scenario = "S7"

\* S3 splits a read into its page GETs, so C can move across the page boundary between them.
SplitPages == Scenario = "S3"
Can(f) == spent[f] < Bud(f)
Spend(f) == spent' = [spent EXCEPT ![f] = @ + 1]

\* The scenario checks fingerprint states without `last`, which records how a state was reached, not what it is,
\* and without the given-up deliveries once no operator retry is left to send them again.
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
NoRead == [ph |-> "none", v |-> NoView, chg |-> FALSE, outd |-> FALSE, rch |-> FALSE, hadRow |-> FALSE]
NoFetch == [on |-> FALSE, r |-> NONE, ex |-> FALSE, l |-> NoListing]
NoLastRead == [valid |-> FALSE, i |-> NONE, a |-> NONE, rch |-> FALSE, kch |-> FALSE]

\* R's FeaturedCollection lists L's accepted item with its approval (featured_collection_serializer.rb:14, :56-58;
\* featured_item_serializer.rb:22-28). rs.crowd: more than 25 entries with L's past the 25th, which single adds allow
\* (add_account_to_collection_service.rb:23-26; collection.rb:57, :112-114 check only the collection's own save).
RListing ==
  IF rs.item.st = "acc" /\ ~rs.crowd THEN [i |-> ItemOf(rs.item.req), a |-> rs.item.ap, tr |-> FALSE]
  ELSE [i |-> NONE, a |-> NONE, tr |-> rs.crowd]

\* RES-4: an ordinary intent is refused at a full backlog (recorded as given up). VARIANT V9: a retraction too.
Refused(m) == env.bl /\ (m.cls = "ord" \/ (Variant = "V9" /\ m.ty = "Delete"))

Quiescent == toK = {} /\ rin = {} /\ kq = {} /\ rd.ph = "none" /\ sr.ph = "none" /\ ~fe.on

(***************************************************************************)
(* Init.                                                                   *)
(***************************************************************************)
Init ==
  /\ k = [c |-> StartsWithC, row |-> NoRow, issued |-> 0, obl |-> NONE, lx |-> TRUE, rk |-> TRUE,
          lblk |-> FALSE, ret |-> {}, sync |-> FALSE]
  \* S1 starts with either policy, so a request can be refused before L consents (F3).
  /\ env \in {[consent |-> c, slots |-> FALSE, held |-> "lt10", bl |-> FALSE, cap |-> FALSE] :
               c \in IF Scenario = "S1" THEN BOOLEAN ELSE {TRUE}}
  /\ kq = {} /\ kg = {} /\ toK = {} /\ rin = {}
  /\ rs \in {[c |-> TRUE, item |-> NoItem, adds |-> 0, kb |-> FALSE, la |-> TRUE, pos |-> p, crowd |-> FALSE,
              gone |-> FALSE] : p \in StartPages}
  /\ rd = NoRead /\ sr = NoRead /\ fe = NoFetch
  /\ spent = Zero
  /\ g = [delServed |-> FALSE, refusedHeld |-> FALSE, missed |-> FALSE, ov1 |-> FALSE, nue |-> FALSE,
          accAfterRem |-> FALSE, remLive |-> FALSE, tags |-> [a \in Auths |-> {}], lastRd |-> NoLastRead]
  /\ last = [act |-> "Init", arg |-> NoArg, rec |-> {}, resp |-> 0, ev |-> {}]

(***************************************************************************)
(* One Kopje step. res: a FeatureDKopje operator's result. opp: the        *)
(* authorization an item Add or an applied read listing named (CR1's       *)
(* opportunity), or NONE. mayHide: the step is of a kind that may hide the *)
(* row (OV1), judged from its kind and input alone. outdNow: an inbound    *)
(* change of R's collections, which makes a read under way outdated. lr:   *)
(* OV2's latest read after the step. remC: R's Remove of C succeeded.      *)
(***************************************************************************)
\* F7's history: what each correction opportunity for a since R last accepted with a came to.
OppTag(k2, rec, a) ==
  IF Served(k2, a) THEN {"served"}
  ELSE IF ~k2.lx THEN {"lGone"}
  ELSE IF \E m \in rec : m.ty = "Delete" /\ m.obj = a /\ Refused(m) THEN {"f8"}
  ELSE {}

GhostK(res, opp, mayHide, lr, remC) ==
  LET k2 == res.k
      dels == {m \in res.rec : m.ty = "Delete"}
  IN [g EXCEPT
        !.delServed = @ \/ (\E m \in dels : Served(k2, m.obj)),
        !.refusedHeld = @ \/ (\E m \in dels : Refused(m) /\ HeldRow(k2, m.obj)),
        !.missed = @ \/ (opp # NONE /\ ~Served(k2, opp) /\ k2.lx /\ ~(\E m \in dels : m.obj = opp)),
        !.ov1 = @ \/ (Shown(k) /\ ~Shown(k2) /\ ~mayHide),
        !.tags = [a \in Auths |-> IF a = opp THEN g.tags[a] \cup OppTag(k2, res.rec, a) ELSE g.tags[a]],
        !.lastRd = lr,
        !.accAfterRem = @ \/ (g.remLive /\ (\E m \in res.rec : m.ty = "Accept")),
        !.remLive = @ \/ remC]

\* OV2's latest read after a Kopje step other than a read's completion: a change of the row is recorded.
Touched(k2) == [g.lastRd EXCEPT !.kch = @ \/ (k2.row # k.row)]

\* A read under way sees Kopje's changes of the row (its fence) and inbound changes (outdated).
Touch(read, k2, outdNow) ==
  IF read.ph = "none" THEN read
  ELSE [read EXCEPT !.chg = @ \/ (k2.row # k.row), !.outd = @ \/ outdNow]

Events(res, extra) ==
  extra \cup (IF Shown(k) /\ ~Shown(res.k) /\ res.k.row.st = "acc" THEN {"hid"} ELSE {})
        \cup (IF \E m \in res.rec : m.ty = "Delete" /\ Refused(m) /\ ~HeldRow(res.k, m.obj) THEN {"f8"} ELSE {})

Record(res) ==
  /\ k' = res.k
  /\ kq' = kq \cup {m \in res.rec : ~Refused(m)}
  /\ kg' = kg \cup {m \in res.rec : Refused(m)}

Commit(res, opp, mayHide, outdNow, remC, act, arg, extra) ==
  /\ Record(res)
  /\ g' = GhostK(res, opp, mayHide, Touched(res.k), remC)
  /\ rd' = Touch(rd, res.k, outdNow)
  /\ sr' = Touch(sr, res.k, outdNow)
  /\ last' = [act |-> act, arg |-> arg, rec |-> res.rec, resp |-> res.resp, ev |-> Events(res, extra)]

\* A step that would create a row with a third authorization lies past the bound.
PastBound == NeedsAuth(k, env)

(***************************************************************************)
(* KRecv: Kopje processes an envelope from toK. dup: its response is lost, *)
(* so it stays in toK and R sends it again (a duplicate delivery).         *)
(***************************************************************************)
Pushes == {"Add", "Rem", "Upd", "RemC"}

\* Activities of an owner gone at Kopje, and requests for a member gone, are ignored.
RecvRes(e) ==
  IF (~k.rk /\ e.ty # "XAdd") \/ (e.ty = "FR" /\ ~k.lx) THEN Res(k, {}, 202)
  ELSE CASE e.ty = "FR" -> Decide(k, env, e.r)
         [] e.ty = "Add" -> AddItem(k, env, e.i, e.a, "R")
         [] e.ty = "XAdd" -> AddItem(k, env, e.i, e.a, "X")
         [] e.ty = "Rem" -> RemoveItem(k, env, e.i)
         [] e.ty = "Upd" -> UpdateCollection(k, env, e.l)
         [] e.ty = "RemC" -> RemoveCollection(k, env)
         [] e.ty = "DelR" -> OwnerGone(k)

\* A FeatureRequest for a collection Kopje does not store: the instrument is fetched (a snapshot of R's C now).
NeedsFetch(e) == e.ty = "FR" /\ ~k.c /\ k.lx /\ k.rk

Consume(e, dup, resp) == toK' = IF dup \/ resp = 503 THEN toK ELSE toK \ {e}

KRecv(e, dup) ==
  /\ e \in toK
  /\ IF dup THEN Can("dup") /\ Spend("dup") ELSE UNCHANGED spent
  /\ IF NeedsFetch(e)
     THEN /\ Consume(e, dup, 202)
          /\ UNCHANGED <<k, env, kq, kg, rs, rin, rd, sr, g>>
          /\ IF "C" \in k.ret
             THEN \* R retracted C: the request is ignored (:269-272).
                  /\ UNCHANGED fe
                  /\ last' = [act |-> "KRecv", arg |-> Arg(e, NoIntent, NONE), rec |-> {}, resp |-> 202,
                              ev |-> IF g.remLive THEN {"rfGuard"} ELSE {}]
             ELSE /\ ~fe.on
                  /\ fe' = [on |-> TRUE, r |-> e.r, ex |-> rs.c, l |-> RListing]
                  /\ last' = [act |-> "KRecv", arg |-> Arg(e, NoIntent, NONE), rec |-> {}, resp |-> 202,
                              ev |-> {"fetch"}]
     ELSE LET res == RecvRes(e)
              opp == IF e.ty = "XAdd" \/ (e.ty = "Add" /\ k.rk) THEN e.a ELSE NONE
              mayHide == CASE e.ty = "FR" -> k.row.st = "acc" /\ k.row.req # e.r
                           [] e.ty = "Rem" -> k.row # NoRow /\ k.row.uri = e.i
                           [] e.ty \in {"RemC", "DelR"} -> TRUE
                           [] OTHER -> FALSE
          IN /\ ~(e.ty = "FR" /\ PastBound)
             /\ Commit(res, opp, mayHide, e.ty \in Pushes /\ res.k # k, e.ty = "RemC" /\ res.resp = 202 /\ k.rk,
                       "KRecv", Arg(e, NoIntent, NONE), IF res.resp = 503 THEN {"503"} ELSE {})
             /\ Consume(e, dup, res.resp)
             /\ UNCHANGED <<env, rs, rin, fe>>

\* K1b: the instrument fetched by KRecv applied (a Store transaction of its own).
KApplyFetch ==
  /\ fe.on
  /\ ~PastBound
  /\ Commit(ApplyFetch(k, env, fe), NONE, k.row.st = "acc" /\ k.row.req # fe.r, FALSE, FALSE, "KApplyFetch",
            Arg(Envelope("Instrument", fe.r, fe.l.i, fe.l.a, fe.l), NoIntent, IF fe.ex THEN "served" ELSE "gone"),
            IF "C" \in k.ret /\ g.remLive THEN {"rfGuard"} ELSE {})
  /\ fe' = NoFetch
  /\ UNCHANGED <<env, toK, rs, rin, spent>>

KMember(res, f, act) ==
  /\ Can(f) /\ Spend(f)
  /\ Commit(res, NONE, TRUE, FALSE, FALSE, act, NoArg, {})
  /\ UNCHANGED <<env, toK, rs, rin, fe>>

KRevoke == k.row.st = "acc" /\ KMember(Revoke(k), "revoke", "KRevoke")
KBlock == ~k.lblk /\ k.lx /\ KMember(Block(k), "block", "KBlock")
KMemberGone == k.lx /\ KMember(MemberGone(k), "ldel", "KMemberGone")

KCleanup ==
  /\ k.row.st = "ret"
  /\ Commit(Cleanup(k), NONE, TRUE, FALSE, FALSE, "KCleanup", NoArg, {})
  /\ UNCHANGED <<env, toK, rs, rin, fe, spent>>

\* The environment: L's policy, RES-4's backlog, the retraction cap, how many of R's collections Kopje holds.
EnvSet(f, field, value) ==
  /\ Can(f) /\ Spend(f)
  /\ env' = [env EXCEPT ![field] = value]
  /\ last' = [act |-> "Env", arg |-> Arg(NoEnvelope, NoIntent, field), rec |-> {}, resp |-> 0, ev |-> {}]
  /\ UNCHANGED <<k, kq, kg, toK, rs, rin, rd, sr, fe, g>>

EnvStep ==
  \/ EnvSet("consent", "consent", ~env.consent)
  \/ EnvSet("backlog", "bl", ~env.bl)
  \/ EnvSet("cap", "cap", ~env.cap)
  \/ \E h \in {"lt10", "lt50", "at50"} \ {env.held} : EnvSet("held", "held", h)

(***************************************************************************)
(* Reads (D21 as (d) keeps it): claim, page GETs, completion.              *)
(***************************************************************************)
KClaim ==
  /\ rd.ph = "none" /\ k.rk /\ Can("reads") /\ Spend("reads")
  /\ rd' = [NoRead EXCEPT !.ph = "cl", !.hadRow = (Variant = "V3" /\ k.row # NoRow)]
  /\ k' = [k EXCEPT !.sync = FALSE]
  /\ last' = [act |-> "KClaim", arg |-> NoArg, rec |-> {}, resp |-> 0, ev |-> {}]
  /\ UNCHANGED <<env, kq, kg, toK, rs, rin, sr, fe, g>>

Page(p) == rs.c /\ rs.pos = p
Seen(v) == [v EXCEPT !.seen = TRUE, !.i = RListing.i, !.a = RListing.a, !.tr = RListing.tr]
Complete == ~Page("past")

\* A fetch step's input, what R serves: C's listing and its place (p1, p2, past the 2 pages Kopje reads, or absent).
PagesArg ==
  Arg(Envelope("Pages", NONE, NONE, NONE, IF rs.c THEN RListing ELSE NoListing), NoIntent,
      IF rs.c THEN rs.pos ELSE "absent")

\* Both pages in one step, where C cannot move between them.
KFetch ==
  /\ ~SplitPages /\ rd.ph = "cl"
  /\ LET v == IF rs.c /\ rs.pos # "past" THEN Seen(NoView) ELSE NoView IN
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

\* (b)'s wait ended (V2 only): no answer of the row is still queued.
Settled == ~(\E m \in kq : m.ty = "Accept" /\ m.res = k.row.auth)
Eligible(read) == ~read.outd /\ read.v.seen /\ ~read.v.tr

KApply ==
  /\ rd.ph = "done"
  /\ LET res == ApplyRead(k, env, rd.v, rd.chg, rd.outd, rd.hadRow, Settled)
         opp == IF Eligible(rd) /\ rd.v.i # NONE THEN rd.v.a ELSE NONE
         mayHide == Eligible(rd) /\ ~rd.chg /\ ~(rd.v.i # NONE /\ rd.v.a = k.row.auth)
         lr == [valid |-> Eligible(rd), i |-> rd.v.i, a |-> rd.v.a, rch |-> rd.rch, kch |-> rd.chg]
     IN /\ Record(res)
        /\ g' = GhostK(res, opp, mayHide, lr, FALSE)
        /\ sr' = Touch(sr, res.k, FALSE)
        /\ last' = [act |-> "KApply", arg |-> NoArg, rec |-> res.rec, resp |-> 0,
                    ev |-> Events(res, IF KeptByRow(k, rd.v, rd.outd) THEN {"kept"} ELSE {})]
  /\ rd' = NoRead
  /\ UNCHANGED <<env, toK, rs, rin, fe, spent>>

\* The read's lease runs out after its GETs; a new claim may start.
KLease ==
  /\ rd.ph = "done" /\ sr.ph = "none" /\ Can("lease") /\ Spend("lease")
  /\ sr' = rd /\ rd' = NoRead
  /\ last' = [act |-> "KLease", arg |-> NoArg, rec |-> {}, resp |-> 0, ev |-> {}]
  /\ UNCHANGED <<k, env, kq, kg, toK, rs, rin, fe, g>>

\* The stale read's completion: its claim token no longer matches, so it applies nothing. VARIANT V4: it applies.
KStale ==
  /\ sr.ph = "done"
  /\ LET res == IF Variant = "V4" THEN ApplyRead(k, env, sr.v, sr.chg, sr.outd, sr.hadRow, Settled)
                ELSE Res(k, {}, 0)
     IN /\ Record(res)
        /\ g' = GhostK(res, NONE, FALSE, g.lastRd, FALSE)
        /\ rd' = Touch(rd, res.k, FALSE)
        /\ last' = [act |-> "KStale", arg |-> NoArg, rec |-> res.rec, resp |-> 0, ev |-> Events(res, {})]
  /\ sr' = NoRead
  /\ UNCHANGED <<env, toK, rs, rin, fe, spent>>

\* ID-7: a retraction expires after 30 days, when none of R's deliveries (about 3 days of retries) or reads remain.
KExpire ==
  /\ Can("expire") /\ toK = {} /\ rd.ph = "none" /\ sr.ph = "none" /\ ~fe.on
  /\ \E x \in k.ret :
       /\ k' = [k EXCEPT !.ret = @ \ {x}]
       /\ g' = [g EXCEPT !.remLive = IF x = "C" THEN FALSE ELSE @]
       /\ last' = [act |-> "KExpire", arg |-> Arg(NoEnvelope, NoIntent, x), rec |-> {}, resp |-> 0, ev |-> {}]
  /\ Spend("expire")
  /\ UNCHANGED <<env, kq, kg, toK, rs, rin, rd, sr, fe>>

(***************************************************************************)
(* R, Mastodon v4.7.5.                                                     *)
(* A change of R's item or collection after a read fetched C's page makes  *)
(* that read's view older than R (OV2's rch).                              *)
(***************************************************************************)
RChanged(rs2) == rs2.item # rs.item \/ rs2.c # rs.c
RTouch(read, rs2) == IF read.v.seen /\ RChanged(rs2) THEN [read EXCEPT !.rch = TRUE] ELSE read

RStep(rs2, sent, act, arg, extra) ==
  /\ rs' = rs2
  /\ toK' = toK \cup sent
  /\ rd' = RTouch(rd, rs2) /\ sr' = RTouch(sr, rs2)
  /\ last' = [act |-> act, arg |-> arg, rec |-> {}, resp |-> 0, ev |-> extra]

RStepG(rs2, sent, act, arg, extra) ==
  /\ RStep(rs2, sent, act, arg, extra)
  /\ g' = [g EXCEPT !.lastRd = [@ EXCEPT !.rch = @ \/ RChanged(rs2)]]

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
  /\ rs.item # NoItem /\ Can("remove") /\ Spend("remove")
  /\ RStepG([rs EXCEPT !.item = NoItem], {ERem(ItemOf(rs.item.req))}, "RRemove", NoArg, {})
  /\ UNCHANGED <<k, env, kq, kg, rin, fe>>

\* DeleteCollectionService: C and its items deleted (collection.rb:32), its Remove sent to R's reach only
\* (delete_collection_service.rb:4-7, :14-19).
RDeleteC ==
  /\ rs.c /\ ~rs.gone /\ Can("rdelc") /\ Spend("rdelc")
  /\ RStepG([rs EXCEPT !.c = FALSE, !.item = NoItem], {ERemC}, "RDeleteC", NoArg, {})
  /\ UNCHANGED <<k, env, kq, kg, rin, fe>>

\* CollectionItemCleanupScheduler: rejected and revoked items destroyed, with no activity
\* (collection_item_cleanup_scheduler.rb:6-15).
RCleanup ==
  /\ rs.item.st \in {"rej", "rev"} /\ Can("rclean") /\ Spend("rclean")
  /\ RStepG([rs EXCEPT !.item = NoItem], {}, "RCleanup", NoArg, {})
  /\ UNCHANGED <<k, env, kq, kg, rin, fe>>

\* R deletes its account: its collections purged (delete_account_service.rb:6-14), its actor Delete sent
\* (:102-107, :305-311).
RDeleteSelf ==
  /\ ~rs.gone /\ Can("gone") /\ Spend("gone")
  /\ RStepG([rs EXCEPT !.gone = TRUE, !.c = FALSE, !.item = NoItem], {EDelR}, "RDeleteSelf", NoArg, {})
  /\ UNCHANGED <<k, env, kq, kg, rin, fe>>

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

RCrowd ==
  /\ Can("crowd") /\ Spend("crowd")
  /\ RStepG([rs EXCEPT !.crowd = ~@], {}, "RCrowd", NoArg, {})
  /\ UNCHANGED <<k, env, kq, kg, rin, fe>>

\* X, another owner on R's server, lists an authorization of L's in its own collection (adversarial: S4).
XAdd ==
  /\ Can("x") /\ Spend("x")
  /\ \E a \in {AuthOf(j) : j \in {i \in 0..1 : i < k.issued}} :
       RStep(rs, {EXAdd(a)}, "XAdd", Arg(NoEnvelope, NoIntent, a), {})
  /\ UNCHANGED <<k, env, kq, kg, rin, fe, g>>

\* One job of R's processing an activity Kopje delivered.
\*  Accept: the item of that request, in any state (activity.rb:160-164), accepted with the result as its approval
\*    and its Add distributed (accept.rb:36-45); with no such item, ignored (accept.rb:8).
\*  Reject: the item of that request rejected, in any state (reject.rb:41-46).
\*  Delete: the item of L's with that approval, found across R's server in any state, revoked and kept, its Remove
\*    distributed (delete.rb:6, :68-81; delete_collection_item_service.rb:8-10).
\*  Block: recorded; no collection changes (activity/block.rb:3-22, after_block_service.rb:4-13).
\*  DeleteActor: L's items purged with its account (delete.rb:5, :13-17; delete_account_service.rb:14, :214-218).
RProcess(m, act) ==
  LET it == rs.item
      mine(r) == it # NoItem /\ it.req = r
      live == ~rs.gone /\ rs.la
      arg == Arg(NoEnvelope, m, NONE)
  IN CASE m.ty = "Accept" /\ live /\ mine(m.obj) ->
            /\ RStep([rs EXCEPT !.item = [it EXCEPT !.st = "acc", !.ap = m.res]], {EAdd(ItemOf(m.obj), m.res)}, act,
                     arg, {"accepted"})
            /\ g' = [g EXCEPT !.lastRd = [@ EXCEPT !.rch = TRUE],
                              !.tags = [a \in Auths |-> IF a = m.res THEN {} ELSE g.tags[a]]]
       [] m.ty = "Reject" /\ live /\ mine(m.obj) ->
            /\ RStep([rs EXCEPT !.item = [it EXCEPT !.st = "rej"]], {}, act, arg, {})
            /\ g' = [g EXCEPT !.lastRd = [@ EXCEPT !.rch = TRUE],
                              !.nue = @ \/ (m.why = "kept" /\ it.st = "acc" /\ Served(k, it.ap))]
       [] m.ty = "Delete" /\ live /\ it # NoItem /\ it.ap = m.obj ->
            RStepG([rs EXCEPT !.item = [it EXCEPT !.st = "rev"]], {ERem(ItemOf(it.req))}, act, arg,
                   IF m.why = "answer" THEN {"corrected"} ELSE {})
       [] m.ty = "Block" ->
            RStepG([rs EXCEPT !.kb = TRUE], {}, act, arg, {})
       [] m.ty = "DeleteActor" ->
            RStepG([rs EXCEPT !.item = NoItem, !.la = FALSE], {}, act, arg, {})
       [] OTHER ->
            RStepG(rs, {}, act, arg, {"ignored"})

RJob ==
  /\ Staged
  /\ \E m \in rin : rin' = rin \ {m} /\ RProcess(m, "RJob")
  /\ UNCHANGED <<k, env, kq, kg, fe, spent>>

(***************************************************************************)
(* Kopje's deliveries to R's inbox (X's inbox is on R's server).           *)
(***************************************************************************)
DeliveryStep(act, m) == last' = [act |-> act, arg |-> Arg(NoEnvelope, m, NONE), rec |-> {}, resp |-> 0, ev |-> {}]

KDeliver ==
  \E m \in kq :
    /\ kq' = kq \ {m}
    /\ IF Staged
       THEN /\ rin' = rin \cup {m}
            /\ DeliveryStep("KDeliver", m)
            /\ UNCHANGED <<k, env, kg, toK, rs, rd, sr, fe, spent, g>>
       ELSE /\ RProcess(m, "KDeliver")
            /\ UNCHANGED <<k, env, kg, rin, fe, spent>>

KGiveUp ==
  \E m \in kq :
    /\ kq' = kq \ {m} /\ kg' = kg \cup {m}
    /\ LET tag == IF m.why = "answer" THEN "gaveUp" ELSE "gaveUpRevoke" IN
       g' = [g EXCEPT !.tags = [a \in Auths |-> IF m.ty = "Delete" /\ m.obj = a THEN g.tags[a] \cup {tag}
                                                ELSE g.tags[a]]]
    /\ DeliveryStep("KGiveUp", m)
    /\ UNCHANGED <<k, env, toK, rs, rin, rd, sr, fe, spent>>

\* A delivery whose response is lost: R gets it, and it stays queued, to be delivered again or given up.
KDup ==
  \E m \in kq :
    /\ Can("dup") /\ Spend("dup")
    /\ IF Staged
       THEN /\ rin' = rin \cup {m}
            /\ DeliveryStep("KDup", m)
            /\ UNCHANGED <<k, env, kq, kg, toK, rs, rd, sr, fe, g>>
       ELSE /\ RProcess(m, "KDup")
            /\ UNCHANGED <<k, env, kq, kg, rin, fe>>

\* An operator retries a given-up delivery (retryDeliveries); :322 allows it for any unrevoked row's answer.
KRetry ==
  \E m \in kg :
    /\ Can("retry") /\ Spend("retry")
    /\ kg' = kg \ {m} /\ kq' = kq \cup {m}
    /\ DeliveryStep("KRetry", m)
    /\ UNCHANGED <<k, env, toK, rs, rin, rd, sr, fe, g>>

\* R's delivery to Kopje given up after its retries (delivery_worker.rb:11-21), or never sent: L outside its reach.
Drop ==
  \E e \in toK :
    /\ toK' = toK \ {e}
    /\ last' = [act |-> "Drop", arg |-> Arg(e, NoIntent, NONE), rec |-> {}, resp |-> 0, ev |-> {}]
    /\ UNCHANGED <<k, env, kq, kg, rs, rin, rd, sr, fe, spent, g>>

Next ==
  \/ \E e \in toK : KRecv(e, FALSE) \/ KRecv(e, TRUE)
  \/ KApplyFetch \/ KRevoke \/ KBlock \/ KMemberGone \/ KCleanup \/ EnvStep
  \/ KClaim \/ KFetch \/ KFetch1 \/ KFetch2 \/ KApply \/ KLease \/ KStale \/ KExpire
  \/ KDeliver \/ KGiveUp \/ KDup \/ KRetry
  \/ RAdd \/ RRemove \/ RDeleteC \/ RCleanup \/ RDeleteSelf \/ RUpdate \/ RShift \/ RCrowd \/ XAdd \/ RJob \/ Drop

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* Invariants.                                                             *)
(***************************************************************************)
GP1 == k.obl # NONE => (k.c /\ k.row.st = "acc" /\ k.row.auth = k.obl)
GP2 == ~g.delServed
GrantPreservation == GP1 /\ GP2

\* R holds L's item accepted with a, which Kopje does not serve, and R and L are both still there for each other.
RHoldsUnserved(a) == rs.item.st = "acc" /\ rs.item.ap = a /\ ~Served(k, a) /\ k.rk /\ rs.la /\ ~rs.gone
\* F7 as the design states it (:553-559): each opportunity since R accepted was answered by an F8-refused Delete.
F7Design(a) == g.tags[a] \subseteq {"f8", "gaveUpRevoke"}
\* F7 as proposed for amendment: no Delete of a reached R since it accepted. In this model it follows from RJob's
\* Delete rule and the reset at acceptance, and is kept as the statement CR3 holds the design to.
F7Amended(a) == g.tags[a] \subseteq {"f8", "gaveUp", "gaveUpRevoke", "lGone", "served"}
\* VARIANT V8 (oracle side): F7 without its F8 clause.
F7NoF8(a) == g.tags[a] \subseteq {"gaveUp", "gaveUpRevoke", "lGone", "served"}

CR1 == ~g.missed
CR2 == ~g.refusedHeld
CR3 == Quiescent => \A a \in Auths : RHoldsUnserved(a) => F7Amended(a)
CR3Design == Quiescent => \A a \in Auths : RHoldsUnserved(a) => F7Design(a)
CR3NoF8 == Quiescent => \A a \in Auths : RHoldsUnserved(a) => F7NoF8(a)
CorrectiveRevocation == CR1 /\ CR2 /\ CR3

OV1 == ~g.ov1
OV2Holds == Quiescent /\ g.lastRd.valid /\ ~g.lastRd.rch /\ ~g.lastRd.kch
OV2 == OV2Holds => (Shown(k) <=> (k.row.st = "acc" /\ g.lastRd.i # NONE /\ g.lastRd.a = k.row.auth))
ObservedVisibility == OV1 /\ OV2

RemovalFinality == g.remLive => (~k.c /\ k.row = NoRow /\ ~g.accAfterRem)

NoUnilateralEnd == ~g.nue

Oracle == GrantPreservation /\ CorrectiveRevocation /\ ObservedVisibility /\ RemovalFinality

(***************************************************************************)
(* Reachability goals (each checked as INVARIANT ~Goal, which must fail).  *)
(***************************************************************************)
Acted(a) == last.act = a
GoalAccepted == k.row.st = "acc" /\ rs.item.st = "acc" /\ rs.item.ap = k.row.auth
GoalShown == Shown(k)
GoalHidden == "hid" \in last.ev
GoalCorrected == "corrected" \in last.ev
GoalF8 == "f8" \in last.ev
GoalF7 == Quiescent /\ \E a \in Auths : RHoldsUnserved(a)
GoalF8ThenF7 == Quiescent /\ \E a \in Auths : RHoldsUnserved(a) /\ "f8" \in g.tags[a]
GoalF3 == k.row.st = "acc" /\ rs.item.st = "rej" /\ rs.item.req = k.row.req
GoalKept == "kept" \in last.ev
GoalRemovalGuard == "rfGuard" \in last.ev
Goal503 == "503" \in last.ev
GoalOV2Shown == OV2Holds /\ Shown(k)
GoalOV2Hidden == OV2Holds /\ k.row.st = "acc" /\ ~Shown(k)
GoalObligation == k.obl # NONE
GoalCR1 == \E m \in last.rec : m.ty = "Delete" /\ m.why = "answer"

(***************************************************************************)
(* The abstract observation the real Store gives after each step           *)
(* (test/feature-d-observe.ts; FeatureDFixtures.tla exports it).           *)
(***************************************************************************)
Issued == {AuthOf(j) : j \in {i \in 0..1 : i < k.issued}}
\* What the design leaves open at a step, which a replay does not compare: whether an embedded listing
\* (an Update of C, an instrument) that names an unserved authorization is answered, and a retired row's listing.
EmbeddedUnserved ==
  /\ last.act \in {"KRecv", "KApplyFetch"}
  /\ last.arg.env.ty \in {"Upd", "Instrument"}
  /\ last.arg.env.l.i # NONE
  /\ ~Served(k, last.arg.env.l.a)
Unspecified ==
  (IF EmbeddedUnserved THEN {"recorded"} ELSE {}) \cup (IF k.row.st = "ret" THEN {"row.listedAs"} ELSE {})
Observation ==
  [row |-> IF k.row = NoRow THEN [name |-> NONE, state |-> NONE, authorization |-> NONE, request |-> NONE,
                                  listedAs |-> NONE]
           ELSE [name |-> IF k.row.auth = "a1" THEN "row1" ELSE "row2",
                 state |-> IF k.row.st = "acc" THEN "accepted" ELSE "retired",
                 authorization |-> k.row.auth, request |-> k.row.req, listedAs |-> k.row.uri],
   collection |-> IF k.c THEN "stored" ELSE "absent",
   authorizationGet |-> [a \in Issued |-> IF Served(k, a) THEN 200 ELSE 404],
   publicShows |-> Shown(k),
   memberShows |-> MemberShown(k),
   response |-> last.resp,
   recorded |-> {[type |-> m.ty, object |-> m.obj, result |-> m.res, to |-> m.to, class |-> m.cls,
                  outcome |-> IF Refused(m) THEN "refused" ELSE "queued"] : m \in last.rec},
   readRequested |-> k.sync,
   unspecified |-> Unspecified]
=============================================================================
