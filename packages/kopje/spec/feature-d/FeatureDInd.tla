----------------------------- MODULE FeatureDInd -----------------------------
(***************************************************************************)
(* Grant preservation is inductive over Kopje's steps (TLC's induction     *)
(* check: Ind.cfg starts from every state satisfying IndInv and checks     *)
(* IndInv after one step of IndNext).                                      *)
(*                                                                         *)
(* IndNext is every Kopje step of FeatureDKopje.tla applied with every     *)
(* input and environment of the type domain: any envelope, any instrument  *)
(* snapshot, any read view and fence, any policy, slot, admission and cap  *)
(* state. Each step of FeatureD.tla's Next is one of these (R's,           *)
(* the network's and the environment's steps leave the core unchanged),    *)
(* so an IndInv preserved by IndNext is preserved by Next.                 *)
(*                                                                         *)
(* ob is the obligation, as FeatureD.tla's ghost g.obl: the authorization  *)
(* of the last Accept a step recorded, cleared by the steps that are       *)
(* evidence (R's Remove of C or its tombstone while R is there, L's        *)
(* revoke, block or deletion).                                             *)
(*                                                                         *)
(* The starting states are every core of CoreType, with every obligation,  *)
(* that satisfies IndInv. IndInv == TypeOK /\ GP1 /\ J1 /\ J2 /\ J3 /\ J4  *)
(* /\ J5 /\ ~bad, where bad records a Delete of a served authorization     *)
(* (GP2, a property of the step):                                          *)
(*  TypeOK the core is in CoreType;                                        *)
(*  GP1  an obligation a means C stored and the row accepted with a;       *)
(*  J1   while R and L are both there, an accepted row's authorization is  *)
(*       the obligation;                                                   *)
(*  J2   a retired row has no obligation;                                  *)
(*  J3   a row lives in a stored C;                                        *)
(*  J4   the row's authorization was issued, so a new one is fresh;        *)
(*  J5   nothing is owed once R is tombstoned.                             *)
(***************************************************************************)
EXTENDS FeatureDKopje, TLC

VARIABLES kc, ob, bad

TypeOK(c) == c \in CoreType /\ ob \in Auths \cup {NONE}
GP1(c) == ob # NONE => (c.c /\ c.row.st = "acc" /\ c.row.auth = ob)
J1(c) == (c.row.st = "acc" /\ c.rk /\ c.lx) => ob = c.row.auth
J2(c) == c.row.st = "ret" => ob = NONE
J3(c) == c.row # NoRow => c.c
J4(c) == c.row # NoRow => c.row.auth \in {AuthOf(j) : j \in {i \in 0..1 : i < c.issued}}
J5(c) == ~c.rk => ob = NONE
IndInv == TypeOK(kc) /\ GP1(kc) /\ J1(kc) /\ J2(kc) /\ J3(kc) /\ J4(kc) /\ J5(kc) /\ ~bad

IndInit == kc \in CoreType /\ ob \in Auths \cup {NONE} /\ bad = FALSE /\ IndInv
\* Only the starting states are expanded: IndInv is checked one step after each.
OneStep == TLCGet("level") < 2

\* One step: its core, the obligation after it, and whether it recorded a Delete of a served authorization.
Step(res, evid) ==
  LET acc == {m \in res.rec : m.ty = "Accept"} IN
  /\ kc' = res.k
  /\ ob' = IF acc # {} THEN (CHOOSE m \in acc : TRUE).res ELSE IF evid THEN NONE ELSE ob
  /\ bad' = (bad \/ \E m \in res.rec : m.ty = "Delete" /\ Served(res.k, m.obj))

Listings == ListingType
Fetches == [on : {TRUE}, r : Reqs, ex : BOOLEAN, l : ListingType]
\* Each step is taken under every value of the environment fields it reads, and the rest held at E0: Decide reads
\* consent and slots, ApplyFetch those and held, UpdateCollection and ApplyRead held, the Removes cap; bl decides
\* only whether a recorded activity is queued or refused, which no core field depends on. hadRow and settled are read
\* only by the variants V3 and V2, so this check of (d) holds them FALSE.
E0 == [consent |-> FALSE, slots |-> FALSE, held |-> "lt10", bl |-> FALSE, cap |-> FALSE]
Decisions == {[E0 EXCEPT !.consent = c, !.slots = s] : c \in BOOLEAN, s \in BOOLEAN}
Admissions == {[E0 EXCEPT !.held = h] : h \in {"lt10", "lt50", "at50"}}
Caps == {[E0 EXCEPT !.cap = c] : c \in BOOLEAN}

IndNext ==
  \/ \E ee \in Decisions, r \in Reqs :
       ~NeedsAuth(kc, ee) /\ kc.c /\ kc.lx /\ kc.rk /\ Step(Decide(kc, ee, r), FALSE)
  \/ \E ee \in Decisions, h \in {"lt10", "lt50", "at50"}, f \in Fetches :
       ~NeedsAuth(kc, ee) /\ Step(ApplyFetch(kc, [ee EXCEPT !.held = h], f), FALSE)
  \* An item Add comes from R for one of its items, or from X for X's own (FeatureD.tla's EAdd and EXAdd).
  \/ \E it \in (Items \X {"R"}) \cup {<<"IX", "X">>}, a \in Auths : Step(AddItem(kc, E0, it[1], a, it[2]), FALSE)
  \/ \E ee \in Caps, i \in Items : Step(RemoveItem(kc, ee, i), FALSE)
  \/ \E ee \in Admissions, l \in Listings : Step(UpdateCollection(kc, ee, l), FALSE)
  \/ \E ee \in Caps : LET res == RemoveCollection(kc, ee) IN Step(res, kc.rk /\ res.resp = 202)
  \/ Step(OwnerGone(kc), kc.rk)
  \/ ~kc.rk /\ Step(OwnerPurge(kc), FALSE)
  \/ kc.row.st = "acc" /\ Step(Revoke(kc), TRUE)
  \/ ~kc.lblk /\ kc.lx /\ Step(Block(kc), TRUE)
  \/ kc.lx /\ Step(MemberGone(kc), TRUE)
  \/ kc.lx /\ Step(Suspend(kc), FALSE)
  \/ Step(Unsuspend(kc), FALSE)
  \/ kc.row.st = "ret" /\ Step(Cleanup(kc), FALSE)
  \/ kc.row.st = "ret" /\ Step(Evict(kc), FALSE)
  \/ \E ee \in Admissions, v \in ViewType, chg \in BOOLEAN, outd \in BOOLEAN :
       Step(ApplyRead(kc, ee, v, chg, outd, FALSE, FALSE), FALSE)
  \/ kc' = [kc EXCEPT !.sync = FALSE] /\ UNCHANGED <<ob, bad>>
  \/ \E x \in kc.ret : kc' = [kc EXCEPT !.ret = @ \ {x}] /\ UNCHANGED <<ob, bad>>
=============================================================================
