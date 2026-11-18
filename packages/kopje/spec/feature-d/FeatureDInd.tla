----------------------------- MODULE FeatureDInd -----------------------------
(***************************************************************************)
(* Grant preservation is inductive over Kopje's steps (TLC's induction     *)
(* check: Ind.cfg starts from every core state satisfying IndInv and       *)
(* checks IndInv after one step of IndNext).                               *)
(*                                                                         *)
(* IndNext is every Kopje step of FeatureDKopje.tla applied with every     *)
(* input and environment of the type domain: any envelope, any instrument  *)
(* snapshot, any read view and fence, any policy, slot, admission and cap  *)
(* state. Each step of FeatureD.tla's Next is one of these (R's,           *)
(* the network's and the environment's steps leave the core unchanged),    *)
(* so an IndInv preserved by IndNext is preserved by Next.                 *)
(*                                                                         *)
(* The starting states fix three fields no step's effect on IndInv reads:  *)
(* sync (only written), the row's uri (it decides only uri, retractions    *)
(* and sync), and the item retractions (they gate only uri); each is       *)
(* fixed to the values below, and every step is checked from each.         *)
(*                                                                         *)
(* IndInv == TypeOK /\ GP1 /\ J1 /\ J2 /\ J3 /\ J4 /\ ~bad, where bad      *)
(* records a Delete of a served authorization (GP2, a property of the      *)
(* step):                                                                  *)
(*  TypeOK the core is in CoreType;                                        *)
(*  GP1  an obligation a means C stored and the row accepted with a;       *)
(*  J1   an accepted row's authorization is the obligation;                *)
(*  J2   a retired row has no obligation;                                  *)
(*  J3   a row lives in a stored C;                                        *)
(*  J4   the row's authorization was issued, so a new one is fresh.        *)
(***************************************************************************)
EXTENDS FeatureDKopje, TLC

VARIABLES kc, bad

TypeOK(c) == c \in CoreType
GP1(c) == c.obl # NONE => (c.c /\ c.row.st = "acc" /\ c.row.auth = c.obl)
J1(c) == c.row.st = "acc" => c.obl = c.row.auth
J2(c) == c.row.st = "ret" => c.obl = NONE
J3(c) == c.row # NoRow => c.c
J4(c) == c.row # NoRow => c.row.auth \in {AuthOf(j) : j \in {i \in 0..1 : i < c.issued}}
IndInv == TypeOK(kc) /\ GP1(kc) /\ J1(kc) /\ J2(kc) /\ J3(kc) /\ J4(kc) /\ ~bad

StartRows == {NoRow} \cup [auth : Auths, req : Reqs, st : {"acc", "ret"}, uri : {NONE, "I1"}]
StartCores == [c : BOOLEAN, row : StartRows, issued : 0..2, obl : Auths \cup {NONE}, lx : BOOLEAN, rk : BOOLEAN,
               lblk : BOOLEAN, ret : {{}, {"C"}, {"I1", "C"}}, sync : {FALSE}]

IndInit == kc \in StartCores /\ bad = FALSE /\ IndInv
\* Only the starting states are expanded: IndInv is checked one step after each.
OneStep == TLCGet("level") < 2

Step(res) ==
  /\ kc' = res.k
  /\ bad' = (bad \/ \E m \in res.rec : m.ty = "Delete" /\ Served(res.k, m.obj))

Listings == {NoListing} \cup [i : Items, a : Auths, tr : {FALSE}] \cup {[i |-> NONE, a |-> NONE, tr |-> TRUE]}
Views == {v \in ViewType : v.seen \/ (v.i = NONE /\ v.a = NONE /\ ~v.tr)}
Fetches == [on : {TRUE}, r : Reqs, ex : BOOLEAN, l : Listings]
\* Each step is taken under every value of the environment fields it reads, and the rest held at E0: Decide reads
\* consent and slots, ApplyFetch those and held, UpdateCollection and ApplyRead held, the Removes cap; bl decides
\* only whether a recorded activity is queued or refused, which no core field depends on. hadRow and settled are read
\* only by the variants V3 and V2, so this check of (d) holds them FALSE.
E0 == [consent |-> FALSE, slots |-> FALSE, held |-> "lt10", bl |-> FALSE, cap |-> FALSE]
Decisions == {[E0 EXCEPT !.consent = c, !.slots = s] : c \in BOOLEAN, s \in BOOLEAN}
Admissions == {[E0 EXCEPT !.held = h] : h \in {"lt10", "lt50", "at50"}}
Caps == {[E0 EXCEPT !.cap = c] : c \in BOOLEAN}

IndNext ==
  \/ \E ee \in Decisions, r \in Reqs : ~NeedsAuth(kc, ee) /\ kc.c /\ kc.lx /\ kc.rk /\ Step(Decide(kc, ee, r))
  \/ \E ee \in Decisions, h \in {"lt10", "lt50", "at50"}, f \in Fetches :
       ~NeedsAuth(kc, ee) /\ Step(ApplyFetch(kc, [ee EXCEPT !.held = h], f))
  \* An item Add comes from R for one of its items, or from X for X's own (FeatureD.tla's EAdd and EXAdd).
  \/ \E it \in (Items \X {"R"}) \cup {<<"IX", "X">>}, a \in Auths : Step(AddItem(kc, E0, it[1], a, it[2]))
  \/ \E ee \in Caps, i \in Items : Step(RemoveItem(kc, ee, i))
  \/ \E ee \in Admissions, l \in Listings : Step(UpdateCollection(kc, ee, l))
  \/ \E ee \in Caps : Step(RemoveCollection(kc, ee))
  \/ Step(OwnerGone(kc))
  \/ kc.row.st = "acc" /\ Step(Revoke(kc))
  \/ ~kc.lblk /\ kc.lx /\ Step(Block(kc))
  \/ kc.lx /\ Step(MemberGone(kc))
  \/ kc.row.st = "ret" /\ Step(Cleanup(kc))
  \/ \E ee \in Admissions, v \in Views, chg \in BOOLEAN, outd \in BOOLEAN :
       Step(ApplyRead(kc, ee, v, chg, outd, FALSE, FALSE))
  \/ kc' = [kc EXCEPT !.sync = FALSE] /\ UNCHANGED bad
  \/ \E x \in kc.ret : kc' = [kc EXCEPT !.ret = @ \ {x}] /\ UNCHANGED bad
=============================================================================
