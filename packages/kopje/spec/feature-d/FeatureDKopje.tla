---------------------------- MODULE FeatureDKopje ----------------------------
(***************************************************************************)
(* Kopje's side of #1589 PR 6 design (d), "an omission hides; only         *)
(* evidence deletes", as pure operators over Kopje's core state: each      *)
(* takes the core record, the environment and the step's input, and        *)
(* returns the new core, the activities the step records and the inbound   *)
(* response. FeatureD.tla wires them to the network and the owner's        *)
(* server; FeatureDInd.tla checks Grant preservation inductively over      *)
(* them. Written from the design, never from Kopje's code; each operator   *)
(* is one Store transaction (FeatureD.tla's header maps them).             *)
(*                                                                         *)
(* Variant selects one calibration variant (checks.json's variants): "d"   *)
(* is the design; every other value changes one rule, marked "VARIANT"     *)
(* where it applies.                                                       *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANT Variant

NONE == "-"
Reqs == {"r1", "r2"}
Auths == {"a1", "a2"}
Items == {"I1", "I2"}
\* R's item URI for its request: one item per request (collection_item.rb:79-81; tag_manager.rb:69-70).
ItemOf(r) == IF r = "r1" THEN "I1" ELSE "I2"
\* Kopje issues one authorization per row, in creation order, never reused (row ids: 0103_collections.sql:152-157).
AuthOf(n) == IF n = 0 THEN "a1" ELSE "a2"

(***************************************************************************)
(* Records.                                                                *)
(*  row: L's one row in C (design :225: uri is the owner's item that last  *)
(*       listed it; NONE means unlisted). st is "acc" (accepted) or "ret"  *)
(*       (retired by L's revoke or block, :206).                           *)
(*  core: c (C stored), row, issued (authorizations issued), obl (Grant    *)
(*       preservation's obligation, a ghost: FeatureD.tla), lx (L exists), *)
(*       rk (R neither deleted nor purged), lblk (L blocks R), ret (ID-7   *)
(*       retractions of R's items and of C), sync (a read of R requested). *)
(*  env: consent (L's policy toward R), slots (25 live slots all local     *)
(*       rows, :287), held (R's collections Kopje holds besides C: below   *)
(*       10, below 50, at 50; :260-264), bl (RES-4's backlog to R's inbox  *)
(*       full), cap (R's live retractions at 10,000, :273-275).            *)
(*  listing: what R's FeaturedCollection names of L: item i with           *)
(*       authorization a, or NONE; tr: more than 25 entries, L past the    *)
(*       cut (:218).                                                       *)
(*  view: a read's view of C: seen (C on a fetched page), its listing, cpl *)
(*       (no page past the 2 read: the read is complete).                  *)
(***************************************************************************)
NoRow == [auth |-> NONE, req |-> NONE, st |-> NONE, uri |-> NONE]
RowType == {NoRow} \cup [auth : Auths, req : Reqs, st : {"acc", "ret"}, uri : Items \cup {NONE}]
ListingType == [i : Items \cup {NONE}, a : Auths \cup {NONE}, tr : BOOLEAN]
NoListing == [i |-> NONE, a |-> NONE, tr |-> FALSE]
ViewType == [seen : BOOLEAN, i : Items \cup {NONE}, a : Auths \cup {NONE}, tr : BOOLEAN, cpl : BOOLEAN]
EnvType == [consent : BOOLEAN, slots : BOOLEAN, held : {"lt10", "lt50", "at50"}, bl : BOOLEAN, cap : BOOLEAN]
CoreType == [c : BOOLEAN, row : RowType, issued : 0..2, obl : Auths \cup {NONE}, lx : BOOLEAN, rk : BOOLEAN,
             lblk : BOOLEAN, ret : SUBSET (Items \cup {"C"}), sync : BOOLEAN]

\* An activity Kopje records (an outbound intent). cls "ret" is a retraction, never refused at a full backlog;
\* "ord" is an ordinary intent, refused at a full backlog (RES-4). why tells a revoke's Delete from an answer's.
Acc(r, a) == [ty |-> "Accept", obj |-> r, res |-> a, to |-> "R", cls |-> "ord", why |-> "answer"]
Rej(r) == [ty |-> "Reject", obj |-> r, res |-> NONE, to |-> "R", cls |-> "ord", why |-> "answer"]
\* A Reject of another request while the accepted row is kept (:318): why marks it for NoUnilateralEnd.
RejKept(r) == [ty |-> "Reject", obj |-> r, res |-> NONE, to |-> "R", cls |-> "ord", why |-> "kept"]
Del(a, to, cls, why) == [ty |-> "Delete", obj |-> a, res |-> NONE, to |-> to, cls |-> cls, why |-> why]
Blk == [ty |-> "Block", obj |-> "R", res |-> NONE, to |-> "R", cls |-> "ret", why |-> "block"]
DelL == [ty |-> "DeleteActor", obj |-> "L", res |-> NONE, to |-> "R", cls |-> "ord", why |-> NONE]

Served(kk, a) == kk.row.st = "acc" /\ kk.row.auth = a
HeldRow(kk, a) == kk.row # NoRow /\ kk.row.auth = a
\* R45 for a viewer other than L (:295-301): shown while listed. The owner-block and availability predicates are
\* outside the model.
Shown(kk) == kk.row.st = "acc" /\ kk.row.uri # NONE /\ kk.lx /\ kk.rk
\* What L sees of its own row (:297-298, :303-307).
MemberShown(kk) == kk.row.st = "acc" /\ kk.lx /\ kk.rk
\* The class of a Delete answering a listing of a: a retraction while Kopje holds a's row, else ordinary (F8, :330-331).
AnswerClass(kk, a) == IF HeldRow(kk, a) THEN "ret" ELSE "ord"

Res(kk, rec, resp) == [k |-> kk, rec |-> rec, resp |-> resp]

(***************************************************************************)
(* K1, a FeatureRequest for C while Kopje stores C (D24 as (d) keeps it,   *)
(* :313-322):                                                              *)
(*  - no row: by L's current policy and the slots: Accept with a new       *)
(*    authorization and a row, or Reject with no row (:287-289, :316);     *)
(*  - the row's own request: Accept again, no consent check (:317);        *)
(*  - another request: by current policy, Accept with the row's            *)
(*    authorization (the row takes the request, uri cleared, :318, :225),  *)
(*    or Reject with the row kept;                                         *)
(*  - a retired row: Reject (:320).                                        *)
(* NeedsAuth: a third authorization would be needed, past the bound; the   *)
(* step is then disabled (FeatureD.tla, Bounds).                           *)
(***************************************************************************)
Consents(kk, ee) == ee.consent /\ ~kk.lblk
NeedsAuth(kk, ee) == kk.lx /\ kk.row = NoRow /\ Consents(kk, ee) /\ ~ee.slots /\ kk.issued = 2

Decide(kk, ee, r) ==
  IF ~kk.lx THEN Res(kk, {}, 202)
  ELSE IF kk.row = NoRow
    THEN IF Consents(kk, ee) /\ ~ee.slots
         THEN Res([kk EXCEPT !.row = [auth |-> AuthOf(kk.issued), req |-> r, st |-> "acc", uri |-> NONE],
                             !.issued = @ + 1, !.obl = AuthOf(kk.issued)],
                  {Acc(r, AuthOf(kk.issued))}, 202)
         ELSE Res(kk, {Rej(r)}, 202)
  ELSE IF kk.row.st = "acc" /\ kk.row.req = r
    THEN Res([kk EXCEPT !.obl = kk.row.auth], {Acc(r, kk.row.auth)}, 202)
  ELSE IF kk.row.st = "acc"
    THEN IF Consents(kk, ee)
         THEN Res([kk EXCEPT !.row.req = r, !.row.uri = NONE, !.obl = kk.row.auth], {Acc(r, kk.row.auth)}, 202)
         ELSE Res(kk, {RejKept(r)}, 202)
  ELSE Res(kk, {Rej(r)}, 202)

\* A listing that only shows (:220): sets uri for an accepted row it names, without a retraction check; never hides.
ShowOnly(kk, l) == IF l.i # NONE /\ Served(kk, l.a) THEN [kk EXCEPT !.row.uri = l.i] ELSE kk

(***************************************************************************)
(* K1b, the instrument's application after its fetch (:265-272): nothing   *)
(* once R retracted C (it stores nothing and grants nothing), nothing for  *)
(* a collection R no longer serves, Reject at the 50 for a new collection  *)
(* (:265-267, no collection or row), else C stored (:261-262), its         *)
(* embedded listing shown, and the request decided as K1.                  *)
(***************************************************************************)
ApplyFetch(kk, ee, f) ==
  IF "C" \in kk.ret \/ ~f.ex THEN Res(kk, {}, 0)
  ELSE IF kk.c THEN Decide(ShowOnly(kk, f.l), ee, f.r)
  ELSE IF ee.held = "at50" THEN Res(kk, {Rej(f.r)}, 0)
  ELSE Decide(ShowOnly([kk EXCEPT !.c = TRUE], f.l), ee, f.r)

(***************************************************************************)
(* K2, an item Add naming L's authorization a, from R (its collection C)   *)
(* or from X (another owner on R's server, its own collection): while a    *)
(* is served, sets uri unless R retracted the item (:219); while it is not *)
(* and L exists, answers with L's Delete of a to the sender's inbox, a     *)
(* retraction while a's row is held, else ordinary (:329-331, :482-487,    *)
(* F8 :561-563); with no member left, nothing (:207).                      *)
(* VARIANT V10: "served" is judged in X's collection only.                 *)
(* VARIANT V15: no answer to an unserved authorization.                    *)
(***************************************************************************)
AddItem(kk, ee, i, a, to) ==
  LET served == IF to = "X" /\ Variant = "V10" THEN FALSE ELSE Served(kk, a) IN
  IF to = "R" /\ ~kk.rk THEN Res(kk, {}, 202)
  ELSE IF served
    THEN Res(IF to = "R" /\ kk.c /\ i \notin kk.ret THEN [kk EXCEPT !.row.uri = i] ELSE kk, {}, 202)
  ELSE IF kk.lx /\ Variant # "V15" THEN Res(kk, {Del(a, to, AnswerClass(kk, a), "answer")}, 202)
  ELSE Res(kk, {}, 202)

(***************************************************************************)
(* K3, R's Remove of item i (:221): at the retraction cap, 503 and nothing *)
(* written; the row whose uri is i is hidden, i retracted and a read       *)
(* requested; any other item is retracted.                                 *)
(* VARIANT V6: the Remove deletes the row.                                 *)
(***************************************************************************)
RemoveItem(kk, ee, i) ==
  IF ~kk.rk THEN Res(kk, {}, 202)
  ELSE IF ee.cap THEN Res(kk, {}, 503)
  ELSE IF kk.row # NoRow /\ kk.row.uri = i
    THEN IF Variant = "V6"
         THEN Res([kk EXCEPT !.row = NoRow, !.ret = @ \cup {i}, !.sync = TRUE], {}, 202)
         ELSE Res([kk EXCEPT !.row.uri = NONE, !.ret = @ \cup {i}, !.sync = TRUE], {}, 202)
  ELSE Res([kk EXCEPT !.ret = @ \cup {i}], {}, 202)

(***************************************************************************)
(* K4, R's Update of C, an embedded listing (:220): stores a new C only    *)
(* below 10 and unretracted (:263-264, :270), then shows only.             *)
(* VARIANT V11: an Update that omits the row hides it.                     *)
(***************************************************************************)
UpdateCollection(kk, ee, l) ==
  IF ~kk.rk THEN Res(kk, {}, 202)
  ELSE LET k1 == IF ~kk.c /\ ee.held = "lt10" /\ "C" \notin kk.ret THEN [kk EXCEPT !.c = TRUE] ELSE kk IN
       IF ~k1.c THEN Res(k1, {}, 202)
       ELSE IF Variant = "V11" /\ k1.row.st = "acc" /\ ~(l.i # NONE /\ l.a = k1.row.auth)
         THEN Res([k1 EXCEPT !.row.uri = NONE], {}, 202)
       ELSE Res(ShowOnly(k1, l), {}, 202)

(***************************************************************************)
(* K5, R's Remove of C (target R's featuredCollections; :208, :268-280):   *)
(* at the cap, 503 and nothing written in either branch; else C's          *)
(* retraction recorded, held or not, and C deleted with its rows.          *)
(* VARIANT V7 / V7b: the held / unheld branch records no retraction.       *)
(***************************************************************************)
RemoveCollection(kk, ee) ==
  IF ~kk.rk THEN Res(kk, {}, 202)
  ELSE IF ee.cap THEN Res(kk, {}, 503)
  ELSE LET unrecorded == (kk.c /\ Variant = "V7") \/ (~kk.c /\ Variant = "V7b") IN
       Res([kk EXCEPT !.c = FALSE, !.row = NoRow, !.obl = NONE,
                      !.ret = IF unrecorded THEN @ ELSE @ \cup {"C"}], {}, 202)

\* K6, R gone: its actor Delete, a 410, or the operator's purge (:209): its collections and their rows deleted.
OwnerGone(kk) == Res([kk EXCEPT !.c = FALSE, !.row = NoRow, !.rk = FALSE, !.obl = NONE], {}, 202)

\* K7, L revokes its accepted row (D10, :206): retired, its Delete sent to R (:452) as a retraction.
Revoke(kk) == Res([kk EXCEPT !.row.st = "ret", !.obl = NONE], {Del(kk.row.auth, "R", "ret", "revoke")}, 0)

\* K8, L blocks R (severCollections, :206): an accepted row retired, its Delete to R's personal inbox (:453-454).
Block(kk) ==
  IF kk.row.st = "acc"
  THEN Res([kk EXCEPT !.row.st = "ret", !.obl = NONE, !.lblk = TRUE], {Del(kk.row.auth, "R", "ret", "block"), Blk}, 0)
  ELSE Res([kk EXCEPT !.lblk = TRUE], {Blk}, 0)

\* K9, L's account deleted (:207): its rows by cascade; its actor Delete is an ordinary intent.
MemberGone(kk) == Res([kk EXCEPT !.lx = FALSE, !.row = NoRow, !.obl = NONE], {DelL}, 0)

\* K10, D9's cleanup or the early eviction of the retired row (:210, :256-259): deleted, and a read of R requested.
Cleanup(kk) == Res([kk EXCEPT !.row = NoRow, !.sync = TRUE], {}, 0)

(***************************************************************************)
(* K14, a read's completion (D21 as (d) changes it):                       *)
(*  - an outdated read (an inbound change since its claim) applies nothing *)
(*    (:217);                                                              *)
(*  - C seen, untruncated: C admitted up to 50 (:261-262); the row named   *)
(*    by its authorization takes the listed item, whatever the retractions *)
(*    (:216); an accepted row not named and unchanged since the claim is   *)
(*    hidden (:217); an unserved authorization named is answered with L's  *)
(*    Delete (:333-335);                                                   *)
(*  - C seen, truncated: nothing hidden, nothing answered (:218);          *)
(*  - C not seen, complete: C deleted only while it holds no row of L in   *)
(*    any state (deleteUnlisted's exemption, :222, :252-253);              *)
(*  - C not seen, incomplete: nothing.                                     *)
(* chg: the row changed since the claim; outd: an inbound change of R's    *)
(* collections since the claim; hadRow: a row held at the claim (V3 only); *)
(* settled: no answer of the row queued (V2 only).                         *)
(* VARIANTS: V1 an omission deletes; V2 it deletes once no answer is       *)
(* queued ((b)'s wait without the margin); V3 the exemption is read at the *)
(* claim and the outdated check is gone; V5 no exemption; V12 a truncated  *)
(* listing hides; V13 a read honours retractions; V14 neither the row      *)
(* fence nor the outdated check; V15 no answer.                            *)
(***************************************************************************)
ApplyRead(kk, ee, v, chg, outd, hadRow, settled) ==
  IF outd /\ Variant \notin {"V3", "V14"} THEN Res(kk, {}, 0)
  ELSE IF v.seen /\ (~v.tr \/ Variant = "V12")
    THEN LET k1 == IF ~kk.c /\ ee.held # "at50" /\ "C" \notin kk.ret THEN [kk EXCEPT !.c = TRUE] ELSE kk
             own == v.i # NONE /\ HeldRow(k1, v.a)
             fenced == chg /\ Variant # "V14"
             k2 == IF ~k1.c THEN k1
                   ELSE IF own
                     THEN IF Variant = "V13" /\ v.i \in k1.ret THEN k1 ELSE [k1 EXCEPT !.row.uri = v.i]
                   ELSE IF k1.row.st = "acc" /\ ~fenced
                     THEN IF Variant = "V1" \/ (Variant = "V2" /\ settled)
                          THEN [k1 EXCEPT !.row = NoRow]
                          ELSE [k1 EXCEPT !.row.uri = NONE]
                   ELSE k1
             answer == v.i # NONE /\ ~Served(k1, v.a) /\ k1.lx /\ Variant # "V15"
         IN Res(k2, IF answer THEN {Del(v.a, "R", AnswerClass(k1, v.a), "answer")} ELSE {}, 0)
  ELSE IF ~v.seen /\ v.cpl
    THEN IF kk.c /\ (kk.row = NoRow \/ Variant = "V5" \/ (Variant = "V3" /\ ~hadRow))
         THEN Res([kk EXCEPT !.c = FALSE, !.row = NoRow], {}, 0)
         ELSE Res(kk, {}, 0)
  ELSE Res(kk, {}, 0)

\* Whether a completion keeps C because it holds L's row (deleteUnlisted's exemption ran): a trap's event.
KeptByRow(kk, v, outd) == ~outd /\ ~v.seen /\ v.cpl /\ kk.c /\ kk.row # NoRow

=============================================================================
