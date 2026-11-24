-------------------------- MODULE MediaUploadParams --------------------------
(***************************************************************************)
(* The scenarios of MediaUpload.tla: which uploads take part, their        *)
(* endpoints, and the budget of every fault a scenario allows. A budget is  *)
(* how many times the fault may happen in one behaviour; 0 disables it.     *)
(*                                                                         *)
(*  up      the uploads; v1 those on the v1 endpoint, the rest on v2        *)
(*  max     MAX_AV_INFLIGHT (1 where two uploads compete for it, so the     *)
(*          second meets a full instance; 2 otherwise)                      *)
(*  arr     the last time a request may arrive                              *)
(*  nw      the final writes of a job (1: files/<token>/full; 2:             *)
(*          originals/<id> then full, each behind its own S5)               *)
(*  loss    lost replies, and RPCs that fail before their commit, on any    *)
(*          route or processor call; loseRun lets a `run` be lost           *)
(*  kill    processor invocations killed at any step                        *)
(*  dfail   container stops that fail (destroy not confirmed)               *)
(*  perr    R2 writes that answer an error (and may still land)             *)
(*  rdie    route requests that die                                         *)
(*  del     owner DELETEs                                                   *)
(*  mOn     maintenance windows                                             *)
(*  bm, rs  bookmarks taken and PITR restores to the last one               *)
(*  rev     revocations of the normalize probe's verdict (M5)               *)
(*  bad     a body or text field the route refuses                          *)
(*  fails   an encode the input fails (cause refused)                       *)
(*  orphan  the incomingOrphans pass runs                                   *)
(*  gc      the sweep, reconciliation and the tombstone's retirement run    *)
(*  skd     the processor's clock offset from the Store's                   *)
(*  prompt  the kinds of actor ("route", "do", "cron") whose steps that can *)
(*          be taken now are taken before the clock moves: all of them in  *)
(*          the liveness scenarios (MediaUpload.tla, LIVENESS), some in    *)
(*          the two-upload ones to bound their size; the others may wait   *)
(*  tmax    the last time of the behaviour                                  *)
(***************************************************************************)
EXTENDS Integers

CONSTANTS Scenario, Variant

All == {"route", "do", "cron"}

Base ==
  [up |-> {"u1"}, v1 |-> {}, max |-> 2, arr |-> 0, nw |-> 1, loss |-> 0, loseRun |-> FALSE, kill |-> 0, dfail |-> 0,
   perr |-> 0, rdie |-> 0, del |-> 0, mOn |-> 0, bm |-> 0, rs |-> 0, rev |-> 0, bad |-> FALSE, fails |-> FALSE,
   orphan |-> FALSE, gc |-> TRUE, skd |-> 0, prompt |-> {}, tmax |-> 6]

Params ==
  [\* v1 with lost replies and calls that fail before their commit, on every call.
   V1L |-> [Base EXCEPT !.v1 = {"u1"}, !.loss = 2],
   \* v1 with a kill, a refused body or text field and a refused encode.
   V1K |-> [Base EXCEPT !.v1 = {"u1"}, !.kill = 1, !.bad = TRUE, !.fails = TRUE],
   \* v1 with the probe verdict revoked, DELETE after the 200 and a lost reply.
   V1R |-> [Base EXCEPT !.v1 = {"u1"}, !.rev = 1, !.del = 1, !.loss = 1],
   \* v2, two writes, a lost reply or a lost run.
   V2L |-> [Base EXCEPT !.nw = 2, !.loss = 1, !.loseRun = TRUE, !.tmax = 7],
   \* v2, a kill, a stop that is not confirmed and a failed write.
   V2K |-> [Base EXCEPT !.kill = 1, !.dfail = 1, !.perr = 1, !.tmax = 7],
   \* v2, two writes, DELETE, a failed write and a route that dies.
   V2D |-> [Base EXCEPT !.nw = 2, !.del = 1, !.perr = 1, !.rdie = 1, !.tmax = 7],
   \* Maintenance across a v1 upload, with a kill.
   MT |-> [Base EXCEPT !.v1 = {"u1"}, !.kill = 1, !.mOn = 1],
   \* Maintenance across a v2 upload with two writes.
   MT2 |-> [Base EXCEPT !.nw = 2, !.mOn = 1, !.tmax = 7],
   \* A PITR restore across a v1 upload.
   RS |-> [Base EXCEPT !.v1 = {"u1"}, !.bm = 1, !.rs = 1],
   \* A PITR restore across a v2 upload whose processor runs on, with a kill.
   RS2 |-> [Base EXCEPT !.bm = 1, !.rs = 1, !.kill = 1, !.gc = FALSE],
   \* A PITR restore across a v2 upload, with DELETE.
   RS3 |-> [Base EXCEPT !.bm = 1, !.rs = 1, !.del = 1, !.gc = FALSE, !.prompt = {"cron"}],
   \* Two v2 uploads competing for one slot, with DELETE.
   CAP |-> [Base EXCEPT !.up = {"u1", "u2"}, !.max = 1, !.arr = 1, !.del = 1, !.gc = FALSE,
                        !.prompt = {"cron", "route"}, !.tmax = 5],
   \* Two v2 uploads competing for one slot across a restore.
   CAP2 |-> [Base EXCEPT !.up = {"u1", "u2"}, !.max = 1, !.arr = 1, !.bm = 1, !.rs = 1, !.gc = FALSE,
                         !.prompt = {"cron", "route"}, !.tmax = 5],
   \* Two v2 uploads competing for one slot, with a stop that is not confirmed.
   CAP3 |-> [Base EXCEPT !.up = {"u1", "u2"}, !.max = 1, !.arr = 1, !.dfail = 1, !.gc = FALSE,
                         !.prompt = {"cron", "route"}, !.tmax = 5],
   \* The incomingOrphans pass across two restores, with a route that dies.
   OR |-> [Base EXCEPT !.orphan = TRUE, !.bm = 2, !.rs = 2, !.rdie = 1, !.prompt = All],
   \* The processor's clock one unit behind the Store's, two writes, DELETE.
   SK |-> [Base EXCEPT !.nw = 2, !.skd = -1, !.del = 1, !.tmax = 7],
   \* Liveness: a v2 upload with a lost reply, a kill, a stop that is not confirmed and a failed write.
   L1 |-> [Base EXCEPT !.loss = 1, !.kill = 1, !.dfail = 1, !.perr = 1, !.prompt = All, !.tmax = 10],
   \* Liveness: a v2 upload whose run is lost (W7).
   L4 |-> [Base EXCEPT !.loss = 1, !.loseRun = TRUE, !.prompt = All, !.tmax = 10],
   \* Liveness: a v1 upload across maintenance with a lost reply and a refused body.
   L2 |-> [Base EXCEPT !.v1 = {"u1"}, !.mOn = 1, !.loss = 1, !.bad = TRUE, !.prompt = All, !.tmax = 10],
   \* Liveness: a v2 upload across a restore, its processor killed once, with the incomingOrphans pass.
   L3 |-> [Base EXCEPT !.bm = 1, !.rs = 1, !.kill = 1, !.orphan = TRUE, !.prompt = All, !.tmax = 10]]

P == Params[Scenario]
U == P.up
MaxInflight == P.max
Writes == 1..P.nw

=============================================================================
