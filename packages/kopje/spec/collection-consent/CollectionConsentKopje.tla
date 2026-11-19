------------------------ MODULE CollectionConsentKopje -------------------------
(***************************************************************************)
(* Kopje's rules for a local account's consent to membership in a remote   *)
(* collection (#1589), "an omission hides; only evidence deletes", as pure *)
(* operators over Kopje's core state: each takes the core record, the      *)
(* environment and the step's input, and returns the new core, the         *)
(* activities the step records and the inbound response.                   *)
(* CollectionConsent.tla wires them to the network and the owner's server; *)
(* CollectionConsentInd.tla checks Grant preservation inductively over     *)
(* them. Each operator is one Store transaction (CollectionConsent.tla's   *)
(* header maps them to Kopje's code).                                      *)
(*                                                                         *)
(* Variant selects one calibration variant (checks.json's variants):       *)
(* "base" is the rules as stated; every other value changes one rule,      *)
(* marked "VARIANT" where it applies.                                      *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANT Variant

NONE == "-"
\* The Store's answer to an inbound activity it can decide only after a fetch (inbound.ts, the `need` loop): no HTTP
\* response yet; the resumed activity's own transaction gives the final status.
FETCH == 1
Reqs == {"r1", "r2"}
Auths == {"a1", "a2"}
Items == {"I1", "I2"}
\* R's item URI for its request: one item per request (collection_item.rb:79-81; tag_manager.rb:69-70).
ItemOf(r) == IF r = "r1" THEN "I1" ELSE "I2"
\* Kopje issues one authorization per row, in creation order, never reused (row ids: 0103_collections.sql:152-157).
AuthOf(n) == IF n = 0 THEN "a1" ELSE "a2"

(***************************************************************************)
(* Records.                                                                *)
(*  row: L's one row in C (uri is the owner's item that last listed it;    *)
(*    NONE means unlisted). st is "acc" (accepted) or "ret" (retired by    *)
(*    L's revoke or block).                                                *)
(*  core: c (C stored), row, issued (authorizations issued), lx (L exists; *)
(*    its deletion is model-only: Kopje deletes no local account,          *)
(*    delivery-hosts.ts:63), ls (L suspended: its rows stay, and every     *)
(*    read leaves it out, audience.ts availableSql), rk (R neither deleted *)
(*    nor purged: false from R's tombstone on), lblk (L blocks R), ret     *)
(*    (ID-7 retractions of R's items and of C), sync (a read of R          *)
(*    requested and not yet read through: R's collection_syncs row, kept   *)
(*    from the request through the claim until a completion reads it       *)
(*    through, remote-collections.ts:309-398).                             *)
(*  env: consent (L's policy toward R), slots (25 live slots all local     *)
(*    rows), held (R's collections Kopje holds besides C: below 10, below  *)
(*    50, at 50), bl (RES-4's backlog to R's server full), cap (R's live   *)
(*    retractions at 10,000). C at its 50 stored rows is the step that     *)
(*    evicts L's retired row (Evict).                                      *)
(*  listing: what R's FeaturedCollection names of L: item i with           *)
(*    authorization a, or NONE; tr: more than 25 entries, with L either    *)
(*    within the 25 (named) or past them (not named).                      *)
(*  view: a read's view of C: seen (C on a fetched page), its listing, cpl *)
(*    (no page past the 2 read: the read is complete).                     *)
(***************************************************************************)
NoRow == [auth |-> NONE, req |-> NONE, st |-> NONE, uri |-> NONE]
RowType == {NoRow} \cup [auth : Auths, req : Reqs, st : {"acc", "ret"}, uri : Items \cup {NONE}]
ListingType == [i : Items \cup {NONE}, a : Auths \cup {NONE}, tr : BOOLEAN]
NoListing == [i |-> NONE, a |-> NONE, tr |-> FALSE]
ViewType == [seen : BOOLEAN, i : Items \cup {NONE}, a : Auths \cup {NONE}, tr : BOOLEAN, cpl : BOOLEAN]
EnvType == [consent : BOOLEAN, slots : BOOLEAN, held : {"lt10", "lt50", "at50"}, bl : BOOLEAN, cap : BOOLEAN]
CoreType == [c : BOOLEAN, row : RowType, issued : 0..2, lx : BOOLEAN, ls : BOOLEAN, rk : BOOLEAN, lblk : BOOLEAN,
             ret : SUBSET (Items \cup {"C"}), sync : BOOLEAN]

\* An activity Kopje records (an outbound intent). cls "ret" is a retraction, never refused at a full backlog (RES-4,
\* deliveries.ts Admission); "ord" is any other, refused at a full backlog. A revoke's or a block's Delete is a
\* retraction, and an answer's is one only to R while Kopje holds the row it retracts (AnswerClass, F8); a Block is
\* ordinary (audience.ts outboundKind). why tells an answer's Delete from a revoke's or a block's. to is the inbox: R's,
\* or X's for X's Add (both on R's server, so one delivery lane).
Acc(r, a) == [ty |-> "Accept", obj |-> r, res |-> a, to |-> "R", cls |-> "ord", why |-> "answer"]
Rej(r) == [ty |-> "Reject", obj |-> r, res |-> NONE, to |-> "R", cls |-> "ord", why |-> "answer"]
Del(a, to, cls, why) == [ty |-> "Delete", obj |-> a, res |-> NONE, to |-> to, cls |-> cls, why |-> why]
Blk == [ty |-> "Block", obj |-> "R", res |-> NONE, to |-> "R", cls |-> "ord", why |-> "block"]
DelL == [ty |-> "DeleteActor", obj |-> "L", res |-> NONE, to |-> "R", cls |-> "ord", why |-> NONE]

Served(kk, a) == kk.row.st = "acc" /\ kk.row.auth = a
HeldRow(kk, a) == kk.row # NoRow /\ kk.row.auth = a
\* L available to every read (audience.ts availableSql).
LAvail(kk) == kk.lx /\ ~kk.ls
\* R45 for a viewer other than L: shown while listed. The owner-block predicate is outside the model; R's tombstone
\* hides its collections at once.
Shown(kk) == kk.row.st = "acc" /\ kk.row.uri # NONE /\ LAvail(kk) /\ kk.rk /\ kk.c
\* What L sees of its own row in C's items (audience.ts collectionItemShownSql).
MemberDetail(kk) == kk.row.st = "acc" /\ LAvail(kk) /\ kk.rk /\ kk.c
\* C in L's in_collections, its row in any state (audience.ts inCollectionsSql).
InCollections(kk) == kk.row # NoRow /\ kk.lx /\ kk.rk /\ kk.c
\* GET of a's FeatureAuthorization (collection-documents.ts featureAuthorizationDocument): the row accepted with a and
\* L available; its body binds C (interactingObject) and L (interactionTarget).
AuthorizationServed(kk, a) == Served(kk, a) /\ LAvail(kk) /\ kk.c
\* The class of a Delete answering a listing of a by `from` (R, the owner of C, or X): a retraction while Kopje holds
\* a's row and R listed it, else ordinary (F8). A retraction is never refused, so only the row's one owner draws one:
\* any other account may list an authorization it learnt from L's revocation, and its answer is new work under RES-4's
\* caps (feature-answers.ts answerUnserved). VARIANT V26: any lister's answer is a retraction while the row is held.
AnswerClass(kk, a, from) == IF HeldRow(kk, a) /\ (from = "R" \/ Variant = "V26") THEN "ret" ELSE "ord"

\* A step's result. req: the step requests a read of R (requestCollectionSync), which a read already under way does not
\* read through (CollectionConsent.tla's KApply).
Res(kk, rec, resp) == [k |-> kk, rec |-> rec, resp |-> resp, req |-> FALSE]
ResReq(kk, rec, resp) == [k |-> kk, rec |-> rec, resp |-> resp, req |-> TRUE]

(***************************************************************************)
(* K1, a FeatureRequest for C while Kopje stores C:                        *)
(*  - no row: by L's current policy and the slots: Accept with a new       *)
(*    authorization and a row, or Reject with no row;                      *)
(*  - an accepted row: Accept with the row's authorization and no policy   *)
(*    check, the row taking the request (another request clears uri);      *)
(*  - a retired row: Reject.                                               *)
(* While L is unavailable (suspended, or gone), the request is ignored:    *)
(* 202, nothing recorded, nothing fetched, as Kopje ignores every request  *)
(* to an unavailable local account (inbox.ts:617-619, a Follow to a        *)
(* suspended target, and :1279, a Move; R38): a suspended member cannot    *)
(* consent, and its suspension changes none of its grants, so it issues    *)
(* none either.                                                            *)
(* NeedsAuth: a third authorization would be needed, past the bound; the   *)
(* step is then disabled (CollectionConsent.tla, Bounds).                  *)
(* VARIANT V19: another request is decided by L's current policy, Accept   *)
(* or Reject with the row kept.                                            *)
(* VARIANT V20: another request rotates the authorization: the row takes a *)
(* new one, and the Accept carries it.                                     *)
(* VARIANT V21: no availability gate (a suspended member is decided as an  *)
(* available one).                                                         *)
(***************************************************************************)
Consents(kk, ee) == ee.consent /\ ~kk.lblk
\* The member a request or a listing may name: L available, unless VARIANT V21 (requests) or V22 (listings).
Decides(kk) == IF Variant = "V21" THEN kk.lx ELSE LAvail(kk)
Lists(kk) == IF Variant = "V22" THEN kk.lx ELSE LAvail(kk)
Rotates(kk, r) == Variant = "V20" /\ kk.row.st = "acc" /\ kk.row.req # r
NeedsAuth(kk, ee) ==
  /\ Decides(kk)
  /\ \/ kk.row = NoRow /\ Consents(kk, ee) /\ ~ee.slots
     \/ Rotates(kk, "r1") \/ Rotates(kk, "r2")
  /\ kk.issued = 2

Decide(kk, ee, r) ==
  IF ~Decides(kk) THEN Res(kk, {}, 202)
  ELSE IF kk.row = NoRow
    THEN IF Consents(kk, ee) /\ ~ee.slots
         THEN Res([kk EXCEPT !.row = [auth |-> AuthOf(kk.issued), req |-> r, st |-> "acc", uri |-> NONE],
                             !.issued = @ + 1],
                  {Acc(r, AuthOf(kk.issued))}, 202)
         ELSE Res(kk, {Rej(r)}, 202)
  ELSE IF kk.row.st = "acc" /\ kk.row.req = r
    THEN Res(kk, {Acc(r, kk.row.auth)}, 202)
  ELSE IF Rotates(kk, r)
    THEN Res([kk EXCEPT !.row.req = r, !.row.uri = NONE, !.row.auth = AuthOf(kk.issued), !.issued = @ + 1],
             {Acc(r, AuthOf(kk.issued))}, 202)
  ELSE IF kk.row.st = "acc" /\ (Variant # "V19" \/ Consents(kk, ee))
    THEN Res([kk EXCEPT !.row.req = r, !.row.uri = NONE], {Acc(r, kk.row.auth)}, 202)
  ELSE Res(kk, {Rej(r)}, 202)

\* A listing that only shows: sets uri for an accepted row it names, without a retraction check; never hides.
\* A listing naming an unavailable L leaves its row as it is (Lists; K2).
ShowOnly(kk, l) == IF l.i # NONE /\ Served(kk, l.a) /\ Lists(kk) THEN [kk EXCEPT !.row.uri = l.i] ELSE kk

(***************************************************************************)
(* K1b, the instrument's application, the resumed activity's own           *)
(* transaction: nothing while L is unavailable (K1's gate) or once R is    *)
(* gone (its tombstone, retractions.ts isDeleted). For a C stored since    *)
(* the fetch, the existing-collection path: the stored C as it is, the     *)
(* fetched listing unused, and the request decided as K1, as main resolves *)
(* a collection it stores (remote-statuses.ts:1148-1164). Otherwise        *)
(* nothing for a retracted C (it stores nothing and grants nothing) or for *)
(* one R no longer serves, Reject at the 50 for a new collection (no       *)
(* collection or row), else C stored, its embedded listing shown, and the  *)
(* request decided as K1. Storing C is a change of R's collections that a  *)
(* read under way does not hold (CollectionConsent.tla KApplyFetch), as    *)
(* main marks for a collection it applies (remote-statuses.ts:1157-1162).  *)
(* VARIANT V17: no tombstone check.                                        *)
(***************************************************************************)
ApplyFetch(kk, ee, f) ==
  IF ~Decides(kk) \/ (~kk.rk /\ Variant # "V17") THEN Res(kk, {}, 202)
  ELSE IF kk.c THEN Decide(kk, ee, f.r)
  ELSE IF "C" \in kk.ret \/ ~f.ex THEN Res(kk, {}, 202)
  ELSE IF ee.held = "at50" THEN Res(kk, {Rej(f.r)}, 202)
  ELSE Decide(ShowOnly([kk EXCEPT !.c = TRUE], f.l), ee, f.r)

(***************************************************************************)
(* K2, an item Add naming L's authorization a, from R (its collection C)   *)
(* or from X (another owner on R's server, its own collection): while L is *)
(* unavailable, nothing (the listing gate); while a is served, sets uri    *)
(* unless R retracted the item; while it is not, answers with L's Delete   *)
(* of a to the sender's inbox, a retraction while a's row is held and R    *)
(* sent the Add, else ordinary (AnswerClass, F8). The gate covers every    *)
(* listing that names L (an Add, an Update, an instrument, a read), for    *)
(* K1's reason: a suspended member's row stays as it was, and nothing is   *)
(* answered in its name while it cannot act; a member gone is no member.   *)
(* VARIANT V10: "served" is judged in X's collection only.                 *)
(* VARIANT V15: no answer to an unserved authorization.                    *)
(* VARIANT V16a: the answer to X's Add goes to R's inbox.                  *)
(* VARIANT V22: no listing gate (a suspended member's listings are         *)
(* processed as an available one's).                                       *)
(***************************************************************************)
AddItem(kk, ee, i, a, to) ==
  LET served == IF to = "X" /\ Variant = "V10" THEN FALSE ELSE Served(kk, a)
      inbox == IF to = "X" /\ Variant = "V16a" THEN "R" ELSE to
  IN IF (to = "R" /\ ~kk.rk) \/ ~Lists(kk) THEN Res(kk, {}, 202)
     ELSE IF served
       THEN Res(IF to = "R" /\ kk.c /\ i \notin kk.ret THEN [kk EXCEPT !.row.uri = i] ELSE kk, {}, 202)
     ELSE IF Variant # "V15" THEN Res(kk, {Del(a, inbox, AnswerClass(kk, a, to), "answer")}, 202)
     ELSE Res(kk, {}, 202)

(***************************************************************************)
(* K3, R's Remove of item i: at the retraction cap, 503 and nothing        *)
(* written; the row whose uri is i is hidden, i retracted and a read       *)
(* requested; any other item is retracted.                                 *)
(* VARIANT V6: the Remove deletes the row.                                 *)
(***************************************************************************)
RemoveItem(kk, ee, i) ==
  IF ~kk.rk THEN Res(kk, {}, 202)
  ELSE IF ee.cap THEN Res(kk, {}, 503)
  ELSE IF kk.row # NoRow /\ kk.row.uri = i
    THEN IF Variant = "V6"
         THEN ResReq([kk EXCEPT !.row = NoRow, !.ret = @ \cup {i}, !.sync = TRUE], {}, 202)
         ELSE ResReq([kk EXCEPT !.row.uri = NONE, !.ret = @ \cup {i}, !.sync = TRUE], {}, 202)
  ELSE Res([kk EXCEPT !.ret = @ \cup {i}], {}, 202)

(***************************************************************************)
(* K4, R's Update of C, an embedded listing: stores a new C only below 10  *)
(* and unretracted, then shows only.                                       *)
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
(* K5, R's Remove of C (target R's featuredCollections): at the cap, 503   *)
(* and nothing written in either branch; else C's retraction recorded,     *)
(* held or not, and C deleted with its rows.                               *)
(* VARIANT V7 / V7b: the held / unheld branch records no retraction.       *)
(***************************************************************************)
RemoveCollection(kk, ee) ==
  IF ~kk.rk THEN Res(kk, {}, 202)
  ELSE IF ee.cap THEN Res(kk, {}, 503)
  ELSE LET unrecorded == (kk.c /\ Variant = "V7") \/ (~kk.c /\ Variant = "V7b") IN
       Res([kk EXCEPT !.c = FALSE, !.row = NoRow, !.ret = IF unrecorded THEN @ ELSE @ \cup {"C"}], {}, 202)

\* K6, R gone (its actor Delete, a 410, or the operator's purge): R's tombstone at once, after which Kopje ignores R;
\* its collections, their rows and its read request go in the batched purge (OwnerPurge). The first batch runs in the
\* same transaction (inbox.ts:1493-1509 startActorDeletion, :1550 purgeBatch); first: it reaches C, as it does when R
\* has little else to purge (its read request, :1967-1971, then its collections' rows, :1977-1979), or not, when
\* preceding work fills the batch.
OwnerGone(kk, first) ==
  Res(IF first THEN [kk EXCEPT !.rk = FALSE, !.c = FALSE, !.row = NoRow, !.sync = FALSE] ELSE [kk EXCEPT !.rk = FALSE],
      {}, 202)
OwnerPurge(kk) == Res([kk EXCEPT !.c = FALSE, !.row = NoRow, !.sync = FALSE], {}, 0)

\* K7, L revokes its accepted row: retired, its Delete sent to R as a retraction.
Revoke(kk) == Res([kk EXCEPT !.row.st = "ret"], {Del(kk.row.auth, "R", "ret", "revoke")}, 0)

\* K8, L blocks R (severCollections): an accepted row retired, its Delete to R's personal inbox; the Block itself is
\* ordinary.
Block(kk) ==
  IF kk.row.st = "acc"
  THEN Res([kk EXCEPT !.row.st = "ret", !.lblk = TRUE], {Del(kk.row.auth, "R", "ret", "block"), Blk}, 0)
  ELSE Res([kk EXCEPT !.lblk = TRUE], {Blk}, 0)

\* K9, L's account deleted, model-only (Kopje deletes no local account): its rows by cascade, and its actor Delete as an
\* ordinary intent.
MemberGone(kk) == Res([kk EXCEPT !.lx = FALSE, !.row = NoRow], {DelL}, 0)

\* L's suspension and its lifting: the rows stay and nothing is recorded; what reads see follows L's availability.
Suspend(kk) == Res([kk EXCEPT !.ls = TRUE], {}, 0)
Unsuspend(kk) == Res([kk EXCEPT !.ls = FALSE], {}, 0)

\* K10, the retired row's cleanup (pruneCollectionItems), which requests a read of R.
Cleanup(kk) == ResReq([kk EXCEPT !.row = NoRow, !.sync = TRUE], {}, 0)
\* The early eviction of the retired row when a new row comes into C at its 50 stored rows (takeSlot).
Evict(kk) == Res([kk EXCEPT !.row = NoRow], {}, 0)

(***************************************************************************)
(* K14, a read's completion:                                               *)
(*  - R gone since the claim, or the read outdated (a valid push of R's    *)
(*    collections since the claim, inbox.ts markCollectionsChanged):       *)
(*    nothing;                                                             *)
(*  - C seen: C admitted up to 50; the row named by its authorization      *)
(*    takes the listed item, whatever the retractions; an unserved         *)
(*    authorization named is answered with L's Delete; an untruncated      *)
(*    listing that does not name the accepted row hides it, unless the row *)
(*    changed at or after the claim. A truncated listing applies what it   *)
(*    names and hides nothing. While L is unavailable, the read leaves its *)
(*    row as it is and answers nothing (K2's listing gate): its naming of  *)
(*    L is not processed, so its omission of L cannot be told from a       *)
(*    naming and hides nothing either;                                     *)
(*  - C not seen, complete: C deleted only while it holds no row of L in   *)
(*    any state (deleteUnlisted's exemption);                              *)
(*  - C not seen, incomplete: nothing.                                     *)
(* chg: the row changed at or after the claim; outd: a valid push since    *)
(* the claim; hadRow: a row held at the claim (V3 only); settled: no       *)
(* answer of the row queued (V2 only).                                     *)
(* VARIANTS: V1 an omission deletes; V2 it deletes once no answer is       *)
(* queued (a wait for the answer, without a margin); V3 the exemption is   *)
(* read at the claim and the outdated check is gone; V5 no exemption; V12  *)
(* a truncated listing hides; V13 a read honours retractions; V14a no      *)
(* outdated check; V14b no row fence; V15 no answer; V18 no check of R at  *)
(* the completion; V22 no listing gate; V24 a read hides a suspended       *)
(* member's row it omits.                                                  *)
(***************************************************************************)
ApplyRead(kk, ee, v, chg, outd, hadRow, settled) ==
  IF ~kk.rk /\ Variant # "V18" THEN Res(kk, {}, 0)
  ELSE IF outd /\ Variant \notin {"V3", "V14a"} THEN Res(kk, {}, 0)
  ELSE IF v.seen
    THEN LET k1 == IF ~kk.c /\ ee.held # "at50" /\ "C" \notin kk.ret THEN [kk EXCEPT !.c = TRUE] ELSE kk
             own == v.i # NONE /\ HeldRow(k1, v.a)
             fenced == chg /\ Variant # "V14b"
             omits == ~v.tr \/ Variant = "V12"
             \* VARIANT V24: a read hides a suspended member's row it omits.
             hidesSuspended == Variant = "V24" /\ k1.c /\ ~Lists(k1) /\ k1.row.st = "acc" /\ omits /\ ~fenced
                               /\ ~(v.i # NONE /\ HeldRow(k1, v.a))
             k2 == IF hidesSuspended THEN [k1 EXCEPT !.row.uri = NONE]
                   ELSE IF ~k1.c \/ ~Lists(k1) THEN k1
                   ELSE IF own
                     THEN IF Variant = "V13" /\ v.i \in k1.ret THEN k1 ELSE [k1 EXCEPT !.row.uri = v.i]
                   ELSE IF k1.row.st = "acc" /\ omits /\ ~fenced
                     THEN IF Variant = "V1" \/ (Variant = "V2" /\ settled)
                          THEN [k1 EXCEPT !.row = NoRow]
                          ELSE [k1 EXCEPT !.row.uri = NONE]
                   ELSE k1
             answer == v.i # NONE /\ ~Served(k1, v.a) /\ Lists(k1) /\ Variant # "V15"
         IN Res(k2, IF answer THEN {Del(v.a, "R", AnswerClass(k1, v.a, "R"), "answer")} ELSE {}, 0)
  ELSE IF v.cpl
    THEN IF kk.c /\ (kk.row = NoRow \/ Variant = "V5" \/ (Variant = "V3" /\ ~hadRow))
         THEN Res([kk EXCEPT !.c = FALSE, !.row = NoRow], {}, 0)
         ELSE Res(kk, {}, 0)
  ELSE Res(kk, {}, 0)

\* Whether a completion keeps C because it holds L's row (deleteUnlisted's exemption ran): a trap's event.
KeptByRow(kk, v, outd) == kk.rk /\ ~outd /\ ~v.seen /\ v.cpl /\ kk.c /\ kk.row # NoRow

=============================================================================
